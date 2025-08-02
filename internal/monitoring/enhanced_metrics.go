package monitoring

import (
	"context"
	"runtime"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"go.uber.org/zap"
)

// EnhancedMetrics provides comprehensive metrics collection
type EnhancedMetrics struct {
	logger *zap.Logger
	
	// System metrics
	cpuUsage        prometheus.Gauge
	memoryUsage     prometheus.Gauge
	goroutines      prometheus.Gauge
	gcPauseTime     prometheus.Histogram
	
	// Mining metrics
	hashrate        prometheus.GaugeVec
	sharesAccepted  prometheus.CounterVec
	sharesRejected  prometheus.CounterVec
	blocksFound     prometheus.Counter
	miningRevenue   prometheus.GaugeVec
	
	// P2P metrics
	peersConnected  prometheus.Gauge
	peersActive     prometheus.Gauge
	messagesSent    prometheus.CounterVec
	messagesRecv    prometheus.CounterVec
	networkLatency  prometheus.HistogramVec
	
	// Pool metrics
	poolHashrate    prometheus.Gauge
	poolMiners      prometheus.Gauge
	poolEfficiency  prometheus.Gauge
	sharesDifficulty prometheus.Histogram
	
	// API metrics
	apiRequests     prometheus.CounterVec
	apiLatency      prometheus.HistogramVec
	apiErrors       prometheus.CounterVec
	
	// Error metrics
	errorCount      prometheus.CounterVec
	panicCount      prometheus.Counter
	
	// Custom metrics
	customGauges    map[string]prometheus.Gauge
	customCounters  map[string]prometheus.Counter
	mu              sync.RWMutex
}

// NewEnhancedMetrics creates a new enhanced metrics collector
func NewEnhancedMetrics(logger *zap.Logger, namespace string) *EnhancedMetrics {
	m := &EnhancedMetrics{
		logger:         logger,
		customGauges:   make(map[string]prometheus.Gauge),
		customCounters: make(map[string]prometheus.Counter),
	}
	
	// System metrics
	m.cpuUsage = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "system",
		Name:      "cpu_usage_percent",
		Help:      "Current CPU usage percentage",
	})
	
	m.memoryUsage = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "system",
		Name:      "memory_usage_bytes",
		Help:      "Current memory usage in bytes",
	})
	
	m.goroutines = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "system",
		Name:      "goroutines",
		Help:      "Number of goroutines",
	})
	
	m.gcPauseTime = promauto.NewHistogram(prometheus.HistogramOpts{
		Namespace: namespace,
		Subsystem: "system",
		Name:      "gc_pause_seconds",
		Help:      "GC pause time in seconds",
		Buckets:   prometheus.ExponentialBuckets(0.00001, 2, 15),
	})
	
	// Mining metrics
	m.hashrate = *promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "mining",
		Name:      "hashrate",
		Help:      "Current hashrate by algorithm",
	}, []string{"algorithm", "device"})
	
	m.sharesAccepted = *promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Subsystem: "mining",
		Name:      "shares_accepted_total",
		Help:      "Total accepted shares",
	}, []string{"algorithm", "worker"})
	
	m.sharesRejected = *promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Subsystem: "mining",
		Name:      "shares_rejected_total",
		Help:      "Total rejected shares",
	}, []string{"algorithm", "worker", "reason"})
	
	m.blocksFound = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: namespace,
		Subsystem: "mining",
		Name:      "blocks_found_total",
		Help:      "Total blocks found",
	})
	
	m.miningRevenue = *promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "mining",
		Name:      "revenue_usd",
		Help:      "Mining revenue in USD",
	}, []string{"currency"})
	
	// P2P metrics
	m.peersConnected = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "p2p",
		Name:      "peers_connected",
		Help:      "Number of connected peers",
	})
	
	m.peersActive = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "p2p",
		Name:      "peers_active",
		Help:      "Number of active peers",
	})
	
	m.messagesSent = *promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Subsystem: "p2p",
		Name:      "messages_sent_total",
		Help:      "Total messages sent",
	}, []string{"type"})
	
	m.messagesRecv = *promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Subsystem: "p2p",
		Name:      "messages_received_total",
		Help:      "Total messages received",
	}, []string{"type"})
	
	m.networkLatency = *promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: namespace,
		Subsystem: "p2p",
		Name:      "network_latency_seconds",
		Help:      "Network latency in seconds",
		Buckets:   prometheus.ExponentialBuckets(0.001, 2, 10),
	}, []string{"peer"})
	
	// Pool metrics
	m.poolHashrate = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "pool",
		Name:      "hashrate_total",
		Help:      "Total pool hashrate",
	})
	
	m.poolMiners = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "pool",
		Name:      "miners_active",
		Help:      "Number of active miners",
	})
	
	m.poolEfficiency = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace,
		Subsystem: "pool",
		Name:      "efficiency_percent",
		Help:      "Pool efficiency percentage",
	})
	
	m.sharesDifficulty = promauto.NewHistogram(prometheus.HistogramOpts{
		Namespace: namespace,
		Subsystem: "pool",
		Name:      "share_difficulty",
		Help:      "Distribution of share difficulties",
		Buckets:   prometheus.ExponentialBuckets(1, 2, 20),
	})
	
	// API metrics
	m.apiRequests = *promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Subsystem: "api",
		Name:      "requests_total",
		Help:      "Total API requests",
	}, []string{"method", "endpoint", "status"})
	
	m.apiLatency = *promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: namespace,
		Subsystem: "api",
		Name:      "latency_seconds",
		Help:      "API request latency",
		Buckets:   prometheus.DefBuckets,
	}, []string{"method", "endpoint"})
	
	m.apiErrors = *promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Subsystem: "api",
		Name:      "errors_total",
		Help:      "Total API errors",
	}, []string{"method", "endpoint", "error"})
	
	// Error metrics
	m.errorCount = *promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "errors_total",
		Help:      "Total errors by type",
	}, []string{"type", "severity"})
	
	m.panicCount = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: namespace,
		Name:      "panics_total",
		Help:      "Total panic recoveries",
	})
	
	return m
}

