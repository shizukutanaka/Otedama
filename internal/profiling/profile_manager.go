package profiling

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"net/http"
	_ "net/http/pprof"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"runtime/trace"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ProfileManager manages comprehensive profiling for the mining system
type ProfileManager struct {
	logger *zap.Logger
	config ProfileConfig
	
	// Profiling state
	running      atomic.Bool
	cpuProfiling atomic.Bool
	memProfiling atomic.Bool
	tracing      atomic.Bool
	
	// Profile data
	profiles     map[string]*ProfileData
	profilesMu   sync.RWMutex
	
	// Performance tracking
	perfTracker  *PerformanceTracker
	
	// HTTP server for pprof
	pprofServer  *http.Server
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// ProfileConfig configures profiling behavior
type ProfileConfig struct {
	Enabled           bool          `yaml:"enabled"`
	HTTPAddr          string        `yaml:"http_addr"`
	
	// Automatic profiling
	AutoProfile       bool          `yaml:"auto_profile"`
	ProfileInterval   time.Duration `yaml:"profile_interval"`
	ProfileDuration   time.Duration `yaml:"profile_duration"`
	
	// Profile types
	CPUProfile        bool          `yaml:"cpu_profile"`
	MemProfile        bool          `yaml:"mem_profile"`
	BlockProfile      bool          `yaml:"block_profile"`
	MutexProfile      bool          `yaml:"mutex_profile"`
	GoroutineProfile  bool          `yaml:"goroutine_profile"`
	TraceProfile      bool          `yaml:"trace_profile"`
	
	// Storage
	ProfileDir        string        `yaml:"profile_dir"`
	MaxProfileSize    int64         `yaml:"max_profile_size"`
	RetentionDays     int           `yaml:"retention_days"`
	
	// Triggers
	CPUThreshold      float64       `yaml:"cpu_threshold"`
	MemThreshold      float64       `yaml:"mem_threshold"`
	GoroutineThreshold int          `yaml:"goroutine_threshold"`
}

// ProfileData contains profiling data
type ProfileData struct {
	ID           string
	Type         string
	StartTime    time.Time
	EndTime      time.Time
	Duration     time.Duration
	Size         int64
	Metrics      ProfileMetrics
	Analysis     *ProfileAnalysis
	FilePath     string
}

// ProfileMetrics contains metrics during profiling
type ProfileMetrics struct {
	CPUUsage         float64
	MemoryUsage      uint64
	GoroutineCount   int
	HeapAlloc        uint64
	HeapObjects      uint64
	GCCount          uint32
	GCPauseTotal     time.Duration
	BlockedTime      time.Duration
	MutexContention  int64
}

// ProfileAnalysis contains analysis results
type ProfileAnalysis struct {
	Hotspots         []Hotspot
	MemoryLeaks      []MemoryLeak
	Bottlenecks      []Bottleneck
	Recommendations  []string
	Score            float64
}

// Hotspot represents a CPU hotspot
type Hotspot struct {
	Function     string
	File         string
	Line         int
	CPUTime      time.Duration
	Percentage   float64
	CallCount    int64
}

// MemoryLeak represents a potential memory leak
type MemoryLeak struct {
	Type         string
	Size         uint64
	Count        uint64
	GrowthRate   float64
	StackTrace   string
}

// Bottleneck represents a performance bottleneck
type Bottleneck struct {
	Type         string // cpu, memory, io, lock
	Location     string
	Impact       float64
	Description  string
}

// PerformanceTracker tracks real-time performance
type PerformanceTracker struct {
	samples      []PerformanceSample
	samplesMu    sync.RWMutex
	
	// Rolling windows
	cpuWindow    *RollingWindow
	memWindow    *RollingWindow
	allocWindow  *RollingWindow
	
	// Anomaly detection
	anomalies    []PerformanceAnomaly
	anomaliesMu  sync.RWMutex
}

// PerformanceSample represents a performance sample
type PerformanceSample struct {
	Timestamp      time.Time
	CPUUsage       float64
	MemoryUsage    uint64
	GoroutineCount int
	HeapAlloc      uint64
	GCPauseNs      uint64
	HashRate       uint64
}

// PerformanceAnomaly represents a performance anomaly
type PerformanceAnomaly struct {
	Timestamp   time.Time
	Type        string
	Severity    string
	Value       float64
	Expected    float64
	Description string
}

// RollingWindow implements a time-based rolling window
type RollingWindow struct {
	window   time.Duration
	samples  []TimedValue
	mu       sync.RWMutex
}

// TimedValue represents a timestamped value
type TimedValue struct {
	Timestamp time.Time
	Value     float64
}

// NewProfileManager creates a new profile manager
func NewProfileManager(logger *zap.Logger, config ProfileConfig) *ProfileManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	pm := &ProfileManager{
		logger:   logger,
		config:   config,
		profiles: make(map[string]*ProfileData),
		ctx:      ctx,
		cancel:   cancel,
	}
	
	// Initialize performance tracker
	pm.perfTracker = &PerformanceTracker{
		cpuWindow:   NewRollingWindow(5 * time.Minute),
		memWindow:   NewRollingWindow(5 * time.Minute),
		allocWindow: NewRollingWindow(5 * time.Minute),
	}
	
	// Configure runtime profiling
	if config.BlockProfile {
		runtime.SetBlockProfileRate(1)
	}
	if config.MutexProfile {
		runtime.SetMutexProfileFraction(1)
	}
	
	return pm
}

