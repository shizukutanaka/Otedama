package core

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// EnhancedRecoverySystem provides comprehensive error recovery with circuit breakers
// Following John Carmack's principle: "Plan for failure, it will happen"
type EnhancedRecoverySystem struct {
	logger *zap.Logger
	
	// Circuit breakers for different subsystems
	circuitBreakers map[string]*AdaptiveCircuitBreaker
	breakersMu      sync.RWMutex
	
	// Global recovery state
	systemHealth    atomic.Int32 // 0-100 health score
	recoveryMode    atomic.Bool
	
	// Recovery strategies
	strategies      map[string]RecoveryStrategy
	strategiesMu    sync.RWMutex
	
	// Metrics
	metrics         *RecoveryMetrics
	
	// Configuration
	config          *RecoveryConfig
}

// RecoveryConfig contains recovery system configuration
type RecoveryConfig struct {
	// Circuit breaker defaults
	DefaultMaxFailures     int
	DefaultResetTimeout    time.Duration
	DefaultHalfOpenTimeout time.Duration
	
	// System health thresholds
	HealthyThreshold       int32
	DegradedThreshold      int32
	CriticalThreshold      int32
	
	// Recovery settings
	MaxRecoveryAttempts    int
	RecoveryBackoffBase    time.Duration
	RecoveryBackoffMax     time.Duration
	
	// Monitoring
	MetricsInterval        time.Duration
	HealthCheckInterval    time.Duration
}

// AdaptiveCircuitBreaker extends basic circuit breaker with adaptive behavior
type AdaptiveCircuitBreaker struct {
	name            string
	subsystem       string
	
	// Adaptive thresholds
	maxFailures     atomic.Int32
	successRequired atomic.Int32
	
	// Timing
	resetTimeout    atomic.Int64  // nanoseconds
	halfOpenTimeout atomic.Int64  // nanoseconds
	
	// State tracking
	state           atomic.Int32  // CircuitState
	failures        atomic.Int32
	successes       atomic.Int32
	lastFailTime    atomic.Int64
	lastSuccessTime atomic.Int64
	
	// Request tracking
	totalRequests   atomic.Uint64
	failedRequests  atomic.Uint64
	
	// Callbacks
	onStateChange   func(from, to CircuitState)
	onThresholdAdapt func(newThreshold int32)
	
	// Metrics
	avgResponseTime atomic.Int64
	p99ResponseTime atomic.Int64
}

// RecoveryStrategy defines how to recover from failures
type RecoveryStrategy interface {
	Name() string
	CanRecover(error) bool
	Recover(context.Context, error) error
	Priority() int
}

// RecoveryMetrics tracks recovery system metrics
type RecoveryMetrics struct {
	// Circuit breaker metrics
	breakerTrips      atomic.Uint64
	breakerResets     atomic.Uint64
	breakerTimeouts   atomic.Uint64
	
	// Recovery metrics
	recoveryAttempts  atomic.Uint64
	recoverySuccesses atomic.Uint64
	recoveryFailures  atomic.Uint64
	
	// System metrics
	healthChecks      atomic.Uint64
	criticalEvents    atomic.Uint64
	
	// Timing metrics
	avgRecoveryTime   atomic.Int64
	maxRecoveryTime   atomic.Int64
}

// NewEnhancedRecoverySystem creates a new enhanced recovery system
func NewEnhancedRecoverySystem(logger *zap.Logger, config *RecoveryConfig) *EnhancedRecoverySystem {
	if config == nil {
		config = DefaultRecoveryConfig()
	}
	
	system := &EnhancedRecoverySystem{
		logger:          logger,
		circuitBreakers: make(map[string]*AdaptiveCircuitBreaker),
		strategies:      make(map[string]RecoveryStrategy),
		metrics:         &RecoveryMetrics{},
		config:          config,
	}
	
	// Set initial health
	system.systemHealth.Store(100)
	
	// Register default strategies
	system.registerDefaultStrategies()
	
	return system
}

