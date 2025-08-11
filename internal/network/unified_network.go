package network

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"github.com/shizukutanaka/Otedama/internal/memory"
	"go.uber.org/zap"
	"golang.org/x/time/rate"
)

// UnifiedNetworkManager provides centralized network management
// Follows John Carmack's performance-first design with Rob Pike's simplicity
type UnifiedNetworkManager struct {
	logger          *zap.Logger
	config          NetworkConfig
	memoryManager   *memory.UnifiedMemoryManager
	recoveryManager *common.RecoveryManager
	
	// Connection management
	connectionPool  *ConnectionPool
	listeners       sync.Map // map[string]net.Listener
	activeConns     sync.Map // map[string]*ManagedConnection
	
	// Circuit breakers for stability
	circuitBreakers sync.Map // map[string]*common.CircuitBreaker
	
	// Rate limiting
	rateLimiters    sync.Map // map[string]*rate.Limiter
	globalLimiter   *rate.Limiter
	
	// Statistics
	stats           NetworkStatistics
	
	// Health monitoring
	healthChecker   *HealthMonitor
	
	// Lifecycle
	ctx            context.Context
	cancel         context.CancelFunc
	wg             sync.WaitGroup
}

// NetworkConfig defines network configuration
type NetworkConfig struct {
	// Connection settings
	MaxConnections      int           `yaml:"max_connections"`
	MaxConnsPerHost     int           `yaml:"max_conns_per_host"`
	ConnectionTimeout   time.Duration `yaml:"connection_timeout"`
	IdleTimeout         time.Duration `yaml:"idle_timeout"`
	KeepAliveInterval   time.Duration `yaml:"keepalive_interval"`
	
	// Performance settings
	EnableTCPNoDelay    bool          `yaml:"enable_tcp_nodelay"`
	EnableTCPKeepAlive  bool          `yaml:"enable_tcp_keepalive"`
	ReceiveBufferSize   int           `yaml:"receive_buffer_size"`
	SendBufferSize      int           `yaml:"send_buffer_size"`
	
	// Rate limiting
	MaxRequestsPerSec   int           `yaml:"max_requests_per_sec"`
	MaxBurstSize        int           `yaml:"max_burst_size"`
	PerHostRateLimit    int           `yaml:"per_host_rate_limit"`
	
	// Circuit breaker
	CircuitBreakerThreshold int       `yaml:"circuit_breaker_threshold"`
	CircuitBreakerTimeout   time.Duration `yaml:"circuit_breaker_timeout"`
	
	// Health checking
	HealthCheckInterval time.Duration `yaml:"health_check_interval"`
	HealthCheckTimeout  time.Duration `yaml:"health_check_timeout"`
	
	// Security
	TLSEnabled         bool          `yaml:"tls_enabled"`
	MaxMessageSize     int64         `yaml:"max_message_size"`
	EnableCompression  bool          `yaml:"enable_compression"`
}

// NetworkStatistics tracks network metrics
type NetworkStatistics struct {
	// Connection metrics
	TotalConnections    atomic.Uint64
	ActiveConnections   atomic.Int64
	FailedConnections   atomic.Uint64
	DroppedConnections  atomic.Uint64
	
	// Data transfer metrics
	BytesSent           atomic.Uint64
	BytesReceived       atomic.Uint64
	MessagesSent        atomic.Uint64
	MessagesReceived    atomic.Uint64
	
	// Performance metrics
	AvgLatencyNs        atomic.Int64
	MaxLatencyNs        atomic.Int64
	MinLatencyNs        atomic.Int64
	
	// Error metrics
	NetworkErrors       atomic.Uint64
	TimeoutErrors       atomic.Uint64
	ProtocolErrors      atomic.Uint64
	
	// Rate limiting metrics
	RateLimitHits       atomic.Uint64
	
	// Circuit breaker metrics
	CircuitBreakerTrips atomic.Uint64
}

