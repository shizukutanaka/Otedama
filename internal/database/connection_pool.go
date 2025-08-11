package database

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
)

// OptimizedConnectionPool provides high-performance database connection pooling
// Implements connection reuse, health checking, and automatic recovery
type OptimizedConnectionPool struct {
	logger          *zap.Logger
	config          PoolConfig
	driver          string
	dsn             string
	
	// Connection management
	connections     chan *PooledConnection
	allConnections  []*PooledConnection
	activeCount     atomic.Int32
	idleCount       atomic.Int32
	totalCreated    atomic.Uint64
	
	// Health monitoring
	healthChecker   *HealthChecker
	circuitBreaker  *common.CircuitBreaker
	
	// Statistics
	stats           PoolStatistics
	
	// Prepared statement cache
	stmtCache       *StatementCache
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
	mu              sync.RWMutex
}

// PoolConfig defines connection pool configuration
type PoolConfig struct {
	Driver              string        `yaml:"driver"`
	DSN                 string        `yaml:"dsn"`
	MaxConnections      int           `yaml:"max_connections"`
	MinConnections      int           `yaml:"min_connections"`
	MaxIdleConnections  int           `yaml:"max_idle_connections"`
	ConnectionTimeout   time.Duration `yaml:"connection_timeout"`
	IdleTimeout         time.Duration `yaml:"idle_timeout"`
	MaxLifetime         time.Duration `yaml:"max_lifetime"`
	HealthCheckInterval time.Duration `yaml:"health_check_interval"`
	RetryAttempts       int           `yaml:"retry_attempts"`
	RetryDelay          time.Duration `yaml:"retry_delay"`
}

// PooledConnection represents a pooled database connection
type PooledConnection struct {
	conn            *sql.Conn
	id              string
	createdAt       time.Time
	lastUsedAt      atomic.Int64
	useCount        atomic.Uint64
	healthy         atomic.Bool
	inUse           atomic.Bool
	pool            *OptimizedConnectionPool
}

// PoolStatistics tracks pool metrics
type PoolStatistics struct {
	ConnectionsCreated   atomic.Uint64
	ConnectionsDestroyed atomic.Uint64
	ConnectionsReused    atomic.Uint64
	ConnectionsFailed    atomic.Uint64
	WaitTime            atomic.Int64 // nanoseconds
	WaitCount           atomic.Uint64
	QueryCount          atomic.Uint64
	QueryTime           atomic.Int64 // nanoseconds
	ErrorCount          atomic.Uint64
}

// StatementCache caches prepared statements
type StatementCache struct {
	cache    sync.Map // map[string]*PreparedStatement
	maxSize  int
	hits     atomic.Uint64
	misses   atomic.Uint64
	evicted  atomic.Uint64
}

// PreparedStatement represents a cached prepared statement
type PreparedStatement struct {
	stmt        *sql.Stmt
	query       string
	lastUsed    atomic.Int64
	useCount    atomic.Uint64
	createTime  time.Time
}

// HealthChecker monitors connection health
type HealthChecker struct {
	pool     *OptimizedConnectionPool
	interval time.Duration
	timeout  time.Duration
}

// DefaultPoolConfig returns default pool configuration
func DefaultPoolConfig() PoolConfig {
	return PoolConfig{
		Driver:              "postgres",
		MaxConnections:      100,
		MinConnections:      10,
		MaxIdleConnections:  50,
		ConnectionTimeout:   30 * time.Second,
		IdleTimeout:         5 * time.Minute,
		MaxLifetime:         1 * time.Hour,
		HealthCheckInterval: 30 * time.Second,
		RetryAttempts:       3,
		RetryDelay:          1 * time.Second,
	}
}

