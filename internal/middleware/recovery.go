package middleware

import (
	"fmt"
	"net/http"
	"runtime/debug"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// RecoveryMiddleware provides panic recovery for HTTP handlers
type RecoveryMiddleware struct {
	logger         *zap.Logger
	onPanic        PanicHandler
	includeStack   bool
	
	// Stats
	panicsRecovered atomic.Uint64
}

// PanicHandler handles panics in HTTP handlers
type PanicHandler func(w http.ResponseWriter, r *http.Request, err interface{}, stack []byte)

// NewRecoveryMiddleware creates recovery middleware
func NewRecoveryMiddleware(logger *zap.Logger) *RecoveryMiddleware {
	return &RecoveryMiddleware{
		logger:       logger,
		includeStack: true,
		onPanic:      defaultPanicHandler(logger),
	}
}

// Middleware returns the HTTP middleware function
func (rm *RecoveryMiddleware) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if err := recover(); err != nil {
				rm.panicsRecovered.Add(1)
				
				// Get stack trace
				stack := debug.Stack()
				
				// Log the panic
				rm.logger.Error("HTTP handler panic",
					zap.String("method", r.Method),
					zap.String("path", r.URL.Path),
					zap.String("remote", r.RemoteAddr),
					zap.Any("error", err),
					zap.String("stack", string(stack)))
				
				// Call panic handler
				rm.onPanic(w, r, err, stack)
			}
		}()
		
		next.ServeHTTP(w, r)
	})
}

// SetPanicHandler sets a custom panic handler
func (rm *RecoveryMiddleware) SetPanicHandler(handler PanicHandler) {
	rm.onPanic = handler
}

// GetStats returns recovery statistics
func (rm *RecoveryMiddleware) GetStats() RecoveryStats {
	return RecoveryStats{
		PanicsRecovered: rm.panicsRecovered.Load(),
	}
}

// RecoveryStats contains recovery statistics
type RecoveryStats struct {
	PanicsRecovered uint64
}

// defaultPanicHandler returns the default panic handler
func defaultPanicHandler(logger *zap.Logger) PanicHandler {
	return func(w http.ResponseWriter, r *http.Request, err interface{}, stack []byte) {
		// Check if response was already written
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", "application/json")
		}
		
		w.WriteHeader(http.StatusInternalServerError)
		
		response := map[string]interface{}{
			"error":     "Internal server error",
			"message":   "An unexpected error occurred",
			"timestamp": time.Now().Unix(),
		}
		
		// Include error details in development
		if logger.Core().Enabled(zap.DebugLevel) {
			response["details"] = fmt.Sprintf("%v", err)
		}
		
		// Write error response
		w.Write([]byte(fmt.Sprintf(`{"error":"Internal server error","message":"An unexpected error occurred","timestamp":%d}`, time.Now().Unix())))
	}
}

// GoroutineRecovery provides panic recovery for goroutines
type GoroutineRecovery struct {
	logger    *zap.Logger
	onPanic   GoroutinePanicHandler
	
	// Stats
	panicsRecovered atomic.Uint64
}

// GoroutinePanicHandler handles panics in goroutines
type GoroutinePanicHandler func(err interface{}, stack []byte)

// NewGoroutineRecovery creates goroutine recovery
func NewGoroutineRecovery(logger *zap.Logger) *GoroutineRecovery {
	return &GoroutineRecovery{
		logger:  logger,
		onPanic: defaultGoroutinePanicHandler(logger),
	}
}

// Go runs a function in a goroutine with panic recovery
func (gr *GoroutineRecovery) Go(fn func()) {
	go func() {
		defer func() {
			if err := recover(); err != nil {
				gr.panicsRecovered.Add(1)
				
				// Get stack trace
				stack := debug.Stack()
				
				// Log the panic
				gr.logger.Error("Goroutine panic",
					zap.Any("error", err),
					zap.String("stack", string(stack)))
				
				// Call panic handler
				gr.onPanic(err, stack)
			}
		}()
		
		fn()
	}()
}

// GoWithContext runs a function with context in a goroutine with panic recovery
func (gr *GoroutineRecovery) GoWithContext(fn func() error, errorHandler func(error)) {
	go func() {
		defer func() {
			if err := recover(); err != nil {
				gr.panicsRecovered.Add(1)
				
				// Get stack trace
				stack := debug.Stack()
				
				// Log the panic
				gr.logger.Error("Goroutine panic",
					zap.Any("error", err),
					zap.String("stack", string(stack)))
				
				// Call panic handler
				gr.onPanic(err, stack)
				
				// Call error handler with panic as error
				if errorHandler != nil {
					errorHandler(fmt.Errorf("panic: %v", err))
				}
			}
		}()
		
		if err := fn(); err != nil && errorHandler != nil {
			errorHandler(err)
		}
	}()
}

