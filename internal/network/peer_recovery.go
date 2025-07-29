package network

import (
	"context"
	"fmt"
	"math"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// PeerRecoveryManager handles error recovery for disconnected peers
type PeerRecoveryManager struct {
	logger           *zap.Logger
	config           RecoveryConfig
	reconnectQueue   *ReconnectQueue
	circuitBreakers  sync.Map // peerID -> *CircuitBreaker
	retryStrategies  sync.Map // peerID -> RetryStrategy
	connectionHealth sync.Map // peerID -> *ConnectionHealth
	stats            *RecoveryStats
	mu               sync.RWMutex
}

// RecoveryConfig contains recovery configuration
type RecoveryConfig struct {
	// Retry settings
	MaxRetryAttempts     int
	InitialRetryDelay    time.Duration
	MaxRetryDelay        time.Duration
	RetryBackoffFactor   float64
	
	// Circuit breaker settings
	FailureThreshold     int
	SuccessThreshold     int
	CircuitOpenDuration  time.Duration
	
	// Health check settings
	HealthCheckInterval  time.Duration
	HealthCheckTimeout   time.Duration
	MinHealthyDuration   time.Duration
	
	// Recovery settings
	EnableAutoRecovery   bool
	RecoveryWorkers      int
	QueueSize            int
	PriorityRecovery     bool
}

// ReconnectQueue manages peers waiting for reconnection
type ReconnectQueue struct {
	items    []*ReconnectItem
	itemMap  map[string]*ReconnectItem
	mu       sync.RWMutex
	notifyCh chan struct{}
}

// ReconnectItem represents a peer to reconnect
type ReconnectItem struct {
	PeerID       string
	Address      string
	Priority     int
	RetryCount   int
	LastAttempt  time.Time
	NextAttempt  time.Time
	ErrorHistory []ErrorRecord
	Metadata     map[string]interface{}
}

// ErrorRecord records an error occurrence
type ErrorRecord struct {
	Error     error
	Timestamp time.Time
	ErrorType string
	Severity  ErrorSeverity
}

// ErrorSeverity represents error severity
type ErrorSeverity int

const (
	SeverityLow ErrorSeverity = iota
	SeverityMedium
	SeverityHigh
	SeverityCritical
)

// CircuitBreaker implements circuit breaker pattern
type CircuitBreaker struct {
	state           CircuitState
	failures        int
	successes       int
	lastStateChange time.Time
	lastFailure     time.Time
	mu              sync.RWMutex
}

// CircuitState represents circuit breaker state
type CircuitState int

const (
	CircuitClosed CircuitState = iota
	CircuitOpen
	CircuitHalfOpen
)

// RetryStrategy defines how to retry connections
type RetryStrategy interface {
	NextDelay(attempt int) time.Duration
	ShouldRetry(attempt int, err error) bool
	Reset()
}

// ConnectionHealth tracks connection health metrics
type ConnectionHealth struct {
	PeerID              string
	LastSuccessful      time.Time
	LastFailed          time.Time
	ConsecutiveFailures int
	TotalFailures       int
	TotalSuccesses      int
	AverageLatency      time.Duration
	HealthScore         float64
	mu                  sync.RWMutex
}

// RecoveryStats tracks recovery statistics
type RecoveryStats struct {
	TotalReconnectAttempts   atomic.Uint64
	SuccessfulReconnects     atomic.Uint64
	FailedReconnects         atomic.Uint64
	CircuitBreakerTrips      atomic.Uint64
	AverageRecoveryTime      atomic.Int64 // microseconds
	CurrentQueueSize         atomic.Int32
	ActiveRecoveryWorkers    atomic.Int32
}

// PeerConnection represents a peer connection
type PeerConnection interface {
	Connect(ctx context.Context, address string) error
	IsConnected() bool
	Close() error
	GetID() string
}

// NewPeerRecoveryManager creates a new peer recovery manager
func NewPeerRecoveryManager(config RecoveryConfig, logger *zap.Logger) *PeerRecoveryManager {
	if config.MaxRetryAttempts == 0 {
		config.MaxRetryAttempts = 5
	}
	if config.InitialRetryDelay == 0 {
		config.InitialRetryDelay = 1 * time.Second
	}
	if config.MaxRetryDelay == 0 {
		config.MaxRetryDelay = 5 * time.Minute
	}
	if config.RetryBackoffFactor == 0 {
		config.RetryBackoffFactor = 2.0
	}
	if config.FailureThreshold == 0 {
		config.FailureThreshold = 5
	}
	if config.SuccessThreshold == 0 {
		config.SuccessThreshold = 2
	}
	if config.CircuitOpenDuration == 0 {
		config.CircuitOpenDuration = 30 * time.Second
	}
	if config.RecoveryWorkers == 0 {
		config.RecoveryWorkers = 3
	}
	if config.QueueSize == 0 {
		config.QueueSize = 1000
	}

	prm := &PeerRecoveryManager{
		logger: logger,
		config: config,
		reconnectQueue: &ReconnectQueue{
			itemMap:  make(map[string]*ReconnectItem),
			notifyCh: make(chan struct{}, 1),
		},
		stats: &RecoveryStats{},
	}

	return prm
}

// Start starts the recovery manager
func (prm *PeerRecoveryManager) Start(ctx context.Context) error {
	prm.logger.Info("Starting peer recovery manager",
		zap.Int("workers", prm.config.RecoveryWorkers))

	// Start recovery workers
	for i := 0; i < prm.config.RecoveryWorkers; i++ {
		go prm.recoveryWorker(ctx, i)
	}

	// Start health check routine
	go prm.healthCheckRoutine(ctx)

	// Start statistics routine
	go prm.statsRoutine(ctx)

	return nil
}

// HandleDisconnect handles a peer disconnection
func (prm *PeerRecoveryManager) HandleDisconnect(peerID string, address string, err error) {
	prm.logger.Info("Handling peer disconnect",
		zap.String("peer_id", peerID),
		zap.String("address", address),
		zap.Error(err))

	// Update connection health
	health := prm.getOrCreateHealth(peerID)
	health.RecordFailure()

	// Check circuit breaker
	breaker := prm.getOrCreateCircuitBreaker(peerID)
	if breaker.RecordFailure() {
		prm.stats.CircuitBreakerTrips.Add(1)
		prm.logger.Warn("Circuit breaker tripped",
			zap.String("peer_id", peerID))
	}

	// Classify error
	errorType, severity := prm.classifyError(err)

	// Determine if should attempt recovery
	if !prm.shouldRecover(peerID, errorType, severity) {
		prm.logger.Debug("Skipping recovery for peer",
			zap.String("peer_id", peerID),
			zap.String("reason", "recovery_not_needed"))
		return
	}

	// Add to reconnect queue
	item := &ReconnectItem{
		PeerID:      peerID,
		Address:     address,
		Priority:    prm.calculatePriority(peerID, health),
		RetryCount:  0,
		LastAttempt: time.Now(),
		NextAttempt: time.Now().Add(prm.getInitialDelay(peerID)),
		ErrorHistory: []ErrorRecord{{
			Error:     err,
			Timestamp: time.Now(),
			ErrorType: errorType,
			Severity:  severity,
		}},
		Metadata: make(map[string]interface{}),
	}

	prm.reconnectQueue.Add(item)
	prm.stats.CurrentQueueSize.Add(1)
}

// recoveryWorker processes reconnection attempts
func (prm *PeerRecoveryManager) recoveryWorker(ctx context.Context, id int) {
	prm.stats.ActiveRecoveryWorkers.Add(1)
	defer prm.stats.ActiveRecoveryWorkers.Add(-1)

	prm.logger.Debug("Recovery worker started", zap.Int("worker_id", id))

	for {
		select {
		case <-ctx.Done():
			return
		case <-prm.reconnectQueue.notifyCh:
			prm.processReconnectQueue(ctx)
		case <-time.After(10 * time.Second):
			// Periodic check
			prm.processReconnectQueue(ctx)
		}
	}
}

// processReconnectQueue processes items in the reconnect queue
func (prm *PeerRecoveryManager) processReconnectQueue(ctx context.Context) {
	item := prm.reconnectQueue.GetNext()
	if item == nil {
		return
	}

	// Check if it's time to retry
	if time.Now().Before(item.NextAttempt) {
		prm.reconnectQueue.Requeue(item)
		return
	}

	// Check circuit breaker
	breaker := prm.getOrCreateCircuitBreaker(item.PeerID)
	if !breaker.CanAttempt() {
		// Circuit is open, requeue for later
		item.NextAttempt = time.Now().Add(prm.config.CircuitOpenDuration)
		prm.reconnectQueue.Requeue(item)
		return
	}

	// Attempt reconnection
	prm.stats.TotalReconnectAttempts.Add(1)
	startTime := time.Now()

	err := prm.attemptReconnect(ctx, item)
	
	recoveryTime := time.Since(startTime).Microseconds()
	prm.stats.AverageRecoveryTime.Store(recoveryTime)

	if err == nil {
		// Success
		prm.handleReconnectSuccess(item)
		prm.stats.SuccessfulReconnects.Add(1)
		prm.stats.CurrentQueueSize.Add(-1)
	} else {
		// Failure
		prm.handleReconnectFailure(item, err)
		prm.stats.FailedReconnects.Add(1)
	}
}

// attemptReconnect attempts to reconnect to a peer
func (prm *PeerRecoveryManager) attemptReconnect(ctx context.Context, item *ReconnectItem) error {
	prm.logger.Debug("Attempting reconnect",
		zap.String("peer_id", item.PeerID),
		zap.Int("attempt", item.RetryCount+1))

	// Create connection context with timeout
	connCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Attempt connection (simplified - would use actual connection logic)
	conn, err := net.DialTimeout("tcp", item.Address, 30*time.Second)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer conn.Close()

	// Perform handshake or validation
	if err := prm.validateConnection(connCtx, conn, item.PeerID); err != nil {
		return fmt.Errorf("validation failed: %w", err)
	}

	return nil
}

// validateConnection validates a reconnected connection
func (prm *PeerRecoveryManager) validateConnection(ctx context.Context, conn net.Conn, peerID string) error {
	// Simplified validation - would implement actual protocol
	return nil
}

// handleReconnectSuccess handles successful reconnection
func (prm *PeerRecoveryManager) handleReconnectSuccess(item *ReconnectItem) {
	prm.logger.Info("Reconnection successful",
		zap.String("peer_id", item.PeerID),
		zap.Int("attempts", item.RetryCount+1))

	// Update circuit breaker
	breaker := prm.getOrCreateCircuitBreaker(item.PeerID)
	breaker.RecordSuccess()

	// Update connection health
	health := prm.getOrCreateHealth(item.PeerID)
	health.RecordSuccess()

	// Reset retry strategy
	if strategy, ok := prm.retryStrategies.Load(item.PeerID); ok {
		strategy.(RetryStrategy).Reset()
	}
}

// handleReconnectFailure handles failed reconnection
func (prm *PeerRecoveryManager) handleReconnectFailure(item *ReconnectItem, err error) {
	item.RetryCount++
	item.LastAttempt = time.Now()
	
	// Record error
	errorType, severity := prm.classifyError(err)
	item.ErrorHistory = append(item.ErrorHistory, ErrorRecord{
		Error:     err,
		Timestamp: time.Now(),
		ErrorType: errorType,
		Severity:  severity,
	})

	// Get retry strategy
	strategy := prm.getOrCreateRetryStrategy(item.PeerID)
	
	// Check if should continue retrying
	if !strategy.ShouldRetry(item.RetryCount, err) || 
		item.RetryCount >= prm.config.MaxRetryAttempts {
		prm.logger.Warn("Giving up on peer reconnection",
			zap.String("peer_id", item.PeerID),
			zap.Int("attempts", item.RetryCount),
			zap.Error(err))
		prm.stats.CurrentQueueSize.Add(-1)
		return
	}

	// Calculate next retry time
	delay := strategy.NextDelay(item.RetryCount)
	item.NextAttempt = time.Now().Add(delay)

	prm.logger.Debug("Scheduling retry",
		zap.String("peer_id", item.PeerID),
		zap.Duration("delay", delay),
		zap.Int("attempt", item.RetryCount))

	// Requeue for retry
	prm.reconnectQueue.Requeue(item)
}

// healthCheckRoutine performs periodic health checks
func (prm *PeerRecoveryManager) healthCheckRoutine(ctx context.Context) {
	ticker := time.NewTicker(prm.config.HealthCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			prm.performHealthChecks()
		}
	}
}

