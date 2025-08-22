package metrics

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// MetricsAggregator aggregates metrics across the system
type MetricsAggregator struct {
	// Metrics storage
	counters   map[string]*Counter
	gauges     map[string]*Gauge
	histograms map[string]*Histogram
	meters     map[string]*Meter
	timers     map[string]*Timer
	
	metricsMu  sync.RWMutex
	
	// Configuration
	config     *AggregatorConfig
	
	// Aggregation
	windows    map[string]*TimeWindow
	
	// Export
	exporters  []MetricsExporter
	
	// Statistics
	totalMetrics atomic.Uint64
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// Counter tracks incrementing values
type Counter struct {
	name  string
	value atomic.Uint64
	tags  map[string]string
}

// Gauge tracks current values
type Gauge struct {
	name  string
	value atomic.Value // float64
	tags  map[string]string
}

// Histogram tracks value distributions
type Histogram struct {
	name    string
	values  []float64
	mu      sync.Mutex
	tags    map[string]string
	
	// Pre-computed percentiles
	p50     float64
	p90     float64
	p95     float64
	p99     float64
	min     float64
	max     float64
	mean    float64
	stddev  float64
}

// Meter tracks rates
type Meter struct {
	name      string
	count     atomic.Uint64
	startTime time.Time
	
	// Moving averages
	m1Rate    float64 // 1-minute
	m5Rate    float64 // 5-minute
	m15Rate   float64 // 15-minute
	
	lastTick  time.Time
	mu        sync.Mutex
	tags      map[string]string
}

// Timer tracks durations
type Timer struct {
	histogram *Histogram
	meter     *Meter
	name      string
	tags      map[string]string
}

// TimeWindow represents a time-based aggregation window
type TimeWindow struct {
	start     time.Time
	end       time.Time
	duration  time.Duration
	metrics   map[string]interface{}
	mu        sync.RWMutex
}

// AggregatorConfig holds aggregator configuration
type AggregatorConfig struct {
	WindowSize      time.Duration
	RetentionPeriod time.Duration
	ExportInterval  time.Duration
	MaxMetrics      int
}

// MetricsExporter exports metrics to external systems
type MetricsExporter interface {
	Export(metrics map[string]interface{}) error
	Name() string
}

// DefaultAggregatorConfig returns default configuration
func DefaultAggregatorConfig() *AggregatorConfig {
	return &AggregatorConfig{
		WindowSize:      1 * time.Minute,
		RetentionPeriod: 24 * time.Hour,
		ExportInterval:  10 * time.Second,
		MaxMetrics:      10000,
	}
}

// NewMetricsAggregator creates a new metrics aggregator
func NewMetricsAggregator(ctx context.Context, config *AggregatorConfig) *MetricsAggregator {
	if config == nil {
		config = DefaultAggregatorConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	ma := &MetricsAggregator{
		counters:   make(map[string]*Counter),
		gauges:     make(map[string]*Gauge),
		histograms: make(map[string]*Histogram),
		meters:     make(map[string]*Meter),
		timers:     make(map[string]*Timer),
		windows:    make(map[string]*TimeWindow),
		config:     config,
		exporters:  make([]MetricsExporter, 0),
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Start workers
	ma.wg.Add(1)
	go ma.aggregationWorker()
	
	ma.wg.Add(1)
	go ma.exportWorker()
	
	return ma
}

// IncrementCounter increments a counter
func (ma *MetricsAggregator) IncrementCounter(name string, delta uint64, tags map[string]string) {
	ma.metricsMu.Lock()
	counter, exists := ma.counters[name]
	if !exists {
		if len(ma.counters) >= ma.config.MaxMetrics {
			ma.metricsMu.Unlock()
			return
		}
		counter = &Counter{
			name: name,
			tags: tags,
		}
		ma.counters[name] = counter
		ma.totalMetrics.Add(1)
	}
	ma.metricsMu.Unlock()
	
	counter.value.Add(delta)
}

// SetGauge sets a gauge value
func (ma *MetricsAggregator) SetGauge(name string, value float64, tags map[string]string) {
	ma.metricsMu.Lock()
	gauge, exists := ma.gauges[name]
	if !exists {
		if len(ma.gauges) >= ma.config.MaxMetrics {
			ma.metricsMu.Unlock()
			return
		}
		gauge = &Gauge{
			name: name,
			tags: tags,
		}
		ma.gauges[name] = gauge
		ma.totalMetrics.Add(1)
	}
	ma.metricsMu.Unlock()
	
	gauge.value.Store(value)
}

// RecordHistogram records a histogram value
func (ma *MetricsAggregator) RecordHistogram(name string, value float64, tags map[string]string) {
	ma.metricsMu.Lock()
	histogram, exists := ma.histograms[name]
	if !exists {
		if len(ma.histograms) >= ma.config.MaxMetrics {
			ma.metricsMu.Unlock()
			return
		}
		histogram = &Histogram{
			name:   name,
			values: make([]float64, 0, 1000),
			tags:   tags,
		}
		ma.histograms[name] = histogram
		ma.totalMetrics.Add(1)
	}
	ma.metricsMu.Unlock()
	
	histogram.mu.Lock()
	histogram.values = append(histogram.values, value)
	
	// Keep last 10000 values
	if len(histogram.values) > 10000 {
		histogram.values = histogram.values[len(histogram.values)-10000:]
	}
	histogram.mu.Unlock()
}

// UpdateMeter updates a meter
func (ma *MetricsAggregator) UpdateMeter(name string, count uint64, tags map[string]string) {
	ma.metricsMu.Lock()
	meter, exists := ma.meters[name]
	if !exists {
		if len(ma.meters) >= ma.config.MaxMetrics {
			ma.metricsMu.Unlock()
			return
		}
		meter = &Meter{
			name:      name,
			startTime: time.Now(),
			lastTick:  time.Now(),
			tags:      tags,
		}
		ma.meters[name] = meter
		ma.totalMetrics.Add(1)
	}
	ma.metricsMu.Unlock()
	
	meter.count.Add(count)
	meter.tick()
}

// RecordTimer records a timer duration
func (ma *MetricsAggregator) RecordTimer(name string, duration time.Duration, tags map[string]string) {
	ma.metricsMu.Lock()
	timer, exists := ma.timers[name]
	if !exists {
		if len(ma.timers) >= ma.config.MaxMetrics {
			ma.metricsMu.Unlock()
			return
		}
		timer = &Timer{
			name: name,
			histogram: &Histogram{
				name:   name + ".histogram",
				values: make([]float64, 0, 1000),
				tags:   tags,
			},
			meter: &Meter{
				name:      name + ".meter",
				startTime: time.Now(),
				lastTick:  time.Now(),
				tags:      tags,
			},
			tags: tags,
		}
		ma.timers[name] = timer
		ma.totalMetrics.Add(1)
	}
	ma.metricsMu.Unlock()
	
	// Record in histogram
	timer.histogram.mu.Lock()
	timer.histogram.values = append(timer.histogram.values, duration.Seconds())
	timer.histogram.mu.Unlock()
	
	// Update meter
	timer.meter.count.Add(1)
	timer.meter.tick()
}

// AddExporter adds a metrics exporter
func (ma *MetricsAggregator) AddExporter(exporter MetricsExporter) {
	ma.exporters = append(ma.exporters, exporter)
}

// aggregationWorker performs periodic aggregation
func (ma *MetricsAggregator) aggregationWorker() {
	defer ma.wg.Done()
	
	ticker := time.NewTicker(ma.config.WindowSize)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ma.aggregate()
			
		case <-ma.ctx.Done():
			return
		}
	}
}

// aggregate performs metrics aggregation
func (ma *MetricsAggregator) aggregate() {
	now := time.Now()
	windowKey := fmt.Sprintf("window_%d", now.Unix()/int64(ma.config.WindowSize.Seconds()))
	
	window := &TimeWindow{
		start:    now.Add(-ma.config.WindowSize),
		end:      now,
		duration: ma.config.WindowSize,
		metrics:  make(map[string]interface{}),
	}
	
	ma.metricsMu.RLock()
	
	// Aggregate counters
	for name, counter := range ma.counters {
		window.metrics[name] = counter.value.Load()
	}
	
	// Aggregate gauges
	for name, gauge := range ma.gauges {
		if val := gauge.value.Load(); val != nil {
			window.metrics[name] = val.(float64)
		}
	}
	
	// Aggregate histograms
	for name, histogram := range ma.histograms {
		histogram.compute()
		window.metrics[name+".p50"] = histogram.p50
		window.metrics[name+".p90"] = histogram.p90
		window.metrics[name+".p95"] = histogram.p95
		window.metrics[name+".p99"] = histogram.p99
		window.metrics[name+".min"] = histogram.min
		window.metrics[name+".max"] = histogram.max
		window.metrics[name+".mean"] = histogram.mean
		window.metrics[name+".stddev"] = histogram.stddev
	}
	
	// Aggregate meters
	for name, meter := range ma.meters {
		window.metrics[name+".count"] = meter.count.Load()
		window.metrics[name+".m1_rate"] = meter.m1Rate
		window.metrics[name+".m5_rate"] = meter.m5Rate
		window.metrics[name+".m15_rate"] = meter.m15Rate
		window.metrics[name+".mean_rate"] = meter.meanRate()
	}
	
	// Aggregate timers
	for name, timer := range ma.timers {
		timer.histogram.compute()
		window.metrics[name+".p50"] = timer.histogram.p50
		window.metrics[name+".p95"] = timer.histogram.p95
		window.metrics[name+".p99"] = timer.histogram.p99
		window.metrics[name+".count"] = timer.meter.count.Load()
		window.metrics[name+".rate"] = timer.meter.meanRate()
	}
	
	ma.metricsMu.RUnlock()
	
	// Store window
	ma.windows[windowKey] = window
	
	// Clean old windows
	ma.cleanOldWindows()
}

// cleanOldWindows removes old aggregation windows
func (ma *MetricsAggregator) cleanOldWindows() {
	cutoff := time.Now().Add(-ma.config.RetentionPeriod)
	
	for key, window := range ma.windows {
		if window.end.Before(cutoff) {
			delete(ma.windows, key)
		}
	}
}

// exportWorker exports metrics periodically
func (ma *MetricsAggregator) exportWorker() {
	defer ma.wg.Done()
	
	ticker := time.NewTicker(ma.config.ExportInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ma.export()
			
		case <-ma.ctx.Done():
			return
		}
	}
}

