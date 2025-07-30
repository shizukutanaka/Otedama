package algorithms

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sort"
	"sync"
	"time"
)

// MergedMiningAlgorithm implements merged mining (auxiliary proof-of-work)
type MergedMiningAlgorithm struct {
	*Algorithm
	parentChain    *ChainConfig
	auxiliaryChains []*ChainConfig
	merkleTree     *MerkleTree
	mu             sync.RWMutex
}

// ChainConfig represents a blockchain configuration for merged mining
type ChainConfig struct {
	Name          string
	ChainID       uint64
	Algorithm     *Algorithm
	Difficulty    float64
	BlockReward   float64
	Active        bool
	AuxPowEnabled bool
}

// MerkleTree represents Merkle tree for merged mining
type MerkleTree struct {
	Root     []byte
	Leaves   [][]byte
	Branches [][]MerkleBranch
}

// MerkleBranch represents a branch in Merkle tree
type MerkleBranch struct {
	Hash  []byte
	Side  int // 0 = left, 1 = right
}

// AuxiliaryProofOfWork represents auxiliary proof of work
type AuxiliaryProofOfWork struct {
	ChainID      uint64
	BlockHash    []byte
	ParentHash   []byte
	MerkleRoot   []byte
	MerkleBranch []MerkleBranch
	ChainMerkleRoot   []byte
	ChainMerkleBranch []MerkleBranch
}

// NewMergedMining creates a new merged mining algorithm
func NewMergedMining(parentChain *ChainConfig) *MergedMiningAlgorithm {
	baseAlgo := &Algorithm{
		Name:         "merged_mining",
		DisplayName:  "Merged Mining",
		Type:         TypeMergedMining,
		HashFunction: nil, // Set dynamically based on parent chain
		ValidateFunc: sha256Validate,
		DifficultyFunc: calculateDifficulty,
		Config: AlgorithmConfig{
			GPUOptimized:   false,
			ASICResistant:  false,
			CPUFriendly:    true,
			ThreadsPerHash: 1,
		},
	}
	
	return &MergedMiningAlgorithm{
		Algorithm:       baseAlgo,
		parentChain:     parentChain,
		auxiliaryChains: make([]*ChainConfig, 0, 16), // Support up to 16 aux chains
		merkleTree:      &MerkleTree{},
	}
}

// AddAuxiliaryChain adds an auxiliary chain for merged mining
func (mm *MergedMiningAlgorithm) AddAuxiliaryChain(chain *ChainConfig) error {
	mm.mu.Lock()
	defer mm.mu.Unlock()
	
	// Check if chain already exists
	for _, existing := range mm.auxiliaryChains {
		if existing.ChainID == chain.ChainID {
			return fmt.Errorf("chain %d already exists", chain.ChainID)
		}
	}
	
	// Validate auxiliary chain configuration
	if err := mm.validateAuxiliaryChain(chain); err != nil {
		return fmt.Errorf("invalid auxiliary chain: %v", err)
	}
	
	chain.AuxPowEnabled = true
	mm.auxiliaryChains = append(mm.auxiliaryChains, chain)
	
	// Rebuild Merkle tree
	return mm.rebuildMerkleTree()
}

// RemoveAuxiliaryChain removes an auxiliary chain
func (mm *MergedMiningAlgorithm) RemoveAuxiliaryChain(chainID uint64) error {
	mm.mu.Lock()
	defer mm.mu.Unlock()
	
	for i, chain := range mm.auxiliaryChains {
		if chain.ChainID == chainID {
			// Remove chain
			mm.auxiliaryChains = append(mm.auxiliaryChains[:i], mm.auxiliaryChains[i+1:]...)
			
			// Rebuild Merkle tree
			return mm.rebuildMerkleTree()
		}
	}
	
	return fmt.Errorf("chain %d not found", chainID)
}

// validateAuxiliaryChain validates auxiliary chain configuration
func (mm *MergedMiningAlgorithm) validateAuxiliaryChain(chain *ChainConfig) error {
	if chain.ChainID == 0 {
		return fmt.Errorf("invalid chain ID")
	}
	
	if chain.Algorithm == nil {
		return fmt.Errorf("algorithm not specified")
	}
	
	if chain.Difficulty <= 0 {
		return fmt.Errorf("invalid difficulty")
	}
	
	// Check if parent algorithm is compatible
	if mm.parentChain.Algorithm.Type != chain.Algorithm.Type {
		return fmt.Errorf("incompatible algorithm types")
	}
	
	return nil
}

