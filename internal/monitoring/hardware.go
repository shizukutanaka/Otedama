package monitoring

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"go.uber.org/zap"
)

// HardwareMonitor monitors system hardware and provides auto-tuning recommendations
type HardwareMonitor struct {
	logger       *zap.Logger
	metrics      *HardwareMetrics
	thresholds   *PerformanceThresholds
	tuner        *AutoTuner
	mu           sync.RWMutex
	running      bool
	ctx          context.Context
	cancel       context.CancelFunc
}

// HardwareMetrics contains current hardware metrics
type HardwareMetrics struct {
	CPU         CPUMetrics         `json:"cpu"`
	Memory      MemoryMetrics      `json:"memory"`
	GPU         []GPUMetrics       `json:"gpu"`
	Network     NetworkMetrics     `json:"network"`
	Disk        DiskMetrics        `json:"disk"`
	Temperature TemperatureMetrics `json:"temperature"`
	UpdatedAt   time.Time          `json:"updated_at"`
}

// CPUMetrics contains CPU-specific metrics
type CPUMetrics struct {
	UsagePercent    float64   `json:"usage_percent"`
	PerCoreUsage    []float64 `json:"per_core_usage"`
	Temperature     float64   `json:"temperature"`
	Frequency       float64   `json:"frequency"`
	TurboAvailable  bool      `json:"turbo_available"`
	LoadAverage     []float64 `json:"load_average"`
	ContextSwitches uint64    `json:"context_switches"`
}

// MemoryMetrics contains memory-specific metrics
type MemoryMetrics struct {
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Available   uint64  `json:"available"`
	UsedPercent float64 `json:"used_percent"`
	SwapTotal   uint64  `json:"swap_total"`
	SwapUsed    uint64  `json:"swap_used"`
	Cached      uint64  `json:"cached"`
	Buffers     uint64  `json:"buffers"`
}

// GPUMetrics contains GPU-specific metrics
type GPUMetrics struct {
	Index            int     `json:"index"`
	Name             string  `json:"name"`
	MemoryTotal      uint64  `json:"memory_total"`
	MemoryUsed       uint64  `json:"memory_used"`
	MemoryFree       uint64  `json:"memory_free"`
	Temperature      float64 `json:"temperature"`
	PowerDraw        float64 `json:"power_draw"`
	PowerLimit       float64 `json:"power_limit"`
	UtilizationGPU   float64 `json:"utilization_gpu"`
	UtilizationMem   float64 `json:"utilization_memory"`
	FanSpeed         float64 `json:"fan_speed"`
	PerformanceState string  `json:"performance_state"`
}

// NetworkMetrics contains network-specific metrics
type NetworkMetrics struct {
	BytesSent     uint64  `json:"bytes_sent"`
	BytesRecv     uint64  `json:"bytes_recv"`
	PacketsSent   uint64  `json:"packets_sent"`
	PacketsRecv   uint64  `json:"packets_recv"`
	Errin         uint64  `json:"errors_in"`
	Errout        uint64  `json:"errors_out"`
	Dropin        uint64  `json:"drops_in"`
	Dropout       uint64  `json:"drops_out"`
	Bandwidth     float64 `json:"bandwidth_mbps"`
}

// DiskMetrics contains disk-specific metrics
type DiskMetrics struct {
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Free        uint64  `json:"free"`
	UsedPercent float64 `json:"used_percent"`
	IOWait      float64 `json:"io_wait"`
	ReadSpeed   float64 `json:"read_speed_mbps"`
	WriteSpeed  float64 `json:"write_speed_mbps"`
}

// TemperatureMetrics contains temperature readings
type TemperatureMetrics struct {
	CPU      float64            `json:"cpu"`
	GPU      []float64          `json:"gpu"`
	System   float64            `json:"system"`
	Warnings map[string]float64 `json:"warnings"`
}

// PerformanceThresholds defines thresholds for auto-tuning
type PerformanceThresholds struct {
	CPUUsageHigh      float64 `json:"cpu_usage_high"`
	CPUUsageLow       float64 `json:"cpu_usage_low"`
	MemoryUsageHigh   float64 `json:"memory_usage_high"`
	GPUUsageHigh      float64 `json:"gpu_usage_high"`
	GPUTempHigh       float64 `json:"gpu_temp_high"`
	DiskUsageHigh     float64 `json:"disk_usage_high"`
	NetworkUsageHigh  float64 `json:"network_usage_high"`
}

