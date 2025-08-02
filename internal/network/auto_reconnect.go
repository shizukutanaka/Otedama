package network

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ReconnectableConnection wraps a network connection with automatic reconnection
type ReconnectableConnection struct {
	logger         *zap.Logger
	config         ReconnectConfig
	
	// Connection details
	network        string // "tcp", "udp", etc.
	address        string
	conn           net.Conn
	connMu         sync.RWMutex
	
	// State
	connected      atomic.Bool
	reconnecting   atomic.Bool
	lastConnected  atomic.Int64 // Unix timestamp
	failureCount   atomic.Int32
	
	// Lifecycle
	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup
	
	// Callbacks
	onConnect      func(conn net.Conn)
	onDisconnect   func(reason error)
	onReconnect    func(attempts int)
}

// ReconnectConfig defines reconnection behavior
type ReconnectConfig struct {
	// Basic settings
	MaxRetries       int           `yaml:"max_retries"`        // -1 for infinite
	InitialBackoff   time.Duration `yaml:"initial_backoff"`
	MaxBackoff       time.Duration `yaml:"max_backoff"`
	BackoffMultiplier float64      `yaml:"backoff_multiplier"`
	
	// Connection settings
	DialTimeout      time.Duration `yaml:"dial_timeout"`
	KeepAlive        time.Duration `yaml:"keep_alive"`
	
	// Health check
	PingInterval     time.Duration `yaml:"ping_interval"`
	PingTimeout      time.Duration `yaml:"ping_timeout"`
	
	// Advanced
	JitterFactor     float64       `yaml:"jitter_factor"`     // 0-1, randomness in backoff
	ResetBackoffAfter time.Duration `yaml:"reset_backoff_after"`
}

// DefaultReconnectConfig returns sensible defaults
func DefaultReconnectConfig() ReconnectConfig {
	return ReconnectConfig{
		MaxRetries:       -1, // Infinite
		InitialBackoff:   time.Second,
		MaxBackoff:       5 * time.Minute,
		BackoffMultiplier: 2.0,
		DialTimeout:      30 * time.Second,
		KeepAlive:        30 * time.Second,
		PingInterval:     30 * time.Second,
		PingTimeout:      10 * time.Second,
		JitterFactor:     0.1,
		ResetBackoffAfter: 5 * time.Minute,
	}
}

// NewReconnectableConnection creates a new auto-reconnecting connection
func NewReconnectableConnection(logger *zap.Logger, network, address string, config ReconnectConfig) *ReconnectableConnection {
	ctx, cancel := context.WithCancel(context.Background())
	
	rc := &ReconnectableConnection{
		logger:  logger,
		config:  config,
		network: network,
		address: address,
		ctx:     ctx,
		cancel:  cancel,
	}
	
	return rc
}

// Connect establishes the initial connection
func (rc *ReconnectableConnection) Connect() error {
	rc.logger.Info("Connecting",
		zap.String("network", rc.network),
		zap.String("address", rc.address),
	)
	
	conn, err := rc.dial()
	if err != nil {
		// Start reconnection in background
		rc.wg.Add(1)
		go rc.reconnectLoop()
		return fmt.Errorf("initial connection failed, reconnecting in background: %w", err)
	}
	
	rc.setConnection(conn)
	
	// Start health check
	rc.wg.Add(1)
	go rc.healthCheckLoop()
	
	return nil
}

// Close stops the connection and reconnection attempts
func (rc *ReconnectableConnection) Close() error {
	rc.logger.Info("Closing reconnectable connection")
	rc.cancel()
	
	rc.connMu.Lock()
	if rc.conn != nil {
		rc.conn.Close()
	}
	rc.connMu.Unlock()
	
	rc.wg.Wait()
	return nil
}

// Write sends data with automatic reconnection
func (rc *ReconnectableConnection) Write(data []byte) (int, error) {
	rc.connMu.RLock()
	conn := rc.conn
	rc.connMu.RUnlock()
	
	if conn == nil {
		return 0, fmt.Errorf("not connected")
	}
	
	n, err := conn.Write(data)
	if err != nil {
		rc.handleConnectionError(err)
		return n, err
	}
	
	return n, nil
}

