package core

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
)

// EnterpriseRecoveryManager provides national-level reliability and recovery.
// Follows John Carmack's principle of explicit error handling with minimal overhead.
type EnterpriseRecoveryManager struct {
	logger *zap.Logger
	
	// Component registry
	components map[string]*ComponentState
	compMu     sync.RWMutex
	
	// Recovery strategies
	strategies map[string]RecoveryStrategy
	stratMu    sync.RWMutex
	
	// Health checks
	healthChecks []HealthCheck
	checkMu      sync.RWMutex
	
	// Circuit breakers for preventing cascading failures
	breakers map[string]*CircuitBreaker
	breakMu  sync.RWMutex
	
	// Recovery statistics
	stats struct {
		recoveryAttempts  atomic.Uint64
		recoverySuccesses atomic.Uint64
		recoveryFailures  atomic.Uint64
		lastRecoveryTime  atomic.Int64
	}
	
	// Control
	running atomic.Bool
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// ComponentState tracks component health and recovery state
type ComponentState struct {
	Name           string
	Component      common.Component
	LastHealthy    time.Time
	FailureCount   int32
	RecoveryCount  int32
	CircuitBreaker *CircuitBreaker
	Strategy       RecoveryStrategy
}

// RecoveryStrategy defines how to recover a component
type RecoveryStrategy interface {
	Recover(ctx context.Context, component common.Component) error
	Name() string
	MaxRetries() int
	RetryDelay() time.Duration
}

// HealthCheck performs health validation
type HealthCheck struct {
	Name     string
	Interval time.Duration
	Timeout  time.Duration
	Critical bool
	Check    func(ctx context.Context) error
}

// CircuitBreaker prevents repeated recovery attempts
type CircuitBreaker struct {
	name          string
	maxFailures   int32
	resetTimeout  time.Duration
	failureCount  atomic.Int32
	lastFailTime  atomic.Int64
	state         atomic.Int32 // 0=closed, 1=open, 2=half-open
}

// CircuitBreaker states
const (
	CircuitClosed = iota
	CircuitOpen
	CircuitHalfOpen
)

// NewEnterpriseRecoveryManager creates a new recovery manager
func NewEnterpriseRecoveryManager(logger *zap.Logger) *EnterpriseRecoveryManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	manager := &EnterpriseRecoveryManager{
		logger:       logger,
		components:   make(map[string]*ComponentState),
		strategies:   make(map[string]RecoveryStrategy),
		breakers:     make(map[string]*CircuitBreaker),
		healthChecks: make([]HealthCheck, 0),
		ctx:          ctx,
		cancel:       cancel,
	}
	
	// Register default strategies
	manager.registerDefaultStrategies()
	
	return manager
}

// Start starts the recovery manager
func (m *EnterpriseRecoveryManager) Start() error {
	if !m.running.CompareAndSwap(false, true) {
		return errors.New("recovery manager already running")
	}
	
	m.logger.Info("Starting enterprise recovery manager")
	
	// Start health monitoring
	m.wg.Add(1)
	go m.healthMonitor()
	
	// Start recovery processor
	m.wg.Add(1)
	go m.recoveryProcessor()
	
	// Start metrics collector
	m.wg.Add(1)
	go m.metricsCollector()
	
	return nil
}

// Stop stops the recovery manager
func (m *EnterpriseRecoveryManager) Stop() error {
	if !m.running.CompareAndSwap(true, false) {
		return errors.New("recovery manager not running")
	}
	
	m.logger.Info("Stopping enterprise recovery manager")
	
	m.cancel()
	m.wg.Wait()
	
	return nil
}

// RegisterComponent registers a component for monitoring
func (m *EnterpriseRecoveryManager) RegisterComponent(component common.Component, strategy string) error {
	m.compMu.Lock()
	defer m.compMu.Unlock()
	
	m.stratMu.RLock()
	strat, ok := m.strategies[strategy]
	m.stratMu.RUnlock()
	
	if !ok {
		return fmt.Errorf("unknown strategy: %s", strategy)
	}
	
	name := component.Name()
	
	// Create circuit breaker for component
	breaker := &CircuitBreaker{
		name:         name,
		maxFailures:  3,
		resetTimeout: 5 * time.Minute,
	}
	
	m.components[name] = &ComponentState{
		Name:           name,
		Component:      component,
		LastHealthy:    time.Now(),
		CircuitBreaker: breaker,
		Strategy:       strat,
	}
	
	m.breakMu.Lock()
	m.breakers[name] = breaker
	m.breakMu.Unlock()
	
	m.logger.Info("Component registered for recovery",
		zap.String("component", name),
		zap.String("strategy", strategy),
	)
	
	return nil
}

