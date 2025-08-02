package ledger

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// RewardLedger represents a reward distribution ledger for a mined block
type RewardLedger struct {
	BlockHash   string             `json:"block_hash"`
	BlockHeight uint64             `json:"block_height"`
	TotalReward uint64             `json:"total_reward"`
	Shares      map[string]float64 `json:"shares"`      // minerID -> share percentage
	Rewards     map[string]uint64  `json:"rewards"`     // minerID -> reward amount
	Timestamp   time.Time          `json:"timestamp"`
	Creator     string             `json:"creator"`
	Signature   []byte             `json:"signature"`
	Checksum    string             `json:"checksum"`
}

// LedgerManager manages reward ledgers and their synchronization
type LedgerManager struct {
	logger       *zap.Logger
	nodeID       string
	privateKey   *ecdsa.PrivateKey
	
	// Ledger storage
	ledgers      map[string]*RewardLedger  // blockHash -> ledger
	ledgerByHeight map[uint64]*RewardLedger // height -> ledger
	pendingLedgers map[string]*RewardLedger // ledgers awaiting confirmation
	
	// Statistics
	totalBlocks    atomic.Uint64
	totalRewards   atomic.Uint64
	conflictCount  atomic.Uint64
	
	// Consensus tracking
	ledgerVotes    map[string]map[string]int // blockHash -> nodeID -> vote count
	trustedNodes   map[string]float64        // nodeID -> trust score
	
	mu sync.RWMutex
	
	// Callbacks
	onLedgerConfirmed func(*RewardLedger)
	onConflict        func(blockHash string, ledgers []*RewardLedger)
}

// LedgerConfig contains ledger manager configuration
type LedgerConfig struct {
	MinConfirmations   int           `yaml:"min_confirmations"`
	ConsensusThreshold float64       `yaml:"consensus_threshold"`
	LedgerTTL         time.Duration `yaml:"ledger_ttl"`
	TrustDecayRate    float64       `yaml:"trust_decay_rate"`
}

// NewLedgerManager creates a new ledger manager
func NewLedgerManager(logger *zap.Logger, nodeID string, privateKey *ecdsa.PrivateKey, config LedgerConfig) *LedgerManager {
	// Set defaults
	if config.MinConfirmations <= 0 {
		config.MinConfirmations = 3
	}
	if config.ConsensusThreshold <= 0 {
		config.ConsensusThreshold = 0.51
	}
	if config.LedgerTTL <= 0 {
		config.LedgerTTL = 7 * 24 * time.Hour
	}
	if config.TrustDecayRate <= 0 {
		config.TrustDecayRate = 0.95
	}
	
	lm := &LedgerManager{
		logger:         logger,
		nodeID:         nodeID,
		privateKey:     privateKey,
		ledgers:        make(map[string]*RewardLedger),
		ledgerByHeight: make(map[uint64]*RewardLedger),
		pendingLedgers: make(map[string]*RewardLedger),
		ledgerVotes:    make(map[string]map[string]int),
		trustedNodes:   make(map[string]float64),
	}
	
	// Initialize trusted nodes with default trust
	lm.trustedNodes[nodeID] = 1.0
	
	return lm
}

// CreateRewardLedger creates a new reward ledger for a mined block
func (lm *LedgerManager) CreateRewardLedger(blockHash string, blockHeight uint64, totalReward uint64, shares map[string]float64) (*RewardLedger, error) {
	// Calculate rewards based on shares
	rewards := lm.calculateRewards(totalReward, shares)
	
	// Create ledger
	ledger := &RewardLedger{
		BlockHash:   blockHash,
		BlockHeight: blockHeight,
		TotalReward: totalReward,
		Shares:      shares,
		Rewards:     rewards,
		Timestamp:   time.Now(),
		Creator:     lm.nodeID,
	}
	
	// Calculate checksum
	ledger.Checksum = lm.calculateChecksum(ledger)
	
	// Sign ledger
	if err := lm.signLedger(ledger); err != nil {
		return nil, fmt.Errorf("failed to sign ledger: %w", err)
	}
	
	// Store in pending
	lm.mu.Lock()
	lm.pendingLedgers[blockHash] = ledger
	lm.mu.Unlock()
	
	lm.logger.Info("Created reward ledger",
		zap.String("block_hash", blockHash),
		zap.Uint64("block_height", blockHeight),
		zap.Uint64("total_reward", totalReward),
		zap.Int("miner_count", len(shares)),
	)
	
	return ledger, nil
}

