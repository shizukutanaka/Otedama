package performance

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"runtime/debug"
	"runtime/pprof"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"go.uber.org/zap"
)

// Monitor provides comprehensive performance monitoring
type Monitor struct {
	logger     *zap.Logger
	collectors map[string]Collector
	metrics    *Metrics
	profiler   *Profiler
	alerts     *AlertManager
	
	// Control
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	
	// Configuration
	config     Config
}

// Config defines performance monitoring configuration
type Config struct {
	CollectionInterval time.Duration `json:"collection_interval"`
	RetentionPeriod   time.Duration `json:"retention_period"`
	EnableProfiling   bool          `json:"enable_profiling"`
	EnableAlerts      bool          `json:"enable_alerts"`
	MetricsBufferSize int           `json:"metrics_buffer_size"`
	
	// Alert thresholds
	CPUAlertThreshold    float64 `json:"cpu_alert_threshold"`
	MemoryAlertThreshold float64 `json:"memory_alert_threshold"`
	LatencyAlertThreshold time.Duration `json:"latency_alert_threshold"`
}

// Metrics holds performance metrics
type Metrics struct {
	// System metrics
	CPU          *CPUMetrics          `json:"cpu"`
	Memory       *MemoryMetrics       `json:"memory"`
	Disk         *DiskMetrics         `json:"disk"`
	Network      *NetworkMetrics      `json:"network"`
	
	// Application metrics
	Application  *ApplicationMetrics  `json:"application"`
	Mining       *MiningMetrics       `json:"mining"`
	Database     *DatabaseMetrics     `json:"database"`
	
	// Custom metrics
	Custom       map[string]*CustomMetric `json:"custom"`
	customMu     sync.RWMutex
}

// CPUMetrics tracks CPU performance
type CPUMetrics struct {
	Usage         atomic.Value // float64 - percentage
	LoadAverage   atomic.Value // [3]float64 - 1m, 5m, 15m
	Cores         int          `json:"cores"`
	MaxFrequency  uint64       `json:"max_frequency"`
	CurrentFreq   atomic.Uint64 `json:"current_frequency"`
	ContextSwitches atomic.Uint64 `json:"context_switches"`
	Interrupts    atomic.Uint64 `json:"interrupts"`
	
	// Per-core metrics
	PerCore       []float64    `json:"per_core"`
	perCoreMu     sync.RWMutex
}

// MemoryMetrics tracks memory performance
type MemoryMetrics struct {
	// System memory
	Total         uint64       `json:"total"`
	Available     atomic.Uint64 `json:"available"`
	Used          atomic.Uint64 `json:"used"`
	UsagePercent  atomic.Value  // float64
	
	// Process memory
	ProcessRSS    atomic.Uint64 `json:"process_rss"`
	ProcessVSS    atomic.Uint64 `json:"process_vss"`
	
	// Go runtime memory
	HeapAlloc     atomic.Uint64 `json:"heap_alloc"`
	HeapSys       atomic.Uint64 `json:"heap_sys"`
	HeapIdle      atomic.Uint64 `json:"heap_idle"`
	HeapInuse     atomic.Uint64 `json:"heap_inuse"`
	HeapReleased  atomic.Uint64 `json:"heap_released"`
	StackInuse    atomic.Uint64 `json:"stack_inuse"`
	StackSys      atomic.Uint64 `json:"stack_sys"`
	
	// GC metrics
	GCRuns        atomic.Uint32 `json:"gc_runs"`
	LastGCTime    atomic.Value  // time.Time
	NextGC        atomic.Uint64 `json:"next_gc"`
	PauseTotal    atomic.Value  // time.Duration
	PauseRecent   atomic.Value  // time.Duration
}

