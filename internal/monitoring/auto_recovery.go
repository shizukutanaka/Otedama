package monitoring

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/p2p"
	"go.uber.org/zap"
)

// AutoRecoveryManager handles automated recovery actions
type AutoRecoveryManager struct {
	logger       *zap.Logger
	healthMon    *HealthMonitor
	recoveryMgr  common.RecoveryManager
	miningEngine *mining.Engine
	p2pPool      *p2p.Pool
	
	recoveryStrategies map[string]RecoveryStrategy
	recoveryHistory    sync.Map
	maxRetries         int
	retryInterval      time.Duration
	
	mu sync.RWMutex
}

// RecoveryStrategy defines a recovery action
type RecoveryStrategy interface {
	Name() string
	CanRecover(status HealthStatus) bool
	Recover(ctx context.Context) error
	Priority() int
}

// RecoveryResult tracks recovery attempts
type RecoveryResult struct {
	Strategy  string
	Success   bool
	Error     error
	Timestamp time.Time
	Duration  time.Duration
}

// NewAutoRecoveryManager creates a new auto-recovery manager
func NewAutoRecoveryManager(logger *zap.Logger, healthMon *HealthMonitor, recoveryMgr common.RecoveryManager) *AutoRecoveryManager {
	arm := &AutoRecoveryManager{
		logger:             logger,
		healthMon:          healthMon,
		recoveryMgr:        recoveryMgr,
		recoveryStrategies: make(map[string]RecoveryStrategy),
		maxRetries:         3,
		retryInterval:      30 * time.Second,
	}
	
	// Register as alert handler
	healthMon.RegisterAlertHandler(arm)
	
	// Register default recovery strategies
	arm.registerDefaultStrategies()
	
	return arm
}

// SetMiningEngine sets the mining engine for recovery actions
func (arm *AutoRecoveryManager) SetMiningEngine(engine *mining.Engine) {
	arm.mu.Lock()
	defer arm.mu.Unlock()
	arm.miningEngine = engine
}

// SetP2PPool sets the P2P pool for recovery actions
func (arm *AutoRecoveryManager) SetP2PPool(pool *p2p.Pool) {
	arm.mu.Lock()
	defer arm.mu.Unlock()
	arm.p2pPool = pool
}

// RegisterStrategy registers a recovery strategy
func (arm *AutoRecoveryManager) RegisterStrategy(strategy RecoveryStrategy) {
	arm.mu.Lock()
	defer arm.mu.Unlock()
	arm.recoveryStrategies[strategy.Name()] = strategy
}

// HandleAlert implements AlertHandler interface
func (arm *AutoRecoveryManager) HandleAlert(alert Alert) {
	// Only handle error and critical alerts
	if alert.Level < AlertLevelError {
		return
	}
	
	arm.logger.Info("Handling alert for auto-recovery",
		zap.String("component", alert.Component),
		zap.String("level", alertLevelString(alert.Level)),
		zap.String("message", alert.Message),
	)
	
	// Get current health status
	healthStatus := arm.healthMon.GetHealthStatus()
	componentStatus, exists := healthStatus[alert.Component]
	if !exists {
		arm.logger.Warn("Component not found in health status",
			zap.String("component", alert.Component),
		)
		return
	}
	
	// Find applicable recovery strategies
	strategies := arm.findApplicableStrategies(componentStatus)
	if len(strategies) == 0 {
		arm.logger.Warn("No recovery strategies available",
			zap.String("component", alert.Component),
		)
		return
	}
	
	// Execute recovery strategies
	go arm.executeRecovery(context.Background(), alert.Component, componentStatus, strategies)
}

// Find strategies that can handle the current status
func (arm *AutoRecoveryManager) findApplicableStrategies(status HealthStatus) []RecoveryStrategy {
	arm.mu.RLock()
	defer arm.mu.RUnlock()
	
	var applicable []RecoveryStrategy
	for _, strategy := range arm.recoveryStrategies {
		if strategy.CanRecover(status) {
			applicable = append(applicable, strategy)
		}
	}
	
	// Sort by priority
	sortStrategiesByPriority(applicable)
	
	return applicable
}