// ReceiveLedger processes a ledger received from another node
func (lm *LedgerManager) ReceiveLedger(ledger *RewardLedger, senderID string) error {
	// Verify ledger integrity
	if err := lm.verifyLedger(ledger); err != nil {
		lm.updateTrustScore(senderID, -0.1)
		return fmt.Errorf("invalid ledger: %w", err)
	}
	
	lm.mu.Lock()
	defer lm.mu.Unlock()
	
	// Check if we already have this ledger
	if existing, exists := lm.ledgers[ledger.BlockHash]; exists {
		// Compare with existing
		if !lm.ledgersMatch(existing, ledger) {
			lm.conflictCount.Add(1)
			lm.handleConflict(ledger.BlockHash, existing, ledger)
		}
		return nil
	}
	
	// Add to pending if new
	lm.pendingLedgers[ledger.BlockHash] = ledger
	
	// Record vote
	if lm.ledgerVotes[ledger.BlockHash] == nil {
		lm.ledgerVotes[ledger.BlockHash] = make(map[string]int)
	}
	lm.ledgerVotes[ledger.BlockHash][senderID]++
	
	// Update trust score positively
	lm.updateTrustScore(senderID, 0.01)
	
	// Check if we have enough confirmations
	if lm.checkConsensus(ledger.BlockHash) {
		lm.confirmLedger(ledger.BlockHash)
	}
	
	return nil
}

// GetLedger retrieves a ledger by block hash
func (lm *LedgerManager) GetLedger(blockHash string) (*RewardLedger, error) {
	lm.mu.RLock()
	defer lm.mu.RUnlock()
	
	ledger, exists := lm.ledgers[blockHash]
	if !exists {
		return nil, fmt.Errorf("ledger not found for block: %s", blockHash)
	}
	
	return ledger, nil
}

// GetLedgerByHeight retrieves a ledger by block height
func (lm *LedgerManager) GetLedgerByHeight(height uint64) (*RewardLedger, error) {
	lm.mu.RLock()
	defer lm.mu.RUnlock()
	
	ledger, exists := lm.ledgerByHeight[height]
	if !exists {
		return nil, fmt.Errorf("ledger not found for height: %d", height)
	}
	
	return ledger, nil
}

// GetMinerRewards returns all rewards for a specific miner
func (lm *LedgerManager) GetMinerRewards(minerID string, since time.Time) []MinerReward {
	lm.mu.RLock()
	defer lm.mu.RUnlock()
	
	var rewards []MinerReward
	
	for _, ledger := range lm.ledgers {
		if ledger.Timestamp.Before(since) {
			continue
		}
		
		if reward, exists := ledger.Rewards[minerID]; exists && reward > 0 {
			rewards = append(rewards, MinerReward{
				BlockHash:   ledger.BlockHash,
				BlockHeight: ledger.BlockHeight,
				Amount:      reward,
				Share:       ledger.Shares[minerID],
				Timestamp:   ledger.Timestamp,
			})
		}
	}
	
	// Sort by timestamp
	sort.Slice(rewards, func(i, j int) bool {
		return rewards[i].Timestamp.After(rewards[j].Timestamp)
	})
	
	return rewards
}

// GetStatistics returns ledger manager statistics
func (lm *LedgerManager) GetStatistics() map[string]interface{} {
	lm.mu.RLock()
	confirmedCount := len(lm.ledgers)
	pendingCount := len(lm.pendingLedgers)
	trustedNodeCount := 0
	for _, trust := range lm.trustedNodes {
		if trust > 0.5 {
			trustedNodeCount++
		}
	}
	lm.mu.RUnlock()
	
	return map[string]interface{}{
		"total_blocks":      lm.totalBlocks.Load(),
		"total_rewards":     lm.totalRewards.Load(),
		"confirmed_ledgers": confirmedCount,
		"pending_ledgers":   pendingCount,
		"conflict_count":    lm.conflictCount.Load(),
		"trusted_nodes":     trustedNodeCount,
	}
}

// SetOnLedgerConfirmed sets the callback for when a ledger is confirmed
func (lm *LedgerManager) SetOnLedgerConfirmed(callback func(*RewardLedger)) {
	lm.onLedgerConfirmed = callback
}

// SetOnConflict sets the callback for when a conflict is detected
func (lm *LedgerManager) SetOnConflict(callback func(blockHash string, ledgers []*RewardLedger)) {
	lm.onConflict = callback
}

// Private methods