// Start begins profiling
func (pm *ProfileManager) Start() error {
	if !pm.running.CompareAndSwap(false, true) {
		return fmt.Errorf("profile manager already running")
	}
	
	pm.logger.Info("Starting profile manager",
		zap.Bool("auto_profile", pm.config.AutoProfile),
		zap.String("http_addr", pm.config.HTTPAddr),
	)
	
	// Start pprof HTTP server
	if pm.config.HTTPAddr != "" {
		pm.startPprofServer()
	}
	
	// Start performance tracking
	pm.wg.Add(1)
	go pm.performanceTrackingLoop()
	
	// Start auto profiling if enabled
	if pm.config.AutoProfile {
		pm.wg.Add(1)
		go pm.autoProfileLoop()
	}
	
	// Start anomaly detection
	pm.wg.Add(1)
	go pm.anomalyDetectionLoop()
	
	return nil
}

// Stop stops profiling
func (pm *ProfileManager) Stop() error {
	if !pm.running.CompareAndSwap(true, false) {
		return fmt.Errorf("profile manager not running")
	}
	
	pm.logger.Info("Stopping profile manager")
	
	// Stop any active profiling
	pm.StopCPUProfile()
	pm.StopTrace()
	
	// Shutdown pprof server
	if pm.pprofServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		pm.pprofServer.Shutdown(ctx)
	}
	
	pm.cancel()
	pm.wg.Wait()
	
	return nil
}

// StartCPUProfile starts CPU profiling
func (pm *ProfileManager) StartCPUProfile(duration time.Duration) (*ProfileData, error) {
	if !pm.cpuProfiling.CompareAndSwap(false, true) {
		return nil, fmt.Errorf("CPU profiling already active")
	}
	
	profileData := &ProfileData{
		ID:        pm.generateProfileID("cpu"),
		Type:      "cpu",
		StartTime: time.Now(),
		FilePath:  fmt.Sprintf("%s/cpu_%d.prof", pm.config.ProfileDir, time.Now().Unix()),
	}
	
	// Create profile file
	file, err := pm.createProfileFile(profileData.FilePath)
	if err != nil {
		pm.cpuProfiling.Store(false)
		return nil, err
	}
	
	// Start profiling
	if err := pprof.StartCPUProfile(file); err != nil {
		file.Close()
		pm.cpuProfiling.Store(false)
		return nil, err
	}
	
	// Schedule stop
	go func() {
		time.Sleep(duration)
		pm.StopCPUProfile()
	}()
	
	// Store profile data
	pm.profilesMu.Lock()
	pm.profiles[profileData.ID] = profileData
	pm.profilesMu.Unlock()
	
	pm.logger.Info("Started CPU profiling",
		zap.String("id", profileData.ID),
		zap.Duration("duration", duration),
	)
	
	return profileData, nil
}

// StopCPUProfile stops CPU profiling
func (pm *ProfileManager) StopCPUProfile() {
	if !pm.cpuProfiling.CompareAndSwap(true, false) {
		return
	}
	
	pprof.StopCPUProfile()
	pm.logger.Info("Stopped CPU profiling")
}

