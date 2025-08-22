// Package mining provides unified optimization for the Otedama mining engine
// Design: Performance-focused, adaptive, and efficient (Carmack/Pike/Martin)
package mining

import (
	"context"
	"errors"
	"fmt"
	"math"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// UnifiedOptimizer manages all optimization aspects of mining
type UnifiedOptimizer struct {
	mu       sync.RWMutex
	engine   *Engine
	ctx      context.Context
	cancel   context.CancelFunc
	
	// Optimization modules
	thermal  *ThermalOptimizer
	power    *PowerOptimizer
	perform  *PerformanceOptimizer
	memory   *MemoryOptimizer
	
	// State tracking
	enabled  atomic.Bool
	mode     atomic.Int32 // OptimizationMode
	
	// Metrics
	metrics  *OptimizationMetrics
	
	// Configuration
	config   OptimizationConfig
}

// OptimizationConfig contains optimizer configuration

// OptimizationMode represents optimization strategies
type OptimizationMode int32

const (
	ModeEfficiency OptimizationMode = iota
	ModePerformance
	ModeBalanced
	ModeAggressive
	ModeCustom
)

// OptimizationMetrics tracks optimization performance

// ThermalOptimizer manages temperature-based optimization
type ThermalOptimizer struct {
	mu              sync.RWMutex
	targetTemp      float64
	currentTemp     atomic.Uint32 // Celsius * 100
	fanCurve        []FanPoint
	throttlePoints  []ThrottlePoint
	coolingProfile  CoolingProfile
}

// PowerOptimizer manages power consumption optimization
type PowerOptimizer struct {
	mu            sync.RWMutex
	maxPower      float64
	currentPower  atomic.Uint32 // Watts * 100
	powerStates   []PowerState
	voltageTable  []VoltagePoint
	powerProfile  PowerProfile
}

// PerformanceOptimizer manages performance tuning
type PerformanceOptimizer struct {
	mu             sync.RWMutex
	targetHashrate uint64
	currentHashrate atomic.Uint64
	cpuOptimizer   *CPUOptimizer
	gpuOptimizer   *GPUOptimizer
	asicOptimizer  *ASICOptimizer
}

// MemoryOptimizer manages memory optimization

// Hardware-specific optimizers

// CPUOptimizer optimizes CPU mining
type CPUOptimizer struct {
	cores       int
	threads     int
	frequency   atomic.Uint32 // MHz
	voltage     atomic.Uint32 // mV
	affinity    []int
	prefetch    bool
	turboBoost  bool
	avx2        bool
	avx512      bool
}

// GPUOptimizer optimizes GPU mining
type GPUOptimizer struct {
	devices      []GPUDevice
	coreFreq     atomic.Uint32 // MHz
	memFreq      atomic.Uint32 // MHz
	powerLimit   atomic.Uint32 // Watts
	tempLimit    atomic.Uint32 // Celsius
	fanSpeed     atomic.Uint32 // Percentage
	computeMode  ComputeMode
}

// ASICOptimizer optimizes ASIC mining
type ASICOptimizer struct {
	devices    []ASICDevice
	frequency  atomic.Uint32 // MHz
	voltage    atomic.Uint32 // mV
	fanSpeed   atomic.Uint32 // RPM
	chipTemp   atomic.Uint32 // Celsius
}

// Supporting types

type FanPoint struct {
	Temperature float64
	FanSpeed    int // Percentage
}

type ThrottlePoint struct {
	Temperature float64
	Throttle    float64 // Reduction factor (0-1)
}

type CoolingProfile struct {
	Mode        string // passive, active, aggressive
	MinFanSpeed int
	MaxFanSpeed int
	TargetDelta float64 // Target temp delta
}

type PowerState struct {
	Name      string
	MinPower  float64
	MaxPower  float64
	Frequency float64
	Voltage   float64
}

type VoltagePoint struct {
	Frequency float64
	Voltage   float64
}

type PowerProfile struct {
	Mode          string // efficiency, balanced, performance
	PowerLimit    float64
	CurrentLimit  float64
	ThermalLimit  float64
}

type ComputeMode int

const (
	ComputeDefault ComputeMode = iota
	ComputeOptimized
	ComputeAggressive
	ComputeMaximum
)

// NewUnifiedOptimizer creates a new unified optimizer
func NewUnifiedOptimizer(engine *Engine, config OptimizationConfig) *UnifiedOptimizer {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Set defaults
	if config.ThermalInterval == 0 {
		config.ThermalInterval = 5 * time.Second
	}
	if config.PowerInterval == 0 {
		config.PowerInterval = 10 * time.Second
	}
	if config.PerformanceInterval == 0 {
		config.PerformanceInterval = 30 * time.Second
	}
	if config.TargetTemperature == 0 {
		config.TargetTemperature = 75.0
	}
	if config.MaxPower == 0 {
		config.MaxPower = 1000.0
	}
	
	opt := &UnifiedOptimizer{
		engine:  engine,
		ctx:     ctx,
		cancel:  cancel,
		config:  config,
		metrics: &OptimizationMetrics{},
	}
	
	// Initialize modules
	opt.thermal = &ThermalOptimizer{
		targetTemp: config.TargetTemperature,
		fanCurve:   defaultFanCurve(),
		coolingProfile: CoolingProfile{
			Mode:        "active",
			MinFanSpeed: 30,
			MaxFanSpeed: 100,
			TargetDelta: 5.0,
		},
	}
	
	opt.power = &PowerOptimizer{
		maxPower:     config.MaxPower,
		powerStates:  defaultPowerStates(),
		voltageTable: defaultVoltageTable(),
		powerProfile: PowerProfile{
			Mode:       "balanced",
			PowerLimit: config.MaxPower,
		},
	}
	
	opt.perform = &PerformanceOptimizer{
		targetHashrate: config.TargetHashrate,
		cpuOptimizer:   newCPUOptimizer(),
		gpuOptimizer:   newGPUOptimizer(),
		asicOptimizer:  newASICOptimizer(),
	}
	
	opt.memory = &MemoryOptimizer{
		memoryPool: &sync.Pool{
			New: func() interface{} {
				return make([]byte, 4096)
			},
		},
		cacheSize:    64 * 1024 * 1024, // 64MB
		prefetchSize: 4096,
	}
	
	opt.enabled.Store(true)
	opt.mode.Store(int32(ModeBalanced))
	
	return opt
}

// Start begins optimization
func (o *UnifiedOptimizer) Start() error {
	if !o.enabled.Load() {
		return errors.New("optimizer disabled")
	}
	
	// Start optimization routines
	go o.thermalOptimizationLoop()
	go o.powerOptimizationLoop()
	go o.performanceOptimizationLoop()
	
	// Start auto-tuning if enabled
	if o.config.AutoTune {
		go o.autoTuneLoop()
	}
	
	return nil
}

// Stop halts optimization
func (o *UnifiedOptimizer) Stop() error {
	o.enabled.Store(false)
	o.cancel()
	return nil
}

// SetMode sets optimization mode
func (o *UnifiedOptimizer) SetMode(mode OptimizationMode) {
	o.mode.Store(int32(mode))
	o.applyMode(mode)
}

// Optimize performs immediate optimization
func (o *UnifiedOptimizer) Optimize() error {
	o.metrics.OptimizationCount.Add(1)
	o.metrics.LastOptimization.Store(time.Now().Unix())
	
	// Get current metrics
	stats := o.engine.GetStatistics()
	hashrate := stats["hashrate"].(uint64)
	temp := stats["temperature"].(float64)
	power := stats["power_usage"].(float64)
	
	// Thermal optimization
	if err := o.optimizeThermal(temp); err != nil {
		o.metrics.FailedTuning.Add(1)
		return err
	}
	
	// Power optimization
	if err := o.optimizePower(power); err != nil {
		o.metrics.FailedTuning.Add(1)
		return err
	}
	
	// Performance optimization
	if err := o.optimizePerformance(hashrate); err != nil {
		o.metrics.FailedTuning.Add(1)
		return err
	}
	
	o.metrics.SuccessfulTuning.Add(1)
	
	// Calculate improvement
	newStats := o.engine.GetStatistics()
	newHashrate := newStats["hashrate"].(uint64)
	if hashrate > 0 {
		gain := ((newHashrate - hashrate) * 100) / hashrate
		o.metrics.AverageGain.Store(gain)
	}
	
	// Update best metrics
	if newHashrate > o.metrics.BestHashrate.Load() {
		o.metrics.BestHashrate.Store(newHashrate)
	}
	
	efficiency := uint64(newStats["efficiency"].(float64) * 1000)
	if efficiency > o.metrics.BestEfficiency.Load() {
		o.metrics.BestEfficiency.Store(efficiency)
	}
	
	return nil
}

// Optimization loops

func (o *UnifiedOptimizer) thermalOptimizationLoop() {
	ticker := time.NewTicker(o.config.ThermalInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-o.ctx.Done():
			return
		case <-ticker.C:
			if o.enabled.Load() {
				stats := o.engine.GetStatistics()
				temp := stats["temperature"].(float64)
				o.optimizeThermal(temp)
			}
		}
	}
}

