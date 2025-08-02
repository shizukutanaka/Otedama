package hardware

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
	"go.uber.org/zap"
)

// Monitor provides hardware monitoring capabilities
type Monitor struct {
	logger      *zap.Logger
	config      Config
	gpuMonitor  GPUMonitor
	metrics     *Metrics
	mu          sync.RWMutex
	stopChan    chan struct{}
	alertChan   chan Alert
}

// Config defines hardware monitoring configuration
type Config struct {
	Enabled          bool          `yaml:"enabled"`
	UpdateInterval   time.Duration `yaml:"update_interval"`
	TempThreshold    float64       `yaml:"temp_threshold"`
	PowerThreshold   float64       `yaml:"power_threshold"`
	MemoryThreshold  float64       `yaml:"memory_threshold"`
	EnableGPU        bool          `yaml:"enable_gpu"`
	EnableAlerts     bool          `yaml:"enable_alerts"`
}

// Metrics holds current hardware metrics
type Metrics struct {
	CPU        CPUMetrics        `json:"cpu"`
	Memory     MemoryMetrics     `json:"memory"`
	Disk       DiskMetrics       `json:"disk"`
	Network    NetworkMetrics    `json:"network"`
	GPU        []GPUMetrics      `json:"gpu,omitempty"`
	System     SystemMetrics     `json:"system"`
	UpdatedAt  time.Time         `json:"updated_at"`
}

// CPUMetrics represents CPU metrics
type CPUMetrics struct {
	Usage       float64   `json:"usage_percent"`
	Temperature float64   `json:"temperature"`
	Cores       int       `json:"cores"`
	Threads     int       `json:"threads"`
	Frequency   float64   `json:"frequency_mhz"`
	LoadAvg     []float64 `json:"load_avg"`
}

// MemoryMetrics represents memory metrics
type MemoryMetrics struct {
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Free        uint64  `json:"free"`
	Usage       float64 `json:"usage_percent"`
	SwapTotal   uint64  `json:"swap_total"`
	SwapUsed    uint64  `json:"swap_used"`
	SwapUsage   float64 `json:"swap_usage_percent"`
}

// DiskMetrics represents disk metrics
type DiskMetrics struct {
	Total       uint64  `json:"total"`
	Used        uint64  `json:"used"`
	Free        uint64  `json:"free"`
	Usage       float64 `json:"usage_percent"`
	ReadBytes   uint64  `json:"read_bytes"`
	WriteBytes  uint64  `json:"write_bytes"`
	ReadRate    float64 `json:"read_rate_mbps"`
	WriteRate   float64 `json:"write_rate_mbps"`
}

// NetworkMetrics represents network metrics
type NetworkMetrics struct {
	BytesSent     uint64  `json:"bytes_sent"`
	BytesRecv     uint64  `json:"bytes_recv"`
	PacketsSent   uint64  `json:"packets_sent"`
	PacketsRecv   uint64  `json:"packets_recv"`
	SendRate      float64 `json:"send_rate_mbps"`
	RecvRate      float64 `json:"recv_rate_mbps"`
	Connections   int     `json:"active_connections"`
}

// GPUMetrics represents GPU metrics
type GPUMetrics struct {
	Index         int     `json:"index"`
	Name          string  `json:"name"`
	Temperature   float64 `json:"temperature"`
	Power         float64 `json:"power_watts"`
	FanSpeed      int     `json:"fan_speed_percent"`
	MemoryTotal   uint64  `json:"memory_total"`
	MemoryUsed    uint64  `json:"memory_used"`
	MemoryFree    uint64  `json:"memory_free"`
	Usage         float64 `json:"usage_percent"`
	MemoryUsage   float64 `json:"memory_usage_percent"`
	ClockCore     int     `json:"clock_core_mhz"`
	ClockMemory   int     `json:"clock_memory_mhz"`
}

// SystemMetrics represents system-wide metrics
type SystemMetrics struct {
	Hostname    string    `json:"hostname"`
	OS          string    `json:"os"`
	Platform    string    `json:"platform"`
	Kernel      string    `json:"kernel_version"`
	Uptime      uint64    `json:"uptime_seconds"`
	BootTime    time.Time `json:"boot_time"`
	ProcessCount int      `json:"process_count"`
}

// Alert represents a hardware alert
type Alert struct {
	Type        string    `json:"type"`
	Severity    string    `json:"severity"`
	Component   string    `json:"component"`
	Message     string    `json:"message"`
	Value       float64   `json:"value"`
	Threshold   float64   `json:"threshold"`
	Timestamp   time.Time `json:"timestamp"`
}

// GPUMonitor interface for GPU monitoring
type GPUMonitor interface {
	GetGPUCount() int
	GetGPUMetrics(index int) (*GPUMetrics, error)
	GetAllGPUMetrics() ([]GPUMetrics, error)
}

