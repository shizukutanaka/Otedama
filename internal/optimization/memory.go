package optimization

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

// MemoryOptimizer はメモリ最適化マネージャー
type MemoryOptimizer struct {
	bufferPools     map[int]*BufferPool
	zeroCopyManager *ZeroCopyManager
	gcController    *GCController
	mu              sync.RWMutex
}

// BufferPool はバッファプール
type BufferPool struct {
	pool      sync.Pool
	size      int
	allocated atomic.Int64
	reused    atomic.Int64
}

// ZeroCopyManager はゼロコピーマネージャー
type ZeroCopyManager struct {
	mappedRegions sync.Map
	pageSize      int
}

// GCController はGC制御
type GCController struct {
	targetPercent   int
	lastGC          atomic.Int64
	forceGCInterval int64
}

// Buffer は再利用可能バッファ
type Buffer struct {
	data []byte
	pool *BufferPool
}

// NewMemoryOptimizer は新しいメモリオプティマイザーを作成
func NewMemoryOptimizer() *MemoryOptimizer {
	mo := &MemoryOptimizer{
		bufferPools:     make(map[int]*BufferPool),
		zeroCopyManager: NewZeroCopyManager(),
		gcController:    NewGCController(),
	}
	
	// 一般的なバッファサイズのプールを事前作成
	commonSizes := []int{
		64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
	}
	
	for _, size := range commonSizes {
		mo.createBufferPool(size)
	}
	
	return mo
}

// createBufferPool はバッファプールを作成
func (mo *MemoryOptimizer) createBufferPool(size int) *BufferPool {
	bp := &BufferPool{
		size: size,
		pool: sync.Pool{
			New: func() interface{} {
				bp.allocated.Add(1)
				return &Buffer{
					data: make([]byte, size),
					pool: bp,
				}
			},
		},
	}
	
	mo.bufferPools[size] = bp
	return bp
}

// GetBuffer は指定サイズのバッファを取得
func (mo *MemoryOptimizer) GetBuffer(size int) *Buffer {
	mo.mu.RLock()
	
	// 最適なプールサイズを見つける
	poolSize := 0
	for ps := range mo.bufferPools {
		if ps >= size && (poolSize == 0 || ps < poolSize) {
			poolSize = ps
		}
	}
	
	pool, exists := mo.bufferPools[poolSize]
	mo.mu.RUnlock()
	
	if !exists {
		// プールが存在しない場合は作成
		mo.mu.Lock()
		pool = mo.createBufferPool(nextPowerOf2(size))
		mo.mu.Unlock()
	}
	
	buf := pool.pool.Get().(*Buffer)
	pool.reused.Add(1)
	
	// 必要なサイズにスライス
	buf.data = buf.data[:size]
	return buf
}

// PutBuffer はバッファを返却
func (mo *MemoryOptimizer) PutBuffer(buf *Buffer) {
	if buf == nil || buf.pool == nil {
		return
	}
	
	// バッファをクリア（セキュリティ対策）
	for i := range buf.data {
		buf.data[i] = 0
	}
	
	// 元のサイズに戻す
	buf.data = buf.data[:cap(buf.data)]
	
	buf.pool.pool.Put(buf)
}

// GetStats は統計情報を取得
func (mo *MemoryOptimizer) GetStats() map[string]interface{} {
	stats := make(map[string]interface{})
	
	mo.mu.RLock()
	defer mo.mu.RUnlock()
	
	poolStats := make(map[int]map[string]int64)
	for size, pool := range mo.bufferPools {
		poolStats[size] = map[string]int64{
			"allocated": pool.allocated.Load(),
			"reused":    pool.reused.Load(),
		}
	}
	
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	stats["buffer_pools"] = poolStats
	stats["heap_alloc"] = m.HeapAlloc
	stats["heap_sys"] = m.HeapSys
	stats["gc_count"] = m.NumGC
	stats["gc_cpu_fraction"] = m.GCCPUFraction
	
	return stats
}

// NewZeroCopyManager は新しいゼロコピーマネージャーを作成
func NewZeroCopyManager() *ZeroCopyManager {
	return &ZeroCopyManager{
		pageSize: 4096, // 標準的なページサイズ
	}
}