func (o *UnifiedOptimizer) powerOptimizationLoop() {
	ticker := time.NewTicker(o.config.PowerInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-o.ctx.Done():
			return
		case <-ticker.C:
			if o.enabled.Load() {
				stats := o.engine.GetStatistics()
				power := stats["power_usage"].(float64)
				o.optimizePower(power)
			}
		}
	}
}

func (o *UnifiedOptimizer) performanceOptimizationLoop() {
	ticker := time.NewTicker(o.config.PerformanceInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-o.ctx.Done():
			return
		case <-ticker.C:
			if o.enabled.Load() {
				stats := o.engine.GetStatistics()
				hashrate := stats["hashrate"].(uint64)
				o.optimizePerformance(hashrate)
			}
		}
	}
}

func (o *UnifiedOptimizer) autoTuneLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-o.ctx.Done():
			return
		case <-ticker.C:
			if o.enabled.Load() {
				o.autoTune()
			}
		}
	}
}

// Optimization methods

func (o *UnifiedOptimizer) optimizeThermal(currentTemp float64) error {
	o.thermal.currentTemp.Store(uint32(currentTemp * 100))
	
	// Check if temperature is within range
	if currentTemp > o.config.TargetTemperature {
		// Too hot - reduce power
		delta := currentTemp - o.config.TargetTemperature
		reduction := math.Min(delta/10, 0.2) // Max 20% reduction
		
		// Apply thermal throttling
		o.applyThermalThrottle(reduction)
		
		// Increase fan speed
		o.adjustFanSpeed(currentTemp)
		
		// Track temperature reduction
		o.metrics.TemperatureReduced.Store(int32(delta * 10))
		
	} else if currentTemp < o.config.TargetTemperature-10 {
		// Cool enough - can increase performance
		o.removeThermalThrottle()
	}
	
	return nil
}

