package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
)

// ConnectionPool manages database connections
type ConnectionPool struct {
	// Configuration
	config     *PoolConfig
	driver     string
	dataSource string

	// Connection management
	connections chan *PooledConnection
	mu          sync.RWMutex
	closed      atomic.Bool

	// Statistics
	totalConnections   atomic.Int32
	activeConnections  atomic.Int32
	idleConnections    atomic.Int32
	waitCount         atomic.Int64
	waitDuration      atomic.Int64

	// Health checking
	healthCheckInterval time.Duration
	healthCheckQuery    string
}

// PoolConfig holds connection pool configuration
type PoolConfig struct {
	MaxConnections     int
	MinConnections     int
	MaxIdleConnections int
	MaxLifetime        time.Duration
	MaxIdleTime        time.Duration
	ConnectionTimeout  time.Duration
	HealthCheckInterval time.Duration
}

// PooledConnection wraps a database connection
type PooledConnection struct {
	conn       *sql.Conn
	pool       *ConnectionPool
	createdAt  time.Time
	lastUsedAt time.Time
	inUse      atomic.Bool
	id         int32
}

// DefaultPoolConfig returns default pool configuration
func DefaultPoolConfig() *PoolConfig {
	return &PoolConfig{
		MaxConnections:      100,
		MinConnections:      10,
		MaxIdleConnections:  50,
		MaxLifetime:         1 * time.Hour,
		MaxIdleTime:         10 * time.Minute,
		ConnectionTimeout:   30 * time.Second,
		HealthCheckInterval: 30 * time.Second,
	}
}

// NewConnectionPool creates a new connection pool
func NewConnectionPool(driver, dataSource string, config *PoolConfig) (*ConnectionPool, error) {
	if config == nil {
		config = DefaultPoolConfig()
	}

	pool := &ConnectionPool{
		config:              config,
		driver:              driver,
		dataSource:          dataSource,
		connections:         make(chan *PooledConnection, config.MaxConnections),
		healthCheckInterval: config.HealthCheckInterval,
		healthCheckQuery:    "SELECT 1",
	}

	// Initialize minimum connections
	for i := 0; i < config.MinConnections; i++ {
		conn, err := pool.createConnection()
		if err != nil {
			// Clean up created connections
			pool.Close()
			return nil, fmt.Errorf("failed to create initial connection: %w", err)
		}
		pool.connections <- conn
		pool.idleConnections.Add(1)
	}

	// Start health check routine
	go pool.healthCheckRoutine()

	// Start metrics collection
	go pool.metricsRoutine()

	return pool, nil
}

// Get acquires a connection from the pool
func (p *ConnectionPool) Get(ctx context.Context) (*PooledConnection, error) {
	if p.closed.Load() {
		return nil, errors.New("pool is closed")
	}

	// Try to get an existing connection
	select {
	case conn := <-p.connections:
		if p.isConnectionHealthy(conn) {
			conn.inUse.Store(true)
			conn.lastUsedAt = time.Now()
			p.idleConnections.Add(-1)
			p.activeConnections.Add(1)
			return conn, nil
		}
		// Connection is unhealthy, close it
		conn.close()
		p.totalConnections.Add(-1)

	case <-ctx.Done():
		return nil, ctx.Err()

	default:
		// No idle connections available
	}

	// Check if we can create a new connection
	if p.totalConnections.Load() < int32(p.config.MaxConnections) {
		conn, err := p.createConnection()
		if err != nil {
			return nil, err
		}
		conn.inUse.Store(true)
		p.activeConnections.Add(1)
		return conn, nil
	}

	// Wait for a connection to become available
	waitStart := time.Now()
	p.waitCount.Add(1)

	select {
	case conn := <-p.connections:
		p.waitDuration.Add(int64(time.Since(waitStart)))
		
		if p.isConnectionHealthy(conn) {
			conn.inUse.Store(true)
			conn.lastUsedAt = time.Now()
			p.idleConnections.Add(-1)
			p.activeConnections.Add(1)
			return conn, nil
		}
		// Connection is unhealthy
		conn.close()
		p.totalConnections.Add(-1)
		return nil, errors.New("no healthy connections available")

	case <-time.After(p.config.ConnectionTimeout):
		p.waitDuration.Add(int64(time.Since(waitStart)))
		return nil, errors.New("connection timeout")

	case <-ctx.Done():
		p.waitDuration.Add(int64(time.Since(waitStart)))
		return nil, ctx.Err()
	}
}

// Put returns a connection to the pool
func (p *ConnectionPool) Put(conn *PooledConnection) {
	if conn == nil || p.closed.Load() {
		return
	}

	conn.inUse.Store(false)
	conn.lastUsedAt = time.Now()
	p.activeConnections.Add(-1)

	// Check if connection should be closed
	if !p.isConnectionHealthy(conn) {
		conn.close()
		p.totalConnections.Add(-1)
		return
	}

	// Return to pool if under idle limit
	if p.idleConnections.Load() < int32(p.config.MaxIdleConnections) {
		p.idleConnections.Add(1)
		select {
		case p.connections <- conn:
			return
		default:
			// Pool is full, close connection
		}
	}

	// Close excess connection
	conn.close()
	p.totalConnections.Add(-1)
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

// createConnection creates a new database connection
func (p *ConnectionPool) createConnection() (*PooledConnection, error) {
	db, err := sql.Open(p.driver, p.dataSource)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), p.config.ConnectionTimeout)
	defer cancel()

	sqlConn, err := db.Conn(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}

	conn := &PooledConnection{
		conn:      sqlConn,
		pool:      p,
		createdAt: time.Now(),
		id:        p.totalConnections.Add(1),
	}

	return conn, nil
}

