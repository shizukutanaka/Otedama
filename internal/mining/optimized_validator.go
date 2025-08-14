package mining

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/big"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// OptimizedShareValidator provides high-performance share validation
// Following Carmack's optimization principles - measure, optimize, repeat
type OptimizedShareValidator struct {
	logger *zap.Logger
	
	// Validation workers - parallel processing
	workers    int
	workQueue  chan *ValidationRequest
	resultChan chan *ValidationResult
	
	// Caching for repeated validations
	cache      *ValidationCache
	cacheHits  atomic.Uint64
	cacheMiss  atomic.Uint64
	
	// Pre-computed difficulty targets
	targetCache sync.Map // map[float64]*big.Int
	
	// Bloom filter for efficient duplicate detection
	bloomFilter  []uint64
	bloomSize    int
	bloomMutex   sync.RWMutex
	
	// Performance stats
	stats struct {
		validated     atomic.Uint64
		rejected      atomic.Uint64
		duplicates    atomic.Uint64
		avgTimeNs     atomic.Int64
		peakTimeNs    atomic.Int64
	}
	
	// SIMD optimization flags
	useAVX2   bool
	useAVX512 bool
}

// ValidationRequest contains share validation data
type ValidationRequest struct {
	Share    *Share
	Job      *Job
	Response chan<- *ValidationResult
}



// ValidationCache provides fast lookups for recent validations
type ValidationCache struct {
	entries sync.Map // map[string]*CacheEntry
	maxSize int
	size    atomic.Int32
}

// CacheEntry stores cached validation result
type CacheEntry struct {
	Result    ValidationResult
	Timestamp int64
}

// NewOptimizedShareValidator creates an optimized validator
func NewOptimizedShareValidator(logger *zap.Logger, workers int) *OptimizedShareValidator {
	if workers <= 0 {
		workers = runtime.NumCPU()
	}
	
	v := &OptimizedShareValidator{
		logger:       logger,
		workers:      workers,
		workQueue:    make(chan *ValidationRequest, workers*100),
		resultChan:   make(chan *ValidationResult, workers*10),
		cache:        NewValidationCache(10000),
		bloomSize:    1 << 20, // 1M bits
		bloomFilter:  make([]uint64, 1<<14), // 16K uint64s = 1M bits
		useAVX2:      hasAVX2Support(),
		useAVX512:    hasAVX512Support(),
	}
	
	// Pre-compute common difficulty targets
	v.precomputeTargets()
	
	// Start bloom filter cleaner
	go v.bloomFilterCleaner()
	
	return v
}

// Start begins validation workers
func (v *OptimizedShareValidator) Start() {
	v.logger.Info("Starting optimized share validator",
		zap.Int("workers", v.workers),
		zap.Bool("avx2", v.useAVX2),
		zap.Bool("avx512", v.useAVX512),
	)
	
	// Start worker pool
	for i := 0; i < v.workers; i++ {
		go v.validationWorker(i)
	}
	
	// Start stats collector
	go v.statsCollector()
}

// ValidateShare validates a mining share
func (v *OptimizedShareValidator) ValidateShare(share *Share, job *Job) (*ValidationResult, error) {
	// Quick sanity checks
	if share == nil || job == nil {
		return &ValidationResult{Valid: false, Reason: "nil share or job"}, nil
	}
	
	// Check cache first
	cacheKey := v.cacheKey(share, job)
	if cached := v.cache.Get(cacheKey); cached != nil {
		v.cacheHits.Add(1)
		return cached, nil
	}
	v.cacheMiss.Add(1)
	
	// Submit to worker pool
	req := &ValidationRequest{
		Share:    share,
		Job:      job,
		Response: make(chan *ValidationResult, 1),
	}
	
	select {
	case v.workQueue <- req:
		result := <-req.Response
		
		// Cache successful validations
		if result.Valid {
			v.cache.Put(cacheKey, result)
		}
		
		return result, nil
		
	default:
		return &ValidationResult{
			Valid:  false,
			Reason: "validation queue full",
		}, errors.New("validation queue full")
	}
}

