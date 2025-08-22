package network

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// RetryManager manages connection retries with exponential backoff
type RetryManager struct {
	config *RetryConfig
	
	// Statistics
	totalAttempts   atomic.Uint64
	successfulRetries atomic.Uint64
	failedRetries    atomic.Uint64
}

// RetryConfig holds retry configuration
type RetryConfig struct {
	MaxRetries       int
	InitialDelay     time.Duration
	MaxDelay         time.Duration
	Multiplier       float64
	Jitter           float64
	RetryableErrors  []error
}

// Connection represents a network connection
type Connection interface {
	Connect(ctx context.Context) error
	Close() error
	IsConnected() bool
}

// RetryableConnection wraps a connection with retry logic
type RetryableConnection struct {
	conn         Connection
	retryManager *RetryManager
	mu           sync.RWMutex
	
	// State
	connected    atomic.Bool
	lastAttempt  atomic.Value // time.Time
	retryCount   atomic.Int32
}

// DefaultRetryConfig returns default retry configuration
func DefaultRetryConfig() *RetryConfig {
	return &RetryConfig{
		MaxRetries:   10,
		InitialDelay: 1 * time.Second,
		MaxDelay:     60 * time.Second,
		Multiplier:   2.0,
		Jitter:       0.1,
	}
}

// NewRetryManager creates a new retry manager
func NewRetryManager(config *RetryConfig) *RetryManager {
	if config == nil {
		config = DefaultRetryConfig()
	}
	
	return &RetryManager{
		config: config,
	}
}

// ConnectWithRetry attempts connection with exponential backoff
func (rm *RetryManager) ConnectWithRetry(ctx context.Context, conn Connection) error {
	rm.totalAttempts.Add(1)
	
	var lastErr error
	delay := rm.config.InitialDelay
	
	for attempt := 0; attempt <= rm.config.MaxRetries; attempt++ {
		// Check context
		select {
		case <-ctx.Done():
			rm.failedRetries.Add(1)
			return ctx.Err()
		default:
		}
		
		// Attempt connection
		if err := conn.Connect(ctx); err == nil {
			if attempt > 0 {
				rm.successfulRetries.Add(1)
			}
			return nil
		} else {
			lastErr = err
			
			// Check if error is retryable
			if !rm.isRetryable(err) {
				rm.failedRetries.Add(1)
				return err
			}
		}
		
		// Don't delay on last attempt
		if attempt == rm.config.MaxRetries {
			break
		}
		
		// Calculate backoff delay
		backoffDelay := rm.calculateBackoff(delay, attempt)
		
		// Wait with context
		select {
		case <-time.After(backoffDelay):
			// Continue to next attempt
		case <-ctx.Done():
			rm.failedRetries.Add(1)
			return ctx.Err()
		}
		
		// Update delay for next iteration
		delay = time.Duration(float64(delay) * rm.config.Multiplier)
		if delay > rm.config.MaxDelay {
			delay = rm.config.MaxDelay
		}
	}
	
	rm.failedRetries.Add(1)
	return fmt.Errorf("max retries exceeded: %w", lastErr)
}

// calculateBackoff calculates backoff delay with jitter
func (rm *RetryManager) calculateBackoff(baseDelay time.Duration, attempt int) time.Duration {
	// Add jitter
	jitter := rm.config.Jitter * (rand.Float64()*2 - 1) // -jitter to +jitter
	delayMs := float64(baseDelay.Milliseconds())
	delayMs = delayMs * (1 + jitter)
	
	// Ensure minimum delay
	if delayMs < 100 {
		delayMs = 100
	}
	
	return time.Duration(delayMs) * time.Millisecond
}

// isRetryable checks if error is retryable
func (rm *RetryManager) isRetryable(err error) bool {
	// Check for specific retryable errors
	for _, retryableErr := range rm.config.RetryableErrors {
		if errors.Is(err, retryableErr) {
			return true
		}
	}
	
	// Check for network errors
	var netErr net.Error
	if errors.As(err, &netErr) {
		// Retry on timeout or temporary errors
		return netErr.Timeout() || netErr.Temporary()
	}
	
	// Check for specific error types
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return true
	case errors.Is(err, context.Canceled):
		return false
	default:
		// Default to retryable for unknown errors
		return true
	}
}

// GetStatistics returns retry statistics
func (rm *RetryManager) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["total_attempts"] = rm.totalAttempts.Load()
	stats["successful_retries"] = rm.successfulRetries.Load()
	stats["failed_retries"] = rm.failedRetries.Load()
	
	successRate := float64(0)
	if total := rm.totalAttempts.Load(); total > 0 {
		successRate = float64(rm.successfulRetries.Load()) / float64(total) * 100
	}
	stats["success_rate"] = successRate
	
	return stats
}

// NewRetryableConnection creates a retryable connection
func NewRetryableConnection(conn Connection, manager *RetryManager) *RetryableConnection {
	return &RetryableConnection{
		conn:         conn,
		retryManager: manager,
	}
}

// Connect connects with retry logic
func (rc *RetryableConnection) Connect(ctx context.Context) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	
	if rc.connected.Load() {
		return nil
	}
	
	rc.lastAttempt.Store(time.Now())
	rc.retryCount.Store(0)
	
	if err := rc.retryManager.ConnectWithRetry(ctx, rc.conn); err != nil {
		return err
	}
	
	rc.connected.Store(true)
	return nil
}