func (o *UnifiedOptimizer) optimizePower(currentPower float64) error {
	o.power.currentPower.Store(uint32(currentPower * 100))
	
	// Check if power is within limits
	if currentPower > o.config.MaxPower {
		// Over power limit - reduce consumption
		excess := currentPower - o.config.MaxPower
		reduction := excess / o.config.MaxPower
		
		// Apply power limiting
		o.applyPowerLimit(reduction)
		
		// Track power saved
		o.metrics.PowerSaved.Store(uint64(excess))
		
	} else if currentPower < o.config.MaxPower*0.8 {
		// Power headroom available
		if o.config.AggressiveMode {
			o.increasePowerLimit()
		}
	}
	
	return nil
}

func (o *UnifiedOptimizer) optimizePerformance(currentHashrate uint64) error {
	o.perform.currentHashrate.Store(currentHashrate)
	
	// Check if meeting target
	if o.config.TargetHashrate > 0 && currentHashrate < o.config.TargetHashrate {
		// Below target - increase performance
		deficit := o.config.TargetHashrate - currentHashrate
		factor := float64(deficit) / float64(o.config.TargetHashrate)
		
		// Adjust frequencies
		o.adjustFrequencies(factor)
		
		// Optimize memory timings
		o.optimizeMemoryTimings()
		
	} else if currentHashrate > o.config.TargetHashrate*1.1 {
		// Above target - can optimize for efficiency
		if o.config.PowerSaving {
			o.optimizeForEfficiency()
		}
	}
	
	return nil
}

