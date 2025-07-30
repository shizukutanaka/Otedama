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

// AdaptiveConnectionPool implements an adaptive connection pool with circuit breakers
// Following Rob Pike's principle: "Don't communicate by sharing memory; share memory by communicating"
type AdaptiveConnectionPool struct {
	logger *zap.Logger
	config *PoolConfig
	
	// Connection management
	connections   map[string]*PooledConnection
	connMu        sync.RWMutex
	idle          chan *PooledConnection
	
	// Circuit breakers
	breakers      map[string]*CircuitBreaker
	breakersMu    sync.RWMutex
	
	// Adaptive sizing
	minSize       atomic.Int32
	maxSize       atomic.Int32
	currentSize   atomic.Int32
	targetSize    atomic.Int32
	
	// Performance metrics
	metrics       *PoolMetrics
	
	// Health checking
	healthChecker *HealthChecker
	
	// Lifecycle
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
}

// PoolConfig contains connection pool configuration
type PoolConfig struct {
	// Pool sizing
	MinConnections      int
	MaxConnections      int
	MaxIdleConnections  int
	
	// Timeouts
	DialTimeout         time.Duration
	IdleTimeout         time.Duration
	MaxLifetime         time.Duration
	
	// Circuit breaker settings
	FailureThreshold    int
	SuccessThreshold    int
	Timeout             time.Duration
	HalfOpenMaxRequests int
	
	// Adaptive settings
	AdaptiveScaling     bool
	ScaleUpThreshold    float64   // CPU/memory usage threshold
	ScaleDownThreshold  float64
	ScaleInterval       time.Duration
	
	// Health check settings
	HealthCheckInterval time.Duration
	HealthCheckTimeout  time.Duration
}

// PooledConnection represents a pooled connection
type PooledConnection struct {
	conn          net.Conn
	id            string
	address       string
	createdAt     time.Time
	lastUsedAt    atomic.Int64
	usageCount    atomic.Uint64
	healthy       atomic.Bool
	mu            sync.Mutex
}

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
	state         atomic.Value // CircuitState
	failures      atomic.Uint32
	successes     atomic.Uint32
	lastFailure   atomic.Int64
	lastSuccess   atomic.Int64
	halfOpenTests atomic.Uint32
	config        *PoolConfig
	mu            sync.Mutex
}

// CircuitState represents circuit breaker states
type CircuitState string

const (
	StateClosed    CircuitState = "closed"
	StateOpen      CircuitState = "open"
	StateHalfOpen  CircuitState = "half-open"
)

// PoolMetrics tracks pool performance metrics
type PoolMetrics struct {
	TotalConnections   atomic.Uint64
	ActiveConnections  atomic.Int32
	IdleConnections    atomic.Int32
	FailedConnections  atomic.Uint64
	SuccessfulRequests atomic.Uint64
	FailedRequests     atomic.Uint64
	AvgResponseTime    atomic.Uint64 // Nanoseconds
}