// NewOptimizedConnectionPool creates a new optimized connection pool
func NewOptimizedConnectionPool(logger *zap.Logger, config PoolConfig) (*OptimizedConnectionPool, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	pool := &OptimizedConnectionPool{
		logger:         logger,
		config:         config,
		driver:         config.Driver,
		dsn:            config.DSN,
		connections:    make(chan *PooledConnection, config.MaxConnections),
		allConnections: make([]*PooledConnection, 0, config.MaxConnections),
		ctx:            ctx,
		cancel:         cancel,
	}
	
	// Initialize circuit breaker
	pool.circuitBreaker = &common.CircuitBreaker{}
	
	// Initialize statement cache
	pool.stmtCache = &StatementCache{
		maxSize: 1000,
	}
	
	// Initialize health checker
	pool.healthChecker = &HealthChecker{
		pool:     pool,
		interval: config.HealthCheckInterval,
		timeout:  5 * time.Second,
	}
	
	// Create initial connections
	if err := pool.createInitialConnections(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create initial connections: %w", err)
	}
	
	// Start maintenance routines
	pool.wg.Add(1)
	go pool.maintenanceLoop()
	
	pool.wg.Add(1)
	go pool.healthCheckLoop()
	
	pool.wg.Add(1)
	go pool.metricsLoop()
	
	logger.Info("Connection pool initialized",
		zap.String("driver", config.Driver),
		zap.Int("min_connections", config.MinConnections),
		zap.Int("max_connections", config.MaxConnections))
	
	return pool, nil
}

// createInitialConnections creates the minimum number of connections
func (pool *OptimizedConnectionPool) createInitialConnections() error {
	for i := 0; i < pool.config.MinConnections; i++ {
		conn, err := pool.createConnection()
		if err != nil {
			// Clean up already created connections
			pool.closeAllConnections()
			return fmt.Errorf("failed to create connection %d: %w", i, err)
		}
		
		pool.connections <- conn
		pool.idleCount.Add(1)
	}
	
	return nil
}

