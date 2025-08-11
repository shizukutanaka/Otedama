package common

import (
	"context"
	"fmt"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// Recover recovers from a panic and returns an error
func Recover() error {
	if r := recover(); r != nil {
		// Get stack trace
		stack := debug.Stack()
		
		// Convert panic to error
		var err error
		switch v := r.(type) {
		case error:
			err = v
		case string:
			err = fmt.Errorf(v)
		default:
			err = fmt.Errorf("panic: %v", v)
		}
		
		// Include stack trace in error
		return fmt.Errorf("%w\nStack trace:\n%s", err, stack)
	}
	return nil
}

// SafeGo runs a function in a goroutine with panic recovery
func SafeGo(fn func()) {
	go func() {
		defer func() {
			if err := Recover(); err != nil {
				// Log the error (without importing logger to avoid cycles)
				fmt.Printf("Goroutine panic recovered: %v\n", err)
			}
		}()
		fn()
	}()
}

// SafeFunc wraps a function with panic recovery
func SafeFunc(fn func() error) error {
	var err error
	func() {
		defer func() {
			if panicErr := Recover(); panicErr != nil {
				err = panicErr
			}
		}()
		err = fn()
	}()
	return err
}

// RecoveryConfig defines recovery behavior configuration
type RecoveryConfig struct {
	MaxRetries       int
	RetryDelay       time.Duration
	BackoffMultiplier float64
	MaxBackoff       time.Duration
	EnableCircuitBreaker bool
	CircuitBreakerThreshold int
	CircuitBreakerTimeout time.Duration
}

// DefaultRecoveryConfig returns default recovery configuration
func DefaultRecoveryConfig() *RecoveryConfig {
	return &RecoveryConfig{
		MaxRetries:       3,
		RetryDelay:       time.Second,
		BackoffMultiplier: 2.0,
		MaxBackoff:       30 * time.Second,
		EnableCircuitBreaker: true,
		CircuitBreakerThreshold: 5,
		CircuitBreakerTimeout: 60 * time.Second,
	}
}

// RecoveryManagerImpl provides centralized recovery management
type RecoveryManagerImpl struct {
	config   *RecoveryConfig
	stats    RecoveryStats
	breakers sync.Map // map[string]*CircuitBreaker
	mu       sync.RWMutex
}

// RecoveryStats tracks recovery statistics
type RecoveryStats struct {
	TotalRecoveries  atomic.Uint64
	SuccessfulRecoveries atomic.Uint64
	FailedRecoveries atomic.Uint64
	PanicsRecovered  atomic.Uint64
	LastRecoveryTime atomic.Int64
}

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
	threshold    int
	timeout      time.Duration
	failureCount atomic.Int32
	lastFailTime atomic.Int64
	state        atomic.Int32 // 0=closed, 1=open, 2=half-open
	successCount atomic.Int32
	mu           sync.RWMutex
}

// CircuitBreakerState constants
const (
	CircuitClosed int32 = iota
	CircuitOpen
	CircuitHalfOpen
)

// NewRecoveryManager creates a new recovery manager
func NewRecoveryManager(config *RecoveryConfig) *RecoveryManagerImpl {
	if config == nil {
		config = DefaultRecoveryConfig()
	}
	return &RecoveryManagerImpl{
		config: config,
	}
}

// ExecuteWithRecovery executes a function with recovery and retry logic
func (rm *RecoveryManagerImpl) ExecuteWithRecovery(ctx context.Context, name string, fn func() error) error {
	// Get or create circuit breaker for this operation
	var breaker *CircuitBreaker
	if rm.config.EnableCircuitBreaker {
		val, _ := rm.breakers.LoadOrStore(name, &CircuitBreaker{
			threshold: rm.config.CircuitBreakerThreshold,
			timeout:   rm.config.CircuitBreakerTimeout,
		})
		breaker = val.(*CircuitBreaker)
		
		// Check circuit breaker
		if !breaker.Allow() {
			rm.stats.FailedRecoveries.Add(1)
			return fmt.Errorf("circuit breaker open for %s", name)
		}
	}
	
	var lastErr error
	retryDelay := rm.config.RetryDelay
	
	for attempt := 0; attempt <= rm.config.MaxRetries; attempt++ {
		if attempt > 0 {
			// Apply backoff
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(retryDelay):
			}
			
			// Calculate next delay
			retryDelay = time.Duration(float64(retryDelay) * rm.config.BackoffMultiplier)
			if retryDelay > rm.config.MaxBackoff {
				retryDelay = rm.config.MaxBackoff
			}
		}
		
		// Execute with panic recovery
		err := SafeFunc(fn)
		
		if err == nil {
			// Success
			rm.stats.SuccessfulRecoveries.Add(1)
			rm.stats.LastRecoveryTime.Store(time.Now().Unix())
			
			if breaker != nil {
				breaker.RecordSuccess()
			}
			return nil
		}
		
		lastErr = err
		
		// Check if error is retryable
		if !IsRetryable(err) {
			break
		}
	}
	
	// All retries failed
	rm.stats.FailedRecoveries.Add(1)
	
	if breaker != nil {
		breaker.RecordFailure()
	}
	
	return fmt.Errorf("failed after %d attempts: %w", rm.config.MaxRetries+1, lastErr)
}

