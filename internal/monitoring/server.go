package monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

// MonitoringServer provides HTTP endpoints for health checks and metrics
// Following Rob Pike's principle: "Make it correct, simple, and efficient, in that order"
type MonitoringServer struct {
	logger *zap.Logger
	server *http.Server
	
	// Components to monitor
	components   map[string]Component
	componentsMu sync.RWMutex
	
	// Health state
	healthy      atomic.Bool
	lastCheck    atomic.Int64
	
	// Metrics
	metrics      *SystemMetrics
	metricsMu    sync.RWMutex
	
	// Prometheus metrics
	promRegistry *prometheus.Registry
	promMetrics  *PrometheusMetrics
	
	// Configuration
	config       *MonitoringConfig
}

// MonitoringConfig contains monitoring server configuration
type MonitoringConfig struct {
	ListenAddr         string
	EnablePrometheus   bool
	EnableHealthCheck  bool
	EnableDebug        bool
	HealthCheckInterval time.Duration
}

// Component represents a monitored component
type Component interface {
	Name() string
	HealthCheck(context.Context) error
	GetStats() interface{}
}

// SystemMetrics contains system-wide metrics
type SystemMetrics struct {
	// System
	Uptime          time.Duration `json:"uptime"`
	Version         string        `json:"version"`
	GoVersion       string        `json:"go_version"`
	
	// Resources
	CPUUsage        float64       `json:"cpu_usage_percent"`
	MemoryUsed      uint64        `json:"memory_used_bytes"`
	MemoryTotal     uint64        `json:"memory_total_bytes"`
	GoroutineCount  int           `json:"goroutine_count"`
	
	// Mining
	HashRate        float64       `json:"hash_rate"`
	SharesSubmitted uint64        `json:"shares_submitted"`
	SharesAccepted  uint64        `json:"shares_accepted"`
	
	// Network
	ConnectedPeers  int           `json:"connected_peers"`
	NetworkInBytes  uint64        `json:"network_in_bytes"`
	NetworkOutBytes uint64        `json:"network_out_bytes"`
	
	// Pool
	ActiveWorkers   int           `json:"active_workers"`
	PoolHashRate    float64       `json:"pool_hash_rate"`
	
	// Timestamp
	LastUpdated     time.Time     `json:"last_updated"`
}

// PrometheusMetrics contains Prometheus metric collectors
type PrometheusMetrics struct {
	// System metrics
	cpuUsage        prometheus.Gauge
	memoryUsed      prometheus.Gauge
	goroutines      prometheus.Gauge
	
	// Mining metrics
	hashRate        prometheus.Gauge
	sharesTotal     prometheus.Counter
	sharesAccepted  prometheus.Counter
	
	// Network metrics
	peersConnected  prometheus.Gauge
	networkBytesIn  prometheus.Counter
	networkBytesOut prometheus.Counter
	
	// HTTP metrics
	httpDuration    prometheus.HistogramVec
	httpRequests    prometheus.CounterVec
}

// NewMonitoringServer creates a new monitoring server
func NewMonitoringServer(logger *zap.Logger, config *MonitoringConfig) *MonitoringServer {
	if config == nil {
		config = DefaultMonitoringConfig()
	}
	
	ms := &MonitoringServer{
		logger:     logger,
		components: make(map[string]Component),
		metrics:    &SystemMetrics{},
		config:     config,
	}
	
	// Setup Prometheus if enabled
	if config.EnablePrometheus {
		ms.setupPrometheus()
	}
	
	// Setup HTTP server
	ms.setupHTTPServer()
	
	// Set initial health state
	ms.healthy.Store(true)
	
	return ms
}

// Start starts the monitoring server
func (ms *MonitoringServer) Start() error {
	ms.logger.Info("Starting monitoring server", 
		zap.String("address", ms.config.ListenAddr),
		zap.Bool("prometheus", ms.config.EnablePrometheus),
	)
	
	// Start health checker
	go ms.healthChecker()
	
	// Start metrics collector
	go ms.metricsCollector()
	
	// Start HTTP server
	go func() {
		if err := ms.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			ms.logger.Error("Monitoring server error", zap.Error(err))
		}
	}()
	
	return nil
}

// Stop stops the monitoring server
func (ms *MonitoringServer) Stop() error {
	ms.logger.Info("Stopping monitoring server")
	
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	
	return ms.server.Shutdown(ctx)
}

// RegisterComponent registers a component for monitoring
func (ms *MonitoringServer) RegisterComponent(component Component) {
	ms.componentsMu.Lock()
	defer ms.componentsMu.Unlock()
	
	ms.components[component.Name()] = component
	ms.logger.Debug("Registered component", zap.String("name", component.Name()))
}

