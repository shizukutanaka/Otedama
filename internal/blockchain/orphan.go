package blockchain

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// OrphanManager manages orphan and uncle blocks
type OrphanManager struct {
	// Block storage
	orphanBlocks    map[string]*OrphanBlock
	uncleBlocks     map[string]*UncleBlock
	orphansMu       sync.RWMutex
	
	// Chain tracking
	mainChain       *BlockChain
	pendingBlocks   map[string]*PendingBlock
	pendingMu       sync.RWMutex
	
	// Configuration
	config          *OrphanConfig
	
	// Reorganization detection
	reorgCandidates map[string]*ReorgCandidate
	reorgMu         sync.RWMutex
	
	// Statistics
	totalOrphans    atomic.Uint64
	totalUncles     atomic.Uint64
	totalReorgs     atomic.Uint64
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// OrphanBlock represents an orphaned block
type OrphanBlock struct {
	Hash          []byte
	Height        uint64
	PreviousHash  []byte
	Timestamp     time.Time
	Difficulty    float64
	
	// Mining info
	Miner         string
	Reward        float64
	Transactions  int
	
	// Orphan details
	OrphanedAt    time.Time
	Reason        OrphanReason
	ReplacedBy    []byte // Hash of block that replaced it
	
	// Chain context
	ChainWork     []byte
	ChainLength   uint64
}

// UncleBlock represents an uncle block (Ethereum-style)
type UncleBlock struct {
	Hash          []byte
	Height        uint64
	PreviousHash  []byte
	Timestamp     time.Time
	Difficulty    float64
	
	// Uncle details
	IncludedIn    []byte // Hash of block that included this uncle
	IncludedAt    time.Time
	UncleReward   float64
	NephewReward  float64
	
	// Mining info
	Miner         string
	Generation    int // How many blocks back from nephew
}

// PendingBlock represents a block awaiting validation
type PendingBlock struct {
	Hash          []byte
	Height        uint64
	PreviousHash  []byte
	Data          []byte
	ReceivedAt    time.Time
	Source        string
	
	// Validation status
	Validated     bool
	ValidationErr error
}

// ReorgCandidate represents a potential chain reorganization
type ReorgCandidate struct {
	CommonAncestor []byte
	OldChain       []*OrphanBlock
	NewChain       []*PendingBlock
	HeightDiff     int64
	WorkDiff       []byte
	
	// Detection
	DetectedAt     time.Time
	Confidence     float64
}

// BlockChain represents the main blockchain
type BlockChain struct {
	blocks       map[string]*Block
	blocksMu     sync.RWMutex
	tip          atomic.Value // []byte (hash)
	height       atomic.Uint64
}

// Block represents a blockchain block
type Block struct {
	Hash         []byte
	Height       uint64
	PreviousHash []byte
	Timestamp    time.Time
	Difficulty   float64
	ChainWork    []byte
	Confirmed    bool
}

// OrphanReason represents why a block became orphaned
type OrphanReason int

const (
	OrphanReasonReorg OrphanReason = iota
	OrphanReasonStale
	OrphanReasonInvalid
	OrphanReasonDoubleSpend
	OrphanReasonTimestamp
)

// OrphanConfig holds orphan management configuration
type OrphanConfig struct {
	// Storage limits
	MaxOrphans        int
	MaxUncles         int
	MaxPending        int
	
	// Time limits
	OrphanTimeout     time.Duration
	PendingTimeout    time.Duration
	
	// Reorganization detection
	ReorgDetection    bool
	MaxReorgDepth     int
	MinConfirmations  int
	
	// Uncle block support (Ethereum-style)
	UncleSupport      bool
	MaxUncleDepth     int
	UncleRewardRatio  float64
	
	// Cleanup intervals
	CleanupInterval   time.Duration
}

// DefaultOrphanConfig returns default configuration
func DefaultOrphanConfig() *OrphanConfig {
	return &OrphanConfig{
		MaxOrphans:       1000,
		MaxUncles:        500,
		MaxPending:       100,
		OrphanTimeout:    24 * time.Hour,
		PendingTimeout:   10 * time.Minute,
		ReorgDetection:   true,
		MaxReorgDepth:    10,
		MinConfirmations: 6,
		UncleSupport:     false,
		MaxUncleDepth:    7,
		UncleRewardRatio: 0.875, // 7/8 of full reward
		CleanupInterval:  1 * time.Hour,
	}
}

// NewOrphanManager creates a new orphan manager
func NewOrphanManager(ctx context.Context, config *OrphanConfig) *OrphanManager {
	if config == nil {
		config = DefaultOrphanConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	om := &OrphanManager{
		orphanBlocks:    make(map[string]*OrphanBlock),
		uncleBlocks:     make(map[string]*UncleBlock),
		pendingBlocks:   make(map[string]*PendingBlock),
		reorgCandidates: make(map[string]*ReorgCandidate),
		config:          config,
		ctx:             ctx,
		cancel:          cancel,
	}
	
	// Initialize main chain
	om.mainChain = &BlockChain{
		blocks: make(map[string]*Block),
	}
	om.mainChain.height.Store(0)
	
	// Start workers
	om.wg.Add(1)
	go om.orphanCleaner()
	
	if config.ReorgDetection {
		om.wg.Add(1)
		go om.reorgDetector()
	}
	
	return om
}

// AddBlock adds a new block to the chain
func (om *OrphanManager) AddBlock(hash []byte, height uint64, previousHash []byte, data []byte, source string) error {
	hashStr := hex.EncodeToString(hash)
	prevHashStr := hex.EncodeToString(previousHash)
	
	// Check if block already exists
	om.mainChain.blocksMu.RLock()
	if _, exists := om.mainChain.blocks[hashStr]; exists {
		om.mainChain.blocksMu.RUnlock()
		return errors.New("block already exists")
	}
	om.mainChain.blocksMu.RUnlock()
	
	// Check if this extends the main chain
	currentHeight := om.mainChain.height.Load()
	
	if height == currentHeight+1 {
		// Check if previous block exists
		om.mainChain.blocksMu.RLock()
		_, prevExists := om.mainChain.blocks[prevHashStr]
		om.mainChain.blocksMu.RUnlock()
		
		if prevExists {
			// Valid next block
			return om.addToMainChain(hash, height, previousHash, data)
		}
	}
	
	// Block doesn't extend main chain - add as pending
	return om.addPendingBlock(hash, height, previousHash, data, source)
}

// addToMainChain adds block to main chain
func (om *OrphanManager) addToMainChain(hash []byte, height uint64, previousHash []byte, data []byte) error {
	hashStr := hex.EncodeToString(hash)
	
	block := &Block{
		Hash:         hash,
		Height:       height,
		PreviousHash: previousHash,
		Timestamp:    time.Now(),
		Difficulty:   1.0, // Placeholder
		ChainWork:    om.calculateChainWork(height),
		Confirmed:    false,
	}
	
	om.mainChain.blocksMu.Lock()
	om.mainChain.blocks[hashStr] = block
	om.mainChain.blocksMu.Unlock()
	
	om.mainChain.tip.Store(hash)
	om.mainChain.height.Store(height)
	
	fmt.Printf("Added block %s at height %d to main chain\n", hashStr[:8], height)
	
	// Check for pending blocks that can now be added
	om.processPendingBlocks()
	
	// Check for reorganizations
	if om.config.ReorgDetection {
		om.detectReorganization(block)
	}
	
	return nil
}

// addPendingBlock adds block as pending
func (om *OrphanManager) addPendingBlock(hash []byte, height uint64, previousHash []byte, data []byte, source string) error {
	hashStr := hex.EncodeToString(hash)
	
	om.pendingMu.Lock()
	defer om.pendingMu.Unlock()
	
	// Check pending limit
	if len(om.pendingBlocks) >= om.config.MaxPending {
		return errors.New("pending blocks limit reached")
	}
	
	pending := &PendingBlock{
		Hash:         hash,
		Height:       height,
		PreviousHash: previousHash,
		Data:         data,
		ReceivedAt:   time.Now(),
		Source:       source,
		Validated:    false,
	}
	
	om.pendingBlocks[hashStr] = pending
	
	fmt.Printf("Added pending block %s at height %d\n", hashStr[:8], height)
	
	return nil
}

// processPendingBlocks processes blocks that may now be valid
func (om *OrphanManager) processPendingBlocks() {
	om.pendingMu.Lock()
	defer om.pendingMu.Unlock()
	
	currentHeight := om.mainChain.height.Load()
	processed := make([]string, 0)
	
	for hashStr, pending := range om.pendingBlocks {
		if pending.Height == currentHeight+1 {
			prevHashStr := hex.EncodeToString(pending.PreviousHash)
			
			om.mainChain.blocksMu.RLock()
			_, prevExists := om.mainChain.blocks[prevHashStr]
			om.mainChain.blocksMu.RUnlock()
			
			if prevExists {
				// This block can now be added
				err := om.addToMainChain(pending.Hash, pending.Height, pending.PreviousHash, pending.Data)
				if err == nil {
					processed = append(processed, hashStr)
				}
			}
		}
	}
	
	// Remove processed blocks
	for _, hashStr := range processed {
		delete(om.pendingBlocks, hashStr)
	}
}

// OrphanBlock orphans a block from the main chain
func (om *OrphanManager) OrphanBlock(hash []byte, reason OrphanReason, replacedBy []byte) error {
	hashStr := hex.EncodeToString(hash)
	
	om.mainChain.blocksMu.Lock()
	block, exists := om.mainChain.blocks[hashStr]
	if !exists {
		om.mainChain.blocksMu.Unlock()
		return errors.New("block not found in main chain")
	}
	
	// Remove from main chain
	delete(om.mainChain.blocks, hashStr)
	om.mainChain.blocksMu.Unlock()
	
	// Create orphan block
	orphan := &OrphanBlock{
		Hash:         block.Hash,
		Height:       block.Height,
		PreviousHash: block.PreviousHash,
		Timestamp:    block.Timestamp,
		Difficulty:   block.Difficulty,
		Miner:        "unknown", // Would be extracted from block data
		Reward:       50.0,      // Placeholder
		Transactions: 1,         // Placeholder
		OrphanedAt:   time.Now(),
		Reason:       reason,
		ReplacedBy:   replacedBy,
		ChainWork:    block.ChainWork,
		ChainLength:  block.Height,
	}
	
	// Store orphan
	om.orphansMu.Lock()
	if len(om.orphanBlocks) < om.config.MaxOrphans {
		om.orphanBlocks[hashStr] = orphan
		om.totalOrphans.Add(1)
	}
	om.orphansMu.Unlock()
	
	fmt.Printf("Orphaned block %s at height %d (reason: %s)\n", 
		hashStr[:8], block.Height, reason.String())
	
	return nil
}

// AddUncleBlock adds an uncle block (Ethereum-style)
func (om *OrphanManager) AddUncleBlock(hash []byte, height uint64, includedIn []byte, generation int) error {
	if !om.config.UncleSupport {
		return errors.New("uncle blocks not supported")
	}
	
	if generation > om.config.MaxUncleDepth {
		return errors.New("uncle too old")
	}
	
	hashStr := hex.EncodeToString(hash)
	
	uncle := &UncleBlock{
		Hash:         hash,
		Height:       height,
		Timestamp:    time.Now(),
		Difficulty:   1.0, // Placeholder
		IncludedIn:   includedIn,
		IncludedAt:   time.Now(),
		UncleReward:  50.0 * om.config.UncleRewardRatio, // Reduced reward
		NephewReward: 50.0 * 0.03125,                    // 1/32 of full reward
		Miner:        "unknown",
		Generation:   generation,
	}
	
	om.orphansMu.Lock()
	if len(om.uncleBlocks) < om.config.MaxUncles {
		om.uncleBlocks[hashStr] = uncle
		om.totalUncles.Add(1)
	}
	om.orphansMu.Unlock()
	
	fmt.Printf("Added uncle block %s (generation %d)\n", hashStr[:8], generation)
	
	return nil
}

// detectReorganization detects potential chain reorganizations
func (om *OrphanManager) detectReorganization(newBlock *Block) {
	// Look for competing chains
	om.pendingMu.RLock()
	competitors := make([]*PendingBlock, 0)
	
	for _, pending := range om.pendingBlocks {
		// Look for blocks at same height with different hash
		if pending.Height == newBlock.Height && !bytesEqual(pending.Hash, newBlock.Hash) {
			competitors = append(competitors, pending)
		}
	}
	om.pendingMu.RUnlock()
	
	if len(competitors) == 0 {
		return
	}
	
	// Analyze competitors for reorganization potential
	for _, competitor := range competitors {
		om.analyzeReorgCandidate(newBlock, competitor)
	}
}

// analyzeReorgCandidate analyzes a potential reorganization
func (om *OrphanManager) analyzeReorgCandidate(mainBlock *Block, competitor *PendingBlock) {
	// Find common ancestor
	commonAncestor := om.findCommonAncestor(mainBlock.Hash, competitor.Hash)
	if commonAncestor == nil {
		return
	}
	
	// Calculate work difference (simplified)
	mainWork := om.calculateChainWork(mainBlock.Height)
	compWork := om.calculateChainWork(competitor.Height)
	
	workDiff := om.compareChainWork(compWork, mainWork)
	confidence := om.calculateReorgConfidence(mainBlock, competitor, workDiff)
	
	if confidence > 0.7 { // 70% confidence threshold
		candidateID := hex.EncodeToString(competitor.Hash)[:8]
		
		candidate := &ReorgCandidate{
			CommonAncestor: commonAncestor,
			HeightDiff:     int64(competitor.Height) - int64(mainBlock.Height),
			WorkDiff:       workDiff,
			DetectedAt:     time.Now(),
			Confidence:     confidence,
		}
		
		om.reorgMu.Lock()
		om.reorgCandidates[candidateID] = candidate
		om.reorgMu.Unlock()
		
		fmt.Printf("Potential reorganization detected (confidence: %.1f%%)\n", confidence*100)
	}
}

// findCommonAncestor finds common ancestor of two blocks
func (om *OrphanManager) findCommonAncestor(hash1, hash2 []byte) []byte {
	// Simplified implementation - would trace back through chains
	// For now, return genesis block hash
	genesis := make([]byte, 32)
	return genesis
}

// calculateChainWork calculates cumulative chain work
func (om *OrphanManager) calculateChainWork(height uint64) []byte {
	// Simplified calculation - cumulative difficulty
	work := make([]byte, 32)
	work[31] = byte(height) // Very simplified
	return work
}

// compareChainWork compares two chain work values
func (om *OrphanManager) compareChainWork(work1, work2 []byte) []byte {
	// Return difference (simplified)
	diff := make([]byte, 32)
	for i := 0; i < 32; i++ {
		if work1[i] > work2[i] {
			diff[i] = work1[i] - work2[i]
		} else {
			diff[i] = work2[i] - work1[i]
		}
	}
	return diff
}

// calculateReorgConfidence calculates reorganization confidence
func (om *OrphanManager) calculateReorgConfidence(mainBlock *Block, competitor *PendingBlock, workDiff []byte) float64 {
	confidence := 0.0
	
	// Height difference factor
	heightDiff := float64(competitor.Height) - float64(mainBlock.Height)
	if heightDiff > 0 {
		confidence += 0.3
	}
	
	// Work difference factor (simplified)
	workFactor := float64(workDiff[31]) / 255.0
	confidence += workFactor * 0.4
	
	// Time factor
	timeDiff := time.Since(competitor.ReceivedAt)
	if timeDiff < 1*time.Minute {
		confidence += 0.3
	}
	
	if confidence > 1.0 {
		confidence = 1.0
	}
	
	return confidence
}

// reorgDetector detects and handles reorganizations
func (om *OrphanManager) reorgDetector() {
	defer om.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			om.checkReorganizations()
			
		case <-om.ctx.Done():
			return
		}
	}
}

