package database

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ConnectionPool implements a database connection pool with advanced features
type ConnectionPool struct {
	logger        *zap.Logger
	config        PoolConfig
	connections   chan *PooledConnection
	factory       ConnectionFactory
	healthChecker *HealthChecker
	stats         *PoolStats
	mu            sync.RWMutex
	closed        atomic.Bool
}

// PoolConfig contains connection pool configuration
type PoolConfig struct {
	// Connection settings
	Driver          string
	DSN             string
	MaxConnections  int
	MinConnections  int
	MaxIdleTime     time.Duration
	MaxLifetime     time.Duration
	
	// Health check settings
	HealthCheckInterval time.Duration
	PingTimeout         time.Duration
	RetryAttempts       int
	RetryDelay          time.Duration
	
	// Performance settings
	AcquireTimeout      time.Duration
	ConnectionTimeout   time.Duration
	
	// Features
	EnableMetrics       bool
	EnableHealthCheck   bool
	EnableAutoRecovery  bool
}

// PooledConnection represents a pooled database connection
type PooledConnection struct {
	conn          *sql.DB
	pool          *ConnectionPool
	id            string
	createdAt     time.Time
	lastUsedAt    time.Time
	usageCount    uint64
	inUse         atomic.Bool
	healthy       atomic.Bool
	mu            sync.Mutex
}

// ConnectionFactory creates new database connections
type ConnectionFactory interface {
	CreateConnection(config PoolConfig) (*sql.DB, error)
	ValidateConnection(conn *sql.DB) error
}

// HealthChecker monitors connection health
type HealthChecker struct {
	logger       *zap.Logger
	pool         *ConnectionPool
	checkResults sync.Map // connID -> *HealthCheckResult
	mu           sync.RWMutex
}

// HealthCheckResult contains health check results
type HealthCheckResult struct {
	ConnectionID string
	Healthy      bool
	LastCheck    time.Time
	Error        error
	Latency      time.Duration
}

// PoolStats tracks connection pool statistics
type PoolStats struct {
	// Connection stats
	TotalConnections    atomic.Int64
	ActiveConnections   atomic.Int64
	IdleConnections     atomic.Int64
	FailedConnections   atomic.Int64
	
	// Usage stats
	TotalAcquisitions   atomic.Uint64
	TotalReleases       atomic.Uint64
	TotalTimeouts       atomic.Uint64
	TotalErrors         atomic.Uint64
	
	// Performance stats
	AverageWaitTime     atomic.Int64 // microseconds
	AverageUseTime      atomic.Int64 // microseconds
	PeakConnections     atomic.Int64
	
	// Health stats
	HealthChecksPassed  atomic.Uint64
	HealthChecksFailed  atomic.Uint64
}

// Transaction represents a database transaction with pooled connection
type Transaction struct {
	tx   *sql.Tx
	conn *PooledConnection
	ctx  context.Context
	opts *sql.TxOptions
}

// Query represents a prepared query with connection affinity
type Query struct {
	stmt *sql.Stmt
	conn *PooledConnection
	sql  string
}

// NewConnectionPool creates a new connection pool
func NewConnectionPool(config PoolConfig, logger *zap.Logger) (*ConnectionPool, error) {
	if config.MaxConnections == 0 {
		config.MaxConnections = 10
	}
	if config.MinConnections == 0 {
		config.MinConnections = 2
	}
	if config.MaxIdleTime == 0 {
		config.MaxIdleTime = 30 * time.Minute
	}
	if config.MaxLifetime == 0 {
		config.MaxLifetime = 1 * time.Hour
	}
	if config.HealthCheckInterval == 0 {
		config.HealthCheckInterval = 30 * time.Second
	}
	if config.AcquireTimeout == 0 {
		config.AcquireTimeout = 30 * time.Second
	}

	pool := &ConnectionPool{
		logger:      logger,
		config:      config,
		connections: make(chan *PooledConnection, config.MaxConnections),
		factory:     NewDefaultConnectionFactory(),
		stats:       &PoolStats{},
	}

	pool.healthChecker = &HealthChecker{
		logger: logger,
		pool:   pool,
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
		pool.stats.IdleConnections.Add(1)
	}

	pool.stats.TotalConnections.Store(int64(config.MinConnections))

	// Start maintenance routines
	if config.EnableHealthCheck {
		go pool.healthCheckRoutine()
	}
	go pool.idleCleanupRoutine()
	go pool.metricsRoutine()

	logger.Info("Connection pool initialized",
		zap.Int("min_connections", config.MinConnections),
		zap.Int("max_connections", config.MaxConnections))

	return pool, nil
}