// GetStats returns recovery statistics
func (rm *RecoveryManagerImpl) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"total_recoveries":      rm.stats.TotalRecoveries.Load(),
		"successful_recoveries": rm.stats.SuccessfulRecoveries.Load(),
		"failed_recoveries":     rm.stats.FailedRecoveries.Load(),
		"panics_recovered":      rm.stats.PanicsRecovered.Load(),
		"last_recovery_time":    time.Unix(rm.stats.LastRecoveryTime.Load(), 0),
	}
}

// CircuitBreaker methods

// Allow checks if the circuit breaker allows the operation
func (cb *CircuitBreaker) Allow() bool {
	state := cb.state.Load()
	
	switch state {
	case CircuitClosed:
		return true
		
	case CircuitOpen:
		// Check if enough time has passed to try half-open
		lastFail := cb.lastFailTime.Load()
		if time.Since(time.Unix(0, lastFail)) > cb.timeout {
			cb.state.CompareAndSwap(CircuitOpen, CircuitHalfOpen)
			cb.successCount.Store(0)
			return true
		}
		return false
		
	case CircuitHalfOpen:
		return true
		
	default:
		return false
	}
}

// RecordSuccess records a successful operation
func (cb *CircuitBreaker) RecordSuccess() {
	state := cb.state.Load()
	
	if state == CircuitHalfOpen {
		success := cb.successCount.Add(1)
		if success >= 3 { // Require 3 successes to close
			cb.state.Store(CircuitClosed)
			cb.failureCount.Store(0)
		}
	} else if state == CircuitClosed {
		cb.failureCount.Store(0)
	}
}

// RecordFailure records a failed operation
func (cb *CircuitBreaker) RecordFailure() {
	failures := cb.failureCount.Add(1)
	cb.lastFailTime.Store(time.Now().UnixNano())
	
	if failures >= int32(cb.threshold) {
		cb.state.Store(CircuitOpen)
	}
}

// SafeGoWithRecover runs a goroutine with recovery and optional callback
func SafeGoWithRecover(fn func(), onPanic func(interface{})) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				if onPanic != nil {
					onPanic(r)
				} else {
					// Default handling
					fmt.Printf("Goroutine panic recovered: %v\nStack: %s\n", r, debug.Stack())
				}
			}
		}()
		fn()
	}()
}

// BatchProcessor processes items with individual error recovery
type BatchProcessor struct {
	recoveryManager *RecoveryManagerImpl
	workers         int
	mu              sync.RWMutex
}

// NewBatchProcessor creates a new batch processor
func NewBatchProcessor(workers int) *BatchProcessor {
	return &BatchProcessor{
		recoveryManager: NewRecoveryManager(DefaultRecoveryConfig()),
		workers:         workers,
	}
}

// ProcessBatch processes a batch of items with recovery
func (bp *BatchProcessor) ProcessBatch(ctx context.Context, items []interface{}, processor func(interface{}) error) []error {
	if len(items) == 0 {
		return nil
	}
	
	errors := make([]error, 0)
	errorsMu := sync.Mutex{}
	
	// Create worker pool
	workCh := make(chan interface{}, len(items))
	for _, item := range items {
		workCh <- item
	}
	close(workCh)
	
	// Start workers
	var wg sync.WaitGroup
	for i := 0; i < bp.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			
			for item := range workCh {
				err := bp.recoveryManager.ExecuteWithRecovery(ctx, "batch-item", func() error {
					return processor(item)
				})
				
				if err != nil {
					errorsMu.Lock()
					errors = append(errors, err)
					errorsMu.Unlock()
				}
			}
		}()
	}
	
	wg.Wait()
	return errors
}