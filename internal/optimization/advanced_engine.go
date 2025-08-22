package optimization

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

type OptimizationEngine struct {
	logger            *zap.Logger
	mu                sync.RWMutex
	ctx               context.Context
	cancel            context.CancelFunc
	
	// Configuration
	config            *EngineConfig
	
	// State tracking
	devices           map[string]*DeviceState
	algorithms        map[string]*AlgorithmProfile
	profitHistory     []ProfitSnapshot
	optimizationQueue chan OptimizationTask
	
	// Performance metrics
	metrics           *OptimizationMetrics
	
	// Advanced features
	mlPredictor       *MLPredictor
	geneticOptimizer  *GeneticOptimizer
	thermalManager    *ThermalManager
	powerManager      *PowerManager
}

type EngineConfig struct {
	OptimizationInterval  time.Duration `json:"optimization_interval"`
	ProfitabilityWindow   time.Duration `json:"profitability_window"`
	ThermalThreshold      float64       `json:"thermal_threshold"`
	PowerLimit            float64       `json:"power_limit"`
	EnableMLPrediction    bool          `json:"enable_ml_prediction"`
	EnableGeneticOptim    bool          `json:"enable_genetic_optimization"`
	MaxConcurrentTasks    int           `json:"max_concurrent_tasks"`
	SafetyMargin          float64       `json:"safety_margin"`
}

type DeviceState struct {
	ID                string            `json:"id"`
	Type              string            `json:"type"`
	Status            DeviceStatus      `json:"status"`
	CurrentAlgorithm  string            `json:"current_algorithm"`
	Settings          DeviceSettings    `json:"settings"`
	Performance       PerformanceData   `json:"performance"`
	Thermal           ThermalData       `json:"thermal"`
	Power             PowerData         `json:"power"`
	LastOptimized     time.Time         `json:"last_optimized"`
	OptimizationScore float64           `json:"optimization_score"`
}

type DeviceSettings struct {
	Intensity         int     `json:"intensity"`
	CoreClock         int     `json:"core_clock"`
	MemoryClock       int     `json:"memory_clock"`
	PowerLimit        int     `json:"power_limit"`
	FanSpeed          int     `json:"fan_speed"`
	Threads           int     `json:"threads"`
	BatchSize         int     `json:"batch_size"`
}

type PerformanceData struct {
	Hashrate          float64   `json:"hashrate"`
	Efficiency        float64   `json:"efficiency"`
	Stability         float64   `json:"stability"`
	ErrorRate         float64   `json:"error_rate"`
	SharesAccepted    uint64    `json:"shares_accepted"`
	SharesRejected    uint64    `json:"shares_rejected"`
	Uptime            time.Duration `json:"uptime"`
	LastUpdate        time.Time `json:"last_update"`
}

type ThermalData struct {
	CoreTemp          float64 `json:"core_temp"`
	MemoryTemp        float64 `json:"memory_temp"`
	VRMTemp           float64 `json:"vrm_temp"`
	ThermalThrottling bool    `json:"thermal_throttling"`
	FanRPM            int     `json:"fan_rpm"`
	ThermalTarget     float64 `json:"thermal_target"`
}

type PowerData struct {
	CurrentPower      float64 `json:"current_power"`
	PowerLimit        float64 `json:"power_limit"`
	Voltage           float64 `json:"voltage"`
	Current           float64 `json:"current"`
	PowerEfficiency   float64 `json:"power_efficiency"`
}

type AlgorithmProfile struct {
	Name              string            `json:"name"`
	Difficulty        float64           `json:"difficulty"`
	BlockReward       float64           `json:"block_reward"`
	ExchangeRate      float64           `json:"exchange_rate"`
	NetworkHashrate   float64           `json:"network_hashrate"`
	OptimalSettings   map[string]DeviceSettings `json:"optimal_settings"`
	ProfitHistory     []float64         `json:"profit_history"`
	LastUpdated       time.Time         `json:"last_updated"`
}

type ProfitSnapshot struct {
	Timestamp         time.Time         `json:"timestamp"`
	Algorithm         string            `json:"algorithm"`
	EstimatedProfit   float64           `json:"estimated_profit"`
	ActualProfit      float64           `json:"actual_profit"`
	PowerCost         float64           `json:"power_cost"`
	NetProfit         float64           `json:"net_profit"`
}