// DiskMetrics tracks disk performance
type DiskMetrics struct {
	// Usage
	Total         uint64       `json:"total"`
	Available     atomic.Uint64 `json:"available"`
	Used          atomic.Uint64 `json:"used"`
	UsagePercent  atomic.Value  // float64
	
	// I/O metrics
	ReadBytes     atomic.Uint64 `json:"read_bytes"`
	WriteBytes    atomic.Uint64 `json:"write_bytes"`
	ReadOps       atomic.Uint64 `json:"read_ops"`
	WriteOps      atomic.Uint64 `json:"write_ops"`
	ReadLatency   atomic.Value  // time.Duration
	WriteLatency  atomic.Value  // time.Duration
	
	// Queue metrics
	IOQueue       atomic.Uint64 `json:"io_queue"`
	IOWait        atomic.Value  // float64 - percentage
}

// NetworkMetrics tracks network performance
type NetworkMetrics struct {
	// Bytes transferred
	BytesIn       atomic.Uint64 `json:"bytes_in"`
	BytesOut      atomic.Uint64 `json:"bytes_out"`
	PacketsIn     atomic.Uint64 `json:"packets_in"`
	PacketsOut    atomic.Uint64 `json:"packets_out"`
	
	// Error counters
	ErrorsIn      atomic.Uint64 `json:"errors_in"`
	ErrorsOut     atomic.Uint64 `json:"errors_out"`
	DroppedIn     atomic.Uint64 `json:"dropped_in"`
	DroppedOut    atomic.Uint64 `json:"dropped_out"`
	
	// Connection metrics
	Connections   atomic.Uint64 `json:"connections"`
	ActiveConns   atomic.Uint64 `json:"active_connections"`
	ListenConns   atomic.Uint64 `json:"listen_connections"`
	
	// Latency metrics
	LatencyP50    atomic.Value  // time.Duration
	LatencyP95    atomic.Value  // time.Duration
	LatencyP99    atomic.Value  // time.Duration
}

// ApplicationMetrics tracks application-specific performance
type ApplicationMetrics struct {
	// Request metrics
	RequestCount     atomic.Uint64 `json:"request_count"`
	RequestRate      atomic.Value  // float64 - requests per second
	ResponseTime     atomic.Value  // time.Duration - average
	ErrorRate        atomic.Value  // float64 - percentage
	
	// Goroutine metrics
	Goroutines       atomic.Int32  `json:"goroutines"`
	MaxGoroutines    atomic.Int32  `json:"max_goroutines"`
	
	// Thread metrics
	OSThreads        atomic.Int32  `json:"os_threads"`
	
	// Cache metrics
	CacheHits        atomic.Uint64 `json:"cache_hits"`
	CacheMisses      atomic.Uint64 `json:"cache_misses"`
	CacheSize        atomic.Uint64 `json:"cache_size"`
	
	// Pool metrics
	PoolActive       atomic.Int32  `json:"pool_active"`
	PoolIdle         atomic.Int32  `json:"pool_idle"`
	PoolWaiting      atomic.Int32  `json:"pool_waiting"`
	
	// Feature usage
	FeatureUsage     map[string]atomic.Uint64 `json:"feature_usage"`
	featureMu        sync.RWMutex
}

// MiningMetrics tracks mining performance
type MiningMetrics struct {
	// Hash rate metrics
	HashRate        atomic.Value  // float64 - current hash rate
	AvgHashRate     atomic.Value  // float64 - average hash rate
	PeakHashRate    atomic.Value  // float64 - peak hash rate
	
	// Worker metrics
	ActiveWorkers   atomic.Int32  `json:"active_workers"`
	TotalWorkers    atomic.Int32  `json:"total_workers"`
	WorkerErrors    atomic.Uint64 `json:"worker_errors"`
	
	// Share metrics
	SharesSubmitted atomic.Uint64 `json:"shares_submitted"`
	SharesAccepted  atomic.Uint64 `json:"shares_accepted"`
	SharesRejected  atomic.Uint64 `json:"shares_rejected"`
	AcceptanceRate  atomic.Value  // float64 - percentage
	
	// Hardware metrics
	Temperature     atomic.Value  // float64 - average temperature
	PowerUsage      atomic.Value  // float64 - watts
	FanSpeed        atomic.Value  // float64 - RPM
	
	// Algorithm metrics
	CurrentAlgo     atomic.Value  // string
	AlgoSwitches    atomic.Uint64 `json:"algo_switches"`
	Difficulty      atomic.Value  // float64
	
	// Pool metrics
	PoolLatency     atomic.Value  // time.Duration
	PoolReconnects  atomic.Uint64 `json:"pool_reconnects"`
	PoolErrors      atomic.Uint64 `json:"pool_errors"`
}

