package datastructures

import (
	"sync"
	"sync/atomic"
	"unsafe"
)

// LockFreeQueue はロックフリーキュー実装
type LockFreeQueue struct {
	head unsafe.Pointer
	tail unsafe.Pointer
	_pad [128 - 2*unsafe.Sizeof(unsafe.Pointer(nil))%128]byte // CPUキャッシュライン境界
}

// node はキューノード
type node struct {
	value interface{}
	next  unsafe.Pointer
}

// NewLockFreeQueue は新しいロックフリーキューを作成
func NewLockFreeQueue() *LockFreeQueue {
	n := &node{}
	q := &LockFreeQueue{
		head: unsafe.Pointer(n),
		tail: unsafe.Pointer(n),
	}
	return q
}

// Enqueue はアイテムをキューに追加
func (q *LockFreeQueue) Enqueue(v interface{}) {
	n := &node{value: v}
	for {
		tail := (*node)(atomic.LoadPointer(&q.tail))
		next := (*node)(atomic.LoadPointer(&tail.next))
		
		if tail == (*node)(atomic.LoadPointer(&q.tail)) {
			if next == nil {
				if atomic.CompareAndSwapPointer(&tail.next, unsafe.Pointer(next), unsafe.Pointer(n)) {
					atomic.CompareAndSwapPointer(&q.tail, unsafe.Pointer(tail), unsafe.Pointer(n))
					break
				}
			} else {
				atomic.CompareAndSwapPointer(&q.tail, unsafe.Pointer(tail), unsafe.Pointer(next))
			}
		}
	}
}

// Dequeue はアイテムをキューから取り出す
func (q *LockFreeQueue) Dequeue() (interface{}, bool) {
	for {
		head := (*node)(atomic.LoadPointer(&q.head))
		tail := (*node)(atomic.LoadPointer(&q.tail))
		next := (*node)(atomic.LoadPointer(&head.next))
		
		if head == (*node)(atomic.LoadPointer(&q.head)) {
			if head == tail {
				if next == nil {
					return nil, false
				}
				atomic.CompareAndSwapPointer(&q.tail, unsafe.Pointer(tail), unsafe.Pointer(next))
			} else {
				v := next.value
				if atomic.CompareAndSwapPointer(&q.head, unsafe.Pointer(head), unsafe.Pointer(next)) {
					return v, true
				}
			}
		}
	}
}

// RingBuffer は高速リングバッファ実装
type RingBuffer struct {
	buffer   []interface{}
	capacity uint64
	_pad1    [128 - unsafe.Sizeof([]interface{}{})%128]byte
	head     atomic.Uint64
	_pad2    [128 - unsafe.Sizeof(atomic.Uint64{})%128]byte
	tail     atomic.Uint64
	_pad3    [128 - unsafe.Sizeof(atomic.Uint64{})%128]byte
}

// NewRingBuffer は新しいリングバッファを作成
func NewRingBuffer(capacity uint64) *RingBuffer {
	// 2の累乗に調整
	c := uint64(1)
	for c < capacity {
		c <<= 1
	}
	
	return &RingBuffer{
		buffer:   make([]interface{}, c),
		capacity: c,
	}
}

// Put はアイテムをバッファに追加
func (rb *RingBuffer) Put(item interface{}) bool {
	head := rb.head.Load()
	tail := rb.tail.Load()
	
	if head-tail >= rb.capacity {
		return false // バッファフル
	}
	
	rb.buffer[head&(rb.capacity-1)] = item
	rb.head.Add(1)
	return true
}

// Get はアイテムをバッファから取得
func (rb *RingBuffer) Get() (interface{}, bool) {
	head := rb.head.Load()
	tail := rb.tail.Load()
	
	if tail >= head {
		return nil, false // バッファ空
	}
	
	item := rb.buffer[tail&(rb.capacity-1)]
	rb.tail.Add(1)
	return item, true
}

// Size は現在のサイズを取得
func (rb *RingBuffer) Size() uint64 {
	return rb.head.Load() - rb.tail.Load()
}

// ObjectPool はオブジェクトプール実装
type ObjectPool struct {
	pool sync.Pool
	new  func() interface{}
}

