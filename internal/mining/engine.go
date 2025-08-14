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

// P2PEngine defines the core P2P mining engine interface following interface segregation principle.
// The interface is divided into logical groups for better organization and understanding.
type P2PEngine interface {
	// Lifecycle management
	Start() error
	Stop() error
	
	// Statistics and monitoring
	GetStats() *Stats
	GetStatus() *EngineStatus
	GetStartTime() time.Time
	GetStatsHistory(duration time.Duration) []StatsSnapshot
	ResetStats()
	
	// Algorithm management
	GetAlgorithm() AlgorithmType
	SetAlgorithm(AlgorithmType) error
	SwitchAlgorithm(AlgorithmType) error
	GetSupportedAlgorithms() []string
	ValidateAlgorithm(algorithm string) bool
	
	// Currency support
	SetActiveCurrency(symbol string) error
	GetActiveCurrency() string
	
	// Hardware configuration
	GetCPUThreads() int
	SetCPUThreads(threads int) error
	SetGPUSettings(coreClock, memoryClock, powerLimit int) error
	GetHardwareInfo() *HardwareInfo
	HasGPU() bool
	HasCPU() bool
	HasASIC() bool
	
	// Pool management
	SetPool(url, wallet string) error
	SubmitShare(*Share) error
	GetCurrentJob() *Job
	
	// Configuration and optimization
	GetConfig() map[string]interface{}
	SetConfig(key string, value interface{}) error
	GetAutoTuner() *AutoTuner
	GetProfitSwitcher() *ProfitSwitcher
}

// Engine is an alias maintained for backward compatibility across packages.
// It maps to the primary mining engine interface.
type Engine = P2PEngine

// System represents a complete mining system following clean architecture principles.
// It provides high-level operations for the entire mining system.
type System interface {
	// Lifecycle management
	Start() error
	Stop() error
	
	// System statistics
	GetStats() *Stats
	
	// Proof verification
	IsVerified(proofID string) bool
	VerifyProof(proofID string, data interface{}) error
}

