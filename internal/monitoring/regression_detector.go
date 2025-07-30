package monitoring

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// RegressionDetector detects performance regressions automatically
// Following Robert C. Martin's principle: "The only way to go fast is to go well"
type RegressionDetector struct {
	logger *zap.Logger
	config *RegressionConfig
	
	// Performance baselines
	baselines       map[string]*PerformanceBaseline
	baselinesMu     sync.RWMutex
	
	// Current metrics
	metricsCollector *MetricsCollector
	
	// Statistical analysis
	analyzer        *StatisticalAnalyzer
	
	// Regression detection
	detectors       map[MetricType]Detector
	
	// Alert manager
	alertManager    *AlertManager
	
	// Historical data
	history         *PerformanceHistory
	
	// Regression tracking
	regressions     []*DetectedRegression
	regressionsMu   sync.RWMutex
	
	// Metrics
	metrics         *RegressionMetrics
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// RegressionConfig contains regression detection configuration
type RegressionConfig struct {
	// Detection settings
	Sensitivity         float64 // 0.0 to 1.0
	ConfidenceLevel     float64 // Statistical confidence
	MinSampleSize       int
	DetectionWindow     time.Duration
	
	// Baseline settings
	BaselineWindow      time.Duration
	BaselineUpdateFreq  time.Duration
	AutoBaseline        bool
	
	// Metrics to track
	TrackedMetrics      []MetricType
	MetricThresholds    map[MetricType]float64
	
	// Statistical settings
	UseMAD              bool   // Median Absolute Deviation
	OutlierThreshold    float64
	TrendAnalysis       bool
	
	// Alert settings
	AlertOnRegression   bool
	AlertChannels       []string
	AlertCooldown       time.Duration
	
	// Reporting
	ReportingEnabled    bool
	ReportingInterval   time.Duration
	DashboardURL        string
}

// MetricType represents types of performance metrics
type MetricType string

const (
	MetricLatency       MetricType = "latency"
	MetricThroughput    MetricType = "throughput"
	MetricCPU           MetricType = "cpu"
	MetricMemory        MetricType = "memory"
	MetricGoroutines    MetricType = "goroutines"
	MetricGC            MetricType = "gc_pause"
	MetricHashRate      MetricType = "hash_rate"
	MetricShareLatency  MetricType = "share_latency"
)

// PerformanceBaseline represents baseline performance metrics
type PerformanceBaseline struct {
	MetricType      MetricType
	Mean            float64
	StdDev          float64
	Median          float64
	MAD             float64 // Median Absolute Deviation
	P50             float64
	P95             float64
	P99             float64
	Min             float64
	Max             float64
	SampleCount     int
	LastUpdated     time.Time
	Version         string
}

// DetectedRegression represents a detected performance regression
type DetectedRegression struct {
	ID              string
	MetricType      MetricType
	DetectedAt      time.Time
	Severity        RegressionSeverity
	BaselineValue   float64
	CurrentValue    float64
	Degradation     float64 // Percentage
	Confidence      float64
	StatisticalSig  float64 // p-value
	Description     string
	PossibleCauses  []string
	Recommendations []string
	Resolved        bool
	ResolvedAt      time.Time
}

// RegressionSeverity represents severity levels
type RegressionSeverity string

const (
	SeverityLow      RegressionSeverity = "low"
	SeverityMedium   RegressionSeverity = "medium"
	SeverityHigh     RegressionSeverity = "high"
	SeverityCritical RegressionSeverity = "critical"
)

// RegressionMetrics tracks detection metrics
type RegressionMetrics struct {
	TotalChecks         atomic.Uint64
	RegressionsDetected atomic.Uint64
	FalsePositives      atomic.Uint64
	TruePositives       atomic.Uint64
	AvgDetectionTime    atomic.Uint64 // Milliseconds
	ActiveRegressions   atomic.Int32
}

// NewRegressionDetector creates a new regression detector
func NewRegressionDetector(logger *zap.Logger, config *RegressionConfig) (*RegressionDetector, error) {
	if config == nil {
		config = DefaultRegressionConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	rd := &RegressionDetector{
		logger:           logger,
		config:           config,
		baselines:        make(map[string]*PerformanceBaseline),
		metricsCollector: NewMetricsCollector(logger),
		analyzer:         NewStatisticalAnalyzer(config),
		detectors:        make(map[MetricType]Detector),
		alertManager:     NewAlertManager(logger, config),
		history:          NewPerformanceHistory(),
		regressions:      make([]*DetectedRegression, 0),
		metrics:          &RegressionMetrics{},
		ctx:              ctx,
		cancel:           cancel,
	}
	
	// Initialize detectors for each metric type
	for _, metricType := range config.TrackedMetrics {
		rd.detectors[metricType] = rd.createDetector(metricType)
	}
	
	return rd, nil
}

// Start starts the regression detector
func (rd *RegressionDetector) Start() error {
	rd.logger.Info("Starting regression detector",
		zap.Float64("sensitivity", rd.config.Sensitivity),
		zap.Float64("confidence", rd.config.ConfidenceLevel),
		zap.Int("tracked_metrics", len(rd.config.TrackedMetrics)),
	)
	
	// Load or create baselines
	if err := rd.loadBaselines(); err != nil {
		return fmt.Errorf("failed to load baselines: %w", err)
	}
	
	// Start metrics collection
	if err := rd.metricsCollector.Start(); err != nil {
		return fmt.Errorf("failed to start metrics collector: %w", err)
	}
	
	// Start background workers
	rd.wg.Add(1)
	go rd.detectionLoop()
	
	rd.wg.Add(1)
	go rd.baselineUpdateLoop()
	
	if rd.config.ReportingEnabled {
		rd.wg.Add(1)
		go rd.reportingLoop()
	}
	
	return nil
}

// Stop stops the regression detector
func (rd *RegressionDetector) Stop() error {
	rd.logger.Info("Stopping regression detector")
	
	rd.cancel()
	rd.wg.Wait()
	
	// Stop metrics collector
	rd.metricsCollector.Stop()
	
	// Save baselines
	return rd.saveBaselines()
}

// CheckMetric checks a specific metric for regression
func (rd *RegressionDetector) CheckMetric(metricType MetricType, value float64) (*DetectedRegression, error) {
	rd.metrics.TotalChecks.Add(1)
	
	// Get baseline
	rd.baselinesMu.RLock()
	baseline, exists := rd.baselines[string(metricType)]
	rd.baselinesMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("no baseline for metric: %s", metricType)
	}
	
	// Get detector
	detector, exists := rd.detectors[metricType]
	if !exists {
		return nil, fmt.Errorf("no detector for metric: %s", metricType)
	}
	
	// Check for regression
	regression := detector.Detect(baseline, value)
	if regression != nil {
		rd.handleRegression(regression)
	}
	
	return regression, nil
}

// UpdateBaseline updates the baseline for a metric
func (rd *RegressionDetector) UpdateBaseline(metricType MetricType, samples []float64) error {
	if len(samples) < rd.config.MinSampleSize {
		return fmt.Errorf("insufficient samples: %d < %d", len(samples), rd.config.MinSampleSize)
	}
	
	baseline := rd.analyzer.CalculateBaseline(metricType, samples)
	
	rd.baselinesMu.Lock()
	rd.baselines[string(metricType)] = baseline
	rd.baselinesMu.Unlock()
	
	rd.logger.Info("Updated baseline",
		zap.String("metric", string(metricType)),
		zap.Float64("mean", baseline.Mean),
		zap.Float64("stddev", baseline.StdDev),
		zap.Int("samples", baseline.SampleCount),
	)
	
	return nil
}

// GetRegressions returns detected regressions
func (rd *RegressionDetector) GetRegressions(active bool) []*DetectedRegression {
	rd.regressionsMu.RLock()
	defer rd.regressionsMu.RUnlock()
	
	if !active {
		return rd.regressions
	}
	
	// Return only active regressions
	active_regressions := make([]*DetectedRegression, 0)
	for _, reg := range rd.regressions {
		if !reg.Resolved {
			active_regressions = append(active_regressions, reg)
		}
	}
	
	return active_regressions
}

// ResolveRegression marks a regression as resolved
func (rd *RegressionDetector) ResolveRegression(regressionID string) error {
	rd.regressionsMu.Lock()
	defer rd.regressionsMu.Unlock()
	
	for _, reg := range rd.regressions {
		if reg.ID == regressionID {
			reg.Resolved = true
			reg.ResolvedAt = time.Now()
			rd.metrics.ActiveRegressions.Add(-1)
			return nil
		}
	}
	
	return fmt.Errorf("regression not found: %s", regressionID)
}

// GetMetrics returns detection metrics
func (rd *RegressionDetector) GetMetrics() RegressionStats {
	totalChecks := rd.metrics.TotalChecks.Load()
	detected := rd.metrics.RegressionsDetected.Load()
	truePositives := rd.metrics.TruePositives.Load()
	falsePositives := rd.metrics.FalsePositives.Load()
	
	precision := float64(0)
	if detected > 0 {
		precision = float64(truePositives) / float64(detected)
	}
	
	detectionRate := float64(0)
	if totalChecks > 0 {
		detectionRate = float64(detected) / float64(totalChecks)
	}
	
	return RegressionStats{
		TotalChecks:         totalChecks,
		RegressionsDetected: detected,
		ActiveRegressions:   int(rd.metrics.ActiveRegressions.Load()),
		Precision:           precision,
		DetectionRate:       detectionRate,
		AvgDetectionTime:    time.Duration(rd.metrics.AvgDetectionTime.Load()) * time.Millisecond,
		Baselines:           rd.getBaselineStats(),
	}
}

// Private methods

func (rd *RegressionDetector) detectionLoop() {
	defer rd.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			rd.performDetection()
			
		case <-rd.ctx.Done():
			return
		}
	}
}