// calculateRewards distributes rewards based on shares
func (lm *LedgerManager) calculateRewards(totalReward uint64, shares map[string]float64) map[string]uint64 {
	rewards := make(map[string]uint64)
	
	// Calculate total shares
	totalShares := 0.0
	for _, share := range shares {
		totalShares += share
	}
	
	if totalShares == 0 {
		return rewards
	}
	
	// Distribute rewards proportionally
	distributed := uint64(0)
	miners := make([]string, 0, len(shares))
	for miner := range shares {
		miners = append(miners, miner)
	}
	sort.Strings(miners) // Ensure deterministic order
	
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

// calculateChecksum calculates ledger checksum for integrity
func (lm *LedgerManager) calculateChecksum(ledger *RewardLedger) string {
	// Create deterministic data for checksum
	data := struct {
		BlockHash   string
		BlockHeight uint64
		TotalReward uint64
		Shares      map[string]float64
		Rewards     map[string]uint64
		Creator     string
		Timestamp   int64
	}{
		BlockHash:   ledger.BlockHash,
		BlockHeight: ledger.BlockHeight,
		TotalReward: ledger.TotalReward,
		Shares:      ledger.Shares,
		Rewards:     ledger.Rewards,
		Creator:     ledger.Creator,
		Timestamp:   ledger.Timestamp.Unix(),
	}
	
	serialized, _ := json.Marshal(data)
	hash := sha256.Sum256(serialized)
	return hex.EncodeToString(hash[:])
}

// signLedger signs the ledger with the node's private key
func (lm *LedgerManager) signLedger(ledger *RewardLedger) error {
	// Create hash of ledger data
	data := ledger.Checksum + ledger.Creator
	hash := sha256.Sum256([]byte(data))
	
	// Sign the hash
	r, s, err := ecdsa.Sign(rand.Reader, lm.privateKey, hash[:])
	if err != nil {
		return err
	}
	
	// Encode signature
	signature := append(r.Bytes(), s.Bytes()...)
	ledger.Signature = signature
	
	return nil
}

// verifyLedger verifies ledger integrity and signature
func (lm *LedgerManager) verifyLedger(ledger *RewardLedger) error {
	// Verify checksum
	expectedChecksum := lm.calculateChecksum(ledger)
	if ledger.Checksum != expectedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, ledger.Checksum)
	}
	
	// Verify rewards calculation
	expectedRewards := lm.calculateRewards(ledger.TotalReward, ledger.Shares)
	for miner, reward := range expectedRewards {
		if ledger.Rewards[miner] != reward {
			return fmt.Errorf("reward mismatch for miner %s: expected %d, got %d", 
				miner, reward, ledger.Rewards[miner])
		}
	}
	
	// TODO: Verify signature (requires public key management)
	
	return nil
}

// ledgersMatch checks if two ledgers are identical
func (lm *LedgerManager) ledgersMatch(a, b *RewardLedger) bool {
	return a.Checksum == b.Checksum
}

// checkConsensus checks if a ledger has reached consensus
func (lm *LedgerManager) checkConsensus(blockHash string) bool {
	votes := lm.ledgerVotes[blockHash]
	if votes == nil {
		return false
	}
	
	// Calculate weighted votes based on trust scores
	totalVotes := 0.0
	totalTrust := 0.0
	
	for nodeID, voteCount := range votes {
		trust := lm.trustedNodes[nodeID]
		if trust <= 0 {
			trust = 0.1 // Minimum trust
		}
		totalVotes += float64(voteCount) * trust
		totalTrust += trust
	}
	
	// Check if we have enough confirmations
	if totalVotes >= 3 && totalVotes/totalTrust >= 0.51 {
		return true
	}
	
	return false
}

// confirmLedger moves a ledger from pending to confirmed
func (lm *LedgerManager) confirmLedger(blockHash string) {
	ledger, exists := lm.pendingLedgers[blockHash]
	if !exists {
		return
	}
	
	// Move to confirmed
	lm.ledgers[blockHash] = ledger
	lm.ledgerByHeight[ledger.BlockHeight] = ledger
	delete(lm.pendingLedgers, blockHash)
	
	// Update statistics
	lm.totalBlocks.Add(1)
	lm.totalRewards.Add(ledger.TotalReward)
	
	// Notify callback
	if lm.onLedgerConfirmed != nil {
		lm.onLedgerConfirmed(ledger)
	}
	
	lm.logger.Info("Ledger confirmed",
		zap.String("block_hash", blockHash),
		zap.Uint64("block_height", ledger.BlockHeight),
		zap.Uint64("total_reward", ledger.TotalReward),
	)
}