type OptimizationTask struct {
	Type              TaskType          `json:"type"`
	DeviceID          string            `json:"device_id"`
	Priority          int               `json:"priority"`
	Parameters        map[string]interface{} `json:"parameters"`
	Callback          func(result OptimizationResult) `json:"-"`
	CreatedAt         time.Time         `json:"created_at"`
}

type TaskType int

const (
	TaskTypeAlgorithmSwitch TaskType = iota
	TaskTypeSettingsOptimize
	TaskTypeThermalOptimize
	TaskTypePowerOptimize
	TaskTypeFailureRecovery
	TaskTypeProfit Optimize
)

type OptimizationResult struct {
	Success           bool              `json:"success"`
	DeviceID          string            `json:"device_id"`
	OldSettings       DeviceSettings    `json:"old_settings"`
	NewSettings       DeviceSettings    `json:"new_settings"`
	ExpectedImprovement float64         `json:"expected_improvement"`
	ActualImprovement   float64         `json:"actual_improvement"`
	Error             error             `json:"error,omitempty"`
	Timestamp         time.Time         `json:"timestamp"`
}

type OptimizationMetrics struct {
	mu                    sync.RWMutex
	TotalOptimizations    uint64            `json:"total_optimizations"`
	SuccessfulOptimizations uint64          `json:"successful_optimizations"`
	FailedOptimizations   uint64            `json:"failed_optimizations"`
	AverageImprovement    float64           `json:"average_improvement"`
	TotalHashrateGain     float64           `json:"total_hashrate_gain"`
	TotalPowerSaved       float64           `json:"total_power_saved"`
	OptimizationsByType   map[TaskType]uint64 `json:"optimizations_by_type"`
	LastOptimization      time.Time         `json:"last_optimization"`
}

type DeviceStatus int

const (
	DeviceStatusIdle DeviceStatus = iota
	DeviceStatusMining
	DeviceStatusOptimizing
	DeviceStatusThermalThrottle
	DeviceStatusError
	DeviceStatusMaintenance
)

func NewOptimizationEngine(logger *zap.Logger, config *EngineConfig) *OptimizationEngine {
	ctx, cancel := context.WithCancel(context.Background())
	
	engine := &OptimizationEngine{
		logger:            logger,
		ctx:               ctx,
		cancel:            cancel,
		config:            config,
		devices:           make(map[string]*DeviceState),
		algorithms:        make(map[string]*AlgorithmProfile),
		profitHistory:     make([]ProfitSnapshot, 0),
		optimizationQueue: make(chan OptimizationTask, config.MaxConcurrentTasks*2),
		metrics:           &OptimizationMetrics{
			OptimizationsByType: make(map[TaskType]uint64),
		},
	}
	
	// Initialize advanced components
	engine.mlPredictor = NewMLPredictor(logger)
	engine.geneticOptimizer = NewGeneticOptimizer(logger, config)
	engine.thermalManager = NewThermalManager(logger, config.ThermalThreshold)
	engine.powerManager = NewPowerManager(logger, config.PowerLimit)
	
	return engine
}

func (e *OptimizationEngine) Start() error {
	e.logger.Info("Starting optimization engine")
	
	// Start worker goroutines
	for i := 0; i < e.config.MaxConcurrentTasks; i++ {
		go e.optimizationWorker()
	}
	
	// Start periodic optimization
	go e.periodicOptimization()
	
	// Start monitoring routines
	go e.monitorDeviceHealth()
	go e.updateAlgorithmProfitability()
	go e.thermalMonitoring()
	go e.powerMonitoring()
	
	return nil
}

func (e *OptimizationEngine) Stop() error {
	e.logger.Info("Stopping optimization engine")
	e.cancel()
	close(e.optimizationQueue)
	return nil
}