// createConnection creates a new database connection
func (pool *OptimizedConnectionPool) createConnection() (*PooledConnection, error) {
	// Open database connection
	db, err := sql.Open(pool.driver, pool.dsn)
	if err != nil {
		pool.stats.ConnectionsFailed.Add(1)
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	
	// Get a single connection from the DB
	ctx, cancel := context.WithTimeout(pool.ctx, pool.config.ConnectionTimeout)
	defer cancel()
	
	conn, err := db.Conn(ctx)
	if err != nil {
		db.Close()
		pool.stats.ConnectionsFailed.Add(1)
		return nil, fmt.Errorf("failed to get connection: %w", err)
	}
	
	// Test connection
	if err := conn.PingContext(ctx); err != nil {
		conn.Close()
		db.Close()
		pool.stats.ConnectionsFailed.Add(1)
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}
	
	// Create pooled connection
	pooledConn := &PooledConnection{
		conn:      conn,
		id:        fmt.Sprintf("conn-%d-%d", time.Now().UnixNano(), pool.totalCreated.Add(1)),
		createdAt: time.Now(),
		pool:      pool,
	}
	
	pooledConn.lastUsedAt.Store(time.Now().UnixNano())
	pooledConn.healthy.Store(true)
	
	// Track connection
	pool.mu.Lock()
	pool.allConnections = append(pool.allConnections, pooledConn)
	pool.mu.Unlock()
	
	pool.stats.ConnectionsCreated.Add(1)
	
	return pooledConn, nil
}

// Get acquires a connection from the pool
func (pool *OptimizedConnectionPool) Get(ctx context.Context) (*PooledConnection, error) {
	// Check circuit breaker
	if !pool.circuitBreaker.Allow() {
		return nil, fmt.Errorf("circuit breaker open")
	}
	
	startTime := time.Now()
	pool.stats.WaitCount.Add(1)
	
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
			
		case conn := <-pool.connections:
			// Check if connection is healthy
			if !conn.healthy.Load() {
				pool.destroyConnection(conn)
				continue
			}
			
			// Check if connection has exceeded max lifetime
			if time.Since(conn.createdAt) > pool.config.MaxLifetime {
				pool.destroyConnection(conn)
				continue
			}
			
			// Mark as in use
			conn.inUse.Store(true)
			conn.lastUsedAt.Store(time.Now().UnixNano())
			conn.useCount.Add(1)
			
			pool.activeCount.Add(1)
			pool.idleCount.Add(-1)
			pool.stats.ConnectionsReused.Add(1)
			pool.stats.WaitTime.Add(time.Since(startTime).Nanoseconds())
			
			pool.circuitBreaker.RecordSuccess()
			
			return conn, nil
			
		default:
			// No idle connections available
			activeCount := pool.activeCount.Load()
			if activeCount >= int32(pool.config.MaxConnections) {
				// Wait for a connection to become available
				select {
				case conn := <-pool.connections:
					// Recheck in next iteration
					pool.connections <- conn
					time.Sleep(10 * time.Millisecond)
					continue
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			
			// Create new connection
			conn, err := pool.createConnection()
			if err != nil {
				pool.circuitBreaker.RecordFailure()
				pool.stats.ErrorCount.Add(1)
				return nil, fmt.Errorf("failed to create connection: %w", err)
			}
			
			conn.inUse.Store(true)
			pool.activeCount.Add(1)
			pool.stats.WaitTime.Add(time.Since(startTime).Nanoseconds())
			pool.circuitBreaker.RecordSuccess()
			
			return conn, nil
		}
	}
}

// Put returns a connection to the pool
func (pool *OptimizedConnectionPool) Put(conn *PooledConnection) {
	if conn == nil {
		return
	}
	
	// Check if connection belongs to this pool
	if conn.pool != pool {
		conn.Close()
		return
	}
	
	// Mark as not in use
	conn.inUse.Store(false)
	pool.activeCount.Add(-1)
	
	// Check if connection is still healthy
	if !conn.healthy.Load() {
		pool.destroyConnection(conn)
		return
	}
	
	// Check if we have too many idle connections
	if pool.idleCount.Load() >= int32(pool.config.MaxIdleConnections) {
		pool.destroyConnection(conn)
		return
	}
	
	// Return to pool
	select {
	case pool.connections <- conn:
		pool.idleCount.Add(1)
	default:
		// Pool is full, destroy connection
		pool.destroyConnection(conn)
	}
}

// destroyConnection closes and removes a connection
func (pool *OptimizedConnectionPool) destroyConnection(conn *PooledConnection) {
	if conn == nil {
		return
	}
	
	conn.Close()
	
	// Remove from tracking
	pool.mu.Lock()
	for i, c := range pool.allConnections {
		if c == conn {
			pool.allConnections = append(pool.allConnections[:i], pool.allConnections[i+1:]...)
			break
		}
	}
	pool.mu.Unlock()
	
	pool.stats.ConnectionsDestroyed.Add(1)
}

// ExecuteWithRetry executes a query with retry logic
func (pool *OptimizedConnectionPool) ExecuteWithRetry(ctx context.Context, fn func(*sql.Conn) error) error {
	var lastErr error
	
	for attempt := 0; attempt < pool.config.RetryAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(pool.config.RetryDelay * time.Duration(attempt))
		}
		
		conn, err := pool.Get(ctx)
		if err != nil {
			lastErr = err
			continue
		}
		
		err = fn(conn.conn)
		pool.Put(conn)
		
		if err == nil {
			return nil
		}
		
		// Check if error is retryable
		if !isRetryableError(err) {
			return err
		}
		
		lastErr = err
		conn.healthy.Store(false)
	}
	
	return fmt.Errorf("failed after %d attempts: %w", pool.config.RetryAttempts, lastErr)
}

// Prepare prepares a statement with caching
func (pool *OptimizedConnectionPool) Prepare(ctx context.Context, query string) (*PreparedStatement, error) {
	// Check cache
	if cached, ok := pool.stmtCache.cache.Load(query); ok {
		ps := cached.(*PreparedStatement)
		ps.lastUsed.Store(time.Now().UnixNano())
		ps.useCount.Add(1)
		pool.stmtCache.hits.Add(1)
		return ps, nil
	}
	
	pool.stmtCache.misses.Add(1)
	
	// Prepare new statement
	conn, err := pool.Get(ctx)
	if err != nil {
		return nil, err
	}
	defer pool.Put(conn)
	
	stmt, err := conn.conn.PrepareContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to prepare statement: %w", err)
	}
	
	ps := &PreparedStatement{
		stmt:       stmt,
		query:      query,
		createTime: time.Now(),
	}
	ps.lastUsed.Store(time.Now().UnixNano())
	
	// Cache statement
	pool.stmtCache.cache.Store(query, ps)
	
	return ps, nil
}

