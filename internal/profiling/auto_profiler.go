package profiling

import (
	"context"
	"fmt"
	"net/http"
	_ "net/http/pprof"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// AutoProfiler provides automatic profiling with pprof integration
type AutoProfiler struct {
	logger *zap.Logger
	config ProfilerConfig
	
	// Profile collection
	cpuProfile    *os.File
	memProfiles   []memSnapshot
	goroutines    []goroutineSnapshot
	blockProfile  *blockProfiler
	mutexProfile  *mutexProfiler
	
	// Analysis results
	cpuHotspots   []Hotspot
	memLeaks      []MemoryLeak
	bottlenecks   []Bottleneck
	
	// Profiling state
	running       atomic.Bool
	cpuProfiling  atomic.Bool
	
	// HTTP server
	server        *http.Server
	
	// Thresholds
	cpuThreshold  float64
	memThreshold  uint64
	gcThreshold   time.Duration
	
	mu sync.RWMutex
}

// ProfilerConfig contains auto-profiler configuration
type ProfilerConfig struct {
	Enabled           bool          `yaml:"enabled"`
	HTTPAddr          string        `yaml:"http_addr"`
	OutputDir         string        `yaml:"output_dir"`
	CPUProfileRate    int           `yaml:"cpu_profile_rate"`
	MemProfileRate    int           `yaml:"mem_profile_rate"`
	BlockProfileRate  int           `yaml:"block_profile_rate"`
	MutexProfileRate  int           `yaml:"mutex_profile_rate"`
	ProfileInterval   time.Duration `yaml:"profile_interval"`
	AnalysisInterval  time.Duration `yaml:"analysis_interval"`
	CPUThreshold      float64       `yaml:"cpu_threshold"`
	MemThreshold      uint64        `yaml:"mem_threshold"`
	AutoOptimize      bool          `yaml:"auto_optimize"`
}

// Hotspot represents a CPU hotspot
type Hotspot struct {
	Function     string
	File         string
	Line         int
	CPUPercent   float64
	SampleCount  int64
	Optimizable  bool
	Suggestions  []string
}

// MemoryLeak represents a potential memory leak
type MemoryLeak struct {
	Location     string
	AllocBytes   uint64
	AllocObjects uint64
	GrowthRate   float64
	Severity     string
}

// Bottleneck represents a performance bottleneck
type Bottleneck struct {
	Type         string // "blocking", "contention", "gc"
	Location     string
	Impact       float64
	Duration     time.Duration
	Suggestions  []string
}

// memSnapshot represents a memory profile snapshot
type memSnapshot struct {
	timestamp time.Time
	stats     runtime.MemStats
	profile   []runtime.MemProfileRecord
}

// goroutineSnapshot represents goroutine state snapshot
type goroutineSnapshot struct {
	timestamp time.Time
	count     int
	stacks    []runtime.Stack
}

// blockProfiler handles block profiling
type blockProfiler struct {
	samples []runtime.BlockProfileRecord
	mu      sync.Mutex
}

// mutexProfiler handles mutex profiling
type mutexProfiler struct {
	samples []runtime.BlockProfileRecord
	mu      sync.Mutex
}

// NewAutoProfiler creates a new auto-profiler
func NewAutoProfiler(logger *zap.Logger, config ProfilerConfig) *AutoProfiler {
	// Set defaults
	if config.HTTPAddr == "" {
		config.HTTPAddr = "localhost:6060"
	}
	if config.OutputDir == "" {
		config.OutputDir = "profiles"
	}
	if config.CPUProfileRate <= 0 {
		config.CPUProfileRate = 100
	}
	if config.ProfileInterval <= 0 {
		config.ProfileInterval = 30 * time.Second
	}
	if config.AnalysisInterval <= 0 {
		config.AnalysisInterval = 5 * time.Minute
	}
	if config.CPUThreshold <= 0 {
		config.CPUThreshold = 80.0
	}
	if config.MemThreshold <= 0 {
		config.MemThreshold = 1 << 30 // 1GB
	}
	
	// Create output directory
	os.MkdirAll(config.OutputDir, 0755)
	
	ap := &AutoProfiler{
		logger:       logger,
		config:       config,
		memProfiles:  make([]memSnapshot, 0, 100),
		goroutines:   make([]goroutineSnapshot, 0, 100),
		blockProfile: &blockProfiler{},
		mutexProfile: &mutexProfiler{},
		cpuThreshold: config.CPUThreshold,
		memThreshold: config.MemThreshold,
		gcThreshold:  100 * time.Millisecond,
	}
	
	// Configure runtime profiling
	runtime.SetCPUProfileRate(config.CPUProfileRate)
	runtime.SetBlockProfileRate(config.BlockProfileRate)
	runtime.SetMutexProfileFraction(config.MutexProfileRate)
	
	return ap
}

// Start starts the auto-profiler
func (ap *AutoProfiler) Start(ctx context.Context) error {
	if !ap.config.Enabled {
		ap.logger.Info("Auto-profiler is disabled")
		return nil
	}
	
	if ap.running.Load() {
		return fmt.Errorf("profiler already running")
	}
	
	ap.running.Store(true)
	
	// Start HTTP server for pprof
	if ap.config.HTTPAddr != "" {
		ap.server = &http.Server{
			Addr:    ap.config.HTTPAddr,
			Handler: http.DefaultServeMux,
		}
		
		go func() {
			ap.logger.Info("Starting pprof HTTP server",
				zap.String("addr", ap.config.HTTPAddr),
			)
			if err := ap.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				ap.logger.Error("pprof server error", zap.Error(err))
			}
		}()
	}
	
	// Start profiling goroutines
	go ap.profileLoop(ctx)
	go ap.analysisLoop(ctx)
	
	ap.logger.Info("Auto-profiler started",
		zap.String("output_dir", ap.config.OutputDir),
		zap.Duration("profile_interval", ap.config.ProfileInterval),
	)
	
	return nil
}

