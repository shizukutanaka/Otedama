package monitoring

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// AnomalyDetector implements real-time anomaly detection
type AnomalyDetector struct {
	logger        *zap.Logger
	config        AnomalyConfig
	metrics       *MetricsCollector
	algorithms    map[string]AnomalyAlgorithm
	alerts        *AlertManager
	history       *MetricsHistory
	stats         *AnomalyStats
	mu            sync.RWMutex
	shutdown      chan struct{}
}

// AnomalyConfig contains anomaly detection configuration
type AnomalyConfig struct {
	// Detection settings
	EnableZScore          bool
	EnableIsolationForest bool
	EnableLSTM           bool
	EnableEWMA           bool
	
	// Thresholds
	ZScoreThreshold      float64
	IsolationThreshold   float64
	EWMAAlpha           float64
	
	// Window settings
	HistoryWindow       time.Duration
	DetectionInterval   time.Duration
	BaselineWindow      time.Duration
	
	// Alert settings
	AlertCooldown       time.Duration
	MinAnomalyDuration  time.Duration
	MaxFalsePositives   int
}

// MetricsCollector collects system metrics
type MetricsCollector struct {
	// Mining metrics
	hashRate        *MetricStream
	shareRate       *MetricStream
	rejectRate      *MetricStream
	
	// Network metrics
	latency         *MetricStream
	packetLoss      *MetricStream
	bandwidth       *MetricStream
	
	// System metrics
	cpuUsage        *MetricStream
	memoryUsage     *MetricStream
	diskIO          *MetricStream
	temperature     *MetricStream
	
	// Pool metrics
	peerCount       *MetricStream
	blockTime       *MetricStream
	orphanRate      *MetricStream
	
	mu              sync.RWMutex
}

// MetricStream represents a time-series metric stream
type MetricStream struct {
	name        string
	values      []MetricPoint
	maxPoints   int
	mu          sync.RWMutex
}

// MetricPoint represents a single metric measurement
type MetricPoint struct {
	Timestamp time.Time
	Value     float64
	Tags      map[string]string
}

// AnomalyAlgorithm interface for anomaly detection algorithms
type AnomalyAlgorithm interface {
	Detect(stream *MetricStream) []Anomaly
	Train(history []MetricPoint)
	GetName() string
}

// Anomaly represents a detected anomaly
type Anomaly struct {
	ID            string
	Type          string
	Severity      SeverityLevel
	Metric        string
	Value         float64
	ExpectedRange [2]float64
	Timestamp     time.Time
	Duration      time.Duration
	Confidence    float64
	Algorithm     string
	Description   string
}

// SeverityLevel represents anomaly severity
type SeverityLevel int

const (
	SeverityLow SeverityLevel = iota
	SeverityMedium
	SeverityHigh
	SeverityCritical
)

// AlertManager manages anomaly alerts
type AlertManager struct {
	alerts      sync.Map // alertID -> *Alert
	subscribers []AlertSubscriber
	cooldowns   sync.Map // metric -> lastAlert
	mu          sync.RWMutex
}

// Alert represents an anomaly alert
type Alert struct {
	ID        string
	Anomaly   Anomaly
	Status    AlertStatus
	CreatedAt time.Time
	UpdatedAt time.Time
	Actions   []string
}

// AlertStatus represents alert status
type AlertStatus int

const (
	AlertStatusActive AlertStatus = iota
	AlertStatusAcknowledged
	AlertStatusResolved
)

// AlertSubscriber interface for alert notifications
type AlertSubscriber interface {
	OnAlert(alert *Alert)
}

// MetricsHistory stores historical metrics
type MetricsHistory struct {
	data       sync.Map // metric -> *CircularBuffer
	maxHistory time.Duration
}

// AnomalyStats tracks anomaly detection statistics
type AnomalyStats struct {
	TotalAnomalies    atomic.Uint64
	FalsePositives    atomic.Uint64
	TruePositives     atomic.Uint64
	AnomaliesByType   sync.Map
	AnomaliesBySeverity sync.Map
	DetectionLatency  atomic.Int64 // microseconds
}