func (o *UnifiedOptimizer) autoTune() {
	// Automatic tuning based on current conditions
	mode := OptimizationMode(o.mode.Load())
	
	switch mode {
	case ModeEfficiency:
		o.tuneForEfficiency()
	case ModePerformance:
		o.tuneForPerformance()
	case ModeBalanced:
		o.tuneBalanced()
	case ModeAggressive:
		o.tuneAggressive()
	}
}

// Tuning strategies

func (o *UnifiedOptimizer) tuneForEfficiency() {
	// Reduce frequencies to efficient points
	o.perform.cpuOptimizer.frequency.Store(2000) // 2GHz
	o.perform.gpuOptimizer.coreFreq.Store(1500)  // 1.5GHz
	
	// Lower voltages
	o.perform.cpuOptimizer.voltage.Store(900)   // 900mV
	o.perform.gpuOptimizer.powerLimit.Store(150) // 150W
	
	// Optimize memory
	o.memory.enablePowerSaving()
}

func (o *UnifiedOptimizer) tuneForPerformance() {
	// Maximize frequencies
	o.perform.cpuOptimizer.frequency.Store(4500) // 4.5GHz
	o.perform.gpuOptimizer.coreFreq.Store(2100)  // 2.1GHz
	
	// Increase power limits
	o.perform.gpuOptimizer.powerLimit.Store(350) // 350W
	
	// Enable turbo modes
	o.perform.cpuOptimizer.turboBoost = true
	o.perform.gpuOptimizer.computeMode = ComputeMaximum
}

func (o *UnifiedOptimizer) tuneBalanced() {
	// Balanced settings
	o.perform.cpuOptimizer.frequency.Store(3500) // 3.5GHz
	o.perform.gpuOptimizer.coreFreq.Store(1800)  // 1.8GHz
	o.perform.gpuOptimizer.powerLimit.Store(250) // 250W
}

func (o *UnifiedOptimizer) tuneAggressive() {
	// Maximum performance without limits
	o.perform.cpuOptimizer.frequency.Store(5000) // 5GHz
	o.perform.gpuOptimizer.coreFreq.Store(2500)  // 2.5GHz
	o.perform.gpuOptimizer.powerLimit.Store(500) // 500W
	
	// Disable all limits
	o.thermal.targetTemp = 100.0
	o.power.maxPower = 2000.0
}

// Apply optimization methods

func (o *UnifiedOptimizer) applyMode(mode OptimizationMode) {
	switch mode {
	case ModeEfficiency:
		o.config.PowerSaving = true
		o.config.AggressiveMode = false
		o.config.TargetEfficiency = 1000.0 // 1000 H/W
	case ModePerformance:
		o.config.PowerSaving = false
		o.config.AggressiveMode = true
		o.config.MaxPower = 1500.0
	case ModeBalanced:
		o.config.PowerSaving = false
		o.config.AggressiveMode = false
	case ModeAggressive:
		o.config.PowerSaving = false
		o.config.AggressiveMode = true
		o.config.MaxPower = 2000.0
	}
}

func (o *UnifiedOptimizer) applyThermalThrottle(factor float64) {
	// Reduce frequencies by factor
	for _, worker := range o.engine.workers {
		switch worker.Type {
		case DeviceCPU:
			currentFreq := o.perform.cpuOptimizer.frequency.Load()
			newFreq := uint32(float64(currentFreq) * (1 - factor))
			o.perform.cpuOptimizer.frequency.Store(newFreq)
			
		case DeviceGPU:
			currentFreq := o.perform.gpuOptimizer.coreFreq.Load()
			newFreq := uint32(float64(currentFreq) * (1 - factor))
			o.perform.gpuOptimizer.coreFreq.Store(newFreq)
		}
	}
}

func (o *UnifiedOptimizer) removeThermalThrottle() {
	// Restore normal frequencies
	o.tuneBalanced()
}

