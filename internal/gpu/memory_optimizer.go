package gpu

import (
	"fmt"
	"math"
	"sync"
)

// MemoryOptimizer optimizes GPU memory usage for mining
type MemoryOptimizer struct {
	device         *GPUDevice
	
	// Memory pools
	pools          map[string]*MemoryPool
	poolsMu        sync.RWMutex
	
	// Memory statistics
	totalAllocated uint64
	peakUsage      uint64
	
	// Configuration
	maxMemoryUsage float64 // Percentage of total memory
	alignment      int     // Memory alignment requirement
}

// MemoryPool manages a pool of reusable memory buffers
type MemoryPool struct {
	name           string
	bufferSize     int
	maxBuffers     int
	alignment      int
	
	// Available buffers
	available      []GPUBuffer
	availableMu    sync.Mutex
	
	// In-use buffers
	inUse          map[string]GPUBuffer
	inUseMu        sync.RWMutex
	
	// Statistics
	allocated      int
	hits           uint64
	misses         uint64
}

// GPUBuffer represents a GPU memory buffer
type GPUBuffer struct {
	ID       string
	Ptr      interface{} // Device pointer
	Size     int
	Offset   int
	InUse    bool
}

// NewMemoryOptimizer creates a new memory optimizer
func NewMemoryOptimizer(device *GPUDevice, maxUsagePercent float64) *MemoryOptimizer {
	return &MemoryOptimizer{
		device:         device,
		pools:          make(map[string]*MemoryPool),
		maxMemoryUsage: maxUsagePercent,
		alignment:      256, // Common GPU memory alignment
	}
}

// CreatePool creates a new memory pool
func (m *MemoryOptimizer) CreatePool(name string, bufferSize, maxBuffers int) error {
	m.poolsMu.Lock()
	defer m.poolsMu.Unlock()
	
	if _, exists := m.pools[name]; exists {
		return fmt.Errorf("pool %s already exists", name)
	}
	
	pool := &MemoryPool{
		name:       name,
		bufferSize: m.alignSize(bufferSize),
		maxBuffers: maxBuffers,
		alignment:  m.alignment,
		available:  make([]GPUBuffer, 0),
		inUse:      make(map[string]GPUBuffer),
	}
	
	// Pre-allocate some buffers
	initialCount := minInt(maxBuffers/4, 10)
	for i := 0; i < initialCount; i++ {
		if err := pool.allocateBuffer(); err != nil {
			return err
		}
	}
	
	m.pools[name] = pool
	return nil
}

// GetBuffer gets a buffer from the pool
func (m *MemoryOptimizer) GetBuffer(poolName string) (*GPUBuffer, error) {
	m.poolsMu.RLock()
	pool, exists := m.pools[poolName]
	m.poolsMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("pool %s not found", poolName)
	}
	
	return pool.getBuffer()
}

// ReleaseBuffer returns a buffer to the pool
func (m *MemoryOptimizer) ReleaseBuffer(poolName string, buffer *GPUBuffer) error {
	m.poolsMu.RLock()
	pool, exists := m.pools[poolName]
	m.poolsMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("pool %s not found", poolName)
	}
	
	return pool.releaseBuffer(buffer)
}

// GetStats returns memory usage statistics
func (m *MemoryOptimizer) GetStats() MemoryStats {
	stats := MemoryStats{
		TotalMemory:    m.device.Memory,
		UsedMemory:     m.totalAllocated,
		PeakUsage:      m.peakUsage,
		Pools:          make(map[string]PoolStats),
	}
	
	m.poolsMu.RLock()
	defer m.poolsMu.RUnlock()
	
	for name, pool := range m.pools {
		stats.Pools[name] = pool.getStats()
	}
	
	return stats
}

// OptimizeForWorkload adjusts memory allocation for workload
func (m *MemoryOptimizer) OptimizeForWorkload(workload MiningWorkload) error {
	// Calculate memory requirements
	required := m.calculateMemoryRequirements(workload)
	
	// Check if we have enough memory
	availableMemory := uint64(float64(m.device.Memory) * m.maxMemoryUsage)
	if required.Total > availableMemory {
		return fmt.Errorf("insufficient memory: required %d, available %d", 
			required.Total, availableMemory)
	}
	
	// Adjust pools
	if err := m.adjustPools(required); err != nil {
		return err
	}
	
	return nil
}

// Memory pool methods