// ManagedConnection represents a managed network connection
type ManagedConnection struct {
	conn            net.Conn
	id              string
	remoteAddr      string
	localAddr       string
	protocol        string
	
	// State tracking
	created         time.Time
	lastActivity    atomic.Int64
	bytesRead       atomic.Uint64
	bytesWritten    atomic.Uint64
	messagesRead    atomic.Uint64
	messagesWritten atomic.Uint64
	
	// Rate limiting
	rateLimiter     *rate.Limiter
	
	// Circuit breaker
	circuitBreaker  *common.CircuitBreaker
	
	// Health status
	healthy         atomic.Bool
	lastError       atomic.Value // stores error
	errorCount      atomic.Uint32
	
	// Buffering
	readBuffer      []byte
	writeBuffer     []byte
	
	// Lifecycle
	ctx            context.Context
	cancel         context.CancelFunc
	mu             sync.RWMutex
}

// ConnectionPool manages connection pooling
type ConnectionPool struct {
	manager        *UnifiedNetworkManager
	
	// Pool storage by host
	pools          sync.Map // map[string]*HostPool
	
	// Global connection tracking
	totalConns     atomic.Int64
	activeConns    atomic.Int64
	idleConns      atomic.Int64
}

// HostPool manages connections to a specific host
type HostPool struct {
	host           string
	connections    []*ManagedConnection
	available      chan *ManagedConnection
	maxConns       int
	activeCount    atomic.Int32
	mu             sync.RWMutex
}

// HealthMonitor monitors network health
type HealthMonitor struct {
	manager        *UnifiedNetworkManager
	checks         []HealthCheck
	mu             sync.RWMutex
}

// HealthCheck defines a network health check
type HealthCheck struct {
	Name           string
	Target         string
	CheckFunc      func(ctx context.Context) error
	Interval       time.Duration
	Timeout        time.Duration
	Critical       bool
	LastCheck      time.Time
	LastSuccess    time.Time
	ConsecutiveFails int
}

// DefaultNetworkConfig returns default network configuration
func DefaultNetworkConfig() NetworkConfig {
	return NetworkConfig{
		MaxConnections:      10000,
		MaxConnsPerHost:     100,
		ConnectionTimeout:   30 * time.Second,
		IdleTimeout:         5 * time.Minute,
		KeepAliveInterval:   30 * time.Second,
		EnableTCPNoDelay:    true,
		EnableTCPKeepAlive:  true,
		ReceiveBufferSize:   64 * 1024,
		SendBufferSize:      64 * 1024,
		MaxRequestsPerSec:   1000,
		MaxBurstSize:        100,
		PerHostRateLimit:    100,
		CircuitBreakerThreshold: 5,
		CircuitBreakerTimeout:   60 * time.Second,
		HealthCheckInterval: 30 * time.Second,
		HealthCheckTimeout:  5 * time.Second,
		TLSEnabled:         false,
		MaxMessageSize:     16 * 1024 * 1024, // 16MB
		EnableCompression:  true,
	}
}

// NewUnifiedNetworkManager creates a new unified network manager
func NewUnifiedNetworkManager(logger *zap.Logger, config NetworkConfig) *UnifiedNetworkManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	nm := &UnifiedNetworkManager{
		logger:          logger,
		config:          config,
		memoryManager:   memory.Global(),
		recoveryManager: common.NewRecoveryManager(common.DefaultRecoveryConfig()),
		ctx:             ctx,
		cancel:          cancel,
	}
	
	// Initialize connection pool
	nm.connectionPool = &ConnectionPool{
		manager: nm,
	}
	
	// Initialize rate limiters
	nm.globalLimiter = rate.NewLimiter(
		rate.Limit(config.MaxRequestsPerSec),
		config.MaxBurstSize,
	)
	
	// Initialize health monitor
	nm.healthChecker = &HealthMonitor{
		manager: nm,
		checks:  make([]HealthCheck, 0),
	}
	
	// Start background tasks
	nm.wg.Add(1)
	go nm.maintenanceLoop()
	
	nm.wg.Add(1)
	go nm.healthCheckLoop()
	
	nm.wg.Add(1)
	go nm.metricsLoop()
	
	return nm
}

