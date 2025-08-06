package monitoring

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/core"
	"go.uber.org/zap"
)

// AutoRecoverySystem provides comprehensive auto-recovery capabilities
type AutoRecoverySystem struct {
	logger *zap.Logger
	
	// Components to monitor
	components map[string]Component
	mu         sync.RWMutex
	
	// Recovery strategies
	strategies map[string]RecoveryStrategy
	
	// Health monitors
	healthMonitors map[string]HealthMonitor
	
	// Circuit breakers
	circuitBreakers map[string]*CircuitBreaker
	
	// Recovery state
	state struct {
		mu              sync.RWMutex
		failureCount    map[string]int
		lastFailure     map[string]time.Time
		recoveryAttempts map[string]int
		blacklist       map[string]time.Time
	}
	
	// Configuration
	config RecoveryConfig
	
	// Metrics
	metrics struct {
		totalFailures    atomic.Uint64
		totalRecoveries  atomic.Uint64
		failedRecoveries atomic.Uint64
		currentlyFailed  atomic.Int32
	}
	
	// Context
	ctx    context.Context
	cancel context.CancelFunc
}

// Component represents a system component that can be monitored and recovered
type Component interface {
	Name() string
	HealthCheck(ctx context.Context) error
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	Restart(ctx context.Context) error
	GetStatus() ComponentStatus
}

// ComponentStatus represents component health status
type ComponentStatus struct {
	Healthy       bool
	LastCheck     time.Time
	LastError     error
	Uptime        time.Duration
	RestartCount  int
	FailureCount  int
}

// RecoveryStrategy defines how to recover a failed component
type RecoveryStrategy interface {
	Name() string
	CanRecover(component Component, failure error) bool
	Recover(ctx context.Context, component Component, failure error) error
	GetPriority() int
}

// HealthMonitor monitors component health
type HealthMonitor interface {
	Monitor(ctx context.Context, component Component) <-chan error
}

// RecoveryConfig defines recovery system configuration
type RecoveryConfig struct {
	// Monitoring
	CheckInterval    time.Duration `json:"check_interval"`
	CheckTimeout     time.Duration `json:"check_timeout"`
	
	// Recovery
	MaxRetries       int           `json:"max_retries"`
	RetryDelay       time.Duration `json:"retry_delay"`
	BackoffMultiplier float64      `json:"backoff_multiplier"`
	MaxBackoff       time.Duration `json:"max_backoff"`
	
	// Circuit breaker
	FailureThreshold int           `json:"failure_threshold"`
	RecoveryTimeout  time.Duration `json:"recovery_timeout"`
	
	// Blacklist
	BlacklistDuration time.Duration `json:"blacklist_duration"`
	
	// Strategies
	EnabledStrategies []string      `json:"enabled_strategies"`
}

// NewAutoRecoverySystem creates a new auto-recovery system
func NewAutoRecoverySystem(logger *zap.Logger, config RecoveryConfig) *AutoRecoverySystem {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Set defaults
	if config.CheckInterval == 0 {
		config.CheckInterval = 30 * time.Second
	}
	if config.CheckTimeout == 0 {
		config.CheckTimeout = 10 * time.Second
	}
	if config.MaxRetries == 0 {
		config.MaxRetries = 3
	}
	if config.RetryDelay == 0 {
		config.RetryDelay = 5 * time.Second
	}
	if config.BackoffMultiplier == 0 {
		config.BackoffMultiplier = 2.0
	}
	if config.MaxBackoff == 0 {
		config.MaxBackoff = 5 * time.Minute
	}
	if config.FailureThreshold == 0 {
		config.FailureThreshold = 5
	}
	if config.RecoveryTimeout == 0 {
		config.RecoveryTimeout = 10 * time.Minute
	}
	if config.BlacklistDuration == 0 {
		config.BlacklistDuration = 1 * time.Hour
	}
	
	ars := &AutoRecoverySystem{
		logger:          logger,
		config:          config,
		components:      make(map[string]Component),
		strategies:      make(map[string]RecoveryStrategy),
		healthMonitors:  make(map[string]HealthMonitor),
		circuitBreakers: make(map[string]*CircuitBreaker),
		ctx:            ctx,
		cancel:         cancel,
	}
	
	// Initialize state
	ars.state.failureCount = make(map[string]int)
	ars.state.lastFailure = make(map[string]time.Time)
	ars.state.recoveryAttempts = make(map[string]int)
	ars.state.blacklist = make(map[string]time.Time)
	
	// Register default strategies
	ars.registerDefaultStrategies()
	
	return ars
}

