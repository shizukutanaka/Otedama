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
	
	// Performance stats
	stats struct {
		validated     atomic.Uint64
		rejected      atomic.Uint64
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

// ValidationResult contains validation outcome
type ValidationResult struct {
	Valid       bool
	Reason      string
	Difficulty  float64
	Hash        []byte
	ProcessTime time.Duration
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
		logger:      logger,
		workers:     workers,
		workQueue:   make(chan *ValidationRequest, workers*100),
		resultChan:  make(chan *ValidationResult, workers*10),
		cache:       NewValidationCache(10000),
		useAVX2:     hasAVX2Support(),
		useAVX512:   hasAVX512Support(),
	}
	
	// Pre-compute common difficulty targets
	v.precomputeTargets()
	
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
		TotalValidated: v.stats.validated.Load(),
		TotalRejected:  v.stats.rejected.Load(),
		CacheHitRate:   v.calculateCacheHitRate(),
		AvgTimeMs:      float64(v.stats.avgTimeNs.Load()) / 1e6,
		PeakTimeMs:     float64(v.stats.peakTimeNs.Load()) / 1e6,
	}
}

// Private methods

func (v *OptimizedShareValidator) validationWorker(id int) {
	for req := range v.workQueue {
		start := time.Now()
		result := v.performValidation(req.Share, req.Job)
		result.ProcessTime = time.Since(start)
		
		// Update stats
		v.updateStats(result)
		
		// Send result
		req.Response <- result
	}
}

func (v *OptimizedShareValidator) performValidation(share *Share, job *Job) *ValidationResult {
	// Validate nonce range
	if share.Nonce < job.NonceStart || share.Nonce > job.NonceEnd {
		return &ValidationResult{
			Valid:  false,
			Reason: "nonce out of range",
		}
	}
	
	// Validate timestamp
	if abs(int64(share.Timestamp)-time.Now().Unix()) > 600 {
		return &ValidationResult{
			Valid:  false,
			Reason: "timestamp out of range",
		}
	}
	
	// Compute hash based on algorithm
	var hash []byte
	switch job.Algorithm {
	case AlgorithmSHA256D:
		hash = v.computeSHA256D(share, job)
	case AlgorithmScrypt:
		hash = v.computeScrypt(share, job)
	default:
		return &ValidationResult{
			Valid:  false,
			Reason: "unsupported algorithm",
		}
	}
	
	// Check difficulty
	hashInt := new(big.Int).SetBytes(hash)
	target := v.getTarget(job.Difficulty)
	
	if hashInt.Cmp(target) > 0 {
		return &ValidationResult{
			Valid:      false,
			Reason:     "insufficient difficulty",
			Difficulty: v.calculateDifficulty(hashInt),
			Hash:       hash,
		}
	}
	
	return &ValidationResult{
		Valid:      true,
		Difficulty: job.Difficulty,
		Hash:       hash,
	}
}

func (v *OptimizedShareValidator) computeSHA256D(share *Share, job *Job) []byte {
	// Build block header
	header := make([]byte, 80)
	binary.LittleEndian.PutUint32(header[0:4], job.Version)
	copy(header[4:36], job.PrevHash)
	copy(header[36:68], job.MerkleRoot)
	binary.LittleEndian.PutUint32(header[68:72], share.Timestamp)
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
	CacheHitRate   float64
	AvgTimeMs      float64
	PeakTimeMs     float64
}