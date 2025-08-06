package pool

import (
	"math"
	"sync"
	"time"

	"go.uber.org/zap"
)

// DifficultyAdjuster adjusts mining difficulty per worker
type DifficultyAdjuster struct {
	logger         *zap.Logger
	workers        map[string]*WorkerDifficulty
	workersMu      sync.RWMutex
	
	// Configuration
	targetShareTime time.Duration
	minDifficulty   float64
	maxDifficulty   float64
	adjustWindow    time.Duration
	adjustFactor    float64
}

// WorkerDifficulty tracks difficulty for a worker
type WorkerDifficulty struct {
	CurrentDifficulty float64
	ShareTimes        []time.Time
	LastAdjustment    time.Time
	TotalShares       uint64
}

// NewDifficultyAdjuster creates a new difficulty adjuster
func NewDifficultyAdjuster(logger *zap.Logger, minDifficulty float64) *DifficultyAdjuster {
	return &DifficultyAdjuster{
		logger:          logger,
		workers:         make(map[string]*WorkerDifficulty),
		targetShareTime: 10 * time.Second, // Target 1 share per 10 seconds
		minDifficulty:   minDifficulty,
		maxDifficulty:   1e12, // Very high max
		adjustWindow:    2 * time.Minute,
		adjustFactor:    2.0, // Max adjustment factor
	}
}

// GetDifficulty returns the current difficulty for a worker
func (da *DifficultyAdjuster) GetDifficulty(workerID string) float64 {
	da.workersMu.RLock()
	defer da.workersMu.RUnlock()
	
	worker, exists := da.workers[workerID]
	if !exists {
		return da.minDifficulty
	}
	
	return worker.CurrentDifficulty
}

// RecordShare records a share submission time
func (da *DifficultyAdjuster) RecordShare(workerID string, timestamp time.Time) {
	da.workersMu.Lock()
	defer da.workersMu.Unlock()
	
	worker, exists := da.workers[workerID]
	if !exists {
		worker = &WorkerDifficulty{
			CurrentDifficulty: da.minDifficulty,
			ShareTimes:        make([]time.Time, 0, 100),
			LastAdjustment:    time.Now(),
		}
		da.workers[workerID] = worker
	}
	
	// Add share time
	worker.ShareTimes = append(worker.ShareTimes, timestamp)
	worker.TotalShares++
	
	// Keep only recent shares
	cutoff := time.Now().Add(-da.adjustWindow)
	validTimes := make([]time.Time, 0)
	for _, t := range worker.ShareTimes {
		if t.After(cutoff) {
			validTimes = append(validTimes, t)
		}
	}
	worker.ShareTimes = validTimes
	
	// Check if we should adjust
	if time.Since(worker.LastAdjustment) >= 30*time.Second && len(worker.ShareTimes) >= 5 {
		da.adjustDifficulty(workerID, worker)
	}
}

// adjustDifficulty adjusts difficulty based on share rate
func (da *DifficultyAdjuster) adjustDifficulty(workerID string, worker *WorkerDifficulty) {
	if len(worker.ShareTimes) < 2 {
		return
	}
	
	// Calculate average time between shares
	totalTime := worker.ShareTimes[len(worker.ShareTimes)-1].Sub(worker.ShareTimes[0])
	avgShareTime := totalTime / time.Duration(len(worker.ShareTimes)-1)
	
	// Calculate adjustment ratio
	ratio := float64(da.targetShareTime) / float64(avgShareTime)
	
	// Limit adjustment factor
	if ratio > da.adjustFactor {
		ratio = da.adjustFactor
	} else if ratio < 1/da.adjustFactor {
		ratio = 1 / da.adjustFactor
	}
	
	// Apply adjustment
	newDifficulty := worker.CurrentDifficulty * ratio
	
	// Apply bounds
	if newDifficulty < da.minDifficulty {
		newDifficulty = da.minDifficulty
	} else if newDifficulty > da.maxDifficulty {
		newDifficulty = da.maxDifficulty
	}
	
	// Round to nice number
	newDifficulty = roundDifficulty(newDifficulty)
	
	if newDifficulty != worker.CurrentDifficulty {
		da.logger.Info("Adjusted worker difficulty",
			zap.String("worker", workerID),
			zap.Float64("old_difficulty", worker.CurrentDifficulty),
			zap.Float64("new_difficulty", newDifficulty),
			zap.Duration("avg_share_time", avgShareTime),
			zap.Float64("ratio", ratio),
		)
		
		worker.CurrentDifficulty = newDifficulty
	}
	
	worker.LastAdjustment = time.Now()
}