// Read receives data with automatic reconnection
func (rc *ReconnectableConnection) Read(buffer []byte) (int, error) {
	rc.connMu.RLock()
	conn := rc.conn
	rc.connMu.RUnlock()
	
	if conn == nil {
		return 0, fmt.Errorf("not connected")
	}
	
	n, err := conn.Read(buffer)
	if err != nil {
		rc.handleConnectionError(err)
		return n, err
	}
	
	return n, nil
}

// IsConnected returns the current connection status
func (rc *ReconnectableConnection) IsConnected() bool {
	return rc.connected.Load()
}

// GetConnection returns the underlying connection (may be nil)
func (rc *ReconnectableConnection) GetConnection() net.Conn {
	rc.connMu.RLock()
	defer rc.connMu.RUnlock()
	return rc.conn
}

// SetCallbacks sets optional callback functions
func (rc *ReconnectableConnection) SetCallbacks(
	onConnect func(net.Conn),
	onDisconnect func(error),
	onReconnect func(int),
) {
	rc.onConnect = onConnect
	rc.onDisconnect = onDisconnect
	rc.onReconnect = onReconnect
}

// Private methods

func (rc *ReconnectableConnection) dial() (net.Conn, error) {
	dialer := &net.Dialer{
		Timeout:   rc.config.DialTimeout,
		KeepAlive: rc.config.KeepAlive,
	}
	
	ctx, cancel := context.WithTimeout(rc.ctx, rc.config.DialTimeout)
	defer cancel()
	
	return dialer.DialContext(ctx, rc.network, rc.address)
}

func (rc *ReconnectableConnection) setConnection(conn net.Conn) {
	rc.connMu.Lock()
	rc.conn = conn
	rc.connMu.Unlock()
	
	rc.connected.Store(true)
	rc.lastConnected.Store(time.Now().Unix())
	rc.failureCount.Store(0)
	
	if rc.onConnect != nil {
		rc.onConnect(conn)
	}
	
	rc.logger.Info("Connection established",
		zap.String("address", rc.address),
		zap.String("local", conn.LocalAddr().String()),
	)
}

func (rc *ReconnectableConnection) handleConnectionError(err error) {
	if !rc.connected.Load() {
		return // Already disconnected
	}
	
	rc.logger.Warn("Connection error detected",
		zap.Error(err),
		zap.String("address", rc.address),
	)
	
	rc.connected.Store(false)
	
	rc.connMu.Lock()
	if rc.conn != nil {
		rc.conn.Close()
		rc.conn = nil
	}
	rc.connMu.Unlock()
	
	if rc.onDisconnect != nil {
		rc.onDisconnect(err)
	}
	
	// Start reconnection if not already running
	if rc.reconnecting.CompareAndSwap(false, true) {
		rc.wg.Add(1)
		go rc.reconnectLoop()
	}
}

func (rc *ReconnectableConnection) reconnectLoop() {
	defer rc.wg.Done()
	defer rc.reconnecting.Store(false)
	
	backoff := rc.config.InitialBackoff
	attempts := 0
	
	for {
		select {
		case <-rc.ctx.Done():
			return
		default:
		}
		
		attempts++
		rc.failureCount.Add(1)
		
		// Check max retries
		if rc.config.MaxRetries >= 0 && attempts > rc.config.MaxRetries {
			rc.logger.Error("Max reconnection attempts reached",
				zap.Int("attempts", attempts),
			)
			return
		}
		
		rc.logger.Info("Attempting reconnection",
			zap.Int("attempt", attempts),
			zap.Duration("backoff", backoff),
		)
		
		if rc.onReconnect != nil {
			rc.onReconnect(attempts)
		}
		
		// Wait with backoff
		timer := time.NewTimer(backoff)
		select {
		case <-rc.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		
		// Try to connect
		conn, err := rc.dial()
		if err != nil {
			rc.logger.Debug("Reconnection failed",
				zap.Int("attempt", attempts),
				zap.Error(err),
			)
			
			// Calculate next backoff with jitter
			backoff = rc.calculateBackoff(backoff)
			continue
		}
		
		// Success!
		rc.setConnection(conn)
		rc.logger.Info("Reconnection successful",
			zap.Int("attempts", attempts),
		)
		
		// Start health check
		rc.wg.Add(1)
		go rc.healthCheckLoop()
		
		return
	}
}

func (rc *ReconnectableConnection) calculateBackoff(current time.Duration) time.Duration {
	// Apply multiplier
	next := time.Duration(float64(current) * rc.config.BackoffMultiplier)
	
	// Apply max limit
	if next > rc.config.MaxBackoff {
		next = rc.config.MaxBackoff
	}
	
	// Apply jitter
	if rc.config.JitterFactor > 0 {
		jitter := time.Duration(float64(next) * rc.config.JitterFactor * (2*randFloat() - 1))
		next += jitter
	}
	
	// Check if we should reset backoff
	if rc.config.ResetBackoffAfter > 0 {
		lastConn := time.Unix(rc.lastConnected.Load(), 0)
		if time.Since(lastConn) > rc.config.ResetBackoffAfter {
			return rc.config.InitialBackoff
		}
	}
	
	return next
}

func (rc *ReconnectableConnection) healthCheckLoop() {
	defer rc.wg.Done()
	
	if rc.config.PingInterval <= 0 {
		return // Health check disabled
	}
	
	ticker := time.NewTicker(rc.config.PingInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-rc.ctx.Done():
			return
		case <-ticker.C:
			if !rc.connected.Load() {
				return
			}
			
			if err := rc.performHealthCheck(); err != nil {
				rc.logger.Debug("Health check failed", zap.Error(err))
				rc.handleConnectionError(err)
				return
			}
		}
	}
}

