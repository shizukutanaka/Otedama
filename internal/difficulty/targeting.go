package difficulty

import (
	"errors"
	"math"
	"math/big"
	"sync"
	"sync/atomic"
	"time"
)

// DifficultyTargeter manages share difficulty targeting
type DifficultyTargeter struct {
	// Configuration
	targetShareTime   time.Duration // Target time between shares
	minDifficulty     float64
	maxDifficulty     float64
	adjustmentFactor  float64
	adjustmentWindow  int
	
	// Worker tracking
	workers      map[string]*WorkerDifficulty
	workersMu    sync.RWMutex
	
	// Global difficulty
	globalDifficulty atomic.Value // float64
	
	// Statistics
	totalShares      atomic.Uint64
	totalAdjustments atomic.Uint64
}

// WorkerDifficulty tracks per-worker difficulty
type WorkerDifficulty struct {
	ID             string
	CurrentDiff    atomic.Value // float64
	ShareTimes     []time.Time
	LastShare      atomic.Value // time.Time
	ShareCount     atomic.Uint64
	
	// Statistics
	AvgShareTime   time.Duration
	HashRate       float64
	ValidShares    uint64
	InvalidShares  uint64
	
	mu sync.RWMutex
}

// DifficultyConfig holds difficulty configuration
type DifficultyConfig struct {
	TargetShareTime  time.Duration
	MinDifficulty    float64
	MaxDifficulty    float64
	AdjustmentFactor float64
	AdjustmentWindow int
}

// DefaultDifficultyConfig returns default configuration
func DefaultDifficultyConfig() *DifficultyConfig {
	return &DifficultyConfig{
		TargetShareTime:  10 * time.Second,
		MinDifficulty:    1.0,
		MaxDifficulty:    1000000.0,
		AdjustmentFactor: 0.2,
		AdjustmentWindow: 10,
	}
}

// NewDifficultyTargeter creates a new difficulty targeter
func NewDifficultyTargeter(config *DifficultyConfig) *DifficultyTargeter {
	if config == nil {
		config = DefaultDifficultyConfig()
	}
	
	dt := &DifficultyTargeter{
		targetShareTime:  config.TargetShareTime,
		minDifficulty:    config.MinDifficulty,
		maxDifficulty:    config.MaxDifficulty,
		adjustmentFactor: config.AdjustmentFactor,
		adjustmentWindow: config.AdjustmentWindow,
		workers:         make(map[string]*WorkerDifficulty),
	}
	
	dt.globalDifficulty.Store(config.MinDifficulty)
	
	// Start adjustment routine
	go dt.adjustmentRoutine()
	
	return dt
}

// RegisterWorker registers a new worker
func (dt *DifficultyTargeter) RegisterWorker(workerID string) {
	dt.workersMu.Lock()
	defer dt.workersMu.Unlock()
	
	if _, exists := dt.workers[workerID]; exists {
		return
	}
	
	worker := &WorkerDifficulty{
		ID:         workerID,
		ShareTimes: make([]time.Time, 0, dt.adjustmentWindow),
	}
	
	// Set initial difficulty
	worker.CurrentDiff.Store(dt.globalDifficulty.Load())
	worker.LastShare.Store(time.Now())
	
	dt.workers[workerID] = worker
}

// SubmitShare records a share submission
func (dt *DifficultyTargeter) SubmitShare(workerID string, valid bool) error {
	dt.workersMu.RLock()
	worker, exists := dt.workers[workerID]
	dt.workersMu.RUnlock()
	
	if !exists {
		return errors.New("worker not found")
	}
	
	now := time.Now()
	
	worker.mu.Lock()
	defer worker.mu.Unlock()
	
	// Update statistics
	if valid {
		worker.ValidShares++
	} else {
		worker.InvalidShares++
		// Don't adjust difficulty for invalid shares
		return nil
	}
	
	// Record share time
	worker.ShareTimes = append(worker.ShareTimes, now)
	if len(worker.ShareTimes) > dt.adjustmentWindow {
		worker.ShareTimes = worker.ShareTimes[1:]
	}
	
	worker.LastShare.Store(now)
	worker.ShareCount.Add(1)
	dt.totalShares.Add(1)
	
	// Adjust difficulty if enough shares
	if len(worker.ShareTimes) >= dt.adjustmentWindow {
		dt.adjustWorkerDifficulty(worker)
	}
	
	return nil
}

