package common

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Error severity levels for prioritization
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
	CategoryPool        ErrorCategory = "pool"
	CategoryWallet      ErrorCategory = "wallet"
)

// Common sentinel errors used across the application
var (
	// General errors
	ErrNilInput      = errors.New("nil input provided")
	ErrInvalidInput  = errors.New("invalid input")
	ErrNotFound      = errors.New("not found")
	ErrAlreadyExists = errors.New("already exists")
	ErrTimeout       = errors.New("operation timeout")
	ErrCanceled      = errors.New("operation canceled")
	ErrNotImplemented = errors.New("not implemented")
	ErrInternal      = errors.New("internal error")
	
	// Resource errors
	ErrResourceExhausted = errors.New("resource exhausted")
	ErrQuotaExceeded     = errors.New("quota exceeded")
	ErrRateLimited       = errors.New("rate limited")
	ErrResourceBusy      = errors.New("resource busy")
	ErrResourceLocked    = errors.New("resource locked")
	
	// State errors
	ErrInvalidState     = errors.New("invalid state")
	ErrNotInitialized   = errors.New("not initialized")
	ErrAlreadyStarted   = errors.New("already started")
	ErrAlreadyStopped   = errors.New("already stopped")
	ErrShuttingDown     = errors.New("shutting down")
	
	// Permission errors
	ErrUnauthorized     = errors.New("unauthorized")
	ErrPermissionDenied = errors.New("permission denied")
	ErrTokenExpired     = errors.New("token expired")
	ErrInvalidToken     = errors.New("invalid token")
	
	// Network errors
	ErrConnectionFailed = errors.New("connection failed")
	ErrConnectionLost   = errors.New("connection lost")
	ErrNetworkTimeout   = errors.New("network timeout")
	ErrHostUnreachable  = errors.New("host unreachable")
	
	// Mining errors
	ErrInvalidShare     = errors.New("invalid share")
	ErrStaleShare       = errors.New("stale share")
	ErrDuplicateShare   = errors.New("duplicate share")
	ErrLowDifficulty    = errors.New("difficulty too low")
	ErrInvalidNonce     = errors.New("invalid nonce")
	ErrInvalidWork      = errors.New("invalid work")
	
	// Hardware errors
	ErrDeviceNotFound   = errors.New("device not found")
	ErrDeviceError      = errors.New("device error")
	ErrDeviceOverheat   = errors.New("device overheat")
	ErrDeviceDisabled   = errors.New("device disabled")
	
	// Additional system errors
	ErrSystemOverloaded   = errors.New("system overloaded")
	ErrComponentFailed    = errors.New("component failed")
	ErrConfigInvalid      = errors.New("invalid configuration")
	ErrSuspiciousActivity = errors.New("suspicious activity detected")
	ErrSecurityViolation  = errors.New("security violation")
)

// ValidationError represents a validation failure with field information
type ValidationError struct {
	Field   string
	Value   interface{}
	Message string
}

// Error implements the error interface
func (e ValidationError) Error() string {
	if e.Field != "" {
		return fmt.Sprintf("validation error for field '%s': %s (value: %v)", e.Field, e.Message, e.Value)
	}
	return fmt.Sprintf("validation error: %s", e.Message)
}

// MultiError represents multiple errors that occurred
type MultiError struct {
	Errors []error
}

// Error implements the error interface
func (e MultiError) Error() string {
	if len(e.Errors) == 0 {
		return "no errors"
	}
	if len(e.Errors) == 1 {
		return e.Errors[0].Error()
	}
	return fmt.Sprintf("multiple errors occurred: first error: %v (total: %d)", e.Errors[0], len(e.Errors))
}

// Add adds an error to the multi-error
func (e *MultiError) Add(err error) {
	if err != nil {
		e.Errors = append(e.Errors, err)
	}
}

// HasErrors returns true if there are any errors
func (e *MultiError) HasErrors() bool {
	return len(e.Errors) > 0
}

// ErrorOrNil returns nil if no errors, otherwise returns the MultiError
func (e *MultiError) ErrorOrNil() error {
	if !e.HasErrors() {
		return nil
	}
	return e
}

