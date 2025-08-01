package mining

import (
	"context"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// AutoTuner provides automatic hardware optimization
type AutoTuner struct {
	logger   *zap.Logger
	engine   Engine
	
	// Tuning state
	running  atomic.Bool
	tuning   atomic.Bool
	
	// Performance tracking
	baselineHashrate atomic.Uint64
	currentHashrate  atomic.Uint64
	bestHashrate     atomic.Uint64
	
	// Configuration
	config   AutoTunerConfig
	profiles map[string]*TuningProfile
	mu       sync.RWMutex
	
	// Current settings
	currentProfile atomic.Value // *TuningProfile
	
	// Monitoring
	tempMonitor    *TemperatureMonitor
	powerMonitor   *PowerMonitor
	stabilityScore atomic.Uint32
	
	// Context
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// AutoTunerConfig configures auto-tuning behavior
type AutoTunerConfig struct {
	// Tuning parameters
	Enabled          bool          `yaml:"enabled"`
	Interval         time.Duration `yaml:"interval"`
	StabilityPeriod  time.Duration `yaml:"stability_period"`
	MinImprovement   float64       `yaml:"min_improvement"` // Minimum % improvement to keep settings
	
	// Safety limits
	MaxTemp          int     `yaml:"max_temp"`         // Celsius
	MaxPower         int     `yaml:"max_power"`        // Watts
	MaxFanSpeed      int     `yaml:"max_fan_speed"`    // Percentage
	ThermalThrottle  int     `yaml:"thermal_throttle"` // Temp to reduce performance
	
	// GPU specific
	MemoryOffset     int     `yaml:"memory_offset"`     // MHz
	CoreOffset       int     `yaml:"core_offset"`       // MHz
	PowerLimit       int     `yaml:"power_limit"`       // Percentage
	
	// Testing
	TestDuration     time.Duration `yaml:"test_duration"`
	WarmupTime       time.Duration `yaml:"warmup_time"`
}

// TuningProfile represents a set of tuning parameters
type TuningProfile struct {
	Name            string    `json:"name"`
	Algorithm       Algorithm `json:"algorithm"`
	
	// GPU settings
	CoreClock       int       `json:"core_clock"`       // MHz
	MemoryClock     int       `json:"memory_clock"`     // MHz
	PowerLimit      int       `json:"power_limit"`      // Percentage
	FanSpeed        int       `json:"fan_speed"`        // Percentage
	
	// CPU settings
	ThreadCount     int       `json:"thread_count"`
	Affinity        []int     `json:"affinity"`         // CPU cores
	Priority        int       `json:"priority"`         // Process priority
	
	// Performance metrics
	Hashrate        uint64    `json:"hashrate"`
	Power           uint32    `json:"power"`            // Watts
	Efficiency      float64   `json:"efficiency"`       // Hash/Watt
	Temperature     int32     `json:"temperature"`      // Celsius
	
	// Metadata
	TestedAt        time.Time `json:"tested_at"`
	StableFor       time.Duration `json:"stable_for"`
	CrashCount      int       `json:"crash_count"`
}

// NewAutoTuner creates a new auto-tuner
func NewAutoTuner(logger *zap.Logger, engine Engine, config AutoTunerConfig) *AutoTuner {
	ctx, cancel := context.WithCancel(context.Background())
	
	at := &AutoTuner{
		logger:   logger,
		engine:   engine,
		config:   config,
		profiles: make(map[string]*TuningProfile),
		ctx:      ctx,
		cancel:   cancel,
	}
	
	// Initialize monitors
	at.tempMonitor = NewTemperatureMonitor(logger)
	at.powerMonitor = NewPowerMonitor(logger)
	
	// Load default profiles
	at.loadDefaultProfiles()
	
	return at
}

// Start begins auto-tuning
func (at *AutoTuner) Start() error {
	if !at.running.CompareAndSwap(false, true) {
		return fmt.Errorf("auto-tuner already running")
	}
	
	at.logger.Info("Starting auto-tuner",
		zap.Duration("interval", at.config.Interval),
		zap.Float64("min_improvement", at.config.MinImprovement),
		zap.Int("max_temp", at.config.MaxTemp),
	)
	
	// Start monitoring
	at.wg.Add(1)
	go at.monitorLoop()
	
	// Start tuning loop
	if at.config.Enabled {
		at.wg.Add(1)
		go at.tuningLoop()
	}
	
	return nil
}

// Stop stops auto-tuning
func (at *AutoTuner) Stop() error {
	if !at.running.CompareAndSwap(true, false) {
		return fmt.Errorf("auto-tuner not running")
	}
	
	at.logger.Info("Stopping auto-tuner")
	
	at.cancel()
	at.wg.Wait()
	
	return nil
}

// TuneHardware performs one-time hardware tuning
func (at *AutoTuner) TuneHardware() (*TuningProfile, error) {
	if !at.tuning.CompareAndSwap(false, true) {
		return nil, fmt.Errorf("tuning already in progress")
	}
	defer at.tuning.Store(false)
	
	at.logger.Info("Starting hardware tuning")
	
	// Get baseline performance
	baseline, err := at.measureBaseline()
	if err != nil {
		return nil, fmt.Errorf("failed to measure baseline: %w", err)
	}
	
	at.baselineHashrate.Store(baseline.Hashrate)
	bestProfile := baseline
	
	// Test different configurations
	profiles := at.generateTestProfiles()
	
	for i, profile := range profiles {
		at.logger.Info("Testing profile",
			zap.Int("index", i+1),
			zap.Int("total", len(profiles)),
			zap.String("name", profile.Name),
		)
		
		// Apply profile
		if err := at.applyProfile(profile); err != nil {
			at.logger.Warn("Failed to apply profile",
				zap.String("name", profile.Name),
				zap.Error(err),
			)
			continue
		}
		
		// Test profile
		result, err := at.testProfile(profile)
		if err != nil {
			at.logger.Warn("Profile test failed",
				zap.String("name", profile.Name),
				zap.Error(err),
			)
			continue
		}
		
		// Check if better
		if result.Hashrate > bestProfile.Hashrate {
			improvement := float64(result.Hashrate-bestProfile.Hashrate) / float64(bestProfile.Hashrate) * 100
			if improvement >= at.config.MinImprovement {
				at.logger.Info("Found better profile",
					zap.String("name", result.Name),
					zap.Uint64("hashrate", result.Hashrate),
					zap.Float64("improvement", improvement),
				)
				bestProfile = result
			}
		}
	}
	
	// Apply best profile
	if err := at.applyProfile(bestProfile); err != nil {
		return nil, fmt.Errorf("failed to apply best profile: %w", err)
	}
	
	at.bestHashrate.Store(bestProfile.Hashrate)
	at.currentProfile.Store(bestProfile)
	
	// Save profile
	at.saveProfile(bestProfile)
	
	at.logger.Info("Hardware tuning complete",
		zap.String("best_profile", bestProfile.Name),
		zap.Uint64("hashrate", bestProfile.Hashrate),
		zap.Float64("efficiency", bestProfile.Efficiency),
	)
	
	return bestProfile, nil
}

// GetCurrentProfile returns the current tuning profile
func (at *AutoTuner) GetCurrentProfile() *TuningProfile {
	if profile := at.currentProfile.Load(); profile != nil {
		return profile.(*TuningProfile)
	}
	return nil
}

// GetProfiles returns all saved profiles
func (at *AutoTuner) GetProfiles() map[string]*TuningProfile {
	at.mu.RLock()
	defer at.mu.RUnlock()
	
	profiles := make(map[string]*TuningProfile)
	for k, v := range at.profiles {
		profiles[k] = v
	}
	
	return profiles
}

// monitorLoop continuously monitors hardware health
func (at *AutoTuner) monitorLoop() {
	defer at.wg.Done()
	
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-at.ctx.Done():
			return
		case <-ticker.C:
			at.checkHardwareHealth()
		}
	}
}