// UnifiedP2PEngine implements a high-performance P2P mining engine with focus on:
// - Cache alignment for hot path optimization
// - Lock-free operations where possible
// - Clear separation of concerns
type UnifiedP2PEngine struct {
	logger *zap.Logger
	config *Config
	
	// Performance-critical fields (cache-aligned, most frequently accessed)
	totalHashRate    atomic.Uint64
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
	memoryOptimizer *MemoryOptimizer
	cpuOptimizer    *CPUOptimizer
	jobDispatcher   *FastJobDispatcher
	
	// Multi-currency support
	activeCurrency  string
	algorithmEngines map[string]AlgorithmEngine
	currencyMu      sync.RWMutex
	
	// Pool info
	poolURL    string
	walletAddr string
	
	// Stats history
	statsHistory []StatsSnapshot
	historyMu    sync.RWMutex
	
	// Hardware managers
	cpuManager   *CPUManager
	gpuManager   *GPUManager
	asicManager  *ASICManager
	
	// Legacy miners (for backward compatibility)
	cpuMiners    []*CPUMiner
	gpuMiners    []*GPUMiner
	asicMiners   []*ASICMiner
	
	// Job management - optimized for throughput
	jobQueue     *EfficientJobQueue
	jobChan      chan *Job
	shareChan    chan *Share
	shareValidator *OptimizedShareValidator
	
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
	MaxMemoryMB        int      `validate:"min=512,max=32768"`
	JobQueueSize       int      `validate:"min=10,max=10000"`
	MinShareDifficulty uint64   `validate:"min=1"`
	
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

// NewEngine creates optimized mining engine - Rob Pike's clear construction
func NewEngine(logger *zap.Logger, config *Config) (P2PEngine, error) {
	if config == nil {
		config = DefaultConfig()
	}
	
	if err := validateConfig(config); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	engine := &UnifiedP2PEngine{
		logger:    logger,
		config:    config,
		ctx:       ctx,
		cancel:    cancel,
		startTime: time.Now(),
		stats:     &OptimizedStats{}, // Use optimized stats from engine_optimizations.go
		
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
	engine.shareValidator = NewOptimizedShareValidator(logger, runtime.NumCPU())
	
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
	
	// Initialize optimization components from engine_optimizations.go
	engine.memoryOptimizer = NewMemoryOptimizer(config.MaxMemoryMB)
	engine.cpuOptimizer = NewCPUOptimizer()
	
	// Initialize hardware managers
	engine.cpuManager = NewCPUManager()
	engine.gpuManager = NewGPUManager()
	engine.asicManager = NewASICManager()
	
	// Initialize fast job dispatcher based on worker counts
	cpuWorkers := config.CPUThreads
	gpuWorkers := len(config.GPUDevices)
	asicWorkers := len(config.ASICDevices)
	engine.jobDispatcher = NewFastJobDispatcher(cpuWorkers, gpuWorkers, asicWorkers)
	
	// Detect and initialize workers
	if err := engine.initializeWorkers(); err != nil {
		cancel()
		return nil, fmt.Errorf("worker initialization failed: %w", err)
	}
	
	// Initialize hardware managers
	if err := engine.initializeHardwareManagers(); err != nil {
		cancel()
		return nil, fmt.Errorf("hardware manager initialization failed: %w", err)
	}
	
	return engine, nil
}

// Start starts the mining engine - optimized startup sequence
func (e *UnifiedP2PEngine) Start() error {
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
func (e *UnifiedP2PEngine) Stop() error {
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
func (e *UnifiedP2PEngine) GetStats() *Stats {
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
func (e *UnifiedP2PEngine) SubmitShare(share *Share) error {
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
func (e *UnifiedP2PEngine) SwitchAlgorithm(algo AlgorithmType) error {
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
func (e *UnifiedP2PEngine) GetAlgorithm() AlgorithmType {
	return e.algorithm.Load().(AlgorithmType)
}

// SetAlgorithm sets the mining algorithm
func (e *UnifiedP2PEngine) SetAlgorithm(algo AlgorithmType) error {
	return e.SwitchAlgorithm(algo)
}

// GetStatus returns the current engine status
func (e *UnifiedP2PEngine) GetStatus() *EngineStatus {
	return &EngineStatus{
		Running:   e.running.Load(),
		Algorithm: e.GetAlgorithm(),
		Pool:      e.poolURL,
		Wallet:    e.walletAddr,
		Uptime:    time.Since(e.startTime),
	}
}

// GetStartTime returns when the engine was started
func (e *UnifiedP2PEngine) GetStartTime() time.Time {
	return e.startTime
}

// GetHardwareInfo returns hardware information
func (e *UnifiedP2PEngine) GetHardwareInfo() *HardwareInfo {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	asicDevices := []ASICInfo{}
	if e.asicManager != nil {
		asicDevices = e.asicManager.GetDevices()
	}

	return &HardwareInfo{
		CPUThreads:  e.config.CPUThreads,
		GPUDevices:  []GPUInfo{}, // TODO: Implement GPU detection
		ASICDevices: asicDevices,
		TotalMemory: m.Sys,
		AvailMemory: m.Sys - m.Alloc,
	}
}

// HasASIC returns true if ASIC mining is enabled
func (e *UnifiedP2PEngine) HasASIC() bool {
	return len(e.config.ASICDevices) > 0 || e.asicManager != nil
}

// GetCurrentJob returns the current mining job
func (e *UnifiedP2PEngine) GetCurrentJob() *Job {
	return e.jobQueue.Peek()
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

// jobProcessor handles job distribution to mining workers.
// It runs in a tight loop for optimal performance, dequeueing jobs
// and dispatching them to appropriate hardware.
func (e *UnifiedEngine) jobProcessor() {
	defer e.wg.Done()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		default:
			// Process next job from the queue
			if err := e.processNextJob(); err != nil {
				// Only log non-cancellation errors
				if err != context.Canceled {
					e.logger.Error("Failed to process job", zap.Error(err))
				}
			}
		}
	}
}

// processNextJob dequeues and dispatches a single job.
// Extracted for better testability and clarity.
func (e *UnifiedEngine) processNextJob() error {
	job, err := e.jobQueue.Dequeue(e.ctx)
	if err != nil {
		return err
	}
	
	e.dispatchJob(job)
	return nil
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
			accepted := e.validateShare(share)
			
			// Update OptimizedStats if available
			if e.stats != nil {
				e.stats.IncrementShares(true, accepted)
			}
			
			// Also update legacy fields
			e.sharesSubmitted.Add(1)
			if accepted {
				e.sharesAccepted.Add(1)
			}
			
			// Return share to pool
			e.sharePool.Put(share)
			
		case <-e.ctx.Done():
			return
		}
	}
}

// validateShare performs fast validation of mining shares.
// Returns true if the share meets all validation criteria.
func (e *UnifiedEngine) validateShare(share *Share) bool {
	// Nil check
	if share == nil {
		return false
	}
	
	// Required field validation
	if !e.validateShareFields(share) {
		return false
	}
	
	// Difficulty validation
	if !e.validateShareDifficulty(share) {
		return false
	}
	
	// Algorithm-specific validation
	return e.validateShareAlgorithm(share)
}

// validateShareFields checks required share fields.
func (e *UnifiedEngine) validateShareFields(share *Share) bool {
	return share.JobID != "" && share.WorkerID != ""
}

// validateShareDifficulty checks share difficulty requirements.
func (e *UnifiedEngine) validateShareDifficulty(share *Share) bool {
	return share.Difficulty > 0 && share.Difficulty >= e.config.MinShareDifficulty
}

// validateShareAlgorithm performs algorithm-specific validation.
func (e *UnifiedEngine) validateShareAlgorithm(share *Share) bool {
	// TODO: Implement algorithm-specific validation
	// For now, return true for all valid shares
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

// updateHashRate calculates and updates the total hash rate across all workers.
// It categorizes rates by hardware type for detailed monitoring.
func (e *UnifiedEngine) updateHashRate() {
	rates := e.calculateHashRates()
	
	// Update statistics
	e.updateHashRateStats(rates)
}

// hashRates holds categorized hash rate data
type hashRates struct {
	total uint64
	cpu   uint64
	gpu   uint64
	asic  uint64
}

// calculateHashRates aggregates hash rates from all workers.
func (e *UnifiedEngine) calculateHashRates() hashRates {
	var rates hashRates
	
	e.workersMu.RLock()
	defer e.workersMu.RUnlock()
	
	for _, worker := range e.workers {
		rate := worker.GetHashRate()
		rates.total += rate
		
		// Categorize by hardware type
		switch worker.GetType() {
		case WorkerCPU:
			rates.cpu += rate
		case WorkerGPU:
			rates.gpu += rate
		case WorkerASIC:
			rates.asic += rate
		}
	}
	
	return rates
}

// updateHashRateStats updates both new and legacy statistics.
func (e *UnifiedEngine) updateHashRateStats(rates hashRates) {
	// Update OptimizedStats if available
	if e.stats != nil {
		e.stats.UpdateHashRate(rates.total, rates.cpu, rates.gpu, rates.asic)
	}
	
	// Update legacy atomic field for compatibility
	e.totalHashRate.Store(rates.total)
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

// runMemoryOptimizer runs the memory optimizer
func (e *UnifiedEngine) runMemoryOptimizer() {
	defer e.wg.Done()
	
	if e.memoryOptimizer == nil {
		return
	}
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			e.memoryOptimizer.OptimizeMemory()
		case <-e.ctx.Done():
			return
		}
	}
}

// performOptimization optimizes performance
func (e *UnifiedEngine) performOptimization() {
	// Use memory optimizer if available
	if e.memoryOptimizer != nil {
		e.memoryOptimizer.OptimizeMemory()
	} else {
		// Fallback to basic memory optimization
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
		CPUThreads:         runtime.NumCPU(),
		Algorithm:          "sha256d",
		Intensity:          80,
		MaxMemoryMB:        4096,
		JobQueueSize:       1000,
		MinShareDifficulty: 1000,
		AutoOptimize:       true,
		HugePages:          false,
		NUMA:               false,
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

// WorkerPool is now defined in efficient_job_queue.go to avoid duplication

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
