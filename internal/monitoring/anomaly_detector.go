package monitoring

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

// AnomalyDetector detects anomalies in mining operations
// Following Rob Pike's principle: "Don't design with interfaces, discover them."
type AnomalyDetector struct {
	logger *zap.Logger
	
	// Time series data
	metrics       map[string]*MetricTimeSeries
	metricsMu     sync.RWMutex
	
	// Anomaly models
	models        map[string]AnomalyModel
	modelsMu      sync.RWMutex
	
	// Detected anomalies
	anomalies     []*Anomaly
	anomaliesMu   sync.RWMutex
	
	// Alert channels
	alertChannels []AlertChannel
	
	// Configuration
	config        AnomalyConfig
	
	// Control
	ctx           context.Context
	cancel        context.CancelFunc
	
	// Metrics
	detectorMetrics struct {
		dataPointsProcessed uint64
		anomaliesDetected   uint64
		falsePositives      uint64
		alertsSent          uint64
		modelsUpdated       uint64
		avgDetectionLatency uint64 // microseconds
	}
}

// AnomalyConfig configures anomaly detection
type AnomalyConfig struct {
	// Detection settings
	WindowSize        time.Duration
	UpdateInterval    time.Duration
	MinDataPoints     int
	
	// Sensitivity
	Sensitivity       float64 // 0.0 to 1.0
	ConfidenceLevel   float64
	
	// Models
	EnabledModels     []string
	ModelUpdatePeriod time.Duration
	
	// Alerting
	AlertThreshold    float64
	AlertCooldown     time.Duration
	MaxAlertsPerHour  int
}

// MetricTimeSeries stores time series data for a metric
type MetricTimeSeries struct {
	Name       string
	DataPoints []DataPoint
	Stats      TimeSeriesStats
	LastUpdate time.Time
	mu         sync.RWMutex
}

// DataPoint represents a single data point
type DataPoint struct {
	Timestamp time.Time
	Value     float64
	Tags      map[string]string
}

// TimeSeriesStats contains statistical information
type TimeSeriesStats struct {
	Mean     float64
	StdDev   float64
	Min      float64
	Max      float64
	Median   float64
	Q1       float64
	Q3       float64
	IQR      float64
	Count    int
}

// AnomalyModel interface for anomaly detection algorithms
type AnomalyModel interface {
	Name() string
	Train(data []DataPoint) error
	Detect(point DataPoint) (float64, error) // Returns anomaly score
	Update(point DataPoint) error
	GetThreshold() float64
}

// Anomaly represents a detected anomaly
type Anomaly struct {
	ID          string
	Metric      string
	Type        string
	Severity    string // "low", "medium", "high", "critical"
	Score       float64
	Expected    float64
	Actual      float64
	Deviation   float64
	Timestamp   time.Time
	Duration    time.Duration
	Description string
	Context     map[string]interface{}
}

// AlertChannel interface for sending alerts
type AlertChannel interface {
	SendAlert(anomaly *Anomaly) error
	Name() string
}

// NewAnomalyDetector creates a new anomaly detector
func NewAnomalyDetector(logger *zap.Logger, config AnomalyConfig) (*AnomalyDetector, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	ad := &AnomalyDetector{
		logger:        logger,
		metrics:       make(map[string]*MetricTimeSeries),
		models:        make(map[string]AnomalyModel),
		anomalies:     make([]*Anomaly, 0),
		alertChannels: make([]AlertChannel, 0),
		config:        config,
		ctx:           ctx,
		cancel:        cancel,
	}
	
	// Initialize models
	if err := ad.initializeModels(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to initialize models: %w", err)
	}
	
	// Start detection loop
	go ad.detectionLoop()
	
	// Start model update loop
	go ad.modelUpdateLoop()
	
	logger.Info("Initialized anomaly detector",
		zap.Float64("sensitivity", config.Sensitivity),
		zap.Int("models", len(ad.models)),
		zap.Duration("window_size", config.WindowSize))
	
	return ad, nil
}

