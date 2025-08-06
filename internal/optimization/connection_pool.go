package optimization

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ConnectionPool implements a high-performance connection pool
type ConnectionPool struct {
	logger      *zap.Logger
	config      PoolConfig
	connections chan *PooledConnection
	factory     ConnectionFactory
	metrics     *PoolMetrics
	closed      atomic.Bool
	mu          sync.RWMutex
}

// PoolConfig contains connection pool configuration
type PoolConfig struct {
	InitialSize     int
	MaxSize         int
	MaxIdleTime     time.Duration
	ConnectionTimeout time.Duration
	HealthCheckInterval time.Duration
	MaxRetries      int
	RetryDelay      time.Duration
}

// ConnectionFactory creates new connections
type ConnectionFactory func() (net.Conn, error)

// PooledConnection wraps a connection with metadata
type PooledConnection struct {
	conn       net.Conn
	pool       *ConnectionPool
	createdAt  time.Time
	lastUsedAt atomic.Int64
	useCount   atomic.Uint64
	healthy    atomic.Bool
	id         string
}

// PoolMetrics tracks pool performance
type PoolMetrics struct {
	TotalConnections   atomic.Uint64
	ActiveConnections  atomic.Int32
	IdleConnections    atomic.Int32
	FailedConnections  atomic.Uint64
	ConnectionWaitTime atomic.Int64 // nanoseconds
	ConnectionUseTime  atomic.Int64 // nanoseconds
	HealthChecksFailed atomic.Uint64
}

// NewConnectionPool creates a new connection pool
func NewConnectionPool(logger *zap.Logger, config PoolConfig, factory ConnectionFactory) (*ConnectionPool, error) {
	if config.MaxSize <= 0 {
		return nil, errors.New("max size must be positive")
	}
	
	if config.InitialSize > config.MaxSize {
		config.InitialSize = config.MaxSize
	}

	pool := &ConnectionPool{
		logger:      logger,
		config:      config,
		connections: make(chan *PooledConnection, config.MaxSize),
		factory:     factory,
		metrics:     &PoolMetrics{},
	}

	// Create initial connections
	for i := 0; i < config.InitialSize; i++ {
		conn, err := pool.createConnection()
		if err != nil {
			// Log error but continue
			logger.Warn("Failed to create initial connection",
				zap.Int("index", i),
				zap.Error(err),
			)
			continue
		}
		pool.connections <- conn
		pool.metrics.IdleConnections.Add(1)
	}

	// Start health checker
	go pool.healthChecker()

	// Start idle connection cleaner
	go pool.idleCleaner()

	return pool, nil
}

// Get retrieves a connection from the pool
func (p *ConnectionPool) Get(ctx context.Context) (*PooledConnection, error) {
	if p.closed.Load() {
		return nil, errors.New("pool is closed")
	}

	startTime := time.Now()
	defer func() {
		waitTime := time.Since(startTime).Nanoseconds()
		p.metrics.ConnectionWaitTime.Add(waitTime)
	}()

	// Try to get existing connection
	select {
	case conn := <-p.connections:
		if conn.isHealthy() {
			p.metrics.IdleConnections.Add(-1)
			p.metrics.ActiveConnections.Add(1)
			conn.lastUsedAt.Store(time.Now().Unix())
			return conn, nil
		}
		// Connection unhealthy, close it
		conn.close()
		p.metrics.TotalConnections.Add(-1)

	case <-ctx.Done():
		return nil, ctx.Err()

	default:
		// No idle connections available
	}

	// Check if we can create a new connection
	currentTotal := p.metrics.TotalConnections.Load()
	if currentTotal < uint64(p.config.MaxSize) {
		conn, err := p.createConnection()
		if err != nil {
			return nil, fmt.Errorf("failed to create connection: %w", err)
		}
		p.metrics.ActiveConnections.Add(1)
		return conn, nil
	}

	// Wait for available connection
	select {
	case conn := <-p.connections:
		if conn.isHealthy() {
			p.metrics.IdleConnections.Add(-1)
			p.metrics.ActiveConnections.Add(1)
			conn.lastUsedAt.Store(time.Now().Unix())
			return conn, nil
		}
		// Connection unhealthy, try again
		conn.close()
		p.metrics.TotalConnections.Add(-1)
		return p.Get(ctx)

	case <-ctx.Done():
		return nil, ctx.Err()

	case <-time.After(p.config.ConnectionTimeout):
		return nil, errors.New("connection timeout")
	}
}