// RegisterCircuitBreaker registers a new adaptive circuit breaker
func (ers *EnhancedRecoverySystem) RegisterCircuitBreaker(name, subsystem string) *AdaptiveCircuitBreaker {
	ers.breakersMu.Lock()
	defer ers.breakersMu.Unlock()
	
	if breaker, exists := ers.circuitBreakers[name]; exists {
		return breaker
	}
	
	breaker := &AdaptiveCircuitBreaker{
		name:      name,
		subsystem: subsystem,
	}
	
	// Set defaults
	breaker.maxFailures.Store(int32(ers.config.DefaultMaxFailures))
	breaker.successRequired.Store(3) // Require 3 successes in half-open
	breaker.resetTimeout.Store(ers.config.DefaultResetTimeout.Nanoseconds())
	breaker.halfOpenTimeout.Store(ers.config.DefaultHalfOpenTimeout.Nanoseconds())
	
	ers.circuitBreakers[name] = breaker
	
	ers.logger.Info("Registered circuit breaker",
		zap.String("name", name),
		zap.String("subsystem", subsystem),
	)
	
	return breaker
}

// Execute executes a function with recovery and circuit breaker protection
func (ers *EnhancedRecoverySystem) Execute(ctx context.Context, name string, fn func() error) error {
	ers.breakersMu.RLock()
	breaker, exists := ers.circuitBreakers[name]
	ers.breakersMu.RUnlock()
	
	if !exists {
		// Create breaker on demand
		breaker = ers.RegisterCircuitBreaker(name, "default")
	}
	
	// Check circuit breaker
	if !breaker.CanExecute() {
		ers.metrics.breakerTimeouts.Add(1)
		return fmt.Errorf("circuit breaker '%s' is open", name)
	}
	
	// Measure execution time
	start := time.Now()
	
	// Execute with panic recovery
	err := ers.executeWithRecovery(ctx, breaker, fn)
	
	// Update metrics
	elapsed := time.Since(start)
	breaker.updateResponseTime(elapsed)
	
	if err != nil {
		// Try recovery strategies
		if recoveredErr := ers.tryRecover(ctx, name, err); recoveredErr == nil {
			breaker.RecordSuccess()
			return nil
		}
		
		breaker.RecordFailure()
		return err
	}
	
	breaker.RecordSuccess()
	return nil
}

// ExecuteWithRetry executes with retry logic and circuit breaker
func (ers *EnhancedRecoverySystem) ExecuteWithRetry(ctx context.Context, name string, maxRetries int, fn func() error) error {
	var lastErr error
	backoff := ers.config.RecoveryBackoffBase
	
	for attempt := 0; attempt <= maxRetries; attempt++ {
		// Use circuit breaker for each attempt
		err := ers.Execute(ctx, name, fn)
		if err == nil {
			return nil
		}
		
		lastErr = err
		
		// Check if error is retryable
		if !ers.isRetryable(err) {
			return err
		}
		
		// Don't retry on last attempt
		if attempt == maxRetries {
			break
		}
		
		// Wait with backoff
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
			// Exponential backoff with cap
			backoff = backoff * 2
			if backoff > ers.config.RecoveryBackoffMax {
				backoff = ers.config.RecoveryBackoffMax
			}
		}
		
		ers.logger.Debug("Retrying operation",
			zap.String("operation", name),
			zap.Int("attempt", attempt+1),
			zap.Duration("backoff", backoff),
		)
	}
	
	return fmt.Errorf("max retries exceeded for %s: %w", name, lastErr)
}

// GetSystemHealth returns the current system health score (0-100)
func (ers *EnhancedRecoverySystem) GetSystemHealth() int32 {
	return ers.systemHealth.Load()
}

// IsHealthy returns true if system is healthy
func (ers *EnhancedRecoverySystem) IsHealthy() bool {
	return ers.systemHealth.Load() >= ers.config.HealthyThreshold
}

// IsDegraded returns true if system is degraded
func (ers *EnhancedRecoverySystem) IsDegraded() bool {
	health := ers.systemHealth.Load()
	return health < ers.config.HealthyThreshold && health >= ers.config.DegradedThreshold
}

// IsCritical returns true if system is in critical state
func (ers *EnhancedRecoverySystem) IsCritical() bool {
	return ers.systemHealth.Load() < ers.config.CriticalThreshold
}

