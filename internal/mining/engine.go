package mining

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/core"
	"go.uber.org/zap"
)

// Engine provides a unified mining engine supporting CPU, GPU, and ASIC hardware
// Following design principles from Carmack (performance), Martin (clean architecture), and Pike (simplicity)
type Engine struct {
	logger          *zap.Logger
	config          Config
	hardwareType    HardwareType
	
	// Hardware-specific engines
	cpuEngine       *CPUEngine
	gpuEngine       *ModernGPUMiner
	asicEngine      *AdvancedASICMiner
	
	// Common components
	jobManager      *JobManager
	shareValidator  *ShareValidator
	difficultyMgr   *DifficultyManager
	algorithmMgr    *AlgorithmManager
	
	// Error handling
	errorHandler    *core.ErrorHandler
	recoveryManager *core.RecoveryManager
	
	// Performance tracking
	hashRate        atomic.Uint64
	totalShares     atomic.Uint64
	acceptedShares  atomic.Uint64
	rejectedShares  atomic.Uint64
	failedShares    atomic.Uint64
	errorCount      atomic.Uint64
	uptime          atomic.Int64
	
	// State management
	running         atomic.Bool
	ctx             context.Context
	cancel          context.CancelFunc
	mu              sync.RWMutex
}

// Config defines mining engine configuration
type Config struct {
	// Hardware configuration
	HardwareType    HardwareType    `yaml:"hardware_type" json:"hardware_type"`
	AutoDetect      bool            `yaml:"auto_detect" json:"auto_detect"`
	
	// Algorithm configuration
	Algorithm       MiningAlgorithm `yaml:"algorithm" json:"algorithm"`
	AlgorithmParams AlgorithmParams `yaml:"algorithm_params" json:"algorithm_params"`
	
	// Performance configuration
	Threads         int             `yaml:"threads" json:"threads"`
	Intensity       int             `yaml:"intensity" json:"intensity"`
	WorkSize        int             `yaml:"work_size" json:"work_size"`
	
	// Hardware-specific configs
	CPU             CPUConfig       `yaml:"cpu" json:"cpu"`
	GPU             GPUConfig       `yaml:"gpu" json:"gpu"`
	ASIC            ASICConfig      `yaml:"asic" json:"asic"`
	
	// Common settings
	MaxTemp         int             `yaml:"max_temp" json:"max_temp"`
	PowerLimit      int             `yaml:"power_limit" json:"power_limit"`
	AutoTuning      bool            `yaml:"auto_tuning" json:"auto_tuning"`
}

// HardwareType represents the type of mining hardware
type HardwareType string

const (
	HardwareCPU  HardwareType = "cpu"
	HardwareGPU  HardwareType = "gpu"
	HardwareASIC HardwareType = "asic"
	HardwareAuto HardwareType = "auto"
)

// MiningAlgorithm represents supported mining algorithms
type MiningAlgorithm string

const (
	AlgorithmSHA256d   MiningAlgorithm = "sha256d"   // Bitcoin
	AlgorithmEthash    MiningAlgorithm = "ethash"    // Ethereum
	AlgorithmKawPow    MiningAlgorithm = "kawpow"    // Ravencoin
	AlgorithmRandomX   MiningAlgorithm = "randomx"   // Monero
	AlgorithmScrypt    MiningAlgorithm = "scrypt"    // Litecoin
	AlgorithmProgPow   MiningAlgorithm = "progpow"   // ProgPoW
	AlgorithmCuckoo    MiningAlgorithm = "cuckoo"    // Grin
)

// AlgorithmParams contains algorithm-specific parameters
type AlgorithmParams struct {
	MemorySize      int             `yaml:"memory_size" json:"memory_size"`
	Iterations      int             `yaml:"iterations" json:"iterations"`
	Parallelism     int             `yaml:"parallelism" json:"parallelism"`
	CustomParams    map[string]interface{} `yaml:"custom_params" json:"custom_params"`
}

// MiningJob represents a mining work unit
type MiningJob struct {
	ID              string          `json:"id"`
	Algorithm       MiningAlgorithm `json:"algorithm"`
	Data            []byte          `json:"data"`
	Target          []byte          `json:"target"`
	ExtraNonce      []byte          `json:"extra_nonce"`
	Height          uint64          `json:"height"`
	Difficulty      float64         `json:"difficulty"`
	CleanJob        bool            `json:"clean_job"`
	Timestamp       time.Time       `json:"timestamp"`
}

