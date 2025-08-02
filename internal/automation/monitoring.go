package automation

import (
	"context"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MonitoringSystem provides comprehensive monitoring and alerting
type MonitoringSystem struct {
	logger *zap.Logger
	config *MonitoringConfig
	
	// Metrics collection
	collectors    map[string]MetricCollector
	collectorsMu  sync.RWMutex
	
	// Alert management
	alerts        map[string]*Alert
	alertsMu      sync.RWMutex
	alertHandlers []AlertHandler
	
	// Time series data
	metrics       *MetricsStore
	
	// Anomaly detection
	anomalyDetector *AnomalyDetector
	
	// Status
	running       atomic.Bool
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
}

// MonitoringConfig contains monitoring configuration
type MonitoringConfig struct {
	// Collection settings
	CollectionInterval time.Duration `yaml:"collection_interval"`
	RetentionPeriod    time.Duration `yaml:"retention_period"`
	
	// Alert settings
	AlertRules        []AlertRule     `yaml:"alert_rules"`
	AlertCooldown     time.Duration   `yaml:"alert_cooldown"`
	
	// Anomaly detection
	AnomalyDetection  bool            `yaml:"anomaly_detection"`
	AnomalyThreshold  float64         `yaml:"anomaly_threshold"`
	
	// Export settings
	PrometheusEnabled bool            `yaml:"prometheus_enabled"`
	PrometheusPort    int             `yaml:"prometheus_port"`
	
	// Notification channels
	EmailEnabled      bool            `yaml:"email_enabled"`
	SlackEnabled      bool            `yaml:"slack_enabled"`
	WebhookEnabled    bool            `yaml:"webhook_enabled"`
	WebhookURL        string          `yaml:"webhook_url"`
}

// MetricCollector collects metrics
type MetricCollector interface {
	Collect(ctx context.Context) ([]Metric, error)
	Name() string
}

// Metric represents a single metric
type Metric struct {
	Name      string
	Value     float64
	Labels    map[string]string
	Timestamp time.Time
}

// AlertRule defines an alert condition
type AlertRule struct {
	Name        string            `yaml:"name"`
	Metric      string            `yaml:"metric"`
	Condition   string            `yaml:"condition"`
	Threshold   float64           `yaml:"threshold"`
	Duration    time.Duration     `yaml:"duration"`
	Severity    AlertSeverity     `yaml:"severity"`
	Labels      map[string]string `yaml:"labels"`
	Annotations map[string]string `yaml:"annotations"`
}

// Alert represents an active alert
type Alert struct {
	Rule         AlertRule
	State        AlertState
	Value        float64
	StartsAt     time.Time
	EndsAt       time.Time
	LastNotified time.Time
	
	mu sync.RWMutex
}

// AlertState represents alert state
type AlertState string

const (
	AlertStatePending  AlertState = "pending"
	AlertStateFiring   AlertState = "firing"
	AlertStateResolved AlertState = "resolved"
)

// AlertSeverity represents alert severity
type AlertSeverity string

const (
	SeverityInfo     AlertSeverity = "info"
	SeverityWarning  AlertSeverity = "warning"
	SeverityCritical AlertSeverity = "critical"
)

// AlertHandler handles alert notifications
type AlertHandler interface {
	Handle(alert *Alert) error
}

// NewMonitoringSystem creates a new monitoring system
func NewMonitoringSystem(logger *zap.Logger, config *MonitoringConfig) *MonitoringSystem {
	ctx, cancel := context.WithCancel(context.Background())
	
	ms := &MonitoringSystem{
		logger:     logger,
		config:     config,
		collectors: make(map[string]MetricCollector),
		alerts:     make(map[string]*Alert),
		metrics:    NewMetricsStore(config.RetentionPeriod),
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Initialize anomaly detector
	if config.AnomalyDetection {
		ms.anomalyDetector = NewAnomalyDetector(logger, config.AnomalyThreshold)
	}
	
	// Initialize alert handlers
	ms.initializeAlertHandlers()
	
	// Register default collectors
	ms.registerDefaultCollectors()
	
	return ms
}

// Start starts the monitoring system
func (ms *MonitoringSystem) Start() error {
	if !ms.running.CompareAndSwap(false, true) {
		return fmt.Errorf("monitoring system already running")
	}
	
	ms.logger.Info("Starting monitoring system",
		zap.Duration("collection_interval", ms.config.CollectionInterval),
		zap.Int("alert_rules", len(ms.config.AlertRules)),
	)
	
	// Start collection loop
	ms.wg.Add(1)
	go ms.collectionLoop()
	
	// Start alert evaluation loop
	ms.wg.Add(1)
	go ms.alertLoop()
	
	// Start Prometheus exporter if enabled
	if ms.config.PrometheusEnabled {
		ms.wg.Add(1)
		go ms.startPrometheusExporter()
	}
	
	return nil
}

// Stop stops the monitoring system
func (ms *MonitoringSystem) Stop() error {
	if !ms.running.CompareAndSwap(true, false) {
		return fmt.Errorf("monitoring system not running")
	}
	
	ms.logger.Info("Stopping monitoring system")
	
	ms.cancel()
	ms.wg.Wait()
	
	return nil
}

// RegisterCollector registers a metric collector
func (ms *MonitoringSystem) RegisterCollector(collector MetricCollector) {
	ms.collectorsMu.Lock()
	defer ms.collectorsMu.Unlock()
	
	ms.collectors[collector.Name()] = collector
	ms.logger.Debug("Registered metric collector", zap.String("name", collector.Name()))
}

// collectionLoop runs metric collection
func (ms *MonitoringSystem) collectionLoop() {
	defer ms.wg.Done()
	
	ticker := time.NewTicker(ms.config.CollectionInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ms.ctx.Done():
			return
		case <-ticker.C:
			ms.collectMetrics()
		}
	}
}

// collectMetrics collects metrics from all collectors
func (ms *MonitoringSystem) collectMetrics() {
	ms.collectorsMu.RLock()
	collectors := make([]MetricCollector, 0, len(ms.collectors))
	for _, collector := range ms.collectors {
		collectors = append(collectors, collector)
	}
	ms.collectorsMu.RUnlock()
	
	// Collect metrics in parallel
	var wg sync.WaitGroup
	metricsCh := make(chan []Metric, len(collectors))
	
	for _, collector := range collectors {
		wg.Add(1)
		go func(c MetricCollector) {
			defer wg.Done()
			
			ctx, cancel := context.WithTimeout(ms.ctx, 5*time.Second)
			defer cancel()
			
			metrics, err := c.Collect(ctx)
			if err != nil {
				ms.logger.Error("Failed to collect metrics",
					zap.String("collector", c.Name()),
					zap.Error(err),
				)
				return
			}
			
			metricsCh <- metrics
		}(collector)
	}
	
	// Wait for collection to complete
	go func() {
		wg.Wait()
		close(metricsCh)
	}()
	
	// Store metrics
	for metrics := range metricsCh {
		for _, metric := range metrics {
			ms.metrics.Add(metric)
			
			// Check for anomalies
			if ms.anomalyDetector != nil {
				if ms.anomalyDetector.IsAnomaly(metric) {
					ms.createAnomalyAlert(metric)
				}
			}
		}
	}
}

// alertLoop evaluates alert rules
func (ms *MonitoringSystem) alertLoop() {
	defer ms.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ms.ctx.Done():
			return
		case <-ticker.C:
			ms.evaluateAlerts()
		}
	}
}