// export exports current metrics
func (ma *MetricsAggregator) export() {
	metrics := ma.GetCurrentMetrics()
	
	for _, exporter := range ma.exporters {
		if err := exporter.Export(metrics); err != nil {
			fmt.Printf("Failed to export to %s: %v\n", exporter.Name(), err)
		}
	}
}

// GetCurrentMetrics returns current metrics snapshot
func (ma *MetricsAggregator) GetCurrentMetrics() map[string]interface{} {
	metrics := make(map[string]interface{})
	
	ma.metricsMu.RLock()
	defer ma.metricsMu.RUnlock()
	
	// Get counter values
	for name, counter := range ma.counters {
		metrics[name] = counter.value.Load()
	}
	
	// Get gauge values
	for name, gauge := range ma.gauges {
		if val := gauge.value.Load(); val != nil {
			metrics[name] = val.(float64)
		}
	}
	
	// Get histogram stats
	for name, histogram := range ma.histograms {
		histogram.compute()
		metrics[name+".p50"] = histogram.p50
		metrics[name+".p95"] = histogram.p95
		metrics[name+".p99"] = histogram.p99
		metrics[name+".mean"] = histogram.mean
	}
	
	// Get meter rates
	for name, meter := range ma.meters {
		metrics[name+".rate"] = meter.meanRate()
		metrics[name+".m1_rate"] = meter.m1Rate
	}
	
	// Get timer stats
	for name, timer := range ma.timers {
		timer.histogram.compute()
		metrics[name+".p95"] = timer.histogram.p95
		metrics[name+".rate"] = timer.meter.meanRate()
	}
	
	return metrics
}

