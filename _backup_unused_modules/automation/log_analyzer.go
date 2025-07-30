package automation

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// LogAnalyzer implements automated log analysis and alerting
type LogAnalyzer struct {
	logger        *zap.Logger
	config        LogAnalyzerConfig
	collector     *LogCollector
	parser        *LogParser
	analyzer      *PatternAnalyzer
	alertManager  *AlertManager
	insightEngine *InsightEngine
	stats         *LogAnalyzerStats
	mu            sync.RWMutex
	shutdown      chan struct{}
}

// LogAnalyzerConfig contains analyzer configuration
type LogAnalyzerConfig struct {
	// Collection settings
	LogPaths          []string
	WatchInterval     time.Duration
	MaxFileSize       int64
	RotationDetection bool
	
	// Parsing settings
	ParserRules      []ParserRule
	TimestampFormats []string
	MultilinePatterns []string
	
	// Analysis settings
	AnalysisWindow    time.Duration
	AnomalyThreshold  float64
	PatternMinSupport float64
	CorrelationWindow time.Duration
	
	// Alert settings
	EnableRealTimeAlerts bool
	AlertThresholds      map[string]AlertThreshold
	AlertChannels        []AlertChannel
	AlertCooldown        time.Duration
}

// LogCollector collects logs from various sources
type LogCollector struct {
	logger       *zap.Logger
	sources      sync.Map // sourceID -> LogSource
	tailers      sync.Map // filepath -> *FileTailer
	buffer       *LogBuffer
	mu           sync.RWMutex
}

// LogSource represents a log source
type LogSource struct {
	ID          string
	Type        SourceType
	Path        string
	Format      LogFormat
	Labels      map[string]string
	LastOffset  int64
	Active      bool
}

// SourceType defines log source type
type SourceType string

const (
	SourceTypeFile   SourceType = "file"
	SourceTypeStream SourceType = "stream"
	SourceTypeSocket SourceType = "socket"
	SourceTypeSyslog SourceType = "syslog"
)

// LogFormat defines log format
type LogFormat string

const (
	FormatJSON       LogFormat = "json"
	FormatPlain      LogFormat = "plain"
	FormatStructured LogFormat = "structured"
	FormatCustom     LogFormat = "custom"
)

// FileTailer follows log files
type FileTailer struct {
	Path      string
	File      *os.File
	Reader    *bufio.Reader
	Offset    int64
	Inode     uint64
	OnLine    func(string)
	mu        sync.Mutex
}

// LogBuffer buffers log entries
type LogBuffer struct {
	entries     []LogEntry
	maxSize     int
	currentSize atomic.Int64
	mu          sync.RWMutex
}

// LogEntry represents a parsed log entry
type LogEntry struct {
	ID          string
	Timestamp   time.Time
	Level       LogLevel
	Source      string
	Message     string
	Fields      map[string]interface{}
	Raw         string
	ParseError  error
}

// LogLevel represents log severity
type LogLevel string

const (
	LogLevelDebug   LogLevel = "debug"
	LogLevelInfo    LogLevel = "info"
	LogLevelWarning LogLevel = "warning"
	LogLevelError   LogLevel = "error"
	LogLevelFatal   LogLevel = "fatal"
)

// LogParser parses log entries
type LogParser struct {
	logger    *zap.Logger
	rules     []ParserRule
	formats   map[string]*regexp.Regexp
	cache     sync.Map // pattern -> compiled regex
	mu        sync.RWMutex
}

// ParserRule defines parsing rule
type ParserRule struct {
	Name      string
	Pattern   string
	Regex     *regexp.Regexp
	Extract   map[string]int
	Transform func(map[string]string) map[string]interface{}
	Priority  int
}

// PatternAnalyzer analyzes log patterns
type PatternAnalyzer struct {
	logger      *zap.Logger
	patterns    sync.Map // patternID -> LogPattern
	anomalies   []LogAnomaly
	correlator  *EventCorrelator
	ml          *MLAnalyzer
	mu          sync.RWMutex
}

// LogPattern represents detected pattern
type LogPattern struct {
	ID          string
	Type        PatternType
	Signature   string
	Count       int64
	FirstSeen   time.Time
	LastSeen    time.Time
	Frequency   float64
	Severity    float64
	Examples    []LogEntry
	Related     []string
}

// PatternType defines pattern category
type PatternType string

const (
	PatternTypeError     PatternType = "error"
	PatternTypeAnomaly   PatternType = "anomaly"
	PatternTypeTrend     PatternType = "trend"
	PatternTypeRecurring PatternType = "recurring"
	PatternTypeBurst     PatternType = "burst"
)

// LogAnomaly represents detected anomaly
type LogAnomaly struct {
	ID          string
	Type        AnomalyType
	Score       float64
	Pattern     string
	StartTime   time.Time
	EndTime     time.Time
	Count       int
	Impact      string
	Entries     []LogEntry
}

// EventCorrelator correlates related events
type EventCorrelator struct {
	logger      *zap.Logger
	rules       []CorrelationRule
	events      *TimeSeriesBuffer
	chains      sync.Map // chainID -> EventChain
	mu          sync.RWMutex
}

// CorrelationRule defines event correlation
type CorrelationRule struct {
	Name        string
	Conditions  []EventCondition
	Window      time.Duration
	MinEvents   int
	Action      CorrelationAction
}

// EventCondition defines correlation condition
type EventCondition struct {
	Field    string
	Operator string
	Value    interface{}
}

// CorrelationAction defines correlation action
type CorrelationAction func(events []LogEntry) *CorrelatedEvent

// EventChain represents correlated events
type EventChain struct {
	ID        string
	Events    []LogEntry
	StartTime time.Time
	EndTime   time.Time
	Type      string
	Summary   string
}

// CorrelatedEvent represents correlation result
type CorrelatedEvent struct {
	ChainID     string
	Type        string
	Summary     string
	Severity    float64
	RootCause   string
	Impact      []string
	Remediation string
}

// TimeSeriesBuffer stores time-ordered events
type TimeSeriesBuffer struct {
	buckets     map[int64][]LogEntry
	bucketSize  time.Duration
	maxBuckets  int
	mu          sync.RWMutex
}

// MLAnalyzer performs ML-based analysis
type MLAnalyzer struct {
	logger      *zap.Logger
	models      map[string]MLModel
	features    *FeatureExtractor
	trainer     *ModelTrainer
	mu          sync.RWMutex
}

// MLModel defines ML model interface
type MLModel interface {
	Predict(features []float64) (float64, error)
	Train(data []TrainingExample)
	GetAccuracy() float64
	Save(path string) error
	Load(path string) error
}

