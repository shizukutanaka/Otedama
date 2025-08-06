package optimization

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MiningOptimizer optimizes mining algorithms for different hardware
// Following John Carmack's performance-first approach
type MiningOptimizer struct {
	logger *zap.Logger
	config OptimizerConfig
	
	// Algorithm optimizers
	optimizers map[string]AlgorithmOptimizer
	
	// Hardware profiles
	profiles   map[string]*HardwareProfile
	profileMu  sync.RWMutex
	
	// Performance tracking
	metrics    *PerformanceMetrics
	
	// Optimization state
	activeOptimizations sync.Map // map[string]*Optimization
	
	// Statistics
	stats      *OptimizationStats
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// OptimizerConfig contains optimization configuration
type OptimizerConfig struct {
	// Optimization settings
	AutoTuning           bool
	TuningInterval       time.Duration
	BenchmarkDuration    time.Duration
	
	// Performance thresholds
	MinHashrateGain      float64 // Minimum % gain to apply optimization
	MaxPowerIncrease     float64 // Maximum % power increase allowed
	TargetEfficiency     float64 // Target hash/watt ratio
	
	// Hardware limits
	MaxTemperature       float64
	MaxPower             float64
	MaxMemoryClock       int
	MaxCoreClock         int
	
	// Algorithm settings
	EnabledAlgorithms    []string
	OptimizationLevel    int // 0-3 (off, low, medium, high)
}

// AlgorithmOptimizer interface for algorithm-specific optimizers
type AlgorithmOptimizer interface {
	Name() string
	Optimize(ctx context.Context, hardware *HardwareProfile) (*OptimizationResult, error)
	Benchmark(ctx context.Context, hardware *HardwareProfile, params OptimizationParams) (*BenchmarkResult, error)
	GetDefaultParams(hardware *HardwareProfile) OptimizationParams
}

// HardwareProfile represents hardware capabilities and characteristics
type HardwareProfile struct {
	ID            string
	Type          string // "CPU", "GPU", "ASIC", "FPGA"
	Manufacturer  string
	Model         string
	
	// Capabilities
	ComputeUnits  int
	MemorySize    int64 // bytes
	MemoryType    string
	MemoryBandwidth float64 // GB/s
	
	// Current settings
	CoreClock     int
	MemoryClock   int
	PowerLimit    int
	FanSpeed      int
	
	// Thermal info
	Temperature   float64
	MaxTemp       float64
	
	// Performance history
	BaseHashrate  float64
	BestHashrate  float64
	BestParams    OptimizationParams
	
	// Timestamps
	LastOptimized time.Time
	LastBenchmark time.Time
}

// OptimizationParams contains optimization parameters
type OptimizationParams struct {
	// General parameters
	Threads       int
	WorkSize      int
	Intensity     int
	
	// Memory settings
	LookupGap     int
	CacheSize     int
	BufferSize    int
	
	// GPU specific
	GridSize      int
	BlockSize     int
	SharedMemory  int
	
	// Algorithm specific
	CustomParams  map[string]interface{}
}

// OptimizationResult contains optimization results
type OptimizationResult struct {
	Algorithm     string
	Hardware      string
	Params        OptimizationParams
	Hashrate      float64
	PowerUsage    float64
	Efficiency    float64 // hash/watt
	Temperature   float64
	Improvement   float64 // % improvement
	Stable        bool
	AppliedAt     time.Time
}

// BenchmarkResult contains benchmark results
type BenchmarkResult struct {
	Duration      time.Duration
	Hashrate      float64
	SharesFound   int
	InvalidShares int
	PowerAverage  float64
	TempAverage   float64
	Stable        bool
	Error         error
}

// Optimization represents an active optimization
type Optimization struct {
	ID            string
	WorkerID      string
	Algorithm     string
	StartTime     time.Time
	Status        OptimizationStatus
	Progress      atomic.Int32 // 0-100
	Result        *OptimizationResult
}

// OptimizationStatus represents optimization status
type OptimizationStatus string

const (
	OptStatusPending    OptimizationStatus = "pending"
	OptStatusRunning    OptimizationStatus = "running"
	OptStatusCompleted  OptimizationStatus = "completed"
	OptStatusFailed     OptimizationStatus = "failed"
	OptStatusCancelled  OptimizationStatus = "cancelled"
)

// PerformanceMetrics tracks performance metrics
type PerformanceMetrics struct {
	hashrateHistory   []MetricPoint
	efficiencyHistory []MetricPoint
	mu                sync.RWMutex
}

// MetricPoint represents a metric data point
type MetricPoint struct {
	Timestamp time.Time
	Value     float64
}

// OptimizationStats tracks optimization statistics
type OptimizationStats struct {
	TotalOptimizations   atomic.Uint64
	SuccessfulOptimizations atomic.Uint64
	FailedOptimizations  atomic.Uint64
	AverageImprovement   atomic.Value // float64
	TotalHashrateGain    atomic.Value // float64
	PowerSaved           atomic.Value // float64
}

// NewMiningOptimizer creates a new mining optimizer
func NewMiningOptimizer(logger *zap.Logger, config OptimizerConfig) *MiningOptimizer {
	ctx, cancel := context.WithCancel(context.Background())
	
	mo := &MiningOptimizer{
		logger:     logger,
		config:     config,
		optimizers: make(map[string]AlgorithmOptimizer),
		profiles:   make(map[string]*HardwareProfile),
		metrics:    &PerformanceMetrics{
			hashrateHistory:   make([]MetricPoint, 0),
			efficiencyHistory: make([]MetricPoint, 0),
		},
		stats:      &OptimizationStats{},
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Register algorithm optimizers
	mo.registerOptimizers()
	
	return mo
}

// Start starts the mining optimizer
func (mo *MiningOptimizer) Start() error {
	mo.logger.Info("Starting mining optimizer",
		zap.Bool("auto_tuning", mo.config.AutoTuning),
		zap.Int("optimization_level", mo.config.OptimizationLevel),
	)
	
	if mo.config.AutoTuning {
		mo.wg.Add(1)
		go mo.autoTuningLoop()
	}
	
	// Start metrics collection
	mo.wg.Add(1)
	go mo.metricsCollectionLoop()
	
	return nil
}

// Stop stops the mining optimizer
func (mo *MiningOptimizer) Stop() error {
	mo.logger.Info("Stopping mining optimizer")
	
	mo.cancel()
	mo.wg.Wait()
	
	return nil
}

// OptimizeWorker optimizes settings for a specific worker
func (mo *MiningOptimizer) OptimizeWorker(workerID string, algorithm string, hardware *HardwareProfile) (*OptimizationResult, error) {
	mo.logger.Info("Optimizing worker",
		zap.String("worker_id", workerID),
		zap.String("algorithm", algorithm),
		zap.String("hardware", hardware.Model),
	)
	
	// Check if optimization is already running
	if _, exists := mo.activeOptimizations.Load(workerID); exists {
		return nil, ErrOptimizationInProgress
	}
	
	// Create optimization record
	opt := &Optimization{
		ID:        generateOptimizationID(),
		WorkerID:  workerID,
		Algorithm: algorithm,
		StartTime: time.Now(),
		Status:    OptStatusRunning,
	}
	mo.activeOptimizations.Store(workerID, opt)
	defer mo.activeOptimizations.Delete(workerID)
	
	// Get algorithm optimizer
	optimizer, ok := mo.optimizers[algorithm]
	if !ok {
		opt.Status = OptStatusFailed
		return nil, ErrUnsupportedAlgorithm
	}
	
	// Store hardware profile
	mo.profileMu.Lock()
	mo.profiles[hardware.ID] = hardware
	mo.profileMu.Unlock()
	
	// Run optimization
	result, err := mo.runOptimization(optimizer, hardware, opt)
	if err != nil {
		opt.Status = OptStatusFailed
		mo.stats.FailedOptimizations.Add(1)
		return nil, err
	}
	
	// Update optimization record
	opt.Status = OptStatusCompleted
	opt.Result = result
	opt.Progress.Store(100)
	
	// Update statistics
	mo.stats.TotalOptimizations.Add(1)
	mo.stats.SuccessfulOptimizations.Add(1)
	mo.updateAverageImprovement(result.Improvement)
	
	// Store best parameters if improvement is significant
	if result.Improvement >= mo.config.MinHashrateGain {
		hardware.BestHashrate = result.Hashrate
		hardware.BestParams = result.Params
		hardware.LastOptimized = time.Now()
		
		mo.logger.Info("Optimization successful",
			zap.String("worker_id", workerID),
			zap.Float64("hashrate", result.Hashrate),
			zap.Float64("improvement", result.Improvement),
			zap.Float64("efficiency", result.Efficiency),
		)
	}
	
	return result, nil
}

// runOptimization runs the optimization process
func (mo *MiningOptimizer) runOptimization(optimizer AlgorithmOptimizer, hardware *HardwareProfile, opt *Optimization) (*OptimizationResult, error) {
	// Phase 1: Baseline benchmark (20%)
	opt.Progress.Store(10)
	baselineParams := optimizer.GetDefaultParams(hardware)
	baselineResult, err := optimizer.Benchmark(mo.ctx, hardware, baselineParams)
	if err != nil {
		return nil, err
	}
	hardware.BaseHashrate = baselineResult.Hashrate
	
	// Phase 2: Parameter exploration (60%)
	opt.Progress.Store(30)
	bestParams := baselineParams
	bestHashrate := baselineResult.Hashrate
	bestEfficiency := baselineResult.Hashrate / baselineResult.PowerAverage
	
	// Try different optimization strategies based on level
	strategies := mo.getOptimizationStrategies(mo.config.OptimizationLevel)
	
	for i, strategy := range strategies {
		progress := 30 + (30 * i / len(strategies))
		opt.Progress.Store(int32(progress))
		
		params := mo.applyStrategy(baselineParams, strategy, hardware)
		result, err := optimizer.Benchmark(mo.ctx, hardware, params)
		if err != nil {
			continue
		}
		
		efficiency := result.Hashrate / result.PowerAverage
		
		// Check if this is better
		if mo.isBetterResult(result, bestHashrate, bestEfficiency) {
			bestParams = params
			bestHashrate = result.Hashrate
			bestEfficiency = efficiency
		}
	}
	
	// Phase 3: Fine-tuning (20%)
	opt.Progress.Store(80)
	finalParams := mo.fineTuneParameters(optimizer, hardware, bestParams)
	finalResult, err := optimizer.Benchmark(mo.ctx, hardware, finalParams)
	if err != nil {
		finalResult = &BenchmarkResult{
			Hashrate:     bestHashrate,
			PowerAverage: bestHashrate / bestEfficiency,
		}
	}
	
	// Calculate improvement
	improvement := ((finalResult.Hashrate - hardware.BaseHashrate) / hardware.BaseHashrate) * 100
	
	return &OptimizationResult{
		Algorithm:   optimizer.Name(),
		Hardware:    hardware.Model,
		Params:      finalParams,
		Hashrate:    finalResult.Hashrate,
		PowerUsage:  finalResult.PowerAverage,
		Efficiency:  finalResult.Hashrate / finalResult.PowerAverage,
		Temperature: finalResult.TempAverage,
		Improvement: improvement,
		Stable:      finalResult.Stable,
		AppliedAt:   time.Now(),
	}, nil
}

// getOptimizationStrategies returns strategies based on level
func (mo *MiningOptimizer) getOptimizationStrategies(level int) []OptimizationStrategy {
	switch level {
	case 1: // Low
		return []OptimizationStrategy{
			{Name: "threads", Variations: []int{-2, -1, 0, 1, 2}},
			{Name: "intensity", Variations: []int{-1, 0, 1}},
		}
	case 2: // Medium
		return []OptimizationStrategy{
			{Name: "threads", Variations: []int{-4, -2, 0, 2, 4}},
			{Name: "intensity", Variations: []int{-2, -1, 0, 1, 2}},
			{Name: "worksize", Variations: []int{64, 128, 256, 512}},
			{Name: "cache", Variations: []int{0, 1, 2}},
		}
	case 3: // High
		return []OptimizationStrategy{
			{Name: "threads", Variations: []int{-8, -4, -2, 0, 2, 4, 8}},
			{Name: "intensity", Variations: []int{-3, -2, -1, 0, 1, 2, 3}},
			{Name: "worksize", Variations: []int{32, 64, 128, 256, 512, 1024}},
			{Name: "cache", Variations: []int{0, 1, 2, 3}},
			{Name: "lookup_gap", Variations: []int{1, 2, 4, 8}},
			{Name: "grid_block", Variations: []int{8, 16, 32, 64}},
		}
	default:
		return []OptimizationStrategy{}
	}
}

// applyStrategy applies an optimization strategy
func (mo *MiningOptimizer) applyStrategy(base OptimizationParams, strategy OptimizationStrategy, hardware *HardwareProfile) OptimizationParams {
	params := base
	
	switch strategy.Name {
	case "threads":
		maxThreads := hardware.ComputeUnits * 2
		for _, delta := range strategy.Variations {
			threads := base.Threads + delta
			if threads > 0 && threads <= maxThreads {
				params.Threads = threads
				break
			}
		}
		
	case "intensity":
		for _, delta := range strategy.Variations {
			intensity := base.Intensity + delta
			if intensity >= 1 && intensity <= 32 {
				params.Intensity = intensity
				break
			}
		}
		
	case "worksize":
		for _, size := range strategy.Variations {
			if size >= 32 && size <= 2048 {
				params.WorkSize = size
				break
			}
		}
		
	case "cache":
		for _, level := range strategy.Variations {
			params.LookupGap = 1 << level // 1, 2, 4, 8
		}
		
	case "grid_block":
		for _, size := range strategy.Variations {
			params.GridSize = size * hardware.ComputeUnits
			params.BlockSize = size
		}
	}
	
	return params
}

// fineTuneParameters performs fine-tuning of parameters
func (mo *MiningOptimizer) fineTuneParameters(optimizer AlgorithmOptimizer, hardware *HardwareProfile, params OptimizationParams) OptimizationParams {
	// Simple hill-climbing fine-tuning
	bestParams := params
	bestHashrate := 0.0
	
	// Fine-tune intensity
	for delta := -1; delta <= 1; delta++ {
		testParams := params
		testParams.Intensity += delta
		
		if testParams.Intensity < 1 || testParams.Intensity > 32 {
			continue
		}
		
		result, err := optimizer.Benchmark(mo.ctx, hardware, testParams)
		if err == nil && result.Hashrate > bestHashrate {
			bestHashrate = result.Hashrate
			bestParams = testParams
		}
	}
	
	return bestParams
}

// isBetterResult determines if a result is better
func (mo *MiningOptimizer) isBetterResult(result *BenchmarkResult, currentBestHashrate, currentBestEfficiency float64) bool {
	if !result.Stable {
		return false
	}
	
	// Check temperature limit
	if result.TempAverage > mo.config.MaxTemperature {
		return false
	}
	
	// Check power limit
	if result.PowerAverage > mo.config.MaxPower {
		return false
	}
	
	efficiency := result.Hashrate / result.PowerAverage
	
	// Prefer efficiency if close in hashrate
	hashrateGain := (result.Hashrate - currentBestHashrate) / currentBestHashrate
	efficiencyGain := (efficiency - currentBestEfficiency) / currentBestEfficiency
	
	if math.Abs(hashrateGain) < 0.02 { // Within 2%
		return efficiencyGain > 0
	}
	
	return result.Hashrate > currentBestHashrate
}

// registerOptimizers registers algorithm optimizers
func (mo *MiningOptimizer) registerOptimizers() {
	// Register optimizers for each algorithm
	mo.optimizers["SHA256"] = NewSHA256Optimizer(mo.logger)
	mo.optimizers["Scrypt"] = NewScryptOptimizer(mo.logger)
	mo.optimizers["Ethash"] = NewEthashOptimizer(mo.logger)
	mo.optimizers["RandomX"] = NewRandomXOptimizer(mo.logger)
	mo.optimizers["KawPow"] = NewKawPowOptimizer(mo.logger)
	mo.optimizers["Autolykos2"] = NewAutolykos2Optimizer(mo.logger)
}

// autoTuningLoop performs automatic tuning
func (mo *MiningOptimizer) autoTuningLoop() {
	defer mo.wg.Done()
	
	ticker := time.NewTicker(mo.config.TuningInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-mo.ctx.Done():
			return
			
		case <-ticker.C:
			mo.performAutoTuning()
		}
	}
}

func (mo *MiningOptimizer) performAutoTuning() {
	mo.profileMu.RLock()
	profiles := make([]*HardwareProfile, 0, len(mo.profiles))
	for _, profile := range mo.profiles {
		profiles = append(profiles, profile)
	}
	mo.profileMu.RUnlock()
	
	for _, profile := range profiles {
		// Check if optimization is needed
		if time.Since(profile.LastOptimized) < mo.config.TuningInterval {
			continue
		}
		
		// Get current metrics
		metrics := mo.metrics.GetLatest()
		if metrics.Efficiency < mo.config.TargetEfficiency*0.95 {
			// Re-optimize if efficiency dropped
			mo.logger.Info("Auto-tuning triggered",
				zap.String("hardware", profile.Model),
				zap.Float64("current_efficiency", metrics.Efficiency),
				zap.Float64("target_efficiency", mo.config.TargetEfficiency),
			)
			
			// Trigger optimization for active algorithm
			// Implementation depends on worker management integration
		}
	}
}

// metricsCollectionLoop collects performance metrics
func (mo *MiningOptimizer) metricsCollectionLoop() {
	defer mo.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-mo.ctx.Done():
			return
			
		case <-ticker.C:
			mo.collectMetrics()
		}
	}
}