func (rc *ReconnectableConnection) performHealthCheck() error {
	rc.connMu.RLock()
	conn := rc.conn
	rc.connMu.RUnlock()
	
	if conn == nil {
		return fmt.Errorf("no connection")
	}
	
	// Set deadline for the ping
	if err := conn.SetReadDeadline(time.Now().Add(rc.config.PingTimeout)); err != nil {
		return err
	}
	defer conn.SetReadDeadline(time.Time{})
	
	// Try to read 0 bytes to check if connection is alive
	// This works for TCP connections
	buf := make([]byte, 0)
	_, err := conn.Read(buf)
	if err != nil && err.Error() != "EOF" {
		return nil // Connection is alive
	}
	
	return fmt.Errorf("connection appears dead")
}

// Helper function for random float between 0 and 1
func randFloat() float64 {
	return float64(time.Now().UnixNano()%1000000) / 1000000.0
}

// ConnectionPool manages multiple auto-reconnecting connections
type ConnectionPool struct {
	logger      *zap.Logger
	config      PoolConfig
	connections sync.Map // map[string]*ReconnectableConnection
}

// PoolConfig defines connection pool settings
type PoolConfig struct {
	MaxConnections    int                        `yaml:"max_connections"`
	IdleTimeout       time.Duration              `yaml:"idle_timeout"`
	ReconnectConfigs  map[string]ReconnectConfig `yaml:"reconnect_configs"`
}

// NewConnectionPool creates a new connection pool
func NewConnectionPool(logger *zap.Logger, config PoolConfig) *ConnectionPool {
	return &ConnectionPool{
		logger: logger,
		config: config,
	}
}

// GetOrCreate gets an existing connection or creates a new one
func (cp *ConnectionPool) GetOrCreate(key, network, address string) (*ReconnectableConnection, error) {
	// Try to get existing
	if val, ok := cp.connections.Load(key); ok {
		return val.(*ReconnectableConnection), nil
	}
	
	// Create new connection
	config := DefaultReconnectConfig()
	if custom, ok := cp.config.ReconnectConfigs[key]; ok {
		config = custom
	}
	
	conn := NewReconnectableConnection(cp.logger, network, address, config)
	if err := conn.Connect(); err != nil {
		// Connection will retry in background
		cp.logger.Warn("Initial connection failed, will retry", 
			zap.String("key", key),
			zap.Error(err),
		)
	}
	
	// Store and return
	actual, _ := cp.connections.LoadOrStore(key, conn)
	return actual.(*ReconnectableConnection), nil
}

// Close closes all connections in the pool
func (cp *ConnectionPool) Close() error {
	var wg sync.WaitGroup
	
	cp.connections.Range(func(key, value interface{}) bool {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if conn, ok := value.(*ReconnectableConnection); ok {
				conn.Close()
			}
		}()
		return true
	})
	
	wg.Wait()
	return nil
}