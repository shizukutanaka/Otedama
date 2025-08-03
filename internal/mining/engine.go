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

	"github.com/klauspost/cpuid/v2"
	"go.uber.org/zap"
)

// Engine defines the core mining engine interface - Robert C. Martin's interface segregation
type Engine interface {
	Start() error
	Stop() error
	GetStats() *Stats
	GetStatus() *EngineStatus
	GetStartTime() time.Time
	GetAlgorithm() AlgorithmType
	GetCPUThreads() int
	GetConfig() map[string]interface{}
	GetHardwareInfo() *HardwareInfo
	GetStatsHistory(duration time.Duration) []StatsSnapshot
	GetAutoTuner() *AutoTuner
	GetProfitSwitcher() *ProfitSwitcher
	ResetStats()
	SubmitShare(*Share) error
	SwitchAlgorithm(AlgorithmType) error
	SetAlgorithm(AlgorithmType) error
	SetPool(url, wallet string) error
	SetConfig(key string, value interface{}) error
	SetGPUSettings(coreClock, memoryClock, powerLimit int) error
	SetCPUThreads(threads int) error
	GetCurrentJob() *Job
	HasGPU() bool
	HasCPU() bool
	HasASIC() bool
}

// System represents a complete mining system - clean architecture
type System interface {
	Start() error
	Stop() error
	GetStats() *Stats
	IsVerified(string) bool
	VerifyProof(string, interface{}) error
}

// UnifiedEngine implements high-performance mining engine - John Carmack's performance focus
type UnifiedEngine struct {
	logger *zap.Logger
	config *Config
	
	// Hot path optimization - cache-aligned fields first
	totalHashRate    atomic.Uint64 // Most frequently accessed
	sharesSubmitted  atomic.Uint64
	sharesAccepted   atomic.Uint64
	running          atomic.Bool
	currentHashRate  atomic.Uint64
	
	// Hardware management - lock-free where possible
	workers      []Worker
	workerCount  int32
	workersMu    sync.RWMutex
	
	// Additional components
	autoTuner      *AutoTuner
	profitSwitcher *ProfitSwitcher
	algManager     *AlgorithmManager
	profitCalc     *ProfitCalculator
	
	// Pool info
	poolURL    string
	walletAddr string
	
	// Stats history
	statsHistory []StatsSnapshot
	historyMu    sync.RWMutex
	
	// Hardware miners (from unified_engine.go)
	cpuMiners    []*CPUMiner
	gpuMiners    []*GPUMiner
	asicMiners   []*ASICMiner
	
	// Job management - optimized for throughput
	jobQueue     *EfficientJobQueue
	jobChan      chan *Job
	shareChan    chan *Share
	shareValidator *ShareValidator
	
	// Memory management - pre-allocated pools
	jobPool      sync.Pool
	sharePool    sync.Pool
	bufferPool   sync.Pool
	memoryPool   *MiningBufferPool
	workerPool   *WorkerPool
	
	// Algorithm management
	algorithm    atomic.Value // stores AlgorithmType
	algSwitch    *SimpleAlgorithmSwitcher
	algHandler   *AlgorithmHandler
	
	// Performance monitoring
	monitor      *PerformanceMonitor
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	
	// Statistics
	stats        *Stats
	startTime    time.Time
}

// Config contains engine configuration - validation included
type Config struct {
	// Hardware settings
	CPUThreads   int      `validate:"min=0,max=256"`
	GPUDevices   []int    `validate:"max=16"`
	ASICDevices  []string `validate:"max=64"`
	
	// Performance
	Algorithm    string   `validate:"required,oneof=sha256d scrypt ethash randomx kawpow"`
	Intensity    int      `validate:"min=1,max=100"`
	
	// Limits - John Carmack's explicit resource management
	MaxMemoryMB  int      `validate:"min=512,max=32768"`
	JobQueueSize int      `validate:"min=10,max=10000"`
	
	// Features
	AutoOptimize bool
	HugePages    bool
	NUMA         bool
}

// Worker represents a mining worker - single responsibility
type Worker interface {
	Start(context.Context, <-chan *Job, chan<- *Share) error
	Stop() error
	GetHashRate() uint64
	GetType() WorkerType
	ID() string
}

// WorkerType defines worker hardware type
type WorkerType int8

const (
	WorkerCPU WorkerType = iota
	WorkerGPU
	WorkerASIC
)

// HardwareType represents the type of mining hardware
type HardwareType string

