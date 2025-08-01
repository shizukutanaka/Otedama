package consensus

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"go.uber.org/zap"
)

// PoolStateMachine implements the state machine for P2P pool consensus
// Following John Carmack's principle: "If you want to set off and go develop some grand new thing, you don't need millions of dollars of capitalization. You need enough pizza and Diet Coke to stick in your refrigerator, a cheap PC to work on, and the dedication to go through with it."
type PoolStateMachine struct {
	logger *zap.Logger
	
	// Pool state
	shares      map[string]*MinerShares // minerID -> shares
	blocks      []FoundBlock
	payments    []Payment
	
	// Pool configuration (consensus-driven)
	poolConfig  PoolConfig
	
	// Mutexes
	sharesMu    sync.RWMutex
	blocksMu    sync.RWMutex
	paymentsMu  sync.RWMutex
	configMu    sync.RWMutex
	
	// Snapshot support
	lastSnapshot time.Time
}

// MinerShares tracks shares for a miner
type MinerShares struct {
	MinerID      string
	TotalShares  uint64
	ValidShares  uint64
	InvalidShares uint64
	LastShare    time.Time
	Balance      *big.Int
	
	// Reputation (for ZKP-based trust)
	Reputation   float64
	JoinTime     time.Time
}

// FoundBlock represents a block found by the pool
type FoundBlock struct {
	Height       uint64
	Hash         string
	Finder       string
	Reward       *big.Int
	Timestamp    time.Time
	Distributed  bool
}

// Payment represents a payout to miners
type Payment struct {
	PaymentID    string
	MinerID      string
	Amount       *big.Int
	TxHash       string
	Timestamp    time.Time
	Status       string // pending, confirmed, failed
}

// PoolConfig represents consensus-driven pool configuration
type PoolConfig struct {
	PoolFee      float64
	MinPayout    *big.Int
	PayoutScheme string // PPLNS, PPS, PROP
	ShareWindow  time.Duration
	
	// Governance parameters
	VotingPeriod time.Duration
	Quorum       float64
}

// Command types for the state machine
type CommandType string

const (
	CmdSubmitShare    CommandType = "submit_share"
	CmdFoundBlock     CommandType = "found_block"
	CmdProcessPayout  CommandType = "process_payout"
	CmdUpdateConfig   CommandType = "update_config"
	CmdAddMiner       CommandType = "add_miner"
	CmdRemoveMiner    CommandType = "remove_miner"
	CmdUpdateBalance  CommandType = "update_balance"
)

// Command represents a state machine command
type Command struct {
	Type      CommandType
	Data      json.RawMessage
	Timestamp time.Time
}

// Share submission data
type ShareData struct {
	MinerID    string
	Difficulty uint64
	Valid      bool
	JobID      string
}

// Block data
type BlockData struct {
	Height  uint64
	Hash    string
	Finder  string
	Reward  string // big.Int as string
}

// Payout data
type PayoutData struct {
	Payments []PaymentData
}

type PaymentData struct {
	MinerID string
	Amount  string // big.Int as string
}

// Config update data
type ConfigData struct {
	PoolFee      *float64
	MinPayout    *string // big.Int as string
	PayoutScheme *string
}

// NewPoolStateMachine creates a new pool state machine
func NewPoolStateMachine(logger *zap.Logger) *PoolStateMachine {
	return &PoolStateMachine{
		logger:   logger,
		shares:   make(map[string]*MinerShares),
		blocks:   make([]FoundBlock, 0),
		payments: make([]Payment, 0),
		poolConfig: PoolConfig{
			PoolFee:      0.01, // 1%
			MinPayout:    big.NewInt(100000000000000000), // 0.1 ETH
			PayoutScheme: "PPLNS",
			ShareWindow:  3 * time.Hour,
			VotingPeriod: 24 * time.Hour,
			Quorum:       0.51,
		},
		lastSnapshot: time.Now(),
	}
}