func (e *OptimizationEngine) RegisterDevice(device *DeviceState) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	
	e.devices[device.ID] = device
	e.logger.Info("Device registered for optimization", 
		zap.String("device_id", device.ID),
		zap.String("type", device.Type))
	
	// Queue initial optimization
	task := OptimizationTask{
		Type:      TaskTypeSettingsOptimize,
		DeviceID:  device.ID,
		Priority:  1,
		CreatedAt: time.Now(),
	}
	
	select {
	case e.optimizationQueue <- task:
	default:
		e.logger.Warn("Optimization queue full, skipping initial optimization",
			zap.String("device_id", device.ID))
	}
	
	return nil
}

func (e *OptimizationEngine) optimizationWorker() {
	for task := range e.optimizationQueue {
		e.processOptimizationTask(task)
	}
}

func (e *OptimizationEngine) processOptimizationTask(task OptimizationTask) {
	start := time.Now()
	result := OptimizationResult{
		DeviceID:  task.DeviceID,
		Timestamp: start,
	}
	
	e.mu.RLock()
	device, exists := e.devices[task.DeviceID]
	e.mu.RUnlock()
	
	if !exists {
		result.Error = fmt.Errorf("device not found: %s", task.DeviceID)
		result.Success = false
		if task.Callback != nil {
			task.Callback(result)
		}
		return
	}
	
	// Store old settings
	result.OldSettings = device.Settings
	
	// Process based on task type
	switch task.Type {
	case TaskTypeAlgorithmSwitch:
		result = e.optimizeAlgorithmSelection(device, task)
	case TaskTypeSettingsOptimize:
		result = e.optimizeDeviceSettings(device, task)
	case TaskTypeThermalOptimize:
		result = e.optimizeThermalSettings(device, task)
	case TaskTypePowerOptimize:
		result = e.optimizePowerSettings(device, task)
	case TaskTypeFailureRecovery:
		result = e.recoverFromFailure(device, task)
	default:
		result.Error = fmt.Errorf("unknown task type: %d", task.Type)
		result.Success = false
	}
	
	// Update metrics
	e.updateOptimizationMetrics(result, time.Since(start))
	
	// Execute callback
	if task.Callback != nil {
		task.Callback(result)
	}
	
	e.logger.Info("Optimization task completed",
		zap.String("device_id", task.DeviceID),
		zap.Int("task_type", int(task.Type)),
		zap.Bool("success", result.Success),
		zap.Duration("duration", time.Since(start)))
}

func (e *OptimizationEngine) optimizeDeviceSettings(device *DeviceState, task OptimizationTask) OptimizationResult {
	result := OptimizationResult{
		DeviceID:    device.ID,
		Success:     false,
		OldSettings: device.Settings,
		Timestamp:   time.Now(),
	}
	
	// Use genetic algorithm for complex optimization
	if e.config.EnableGeneticOptim {
		optimizedSettings, improvement, err := e.geneticOptimizer.OptimizeSettings(device)
		if err != nil {
			result.Error = err
			return result
		}
		
		result.NewSettings = optimizedSettings
		result.ExpectedImprovement = improvement
		result.Success = true
		
		// Apply settings
		device.Settings = optimizedSettings
		device.LastOptimized = time.Now()
		
		return result
	}
	
	// Fallback to traditional optimization
	return e.traditionalOptimization(device)
}

func (e *OptimizationEngine) traditionalOptimization(device *DeviceState) OptimizationResult {
	result := OptimizationResult{
		DeviceID:    device.ID,
		OldSettings: device.Settings,
		Timestamp:   time.Now(),
	}
	
	newSettings := device.Settings
	baseHashrate := device.Performance.Hashrate
	
	// Optimize intensity
	bestIntensity, hashrateGain := e.optimizeIntensity(device)
	newSettings.Intensity = bestIntensity
	
	// Optimize memory clock if GPU
	if device.Type == "GPU" {
		bestMemClock, memGain := e.optimizeMemoryClock(device)
		newSettings.MemoryClock = bestMemClock
		hashrateGain += memGain
	}
	
	// Optimize core clock
	bestCoreClock, coreGain := e.optimizeCoreClock(device)
	newSettings.CoreClock = bestCoreClock
	hashrateGain += coreGain
	
	// Apply thermal constraints
	newSettings = e.thermalManager.ApplyThermalConstraints(device, newSettings)
	
	// Apply power constraints
	newSettings = e.powerManager.ApplyPowerConstraints(device, newSettings)
	
	result.NewSettings = newSettings
	result.ExpectedImprovement = hashrateGain / baseHashrate * 100
	result.Success = true
	
	// Update device
	device.Settings = newSettings
	device.LastOptimized = time.Now()
	
	return result
}