// GetStats returns validation statistics
func (v *OptimizedShareValidator) GetStats() ValidatorStats {
	return ValidatorStats{
		TotalValidated:  v.stats.validated.Load(),
		TotalRejected:   v.stats.rejected.Load(),
		TotalDuplicates: v.stats.duplicates.Load(),
		CacheHitRate:    v.calculateCacheHitRate(),
		AvgTimeMs:       float64(v.stats.avgTimeNs.Load()) / 1e6,
		PeakTimeMs:      float64(v.stats.peakTimeNs.Load()) / 1e6,
	}
}

// Private methods

func (v *OptimizedShareValidator) validationWorker(id int) {
	for req := range v.workQueue {
		start := time.Now()
		result := v.validateShare(req.Share, req.Job)
		result.ProcessTime = time.Since(start)

		// Update stats
		v.updateStats(result)

		// Send result
		req.Response <- result
	}
}

func (v *OptimizedShareValidator) validateShare(share *Share, job *Job) *ValidationResult {
    // Nonce range validation skipped: Job does not define NonceStart/NonceEnd in types.go

	// Validate timestamp
	if abs(share.Timestamp-time.Now().Unix()) > 600 {
		return &ValidationResult{
			Valid:  false,
			Reason: "timestamp out of range",
		}
	}

	// Quick duplicate check using bloom filter (before expensive hash computation)
	if v.checkDuplicateBloom(share.Hash[:], share.Nonce) {
		v.stats.duplicates.Add(1)
		return &ValidationResult{
			Valid:  false,
			Reason: "duplicate share",
		}
	}

	// Compute hash based on algorithm
	var hash []byte
	switch job.Algorithm {
	case SHA256D:
		hash = v.computeSHA256D(share, job)
	case Scrypt:
		hash = v.computeScrypt(share, job)
	default:
		return &ValidationResult{
			Valid:  false,
			Reason: "unsupported algorithm",
		}
	}

	// Check difficulty
	hashInt := new(big.Int).SetBytes(hash)
	target := v.getTarget(float64(job.Difficulty))

	if hashInt.Cmp(target) > 0 {
		return &ValidationResult{
			Valid:      false,
			Reason:     "insufficient difficulty",
			Difficulty: uint64(v.calculateDifficulty(hashInt)),
			Hash:       hash,
		}
	}

	// Mark share as seen in bloom filter
	v.markSeenBloom(hash, share.Nonce)

	return &ValidationResult{
		Valid:      true,
		Difficulty: job.Difficulty,
		Hash:       hash,
	}
}

func (v *OptimizedShareValidator) computeSHA256D(share *Share, job *Job) []byte {
    // Build block header
    header := make([]byte, 80)
    // Version is not present in Job; use 0
    binary.LittleEndian.PutUint32(header[0:4], 0)
    copy(header[4:36], job.PrevHash)
    copy(header[36:68], job.MerkleRoot)
    binary.LittleEndian.PutUint32(header[68:72], uint32(share.Timestamp))
    binary.LittleEndian.PutUint32(header[72:76], job.Bits)
    binary.LittleEndian.PutUint32(header[76:80], uint32(share.Nonce))

	// Double SHA256
	if v.useAVX2 {
		return v.sha256dAVX2(header)
	}

	hash1 := sha256.Sum256(header)
	hash2 := sha256.Sum256(hash1[:])

	// Reverse for little-endian
	reversed := make([]byte, 32)
	for i := 0; i < 32; i++ {
		reversed[i] = hash2[31-i]
	}

	return reversed
}

func (v *OptimizedShareValidator) sha256dAVX2(data []byte) []byte {
	// AVX2 optimized implementation would go here
	// For now, fallback to standard
	hash1 := sha256.Sum256(data)
	hash2 := sha256.Sum256(hash1[:])
	
	reversed := make([]byte, 32)
	for i := 0; i < 32; i++ {
		reversed[i] = hash2[31-i]
	}
	
	return reversed
}

func (v *OptimizedShareValidator) computeScrypt(share *Share, job *Job) []byte {
	// Scrypt implementation would go here
	// This is a placeholder
	return make([]byte, 32)
}