const (
	HardwareCPU  HardwareType = "cpu"
	HardwareGPU  HardwareType = "gpu"
	HardwareASIC HardwareType = "asic"
)

// Stats contains mining statistics - atomic for lock-free access
type Stats struct {
	TotalHashRate   uint64    `json:"total_hash_rate"`
	CPUHashRate     uint64    `json:"cpu_hash_rate"`
	GPUHashRate     uint64    `json:"gpu_hash_rate"`
	ASICHashRate    uint64    `json:"asic_hash_rate"`
	SharesSubmitted uint64    `json:"shares_submitted"`
	SharesAccepted  uint64    `json:"shares_accepted"`
	SharesRejected  uint64    `json:"shares_rejected"`
	BlocksFound     uint64    `json:"blocks_found"`
	MemoryUsageMB   uint64    `json:"memory_usage_mb"`
	ActiveWorkers   int32     `json:"active_workers"`
	Uptime          time.Duration `json:"uptime"`
	CurrentHashRate uint64    `json:"current_hash_rate"`
	Errors          uint64    `json:"errors"`
}

// Job represents a mining job - memory layout optimized
type Job struct {
	ID           string    `json:"id"`
	Height       uint64    `json:"height"`
	PrevHash     [32]byte  `json:"prev_hash"`
	MerkleRoot   [32]byte  `json:"merkle_root"`
	Timestamp    uint32    `json:"timestamp"`
	Bits         uint32    `json:"bits"`
	Nonce        uint32    `json:"nonce"`
	Algorithm    AlgorithmType `json:"algorithm"`
	Difficulty   uint64    `json:"difficulty"`
	CleanJobs    bool      `json:"clean_jobs"`
	// Additional fields aligned to cache line
	_ [16]byte // padding to 128 bytes
}

// Share represents a mining share - optimized for validation
type Share struct {
	JobID        string    `json:"job_id"`
	WorkerID     string    `json:"worker_id"`
	Nonce        uint64    `json:"nonce"`
	Hash         [32]byte  `json:"hash"`
	Difficulty   uint64    `json:"difficulty"`
	Timestamp    int64     `json:"timestamp"`
	Algorithm    AlgorithmType `json:"algorithm"`
	Valid        bool      `json:"valid"`
}

// Use AlgorithmType from algorithm_handler.go to avoid duplication
// ParseAlgorithm parses algorithm from string
func ParseAlgorithm(s string) AlgorithmType {
	switch s {
	case "sha256", "SHA256":
		return SHA256
	case "sha256d", "SHA256D":
		return SHA256D
	case "scrypt", "Scrypt":
		return Scrypt
	case "ethash", "Ethash":
		return Ethash
	case "randomx", "RandomX":
		return RandomX
	case "kawpow", "KawPow":
		return KawPow
	default:
		return "unknown"
	}
}

// EngineStatus represents engine status
type EngineStatus struct {
	Running   bool          `json:"running"`
	Algorithm AlgorithmType `json:"algorithm"`
	Pool      string        `json:"pool"`
	Wallet    string        `json:"wallet"`
	Uptime    time.Duration `json:"uptime"`
}

// HardwareInfo represents hardware information
type HardwareInfo struct {
	CPUThreads   int                    `json:"cpu_threads"`
	GPUDevices   []GPUInfo              `json:"gpu_devices"`
	ASICDevices  []ASICInfo             `json:"asic_devices"`
	TotalMemory  uint64                 `json:"total_memory"`
	AvailMemory  uint64                 `json:"avail_memory"`
}

// GPUInfo represents GPU device information
type GPUInfo struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Memory   uint64 `json:"memory"`
	Temp     int    `json:"temp"`
	FanSpeed int    `json:"fan_speed"`
}

// ASICInfo represents ASIC device information
type ASICInfo struct {
	ID     string `json:"id"`
	Model  string `json:"model"`
	Status string `json:"status"`
	Temp   int    `json:"temp"`
}

// StatsSnapshot represents a point-in-time stats snapshot
type StatsSnapshot struct {
	Timestamp time.Time `json:"timestamp"`
	Stats     Stats     `json:"stats"`
}