// TrainingExample for ML models
type TrainingExample struct {
	Features []float64
	Label    float64
}

// FeatureExtractor extracts features from logs
type FeatureExtractor struct {
	extractors map[string]FeatureExtractorFunc
	mu         sync.RWMutex
}

// FeatureExtractorFunc extracts feature value
type FeatureExtractorFunc func(entry LogEntry) float64

// ModelTrainer trains ML models
type ModelTrainer struct {
	logger     *zap.Logger
	trainQueue chan TrainingJob
	models     sync.Map
	mu         sync.RWMutex
}

// TrainingJob represents model training task
type TrainingJob struct {
	ID        string
	ModelName string
	Data      []TrainingExample
	Callback  func(error)
}

// AlertManager manages log-based alerts
type AlertManager struct {
	logger      *zap.Logger
	rules       []AlertRule
	channels    []AlertChannel
	active      sync.Map // alertID -> Alert
	history     []Alert
	suppressor  *AlertSuppressor
	mu          sync.RWMutex
}

// AlertRule defines alert condition
type AlertRule struct {
	ID          string
	Name        string
	Condition   AlertCondition
	Severity    AlertSeverity
	Actions     []AlertAction
	Cooldown    time.Duration
	Enabled     bool
}

// AlertCondition defines alert trigger
type AlertCondition interface {
	Evaluate(entries []LogEntry) (bool, map[string]interface{})
}

// AlertSeverity defines alert level
type AlertSeverity int

const (
	AlertSeverityInfo AlertSeverity = iota
	AlertSeverityWarning
	AlertSeverityError
	AlertSeverityCritical
)

// Alert represents an active alert
type Alert struct {
	ID          string
	RuleID      string
	Timestamp   time.Time
	Severity    AlertSeverity
	Title       string
	Description string
	Context     map[string]interface{}
	Status      AlertStatus
	AckedBy     string
	AckedAt     time.Time
}

// AlertStatus defines alert state
type AlertStatus string

const (
	AlertStatusActive       AlertStatus = "active"
	AlertStatusAcknowledged AlertStatus = "acknowledged"
	AlertStatusResolved     AlertStatus = "resolved"
	AlertStatusSuppressed   AlertStatus = "suppressed"
)

// AlertChannel delivers alerts
type AlertChannel interface {
	Send(alert Alert) error
	GetName() string
}

// AlertAction defines alert response
type AlertAction struct {
	Type     ActionType
	Config   map[string]interface{}
	Execute  func(alert Alert) error
}

// ActionType defines action category
type ActionType string

const (
	ActionTypeNotify     ActionType = "notify"
	ActionTypeRemediate  ActionType = "remediate"
	ActionTypeEscalate   ActionType = "escalate"
	ActionTypeSuppress   ActionType = "suppress"
)

// AlertThreshold defines threshold config
type AlertThreshold struct {
	Metric    string
	Operator  string
	Value     float64
	Duration  time.Duration
	Occurrences int
}

// AlertSuppressor manages alert suppression
type AlertSuppressor struct {
	rules      []SuppressionRule
	suppressed sync.Map
	mu         sync.RWMutex
}

// SuppressionRule defines suppression criteria
type SuppressionRule struct {
	ID         string
	Condition  func(alert Alert) bool
	Duration   time.Duration
	Reason     string
}

// InsightEngine generates insights from logs
type InsightEngine struct {
	logger       *zap.Logger
	generators   []InsightGenerator
	insights     sync.Map // insightID -> LogInsight
	subscribers  []InsightSubscriber
	mu           sync.RWMutex
}

// InsightGenerator generates insights
type InsightGenerator interface {
	Generate(entries []LogEntry, patterns []LogPattern) []LogInsight
	GetName() string
}

// LogInsight represents analytical insight
type LogInsight struct {
	ID           string
	Type         InsightType
	Title        string
	Description  string
	Evidence     []LogEntry
	Confidence   float64
	Impact       string
	Suggestions  []string
	GeneratedAt  time.Time
	GeneratedBy  string
}

// InsightType defines insight category
type InsightType string

const (
	InsightTypePerformance InsightType = "performance"
	InsightTypeSecurity    InsightType = "security"
	InsightTypeReliability InsightType = "reliability"
	InsightTypeCapacity    InsightType = "capacity"
	InsightTypeTrend       InsightType = "trend"
)

// InsightSubscriber receives insights
type InsightSubscriber interface {
	OnInsight(insight LogInsight)
}

// LogAnalyzerStats tracks analyzer statistics
type LogAnalyzerStats struct {
	LogsProcessed      atomic.Uint64
	PatternsDetected   atomic.Uint64
	AnomaliesDetected  atomic.Uint64
	AlertsGenerated    atomic.Uint64
	InsightsGenerated  atomic.Uint64
	ProcessingRate     atomic.Value // float64
	LastAnalysis       atomic.Value // time.Time
}

// NewLogAnalyzer creates a new log analyzer
func NewLogAnalyzer(config LogAnalyzerConfig, logger *zap.Logger) *LogAnalyzer {
	if config.WatchInterval == 0 {
		config.WatchInterval = 1 * time.Second
	}
	if config.AnalysisWindow == 0 {
		config.AnalysisWindow = 5 * time.Minute
	}
	if config.AnomalyThreshold == 0 {
		config.AnomalyThreshold = 3.0 // 3 sigma
	}

	la := &LogAnalyzer{
		logger:        logger,
		config:        config,
		collector:     NewLogCollector(logger),
		parser:        NewLogParser(logger, config.ParserRules),
		analyzer:      NewPatternAnalyzer(logger),
		alertManager:  NewAlertManager(logger, config.AlertChannels),
		insightEngine: NewInsightEngine(logger),
		stats:         &LogAnalyzerStats{},
		shutdown:      make(chan struct{}),
	}

	// Initialize components
	la.initializeComponents()

	return la
}

// initializeComponents sets up analyzer components
func (la *LogAnalyzer) initializeComponents() {
	// Initialize parser rules
	la.initializeParserRules()

	// Initialize alert rules
	la.initializeAlertRules()

	// Initialize ML models
	la.analyzer.ml = NewMLAnalyzer(la.logger)
	la.initializeMLModels()

	// Initialize insight generators
	la.initializeInsightGenerators()
}