// Share represents a mining share submission
type Share struct {
	JobID           string          `json:"job_id"`
	Nonce           uint64          `json:"nonce"`
	ExtraNonce      []byte          `json:"extra_nonce"`
	Hash            []byte          `json:"hash"`
	Difficulty      float64         `json:"difficulty"`
	Timestamp       time.Time       `json:"timestamp"`
	HardwareID      string          `json:"hardware_id"`
}

// MiningStats represents mining statistics
type MiningStats struct {
	HashRate        float64         `json:"hash_rate"`
	Shares          ShareStats      `json:"shares"`
	Temperature     float64         `json:"temperature"`
	PowerUsage      float64         `json:"power_usage"`
	Efficiency      float64         `json:"efficiency"`
	Uptime          time.Duration   `json:"uptime"`
	Hardware        HardwareStats   `json:"hardware"`
}

// ShareStats represents share statistics
type ShareStats struct {
	Accepted        uint64          `json:"accepted"`
	Rejected        uint64          `json:"rejected"`
	Stale           uint64          `json:"stale"`
	Duplicate       uint64          `json:"duplicate"`
	LowDiff         uint64          `json:"low_diff"`
}

// HardwareStats represents hardware-specific statistics
type HardwareStats struct {
	Type            HardwareType    `json:"type"`
	Devices         int             `json:"devices"`
	ActiveThreads   int             `json:"active_threads"`
	MemoryUsage     int64           `json:"memory_usage"`
	Errors          uint64          `json:"errors"`
}

// NewEngine creates a new unified mining engine
func NewEngine(config Config, logger *zap.Logger) (*Engine, error) {
	// Auto-detect hardware if requested
	if config.AutoDetect || config.HardwareType == HardwareAuto {
		hardwareType := detectBestHardware(logger)
		config.HardwareType = hardwareType
	}
	
	// Validate configuration
	if err := validateConfig(&config); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}
	
	// Create base engine
	ctx, cancel := context.WithCancel(context.Background())
	engine := &Engine{
		logger:   logger,
		config:   config,
		hardwareType: config.HardwareType,
		ctx:      ctx,
		cancel:   cancel,
	}
	
	// Initialize common components
	engine.jobManager = NewJobManager(logger)
	engine.shareValidator = NewShareValidator(logger)
	engine.difficultyMgr = NewDifficultyManager(config.Algorithm, logger)
	engine.algorithmMgr = NewAlgorithmManager(logger)
	
	// Initialize error handling
	engine.errorHandler = core.NewErrorHandler(logger)
	engine.recoveryManager = core.NewRecoveryManager(logger, engine.errorHandler)
	
	// Register mining-specific recovery strategies
	engine.registerRecoveryStrategies()
	
	// Register health checks
	engine.registerHealthChecks()
	
	// Initialize hardware-specific engine
	if err := engine.initializeHardware(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to initialize hardware: %w", err)
	}
	
	logger.Info("Mining engine created",
		zap.String("hardware_type", string(config.HardwareType)),
		zap.String("algorithm", string(config.Algorithm)),
	)
	
	return engine, nil
}

// initializeHardware initializes the hardware-specific mining engine
func (e *Engine) initializeHardware() error {
	switch e.hardwareType {
	case HardwareCPU:
		cpuEngine, err := NewCPUEngine(e.config.CPU, e.logger)
		if err != nil {
			return fmt.Errorf("failed to create CPU engine: %w", err)
		}
		e.cpuEngine = cpuEngine
		
	case HardwareGPU:
		gpuEngine, err := NewModernGPUMiner(e.logger, e.config.GPU)
		if err != nil {
			return fmt.Errorf("failed to create GPU engine: %w", err)
		}
		e.gpuEngine = gpuEngine
		
	case HardwareASIC:
		asicEngine, err := NewAdvancedASICMiner(e.logger, e.config.ASIC)
		if err != nil {
			return fmt.Errorf("failed to create ASIC engine: %w", err)
		}
		e.asicEngine = asicEngine
		
	default:
		return fmt.Errorf("unsupported hardware type: %s", e.hardwareType)
	}
	
	return nil
}

