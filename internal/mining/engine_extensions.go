package mining

import (
	"fmt"
	"runtime"
	"sync/atomic"
	"time"
)

// GetStatus returns current engine status
func (e *UnifiedEngine) GetStatus() *EngineStatus {
	return &EngineStatus{
		Running:   e.running.Load(),
		Algorithm: e.algorithm.Load().(Algorithm),
		Pool:      e.poolURL,
		Wallet:    e.walletAddr,
		Uptime:    time.Since(e.startTime),
	}
}

// GetStartTime returns engine start time
func (e *UnifiedEngine) GetStartTime() time.Time {
	return e.startTime
}

// GetAlgorithm returns current algorithm
func (e *UnifiedEngine) GetAlgorithm() Algorithm {
	return e.algorithm.Load().(Algorithm)
}

// GetCPUThreads returns number of CPU threads
func (e *UnifiedEngine) GetCPUThreads() int {
	return e.config.CPUThreads
}

// GetConfig returns engine configuration as map
func (e *UnifiedEngine) GetConfig() map[string]interface{} {
	return map[string]interface{}{
		"cpu_threads":   e.config.CPUThreads,
		"gpu_devices":   e.config.GPUDevices,
		"asic_devices":  e.config.ASICDevices,
		"algorithm":     e.config.Algorithm,
		"intensity":     e.config.Intensity,
		"max_memory_mb": e.config.MaxMemoryMB,
		"auto_optimize": e.config.AutoOptimize,
		"huge_pages":    e.config.HugePages,
		"numa":          e.config.NUMA,
	}
}

// GetHardwareInfo returns hardware information
func (e *UnifiedEngine) GetHardwareInfo() *HardwareInfo {
	info := &HardwareInfo{
		CPUThreads:  e.config.CPUThreads,
		GPUDevices:  make([]GPUInfo, 0),
		ASICDevices: make([]ASICInfo, 0),
	}
	
	// Get memory info
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	info.TotalMemory = m.TotalAlloc
	info.AvailMemory = m.Sys - m.Alloc
	
	// Get GPU info
	for i, deviceID := range e.config.GPUDevices {
		info.GPUDevices = append(info.GPUDevices, GPUInfo{
			ID:       deviceID,
			Name:     fmt.Sprintf("GPU %d", i),
			Memory:   4096 * 1024 * 1024, // Placeholder
			Temp:     70,                  // Placeholder
			FanSpeed: 60,                  // Placeholder
		})
	}
	
	// Get ASIC info
	for _, devicePath := range e.config.ASICDevices {
		info.ASICDevices = append(info.ASICDevices, ASICInfo{
			ID:     devicePath,
			Model:  "Unknown",
			Status: "Active",
			Temp:   80, // Placeholder
		})
	}
	
	return info
}

// GetStatsHistory returns stats history for given duration
func (e *UnifiedEngine) GetStatsHistory(duration time.Duration) []StatsSnapshot {
	e.historyMu.RLock()
	defer e.historyMu.RUnlock()
	
	cutoff := time.Now().Add(-duration)
	result := make([]StatsSnapshot, 0)
	
	for _, snapshot := range e.statsHistory {
		if snapshot.Timestamp.After(cutoff) {
			result = append(result, snapshot)
		}
	}
	
	return result
}

// GetAutoTuner returns auto tuner if available
func (e *UnifiedEngine) GetAutoTuner() *AutoTuner {
	return e.autoTuner
}

// GetProfitSwitcher returns profit switcher if available
func (e *UnifiedEngine) GetProfitSwitcher() *ProfitSwitcher {
	return e.profitSwitcher
}

// ResetStats resets all statistics
func (e *UnifiedEngine) ResetStats() {
	e.sharesSubmitted.Store(0)
	e.sharesAccepted.Store(0)
	e.totalHashRate.Store(0)
	
	if e.stats != nil {
		e.stats.SharesRejected = 0
		e.stats.BlocksFound = 0
	}
	
	// Clear history
	e.historyMu.Lock()
	e.statsHistory = e.statsHistory[:0]
	e.historyMu.Unlock()
}

// SetAlgorithm sets the mining algorithm
func (e *UnifiedEngine) SetAlgorithm(algo Algorithm) error {
	if algo == AlgorithmUnknown {
		return fmt.Errorf("invalid algorithm")
	}
	
	// Stop current mining
	wasRunning := e.running.Load()
	if wasRunning {
		e.Stop()
	}
	
	// Update algorithm
	e.algorithm.Store(algo)
	e.config.Algorithm = string(algo)
	
	// Restart if was running
	if wasRunning {
		return e.Start()
	}
	
	return nil
}