// tuningLoop periodically retunes hardware
func (at *AutoTuner) tuningLoop() {
	defer at.wg.Done()
	
	// Initial tuning
	time.Sleep(at.config.WarmupTime)
	if _, err := at.TuneHardware(); err != nil {
		at.logger.Error("Initial tuning failed", zap.Error(err))
	}
	
	ticker := time.NewTicker(at.config.Interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-at.ctx.Done():
			return
		case <-ticker.C:
			// Check if retuning needed
			if at.shouldRetune() {
				if _, err := at.TuneHardware(); err != nil {
					at.logger.Error("Retuning failed", zap.Error(err))
				}
			}
		}
	}
}

// checkHardwareHealth monitors and responds to hardware issues
func (at *AutoTuner) checkHardwareHealth() {
	// Check temperature
	temp := at.tempMonitor.GetCurrentTemp()
	if temp > at.config.MaxTemp {
		at.logger.Warn("High temperature detected",
			zap.Int("temp", temp),
			zap.Int("max", at.config.MaxTemp),
		)
		at.reducePower(10) // Reduce power by 10%
	} else if temp > at.config.ThermalThrottle {
		at.reducePower(5) // Reduce power by 5%
	}
	
	// Check power
	power := at.powerMonitor.GetCurrentPower()
	if power > uint32(at.config.MaxPower) {
		at.logger.Warn("High power consumption",
			zap.Uint32("power", power),
			zap.Int("max", at.config.MaxPower),
		)
		at.reducePower(5)
	}
	
	// Update stability score
	if at.isStable() {
		score := at.stabilityScore.Load()
		if score < 100 {
			at.stabilityScore.Add(1)
		}
	} else {
		at.stabilityScore.Store(0)
	}
}