// Start begins collecting metrics
func (m *EnhancedMetrics) Start(ctx context.Context) {
	go m.collectSystemMetrics(ctx)
}

// collectSystemMetrics collects system-level metrics
func (m *EnhancedMetrics) collectSystemMetrics(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	var lastGCPause uint64
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// Collect memory stats
			var memStats runtime.MemStats
			runtime.ReadMemStats(&memStats)
			
			// Update metrics
			m.memoryUsage.Set(float64(memStats.Alloc))
			m.goroutines.Set(float64(runtime.NumGoroutine()))
			
			// Track GC pause time
			if memStats.NumGC > 0 {
				pause := memStats.PauseNs[(memStats.NumGC+255)%256]
				if pause > lastGCPause {
					m.gcPauseTime.Observe(float64(pause-lastGCPause) / 1e9)
					lastGCPause = pause
				}
			}
		}
	}
}

// RecordHashrate records hashrate for an algorithm/device
func (m *EnhancedMetrics) RecordHashrate(algorithm, device string, hashrate float64) {
	m.hashrate.WithLabelValues(algorithm, device).Set(hashrate)
}

// RecordShareAccepted records an accepted share
func (m *EnhancedMetrics) RecordShareAccepted(algorithm, worker string) {
	m.sharesAccepted.WithLabelValues(algorithm, worker).Inc()
}

// RecordShareRejected records a rejected share
func (m *EnhancedMetrics) RecordShareRejected(algorithm, worker, reason string) {
	m.sharesRejected.WithLabelValues(algorithm, worker, reason).Inc()
}

// RecordBlockFound records a found block
func (m *EnhancedMetrics) RecordBlockFound() {
	m.blocksFound.Inc()
}

// RecordRevenue records mining revenue
func (m *EnhancedMetrics) RecordRevenue(currency string, amount float64) {
	m.miningRevenue.WithLabelValues(currency).Set(amount)
}