func (e *OptimizationEngine) optimizeIntensity(device *DeviceState) (int, float64) {
	currentIntensity := device.Settings.Intensity
	maxIntensity := e.getMaxIntensityForDevice(device)
	bestIntensity := currentIntensity
	bestHashrate := device.Performance.Hashrate
	
	// Test different intensity levels
	for intensity := 1; intensity <= maxIntensity; intensity++ {
		if intensity == currentIntensity {
			continue
		}
		
		// Predict performance at this intensity
		predictedHashrate := e.predictHashrateAtIntensity(device, intensity)
		
		// Check thermal and power constraints
		if e.wouldExceedLimits(device, intensity) {
			continue
		}
		
		if predictedHashrate > bestHashrate {
			bestHashrate = predictedHashrate
			bestIntensity = intensity
		}
	}
	
	gain := bestHashrate - device.Performance.Hashrate
	return bestIntensity, gain
}

func (e *OptimizationEngine) optimizeMemoryClock(device *DeviceState) (int, float64) {
	if device.Type != "GPU" {
		return device.Settings.MemoryClock, 0
	}
	
	currentClock := device.Settings.MemoryClock
	baseClock := e.getBaseMemoryClock(device)
	maxClock := e.getMaxMemoryClock(device)
	
	bestClock := currentClock
	bestHashrate := device.Performance.Hashrate
	
	// Binary search for optimal memory clock
	step := 50 // MHz steps
	for clock := baseClock; clock <= maxClock; clock += step {
		if clock == currentClock {
			continue
		}
		
		predictedHashrate := e.predictHashrateAtMemoryClock(device, clock)
		
		if e.wouldExceedThermalLimits(device, clock, "memory") {
			break
		}
		
		if predictedHashrate > bestHashrate {
			bestHashrate = predictedHashrate
			bestClock = clock
		}
	}
	
	gain := bestHashrate - device.Performance.Hashrate
	return bestClock, gain
}

func (e *OptimizationEngine) optimizeCoreClock(device *DeviceState) (int, float64) {
	currentClock := device.Settings.CoreClock
	baseClock := e.getBaseCoreClock(device)
	maxClock := e.getMaxCoreClock(device)
	
	bestClock := currentClock
	bestHashrate := device.Performance.Hashrate
	
	step := 25 // MHz steps
	for clock := baseClock; clock <= maxClock; clock += step {
		if clock == currentClock {
			continue
		}
		
		predictedHashrate := e.predictHashrateAtCoreClock(device, clock)
		
		if e.wouldExceedThermalLimits(device, clock, "core") {
			break
		}
		
		if predictedHashrate > bestHashrate {
			bestHashrate = predictedHashrate
			bestClock = clock
		}
	}
	
	gain := bestHashrate - device.Performance.Hashrate
	return bestClock, gain
}

func (e *OptimizationEngine) optimizeAlgorithmSelection(device *DeviceState, task OptimizationTask) OptimizationResult {
	result := OptimizationResult{
		DeviceID:    device.ID,
		OldSettings: device.Settings,
		Timestamp:   time.Now(),
	}
	
	currentAlgorithm := device.CurrentAlgorithm
	bestAlgorithm := currentAlgorithm
	bestProfit := e.calculateCurrentProfit(device, currentAlgorithm)
	
	// Evaluate all available algorithms
	for algorithmName, profile := range e.algorithms {
		if algorithmName == currentAlgorithm {
			continue
		}
		
		// Predict profit for this algorithm
		predictedProfit := e.predictProfitForAlgorithm(device, algorithmName, profile)
		
		// Apply safety margin to avoid constant switching
		if predictedProfit > bestProfit*(1+e.config.SafetyMargin) {
			bestProfit = predictedProfit
			bestAlgorithm = algorithmName
		}
	}
	
	if bestAlgorithm != currentAlgorithm {
		// Switch algorithm
		device.CurrentAlgorithm = bestAlgorithm
		
		// Apply optimal settings for new algorithm
		if profile, exists := e.algorithms[bestAlgorithm]; exists {
			if settings, hasSettings := profile.OptimalSettings[device.Type]; hasSettings {
				device.Settings = settings
			}
		}
		
		result.NewSettings = device.Settings
		result.ExpectedImprovement = (bestProfit - e.calculateCurrentProfit(device, currentAlgorithm)) / e.calculateCurrentProfit(device, currentAlgorithm) * 100
		result.Success = true
		
		e.logger.Info("Algorithm switched",
			zap.String("device_id", device.ID),
			zap.String("old_algorithm", currentAlgorithm),
			zap.String("new_algorithm", bestAlgorithm),
			zap.Float64("expected_improvement", result.ExpectedImprovement))
	} else {
		result.NewSettings = device.Settings
		result.ExpectedImprovement = 0
		result.Success = true
	}
	
	return result
}