// Apply applies a command to the state machine
func (psm *PoolStateMachine) Apply(command interface{}) (interface{}, error) {
	cmd, ok := command.(Command)
	if !ok {
		// Try to unmarshal if it's raw JSON
		if err := json.Unmarshal(command.([]byte), &cmd); err != nil {
			return nil, fmt.Errorf("invalid command type: %T", command)
		}
	}
	
	psm.logger.Debug("Applying command", 
		zap.String("type", string(cmd.Type)),
		zap.Time("timestamp", cmd.Timestamp))
	
	switch cmd.Type {
	case CmdSubmitShare:
		return psm.applySubmitShare(cmd.Data)
		
	case CmdFoundBlock:
		return psm.applyFoundBlock(cmd.Data)
		
	case CmdProcessPayout:
		return psm.applyProcessPayout(cmd.Data)
		
	case CmdUpdateConfig:
		return psm.applyUpdateConfig(cmd.Data)
		
	case CmdAddMiner:
		return psm.applyAddMiner(cmd.Data)
		
	case CmdRemoveMiner:
		return psm.applyRemoveMiner(cmd.Data)
		
	case CmdUpdateBalance:
		return psm.applyUpdateBalance(cmd.Data)
		
	default:
		return nil, fmt.Errorf("unknown command type: %s", cmd.Type)
	}
}

// Snapshot creates a snapshot of the current state
func (psm *PoolStateMachine) Snapshot() ([]byte, error) {
	psm.sharesMu.RLock()
	psm.blocksMu.RLock()
	psm.paymentsMu.RLock()
	psm.configMu.RLock()
	defer psm.sharesMu.RUnlock()
	defer psm.blocksMu.RUnlock()
	defer psm.paymentsMu.RUnlock()
	defer psm.configMu.RUnlock()
	
	snapshot := struct {
		Shares       map[string]*MinerShares `json:"shares"`
		Blocks       []FoundBlock            `json:"blocks"`
		Payments     []Payment               `json:"payments"`
		PoolConfig   PoolConfig              `json:"pool_config"`
		Timestamp    time.Time               `json:"timestamp"`
	}{
		Shares:     psm.shares,
		Blocks:     psm.blocks,
		Payments:   psm.payments,
		PoolConfig: psm.poolConfig,
		Timestamp:  time.Now(),
	}
	
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal snapshot: %w", err)
	}
	
	psm.lastSnapshot = time.Now()
	return data, nil
}

// Restore restores state from a snapshot
func (psm *PoolStateMachine) Restore(snapshot []byte) error {
	var data struct {
		Shares       map[string]*MinerShares `json:"shares"`
		Blocks       []FoundBlock            `json:"blocks"`
		Payments     []Payment               `json:"payments"`
		PoolConfig   PoolConfig              `json:"pool_config"`
		Timestamp    time.Time               `json:"timestamp"`
	}
	
	if err := json.Unmarshal(snapshot, &data); err != nil {
		return fmt.Errorf("failed to unmarshal snapshot: %w", err)
	}
	
	psm.sharesMu.Lock()
	psm.blocksMu.Lock()
	psm.paymentsMu.Lock()
	psm.configMu.Lock()
	defer psm.sharesMu.Unlock()
	defer psm.blocksMu.Unlock()
	defer psm.paymentsMu.Unlock()
	defer psm.configMu.Unlock()
	
	psm.shares = data.Shares
	psm.blocks = data.Blocks
	psm.payments = data.Payments
	psm.poolConfig = data.PoolConfig
	psm.lastSnapshot = data.Timestamp
	
	psm.logger.Info("Restored from snapshot", 
		zap.Time("snapshot_time", data.Timestamp),
		zap.Int("miners", len(data.Shares)),
		zap.Int("blocks", len(data.Blocks)))
	
	return nil
}

// Command application methods