// isConnectionHealthy checks if a connection is healthy
func (p *ConnectionPool) isConnectionHealthy(conn *PooledConnection) bool {
	if conn == nil || conn.conn == nil {
		return false
	}

	// Check lifetime
	if time.Since(conn.createdAt) > p.config.MaxLifetime {
		return false
	}

	// Check idle time
	if !conn.inUse.Load() && time.Since(conn.lastUsedAt) > p.config.MaxIdleTime {
		return false
	}

	// Ping the connection
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	if err := conn.conn.PingContext(ctx); err != nil {
		return false
	}

	return true
}

// healthCheckRoutine performs periodic health checks
func (p *ConnectionPool) healthCheckRoutine() {
	ticker := time.NewTicker(p.healthCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if p.closed.Load() {
				return
			}
			p.performHealthCheck()
		}
	}
}

// performHealthCheck checks all idle connections
func (p *ConnectionPool) performHealthCheck() {
	// Get current idle count
	idleCount := int(p.idleConnections.Load())
	
	// Check each idle connection
	for i := 0; i < idleCount; i++ {
		select {
		case conn := <-p.connections:
			if p.isConnectionHealthy(conn) {
				// Return healthy connection to pool
				p.connections <- conn
			} else {
				// Close unhealthy connection
				conn.close()
				p.totalConnections.Add(-1)
				p.idleConnections.Add(-1)
			}
		default:
			return
		}
	}

	// Ensure minimum connections
	for p.totalConnections.Load() < int32(p.config.MinConnections) {
		conn, err := p.createConnection()
		if err != nil {
			break
		}
		p.connections <- conn
		p.idleConnections.Add(1)
	}
}

// metricsRoutine collects pool metrics
func (p *ConnectionPool) metricsRoutine() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if p.closed.Load() {
				return
			}
			// Metrics would be exported here
		}
	}
}

// GetStatistics returns pool statistics
func (p *ConnectionPool) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["total_connections"] = p.totalConnections.Load()
	stats["active_connections"] = p.activeConnections.Load()
	stats["idle_connections"] = p.idleConnections.Load()
	stats["wait_count"] = p.waitCount.Load()
	
	avgWait := float64(0)
	if wc := p.waitCount.Load(); wc > 0 {
		avgWait = float64(p.waitDuration.Load()) / float64(wc) / float64(time.Millisecond)
	}
	stats["avg_wait_ms"] = avgWait
	
	return stats
}

// Exec executes a query without returning rows
func (pc *PooledConnection) Exec(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	return pc.conn.ExecContext(ctx, query, args...)
}

// Query executes a query that returns rows
func (pc *PooledConnection) Query(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	return pc.conn.QueryContext(ctx, query, args...)
}

// QueryRow executes a query that returns at most one row
func (pc *PooledConnection) QueryRow(ctx context.Context, query string, args ...interface{}) *sql.Row {
	return pc.conn.QueryRowContext(ctx, query, args...)
}

// Begin starts a database transaction
func (pc *PooledConnection) Begin(ctx context.Context) (*sql.Tx, error) {
	return pc.conn.BeginTx(ctx, nil)
}

// Close returns the connection to the pool
func (pc *PooledConnection) Close() error {
	pc.pool.Put(pc)
	return nil
}

// close actually closes the database connection
func (pc *PooledConnection) close() {
	if pc.conn != nil {
		pc.conn.Close()
		pc.conn = nil
	}
}

// PreparedStatementCache caches prepared statements
type PreparedStatementCache struct {
	statements map[string]*sql.Stmt
	mu         sync.RWMutex
	conn       *sql.Conn
}

// NewPreparedStatementCache creates a new statement cache
func NewPreparedStatementCache(conn *sql.Conn) *PreparedStatementCache {
	return &PreparedStatementCache{
		statements: make(map[string]*sql.Stmt),
		conn:       conn,
	}
}

// GetOrPrepare gets or prepares a statement
func (psc *PreparedStatementCache) GetOrPrepare(ctx context.Context, query string) (*sql.Stmt, error) {
	psc.mu.RLock()
	stmt, exists := psc.statements[query]
	psc.mu.RUnlock()

	if exists {
		return stmt, nil
	}

	psc.mu.Lock()
	defer psc.mu.Unlock()

	// Double-check after acquiring write lock
	if stmt, exists := psc.statements[query]; exists {
		return stmt, nil
	}

	// Prepare new statement
	stmt, err := psc.conn.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}

	psc.statements[query] = stmt
	return stmt, nil
}

// Close closes all cached statements
func (psc *PreparedStatementCache) Close() error {
	psc.mu.Lock()
	defer psc.mu.Unlock()

	for _, stmt := range psc.statements {
		stmt.Close()
	}

	psc.statements = make(map[string]*sql.Stmt)
	return nil
}