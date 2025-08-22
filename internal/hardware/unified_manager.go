// Package hardware provides unified hardware management for Otedama
package hardware

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DeviceType represents the type of mining device
type DeviceType int

const (
	DeviceTypeCPU DeviceType = iota
	DeviceTypeGPU
	DeviceTypeASIC
	DeviceTypeFPGA
)

// UnifiedManager manages all hardware devices
type UnifiedManager struct {
	logger *zap.Logger
	config *Config
	
	// Device management
	devices      []MiningDevice
	devicesMu    sync.RWMutex
	
	// CPU management
	cpuDevices   []*CPUDevice
	cpuManager   *CPUManager
	
	// GPU management
	gpuDevices   []*GPUDevice
	gpuManager   *GPUManager
	
	// ASIC management
	asicDevices  []*ASICDevice
	asicManager  *ASICManager
	
	// Monitoring
	monitor      *HardwareMonitor
	
	// Statistics
	stats        *HardwareStats
	
	// Power management
	powerLimit   atomic.Uint64
	tempLimit    atomic.Uint64
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	running      atomic.Bool
	wg           sync.WaitGroup
}

// Config contains hardware configuration
type Config struct {
	CPU  CPUConfig
	GPU  GPUConfig
	ASIC ASICConfig
	FPGA FPGAConfig
	
	PowerLimit      float64
	TemperatureLimit float64
	UpdateInterval   time.Duration
	EnableMonitoring bool
}

// CPUConfig contains CPU configuration
type CPUConfig struct {
	Enabled  bool
	Threads  int
	Affinity []int
	Priority string
}

// GPUConfig contains GPU configuration
type GPUConfig struct {
	Enabled   bool
	Devices   []int
	Intensity int
	PowerLimit int
	TempLimit float64
}

// ASICConfig contains ASIC configuration
type ASICConfig struct {
	Enabled bool
	Devices []string
	Frequency int
}

// FPGAConfig contains FPGA configuration
type FPGAConfig struct {
	Enabled  bool
	Devices  []string
	Bitstream string
}

// MiningDevice interface for all mining devices
type MiningDevice interface {
	GetID() string
	GetName() string
	GetType() DeviceType
	IsAvailable() bool
	GetHashrate() uint64
	GetTemperature() float64
	GetPowerUsage() float64
	GetMemoryUsage() uint64
	SetIntensity(intensity int) error
	Start(algorithm string) error
	Stop() error
}

// CPUDevice represents a CPU mining device
type CPUDevice struct {
	ID           string
	Name         string
	Cores        int
	Threads      int
	Available    atomic.Bool
	Hashrate     atomic.Uint64
	Temperature  atomic.Uint64
	PowerUsage   atomic.Uint64
	Intensity    atomic.Int32
	mining       atomic.Bool
}

// GPUDevice represents a GPU mining device
type GPUDevice struct {
	ID           string
	Name         string
	Index        int
	Memory       uint64
	ComputeUnits int
	Available    atomic.Bool
	Hashrate     atomic.Uint64
	Temperature  atomic.Uint64
	PowerUsage   atomic.Uint64
	MemoryUsage  atomic.Uint64
	FanSpeed     atomic.Uint32
	Intensity    atomic.Int32
	mining       atomic.Bool
}

// ASICDevice represents an ASIC mining device
type ASICDevice struct {
	ID          string
	Name        string
	Model       string
	SerialPort  string
	Available   atomic.Bool
	Hashrate    atomic.Uint64
	Temperature atomic.Uint64
	PowerUsage  atomic.Uint64
	Frequency   atomic.Int32
	ChipCount   int
	mining      atomic.Bool
}

// HardwareStats tracks hardware statistics
type HardwareStats struct {
	DevicesTotal     atomic.Int32
	DevicesActive    atomic.Int32
	TotalHashrate    atomic.Uint64
	TotalPower       atomic.Uint64
	AverageTemp      atomic.Uint64
	ErrorCount       atomic.Uint64
	RestartCount     atomic.Uint64
}

