package monitoring

import (
	"context"
	"fmt"
	"runtime"
	"runtime/pprof"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// PerformanceProfiler provides real-time performance profiling and bottleneck detection
// Following John Carmack's principle: "Profile, don't speculate"
type PerformanceProfiler struct {
	logger *zap.Logger
	config *ProfilerConfig
	
	// Profiling components
	cpuProfiler      *CPUProfiler
	memoryProfiler   *MemoryProfiler
	goroutineProfiler *GoroutineProfiler
	ioProfiler       *IOProfiler
	
	// Performance tracking
	metrics          *PerformanceMetrics
	bottlenecks      *BottleneckDetector
	
	// Trace collection
	traceCollector   *TraceCollector
	
	// Lifecycle
	ctx              context.Context
	cancel           context.CancelFunc
	wg               sync.WaitGroup
}

// ProfilerConfig contains profiler configuration
type ProfilerConfig struct {
	// Profiling settings
	EnableCPUProfile      bool
	EnableMemProfile      bool
	EnableBlockProfile    bool
	EnableMutexProfile    bool
	EnableGoroutineProfile bool
	
	// Sampling rates
	CPUSampleRate         int
	MemSampleRate         int
	BlockProfileRate      int
	MutexProfileFraction  int
	
	// Collection intervals
	ProfileInterval       time.Duration
	MetricsInterval       time.Duration
	
	// Analysis settings
	BottleneckThreshold   float64
	AnomalyDetection      bool
	AutoOptimization      bool
	
	// Storage
	ProfileDir            string
	RetentionPeriod       time.Duration
}

// PerformanceMetrics tracks system performance metrics
type PerformanceMetrics struct {
	// CPU metrics
	CPUUsage          atomic.Uint64 // Percentage * 100
	CPUCores          int
	GoroutineCount    atomic.Int32
	
	// Memory metrics
	HeapAlloc         atomic.Uint64
	HeapSys           atomic.Uint64
	GCCount           atomic.Uint32
	GCPauseTotal      atomic.Uint64 // Nanoseconds
	
	// Throughput metrics
	RequestsPerSec    atomic.Uint64
	HashesPerSec      atomic.Uint64
	SharesPerSec      atomic.Uint64
	
	// Latency metrics
	AvgResponseTime   atomic.Uint64 // Nanoseconds
	P50ResponseTime   atomic.Uint64
	P95ResponseTime   atomic.Uint64
	P99ResponseTime   atomic.Uint64
}

// BottleneckDetector identifies performance bottlenecks
type BottleneckDetector struct {
	bottlenecks     []Bottleneck
	bottlenecksMu   sync.RWMutex
	threshold       float64
	history         *MetricsHistory
}

// Bottleneck represents a detected performance bottleneck
type Bottleneck struct {
	Type            BottleneckType
	Component       string
	Severity        float64
	Description     string
	Recommendation  string
	DetectedAt      time.Time
	Metrics         map[string]float64
}

// BottleneckType represents types of bottlenecks
type BottleneckType string

const (
	BottleneckCPU        BottleneckType = "cpu"
	BottleneckMemory     BottleneckType = "memory"
	BottleneckIO         BottleneckType = "io"
	BottleneckNetwork    BottleneckType = "network"
	BottleneckLock       BottleneckType = "lock_contention"
	BottleneckGoroutine  BottleneckType = "goroutine_leak"
)

// NewPerformanceProfiler creates a new performance profiler
func NewPerformanceProfiler(logger *zap.Logger, config *ProfilerConfig) *PerformanceProfiler {
	if config == nil {
		config = DefaultProfilerConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	pp := &PerformanceProfiler{
		logger:            logger,
		config:            config,
		cpuProfiler:       NewCPUProfiler(logger),
		memoryProfiler:    NewMemoryProfiler(logger),
		goroutineProfiler: NewGoroutineProfiler(logger),
		ioProfiler:        NewIOProfiler(logger),
		metrics:           &PerformanceMetrics{CPUCores: runtime.NumCPU()},
		bottlenecks:       NewBottleneckDetector(config.BottleneckThreshold),
		traceCollector:    NewTraceCollector(),
		ctx:               ctx,
		cancel:            cancel,
	}
	
	return pp
}

// Start starts the performance profiler
func (pp *PerformanceProfiler) Start() error {
	pp.logger.Info("Starting performance profiler",
		zap.Bool("cpu_profile", pp.config.EnableCPUProfile),
		zap.Bool("mem_profile", pp.config.EnableMemProfile),
		zap.Bool("anomaly_detection", pp.config.AnomalyDetection),
	)
	
	// Configure runtime profiling
	if pp.config.EnableBlockProfile {
		runtime.SetBlockProfileRate(pp.config.BlockProfileRate)
	}
	
	if pp.config.EnableMutexProfile {
		runtime.SetMutexProfileFraction(pp.config.MutexProfileFraction)
	}
	
	// Start profiling goroutines
	pp.wg.Add(1)
	go pp.profilingLoop()
	
	pp.wg.Add(1)
	go pp.metricsLoop()
	
	pp.wg.Add(1)
	go pp.analysisLoop()
	
	return nil
}

// Stop stops the performance profiler
func (pp *PerformanceProfiler) Stop() error {
	pp.logger.Info("Stopping performance profiler")
	
	pp.cancel()
	pp.wg.Wait()
	
	// Reset runtime profiling
	runtime.SetBlockProfileRate(0)
	runtime.SetMutexProfileFraction(0)
	
	return nil
}

// RecordOperation records a timed operation
func (pp *PerformanceProfiler) RecordOperation(operation string, duration time.Duration) {
	pp.traceCollector.Record(operation, duration)
	
	// Update response time metrics
	durationNanos := uint64(duration.Nanoseconds())
	pp.updateResponseTimeMetrics(durationNanos)
}

// GetBottlenecks returns current bottlenecks
func (pp *PerformanceProfiler) GetBottlenecks() []Bottleneck {
	return pp.bottlenecks.GetCurrent()
}

// GetMetrics returns current performance metrics
func (pp *PerformanceProfiler) GetMetrics() PerformanceReport {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	return PerformanceReport{
		CPUUsage:         float64(pp.metrics.CPUUsage.Load()) / 100.0,
		CPUCores:         pp.metrics.CPUCores,
		GoroutineCount:   int(pp.metrics.GoroutineCount.Load()),
		HeapAlloc:        pp.metrics.HeapAlloc.Load(),
		HeapSys:          pp.metrics.HeapSys.Load(),
		GCCount:          pp.metrics.GCCount.Load(),
		GCPauseTotal:     time.Duration(pp.metrics.GCPauseTotal.Load()),
		RequestsPerSec:   pp.metrics.RequestsPerSec.Load(),
		HashesPerSec:     pp.metrics.HashesPerSec.Load(),
		SharesPerSec:     pp.metrics.SharesPerSec.Load(),
		AvgResponseTime:  time.Duration(pp.metrics.AvgResponseTime.Load()),
		P50ResponseTime:  time.Duration(pp.metrics.P50ResponseTime.Load()),
		P95ResponseTime:  time.Duration(pp.metrics.P95ResponseTime.Load()),
		P99ResponseTime:  time.Duration(pp.metrics.P99ResponseTime.Load()),
		Bottlenecks:      pp.GetBottlenecks(),
		Timestamp:        time.Now(),
	}
}

// Private methods

func (pp *PerformanceProfiler) profilingLoop() {
	defer pp.wg.Done()
	
	ticker := time.NewTicker(pp.config.ProfileInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			pp.collectProfiles()
			
		case <-pp.ctx.Done():
			return
		}
	}
}

func (pp *PerformanceProfiler) metricsLoop() {
	defer pp.wg.Done()
	
	ticker := time.NewTicker(pp.config.MetricsInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			pp.collectMetrics()
			
		case <-pp.ctx.Done():
			return
		}
	}
}