// detectBestHardware detects the best available mining hardware
func detectBestHardware(logger *zap.Logger) HardwareType {
	// Check for ASIC first (highest performance)
	if hasASICSupport() {
		logger.Info("ASIC hardware detected")
		return HardwareASIC
	}
	
	// Check for GPU (better than CPU)
	if hasGPUSupport() {
		logger.Info("GPU hardware detected")
		return HardwareGPU
	}
	
	// Default to CPU
	logger.Info("Using CPU for mining")
	return HardwareCPU
}

// validateConfig validates the mining configuration
func validateConfig(config *Config) error {
	// Set defaults
	if config.Threads <= 0 {
		config.Threads = runtime.NumCPU()
	}
	
	if config.WorkSize <= 0 {
		config.WorkSize = 256 * 1024 // 256KB default
	}
	
	if config.MaxTemp <= 0 {
		config.MaxTemp = 85 // 85°C default
	}
	
	// Validate algorithm
	if !isValidAlgorithm(config.Algorithm) {
		return fmt.Errorf("unsupported algorithm: %s", config.Algorithm)
	}
	
	return nil
}

// Start starts the mining engine
func (e *Engine) Start() error {
	if !e.running.CompareAndSwap(false, true) {
		return core.NewError("ENGINE_ALREADY_RUNNING", "mining engine already running", core.ErrorCategoryMining, core.ErrorSeverityLow)
	}
	
	// Add panic recovery
	defer func() {
		if r := recover(); r != nil {
			e.running.Store(false)
			core.PanicRecovery(e.logger)
		}
	}()
	
	e.logger.Info("Starting mining engine",
		zap.String("hardware", string(e.hardwareType)),
		zap.String("algorithm", string(e.config.Algorithm)),
	)
	
	// Record start time
	e.uptime.Store(time.Now().Unix())
	
	// Start recovery manager
	e.recoveryManager.Start(e.ctx)
	
	// Start hardware-specific engine with error handling
	var err error
	switch e.hardwareType {
	case HardwareCPU:
		err = e.cpuEngine.Start(e.ctx)
	case HardwareGPU:
		err = e.gpuEngine.Start(e.ctx, string(e.config.Algorithm))
	case HardwareASIC:
		err = e.asicEngine.Start(e.ctx)
	}
	
	if err != nil {
		e.running.Store(false)
		otedamaErr := core.NewError("ENGINE_START_FAILED", "failed to start mining engine", core.ErrorCategoryMining, core.ErrorSeverityHigh).
			WithCause(err).
			WithContext("hardware_type", string(e.hardwareType)).
			WithRetry(5 * time.Second)
		
		// Attempt recovery
		if recoveryErr := e.errorHandler.Handle(e.ctx, otedamaErr); recoveryErr != nil {
			return recoveryErr
		}
		return otedamaErr
	}
	
	// Start monitoring routines
	go e.monitorPerformance(e.ctx)
	go e.processShares(e.ctx)
	go e.monitorErrors(e.ctx)
	
	return nil
}

// Stop stops the mining engine
func (e *Engine) Stop() error {
	if !e.running.CompareAndSwap(true, false) {
		return nil // Already stopped
	}
	
	e.logger.Info("Stopping mining engine")
	
	// Stop recovery manager
	if e.recoveryManager != nil {
		e.recoveryManager.Stop()
	}
	
	// Cancel context to stop all goroutines
	e.cancel()
	
	// Stop hardware-specific engine with timeout
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer stopCancel()
	
	var err error
	switch e.hardwareType {
	case HardwareCPU:
		if e.cpuEngine != nil {
			err = e.cpuEngine.Stop()
		}
	case HardwareGPU:
		if e.gpuEngine != nil {
			err = e.gpuEngine.Stop()
		}
	case HardwareASIC:
		if e.asicEngine != nil {
			err = e.asicEngine.Stop()
		}
	}
	
	if err != nil {
		otedamaErr := core.NewError("ENGINE_STOP_FAILED", "error stopping hardware engine", core.ErrorCategoryMining, core.ErrorSeverityMedium).
			WithCause(err).
			WithContext("hardware_type", string(e.hardwareType))
		e.errorHandler.Handle(stopCtx, otedamaErr)
	}
	
	return err
}