// SetPool sets the mining pool
func (e *UnifiedEngine) SetPool(url, wallet string) error {
	if url == "" || wallet == "" {
		return fmt.Errorf("invalid pool configuration")
	}
	
	e.poolURL = url
	e.walletAddr = wallet
	
	// Update pool connection if running
	if e.running.Load() && e.pool != nil {
		return e.pool.Connect(url, wallet)
	}
	
	return nil
}

// SetConfig sets a configuration value
func (e *UnifiedEngine) SetConfig(key string, value interface{}) error {
	switch key {
	case "cpu_threads":
		threads, ok := value.(int)
		if !ok || threads < 0 || threads > 256 {
			return fmt.Errorf("invalid cpu_threads value")
		}
		e.config.CPUThreads = threads
		
	case "intensity":
		intensity, ok := value.(int)
		if !ok || intensity < 1 || intensity > 100 {
			return fmt.Errorf("invalid intensity value")
		}
		e.config.Intensity = intensity
		
	case "auto_optimize":
		optimize, ok := value.(bool)
		if !ok {
			return fmt.Errorf("invalid auto_optimize value")
		}
		e.config.AutoOptimize = optimize
		
	default:
		return fmt.Errorf("unknown config key: %s", key)
	}
	
	return nil
}

// SetGPUSettings sets GPU settings
func (e *UnifiedEngine) SetGPUSettings(coreClock, memoryClock, powerLimit int) error {
	// This would interface with actual GPU drivers
	// For now, just validate ranges
	if coreClock < -500 || coreClock > 500 {
		return fmt.Errorf("invalid core clock offset")
	}
	if memoryClock < -2000 || memoryClock > 2000 {
		return fmt.Errorf("invalid memory clock offset")
	}
	if powerLimit < 50 || powerLimit > 120 {
		return fmt.Errorf("invalid power limit")
	}
	
	// Apply to GPU workers
	e.workersMu.RLock()
	defer e.workersMu.RUnlock()
	
	for _, worker := range e.workers {
		if worker.GetType() == WorkerGPU {
			// Apply settings to GPU worker
			// This is a placeholder - actual implementation would call GPU APIs
		}
	}
	
	return nil
}

// SetCPUThreads sets the number of CPU threads
func (e *UnifiedEngine) SetCPUThreads(threads int) error {
	if threads < 0 || threads > runtime.NumCPU()*2 {
		return fmt.Errorf("invalid thread count")
	}
	
	// Stop current CPU workers
	wasRunning := e.running.Load()
	if wasRunning {
		e.Stop()
	}
	
	// Update configuration
	e.config.CPUThreads = threads
	
	// Restart if was running
	if wasRunning {
		return e.Start()
	}
	
	return nil
}

// HasGPU returns true if GPU mining is enabled
func (e *UnifiedEngine) HasGPU() bool {
	return len(e.config.GPUDevices) > 0
}

// HasCPU returns true if CPU mining is enabled
func (e *UnifiedEngine) HasCPU() bool {
	return e.config.CPUThreads > 0
}

// HasASIC returns true if ASIC mining is enabled
func (e *UnifiedEngine) HasASIC() bool {
	return len(e.config.ASICDevices) > 0
}

// recordStatsSnapshot records a stats snapshot for history
func (e *UnifiedEngine) recordStatsSnapshot() {
	snapshot := StatsSnapshot{
		Timestamp: time.Now(),
		Stats:     *e.GetStats(),
	}
	
	e.historyMu.Lock()
	e.statsHistory = append(e.statsHistory, snapshot)
	
	// Keep only last 24 hours of history
	cutoff := time.Now().Add(-24 * time.Hour)
	newHistory := make([]StatsSnapshot, 0, len(e.statsHistory))
	for _, s := range e.statsHistory {
		if s.Timestamp.After(cutoff) {
			newHistory = append(newHistory, s)
		}
	}
	e.statsHistory = newHistory
	e.historyMu.Unlock()
}

// Update currentHashRate for other components
func (e *UnifiedEngine) updateCurrentHashRate() {
	rate := e.totalHashRate.Load()
	e.currentHashRate.Store(rate)
	
	// Record snapshot periodically
	e.recordStatsSnapshot()
}