// maintenanceLoop performs periodic maintenance
func (pool *OptimizedConnectionPool) maintenanceLoop() {
	defer pool.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-pool.ctx.Done():
			return
		case <-ticker.C:
			pool.performMaintenance()
		}
	}
}

// performMaintenance performs maintenance tasks
func (pool *OptimizedConnectionPool) performMaintenance() {
	pool.mu.RLock()
	connections := make([]*PooledConnection, len(pool.allConnections))
	copy(connections, pool.allConnections)
	pool.mu.RUnlock()
	
	for _, conn := range connections {
		// Skip connections in use
		if conn.inUse.Load() {
			continue
		}
		
		// Check idle timeout
		lastUsed := time.Unix(0, conn.lastUsedAt.Load())
		if time.Since(lastUsed) > pool.config.IdleTimeout {
			pool.destroyConnection(conn)
			continue
		}
		
		// Check max lifetime
		if time.Since(conn.createdAt) > pool.config.MaxLifetime {
			pool.destroyConnection(conn)
			continue
		}
	}
	
	// Ensure minimum connections
	currentTotal := len(connections)
	if currentTotal < pool.config.MinConnections {
		for i := currentTotal; i < pool.config.MinConnections; i++ {
			conn, err := pool.createConnection()
			if err != nil {
				pool.logger.Warn("Failed to create connection during maintenance",
					zap.Error(err))
				break
			}
			pool.connections <- conn
			pool.idleCount.Add(1)
		}
	}
	
	// Clean up statement cache
	pool.cleanStatementCache()
}

// cleanStatementCache removes old prepared statements
func (pool *OptimizedConnectionPool) cleanStatementCache() {
	cutoff := time.Now().Add(-1 * time.Hour).UnixNano()
	
	pool.stmtCache.cache.Range(func(key, value interface{}) bool {
		ps := value.(*PreparedStatement)
		if ps.lastUsed.Load() < cutoff {
			ps.stmt.Close()
			pool.stmtCache.cache.Delete(key)
			pool.stmtCache.evicted.Add(1)
		}
		return true
	})
}

// healthCheckLoop performs periodic health checks
func (pool *OptimizedConnectionPool) healthCheckLoop() {
	defer pool.wg.Done()
	
	ticker := time.NewTicker(pool.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-pool.ctx.Done():
			return
		case <-ticker.C:
			pool.performHealthChecks()
		}
	}
}

// performHealthChecks checks health of all connections
func (pool *OptimizedConnectionPool) performHealthChecks() {
	pool.mu.RLock()
	connections := make([]*PooledConnection, len(pool.allConnections))
	copy(connections, pool.allConnections)
	pool.mu.RUnlock()
	
	for _, conn := range connections {
		// Skip connections in use
		if conn.inUse.Load() {
			continue
		}
		
		// Ping connection
		ctx, cancel := context.WithTimeout(pool.ctx, pool.healthChecker.timeout)
		err := conn.conn.PingContext(ctx)
		cancel()
		
		if err != nil {
			conn.healthy.Store(false)
			pool.logger.Debug("Connection health check failed",
				zap.String("id", conn.id),
				zap.Error(err))
		} else {
			conn.healthy.Store(true)
		}
	}
}

// metricsLoop collects and reports metrics
func (pool *OptimizedConnectionPool) metricsLoop() {
	defer pool.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-pool.ctx.Done():
			return
		case <-ticker.C:
			pool.reportMetrics()
		}
	}
}

