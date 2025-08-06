package core

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"
)

// Common error categories
var (
	// Mining errors
	ErrInvalidWork        = errors.New("invalid work template")
	ErrInvalidShare       = errors.New("invalid share submission")
	ErrStaleShare         = errors.New("stale share")
	ErrDuplicateShare     = errors.New("duplicate share")
	ErrLowDifficulty      = errors.New("share difficulty too low")
	ErrInvalidNonce       = errors.New("invalid nonce")
	ErrJobNotFound        = errors.New("job not found")
	ErrWorkerNotFound     = errors.New("worker not found")
	ErrMiningNotStarted   = errors.New("mining not started")
	
	// Network errors
	ErrConnectionFailed   = errors.New("connection failed")
	ErrConnectionTimeout  = errors.New("connection timeout")
	ErrPeerUnreachable    = errors.New("peer unreachable")
	ErrNetworkUnavailable = errors.New("network unavailable")
	ErrProtocolError      = errors.New("protocol error")
	ErrInvalidMessage     = errors.New("invalid message")
	ErrMessageTooLarge    = errors.New("message too large")
	
	// Pool errors
	ErrPoolFull           = errors.New("pool is full")
	ErrPoolClosed         = errors.New("pool is closed")
	ErrNoHealthyPools     = errors.New("no healthy pools available")
	ErrAuthFailed         = errors.New("authentication failed")
	ErrUnauthorized       = errors.New("unauthorized")
	ErrRateLimited        = errors.New("rate limited")
	
	// Resource errors
	ErrOutOfMemory        = errors.New("out of memory")
	ErrResourceExhausted  = errors.New("resource exhausted")
	ErrCapacityExceeded   = errors.New("capacity exceeded")
	
	// Configuration errors
	ErrInvalidConfig      = errors.New("invalid configuration")
	ErrMissingConfig      = errors.New("missing configuration")
	ErrConfigConflict     = errors.New("configuration conflict")
	
	// System errors
	ErrNotImplemented     = errors.New("not implemented")
	ErrOperationCanceled  = errors.New("operation canceled")
	ErrShuttingDown       = errors.New("system shutting down")
	ErrAlreadyStarted     = errors.New("already started")
	ErrNotStarted         = errors.New("not started")
)

// Error represents a comprehensive error with context
type Error struct {
	// Core error information
	Code      ErrorCode
	Message   string
	Cause     error
	
	// Context information
	Component string
	Operation string
	
	// Debug information
	Stack     string
	Timestamp time.Time
	
	// Additional context
	Context   map[string]interface{}
}

// ErrorCode represents error categories
type ErrorCode int

const (
	// Mining error codes (1000-1999)
	ErrorCodeInvalidWork ErrorCode = 1000 + iota
	ErrorCodeInvalidShare
	ErrorCodeStaleShare
	ErrorCodeDuplicateShare
	ErrorCodeLowDifficulty
	ErrorCodeInvalidNonce
	ErrorCodeJobNotFound
	ErrorCodeWorkerNotFound
	ErrorCodeMiningNotStarted
	
	// Network error codes (2000-2999)
	ErrorCodeConnectionFailed ErrorCode = 2000 + iota
	ErrorCodeConnectionTimeout
	ErrorCodePeerUnreachable
	ErrorCodeNetworkUnavailable
	ErrorCodeProtocolError
	ErrorCodeInvalidMessage
	ErrorCodeMessageTooLarge
	
	// Pool error codes (3000-3999)
	ErrorCodePoolFull ErrorCode = 3000 + iota
	ErrorCodePoolClosed
	ErrorCodeNoHealthyPools
	ErrorCodeAuthFailed
	ErrorCodeUnauthorized
	ErrorCodeRateLimited
	
	// Resource error codes (4000-4999)
	ErrorCodeOutOfMemory ErrorCode = 4000 + iota
	ErrorCodeResourceExhausted
	ErrorCodeCapacityExceeded
	
	// Configuration error codes (5000-5999)
	ErrorCodeInvalidConfig ErrorCode = 5000 + iota
	ErrorCodeMissingConfig
	ErrorCodeConfigConflict
	
	// System error codes (9000-9999)
	ErrorCodeNotImplemented ErrorCode = 9000 + iota
	ErrorCodeOperationCanceled
	ErrorCodeShuttingDown
	ErrorCodeAlreadyStarted
	ErrorCodeNotStarted
	ErrorCodeUnknown ErrorCode = 9999
)

// NewError creates a new error with context
func NewError(code ErrorCode, message string) *Error {
	return &Error{
		Code:      code,
		Message:   message,
		Stack:     captureStack(2),
		Timestamp: time.Now(),
		Context:   make(map[string]interface{}),
	}
}

// NewErrorf creates a new error with formatted message
func NewErrorf(code ErrorCode, format string, args ...interface{}) *Error {
	return NewError(code, fmt.Sprintf(format, args...))
}

// Wrap wraps an existing error with additional context
func Wrap(err error, message string) *Error {
	if err == nil {
		return nil
	}
	
	// If already our error type, add context
	if e, ok := err.(*Error); ok {
		e.Message = message + ": " + e.Message
		return e
	}
	
	// Create new error wrapping the original
	return &Error{
		Code:      ErrorCodeUnknown,
		Message:   message,
		Cause:     err,
		Stack:     captureStack(2),
		Timestamp: time.Now(),
		Context:   make(map[string]interface{}),
	}
}

// Wrapf wraps an error with formatted message
func Wrapf(err error, format string, args ...interface{}) *Error {
	return Wrap(err, fmt.Sprintf(format, args...))
}

// Error implements the error interface
func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Cause)
	}
	return e.Message
}

