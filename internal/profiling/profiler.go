package profiling

import (
	"context"
	"fmt"
	"net/http"
	_ "net/http/pprof"
	"os"
	"runtime"
	"runtime/pprof"
	"runtime/trace"
	"time"

	"go.uber.org/zap"
)

// Profiler manages runtime profiling for performance analysis
type Profiler struct {
	logger         *zap.Logger
	config         Config
	pprofServer    *http.Server
	profileDir     string
	activeProfiles map[string]*Profile
}

// Config defines profiler configuration
type Config struct {
	Enabled         bool   `yaml:"enabled"`
	PProfAddr       string `yaml:"pprof_addr"`
	ProfileDir      string `yaml:"profile_dir"`
	CPUProfile      bool   `yaml:"cpu_profile"`
	MemProfile      bool   `yaml:"mem_profile"`
	BlockProfile    bool   `yaml:"block_profile"`
	MutexProfile    bool   `yaml:"mutex_profile"`
	GoroutineProfile bool  `yaml:"goroutine_profile"`
	TraceProfile    bool   `yaml:"trace_profile"`
	ProfileInterval time.Duration `yaml:"profile_interval"`
}

// Profile tracks an active profile
type Profile struct {
	Type      string
	StartTime time.Time
	File      *os.File
	Active    bool
}

// NewProfiler creates a new profiler
func NewProfiler(logger *zap.Logger, config Config) *Profiler {
	if config.ProfileDir == "" {
		config.ProfileDir = "./profiles"
	}
	
	if config.PProfAddr == "" {
		config.PProfAddr = "localhost:6060"
	}
	
	if config.ProfileInterval == 0 {
		config.ProfileInterval = 5 * time.Minute
	}
	
	return &Profiler{
		logger:         logger,
		config:         config,
		profileDir:     config.ProfileDir,
		activeProfiles: make(map[string]*Profile),
	}
}

// Start begins profiling operations
func (p *Profiler) Start(ctx context.Context) error {
	if !p.config.Enabled {
		p.logger.Info("Profiler disabled")
		return nil
	}
	
	// Create profile directory
	if err := os.MkdirAll(p.profileDir, 0755); err != nil {
		return fmt.Errorf("failed to create profile directory: %w", err)
	}
	
	// Start pprof server
	if err := p.startPProfServer(); err != nil {
		return fmt.Errorf("failed to start pprof server: %w", err)
	}
	
	// Start profiling routines
	go p.profileRoutine(ctx)
	
	p.logger.Info("Profiler started",
		zap.String("pprof_addr", p.config.PProfAddr),
		zap.String("profile_dir", p.profileDir),
	)
	
	return nil
}

// Stop halts profiling operations
func (p *Profiler) Stop() error {
	p.logger.Info("Stopping profiler")
	
	// Stop all active profiles
	for _, profile := range p.activeProfiles {
		if profile.Active {
			p.stopProfile(profile.Type)
		}
	}
	
	// Stop pprof server
	if p.pprofServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		p.pprofServer.Shutdown(ctx)
	}
	
	return nil
}

// startPProfServer starts the pprof HTTP server
func (p *Profiler) startPProfServer() error {
	p.pprofServer = &http.Server{
		Addr:         p.config.PProfAddr,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}
	
	go func() {
		p.logger.Info("Starting pprof server", zap.String("addr", p.config.PProfAddr))
		if err := p.pprofServer.ListenAndServe(); err != http.ErrServerClosed {
			p.logger.Error("pprof server error", zap.Error(err))
		}
	}()
	
	return nil
}

// profileRoutine manages periodic profiling
func (p *Profiler) profileRoutine(ctx context.Context) {
	ticker := time.NewTicker(p.config.ProfileInterval)
	defer ticker.Stop()
	
	// Start initial profiles
	p.startConfiguredProfiles()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.rotateProfiles()
		}
	}
}

