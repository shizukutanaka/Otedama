package monitoring

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

// MetricsExporter provides Prometheus metrics export functionality
type MetricsExporter struct {
	logger    *zap.Logger
	config    MetricsConfig
	server    *http.Server
	registry  *prometheus.Registry
	
	// Mining metrics
	hashrate           *prometheus.GaugeVec
	sharesSubmitted    *prometheus.CounterVec
	sharesAccepted     *prometheus.CounterVec
	sharesRejected     *prometheus.CounterVec
	blocksFound        *prometheus.CounterVec
	earnings           *prometheus.GaugeVec
	difficulty         *prometheus.GaugeVec
	
	// Hardware metrics
	temperature        *prometheus.GaugeVec
	fanSpeed           *prometheus.GaugeVec
	powerDraw          *prometheus.GaugeVec
	memoryUsage        *prometheus.GaugeVec
	gpuUtilization     *prometheus.GaugeVec
	
	// Network metrics
	peerCount          prometheus.Gauge
	connectionCount    *prometheus.GaugeVec
	networkLatency     *prometheus.HistogramVec
	bytesReceived      *prometheus.CounterVec
	bytesSent          *prometheus.CounterVec
	
	// System metrics
	cpuUsage           prometheus.Gauge
	memoryAlloc        prometheus.Gauge
	goroutines         prometheus.Gauge
	gcPauses           *prometheus.HistogramVec
	
	// Pool metrics
	poolHashrate       prometheus.Gauge
	poolMiners         prometheus.Gauge
	poolEfficiency     prometheus.Gauge
	poolShares         *prometheus.CounterVec
	poolPayouts        *prometheus.CounterVec
	
	// Custom metrics
	customGauges       map[string]*prometheus.GaugeVec
	customCounters     map[string]*prometheus.CounterVec
	customHistograms   map[string]*prometheus.HistogramVec
	mu                 sync.RWMutex
}

// MetricsConfig defines metrics exporter configuration
type MetricsConfig struct {
	Enabled        bool          `yaml:"enabled"`
	ListenAddr     string        `yaml:"listen_addr"`
	MetricsPath    string        `yaml:"metrics_path"`
	UpdateInterval time.Duration `yaml:"update_interval"`
	Namespace      string        `yaml:"namespace"`
	Subsystem      string        `yaml:"subsystem"`
}

// NewMetricsExporter creates a new metrics exporter
func NewMetricsExporter(logger *zap.Logger, config MetricsConfig) *MetricsExporter {
	// Set defaults
	if config.ListenAddr == "" {
		config.ListenAddr = ":9090"
	}
	if config.MetricsPath == "" {
		config.MetricsPath = "/metrics"
	}
	if config.UpdateInterval <= 0 {
		config.UpdateInterval = 10 * time.Second
	}
	if config.Namespace == "" {
		config.Namespace = "otedama"
	}

	registry := prometheus.NewRegistry()

	me := &MetricsExporter{
		logger:           logger,
		config:           config,
		registry:         registry,
		customGauges:     make(map[string]*prometheus.GaugeVec),
		customCounters:   make(map[string]*prometheus.CounterVec),
		customHistograms: make(map[string]*prometheus.HistogramVec),
	}

	// Initialize metrics
	me.initializeMetrics()

	return me
}

// Start begins metrics export
func (me *MetricsExporter) Start(ctx context.Context) error {
	if !me.config.Enabled {
		me.logger.Info("Metrics exporter disabled")
		return nil
	}

	// Create HTTP server
	mux := http.NewServeMux()
	mux.Handle(me.config.MetricsPath, promhttp.HandlerFor(me.registry, promhttp.HandlerOpts{
		ErrorHandling: promhttp.ContinueOnError,
	}))
	
	// Add health check endpoint
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	me.server = &http.Server{
		Addr:    me.config.ListenAddr,
		Handler: mux,
	}

	// Start server
	go func() {
		me.logger.Info("Starting metrics exporter",
			zap.String("address", me.config.ListenAddr),
			zap.String("path", me.config.MetricsPath),
		)
		
		if err := me.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			me.logger.Error("Metrics server error", zap.Error(err))
		}
	}()

	// Wait for shutdown
	<-ctx.Done()
	return me.Stop()
}

// Stop halts metrics export
func (me *MetricsExporter) Stop() error {
	if me.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		
		if err := me.server.Shutdown(ctx); err != nil {
			return fmt.Errorf("failed to shutdown metrics server: %w", err)
		}
	}
	
	me.logger.Info("Metrics exporter stopped")
	return nil
}

