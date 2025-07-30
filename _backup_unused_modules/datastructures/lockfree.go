package datastructures

import (
	"sync/atomic"
	"unsafe"
)

// Note: LockFreeQueue is defined in structures.go to avoid duplicate declarations

// LockFreeStack implements a lock-free LIFO stack
type LockFreeStack struct {
	top unsafe.Pointer
	_pad [128]byte // Padding to prevent false sharing
}

// NewLockFreeStack creates a new lock-free stack
func NewLockFreeStack() *LockFreeStack {
	return &LockFreeStack{}
}

// Push adds an item to the stack
func (s *LockFreeStack) Push(value interface{}) {
	n := &node{value: value}
	for {
		top := atomic.LoadPointer(&s.top)
		n.next = top
		if atomic.CompareAndSwapPointer(&s.top, top, unsafe.Pointer(n)) {
			break
		}
	}
}

// Pop removes and returns an item from the stack
func (s *LockFreeStack) Pop() (interface{}, bool) {
	for {
		top := (*node)(atomic.LoadPointer(&s.top))
		if top == nil {
			return nil, false
		}
		next := atomic.LoadPointer(&top.next)
		if atomic.CompareAndSwapPointer(&s.top, unsafe.Pointer(top), next) {
			return top.value, true
		}
	}
}

// AtomicCounter provides atomic counter operations
type AtomicCounter struct {
	value uint64
	_pad  [7]uint64 // Padding for cache line alignment
}

// NewAtomicCounter creates a new atomic counter
func NewAtomicCounter() *AtomicCounter {
	return &AtomicCounter{}
}

// Inc increments the counter
func (c *AtomicCounter) Inc() uint64 {
	return atomic.AddUint64(&c.value, 1)
}

// Dec decrements the counter
func (c *AtomicCounter) Dec() uint64 {
	return atomic.AddUint64(&c.value, ^uint64(0))
}

// Get returns the current value
func (c *AtomicCounter) Get() uint64 {
	return atomic.LoadUint64(&c.value)
}

// Set sets the counter to a specific value
func (c *AtomicCounter) Set(val uint64) {
	atomic.StoreUint64(&c.value, val)
}

// CompareAndSwap performs atomic CAS
func (c *AtomicCounter) CompareAndSwap(old, new uint64) bool {
	return atomic.CompareAndSwapUint64(&c.value, old, new)
}

// SeqLock provides sequential lock for readers/writers
type SeqLock struct {
	seq  uint64
	_pad [7]uint64 // Padding
}

// NewSeqLock creates a new sequential lock
func NewSeqLock() *SeqLock {
	return &SeqLock{}
}

// BeginWrite starts a write operation
func (s *SeqLock) BeginWrite() uint64 {
	seq := atomic.AddUint64(&s.seq, 1)
	// Memory barrier
	_ = atomic.LoadUint64(&s.seq)
	return seq
}

// EndWrite ends a write operation
func (s *SeqLock) EndWrite() {
	atomic.AddUint64(&s.seq, 1)
}

// BeginRead starts a read operation
func (s *SeqLock) BeginRead() uint64 {
	for {
		seq := atomic.LoadUint64(&s.seq)
		if seq&1 == 0 {
			return seq
		}
		// Writer in progress, spin
		for i := 0; i < 10; i++ {
			// Spin
		}
	}
}

// ValidateRead validates a read operation
func (s *SeqLock) ValidateRead(startSeq uint64) bool {
	// Memory barrier
	_ = atomic.LoadUint64(&s.seq)
	return atomic.LoadUint64(&s.seq) == startSeq
}

// SpinLock implements a simple spin lock
type SpinLock struct {
	flag uint32
	_pad [15]uint32 // Padding for cache line
}

// NewSpinLock creates a new spin lock
func NewSpinLock() *SpinLock {
	return &SpinLock{}
}