// TakeMemProfile takes a memory profile
func (pm *ProfileManager) TakeMemProfile() (*ProfileData, error) {
	profileData := &ProfileData{
		ID:        pm.generateProfileID("mem"),
		Type:      "memory",
		StartTime: time.Now(),
		FilePath:  fmt.Sprintf("%s/mem_%d.prof", pm.config.ProfileDir, time.Now().Unix()),
	}
	
	// Create profile file
	file, err := pm.createProfileFile(profileData.FilePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	
	// Force GC before profiling
	runtime.GC()
	
	// Write heap profile
	if err := pprof.WriteHeapProfile(file); err != nil {
		return nil, err
	}
	
	profileData.EndTime = time.Now()
	profileData.Duration = profileData.EndTime.Sub(profileData.StartTime)
	
	// Get file size
	if info, err := file.Stat(); err == nil {
		profileData.Size = info.Size()
	}
	
	// Collect metrics
	profileData.Metrics = pm.collectMetrics()
	
	// Store profile data
	pm.profilesMu.Lock()
	pm.profiles[profileData.ID] = profileData
	pm.profilesMu.Unlock()
	
	pm.logger.Info("Took memory profile",
		zap.String("id", profileData.ID),
		zap.Int64("size", profileData.Size),
	)
	
	// Analyze profile
	go pm.analyzeProfile(profileData)
	
	return profileData, nil
}

// StartTrace starts execution tracing
func (pm *ProfileManager) StartTrace(duration time.Duration) (*ProfileData, error) {
	if !pm.tracing.CompareAndSwap(false, true) {
		return nil, fmt.Errorf("tracing already active")
	}
	
	profileData := &ProfileData{
		ID:        pm.generateProfileID("trace"),
		Type:      "trace",
		StartTime: time.Now(),
		FilePath:  fmt.Sprintf("%s/trace_%d.out", pm.config.ProfileDir, time.Now().Unix()),
	}
	
	// Create trace file
	file, err := pm.createProfileFile(profileData.FilePath)
	if err != nil {
		pm.tracing.Store(false)
		return nil, err
	}
	
	// Start tracing
	if err := trace.Start(file); err != nil {
		file.Close()
		pm.tracing.Store(false)
		return nil, err
	}
	
	// Schedule stop
	go func() {
		time.Sleep(duration)
		pm.StopTrace()
		file.Close()
		
		// Update profile data
		profileData.EndTime = time.Now()
		profileData.Duration = profileData.EndTime.Sub(profileData.StartTime)
		
		if info, err := file.Stat(); err == nil {
			profileData.Size = info.Size()
		}
	}()
	
	// Store profile data
	pm.profilesMu.Lock()
	pm.profiles[profileData.ID] = profileData
	pm.profilesMu.Unlock()
	
	pm.logger.Info("Started tracing",
		zap.String("id", profileData.ID),
		zap.Duration("duration", duration),
	)
	
	return profileData, nil
}

// StopTrace stops execution tracing
func (pm *ProfileManager) StopTrace() {
	if !pm.tracing.CompareAndSwap(true, false) {
		return
	}
	
	trace.Stop()
	pm.logger.Info("Stopped tracing")
}

// GetProfile returns profile data by ID
func (pm *ProfileManager) GetProfile(id string) (*ProfileData, error) {
	pm.profilesMu.RLock()
	defer pm.profilesMu.RUnlock()
	
	profile, exists := pm.profiles[id]
	if !exists {
		return nil, fmt.Errorf("profile not found: %s", id)
	}
	
	return profile, nil
}

// ListProfiles returns list of profiles
func (pm *ProfileManager) ListProfiles() []*ProfileData {
	pm.profilesMu.RLock()
	defer pm.profilesMu.RUnlock()
	
	profiles := make([]*ProfileData, 0, len(pm.profiles))
	for _, profile := range pm.profiles {
		profiles = append(profiles, profile)
	}
	
	return profiles
}

// GetPerformanceReport generates a performance report
func (pm *ProfileManager) GetPerformanceReport() *PerformanceReport {
	report := &PerformanceReport{
		Generated: time.Now(),
		Period:    5 * time.Minute,
	}
	
	// CPU statistics
	cpuStats := pm.perfTracker.cpuWindow.GetStatistics()
	report.CPUStats = CPUStatistics{
		Average:   cpuStats.Average,
		Max:       cpuStats.Max,
		Min:       cpuStats.Min,
		StdDev:    cpuStats.StdDev,
		P95:       cpuStats.P95,
		P99:       cpuStats.P99,
	}
	
	// Memory statistics
	memStats := pm.perfTracker.memWindow.GetStatistics()
	report.MemoryStats = MemoryStatistics{
		Average:   uint64(memStats.Average),
		Max:       uint64(memStats.Max),
		Min:       uint64(memStats.Min),
		StdDev:    uint64(memStats.StdDev),
		P95:       uint64(memStats.P95),
		P99:       uint64(memStats.P99),
	}
	
	// Recent anomalies
	pm.perfTracker.anomaliesMu.RLock()
	report.Anomalies = make([]PerformanceAnomaly, len(pm.perfTracker.anomalies))
	copy(report.Anomalies, pm.perfTracker.anomalies)
	pm.perfTracker.anomaliesMu.RUnlock()
	
	// Recommendations
	report.Recommendations = pm.generateRecommendations()
	
	return report
}

// PerformanceReport represents a performance analysis report
type PerformanceReport struct {
	Generated       time.Time
	Period          time.Duration
	CPUStats        CPUStatistics
	MemoryStats     MemoryStatistics
	GCStats         GCStatistics
	Anomalies       []PerformanceAnomaly
	Recommendations []string
}

// CPUStatistics contains CPU usage statistics
type CPUStatistics struct {
	Average float64
	Max     float64
	Min     float64
	StdDev  float64
	P95     float64
	P99     float64
}

// MemoryStatistics contains memory usage statistics
type MemoryStatistics struct {
	Average uint64
	Max     uint64
	Min     uint64
	StdDev  uint64
	P95     uint64
	P99     uint64
}

// GCStatistics contains garbage collection statistics
type GCStatistics struct {
	Count        uint32
	PauseTotal   time.Duration
	PauseAvg     time.Duration
	PauseMax     time.Duration
	LastGC       time.Time
}

// performanceTrackingLoop tracks performance metrics
func (pm *ProfileManager) performanceTrackingLoop() {
	defer pm.wg.Done()
	
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-pm.ctx.Done():
			return
		case <-ticker.C:
			pm.collectPerformanceSample()
		}
	}
}

