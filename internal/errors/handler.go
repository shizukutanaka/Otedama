package errors

import (
	"context"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ErrorType represents the type of error
type ErrorType string

const (
	ErrorTypeValidation   ErrorType = "validation"
	ErrorTypeNetwork      ErrorType = "network"
	ErrorTypeDatabase     ErrorType = "database"
	ErrorTypeAuth         ErrorType = "authentication"
	ErrorTypeMining       ErrorType = "mining"
	ErrorTypeSystem       ErrorType = "system"
	ErrorTypeConfiguration ErrorType = "configuration"
	ErrorTypeSecurity     ErrorType = "security"
)

// ErrorSeverity represents the severity of an error
type ErrorSeverity string

const (
	SeverityLow      ErrorSeverity = "low"
	SeverityMedium   ErrorSeverity = "medium"
	SeverityHigh     ErrorSeverity = "high"
	SeverityCritical ErrorSeverity = "critical"
)

// AppError represents an application error with context
type AppError struct {
	Type       ErrorType     `json:"type"`
	Severity   ErrorSeverity `json:"severity"`
	Code       string        `json:"code"`
	Message    string        `json:"message"`
	Details    interface{}   `json:"details,omitempty"`
	StackTrace string        `json:"stack_trace,omitempty"`
	Timestamp  time.Time     `json:"timestamp"`
	Context    map[string]interface{} `json:"context,omitempty"`
	wrapped    error
}

// Error implements the error interface
func (e *AppError) Error() string {
	if e.wrapped != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.wrapped)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Unwrap returns the wrapped error
func (e *AppError) Unwrap() error {
	return e.wrapped
}

// NewError creates a new application error
func NewError(errType ErrorType, severity ErrorSeverity, code string, message string) *AppError {
	return &AppError{
		Type:      errType,
		Severity:  severity,
		Code:      code,
		Message:   message,
		Timestamp: time.Now(),
		Context:   make(map[string]interface{}),
	}
}

// WithError wraps an existing error
func (e *AppError) WithError(err error) *AppError {
	e.wrapped = err
	return e
}

// WithDetails adds additional details to the error
func (e *AppError) WithDetails(details interface{}) *AppError {
	e.Details = details
	return e
}

// WithContext adds context information to the error
func (e *AppError) WithContext(key string, value interface{}) *AppError {
	e.Context[key] = value
	return e
}

// WithStackTrace captures the current stack trace
func (e *AppError) WithStackTrace() *AppError {
	buf := make([]byte, 4096)
	n := runtime.Stack(buf, false)
	e.StackTrace = string(buf[:n])
	return e
}

// ErrorHandler manages error handling and recovery
type ErrorHandler struct {
	logger       *zap.Logger
	circuitBreaker *CircuitBreaker
	errorStats   *ErrorStats
	recoveryFuncs map[ErrorType]RecoveryFunc
	mu           sync.RWMutex
}

// RecoveryFunc defines a function that attempts to recover from an error
type RecoveryFunc func(ctx context.Context, err *AppError) error

// NewErrorHandler creates a new error handler
func NewErrorHandler(logger *zap.Logger) *ErrorHandler {
	return &ErrorHandler{
		logger:         logger,
		circuitBreaker: NewCircuitBreaker(5, 10*time.Second),
		errorStats:     NewErrorStats(),
		recoveryFuncs:  make(map[ErrorType]RecoveryFunc),
	}
}

// Handle processes an error with appropriate logging and recovery
func (h *ErrorHandler) Handle(ctx context.Context, err error) error {
	// Convert to AppError if needed
	appErr, ok := err.(*AppError)
	if !ok {
		appErr = NewError(ErrorTypeSystem, SeverityMedium, "UNKNOWN", err.Error()).
			WithError(err).
			WithStackTrace()
	}

	// Log the error
	h.logError(appErr)

	// Update statistics
	h.errorStats.Record(appErr)

	// Check circuit breaker
	if h.circuitBreaker.IsOpen() {
		return fmt.Errorf("circuit breaker open: %w", err)
	}

	// Attempt recovery
	if recoveryFunc := h.getRecoveryFunc(appErr.Type); recoveryFunc != nil {
		if recoveryErr := recoveryFunc(ctx, appErr); recoveryErr != nil {
			h.circuitBreaker.RecordFailure()
			return fmt.Errorf("recovery failed: %w", recoveryErr)
		}
		h.circuitBreaker.RecordSuccess()
		return nil
	}

	// No recovery available
	h.circuitBreaker.RecordFailure()
	return err
}

// RegisterRecovery registers a recovery function for an error type
func (h *ErrorHandler) RegisterRecovery(errType ErrorType, fn RecoveryFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.recoveryFuncs[errType] = fn
}

// getRecoveryFunc returns the recovery function for an error type
func (h *ErrorHandler) getRecoveryFunc(errType ErrorType) RecoveryFunc {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.recoveryFuncs[errType]
}

// logError logs an error with appropriate level
func (h *ErrorHandler) logError(err *AppError) {
	fields := []zap.Field{
		zap.String("type", string(err.Type)),
		zap.String("severity", string(err.Severity)),
		zap.String("code", err.Code),
		zap.Time("timestamp", err.Timestamp),
		zap.Any("context", err.Context),
	}

	if err.Details != nil {
		fields = append(fields, zap.Any("details", err.Details))
	}

	if err.StackTrace != "" && err.Severity == SeverityCritical {
		fields = append(fields, zap.String("stack_trace", err.StackTrace))
	}

	switch err.Severity {
	case SeverityCritical:
		h.logger.Error(err.Message, fields...)
	case SeverityHigh:
		h.logger.Warn(err.Message, fields...)
	case SeverityMedium:
		h.logger.Info(err.Message, fields...)
	case SeverityLow:
		h.logger.Debug(err.Message, fields...)
	}
}

// CircuitBreaker implements the circuit breaker pattern
type CircuitBreaker struct {
	maxFailures   int
	timeout       time.Duration
	failures      int
	lastFailure   time.Time
	state         CircuitState
	mu            sync.Mutex
}

// CircuitState represents the state of the circuit breaker
type CircuitState int

const (
	CircuitClosed CircuitState = iota
	CircuitOpen
	CircuitHalfOpen
)

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker(maxFailures int, timeout time.Duration) *CircuitBreaker {
	return &CircuitBreaker{
		maxFailures: maxFailures,
		timeout:     timeout,
		state:       CircuitClosed,
	}
}

// IsOpen checks if the circuit is open
func (cb *CircuitBreaker) IsOpen() bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == CircuitOpen {
		// Check if we should transition to half-open
		if time.Since(cb.lastFailure) > cb.timeout {
			cb.state = CircuitHalfOpen
			cb.failures = cb.maxFailures / 2
		}
	}

	return cb.state == CircuitOpen
}

