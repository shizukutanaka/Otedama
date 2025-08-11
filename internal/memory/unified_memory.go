package memory

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// UnifiedMemoryManager provides centralized memory management for the entire application
// Implements John Carmack's cache-aware design with zero-allocation patterns
type UnifiedMemoryManager struct {
	// Global memory pool
	pool *OptimizedMemoryPool
	
	// Specialized pools for different subsystems
	miningPool  *SubsystemPool
	networkPool *SubsystemPool
	storagePool *SubsystemPool
	
	// Global statistics
	stats MemoryStatistics
	
	// Configuration
	config MemoryConfig
	
	// Lifecycle
	shutdown chan struct{}
	wg       sync.WaitGroup
}

// MemoryConfig defines memory management configuration
type MemoryConfig struct {
	MaxMemory          int64         // Maximum memory usage in bytes
	GCInterval         time.Duration // Garbage collection interval
	EnableNUMA         bool          // Enable NUMA optimizations
	EnableHugepages    bool          // Enable hugepages support
	CompactionInterval time.Duration // Memory compaction interval
	MetricsEnabled     bool          // Enable detailed metrics
}

// MemoryStatistics tracks global memory statistics
type MemoryStatistics struct {
	TotalAllocated   atomic.Int64
	TotalFreed       atomic.Int64
	CurrentUsage     atomic.Int64
	PeakUsage        atomic.Int64
	Allocations      atomic.Uint64
	Deallocations    atomic.Uint64
	GCRuns           atomic.Uint32
	CompactionRuns   atomic.Uint32
	LastGC           atomic.Int64
	LastCompaction   atomic.Int64
}

// SubsystemPool provides memory management for a specific subsystem
type SubsystemPool struct {
	name      string
	parent    *UnifiedMemoryManager
	dedicated sync.Pool
	stats     SubsystemStats
	mu        sync.RWMutex
}

// SubsystemStats tracks per-subsystem memory statistics
type SubsystemStats struct {
	Allocated     atomic.Int64
	Freed         atomic.Int64
	CurrentUsage  atomic.Int64
	PeakUsage     atomic.Int64
	HitRate       atomic.Uint64
	LastAccess    atomic.Int64
}

// DefaultMemoryConfig returns default memory configuration
func DefaultMemoryConfig() MemoryConfig {
	return MemoryConfig{
		MaxMemory:          4 * 1024 * 1024 * 1024, // 4GB
		GCInterval:         30 * time.Second,
		EnableNUMA:         runtime.GOOS == "linux",
		EnableHugepages:    false,
		CompactionInterval: 5 * time.Minute,
		MetricsEnabled:     true,
	}
}

// NewUnifiedMemoryManager creates a new unified memory manager
func NewUnifiedMemoryManager(config MemoryConfig) *UnifiedMemoryManager {
	mm := &UnifiedMemoryManager{
		pool:     NewOptimizedMemoryPool(),
		config:   config,
		shutdown: make(chan struct{}),
	}
	
	// Initialize subsystem pools
	mm.miningPool = mm.newSubsystemPool("mining")
	mm.networkPool = mm.newSubsystemPool("network")
	mm.storagePool = mm.newSubsystemPool("storage")
	
	// Start maintenance routines
	if config.MetricsEnabled {
		mm.wg.Add(1)
		go mm.metricsCollector()
	}
	
	mm.wg.Add(1)
	go mm.gcRoutine()
	
	if config.CompactionInterval > 0 {
		mm.wg.Add(1)
		go mm.compactionRoutine()
	}
	
	return mm
}

// newSubsystemPool creates a new subsystem-specific pool
func (mm *UnifiedMemoryManager) newSubsystemPool(name string) *SubsystemPool {
	return &SubsystemPool{
		name:   name,
		parent: mm,
		dedicated: sync.Pool{
			New: func() interface{} {
				// Use parent pool for actual allocation
				return nil
			},
		},
	}
}

// Allocate allocates memory with specified options
func (mm *UnifiedMemoryManager) Allocate(size int, options ...AllocOption) []byte {
	opts := &allocOptions{
		alignment: 1,
		zeroed:    false,
		subsystem: "general",
	}
	
	for _, opt := range options {
		opt(opts)
	}
	
	// Check memory limit
	current := mm.stats.CurrentUsage.Load()
	if current+int64(size) > mm.config.MaxMemory {
		// Trigger GC and retry
		runtime.GC()
		mm.stats.GCRuns.Add(1)
		
		current = mm.stats.CurrentUsage.Load()
		if current+int64(size) > mm.config.MaxMemory {
			return nil // Out of memory
		}
	}
	
	// Allocate from pool
	var buf []byte
	if opts.alignment > 1 {
		buf = mm.pool.GetAligned(size, opts.alignment)
	} else {
		buf = mm.pool.Get(size)
	}
	
	// Update statistics
	mm.stats.TotalAllocated.Add(int64(size))
	mm.stats.CurrentUsage.Add(int64(size))
	mm.stats.Allocations.Add(1)
	
	// Update peak usage
	for {
		peak := mm.stats.PeakUsage.Load()
		current := mm.stats.CurrentUsage.Load()
		if current <= peak || mm.stats.PeakUsage.CompareAndSwap(peak, current) {
			break
		}
	}
	
	// Clear if requested
	if opts.zeroed && buf != nil {
		clear(buf)
	}
	
	return buf
}

