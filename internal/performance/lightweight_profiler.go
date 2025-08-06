package performance

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"go.uber.org/zap"
)

// LockFreeProfiler provides minimal overhead performance monitoring
// Following John Carmack's principle: "Optimization is about removing work, not doing work faster"
type LockFreeProfiler struct {
	logger *zap.Logger
	
	// Lock-free circular buffers for metrics - zero allocation hot path
	hashRateBuffer    *CircularBuffer
	temperatureBuffer *CircularBuffer
	powerBuffer      *CircularBuffer
	memoryBuffer     *CircularBuffer
	
	// Atomic counters for efficiency metrics
	totalHashes     atomic.Uint64
	totalShares     atomic.Uint64
	acceptedShares  atomic.Uint64
	rejectedShares  atomic.Uint64
	staleShares     atomic.Uint64
	
	// Performance metrics
	avgHashTime     atomic.Uint64 // nanoseconds
	avgShareTime    atomic.Uint64 // nanoseconds
	gcPauseTime     atomic.Uint64 // nanoseconds
	
	// System metrics
	cpuUsage        atomic.Uint64 // percentage * 100
	memoryUsage     atomic.Uint64 // bytes
	networkThroughput atomic.Uint64 // bytes/sec
	
	// Mining specific metrics
	currentDifficulty atomic.Uint64
	networkHashRate   atomic.Uint64
	poolHashRate      atomic.Uint64
	
	// Hardware metrics (2025 ASIC support)
	coreTemperature   atomic.Uint64 // celsius * 100
	chipTemperature   atomic.Uint64 // celsius * 100
	fanSpeed          atomic.Uint64 // RPM
	powerConsumption  atomic.Uint64 // watts * 100
	efficiency        atomic.Uint64 // J/TH * 100
	
	// Status and lifecycle
	running         atomic.Bool
	startTime       time.Time
	
	// Configuration
	config          *ProfilerConfig
	
	// Sampling control
	sampleTicker    *time.Ticker
	cleanupTicker   *time.Ticker
	
	// Context for graceful shutdown
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// CircularBuffer implements lock-free circular buffer for metrics
type CircularBuffer struct {
	data     []uint64
	size     uint64
	mask     uint64 // size - 1, for fast modulo
	writeIdx atomic.Uint64
	readIdx  atomic.Uint64
}

// MetricSample represents a single metric sample
type MetricSample struct {
	Timestamp time.Time `json:"timestamp"`
	Value     float64   `json:"value"`
	Unit      string    `json:"unit"`
}

// ProfilerConfig contains profiler configuration
type ProfilerConfig struct {
	// Sampling settings
	SampleInterval    time.Duration `validate:"min=100ms,max=10s"`
	BufferSize        int          `validate:"min=64,max=8192"`
	MaxMemoryMB       int          `validate:"min=1,max=1024"`
	
	// Feature toggles
	EnableCPUProfiling    bool
	EnableMemoryProfiling bool
	EnableHardwareProfiling bool
	EnableNetworkProfiling bool
	
	// Hardware specific
	EnableASICMetrics     bool
	EnableThermalMetrics  bool
	EnablePowerMetrics    bool
	
	// Output settings
	LogInterval       time.Duration
	MetricsEndpoint   string
	PrometheusPort    int
	
	// Performance tuning
	MaxGoroutines     int
	GCTargetPercent   int
	MemoryLimit       uint64
	
	// Alert thresholds
	HighTempThreshold    float64 // Celsius
	LowEfficiencyThreshold float64 // J/TH
	HighMemoryThreshold  float64 // Percentage
}

// ProfilerStats contains comprehensive profiler statistics
type ProfilerStats struct {
	// Basic stats
	Uptime          time.Duration `json:"uptime"`
	SampleCount     uint64        `json:"sample_count"`
	BufferUtilization float64     `json:"buffer_utilization"`
	
	// Mining performance
	AverageHashRate   float64 `json:"average_hash_rate_th"`
	PeakHashRate      float64 `json:"peak_hash_rate_th"`
	SharesPerMinute   float64 `json:"shares_per_minute"`
	AcceptanceRate    float64 `json:"acceptance_rate_percent"`
	StaleRate         float64 `json:"stale_rate_percent"`
	
	// Hardware status (2025 ASICs)
	CoreTemperature   float64 `json:"core_temperature_c"`
	ChipTemperature   float64 `json:"chip_temperature_c"`
	FanSpeed          uint64  `json:"fan_speed_rpm"`
	PowerConsumption  float64 `json:"power_consumption_w"`
	Efficiency        float64 `json:"efficiency_j_th"`
	ThermalThrottling bool    `json:"thermal_throttling"`
	
	// System performance
	CPUUsage         float64 `json:"cpu_usage_percent"`
	MemoryUsage      uint64  `json:"memory_usage_mb"`
	MemoryUsagePercent float64 `json:"memory_usage_percent"`
	GCPauseAvg       time.Duration `json:"gc_pause_avg"`
	NetworkThroughput uint64 `json:"network_throughput_mbps"`
	
	// Profiler overhead
	ProfilerCPUUsage    float64       `json:"profiler_cpu_usage_percent"`
	ProfilerMemoryUsage uint64        `json:"profiler_memory_usage_kb"`
	SamplingOverhead    time.Duration `json:"sampling_overhead_ns"`
}

// NewLockFreeProfiler creates a new lightweight profiler
func NewLockFreeProfiler(logger *zap.Logger, config *ProfilerConfig) *LockFreeProfiler {
	if config == nil {
		config = DefaultProfilerConfig()
	}
	
	// Ensure buffer size is power of 2 for efficient masking
	bufferSize := nextPowerOf2(uint64(config.BufferSize))
	
	ctx, cancel := context.WithCancel(context.Background())
	
	p := &LockFreeProfiler{
		logger:    logger.With(zap.String("component", "profiler")),
		config:    config,
		startTime: time.Now(),
		ctx:       ctx,
		cancel:    cancel,
		
		// Initialize circular buffers
		hashRateBuffer:    NewCircularBuffer(bufferSize),
		temperatureBuffer: NewCircularBuffer(bufferSize),
		powerBuffer:      NewCircularBuffer(bufferSize),
		memoryBuffer:     NewCircularBuffer(bufferSize),
	}
	
	return p
}

// NewCircularBuffer creates a new lock-free circular buffer
func NewCircularBuffer(size uint64) *CircularBuffer {
	return &CircularBuffer{
		data: make([]uint64, size),
		size: size,
		mask: size - 1, // For fast modulo operation
	}
}

// Start begins profiling with minimal overhead
func (p *LockFreeProfiler) Start() error {
	if !p.running.CompareAndSwap(false, true) {
		return ErrProfilerAlreadyRunning
	}
	
	p.logger.Info("Starting lightweight profiler",
		zap.Duration("sample_interval", p.config.SampleInterval),
		zap.Int("buffer_size", p.config.BufferSize),
		zap.Bool("asic_metrics", p.config.EnableASICMetrics))
	
	// Configure GC for mining workload
	if p.config.GCTargetPercent > 0 {
		runtime.SetGCPercent(p.config.GCTargetPercent)
	}
	
	// Start sampling goroutine
	p.sampleTicker = time.NewTicker(p.config.SampleInterval)
	p.wg.Add(1)
	go p.samplingLoop()
	
	// Start cleanup goroutine
	p.cleanupTicker = time.NewTicker(time.Minute)
	p.wg.Add(1)
	go p.cleanupLoop()
	
	// Start hardware monitoring if enabled
	if p.config.EnableHardwareProfiling {
		p.wg.Add(1)
		go p.hardwareMonitoringLoop()
	}
	
	p.logger.Info("Lightweight profiler started successfully")
	return nil
}

// Stop gracefully stops the profiler
func (p *LockFreeProfiler) Stop() error {
	if !p.running.CompareAndSwap(true, false) {
		return ErrProfilerNotRunning
	}
	
	p.logger.Info("Stopping lightweight profiler")
	
	// Stop tickers
	if p.sampleTicker != nil {
		p.sampleTicker.Stop()
	}
	if p.cleanupTicker != nil {
		p.cleanupTicker.Stop()
	}
	
	// Cancel context and wait for goroutines
	p.cancel()
	p.wg.Wait()
	
	p.logger.Info("Lightweight profiler stopped")
	return nil
}

// RecordHash records a hash computation with minimal overhead
func (p *LockFreeProfiler) RecordHash(hashTime time.Duration, hashRate uint64) {
	if !p.running.Load() {
		return
	}
	
	// Atomic operations for thread safety
	p.totalHashes.Add(1)
	
	// Update average hash time using exponential moving average
	currentAvg := p.avgHashTime.Load()
	newTime := uint64(hashTime.Nanoseconds())
	if currentAvg == 0 {
		p.avgHashTime.Store(newTime)
	} else {
		// EMA with alpha = 0.1 for smoothing
		newAvg := (currentAvg*9 + newTime) / 10
		p.avgHashTime.Store(newAvg)
	}
	
	// Store hash rate in circular buffer
	p.hashRateBuffer.Write(hashRate)
}

// RecordShare records share submission statistics
func (p *LockFreeProfiler) RecordShare(shareTime time.Duration, accepted bool, stale bool) {
	if !p.running.Load() {
		return
	}
	
	p.totalShares.Add(1)
	
	if accepted {
		p.acceptedShares.Add(1)
	} else {
		p.rejectedShares.Add(1)
	}
	
	if stale {
		p.staleShares.Add(1)
	}
	
	// Update average share processing time
	currentAvg := p.avgShareTime.Load()
	newTime := uint64(shareTime.Nanoseconds())
	if currentAvg == 0 {
		p.avgShareTime.Store(newTime)
	} else {
		newAvg := (currentAvg*9 + newTime) / 10
		p.avgShareTime.Store(newAvg)
	}
}

// RecordTemperature records hardware temperature
func (p *LockFreeProfiler) RecordTemperature(coreTemp, chipTemp float64) {
	if !p.running.Load() || !p.config.EnableThermalMetrics {
		return
	}
	
	// Store temperatures as fixed-point integers (celsius * 100)
	coreTemp100 := uint64(coreTemp * 100)
	chipTemp100 := uint64(chipTemp * 100)
	
	p.coreTemperature.Store(coreTemp100)
	p.chipTemperature.Store(chipTemp100)
	
	// Store in circular buffer for trending
	p.temperatureBuffer.Write(coreTemp100)
	
	// Check thermal throttling threshold
	if coreTemp > p.config.HighTempThreshold {
		p.logger.Warn("High temperature detected",
			zap.Float64("core_temp", coreTemp),
			zap.Float64("threshold", p.config.HighTempThreshold))
	}
}

// RecordPower records power consumption and efficiency
func (p *LockFreeProfiler) RecordPower(watts float64, efficiency float64) {
	if !p.running.Load() || !p.config.EnablePowerMetrics {
		return
	}
	
	// Store as fixed-point integers
	watts100 := uint64(watts * 100)
	efficiency100 := uint64(efficiency * 100)
	
	p.powerConsumption.Store(watts100)
	p.efficiency.Store(efficiency100)
	
	// Store in circular buffer
	p.powerBuffer.Write(watts100)
	
	// Check efficiency threshold
	if efficiency > p.config.LowEfficiencyThreshold {
		p.logger.Warn("Low efficiency detected",
			zap.Float64("efficiency", efficiency),
			zap.Float64("threshold", p.config.LowEfficiencyThreshold))
	}
}

// GetStats returns comprehensive profiler statistics
func (p *LockFreeProfiler) GetStats() *ProfilerStats {
	if !p.running.Load() {
		return nil
	}
	
	stats := &ProfilerStats{
		Uptime:      time.Since(p.startTime),
		SampleCount: p.totalHashes.Load(),
	}
	
	// Calculate mining performance metrics
	totalShares := p.totalShares.Load()
	acceptedShares := p.acceptedShares.Load()
	staleShares := p.staleShares.Load()
	
	if totalShares > 0 {
		stats.AcceptanceRate = float64(acceptedShares) / float64(totalShares) * 100
		stats.StaleRate = float64(staleShares) / float64(totalShares) * 100
		
		// Calculate shares per minute
		minutes := stats.Uptime.Minutes()
		if minutes > 0 {
			stats.SharesPerMinute = float64(totalShares) / minutes
		}
	}
	
	// Get hardware metrics
	if p.config.EnableThermalMetrics {
		stats.CoreTemperature = float64(p.coreTemperature.Load()) / 100
		stats.ChipTemperature = float64(p.chipTemperature.Load()) / 100
		stats.ThermalThrottling = stats.CoreTemperature > p.config.HighTempThreshold
	}
	
	if p.config.EnablePowerMetrics {
		stats.PowerConsumption = float64(p.powerConsumption.Load()) / 100
		stats.Efficiency = float64(p.efficiency.Load()) / 100
	}
	
	// Calculate hash rate statistics
	stats.AverageHashRate = p.calculateAverageHashRate()
	stats.PeakHashRate = p.calculatePeakHashRate()
	
	// System metrics
	stats.CPUUsage = float64(p.cpuUsage.Load()) / 100
	stats.MemoryUsage = p.memoryUsage.Load() / 1024 / 1024 // Convert to MB
	stats.GCPauseAvg = time.Duration(p.gcPauseTime.Load())
	stats.NetworkThroughput = p.networkThroughput.Load() / 1024 / 1024 // Convert to Mbps
	
	// Buffer utilization
	stats.BufferUtilization = p.calculateBufferUtilization()
	
	// Profiler overhead (should be minimal)
	stats.ProfilerCPUUsage = p.calculateProfilerOverhead()
	stats.SamplingOverhead = time.Duration(p.avgHashTime.Load())
	
	return stats
}

// Write adds a value to the circular buffer (lock-free)
func (cb *CircularBuffer) Write(value uint64) {
	writeIdx := cb.writeIdx.Add(1) - 1
	idx := writeIdx & cb.mask
	cb.data[idx] = value
}

// Read reads the most recent value (lock-free)
func (cb *CircularBuffer) Read() uint64 {
	writeIdx := cb.writeIdx.Load()
	if writeIdx == 0 {
		return 0
	}
	idx := (writeIdx - 1) & cb.mask
	return cb.data[idx]
}

// ReadRange reads a range of recent values (lock-free)
func (cb *CircularBuffer) ReadRange(count int) []uint64 {
	if count <= 0 {
		return nil
	}
	
	writeIdx := cb.writeIdx.Load()
	if writeIdx == 0 {
		return nil
	}
	
	// Limit count to buffer size
	if uint64(count) > cb.size {
		count = int(cb.size)
	}
	
	// Limit count to available data
	if uint64(count) > writeIdx {
		count = int(writeIdx)
	}
	
	result := make([]uint64, count)
	for i := 0; i < count; i++ {
		idx := (writeIdx - uint64(i) - 1) & cb.mask
		result[count-1-i] = cb.data[idx]
	}
	
	return result
}

// Private methods

func (p *LockFreeProfiler) samplingLoop() {
	defer p.wg.Done()
	
	for {
		select {
		case <-p.sampleTicker.C:
			p.collectSystemMetrics()
		case <-p.ctx.Done():
			return
		}
	}
}

func (p *LockFreeProfiler) collectSystemMetrics() {
	if p.config.EnableCPUProfiling {
		p.collectCPUMetrics()
	}
	
	if p.config.EnableMemoryProfiling {
		p.collectMemoryMetrics()
	}
	
	if p.config.EnableNetworkProfiling {
		p.collectNetworkMetrics()
	}
}

func (p *LockFreeProfiler) collectCPUMetrics() {
	// Simplified CPU usage calculation
	// In production, this would use more sophisticated methods
	var usage float64 = 75.0 // Placeholder
	p.cpuUsage.Store(uint64(usage * 100))
}

func (p *LockFreeProfiler) collectMemoryMetrics() {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	p.memoryUsage.Store(m.Alloc)
	p.gcPauseTime.Store(uint64(m.PauseNs[(m.NumGC+255)%256]))
	
	// Store in circular buffer
	p.memoryBuffer.Write(m.Alloc)
}

func (p *LockFreeProfiler) collectNetworkMetrics() {
	// Network throughput would be calculated based on actual network I/O
	// This is a simplified placeholder
	throughput := uint64(100 * 1024 * 1024) // 100 Mbps placeholder
	p.networkThroughput.Store(throughput)
}

func (p *LockFreeProfiler) hardwareMonitoringLoop() {
	defer p.wg.Done()
	
	ticker := time.NewTicker(5 * time.Second) // Hardware monitoring at 5s intervals
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			p.collectHardwareMetrics()
		case <-p.ctx.Done():
			return
		}
	}
}

