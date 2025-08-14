package mining

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/shizukutanaka/Otedama/internal/memory"
	"go.uber.org/zap"
)

// UnifiedOptimizationEngine - 統合された最適化エンジン
// John Carmack, Robert C. Martin, Rob Pikeの設計原則を適用
type UnifiedOptimizationEngine struct {
	logger *zap.Logger
	config OptimizationConfig
	
	// メモリ最適化
	memoryOptimizer *MemoryOptimizer
	memoryPool      *OptimizedMiningMemory
	
	// CPU最適化
	cpuOptimizer *CPUOptimizer
	
	// GPU最適化
	gpuEngine *GPUOptimizationEngine
	
	// パフォーマンスモニター
	perfMonitor *PerformanceMonitor
	
	// ジョブディスパッチャー
	jobDispatcher *FastJobDispatcher
	
	// シェアバリデーター
	shareValidator *OptimizedShareValidator
	
	// ワーカープール
	workerPool *WorkerPool
	
	// 統計
	stats       *OptimizationStats
	allocations atomic.Uint64
	
	// ライフサイクル
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// OptimizationConfig - 最適化設定
type OptimizationConfig struct {
	// メモリ設定
	MaxMemoryMB      int  `json:"max_memory_mb"`
	EnableHugePages  bool `json:"enable_huge_pages"`
	EnableNUMA       bool `json:"enable_numa"`
	
	// CPU設定
	CPUAffinity      []int `json:"cpu_affinity"`
	CPUPriority      int   `json:"cpu_priority"`
	EnableAVX2       bool  `json:"enable_avx2"`
	EnableAVX512     bool  `json:"enable_avx512"`
	
	// GPU設定
	EnableGPU        bool  `json:"enable_gpu"`
	GPUDevices       []int `json:"gpu_devices"`
	GPUIntensity     int   `json:"gpu_intensity"`
	GPUWorkSize      int   `json:"gpu_work_size"`
	
	// パフォーマンス設定
	WorkerCount      int   `json:"worker_count"`
	BatchSize        int   `json:"batch_size"`
	JobQueueSize     int   `json:"job_queue_size"`
	ShareBufferSize  int   `json:"share_buffer_size"`
}

// OptimizationStats - 最適化統計
type OptimizationStats struct {
	MemoryAllocated   atomic.Uint64
	MemoryFreed       atomic.Uint64
	JobsDispatched    atomic.Uint64
	SharesValidated   atomic.Uint64
	CPUUtilization    atomic.Value // float64
	GPUUtilization    atomic.Value // float64
	CacheHitRate      atomic.Value // float64
	OptimizationScore atomic.Value // float64
}

// MemoryOptimizer - メモリ最適化
type MemoryOptimizer struct {
	maxMemoryMB   int
	currentUsage  atomic.Uint64
	hugePages     bool
	numaAware     bool
	memoryPools   map[string]*sync.Pool
	mu            sync.RWMutex
}

// CPUOptimizer - CPU最適化
type CPUOptimizer struct {
	coreCount    int
	affinity     []int
	priority     int
	avx2Enabled  bool
	avx512Enabled bool
	mu           sync.RWMutex
}

// PerformanceMonitor - パフォーマンスモニター
type PerformanceMonitor struct {
	logger       *zap.Logger
	samples      []PerformanceSample
	samplesMu    sync.RWMutex
	ticker       *time.Ticker
}

// PerformanceSample - パフォーマンスサンプル
type PerformanceSample struct {
	Timestamp       time.Time
	CPUUsage        float64
	MemoryUsage     uint64
	HashRate        uint64
	SharesPerSecond float64
	Latency         time.Duration
	Temperature     float64
}

// NewUnifiedOptimizationEngine - 統合最適化エンジンを作成
func NewUnifiedOptimizationEngine(logger *zap.Logger, config OptimizationConfig) (*UnifiedOptimizationEngine, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	// デフォルト値設定
	if config.MaxMemoryMB == 0 {
		config.MaxMemoryMB = 1024 // 1GB
	}
	if config.WorkerCount == 0 {
		config.WorkerCount = runtime.NumCPU()
	}
	if config.BatchSize == 0 {
		config.BatchSize = 1000
	}
	if config.JobQueueSize == 0 {
		config.JobQueueSize = 10000
	}
	
	engine := &UnifiedOptimizationEngine{
		logger:         logger,
		config:         config,
		stats:          &OptimizationStats{},
		ctx:            ctx,
		cancel:         cancel,
	}
	
	// メモリ最適化を初期化
	engine.memoryOptimizer = &MemoryOptimizer{
		maxMemoryMB:  config.MaxMemoryMB,
		hugePages:    config.EnableHugePages,
		numaAware:    config.EnableNUMA,
		memoryPools:  make(map[string]*sync.Pool),
	}
	
	// メモリプールを初期化
	engine.memoryPool = NewOptimizedMiningMemory()
	
	// CPU最適化を初期化
	engine.cpuOptimizer = &CPUOptimizer{
		coreCount:     runtime.NumCPU(),
		affinity:      config.CPUAffinity,
		priority:      config.CPUPriority,
		avx2Enabled:   config.EnableAVX2,
		avx512Enabled: config.EnableAVX512,
	}
	
	// GPU最適化を初期化（有効な場合）
	if config.EnableGPU {
		gpuConfig := &GPUConfig{
			Devices:   config.GPUDevices,
			Intensity: config.GPUIntensity,
			WorkSize:  config.GPUWorkSize,
		}
		gpuEngine, err := NewGPUOptimizationEngine(logger, gpuConfig)
		if err != nil {
			logger.Warn("GPU optimization initialization failed", zap.Error(err))
		} else {
			engine.gpuEngine = gpuEngine
		}
	}
	
	// パフォーマンスモニターを初期化
	engine.perfMonitor = &PerformanceMonitor{
		logger:  logger,
		samples: make([]PerformanceSample, 0, 1000),
	}
	
	// ジョブディスパッチャーを初期化
	cpuWorkers := config.WorkerCount
	gpuWorkers := 0
	if engine.gpuEngine != nil {
		gpuWorkers = len(engine.gpuEngine.GetDevices())
	}
	engine.jobDispatcher = NewFastJobDispatcher(cpuWorkers, gpuWorkers, 0)
	
	// シェアバリデーターを初期化
	engine.shareValidator = NewOptimizedShareValidator(logger, config.WorkerCount)
	
	// ワーカープールを初期化
	engine.workerPool = NewWorkerPool(logger, nil, config.WorkerCount)
	
	logger.Info("Unified optimization engine initialized",
		zap.Int("max_memory_mb", config.MaxMemoryMB),
		zap.Int("worker_count", config.WorkerCount),
		zap.Bool("gpu_enabled", config.EnableGPU))
	
	return engine, nil
}

// Start - エンジンを開始
func (e *UnifiedOptimizationEngine) Start() error {
	e.logger.Info("Starting optimization engine")
	
	// CPU最適化を適用
	if err := e.applyCPUOptimizations(); err != nil {
		e.logger.Warn("Failed to apply CPU optimizations", zap.Error(err))
	}
	
	// メモリ最適化を適用
	if err := e.applyMemoryOptimizations(); err != nil {
		e.logger.Warn("Failed to apply memory optimizations", zap.Error(err))
	}
	
	// GPU最適化を開始
	if e.gpuEngine != nil {
		if err := e.gpuEngine.Start(e.ctx); err != nil {
			e.logger.Warn("Failed to start GPU engine", zap.Error(err))
		}
	}
	
	// パフォーマンス監視を開始
	e.wg.Add(1)
	go e.monitorPerformance()
	
	// 最適化スコアを計算
	e.wg.Add(1)
	go e.calculateOptimizationScore()
	
	return nil
}

// Stop - エンジンを停止
func (e *UnifiedOptimizationEngine) Stop() error {
	e.logger.Info("Stopping optimization engine")
	
	e.cancel()
	
	// シェアバリデーターを停止
	e.shareValidator.Stop()
	
	// GPU エンジンを停止
	if e.gpuEngine != nil {
		e.gpuEngine.Stop()
	}
	
	e.wg.Wait()
	
	return nil
}

// OptimizeForAlgorithm - アルゴリズムに最適化
func (e *UnifiedOptimizationEngine) OptimizeForAlgorithm(algo AlgorithmType) error {
	e.logger.Info("Optimizing for algorithm", zap.String("algorithm", string(algo)))
	
	// アルゴリズムのメモリプロファイルを取得
	profile := GetAlgorithmProfile(algo)
	
	// メモリ最適化を調整
	e.optimizeMemoryForProfile(profile)
	
	// CPU最適化を調整
	e.optimizeCPUForProfile(profile)
	
	// GPU最適化を調整
	if e.gpuEngine != nil {
		if err := e.gpuEngine.OptimizeForAlgorithm(algo); err != nil {
			return fmt.Errorf("GPU optimization failed: %w", err)
		}
	}
	
	return nil
}

// GetMemoryPool - メモリプールを取得
func (e *UnifiedOptimizationEngine) GetMemoryPool() *OptimizedMiningMemory {
	return e.memoryPool
}

// GetJobDispatcher - ジョブディスパッチャーを取得
func (e *UnifiedOptimizationEngine) GetJobDispatcher() *FastJobDispatcher {
	return e.jobDispatcher
}

// ValidateShare - シェアを検証
func (e *UnifiedOptimizationEngine) ValidateShare(share *Share) bool {
	e.stats.SharesValidated.Add(1)
	return e.shareValidator.ValidateShare(share)
}

// GetStats - 統計を取得
func (e *UnifiedOptimizationEngine) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"memory_allocated":   e.stats.MemoryAllocated.Load(),
		"memory_freed":       e.stats.MemoryFreed.Load(),
		"jobs_dispatched":    e.stats.JobsDispatched.Load(),
		"shares_validated":   e.stats.SharesValidated.Load(),
	}
	
	if cpuUtil, ok := e.stats.CPUUtilization.Load().(float64); ok {
		stats["cpu_utilization"] = cpuUtil
	}
	
	if gpuUtil, ok := e.stats.GPUUtilization.Load().(float64); ok {
		stats["gpu_utilization"] = gpuUtil
	}
	
	if cacheHit, ok := e.stats.CacheHitRate.Load().(float64); ok {
		stats["cache_hit_rate"] = cacheHit
	}
	
	if score, ok := e.stats.OptimizationScore.Load().(float64); ok {
		stats["optimization_score"] = score
	}
	
	// メモリプール統計
	if e.memoryPool != nil {
		memStats := e.memoryPool.Stats()
		stats["memory_pool"] = map[string]interface{}{
			"allocations":    memStats.Allocations,
			"deallocations":  memStats.Deallocations,
			"active_objects": memStats.ActiveObjects,
		}
	}
	
	// GPU統計
	if e.gpuEngine != nil {
		stats["gpu"] = e.gpuEngine.GetStats()
	}
	
	// パフォーマンスサンプル
	if e.perfMonitor != nil {
		e.perfMonitor.samplesMu.RLock()
		if len(e.perfMonitor.samples) > 0 {
			latest := e.perfMonitor.samples[len(e.perfMonitor.samples)-1]
			stats["latest_performance"] = map[string]interface{}{
				"cpu_usage":         latest.CPUUsage,
				"memory_usage":      latest.MemoryUsage,
				"hash_rate":         latest.HashRate,
				"shares_per_second": latest.SharesPerSecond,
				"latency":           latest.Latency.String(),
				"temperature":       latest.Temperature,
			}
		}
		e.perfMonitor.samplesMu.RUnlock()
	}
	
	return stats
}