// NewAnomalyDetector creates a new anomaly detector
func NewAnomalyDetector(config AnomalyConfig, logger *zap.Logger) *AnomalyDetector {
	if config.ZScoreThreshold == 0 {
		config.ZScoreThreshold = 3.0
	}
	if config.IsolationThreshold == 0 {
		config.IsolationThreshold = 0.5
	}
	if config.EWMAAlpha == 0 {
		config.EWMAAlpha = 0.1
	}
	if config.HistoryWindow == 0 {
		config.HistoryWindow = 24 * time.Hour
	}
	if config.DetectionInterval == 0 {
		config.DetectionInterval = 10 * time.Second
	}
	if config.BaselineWindow == 0 {
		config.BaselineWindow = 1 * time.Hour
	}

	ad := &AnomalyDetector{
		logger:     logger,
		config:     config,
		metrics:    NewMetricsCollector(),
		algorithms: make(map[string]AnomalyAlgorithm),
		alerts:     NewAlertManager(),
		history:    NewMetricsHistory(config.HistoryWindow),
		stats:      &AnomalyStats{},
		shutdown:   make(chan struct{}),
	}

	// Initialize algorithms
	if config.EnableZScore {
		ad.algorithms["zscore"] = NewZScoreDetector(config.ZScoreThreshold)
	}
	if config.EnableIsolationForest {
		ad.algorithms["isolation"] = NewIsolationForestDetector(config.IsolationThreshold)
	}
	if config.EnableEWMA {
		ad.algorithms["ewma"] = NewEWMADetector(config.EWMAAlpha)
	}

	return ad
}

// Start starts the anomaly detector
func (ad *AnomalyDetector) Start(ctx context.Context) error {
	ad.logger.Info("Starting anomaly detector",
		zap.Int("algorithms", len(ad.algorithms)))

	// Start detection loop
	go ad.detectionLoop(ctx)

	// Start cleanup routine
	go ad.cleanupLoop(ctx)

	return nil
}

// Stop stops the anomaly detector
func (ad *AnomalyDetector) Stop() error {
	close(ad.shutdown)
	return nil
}

// RecordMetric records a metric value
func (ad *AnomalyDetector) RecordMetric(name string, value float64, tags map[string]string) {
	stream := ad.metrics.GetOrCreateStream(name)
	point := MetricPoint{
		Timestamp: time.Now(),
		Value:     value,
		Tags:      tags,
	}
	
	stream.AddPoint(point)
	ad.history.Store(name, point)
}

// detectionLoop runs anomaly detection periodically
func (ad *AnomalyDetector) detectionLoop(ctx context.Context) {
	ticker := time.NewTicker(ad.config.DetectionInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ad.shutdown:
			return
		case <-ticker.C:
			ad.runDetection()
		}
	}
}

// runDetection runs anomaly detection on all metrics
func (ad *AnomalyDetector) runDetection() {
	startTime := time.Now()
	
	streams := ad.metrics.GetAllStreams()
	for _, stream := range streams {
		// Skip if not enough data
		if stream.Length() < 10 {
			continue
		}

		// Run each algorithm
		for name, algorithm := range ad.algorithms {
			anomalies := algorithm.Detect(stream)
			
			for _, anomaly := range anomalies {
				anomaly.Algorithm = name
				ad.handleAnomaly(anomaly)
			}
		}
	}

	// Update detection latency
	latency := time.Since(startTime).Microseconds()
	ad.stats.DetectionLatency.Store(latency)
}

// handleAnomaly processes a detected anomaly
func (ad *AnomalyDetector) handleAnomaly(anomaly Anomaly) {
	ad.stats.TotalAnomalies.Add(1)
	
	// Update statistics
	ad.updateAnomalyStats(anomaly)
	
	// Check if should alert
	if ad.shouldAlert(anomaly) {
		alert := ad.alerts.CreateAlert(anomaly)
		ad.alerts.Notify(alert)
		
		ad.logger.Warn("Anomaly detected",
			zap.String("metric", anomaly.Metric),
			zap.String("type", anomaly.Type),
			zap.Float64("value", anomaly.Value),
			zap.String("severity", anomaly.Severity.String()),
			zap.Float64("confidence", anomaly.Confidence))
	}
}