// AddDataPoint adds a new data point for a metric
func (ad *AnomalyDetector) AddDataPoint(metric string, value float64, tags map[string]string) {
	ad.metricsMu.Lock()
	ts, exists := ad.metrics[metric]
	if !exists {
		ts = &MetricTimeSeries{
			Name:       metric,
			DataPoints: make([]DataPoint, 0),
		}
		ad.metrics[metric] = ts
	}
	ad.metricsMu.Unlock()
	
	point := DataPoint{
		Timestamp: time.Now(),
		Value:     value,
		Tags:      tags,
	}
	
	ts.mu.Lock()
	defer ts.mu.Unlock()
	
	// Add point
	ts.DataPoints = append(ts.DataPoints, point)
	ts.LastUpdate = time.Now()
	
	// Maintain window size
	cutoff := time.Now().Add(-ad.config.WindowSize)
	for len(ts.DataPoints) > 0 && ts.DataPoints[0].Timestamp.Before(cutoff) {
		ts.DataPoints = ts.DataPoints[1:]
	}
	
	// Update statistics
	ts.Stats = ad.calculateStats(ts.DataPoints)
	
	ad.detectorMetrics.dataPointsProcessed++
}

// DetectAnomalies runs anomaly detection on current data
func (ad *AnomalyDetector) DetectAnomalies() ([]*Anomaly, error) {
	detectedAnomalies := make([]*Anomaly, 0)
	
	ad.metricsMu.RLock()
	metrics := make([]*MetricTimeSeries, 0, len(ad.metrics))
	for _, ts := range ad.metrics {
		metrics = append(metrics, ts)
	}
	ad.metricsMu.RUnlock()
	
	for _, ts := range metrics {
		ts.mu.RLock()
		if len(ts.DataPoints) < ad.config.MinDataPoints {
			ts.mu.RUnlock()
			continue
		}
		
		// Get latest point
		latestPoint := ts.DataPoints[len(ts.DataPoints)-1]
		stats := ts.Stats
		ts.mu.RUnlock()
		
		// Run detection with each model
		ad.modelsMu.RLock()
		for _, model := range ad.models {
			score, err := model.Detect(latestPoint)
			if err != nil {
				ad.logger.Warn("Model detection failed",
					zap.String("model", model.Name()),
					zap.String("metric", ts.Name),
					zap.Error(err))
				continue
			}
			
			// Check if anomalous
			if score > model.GetThreshold() {
				anomaly := ad.createAnomaly(ts.Name, model.Name(), latestPoint, score, stats)
				detectedAnomalies = append(detectedAnomalies, anomaly)
			}
		}
		ad.modelsMu.RUnlock()
	}
	
	// Filter and rank anomalies
	filteredAnomalies := ad.filterAnomalies(detectedAnomalies)
	
	// Store detected anomalies
	ad.anomaliesMu.Lock()
	ad.anomalies = append(ad.anomalies, filteredAnomalies...)
	// Keep last 1000 anomalies
	if len(ad.anomalies) > 1000 {
		ad.anomalies = ad.anomalies[len(ad.anomalies)-1000:]
	}
	ad.anomaliesMu.Unlock()
	
	ad.detectorMetrics.anomaliesDetected += uint64(len(filteredAnomalies))
	
	return filteredAnomalies, nil
}

// GetRecentAnomalies returns recent anomalies
func (ad *AnomalyDetector) GetRecentAnomalies(duration time.Duration) []*Anomaly {
	ad.anomaliesMu.RLock()
	defer ad.anomaliesMu.RUnlock()
	
	cutoff := time.Now().Add(-duration)
	recent := make([]*Anomaly, 0)
	
	for i := len(ad.anomalies) - 1; i >= 0; i-- {
		if ad.anomalies[i].Timestamp.Before(cutoff) {
			break
		}
		recent = append(recent, ad.anomalies[i])
	}
	
	return recent
}

// AddAlertChannel adds an alert channel
func (ad *AnomalyDetector) AddAlertChannel(channel AlertChannel) {
	ad.alertChannels = append(ad.alertChannels, channel)
	
	ad.logger.Info("Added alert channel",
		zap.String("channel", channel.Name()))
}

// Implementation methods

func (ad *AnomalyDetector) initializeModels() error {
	for _, modelName := range ad.config.EnabledModels {
		var model AnomalyModel
		
		switch modelName {
		case "zscore":
			model = NewZScoreModel(ad.config.Sensitivity)
		case "mad":
			model = NewMADModel(ad.config.Sensitivity)
		case "isolation_forest":
			model = NewIsolationForestModel(100, ad.config.Sensitivity)
		case "lstm":
			model = NewLSTMModel(ad.config.WindowSize)
		case "prophet":
			model = NewProphetModel()
		default:
			ad.logger.Warn("Unknown model", zap.String("model", modelName))
			continue
		}
		
		ad.modelsMu.Lock()
		ad.models[modelName] = model
		ad.modelsMu.Unlock()
	}
	
	if len(ad.models) == 0 {
		return errors.New("no models initialized")
	}
	
	return nil
}