// rebuildMerkleTree rebuilds the Merkle tree for auxiliary chains
func (mm *MergedMiningAlgorithm) rebuildMerkleTree() error {
	if len(mm.auxiliaryChains) == 0 {
		mm.merkleTree = &MerkleTree{}
		return nil
	}
	
	// Sort chains by chain ID for deterministic order
	chains := make([]*ChainConfig, len(mm.auxiliaryChains))
	copy(chains, mm.auxiliaryChains)
	sort.Slice(chains, func(i, j int) bool {
		return chains[i].ChainID < chains[j].ChainID
	})
	
	// Create leaves (chain IDs)
	leaves := make([][]byte, len(chains))
	for i, chain := range chains {
		chainIDBytes := make([]byte, 8)
		binary.LittleEndian.PutUint64(chainIDBytes, chain.ChainID)
		leavesHash := sha256.Sum256(chainIDBytes)
		leaves[i] = leavesHash[:]
	}
	
	// Build Merkle tree
	mm.merkleTree = buildMerkleTree(leaves)
	
	return nil
}

// buildMerkleTree builds a Merkle tree from leaves
func buildMerkleTree(leaves [][]byte) *MerkleTree {
	if len(leaves) == 0 {
		return &MerkleTree{}
	}
	
	tree := &MerkleTree{
		Leaves:   make([][]byte, len(leaves)),
		Branches: make([][]MerkleBranch, 0),
	}
	
	copy(tree.Leaves, leaves)
	
	// Build tree bottom-up
	currentLevel := leaves
	
	for len(currentLevel) > 1 {
		nextLevel := make([][]byte, 0, (len(currentLevel)+1)/2)
		branches := make([]MerkleBranch, 0, len(currentLevel))
		
		for i := 0; i < len(currentLevel); i += 2 {
			left := currentLevel[i]
			var right []byte
			
			if i+1 < len(currentLevel) {
				right = currentLevel[i+1]
			} else {
				// Odd number of nodes, duplicate the last one
				right = left
			}
			
			// Create parent hash
			combined := append(left, right...)
			parentArray := sha256.Sum256(combined)
			parent := parentArray[:]
			nextLevel = append(nextLevel, parent[:])
			
			// Store branches
			branches = append(branches, MerkleBranch{Hash: left, Side: 0})
			branches = append(branches, MerkleBranch{Hash: right, Side: 1})
		}
		
		tree.Branches = append(tree.Branches, branches)
		currentLevel = nextLevel
	}
	
	if len(currentLevel) > 0 {
		tree.Root = currentLevel[0]
	}
	
	return tree
}

// GenerateAuxiliaryProofOfWork generates auxiliary proof of work for a chain
func (mm *MergedMiningAlgorithm) GenerateAuxiliaryProofOfWork(chainID uint64, blockHash []byte) (*AuxiliaryProofOfWork, error) {
	mm.mu.RLock()
	defer mm.mu.RUnlock()
	
	// Find the auxiliary chain
	var targetChain *ChainConfig
	var chainIndex int
	
	for i, chain := range mm.auxiliaryChains {
		if chain.ChainID == chainID {
			targetChain = chain
			chainIndex = i
			break
		}
	}
	
	if targetChain == nil {
		return nil, fmt.Errorf("chain %d not found", chainID)
	}
	
	// Generate Merkle branch for the chain
	merkleBranch := mm.generateMerkleBranch(chainIndex)
	
	// Generate chain Merkle branch (for multiple blocks)
	chainMerkleBranch := mm.generateChainMerkleBranch(blockHash)
	
	auxPow := &AuxiliaryProofOfWork{
		ChainID:           chainID,
		BlockHash:         blockHash,
		ParentHash:        mm.getParentBlockHash(),
		MerkleRoot:        mm.merkleTree.Root,
		MerkleBranch:      merkleBranch,
		ChainMerkleRoot:   mm.calculateChainMerkleRoot(blockHash),
		ChainMerkleBranch: chainMerkleBranch,
	}
	
	return auxPow, nil
}