// shouldAlert determines if an alert should be sent
func (ad *AnomalyDetector) shouldAlert(anomaly Anomaly) bool {
	// Check cooldown
	if lastAlert, ok := ad.alerts.cooldowns.Load(anomaly.Metric); ok {
		if time.Since(lastAlert.(time.Time)) < ad.config.AlertCooldown {
			return false
		}
	}
	
	// Check severity
	if anomaly.Severity < SeverityMedium {
		return false
	}
	
	// Check confidence
	if anomaly.Confidence < 0.7 {
		return false
	}
	
	return true
}

// updateAnomalyStats updates anomaly statistics
func (ad *AnomalyDetector) updateAnomalyStats(anomaly Anomaly) {
	// Update by type
	if val, ok := ad.stats.AnomaliesByType.Load(anomaly.Type); ok {
		ad.stats.AnomaliesByType.Store(anomaly.Type, val.(uint64)+1)
	} else {
		ad.stats.AnomaliesByType.Store(anomaly.Type, uint64(1))
	}
	
	// Update by severity
	severityStr := anomaly.Severity.String()
	if val, ok := ad.stats.AnomaliesBySeverity.Load(severityStr); ok {
		ad.stats.AnomaliesBySeverity.Store(severityStr, val.(uint64)+1)
	} else {
		ad.stats.AnomaliesBySeverity.Store(severityStr, uint64(1))
	}
}

// cleanupLoop periodically cleans up old data
func (ad *AnomalyDetector) cleanupLoop(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ad.shutdown:
			return
		case <-ticker.C:
			ad.cleanup()
		}
	}
}

// cleanup removes old data
func (ad *AnomalyDetector) cleanup() {
	// Clean up metrics
	streams := ad.metrics.GetAllStreams()
	for _, stream := range streams {
		stream.Cleanup(ad.config.HistoryWindow)
	}
	
	// Clean up history
	ad.history.Cleanup()
	
	// Clean up old alerts
	ad.alerts.CleanupOld(24 * time.Hour)
}

// GetStats returns anomaly detection statistics
func (ad *AnomalyDetector) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_anomalies":    ad.stats.TotalAnomalies.Load(),
		"false_positives":    ad.stats.FalsePositives.Load(),
		"true_positives":     ad.stats.TruePositives.Load(),
		"detection_latency":  ad.stats.DetectionLatency.Load(),
		"active_algorithms":  len(ad.algorithms),
	}
	
	// Add anomalies by type
	byType := make(map[string]uint64)
	ad.stats.AnomaliesByType.Range(func(key, value interface{}) bool {
		byType[key.(string)] = value.(uint64)
		return true
	})
	stats["anomalies_by_type"] = byType
	
	// Add anomalies by severity
	bySeverity := make(map[string]uint64)
	ad.stats.AnomaliesBySeverity.Range(func(key, value interface{}) bool {
		bySeverity[key.(string)] = value.(uint64)
		return true
	})
	stats["anomalies_by_severity"] = bySeverity
	
	return stats
}

// Implementation of components

// NewMetricsCollector creates a new metrics collector
func NewMetricsCollector() *MetricsCollector {
	mc := &MetricsCollector{
		// Mining metrics
		hashRate:    NewMetricStream("hash_rate", 1000),
		shareRate:   NewMetricStream("share_rate", 1000),
		rejectRate:  NewMetricStream("reject_rate", 1000),
		
		// Network metrics
		latency:     NewMetricStream("latency", 1000),
		packetLoss:  NewMetricStream("packet_loss", 1000),
		bandwidth:   NewMetricStream("bandwidth", 1000),
		
		// System metrics
		cpuUsage:    NewMetricStream("cpu_usage", 1000),
		memoryUsage: NewMetricStream("memory_usage", 1000),
		diskIO:      NewMetricStream("disk_io", 1000),
		temperature: NewMetricStream("temperature", 1000),
		
		// Pool metrics
		peerCount:   NewMetricStream("peer_count", 1000),
		blockTime:   NewMetricStream("block_time", 1000),
		orphanRate:  NewMetricStream("orphan_rate", 1000),
	}
	
	return mc
}