// UpdateMiningMetrics updates mining-related metrics
func (me *MetricsExporter) UpdateMiningMetrics(stats MiningStats) {
	me.hashrate.WithLabelValues(stats.Algorithm, stats.Worker).Set(stats.Hashrate)
	me.difficulty.WithLabelValues(stats.Algorithm).Set(stats.Difficulty)
	
	if stats.Earnings > 0 {
		me.earnings.WithLabelValues(stats.Currency).Set(stats.Earnings)
	}
}

// RecordShare records a mining share
func (me *MetricsExporter) RecordShare(algorithm, worker, result string) {
	me.sharesSubmitted.WithLabelValues(algorithm, worker).Inc()
	
	switch result {
	case "accepted":
		me.sharesAccepted.WithLabelValues(algorithm, worker).Inc()
	case "rejected":
		me.sharesRejected.WithLabelValues(algorithm, worker).Inc()
	}
}

// RecordBlock records a found block
func (me *MetricsExporter) RecordBlock(algorithm, worker string, reward float64) {
	me.blocksFound.WithLabelValues(algorithm, worker).Inc()
	me.earnings.WithLabelValues(algorithm).Add(reward)
}

// UpdateHardwareMetrics updates hardware-related metrics
func (me *MetricsExporter) UpdateHardwareMetrics(stats HardwareStats) {
	if stats.Temperature > 0 {
		me.temperature.WithLabelValues(stats.Device, stats.Type).Set(stats.Temperature)
	}
	if stats.FanSpeed > 0 {
		me.fanSpeed.WithLabelValues(stats.Device, stats.Type).Set(float64(stats.FanSpeed))
	}
	if stats.PowerDraw > 0 {
		me.powerDraw.WithLabelValues(stats.Device, stats.Type).Set(stats.PowerDraw)
	}
	if stats.MemoryUsage > 0 {
		me.memoryUsage.WithLabelValues(stats.Device, stats.Type).Set(float64(stats.MemoryUsage))
	}
	if stats.Utilization > 0 {
		me.gpuUtilization.WithLabelValues(stats.Device, stats.Type).Set(float64(stats.Utilization))
	}
}

// UpdateNetworkMetrics updates network-related metrics
func (me *MetricsExporter) UpdateNetworkMetrics(stats NetworkStats) {
	me.peerCount.Set(float64(stats.PeerCount))
	
	for connType, count := range stats.ConnectionCounts {
		me.connectionCount.WithLabelValues(connType).Set(float64(count))
	}
	
	if stats.BytesReceived > 0 {
		me.bytesReceived.WithLabelValues("total").Add(float64(stats.BytesReceived))
	}
	if stats.BytesSent > 0 {
		me.bytesSent.WithLabelValues("total").Add(float64(stats.BytesSent))
	}
}

// RecordNetworkLatency records network latency
func (me *MetricsExporter) RecordNetworkLatency(peerType string, latency time.Duration) {
	me.networkLatency.WithLabelValues(peerType).Observe(latency.Seconds())
}

// UpdateSystemMetrics updates system-related metrics
func (me *MetricsExporter) UpdateSystemMetrics(stats SystemStats) {
	me.cpuUsage.Set(stats.CPUUsage)
	me.memoryAlloc.Set(float64(stats.MemoryAlloc))
	me.goroutines.Set(float64(stats.Goroutines))
}

// RecordGCPause records a garbage collection pause
func (me *MetricsExporter) RecordGCPause(pauseType string, duration time.Duration) {
	me.gcPauses.WithLabelValues(pauseType).Observe(duration.Seconds())
}

// UpdatePoolMetrics updates pool-related metrics
func (me *MetricsExporter) UpdatePoolMetrics(stats PoolStats) {
	me.poolHashrate.Set(stats.Hashrate)
	me.poolMiners.Set(float64(stats.ActiveMiners))
	me.poolEfficiency.Set(stats.Efficiency)
}

// RecordPoolShare records a pool share
func (me *MetricsExporter) RecordPoolShare(miner, result string) {
	me.poolShares.WithLabelValues(miner, result).Inc()
}

// RecordPayout records a pool payout
func (me *MetricsExporter) RecordPayout(miner string, amount float64) {
	me.poolPayouts.WithLabelValues(miner).Add(amount)
}

