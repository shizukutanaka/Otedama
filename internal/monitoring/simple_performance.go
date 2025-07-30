package monitoring

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// SimplePerformanceMonitor provides lightweight performance monitoring
// Following John Carmack's principle: "Measure twice, optimize once"
type SimplePerformanceMonitor struct {
	logger  *zap.Logger
	metrics map[string]*Metric
	mu      sync.RWMutex
	
	// Monitoring state
	running atomic.Bool
	ctx     context.Context
	cancel  context.CancelFunc
}

// Metric represents a performance metric
type Metric struct {
	name        string
	value       atomic.Int64
	rate        atomic.Uint64 // per second
	lastUpdate  atomic.Int64
	
	// Rolling window for rate calculation
	samples     []int64
	sampleIndex int
	sampleMutex sync.Mutex
}

// NewSimplePerformanceMonitor creates a new performance monitor
func NewSimplePerformanceMonitor(logger *zap.Logger) *SimplePerformanceMonitor {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &SimplePerformanceMonitor{
		logger:  logger,
		metrics: make(map[string]*Metric),
		ctx:     ctx,
		cancel:  cancel,
	}
}

// Start starts the performance monitor
func (pm *SimplePerformanceMonitor) Start() error {
	if !pm.running.CompareAndSwap(false, true) {
		return nil
	}
	
	// Start the rate calculator
	go pm.calculateRates()
	
	pm.logger.Info("Performance monitor started")
	return nil
}

// Stop stops the performance monitor
func (pm *SimplePerformanceMonitor) Stop() {
	if pm.running.CompareAndSwap(true, false) {
		pm.cancel()
		pm.logger.Info("Performance monitor stopped")
	}
}

// RegisterMetric registers a new metric
func (pm *SimplePerformanceMonitor) RegisterMetric(name string) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	if _, exists := pm.metrics[name]; !exists {
		pm.metrics[name] = &Metric{
			name:    name,
			samples: make([]int64, 60), // 60 second window
		}
	}
}

// RecordValue records a value for a metric
func (pm *SimplePerformanceMonitor) RecordValue(name string, value int64) {
	pm.mu.RLock()
	metric, exists := pm.metrics[name]
	pm.mu.RUnlock()
	
	if !exists {
		pm.RegisterMetric(name)
		pm.mu.RLock()
		metric = pm.metrics[name]
		pm.mu.RUnlock()
	}
	
	metric.value.Store(value)
	metric.lastUpdate.Store(time.Now().UnixNano())
}

// IncrementCounter increments a counter metric
func (pm *SimplePerformanceMonitor) IncrementCounter(name string, delta int64) {
	pm.mu.RLock()
	metric, exists := pm.metrics[name]
	pm.mu.RUnlock()
	
	if !exists {
		pm.RegisterMetric(name)
		pm.mu.RLock()
		metric = pm.metrics[name]
		pm.mu.RUnlock()
	}
	
	metric.value.Add(delta)
	metric.lastUpdate.Store(time.Now().UnixNano())
}

// GetMetric returns the current value of a metric
func (pm *SimplePerformanceMonitor) GetMetric(name string) (value int64, rate uint64, exists bool) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	metric, exists := pm.metrics[name]
	if !exists {
		return 0, 0, false
	}
	
	return metric.value.Load(), metric.rate.Load(), true
}

// GetAllMetrics returns all metrics
func (pm *SimplePerformanceMonitor) GetAllMetrics() map[string]MetricSnapshot {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	snapshots := make(map[string]MetricSnapshot)
	for name, metric := range pm.metrics {
		snapshots[name] = MetricSnapshot{
			Name:       name,
			Value:      metric.value.Load(),
			Rate:       metric.rate.Load(),
			LastUpdate: time.Unix(0, metric.lastUpdate.Load()),
		}
	}
	
	return snapshots
}

// MetricSnapshot represents a point-in-time snapshot of a metric
type MetricSnapshot struct {
	Name       string
	Value      int64
	Rate       uint64
	LastUpdate time.Time
}

// Private methods

func (pm *SimplePerformanceMonitor) calculateRates() {
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-pm.ctx.Done():
			return
		case <-ticker.C:
			pm.updateRates()
		}
	}
}