func (psm *PoolStateMachine) applySubmitShare(data json.RawMessage) (interface{}, error) {
	var share ShareData
	if err := json.Unmarshal(data, &share); err != nil {
		return nil, err
	}
	
	psm.sharesMu.Lock()
	defer psm.sharesMu.Unlock()
	
	miner, exists := psm.shares[share.MinerID]
	if !exists {
		miner = &MinerShares{
			MinerID:   share.MinerID,
			Balance:   big.NewInt(0),
			JoinTime:  time.Now(),
			Reputation: 0.5, // Start with neutral reputation
		}
		psm.shares[share.MinerID] = miner
	}
	
	miner.TotalShares++
	if share.Valid {
		miner.ValidShares++
		// Update reputation positively
		miner.Reputation = updateReputation(miner.Reputation, true)
	} else {
		miner.InvalidShares++
		// Update reputation negatively
		miner.Reputation = updateReputation(miner.Reputation, false)
	}
	miner.LastShare = time.Now()
	
	return nil, nil
}

func (psm *PoolStateMachine) applyFoundBlock(data json.RawMessage) (interface{}, error) {
	var block BlockData
	if err := json.Unmarshal(data, &block); err != nil {
		return nil, err
	}
	
	reward, ok := new(big.Int).SetString(block.Reward, 10)
	if !ok {
		return nil, errors.New("invalid reward amount")
	}
	
	psm.blocksMu.Lock()
	psm.blocks = append(psm.blocks, FoundBlock{
		Height:      block.Height,
		Hash:        block.Hash,
		Finder:      block.Finder,
		Reward:      reward,
		Timestamp:   time.Now(),
		Distributed: false,
	})
	psm.blocksMu.Unlock()
	
	// Update finder's reputation
	psm.sharesMu.Lock()
	if miner, exists := psm.shares[block.Finder]; exists {
		miner.Reputation = updateReputation(miner.Reputation, true)
	}
	psm.sharesMu.Unlock()
	
	psm.logger.Info("Block found", 
		zap.Uint64("height", block.Height),
		zap.String("finder", block.Finder),
		zap.String("reward", reward.String()))
	
	return nil, nil
}

func (psm *PoolStateMachine) applyProcessPayout(data json.RawMessage) (interface{}, error) {
	var payout PayoutData
	if err := json.Unmarshal(data, &payout); err != nil {
		return nil, err
	}
	
	psm.paymentsMu.Lock()
	defer psm.paymentsMu.Unlock()
	
	for _, payment := range payout.Payments {
		amount, ok := new(big.Int).SetString(payment.Amount, 10)
		if !ok {
			continue
		}
		
		psm.payments = append(psm.payments, Payment{
			PaymentID: fmt.Sprintf("pay_%d", time.Now().UnixNano()),
			MinerID:   payment.MinerID,
			Amount:    amount,
			Timestamp: time.Now(),
			Status:    "pending",
		})
		
		// Update miner balance
		psm.sharesMu.Lock()
		if miner, exists := psm.shares[payment.MinerID]; exists {
			miner.Balance.Sub(miner.Balance, amount)
		}
		psm.sharesMu.Unlock()
	}
	
	return nil, nil
}

func (psm *PoolStateMachine) applyUpdateConfig(data json.RawMessage) (interface{}, error) {
	var config ConfigData
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	
	psm.configMu.Lock()
	defer psm.configMu.Unlock()
	
	if config.PoolFee != nil {
		psm.poolConfig.PoolFee = *config.PoolFee
	}
	
	if config.MinPayout != nil {
		minPayout, ok := new(big.Int).SetString(*config.MinPayout, 10)
		if ok {
			psm.poolConfig.MinPayout = minPayout
		}
	}
	
	if config.PayoutScheme != nil {
		psm.poolConfig.PayoutScheme = *config.PayoutScheme
	}
	
	return nil, nil
}

func (psm *PoolStateMachine) applyAddMiner(data json.RawMessage) (interface{}, error) {
	var minerID string
	if err := json.Unmarshal(data, &minerID); err != nil {
		return nil, err
	}
	
	psm.sharesMu.Lock()
	defer psm.sharesMu.Unlock()
	
	if _, exists := psm.shares[minerID]; !exists {
		psm.shares[minerID] = &MinerShares{
			MinerID:    minerID,
			Balance:    big.NewInt(0),
			JoinTime:   time.Now(),
			Reputation: 0.5,
		}
	}
	
	return nil, nil
}