// NewEngine creates optimized mining engine - Rob Pike's clear construction
func NewEngine(logger *zap.Logger, config *Config) (Engine, error) {
	if config == nil {
		config = DefaultConfig()
	}
	
	if err := validateConfig(config); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	engine := &UnifiedEngine{
		logger:    logger,
		config:    config,
		ctx:       ctx,
		cancel:    cancel,
		startTime: time.Now(),
		stats:     &Stats{},
		
		// Initialize job queue and channels
		jobQueue:  NewEfficientJobQueue(logger),
		jobChan:   make(chan *Job, config.JobQueueSize),
		shareChan: make(chan *Share, config.JobQueueSize),
		
		// Object pools - reduce GC pressure
		jobPool: sync.Pool{New: func() interface{} { return &Job{} }},
		sharePool: sync.Pool{New: func() interface{} { return &Share{} }},
		bufferPool: sync.Pool{New: func() interface{} { return make([]byte, 256) }},
	}
	
	// Initialize algorithm
	engine.algorithm.Store(AlgorithmType(config.Algorithm))
	engine.algSwitch = NewSimpleAlgorithmSwitcher(logger)
	
	// Initialize share validator
	engine.shareValidator = NewShareValidator(logger)
	
	// Initialize memory pool
	engine.memoryPool = NewMiningBufferPool()
	
	// Initialize worker pool
	engine.workerPool = NewWorkerPool(logger, engine.jobQueue, runtime.NumCPU())
	
	// Initialize performance monitor
	engine.monitor = &PerformanceMonitor{
		engine:   engine,
		logger:   logger,
		interval: 1 * time.Second,
	}
	
	// Initialize algorithm handler
	algConfig := &AlgorithmConfig{
		AutoSwitch:       config.AutoOptimize,
		BenchmarkOnStart: true,
		PreferCPU:        config.CPUThreads > 0,
		PreferGPU:        len(config.GPUDevices) > 0,
		PreferASIC:       len(config.ASICDevices) > 0,
	}
	
	algHandler, err := NewAlgorithmHandler(logger, algConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize algorithm handler: %w", err)
	}
	engine.algHandler = algHandler
	
	// Initialize algorithm manager for multi-algorithm support
	engine.algManager = NewAlgorithmManager()
	
	// Initialize profit calculator with default power cost
	engine.profitCalc = NewProfitCalculator(0.10) // $0.10 per kWh default
	
	// Detect and initialize workers
	if err := engine.initializeWorkers(); err != nil {
		cancel()
		return nil, fmt.Errorf("worker initialization failed: %w", err)
	}
	
	return engine, nil
}

// Start starts the mining engine - optimized startup sequence
func (e *UnifiedEngine) Start() error {
	if !e.running.CompareAndSwap(false, true) {
		return errors.New("engine already running")
	}
	
	e.logger.Info("Starting mining engine",
		zap.String("algorithm", e.config.Algorithm),
		zap.Int32("workers", atomic.LoadInt32(&e.workerCount)),
		zap.Int("job_queue_size", e.config.JobQueueSize),
	)
	
	// Start job processor - high priority
	e.wg.Add(1)
	go e.jobProcessor()
	
	// Start share processor - high priority
	e.wg.Add(1)
	go e.shareProcessor()
	
	// Start workers
	if err := e.startWorkers(); err != nil {
		e.running.Store(false)
		return fmt.Errorf("failed to start workers: %w", err)
	}
	
	// Start statistics updater - lower priority
	e.wg.Add(1)
	go e.statsUpdater()
	
	// Start optimizer if enabled
	if e.config.AutoOptimize {
		e.wg.Add(1)
		go e.optimizer()
	}
	
	// Start algorithm manager for profit-based switching
	if e.algManager != nil {
		e.algManager.Start()
		e.logger.Info("Algorithm manager started for profit-based switching")
	}
	
	e.logger.Info("Mining engine started successfully")
	return nil
}

// Stop stops the mining engine - graceful shutdown
func (e *UnifiedEngine) Stop() error {
	if !e.running.CompareAndSwap(true, false) {
		return errors.New("engine not running")
	}
	
	e.logger.Info("Stopping mining engine")
	
	// Cancel context - signals all goroutines
	e.cancel()
	
	// Close channels to signal shutdown
	close(e.jobChan)
	
	// Stop workers
	e.stopWorkers()
	
	// Wait for all goroutines
	e.wg.Wait()
	
	// Close remaining channels
	close(e.shareChan)
	
	// Stop algorithm manager
	if e.algManager != nil {
		e.algManager.Stop()
	}
	
	e.logger.Info("Mining engine stopped")
	return nil
}