// getBuffer gets a buffer from the pool
func (p *MemoryPool) getBuffer() (*GPUBuffer, error) {
	// Try to get from available pool
	p.availableMu.Lock()
	if len(p.available) > 0 {
		buffer := p.available[len(p.available)-1]
		p.available = p.available[:len(p.available)-1]
		p.availableMu.Unlock()
		
		// Mark as in use
		p.inUseMu.Lock()
		buffer.InUse = true
		p.inUse[buffer.ID] = buffer
		p.inUseMu.Unlock()
		
		p.hits++
		return &buffer, nil
	}
	p.availableMu.Unlock()
	
	// Need to allocate new buffer
	p.misses++
	
	if p.allocated >= p.maxBuffers {
		return nil, fmt.Errorf("pool %s exhausted", p.name)
	}
	
	if err := p.allocateBuffer(); err != nil {
		return nil, err
	}
	
	// Retry
	return p.getBuffer()
}

// releaseBuffer returns a buffer to the pool
func (p *MemoryPool) releaseBuffer(buffer *GPUBuffer) error {
	p.inUseMu.Lock()
	if _, exists := p.inUse[buffer.ID]; !exists {
		p.inUseMu.Unlock()
		return fmt.Errorf("buffer %s not from this pool", buffer.ID)
	}
	delete(p.inUse, buffer.ID)
	p.inUseMu.Unlock()
	
	// Clear buffer (optional, for security)
	// p.clearBuffer(buffer)
	
	// Return to available pool
	p.availableMu.Lock()
	buffer.InUse = false
	p.available = append(p.available, *buffer)
	p.availableMu.Unlock()
	
	return nil
}

// allocateBuffer allocates a new buffer
func (p *MemoryPool) allocateBuffer() error {
	// This would allocate actual GPU memory
	// For now, create mock buffer
	
	buffer := GPUBuffer{
		ID:   fmt.Sprintf("%s_%d", p.name, p.allocated),
		Size: p.bufferSize,
		Ptr:  nil, // Would be actual device pointer
	}
	
	p.availableMu.Lock()
	p.available = append(p.available, buffer)
	p.allocated++
	p.availableMu.Unlock()
	
	return nil
}

// getStats returns pool statistics
func (p *MemoryPool) getStats() PoolStats {
	p.inUseMu.RLock()
	inUseCount := len(p.inUse)
	p.inUseMu.RUnlock()
	
	p.availableMu.Lock()
	availableCount := len(p.available)
	p.availableMu.Unlock()
	
	return PoolStats{
		BufferSize:     p.bufferSize,
		TotalBuffers:   p.allocated,
		InUse:          inUseCount,
		Available:      availableCount,
		Hits:           p.hits,
		Misses:         p.misses,
		HitRate:        float64(p.hits) / float64(p.hits+p.misses),
	}
}

// Memory optimization strategies

// MiningWorkload describes the mining workload characteristics
type MiningWorkload struct {
	Algorithm      string
	Intensity      int
	BatchSize      int
	ThreadsPerBlock int
	UseDouble      bool // Double precision
}

// MemoryRequirements calculated memory requirements
type MemoryRequirements struct {
	HeaderBuffer   uint64
	NonceBuffer    uint64
	HashBuffer     uint64
	StateBuffer    uint64
	ScratchBuffer  uint64
	Total          uint64
}

// calculateMemoryRequirements calculates memory needed for workload
func (m *MemoryOptimizer) calculateMemoryRequirements(workload MiningWorkload) MemoryRequirements {
	req := MemoryRequirements{}
	
	// Header buffer (80 bytes per work item)
	req.HeaderBuffer = uint64(80 * workload.BatchSize)
	
	// Nonce buffer (4 bytes per result)
	maxResults := workload.BatchSize / 1000 // Assume 0.1% hit rate
	req.NonceBuffer = uint64(4 * maxResults)
	
	// Hash buffer (32 bytes per hash)
	if workload.UseDouble {
		req.HashBuffer = uint64(64 * workload.BatchSize)
	} else {
		req.HashBuffer = uint64(32 * workload.BatchSize)
	}
	
	// State buffer for SHA256 (256 bytes per thread)
	req.StateBuffer = uint64(256 * workload.ThreadsPerBlock)
	
	// Scratch buffer (algorithm specific)
	switch workload.Algorithm {
	case "sha256d":
		req.ScratchBuffer = uint64(128 * workload.BatchSize)
	case "scrypt":
		req.ScratchBuffer = uint64(128 * 1024 * workload.ThreadsPerBlock) // 128KB per thread
	default:
		req.ScratchBuffer = uint64(64 * workload.BatchSize)
	}
	
	// Add alignment overhead (10%)
	overhead := uint64(float64(req.HeaderBuffer+req.NonceBuffer+req.HashBuffer+req.StateBuffer+req.ScratchBuffer) * 0.1)
	
	req.Total = req.HeaderBuffer + req.NonceBuffer + req.HashBuffer + 
	           req.StateBuffer + req.ScratchBuffer + overhead
	
	return req
}