// adjustWorkerDifficulty adjusts difficulty for a worker
func (dt *DifficultyTargeter) adjustWorkerDifficulty(worker *WorkerDifficulty) {
	// Calculate average share time
	if len(worker.ShareTimes) < 2 {
		return
	}
	
	totalTime := worker.ShareTimes[len(worker.ShareTimes)-1].Sub(worker.ShareTimes[0])
	avgShareTime := totalTime / time.Duration(len(worker.ShareTimes)-1)
	worker.AvgShareTime = avgShareTime
	
	// Calculate adjustment ratio
	ratio := float64(avgShareTime) / float64(dt.targetShareTime)
	
	// Apply adjustment with damping
	currentDiff := worker.CurrentDiff.Load().(float64)
	var newDiff float64
	
	if ratio > 1.2 {
		// Shares coming too slowly, decrease difficulty
		adjustment := 1.0 - dt.adjustmentFactor*(ratio-1.0)
		newDiff = currentDiff * adjustment
	} else if ratio < 0.8 {
		// Shares coming too quickly, increase difficulty
		adjustment := 1.0 + dt.adjustmentFactor*(1.0-ratio)
		newDiff = currentDiff * adjustment
	} else {
		// Within target range, no adjustment
		return
	}
	
	// Apply limits
	if newDiff < dt.minDifficulty {
		newDiff = dt.minDifficulty
	}
	if newDiff > dt.maxDifficulty {
		newDiff = dt.maxDifficulty
	}
	
	// Update difficulty
	worker.CurrentDiff.Store(newDiff)
	dt.totalAdjustments.Add(1)
	
	// Estimate hashrate
	worker.HashRate = dt.estimateHashRate(newDiff, avgShareTime)
}

// GetWorkerDifficulty gets current difficulty for a worker
func (dt *DifficultyTargeter) GetWorkerDifficulty(workerID string) (float64, error) {
	dt.workersMu.RLock()
	worker, exists := dt.workers[workerID]
	dt.workersMu.RUnlock()
	
	if !exists {
		return dt.globalDifficulty.Load().(float64), nil
	}
	
	return worker.CurrentDiff.Load().(float64), nil
}

// estimateHashRate estimates hashrate from difficulty and share time
func (dt *DifficultyTargeter) estimateHashRate(difficulty float64, avgShareTime time.Duration) float64 {
	// Hashrate = Difficulty * 2^32 / ShareTime
	hashesPerShare := difficulty * math.Pow(2, 32)
	seconds := avgShareTime.Seconds()
	
	if seconds > 0 {
		return hashesPerShare / seconds
	}
	
	return 0
}

// adjustmentRoutine periodically adjusts global difficulty
func (dt *DifficultyTargeter) adjustmentRoutine() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		dt.adjustGlobalDifficulty()
	}
}

// adjustGlobalDifficulty adjusts global difficulty
func (dt *DifficultyTargeter) adjustGlobalDifficulty() {
	dt.workersMu.RLock()
	defer dt.workersMu.RUnlock()
	
	if len(dt.workers) == 0 {
		return
	}
	
	// Calculate average difficulty across all workers
	var totalDiff float64
	var activeWorkers int
	
	now := time.Now()
	for _, worker := range dt.workers {
		// Only consider active workers (submitted share in last 5 minutes)
		lastShare := worker.LastShare.Load().(time.Time)
		if now.Sub(lastShare) < 5*time.Minute {
			totalDiff += worker.CurrentDiff.Load().(float64)
			activeWorkers++
		}
	}
	
	if activeWorkers > 0 {
		avgDiff := totalDiff / float64(activeWorkers)
		dt.globalDifficulty.Store(avgDiff)
	}
}

// GetStatistics returns targeter statistics
func (dt *DifficultyTargeter) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	stats["global_difficulty"] = dt.globalDifficulty.Load()
	stats["total_shares"] = dt.totalShares.Load()
	stats["total_adjustments"] = dt.totalAdjustments.Load()
	
	// Worker statistics
	dt.workersMu.RLock()
	workerStats := make([]map[string]interface{}, 0, len(dt.workers))
	
	for _, worker := range dt.workers {
		workerStats = append(workerStats, map[string]interface{}{
			"id":             worker.ID,
			"difficulty":     worker.CurrentDiff.Load(),
			"share_count":    worker.ShareCount.Load(),
			"valid_shares":   worker.ValidShares,
			"invalid_shares": worker.InvalidShares,
			"avg_share_time": worker.AvgShareTime.Seconds(),
			"hashrate":       worker.HashRate,
		})
	}
	dt.workersMu.RUnlock()
	
	stats["workers"] = workerStats
	stats["active_workers"] = len(workerStats)
	
	return stats
}