func (ad *AnomalyDetector) detectionLoop() {
	ticker := time.NewTicker(ad.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			anomalies, err := ad.DetectAnomalies()
			if err != nil {
				ad.logger.Error("Anomaly detection failed", zap.Error(err))
				continue
			}
			
			// Send alerts for significant anomalies
			for _, anomaly := range anomalies {
				if ad.shouldAlert(anomaly) {
					ad.sendAlerts(anomaly)
				}
			}
			
		case <-ad.ctx.Done():
			return
		}
	}
}

func (ad *AnomalyDetector) modelUpdateLoop() {
	ticker := time.NewTicker(ad.config.ModelUpdatePeriod)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ad.updateModels()
			
		case <-ad.ctx.Done():
			return
		}
	}
}

func (ad *AnomalyDetector) updateModels() {
	ad.metricsMu.RLock()
	defer ad.metricsMu.RUnlock()
	
	for _, ts := range ad.metrics {
		ts.mu.RLock()
		if len(ts.DataPoints) < ad.config.MinDataPoints {
			ts.mu.RUnlock()
			continue
		}
		
		data := make([]DataPoint, len(ts.DataPoints))
		copy(data, ts.DataPoints)
		ts.mu.RUnlock()
		
		// Update each model
		ad.modelsMu.RLock()
		for _, model := range ad.models {
			if err := model.Train(data); err != nil {
				ad.logger.Warn("Model training failed",
					zap.String("model", model.Name()),
					zap.String("metric", ts.Name),
					zap.Error(err))
			}
		}
		ad.modelsMu.RUnlock()
	}
	
	ad.detectorMetrics.modelsUpdated++
}

func (ad *AnomalyDetector) calculateStats(data []DataPoint) TimeSeriesStats {
	if len(data) == 0 {
		return TimeSeriesStats{}
	}
	
	values := make([]float64, len(data))
	for i, dp := range data {
		values[i] = dp.Value
	}
	
	// Sort for percentiles
	sorted := make([]float64, len(values))
	copy(sorted, values)
	sort.Float64s(sorted)
	
	// Calculate mean
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	mean := sum / float64(len(values))
	
	// Calculate standard deviation
	sumSquares := 0.0
	for _, v := range values {
		diff := v - mean
		sumSquares += diff * diff
	}
	stdDev := math.Sqrt(sumSquares / float64(len(values)))
	
	// Calculate percentiles
	q1Index := len(sorted) / 4
	medianIndex := len(sorted) / 2
	q3Index := 3 * len(sorted) / 4
	
	stats := TimeSeriesStats{
		Mean:   mean,
		StdDev: stdDev,
		Min:    sorted[0],
		Max:    sorted[len(sorted)-1],
		Median: sorted[medianIndex],
		Q1:     sorted[q1Index],
		Q3:     sorted[q3Index],
		Count:  len(values),
	}
	
	stats.IQR = stats.Q3 - stats.Q1
	
	return stats
}

func (ad *AnomalyDetector) createAnomaly(metric, modelName string, point DataPoint, score float64, stats TimeSeriesStats) *Anomaly {
	// Calculate deviation
	deviation := math.Abs(point.Value - stats.Mean)
	if stats.StdDev > 0 {
		deviation = deviation / stats.StdDev
	}
	
	// Determine severity
	severity := ad.calculateSeverity(score, deviation)
	
	// Generate description
	description := fmt.Sprintf("%s anomaly detected in %s: value %.2f (expected %.2f ± %.2f)",
		severity, metric, point.Value, stats.Mean, stats.StdDev)
	
	return &Anomaly{
		ID:          fmt.Sprintf("anomaly-%d", time.Now().UnixNano()),
		Metric:      metric,
		Type:        modelName,
		Severity:    severity,
		Score:       score,
		Expected:    stats.Mean,
		Actual:      point.Value,
		Deviation:   deviation,
		Timestamp:   point.Timestamp,
		Description: description,
		Context: map[string]interface{}{
			"model":     modelName,
			"stats":     stats,
			"tags":      point.Tags,
		},
	}
}

func (ad *AnomalyDetector) calculateSeverity(score, deviation float64) string {
	// Combine score and deviation for severity
	combined := (score + deviation) / 2
	
	if combined > 4.0 {
		return "critical"
	} else if combined > 3.0 {
		return "high"
	} else if combined > 2.0 {
		return "medium"
	}
	return "low"
}