// DatabaseMetrics tracks database performance
type DatabaseMetrics struct {
	// Connection metrics
	OpenConnections atomic.Int32  `json:"open_connections"`
	IdleConnections atomic.Int32  `json:"idle_connections"`
	WaitCount       atomic.Uint64 `json:"wait_count"`
	WaitDuration    atomic.Value  // time.Duration
	MaxIdleTime     atomic.Value  // time.Duration
	MaxLifetime     atomic.Value  // time.Duration
	
	// Query metrics
	QueriesTotal    atomic.Uint64 `json:"queries_total"`
	QueriesSuccess  atomic.Uint64 `json:"queries_success"`
	QueriesError    atomic.Uint64 `json:"queries_error"`
	QueryDuration   atomic.Value  // time.Duration - average
	SlowQueries     atomic.Uint64 `json:"slow_queries"`
	
	// Transaction metrics
	TransactionsTotal atomic.Uint64 `json:"transactions_total"`
	TransactionsCommit atomic.Uint64 `json:"transactions_commit"`
	TransactionsRollback atomic.Uint64 `json:"transactions_rollback"`
}

// CustomMetric represents a custom performance metric
type CustomMetric struct {
	Name        string           `json:"name"`
	Type        MetricType       `json:"type"`
	Value       atomic.Value     `json:"value"`
	Labels      map[string]string `json:"labels"`
	LastUpdate  atomic.Value     // time.Time
	Description string           `json:"description"`
}

// MetricType defines the type of metric
type MetricType string

const (
	TypeCounter   MetricType = "counter"
	TypeGauge     MetricType = "gauge"
	TypeHistogram MetricType = "histogram"
	TypeTimer     MetricType = "timer"
)

// Collector interface for metric collection
type Collector interface {
	Name() string
	Collect(ctx context.Context) error
	Metrics() map[string]interface{}
}