// SetPanicHandler sets a custom panic handler
func (gr *GoroutineRecovery) SetPanicHandler(handler GoroutinePanicHandler) {
	gr.onPanic = handler
}

// GetStats returns recovery statistics
func (gr *GoroutineRecovery) GetStats() RecoveryStats {
	return RecoveryStats{
		PanicsRecovered: gr.panicsRecovered.Load(),
	}
}

// defaultGoroutinePanicHandler returns the default goroutine panic handler
func defaultGoroutinePanicHandler(logger *zap.Logger) GoroutinePanicHandler {
	return func(err interface{}, stack []byte) {
		// Default behavior is just logging (already done)
		// Could add additional actions like metrics, alerts, etc.
	}
}

// SafeExecutor provides safe execution with panic recovery
type SafeExecutor struct {
	logger         *zap.Logger
	recovery       *GoroutineRecovery
	maxConcurrent  int
	semaphore      chan struct{}
}

// NewSafeExecutor creates a safe executor
func NewSafeExecutor(logger *zap.Logger, maxConcurrent int) *SafeExecutor {
	return &SafeExecutor{
		logger:        logger,
		recovery:      NewGoroutineRecovery(logger),
		maxConcurrent: maxConcurrent,
		semaphore:     make(chan struct{}, maxConcurrent),
	}
}

// Execute executes a function safely with concurrency control
func (se *SafeExecutor) Execute(fn func() error) error {
	// Acquire semaphore
	se.semaphore <- struct{}{}
	defer func() { <-se.semaphore }()
	
	// Create error channel
	errCh := make(chan error, 1)
	
	// Execute with recovery
	se.recovery.GoWithContext(fn, func(err error) {
		select {
		case errCh <- err:
		default:
		}
	})
	
	// Wait for completion or error
	select {
	case err := <-errCh:
		return err
	case <-time.After(30 * time.Second):
		return fmt.Errorf("execution timeout")
	}
}

// ExecuteAsync executes a function asynchronously with recovery
func (se *SafeExecutor) ExecuteAsync(fn func()) {
	go func() {
		// Acquire semaphore
		se.semaphore <- struct{}{}
		defer func() { <-se.semaphore }()
		
		// Execute with recovery
		se.recovery.Go(fn)
	}()
}

// BatchRecovery provides panic recovery for batch operations
type BatchRecovery struct {
	logger    *zap.Logger
	onError   BatchErrorHandler
	
	// Stats
	batchesProcessed atomic.Uint64
	itemsProcessed   atomic.Uint64
	errorsRecovered  atomic.Uint64
}

// BatchErrorHandler handles errors in batch processing
type BatchErrorHandler func(item interface{}, err error)

// NewBatchRecovery creates batch recovery
func NewBatchRecovery(logger *zap.Logger) *BatchRecovery {
	return &BatchRecovery{
		logger:  logger,
		onError: defaultBatchErrorHandler(logger),
	}
}

// ProcessBatch processes a batch of items with individual error recovery
func (br *BatchRecovery) ProcessBatch(items []interface{}, processor func(interface{}) error) []error {
	br.batchesProcessed.Add(1)
	
	errors := make([]error, 0)
	var errorsMu sync.Mutex
	
	var wg sync.WaitGroup
	for _, item := range items {
		wg.Add(1)
		go func(item interface{}) {
			defer wg.Done()
			
			// Recover from panics
			defer func() {
				if r := recover(); r != nil {
					br.errorsRecovered.Add(1)
					
					err := fmt.Errorf("panic processing item: %v", r)
					br.logger.Error("Batch item panic",
						zap.Any("item", item),
						zap.Any("panic", r),
						zap.String("stack", string(debug.Stack())))
					
					errorsMu.Lock()
					errors = append(errors, err)
					errorsMu.Unlock()
					
					br.onError(item, err)
				}
			}()
			
			// Process item
			if err := processor(item); err != nil {
				br.errorsRecovered.Add(1)
				
				errorsMu.Lock()
				errors = append(errors, err)
				errorsMu.Unlock()
				
				br.onError(item, err)
			} else {
				br.itemsProcessed.Add(1)
			}
		}(item)
	}
	
	wg.Wait()
	return errors
}

// SetErrorHandler sets a custom error handler
func (br *BatchRecovery) SetErrorHandler(handler BatchErrorHandler) {
	br.onError = handler
}