func (mo *MiningOptimizer) collectMetrics() {
	// Collect current metrics from all optimized workers
	totalHashrate := 0.0
	totalPower := 0.0
	
	mo.activeOptimizations.Range(func(key, value interface{}) bool {
		opt := value.(*Optimization)
		if opt.Status == OptStatusCompleted && opt.Result != nil {
			totalHashrate += opt.Result.Hashrate
			totalPower += opt.Result.PowerUsage
		}
		return true
	})
	
	if totalPower > 0 {
		efficiency := totalHashrate / totalPower
		
		mo.metrics.mu.Lock()
		mo.metrics.hashrateHistory = append(mo.metrics.hashrateHistory, MetricPoint{
			Timestamp: time.Now(),
			Value:     totalHashrate,
		})
		mo.metrics.efficiencyHistory = append(mo.metrics.efficiencyHistory, MetricPoint{
			Timestamp: time.Now(),
			Value:     efficiency,
		})
		
		// Keep only recent history
		if len(mo.metrics.hashrateHistory) > 1440 { // 12 hours at 30s intervals
			mo.metrics.hashrateHistory = mo.metrics.hashrateHistory[1:]
		}
		if len(mo.metrics.efficiencyHistory) > 1440 {
			mo.metrics.efficiencyHistory = mo.metrics.efficiencyHistory[1:]
		}
		mo.metrics.mu.Unlock()
	}
}

