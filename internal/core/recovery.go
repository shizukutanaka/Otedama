package core

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// RecoveryManager manages system recovery operations
type RecoveryManager struct {
	logger        *zap.Logger
	errorHandler  *ErrorHandler
	strategies    map[string]RecoveryStrategy
	healthChecks  map[string]HealthCheck
	checkInterval time.Duration
	
	// State tracking
	systemHealth  atomic.Value // *SystemHealth
	recovering    atomic.Bool
	lastRecovery  atomic.Value // time.Time
	
	// Control
	stopCh chan struct{}
	wg     sync.WaitGroup
	mu     sync.RWMutex
}

// RecoveryStrategy defines a recovery strategy
type RecoveryStrategy interface {
	Name() string
	CanRecover(error) bool
	Recover(context.Context) error
	Priority() int
}

// HealthCheck defines a health check
type HealthCheck interface {
	Name() string
	Check(context.Context) error
	Critical() bool
}

// SystemHealth represents overall system health
type SystemHealth struct {
	Healthy      bool
	Components   map[string]ComponentHealth
	LastCheck    time.Time
	HealthScore  float64
}

// ComponentHealth represents component health
type ComponentHealth struct {
	Name     string
	Healthy  bool
	Status   string
	Error    error
	LastCheck time.Time
}

// NewRecoveryManager creates a new recovery manager
func NewRecoveryManager(logger *zap.Logger, errorHandler *ErrorHandler) *RecoveryManager {
	rm := &RecoveryManager{
		logger:        logger,
		errorHandler:  errorHandler,
		strategies:    make(map[string]RecoveryStrategy),
		healthChecks:  make(map[string]HealthCheck),
		checkInterval: 30 * time.Second,
		stopCh:        make(chan struct{}),
	}
	
	// Initialize system health
	rm.systemHealth.Store(&SystemHealth{
		Healthy:    true,
		Components: make(map[string]ComponentHealth),
		LastCheck:  time.Now(),
	})
	
	// Register default strategies
	rm.RegisterStrategy(&NetworkRecoveryStrategy{logger: logger})
	rm.RegisterStrategy(&StorageRecoveryStrategy{logger: logger})
	rm.RegisterStrategy(&MiningRecoveryStrategy{logger: logger})
	rm.RegisterStrategy(&MemoryRecoveryStrategy{logger: logger})
	
	return rm
}

// Start starts the recovery manager
func (rm *RecoveryManager) Start(ctx context.Context) {
	rm.wg.Add(2)
	go rm.healthCheckRoutine(ctx)
	go rm.recoveryRoutine(ctx)
	
	rm.logger.Info("Recovery manager started")
}

// Stop stops the recovery manager
func (rm *RecoveryManager) Stop() {
	close(rm.stopCh)
	rm.wg.Wait()
	
	rm.logger.Info("Recovery manager stopped")
}

// RegisterStrategy registers a recovery strategy
func (rm *RecoveryManager) RegisterStrategy(strategy RecoveryStrategy) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	rm.strategies[strategy.Name()] = strategy
}

// RegisterHealthCheck registers a health check
func (rm *RecoveryManager) RegisterHealthCheck(check HealthCheck) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	rm.healthChecks[check.Name()] = check
}

// TriggerRecovery manually triggers recovery
func (rm *RecoveryManager) TriggerRecovery(ctx context.Context, err error) error {
	if rm.recovering.Load() {
		return fmt.Errorf("recovery already in progress")
	}
	
	rm.recovering.Store(true)
	defer rm.recovering.Store(false)
	
	rm.logger.Info("Manual recovery triggered", zap.Error(err))
	return rm.performRecovery(ctx, err)
}

// GetSystemHealth returns current system health
func (rm *RecoveryManager) GetSystemHealth() *SystemHealth {
	if health := rm.systemHealth.Load(); health != nil {
		return health.(*SystemHealth).clone()
	}
	return nil
}

// Background routines

func (rm *RecoveryManager) healthCheckRoutine(ctx context.Context) {
	defer rm.wg.Done()
	
	ticker := time.NewTicker(rm.checkInterval)
	defer ticker.Stop()
	
	// Initial check
	rm.performHealthChecks(ctx)
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-rm.stopCh:
			return
		case <-ticker.C:
			rm.performHealthChecks(ctx)
		}
	}
}

func (rm *RecoveryManager) recoveryRoutine(ctx context.Context) {
	defer rm.wg.Done()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-rm.stopCh:
			return
		default:
			// Check if recovery needed
			health := rm.GetSystemHealth()
			if !health.Healthy && !rm.recovering.Load() {
				rm.recovering.Store(true)
				go func() {
					defer rm.recovering.Store(false)
					if err := rm.performRecovery(ctx, nil); err != nil {
						rm.logger.Error("Automatic recovery failed", zap.Error(err))
					}
				}()
			}
			
			time.Sleep(5 * time.Second)
		}
	}
}