// HardwareMonitor monitors hardware health
type HardwareMonitor struct {
	logger       *zap.Logger
	devices      []MiningDevice
	interval     time.Duration
	tempLimit    float64
	powerLimit   float64
	alerts       chan *Alert
	running      atomic.Bool
}

// Alert represents a hardware alert
type Alert struct {
	Timestamp time.Time
	Device    string
	Type      string
	Severity  string
	Message   string
	Value     float64
}

// CPUManager manages CPU mining
type CPUManager struct {
	logger  *zap.Logger
	devices []*CPUDevice
	threads int
	affinity []int
}

// GPUManager manages GPU mining
type GPUManager struct {
	logger  *zap.Logger
	devices []*GPUDevice
}

// ASICManager manages ASIC mining
type ASICManager struct {
	logger  *zap.Logger
	devices []*ASICDevice
}

// MiningJob represents a mining job for hardware
type MiningJob struct {
	ID         string
	Algorithm  string
	Target     []byte
	Data       []byte
	ExtraNonce []byte
	Height     uint64
	Difficulty float64
	Timestamp  time.Time
}

// NewUnifiedManager creates a new unified hardware manager
func NewUnifiedManager(logger *zap.Logger) *UnifiedManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &UnifiedManager{
		logger:      logger,
		devices:     make([]MiningDevice, 0),
		cpuDevices:  make([]*CPUDevice, 0),
		gpuDevices:  make([]*GPUDevice, 0),
		asicDevices: make([]*ASICDevice, 0),
		stats:       &HardwareStats{},
		ctx:         ctx,
		cancel:      cancel,
	}
}

// SetConfig sets the hardware configuration
func (um *UnifiedManager) SetConfig(config *Config) {
	um.config = config
}

// Initialize initializes all hardware
func (um *UnifiedManager) Initialize() error {
	um.logger.Info("Initializing hardware manager")
	
	// Initialize CPU devices
	if um.config.CPU.Enabled {
		if err := um.initializeCPU(); err != nil {
			um.logger.Warn("Failed to initialize CPU", zap.Error(err))
		}
	}
	
	// Initialize GPU devices
	if um.config.GPU.Enabled {
		if err := um.initializeGPU(); err != nil {
			um.logger.Warn("Failed to initialize GPU", zap.Error(err))
		}
	}
	
	// Initialize ASIC devices
	if um.config.ASIC.Enabled {
		if err := um.initializeASIC(); err != nil {
			um.logger.Warn("Failed to initialize ASIC", zap.Error(err))
		}
	}
	
	// Create hardware monitor
	if um.config.EnableMonitoring {
		um.monitor = NewHardwareMonitor(um.logger, um.devices, um.config.UpdateInterval)
		um.monitor.SetLimits(um.config.TemperatureLimit, um.config.PowerLimit)
	}
	
	// Update statistics
	um.stats.DevicesTotal.Store(int32(len(um.devices)))
	
	um.logger.Info("Hardware initialization complete",
		zap.Int("total_devices", len(um.devices)),
		zap.Int("cpu_devices", len(um.cpuDevices)),
		zap.Int("gpu_devices", len(um.gpuDevices)),
		zap.Int("asic_devices", len(um.asicDevices)))
	
	return nil
}

// Start starts hardware mining
func (um *UnifiedManager) Start(algorithm string) error {
	if !um.running.CompareAndSwap(false, true) {
		return errors.New("already running")
	}
	
	um.logger.Info("Starting hardware mining",
		zap.String("algorithm", algorithm))
	
	// Start monitoring
	if um.monitor != nil {
		um.wg.Add(1)
		go um.monitorLoop()
	}
	
	// Start devices
	var started int
	for _, device := range um.devices {
		if device.IsAvailable() {
			if err := device.Start(algorithm); err != nil {
				um.logger.Warn("Failed to start device",
					zap.String("device", device.GetName()),
					zap.Error(err))
			} else {
				started++
			}
		}
	}
	
	um.stats.DevicesActive.Store(int32(started))
	
	um.logger.Info("Hardware mining started",
		zap.Int("active_devices", started))
	
	return nil
}