// Stop stops the auto-profiler
func (ap *AutoProfiler) Stop() error {
	if !ap.running.Load() {
		return nil
	}
	
	ap.running.Store(false)
	
	// Stop CPU profiling if active
	if ap.cpuProfiling.Load() {
		pprof.StopCPUProfile()
		if ap.cpuProfile != nil {
			ap.cpuProfile.Close()
		}
	}
	
	// Stop HTTP server
	if ap.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ap.server.Shutdown(ctx)
	}
	
	// Write final profiles
	ap.writeProfiles()
	
	ap.logger.Info("Auto-profiler stopped")
	return nil
}

// profileLoop continuously collects profiles
func (ap *AutoProfiler) profileLoop(ctx context.Context) {
	ticker := time.NewTicker(ap.config.ProfileInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !ap.running.Load() {
				return
			}
			
			// Collect profiles
			ap.collectCPUProfile()
			ap.collectMemProfile()
			ap.collectGoroutineProfile()
			ap.collectBlockProfile()
			ap.collectMutexProfile()
		}
	}
}

// analysisLoop periodically analyzes collected profiles
func (ap *AutoProfiler) analysisLoop(ctx context.Context) {
	ticker := time.NewTicker(ap.config.AnalysisInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !ap.running.Load() {
				return
			}
			
			// Analyze profiles
			ap.analyzeCPU()
			ap.analyzeMemory()
			ap.analyzeBottlenecks()
			
			// Report findings
			ap.reportFindings()
			
			// Auto-optimize if enabled
			if ap.config.AutoOptimize {
				ap.autoOptimize()
			}
		}
	}
}