func (rd *RegressionDetector) baselineUpdateLoop() {
	defer rd.wg.Done()
	
	ticker := time.NewTicker(rd.config.BaselineUpdateFreq)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if rd.config.AutoBaseline {
				rd.updateBaselines()
			}
			
		case <-rd.ctx.Done():
			return
		}
	}
}

func (rd *RegressionDetector) reportingLoop() {
	defer rd.wg.Done()
	
	ticker := time.NewTicker(rd.config.ReportingInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			rd.generateReport()
			
		case <-rd.ctx.Done():
			return
		}
	}
}

func (rd *RegressionDetector) performDetection() {
	start := time.Now()
	
	// Collect current metrics
	currentMetrics := rd.metricsCollector.CollectAll()
	
	// Check each metric
	for metricType, value := range currentMetrics {
		if _, err := rd.CheckMetric(metricType, value); err != nil {
			rd.logger.Error("Failed to check metric",
				zap.String("metric", string(metricType)),
				zap.Error(err),
			)
		}
	}
	
	// Update detection time
	detectionTime := time.Since(start).Milliseconds()
	current := rd.metrics.AvgDetectionTime.Load()
	newAvg := (current*9 + uint64(detectionTime)) / 10
	rd.metrics.AvgDetectionTime.Store(newAvg)
}

