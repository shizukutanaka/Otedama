package core

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
)

// ComponentStatus represents the current state of a component
type ComponentStatus int

const (
	StatusHealthy ComponentStatus = iota
	StatusDegraded
	StatusUnhealthy
	StatusRecovering
	StatusOffline
)

// ComponentState tracks the state of a system component
type ComponentState struct {
	Name           string
	Status         ComponentStatus
	LastError      error
	ErrorCount     int32
	LastCheck      time.Time
	RestartCount   int32
	CircuitBreaker *common.CircuitBreaker
	mu             sync.RWMutex
}

// RecoveryStrategy defines how to recover a failed component
type RecoveryStrategy interface {
	Recover(ctx context.Context, component *ComponentState) error
	ShouldRecover(component *ComponentState) bool
	GetPriority() int
}

// HealthCheck defines a health check function
type HealthCheck struct {
	Name      string
	Component string
	Check     func(ctx context.Context) error
	Interval  time.Duration
	Timeout   time.Duration
	Critical  bool
}

// RecoveryManager provides production-grade error recovery and resilience
type RecoveryManager struct {
	logger          *zap.Logger
	recoveryManager *common.RecoveryManager
	components      map[string]*ComponentState
	compMu          sync.RWMutex
	strategies      map[string]RecoveryStrategy
	stratMu         sync.RWMutex
	healthChecks    []HealthCheck
	checkMu         sync.RWMutex
	stats           struct {
		recoveryAttempts  atomic.Uint64
		recoverySuccesses atomic.Uint64
		recoveryFailures  atomic.Uint64
		lastRecoveryTime  atomic.Int64
		totalDowntime     atomic.Int64
	}
	ctx    context.Context
	cancel context.CancelFunc
}

// NewRecoveryManager creates a new recovery manager
func NewRecoveryManager(logger *zap.Logger) *RecoveryManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	config := &common.RecoveryConfig{
		MaxRetries:              5,
		RetryDelay:              time.Second,
		BackoffMultiplier:       2.0,
		MaxBackoff:              time.Minute,
		EnableCircuitBreaker:    true,
		CircuitBreakerThreshold: 3,
		CircuitBreakerTimeout:   30 * time.Second,
	}
	
	rm := &RecoveryManager{
		logger:          logger,
		recoveryManager: common.NewRecoveryManager(config),
		components:      make(map[string]*ComponentState),
		strategies:      make(map[string]RecoveryStrategy),
		healthChecks:    make([]HealthCheck, 0),
		ctx:             ctx,
		cancel:          cancel,
	}
	
	rm.registerDefaultStrategies()
	return rm
}

// RegisterComponent registers a component for monitoring
func (rm *RecoveryManager) RegisterComponent(name string) error {
	rm.compMu.Lock()
	defer rm.compMu.Unlock()
	
	if _, exists := rm.components[name]; exists {
		return fmt.Errorf("component %s already registered", name)
	}
	
	rm.components[name] = &ComponentState{
		Name:      name,
		Status:    StatusHealthy,
		LastCheck: time.Now(),
		CircuitBreaker: &common.CircuitBreaker{},
	}
	
	rm.logger.Info("Component registered", zap.String("component", name))
	return nil
}

// RecoverComponent attempts to recover a failed component
func (rm *RecoveryManager) RecoverComponent(ctx context.Context, componentName string) error {
	rm.compMu.RLock()
	component, exists := rm.components[componentName]
	rm.compMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("component %s not found", componentName)
	}
	
	rm.stats.recoveryAttempts.Add(1)
	startTime := time.Now()
	
	strategy := rm.getRecoveryStrategy(componentName)
	if strategy == nil {
		return fmt.Errorf("no recovery strategy for %s", componentName)
	}
	
	if !strategy.ShouldRecover(component) {
		return fmt.Errorf("recovery not recommended for %s", componentName)
	}
	
	// Use common recovery manager for execution
	err := rm.recoveryManager.ExecuteWithRecovery(ctx, componentName, func() error {
		return strategy.Recover(ctx, component)
	})
	
	if err != nil {
		rm.stats.recoveryFailures.Add(1)
		rm.logger.Error("Recovery failed", 
			zap.String("component", componentName),
			zap.Error(err))
		return err
	}
	
	// Recovery successful
	rm.stats.recoverySuccesses.Add(1)
	rm.stats.lastRecoveryTime.Store(time.Now().Unix())
	
	component.mu.Lock()
	component.Status = StatusHealthy
	component.ErrorCount = 0
	component.LastError = nil
	component.mu.Unlock()
	
	rm.logger.Info("Component recovered successfully",
		zap.String("component", componentName),
		zap.Duration("recovery_time", time.Since(startTime)))
	
	return nil
}