// GetOrCreateStream gets or creates a metric stream
func (mc *MetricsCollector) GetOrCreateStream(name string) *MetricStream {
	mc.mu.RLock()
	
	// Check existing streams
	switch name {
	case "hash_rate":
		mc.mu.RUnlock()
		return mc.hashRate
	case "share_rate":
		mc.mu.RUnlock()
		return mc.shareRate
	case "reject_rate":
		mc.mu.RUnlock()
		return mc.rejectRate
	case "latency":
		mc.mu.RUnlock()
		return mc.latency
	case "packet_loss":
		mc.mu.RUnlock()
		return mc.packetLoss
	case "bandwidth":
		mc.mu.RUnlock()
		return mc.bandwidth
	case "cpu_usage":
		mc.mu.RUnlock()
		return mc.cpuUsage
	case "memory_usage":
		mc.mu.RUnlock()
		return mc.memoryUsage
	case "disk_io":
		mc.mu.RUnlock()
		return mc.diskIO
	case "temperature":
		mc.mu.RUnlock()
		return mc.temperature
	case "peer_count":
		mc.mu.RUnlock()
		return mc.peerCount
	case "block_time":
		mc.mu.RUnlock()
		return mc.blockTime
	case "orphan_rate":
		mc.mu.RUnlock()
		return mc.orphanRate
	default:
		mc.mu.RUnlock()
		// Create new stream for unknown metrics
		return NewMetricStream(name, 1000)
	}
}

// GetAllStreams returns all metric streams
func (mc *MetricsCollector) GetAllStreams() []*MetricStream {
	mc.mu.RLock()
	defer mc.mu.RUnlock()
	
	return []*MetricStream{
		mc.hashRate,
		mc.shareRate,
		mc.rejectRate,
		mc.latency,
		mc.packetLoss,
		mc.bandwidth,
		mc.cpuUsage,
		mc.memoryUsage,
		mc.diskIO,
		mc.temperature,
		mc.peerCount,
		mc.blockTime,
		mc.orphanRate,
	}
}

// NewMetricStream creates a new metric stream
func NewMetricStream(name string, maxPoints int) *MetricStream {
	return &MetricStream{
		name:      name,
		values:    make([]MetricPoint, 0, maxPoints),
		maxPoints: maxPoints,
	}
}

// AddPoint adds a point to the stream
func (ms *MetricStream) AddPoint(point MetricPoint) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	
	ms.values = append(ms.values, point)
	
	// Remove old points if exceeding max
	if len(ms.values) > ms.maxPoints {
		ms.values = ms.values[len(ms.values)-ms.maxPoints:]
	}
}

// GetRecent gets recent points
func (ms *MetricStream) GetRecent(duration time.Duration) []MetricPoint {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	
	cutoff := time.Now().Add(-duration)
	var recent []MetricPoint
	
	for i := len(ms.values) - 1; i >= 0; i-- {
		if ms.values[i].Timestamp.After(cutoff) {
			recent = append(recent, ms.values[i])
		} else {
			break
		}
	}
	
	// Reverse to chronological order
	for i, j := 0, len(recent)-1; i < j; i, j = i+1, j-1 {
		recent[i], recent[j] = recent[j], recent[i]
	}
	
	return recent
}

// Length returns the number of points
func (ms *MetricStream) Length() int {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	return len(ms.values)
}

// Cleanup removes old points
func (ms *MetricStream) Cleanup(maxAge time.Duration) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	
	cutoff := time.Now().Add(-maxAge)
	var kept []MetricPoint
	
	for _, point := range ms.values {
		if point.Timestamp.After(cutoff) {
			kept = append(kept, point)
		}
	}
	
	ms.values = kept
}

// Algorithm implementations

// ZScoreDetector implements Z-score based anomaly detection
type ZScoreDetector struct {
	threshold float64
}

func NewZScoreDetector(threshold float64) *ZScoreDetector {
	return &ZScoreDetector{threshold: threshold}
}