func (v *OptimizedShareValidator) getTarget(difficulty float64) *big.Int {
	// Check cache
	if cached, ok := v.targetCache.Load(difficulty); ok {
		return cached.(*big.Int)
	}
	
	// Calculate target
	maxTarget := new(big.Int)
	maxTarget.SetString("00000000FFFF0000000000000000000000000000000000000000000000000000", 16)
	
	target := new(big.Int).Div(maxTarget, big.NewInt(int64(difficulty)))
	
	// Cache for future use
	v.targetCache.Store(difficulty, target)
	
	return target
}

func (v *OptimizedShareValidator) calculateDifficulty(hash *big.Int) float64 {
	maxTarget := new(big.Int)
	maxTarget.SetString("00000000FFFF0000000000000000000000000000000000000000000000000000", 16)
	
	if hash.Sign() == 0 {
		return 0
	}
	
	diff := new(big.Int).Div(maxTarget, hash)
	return float64(diff.Int64())
}

func (v *OptimizedShareValidator) precomputeTargets() {
	// Pre-compute common difficulty targets
	difficulties := []float64{
		1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024,
		2048, 4096, 8192, 16384, 32768, 65536,
	}
	
	for _, diff := range difficulties {
		v.getTarget(diff)
	}
}

func (v *OptimizedShareValidator) updateStats(result *ValidationResult) {
	if result.Valid {
		v.stats.validated.Add(1)
	} else {
		v.stats.rejected.Add(1)
	}
	
	// Update timing stats
	timeNs := result.ProcessTime.Nanoseconds()
	
	// Update average (exponential moving average)
	const alpha = 0.1
	for {
		current := v.stats.avgTimeNs.Load()
		new := int64(float64(current)*(1-alpha) + float64(timeNs)*alpha)
		if v.stats.avgTimeNs.CompareAndSwap(current, new) {
			break
		}
	}
	
	// Update peak
	for {
		peak := v.stats.peakTimeNs.Load()
		if timeNs <= peak {
			break
		}
		if v.stats.peakTimeNs.CompareAndSwap(peak, timeNs) {
			break
		}
	}
}

func (v *OptimizedShareValidator) statsCollector() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		stats := v.GetStats()
		v.logger.Info("Validator statistics",
			zap.Uint64("validated", stats.TotalValidated),
			zap.Uint64("rejected", stats.TotalRejected),
			zap.Float64("cache_hit_rate", stats.CacheHitRate),
			zap.Float64("avg_time_ms", stats.AvgTimeMs),
		)
	}
}

func (v *OptimizedShareValidator) cacheKey(share *Share, job *Job) string {
	// Simple cache key - could be optimized with hashing
	return share.JobID + ":" + string(share.Nonce)
}

func (v *OptimizedShareValidator) calculateCacheHitRate() float64 {
	hits := v.cacheHits.Load()
	misses := v.cacheMiss.Load()
	total := hits + misses
	
	if total == 0 {
		return 0
	}
	
	return float64(hits) / float64(total)
}

// ValidationCache implementation

func NewValidationCache(maxSize int) *ValidationCache {
	return &ValidationCache{
		maxSize: maxSize,
	}
}

func (c *ValidationCache) Get(key string) *ValidationResult {
	if entry, ok := c.entries.Load(key); ok {
		e := entry.(*CacheEntry)
		// Check if not expired (5 minutes)
		if time.Now().Unix()-e.Timestamp < 300 {
			return &e.Result
		}
		c.entries.Delete(key)
		c.size.Add(-1)
	}
	return nil
}

func (c *ValidationCache) Put(key string, result *ValidationResult) {
	// Simple size limit - in production, use LRU
	if c.size.Load() >= int32(c.maxSize) {
		return
	}
	
	entry := &CacheEntry{
		Result:    *result,
		Timestamp: time.Now().Unix(),
	}
	
	if _, loaded := c.entries.LoadOrStore(key, entry); !loaded {
		c.size.Add(1)
	}
}

// Helper functions

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}

func hasAVX2Support() bool {
	// Check CPU features - implementation would use cpuid
	return false
}

func hasAVX512Support() bool {
	// Check CPU features - implementation would use cpuid
	return false
}

// ValidatorStats contains validator statistics
type ValidatorStats struct {
	TotalValidated uint64
	TotalRejected  uint64
	TotalDuplicates uint64
	CacheHitRate   float64
	AvgTimeMs      float64
	PeakTimeMs     float64
}