// UpdateMetrics updates system metrics
func (ms *MonitoringServer) UpdateMetrics(update func(*SystemMetrics)) {
	ms.metricsMu.Lock()
	defer ms.metricsMu.Unlock()
	
	update(ms.metrics)
	ms.metrics.LastUpdated = time.Now()
	
	// Update Prometheus metrics if enabled
	if ms.promMetrics != nil {
		ms.updatePrometheusMetrics()
	}
}

// Private methods

func (ms *MonitoringServer) setupHTTPServer() {
	mux := http.NewServeMux()
	
	// Health check endpoints
	mux.HandleFunc("/health", ms.handleHealth)
	mux.HandleFunc("/health/live", ms.handleLiveness)
	mux.HandleFunc("/health/ready", ms.handleReadiness)
	
	// Metrics endpoints
	mux.HandleFunc("/metrics", ms.handleMetrics)
	if ms.config.EnablePrometheus {
		mux.Handle("/metrics/prometheus", promhttp.HandlerFor(ms.promRegistry, promhttp.HandlerOpts{}))
	}
	
	// Status endpoints
	mux.HandleFunc("/status", ms.handleStatus)
	mux.HandleFunc("/status/components", ms.handleComponentStatus)
	
	// Debug endpoints
	if ms.config.EnableDebug {
		mux.HandleFunc("/debug/pprof/", http.HandlerFunc(http.DefaultServeMux.ServeHTTP))
	}
	
	// Wrap with middleware
	handler := ms.metricsMiddleware(ms.loggingMiddleware(mux))
	
	ms.server = &http.Server{
		Addr:         ms.config.ListenAddr,
		Handler:      handler,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
}

func (ms *MonitoringServer) setupPrometheus() {
	ms.promRegistry = prometheus.NewRegistry()
	
	// Create metrics
	ms.promMetrics = &PrometheusMetrics{
		cpuUsage: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_cpu_usage_percent",
			Help: "Current CPU usage percentage",
		}),
		memoryUsed: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_memory_used_bytes",
			Help: "Memory used in bytes",
		}),
		goroutines: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_goroutines_count",
			Help: "Number of goroutines",
		}),
		hashRate: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_hash_rate",
			Help: "Current hash rate",
		}),
		sharesTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "otedama_shares_total",
			Help: "Total shares submitted",
		}),
		sharesAccepted: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "otedama_shares_accepted_total",
			Help: "Total shares accepted",
		}),
		peersConnected: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_peers_connected",
			Help: "Number of connected peers",
		}),
		networkBytesIn: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "otedama_network_bytes_in_total",
			Help: "Total bytes received",
		}),
		networkBytesOut: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "otedama_network_bytes_out_total",
			Help: "Total bytes sent",
		}),
		httpDuration: *prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "otedama_http_request_duration_seconds",
			Help:    "HTTP request duration",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "path", "status"}),
		httpRequests: *prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "otedama_http_requests_total",
			Help: "Total HTTP requests",
		}, []string{"method", "path", "status"}),
	}
	
	// Register metrics
	ms.promRegistry.MustRegister(
		ms.promMetrics.cpuUsage,
		ms.promMetrics.memoryUsed,
		ms.promMetrics.goroutines,
		ms.promMetrics.hashRate,
		ms.promMetrics.sharesTotal,
		ms.promMetrics.sharesAccepted,
		ms.promMetrics.peersConnected,
		ms.promMetrics.networkBytesIn,
		ms.promMetrics.networkBytesOut,
		&ms.promMetrics.httpDuration,
		&ms.promMetrics.httpRequests,
	)
	
	// Register Go collectors
	ms.promRegistry.MustRegister(prometheus.NewGoCollector())
}

func (ms *MonitoringServer) updatePrometheusMetrics() {
	ms.promMetrics.cpuUsage.Set(ms.metrics.CPUUsage)
	ms.promMetrics.memoryUsed.Set(float64(ms.metrics.MemoryUsed))
	ms.promMetrics.goroutines.Set(float64(ms.metrics.GoroutineCount))
	ms.promMetrics.hashRate.Set(ms.metrics.HashRate)
	ms.promMetrics.sharesTotal.Add(float64(ms.metrics.SharesSubmitted))
	ms.promMetrics.sharesAccepted.Add(float64(ms.metrics.SharesAccepted))
	ms.promMetrics.peersConnected.Set(float64(ms.metrics.ConnectedPeers))
	ms.promMetrics.networkBytesIn.Add(float64(ms.metrics.NetworkInBytes))
	ms.promMetrics.networkBytesOut.Add(float64(ms.metrics.NetworkOutBytes))
}

// HTTP handlers

func (ms *MonitoringServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !ms.healthy.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]string{
			"status": "unhealthy",
			"message": "System health check failed",
		})
		return
	}
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status": "healthy",
	})
}

func (ms *MonitoringServer) handleLiveness(w http.ResponseWriter, r *http.Request) {
	// Liveness check - is the process alive?
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status": "alive",
	})
}