// registerDefaultStrategies registers built-in recovery strategies
func (ars *AutoRecoverySystem) registerDefaultStrategies() {
	// Simple restart strategy
	ars.RegisterStrategy(&RestartStrategy{
		logger:   ars.logger,
		priority: 1,
	})
	
	// Graceful restart with state preservation
	ars.RegisterStrategy(&GracefulRestartStrategy{
		logger:   ars.logger,
		priority: 2,
	})
	
	// Failover strategy
	ars.RegisterStrategy(&FailoverStrategy{
		logger:   ars.logger,
		priority: 3,
	})
	
	// Resource cleanup strategy
	ars.RegisterStrategy(&ResourceCleanupStrategy{
		logger:   ars.logger,
		priority: 4,
	})
	
	// Degraded mode strategy
	ars.RegisterStrategy(&DegradedModeStrategy{
		logger:   ars.logger,
		priority: 5,
	})
}

// RegisterComponent registers a component for monitoring
func (ars *AutoRecoverySystem) RegisterComponent(component Component) error {
	ars.mu.Lock()
	defer ars.mu.Unlock()
	
	name := component.Name()
	if _, exists := ars.components[name]; exists {
		return fmt.Errorf("component %s already registered", name)
	}
	
	ars.components[name] = component
	
	// Create circuit breaker
	ars.circuitBreakers[name] = NewCircuitBreaker(
		ars.config.FailureThreshold,
		ars.config.RecoveryTimeout,
	)
	
	// Create health monitor
	ars.healthMonitors[name] = NewDefaultHealthMonitor(
		ars.logger,
		ars.config.CheckInterval,
		ars.config.CheckTimeout,
	)
	
	ars.logger.Info("Component registered for auto-recovery",
		zap.String("component", name),
	)
	
	return nil
}

// RegisterStrategy registers a recovery strategy
func (ars *AutoRecoverySystem) RegisterStrategy(strategy RecoveryStrategy) {
	ars.strategies[strategy.Name()] = strategy
	
	ars.logger.Info("Recovery strategy registered",
		zap.String("strategy", strategy.Name()),
		zap.Int("priority", strategy.GetPriority()),
	)
}

// Start starts the auto-recovery system
func (ars *AutoRecoverySystem) Start() error {
	ars.logger.Info("Starting auto-recovery system")
	
	// Start monitoring each component
	ars.mu.RLock()
	components := make(map[string]Component)
	for name, comp := range ars.components {
		components[name] = comp
	}
	ars.mu.RUnlock()
	
	for name, component := range components {
		go ars.monitorComponent(name, component)
	}
	
	// Start metrics reporter
	go ars.reportMetrics()
	
	// Start blacklist cleaner
	go ars.cleanupBlacklist()
	
	return nil
}

// Stop stops the auto-recovery system
func (ars *AutoRecoverySystem) Stop() error {
	ars.logger.Info("Stopping auto-recovery system")
	ars.cancel()
	return nil
}

// monitorComponent monitors a single component
func (ars *AutoRecoverySystem) monitorComponent(name string, component Component) {
	monitor := ars.healthMonitors[name]
	errorChan := monitor.Monitor(ars.ctx, component)
	
	for {
		select {
		case err := <-errorChan:
			if err != nil {
				ars.handleComponentFailure(name, component, err)
			}
			
		case <-ars.ctx.Done():
			return
		}
	}
}

