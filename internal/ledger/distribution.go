package ledger

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DistributionMethod represents the reward distribution method
type DistributionMethod string

const (
	// PPS - Pay Per Share
	PPS DistributionMethod = "pps"
	// PPLNS - Pay Per Last N Shares
	PPLNS DistributionMethod = "pplns"
	// PROP - Proportional
	PROP DistributionMethod = "prop"
	// FPPS - Full Pay Per Share
	FPPS DistributionMethod = "fpps"
)

// DistributionManager handles reward distribution calculations
type DistributionManager struct {
	logger       *zap.Logger
	method       DistributionMethod
	shareManager ShareManager
	
	// Configuration
	pplnsWindow  int           // Number of shares for PPLNS
	feePercent   float64       // Pool fee percentage
	minPayout    uint64        // Minimum payout threshold
	payoutBuffer time.Duration // Time to wait before distribution
	
	// State
	pendingPayouts map[string]uint64 // minerID -> pending amount
	paidRewards    map[string]uint64 // minerID -> total paid
	lastPayout     time.Time
	
	// Statistics
	totalDistributed atomic.Uint64
	totalFees        atomic.Uint64
	payoutCount      atomic.Uint64
	
	mu sync.RWMutex
	
	// Callbacks
	onPayout func(payouts map[string]uint64)
}

// ShareManager interface for accessing share data
type ShareManager interface {
	GetValidSharesCount(minerID string, since time.Time) int
	GetJobShares(jobID string) []*Share
	GetShareStatistics() map[string]interface{}
}

// Share represents a mining share (simplified interface)
type Share struct {
	MinerID    string
	Difficulty float64
	Timestamp  time.Time
	Valid      bool
}

// DistributionConfig contains distribution manager configuration
type DistributionConfig struct {
	Method       DistributionMethod `yaml:"method"`
	PPLNSWindow  int                `yaml:"pplns_window"`
	FeePercent   float64            `yaml:"fee_percent"`
	MinPayout    uint64             `yaml:"min_payout"`
	PayoutBuffer time.Duration      `yaml:"payout_buffer"`
}

// NewDistributionManager creates a new distribution manager
func NewDistributionManager(logger *zap.Logger, shareManager ShareManager, config DistributionConfig) *DistributionManager {
	// Set defaults
	if config.Method == "" {
		config.Method = PPLNS
	}
	if config.PPLNSWindow <= 0 {
		config.PPLNSWindow = 1000
	}
	if config.FeePercent < 0 {
		config.FeePercent = 1.0 // 1% default fee
	}
	if config.MinPayout <= 0 {
		config.MinPayout = 100000 // 0.001 in smallest unit
	}
	if config.PayoutBuffer <= 0 {
		config.PayoutBuffer = 10 * time.Minute
	}
	
	return &DistributionManager{
		logger:         logger,
		method:         config.Method,
		shareManager:   shareManager,
		pplnsWindow:    config.PPLNSWindow,
		feePercent:     config.FeePercent,
		minPayout:      config.MinPayout,
		payoutBuffer:   config.PayoutBuffer,
		pendingPayouts: make(map[string]uint64),
		paidRewards:    make(map[string]uint64),
	}
}

// CalculateRewards calculates reward distribution for a block
func (dm *DistributionManager) CalculateRewards(blockReward uint64, blockHash string) (map[string]uint64, error) {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	
	// Calculate pool fee
	poolFee := uint64(float64(blockReward) * dm.feePercent / 100)
	distributableReward := blockReward - poolFee
	
	dm.totalFees.Add(poolFee)
	
	// Calculate shares based on distribution method
	var shares map[string]float64
	var err error
	
	switch dm.method {
	case PPS:
		shares, err = dm.calculatePPSShares()
	case PPLNS:
		shares, err = dm.calculatePPLNSShares()
	case PROP:
		shares, err = dm.calculatePROPShares(blockHash)
	case FPPS:
		shares, err = dm.calculateFPPSShares()
	default:
		return nil, fmt.Errorf("unknown distribution method: %s", dm.method)
	}
	
	if err != nil {
		return nil, fmt.Errorf("failed to calculate shares: %w", err)
	}
	
	// Convert shares to rewards
	rewards := dm.sharesToRewards(shares, distributableReward)
	
	// Add to pending payouts
	for minerID, reward := range rewards {
		dm.pendingPayouts[minerID] += reward
	}
	
	dm.logger.Info("Calculated block rewards",
		zap.String("block_hash", blockHash),
		zap.Uint64("block_reward", blockReward),
		zap.Uint64("pool_fee", poolFee),
		zap.Int("miner_count", len(rewards)),
		zap.String("method", string(dm.method)),
	)
	
	return rewards, nil
}