// checkReorganizations checks for confirmed reorganizations
func (om *OrphanManager) checkReorganizations() {
	om.reorgMu.Lock()
	defer om.reorgMu.Unlock()
	
	for id, candidate := range om.reorgCandidates {
		// Check if reorganization should be executed
		if candidate.Confidence > 0.9 && time.Since(candidate.DetectedAt) > 1*time.Minute {
			om.executeReorganization(candidate)
			delete(om.reorgCandidates, id)
		} else if time.Since(candidate.DetectedAt) > 10*time.Minute {
			// Remove stale candidates
			delete(om.reorgCandidates, id)
		}
	}
}

// executeReorganization executes a chain reorganization
func (om *OrphanManager) executeReorganization(candidate *ReorgCandidate) {
	fmt.Printf("Executing chain reorganization (confidence: %.1f%%)\n", candidate.Confidence*100)
	
	// This would involve:
	// 1. Rolling back to common ancestor
	// 2. Orphaning blocks from old chain
	// 3. Applying blocks from new chain
	// 4. Updating state
	
	om.totalReorgs.Add(1)
}

// orphanCleaner cleans up old orphan blocks
func (om *OrphanManager) orphanCleaner() {
	defer om.wg.Done()
	
	ticker := time.NewTicker(om.config.CleanupInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			om.cleanupOrphans()
			om.cleanupPending()
			
		case <-om.ctx.Done():
			return
		}
	}
}

