package errors

import (
	"context"
	"fmt"
	"runtime"
	"runtime/debug"
	"time"

	"go.uber.org/zap"
)

// RecoveryHandler handles panic recovery with structured logging
type RecoveryHandler struct {
	logger      *zap.Logger
	onPanic     func(interface{}, string) // Custom panic handler
	reportPanic bool                      // Whether to report panics to external service
}

// NewRecoveryHandler creates a new recovery handler
func NewRecoveryHandler(logger *zap.Logger) *RecoveryHandler {
	return &RecoveryHandler{
		logger:      logger,
		reportPanic: true,
	}
}

// WithPanicHandler sets a custom panic handler
func (rh *RecoveryHandler) WithPanicHandler(handler func(interface{}, string)) *RecoveryHandler {
	rh.onPanic = handler
	return rh
}

// WithReporting enables/disables panic reporting
func (rh *RecoveryHandler) WithReporting(enabled bool) *RecoveryHandler {
	rh.reportPanic = enabled
	return rh
}

// Recover recovers from panics in goroutines
func (rh *RecoveryHandler) Recover() {
	if r := recover(); r != nil {
		stack := string(debug.Stack())
		
		// Create structured error
		panicErr := &OtedamaError{
			Code:      ErrCodeSystem,
			Message:   fmt.Sprintf("panic recovered: %v", r),
			Severity:  SeverityCritical,
			Timestamp: time.Now(),
			Stack:     stack,
			Context: map[string]interface{}{
				"panic_value": r,
				"goroutines":  runtime.NumGoroutine(),
			},
		}
		
		// Log the panic
		rh.logger.Error("Panic recovered",
			zap.String("code", string(panicErr.Code)),
			zap.String("message", panicErr.Message),
			zap.Any("panic_value", r),
			zap.String("stack", stack),
			zap.Int("goroutines", runtime.NumGoroutine()),
		)
		
		// Call custom panic handler if set
		if rh.onPanic != nil {
			rh.onPanic(r, stack)
		}
		
		// Report panic if enabled
		if rh.reportPanic {
			rh.reportPanicToService(panicErr)
		}
	}
}

// RecoverWithError recovers from panics and returns an error
func (rh *RecoveryHandler) RecoverWithError() error {
	if r := recover(); r != nil {
		stack := string(debug.Stack())
		
		panicErr := &OtedamaError{
			Code:      ErrCodeSystem,
			Message:   fmt.Sprintf("panic recovered: %v", r),
			Severity:  SeverityCritical,
			Timestamp: time.Now(),
			Stack:     stack,
			Context: map[string]interface{}{
				"panic_value": r,
				"goroutines":  runtime.NumGoroutine(),
			},
		}
		
		rh.logger.Error("Panic recovered with error return",
			zap.String("code", string(panicErr.Code)),
			zap.String("message", panicErr.Message),
			zap.Any("panic_value", r),
			zap.String("stack", stack),
		)
		
		if rh.onPanic != nil {
			rh.onPanic(r, stack)
		}
		
		if rh.reportPanic {
			rh.reportPanicToService(panicErr)
		}
		
		return panicErr
	}
	return nil
}

// SafeGo runs a function in a goroutine with panic recovery
func (rh *RecoveryHandler) SafeGo(fn func()) {
	go func() {
		defer rh.Recover()
		fn()
	}()
}

// SafeGoWithContext runs a function in a goroutine with context and panic recovery
func (rh *RecoveryHandler) SafeGoWithContext(ctx context.Context, fn func(context.Context)) {
	go func() {
		defer rh.Recover()
		fn(ctx)
	}()
}

// SafeCall calls a function with panic recovery, returning any error
func (rh *RecoveryHandler) SafeCall(fn func() error) (err error) {
	defer func() {
		if recoveryErr := rh.RecoverWithError(); recoveryErr != nil {
			err = recoveryErr
		}
	}()
	
	return fn()
}

// SafeCallWithReturn calls a function with panic recovery, returning value and error
func SafeCallWithReturn[T any](rh *RecoveryHandler, fn func() (T, error)) (result T, err error) {
	defer func() {
		if recoveryErr := rh.RecoverWithError(); recoveryErr != nil {
			var zero T
			result = zero
			err = recoveryErr
		}
	}()
	
	return fn()
}

