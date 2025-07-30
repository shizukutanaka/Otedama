package monitoring

import (
	"context"
	"runtime"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
)

// Monitor はシステムモニタリング
type Monitor struct {
	logger    *zap.Logger
	startTime time.Time
	metrics   *Metrics
	mu        sync.RWMutex
}

// Metrics はメトリクス
type Metrics struct {
	// カウンター
	totalHashes    prometheus.Counter
	blocksFound    prometheus.Counter
	sharesAccepted prometheus.Counter
	sharesRejected prometheus.Counter
	
	// ゲージ
	hashRate       prometheus.Gauge
	temperature    prometheus.Gauge
	powerUsage     prometheus.Gauge
	activePeers    prometheus.Gauge
	activeMiners   prometheus.Gauge
	
	// ヒストグラム
	shareLatency   prometheus.Histogram
	blockTime      prometheus.Histogram
}

// NewMonitor は新しいモニターを作成
func NewMonitor(logger *zap.Logger) *Monitor {
	m := &Monitor{
		logger:    logger,
		startTime: time.Now(),
		metrics:   createMetrics(),
	}
	
	// Prometheusにメトリクスを登録
	m.registerMetrics()
	
	return m
}

// createMetrics はメトリクスを作成
func createMetrics() *Metrics {
	return &Metrics{
		totalHashes: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "otedama_total_hashes",
			Help: "Total number of hashes computed",
		}),
		blocksFound: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "otedama_blocks_found_total",
			Help: "Total number of blocks found",
		}),
		sharesAccepted: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "otedama_shares_accepted_total",
			Help: "Total number of shares accepted",
		}),
		sharesRejected: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "otedama_shares_rejected_total",
			Help: "Total number of shares rejected",
		}),
		hashRate: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_hash_rate",
			Help: "Current hash rate in H/s",
		}),
		temperature: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_temperature_celsius",
			Help: "Current temperature in Celsius",
		}),
		powerUsage: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_power_usage_watts",
			Help: "Current power usage in watts",
		}),
		activePeers: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_active_peers",
			Help: "Number of active P2P peers",
		}),
		activeMiners: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "otedama_active_miners",
			Help: "Number of active miners",
		}),
		shareLatency: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "otedama_share_latency_seconds",
			Help:    "Share submission latency",
			Buckets: prometheus.DefBuckets,
		}),
		blockTime: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "otedama_block_time_seconds",
			Help:    "Time between blocks",
			Buckets: []float64{1, 5, 10, 30, 60, 300, 600},
		}),
	}
}

// registerMetrics はメトリクスをPrometheusに登録
func (m *Monitor) registerMetrics() {
	prometheus.MustRegister(
		m.metrics.totalHashes,
		m.metrics.blocksFound,
		m.metrics.sharesAccepted,
		m.metrics.sharesRejected,
		m.metrics.hashRate,
		m.metrics.temperature,
		m.metrics.powerUsage,
		m.metrics.activePeers,
		m.metrics.activeMiners,
		m.metrics.shareLatency,
		m.metrics.blockTime,
	)
}

// Start はモニタリングを開始
func (m *Monitor) Start(ctx context.Context) error {
	m.logger.Info("Starting monitoring")
	
	// システムメトリクス収集
	go m.collectSystemMetrics(ctx)
	
	return nil
}

// Stop はモニタリングを停止
func (m *Monitor) Stop() error {
	m.logger.Info("Stopping monitoring")
	return nil
}

// collectSystemMetrics はシステムメトリクスを収集
func (m *Monitor) collectSystemMetrics(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	// システムメトリクス用のGaugeを追加
	cpuGauge := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "otedama_cpu_usage_percent",
		Help: "CPU usage percentage",
	})
	memGauge := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "otedama_memory_usage_bytes",
		Help: "Memory usage in bytes",
	})
	goroutineGauge := prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "otedama_goroutines",
		Help: "Number of goroutines",
	})
	
	prometheus.MustRegister(cpuGauge, memGauge, goroutineGauge)
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.collectRealSystemMetrics(cpuGauge, memGauge, goroutineGauge)
		}
	}
}

// collectRealSystemMetrics は実際のシステムメトリクスを収集
func (m *Monitor) collectRealSystemMetrics(cpuGauge, memGauge, goroutineGauge prometheus.Gauge) {
	// メモリ使用量
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	memGauge.Set(float64(memStats.Alloc))
	
	// Goroutine数
	goroutineGauge.Set(float64(runtime.NumGoroutine()))
	
	// CPU使用率（簡易版）
	cpuUsage := m.getCPUUsage()
	cpuGauge.Set(cpuUsage)
	
	m.logger.Debug("System metrics collected",
		zap.Float64("cpu_usage", cpuUsage),
		zap.Uint64("memory_bytes", memStats.Alloc),
		zap.Int("goroutines", runtime.NumGoroutine()),
	)
}

// getCPUUsage はCPU使用率を取得（簡易版）
func (m *Monitor) getCPUUsage() float64 {
	// Go runtime統計からCPU時間を推定
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	
	// GCのCPU時間から推定（非常に簡易的）
	gcCPUFraction := stats.GCCPUFraction
	if gcCPUFraction > 1.0 {
		gcCPUFraction = 1.0
	}
	
	// プロセス全体のCPU使用率を推定
	// 実際の実装では /proc/stat や Windows APIを使用
	return gcCPUFraction * 100
}

// UpdateStats は統計情報を更新
func (m *Monitor) UpdateStats(stats map[string]interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	// ハッシュレート更新
	if hashRate, ok := stats["cpu_hashrate"].(uint64); ok {
		m.metrics.hashRate.Set(float64(hashRate))
	}
	
	// 温度更新
	if temp, ok := stats["gpu_temperature"].(int32); ok {
		m.metrics.temperature.Set(float64(temp))
	}
	
	// ピア数更新
	if peers, ok := stats["pool_peers"].(int); ok {
		m.metrics.activePeers.Set(float64(peers))
	}
	
	// マイナー数更新
	if miners, ok := stats["stratum_clients"].(int32); ok {
		m.metrics.activeMiners.Set(float64(miners))
	}
}

// RecordHash はハッシュをカウント
func (m *Monitor) RecordHash(count uint64) {
	m.metrics.totalHashes.Add(float64(count))
}

// RecordBlock はブロック発見を記録
func (m *Monitor) RecordBlock() {
	m.metrics.blocksFound.Inc()
}

// RecordShare はシェアを記録
func (m *Monitor) RecordShare(accepted bool, latency time.Duration) {
	if accepted {
		m.metrics.sharesAccepted.Inc()
	} else {
		m.metrics.sharesRejected.Inc()
	}
	m.metrics.shareLatency.Observe(latency.Seconds())
}

// StartTime は開始時刻を取得
func (m *Monitor) StartTime() time.Time {
	return m.startTime
}