// cleanupOrphans removes old orphan blocks
func (om *OrphanManager) cleanupOrphans() {
	om.orphansMu.Lock()
	defer om.orphansMu.Unlock()
	
	cutoff := time.Now().Add(-om.config.OrphanTimeout)
	
	for hashStr, orphan := range om.orphanBlocks {
		if orphan.OrphanedAt.Before(cutoff) {
			delete(om.orphanBlocks, hashStr)
		}
	}
	
	for hashStr, uncle := range om.uncleBlocks {
		if uncle.IncludedAt.Before(cutoff) {
			delete(om.uncleBlocks, hashStr)
		}
	}
}

// cleanupPending removes old pending blocks
func (om *OrphanManager) cleanupPending() {
	om.pendingMu.Lock()
	defer om.pendingMu.Unlock()
	
	cutoff := time.Now().Add(-om.config.PendingTimeout)
	
	for hashStr, pending := range om.pendingBlocks {
		if pending.ReceivedAt.Before(cutoff) {
			delete(om.pendingBlocks, hashStr)
		}
	}
}

// GetOrphanBlocks returns all orphan blocks
func (om *OrphanManager) GetOrphanBlocks() map[string]*OrphanBlock {
	om.orphansMu.RLock()
	defer om.orphansMu.RUnlock()
	
	result := make(map[string]*OrphanBlock)
	for k, v := range om.orphanBlocks {
		result[k] = v
	}
	return result
}