// Stop stops hardware mining
func (um *UnifiedManager) Stop() error {
	if !um.running.CompareAndSwap(true, false) {
		return errors.New("not running")
	}
	
	um.logger.Info("Stopping hardware mining")
	
	// Stop devices
	for _, device := range um.devices {
		if err := device.Stop(); err != nil {
			um.logger.Warn("Failed to stop device",
				zap.String("device", device.GetName()),
				zap.Error(err))
		}
	}
	
	// Cancel context
	um.cancel()
	
	// Wait for goroutines
	um.wg.Wait()
	
	um.stats.DevicesActive.Store(0)
	
	um.logger.Info("Hardware mining stopped")
	return nil
}

// GetDevices returns all mining devices
func (um *UnifiedManager) GetDevices() []MiningDevice {
	um.devicesMu.RLock()
	defer um.devicesMu.RUnlock()
	
	devices := make([]MiningDevice, len(um.devices))
	copy(devices, um.devices)
	return devices
}

// SubmitJob submits a mining job to hardware
func (um *UnifiedManager) SubmitJob(job *MiningJob) error {
	// In a real implementation, this would distribute
	// the job to hardware devices
	um.logger.Debug("Job submitted to hardware",
		zap.String("job_id", job.ID),
		zap.String("algorithm", job.Algorithm))
	
	return nil
}

// GetMetrics returns hardware metrics
func (um *UnifiedManager) GetMetrics() map[string]interface{} {
	totalHashrate := uint64(0)
	totalPower := uint64(0)
	totalTemp := float64(0)
	activeDevices := 0
	
	for _, device := range um.devices {
		if device.IsAvailable() {
			totalHashrate += device.GetHashrate()
			totalPower += uint64(device.GetPowerUsage())
			totalTemp += device.GetTemperature()
			activeDevices++
		}
	}
	
	avgTemp := float64(0)
	if activeDevices > 0 {
		avgTemp = totalTemp / float64(activeDevices)
	}
	
	return map[string]interface{}{
		"devices_total":  um.stats.DevicesTotal.Load(),
		"devices_active": activeDevices,
		"total_hashrate": totalHashrate,
		"total_power":    totalPower,
		"average_temp":   avgTemp,
		"error_count":    um.stats.ErrorCount.Load(),
		"restart_count":  um.stats.RestartCount.Load(),
	}
}

// SetPowerLimit sets the global power limit
func (um *UnifiedManager) SetPowerLimit(watts float64) error {
	um.powerLimit.Store(uint64(watts))
	
	if um.monitor != nil {
		um.monitor.SetLimits(um.monitor.tempLimit, watts)
	}
	
	um.logger.Info("Power limit set",
		zap.Float64("watts", watts))
	
	return nil
}

// SetTemperatureLimit sets the global temperature limit
func (um *UnifiedManager) SetTemperatureLimit(celsius float64) error {
	um.tempLimit.Store(uint64(celsius))
	
	if um.monitor != nil {
		um.monitor.SetLimits(celsius, um.monitor.powerLimit)
	}
	
	um.logger.Info("Temperature limit set",
		zap.Float64("celsius", celsius))
	
	return nil
}

// BenchmarkCPU runs CPU benchmark
func (um *UnifiedManager) BenchmarkCPU() map[string]float64 {
	results := make(map[string]float64)
	
	// Simplified benchmark
	algorithms := []string{"sha256d", "scrypt", "randomx"}
	
	for _, algo := range algorithms {
		// Simulate benchmark
		hashrate := float64(1000000 + runtime.NumCPU()*500000)
		results[algo] = hashrate
	}
	
	return results
}

