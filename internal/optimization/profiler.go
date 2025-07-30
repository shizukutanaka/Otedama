package optimization

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"runtime/trace"
	"sync"
	"time"

	"go.uber.org/zap"
)

// PerformanceProfiler provides comprehensive performance profiling
// Following John Carmack's principle: "Profile, don't speculate"
type PerformanceProfiler struct {
	logger *zap.Logger
	
	// Profiling state
	cpuProfile   *os.File
	memProfile   *os.File
	traceFile    *os.File
	
	// Metrics collection
	metrics      *PerformanceMetrics
	metricsMu    sync.RWMutex
	
	// Configuration
	sampleRate   time.Duration
	profileDir   string
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// PerformanceMetrics contains real-time performance metrics
type PerformanceMetrics struct {
	// CPU metrics
	CPUUsagePercent   float64
	CPUCores          int
	GoroutineCount    int
	
	// Memory metrics
	MemoryUsed        uint64
	MemoryAllocated   uint64
	MemorySys         uint64
	GCPauseNs         uint64
	GCRunsPerMinute   uint64
	
	// Mining metrics
	CurrentHashRate   float64
	SharesPerMinute   uint64
	ValidShareRatio   float64
	
	// Network metrics
	ConnectedPeers    int
	NetworkBandwidth  uint64
	MessageQueueSize  int
	
	// System metrics
	Uptime           time.Duration
	LastUpdated      time.Time
}

// NewPerformanceProfiler creates a new performance profiler
func NewPerformanceProfiler(logger *zap.Logger, profileDir string) *PerformanceProfiler {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &PerformanceProfiler{
		logger:     logger,
		sampleRate: time.Second,
		profileDir: profileDir,
		metrics:    &PerformanceMetrics{},
		ctx:        ctx,
		cancel:     cancel,
	}
}

// StartProfiling starts comprehensive profiling
func (pp *PerformanceProfiler) StartProfiling() error {
	pp.logger.Info("Starting performance profiling")
	
	// Create profile directory
	if err := os.MkdirAll(pp.profileDir, 0755); err != nil {
		return fmt.Errorf("failed to create profile directory: %w", err)
	}
	
	// Start CPU profiling
	if err := pp.startCPUProfile(); err != nil {
		return fmt.Errorf("failed to start CPU profile: %w", err)
	}
	
	// Start trace
	if err := pp.startTrace(); err != nil {
		return fmt.Errorf("failed to start trace: %w", err)
	}
	
	// Start metrics collection
	pp.wg.Add(1)
	go pp.collectMetrics()
	
	// Start profile snapshots
	pp.wg.Add(1)
	go pp.profileSnapshots()
	
	return nil
}

// StopProfiling stops all profiling
func (pp *PerformanceProfiler) StopProfiling() error {
	pp.logger.Info("Stopping performance profiling")
	
	// Cancel context
	pp.cancel()
	
	// Stop CPU profiling
	if pp.cpuProfile != nil {
		pprof.StopCPUProfile()
		pp.cpuProfile.Close()
	}
	
	// Stop trace
	if pp.traceFile != nil {
		trace.Stop()
		pp.traceFile.Close()
	}
	
	// Write final memory profile
	pp.writeMemoryProfile()
	
	// Wait for goroutines
	pp.wg.Wait()
	
	// Generate report
	pp.generateReport()
	
	return nil
}

// GetMetrics returns current performance metrics
func (pp *PerformanceProfiler) GetMetrics() *PerformanceMetrics {
	pp.metricsMu.RLock()
	defer pp.metricsMu.RUnlock()
	
	// Return copy
	metrics := *pp.metrics
	return &metrics
}

// RunBenchmarks runs all performance benchmarks
func (pp *PerformanceProfiler) RunBenchmarks() (*ComprehensiveBenchmarkReport, error) {
	pp.logger.Info("Running comprehensive benchmarks")
	
	report := &ComprehensiveBenchmarkReport{
		Timestamp: time.Now(),
	}
	
	// Run mining benchmarks
	miningBench := NewMiningBenchmarks(pp.logger)
	miningReport, err := miningBench.RunAllMiningBenchmarks()
	if err != nil {
		pp.logger.Error("Mining benchmarks failed", zap.Error(err))
	} else {
		report.Mining = miningReport
	}
	
	// Run network benchmarks
	networkBench := NewNetworkBenchmarks(pp.logger)
	networkReport, err := networkBench.RunAllNetworkBenchmarks()
	if err != nil {
		pp.logger.Error("Network benchmarks failed", zap.Error(err))
	} else {
		report.Network = networkReport
	}
	
	// Generate optimization suggestions
	report.Optimizations = pp.generateOptimizations(report)
	
	// Save report
	pp.saveReport(report)
	
	return report, nil
}

// Private methods

func (pp *PerformanceProfiler) startCPUProfile() error {
	filename := fmt.Sprintf("%s/cpu_%d.prof", pp.profileDir, time.Now().Unix())
	
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	
	pp.cpuProfile = file
	
	if err := pprof.StartCPUProfile(file); err != nil {
		file.Close()
		return err
	}
	
	pp.logger.Info("CPU profiling started", zap.String("file", filename))
	return nil
}

func (pp *PerformanceProfiler) startTrace() error {
	filename := fmt.Sprintf("%s/trace_%d.out", pp.profileDir, time.Now().Unix())
	
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	
	pp.traceFile = file
	
	if err := trace.Start(file); err != nil {
		file.Close()
		return err
	}
	
	pp.logger.Info("Trace started", zap.String("file", filename))
	return nil
}

func (pp *PerformanceProfiler) writeMemoryProfile() error {
	filename := fmt.Sprintf("%s/mem_%d.prof", pp.profileDir, time.Now().Unix())
	
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	runtime.GC() // Get up-to-date stats
	if err := pprof.WriteHeapProfile(file); err != nil {
		return err
	}
	
	pp.logger.Info("Memory profile written", zap.String("file", filename))
	return nil
}

func (pp *PerformanceProfiler) collectMetrics() {
	defer pp.wg.Done()
	
	ticker := time.NewTicker(pp.sampleRate)
	defer ticker.Stop()
	
	startTime := time.Now()
	var lastGCRuns uint32
	
	for {
		select {
		case <-ticker.C:
			pp.updateMetrics(startTime, &lastGCRuns)
			
		case <-pp.ctx.Done():
			return
		}
	}
}

func (pp *PerformanceProfiler) updateMetrics(startTime time.Time, lastGCRuns *uint32) {
	pp.metricsMu.Lock()
	defer pp.metricsMu.Unlock()
	
	// CPU metrics
	pp.metrics.CPUCores = runtime.NumCPU()
	pp.metrics.GoroutineCount = runtime.NumGoroutine()
	pp.metrics.CPUUsagePercent = getCPUUsage()
	
	// Memory metrics
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	pp.metrics.MemoryUsed = memStats.Alloc
	pp.metrics.MemoryAllocated = memStats.TotalAlloc
	pp.metrics.MemorySys = memStats.Sys
	pp.metrics.GCPauseNs = memStats.PauseNs[(memStats.NumGC+255)%256]
	
	// Calculate GC runs per minute
	gcRuns := memStats.NumGC - *lastGCRuns
	*lastGCRuns = memStats.NumGC
	pp.metrics.GCRunsPerMinute = uint64(float64(gcRuns) * 60 / pp.sampleRate.Seconds())
	
	// System metrics
	pp.metrics.Uptime = time.Since(startTime)
	pp.metrics.LastUpdated = time.Now()
	
	// TODO: Update mining and network metrics from actual components
}

func (pp *PerformanceProfiler) profileSnapshots() {
	defer pp.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Take memory snapshot
			pp.writeMemoryProfile()
			
			// Take goroutine snapshot
			pp.writeGoroutineProfile()
			
		case <-pp.ctx.Done():
			return
		}
	}
}