// GetCircuitBreakerStats returns statistics for all circuit breakers
func (ers *EnhancedRecoverySystem) GetCircuitBreakerStats() map[string]CircuitBreakerStats {
	ers.breakersMu.RLock()
	defer ers.breakersMu.RUnlock()
	
	stats := make(map[string]CircuitBreakerStats)
	for name, breaker := range ers.circuitBreakers {
		stats[name] = CircuitBreakerStats{
			Name:            name,
			Subsystem:       breaker.subsystem,
			State:           breaker.GetState(),
			Failures:        breaker.failures.Load(),
			TotalRequests:   breaker.totalRequests.Load(),
			FailedRequests:  breaker.failedRequests.Load(),
			AvgResponseTime: time.Duration(breaker.avgResponseTime.Load()),
			P99ResponseTime: time.Duration(breaker.p99ResponseTime.Load()),
		}
	}
	
	return stats
}

// Private methods

func (ers *EnhancedRecoverySystem) executeWithRecovery(ctx context.Context, breaker *AdaptiveCircuitBreaker, fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			// Get stack trace
			stack := make([]byte, 4096)
			n := runtime.Stack(stack, false)
			
			err = fmt.Errorf("panic in %s: %v\nStack:\n%s", breaker.name, r, stack[:n])
			
			ers.logger.Error("Panic recovered",
				zap.String("breaker", breaker.name),
				zap.Any("panic", r),
				zap.String("stack", string(stack[:n])),
			)
			
			// Update health score
			ers.updateHealthScore(-10)
		}
	}()
	
	// Execute function
	return fn()
}

func (ers *EnhancedRecoverySystem) tryRecover(ctx context.Context, operation string, err error) error {
	ers.metrics.recoveryAttempts.Add(1)
	
	// Get applicable strategies
	strategies := ers.getApplicableStrategies(err)
	if len(strategies) == 0 {
		ers.metrics.recoveryFailures.Add(1)
		return err
	}
	
	// Try strategies in priority order
	for _, strategy := range strategies {
		ers.logger.Debug("Attempting recovery",
			zap.String("operation", operation),
			zap.String("strategy", strategy.Name()),
			zap.Error(err),
		)
		
		if recoveryErr := strategy.Recover(ctx, err); recoveryErr == nil {
			ers.metrics.recoverySuccesses.Add(1)
			ers.logger.Info("Recovery successful",
				zap.String("operation", operation),
				zap.String("strategy", strategy.Name()),
			)
			return nil
		}
	}
	
	ers.metrics.recoveryFailures.Add(1)
	return err
}

func (ers *EnhancedRecoverySystem) getApplicableStrategies(err error) []RecoveryStrategy {
	ers.strategiesMu.RLock()
	defer ers.strategiesMu.RUnlock()
	
	var applicable []RecoveryStrategy
	for _, strategy := range ers.strategies {
		if strategy.CanRecover(err) {
			applicable = append(applicable, strategy)
		}
	}
	
	// Sort by priority (higher priority first)
	// Simple bubble sort for small lists
	for i := 0; i < len(applicable)-1; i++ {
		for j := 0; j < len(applicable)-i-1; j++ {
			if applicable[j].Priority() < applicable[j+1].Priority() {
				applicable[j], applicable[j+1] = applicable[j+1], applicable[j]
			}
		}
	}
	
	return applicable
}

func (ers *EnhancedRecoverySystem) updateHealthScore(delta int32) {
	for {
		current := ers.systemHealth.Load()
		newScore := current + delta
		
		// Clamp to 0-100
		if newScore < 0 {
			newScore = 0
		} else if newScore > 100 {
			newScore = 100
		}
		
		if ers.systemHealth.CompareAndSwap(current, newScore) {
			// Check for critical events
			if newScore < ers.config.CriticalThreshold && current >= ers.config.CriticalThreshold {
				ers.metrics.criticalEvents.Add(1)
				ers.logger.Error("System entered critical state",
					zap.Int32("health", newScore),
				)
			}
			break
		}
	}
}