func (pp *PerformanceProfiler) analysisLoop() {
	defer pp.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			pp.analyzePerformance()
			
		case <-pp.ctx.Done():
			return
		}
	}
}

func (pp *PerformanceProfiler) collectProfiles() {
	// CPU profiling
	if pp.config.EnableCPUProfile {
		profile := pp.cpuProfiler.Collect(pp.config.ProfileInterval)
		if profile != nil {
			// Analyze CPU profile for hot spots
			hotSpots := pp.cpuProfiler.FindHotSpots(profile)
			for _, spot := range hotSpots {
				if spot.Percentage > pp.config.BottleneckThreshold {
					pp.bottlenecks.Add(Bottleneck{
						Type:           BottleneckCPU,
						Component:      spot.Function,
						Severity:       spot.Percentage,
						Description:    fmt.Sprintf("CPU hot spot: %.1f%% in %s", spot.Percentage, spot.Function),
						Recommendation: "Consider optimizing this function or parallelizing the work",
						DetectedAt:     time.Now(),
					})
				}
			}
		}
	}
	
	// Memory profiling
	if pp.config.EnableMemProfile {
		profile := pp.memoryProfiler.Collect()
		if profile != nil {
			// Analyze memory allocations
			allocators := pp.memoryProfiler.FindTopAllocators(profile)
			for _, alloc := range allocators {
				if alloc.Percentage > pp.config.BottleneckThreshold {
					pp.bottlenecks.Add(Bottleneck{
						Type:           BottleneckMemory,
						Component:      alloc.Function,
						Severity:       alloc.Percentage,
						Description:    fmt.Sprintf("High memory allocation: %.1f%% in %s", alloc.Percentage, alloc.Function),
						Recommendation: "Consider using object pools or reducing allocations",
						DetectedAt:     time.Now(),
					})
				}
			}
		}
	}
	
	// Goroutine profiling
	if pp.config.EnableGoroutineProfile {
		profile := pp.goroutineProfiler.Collect()
		if profile != nil {
			// Check for goroutine leaks
			if profile.Count > 10000 {
				pp.bottlenecks.Add(Bottleneck{
					Type:           BottleneckGoroutine,
					Component:      "system",
					Severity:       float64(profile.Count) / 10000.0,
					Description:    fmt.Sprintf("High goroutine count: %d", profile.Count),
					Recommendation: "Check for goroutine leaks or implement worker pools",
					DetectedAt:     time.Now(),
				})
			}
		}
	}
}