// Execute recovery strategies
func (arm *AutoRecoveryManager) executeRecovery(ctx context.Context, component string, status HealthStatus, strategies []RecoveryStrategy) {
	arm.logger.Info("Starting auto-recovery",
		zap.String("component", component),
		zap.Int("strategies", len(strategies)),
	)
	
	// Check recovery history to avoid rapid retries
	if !arm.shouldAttemptRecovery(component) {
		arm.logger.Info("Skipping recovery due to recent attempts",
			zap.String("component", component),
		)
		return
	}
	
	// Try each strategy
	for _, strategy := range strategies {
		arm.logger.Info("Attempting recovery strategy",
			zap.String("component", component),
			zap.String("strategy", strategy.Name()),
		)
		
		start := time.Now()
		err := strategy.Recover(ctx)
		duration := time.Since(start)
		
		result := RecoveryResult{
			Strategy:  strategy.Name(),
			Success:   err == nil,
			Error:     err,
			Timestamp: time.Now(),
			Duration:  duration,
		}
		
		// Store result
		arm.storeRecoveryResult(component, result)
		
		if err == nil {
			arm.logger.Info("Recovery strategy succeeded",
				zap.String("component", component),
				zap.String("strategy", strategy.Name()),
				zap.Duration("duration", duration),
			)
			
			// Wait a bit for system to stabilize
			time.Sleep(5 * time.Second)
			
			// Verify recovery
			if arm.verifyRecovery(component) {
				arm.logger.Info("Recovery verified successful",
					zap.String("component", component),
				)
				return
			}
		} else {
			arm.logger.Error("Recovery strategy failed",
				zap.String("component", component),
				zap.String("strategy", strategy.Name()),
				zap.Error(err),
			)
		}
	}
	
	arm.logger.Error("All recovery strategies failed",
		zap.String("component", component),
	)
}

// Check if we should attempt recovery
func (arm *AutoRecoveryManager) shouldAttemptRecovery(component string) bool {
	key := fmt.Sprintf("recovery_%s", component)
	
	if val, exists := arm.recoveryHistory.Load(key); exists {
		if history, ok := val.([]RecoveryResult); ok && len(history) > 0 {
			lastAttempt := history[len(history)-1]
			
			// Check if enough time has passed
			if time.Since(lastAttempt.Timestamp) < arm.retryInterval {
				return false
			}
			
			// Check retry limit
			recentAttempts := 0
			cutoff := time.Now().Add(-time.Hour)
			for _, result := range history {
				if result.Timestamp.After(cutoff) {
					recentAttempts++
				}
			}
			
			if recentAttempts >= arm.maxRetries {
				return false
			}
		}
	}
	
	return true
}

// Store recovery result
func (arm *AutoRecoveryManager) storeRecoveryResult(component string, result RecoveryResult) {
	key := fmt.Sprintf("recovery_%s", component)
	
	val, _ := arm.recoveryHistory.LoadOrStore(key, []RecoveryResult{})
	history := val.([]RecoveryResult)
	
	history = append(history, result)
	
	// Keep only recent history
	if len(history) > 100 {
		history = history[len(history)-100:]
	}
	
	arm.recoveryHistory.Store(key, history)
}

// Verify that recovery was successful
func (arm *AutoRecoveryManager) verifyRecovery(component string) bool {
	// Wait a bit for status to update
	time.Sleep(2 * time.Second)
	
	// Check health status
	healthStatus := arm.healthMon.GetHealthStatus()
	if status, exists := healthStatus[component]; exists {
		return status.Healthy
	}
	
	return false
}