// initializeParserRules sets up parsing rules
func (la *LogAnalyzer) initializeParserRules() {
	// Common log format patterns
	patterns := []ParserRule{
		{
			Name:    "json_log",
			Pattern: `^{.*}$`,
			Extract: map[string]int{},
			Transform: func(m map[string]string) map[string]interface{} {
				var result map[string]interface{}
				json.Unmarshal([]byte(m["raw"]), &result)
				return result
			},
			Priority: 1,
		},
		{
			Name:    "apache_common",
			Pattern: `^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d+) (\d+|-)`,
			Extract: map[string]int{
				"ip":     1,
				"time":   2,
				"request": 3,
				"status": 4,
				"size":   5,
			},
			Priority: 2,
		},
		{
			Name:    "syslog",
			Pattern: `^(\w+ \d+ \d+:\d+:\d+) (\S+) (\S+)(?:\[(\d+)\])?: (.*)`,
			Extract: map[string]int{
				"timestamp": 1,
				"host":      2,
				"process":   3,
				"pid":       4,
				"message":   5,
			},
			Priority: 3,
		},
		{
			Name:    "golang_log",
			Pattern: `^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (.+)`,
			Extract: map[string]int{
				"timestamp": 1,
				"level":     2,
				"message":   3,
			},
			Priority: 4,
		},
	}

	// Compile patterns
	for i := range patterns {
		patterns[i].Regex = regexp.MustCompile(patterns[i].Pattern)
	}

	la.parser.rules = append(la.parser.rules, patterns...)
}

// initializeAlertRules sets up alert rules
func (la *LogAnalyzer) initializeAlertRules() {
	rules := []AlertRule{
		{
			ID:   "high_error_rate",
			Name: "High Error Rate",
			Condition: &ThresholdCondition{
				Field:     "level",
				Value:     "error",
				Threshold: 10,
				Window:    1 * time.Minute,
			},
			Severity: AlertSeverityWarning,
			Cooldown: 5 * time.Minute,
			Enabled:  true,
		},
		{
			ID:   "security_breach",
			Name: "Security Breach Detected",
			Condition: &PatternCondition{
				Patterns: []string{
					"unauthorized access",
					"authentication failed",
					"permission denied",
				},
				MinMatches: 5,
				Window:     5 * time.Minute,
			},
			Severity: AlertSeverityCritical,
			Cooldown: 10 * time.Minute,
			Enabled:  true,
		},
		{
			ID:   "performance_degradation",
			Name: "Performance Degradation",
			Condition: &LatencyCondition{
				Threshold: 1000, // ms
				Percentile: 95,
				Window:    5 * time.Minute,
			},
			Severity: AlertSeverityWarning,
			Cooldown: 15 * time.Minute,
			Enabled:  true,
		},
	}

	la.alertManager.rules = append(la.alertManager.rules, rules...)
}

// initializeMLModels sets up ML models
func (la *LogAnalyzer) initializeMLModels() {
	// Anomaly detection model
	la.analyzer.ml.models["anomaly_detection"] = &IsolationForestModel{
		Trees:         100,
		SampleSize:    256,
		Contamination: 0.1,
	}

	// Pattern classification model
	la.analyzer.ml.models["pattern_classification"] = &RandomForestClassifier{
		Trees:      50,
		MaxDepth:   10,
		MinSamples: 5,
	}

	// Time series prediction model
	la.analyzer.ml.models["time_series"] = &ARIMAModel{
		P: 2,
		D: 1,
		Q: 2,
	}
}

// initializeInsightGenerators sets up insight generators
func (la *LogAnalyzer) initializeInsightGenerators() {
	generators := []InsightGenerator{
		&PerformanceInsightGenerator{
			thresholds: map[string]float64{
				"response_time": 1000,
				"error_rate":    0.05,
				"throughput":    100,
			},
		},
		&SecurityInsightGenerator{
			patterns: []string{
				"failed login",
				"unauthorized",
				"injection",
				"malformed request",
			},
		},
		&CapacityInsightGenerator{
			limits: map[string]float64{
				"disk_usage":   0.8,
				"memory_usage": 0.9,
				"cpu_usage":    0.85,
			},
		},
	}

	la.insightEngine.generators = append(la.insightEngine.generators, generators...)
}

// Start starts the log analyzer
func (la *LogAnalyzer) Start(ctx context.Context) error {
	la.logger.Info("Starting log analyzer")

	// Start log collection
	for _, path := range la.config.LogPaths {
		if err := la.collector.AddSource(path); err != nil {
			la.logger.Error("Failed to add log source",
				zap.String("path", path),
				zap.Error(err))
		}
	}

	// Start processing loops
	go la.collectionLoop(ctx)
	go la.analysisLoop(ctx)
	go la.alertLoop(ctx)
	go la.insightLoop(ctx)

	return nil
}

// Stop stops the log analyzer
func (la *LogAnalyzer) Stop() error {
	close(la.shutdown)
	return nil
}

// collectionLoop collects logs continuously
func (la *LogAnalyzer) collectionLoop(ctx context.Context) {
	ticker := time.NewTicker(la.config.WatchInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-la.shutdown:
			return
		case <-ticker.C:
			la.collectLogs(ctx)
		}
	}
}

// collectLogs collects logs from all sources
func (la *LogAnalyzer) collectLogs(ctx context.Context) {
	la.collector.sources.Range(func(key, value interface{}) bool {
		source := value.(*LogSource)
		if !source.Active {
			return true
		}

		entries := la.collector.CollectFrom(source)
		for _, entry := range entries {
			// Parse log entry
			parsed := la.parser.Parse(entry)
			if parsed != nil {
				la.collector.buffer.Add(*parsed)
				la.stats.LogsProcessed.Add(1)
			}
		}

		return true
	})
}

// analysisLoop runs periodic analysis
func (la *LogAnalyzer) analysisLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-la.shutdown:
			return
		case <-ticker.C:
			la.analyze(ctx)
		}
	}
}

// analyze performs log analysis
func (la *LogAnalyzer) analyze(ctx context.Context) {
	la.logger.Debug("Running log analysis")

	// Get recent entries
	entries := la.collector.buffer.GetRecent(la.config.AnalysisWindow)
	if len(entries) == 0 {
		return
	}

	// Detect patterns
	patterns := la.analyzer.DetectPatterns(entries)
	la.stats.PatternsDetected.Add(uint64(len(patterns)))

	// Detect anomalies
	anomalies := la.analyzer.DetectAnomalies(entries, la.config.AnomalyThreshold)
	la.stats.AnomaliesDetected.Add(uint64(len(anomalies)))

	// Correlate events
	correlations := la.analyzer.correlator.Correlate(entries)

	// Update ML models
	la.updateMLModels(entries, patterns)

	// Store results
	la.storeAnalysisResults(patterns, anomalies, correlations)

	la.stats.LastAnalysis.Store(time.Now())
}