func (pp *PerformanceProfiler) collectMetrics() {
	// CPU metrics
	cpuUsage := pp.calculateCPUUsage()
	pp.metrics.CPUUsage.Store(uint64(cpuUsage * 100))
	
	// Memory metrics
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	pp.metrics.HeapAlloc.Store(memStats.HeapAlloc)
	pp.metrics.HeapSys.Store(memStats.HeapSys)
	pp.metrics.GCCount.Store(memStats.NumGC)
	pp.metrics.GCPauseTotal.Store(memStats.PauseTotalNs)
	
	// Goroutine metrics
	pp.metrics.GoroutineCount.Store(int32(runtime.NumGoroutine()))
	
	// Throughput metrics are updated by other components
}

func (pp *PerformanceProfiler) analyzePerformance() {
	// Analyze for anomalies if enabled
	if pp.config.AnomalyDetection {
		pp.detectAnomalies()
	}
	
	// Check for common bottlenecks
	pp.checkCPUBottleneck()
	pp.checkMemoryBottleneck()
	pp.checkGCBottleneck()
	pp.checkLockContention()
}

func (pp *PerformanceProfiler) detectAnomalies() {
	// Use historical data to detect anomalies
	cpuUsage := float64(pp.metrics.CPUUsage.Load()) / 100.0
	historicalCPU := pp.bottlenecks.history.GetAverageCPU()
	
	if cpuUsage > historicalCPU*1.5 {
		pp.bottlenecks.Add(Bottleneck{
			Type:           BottleneckCPU,
			Component:      "system",
			Severity:       cpuUsage,
			Description:    fmt.Sprintf("CPU usage anomaly: %.1f%% (normal: %.1f%%)", cpuUsage*100, historicalCPU*100),
			Recommendation: "Investigate recent changes or increased load",
			DetectedAt:     time.Now(),
		})
	}
}

func (pp *PerformanceProfiler) checkCPUBottleneck() {
	cpuUsage := float64(pp.metrics.CPUUsage.Load()) / 100.0
	
	if cpuUsage > pp.config.BottleneckThreshold {
		pp.bottlenecks.Add(Bottleneck{
			Type:           BottleneckCPU,
			Component:      "system",
			Severity:       cpuUsage,
			Description:    fmt.Sprintf("High CPU usage: %.1f%%", cpuUsage*100),
			Recommendation: "Scale horizontally or optimize CPU-intensive operations",
			DetectedAt:     time.Now(),
			Metrics: map[string]float64{
				"cpu_usage":      cpuUsage,
				"cpu_cores":      float64(pp.metrics.CPUCores),
				"goroutine_count": float64(pp.metrics.GoroutineCount.Load()),
			},
		})
	}
}

