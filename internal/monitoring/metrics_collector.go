package monitoring

import (
	"context"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
	
	"net/http"
)

// MetricsCollector collects and exposes metrics
type MetricsCollector struct {
	logger *zap.Logger
	
	// Configuration
	config MetricsConfig
	
	// HTTP server for metrics endpoint
	server *http.Server
	
	// Custom collectors
	collectors []prometheus.Collector
	
	// Metrics
	
	// System metrics
	cpuUsage        prometheus.Gauge
	memoryUsage     prometheus.Gauge
	goroutines      prometheus.Gauge
	gcPauseTime     prometheus.Histogram
	
	// Mining metrics
	hashRate        *prometheus.GaugeVec
	sharesSubmitted *prometheus.CounterVec
	sharesAccepted  *prometheus.CounterVec
	sharesRejected  *prometheus.CounterVec
	blockFound      *prometheus.CounterVec
	
	// Network metrics
	peersConnected  prometheus.Gauge
	messagesRx      *prometheus.CounterVec
	messagesTx      *prometheus.CounterVec
	networkLatency  *prometheus.HistogramVec
	bandwidth       *prometheus.GaugeVec
	
	// Pool metrics
	activeMiners    prometheus.Gauge
	poolHashRate    prometheus.Gauge
	pendingPayouts  prometheus.Gauge
	totalPayouts    prometheus.Counter
	poolEfficiency  prometheus.Gauge
	
	// API metrics
	httpRequests    *prometheus.CounterVec
	httpDuration    *prometheus.HistogramVec
	httpInFlight    prometheus.Gauge
	wsConnections   prometheus.Gauge
	
	// Database metrics
	dbConnections   prometheus.Gauge
	dbQueries       *prometheus.CounterVec
	dbDuration      *prometheus.HistogramVec
	dbErrors        *prometheus.CounterVec
	
	// Business metrics
	revenue         *prometheus.CounterVec
	userActivity    *prometheus.CounterVec
	
	// Runtime metrics
	startTime       time.Time
	
	// Context
	ctx    context.Context
	cancel context.CancelFunc
}

// MetricsConfig defines metrics configuration
type MetricsConfig struct {
	Enabled        bool          `json:"enabled"`
	Address        string        `json:"address"`
	Path           string        `json:"path"`
	UpdateInterval time.Duration `json:"update_interval"`
	
	// Labels
	NodeID   string            `json:"node_id"`
	Region   string            `json:"region"`
	Labels   map[string]string `json:"labels"`
}

