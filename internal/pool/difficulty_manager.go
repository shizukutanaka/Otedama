package pool

import (
	"context"
	"fmt"
	"math"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DifficultyManager handles automated share difficulty adjustment
// Following John Carmack's principle: "Measure twice, optimize once"
type DifficultyManager struct {
	logger *zap.Logger
	config *DifficultyConfig
	
	// Difficulty tracking
	currentDiff     atomic.Uint64
	networkDiff     atomic.Uint64
	baseDiff        uint64
	
	// Miner difficulty tracking
	minerDiffs      map[string]*MinerDifficulty
	minerDiffsMu    sync.RWMutex
	
	// Performance metrics
	shareStats      *ShareStatistics
	adjustmentStats *AdjustmentStatistics
	
	// Adjustment algorithm
	adjuster        *DifficultyAdjuster
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// DifficultyConfig contains difficulty adjustment configuration
type DifficultyConfig struct {
	// Base settings
	BaseDifficulty      uint64
	MinDifficulty       uint64
	MaxDifficulty       uint64
	
	// Target metrics
	TargetShareTime     time.Duration // Target time between shares
	ShareWindow         time.Duration // Window for calculating share rate
	
	// Adjustment parameters
	AdjustmentInterval  time.Duration
	MaxAdjustmentFactor float64 // Max change per adjustment (e.g., 2.0 = 100%)
	SmoothingFactor     float64 // Exponential smoothing factor
	
	// Vardiff settings
	EnableVardiff       bool
	VardiffRetargetTime time.Duration
	VardiffVariance     float64
	
	// Performance targets
	MinShareRate        float64 // Minimum shares per minute
	MaxShareRate        float64 // Maximum shares per minute
	
	// Network awareness
	NetworkDiffRatio    float64 // Pool diff as ratio of network diff
	AutoAdjustToNetwork bool
}

// MinerDifficulty tracks individual miner difficulty
type MinerDifficulty struct {
	MinerID         string
	CurrentDiff     uint64
	LastShare       time.Time
	ShareCount      uint64
	ShareTimes      []time.Time
	HashRate        float64
	Stale           uint64
	Valid           uint64
	LastAdjustment  time.Time
	mu              sync.RWMutex
}

// ShareStatistics tracks global share statistics
type ShareStatistics struct {
	TotalShares     atomic.Uint64
	ValidShares     atomic.Uint64
	StaleShares     atomic.Uint64
	InvalidShares   atomic.Uint64
	shareTimestamps []time.Time
	timestampsMu    sync.RWMutex
}

// AdjustmentStatistics tracks adjustment metrics
type AdjustmentStatistics struct {
	AdjustmentCount   atomic.Uint64
	LastAdjustment    atomic.Int64 // Unix timestamp
	AverageShareTime  atomic.Uint64 // Nanoseconds
	ShareRateVariance atomic.Uint64
}

// DifficultyAdjuster implements the adjustment algorithm
type DifficultyAdjuster struct {
	config         *DifficultyConfig
	history        []DifficultySnapshot
	historyMu      sync.RWMutex
	predictionModel *PredictionModel
}

// DifficultySnapshot represents a point-in-time difficulty state
type DifficultySnapshot struct {
	Timestamp       time.Time
	Difficulty      uint64
	ShareRate       float64
	HashRate        float64
	MinerCount      int
	NetworkDiff     uint64
}

// NewDifficultyManager creates a new difficulty manager
func NewDifficultyManager(logger *zap.Logger, config *DifficultyConfig) *DifficultyManager {
	if config == nil {
		config = DefaultDifficultyConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	dm := &DifficultyManager{
		logger:          logger,
		config:          config,
		baseDiff:        config.BaseDifficulty,
		minerDiffs:      make(map[string]*MinerDifficulty),
		shareStats:      &ShareStatistics{},
		adjustmentStats: &AdjustmentStatistics{},
		adjuster:        NewDifficultyAdjuster(config),
		ctx:             ctx,
		cancel:          cancel,
	}
	
	dm.currentDiff.Store(config.BaseDifficulty)
	
	return dm
}

// Start starts the difficulty manager
func (dm *DifficultyManager) Start() error {
	dm.logger.Info("Starting difficulty manager",
		zap.Uint64("base_difficulty", dm.baseDiff),
		zap.Duration("target_share_time", dm.config.TargetShareTime),
		zap.Bool("vardiff_enabled", dm.config.EnableVardiff),
	)
	
	// Start adjustment loop
	dm.wg.Add(1)
	go dm.adjustmentLoop()
	
	// Start vardiff loop if enabled
	if dm.config.EnableVardiff {
		dm.wg.Add(1)
		go dm.vardiffLoop()
	}
	
	// Start statistics collector
	dm.wg.Add(1)
	go dm.statisticsLoop()
	
	return nil
}

// Stop stops the difficulty manager
func (dm *DifficultyManager) Stop() error {
	dm.logger.Info("Stopping difficulty manager")
	
	dm.cancel()
	dm.wg.Wait()
	
	return nil
}

// SubmitShare processes a submitted share and updates statistics
func (dm *DifficultyManager) SubmitShare(minerID string, share *Share) error {
	// Update global statistics
	dm.shareStats.TotalShares.Add(1)
	
	if share.Valid {
		dm.shareStats.ValidShares.Add(1)
	} else if share.Stale {
		dm.shareStats.StaleShares.Add(1)
	} else {
		dm.shareStats.InvalidShares.Add(1)
	}
	
	// Record share timestamp
	dm.shareStats.timestampsMu.Lock()
	dm.shareStats.shareTimestamps = append(dm.shareStats.shareTimestamps, time.Now())
	
	// Keep only recent timestamps
	cutoff := time.Now().Add(-dm.config.ShareWindow)
	for len(dm.shareStats.shareTimestamps) > 0 && dm.shareStats.shareTimestamps[0].Before(cutoff) {
		dm.shareStats.shareTimestamps = dm.shareStats.shareTimestamps[1:]
	}
	dm.shareStats.timestampsMu.Unlock()
	
	// Update miner statistics
	if dm.config.EnableVardiff {
		dm.updateMinerStats(minerID, share)
	}
	
	return nil
}

// GetDifficulty returns the current difficulty for a miner
func (dm *DifficultyManager) GetDifficulty(minerID string) uint64 {
	if !dm.config.EnableVardiff {
		return dm.currentDiff.Load()
	}
	
	dm.minerDiffsMu.RLock()
	minerDiff, exists := dm.minerDiffs[minerID]
	dm.minerDiffsMu.RUnlock()
	
	if !exists {
		return dm.currentDiff.Load()
	}
	
	minerDiff.mu.RLock()
	difficulty := minerDiff.CurrentDiff
	minerDiff.mu.RUnlock()
	
	return difficulty
}

// SetNetworkDifficulty updates the network difficulty
func (dm *DifficultyManager) SetNetworkDifficulty(diff uint64) {
	dm.networkDiff.Store(diff)
	
	if dm.config.AutoAdjustToNetwork {
		// Trigger immediate adjustment
		go dm.adjustToNetworkDifficulty()
	}
}

// GetStatistics returns current difficulty statistics
func (dm *DifficultyManager) GetStatistics() DifficultyStats {
	return DifficultyStats{
		CurrentDifficulty:  dm.currentDiff.Load(),
		NetworkDifficulty:  dm.networkDiff.Load(),
		TotalShares:        dm.shareStats.TotalShares.Load(),
		ValidShares:        dm.shareStats.ValidShares.Load(),
		StaleShares:        dm.shareStats.StaleShares.Load(),
		InvalidShares:      dm.shareStats.InvalidShares.Load(),
		AdjustmentCount:    dm.adjustmentStats.AdjustmentCount.Load(),
		LastAdjustment:     time.Unix(dm.adjustmentStats.LastAdjustment.Load(), 0),
		AverageShareTime:   time.Duration(dm.adjustmentStats.AverageShareTime.Load()),
		ShareRate:          dm.calculateShareRate(),
		ActiveMinerCount:   len(dm.minerDiffs),
	}
}

// Private methods

func (dm *DifficultyManager) adjustmentLoop() {
	defer dm.wg.Done()
	
	ticker := time.NewTicker(dm.config.AdjustmentInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dm.adjustDifficulty()
			
		case <-dm.ctx.Done():
			return
		}
	}
}

func (dm *DifficultyManager) vardiffLoop() {
	defer dm.wg.Done()
	
	ticker := time.NewTicker(dm.config.VardiffRetargetTime)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dm.adjustMinerDifficulties()
			
		case <-dm.ctx.Done():
			return
		}
	}
}