func (e *OptimizationEngine) periodicOptimization() {
	ticker := time.NewTicker(e.config.OptimizationInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-e.ctx.Done():
			return
		case <-ticker.C:
			e.runPeriodicOptimization()
		}
	}
}

func (e *OptimizationEngine) runPeriodicOptimization() {
	e.mu.RLock()
	devices := make([]*DeviceState, 0, len(e.devices))
	for _, device := range e.devices {
		devices = append(devices, device)
	}
	e.mu.RUnlock()
	
	// Sort devices by optimization priority
	sort.Slice(devices, func(i, j int) bool {
		return e.getOptimizationPriority(devices[i]) > e.getOptimizationPriority(devices[j])
	})
	
	// Queue optimization tasks
	for _, device := range devices {
		if time.Since(device.LastOptimized) > e.config.OptimizationInterval {
			task := OptimizationTask{
				Type:      e.determineOptimizationType(device),
				DeviceID:  device.ID,
				Priority:  int(e.getOptimizationPriority(device)),
				CreatedAt: time.Now(),
			}
			
			select {
			case e.optimizationQueue <- task:
			default:
				e.logger.Warn("Optimization queue full, skipping device",
					zap.String("device_id", device.ID))
			}
		}
	}
}

func (e *OptimizationEngine) getOptimizationPriority(device *DeviceState) float64 {
	priority := 0.0
	
	// Higher priority for devices with performance issues
	if device.Performance.ErrorRate > 0.05 {
		priority += 50
	}
	
	// Higher priority for thermal issues
	if device.Thermal.CoreTemp > e.config.ThermalThreshold {
		priority += 30
	}
	
	// Higher priority for low efficiency
	if device.Performance.Efficiency < 0.8 {
		priority += 20
	}
	
	// Higher priority for devices not optimized recently
	timeSinceOptimization := time.Since(device.LastOptimized)
	priority += float64(timeSinceOptimization.Hours())
	
	return priority
}

func (e *OptimizationEngine) determineOptimizationType(device *DeviceState) TaskType {
	// Thermal issues take priority
	if device.Thermal.CoreTemp > e.config.ThermalThreshold {
		return TaskTypeThermalOptimize
	}
	
	// Power issues
	if device.Power.CurrentPower > device.Power.PowerLimit*0.95 {
		return TaskTypePowerOptimize
	}
	
	// High error rate suggests need for settings optimization
	if device.Performance.ErrorRate > 0.05 {
		return TaskTypeSettingsOptimize
	}
	
	// Check if algorithm switch would be profitable
	if e.shouldConsiderAlgorithmSwitch(device) {
		return TaskTypeAlgorithmSwitch
	}
	
	// Default to settings optimization
	return TaskTypeSettingsOptimize
}

func (e *OptimizationEngine) shouldConsiderAlgorithmSwitch(device *DeviceState) bool {
	currentProfit := e.calculateCurrentProfit(device, device.CurrentAlgorithm)
	
	for algorithmName, profile := range e.algorithms {
		if algorithmName == device.CurrentAlgorithm {
			continue
		}
		
		predictedProfit := e.predictProfitForAlgorithm(device, algorithmName, profile)
		if predictedProfit > currentProfit*(1+e.config.SafetyMargin) {
			return true
		}
	}
	
	return false
}