// adjustPools adjusts memory pools based on requirements
func (m *MemoryOptimizer) adjustPools(req MemoryRequirements) error {
	// Define pool configurations based on requirements
	pools := []struct {
		name   string
		size   uint64
		count  int
	}{
		{"header", req.HeaderBuffer, 2},
		{"nonce", req.NonceBuffer, 4},
		{"hash", req.HashBuffer, 2},
		{"state", req.StateBuffer, 2},
		{"scratch", req.ScratchBuffer, 1},
	}
	
	for _, p := range pools {
		if p.size == 0 {
			continue
		}
		
		// Create or resize pool
		if err := m.CreatePool(p.name, int(p.size), p.count); err != nil {
			// Pool might already exist, try to resize
			// For now, ignore error
		}
	}
	
	return nil
}

// alignSize aligns size to memory alignment requirement
func (m *MemoryOptimizer) alignSize(size int) int {
	if size%m.alignment == 0 {
		return size
	}
	return ((size / m.alignment) + 1) * m.alignment
}

// Memory coalescing for better access patterns

// CoalescedBuffer represents memory organized for coalesced access
type CoalescedBuffer struct {
	Stride    int
	Elements  int
	Pitch     int
	DevicePtr interface{}
}

// CreateCoalescedBuffer creates buffer optimized for coalesced access
func CreateCoalescedBuffer(elementSize, elementCount, alignment int) *CoalescedBuffer {
	// Calculate stride for coalesced access
	stride := ((elementSize + alignment - 1) / alignment) * alignment
	
	return &CoalescedBuffer{
		Stride:   stride,
		Elements: elementCount,
		Pitch:    stride * elementCount,
	}
}

// Memory transfer optimization

// TransferOptimizer optimizes host-device memory transfers
type TransferOptimizer struct {
	device       *GPUDevice
	
	// Pinned memory pools
	pinnedPools  map[string][]byte
	
	// Transfer statistics
	transfers    uint64
	bytesTransferred uint64
}

// NewTransferOptimizer creates a new transfer optimizer
func NewTransferOptimizer(device *GPUDevice) *TransferOptimizer {
	return &TransferOptimizer{
		device:      device,
		pinnedPools: make(map[string][]byte),
	}
}

// AllocatePinnedMemory allocates pinned host memory for fast transfers
func (t *TransferOptimizer) AllocatePinnedMemory(name string, size int) error {
	// This would allocate page-locked memory
	// For now, use regular memory
	t.pinnedPools[name] = make([]byte, size)
	return nil
}

// OptimizeTransfer optimizes a memory transfer
func (t *TransferOptimizer) OptimizeTransfer(size int, useAsync bool) TransferConfig {
	config := TransferConfig{
		UseAsync:    useAsync,
		UsePinned:   size > 1024*1024, // Use pinned for large transfers
		ChunkSize:   t.calculateOptimalChunkSize(size),
	}
	
	return config
}

// calculateOptimalChunkSize calculates optimal transfer chunk size
func (t *TransferOptimizer) calculateOptimalChunkSize(totalSize int) int {
	// Based on PCIe bandwidth and latency
	const (
		minChunk = 64 * 1024      // 64KB minimum
		maxChunk = 16 * 1024 * 1024 // 16MB maximum
	)
	
	// Use 1MB chunks by default
	chunkSize := 1024 * 1024
	
	if totalSize < minChunk {
		return totalSize
	}
	
	// Adjust based on total size
	if totalSize > 100*1024*1024 {
		chunkSize = maxChunk
	}
	
	return chunkSize
}

// Types for memory statistics

// MemoryStats contains memory usage statistics
type MemoryStats struct {
	TotalMemory uint64
	UsedMemory  uint64
	PeakUsage   uint64
	Pools       map[string]PoolStats
}

// PoolStats contains pool-specific statistics  
type PoolStats struct {
	BufferSize   int
	TotalBuffers int
	InUse        int
	Available    int
	Hits         uint64
	Misses       uint64
	HitRate      float64
}

