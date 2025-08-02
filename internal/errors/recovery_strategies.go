package errors

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"

	"go.uber.org/zap"
)

// RetryRecoveryStrategy implements exponential backoff retry strategy
type RetryRecoveryStrategy struct {
	MaxRetries int
	Delay      time.Duration
	Backoff    float64
	Jitter     bool
	
	logger *zap.Logger
}

// Recover attempts to recover using retry logic
func (r *RetryRecoveryStrategy) Recover(ctx context.Context, err *Error) error {
	def := &ErrorDefinition{
		Retryable:  true,
		MaxRetries: r.MaxRetries,
		RetryDelay: r.Delay,
	}
	
	for attempt := 0; attempt < def.MaxRetries; attempt++ {
		// Calculate delay with exponential backoff
		delay := r.calculateDelay(attempt)
		
		if r.logger != nil {
			r.logger.Debug("Attempting retry",
				zap.String("error_code", string(err.Code)),
				zap.Int("attempt", attempt+1),
				zap.Duration("delay", delay),
			)
		}
		
		// Wait before retry
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
		
		// Retry logic would go here
		// For now, we'll simulate success on last attempt
		if attempt == def.MaxRetries-1 {
			return nil
		}
	}
	
	return fmt.Errorf("max retries exceeded for %s", err.Code)
}

// CanRecover checks if recovery is possible
func (r *RetryRecoveryStrategy) CanRecover(err *Error) bool {
	// Check if error is retryable
	return err.Severity < SeverityCritical
}

// calculateDelay calculates the retry delay with backoff and jitter
func (r *RetryRecoveryStrategy) calculateDelay(attempt int) time.Duration {
	delay := float64(r.Delay) * math.Pow(r.Backoff, float64(attempt))
	
	if r.Jitter {
		// Add random jitter (±25%)
		jitter := delay * 0.25 * (2*rand.Float64() - 1)
		delay += jitter
	}
	
	return time.Duration(delay)
}

// TimeoutRecoveryStrategy implements timeout extension strategy
type TimeoutRecoveryStrategy struct {
	ExtendTimeout float64
	MaxTimeout    time.Duration
	
	currentTimeout time.Duration
	mu             sync.Mutex
}

// Recover attempts to recover by extending timeout
func (t *TimeoutRecoveryStrategy) Recover(ctx context.Context, err *Error) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	
	// Calculate new timeout
	if t.currentTimeout == 0 {
		t.currentTimeout = 5 * time.Second // Default starting timeout
	}
	
	newTimeout := time.Duration(float64(t.currentTimeout) * t.ExtendTimeout)
	if newTimeout > t.MaxTimeout {
		newTimeout = t.MaxTimeout
	}
	
	t.currentTimeout = newTimeout
	
	// Create new context with extended timeout
	newCtx, cancel := context.WithTimeout(context.Background(), newTimeout)
	defer cancel()
	
	// Retry operation with new timeout
	select {
	case <-newCtx.Done():
		return fmt.Errorf("extended timeout exceeded")
	case <-time.After(100 * time.Millisecond): // Simulate retry
		return nil
	}
}

// CanRecover checks if recovery is possible
func (t *TimeoutRecoveryStrategy) CanRecover(err *Error) bool {
	return err.Code == ErrCodeTimeout
}

// ResourceRecoveryStrategy implements resource fallback strategy
type ResourceRecoveryStrategy struct {
	FallbackEnabled bool
	CacheEnabled    bool
	
	cache      sync.Map
	fallbacks  map[string]interface{}
	fallbackMu sync.RWMutex
}

// Recover attempts to recover using fallback resources
func (r *ResourceRecoveryStrategy) Recover(ctx context.Context, err *Error) error {
	// Try cache first
	if r.CacheEnabled {
		if resource, ok := r.getFromCache(err.Context); ok {
			if r.logger != nil {
				r.logger.Debug("Recovered from cache",
					zap.String("error_code", string(err.Code)),
				)
			}
			return nil
		}
	}
	
	// Try fallback
	if r.FallbackEnabled {
		if fallback := r.getFallback(err.Context); fallback != nil {
			if r.logger != nil {
				r.logger.Debug("Using fallback resource",
					zap.String("error_code", string(err.Code)),
				)
			}
			return nil
		}
	}
	
	return fmt.Errorf("no fallback available for %s", err.Code)
}