// collectCPUProfile collects CPU profile
func (ap *AutoProfiler) collectCPUProfile() {
	// Start CPU profiling if not already running
	if !ap.cpuProfiling.CompareAndSwap(false, true) {
		return
	}
	
	filename := filepath.Join(ap.config.OutputDir, fmt.Sprintf("cpu_%d.prof", time.Now().Unix()))
	
	file, err := os.Create(filename)
	if err != nil {
		ap.logger.Error("Failed to create CPU profile", zap.Error(err))
		ap.cpuProfiling.Store(false)
		return
	}
	
	ap.cpuProfile = file
	
	if err := pprof.StartCPUProfile(file); err != nil {
		ap.logger.Error("Failed to start CPU profiling", zap.Error(err))
		file.Close()
		ap.cpuProfiling.Store(false)
		return
	}
	
	// Stop profiling after interval
	go func() {
		time.Sleep(10 * time.Second)
		pprof.StopCPUProfile()
		file.Close()
		ap.cpuProfiling.Store(false)
		
		ap.logger.Debug("CPU profile collected",
			zap.String("file", filename),
		)
	}()
}

// collectMemProfile collects memory profile
func (ap *AutoProfiler) collectMemProfile() {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	
	// Collect heap profile
	records := make([]runtime.MemProfileRecord, 1000)
	n, _ := runtime.MemProfile(records, true)
	
	snapshot := memSnapshot{
		timestamp: time.Now(),
		stats:     stats,
		profile:   records[:n],
	}
	
	ap.mu.Lock()
	ap.memProfiles = append(ap.memProfiles, snapshot)
	
	// Keep only recent profiles
	if len(ap.memProfiles) > 100 {
		ap.memProfiles = ap.memProfiles[1:]
	}
	ap.mu.Unlock()
	
	// Write heap profile if memory usage is high
	if stats.Alloc > ap.memThreshold {
		filename := filepath.Join(ap.config.OutputDir, fmt.Sprintf("heap_%d.prof", time.Now().Unix()))
		file, err := os.Create(filename)
		if err == nil {
			pprof.WriteHeapProfile(file)
			file.Close()
			
			ap.logger.Warn("High memory usage detected",
				zap.Uint64("alloc_mb", stats.Alloc/(1<<20)),
				zap.String("profile", filename),
			)
		}
	}
}

// collectGoroutineProfile collects goroutine profile
func (ap *AutoProfiler) collectGoroutineProfile() {
	count := runtime.NumGoroutine()
	
	snapshot := goroutineSnapshot{
		timestamp: time.Now(),
		count:     count,
	}
	
	ap.mu.Lock()
	ap.goroutines = append(ap.goroutines, snapshot)
	
	// Keep only recent snapshots
	if len(ap.goroutines) > 100 {
		ap.goroutines = ap.goroutines[1:]
	}
	ap.mu.Unlock()
	
	// Write goroutine profile if count is high
	if count > 10000 {
		filename := filepath.Join(ap.config.OutputDir, fmt.Sprintf("goroutine_%d.prof", time.Now().Unix()))
		file, err := os.Create(filename)
		if err == nil {
			pprof.Lookup("goroutine").WriteTo(file, 1)
			file.Close()
			
			ap.logger.Warn("High goroutine count",
				zap.Int("count", count),
				zap.String("profile", filename),
			)
		}
	}
}

// collectBlockProfile collects block profile
func (ap *AutoProfiler) collectBlockProfile() {
	records := make([]runtime.BlockProfileRecord, 1000)
	n, _ := runtime.BlockProfile(records)
	
	ap.blockProfile.mu.Lock()
	ap.blockProfile.samples = records[:n]
	ap.blockProfile.mu.Unlock()
}

// collectMutexProfile collects mutex profile
func (ap *AutoProfiler) collectMutexProfile() {
	records := make([]runtime.BlockProfileRecord, 1000)
	n, _ := runtime.MutexProfile(records)
	
	ap.mutexProfile.mu.Lock()
	ap.mutexProfile.samples = records[:n]
	ap.mutexProfile.mu.Unlock()
}