// BenchmarkGPU runs GPU benchmark
func (um *UnifiedManager) BenchmarkGPU() map[string]map[string]float64 {
	results := make(map[string]map[string]float64)
	
	for _, gpu := range um.gpuDevices {
		gpuResults := make(map[string]float64)
		
		// Simplified benchmark
		algorithms := []string{"ethash", "cryptonight", "x11"}
		
		for _, algo := range algorithms {
			// Simulate benchmark based on GPU
			hashrate := float64(10000000 + gpu.ComputeUnits*1000000)
			gpuResults[algo] = hashrate
		}
		
		results[gpu.Name] = gpuResults
	}
	
	return results
}

// HasGPU returns true if GPU devices are available
func (um *UnifiedManager) HasGPU() bool {
	return len(um.gpuDevices) > 0
}

// Private methods

func (um *UnifiedManager) initializeCPU() error {
	um.logger.Info("Initializing CPU devices")
	
	// Detect CPU
	cpu := &CPUDevice{
		ID:      "cpu-0",
		Name:    fmt.Sprintf("CPU %d cores", runtime.NumCPU()),
		Cores:   runtime.NumCPU(),
		Threads: runtime.NumCPU(),
	}
	
	// Configure threads
	if um.config.CPU.Threads > 0 {
		cpu.Threads = um.config.CPU.Threads
	}
	
	cpu.Available.Store(true)
	
	um.cpuDevices = append(um.cpuDevices, cpu)
	um.devices = append(um.devices, cpu)
	
	// Create CPU manager
	um.cpuManager = &CPUManager{
		logger:   um.logger,
		devices:  um.cpuDevices,
		threads:  cpu.Threads,
		affinity: um.config.CPU.Affinity,
	}
	
	um.logger.Info("CPU initialized",
		zap.Int("cores", cpu.Cores),
		zap.Int("threads", cpu.Threads))
	
	return nil
}

func (um *UnifiedManager) initializeGPU() error {
	um.logger.Info("Initializing GPU devices")
	
	// Detect GPUs (simplified - would use actual GPU libraries)
	gpuCount := um.detectGPUs()
	
	for i := 0; i < gpuCount; i++ {
		gpu := &GPUDevice{
			ID:           fmt.Sprintf("gpu-%d", i),
			Name:         fmt.Sprintf("GPU %d", i),
			Index:        i,
			Memory:       8589934592, // 8GB
			ComputeUnits: 36,         // Simplified
		}
		
		gpu.Available.Store(true)
		gpu.Intensity.Store(int32(um.config.GPU.Intensity))
		
		um.gpuDevices = append(um.gpuDevices, gpu)
		um.devices = append(um.devices, gpu)
	}
	
	// Create GPU manager
	um.gpuManager = &GPUManager{
		logger:  um.logger,
		devices: um.gpuDevices,
	}
	
	um.logger.Info("GPU initialized",
		zap.Int("count", gpuCount))
	
	return nil
}

func (um *UnifiedManager) initializeASIC() error {
	um.logger.Info("Initializing ASIC devices")
	
	// Detect ASICs (simplified - would use actual ASIC communication)
	for i, device := range um.config.ASIC.Devices {
		asic := &ASICDevice{
			ID:         fmt.Sprintf("asic-%d", i),
			Name:       fmt.Sprintf("ASIC %d", i),
			Model:      "Generic ASIC",
			SerialPort: device,
			ChipCount:  288, // Typical chip count
		}
		
		asic.Available.Store(false) // Would test actual connection
		asic.Frequency.Store(int32(um.config.ASIC.Frequency))
		
		um.asicDevices = append(um.asicDevices, asic)
		um.devices = append(um.devices, asic)
	}
	
	// Create ASIC manager
	um.asicManager = &ASICManager{
		logger:  um.logger,
		devices: um.asicDevices,
	}
	
	um.logger.Info("ASIC initialized",
		zap.Int("count", len(um.asicDevices)))
	
	return nil
}

