package mining

import (
	"encoding/binary"
	"errors"
	"math/bits"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ShareValidator provides optimized share validation
// Following John Carmack's principle: "Optimize for the hot path"
type ShareValidator struct {
	logger *zap.Logger
	
	// Validation cache for recent shares (prevent duplicates)
	recentShares map[string]time.Time
	cacheMutex   sync.RWMutex
	cacheSize    int
	cacheTTL     time.Duration
	
	// Performance counters
	validated   atomic.Uint64
	accepted    atomic.Uint64
	rejected    atomic.Uint64
	duplicates  atomic.Uint64
	
	// Difficulty targets
	poolDifficulty   uint64
	networkDifficulty uint64
	difficultyMutex  sync.RWMutex
}

// Share represents a mining share
type Share struct {
	JobID      string
	WorkerID   string
	Nonce      uint64
	Hash       []byte
	Timestamp  time.Time
	Difficulty uint64
}

// ValidationResult contains the result of share validation
type ValidationResult struct {
	Valid      bool
	IsBlock    bool
	Reason     string
	Difficulty uint64
}

// NewShareValidator creates a new share validator
func NewShareValidator(logger *zap.Logger) *ShareValidator {
	sv := &ShareValidator{
		logger:       logger,
		recentShares: make(map[string]time.Time),
		cacheSize:    10000,
		cacheTTL:     5 * time.Minute,
	}
	
	// Start cache cleaner
	go sv.cleanCache()
	
	return sv
}

// SetDifficulty sets the pool and network difficulty
func (sv *ShareValidator) SetDifficulty(poolDiff, networkDiff uint64) {
	sv.difficultyMutex.Lock()
	sv.poolDifficulty = poolDiff
	sv.networkDifficulty = networkDiff
	sv.difficultyMutex.Unlock()
	
	sv.logger.Info("Difficulty updated",
		zap.Uint64("pool_difficulty", poolDiff),
		zap.Uint64("network_difficulty", networkDiff),
	)
}

// ValidateShare validates a mining share
func (sv *ShareValidator) ValidateShare(share *Share) ValidationResult {
	sv.validated.Add(1)
	
	// Fast path: basic validation
	if err := sv.basicValidation(share); err != nil {
		sv.rejected.Add(1)
		return ValidationResult{
			Valid:  false,
			Reason: err.Error(),
		}
	}
	
	// Check for duplicate shares
	if sv.isDuplicate(share) {
		sv.duplicates.Add(1)
		sv.rejected.Add(1)
		return ValidationResult{
			Valid:  false,
			Reason: "duplicate share",
		}
	}
	
	// Validate difficulty
	sv.difficultyMutex.RLock()
	poolDiff := sv.poolDifficulty
	networkDiff := sv.networkDifficulty
	sv.difficultyMutex.RUnlock()
	
	shareDiff := sv.calculateDifficulty(share.Hash)
	
	if shareDiff < poolDiff {
		sv.rejected.Add(1)
		return ValidationResult{
			Valid:      false,
			Reason:     "difficulty too low",
			Difficulty: shareDiff,
		}
	}
	
	// Cache the share
	sv.cacheShare(share)
	sv.accepted.Add(1)
	
	// Check if it's a block
	isBlock := shareDiff >= networkDiff
	if isBlock {
		sv.logger.Info("Block found!",
			zap.String("worker", share.WorkerID),
			zap.Uint64("difficulty", shareDiff),
		)
	}
	
	return ValidationResult{
		Valid:      true,
		IsBlock:    isBlock,
		Difficulty: shareDiff,
	}
}

// GetStats returns validation statistics
func (sv *ShareValidator) GetStats() (validated, accepted, rejected, duplicates uint64) {
	return sv.validated.Load(), sv.accepted.Load(), sv.rejected.Load(), sv.duplicates.Load()
}

// Private methods

func (sv *ShareValidator) basicValidation(share *Share) error {
	// Check required fields
	if share.JobID == "" {
		return errors.New("missing job ID")
	}
	if share.WorkerID == "" {
		return errors.New("missing worker ID")
	}
	if len(share.Hash) != 32 {
		return errors.New("invalid hash length")
	}
	
	// Check timestamp (not too old, not in future)
	now := time.Now()
	if share.Timestamp.After(now.Add(30 * time.Second)) {
		return errors.New("timestamp too far in future")
	}
	if share.Timestamp.Before(now.Add(-10 * time.Minute)) {
		return errors.New("timestamp too old")
	}
	
	return nil
}

func (sv *ShareValidator) isDuplicate(share *Share) bool {
	// Create unique key for share
	key := sv.shareKey(share)
	
	sv.cacheMutex.RLock()
	_, exists := sv.recentShares[key]
	sv.cacheMutex.RUnlock()
	
	return exists
}

func (sv *ShareValidator) cacheShare(share *Share) {
	key := sv.shareKey(share)
	
	sv.cacheMutex.Lock()
	defer sv.cacheMutex.Unlock()
	
	// Enforce cache size limit
	if len(sv.recentShares) >= sv.cacheSize {
		// Remove oldest entry (simple strategy)
		var oldestKey string
		var oldestTime time.Time
		for k, t := range sv.recentShares {
			if oldestTime.IsZero() || t.Before(oldestTime) {
				oldestKey = k
				oldestTime = t
			}
		}
		delete(sv.recentShares, oldestKey)
	}
	
	sv.recentShares[key] = share.Timestamp
}

func (sv *ShareValidator) shareKey(share *Share) string {
	// Create unique key from share data
	// Using first 8 bytes of hash + nonce + job ID
	return string(share.Hash[:8]) + string(share.Nonce) + share.JobID
}

func (sv *ShareValidator) calculateDifficulty(hash []byte) uint64 {
	// Count leading zeros in hash
	zeros := 0
	for _, b := range hash {
		if b == 0 {
			zeros += 8
		} else {
			// Count leading zeros in byte
			for i := 7; i >= 0; i-- {
				if b&(1<<uint(i)) == 0 {
					zeros++
				} else {
					break
				}
			}
			break
		}
	}
	
	// Simplified difficulty calculation
	// Real implementation would use proper difficulty encoding
	return uint64(zeros) * 1000000000
}

func (sv *ShareValidator) cleanCache() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		sv.cacheMutex.Lock()
		now := time.Now()
		for key, timestamp := range sv.recentShares {
			if now.Sub(timestamp) > sv.cacheTTL {
				delete(sv.recentShares, key)
			}
		}
		sv.cacheMutex.Unlock()
	}
}