// OperationError represents an error during a specific operation
type OperationError struct {
	Op      string // Operation being performed
	Entity  string // Entity being operated on
	Err     error  // Underlying error
}

// Error implements the error interface
func (e OperationError) Error() string {
	if e.Entity != "" {
		return fmt.Sprintf("%s %s: %v", e.Op, e.Entity, e.Err)
	}
	return fmt.Sprintf("%s: %v", e.Op, e.Err)
}

// Unwrap returns the underlying error
func (e OperationError) Unwrap() error {
	return e.Err
}

// WrapError wraps an error with operation context
func WrapError(op, entity string, err error) error {
	if err == nil {
		return nil
	}
	return OperationError{
		Op:     op,
		Entity: entity,
		Err:    err,
	}
}

// IsRetryable checks if an error is retryable
func IsRetryable(err error) bool {
	if err == nil {
		return false
	}
	
	// Check for specific retryable errors
	switch {
	case errors.Is(err, ErrTimeout):
		return true
	case errors.Is(err, ErrResourceExhausted):
		return true
	case errors.Is(err, ErrRateLimited):
		return true
	case errors.Is(err, ErrResourceBusy):
		return true
	case errors.Is(err, ErrConnectionLost):
		return true
	case errors.Is(err, ErrNetworkTimeout):
		return true
	case errors.Is(err, ErrHostUnreachable):
		return true
	case errors.Is(err, ErrDeviceError):
		return true
	default:
		return false
	}
}

// IsFatal checks if an error is fatal and should not be retried
func IsFatal(err error) bool {
	if err == nil {
		return false
	}
	
	// Check for specific fatal errors
	switch {
	case errors.Is(err, ErrInvalidInput):
		return true
	case errors.Is(err, ErrUnauthorized):
		return true
	case errors.Is(err, ErrPermissionDenied):
		return true
	case errors.Is(err, ErrInvalidState):
		return true
	case errors.Is(err, ErrNotImplemented):
		return true
	case errors.Is(err, ErrTokenExpired):
		return true
	case errors.Is(err, ErrInvalidToken):
		return true
	case errors.Is(err, ErrNotInitialized):
		return true
	case errors.Is(err, ErrShuttingDown):
		return true
	default:
		return false
	}
}

// IsTemporary checks if an error is temporary
func IsTemporary(err error) bool {
	if err == nil {
		return false
	}
	
	switch {
	case errors.Is(err, ErrResourceBusy):
		return true
	case errors.Is(err, ErrResourceLocked):
		return true
	case errors.Is(err, ErrRateLimited):
		return true
	case errors.Is(err, ErrResourceExhausted):
		return true
	default:
		return false
	}
}

// OtedamaError provides comprehensive error information with full context
type OtedamaError struct {
	Code       string
	Message    string
	Category   ErrorCategory
	Severity   ErrorSeverity
	Component  string
	Operation  string
	Timestamp  time.Time
	StackTrace string
	Context    map[string]interface{}
	Wrapped    error
	mu         sync.RWMutex
}

// Error implements the error interface
func (e *OtedamaError) Error() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("[%s] %s: %s", e.Category, e.Code, e.Message))
	
	if e.Component != "" {
		sb.WriteString(fmt.Sprintf(" (component: %s)", e.Component))
	}
	
	if e.Operation != "" {
		sb.WriteString(fmt.Sprintf(" (operation: %s)", e.Operation))
	}
	
	if e.Wrapped != nil {
		sb.WriteString(fmt.Sprintf(" - %v", e.Wrapped))
	}
	
	return sb.String()
}

// Unwrap returns the wrapped error
func (e *OtedamaError) Unwrap() error {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.Wrapped
}

// Is implements error comparison
func (e *OtedamaError) Is(target error) bool {
	t, ok := target.(*OtedamaError)
	if !ok {
		return false
	}
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.Code == t.Code && e.Category == t.Category
}

// NewError creates a new OtedamaError with comprehensive context
func NewError(code string, message string, category ErrorCategory, severity ErrorSeverity) *OtedamaError {
	return &OtedamaError{
		Code:       code,
		Message:    message,
		Category:   category,
		Severity:   severity,
		Timestamp:  time.Now(),
		StackTrace: getStackTrace(),
		Context:    make(map[string]interface{}),
	}
}