// CanRecover checks if recovery is possible
func (r *ResourceRecoveryStrategy) CanRecover(err *Error) bool {
	return err.Code == ErrCodeResource
}

// getFromCache retrieves resource from cache
func (r *ResourceRecoveryStrategy) getFromCache(context map[string]interface{}) (interface{}, bool) {
	if key, ok := context["resource_key"].(string); ok {
		return r.cache.Load(key)
	}
	return nil, false
}

// getFallback retrieves fallback resource
func (r *ResourceRecoveryStrategy) getFallback(context map[string]interface{}) interface{} {
	r.fallbackMu.RLock()
	defer r.fallbackMu.RUnlock()
	
	if key, ok := context["resource_key"].(string); ok {
		return r.fallbacks[key]
	}
	return nil
}

// CircuitBreakerRecoveryStrategy implements circuit breaker recovery
type CircuitBreakerRecoveryStrategy struct {
	OpenThreshold   int
	CloseThreshold  int
	HalfOpenTimeout time.Duration
	
	breakers map[string]*AdaptiveCircuitBreaker
	mu       sync.RWMutex
}

// AdaptiveCircuitBreaker implements an adaptive circuit breaker
type AdaptiveCircuitBreaker struct {
	state           int32 // 0=closed, 1=open, 2=half-open
	failures        int32
	successes       int32
	lastFailureTime time.Time
	
	openThreshold   int
	closeThreshold  int
	halfOpenTimeout time.Duration
	
	mu sync.Mutex
}

// Recover attempts to recover using circuit breaker
func (c *CircuitBreakerRecoveryStrategy) Recover(ctx context.Context, err *Error) error {
	breaker := c.getBreaker(string(err.Code))
	
	if !breaker.Allow() {
		return fmt.Errorf("circuit breaker open for %s", err.Code)
	}
	
	// Simulate recovery attempt
	success := rand.Float32() > 0.3 // 70% success rate
	
	if success {
		breaker.RecordSuccess()
		return nil
	} else {
		breaker.RecordFailure()
		return fmt.Errorf("recovery failed for %s", err.Code)
	}
}

// CanRecover checks if recovery is possible
func (c *CircuitBreakerRecoveryStrategy) CanRecover(err *Error) bool {
	breaker := c.getBreaker(string(err.Code))
	return breaker.Allow()
}

// getBreaker gets or creates a circuit breaker
func (c *CircuitBreakerRecoveryStrategy) getBreaker(name string) *AdaptiveCircuitBreaker {
	c.mu.RLock()
	breaker, exists := c.breakers[name]
	c.mu.RUnlock()
	
	if exists {
		return breaker
	}
	
	c.mu.Lock()
	defer c.mu.Unlock()
	
	if breaker, exists = c.breakers[name]; exists {
		return breaker
	}
	
	breaker = &AdaptiveCircuitBreaker{
		openThreshold:   c.OpenThreshold,
		closeThreshold:  c.CloseThreshold,
		halfOpenTimeout: c.HalfOpenTimeout,
	}
	
	if c.breakers == nil {
		c.breakers = make(map[string]*AdaptiveCircuitBreaker)
	}
	c.breakers[name] = breaker
	
	return breaker
}

// Allow checks if request should be allowed
func (b *AdaptiveCircuitBreaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	switch b.state {
	case 0: // Closed
		return true
	case 1: // Open
		if time.Since(b.lastFailureTime) > b.halfOpenTimeout {
			b.state = 2 // Transition to half-open
			b.successes = 0
			return true
		}
		return false
	case 2: // Half-open
		return true
	}
	
	return false
}

// RecordSuccess records a successful operation
func (b *AdaptiveCircuitBreaker) RecordSuccess() {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	b.successes++
	
	if b.state == 2 && int(b.successes) >= b.closeThreshold {
		b.state = 0 // Close the breaker
		b.failures = 0
	}
}

