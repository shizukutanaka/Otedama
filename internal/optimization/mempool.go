package optimization

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MemoryPool provides efficient memory pooling for frequently allocated objects
type MemoryPool struct {
	logger    *zap.Logger
	pools     map[string]*ObjectPool
	stats     *MemPoolStats
	mu        sync.RWMutex
}

// ObjectPool manages a pool of reusable objects
type ObjectPool struct {
	pool      sync.Pool
	allocFunc func() interface{}
	resetFunc func(interface{})
	stats     *PoolStats
}

// PoolStats tracks statistics for an object pool
type PoolStats struct {
	Allocations   atomic.Uint64
	Deallocations atomic.Uint64
	InUse         atomic.Int64
	PeakUsage     atomic.Int64
	TotalSize     atomic.Uint64
}

// MemPoolStats tracks overall memory pool statistics
type MemPoolStats struct {
	TotalAllocations   atomic.Uint64
	TotalDeallocations atomic.Uint64
	ActivePools        atomic.Int32
	LastGC             time.Time
	mu                 sync.RWMutex
}

// Common buffer sizes for mining operations
var commonBufferSizes = []int{
	32,     // Small hash outputs
	64,     // SHA-512 outputs
	256,    // Small messages
	1024,   // 1KB - Stratum messages
	4096,   // 4KB - Medium data
	8192,   // 8KB - Large messages
	16384,  // 16KB - Block headers
	65536,  // 64KB - Transaction data
	262144, // 256KB - Large blocks
}

// NewMemoryPool creates a new memory pool manager
func NewMemoryPool(logger *zap.Logger) *MemoryPool {
	mp := &MemoryPool{
		logger: logger,
		pools:  make(map[string]*ObjectPool),
		stats:  &MemPoolStats{},
	}

	// Initialize common pools
	mp.initializeCommonPools()

	// Start periodic cleanup
	go mp.periodicCleanup()

	return mp
}

// initializeCommonPools sets up pools for commonly used objects
func (mp *MemoryPool) initializeCommonPools() {
	// Hash result pool (32 bytes)
	mp.RegisterPool("hash32", func() interface{} {
		return make([]byte, 32)
	}, func(obj interface{}) {
		// Clear the buffer
		b := obj.([]byte)
		for i := range b {
			b[i] = 0
		}
	})

	// Block header pool
	mp.RegisterPool("blockheader", func() interface{} {
		return &BlockHeader{}
	}, func(obj interface{}) {
		h := obj.(*BlockHeader)
		h.Reset()
	})

	// Mining job pool
	mp.RegisterPool("miningjob", func() interface{} {
		return &MiningJob{}
	}, func(obj interface{}) {
		j := obj.(*MiningJob)
		j.Reset()
	})

	// Share submission pool
	mp.RegisterPool("share", func() interface{} {
		return &Share{}
	}, func(obj interface{}) {
		s := obj.(*Share)
		s.Reset()
	})
}

// RegisterPool registers a new object pool
func (mp *MemoryPool) RegisterPool(name string, allocFunc func() interface{}, resetFunc func(interface{})) {
	mp.mu.Lock()
	defer mp.mu.Unlock()

	if _, exists := mp.pools[name]; exists {
		mp.logger.Warn("Pool already exists", zap.String("name", name))
		return
	}

	pool := &ObjectPool{
		allocFunc: allocFunc,
		resetFunc: resetFunc,
		stats:     &PoolStats{},
	}

	pool.pool = sync.Pool{
		New: func() interface{} {
			pool.stats.Allocations.Add(1)
			mp.stats.TotalAllocations.Add(1)
			return allocFunc()
		},
	}

	mp.pools[name] = pool
	mp.stats.ActivePools.Add(1)

	mp.logger.Info("Registered memory pool", zap.String("name", name))
}

