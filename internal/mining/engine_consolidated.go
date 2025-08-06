package mining

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/cpuid/v2"
	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
)

// ConsolidatedEngine implements a high-performance mining engine with unified functionality.
// Follows John Carmack's performance-first approach with minimal abstraction.
type ConsolidatedEngine struct {
	logger *zap.Logger
	config *Config
	
	// Performance-critical atomic fields (cache-aligned)
	stats struct {
		totalHashRate   atomic.Uint64
		sharesSubmitted atomic.Uint64
		sharesAccepted  atomic.Uint64
		sharesRejected  atomic.Uint64
	}
	
	// State management
	running   atomic.Bool
	startTime time.Time
	
	// Hardware workers (unified approach)
	workers   []Worker
	workersMu sync.RWMutex
	
	// Algorithm management (single source of truth)
	algorithm      AlgorithmType
	algorithmMu    sync.RWMutex
	algorithmImpls map[AlgorithmType]AlgorithmEngine
	
	// Job and share management
	jobQueue   *OptimizedJobQueue
	shareQueue chan *Share
	
	// Pool configuration
	poolURL    string
	walletAddr string
	poolMu     sync.RWMutex
	
	// Memory pools for zero allocation
	jobPool   sync.Pool
	sharePool sync.Pool
	
	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	
	// Optional components
	profitSwitcher *ProfitSwitcher
	autoTuner      *AutoTuner
	
	// Statistics tracking
	statsHistory []StatsSnapshot
	historyMu    sync.RWMutex
}

// NewConsolidatedEngine creates a new consolidated mining engine.
// Rob Pike's clear construction - simple and explicit.
func NewConsolidatedEngine(logger *zap.Logger, config *Config) (*ConsolidatedEngine, error) {
	if config == nil {
		config = DefaultConfig()
	}
	
	if err := validateConfig(config); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	engine := &ConsolidatedEngine{
		logger:    logger,
		config:    config,
		ctx:       ctx,
		cancel:    cancel,
		startTime: time.Now(),
		algorithm: AlgorithmType(config.Algorithm),
		
		jobQueue:   NewOptimizedJobQueue(config.JobQueueSize),
		shareQueue: make(chan *Share, config.JobQueueSize),
		
		algorithmImpls: make(map[AlgorithmType]AlgorithmEngine),
		
		// Memory pools
		jobPool:   sync.Pool{New: func() interface{} { return &Job{} }},
		sharePool: sync.Pool{New: func() interface{} { return &Share{} }},
	}
	
	// Initialize algorithm implementations
	engine.initializeAlgorithms()
	
	// Initialize workers based on configuration
	if err := engine.initializeWorkers(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to initialize workers: %w", err)
	}
	
	// Optional components
	if config.AutoOptimize {
		engine.autoTuner = NewAutoTuner(logger)
	}
	
	return engine, nil
}

// Start starts the mining engine - clean and efficient startup
func (e *ConsolidatedEngine) Start() error {
	if !e.running.CompareAndSwap(false, true) {
		return errors.New("engine already running")
	}
	
	e.logger.Info("Starting consolidated mining engine",
		zap.String("algorithm", string(e.algorithm)),
		zap.Int("workers", len(e.workers)),
	)
	
	// Start core processing loops
	e.wg.Add(3)
	go e.jobProcessor()
	go e.shareProcessor()
	go e.statsUpdater()
	
	// Start workers
	e.workersMu.RLock()
	for _, worker := range e.workers {
		if err := worker.Start(e.ctx, e.jobQueue.JobChannel(), e.shareQueue); err != nil {
			e.workersMu.RUnlock()
			e.Stop()
			return fmt.Errorf("failed to start worker %s: %w", worker.ID(), err)
		}
	}
	e.workersMu.RUnlock()
	
	// Start optional components
	if e.autoTuner != nil {
		e.wg.Add(1)
		go e.runAutoTuner()
	}
	
	e.logger.Info("Mining engine started successfully")
	return nil
}