// NewMetricsCollector creates a new metrics collector
func NewMetricsCollector(logger *zap.Logger, config MetricsConfig) *MetricsCollector {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Set defaults
	if config.Address == "" {
		config.Address = ":9090"
	}
	if config.Path == "" {
		config.Path = "/metrics"
	}
	if config.UpdateInterval == 0 {
		config.UpdateInterval = 10 * time.Second
	}
	
	mc := &MetricsCollector{
		logger:    logger,
		config:    config,
		startTime: time.Now(),
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Initialize metrics
	mc.initializeMetrics()
	
	return mc
}

// initializeMetrics creates all metric collectors
func (mc *MetricsCollector) initializeMetrics() {
	// Common labels
	constLabels := prometheus.Labels{
		"node_id": mc.config.NodeID,
		"region":  mc.config.Region,
	}
	
	// Add custom labels
	for k, v := range mc.config.Labels {
		constLabels[k] = v
	}
	
	// System metrics
	mc.cpuUsage = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_cpu_usage_percent",
		Help:        "Current CPU usage percentage",
		ConstLabels: constLabels,
	})
	
	mc.memoryUsage = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_memory_usage_bytes",
		Help:        "Current memory usage in bytes",
		ConstLabels: constLabels,
	})
	
	mc.goroutines = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_goroutines",
		Help:        "Number of goroutines",
		ConstLabels: constLabels,
	})
	
	mc.gcPauseTime = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:        "otedama_gc_pause_seconds",
		Help:        "GC pause time in seconds",
		ConstLabels: constLabels,
		Buckets:     prometheus.ExponentialBuckets(0.00001, 2, 15), // 10us to 160ms
	})
	
	// Mining metrics
	mc.hashRate = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name:        "otedama_hashrate",
		Help:        "Current hashrate by device type",
		ConstLabels: constLabels,
	}, []string{"device_type", "device_id"})
	
	mc.sharesSubmitted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_shares_submitted_total",
		Help:        "Total shares submitted",
		ConstLabels: constLabels,
	}, []string{"worker_id", "algorithm"})
	
	mc.sharesAccepted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_shares_accepted_total",
		Help:        "Total shares accepted",
		ConstLabels: constLabels,
	}, []string{"worker_id", "algorithm"})
	
	mc.sharesRejected = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_shares_rejected_total",
		Help:        "Total shares rejected",
		ConstLabels: constLabels,
	}, []string{"worker_id", "algorithm", "reason"})
	
	mc.blockFound = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_blocks_found_total",
		Help:        "Total blocks found",
		ConstLabels: constLabels,
	}, []string{"algorithm", "reward"})
	
	// Network metrics
	mc.peersConnected = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_peers_connected",
		Help:        "Number of connected peers",
		ConstLabels: constLabels,
	})
	
	mc.messagesRx = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_network_messages_rx_total",
		Help:        "Total messages received",
		ConstLabels: constLabels,
	}, []string{"message_type", "peer_id"})
	
	mc.messagesTx = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_network_messages_tx_total",
		Help:        "Total messages transmitted",
		ConstLabels: constLabels,
	}, []string{"message_type", "peer_id"})
	
	mc.networkLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:        "otedama_network_latency_seconds",
		Help:        "Network latency in seconds",
		ConstLabels: constLabels,
		Buckets:     prometheus.ExponentialBuckets(0.001, 2, 10), // 1ms to 1s
	}, []string{"peer_id"})
	
	mc.bandwidth = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name:        "otedama_network_bandwidth_bytes_per_second",
		Help:        "Network bandwidth usage",
		ConstLabels: constLabels,
	}, []string{"direction"}) // inbound, outbound
	
	// Pool metrics
	mc.activeMiners = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_pool_active_miners",
		Help:        "Number of active miners",
		ConstLabels: constLabels,
	})
	
	mc.poolHashRate = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_pool_hashrate",
		Help:        "Total pool hashrate",
		ConstLabels: constLabels,
	})
	
	mc.pendingPayouts = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_pool_pending_payouts",
		Help:        "Total pending payouts",
		ConstLabels: constLabels,
	})
	
	mc.totalPayouts = promauto.NewCounter(prometheus.CounterOpts{
		Name:        "otedama_pool_total_payouts",
		Help:        "Total payouts made",
		ConstLabels: constLabels,
	})
	
	mc.poolEfficiency = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_pool_efficiency_percent",
		Help:        "Pool efficiency percentage",
		ConstLabels: constLabels,
	})
	
	// API metrics
	mc.httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_http_requests_total",
		Help:        "Total HTTP requests",
		ConstLabels: constLabels,
	}, []string{"method", "path", "status"})
	
	mc.httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:        "otedama_http_request_duration_seconds",
		Help:        "HTTP request duration in seconds",
		ConstLabels: constLabels,
		Buckets:     prometheus.DefBuckets,
	}, []string{"method", "path"})
	
	mc.httpInFlight = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_http_requests_in_flight",
		Help:        "Number of HTTP requests in flight",
		ConstLabels: constLabels,
	})
	
	mc.wsConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_websocket_connections",
		Help:        "Number of WebSocket connections",
		ConstLabels: constLabels,
	})
	
	// Database metrics
	mc.dbConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name:        "otedama_db_connections",
		Help:        "Number of database connections",
		ConstLabels: constLabels,
	})
	
	mc.dbQueries = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_db_queries_total",
		Help:        "Total database queries",
		ConstLabels: constLabels,
	}, []string{"query_type", "table"})
	
	mc.dbDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:        "otedama_db_query_duration_seconds",
		Help:        "Database query duration in seconds",
		ConstLabels: constLabels,
		Buckets:     prometheus.ExponentialBuckets(0.0001, 2, 10), // 100us to 100ms
	}, []string{"query_type"})
	
	mc.dbErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_db_errors_total",
		Help:        "Total database errors",
		ConstLabels: constLabels,
	}, []string{"error_type"})
	
	// Business metrics
	mc.revenue = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_revenue_total",
		Help:        "Total revenue",
		ConstLabels: constLabels,
	}, []string{"currency", "source"})
	
	mc.userActivity = promauto.NewCounterVec(prometheus.CounterOpts{
		Name:        "otedama_user_activity_total",
		Help:        "User activity events",
		ConstLabels: constLabels,
	}, []string{"event_type", "user_type"})
}