// GetStats returns batch recovery statistics
func (br *BatchRecovery) GetStats() BatchRecoveryStats {
	return BatchRecoveryStats{
		BatchesProcessed: br.batchesProcessed.Load(),
		ItemsProcessed:   br.itemsProcessed.Load(),
		ErrorsRecovered:  br.errorsRecovered.Load(),
	}
}

// BatchRecoveryStats contains batch recovery statistics
type BatchRecoveryStats struct {
	BatchesProcessed uint64
	ItemsProcessed   uint64
	ErrorsRecovered  uint64
}

// defaultBatchErrorHandler returns the default batch error handler
func defaultBatchErrorHandler(logger *zap.Logger) BatchErrorHandler {
	return func(item interface{}, err error) {
		// Default behavior is just logging (already done)
	}
}

// CircuitBreakerMiddleware provides circuit breaker pattern for HTTP
type CircuitBreakerMiddleware struct {
	logger         *zap.Logger
	threshold      int
	timeout        time.Duration
	
	// State
	state          atomic.Int32 // 0=closed, 1=open, 2=half-open
	failures       atomic.Int32
	lastFailure    atomic.Int64
	successCount   atomic.Int32
	
	// Stats
	requestsAllowed atomic.Uint64
	requestsBlocked atomic.Uint64
}

// NewCircuitBreakerMiddleware creates circuit breaker middleware
func NewCircuitBreakerMiddleware(logger *zap.Logger, threshold int, timeout time.Duration) *CircuitBreakerMiddleware {
	return &CircuitBreakerMiddleware{
		logger:    logger,
		threshold: threshold,
		timeout:   timeout,
	}
}

// Middleware returns the HTTP middleware function
func (cb *CircuitBreakerMiddleware) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check circuit breaker state
		if cb.isOpen() {
			cb.requestsBlocked.Add(1)
			
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"error":"Service temporarily unavailable"}`))
			return
		}
		
		cb.requestsAllowed.Add(1)
		
		// Wrap response writer to capture status
		wrapped := &responseWriter{ResponseWriter: w}
		
		// Call next handler
		next.ServeHTTP(wrapped, r)
		
		// Check response status
		if wrapped.status >= 500 {
			cb.recordFailure()
		} else {
			cb.recordSuccess()
		}
	})
}

func (cb *CircuitBreakerMiddleware) isOpen() bool {
	state := cb.state.Load()
	if state == 1 { // Open
		// Check if timeout has passed
		lastFailure := cb.lastFailure.Load()
		if time.Since(time.Unix(0, lastFailure)) > cb.timeout {
			// Transition to half-open
			cb.state.CompareAndSwap(1, 2)
			cb.successCount.Store(0)
			return false
		}
		return true
	}
	return false
}

func (cb *CircuitBreakerMiddleware) recordFailure() {
	failures := cb.failures.Add(1)
	cb.lastFailure.Store(time.Now().UnixNano())
	
	if failures >= int32(cb.threshold) {
		cb.state.Store(1) // Open
		cb.logger.Warn("Circuit breaker opened due to failures",
			zap.Int32("failures", failures))
	}
}

func (cb *CircuitBreakerMiddleware) recordSuccess() {
	state := cb.state.Load()
	
	if state == 2 { // Half-open
		success := cb.successCount.Add(1)
		if success >= 3 { // Require 3 successes to close
			cb.state.Store(0) // Closed
			cb.failures.Store(0)
			cb.logger.Info("Circuit breaker closed after recovery")
		}
	} else if state == 0 { // Closed
		// Reset failure count on success
		cb.failures.Store(0)
	}
}

// GetStats returns circuit breaker statistics
func (cb *CircuitBreakerMiddleware) GetStats() CircuitBreakerStats {
	return CircuitBreakerStats{
		State:           cb.getStateString(),
		Failures:        cb.failures.Load(),
		RequestsAllowed: cb.requestsAllowed.Load(),
		RequestsBlocked: cb.requestsBlocked.Load(),
	}
}

func (cb *CircuitBreakerMiddleware) getStateString() string {
	switch cb.state.Load() {
	case 0:
		return "closed"
	case 1:
		return "open"
	case 2:
		return "half-open"
	default:
		return "unknown"
	}
}

// CircuitBreakerStats contains circuit breaker statistics
type CircuitBreakerStats struct {
	State           string
	Failures        int32
	RequestsAllowed uint64
	RequestsBlocked uint64
}

// responseWriter wraps http.ResponseWriter to capture status
type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	if rw.status == 0 {
		rw.status = http.StatusOK
	}
	return rw.ResponseWriter.Write(b)
}