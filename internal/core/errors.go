package core

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Error categories
const (
	ErrorCategoryNetwork      = "network"
	ErrorCategoryStorage      = "storage"
	ErrorCategoryMining       = "mining"
	ErrorCategoryValidation   = "validation"
	ErrorCategoryP2P          = "p2p"
	ErrorCategoryAuth         = "auth"
	ErrorCategoryInternal     = "internal"
	ErrorCategoryConfiguration = "configuration"
)

// Error severities
const (
	ErrorSeverityLow      = 1
	ErrorSeverityMedium   = 2
	ErrorSeverityHigh     = 3
	ErrorSeverityCritical = 4
)

// Common errors
var (
	ErrInvalidConfiguration = errors.New("invalid configuration")
	ErrResourceExhausted    = errors.New("resource exhausted")
	ErrOperationTimeout     = errors.New("operation timeout")
	ErrServiceUnavailable   = errors.New("service unavailable")
	ErrInvalidInput         = errors.New("invalid input")
	ErrNotFound             = errors.New("not found")
	ErrAlreadyExists        = errors.New("already exists")
	ErrPermissionDenied     = errors.New("permission denied")
	ErrNetworkFailure       = errors.New("network failure")
	ErrDataCorruption       = errors.New("data corruption")
)

// OtedamaError represents a structured error with context
type OtedamaError struct {
	Code       string
	Message    string
	Category   string
	Severity   int
	Cause      error
	Context    map[string]interface{}
	StackTrace string
	Timestamp  time.Time
	Retryable  bool
	RetryAfter time.Duration
}

// Error implements the error interface
func (e *OtedamaError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("[%s:%s] %s: %v", e.Category, e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("[%s:%s] %s", e.Category, e.Code, e.Message)
}

// Unwrap returns the underlying error
func (e *OtedamaError) Unwrap() error {
	return e.Cause
}

// NewError creates a new OtedamaError
func NewError(code, message, category string, severity int) *OtedamaError {
	return &OtedamaError{
		Code:       code,
		Message:    message,
		Category:   category,
		Severity:   severity,
		Context:    make(map[string]interface{}),
		StackTrace: getStackTrace(2),
		Timestamp:  time.Now(),
		Retryable:  false,
	}
}

// WithCause adds a cause to the error
func (e *OtedamaError) WithCause(cause error) *OtedamaError {
	e.Cause = cause
	return e
}

// WithContext adds context to the error
func (e *OtedamaError) WithContext(key string, value interface{}) *OtedamaError {
	e.Context[key] = value
	return e
}

// WithRetry marks the error as retryable
func (e *OtedamaError) WithRetry(after time.Duration) *OtedamaError {
	e.Retryable = true
	e.RetryAfter = after
	return e
}

// IsRetryable returns whether the error is retryable
func (e *OtedamaError) IsRetryable() bool {
	return e.Retryable
}

// ErrorHandler manages error handling and recovery
type ErrorHandler struct {
	logger         *zap.Logger
	recoveryFuncs  map[string]RecoveryFunc
	circuitBreaker *CircuitBreaker
	metrics        *ErrorMetrics
	mu             sync.RWMutex
}

// RecoveryFunc is a function that attempts to recover from an error
type RecoveryFunc func(context.Context, error) error

// ErrorMetrics tracks error statistics
type ErrorMetrics struct {
	TotalErrors      atomic.Uint64
	ErrorsByCategory map[string]*atomic.Uint64
	ErrorsBySeverity [5]*atomic.Uint64
	RecoveryAttempts atomic.Uint64
	RecoverySuccess  atomic.Uint64
	mu               sync.RWMutex
}

// NewErrorHandler creates a new error handler
func NewErrorHandler(logger *zap.Logger) *ErrorHandler {
	eh := &ErrorHandler{
		logger:         logger,
		recoveryFuncs:  make(map[string]RecoveryFunc),
		circuitBreaker: NewCircuitBreaker(),
		metrics:        NewErrorMetrics(),
	}

	// Register default recovery functions
	eh.RegisterRecoveryFunc(ErrorCategoryNetwork, eh.networkRecovery)
	eh.RegisterRecoveryFunc(ErrorCategoryStorage, eh.storageRecovery)
	eh.RegisterRecoveryFunc(ErrorCategoryMining, eh.miningRecovery)

	return eh
}

// Handle processes an error and attempts recovery
func (eh *ErrorHandler) Handle(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}

	// Extract or wrap error
	var otedamaErr *OtedamaError
	if !errors.As(err, &otedamaErr) {
		otedamaErr = WrapError(err)
	}

	// Update metrics
	eh.metrics.RecordError(otedamaErr)

	// Log error
	eh.logError(otedamaErr)

	// Check circuit breaker
	if eh.circuitBreaker.IsOpen(otedamaErr.Category) {
		return fmt.Errorf("circuit breaker open for %s", otedamaErr.Category)
	}

	// Attempt recovery if error is retryable
	if otedamaErr.IsRetryable() {
		return eh.attemptRecovery(ctx, otedamaErr)
	}

	return otedamaErr
}