// Acquire gets a connection from the pool
func (cp *ConnectionPool) Acquire(ctx context.Context) (*PooledConnection, error) {
	if cp.closed.Load() {
		return nil, fmt.Errorf("connection pool is closed")
	}

	startTime := time.Now()
	cp.stats.TotalAcquisitions.Add(1)

	// Try to get from pool with timeout
	timeoutCtx, cancel := context.WithTimeout(ctx, cp.config.AcquireTimeout)
	defer cancel()

	select {
	case conn := <-cp.connections:
		// Got connection from pool
		cp.stats.IdleConnections.Add(-1)
		cp.stats.ActiveConnections.Add(1)
		
		// Validate connection
		if err := cp.validateConnection(conn); err != nil {
			cp.logger.Debug("Connection validation failed", zap.Error(err))
			cp.removeConnection(conn)
			
			// Try to create new connection
			return cp.createAndAcquire(ctx)
		}

		conn.inUse.Store(true)
		conn.lastUsedAt = time.Now()
		conn.usageCount++

		// Update wait time
		waitTime := time.Since(startTime).Microseconds()
		cp.stats.AverageWaitTime.Store(waitTime)

		return conn, nil

	case <-timeoutCtx.Done():
		// Timeout - try to create new connection if under limit
		currentTotal := cp.stats.TotalConnections.Load()
		if currentTotal < int64(cp.config.MaxConnections) {
			return cp.createAndAcquire(ctx)
		}

		cp.stats.TotalTimeouts.Add(1)
		return nil, fmt.Errorf("acquire timeout: no connections available")

	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Release returns a connection to the pool
func (cp *ConnectionPool) Release(conn *PooledConnection) {
	if conn == nil || !conn.inUse.Load() {
		return
	}

	cp.stats.TotalReleases.Add(1)
	conn.inUse.Store(false)

	// Check if pool is closed
	if cp.closed.Load() {
		conn.close()
		return
	}

	// Check connection health
	if !conn.healthy.Load() || time.Since(conn.createdAt) > cp.config.MaxLifetime {
		cp.removeConnection(conn)
		
		// Create replacement if below minimum
		if cp.stats.TotalConnections.Load() < int64(cp.config.MinConnections) {
			go cp.createReplacementConnection()
		}
		return
	}

	// Return to pool
	select {
	case cp.connections <- conn:
		cp.stats.ActiveConnections.Add(-1)
		cp.stats.IdleConnections.Add(1)
	default:
		// Pool is full, close connection
		cp.removeConnection(conn)
	}
}

// Execute executes a query with automatic connection management
func (cp *ConnectionPool) Execute(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	conn, err := cp.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer cp.Release(conn)

	return conn.Exec(ctx, query, args...)
}

// Query executes a query and returns rows
func (cp *ConnectionPool) Query(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	conn, err := cp.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	
	// Note: Connection will be released when rows are closed
	rows, err := conn.Query(ctx, query, args...)
	if err != nil {
		cp.Release(conn)
		return nil, err
	}

	// Wrap rows to handle connection release
	return &pooledRows{
		Rows: rows,
		conn: conn,
		pool: cp,
	}, nil
}

// QueryRow executes a query that returns at most one row
func (cp *ConnectionPool) QueryRow(ctx context.Context, query string, args ...interface{}) *sql.Row {
	conn, err := cp.Acquire(ctx)
	if err != nil {
		// Return a row that will error on Scan
		return &sql.Row{}
	}

	row := conn.QueryRow(ctx, query, args...)
	
	// Release connection after scan
	go func() {
		time.Sleep(100 * time.Millisecond) // Give time for Scan
		cp.Release(conn)
	}()

	return row
}

// BeginTx starts a transaction
func (cp *ConnectionPool) BeginTx(ctx context.Context, opts *sql.TxOptions) (*Transaction, error) {
	conn, err := cp.Acquire(ctx)
	if err != nil {
		return nil, err
	}

	tx, err := conn.conn.BeginTx(ctx, opts)
	if err != nil {
		cp.Release(conn)
		return nil, err
	}

	return &Transaction{
		tx:   tx,
		conn: conn,
		ctx:  ctx,
		opts: opts,
	}, nil
}

// Prepare prepares a statement for multiple executions
func (cp *ConnectionPool) Prepare(ctx context.Context, query string) (*Query, error) {
	conn, err := cp.Acquire(ctx)
	if err != nil {
		return nil, err
	}

	stmt, err := conn.conn.PrepareContext(ctx, query)
	if err != nil {
		cp.Release(conn)
		return nil, err
	}

	return &Query{
		stmt: stmt,
		conn: conn,
		sql:  query,
	}, nil
}

// createConnection creates a new database connection
func (cp *ConnectionPool) createConnection() (*PooledConnection, error) {
	db, err := cp.factory.CreateConnection(cp.config)
	if err != nil {
		cp.stats.FailedConnections.Add(1)
		return nil, err
	}

	conn := &PooledConnection{
		conn:      db,
		pool:      cp,
		id:        generateConnectionID(),
		createdAt: time.Now(),
		lastUsedAt: time.Now(),
	}
	conn.healthy.Store(true)

	cp.logger.Debug("Created new connection", zap.String("id", conn.id))
	return conn, nil
}

// createAndAcquire creates a new connection and acquires it
func (cp *ConnectionPool) createAndAcquire(ctx context.Context) (*PooledConnection, error) {
	conn, err := cp.createConnection()
	if err != nil {
		cp.stats.TotalErrors.Add(1)
		return nil, err
	}

	cp.stats.TotalConnections.Add(1)
	cp.stats.ActiveConnections.Add(1)
	
	// Update peak connections
	current := cp.stats.ActiveConnections.Load()
	for {
		peak := cp.stats.PeakConnections.Load()
		if current <= peak || cp.stats.PeakConnections.CompareAndSwap(peak, current) {
			break
		}
	}

	conn.inUse.Store(true)
	return conn, nil
}

// createReplacementConnection creates a replacement connection
func (cp *ConnectionPool) createReplacementConnection() {
	conn, err := cp.createConnection()
	if err != nil {
		cp.logger.Error("Failed to create replacement connection", zap.Error(err))
		return
	}

	select {
	case cp.connections <- conn:
		cp.stats.TotalConnections.Add(1)
		cp.stats.IdleConnections.Add(1)
	default:
		// Pool is full
		conn.close()
	}
}

// removeConnection removes a connection from the pool
func (cp *ConnectionPool) removeConnection(conn *PooledConnection) {
	conn.close()
	cp.stats.TotalConnections.Add(-1)
	if conn.inUse.Load() {
		cp.stats.ActiveConnections.Add(-1)
	}
}

// validateConnection validates a connection is still usable
func (cp *ConnectionPool) validateConnection(conn *PooledConnection) error {
	// Check if connection is healthy
	if !conn.healthy.Load() {
		return fmt.Errorf("connection marked unhealthy")
	}

	// Check lifetime
	if time.Since(conn.createdAt) > cp.config.MaxLifetime {
		return fmt.Errorf("connection exceeded max lifetime")
	}

	// Ping connection
	ctx, cancel := context.WithTimeout(context.Background(), cp.config.PingTimeout)
	defer cancel()

	if err := conn.conn.PingContext(ctx); err != nil {
		conn.healthy.Store(false)
		return fmt.Errorf("ping failed: %w", err)
	}

	return nil
}

// healthCheckRoutine performs periodic health checks
func (cp *ConnectionPool) healthCheckRoutine() {
	ticker := time.NewTicker(cp.config.HealthCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			cp.performHealthChecks()
		}
		
		if cp.closed.Load() {
			return
		}
	}
}

// performHealthChecks checks health of all connections
func (cp *ConnectionPool) performHealthChecks() {
	// Get snapshot of idle connections
	idleCount := int(cp.stats.IdleConnections.Load())
	checked := 0

	for i := 0; i < idleCount && checked < idleCount; i++ {
		select {
		case conn := <-cp.connections:
			checked++
			
			// Check connection health
			result := cp.healthChecker.checkConnection(conn)
			
			if result.Healthy {
				// Return to pool
				cp.connections <- conn
				cp.stats.HealthChecksPassed.Add(1)
			} else {
				// Remove unhealthy connection
				cp.removeConnection(conn)
				cp.stats.HealthChecksFailed.Add(1)
				
				// Create replacement
				go cp.createReplacementConnection()
			}
			
		default:
			// No more connections to check
			return
		}
	}
}

// idleCleanupRoutine removes idle connections
func (cp *ConnectionPool) idleCleanupRoutine() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			cp.cleanupIdleConnections()
		}
		
		if cp.closed.Load() {
			return
		}
	}
}