// generateMerkleBranch generates Merkle branch for chain position
func (mm *MergedMiningAlgorithm) generateMerkleBranch(chainIndex int) []MerkleBranch {
	if len(mm.merkleTree.Branches) == 0 {
		return nil
	}
	
	branch := make([]MerkleBranch, 0)
	index := chainIndex
	
	for level := 0; level < len(mm.merkleTree.Branches); level++ {
		levelBranches := mm.merkleTree.Branches[level]
		
		// Find sibling
		siblingIndex := index ^ 1 // XOR with 1 to get sibling
		if siblingIndex*2 < len(levelBranches) {
			sibling := levelBranches[siblingIndex*2]
			branch = append(branch, sibling)
		}
		
		index /= 2
	}
	
	return branch
}

// generateChainMerkleBranch generates Merkle branch for chain blocks
func (mm *MergedMiningAlgorithm) generateChainMerkleBranch(blockHash []byte) []MerkleBranch {
	// Simplified chain Merkle branch generation
	// In real implementation, this would include multiple blocks
	return []MerkleBranch{
		{Hash: blockHash, Side: 0},
	}
}

// calculateChainMerkleRoot calculates Merkle root for chain
func (mm *MergedMiningAlgorithm) calculateChainMerkleRoot(blockHash []byte) []byte {
	// Simplified chain Merkle root calculation
	hashArray := sha256.Sum256(blockHash)
	return hashArray[:]
}

// getParentBlockHash gets parent block hash
func (mm *MergedMiningAlgorithm) getParentBlockHash() []byte {
	// Placeholder - would get from parent chain
	return make([]byte, 32)
}

// ValidateAuxiliaryProofOfWork validates auxiliary proof of work
func (mm *MergedMiningAlgorithm) ValidateAuxiliaryProofOfWork(auxPow *AuxiliaryProofOfWork) error {
	mm.mu.RLock()
	defer mm.mu.RUnlock()
	
	// Find the auxiliary chain
	var targetChain *ChainConfig
	for _, chain := range mm.auxiliaryChains {
		if chain.ChainID == auxPow.ChainID {
			targetChain = chain
			break
		}
	}
	
	if targetChain == nil {
		return fmt.Errorf("chain %d not found", auxPow.ChainID)
	}
	
	// Validate Merkle root
	if !bytesEqual(auxPow.MerkleRoot, mm.merkleTree.Root) {
		return fmt.Errorf("invalid Merkle root")
	}
	
	// Validate Merkle branch
	if err := mm.validateMerkleBranch(auxPow.ChainID, auxPow.MerkleBranch); err != nil {
		return fmt.Errorf("invalid Merkle branch: %v", err)
	}
	
	// Validate chain Merkle branch
	if err := mm.validateChainMerkleBranch(auxPow.BlockHash, auxPow.ChainMerkleBranch, auxPow.ChainMerkleRoot); err != nil {
		return fmt.Errorf("invalid chain Merkle branch: %v", err)
	}
	
	// Validate parent block hash exists and meets difficulty
	if err := mm.validateParentBlock(auxPow.ParentHash, targetChain.Difficulty); err != nil {
		return fmt.Errorf("invalid parent block: %v", err)
	}
	
	return nil
}

// validateMerkleBranch validates Merkle branch
func (mm *MergedMiningAlgorithm) validateMerkleBranch(chainID uint64, branch []MerkleBranch) error {
	// Find chain index
	chainIndex := -1
	for i, chain := range mm.auxiliaryChains {
		if chain.ChainID == chainID {
			chainIndex = i
			break
		}
	}
	
	if chainIndex == -1 {
		return fmt.Errorf("chain not found")
	}
	
	// Start with chain ID hash
	chainIDBytes := make([]byte, 8)
	binary.LittleEndian.PutUint64(chainIDBytes, chainID)
	currentArray := sha256.Sum256(chainIDBytes)
	current := currentArray[:]
	
	// Traverse branch
	index := chainIndex
	for _, branchNode := range branch {
		var combined []byte
		if branchNode.Side == 0 {
			combined = append(current, branchNode.Hash...)
		} else {
			combined = append(branchNode.Hash, current...)
		}
		
		currentArray := sha256.Sum256(combined)
		current = currentArray[:]
		index /= 2
	}
	
	// Should match Merkle root
	if !bytesEqual(current, mm.merkleTree.Root) {
		return fmt.Errorf("Merkle branch validation failed")
	}
	
	return nil
}

