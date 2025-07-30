package automation

import (
	"context"
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/core"
	"github.com/otedama/otedama/internal/mining"
	"go.uber.org/zap"
)

// SelfHealer provides automatic healing of system issues
// Following Robert C. Martin's principle: "Leave the code better than you found it"
type SelfHealer struct {
	logger *zap.Logger
	
	// Healing strategies
	strategies map[string]HealingStrategy
	
	// Healing state
	activeHealing   sync.Map // map[string]*HealingOperation
	healingHistory  []HealingRecord
	historyMu       sync.RWMutex
	
	// Metrics
	healingAttempts atomic.Uint64
	healingSuccess  atomic.Uint64
	healingFailures atomic.Uint64
}

// HealingStrategy defines a healing approach
type HealingStrategy interface {
	Name() string
	CanHeal(issue Issue) bool
	Heal(ctx context.Context, issue Issue) error
	Priority() int
}

// Issue represents a system issue
type Issue struct {
	Type        string
	Severity    Severity
	Component   string
	Description string
	Metrics     map[string]float64
	Timestamp   time.Time
}

// Severity levels
type Severity int

const (
	SeverityLow Severity = iota
	SeverityMedium
	SeverityHigh
	SeverityCritical
)

// HealingOperation tracks an active healing operation
type HealingOperation struct {
	ID        string
	Issue     Issue
	Strategy  string
	StartTime time.Time
	Status    atomic.Value // string
}

// HealingRecord stores healing history
type HealingRecord struct {
	Operation HealingOperation
	EndTime   time.Time
	Success   bool
	Error     error
	Impact    float64
}

// NewSelfHealer creates a new self healer
func NewSelfHealer(logger *zap.Logger) *SelfHealer {
	healer := &SelfHealer{
		logger:         logger,
		strategies:     make(map[string]HealingStrategy),
		healingHistory: make([]HealingRecord, 0, 1000),
	}
	
	// Register default strategies
	healer.registerDefaultStrategies()
	
	return healer
}

// HealErrorRate heals high error rate issues
func (sh *SelfHealer) HealErrorRate(ctx context.Context, engine *mining.UnifiedEngine) error {
	issue := Issue{
		Type:        "high_error_rate",
		Severity:    SeverityHigh,
		Component:   "mining_engine",
		Description: "Error rate exceeds threshold",
		Timestamp:   time.Now(),
	}
	
	return sh.heal(ctx, issue, engine)
}

// HealAcceptanceRate heals low share acceptance rate
func (sh *SelfHealer) HealAcceptanceRate(ctx context.Context, engine *mining.UnifiedEngine) error {
	issue := Issue{
		Type:        "low_acceptance_rate",
		Severity:    SeverityMedium,
		Component:   "mining_engine",
		Description: "Share acceptance rate below threshold",
		Timestamp:   time.Now(),
	}
	
	return sh.heal(ctx, issue, engine)
}

// HealComponent heals a specific component
func (sh *SelfHealer) HealComponent(ctx context.Context, component string, issue Issue) error {
	issue.Component = component
	return sh.heal(ctx, issue, nil)
}

