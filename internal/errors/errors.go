package errors

import (
	"errors"
	"fmt"
	"runtime"
	"time"
)

// ErrorCode represents an error classification
type ErrorCode string

const (
	// System errors
	ErrCodeSystem     ErrorCode = "SYSTEM_ERROR"
	ErrCodeNetwork    ErrorCode = "NETWORK_ERROR"
	ErrCodeTimeout    ErrorCode = "TIMEOUT_ERROR"
	ErrCodeDatabase   ErrorCode = "DATABASE_ERROR"
	ErrCodeConfig     ErrorCode = "CONFIG_ERROR"
	
	// Mining errors
	ErrCodeMining     ErrorCode = "MINING_ERROR"
	ErrCodePool       ErrorCode = "POOL_ERROR"
	ErrCodeWorker     ErrorCode = "WORKER_ERROR"
	ErrCodeDevice     ErrorCode = "DEVICE_ERROR"
	ErrCodeAlgorithm  ErrorCode = "ALGORITHM_ERROR"
	
	// Security errors
	ErrCodeAuth       ErrorCode = "AUTH_ERROR"
	ErrCodePermission ErrorCode = "PERMISSION_ERROR"
	ErrCodeSecurity   ErrorCode = "SECURITY_ERROR"
	
	// API errors
	ErrCodeAPI        ErrorCode = "API_ERROR"
	ErrCodeValidation ErrorCode = "VALIDATION_ERROR"
	ErrCodeRateLimit  ErrorCode = "RATE_LIMIT_ERROR"
	
	// P2P errors
	ErrCodeP2P        ErrorCode = "P2P_ERROR"
	ErrCodePeer       ErrorCode = "PEER_ERROR"
	ErrCodeProtocol   ErrorCode = "PROTOCOL_ERROR"
)

// Severity represents error severity levels
type Severity string

const (
	SeverityInfo     Severity = "INFO"
	SeverityWarning  Severity = "WARNING"
	SeverityError    Severity = "ERROR"
	SeverityCritical Severity = "CRITICAL"
	SeverityFatal    Severity = "FATAL"
)

// OtedamaError represents a structured error with metadata
type OtedamaError struct {
	Code      ErrorCode              `json:"code"`
	Message   string                 `json:"message"`
	Severity  Severity              `json:"severity"`
	Context   map[string]interface{} `json:"context,omitempty"`
	Cause     error                  `json:"cause,omitempty"`
	Timestamp time.Time              `json:"timestamp"`
	Stack     string                 `json:"stack,omitempty"`
}