func (rd *RegressionDetector) updateBaselines() {
	for metricType := range rd.detectors {
		// Get historical data
		samples := rd.history.GetSamples(metricType, rd.config.BaselineWindow)
		if len(samples) >= rd.config.MinSampleSize {
			if err := rd.UpdateBaseline(metricType, samples); err != nil {
				rd.logger.Error("Failed to update baseline",
					zap.String("metric", string(metricType)),
					zap.Error(err),
				)
			}
		}
	}
}

func (rd *RegressionDetector) handleRegression(regression *DetectedRegression) {
	rd.logger.Warn("Performance regression detected",
		zap.String("metric", string(regression.MetricType)),
		zap.String("severity", string(regression.Severity)),
		zap.Float64("degradation", regression.Degradation),
		zap.Float64("confidence", regression.Confidence),
	)
	
	// Store regression
	rd.regressionsMu.Lock()
	rd.regressions = append(rd.regressions, regression)
	if len(rd.regressions) > 1000 {
		rd.regressions = rd.regressions[500:]
	}
	rd.regressionsMu.Unlock()
	
	// Update metrics
	rd.metrics.RegressionsDetected.Add(1)
	rd.metrics.ActiveRegressions.Add(1)
	
	// Send alert if enabled
	if rd.config.AlertOnRegression {
		rd.alertManager.SendAlert(regression)
	}
	
	// Analyze possible causes
	regression.PossibleCauses = rd.analyzeCauses(regression)
	regression.Recommendations = rd.generateRecommendations(regression)
}

func (rd *RegressionDetector) createDetector(metricType MetricType) Detector {
	switch metricType {
	case MetricLatency, MetricShareLatency:
		return NewLatencyDetector(rd.config)
	case MetricThroughput, MetricHashRate:
		return NewThroughputDetector(rd.config)
	case MetricCPU, MetricMemory:
		return NewResourceDetector(rd.config)
	case MetricGC:
		return NewGCDetector(rd.config)
	default:
		return NewGenericDetector(rd.config)
	}
}