// shouldRetune determines if hardware should be retuned
func (at *AutoTuner) shouldRetune() bool {
	// Check stability
	if at.stabilityScore.Load() < 50 {
		return false // Not stable enough
	}
	
	// Check performance degradation
	current := at.currentHashrate.Load()
	best := at.bestHashrate.Load()
	if best > 0 && current < uint64(float64(best)*0.95) {
		at.logger.Info("Performance degradation detected",
			zap.Uint64("current", current),
			zap.Uint64("best", best),
		)
		return true
	}
	
	return false
}

// measureBaseline measures baseline performance
func (at *AutoTuner) measureBaseline() (*TuningProfile, error) {
	profile := &TuningProfile{
		Name:      "baseline",
		Algorithm: at.engine.GetAlgorithm(),
		TestedAt:  time.Now(),
	}
	
	// Warmup
	time.Sleep(at.config.WarmupTime)
	
	// Measure
	start := time.Now()
	startShares := at.engine.GetStats().SharesAccepted
	
	time.Sleep(at.config.TestDuration)
	
	endShares := at.engine.GetStats().SharesAccepted
	duration := time.Since(start)
	
	// Calculate hashrate
	shares := endShares - startShares
	profile.Hashrate = uint64(float64(shares) / duration.Seconds() * 1e6) // Approximate
	
	// Get other metrics
	profile.Temperature = at.tempMonitor.GetCurrentTemp()
	profile.Power = at.powerMonitor.GetCurrentPower()
	if profile.Power > 0 {
		profile.Efficiency = float64(profile.Hashrate) / float64(profile.Power)
	}
	
	return profile, nil
}

// generateTestProfiles creates profiles to test
func (at *AutoTuner) generateTestProfiles() []*TuningProfile {
	var profiles []*TuningProfile
	
	// GPU profiles
	if at.engine.HasGPU() {
		// Memory-focused profiles
		for i := -100; i <= 100; i += 50 {
			profile := &TuningProfile{
				Name:        fmt.Sprintf("gpu_mem_%+d", i),
				Algorithm:   at.engine.GetAlgorithm(),
				MemoryClock: i,
				CoreClock:   0,
				PowerLimit:  100,
			}
			profiles = append(profiles, profile)
		}
		
		// Core-focused profiles
		for i := -50; i <= 50; i += 25 {
			profile := &TuningProfile{
				Name:        fmt.Sprintf("gpu_core_%+d", i),
				Algorithm:   at.engine.GetAlgorithm(),
				MemoryClock: 0,
				CoreClock:   i,
				PowerLimit:  100,
			}
			profiles = append(profiles, profile)
		}
		
		// Power-limited profiles
		for i := 70; i <= 100; i += 10 {
			profile := &TuningProfile{
				Name:        fmt.Sprintf("gpu_power_%d", i),
				Algorithm:   at.engine.GetAlgorithm(),
				MemoryClock: 0,
				CoreClock:   0,
				PowerLimit:  i,
			}
			profiles = append(profiles, profile)
		}
	}
	
	// CPU profiles
	if at.engine.HasCPU() {
		maxThreads := at.engine.GetCPUThreads()
		for i := 1; i <= maxThreads; i++ {
			profile := &TuningProfile{
				Name:        fmt.Sprintf("cpu_threads_%d", i),
				Algorithm:   at.engine.GetAlgorithm(),
				ThreadCount: i,
			}
			profiles = append(profiles, profile)
		}
	}
	
	return profiles
}

// applyProfile applies tuning settings
func (at *AutoTuner) applyProfile(profile *TuningProfile) error {
	// GPU settings
	if at.engine.HasGPU() && (profile.CoreClock != 0 || profile.MemoryClock != 0 || profile.PowerLimit != 100) {
		if err := at.engine.SetGPUSettings(profile.CoreClock, profile.MemoryClock, profile.PowerLimit); err != nil {
			return fmt.Errorf("failed to apply GPU settings: %w", err)
		}
	}
	
	// CPU settings
	if at.engine.HasCPU() && profile.ThreadCount > 0 {
		if err := at.engine.SetCPUThreads(profile.ThreadCount); err != nil {
			return fmt.Errorf("failed to set CPU threads: %w", err)
		}
	}
	
	return nil
}