// RecordPeerCount records peer counts
func (m *EnhancedMetrics) RecordPeerCount(connected, active int) {
	m.peersConnected.Set(float64(connected))
	m.peersActive.Set(float64(active))
}

// RecordMessage records P2P message metrics
func (m *EnhancedMetrics) RecordMessage(msgType string, sent bool) {
	if sent {
		m.messagesSent.WithLabelValues(msgType).Inc()
	} else {
		m.messagesRecv.WithLabelValues(msgType).Inc()
	}
}

// RecordNetworkLatency records network latency to a peer
func (m *EnhancedMetrics) RecordNetworkLatency(peer string, latency time.Duration) {
	m.networkLatency.WithLabelValues(peer).Observe(latency.Seconds())
}

// RecordPoolStats records pool statistics
func (m *EnhancedMetrics) RecordPoolStats(hashrate float64, miners int, efficiency float64) {
	m.poolHashrate.Set(hashrate)
	m.poolMiners.Set(float64(miners))
	m.poolEfficiency.Set(efficiency)
}

// RecordShareDifficulty records share difficulty
func (m *EnhancedMetrics) RecordShareDifficulty(difficulty float64) {
	m.sharesDifficulty.Observe(difficulty)
}

// RecordAPIRequest records an API request
func (m *EnhancedMetrics) RecordAPIRequest(method, endpoint, status string, latency time.Duration) {
	m.apiRequests.WithLabelValues(method, endpoint, status).Inc()
	m.apiLatency.WithLabelValues(method, endpoint).Observe(latency.Seconds())
}

// RecordAPIError records an API error
func (m *EnhancedMetrics) RecordAPIError(method, endpoint, error string) {
	m.apiErrors.WithLabelValues(method, endpoint, error).Inc()
}

// RecordError records an error
func (m *EnhancedMetrics) RecordError(errorType, severity string) {
	m.errorCount.WithLabelValues(errorType, severity).Inc()
}

// RecordPanic records a panic recovery
func (m *EnhancedMetrics) RecordPanic() {
	m.panicCount.Inc()
}

// SetCustomGauge sets a custom gauge metric
func (m *EnhancedMetrics) SetCustomGauge(name string, value float64, help string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	gauge, exists := m.customGauges[name]
	if !exists {
		gauge = promauto.NewGauge(prometheus.GaugeOpts{
			Name: name,
			Help: help,
		})
		m.customGauges[name] = gauge
	}
	
	gauge.Set(value)
}

// IncrementCustomCounter increments a custom counter
func (m *EnhancedMetrics) IncrementCustomCounter(name string, help string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	counter, exists := m.customCounters[name]
	if !exists {
		counter = promauto.NewCounter(prometheus.CounterOpts{
			Name: name,
			Help: help,
		})
		m.customCounters[name] = counter
	}
	
	counter.Inc()
}

// GetMetricsSummary returns a summary of key metrics
func (m *EnhancedMetrics) GetMetricsSummary() map[string]interface{} {
	// Collect current values
	dto := &prometheus.Metric{}
	
	summary := make(map[string]interface{})
	
	// System metrics
	m.cpuUsage.Write(dto)
	summary["cpu_usage"] = dto.Gauge.GetValue()
	
	m.memoryUsage.Write(dto)
	summary["memory_bytes"] = dto.Gauge.GetValue()
	
	m.goroutines.Write(dto)
	summary["goroutines"] = dto.Gauge.GetValue()
	
	// Pool metrics
	m.poolHashrate.Write(dto)
	summary["pool_hashrate"] = dto.Gauge.GetValue()
	
	m.poolMiners.Write(dto)
	summary["active_miners"] = dto.Gauge.GetValue()
	
	m.poolEfficiency.Write(dto)
	summary["pool_efficiency"] = dto.Gauge.GetValue()
	
	// P2P metrics
	m.peersConnected.Write(dto)
	summary["peers_connected"] = dto.Gauge.GetValue()
	
	return summary
}