// GetStatistics returns aggregator statistics
func (ma *MetricsAggregator) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	ma.metricsMu.RLock()
	stats["total_counters"] = len(ma.counters)
	stats["total_gauges"] = len(ma.gauges)
	stats["total_histograms"] = len(ma.histograms)
	stats["total_meters"] = len(ma.meters)
	stats["total_timers"] = len(ma.timers)
	stats["total_windows"] = len(ma.windows)
	ma.metricsMu.RUnlock()
	
	stats["total_metrics"] = ma.totalMetrics.Load()
	
	return stats
}

// Stop stops the aggregator
func (ma *MetricsAggregator) Stop() {
	ma.cancel()
	ma.wg.Wait()
}

// compute computes histogram statistics
func (h *Histogram) compute() {
	h.mu.Lock()
	defer h.mu.Unlock()
	
	if len(h.values) == 0 {
		return
	}
	
	// Sort values
	sorted := make([]float64, len(h.values))
	copy(sorted, h.values)
	sort.Float64s(sorted)
	
	// Calculate percentiles
	h.p50 = percentile(sorted, 0.50)
	h.p90 = percentile(sorted, 0.90)
	h.p95 = percentile(sorted, 0.95)
	h.p99 = percentile(sorted, 0.99)
	
	// Calculate min/max
	h.min = sorted[0]
	h.max = sorted[len(sorted)-1]
	
	// Calculate mean
	sum := 0.0
	for _, v := range sorted {
		sum += v
	}
	h.mean = sum / float64(len(sorted))
	
	// Calculate standard deviation
	sumSquares := 0.0
	for _, v := range sorted {
		diff := v - h.mean
		sumSquares += diff * diff
	}
	h.stddev = math.Sqrt(sumSquares / float64(len(sorted)))
}

