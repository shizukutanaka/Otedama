package mining

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/shizukutanaka/Otedama/internal/crypto"
	"go.uber.org/zap"
)

// HardwareAcceleratedMiner uses CPU features for optimized mining
// John Carmack's performance-first approach - optimized memory pools
type HardwareAcceleratedMiner struct {
	logger        *zap.Logger
	sha256        *crypto.SHA256Optimized
	simdHasher    *crypto.SIMDHasher
	
	// Performance metrics (cache-aligned for hot path)
	hashCount     atomic.Uint64
	bestDiff      atomic.Uint64
	
	// Worker management
	workers       int
	workerWG      sync.WaitGroup
	
	// Memory optimization - lock-free pools
	blockCache    *BlockCache
	nonceRanges   []NonceRange
	headerPool    *HeaderPool
	resultPool    *ResultPool
}

// BlockCache stores precomputed block data
type BlockCache struct {
	header    [80]byte
	midstate  [32]byte
	target    [32]byte
	mu        sync.RWMutex
}

// NonceRange defines work range for a worker
type NonceRange struct {
	start uint32
	end   uint32
}

// HeaderPool manages reusable header arrays for memory efficiency
type HeaderPool struct {
	pool sync.Pool
}

// ResultPool manages reusable result arrays
type ResultPool struct {
	pool sync.Pool
}

// NewHeaderPool creates optimized header pool
func NewHeaderPool() *HeaderPool {
	return &HeaderPool{
		pool: sync.Pool{
			New: func() interface{} {
				// Pre-allocate batch size for optimal cache usage
				return make([][80]byte, 256)
			},
		},
	}
}

// NewResultPool creates optimized result pool
func NewResultPool() *ResultPool {
	return &ResultPool{
		pool: sync.Pool{
			New: func() interface{} {
				return make([][32]byte, 256)
			},
		},
	}
}

// Get retrieves headers from pool
func (hp *HeaderPool) Get() [][80]byte {
	return hp.pool.Get().([][80]byte)
}

// Put returns headers to pool
func (hp *HeaderPool) Put(headers [][80]byte) {
	// Clear before returning to pool for security
	for i := range headers {
		for j := range headers[i] {
			headers[i][j] = 0
		}
	}
	hp.pool.Put(headers)
}

// Get retrieves results from pool
func (rp *ResultPool) Get() [][32]byte {
	return rp.pool.Get().([][32]byte)
}

// Put returns results to pool
func (rp *ResultPool) Put(results [][32]byte) {
	// Clear before returning to pool for security
	for i := range results {
		for j := range results[i] {
			results[i][j] = 0
		}
	}
	rp.pool.Put(results)
}

// NewHardwareAcceleratedMiner creates an optimized miner with memory pools
func NewHardwareAcceleratedMiner(logger *zap.Logger, workers int) *HardwareAcceleratedMiner {
	if workers <= 0 {
		workers = runtime.NumCPU()
	}
	
	return &HardwareAcceleratedMiner{
		logger:      logger,
		sha256:      crypto.NewSHA256Optimized(),
		simdHasher:  crypto.NewSIMDHasher("sha256d"),
		workers:     workers,
		blockCache:  &BlockCache{},
		nonceRanges: distributeNonceRanges(workers),
		headerPool:  NewHeaderPool(),
		resultPool:  NewResultPool(),
	}
}

// Mine performs hardware-accelerated mining
func (m *HardwareAcceleratedMiner) Mine(ctx context.Context, job *Job) (*Share, error) {
	// Prepare block header
	m.prepareBlockHeader(job)
	
	// Reset metrics
	m.hashCount.Store(0)
	m.bestDiff.Store(0)
	
	// Create result channel
	resultChan := make(chan *Share, m.workers)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	
	// Launch workers
	for i := 0; i < m.workers; i++ {
		m.workerWG.Add(1)
		go m.mineWorker(ctx, i, job, resultChan)
	}
	
	// Wait for result or cancellation
	select {
	case share := <-resultChan:
		cancel() // Stop other workers
		m.workerWG.Wait()
		return share, nil
	case <-ctx.Done():
		m.workerWG.Wait()
		return nil, ctx.Err()
	}
}

// mineWorker performs mining for a specific nonce range
func (m *HardwareAcceleratedMiner) mineWorker(ctx context.Context, workerID int, job *Job, resultChan chan<- *Share) {
	defer m.workerWG.Done()
	
	// Get nonce range for this worker
	nonceRange := m.nonceRanges[workerID]
	
	// Local copy of header for this worker
	var header [80]byte
	m.blockCache.mu.RLock()
	copy(header[:], m.blockCache.header[:])
	target := m.blockCache.target
	m.blockCache.mu.RUnlock()
	
	// Optimize for CPU cache - use memory pool to reduce GC pressure
	const batchSize = 256
	headers := m.headerPool.Get()[:batchSize]
	defer m.headerPool.Put(headers)
	
	for nonce := nonceRange.start; nonce < nonceRange.end; nonce += batchSize {
		// Check for cancellation
		select {
		case <-ctx.Done():
			return
		default:
		}
		
		// Prepare batch
		batchEnd := nonce + batchSize
		if batchEnd > nonceRange.end {
			batchEnd = nonceRange.end
		}
		
		// Fill headers with different nonces
		for i := uint32(0); i < batchEnd-nonce; i++ {
			copy(headers[i][:], header[:])
			putUint32LE(headers[i][76:80], nonce+i)
		}
		
		// Process batch with SIMD using memory pool
		batchCount := int(batchEnd - nonce)
		results := m.resultPool.Get()[:batchCount]
		m.processBatchOptimized(headers[:batchCount], results)
		
		// Check results
		for i, hash := range results[:batchCount] {
			m.hashCount.Add(1)
			
			if isValidHash(hash[:], target[:]) {
				share := &Share{
					JobID:    job.ID,
					WorkerID: string(rune('A' + workerID)),
					Nonce:    uint64(nonce + uint32(i)),
					Hash:     hash,
				}
				
				select {
				case resultChan <- share:
				case <-ctx.Done():
				}
				m.resultPool.Put(results)
				return
			}
		}
		
		// Return results buffer to pool after processing batch
		m.resultPool.Put(results)
	}
}