// Helper functions for predictions and calculations
func (e *OptimizationEngine) predictHashrateAtIntensity(device *DeviceState, intensity int) float64 {
	// Simplified prediction model - in reality would use ML or historical data
	currentHashrate := device.Performance.Hashrate
	currentIntensity := device.Settings.Intensity
	
	if currentIntensity == 0 {
		return currentHashrate
	}
	
	// Linear approximation with diminishing returns
	ratio := float64(intensity) / float64(currentIntensity)
	efficiency := 1.0 - (ratio-1.0)*0.1 // Diminishing returns
	
	return currentHashrate * ratio * efficiency
}

func (e *OptimizationEngine) predictHashrateAtMemoryClock(device *DeviceState, clock int) float64 {
	currentHashrate := device.Performance.Hashrate
	currentClock := device.Settings.MemoryClock
	
	if currentClock == 0 {
		return currentHashrate
	}
	
	// Memory clock has different impact based on algorithm
	memoryImpact := e.getMemoryImpactForAlgorithm(device.CurrentAlgorithm)
	ratio := float64(clock) / float64(currentClock)
	
	return currentHashrate * (1 + (ratio-1)*memoryImpact)
}

func (e *OptimizationEngine) predictHashrateAtCoreClock(device *DeviceState, clock int) float64 {
	currentHashrate := device.Performance.Hashrate
	currentClock := device.Settings.CoreClock
	
	if currentClock == 0 {
		return currentHashrate
	}
	
	ratio := float64(clock) / float64(currentClock)
	
	// Core clock generally has linear impact up to thermal limits
	return currentHashrate * ratio * 0.8 // 80% efficiency factor
}

func (e *OptimizationEngine) calculateCurrentProfit(device *DeviceState, algorithm string) float64 {
	profile, exists := e.algorithms[algorithm]
	if !exists {
		return 0
	}
	
	// Revenue = (hashrate / network_hashrate) * block_reward * blocks_per_day * exchange_rate
	hashrateShare := device.Performance.Hashrate / profile.NetworkHashrate
	dailyBlocks := 144.0 // Approximate for most cryptocurrencies
	dailyRevenue := hashrateShare * profile.BlockReward * dailyBlocks * profile.ExchangeRate
	
	// Power cost
	powerCostPerKWh := 0.12 // Default electricity rate
	dailyPowerCost := (device.Power.CurrentPower / 1000) * 24 * powerCostPerKWh
	
	return dailyRevenue - dailyPowerCost
}

func (e *OptimizationEngine) predictProfitForAlgorithm(device *DeviceState, algorithm string, profile *AlgorithmProfile) float64 {
	// Predict hashrate for this algorithm
	predictedHashrate := e.predictHashrateForAlgorithm(device, algorithm)
	
	// Calculate profit with predicted hashrate
	hashrateShare := predictedHashrate / profile.NetworkHashrate
	dailyBlocks := 144.0
	dailyRevenue := hashrateShare * profile.BlockReward * dailyBlocks * profile.ExchangeRate
	
	// Power cost remains similar
	powerCostPerKWh := 0.12
	dailyPowerCost := (device.Power.CurrentPower / 1000) * 24 * powerCostPerKWh
	
	return dailyRevenue - dailyPowerCost
}

func (e *OptimizationEngine) predictHashrateForAlgorithm(device *DeviceState, algorithm string) float64 {
	// Use ML predictor if enabled
	if e.config.EnableMLPrediction {
		return e.mlPredictor.PredictHashrate(device, algorithm)
	}
	
	// Fallback to simple estimation
	return device.Performance.Hashrate * e.getAlgorithmHashrateMultiplier(device.Type, algorithm)
}