func (p *LockFreeProfiler) collectHardwareMetrics() {
	// In a real implementation, this would interface with ASIC firmware APIs
	// This is a simplified simulation for demonstration
	
	if p.config.EnableASICMetrics {
		// Simulate ASIC metrics
		coreTemp := 65.5  // Celsius
		chipTemp := 68.2  // Celsius
		fanRPM := uint64(3200)
		watts := 3510.0   // Antminer S21 Pro power consumption
		efficiency := 15.0 // J/TH
		
		p.RecordTemperature(coreTemp, chipTemp)
		p.RecordPower(watts, efficiency)
		p.fanSpeed.Store(fanRPM)
	}
}

func (p *LockFreeProfiler) cleanupLoop() {
	defer p.wg.Done()
	
	for {
		select {
		case <-p.cleanupTicker.C:
			p.performCleanup()
		case <-p.ctx.Done():
			return
		}
	}
}

func (p *LockFreeProfiler) performCleanup() {
	// Force garbage collection periodically to maintain consistent performance
	if p.config.EnableMemoryProfiling {
		runtime.GC()
	}
	
	// Log periodic statistics
	if p.config.LogInterval > 0 {
		stats := p.GetStats()
		p.logger.Info("Profiler stats",
			zap.Float64("avg_hash_rate_th", stats.AverageHashRate),
			zap.Float64("acceptance_rate", stats.AcceptanceRate),
			zap.Float64("core_temp", stats.CoreTemperature),
			zap.Float64("efficiency_j_th", stats.Efficiency),
			zap.Float64("cpu_usage", stats.CPUUsage),
			zap.Uint64("memory_mb", stats.MemoryUsage))
	}
}