func (pm *SimplePerformanceMonitor) updateRates() {
	pm.mu.RLock()
	metrics := make([]*Metric, 0, len(pm.metrics))
	for _, m := range pm.metrics {
		metrics = append(metrics, m)
	}
	pm.mu.RUnlock()
	
	for _, metric := range metrics {
		metric.sampleMutex.Lock()
		
		// Store current value in rolling window
		currentValue := metric.value.Load()
		metric.samples[metric.sampleIndex] = currentValue
		metric.sampleIndex = (metric.sampleIndex + 1) % len(metric.samples)
		
		// Calculate rate (per second)
		oldestIndex := metric.sampleIndex
		oldestValue := metric.samples[oldestIndex]
		
		if oldestValue > 0 {
			// Rate = (current - oldest) / window_size
			rate := (currentValue - oldestValue) / int64(len(metric.samples))
			if rate < 0 {
				rate = 0
			}
			metric.rate.Store(uint64(rate))
		}
		
		metric.sampleMutex.Unlock()
	}
}

// MiningMetrics tracks mining-specific performance metrics
type MiningMetrics struct {
	monitor *SimplePerformanceMonitor
	logger  *zap.Logger
}

// NewMiningMetrics creates mining-specific metrics
func NewMiningMetrics(monitor *SimplePerformanceMonitor, logger *zap.Logger) *MiningMetrics {
	mm := &MiningMetrics{
		monitor: monitor,
		logger:  logger,
	}
	
	// Register mining metrics
	monitor.RegisterMetric("hashes_total")
	monitor.RegisterMetric("shares_submitted")
	monitor.RegisterMetric("shares_accepted")
	monitor.RegisterMetric("shares_rejected")
	monitor.RegisterMetric("blocks_found")
	monitor.RegisterMetric("difficulty_current")
	monitor.RegisterMetric("network_latency_ms")
	monitor.RegisterMetric("memory_usage_mb")
	monitor.RegisterMetric("cpu_usage_percent")
	
	return mm
}

// RecordHash records a hash calculation
func (mm *MiningMetrics) RecordHash(count int64) {
	mm.monitor.IncrementCounter("hashes_total", count)
}

// RecordShare records a share submission
func (mm *MiningMetrics) RecordShare(accepted bool) {
	mm.monitor.IncrementCounter("shares_submitted", 1)
	if accepted {
		mm.monitor.IncrementCounter("shares_accepted", 1)
	} else {
		mm.monitor.IncrementCounter("shares_rejected", 1)
	}
}

// RecordBlock records a block found
func (mm *MiningMetrics) RecordBlock() {
	mm.monitor.IncrementCounter("blocks_found", 1)
	mm.logger.Info("Block found!")
}

// UpdateDifficulty updates current difficulty
func (mm *MiningMetrics) UpdateDifficulty(difficulty int64) {
	mm.monitor.RecordValue("difficulty_current", difficulty)
}

// UpdateNetworkLatency updates network latency
func (mm *MiningMetrics) UpdateNetworkLatency(latencyMs int64) {
	mm.monitor.RecordValue("network_latency_ms", latencyMs)
}

// GetHashRate returns the current hash rate
func (mm *MiningMetrics) GetHashRate() uint64 {
	_, rate, _ := mm.monitor.GetMetric("hashes_total")
	return rate
}

// GetShareStats returns share statistics
func (mm *MiningMetrics) GetShareStats() (submitted, accepted, rejected int64) {
	submitted, _, _ = mm.monitor.GetMetric("shares_submitted")
	accepted, _, _ = mm.monitor.GetMetric("shares_accepted")
	rejected, _, _ = mm.monitor.GetMetric("shares_rejected")
	return
}

// ResourceMonitor monitors system resource usage
type ResourceMonitor struct {
	monitor *SimplePerformanceMonitor
	logger  *zap.Logger
}

// NewResourceMonitor creates a resource monitor
func NewResourceMonitor(monitor *SimplePerformanceMonitor, logger *zap.Logger) *ResourceMonitor {
	rm := &ResourceMonitor{
		monitor: monitor,
		logger:  logger,
	}
	
	// Register resource metrics
	monitor.RegisterMetric("memory_alloc_mb")
	monitor.RegisterMetric("memory_sys_mb")
	monitor.RegisterMetric("goroutines")
	monitor.RegisterMetric("gc_pause_ms")
	
	return rm
}