// startConfiguredProfiles starts profiles based on configuration
func (p *Profiler) startConfiguredProfiles() {
	if p.config.CPUProfile {
		if err := p.StartCPUProfile(); err != nil {
			p.logger.Error("Failed to start CPU profile", zap.Error(err))
		}
	}
	
	if p.config.MemProfile {
		// Memory profile is captured on demand
		runtime.MemProfileRate = 1
	}
	
	if p.config.BlockProfile {
		runtime.SetBlockProfileRate(1)
	}
	
	if p.config.MutexProfile {
		runtime.SetMutexProfileFraction(1)
	}
	
	if p.config.TraceProfile {
		if err := p.StartTrace(); err != nil {
			p.logger.Error("Failed to start trace", zap.Error(err))
		}
	}
}

// rotateProfiles rotates active profiles
func (p *Profiler) rotateProfiles() {
	p.logger.Debug("Rotating profiles")
	
	// Stop and restart CPU profile
	if p.config.CPUProfile {
		p.StopCPUProfile()
		time.Sleep(100 * time.Millisecond)
		if err := p.StartCPUProfile(); err != nil {
			p.logger.Error("Failed to restart CPU profile", zap.Error(err))
		}
	}
	
	// Capture memory profile
	if p.config.MemProfile {
		if err := p.CaptureMemProfile(); err != nil {
			p.logger.Error("Failed to capture memory profile", zap.Error(err))
		}
	}
	
	// Capture block profile
	if p.config.BlockProfile {
		if err := p.CaptureBlockProfile(); err != nil {
			p.logger.Error("Failed to capture block profile", zap.Error(err))
		}
	}
	
	// Capture mutex profile
	if p.config.MutexProfile {
		if err := p.CaptureMutexProfile(); err != nil {
			p.logger.Error("Failed to capture mutex profile", zap.Error(err))
		}
	}
	
	// Capture goroutine profile
	if p.config.GoroutineProfile {
		if err := p.CaptureGoroutineProfile(); err != nil {
			p.logger.Error("Failed to capture goroutine profile", zap.Error(err))
		}
	}
	
	// Rotate trace
	if p.config.TraceProfile {
		p.StopTrace()
		time.Sleep(100 * time.Millisecond)
		if err := p.StartTrace(); err != nil {
			p.logger.Error("Failed to restart trace", zap.Error(err))
		}
	}
}

// StartCPUProfile starts CPU profiling
func (p *Profiler) StartCPUProfile() error {
	if _, exists := p.activeProfiles["cpu"]; exists && p.activeProfiles["cpu"].Active {
		return fmt.Errorf("CPU profile already active")
	}
	
	filename := p.generateFilename("cpu", "prof")
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create CPU profile file: %w", err)
	}
	
	if err := pprof.StartCPUProfile(file); err != nil {
		file.Close()
		return fmt.Errorf("failed to start CPU profile: %w", err)
	}
	
	p.activeProfiles["cpu"] = &Profile{
		Type:      "cpu",
		StartTime: time.Now(),
		File:      file,
		Active:    true,
	}
	
	p.logger.Info("CPU profiling started", zap.String("file", filename))
	return nil
}

// StopCPUProfile stops CPU profiling
func (p *Profiler) StopCPUProfile() {
	if profile, exists := p.activeProfiles["cpu"]; exists && profile.Active {
		pprof.StopCPUProfile()
		profile.File.Close()
		profile.Active = false
		
		duration := time.Since(profile.StartTime)
		p.logger.Info("CPU profiling stopped",
			zap.String("file", profile.File.Name()),
			zap.Duration("duration", duration),
		)
	}
}

// CaptureMemProfile captures a memory profile
func (p *Profiler) CaptureMemProfile() error {
	filename := p.generateFilename("mem", "prof")
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create memory profile file: %w", err)
	}
	defer file.Close()
	
	runtime.GC() // Get up-to-date statistics
	
	if err := pprof.WriteHeapProfile(file); err != nil {
		return fmt.Errorf("failed to write memory profile: %w", err)
	}
	
	p.logger.Info("Memory profile captured", zap.String("file", filename))
	return nil
}

// CaptureBlockProfile captures a block profile
func (p *Profiler) CaptureBlockProfile() error {
	filename := p.generateFilename("block", "prof")
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create block profile file: %w", err)
	}
	defer file.Close()
	
	if err := pprof.Lookup("block").WriteTo(file, 0); err != nil {
		return fmt.Errorf("failed to write block profile: %w", err)
	}
	
	p.logger.Info("Block profile captured", zap.String("file", filename))
	return nil
}