// Free returns memory to the pool
func (mm *UnifiedMemoryManager) Free(buf []byte) {
	if buf == nil || len(buf) == 0 {
		return
	}
	
	size := cap(buf)
	
	// Return to pool
	mm.pool.Put(buf)
	
	// Update statistics
	mm.stats.TotalFreed.Add(int64(size))
	mm.stats.CurrentUsage.Add(-int64(size))
	mm.stats.Deallocations.Add(1)
}

// AllocateForMining allocates memory optimized for mining operations
func (mm *UnifiedMemoryManager) AllocateForMining(size int) []byte {
	buf := mm.Allocate(size, WithSubsystem("mining"), WithAlignment(64))
	
	if buf != nil {
		mm.miningPool.stats.Allocated.Add(int64(size))
		mm.miningPool.stats.CurrentUsage.Add(int64(size))
		mm.miningPool.stats.LastAccess.Store(time.Now().Unix())
	}
	
	return buf
}

// AllocateForNetwork allocates memory optimized for network operations
func (mm *UnifiedMemoryManager) AllocateForNetwork(size int) []byte {
	buf := mm.Allocate(size, WithSubsystem("network"), WithAlignment(8))
	
	if buf != nil {
		mm.networkPool.stats.Allocated.Add(int64(size))
		mm.networkPool.stats.CurrentUsage.Add(int64(size))
		mm.networkPool.stats.LastAccess.Store(time.Now().Unix())
	}
	
	return buf
}

// AllocateForStorage allocates memory optimized for storage operations
func (mm *UnifiedMemoryManager) AllocateForStorage(size int) []byte {
	buf := mm.Allocate(size, WithSubsystem("storage"), WithAlignment(512))
	
	if buf != nil {
		mm.storagePool.stats.Allocated.Add(int64(size))
		mm.storagePool.stats.CurrentUsage.Add(int64(size))
		mm.storagePool.stats.LastAccess.Store(time.Now().Unix())
	}
	
	return buf
}

// gcRoutine performs periodic garbage collection
func (mm *UnifiedMemoryManager) gcRoutine() {
	defer mm.wg.Done()
	
	ticker := time.NewTicker(mm.config.GCInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-mm.shutdown:
			return
		case <-ticker.C:
			mm.performGC()
		}
	}
}

// performGC performs garbage collection
func (mm *UnifiedMemoryManager) performGC() {
	runtime.GC()
	mm.stats.GCRuns.Add(1)
	mm.stats.LastGC.Store(time.Now().Unix())
	
	// Update current memory usage
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	mm.stats.CurrentUsage.Store(int64(m.Alloc))
}

// compactionRoutine performs periodic memory compaction
func (mm *UnifiedMemoryManager) compactionRoutine() {
	defer mm.wg.Done()
	
	ticker := time.NewTicker(mm.config.CompactionInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-mm.shutdown:
			return
		case <-ticker.C:
			mm.performCompaction()
		}
	}
}

// performCompaction performs memory compaction
func (mm *UnifiedMemoryManager) performCompaction() {
	// Force a full GC cycle
	runtime.GC()
	runtime.Gosched()
	
	mm.stats.CompactionRuns.Add(1)
	mm.stats.LastCompaction.Store(time.Now().Unix())
}

// metricsCollector collects memory metrics
func (mm *UnifiedMemoryManager) metricsCollector() {
	defer mm.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-mm.shutdown:
			return
		case <-ticker.C:
			mm.collectMetrics()
		}
	}
}

// collectMetrics collects current memory metrics
func (mm *UnifiedMemoryManager) collectMetrics() {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	// Update global statistics
	mm.stats.CurrentUsage.Store(int64(m.Alloc))
	
	// Check peak usage
	for {
		peak := mm.stats.PeakUsage.Load()
		current := mm.stats.CurrentUsage.Load()
		if current <= peak || mm.stats.PeakUsage.CompareAndSwap(peak, current) {
			break
		}
	}
}