// percentile calculates percentile value
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	
	index := p * float64(len(sorted)-1)
	lower := int(math.Floor(index))
	upper := int(math.Ceil(index))
	
	if lower == upper {
		return sorted[lower]
	}
	
	weight := index - float64(lower)
	return sorted[lower]*(1-weight) + sorted[upper]*weight
}

// tick updates meter rates
func (m *Meter) tick() {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	now := time.Now()
	elapsed := now.Sub(m.lastTick).Seconds()
	
	if elapsed <= 0 {
		return
	}
	
	count := float64(m.count.Load())
	instantRate := count / elapsed
	
	// Exponential weighted moving average
	alpha1 := 1 - math.Exp(-elapsed/60.0)   // 1-minute
	alpha5 := 1 - math.Exp(-elapsed/300.0)  // 5-minute
	alpha15 := 1 - math.Exp(-elapsed/900.0) // 15-minute
	
	m.m1Rate = m.m1Rate*(1-alpha1) + instantRate*alpha1
	m.m5Rate = m.m5Rate*(1-alpha5) + instantRate*alpha5
	m.m15Rate = m.m15Rate*(1-alpha15) + instantRate*alpha15
	
	m.lastTick = now
}

// meanRate calculates mean rate since start
func (m *Meter) meanRate() float64 {
	elapsed := time.Since(m.startTime).Seconds()
	if elapsed <= 0 {
		return 0
	}
	return float64(m.count.Load()) / elapsed
}