func (rm *RecoveryManager) performHealthChecks(ctx context.Context) {
	rm.mu.RLock()
	checks := make([]HealthCheck, 0, len(rm.healthChecks))
	for _, check := range rm.healthChecks {
		checks = append(checks, check)
	}
	rm.mu.RUnlock()
	
	health := &SystemHealth{
		Healthy:    true,
		Components: make(map[string]ComponentHealth),
		LastCheck:  time.Now(),
	}
	
	var wg sync.WaitGroup
	var mu sync.Mutex
	
	for _, check := range checks {
		wg.Add(1)
		go func(c HealthCheck) {
			defer wg.Done()
			
			checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			
			err := c.Check(checkCtx)
			
			mu.Lock()
			defer mu.Unlock()
			
			component := ComponentHealth{
				Name:      c.Name(),
				Healthy:   err == nil,
				LastCheck: time.Now(),
			}
			
			if err != nil {
				component.Status = "unhealthy"
				component.Error = err
				if c.Critical() {
					health.Healthy = false
				}
			} else {
				component.Status = "healthy"
			}
			
			health.Components[c.Name()] = component
		}(check)
	}
	
	wg.Wait()
	
	// Calculate health score
	health.HealthScore = rm.calculateHealthScore(health)
	
	// Store health status
	rm.systemHealth.Store(health)
	
	// Log if unhealthy
	if !health.Healthy {
		rm.logger.Warn("System health check failed",
			zap.Float64("health_score", health.HealthScore),
			zap.Int("unhealthy_components", countUnhealthy(health)))
	}
}

func (rm *RecoveryManager) performRecovery(ctx context.Context, err error) error {
	rm.lastRecovery.Store(time.Now())
	
	rm.logger.Info("Starting system recovery")
	
	// Get applicable strategies
	strategies := rm.getApplicableStrategies(err)
	if len(strategies) == 0 {
		return fmt.Errorf("no applicable recovery strategies")
	}
	
	// Try strategies in order of priority
	var lastErr error
	for _, strategy := range strategies {
		rm.logger.Info("Attempting recovery strategy",
			zap.String("strategy", strategy.Name()))
		
		recoveryCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		err := strategy.Recover(recoveryCtx)
		cancel()
		
		if err == nil {
			rm.logger.Info("Recovery strategy succeeded",
				zap.String("strategy", strategy.Name()))
			
			// Verify system health
			rm.performHealthChecks(ctx)
			health := rm.GetSystemHealth()
			if health.Healthy {
				return nil
			}
		} else {
			lastErr = err
			rm.logger.Warn("Recovery strategy failed",
				zap.String("strategy", strategy.Name()),
				zap.Error(err))
		}
	}
	
	return fmt.Errorf("all recovery strategies failed: %w", lastErr)
}

func (rm *RecoveryManager) getApplicableStrategies(err error) []RecoveryStrategy {
	rm.mu.RLock()
	defer rm.mu.RUnlock()
	
	var applicable []RecoveryStrategy
	
	// Get unhealthy components
	health := rm.GetSystemHealth()
	unhealthyComponents := make(map[string]bool)
	for name, comp := range health.Components {
		if !comp.Healthy {
			unhealthyComponents[name] = true
		}
	}
	
	// Find applicable strategies
	for _, strategy := range rm.strategies {
		if err != nil && strategy.CanRecover(err) {
			applicable = append(applicable, strategy)
		} else if len(unhealthyComponents) > 0 {
			// Check if strategy can help with unhealthy components
			applicable = append(applicable, strategy)
		}
	}
	
	// Sort by priority
	sortStrategiesByPriority(applicable)
	
	return applicable
}

func (rm *RecoveryManager) calculateHealthScore(health *SystemHealth) float64 {
	if len(health.Components) == 0 {
		return 100.0
	}
	
	healthyCount := 0
	totalWeight := 0.0
	weightedScore := 0.0
	
	for _, comp := range health.Components {
		weight := 1.0
		if check, exists := rm.healthChecks[comp.Name]; exists && check.Critical() {
			weight = 2.0
		}
		
		totalWeight += weight
		if comp.Healthy {
			healthyCount++
			weightedScore += weight
		}
	}
	
	return (weightedScore / totalWeight) * 100.0
}

// Default recovery strategies

// NetworkRecoveryStrategy recovers network issues
type NetworkRecoveryStrategy struct {
	logger *zap.Logger
}

func (s *NetworkRecoveryStrategy) Name() string {
	return "network_recovery"
}

func (s *NetworkRecoveryStrategy) CanRecover(err error) bool {
	if err == nil {
		return false
	}
	
	var otedamaErr *OtedamaError
	if errors.As(err, &otedamaErr) {
		return otedamaErr.Category == ErrorCategoryNetwork
	}
	
	return false
}