// handleComponentFailure handles component failure
func (ars *AutoRecoverySystem) handleComponentFailure(name string, component Component, failure error) {
	ars.logger.Error("Component failure detected",
		zap.String("component", name),
		zap.Error(failure),
	)
	
	// Update metrics
	ars.metrics.totalFailures.Add(1)
	ars.metrics.currentlyFailed.Add(1)
	defer ars.metrics.currentlyFailed.Add(-1)
	
	// Check if component is blacklisted
	if ars.isBlacklisted(name) {
		ars.logger.Warn("Component is blacklisted, skipping recovery",
			zap.String("component", name),
		)
		return
	}
	
	// Check circuit breaker
	breaker := ars.circuitBreakers[name]
	if !breaker.CanExecute() {
		ars.logger.Warn("Circuit breaker is open, skipping recovery",
			zap.String("component", name),
		)
		return
	}
	
	// Update failure state
	ars.updateFailureState(name)
	
	// Attempt recovery
	recovered := false
	err := breaker.Execute(func() error {
		return ars.attemptRecovery(name, component, failure)
	})
	
	if err == nil {
		recovered = true
		ars.metrics.totalRecoveries.Add(1)
		ars.resetFailureState(name)
		
		ars.logger.Info("Component recovered successfully",
			zap.String("component", name),
		)
	} else {
		ars.metrics.failedRecoveries.Add(1)
		
		ars.logger.Error("Component recovery failed",
			zap.String("component", name),
			zap.Error(err),
		)
		
		// Check if should blacklist
		if ars.shouldBlacklist(name) {
			ars.blacklistComponent(name)
		}
	}
}

// attemptRecovery attempts to recover a failed component
func (ars *AutoRecoverySystem) attemptRecovery(name string, component Component, failure error) error {
	ctx, cancel := context.WithTimeout(ars.ctx, 5*time.Minute)
	defer cancel()
	
	// Get sorted strategies by priority
	strategies := ars.getSortedStrategies()
	
	// Try each strategy
	for _, strategy := range strategies {
		if !ars.isStrategyEnabled(strategy.Name()) {
			continue
		}
		
		if strategy.CanRecover(component, failure) {
			ars.logger.Info("Attempting recovery with strategy",
				zap.String("component", name),
				zap.String("strategy", strategy.Name()),
			)
			
			err := ars.executeRecoveryWithRetries(ctx, strategy, component, failure)
			if err == nil {
				return nil
			}
			
			ars.logger.Warn("Recovery strategy failed",
				zap.String("component", name),
				zap.String("strategy", strategy.Name()),
				zap.Error(err),
			)
		}
	}
	
	return fmt.Errorf("all recovery strategies failed")
}