// RegisterHealthCheck adds a health check
func (m *EnterpriseRecoveryManager) RegisterHealthCheck(check HealthCheck) {
	m.checkMu.Lock()
	defer m.checkMu.Unlock()
	
	m.healthChecks = append(m.healthChecks, check)
	
	m.logger.Info("Health check registered",
		zap.String("name", check.Name),
		zap.Duration("interval", check.Interval),
		zap.Bool("critical", check.Critical),
	)
}

// RegisterStrategy registers a recovery strategy
func (m *EnterpriseRecoveryManager) RegisterStrategy(name string, strategy RecoveryStrategy) {
	m.stratMu.Lock()
	defer m.stratMu.Unlock()
	
	m.strategies[name] = strategy
	
	m.logger.Info("Recovery strategy registered", zap.String("name", name))
}

// RecoverComponent manually triggers component recovery
func (m *EnterpriseRecoveryManager) RecoverComponent(componentName string) error {
	m.compMu.RLock()
	state, ok := m.components[componentName]
	m.compMu.RUnlock()
	
	if !ok {
		return fmt.Errorf("component not found: %s", componentName)
	}
	
	return m.performRecovery(state)
}

// GetRecoveryStats returns recovery statistics
func (m *EnterpriseRecoveryManager) GetRecoveryStats() map[string]interface{} {
	lastRecovery := m.stats.lastRecoveryTime.Load()
	var lastRecoveryTime *time.Time
	if lastRecovery > 0 {
		t := time.Unix(lastRecovery, 0)
		lastRecoveryTime = &t
	}
	
	return map[string]interface{}{
		"recovery_attempts":  m.stats.recoveryAttempts.Load(),
		"recovery_successes": m.stats.recoverySuccesses.Load(),
		"recovery_failures":  m.stats.recoveryFailures.Load(),
		"last_recovery_time": lastRecoveryTime,
		"components":         m.getComponentStats(),
	}
}

// Private methods

func (m *EnterpriseRecoveryManager) registerDefaultStrategies() {
	// Simple restart strategy
	m.RegisterStrategy("restart", &RestartStrategy{
		maxRetries: 3,
		retryDelay: 5 * time.Second,
	})
	
	// Exponential backoff strategy
	m.RegisterStrategy("exponential", &ExponentialBackoffStrategy{
		initialDelay: time.Second,
		maxDelay:     time.Minute,
		maxRetries:   5,
	})
	
	// Graceful degradation strategy
	m.RegisterStrategy("graceful", &GracefulDegradationStrategy{
		fallbackMode: true,
		maxRetries:   2,
	})
}

func (m *EnterpriseRecoveryManager) healthMonitor() {
	defer m.wg.Done()
	
	// Create ticker for each health check
	timers := make(map[string]*time.Ticker)
	defer func() {
		for _, timer := range timers {
			timer.Stop()
		}
	}()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		default:
			m.checkMu.RLock()
			checks := make([]HealthCheck, len(m.healthChecks))
			copy(checks, m.healthChecks)
			m.checkMu.RUnlock()
			
			for _, check := range checks {
				if _, exists := timers[check.Name]; !exists {
					timers[check.Name] = time.NewTicker(check.Interval)
					go m.runHealthCheck(check, timers[check.Name])
				}
			}
			
			time.Sleep(10 * time.Second)
		}
	}
}

func (m *EnterpriseRecoveryManager) runHealthCheck(check HealthCheck, ticker *time.Ticker) {
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(m.ctx, check.Timeout)
			err := check.Check(ctx)
			cancel()
			
			if err != nil {
				m.logger.Warn("Health check failed",
					zap.String("check", check.Name),
					zap.Error(err),
					zap.Bool("critical", check.Critical),
				)
				
				if check.Critical {
					m.handleCriticalFailure(check.Name, err)
				}
			}
		}
	}
}