// RegisterCustomGauge registers a custom gauge metric
func (me *MetricsExporter) RegisterCustomGauge(name, help string, labels []string) error {
	me.mu.Lock()
	defer me.mu.Unlock()

	if _, exists := me.customGauges[name]; exists {
		return fmt.Errorf("gauge %s already exists", name)
	}

	gauge := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: me.config.Subsystem,
		Name:      name,
		Help:      help,
	}, labels)

	if err := me.registry.Register(gauge); err != nil {
		return err
	}

	me.customGauges[name] = gauge
	return nil
}

// SetCustomGauge sets a custom gauge value
func (me *MetricsExporter) SetCustomGauge(name string, value float64, labels ...string) error {
	me.mu.RLock()
	gauge, exists := me.customGauges[name]
	me.mu.RUnlock()

	if !exists {
		return fmt.Errorf("gauge %s not found", name)
	}

	gauge.WithLabelValues(labels...).Set(value)
	return nil
}

// RegisterCustomCounter registers a custom counter metric
func (me *MetricsExporter) RegisterCustomCounter(name, help string, labels []string) error {
	me.mu.Lock()
	defer me.mu.Unlock()

	if _, exists := me.customCounters[name]; exists {
		return fmt.Errorf("counter %s already exists", name)
	}

	counter := prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: me.config.Subsystem,
		Name:      name,
		Help:      help,
	}, labels)

	if err := me.registry.Register(counter); err != nil {
		return err
	}

	me.customCounters[name] = counter
	return nil
}

// IncrementCustomCounter increments a custom counter
func (me *MetricsExporter) IncrementCustomCounter(name string, labels ...string) error {
	me.mu.RLock()
	counter, exists := me.customCounters[name]
	me.mu.RUnlock()

	if !exists {
		return fmt.Errorf("counter %s not found", name)
	}

	counter.WithLabelValues(labels...).Inc()
	return nil
}

// RegisterCustomHistogram registers a custom histogram metric
func (me *MetricsExporter) RegisterCustomHistogram(name, help string, labels []string, buckets []float64) error {
	me.mu.Lock()
	defer me.mu.Unlock()

	if _, exists := me.customHistograms[name]; exists {
		return fmt.Errorf("histogram %s already exists", name)
	}

	histogram := prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: me.config.Namespace,
		Subsystem: me.config.Subsystem,
		Name:      name,
		Help:      help,
		Buckets:   buckets,
	}, labels)

	if err := me.registry.Register(histogram); err != nil {
		return err
	}

	me.customHistograms[name] = histogram
	return nil
}

// ObserveCustomHistogram records an observation in a custom histogram
func (me *MetricsExporter) ObserveCustomHistogram(name string, value float64, labels ...string) error {
	me.mu.RLock()
	histogram, exists := me.customHistograms[name]
	me.mu.RUnlock()

	if !exists {
		return fmt.Errorf("histogram %s not found", name)
	}

	histogram.WithLabelValues(labels...).Observe(value)
	return nil
}

// Private methods

