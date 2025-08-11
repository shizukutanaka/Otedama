package mining

import (
	"sync/atomic"
	
	"github.com/shizukutanaka/Otedama/internal/memory"
)

// MiningBufferPool provides optimized memory management for mining operations
// Now uses the unified memory manager for consistent memory management
type MiningBufferPool struct {
	manager *memory.UnifiedMemoryManager
	
	// Statistics
	allocations atomic.Int64
	reuses      atomic.Int64
	totalSize   atomic.Int64
}

// Buffer sizes optimized for cache line alignment
const (
	SmallBufferSize  = 256
	MediumBufferSize = 4 * 1024
	LargeBufferSize  = 64 * 1024
	HugeBufferSize   = 1024 * 1024
)

// NewMiningBufferPool creates an optimized buffer pool using unified memory
func NewMiningBufferPool() *MiningBufferPool {
	return &MiningBufferPool{
		manager: memory.Global(),
	}
}

// GetSmall returns a small buffer from the pool
func (p *MiningBufferPool) GetSmall() []byte {
	buf := p.manager.AllocateForMining(SmallBufferSize)
	p.reuses.Add(1)
	return buf
}

// GetMedium returns a medium buffer from the pool
func (p *MiningBufferPool) GetMedium() []byte {
	buf := p.manager.AllocateForMining(MediumBufferSize)
	p.reuses.Add(1)
	return buf
}

// GetLarge returns a large buffer from the pool
func (p *MiningBufferPool) GetLarge() []byte {
	buf := p.manager.AllocateForMining(LargeBufferSize)
	p.reuses.Add(1)
	return buf
}

// GetHuge returns a huge buffer from the pool
func (p *MiningBufferPool) GetHuge() []byte {
	buf := p.manager.AllocateForMining(HugeBufferSize)
	p.reuses.Add(1)
	return buf
}

// Get returns a buffer of the requested size
func (p *MiningBufferPool) Get(size int) []byte {
	switch {
	case size <= SmallBufferSize:
		return p.GetSmall()[:size]
	case size <= MediumBufferSize:
		return p.GetMedium()[:size]
	case size <= LargeBufferSize:
		return p.GetLarge()[:size]
	case size <= HugeBufferSize:
		return p.GetHuge()[:size]
	default:
		// For sizes larger than huge, allocate directly
		p.allocations.Add(1)
		p.totalSize.Add(int64(size))
		return p.manager.AllocateForMining(size)
	}
}

// Put returns a buffer to the pool
func (p *MiningBufferPool) Put(buf []byte) {
	if buf == nil {
		return
	}
	p.manager.Free(buf)
}

// PutSmall returns a small buffer to the pool
func (p *MiningBufferPool) PutSmall(buf []byte) {
	p.Put(buf)
}

// PutMedium returns a medium buffer to the pool
func (p *MiningBufferPool) PutMedium(buf []byte) {
	p.Put(buf)
}

// PutLarge returns a large buffer to the pool
func (p *MiningBufferPool) PutLarge(buf []byte) {
	p.Put(buf)
}

// PutHuge returns a huge buffer to the pool
func (p *MiningBufferPool) PutHuge(buf []byte) {
	p.Put(buf)
}

// GetAligned returns a cache-aligned buffer
func (p *MiningBufferPool) GetAligned(size int, alignment int) []byte {
	return p.manager.Allocate(size, 
		memory.WithSubsystem("mining"),
		memory.WithAlignment(alignment))
}

// GetZeroed returns a zeroed buffer
func (p *MiningBufferPool) GetZeroed(size int) []byte {
	return p.manager.Allocate(size,
		memory.WithSubsystem("mining"),
		memory.WithZeroed())
}

// Stats returns pool statistics
func (p *MiningBufferPool) Stats() BufferPoolStats {
	globalStats := p.manager.GetStats()
	miningStats := globalStats["mining_pool"].(map[string]interface{})
	
	return BufferPoolStats{
		Allocations: p.allocations.Load(),
		Reuses:      p.reuses.Load(),
		TotalSize:   p.totalSize.Load(),
		Allocated:   miningStats["allocated"].(int64),
		Current:     miningStats["current"].(int64),
	}
}

// BufferPoolStats contains buffer pool statistics
type BufferPoolStats struct {
	Allocations int64
	Reuses      int64
	TotalSize   int64
	Allocated   int64
	Current     int64
}

// Reset clears all buffers and resets statistics
func (p *MiningBufferPool) Reset() {
	// Statistics are managed by the unified memory manager
	// Just reset local counters
	p.allocations.Store(0)
	p.reuses.Store(0)
	p.totalSize.Store(0)
}