// VarDiff implements variable difficulty algorithm
type VarDiff struct {
	// Configuration
	retargetTime     time.Duration
	targetShareRate  float64 // Shares per second
	maxChange        float64 // Maximum change per adjustment
	
	// State
	currentDiff      atomic.Value // float64
	lastRetarget     time.Time
	sharesSinceRetarget atomic.Uint64
	
	mu sync.Mutex
}

// NewVarDiff creates a new VarDiff instance
func NewVarDiff(targetShareRate float64) *VarDiff {
	vd := &VarDiff{
		retargetTime:    30 * time.Second,
		targetShareRate: targetShareRate,
		maxChange:       2.0, // Max 2x change
	}
	
	vd.currentDiff.Store(1.0)
	vd.lastRetarget = time.Now()
	
	return vd
}

// SubmitShare submits a share and potentially adjusts difficulty
func (vd *VarDiff) SubmitShare() float64 {
	vd.sharesSinceRetarget.Add(1)
	
	vd.mu.Lock()
	defer vd.mu.Unlock()
	
	// Check if it's time to retarget
	elapsed := time.Since(vd.lastRetarget)
	if elapsed < vd.retargetTime {
		return vd.currentDiff.Load().(float64)
	}
	
	// Calculate actual share rate
	shares := vd.sharesSinceRetarget.Load()
	actualRate := float64(shares) / elapsed.Seconds()
	
	// Calculate adjustment
	currentDiff := vd.currentDiff.Load().(float64)
	targetShares := vd.targetShareRate * vd.retargetTime.Seconds()
	actualShares := float64(shares)
	
	ratio := actualShares / targetShares
	
	// Apply adjustment with limits
	var newDiff float64
	if ratio > vd.maxChange {
		newDiff = currentDiff * vd.maxChange
	} else if ratio < 1.0/vd.maxChange {
		newDiff = currentDiff / vd.maxChange
	} else {
		newDiff = currentDiff * ratio
	}
	
	// Update state
	vd.currentDiff.Store(newDiff)
	vd.lastRetarget = time.Now()
	vd.sharesSinceRetarget.Store(0)
	
	return newDiff
}

// GetDifficulty returns current difficulty
func (vd *VarDiff) GetDifficulty() float64 {
	return vd.currentDiff.Load().(float64)
}

// DifficultyToTarget converts difficulty to target
func DifficultyToTarget(difficulty float64) *big.Int {
	// Target = MaxTarget / Difficulty
	maxTarget := new(big.Int).Lsh(big.NewInt(1), 256)
	maxTarget.Sub(maxTarget, big.NewInt(1))
	
	diffBig := new(big.Float).SetFloat64(difficulty)
	targetFloat := new(big.Float).Quo(new(big.Float).SetInt(maxTarget), diffBig)
	
	target, _ := targetFloat.Int(nil)
	return target
}

// TargetToDifficulty converts target to difficulty
func TargetToDifficulty(target *big.Int) float64 {
	// Difficulty = MaxTarget / Target
	maxTarget := new(big.Int).Lsh(big.NewInt(1), 256)
	maxTarget.Sub(maxTarget, big.NewInt(1))
	
	if target.Cmp(big.NewInt(0)) == 0 {
		return math.MaxFloat64
	}
	
	difficulty := new(big.Float).Quo(
		new(big.Float).SetInt(maxTarget),
		new(big.Float).SetInt(target),
	)
	
	diff, _ := difficulty.Float64()
	return diff
}

// ShareValidator validates shares against difficulty
type ShareValidator struct {
	networkDiff float64
	poolDiff    float64
	mu          sync.RWMutex
}

// NewShareValidator creates a share validator
func NewShareValidator(networkDiff, poolDiff float64) *ShareValidator {
	return &ShareValidator{
		networkDiff: networkDiff,
		poolDiff:    poolDiff,
	}
}

// ValidateShare validates a share
func (sv *ShareValidator) ValidateShare(hash []byte, workerDiff float64) (bool, bool) {
	sv.mu.RLock()
	defer sv.mu.RUnlock()
	
	// Convert hash to big.Int
	hashInt := new(big.Int).SetBytes(hash)
	
	// Check against worker difficulty
	workerTarget := DifficultyToTarget(workerDiff)
	if hashInt.Cmp(workerTarget) > 0 {
		return false, false // Invalid share
	}
	
	// Check if it's a block
	networkTarget := DifficultyToTarget(sv.networkDiff)
	isBlock := hashInt.Cmp(networkTarget) <= 0
	
	return true, isBlock
}

// UpdateNetworkDifficulty updates network difficulty
func (sv *ShareValidator) UpdateNetworkDifficulty(diff float64) {
	sv.mu.Lock()
	defer sv.mu.Unlock()
	sv.networkDiff = diff
}