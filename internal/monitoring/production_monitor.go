package monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

// ProductionMonitor provides enterprise-grade monitoring and alerting
// following Carmack's "simple, observable, reliable" design principles
type ProductionMonitor struct {
	logger   *zap.Logger
	server   *http.Server
	mu       sync.RWMutex
	
	// Prometheus metrics
	registry *prometheus.Registry
	
	// System metrics
	systemUp           prometheus.Gauge
	memoryUsage        prometheus.Gauge
	cpuUsage           prometheus.Gauge
	goroutines         prometheus.Gauge
	gcRuns             prometheus.Counter
	
	// Mining metrics
	hashRate           prometheus.Gauge
	jobsProcessed      prometheus.Counter
	sharesFound        prometheus.Counter
	deviceCount        prometheus.Gauge
	algorithmChanges   prometheus.Counter
	
	// Health metrics
	healthChecks        prometheus.Counter
	healthFailures      prometheus.Counter
	uptimeSeconds       prometheus.Counter
	
	// Alerting
	alerts             []Alert
	alertMutex         sync.RWMutex
}

// Alert represents a monitoring alert
type Alert struct {
	Name        string    `json:"name"`
	Severity    string    `json:"severity"`
	Message     string    `json:"message"`
	Timestamp   time.Time `json:"timestamp"`
	Resolved    bool      `json:"resolved"`
}

// NewProductionMonitor creates enterprise monitoring
func NewProductionMonitor(logger *zap.Logger, port int) *ProductionMonitor {
	registry := prometheus.NewRegistry()
	
	pm := &ProductionMonitor{
		logger:   logger,
		registry: registry,
	}

	// Initialize metrics with proper labels and descriptions
	pm.initializeMetrics()
	
	// Setup HTTP server for metrics endpoint
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("/health", pm.healthHandler)
	mux.HandleFunc("/status", pm.statusHandler)
	mux.HandleFunc("/alerts", pm.alertsHandler)
	
	pm.server = &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: mux,
	}

	return pm
}

// Start begins monitoring operations
func (pm *ProductionMonitor) Start() error {
	go func() {
		if err := pm.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			pm.logger.Error("monitoring server failed", zap.Error(err))
		}
	}()

	// Start background collection
	go pm.collectSystemMetrics()
	go pm.collectMiningMetrics()
	go pm.checkAlerts()

	pm.logger.Info("production monitoring started", zap.Int("port", 8080))
	return nil
}

// Stop gracefully shuts down monitoring
func (pm *ProductionMonitor) Stop() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	return pm.server.Shutdown(ctx)
}

// initializeMetrics sets up all Prometheus metrics
func (pm *ProductionMonitor) initializeMetrics() {
	// System metrics
	pm.systemUp = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "system_up",
		Help: "Whether the system is running (1) or down (0)",
	})
	
	pm.memoryUsage = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "system_memory_bytes",
		Help: "Current memory usage in bytes",
	})
	
	pm.cpuUsage = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "system_cpu_percent",
		Help: "Current CPU usage percentage",
	})
	
	pm.goroutines = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "system_goroutines",
		Help: "Number of active goroutines",
	})
	
	pm.gcRuns = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "system_gc_runs_total",
		Help: "Total number of garbage collection runs",
	})
	
	// Mining metrics
	pm.hashRate = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "mining_hash_rate",
		Help: "Current mining hash rate",
	})
	
	pm.jobsProcessed = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "mining_jobs_processed_total",
		Help: "Total number of mining jobs processed",
	})
	
	pm.sharesFound = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "mining_shares_found_total",
		Help: "Total number of valid shares found",
	})
	
	pm.deviceCount = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "mining_device_count",
		Help: "Number of active mining devices",
	})
	
	pm.algorithmChanges = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "mining_algorithm_changes_total",
		Help: "Total number of algorithm changes",
	})
	
	// Health metrics
	pm.healthChecks = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "health_checks_total",
		Help: "Total number of health checks performed",
	})
	
	pm.healthFailures = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "health_failures_total",
		Help: "Total number of health check failures",
	})
	
	pm.uptimeSeconds = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "uptime_seconds_total",
		Help: "Total uptime in seconds",
	})
	
	// Register all metrics
	metrics := []prometheus.Collector{
		pm.systemUp, pm.memoryUsage, pm.cpuUsage, pm.goroutines, pm.gcRuns,
		pm.hashRate, pm.jobsProcessed, pm.sharesFound, pm.deviceCount, pm.algorithmChanges,
		pm.healthChecks, pm.healthFailures, pm.uptimeSeconds,
	}
	
	for _, metric := range metrics {
		pm.registry.MustRegister(metric)
	}
}