// AutoTuner provides automatic performance tuning
type AutoTuner struct {
	logger         *zap.Logger
	recommendations []TuningRecommendation
	applied        map[string]time.Time
	mu             sync.RWMutex
}

// TuningRecommendation represents a performance tuning recommendation
type TuningRecommendation struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	Severity    string                 `json:"severity"`
	Component   string                 `json:"component"`
	Description string                 `json:"description"`
	Actions     []string               `json:"actions"`
	Parameters  map[string]interface{} `json:"parameters"`
	CreatedAt   time.Time              `json:"created_at"`
}

// NewHardwareMonitor creates a new hardware monitor
func NewHardwareMonitor(logger *zap.Logger) *HardwareMonitor {
	ctx, cancel := context.WithCancel(context.Background())
	return &HardwareMonitor{
		logger:     logger,
		metrics:    &HardwareMetrics{},
		thresholds: DefaultThresholds(),
		tuner:      NewAutoTuner(logger),
		ctx:        ctx,
		cancel:     cancel,
	}
}

// DefaultThresholds returns default performance thresholds
func DefaultThresholds() *PerformanceThresholds {
	return &PerformanceThresholds{
		CPUUsageHigh:     85.0,
		CPUUsageLow:      20.0,
		MemoryUsageHigh:  90.0,
		GPUUsageHigh:     95.0,
		GPUTempHigh:      85.0,
		DiskUsageHigh:    85.0,
		NetworkUsageHigh: 80.0,
	}
}

// NewAutoTuner creates a new auto-tuner
func NewAutoTuner(logger *zap.Logger) *AutoTuner {
	return &AutoTuner{
		logger:          logger,
		recommendations: make([]TuningRecommendation, 0),
		applied:         make(map[string]time.Time),
	}
}

// Start begins hardware monitoring
func (hm *HardwareMonitor) Start() error {
	hm.mu.Lock()
	if hm.running {
		hm.mu.Unlock()
		return fmt.Errorf("hardware monitor already running")
	}
	hm.running = true
	hm.mu.Unlock()

	// Start monitoring goroutine
	go hm.monitorLoop()

	hm.logger.Info("Hardware monitor started")
	return nil
}

// Stop stops hardware monitoring
func (hm *HardwareMonitor) Stop() error {
	hm.mu.Lock()
	if !hm.running {
		hm.mu.Unlock()
		return fmt.Errorf("hardware monitor not running")
	}
	hm.running = false
	hm.mu.Unlock()

	hm.cancel()
	hm.logger.Info("Hardware monitor stopped")
	return nil
}

// monitorLoop continuously monitors hardware
func (hm *HardwareMonitor) monitorLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-hm.ctx.Done():
			return
		case <-ticker.C:
			metrics := hm.collectMetrics()
			hm.updateMetrics(metrics)
			hm.analyzeAndTune(metrics)
		}
	}
}

// collectMetrics collects all hardware metrics
func (hm *HardwareMonitor) collectMetrics() *HardwareMetrics {
	metrics := &HardwareMetrics{
		UpdatedAt: time.Now(),
	}

	// Collect CPU metrics
	metrics.CPU = hm.collectCPUMetrics()

	// Collect memory metrics
	metrics.Memory = hm.collectMemoryMetrics()

	// Collect GPU metrics
	metrics.GPU = hm.collectGPUMetrics()

	// Collect network metrics
	metrics.Network = hm.collectNetworkMetrics()

	// Collect disk metrics
	metrics.Disk = hm.collectDiskMetrics()

	// Collect temperature metrics
	metrics.Temperature = hm.collectTemperatureMetrics()

	return metrics
}