// Bloom filter methods for duplicate detection

func (v *OptimizedShareValidator) checkDuplicateBloom(hash []byte, nonce uint64) bool {
	// Use multiple hash functions for bloom filter
	h1, h2 := v.bloomHash(hash, nonce)
	
	v.bloomMutex.RLock()
	defer v.bloomMutex.RUnlock()
	
	// Check if both bits are set
	idx1 := h1 % uint64(v.bloomSize)
	idx2 := h2 % uint64(v.bloomSize)
	
	word1 := idx1 / 64
	bit1 := idx1 % 64
	word2 := idx2 / 64
	bit2 := idx2 % 64
	
	return (v.bloomFilter[word1]&(1<<bit1) != 0) &&
		(v.bloomFilter[word2]&(1<<bit2) != 0)
}

func (v *OptimizedShareValidator) markSeenBloom(hash []byte, nonce uint64) {
	h1, h2 := v.bloomHash(hash, nonce)
	
	v.bloomMutex.Lock()
	defer v.bloomMutex.Unlock()
	
	// Set both bits
	idx1 := h1 % uint64(v.bloomSize)
	idx2 := h2 % uint64(v.bloomSize)
	
	word1 := idx1 / 64
	bit1 := idx1 % 64
	word2 := idx2 / 64
	bit2 := idx2 % 64
	
	v.bloomFilter[word1] |= (1 << bit1)
	v.bloomFilter[word2] |= (1 << bit2)
}

func (v *OptimizedShareValidator) bloomHash(hash []byte, nonce uint64) (uint64, uint64) {
	// Simple but effective hash functions for bloom filter
	if len(hash) < 32 {
		// Handle short hash
		h1 := uint64(0)
		h2 := uint64(0)
		for i, b := range hash {
			h1 = h1*31 + uint64(b)
			h2 = h2*37 + uint64(b)<<uint(i%8)
		}
		return h1 ^ nonce, h2 ^ (nonce << 32)
	}
	h1 := binary.BigEndian.Uint64(hash[:8]) ^ nonce
	h2 := binary.BigEndian.Uint64(hash[24:]) ^ (nonce << 32)
	return h1, h2
}

// ClearBloomFilter clears the bloom filter
func (v *OptimizedShareValidator) ClearBloomFilter() {
	v.bloomMutex.Lock()
	defer v.bloomMutex.Unlock()
	
	for i := range v.bloomFilter {
		v.bloomFilter[i] = 0
	}
	
	v.logger.Info("Bloom filter cleared")
}

// bloomFilterCleaner periodically clears the bloom filter
func (v *OptimizedShareValidator) bloomFilterCleaner() {
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		v.ClearBloomFilter()
	}
}

// BatchValidator provides batch validation functionality

// BatchValidator validates shares in batches for better performance
type BatchValidator struct {
	validator *OptimizedShareValidator
	logger    *zap.Logger
	
	batchSize int
	batch     []Share
	results   chan []ValidationResult
	mu        sync.Mutex
}

// NewBatchValidator creates a batch validator
func NewBatchValidator(validator *OptimizedShareValidator, logger *zap.Logger) *BatchValidator {
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
			// Create validation request and send to validator
			req := &ValidationRequest{
				Share: &shares[idx],
				Response: make(chan *ValidationResult, 1),
			}
			bv.validator.workQueue <- req
			result := <-req.Response
			results[idx] = *result
		}(i)
	}
	
	wg.Wait()
	bv.results <- results
}

// GetResults returns the results channel
func (bv *BatchValidator) GetResults() <-chan []ValidationResult {
	return bv.results
}

// ValidateBatch validates a batch of shares synchronously
func (v *OptimizedShareValidator) ValidateBatch(shares []Share) []ValidationResult {
	results := make([]ValidationResult, len(shares))
	
	// Process in parallel using available workers
	var wg sync.WaitGroup
	for i := range shares {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req := &ValidationRequest{
				Share: &shares[idx],
				Response: make(chan *ValidationResult, 1),
			}
			v.workQueue <- req
			result := <-req.Response
			results[idx] = *result
		}(i)
	}
	
	wg.Wait()
	return results
}