// Listen creates a new listener on the specified address
func (nm *UnifiedNetworkManager) Listen(network, address string) (net.Listener, error) {
	// Check if we're at connection limit
	if nm.stats.ActiveConnections.Load() >= int64(nm.config.MaxConnections) {
		return nil, fmt.Errorf("connection limit reached")
	}
	
	// Create listener
	listener, err := net.Listen(network, address)
	if err != nil {
		nm.stats.NetworkErrors.Add(1)
		return nil, fmt.Errorf("failed to create listener: %w", err)
	}
	
	// Store listener
	nm.listeners.Store(address, listener)
	
	nm.logger.Info("Listener created",
		zap.String("network", network),
		zap.String("address", address))
	
	return &managedListener{
		Listener: listener,
		manager:  nm,
		address:  address,
	}, nil
}

// Dial creates a new outgoing connection
func (nm *UnifiedNetworkManager) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	// Rate limiting
	if !nm.globalLimiter.Allow() {
		nm.stats.RateLimitHits.Add(1)
		return nil, fmt.Errorf("rate limit exceeded")
	}
	
	// Check circuit breaker
	breaker := nm.getCircuitBreaker(address)
	if !breaker.Allow() {
		nm.stats.CircuitBreakerTrips.Add(1)
		return nil, fmt.Errorf("circuit breaker open for %s", address)
	}
	
	// Try to get from pool first
	if poolConn := nm.connectionPool.Get(address); poolConn != nil {
		return poolConn, nil
	}
	
	// Create new connection with timeout
	dialer := &net.Dialer{
		Timeout:   nm.config.ConnectionTimeout,
		KeepAlive: nm.config.KeepAliveInterval,
	}
	
	conn, err := dialer.DialContext(ctx, network, address)
	if err != nil {
		nm.stats.FailedConnections.Add(1)
		breaker.RecordFailure()
		return nil, fmt.Errorf("dial failed: %w", err)
	}
	
	// Configure connection
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		if nm.config.EnableTCPNoDelay {
			tcpConn.SetNoDelay(true)
		}
		if nm.config.EnableTCPKeepAlive {
			tcpConn.SetKeepAlive(true)
			tcpConn.SetKeepAlivePeriod(nm.config.KeepAliveInterval)
		}
		if nm.config.ReceiveBufferSize > 0 {
			tcpConn.SetReadBuffer(nm.config.ReceiveBufferSize)
		}
		if nm.config.SendBufferSize > 0 {
			tcpConn.SetWriteBuffer(nm.config.SendBufferSize)
		}
	}
	
	// Create managed connection
	managedConn := nm.wrapConnection(conn, address)
	
	// Record success
	breaker.RecordSuccess()
	nm.stats.TotalConnections.Add(1)
	nm.stats.ActiveConnections.Add(1)
	
	return managedConn, nil
}

// wrapConnection wraps a raw connection with management features
func (nm *UnifiedNetworkManager) wrapConnection(conn net.Conn, remoteAddr string) *ManagedConnection {
	ctx, cancel := context.WithCancel(nm.ctx)
	
	mc := &ManagedConnection{
		conn:           conn,
		id:             generateConnID(),
		remoteAddr:     remoteAddr,
		localAddr:      conn.LocalAddr().String(),
		protocol:       conn.LocalAddr().Network(),
		created:        time.Now(),
		rateLimiter:    nm.getHostRateLimiter(remoteAddr),
		circuitBreaker: nm.getCircuitBreaker(remoteAddr),
		readBuffer:     nm.memoryManager.AllocateForNetwork(nm.config.ReceiveBufferSize),
		writeBuffer:    nm.memoryManager.AllocateForNetwork(nm.config.SendBufferSize),
		ctx:            ctx,
		cancel:         cancel,
	}
	
	mc.lastActivity.Store(time.Now().UnixNano())
	mc.healthy.Store(true)
	
	// Store in active connections
	nm.activeConns.Store(mc.id, mc)
	
	// Start monitoring
	go nm.monitorConnection(mc)
	
	return mc
}

