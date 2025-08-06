package common

import (
	"errors"
	"fmt"
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
		return "E999" // Unknown error
	}
}