// CaptureMutexProfile captures a mutex profile
func (p *Profiler) CaptureMutexProfile() error {
	filename := p.generateFilename("mutex", "prof")
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create mutex profile file: %w", err)
	}
	defer file.Close()
	
	if err := pprof.Lookup("mutex").WriteTo(file, 0); err != nil {
		return fmt.Errorf("failed to write mutex profile: %w", err)
	}
	
	p.logger.Info("Mutex profile captured", zap.String("file", filename))
	return nil
}

// CaptureGoroutineProfile captures a goroutine profile
func (p *Profiler) CaptureGoroutineProfile() error {
	filename := p.generateFilename("goroutine", "prof")
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create goroutine profile file: %w", err)
	}
	defer file.Close()
	
	if err := pprof.Lookup("goroutine").WriteTo(file, 0); err != nil {
		return fmt.Errorf("failed to write goroutine profile: %w", err)
	}
	
	p.logger.Info("Goroutine profile captured", zap.String("file", filename))
	return nil
}

// StartTrace starts execution tracing
func (p *Profiler) StartTrace() error {
	if _, exists := p.activeProfiles["trace"]; exists && p.activeProfiles["trace"].Active {
		return fmt.Errorf("trace already active")
	}
	
	filename := p.generateFilename("trace", "out")
	file, err := os.Create(filename)
	if err != nil {
		return fmt.Errorf("failed to create trace file: %w", err)
	}
	
	if err := trace.Start(file); err != nil {
		file.Close()
		return fmt.Errorf("failed to start trace: %w", err)
	}
	
	p.activeProfiles["trace"] = &Profile{
		Type:      "trace",
		StartTime: time.Now(),
		File:      file,
		Active:    true,
	}
	
	p.logger.Info("Execution tracing started", zap.String("file", filename))
	return nil
}

// StopTrace stops execution tracing
func (p *Profiler) StopTrace() {
	if profile, exists := p.activeProfiles["trace"]; exists && profile.Active {
		trace.Stop()
		profile.File.Close()
		profile.Active = false
		
		duration := time.Since(profile.StartTime)
		p.logger.Info("Execution tracing stopped",
			zap.String("file", profile.File.Name()),
			zap.Duration("duration", duration),
		)
	}
}

// stopProfile stops a specific profile type
func (p *Profiler) stopProfile(profileType string) {
	switch profileType {
	case "cpu":
		p.StopCPUProfile()
	case "trace":
		p.StopTrace()
	}
}

// generateFilename generates a profile filename
func (p *Profiler) generateFilename(profileType, extension string) string {
	timestamp := time.Now().Format("20060102-150405")
	return fmt.Sprintf("%s/%s-%s.%s", p.profileDir, profileType, timestamp, extension)
}

// GetProfileStats returns profiling statistics
func (p *Profiler) GetProfileStats() map[string]interface{} {
	stats := map[string]interface{}{
		"enabled":        p.config.Enabled,
		"pprof_address":  p.config.PProfAddr,
		"profile_dir":    p.profileDir,
		"active_profiles": []string{},
	}
	
	// List active profiles
	activeProfiles := []string{}
	for name, profile := range p.activeProfiles {
		if profile.Active {
			activeProfiles = append(activeProfiles, name)
		}
	}
	stats["active_profiles"] = activeProfiles
	
	// Memory stats
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	stats["memory"] = map[string]interface{}{
		"alloc_mb":      m.Alloc / 1024 / 1024,
		"total_alloc_mb": m.TotalAlloc / 1024 / 1024,
		"sys_mb":        m.Sys / 1024 / 1024,
		"num_gc":        m.NumGC,
		"gc_cpu_percent": m.GCCPUFraction * 100,
	}
	
	// Runtime stats
	stats["runtime"] = map[string]interface{}{
		"goroutines": runtime.NumGoroutine(),
		"cpus":       runtime.NumCPU(),
		"go_version": runtime.Version(),
	}
	
	return stats
}