func (rd *RegressionDetector) analyzeCauses(regression *DetectedRegression) []string {
	causes := make([]string, 0)
	
	// Check for correlated metrics
	correlations := rd.analyzer.FindCorrelations(regression.MetricType, regression.DetectedAt)
	for _, corr := range correlations {
		if corr.Coefficient > 0.7 {
			causes = append(causes, fmt.Sprintf("%s correlation: %.2f", corr.Metric, corr.Coefficient))
		}
	}
	
	// Check recent changes
	recentChanges := rd.history.GetRecentChanges(regression.DetectedAt.Add(-1 * time.Hour))
	for _, change := range recentChanges {
		causes = append(causes, change.Description)
	}
	
	// Add generic causes based on metric type
	switch regression.MetricType {
	case MetricLatency:
		causes = append(causes, "Increased load", "Network congestion", "Database slowdown")
	case MetricCPU:
		causes = append(causes, "Inefficient algorithm", "Memory leak causing GC pressure")
	case MetricMemory:
		causes = append(causes, "Memory leak", "Increased data volume")
	}
	
	return causes
}

func (rd *RegressionDetector) generateRecommendations(regression *DetectedRegression) []string {
	recommendations := make([]string, 0)
	
	switch regression.Severity {
	case SeverityCritical:
		recommendations = append(recommendations, "Immediate rollback recommended")
		recommendations = append(recommendations, "Alert on-call team")
	case SeverityHigh:
		recommendations = append(recommendations, "Investigate root cause immediately")
		recommendations = append(recommendations, "Consider scaling resources")
	case SeverityMedium:
		recommendations = append(recommendations, "Monitor closely for further degradation")
		recommendations = append(recommendations, "Schedule investigation")
	case SeverityLow:
		recommendations = append(recommendations, "Add to backlog for optimization")
	}
	
	// Metric-specific recommendations
	switch regression.MetricType {
	case MetricLatency:
		recommendations = append(recommendations, "Profile slow code paths")
		recommendations = append(recommendations, "Check database query performance")
	case MetricCPU:
		recommendations = append(recommendations, "Run CPU profiler")
		recommendations = append(recommendations, "Check for infinite loops")
	case MetricMemory:
		recommendations = append(recommendations, "Run memory profiler")
		recommendations = append(recommendations, "Check for goroutine leaks")
	}
	
	return recommendations
}

func (rd *RegressionDetector) loadBaselines() error {
	// In production, would load from persistent storage
	// For now, create default baselines
	for _, metricType := range rd.config.TrackedMetrics {
		rd.baselines[string(metricType)] = rd.createDefaultBaseline(metricType)
	}
	return nil
}

func (rd *RegressionDetector) saveBaselines() error {
	// In production, would save to persistent storage
	return nil
}

func (rd *RegressionDetector) createDefaultBaseline(metricType MetricType) *PerformanceBaseline {
	// Default baselines based on metric type
	switch metricType {
	case MetricLatency:
		return &PerformanceBaseline{
			MetricType:  metricType,
			Mean:        50.0,  // 50ms
			StdDev:      10.0,
			Median:      45.0,
			P95:         80.0,
			P99:         100.0,
			SampleCount: 1000,
			LastUpdated: time.Now(),
		}
	case MetricThroughput:
		return &PerformanceBaseline{
			MetricType:  metricType,
			Mean:        1000.0, // 1000 req/s
			StdDev:      100.0,
			Median:      1000.0,
			P95:         1200.0,
			P99:         1300.0,
			SampleCount: 1000,
			LastUpdated: time.Now(),
		}
	case MetricHashRate:
		return &PerformanceBaseline{
			MetricType:  metricType,
			Mean:        1000000.0, // 1 MH/s
			StdDev:      50000.0,
			Median:      1000000.0,
			P95:         1100000.0,
			P99:         1150000.0,
			SampleCount: 1000,
			LastUpdated: time.Now(),
		}
	default:
		return &PerformanceBaseline{
			MetricType:  metricType,
			Mean:        100.0,
			StdDev:      10.0,
			Median:      100.0,
			P95:         120.0,
			P99:         130.0,
			SampleCount: 1000,
			LastUpdated: time.Now(),
		}
	}
}

func (rd *RegressionDetector) generateReport() {
	stats := rd.GetMetrics()
	active := rd.GetRegressions(true)
	
	rd.logger.Info("Performance regression report",
		zap.Uint64("total_checks", stats.TotalChecks),
		zap.Uint64("regressions_detected", stats.RegressionsDetected),
		zap.Int("active_regressions", stats.ActiveRegressions),
		zap.Float64("precision", stats.Precision),
	)
	
	// Generate detailed report for active regressions
	for _, reg := range active {
		rd.logger.Warn("Active regression",
			zap.String("id", reg.ID),
			zap.String("metric", string(reg.MetricType)),
			zap.String("severity", string(reg.Severity)),
			zap.Time("detected", reg.DetectedAt),
			zap.Float64("degradation", reg.Degradation),
		)
	}
}