// NewMonitor creates a new hardware monitor
func NewMonitor(logger *zap.Logger, config Config) *Monitor {
	m := &Monitor{
		logger:    logger,
		config:    config,
		metrics:   &Metrics{},
		stopChan:  make(chan struct{}),
		alertChan: make(chan Alert, 100),
	}

	// Initialize GPU monitor if enabled
	if config.EnableGPU {
		m.gpuMonitor = NewNvidiaGPUMonitor(logger)
	}

	return m
}

// Start begins hardware monitoring
func (m *Monitor) Start(ctx context.Context) error {
	if !m.config.Enabled {
		m.logger.Info("Hardware monitoring disabled")
		return nil
	}

	m.logger.Info("Starting hardware monitor",
		zap.Duration("update_interval", m.config.UpdateInterval),
		zap.Bool("gpu_enabled", m.config.EnableGPU),
	)

	// Initial update
	if err := m.update(); err != nil {
		m.logger.Error("Failed initial hardware update", zap.Error(err))
	}

	// Start monitoring loop
	go m.monitorLoop(ctx)

	// Start alert processor if enabled
	if m.config.EnableAlerts {
		go m.processAlerts(ctx)
	}

	return nil
}

// Stop halts hardware monitoring
func (m *Monitor) Stop() error {
	close(m.stopChan)
	return nil
}

// GetMetrics returns current hardware metrics
func (m *Monitor) GetMetrics() *Metrics {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	// Return a copy to avoid race conditions
	metricsCopy := *m.metrics
	return &metricsCopy
}

// GetAlertChannel returns the alert channel
func (m *Monitor) GetAlertChannel() <-chan Alert {
	return m.alertChan
}

// monitorLoop continuously updates hardware metrics
func (m *Monitor) monitorLoop(ctx context.Context) {
	ticker := time.NewTicker(m.config.UpdateInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-m.stopChan:
			return
		case <-ticker.C:
			if err := m.update(); err != nil {
				m.logger.Error("Failed to update hardware metrics", zap.Error(err))
			}
		}
	}
}

// update collects all hardware metrics
func (m *Monitor) update() error {
	metrics := &Metrics{
		UpdatedAt: time.Now(),
	}

	// Collect CPU metrics
	if err := m.updateCPUMetrics(&metrics.CPU); err != nil {
		m.logger.Warn("Failed to update CPU metrics", zap.Error(err))
	}

	// Collect memory metrics
	if err := m.updateMemoryMetrics(&metrics.Memory); err != nil {
		m.logger.Warn("Failed to update memory metrics", zap.Error(err))
	}

	// Collect disk metrics
	if err := m.updateDiskMetrics(&metrics.Disk); err != nil {
		m.logger.Warn("Failed to update disk metrics", zap.Error(err))
	}

	// Collect network metrics
	if err := m.updateNetworkMetrics(&metrics.Network); err != nil {
		m.logger.Warn("Failed to update network metrics", zap.Error(err))
	}

	// Collect GPU metrics if enabled
	if m.config.EnableGPU && m.gpuMonitor != nil {
		gpuMetrics, err := m.gpuMonitor.GetAllGPUMetrics()
		if err != nil {
			m.logger.Warn("Failed to update GPU metrics", zap.Error(err))
		} else {
			metrics.GPU = gpuMetrics
		}
	}

	// Collect system metrics
	if err := m.updateSystemMetrics(&metrics.System); err != nil {
		m.logger.Warn("Failed to update system metrics", zap.Error(err))
	}

	// Update stored metrics
	m.mu.Lock()
	m.metrics = metrics
	m.mu.Unlock()

	// Check thresholds and generate alerts
	if m.config.EnableAlerts {
		m.checkThresholds(metrics)
	}

	return nil
}

// updateCPUMetrics updates CPU metrics
func (m *Monitor) updateCPUMetrics(metrics *CPUMetrics) error {
	// Get CPU usage
	percentages, err := cpu.Percent(time.Second, false)
	if err != nil {
		return err
	}
	if len(percentages) > 0 {
		metrics.Usage = percentages[0]
	}

	// Get CPU info
	info, err := cpu.Info()
	if err == nil && len(info) > 0 {
		metrics.Cores = int(info[0].Cores)
		metrics.Frequency = info[0].Mhz
	}

	// Get logical CPU count (threads)
	metrics.Threads = runtime.NumCPU()

	// Temperature would require platform-specific code
	// For now, set to 0 (not available)
	metrics.Temperature = 0

	return nil
}

// updateMemoryMetrics updates memory metrics
func (m *Monitor) updateMemoryMetrics(metrics *MemoryMetrics) error {
	// Virtual memory
	vmem, err := mem.VirtualMemory()
	if err != nil {
		return err
	}

	metrics.Total = vmem.Total
	metrics.Used = vmem.Used
	metrics.Free = vmem.Free
	metrics.Usage = vmem.UsedPercent

	// Swap memory
	swap, err := mem.SwapMemory()
	if err == nil {
		metrics.SwapTotal = swap.Total
		metrics.SwapUsed = swap.Used
		metrics.SwapUsage = swap.UsedPercent
	}

	return nil
}