// AllocateAligned はアライメントされたメモリを割り当て
func (zcm *ZeroCopyManager) AllocateAligned(size int, alignment int) []byte {
	// アライメントを考慮したサイズ
	allocSize := size + alignment - 1
	
	// 割り当て
	raw := make([]byte, allocSize)
	
	// アライメント調整
	ptr := uintptr(unsafe.Pointer(&raw[0]))
	offset := alignment - int(ptr%uintptr(alignment))
	
	if offset == alignment {
		offset = 0
	}
	
	return raw[offset : offset+size]
}

// CopyUnsafe は高速アンセーフコピー
func (zcm *ZeroCopyManager) CopyUnsafe(dst, src []byte) int {
	if len(src) > len(dst) {
		panic("destination buffer too small")
	}
	
	// メモリバリア
	runtime.KeepAlive(dst)
	runtime.KeepAlive(src)
	
	// アンセーフコピー
	copy(dst, src)
	
	return len(src)
}

// StringToBytes は文字列をバイトスライスにゼロコピー変換
func (zcm *ZeroCopyManager) StringToBytes(s string) []byte {
	return unsafe.Slice(unsafe.StringData(s), len(s))
}

// BytesToString はバイトスライスを文字列にゼロコピー変換
func (zcm *ZeroCopyManager) BytesToString(b []byte) string {
	return unsafe.String(&b[0], len(b))
}

// NewGCController は新しいGCコントローラーを作成
func NewGCController() *GCController {
	gc := &GCController{
		targetPercent:   100,
		forceGCInterval: 60, // 60秒
	}
	
	// GCターゲット設定
	runtime.SetGCPercent(gc.targetPercent)
	
	// 定期的なGC実行
	go gc.periodicGC()
	
	return gc
}

// periodicGC は定期的にGCを実行
func (gc *GCController) periodicGC() {
	ticker := time.NewTicker(time.Duration(gc.forceGCInterval) * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		lastGC := gc.lastGC.Load()
		now := time.Now().Unix()
		
		if now-lastGC >= gc.forceGCInterval {
			runtime.GC()
			gc.lastGC.Store(now)
		}
	}
}

// SetGCPercent はGCパーセントを設定
func (gc *GCController) SetGCPercent(percent int) {
	gc.targetPercent = percent
	runtime.SetGCPercent(percent)
}

// ForceGC は強制的にGCを実行
func (gc *GCController) ForceGC() {
	runtime.GC()
	gc.lastGC.Store(time.Now().Unix())
}

// nextPowerOf2 は次の2の累乗を計算
func nextPowerOf2(n int) int {
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

// MemoryBarrier はメモリバリアを実行
func MemoryBarrier() {
	// Goではatomic操作が暗黙的にメモリバリアを提供
	var dummy int32
	atomic.AddInt32(&dummy, 0)
}

// Prefetch はデータをプリフェッチ（ヒント）
func Prefetch(addr unsafe.Pointer) {
	// Goでは明示的なプリフェッチ命令はないが、
	// コンパイラ最適化のヒントとして読み込みを行う
	_ = *(*byte)(addr)
}

// AlignedAlloc はアライメントされたメモリを割り当て
func AlignedAlloc(size, alignment int) []byte {
	if alignment <= 0 || (alignment&(alignment-1)) != 0 {
		panic("alignment must be a power of 2")
	}
	
	// オーバーアロケーション
	buf := make([]byte, size+alignment)
	
	// アライメント計算
	ptr := uintptr(unsafe.Pointer(&buf[0]))
	alignedPtr := (ptr + uintptr(alignment) - 1) &^ (uintptr(alignment) - 1)
	offset := int(alignedPtr - ptr)
	
	return buf[offset : offset+size]
}

// 定数
const (
	CacheLineSize = 64 // 一般的なCPUキャッシュラインサイズ
)

// CacheLinePad はキャッシュライン境界用パディング
type CacheLinePad [CacheLineSize]byte

// AtomicCounter はキャッシュライン境界に配置されたアトミックカウンター
type AtomicCounter struct {
	_pad0 CacheLinePad
	value atomic.Int64
	_pad1 CacheLinePad
}

// Inc はカウンターをインクリメント
func (ac *AtomicCounter) Inc() int64 {
	return ac.value.Add(1)
}

// Load は値を読み込み
func (ac *AtomicCounter) Load() int64 {
	return ac.value.Load()
}

// Store は値を保存
func (ac *AtomicCounter) Store(val int64) {
	ac.value.Store(val)
}