// SubmitJob submits a new mining job
func (e *Engine) SubmitJob(job *MiningJob) error {
	if !e.running.Load() {
		return fmt.Errorf("mining engine not running")
	}
	
	e.mu.Lock()
	defer e.mu.Unlock()
	
	// Validate job
	if err := e.validateJob(job); err != nil {
		return fmt.Errorf("invalid job: %w", err)
	}
	
	// Update job in job manager
	e.jobManager.UpdateJob(job)
	
	// Submit to hardware-specific engine
	switch e.hardwareType {
	case HardwareCPU:
		if e.cpuEngine != nil {
			e.cpuEngine.SetWork(Work{
				Data:      job.Data,
				Target:    job.Target,
				Height:    job.Height,
				Timestamp: job.Timestamp,
			})
		}
		
	case HardwareGPU:
		if e.gpuEngine != nil {
			// GPU engines process work differently
			// In a real implementation, this would submit to GPU kernel
			e.logger.Debug("GPU job submission", zap.String("job_id", job.ID))
		}
		
	case HardwareASIC:
		if e.asicEngine != nil {
			// ASIC engines have dedicated firmware for job processing
			// In a real implementation, this would communicate with ASIC firmware
			e.logger.Debug("ASIC job submission", zap.String("job_id", job.ID))
		}
	}
	
	e.logger.Debug("New job submitted",
		zap.String("job_id", job.ID),
		zap.String("algorithm", string(job.Algorithm)),
		zap.Uint64("height", job.Height),
	)
	
	return nil
}

// validateJob validates a mining job
func (e *Engine) validateJob(job *MiningJob) error {
	if job == nil {
		return fmt.Errorf("job is nil")
	}
	
	if job.ID == "" {
		return fmt.Errorf("job ID is empty")
	}
	
	if len(job.Data) == 0 {
		return fmt.Errorf("job data is empty")
	}
	
	if len(job.Target) == 0 {
		return fmt.Errorf("job target is empty")
	}
	
	if job.Algorithm != e.config.Algorithm {
		return fmt.Errorf("job algorithm %s doesn't match engine algorithm %s", 
			job.Algorithm, e.config.Algorithm)
	}
	
	return nil
}

// GetStats returns current mining statistics
func (e *Engine) GetStats() MiningStats {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	stats := MiningStats{
		HashRate: float64(e.hashRate.Load()),
		Shares: ShareStats{
			Accepted: e.acceptedShares.Load(),
			Rejected: e.rejectedShares.Load(),
			Stale:    e.failedShares.Load(), // Using failedShares for stale count
		},
		Uptime: time.Duration(time.Now().Unix() - e.uptime.Load()) * time.Second,
		Hardware: HardwareStats{
			Type: e.hardwareType,
		},
	}
	
	// Get hardware-specific stats
	switch e.hardwareType {
	case HardwareCPU:
		if e.cpuEngine != nil {
			cpuStats := e.cpuEngine.GetStats()
			stats.HashRate = float64(cpuStats["hash_rate"].(uint64))
			stats.Hardware.ActiveThreads = cpuStats["threads"].(int)
		}
		
	case HardwareGPU:
		if e.gpuEngine != nil {
			gpuStats := e.gpuEngine.GetStats()
			if temp, ok := gpuStats["temperature"].(float64); ok {
				stats.Temperature = temp
			}
			if power, ok := gpuStats["power_usage"].(float64); ok {
				stats.PowerUsage = power
			}
			if devices, ok := gpuStats["device_count"].(int); ok {
				stats.Hardware.Devices = devices
			}
		}
		
	case HardwareASIC:
		if e.asicEngine != nil {
			asicStats := e.asicEngine.GetStats()
			if temp, ok := asicStats["average_temp"].(float64); ok {
				stats.Temperature = temp
			}
			if power, ok := asicStats["total_power"].(float64); ok {
				stats.PowerUsage = power
			}
			if eff, ok := asicStats["efficiency"].(float64); ok {
				stats.Efficiency = eff
			}
			if devices, ok := asicStats["device_count"].(int); ok {
				stats.Hardware.Devices = devices
			}
		}
	}
	
	return stats
}

// GetHashRate returns the current hash rate
func (e *Engine) GetHashRate() float64 {
	return float64(e.hashRate.Load())
}

// monitorPerformance monitors and updates performance metrics
func (e *Engine) monitorPerformance(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.updateHashRate()
			e.checkThermalLimits()
			e.optimizePower()
		}
	}
}