// WithComponent adds component information to the error
func (e *OtedamaError) WithComponent(component string) *OtedamaError {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.Component = component
	return e
}

// WithOperation adds operation information to the error
func (e *OtedamaError) WithOperation(operation string) *OtedamaError {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.Operation = operation
	return e
}

// WithContext adds context information to the error
func (e *OtedamaError) WithContext(key string, value interface{}) *OtedamaError {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.Context[key] = value
	return e
}

// Wrap wraps another error
func (e *OtedamaError) Wrap(err error) *OtedamaError {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.Wrapped = err
	return e
}

// getStackTrace captures the current stack trace
func getStackTrace() string {
	buf := make([]byte, 4096)
	n := runtime.Stack(buf, false)
	return string(buf[:n])
}

// GetErrorCode returns a unique error code for the error
func GetErrorCode(err error) string {
	if err == nil {
		return "OK"
	}
	
	// Map errors to codes
	switch {
	// General errors
	case errors.Is(err, ErrNilInput):
		return "E001"
	case errors.Is(err, ErrInvalidInput):
		return "E002"
	case errors.Is(err, ErrNotFound):
		return "E003"
	case errors.Is(err, ErrAlreadyExists):
		return "E004"
	case errors.Is(err, ErrTimeout):
		return "E005"
	case errors.Is(err, ErrCanceled):
		return "E006"
	case errors.Is(err, ErrNotImplemented):
		return "E007"
	case errors.Is(err, ErrInternal):
		return "E008"
	
	// Resource errors
	case errors.Is(err, ErrResourceExhausted):
		return "E101"
	case errors.Is(err, ErrQuotaExceeded):
		return "E102"
	case errors.Is(err, ErrRateLimited):
		return "E103"
	case errors.Is(err, ErrResourceBusy):
		return "E104"
	case errors.Is(err, ErrResourceLocked):
		return "E105"
	
	// State errors
	case errors.Is(err, ErrInvalidState):
		return "E201"
	case errors.Is(err, ErrNotInitialized):
		return "E202"
	case errors.Is(err, ErrAlreadyStarted):
		return "E203"
	case errors.Is(err, ErrAlreadyStopped):
		return "E204"
	case errors.Is(err, ErrShuttingDown):
		return "E205"
	
	// Permission errors
	case errors.Is(err, ErrUnauthorized):
		return "E301"
	case errors.Is(err, ErrPermissionDenied):
		return "E302"
	case errors.Is(err, ErrTokenExpired):
		return "E303"
	case errors.Is(err, ErrInvalidToken):
		return "E304"
	
	// Network errors
	case errors.Is(err, ErrConnectionFailed):
		return "E401"
	case errors.Is(err, ErrConnectionLost):
		return "E402"
	case errors.Is(err, ErrNetworkTimeout):
		return "E403"
	case errors.Is(err, ErrHostUnreachable):
		return "E404"
	
	// Mining errors
	case errors.Is(err, ErrInvalidShare):
		return "E501"
	case errors.Is(err, ErrStaleShare):
		return "E502"
	case errors.Is(err, ErrDuplicateShare):
		return "E503"
	case errors.Is(err, ErrLowDifficulty):
		return "E504"
	case errors.Is(err, ErrInvalidNonce):
		return "E505"
	case errors.Is(err, ErrInvalidWork):
		return "E506"
	
	// Hardware errors
	case errors.Is(err, ErrDeviceNotFound):
		return "E601"
	case errors.Is(err, ErrDeviceError):
		return "E602"
	case errors.Is(err, ErrDeviceOverheat):
		return "E603"
	case errors.Is(err, ErrDeviceDisabled):
		return "E604"
	
	default:
		// Check if it's an OtedamaError
		if otedamaErr, ok := err.(*OtedamaError); ok {
			return otedamaErr.Code
		}
		return "E999" // Unknown error
	}
}

