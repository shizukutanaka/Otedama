package optimization

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
	
	"go.uber.org/zap"
)

// MemoryOptimizer はメモリ最適化マネージャー
type MemoryOptimizer struct {
	bufferPools     map[int]*BufferPool
	zeroCopyManager *ZeroCopyManager
	gcController    *GCController
	logger          *zap.Logger
	stats           *MemoryStats
	hotPathPools    *HotPathPools
	mu              sync.RWMutex
}

// MemoryStats はメモリ統計
type MemoryStats struct {
	allocations     atomic.Uint64
	deallocations   atomic.Uint64
	poolHits        atomic.Uint64
	poolMisses      atomic.Uint64
	gcRuns          atomic.Uint64
	peakMemory      atomic.Uint64
}

// HotPathPools はホットパス用の専用プール
type HotPathPools struct {
	hashBuffers    sync.Pool
	nonceBuffers   sync.Pool
	shareBuffers   sync.Pool
	jobBuffers     sync.Pool
	messageBuffers sync.Pool
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
func NewMemoryOptimizer(logger *zap.Logger) *MemoryOptimizer {
	mo := &MemoryOptimizer{
		bufferPools:     make(map[int]*BufferPool),
		zeroCopyManager: NewZeroCopyManager(),
		logger:          logger,
		stats:           &MemoryStats{},
		hotPathPools:    NewHotPathPools(),
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

// NewHotPathPools はホットパス用プールを作成
func NewHotPathPools() *HotPathPools {
	return &HotPathPools{
		hashBuffers: sync.Pool{
			New: func() interface{} {
				return make([]byte, 32) // SHA256サイズ
			},
		},
		nonceBuffers: sync.Pool{
			New: func() interface{} {
				return make([]byte, 8) // 64bit nonce
			},
		},
		shareBuffers: sync.Pool{
			New: func() interface{} {
				return make([]byte, 80) // 標準シェアサイズ
			},
		},
		jobBuffers: sync.Pool{
			New: func() interface{} {
				return make([]byte, 128) // ジョブデータサイズ
			},
		},
		messageBuffers: sync.Pool{
			New: func() interface{} {
				return make([]byte, 4096) // ネットワークメッセージサイズ
			},
		},
	}
}

// GetHashBuffer はハッシュ用バッファを取得（ホットパス最適化）
func (mo *MemoryOptimizer) GetHashBuffer() []byte {
	buf := mo.hotPathPools.hashBuffers.Get().([]byte)
	mo.stats.poolHits.Add(1)
	return buf
}

// PutHashBuffer はハッシュ用バッファを返却
func (mo *MemoryOptimizer) PutHashBuffer(buf []byte) {
	if len(buf) == 32 {
		// バッファをクリア（セキュリティ上の理由）
		for i := range buf {
			buf[i] = 0
		}
		mo.hotPathPools.hashBuffers.Put(buf)
	}
}

// GetNonceBuffer はNonce用バッファを取得
func (mo *MemoryOptimizer) GetNonceBuffer() []byte {
	buf := mo.hotPathPools.nonceBuffers.Get().([]byte)
	mo.stats.poolHits.Add(1)
	return buf
}

// PutNonceBuffer はNonce用バッファを返却
func (mo *MemoryOptimizer) PutNonceBuffer(buf []byte) {
	if len(buf) == 8 {
		mo.hotPathPools.nonceBuffers.Put(buf)
	}
}

// GetShareBuffer はシェア用バッファを取得
func (mo *MemoryOptimizer) GetShareBuffer() []byte {
	buf := mo.hotPathPools.shareBuffers.Get().([]byte)
	mo.stats.poolHits.Add(1)
	return buf
}

// PutShareBuffer はシェア用バッファを返却
func (mo *MemoryOptimizer) PutShareBuffer(buf []byte) {
	if len(buf) == 80 {
		mo.hotPathPools.shareBuffers.Put(buf)
	}
}

// GetJobBuffer はジョブ用バッファを取得
func (mo *MemoryOptimizer) GetJobBuffer() []byte {
	buf := mo.hotPathPools.jobBuffers.Get().([]byte)
	mo.stats.poolHits.Add(1)
	return buf
}

// PutJobBuffer はジョブ用バッファを返却
func (mo *MemoryOptimizer) PutJobBuffer(buf []byte) {
	if len(buf) == 128 {
		mo.hotPathPools.jobBuffers.Put(buf)
	}
}

// GetMessageBuffer はメッセージ用バッファを取得
func (mo *MemoryOptimizer) GetMessageBuffer() []byte {
	buf := mo.hotPathPools.messageBuffers.Get().([]byte)
	mo.stats.poolHits.Add(1)
	return buf
}

// PutMessageBuffer はメッセージ用バッファを返却
func (mo *MemoryOptimizer) PutMessageBuffer(buf []byte) {
	if len(buf) == 4096 {
		mo.hotPathPools.messageBuffers.Put(buf)
	}
}

// OptimizeHotPath はホットパスの最適化を実行
func (mo *MemoryOptimizer) OptimizeHotPath() {
	mo.logger.Info("Optimizing hot paths for memory allocation")
	
	// GCの最適化
	mo.gcController.SetGCPercent(50) // より積極的なGC
	
	// プールの事前ウォームアップ
	mo.warmupPools()
	
	// 統計監視開始
	go mo.monitorStats()
}

// warmupPools はプールを事前にウォームアップ
func (mo *MemoryOptimizer) warmupPools() {
	warmupCount := 100
	
	// ハッシュバッファの事前作成
	hashBuffers := make([][]byte, warmupCount)
	for i := 0; i < warmupCount; i++ {
		hashBuffers[i] = mo.GetHashBuffer()
	}
	for _, buf := range hashBuffers {
		mo.PutHashBuffer(buf)
	}
	
	// 他のプールも同様にウォームアップ
	nonceBuffers := make([][]byte, warmupCount)
	for i := 0; i < warmupCount; i++ {
		nonceBuffers[i] = mo.GetNonceBuffer()
	}
	for _, buf := range nonceBuffers {
		mo.PutNonceBuffer(buf)
	}
	
	mo.logger.Debug("Pool warmup completed", zap.Int("warmup_count", warmupCount))
}

// monitorStats は統計を監視
func (mo *MemoryOptimizer) monitorStats() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		stats := mo.GetOptimizedStats()
		
		mo.logger.Debug("Memory optimization stats",
			zap.Uint64("pool_hits", stats["pool_hits"].(uint64)),
			zap.Uint64("pool_misses", stats["pool_misses"].(uint64)),
			zap.Float64("hit_ratio", stats["hit_ratio"].(float64)),
			zap.Uint64("peak_memory", stats["peak_memory"].(uint64)),
		)
		
		// メモリ圧迫の検出と対応
		if stats["heap_inuse_percent"].(float64) > 80.0 {
			mo.logger.Warn("High memory pressure detected, forcing cleanup")
			mo.forceCleanup()
		}
	}
}

// forceCleanup は強制クリーンアップを実行
func (mo *MemoryOptimizer) forceCleanup() {
	// 複数回のGC実行
	runtime.GC()
	runtime.GC()
	
	// 統計更新
	mo.stats.gcRuns.Add(1)
	
	mo.logger.Info("Forced memory cleanup completed")
}

// GetOptimizedStats は最適化統計を取得
func (mo *MemoryOptimizer) GetOptimizedStats() map[string]interface{} {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	// ピークメモリ使用量を更新
	current := memStats.Alloc
	for {
		peak := mo.stats.peakMemory.Load()
		if current <= peak || mo.stats.peakMemory.CompareAndSwap(peak, current) {
			break
		}
	}
	
	poolHits := mo.stats.poolHits.Load()
	poolMisses := mo.stats.poolMisses.Load()
	total := poolHits + poolMisses
	hitRatio := 0.0
	if total > 0 {
		hitRatio = float64(poolHits) / float64(total) * 100
	}
	
	return map[string]interface{}{
		// Runtime stats
		"alloc_bytes":         memStats.Alloc,
		"heap_sys":            memStats.HeapSys,
		"heap_inuse":          memStats.HeapInuse,
		"heap_inuse_percent":  float64(memStats.HeapInuse) / float64(memStats.HeapSys) * 100,
		"num_gc":              memStats.NumGC,
		"gc_cpu_fraction":     memStats.GCCPUFraction,
		
		// Custom stats
		"allocations":   mo.stats.allocations.Load(),
		"deallocations": mo.stats.deallocations.Load(),
		"pool_hits":     poolHits,
		"pool_misses":   poolMisses,
		"hit_ratio":     hitRatio,
		"peak_memory":   mo.stats.peakMemory.Load(),
		"gc_runs":       mo.stats.gcRuns.Load(),
	}
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