package automation

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestMonitoringSystem_Creation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval:    1 * time.Second,
		RetentionPeriod:    24 * time.Hour,
		EnableAlerts:       true,
		EnableAnomalyDetection: true,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)
	assert.NotNil(t, ms)
}

func TestMonitoringSystem_StartStop(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval: 100 * time.Millisecond,
		RetentionPeriod: 1 * time.Hour,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)

	// Start monitoring
	err = ms.Start()
	assert.NoError(t, err)

	// Should be running
	assert.True(t, ms.running.Load())

	// Stop monitoring
	err = ms.Stop()
	assert.NoError(t, err)

	// Should not be running
	assert.False(t, ms.running.Load())
}

func TestMonitoringSystem_MetricCollection(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval: 50 * time.Millisecond,
		RetentionPeriod: 1 * time.Hour,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)

	err = ms.Start()
	require.NoError(t, err)
	defer ms.Stop()

	// Record some metrics
	ms.RecordMetric("cpu_usage", 45.5, map[string]string{"host": "node1"})
	ms.RecordMetric("memory_usage", 78.2, map[string]string{"host": "node1"})
	ms.RecordMetric("request_count", 100, map[string]string{"endpoint": "/api/v1"})

	// Wait for metrics to be processed
	time.Sleep(100 * time.Millisecond)

	// Query metrics
	ctx := context.Background()
	
	cpuMetrics, err := ms.QueryMetrics(ctx, "cpu_usage", time.Now().Add(-1*time.Minute), time.Now())
	assert.NoError(t, err)
	assert.NotEmpty(t, cpuMetrics)
	assert.Equal(t, 45.5, cpuMetrics[0].Value)

	memMetrics, err := ms.QueryMetrics(ctx, "memory_usage", time.Now().Add(-1*time.Minute), time.Now())
	assert.NoError(t, err)
	assert.NotEmpty(t, memMetrics)
	assert.Equal(t, 78.2, memMetrics[0].Value)
}

func TestMonitoringSystem_Aggregation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval: 50 * time.Millisecond,
		RetentionPeriod: 1 * time.Hour,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)

	err = ms.Start()
	require.NoError(t, err)
	defer ms.Stop()

	// Record multiple values for aggregation
	for i := 0; i < 10; i++ {
		ms.RecordMetric("response_time", float64(100+i*10), map[string]string{"service": "api"})
		time.Sleep(10 * time.Millisecond)
	}

	// Wait for processing
	time.Sleep(100 * time.Millisecond)

	// Get aggregated stats
	stats := ms.GetAggregatedStats("response_time", time.Now().Add(-1*time.Minute), time.Now())
	
	assert.Greater(t, stats.Count, 0)
	assert.Greater(t, stats.Mean, 0.0)
	assert.GreaterOrEqual(t, stats.Max, stats.Min)
}

func TestMonitoringSystem_Alerting(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval: 50 * time.Millisecond,
		RetentionPeriod: 1 * time.Hour,
		EnableAlerts:    true,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)

	err = ms.Start()
	require.NoError(t, err)
	defer ms.Stop()

	// Create alert rule
	alertRule := &AlertRule{
		ID:          "high-cpu",
		Name:        "High CPU Usage",
		Metric:      "cpu_usage",
		Condition:   "greater_than",
		Threshold:   80.0,
		Duration:    100 * time.Millisecond,
		Severity:    "critical",
		Actions:     []string{"notify"},
	}

	err = ms.AddAlertRule(alertRule)
	assert.NoError(t, err)

	// Track alert count
	alertCount := atomic.Int32{}
	ms.SetAlertHandler(func(alert *Alert) {
		alertCount.Add(1)
	})

	// Trigger alert with high CPU
	ms.RecordMetric("cpu_usage", 85.0, map[string]string{"host": "node1"})
	ms.RecordMetric("cpu_usage", 90.0, map[string]string{"host": "node1"})

	// Wait for alert to trigger
	time.Sleep(200 * time.Millisecond)

	// Should have triggered alert
	assert.Greater(t, alertCount.Load(), int32(0))

	// Check active alerts
	activeAlerts := ms.GetActiveAlerts()
	assert.NotEmpty(t, activeAlerts)
}

func TestMonitoringSystem_AnomalyDetection(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval:        50 * time.Millisecond,
		RetentionPeriod:        1 * time.Hour,
		EnableAnomalyDetection: true,
		AnomalyDetection: AnomalyDetectionConfig{
			Algorithm:         "zscore",
			Sensitivity:       2.5,
			TrainingPeriod:    5 * time.Minute,
			MinDataPoints:     10,
		},
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)

	err = ms.Start()
	require.NoError(t, err)
	defer ms.Stop()

	// Record normal pattern
	for i := 0; i < 20; i++ {
		value := 50.0 + float64(i%5) // Normal range 50-54
		ms.RecordMetric("request_rate", value, map[string]string{"service": "api"})
		time.Sleep(10 * time.Millisecond)
	}

	// Track anomalies
	anomalyCount := atomic.Int32{}
	ms.SetAnomalyHandler(func(anomaly *Anomaly) {
		anomalyCount.Add(1)
	})

	// Record anomalous values
	ms.RecordMetric("request_rate", 150.0, map[string]string{"service": "api"}) // Spike
	ms.RecordMetric("request_rate", 5.0, map[string]string{"service": "api"})   // Drop

	// Wait for anomaly detection
	time.Sleep(200 * time.Millisecond)

	// Should detect anomalies
	assert.Greater(t, anomalyCount.Load(), int32(0))
}

