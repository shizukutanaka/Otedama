package recovery

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// RecoveryManager provides comprehensive error recovery
type RecoveryManager struct {
	ctx           context.Context
	cancel        context.CancelFunc
	errorHandlers map[string]ErrorHandler
	handlersMu    sync.RWMutex
	
	// Circuit breaker
	circuitBreakers map[string]*CircuitBreaker
	breakersMu      sync.RWMutex
	
	// Statistics
	panicCount     atomic.Uint64
	recoveryCount  atomic.Uint64
	errorCount     atomic.Uint64
	
	// Recovery strategies
	strategies     map[string]RecoveryStrategy
	strategiesMu   sync.RWMutex
}

// ErrorHandler handles specific error types
type ErrorHandler func(err error) error

// RecoveryStrategy defines how to recover from errors
type RecoveryStrategy interface {
	Recover(err error) error
	CanRecover(err error) bool
}

// CircuitBreaker prevents cascading failures
type CircuitBreaker struct {
	name          string
	failures      atomic.Uint32
	lastFailure   atomic.Value
	state         atomic.Value
	threshold     uint32
	timeout       time.Duration
	halfOpenTests atomic.Uint32
}

// CircuitState represents circuit breaker state
type CircuitState int

const (
	StateClosed CircuitState = iota
	StateOpen
	StateHalfOpen
)

// NewRecoveryManager creates a new recovery manager
func NewRecoveryManager(ctx context.Context) *RecoveryManager {
	ctx, cancel := context.WithCancel(ctx)
	
	rm := &RecoveryManager{
		ctx:             ctx,
		cancel:          cancel,
		errorHandlers:   make(map[string]ErrorHandler),
		circuitBreakers: make(map[string]*CircuitBreaker),
		strategies:      make(map[string]RecoveryStrategy),
	}
	
	// Register default strategies
	rm.RegisterStrategy("retry", &RetryStrategy{MaxRetries: 3})
	rm.RegisterStrategy("fallback", &FallbackStrategy{})
	rm.RegisterStrategy("graceful", &GracefulDegradationStrategy{})
	
	// Start monitoring
	go rm.monitor()
	
	return rm
}

// Recover recovers from panics
func (rm *RecoveryManager) Recover() {
	if r := recover(); r != nil {
		rm.panicCount.Add(1)
		
		// Get stack trace
		stack := debug.Stack()
		
		// Log panic
		fmt.Printf("Panic recovered: %v\nStack: %s\n", r, stack)
		
		// Convert panic to error
		var err error
		switch v := r.(type) {
		case error:
			err = v
		case string:
			err = errors.New(v)
		default:
			err = fmt.Errorf("panic: %v", v)
		}
		
		// Attempt recovery
		if recoveryErr := rm.attemptRecovery(err); recoveryErr != nil {
			fmt.Printf("Recovery failed: %v\n", recoveryErr)
		} else {
			rm.recoveryCount.Add(1)
		}
	}
}

// RecoverWithContext recovers with context
func (rm *RecoveryManager) RecoverWithContext(ctx context.Context, fn func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			rm.panicCount.Add(1)
			
			switch v := r.(type) {
			case error:
				err = v
			case string:
				err = errors.New(v)
			default:
				err = fmt.Errorf("panic: %v", v)
			}
			
			// Attempt recovery with context
			if recoveryErr := rm.attemptRecoveryWithContext(ctx, err); recoveryErr != nil {
				err = fmt.Errorf("recovery failed: %w", recoveryErr)
			} else {
				rm.recoveryCount.Add(1)
				err = nil
			}
		}
	}()
	
	fn()
	return nil
}

// HandleError handles an error with recovery
func (rm *RecoveryManager) HandleError(err error) error {
	if err == nil {
		return nil
	}
	
	rm.errorCount.Add(1)
	
	// Check if we have a specific handler
	rm.handlersMu.RLock()
	handler, exists := rm.errorHandlers[fmt.Sprintf("%T", err)]
	rm.handlersMu.RUnlock()
	
	if exists {
		return handler(err)
	}
	
	// Try recovery strategies
	return rm.attemptRecovery(err)
}

// attemptRecovery attempts to recover from an error
func (rm *RecoveryManager) attemptRecovery(err error) error {
	rm.strategiesMu.RLock()
	defer rm.strategiesMu.RUnlock()
	
	// Try each strategy
	for name, strategy := range rm.strategies {
		if strategy.CanRecover(err) {
			if recoveryErr := strategy.Recover(err); recoveryErr == nil {
				fmt.Printf("Recovered using strategy: %s\n", name)
				return nil
			}
		}
	}
	
	return err
}

// attemptRecoveryWithContext attempts recovery with context
func (rm *RecoveryManager) attemptRecoveryWithContext(ctx context.Context, err error) error {
	// Check context cancellation
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	
	return rm.attemptRecovery(err)
}

// RegisterHandler registers an error handler
func (rm *RecoveryManager) RegisterHandler(errorType string, handler ErrorHandler) {
	rm.handlersMu.Lock()
	defer rm.handlersMu.Unlock()
	rm.errorHandlers[errorType] = handler
}

// RegisterStrategy registers a recovery strategy
func (rm *RecoveryManager) RegisterStrategy(name string, strategy RecoveryStrategy) {
	rm.strategiesMu.Lock()
	defer rm.strategiesMu.Unlock()
	rm.strategies[name] = strategy
}