// updateHashRate updates the current hash rate
func (e *Engine) updateHashRate() {
	var hashRate uint64
	
	switch e.hardwareType {
	case HardwareCPU:
		if e.cpuEngine != nil {
			hashRate = e.cpuEngine.GetHashRate()
		}
	case HardwareGPU:
		if e.gpuEngine != nil {
			stats := e.gpuEngine.GetStats()
			if hr, ok := stats["hash_rate"].(uint64); ok {
				hashRate = hr
			}
		}
	case HardwareASIC:
		if e.asicEngine != nil {
			stats := e.asicEngine.GetStats()
			if hr, ok := stats["total_hashrate"].(uint64); ok {
				hashRate = hr
			}
		}
	}
	
	e.hashRate.Store(hashRate)
}

// processShares processes mining shares
func (e *Engine) processShares(ctx context.Context) {
	// This would handle share processing in a real implementation
	// For now, it's a placeholder for share validation and submission
}

// checkThermalLimits checks and enforces thermal limits
func (e *Engine) checkThermalLimits() {
	stats := e.GetStats()
	
	if stats.Temperature > float64(e.config.MaxTemp) {
		e.logger.Warn("Temperature limit exceeded",
			zap.Float64("current_temp", stats.Temperature),
			zap.Int("max_temp", e.config.MaxTemp),
		)
		
		// Create temperature error for handling
		err := core.NewError("TEMP_LIMIT_EXCEEDED", "temperature limit exceeded",
			core.ErrorCategoryMining, core.ErrorSeverityHigh).
			WithContext("current_temp", stats.Temperature).
			WithContext("max_temp", e.config.MaxTemp).
			WithRetry(30 * time.Second)
		
		// Trigger recovery through error handler
		e.errorHandler.Handle(e.ctx, err)
	}
}

// optimizePower optimizes power consumption
func (e *Engine) optimizePower() {
	if !e.config.AutoTuning {
		return
	}
	
	stats := e.GetStats()
	
	// Simple power optimization based on efficiency
	if stats.PowerUsage > float64(e.config.PowerLimit) {
		e.logger.Debug("Optimizing power consumption",
			zap.Float64("current_power", stats.PowerUsage),
			zap.Int("power_limit", e.config.PowerLimit),
		)
		
		// Implement power optimization
		// This would adjust clocks, voltages, or intensity
	}
}

// SubmitShare submits a found share
func (e *Engine) SubmitShare(share *Share) error {
	if !e.running.Load() {
		return core.NewError("ENGINE_NOT_RUNNING", "mining engine not running", 
			core.ErrorCategoryMining, core.ErrorSeverityLow)
	}
	
	// Update total shares
	e.totalShares.Add(1)
	
	// Validate share with error handling
	valid, err := e.shareValidator.Validate(share)
	if err != nil {
		e.failedShares.Add(1)
		otedamaErr := core.NewError("SHARE_VALIDATION_FAILED", "failed to validate share", 
			core.ErrorCategoryValidation, core.ErrorSeverityMedium).
			WithCause(err).
			WithContext("job_id", share.JobID).
			WithContext("nonce", share.Nonce)
		return e.errorHandler.Handle(e.ctx, otedamaErr)
	}
	
	if !valid {
		e.rejectedShares.Add(1)
		otedamaErr := core.NewError("SHARE_REJECTED", "share rejected", 
			core.ErrorCategoryValidation, core.ErrorSeverityLow).
			WithContext("job_id", share.JobID).
			WithContext("difficulty", share.Difficulty)
		
		// Log rejected share
		e.logger.Debug("Share rejected",
			zap.String("job_id", share.JobID),
			zap.Uint64("nonce", share.Nonce),
		)
		
		return otedamaErr
	}
	
	// Update statistics
	e.acceptedShares.Add(1)
	
	e.logger.Info("Share accepted",
		zap.String("job_id", share.JobID),
		zap.Uint64("nonce", share.Nonce),
		zap.Float64("difficulty", share.Difficulty),
	)
	
	return nil
}