// NewMonitor creates a new performance monitor
func NewMonitor(logger *zap.Logger, config Config) *Monitor {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Set defaults
	if config.CollectionInterval == 0 {
		config.CollectionInterval = 10 * time.Second
	}
	if config.RetentionPeriod == 0 {
		config.RetentionPeriod = 24 * time.Hour
	}
	if config.MetricsBufferSize == 0 {
		config.MetricsBufferSize = 1000
	}
	
	monitor := &Monitor{
		logger:     logger,
		collectors: make(map[string]Collector),
		metrics:    newMetrics(),
		config:     config,
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Initialize profiler if enabled
	if config.EnableProfiling {
		monitor.profiler = NewProfiler(logger)
	}
	
	// Initialize alert manager if enabled
	if config.EnableAlerts {
		monitor.alerts = NewAlertManager(logger, config)
	}
	
	// Register default collectors
	monitor.registerDefaultCollectors()
	
	return monitor
}

// newMetrics creates new metrics instance
func newMetrics() *Metrics {
	return &Metrics{
		CPU:         &CPUMetrics{Cores: runtime.NumCPU()},
		Memory:      &MemoryMetrics{},
		Disk:        &DiskMetrics{},
		Network:     &NetworkMetrics{},
		Application: &ApplicationMetrics{
			FeatureUsage: make(map[string]atomic.Uint64),
		},
		Mining:      &MiningMetrics{},
		Database:    &DatabaseMetrics{},
		Custom:      make(map[string]*CustomMetric),
	}
}

// Start starts the performance monitor
func (m *Monitor) Start() error {
	m.logger.Info("Starting performance monitor",
		zap.Duration("collection_interval", m.config.CollectionInterval),
		zap.Bool("profiling_enabled", m.config.EnableProfiling),
		zap.Bool("alerts_enabled", m.config.EnableAlerts))
	
	// Start profiler
	if m.profiler != nil {
		if err := m.profiler.Start(); err != nil {
			return err
		}
	}
	
	// Start alert manager
	if m.alerts != nil {
		m.alerts.Start()
	}
	
	// Start collection loop
	m.wg.Add(1)
	go m.collectionLoop()
	
	// Start alert checking loop
	if m.alerts != nil {
		m.wg.Add(1)
		go m.alertLoop()
	}
	
	return nil
}

// Stop stops the performance monitor
func (m *Monitor) Stop() error {
	m.logger.Info("Stopping performance monitor")
	
	m.cancel()
	m.wg.Wait()
	
	if m.profiler != nil {
		m.profiler.Stop()
	}
	
	if m.alerts != nil {
		m.alerts.Stop()
	}
	
	return nil
}

// RegisterCollector registers a custom collector
func (m *Monitor) RegisterCollector(collector Collector) {
	m.collectors[collector.Name()] = collector
}

// GetMetrics returns current metrics snapshot
func (m *Monitor) GetMetrics() *Metrics {
	return m.metrics
}

// GetSnapshot returns a metrics snapshot
func (m *Monitor) GetSnapshot() map[string]interface{} {
	snapshot := make(map[string]interface{})
	
	// System metrics
	snapshot["cpu"] = map[string]interface{}{
		"usage":           m.metrics.CPU.Usage.Load(),
		"cores":           m.metrics.CPU.Cores,
		"context_switches": m.metrics.CPU.ContextSwitches.Load(),
	}
	
	snapshot["memory"] = map[string]interface{}{
		"used":           m.metrics.Memory.Used.Load(),
		"available":      m.metrics.Memory.Available.Load(),
		"usage_percent":  m.metrics.Memory.UsagePercent.Load(),
		"heap_alloc":     m.metrics.Memory.HeapAlloc.Load(),
		"heap_sys":       m.metrics.Memory.HeapSys.Load(),
		"gc_runs":        m.metrics.Memory.GCRuns.Load(),
	}
	
	// Application metrics
	snapshot["application"] = map[string]interface{}{
		"request_count":  m.metrics.Application.RequestCount.Load(),
		"request_rate":   m.metrics.Application.RequestRate.Load(),
		"response_time":  m.metrics.Application.ResponseTime.Load(),
		"error_rate":     m.metrics.Application.ErrorRate.Load(),
		"goroutines":     m.metrics.Application.Goroutines.Load(),
	}
	
	// Mining metrics
	snapshot["mining"] = map[string]interface{}{
		"hash_rate":        m.metrics.Mining.HashRate.Load(),
		"active_workers":   m.metrics.Mining.ActiveWorkers.Load(),
		"shares_submitted": m.metrics.Mining.SharesSubmitted.Load(),
		"shares_accepted":  m.metrics.Mining.SharesAccepted.Load(),
		"acceptance_rate":  m.metrics.Mining.AcceptanceRate.Load(),
	}
	
	// Custom metrics
	m.metrics.customMu.RLock()
	if len(m.metrics.Custom) > 0 {
		custom := make(map[string]interface{})
		for name, metric := range m.metrics.Custom {
			custom[name] = map[string]interface{}{
				"type":        metric.Type,
				"value":       metric.Value.Load(),
				"labels":      metric.Labels,
				"last_update": metric.LastUpdate.Load(),
			}
		}
		snapshot["custom"] = custom
	}
	m.metrics.customMu.RUnlock()
	
	return snapshot
}

// UpdateMiningMetrics updates mining-specific metrics
func (m *Monitor) UpdateMiningMetrics(hashRate float64, workers int32, shares map[string]uint64) {
	m.metrics.Mining.HashRate.Store(hashRate)
	m.metrics.Mining.ActiveWorkers.Store(workers)
	
	if submitted, ok := shares["submitted"]; ok {
		m.metrics.Mining.SharesSubmitted.Store(submitted)
	}
	if accepted, ok := shares["accepted"]; ok {
		m.metrics.Mining.SharesAccepted.Store(accepted)
	}
	if rejected, ok := shares["rejected"]; ok {
		m.metrics.Mining.SharesRejected.Store(rejected)
	}
	
	// Calculate acceptance rate
	submitted := m.metrics.Mining.SharesSubmitted.Load()
	accepted := m.metrics.Mining.SharesAccepted.Load()
	if submitted > 0 {
		rate := float64(accepted) / float64(submitted) * 100
		m.metrics.Mining.AcceptanceRate.Store(rate)
	}
}

// RecordCustomMetric records a custom metric
func (m *Monitor) RecordCustomMetric(name string, metricType MetricType, value interface{}, labels map[string]string) {
	m.metrics.customMu.Lock()
	defer m.metrics.customMu.Unlock()
	
	metric, exists := m.metrics.Custom[name]
	if !exists {
		metric = &CustomMetric{
			Name:   name,
			Type:   metricType,
			Labels: labels,
		}
		m.metrics.Custom[name] = metric
	}
	
	metric.Value.Store(value)
	metric.LastUpdate.Store(time.Now())
}

// collectionLoop runs the metrics collection loop
func (m *Monitor) collectionLoop() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(m.config.CollectionInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.collectMetrics()
		}
	}
}