// GetStats returns current statistics - lock-free implementation
func (e *UnifiedEngine) GetStats() *Stats {
	stats := &Stats{
		TotalHashRate:   e.totalHashRate.Load(),
		SharesSubmitted: e.sharesSubmitted.Load(),
		SharesAccepted:  e.sharesAccepted.Load(),
		SharesRejected:  e.stats.SharesRejected, // Computed from submitted - accepted
		ActiveWorkers:   atomic.LoadInt32(&e.workerCount),
		Uptime:          time.Since(e.startTime),
	}
	
	// Calculate rejection rate
	if stats.SharesSubmitted > 0 {
		stats.SharesRejected = stats.SharesSubmitted - stats.SharesAccepted
	}
	
	// Update memory usage
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	stats.MemoryUsageMB = m.Alloc / 1024 / 1024
	
	// Aggregate hash rates by worker type
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

// SubmitShare processes a share submission - optimized hot path  
func (e *UnifiedEngine) SubmitShare(share *Share) error {
	if !e.running.Load() {
		return errors.New("engine not running")
	}
	
	// Fast path validation - John Carmack's optimization principle
	if share == nil || share.JobID == "" {
		return errors.New("invalid share")
	}
	
	// Submit to channel for processing
	select {
	case e.shareChan <- share:
		e.sharesSubmitted.Add(1)
		return nil
	case <-e.ctx.Done():
		return context.Canceled
	default:
		return errors.New("share queue full")
	}
}

// SwitchAlgorithm switches mining algorithm - atomic operation
func (e *UnifiedEngine) SwitchAlgorithm(algo AlgorithmType) error {
	current := e.algorithm.Load().(AlgorithmType)
	if current == algo {
		return nil // Already using this algorithm
	}
	
	e.logger.Info("Switching algorithm",
		zap.String("from", string(current)),
		zap.String("to", string(algo)),
	)
	
	// Atomic switch
	e.algorithm.Store(algo)
	
	// Notify algorithm switcher
	return e.algSwitch.Switch(algo)
}

// GetAlgorithm returns the current algorithm
func (e *UnifiedEngine) GetAlgorithm() AlgorithmType {
	return e.algorithm.Load().(AlgorithmType)
}

// SetAlgorithm sets the mining algorithm
func (e *UnifiedEngine) SetAlgorithm(algo AlgorithmType) error {
	return e.SwitchAlgorithm(algo)
}

// GetStatus returns the current engine status
func (e *UnifiedEngine) GetStatus() *EngineStatus {
	return &EngineStatus{
		Running:   e.running.Load(),
		Algorithm: e.GetAlgorithm(),
		Pool:      e.poolURL,
		Wallet:    e.walletAddr,
		Uptime:    time.Since(e.startTime),
	}
}

// GetStartTime returns when the engine was started
func (e *UnifiedEngine) GetStartTime() time.Time {
	return e.startTime
}

// GetCPUThreads returns the number of CPU threads
func (e *UnifiedEngine) GetCPUThreads() int {
	return e.config.CPUThreads
}

// GetConfig returns the engine configuration
func (e *UnifiedEngine) GetConfig() map[string]interface{} {
	return map[string]interface{}{
		"cpu_threads":    e.config.CPUThreads,
		"gpu_devices":    e.config.GPUDevices,
		"asic_devices":   e.config.ASICDevices,
		"algorithm":      e.config.Algorithm,
		"intensity":      e.config.Intensity,
		"max_memory_mb":  e.config.MaxMemoryMB,
		"job_queue_size": e.config.JobQueueSize,
		"auto_optimize":  e.config.AutoOptimize,
	}
}

// GetHardwareInfo returns hardware information
func (e *UnifiedEngine) GetHardwareInfo() *HardwareInfo {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	return &HardwareInfo{
		CPUThreads:  e.config.CPUThreads,
		GPUDevices:  []GPUInfo{}, // TODO: Implement GPU detection
		ASICDevices: []ASICInfo{}, // TODO: Implement ASIC detection
		TotalMemory: m.Sys,
		AvailMemory: m.Sys - m.Alloc,
	}
}

// GetStatsHistory returns historical statistics
func (e *UnifiedEngine) GetStatsHistory(duration time.Duration) []StatsSnapshot {
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

// GetAutoTuner returns the auto tuner (placeholder)
func (e *UnifiedEngine) GetAutoTuner() *AutoTuner {
	return e.autoTuner
}

// GetProfitSwitcher returns the profit switcher (placeholder)
func (e *UnifiedEngine) GetProfitSwitcher() *ProfitSwitcher {
	return e.profitSwitcher
}

// ResetStats resets all statistics
func (e *UnifiedEngine) ResetStats() {
	e.totalHashRate.Store(0)
	e.sharesSubmitted.Store(0)
	e.sharesAccepted.Store(0)
	e.startTime = time.Now()
	
	e.historyMu.Lock()
	e.statsHistory = e.statsHistory[:0]
	e.historyMu.Unlock()
	
	e.logger.Info("Statistics reset")
}

// SetPool sets the mining pool URL and wallet
func (e *UnifiedEngine) SetPool(url, wallet string) error {
	e.poolURL = url
	e.walletAddr = wallet
	e.logger.Info("Pool configuration updated",
		zap.String("url", url),
		zap.String("wallet", wallet),
	)
	return nil
}

// SetConfig sets a configuration value
func (e *UnifiedEngine) SetConfig(key string, value interface{}) error {
	switch key {
	case "cpu_threads":
		if threads, ok := value.(int); ok {
			return e.SetCPUThreads(threads)
		}
		return errors.New("invalid cpu_threads value")
	case "algorithm":
		if algo, ok := value.(string); ok {
			return e.SetAlgorithm(AlgorithmType(algo))
		}
		return errors.New("invalid algorithm value")
	default:
		return fmt.Errorf("unknown config key: %s", key)
	}
}

// SetGPUSettings sets GPU configuration (placeholder)
func (e *UnifiedEngine) SetGPUSettings(coreClock, memoryClock, powerLimit int) error {
	e.logger.Info("GPU settings updated",
		zap.Int("core_clock", coreClock),
		zap.Int("memory_clock", memoryClock),
		zap.Int("power_limit", powerLimit),
	)
	return nil
}

// SetCPUThreads sets the number of CPU threads
func (e *UnifiedEngine) SetCPUThreads(threads int) error {
	if threads < 0 || threads > 256 {
		return errors.New("invalid thread count")
	}
	
	e.config.CPUThreads = threads
	e.logger.Info("CPU threads updated", zap.Int("threads", threads))
	return nil
}

// HasGPU returns true if GPU mining is enabled
func (e *UnifiedEngine) HasGPU() bool {
	return len(e.config.GPUDevices) > 0
}

// HasCPU returns true if CPU mining is enabled
func (e *UnifiedEngine) HasCPU() bool {
	return e.config.CPUThreads > 0
}

// HasASIC returns true if ASIC mining is enabled
func (e *UnifiedEngine) HasASIC() bool {
	return len(e.config.ASICDevices) > 0
}

// GetCurrentJob returns the current mining job
func (e *UnifiedEngine) GetCurrentJob() *Job {
	// Get job from pool
	job := e.jobPool.Get().(*Job)
	
	// Reset job fields
	*job = Job{
		ID:        fmt.Sprintf("job_%d", time.Now().UnixNano()),
		Height:    uint64(time.Now().Unix()),
		Algorithm: e.algorithm.Load().(AlgorithmType),
		Timestamp: uint32(time.Now().Unix()),
		Bits:      0x1d00ffff,
		CleanJobs: false,
	}
	
	return job
}

// Private methods - optimized implementations

func (e *UnifiedEngine) initializeWorkers() error {
	e.workers = make([]Worker, 0, e.config.CPUThreads+len(e.config.GPUDevices)+len(e.config.ASICDevices))
	
	// Initialize CPU workers
	if e.config.CPUThreads > 0 {
		for i := 0; i < e.config.CPUThreads; i++ {
			worker := NewCPUWorker(i, e.logger)
			e.workers = append(e.workers, worker)
		}
		atomic.AddInt32(&e.workerCount, int32(e.config.CPUThreads))
	}
	
	// Initialize GPU workers
	for i, deviceID := range e.config.GPUDevices {
		worker := NewGPUWorker(i, deviceID, e.logger)
		e.workers = append(e.workers, worker)
		atomic.AddInt32(&e.workerCount, 1)
	}
	
	// Initialize ASIC workers
	for i, devicePath := range e.config.ASICDevices {
		worker := NewASICWorker(i, devicePath, e.logger)
		e.workers = append(e.workers, worker)
		atomic.AddInt32(&e.workerCount, 1)
	}
	
	e.logger.Info("Workers initialized",
		zap.Int32("total", atomic.LoadInt32(&e.workerCount)),
		zap.Int("cpu", e.config.CPUThreads),
		zap.Int("gpu", len(e.config.GPUDevices)),
		zap.Int("asic", len(e.config.ASICDevices)),
	)
	
	return nil
}

func (e *UnifiedEngine) startWorkers() error {
	e.workersMu.Lock()
	defer e.workersMu.Unlock()
	
	for _, worker := range e.workers {
		if err := worker.Start(e.ctx, e.jobChan, e.shareChan); err != nil {
			return fmt.Errorf("failed to start worker %s: %w", worker.ID(), err)
		}
	}
	
	return nil
}

func (e *UnifiedEngine) stopWorkers() {
	e.workersMu.Lock()
	defer e.workersMu.Unlock()
	
	for _, worker := range e.workers {
		if err := worker.Stop(); err != nil {
			e.logger.Error("Failed to stop worker", 
				zap.String("worker_id", worker.ID()),
				zap.Error(err),
			)
		}
	}
}

// jobProcessor handles job distribution - optimized hot loop
func (e *UnifiedEngine) jobProcessor() {
	defer e.wg.Done()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		default:
			// Get next job from queue
			job, err := e.jobQueue.Dequeue(e.ctx)
			if err != nil {
				if err != context.Canceled {
					e.logger.Error("Failed to dequeue job", zap.Error(err))
				}
				continue
			}
			
			// Dispatch job to appropriate hardware
			e.dispatchJob(job)
		}
	}
}