// monitorConnection monitors a connection for health and activity
func (nm *UnifiedNetworkManager) monitorConnection(mc *ManagedConnection) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-mc.ctx.Done():
			return
		case <-ticker.C:
			// Check idle timeout
			lastActivity := time.Unix(0, mc.lastActivity.Load())
			if time.Since(lastActivity) > nm.config.IdleTimeout {
				nm.logger.Debug("Connection idle timeout",
					zap.String("id", mc.id),
					zap.String("remote", mc.remoteAddr))
				mc.Close()
				return
			}
			
			// Health check
			if !nm.checkConnectionHealth(mc) {
				mc.healthy.Store(false)
				if mc.errorCount.Load() > 3 {
					mc.Close()
					return
				}
			}
		}
	}
}

// checkConnectionHealth checks if a connection is healthy
func (nm *UnifiedNetworkManager) checkConnectionHealth(mc *ManagedConnection) bool {
	// Set deadline for health check
	mc.conn.SetReadDeadline(time.Now().Add(nm.config.HealthCheckTimeout))
	defer mc.conn.SetReadDeadline(time.Time{})
	
	// Try to read 0 bytes to check connection
	buf := make([]byte, 0)
	_, err := mc.conn.Read(buf)
	
	if err != nil && err != net.ErrClosed {
		mc.errorCount.Add(1)
		mc.lastError.Store(err)
		return false
	}
	
	return true
}

// getCircuitBreaker gets or creates a circuit breaker for a host
func (nm *UnifiedNetworkManager) getCircuitBreaker(host string) *common.CircuitBreaker {
	val, _ := nm.circuitBreakers.LoadOrStore(host, &common.CircuitBreaker{})
	return val.(*common.CircuitBreaker)
}

// getHostRateLimiter gets or creates a rate limiter for a host
func (nm *UnifiedNetworkManager) getHostRateLimiter(host string) *rate.Limiter {
	val, _ := nm.rateLimiters.LoadOrStore(host, rate.NewLimiter(
		rate.Limit(nm.config.PerHostRateLimit),
		nm.config.MaxBurstSize,
	))
	return val.(*rate.Limiter)
}

// maintenanceLoop performs periodic maintenance
func (nm *UnifiedNetworkManager) maintenanceLoop() {
	defer nm.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-nm.ctx.Done():
			return
		case <-ticker.C:
			nm.performMaintenance()
		}
	}
}

// performMaintenance performs maintenance tasks
func (nm *UnifiedNetworkManager) performMaintenance() {
	// Clean up idle connections
	nm.activeConns.Range(func(key, value interface{}) bool {
		mc := value.(*ManagedConnection)
		lastActivity := time.Unix(0, mc.lastActivity.Load())
		
		if time.Since(lastActivity) > nm.config.IdleTimeout {
			nm.logger.Debug("Closing idle connection",
				zap.String("id", mc.id))
			mc.Close()
			nm.activeConns.Delete(key)
		}
		
		return true
	})
	
	// Clean up connection pools
	nm.connectionPool.cleanup()
}

// healthCheckLoop performs periodic health checks
func (nm *UnifiedNetworkManager) healthCheckLoop() {
	defer nm.wg.Done()
	
	ticker := time.NewTicker(nm.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-nm.ctx.Done():
			return
		case <-ticker.C:
			nm.performHealthChecks()
		}
	}
}