// processBatchOptimized processes multiple headers in parallel with memory pools
func (m *HardwareAcceleratedMiner) processBatchOptimized(headers [][80]byte, results [][32]byte) {
	count := len(headers)
	if len(results) < count {
		panic("results buffer too small")
	}
	
	// Use SIMD for parallel processing if available
	if count >= 4 {
		// Process in groups of 4 for SIMD efficiency
		for i := 0; i < count-3; i += 4 {
			// Simulated SIMD processing
			for j := 0; j < 4; j++ {
				results[i+j] = m.sha256.HashDouble(headers[i+j][:])
			}
		}
		
		// Process remaining
		for i := (count / 4) * 4; i < count; i++ {
			results[i] = m.sha256.HashDouble(headers[i][:])
		}
	} else {
		// Sequential processing for small batches
		for i := 0; i < count; i++ {
			results[i] = m.sha256.HashDouble(headers[i][:])
		}
	}
}

// prepareBlockHeader prepares and caches block header
func (m *HardwareAcceleratedMiner) prepareBlockHeader(job *Job) {
	m.blockCache.mu.Lock()
	defer m.blockCache.mu.Unlock()
	
	// Build 80-byte block header
	header := &m.blockCache.header
	
	// Version (4 bytes)
	putUint32LE(header[0:4], 0x20000000) // Version 536870912
	
	// Previous block hash (32 bytes)
	copy(header[4:36], job.PrevHash[:])
	
	// Merkle root (32 bytes)
	copy(header[36:68], job.MerkleRoot[:])
	
	// Timestamp (4 bytes)
	putUint32LE(header[68:72], job.Timestamp)
	
	// Bits (4 bytes)
	putUint32LE(header[72:76], job.Bits)
	
	// Nonce placeholder (4 bytes) - will be filled by workers
	putUint32LE(header[76:80], 0)
	
	// Compute midstate for first 64 bytes
	m.blockCache.midstate = m.sha256.Hash(header[:64])
	
	// Calculate target from bits
	m.blockCache.target = bitsToTarget(job.Bits)
}

// GetHashRate returns current hash rate
func (m *HardwareAcceleratedMiner) GetHashRate() float64 {
	return float64(m.hashCount.Load())
}

// Utility functions

// distributeNonceRanges divides nonce space among workers
func distributeNonceRanges(workers int) []NonceRange {
	ranges := make([]NonceRange, workers)
	rangeSize := uint32(0xFFFFFFFF) / uint32(workers)
	
	for i := 0; i < workers; i++ {
		ranges[i] = NonceRange{
			start: uint32(i) * rangeSize,
			end:   uint32(i+1) * rangeSize,
		}
	}
	
	// Adjust last range to cover full space
	ranges[workers-1].end = 0xFFFFFFFF
	
	return ranges
}

// isValidHash checks if hash meets target difficulty
func isValidHash(hash, target []byte) bool {
	for i := 0; i < 32; i++ {
		if hash[i] < target[i] {
			return true
		}
		if hash[i] > target[i] {
			return false
		}
	}
	return true
}

// bitsToTarget converts compact bits to 256-bit target
func bitsToTarget(bits uint32) [32]byte {
	var target [32]byte
	
	// Extract exponent and mantissa
	exp := bits >> 24
	mant := bits & 0x00FFFFFF
	
	// Calculate target value
	if exp <= 3 {
		mant >>= 8 * (3 - exp)
		putUint32BE(target[28:], mant)
	} else {
		offset := exp - 3
		if offset < 29 {
			putUint32BE(target[32-offset-4:], mant)
		}
	}
	
	return target
}

// putUint32LE writes uint32 in little-endian
func putUint32LE(b []byte, v uint32) {
	b[0] = byte(v)
	b[1] = byte(v >> 8)
	b[2] = byte(v >> 16)
	b[3] = byte(v >> 24)
}

// putUint32BE writes uint32 in big-endian
func putUint32BE(b []byte, v uint32) {
	b[0] = byte(v >> 24)
	b[1] = byte(v >> 16)
	b[2] = byte(v >> 8)
	b[3] = byte(v)
}

// OptimizeForCPU configures miner for specific CPU
func (m *HardwareAcceleratedMiner) OptimizeForCPU() {
	// Set CPU affinity for workers
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	
	// Prefetch block data
	if m.blockCache != nil {
		prefetchData(unsafe.Pointer(&m.blockCache.header[0]))
	}
}

// prefetchData hints CPU to prefetch data
func prefetchData(p unsafe.Pointer) {
	// Platform-specific prefetch
	// In production, use assembly or compiler intrinsics
}