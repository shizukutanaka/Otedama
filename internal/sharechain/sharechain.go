package sharechain

import (
	"crypto/sha256"
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

// SharechainBlock represents a block in the sharechain
type SharechainBlock struct {
	Height       uint64             `json:"height"`
	PrevHash     string             `json:"prev_hash"`
	Hash         string             `json:"hash"`
	Timestamp    time.Time          `json:"timestamp"`
	Shares       []Share            `json:"shares"`
	MinerShares  map[string]uint64  `json:"miner_shares"`  // minerID -> share count
	Difficulty   float64            `json:"difficulty"`
	Creator      string             `json:"creator"`
	Signature    []byte             `json:"signature"`
	Nonce        uint64             `json:"nonce"`
}

// Share represents a mining share in the sharechain
type Share struct {
	ID          string    `json:"id"`
	MinerID     string    `json:"miner_id"`
	JobID       string    `json:"job_id"`
	Nonce       uint64    `json:"nonce"`
	Hash        string    `json:"hash"`
	Difficulty  float64   `json:"difficulty"`
	Timestamp   time.Time `json:"timestamp"`
	Valid       bool      `json:"valid"`
}

// Sharechain manages the P2P sharechain
type Sharechain struct {
	logger      *zap.Logger
	nodeID      string
	
	// Chain storage
	blocks      map[uint64]*SharechainBlock  // height -> block
	blockHashes map[string]*SharechainBlock  // hash -> block
	currentTip  *SharechainBlock
	
	// Share pool for next block
	pendingShares []Share
	
	// Fork handling
	forks       map[string][]*SharechainBlock // fork tip hash -> chain
	
	// Validation
	minDifficulty float64
	blockTime     time.Duration
	maxShares     int
	
	// Statistics
	totalBlocks   atomic.Uint64
	totalShares   atomic.Uint64
	forkCount     atomic.Uint64
	
	// Callbacks
	onNewBlock    func(*SharechainBlock)
	onForkDetected func(main, fork *SharechainBlock)
	
	mu sync.RWMutex
}

// SharechainConfig contains sharechain configuration
type SharechainConfig struct {
	MinDifficulty   float64       `yaml:"min_difficulty"`
	BlockTime       time.Duration `yaml:"block_time"`
	MaxSharesPerBlock int         `yaml:"max_shares_per_block"`
	ForkThreshold   int           `yaml:"fork_threshold"`
}

// NewSharechain creates a new sharechain instance
func NewSharechain(logger *zap.Logger, nodeID string, config SharechainConfig) *Sharechain {
	// Set defaults
	if config.MinDifficulty <= 0 {
		config.MinDifficulty = 1000
	}
	if config.BlockTime <= 0 {
		config.BlockTime = 30 * time.Second
	}
	if config.MaxSharesPerBlock <= 0 {
		config.MaxSharesPerBlock = 100
	}
	
	sc := &Sharechain{
		logger:        logger,
		nodeID:        nodeID,
		blocks:        make(map[uint64]*SharechainBlock),
		blockHashes:   make(map[string]*SharechainBlock),
		forks:         make(map[string][]*SharechainBlock),
		pendingShares: make([]Share, 0, config.MaxSharesPerBlock),
		minDifficulty: config.MinDifficulty,
		blockTime:     config.BlockTime,
		maxShares:     config.MaxSharesPerBlock,
	}
	
	// Create genesis block
	genesis := sc.createGenesisBlock()
	sc.blocks[0] = genesis
	sc.blockHashes[genesis.Hash] = genesis
	sc.currentTip = genesis
	
	return sc
}

// AddShare adds a share to the pending pool
func (sc *Sharechain) AddShare(share Share) error {
	// Validate share
	if err := sc.validateShare(share); err != nil {
		return fmt.Errorf("invalid share: %w", err)
	}
	
	sc.mu.Lock()
	defer sc.mu.Unlock()
	
	// Check if we have room for more shares
	if len(sc.pendingShares) >= sc.maxShares {
		// Remove oldest share
		sc.pendingShares = sc.pendingShares[1:]
	}
	
	// Add share
	sc.pendingShares = append(sc.pendingShares, share)
	sc.totalShares.Add(1)
	
	sc.logger.Debug("Share added to pending pool",
		zap.String("share_id", share.ID),
		zap.String("miner_id", share.MinerID),
		zap.Int("pending_count", len(sc.pendingShares)),
	)
	
	// Check if we should create a new block
	if sc.shouldCreateBlock() {
		go sc.createNewBlock()
	}
	
	return nil
}

// AddBlock adds a new block to the sharechain
func (sc *Sharechain) AddBlock(block *SharechainBlock) error {
	// Validate block
	if err := sc.validateBlock(block); err != nil {
		return fmt.Errorf("invalid block: %w", err)
	}
	
	sc.mu.Lock()
	defer sc.mu.Unlock()
	
	// Check if block already exists
	if _, exists := sc.blockHashes[block.Hash]; exists {
		return fmt.Errorf("block already exists: %s", block.Hash)
	}
	
	// Find parent block
	parent, exists := sc.blockHashes[block.PrevHash]
	if !exists {
		// Handle orphan block
		return sc.handleOrphanBlock(block)
	}
	
	// Check if this extends the main chain
	if parent.Hash == sc.currentTip.Hash {
		// Extends main chain
		sc.blocks[block.Height] = block
		sc.blockHashes[block.Hash] = block
		sc.currentTip = block
		sc.totalBlocks.Add(1)
		
		// Remove shares from pending that are in this block
		sc.removeIncludedShares(block.Shares)
		
		// Notify callback
		if sc.onNewBlock != nil {
			sc.onNewBlock(block)
		}
		
		sc.logger.Info("New block added to main chain",
			zap.Uint64("height", block.Height),
			zap.String("hash", block.Hash),
			zap.Int("shares", len(block.Shares)),
		)
	} else {
		// Fork detected
		return sc.handleFork(block, parent)
	}
	
	return nil
}

// GetBlock returns a block by height
func (sc *Sharechain) GetBlock(height uint64) (*SharechainBlock, error) {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	
	block, exists := sc.blocks[height]
	if !exists {
		return nil, fmt.Errorf("block not found at height %d", height)
	}
	
	return block, nil
}

// GetBlockByHash returns a block by hash
func (sc *Sharechain) GetBlockByHash(hash string) (*SharechainBlock, error) {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	
	block, exists := sc.blockHashes[hash]
	if !exists {
		return nil, fmt.Errorf("block not found: %s", hash)
	}
	
	return block, nil
}

// GetCurrentHeight returns the current chain height
func (sc *Sharechain) GetCurrentHeight() uint64 {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	
	if sc.currentTip == nil {
		return 0
	}
	
	return sc.currentTip.Height
}

// GetChainTip returns the current chain tip
func (sc *Sharechain) GetChainTip() *SharechainBlock {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	
	return sc.currentTip
}

// GetMinerShares returns share statistics for a miner
func (sc *Sharechain) GetMinerShares(minerID string, fromHeight uint64) (uint64, float64) {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	
	totalShares := uint64(0)
	totalDifficulty := float64(0)
	
	// Count shares from specified height to current
	for height := fromHeight; height <= sc.currentTip.Height; height++ {
		if block, exists := sc.blocks[height]; exists {
			if shares, ok := block.MinerShares[minerID]; ok {
				totalShares += shares
				
				// Calculate difficulty contribution
				for _, share := range block.Shares {
					if share.MinerID == minerID && share.Valid {
						totalDifficulty += share.Difficulty
					}
				}
			}
		}
	}
	
	return totalShares, totalDifficulty
}

// GetRecentBlocks returns recent blocks
func (sc *Sharechain) GetRecentBlocks(count int) []*SharechainBlock {
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	
	blocks := make([]*SharechainBlock, 0, count)
	
	// Start from current tip and go backwards
	height := sc.currentTip.Height
	for i := 0; i < count && height > 0; i++ {
		if block, exists := sc.blocks[height]; exists {
			blocks = append(blocks, block)
		}
		height--
	}
	
	return blocks
}

// SyncWith synchronizes with another node's sharechain
func (sc *Sharechain) SyncWith(peerBlocks []*SharechainBlock) error {
	if len(peerBlocks) == 0 {
		return nil
	}
	
	sc.logger.Info("Starting sharechain sync",
		zap.Int("peer_blocks", len(peerBlocks)),
	)
	
	// Sort blocks by height
	sort.Slice(peerBlocks, func(i, j int) bool {
		return peerBlocks[i].Height < peerBlocks[j].Height
	})
	
	// Find common ancestor
	commonHeight := sc.findCommonAncestor(peerBlocks)
	
	// Add blocks from common ancestor
	added := 0
	for _, block := range peerBlocks {
		if block.Height > commonHeight {
			if err := sc.AddBlock(block); err != nil {
				sc.logger.Debug("Failed to add block during sync",
					zap.Uint64("height", block.Height),
					zap.Error(err),
				)
			} else {
				added++
			}
		}
	}
	
	sc.logger.Info("Sharechain sync completed",
		zap.Int("blocks_added", added),
		zap.Uint64("new_height", sc.GetCurrentHeight()),
	)
	
	return nil
}

// GetStatistics returns sharechain statistics
func (sc *Sharechain) GetStatistics() map[string]interface{} {
	sc.mu.RLock()
	pendingCount := len(sc.pendingShares)
	forkCount := len(sc.forks)
	sc.mu.RUnlock()
	
	return map[string]interface{}{
		"current_height":  sc.GetCurrentHeight(),
		"total_blocks":    sc.totalBlocks.Load(),
		"total_shares":    sc.totalShares.Load(),
		"pending_shares":  pendingCount,
		"fork_count":      sc.forkCount.Load(),
		"active_forks":    forkCount,
	}
}

// SetOnNewBlock sets the new block callback
func (sc *Sharechain) SetOnNewBlock(callback func(*SharechainBlock)) {
	sc.onNewBlock = callback
}

// SetOnForkDetected sets the fork detected callback
func (sc *Sharechain) SetOnForkDetected(callback func(main, fork *SharechainBlock)) {
	sc.onForkDetected = callback
}

// Private methods

// createGenesisBlock creates the genesis block
func (sc *Sharechain) createGenesisBlock() *SharechainBlock {
	genesis := &SharechainBlock{
		Height:      0,
		PrevHash:    "0000000000000000000000000000000000000000000000000000000000000000",
		Timestamp:   time.Now(),
		Shares:      []Share{},
		MinerShares: make(map[string]uint64),
		Difficulty:  sc.minDifficulty,
		Creator:     "genesis",
	}
	
	genesis.Hash = sc.calculateBlockHash(genesis)
	return genesis
}

// createNewBlock creates a new block from pending shares
func (sc *Sharechain) createNewBlock() {
	sc.mu.Lock()
	
	// Check if we still should create a block
	if !sc.shouldCreateBlock() {
		sc.mu.Unlock()
		return
	}
	
	// Get shares for the block
	shares := make([]Share, len(sc.pendingShares))
	copy(shares, sc.pendingShares)
	sc.pendingShares = sc.pendingShares[:0]
	
	// Calculate miner shares
	minerShares := make(map[string]uint64)
	for _, share := range shares {
		if share.Valid {
			minerShares[share.MinerID]++
		}
	}
	
	// Create block
	block := &SharechainBlock{
		Height:      sc.currentTip.Height + 1,
		PrevHash:    sc.currentTip.Hash,
		Timestamp:   time.Now(),
		Shares:      shares,
		MinerShares: minerShares,
		Difficulty:  sc.calculateNextDifficulty(),
		Creator:     sc.nodeID,
	}
	
	// Calculate nonce for proof of work
	block.Nonce = sc.findBlockNonce(block)
	
	// Calculate hash
	block.Hash = sc.calculateBlockHash(block)
	
	sc.mu.Unlock()
	
	// Add block to our chain
	if err := sc.AddBlock(block); err != nil {
		sc.logger.Error("Failed to add own block",
			zap.Error(err),
		)
		return
	}
	
	sc.logger.Info("Created new sharechain block",
		zap.Uint64("height", block.Height),
		zap.String("hash", block.Hash),
		zap.Int("shares", len(shares)),
	)
}

// shouldCreateBlock checks if we should create a new block
func (sc *Sharechain) shouldCreateBlock() bool {
	// Check if enough time has passed
	if time.Since(sc.currentTip.Timestamp) < sc.blockTime {
		return false
	}
	
	// Check if we have enough shares
	if len(sc.pendingShares) < 10 {
		return false
	}
	
	return true
}

// validateShare validates a share
func (sc *Sharechain) validateShare(share Share) error {
	if share.ID == "" {
		return fmt.Errorf("share has no ID")
	}
	if share.MinerID == "" {
		return fmt.Errorf("share has no miner ID")
	}
	if share.JobID == "" {
		return fmt.Errorf("share has no job ID")
	}
	if share.Difficulty < sc.minDifficulty {
		return fmt.Errorf("share difficulty too low: %f < %f", share.Difficulty, sc.minDifficulty)
	}
	
	return nil
}

// validateBlock validates a block
func (sc *Sharechain) validateBlock(block *SharechainBlock) error {
	// Check basic fields
	if block.Hash == "" {
		return fmt.Errorf("block has no hash")
	}
	if block.PrevHash == "" {
		return fmt.Errorf("block has no previous hash")
	}
	
	// Verify hash
	expectedHash := sc.calculateBlockHash(block)
	if block.Hash != expectedHash {
		return fmt.Errorf("invalid block hash: expected %s, got %s", expectedHash, block.Hash)
	}
	
	// Verify proof of work
	if !sc.verifyBlockPoW(block) {
		return fmt.Errorf("invalid proof of work")
	}
	
	// Validate shares
	minerShares := make(map[string]uint64)
	for _, share := range block.Shares {
		if err := sc.validateShare(share); err != nil {
			return fmt.Errorf("invalid share %s: %w", share.ID, err)
		}
		if share.Valid {
			minerShares[share.MinerID]++
		}
	}
	
	// Verify miner shares calculation
	for minerID, count := range minerShares {
		if block.MinerShares[minerID] != count {
			return fmt.Errorf("miner share count mismatch for %s", minerID)
		}
	}
	
	return nil
}

// calculateBlockHash calculates the hash of a block
func (sc *Sharechain) calculateBlockHash(block *SharechainBlock) string {
	data := fmt.Sprintf("%d:%s:%d:%f:%d",
		block.Height,
		block.PrevHash,
		block.Timestamp.Unix(),
		block.Difficulty,
		block.Nonce,
	)
	
	// Include share hashes
	for _, share := range block.Shares {
		data += ":" + share.Hash
	}
	
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:])
}