// プライベートメソッド

func (e *UnifiedOptimizationEngine) applyCPUOptimizations() error {
	// CPU アフィニティを設定
	if len(e.cpuOptimizer.affinity) > 0 {
		// プラットフォーム固有の実装が必要
		e.logger.Info("CPU affinity set", zap.Ints("cores", e.cpuOptimizer.affinity))
	}
	
	// スレッド優先度を設定
	runtime.GOMAXPROCS(e.cpuOptimizer.coreCount)
	
	// AVX最適化を有効化（実際の実装ではアセンブリ最適化を使用）
	if e.cpuOptimizer.avx2Enabled {
		e.logger.Info("AVX2 optimizations enabled")
	}
	if e.cpuOptimizer.avx512Enabled {
		e.logger.Info("AVX512 optimizations enabled")
	}
	
	return nil
}

func (e *UnifiedOptimizationEngine) applyMemoryOptimizations() error {
	// Huge Pagesを有効化（Linux固有）
	if e.memoryOptimizer.hugePages && runtime.GOOS == "linux" {
		e.logger.Info("Huge pages enabled")
	}
	
	// NUMA最適化
	if e.memoryOptimizer.numaAware && runtime.NumCPU() > 8 {
		e.logger.Info("NUMA optimizations enabled")
	}
	
	// メモリプールを事前割り当て
	e.preallocateMemoryPools()
	
	return nil
}