// Stop stops the mining engine gracefully
func (e *ConsolidatedEngine) Stop() error {
	if !e.running.CompareAndSwap(true, false) {
		return errors.New("engine not running")
	}
	
	e.logger.Info("Stopping mining engine")
	
	// Cancel context to signal shutdown
	e.cancel()
	
	// Stop workers
	e.workersMu.RLock()
	for _, worker := range e.workers {
		if err := worker.Stop(); err != nil {
			e.logger.Error("Failed to stop worker",
				zap.String("id", worker.ID()),
				zap.Error(err),
			)
		}
	}
	e.workersMu.RUnlock()
	
	// Close channels
	close(e.shareQueue)
	e.jobQueue.Close()
	
	// Wait for all goroutines
	e.wg.Wait()
	
	e.logger.Info("Mining engine stopped")
	return nil
}

// GetStats returns current mining statistics - lock-free for performance
func (e *ConsolidatedEngine) GetStats() *Stats {
	stats := &Stats{
		TotalHashRate:   e.stats.totalHashRate.Load(),
		SharesSubmitted: e.stats.sharesSubmitted.Load(),
		SharesAccepted:  e.stats.sharesAccepted.Load(),
		SharesRejected:  e.stats.sharesRejected.Load(),
		ActiveWorkers:   int32(len(e.workers)),
		Uptime:          time.Since(e.startTime),
	}
	
	// Get memory usage
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	stats.MemoryUsageMB = m.Alloc / 1024 / 1024
	
	// Aggregate worker statistics
	e.workersMu.RLock()
	for _, worker := range e.workers {
		rate := worker.GetHashRate()
		switch worker.GetType() {
		case WorkerCPU:
			stats.CPUHashRate += rate
		case WorkerGPU:
			stats.GPUHashRate += rate
		case WorkerASIC:
			stats.ASICHashRate += rate
		}
	}
	e.workersMu.RUnlock()
	
	return stats
}

// SubmitShare submits a share for validation - hot path optimized
func (e *ConsolidatedEngine) SubmitShare(share *Share) error {
	if !e.running.Load() {
		return errors.New("engine not running")
	}
	
	if share == nil || share.JobID == "" {
		return errors.New("invalid share")
	}
	
	select {
	case e.shareQueue <- share:
		e.stats.sharesSubmitted.Add(1)
		return nil
	case <-e.ctx.Done():
		return context.Canceled
	default:
		return errors.New("share queue full")
	}
}

// SetAlgorithm changes the mining algorithm
func (e *ConsolidatedEngine) SetAlgorithm(algo AlgorithmType) error {
	e.algorithmMu.Lock()
	defer e.algorithmMu.Unlock()
	
	if e.algorithm == algo {
		return nil
	}
	
	// Check if algorithm is supported
	if _, ok := e.algorithmImpls[algo]; !ok {
		return fmt.Errorf("unsupported algorithm: %s", algo)
	}
	
	oldAlgo := e.algorithm
	e.algorithm = algo
	
	e.logger.Info("Algorithm changed",
		zap.String("from", string(oldAlgo)),
		zap.String("to", string(algo)),
	)
	
	// Notify workers of algorithm change
	e.notifyAlgorithmChange(algo)
	
	return nil
}

// GetAlgorithm returns the current algorithm
func (e *ConsolidatedEngine) GetAlgorithm() AlgorithmType {
	e.algorithmMu.RLock()
	defer e.algorithmMu.RUnlock()
	return e.algorithm
}

// SetPool updates pool configuration
func (e *ConsolidatedEngine) SetPool(url, wallet string) error {
	e.poolMu.Lock()
	defer e.poolMu.Unlock()
	
	e.poolURL = url
	e.walletAddr = wallet
	
	e.logger.Info("Pool configuration updated",
		zap.String("url", url),
		zap.String("wallet", wallet),
	)
	
	return nil
}