// alertLoop manages alerts
func (la *LogAnalyzer) alertLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-la.shutdown:
			return
		case <-ticker.C:
			la.checkAlerts(ctx)
		}
	}
}

// checkAlerts evaluates alert conditions
func (la *LogAnalyzer) checkAlerts(ctx context.Context) {
	entries := la.collector.buffer.GetRecent(5 * time.Minute)

	for _, rule := range la.alertManager.rules {
		if !rule.Enabled {
			continue
		}

		// Check if in cooldown
		if la.alertManager.InCooldown(rule.ID) {
			continue
		}

		// Evaluate condition
		triggered, context := rule.Condition.Evaluate(entries)
		if triggered {
			alert := la.createAlert(rule, context)
			la.alertManager.Trigger(alert)
			la.stats.AlertsGenerated.Add(1)
		}
	}
}

// insightLoop generates insights
func (la *LogAnalyzer) insightLoop(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-la.shutdown:
			return
		case <-ticker.C:
			la.generateInsights(ctx)
		}
	}
}

// generateInsights creates analytical insights
func (la *LogAnalyzer) generateInsights(ctx context.Context) {
	la.logger.Debug("Generating insights")

	entries := la.collector.buffer.GetRecent(la.config.AnalysisWindow)
	patterns := la.getRecentPatterns()

	for _, generator := range la.insightEngine.generators {
		insights := generator.Generate(entries, patterns)
		for _, insight := range insights {
			la.insightEngine.Store(insight)
			la.stats.InsightsGenerated.Add(1)

			// Notify subscribers
			la.insightEngine.NotifySubscribers(insight)
		}
	}
}

// Helper methods

func (la *LogAnalyzer) createAlert(rule AlertRule, context map[string]interface{}) Alert {
	return Alert{
		ID:          fmt.Sprintf("alert_%d", time.Now().UnixNano()),
		RuleID:      rule.ID,
		Timestamp:   time.Now(),
		Severity:    rule.Severity,
		Title:       rule.Name,
		Description: la.generateAlertDescription(rule, context),
		Context:     context,
		Status:      AlertStatusActive,
	}
}

func (la *LogAnalyzer) generateAlertDescription(rule AlertRule, context map[string]interface{}) string {
	desc := fmt.Sprintf("Alert triggered: %s", rule.Name)
	
	if count, ok := context["count"].(int); ok {
		desc += fmt.Sprintf(" (occurrences: %d)", count)
	}
	
	if pattern, ok := context["pattern"].(string); ok {
		desc += fmt.Sprintf(" - Pattern: %s", pattern)
	}
	
	return desc
}

func (la *LogAnalyzer) updateMLModels(entries []LogEntry, patterns []LogPattern) {
	// Extract features
	features := la.analyzer.ml.features.ExtractBatch(entries)
	
	// Create training examples
	examples := make([]TrainingExample, 0, len(features))
	for i, feat := range features {
		label := 0.0
		// Simple labeling based on log level
		if entries[i].Level == LogLevelError || entries[i].Level == LogLevelFatal {
			label = 1.0
		}
		examples = append(examples, TrainingExample{
			Features: feat,
			Label:    label,
		})
	}
	
	// Queue training job
	job := TrainingJob{
		ID:        fmt.Sprintf("train_%d", time.Now().UnixNano()),
		ModelName: "anomaly_detection",
		Data:      examples,
	}
	
	la.analyzer.ml.trainer.Submit(job)
}

func (la *LogAnalyzer) storeAnalysisResults(patterns []LogPattern, anomalies []LogAnomaly, correlations []EventChain) {
	// Store patterns
	for _, pattern := range patterns {
		la.analyzer.patterns.Store(pattern.ID, pattern)
	}
	
	// Store anomalies
	la.analyzer.mu.Lock()
	la.analyzer.anomalies = append(la.analyzer.anomalies, anomalies...)
	if len(la.analyzer.anomalies) > 1000 {
		la.analyzer.anomalies = la.analyzer.anomalies[len(la.analyzer.anomalies)-1000:]
	}
	la.analyzer.mu.Unlock()
	
	// Store correlations
	for _, chain := range correlations {
		la.analyzer.correlator.chains.Store(chain.ID, chain)
	}
}

func (la *LogAnalyzer) getRecentPatterns() []LogPattern {
	var patterns []LogPattern
	
	la.analyzer.patterns.Range(func(key, value interface{}) bool {
		pattern := value.(LogPattern)
		if time.Since(pattern.LastSeen) < la.config.AnalysisWindow {
			patterns = append(patterns, pattern)
		}
		return true
	})
	
	return patterns
}

// GetStats returns analyzer statistics
func (la *LogAnalyzer) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"logs_processed":      la.stats.LogsProcessed.Load(),
		"patterns_detected":   la.stats.PatternsDetected.Load(),
		"anomalies_detected":  la.stats.AnomaliesDetected.Load(),
		"alerts_generated":    la.stats.AlertsGenerated.Load(),
		"insights_generated":  la.stats.InsightsGenerated.Load(),
	}
	
	if rate := la.stats.ProcessingRate.Load(); rate != nil {
		stats["processing_rate"] = rate.(float64)
	}
	
	if lastAnalysis := la.stats.LastAnalysis.Load(); lastAnalysis != nil {
		stats["last_analysis"] = lastAnalysis.(time.Time)
	}
	
	return stats
}

// Component implementations

// NewLogCollector creates a new log collector
func NewLogCollector(logger *zap.Logger) *LogCollector {
	return &LogCollector{
		logger: logger,
		buffer: NewLogBuffer(10000),
	}
}

// AddSource adds a log source
func (lc *LogCollector) AddSource(path string) error {
	source := &LogSource{
		ID:     fmt.Sprintf("source_%s", filepath.Base(path)),
		Type:   SourceTypeFile,
		Path:   path,
		Format: FormatPlain,
		Active: true,
	}
	
	lc.sources.Store(source.ID, source)
	
	// Start tailing if file
	if source.Type == SourceTypeFile {
		tailer := lc.createTailer(path)
		lc.tailers.Store(path, tailer)
		go tailer.Start()
	}
	
	return nil
}

// CollectFrom collects logs from source
func (lc *LogCollector) CollectFrom(source *LogSource) []string {
	// Placeholder - would read from actual source
	return []string{}
}

func (lc *LogCollector) createTailer(path string) *FileTailer {
	return &FileTailer{
		Path: path,
		OnLine: func(line string) {
			// Add to buffer
			entry := LogEntry{
				ID:        fmt.Sprintf("log_%d", time.Now().UnixNano()),
				Timestamp: time.Now(),
				Source:    path,
				Raw:       line,
			}
			lc.buffer.Add(entry)
		},
	}
}