func (m *EnterpriseRecoveryManager) recoveryProcessor() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.checkComponentHealth()
		}
	}
}

func (m *EnterpriseRecoveryManager) checkComponentHealth() {
	m.compMu.RLock()
	components := make([]*ComponentState, 0, len(m.components))
	for _, state := range m.components {
		components = append(components, state)
	}
	m.compMu.RUnlock()
	
	for _, state := range components {
		health := state.Component.Health()
		
		if !health.Healthy {
			m.logger.Warn("Component unhealthy",
				zap.String("component", state.Name),
				zap.String("message", health.Message),
			)
			
			// Check circuit breaker
			if state.CircuitBreaker.CanAttempt() {
				if err := m.performRecovery(state); err != nil {
					m.logger.Error("Recovery failed",
						zap.String("component", state.Name),
						zap.Error(err),
					)
				}
			}
		} else {
			// Update last healthy time
			state.LastHealthy = time.Now()
			state.CircuitBreaker.RecordSuccess()
		}
	}
}

func (m *EnterpriseRecoveryManager) performRecovery(state *ComponentState) error {
	m.stats.recoveryAttempts.Add(1)
	
	m.logger.Info("Attempting component recovery",
		zap.String("component", state.Name),
		zap.String("strategy", state.Strategy.Name()),
	)
	
	// Create recovery context with timeout
	ctx, cancel := context.WithTimeout(m.ctx, 5*time.Minute)
	defer cancel()
	
	// Execute recovery strategy
	err := state.Strategy.Recover(ctx, state.Component)
	
	if err != nil {
		m.stats.recoveryFailures.Add(1)
		state.CircuitBreaker.RecordFailure()
		atomic.AddInt32(&state.FailureCount, 1)
		return err
	}
	
	// Verify component is healthy
	health := state.Component.Health()
	if !health.Healthy {
		m.stats.recoveryFailures.Add(1)
		state.CircuitBreaker.RecordFailure()
		return fmt.Errorf("component still unhealthy after recovery: %s", health.Message)
	}
	
	m.stats.recoverySuccesses.Add(1)
	m.stats.lastRecoveryTime.Store(time.Now().Unix())
	state.CircuitBreaker.RecordSuccess()
	atomic.AddInt32(&state.RecoveryCount, 1)
	
	m.logger.Info("Component recovered successfully",
		zap.String("component", state.Name),
		zap.Int32("recovery_count", atomic.LoadInt32(&state.RecoveryCount)),
	)
	
	return nil
}

func (m *EnterpriseRecoveryManager) handleCriticalFailure(checkName string, err error) {
	m.logger.Error("Critical health check failure",
		zap.String("check", checkName),
		zap.Error(err),
	)
	
	// TODO: Implement critical failure handling
	// - Alert operators
	// - Trigger emergency shutdown if necessary
	// - Save state for forensics
}

func (m *EnterpriseRecoveryManager) metricsCollector() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			stats := m.GetRecoveryStats()
			m.logger.Debug("Recovery statistics",
				zap.Any("stats", stats),
			)
		}
	}
}

func (m *EnterpriseRecoveryManager) getComponentStats() []map[string]interface{} {
	m.compMu.RLock()
	defer m.compMu.RUnlock()
	
	stats := make([]map[string]interface{}, 0, len(m.components))
	
	for _, state := range m.components {
		stats = append(stats, map[string]interface{}{
			"name":           state.Name,
			"healthy":        state.Component.Health().Healthy,
			"last_healthy":   state.LastHealthy,
			"failure_count":  atomic.LoadInt32(&state.FailureCount),
			"recovery_count": atomic.LoadInt32(&state.RecoveryCount),
			"breaker_state":  state.CircuitBreaker.State(),
		})
	}
	
	return stats
}

// Circuit Breaker implementation

func (cb *CircuitBreaker) CanAttempt() bool {
	state := cb.state.Load()
	
	switch state {
	case CircuitClosed:
		return true
	case CircuitOpen:
		// Check if enough time has passed to try again
		lastFail := cb.lastFailTime.Load()
		if time.Since(time.Unix(lastFail, 0)) > cb.resetTimeout {
			cb.state.Store(CircuitHalfOpen)
			return true
		}
		return false
	case CircuitHalfOpen:
		return true
	default:
		return false
	}
}