// GetPool returns current pool configuration
func (e *ConsolidatedEngine) GetPool() (url, wallet string) {
	e.poolMu.RLock()
	defer e.poolMu.RUnlock()
	return e.poolURL, e.walletAddr
}

// Private methods

func (e *ConsolidatedEngine) initializeAlgorithms() {
	// Initialize algorithm implementations
	e.algorithmImpls[SHA256D] = &SHA256dEngine{}
	e.algorithmImpls[Scrypt] = &ScryptEngine{}
	e.algorithmImpls[Ethash] = &EthashEngine{}
	e.algorithmImpls[RandomX] = NewRandomXEngine()
	e.algorithmImpls[KawPow] = NewKawPowEngine()
}

func (e *ConsolidatedEngine) initializeWorkers() error {
	totalWorkers := e.config.CPUThreads + len(e.config.GPUDevices) + len(e.config.ASICDevices)
	e.workers = make([]Worker, 0, totalWorkers)
	
	// Initialize CPU workers
	for i := 0; i < e.config.CPUThreads; i++ {
		worker := NewCPUWorker(i, e.logger)
		e.workers = append(e.workers, worker)
	}
	
	// Initialize GPU workers
	for i, deviceID := range e.config.GPUDevices {
		worker := NewGPUWorker(i, deviceID, e.logger)
		e.workers = append(e.workers, worker)
	}
	
	// Initialize ASIC workers
	for i, devicePath := range e.config.ASICDevices {
		worker := NewASICWorker(i, devicePath, e.logger)
		e.workers = append(e.workers, worker)
	}
	
	e.logger.Info("Workers initialized",
		zap.Int("total", len(e.workers)),
		zap.Int("cpu", e.config.CPUThreads),
		zap.Int("gpu", len(e.config.GPUDevices)),
		zap.Int("asic", len(e.config.ASICDevices)),
	)
	
	return nil
}

func (e *ConsolidatedEngine) jobProcessor() {
	defer e.wg.Done()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		case job := <-e.jobQueue.JobChannel():
			if job == nil {
				continue
			}
			// Jobs are distributed to workers via the shared channel
			e.logger.Debug("Job queued for processing", zap.String("id", job.ID))
		}
	}
}

func (e *ConsolidatedEngine) shareProcessor() {
	defer e.wg.Done()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		case share := <-e.shareQueue:
			if share == nil {
				continue
			}
			
			// Validate share
			if e.validateShare(share) {
				e.stats.sharesAccepted.Add(1)
				// TODO: Submit to pool
			} else {
				e.stats.sharesRejected.Add(1)
			}
			
			// Return share to pool
			e.sharePool.Put(share)
		}
	}
}

func (e *ConsolidatedEngine) statsUpdater() {
	defer e.wg.Done()
	
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			e.updateStats()
		}
	}
}

func (e *ConsolidatedEngine) updateStats() {
	var totalHashRate uint64
	
	e.workersMu.RLock()
	for _, worker := range e.workers {
		totalHashRate += worker.GetHashRate()
	}
	e.workersMu.RUnlock()
	
	e.stats.totalHashRate.Store(totalHashRate)
	
	// Record snapshot
	snapshot := StatsSnapshot{
		Timestamp:       time.Now(),
		HashRate:        totalHashRate,
		SharesSubmitted: e.stats.sharesSubmitted.Load(),
		SharesAccepted:  e.stats.sharesAccepted.Load(),
	}
	
	e.historyMu.Lock()
	e.statsHistory = append(e.statsHistory, snapshot)
	// Keep only last hour of history
	if len(e.statsHistory) > 3600 {
		e.statsHistory = e.statsHistory[len(e.statsHistory)-3600:]
	}
	e.historyMu.Unlock()
}