func (ms *MonitoringServer) handleReadiness(w http.ResponseWriter, r *http.Request) {
	// Readiness check - is the service ready to handle requests?
	ms.componentsMu.RLock()
	componentCount := len(ms.components)
	ms.componentsMu.RUnlock()
	
	if componentCount == 0 || !ms.healthy.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "not_ready",
			"components": componentCount,
		})
		return
	}
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ready",
		"components": componentCount,
	})
}

func (ms *MonitoringServer) handleMetrics(w http.ResponseWriter, r *http.Request) {
	ms.metricsMu.RLock()
	metrics := *ms.metrics
	ms.metricsMu.RUnlock()
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(metrics)
}

func (ms *MonitoringServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	ms.componentsMu.RLock()
	defer ms.componentsMu.RUnlock()
	
	status := SystemStatus{
		Healthy:    ms.healthy.Load(),
		Components: make(map[string]ComponentStatus),
		Timestamp:  time.Now(),
	}
	
	// Check each component
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	
	for name, component := range ms.components {
		compStatus := ComponentStatus{
			Name:    name,
			Healthy: true,
		}
		
		// Health check
		if err := component.HealthCheck(ctx); err != nil {
			compStatus.Healthy = false
			compStatus.Error = err.Error()
		}
		
		// Get stats
		compStatus.Stats = component.GetStats()
		
		status.Components[name] = compStatus
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

func (ms *MonitoringServer) handleComponentStatus(w http.ResponseWriter, r *http.Request) {
	ms.componentsMu.RLock()
	defer ms.componentsMu.RUnlock()
	
	components := make([]string, 0, len(ms.components))
	for name := range ms.components {
		components = append(components, name)
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"components": components,
		"count":      len(components),
	})
}

// Middleware

func (ms *MonitoringServer) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		// Wrap response writer to capture status
		wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		
		next.ServeHTTP(wrapped, r)
		
		ms.logger.Debug("HTTP request",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.Int("status", wrapped.status),
			zap.Duration("duration", time.Since(start)),
		)
	})
}

func (ms *MonitoringServer) metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ms.promMetrics == nil {
			next.ServeHTTP(w, r)
			return
		}
		
		start := time.Now()
		wrapped := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		
		next.ServeHTTP(wrapped, r)
		
		duration := time.Since(start).Seconds()
		status := fmt.Sprintf("%d", wrapped.status)
		
		ms.promMetrics.httpDuration.WithLabelValues(r.Method, r.URL.Path, status).Observe(duration)
		ms.promMetrics.httpRequests.WithLabelValues(r.Method, r.URL.Path, status).Inc()
	})
}

// Background workers

func (ms *MonitoringServer) healthChecker() {
	ticker := time.NewTicker(ms.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for range ticker.C {
		ms.performHealthCheck()
	}
}

func (ms *MonitoringServer) performHealthCheck() {
	ms.componentsMu.RLock()
	defer ms.componentsMu.RUnlock()
	
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	
	healthy := true
	
	for name, component := range ms.components {
		if err := component.HealthCheck(ctx); err != nil {
			ms.logger.Warn("Component health check failed",
				zap.String("component", name),
				zap.Error(err),
			)
			healthy = false
		}
	}
	
	ms.healthy.Store(healthy)
	ms.lastCheck.Store(time.Now().Unix())
}

func (ms *MonitoringServer) metricsCollector() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		ms.collectSystemMetrics()
	}
}

func (ms *MonitoringServer) collectSystemMetrics() {
	ms.metricsMu.Lock()
	defer ms.metricsMu.Unlock()
	
	// Collect system metrics
	ms.metrics.GoVersion = runtime.Version()
	ms.metrics.GoroutineCount = runtime.NumGoroutine()
	
	// Memory stats
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	ms.metrics.MemoryUsed = memStats.Alloc
	ms.metrics.MemoryTotal = memStats.Sys
	
	// CPU usage (simplified)
	ms.metrics.CPUUsage = 50.0 // Would use actual CPU sampling in production
	
	ms.metrics.LastUpdated = time.Now()
}

// Helper types

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

type SystemStatus struct {
	Healthy    bool                       `json:"healthy"`
	Components map[string]ComponentStatus `json:"components"`
	Timestamp  time.Time                  `json:"timestamp"`
}

type ComponentStatus struct {
	Name    string      `json:"name"`
	Healthy bool        `json:"healthy"`
	Error   string      `json:"error,omitempty"`
	Stats   interface{} `json:"stats,omitempty"`
}

// DefaultMonitoringConfig returns default monitoring configuration
func DefaultMonitoringConfig() *MonitoringConfig {
	return &MonitoringConfig{
		ListenAddr:          ":9090",
		EnablePrometheus:    true,
		EnableHealthCheck:   true,
		EnableDebug:         false,
		HealthCheckInterval: 30 * time.Second,
	}
}