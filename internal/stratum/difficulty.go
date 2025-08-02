package stratum

import (
	"math"
	"sync"
	"time"
)

// DifficultyAdjuster manages advanced difficulty adjustment
type DifficultyAdjuster struct {
	config       DifficultyConfig
	shareHistory *ShareHistory
	mu           sync.RWMutex
}

// DifficultyConfig contains difficulty adjustment settings
type DifficultyConfig struct {
	InitialDiff     float64
	MinDiff         float64
	MaxDiff         float64
	TargetTime      float64
	RetargetTime    float64
	VariancePercent float64
	EnableVarDiff   bool
	EnableJumpDiff  bool
	MaxJumpFactor   float64
	SmoothingFactor float64
	ShareBufferSize int
	WindowSize      time.Duration
}

// ShareHistory tracks share submission history
type ShareHistory struct {
	shares     []ShareRecord
	maxSize    int
	currentIdx int
	mu         sync.RWMutex
}

// ShareRecord represents a share submission record
type ShareRecord struct {
	Timestamp  time.Time
	Difficulty float64
	Valid      bool
}

// WorkerStats tracks worker performance statistics
type WorkerStats struct {
	LastShareTime   time.Time
	ShareCount      uint64
	CurrentDiff     float64
	AverageHashRate float64
	ShareTimes      []time.Duration
}

// NewDifficultyAdjuster creates a new difficulty adjuster
func NewDifficultyAdjuster(config DifficultyConfig) *DifficultyAdjuster {
	return &DifficultyAdjuster{
		config: config,
		shareHistory: &ShareHistory{
			shares:  make([]ShareRecord, config.ShareBufferSize),
			maxSize: config.ShareBufferSize,
		},
	}
}

// DefaultDifficultyConfig returns default difficulty configuration
func DefaultDifficultyConfig() DifficultyConfig {
	return DifficultyConfig{
		InitialDiff:     1000.0,
		MinDiff:         100.0,
		MaxDiff:         1000000.0,
		TargetTime:      10.0,
		RetargetTime:    60.0,
		VariancePercent: 30.0,
		EnableVarDiff:   true,
		EnableJumpDiff:  true,
		MaxJumpFactor:   4.0,
		SmoothingFactor: 0.3,
		ShareBufferSize: 1000,
		WindowSize:      10 * time.Minute,
	}
}

// AdjustDifficulty adjusts worker difficulty using advanced algorithms
func (da *DifficultyAdjuster) AdjustDifficulty(worker *WorkerStats) float64 {
	da.mu.Lock()
	defer da.mu.Unlock()
	
	// Initial or insufficient history
	if len(worker.ShareTimes) < 3 {
		return worker.CurrentDiff
	}
	
	newDiff := worker.CurrentDiff
	
	if da.config.EnableVarDiff {
		// Variable difficulty algorithm
		newDiff = da.calculateVarDiff(worker)
	}
	
	if da.config.EnableJumpDiff {
		// Jump difficulty algorithm
		jumpDiff := da.calculateJumpDiff(worker)
		if math.Abs(jumpDiff-newDiff)/newDiff > 0.5 {
			newDiff = jumpDiff
		}
	}
	
	// Apply smoothing
	if da.config.SmoothingFactor > 0 {
		newDiff = da.smoothDifficulty(worker.CurrentDiff, newDiff)
	}
	
	// Apply limits
	newDiff = da.applyLimits(newDiff)
	
	return newDiff
}

// calculateVarDiff calculates variable difficulty
func (da *DifficultyAdjuster) calculateVarDiff(worker *WorkerStats) float64 {
	avgShareTime := da.calculateAverageShareTime(worker.ShareTimes)
	
	deviation := avgShareTime - da.config.TargetTime
	deviationPercent := deviation / da.config.TargetTime * 100
	
	adjustmentFactor := 1.0
	
	if math.Abs(deviationPercent) > da.config.VariancePercent {
		// PID-like control algorithm
		proportional := deviation / da.config.TargetTime
		integral := da.calculateIntegral(worker)
		derivative := da.calculateDerivative(worker)
		
		// PID coefficients
		kp := 0.5
		ki := 0.1
		kd := 0.05
		
		adjustment := kp*proportional + ki*integral + kd*derivative
		adjustmentFactor = 1.0 + adjustment
	}
	
	return worker.CurrentDiff * adjustmentFactor
}