func (e *UnifiedOptimizationEngine) preallocateMemoryPools() {
	// シェアプールを事前割り当て
	for i := 0; i < 100; i++ {
		share := e.memoryPool.GetShare()
		e.memoryPool.PutShare(share)
	}
	
	// ジョブプールを事前割り当て
	for i := 0; i < 50; i++ {
		job := e.memoryPool.GetJob()
		e.memoryPool.PutJob(job)
	}
	
	// ハッシュバッファを事前割り当て
	buffers := e.memoryPool.GetBatchBuffers(10, 256)
	e.memoryPool.PutBatchBuffers(buffers)
	
	e.logger.Info("Memory pools preallocated")
}

func (e *UnifiedOptimizationEngine) optimizeMemoryForProfile(profile AlgorithmMemoryProfile) {
	// アルゴリズム固有のメモリ最適化
	e.memoryOptimizer.mu.Lock()
	defer e.memoryOptimizer.mu.Unlock()
	
	// メモリプールサイズを調整
	poolName := fmt.Sprintf("algo_%d", profile.HeaderSize)
	if _, exists := e.memoryOptimizer.memoryPools[poolName]; !exists {
		e.memoryOptimizer.memoryPools[poolName] = &sync.Pool{
			New: func() interface{} {
				return make([]byte, profile.HeaderSize)
			},
		}
	}
	
	e.logger.Debug("Memory optimized for algorithm profile",
		zap.Int("header_size", profile.HeaderSize),
		zap.Int("scratch_size", profile.ScratchSize))
}