func (o *UnifiedOptimizer) adjustFanSpeed(temp float64) {
	// Find appropriate fan speed from curve
	fanSpeed := 30 // Default minimum
	
	for _, point := range o.thermal.fanCurve {
		if temp >= point.Temperature {
			fanSpeed = point.FanSpeed
		}
	}
	
	o.perform.gpuOptimizer.fanSpeed.Store(uint32(fanSpeed))
	o.perform.asicOptimizer.fanSpeed.Store(uint32(fanSpeed * 50)) // RPM
}

func (o *UnifiedOptimizer) applyPowerLimit(factor float64) {
	// Reduce power limits
	currentLimit := o.perform.gpuOptimizer.powerLimit.Load()
	newLimit := uint32(float64(currentLimit) * (1 - factor))
	o.perform.gpuOptimizer.powerLimit.Store(newLimit)
}

func (o *UnifiedOptimizer) increasePowerLimit() {
	// Increase power limit by 10%
	currentLimit := o.perform.gpuOptimizer.powerLimit.Load()
	newLimit := uint32(float64(currentLimit) * 1.1)
	if newLimit > uint32(o.config.MaxPower) {
		newLimit = uint32(o.config.MaxPower)
	}
	o.perform.gpuOptimizer.powerLimit.Store(newLimit)
}

func (o *UnifiedOptimizer) adjustFrequencies(factor float64) {
	// Increase frequencies based on deficit
	increase := 1.0 + (factor * 0.1) // Max 10% increase
	
	currentCPU := o.perform.cpuOptimizer.frequency.Load()
	o.perform.cpuOptimizer.frequency.Store(uint32(float64(currentCPU) * increase))
	
	currentGPU := o.perform.gpuOptimizer.coreFreq.Load()
	o.perform.gpuOptimizer.coreFreq.Store(uint32(float64(currentGPU) * increase))
}

func (o *UnifiedOptimizer) optimizeMemoryTimings() {
	// Optimize memory timings for mining
	o.perform.gpuOptimizer.memFreq.Store(8000) // 8GHz for GDDR6
}

func (o *UnifiedOptimizer) optimizeForEfficiency() {
	// Switch to efficiency mode
	o.SetMode(ModeEfficiency)
}

// Memory optimization methods

func (m *MemoryOptimizer) enablePowerSaving() {
	// Reduce cache size
	m.cacheSize = 32 * 1024 * 1024 // 32MB
	m.prefetchSize = 2048
}

func (m *MemoryOptimizer) enableHugePages() error {
	m.hugePagesEnabled = true
	// Platform-specific huge pages enablement
	return nil
}

func (m *MemoryOptimizer) optimizeLayout() {
	// Optimize memory layout for cache efficiency
	// Align data structures to cache lines
}

// Helper functions

func newCPUOptimizer() *CPUOptimizer {
	return &CPUOptimizer{
		cores:      runtime.NumCPU(),
		threads:    runtime.NumCPU() * 2,
		prefetch:   true,
		turboBoost: true,
		avx2:       runtime.GOARCH == "amd64",
		avx512:     false,
	}
}

func newGPUOptimizer() *GPUOptimizer {
	return &GPUOptimizer{
		devices:     []GPUDevice{},
		computeMode: ComputeOptimized,
	}
}

func newASICOptimizer() *ASICOptimizer {
	return &ASICOptimizer{
		devices: []ASICDevice{},
	}
}

func defaultFanCurve() []FanPoint {
	return []FanPoint{
		{Temperature: 40, FanSpeed: 30},
		{Temperature: 50, FanSpeed: 40},
		{Temperature: 60, FanSpeed: 50},
		{Temperature: 70, FanSpeed: 65},
		{Temperature: 80, FanSpeed: 80},
		{Temperature: 85, FanSpeed: 90},
		{Temperature: 90, FanSpeed: 100},
	}
}

func defaultPowerStates() []PowerState {
	return []PowerState{
		{Name: "P0", MinPower: 250, MaxPower: 350, Frequency: 2100, Voltage: 1.1},
		{Name: "P1", MinPower: 180, MaxPower: 250, Frequency: 1800, Voltage: 1.0},
		{Name: "P2", MinPower: 120, MaxPower: 180, Frequency: 1500, Voltage: 0.9},
		{Name: "P3", MinPower: 80, MaxPower: 120, Frequency: 1200, Voltage: 0.85},
		{Name: "P4", MinPower: 50, MaxPower: 80, Frequency: 900, Voltage: 0.8},
	}
}