// findBlockNonce finds a valid nonce for the block
func (sc *Sharechain) findBlockNonce(block *SharechainBlock) uint64 {
	target := sc.difficultyToTarget(block.Difficulty)
	
	for nonce := uint64(0); ; nonce++ {
		block.Nonce = nonce
		hash := sc.calculateBlockHash(block)
		
		hashBig := new(big.Int)
		hashBig.SetString(hash, 16)
		
		if hashBig.Cmp(target) < 0 {
			return nonce
		}
	}
}

// verifyBlockPoW verifies the proof of work for a block
func (sc *Sharechain) verifyBlockPoW(block *SharechainBlock) bool {
	target := sc.difficultyToTarget(block.Difficulty)
	
	hashBig := new(big.Int)
	hashBig.SetString(block.Hash, 16)
	
	return hashBig.Cmp(target) < 0
}

// difficultyToTarget converts difficulty to target
func (sc *Sharechain) difficultyToTarget(difficulty float64) *big.Int {
	// Max target (2^256 - 1)
	maxTarget := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	
	// Target = MaxTarget / Difficulty
	diffBig := new(big.Float).SetFloat64(difficulty)
	targetFloat := new(big.Float).Quo(new(big.Float).SetInt(maxTarget), diffBig)
	
	target, _ := targetFloat.Int(nil)
	return target
}