func (s *NetworkRecoveryStrategy) Recover(ctx context.Context) error {
	s.logger.Info("Performing network recovery")
	
	// Network recovery steps:
	// 1. Reset network connections
	// 2. Clear DNS cache
	// 3. Restart network services
	// 4. Re-establish peer connections
	
	// Simulate recovery
	time.Sleep(2 * time.Second)
	
	return nil
}

func (s *NetworkRecoveryStrategy) Priority() int {
	return 10
}

// StorageRecoveryStrategy recovers storage issues
type StorageRecoveryStrategy struct {
	logger *zap.Logger
}

func (s *StorageRecoveryStrategy) Name() string {
	return "storage_recovery"
}

func (s *StorageRecoveryStrategy) CanRecover(err error) bool {
	if err == nil {
		return false
	}
	
	var otedamaErr *OtedamaError
	if errors.As(err, &otedamaErr) {
		return otedamaErr.Category == ErrorCategoryStorage
	}
	
	return false
}

func (s *StorageRecoveryStrategy) Recover(ctx context.Context) error {
	s.logger.Info("Performing storage recovery")
	
	// Storage recovery steps:
	// 1. Check disk space
	// 2. Clear temporary files
	// 3. Verify data integrity
	// 4. Switch to backup storage if needed
	
	return nil
}

func (s *StorageRecoveryStrategy) Priority() int {
	return 20
}

// MiningRecoveryStrategy recovers mining issues
type MiningRecoveryStrategy struct {
	logger *zap.Logger
}

func (s *MiningRecoveryStrategy) Name() string {
	return "mining_recovery"
}

func (s *MiningRecoveryStrategy) CanRecover(err error) bool {
	if err == nil {
		return false
	}
	
	var otedamaErr *OtedamaError
	if errors.As(err, &otedamaErr) {
		return otedamaErr.Category == ErrorCategoryMining
	}
	
	return false
}

func (s *MiningRecoveryStrategy) Recover(ctx context.Context) error {
	s.logger.Info("Performing mining recovery")
	
	// Mining recovery steps:
	// 1. Reset mining engines
	// 2. Clear job queue
	// 3. Reduce mining intensity
	// 4. Switch to different algorithm
	
	return nil
}

func (s *MiningRecoveryStrategy) Priority() int {
	return 30
}

// MemoryRecoveryStrategy recovers memory issues
type MemoryRecoveryStrategy struct {
	logger *zap.Logger
}

func (s *MemoryRecoveryStrategy) Name() string {
	return "memory_recovery"
}

func (s *MemoryRecoveryStrategy) CanRecover(err error) bool {
	// Always applicable for memory pressure
	return true
}

func (s *MemoryRecoveryStrategy) Recover(ctx context.Context) error {
	s.logger.Info("Performing memory recovery")
	
	// Memory recovery steps:
	// 1. Force garbage collection
	// 2. Clear caches
	// 3. Release unused memory pools
	// 4. Reduce concurrent operations
	
	// Force GC
	runtime.GC()
	
	return nil
}

func (s *MemoryRecoveryStrategy) Priority() int {
	return 5
}

// Utility functions

func (sh *SystemHealth) clone() *SystemHealth {
	clone := &SystemHealth{
		Healthy:     sh.Healthy,
		Components:  make(map[string]ComponentHealth),
		LastCheck:   sh.LastCheck,
		HealthScore: sh.HealthScore,
	}
	
	for k, v := range sh.Components {
		clone.Components[k] = v
	}
	
	return clone
}

func countUnhealthy(health *SystemHealth) int {
	count := 0
	for _, comp := range health.Components {
		if !comp.Healthy {
			count++
		}
	}
	return count
}

func sortStrategiesByPriority(strategies []RecoveryStrategy) {
	// Simple insertion sort for small arrays
	for i := 1; i < len(strategies); i++ {
		key := strategies[i]
		j := i - 1
		for j >= 0 && strategies[j].Priority() > key.Priority() {
			strategies[j+1] = strategies[j]
			j--
		}
		strategies[j+1] = key
	}
}

// Default health checks

// NetworkHealthCheck checks network health
type NetworkHealthCheck struct{}

func (c *NetworkHealthCheck) Name() string {
	return "network"
}

func (c *NetworkHealthCheck) Check(ctx context.Context) error {
	// Check network connectivity
	// This would be implemented based on actual network requirements
	return nil
}

func (c *NetworkHealthCheck) Critical() bool {
	return true
}

// StorageHealthCheck checks storage health
type StorageHealthCheck struct{}

func (c *StorageHealthCheck) Name() string {
	return "storage"
}

func (c *StorageHealthCheck) Check(ctx context.Context) error {
	// Check storage availability and space
	return nil
}

func (c *StorageHealthCheck) Critical() bool {
	return true
}

// MiningHealthCheck checks mining health
type MiningHealthCheck struct{}

func (c *MiningHealthCheck) Name() string {
	return "mining"
}

func (c *MiningHealthCheck) Check(ctx context.Context) error {
	// Check mining engine status
	return nil
}

func (c *MiningHealthCheck) Critical() bool {
	return false
}