func TestMonitoringSystem_ConcurrentMetrics(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval: 50 * time.Millisecond,
		RetentionPeriod: 1 * time.Hour,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)

	err = ms.Start()
	require.NoError(t, err)
	defer ms.Stop()

	// Record metrics from multiple goroutines
	var wg sync.WaitGroup
	numGoroutines := 10
	metricsPerGoroutine := 100

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			
			for j := 0; j < metricsPerGoroutine; j++ {
				ms.RecordMetric(
					"concurrent_metric",
					float64(id*100+j),
					map[string]string{"goroutine": fmt.Sprintf("%d", id)},
				)
			}
		}(i)
	}

	wg.Wait()

	// Wait for processing
	time.Sleep(100 * time.Millisecond)

	// Query all metrics
	ctx := context.Background()
	metrics, err := ms.QueryMetrics(ctx, "concurrent_metric", time.Now().Add(-1*time.Minute), time.Now())
	assert.NoError(t, err)
	assert.GreaterOrEqual(t, len(metrics), numGoroutines*metricsPerGoroutine/2) // At least half should be recorded
}

func TestMonitoringSystem_MetricRetention(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval: 50 * time.Millisecond,
		RetentionPeriod: 200 * time.Millisecond, // Very short for testing
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)

	err = ms.Start()
	require.NoError(t, err)
	defer ms.Stop()

	// Record metric
	ms.RecordMetric("old_metric", 100.0, map[string]string{"test": "retention"})

	// Wait for metric to be recorded
	time.Sleep(100 * time.Millisecond)

	// Verify metric exists
	ctx := context.Background()
	metrics, err := ms.QueryMetrics(ctx, "old_metric", time.Now().Add(-1*time.Second), time.Now())
	assert.NoError(t, err)
	assert.NotEmpty(t, metrics)

	// Wait for retention period to pass
	time.Sleep(300 * time.Millisecond)

	// Metric should be cleaned up
	metrics, err = ms.QueryMetrics(ctx, "old_metric", time.Now().Add(-1*time.Second), time.Now())
	assert.NoError(t, err)
	assert.Empty(t, metrics)
}

func TestMonitoringSystem_Dashboard(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &MonitoringConfig{
		MetricsInterval:  50 * time.Millisecond,
		RetentionPeriod:  1 * time.Hour,
		EnableDashboard:  true,
		DashboardPort:    0, // Random port
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(t, err)

	err = ms.Start()
	require.NoError(t, err)
	defer ms.Stop()

	// Record some metrics for dashboard
	ms.RecordMetric("dashboard_test", 42.0, map[string]string{"type": "test"})

	// Get dashboard URL
	dashboardURL := ms.GetDashboardURL()
	assert.NotEmpty(t, dashboardURL)
	assert.Contains(t, dashboardURL, "http://")
}

// Benchmark tests

func BenchmarkMonitoringSystem_RecordMetric(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := &MonitoringConfig{
		MetricsInterval: 100 * time.Millisecond,
		RetentionPeriod: 1 * time.Hour,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(b, err)

	err = ms.Start()
	require.NoError(b, err)
	defer ms.Stop()

	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		ms.RecordMetric("benchmark_metric", float64(i), map[string]string{"bench": "true"})
	}
}

func BenchmarkMonitoringSystem_ConcurrentRecord(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := &MonitoringConfig{
		MetricsInterval: 100 * time.Millisecond,
		RetentionPeriod: 1 * time.Hour,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(b, err)

	err = ms.Start()
	require.NoError(b, err)
	defer ms.Stop()

	b.ResetTimer()

	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			ms.RecordMetric("concurrent_bench", float64(i), map[string]string{"thread": "parallel"})
			i++
		}
	})
}

func BenchmarkMonitoringSystem_QueryMetrics(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := &MonitoringConfig{
		MetricsInterval: 100 * time.Millisecond,
		RetentionPeriod: 1 * time.Hour,
	}

	ms, err := NewMonitoringSystem(logger, config)
	require.NoError(b, err)

	err = ms.Start()
	require.NoError(b, err)
	defer ms.Stop()

	// Pre-populate with metrics
	for i := 0; i < 1000; i++ {
		ms.RecordMetric("query_bench", float64(i), map[string]string{"id": fmt.Sprintf("%d", i)})
	}

	time.Sleep(200 * time.Millisecond)

	ctx := context.Background()
	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		ms.QueryMetrics(ctx, "query_bench", time.Now().Add(-1*time.Hour), time.Now())
	}
}