// Start starts the metrics collector
func (mc *MetricsCollector) Start() error {
	if !mc.config.Enabled {
		mc.logger.Info("Metrics collection disabled")
		return nil
	}
	
	mc.logger.Info("Starting metrics collector",
		zap.String("address", mc.config.Address),
		zap.String("path", mc.config.Path),
	)
	
	// Start metrics server
	mux := http.NewServeMux()
	mux.Handle(mc.config.Path, promhttp.Handler())
	
	// Add health endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "OK")
	})
	
	// Add custom metrics endpoint
	mux.HandleFunc("/metrics/custom", mc.customMetricsHandler)
	
	mc.server = &http.Server{
		Addr:    mc.config.Address,
		Handler: mux,
	}
	
	// Start server
	go func() {
		if err := mc.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			mc.logger.Error("Metrics server error", zap.Error(err))
		}
	}()
	
	// Start runtime metrics collector
	go mc.collectRuntimeMetrics()
	
	return nil
}

// Stop stops the metrics collector
func (mc *MetricsCollector) Stop() error {
	mc.logger.Info("Stopping metrics collector")
	
	mc.cancel()
	
	if mc.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return mc.server.Shutdown(ctx)
	}
	
	return nil
}

// collectRuntimeMetrics periodically collects runtime metrics
func (mc *MetricsCollector) collectRuntimeMetrics() {
	ticker := time.NewTicker(mc.config.UpdateInterval)
	defer ticker.Stop()
	
	var lastGCPause uint64
	
	for {
		select {
		case <-ticker.C:
			// Collect memory stats
			var m runtime.MemStats
			runtime.ReadMemStats(&m)
			
			// Update metrics
			mc.memoryUsage.Set(float64(m.Alloc))
			mc.goroutines.Set(float64(runtime.NumGoroutine()))
			
			// GC pause time
			if m.PauseTotalNs > lastGCPause {
				pauseTime := float64(m.PauseTotalNs-lastGCPause) / 1e9
				mc.gcPauseTime.Observe(pauseTime)
				lastGCPause = m.PauseTotalNs
			}
			
		case <-mc.ctx.Done():
			return
		}
	}
}

// customMetricsHandler provides custom metrics in different formats
func (mc *MetricsCollector) customMetricsHandler(w http.ResponseWriter, r *http.Request) {
	format := r.URL.Query().Get("format")
	
	switch format {
	case "json":
		mc.serveJSONMetrics(w, r)
	default:
		mc.serveTextMetrics(w, r)
	}
}

// serveJSONMetrics serves metrics in JSON format
func (mc *MetricsCollector) serveJSONMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	
	metrics := map[string]interface{}{
		"uptime_seconds": time.Since(mc.startTime).Seconds(),
		"goroutines":     runtime.NumGoroutine(),
		"timestamp":      time.Now().Unix(),
	}
	
	// Add custom business metrics
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	metrics["memory"] = map[string]interface{}{
		"alloc_mb":      m.Alloc / 1024 / 1024,
		"total_alloc_mb": m.TotalAlloc / 1024 / 1024,
		"sys_mb":        m.Sys / 1024 / 1024,
		"gc_count":      m.NumGC,
	}
	
	// Encode and send
	// JSON encoding would be done here
}

// serveTextMetrics serves metrics in text format
func (mc *MetricsCollector) serveTextMetrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	
	fmt.Fprintf(w, "# Otedama Custom Metrics\n")
	fmt.Fprintf(w, "# Generated at: %s\n\n", time.Now().Format(time.RFC3339))
	
	fmt.Fprintf(w, "uptime_seconds %f\n", time.Since(mc.startTime).Seconds())
	fmt.Fprintf(w, "goroutines %d\n", runtime.NumGoroutine())
}

// Mining metrics update methods

// UpdateHashRate updates hashrate metric
func (mc *MetricsCollector) UpdateHashRate(deviceType, deviceID string, hashrate float64) {
	mc.hashRate.WithLabelValues(deviceType, deviceID).Set(hashrate)
}

// IncrementSharesSubmitted increments submitted shares
func (mc *MetricsCollector) IncrementSharesSubmitted(workerID, algorithm string) {
	mc.sharesSubmitted.WithLabelValues(workerID, algorithm).Inc()
}

// IncrementSharesAccepted increments accepted shares
func (mc *MetricsCollector) IncrementSharesAccepted(workerID, algorithm string) {
	mc.sharesAccepted.WithLabelValues(workerID, algorithm).Inc()
}

// IncrementSharesRejected increments rejected shares
func (mc *MetricsCollector) IncrementSharesRejected(workerID, algorithm, reason string) {
	mc.sharesRejected.WithLabelValues(workerID, algorithm, reason).Inc()
}

// IncrementBlockFound increments blocks found
func (mc *MetricsCollector) IncrementBlockFound(algorithm string, reward float64) {
	mc.blockFound.WithLabelValues(algorithm, fmt.Sprintf("%.8f", reward)).Inc()
}

// Network metrics update methods

// SetPeersConnected sets connected peers count
func (mc *MetricsCollector) SetPeersConnected(count int) {
	mc.peersConnected.Set(float64(count))
}