// executeRecoveryWithRetries executes recovery with retries
func (ars *AutoRecoverySystem) executeRecoveryWithRetries(
	ctx context.Context,
	strategy RecoveryStrategy,
	component Component,
	failure error,
) error {
	delay := ars.config.RetryDelay
	
	for attempt := 1; attempt <= ars.config.MaxRetries; attempt++ {
		// Attempt recovery
		err := strategy.Recover(ctx, component, failure)
		if err == nil {
			return nil
		}
		
		if attempt < ars.config.MaxRetries {
			ars.logger.Debug("Recovery attempt failed, retrying",
				zap.String("component", component.Name()),
				zap.Int("attempt", attempt),
				zap.Duration("delay", delay),
			)
			
			// Wait before retry
			select {
			case <-time.After(delay):
				// Exponential backoff
				delay = time.Duration(float64(delay) * ars.config.BackoffMultiplier)
				if delay > ars.config.MaxBackoff {
					delay = ars.config.MaxBackoff
				}
				
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	
	return fmt.Errorf("recovery failed after %d attempts", ars.config.MaxRetries)
}

// getSortedStrategies returns strategies sorted by priority
func (ars *AutoRecoverySystem) getSortedStrategies() []RecoveryStrategy {
	strategies := make([]RecoveryStrategy, 0, len(ars.strategies))
	
	for _, strategy := range ars.strategies {
		strategies = append(strategies, strategy)
	}
	
	// Sort by priority (lower number = higher priority)
	for i := 0; i < len(strategies)-1; i++ {
		for j := i + 1; j < len(strategies); j++ {
			if strategies[i].GetPriority() > strategies[j].GetPriority() {
				strategies[i], strategies[j] = strategies[j], strategies[i]
			}
		}
	}
	
	return strategies
}

// isStrategyEnabled checks if a strategy is enabled
func (ars *AutoRecoverySystem) isStrategyEnabled(name string) bool {
	if len(ars.config.EnabledStrategies) == 0 {
		return true // All enabled if none specified
	}
	
	for _, enabled := range ars.config.EnabledStrategies {
		if enabled == name {
			return true
		}
	}
	
	return false
}

// updateFailureState updates component failure state
func (ars *AutoRecoverySystem) updateFailureState(name string) {
	ars.state.mu.Lock()
	defer ars.state.mu.Unlock()
	
	ars.state.failureCount[name]++
	ars.state.lastFailure[name] = time.Now()
	ars.state.recoveryAttempts[name]++
}

// resetFailureState resets component failure state
func (ars *AutoRecoverySystem) resetFailureState(name string) {
	ars.state.mu.Lock()
	defer ars.state.mu.Unlock()
	
	delete(ars.state.failureCount, name)
	delete(ars.state.lastFailure, name)
	delete(ars.state.recoveryAttempts, name)
}

// shouldBlacklist determines if component should be blacklisted
func (ars *AutoRecoverySystem) shouldBlacklist(name string) bool {
	ars.state.mu.RLock()
	defer ars.state.mu.RUnlock()
	
	failureCount := ars.state.failureCount[name]
	recoveryAttempts := ars.state.recoveryAttempts[name]
	
	// Blacklist if too many failures or recovery attempts
	return failureCount > ars.config.FailureThreshold*2 ||
		recoveryAttempts > ars.config.MaxRetries*3
}

// blacklistComponent blacklists a component
func (ars *AutoRecoverySystem) blacklistComponent(name string) {
	ars.state.mu.Lock()
	defer ars.state.mu.Unlock()
	
	ars.state.blacklist[name] = time.Now().Add(ars.config.BlacklistDuration)
	
	ars.logger.Error("Component blacklisted due to repeated failures",
		zap.String("component", name),
		zap.Duration("duration", ars.config.BlacklistDuration),
	)
}

// isBlacklisted checks if component is blacklisted
func (ars *AutoRecoverySystem) isBlacklisted(name string) bool {
	ars.state.mu.RLock()
	defer ars.state.mu.RUnlock()
	
	blacklistUntil, exists := ars.state.blacklist[name]
	if !exists {
		return false
	}
	
	return time.Now().Before(blacklistUntil)
}

// cleanupBlacklist periodically removes expired blacklist entries
func (ars *AutoRecoverySystem) cleanupBlacklist() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ars.state.mu.Lock()
			now := time.Now()
			for name, until := range ars.state.blacklist {
				if now.After(until) {
					delete(ars.state.blacklist, name)
					ars.logger.Info("Component removed from blacklist",
						zap.String("component", name),
					)
				}
			}
			ars.state.mu.Unlock()
			
		case <-ars.ctx.Done():
			return
		}
	}
}

// reportMetrics periodically reports recovery metrics
func (ars *AutoRecoverySystem) reportMetrics() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ars.logger.Info("Auto-recovery metrics",
				zap.Uint64("total_failures", ars.metrics.totalFailures.Load()),
				zap.Uint64("total_recoveries", ars.metrics.totalRecoveries.Load()),
				zap.Uint64("failed_recoveries", ars.metrics.failedRecoveries.Load()),
				zap.Int32("currently_failed", ars.metrics.currentlyFailed.Load()),
			)
			
		case <-ars.ctx.Done():
			return
		}
	}
}

// GetComponentStatus returns status of a component
func (ars *AutoRecoverySystem) GetComponentStatus(name string) (ComponentStatus, bool) {
	ars.mu.RLock()
	component, exists := ars.components[name]
	ars.mu.RUnlock()
	
	if !exists {
		return ComponentStatus{}, false
	}
	
	status := component.GetStatus()
	
	// Add recovery information
	ars.state.mu.RLock()
	status.FailureCount = ars.state.failureCount[name]
	status.RestartCount = ars.state.recoveryAttempts[name]
	ars.state.mu.RUnlock()
	
	return status, true
}

