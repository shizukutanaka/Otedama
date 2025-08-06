package p2p

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

// OptimizedConnectionPool provides high-performance connection pooling
// Rob Pike's simplicity with John Carmack's performance optimization
type OptimizedConnectionPool struct {
	logger *zap.Logger
	config ConnectionPoolConfig
	
	// Connection tracking
	connections map[string]*PooledConnection
	connMu      sync.RWMutex
	
	// Pool channels for different connection types
	tcpPool     chan *PooledConnection
	tlsPool     chan *PooledConnection
	
	// Metrics
	stats       PoolStats
	statsMu     sync.RWMutex
	
	// Lifecycle
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	
	// Health checking
	healthCheck HealthChecker
}

// ConnectionPoolConfig defines pool configuration
type ConnectionPoolConfig struct {
	// Pool sizing
	MinConnections int           `json:"min_connections"`
	MaxConnections int           `json:"max_connections"`
	MaxIdleTime    time.Duration `json:"max_idle_time"`
	
	// Connection settings
	DialTimeout     time.Duration `json:"dial_timeout"`
	KeepAlive       time.Duration `json:"keep_alive"`
	ReadTimeout     time.Duration `json:"read_timeout"`
	WriteTimeout    time.Duration `json:"write_timeout"`
	
	// Health check
	HealthCheckInterval time.Duration `json:"health_check_interval"`
	MaxRetries          int           `json:"max_retries"`
	
	// Performance
	EnableTCPNoDelay bool `json:"enable_tcp_nodelay"`
	EnableKeepAlive  bool `json:"enable_keepalive"`
	BufferSize       int  `json:"buffer_size"`
}

// PooledConnection wraps a network connection with metadata
type PooledConnection struct {
	conn        net.Conn
	address     string
	connType    ConnectionType
	created     time.Time
	lastUsed    time.Time
	useCount    atomic.Int64
	errors      atomic.Int32
	inUse       atomic.Bool
	pool        *OptimizedConnectionPool
}

// ConnectionType defines the type of connection
type ConnectionType int

const (
	ConnTypeTCP ConnectionType = iota
	ConnTypeTLS
	ConnTypeWebSocket
)

// PoolStats tracks pool metrics
type PoolStats struct {
	TotalConnections   int64
	ActiveConnections  int64
	IdleConnections    int64
	FailedConnections  int64
	TotalRequests      int64
	Hits               int64
	Misses             int64
	Timeouts           int64
	AverageWaitTime    time.Duration
}

// HealthChecker validates connection health
type HealthChecker interface {
	Check(conn net.Conn) error
}

// DefaultHealthChecker implements basic health checking
type DefaultHealthChecker struct{}

func (d *DefaultHealthChecker) Check(conn net.Conn) error {
	// Set a short deadline for health check
	conn.SetDeadline(time.Now().Add(time.Second))
	defer conn.SetDeadline(time.Time{})
	
	// Try to read 0 bytes - tests if connection is alive
	buf := make([]byte, 0)
	_, err := conn.Read(buf)
	if err != nil && err.Error() != "EOF" {
		return err
	}
	
	return nil
}

// NewOptimizedConnectionPool creates an optimized connection pool
func NewOptimizedConnectionPool(logger *zap.Logger, config ConnectionPoolConfig) *OptimizedConnectionPool {
	ctx, cancel := context.WithCancel(context.Background())
	
	pool := &OptimizedConnectionPool{
		logger:      logger,
		config:      config,
		connections: make(map[string]*PooledConnection),
		tcpPool:     make(chan *PooledConnection, config.MaxConnections),
		tlsPool:     make(chan *PooledConnection, config.MaxConnections),
		ctx:         ctx,
		cancel:      cancel,
		healthCheck: &DefaultHealthChecker{},
	}
	
	// Start maintenance goroutine
	pool.wg.Add(1)
	go pool.maintain()
	
	return pool
}