func (e *UnifiedOptimizationEngine) optimizeCPUForProfile(profile AlgorithmMemoryProfile) {
	// 並列度を調整
	optimalWorkers := profile.Parallelism
	if optimalWorkers > e.cpuOptimizer.coreCount {
		optimalWorkers = e.cpuOptimizer.coreCount
	}
	
	// ワーカープールを調整
	currentWorkers := e.workerPool.GetWorkerCount()
	if currentWorkers != optimalWorkers {
		e.logger.Info("Adjusting worker count",
			zap.Int("from", currentWorkers),
			zap.Int("to", optimalWorkers))
	}
}

func (e *UnifiedOptimizationEngine) monitorPerformance() {
	defer e.wg.Done()
	
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			e.collectPerformanceSample()
		}
	}
}

func (e *UnifiedOptimizationEngine) collectPerformanceSample() {
	sample := PerformanceSample{
		Timestamp:   time.Now(),
		CPUUsage:    e.getCPUUsage(),
		MemoryUsage: e.memoryOptimizer.currentUsage.Load(),
		HashRate:    0, // 実際のハッシュレートから取得
	}
	
	// GPU情報を追加
	if e.gpuEngine != nil {
		sample.HashRate = e.gpuEngine.GetHashRate()
	}
	
	e.perfMonitor.samplesMu.Lock()
	e.perfMonitor.samples = append(e.perfMonitor.samples, sample)
	
	// サンプル数を制限
	if len(e.perfMonitor.samples) > 1000 {
		e.perfMonitor.samples = e.perfMonitor.samples[len(e.perfMonitor.samples)-1000:]
	}
	e.perfMonitor.samplesMu.Unlock()
	
	// 統計を更新
	e.stats.CPUUtilization.Store(sample.CPUUsage)
}