func (cb *CircuitBreaker) RecordSuccess() {
	cb.failureCount.Store(0)
	cb.state.Store(CircuitClosed)
}

func (cb *CircuitBreaker) RecordFailure() {
	failures := cb.failureCount.Add(1)
	cb.lastFailTime.Store(time.Now().Unix())
	
	if failures >= cb.maxFailures {
		cb.state.Store(CircuitOpen)
	}
}

func (cb *CircuitBreaker) State() string {
	switch cb.state.Load() {
	case CircuitClosed:
		return "closed"
	case CircuitOpen:
		return "open"
	case CircuitHalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// Recovery Strategy implementations

type RestartStrategy struct {
	maxRetries int
	retryDelay time.Duration
}

func (s *RestartStrategy) Name() string { return "restart" }
func (s *RestartStrategy) MaxRetries() int { return s.maxRetries }
func (s *RestartStrategy) RetryDelay() time.Duration { return s.retryDelay }

func (s *RestartStrategy) Recover(ctx context.Context, component common.Component) error {
	// Stop the component
	if err := component.Stop(ctx); err != nil {
		return fmt.Errorf("failed to stop component: %w", err)
	}
	
	// Wait before restart
	select {
	case <-time.After(s.retryDelay):
	case <-ctx.Done():
		return ctx.Err()
	}
	
	// Start the component
	if err := component.Start(ctx); err != nil {
		return fmt.Errorf("failed to start component: %w", err)
	}
	
	return nil
}

type ExponentialBackoffStrategy struct {
	initialDelay time.Duration
	maxDelay     time.Duration
	maxRetries   int
}

func (s *ExponentialBackoffStrategy) Name() string { return "exponential" }
func (s *ExponentialBackoffStrategy) MaxRetries() int { return s.maxRetries }
func (s *ExponentialBackoffStrategy) RetryDelay() time.Duration { return s.initialDelay }

func (s *ExponentialBackoffStrategy) Recover(ctx context.Context, component common.Component) error {
	delay := s.initialDelay
	
	for attempt := 0; attempt < s.maxRetries; attempt++ {
		// Try to restart
		if err := component.Stop(ctx); err != nil {
			return fmt.Errorf("failed to stop component: %w", err)
		}
		
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
		
		if err := component.Start(ctx); err == nil {
			return nil
		}
		
		// Exponential backoff
		delay *= 2
		if delay > s.maxDelay {
			delay = s.maxDelay
		}
	}
	
	return fmt.Errorf("exceeded maximum retry attempts")
}

type GracefulDegradationStrategy struct {
	fallbackMode bool
	maxRetries   int
}

func (s *GracefulDegradationStrategy) Name() string { return "graceful" }
func (s *GracefulDegradationStrategy) MaxRetries() int { return s.maxRetries }
func (s *GracefulDegradationStrategy) RetryDelay() time.Duration { return 10 * time.Second }

func (s *GracefulDegradationStrategy) Recover(ctx context.Context, component common.Component) error {
	// Try normal recovery first
	if err := component.Stop(ctx); err == nil {
		if err := component.Start(ctx); err == nil {
			return nil
		}
	}
	
	// If normal recovery fails, enable fallback mode
	if degradable, ok := component.(interface{ EnableFallbackMode() error }); ok {
		return degradable.EnableFallbackMode()
	}
	
	return fmt.Errorf("component does not support graceful degradation")
}

// PanicHandler provides panic recovery
func PanicHandler(logger *zap.Logger, componentName string) {
	if r := recover(); r != nil {
		// Get stack trace
		buf := make([]byte, 4096)
		n := runtime.Stack(buf, false)
		stackTrace := string(buf[:n])
		
		logger.Error("Panic recovered",
			zap.String("component", componentName),
			zap.Any("panic", r),
			zap.String("stack", stackTrace),
		)
		
		// TODO: Send alert to operators
	}
}

// WithRecovery wraps a function with panic recovery
func WithRecovery(logger *zap.Logger, componentName string, fn func()) {
	defer PanicHandler(logger, componentName)
	fn()
}