func (rd *RegressionDetector) getBaselineStats() map[string]BaselineInfo {
	rd.baselinesMu.RLock()
	defer rd.baselinesMu.RUnlock()
	
	stats := make(map[string]BaselineInfo)
	for metric, baseline := range rd.baselines {
		stats[metric] = BaselineInfo{
			Mean:        baseline.Mean,
			StdDev:      baseline.StdDev,
			SampleCount: baseline.SampleCount,
			LastUpdated: baseline.LastUpdated,
		}
	}
	
	return stats
}

// Helper components

// MetricsCollector collects performance metrics
type MetricsCollector struct {
	logger    *zap.Logger
	collectors map[MetricType]func() float64
}

func NewMetricsCollector(logger *zap.Logger) *MetricsCollector {
	mc := &MetricsCollector{
		logger:     logger,
		collectors: make(map[MetricType]func() float64),
	}
	
	// Register collectors
	mc.collectors[MetricLatency] = mc.collectLatency
	mc.collectors[MetricThroughput] = mc.collectThroughput
	mc.collectors[MetricCPU] = mc.collectCPU
	mc.collectors[MetricMemory] = mc.collectMemory
	mc.collectors[MetricGoroutines] = mc.collectGoroutines
	mc.collectors[MetricGC] = mc.collectGC
	mc.collectors[MetricHashRate] = mc.collectHashRate
	mc.collectors[MetricShareLatency] = mc.collectShareLatency
	
	return mc
}

func (mc *MetricsCollector) Start() error {
	return nil
}

func (mc *MetricsCollector) Stop() {
	// Stop collectors
}

func (mc *MetricsCollector) CollectAll() map[MetricType]float64 {
	metrics := make(map[MetricType]float64)
	
	for metricType, collector := range mc.collectors {
		metrics[metricType] = collector()
	}
	
	return metrics
}

func (mc *MetricsCollector) collectLatency() float64 {
	// Simulate latency collection
	return 50.0 + math.Sin(float64(time.Now().Unix())/100)*10
}

func (mc *MetricsCollector) collectThroughput() float64 {
	// Simulate throughput collection
	return 1000.0 + math.Cos(float64(time.Now().Unix())/100)*100
}

func (mc *MetricsCollector) collectCPU() float64 {
	// Simulate CPU usage
	return 50.0 + math.Sin(float64(time.Now().Unix())/50)*20
}

func (mc *MetricsCollector) collectMemory() float64 {
	// Simulate memory usage
	return 60.0 + math.Cos(float64(time.Now().Unix())/60)*10
}

func (mc *MetricsCollector) collectGoroutines() float64 {
	return float64(runtime.NumGoroutine())
}

func (mc *MetricsCollector) collectGC() float64 {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	return float64(stats.PauseTotalNs) / 1e6 // Convert to milliseconds
}

func (mc *MetricsCollector) collectHashRate() float64 {
	// Simulate hash rate
	return 1000000.0 + math.Sin(float64(time.Now().Unix())/30)*50000
}

func (mc *MetricsCollector) collectShareLatency() float64 {
	// Simulate share submission latency
	return 10.0 + math.Cos(float64(time.Now().Unix())/40)*2
}

// StatisticalAnalyzer performs statistical analysis
type StatisticalAnalyzer struct {
	config *RegressionConfig
}

func NewStatisticalAnalyzer(config *RegressionConfig) *StatisticalAnalyzer {
	return &StatisticalAnalyzer{config: config}
}

func (sa *StatisticalAnalyzer) CalculateBaseline(metricType MetricType, samples []float64) *PerformanceBaseline {
	if len(samples) == 0 {
		return nil
	}
	
	// Sort samples for percentile calculation
	sorted := make([]float64, len(samples))
	copy(sorted, samples)
	sort.Float64s(sorted)
	
	baseline := &PerformanceBaseline{
		MetricType:  metricType,
		Mean:        sa.calculateMean(samples),
		StdDev:      sa.calculateStdDev(samples),
		Median:      sa.calculatePercentile(sorted, 0.5),
		P50:         sa.calculatePercentile(sorted, 0.5),
		P95:         sa.calculatePercentile(sorted, 0.95),
		P99:         sa.calculatePercentile(sorted, 0.99),
		Min:         sorted[0],
		Max:         sorted[len(sorted)-1],
		SampleCount: len(samples),
		LastUpdated: time.Now(),
	}
	
	if sa.config.UseMAD {
		baseline.MAD = sa.calculateMAD(samples, baseline.Median)
	}
	
	return baseline
}

func (sa *StatisticalAnalyzer) FindCorrelations(metricType MetricType, timestamp time.Time) []Correlation {
	// Simplified correlation analysis
	correlations := []Correlation{
		{Metric: "cpu", Coefficient: 0.8},
		{Metric: "memory", Coefficient: 0.6},
	}
	return correlations
}