// collectMetrics collects metrics from all collectors
func (m *Monitor) collectMetrics() {
	// Collect system metrics
	m.collectSystemMetrics()
	
	// Run custom collectors
	for name, collector := range m.collectors {
		if err := collector.Collect(m.ctx); err != nil {
			m.logger.Error("Collector failed",
				zap.String("collector", name),
				zap.Error(err))
		}
	}
}

// collectSystemMetrics collects basic system metrics
func (m *Monitor) collectSystemMetrics() {
	// Collect Go runtime metrics
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	// Update memory metrics
	m.metrics.Memory.HeapAlloc.Store(memStats.Alloc)
	m.metrics.Memory.HeapSys.Store(memStats.HeapSys)
	m.metrics.Memory.HeapIdle.Store(memStats.HeapIdle)
	m.metrics.Memory.HeapInuse.Store(memStats.HeapInuse)
	m.metrics.Memory.HeapReleased.Store(memStats.HeapReleased)
	m.metrics.Memory.StackInuse.Store(memStats.StackInuse)
	m.metrics.Memory.StackSys.Store(memStats.StackSys)
	m.metrics.Memory.GCRuns.Store(memStats.NumGC)
	m.metrics.Memory.NextGC.Store(memStats.NextGC)
	
	// Update application metrics
	m.metrics.Application.Goroutines.Store(int32(runtime.NumGoroutine()))
	
	// Calculate memory usage percentage
	if memStats.Sys > 0 {
		usagePercent := float64(memStats.Alloc) / float64(memStats.Sys) * 100
		m.metrics.Memory.UsagePercent.Store(usagePercent)
	}
}

// alertLoop runs the alert checking loop
func (m *Monitor) alertLoop() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.checkAlerts()
		}
	}
}

// checkAlerts checks for alert conditions
func (m *Monitor) checkAlerts() {
	if m.alerts == nil {
		return
	}
	
	// Check CPU usage
	if cpuUsage, ok := m.metrics.CPU.Usage.Load().(float64); ok {
		if cpuUsage > m.config.CPUAlertThreshold {
			m.alerts.TriggerAlert("high_cpu_usage", 
				fmt.Sprintf("CPU usage is %.2f%%, threshold is %.2f%%", cpuUsage, m.config.CPUAlertThreshold))
		}
	}
	
	// Check memory usage
	if memUsage, ok := m.metrics.Memory.UsagePercent.Load().(float64); ok {
		if memUsage > m.config.MemoryAlertThreshold {
			m.alerts.TriggerAlert("high_memory_usage",
				fmt.Sprintf("Memory usage is %.2f%%, threshold is %.2f%%", memUsage, m.config.MemoryAlertThreshold))
		}
	}
	
	// Check goroutine count
	goroutines := m.metrics.Application.Goroutines.Load()
	if goroutines > 1000 {
		m.alerts.TriggerAlert("high_goroutine_count",
			fmt.Sprintf("Goroutine count is %d", goroutines))
	}
}