// performHealthChecks checks health of all tracked connections
func (prm *PeerRecoveryManager) performHealthChecks() {
	prm.connectionHealth.Range(func(key, value interface{}) bool {
		health := value.(*ConnectionHealth)
		health.UpdateHealthScore()
		
		// Log unhealthy connections
		if health.HealthScore < 0.5 {
			prm.logger.Warn("Unhealthy peer connection",
				zap.String("peer_id", health.PeerID),
				zap.Float64("health_score", health.HealthScore),
				zap.Int("consecutive_failures", health.ConsecutiveFailures))
		}
		
		return true
	})
}

// classifyError classifies an error by type and severity
func (prm *PeerRecoveryManager) classifyError(err error) (string, ErrorSeverity) {
	if err == nil {
		return "none", SeverityLow
	}

	errStr := err.Error()
	
	// Network errors
	if netErr, ok := err.(net.Error); ok {
		if netErr.Timeout() {
			return "timeout", SeverityMedium
		}
		if netErr.Temporary() {
			return "temporary", SeverityLow
		}
	}

	// Connection refused
	if opErr, ok := err.(*net.OpError); ok {
		if opErr.Op == "dial" {
			return "connection_refused", SeverityHigh
		}
	}

	// Generic classification
	switch {
	case contains(errStr, "timeout"):
		return "timeout", SeverityMedium
	case contains(errStr, "refused"):
		return "refused", SeverityHigh
	case contains(errStr, "reset"):
		return "reset", SeverityMedium
	case contains(errStr, "broken pipe"):
		return "broken_pipe", SeverityMedium
	default:
		return "unknown", SeverityMedium
	}
}