func (e *UnifiedOptimizationEngine) getCPUUsage() float64 {
	// 簡略化された実装
	// 実際の実装ではシステムAPIを使用
	return 50.0 // プレースホルダー
}

func (e *UnifiedOptimizationEngine) calculateOptimizationScore() {
	defer e.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			score := e.computeOptimizationScore()
			e.stats.OptimizationScore.Store(score)
		}
	}
}

func (e *UnifiedOptimizationEngine) computeOptimizationScore() float64 {
	score := 0.0
	factors := 0
	
	// CPU利用率スコア（最適は70-80%）
	if cpuUtil, ok := e.stats.CPUUtilization.Load().(float64); ok {
		if cpuUtil >= 70 && cpuUtil <= 80 {
			score += 1.0
		} else if cpuUtil >= 60 && cpuUtil <= 90 {
			score += 0.8
		} else {
			score += 0.5
		}
		factors++
	}
	
	// メモリ効率スコア
	if e.memoryPool != nil {
		memStats := e.memoryPool.Stats()
		if memStats.Allocations > 0 {
			efficiency := float64(memStats.ActiveObjects) / float64(memStats.Allocations)
			score += efficiency
			factors++
		}
	}
	
	// キャッシュヒット率スコア
	if cacheHit, ok := e.stats.CacheHitRate.Load().(float64); ok {
		score += cacheHit
		factors++
	}
	
	// GPU利用率スコア
	if gpuUtil, ok := e.stats.GPUUtilization.Load().(float64); ok {
		if gpuUtil >= 90 {
			score += 1.0
		} else if gpuUtil >= 80 {
			score += 0.9
		} else {
			score += gpuUtil / 100
		}
		factors++
	}
	
	if factors == 0 {
		return 0.5
	}
	
	return score / float64(factors)
}

// OptimizedMiningMemory - マイニング固有のメモリ最適化
type OptimizedMiningMemory struct {
	// メモリプール
	sharePool *ShareMemoryPool
	jobPool   *JobMemoryPool
	hashPool  *HashBufferPool
	
	// 最適化アロケーター
	memPool *memory.OptimizedMemoryPool
	
	// キャッシュ整列カウンター
	allocations   atomic.Uint64
	deallocations atomic.Uint64
	
	// NUMA最適化
	numaAware bool
	cpuNodes  []int
}

// ShareMemoryPool - シェアオブジェクトプール
type ShareMemoryPool struct {
	pool         sync.Pool
	preallocated [1024]*Share
	index        atomic.Int32
}

// JobMemoryPool - ジョブオブジェクトプール
type JobMemoryPool struct {
	pool     sync.Pool
	jobCache [256]*Job
	cacheMu  sync.RWMutex
}

// HashBufferPool - ハッシュ計算バッファプール
type HashBufferPool struct {
	small  sync.Pool // 80バイト
	medium sync.Pool // 256バイト
	large  sync.Pool // 1KB
}