func (um *UnifiedManager) detectGPUs() int {
	// Simplified GPU detection
	// In production, would use OpenCL/CUDA libraries
	// to detect actual GPUs
	
	// Check environment or return default
	return 0 // Return 0 for now to avoid issues
}

func (um *UnifiedManager) monitorLoop() {
	defer um.wg.Done()
	
	ticker := time.NewTicker(um.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-um.ctx.Done():
			return
		case <-ticker.C:
			um.checkDeviceHealth()
		}
	}
}

func (um *UnifiedManager) checkDeviceHealth() {
	for _, device := range um.devices {
		// Check temperature
		temp := device.GetTemperature()
		if temp > um.config.TemperatureLimit {
			um.logger.Warn("Device overheating",
				zap.String("device", device.GetName()),
				zap.Float64("temperature", temp))
			
			// Throttle or stop device
			um.handleOverheat(device)
		}
		
		// Check power
		power := device.GetPowerUsage()
		if power > um.config.PowerLimit {
			um.logger.Warn("Device exceeding power limit",
				zap.String("device", device.GetName()),
				zap.Float64("power", power))
			
			// Reduce intensity
			um.handlePowerLimit(device)
		}
	}
	
	// Update statistics
	um.updateStatistics()
}

func (um *UnifiedManager) handleOverheat(device MiningDevice) {
	// Reduce intensity or stop device
	switch d := device.(type) {
	case *GPUDevice:
		currentIntensity := d.Intensity.Load()
		if currentIntensity > 10 {
			d.SetIntensity(int(currentIntensity - 2))
		} else {
			d.Stop()
		}
	case *CPUDevice:
		d.Stop()
		um.stats.RestartCount.Add(1)
	}
}

func (um *UnifiedManager) handlePowerLimit(device MiningDevice) {
	// Reduce device intensity
	switch d := device.(type) {
	case *GPUDevice:
		currentIntensity := d.Intensity.Load()
		if currentIntensity > 5 {
			d.SetIntensity(int(currentIntensity - 1))
		}
	}
}

func (um *UnifiedManager) updateStatistics() {
	totalHashrate := uint64(0)
	totalPower := uint64(0)
	activeCount := int32(0)
	
	for _, device := range um.devices {
		if device.IsAvailable() {
			totalHashrate += device.GetHashrate()
			totalPower += uint64(device.GetPowerUsage())
			activeCount++
		}
	}
	
	um.stats.TotalHashrate.Store(totalHashrate)
	um.stats.TotalPower.Store(totalPower)
	um.stats.DevicesActive.Store(activeCount)
}

// Device implementations

// CPUDevice methods
func (d *CPUDevice) GetID() string           { return d.ID }
func (d *CPUDevice) GetName() string         { return d.Name }
func (d *CPUDevice) GetType() DeviceType     { return DeviceTypeCPU }
func (d *CPUDevice) IsAvailable() bool       { return d.Available.Load() }
func (d *CPUDevice) GetHashrate() uint64     { return d.Hashrate.Load() }
func (d *CPUDevice) GetTemperature() float64 { return float64(d.Temperature.Load()) / 100 }
func (d *CPUDevice) GetPowerUsage() float64  { return float64(d.PowerUsage.Load()) / 100 }
func (d *CPUDevice) GetMemoryUsage() uint64  { return 0 }

func (d *CPUDevice) SetIntensity(intensity int) error {
	d.Intensity.Store(int32(intensity))
	return nil
}

func (d *CPUDevice) Start(algorithm string) error {
	d.mining.Store(true)
	// Start CPU mining (simplified)
	return nil
}

func (d *CPUDevice) Stop() error {
	d.mining.Store(false)
	return nil
}

// GPUDevice methods
func (d *GPUDevice) GetID() string           { return d.ID }
func (d *GPUDevice) GetName() string         { return d.Name }
func (d *GPUDevice) GetType() DeviceType     { return DeviceTypeGPU }
func (d *GPUDevice) IsAvailable() bool       { return d.Available.Load() }
func (d *GPUDevice) GetHashrate() uint64     { return d.Hashrate.Load() }
func (d *GPUDevice) GetTemperature() float64 { return float64(d.Temperature.Load()) / 100 }
func (d *GPUDevice) GetPowerUsage() float64  { return float64(d.PowerUsage.Load()) / 100 }
func (d *GPUDevice) GetMemoryUsage() uint64  { return d.MemoryUsage.Load() }