// calculateNextDifficulty calculates the difficulty for the next block
func (sc *Sharechain) calculateNextDifficulty() float64 {
	// Simple difficulty adjustment
	// In production, this would consider block times and network hash rate
	return sc.currentTip.Difficulty
}

// removeIncludedShares removes shares that were included in a block
func (sc *Sharechain) removeIncludedShares(includedShares []Share) {
	includedMap := make(map[string]bool)
	for _, share := range includedShares {
		includedMap[share.ID] = true
	}
	
	// Filter pending shares
	filtered := sc.pendingShares[:0]
	for _, share := range sc.pendingShares {
		if !includedMap[share.ID] {
			filtered = append(filtered, share)
		}
	}
	sc.pendingShares = filtered
}

// handleOrphanBlock handles an orphan block
func (sc *Sharechain) handleOrphanBlock(block *SharechainBlock) error {
	// TODO: Implement orphan block handling
	// Store orphan blocks temporarily and try to connect them later
	return fmt.Errorf("orphan block: parent %s not found", block.PrevHash)
}

// handleFork handles a fork in the sharechain
func (sc *Sharechain) handleFork(block *SharechainBlock, parent *SharechainBlock) error {
	sc.forkCount.Add(1)
	
	// Add block to fork
	forkKey := parent.Hash
	sc.forks[forkKey] = append(sc.forks[forkKey], block)
	sc.blockHashes[block.Hash] = block
	
	// Check if fork is longer than main chain
	forkLength := parent.Height + uint64(len(sc.forks[forkKey])) + 1
	
	if forkLength > sc.currentTip.Height {
		// Fork is longer, reorganize
		sc.logger.Warn("Fork detected and is longer than main chain",
			zap.Uint64("main_height", sc.currentTip.Height),
			zap.Uint64("fork_height", forkLength),
		)
		
		if sc.onForkDetected != nil {
			sc.onForkDetected(sc.currentTip, block)
		}
		
		// TODO: Implement chain reorganization
	}
	
	return nil
}

// findCommonAncestor finds the common ancestor with peer blocks
func (sc *Sharechain) findCommonAncestor(peerBlocks []*SharechainBlock) uint64 {
	for i := len(peerBlocks) - 1; i >= 0; i-- {
		block := peerBlocks[i]
		if localBlock, exists := sc.blocks[block.Height]; exists {
			if localBlock.Hash == block.Hash {
				return block.Height
			}
		}
	}
	
	return 0 // Start from genesis
}