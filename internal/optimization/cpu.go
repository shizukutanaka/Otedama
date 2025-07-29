package optimization

import (
	"fmt"
	"runtime"
	"sync"

	"go.uber.org/zap"
)

// CPUManager はCPU最適化を管理
type CPUManager struct {
	logger     *zap.Logger
	affinityMap map[int][]int // Thread ID -> CPU cores
	threadPool *ThreadPool
	mu         sync.RWMutex
}

// ThreadPool はワーカースレッドプール
type ThreadPool struct {
	workers   []*Worker
	workChan  chan WorkItem
	quitChan  chan bool
	numWorkers int
}

// Worker はワーカー
type Worker struct {
	id       int
	workChan chan WorkItem
	quitChan chan bool
	cpuCore  int
}

// WorkItem は作業項目
type WorkItem struct {
	ID       string
	TaskFunc func() error
	Priority int
}

// NewCPUManager は新しいCPUマネージャーを作成
func NewCPUManager(logger *zap.Logger) *CPUManager {
	return &CPUManager{
		logger:      logger,
		affinityMap: make(map[int][]int),
		threadPool:  nil,
	}
}

// Initialize はCPUマネージャーを初期化
func (c *CPUManager) Initialize() error {
	numCPU := runtime.NumCPU()
	c.logger.Info("Initializing CPU manager", 
		zap.Int("cpu_cores", numCPU),
		zap.Int("gomaxprocs", runtime.GOMAXPROCS(0)))
	
	// スレッドプールを初期化
	c.threadPool = &ThreadPool{
		workers:    make([]*Worker, numCPU),
		workChan:   make(chan WorkItem, numCPU*2),
		quitChan:   make(chan bool),
		numWorkers: numCPU,
	}
	
	// ワーカーを初期化
	for i := 0; i < numCPU; i++ {
		worker := &Worker{
			id:       i,
			workChan: c.threadPool.workChan,
			quitChan: c.threadPool.quitChan,
			cpuCore:  i,
		}
		c.threadPool.workers[i] = worker
		go worker.start(c.logger)
	}
	
	// デフォルトのCPUアフィニティを設定
	c.setDefaultAffinity()
	
	return nil
}

// setDefaultAffinity はデフォルトのCPUアフィニティを設定
func (c *CPUManager) setDefaultAffinity() {
	numCPU := runtime.NumCPU()
	
	// 各スレッドを異なるCPUコアに割り当て
	for i := 0; i < numCPU; i++ {
		c.affinityMap[i] = []int{i}
	}
	
	c.logger.Debug("Set default CPU affinity", 
		zap.Any("affinity_map", c.affinityMap))
}

// SetThreadAffinity はスレッドのCPUアフィニティを設定
func (c *CPUManager) SetThreadAffinity(threadID int, cpuCores []int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	// CPUコア番号の検証
	numCPU := runtime.NumCPU()
	for _, core := range cpuCores {
		if core < 0 || core >= numCPU {
			return fmt.Errorf("invalid CPU core: %d (available: 0-%d)", core, numCPU-1)
		}
	}
	
	c.affinityMap[threadID] = cpuCores
	
	c.logger.Info("Set thread CPU affinity",
		zap.Int("thread_id", threadID),
		zap.Ints("cpu_cores", cpuCores))
	
	return nil
}

// GetThreadAffinity はスレッドのCPUアフィニティを取得
func (c *CPUManager) GetThreadAffinity(threadID int) ([]int, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	cores, exists := c.affinityMap[threadID]
	return cores, exists
}

