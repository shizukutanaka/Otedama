package core

import (
	"errors"
	"fmt"
	"runtime"
	"time"
)

// Error severity levels
type ErrorSeverity int

const (
	SeverityLow ErrorSeverity = iota
	SeverityMedium
	SeverityHigh
	SeverityCritical
	SeverityFatal
)

// Error categories for better organization
type ErrorCategory string

const (
	CategoryMining      ErrorCategory = "mining"
	CategoryNetwork     ErrorCategory = "network"
	CategoryStorage     ErrorCategory = "storage"
	CategorySecurity    ErrorCategory = "security"
	CategoryHardware    ErrorCategory = "hardware"
	CategoryAPI         ErrorCategory = "api"
	CategoryP2P         ErrorCategory = "p2p"
	CategoryStratum     ErrorCategory = "stratum"
	CategorySystem      ErrorCategory = "system"
	CategoryValidation  ErrorCategory = "validation"
)

// EnterpriseError provides comprehensive error information
type EnterpriseError struct {
	Code       string
	Message    string
	Category   ErrorCategory
	Severity   ErrorSeverity
	Timestamp  time.Time
	Component  string
	Operation  string
	Cause      error
	Context    map[string]interface{}
	StackTrace string
	Retryable  bool
	RetryAfter time.Duration
}

// Error implements the error interface
func (e *EnterpriseError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("[%s] %s: %s (caused by: %v)", e.Code, e.Component, e.Message, e.Cause)
	}
	return fmt.Sprintf("[%s] %s: %s", e.Code, e.Component, e.Message)
}

// Unwrap returns the underlying error
func (e *EnterpriseError) Unwrap() error {
	return e.Cause
}

// Is implements errors.Is support
func (e *EnterpriseError) Is(target error) bool {
	t, ok := target.(*EnterpriseError)
	if !ok {
		return false
	}
	return e.Code == t.Code
}

// NewEnterpriseError creates a new enterprise error
func NewEnterpriseError(code string, message string, opts ...ErrorOption) *EnterpriseError {
	err := &EnterpriseError{
		Code:      code,
		Message:   message,
		Timestamp: time.Now(),
		Context:   make(map[string]interface{}),
		Retryable: false,
	}
	
	// Capture stack trace
	buf := make([]byte, 2048)
	n := runtime.Stack(buf, false)
	err.StackTrace = string(buf[:n])
	
	// Apply options
	for _, opt := range opts {
		opt(err)
	}
	
	return err
}

// ErrorOption configures an EnterpriseError
type ErrorOption func(*EnterpriseError)

// WithCategory sets the error category
func WithCategory(category ErrorCategory) ErrorOption {
	return func(e *EnterpriseError) {
		e.Category = category
	}
}

// WithSeverity sets the error severity
func WithSeverity(severity ErrorSeverity) ErrorOption {
	return func(e *EnterpriseError) {
		e.Severity = severity
	}
}

// WithComponent sets the component that generated the error
func WithComponent(component string) ErrorOption {
	return func(e *EnterpriseError) {
		e.Component = component
	}
}

// WithOperation sets the operation that failed
func WithOperation(operation string) ErrorOption {
	return func(e *EnterpriseError) {
		e.Operation = operation
	}
}

// WithCause wraps an underlying error
func WithCause(cause error) ErrorOption {
	return func(e *EnterpriseError) {
		e.Cause = cause
	}
}

// WithContext adds contextual information
func WithContext(key string, value interface{}) ErrorOption {
	return func(e *EnterpriseError) {
		e.Context[key] = value
	}
}

// WithRetryable marks the error as retryable
func WithRetryable(retryAfter time.Duration) ErrorOption {
	return func(e *EnterpriseError) {
		e.Retryable = true
		e.RetryAfter = retryAfter
	}
}

// Common error codes
const (
	// Mining errors
	ErrCodeMiningEngineFailure    = "MINING_001"
	ErrCodeInvalidShare          = "MINING_002"
	ErrCodeJobTimeout            = "MINING_003"
	ErrCodeAlgorithmNotSupported = "MINING_004"
	ErrCodeHardwareFailure       = "MINING_005"
	
	// Network errors
	ErrCodeConnectionFailed     = "NET_001"
	ErrCodeConnectionTimeout    = "NET_002"
	ErrCodePoolUnreachable      = "NET_003"
	ErrCodeAuthenticationFailed = "NET_004"
	ErrCodeRateLimitExceeded    = "NET_005"
	
	// Storage errors
	ErrCodeDatabaseConnection = "STORAGE_001"
	ErrCodeDatabaseQuery      = "STORAGE_002"
	ErrCodeCacheFailure       = "STORAGE_003"
	ErrCodeDiskFull           = "STORAGE_004"
	
	// Security errors
	ErrCodeUnauthorized       = "SEC_001"
	ErrCodeForbidden          = "SEC_002"
	ErrCodeInvalidToken       = "SEC_003"
	ErrCodeSuspiciousActivity = "SEC_004"
	
	// System errors
	ErrCodeResourceExhausted = "SYS_001"
	ErrCodeConfigInvalid     = "SYS_002"
	ErrCodeComponentFailure  = "SYS_003"
	ErrCodeShutdownInProgress = "SYS_004"
)