// DetectAndHeal detects issues and attempts healing
func (sh *SelfHealer) DetectAndHeal(ctx context.Context, state *SystemState) error {
	issues := sh.detectIssues(state)
	
	if len(issues) == 0 {
		return nil
	}
	
	sh.logger.Info("Detected system issues",
		zap.Int("count", len(issues)),
	)
	
	// Sort by severity
	sortIssuesBySeverity(issues)
	
	// Heal each issue
	var firstErr error
	for _, issue := range issues {
		if err := sh.heal(ctx, issue, nil); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	
	return firstErr
}

// GetHealingStatus returns current healing operations
func (sh *SelfHealer) GetHealingStatus() []HealingOperation {
	operations := []HealingOperation{}
	
	sh.activeHealing.Range(func(key, value interface{}) bool {
		if op, ok := value.(*HealingOperation); ok {
			operations = append(operations, *op)
		}
		return true
	})
	
	return operations
}

// GetHealingHistory returns healing history
func (sh *SelfHealer) GetHealingHistory(limit int) []HealingRecord {
	sh.historyMu.RLock()
	defer sh.historyMu.RUnlock()
	
	if limit <= 0 || limit > len(sh.healingHistory) {
		limit = len(sh.healingHistory)
	}
	
	// Return most recent records
	start := len(sh.healingHistory) - limit
	if start < 0 {
		start = 0
	}
	
	result := make([]HealingRecord, limit)
	copy(result, sh.healingHistory[start:])
	
	return result
}

// Private methods

func (sh *SelfHealer) heal(ctx context.Context, issue Issue, engine *mining.UnifiedEngine) error {
	sh.healingAttempts.Add(1)
	
	// Find appropriate strategy
	strategy := sh.selectStrategy(issue)
	if strategy == nil {
		return fmt.Errorf("no healing strategy available for issue: %s", issue.Type)
	}
	
	// Create healing operation
	operation := &HealingOperation{
		ID:        generateOperationID(),
		Issue:     issue,
		Strategy:  strategy.Name(),
		StartTime: time.Now(),
	}
	operation.Status.Store("running")
	
	// Track active healing
	sh.activeHealing.Store(operation.ID, operation)
	defer sh.activeHealing.Delete(operation.ID)
	
	sh.logger.Info("Starting healing operation",
		zap.String("id", operation.ID),
		zap.String("issue", issue.Type),
		zap.String("strategy", strategy.Name()),
	)
	
	// Execute healing
	err := strategy.Heal(ctx, issue)
	
	// Record result
	record := HealingRecord{
		Operation: *operation,
		EndTime:   time.Now(),
		Success:   err == nil,
		Error:     err,
	}
	
	if err == nil {
		sh.healingSuccess.Add(1)
		operation.Status.Store("completed")
		record.Impact = sh.measureImpact(issue)
	} else {
		sh.healingFailures.Add(1)
		operation.Status.Store("failed")
	}
	
	sh.recordHealing(record)
	
	return err
}

func (sh *SelfHealer) selectStrategy(issue Issue) HealingStrategy {
	var bestStrategy HealingStrategy
	highestPriority := -1
	
	for _, strategy := range sh.strategies {
		if strategy.CanHeal(issue) && strategy.Priority() > highestPriority {
			bestStrategy = strategy
			highestPriority = strategy.Priority()
		}
	}
	
	return bestStrategy
}

func (sh *SelfHealer) detectIssues(state *SystemState) []Issue {
	issues := []Issue{}
	
	// High CPU usage
	if state.CPUUsage > 90 {
		issues = append(issues, Issue{
			Type:        "high_cpu_usage",
			Severity:    SeverityHigh,
			Component:   "system",
			Description: fmt.Sprintf("CPU usage at %.1f%%", state.CPUUsage),
			Metrics:     map[string]float64{"cpu_usage": state.CPUUsage},
			Timestamp:   state.Timestamp,
		})
	}
	
	// High memory usage
	if state.MemoryUsage > 85 {
		issues = append(issues, Issue{
			Type:        "high_memory_usage",
			Severity:    SeverityMedium,
			Component:   "system",
			Description: fmt.Sprintf("Memory usage at %.1f%%", state.MemoryUsage),
			Metrics:     map[string]float64{"memory_usage": state.MemoryUsage},
			Timestamp:   state.Timestamp,
		})
	}
	
	// Low hash rate
	if state.HashRate > 0 && state.HashRate < state.WorkerCount*1000000 {
		issues = append(issues, Issue{
			Type:        "low_hash_rate",
			Severity:    SeverityMedium,
			Component:   "mining",
			Description: "Hash rate below expected",
			Metrics:     map[string]float64{"hash_rate": state.HashRate},
			Timestamp:   state.Timestamp,
		})
	}
	
	// High error rate
	if state.ErrorRate > 0.05 {
		issues = append(issues, Issue{
			Type:        "high_error_rate",
			Severity:    SeverityHigh,
			Component:   "system",
			Description: fmt.Sprintf("Error rate at %.1f%%", state.ErrorRate*100),
			Metrics:     map[string]float64{"error_rate": state.ErrorRate},
			Timestamp:   state.Timestamp,
		})
	}
	
	// Low system health
	if state.SystemHealth < 50 {
		issues = append(issues, Issue{
			Type:        "low_system_health",
			Severity:    SeverityCritical,
			Component:   "system",
			Description: fmt.Sprintf("System health at %d", state.SystemHealth),
			Metrics:     map[string]float64{"health": float64(state.SystemHealth)},
			Timestamp:   state.Timestamp,
		})
	}
	
	return issues
}

func (sh *SelfHealer) measureImpact(issue Issue) float64 {
	// Simplified impact measurement
	// In production, would measure actual improvement
	switch issue.Severity {
	case SeverityCritical:
		return 1.0
	case SeverityHigh:
		return 0.7
	case SeverityMedium:
		return 0.4
	case SeverityLow:
		return 0.2
	default:
		return 0.1
	}
}

func (sh *SelfHealer) recordHealing(record HealingRecord) {
	sh.historyMu.Lock()
	defer sh.historyMu.Unlock()
	
	sh.healingHistory = append(sh.healingHistory, record)
	
	// Keep only recent history
	if len(sh.healingHistory) > 1000 {
		sh.healingHistory = sh.healingHistory[len(sh.healingHistory)-1000:]
	}
}

func (sh *SelfHealer) registerDefaultStrategies() {
	// Restart strategy
	sh.RegisterStrategy(&RestartStrategy{logger: sh.logger})
	
	// Resource optimization strategy
	sh.RegisterStrategy(&ResourceOptimizationStrategy{logger: sh.logger})
	
	// Configuration adjustment strategy
	sh.RegisterStrategy(&ConfigAdjustmentStrategy{logger: sh.logger})
	
	// Cache clearing strategy
	sh.RegisterStrategy(&CacheClearingStrategy{logger: sh.logger})
	
	// Network reset strategy
	sh.RegisterStrategy(&NetworkResetStrategy{logger: sh.logger})
}

// RegisterStrategy registers a healing strategy
func (sh *SelfHealer) RegisterStrategy(strategy HealingStrategy) {
	sh.strategies[strategy.Name()] = strategy
}

// Default healing strategies

// RestartStrategy restarts components
type RestartStrategy struct {
	logger *zap.Logger
}

func (rs *RestartStrategy) Name() string { return "restart" }
func (rs *RestartStrategy) Priority() int { return 5 }

func (rs *RestartStrategy) CanHeal(issue Issue) bool {
	return issue.Type == "high_error_rate" || issue.Type == "low_system_health"
}

func (rs *RestartStrategy) Heal(ctx context.Context, issue Issue) error {
	rs.logger.Info("Applying restart strategy",
		zap.String("component", issue.Component),
	)
	
	// Simulate restart
	time.Sleep(100 * time.Millisecond)
	
	return nil
}

// ResourceOptimizationStrategy optimizes resource usage
type ResourceOptimizationStrategy struct {
	logger *zap.Logger
}

func (ro *ResourceOptimizationStrategy) Name() string { return "resource_optimization" }
func (ro *ResourceOptimizationStrategy) Priority() int { return 8 }

func (ro *ResourceOptimizationStrategy) CanHeal(issue Issue) bool {
	return issue.Type == "high_memory_usage" || issue.Type == "high_cpu_usage"
}

func (ro *ResourceOptimizationStrategy) Heal(ctx context.Context, issue Issue) error {
	ro.logger.Info("Applying resource optimization",
		zap.String("issue", issue.Type),
	)
	
	// Force garbage collection
	runtime.GC()
	
	// Free OS memory
	debug.FreeOSMemory()
	
	return nil
}

// ConfigAdjustmentStrategy adjusts configuration
type ConfigAdjustmentStrategy struct {
	logger *zap.Logger
}

func (ca *ConfigAdjustmentStrategy) Name() string { return "config_adjustment" }
func (ca *ConfigAdjustmentStrategy) Priority() int { return 7 }

func (ca *ConfigAdjustmentStrategy) CanHeal(issue Issue) bool {
	return issue.Type == "low_hash_rate" || issue.Type == "low_acceptance_rate"
}

func (ca *ConfigAdjustmentStrategy) Heal(ctx context.Context, issue Issue) error {
	ca.logger.Info("Adjusting configuration",
		zap.String("issue", issue.Type),
	)
	
	// Configuration adjustment logic would go here
	
	return nil
}

// CacheClearingStrategy clears caches
type CacheClearingStrategy struct {
	logger *zap.Logger
}

func (cc *CacheClearingStrategy) Name() string { return "cache_clearing" }
func (cc *CacheClearingStrategy) Priority() int { return 3 }

func (cc *CacheClearingStrategy) CanHeal(issue Issue) bool {
	return issue.Type == "high_memory_usage"
}

func (cc *CacheClearingStrategy) Heal(ctx context.Context, issue Issue) error {
	cc.logger.Info("Clearing caches")
	
	// Cache clearing logic would go here
	
	return nil
}

// NetworkResetStrategy resets network connections
type NetworkResetStrategy struct {
	logger *zap.Logger
}

func (nr *NetworkResetStrategy) Name() string { return "network_reset" }
func (nr *NetworkResetStrategy) Priority() int { return 6 }

func (nr *NetworkResetStrategy) CanHeal(issue Issue) bool {
	return issue.Component == "network" || issue.Type == "connection_errors"
}

func (nr *NetworkResetStrategy) Heal(ctx context.Context, issue Issue) error {
	nr.logger.Info("Resetting network connections")
	
	// Network reset logic would go here
	
	return nil
}

// Helper functions

func generateOperationID() string {
	return fmt.Sprintf("heal_%d", time.Now().UnixNano())
}

func sortIssuesBySeverity(issues []Issue) {
	// Simple bubble sort for small lists
	for i := 0; i < len(issues)-1; i++ {
		for j := 0; j < len(issues)-i-1; j++ {
			if issues[j].Severity < issues[j+1].Severity {
				issues[j], issues[j+1] = issues[j+1], issues[j]
			}
		}
	}
}