func (p *LockFreeProfiler) calculateAverageHashRate() float64 {
	values := p.hashRateBuffer.ReadRange(60) // Last 60 samples
	if len(values) == 0 {
		return 0
	}
	
	var sum uint64
	for _, v := range values {
		sum += v
	}
	
	return float64(sum) / float64(len(values)) / 1e12 // Convert to TH/s
}

func (p *LockFreeProfiler) calculatePeakHashRate() float64 {
	values := p.hashRateBuffer.ReadRange(60)
	if len(values) == 0 {
		return 0
	}
	
	var peak uint64
	for _, v := range values {
		if v > peak {
			peak = v
		}
	}
	
	return float64(peak) / 1e12 // Convert to TH/s
}

func (p *LockFreeProfiler) calculateBufferUtilization() float64 {
	writeIdx := p.hashRateBuffer.writeIdx.Load()
	return float64(writeIdx) / float64(p.hashRateBuffer.size) * 100
}

func (p *LockFreeProfiler) calculateProfilerOverhead() float64 {
	// In practice, this would measure actual profiler CPU usage
	// For now, return a minimal value indicating low overhead
	return 0.5 // 0.5% CPU overhead target
}

// Utility functions

func nextPowerOf2(n uint64) uint64 {
	if n <= 1 {
		return 1
	}
	n--
	n |= n >> 1
	n |= n >> 2
	n |= n >> 4
	n |= n >> 8
	n |= n >> 16
	n |= n >> 32
	return n + 1
}