// handleConflict handles conflicting ledgers
func (lm *LedgerManager) handleConflict(blockHash string, ledgers ...*RewardLedger) {
	lm.logger.Warn("Ledger conflict detected",
		zap.String("block_hash", blockHash),
		zap.Int("ledger_count", len(ledgers)),
	)
	
	// Notify callback
	if lm.onConflict != nil {
		lm.onConflict(blockHash, ledgers)
	}
	
	// TODO: Implement conflict resolution strategy
	// For now, keep the ledger with more votes
}

// updateTrustScore updates the trust score for a node
func (lm *LedgerManager) updateTrustScore(nodeID string, delta float64) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	
	current := lm.trustedNodes[nodeID]
	if current == 0 {
		current = 0.5 // Start at neutral
	}
	
	// Update score
	current += delta
	
	// Clamp between 0 and 1
	if current < 0 {
		current = 0
	} else if current > 1 {
		current = 1
	}
	
	lm.trustedNodes[nodeID] = current
}

// DecayTrust applies trust decay to all nodes
func (lm *LedgerManager) DecayTrust(rate float64) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	
	for nodeID, trust := range lm.trustedNodes {
		// Don't decay our own trust
		if nodeID == lm.nodeID {
			continue
		}
		
		// Apply decay towards 0.5 (neutral)
		newTrust := trust*rate + 0.5*(1-rate)
		lm.trustedNodes[nodeID] = newTrust
	}
}

// CleanupOldLedgers removes ledgers older than TTL
func (lm *LedgerManager) CleanupOldLedgers(ttl time.Duration) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	
	now := time.Now()
	removed := 0
	
	for hash, ledger := range lm.ledgers {
		if now.Sub(ledger.Timestamp) > ttl {
			delete(lm.ledgers, hash)
			delete(lm.ledgerByHeight, ledger.BlockHeight)
			removed++
		}
	}
	
	if removed > 0 {
		lm.logger.Info("Cleaned up old ledgers",
			zap.Int("removed_count", removed),
			zap.Int("remaining_count", len(lm.ledgers)),
		)
	}
}

// MinerReward represents a reward entry for a miner
type MinerReward struct {
	BlockHash   string    `json:"block_hash"`
	BlockHeight uint64    `json:"block_height"`
	Amount      uint64    `json:"amount"`
	Share       float64   `json:"share"`
	Timestamp   time.Time `json:"timestamp"`
}

// SerializeLedger serializes a ledger for network transmission
func SerializeLedger(ledger *RewardLedger) ([]byte, error) {
	return json.Marshal(ledger)
}

// DeserializeLedger deserializes a ledger from network data
func DeserializeLedger(data []byte) (*RewardLedger, error) {
	var ledger RewardLedger
	if err := json.Unmarshal(data, &ledger); err != nil {
		return nil, err
	}
	return &ledger, nil
}

// LedgerSyncProtocol handles ledger synchronization between nodes
type LedgerSyncProtocol struct {
	manager *LedgerManager
	logger  *zap.Logger
}

// NewLedgerSyncProtocol creates a new ledger sync protocol
func NewLedgerSyncProtocol(manager *LedgerManager, logger *zap.Logger) *LedgerSyncProtocol {
	return &LedgerSyncProtocol{
		manager: manager,
		logger:  logger,
	}
}

// RequestLedgers requests ledgers from a specific height range
func (lsp *LedgerSyncProtocol) RequestLedgers(fromHeight, toHeight uint64) []byte {
	request := struct {
		Type       string `json:"type"`
		FromHeight uint64 `json:"from_height"`
		ToHeight   uint64 `json:"to_height"`
	}{
		Type:       "ledger_request",
		FromHeight: fromHeight,
		ToHeight:   toHeight,
	}
	
	data, _ := json.Marshal(request)
	return data
}

// HandleLedgerRequest processes a ledger request and returns matching ledgers
func (lsp *LedgerSyncProtocol) HandleLedgerRequest(fromHeight, toHeight uint64) ([]*RewardLedger, error) {
	lsp.manager.mu.RLock()
	defer lsp.manager.mu.RUnlock()
	
	var ledgers []*RewardLedger
	
	for height := fromHeight; height <= toHeight; height++ {
		if ledger, exists := lsp.manager.ledgerByHeight[height]; exists {
			ledgers = append(ledgers, ledger)
		}
	}
	
	return ledgers, nil
}