// ProcessPayouts processes pending payouts that meet the threshold
func (dm *DistributionManager) ProcessPayouts() (map[string]uint64, error) {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	
	// Check if enough time has passed since last payout
	if time.Since(dm.lastPayout) < dm.payoutBuffer {
		return nil, nil
	}
	
	payouts := make(map[string]uint64)
	
	// Process each pending payout
	for minerID, amount := range dm.pendingPayouts {
		if amount >= dm.minPayout {
			payouts[minerID] = amount
			dm.paidRewards[minerID] += amount
			dm.totalDistributed.Add(amount)
			delete(dm.pendingPayouts, minerID)
		}
	}
	
	if len(payouts) > 0 {
		dm.lastPayout = time.Now()
		dm.payoutCount.Add(uint64(len(payouts)))
		
		// Notify callback
		if dm.onPayout != nil {
			dm.onPayout(payouts)
		}
		
		dm.logger.Info("Processed payouts",
			zap.Int("payout_count", len(payouts)),
			zap.Time("payout_time", dm.lastPayout),
		)
	}
	
	return payouts, nil
}

// GetPendingPayouts returns all pending payouts
func (dm *DistributionManager) GetPendingPayouts() map[string]uint64 {
	dm.mu.RLock()
	defer dm.mu.RUnlock()
	
	result := make(map[string]uint64)
	for minerID, amount := range dm.pendingPayouts {
		result[minerID] = amount
	}
	
	return result
}

// GetMinerStats returns statistics for a specific miner
func (dm *DistributionManager) GetMinerStats(minerID string) MinerStats {
	dm.mu.RLock()
	defer dm.mu.RUnlock()
	
	return MinerStats{
		MinerID:       minerID,
		PendingPayout: dm.pendingPayouts[minerID],
		TotalPaid:     dm.paidRewards[minerID],
		ShareCount:    dm.shareManager.GetValidSharesCount(minerID, time.Now().Add(-24*time.Hour)),
	}
}

// GetStatistics returns distribution manager statistics
func (dm *DistributionManager) GetStatistics() map[string]interface{} {
	dm.mu.RLock()
	pendingCount := len(dm.pendingPayouts)
	totalPending := uint64(0)
	for _, amount := range dm.pendingPayouts {
		totalPending += amount
	}
	dm.mu.RUnlock()
	
	return map[string]interface{}{
		"method":            string(dm.method),
		"total_distributed": dm.totalDistributed.Load(),
		"total_fees":        dm.totalFees.Load(),
		"payout_count":      dm.payoutCount.Load(),
		"pending_payouts":   pendingCount,
		"pending_amount":    totalPending,
		"min_payout":        dm.minPayout,
		"fee_percent":       dm.feePercent,
	}
}

// SetOnPayout sets the payout callback
func (dm *DistributionManager) SetOnPayout(callback func(payouts map[string]uint64)) {
	dm.onPayout = callback
}

// Private methods

// calculatePPSShares calculates shares for Pay Per Share method
func (dm *DistributionManager) calculatePPSShares() (map[string]float64, error) {
	// In PPS, miners are paid for each share regardless of blocks found
	// This is typically based on share difficulty and current network difficulty
	
	shares := make(map[string]float64)
	stats := dm.shareManager.GetShareStatistics()
	
	// For now, return equal shares (simplified)
	// In production, this would calculate based on actual share difficulties
	if minerCount, ok := stats["active_miners"].(int); ok && minerCount > 0 {
		sharePerMiner := 1.0 / float64(minerCount)
		// This is a placeholder - real implementation would iterate actual miners
		shares["placeholder"] = sharePerMiner
	}
	
	return shares, nil
}