// GetStats returns current memory statistics
func (mm *UnifiedMemoryManager) GetStats() map[string]interface{} {
	poolStats := mm.pool.Stats()
	
	return map[string]interface{}{
		"total_allocated":   mm.stats.TotalAllocated.Load(),
		"total_freed":       mm.stats.TotalFreed.Load(),
		"current_usage":     mm.stats.CurrentUsage.Load(),
		"peak_usage":        mm.stats.PeakUsage.Load(),
		"allocations":       mm.stats.Allocations.Load(),
		"deallocations":     mm.stats.Deallocations.Load(),
		"gc_runs":          mm.stats.GCRuns.Load(),
		"compaction_runs":  mm.stats.CompactionRuns.Load(),
		"last_gc":          time.Unix(mm.stats.LastGC.Load(), 0),
		"last_compaction":  time.Unix(mm.stats.LastCompaction.Load(), 0),
		"pool_stats":       poolStats,
		"mining_pool": map[string]interface{}{
			"allocated":    mm.miningPool.stats.Allocated.Load(),
			"current":      mm.miningPool.stats.CurrentUsage.Load(),
			"last_access":  time.Unix(mm.miningPool.stats.LastAccess.Load(), 0),
		},
		"network_pool": map[string]interface{}{
			"allocated":    mm.networkPool.stats.Allocated.Load(),
			"current":      mm.networkPool.stats.CurrentUsage.Load(),
			"last_access":  time.Unix(mm.networkPool.stats.LastAccess.Load(), 0),
		},
		"storage_pool": map[string]interface{}{
			"allocated":    mm.storagePool.stats.Allocated.Load(),
			"current":      mm.storagePool.stats.CurrentUsage.Load(),
			"last_access":  time.Unix(mm.storagePool.stats.LastAccess.Load(), 0),
		},
	}
}

// Shutdown gracefully shuts down the memory manager
func (mm *UnifiedMemoryManager) Shutdown() {
	close(mm.shutdown)
	mm.wg.Wait()
}

// AllocOption defines allocation options
type AllocOption func(*allocOptions)

type allocOptions struct {
	alignment int
	zeroed    bool
	subsystem string
}

// WithAlignment sets memory alignment
func WithAlignment(alignment int) AllocOption {
	return func(o *allocOptions) {
		o.alignment = alignment
	}
}

// WithZeroed requests zeroed memory
func WithZeroed() AllocOption {
	return func(o *allocOptions) {
		o.zeroed = true
	}
}

// WithSubsystem tags allocation with subsystem name
func WithSubsystem(subsystem string) AllocOption {
	return func(o *allocOptions) {
		o.subsystem = subsystem
	}
}

// ZeroAllocator provides zero-allocation patterns
type ZeroAllocator struct {
	buffers [][]byte
	size    int
	index   int
	mu      sync.Mutex
}

// NewZeroAllocator creates a zero-allocation buffer manager
func NewZeroAllocator(bufferSize, bufferCount int) *ZeroAllocator {
	za := &ZeroAllocator{
		buffers: make([][]byte, bufferCount),
		size:    bufferSize,
	}
	
	for i := range za.buffers {
		za.buffers[i] = make([]byte, bufferSize)
	}
	
	return za
}

// Get returns a buffer without allocation
func (za *ZeroAllocator) Get() []byte {
	za.mu.Lock()
	defer za.mu.Unlock()
	
	buf := za.buffers[za.index]
	za.index = (za.index + 1) % len(za.buffers)
	
	// Clear the buffer
	clear(buf)
	return buf
}

// clearBytes zeros out a byte slice efficiently
func clearBytes(b []byte) {
	// Use optimized clear for larger slices
	if len(b) > 64 {
		// Clear in chunks for better performance
		for len(b) >= 8 {
			*(*uint64)(unsafe.Pointer(&b[0])) = 0
			b = b[8:]
		}
	}
	
	// Clear remaining bytes
	for i := range b {
		b[i] = 0
	}
}

// Global instance for convenience
var globalManager *UnifiedMemoryManager
var globalOnce sync.Once

// Initialize initializes the global memory manager
func Initialize(config MemoryConfig) {
	globalOnce.Do(func() {
		globalManager = NewUnifiedMemoryManager(config)
	})
}

// Global returns the global memory manager instance
func Global() *UnifiedMemoryManager {
	if globalManager == nil {
		Initialize(DefaultMemoryConfig())
	}
	return globalManager
}

// Allocate allocates memory using the global manager
func Allocate(size int, options ...AllocOption) []byte {
	return Global().Allocate(size, options...)
}

// Free returns memory to the global pool
func Free(buf []byte) {
	Global().Free(buf)
}