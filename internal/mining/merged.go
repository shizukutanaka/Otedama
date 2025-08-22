package mining

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// MergedMiningManager manages merged mining operations
type MergedMiningManager struct {
	// Primary chain
	primaryChain *Chain
	
	// Auxiliary chains
	auxChains    map[string]*AuxiliaryChain
	auxChainsMu  sync.RWMutex
	
	// Merkle tree for aux chains
	merkleTree   *MerkleTree
	
	// Configuration
	config       *MergedMiningConfig
	
	// Job management
	currentJob   atomic.Value // *MergedJob
	jobCounter   atomic.Uint64
	
	// Statistics
	totalJobs       atomic.Uint64
	totalShares     atomic.Uint64
	auxBlocks       map[string]atomic.Uint64
	auxBlocksMu     sync.RWMutex
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Chain represents a blockchain
type Chain struct {
	ID          string
	Name        string
	Symbol      string
	Algorithm   string
	Difficulty  float64
	BlockTime   time.Duration
	
	// Network info
	NetworkHashrate float64
	BlockHeight     uint64
	PrevBlockHash   []byte
	
	// Reward info
	BlockReward     float64
	CurrentPrice    float64
	
	// Connection
	RPCEndpoint     string
	Username        string
	Password        string
}

// AuxiliaryChain represents an auxiliary chain in merged mining
type AuxiliaryChain struct {
	*Chain
	
	// Merged mining specific
	ChainID         uint32
	AuxPOWEnabled   bool
	TargetSpacing   time.Duration
	
	// Merkle position
	MerkleIndex     int
	MerkleBranch    [][]byte
	
	// Statistics
	AcceptedBlocks  atomic.Uint64
	RejectedBlocks  atomic.Uint64
	LastBlock       atomic.Value // time.Time
	
	// Job template
	CurrentTemplate atomic.Value // *AuxTemplate
}

// MergedJob represents a merged mining job
type MergedJob struct {
	JobID           string
	PrimaryJobID    string
	
	// Primary chain data
	PrimaryBlock    *BlockTemplate
	
	// Auxiliary chain data
	AuxBlocks       map[string]*AuxTemplate
	AuxMerkleRoot   []byte
	
	// Combined data
	CoinbaseAux     []byte
	MerkleTree      *MerkleTree
	
	// Timing
	CreatedAt       time.Time
	ValidUntil      time.Time
}

// BlockTemplate represents a block template

// AuxTemplate represents auxiliary chain template
type AuxTemplate struct {
	ChainID        uint32
	BlockHash      []byte
	Target         []byte
	Height         uint64
	ParentBlockHash []byte
	
	// Auxiliary proof-of-work
	AuxPOW         *AuxPOW
}

// AuxPOW represents auxiliary proof-of-work
type AuxPOW struct {
	CoinbaseTx     Transaction
	BlockHash      []byte
	CoinbaseBranch [][]byte
	CoinbaseIndex  uint32
	ChainMerkleBranch [][]byte
	ChainIndex     uint32
	ParentBlock    []byte
}

// Transaction represents a blockchain transaction
type Transaction struct {
	Hash    []byte
	Data    []byte
	Inputs  []TxInput
	Outputs []TxOutput
	Version uint32
	LockTime uint32
}

// TxInput represents transaction input
type TxInput struct {
	PrevHash  []byte
	PrevIndex uint32
	Script    []byte
	Sequence  uint32
}

// TxOutput represents transaction output
type TxOutput struct {
	Value  uint64
	Script []byte
}

// MerkleTree represents a merkle tree for aux chains
type MerkleTree struct {
	root     []byte
	branches map[int][][]byte
	leaves   [][]byte
	mu       sync.RWMutex
}

// MergedMiningConfig holds merged mining configuration
type MergedMiningConfig struct {
	PrimaryChain    string
	MaxAuxChains    int
	JobTimeout      time.Duration
	UpdateInterval  time.Duration
	
	// Profitability settings
	EnableProfitability bool
	MinProfitability    float64
	
	// Network settings
	RPCTimeout      time.Duration
	MaxRetries      int
}

// DefaultMergedMiningConfig returns default configuration
func DefaultMergedMiningConfig() *MergedMiningConfig {
	return &MergedMiningConfig{
		PrimaryChain:        "bitcoin",
		MaxAuxChains:        64, // Maximum supported aux chains
		JobTimeout:          300 * time.Second,
		UpdateInterval:      30 * time.Second,
		EnableProfitability: true,
		MinProfitability:    0.01, // 1%
		RPCTimeout:          10 * time.Second,
		MaxRetries:          3,
	}
}

// NewMergedMiningManager creates a new merged mining manager
func NewMergedMiningManager(ctx context.Context, config *MergedMiningConfig) *MergedMiningManager {
	if config == nil {
		config = DefaultMergedMiningConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	mm := &MergedMiningManager{
		auxChains: make(map[string]*AuxiliaryChain),
		auxBlocks: make(map[string]atomic.Uint64),
		config:    config,
		ctx:       ctx,
		cancel:    cancel,
	}
	
	mm.merkleTree = NewMerkleTree()
	
	// Start workers
	mm.wg.Add(1)
	go mm.jobUpdater()
	
	return mm
}

// SetPrimaryChain sets the primary blockchain
func (mm *MergedMiningManager) SetPrimaryChain(chain *Chain) error {
	if chain == nil {
		return errors.New("primary chain cannot be nil")
	}
	
	mm.primaryChain = chain
	fmt.Printf("Primary chain set to %s (%s)\n", chain.Name, chain.Symbol)
	
	return nil
}

// AddAuxiliaryChain adds an auxiliary chain
func (mm *MergedMiningManager) AddAuxiliaryChain(chain *Chain) error {
	if chain == nil {
		return errors.New("auxiliary chain cannot be nil")
	}
	
	mm.auxChainsMu.Lock()
	defer mm.auxChainsMu.Unlock()
	
	if len(mm.auxChains) >= mm.config.MaxAuxChains {
		return errors.New("maximum auxiliary chains reached")
	}
	
	if _, exists := mm.auxChains[chain.ID]; exists {
		return fmt.Errorf("auxiliary chain %s already exists", chain.ID)
	}
	
	auxChain := &AuxiliaryChain{
		Chain:         chain,
		ChainID:       uint32(len(mm.auxChains)),
		AuxPOWEnabled: true,
		TargetSpacing: chain.BlockTime,
		MerkleIndex:   len(mm.auxChains),
	}
	
	auxChain.LastBlock.Store(time.Now())
	
	mm.auxChains[chain.ID] = auxChain
	mm.auxBlocks[chain.ID] = atomic.Uint64{}
	
	fmt.Printf("Added auxiliary chain %s (%s) with ID %d\n", 
		chain.Name, chain.Symbol, auxChain.ChainID)
	
	return nil
}

// RemoveAuxiliaryChain removes an auxiliary chain
func (mm *MergedMiningManager) RemoveAuxiliaryChain(chainID string) error {
	mm.auxChainsMu.Lock()
	defer mm.auxChainsMu.Unlock()
	
	if _, exists := mm.auxChains[chainID]; !exists {
		return fmt.Errorf("auxiliary chain %s not found", chainID)
	}
	
	delete(mm.auxChains, chainID)
	delete(mm.auxBlocks, chainID)
	
	fmt.Printf("Removed auxiliary chain %s\n", chainID)
	return nil
}

// GetCurrentJob returns the current merged mining job
func (mm *MergedMiningManager) GetCurrentJob() *MergedJob {
	if job := mm.currentJob.Load(); job != nil {
		return job.(*MergedJob)
	}
	return nil
}

// SubmitShare submits a share for merged mining
func (mm *MergedMiningManager) SubmitShare(jobID string, extraNonce1, extraNonce2 []byte, nonce uint32, timestamp uint32) error {
	job := mm.GetCurrentJob()
	if job == nil || job.JobID != jobID {
		return errors.New("invalid or stale job")
	}
	
	// Build block header
	header := mm.buildBlockHeader(job, extraNonce1, extraNonce2, nonce, timestamp)
	
	// Calculate hash
	hash := sha256.Sum256(header)
	hash = sha256.Sum256(hash[:])
	
	mm.totalShares.Add(1)
	
	// Check primary chain
	if mm.checkTarget(hash[:], job.PrimaryBlock.Target) {
		fmt.Printf("Primary block found for %s!\n", mm.primaryChain.Name)
		mm.submitPrimaryBlock(job, header, hash[:])
	}
	
	// Check auxiliary chains
	mm.auxChainsMu.RLock()
	for chainID, auxChain := range mm.auxChains {
		if auxTemplate := auxChain.CurrentTemplate.Load(); auxTemplate != nil {
			template := auxTemplate.(*AuxTemplate)
			if mm.checkTarget(hash[:], template.Target) {
				fmt.Printf("Auxiliary block found for %s!\n", auxChain.Name)
				mm.submitAuxiliaryBlock(auxChain, job, header, hash[:])
				
				auxChain.AcceptedBlocks.Add(1)
				mm.auxBlocks[chainID].Add(1)
			}
		}
	}
	mm.auxChainsMu.RUnlock()
	
	return nil
}

// buildBlockHeader builds the block header for mining
func (mm *MergedMiningManager) buildBlockHeader(job *MergedJob, extraNonce1, extraNonce2 []byte, nonce, timestamp uint32) []byte {
	// Build coinbase transaction with aux data
	coinbase := mm.buildCoinbaseTransaction(job, extraNonce1, extraNonce2)
	
	// Calculate merkle root
	merkleRoot := mm.calculateMerkleRoot(job.PrimaryBlock, coinbase)
	
	// Build block header (80 bytes for Bitcoin-like)
	header := make([]byte, 80)
	
	// Version
	binary.LittleEndian.PutUint32(header[0:4], job.PrimaryBlock.CoinbaseTx.Version)
	
	// Previous block hash
	copy(header[4:36], job.PrimaryBlock.PrevBlockHash)
	
	// Merkle root
	copy(header[36:68], merkleRoot)
	
	// Timestamp
	binary.LittleEndian.PutUint32(header[68:72], timestamp)
	
	// Bits (difficulty target)
	binary.LittleEndian.PutUint32(header[72:76], 0x1d00ffff) // Placeholder
	
	// Nonce
	binary.LittleEndian.PutUint32(header[76:80], nonce)
	
	return header
}

// buildCoinbaseTransaction builds coinbase transaction with aux data
func (mm *MergedMiningManager) buildCoinbaseTransaction(job *MergedJob, extraNonce1, extraNonce2 []byte) []byte {
	coinbase := append(job.PrimaryBlock.Coinbase1, extraNonce1...)
	coinbase = append(coinbase, extraNonce2...)
	
	// Add auxiliary chain commitment
	if len(job.AuxMerkleRoot) > 0 {
		// Add OP_RETURN output with aux merkle root
		auxCommitment := make([]byte, 38)
		auxCommitment[0] = 0x6a // OP_RETURN
		auxCommitment[1] = 0x24 // 36 bytes
		auxCommitment[2] = 0x2f // '/'
		auxCommitment[3] = 0xfa // Magic bytes for merged mining
		auxCommitment[4] = 0xbe
		auxCommitment[5] = 0x6d
		copy(auxCommitment[6:], job.AuxMerkleRoot)
		
		coinbase = append(coinbase, auxCommitment...)
	}
	
	coinbase = append(coinbase, job.PrimaryBlock.Coinbase2...)
	
	return coinbase
}

// calculateMerkleRoot calculates the merkle root
func (mm *MergedMiningManager) calculateMerkleRoot(block *BlockTemplate, coinbase []byte) []byte {
	// Hash coinbase
	hash := sha256.Sum256(coinbase)
	hash = sha256.Sum256(hash[:])
	
	current := hash[:]
	
	// Calculate merkle root with other transactions
	for _, tx := range block.Transactions {
		combined := append(current, tx.Hash...)
		hash = sha256.Sum256(combined)
		hash = sha256.Sum256(hash[:])
		current = hash[:]
	}
	
	return current
}

// checkTarget checks if hash meets target difficulty
func (mm *MergedMiningManager) checkTarget(hash []byte, target []byte) bool {
	// Compare hash against target (big-endian comparison)
	for i := 31; i >= 0; i-- {
		if hash[i] > target[i] {
			return false
		} else if hash[i] < target[i] {
			return true
		}
	}
	return true
}

// submitPrimaryBlock submits primary block to network
func (mm *MergedMiningManager) submitPrimaryBlock(job *MergedJob, header []byte, hash []byte) {
	// Submit to primary chain network
	fmt.Printf("Submitting primary block: %s\n", hex.EncodeToString(hash))
	
	// This would normally submit via RPC to the blockchain node
	// For now, just log the submission
}

// submitAuxiliaryBlock submits auxiliary block to network
func (mm *MergedMiningManager) submitAuxiliaryBlock(auxChain *AuxiliaryChain, job *MergedJob, header []byte, hash []byte) {
	// Build auxiliary proof-of-work
	auxPOW := mm.buildAuxPOW(auxChain, job, header, hash)
	
	fmt.Printf("Submitting auxiliary block for %s: %s\n", 
		auxChain.Name, hex.EncodeToString(hash))
	
	// Submit to auxiliary chain network
	// This would normally submit via RPC with the AuxPOW
	_ = auxPOW
}

// buildAuxPOW builds auxiliary proof-of-work
func (mm *MergedMiningManager) buildAuxPOW(auxChain *AuxiliaryChain, job *MergedJob, header []byte, hash []byte) *AuxPOW {
	return &AuxPOW{
		CoinbaseTx:        job.PrimaryBlock.CoinbaseTx,
		BlockHash:         hash,
		CoinbaseBranch:    [][]byte{}, // Merkle branch to coinbase
		CoinbaseIndex:     0,
		ChainMerkleBranch: auxChain.MerkleBranch,
		ChainIndex:        uint32(auxChain.MerkleIndex),
		ParentBlock:       header,
	}
}

// jobUpdater updates mining jobs
func (mm *MergedMiningManager) jobUpdater() {
	defer mm.wg.Done()
	
	ticker := time.NewTicker(mm.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if err := mm.updateJob(); err != nil {
				fmt.Printf("Error updating job: %v\n", err)
			}
			
		case <-mm.ctx.Done():
			return
		}
	}
}

// updateJob updates the current merged mining job
func (mm *MergedMiningManager) updateJob() error {
	if mm.primaryChain == nil {
		return errors.New("no primary chain configured")
	}
	
	// Get primary block template
	primaryTemplate := mm.getPrimaryBlockTemplate()
	if primaryTemplate == nil {
		return errors.New("failed to get primary block template")
	}
	
	// Get auxiliary templates
	auxTemplates := mm.getAuxiliaryTemplates()
	
	// Build aux merkle tree
	auxMerkleRoot := mm.buildAuxMerkleTree(auxTemplates)
	
	// Create merged job
	jobID := fmt.Sprintf("merged_%d", mm.jobCounter.Add(1))
	job := &MergedJob{
		JobID:         jobID,
		PrimaryJobID:  primaryTemplate.JobID,
		PrimaryBlock:  primaryTemplate,
		AuxBlocks:     auxTemplates,
		AuxMerkleRoot: auxMerkleRoot,
		CreatedAt:     time.Now(),
		ValidUntil:    time.Now().Add(mm.config.JobTimeout),
	}
	
	mm.currentJob.Store(job)
	mm.totalJobs.Add(1)
	
	fmt.Printf("Updated merged mining job %s with %d aux chains\n", 
		jobID, len(auxTemplates))
	
	return nil
}

// getPrimaryBlockTemplate gets primary chain block template
func (mm *MergedMiningManager) getPrimaryBlockTemplate() *BlockTemplate {
	// This would normally get template via RPC
	// Returns optimized template based on algorithm
	
	prevHash := make([]byte, 32)
	// Fill with some data
	for i := range prevHash {
		prevHash[i] = byte(i)
	}
	
	return &BlockTemplate{
		JobID:           fmt.Sprintf("primary_%d", time.Now().Unix()),
		PrevBlockHash:   prevHash,
		Transactions:    []Transaction{},
		CoinbaseValue:   625000000, // 6.25 BTC in satoshis
		Target:          make([]byte, 32),
		Height:          800000,
		Coinbase1:       []byte{0x01, 0x00, 0x00, 0x00},
		Coinbase2:       []byte{0xff, 0xff, 0xff, 0xff},
		ExtraNonce1Size: 4,
		ExtraNonce2Size: 8,
	}
}

// getAuxiliaryTemplates gets auxiliary chain templates
func (mm *MergedMiningManager) getAuxiliaryTemplates() map[string]*AuxTemplate {
	templates := make(map[string]*AuxTemplate)
	
	mm.auxChainsMu.RLock()
	defer mm.auxChainsMu.RUnlock()
	
	for chainID, auxChain := range mm.auxChains {
		// Check profitability if enabled
		if mm.config.EnableProfitability {
			profitability := mm.calculateProfitability(auxChain)
			if profitability < mm.config.MinProfitability {
				continue
			}
		}
		
		template := mm.getAuxiliaryTemplate(auxChain)
		if template != nil {
			templates[chainID] = template
			auxChain.CurrentTemplate.Store(template)
		}
	}
	
	return templates
}

// getAuxiliaryTemplate gets template for auxiliary chain
func (mm *MergedMiningManager) getAuxiliaryTemplate(auxChain *AuxiliaryChain) *AuxTemplate {
	// This would normally get template via RPC
	// Returns optimized template based on algorithm
	
	blockHash := make([]byte, 32)
	target := make([]byte, 32)
	parentHash := make([]byte, 32)
	
	return &AuxTemplate{
		ChainID:         auxChain.ChainID,
		BlockHash:       blockHash,
		Target:          target,
		Height:          auxChain.BlockHeight,
		ParentBlockHash: parentHash,
	}
}

// calculateProfitability calculates profitability for aux chain
func (mm *MergedMiningManager) calculateProfitability(auxChain *AuxiliaryChain) float64 {
	// Simplified profitability calculation
	// Profitability = (Block Reward * Price) / (Network Difficulty * Block Time)
	
	reward := auxChain.BlockReward * auxChain.CurrentPrice
	difficulty := auxChain.Difficulty
	blockTime := auxChain.BlockTime.Seconds()
	
	if difficulty == 0 || blockTime == 0 {
		return 0
	}
	
	return reward / (difficulty * blockTime)
}

// buildAuxMerkleTree builds merkle tree for auxiliary chains
func (mm *MergedMiningManager) buildAuxMerkleTree(auxTemplates map[string]*AuxTemplate) []byte {
	if len(auxTemplates) == 0 {
		return nil
	}
	
	// Create leaves from aux chain hashes
	leaves := make([][]byte, 0, len(auxTemplates))
	
	mm.auxChainsMu.RLock()
	for chainID, template := range auxTemplates {
		if auxChain, exists := mm.auxChains[chainID]; exists {
			// Update merkle branch for this chain
			auxChain.MerkleBranch = [][]byte{} // Would be calculated properly
		}
		leaves = append(leaves, template.BlockHash)
	}
	mm.auxChainsMu.RUnlock()
	
	// Build merkle tree
	mm.merkleTree.Build(leaves)
	
	return mm.merkleTree.GetRoot()
}

// GetStatistics returns merged mining statistics
func (mm *MergedMiningManager) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	if mm.primaryChain != nil {
		stats["primary_chain"] = map[string]interface{}{
			"name":       mm.primaryChain.Name,
			"symbol":     mm.primaryChain.Symbol,
			"difficulty": mm.primaryChain.Difficulty,
			"height":     mm.primaryChain.BlockHeight,
		}
	}
	
	// Auxiliary chain statistics
	mm.auxChainsMu.RLock()
	auxStats := make([]map[string]interface{}, 0, len(mm.auxChains))
	for chainID, auxChain := range mm.auxChains {
		auxStats = append(auxStats, map[string]interface{}{
			"id":              chainID,
			"name":            auxChain.Name,
			"symbol":          auxChain.Symbol,
			"chain_id":        auxChain.ChainID,
			"difficulty":      auxChain.Difficulty,
			"height":          auxChain.BlockHeight,
			"accepted_blocks": auxChain.AcceptedBlocks.Load(),
			"rejected_blocks": auxChain.RejectedBlocks.Load(),
			"profitability":   mm.calculateProfitability(auxChain),
		})
	}
	mm.auxChainsMu.RUnlock()
	
	stats["auxiliary_chains"] = auxStats
	stats["aux_chain_count"] = len(auxStats)
	stats["total_jobs"] = mm.totalJobs.Load()
	stats["total_shares"] = mm.totalShares.Load()
	
	// Total auxiliary blocks
	var totalAuxBlocks uint64
	mm.auxBlocksMu.RLock()
	for _, count := range mm.auxBlocks {
		totalAuxBlocks += count.Load()
	}
	mm.auxBlocksMu.RUnlock()
	
	stats["total_aux_blocks"] = totalAuxBlocks
	
	return stats
}