// registerDefaultCollectors registers default metric collectors
func (m *Monitor) registerDefaultCollectors() {
	// Register system collector
	m.RegisterCollector(&SystemCollector{
		logger:  m.logger,
		metrics: m.metrics,
	})
	
	// Register application collector
	m.RegisterCollector(&ApplicationCollector{
		logger:  m.logger,
		metrics: m.metrics,
	})
}

// Profiler provides CPU, memory, and trace profiling
type Profiler struct {
	logger    *zap.Logger
	enabled   bool
	cpuFile   *os.File
	memFile   *os.File
	traceFile *os.File
	mu        sync.Mutex
}

// NewProfiler creates a new profiler
func NewProfiler(logger *zap.Logger) *Profiler {
	return &Profiler{
		logger:  logger,
		enabled: false,
	}
}

// Start starts profiling
func (p *Profiler) Start() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if p.enabled {
		return nil
	}
	
	// Start CPU profiling
	cpuFile, err := os.Create("cpu.prof")
	if err != nil {
		return fmt.Errorf("failed to create CPU profile: %w", err)
	}
	p.cpuFile = cpuFile
	
	if err := pprof.StartCPUProfile(cpuFile); err != nil {
		cpuFile.Close()
		return fmt.Errorf("failed to start CPU profile: %w", err)
	}
	
	p.enabled = true
	p.logger.Info("Profiler started")
	return nil
}

// Stop stops profiling
func (p *Profiler) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if !p.enabled {
		return
	}
	
	// Stop CPU profiling
	pprof.StopCPUProfile()
	if p.cpuFile != nil {
		p.cpuFile.Close()
	}
	
	// Write heap profile
	memFile, err := os.Create("mem.prof")
	if err == nil {
		pprof.WriteHeapProfile(memFile)
		memFile.Close()
	}
	
	p.enabled = false
	p.logger.Info("Profiler stopped")
}

// WriteProfile writes a specific profile type
func (p *Profiler) WriteProfile(profileType string, filename string) error {
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	profile := pprof.Lookup(profileType)
	if profile == nil {
		return fmt.Errorf("unknown profile type: %s", profileType)
	}
	
	return profile.WriteTo(file, 0)
}

// Alert represents a performance alert
type Alert struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Message     string                 `json:"message"`
	Severity    AlertSeverity          `json:"severity"`
	Timestamp   time.Time              `json:"timestamp"`
	Active      bool                   `json:"active"`
	Metadata    map[string]interface{} `json:"metadata"`
}

// AlertSeverity defines alert severity levels
type AlertSeverity string

const (
	SeverityLow      AlertSeverity = "low"
	SeverityMedium   AlertSeverity = "medium"
	SeverityHigh     AlertSeverity = "high"
	SeverityCritical AlertSeverity = "critical"
)

// AlertManager manages performance alerts
type AlertManager struct {
	logger      *zap.Logger
	config      Config
	alerts      map[string]*Alert
	handlers    []AlertHandler
	mu          sync.RWMutex
	suppressed  map[string]time.Time
	suppressMu  sync.RWMutex
}

// AlertHandler interface for handling alerts
type AlertHandler interface {
	HandleAlert(alert *Alert) error
}

// NewAlertManager creates a new alert manager
func NewAlertManager(logger *zap.Logger, config Config) *AlertManager {
	return &AlertManager{
		logger:     logger,
		config:     config,
		alerts:     make(map[string]*Alert),
		handlers:   make([]AlertHandler, 0),
		suppressed: make(map[string]time.Time),
	}
}