// collectPerformanceSample collects a performance sample
func (pm *ProfileManager) collectPerformanceSample() {
	sample := PerformanceSample{
		Timestamp: time.Now(),
	}
	
	// CPU usage
	sample.CPUUsage = pm.getCPUUsage()
	
	// Memory stats
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	sample.MemoryUsage = m.Alloc
	sample.HeapAlloc = m.HeapAlloc
	sample.GCPauseNs = m.PauseTotalNs
	
	// Goroutine count
	sample.GoroutineCount = runtime.NumGoroutine()
	
	// Add to tracker
	pm.perfTracker.AddSample(sample)
	
	// Update rolling windows
	pm.perfTracker.cpuWindow.Add(sample.CPUUsage)
	pm.perfTracker.memWindow.Add(float64(sample.MemoryUsage))
	pm.perfTracker.allocWindow.Add(float64(sample.HeapAlloc))
}

// autoProfileLoop automatically triggers profiling
func (pm *ProfileManager) autoProfileLoop() {
	defer pm.wg.Done()
	
	ticker := time.NewTicker(pm.config.ProfileInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-pm.ctx.Done():
			return
		case <-ticker.C:
			pm.autoProfile()
		}
	}
}

// autoProfile performs automatic profiling based on conditions
func (pm *ProfileManager) autoProfile() {
	// Check CPU threshold
	cpuUsage := pm.getCPUUsage()
	if cpuUsage > pm.config.CPUThreshold {
		pm.logger.Info("CPU threshold exceeded, starting profiling",
			zap.Float64("cpu_usage", cpuUsage),
			zap.Float64("threshold", pm.config.CPUThreshold),
		)
		pm.StartCPUProfile(pm.config.ProfileDuration)
	}
	
	// Check memory threshold
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	memUsage := float64(m.Alloc) / float64(m.Sys) * 100
	if memUsage > pm.config.MemThreshold {
		pm.logger.Info("Memory threshold exceeded, taking profile",
			zap.Float64("mem_usage", memUsage),
			zap.Float64("threshold", pm.config.MemThreshold),
		)
		pm.TakeMemProfile()
	}
	
	// Check goroutine threshold
	goroutines := runtime.NumGoroutine()
	if goroutines > pm.config.GoroutineThreshold {
		pm.logger.Info("Goroutine threshold exceeded",
			zap.Int("goroutines", goroutines),
			zap.Int("threshold", pm.config.GoroutineThreshold),
		)
		pm.takeGoroutineProfile()
	}
}