// Stop stops the merged mining manager
func (mm *MergedMiningManager) Stop() {
	mm.cancel()
	mm.wg.Wait()
}

// NewMerkleTree creates a new merkle tree
func NewMerkleTree() *MerkleTree {
	return &MerkleTree{
		branches: make(map[int][][]byte),
		leaves:   make([][]byte, 0),
	}
}

// Build builds the merkle tree from leaves
func (mt *MerkleTree) Build(leaves [][]byte) {
	mt.mu.Lock()
	defer mt.mu.Unlock()
	
	if len(leaves) == 0 {
		mt.root = nil
		return
	}
	
	mt.leaves = make([][]byte, len(leaves))
	copy(mt.leaves, leaves)
	
	// Build tree bottom-up
	current := leaves
	level := 0
	
	for len(current) > 1 {
		next := make([][]byte, 0, (len(current)+1)/2)
		mt.branches[level] = make([][]byte, len(current))
		copy(mt.branches[level], current)
		
		for i := 0; i < len(current); i += 2 {
			var hash []byte
			if i+1 < len(current) {
				// Hash pair
				combined := append(current[i], current[i+1]...)
				h := sha256.Sum256(combined)
				hash = h[:]
			} else {
				// Odd number, duplicate last
				combined := append(current[i], current[i]...)
				h := sha256.Sum256(combined)
				hash = h[:]
			}
			next = append(next, hash)
		}
		
		current = next
		level++
	}
	
	if len(current) == 1 {
		mt.root = current[0]
	}
}

// GetRoot returns the merkle root
func (mt *MerkleTree) GetRoot() []byte {
	mt.mu.RLock()
	defer mt.mu.RUnlock()
	return mt.root
}

// GetBranch returns the merkle branch for a leaf index
func (mt *MerkleTree) GetBranch(index int) [][]byte {
	mt.mu.RLock()
	defer mt.mu.RUnlock()
	
	if index >= len(mt.leaves) {
		return nil
	}
	
	branch := make([][]byte, 0)
	currentIndex := index
	
	for level := 0; ; level++ {
		levelBranches, exists := mt.branches[level]
		if !exists {
			break
		}
		
		// Find sibling
		var sibling []byte
		if currentIndex%2 == 0 {
			// Even index, sibling is next
			if currentIndex+1 < len(levelBranches) {
				sibling = levelBranches[currentIndex+1]
			} else {
				sibling = levelBranches[currentIndex] // Duplicate for odd count
			}
		} else {
			// Odd index, sibling is previous
			sibling = levelBranches[currentIndex-1]
		}
		
		branch = append(branch, sibling)
		currentIndex /= 2
	}
	
	return branch
}