// FastShareValidator provides ultra-fast share validation using optimized algorithms
type FastShareValidator struct {
	logger *zap.Logger
	
	// Pre-computed difficulty targets
	targets      [256]uint64 // Indexed by leading zeros
	targetsMutex sync.RWMutex
	
	// Bloom filter for duplicate detection (more memory efficient)
	bloomFilter  []uint64
	bloomSize    int
	bloomMutex   sync.RWMutex
	
	// Stats
	stats struct {
		validated  atomic.Uint64
		accepted   atomic.Uint64
		rejected   atomic.Uint64
		duplicates atomic.Uint64
	}
}

// NewFastShareValidator creates an optimized share validator
func NewFastShareValidator(logger *zap.Logger) *FastShareValidator {
	fsv := &FastShareValidator{
		logger:      logger,
		bloomSize:   1 << 20, // 1M bits
		bloomFilter: make([]uint64, 1<<14), // 16K uint64s = 1M bits
	}
	
	// Pre-compute difficulty targets
	fsv.precomputeTargets()
	
	return fsv
}

// ValidateFast performs ultra-fast share validation
func (fsv *FastShareValidator) ValidateFast(hash []byte, nonce uint64, difficulty uint64) bool {
	fsv.stats.validated.Add(1)
	
	// Fast difficulty check using pre-computed targets
	if !fsv.checkDifficultyFast(hash, difficulty) {
		fsv.stats.rejected.Add(1)
		return false
	}
	
	// Fast duplicate check using bloom filter
	if fsv.checkDuplicateFast(hash, nonce) {
		fsv.stats.duplicates.Add(1)
		fsv.stats.rejected.Add(1)
		return false
	}
	
	// Mark as seen
	fsv.markSeenFast(hash, nonce)
	
	fsv.stats.accepted.Add(1)
	return true
}

func (fsv *FastShareValidator) precomputeTargets() {
	// Pre-compute difficulty targets for fast lookup
	for i := 0; i < 256; i++ {
		fsv.targets[i] = uint64(i) * 1000000000
	}
}