// NewAdaptiveConnectionPool creates a new adaptive connection pool
func NewAdaptiveConnectionPool(logger *zap.Logger, config *PoolConfig) *AdaptiveConnectionPool {
	if config == nil {
		config = DefaultPoolConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	pool := &AdaptiveConnectionPool{
		logger:        logger,
		config:        config,
		connections:   make(map[string]*PooledConnection),
		idle:          make(chan *PooledConnection, config.MaxIdleConnections),
		breakers:      make(map[string]*CircuitBreaker),
		metrics:       &PoolMetrics{},
		healthChecker: NewHealthChecker(logger, config),
		ctx:           ctx,
		cancel:        cancel,
	}
	
	pool.minSize.Store(int32(config.MinConnections))
	pool.maxSize.Store(int32(config.MaxConnections))
	pool.targetSize.Store(int32(config.MinConnections))
	
	return pool
}

// Start starts the connection pool
func (p *AdaptiveConnectionPool) Start() error {
	p.logger.Info("Starting adaptive connection pool",
		zap.Int("min_connections", int(p.minSize.Load())),
		zap.Int("max_connections", int(p.maxSize.Load())),
		zap.Bool("adaptive_scaling", p.config.AdaptiveScaling),
	)
	
	// Pre-warm pool with minimum connections
	for i := 0; i < int(p.minSize.Load()); i++ {
		// Connection creation will be address-specific in real usage
	}
	
	// Start background workers
	p.wg.Add(1)
	go p.maintainer()
	
	if p.config.AdaptiveScaling {
		p.wg.Add(1)
		go p.scaler()
	}
	
	p.wg.Add(1)
	go p.healthCheckLoop()
	
	return nil
}

// Stop stops the connection pool
func (p *AdaptiveConnectionPool) Stop() error {
	p.logger.Info("Stopping adaptive connection pool")
	
	p.cancel()
	p.wg.Wait()
	
	// Close all connections
	p.connMu.Lock()
	for _, conn := range p.connections {
		conn.Close()
	}
	p.connMu.Unlock()
	
	close(p.idle)
	
	return nil
}

// Get retrieves a connection from the pool
func (p *AdaptiveConnectionPool) Get(ctx context.Context, address string) (*PooledConnection, error) {
	// Check circuit breaker
	breaker := p.getOrCreateBreaker(address)
	if !breaker.Allow() {
		p.metrics.FailedRequests.Add(1)
		return nil, fmt.Errorf("circuit breaker open for %s", address)
	}
	
	// Try to get from idle pool
	select {
	case conn := <-p.idle:
		if conn.IsHealthy() && !conn.IsExpired(p.config.MaxLifetime) {
			conn.lastUsedAt.Store(time.Now().UnixNano())
			conn.usageCount.Add(1)
			p.metrics.SuccessfulRequests.Add(1)
			breaker.RecordSuccess()
			return conn, nil
		}
		// Connection is unhealthy or expired
		conn.Close()
		p.currentSize.Add(-1)
		
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		// No idle connections available
	}
	
	// Create new connection if under limit
	if p.currentSize.Load() < p.maxSize.Load() {
		conn, err := p.createConnection(ctx, address)
		if err != nil {
			p.metrics.FailedConnections.Add(1)
			breaker.RecordFailure()
			return nil, err
		}
		
		p.metrics.SuccessfulRequests.Add(1)
		breaker.RecordSuccess()
		return conn, nil
	}
	
	// Wait for available connection
	timer := time.NewTimer(p.config.DialTimeout)
	defer timer.Stop()
	
	select {
	case conn := <-p.idle:
		if conn.IsHealthy() && !conn.IsExpired(p.config.MaxLifetime) {
			conn.lastUsedAt.Store(time.Now().UnixNano())
			conn.usageCount.Add(1)
			p.metrics.SuccessfulRequests.Add(1)
			breaker.RecordSuccess()
			return conn, nil
		}
		conn.Close()
		p.currentSize.Add(-1)
		return p.Get(ctx, address) // Retry
		
	case <-timer.C:
		p.metrics.FailedRequests.Add(1)
		return nil, fmt.Errorf("connection pool timeout")
		
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Put returns a connection to the pool
func (p *AdaptiveConnectionPool) Put(conn *PooledConnection) {
	if conn == nil {
		return
	}
	
	// Check if connection is still healthy
	if !conn.IsHealthy() || conn.IsExpired(p.config.MaxLifetime) {
		conn.Close()
		p.currentSize.Add(-1)
		return
	}
	
	// Update metrics
	p.metrics.IdleConnections.Add(1)
	p.metrics.ActiveConnections.Add(-1)
	
	// Try to return to idle pool
	select {
	case p.idle <- conn:
		// Successfully returned to pool
	default:
		// Pool is full, close connection
		conn.Close()
		p.currentSize.Add(-1)
	}
}

// GetStats returns pool statistics
func (p *AdaptiveConnectionPool) GetStats() PoolStats {
	return PoolStats{
		TotalConnections:   p.metrics.TotalConnections.Load(),
		ActiveConnections:  int(p.metrics.ActiveConnections.Load()),
		IdleConnections:    int(p.metrics.IdleConnections.Load()),
		FailedConnections:  p.metrics.FailedConnections.Load(),
		SuccessfulRequests: p.metrics.SuccessfulRequests.Load(),
		FailedRequests:     p.metrics.FailedRequests.Load(),
		AvgResponseTime:    time.Duration(p.metrics.AvgResponseTime.Load()),
		CurrentSize:        int(p.currentSize.Load()),
		TargetSize:         int(p.targetSize.Load()),
	}
}

// Private methods

func (p *AdaptiveConnectionPool) createConnection(ctx context.Context, address string) (*PooledConnection, error) {
	dialer := &net.Dialer{
		Timeout: p.config.DialTimeout,
	}
	
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	
	pooled := &PooledConnection{
		conn:      conn,
		id:        generateConnID(),
		address:   address,
		createdAt: time.Now(),
	}
	pooled.healthy.Store(true)
	pooled.lastUsedAt.Store(time.Now().UnixNano())
	
	p.connMu.Lock()
	p.connections[pooled.id] = pooled
	p.connMu.Unlock()
	
	p.currentSize.Add(1)
	p.metrics.TotalConnections.Add(1)
	p.metrics.ActiveConnections.Add(1)
	
	return pooled, nil
}

func (p *AdaptiveConnectionPool) maintainer() {
	defer p.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			p.cleanup()
			
		case <-p.ctx.Done():
			return
		}
	}
}

func (p *AdaptiveConnectionPool) cleanup() {
	// Remove expired connections
	p.connMu.Lock()
	for id, conn := range p.connections {
		if conn.IsExpired(p.config.MaxLifetime) ||
			time.Since(time.Unix(0, conn.lastUsedAt.Load())) > p.config.IdleTimeout {
			delete(p.connections, id)
			conn.Close()
			p.currentSize.Add(-1)
		}
	}
	p.connMu.Unlock()
}

func (p *AdaptiveConnectionPool) scaler() {
	defer p.wg.Done()
	
	ticker := time.NewTicker(p.config.ScaleInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			p.adjustPoolSize()
			
		case <-p.ctx.Done():
			return
		}
	}
}