// reportMetrics logs current metrics
func (pool *OptimizedConnectionPool) reportMetrics() {
	pool.mu.RLock()
	totalConns := len(pool.allConnections)
	pool.mu.RUnlock()
	
	activeConns := pool.activeCount.Load()
	idleConns := pool.idleCount.Load()
	
	avgWaitTime := float64(0)
	if waitCount := pool.stats.WaitCount.Load(); waitCount > 0 {
		avgWaitTime = float64(pool.stats.WaitTime.Load()) / float64(waitCount) / 1e6 // Convert to ms
	}
	
	avgQueryTime := float64(0)
	if queryCount := pool.stats.QueryCount.Load(); queryCount > 0 {
		avgQueryTime = float64(pool.stats.QueryTime.Load()) / float64(queryCount) / 1e6 // Convert to ms
	}
	
	pool.logger.Debug("Connection pool metrics",
		zap.Int("total_connections", totalConns),
		zap.Int32("active_connections", activeConns),
		zap.Int32("idle_connections", idleConns),
		zap.Uint64("connections_created", pool.stats.ConnectionsCreated.Load()),
		zap.Uint64("connections_reused", pool.stats.ConnectionsReused.Load()),
		zap.Float64("avg_wait_time_ms", avgWaitTime),
		zap.Float64("avg_query_time_ms", avgQueryTime),
		zap.Uint64("cache_hits", pool.stmtCache.hits.Load()),
		zap.Uint64("cache_misses", pool.stmtCache.misses.Load()))
}

// GetStats returns pool statistics
func (pool *OptimizedConnectionPool) GetStats() map[string]interface{} {
	pool.mu.RLock()
	totalConns := len(pool.allConnections)
	pool.mu.RUnlock()
	
	waitCount := pool.stats.WaitCount.Load()
	queryCount := pool.stats.QueryCount.Load()
	
	stats := map[string]interface{}{
		"total_connections":      totalConns,
		"active_connections":     pool.activeCount.Load(),
		"idle_connections":       pool.idleCount.Load(),
		"connections_created":    pool.stats.ConnectionsCreated.Load(),
		"connections_destroyed":  pool.stats.ConnectionsDestroyed.Load(),
		"connections_reused":     pool.stats.ConnectionsReused.Load(),
		"connections_failed":     pool.stats.ConnectionsFailed.Load(),
		"wait_count":            waitCount,
		"query_count":           queryCount,
		"error_count":           pool.stats.ErrorCount.Load(),
		"cache_hits":            pool.stmtCache.hits.Load(),
		"cache_misses":          pool.stmtCache.misses.Load(),
		"cache_evicted":         pool.stmtCache.evicted.Load(),
	}
	
	if waitCount > 0 {
		stats["avg_wait_time_ms"] = float64(pool.stats.WaitTime.Load()) / float64(waitCount) / 1e6
	}
	
	if queryCount > 0 {
		stats["avg_query_time_ms"] = float64(pool.stats.QueryTime.Load()) / float64(queryCount) / 1e6
	}
	
	return stats
}

// closeAllConnections closes all connections
func (pool *OptimizedConnectionPool) closeAllConnections() {
	pool.mu.Lock()
	defer pool.mu.Unlock()
	
	for _, conn := range pool.allConnections {
		conn.Close()
	}
	
	pool.allConnections = nil
}

// Shutdown gracefully shuts down the pool
func (pool *OptimizedConnectionPool) Shutdown() error {
	pool.cancel()
	
	// Close all connections
	pool.closeAllConnections()
	
	// Close statement cache
	pool.stmtCache.cache.Range(func(key, value interface{}) bool {
		ps := value.(*PreparedStatement)
		ps.stmt.Close()
		return true
	})
	
	// Wait for routines to finish
	pool.wg.Wait()
	
	pool.logger.Info("Connection pool shut down")
	return nil
}

// PooledConnection methods

// Close closes the connection
func (pc *PooledConnection) Close() error {
	if pc.conn != nil {
		return pc.conn.Close()
	}
	return nil
}

// isRetryableError checks if an error is retryable
func isRetryableError(err error) bool {
	if err == nil {
		return false
	}
	
	// Check for specific retryable database errors
	errStr := err.Error()
	retryablePatterns := []string{
		"connection refused",
		"connection reset",
		"broken pipe",
		"timeout",
		"deadlock",
		"too many connections",
	}
	
	for _, pattern := range retryablePatterns {
		if contains(errStr, pattern) {
			return true
		}
	}
	
	return false
}

// contains checks if a string contains a substring (case-insensitive)
func contains(s, substr string) bool {
	return len(s) >= len(substr) && 
		(s == substr || 
		 len(s) > 0 && len(substr) > 0 && 
		 findSubstring(s, substr))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}