// collectCPUMetrics collects CPU-specific metrics
func (hm *HardwareMonitor) collectCPUMetrics() CPUMetrics {
	metrics := CPUMetrics{}

	// Overall CPU usage
	if percent, err := cpu.Percent(time.Second, false); err == nil && len(percent) > 0 {
		metrics.UsagePercent = percent[0]
	}

	// Per-core CPU usage
	if perCore, err := cpu.Percent(time.Second, true); err == nil {
		metrics.PerCoreUsage = perCore
	}

	// CPU info
	if info, err := cpu.Info(); err == nil && len(info) > 0 {
		metrics.Frequency = info[0].Mhz
	}

	// Load average (Unix-like systems)
	// Note: LoadAvg is not available in gopsutil/v3 for all platforms
	// We'll use a placeholder for now
	metrics.LoadAverage = []float64{0.0, 0.0, 0.0}

	return metrics
}

// collectMemoryMetrics collects memory-specific metrics
func (hm *HardwareMonitor) collectMemoryMetrics() MemoryMetrics {
	metrics := MemoryMetrics{}

	// Virtual memory
	if vmem, err := mem.VirtualMemory(); err == nil {
		metrics.Total = vmem.Total
		metrics.Used = vmem.Used
		metrics.Available = vmem.Available
		metrics.UsedPercent = vmem.UsedPercent
		metrics.Cached = vmem.Cached
		metrics.Buffers = vmem.Buffers
	}

	// Swap memory
	if swap, err := mem.SwapMemory(); err == nil {
		metrics.SwapTotal = swap.Total
		metrics.SwapUsed = swap.Used
	}

	return metrics
}

// collectGPUMetrics collects GPU-specific metrics
func (hm *HardwareMonitor) collectGPUMetrics() []GPUMetrics {
	// This is a placeholder for GPU metrics collection
	// In a real implementation, you would use NVIDIA Management Library (NVML)
	// or AMD GPU libraries to collect actual GPU metrics
	
	// For now, return empty slice
	return []GPUMetrics{}
}

// collectNetworkMetrics collects network-specific metrics
func (hm *HardwareMonitor) collectNetworkMetrics() NetworkMetrics {
	metrics := NetworkMetrics{}

	// Get network I/O statistics
	if iostats, err := net.IOCounters(false); err == nil && len(iostats) > 0 {
		stats := iostats[0]
		metrics.BytesSent = stats.BytesSent
		metrics.BytesRecv = stats.BytesRecv
		metrics.PacketsSent = stats.PacketsSent
		metrics.PacketsRecv = stats.PacketsRecv
		metrics.Errin = stats.Errin
		metrics.Errout = stats.Errout
		metrics.Dropin = stats.Dropin
		metrics.Dropout = stats.Dropout
	}

	return metrics
}

// collectDiskMetrics collects disk-specific metrics
func (hm *HardwareMonitor) collectDiskMetrics() DiskMetrics {
	metrics := DiskMetrics{}

	// Get disk usage for the current working directory
	if usage, err := disk.Usage("."); err == nil {
		metrics.Total = usage.Total
		metrics.Used = usage.Used
		metrics.Free = usage.Free
		metrics.UsedPercent = usage.UsedPercent
	}

	return metrics
}

// collectTemperatureMetrics collects temperature readings
func (hm *HardwareMonitor) collectTemperatureMetrics() TemperatureMetrics {
	metrics := TemperatureMetrics{
		Warnings: make(map[string]float64),
	}

	// Temperature collection is platform-specific
	// This is a placeholder implementation
	
	return metrics
}

// updateMetrics updates the stored metrics
func (hm *HardwareMonitor) updateMetrics(metrics *HardwareMetrics) {
	hm.mu.Lock()
	hm.metrics = metrics
	hm.mu.Unlock()
}

// GetMetrics returns the current hardware metrics
func (hm *HardwareMonitor) GetMetrics() *HardwareMetrics {
	hm.mu.RLock()
	defer hm.mu.RUnlock()
	return hm.metrics
}

// analyzeAndTune analyzes metrics and applies auto-tuning
func (hm *HardwareMonitor) analyzeAndTune(metrics *HardwareMetrics) {
	recommendations := hm.tuner.Analyze(metrics, hm.thresholds)
	
	for _, rec := range recommendations {
		if hm.tuner.ShouldApply(rec) {
			hm.tuner.Apply(rec)
		}
	}
}