// anomalyDetectionLoop detects performance anomalies
func (pm *ProfileManager) anomalyDetectionLoop() {
	defer pm.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-pm.ctx.Done():
			return
		case <-ticker.C:
			pm.detectAnomalies()
		}
	}
}

// detectAnomalies detects performance anomalies
func (pm *ProfileManager) detectAnomalies() {
	// CPU anomalies
	cpuStats := pm.perfTracker.cpuWindow.GetStatistics()
	currentCPU := pm.getCPUUsage()
	
	if currentCPU > cpuStats.Average+2*cpuStats.StdDev {
		pm.perfTracker.AddAnomaly(PerformanceAnomaly{
			Timestamp:   time.Now(),
			Type:        "cpu_spike",
			Severity:    "warning",
			Value:       currentCPU,
			Expected:    cpuStats.Average,
			Description: fmt.Sprintf("CPU usage spike detected: %.1f%% (expected: %.1f%%)", currentCPU, cpuStats.Average),
		})
	}
	
	// Memory anomalies
	memStats := pm.perfTracker.memWindow.GetStatistics()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	currentMem := float64(m.Alloc)
	
	if currentMem > memStats.Average+2*memStats.StdDev {
		pm.perfTracker.AddAnomaly(PerformanceAnomaly{
			Timestamp:   time.Now(),
			Type:        "memory_spike",
			Severity:    "warning",
			Value:       currentMem,
			Expected:    memStats.Average,
			Description: fmt.Sprintf("Memory usage spike detected: %.1f MB (expected: %.1f MB)", 
				currentMem/1024/1024, memStats.Average/1024/1024),
		})
	}
	
	// GC pause anomalies
	if m.PauseTotalNs > 1000000000 { // 1 second total pause
		pm.perfTracker.AddAnomaly(PerformanceAnomaly{
			Timestamp:   time.Now(),
			Type:        "gc_pause",
			Severity:    "warning",
			Value:       float64(m.PauseTotalNs),
			Expected:    100000000, // 100ms expected
			Description: fmt.Sprintf("High GC pause time: %v", time.Duration(m.PauseTotalNs)),
		})
	}
}

// Helper methods

func (pm *ProfileManager) startPprofServer() {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	
	pm.pprofServer = &http.Server{
		Addr:    pm.config.HTTPAddr,
		Handler: mux,
	}
	
	go func() {
		pm.logger.Info("Starting pprof HTTP server", zap.String("addr", pm.config.HTTPAddr))
		if err := pm.pprofServer.ListenAndServe(); err != http.ErrServerClosed {
			pm.logger.Error("pprof server error", zap.Error(err))
		}
	}()
}

func (pm *ProfileManager) generateProfileID(profileType string) string {
	return fmt.Sprintf("%s_%d_%s", profileType, time.Now().Unix(), generateRandomID(8))
}

func (pm *ProfileManager) createProfileFile(path string) (*os.File, error) {
	// Ensure directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err
	}
	
	return os.Create(path)
}

func (pm *ProfileManager) collectMetrics() ProfileMetrics {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	return ProfileMetrics{
		CPUUsage:        pm.getCPUUsage(),
		MemoryUsage:     m.Alloc,
		GoroutineCount:  runtime.NumGoroutine(),
		HeapAlloc:       m.HeapAlloc,
		HeapObjects:     m.HeapObjects,
		GCCount:         m.NumGC,
		GCPauseTotal:    time.Duration(m.PauseTotalNs),
	}
}

func (pm *ProfileManager) getCPUUsage() float64 {
	// Simplified CPU usage calculation
	// In production, use more sophisticated methods
	return 50.0 // Placeholder
}

func (pm *ProfileManager) analyzeProfile(profile *ProfileData) {
	// Analyze profile data
	// This would use pprof parsing libraries in production
	
	analysis := &ProfileAnalysis{
		Score: 85.0, // Placeholder
		Recommendations: []string{
			"Consider optimizing hot functions",
			"Review memory allocation patterns",
		},
	}
	
	profile.Analysis = analysis
}