// Put returns a connection to the pool
func (p *ConnectionPool) Put(conn *PooledConnection) {
	if p.closed.Load() {
		conn.close()
		return
	}

	conn.useCount.Add(1)
	p.metrics.ActiveConnections.Add(-1)

	// Check if connection is still healthy
	if !conn.isHealthy() {
		conn.close()
		p.metrics.TotalConnections.Add(-1)
		return
	}

	// Try to return to pool
	select {
	case p.connections <- conn:
		p.metrics.IdleConnections.Add(1)
	default:
		// Pool is full, close connection
		conn.close()
		p.metrics.TotalConnections.Add(-1)
	}
}

// Close closes the connection pool
func (p *ConnectionPool) Close() error {
	if !p.closed.CompareAndSwap(false, true) {
		return errors.New("pool already closed")
	}

	close(p.connections)

	// Close all connections
	for conn := range p.connections {
		conn.close()
	}

	return nil
}

// createConnection creates a new pooled connection
func (p *ConnectionPool) createConnection() (*PooledConnection, error) {
	conn, err := p.factory()
	if err != nil {
		p.metrics.FailedConnections.Add(1)
		return nil, err
	}

	pooledConn := &PooledConnection{
		conn:      conn,
		pool:      p,
		createdAt: time.Now(),
		id:        fmt.Sprintf("conn-%d-%d", time.Now().Unix(), p.metrics.TotalConnections.Load()),
	}
	pooledConn.healthy.Store(true)
	pooledConn.lastUsedAt.Store(time.Now().Unix())

	p.metrics.TotalConnections.Add(1)

	return pooledConn, nil
}

// healthChecker periodically checks connection health
func (p *ConnectionPool) healthChecker() {
	ticker := time.NewTicker(p.config.HealthCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if p.closed.Load() {
				return
			}
			p.checkHealth()
		}
	}
}

// checkHealth checks health of idle connections
func (p *ConnectionPool) checkHealth() {
	// Get current idle connections count
	idleCount := int(p.metrics.IdleConnections.Load())
	if idleCount == 0 {
		return
	}

	// Check a sample of connections
	checked := 0
	maxCheck := idleCount / 2 // Check half of idle connections
	if maxCheck < 1 {
		maxCheck = 1
	}

	for i := 0; i < maxCheck; i++ {
		select {
		case conn := <-p.connections:
			if conn.isHealthy() {
				// Perform actual health check
				if err := conn.healthCheck(); err != nil {
					conn.healthy.Store(false)
					conn.close()
					p.metrics.TotalConnections.Add(-1)
					p.metrics.HealthChecksFailed.Add(1)
					p.metrics.IdleConnections.Add(-1)
				} else {
					// Return healthy connection to pool
					p.connections <- conn
				}
			} else {
				conn.close()
				p.metrics.TotalConnections.Add(-1)
				p.metrics.IdleConnections.Add(-1)
			}
			checked++
		default:
			// No more connections to check
			return
		}
	}
}

// idleCleaner removes idle connections
func (p *ConnectionPool) idleCleaner() {
	ticker := time.NewTicker(p.config.MaxIdleTime / 2)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if p.closed.Load() {
				return
			}
			p.cleanIdleConnections()
		}
	}
}