// evaluateAlerts evaluates all alert rules
func (ms *MonitoringSystem) evaluateAlerts() {
	for _, rule := range ms.config.AlertRules {
		ms.evaluateAlertRule(rule)
	}
	
	// Check for resolved alerts
	ms.alertsMu.Lock()
	for name, alert := range ms.alerts {
		alert.mu.RLock()
		state := alert.State
		alert.mu.RUnlock()
		
		if state == AlertStateFiring {
			// Re-evaluate to check if resolved
			if !ms.isConditionMet(alert.Rule) {
				ms.resolveAlert(name)
			}
		}
	}
	ms.alertsMu.Unlock()
}

// evaluateAlertRule evaluates a single alert rule
func (ms *MonitoringSystem) evaluateAlertRule(rule AlertRule) {
	// Get metric values
	values := ms.metrics.GetLatest(rule.Metric, rule.Duration)
	if len(values) == 0 {
		return
	}
	
	// Check condition
	if ms.isConditionMet(rule) {
		ms.handleAlertCondition(rule, values)
	}
}

// isConditionMet checks if alert condition is met
func (ms *MonitoringSystem) isConditionMet(rule AlertRule) bool {
	values := ms.metrics.GetLatest(rule.Metric, rule.Duration)
	if len(values) == 0 {
		return false
	}
	
	// Calculate aggregate based on condition
	var result float64
	switch rule.Condition {
	case "above":
		result = ms.calculateMax(values)
		return result > rule.Threshold
	case "below":
		result = ms.calculateMin(values)
		return result < rule.Threshold
	case "avg_above":
		result = ms.calculateAverage(values)
		return result > rule.Threshold
	case "avg_below":
		result = ms.calculateAverage(values)
		return result < rule.Threshold
	default:
		ms.logger.Warn("Unknown alert condition", zap.String("condition", rule.Condition))
		return false
	}
}