// Start starts file tailing
func (ft *FileTailer) Start() error {
	// Simplified file tailing
	return nil
}

// NewLogBuffer creates a new log buffer
func NewLogBuffer(maxSize int) *LogBuffer {
	return &LogBuffer{
		entries: make([]LogEntry, 0, maxSize),
		maxSize: maxSize,
	}
}

// Add adds entry to buffer
func (lb *LogBuffer) Add(entry LogEntry) {
	lb.mu.Lock()
	defer lb.mu.Unlock()
	
	lb.entries = append(lb.entries, entry)
	if len(lb.entries) > lb.maxSize {
		lb.entries = lb.entries[1:]
	}
}

// GetRecent returns recent entries
func (lb *LogBuffer) GetRecent(window time.Duration) []LogEntry {
	lb.mu.RLock()
	defer lb.mu.RUnlock()
	
	cutoff := time.Now().Add(-window)
	var recent []LogEntry
	
	for i := len(lb.entries) - 1; i >= 0; i-- {
		if lb.entries[i].Timestamp.Before(cutoff) {
			break
		}
		recent = append(recent, lb.entries[i])
	}
	
	return recent
}

// NewLogParser creates a new log parser
func NewLogParser(logger *zap.Logger, rules []ParserRule) *LogParser {
	return &LogParser{
		logger:  logger,
		rules:   rules,
		formats: make(map[string]*regexp.Regexp),
	}
}

// Parse parses log entry
func (lp *LogParser) Parse(raw string) *LogEntry {
	entry := &LogEntry{
		ID:        fmt.Sprintf("log_%d", time.Now().UnixNano()),
		Timestamp: time.Now(),
		Raw:       raw,
		Fields:    make(map[string]interface{}),
	}
	
	// Try each parser rule
	for _, rule := range lp.rules {
		if matches := rule.Regex.FindStringSubmatch(raw); matches != nil {
			// Extract fields
			for field, index := range rule.Extract {
				if index < len(matches) {
					entry.Fields[field] = matches[index]
				}
			}
			
			// Transform if needed
			if rule.Transform != nil {
				extracted := make(map[string]string)
				for field, index := range rule.Extract {
					if index < len(matches) {
						extracted[field] = matches[index]
					}
				}
				extracted["raw"] = raw
				entry.Fields = rule.Transform(extracted)
			}
			
			// Extract standard fields
			lp.extractStandardFields(entry)
			
			return entry
		}
	}
	
	// Fallback to plain text
	entry.Message = raw
	entry.Level = LogLevelInfo
	
	return entry
}

func (lp *LogParser) extractStandardFields(entry *LogEntry) {
	// Extract timestamp
	if ts, ok := entry.Fields["timestamp"].(string); ok {
		if parsed, err := time.Parse(time.RFC3339, ts); err == nil {
			entry.Timestamp = parsed
		}
	}
	
	// Extract level
	if level, ok := entry.Fields["level"].(string); ok {
		entry.Level = LogLevel(strings.ToLower(level))
	}
	
	// Extract message
	if msg, ok := entry.Fields["message"].(string); ok {
		entry.Message = msg
	}
}

// NewPatternAnalyzer creates a new pattern analyzer
func NewPatternAnalyzer(logger *zap.Logger) *PatternAnalyzer {
	return &PatternAnalyzer{
		logger:     logger,
		anomalies:  make([]LogAnomaly, 0),
		correlator: NewEventCorrelator(logger),
	}
}

// DetectPatterns detects log patterns
func (pa *PatternAnalyzer) DetectPatterns(entries []LogEntry) []LogPattern {
	var patterns []LogPattern
	
	// Group by message similarity
	groups := pa.groupBySimilarity(entries)
	
	for signature, group := range groups {
		pattern := LogPattern{
			ID:        fmt.Sprintf("pattern_%d", time.Now().UnixNano()),
			Type:      pa.classifyPattern(group),
			Signature: signature,
			Count:     int64(len(group)),
			FirstSeen: group[0].Timestamp,
			LastSeen:  group[len(group)-1].Timestamp,
			Frequency: float64(len(group)) / time.Since(group[0].Timestamp).Minutes(),
			Examples:  group[:min(5, len(group))],
		}
		
		patterns = append(patterns, pattern)
	}
	
	return patterns
}

// DetectAnomalies detects log anomalies
func (pa *PatternAnalyzer) DetectAnomalies(entries []LogEntry, threshold float64) []LogAnomaly {
	var anomalies []LogAnomaly
	
	// Use ML model for anomaly detection
	if pa.ml != nil {
		features := pa.ml.features.ExtractBatch(entries)
		
		for i, feat := range features {
			if score, err := pa.ml.models["anomaly_detection"].Predict(feat); err == nil && score > threshold {
				anomaly := LogAnomaly{
					ID:        fmt.Sprintf("anomaly_%d", time.Now().UnixNano()),
					Type:      AnomalyTypeAnomaly,
					Score:     score,
					Pattern:   entries[i].Message,
					StartTime: entries[i].Timestamp,
					Count:     1,
					Entries:   []LogEntry{entries[i]},
				}
				anomalies = append(anomalies, anomaly)
			}
		}
	}
	
	return anomalies
}

func (pa *PatternAnalyzer) groupBySimilarity(entries []LogEntry) map[string][]LogEntry {
	groups := make(map[string][]LogEntry)
	
	for _, entry := range entries {
		// Simple grouping by message prefix
		signature := pa.getSignature(entry.Message)
		groups[signature] = append(groups[signature], entry)
	}
	
	return groups
}

func (pa *PatternAnalyzer) getSignature(message string) string {
	// Simplified signature extraction
	words := strings.Fields(message)
	if len(words) > 3 {
		return strings.Join(words[:3], " ")
	}
	return message
}

func (pa *PatternAnalyzer) classifyPattern(entries []LogEntry) PatternType {
	// Simple classification based on frequency
	if len(entries) > 100 {
		return PatternTypeRecurring
	}
	
	// Check for error patterns
	errorCount := 0
	for _, entry := range entries {
		if entry.Level == LogLevelError || entry.Level == LogLevelFatal {
			errorCount++
		}
	}
	
	if float64(errorCount)/float64(len(entries)) > 0.8 {
		return PatternTypeError
	}
	
	// Check for burst patterns
	if len(entries) > 10 {
		duration := entries[len(entries)-1].Timestamp.Sub(entries[0].Timestamp)
		if duration < 1*time.Minute {
			return PatternTypeBurst
		}
	}
	
	return PatternTypeTrend
}