func (pp *PerformanceProfiler) checkMemoryBottleneck() {
	heapAlloc := pp.metrics.HeapAlloc.Load()
	heapSys := pp.metrics.HeapSys.Load()
	
	if heapSys > 0 {
		usageRatio := float64(heapAlloc) / float64(heapSys)
		if usageRatio > pp.config.BottleneckThreshold {
			pp.bottlenecks.Add(Bottleneck{
				Type:           BottleneckMemory,
				Component:      "heap",
				Severity:       usageRatio,
				Description:    fmt.Sprintf("High memory usage: %.1f%% of system memory", usageRatio*100),
				Recommendation: "Investigate memory leaks or implement memory pooling",
				DetectedAt:     time.Now(),
				Metrics: map[string]float64{
					"heap_alloc": float64(heapAlloc),
					"heap_sys":   float64(heapSys),
				},
			})
		}
	}
}

func (pp *PerformanceProfiler) checkGCBottleneck() {
	gcCount := pp.metrics.GCCount.Load()
	gcPauseTotal := time.Duration(pp.metrics.GCPauseTotal.Load())
	
	if gcCount > 0 {
		avgPause := gcPauseTotal / time.Duration(gcCount)
		if avgPause > 10*time.Millisecond {
			pp.bottlenecks.Add(Bottleneck{
				Type:           BottleneckMemory,
				Component:      "gc",
				Severity:       float64(avgPause.Milliseconds()) / 10.0,
				Description:    fmt.Sprintf("High GC pause time: %v average", avgPause),
				Recommendation: "Reduce allocations or tune GOGC settings",
				DetectedAt:     time.Now(),
			})
		}
	}
}

func (pp *PerformanceProfiler) checkLockContention() {
	// Check mutex profile if enabled
	if pp.config.EnableMutexProfile {
		profile := pprof.Lookup("mutex")
		if profile != nil && profile.Count() > 1000 {
			pp.bottlenecks.Add(Bottleneck{
				Type:           BottleneckLock,
				Component:      "mutex",
				Severity:       float64(profile.Count()) / 1000.0,
				Description:    fmt.Sprintf("High lock contention: %d contentions", profile.Count()),
				Recommendation: "Use lock-free data structures or reduce critical sections",
				DetectedAt:     time.Now(),
			})
		}
	}
}

func (pp *PerformanceProfiler) calculateCPUUsage() float64 {
	// Simplified CPU usage calculation
	// In production, use more accurate system-specific methods
	return 0.5 // Placeholder
}

func (pp *PerformanceProfiler) updateResponseTimeMetrics(duration uint64) {
	// Update average (simplified - should use running average)
	current := pp.metrics.AvgResponseTime.Load()
	if current == 0 {
		pp.metrics.AvgResponseTime.Store(duration)
	} else {
		// Simple moving average
		newAvg := (current*9 + duration) / 10
		pp.metrics.AvgResponseTime.Store(newAvg)
	}
	
	// Update percentiles (simplified - should use proper percentile calculation)
	pp.metrics.P50ResponseTime.Store(duration)
	pp.metrics.P95ResponseTime.Store(duration * 2)
	pp.metrics.P99ResponseTime.Store(duration * 3)
}

// Helper components

// CPUProfiler handles CPU profiling
type CPUProfiler struct {
	logger *zap.Logger
}

func NewCPUProfiler(logger *zap.Logger) *CPUProfiler {
	return &CPUProfiler{logger: logger}
}

func (cp *CPUProfiler) Collect(duration time.Duration) *pprof.Profile {
	// Simplified CPU profile collection
	return pprof.Lookup("cpu")
}

func (cp *CPUProfiler) FindHotSpots(profile *pprof.Profile) []HotSpot {
	// Analyze profile for hot spots
	return []HotSpot{}
}

// MemoryProfiler handles memory profiling
type MemoryProfiler struct {
	logger *zap.Logger
}

func NewMemoryProfiler(logger *zap.Logger) *MemoryProfiler {
	return &MemoryProfiler{logger: logger}
}

func (mp *MemoryProfiler) Collect() *pprof.Profile {
	return pprof.Lookup("heap")
}

func (mp *MemoryProfiler) FindTopAllocators(profile *pprof.Profile) []Allocator {
	return []Allocator{}
}

// GoroutineProfiler handles goroutine profiling
type GoroutineProfiler struct {
	logger *zap.Logger
}

func NewGoroutineProfiler(logger *zap.Logger) *GoroutineProfiler {
	return &GoroutineProfiler{logger: logger}
}

func (gp *GoroutineProfiler) Collect() *GoroutineProfile {
	return &GoroutineProfile{
		Count: runtime.NumGoroutine(),
	}
}

