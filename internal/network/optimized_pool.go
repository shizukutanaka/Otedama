package network

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// OptimizedConnectionPool provides high-performance connection pooling
// Following Carmack's performance focus and Pike's simplicity
type OptimizedConnectionPool struct {
	logger *zap.Logger
	
	// Connection storage - lock-free where possible
	connections sync.Map // map[string]*ConnWrapper
	
	// Pool configuration
	config PoolConfig
	
	// Statistics - atomic for lock-free access
	stats struct {
		activeConns   atomic.Int64
		totalConns    atomic.Int64
		failedConns   atomic.Int64
		reusedConns   atomic.Int64
		avgLatencyNs  atomic.Int64
	}
	
	// Connection factory
	dialFunc DialFunc
	
	// Health checking
	healthChecker *HealthChecker
}

// PoolConfig defines connection pool configuration
type PoolConfig struct {
	MaxConnsPerHost    int           `yaml:"max_conns_per_host"`
	MaxIdleConns       int           `yaml:"max_idle_conns"`
	ConnTimeout        time.Duration `yaml:"conn_timeout"`
	IdleTimeout        time.Duration `yaml:"idle_timeout"`
	HealthCheckPeriod  time.Duration `yaml:"health_check_period"`
	EnableCompression  bool          `yaml:"enable_compression"`
	EnableTCPNoDelay   bool          `yaml:"enable_tcp_nodelay"`
	EnableTCPKeepAlive bool          `yaml:"enable_tcp_keepalive"`
	KeepAlivePeriod    time.Duration `yaml:"keepalive_period"`
}

// ConnWrapper wraps a connection with metadata
type ConnWrapper struct {
	conn        net.Conn
	addr        string
	createTime  time.Time
	lastUseTime atomic.Int64
	useCount    atomic.Int64
	healthy     atomic.Bool
	mu          sync.Mutex
}

// DialFunc is a function that creates new connections
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// HealthChecker monitors connection health
type HealthChecker struct {
	checkFunc func(conn net.Conn) error
	interval  time.Duration
}

// NewOptimizedConnectionPool creates an optimized connection pool
func NewOptimizedConnectionPool(logger *zap.Logger, config PoolConfig, dialFunc DialFunc) *OptimizedConnectionPool {
	pool := &OptimizedConnectionPool{
		logger:   logger,
		config:   config,
		dialFunc: dialFunc,
		healthChecker: &HealthChecker{
			interval: config.HealthCheckPeriod,
			checkFunc: defaultHealthCheck,
		},
	}
	
	return pool
}

// Get retrieves or creates a connection
func (p *OptimizedConnectionPool) Get(ctx context.Context, addr string) (net.Conn, error) {
	// Try to get existing healthy connection
	if wrapped := p.getHealthyConnection(addr); wrapped != nil {
		p.stats.reusedConns.Add(1)
		return &pooledConn{
			Conn:    wrapped.conn,
			pool:    p,
			wrapper: wrapped,
		}, nil
	}
	
	// Create new connection
	conn, err := p.createConnection(ctx, addr)
	if err != nil {
		p.stats.failedConns.Add(1)
		return nil, err
	}
	
	// Wrap and store
	wrapped := &ConnWrapper{
		conn:       conn,
		addr:       addr,
		createTime: time.Now(),
	}
	wrapped.lastUseTime.Store(time.Now().UnixNano())
	wrapped.healthy.Store(true)
	wrapped.useCount.Store(1)
	
	// Store in pool
	key := p.connKey(addr)
	p.connections.Store(key, wrapped)
	
	p.stats.activeConns.Add(1)
	p.stats.totalConns.Add(1)
	
	return &pooledConn{
		Conn:    conn,
		pool:    p,
		wrapper: wrapped,
	}, nil
}

// StartMaintenance starts background maintenance
func (p *OptimizedConnectionPool) StartMaintenance(ctx context.Context) {
	// Health checking
	go p.healthCheckLoop(ctx)
	
	// Idle connection cleanup
	go p.cleanupLoop(ctx)
	
	// Statistics collection
	go p.statsLoop(ctx)
}

// GetStats returns pool statistics
func (p *OptimizedConnectionPool) GetStats() ConnectionStats {
	return ConnectionStats{
		ActiveConnections: p.stats.activeConns.Load(),
		TotalConnections:  p.stats.totalConns.Load(),
		FailedConnections: p.stats.failedConns.Load(),
		ReusedConnections: p.stats.reusedConns.Load(),
		AvgLatencyMs:      float64(p.stats.avgLatencyNs.Load()) / 1e6,
	}
}

// Private methods

