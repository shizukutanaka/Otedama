package pool

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// SimplePool provides a zpool-like mining pool where miners can connect with just a wallet address
type SimplePool struct {
	logger *zap.Logger
	config Config
	
	// Miner management - wallet address is the key
	miners     sync.Map // map[walletAddress]*Miner
	minerStats sync.Map // map[walletAddress]*MinerStats
	
	// Share tracking
	shares     *ShareManager
	
	// Payout system
	payouts    *PayoutManager
	
	// Current work
	currentJob *Job
	jobMu      sync.RWMutex
}

// Config for simple pool
type Config struct {
	MinPayout      float64       `yaml:"min_payout"`
	PayoutInterval time.Duration `yaml:"payout_interval"`
	PoolFee        float64       `yaml:"pool_fee"`
	Ports          map[string]int `yaml:"ports"` // algorithm -> port mapping
}

// Miner represents a miner connected with just a wallet address
type Miner struct {
	WalletAddress string
	WorkerName    string
	ConnectedAt   time.Time
	LastSeen      time.Time
	Hashrate      float64
}

// MinerStats tracks miner statistics
type MinerStats struct {
	ValidShares   uint64
	InvalidShares uint64
	TotalHashrate float64
	Balance       float64
	LastPayout    time.Time
}

// NewSimplePool creates a new simple mining pool
func NewSimplePool(logger *zap.Logger, config Config) *SimplePool {
	return &SimplePool{
		logger:  logger,
		config:  config,
		shares:  NewShareManager(),
		payouts: NewPayoutManager(config.MinPayout, config.PoolFee),
	}
}

// Start begins pool operations
func (p *SimplePool) Start(ctx context.Context) error {
	p.logger.Info("Starting simple mining pool",
		zap.Float64("min_payout", p.config.MinPayout),
		zap.Float64("pool_fee", p.config.PoolFee),
	)
	
	// Start payout processor
	go p.payoutProcessor(ctx)
	
	// Start stats updater
	go p.statsUpdater(ctx)
	
	return nil
}

// HandleConnection handles a new miner connection
func (p *SimplePool) HandleConnection(conn Connection) {
	// Extract wallet address from username
	// Format: WALLET_ADDRESS.WORKER_NAME or just WALLET_ADDRESS
	parts := strings.Split(conn.Username, ".")
	if len(parts) == 0 {
		conn.Reject("Invalid wallet address")
		return
	}
	
	walletAddress := parts[0]
	workerName := "default"
	if len(parts) > 1 {
		workerName = parts[1]
	}
	
	// Validate wallet address (basic validation)
	if !p.isValidWalletAddress(walletAddress) {
		conn.Reject("Invalid wallet address format")
		return
	}
	
	// Create or update miner
	miner := &Miner{
		WalletAddress: walletAddress,
		WorkerName:    workerName,
		ConnectedAt:   time.Now(),
		LastSeen:      time.Now(),
	}
	
	p.miners.Store(walletAddress, miner)
	
	// Initialize stats if new miner
	if _, exists := p.minerStats.Load(walletAddress); !exists {
		p.minerStats.Store(walletAddress, &MinerStats{})
	}
	
	// Send current job
	p.sendCurrentJob(conn)
	
	p.logger.Info("New miner connected",
		zap.String("wallet", walletAddress),
		zap.String("worker", workerName),
	)
}

// SubmitShare processes a share submission
func (p *SimplePool) SubmitShare(walletAddress string, share *Share) error {
	// Get miner
	minerInterface, exists := p.miners.Load(walletAddress)
	if !exists {
		return fmt.Errorf("unknown miner")
	}
	
	miner := minerInterface.(*Miner)
	miner.LastSeen = time.Now()
	
	// Validate share
	if err := p.shares.ValidateShare(share); err != nil {
		p.updateMinerStats(walletAddress, false, 0)
		return err
	}
	
	// Calculate share value
	shareValue := p.calculateShareValue(share)
	
	// Update miner stats
	p.updateMinerStats(walletAddress, true, shareValue)
	
	// Check if it's a block
	if share.IsBlock() {
		p.handleBlockFound(walletAddress, share)
	}
	
	return nil
}

// GetMinerStats returns statistics for a wallet address
func (p *SimplePool) GetMinerStats(walletAddress string) (*MinerStats, error) {
	statsInterface, exists := p.minerStats.Load(walletAddress)
	if !exists {
		return nil, fmt.Errorf("miner not found")
	}
	
	return statsInterface.(*MinerStats), nil
}

// GetPoolStats returns overall pool statistics
func (p *SimplePool) GetPoolStats() map[string]interface{} {
	totalHashrate := 0.0
	totalMiners := 0
	activeMiners := 0
	
	now := time.Now()
	p.miners.Range(func(key, value interface{}) bool {
		miner := value.(*Miner)
		totalMiners++
		
		if now.Sub(miner.LastSeen) < 5*time.Minute {
			activeMiners++
			totalHashrate += miner.Hashrate
		}
		
		return true
	})
	
	return map[string]interface{}{
		"hashrate":      totalHashrate,
		"total_miners":  totalMiners,
		"active_miners": activeMiners,
		"pool_fee":      p.config.PoolFee,
		"min_payout":    p.config.MinPayout,
	}
}

// Private methods

