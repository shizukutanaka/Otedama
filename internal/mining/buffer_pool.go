package mining

import (
	"runtime"
	"sync"
	"sync/atomic"
)

// MiningBufferPool provides optimized memory management for mining operations
// Following John Carmack's principle of minimizing allocations in hot paths
type MiningBufferPool struct {
	// Different sized buffer pools for various operations
	small  sync.Pool // 256 bytes - nonce operations
	medium sync.Pool // 4KB - hash operations  
	large  sync.Pool // 64KB - batch operations
	huge   sync.Pool // 1MB - dataset operations
	
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

// NewMiningBufferPool creates an optimized buffer pool
func NewMiningBufferPool() *MiningBufferPool {
	return &MiningBufferPool{
		small: sync.Pool{
			New: func() interface{} {
				buf := make([]byte, SmallBufferSize)
				return &buf
			},
		},
		medium: sync.Pool{
			New: func() interface{} {
				buf := make([]byte, MediumBufferSize)
				return &buf
			},
		},
		large: sync.Pool{
			New: func() interface{} {
				buf := make([]byte, LargeBufferSize)
				return &buf
			},
		},
		huge: sync.Pool{
			New: func() interface{} {
				buf := make([]byte, HugeBufferSize)
				return &buf
			},
		},
	}
}

// GetSmall returns a small buffer from the pool
func (p *MiningBufferPool) GetSmall() []byte {
	buf := p.small.Get().(*[]byte)
	p.reuses.Add(1)
	return *buf
}

// GetMedium returns a medium buffer from the pool
func (p *MiningBufferPool) GetMedium() []byte {
	buf := p.medium.Get().(*[]byte)
	p.reuses.Add(1)
	return *buf
}

// GetLarge returns a large buffer from the pool
func (p *MiningBufferPool) GetLarge() []byte {
	buf := p.large.Get().(*[]byte)
	p.reuses.Add(1)
	return *buf
}

// GetHuge returns a huge buffer from the pool
func (p *MiningBufferPool) GetHuge() []byte {
	buf := p.huge.Get().(*[]byte)
	p.reuses.Add(1)
	return *buf
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
		// For very large buffers, allocate directly
		p.allocations.Add(1)
		p.totalSize.Add(int64(size))
		return make([]byte, size)
	}
}

// Put returns a buffer to the pool
func (p *MiningBufferPool) Put(buf []byte) {
	// Clear sensitive data before returning to pool
	clear(buf)
	
	size := cap(buf)
	switch size {
	case SmallBufferSize:
		p.small.Put(&buf)
	case MediumBufferSize:
		p.medium.Put(&buf)
	case LargeBufferSize:
		p.large.Put(&buf)
	case HugeBufferSize:
		p.huge.Put(&buf)
	default:
		// Don't pool non-standard sizes
		// Let GC handle them
	}
}

// GetStats returns pool statistics
func (p *MiningBufferPool) GetStats() (allocations, reuses, totalSize int64) {
	return p.allocations.Load(), p.reuses.Load(), p.totalSize.Load()
}

// Preload pre-allocates buffers to reduce initial allocation overhead
func (p *MiningBufferPool) Preload() {
	// Pre-allocate buffers based on CPU count
	numCPU := runtime.NumCPU()
	
	// Pre-allocate small buffers (most common)
	for i := 0; i < numCPU*4; i++ {
		buf := make([]byte, SmallBufferSize)
		p.small.Put(&buf)
	}
	
	// Pre-allocate medium buffers
	for i := 0; i < numCPU*2; i++ {
		buf := make([]byte, MediumBufferSize)
		p.medium.Put(&buf)
	}
	
	// Pre-allocate large buffers
	for i := 0; i < numCPU; i++ {
		buf := make([]byte, LargeBufferSize)
		p.large.Put(&buf)
	}
	
	// Pre-allocate a few huge buffers
	for i := 0; i < 2; i++ {
		buf := make([]byte, HugeBufferSize)
		p.huge.Put(&buf)
	}
}

// clear efficiently zeros a byte slice
func clear(b []byte) {
	if len(b) == 0 {
		return
	}
	// Use optimized clear for Go 1.21+
	// Fallback to manual clear for older versions
	for i := range b {
		b[i] = 0
	}
}