// GetStats returns optimization statistics
func (mo *MiningOptimizer) GetStats() map[string]interface{} {
	avgImprovement := 0.0
	if val := mo.stats.AverageImprovement.Load(); val != nil {
		avgImprovement = val.(float64)
	}
	
	totalGain := 0.0
	if val := mo.stats.TotalHashrateGain.Load(); val != nil {
		totalGain = val.(float64)
	}
	
	powerSaved := 0.0
	if val := mo.stats.PowerSaved.Load(); val != nil {
		powerSaved = val.(float64)
	}
	
	return map[string]interface{}{
		"total_optimizations":      mo.stats.TotalOptimizations.Load(),
		"successful_optimizations": mo.stats.SuccessfulOptimizations.Load(),
		"failed_optimizations":     mo.stats.FailedOptimizations.Load(),
		"average_improvement":      avgImprovement,
		"total_hashrate_gain":      totalGain,
		"power_saved":              powerSaved,
		"active_optimizations":     mo.countActiveOptimizations(),
		"hardware_profiles":        len(mo.profiles),
	}
}

// Helper methods

func (mo *MiningOptimizer) updateAverageImprovement(improvement float64) {
	current := 0.0
	if val := mo.stats.AverageImprovement.Load(); val != nil {
		current = val.(float64)
	}
	
	total := mo.stats.SuccessfulOptimizations.Load()
	if total > 0 {
		newAvg := ((current * float64(total-1)) + improvement) / float64(total)
		mo.stats.AverageImprovement.Store(newAvg)
	}
}