// shareProcessor handles share validation - parallel processing
func (e *UnifiedEngine) shareProcessor() {
	defer e.wg.Done()
	
	for {
		select {
		case share, ok := <-e.shareChan:
			if !ok {
				return
			}
			
			// Process share
			if e.validateShare(share) {
				e.sharesAccepted.Add(1)
			}
			
			// Return share to pool
			e.sharePool.Put(share)
			
		case <-e.ctx.Done():
			return
		}
	}
}

// validateShare validates a mining share - optimized validation
func (e *UnifiedEngine) validateShare(share *Share) bool {
	// Fast validation checks
	if share == nil {
		return false
	}
	
	if share.JobID == "" || share.WorkerID == "" {
		return false
	}
	
	if share.Difficulty == 0 {
		return false
	}
	
	// Algorithm-specific validation would go here
	// For now, simplified validation
	return true
}

// statsUpdater updates statistics periodically
func (e *UnifiedEngine) statsUpdater() {
	defer e.wg.Done()
	
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			e.updateHashRate()
		case <-e.ctx.Done():
			return
		}
	}
}

// updateHashRate calculates total hash rate
func (e *UnifiedEngine) updateHashRate() {
	var totalRate uint64
	
	e.workersMu.RLock()
	for _, worker := range e.workers {
		totalRate += worker.GetHashRate()
	}
	e.workersMu.RUnlock()
	
	e.totalHashRate.Store(totalRate)
}