// Close closes the connection
func (rc *RetryableConnection) Close() error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	
	rc.connected.Store(false)
	return rc.conn.Close()
}

// IsConnected checks if connected
func (rc *RetryableConnection) IsConnected() bool {
	return rc.connected.Load()
}

// ReconnectOnFailure automatically reconnects on failure
func (rc *RetryableConnection) ReconnectOnFailure(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
			if !rc.IsConnected() {
				rc.Connect(ctx)
			}
		}
	}
}

// CircuitBreaker implements circuit breaker pattern
type CircuitBreaker struct {
	maxFailures      int
	resetTimeout     time.Duration
	halfOpenRequests int
	
	mu           sync.RWMutex
	state        State
	failures     int
	lastFailTime time.Time
	successCount int
}

// State represents circuit breaker state
type State int

const (
	StateClosed State = iota
	StateOpen
	StateHalfOpen
)

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		maxFailures:      maxFailures,
		resetTimeout:     resetTimeout,
		halfOpenRequests: 3,
		state:           StateClosed,
	}
}

// Execute executes function with circuit breaker
func (cb *CircuitBreaker) Execute(fn func() error) error {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	
	// Check state
	switch cb.state {
	case StateOpen:
		// Check if we should transition to half-open
		if time.Since(cb.lastFailTime) > cb.resetTimeout {
			cb.state = StateHalfOpen
			cb.successCount = 0
		} else {
			return errors.New("circuit breaker is open")
		}
		
	case StateHalfOpen:
		// Allow limited requests
		if cb.successCount >= cb.halfOpenRequests {
			// Transition to closed
			cb.state = StateClosed
			cb.failures = 0
		}
	}
	
	// Execute function
	err := fn()
	
	if err != nil {
		cb.recordFailure()
	} else {
		cb.recordSuccess()
	}
	
	return err
}

// recordFailure records a failure
func (cb *CircuitBreaker) recordFailure() {
	cb.failures++
	cb.lastFailTime = time.Now()
	
	if cb.failures >= cb.maxFailures {
		cb.state = StateOpen
	}
}

// recordSuccess records a success
func (cb *CircuitBreaker) recordSuccess() {
	if cb.state == StateHalfOpen {
		cb.successCount++
		if cb.successCount >= cb.halfOpenRequests {
			cb.state = StateClosed
			cb.failures = 0
		}
	} else if cb.state == StateClosed {
		cb.failures = 0
	}
}

// GetState returns current state
func (cb *CircuitBreaker) GetState() State {
	cb.mu.RLock()
	defer cb.mu.RUnlock()
	return cb.state
}

// AdaptiveRetry implements adaptive retry with learning
type AdaptiveRetry struct {
	baseConfig   *RetryConfig
	successRates map[string]float64
	mu           sync.RWMutex
}

// NewAdaptiveRetry creates adaptive retry manager
func NewAdaptiveRetry(config *RetryConfig) *AdaptiveRetry {
	return &AdaptiveRetry{
		baseConfig:   config,
		successRates: make(map[string]float64),
	}
}

// RetryWithLearning retries with adaptive behavior
func (ar *AdaptiveRetry) RetryWithLearning(ctx context.Context, endpoint string, fn func() error) error {
	ar.mu.RLock()
	successRate := ar.successRates[endpoint]
	ar.mu.RUnlock()
	
	// Adjust retry config based on success rate
	config := *ar.baseConfig
	if successRate < 0.5 {
		// Poor success rate, be more aggressive
		config.MaxRetries = int(float64(config.MaxRetries) * 1.5)
		config.InitialDelay = config.InitialDelay / 2
	} else if successRate > 0.9 {
		// High success rate, reduce retries
		config.MaxRetries = int(float64(config.MaxRetries) * 0.7)
	}
	
	manager := NewRetryManager(&config)
	
	// Track success
	attempts := 0
	var lastErr error
	
	for attempts <= config.MaxRetries {
		attempts++
		
		if err := fn(); err == nil {
			ar.recordSuccess(endpoint, attempts)
			return nil
		} else {
			lastErr = err
		}
		
		// Backoff
		delay := time.Duration(math.Pow(2, float64(attempts))) * time.Second
		if delay > config.MaxDelay {
			delay = config.MaxDelay
		}
		
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	
	ar.recordFailure(endpoint)
	return lastErr
}

// recordSuccess records successful retry
func (ar *AdaptiveRetry) recordSuccess(endpoint string, attempts int) {
	ar.mu.Lock()
	defer ar.mu.Unlock()
	
	// Update success rate with exponential moving average
	alpha := 0.1
	newRate := 1.0 / float64(attempts)
	
	if oldRate, exists := ar.successRates[endpoint]; exists {
		ar.successRates[endpoint] = alpha*newRate + (1-alpha)*oldRate
	} else {
		ar.successRates[endpoint] = newRate
	}
}

// recordFailure records failed retry
func (ar *AdaptiveRetry) recordFailure(endpoint string) {
	ar.mu.Lock()
	defer ar.mu.Unlock()
	
	// Update success rate
	alpha := 0.1
	if oldRate, exists := ar.successRates[endpoint]; exists {
		ar.successRates[endpoint] = (1 - alpha) * oldRate
	} else {
		ar.successRates[endpoint] = 0
	}
}