package automation

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/mining"
	"go.uber.org/zap"
)

// AutoScaler provides automatic scaling of mining workers
// Following Rob Pike's principle: "Don't guess, measure"
type AutoScaler struct {
	logger *zap.Logger
	config *AutomationConfig
	
	// Scaling state
	currentWorkers   atomic.Int32
	targetWorkers    atomic.Int32
	scalingInProgress atomic.Bool
	
	// Metrics
	scaleUpCount     atomic.Uint64
	scaleDownCount   atomic.Uint64
	
	// Performance tracking
	performanceHistory []PerformanceSnapshot
	historyMu         sync.RWMutex
}

// PerformanceSnapshot represents a point-in-time performance measurement
type PerformanceSnapshot struct {
	Timestamp      time.Time
	WorkerCount    int
	HashRate       float64
	CPUUsage       float64
	MemoryUsage    float64
	Efficiency     float64 // HashRate per worker
}

// NewAutoScaler creates a new auto scaler
func NewAutoScaler(logger *zap.Logger, config *AutomationConfig) *AutoScaler {
	scaler := &AutoScaler{
		logger:             logger,
		config:             config,
		performanceHistory: make([]PerformanceSnapshot, 0, 1000),
	}
	
	// Set initial worker count
	scaler.currentWorkers.Store(int32(runtime.NumCPU()))
	scaler.targetWorkers.Store(int32(runtime.NumCPU()))
	
	return scaler
}

// ScaleUp increases the number of workers
func (as *AutoScaler) ScaleUp(ctx context.Context, engine *mining.UnifiedEngine) error {
	if !as.scalingInProgress.CompareAndSwap(false, true) {
		return fmt.Errorf("scaling operation already in progress")
	}
	defer as.scalingInProgress.Store(false)
	
	current := as.currentWorkers.Load()
	maxWorkers := int32(as.config.MaxWorkers)
	
	if current >= maxWorkers {
		return fmt.Errorf("already at maximum workers: %d", maxWorkers)
	}
	
	// Calculate new worker count
	newCount := current + calculateScaleUpDelta(current, maxWorkers)
	if newCount > maxWorkers {
		newCount = maxWorkers
	}
	
	as.logger.Info("Scaling up workers",
		zap.Int32("current", current),
		zap.Int32("target", newCount),
	)
	
	// Apply scaling
	if err := as.applyScaling(ctx, engine, newCount); err != nil {
		return fmt.Errorf("failed to scale up: %w", err)
	}
	
	as.scaleUpCount.Add(1)
	as.recordPerformance(engine)
	
	return nil
}

// ScaleDown decreases the number of workers
func (as *AutoScaler) ScaleDown(ctx context.Context, engine *mining.UnifiedEngine) error {
	if !as.scalingInProgress.CompareAndSwap(false, true) {
		return fmt.Errorf("scaling operation already in progress")
	}
	defer as.scalingInProgress.Store(false)
	
	current := as.currentWorkers.Load()
	minWorkers := int32(as.config.MinWorkers)
	
	if current <= minWorkers {
		return fmt.Errorf("already at minimum workers: %d", minWorkers)
	}
	
	// Calculate new worker count
	newCount := current - calculateScaleDownDelta(current, minWorkers)
	if newCount < minWorkers {
		newCount = minWorkers
	}
	
	as.logger.Info("Scaling down workers",
		zap.Int32("current", current),
		zap.Int32("target", newCount),
	)
	
	// Apply scaling
	if err := as.applyScaling(ctx, engine, newCount); err != nil {
		return fmt.Errorf("failed to scale down: %w", err)
	}
	
	as.scaleDownCount.Add(1)
	as.recordPerformance(engine)
	
	return nil
}

// AutoScale performs automatic scaling based on metrics
func (as *AutoScaler) AutoScale(ctx context.Context, engine *mining.UnifiedEngine, state *SystemState) error {
	// Analyze performance history
	optimal := as.calculateOptimalWorkers(state)
	current := as.currentWorkers.Load()
	
	if optimal == current {
		return nil // No scaling needed
	}
	
	if optimal > current {
		return as.ScaleUp(ctx, engine)
	} else {
		return as.ScaleDown(ctx, engine)
	}
}

// GetScalingRecommendation returns scaling recommendation
func (as *AutoScaler) GetScalingRecommendation(state *SystemState) ScalingRecommendation {
	optimal := as.calculateOptimalWorkers(state)
	current := as.currentWorkers.Load()
	
	rec := ScalingRecommendation{
		CurrentWorkers:     int(current),
		RecommendedWorkers: int(optimal),
		Timestamp:          time.Now(),
	}
	
	if optimal > current {
		rec.Action = "scale_up"
		rec.Reason = fmt.Sprintf("CPU usage %.1f%% > threshold %.1f%%", 
			state.CPUUsage, as.config.ScaleUpThreshold)
	} else if optimal < current {
		rec.Action = "scale_down"
		rec.Reason = fmt.Sprintf("CPU usage %.1f%% < threshold %.1f%%",
			state.CPUUsage, as.config.ScaleDownThreshold)
	} else {
		rec.Action = "maintain"
		rec.Reason = "Current worker count is optimal"
	}
	
	// Add efficiency analysis
	if len(as.performanceHistory) > 0 {
		as.historyMu.RLock()
		latest := as.performanceHistory[len(as.performanceHistory)-1]
		as.historyMu.RUnlock()
		
		rec.CurrentEfficiency = latest.Efficiency
		rec.PredictedEfficiency = as.predictEfficiency(optimal)
	}
	
	return rec
}