// getRecoveryStrategy finds the appropriate recovery strategy
func (rm *RecoveryManager) getRecoveryStrategy(componentName string) RecoveryStrategy {
	rm.stratMu.RLock()
	defer rm.stratMu.RUnlock()
	
	if strategy, exists := rm.strategies[componentName]; exists {
		return strategy
	}
	
	if strategy, exists := rm.strategies["default"]; exists {
		return strategy
	}
	
	return nil
}

// registerDefaultStrategies registers built-in recovery strategies
func (rm *RecoveryManager) registerDefaultStrategies() {
	rm.strategies["default"] = &RestartStrategy{
		logger:       rm.logger,
		maxRestarts:  3,
		restartDelay: 5 * time.Second,
	}
	
	rm.strategies["mining"] = &MiningRecoveryStrategy{
		logger: rm.logger,
	}
	
	rm.strategies["network"] = &NetworkRecoveryStrategy{
		logger: rm.logger,
	}
}

// RegisterStrategy registers a custom recovery strategy
func (rm *RecoveryManager) RegisterStrategy(name string, strategy RecoveryStrategy) {
	rm.stratMu.Lock()
	defer rm.stratMu.Unlock()
	rm.strategies[name] = strategy
}

// RegisterHealthCheck registers a health check
func (rm *RecoveryManager) RegisterHealthCheck(check HealthCheck) {
	rm.checkMu.Lock()
	defer rm.checkMu.Unlock()
	rm.healthChecks = append(rm.healthChecks, check)
}

// StartHealthMonitoring starts continuous health monitoring
func (rm *RecoveryManager) StartHealthMonitoring() {
	go rm.runHealthChecks()
}

// runHealthChecks continuously runs health checks
func (rm *RecoveryManager) runHealthChecks() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-rm.ctx.Done():
			return
		case <-ticker.C:
			rm.performHealthChecks()
		}
	}
}

// performHealthChecks executes all registered health checks
func (rm *RecoveryManager) performHealthChecks() {
	rm.checkMu.RLock()
	checks := make([]HealthCheck, len(rm.healthChecks))
	copy(checks, rm.healthChecks)
	rm.checkMu.RUnlock()
	
	var wg sync.WaitGroup
	for _, check := range checks {
		wg.Add(1)
		go func(hc HealthCheck) {
			defer wg.Done()
			
			ctx, cancel := context.WithTimeout(rm.ctx, hc.Timeout)
			defer cancel()
			
			if err := hc.Check(ctx); err != nil {
				rm.handleHealthCheckFailure(hc, err)
			} else {
				rm.handleHealthCheckSuccess(hc)
			}
		}(check)
	}
	
	wg.Wait()
}

// handleHealthCheckFailure handles a failed health check
func (rm *RecoveryManager) handleHealthCheckFailure(check HealthCheck, err error) {
	rm.compMu.Lock()
	defer rm.compMu.Unlock()
	
	component, exists := rm.components[check.Component]
	if !exists {
		return
	}
	
	component.ErrorCount++
	component.LastError = err
	component.LastCheck = time.Now()
	
	if component.ErrorCount >= 3 {
		component.Status = StatusUnhealthy
		if check.Critical {
			go rm.RecoverComponent(rm.ctx, check.Component)
		}
	} else {
		component.Status = StatusDegraded
	}
	
	rm.logger.Warn("Health check failed",
		zap.String("check", check.Name),
		zap.String("component", check.Component),
		zap.Error(err))
}