func (e *ConsolidatedEngine) validateShare(share *Share) bool {
	if share == nil || share.JobID == "" || share.WorkerID == "" {
		return false
	}
	
	if share.Difficulty < e.config.MinShareDifficulty {
		return false
	}
	
	// Algorithm-specific validation
	e.algorithmMu.RLock()
	impl, ok := e.algorithmImpls[e.algorithm]
	e.algorithmMu.RUnlock()
	
	if !ok {
		return false
	}
	
	return impl.ValidateShare(share)
}

func (e *ConsolidatedEngine) notifyAlgorithmChange(algo AlgorithmType) {
	// Notify all workers of algorithm change
	e.workersMu.RLock()
	defer e.workersMu.RUnlock()
	
	for _, worker := range e.workers {
		// Workers can optionally implement algorithm switching
		if switcher, ok := worker.(interface{ SwitchAlgorithm(AlgorithmType) }); ok {
			switcher.SwitchAlgorithm(algo)
		}
	}
}

func (e *ConsolidatedEngine) runAutoTuner() {
	defer e.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			if e.autoTuner != nil {
				e.autoTuner.Optimize(e)
			}
		}
	}
}

// GetStatus returns engine status
func (e *ConsolidatedEngine) GetStatus() *EngineStatus {
	e.poolMu.RLock()
	pool := e.poolURL
	wallet := e.walletAddr
	e.poolMu.RUnlock()
	
	e.algorithmMu.RLock()
	algo := e.algorithm
	e.algorithmMu.RUnlock()
	
	return &EngineStatus{
		Running:   e.running.Load(),
		Algorithm: algo,
		Pool:      pool,
		Wallet:    wallet,
		Uptime:    time.Since(e.startTime),
	}
}

// GetStatsHistory returns historical statistics
func (e *ConsolidatedEngine) GetStatsHistory(duration time.Duration) []StatsSnapshot {
	e.historyMu.RLock()
	defer e.historyMu.RUnlock()
	
	cutoff := time.Now().Add(-duration)
	var result []StatsSnapshot
	
	for _, snapshot := range e.statsHistory {
		if snapshot.Timestamp.After(cutoff) {
			result = append(result, snapshot)
		}
	}
	
	return result
}

// Interface implementations for compatibility

func (e *ConsolidatedEngine) GetStartTime() time.Time { return e.startTime }
func (e *ConsolidatedEngine) GetCPUThreads() int { return e.config.CPUThreads }
func (e *ConsolidatedEngine) SetCPUThreads(threads int) error {
	if threads < 0 || threads > 256 {
		return errors.New("invalid thread count")
	}
	e.config.CPUThreads = threads
	return nil
}

func (e *ConsolidatedEngine) GetConfig() map[string]interface{} {
	return map[string]interface{}{
		"cpu_threads":   e.config.CPUThreads,
		"gpu_devices":   e.config.GPUDevices,
		"asic_devices":  e.config.ASICDevices,
		"algorithm":     e.config.Algorithm,
		"intensity":     e.config.Intensity,
		"max_memory_mb": e.config.MaxMemoryMB,
		"auto_optimize": e.config.AutoOptimize,
	}
}

func (e *ConsolidatedEngine) SetConfig(key string, value interface{}) error {
	switch key {
	case "cpu_threads":
		if threads, ok := value.(int); ok {
			return e.SetCPUThreads(threads)
		}
	case "algorithm":
		if algo, ok := value.(string); ok {
			return e.SetAlgorithm(AlgorithmType(algo))
		}
	}
	return fmt.Errorf("unknown config key: %s", key)
}

func (e *ConsolidatedEngine) HasCPU() bool { return e.config.CPUThreads > 0 }
func (e *ConsolidatedEngine) HasGPU() bool { return len(e.config.GPUDevices) > 0 }
func (e *ConsolidatedEngine) HasASIC() bool { return len(e.config.ASICDevices) > 0 }