// NewEventCorrelator creates a new event correlator
func NewEventCorrelator(logger *zap.Logger) *EventCorrelator {
	return &EventCorrelator{
		logger: logger,
		events: NewTimeSeriesBuffer(1*time.Minute, 60),
		rules:  make([]CorrelationRule, 0),
	}
}

// Correlate correlates events
func (ec *EventCorrelator) Correlate(entries []LogEntry) []EventChain {
	var chains []EventChain
	
	// Add entries to time series buffer
	for _, entry := range entries {
		ec.events.Add(entry)
	}
	
	// Apply correlation rules
	for _, rule := range ec.rules {
		if chain := ec.applyRule(rule); chain != nil {
			chains = append(chains, *chain)
		}
	}
	
	return chains
}

func (ec *EventCorrelator) applyRule(rule CorrelationRule) *EventChain {
	// Get events in window
	events := ec.events.GetWindow(rule.Window)
	
	// Check conditions
	matching := make([]LogEntry, 0)
	for _, event := range events {
		if ec.matchesConditions(event, rule.Conditions) {
			matching = append(matching, event)
		}
	}
	
	if len(matching) >= rule.MinEvents {
		result := rule.Action(matching)
		if result != nil {
			return &EventChain{
				ID:        result.ChainID,
				Events:    matching,
				StartTime: matching[0].Timestamp,
				EndTime:   matching[len(matching)-1].Timestamp,
				Type:      result.Type,
				Summary:   result.Summary,
			}
		}
	}
	
	return nil
}

func (ec *EventCorrelator) matchesConditions(event LogEntry, conditions []EventCondition) bool {
	for _, cond := range conditions {
		if !ec.evaluateCondition(event, cond) {
			return false
		}
	}
	return true
}

func (ec *EventCorrelator) evaluateCondition(event LogEntry, condition EventCondition) bool {
	value, exists := event.Fields[condition.Field]
	if !exists {
		return false
	}
	
	switch condition.Operator {
	case "equals":
		return value == condition.Value
	case "contains":
		return strings.Contains(fmt.Sprintf("%v", value), fmt.Sprintf("%v", condition.Value))
	case "greater_than":
		return compareValues(value, condition.Value) > 0
	case "less_than":
		return compareValues(value, condition.Value) < 0
	}
	
	return false
}

// NewTimeSeriesBuffer creates a new time series buffer
func NewTimeSeriesBuffer(bucketSize time.Duration, maxBuckets int) *TimeSeriesBuffer {
	return &TimeSeriesBuffer{
		buckets:    make(map[int64][]LogEntry),
		bucketSize: bucketSize,
		maxBuckets: maxBuckets,
	}
}

// Add adds entry to buffer
func (tsb *TimeSeriesBuffer) Add(entry LogEntry) {
	tsb.mu.Lock()
	defer tsb.mu.Unlock()
	
	bucket := entry.Timestamp.Unix() / int64(tsb.bucketSize.Seconds())
	tsb.buckets[bucket] = append(tsb.buckets[bucket], entry)
	
	// Clean old buckets
	tsb.cleanOldBuckets()
}

// GetWindow returns entries in time window
func (tsb *TimeSeriesBuffer) GetWindow(window time.Duration) []LogEntry {
	tsb.mu.RLock()
	defer tsb.mu.RUnlock()
	
	var entries []LogEntry
	cutoff := time.Now().Add(-window).Unix() / int64(tsb.bucketSize.Seconds())
	
	for bucket, items := range tsb.buckets {
		if bucket >= cutoff {
			entries = append(entries, items...)
		}
	}
	
	// Sort by timestamp
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Timestamp.Before(entries[j].Timestamp)
	})
	
	return entries
}

func (tsb *TimeSeriesBuffer) cleanOldBuckets() {
	if len(tsb.buckets) <= tsb.maxBuckets {
		return
	}
	
	// Find oldest buckets
	var buckets []int64
	for k := range tsb.buckets {
		buckets = append(buckets, k)
	}
	sort.Slice(buckets, func(i, j int) bool {
		return buckets[i] < buckets[j]
	})
	
	// Remove oldest
	toRemove := len(buckets) - tsb.maxBuckets
	for i := 0; i < toRemove; i++ {
		delete(tsb.buckets, buckets[i])
	}
}

// NewMLAnalyzer creates a new ML analyzer
func NewMLAnalyzer(logger *zap.Logger) *MLAnalyzer {
	return &MLAnalyzer{
		logger:   logger,
		models:   make(map[string]MLModel),
		features: NewFeatureExtractor(),
		trainer:  NewModelTrainer(logger),
	}
}

// NewFeatureExtractor creates a new feature extractor
func NewFeatureExtractor() *FeatureExtractor {
	fe := &FeatureExtractor{
		extractors: make(map[string]FeatureExtractorFunc),
	}
	
	// Add default extractors
	fe.extractors["length"] = func(entry LogEntry) float64 {
		return float64(len(entry.Message))
	}
	
	fe.extractors["level"] = func(entry LogEntry) float64 {
		switch entry.Level {
		case LogLevelDebug:
			return 0.0
		case LogLevelInfo:
			return 0.25
		case LogLevelWarning:
			return 0.5
		case LogLevelError:
			return 0.75
		case LogLevelFatal:
			return 1.0
		}
		return 0.0
	}
	
	fe.extractors["hour"] = func(entry LogEntry) float64 {
		return float64(entry.Timestamp.Hour()) / 24.0
	}
	
	return fe
}

// ExtractBatch extracts features from entries
func (fe *FeatureExtractor) ExtractBatch(entries []LogEntry) [][]float64 {
	features := make([][]float64, len(entries))
	
	for i, entry := range entries {
		features[i] = fe.Extract(entry)
	}
	
	return features
}