// handleAlertCondition handles alert condition
func (ms *MonitoringSystem) handleAlertCondition(rule AlertRule, values []Metric) {
	alertName := rule.Name
	
	ms.alertsMu.Lock()
	alert, exists := ms.alerts[alertName]
	ms.alertsMu.Unlock()
	
	if !exists {
		// Create new alert
		alert = &Alert{
			Rule:     rule,
			State:    AlertStatePending,
			Value:    ms.calculateAverage(values),
			StartsAt: time.Now(),
		}
		
		ms.alertsMu.Lock()
		ms.alerts[alertName] = alert
		ms.alertsMu.Unlock()
	}
	
	alert.mu.Lock()
	defer alert.mu.Unlock()
	
	// Update alert value
	alert.Value = ms.calculateAverage(values)
	
	// State transition
	switch alert.State {
	case AlertStatePending:
		// Check if duration requirement met
		if time.Since(alert.StartsAt) >= rule.Duration {
			alert.State = AlertStateFiring
			ms.notifyAlert(alert)
		}
	case AlertStateFiring:
		// Check for re-notification
		if time.Since(alert.LastNotified) >= ms.config.AlertCooldown {
			ms.notifyAlert(alert)
		}
	}
}

// resolveAlert resolves an alert
func (ms *MonitoringSystem) resolveAlert(alertName string) {
	ms.alertsMu.Lock()
	alert, exists := ms.alerts[alertName]
	ms.alertsMu.Unlock()
	
	if !exists {
		return
	}
	
	alert.mu.Lock()
	defer alert.mu.Unlock()
	
	if alert.State != AlertStateResolved {
		alert.State = AlertStateResolved
		alert.EndsAt = time.Now()
		ms.notifyAlert(alert)
		
		// Remove from active alerts after notification
		go func() {
			time.Sleep(5 * time.Minute)
			ms.alertsMu.Lock()
			delete(ms.alerts, alertName)
			ms.alertsMu.Unlock()
		}()
	}
}

// notifyAlert sends alert notifications
func (ms *MonitoringSystem) notifyAlert(alert *Alert) {
	alert.LastNotified = time.Now()
	
	for _, handler := range ms.alertHandlers {
		go func(h AlertHandler) {
			if err := h.Handle(alert); err != nil {
				ms.logger.Error("Failed to handle alert",
					zap.String("alert", alert.Rule.Name),
					zap.Error(err),
				)
			}
		}(handler)
	}
}

// createAnomalyAlert creates alert for anomaly
func (ms *MonitoringSystem) createAnomalyAlert(metric Metric) {
	rule := AlertRule{
		Name:      fmt.Sprintf("anomaly_%s", metric.Name),
		Metric:    metric.Name,
		Condition: "anomaly",
		Threshold: metric.Value,
		Duration:  0,
		Severity:  SeverityWarning,
		Annotations: map[string]string{
			"description": fmt.Sprintf("Anomaly detected in %s", metric.Name),
		},
	}
	
	alert := &Alert{
		Rule:     rule,
		State:    AlertStateFiring,
		Value:    metric.Value,
		StartsAt: time.Now(),
	}
	
	ms.notifyAlert(alert)
}

// registerDefaultCollectors registers default metric collectors
func (ms *MonitoringSystem) registerDefaultCollectors() {
	// System metrics collector
	ms.RegisterCollector(&SystemMetricsCollector{logger: ms.logger})
	
	// Application metrics collector
	ms.RegisterCollector(&ApplicationMetricsCollector{logger: ms.logger})
	
	// Network metrics collector
	ms.RegisterCollector(&NetworkMetricsCollector{logger: ms.logger})
}

// initializeAlertHandlers initializes alert handlers
func (ms *MonitoringSystem) initializeAlertHandlers() {
	// Log handler (always enabled)
	ms.alertHandlers = append(ms.alertHandlers, &LogAlertHandler{logger: ms.logger})
	
	// Email handler
	if ms.config.EmailEnabled {
		ms.alertHandlers = append(ms.alertHandlers, &EmailAlertHandler{logger: ms.logger})
	}
	
	// Slack handler
	if ms.config.SlackEnabled {
		ms.alertHandlers = append(ms.alertHandlers, &SlackAlertHandler{logger: ms.logger})
	}
	
	// Webhook handler
	if ms.config.WebhookEnabled {
		ms.alertHandlers = append(ms.alertHandlers, &WebhookAlertHandler{
			logger:     ms.logger,
			webhookURL: ms.config.WebhookURL,
		})
	}
}