func (p *AdaptiveConnectionPool) adjustPoolSize() {
	// Calculate pool utilization
	active := float64(p.metrics.ActiveConnections.Load())
	current := float64(p.currentSize.Load())
	
	if current == 0 {
		return
	}
	
	utilization := active / current
	
	// Scale up if utilization is high
	if utilization > p.config.ScaleUpThreshold {
		newTarget := int32(float64(p.targetSize.Load()) * 1.5)
		if newTarget > p.maxSize.Load() {
			newTarget = p.maxSize.Load()
		}
		
		if newTarget != p.targetSize.Load() {
			p.targetSize.Store(newTarget)
			p.logger.Info("Scaling up connection pool",
				zap.Int32("new_target", newTarget),
				zap.Float64("utilization", utilization),
			)
		}
	}
	
	// Scale down if utilization is low
	if utilization < p.config.ScaleDownThreshold {
		newTarget := int32(float64(p.targetSize.Load()) * 0.75)
		if newTarget < p.minSize.Load() {
			newTarget = p.minSize.Load()
		}
		
		if newTarget != p.targetSize.Load() {
			p.targetSize.Store(newTarget)
			p.logger.Info("Scaling down connection pool",
				zap.Int32("new_target", newTarget),
				zap.Float64("utilization", utilization),
			)
		}
	}
}

func (p *AdaptiveConnectionPool) healthCheckLoop() {
	defer p.wg.Done()
	
	ticker := time.NewTicker(p.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			p.checkHealth()
			
		case <-p.ctx.Done():
			return
		}
	}
}

func (p *AdaptiveConnectionPool) checkHealth() {
	p.connMu.RLock()
	conns := make([]*PooledConnection, 0, len(p.connections))
	for _, conn := range p.connections {
		conns = append(conns, conn)
	}
	p.connMu.RUnlock()
	
	for _, conn := range conns {
		if !p.healthChecker.Check(conn) {
			conn.healthy.Store(false)
		}
	}
}

func (p *AdaptiveConnectionPool) getOrCreateBreaker(address string) *CircuitBreaker {
	p.breakersMu.RLock()
	breaker, exists := p.breakers[address]
	p.breakersMu.RUnlock()
	
	if exists {
		return breaker
	}
	
	p.breakersMu.Lock()
	defer p.breakersMu.Unlock()
	
	// Double-check
	if breaker, exists := p.breakers[address]; exists {
		return breaker
	}
	
	breaker = NewCircuitBreaker(p.config)
	p.breakers[address] = breaker
	return breaker
}

// CircuitBreaker methods

func NewCircuitBreaker(config *PoolConfig) *CircuitBreaker {
	cb := &CircuitBreaker{
		config: config,
	}
	cb.state.Store(StateClosed)
	return cb
}