func (psm *PoolStateMachine) applyRemoveMiner(data json.RawMessage) (interface{}, error) {
	var minerID string
	if err := json.Unmarshal(data, &minerID); err != nil {
		return nil, err
	}
	
	psm.sharesMu.Lock()
	defer psm.sharesMu.Unlock()
	
	delete(psm.shares, minerID)
	
	return nil, nil
}

func (psm *PoolStateMachine) applyUpdateBalance(data json.RawMessage) (interface{}, error) {
	var update struct {
		MinerID string
		Amount  string
		Add     bool
	}
	if err := json.Unmarshal(data, &update); err != nil {
		return nil, err
	}
	
	amount, ok := new(big.Int).SetString(update.Amount, 10)
	if !ok {
		return nil, errors.New("invalid amount")
	}
	
	psm.sharesMu.Lock()
	defer psm.sharesMu.Unlock()
	
	if miner, exists := psm.shares[update.MinerID]; exists {
		if update.Add {
			miner.Balance.Add(miner.Balance, amount)
		} else {
			miner.Balance.Sub(miner.Balance, amount)
		}
	}
	
	return nil, nil
}

// Query methods (read-only, no consensus needed)

// GetMinerStats returns statistics for a miner
func (psm *PoolStateMachine) GetMinerStats(minerID string) (*MinerShares, error) {
	psm.sharesMu.RLock()
	defer psm.sharesMu.RUnlock()
	
	miner, exists := psm.shares[minerID]
	if !exists {
		return nil, fmt.Errorf("miner not found: %s", minerID)
	}
	
	// Return a copy to prevent external modification
	return &MinerShares{
		MinerID:       miner.MinerID,
		TotalShares:   miner.TotalShares,
		ValidShares:   miner.ValidShares,
		InvalidShares: miner.InvalidShares,
		LastShare:     miner.LastShare,
		Balance:       new(big.Int).Set(miner.Balance),
		Reputation:    miner.Reputation,
		JoinTime:      miner.JoinTime,
	}, nil
}

// GetPoolStats returns overall pool statistics
func (psm *PoolStateMachine) GetPoolStats() map[string]interface{} {
	psm.sharesMu.RLock()
	psm.blocksMu.RLock()
	psm.paymentsMu.RLock()
	psm.configMu.RLock()
	defer psm.sharesMu.RUnlock()
	defer psm.blocksMu.RUnlock()
	defer psm.paymentsMu.RUnlock()
	defer psm.configMu.RUnlock()
	
	totalShares := uint64(0)
	totalMiners := len(psm.shares)
	activeMiners := 0
	
	for _, miner := range psm.shares {
		totalShares += miner.ValidShares
		if time.Since(miner.LastShare) < 10*time.Minute {
			activeMiners++
		}
	}
	
	return map[string]interface{}{
		"total_miners":   totalMiners,
		"active_miners":  activeMiners,
		"total_shares":   totalShares,
		"blocks_found":   len(psm.blocks),
		"total_payments": len(psm.payments),
		"pool_fee":       psm.poolConfig.PoolFee,
		"payout_scheme":  psm.poolConfig.PayoutScheme,
		"min_payout":     psm.poolConfig.MinPayout.String(),
	}
}

// GetPendingPayouts returns miners with pending payouts
func (psm *PoolStateMachine) GetPendingPayouts() []PaymentData {
	psm.sharesMu.RLock()
	psm.configMu.RLock()
	defer psm.sharesMu.RUnlock()
	defer psm.configMu.RUnlock()
	
	var payouts []PaymentData
	
	for _, miner := range psm.shares {
		if miner.Balance.Cmp(psm.poolConfig.MinPayout) >= 0 {
			payouts = append(payouts, PaymentData{
				MinerID: miner.MinerID,
				Amount:  miner.Balance.String(),
			})
		}
	}
	
	return payouts
}

// Helper functions