// performHealthChecks executes all health checks
func (nm *UnifiedNetworkManager) performHealthChecks() {
	nm.healthChecker.mu.RLock()
	checks := make([]HealthCheck, len(nm.healthChecker.checks))
	copy(checks, nm.healthChecker.checks)
	nm.healthChecker.mu.RUnlock()
	
	var wg sync.WaitGroup
	for i := range checks {
		wg.Add(1)
		go func(check *HealthCheck) {
			defer wg.Done()
			
			ctx, cancel := context.WithTimeout(nm.ctx, check.Timeout)
			defer cancel()
			
			err := check.CheckFunc(ctx)
			
			nm.healthChecker.mu.Lock()
			check.LastCheck = time.Now()
			if err != nil {
				check.ConsecutiveFails++
				nm.logger.Warn("Health check failed",
					zap.String("name", check.Name),
					zap.String("target", check.Target),
					zap.Error(err))
				
				if check.Critical && check.ConsecutiveFails > 3 {
					// Trigger recovery for critical checks
					nm.handleCriticalFailure(check)
				}
			} else {
				check.LastSuccess = time.Now()
				check.ConsecutiveFails = 0
			}
			nm.healthChecker.mu.Unlock()
		}(&checks[i])
	}
	
	wg.Wait()
}

// handleCriticalFailure handles critical health check failures
func (nm *UnifiedNetworkManager) handleCriticalFailure(check *HealthCheck) {
	nm.logger.Error("Critical health check failure",
		zap.String("name", check.Name),
		zap.String("target", check.Target),
		zap.Int("consecutive_fails", check.ConsecutiveFails))
	
	// Close all connections to the target
	nm.activeConns.Range(func(key, value interface{}) bool {
		mc := value.(*ManagedConnection)
		if mc.remoteAddr == check.Target {
			mc.Close()
			nm.activeConns.Delete(key)
		}
		return true
	})
	
	// Trip circuit breaker
	breaker := nm.getCircuitBreaker(check.Target)
	for i := 0; i < nm.config.CircuitBreakerThreshold; i++ {
		breaker.RecordFailure()
	}
}

// metricsLoop collects and reports metrics
func (nm *UnifiedNetworkManager) metricsLoop() {
	defer nm.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-nm.ctx.Done():
			return
		case <-ticker.C:
			nm.collectMetrics()
		}
	}
}

// collectMetrics collects current metrics
func (nm *UnifiedNetworkManager) collectMetrics() {
	// Count active connections
	activeCount := int64(0)
	totalBytes := uint64(0)
	totalMessages := uint64(0)
	
	nm.activeConns.Range(func(key, value interface{}) bool {
		activeCount++
		mc := value.(*ManagedConnection)
		totalBytes += mc.bytesRead.Load() + mc.bytesWritten.Load()
		totalMessages += mc.messagesRead.Load() + mc.messagesWritten.Load()
		return true
	})
	
	nm.stats.ActiveConnections.Store(activeCount)
	
	// Log metrics if significant changes
	if activeCount > 0 {
		nm.logger.Debug("Network metrics",
			zap.Int64("active_connections", activeCount),
			zap.Uint64("total_bytes", totalBytes),
			zap.Uint64("total_messages", totalMessages))
	}
}

// GetStats returns current network statistics
func (nm *UnifiedNetworkManager) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"total_connections":   nm.stats.TotalConnections.Load(),
		"active_connections":  nm.stats.ActiveConnections.Load(),
		"failed_connections":  nm.stats.FailedConnections.Load(),
		"dropped_connections": nm.stats.DroppedConnections.Load(),
		"bytes_sent":         nm.stats.BytesSent.Load(),
		"bytes_received":     nm.stats.BytesReceived.Load(),
		"messages_sent":      nm.stats.MessagesSent.Load(),
		"messages_received":  nm.stats.MessagesReceived.Load(),
		"avg_latency_ms":     float64(nm.stats.AvgLatencyNs.Load()) / 1e6,
		"network_errors":     nm.stats.NetworkErrors.Load(),
		"timeout_errors":     nm.stats.TimeoutErrors.Load(),
		"rate_limit_hits":    nm.stats.RateLimitHits.Load(),
		"circuit_breaker_trips": nm.stats.CircuitBreakerTrips.Load(),
	}
}