// Lock acquires the lock
func (s *SpinLock) Lock() {
	for !atomic.CompareAndSwapUint32(&s.flag, 0, 1) {
		// Spin with exponential backoff
		for i := 1; i < 128; i *= 2 {
			for j := 0; j < i; j++ {
				// Spin
			}
		}
	}
}

// Unlock releases the lock
func (s *SpinLock) Unlock() {
	atomic.StoreUint32(&s.flag, 0)
}

// TryLock attempts to acquire the lock without blocking
func (s *SpinLock) TryLock() bool {
	return atomic.CompareAndSwapUint32(&s.flag, 0, 1)
}

// lockFreeNode is used by MPSCQueue to avoid conflict with node in structures.go
type lockFreeNode struct {
	next unsafe.Pointer
	data interface{}
}

// MPSCQueue implements a multi-producer single-consumer queue
type MPSCQueue struct {
	head *lockFreeNode
	tail *lockFreeNode
	_pad [128]byte
}

// NewMPSCQueue creates a new MPSC queue
func NewMPSCQueue() *MPSCQueue {
	stub := &lockFreeNode{}
	return &MPSCQueue{
		head: stub,
		tail: stub,
	}
}

// Push adds an item to the queue (can be called from multiple threads)
func (q *MPSCQueue) Push(data interface{}) {
	n := &lockFreeNode{data: data}
	prev := (*lockFreeNode)(atomic.SwapPointer((*unsafe.Pointer)(unsafe.Pointer(&q.head)), unsafe.Pointer(n)))
	atomic.StorePointer(&prev.next, unsafe.Pointer(n))
}

// Pop removes an item from the queue (single consumer only)
func (q *MPSCQueue) Pop() (interface{}, bool) {
	tail := q.tail
	next := (*lockFreeNode)(atomic.LoadPointer(&tail.next))
	
	if next != nil {
		q.tail = next
		return next.data, true
	}
	
	return nil, false
}

// AtomicBitmap provides atomic bitmap operations
type AtomicBitmap struct {
	bits []uint64
	size int
}

// NewAtomicBitmap creates a new atomic bitmap
func NewAtomicBitmap(size int) *AtomicBitmap {
	words := (size + 63) / 64
	return &AtomicBitmap{
		bits: make([]uint64, words),
		size: size,
	}
}

// Set sets a bit atomically
func (b *AtomicBitmap) Set(index int) bool {
	if index < 0 || index >= b.size {
		return false
	}
	
	word := index / 64
	bit := uint64(1) << (index % 64)
	
	for {
		old := atomic.LoadUint64(&b.bits[word])
		if old&bit != 0 {
			return false // Already set
		}
		if atomic.CompareAndSwapUint64(&b.bits[word], old, old|bit) {
			return true
		}
	}
}

// Clear clears a bit atomically
func (b *AtomicBitmap) Clear(index int) bool {
	if index < 0 || index >= b.size {
		return false
	}
	
	word := index / 64
	bit := uint64(1) << (index % 64)
	
	for {
		old := atomic.LoadUint64(&b.bits[word])
		if old&bit == 0 {
			return false // Already clear
		}
		if atomic.CompareAndSwapUint64(&b.bits[word], old, old&^bit) {
			return true
		}
	}
}

// Test tests if a bit is set
func (b *AtomicBitmap) Test(index int) bool {
	if index < 0 || index >= b.size {
		return false
	}
	
	word := index / 64
	bit := uint64(1) << (index % 64)
	
	return atomic.LoadUint64(&b.bits[word])&bit != 0
}

// FindFirstClear finds the first clear bit
func (b *AtomicBitmap) FindFirstClear() int {
	for i := 0; i < len(b.bits); i++ {
		word := atomic.LoadUint64(&b.bits[i])
		if word != ^uint64(0) {
			// Found a word with at least one clear bit
			for j := 0; j < 64; j++ {
				if word&(1<<j) == 0 {
					index := i*64 + j
					if index < b.size {
						return index
					}
				}
			}
		}
	}
	return -1
}