// testProfile tests a tuning profile
func (at *AutoTuner) testProfile(profile *TuningProfile) (*TuningProfile, error) {
	result := *profile // Copy
	result.TestedAt = time.Now()
	
	// Warmup
	time.Sleep(at.config.WarmupTime)
	
	// Test
	start := time.Now()
	startStats := at.engine.GetStats()
	
	// Monitor for crashes/errors
	errorCount := 0
	go func() {
		for {
			select {
			case <-at.ctx.Done():
				return
			case <-time.After(1 * time.Second):
				if time.Since(start) > at.config.TestDuration {
					return
				}
				// Check for errors
				currentStats := at.engine.GetStats()
				if currentStats.Errors > startStats.Errors {
					errorCount++
				}
			}
		}
	}()
	
	time.Sleep(at.config.TestDuration)
	
	endStats := at.engine.GetStats()
	duration := time.Since(start)
	
	// Calculate results
	shares := endStats.SharesAccepted - startStats.SharesAccepted
	result.Hashrate = uint64(float64(shares) / duration.Seconds() * 1e6) // Approximate
	
	// Get metrics
	result.Temperature = at.tempMonitor.GetCurrentTemp()
	result.Power = at.powerMonitor.GetCurrentPower()
	if result.Power > 0 {
		result.Efficiency = float64(result.Hashrate) / float64(result.Power)
	}
	
	result.CrashCount = errorCount
	
	// Check if stable
	if errorCount > 0 || result.Temperature > int32(at.config.MaxTemp) {
		return nil, fmt.Errorf("profile unstable: errors=%d, temp=%d", errorCount, result.Temperature)
	}
	
	return &result, nil
}

// reducePower reduces power consumption
func (at *AutoTuner) reducePower(percent int) {
	if profile := at.GetCurrentProfile(); profile != nil {
		newPowerLimit := profile.PowerLimit - percent
		if newPowerLimit < 50 {
			newPowerLimit = 50 // Minimum 50%
		}
		
		at.logger.Info("Reducing power limit",
			zap.Int("current", profile.PowerLimit),
			zap.Int("new", newPowerLimit),
		)
		
		profile.PowerLimit = newPowerLimit
		at.applyProfile(profile)
	}
}

// isStable checks if current settings are stable
func (at *AutoTuner) isStable() bool {
	// Check temperature
	if at.tempMonitor.GetCurrentTemp() > int32(at.config.MaxTemp) {
		return false
	}
	
	// Check hashrate variance
	current := at.currentHashrate.Load()
	if current == 0 {
		return false
	}
	
	// Get recent hashrates and check variance
	// (simplified - in production would track history)
	return true
}

// saveProfile saves a profile to storage
func (at *AutoTuner) saveProfile(profile *TuningProfile) {
	at.mu.Lock()
	defer at.mu.Unlock()
	
	key := fmt.Sprintf("%s_%s", profile.Algorithm, profile.Name)
	at.profiles[key] = profile
}

// loadDefaultProfiles loads default tuning profiles
func (at *AutoTuner) loadDefaultProfiles() {
	// Add some default safe profiles
	at.profiles["default_efficient"] = &TuningProfile{
		Name:       "efficient",
		PowerLimit: 80,
		Efficiency: 1.0,
	}
	
	at.profiles["default_balanced"] = &TuningProfile{
		Name:       "balanced",
		PowerLimit: 90,
		Efficiency: 0.9,
	}
	
	at.profiles["default_performance"] = &TuningProfile{
		Name:       "performance",
		PowerLimit: 100,
		Efficiency: 0.8,
	}
}

// TemperatureMonitor monitors hardware temperature
type TemperatureMonitor struct {
	logger      *zap.Logger
	currentTemp atomic.Int32
}

func NewTemperatureMonitor(logger *zap.Logger) *TemperatureMonitor {
	return &TemperatureMonitor{
		logger: logger,
	}
}

func (tm *TemperatureMonitor) GetCurrentTemp() int32 {
	// In production, this would read actual hardware sensors
	return tm.currentTemp.Load()
}

// PowerMonitor monitors power consumption
type PowerMonitor struct {
	logger       *zap.Logger
	currentPower atomic.Uint32
}

func NewPowerMonitor(logger *zap.Logger) *PowerMonitor {
	return &PowerMonitor{
		logger: logger,
	}
}

func (pm *PowerMonitor) GetCurrentPower() uint32 {
	// In production, this would read actual power sensors
	return pm.currentPower.Load()
}