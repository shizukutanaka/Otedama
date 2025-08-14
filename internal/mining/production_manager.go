package mining

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/monitoring"
	"go.uber.org/zap"
)

// ProductionManager implements production-grade mining operations
// following Carmack's "simple, fast, reliable" principles
// Martin's "clean architecture" patterns
// Pike's "less is more" philosophy
type ProductionManager struct {
	logger   *zap.Logger
	config   *config.MiningConfig
	mu       sync.RWMutex
	
	// Core components
	engine   *Engine
	monitor  *monitoring.Monitor
	metrics  *MetricsCollector
	
	// State management
	ctx      context.Context
	cancel   context.CancelFunc
	running  bool
	healthy  bool
	
	// Performance optimization
	cache    *CacheManager
	profiler *Profiler
	
	// Reliability features
	circuitBreaker *CircuitBreaker
	retryPolicy    *RetryPolicy
}

// NewProductionManager creates a production-ready mining manager
func NewProductionManager(logger *zap.Logger, cfg *config.MiningConfig) (*ProductionManager, error) {
	if logger == nil {
		return nil, fmt.Errorf("logger is required")
	}
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}

	ctx, cancel := context.WithCancel(context.Background())
	
	pm := &ProductionManager{
		logger:  logger,
		config:  cfg,
		ctx:     ctx,
		cancel:  cancel,
		healthy: true,
	}

	// Initialize core components with proper error handling
	if err := pm.initialize(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to initialize production manager: %w", err)
	}

	return pm, nil
}

// initialize sets up all production components
func (pm *ProductionManager) initialize() error {
	// Initialize monitoring first (fail fast)
	pm.monitor = monitoring.New(pm.logger)
	
	// Initialize metrics collection
	pm.metrics = NewMetricsCollector(pm.logger)
	
	// Initialize caching layer
	pm.cache = NewCacheManager(pm.config.CacheSize)
	
	// Initialize profiler for performance optimization
	pm.profiler = NewProfiler()
	
	// Initialize circuit breaker for reliability
	pm.circuitBreaker = NewCircuitBreaker(pm.logger)
	
	// Initialize retry policy
	pm.retryPolicy = NewRetryPolicy(pm.config.MaxRetries)

	// Initialize mining engine
	engine, err := NewEngine(pm.logger, pm.config)
	if err != nil {
		return fmt.Errorf("failed to create mining engine: %w", err)
	}
	pm.engine = engine

	return nil
}

// Start begins production mining operations
func (pm *ProductionManager) Start() error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if pm.running {
		return fmt.Errorf("production manager already running")
	}

	// Pre-start health checks
	if err := pm.healthCheck(); err != nil {
		return fmt.Errorf("health check failed: %w", err)
	}

	// Start monitoring
	pm.monitor.Start()

	// Start metrics collection
	pm.metrics.Start()

	// Start mining engine
	if err := pm.engine.Start(); err != nil {
		return fmt.Errorf("failed to start mining engine: %w", err)
	}

	// Start background tasks
	go pm.backgroundHealthCheck()
	go pm.backgroundMetricsCollection()
	go pm.backgroundPerformanceOptimization()

	pm.running = true
	pm.logger.Info("production mining manager started")

	return nil
}

// Stop gracefully shuts down mining operations
func (pm *ProductionManager) Stop() error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if !pm.running {
		return nil
	}

	// Signal shutdown
	pm.cancel()

	// Stop components in reverse order
	if pm.engine != nil {
		if err := pm.engine.Stop(); err != nil {
			pm.logger.Error("failed to stop mining engine", zap.Error(err))
		}
	}

	if pm.monitor != nil {
		pm.monitor.Stop()
	}

	if pm.metrics != nil {
		pm.metrics.Stop()
	}

	pm.running = false
	pm.logger.Info("production mining manager stopped")

	return nil
}

// GetStatus returns current production status
func (pm *ProductionManager) GetStatus() *ProductionStatus {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	status := &ProductionStatus{
		Running:   pm.running,
		Healthy:   pm.healthy,
		Timestamp: time.Now(),
		Uptime:    time.Since(pm.ctx.Value(startTimeKey{})), //nolint
	}

	if pm.engine != nil {
		status.EngineStatus = pm.engine.GetStatus()
	}

	if pm.metrics != nil {
		status.Metrics = pm.metrics.GetSnapshot()
	}

	return status
}

// healthCheck performs comprehensive system health validation
func (pm *ProductionManager) healthCheck() error {
	// Check system resources
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	if m.Alloc > pm.config.MaxMemoryBytes {
		return fmt.Errorf("memory usage exceeds limit: %d > %d", m.Alloc, pm.config.MaxMemoryBytes)
	}

	// Check CPU availability
	if runtime.NumCPU() < pm.config.MinCPUCores {
		return fmt.Errorf("insufficient CPU cores: %d < %d", runtime.NumCPU(), pm.config.MinCPUCores)
	}

	// Check disk space
	// Implementation depends on storage backend

	return nil
}