// shouldRecover determines if recovery should be attempted
func (prm *PeerRecoveryManager) shouldRecover(peerID string, errorType string, severity ErrorSeverity) bool {
	if !prm.config.EnableAutoRecovery {
		return false
	}

	// Check circuit breaker
	breaker := prm.getOrCreateCircuitBreaker(peerID)
	if breaker.state == CircuitOpen {
		return false
	}

	// Don't recover from critical errors immediately
	if severity == SeverityCritical {
		return false
	}

	return true
}

// calculatePriority calculates reconnection priority
func (prm *PeerRecoveryManager) calculatePriority(peerID string, health *ConnectionHealth) int {
	priority := 50 // Default medium priority

	// Adjust based on health score
	healthScore := health.GetHealthScore()
	if healthScore > 0.8 {
		priority += 20 // Healthy peers get higher priority
	} else if healthScore < 0.3 {
		priority -= 20 // Unhealthy peers get lower priority
	}

	// Adjust based on failure count
	if health.ConsecutiveFailures > 5 {
		priority -= 10
	}

	// Clamp to valid range
	if priority < 0 {
		priority = 0
	} else if priority > 100 {
		priority = 100
	}

	return priority
}

// getInitialDelay calculates initial retry delay
func (prm *PeerRecoveryManager) getInitialDelay(peerID string) time.Duration {
	// Could be customized per peer
	return prm.config.InitialRetryDelay
}