func (sa *StatisticalAnalyzer) calculateMean(samples []float64) float64 {
	sum := 0.0
	for _, v := range samples {
		sum += v
	}
	return sum / float64(len(samples))
}

func (sa *StatisticalAnalyzer) calculateStdDev(samples []float64) float64 {
	mean := sa.calculateMean(samples)
	variance := 0.0
	
	for _, v := range samples {
		diff := v - mean
		variance += diff * diff
	}
	
	return math.Sqrt(variance / float64(len(samples)))
}

func (sa *StatisticalAnalyzer) calculatePercentile(sorted []float64, percentile float64) float64 {
	index := int(percentile * float64(len(sorted)-1))
	return sorted[index]
}

func (sa *StatisticalAnalyzer) calculateMAD(samples []float64, median float64) float64 {
	deviations := make([]float64, len(samples))
	for i, v := range samples {
		deviations[i] = math.Abs(v - median)
	}
	sort.Float64s(deviations)
	return sa.calculatePercentile(deviations, 0.5)
}

// Detector interface for different detection strategies
type Detector interface {
	Detect(baseline *PerformanceBaseline, currentValue float64) *DetectedRegression
}

// LatencyDetector detects latency regressions
type LatencyDetector struct {
	config *RegressionConfig
}

func NewLatencyDetector(config *RegressionConfig) *LatencyDetector {
	return &LatencyDetector{config: config}
}

func (ld *LatencyDetector) Detect(baseline *PerformanceBaseline, currentValue float64) *DetectedRegression {
	// Calculate z-score
	zScore := (currentValue - baseline.Mean) / baseline.StdDev
	
	// Check if regression
	threshold := 2.0 * (1.0 - ld.config.Sensitivity)
	if zScore <= threshold {
		return nil
	}
	
	// Calculate degradation
	degradation := ((currentValue - baseline.Mean) / baseline.Mean) * 100
	
	// Determine severity
	severity := ld.determineSeverity(degradation, zScore)
	
	return &DetectedRegression{
		ID:             generateRegressionID(),
		MetricType:     baseline.MetricType,
		DetectedAt:     time.Now(),
		Severity:       severity,
		BaselineValue:  baseline.Mean,
		CurrentValue:   currentValue,
		Degradation:    degradation,
		Confidence:     ld.calculateConfidence(zScore),
		StatisticalSig: ld.calculatePValue(zScore),
		Description:    fmt.Sprintf("Latency increased by %.1f%% (%.2fms -> %.2fms)", degradation, baseline.Mean, currentValue),
	}
}

func (ld *LatencyDetector) determineSeverity(degradation, zScore float64) RegressionSeverity {
	if degradation > 100 || zScore > 4 {
		return SeverityCritical
	} else if degradation > 50 || zScore > 3 {
		return SeverityHigh
	} else if degradation > 25 || zScore > 2.5 {
		return SeverityMedium
	}
	return SeverityLow
}

func (ld *LatencyDetector) calculateConfidence(zScore float64) float64 {
	// Simplified confidence calculation
	return math.Min(1.0, zScore/5.0)
}

func (ld *LatencyDetector) calculatePValue(zScore float64) float64 {
	// Simplified p-value calculation
	return 1.0 - math.Erf(math.Abs(zScore)/math.Sqrt(2))
}

// ThroughputDetector detects throughput regressions
type ThroughputDetector struct {
	config *RegressionConfig
}

func NewThroughputDetector(config *RegressionConfig) *ThroughputDetector {
	return &ThroughputDetector{config: config}
}

func (td *ThroughputDetector) Detect(baseline *PerformanceBaseline, currentValue float64) *DetectedRegression {
	// For throughput, lower is worse
	zScore := (baseline.Mean - currentValue) / baseline.StdDev
	
	threshold := 2.0 * (1.0 - td.config.Sensitivity)
	if zScore <= threshold {
		return nil
	}
	
	degradation := ((baseline.Mean - currentValue) / baseline.Mean) * 100
	
	return &DetectedRegression{
		ID:             generateRegressionID(),
		MetricType:     baseline.MetricType,
		DetectedAt:     time.Now(),
		Severity:       td.determineSeverity(degradation),
		BaselineValue:  baseline.Mean,
		CurrentValue:   currentValue,
		Degradation:    degradation,
		Confidence:     math.Min(1.0, zScore/5.0),
		Description:    fmt.Sprintf("Throughput decreased by %.1f%% (%.0f -> %.0f req/s)", degradation, baseline.Mean, currentValue),
	}
}