// TransferConfig contains transfer optimization settings
type TransferConfig struct {
	UseAsync  bool
	UsePinned bool
	ChunkSize int
}

// Utility functions

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// MemoryLayoutOptimizer optimizes memory layout for specific algorithms
type MemoryLayoutOptimizer struct {
	algorithm string
}

// OptimizeLayout optimizes memory layout for the algorithm
func (m *MemoryLayoutOptimizer) OptimizeLayout(data []byte, accessPattern AccessPattern) []byte {
	switch accessPattern {
	case AccessSequential:
		// Already optimal
		return data
	case AccessStrided:
		return m.optimizeForStrided(data)
	case AccessRandom:
		return m.optimizeForRandom(data)
	default:
		return data
	}
}

// AccessPattern describes memory access pattern
type AccessPattern int

const (
	AccessSequential AccessPattern = iota
	AccessStrided
	AccessRandom
	AccessCoalesced
)

// optimizeForStrided optimizes layout for strided access
func (m *MemoryLayoutOptimizer) optimizeForStrided(data []byte) []byte {
	// Implement data reordering for better cache utilization
	// For now, return as-is
	return data
}

// optimizeForRandom optimizes layout for random access
func (m *MemoryLayoutOptimizer) optimizeForRandom(data []byte) []byte {
	// Implement data structure like hash table for faster random access
	// For now, return as-is
	return data
}

// CacheOptimizer optimizes GPU cache usage
type CacheOptimizer struct {
	l1Size    int
	l2Size    int
	lineSize  int
}

// NewCacheOptimizer creates a cache optimizer
func NewCacheOptimizer() *CacheOptimizer {
	return &CacheOptimizer{
		l1Size:   48 * 1024,  // 48KB typical L1
		l2Size:   4 * 1024 * 1024, // 4MB typical L2
		lineSize: 128, // 128 byte cache line
	}
}

// OptimizeTiling calculates optimal tiling for cache efficiency
func (c *CacheOptimizer) OptimizeTiling(dataSize, elementSize int) TilingConfig {
	// Calculate tile size that fits in L1
	elementsPerLine := c.lineSize / elementSize
	linesInL1 := c.l1Size / c.lineSize
	
	// Leave some space for other data
	optimalTileSize := (linesInL1 * elementsPerLine * 3) / 4
	
	return TilingConfig{
		TileSize:     optimalTileSize,
		ElementsPerTile: optimalTileSize,
		TilesNeeded:  (dataSize + optimalTileSize - 1) / optimalTileSize,
	}
}

// TilingConfig contains tiling configuration
type TilingConfig struct {
	TileSize        int
	ElementsPerTile int
	TilesNeeded     int
}

// PrefetchOptimizer manages data prefetching
type PrefetchOptimizer struct {
	distance int // Prefetch distance
}

// NewPrefetchOptimizer creates a prefetch optimizer
func NewPrefetchOptimizer() *PrefetchOptimizer {
	return &PrefetchOptimizer{
		distance: 8, // Prefetch 8 elements ahead
	}
}

// GeneratePrefetchPattern generates prefetch instructions pattern
func (p *PrefetchOptimizer) GeneratePrefetchPattern(accessPattern []int) []int {
	prefetchPattern := make([]int, 0)
	
	for i, access := range accessPattern {
		// Current access
		prefetchPattern = append(prefetchPattern, access)
		
		// Prefetch future access
		futureIdx := i + p.distance
		if futureIdx < len(accessPattern) {
			prefetchPattern = append(prefetchPattern, -accessPattern[futureIdx]) // Negative indicates prefetch
		}
	}
	
	return prefetchPattern
}

// calculateOptimalBatchSize calculates optimal batch size for GPU
func calculateOptimalBatchSize(device *GPUDevice, workItemSize int) int {
	// Consider GPU memory and compute capability
	availableMemory := device.Memory * 90 / 100 // Use 90% of memory
	maxBatchFromMemory := int(availableMemory / uint64(workItemSize))
	
	// Consider compute units
	optimalWaves := 4 // Waves per compute unit for good occupancy
	workGroupSize := 256 // Typical work group size
	maxBatchFromCompute := device.ComputeUnits * optimalWaves * workGroupSize
	
	// Take minimum and round to power of 2
	optimalBatch := minInt(maxBatchFromMemory, maxBatchFromCompute)
	
	// Round down to nearest power of 2
	return int(math.Pow(2, math.Floor(math.Log2(float64(optimalBatch)))))
}