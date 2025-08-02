package errors

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ErrorHandler implements comprehensive error handling following Rob Pike's error handling principles
type ErrorHandler struct {
	logger *zap.Logger
	
	// Error tracking
	errorCount    atomic.Uint64
	criticalCount atomic.Uint64
	recoveryCount atomic.Uint64
	
	// Error registry
	registry      map[ErrorCode]*ErrorDefinition
	registryMu    sync.RWMutex
	
	// Recovery strategies
	strategies    map[ErrorCode]RecoveryStrategy
	strategiesMu  sync.RWMutex
	
	// Circuit breakers
	breakers      map[string]*CircuitBreaker
	breakersMu    sync.RWMutex
	
	// Error callbacks
	callbacks     []ErrorCallback
	callbacksMu   sync.RWMutex
	
	// Configuration
	config        *ErrorHandlerConfig
}

// ErrorCode represents a unique error code
type ErrorCode string

// Common error codes
const (
	ErrCodeNetwork      ErrorCode = "NETWORK_ERROR"
	ErrCodeTimeout      ErrorCode = "TIMEOUT_ERROR"
	ErrCodeValidation   ErrorCode = "VALIDATION_ERROR"
	ErrCodeAuth         ErrorCode = "AUTH_ERROR"
	ErrCodeResource     ErrorCode = "RESOURCE_ERROR"
	ErrCodeInternal     ErrorCode = "INTERNAL_ERROR"
	ErrCodeExternal     ErrorCode = "EXTERNAL_ERROR"
	ErrCodeCritical     ErrorCode = "CRITICAL_ERROR"
	ErrCodeRecoverable  ErrorCode = "RECOVERABLE_ERROR"
)

// ErrorSeverity represents error severity levels
type ErrorSeverity int

const (
	SeverityInfo ErrorSeverity = iota
	SeverityWarning
	SeverityError
	SeverityCritical
	SeverityFatal
)

// ErrorDefinition defines an error type
type ErrorDefinition struct {
	Code        ErrorCode
	Message     string
	Severity    ErrorSeverity
	Retryable   bool
	MaxRetries  int
	RetryDelay  time.Duration
	UserMessage string
}

// Error represents an enhanced error with context
type Error struct {
	Code       ErrorCode
	Message    string
	Severity   ErrorSeverity
	Cause      error
	Context    map[string]interface{}
	StackTrace string
	Timestamp  time.Time
	RequestID  string
}

// RecoveryStrategy defines how to recover from an error
type RecoveryStrategy interface {
	Recover(ctx context.Context, err *Error) error
	CanRecover(err *Error) bool
}

// ErrorCallback is called when an error occurs
type ErrorCallback func(err *Error)

// CircuitBreaker implements circuit breaker pattern
type CircuitBreaker struct {
	name          string
	maxFailures   int
	resetTimeout  time.Duration
	
	failures      atomic.Int32
	lastFailTime  atomic.Int64
	state         atomic.Uint32 // 0=closed, 1=open, 2=half-open
	
	mu            sync.Mutex
	successCount  int
	halfOpenTests int
}

// ErrorHandlerConfig contains error handler configuration
type ErrorHandlerConfig struct {
	EnableStackTrace   bool
	MaxErrorHistory    int
	CircuitBreakerMax  int
	RecoveryTimeout    time.Duration
	EnableMetrics      bool
}

// NewErrorHandler creates a new error handler
func NewErrorHandler(logger *zap.Logger, config *ErrorHandlerConfig) *ErrorHandler {
	if config == nil {
		config = DefaultErrorHandlerConfig()
	}
	
	eh := &ErrorHandler{
		logger:     logger,
		registry:   make(map[ErrorCode]*ErrorDefinition),
		strategies: make(map[ErrorCode]RecoveryStrategy),
		breakers:   make(map[string]*CircuitBreaker),
		config:     config,
	}
	
	// Register common errors
	eh.registerCommonErrors()
	
	// Initialize default recovery strategies
	eh.initializeRecoveryStrategies()
	
	return eh
}

