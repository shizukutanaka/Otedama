package optimization

import (
	"sync"
	"sync/atomic"
)

// SimpleMemoryPool provides a simple and efficient memory pool
// Following Rob Pike's philosophy: "Simplicity is the ultimate sophistication"
type SimpleMemoryPool struct {
	small  sync.Pool // 256 bytes - for hashes and small data
	medium sync.Pool // 4KB - for network messages
	large  sync.Pool // 64KB - for batch operations
	
	stats struct {
		hits   atomic.Uint64
		misses atomic.Uint64
		allocs atomic.Uint64
	}
}

// NewSimpleMemoryPool creates a new memory pool
func NewSimpleMemoryPool() *SimpleMemoryPool {
	mp := &SimpleMemoryPool{}
	
	// Small buffers (256 bytes)
	mp.small.New = func() interface{} {
		mp.stats.allocs.Add(1)
		return make([]byte, 256)
	}
	
	// Medium buffers (4KB)
	mp.medium.New = func() interface{} {
		mp.stats.allocs.Add(1)
		return make([]byte, 4096)
	}
	
	// Large buffers (64KB)
	mp.large.New = func() interface{} {
		mp.stats.allocs.Add(1)
		return make([]byte, 65536)
	}
	
	return mp
}

// Get returns a buffer of at least the requested size
func (mp *SimpleMemoryPool) Get(size int) []byte {
	var buf []byte
	
	switch {
	case size <= 256:
		buf = mp.small.Get().([]byte)
		mp.stats.hits.Add(1)
		return buf[:size]
	case size <= 4096:
		buf = mp.medium.Get().([]byte)
		mp.stats.hits.Add(1)
		return buf[:size]
	case size <= 65536:
		buf = mp.large.Get().([]byte)
		mp.stats.hits.Add(1)
		return buf[:size]
	default:
		// For very large allocations, just allocate
		mp.stats.misses.Add(1)
		return make([]byte, size)
	}
}

// Put returns a buffer to the pool
func (mp *SimpleMemoryPool) Put(buf []byte) {
	// Clear sensitive data
	for i := range buf {
		buf[i] = 0
	}
	
	// Return to appropriate pool based on capacity
	switch cap(buf) {
	case 256:
		mp.small.Put(buf[:256])
	case 4096:
		mp.medium.Put(buf[:4096])
	case 65536:
		mp.large.Put(buf[:65536])
	default:
		// Let GC handle non-standard sizes
	}
}

// GetHash32 returns a 32-byte buffer for hash operations
func (mp *SimpleMemoryPool) GetHash32() []byte {
	buf := mp.Get(32)
	return buf[:32]
}

// GetStats returns pool statistics
func (mp *SimpleMemoryPool) GetStats() (hits, misses, allocs uint64) {
	return mp.stats.hits.Load(), mp.stats.misses.Load(), mp.stats.allocs.Load()
}

// MiningBufferPool is a specialized pool for mining operations
type MiningBufferPool struct {
	hashPool  sync.Pool // 32 bytes for SHA256
	noncePool sync.Pool // 8 bytes for nonce
	jobPool   sync.Pool // ~200 bytes for job data
}

// NewMiningBufferPool creates a new mining-specific buffer pool
func NewMiningBufferPool() *MiningBufferPool {
	return &MiningBufferPool{
		hashPool: sync.Pool{
			New: func() interface{} {
				return make([]byte, 32)
			},
		},
		noncePool: sync.Pool{
			New: func() interface{} {
				return make([]byte, 8)
			},
		},
		jobPool: sync.Pool{
			New: func() interface{} {
				return make([]byte, 200)
			},
		},
	}
}

// GetHashBuffer returns a buffer for hash results
func (mbp *MiningBufferPool) GetHashBuffer() []byte {
	return mbp.hashPool.Get().([]byte)
}

// PutHashBuffer returns a hash buffer to the pool
func (mbp *MiningBufferPool) PutHashBuffer(buf []byte) {
	if len(buf) == 32 {
		// Clear for security
		for i := range buf {
			buf[i] = 0
		}
		mbp.hashPool.Put(buf)
	}
}

// GetNonceBuffer returns a buffer for nonce values
func (mbp *MiningBufferPool) GetNonceBuffer() []byte {
	return mbp.noncePool.Get().([]byte)
}

// PutNonceBuffer returns a nonce buffer to the pool
func (mbp *MiningBufferPool) PutNonceBuffer(buf []byte) {
	if len(buf) == 8 {
		mbp.noncePool.Put(buf)
	}
}

// GetJobBuffer returns a buffer for job data
func (mbp *MiningBufferPool) GetJobBuffer() []byte {
	return mbp.jobPool.Get().([]byte)
}

// PutJobBuffer returns a job buffer to the pool
func (mbp *MiningBufferPool) PutJobBuffer(buf []byte) {
	if cap(buf) == 200 {
		mbp.jobPool.Put(buf[:200])
	}
}