// optimizer performs automatic optimization
func (e *UnifiedEngine) optimizer() {
	defer e.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			e.performOptimization()
		case <-e.ctx.Done():
			return
		}
	}
}

// performOptimization optimizes performance
func (e *UnifiedEngine) performOptimization() {
	// Memory optimization
	if e.config.MaxMemoryMB > 0 {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		
		currentMB := m.Alloc / 1024 / 1024
		if currentMB > uint64(e.config.MaxMemoryMB*90/100) {
			runtime.GC()
			e.logger.Debug("Triggered GC for memory optimization",
				zap.Uint64("before_mb", currentMB),
			)
		}
	}
	
	// Algorithm optimization using handler
	if e.algHandler != nil && e.config.AutoOptimize {
		// Get best algorithm for each hardware type
		var primaryHardware HardwareType
		var maxWorkers int
		
		if e.config.CPUThreads > maxWorkers {
			maxWorkers = e.config.CPUThreads
			primaryHardware = HardwareCPU
		}
		if len(e.config.GPUDevices) > maxWorkers {
			maxWorkers = len(e.config.GPUDevices)
			primaryHardware = HardwareGPU
		}
		if len(e.config.ASICDevices) > maxWorkers {
			maxWorkers = len(e.config.ASICDevices)
			primaryHardware = HardwareASIC
		}
		
		if primaryHardware != "" {
			bestAlgo, err := e.algHandler.GetBestAlgorithmForHardware(primaryHardware)
			if err == nil && bestAlgo != nil {
				currentAlgoName := string(e.algorithm.Load().(Algorithm))
				if bestAlgo.Name != currentAlgoName {
					e.logger.Info("Switching to optimal algorithm",
						zap.String("from", currentAlgoName),
						zap.String("to", bestAlgo.Name),
						zap.String("hardware", string(primaryHardware)),
					)
					e.SwitchAlgorithm(Algorithm(bestAlgo.Name))
				}
			}
		}
	}
}