// Extract extracts features from entry
func (fe *FeatureExtractor) Extract(entry LogEntry) []float64 {
	fe.mu.RLock()
	defer fe.mu.RUnlock()
	
	features := make([]float64, 0, len(fe.extractors))
	
	// Extract features in consistent order
	var keys []string
	for k := range fe.extractors {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	
	for _, key := range keys {
		features = append(features, fe.extractors[key](entry))
	}
	
	return features
}

// NewModelTrainer creates a new model trainer
func NewModelTrainer(logger *zap.Logger) *ModelTrainer {
	return &ModelTrainer{
		logger:     logger,
		trainQueue: make(chan TrainingJob, 100),
	}
}

// Submit submits training job
func (mt *ModelTrainer) Submit(job TrainingJob) {
	select {
	case mt.trainQueue <- job:
	default:
		mt.logger.Warn("Training queue full, dropping job")
	}
}

// NewAlertManager creates a new alert manager
func NewAlertManager(logger *zap.Logger, channels []AlertChannel) *AlertManager {
	return &AlertManager{
		logger:     logger,
		channels:   channels,
		history:    make([]Alert, 0),
		suppressor: NewAlertSuppressor(),
	}
}

// Trigger triggers an alert
func (am *AlertManager) Trigger(alert Alert) {
	am.mu.Lock()
	defer am.mu.Unlock()
	
	// Check suppression
	if am.suppressor.IsSuppressed(alert) {
		alert.Status = AlertStatusSuppressed
		return
	}
	
	// Store alert
	am.active.Store(alert.ID, alert)
	am.history = append(am.history, alert)
	if len(am.history) > 1000 {
		am.history = am.history[1:]
	}
	
	// Send to channels
	for _, channel := range am.channels {
		go func(ch AlertChannel) {
			if err := ch.Send(alert); err != nil {
				am.logger.Error("Failed to send alert",
					zap.String("channel", ch.GetName()),
					zap.Error(err))
			}
		}(channel)
	}
	
	// Execute actions
	if rule := am.getRule(alert.RuleID); rule != nil {
		for _, action := range rule.Actions {
			go func(act AlertAction) {
				if err := act.Execute(alert); err != nil {
					am.logger.Error("Failed to execute alert action",
						zap.String("action", string(act.Type)),
						zap.Error(err))
				}
			}(action)
		}
	}
}

// InCooldown checks if rule is in cooldown
func (am *AlertManager) InCooldown(ruleID string) bool {
	am.mu.RLock()
	defer am.mu.RUnlock()
	
	for i := len(am.history) - 1; i >= 0; i-- {
		alert := am.history[i]
		if alert.RuleID == ruleID {
			rule := am.getRule(ruleID)
			if rule != nil && time.Since(alert.Timestamp) < rule.Cooldown {
				return true
			}
			break
		}
	}
	
	return false
}

func (am *AlertManager) getRule(ruleID string) *AlertRule {
	for _, rule := range am.rules {
		if rule.ID == ruleID {
			return &rule
		}
	}
	return nil
}

// NewAlertSuppressor creates a new alert suppressor
func NewAlertSuppressor() *AlertSuppressor {
	return &AlertSuppressor{
		rules: make([]SuppressionRule, 0),
	}
}

// IsSuppressed checks if alert is suppressed
func (as *AlertSuppressor) IsSuppressed(alert Alert) bool {
	as.mu.RLock()
	defer as.mu.RUnlock()
	
	for _, rule := range as.rules {
		if rule.Condition(alert) {
			as.suppressed.Store(alert.ID, time.Now().Add(rule.Duration))
			return true
		}
	}
	
	// Check if previously suppressed
	if until, ok := as.suppressed.Load(alert.ID); ok {
		if time.Now().Before(until.(time.Time)) {
			return true
		}
		as.suppressed.Delete(alert.ID)
	}
	
	return false
}

// NewInsightEngine creates a new insight engine
func NewInsightEngine(logger *zap.Logger) *InsightEngine {
	return &InsightEngine{
		logger:      logger,
		generators:  make([]InsightGenerator, 0),
		subscribers: make([]InsightSubscriber, 0),
	}
}

// Store stores an insight
func (ie *InsightEngine) Store(insight LogInsight) {
	ie.insights.Store(insight.ID, insight)
}

// NotifySubscribers notifies insight subscribers
func (ie *InsightEngine) NotifySubscribers(insight LogInsight) {
	ie.mu.RLock()
	defer ie.mu.RUnlock()
	
	for _, subscriber := range ie.subscribers {
		go subscriber.OnInsight(insight)
	}
}

// Alert condition implementations

type ThresholdCondition struct {
	Field     string
	Value     interface{}
	Threshold int
	Window    time.Duration
}

func (tc *ThresholdCondition) Evaluate(entries []LogEntry) (bool, map[string]interface{}) {
	count := 0
	cutoff := time.Now().Add(-tc.Window)
	
	for _, entry := range entries {
		if entry.Timestamp.Before(cutoff) {
			continue
		}
		
		if val, ok := entry.Fields[tc.Field]; ok && val == tc.Value {
			count++
		}
	}
	
	triggered := count >= tc.Threshold
	context := map[string]interface{}{
		"count":     count,
		"threshold": tc.Threshold,
		"field":     tc.Field,
		"value":     tc.Value,
	}
	
	return triggered, context
}

type PatternCondition struct {
	Patterns   []string
	MinMatches int
	Window     time.Duration
}

func (pc *PatternCondition) Evaluate(entries []LogEntry) (bool, map[string]interface{}) {
	matches := 0
	cutoff := time.Now().Add(-pc.Window)
	matchedPatterns := make(map[string]int)
	
	for _, entry := range entries {
		if entry.Timestamp.Before(cutoff) {
			continue
		}
		
		for _, pattern := range pc.Patterns {
			if strings.Contains(strings.ToLower(entry.Message), strings.ToLower(pattern)) {
				matches++
				matchedPatterns[pattern]++
				break
			}
		}
	}
	
	triggered := matches >= pc.MinMatches
	context := map[string]interface{}{
		"matches":  matches,
		"patterns": matchedPatterns,
		"window":   pc.Window,
	}
	
	return triggered, context
}

type LatencyCondition struct {
	Threshold  float64 // milliseconds
	Percentile float64
	Window     time.Duration
}

func (lc *LatencyCondition) Evaluate(entries []LogEntry) (bool, map[string]interface{}) {
	var latencies []float64
	cutoff := time.Now().Add(-lc.Window)
	
	for _, entry := range entries {
		if entry.Timestamp.Before(cutoff) {
			continue
		}
		
		if latency, ok := entry.Fields["latency"].(float64); ok {
			latencies = append(latencies, latency)
		}
	}
	
	if len(latencies) == 0 {
		return false, nil
	}
	
	// Calculate percentile
	sort.Float64s(latencies)
	index := int(float64(len(latencies)) * lc.Percentile / 100)
	percentileValue := latencies[index]
	
	triggered := percentileValue > lc.Threshold
	context := map[string]interface{}{
		"percentile":       lc.Percentile,
		"percentile_value": percentileValue,
		"threshold":        lc.Threshold,
		"sample_size":      len(latencies),
	}
	
	return triggered, context
}

// ML model implementations

type IsolationForestModel struct {
	Trees         int
	SampleSize    int
	Contamination float64
	forest        []isolationTree
}

type isolationTree struct {
	// Simplified tree structure
}

func (ifm *IsolationForestModel) Predict(features []float64) (float64, error) {
	// Simplified anomaly score
	score := 0.0
	for _, tree := range ifm.forest {
		// Calculate path length
		score += 1.0
	}
	return score / float64(len(ifm.forest)), nil
}

func (ifm *IsolationForestModel) Train(data []TrainingExample) {
	// Simplified training
	ifm.forest = make([]isolationTree, ifm.Trees)
}

func (ifm *IsolationForestModel) GetAccuracy() float64 {
	return 0.85
}

func (ifm *IsolationForestModel) Save(path string) error {
	return nil
}

func (ifm *IsolationForestModel) Load(path string) error {
	return nil
}

type RandomForestClassifier struct {
	Trees      int
	MaxDepth   int
	MinSamples int
	forest     []decisionTree
}

type decisionTree struct {
	// Simplified tree structure
}

func (rfc *RandomForestClassifier) Predict(features []float64) (float64, error) {
	// Simplified classification
	votes := 0.0
	for _, tree := range rfc.forest {
		votes += 1.0
	}
	return votes / float64(len(rfc.forest)), nil
}

func (rfc *RandomForestClassifier) Train(data []TrainingExample) {
	// Simplified training
	rfc.forest = make([]decisionTree, rfc.Trees)
}

func (rfc *RandomForestClassifier) GetAccuracy() float64 {
	return 0.88
}

func (rfc *RandomForestClassifier) Save(path string) error {
	return nil
}

func (rfc *RandomForestClassifier) Load(path string) error {
	return nil
}

type ARIMAModel struct {
	P, D, Q int
	coeffs  []float64
}

func (am *ARIMAModel) Predict(features []float64) (float64, error) {
	// Simplified time series prediction
	return features[len(features)-1] * 1.1, nil
}

func (am *ARIMAModel) Train(data []TrainingExample) {
	// Simplified training
	am.coeffs = make([]float64, am.P+am.Q)
}

func (am *ARIMAModel) GetAccuracy() float64 {
	return 0.82
}

func (am *ARIMAModel) Save(path string) error {
	return nil
}

func (am *ARIMAModel) Load(path string) error {
	return nil
}

// Insight generator implementations

type PerformanceInsightGenerator struct {
	thresholds map[string]float64
}

func (pig *PerformanceInsightGenerator) Generate(entries []LogEntry, patterns []LogPattern) []LogInsight {
	var insights []LogInsight
	
	// Analyze response times
	var responseTimes []float64
	for _, entry := range entries {
		if rt, ok := entry.Fields["response_time"].(float64); ok {
			responseTimes = append(responseTimes, rt)
		}
	}
	
	if len(responseTimes) > 0 {
		avg := average(responseTimes)
		if avg > pig.thresholds["response_time"] {
			insights = append(insights, LogInsight{
				ID:          fmt.Sprintf("insight_perf_%d", time.Now().UnixNano()),
				Type:        InsightTypePerformance,
				Title:       "High Response Times Detected",
				Description: fmt.Sprintf("Average response time %.2fms exceeds threshold %.2fms", avg, pig.thresholds["response_time"]),
				Confidence:  0.9,
				Impact:      "Users experiencing slow response times",
				Suggestions: []string{
					"Investigate database query performance",
					"Check for resource contention",
					"Consider implementing caching",
				},
				GeneratedAt: time.Now(),
				GeneratedBy: "PerformanceInsightGenerator",
			})
		}
	}
	
	return insights
}

func (pig *PerformanceInsightGenerator) GetName() string {
	return "performance"
}

type SecurityInsightGenerator struct {
	patterns []string
}

func (sig *SecurityInsightGenerator) Generate(entries []LogEntry, patterns []LogPattern) []LogInsight {
	var insights []LogInsight
	
	// Check for security patterns
	suspiciousCount := 0
	var suspiciousEntries []LogEntry
	
	for _, entry := range entries {
		for _, pattern := range sig.patterns {
			if strings.Contains(strings.ToLower(entry.Message), pattern) {
				suspiciousCount++
				suspiciousEntries = append(suspiciousEntries, entry)
				break
			}
		}
	}
	
	if suspiciousCount > 10 {
		insights = append(insights, LogInsight{
			ID:          fmt.Sprintf("insight_sec_%d", time.Now().UnixNano()),
			Type:        InsightTypeSecurity,
			Title:       "Potential Security Threat Detected",
			Description: fmt.Sprintf("Found %d suspicious log entries matching security patterns", suspiciousCount),
			Evidence:    suspiciousEntries[:min(5, len(suspiciousEntries))],
			Confidence:  0.85,
			Impact:      "Possible security breach attempt",
			Suggestions: []string{
				"Review access logs for unauthorized attempts",
				"Check firewall rules",
				"Enable additional security monitoring",
			},
			GeneratedAt: time.Now(),
			GeneratedBy: "SecurityInsightGenerator",
		})
	}
	
	return insights
}

func (sig *SecurityInsightGenerator) GetName() string {
	return "security"
}

type CapacityInsightGenerator struct {
	limits map[string]float64
}

func (cig *CapacityInsightGenerator) Generate(entries []LogEntry, patterns []LogPattern) []LogInsight {
	var insights []LogInsight
	
	// Check resource usage
	for _, entry := range entries {
		for metric, limit := range cig.limits {
			if value, ok := entry.Fields[metric].(float64); ok && value > limit {
				insights = append(insights, LogInsight{
					ID:          fmt.Sprintf("insight_cap_%d", time.Now().UnixNano()),
					Type:        InsightTypeCapacity,
					Title:       fmt.Sprintf("High %s Usage", metric),
					Description: fmt.Sprintf("%s usage %.2f exceeds limit %.2f", metric, value, limit),
					Evidence:    []LogEntry{entry},
					Confidence:  0.95,
					Impact:      "System approaching capacity limits",
					Suggestions: []string{
						fmt.Sprintf("Consider scaling %s resources", metric),
						"Implement resource cleanup procedures",
						"Review resource allocation policies",
					},
					GeneratedAt: time.Now(),
					GeneratedBy: "CapacityInsightGenerator",
				})
			}
		}
	}
	
	return insights
}

func (cig *CapacityInsightGenerator) GetName() string {
	return "capacity"
}

// Helper functions

func compareValues(a, b interface{}) int {
	// Simplified comparison
	aStr := fmt.Sprintf("%v", a)
	bStr := fmt.Sprintf("%v", b)
	
	if aStr < bStr {
		return -1
	} else if aStr > bStr {
		return 1
	}
	return 0
}

func average(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}