// RecordSuccess records a successful operation
func (cb *CircuitBreaker) RecordSuccess() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	if cb.state == CircuitHalfOpen {
		cb.failures--
		if cb.failures <= 0 {
			cb.state = CircuitClosed
			cb.failures = 0
		}
	}
}

// RecordFailure records a failed operation
func (cb *CircuitBreaker) RecordFailure() {
	cb.mu.Lock()
	defer cb.mu.Unlock()

	cb.failures++
	cb.lastFailure = time.Now()

	if cb.failures >= cb.maxFailures {
		cb.state = CircuitOpen
	}
}

// ErrorStats tracks error statistics
type ErrorStats struct {
	counts   map[string]int64
	mu       sync.RWMutex
}

// NewErrorStats creates new error statistics tracker
func NewErrorStats() *ErrorStats {
	return &ErrorStats{
		counts: make(map[string]int64),
	}
}

// Record records an error occurrence
func (es *ErrorStats) Record(err *AppError) {
	es.mu.Lock()
	defer es.mu.Unlock()

	key := fmt.Sprintf("%s:%s:%s", err.Type, err.Severity, err.Code)
	es.counts[key]++
}

// GetStats returns current error statistics
func (es *ErrorStats) GetStats() map[string]int64 {
	es.mu.RLock()
	defer es.mu.RUnlock()

	stats := make(map[string]int64)
	for k, v := range es.counts {
		stats[k] = v
	}
	return stats
}

// Common error definitions
var (
	ErrInvalidInput = NewError(
		ErrorTypeValidation,
		SeverityLow,
		"INVALID_INPUT",
		"Invalid input provided",
	)

	ErrUnauthorized = NewError(
		ErrorTypeAuth,
		SeverityMedium,
		"UNAUTHORIZED",
		"Authentication required",
	)

	ErrForbidden = NewError(
		ErrorTypeAuth,
		SeverityMedium,
		"FORBIDDEN",
		"Access denied",
	)

	ErrNotFound = NewError(
		ErrorTypeSystem,
		SeverityLow,
		"NOT_FOUND",
		"Resource not found",
	)

	ErrTimeout = NewError(
		ErrorTypeNetwork,
		SeverityMedium,
		"TIMEOUT",
		"Operation timed out",
	)

	ErrInternal = NewError(
		ErrorTypeSystem,
		SeverityHigh,
		"INTERNAL_ERROR",
		"Internal server error",
	)

	ErrDatabaseConnection = NewError(
		ErrorTypeDatabase,
		SeverityHigh,
		"DB_CONNECTION",
		"Database connection failed",
	)

	ErrSecurityViolation = NewError(
		ErrorTypeSecurity,
		SeverityCritical,
		"SECURITY_VIOLATION",
		"Security violation detected",
	)
)

// SafeRecover provides safe panic recovery with logging
func SafeRecover(logger *zap.Logger, operation string) {
	if r := recover(); r != nil {
		// Get stack trace
		buf := make([]byte, 4096)
		n := runtime.Stack(buf, false)
		stackTrace := string(buf[:n])

		// Log the panic
		logger.Error("Panic recovered",
			zap.String("operation", operation),
			zap.Any("panic", r),
			zap.String("stack_trace", stackTrace),
		)

		// Clean up the stack trace for readability
		lines := strings.Split(stackTrace, "\n")
		var relevantLines []string
		for i, line := range lines {
			if strings.Contains(line, "runtime.panic") {
				// Include the next few lines after panic
				for j := i; j < len(lines) && j < i+10; j++ {
					relevantLines = append(relevantLines, lines[j])
				}
				break
			}
		}

		// Create a panic error
		panicErr := NewError(
			ErrorTypeSystem,
			SeverityCritical,
			"PANIC",
			fmt.Sprintf("Panic in %s: %v", operation, r),
		).WithDetails(map[string]interface{}{
			"panic_value": r,
			"stack_trace": strings.Join(relevantLines, "\n"),
		})

		// Log to error tracking service if available
		logger.Error("Critical panic occurred", 
			zap.String("error_code", panicErr.Code),
			zap.String("error_message", panicErr.Message),
		)
	}
}