func (cb *CircuitBreaker) Allow() bool {
	state := cb.state.Load().(CircuitState)
	
	switch state {
	case StateClosed:
		return true
		
	case StateOpen:
		// Check if we should transition to half-open
		lastFailure := time.Unix(0, cb.lastFailure.Load())
		if time.Since(lastFailure) > cb.config.timeout {
			cb.TransitionToHalfOpen()
			return cb.halfOpenTests.Add(1) <= uint32(cb.config.HalfOpenMaxRequests)
		}
		return false
		
	case StateHalfOpen:
		return cb.halfOpenTests.Add(1) <= uint32(cb.config.HalfOpenMaxRequests)
	}
	
	return false
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.successes.Add(1)
	cb.lastSuccess.Store(time.Now().UnixNano())
	
	state := cb.state.Load().(CircuitState)
	
	if state == StateHalfOpen {
		if cb.successes.Load() >= uint32(cb.config.SuccessThreshold) {
			cb.TransitionToClosed()
		}
	}
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.failures.Add(1)
	cb.lastFailure.Store(time.Now().UnixNano())
	
	state := cb.state.Load().(CircuitState)
	
	switch state {
	case StateClosed:
		if cb.failures.Load() >= uint32(cb.config.FailureThreshold) {
			cb.TransitionToOpen()
		}
		
	case StateHalfOpen:
		cb.TransitionToOpen()
	}
}

func (cb *CircuitBreaker) TransitionToOpen() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	
	cb.state.Store(StateOpen)
	cb.failures.Store(0)
	cb.successes.Store(0)
}

func (cb *CircuitBreaker) TransitionToHalfOpen() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	
	cb.state.Store(StateHalfOpen)
	cb.halfOpenTests.Store(0)
	cb.failures.Store(0)
	cb.successes.Store(0)
}

func (cb *CircuitBreaker) TransitionToClosed() {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	
	cb.state.Store(StateClosed)
	cb.failures.Store(0)
	cb.successes.Store(0)
}

// PooledConnection methods

func (pc *PooledConnection) IsHealthy() bool {
	return pc.healthy.Load()
}

func (pc *PooledConnection) IsExpired(maxLifetime time.Duration) bool {
	return time.Since(pc.createdAt) > maxLifetime
}

func (pc *PooledConnection) Close() error {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	
	if pc.conn != nil {
		err := pc.conn.Close()
		pc.conn = nil
		return err
	}
	return nil
}

// HealthChecker checks connection health
type HealthChecker struct {
	logger *zap.Logger
	config *PoolConfig
}

func NewHealthChecker(logger *zap.Logger, config *PoolConfig) *HealthChecker {
	return &HealthChecker{
		logger: logger,
		config: config,
	}
}

func (hc *HealthChecker) Check(conn *PooledConnection) bool {
	if conn.conn == nil {
		return false
	}
	
	// Set deadline for health check
	conn.conn.SetDeadline(time.Now().Add(hc.config.HealthCheckTimeout))
	defer conn.conn.SetDeadline(time.Time{})
	
	// Simple ping-pong health check
	// In real implementation, this would be protocol-specific
	_, err := conn.conn.Write([]byte("PING\n"))
	if err != nil {
		return false
	}
	
	buf := make([]byte, 4)
	n, err := conn.conn.Read(buf)
	if err != nil || n != 4 || string(buf[:n]) != "PONG" {
		return false
	}
	
	return true
}

// Helper structures

type PoolStats struct {
	TotalConnections   uint64
	ActiveConnections  int
	IdleConnections    int
	FailedConnections  uint64
	SuccessfulRequests uint64
	FailedRequests     uint64
	AvgResponseTime    time.Duration
	CurrentSize        int
	TargetSize         int
}

// Helper functions

func generateConnID() string {
	return fmt.Sprintf("conn_%d_%d", time.Now().UnixNano(), rand.Int63())
}

// DefaultPoolConfig returns default pool configuration
func DefaultPoolConfig() *PoolConfig {
	return &PoolConfig{
		MinConnections:      10,
		MaxConnections:      100,
		MaxIdleConnections:  50,
		DialTimeout:         10 * time.Second,
		IdleTimeout:         5 * time.Minute,
		MaxLifetime:         30 * time.Minute,
		FailureThreshold:    5,
		SuccessThreshold:    3,
		Timeout:             30 * time.Second,
		HalfOpenMaxRequests: 10,
		AdaptiveScaling:     true,
		ScaleUpThreshold:    0.8,
		ScaleDownThreshold:  0.2,
		ScaleInterval:       1 * time.Minute,
		HealthCheckInterval: 30 * time.Second,
		HealthCheckTimeout:  5 * time.Second,
	}
}