// GetErrorSeverity extracts error severity from an error
func GetErrorSeverity(err error) ErrorSeverity {
	if err == nil {
		return SeverityLow
	}
	
	if otedamaErr, ok := err.(*OtedamaError); ok {
		return otedamaErr.Severity
	}
	
	// Default severity based on error type
	switch {
	case errors.Is(err, ErrSecurityViolation):
		return SeverityFatal
	case errors.Is(err, ErrUnauthorized), errors.Is(err, ErrPermissionDenied):
		return SeverityCritical
	case errors.Is(err, ErrConnectionFailed), errors.Is(err, ErrConnectionLost):
		return SeverityHigh
	case errors.Is(err, ErrStaleShare), errors.Is(err, ErrLowDifficulty):
		return SeverityMedium
	default:
		return SeverityLow
	}
}

// ErrorMetrics tracks error statistics for monitoring
type ErrorMetrics struct {
	TotalErrors      atomic.Uint64
	ErrorsByCode     sync.Map // map[string]uint64
	ErrorsBySeverity sync.Map // map[ErrorSeverity]uint64
	ErrorsByCategory sync.Map // map[ErrorCategory]uint64
	LastError        atomic.Int64
	mu               sync.RWMutex
}

// NewErrorMetrics creates a new error metrics tracker
func NewErrorMetrics() *ErrorMetrics {
	return &ErrorMetrics{}
}

// RecordError records an error in metrics
func (em *ErrorMetrics) RecordError(err error) {
	if err == nil {
		return
	}
	
	em.TotalErrors.Add(1)
	em.LastError.Store(time.Now().Unix())
	
	if otedamaErr, ok := err.(*OtedamaError); ok {
		// Update code count
		if val, _ := em.ErrorsByCode.LoadOrStore(otedamaErr.Code, new(atomic.Uint64)); val != nil {
			val.(*atomic.Uint64).Add(1)
		}
		
		// Update severity count
		if val, _ := em.ErrorsBySeverity.LoadOrStore(otedamaErr.Severity, new(atomic.Uint64)); val != nil {
			val.(*atomic.Uint64).Add(1)
		}
		
		// Update category count
		if val, _ := em.ErrorsByCategory.LoadOrStore(otedamaErr.Category, new(atomic.Uint64)); val != nil {
			val.(*atomic.Uint64).Add(1)
		}
	}
}

// GetStats returns error statistics
func (em *ErrorMetrics) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_errors": em.TotalErrors.Load(),
		"last_error":   time.Unix(em.LastError.Load(), 0),
	}
	
	// Collect error counts by code
	errorsByCode := make(map[string]uint64)
	em.ErrorsByCode.Range(func(key, value interface{}) bool {
		errorsByCode[key.(string)] = value.(*atomic.Uint64).Load()
		return true
	})
	stats["errors_by_code"] = errorsByCode
	
	return stats
}

// ErrorHandler provides centralized error handling with context
type ErrorHandler struct {
	logger     interface{} // Use interface to avoid circular dependencies
	metrics    *ErrorMetrics
	mu         sync.RWMutex
	handlers   map[ErrorCategory]func(error)
	shutdownCh chan struct{}
}

// NewErrorHandler creates a new error handler
func NewErrorHandler() *ErrorHandler {
	return &ErrorHandler{
		metrics:    NewErrorMetrics(),
		handlers:   make(map[ErrorCategory]func(error)),
		shutdownCh: make(chan struct{}),
	}
}

// Handle processes an error with appropriate action
func (eh *ErrorHandler) Handle(ctx context.Context, err error) {
	if err == nil {
		return
	}
	
	// Record metrics
	eh.metrics.RecordError(err)
	
	// Get category and call specific handler
	if otedamaErr, ok := err.(*OtedamaError); ok {
		eh.mu.RLock()
		handler, exists := eh.handlers[otedamaErr.Category]
		eh.mu.RUnlock()
		
		if exists {
			handler(err)
		}
		
		// Take action based on severity
		switch otedamaErr.Severity {
		case SeverityFatal:
			// Trigger graceful shutdown for fatal errors
			select {
			case eh.shutdownCh <- struct{}{}:
			default:
			}
		case SeverityCritical:
			// Alert monitoring systems for critical errors
			// Implementation depends on monitoring setup
		}
	}
}

// RegisterHandler registers a category-specific error handler
func (eh *ErrorHandler) RegisterHandler(category ErrorCategory, handler func(error)) {
	eh.mu.Lock()
	defer eh.mu.Unlock()
	eh.handlers[category] = handler
}