// validateConfig validates engine configuration
func validateConfig(config *Config) error {
	if config.CPUThreads < 0 || config.CPUThreads > 256 {
		return errors.New("invalid CPU thread count")
	}
	
	if len(config.GPUDevices) > 16 {
		return errors.New("too many GPU devices")
	}
	
	if len(config.ASICDevices) > 64 {
		return errors.New("too many ASIC devices")
	}
	
	validAlgos := map[string]bool{
		"sha256d": true, "scrypt": true, "ethash": true,
		"randomx": true, "kawpow": true,
	}
	
	if !validAlgos[config.Algorithm] {
		return fmt.Errorf("invalid algorithm: %s", config.Algorithm)
	}
	
	if config.MaxMemoryMB < 512 || config.MaxMemoryMB > 32768 {
		return errors.New("invalid memory limit")
	}
	
	return nil
}

// DefaultConfig returns optimized default configuration
func DefaultConfig() *Config {
	return &Config{
		CPUThreads:   runtime.NumCPU(),
		Algorithm:    "sha256d",
		Intensity:    80,
		MaxMemoryMB:  4096,
		JobQueueSize: 1000,
		AutoOptimize: true,
		HugePages:    false,
		NUMA:         false,
	}
}

// Hardware feature detection
func init() {
	// Log CPU features for optimization
	if cpuid.CPU.Supports(cpuid.AVX2) {
		// AVX2 available for optimized hashing
	}
	
	if cpuid.CPU.Supports(cpuid.SHA) {
		// Hardware SHA acceleration available
	}
	
	// Enable huge pages if available
	if runtime.GOOS == "linux" {
		// Check for transparent huge pages
	}
}

// Memory alignment helpers - John Carmack's cache optimization
func alignMemory(size uintptr) uintptr {
	const alignment = 64 // Cache line size
	return (size + alignment - 1) &^ (alignment - 1)
}

// Cache-friendly memory allocation
func allocateAligned(size int) []byte {
	alignedSize := alignMemory(uintptr(size))
	return make([]byte, alignedSize)
}

// Prefetch memory for better cache utilization
func prefetchMemory(data unsafe.Pointer) {
	// Platform-specific prefetch instructions would go here
	_ = data
}

// dispatchJob dispatches a job to appropriate hardware
func (e *UnifiedEngine) dispatchJob(job interface{}) {
	// Type assertion to handle both Job and MiningJob types
	var algo AlgorithmType
	var height uint64
	
	switch j := job.(type) {
	case *Job:
		algo = j.Algorithm
		height = j.Height
	case *MiningJob:
		algo = j.Algorithm
		height = j.Height
	default:
		e.logger.Error("Unknown job type", zap.String("type", fmt.Sprintf("%T", job)))
		return
	}
	
	// Dispatch based on algorithm and hardware availability
	switch {
	case algo == RandomX && len(e.cpuMiners) > 0:
		// Dispatch to CPU
		e.dispatchToCPU(job, height)
	case (algo == Ethash || algo == KawPow) && len(e.gpuMiners) > 0:
		// Dispatch to GPU
		e.dispatchToGPU(job, height)
	case algo == SHA256D && len(e.asicMiners) > 0:
		// Dispatch to ASIC
		e.dispatchToASIC(job, height)
	default:
		// Fallback to workers
		e.dispatchToWorkers(job)
	}
}

// dispatchToCPU dispatches job to CPU miners
func (e *UnifiedEngine) dispatchToCPU(job interface{}, height uint64) {
	e.workersMu.RLock()
	defer e.workersMu.RUnlock()
	
	if len(e.cpuMiners) > 0 {
		minerIdx := int(height) % len(e.cpuMiners)
		if mj, ok := job.(*MiningJob); ok {
			e.cpuMiners[minerIdx].SubmitJob(mj)
		}
	}
}

// dispatchToGPU dispatches job to GPU miners
func (e *UnifiedEngine) dispatchToGPU(job interface{}, height uint64) {
	e.workersMu.RLock()
	defer e.workersMu.RUnlock()
	
	if len(e.gpuMiners) > 0 {
		minerIdx := int(height) % len(e.gpuMiners)
		if mj, ok := job.(*MiningJob); ok {
			e.gpuMiners[minerIdx].SubmitJob(mj)
		}
	}
}