// SetDifficulty updates the mining difficulty
func (e *Engine) SetDifficulty(difficulty float64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	e.difficultyMgr.SetDifficulty(difficulty)
	
	// Update hardware-specific difficulty
	switch e.hardwareType {
	case HardwareCPU:
		if e.cpuEngine != nil {
			e.cpuEngine.SetDifficulty(uint32(difficulty))
		}
	case HardwareGPU:
		if e.gpuEngine != nil {
			// GPU engines handle difficulty internally based on algorithm
			e.logger.Debug("GPU difficulty update", zap.Float64("difficulty", difficulty))
		}
	case HardwareASIC:
		if e.asicEngine != nil {
			// ASIC engines have firmware-managed difficulty
			e.logger.Debug("ASIC difficulty update", zap.Float64("difficulty", difficulty))
		}
	}
	
	e.logger.Info("Difficulty updated", zap.Float64("difficulty", difficulty))
}

// Helper functions

// isValidAlgorithm checks if the algorithm is supported
func isValidAlgorithm(algo MiningAlgorithm) bool {
	switch algo {
	case AlgorithmSHA256d, AlgorithmEthash, AlgorithmKawPow,
		 AlgorithmRandomX, AlgorithmScrypt, AlgorithmProgPow, AlgorithmCuckoo:
		return true
	default:
		return false
	}
}

// hasGPUSupport checks if GPU mining is available
func hasGPUSupport() bool {
	// This would check for CUDA/OpenCL support
	// Simplified for now
	return false
}

// hasASICSupport checks if ASIC mining is available
func hasASICSupport() bool {
	// This would check for ASIC devices
	// Simplified for now
	return false
}

// Component interfaces (would be in separate files in real implementation)

// JobManager manages mining jobs
type JobManager struct {
	logger      *zap.Logger
	currentJob  atomic.Value // *MiningJob
	jobHistory  sync.Map     // job_id -> *MiningJob
}

func NewJobManager(logger *zap.Logger) *JobManager {
	return &JobManager{logger: logger}
}

func (jm *JobManager) UpdateJob(job *MiningJob) {
	jm.currentJob.Store(job)
	jm.jobHistory.Store(job.ID, job)
}

// ShareValidator validates mining shares
type ShareValidator struct {
	logger *zap.Logger
}

func NewShareValidator(logger *zap.Logger) *ShareValidator {
	return &ShareValidator{logger: logger}
}

func (sv *ShareValidator) Validate(share *Share) (bool, error) {
	// Simplified validation
	if share == nil || len(share.Hash) == 0 {
		return false, fmt.Errorf("invalid share data")
	}
	return true, nil
}

// DifficultyManager manages mining difficulty
type DifficultyManager struct {
	logger         *zap.Logger
	algorithm      MiningAlgorithm
	currentDiff    atomic.Value // float64
}

func NewDifficultyManager(algo MiningAlgorithm, logger *zap.Logger) *DifficultyManager {
	dm := &DifficultyManager{
		logger:    logger,
		algorithm: algo,
	}
	dm.currentDiff.Store(1.0)
	return dm
}

func (dm *DifficultyManager) SetDifficulty(diff float64) {
	dm.currentDiff.Store(diff)
}

// AlgorithmManager manages mining algorithms
type AlgorithmManager struct {
	logger *zap.Logger
}

func NewAlgorithmManager(logger *zap.Logger) *AlgorithmManager {
	return &AlgorithmManager{logger: logger}
}

// MiningConfig is an alias for Config (for backward compatibility)
type MiningConfig = Config

// registerRecoveryStrategies registers mining-specific recovery strategies
func (e *Engine) registerRecoveryStrategies() {
	// Register hardware-specific recovery strategy
	e.errorHandler.RegisterRecoveryFunc(core.ErrorCategoryMining, e.miningRecovery)
}

// registerHealthChecks registers mining health checks
func (e *Engine) registerHealthChecks() {
	e.recoveryManager.RegisterHealthCheck(&MiningEngineHealthCheck{engine: e})
	e.recoveryManager.RegisterHealthCheck(&HashRateHealthCheck{engine: e})
	e.recoveryManager.RegisterHealthCheck(&TemperatureHealthCheck{engine: e})
}

// miningRecovery attempts to recover from mining errors
func (e *Engine) miningRecovery(ctx context.Context, err error) error {
	e.logger.Info("Attempting mining recovery", zap.Error(err))
	
	// Increment error count
	e.errorCount.Add(1)
	
	// Try recovery strategies in order
	strategies := []func(context.Context) error{
		e.resetHardware,
		e.reduceIntensity,
		e.switchAlgorithm,
		e.restartEngine,
	}
	
	for _, strategy := range strategies {
		if err := strategy(ctx); err == nil {
			e.logger.Info("Mining recovery successful")
			return nil
		}
	}
	
	return fmt.Errorf("all mining recovery strategies failed")
}

