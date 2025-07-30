package optimization

import (
	"runtime"
	"sync/atomic"
	"unsafe"

	"go.uber.org/zap"
)

// LockFreeQueue implements a high-performance lock-free queue
// Following John Carmack's principle: "The best optimization is when you can eliminate code"
type LockFreeQueue struct {
	head unsafe.Pointer
	tail unsafe.Pointer
	size atomic.Int64
}

type node struct {
	value interface{}
	next  unsafe.Pointer
}

// NewLockFreeQueue creates a new lock-free queue
func NewLockFreeQueue() *LockFreeQueue {
	n := &node{}
	q := &LockFreeQueue{
		head: unsafe.Pointer(n),
		tail: unsafe.Pointer(n),
	}
	return q
}

// Enqueue adds an item to the queue
func (q *LockFreeQueue) Enqueue(value interface{}) {
	n := &node{value: value}
	for {
		tail := (*node)(atomic.LoadPointer(&q.tail))
		next := (*node)(atomic.LoadPointer(&tail.next))
		
		if tail == (*node)(atomic.LoadPointer(&q.tail)) {
			if next == nil {
				if atomic.CompareAndSwapPointer(&tail.next, unsafe.Pointer(next), unsafe.Pointer(n)) {
					atomic.CompareAndSwapPointer(&q.tail, unsafe.Pointer(tail), unsafe.Pointer(n))
					q.size.Add(1)
					break
				}
			} else {
				atomic.CompareAndSwapPointer(&q.tail, unsafe.Pointer(tail), unsafe.Pointer(next))
			}
		}
		runtime.Gosched()
	}
}

// Dequeue removes and returns an item from the queue
func (q *LockFreeQueue) Dequeue() interface{} {
	for {
		head := (*node)(atomic.LoadPointer(&q.head))
		tail := (*node)(atomic.LoadPointer(&q.tail))
		next := (*node)(atomic.LoadPointer(&head.next))
		
		if head == (*node)(atomic.LoadPointer(&q.head)) {
			if head == tail {
				if next == nil {
					return nil
				}
				atomic.CompareAndSwapPointer(&q.tail, unsafe.Pointer(tail), unsafe.Pointer(next))
			} else {
				value := next.value
				if atomic.CompareAndSwapPointer(&q.head, unsafe.Pointer(head), unsafe.Pointer(next)) {
					q.size.Add(-1)
					return value
				}
			}
		}
		runtime.Gosched()
	}
}

// Size returns the current size of the queue
func (q *LockFreeQueue) Size() int64 {
	return q.size.Load()
}

// LockFreeRingBuffer implements a high-performance lock-free ring buffer
type LockFreeRingBuffer struct {
	buffer   []unsafe.Pointer
	capacity uint64
	mask     uint64
	head     atomic.Uint64
	tail     atomic.Uint64
}

// NewLockFreeRingBuffer creates a new lock-free ring buffer
func NewLockFreeRingBuffer(capacity uint64) *LockFreeRingBuffer {
	// Ensure capacity is power of 2
	cap := uint64(1)
	for cap < capacity {
		cap <<= 1
	}
	
	rb := &LockFreeRingBuffer{
		buffer:   make([]unsafe.Pointer, cap),
		capacity: cap,
		mask:     cap - 1,
	}
	return rb
}

// Put adds an item to the ring buffer
func (rb *LockFreeRingBuffer) Put(value interface{}) bool {
	for {
		head := rb.head.Load()
		tail := rb.tail.Load()
		
		if head-tail >= rb.capacity {
			return false // Buffer full
		}
		
		if rb.head.CompareAndSwap(head, head+1) {
			atomic.StorePointer(&rb.buffer[head&rb.mask], unsafe.Pointer(&value))
			return true
		}
		runtime.Gosched()
	}
}

// Get retrieves an item from the ring buffer
func (rb *LockFreeRingBuffer) Get() interface{} {
	for {
		head := rb.head.Load()
		tail := rb.tail.Load()
		
		if tail >= head {
			return nil // Buffer empty
		}
		
		if rb.tail.CompareAndSwap(tail, tail+1) {
			ptr := atomic.LoadPointer(&rb.buffer[tail&rb.mask])
			if ptr != nil {
				return *(*interface{})(ptr)
			}
		}
		runtime.Gosched()
	}
}

// SharePool implements a lock-free pool for share objects
type SharePool struct {
	pool   *LockFreeQueue
	logger *zap.Logger
	allocs atomic.Uint64
	reuses atomic.Uint64
}

// Share represents a mining share
type Share struct {
	MinerID    string
	JobID      string
	Nonce      uint64
	Hash       []byte
	Difficulty uint64
	Timestamp  int64
}

// NewSharePool creates a new share pool
func NewSharePool(logger *zap.Logger) *SharePool {
	return &SharePool{
		pool:   NewLockFreeQueue(),
		logger: logger,
	}
}

// Get retrieves a share from the pool
func (sp *SharePool) Get() *Share {
	if obj := sp.pool.Dequeue(); obj != nil {
		sp.reuses.Add(1)
		share := obj.(*Share)
		// Reset share
		share.MinerID = ""
		share.JobID = ""
		share.Nonce = 0
		share.Hash = share.Hash[:0]
		share.Difficulty = 0
		share.Timestamp = 0
		return share
	}
	
	sp.allocs.Add(1)
	return &Share{
		Hash: make([]byte, 0, 32),
	}
}

// Put returns a share to the pool
func (sp *SharePool) Put(share *Share) {
	sp.pool.Enqueue(share)
}

// Stats returns pool statistics
func (sp *SharePool) Stats() (allocs, reuses uint64) {
	return sp.allocs.Load(), sp.reuses.Load()
}

// LockFreeHashMap implements a high-performance concurrent hash map
type LockFreeHashMap struct {
	buckets  []atomic.Pointer[bucket]
	size     atomic.Int64
	capacity uint64
	mask     uint64
}

type bucket struct {
	key   string
	value unsafe.Pointer
	next  *bucket
}

// NewLockFreeHashMap creates a new lock-free hash map
func NewLockFreeHashMap(capacity int) *LockFreeHashMap {
	// Ensure capacity is power of 2
	cap := uint64(1)
	for cap < uint64(capacity) {
		cap <<= 1
	}
	
	m := &LockFreeHashMap{
		buckets:  make([]atomic.Pointer[bucket], cap),
		capacity: cap,
		mask:     cap - 1,
	}
	return m
}

// Put adds or updates a key-value pair
func (m *LockFreeHashMap) Put(key string, value interface{}) {
	hash := hashString(key)
	idx := hash & m.mask
	
	newBucket := &bucket{
		key:   key,
		value: unsafe.Pointer(&value),
	}
	
	for {
		head := m.buckets[idx].Load()
		newBucket.next = head
		
		if m.buckets[idx].CompareAndSwap(head, newBucket) {
			m.size.Add(1)
			break
		}
	}
}

// Get retrieves a value by key
func (m *LockFreeHashMap) Get(key string) (interface{}, bool) {
	hash := hashString(key)
	idx := hash & m.mask
	
	head := m.buckets[idx].Load()
	for b := head; b != nil; b = b.next {
		if b.key == key {
			return *(*interface{})(b.value), true
		}
	}
	
	return nil, false
}

// Size returns the number of items in the map
func (m *LockFreeHashMap) Size() int64 {
	return m.size.Load()
}

// hashString computes a hash for a string
func hashString(s string) uint64 {
	var hash uint64 = 5381
	for i := 0; i < len(s); i++ {
		hash = ((hash << 5) + hash) + uint64(s[i])
	}
	return hash
}