func updateReputation(current float64, positive bool) float64 {
	// Simple reputation update algorithm
	// Could be replaced with more sophisticated model
	delta := 0.01
	if !positive {
		delta = -0.02 // Penalize bad behavior more
	}
	
	newRep := current + delta
	
	// Clamp between 0 and 1
	if newRep < 0 {
		newRep = 0
	} else if newRep > 1 {
		newRep = 1
	}
	
	return newRep
}

// CalculateRewards calculates rewards distribution for a block
func (psm *PoolStateMachine) CalculateRewards(blockReward *big.Int) map[string]*big.Int {
	psm.sharesMu.RLock()
	psm.configMu.RLock()
	defer psm.sharesMu.RUnlock()
	defer psm.configMu.RUnlock()
	
	rewards := make(map[string]*big.Int)
	
	// Calculate pool fee
	poolFee := new(big.Int).Mul(blockReward, big.NewInt(int64(psm.poolConfig.PoolFee*1000000)))
	poolFee.Div(poolFee, big.NewInt(1000000))
	
	// Remaining after fee
	remaining := new(big.Int).Sub(blockReward, poolFee)
	
	switch psm.poolConfig.PayoutScheme {
	case "PPLNS":
		rewards = psm.calculatePPLNS(remaining)
	case "PPS":
		rewards = psm.calculatePPS(remaining)
	case "PROP":
		rewards = psm.calculatePROP(remaining)
	default:
		rewards = psm.calculatePPLNS(remaining) // Default to PPLNS
	}
	
	return rewards
}

func (psm *PoolStateMachine) calculatePPLNS(reward *big.Int) map[string]*big.Int {
	// Pay Per Last N Shares
	rewards := make(map[string]*big.Int)
	windowStart := time.Now().Add(-psm.poolConfig.ShareWindow)
	
	totalShares := uint64(0)
	minerShares := make(map[string]uint64)
	
	for minerID, miner := range psm.shares {
		if miner.LastShare.After(windowStart) {
			shares := miner.ValidShares // Could implement window-based share counting
			totalShares += shares
			minerShares[minerID] = shares
		}
	}
	
	if totalShares == 0 {
		return rewards
	}
	
	// Distribute proportionally
	for minerID, shares := range minerShares {
		minerReward := new(big.Int).Mul(reward, big.NewInt(int64(shares)))
		minerReward.Div(minerReward, big.NewInt(int64(totalShares)))
		
		// Apply reputation bonus/penalty
		if miner, exists := psm.shares[minerID]; exists {
			repMultiplier := int64(miner.Reputation * 1000)
			minerReward.Mul(minerReward, big.NewInt(repMultiplier))
			minerReward.Div(minerReward, big.NewInt(1000))
		}
		
		rewards[minerID] = minerReward
	}
	
	return rewards
}

func (psm *PoolStateMachine) calculatePPS(reward *big.Int) map[string]*big.Int {
	// Pay Per Share - fixed amount per share
	// Implementation would depend on difficulty and block reward expectations
	rewards := make(map[string]*big.Int)
	
	// Simplified PPS calculation
	shareValue := new(big.Int).Div(reward, big.NewInt(1000000)) // Example share value
	
	for minerID, miner := range psm.shares {
		minerReward := new(big.Int).Mul(shareValue, big.NewInt(int64(miner.ValidShares)))
		rewards[minerID] = minerReward
	}
	
	return rewards
}

func (psm *PoolStateMachine) calculatePROP(reward *big.Int) map[string]*big.Int {
	// Proportional - simple proportional distribution
	rewards := make(map[string]*big.Int)
	
	totalShares := uint64(0)
	for _, miner := range psm.shares {
		totalShares += miner.ValidShares
	}
	
	if totalShares == 0 {
		return rewards
	}
	
	for minerID, miner := range psm.shares {
		minerReward := new(big.Int).Mul(reward, big.NewInt(int64(miner.ValidShares)))
		minerReward.Div(minerReward, big.NewInt(int64(totalShares)))
		rewards[minerID] = minerReward
	}
	
	return rewards
}