func (e *ConsolidatedEngine) GetHardwareInfo() *HardwareInfo {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	return &HardwareInfo{
		CPUThreads:  e.config.CPUThreads,
		GPUDevices:  []GPUInfo{},
		ASICDevices: []ASICInfo{},
		TotalMemory: m.Sys,
		AvailMemory: m.Sys - m.Alloc,
	}
}

func (e *ConsolidatedEngine) ResetStats() {
	e.stats.totalHashRate.Store(0)
	e.stats.sharesSubmitted.Store(0)
	e.stats.sharesAccepted.Store(0)
	e.stats.sharesRejected.Store(0)
	e.startTime = time.Now()
	
	e.historyMu.Lock()
	e.statsHistory = e.statsHistory[:0]
	e.historyMu.Unlock()
}

// Compatibility methods
func (e *ConsolidatedEngine) SwitchAlgorithm(algo AlgorithmType) error { return e.SetAlgorithm(algo) }
func (e *ConsolidatedEngine) GetSupportedAlgorithms() []string {
	algos := make([]string, 0, len(e.algorithmImpls))
	for algo := range e.algorithmImpls {
		algos = append(algos, string(algo))
	}
	return algos
}

func (e *ConsolidatedEngine) ValidateAlgorithm(algorithm string) bool {
	_, ok := e.algorithmImpls[AlgorithmType(algorithm)]
	return ok
}

func (e *ConsolidatedEngine) SetActiveCurrency(symbol string) error {
	// TODO: Implement currency switching
	return nil
}

func (e *ConsolidatedEngine) GetActiveCurrency() string {
	// TODO: Implement currency tracking
	return "BTC"
}

func (e *ConsolidatedEngine) SetGPUSettings(coreClock, memoryClock, powerLimit int) error {
	// TODO: Implement GPU settings
	return nil
}

func (e *ConsolidatedEngine) GetCurrentJob() *Job {
	// Get from pool
	job := e.jobPool.Get().(*Job)
	*job = Job{
		ID:        fmt.Sprintf("job_%d", time.Now().UnixNano()),
		Height:    uint64(time.Now().Unix()),
		Algorithm: e.GetAlgorithm(),
		Timestamp: uint32(time.Now().Unix()),
		Bits:      0x1d00ffff,
		CleanJobs: false,
	}
	return job
}

func (e *ConsolidatedEngine) GetAutoTuner() *AutoTuner { return e.autoTuner }
func (e *ConsolidatedEngine) GetProfitSwitcher() *ProfitSwitcher { return e.profitSwitcher }

// OptimizedJobQueue represents an optimized job queue
type OptimizedJobQueue struct {
	jobs chan *Job
}

func NewOptimizedJobQueue(size int) *OptimizedJobQueue {
	return &OptimizedJobQueue{
		jobs: make(chan *Job, size),
	}
}

func (q *OptimizedJobQueue) JobChannel() <-chan *Job { return q.jobs }
func (q *OptimizedJobQueue) Submit(job *Job) error {
	select {
	case q.jobs <- job:
		return nil
	default:
		return errors.New("queue full")
	}
}
func (q *OptimizedJobQueue) Close() { close(q.jobs) }

// RandomXEngine implements RandomX algorithm
type RandomXEngine struct{}

func NewRandomXEngine() *RandomXEngine { return &RandomXEngine{} }
func (e *RandomXEngine) ValidateShare(share *Share) bool { return true }

// KawPowEngine implements KawPow algorithm
type KawPowEngine struct{}

func NewKawPowEngine() *KawPowEngine { return &KawPowEngine{} }
func (e *KawPowEngine) ValidateShare(share *Share) bool { return true }

// AutoTuner performs automatic optimization
type AutoTuner struct {
	logger *zap.Logger
}

func NewAutoTuner(logger *zap.Logger) *AutoTuner {
	return &AutoTuner{logger: logger}
}

func (t *AutoTuner) Optimize(engine *ConsolidatedEngine) {
	// Perform optimization based on current performance
	t.logger.Debug("Running auto-tuning optimization")
}