// RegisterHealthCheck registers a new health check
func (nm *UnifiedNetworkManager) RegisterHealthCheck(check HealthCheck) {
	nm.healthChecker.mu.Lock()
	defer nm.healthChecker.mu.Unlock()
	nm.healthChecker.checks = append(nm.healthChecker.checks, check)
}

// Shutdown gracefully shuts down the network manager
func (nm *UnifiedNetworkManager) Shutdown() {
	nm.cancel()
	
	// Close all listeners
	nm.listeners.Range(func(key, value interface{}) bool {
		listener := value.(net.Listener)
		listener.Close()
		return true
	})
	
	// Close all connections
	nm.activeConns.Range(func(key, value interface{}) bool {
		mc := value.(*ManagedConnection)
		mc.Close()
		return true
	})
	
	nm.wg.Wait()
	nm.logger.Info("Network manager shut down")
}

// ManagedConnection methods

// Read reads data from the connection
func (mc *ManagedConnection) Read(b []byte) (int, error) {
	// Rate limiting
	if !mc.rateLimiter.Allow() {
		return 0, fmt.Errorf("rate limit exceeded")
	}
	
	// Check circuit breaker
	if !mc.circuitBreaker.Allow() {
		return 0, fmt.Errorf("circuit breaker open")
	}
	
	n, err := mc.conn.Read(b)
	
	if err != nil {
		mc.errorCount.Add(1)
		mc.lastError.Store(err)
		mc.circuitBreaker.RecordFailure()
	} else {
		mc.bytesRead.Add(uint64(n))
		mc.messagesRead.Add(1)
		mc.lastActivity.Store(time.Now().UnixNano())
		mc.circuitBreaker.RecordSuccess()
	}
	
	return n, err
}

// Write writes data to the connection
func (mc *ManagedConnection) Write(b []byte) (int, error) {
	// Rate limiting
	if !mc.rateLimiter.Allow() {
		return 0, fmt.Errorf("rate limit exceeded")
	}
	
	// Check circuit breaker
	if !mc.circuitBreaker.Allow() {
		return 0, fmt.Errorf("circuit breaker open")
	}
	
	n, err := mc.conn.Write(b)
	
	if err != nil {
		mc.errorCount.Add(1)
		mc.lastError.Store(err)
		mc.circuitBreaker.RecordFailure()
	} else {
		mc.bytesWritten.Add(uint64(n))
		mc.messagesWritten.Add(1)
		mc.lastActivity.Store(time.Now().UnixNano())
		mc.circuitBreaker.RecordSuccess()
	}
	
	return n, err
}

// Close closes the connection
func (mc *ManagedConnection) Close() error {
	mc.cancel()
	err := mc.conn.Close()
	
	// Free buffers
	if mc.readBuffer != nil {
		memory.Global().Free(mc.readBuffer)
	}
	if mc.writeBuffer != nil {
		memory.Global().Free(mc.writeBuffer)
	}
	
	return err
}

// LocalAddr returns the local address
func (mc *ManagedConnection) LocalAddr() net.Addr {
	return mc.conn.LocalAddr()
}

// RemoteAddr returns the remote address
func (mc *ManagedConnection) RemoteAddr() net.Addr {
	return mc.conn.RemoteAddr()
}

// SetDeadline sets the connection deadline
func (mc *ManagedConnection) SetDeadline(t time.Time) error {
	return mc.conn.SetDeadline(t)
}

// SetReadDeadline sets the read deadline
func (mc *ManagedConnection) SetReadDeadline(t time.Time) error {
	return mc.conn.SetReadDeadline(t)
}