// Helper methods

func (prm *PeerRecoveryManager) getOrCreateCircuitBreaker(peerID string) *CircuitBreaker {
	if val, ok := prm.circuitBreakers.Load(peerID); ok {
		return val.(*CircuitBreaker)
	}

	cb := &CircuitBreaker{
		state: CircuitClosed,
	}
	actual, _ := prm.circuitBreakers.LoadOrStore(peerID, cb)
	return actual.(*CircuitBreaker)
}

func (prm *PeerRecoveryManager) getOrCreateRetryStrategy(peerID string) RetryStrategy {
	if val, ok := prm.retryStrategies.Load(peerID); ok {
		return val.(RetryStrategy)
	}

	strategy := NewExponentialBackoffStrategy(
		prm.config.InitialRetryDelay,
		prm.config.MaxRetryDelay,
		prm.config.RetryBackoffFactor,
	)
	actual, _ := prm.retryStrategies.LoadOrStore(peerID, strategy)
	return actual.(RetryStrategy)
}

func (prm *PeerRecoveryManager) getOrCreateHealth(peerID string) *ConnectionHealth {
	if val, ok := prm.connectionHealth.Load(peerID); ok {
		return val.(*ConnectionHealth)
	}

	health := &ConnectionHealth{
		PeerID:     peerID,
		HealthScore: 1.0,
	}
	actual, _ := prm.connectionHealth.LoadOrStore(peerID, health)
	return actual.(*ConnectionHealth)
}