// SetTargetShareTime sets the target time between shares
func (da *DifficultyAdjuster) SetTargetShareTime(duration time.Duration) {
	da.targetShareTime = duration
}

// SetDifficultyBounds sets min and max difficulty
func (da *DifficultyAdjuster) SetDifficultyBounds(min, max float64) {
	da.minDifficulty = min
	da.maxDifficulty = max
}

// GetWorkerStats returns statistics for a worker
func (da *DifficultyAdjuster) GetWorkerStats(workerID string) map[string]interface{} {
	da.workersMu.RLock()
	defer da.workersMu.RUnlock()
	
	worker, exists := da.workers[workerID]
	if !exists {
		return map[string]interface{}{
			"difficulty":    da.minDifficulty,
			"total_shares":  0,
			"recent_shares": 0,
		}
	}
	
	avgShareTime := time.Duration(0)
	if len(worker.ShareTimes) >= 2 {
		totalTime := worker.ShareTimes[len(worker.ShareTimes)-1].Sub(worker.ShareTimes[0])
		avgShareTime = totalTime / time.Duration(len(worker.ShareTimes)-1)
	}
	
	// Estimate hashrate
	// Hashrate = Difficulty * 2^32 / Share_Time
	hashrate := worker.CurrentDifficulty * math.Pow(2, 32) / avgShareTime.Seconds()
	
	return map[string]interface{}{
		"difficulty":       worker.CurrentDifficulty,
		"total_shares":     worker.TotalShares,
		"recent_shares":    len(worker.ShareTimes),
		"avg_share_time":   avgShareTime,
		"est_hashrate":     hashrate,
		"last_adjustment":  worker.LastAdjustment,
	}
}

// GetStats returns overall statistics
func (da *DifficultyAdjuster) GetStats() map[string]interface{} {
	da.workersMu.RLock()
	defer da.workersMu.RUnlock()
	
	totalWorkers := len(da.workers)
	avgDifficulty := float64(0)
	minWorkerDiff := da.maxDifficulty
	maxWorkerDiff := da.minDifficulty
	
	for _, worker := range da.workers {
		avgDifficulty += worker.CurrentDifficulty
		if worker.CurrentDifficulty < minWorkerDiff {
			minWorkerDiff = worker.CurrentDifficulty
		}
		if worker.CurrentDifficulty > maxWorkerDiff {
			maxWorkerDiff = worker.CurrentDifficulty
		}
	}
	
	if totalWorkers > 0 {
		avgDifficulty /= float64(totalWorkers)
	}
	
	return map[string]interface{}{
		"total_workers":      totalWorkers,
		"avg_difficulty":     avgDifficulty,
		"min_worker_diff":    minWorkerDiff,
		"max_worker_diff":    maxWorkerDiff,
		"target_share_time":  da.targetShareTime,
		"min_difficulty":     da.minDifficulty,
		"max_difficulty":     da.maxDifficulty,
	}
}

// CleanupInactive removes inactive workers
func (da *DifficultyAdjuster) CleanupInactive(inactiveDuration time.Duration) {
	da.workersMu.Lock()
	defer da.workersMu.Unlock()
	
	cutoff := time.Now().Add(-inactiveDuration)
	removed := 0
	
	for workerID, worker := range da.workers {
		if len(worker.ShareTimes) == 0 || worker.ShareTimes[len(worker.ShareTimes)-1].Before(cutoff) {
			delete(da.workers, workerID)
			removed++
		}
	}
	
	if removed > 0 {
		da.logger.Info("Cleaned up inactive workers",
			zap.Int("removed", removed),
		)
	}
}

// Helper functions

func roundDifficulty(diff float64) float64 {
	// Round to a nice number for display
	if diff < 1 {
		return math.Round(diff*1000) / 1000
	} else if diff < 10 {
		return math.Round(diff*100) / 100
	} else if diff < 100 {
		return math.Round(diff*10) / 10
	} else if diff < 1000 {
		return math.Round(diff)
	} else if diff < 10000 {
		return math.Round(diff/10) * 10
	} else if diff < 100000 {
		return math.Round(diff/100) * 100
	} else if diff < 1000000 {
		return math.Round(diff/1000) * 1000
	} else {
		return math.Round(diff/10000) * 10000
	}
}