// updateDiskMetrics updates disk metrics
func (m *Monitor) updateDiskMetrics(metrics *DiskMetrics) error {
	// Get disk usage for root partition
	usage, err := disk.Usage("/")
	if err != nil {
		return err
	}

	metrics.Total = usage.Total
	metrics.Used = usage.Used
	metrics.Free = usage.Free
	metrics.Usage = usage.UsedPercent

	// IO stats would require tracking over time
	// For now, set to 0
	metrics.ReadRate = 0
	metrics.WriteRate = 0

	return nil
}

// updateNetworkMetrics updates network metrics
func (m *Monitor) updateNetworkMetrics(metrics *NetworkMetrics) error {
	// Get network IO counters
	counters, err := net.IOCounters(false)
	if err != nil {
		return err
	}

	if len(counters) > 0 {
		metrics.BytesSent = counters[0].BytesSent
		metrics.BytesRecv = counters[0].BytesRecv
		metrics.PacketsSent = counters[0].PacketsSent
		metrics.PacketsRecv = counters[0].PacketsRecv
	}

	// Rates would require tracking over time
	// For now, set to 0
	metrics.SendRate = 0
	metrics.RecvRate = 0

	return nil
}

// updateSystemMetrics updates system metrics
func (m *Monitor) updateSystemMetrics(metrics *SystemMetrics) error {
	// Get host info
	info, err := host.Info()
	if err != nil {
		return err
	}

	metrics.Hostname = info.Hostname
	metrics.OS = info.OS
	metrics.Platform = info.Platform
	metrics.Kernel = info.KernelVersion
	metrics.Uptime = info.Uptime
	metrics.BootTime = time.Unix(int64(info.BootTime), 0)

	return nil
}

// checkThresholds checks metrics against configured thresholds
func (m *Monitor) checkThresholds(metrics *Metrics) {
	// Check CPU temperature
	if metrics.CPU.Temperature > m.config.TempThreshold && metrics.CPU.Temperature > 0 {
		m.sendAlert(Alert{
			Type:      "temperature",
			Severity:  "warning",
			Component: "CPU",
			Message:   fmt.Sprintf("CPU temperature exceeds threshold: %.1f°C", metrics.CPU.Temperature),
			Value:     metrics.CPU.Temperature,
			Threshold: m.config.TempThreshold,
			Timestamp: time.Now(),
		})
	}

	// Check memory usage
	if metrics.Memory.Usage > m.config.MemoryThreshold {
		m.sendAlert(Alert{
			Type:      "memory",
			Severity:  "warning",
			Component: "Memory",
			Message:   fmt.Sprintf("Memory usage exceeds threshold: %.1f%%", metrics.Memory.Usage),
			Value:     metrics.Memory.Usage,
			Threshold: m.config.MemoryThreshold,
			Timestamp: time.Now(),
		})
	}

	// Check GPU metrics
	for _, gpu := range metrics.GPU {
		if gpu.Temperature > m.config.TempThreshold {
			m.sendAlert(Alert{
				Type:      "temperature",
				Severity:  "warning",
				Component: fmt.Sprintf("GPU%d", gpu.Index),
				Message:   fmt.Sprintf("GPU%d temperature exceeds threshold: %.1f°C", gpu.Index, gpu.Temperature),
				Value:     gpu.Temperature,
				Threshold: m.config.TempThreshold,
				Timestamp: time.Now(),
			})
		}

		if gpu.Power > m.config.PowerThreshold {
			m.sendAlert(Alert{
				Type:      "power",
				Severity:  "warning",
				Component: fmt.Sprintf("GPU%d", gpu.Index),
				Message:   fmt.Sprintf("GPU%d power exceeds threshold: %.1fW", gpu.Index, gpu.Power),
				Value:     gpu.Power,
				Threshold: m.config.PowerThreshold,
				Timestamp: time.Now(),
			})
		}
	}
}

// sendAlert sends an alert to the alert channel
func (m *Monitor) sendAlert(alert Alert) {
	select {
	case m.alertChan <- alert:
	default:
		// Channel full, drop alert
		m.logger.Warn("Alert channel full, dropping alert",
			zap.String("type", alert.Type),
			zap.String("component", alert.Component),
		)
	}
}

// processAlerts processes alerts
func (m *Monitor) processAlerts(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.stopChan:
			return
		case alert := <-m.alertChan:
			m.logger.Warn("Hardware alert",
				zap.String("type", alert.Type),
				zap.String("severity", alert.Severity),
				zap.String("component", alert.Component),
				zap.String("message", alert.Message),
				zap.Float64("value", alert.Value),
				zap.Float64("threshold", alert.Threshold),
			)
		}
	}
}