// PrometheusExporter exports metrics in Prometheus format
type PrometheusExporter struct {
	endpoint string
}

// NewPrometheusExporter creates Prometheus exporter
func NewPrometheusExporter(endpoint string) *PrometheusExporter {
	return &PrometheusExporter{endpoint: endpoint}
}

// Export exports metrics to Prometheus
func (pe *PrometheusExporter) Export(metrics map[string]interface{}) error {
	// Format metrics for Prometheus
	// This would normally send to pushgateway or expose via HTTP
	for name, value := range metrics {
		fmt.Printf("# TYPE %s gauge\n%s %v\n", name, name, value)
	}
	return nil
}

// Name returns exporter name
func (pe *PrometheusExporter) Name() string {
	return "prometheus"
}

// MiningMetrics provides mining-specific metrics
type MiningMetrics struct {
	aggregator *MetricsAggregator
}

// NewMiningMetrics creates mining metrics
func NewMiningMetrics(aggregator *MetricsAggregator) *MiningMetrics {
	return &MiningMetrics{aggregator: aggregator}
}

// RecordHashrate records hashrate
func (mm *MiningMetrics) RecordHashrate(algorithm string, hashrate float64) {
	mm.aggregator.SetGauge(
		fmt.Sprintf("mining.hashrate.%s", algorithm),
		hashrate,
		map[string]string{"algorithm": algorithm},
	)
}

// RecordShare records share submission
func (mm *MiningMetrics) RecordShare(algorithm string, valid bool, difficulty float64) {
	status := "valid"
	if !valid {
		status = "invalid"
	}
	
	mm.aggregator.IncrementCounter(
		fmt.Sprintf("mining.shares.%s", status),
		1,
		map[string]string{"algorithm": algorithm},
	)
	
	mm.aggregator.RecordHistogram(
		"mining.share_difficulty",
		difficulty,
		map[string]string{"algorithm": algorithm},
	)
}

// RecordBlock records block found
func (mm *MiningMetrics) RecordBlock(algorithm string, reward float64) {
	mm.aggregator.IncrementCounter(
		"mining.blocks_found",
		1,
		map[string]string{"algorithm": algorithm},
	)
	
	mm.aggregator.RecordHistogram(
		"mining.block_reward",
		reward,
		map[string]string{"algorithm": algorithm},
	)
}

// RecordTemperature records device temperature
func (mm *MiningMetrics) RecordTemperature(device string, temperature float64) {
	mm.aggregator.SetGauge(
		fmt.Sprintf("hardware.temperature.%s", device),
		temperature,
		map[string]string{"device": device},
	)
}

// RecordPower records power consumption
func (mm *MiningMetrics) RecordPower(device string, watts float64) {
	mm.aggregator.SetGauge(
		fmt.Sprintf("hardware.power.%s", device),
		watts,
		map[string]string{"device": device},
	)
}

// P2PMetrics provides P2P-specific metrics
type P2PMetrics struct {
	aggregator *MetricsAggregator
}

// NewP2PMetrics creates P2P metrics
func NewP2PMetrics(aggregator *MetricsAggregator) *P2PMetrics {
	return &P2PMetrics{aggregator: aggregator}
}

// RecordPeerCount records peer count
func (pm *P2PMetrics) RecordPeerCount(count int) {
	pm.aggregator.SetGauge("p2p.peer_count", float64(count), nil)
}

// RecordMessage records P2P message
func (pm *P2PMetrics) RecordMessage(msgType string, size int, latency time.Duration) {
	pm.aggregator.IncrementCounter(
		fmt.Sprintf("p2p.messages.%s", msgType),
		1,
		map[string]string{"type": msgType},
	)
	
	pm.aggregator.RecordHistogram(
		"p2p.message_size",
		float64(size),
		map[string]string{"type": msgType},
	)
	
	pm.aggregator.RecordTimer(
		"p2p.message_latency",
		latency,
		map[string]string{"type": msgType},
	)
}