func (p *OptimizedConnectionPool) getHealthyConnection(addr string) *ConnWrapper {
	key := p.connKey(addr)
	if val, ok := p.connections.Load(key); ok {
		wrapped := val.(*ConnWrapper)
		if wrapped.healthy.Load() {
			wrapped.lastUseTime.Store(time.Now().UnixNano())
			wrapped.useCount.Add(1)
			return wrapped
		}
	}
	return nil
}

func (p *OptimizedConnectionPool) createConnection(ctx context.Context, addr string) (net.Conn, error) {
	// Create connection with timeout
	dialCtx, cancel := context.WithTimeout(ctx, p.config.ConnTimeout)
	defer cancel()
	
	start := time.Now()
	conn, err := p.dialFunc(dialCtx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	
	// Update latency stats
	latency := time.Since(start).Nanoseconds()
	p.updateAvgLatency(latency)
	
	// Configure connection
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		if p.config.EnableTCPNoDelay {
			tcpConn.SetNoDelay(true)
		}
		if p.config.EnableTCPKeepAlive {
			tcpConn.SetKeepAlive(true)
			tcpConn.SetKeepAlivePeriod(p.config.KeepAlivePeriod)
		}
	}
	
	return conn, nil
}

func (p *OptimizedConnectionPool) updateAvgLatency(newLatency int64) {
	// Exponential moving average
	const alpha = 0.1
	for {
		current := p.stats.avgLatencyNs.Load()
		new := int64(float64(current)*(1-alpha) + float64(newLatency)*alpha)
		if p.stats.avgLatencyNs.CompareAndSwap(current, new) {
			break
		}
	}
}

func (p *OptimizedConnectionPool) healthCheckLoop(ctx context.Context) {
	ticker := time.NewTicker(p.config.HealthCheckPeriod)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.checkAllConnections()
		}
	}
}

func (p *OptimizedConnectionPool) checkAllConnections() {
	p.connections.Range(func(key, value interface{}) bool {
		wrapped := value.(*ConnWrapper)
		
		if err := p.healthChecker.checkFunc(wrapped.conn); err != nil {
			wrapped.healthy.Store(false)
			p.logger.Debug("Connection failed health check",
				zap.String("addr", wrapped.addr),
				zap.Error(err),
			)
		}
		
		return true
	})
}

func (p *OptimizedConnectionPool) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(p.config.IdleTimeout / 2)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.cleanupIdleConnections()
		}
	}
}

func (p *OptimizedConnectionPool) cleanupIdleConnections() {
	now := time.Now().UnixNano()
	idleThreshold := p.config.IdleTimeout.Nanoseconds()
	
	p.connections.Range(func(key, value interface{}) bool {
		wrapped := value.(*ConnWrapper)
		
		lastUse := wrapped.lastUseTime.Load()
		if now-lastUse > idleThreshold {
			wrapped.mu.Lock()
			if wrapped.conn != nil {
				wrapped.conn.Close()
				p.stats.activeConns.Add(-1)
			}
			wrapped.mu.Unlock()
			
			p.connections.Delete(key)
			p.logger.Debug("Closed idle connection",
				zap.String("addr", wrapped.addr),
				zap.Duration("idle_time", time.Duration(now-lastUse)),
			)
		}
		
		return true
	})
}

func (p *OptimizedConnectionPool) statsLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stats := p.GetStats()
			p.logger.Info("Connection pool stats",
				zap.Int64("active", stats.ActiveConnections),
				zap.Int64("total", stats.TotalConnections),
				zap.Int64("reused", stats.ReusedConnections),
				zap.Float64("avg_latency_ms", stats.AvgLatencyMs),
			)
		}
	}
}

func (p *OptimizedConnectionPool) connKey(addr string) string {
	// Simple key generation - could be enhanced with hashing
	return addr
}

func defaultHealthCheck(conn net.Conn) error {
	// Simple health check - try to set deadline
	return conn.SetDeadline(time.Now().Add(1 * time.Second))
}

// pooledConn wraps a connection to return it to the pool
type pooledConn struct {
	net.Conn
	pool    *OptimizedConnectionPool
	wrapper *ConnWrapper
	closed  atomic.Bool
}

func (c *pooledConn) Close() error {
	if c.closed.CompareAndSwap(false, true) {
		// Return to pool instead of closing
		if c.wrapper.healthy.Load() {
			return nil
		}
		
		// Unhealthy connection - actually close it
		c.pool.stats.activeConns.Add(-1)
		return c.Conn.Close()
	}
	return nil
}

// ConnectionStats contains pool statistics
type ConnectionStats struct {
	ActiveConnections int64
	TotalConnections  int64
	FailedConnections int64
	ReusedConnections int64
	AvgLatencyMs      float64
}