// WithComponent adds component information
func (e *Error) WithComponent(component string) *Error {
	e.Component = component
	return e
}

// WithOperation adds operation information
func (e *Error) WithOperation(operation string) *Error {
	e.Operation = operation
	return e
}

// WithContext adds context information
func (e *Error) WithContext(key string, value interface{}) *Error {
	e.Context[key] = value
	return e
}

// Is checks if error matches target
func (e *Error) Is(target error) bool {
	if e == target {
		return true
	}
	
	// Check by error code if target is our error type
	if te, ok := target.(*Error); ok {
		return e.Code == te.Code
	}
	
	// Check wrapped error
	if e.Cause != nil {
		return errors.Is(e.Cause, target)
	}
	
	return false
}

// Unwrap returns the wrapped error
func (e *Error) Unwrap() error {
	return e.Cause
}

// Format formats the error for display
func (e *Error) Format() string {
	var sb strings.Builder
	
	// Basic error info
	sb.WriteString(fmt.Sprintf("[%d] %s", e.Code, e.Message))
	
	// Component and operation
	if e.Component != "" || e.Operation != "" {
		sb.WriteString(" (")
		if e.Component != "" {
			sb.WriteString(fmt.Sprintf("component: %s", e.Component))
		}
		if e.Operation != "" {
			if e.Component != "" {
				sb.WriteString(", ")
			}
			sb.WriteString(fmt.Sprintf("operation: %s", e.Operation))
		}
		sb.WriteString(")")
	}
	
	// Context
	if len(e.Context) > 0 {
		sb.WriteString(" {")
		first := true
		for k, v := range e.Context {
			if !first {
				sb.WriteString(", ")
			}
			sb.WriteString(fmt.Sprintf("%s: %v", k, v))
			first = false
		}
		sb.WriteString("}")
	}
	
	// Cause
	if e.Cause != nil {
		sb.WriteString(fmt.Sprintf("\nCaused by: %v", e.Cause))
	}
	
	return sb.String()
}

// FormatVerbose formats the error with stack trace
func (e *Error) FormatVerbose() string {
	formatted := e.Format()
	if e.Stack != "" {
		formatted += fmt.Sprintf("\n\nStack trace:\n%s", e.Stack)
	}
	return formatted
}

// ErrorHandler provides centralized error handling
type ErrorHandler struct {
	handlers map[ErrorCode]ErrorHandlerFunc
	fallback ErrorHandlerFunc
}

// ErrorHandlerFunc handles specific error types
type ErrorHandlerFunc func(*Error) error

// NewErrorHandler creates a new error handler
func NewErrorHandler() *ErrorHandler {
	return &ErrorHandler{
		handlers: make(map[ErrorCode]ErrorHandlerFunc),
	}
}

// Register registers a handler for specific error code
func (eh *ErrorHandler) Register(code ErrorCode, handler ErrorHandlerFunc) {
	eh.handlers[code] = handler
}

// SetFallback sets the fallback handler
func (eh *ErrorHandler) SetFallback(handler ErrorHandlerFunc) {
	eh.fallback = handler
}

// Handle handles an error
func (eh *ErrorHandler) Handle(err error) error {
	// Convert to our error type
	var e *Error
	if !errors.As(err, &e) {
		e = Wrap(err, "error handling")
	}
	
	// Find handler
	if handler, ok := eh.handlers[e.Code]; ok {
		return handler(e)
	}
	
	// Use fallback
	if eh.fallback != nil {
		return eh.fallback(e)
	}
	
	return e
}

// Helper functions

// IsRetryable checks if an error is retryable
func IsRetryable(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	
	switch e.Code {
	case ErrorCodeConnectionFailed,
	     ErrorCodeConnectionTimeout,
	     ErrorCodePeerUnreachable,
	     ErrorCodeNetworkUnavailable,
	     ErrorCodeRateLimited,
	     ErrorCodeResourceExhausted:
		return true
	default:
		return false
	}
}

// IsFatal checks if an error is fatal
func IsFatal(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	
	switch e.Code {
	case ErrorCodeOutOfMemory,
	     ErrorCodeShuttingDown,
	     ErrorCodeInvalidConfig:
		return true
	default:
		return false
	}
}

// GetErrorCode extracts error code from error
func GetErrorCode(err error) ErrorCode {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ErrorCodeUnknown
}

// captureStack captures the current stack trace
func captureStack(skip int) string {
	const maxDepth = 32
	var pcs [maxDepth]uintptr
	n := runtime.Callers(skip+1, pcs[:])
	
	if n == 0 {
		return ""
	}
	
	frames := runtime.CallersFrames(pcs[:n])
	var sb strings.Builder
	
	for {
		frame, more := frames.Next()
		
		// Skip runtime internals
		if strings.Contains(frame.File, "runtime/") {
			if !more {
				break
			}
			continue
		}
		
		sb.WriteString(fmt.Sprintf("%s\n\t%s:%d\n", frame.Function, frame.File, frame.Line))
		
		if !more {
			break
		}
	}
	
	return sb.String()
}

// Error recovery helpers

// Recover recovers from panic and converts to error
func Recover() error {
	if r := recover(); r != nil {
		err := NewError(ErrorCodeUnknown, fmt.Sprintf("panic: %v", r))
		err.Stack = captureStack(3)
		return err
	}
	return nil
}

// RecoverWith recovers from panic with custom handler
func RecoverWith(handler func(interface{}) error) error {
	if r := recover(); r != nil {
		return handler(r)
	}
	return nil
}

// Must panics if error is not nil
func Must(err error) {
	if err != nil {
		panic(err)
	}
}

// MustValue returns value or panics if error
func MustValue[T any](val T, err error) T {
	if err != nil {
		panic(err)
	}
	return val
}