// cleanupIdleConnections removes connections idle too long
func (cp *ConnectionPool) cleanupIdleConnections() {
	idleCount := int(cp.stats.IdleConnections.Load())
	totalCount := int(cp.stats.TotalConnections.Load())
	
	// Don't go below minimum
	if totalCount <= cp.config.MinConnections {
		return
	}

	removed := 0
	maxToRemove := totalCount - cp.config.MinConnections

	for i := 0; i < idleCount && removed < maxToRemove; i++ {
		select {
		case conn := <-cp.connections:
			if time.Since(conn.lastUsedAt) > cp.config.MaxIdleTime {
				cp.removeConnection(conn)
				removed++
			} else {
				// Return to pool
				cp.connections <- conn
			}
		default:
			return
		}
	}
}

// metricsRoutine collects pool metrics
func (cp *ConnectionPool) metricsRoutine() {
	if !cp.config.EnableMetrics {
		return
	}

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			cp.collectMetrics()
		}
		
		if cp.closed.Load() {
			return
		}
	}
}

// collectMetrics collects current metrics
func (cp *ConnectionPool) collectMetrics() {
	cp.logger.Debug("Connection pool metrics",
		zap.Int64("total", cp.stats.TotalConnections.Load()),
		zap.Int64("active", cp.stats.ActiveConnections.Load()),
		zap.Int64("idle", cp.stats.IdleConnections.Load()),
		zap.Uint64("acquisitions", cp.stats.TotalAcquisitions.Load()),
		zap.Uint64("timeouts", cp.stats.TotalTimeouts.Load()),
		zap.Int64("avg_wait_us", cp.stats.AverageWaitTime.Load()))
}