// Register default recovery strategies
func (arm *AutoRecoveryManager) registerDefaultStrategies() {
	// System recovery strategies
	arm.RegisterStrategy(&RestartServiceStrategy{
		logger: arm.logger,
		arm:    arm,
	})
	
	arm.RegisterStrategy(&ClearCacheStrategy{
		logger: arm.logger,
	})
	
	arm.RegisterStrategy(&GarbageCollectStrategy{
		logger: arm.logger,
	})
	
	// Mining recovery strategies
	arm.RegisterStrategy(&RestartMiningStrategy{
		logger: arm.logger,
		arm:    arm,
	})
	
	arm.RegisterStrategy(&ResetMiningJobsStrategy{
		logger: arm.logger,
		arm:    arm,
	})
	
	// P2P recovery strategies
	arm.RegisterStrategy(&ReconnectPeersStrategy{
		logger: arm.logger,
		arm:    arm,
	})
	
	arm.RegisterStrategy(&ResetP2PConnectionsStrategy{
		logger: arm.logger,
		arm:    arm,
	})
	
	// Storage recovery strategies
	arm.RegisterStrategy(&CleanupStorageStrategy{
		logger: arm.logger,
	})
}

// Recovery strategies implementation

// RestartServiceStrategy restarts a failed service
type RestartServiceStrategy struct {
	logger *zap.Logger
	arm    *AutoRecoveryManager
}

func (s *RestartServiceStrategy) Name() string {
	return "restart_service"
}

func (s *RestartServiceStrategy) Priority() int {
	return 100
}

func (s *RestartServiceStrategy) CanRecover(status HealthStatus) bool {
	return !status.Healthy && status.Status == "error"
}

func (s *RestartServiceStrategy) Recover(ctx context.Context) error {
	// This would restart the specific service
	// For now, we'll trigger a general recovery
	if s.arm.recoveryMgr != nil {
		return s.arm.recoveryMgr.TriggerRecovery(ctx, fmt.Errorf("service restart requested"))
	}
	return nil
}

// ClearCacheStrategy clears caches to free memory
type ClearCacheStrategy struct {
	logger *zap.Logger
}

func (s *ClearCacheStrategy) Name() string {
	return "clear_cache"
}

func (s *ClearCacheStrategy) Priority() int {
	return 90
}

func (s *ClearCacheStrategy) CanRecover(status HealthStatus) bool {
	// Use when memory is high
	if memPercent, exists := status.Metrics["memory_percent"]; exists {
		return memPercent > 80.0
	}
	return false
}

func (s *ClearCacheStrategy) Recover(ctx context.Context) error {
	s.logger.Info("Clearing caches to free memory")
	// Implementation would clear various caches
	return nil
}

// GarbageCollectStrategy forces garbage collection
type GarbageCollectStrategy struct {
	logger *zap.Logger
}

func (s *GarbageCollectStrategy) Name() string {
	return "garbage_collect"
}

func (s *GarbageCollectStrategy) Priority() int {
	return 80
}

func (s *GarbageCollectStrategy) CanRecover(status HealthStatus) bool {
	// Use when memory is high or too many goroutines
	if memPercent, exists := status.Metrics["memory_percent"]; exists {
		if memPercent > 70.0 {
			return true
		}
	}
	if goroutines, exists := status.Metrics["goroutines"]; exists {
		if goroutines > 5000 {
			return true
		}
	}
	return false
}

func (s *GarbageCollectStrategy) Recover(ctx context.Context) error {
	s.logger.Info("Running garbage collection")
	// Force GC would happen here
	return nil
}

// RestartMiningStrategy restarts mining engine
type RestartMiningStrategy struct {
	logger *zap.Logger
	arm    *AutoRecoveryManager
}

func (s *RestartMiningStrategy) Name() string {
	return "restart_mining"
}

func (s *RestartMiningStrategy) Priority() int {
	return 95
}

func (s *RestartMiningStrategy) CanRecover(status HealthStatus) bool {
	return status.Message == "Mining subsystem error"
}

func (s *RestartMiningStrategy) Recover(ctx context.Context) error {
	s.arm.mu.RLock()
	engine := s.arm.miningEngine
	s.arm.mu.RUnlock()
	
	if engine == nil {
		return fmt.Errorf("mining engine not available")
	}
	
	s.logger.Info("Restarting mining engine")
	
	// Stop and restart mining
	engine.Stop()
	time.Sleep(2 * time.Second)
	return engine.Start(ctx)
}