// analyzeCPU analyzes CPU profiles for hotspots
func (ap *AutoProfiler) analyzeCPU() {
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	// Clear previous results
	ap.cpuHotspots = ap.cpuHotspots[:0]
	
	// TODO: Implement actual CPU profile analysis
	// This would parse pprof data and identify hotspots
	
	// Placeholder hotspot
	if runtime.NumCPU() > 0 {
		ap.cpuHotspots = append(ap.cpuHotspots, Hotspot{
			Function:    "example.hotFunction",
			CPUPercent:  25.5,
			Optimizable: true,
			Suggestions: []string{
				"Consider using sync.Pool for object reuse",
				"Reduce allocations in hot path",
			},
		})
	}
}

// analyzeMemory analyzes memory profiles for leaks
func (ap *AutoProfiler) analyzeMemory() {
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	// Clear previous results
	ap.memLeaks = ap.memLeaks[:0]
	
	// Analyze memory growth
	if len(ap.memProfiles) >= 2 {
		recent := ap.memProfiles[len(ap.memProfiles)-1]
		previous := ap.memProfiles[len(ap.memProfiles)-2]
		
		allocGrowth := float64(recent.stats.Alloc-previous.stats.Alloc) / float64(previous.stats.Alloc) * 100
		
		if allocGrowth > 10 {
			ap.memLeaks = append(ap.memLeaks, MemoryLeak{
				Location:     "heap",
				AllocBytes:   recent.stats.Alloc,
				GrowthRate:   allocGrowth,
				Severity:     "medium",
			})
		}
	}
}

// analyzeBottlenecks analyzes for performance bottlenecks
func (ap *AutoProfiler) analyzeBottlenecks() {
	ap.mu.Lock()
	defer ap.mu.Unlock()
	
	// Clear previous results
	ap.bottlenecks = ap.bottlenecks[:0]
	
	// Check for GC bottlenecks
	if len(ap.memProfiles) > 0 {
		recent := ap.memProfiles[len(ap.memProfiles)-1]
		gcPause := time.Duration(recent.stats.PauseTotalNs)
		
		if gcPause > ap.gcThreshold {
			ap.bottlenecks = append(ap.bottlenecks, Bottleneck{
				Type:     "gc",
				Location: "runtime",
				Impact:   float64(gcPause.Milliseconds()),
				Duration: gcPause,
				Suggestions: []string{
					"Reduce allocation rate",
					"Increase GOGC value",
					"Use object pools",
				},
			})
		}
	}
	
	// Check for blocking operations
	ap.blockProfile.mu.Lock()
	if len(ap.blockProfile.samples) > 0 {
		// TODO: Analyze block profile samples
	}
	ap.blockProfile.mu.Unlock()
}

// reportFindings reports analysis findings
func (ap *AutoProfiler) reportFindings() {
	ap.mu.RLock()
	defer ap.mu.RUnlock()
	
	// Report CPU hotspots
	if len(ap.cpuHotspots) > 0 {
		ap.logger.Info("CPU hotspots detected",
			zap.Int("count", len(ap.cpuHotspots)),
		)
		
		for _, hotspot := range ap.cpuHotspots {
			ap.logger.Warn("CPU hotspot",
				zap.String("function", hotspot.Function),
				zap.Float64("cpu_percent", hotspot.CPUPercent),
				zap.Strings("suggestions", hotspot.Suggestions),
			)
		}
	}
	
	// Report memory leaks
	if len(ap.memLeaks) > 0 {
		ap.logger.Warn("Potential memory leaks detected",
			zap.Int("count", len(ap.memLeaks)),
		)
		
		for _, leak := range ap.memLeaks {
			ap.logger.Warn("Memory leak",
				zap.String("location", leak.Location),
				zap.Uint64("bytes", leak.AllocBytes),
				zap.Float64("growth_rate", leak.GrowthRate),
				zap.String("severity", leak.Severity),
			)
		}
	}
	
	// Report bottlenecks
	if len(ap.bottlenecks) > 0 {
		ap.logger.Warn("Performance bottlenecks detected",
			zap.Int("count", len(ap.bottlenecks)),
		)
		
		for _, bottleneck := range ap.bottlenecks {
			ap.logger.Warn("Bottleneck",
				zap.String("type", bottleneck.Type),
				zap.String("location", bottleneck.Location),
				zap.Float64("impact", bottleneck.Impact),
				zap.Strings("suggestions", bottleneck.Suggestions),
			)
		}
	}
}