// registerCommonErrors registers common error definitions
func (eh *ErrorHandler) registerCommonErrors() {
	commonErrors := []*ErrorDefinition{
		{
			Code:        ErrCodeNetwork,
			Message:     "Network operation failed",
			Severity:    SeverityError,
			Retryable:   true,
			MaxRetries:  3,
			RetryDelay:  time.Second,
			UserMessage: "Connection error. Please check your network.",
		},
		{
			Code:        ErrCodeTimeout,
			Message:     "Operation timed out",
			Severity:    SeverityWarning,
			Retryable:   true,
			MaxRetries:  2,
			RetryDelay:  2 * time.Second,
			UserMessage: "Request timed out. Please try again.",
		},
		{
			Code:        ErrCodeValidation,
			Message:     "Validation failed",
			Severity:    SeverityWarning,
			Retryable:   false,
			UserMessage: "Invalid input provided.",
		},
		{
			Code:        ErrCodeAuth,
			Message:     "Authentication failed",
			Severity:    SeverityError,
			Retryable:   false,
			UserMessage: "Authentication required.",
		},
		{
			Code:        ErrCodeResource,
			Message:     "Resource unavailable",
			Severity:    SeverityError,
			Retryable:   true,
			MaxRetries:  5,
			RetryDelay:  5 * time.Second,
			UserMessage: "Service temporarily unavailable.",
		},
		{
			Code:        ErrCodeCritical,
			Message:     "Critical system error",
			Severity:    SeverityCritical,
			Retryable:   false,
			UserMessage: "A critical error occurred. Please contact support.",
		},
	}
	
	for _, errDef := range commonErrors {
		eh.RegisterError(errDef)
	}
}

// initializeRecoveryStrategies sets up default recovery strategies
func (eh *ErrorHandler) initializeRecoveryStrategies() {
	// Network error recovery
	eh.RegisterRecoveryStrategy(ErrCodeNetwork, &RetryRecoveryStrategy{
		MaxRetries: 3,
		Delay:      time.Second,
		Backoff:    2.0,
	})
	
	// Timeout recovery
	eh.RegisterRecoveryStrategy(ErrCodeTimeout, &TimeoutRecoveryStrategy{
		ExtendTimeout: 2.0,
		MaxTimeout:    30 * time.Second,
	})
	
	// Resource recovery
	eh.RegisterRecoveryStrategy(ErrCodeResource, &ResourceRecoveryStrategy{
		FallbackEnabled: true,
		CacheEnabled:    true,
	})
}

// RegisterError registers an error definition
func (eh *ErrorHandler) RegisterError(def *ErrorDefinition) {
	eh.registryMu.Lock()
	defer eh.registryMu.Unlock()
	
	eh.registry[def.Code] = def
}

// RegisterRecoveryStrategy registers a recovery strategy
func (eh *ErrorHandler) RegisterRecoveryStrategy(code ErrorCode, strategy RecoveryStrategy) {
	eh.strategiesMu.Lock()
	defer eh.strategiesMu.Unlock()
	
	eh.strategies[code] = strategy
}

// RegisterCallback registers an error callback
func (eh *ErrorHandler) RegisterCallback(callback ErrorCallback) {
	eh.callbacksMu.Lock()
	defer eh.callbacksMu.Unlock()
	
	eh.callbacks = append(eh.callbacks, callback)
}

// Handle handles an error with recovery
func (eh *ErrorHandler) Handle(ctx context.Context, err error, code ErrorCode, context map[string]interface{}) error {
	// Create enhanced error
	enhancedErr := eh.createError(err, code, context)
	
	// Log error
	eh.logError(enhancedErr)
	
	// Update metrics
	eh.updateMetrics(enhancedErr)
	
	// Check circuit breaker
	if breaker := eh.getCircuitBreaker(string(code)); breaker != nil {
		if !breaker.Allow() {
			return fmt.Errorf("circuit breaker open for %s", code)
		}
		defer func() {
			if err == nil {
				breaker.Success()
			} else {
				breaker.Failure()
			}
		}()
	}
	
	// Execute callbacks
	eh.executeCallbacks(enhancedErr)
	
	// Attempt recovery
	if strategy := eh.getRecoveryStrategy(code); strategy != nil {
		if strategy.CanRecover(enhancedErr) {
			if recoveryErr := strategy.Recover(ctx, enhancedErr); recoveryErr == nil {
				eh.recoveryCount.Add(1)
				return nil
			}
		}
	}
	
	return enhancedErr
}