func (zd *ZScoreDetector) Detect(stream *MetricStream) []Anomaly {
	points := stream.GetRecent(1 * time.Hour)
	if len(points) < 30 {
		return nil
	}
	
	// Calculate mean and stddev
	var sum, sumSq float64
	for _, p := range points {
		sum += p.Value
		sumSq += p.Value * p.Value
	}
	
	n := float64(len(points))
	mean := sum / n
	variance := (sumSq / n) - (mean * mean)
	stddev := math.Sqrt(variance)
	
	if stddev == 0 {
		return nil
	}
	
	// Check latest point
	latest := points[len(points)-1]
	zscore := math.Abs((latest.Value - mean) / stddev)
	
	if zscore > zd.threshold {
		return []Anomaly{{
			Type:          "zscore",
			Metric:        stream.name,
			Value:         latest.Value,
			ExpectedRange: [2]float64{mean - zd.threshold*stddev, mean + zd.threshold*stddev},
			Timestamp:     latest.Timestamp,
			Confidence:    math.Min(zscore/zd.threshold, 1.0),
			Severity:      zd.getSeverity(zscore),
			Description:   fmt.Sprintf("Value %.2f is %.2f standard deviations from mean %.2f", latest.Value, zscore, mean),
		}}
	}
	
	return nil
}

func (zd *ZScoreDetector) Train(history []MetricPoint) {}

func (zd *ZScoreDetector) GetName() string { return "zscore" }

func (zd *ZScoreDetector) getSeverity(zscore float64) SeverityLevel {
	if zscore > 5 {
		return SeverityCritical
	} else if zscore > 4 {
		return SeverityHigh
	} else if zscore > 3 {
		return SeverityMedium
	}
	return SeverityLow
}

// IsolationForestDetector implements Isolation Forest algorithm
type IsolationForestDetector struct {
	threshold float64
	trees     []*IsolationTree
}

type IsolationTree struct {
	root *IsolationNode
}

type IsolationNode struct {
	left      *IsolationNode
	right     *IsolationNode
	splitAttr int
	splitVal  float64
	size      int
}

func NewIsolationForestDetector(threshold float64) *IsolationForestDetector {
	return &IsolationForestDetector{
		threshold: threshold,
		trees:     make([]*IsolationTree, 100), // 100 trees
	}
}

func (ifd *IsolationForestDetector) Detect(stream *MetricStream) []Anomaly {
	// Simplified implementation for demonstration
	points := stream.GetRecent(1 * time.Hour)
	if len(points) < 10 {
		return nil
	}
	
	latest := points[len(points)-1]
	
	// Calculate anomaly score based on value distribution
	values := make([]float64, len(points))
	for i, p := range points {
		values[i] = p.Value
	}
	
	sort.Float64s(values)
	
	// Find percentile of latest value
	position := sort.SearchFloat64s(values, latest.Value)
	percentile := float64(position) / float64(len(values))
	
	// Values at extremes are anomalous
	anomalyScore := 2 * math.Abs(percentile - 0.5)
	
	if anomalyScore > ifd.threshold {
		return []Anomaly{{
			Type:       "isolation",
			Metric:     stream.name,
			Value:      latest.Value,
			Timestamp:  latest.Timestamp,
			Confidence: anomalyScore,
			Severity:   ifd.getSeverity(anomalyScore),
			Description: fmt.Sprintf("Value %.2f has anomaly score %.2f (percentile %.2f)", latest.Value, anomalyScore, percentile),
		}}
	}
	
	return nil
}

func (ifd *IsolationForestDetector) Train(history []MetricPoint) {}

func (ifd *IsolationForestDetector) GetName() string { return "isolation" }

func (ifd *IsolationForestDetector) getSeverity(score float64) SeverityLevel {
	if score > 0.9 {
		return SeverityCritical
	} else if score > 0.8 {
		return SeverityHigh
	} else if score > 0.7 {
		return SeverityMedium
	}
	return SeverityLow
}

// EWMADetector implements Exponentially Weighted Moving Average detection
type EWMADetector struct {
	alpha    float64
	ewma     sync.Map // metric -> float64
	variance sync.Map // metric -> float64
}

func NewEWMADetector(alpha float64) *EWMADetector {
	return &EWMADetector{
		alpha: alpha,
	}
}