func (pp *PerformanceProfiler) writeGoroutineProfile() error {
	filename := fmt.Sprintf("%s/goroutine_%d.prof", pp.profileDir, time.Now().Unix())
	
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()
	
	profile := pprof.Lookup("goroutine")
	if err := profile.WriteTo(file, 0); err != nil {
		return err
	}
	
	pp.logger.Debug("Goroutine profile written", zap.String("file", filename))
	return nil
}

func (pp *PerformanceProfiler) generateReport() {
	metrics := pp.GetMetrics()
	
	report := PerformanceReport{
		Timestamp: time.Now(),
		Metrics:   metrics,
		Analysis:  pp.analyzeMetrics(metrics),
	}
	
	// Save report
	filename := fmt.Sprintf("%s/performance_report_%d.json", pp.profileDir, time.Now().Unix())
	file, err := os.Create(filename)
	if err != nil {
		pp.logger.Error("Failed to create report file", zap.Error(err))
		return
	}
	defer file.Close()
	
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	
	if err := encoder.Encode(report); err != nil {
		pp.logger.Error("Failed to write report", zap.Error(err))
		return
	}
	
	pp.logger.Info("Performance report generated", zap.String("file", filename))
}

func (pp *PerformanceProfiler) analyzeMetrics(metrics *PerformanceMetrics) *PerformanceAnalysis {
	analysis := &PerformanceAnalysis{
		Issues:        []string{},
		Optimizations: []string{},
	}
	
	// CPU analysis
	if metrics.CPUUsagePercent > 80 {
		analysis.Issues = append(analysis.Issues, "High CPU usage detected")
		analysis.Optimizations = append(analysis.Optimizations, "Consider optimizing hot paths or scaling horizontally")
	}
	
	// Memory analysis
	if metrics.GCRunsPerMinute > 60 {
		analysis.Issues = append(analysis.Issues, "Excessive garbage collection")
		analysis.Optimizations = append(analysis.Optimizations, "Reduce allocations with object pooling")
	}
	
	// Goroutine analysis
	if metrics.GoroutineCount > 10000 {
		analysis.Issues = append(analysis.Issues, "High goroutine count")
		analysis.Optimizations = append(analysis.Optimizations, "Review goroutine lifecycle management")
	}
	
	return analysis
}