// Get retrieves an object from the pool
func (mp *MemoryPool) Get(poolName string) interface{} {
	mp.mu.RLock()
	pool, exists := mp.pools[poolName]
	mp.mu.RUnlock()

	if !exists {
		mp.logger.Error("Pool not found", zap.String("name", poolName))
		return nil
	}

	obj := pool.pool.Get()
	pool.stats.InUse.Add(1)

	// Track peak usage
	current := pool.stats.InUse.Load()
	for {
		peak := pool.stats.PeakUsage.Load()
		if current <= peak || pool.stats.PeakUsage.CompareAndSwap(peak, current) {
			break
		}
	}

	return obj
}

// Put returns an object to the pool
func (mp *MemoryPool) Put(poolName string, obj interface{}) {
	mp.mu.RLock()
	pool, exists := mp.pools[poolName]
	mp.mu.RUnlock()

	if !exists {
		mp.logger.Error("Pool not found", zap.String("name", poolName))
		return
	}

	// Reset the object before returning to pool
	if pool.resetFunc != nil {
		pool.resetFunc(obj)
	}

	pool.pool.Put(obj)
	pool.stats.InUse.Add(-1)
	pool.stats.Deallocations.Add(1)
	mp.stats.TotalDeallocations.Add(1)
}

// GetStats returns pool statistics
func (mp *MemoryPool) GetStats() map[string]interface{} {
	mp.mu.RLock()
	defer mp.mu.RUnlock()

	stats := make(map[string]interface{})
	stats["total_allocations"] = mp.stats.TotalAllocations.Load()
	stats["total_deallocations"] = mp.stats.TotalDeallocations.Load()
	stats["active_pools"] = mp.stats.ActivePools.Load()

	poolStats := make(map[string]interface{})
	for name, pool := range mp.pools {
		poolStats[name] = map[string]interface{}{
			"allocations":   pool.stats.Allocations.Load(),
			"deallocations": pool.stats.Deallocations.Load(),
			"in_use":        pool.stats.InUse.Load(),
			"peak_usage":    pool.stats.PeakUsage.Load(),
		}
	}
	stats["pools"] = poolStats

	// Memory stats
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	stats["memory"] = map[string]interface{}{
		"alloc":      m.Alloc,
		"total_alloc": m.TotalAlloc,
		"sys":        m.Sys,
		"num_gc":     m.NumGC,
	}

	return stats
}

// periodicCleanup runs periodic garbage collection and cleanup
func (mp *MemoryPool) periodicCleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		mp.stats.mu.Lock()
		mp.stats.LastGC = time.Now()
		mp.stats.mu.Unlock()

		// Force GC to return memory to OS
		runtime.GC()
		runtime.GC() // Run twice for better cleanup

		mp.logger.Debug("Memory pool cleanup completed",
			zap.Uint64("total_allocs", mp.stats.TotalAllocations.Load()),
			zap.Uint64("total_deallocs", mp.stats.TotalDeallocations.Load()))
	}
}


// Common objects for pooling

// BlockHeader represents a block header
type BlockHeader struct {
	Version    uint32
	PrevBlock  [32]byte
	MerkleRoot [32]byte
	Timestamp  uint32
	Bits       uint32
	Nonce      uint32
}

// Reset clears the block header
func (h *BlockHeader) Reset() {
	h.Version = 0
	h.PrevBlock = [32]byte{}
	h.MerkleRoot = [32]byte{}
	h.Timestamp = 0
	h.Bits = 0
	h.Nonce = 0
}

// MiningJob represents a mining job
type MiningJob struct {
	ID         string
	Height     uint64
	Target     [32]byte
	ExtraNonce uint32
	Timestamp  time.Time
}

// Reset clears the mining job
func (j *MiningJob) Reset() {
	j.ID = ""
	j.Height = 0
	j.Target = [32]byte{}
	j.ExtraNonce = 0
	j.Timestamp = time.Time{}
}

// Share represents a mining share
type Share struct {
	WorkerID   string
	JobID      string
	Nonce      uint64
	Hash       [32]byte
	Difficulty float64
	Timestamp  time.Time
}

// Reset clears the share
func (s *Share) Reset() {
	s.WorkerID = ""
	s.JobID = ""
	s.Nonce = 0
	s.Hash = [32]byte{}
	s.Difficulty = 0
	s.Timestamp = time.Time{}
}