// Analyze generates tuning recommendations based on metrics
func (at *AutoTuner) Analyze(metrics *HardwareMetrics, thresholds *PerformanceThresholds) []TuningRecommendation {
	at.mu.Lock()
	defer at.mu.Unlock()

	recommendations := []TuningRecommendation{}

	// CPU analysis
	if metrics.CPU.UsagePercent > thresholds.CPUUsageHigh {
		rec := TuningRecommendation{
			ID:          fmt.Sprintf("cpu-high-%d", time.Now().Unix()),
			Type:        "performance",
			Severity:    "warning",
			Component:   "cpu",
			Description: fmt.Sprintf("CPU usage is high: %.2f%%", metrics.CPU.UsagePercent),
			Actions: []string{
				"Reduce mining threads",
				"Lower mining intensity",
				"Enable CPU throttling",
			},
			Parameters: map[string]interface{}{
				"current_usage": metrics.CPU.UsagePercent,
				"threshold":     thresholds.CPUUsageHigh,
			},
			CreatedAt: time.Now(),
		}
		recommendations = append(recommendations, rec)
	}

	// Memory analysis
	if metrics.Memory.UsedPercent > thresholds.MemoryUsageHigh {
		rec := TuningRecommendation{
			ID:          fmt.Sprintf("mem-high-%d", time.Now().Unix()),
			Type:        "memory",
			Severity:    "critical",
			Component:   "memory",
			Description: fmt.Sprintf("Memory usage is critical: %.2f%%", metrics.Memory.UsedPercent),
			Actions: []string{
				"Reduce memory-intensive operations",
				"Clear caches",
				"Restart memory-intensive services",
			},
			Parameters: map[string]interface{}{
				"current_usage": metrics.Memory.UsedPercent,
				"threshold":     thresholds.MemoryUsageHigh,
				"available_mb":  metrics.Memory.Available / 1024 / 1024,
			},
			CreatedAt: time.Now(),
		}
		recommendations = append(recommendations, rec)
	}

	// GPU analysis
	for _, gpu := range metrics.GPU {
		if gpu.Temperature > thresholds.GPUTempHigh {
			rec := TuningRecommendation{
				ID:          fmt.Sprintf("gpu-temp-%d-%d", gpu.Index, time.Now().Unix()),
				Type:        "thermal",
				Severity:    "critical",
				Component:   "gpu",
				Description: fmt.Sprintf("GPU %d temperature is high: %.2f°C", gpu.Index, gpu.Temperature),
				Actions: []string{
					"Reduce GPU power limit",
					"Lower GPU clock speed",
					"Increase fan speed",
				},
				Parameters: map[string]interface{}{
					"gpu_index":   gpu.Index,
					"temperature": gpu.Temperature,
					"threshold":   thresholds.GPUTempHigh,
				},
				CreatedAt: time.Now(),
			}
			recommendations = append(recommendations, rec)
		}
	}

	at.recommendations = recommendations
	return recommendations
}

// ShouldApply determines if a recommendation should be applied
func (at *AutoTuner) ShouldApply(rec TuningRecommendation) bool {
	at.mu.RLock()
	lastApplied, exists := at.applied[rec.ID]
	at.mu.RUnlock()

	// Don't reapply within 5 minutes
	if exists && time.Since(lastApplied) < 5*time.Minute {
		return false
	}

	// Apply based on severity
	return rec.Severity == "critical" || rec.Severity == "warning"
}

// Apply executes a tuning recommendation
func (at *AutoTuner) Apply(rec TuningRecommendation) {
	at.mu.Lock()
	at.applied[rec.ID] = time.Now()
	at.mu.Unlock()

	at.logger.Info("Applying tuning recommendation",
		zap.String("id", rec.ID),
		zap.String("type", rec.Type),
		zap.String("component", rec.Component),
		zap.String("description", rec.Description),
	)

	// Implementation would apply the actual tuning actions
	// This is a placeholder for the actual implementation
}

// GetRecommendations returns current recommendations
func (at *AutoTuner) GetRecommendations() []TuningRecommendation {
	at.mu.RLock()
	defer at.mu.RUnlock()
	return at.recommendations
}