// createError creates an enhanced error
func (eh *ErrorHandler) createError(err error, code ErrorCode, ctx map[string]interface{}) *Error {
	def := eh.getErrorDefinition(code)
	
	enhancedErr := &Error{
		Code:      code,
		Message:   def.Message,
		Severity:  def.Severity,
		Cause:     err,
		Context:   ctx,
		Timestamp: time.Now(),
	}
	
	// Add stack trace if enabled
	if eh.config.EnableStackTrace {
		enhancedErr.StackTrace = eh.captureStackTrace()
	}
	
	// Add request ID if available
	if reqID, ok := ctx["request_id"].(string); ok {
		enhancedErr.RequestID = reqID
	}
	
	return enhancedErr
}

// captureStackTrace captures the current stack trace
func (eh *ErrorHandler) captureStackTrace() string {
	const depth = 32
	var pcs [depth]uintptr
	n := runtime.Callers(3, pcs[:])
	
	var builder strings.Builder
	frames := runtime.CallersFrames(pcs[:n])
	
	for {
		frame, more := frames.Next()
		builder.WriteString(fmt.Sprintf("%s\n\t%s:%d\n", frame.Function, frame.File, frame.Line))
		if !more {
			break
		}
	}
	
	return builder.String()
}

// logError logs an error based on severity
func (eh *ErrorHandler) logError(err *Error) {
	fields := []zap.Field{
		zap.String("code", string(err.Code)),
		zap.String("message", err.Message),
		zap.Time("timestamp", err.Timestamp),
		zap.Any("context", err.Context),
	}
	
	if err.RequestID != "" {
		fields = append(fields, zap.String("request_id", err.RequestID))
	}
	
	if err.Cause != nil {
		fields = append(fields, zap.Error(err.Cause))
	}
	
	if err.StackTrace != "" && eh.config.EnableStackTrace {
		fields = append(fields, zap.String("stack_trace", err.StackTrace))
	}
	
	switch err.Severity {
	case SeverityInfo:
		eh.logger.Info("Error occurred", fields...)
	case SeverityWarning:
		eh.logger.Warn("Warning error", fields...)
	case SeverityError:
		eh.logger.Error("Error occurred", fields...)
	case SeverityCritical:
		eh.logger.Error("Critical error", fields...)
	case SeverityFatal:
		eh.logger.Fatal("Fatal error", fields...)
	}
}

// updateMetrics updates error metrics
func (eh *ErrorHandler) updateMetrics(err *Error) {
	eh.errorCount.Add(1)
	
	if err.Severity >= SeverityCritical {
		eh.criticalCount.Add(1)
	}
}

// executeCallbacks executes registered callbacks
func (eh *ErrorHandler) executeCallbacks(err *Error) {
	eh.callbacksMu.RLock()
	callbacks := make([]ErrorCallback, len(eh.callbacks))
	copy(callbacks, eh.callbacks)
	eh.callbacksMu.RUnlock()
	
	for _, callback := range callbacks {
		go func(cb ErrorCallback) {
			defer func() {
				if r := recover(); r != nil {
					eh.logger.Error("Error callback panicked",
						zap.Any("panic", r),
						zap.String("error_code", string(err.Code)),
					)
				}
			}()
			cb(err)
		}(callback)
	}
}

// getErrorDefinition gets an error definition
func (eh *ErrorHandler) getErrorDefinition(code ErrorCode) *ErrorDefinition {
	eh.registryMu.RLock()
	defer eh.registryMu.RUnlock()
	
	if def, ok := eh.registry[code]; ok {
		return def
	}
	
	// Return default definition
	return &ErrorDefinition{
		Code:        code,
		Message:     "Unknown error",
		Severity:    SeverityError,
		UserMessage: "An error occurred",
	}
}