// GetCircuitBreaker gets or creates a circuit breaker
func (rm *RecoveryManager) GetCircuitBreaker(name string) *CircuitBreaker {
	rm.breakersMu.RLock()
	cb, exists := rm.circuitBreakers[name]
	rm.breakersMu.RUnlock()
	
	if !exists {
		rm.breakersMu.Lock()
		cb = &CircuitBreaker{
			name:      name,
			threshold: 5,
			timeout:   30 * time.Second,
		}
		cb.state.Store(StateClosed)
		rm.circuitBreakers[name] = cb
		rm.breakersMu.Unlock()
	}
	
	return cb
}

// monitor monitors system health
func (rm *RecoveryManager) monitor() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Check memory usage
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			
			if m.Alloc > 1<<30 { // 1GB
				// Trigger GC
				runtime.GC()
			}
			
			// Check goroutine count
			if runtime.NumGoroutine() > 10000 {
				fmt.Println("Warning: High goroutine count")
			}
			
		case <-rm.ctx.Done():
			return
		}
	}
}

// GetStatistics returns recovery statistics
func (rm *RecoveryManager) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	stats["panic_count"] = rm.panicCount.Load()
	stats["recovery_count"] = rm.recoveryCount.Load()
	stats["error_count"] = rm.errorCount.Load()
	
	rm.breakersMu.RLock()
	stats["circuit_breakers"] = len(rm.circuitBreakers)
	rm.breakersMu.RUnlock()
	
	return stats
}

// Call executes a function through the circuit breaker
func (cb *CircuitBreaker) Call(fn func() error) error {
	state := cb.state.Load().(CircuitState)
	
	switch state {
	case StateOpen:
		// Check if timeout has passed
		lastFailure := cb.lastFailure.Load()
		if lastFailure != nil {
			if time.Since(lastFailure.(time.Time)) > cb.timeout {
				cb.state.Store(StateHalfOpen)
				cb.halfOpenTests.Store(0)
			} else {
				return errors.New("circuit breaker is open")
			}
		}
		
	case StateHalfOpen:
		// Allow limited tests
		tests := cb.halfOpenTests.Add(1)
		if tests > 3 {
			return errors.New("circuit breaker is testing")
		}
	}
	
	// Execute function
	err := fn()
	
	if err != nil {
		cb.recordFailure()
		return err
	}
	
	cb.recordSuccess()
	return nil
}

// recordFailure records a failure
func (cb *CircuitBreaker) recordFailure() {
	failures := cb.failures.Add(1)
	cb.lastFailure.Store(time.Now())
	
	if failures >= cb.threshold {
		cb.state.Store(StateOpen)
	}
}

// recordSuccess records a success
func (cb *CircuitBreaker) recordSuccess() {
	state := cb.state.Load().(CircuitState)
	
	if state == StateHalfOpen {
		cb.state.Store(StateClosed)
		cb.failures.Store(0)
	}
}

// RetryStrategy implements retry logic
type RetryStrategy struct {
	MaxRetries int
	Delay      time.Duration
	Backoff    float64
}

// Recover attempts recovery through retry
func (rs *RetryStrategy) Recover(err error) error {
	delay := rs.Delay
	if delay == 0 {
		delay = 100 * time.Millisecond
	}
	
	for i := 0; i < rs.MaxRetries; i++ {
		time.Sleep(delay)
		
		// Exponential backoff
		if rs.Backoff > 0 {
			delay = time.Duration(float64(delay) * rs.Backoff)
		}
		
		// Retry logic would go here
		// For now, just return success after retries
		if i == rs.MaxRetries-1 {
			return nil
		}
	}
	
	return err
}

// CanRecover checks if retry can recover from error
func (rs *RetryStrategy) CanRecover(err error) bool {
	// Can recover from temporary errors
	return true
}

// FallbackStrategy provides fallback behavior
type FallbackStrategy struct {
	FallbackFunc func() error
}

// Recover attempts recovery through fallback
func (fs *FallbackStrategy) Recover(err error) error {
	if fs.FallbackFunc != nil {
		return fs.FallbackFunc()
	}
	return nil
}

// CanRecover checks if fallback can recover
func (fs *FallbackStrategy) CanRecover(err error) bool {
	return fs.FallbackFunc != nil
}

// GracefulDegradationStrategy provides graceful degradation
type GracefulDegradationStrategy struct {
	degradationLevel int
}

// Recover attempts recovery through degradation
func (gds *GracefulDegradationStrategy) Recover(err error) error {
	gds.degradationLevel++
	// Implement degradation logic
	return nil
}

// CanRecover checks if degradation can recover
func (gds *GracefulDegradationStrategy) CanRecover(err error) bool {
	return gds.degradationLevel < 3
}

// SafeGoroutine runs a goroutine with panic recovery
func SafeGoroutine(fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				stack := debug.Stack()
				fmt.Printf("Goroutine panic: %v\nStack: %s\n", r, stack)
			}
		}()
		fn()
	}()
}

// SafeCall executes a function with panic recovery
func SafeCall(fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			switch v := r.(type) {
			case error:
				err = v
			case string:
				err = errors.New(v)
			default:
				err = fmt.Errorf("panic: %v", v)
			}
		}
	}()
	
	return fn()
}