// validateChainMerkleBranch validates chain Merkle branch
func (mm *MergedMiningAlgorithm) validateChainMerkleBranch(blockHash []byte, branch []MerkleBranch, root []byte) error {
	current := blockHash
	
	for _, branchNode := range branch {
		var combined []byte
		if branchNode.Side == 0 {
			combined = append(current, branchNode.Hash...)
		} else {
			combined = append(branchNode.Hash, current...)
		}
		
		currentArray := sha256.Sum256(combined)
		current = currentArray[:]
	}
	
	if !bytesEqual(current, root) {
		return fmt.Errorf("chain Merkle branch validation failed")
	}
	
	return nil
}

// validateParentBlock validates parent block
func (mm *MergedMiningAlgorithm) validateParentBlock(parentHash []byte, minDifficulty float64) error {
	// Simplified validation - would check against parent chain
	if len(parentHash) != 32 {
		return fmt.Errorf("invalid parent hash length")
	}
	
	// Calculate difficulty from hash (simplified)
	difficulty := calculateHashDifficulty(parentHash)
	if difficulty < minDifficulty {
		return fmt.Errorf("insufficient difficulty: %f < %f", difficulty, minDifficulty)
	}
	
	return nil
}

// Hash performs merged mining hash
func (mm *MergedMiningAlgorithm) Hash(data []byte, nonce uint64) ([]byte, error) {
	// Use parent chain's hash function
	if mm.parentChain.Algorithm.HashFunction == nil {
		return nil, fmt.Errorf("parent chain hash function not set")
	}
	
	return mm.parentChain.Algorithm.HashFunction(data, nonce)
}

// GetActiveChains returns list of active auxiliary chains
func (mm *MergedMiningAlgorithm) GetActiveChains() []*ChainConfig {
	mm.mu.RLock()
	defer mm.mu.RUnlock()
	
	active := make([]*ChainConfig, 0, len(mm.auxiliaryChains))
	for _, chain := range mm.auxiliaryChains {
		if chain.Active {
			active = append(active, chain)
		}
	}
	
	return active
}

// SetChainActive sets chain active status
func (mm *MergedMiningAlgorithm) SetChainActive(chainID uint64, active bool) error {
	mm.mu.Lock()
	defer mm.mu.Unlock()
	
	for _, chain := range mm.auxiliaryChains {
		if chain.ChainID == chainID {
			chain.Active = active
			return nil
		}
	}
	
	return fmt.Errorf("chain %d not found", chainID)
}

// UpdateChainDifficulty updates chain difficulty
func (mm *MergedMiningAlgorithm) UpdateChainDifficulty(chainID uint64, difficulty float64) error {
	mm.mu.Lock()
	defer mm.mu.Unlock()
	
	if difficulty <= 0 {
		return fmt.Errorf("invalid difficulty")
	}
	
	for _, chain := range mm.auxiliaryChains {
		if chain.ChainID == chainID {
			chain.Difficulty = difficulty
			return nil
		}
	}
	
	return fmt.Errorf("chain %d not found", chainID)
}

// MergedMiningStats represents merged mining statistics
type MergedMiningStats struct {
	ParentChain     string
	AuxiliaryChains []AuxChainStats
	TotalHashRate   float64
	TotalReward     float64
	Efficiency      float64
	Timestamp       time.Time
}

// AuxChainStats represents auxiliary chain statistics
type AuxChainStats struct {
	ChainID     uint64
	Name        string
	HashRate    float64
	Difficulty  float64
	BlockReward float64
	Active      bool
}