func (ers *EnhancedRecoverySystem) isRetryable(err error) bool {
	// Don't retry on context errors
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	
	// Check if any strategy can handle it
	ers.strategiesMu.RLock()
	defer ers.strategiesMu.RUnlock()
	
	for _, strategy := range ers.strategies {
		if strategy.CanRecover(err) {
			return true
		}
	}
	
	return false
}

func (ers *EnhancedRecoverySystem) registerDefaultStrategies() {
	// Register network error recovery
	ers.RegisterStrategy(&NetworkRecoveryStrategy{})
	
	// Register timeout recovery
	ers.RegisterStrategy(&TimeoutRecoveryStrategy{})
	
	// Register resource exhaustion recovery
	ers.RegisterStrategy(&ResourceRecoveryStrategy{})
}

// RegisterStrategy registers a recovery strategy
func (ers *EnhancedRecoverySystem) RegisterStrategy(strategy RecoveryStrategy) {
	ers.strategiesMu.Lock()
	defer ers.strategiesMu.Unlock()
	
	ers.strategies[strategy.Name()] = strategy
	ers.logger.Info("Registered recovery strategy", zap.String("name", strategy.Name()))
}

// CircuitBreakerStats contains circuit breaker statistics
type CircuitBreakerStats struct {
	Name            string
	Subsystem       string
	State           string
	Failures        int32
	TotalRequests   uint64
	FailedRequests  uint64
	AvgResponseTime time.Duration
	P99ResponseTime time.Duration
}

// AdaptiveCircuitBreaker methods

func (acb *AdaptiveCircuitBreaker) CanExecute() bool {
	state := CircuitState(acb.state.Load())
	
	switch state {
	case StateClosed:
		return true
		
	case StateOpen:
		// Check if we should transition to half-open
		lastFail := acb.lastFailTime.Load()
		resetTimeout := time.Duration(acb.resetTimeout.Load())
		if time.Since(time.Unix(0, lastFail)) > resetTimeout {
			acb.transitionTo(StateHalfOpen)
			return true
		}
		return false
		
	case StateHalfOpen:
		// In half-open, we allow limited requests
		return true
		
	default:
		return false
	}
}

func (acb *AdaptiveCircuitBreaker) RecordSuccess() {
	acb.totalRequests.Add(1)
	acb.lastSuccessTime.Store(time.Now().UnixNano())
	
	state := CircuitState(acb.state.Load())
	
	if state == StateHalfOpen {
		successes := acb.successes.Add(1)
		if successes >= acb.successRequired.Load() {
			// Enough successes, close the breaker
			acb.transitionTo(StateClosed)
			acb.adaptThresholds(true)
		}
	}
}

func (acb *AdaptiveCircuitBreaker) RecordFailure() {
	acb.totalRequests.Add(1)
	acb.failedRequests.Add(1)
	acb.lastFailTime.Store(time.Now().UnixNano())
	
	state := CircuitState(acb.state.Load())
	
	switch state {
	case StateClosed:
		failures := acb.failures.Add(1)
		if failures >= acb.maxFailures.Load() {
			acb.transitionTo(StateOpen)
			acb.adaptThresholds(false)
		}
		
	case StateHalfOpen:
		// Any failure in half-open state reopens the breaker
		acb.transitionTo(StateOpen)
		acb.failures.Store(0)
		acb.successes.Store(0)
	}
}

func (acb *AdaptiveCircuitBreaker) transitionTo(newState CircuitState) {
	oldState := CircuitState(acb.state.Swap(int32(newState)))
	
	if oldState != newState {
		// Reset counters on state change
		if newState == StateClosed {
			acb.failures.Store(0)
			acb.successes.Store(0)
		}
		
		if acb.onStateChange != nil {
			acb.onStateChange(oldState, newState)
		}
	}
}

func (acb *AdaptiveCircuitBreaker) adaptThresholds(success bool) {
	if success {
		// Increase failure threshold slightly (be more tolerant)
		current := acb.maxFailures.Load()
		if current < 10 {
			acb.maxFailures.Store(current + 1)
		}
	} else {
		// Decrease failure threshold (be more strict)
		current := acb.maxFailures.Load()
		if current > 2 {
			acb.maxFailures.Store(current - 1)
		}
		
		// Increase reset timeout
		currentTimeout := time.Duration(acb.resetTimeout.Load())
		newTimeout := currentTimeout + (currentTimeout / 10) // Add 10%
		if newTimeout > 5*time.Minute {
			newTimeout = 5 * time.Minute
		}
		acb.resetTimeout.Store(newTimeout.Nanoseconds())
	}
	
	if acb.onThresholdAdapt != nil {
		acb.onThresholdAdapt(acb.maxFailures.Load())
	}
}