func (fsv *FastShareValidator) checkDifficultyFast(hash []byte, minDifficulty uint64) bool {
	// Count leading zeros
	zeros := 0
	for _, b := range hash {
		if b == 0 {
			zeros += 8
		} else {
			// Use bit manipulation tricks for fast counting
			zeros += bits.LeadingZeros8(b)
			break
		}
	}
	
	fsv.targetsMutex.RLock()
	difficulty := fsv.targets[zeros]
	fsv.targetsMutex.RUnlock()
	
	return difficulty >= minDifficulty
}

func (fsv *FastShareValidator) checkDuplicateFast(hash []byte, nonce uint64) bool {
	// Use multiple hash functions for bloom filter
	h1, h2 := fsv.bloomHash(hash, nonce)
	
	fsv.bloomMutex.RLock()
	defer fsv.bloomMutex.RUnlock()
	
	// Check if both bits are set
	idx1 := h1 % uint64(fsv.bloomSize)
	idx2 := h2 % uint64(fsv.bloomSize)
	
	word1 := idx1 / 64
	bit1 := idx1 % 64
	word2 := idx2 / 64
	bit2 := idx2 % 64
	
	return (fsv.bloomFilter[word1]&(1<<bit1) != 0) &&
		(fsv.bloomFilter[word2]&(1<<bit2) != 0)
}

func (fsv *FastShareValidator) markSeenFast(hash []byte, nonce uint64) {
	h1, h2 := fsv.bloomHash(hash, nonce)
	
	fsv.bloomMutex.Lock()
	defer fsv.bloomMutex.Unlock()
	
	// Set both bits
	idx1 := h1 % uint64(fsv.bloomSize)
	idx2 := h2 % uint64(fsv.bloomSize)
	
	word1 := idx1 / 64
	bit1 := idx1 % 64
	word2 := idx2 / 64
	bit2 := idx2 % 64
	
	fsv.bloomFilter[word1] |= (1 << bit1)
	fsv.bloomFilter[word2] |= (1 << bit2)
}

func (fsv *FastShareValidator) bloomHash(hash []byte, nonce uint64) (uint64, uint64) {
	// Simple but effective hash functions for bloom filter
	h1 := binary.BigEndian.Uint64(hash[:8]) ^ nonce
	h2 := binary.BigEndian.Uint64(hash[24:]) ^ (nonce << 32)
	return h1, h2
}

// ClearBloomFilter clears the bloom filter (call periodically)
func (fsv *FastShareValidator) ClearBloomFilter() {
	fsv.bloomMutex.Lock()
	defer fsv.bloomMutex.Unlock()
	
	for i := range fsv.bloomFilter {
		fsv.bloomFilter[i] = 0
	}
	
	fsv.logger.Info("Bloom filter cleared")
}

// BatchValidator validates shares in batches for better performance
type BatchValidator struct {
	validator *ShareValidator
	logger    *zap.Logger
	
	batchSize int
	batch     []Share
	results   chan []ValidationResult
	mu        sync.Mutex
}

// NewBatchValidator creates a batch validator
func NewBatchValidator(validator *ShareValidator, logger *zap.Logger) *BatchValidator {
	return &BatchValidator{
		validator: validator,
		logger:    logger,
		batchSize: 100,
		batch:     make([]Share, 0, 100),
		results:   make(chan []ValidationResult, 10),
	}
}

// AddShare adds a share to the batch
func (bv *BatchValidator) AddShare(share Share) {
	bv.mu.Lock()
	defer bv.mu.Unlock()
	
	bv.batch = append(bv.batch, share)
	
	if len(bv.batch) >= bv.batchSize {
		// Process batch
		go bv.processBatch(bv.batch)
		bv.batch = make([]Share, 0, bv.batchSize)
	}
}

// Flush processes any remaining shares
func (bv *BatchValidator) Flush() {
	bv.mu.Lock()
	defer bv.mu.Unlock()
	
	if len(bv.batch) > 0 {
		go bv.processBatch(bv.batch)
		bv.batch = make([]Share, 0, bv.batchSize)
	}
}

func (bv *BatchValidator) processBatch(shares []Share) {
	results := make([]ValidationResult, len(shares))
	
	// Validate shares in parallel
	var wg sync.WaitGroup
	for i := range shares {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			results[idx] = bv.validator.ValidateShare(&shares[idx])
		}(i)
	}
	
	wg.Wait()
	bv.results <- results
}

// GetResults returns the results channel
func (bv *BatchValidator) GetResults() <-chan []ValidationResult {
	return bv.results
}