// Close closes the connection pool
func (cp *ConnectionPool) Close() error {
	if !cp.closed.CompareAndSwap(false, true) {
		return nil
	}

	cp.logger.Info("Closing connection pool")

	// Close all connections
	close(cp.connections)
	for conn := range cp.connections {
		conn.close()
	}

	return nil
}

// GetStats returns pool statistics
func (cp *ConnectionPool) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"total_connections":    cp.stats.TotalConnections.Load(),
		"active_connections":   cp.stats.ActiveConnections.Load(),
		"idle_connections":     cp.stats.IdleConnections.Load(),
		"failed_connections":   cp.stats.FailedConnections.Load(),
		"total_acquisitions":   cp.stats.TotalAcquisitions.Load(),
		"total_releases":       cp.stats.TotalReleases.Load(),
		"total_timeouts":       cp.stats.TotalTimeouts.Load(),
		"total_errors":         cp.stats.TotalErrors.Load(),
		"average_wait_time":    cp.stats.AverageWaitTime.Load(),
		"peak_connections":     cp.stats.PeakConnections.Load(),
		"health_checks_passed": cp.stats.HealthChecksPassed.Load(),
		"health_checks_failed": cp.stats.HealthChecksFailed.Load(),
	}
}

// PooledConnection methods

func (pc *PooledConnection) Exec(ctx context.Context, query string, args ...interface{}) (sql.Result, error) {
	return pc.conn.ExecContext(ctx, query, args...)
}