func (td *ThroughputDetector) determineSeverity(degradation float64) RegressionSeverity {
	if degradation > 50 {
		return SeverityCritical
	} else if degradation > 30 {
		return SeverityHigh
	} else if degradation > 15 {
		return SeverityMedium
	}
	return SeverityLow
}

// ResourceDetector detects resource usage regressions
type ResourceDetector struct {
	config *RegressionConfig
}

func NewResourceDetector(config *RegressionConfig) *ResourceDetector {
	return &ResourceDetector{config: config}
}

func (rd *ResourceDetector) Detect(baseline *PerformanceBaseline, currentValue float64) *DetectedRegression {
	// For resources, higher usage is worse
	if rd.config.UseMAD && baseline.MAD > 0 {
		// Use MAD for more robust detection
		deviation := (currentValue - baseline.Median) / baseline.MAD
		if deviation <= 2.5 {
			return nil
		}
	}
	
	zScore := (currentValue - baseline.Mean) / baseline.StdDev
	threshold := 2.0 * (1.0 - rd.config.Sensitivity)
	
	if zScore <= threshold {
		return nil
	}
	
	degradation := ((currentValue - baseline.Mean) / baseline.Mean) * 100
	
	return &DetectedRegression{
		ID:             generateRegressionID(),
		MetricType:     baseline.MetricType,
		DetectedAt:     time.Now(),
		Severity:       rd.determineSeverity(currentValue),
		BaselineValue:  baseline.Mean,
		CurrentValue:   currentValue,
		Degradation:    degradation,
		Confidence:     math.Min(1.0, zScore/5.0),
		Description:    fmt.Sprintf("Resource usage increased by %.1f%%", degradation),
	}
}

func (rd *ResourceDetector) determineSeverity(usage float64) RegressionSeverity {
	if usage > 90 {
		return SeverityCritical
	} else if usage > 80 {
		return SeverityHigh
	} else if usage > 70 {
		return SeverityMedium
	}
	return SeverityLow
}

// GCDetector detects garbage collection regressions
type GCDetector struct {
	config *RegressionConfig
}

func NewGCDetector(config *RegressionConfig) *GCDetector {
	return &GCDetector{config: config}
}

func (gd *GCDetector) Detect(baseline *PerformanceBaseline, currentValue float64) *DetectedRegression {
	// Use percentile-based detection for GC
	if currentValue <= baseline.P99 {
		return nil
	}
	
	degradation := ((currentValue - baseline.P95) / baseline.P95) * 100
	
	return &DetectedRegression{
		ID:             generateRegressionID(),
		MetricType:     baseline.MetricType,
		DetectedAt:     time.Now(),
		Severity:       gd.determineSeverity(currentValue),
		BaselineValue:  baseline.P95,
		CurrentValue:   currentValue,
		Degradation:    degradation,
		Confidence:     0.9,
		Description:    fmt.Sprintf("GC pause time exceeded P99: %.2fms (P99: %.2fms)", currentValue, baseline.P99),
	}
}

func (gd *GCDetector) determineSeverity(pauseTime float64) RegressionSeverity {
	if pauseTime > 100 {
		return SeverityCritical
	} else if pauseTime > 50 {
		return SeverityHigh
	} else if pauseTime > 20 {
		return SeverityMedium
	}
	return SeverityLow
}

// GenericDetector for custom metrics
type GenericDetector struct {
	config *RegressionConfig
}

func NewGenericDetector(config *RegressionConfig) *GenericDetector {
	return &GenericDetector{config: config}
}

func (gd *GenericDetector) Detect(baseline *PerformanceBaseline, currentValue float64) *DetectedRegression {
	// Generic z-score based detection
	zScore := math.Abs(currentValue-baseline.Mean) / baseline.StdDev
	
	threshold := 2.0 * (1.0 - gd.config.Sensitivity)
	if zScore <= threshold {
		return nil
	}
	
	degradation := math.Abs(currentValue-baseline.Mean) / baseline.Mean * 100
	
	return &DetectedRegression{
		ID:             generateRegressionID(),
		MetricType:     baseline.MetricType,
		DetectedAt:     time.Now(),
		Severity:       SeverityMedium,
		BaselineValue:  baseline.Mean,
		CurrentValue:   currentValue,
		Degradation:    degradation,
		Confidence:     math.Min(1.0, zScore/5.0),
		Description:    fmt.Sprintf("Metric deviated by %.1f%% from baseline", degradation),
	}
}

// AlertManager handles regression alerts
type AlertManager struct {
	logger       *zap.Logger
	config       *RegressionConfig
	lastAlerts   map[string]time.Time
	lastAlertsMu sync.RWMutex
}