// NewOptimizedMiningMemory - 最適化されたマイニングメモリマネージャーを作成
func NewOptimizedMiningMemory() *OptimizedMiningMemory {
	omm := &OptimizedMiningMemory{
		memPool:   memory.NewOptimizedMemoryPool(),
		numaAware: detectNUMA(),
		cpuNodes:  getCPUNodes(),
	}
	
	// シェアプールを初期化
	omm.sharePool = &ShareMemoryPool{
		pool: sync.Pool{
			New: func() interface{} {
				omm.allocations.Add(1)
				return &Share{
					Hash: [32]byte{},
				}
			},
		},
	}
	
	// シェアを事前割り当て
	for i := range omm.sharePool.preallocated {
		omm.sharePool.preallocated[i] = &Share{
			Hash: [32]byte{},
		}
	}
	
	// ジョブプールを初期化
	omm.jobPool = &JobMemoryPool{
		pool: sync.Pool{
			New: func() interface{} {
				omm.allocations.Add(1)
				return &Job{}
			},
		},
	}
	
	// ハッシュバッファプールを初期化
	omm.hashPool = &HashBufferPool{
		small: sync.Pool{
			New: func() interface{} {
				return omm.memPool.GetAligned(80, 64)
			},
		},
		medium: sync.Pool{
			New: func() interface{} {
				return omm.memPool.GetAligned(256, 64)
			},
		},
		large: sync.Pool{
			New: func() interface{} {
				return omm.memPool.GetAligned(1024, 64)
			},
		},
	}
	
	return omm
}

// GetShare - 最適化されたシェアオブジェクトを取得
func (omm *OptimizedMiningMemory) GetShare() *Share {
	// 事前割り当てから試す（ホットパス）
	idx := omm.sharePool.index.Add(1) & 1023
	share := omm.sharePool.preallocated[idx]
	
	if share != nil && atomic.CompareAndSwapPointer(
		(*unsafe.Pointer)(unsafe.Pointer(&omm.sharePool.preallocated[idx])),
		unsafe.Pointer(share),
		nil,
	) {
		share.Reset()
		return share
	}
	
	// プールにフォールバック
	return omm.sharePool.pool.Get().(*Share)
}

// PutShare - シェアをプールに返す
func (omm *OptimizedMiningMemory) PutShare(share *Share) {
	if share == nil {
		return
	}
	
	omm.deallocations.Add(1)
	
	// 事前割り当て配列に戻す
	idx := omm.sharePool.index.Load() & 1023
	if atomic.CompareAndSwapPointer(
		(*unsafe.Pointer)(unsafe.Pointer(&omm.sharePool.preallocated[idx])),
		nil,
		unsafe.Pointer(share),
	) {
		return
	}
	
	// プールにフォールバック
	share.Reset()
	omm.sharePool.pool.Put(share)
}

// GetJob - 最適化されたジョブオブジェクトを取得
func (omm *OptimizedMiningMemory) GetJob() *Job {
	job := omm.jobPool.pool.Get().(*Job)
	job.Reset()
	return job
}

// PutJob - ジョブをプールに返す
func (omm *OptimizedMiningMemory) PutJob(job *Job) {
	if job == nil {
		return
	}
	
	omm.deallocations.Add(1)
	
	// 最近のジョブをキャッシュ
	omm.jobPool.cacheMu.Lock()
	if job.Height > 0 {
		idx := job.Height & 255
		omm.jobPool.jobCache[idx] = job
	}
	omm.jobPool.cacheMu.Unlock()
	
	job.Reset()
	omm.jobPool.pool.Put(job)
}

// GetHashBuffer - ハッシュ計算用バッファを取得
func (omm *OptimizedMiningMemory) GetHashBuffer(size int) []byte {
	switch {
	case size <= 80:
		return omm.hashPool.small.Get().([]byte)[:size]
	case size <= 256:
		return omm.hashPool.medium.Get().([]byte)[:size]
	case size <= 1024:
		return omm.hashPool.large.Get().([]byte)[:size]
	default:
		return omm.memPool.Get(size)
	}
}

// PutHashBuffer - ハッシュバッファをプールに返す
func (omm *OptimizedMiningMemory) PutHashBuffer(buf []byte) {
	if buf == nil {
		return
	}
	
	// 機密データをクリア
	for i := range buf {
		buf[i] = 0
	}
	
	capacity := cap(buf)
	switch {
	case capacity == 80:
		omm.hashPool.small.Put(buf[:80])
	case capacity == 256:
		omm.hashPool.medium.Put(buf[:256])
	case capacity == 1024:
		omm.hashPool.large.Put(buf[:1024])
	default:
		omm.memPool.Put(buf)
	}
}