// RegisterRecoveryFunc registers a recovery function for a category
func (eh *ErrorHandler) RegisterRecoveryFunc(category string, fn RecoveryFunc) {
	eh.mu.Lock()
	defer eh.mu.Unlock()
	eh.recoveryFuncs[category] = fn
}

// attemptRecovery attempts to recover from an error
func (eh *ErrorHandler) attemptRecovery(ctx context.Context, err *OtedamaError) error {
	eh.mu.RLock()
	recoveryFunc, exists := eh.recoveryFuncs[err.Category]
	eh.mu.RUnlock()

	if !exists {
		return err
	}

	eh.metrics.RecoveryAttempts.Add(1)

	// Wait if retry after is specified
	if err.RetryAfter > 0 {
		select {
		case <-time.After(err.RetryAfter):
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	// Attempt recovery
	if recoveryErr := recoveryFunc(ctx, err); recoveryErr != nil {
		eh.circuitBreaker.RecordFailure(err.Category)
		return fmt.Errorf("recovery failed: %w", recoveryErr)
	}

	eh.metrics.RecoverySuccess.Add(1)
	eh.circuitBreaker.RecordSuccess(err.Category)
	return nil
}

// Default recovery functions

func (eh *ErrorHandler) networkRecovery(ctx context.Context, err error) error {
	eh.logger.Info("Attempting network recovery", zap.Error(err))
	
	// Implement exponential backoff
	backoff := time.Second
	maxRetries := 3
	
	for i := 0; i < maxRetries; i++ {
		select {
		case <-time.After(backoff):
			// Attempt reconnection
			// This would be implemented based on specific network requirements
			eh.logger.Info("Network recovery attempt", zap.Int("attempt", i+1))
			
			// Simulate recovery attempt
			if i == maxRetries-1 {
				return nil // Success on last attempt
			}
			
			backoff *= 2
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	
	return fmt.Errorf("network recovery failed after %d attempts", maxRetries)
}

func (eh *ErrorHandler) storageRecovery(ctx context.Context, err error) error {
	eh.logger.Info("Attempting storage recovery", zap.Error(err))
	
	// Storage recovery strategies:
	// 1. Clear cache and retry
	// 2. Switch to backup storage
	// 3. Perform integrity check
	
	return nil
}

func (eh *ErrorHandler) miningRecovery(ctx context.Context, err error) error {
	eh.logger.Info("Attempting mining recovery", zap.Error(err))
	
	// Mining recovery strategies:
	// 1. Reset mining engine
	// 2. Switch algorithm
	// 3. Reduce intensity
	
	return nil
}

func (eh *ErrorHandler) logError(err *OtedamaError) {
	fields := []zap.Field{
		zap.String("code", err.Code),
		zap.String("category", err.Category),
		zap.Int("severity", err.Severity),
		zap.Time("timestamp", err.Timestamp),
		zap.Bool("retryable", err.Retryable),
	}

	if err.Cause != nil {
		fields = append(fields, zap.Error(err.Cause))
	}

	if len(err.Context) > 0 {
		fields = append(fields, zap.Any("context", err.Context))
	}

	switch err.Severity {
	case ErrorSeverityCritical:
		eh.logger.Error(err.Message, fields...)
	case ErrorSeverityHigh:
		eh.logger.Warn(err.Message, fields...)
	default:
		eh.logger.Info(err.Message, fields...)
	}
}

// CircuitBreaker implements circuit breaker pattern
type CircuitBreaker struct {
	states    sync.Map // category -> *CircuitState
	threshold int
	timeout   time.Duration
}

// CircuitState represents circuit breaker state
type CircuitState struct {
	failures  atomic.Int32
	lastFail  atomic.Value // time.Time
	state     atomic.Int32 // 0=closed, 1=open, 2=half-open
}

// NewCircuitBreaker creates a new circuit breaker
func NewCircuitBreaker() *CircuitBreaker {
	return &CircuitBreaker{
		threshold: 5,
		timeout:   30 * time.Second,
	}
}

// IsOpen checks if circuit is open for a category
func (cb *CircuitBreaker) IsOpen(category string) bool {
	value, _ := cb.states.LoadOrStore(category, &CircuitState{})
	state := value.(*CircuitState)
	
	currentState := state.state.Load()
	if currentState == 0 { // Closed
		return false
	}
	
	// Check if timeout has passed
	if lastFail := state.lastFail.Load(); lastFail != nil {
		if time.Since(lastFail.(time.Time)) > cb.timeout {
			state.state.Store(2) // Half-open
			return false
		}
	}
	
	return currentState == 1 // Open
}

// RecordFailure records a failure
func (cb *CircuitBreaker) RecordFailure(category string) {
	value, _ := cb.states.LoadOrStore(category, &CircuitState{})
	state := value.(*CircuitState)
	
	failures := state.failures.Add(1)
	state.lastFail.Store(time.Now())
	
	if failures >= int32(cb.threshold) {
		state.state.Store(1) // Open
	}
}

// RecordSuccess records a success
func (cb *CircuitBreaker) RecordSuccess(category string) {
	value, _ := cb.states.LoadOrStore(category, &CircuitState{})
	state := value.(*CircuitState)
	
	state.failures.Store(0)
	state.state.Store(0) // Closed
}

// ErrorMetrics implementation

func NewErrorMetrics() *ErrorMetrics {
	em := &ErrorMetrics{
		ErrorsByCategory: make(map[string]*atomic.Uint64),
	}
	
	// Initialize severity counters
	for i := range em.ErrorsBySeverity {
		em.ErrorsBySeverity[i] = &atomic.Uint64{}
	}
	
	return em
}

func (em *ErrorMetrics) RecordError(err *OtedamaError) {
	em.TotalErrors.Add(1)
	
	// Record by category
	em.mu.Lock()
	if _, exists := em.ErrorsByCategory[err.Category]; !exists {
		em.ErrorsByCategory[err.Category] = &atomic.Uint64{}
	}
	em.mu.Unlock()
	
	em.ErrorsByCategory[err.Category].Add(1)
	
	// Record by severity
	if err.Severity >= 1 && err.Severity <= 4 {
		em.ErrorsBySeverity[err.Severity].Add(1)
	}
}

// GetStats returns error statistics
func (em *ErrorMetrics) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_errors":      em.TotalErrors.Load(),
		"recovery_attempts": em.RecoveryAttempts.Load(),
		"recovery_success":  em.RecoverySuccess.Load(),
	}
	
	// Errors by category
	categoryStats := make(map[string]uint64)
	em.mu.RLock()
	for category, counter := range em.ErrorsByCategory {
		categoryStats[category] = counter.Load()
	}
	em.mu.RUnlock()
	stats["errors_by_category"] = categoryStats
	
	// Errors by severity
	severityStats := make(map[string]uint64)
	severityNames := []string{"", "low", "medium", "high", "critical"}
	for i := 1; i <= 4; i++ {
		severityStats[severityNames[i]] = em.ErrorsBySeverity[i].Load()
	}
	stats["errors_by_severity"] = severityStats
	
	return stats
}

// Utility functions

// WrapError wraps a standard error in OtedamaError
func WrapError(err error) *OtedamaError {
	if err == nil {
		return nil
	}
	
	// Check if already OtedamaError
	var otedamaErr *OtedamaError
	if errors.As(err, &otedamaErr) {
		return otedamaErr
	}
	
	// Categorize error
	category := ErrorCategoryInternal
	severity := ErrorSeverityMedium
	retryable := false
	
	// Analyze error type
	switch {
	case errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled):
		category = ErrorCategoryInternal
		severity = ErrorSeverityLow
		retryable = true
	case strings.Contains(err.Error(), "network") || strings.Contains(err.Error(), "connection"):
		category = ErrorCategoryNetwork
		severity = ErrorSeverityMedium
		retryable = true
	case strings.Contains(err.Error(), "storage") || strings.Contains(err.Error(), "disk"):
		category = ErrorCategoryStorage
		severity = ErrorSeverityHigh
	}
	
	otedamaErr = NewError("WRAPPED", err.Error(), category, severity)
	otedamaErr.Cause = err
	if retryable {
		otedamaErr.WithRetry(time.Second)
	}
	
	return otedamaErr
}

func getStackTrace(skip int) string {
	var builder strings.Builder
	
	for i := skip; i < skip+10; i++ {
		pc, file, line, ok := runtime.Caller(i)
		if !ok {
			break
		}
		
		fn := runtime.FuncForPC(pc)
		if fn == nil {
			continue
		}
		
		builder.WriteString(fmt.Sprintf("\n  %s:%d %s", file, line, fn.Name()))
	}
	
	return builder.String()
}

// PanicRecovery recovers from panics
func PanicRecovery(logger *zap.Logger) {
	if r := recover(); r != nil {
		stack := make([]byte, 8192)
		n := runtime.Stack(stack, false)
		
		logger.Error("Panic recovered",
			zap.Any("panic", r),
			zap.String("stack", string(stack[:n])))
		
		// Create error for handling
		err := NewError("PANIC", fmt.Sprintf("panic: %v", r), ErrorCategoryInternal, ErrorSeverityCritical)
		err.Context["stack"] = string(stack[:n])
		
		// Could send to error reporting service
	}
}

// RetryWithBackoff retries an operation with exponential backoff
func RetryWithBackoff(ctx context.Context, operation func() error, maxRetries int, initialDelay time.Duration) error {
	delay := initialDelay
	
	for i := 0; i < maxRetries; i++ {
		err := operation()
		if err == nil {
			return nil
		}
		
		// Check if error is retryable
		var otedamaErr *OtedamaError
		if errors.As(err, &otedamaErr) && !otedamaErr.IsRetryable() {
			return err
		}
		
		if i < maxRetries-1 {
			select {
			case <-time.After(delay):
				delay *= 2
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	
	return fmt.Errorf("operation failed after %d retries", maxRetries)
}