// getRecoveryStrategy gets a recovery strategy
func (eh *ErrorHandler) getRecoveryStrategy(code ErrorCode) RecoveryStrategy {
	eh.strategiesMu.RLock()
	defer eh.strategiesMu.RUnlock()
	
	return eh.strategies[code]
}

// getCircuitBreaker gets or creates a circuit breaker
func (eh *ErrorHandler) getCircuitBreaker(name string) *CircuitBreaker {
	eh.breakersMu.RLock()
	breaker, exists := eh.breakers[name]
	eh.breakersMu.RUnlock()
	
	if exists {
		return breaker
	}
	
	eh.breakersMu.Lock()
	defer eh.breakersMu.Unlock()
	
	// Double-check
	if breaker, exists = eh.breakers[name]; exists {
		return breaker
	}
	
	// Create new circuit breaker
	breaker = &CircuitBreaker{
		name:         name,
		maxFailures:  eh.config.CircuitBreakerMax,
		resetTimeout: 30 * time.Second,
	}
	
	eh.breakers[name] = breaker
	return breaker
}

// Wrap wraps a function with error handling
func (eh *ErrorHandler) Wrap(ctx context.Context, code ErrorCode, fn func() error) error {
	err := fn()
	if err != nil {
		return eh.Handle(ctx, err, code, nil)
	}
	return nil
}

// GetStats returns error handler statistics
func (eh *ErrorHandler) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_errors":    eh.errorCount.Load(),
		"critical_errors": eh.criticalCount.Load(),
		"recoveries":      eh.recoveryCount.Load(),
	}
	
	// Add circuit breaker stats
	eh.breakersMu.RLock()
	breakerStats := make(map[string]string)
	for name, breaker := range eh.breakers {
		state := "closed"
		switch breaker.state.Load() {
		case 1:
			state = "open"
		case 2:
			state = "half-open"
		}
		breakerStats[name] = state
	}
	eh.breakersMu.RUnlock()
	
	stats["circuit_breakers"] = breakerStats
	
	return stats
}

// Error implements the error interface
func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Cause)
	}
	return e.Message
}

// Allow checks if request should be allowed
func (cb *CircuitBreaker) Allow() bool {
	state := cb.state.Load()
	
	switch state {
	case 0: // Closed
		return true
	case 1: // Open
		// Check if we should transition to half-open
		lastFail := cb.lastFailTime.Load()
		if time.Since(time.Unix(0, lastFail)) > cb.resetTimeout {
			if cb.state.CompareAndSwap(1, 2) {
				cb.mu.Lock()
				cb.halfOpenTests = 0
				cb.successCount = 0
				cb.mu.Unlock()
			}
			return true
		}
		return false
	case 2: // Half-open
		cb.mu.Lock()
		defer cb.mu.Unlock()
		
		cb.halfOpenTests++
		return cb.halfOpenTests <= 3 // Allow limited tests
	}
	
	return false
}

// Success records a successful operation
func (cb *CircuitBreaker) Success() {
	state := cb.state.Load()
	
	if state == 2 { // Half-open
		cb.mu.Lock()
		cb.successCount++
		if cb.successCount >= 3 {
			// Transition to closed
			cb.state.Store(0)
			cb.failures.Store(0)
		}
		cb.mu.Unlock()
	} else if state == 0 { // Closed
		// Reset failure count on success
		cb.failures.Store(0)
	}
}

// Failure records a failed operation
func (cb *CircuitBreaker) Failure() {
	failures := cb.failures.Add(1)
	cb.lastFailTime.Store(time.Now().UnixNano())
	
	if failures >= int32(cb.maxFailures) {
		// Transition to open
		cb.state.Store(1)
	}
}

// DefaultErrorHandlerConfig returns default configuration
func DefaultErrorHandlerConfig() *ErrorHandlerConfig {
	return &ErrorHandlerConfig{
		EnableStackTrace:  true,
		MaxErrorHistory:   1000,
		CircuitBreakerMax: 5,
		RecoveryTimeout:   30 * time.Second,
		EnableMetrics:     true,
	}
}