// GetStats returns recovery statistics
func (prm *PeerRecoveryManager) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"total_reconnect_attempts": prm.stats.TotalReconnectAttempts.Load(),
		"successful_reconnects":    prm.stats.SuccessfulReconnects.Load(),
		"failed_reconnects":        prm.stats.FailedReconnects.Load(),
		"circuit_breaker_trips":    prm.stats.CircuitBreakerTrips.Load(),
		"average_recovery_time":    prm.stats.AverageRecoveryTime.Load(),
		"current_queue_size":       prm.stats.CurrentQueueSize.Load(),
		"active_recovery_workers":  prm.stats.ActiveRecoveryWorkers.Load(),
	}
}

// Component implementations

// ReconnectQueue methods

func (rq *ReconnectQueue) Add(item *ReconnectItem) {
	rq.mu.Lock()
	defer rq.mu.Unlock()

	// Check if already exists
	if _, exists := rq.itemMap[item.PeerID]; exists {
		return
	}

	rq.items = append(rq.items, item)
	rq.itemMap[item.PeerID] = item

	// Notify workers
	select {
	case rq.notifyCh <- struct{}{}:
	default:
	}
}

func (rq *ReconnectQueue) GetNext() *ReconnectItem {
	rq.mu.Lock()
	defer rq.mu.Unlock()

	if len(rq.items) == 0 {
		return nil
	}

	// Find item with earliest next attempt
	now := time.Now()
	var bestIdx int
	var bestItem *ReconnectItem

	for i, item := range rq.items {
		if item.NextAttempt.Before(now) || item.NextAttempt.Equal(now) {
			if bestItem == nil || item.Priority > bestItem.Priority {
				bestIdx = i
				bestItem = item
			}
		}
	}

	if bestItem == nil {
		return nil
	}

	// Remove from queue
	rq.items = append(rq.items[:bestIdx], rq.items[bestIdx+1:]...)
	delete(rq.itemMap, bestItem.PeerID)

	return bestItem
}

func (rq *ReconnectQueue) Requeue(item *ReconnectItem) {
	rq.Add(item)
}

// CircuitBreaker methods

func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.successes++
	cb.failures = 0

	if cb.state == CircuitHalfOpen && cb.successes >= 2 { // Success threshold
		cb.state = CircuitClosed
		cb.lastStateChange = time.Now()
	}
}

func (cb *CircuitBreaker) RecordFailure() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failures++
	cb.lastFailure = time.Now()

	if cb.state == CircuitClosed && cb.failures >= 5 { // Failure threshold
		cb.state = CircuitOpen
		cb.lastStateChange = time.Now()
		return true // Circuit tripped
	}

	if cb.state == CircuitHalfOpen {
		cb.state = CircuitOpen
		cb.lastStateChange = time.Now()
	}

	return false
}