// UpdateMemoryStats updates memory usage statistics
func (rm *ResourceMonitor) UpdateMemoryStats(allocMB, sysMB int64) {
	rm.monitor.RecordValue("memory_alloc_mb", allocMB)
	rm.monitor.RecordValue("memory_sys_mb", sysMB)
}

// UpdateGoroutines updates goroutine count
func (rm *ResourceMonitor) UpdateGoroutines(count int64) {
	rm.monitor.RecordValue("goroutines", count)
}

// UpdateGCPause updates GC pause time
func (rm *ResourceMonitor) UpdateGCPause(pauseMs int64) {
	rm.monitor.RecordValue("gc_pause_ms", pauseMs)
}

// AlertThresholds defines thresholds for performance alerts
type AlertThresholds struct {
	MaxMemoryMB      int64
	MaxGoroutines    int64
	MinHashRate      uint64
	MaxRejectRate    float64
	MaxNetworkLatency int64
}

// PerformanceAlerter monitors metrics and triggers alerts
type PerformanceAlerter struct {
	monitor    *SimplePerformanceMonitor
	logger     *zap.Logger
	thresholds AlertThresholds
	
	lastAlert map[string]time.Time
	mu        sync.Mutex
}

// NewPerformanceAlerter creates a performance alerter
func NewPerformanceAlerter(monitor *SimplePerformanceMonitor, logger *zap.Logger) *PerformanceAlerter {
	return &PerformanceAlerter{
		monitor: monitor,
		logger:  logger,
		thresholds: AlertThresholds{
			MaxMemoryMB:       4096,  // 4GB
			MaxGoroutines:     10000,
			MinHashRate:       1000,  // 1KH/s
			MaxRejectRate:     0.05,  // 5%
			MaxNetworkLatency: 1000,  // 1 second
		},
		lastAlert: make(map[string]time.Time),
	}
}

// CheckAlerts checks for performance issues
func (pa *PerformanceAlerter) CheckAlerts() {
	metrics := pa.monitor.GetAllMetrics()
	
	// Check memory usage
	if memMB, exists := metrics["memory_alloc_mb"]; exists && memMB.Value > pa.thresholds.MaxMemoryMB {
		pa.alert("high_memory", "High memory usage: %d MB", memMB.Value)
	}
	
	// Check goroutines
	if goroutines, exists := metrics["goroutines"]; exists && goroutines.Value > pa.thresholds.MaxGoroutines {
		pa.alert("high_goroutines", "High goroutine count: %d", goroutines.Value)
	}
	
	// Check hash rate
	if hashes, exists := metrics["hashes_total"]; exists && hashes.Rate < pa.thresholds.MinHashRate {
		pa.alert("low_hashrate", "Low hash rate: %d H/s", hashes.Rate)
	}
	
	// Check reject rate
	if submitted, sExists := metrics["shares_submitted"]; sExists && submitted.Value > 0 {
		if rejected, rExists := metrics["shares_rejected"]; rExists {
			rejectRate := float64(rejected.Value) / float64(submitted.Value)
			if rejectRate > pa.thresholds.MaxRejectRate {
				pa.alert("high_reject_rate", "High reject rate: %.2f%%", rejectRate*100)
			}
		}
	}
	
	// Check network latency
	if latency, exists := metrics["network_latency_ms"]; exists && latency.Value > pa.thresholds.MaxNetworkLatency {
		pa.alert("high_latency", "High network latency: %d ms", latency.Value)
	}
}

func (pa *PerformanceAlerter) alert(alertType string, format string, args ...interface{}) {
	pa.mu.Lock()
	defer pa.mu.Unlock()
	
	// Rate limit alerts (one per type per minute)
	if lastAlert, exists := pa.lastAlert[alertType]; exists {
		if time.Since(lastAlert) < 1*time.Minute {
			return
		}
	}
	
	pa.logger.Warn(fmt.Sprintf(format, args...),
		zap.String("alert_type", alertType),
	)
	
	pa.lastAlert[alertType] = time.Now()
}