func NewAlertManager(logger *zap.Logger, config *RegressionConfig) *AlertManager {
	return &AlertManager{
		logger:     logger,
		config:     config,
		lastAlerts: make(map[string]time.Time),
	}
}

func (am *AlertManager) SendAlert(regression *DetectedRegression) {
	// Check cooldown
	am.lastAlertsMu.RLock()
	lastAlert, exists := am.lastAlerts[string(regression.MetricType)]
	am.lastAlertsMu.RUnlock()
	
	if exists && time.Since(lastAlert) < am.config.AlertCooldown {
		return
	}
	
	// Send alerts to configured channels
	for _, channel := range am.config.AlertChannels {
		am.sendToChannel(channel, regression)
	}
	
	// Update last alert time
	am.lastAlertsMu.Lock()
	am.lastAlerts[string(regression.MetricType)] = time.Now()
	am.lastAlertsMu.Unlock()
}

func (am *AlertManager) sendToChannel(channel string, regression *DetectedRegression) {
	am.logger.Error("Performance regression alert",
		zap.String("channel", channel),
		zap.String("metric", string(regression.MetricType)),
		zap.String("severity", string(regression.Severity)),
		zap.Float64("degradation", regression.Degradation),
	)
}

// PerformanceHistory tracks historical performance data
type PerformanceHistory struct {
	data     map[MetricType][]HistoricalPoint
	dataMu   sync.RWMutex
	changes  []SystemChange
	changeMu sync.RWMutex
}

type HistoricalPoint struct {
	Timestamp time.Time
	Value     float64
}

type SystemChange struct {
	Timestamp   time.Time
	Description string
	ChangeType  string
}

func NewPerformanceHistory() *PerformanceHistory {
	return &PerformanceHistory{
		data:    make(map[MetricType][]HistoricalPoint),
		changes: make([]SystemChange, 0),
	}
}

func (ph *PerformanceHistory) GetSamples(metricType MetricType, window time.Duration) []float64 {
	ph.dataMu.RLock()
	defer ph.dataMu.RUnlock()
	
	cutoff := time.Now().Add(-window)
	samples := make([]float64, 0)
	
	if points, exists := ph.data[metricType]; exists {
		for _, point := range points {
			if point.Timestamp.After(cutoff) {
				samples = append(samples, point.Value)
			}
		}
	}
	
	return samples
}

func (ph *PerformanceHistory) GetRecentChanges(since time.Time) []SystemChange {
	ph.changeMu.RLock()
	defer ph.changeMu.RUnlock()
	
	recent := make([]SystemChange, 0)
	for _, change := range ph.changes {
		if change.Timestamp.After(since) {
			recent = append(recent, change)
		}
	}
	
	return recent
}

// Helper structures

type Correlation struct {
	Metric      string
	Coefficient float64
}

type RegressionStats struct {
	TotalChecks         uint64
	RegressionsDetected uint64
	ActiveRegressions   int
	Precision           float64
	DetectionRate       float64
	AvgDetectionTime    time.Duration
	Baselines           map[string]BaselineInfo
}

type BaselineInfo struct {
	Mean        float64
	StdDev      float64
	SampleCount int
	LastUpdated time.Time
}

// Utility functions

func generateRegressionID() string {
	return fmt.Sprintf("reg_%d_%d", time.Now().Unix(), rand.Intn(10000))
}

// DefaultRegressionConfig returns default configuration
func DefaultRegressionConfig() *RegressionConfig {
	return &RegressionConfig{
		Sensitivity:        0.8,
		ConfidenceLevel:    0.95,
		MinSampleSize:      100,
		DetectionWindow:    5 * time.Minute,
		BaselineWindow:     24 * time.Hour,
		BaselineUpdateFreq: 1 * time.Hour,
		AutoBaseline:       true,
		TrackedMetrics: []MetricType{
			MetricLatency,
			MetricThroughput,
			MetricCPU,
			MetricMemory,
			MetricHashRate,
			MetricShareLatency,
		},
		MetricThresholds: map[MetricType]float64{
			MetricLatency:      100.0,  // 100ms
			MetricCPU:          80.0,   // 80%
			MetricMemory:       85.0,   // 85%
		},
		UseMAD:             true,
		OutlierThreshold:   3.0,
		TrendAnalysis:      true,
		AlertOnRegression:  true,
		AlertChannels:      []string{"slack", "email", "pagerduty"},
		AlertCooldown:      15 * time.Minute,
		ReportingEnabled:   true,
		ReportingInterval:  1 * time.Hour,
	}
}