func (mo *MiningOptimizer) countActiveOptimizations() int {
	count := 0
	mo.activeOptimizations.Range(func(key, value interface{}) bool {
		opt := value.(*Optimization)
		if opt.Status == OptStatusRunning {
			count++
		}
		return true
	})
	return count
}

func (mo *PerformanceMetrics) GetLatest() struct{ Hashrate, Efficiency float64 } {
	mo.mu.RLock()
	defer mo.mu.RUnlock()
	
	result := struct{ Hashrate, Efficiency float64 }{}
	
	if len(mo.hashrateHistory) > 0 {
		result.Hashrate = mo.hashrateHistory[len(mo.hashrateHistory)-1].Value
	}
	if len(mo.efficiencyHistory) > 0 {
		result.Efficiency = mo.efficiencyHistory[len(mo.efficiencyHistory)-1].Value
	}
	
	return result
}

// Helper types

type OptimizationStrategy struct {
	Name       string
	Variations []int
}

// Error definitions
var (
	ErrOptimizationInProgress = errors.New("optimization already in progress")
	ErrUnsupportedAlgorithm   = errors.New("unsupported algorithm")
	ErrHardwareNotSupported   = errors.New("hardware not supported")
	ErrBenchmarkFailed        = errors.New("benchmark failed")
)

// Helper functions

func generateOptimizationID() string {
	return fmt.Sprintf("opt_%d", time.Now().UnixNano())
}