// IncrementMessagesReceived increments received messages
func (mc *MetricsCollector) IncrementMessagesReceived(messageType, peerID string) {
	mc.messagesRx.WithLabelValues(messageType, peerID).Inc()
}

// IncrementMessagesTransmitted increments transmitted messages
func (mc *MetricsCollector) IncrementMessagesTransmitted(messageType, peerID string) {
	mc.messagesTx.WithLabelValues(messageType, peerID).Inc()
}

// ObserveNetworkLatency records network latency
func (mc *MetricsCollector) ObserveNetworkLatency(peerID string, latency time.Duration) {
	mc.networkLatency.WithLabelValues(peerID).Observe(latency.Seconds())
}

// SetBandwidth sets network bandwidth
func (mc *MetricsCollector) SetBandwidth(direction string, bytesPerSecond float64) {
	mc.bandwidth.WithLabelValues(direction).Set(bytesPerSecond)
}

// Pool metrics update methods

// SetActiveMiners sets active miners count
func (mc *MetricsCollector) SetActiveMiners(count int) {
	mc.activeMiners.Set(float64(count))
}

// SetPoolHashRate sets pool hashrate
func (mc *MetricsCollector) SetPoolHashRate(hashrate float64) {
	mc.poolHashRate.Set(hashrate)
}

// SetPendingPayouts sets pending payouts
func (mc *MetricsCollector) SetPendingPayouts(amount float64) {
	mc.pendingPayouts.Set(amount)
}

// IncrementTotalPayouts increments total payouts
func (mc *MetricsCollector) IncrementTotalPayouts(amount float64) {
	mc.totalPayouts.Add(amount)
}

// SetPoolEfficiency sets pool efficiency
func (mc *MetricsCollector) SetPoolEfficiency(efficiency float64) {
	mc.poolEfficiency.Set(efficiency)
}

// HTTP metrics middleware

// HTTPMiddleware returns HTTP metrics middleware
func (mc *MetricsCollector) HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		path := r.URL.Path
		method := r.Method
		
		// Track in-flight requests
		mc.httpInFlight.Inc()
		defer mc.httpInFlight.Dec()
		
		// Wrap response writer to capture status code
		wrapped := &responseWriter{
			ResponseWriter: w,
			statusCode:     http.StatusOK,
		}
		
		// Process request
		next.ServeHTTP(wrapped, r)
		
		// Record metrics
		duration := time.Since(start)
		status := fmt.Sprintf("%d", wrapped.statusCode)
		
		mc.httpRequests.WithLabelValues(method, path, status).Inc()
		mc.httpDuration.WithLabelValues(method, path).Observe(duration.Seconds())
	})
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
	written    bool
}

func (rw *responseWriter) WriteHeader(code int) {
	if !rw.written {
		rw.statusCode = code
		rw.ResponseWriter.WriteHeader(code)
		rw.written = true
	}
}

func (rw *responseWriter) Write(data []byte) (int, error) {
	if !rw.written {
		rw.WriteHeader(http.StatusOK)
	}
	return rw.ResponseWriter.Write(data)
}

// Database metrics update methods

// SetDBConnections sets database connections
func (mc *MetricsCollector) SetDBConnections(count int) {
	mc.dbConnections.Set(float64(count))
}

// IncrementDBQueries increments database queries
func (mc *MetricsCollector) IncrementDBQueries(queryType, table string) {
	mc.dbQueries.WithLabelValues(queryType, table).Inc()
}

// ObserveDBDuration records database query duration
func (mc *MetricsCollector) ObserveDBDuration(queryType string, duration time.Duration) {
	mc.dbDuration.WithLabelValues(queryType).Observe(duration.Seconds())
}

// IncrementDBErrors increments database errors
func (mc *MetricsCollector) IncrementDBErrors(errorType string) {
	mc.dbErrors.WithLabelValues(errorType).Inc()
}

// Business metrics update methods

// IncrementRevenue increments revenue
func (mc *MetricsCollector) IncrementRevenue(currency, source string, amount float64) {
	mc.revenue.WithLabelValues(currency, source).Add(amount)
}

// IncrementUserActivity increments user activity
func (mc *MetricsCollector) IncrementUserActivity(eventType, userType string) {
	mc.userActivity.WithLabelValues(eventType, userType).Inc()
}

// WebSocket metrics

// IncrementWSConnections increments WebSocket connections
func (mc *MetricsCollector) IncrementWSConnections() {
	mc.wsConnections.Inc()
}

// DecrementWSConnections decrements WebSocket connections
func (mc *MetricsCollector) DecrementWSConnections() {
	mc.wsConnections.Dec()
}