func (dm *DifficultyManager) statisticsLoop() {
	defer dm.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dm.updateStatistics()
			
		case <-dm.ctx.Done():
			return
		}
	}
}

func (dm *DifficultyManager) adjustDifficulty() {
	currentDiff := dm.currentDiff.Load()
	shareRate := dm.calculateShareRate()
	
	// Calculate target share rate
	targetRate := 60.0 / dm.config.TargetShareTime.Seconds() // Shares per minute
	
	// Calculate adjustment factor
	factor := shareRate / targetRate
	
	// Apply smoothing
	if dm.config.SmoothingFactor > 0 {
		factor = 1.0 + (factor-1.0)*dm.config.SmoothingFactor
	}
	
	// Limit adjustment factor
	maxFactor := dm.config.MaxAdjustmentFactor
	if factor > maxFactor {
		factor = maxFactor
	} else if factor < 1.0/maxFactor {
		factor = 1.0 / maxFactor
	}
	
	// Calculate new difficulty
	newDiff := uint64(float64(currentDiff) * factor)
	
	// Apply limits
	if newDiff < dm.config.MinDifficulty {
		newDiff = dm.config.MinDifficulty
	} else if newDiff > dm.config.MaxDifficulty {
		newDiff = dm.config.MaxDifficulty
	}
	
	// Apply change if significant
	if math.Abs(float64(newDiff-currentDiff))/float64(currentDiff) > 0.05 { // 5% threshold
		dm.currentDiff.Store(newDiff)
		dm.adjustmentStats.AdjustmentCount.Add(1)
		dm.adjustmentStats.LastAdjustment.Store(time.Now().Unix())
		
		dm.logger.Info("Adjusted pool difficulty",
			zap.Uint64("old_difficulty", currentDiff),
			zap.Uint64("new_difficulty", newDiff),
			zap.Float64("share_rate", shareRate),
			zap.Float64("target_rate", targetRate),
			zap.Float64("adjustment_factor", factor),
		)
		
		// Record snapshot
		dm.adjuster.RecordSnapshot(DifficultySnapshot{
			Timestamp:   time.Now(),
			Difficulty:  newDiff,
			ShareRate:   shareRate,
			MinerCount:  len(dm.minerDiffs),
			NetworkDiff: dm.networkDiff.Load(),
		})
	}
}