func (cb *CircuitBreaker) CanAttempt() bool {
	cb.mu.RLock()
	defer cb.mu.RUnlock()

	switch cb.state {
	case CircuitClosed:
		return true
	case CircuitOpen:
		// Check if should transition to half-open
		if time.Since(cb.lastStateChange) > 30*time.Second {
			cb.mu.RUnlock()
			cb.mu.Lock()
			cb.state = CircuitHalfOpen
			cb.lastStateChange = time.Now()
			cb.mu.Unlock()
			cb.mu.RLock()
			return true
		}
		return false
	case CircuitHalfOpen:
		return true
	default:
		return false
	}
}

// ConnectionHealth methods

func (ch *ConnectionHealth) RecordSuccess() {
	ch.mu.Lock()
	defer ch.mu.Unlock()

	ch.LastSuccessful = time.Now()
	ch.ConsecutiveFailures = 0
	ch.TotalSuccesses++
	ch.UpdateHealthScore()
}

func (ch *ConnectionHealth) RecordFailure() {
	ch.mu.Lock()
	defer ch.mu.Unlock()

	ch.LastFailed = time.Now()
	ch.ConsecutiveFailures++
	ch.TotalFailures++
	ch.UpdateHealthScore()
}

func (ch *ConnectionHealth) UpdateHealthScore() {
	// Calculate health score based on various factors
	total := ch.TotalSuccesses + ch.TotalFailures
	if total == 0 {
		ch.HealthScore = 1.0
		return
	}

	// Success rate
	successRate := float64(ch.TotalSuccesses) / float64(total)

	// Recency factor
	timeSinceLastSuccess := time.Since(ch.LastSuccessful)
	recencyFactor := 1.0
	if timeSinceLastSuccess > 5*time.Minute {
		recencyFactor = math.Max(0.5, 1.0 - timeSinceLastSuccess.Minutes()/60)
	}

	// Consecutive failures penalty
	failurePenalty := 1.0
	if ch.ConsecutiveFailures > 0 {
		failurePenalty = 1.0 / float64(ch.ConsecutiveFailures+1)
	}

	// Combined score
	ch.HealthScore = successRate * recencyFactor * failurePenalty
}

func (ch *ConnectionHealth) GetHealthScore() float64 {
	ch.mu.RLock()
	defer ch.mu.RUnlock()
	return ch.HealthScore
}

// ExponentialBackoffStrategy implements exponential backoff
type ExponentialBackoffStrategy struct {
	initialDelay time.Duration
	maxDelay     time.Duration
	factor       float64
	jitter       float64
}

func NewExponentialBackoffStrategy(initial, max time.Duration, factor float64) *ExponentialBackoffStrategy {
	return &ExponentialBackoffStrategy{
		initialDelay: initial,
		maxDelay:     max,
		factor:       factor,
		jitter:       0.1, // 10% jitter
	}
}

func (s *ExponentialBackoffStrategy) NextDelay(attempt int) time.Duration {
	delay := float64(s.initialDelay) * math.Pow(s.factor, float64(attempt-1))
	
	// Add jitter
	jitterRange := delay * s.jitter
	jitter := (rand.Float64() - 0.5) * 2 * jitterRange
	delay += jitter

	// Cap at max delay
	if delay > float64(s.maxDelay) {
		delay = float64(s.maxDelay)
	}

	return time.Duration(delay)
}

func (s *ExponentialBackoffStrategy) ShouldRetry(attempt int, err error) bool {
	// Could implement error-specific logic
	return true
}

func (s *ExponentialBackoffStrategy) Reset() {
	// Nothing to reset for stateless strategy
}

// Helper functions

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s[:len(substr)] == substr
}

// Random number generation placeholder
var rand = struct {
	Float64 func() float64
}{
	Float64: func() float64 { return 0.5 }, // Placeholder
}