// handleHealthCheckSuccess handles a successful health check
func (rm *RecoveryManager) handleHealthCheckSuccess(check HealthCheck) {
	rm.compMu.Lock()
	defer rm.compMu.Unlock()
	
	component, exists := rm.components[check.Component]
	if !exists {
		return
	}
	
	component.Status = StatusHealthy
	component.ErrorCount = 0
	component.LastError = nil
	component.LastCheck = time.Now()
}

// GetComponentStatus returns the status of a component
func (rm *RecoveryManager) GetComponentStatus(name string) (ComponentStatus, error) {
	rm.compMu.RLock()
	defer rm.compMu.RUnlock()
	
	component, exists := rm.components[name]
	if !exists {
		return StatusOffline, fmt.Errorf("component %s not found", name)
	}
	
	return component.Status, nil
}

// GetStats returns recovery statistics
func (rm *RecoveryManager) GetStats() map[string]interface{} {
	commonStats := rm.recoveryManager.GetStats()
	
	// Merge with local stats
	for k, v := range map[string]interface{}{
		"recovery_attempts":  rm.stats.recoveryAttempts.Load(),
		"recovery_successes": rm.stats.recoverySuccesses.Load(),
		"recovery_failures":  rm.stats.recoveryFailures.Load(),
		"last_recovery_time": time.Unix(rm.stats.lastRecoveryTime.Load(), 0),
		"total_downtime":     rm.stats.totalDowntime.Load(),
	} {
		commonStats[k] = v
	}
	
	return commonStats
}

// Shutdown gracefully shuts down the recovery manager
func (rm *RecoveryManager) Shutdown() {
	rm.cancel()
	rm.logger.Info("Recovery manager shut down")
}

// Recovery Strategy Implementations

// RestartStrategy implements a simple restart recovery strategy
type RestartStrategy struct {
	logger       *zap.Logger
	maxRestarts  int
	restartDelay time.Duration
}

func (rs *RestartStrategy) Recover(ctx context.Context, component *ComponentState) error {
	component.mu.Lock()
	component.RestartCount++
	restartCount := component.RestartCount
	component.mu.Unlock()
	
	if restartCount > int32(rs.maxRestarts) {
		return fmt.Errorf("max restarts exceeded for %s", component.Name)
	}
	
	rs.logger.Info("Restarting component",
		zap.String("component", component.Name),
		zap.Int32("restart_count", restartCount))
	
	time.Sleep(rs.restartDelay)
	return nil
}

func (rs *RestartStrategy) ShouldRecover(component *ComponentState) bool {
	component.mu.RLock()
	defer component.mu.RUnlock()
	return component.RestartCount < int32(rs.maxRestarts)
}

func (rs *RestartStrategy) GetPriority() int {
	return 1
}

// MiningRecoveryStrategy implements mining-specific recovery
type MiningRecoveryStrategy struct {
	logger *zap.Logger
}

func (mrs *MiningRecoveryStrategy) Recover(ctx context.Context, component *ComponentState) error {
	mrs.logger.Info("Recovering mining component", zap.String("component", component.Name))
	// Mining-specific recovery logic here
	return nil
}

func (mrs *MiningRecoveryStrategy) ShouldRecover(component *ComponentState) bool {
	return true // Always try to recover mining components
}

func (mrs *MiningRecoveryStrategy) GetPriority() int {
	return 10 // High priority
}

// NetworkRecoveryStrategy implements network-specific recovery
type NetworkRecoveryStrategy struct {
	logger *zap.Logger
}

func (nrs *NetworkRecoveryStrategy) Recover(ctx context.Context, component *ComponentState) error {
	nrs.logger.Info("Recovering network component", zap.String("component", component.Name))
	// Network-specific recovery logic here
	return nil
}

func (nrs *NetworkRecoveryStrategy) ShouldRecover(component *ComponentState) bool {
	component.mu.RLock()
	defer component.mu.RUnlock()
	return component.ErrorCount < 10
}

func (nrs *NetworkRecoveryStrategy) GetPriority() int {
	return 5
}

// SafeGo starts a goroutine with panic recovery using common recovery
func SafeGo(logger *zap.Logger, name string, fn func()) {
	common.SafeGoWithRecover(fn, func(r interface{}) {
		logger.Error("Panic recovered",
			zap.String("component", name),
			zap.Any("panic", r))
	})
}