package optimization

import (
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

// ZeroCopyPool implements a high-performance memory pool with zero-copy operations
// Following John Carmack's approach to performance optimization
type ZeroCopyPool struct {
	// Size-specific pools with power-of-2 sizing for cache alignment
	pools [24]sync.Pool // 16B to 128MB
	
	// Direct memory mapping for large allocations
	largeAllocs sync.Map
	
	// Statistics
	stats struct {
		allocations   atomic.Uint64
		deallocations atomic.Uint64
		bytesInUse    atomic.Int64
		peakBytes     atomic.Int64
		zeroCopyOps   atomic.Uint64
	}
	
	// Memory alignment for cache optimization
	alignment int
	
	// NUMA-aware allocation
	numaNodes int
	nodeAffinity []int
}

// Buffer represents a zero-copy buffer
type Buffer struct {
	data     []byte
	pool     *ZeroCopyPool
	poolIdx  int
	refCount atomic.Int32
}

// NewZeroCopyPool creates a high-performance memory pool
func NewZeroCopyPool() *ZeroCopyPool {
	p := &ZeroCopyPool{
		alignment: 64, // Cache line size
		numaNodes: runtime.NumCPU(),
	}
	
	// Initialize size-specific pools
	for i := range p.pools {
		size := 1 << (i + 4) // 16B, 32B, 64B, ... up to 128MB
		idx := i
		
		p.pools[i].New = func() interface{} {
			// Allocate aligned memory
			buf := make([]byte, size+p.alignment)
			aligned := alignUp(uintptr(unsafe.Pointer(&buf[0])), uintptr(p.alignment))
			offset := int(aligned - uintptr(unsafe.Pointer(&buf[0])))
			
			p.stats.allocations.Add(1)
			p.stats.bytesInUse.Add(int64(size))
			p.updatePeakBytes()
			
			return &Buffer{
				data:    buf[offset : offset+size],
				pool:    p,
				poolIdx: idx,
			}
		}
	}
	
	// Initialize NUMA affinity
	p.initNUMAAffinity()
	
	return p
}

// Allocate returns a buffer of at least the requested size
func (p *ZeroCopyPool) Allocate(size int) *Buffer {
	if size <= 0 {
		return &Buffer{data: []byte{}}
	}
	
	// Find appropriate pool
	poolIdx := p.sizeToPoolIndex(size)
	
	// Large allocations bypass pool
	if poolIdx >= len(p.pools) {
		buf := make([]byte, size)
		b := &Buffer{
			data:    buf,
			pool:    p,
			poolIdx: -1,
		}
		b.refCount.Store(1)
		
		p.largeAllocs.Store(unsafe.Pointer(&buf[0]), b)
		p.stats.allocations.Add(1)
		p.stats.bytesInUse.Add(int64(size))
		p.updatePeakBytes()
		
		return b
	}
	
	// Get from pool
	b := p.pools[poolIdx].Get().(*Buffer)
	b.refCount.Store(1)
	
	// Trim to requested size
	if len(b.data) > size {
		b.data = b.data[:size]
	}
	
	return b
}

// AllocateAligned allocates cache-aligned memory
func (p *ZeroCopyPool) AllocateAligned(size, alignment int) *Buffer {
	if alignment <= 0 {
		alignment = p.alignment
	}
	
	// Allocate extra space for alignment
	buf := p.Allocate(size + alignment)
	
	// Align the buffer
	ptr := uintptr(unsafe.Pointer(&buf.data[0]))
	aligned := alignUp(ptr, uintptr(alignment))
	offset := int(aligned - ptr)
	
	buf.data = buf.data[offset : offset+size]
	return buf
}

// ZeroCopySlice creates a zero-copy slice from existing buffer
func (p *ZeroCopyPool) ZeroCopySlice(buf *Buffer, offset, length int) *Buffer {
	if offset < 0 || length < 0 || offset+length > len(buf.data) {
		return nil
	}
	
	// Create zero-copy slice
	slice := &Buffer{
		data:    buf.data[offset : offset+length],
		pool:    p,
		poolIdx: -2, // Mark as slice
	}
	
	// Share reference count
	buf.refCount.Add(1)
	slice.refCount.Store(buf.refCount.Load())
	
	p.stats.zeroCopyOps.Add(1)
	
	return slice
}

// Buffer methods

// Data returns the buffer data
func (b *Buffer) Data() []byte {
	return b.data
}

// Len returns the buffer length
func (b *Buffer) Len() int {
	return len(b.data)
}

// Cap returns the buffer capacity
func (b *Buffer) Cap() int {
	return cap(b.data)
}

// Release returns the buffer to the pool
func (b *Buffer) Release() {
	if b.pool == nil || b.poolIdx == -2 {
		return
	}
	
	// Decrement reference count
	if b.refCount.Add(-1) > 0 {
		return
	}
	
	size := cap(b.data)
	
	// Return to pool or free large allocation
	if b.poolIdx >= 0 {
		// Reset length to full capacity
		b.data = b.data[:cap(b.data)]
		b.pool.pools[b.poolIdx].Put(b)
	} else if b.poolIdx == -1 {
		// Remove large allocation
		b.pool.largeAllocs.Delete(unsafe.Pointer(&b.data[0]))
	}
	
	b.pool.stats.deallocations.Add(1)
	b.pool.stats.bytesInUse.Add(-int64(size))
}

// Resize resizes the buffer in-place if possible
func (b *Buffer) Resize(newSize int) bool {
	if newSize <= cap(b.data) {
		b.data = b.data[:newSize]
		return true
	}
	return false
}

// Clone creates a copy of the buffer
func (b *Buffer) Clone() *Buffer {
	newBuf := b.pool.Allocate(len(b.data))
	copy(newBuf.data, b.data)
	return newBuf
}

// Internal methods

func (p *ZeroCopyPool) sizeToPoolIndex(size int) int {
	if size <= 16 {
		return 0
	}
	
	// Find the smallest power of 2 >= size
	bits := 0
	for s := size - 1; s > 0; s >>= 1 {
		bits++
	}
	
	if bits <= 4 {
		return 0
	}
	return bits - 4
}

func (p *ZeroCopyPool) updatePeakBytes() {
	current := p.stats.bytesInUse.Load()
	for {
		peak := p.stats.peakBytes.Load()
		if current <= peak || p.stats.peakBytes.CompareAndSwap(peak, current) {
			break
		}
	}
}

func (p *ZeroCopyPool) initNUMAAffinity() {
	p.nodeAffinity = make([]int, p.numaNodes)
	for i := range p.nodeAffinity {
		p.nodeAffinity[i] = i % runtime.NumCPU()
	}
}

// alignUp aligns ptr to alignment boundary
func alignUp(ptr, alignment uintptr) uintptr {
	return (ptr + alignment - 1) &^ (alignment - 1)
}

// GetStats returns pool statistics
func (p *ZeroCopyPool) GetStats() PoolStats {
	return PoolStats{
		Allocations:   p.stats.allocations.Load(),
		Deallocations: p.stats.deallocations.Load(),
		BytesInUse:    p.stats.bytesInUse.Load(),
		PeakBytes:     p.stats.peakBytes.Load(),
		ZeroCopyOps:   p.stats.zeroCopyOps.Load(),
	}
}

// PoolStats contains memory pool statistics
type PoolStats struct {
	Allocations   uint64
	Deallocations uint64
	BytesInUse    int64
	PeakBytes     int64
	ZeroCopyOps   uint64
}

// Prefetch hints the CPU to prefetch memory
func (b *Buffer) Prefetch() {
	if len(b.data) == 0 {
		return
	}
	
	// Prefetch cache lines
	for i := 0; i < len(b.data); i += 64 {
		_ = b.data[i]
	}
}

// Zero fills the buffer with zeros efficiently
func (b *Buffer) Zero() {
	// Use optimized zeroing for large buffers
	if len(b.data) > 4096 {
		// This will be optimized by the compiler
		for i := range b.data {
			b.data[i] = 0
		}
	} else {
		// For small buffers, use copy optimization
		if len(b.data) > 0 {
			b.data[0] = 0
			for i := 1; i < len(b.data); i *= 2 {
				copy(b.data[i:], b.data[:i])
			}
		}
	}
}

// CopyFrom performs optimized copy from source
func (b *Buffer) CopyFrom(src []byte) int {
	n := copy(b.data, src)
	return n
}

// CopyTo performs optimized copy to destination
func (b *Buffer) CopyTo(dst []byte) int {
	n := copy(dst, b.data)
	return n
}