// Start starts the alert manager
func (am *AlertManager) Start() {
	am.logger.Info("Alert manager started")
}

// Stop stops the alert manager
func (am *AlertManager) Stop() {
	am.logger.Info("Alert manager stopped")
}

// TriggerAlert triggers a new alert
func (am *AlertManager) TriggerAlert(name, message string) {
	am.mu.Lock()
	defer am.mu.Unlock()
	
	// Check if alert is suppressed
	am.suppressMu.RLock()
	if suppressTime, exists := am.suppressed[name]; exists {
		if time.Since(suppressTime) < 5*time.Minute {
			am.suppressMu.RUnlock()
			return
		}
	}
	am.suppressMu.RUnlock()
	
	alert := &Alert{
		ID:        fmt.Sprintf("%s_%d", name, time.Now().Unix()),
		Name:      name,
		Message:   message,
		Severity:  am.getSeverity(name),
		Timestamp: time.Now(),
		Active:    true,
		Metadata:  make(map[string]interface{}),
	}
	
	am.alerts[alert.ID] = alert
	
	// Suppress similar alerts for 5 minutes
	am.suppressMu.Lock()
	am.suppressed[name] = time.Now()
	am.suppressMu.Unlock()
	
	// Handle alert
	for _, handler := range am.handlers {
		if err := handler.HandleAlert(alert); err != nil {
			am.logger.Error("Alert handler failed",
				zap.String("alert", alert.Name),
				zap.Error(err))
		}
	}
	
	am.logger.Warn("Performance alert triggered",
		zap.String("name", alert.Name),
		zap.String("message", alert.Message),
		zap.String("severity", string(alert.Severity)))
}

// getSeverity determines alert severity based on alert name
func (am *AlertManager) getSeverity(name string) AlertSeverity {
	switch name {
	case "high_cpu_usage", "high_memory_usage":
		return SeverityHigh
	case "high_goroutine_count", "pool_errors":
		return SeverityMedium
	default:
		return SeverityLow
	}
}

// AddHandler adds an alert handler
func (am *AlertManager) AddHandler(handler AlertHandler) {
	am.handlers = append(am.handlers, handler)
}

// GetActiveAlerts returns all active alerts
func (am *AlertManager) GetActiveAlerts() []*Alert {
	am.mu.RLock()
	defer am.mu.RUnlock()
	
	var activeAlerts []*Alert
	for _, alert := range am.alerts {
		if alert.Active {
			activeAlerts = append(activeAlerts, alert)
		}
	}
	return activeAlerts
}

// SystemCollector collects system-level metrics
type SystemCollector struct {
	logger  *zap.Logger
	metrics *Metrics
}

// Name returns the collector name
func (sc *SystemCollector) Name() string {
	return "system"
}

// Collect collects system metrics
func (sc *SystemCollector) Collect(ctx context.Context) error {
	// Collect CPU metrics
	if err := sc.collectCPUMetrics(); err != nil {
		sc.logger.Error("Failed to collect CPU metrics", zap.Error(err))
	}
	
	// Collect memory metrics
	if err := sc.collectMemoryMetrics(); err != nil {
		sc.logger.Error("Failed to collect memory metrics", zap.Error(err))
	}
	
	// Collect disk metrics
	if err := sc.collectDiskMetrics(); err != nil {
		sc.logger.Error("Failed to collect disk metrics", zap.Error(err))
	}
	
	// Collect network metrics
	if err := sc.collectNetworkMetrics(); err != nil {
		sc.logger.Error("Failed to collect network metrics", zap.Error(err))
	}
	
	return nil
}