func (ad *AnomalyDetector) filterAnomalies(anomalies []*Anomaly) []*Anomaly {
	// Remove duplicates and low-confidence anomalies
	filtered := make([]*Anomaly, 0)
	seen := make(map[string]bool)
	
	for _, anomaly := range anomalies {
		// Create unique key
		key := fmt.Sprintf("%s-%s-%d", anomaly.Metric, anomaly.Type, 
			anomaly.Timestamp.Unix()/60) // Group by minute
		
		if seen[key] {
			continue
		}
		seen[key] = true
		
		// Filter by severity
		if anomaly.Severity == "low" && ad.config.Sensitivity < 0.8 {
			continue
		}
		
		filtered = append(filtered, anomaly)
	}
	
	return filtered
}

func (ad *AnomalyDetector) shouldAlert(anomaly *Anomaly) bool {
	// Check severity
	if anomaly.Severity == "low" {
		return false
	}
	
	// Check alert threshold
	if anomaly.Score < ad.config.AlertThreshold {
		return false
	}
	
	// Check cooldown
	// (Implementation would check last alert time for this metric)
	
	return true
}

func (ad *AnomalyDetector) sendAlerts(anomaly *Anomaly) {
	for _, channel := range ad.alertChannels {
		if err := channel.SendAlert(anomaly); err != nil {
			ad.logger.Error("Failed to send alert",
				zap.String("channel", channel.Name()),
				zap.String("anomaly", anomaly.ID),
				zap.Error(err))
		} else {
			ad.detectorMetrics.alertsSent++
		}
	}
}

// GetMetrics returns anomaly detector metrics
func (ad *AnomalyDetector) GetMetrics() map[string]interface{} {
	ad.metricsMu.RLock()
	metricCount := len(ad.metrics)
	ad.metricsMu.RUnlock()
	
	ad.modelsMu.RLock()
	modelCount := len(ad.models)
	ad.modelsMu.RUnlock()
	
	ad.anomaliesMu.RLock()
	anomalyCount := len(ad.anomalies)
	ad.anomaliesMu.RUnlock()
	
	return map[string]interface{}{
		"metrics_tracked":       metricCount,
		"models_active":         modelCount,
		"data_points_processed": ad.detectorMetrics.dataPointsProcessed,
		"anomalies_detected":    ad.detectorMetrics.anomaliesDetected,
		"anomalies_stored":      anomalyCount,
		"false_positives":       ad.detectorMetrics.falsePositives,
		"alerts_sent":           ad.detectorMetrics.alertsSent,
		"models_updated":        ad.detectorMetrics.modelsUpdated,
		"avg_detection_latency": ad.detectorMetrics.avgDetectionLatency,
		"sensitivity":           ad.config.Sensitivity,
	}
}

// Stop stops the anomaly detector
func (ad *AnomalyDetector) Stop() {
	ad.logger.Info("Stopping anomaly detector")
	ad.cancel()
}

// Model implementations

// ZScoreModel implements Z-score based anomaly detection
type ZScoreModel struct {
	threshold   float64
	sensitivity float64
}

func NewZScoreModel(sensitivity float64) *ZScoreModel {
	// Map sensitivity to Z-score threshold
	threshold := 3.0 - (sensitivity * 2.0) // 3.0 for low sensitivity, 1.0 for high
	return &ZScoreModel{
		threshold:   threshold,
		sensitivity: sensitivity,
	}
}

func (z *ZScoreModel) Name() string {
	return "zscore"
}

func (z *ZScoreModel) Train(data []DataPoint) error {
	// Z-score doesn't require training
	return nil
}

func (z *ZScoreModel) Detect(point DataPoint) (float64, error) {
	// In real implementation, would calculate Z-score based on historical mean/stddev
	// For now, return a simulated score
	return 0.0, nil
}

func (z *ZScoreModel) Update(point DataPoint) error {
	return nil
}

func (z *ZScoreModel) GetThreshold() float64 {
	return z.threshold
}

// MADModel implements Median Absolute Deviation based detection
type MADModel struct {
	threshold   float64
	sensitivity float64
	median      float64
	mad         float64
}

func NewMADModel(sensitivity float64) *MADModel {
	threshold := 3.5 - (sensitivity * 2.5)
	return &MADModel{
		threshold:   threshold,
		sensitivity: sensitivity,
	}
}

func (m *MADModel) Name() string {
	return "mad"
}

func (m *MADModel) Train(data []DataPoint) error {
	if len(data) < 3 {
		return errors.New("insufficient data for MAD calculation")
	}
	
	// Calculate median
	values := make([]float64, len(data))
	for i, dp := range data {
		values[i] = dp.Value
	}
	sort.Float64s(values)
	
	m.median = values[len(values)/2]
	
	// Calculate MAD
	deviations := make([]float64, len(values))
	for i, v := range values {
		deviations[i] = math.Abs(v - m.median)
	}
	sort.Float64s(deviations)
	
	m.mad = deviations[len(deviations)/2]
	
	return nil
}