// backgroundHealthCheck runs continuous health monitoring
func (pm *ProductionManager) backgroundHealthCheck() {
	ticker := time.NewTicker(pm.config.HealthCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-pm.ctx.Done():
			return
		case <-ticker.C:
			if err := pm.healthCheck(); err != nil {
				pm.logger.Error("health check failed", zap.Error(err))
				pm.healthy = false
			} else {
				pm.healthy = true
			}
		}
	}
}

// backgroundMetricsCollection collects performance metrics
func (pm *ProductionManager) backgroundMetricsCollection() {
	ticker := time.NewTicker(pm.config.MetricsInterval)
	defer ticker.Stop()

	for {
		select {
		case <-pm.ctx.Done():
			return
		case <-ticker.C:
			pm.collectMetrics()
		}
	}
}

// backgroundPerformanceOptimization runs continuous optimization
func (pm *ProductionManager) backgroundPerformanceOptimization() {
	ticker := time.NewTicker(pm.config.OptimizationInterval)
	defer ticker.Stop()

	for {
		select {
		case <-pm.ctx.Done():
			return
		case <-ticker.C:
			pm.optimizePerformance()
		}
	}
}

// collectMetrics gathers system performance data
func (pm *ProductionManager) collectMetrics() {
	if pm.metrics == nil {
		return
	}

	// CPU metrics
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	metrics := &MetricsSnapshot{
		MemoryUsage:    m.Alloc,
		GCRuns:         m.NumGC,
		Goroutines:     runtime.NumGoroutine(),
		CPUCores:       runtime.NumCPU(),
		Timestamp:      time.Now(),
	}

	if pm.engine != nil {
		engineStats := pm.engine.GetStats()
		if engineStats != nil {
			metrics.HashRate = engineStats.TotalHashRate
			metrics.JobsProcessed = engineStats.JobsProcessed
			metrics.SharesFound = engineStats.SharesFound
		}
	}

	pm.metrics.Record(metrics)
}

// optimizePerformance applies runtime optimizations
func (pm *ProductionManager) optimizePerformance() {
	if pm.profiler == nil {
		return
	}

	// Trigger garbage collection if needed
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	if m.Alloc > pm.config.GCThreshold {
		runtime.GC()
		pm.logger.Debug("triggered garbage collection", zap.Uint64("alloc", m.Alloc))
	}

	// Optimize cache usage
	if pm.cache != nil {
		pm.cache.Optimize()
	}

	// Update performance metrics
	pm.profiler.Update()
}

// SubmitJob submits a mining job with production-grade error handling
func (pm *ProductionManager) SubmitJob(job *Job) error {
	return pm.circuitBreaker.Execute(func() error {
		if pm.engine == nil {
			return fmt.Errorf("mining engine not initialized")
		}
		
		return pm.retryPolicy.Execute(func() error {
			return pm.engine.SubmitJob(job)
		})
	})
}

// GetDevices returns all available mining devices
func (pm *ProductionManager) GetDevices() []DeviceInfo {
	if pm.engine == nil {
		return []DeviceInfo{}
	}
	
	return pm.engine.GetDevices()
}

// SetAlgorithm changes the mining algorithm with validation
func (pm *ProductionManager) SetAlgorithm(algorithm AlgorithmType) error {
	if pm.engine == nil {
		return fmt.Errorf("mining engine not initialized")
	}
	
	return pm.engine.SetAlgorithm(algorithm)
}

// ProductionStatus represents the current system status
type ProductionStatus struct {
	Running      bool           `json:"running"`
	Healthy      bool           `json:"healthy"`
	Timestamp    time.Time      `json:"timestamp"`
	Uptime       time.Duration  `json:"uptime"`
	EngineStatus *EngineStatus  `json:"engine_status,omitempty"`
	Metrics      *MetricsSnapshot `json:"metrics,omitempty"`
}

// MetricsSnapshot captures performance metrics
type MetricsSnapshot struct {
	MemoryUsage   uint64    `json:"memory_usage"`
	GCRuns        uint32    `json:"gc_runs"`
	Goroutines    int       `json:"goroutines"`
	CPUCores      int       `json:"cpu_cores"`
	HashRate      uint64    `json:"hash_rate"`
	JobsProcessed uint64    `json:"jobs_processed"`
	SharesFound   uint64    `json:"shares_found"`
	Timestamp     time.Time `json:"timestamp"`
}

// startTimeKey is used for uptime calculation
type startTimeKey struct{}

// String representation for debugging
func (pm *ProductionManager) String() string {
	status := pm.GetStatus()
	data, _ := json.MarshalIndent(status, "", "  ")
	return string(data)
}