// GetAllComponentStatuses returns status of all components
func (ars *AutoRecoverySystem) GetAllComponentStatuses() map[string]ComponentStatus {
	ars.mu.RLock()
	defer ars.mu.RUnlock()
	
	statuses := make(map[string]ComponentStatus)
	
	for name, component := range ars.components {
		status, _ := ars.GetComponentStatus(name)
		statuses[name] = status
	}
	
	return statuses
}

// Built-in recovery strategies

// RestartStrategy performs simple component restart
type RestartStrategy struct {
	logger   *zap.Logger
	priority int
}

func (rs *RestartStrategy) Name() string { return "restart" }
func (rs *RestartStrategy) GetPriority() int { return rs.priority }

func (rs *RestartStrategy) CanRecover(component Component, failure error) bool {
	// Can attempt restart for most failures
	return true
}

func (rs *RestartStrategy) Recover(ctx context.Context, component Component, failure error) error {
	return component.Restart(ctx)
}

// GracefulRestartStrategy performs graceful restart with state preservation
type GracefulRestartStrategy struct {
	logger   *zap.Logger
	priority int
}

func (grs *GracefulRestartStrategy) Name() string { return "graceful_restart" }
func (grs *GracefulRestartStrategy) GetPriority() int { return grs.priority }

func (grs *GracefulRestartStrategy) CanRecover(component Component, failure error) bool {
	// Check if component supports graceful restart
	_, ok := component.(GracefulComponent)
	return ok
}

func (grs *GracefulRestartStrategy) Recover(ctx context.Context, component Component, failure error) error {
	graceful, ok := component.(GracefulComponent)
	if !ok {
		return fmt.Errorf("component does not support graceful restart")
	}
	
	// Save state
	state, err := graceful.SaveState(ctx)
	if err != nil {
		grs.logger.Warn("Failed to save component state", zap.Error(err))
	}
	
	// Stop gracefully
	if err := component.Stop(ctx); err != nil {
		return fmt.Errorf("graceful stop failed: %w", err)
	}
	
	// Wait a moment
	time.Sleep(2 * time.Second)
	
	// Start with state
	if err := component.Start(ctx); err != nil {
		return fmt.Errorf("start failed: %w", err)
	}
	
	// Restore state if saved
	if state != nil {
		if err := graceful.RestoreState(ctx, state); err != nil {
			grs.logger.Warn("Failed to restore component state", zap.Error(err))
		}
	}
	
	return nil
}

// GracefulComponent supports graceful restart with state
type GracefulComponent interface {
	Component
	SaveState(ctx context.Context) (interface{}, error)
	RestoreState(ctx context.Context, state interface{}) error
}

// Additional strategy implementations...

// DefaultHealthMonitor provides default health monitoring
type DefaultHealthMonitor struct {
	logger        *zap.Logger
	checkInterval time.Duration
	checkTimeout  time.Duration
}

func NewDefaultHealthMonitor(logger *zap.Logger, interval, timeout time.Duration) *DefaultHealthMonitor {
	return &DefaultHealthMonitor{
		logger:        logger,
		checkInterval: interval,
		checkTimeout:  timeout,
	}
}

func (dhm *DefaultHealthMonitor) Monitor(ctx context.Context, component Component) <-chan error {
	errorChan := make(chan error, 1)
	
	go func() {
		ticker := time.NewTicker(dhm.checkInterval)
		defer ticker.Stop()
		defer close(errorChan)
		
		for {
			select {
			case <-ticker.C:
				checkCtx, cancel := context.WithTimeout(ctx, dhm.checkTimeout)
				err := component.HealthCheck(checkCtx)
				cancel()
				
				if err != nil {
					select {
					case errorChan <- err:
					case <-ctx.Done():
						return
					}
				}
				
			case <-ctx.Done():
				return
			}
		}
	}()
	
	return errorChan
}

// FailoverStrategy, ResourceCleanupStrategy, DegradedModeStrategy implementations would follow similar patterns...