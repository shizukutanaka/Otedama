package core

import (
	"context"
	"errors"
	"fmt"
	"math"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ErrorRecoverySystem provides comprehensive error handling and recovery
// Following Rob Pike's principle of handling errors gracefully
type ErrorRecoverySystem struct {
	logger *zap.Logger
	
	// Error tracking
	errorTracker    *ErrorTracker
	errorClassifier *ErrorClassifier
	
	// Recovery strategies
	recoveryManager *RecoveryManager
	circuitBreaker  *CircuitBreakerManager
	
	// Retry mechanisms
	retryManager    *RetryManager
	backoffStrategy BackoffStrategy
	
	// Health monitoring
	healthMonitor   *HealthMonitor
	
	// Panic recovery
	panicHandler    *PanicHandler
	
	// Error reporting
	reporter        *ErrorReporter
	
	// Stats
	errorsHandled   atomic.Uint64
	recoveries      atomic.Uint64
	panicsRecovered atomic.Uint64
	
	// Configuration
	config *ErrorRecoveryConfig
}

// ErrorRecoveryConfig contains configuration for error recovery
type ErrorRecoveryConfig struct {
	// Error thresholds
	MaxErrorsPerMinute  int
	MaxConsecutiveErrors int
	
	// Recovery settings
	EnableAutoRecovery  bool
	RecoveryTimeout     time.Duration
	MaxRecoveryAttempts int
	
	// Circuit breaker settings
	CircuitBreakerThreshold int
	CircuitBreakerTimeout   time.Duration
	
	// Retry settings
	MaxRetries          int
	InitialBackoff      time.Duration
	MaxBackoff          time.Duration
	BackoffMultiplier   float64
	
	// Health check settings
	HealthCheckInterval time.Duration
	UnhealthyThreshold  int
}

// ErrorTracker tracks errors across the system
type ErrorTracker struct {
	// Error history
	errors      *RingBuffer
	errorCounts map[string]*ErrorCount
	mu          sync.RWMutex
	
	// Time windows for rate limiting
	windows     map[string]*TimeWindow
}

// ErrorClassifier classifies errors by type and severity
type ErrorClassifier struct {
	// Error patterns
	patterns    map[ErrorClass][]*ErrorPattern
	
	// Classification cache
	cache       sync.Map // map[string]ErrorClass
}

// ErrorClass represents error classification
type ErrorClass int

const (
	ErrorClassTransient ErrorClass = iota
	ErrorClassPermanent
	ErrorClassResource
	ErrorClassNetwork
	ErrorClassHardware
	ErrorClassConfiguration
	ErrorClassSecurity
	ErrorClassUnknown
)

// RecoveryManager manages recovery strategies
type RecoveryManager struct {
	logger *zap.Logger
	
	// Recovery strategies
	strategies  map[ErrorClass]RecoveryStrategy
	
	// Active recoveries
	active      sync.Map // map[string]*RecoveryState
	
	// Recovery history
	history     []*RecoveryEvent
	historyMu   sync.RWMutex
}

// RecoveryStrategy defines how to recover from errors
type RecoveryStrategy interface {
	CanRecover(err error) bool
	Recover(ctx context.Context, err error) error
	Name() string
}

// CircuitBreakerManager manages circuit breakers
type CircuitBreakerManager struct {
	breakers sync.Map // map[string]*CircuitBreaker
	config   CircuitBreakerConfig
}

// CircuitBreaker prevents cascading failures
type CircuitBreaker struct {
	name            string
	state           atomic.Int32 // 0=closed, 1=open, 2=half-open
	failures        atomic.Int32
	lastFailure     atomic.Int64
	successCount    atomic.Int32
	
	// Configuration
	threshold       int
	timeout         time.Duration
	halfOpenMax     int
}

// RetryManager manages retry logic
type RetryManager struct {
	logger     *zap.Logger
	strategies map[string]RetryStrategy
}

// HealthMonitor monitors system health
type HealthMonitor struct {
	logger *zap.Logger
	
	// Health checks
	checks      map[string]HealthCheck
	
	// Health status
	status      map[string]*HealthStatus
	statusMu    sync.RWMutex
	
	// Overall health
	healthy     atomic.Bool
}

// PanicHandler handles panic recovery
type PanicHandler struct {
	logger      *zap.Logger
	
	// Panic recovery functions
	recoverers  []PanicRecoverer
	
	// Panic history
	history     []*PanicEvent
	historyMu   sync.RWMutex
}

// ErrorReporter reports errors to external systems
type ErrorReporter struct {
	logger      *zap.Logger
	
	// Reporting destinations
	reporters   []ErrorReportDestination
	
	// Batching
	batch       []*ErrorReport
	batchMu     sync.Mutex
	batchSize   int
}

// NewErrorRecoverySystem creates an error recovery system
func NewErrorRecoverySystem(logger *zap.Logger, config *ErrorRecoveryConfig) *ErrorRecoverySystem {
	if config == nil {
		config = DefaultErrorRecoveryConfig()
	}
	
	ers := &ErrorRecoverySystem{
		logger:          logger,
		config:          config,
		errorTracker:    NewErrorTracker(),
		errorClassifier: NewErrorClassifier(),
		recoveryManager: NewRecoveryManager(logger),
		circuitBreaker:  NewCircuitBreakerManager(config),
		retryManager:    NewRetryManager(logger),
		healthMonitor:   NewHealthMonitor(logger),
		panicHandler:    NewPanicHandler(logger),
		reporter:        NewErrorReporter(logger),
		backoffStrategy: NewExponentialBackoff(config),
	}
	
	// Initialize recovery strategies
	ers.initializeRecoveryStrategies()
	
	// Start health monitoring
	go ers.healthMonitorLoop()
	
	return ers
}

// HandleError handles an error with appropriate recovery
func (ers *ErrorRecoverySystem) HandleError(ctx context.Context, err error, component string) error {
	if err == nil {
		return nil
	}
	
	ers.errorsHandled.Add(1)
	
	// Track error
	ers.errorTracker.TrackError(err, component)
	
	// Classify error
	class := ers.errorClassifier.Classify(err)
	
	// Check circuit breaker
	if ers.circuitBreaker.IsOpen(component) {
		return fmt.Errorf("circuit breaker open for %s: %w", component, err)
	}
	
	// Log error with context
	ers.logger.Error("Error occurred",
		zap.String("component", component),
		zap.String("class", class.String()),
		zap.Error(err))
	
	// Report critical errors
	if ers.shouldReport(err, class) {
		ers.reporter.Report(&ErrorReport{
			Error:     err,
			Component: component,
			Class:     class,
			Timestamp: time.Now(),
		})
	}
	
	// Attempt recovery if enabled
	if ers.config.EnableAutoRecovery {
		if recoveryErr := ers.attemptRecovery(ctx, err, component, class); recoveryErr == nil {
			ers.recoveries.Add(1)
			return nil
		}
	}
	
	// Record failure in circuit breaker
	ers.circuitBreaker.RecordFailure(component)
	
	return err
}

// WrapWithRecovery wraps a function with panic recovery
func (ers *ErrorRecoverySystem) WrapWithRecovery(fn func() error, component string) (err error) {
	defer func() {
		if r := recover(); r != nil {
			ers.panicsRecovered.Add(1)
			
			// Get stack trace
			stack := debug.Stack()
			
			// Create panic event
			event := &PanicEvent{
				Component: component,
				Value:     r,
				Stack:     string(stack),
				Timestamp: time.Now(),
			}
			
			// Handle panic
			ers.panicHandler.HandlePanic(event)
			
			// Convert to error
			err = fmt.Errorf("panic in %s: %v", component, r)
			
			// Attempt recovery
			ers.HandleError(context.Background(), err, component)
		}
	}()
	
	return fn()
}

// ExecuteWithRetry executes a function with retry logic
func (ers *ErrorRecoverySystem) ExecuteWithRetry(ctx context.Context, fn func() error, component string) error {
	return ers.retryManager.ExecuteWithRetry(ctx, fn, component, ers.config.MaxRetries)
}

// CheckHealth checks system health
func (ers *ErrorRecoverySystem) CheckHealth() *SystemHealth {
	return ers.healthMonitor.CheckHealth()
}

// GetErrorStats returns error statistics
func (ers *ErrorRecoverySystem) GetErrorStats() *ErrorStats {
	return &ErrorStats{
		TotalErrors:      ers.errorsHandled.Load(),
		RecoveriesCount:  ers.recoveries.Load(),
		PanicsRecovered:  ers.panicsRecovered.Load(),
		ErrorsByClass:    ers.errorTracker.GetErrorsByClass(),
		CircuitBreakers:  ers.circuitBreaker.GetStatus(),
		HealthStatus:     ers.healthMonitor.GetStatus(),
	}
}

// Private methods

func (ers *ErrorRecoverySystem) initializeRecoveryStrategies() {
	// Initialize default recovery strategies
	ers.recoveryManager.RegisterStrategy(ErrorClassTransient, &TransientErrorRecovery{})
	ers.recoveryManager.RegisterStrategy(ErrorClassNetwork, &NetworkErrorRecovery{})
	ers.recoveryManager.RegisterStrategy(ErrorClassResource, &ResourceErrorRecovery{})
	ers.recoveryManager.RegisterStrategy(ErrorClassHardware, &HardwareErrorRecovery{})
}

func (ers *ErrorRecoverySystem) attemptRecovery(ctx context.Context, err error, component string, class ErrorClass) error {
	return ers.recoveryManager.AttemptRecovery(ctx, err, component, class)
}

func (ers *ErrorRecoverySystem) shouldReport(err error, class ErrorClass) bool {
	// Report critical errors
	return class == ErrorClassSecurity || class == ErrorClassHardware
}

func (ers *ErrorRecoverySystem) healthMonitorLoop() {
	ticker := time.NewTicker(ers.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		ers.healthMonitor.RunChecks()
		<-ticker.C
	}
}

// Helper implementations

// DefaultErrorRecoveryConfig returns default configuration
func DefaultErrorRecoveryConfig() *ErrorRecoveryConfig {
	return &ErrorRecoveryConfig{
		MaxErrorsPerMinute:      100,
		MaxConsecutiveErrors:    10,
		EnableAutoRecovery:      true,
		RecoveryTimeout:         30 * time.Second,
		MaxRecoveryAttempts:     3,
		CircuitBreakerThreshold: 5,
		CircuitBreakerTimeout:   60 * time.Second,
		MaxRetries:              3,
		InitialBackoff:          time.Second,
		MaxBackoff:              30 * time.Second,
		BackoffMultiplier:       2.0,
		HealthCheckInterval:     10 * time.Second,
		UnhealthyThreshold:      3,
	}
}

// NewErrorTracker creates an error tracker
func NewErrorTracker() *ErrorTracker {
	return &ErrorTracker{
		errors:      NewRingBuffer(1000),
		errorCounts: make(map[string]*ErrorCount),
		windows:     make(map[string]*TimeWindow),
	}
}

func (et *ErrorTracker) TrackError(err error, component string) {
	et.mu.Lock()
	defer et.mu.Unlock()
	
	// Add to ring buffer
	et.errors.Add(&TrackedError{
		Error:     err,
		Component: component,
		Timestamp: time.Now(),
	})
	
	// Update counts
	key := fmt.Sprintf("%s:%s", component, err.Error())
	if count, exists := et.errorCounts[key]; exists {
		count.Count.Add(1)
		count.LastSeen = time.Now()
	} else {
		et.errorCounts[key] = &ErrorCount{
			FirstSeen: time.Now(),
			LastSeen:  time.Now(),
		}
		et.errorCounts[key].Count.Store(1)
	}
	
	// Update time window
	window, exists := et.windows[component]
	if !exists {
		window = NewTimeWindow(time.Minute)
		et.windows[component] = window
	}
	window.Add(1)
}

func (et *ErrorTracker) GetErrorsByClass() map[string]int {
	et.mu.RLock()
	defer et.mu.RUnlock()
	
	result := make(map[string]int)
	for key, count := range et.errorCounts {
		result[key] = int(count.Count.Load())
	}
	return result
}

// NewErrorClassifier creates an error classifier
func NewErrorClassifier() *ErrorClassifier {
	ec := &ErrorClassifier{
		patterns: make(map[ErrorClass][]*ErrorPattern),
	}
	
	// Define error patterns
	ec.patterns[ErrorClassTransient] = []*ErrorPattern{
		{Pattern: "timeout", Class: ErrorClassTransient},
		{Pattern: "temporary", Class: ErrorClassTransient},
		{Pattern: "retry", Class: ErrorClassTransient},
	}
	
	ec.patterns[ErrorClassNetwork] = []*ErrorPattern{
		{Pattern: "connection refused", Class: ErrorClassNetwork},
		{Pattern: "network unreachable", Class: ErrorClassNetwork},
		{Pattern: "no route to host", Class: ErrorClassNetwork},
	}
	
	ec.patterns[ErrorClassResource] = []*ErrorPattern{
		{Pattern: "out of memory", Class: ErrorClassResource},
		{Pattern: "disk full", Class: ErrorClassResource},
		{Pattern: "too many open files", Class: ErrorClassResource},
	}
	
	return ec
}

func (ec *ErrorClassifier) Classify(err error) ErrorClass {
	errStr := err.Error()
	
	// Check cache
	if cached, ok := ec.cache.Load(errStr); ok {
		return cached.(ErrorClass)
	}
	
	// Check patterns
	for class, patterns := range ec.patterns {
		for _, pattern := range patterns {
			if pattern.Matches(errStr) {
				ec.cache.Store(errStr, class)
				return class
			}
		}
	}
	
	// Default to unknown
	ec.cache.Store(errStr, ErrorClassUnknown)
	return ErrorClassUnknown
}

// Recovery strategy implementations

// TransientErrorRecovery handles transient errors
type TransientErrorRecovery struct{}

func (r *TransientErrorRecovery) CanRecover(err error) bool {
	return true // Can attempt recovery for all transient errors
}

func (r *TransientErrorRecovery) Recover(ctx context.Context, err error) error {
	// Simple wait and retry
	select {
	case <-time.After(time.Second):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *TransientErrorRecovery) Name() string {
	return "transient_recovery"
}

// NetworkErrorRecovery handles network errors
type NetworkErrorRecovery struct{}

func (r *NetworkErrorRecovery) CanRecover(err error) bool {
	return true
}

func (r *NetworkErrorRecovery) Recover(ctx context.Context, err error) error {
	// Reset network connections
	// Implementation would reset network state
	return nil
}

func (r *NetworkErrorRecovery) Name() string {
	return "network_recovery"
}

// ResourceErrorRecovery handles resource errors
type ResourceErrorRecovery struct{}

func (r *ResourceErrorRecovery) CanRecover(err error) bool {
	// Check if we can free resources
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.Alloc < m.Sys/2 // Can recover if using less than 50% memory
}

func (r *ResourceErrorRecovery) Recover(ctx context.Context, err error) error {
	// Force garbage collection
	runtime.GC()
	runtime.GC() // Run twice for thorough cleanup
	
	// Free OS memory
	debug.FreeOSMemory()
	
	return nil
}

func (r *ResourceErrorRecovery) Name() string {
	return "resource_recovery"
}

// HardwareErrorRecovery handles hardware errors
type HardwareErrorRecovery struct{}

func (r *HardwareErrorRecovery) CanRecover(err error) bool {
	// Hardware errors typically can't be recovered programmatically
	return false
}

func (r *HardwareErrorRecovery) Recover(ctx context.Context, err error) error {
	return errors.New("hardware errors cannot be automatically recovered")
}

func (r *HardwareErrorRecovery) Name() string {
	return "hardware_recovery"
}

// Circuit breaker implementation

// NewCircuitBreakerManager creates a circuit breaker manager
func NewCircuitBreakerManager(config *ErrorRecoveryConfig) *CircuitBreakerManager {
	return &CircuitBreakerManager{
		config: CircuitBreakerConfig{
			Threshold:   config.CircuitBreakerThreshold,
			Timeout:     config.CircuitBreakerTimeout,
			HalfOpenMax: 3,
		},
	}
}

func (cbm *CircuitBreakerManager) IsOpen(component string) bool {
	cb := cbm.getOrCreate(component)
	return cb.IsOpen()
}

func (cbm *CircuitBreakerManager) RecordFailure(component string) {
	cb := cbm.getOrCreate(component)
	cb.RecordFailure()
}

func (cbm *CircuitBreakerManager) RecordSuccess(component string) {
	cb := cbm.getOrCreate(component)
	cb.RecordSuccess()
}

func (cbm *CircuitBreakerManager) GetStatus() map[string]string {
	status := make(map[string]string)
	cbm.breakers.Range(func(key, value interface{}) bool {
		cb := value.(*CircuitBreaker)
		status[key.(string)] = cb.GetState()
		return true
	})
	return status
}

func (cbm *CircuitBreakerManager) getOrCreate(component string) *CircuitBreaker {
	cb, _ := cbm.breakers.LoadOrStore(component, &CircuitBreaker{
		name:        component,
		threshold:   cbm.config.Threshold,
		timeout:     cbm.config.Timeout,
		halfOpenMax: cbm.config.HalfOpenMax,
	})
	return cb.(*CircuitBreaker)
}

func (cb *CircuitBreaker) IsOpen() bool {
	state := cb.state.Load()
	if state == 1 { // Open
		// Check if timeout has passed
		lastFailure := cb.lastFailure.Load()
		if time.Since(time.Unix(0, lastFailure)) > cb.timeout {
			// Transition to half-open
			cb.state.CompareAndSwap(1, 2)
			return false
		}
		return true
	}
	return false
}

func (cb *CircuitBreaker) RecordFailure() {
	cb.failures.Add(1)
	cb.lastFailure.Store(time.Now().UnixNano())
	
	if cb.failures.Load() >= int32(cb.threshold) {
		cb.state.Store(1) // Open
	}
}

func (cb *CircuitBreaker) RecordSuccess() {
	state := cb.state.Load()
	if state == 2 { // Half-open
		success := cb.successCount.Add(1)
		if success >= int32(cb.halfOpenMax) {
			// Transition to closed
			cb.state.Store(0)
			cb.failures.Store(0)
			cb.successCount.Store(0)
		}
	} else if state == 0 { // Closed
		// Reset failure count on success
		cb.failures.Store(0)
	}
}

func (cb *CircuitBreaker) GetState() string {
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

// Additional helper types

type ErrorCount struct {
	Count     atomic.Uint64
	FirstSeen time.Time
	LastSeen  time.Time
}

type TrackedError struct {
	Error     error
	Component string
	Timestamp time.Time
}

type ErrorPattern struct {
	Pattern string
	Class   ErrorClass
}

func (ep *ErrorPattern) Matches(errStr string) bool {
	// Simple substring match - could use regex
	return contains(errStr, ep.Pattern)
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s[:len(substr)] == substr
}

type RecoveryState struct {
	Component string
	StartTime time.Time
	Attempts  int
	LastError error
}

type RecoveryEvent struct {
	Component string
	Error     error
	Strategy  string
	Success   bool
	Duration  time.Duration
	Timestamp time.Time
}

type CircuitBreakerConfig struct {
	Threshold   int
	Timeout     time.Duration
	HalfOpenMax int
}

type ErrorReport struct {
	Error     error
	Component string
	Class     ErrorClass
	Timestamp time.Time
}

type ErrorStats struct {
	TotalErrors      uint64
	RecoveriesCount  uint64
	PanicsRecovered  uint64
	ErrorsByClass    map[string]int
	CircuitBreakers  map[string]string
	HealthStatus     map[string]*HealthStatus
}

type PanicEvent struct {
	Component string
	Value     interface{}
	Stack     string
	Timestamp time.Time
}

type SystemHealth struct {
	Healthy     bool
	Components  map[string]*HealthStatus
	LastChecked time.Time
}

type HealthStatus struct {
	Component   string
	Healthy     bool
	LastChecked time.Time
	Errors      int
	Message     string
}

type TimeWindow struct {
	window   time.Duration
	buckets  []int64
	current  int
	mu       sync.Mutex
}

func NewTimeWindow(window time.Duration) *TimeWindow {
	buckets := int(window.Seconds())
	return &TimeWindow{
		window:  window,
		buckets: make([]int64, buckets),
	}
}

func (tw *TimeWindow) Add(count int64) {
	tw.mu.Lock()
	defer tw.mu.Unlock()
	tw.buckets[tw.current] += count
}

type RingBuffer struct {
	items []interface{}
	size  int
	head  int
	mu    sync.Mutex
}

func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{
		items: make([]interface{}, size),
		size:  size,
	}
}

func (rb *RingBuffer) Add(item interface{}) {
	rb.mu.Lock()
	defer rb.mu.Unlock()
	rb.items[rb.head] = item
	rb.head = (rb.head + 1) % rb.size
}

// String methods

func (ec ErrorClass) String() string {
	switch ec {
	case ErrorClassTransient:
		return "transient"
	case ErrorClassPermanent:
		return "permanent"
	case ErrorClassResource:
		return "resource"
	case ErrorClassNetwork:
		return "network"
	case ErrorClassHardware:
		return "hardware"
	case ErrorClassConfiguration:
		return "configuration"
	case ErrorClassSecurity:
		return "security"
	default:
		return "unknown"
	}
}

// Stub implementations for remaining components

func NewRecoveryManager(logger *zap.Logger) *RecoveryManager {
	return &RecoveryManager{
		logger:     logger,
		strategies: make(map[ErrorClass]RecoveryStrategy),
	}
}

func (rm *RecoveryManager) RegisterStrategy(class ErrorClass, strategy RecoveryStrategy) {
	rm.strategies[class] = strategy
}

func (rm *RecoveryManager) AttemptRecovery(ctx context.Context, err error, component string, class ErrorClass) error {
	strategy, exists := rm.strategies[class]
	if !exists || !strategy.CanRecover(err) {
		return fmt.Errorf("no recovery strategy for %s errors", class)
	}
	
	state := &RecoveryState{
		Component: component,
		StartTime: time.Now(),
		LastError: err,
	}
	
	rm.active.Store(component, state)
	defer rm.active.Delete(component)
	
	if err := strategy.Recover(ctx, err); err != nil {
		return err
	}
	
	// Record success
	rm.historyMu.Lock()
	rm.history = append(rm.history, &RecoveryEvent{
		Component: component,
		Error:     err,
		Strategy:  strategy.Name(),
		Success:   true,
		Duration:  time.Since(state.StartTime),
		Timestamp: time.Now(),
	})
	rm.historyMu.Unlock()
	
	return nil
}

func NewRetryManager(logger *zap.Logger) *RetryManager {
	return &RetryManager{
		logger:     logger,
		strategies: make(map[string]RetryStrategy),
	}
}

type RetryStrategy interface {
	ExecuteWithRetry(ctx context.Context, fn func() error, maxRetries int) error
}

func (rm *RetryManager) ExecuteWithRetry(ctx context.Context, fn func() error, component string, maxRetries int) error {
	var lastErr error
	
	for i := 0; i < maxRetries; i++ {
		if err := fn(); err == nil {
			return nil
		} else {
			lastErr = err
			rm.logger.Debug("Retry attempt failed",
				zap.String("component", component),
				zap.Int("attempt", i+1),
				zap.Error(err))
		}
		
		// Wait before retry
		select {
		case <-time.After(time.Duration(i+1) * time.Second):
			// Continue
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	
	return fmt.Errorf("max retries exceeded: %w", lastErr)
}

func NewHealthMonitor(logger *zap.Logger) *HealthMonitor {
	return &HealthMonitor{
		logger: logger,
		checks: make(map[string]HealthCheck),
		status: make(map[string]*HealthStatus),
	}
}

type HealthCheck interface {
	Check() error
	Name() string
}

func (hm *HealthMonitor) RegisterCheck(check HealthCheck) {
	hm.checks[check.Name()] = check
}

func (hm *HealthMonitor) RunChecks() {
	hm.statusMu.Lock()
	defer hm.statusMu.Unlock()
	
	allHealthy := true
	
	for name, check := range hm.checks {
		status := &HealthStatus{
			Component:   name,
			LastChecked: time.Now(),
		}
		
		if err := check.Check(); err != nil {
			status.Healthy = false
			status.Message = err.Error()
			status.Errors++
			allHealthy = false
		} else {
			status.Healthy = true
			status.Errors = 0
		}
		
		hm.status[name] = status
	}
	
	hm.healthy.Store(allHealthy)
}

func (hm *HealthMonitor) CheckHealth() *SystemHealth {
	hm.statusMu.RLock()
	defer hm.statusMu.RUnlock()
	
	components := make(map[string]*HealthStatus)
	for k, v := range hm.status {
		components[k] = v
	}
	
	return &SystemHealth{
		Healthy:     hm.healthy.Load(),
		Components:  components,
		LastChecked: time.Now(),
	}
}

func (hm *HealthMonitor) GetStatus() map[string]*HealthStatus {
	hm.statusMu.RLock()
	defer hm.statusMu.RUnlock()
	
	status := make(map[string]*HealthStatus)
	for k, v := range hm.status {
		status[k] = v
	}
	return status
}

func NewPanicHandler(logger *zap.Logger) *PanicHandler {
	return &PanicHandler{
		logger: logger,
	}
}

type PanicRecoverer interface {
	Recover(event *PanicEvent) error
}

func (ph *PanicHandler) HandlePanic(event *PanicEvent) {
	ph.logger.Error("Panic recovered",
		zap.String("component", event.Component),
		zap.Any("value", event.Value),
		zap.String("stack", event.Stack))
	
	// Store in history
	ph.historyMu.Lock()
	ph.history = append(ph.history, event)
	if len(ph.history) > 100 {
		ph.history = ph.history[len(ph.history)-100:]
	}
	ph.historyMu.Unlock()
	
	// Run recoverers
	for _, recoverer := range ph.recoverers {
		if err := recoverer.Recover(event); err != nil {
			ph.logger.Error("Panic recovery failed", zap.Error(err))
		}
	}
}

func NewErrorReporter(logger *zap.Logger) *ErrorReporter {
	return &ErrorReporter{
		logger:    logger,
		batchSize: 100,
	}
}

type ErrorReportDestination interface {
	Send(reports []*ErrorReport) error
}

func (er *ErrorReporter) Report(report *ErrorReport) {
	er.batchMu.Lock()
	defer er.batchMu.Unlock()
	
	er.batch = append(er.batch, report)
	
	if len(er.batch) >= er.batchSize {
		er.flush()
	}
}

func (er *ErrorReporter) flush() {
	if len(er.batch) == 0 {
		return
	}
	
	for _, reporter := range er.reporters {
		if err := reporter.Send(er.batch); err != nil {
			er.logger.Error("Failed to send error reports", zap.Error(err))
		}
	}
	
	er.batch = er.batch[:0]
}

// Backoff strategies

type BackoffStrategy interface {
	NextBackoff(attempt int) time.Duration
}

type ExponentialBackoff struct {
	initial    time.Duration
	max        time.Duration
	multiplier float64
}

func NewExponentialBackoff(config *ErrorRecoveryConfig) *ExponentialBackoff {
	return &ExponentialBackoff{
		initial:    config.InitialBackoff,
		max:        config.MaxBackoff,
		multiplier: config.BackoffMultiplier,
	}
}

func (eb *ExponentialBackoff) NextBackoff(attempt int) time.Duration {
	backoff := float64(eb.initial) * math.Pow(eb.multiplier, float64(attempt))
	if backoff > float64(eb.max) {
		return eb.max
	}
	return time.Duration(backoff)
}