func (d *GPUDevice) SetIntensity(intensity int) error {
	if intensity < 1 || intensity > 30 {
		return errors.New("intensity must be between 1 and 30")
	}
	d.Intensity.Store(int32(intensity))
	return nil
}

func (d *GPUDevice) Start(algorithm string) error {
	d.mining.Store(true)
	// Start GPU mining (simplified)
	return nil
}

func (d *GPUDevice) Stop() error {
	d.mining.Store(false)
	return nil
}

// ASICDevice methods
func (d *ASICDevice) GetID() string           { return d.ID }
func (d *ASICDevice) GetName() string         { return d.Name }
func (d *ASICDevice) GetType() DeviceType     { return DeviceTypeASIC }
func (d *ASICDevice) IsAvailable() bool       { return d.Available.Load() }
func (d *ASICDevice) GetHashrate() uint64     { return d.Hashrate.Load() }
func (d *ASICDevice) GetTemperature() float64 { return float64(d.Temperature.Load()) / 100 }
func (d *ASICDevice) GetPowerUsage() float64  { return float64(d.PowerUsage.Load()) / 100 }
func (d *ASICDevice) GetMemoryUsage() uint64  { return 0 }

func (d *ASICDevice) SetIntensity(intensity int) error {
	// ASICs typically use frequency instead of intensity
	d.Frequency.Store(int32(intensity * 10))
	return nil
}

func (d *ASICDevice) Start(algorithm string) error {
	d.mining.Store(true)
	// Start ASIC mining (simplified)
	return nil
}

func (d *ASICDevice) Stop() error {
	d.mining.Store(false)
	return nil
}

// HardwareMonitor implementation

func NewHardwareMonitor(logger *zap.Logger, devices []MiningDevice, interval time.Duration) *HardwareMonitor {
	return &HardwareMonitor{
		logger:   logger,
		devices:  devices,
		interval: interval,
		alerts:   make(chan *Alert, 100),
	}
}

func (hm *HardwareMonitor) SetLimits(tempLimit, powerLimit float64) {
	hm.tempLimit = tempLimit
	hm.powerLimit = powerLimit
}

func (hm *HardwareMonitor) Start() {
	hm.running.Store(true)
	go hm.monitorLoop()
}

func (hm *HardwareMonitor) Stop() {
	hm.running.Store(false)
}

func (hm *HardwareMonitor) monitorLoop() {
	ticker := time.NewTicker(hm.interval)
	defer ticker.Stop()
	
	for hm.running.Load() {
		select {
		case <-ticker.C:
			hm.checkDevices()
		}
	}
}

func (hm *HardwareMonitor) checkDevices() {
	for _, device := range hm.devices {
		// Check temperature
		temp := device.GetTemperature()
		if temp > hm.tempLimit {
			alert := &Alert{
				Timestamp: time.Now(),
				Device:    device.GetName(),
				Type:      "temperature",
				Severity:  "critical",
				Message:   fmt.Sprintf("Temperature exceeds limit: %.1f°C", temp),
				Value:     temp,
			}
			
			select {
			case hm.alerts <- alert:
			default:
				// Alert channel full
			}
		}
		
		// Check power
		power := device.GetPowerUsage()
		if power > hm.powerLimit {
			alert := &Alert{
				Timestamp: time.Now(),
				Device:    device.GetName(),
				Type:      "power",
				Severity:  "warning",
				Message:   fmt.Sprintf("Power exceeds limit: %.1fW", power),
				Value:     power,
			}
			
			select {
			case hm.alerts <- alert:
			default:
				// Alert channel full
			}
		}
	}
}