// calculateJumpDiff calculates jump difficulty
func (da *DifficultyAdjuster) calculateJumpDiff(worker *WorkerStats) float64 {
	if worker.AverageHashRate > 0 {
		// Theoretical difficulty for target share time
		targetDiff := worker.AverageHashRate * da.config.TargetTime / math.Pow(2, 32)
		
		// Check for large deviation
		currentToTarget := targetDiff / worker.CurrentDiff
		if currentToTarget > da.config.MaxJumpFactor {
			return worker.CurrentDiff * da.config.MaxJumpFactor
		} else if currentToTarget < 1.0/da.config.MaxJumpFactor {
			return worker.CurrentDiff / da.config.MaxJumpFactor
		}
		
		return targetDiff
	}
	
	return worker.CurrentDiff
}

// smoothDifficulty applies exponential moving average
func (da *DifficultyAdjuster) smoothDifficulty(current, target float64) float64 {
	alpha := da.config.SmoothingFactor
	return alpha*target + (1-alpha)*current
}

// applyLimits clamps difficulty to configured limits
func (da *DifficultyAdjuster) applyLimits(diff float64) float64 {
	if diff < da.config.MinDiff {
		return da.config.MinDiff
	}
	if diff > da.config.MaxDiff {
		return da.config.MaxDiff
	}
	return diff
}

// calculateAverageShareTime calculates average share time with outlier removal
func (da *DifficultyAdjuster) calculateAverageShareTime(shareTimes []time.Duration) float64 {
	if len(shareTimes) == 0 {
		return da.config.TargetTime
	}
	
	// Copy and remove outliers
	sorted := make([]time.Duration, len(shareTimes))
	copy(sorted, shareTimes)
	
	// Remove top/bottom 10%
	trimCount := len(sorted) / 10
	if trimCount > 0 && len(sorted) > 2*trimCount {
		sorted = sorted[trimCount : len(sorted)-trimCount]
	}
	
	var sum time.Duration
	for _, t := range sorted {
		sum += t
	}
	
	return sum.Seconds() / float64(len(sorted))
}

// calculateIntegral calculates integral term for PID control
func (da *DifficultyAdjuster) calculateIntegral(worker *WorkerStats) float64 {
	integral := 0.0
	for i, shareTime := range worker.ShareTimes {
		if i > 0 {
			deviation := shareTime.Seconds() - da.config.TargetTime
			integral += deviation
		}
	}
	return integral / float64(len(worker.ShareTimes))
}

// calculateDerivative calculates derivative term for PID control
func (da *DifficultyAdjuster) calculateDerivative(worker *WorkerStats) float64 {
	if len(worker.ShareTimes) < 2 {
		return 0.0
	}
	
	lastIdx := len(worker.ShareTimes) - 1
	lastDeviation := worker.ShareTimes[lastIdx].Seconds() - da.config.TargetTime
	prevDeviation := worker.ShareTimes[lastIdx-1].Seconds() - da.config.TargetTime
	
	return lastDeviation - prevDeviation
}

// RecordShare records a share for statistical analysis
func (da *DifficultyAdjuster) RecordShare(timestamp time.Time, difficulty float64, valid bool) {
	da.shareHistory.mu.Lock()
	defer da.shareHistory.mu.Unlock()
	
	record := ShareRecord{
		Timestamp:  timestamp,
		Difficulty: difficulty,
		Valid:      valid,
	}
	
	da.shareHistory.shares[da.shareHistory.currentIdx] = record
	da.shareHistory.currentIdx = (da.shareHistory.currentIdx + 1) % da.shareHistory.maxSize
}