func (pm *ProfileManager) takeGoroutineProfile() {
	profileData := &ProfileData{
		ID:        pm.generateProfileID("goroutine"),
		Type:      "goroutine",
		StartTime: time.Now(),
		FilePath:  fmt.Sprintf("%s/goroutine_%d.prof", pm.config.ProfileDir, time.Now().Unix()),
	}
	
	file, err := pm.createProfileFile(profileData.FilePath)
	if err != nil {
		pm.logger.Error("Failed to create goroutine profile", zap.Error(err))
		return
	}
	defer file.Close()
	
	pprof.Lookup("goroutine").WriteTo(file, 1)
	
	profileData.EndTime = time.Now()
	
	pm.profilesMu.Lock()
	pm.profiles[profileData.ID] = profileData
	pm.profilesMu.Unlock()
}

func (pm *ProfileManager) generateRecommendations() []string {
	var recommendations []string
	
	// Analyze recent performance
	cpuStats := pm.perfTracker.cpuWindow.GetStatistics()
	if cpuStats.Average > 80 {
		recommendations = append(recommendations, "High CPU usage detected. Consider scaling horizontally.")
	}
	
	memStats := pm.perfTracker.memWindow.GetStatistics()
	if memStats.Average > 4*1024*1024*1024 { // 4GB
		recommendations = append(recommendations, "High memory usage. Review memory allocation patterns.")
	}
	
	// Check for recent anomalies
	pm.perfTracker.anomaliesMu.RLock()
	anomalyCount := len(pm.perfTracker.anomalies)
	pm.perfTracker.anomaliesMu.RUnlock()
	
	if anomalyCount > 10 {
		recommendations = append(recommendations, "Multiple performance anomalies detected. Consider profiling.")
	}
	
	return recommendations
}

// PerformanceTracker methods

func (pt *PerformanceTracker) AddSample(sample PerformanceSample) {
	pt.samplesMu.Lock()
	pt.samples = append(pt.samples, sample)
	
	// Keep only recent samples (last 1000)
	if len(pt.samples) > 1000 {
		pt.samples = pt.samples[len(pt.samples)-1000:]
	}
	pt.samplesMu.Unlock()
}

func (pt *PerformanceTracker) AddAnomaly(anomaly PerformanceAnomaly) {
	pt.anomaliesMu.Lock()
	pt.anomalies = append(pt.anomalies, anomaly)
	
	// Keep only recent anomalies
	cutoff := time.Now().Add(-1 * time.Hour)
	var recent []PerformanceAnomaly
	for _, a := range pt.anomalies {
		if a.Timestamp.After(cutoff) {
			recent = append(recent, a)
		}
	}
	pt.anomalies = recent
	pt.anomaliesMu.Unlock()
}

// RollingWindow methods

func NewRollingWindow(window time.Duration) *RollingWindow {
	return &RollingWindow{
		window:  window,
		samples: make([]TimedValue, 0, 1000),
	}
}

func (rw *RollingWindow) Add(value float64) {
	rw.mu.Lock()
	defer rw.mu.Unlock()
	
	now := time.Now()
	rw.samples = append(rw.samples, TimedValue{
		Timestamp: now,
		Value:     value,
	})
	
	// Remove old samples
	cutoff := now.Add(-rw.window)
	var recent []TimedValue
	for _, s := range rw.samples {
		if s.Timestamp.After(cutoff) {
			recent = append(recent, s)
		}
	}
	rw.samples = recent
}

type Statistics struct {
	Average float64
	Max     float64
	Min     float64
	StdDev  float64
	P95     float64
	P99     float64
}

func (rw *RollingWindow) GetStatistics() Statistics {
	rw.mu.RLock()
	defer rw.mu.RUnlock()
	
	if len(rw.samples) == 0 {
		return Statistics{}
	}
	
	// Calculate statistics
	var sum, min, max float64
	values := make([]float64, len(rw.samples))
	
	for i, s := range rw.samples {
		values[i] = s.Value
		sum += s.Value
		if i == 0 || s.Value < min {
			min = s.Value
		}
		if i == 0 || s.Value > max {
			max = s.Value
		}
	}
	
	avg := sum / float64(len(values))
	
	// Calculate standard deviation
	var sumSquares float64
	for _, v := range values {
		diff := v - avg
		sumSquares += diff * diff
	}
	stdDev := math.Sqrt(sumSquares / float64(len(values)))
	
	// Calculate percentiles (simplified)
	sort.Float64s(values)
	p95Index := int(float64(len(values)) * 0.95)
	p99Index := int(float64(len(values)) * 0.99)
	
	return Statistics{
		Average: avg,
		Max:     max,
		Min:     min,
		StdDev:  stdDev,
		P95:     values[p95Index],
		P99:     values[p99Index],
	}
}

// Helper functions

func generateRandomID(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, length)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