// Get retrieves a connection from the pool or creates a new one
func (p *OptimizedConnectionPool) Get(address string, connType ConnectionType) (net.Conn, error) {
	startTime := time.Now()
	p.updateStats(func(s *PoolStats) {
		s.TotalRequests++
	})
	
	// Try to get from pool first
	var poolChan chan *PooledConnection
	switch connType {
	case ConnTypeTCP:
		poolChan = p.tcpPool
	case ConnTypeTLS:
		poolChan = p.tlsPool
	default:
		return nil, fmt.Errorf("unsupported connection type: %v", connType)
	}
	
	// Non-blocking select to check pool
	select {
	case pc := <-poolChan:
		if pc != nil && p.validateConnection(pc) {
			pc.inUse.Store(true)
			pc.lastUsed = time.Now()
			pc.useCount.Add(1)
			
			p.updateStats(func(s *PoolStats) {
				s.Hits++
				s.IdleConnections--
				s.ActiveConnections++
				s.AverageWaitTime = time.Since(startTime)
			})
			
			return pc, nil
		}
	default:
		// Pool is empty
	}
	
	// Create new connection
	p.updateStats(func(s *PoolStats) {
		s.Misses++
	})
	
	conn, err := p.createConnection(address, connType)
	if err != nil {
		p.updateStats(func(s *PoolStats) {
			s.FailedConnections++
		})
		return nil, err
	}
	
	// Wrap in pooled connection
	pc := &PooledConnection{
		conn:     conn,
		address:  address,
		connType: connType,
		created:  time.Now(),
		lastUsed: time.Now(),
		pool:     p,
	}
	pc.inUse.Store(true)
	pc.useCount.Store(1)
	
	// Track connection
	p.connMu.Lock()
	p.connections[address] = pc
	p.connMu.Unlock()
	
	p.updateStats(func(s *PoolStats) {
		s.TotalConnections++
		s.ActiveConnections++
		s.AverageWaitTime = time.Since(startTime)
	})
	
	return pc, nil
}

// Put returns a connection to the pool
func (p *OptimizedConnectionPool) Put(conn net.Conn) {
	pc, ok := conn.(*PooledConnection)
	if !ok {
		// Not a pooled connection, close it
		conn.Close()
		return
	}
	
	pc.inUse.Store(false)
	
	// Check if connection is still healthy
	if pc.errors.Load() > int32(p.config.MaxRetries) || !p.validateConnection(pc) {
		p.closeConnection(pc)
		return
	}
	
	// Return to appropriate pool
	var poolChan chan *PooledConnection
	switch pc.connType {
	case ConnTypeTCP:
		poolChan = p.tcpPool
	case ConnTypeTLS:
		poolChan = p.tlsPool
	default:
		p.closeConnection(pc)
		return
	}
	
	// Non-blocking put
	select {
	case poolChan <- pc:
		p.updateStats(func(s *PoolStats) {
			s.ActiveConnections--
			s.IdleConnections++
		})
	default:
		// Pool is full, close connection
		p.closeConnection(pc)
	}
}

// createConnection creates a new network connection
func (p *OptimizedConnectionPool) createConnection(address string, connType ConnectionType) (net.Conn, error) {
	dialer := &net.Dialer{
		Timeout:   p.config.DialTimeout,
		KeepAlive: p.config.KeepAlive,
	}
	
	// Apply performance options
	dialer.Control = p.setSocketOptions
	
	ctx, cancel := context.WithTimeout(p.ctx, p.config.DialTimeout)
	defer cancel()
	
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("failed to dial %s: %w", address, err)
	}
	
	// Set connection options
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		if p.config.EnableTCPNoDelay {
			tcpConn.SetNoDelay(true)
		}
		if p.config.EnableKeepAlive {
			tcpConn.SetKeepAlive(true)
			tcpConn.SetKeepAlivePeriod(p.config.KeepAlive)
		}
		
		// Set buffer sizes if specified
		if p.config.BufferSize > 0 {
			tcpConn.SetReadBuffer(p.config.BufferSize)
			tcpConn.SetWriteBuffer(p.config.BufferSize)
		}
	}
	
	// Set timeouts
	if p.config.ReadTimeout > 0 {
		conn.SetReadDeadline(time.Now().Add(p.config.ReadTimeout))
	}
	if p.config.WriteTimeout > 0 {
		conn.SetWriteDeadline(time.Now().Add(p.config.WriteTimeout))
	}
	
	return conn, nil
}

// validateConnection checks if a connection is still valid
func (p *OptimizedConnectionPool) validateConnection(pc *PooledConnection) bool {
	// Check age
	if time.Since(pc.created) > p.config.MaxIdleTime {
		return false
	}
	
	// Check idle time
	if time.Since(pc.lastUsed) > p.config.MaxIdleTime {
		return false
	}
	
	// Perform health check
	if err := p.healthCheck.Check(pc.conn); err != nil {
		pc.errors.Add(1)
		return false
	}
	
	return true
}