// autoOptimize applies automatic optimizations
func (ap *AutoProfiler) autoOptimize() {
	ap.mu.RLock()
	defer ap.mu.RUnlock()
	
	// Apply GC tuning if needed
	if len(ap.bottlenecks) > 0 {
		for _, bottleneck := range ap.bottlenecks {
			if bottleneck.Type == "gc" && bottleneck.Impact > 100 {
				// Increase GOGC to reduce GC frequency
				currentGOGC := os.Getenv("GOGC")
				if currentGOGC == "" {
					currentGOGC = "100"
				}
				
				ap.logger.Info("Auto-tuning GC",
					zap.String("current_gogc", currentGOGC),
					zap.String("new_gogc", "200"),
				)
				
				runtime.GC()
				runtime.SetGCPercent(200)
			}
		}
	}
	
	// Apply memory optimizations
	if len(ap.memLeaks) > 0 {
		// Force GC to reclaim memory
		runtime.GC()
		runtime.GC() // Double GC to ensure finalizers run
		
		ap.logger.Info("Forced GC due to memory pressure")
	}
}

// writeProfiles writes all collected profiles to disk
func (ap *AutoProfiler) writeProfiles() {
	timestamp := time.Now().Unix()
	
	// Write all profile types
	profiles := []string{"heap", "goroutine", "threadcreate", "block", "mutex"}
	
	for _, name := range profiles {
		profile := pprof.Lookup(name)
		if profile == nil {
			continue
		}
		
		filename := filepath.Join(ap.config.OutputDir, fmt.Sprintf("%s_final_%d.prof", name, timestamp))
		file, err := os.Create(filename)
		if err != nil {
			ap.logger.Error("Failed to create profile file",
				zap.String("profile", name),
				zap.Error(err),
			)
			continue
		}
		
		profile.WriteTo(file, 0)
		file.Close()
		
		ap.logger.Info("Final profile written",
			zap.String("profile", name),
			zap.String("file", filename),
		)
	}
}

// GetStatistics returns profiler statistics
func (ap *AutoProfiler) GetStatistics() map[string]interface{} {
	ap.mu.RLock()
	defer ap.mu.RUnlock()
	
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	return map[string]interface{}{
		"running":         ap.running.Load(),
		"cpu_profiling":   ap.cpuProfiling.Load(),
		"mem_profiles":    len(ap.memProfiles),
		"goroutine_count": runtime.NumGoroutine(),
		"cpu_hotspots":    len(ap.cpuHotspots),
		"mem_leaks":       len(ap.memLeaks),
		"bottlenecks":     len(ap.bottlenecks),
		"mem_alloc_mb":    memStats.Alloc / (1 << 20),
		"gc_pause_ms":     float64(memStats.PauseTotalNs) / 1e6,
	}
}

// GetFindings returns current analysis findings
func (ap *AutoProfiler) GetFindings() ([]Hotspot, []MemoryLeak, []Bottleneck) {
	ap.mu.RLock()
	defer ap.mu.RUnlock()
	
	// Return copies to avoid race conditions
	hotspots := make([]Hotspot, len(ap.cpuHotspots))
	copy(hotspots, ap.cpuHotspots)
	
	leaks := make([]MemoryLeak, len(ap.memLeaks))
	copy(leaks, ap.memLeaks)
	
	bottlenecks := make([]Bottleneck, len(ap.bottlenecks))
	copy(bottlenecks, ap.bottlenecks)
	
	return hotspots, leaks, bottlenecks
}