// collectSystemMetrics gathers system-level metrics
func (pm *ProductionMonitor) collectSystemMetrics() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			
			pm.memoryUsage.Set(float64(m.Alloc))
			pm.goroutines.Set(float64(runtime.NumGoroutine()))
			pm.gcRuns.Add(float64(m.NumGC))
			pm.uptimeSeconds.Add(10)
		}
	}
}

// collectMiningMetrics gathers mining-specific metrics
func (pm *ProductionMonitor) collectMiningMetrics() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// These would be populated by the mining engine
			// For now, we'll use placeholder values
			pm.hashRate.Set(1000) // Placeholder
			pm.deviceCount.Set(4) // Placeholder
		}
	}
}

// checkAlerts continuously monitors for alert conditions
func (pm *ProductionMonitor) checkAlerts() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			pm.evaluateAlerts()
		}
	}
}

// evaluateAlerts checks for alert conditions
func (pm *ProductionMonitor) evaluateAlerts() {
	// Memory usage alert
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	if m.Alloc > 1024*1024*1024 { // 1GB threshold
		pm.createAlert("high_memory_usage", "warning", 
			fmt.Sprintf("Memory usage high: %.2f GB", float64(m.Alloc)/1024/1024/1024))
	}
	
	// Goroutine count alert
	if runtime.NumGoroutine() > 1000 {
		pm.createAlert("high_goroutine_count", "warning",
			fmt.Sprintf("High goroutine count: %d", runtime.NumGoroutine()))
	}
	
	// Health check
	pm.healthChecks.Inc()
	if !pm.isHealthy() {
		pm.healthFailures.Inc()
		pm.createAlert("system_unhealthy", "critical", "System health check failed")
	}
}

// createAlert creates a new monitoring alert
func (pm *ProductionMonitor) createAlert(name, severity, message string) {
	alert := Alert{
		Name:      name,
		Severity:  severity,
		Message:   message,
		Timestamp: time.Now(),
		Resolved:  false,
	}
	
	pm.alertMutex.Lock()
	pm.alerts = append(pm.alerts, alert)
	pm.alertMutex.Unlock()
	
	pm.logger.Warn("monitoring alert triggered",
		zap.String("name", name),
		zap.String("severity", severity),
		zap.String("message", message))
}

// isHealthy performs comprehensive health check
func (pm *ProductionMonitor) isHealthy() bool {
	// Basic health checks
	if pm.server == nil {
		return false
	}
	
	// Memory health
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	if m.Alloc > 2*1024*1024*1024 { // 2GB threshold
		return false
	}
	
	// Goroutine health
	if runtime.NumGoroutine() > 5000 {
		return false
	}
	
	return true
}

// HTTP Handlers
func (pm *ProductionMonitor) healthHandler(w http.ResponseWriter, r *http.Request) {
	health := map[string]interface{}{
		"status":    "ok",
		"timestamp": time.Now(),
		"healthy":   pm.isHealthy(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(health)
}

func (pm *ProductionMonitor) statusHandler(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"system": map[string]interface{}{
			"uptime":     time.Since(time.Now()), // Placeholder
			"goroutines": runtime.NumGoroutine(),
			"memory":     "healthy",
		},
		"metrics": "available at /metrics",
		"health":  "available at /health",
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

func (pm *ProductionMonitor) alertsHandler(w http.ResponseWriter, r *http.Request) {
	pm.alertMutex.RLock()
	alerts := make([]Alert, len(pm.alerts))
	copy(alerts, pm.alerts)
	pm.alertMutex.RUnlock()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"alerts": alerts,
		"count":  len(alerts),
	})
}

// GetMetrics returns current metric values
func (pm *ProductionMonitor) GetMetrics() map[string]float64 {
	return map[string]float64{
		"system_up":        1, // Placeholder
		"memory_usage":     0, // Placeholder
		"cpu_usage":        0, // Placeholder
		"goroutines":       float64(runtime.NumGoroutine()),
		"hash_rate":        0, // Placeholder
		"device_count":     0, // Placeholder
		"uptime_seconds":   time.Since(time.Now()).Seconds(), // Placeholder
	}
}