// closeConnection closes and removes a connection
func (p *OptimizedConnectionPool) closeConnection(pc *PooledConnection) {
	pc.conn.Close()
	
	p.connMu.Lock()
	delete(p.connections, pc.address)
	p.connMu.Unlock()
	
	p.updateStats(func(s *PoolStats) {
		s.TotalConnections--
		if pc.inUse.Load() {
			s.ActiveConnections--
		} else {
			s.IdleConnections--
		}
	})
}

// maintain performs periodic pool maintenance
func (p *OptimizedConnectionPool) maintain() {
	defer p.wg.Done()
	
	ticker := time.NewTicker(p.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			p.performMaintenance()
		case <-p.ctx.Done():
			return
		}
	}
}

// performMaintenance cleans up idle and unhealthy connections
func (p *OptimizedConnectionPool) performMaintenance() {
	p.connMu.RLock()
	connections := make([]*PooledConnection, 0, len(p.connections))
	for _, pc := range p.connections {
		connections = append(connections, pc)
	}
	p.connMu.RUnlock()
	
	// Check each connection
	for _, pc := range connections {
		if !pc.inUse.Load() && !p.validateConnection(pc) {
			p.closeConnection(pc)
		}
	}
	
	// Log statistics
	stats := p.GetStats()
	p.logger.Debug("Connection pool stats",
		zap.Int64("total", stats.TotalConnections),
		zap.Int64("active", stats.ActiveConnections),
		zap.Int64("idle", stats.IdleConnections),
		zap.Float64("hit_rate", float64(stats.Hits)/float64(stats.TotalRequests)),
	)
}

// GetStats returns current pool statistics
func (p *OptimizedConnectionPool) GetStats() PoolStats {
	p.statsMu.RLock()
	defer p.statsMu.RUnlock()
	return p.stats
}

// updateStats safely updates pool statistics
func (p *OptimizedConnectionPool) updateStats(update func(*PoolStats)) {
	p.statsMu.Lock()
	defer p.statsMu.Unlock()
	update(&p.stats)
}

// Close closes all connections and shuts down the pool
func (p *OptimizedConnectionPool) Close() error {
	p.cancel()
	
	// Close all idle connections
	close(p.tcpPool)
	close(p.tlsPool)
	
	for pc := range p.tcpPool {
		pc.conn.Close()
	}
	for pc := range p.tlsPool {
		pc.conn.Close()
	}
	
	// Close all tracked connections
	p.connMu.Lock()
	for _, pc := range p.connections {
		pc.conn.Close()
	}
	p.connections = make(map[string]*PooledConnection)
	p.connMu.Unlock()
	
	// Wait for maintenance to stop
	p.wg.Wait()
	
	return nil
}

// PooledConnection methods

// Read implements net.Conn
func (pc *PooledConnection) Read(b []byte) (n int, err error) {
	n, err = pc.conn.Read(b)
	if err != nil {
		pc.errors.Add(1)
	}
	return
}

// Write implements net.Conn
func (pc *PooledConnection) Write(b []byte) (n int, err error) {
	n, err = pc.conn.Write(b)
	if err != nil {
		pc.errors.Add(1)
	}
	return
}

// Close returns the connection to the pool
func (pc *PooledConnection) Close() error {
	pc.pool.Put(pc)
	return nil
}

// Delegate other net.Conn methods
func (pc *PooledConnection) LocalAddr() net.Addr             { return pc.conn.LocalAddr() }
func (pc *PooledConnection) RemoteAddr() net.Addr            { return pc.conn.RemoteAddr() }
func (pc *PooledConnection) SetDeadline(t time.Time) error   { return pc.conn.SetDeadline(t) }
func (pc *PooledConnection) SetReadDeadline(t time.Time) error  { return pc.conn.SetReadDeadline(t) }
func (pc *PooledConnection) SetWriteDeadline(t time.Time) error { return pc.conn.SetWriteDeadline(t) }

// Platform-specific socket options
func (p *OptimizedConnectionPool) setSocketOptions(network, address string, c net.RawConn) error {
	// Platform-specific optimizations would go here
	// For example: SO_REUSEPORT, TCP_FASTOPEN, etc.
	return nil
}