// GetUncleBlocks returns all uncle blocks
func (om *OrphanManager) GetUncleBlocks() map[string]*UncleBlock {
	om.orphansMu.RLock()
	defer om.orphansMu.RUnlock()
	
	result := make(map[string]*UncleBlock)
	for k, v := range om.uncleBlocks {
		result[k] = v
	}
	return result
}

// GetRecentOrphans returns recent orphan blocks
func (om *OrphanManager) GetRecentOrphans(limit int) []*OrphanBlock {
	om.orphansMu.RLock()
	defer om.orphansMu.RUnlock()
	
	orphans := make([]*OrphanBlock, 0, len(om.orphanBlocks))
	for _, orphan := range om.orphanBlocks {
		orphans = append(orphans, orphan)
	}
	
	// Sort by orphaned time (most recent first)
	sort.Slice(orphans, func(i, j int) bool {
		return orphans[i].OrphanedAt.After(orphans[j].OrphanedAt)
	})
	
	if limit > 0 && len(orphans) > limit {
		orphans = orphans[:limit]
	}
	
	return orphans
}

// GetStatistics returns orphan management statistics
func (om *OrphanManager) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	om.orphansMu.RLock()
	orphanCount := len(om.orphanBlocks)
	uncleCount := len(om.uncleBlocks)
	om.orphansMu.RUnlock()
	
	om.pendingMu.RLock()
	pendingCount := len(om.pendingBlocks)
	om.pendingMu.RUnlock()
	
	om.reorgMu.RLock()
	reorgCandidateCount := len(om.reorgCandidates)
	om.reorgMu.RUnlock()
	
	stats["orphan_blocks"] = orphanCount
	stats["uncle_blocks"] = uncleCount
	stats["pending_blocks"] = pendingCount
	stats["reorg_candidates"] = reorgCandidateCount
	stats["total_orphans"] = om.totalOrphans.Load()
	stats["total_uncles"] = om.totalUncles.Load()
	stats["total_reorgs"] = om.totalReorgs.Load()
	stats["main_chain_height"] = om.mainChain.height.Load()
	
	// Orphan rate calculation
	totalBlocks := om.mainChain.height.Load() + om.totalOrphans.Load()
	if totalBlocks > 0 {
		orphanRate := float64(om.totalOrphans.Load()) / float64(totalBlocks) * 100
		stats["orphan_rate_percent"] = orphanRate
	} else {
		stats["orphan_rate_percent"] = 0.0
	}
	
	// Recent orphan reasons
	recentOrphans := om.GetRecentOrphans(100)
	reasonCounts := make(map[string]int)
	for _, orphan := range recentOrphans {
		reason := orphan.Reason.String()
		reasonCounts[reason]++
	}
	stats["recent_orphan_reasons"] = reasonCounts
	
	return stats
}

// Stop stops the orphan manager
func (om *OrphanManager) Stop() {
	om.cancel()
	om.wg.Wait()
}

// String returns string representation of OrphanReason
func (or OrphanReason) String() string {
	switch or {
	case OrphanReasonReorg:
		return "reorganization"
	case OrphanReasonStale:
		return "stale"
	case OrphanReasonInvalid:
		return "invalid"
	case OrphanReasonDoubleSpend:
		return "double_spend"
	case OrphanReasonTimestamp:
		return "timestamp"
	default:
		return "unknown"
	}
}

// bytesEqual compares two byte slices
func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// hash calculates SHA256 hash
func hash(data []byte) []byte {
	h := sha256.Sum256(data)
	return h[:]
}