// Recovery strategies

func (e *Engine) resetHardware(ctx context.Context) error {
	e.logger.Info("Resetting hardware")
	
	switch e.hardwareType {
	case HardwareCPU:
		// CPU doesn't need hardware reset
		return nil
	case HardwareGPU:
		// GPU reset would be implemented here
		return nil
	case HardwareASIC:
		// ASIC reset would be implemented here
		return nil
	}
	
	return nil
}

func (e *Engine) reduceIntensity(ctx context.Context) error {
	e.logger.Info("Reducing mining intensity")
	
	e.mu.Lock()
	defer e.mu.Unlock()
	
	// Reduce intensity by 10%
	if e.config.Intensity > 10 {
		e.config.Intensity = int(float64(e.config.Intensity) * 0.9)
		e.logger.Info("Intensity reduced", zap.Int("new_intensity", e.config.Intensity))
	}
	
	return nil
}

func (e *Engine) switchAlgorithm(ctx context.Context) error {
	e.logger.Info("Switching algorithm temporarily")
	// This would implement algorithm switching logic
	return fmt.Errorf("algorithm switching not implemented")
}

func (e *Engine) restartEngine(ctx context.Context) error {
	e.logger.Info("Restarting mining engine")
	
	// Stop engine
	if err := e.Stop(); err != nil {
		return fmt.Errorf("failed to stop engine: %w", err)
	}
	
	// Wait a bit
	select {
	case <-time.After(5 * time.Second):
	case <-ctx.Done():
		return ctx.Err()
	}
	
	// Start engine
	if err := e.Start(); err != nil {
		return fmt.Errorf("failed to restart engine: %w", err)
	}
	
	return nil
}

// monitorErrors monitors for errors and triggers recovery if needed
func (e *Engine) monitorErrors(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Check error rate
			errorRate := e.calculateErrorRate()
			if errorRate > 0.1 { // More than 10% error rate
				e.logger.Warn("High error rate detected",
					zap.Float64("error_rate", errorRate))
				
				err := core.NewError("HIGH_ERROR_RATE", "mining error rate too high", 
					core.ErrorCategoryMining, core.ErrorSeverityHigh).
					WithContext("error_rate", errorRate).
					WithRetry(time.Minute)
				
				e.errorHandler.Handle(ctx, err)
			}
		}
	}
}

// calculateErrorRate calculates the current error rate
func (e *Engine) calculateErrorRate() float64 {
	total := e.totalShares.Load()
	failed := e.failedShares.Load()
	
	if total == 0 {
		return 0
	}
	
	return float64(failed) / float64(total)
}

// Health check implementations

// MiningEngineHealthCheck checks if mining engine is running
type MiningEngineHealthCheck struct {
	engine *Engine
}

func (c *MiningEngineHealthCheck) Name() string {
	return "mining_engine"
}

func (c *MiningEngineHealthCheck) Check(ctx context.Context) error {
	if !c.engine.running.Load() {
		return fmt.Errorf("mining engine not running")
	}
	return nil
}

func (c *MiningEngineHealthCheck) Critical() bool {
	return true
}

// HashRateHealthCheck checks if hash rate is acceptable
type HashRateHealthCheck struct {
	engine *Engine
}

func (c *HashRateHealthCheck) Name() string {
	return "hash_rate"
}

func (c *HashRateHealthCheck) Check(ctx context.Context) error {
	hashRate := c.engine.GetHashRate()
	if hashRate == 0 && c.engine.running.Load() {
		return fmt.Errorf("zero hash rate while mining")
	}
	return nil
}

func (c *HashRateHealthCheck) Critical() bool {
	return false
}

// TemperatureHealthCheck checks if temperature is within limits
type TemperatureHealthCheck struct {
	engine *Engine
}

func (c *TemperatureHealthCheck) Name() string {
	return "temperature"
}

func (c *TemperatureHealthCheck) Check(ctx context.Context) error {
	stats := c.engine.GetStats()
	if stats.Temperature > float64(c.engine.config.MaxTemp) {
		return fmt.Errorf("temperature %.1f exceeds limit %d", 
			stats.Temperature, c.engine.config.MaxTemp)
	}
	return nil
}

func (c *TemperatureHealthCheck) Critical() bool {
	return true
}