func (dm *DifficultyManager) adjustMinerDifficulties() {
	dm.minerDiffsMu.RLock()
	miners := make([]*MinerDifficulty, 0, len(dm.minerDiffs))
	for _, miner := range dm.minerDiffs {
		miners = append(miners, miner)
	}
	dm.minerDiffsMu.RUnlock()
	
	for _, miner := range miners {
		dm.adjustMinerDifficulty(miner)
	}
}

func (dm *DifficultyManager) adjustMinerDifficulty(miner *MinerDifficulty) {
	miner.mu.Lock()
	defer miner.mu.Unlock()
	
	// Skip if recently adjusted
	if time.Since(miner.LastAdjustment) < dm.config.VardiffRetargetTime {
		return
	}
	
	// Calculate miner's share rate
	shareRate := dm.calculateMinerShareRate(miner)
	targetRate := 60.0 / dm.config.TargetShareTime.Seconds()
	
	// Skip if no recent shares
	if shareRate == 0 {
		return
	}
	
	// Calculate adjustment
	factor := shareRate / targetRate
	
	// Apply variance factor
	variance := dm.config.VardiffVariance
	if factor > 1+variance || factor < 1-variance {
		// Apply smoothing
		factor = 1.0 + (factor-1.0)*0.5
		
		// Calculate new difficulty
		newDiff := uint64(float64(miner.CurrentDiff) * factor)
		
		// Apply limits
		if newDiff < dm.config.MinDifficulty {
			newDiff = dm.config.MinDifficulty
		} else if newDiff > dm.config.MaxDifficulty {
			newDiff = dm.config.MaxDifficulty
		}
		
		dm.logger.Debug("Adjusted miner difficulty",
			zap.String("miner_id", miner.MinerID),
			zap.Uint64("old_difficulty", miner.CurrentDiff),
			zap.Uint64("new_difficulty", newDiff),
			zap.Float64("share_rate", shareRate),
		)
		
		miner.CurrentDiff = newDiff
		miner.LastAdjustment = time.Now()
	}
}