func defaultVoltageTable() []VoltagePoint {
	return []VoltagePoint{
		{Frequency: 2100, Voltage: 1.1},
		{Frequency: 2000, Voltage: 1.05},
		{Frequency: 1900, Voltage: 1.0},
		{Frequency: 1800, Voltage: 0.95},
		{Frequency: 1700, Voltage: 0.925},
		{Frequency: 1600, Voltage: 0.9},
		{Frequency: 1500, Voltage: 0.875},
		{Frequency: 1400, Voltage: 0.85},
	}
}

// GetMetrics returns optimization metrics
func (o *UnifiedOptimizer) GetMetrics() map[string]interface{} {
	return map[string]interface{}{
		"enabled":             o.enabled.Load(),
		"mode":                o.getModeString(),
		"optimization_count":  o.metrics.OptimizationCount.Load(),
		"successful_tuning":   o.metrics.SuccessfulTuning.Load(),
		"failed_tuning":       o.metrics.FailedTuning.Load(),
		"average_gain":        float64(o.metrics.AverageGain.Load()) / 100,
		"best_hashrate":       o.metrics.BestHashrate.Load(),
		"best_efficiency":     float64(o.metrics.BestEfficiency.Load()) / 1000,
		"power_saved":         o.metrics.PowerSaved.Load(),
		"temp_reduced":        float64(o.metrics.TemperatureReduced.Load()) / 10,
		"last_optimization":   time.Unix(o.metrics.LastOptimization.Load(), 0),
		"current_temperature": float64(o.thermal.currentTemp.Load()) / 100,
		"current_power":       float64(o.power.currentPower.Load()) / 100,
		"current_hashrate":    o.perform.currentHashrate.Load(),
		"cpu_frequency":       o.perform.cpuOptimizer.frequency.Load(),
		"gpu_core_frequency":  o.perform.gpuOptimizer.coreFreq.Load(),
		"gpu_memory_frequency": o.perform.gpuOptimizer.memFreq.Load(),
		"gpu_power_limit":     o.perform.gpuOptimizer.powerLimit.Load(),
		"gpu_fan_speed":       o.perform.gpuOptimizer.fanSpeed.Load(),
	}
}

func (o *UnifiedOptimizer) getModeString() string {
	switch OptimizationMode(o.mode.Load()) {
	case ModeEfficiency:
		return "efficiency"
	case ModePerformance:
		return "performance"
	case ModeBalanced:
		return "balanced"
	case ModeAggressive:
		return "aggressive"
	case ModeCustom:
		return "custom"
	default:
		return "unknown"
	}
}

// ApplyProfile applies a predefined optimization profile
func (o *UnifiedOptimizer) ApplyProfile(profile string) error {
	switch profile {
	case "mining":
		o.SetMode(ModePerformance)
		o.config.TargetEfficiency = 500.0
		o.config.MaxPower = 1200.0
		
	case "efficiency":
		o.SetMode(ModeEfficiency)
		o.config.TargetEfficiency = 1000.0
		o.config.MaxPower = 800.0
		
	case "silent":
		o.SetMode(ModeEfficiency)
		o.config.TargetTemperature = 65.0
		o.thermal.coolingProfile.MaxFanSpeed = 50
		
	case "extreme":
		o.SetMode(ModeAggressive)
		o.config.MaxPower = 2000.0
		o.config.TargetTemperature = 90.0
		
	default:
		return fmt.Errorf("unknown profile: %s", profile)
	}
	
	return nil
}

// Reset resets optimizer to defaults
func (o *UnifiedOptimizer) Reset() {
	o.SetMode(ModeBalanced)
	o.config = OptimizationConfig{
		TargetTemperature:   75.0,
		MaxPower:            1000.0,
		ThermalInterval:     5 * time.Second,
		PowerInterval:       10 * time.Second,
		PerformanceInterval: 30 * time.Second,
		AutoTune:            true,
	}
	o.metrics = &OptimizationMetrics{}
}