func (pp *PerformanceProfiler) generateOptimizations(report *ComprehensiveBenchmarkReport) []string {
	optimizations := []string{}
	
	// Mining optimizations
	if report.Mining != nil {
		for algo, bench := range report.Mining.Algorithms {
			if bench.HashRate < 1e6 { // Less than 1 MH/s
				optimizations = append(optimizations, 
					fmt.Sprintf("Low hash rate for %s. Consider GPU acceleration", algo))
			}
		}
	}
	
	// Network optimizations
	if report.Network != nil {
		if report.Network.MessageThroughput.MessagesPerSecond < 10000 {
			optimizations = append(optimizations, 
				"Low message throughput. Implement message batching")
		}
		
		if report.Network.NetworkLatency.P99Latency > 100*time.Millisecond {
			optimizations = append(optimizations, 
				"High network latency. Consider regional edge nodes")
		}
	}
	
	return optimizations
}

func (pp *PerformanceProfiler) saveReport(report *ComprehensiveBenchmarkReport) {
	filename := fmt.Sprintf("%s/benchmark_report_%d.json", pp.profileDir, time.Now().Unix())
	
	file, err := os.Create(filename)
	if err != nil {
		pp.logger.Error("Failed to create benchmark report", zap.Error(err))
		return
	}
	defer file.Close()
	
	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	
	if err := encoder.Encode(report); err != nil {
		pp.logger.Error("Failed to write benchmark report", zap.Error(err))
		return
	}
	
	pp.logger.Info("Benchmark report saved", zap.String("file", filename))
}

// Report structures

type PerformanceReport struct {
	Timestamp time.Time
	Metrics   *PerformanceMetrics
	Analysis  *PerformanceAnalysis
}

type PerformanceAnalysis struct {
	Issues        []string
	Optimizations []string
}

type ComprehensiveBenchmarkReport struct {
	Timestamp     time.Time
	Mining        *MiningBenchmarkReport
	Network       *NetworkBenchmarkReport
	Optimizations []string
}

// Helper function
func getCPUUsage() float64 {
	// Simplified CPU usage calculation
	// In production, would use more sophisticated methods
	return 50.0 // Placeholder
}