// calculatePPLNSShares calculates shares for Pay Per Last N Shares method
func (dm *DistributionManager) calculatePPLNSShares() (map[string]float64, error) {
	// PPLNS pays based on the last N shares submitted
	// This reduces pool hopping but may have more variance
	
	shares := make(map[string]float64)
	
	// Get recent share statistics
	// In a real implementation, we would:
	// 1. Get the last N shares from shareManager
	// 2. Calculate each miner's contribution
	// 3. Weight by share difficulty
	
	// Placeholder implementation
	stats := dm.shareManager.GetShareStatistics()
	if validShares, ok := stats["valid_shares"].(uint64); ok && validShares > 0 {
		// This would be replaced with actual share iteration
		shares["placeholder"] = 1.0
	}
	
	return shares, nil
}

// calculatePROPShares calculates shares for Proportional method
func (dm *DistributionManager) calculatePROPShares(blockHash string) (map[string]float64, error) {
	// Proportional pays based on shares submitted for this specific block
	
	shares := make(map[string]float64)
	
	// This would get shares for the specific job/block
	// jobShares := dm.shareManager.GetJobShares(blockHash)
	
	// Placeholder implementation
	shares["placeholder"] = 1.0
	
	return shares, nil
}

// calculateFPPSShares calculates shares for Full Pay Per Share method
func (dm *DistributionManager) calculateFPPSShares() (map[string]float64, error) {
	// FPPS is like PPS but includes transaction fees
	// Similar calculation to PPS but with additional fee consideration
	
	return dm.calculatePPSShares()
}

// sharesToRewards converts share percentages to actual reward amounts
func (dm *DistributionManager) sharesToRewards(shares map[string]float64, totalReward uint64) map[string]uint64 {
	rewards := make(map[string]uint64)
	
	// Calculate total shares
	totalShares := 0.0
	for _, share := range shares {
		totalShares += share
	}
	
	if totalShares == 0 {
		return rewards
	}
	
	// Sort miners for deterministic distribution
	miners := make([]string, 0, len(shares))
	for miner := range shares {
		miners = append(miners, miner)
	}
	sort.Strings(miners)
	
	// Distribute rewards
	distributed := uint64(0)
	for i, miner := range miners {
		share := shares[miner]
		
		// For the last miner, give remaining to avoid rounding errors
		if i == len(miners)-1 {
			rewards[miner] = totalReward - distributed
		} else {
			reward := uint64(float64(totalReward) * (share / totalShares))
			rewards[miner] = reward
			distributed += reward
		}
	}
	
	return rewards
}

// MinerStats represents statistics for a miner
type MinerStats struct {
	MinerID       string `json:"miner_id"`
	PendingPayout uint64 `json:"pending_payout"`
	TotalPaid     uint64 `json:"total_paid"`
	ShareCount    int    `json:"share_count"`
}

// PayoutBatch represents a batch of payouts to process
type PayoutBatch struct {
	BatchID   string            `json:"batch_id"`
	Payouts   map[string]uint64 `json:"payouts"`
	Total     uint64            `json:"total"`
	Timestamp time.Time         `json:"timestamp"`
	Status    string            `json:"status"` // "pending", "processing", "completed", "failed"
}

// DistributionHistory tracks historical distributions
type DistributionHistory struct {
	BlockHash    string            `json:"block_hash"`
	BlockHeight  uint64            `json:"block_height"`
	BlockReward  uint64            `json:"block_reward"`
	PoolFee      uint64            `json:"pool_fee"`
	Distributions map[string]uint64 `json:"distributions"`
	Method       DistributionMethod `json:"method"`
	Timestamp    time.Time         `json:"timestamp"`
}