// SetWriteDeadline sets the write deadline
func (mc *ManagedConnection) SetWriteDeadline(t time.Time) error {
	return mc.conn.SetWriteDeadline(t)
}

// ConnectionPool methods

// Get gets a connection from the pool
func (cp *ConnectionPool) Get(host string) net.Conn {
	val, ok := cp.pools.Load(host)
	if !ok {
		return nil
	}
	
	pool := val.(*HostPool)
	
	select {
	case conn := <-pool.available:
		if conn.healthy.Load() {
			pool.activeCount.Add(1)
			cp.activeConns.Add(1)
			cp.idleConns.Add(-1)
			return conn
		}
		// Unhealthy connection, close it
		conn.Close()
	default:
		// No available connections
	}
	
	return nil
}

// Put returns a connection to the pool
func (cp *ConnectionPool) Put(conn *ManagedConnection) {
	val, ok := cp.pools.Load(conn.remoteAddr)
	if !ok {
		// Create new pool for this host
		pool := &HostPool{
			host:      conn.remoteAddr,
			available: make(chan *ManagedConnection, cp.manager.config.MaxConnsPerHost),
			maxConns:  cp.manager.config.MaxConnsPerHost,
		}
		val, _ = cp.pools.LoadOrStore(conn.remoteAddr, pool)
	}
	
	pool := val.(*HostPool)
	
	select {
	case pool.available <- conn:
		pool.activeCount.Add(-1)
		cp.activeConns.Add(-1)
		cp.idleConns.Add(1)
	default:
		// Pool full, close connection
		conn.Close()
	}
}

// cleanup cleans up idle connections
func (cp *ConnectionPool) cleanup() {
	cp.pools.Range(func(key, value interface{}) bool {
		pool := value.(*HostPool)
		
		// Clean up idle connections
		for {
			select {
			case conn := <-pool.available:
				lastActivity := time.Unix(0, conn.lastActivity.Load())
				if time.Since(lastActivity) > cp.manager.config.IdleTimeout {
					conn.Close()
					cp.idleConns.Add(-1)
					cp.totalConns.Add(-1)
				} else {
					// Put it back
					pool.available <- conn
					return true
				}
			default:
				return true
			}
		}
	})
}

// managedListener wraps a listener with management features
type managedListener struct {
	net.Listener
	manager *UnifiedNetworkManager
	address string
}

// Accept accepts a new connection
func (ml *managedListener) Accept() (net.Conn, error) {
	conn, err := ml.Listener.Accept()
	if err != nil {
		ml.manager.stats.NetworkErrors.Add(1)
		return nil, err
	}
	
	// Check connection limit
	if ml.manager.stats.ActiveConnections.Load() >= int64(ml.manager.config.MaxConnections) {
		conn.Close()
		ml.manager.stats.DroppedConnections.Add(1)
		return nil, fmt.Errorf("connection limit reached")
	}
	
	// Wrap connection
	managedConn := ml.manager.wrapConnection(conn, conn.RemoteAddr().String())
	
	return managedConn, nil
}

// generateConnID generates a unique connection ID
func generateConnID() string {
	return fmt.Sprintf("conn-%d-%d", time.Now().UnixNano(), rand.Int63())
}

// Import crypto/rand for ID generation
import "crypto/rand"
import "encoding/hex"

func init() {
	// Initialize random seed
	b := make([]byte, 8)
	crypto_rand.Read(b)
}

// Global instance
var globalNetworkManager *UnifiedNetworkManager
var networkOnce sync.Once

// InitializeNetwork initializes the global network manager
func InitializeNetwork(logger *zap.Logger, config NetworkConfig) {
	networkOnce.Do(func() {
		globalNetworkManager = NewUnifiedNetworkManager(logger, config)
	})
}

// GlobalNetwork returns the global network manager
func GlobalNetwork() *UnifiedNetworkManager {
	return globalNetworkManager
}