// ResetMiningJobsStrategy resets mining job queue
type ResetMiningJobsStrategy struct {
	logger *zap.Logger
	arm    *AutoRecoveryManager
}

func (s *ResetMiningJobsStrategy) Name() string {
	return "reset_mining_jobs"
}

func (s *ResetMiningJobsStrategy) Priority() int {
	return 85
}

func (s *ResetMiningJobsStrategy) CanRecover(status HealthStatus) bool {
	return status.Message == "Mining job queue full" || status.Message == "Mining jobs stalled"
}

func (s *ResetMiningJobsStrategy) Recover(ctx context.Context) error {
	s.arm.mu.RLock()
	engine := s.arm.miningEngine
	s.arm.mu.RUnlock()
	
	if engine == nil {
		return fmt.Errorf("mining engine not available")
	}
	
	s.logger.Info("Resetting mining job queue")
	// Implementation would reset job queue
	return nil
}

// ReconnectPeersStrategy reconnects P2P peers
type ReconnectPeersStrategy struct {
	logger *zap.Logger
	arm    *AutoRecoveryManager
}

func (s *ReconnectPeersStrategy) Name() string {
	return "reconnect_peers"
}

func (s *ReconnectPeersStrategy) Priority() int {
	return 90
}

func (s *ReconnectPeersStrategy) CanRecover(status HealthStatus) bool {
	return status.Message == "No peers connected" || status.Message == "P2P network error"
}

func (s *ReconnectPeersStrategy) Recover(ctx context.Context) error {
	s.arm.mu.RLock()
	pool := s.arm.p2pPool
	s.arm.mu.RUnlock()
	
	if pool == nil {
		return fmt.Errorf("P2P pool not available")
	}
	
	s.logger.Info("Reconnecting P2P peers")
	return pool.ReconnectPeers()
}

// ResetP2PConnectionsStrategy resets all P2P connections
type ResetP2PConnectionsStrategy struct {
	logger *zap.Logger
	arm    *AutoRecoveryManager
}

func (s *ResetP2PConnectionsStrategy) Name() string {
	return "reset_p2p_connections"
}

func (s *ResetP2PConnectionsStrategy) Priority() int {
	return 70
}

func (s *ResetP2PConnectionsStrategy) CanRecover(status HealthStatus) bool {
	return status.Message == "P2P network degraded"
}

func (s *ResetP2PConnectionsStrategy) Recover(ctx context.Context) error {
	s.arm.mu.RLock()
	pool := s.arm.p2pPool
	s.arm.mu.RUnlock()
	
	if pool == nil {
		return fmt.Errorf("P2P pool not available")
	}
	
	s.logger.Info("Resetting P2P connections")
	// Implementation would reset all connections
	return nil
}

// CleanupStorageStrategy cleans up storage
type CleanupStorageStrategy struct {
	logger *zap.Logger
}

func (s *CleanupStorageStrategy) Name() string {
	return "cleanup_storage"
}

func (s *CleanupStorageStrategy) Priority() int {
	return 85
}

func (s *CleanupStorageStrategy) CanRecover(status HealthStatus) bool {
	if diskPercent, exists := status.Metrics["disk_percent"]; exists {
		return diskPercent > 85.0
	}
	return false
}

func (s *CleanupStorageStrategy) Recover(ctx context.Context) error {
	s.logger.Info("Cleaning up storage")
	// Implementation would clean logs, temp files, etc.
	return nil
}

// Helper functions

func alertLevelString(level AlertLevel) string {
	switch level {
	case AlertLevelInfo:
		return "info"
	case AlertLevelWarning:
		return "warning"
	case AlertLevelError:
		return "error"
	case AlertLevelCritical:
		return "critical"
	default:
		return "unknown"
	}
}

func sortStrategiesByPriority(strategies []RecoveryStrategy) {
	// Simple bubble sort for small arrays
	n := len(strategies)
	for i := 0; i < n-1; i++ {
		for j := 0; j < n-i-1; j++ {
			if strategies[j].Priority() < strategies[j+1].Priority() {
				strategies[j], strategies[j+1] = strategies[j+1], strategies[j]
			}
		}
	}
}