func (pc *PooledConnection) Query(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	return pc.conn.QueryContext(ctx, query, args...)
}

func (pc *PooledConnection) QueryRow(ctx context.Context, query string, args ...interface{}) *sql.Row {
	return pc.conn.QueryRowContext(ctx, query, args...)
}

func (pc *PooledConnection) close() {
	pc.conn.Close()
}

// Transaction methods

func (t *Transaction) Commit() error {
	err := t.tx.Commit()
	t.conn.pool.Release(t.conn)
	return err
}

func (t *Transaction) Rollback() error {
	err := t.tx.Rollback()
	t.conn.pool.Release(t.conn)
	return err
}

func (t *Transaction) Exec(query string, args ...interface{}) (sql.Result, error) {
	return t.tx.ExecContext(t.ctx, query, args...)
}

func (t *Transaction) Query(query string, args ...interface{}) (*sql.Rows, error) {
	return t.tx.QueryContext(t.ctx, query, args...)
}

func (t *Transaction) QueryRow(query string, args ...interface{}) *sql.Row {
	return t.tx.QueryRowContext(t.ctx, query, args...)
}

// Query methods

func (q *Query) Close() error {
	err := q.stmt.Close()
	q.conn.pool.Release(q.conn)
	return err
}

func (q *Query) Exec(args ...interface{}) (sql.Result, error) {
	return q.stmt.Exec(args...)
}

func (q *Query) Query(args ...interface{}) (*sql.Rows, error) {
	return q.stmt.Query(args...)
}

func (q *Query) QueryRow(args ...interface{}) *sql.Row {
	return q.stmt.QueryRow(args...)
}

// HealthChecker methods

func (hc *HealthChecker) checkConnection(conn *PooledConnection) *HealthCheckResult {
	startTime := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), hc.pool.config.PingTimeout)
	defer cancel()

	err := conn.conn.PingContext(ctx)
	
	result := &HealthCheckResult{
		ConnectionID: conn.id,
		Healthy:      err == nil,
		LastCheck:    time.Now(),
		Error:        err,
		Latency:      time.Since(startTime),
	}

	hc.checkResults.Store(conn.id, result)
	return result
}

// DefaultConnectionFactory is the default connection factory
type DefaultConnectionFactory struct{}

func NewDefaultConnectionFactory() *DefaultConnectionFactory {
	return &DefaultConnectionFactory{}
}

func (f *DefaultConnectionFactory) CreateConnection(config PoolConfig) (*sql.DB, error) {
	db, err := sql.Open(config.Driver, config.DSN)
	if err != nil {
		return nil, err
	}

	// Configure connection
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(config.MaxLifetime)
	db.SetConnMaxIdleTime(config.MaxIdleTime)

	// Test connection
	ctx, cancel := context.WithTimeout(context.Background(), config.ConnectionTimeout)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}

	return db, nil
}

func (f *DefaultConnectionFactory) ValidateConnection(conn *sql.DB) error {
	return conn.Ping()
}

// pooledRows wraps sql.Rows to handle connection release
type pooledRows struct {
	*sql.Rows
	conn *PooledConnection
	pool *ConnectionPool
}

func (r *pooledRows) Close() error {
	err := r.Rows.Close()
	r.pool.Release(r.conn)
	return err
}

// Helper functions

func generateConnectionID() string {
	return fmt.Sprintf("conn_%d", time.Now().UnixNano())
}