func (ed *EWMADetector) Detect(stream *MetricStream) []Anomaly {
	points := stream.GetRecent(10 * time.Minute)
	if len(points) < 5 {
		return nil
	}
	
	// Get or initialize EWMA
	ewmaVal, _ := ed.ewma.LoadOrStore(stream.name, points[0].Value)
	ewma := ewmaVal.(float64)
	
	varVal, _ := ed.variance.LoadOrStore(stream.name, 0.0)
	variance := varVal.(float64)
	
	// Update EWMA with recent points
	for i := 0; i < len(points)-1; i++ {
		ewma = ed.alpha*points[i].Value + (1-ed.alpha)*ewma
		
		// Update variance estimate
		diff := points[i].Value - ewma
		variance = ed.alpha*(diff*diff) + (1-ed.alpha)*variance
	}
	
	// Store updated values
	ed.ewma.Store(stream.name, ewma)
	ed.variance.Store(stream.name, variance)
	
	// Check latest point
	latest := points[len(points)-1]
	diff := math.Abs(latest.Value - ewma)
	stddev := math.Sqrt(variance)
	
	if stddev > 0 && diff > 3*stddev {
		return []Anomaly{{
			Type:          "ewma",
			Metric:        stream.name,
			Value:         latest.Value,
			ExpectedRange: [2]float64{ewma - 3*stddev, ewma + 3*stddev},
			Timestamp:     latest.Timestamp,
			Confidence:    math.Min(diff/(3*stddev), 1.0),
			Severity:      ed.getSeverity(diff / stddev),
			Description:   fmt.Sprintf("Value %.2f deviates from EWMA %.2f by %.2f", latest.Value, ewma, diff),
		}}
	}
	
	return nil
}

func (ed *EWMADetector) Train(history []MetricPoint) {}

func (ed *EWMADetector) GetName() string { return "ewma" }

func (ed *EWMADetector) getSeverity(deviation float64) SeverityLevel {
	if deviation > 5 {
		return SeverityCritical
	} else if deviation > 4 {
		return SeverityHigh
	} else if deviation > 3 {
		return SeverityMedium
	}
	return SeverityLow
}

// Helper components

func NewAlertManager() *AlertManager {
	return &AlertManager{
		subscribers: make([]AlertSubscriber, 0),
	}
}

func (am *AlertManager) CreateAlert(anomaly Anomaly) *Alert {
	alert := &Alert{
		ID:        generateAlertID(),
		Anomaly:   anomaly,
		Status:    AlertStatusActive,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	
	am.alerts.Store(alert.ID, alert)
	am.cooldowns.Store(anomaly.Metric, time.Now())
	
	return alert
}

func (am *AlertManager) Notify(alert *Alert) {
	am.mu.RLock()
	subscribers := am.subscribers
	am.mu.RUnlock()
	
	for _, sub := range subscribers {
		go sub.OnAlert(alert)
	}
}

func (am *AlertManager) Subscribe(subscriber AlertSubscriber) {
	am.mu.Lock()
	am.subscribers = append(am.subscribers, subscriber)
	am.mu.Unlock()
}

func (am *AlertManager) CleanupOld(maxAge time.Duration) {
	cutoff := time.Now().Add(-maxAge)
	am.alerts.Range(func(key, value interface{}) bool {
		alert := value.(*Alert)
		if alert.CreatedAt.Before(cutoff) {
			am.alerts.Delete(key)
		}
		return true
	})
}

func NewMetricsHistory(maxHistory time.Duration) *MetricsHistory {
	return &MetricsHistory{
		maxHistory: maxHistory,
	}
}

func (mh *MetricsHistory) Store(metric string, point MetricPoint) {
	// Simplified - in production would use circular buffer
	mh.data.Store(metric, point)
}

func (mh *MetricsHistory) Cleanup() {
	// Cleanup old data
	cutoff := time.Now().Add(-mh.maxHistory)
	mh.data.Range(func(key, value interface{}) bool {
		if point, ok := value.(MetricPoint); ok {
			if point.Timestamp.Before(cutoff) {
				mh.data.Delete(key)
			}
		}
		return true
	})
}

// String methods

func (s SeverityLevel) String() string {
	switch s {
	case SeverityLow:
		return "low"
	case SeverityMedium:
		return "medium"
	case SeverityHigh:
		return "high"
	case SeverityCritical:
		return "critical"
	default:
		return "unknown"
	}
}

// Helper functions

func generateAlertID() string {
	return fmt.Sprintf("alert_%d", time.Now().UnixNano())
}