func (dm *DifficultyManager) adjustToNetworkDifficulty() {
	netDiff := dm.networkDiff.Load()
	if netDiff == 0 {
		return
	}
	
	// Calculate pool difficulty based on network difficulty
	poolDiff := uint64(float64(netDiff) * dm.config.NetworkDiffRatio)
	
	// Apply limits
	if poolDiff < dm.config.MinDifficulty {
		poolDiff = dm.config.MinDifficulty
	} else if poolDiff > dm.config.MaxDifficulty {
		poolDiff = dm.config.MaxDifficulty
	}
	
	currentDiff := dm.currentDiff.Load()
	if poolDiff != currentDiff {
		dm.currentDiff.Store(poolDiff)
		
		dm.logger.Info("Adjusted to network difficulty",
			zap.Uint64("network_difficulty", netDiff),
			zap.Uint64("pool_difficulty", poolDiff),
			zap.Float64("ratio", dm.config.NetworkDiffRatio),
		)
	}
}

func (dm *DifficultyManager) updateMinerStats(minerID string, share *Share) {
	dm.minerDiffsMu.Lock()
	miner, exists := dm.minerDiffs[minerID]
	if !exists {
		miner = &MinerDifficulty{
			MinerID:     minerID,
			CurrentDiff: dm.currentDiff.Load(),
			ShareTimes:  make([]time.Time, 0, 100),
		}
		dm.minerDiffs[minerID] = miner
	}
	dm.minerDiffsMu.Unlock()
	
	miner.mu.Lock()
	defer miner.mu.Unlock()
	
	// Update share statistics
	miner.ShareCount++
	if share.Valid {
		miner.Valid++
	} else if share.Stale {
		miner.Stale++
	}
	
	// Record share time
	now := time.Now()
	miner.LastShare = now
	miner.ShareTimes = append(miner.ShareTimes, now)
	
	// Keep only recent share times
	cutoff := now.Add(-dm.config.ShareWindow)
	for len(miner.ShareTimes) > 0 && miner.ShareTimes[0].Before(cutoff) {
		miner.ShareTimes = miner.ShareTimes[1:]
	}
	
	// Update hash rate estimate
	if share.Valid && share.Difficulty > 0 {
		miner.HashRate = dm.estimateHashRate(miner)
	}
}

func (dm *DifficultyManager) calculateShareRate() float64 {
	dm.shareStats.timestampsMu.RLock()
	defer dm.shareStats.timestampsMu.RUnlock()
	
	if len(dm.shareStats.shareTimestamps) < 2 {
		return 0
	}
	
	// Calculate shares per minute
	firstTime := dm.shareStats.shareTimestamps[0]
	lastTime := dm.shareStats.shareTimestamps[len(dm.shareStats.shareTimestamps)-1]
	duration := lastTime.Sub(firstTime).Minutes()
	
	if duration == 0 {
		return 0
	}
	
	return float64(len(dm.shareStats.shareTimestamps)) / duration
}

func (dm *DifficultyManager) calculateMinerShareRate(miner *MinerDifficulty) float64 {
	if len(miner.ShareTimes) < 2 {
		return 0
	}
	
	firstTime := miner.ShareTimes[0]
	lastTime := miner.ShareTimes[len(miner.ShareTimes)-1]
	duration := lastTime.Sub(firstTime).Minutes()
	
	if duration == 0 {
		return 0
	}
	
	return float64(len(miner.ShareTimes)) / duration
}