func (p *SimplePool) isValidWalletAddress(address string) bool {
	// Basic validation - can be enhanced based on coin type
	if len(address) < 26 || len(address) > 42 {
		return false
	}
	
	// Check if it starts with valid prefixes
	validPrefixes := []string{"1", "3", "bc1", "0x", "L", "M", "t", "r"}
	for _, prefix := range validPrefixes {
		if strings.HasPrefix(address, prefix) {
			return true
		}
	}
	
	return false
}

func (p *SimplePool) sendCurrentJob(conn Connection) {
	p.jobMu.RLock()
	job := p.currentJob
	p.jobMu.RUnlock()
	
	if job != nil {
		conn.SendJob(job)
	}
}

func (p *SimplePool) updateMinerStats(walletAddress string, valid bool, shareValue float64) {
	statsInterface, _ := p.minerStats.LoadOrStore(walletAddress, &MinerStats{})
	stats := statsInterface.(*MinerStats)
	
	if valid {
		stats.ValidShares++
		stats.Balance += shareValue
	} else {
		stats.InvalidShares++
	}
}

func (p *SimplePool) calculateShareValue(share *Share) float64 {
	// Simple PPLNS calculation
	baseValue := 1.0 / float64(share.Difficulty)
	feeMultiplier := 1.0 - (p.config.PoolFee / 100.0)
	return baseValue * feeMultiplier
}

func (p *SimplePool) handleBlockFound(walletAddress string, share *Share) {
	p.logger.Info("Block found!",
		zap.String("wallet", walletAddress),
		zap.String("hash", share.Hash),
	)
	
	// Distribute block reward
	p.payouts.DistributeBlockReward(share.BlockReward)
}

func (p *SimplePool) payoutProcessor(ctx context.Context) {
	ticker := time.NewTicker(p.config.PayoutInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.processPendingPayouts()
		}
	}
}

func (p *SimplePool) processPendingPayouts() {
	p.minerStats.Range(func(key, value interface{}) bool {
		walletAddress := key.(string)
		stats := value.(*MinerStats)
		
		if stats.Balance >= p.config.MinPayout {
			if err := p.payouts.SendPayout(walletAddress, stats.Balance); err != nil {
				p.logger.Error("Payout failed",
					zap.String("wallet", walletAddress),
					zap.Float64("amount", stats.Balance),
					zap.Error(err),
				)
			} else {
				stats.Balance = 0
				stats.LastPayout = time.Now()
			}
		}
		
		return true
	})
}

func (p *SimplePool) statsUpdater(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.updateHashrates()
		}
	}
}

func (p *SimplePool) updateHashrates() {
	// Calculate hashrate based on submitted shares
	// This is a simplified implementation
	p.miners.Range(func(key, value interface{}) bool {
		walletAddress := key.(string)
		miner := value.(*Miner)
		
		if stats, exists := p.minerStats.Load(walletAddress); exists {
			minerStats := stats.(*MinerStats)
			// Simple hashrate calculation based on shares
			miner.Hashrate = float64(minerStats.ValidShares) * 4294967296 / 600 // Assumes 10 minute window
		}
		
		return true
	})
}

// Connection interface for miner connections
type Connection interface {
	Username string
	SendJob(job *Job)
	Reject(reason string)
}

// Job represents mining work
type Job struct {
	ID         string
	PrevHash   string
	Coinbase1  string
	Coinbase2  string
	MerkleBranch []string
	Version    string
	NBits      string
	NTime      string
	CleanJobs  bool
}

// Share represents a mining share
type Share struct {
	JobID      string
	Nonce      string
	Hash       string
	Difficulty float64
	Timestamp  time.Time
	BlockReward float64
}

// IsBlock checks if share meets network difficulty
func (s *Share) IsBlock() bool {
	// Simplified check - implement actual difficulty comparison
	return s.Difficulty > 1000000000
}

// ShareManager handles share validation and tracking
type ShareManager struct {
	recentShares sync.Map
}

func NewShareManager() *ShareManager {
	return &ShareManager{}
}

func (sm *ShareManager) ValidateShare(share *Share) error {
	// Check for duplicate
	if _, exists := sm.recentShares.Load(share.Hash); exists {
		return fmt.Errorf("duplicate share")
	}
	
	// Store share
	sm.recentShares.Store(share.Hash, time.Now())
	
	// Clean old shares periodically
	go sm.cleanOldShares()
	
	return nil
}

func (sm *ShareManager) cleanOldShares() {
	cutoff := time.Now().Add(-10 * time.Minute)
	sm.recentShares.Range(func(key, value interface{}) bool {
		if value.(time.Time).Before(cutoff) {
			sm.recentShares.Delete(key)
		}
		return true
	})
}

// PayoutManager handles miner payouts
type PayoutManager struct {
	minPayout float64
	poolFee   float64
}

func NewPayoutManager(minPayout, poolFee float64) *PayoutManager {
	return &PayoutManager{
		minPayout: minPayout,
		poolFee:   poolFee,
	}
}

func (pm *PayoutManager) SendPayout(walletAddress string, amount float64) error {
	// Implement actual cryptocurrency transaction
	// This is a placeholder
	return nil
}

func (pm *PayoutManager) DistributeBlockReward(reward float64) {
	// Implement PPLNS distribution
	// This is a placeholder
}