func (me *MetricsExporter) initializeMetrics() {
	// Mining metrics
	me.hashrate = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "mining",
		Name:      "hashrate_hashes_per_second",
		Help:      "Current mining hashrate in hashes per second",
	}, []string{"algorithm", "worker"})

	me.sharesSubmitted = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: "mining",
		Name:      "shares_submitted_total",
		Help:      "Total number of shares submitted",
	}, []string{"algorithm", "worker"})

	me.sharesAccepted = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: "mining",
		Name:      "shares_accepted_total",
		Help:      "Total number of shares accepted",
	}, []string{"algorithm", "worker"})

	me.sharesRejected = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: "mining",
		Name:      "shares_rejected_total",
		Help:      "Total number of shares rejected",
	}, []string{"algorithm", "worker"})

	me.blocksFound = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: "mining",
		Name:      "blocks_found_total",
		Help:      "Total number of blocks found",
	}, []string{"algorithm", "worker"})

	me.earnings = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "mining",
		Name:      "earnings_total",
		Help:      "Total earnings from mining",
	}, []string{"currency"})

	me.difficulty = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "mining",
		Name:      "difficulty",
		Help:      "Current mining difficulty",
	}, []string{"algorithm"})

	// Hardware metrics
	me.temperature = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "hardware",
		Name:      "temperature_celsius",
		Help:      "Hardware temperature in Celsius",
	}, []string{"device", "type"})

	me.fanSpeed = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "hardware",
		Name:      "fan_speed_percent",
		Help:      "Fan speed percentage",
	}, []string{"device", "type"})

	me.powerDraw = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "hardware",
		Name:      "power_watts",
		Help:      "Power consumption in watts",
	}, []string{"device", "type"})

	me.memoryUsage = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "hardware",
		Name:      "memory_usage_bytes",
		Help:      "Memory usage in bytes",
	}, []string{"device", "type"})

	me.gpuUtilization = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "hardware",
		Name:      "gpu_utilization_percent",
		Help:      "GPU utilization percentage",
	}, []string{"device", "type"})

	// Network metrics
	me.peerCount = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "network",
		Name:      "peers_total",
		Help:      "Total number of connected peers",
	})

	me.connectionCount = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "network",
		Name:      "connections_total",
		Help:      "Total number of connections by type",
	}, []string{"type"})

	me.networkLatency = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: me.config.Namespace,
		Subsystem: "network",
		Name:      "latency_seconds",
		Help:      "Network latency in seconds",
		Buckets:   prometheus.DefBuckets,
	}, []string{"peer_type"})

	me.bytesReceived = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: "network",
		Name:      "bytes_received_total",
		Help:      "Total bytes received",
	}, []string{"type"})

	me.bytesSent = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: "network",
		Name:      "bytes_sent_total",
		Help:      "Total bytes sent",
	}, []string{"type"})

	// System metrics
	me.cpuUsage = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "system",
		Name:      "cpu_usage_percent",
		Help:      "CPU usage percentage",
	})

	me.memoryAlloc = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "system",
		Name:      "memory_alloc_bytes",
		Help:      "Allocated memory in bytes",
	})

	me.goroutines = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "system",
		Name:      "goroutines_total",
		Help:      "Total number of goroutines",
	})

	me.gcPauses = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: me.config.Namespace,
		Subsystem: "system",
		Name:      "gc_pause_seconds",
		Help:      "Garbage collection pause duration",
		Buckets:   prometheus.DefBuckets,
	}, []string{"type"})

	// Pool metrics
	me.poolHashrate = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "pool",
		Name:      "hashrate_total",
		Help:      "Total pool hashrate",
	})

	me.poolMiners = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "pool",
		Name:      "miners_active",
		Help:      "Number of active miners",
	})

	me.poolEfficiency = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: me.config.Namespace,
		Subsystem: "pool",
		Name:      "efficiency_percent",
		Help:      "Pool efficiency percentage",
	})

	me.poolShares = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: "pool",
		Name:      "shares_total",
		Help:      "Total pool shares",
	}, []string{"miner", "result"})

	me.poolPayouts = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: me.config.Namespace,
		Subsystem: "pool",
		Name:      "payouts_total",
		Help:      "Total payouts",
	}, []string{"miner"})

	// Register all metrics
	me.registry.MustRegister(
		// Mining
		me.hashrate,
		me.sharesSubmitted,
		me.sharesAccepted,
		me.sharesRejected,
		me.blocksFound,
		me.earnings,
		me.difficulty,
		// Hardware
		me.temperature,
		me.fanSpeed,
		me.powerDraw,
		me.memoryUsage,
		me.gpuUtilization,
		// Network
		me.peerCount,
		me.connectionCount,
		me.networkLatency,
		me.bytesReceived,
		me.bytesSent,
		// System
		me.cpuUsage,
		me.memoryAlloc,
		me.goroutines,
		me.gcPauses,
		// Pool
		me.poolHashrate,
		me.poolMiners,
		me.poolEfficiency,
		me.poolShares,
		me.poolPayouts,
	)

	// Register standard Go metrics
	me.registry.MustRegister(prometheus.NewGoCollector())
}

// Stats structures

// MiningStats contains mining statistics
type MiningStats struct {
	Algorithm  string
	Worker     string
	Hashrate   float64
	Difficulty float64
	Earnings   float64
	Currency   string
}

// HardwareStats contains hardware statistics
type HardwareStats struct {
	Device      string
	Type        string
	Temperature float64
	FanSpeed    int
	PowerDraw   float64
	MemoryUsage int64
	Utilization int
}

// NetworkStats contains network statistics
type NetworkStats struct {
	PeerCount        int
	ConnectionCounts map[string]int
	BytesReceived    int64
	BytesSent        int64
}

// SystemStats contains system statistics
type SystemStats struct {
	CPUUsage    float64
	MemoryAlloc int64
	Goroutines  int
}

// PoolStats contains pool statistics
type PoolStats struct {
	Hashrate     float64
	ActiveMiners int
	Efficiency   float64
}