// cleanIdleConnections removes connections idle for too long
func (p *ConnectionPool) cleanIdleConnections() {
	now := time.Now().Unix()
	maxIdleSeconds := int64(p.config.MaxIdleTime.Seconds())

	// Check all idle connections
	idleCount := int(p.metrics.IdleConnections.Load())
	checked := 0

	for i := 0; i < idleCount; i++ {
		select {
		case conn := <-p.connections:
			lastUsed := conn.lastUsedAt.Load()
			if now-lastUsed > maxIdleSeconds {
				// Connection idle for too long
				conn.close()
				p.metrics.TotalConnections.Add(-1)
				p.metrics.IdleConnections.Add(-1)
			} else {
				// Return connection to pool
				p.connections <- conn
			}
			checked++
		default:
			// No more connections to check
			return
		}
	}
}

// PooledConnection methods

// Read implements net.Conn Read with metrics
func (pc *PooledConnection) Read(b []byte) (int, error) {
	startTime := time.Now()
	n, err := pc.conn.Read(b)
	useTime := time.Since(startTime).Nanoseconds()
	pc.pool.metrics.ConnectionUseTime.Add(useTime)
	return n, err
}

// Write implements net.Conn Write with metrics
func (pc *PooledConnection) Write(b []byte) (int, error) {
	startTime := time.Now()
	n, err := pc.conn.Write(b)
	useTime := time.Since(startTime).Nanoseconds()
	pc.pool.metrics.ConnectionUseTime.Add(useTime)
	return n, err
}

// Close returns the connection to the pool
func (pc *PooledConnection) Close() error {
	pc.pool.Put(pc)
	return nil
}

// LocalAddr implements net.Conn
func (pc *PooledConnection) LocalAddr() net.Addr {
	return pc.conn.LocalAddr()
}

// RemoteAddr implements net.Conn
func (pc *PooledConnection) RemoteAddr() net.Addr {
	return pc.conn.RemoteAddr()
}

// SetDeadline implements net.Conn
func (pc *PooledConnection) SetDeadline(t time.Time) error {
	return pc.conn.SetDeadline(t)
}

// SetReadDeadline implements net.Conn
func (pc *PooledConnection) SetReadDeadline(t time.Time) error {
	return pc.conn.SetReadDeadline(t)
}

// SetWriteDeadline implements net.Conn
func (pc *PooledConnection) SetWriteDeadline(t time.Time) error {
	return pc.conn.SetWriteDeadline(t)
}

// isHealthy checks if connection is healthy
func (pc *PooledConnection) isHealthy() bool {
	return pc.healthy.Load()
}

// healthCheck performs actual health check
func (pc *PooledConnection) healthCheck() error {
	// Set short timeout for health check
	pc.conn.SetDeadline(time.Now().Add(5 * time.Second))
	defer pc.conn.SetDeadline(time.Time{})

	// Try to write and read a small amount of data
	if tcpConn, ok := pc.conn.(*net.TCPConn); ok {
		// For TCP connections, we can check if it's still connected
		_, err := tcpConn.Write([]byte{})
		return err
	}

	return nil
}

// close actually closes the connection
func (pc *PooledConnection) close() error {
	pc.healthy.Store(false)
	return pc.conn.Close()
}

// GetMetrics returns pool metrics
func (p *ConnectionPool) GetMetrics() map[string]interface{} {
	return map[string]interface{}{
		"total_connections":    p.metrics.TotalConnections.Load(),
		"active_connections":   p.metrics.ActiveConnections.Load(),
		"idle_connections":     p.metrics.IdleConnections.Load(),
		"failed_connections":   p.metrics.FailedConnections.Load(),
		"avg_wait_time_ms":     float64(p.metrics.ConnectionWaitTime.Load()) / 1e6,
		"avg_use_time_ms":      float64(p.metrics.ConnectionUseTime.Load()) / 1e6,
		"health_checks_failed": p.metrics.HealthChecksFailed.Load(),
	}
}