// dispatchToASIC dispatches job to ASIC miners
func (e *UnifiedEngine) dispatchToASIC(job interface{}, height uint64) {
	e.workersMu.RLock()
	defer e.workersMu.RUnlock()
	
	if len(e.asicMiners) > 0 {
		minerIdx := int(height) % len(e.asicMiners)
		if mj, ok := job.(*MiningJob); ok {
			e.asicMiners[minerIdx].SubmitJob(mj)
		}
	}
}

// dispatchToWorkers dispatches job to generic workers
func (e *UnifiedEngine) dispatchToWorkers(job interface{}) {
	// Use worker pool for dispatching
	if e.workerPool != nil {
		e.workerPool.Submit(func() {
			// Process job with workers
			e.logger.Debug("Processing job with worker pool")
		})
	}
}

// MiningJob represents a mining job (compatibility type)
type MiningJob struct {
	ID           string
	Height       uint64
	PrevHash     [32]byte
	MerkleRoot   [32]byte
	Timestamp    uint32
	Bits         uint32
	Nonce        uint32
	Algorithm    AlgorithmType
	Difficulty   uint64
	CleanJobs    bool
}

// PerformanceMonitor tracks performance metrics
type PerformanceMonitor struct {
	engine       *UnifiedEngine
	logger       *zap.Logger
	interval     time.Duration
	hashRateHistory []uint64
	historyMu    sync.Mutex
}

// WorkerPool manages a pool of workers
type WorkerPool struct {
	logger   *zap.Logger
	jobQueue *EfficientJobQueue
	size     int
}

// NewWorkerPool creates a new worker pool
func NewWorkerPool(logger *zap.Logger, jobQueue *EfficientJobQueue, size int) *WorkerPool {
	return &WorkerPool{
		logger:   logger,
		jobQueue: jobQueue,
		size:     size,
	}
}

// Start starts the worker pool
func (wp *WorkerPool) Start() error {
	// Implementation would start worker goroutines
	return nil
}

// Stop stops the worker pool
func (wp *WorkerPool) Stop() {
	// Implementation would stop worker goroutines
}

// Submit submits a task to the worker pool
func (wp *WorkerPool) Submit(task func()) {
	// Implementation would submit task to workers
	go task()
}

// GetAlgorithmManager returns the algorithm manager
func (e *UnifiedEngine) GetAlgorithmManager() *AlgorithmManager {
	return e.algManager
}

// GetProfitCalculator returns the profit calculator
func (e *UnifiedEngine) GetProfitCalculator() *ProfitCalculator {
	return e.profitCalc
}

// SetPowerCost updates the electricity cost for profit calculations
func (e *UnifiedEngine) SetPowerCost(costPerKWh float64) {
	if e.profitCalc != nil {
		e.profitCalc.UpdatePowerCost(costPerKWh)
	}
}

// GetProfitabilityData returns current profitability data for all algorithms
func (e *UnifiedEngine) GetProfitabilityData() []ProfitabilityData {
	if e.algManager != nil {
		return e.algManager.GetProfitabilityData()
	}
	return nil
}

// GetAlgorithmComparison compares profitability across algorithms
func (e *UnifiedEngine) GetAlgorithmComparison() []AlgorithmComparison {
	if e.profitCalc == nil {
		return nil
	}
	
	// Create hardware profile based on current configuration
	hardware := &MiningHardware{
		Name:      "Otedama Miner",
		PowerDraw: 1000, // Default 1000W
		Hashrate:  make(map[AlgorithmType]float64),
	}
	
	// Set hashrates based on hardware type
	if e.config.CPUThreads > 0 {
		hardware.Hashrate[RandomX] = 10000 // 10 KH/s for RandomX on CPU
		hardware.Hashrate[SHA256D] = 100000000 // 100 MH/s
	}
	
	if len(e.config.GPUDevices) > 0 {
		hardware.Hashrate[Ethash] = 30000000 // 30 MH/s
		hardware.Hashrate[KawPow] = 20000000 // 20 MH/s
	}
	
	if len(e.config.ASICDevices) > 0 {
		hardware.Hashrate[SHA256D] = 100000000000000 // 100 TH/s
	}
	
	return e.profitCalc.CompareAlgorithms(hardware)
}

// EnableProfitSwitching enables automatic profit-based algorithm switching
func (e *UnifiedEngine) EnableProfitSwitching(threshold float64) {
	if e.algManager != nil {
		e.algManager.SetProfitThreshold(threshold)
		e.logger.Info("Profit-based algorithm switching enabled",
			zap.Float64("threshold", threshold))
	}
}