func (acb *AdaptiveCircuitBreaker) updateResponseTime(duration time.Duration) {
	// Simple moving average for demo (real implementation would use better algorithm)
	current := acb.avgResponseTime.Load()
	if current == 0 {
		acb.avgResponseTime.Store(duration.Nanoseconds())
	} else {
		// Weighted average: 90% old, 10% new
		newAvg := (current*9 + duration.Nanoseconds()) / 10
		acb.avgResponseTime.Store(newAvg)
	}
	
	// Update P99 (simplified - just track max for demo)
	if duration.Nanoseconds() > acb.p99ResponseTime.Load() {
		acb.p99ResponseTime.Store(duration.Nanoseconds())
	}
}

func (acb *AdaptiveCircuitBreaker) GetState() string {
	switch CircuitState(acb.state.Load()) {
	case StateClosed:
		return "closed"
	case StateOpen:
		return "open"
	case StateHalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// Default recovery strategies

type NetworkRecoveryStrategy struct{}

func (n *NetworkRecoveryStrategy) Name() string { return "network" }
func (n *NetworkRecoveryStrategy) Priority() int { return 10 }
func (n *NetworkRecoveryStrategy) CanRecover(err error) bool {
	// Check for network-related errors
	errStr := err.Error()
	return errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, errors.New("connection refused")) ||
		errors.Is(err, errors.New("no route to host")) ||
		// Simple string matching for demo
		(errStr != "" && (errors.Is(err, errors.New("timeout")) || 
			errors.Is(err, errors.New("connection reset"))))
}

func (n *NetworkRecoveryStrategy) Recover(ctx context.Context, err error) error {
	// Wait a bit for network to recover
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(500 * time.Millisecond):
		return nil // Assume network might have recovered
	}
}

type TimeoutRecoveryStrategy struct{}

func (t *TimeoutRecoveryStrategy) Name() string { return "timeout" }
func (t *TimeoutRecoveryStrategy) Priority() int { return 5 }
func (t *TimeoutRecoveryStrategy) CanRecover(err error) bool {
	return errors.Is(err, context.DeadlineExceeded)
}

func (t *TimeoutRecoveryStrategy) Recover(ctx context.Context, err error) error {
	// Can't really recover from timeout, just acknowledge it
	return err
}

type ResourceRecoveryStrategy struct{}

func (r *ResourceRecoveryStrategy) Name() string { return "resource" }
func (r *ResourceRecoveryStrategy) Priority() int { return 15 }
func (r *ResourceRecoveryStrategy) CanRecover(err error) bool {
	errStr := err.Error()
	return errStr != "" && (errors.Is(err, errors.New("out of memory")) ||
		errors.Is(err, errors.New("too many open files")) ||
		errors.Is(err, errors.New("no space left")))
}

func (r *ResourceRecoveryStrategy) Recover(ctx context.Context, err error) error {
	// Force garbage collection to free memory
	runtime.GC()
	
	// Wait a moment
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(1 * time.Second):
		return nil
	}
}

// DefaultRecoveryConfig returns default recovery configuration
func DefaultRecoveryConfig() *RecoveryConfig {
	return &RecoveryConfig{
		DefaultMaxFailures:     5,
		DefaultResetTimeout:    30 * time.Second,
		DefaultHalfOpenTimeout: 15 * time.Second,
		HealthyThreshold:       80,
		DegradedThreshold:      50,
		CriticalThreshold:      20,
		MaxRecoveryAttempts:    3,
		RecoveryBackoffBase:    100 * time.Millisecond,
		RecoveryBackoffMax:     10 * time.Second,
		MetricsInterval:        10 * time.Second,
		HealthCheckInterval:    30 * time.Second,
	}
}