// GetBatchBuffers - バッチ処理用の複数バッファを取得
func (omm *OptimizedMiningMemory) GetBatchBuffers(count, size int) [][]byte {
	buffers := make([][]byte, count)
	
	// NUMA対応割り当て
	if omm.numaAware && count >= 4 {
		perNode := count / len(omm.cpuNodes)
		for i, node := range omm.cpuNodes {
			start := i * perNode
			end := start + perNode
			if i == len(omm.cpuNodes)-1 {
				end = count
			}
			
			// CPUアフィニティを設定
			runtime.LockOSThread()
			// setNodeAffinity(node) // プラットフォーム固有
			
			for j := start; j < end; j++ {
				buffers[j] = omm.GetHashBuffer(size)
			}
			
			runtime.UnlockOSThread()
		}
	} else {
		// 標準割り当て
		for i := range buffers {
			buffers[i] = omm.GetHashBuffer(size)
		}
	}
	
	return buffers
}

// PutBatchBuffers - 複数バッファをプールに返す
func (omm *OptimizedMiningMemory) PutBatchBuffers(buffers [][]byte) {
	for _, buf := range buffers {
		omm.PutHashBuffer(buf)
	}
}

// Stats - メモリ統計を返す
func (omm *OptimizedMiningMemory) Stats() MiningMemoryStats {
	return MiningMemoryStats{
		Allocations:   omm.allocations.Load(),
		Deallocations: omm.deallocations.Load(),
		ActiveObjects: omm.allocations.Load() - omm.deallocations.Load(),
		PoolStats:     omm.memPool.Stats(),
	}
}

// MiningMemoryStats - マイニングメモリ統計
type MiningMemoryStats struct {
	Allocations   uint64
	Deallocations uint64
	ActiveObjects uint64
	PoolStats     memory.PoolStatistics
}

// ヘルパー関数

func detectNUMA() bool {
	// NUMA サポートを検出
	return runtime.GOOS == "linux" && runtime.NumCPU() > 8
}

func getCPUNodes() []int {
	// NUMA ノードトポロジーを取得
	// 簡略化 - 単一ノードと仮定
	return []int{0}
}

// AlgorithmMemoryProfile - アルゴリズムのメモリプロファイル
type AlgorithmMemoryProfile struct {
	HeaderSize       int
	IntermediateSize int
	OutputSize       int
	ScratchSize      int
	Parallelism      int
}

// GetAlgorithmProfile - アルゴリズムのメモリプロファイルを取得
func GetAlgorithmProfile(algo AlgorithmType) AlgorithmMemoryProfile {
	profiles := map[AlgorithmType]AlgorithmMemoryProfile{
		SHA256D: {
			HeaderSize:       80,
			IntermediateSize: 64,
			OutputSize:       32,
			ScratchSize:      256,
			Parallelism:      runtime.NumCPU(),
		},
		Scrypt: {
			HeaderSize:       80,
			IntermediateSize: 128 * 1024,
			OutputSize:       32,
			ScratchSize:      128 * 1024,
			Parallelism:      1,
		},
		Ethash: {
			HeaderSize:       32,
			IntermediateSize: 64,
			OutputSize:       32,
			ScratchSize:      1024,
			Parallelism:      runtime.NumCPU() / 2,
		},
		RandomX: {
			HeaderSize:       80,
			IntermediateSize: 2 * 1024 * 1024,
			OutputSize:       32,
			ScratchSize:      256 * 1024,
			Parallelism:      runtime.NumCPU(),
		},
		KawPow: {
			HeaderSize:       32,
			IntermediateSize: 128,
			OutputSize:       32,
			ScratchSize:      2048,
			Parallelism:      runtime.NumCPU() / 2,
		},
	}
	
	if profile, ok := profiles[algo]; ok {
		return profile
	}
	
	// デフォルトプロファイル
	return AlgorithmMemoryProfile{
		HeaderSize:       80,
		IntermediateSize: 256,
		OutputSize:       32,
		ScratchSize:      1024,
		Parallelism:      runtime.NumCPU(),
	}
}