// NewObjectPool は新しいオブジェクトプールを作成
func NewObjectPool(new func() interface{}) *ObjectPool {
	return &ObjectPool{
		pool: sync.Pool{
			New: new,
		},
		new: new,
	}
}

// Get はオブジェクトを取得
func (op *ObjectPool) Get() interface{} {
	return op.pool.Get()
}

// Put はオブジェクトを返却
func (op *ObjectPool) Put(x interface{}) {
	op.pool.Put(x)
}

// ConcurrentMap は並行安全マップ実装
type ConcurrentMap struct {
	shards    []*mapShard
	shardCount uint32
}

// mapShard はマップのシャード
type mapShard struct {
	items map[string]interface{}
	mu    sync.RWMutex
}

// NewConcurrentMap は新しい並行安全マップを作成
func NewConcurrentMap(shardCount int) *ConcurrentMap {
	if shardCount <= 0 {
		shardCount = 32
	}
	
	m := &ConcurrentMap{
		shards:     make([]*mapShard, shardCount),
		shardCount: uint32(shardCount),
	}
	
	for i := 0; i < shardCount; i++ {
		m.shards[i] = &mapShard{
			items: make(map[string]interface{}),
		}
	}
	
	return m
}

// getShard はキーに対応するシャードを取得
func (m *ConcurrentMap) getShard(key string) *mapShard {
	hash := fnvHash(key)
	return m.shards[hash%m.shardCount]
}

// Set は値を設定
func (m *ConcurrentMap) Set(key string, value interface{}) {
	shard := m.getShard(key)
	shard.mu.Lock()
	shard.items[key] = value
	shard.mu.Unlock()
}

// Get は値を取得
func (m *ConcurrentMap) Get(key string) (interface{}, bool) {
	shard := m.getShard(key)
	shard.mu.RLock()
	val, ok := shard.items[key]
	shard.mu.RUnlock()
	return val, ok
}

// Delete は値を削除
func (m *ConcurrentMap) Delete(key string) {
	shard := m.getShard(key)
	shard.mu.Lock()
	delete(shard.items, key)
	shard.mu.Unlock()
}

// Count は全アイテム数を取得
func (m *ConcurrentMap) Count() int {
	count := 0
	for _, shard := range m.shards {
		shard.mu.RLock()
		count += len(shard.items)
		shard.mu.RUnlock()
	}
	return count
}

// fnvHash はFNV-1aハッシュ関数
func fnvHash(key string) uint32 {
	hash := uint32(2166136261)
	const prime32 = uint32(16777619)
	for i := 0; i < len(key); i++ {
		hash ^= uint32(key[i])
		hash *= prime32
	}
	return hash
}

// MemoryBarrier はメモリバリア
func MemoryBarrier() {
	// Go のメモリモデルでは atomic 操作が暗黙的にメモリバリアを提供
	var dummy int32
	atomic.AddInt32(&dummy, 0)
}

// AtomicFloat64 はアトミック float64
type AtomicFloat64 struct {
	v uint64
}

// NewAtomicFloat64 は新しいアトミック float64 を作成
func NewAtomicFloat64(val float64) *AtomicFloat64 {
	a := &AtomicFloat64{}
	a.Store(val)
	return a
}

// Load は値を読み込む
func (a *AtomicFloat64) Load() float64 {
	return float64frombits(atomic.LoadUint64(&a.v))
}

// Store は値を保存
func (a *AtomicFloat64) Store(val float64) {
	atomic.StoreUint64(&a.v, float64bits(val))
}

// Add は値を加算
func (a *AtomicFloat64) Add(delta float64) float64 {
	for {
		old := a.Load()
		new := old + delta
		if a.CompareAndSwap(old, new) {
			return new
		}
	}
}

// CompareAndSwap は値を比較交換
func (a *AtomicFloat64) CompareAndSwap(old, new float64) bool {
	return atomic.CompareAndSwapUint64(&a.v, float64bits(old), float64bits(new))
}

// float64bits は float64 を uint64 に変換
func float64bits(f float64) uint64 {
	return *(*uint64)(unsafe.Pointer(&f))
}

// float64frombits は uint64 を float64 に変換
func float64frombits(b uint64) float64 {
	return *(*float64)(unsafe.Pointer(&b))
}