// Predefined errors for common scenarios
var (
	// Mining errors
	ErrMiningEngineNotRunning = NewEnterpriseError(
		ErrCodeMiningEngineFailure,
		"mining engine is not running",
		WithCategory(CategoryMining),
		WithSeverity(SeverityHigh),
		WithRetryable(5*time.Second),
	)
	
	ErrInvalidShare = NewEnterpriseError(
		ErrCodeInvalidShare,
		"invalid share submitted",
		WithCategory(CategoryMining),
		WithSeverity(SeverityLow),
	)
	
	ErrJobTimeout = NewEnterpriseError(
		ErrCodeJobTimeout,
		"mining job timed out",
		WithCategory(CategoryMining),
		WithSeverity(SeverityMedium),
		WithRetryable(time.Second),
	)
	
	// Network errors
	ErrPoolUnreachable = NewEnterpriseError(
		ErrCodePoolUnreachable,
		"mining pool is unreachable",
		WithCategory(CategoryNetwork),
		WithSeverity(SeverityHigh),
		WithRetryable(10*time.Second),
	)
	
	ErrAuthenticationFailed = NewEnterpriseError(
		ErrCodeAuthenticationFailed,
		"authentication with pool failed",
		WithCategory(CategoryNetwork),
		WithSeverity(SeverityHigh),
	)
	
	// System errors
	ErrResourceExhausted = NewEnterpriseError(
		ErrCodeResourceExhausted,
		"system resources exhausted",
		WithCategory(CategorySystem),
		WithSeverity(SeverityCritical),
		WithRetryable(30*time.Second),
	)
	
	ErrComponentFailure = NewEnterpriseError(
		ErrCodeComponentFailure,
		"critical component failure",
		WithCategory(CategorySystem),
		WithSeverity(SeverityCritical),
	)
)

// ErrorHandler provides centralized error handling
type ErrorHandler struct {
	handlers   map[string]func(*EnterpriseError) error
	fallback   func(*EnterpriseError) error
	middleware []ErrorMiddleware
}

// ErrorMiddleware processes errors before handling
type ErrorMiddleware func(*EnterpriseError) *EnterpriseError

// NewErrorHandler creates a new error handler
func NewErrorHandler() *ErrorHandler {
	return &ErrorHandler{
		handlers:   make(map[string]func(*EnterpriseError) error),
		middleware: make([]ErrorMiddleware, 0),
	}
}

// RegisterHandler registers an error handler for a specific error code
func (h *ErrorHandler) RegisterHandler(code string, handler func(*EnterpriseError) error) {
	h.handlers[code] = handler
}

// SetFallbackHandler sets the fallback error handler
func (h *ErrorHandler) SetFallbackHandler(handler func(*EnterpriseError) error) {
	h.fallback = handler
}

// AddMiddleware adds error processing middleware
func (h *ErrorHandler) AddMiddleware(middleware ErrorMiddleware) {
	h.middleware = append(h.middleware, middleware)
}

// Handle processes an error through the handler chain
func (h *ErrorHandler) Handle(err error) error {
	// Convert to EnterpriseError if needed
	enterpriseErr, ok := err.(*EnterpriseError)
	if !ok {
		enterpriseErr = NewEnterpriseError(
			"UNKNOWN",
			err.Error(),
			WithCategory(CategorySystem),
			WithSeverity(SeverityMedium),
			WithCause(err),
		)
	}
	
	// Apply middleware
	for _, mw := range h.middleware {
		enterpriseErr = mw(enterpriseErr)
	}
	
	// Find and execute handler
	if handler, ok := h.handlers[enterpriseErr.Code]; ok {
		return handler(enterpriseErr)
	}
	
	// Use fallback handler
	if h.fallback != nil {
		return h.fallback(enterpriseErr)
	}
	
	return enterpriseErr
}

// ErrorMetrics tracks error statistics
type ErrorMetrics struct {
	errorCounts   map[string]uint64
	lastErrors    map[string]time.Time
	errorsByType  map[ErrorCategory]uint64
}

// NewErrorMetrics creates a new error metrics tracker
func NewErrorMetrics() *ErrorMetrics {
	return &ErrorMetrics{
		errorCounts:  make(map[string]uint64),
		lastErrors:   make(map[string]time.Time),
		errorsByType: make(map[ErrorCategory]uint64),
	}
}

// RecordError records an error occurrence
func (m *ErrorMetrics) RecordError(err *EnterpriseError) {
	m.errorCounts[err.Code]++
	m.lastErrors[err.Code] = err.Timestamp
	m.errorsByType[err.Category]++
}

// GetMetrics returns current error metrics
func (m *ErrorMetrics) GetMetrics() map[string]interface{} {
	return map[string]interface{}{
		"error_counts":    m.errorCounts,
		"last_errors":     m.lastErrors,
		"errors_by_type":  m.errorsByType,
	}
}

// Helper functions

// IsRetryable checks if an error is retryable
func IsRetryable(err error) (bool, time.Duration) {
	var enterpriseErr *EnterpriseError
	if errors.As(err, &enterpriseErr) {
		return enterpriseErr.Retryable, enterpriseErr.RetryAfter
	}
	return false, 0
}

// GetErrorSeverity returns the severity of an error
func GetErrorSeverity(err error) ErrorSeverity {
	var enterpriseErr *EnterpriseError
	if errors.As(err, &enterpriseErr) {
		return enterpriseErr.Severity
	}
	return SeverityLow
}

// GetErrorCategory returns the category of an error
func GetErrorCategory(err error) ErrorCategory {
	var enterpriseErr *EnterpriseError
	if errors.As(err, &enterpriseErr) {
		return enterpriseErr.Category
	}
	return CategorySystem
}

// WrapError wraps a standard error as an EnterpriseError
func WrapError(err error, code, message string, opts ...ErrorOption) *EnterpriseError {
	options := append([]ErrorOption{WithCause(err)}, opts...)
	return NewEnterpriseError(code, message, options...)
}