// reportPanicToService reports panic to external monitoring service
func (rh *RecoveryHandler) reportPanicToService(panicErr *OtedamaError) {
	// This could integrate with services like Sentry, Rollbar, etc.
	// For now, we'll just log it as a structured event
	rh.logger.Error("Panic reported to monitoring service",
		zap.String("error_code", string(panicErr.Code)),
		zap.String("severity", string(panicErr.Severity)),
		zap.Time("timestamp", panicErr.Timestamp),
		zap.Any("context", panicErr.Context),
	)
}

// RetryConfig defines retry behavior
type RetryConfig struct {
	MaxRetries    int
	InitialDelay  time.Duration
	MaxDelay      time.Duration
	BackoffFactor float64
	RetryableErrors []ErrorCode
}

// DefaultRetryConfig returns sensible retry defaults
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxRetries:    3,
		InitialDelay:  100 * time.Millisecond,
		MaxDelay:      5 * time.Second,
		BackoffFactor: 2.0,
		RetryableErrors: []ErrorCode{
			ErrCodeNetwork,
			ErrCodeTimeout,
			ErrCodeDatabase,
		},
	}
}

// RetryableFunc represents a function that can be retried
type RetryableFunc func() error

// Retry executes a function with retry logic
func Retry(ctx context.Context, config RetryConfig, fn RetryableFunc) error {
	var lastErr error
	delay := config.InitialDelay
	
	for attempt := 0; attempt <= config.MaxRetries; attempt++ {
		if attempt > 0 {
			// Wait before retry
			select {
			case <-ctx.Done():
				return Wrap(ctx.Err(), ErrCodeTimeout, "retry cancelled by context", SeverityError)
			case <-time.After(delay):
			}
			
			// Exponential backoff
			delay = time.Duration(float64(delay) * config.BackoffFactor)
			if delay > config.MaxDelay {
				delay = config.MaxDelay
			}
		}
		
		lastErr = fn()
		if lastErr == nil {
			return nil // Success
		}
		
		// Check if error is retryable
		if !isRetryableError(lastErr, config.RetryableErrors) {
			return lastErr // Don't retry non-retryable errors
		}
	}
	
	return Wrapf(lastErr, ErrCodeSystem, SeverityError, 
		"operation failed after %d retries", config.MaxRetries)
}

// isRetryableError checks if an error should be retried
func isRetryableError(err error, retryableErrors []ErrorCode) bool {
	if otedamaErr, ok := err.(*OtedamaError); ok {
		for _, code := range retryableErrors {
			if otedamaErr.Code == code {
				return true
			}
		}
	}
	return false
}

// CircuitBreakerState represents circuit breaker states
type CircuitBreakerState int

const (
	StateClosed CircuitBreakerState = iota
	StateOpen
	StateHalfOpen
)

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
	maxFailures    int
	resetTimeout   time.Duration
	state         CircuitBreakerState
	failures      int
	lastFailTime  time.Time
	onStateChange func(CircuitBreakerState)
}

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker(maxFailures int, resetTimeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		maxFailures:  maxFailures,
		resetTimeout: resetTimeout,
		state:       StateClosed,
	}
}

// Execute runs a function through the circuit breaker
func (cb *CircuitBreaker) Execute(fn func() error) error {
	switch cb.state {
	case StateOpen:
		if time.Since(cb.lastFailTime) > cb.resetTimeout {
			cb.setState(StateHalfOpen)
		} else {
			return New(ErrCodeSystem, "circuit breaker is open", SeverityWarning)
		}
	}
	
	err := fn()
	
	if err != nil {
		cb.onFailure()
		return err
	}
	
	cb.onSuccess()
	return nil
}

// onSuccess handles successful execution
func (cb *CircuitBreaker) onSuccess() {
	cb.failures = 0
	if cb.state == StateHalfOpen {
		cb.setState(StateClosed)
	}
}

// onFailure handles failed execution
func (cb *CircuitBreaker) onFailure() {
	cb.failures++
	cb.lastFailTime = time.Now()
	
	if cb.failures >= cb.maxFailures && cb.state == StateClosed {
		cb.setState(StateOpen)
	}
}

// setState changes circuit breaker state
func (cb *CircuitBreaker) setState(state CircuitBreakerState) {
	cb.state = state
	if cb.onStateChange != nil {
		cb.onStateChange(state)
	}
}

// GetState returns current circuit breaker state
func (cb *CircuitBreaker) GetState() CircuitBreakerState {
	return cb.state
}

// OnStateChange sets a callback for state changes
func (cb *CircuitBreaker) OnStateChange(fn func(CircuitBreakerState)) {
	cb.onStateChange = fn
}