// IOProfiler handles I/O profiling
type IOProfiler struct {
	logger *zap.Logger
}

func NewIOProfiler(logger *zap.Logger) *IOProfiler {
	return &IOProfiler{logger: logger}
}

// TraceCollector collects execution traces
type TraceCollector struct {
	traces []Trace
	mu     sync.Mutex
}

func NewTraceCollector() *TraceCollector {
	return &TraceCollector{
		traces: make([]Trace, 0, 10000),
	}
}

func (tc *TraceCollector) Record(operation string, duration time.Duration) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	
	tc.traces = append(tc.traces, Trace{
		Operation: operation,
		Duration:  duration,
		Timestamp: time.Now(),
	})
	
	// Keep only recent traces
	if len(tc.traces) > 10000 {
		tc.traces = tc.traces[5000:]
	}
}

// BottleneckDetector methods

func NewBottleneckDetector(threshold float64) *BottleneckDetector {
	return &BottleneckDetector{
		bottlenecks: make([]Bottleneck, 0),
		threshold:   threshold,
		history:     NewMetricsHistory(),
	}
}

func (bd *BottleneckDetector) Add(bottleneck Bottleneck) {
	bd.bottlenecksMu.Lock()
	defer bd.bottlenecksMu.Unlock()
	
	bd.bottlenecks = append(bd.bottlenecks, bottleneck)
	
	// Keep only recent bottlenecks
	cutoff := time.Now().Add(-5 * time.Minute)
	filtered := make([]Bottleneck, 0)
	for _, b := range bd.bottlenecks {
		if b.DetectedAt.After(cutoff) {
			filtered = append(filtered, b)
		}
	}
	bd.bottlenecks = filtered
}

func (bd *BottleneckDetector) GetCurrent() []Bottleneck {
	bd.bottlenecksMu.RLock()
	defer bd.bottlenecksMu.RUnlock()
	
	current := make([]Bottleneck, len(bd.bottlenecks))
	copy(current, bd.bottlenecks)
	return current
}

// MetricsHistory tracks historical metrics
type MetricsHistory struct {
	cpuHistory []float64
	mu         sync.RWMutex
}

func NewMetricsHistory() *MetricsHistory {
	return &MetricsHistory{
		cpuHistory: make([]float64, 0, 1000),
	}
}

func (mh *MetricsHistory) GetAverageCPU() float64 {
	mh.mu.RLock()
	defer mh.mu.RUnlock()
	
	if len(mh.cpuHistory) == 0 {
		return 0.5
	}
	
	sum := 0.0
	for _, cpu := range mh.cpuHistory {
		sum += cpu
	}
	
	return sum / float64(len(mh.cpuHistory))
}

// Helper structures

type PerformanceReport struct {
	CPUUsage         float64
	CPUCores         int
	GoroutineCount   int
	HeapAlloc        uint64
	HeapSys          uint64
	GCCount          uint32
	GCPauseTotal     time.Duration
	RequestsPerSec   uint64
	HashesPerSec     uint64
	SharesPerSec     uint64
	AvgResponseTime  time.Duration
	P50ResponseTime  time.Duration
	P95ResponseTime  time.Duration
	P99ResponseTime  time.Duration
	Bottlenecks      []Bottleneck
	Timestamp        time.Time
}

type HotSpot struct {
	Function   string
	Percentage float64
	Samples    int
}

type Allocator struct {
	Function   string
	Percentage float64
	Bytes      uint64
}

type GoroutineProfile struct {
	Count int
}

type Trace struct {
	Operation string
	Duration  time.Duration
	Timestamp time.Time
}

// DefaultProfilerConfig returns default profiler configuration
func DefaultProfilerConfig() *ProfilerConfig {
	return &ProfilerConfig{
		EnableCPUProfile:       true,
		EnableMemProfile:       true,
		EnableBlockProfile:     false,
		EnableMutexProfile:     false,
		EnableGoroutineProfile: true,
		CPUSampleRate:          100,
		MemSampleRate:          512 * 1024, // 512KB
		BlockProfileRate:       1,
		MutexProfileFraction:   1,
		ProfileInterval:        30 * time.Second,
		MetricsInterval:        5 * time.Second,
		BottleneckThreshold:    0.8, // 80%
		AnomalyDetection:       true,
		AutoOptimization:       false,
		ProfileDir:             "/var/log/otedama/profiles",
		RetentionPeriod:        24 * time.Hour,
	}
}