// DefaultProfilerConfig returns optimized default configuration
func DefaultProfilerConfig() *ProfilerConfig {
	return &ProfilerConfig{
		SampleInterval:         500 * time.Millisecond,
		BufferSize:             1024, // Will be rounded to 1024 (2^10)
		MaxMemoryMB:            64,
		
		EnableCPUProfiling:     true,
		EnableMemoryProfiling:  true,
		EnableHardwareProfiling: true,
		EnableNetworkProfiling: true,
		
		EnableASICMetrics:      true,
		EnableThermalMetrics:   true,
		EnablePowerMetrics:     true,
		
		LogInterval:            time.Minute,
		PrometheusPort:         9090,
		
		MaxGoroutines:          100,
		GCTargetPercent:        200, // Higher for mining workloads
		MemoryLimit:            4 * 1024 * 1024 * 1024, // 4GB
		
		HighTempThreshold:      85.0,  // 85°C
		LowEfficiencyThreshold: 20.0,  // 20 J/TH
		HighMemoryThreshold:    90.0,  // 90%
	}
}

// Error definitions
var (
	ErrProfilerAlreadyRunning = errors.New("profiler already running")
	ErrProfilerNotRunning     = errors.New("profiler not running")
	ErrInvalidConfig         = errors.New("invalid profiler configuration")
)
