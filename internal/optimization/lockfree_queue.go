package optimization

import (
	"runtime"
	"sync/atomic"
	"unsafe"
)

// LockFreeQueue implements a high-performance lock-free ring buffer queue
// optimized for mining job distribution
type LockFreeQueue struct {
	buffer     []unsafe.Pointer
	head       atomic.Uint64
	tail       atomic.Uint64
	size       uint64
	mask       uint64
	cachePad1  [64]byte // Cache line padding to prevent false sharing
	cachePad2  [64]byte
}

// NewLockFreeQueue creates a new lock-free queue with the specified size
// Size must be a power of 2
func NewLockFreeQueue(size uint64) *LockFreeQueue {
	// Ensure size is power of 2
	if size&(size-1) != 0 {
		// Round up to next power of 2
		size = nextPowerOfTwo(size)
	}
	
	return &LockFreeQueue{
		buffer: make([]unsafe.Pointer, size),
		size:   size,
		mask:   size - 1,
	}
}

// Enqueue adds an item to the queue
// Returns false if the queue is full
func (q *LockFreeQueue) Enqueue(item interface{}) bool {
	for {
		tail := q.tail.Load()
		head := q.head.Load()
		
		// Check if queue is full
		if tail-head >= q.size {
			return false
		}
		
		// Try to claim the slot
		if q.tail.CompareAndSwap(tail, tail+1) {
			// Successfully claimed the slot
			index := tail & q.mask
			atomic.StorePointer(&q.buffer[index], unsafe.Pointer(&item))
			return true
		}
		
		// Backoff to reduce contention
		runtime.Gosched()
	}
}

// Dequeue removes and returns an item from the queue
// Returns nil if the queue is empty
func (q *LockFreeQueue) Dequeue() interface{} {
	for {
		head := q.head.Load()
		tail := q.tail.Load()
		
		// Check if queue is empty
		if head >= tail {
			return nil
		}
		
		// Try to claim the slot
		if q.head.CompareAndSwap(head, head+1) {
			// Successfully claimed the slot
			index := head & q.mask
			ptr := atomic.LoadPointer(&q.buffer[index])
			if ptr == nil {
				continue // Slot not yet filled, retry
			}
			
			// Clear the slot to help GC
			atomic.StorePointer(&q.buffer[index], nil)
			return *(*interface{})(ptr)
		}
		
		// Backoff to reduce contention
		runtime.Gosched()
	}
}

// Size returns the current number of items in the queue
func (q *LockFreeQueue) Size() uint64 {
	tail := q.tail.Load()
	head := q.head.Load()
	if tail >= head {
		return tail - head
	}
	return 0
}

// IsEmpty returns true if the queue is empty
func (q *LockFreeQueue) IsEmpty() bool {
	return q.Size() == 0
}

// IsFull returns true if the queue is full
func (q *LockFreeQueue) IsFull() bool {
	return q.Size() >= q.size
}

// MultiProducerQueue implements a lock-free MPMC queue optimized for mining
type MultiProducerQueue struct {
	queues    []*LockFreeQueue
	numQueues uint32
	counter   atomic.Uint32
}

// NewMultiProducerQueue creates a new multi-producer queue
func NewMultiProducerQueue(numQueues, queueSize uint64) *MultiProducerQueue {
	queues := make([]*LockFreeQueue, numQueues)
	for i := range queues {
		queues[i] = NewLockFreeQueue(queueSize)
	}
	
	return &MultiProducerQueue{
		queues:    queues,
		numQueues: uint32(numQueues),
	}
}

// Enqueue adds an item using round-robin distribution
func (mpq *MultiProducerQueue) Enqueue(item interface{}) bool {
	// Try each queue using round-robin
	start := mpq.counter.Add(1)
	for i := uint32(0); i < mpq.numQueues; i++ {
		idx := (start + i) % mpq.numQueues
		if mpq.queues[idx].Enqueue(item) {
			return true
		}
	}
	return false
}

// Dequeue removes an item from any available queue
func (mpq *MultiProducerQueue) Dequeue() interface{} {
	// Try each queue
	start := mpq.counter.Load()
	for i := uint32(0); i < mpq.numQueues; i++ {
		idx := (start + i) % mpq.numQueues
		if item := mpq.queues[idx].Dequeue(); item != nil {
			return item
		}
	}
	return nil
}

// BatchEnqueue adds multiple items efficiently
func (mpq *MultiProducerQueue) BatchEnqueue(items []interface{}) int {
	enqueued := 0
	for _, item := range items {
		if mpq.Enqueue(item) {
			enqueued++
		} else {
			break
		}
	}
	return enqueued
}

// BatchDequeue removes multiple items efficiently
func (mpq *MultiProducerQueue) BatchDequeue(maxItems int) []interface{} {
	items := make([]interface{}, 0, maxItems)
	for i := 0; i < maxItems; i++ {
		item := mpq.Dequeue()
		if item == nil {
			break
		}
		items = append(items, item)
	}
	return items
}

// Helper function to find next power of two
func nextPowerOfTwo(n uint64) uint64 {
	n--
	n |= n >> 1
	n |= n >> 2
	n |= n >> 4
	n |= n >> 8
	n |= n >> 16
	n |= n >> 32
	n++
	return n
}

// SPSCQueue implements a Single Producer Single Consumer lock-free queue
// Optimized for scenarios where there's only one producer and one consumer
type SPSCQueue struct {
	buffer    []interface{}
	head      atomic.Uint64
	tail      atomic.Uint64
	size      uint64
	mask      uint64
	cachePad1 [64]byte // Cache line padding
	cachePad2 [64]byte
}

// NewSPSCQueue creates a new SPSC queue
func NewSPSCQueue(size uint64) *SPSCQueue {
	if size&(size-1) != 0 {
		size = nextPowerOfTwo(size)
	}
	
	return &SPSCQueue{
		buffer: make([]interface{}, size),
		size:   size,
		mask:   size - 1,
	}
}

// Enqueue adds an item (called by producer only)
func (q *SPSCQueue) Enqueue(item interface{}) bool {
	tail := q.tail.Load()
	head := q.head.Load()
	
	if tail-head >= q.size {
		return false
	}
	
	q.buffer[tail&q.mask] = item
	q.tail.Store(tail + 1)
	return true
}

// Dequeue removes an item (called by consumer only)
func (q *SPSCQueue) Dequeue() interface{} {
	head := q.head.Load()
	tail := q.tail.Load()
	
	if head >= tail {
		return nil
	}
	
	item := q.buffer[head&q.mask]
	q.buffer[head&q.mask] = nil // Help GC
	q.head.Store(head + 1)
	return item
}