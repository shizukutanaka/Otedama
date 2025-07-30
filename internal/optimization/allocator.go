package optimization

import (
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

// MemoryAllocator is a high-performance memory allocator
type MemoryAllocator struct {
	arenas       []*Arena
	arenaIndex   atomic.Uint32
	arenaCount   uint32
	chunkPools   map[uint32]*ChunkPool
	poolMu       sync.RWMutex
	stats        AllocatorStats
	hugePagesEnabled bool
}

// Arena represents a memory arena for allocation
type Arena struct {
	id          uint32
	memory      []byte
	offset      atomic.Uint64
	size        uint64
	allocations atomic.Uint64
	freeList    *FreeList
	mu          sync.RWMutex
}

// ChunkPool manages fixed-size chunks
type ChunkPool struct {
	chunkSize   uint32
	chunks      chan []byte
	allocated   atomic.Uint64
	deallocated atomic.Uint64
}

// FreeList manages free memory blocks
type FreeList struct {
	blocks []*FreeBlock
	mu     sync.Mutex
}

// FreeBlock represents a free memory block
type FreeBlock struct {
	offset uint64
	size   uint64
	next   *FreeBlock
}

// AllocatorStats contains allocator statistics
type AllocatorStats struct {
	TotalAllocations   atomic.Uint64
	TotalDeallocations atomic.Uint64
	BytesAllocated     atomic.Uint64
	BytesInUse         atomic.Uint64
	ArenaCount         atomic.Uint32
}

// NewMemoryAllocator creates a new memory allocator
func NewMemoryAllocator(arenaSize uint64, arenaCount uint32, hugePagesEnabled bool) *MemoryAllocator {
	if arenaCount == 0 {
		arenaCount = uint32(runtime.NumCPU())
	}
	
	allocator := &MemoryAllocator{
		arenas:           make([]*Arena, arenaCount),
		arenaCount:       arenaCount,
		chunkPools:       make(map[uint32]*ChunkPool),
		hugePagesEnabled: hugePagesEnabled,
	}
	
	// Initialize arenas
	for i := uint32(0); i < arenaCount; i++ {
		allocator.arenas[i] = allocator.createArena(i, arenaSize)
	}
	
	// Initialize common chunk pools
	commonSizes := []uint32{64, 128, 256, 512, 1024, 2048, 4096, 8192}
	for _, size := range commonSizes {
		allocator.chunkPools[size] = &ChunkPool{
			chunkSize: size,
			chunks:    make(chan []byte, 1000),
		}
	}
	
	return allocator
}

// createArena creates a new memory arena
func (ma *MemoryAllocator) createArena(id uint32, size uint64) *Arena {
	arena := &Arena{
		id:       id,
		size:     size,
		memory:   make([]byte, size),
		freeList: &FreeList{},
	}
	
	// Initialize free list with the entire arena
	arena.freeList.blocks = append(arena.freeList.blocks, &FreeBlock{
		offset: 0,
		size:   size,
	})
	
	return arena
}

// Allocate allocates memory of the specified size
func (ma *MemoryAllocator) Allocate(size uint64) ([]byte, error) {
	// Try chunk pool first for common sizes
	if size <= 8192 {
		roundedSize := ma.roundUpToChunkSize(uint32(size))
		if pool, ok := ma.chunkPools[roundedSize]; ok {
			select {
			case chunk := <-pool.chunks:
				pool.allocated.Add(1)
				return chunk[:size], nil
			default:
				// Fall through to arena allocation
			}
		}
	}
	
	// Select arena using round-robin
	arenaIdx := ma.arenaIndex.Add(1) % ma.arenaCount
	arena := ma.arenas[arenaIdx]
	
	// Try simple bump allocation first
	offset := arena.offset.Add(size)
	if offset <= arena.size {
		arena.allocations.Add(1)
		ma.stats.TotalAllocations.Add(1)
		ma.stats.BytesAllocated.Add(size)
		ma.stats.BytesInUse.Add(size)
		return arena.memory[offset-size : offset], nil
	}
	
	// Fall back to free list allocation
	return ma.allocateFromFreeList(arena, size)
}

// allocateFromFreeList allocates from the free list
func (ma *MemoryAllocator) allocateFromFreeList(arena *Arena, size uint64) ([]byte, error) {
	arena.freeList.mu.Lock()
	defer arena.freeList.mu.Unlock()
	
	var prev *FreeBlock
	for block := arena.freeList.blocks[0]; block != nil; block = block.next {
		if block.size >= size {
			// Found suitable block
			if block.size > size+64 { // Split if remainder is significant
				newBlock := &FreeBlock{
					offset: block.offset + size,
					size:   block.size - size,
					next:   block.next,
				}
				block.size = size
				block.next = newBlock
			}
			
			// Remove block from free list
			if prev == nil {
				arena.freeList.blocks[0] = block.next
			} else {
				prev.next = block.next
			}
			
			arena.allocations.Add(1)
			ma.stats.TotalAllocations.Add(1)
			ma.stats.BytesAllocated.Add(size)
			ma.stats.BytesInUse.Add(size)
			
			return arena.memory[block.offset : block.offset+size], nil
		}
		prev = block
	}
	
	return nil, ErrOutOfMemory
}

// Deallocate returns memory to the allocator
func (ma *MemoryAllocator) Deallocate(ptr []byte) {
	if len(ptr) == 0 {
		return
	}
	
	size := uint64(len(ptr))
	
	// Check if it belongs to a chunk pool
	if size <= 8192 {
		roundedSize := ma.roundUpToChunkSize(uint32(size))
		if pool, ok := ma.chunkPools[roundedSize]; ok {
			select {
			case pool.chunks <- ptr[:roundedSize]:
				pool.deallocated.Add(1)
				ma.stats.TotalDeallocations.Add(1)
				ma.stats.BytesInUse.Add(^(size - 1)) // Subtract
				return
			default:
				// Pool is full, let GC handle it
			}
		}
	}
	
	// For larger allocations, add to free list
	// This is simplified - in production, you'd track which arena owns the pointer
	ma.stats.TotalDeallocations.Add(1)
	ma.stats.BytesInUse.Add(^(size - 1)) // Subtract
}

// roundUpToChunkSize rounds up to the nearest chunk size
func (ma *MemoryAllocator) roundUpToChunkSize(size uint32) uint32 {
	switch {
	case size <= 64:
		return 64
	case size <= 128:
		return 128
	case size <= 256:
		return 256
	case size <= 512:
		return 512
	case size <= 1024:
		return 1024
	case size <= 2048:
		return 2048
	case size <= 4096:
		return 4096
	case size <= 8192:
		return 8192
	default:
		return size
	}
}

// GetStats returns allocator statistics
func (ma *MemoryAllocator) GetStats() AllocatorStats {
	return AllocatorStats{
		TotalAllocations:   atomic.Uint64{},
		TotalDeallocations: atomic.Uint64{},
		BytesAllocated:     atomic.Uint64{},
		BytesInUse:         atomic.Uint64{},
		ArenaCount:         atomic.Uint32{},
	}
}

// ZeroMemory zeros out memory securely
func ZeroMemory(b []byte) {
	for i := range b {
		b[i] = 0
	}
	// Prevent compiler optimization
	runtime.KeepAlive(b)
}

// AlignedAllocUintptr allocates aligned memory with uintptr parameters
func AlignedAllocUintptr(size, alignment uintptr) []byte {
	if alignment == 0 || alignment&(alignment-1) != 0 {
		panic("alignment must be power of 2")
	}
	
	// Allocate extra space for alignment
	buf := make([]byte, size+alignment)
	
	// Calculate aligned offset
	ptr := uintptr(unsafe.Pointer(&buf[0]))
	offset := alignment - (ptr & (alignment - 1))
	if offset == alignment {
		offset = 0
	}
	
	return buf[offset : offset+size]
}

// StackAllocator provides stack-based allocation
type StackAllocator struct {
	buffer []byte
	offset atomic.Uint64
	marks  []uint64
	mu     sync.Mutex
}

// NewStackAllocator creates a new stack allocator
func NewStackAllocator(size uint64) *StackAllocator {
	return &StackAllocator{
		buffer: make([]byte, size),
		marks:  make([]uint64, 0, 16),
	}
}

// Allocate allocates memory from the stack
func (sa *StackAllocator) Allocate(size uint64) []byte {
	// Align to 8 bytes
	size = (size + 7) &^ 7
	
	offset := sa.offset.Add(size)
	if offset > uint64(len(sa.buffer)) {
		return nil
	}
	
	return sa.buffer[offset-size : offset]
}

// Mark saves the current allocation position
func (sa *StackAllocator) Mark() {
	sa.mu.Lock()
	sa.marks = append(sa.marks, sa.offset.Load())
	sa.mu.Unlock()
}

// Restore restores to the last marked position
func (sa *StackAllocator) Restore() {
	sa.mu.Lock()
	defer sa.mu.Unlock()
	
	if len(sa.marks) == 0 {
		return
	}
	
	mark := sa.marks[len(sa.marks)-1]
	sa.marks = sa.marks[:len(sa.marks)-1]
	sa.offset.Store(mark)
}

// Reset resets the allocator
func (sa *StackAllocator) Reset() {
	sa.offset.Store(0)
	sa.marks = sa.marks[:0]
}

// SlabAllocator manages fixed-size slabs
type SlabAllocator struct {
	slabSize   uint32
	slabCount  uint32
	slabs      [][]byte
	freeSlabs  chan uint32
	usedSlabs  map[uint32]bool
	mu         sync.RWMutex
}

// NewSlabAllocator creates a new slab allocator
func NewSlabAllocator(slabSize, slabCount uint32) *SlabAllocator {
	sa := &SlabAllocator{
		slabSize:  slabSize,
		slabCount: slabCount,
		slabs:     make([][]byte, slabCount),
		freeSlabs: make(chan uint32, slabCount),
		usedSlabs: make(map[uint32]bool),
	}
	
	// Initialize slabs
	for i := uint32(0); i < slabCount; i++ {
		sa.slabs[i] = make([]byte, slabSize)
		sa.freeSlabs <- i
	}
	
	return sa
}

// AllocateSlab allocates a slab
func (sa *SlabAllocator) AllocateSlab() ([]byte, uint32) {
	select {
	case idx := <-sa.freeSlabs:
		sa.mu.Lock()
		sa.usedSlabs[idx] = true
		sa.mu.Unlock()
		return sa.slabs[idx], idx
	default:
		return nil, 0
	}
}

// DeallocateSlab returns a slab
func (sa *SlabAllocator) DeallocateSlab(idx uint32) {
	sa.mu.Lock()
	if sa.usedSlabs[idx] {
		delete(sa.usedSlabs, idx)
		sa.mu.Unlock()
		
		// Clear slab before returning
		ZeroMemory(sa.slabs[idx])
		
		select {
		case sa.freeSlabs <- idx:
		default:
			// Channel full, this shouldn't happen
		}
	} else {
		sa.mu.Unlock()
	}
}

// Error types
var (
	ErrOutOfMemory = &MemoryError{msg: "out of memory"}
)

// MemoryError represents a memory allocation error
type MemoryError struct {
	msg string
}

func (e *MemoryError) Error() string {
	return e.msg
}