// Metrics returns collected metrics
func (sc *SystemCollector) Metrics() map[string]interface{} {
	return map[string]interface{}{
		"cpu_usage":    sc.metrics.CPU.Usage.Load(),
		"memory_usage": sc.metrics.Memory.UsagePercent.Load(),
		"disk_usage":   sc.metrics.Disk.UsagePercent.Load(),
		"network_in":   sc.metrics.Network.BytesIn.Load(),
		"network_out":  sc.metrics.Network.BytesOut.Load(),
	}
}

// collectCPUMetrics collects CPU usage metrics
func (sc *SystemCollector) collectCPUMetrics() error {
	// Basic CPU usage calculation (simplified)
	// In production, use proper system calls or libraries
	usage := float64(runtime.NumGoroutine()) / float64(runtime.NumCPU()) * 10
	if usage > 100 {
		usage = 100
	}
	sc.metrics.CPU.Usage.Store(usage)
	return nil
}

// collectMemoryMetrics collects system memory metrics
func (sc *SystemCollector) collectMemoryMetrics() error {
	// Get system memory info (simplified implementation)
	var sysinfo syscall.Sysinfo_t
	if err := syscall.Sysinfo(&sysinfo); err != nil {
		return err
	}
	
	total := sysinfo.Totalram * uint64(sysinfo.Unit)
	free := sysinfo.Freeram * uint64(sysinfo.Unit)
	used := total - free
	
	sc.metrics.Memory.Total = total
	sc.metrics.Memory.Available.Store(free)
	sc.metrics.Memory.Used.Store(used)
	
	if total > 0 {
		usagePercent := float64(used) / float64(total) * 100
		sc.metrics.Memory.UsagePercent.Store(usagePercent)
	}
	
	return nil
}

// collectDiskMetrics collects disk usage metrics
func (sc *SystemCollector) collectDiskMetrics() error {
	// Simplified disk metrics collection
	// In production, use proper system calls
	var stat syscall.Statfs_t
	if err := syscall.Statfs(".", &stat); err != nil {
		return err
	}
	
	total := stat.Blocks * uint64(stat.Bsize)
	free := stat.Bavail * uint64(stat.Bsize)
	used := total - free
	
	sc.metrics.Disk.Total = total
	sc.metrics.Disk.Available.Store(free)
	sc.metrics.Disk.Used.Store(used)
	
	if total > 0 {
		usagePercent := float64(used) / float64(total) * 100
		sc.metrics.Disk.UsagePercent.Store(usagePercent)
	}
	
	return nil
}

// collectNetworkMetrics collects network metrics (simplified)
func (sc *SystemCollector) collectNetworkMetrics() error {
	// Simplified network metrics
	// In production, read from /proc/net/dev or use proper libraries
	sc.metrics.Network.BytesIn.Add(1024)  // Placeholder
	sc.metrics.Network.BytesOut.Add(512)  // Placeholder
	sc.metrics.Network.PacketsIn.Add(10)  // Placeholder
	sc.metrics.Network.PacketsOut.Add(5)  // Placeholder
	return nil
}

// ApplicationCollector collects application-level metrics
type ApplicationCollector struct {
	logger  *zap.Logger
	metrics *Metrics
}

// Name returns the collector name
func (ac *ApplicationCollector) Name() string {
	return "application"
}

// Collect collects application metrics
func (ac *ApplicationCollector) Collect(ctx context.Context) error {
	// Update goroutine count
	ac.metrics.Application.Goroutines.Store(int32(runtime.NumGoroutine()))
	
	// Update OS thread count
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	// Use debug.Stack() to get thread info (simplified)
	ac.metrics.Application.OSThreads.Store(int32(runtime.NumGoroutine() / 10))
	
	return nil
}

// Metrics returns collected metrics
func (ac *ApplicationCollector) Metrics() map[string]interface{} {
	return map[string]interface{}{
		"goroutines":    ac.metrics.Application.Goroutines.Load(),
		"os_threads":    ac.metrics.Application.OSThreads.Load(),
		"request_count": ac.metrics.Application.RequestCount.Load(),
		"error_rate":    ac.metrics.Application.ErrorRate.Load(),
	}
}