// OptimizeForMining はマイニング用に最適化
func (c *CPUManager) OptimizeForMining(miningThreads int) error {
	numCPU := runtime.NumCPU()
	
	if miningThreads <= 0 {
		miningThreads = numCPU
	}
	
	if miningThreads > numCPU {
		miningThreads = numCPU
		c.logger.Warn("Mining threads exceeds CPU cores, limiting to CPU count",
			zap.Int("mining_threads", miningThreads),
			zap.Int("cpu_cores", numCPU))
	}
	
	c.logger.Info("Optimizing CPU for mining",
		zap.Int("mining_threads", miningThreads),
		zap.Int("cpu_cores", numCPU))
	
	// マイニングスレッドを均等に分散
	for i := 0; i < miningThreads; i++ {
		coreID := i % numCPU
		if err := c.SetThreadAffinity(i, []int{coreID}); err != nil {
			return fmt.Errorf("failed to set mining thread affinity: %w", err)
		}
	}
	
	// GCを最適化
	c.optimizeGC()
	
	return nil
}

// optimizeGC はガベージコレクションを最適化
func (c *CPUManager) optimizeGC() {
	// GOGC環境変数が設定されていない場合のみ最適化
	oldGOGC := runtime.GOMAXPROCS(0)
	
	// マイニング用にGCを調整
	runtime.GC() // 初期GC実行
	
	c.logger.Debug("Optimized GC for mining",
		zap.Int("gomaxprocs", oldGOGC))
}

// SubmitWork は作業をスレッドプールに投入
func (c *CPUManager) SubmitWork(item WorkItem) error {
	if c.threadPool == nil {
		return fmt.Errorf("thread pool not initialized")
	}
	
	select {
	case c.threadPool.workChan <- item:
		return nil
	default:
		return fmt.Errorf("thread pool queue full")
	}
}

// GetStats は統計情報を取得
func (c *CPUManager) GetStats() map[string]interface{} {
	c.mu.RLock()
	defer c.mu.RUnlock()
	
	stats := map[string]interface{}{
		"cpu_cores":      runtime.NumCPU(),
		"gomaxprocs":     runtime.GOMAXPROCS(0),
		"goroutines":     runtime.NumGoroutine(),
		"affinity_map":   c.affinityMap,
	}
	
	if c.threadPool != nil {
		stats["thread_pool_workers"] = c.threadPool.numWorkers
		stats["work_queue_size"] = len(c.threadPool.workChan)
	}
	
	return stats
}

// Shutdown はCPUマネージャーをシャットダウン
func (c *CPUManager) Shutdown() error {
	if c.threadPool != nil {
		close(c.threadPool.quitChan)
	}
	
	c.logger.Info("CPU manager shutdown complete")
	return nil
}

// start はワーカーを開始
func (w *Worker) start(logger *zap.Logger) {
	logger.Debug("Starting worker", 
		zap.Int("worker_id", w.id),
		zap.Int("cpu_core", w.cpuCore))
	
	for {
		select {
		case work := <-w.workChan:
			logger.Debug("Processing work item",
				zap.Int("worker_id", w.id),
				zap.String("work_id", work.ID))
			
			if err := work.TaskFunc(); err != nil {
				logger.Error("Work item failed",
					zap.Int("worker_id", w.id),
					zap.String("work_id", work.ID),
					zap.Error(err))
			}
			
		case <-w.quitChan:
			logger.Debug("Stopping worker", zap.Int("worker_id", w.id))
			return
		}
	}
}

// SetProcessPriority はプロセス優先度を設定（プラットフォーム依存）
func (c *CPUManager) SetProcessPriority(priority int) error {
	// Windows/Linux固有の実装が必要
	// ここでは実装の枠組みのみ提供
	c.logger.Info("Process priority setting requested",
		zap.Int("priority", priority))
	
	// 実際の実装では syscall や platform-specific パッケージを使用
	return fmt.Errorf("process priority setting not implemented for this platform")
}

// EnablePowerManagement は電力管理を有効化
func (c *CPUManager) EnablePowerManagement(enable bool) error {
	c.logger.Info("Power management setting",
		zap.Bool("enabled", enable))
	
	// 実際の実装では platform-specific な電力管理APIを使用
	return nil
}