func (e *OptimizationEngine) getAlgorithmHashrateMultiplier(deviceType, algorithm string) float64 {
	// Simplified multipliers - would be based on benchmarks
	multipliers := map[string]map[string]float64{
		"GPU": {
			"ethash":  1.0,
			"kawpow":  0.85,
			"randomx": 0.1,
			"scrypt":  0.9,
		},
		"CPU": {
			"randomx": 1.0,
			"cryptonight": 0.8,
			"scrypt": 0.3,
		},
		"ASIC": {
			"sha256d": 1.0,
			"scrypt":  1.0,
			"x11":     1.0,
		},
	}
	
	if deviceMultipliers, exists := multipliers[deviceType]; exists {
		if multiplier, exists := deviceMultipliers[algorithm]; exists {
			return multiplier
		}
	}
	
	return 0.5 // Conservative default
}

func (e *OptimizationEngine) updateOptimizationMetrics(result OptimizationResult, duration time.Duration) {
	e.metrics.mu.Lock()
	defer e.metrics.mu.Unlock()
	
	e.metrics.TotalOptimizations++
	e.metrics.LastOptimization = time.Now()
	
	if result.Success {
		e.metrics.SuccessfulOptimizations++
		e.metrics.AverageImprovement = (e.metrics.AverageImprovement*float64(e.metrics.SuccessfulOptimizations-1) + result.ExpectedImprovement) / float64(e.metrics.SuccessfulOptimizations)
	} else {
		e.metrics.FailedOptimizations++
	}
}

// Utility functions
func (e *OptimizationEngine) getMaxIntensityForDevice(device *DeviceState) int {
	switch device.Type {
	case "GPU":
		return 31
	case "CPU":
		return 16
	case "ASIC":
		return 1
	default:
		return 20
	}
}

func (e *OptimizationEngine) getBaseMemoryClock(device *DeviceState) int {
	// Device-specific base clocks would be loaded from database
	return 1000 // Default base memory clock
}

func (e *OptimizationEngine) getMaxMemoryClock(device *DeviceState) int {
	// Device-specific max clocks with safety margin
	return 2200 // Conservative maximum
}

func (e *OptimizationEngine) getBaseCoreClock(device *DeviceState) int {
	return 1200 // Default base core clock
}

func (e *OptimizationEngine) getMaxCoreClock(device *DeviceState) int {
	return 2000 // Conservative maximum
}

func (e *OptimizationEngine) getMemoryImpactForAlgorithm(algorithm string) float64 {
	memoryIntensive := map[string]float64{
		"ethash":    0.8,
		"etchash":   0.8,
		"kawpow":    0.6,
		"randomx":   0.3,
		"scrypt":    0.4,
		"cryptonight": 0.5,
	}
	
	if impact, exists := memoryIntensive[algorithm]; exists {
		return impact
	}
	
	return 0.3 // Default low memory impact
}

func (e *OptimizationEngine) wouldExceedLimits(device *DeviceState, intensity int) bool {
	// Simple check - would be more sophisticated in practice
	return intensity > e.getMaxIntensityForDevice(device) ||
		   device.Thermal.CoreTemp > e.config.ThermalThreshold
}

func (e *OptimizationEngine) wouldExceedThermalLimits(device *DeviceState, clock int, clockType string) bool {
	// Estimate temperature increase
	estimatedTempIncrease := float64(clock-device.Settings.CoreClock) * 0.01 // 1°C per 100MHz
	
	return device.Thermal.CoreTemp+estimatedTempIncrease > e.config.ThermalThreshold
}

func (e *OptimizationEngine) GetMetrics() *OptimizationMetrics {
	e.metrics.mu.RLock()
	defer e.metrics.mu.RUnlock()
	
	// Return copy to avoid race conditions
	metricsCopy := *e.metrics
	metricsCopy.OptimizationsByType = make(map[TaskType]uint64)
	for k, v := range e.metrics.OptimizationsByType {
		metricsCopy.OptimizationsByType[k] = v
	}
	
	return &metricsCopy
}

func (e *OptimizationEngine) GetDeviceState(deviceID string) (*DeviceState, bool) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	
	device, exists := e.devices[deviceID]
	if !exists {
		return nil, false
	}
	
	// Return copy
	deviceCopy := *device
	return &deviceCopy, true
}

func (e *OptimizationEngine) QueueOptimization(task OptimizationTask) error {
	select {
	case e.optimizationQueue <- task:
		return nil
	default:
		return fmt.Errorf("optimization queue is full")
	}
}