// Helper functions

func (ms *MonitoringSystem) calculateAverage(metrics []Metric) float64 {
	if len(metrics) == 0 {
		return 0
	}
	
	sum := 0.0
	for _, m := range metrics {
		sum += m.Value
	}
	return sum / float64(len(metrics))
}

func (ms *MonitoringSystem) calculateMax(metrics []Metric) float64 {
	if len(metrics) == 0 {
		return 0
	}
	
	max := metrics[0].Value
	for _, m := range metrics[1:] {
		if m.Value > max {
			max = m.Value
		}
	}
	return max
}

func (ms *MonitoringSystem) calculateMin(metrics []Metric) float64 {
	if len(metrics) == 0 {
		return 0
	}
	
	min := metrics[0].Value
	for _, m := range metrics[1:] {
		if m.Value < min {
			min = m.Value
		}
	}
	return min
}

// MetricsStore stores time series metrics
type MetricsStore struct {
	data      map[string][]Metric
	mu        sync.RWMutex
	retention time.Duration
}

// NewMetricsStore creates a new metrics store
func NewMetricsStore(retention time.Duration) *MetricsStore {
	ms := &MetricsStore{
		data:      make(map[string][]Metric),
		retention: retention,
	}
	
	// Start cleanup goroutine
	go ms.cleanup()
	
	return ms
}

// Add adds a metric to the store
func (ms *MetricsStore) Add(metric Metric) {
	ms.mu.Lock()
	defer ms.mu.Unlock()
	
	ms.data[metric.Name] = append(ms.data[metric.Name], metric)
}

// GetLatest gets latest metrics within duration
func (ms *MetricsStore) GetLatest(name string, duration time.Duration) []Metric {
	ms.mu.RLock()
	defer ms.mu.RUnlock()
	
	metrics, exists := ms.data[name]
	if !exists {
		return nil
	}
	
	cutoff := time.Now().Add(-duration)
	var result []Metric
	
	for i := len(metrics) - 1; i >= 0; i-- {
		if metrics[i].Timestamp.Before(cutoff) {
			break
		}
		result = append(result, metrics[i])
	}
	
	return result
}

// cleanup removes old metrics
func (ms *MetricsStore) cleanup() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for range ticker.C {
		ms.mu.Lock()
		cutoff := time.Now().Add(-ms.retention)
		
		for name, metrics := range ms.data {
			var kept []Metric
			for _, m := range metrics {
				if m.Timestamp.After(cutoff) {
					kept = append(kept, m)
				}
			}
			
			if len(kept) > 0 {
				ms.data[name] = kept
			} else {
				delete(ms.data, name)
			}
		}
		ms.mu.Unlock()
	}
}

// AnomalyDetector detects anomalies in metrics
type AnomalyDetector struct {
	logger    *zap.Logger
	threshold float64
	history   map[string]*MetricHistory
	mu        sync.RWMutex
}

// MetricHistory tracks metric history for anomaly detection
type MetricHistory struct {
	values []float64
	mean   float64
	stddev float64
}

// NewAnomalyDetector creates a new anomaly detector
func NewAnomalyDetector(logger *zap.Logger, threshold float64) *AnomalyDetector {
	return &AnomalyDetector{
		logger:    logger,
		threshold: threshold,
		history:   make(map[string]*MetricHistory),
	}
}

// IsAnomaly checks if a metric is anomalous
func (ad *AnomalyDetector) IsAnomaly(metric Metric) bool {
	ad.mu.Lock()
	defer ad.mu.Unlock()
	
	history, exists := ad.history[metric.Name]
	if !exists {
		history = &MetricHistory{}
		ad.history[metric.Name] = history
	}
	
	// Add to history
	history.values = append(history.values, metric.Value)
	if len(history.values) > 100 {
		history.values = history.values[1:]
	}
	
	// Need enough data
	if len(history.values) < 10 {
		return false
	}
	
	// Calculate statistics
	history.updateStats()
	
	// Check if anomaly (z-score)
	if history.stddev == 0 {
		return false
	}
	
	zScore := math.Abs((metric.Value - history.mean) / history.stddev)
	return zScore > ad.threshold
}

// updateStats updates mean and stddev
func (mh *MetricHistory) updateStats() {
	// Calculate mean
	sum := 0.0
	for _, v := range mh.values {
		sum += v
	}
	mh.mean = sum / float64(len(mh.values))
	
	// Calculate stddev
	variance := 0.0
	for _, v := range mh.values {
		variance += math.Pow(v-mh.mean, 2)
	}
	mh.stddev = math.Sqrt(variance / float64(len(mh.values)))
}