// Private methods

func (as *AutoScaler) applyScaling(ctx context.Context, engine *mining.UnifiedEngine, newCount int32) error {
	// Update engine configuration
	if engine != nil {
		config := engine.GetConfig()
		config.MaxWorkers = int(newCount)
		
		// Apply new configuration
		if err := engine.UpdateConfig(config); err != nil {
			return err
		}
	}
	
	// Update state
	as.currentWorkers.Store(newCount)
	as.targetWorkers.Store(newCount)
	
	return nil
}

func (as *AutoScaler) calculateOptimalWorkers(state *SystemState) int32 {
	// Basic scaling logic based on CPU usage
	if state.CPUUsage > as.config.ScaleUpThreshold {
		// Need more workers
		return as.currentWorkers.Load() + 1
	} else if state.CPUUsage < as.config.ScaleDownThreshold {
		// Can reduce workers
		return as.currentWorkers.Load() - 1
	}
	
	// Advanced: Use efficiency analysis
	if as.config.PredictiveScaling {
		return as.predictOptimalWorkers(state)
	}
	
	return as.currentWorkers.Load()
}

func (as *AutoScaler) predictOptimalWorkers(state *SystemState) int32 {
	// Analyze historical performance
	as.historyMu.RLock()
	defer as.historyMu.RUnlock()
	
	if len(as.performanceHistory) < 10 {
		// Not enough data for prediction
		return as.currentWorkers.Load()
	}
	
	// Find worker count with best efficiency
	efficiencyMap := make(map[int]float64)
	
	for _, snapshot := range as.performanceHistory {
		if existing, ok := efficiencyMap[snapshot.WorkerCount]; ok {
			// Average the efficiencies
			efficiencyMap[snapshot.WorkerCount] = (existing + snapshot.Efficiency) / 2
		} else {
			efficiencyMap[snapshot.WorkerCount] = snapshot.Efficiency
		}
	}
	
	// Find optimal
	var optimalWorkers int
	var maxEfficiency float64
	
	for workers, efficiency := range efficiencyMap {
		if efficiency > maxEfficiency {
			maxEfficiency = efficiency
			optimalWorkers = workers
		}
	}
	
	// Apply constraints
	if optimalWorkers < as.config.MinWorkers {
		optimalWorkers = as.config.MinWorkers
	} else if optimalWorkers > as.config.MaxWorkers {
		optimalWorkers = as.config.MaxWorkers
	}
	
	return int32(optimalWorkers)
}

func (as *AutoScaler) predictEfficiency(workers int32) float64 {
	// Predict efficiency for given worker count
	as.historyMu.RLock()
	defer as.historyMu.RUnlock()
	
	var totalEfficiency float64
	var count int
	
	for _, snapshot := range as.performanceHistory {
		if snapshot.WorkerCount == int(workers) {
			totalEfficiency += snapshot.Efficiency
			count++
		}
	}
	
	if count > 0 {
		return totalEfficiency / float64(count)
	}
	
	// Estimate based on linear scaling
	if len(as.performanceHistory) > 0 {
		latest := as.performanceHistory[len(as.performanceHistory)-1]
		return latest.Efficiency * 0.95 // Assume 5% overhead per worker
	}
	
	return 0
}

func (as *AutoScaler) recordPerformance(engine *mining.UnifiedEngine) {
	if engine == nil {
		return
	}
	
	stats := engine.GetStats()
	
	snapshot := PerformanceSnapshot{
		Timestamp:   time.Now(),
		WorkerCount: int(as.currentWorkers.Load()),
		HashRate:    stats.CurrentHashRate,
		CPUUsage:    getCPUUsage(),
		MemoryUsage: getMemoryUsage(),
	}
	
	if snapshot.WorkerCount > 0 {
		snapshot.Efficiency = snapshot.HashRate / float64(snapshot.WorkerCount)
	}
	
	as.historyMu.Lock()
	defer as.historyMu.Unlock()
	
	as.performanceHistory = append(as.performanceHistory, snapshot)
	
	// Keep only recent history
	if len(as.performanceHistory) > 1000 {
		as.performanceHistory = as.performanceHistory[len(as.performanceHistory)-1000:]
	}
}

// Helper functions

func calculateScaleUpDelta(current, max int32) int32 {
	// Scale up by 20% or at least 1 worker
	delta := current / 5
	if delta < 1 {
		delta = 1
	}
	
	if current+delta > max {
		delta = max - current
	}
	
	return delta
}

func calculateScaleDownDelta(current, min int32) int32 {
	// Scale down by 10% or at least 1 worker
	delta := current / 10
	if delta < 1 {
		delta = 1
	}
	
	if current-delta < min {
		delta = current - min
	}
	
	return delta
}

func getCPUUsage() float64 {
	// Simplified - in production would use actual CPU metrics
	return 50.0
}

func getMemoryUsage() float64 {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	return float64(memStats.Alloc) / float64(memStats.Sys) * 100
}

// ScalingRecommendation contains scaling recommendation
type ScalingRecommendation struct {
	CurrentWorkers      int
	RecommendedWorkers  int
	Action              string
	Reason              string
	CurrentEfficiency   float64
	PredictedEfficiency float64
	Timestamp           time.Time
}