// GetMergedMiningStats returns merged mining statistics
func (mm *MergedMiningAlgorithm) GetMergedMiningStats() MergedMiningStats {
	mm.mu.RLock()
	defer mm.mu.RUnlock()
	
	auxStats := make([]AuxChainStats, len(mm.auxiliaryChains))
	totalHashRate := 0.0
	totalReward := 0.0
	
	for i, chain := range mm.auxiliaryChains {
		hashRate := estimateChainHashRate(chain)
		auxStats[i] = AuxChainStats{
			ChainID:     chain.ChainID,
			Name:        chain.Name,
			HashRate:    hashRate,
			Difficulty:  chain.Difficulty,
			BlockReward: chain.BlockReward,
			Active:      chain.Active,
		}
		
		if chain.Active {
			totalHashRate += hashRate
			totalReward += chain.BlockReward
		}
	}
	
	// Calculate efficiency (total reward per hash)
	efficiency := 0.0
	if totalHashRate > 0 {
		efficiency = totalReward / totalHashRate
	}
	
	return MergedMiningStats{
		ParentChain:     mm.parentChain.Name,
		AuxiliaryChains: auxStats,
		TotalHashRate:   totalHashRate,
		TotalReward:     totalReward,
		Efficiency:      efficiency,
		Timestamp:       time.Now(),
	}
}

// estimateChainHashRate estimates hash rate for a chain
func estimateChainHashRate(chain *ChainConfig) float64 {
	// Simplified estimation based on difficulty
	baseHashRate := 1000000.0 // 1 MH/s
	return baseHashRate * chain.Difficulty / 1000000.0
}

// calculateHashDifficulty calculates difficulty from hash
func calculateHashDifficulty(hash []byte) float64 {
	if len(hash) < 4 {
		return 0
	}
	
	// Count leading zero bits
	leadingZeros := 0
	for _, b := range hash {
		if b == 0 {
			leadingZeros += 8
		} else {
			for mask := byte(0x80); mask > 0; mask >>= 1 {
				if b&mask == 0 {
					leadingZeros++
				} else {
					break
				}
			}
			break
		}
	}
	
	// Convert to difficulty
	return float64(uint64(1) << leadingZeros)
}

// Utility functions

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

// EstimateMergedMiningProfit estimates merged mining profitability
func EstimateMergedMiningProfit(parentReward float64, auxRewards []float64, hashRate float64) float64 {
	totalReward := parentReward
	for _, reward := range auxRewards {
		totalReward += reward
	}
	
	// Calculate profit per hash
	if hashRate > 0 {
		return totalReward / hashRate
	}
	
	return 0
}

// ValidateMergedMiningSetup validates merged mining setup
func ValidateMergedMiningSetup(parent *ChainConfig, auxiliaries []*ChainConfig) error {
	if parent == nil {
		return fmt.Errorf("parent chain not specified")
	}
	
	if len(auxiliaries) == 0 {
		return fmt.Errorf("no auxiliary chains specified")
	}
	
	if len(auxiliaries) > 16 {
		return fmt.Errorf("too many auxiliary chains (max 16)")
	}
	
	// Check for duplicate chain IDs
	seen := make(map[uint64]bool)
	seen[parent.ChainID] = true
	
	for _, aux := range auxiliaries {
		if seen[aux.ChainID] {
			return fmt.Errorf("duplicate chain ID: %d", aux.ChainID)
		}
		seen[aux.ChainID] = true
		
		// Validate compatibility
		if aux.Algorithm.Type != parent.Algorithm.Type {
			return fmt.Errorf("incompatible algorithm for chain %d", aux.ChainID)
		}
	}
	
	return nil
}

// CreateMergedMiningTemplate creates merged mining block template
func CreateMergedMiningTemplate(mm *MergedMiningAlgorithm, parentTemplate []byte) ([]byte, error) {
	// Include auxiliary chain commitments in parent block
	template := make([]byte, len(parentTemplate))
	copy(template, parentTemplate)
	
	// Add Merkle root of auxiliary chains
	if mm.merkleTree.Root != nil {
		template = append(template, mm.merkleTree.Root...)
	}
	
	// Add auxiliary chain metadata
	auxData := make([]byte, 0)
	for _, chain := range mm.auxiliaryChains {
		if chain.Active {
			chainData := make([]byte, 16) // 8 bytes chain ID + 8 bytes difficulty
			binary.LittleEndian.PutUint64(chainData[:8], chain.ChainID)
			binary.LittleEndian.PutUint64(chainData[8:], uint64(chain.Difficulty))
			auxData = append(auxData, chainData...)
		}
	}
	
	template = append(template, auxData...)
	
	return template, nil
}