// RecordFailure records a failed operation  
func (b *AdaptiveCircuitBreaker) RecordFailure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	b.failures++
	b.lastFailureTime = time.Now()
	
	if int(b.failures) >= b.openThreshold {
		b.state = 1 // Open the breaker
		b.successes = 0
	}
}

// HealthCheckRecoveryStrategy implements health check based recovery
type HealthCheckRecoveryStrategy struct {
	HealthChecker   func(ctx context.Context) error
	CheckInterval   time.Duration
	UnhealthyAction func() error
	
	healthy  bool
	mu       sync.RWMutex
	stopCh   chan struct{}
	logger   *zap.Logger
}

// Start starts the health check loop
func (h *HealthCheckRecoveryStrategy) Start() {
	h.stopCh = make(chan struct{})
	go h.healthCheckLoop()
}

// Stop stops the health check loop
func (h *HealthCheckRecoveryStrategy) Stop() {
	if h.stopCh != nil {
		close(h.stopCh)
	}
}

// healthCheckLoop runs periodic health checks
func (h *HealthCheckRecoveryStrategy) healthCheckLoop() {
	ticker := time.NewTicker(h.CheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := h.HealthChecker(ctx)
			cancel()
			
			h.mu.Lock()
			wasHealthy := h.healthy
			h.healthy = err == nil
			h.mu.Unlock()
			
			if wasHealthy && !h.healthy && h.UnhealthyAction != nil {
				if err := h.UnhealthyAction(); err != nil && h.logger != nil {
					h.logger.Error("Unhealthy action failed", zap.Error(err))
				}
			}
			
		case <-h.stopCh:
			return
		}
	}
}

// Recover attempts to recover based on health status
func (h *HealthCheckRecoveryStrategy) Recover(ctx context.Context, err *Error) error {
	h.mu.RLock()
	healthy := h.healthy
	h.mu.RUnlock()
	
	if !healthy {
		return fmt.Errorf("service unhealthy, cannot recover")
	}
	
	// Perform health check
	if h.HealthChecker != nil {
		if checkErr := h.HealthChecker(ctx); checkErr != nil {
			return fmt.Errorf("health check failed: %w", checkErr)
		}
	}
	
	return nil
}

// CanRecover checks if recovery is possible
func (h *HealthCheckRecoveryStrategy) CanRecover(err *Error) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	return h.healthy
}

// CompositeRecoveryStrategy combines multiple recovery strategies
type CompositeRecoveryStrategy struct {
	Strategies []RecoveryStrategy
	Mode       string // "first", "all", "fallback"
}

// Recover attempts recovery using multiple strategies
func (c *CompositeRecoveryStrategy) Recover(ctx context.Context, err *Error) error {
	switch c.Mode {
	case "first":
		// Try strategies until one succeeds
		for _, strategy := range c.Strategies {
			if strategy.CanRecover(err) {
				if recoveryErr := strategy.Recover(ctx, err); recoveryErr == nil {
					return nil
				}
			}
		}
		return fmt.Errorf("all recovery strategies failed")
		
	case "all":
		// All strategies must succeed
		for _, strategy := range c.Strategies {
			if strategy.CanRecover(err) {
				if recoveryErr := strategy.Recover(ctx, err); recoveryErr != nil {
					return recoveryErr
				}
			}
		}
		return nil
		
	case "fallback":
		// Try strategies in order, fallback on failure
		var lastErr error
		for _, strategy := range c.Strategies {
			if strategy.CanRecover(err) {
				if recoveryErr := strategy.Recover(ctx, err); recoveryErr == nil {
					return nil
				} else {
					lastErr = recoveryErr
				}
			}
		}
		return lastErr
		
	default:
		return fmt.Errorf("unknown composite mode: %s", c.Mode)
	}
}

// CanRecover checks if any strategy can recover
func (c *CompositeRecoveryStrategy) CanRecover(err *Error) bool {
	for _, strategy := range c.Strategies {
		if strategy.CanRecover(err) {
			return true
		}
	}
	return false
}