func (dm *DifficultyManager) estimateHashRate(miner *MinerDifficulty) float64 {
	if len(miner.ShareTimes) < 2 {
		return 0
	}
	
	// Estimate based on difficulty and share rate
	shareRate := dm.calculateMinerShareRate(miner)
	if shareRate == 0 {
		return 0
	}
	
	// Hash rate = difficulty * 2^32 / share_time
	// This is a simplified estimate
	diff := new(big.Int).SetUint64(miner.CurrentDiff)
	pow32 := new(big.Int).Lsh(big.NewInt(1), 32)
	hashesPerShare := new(big.Int).Mul(diff, pow32)
	
	// Convert to hashes per second
	sharesPerSecond := shareRate / 60.0
	hashesPerSecond := new(big.Float).SetInt(hashesPerShare)
	hashesPerSecond.Mul(hashesPerSecond, big.NewFloat(sharesPerSecond))
	
	result, _ := hashesPerSecond.Float64()
	return result
}

func (dm *DifficultyManager) updateStatistics() {
	// Calculate average share time
	dm.shareStats.timestampsMu.RLock()
	if len(dm.shareStats.shareTimestamps) >= 2 {
		totalTime := time.Duration(0)
		for i := 1; i < len(dm.shareStats.shareTimestamps); i++ {
			totalTime += dm.shareStats.shareTimestamps[i].Sub(dm.shareStats.shareTimestamps[i-1])
		}
		avgTime := totalTime / time.Duration(len(dm.shareStats.shareTimestamps)-1)
		dm.adjustmentStats.AverageShareTime.Store(uint64(avgTime))
	}
	dm.shareStats.timestampsMu.RUnlock()
	
	// Log statistics
	dm.logger.Debug("Difficulty statistics updated",
		zap.Uint64("current_difficulty", dm.currentDiff.Load()),
		zap.Float64("share_rate", dm.calculateShareRate()),
		zap.Int("active_miners", len(dm.minerDiffs)),
		zap.Uint64("total_shares", dm.shareStats.TotalShares.Load()),
	)
}

// Helper components

// NewDifficultyAdjuster creates a new difficulty adjuster
func NewDifficultyAdjuster(config *DifficultyConfig) *DifficultyAdjuster {
	return &DifficultyAdjuster{
		config:          config,
		history:         make([]DifficultySnapshot, 0, 1000),
		predictionModel: NewPredictionModel(),
	}
}

func (da *DifficultyAdjuster) RecordSnapshot(snapshot DifficultySnapshot) {
	da.historyMu.Lock()
	defer da.historyMu.Unlock()
	
	da.history = append(da.history, snapshot)
	
	// Keep only recent history
	if len(da.history) > 1000 {
		da.history = da.history[len(da.history)-1000:]
	}
}

// PredictionModel provides predictive difficulty adjustment
type PredictionModel struct {
	// Simple moving average for now
	// Could be enhanced with ML in the future
}

func NewPredictionModel() *PredictionModel {
	return &PredictionModel{}
}

// Helper structures

type DifficultyStats struct {
	CurrentDifficulty uint64
	NetworkDifficulty uint64
	TotalShares       uint64
	ValidShares       uint64
	StaleShares       uint64
	InvalidShares     uint64
	AdjustmentCount   uint64
	LastAdjustment    time.Time
	AverageShareTime  time.Duration
	ShareRate         float64
	ActiveMinerCount  int
}

type Share struct {
	MinerID    string
	JobID      string
	Nonce      uint64
	Hash       []byte
	Difficulty uint64
	Valid      bool
	Stale      bool
	Timestamp  time.Time
}

// DefaultDifficultyConfig returns default difficulty configuration
func DefaultDifficultyConfig() *DifficultyConfig {
	return &DifficultyConfig{
		BaseDifficulty:      65536,   // 2^16
		MinDifficulty:       1024,    // 2^10
		MaxDifficulty:       16777216, // 2^24
		TargetShareTime:     10 * time.Second,
		ShareWindow:         5 * time.Minute,
		AdjustmentInterval:  2 * time.Minute,
		MaxAdjustmentFactor: 2.0,
		SmoothingFactor:     0.3,
		EnableVardiff:       true,
		VardiffRetargetTime: 90 * time.Second,
		VardiffVariance:     0.2,
		MinShareRate:        0.5,  // 0.5 shares per minute
		MaxShareRate:        20.0, // 20 shares per minute
		NetworkDiffRatio:    0.001,
		AutoAdjustToNetwork: true,
	}
}