// Error implements the error interface
func (e *OtedamaError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

// Unwrap returns the underlying error
func (e *OtedamaError) Unwrap() error {
	return e.Cause
}

// Is implements error comparison
func (e *OtedamaError) Is(target error) bool {
	if t, ok := target.(*OtedamaError); ok {
		return e.Code == t.Code
	}
	return false
}

// WithContext adds context to the error
func (e *OtedamaError) WithContext(key string, value interface{}) *OtedamaError {
	if e.Context == nil {
		e.Context = make(map[string]interface{})
	}
	e.Context[key] = value
	return e
}

// WithStack adds stack trace to the error
func (e *OtedamaError) WithStack() *OtedamaError {
	buf := make([]byte, 1024)
	n := runtime.Stack(buf, false)
	e.Stack = string(buf[:n])
	return e
}

// New creates a new OtedamaError
func New(code ErrorCode, message string, severity Severity) *OtedamaError {
	return &OtedamaError{
		Code:      code,
		Message:   message,
		Severity:  severity,
		Timestamp: time.Now(),
	}
}

// Wrap wraps an existing error with additional context
func Wrap(err error, code ErrorCode, message string, severity Severity) *OtedamaError {
	return &OtedamaError{
		Code:      code,
		Message:   message,
		Severity:  severity,
		Cause:     err,
		Timestamp: time.Now(),
	}
}

// Wrapf wraps an error with formatted message
func Wrapf(err error, code ErrorCode, severity Severity, format string, args ...interface{}) *OtedamaError {
	return Wrap(err, code, fmt.Sprintf(format, args...), severity)
}

// Critical creates a critical error
func Critical(code ErrorCode, message string) *OtedamaError {
	return New(code, message, SeverityCritical).WithStack()
}

// Fatal creates a fatal error
func Fatal(code ErrorCode, message string) *OtedamaError {
	return New(code, message, SeverityFatal).WithStack()
}

// IsCode checks if an error has a specific code
func IsCode(err error, code ErrorCode) bool {
	if e, ok := err.(*OtedamaError); ok {
		return e.Code == code
	}
	return false
}

// IsSeverity checks if an error has a specific severity
func IsSeverity(err error, severity Severity) bool {
	if e, ok := err.(*OtedamaError); ok {
		return e.Severity == severity
	}
	return false
}

// GetCode extracts error code from error
func GetCode(err error) ErrorCode {
	if e, ok := err.(*OtedamaError); ok {
		return e.Code
	}
	return ErrCodeSystem
}

// GetSeverity extracts severity from error
func GetSeverity(err error) Severity {
	if e, ok := err.(*OtedamaError); ok {
		return e.Severity
	}
	return SeverityError
}

// Common error constructors for frequently used errors

// ErrInvalidInput creates a validation error for invalid input
func ErrInvalidInput(field string, value interface{}) *OtedamaError {
	return New(ErrCodeValidation, fmt.Sprintf("invalid input for field '%s': %v", field, value), SeverityError)
}

// ErrNotFound creates a not found error
func ErrNotFound(resource string, id interface{}) *OtedamaError {
	return New(ErrCodeSystem, fmt.Sprintf("%s not found: %v", resource, id), SeverityWarning)
}

// ErrUnauthorized creates an authorization error
func ErrUnauthorized(action string) *OtedamaError {
	return New(ErrCodeAuth, fmt.Sprintf("unauthorized action: %s", action), SeverityWarning)
}

// ErrForbidden creates a permission error
func ErrForbidden(resource string) *OtedamaError {
	return New(ErrCodePermission, fmt.Sprintf("access forbidden to resource: %s", resource), SeverityWarning)
}

// ErrRateLimit creates a rate limit error
func ErrRateLimit(limit int, window string) *OtedamaError {
	return New(ErrCodeRateLimit, fmt.Sprintf("rate limit exceeded: %d requests per %s", limit, window), SeverityWarning)
}

// ErrTimeout creates a timeout error
func ErrTimeout(operation string, duration time.Duration) *OtedamaError {
	return New(ErrCodeTimeout, fmt.Sprintf("operation '%s' timed out after %v", operation, duration), SeverityError)
}

// ErrConnectionFailed creates a network connection error
func ErrConnectionFailed(target string, cause error) *OtedamaError {
	return Wrap(cause, ErrCodeNetwork, fmt.Sprintf("failed to connect to %s", target), SeverityError)
}

// ErrConfigInvalid creates a configuration error
func ErrConfigInvalid(field string, reason string) *OtedamaError {
	return New(ErrCodeConfig, fmt.Sprintf("invalid configuration for '%s': %s", field, reason), SeverityError)
}

// ErrMiningFailed creates a mining operation error
func ErrMiningFailed(operation string, cause error) *OtedamaError {
	return Wrap(cause, ErrCodeMining, fmt.Sprintf("mining operation failed: %s", operation), SeverityError)
}

// ErrDeviceError creates a device-related error
func ErrDeviceError(device string, operation string, cause error) *OtedamaError {
	return Wrap(cause, ErrCodeDevice, fmt.Sprintf("device '%s' error during %s", device, operation), SeverityError)
}

// ErrPoolConnection creates a pool connection error
func ErrPoolConnection(pool string, cause error) *OtedamaError {
	return Wrap(cause, ErrCodePool, fmt.Sprintf("pool connection failed: %s", pool), SeverityError)
}

// ErrWorkerFailure creates a worker failure error
func ErrWorkerFailure(workerID string, cause error) *OtedamaError {
	return Wrap(cause, ErrCodeWorker, fmt.Sprintf("worker '%s' failed", workerID), SeverityWarning)
}

// ErrAlgorithmUnsupported creates an unsupported algorithm error
func ErrAlgorithmUnsupported(algorithm string) *OtedamaError {
	return New(ErrCodeAlgorithm, fmt.Sprintf("unsupported algorithm: %s", algorithm), SeverityError)
}

// ErrP2PProtocol creates a P2P protocol error
func ErrP2PProtocol(message string, cause error) *OtedamaError {
	return Wrap(cause, ErrCodeProtocol, fmt.Sprintf("P2P protocol error: %s", message), SeverityError)
}

// ErrDatabaseOperation creates a database operation error
func ErrDatabaseOperation(operation string, cause error) *OtedamaError {
	return Wrap(cause, ErrCodeDatabase, fmt.Sprintf("database operation failed: %s", operation), SeverityError)
}

// ErrAPI creates a generic API error
func ErrAPI(message string) *OtedamaError {
	return New(ErrCodeAPI, message, SeverityError)
}

// ErrorHandler provides structured error handling
type ErrorHandler struct {
	OnError func(*OtedamaError) // Callback for error handling
}

// NewErrorHandler creates a new error handler
func NewErrorHandler(onError func(*OtedamaError)) *ErrorHandler {
	return &ErrorHandler{OnError: onError}
}

// Handle processes an error
func (eh *ErrorHandler) Handle(err error) {
	if err == nil {
		return
	}
	
	var otedamaErr *OtedamaError
	if !errors.As(err, &otedamaErr) {
		// Convert generic error to OtedamaError
		otedamaErr = Wrap(err, ErrCodeSystem, err.Error(), SeverityError)
	}
	
	if eh.OnError != nil {
		eh.OnError(otedamaErr)
	}
}

// Must panics if error is not nil
func Must(err error) {
	if err != nil {
		panic(err)
	}
}

// MustReturn panics if error is not nil, otherwise returns the value
func MustReturn[T any](value T, err error) T {
	Must(err)
	return value
}