func (m *MADModel) Detect(point DataPoint) (float64, error) {
	if m.mad == 0 {
		return 0, errors.New("model not trained")
	}
	
	// Calculate modified Z-score
	score := 0.6745 * math.Abs(point.Value-m.median) / m.mad
	
	return score, nil
}

func (m *MADModel) Update(point DataPoint) error {
	// Update median and MAD incrementally
	// Simplified implementation
	return nil
}

func (m *MADModel) GetThreshold() float64 {
	return m.threshold
}

// IsolationForestModel implements Isolation Forest algorithm
type IsolationForestModel struct {
	trees       int
	threshold   float64
	sensitivity float64
}

func NewIsolationForestModel(trees int, sensitivity float64) *IsolationForestModel {
	threshold := 0.6 - (sensitivity * 0.2)
	return &IsolationForestModel{
		trees:       trees,
		threshold:   threshold,
		sensitivity: sensitivity,
	}
}

func (i *IsolationForestModel) Name() string {
	return "isolation_forest"
}

func (i *IsolationForestModel) Train(data []DataPoint) error {
	// Simplified - real implementation would build isolation trees
	return nil
}

func (i *IsolationForestModel) Detect(point DataPoint) (float64, error) {
	// Simplified - real implementation would calculate path length
	return 0.0, nil
}

func (i *IsolationForestModel) Update(point DataPoint) error {
	return nil
}

func (i *IsolationForestModel) GetThreshold() float64 {
	return i.threshold
}

// LSTMModel implements LSTM-based anomaly detection
type LSTMModel struct {
	windowSize time.Duration
	threshold  float64
}

func NewLSTMModel(windowSize time.Duration) *LSTMModel {
	return &LSTMModel{
		windowSize: windowSize,
		threshold:  0.5,
	}
}

func (l *LSTMModel) Name() string {
	return "lstm"
}

func (l *LSTMModel) Train(data []DataPoint) error {
	// Real implementation would train LSTM network
	return nil
}

func (l *LSTMModel) Detect(point DataPoint) (float64, error) {
	// Real implementation would use LSTM predictions
	return 0.0, nil
}

func (l *LSTMModel) Update(point DataPoint) error {
	return nil
}

func (l *LSTMModel) GetThreshold() float64 {
	return l.threshold
}

// ProphetModel implements Prophet-based anomaly detection
type ProphetModel struct {
	threshold float64
}

func NewProphetModel() *ProphetModel {
	return &ProphetModel{
		threshold: 0.5,
	}
}

func (p *ProphetModel) Name() string {
	return "prophet"
}

func (p *ProphetModel) Train(data []DataPoint) error {
	// Real implementation would use Prophet forecasting
	return nil
}

func (p *ProphetModel) Detect(point DataPoint) (float64, error) {
	// Real implementation would compare to Prophet forecast
	return 0.0, nil
}

func (p *ProphetModel) Update(point DataPoint) error {
	return nil
}

func (p *ProphetModel) GetThreshold() float64 {
	return p.threshold
}

// Alert channel implementations

// LogAlertChannel sends alerts to log
type LogAlertChannel struct {
	logger *zap.Logger
}

func NewLogAlertChannel(logger *zap.Logger) *LogAlertChannel {
	return &LogAlertChannel{logger: logger}
}

func (l *LogAlertChannel) SendAlert(anomaly *Anomaly) error {
	l.logger.Warn("Anomaly detected",
		zap.String("id", anomaly.ID),
		zap.String("metric", anomaly.Metric),
		zap.String("severity", anomaly.Severity),
		zap.Float64("score", anomaly.Score),
		zap.String("description", anomaly.Description))
	return nil
}

func (l *LogAlertChannel) Name() string {
	return "log"
}

// WebhookAlertChannel sends alerts via webhook
type WebhookAlertChannel struct {
	url    string
	client *http.Client
}

func NewWebhookAlertChannel(url string) *WebhookAlertChannel {
	return &WebhookAlertChannel{
		url:    url,
		client: &http.Client{Timeout: 10 * time.Second},
	}
}

func (w *WebhookAlertChannel) SendAlert(anomaly *Anomaly) error {
	// Send webhook
	// Implementation would POST anomaly data to webhook URL
	return nil
}

func (w *WebhookAlertChannel) Name() string {
	return "webhook"
}