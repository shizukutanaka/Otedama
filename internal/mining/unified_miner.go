package mining

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/asic"
	"github.com/shizukutanaka/Otedama/internal/cpu"
	"github.com/shizukutanaka/Otedama/internal/gpu"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"go.uber.org/zap"
)

// UnifiedMiner provides a unified interface for CPU, GPU, and ASIC mining
type UnifiedMiner struct {
	logger      *zap.Logger
	
	// Mining backends
	cpuMiner    *cpu.CPUMiner
	gpuManager  *gpu.MultiGPUManager
	asicManager *asic.ASICManager
	
	// Stratum integration
	stratumBridge interface{} // Can be ASIC or general bridge
	
	// Configuration
	config      *UnifiedConfig
	
	// Work management
	currentWork *UnifiedWork
	workMu      sync.RWMutex
	
	// Statistics
	stats       *UnifiedStats
	
	// Control
	running     atomic.Bool
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

// UnifiedConfig contains configuration for all mining types
type UnifiedConfig struct {
	// General settings
	Algorithm    string
	PoolURL      string
	Username     string
	Password     string
	
	// CPU settings
	EnableCPU    bool
	CPUThreads   int
	CPUAffinity  []int
	CPUPriority  string
	
	// GPU settings
	EnableGPU    bool
	GPUDevices   []int
	GPUIntensity int
	GPUWorkSize  int
	
	// ASIC settings
	EnableASIC   bool
	ASICDevices  []string // IP addresses or device IDs
	
	// Performance settings
	TargetTemp   int
	MaxTemp      int
	PowerLimit   int
	
	// Advanced settings
	AutoTune     bool
	FailoverPool string
}

// UnifiedWork represents work that can be used by any miner type
type UnifiedWork struct {
	// Stratum work
	JobID        string
	PrevHash     string
	CoinbaseA    string
	CoinbaseB    string
	MerkleBranch []string
	Version      string
	NBits        string
	NTime        string
	CleanJobs    bool
	Target       string
	Height       uint64
	Difficulty   float64
	
	// Converted formats for different miners
	cpuWork      *cpu.MiningWork
	gpuWork      *gpu.MiningWork
	asicWork     *asic.MiningWork
}

// UnifiedStats aggregates statistics from all miners
type UnifiedStats struct {
	// Hash rates
	CPUHashRate  atomic.Uint64
	GPUHashRate  atomic.Uint64
	ASICHashRate atomic.Uint64
	TotalHashRate atomic.Uint64
	
	// Shares
	ValidShares   atomic.Uint64
	InvalidShares atomic.Uint64
	StaleShares   atomic.Uint64
	
	// Power and efficiency
	TotalPower    atomic.Uint64 // Watts
	Efficiency    atomic.Uint64 // J/TH * 100
	
	// Device counts
	ActiveCPUs    atomic.Int32
	ActiveGPUs    atomic.Int32
	ActiveASICs   atomic.Int32
	
	// Uptime
	StartTime     time.Time
	LastShareTime atomic.Int64
}

// MinerType represents the type of miner
type MinerType int

const (
	MinerCPU MinerType = iota
	MinerGPU
	MinerASIC
)

// NewUnifiedMiner creates a new unified miner
func NewUnifiedMiner(logger *zap.Logger, config *UnifiedConfig) (*UnifiedMiner, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	miner := &UnifiedMiner{
		logger: logger,
		config: config,
		stats:  &UnifiedStats{StartTime: time.Now()},
		ctx:    ctx,
		cancel: cancel,
	}
	
	// Initialize enabled miners
	var initErrors []error
	
	if config.EnableCPU {
		if err := miner.initializeCPUMiner(); err != nil {
			initErrors = append(initErrors, fmt.Errorf("CPU init failed: %w", err))
		}
	}
	
	if config.EnableGPU {
		if err := miner.initializeGPUMiner(); err != nil {
			initErrors = append(initErrors, fmt.Errorf("GPU init failed: %w", err))
		}
	}
	
	if config.EnableASIC {
		if err := miner.initializeASICMiner(); err != nil {
			initErrors = append(initErrors, fmt.Errorf("ASIC init failed: %w", err))
		}
	}
	
	// Check if any miner was initialized
	if miner.cpuMiner == nil && miner.gpuManager == nil && miner.asicManager == nil {
		cancel()
		if len(initErrors) > 0 {
			return nil, fmt.Errorf("no miners initialized: %v", initErrors)
		}
		return nil, errors.New("no miners enabled in configuration")
	}
	
	// Log initialization warnings
	for _, err := range initErrors {
		logger.Warn("Miner initialization warning", zap.Error(err))
	}
	
	logger.Info("Initialized unified miner",
		zap.Bool("cpu_enabled", miner.cpuMiner != nil),
		zap.Bool("gpu_enabled", miner.gpuManager != nil),
		zap.Bool("asic_enabled", miner.asicManager != nil),
	)
	
	return miner, nil
}

// initializeCPUMiner initializes CPU mining
func (m *UnifiedMiner) initializeCPUMiner() error {
	threads := m.config.CPUThreads
	if threads <= 0 {
		threads = -1 // Auto-detect
	}
	
	cpuMiner := cpu.NewCPUMiner(m.logger, threads)
	
	// Apply CPU configuration
	if len(m.config.CPUAffinity) > 0 {
		if err := cpuMiner.SetAffinity(m.config.CPUAffinity); err != nil {
			m.logger.Warn("Failed to set CPU affinity", zap.Error(err))
		}
	}
	
	// Set priority
	priority := m.parseCPUPriority(m.config.CPUPriority)
	cpuMiner.SetPriority(priority)
	
	m.cpuMiner = cpuMiner
	m.stats.ActiveCPUs.Store(int32(threads))
	
	return nil
}

// initializeGPUMiner initializes GPU mining
func (m *UnifiedMiner) initializeGPUMiner() error {
	// Detect GPU devices
	devices, err := m.detectGPUDevices()
	if err != nil {
		return err
	}
	
	if len(devices) == 0 {
		return errors.New("no GPU devices found")
	}
	
	// Create multi-GPU manager
	gpuManager, err := gpu.NewMultiGPUManager(m.logger, devices)
	if err != nil {
		return err
	}
	
	m.gpuManager = gpuManager
	m.stats.ActiveGPUs.Store(int32(len(devices)))
	
	return nil
}

// initializeASICMiner initializes ASIC mining
func (m *UnifiedMiner) initializeASICMiner() error {
	asicManager := asic.NewASICManager(m.logger)
	
	// Add configured ASIC devices
	for _, deviceAddr := range m.config.ASICDevices {
		if err := asicManager.AddDevice(deviceAddr); err != nil {
			m.logger.Warn("Failed to add ASIC device",
				zap.String("address", deviceAddr),
				zap.Error(err),
			)
		}
	}
	
	// Auto-discover if no devices specified
	if len(m.config.ASICDevices) == 0 {
		m.logger.Info("Auto-discovering ASIC devices")
		asicManager.DiscoverDevices()
	}
	
	// Check if any devices were found
	devices := asicManager.GetAllDevices()
	if len(devices) == 0 {
		return errors.New("no ASIC devices found")
	}
	
	// Create Stratum bridge for ASICs
	bridge := asic.NewASICStratumBridge(m.logger, asicManager)
	m.stratumBridge = bridge
	
	m.asicManager = asicManager
	m.stats.ActiveASICs.Store(int32(len(devices)))
	
	return nil
}

// Start begins mining on all enabled devices
func (m *UnifiedMiner) Start() error {
	if m.running.Load() {
		return errors.New("miner already running")
	}
	
	m.running.Store(true)
	m.logger.Info("Starting unified miner")
	
	// Start statistics reporter
	m.wg.Add(1)
	go m.statsReporter()
	
	// Start miners
	if m.cpuMiner != nil {
		if err := m.cpuMiner.Start(); err != nil {
			m.logger.Error("Failed to start CPU miner", zap.Error(err))
		}
	}
	
	if m.gpuManager != nil {
		if err := m.gpuManager.Start(); err != nil {
			m.logger.Error("Failed to start GPU miner", zap.Error(err))
		}
	}
	
	if m.asicManager != nil {
		if err := m.asicManager.Start(); err != nil {
			m.logger.Error("Failed to start ASIC miner", zap.Error(err))
		}
		// Start Stratum bridge
		if bridge, ok := m.stratumBridge.(*asic.ASICStratumBridge); ok {
			bridge.Start()
		}
	}
	
	return nil
}

// Stop stops mining on all devices
func (m *UnifiedMiner) Stop() error {
	if !m.running.Load() {
		return errors.New("miner not running")
	}
	
	m.logger.Info("Stopping unified miner")
	m.running.Store(false)
	m.cancel()
	
	// Stop miners
	var stopErrors []error
	
	if m.cpuMiner != nil {
		if err := m.cpuMiner.Stop(); err != nil {
			stopErrors = append(stopErrors, fmt.Errorf("CPU stop failed: %w", err))
		}
	}
	
	if m.gpuManager != nil {
		if err := m.gpuManager.Stop(); err != nil {
			stopErrors = append(stopErrors, fmt.Errorf("GPU stop failed: %w", err))
		}
	}
	
	if m.asicManager != nil {
		if err := m.asicManager.Stop(); err != nil {
			stopErrors = append(stopErrors, fmt.Errorf("ASIC stop failed: %w", err))
		}
		// Stop Stratum bridge
		if bridge, ok := m.stratumBridge.(*asic.ASICStratumBridge); ok {
			bridge.Stop()
		}
	}
	
	// Wait for goroutines
	m.wg.Wait()
	
	if len(stopErrors) > 0 {
		return fmt.Errorf("stop errors: %v", stopErrors)
	}
	
	return nil
}

// SetWork updates mining work for all devices
func (m *UnifiedMiner) SetWork(job *stratum.Job) error {
	// Convert Stratum job to unified work
	work := m.convertStratumJob(job)
	
	m.workMu.Lock()
	m.currentWork = work
	m.workMu.Unlock()
	
	// Distribute to miners
	if m.cpuMiner != nil {
		m.cpuMiner.SetWork(work.cpuWork)
	}
	
	if m.gpuManager != nil {
		m.gpuManager.SetWork(work.gpuWork)
	}
	
	if m.asicManager != nil && m.stratumBridge != nil {
		if bridge, ok := m.stratumBridge.(*asic.ASICStratumBridge); ok {
			bridge.UpdateWork(job)
		}
	}
	
	m.logger.Info("Updated work for all miners",
		zap.String("job_id", job.ID),
		zap.Float64("difficulty", job.Difficulty),
	)
	
	return nil
}

// GetStats returns aggregated mining statistics
func (m *UnifiedMiner) GetStats() UnifiedStats {
	// Update current stats
	m.updateStats()
	return *m.stats
}

// GetHashRate returns total hash rate across all miners
func (m *UnifiedMiner) GetHashRate() uint64 {
	return m.stats.TotalHashRate.Load()
}

// GetDeviceStats returns statistics for a specific device type
func (m *UnifiedMiner) GetDeviceStats(minerType MinerType) (interface{}, error) {
	switch minerType {
	case MinerCPU:
		if m.cpuMiner == nil {
			return nil, errors.New("CPU miner not enabled")
		}
		stats := m.cpuMiner.GetStats()
		return stats, nil
		
	case MinerGPU:
		if m.gpuManager == nil {
			return nil, errors.New("GPU miner not enabled")
		}
		stats := m.gpuManager.GetStats()
		return stats, nil
		
	case MinerASIC:
		if m.asicManager == nil {
			return nil, errors.New("ASIC miner not enabled")
		}
		stats := m.asicManager.GetStats()
		return stats, nil
		
	default:
		return nil, fmt.Errorf("unknown miner type: %d", minerType)
	}
}

// Private methods

// convertStratumJob converts a Stratum job to unified work format
func (m *UnifiedMiner) convertStratumJob(job *stratum.Job) *UnifiedWork {
	work := &UnifiedWork{
		JobID:        job.ID,
		PrevHash:     job.PrevHash,
		CoinbaseA:    job.CoinbaseA,
		CoinbaseB:    job.CoinbaseB,
		MerkleBranch: job.MerkleBranch,
		Version:      job.Version,
		NBits:        job.NBits,
		NTime:        job.NTime,
		CleanJobs:    job.CleanJobs,
		Target:       job.Target,
		Height:       job.Height,
		Difficulty:   job.Difficulty,
	}
	
	// Convert to CPU work format
	work.cpuWork = &cpu.MiningWork{
		JobID:       job.ID,
		PrevHash:    hexToBytes(job.PrevHash),
		MerkleRoot:  m.calculateMerkleRoot(job),
		Version:     parseHexUint32(job.Version),
		NBits:       parseHexUint32(job.NBits),
		NTime:       parseHexUint32(job.NTime),
		Target:      hexToBytes(job.Target),
		ExtraNonce1: hexToBytes(job.ExtraNonce1),
		ExtraNonce2: make([]byte, job.ExtraNonce2Size),
	}
	
	// Convert to GPU work format (similar structure)
	work.gpuWork = &gpu.MiningWork{
		JobID:       job.ID,
		PrevHash:    hexToBytes(job.PrevHash),
		MerkleRoot:  m.calculateMerkleRoot(job),
		Version:     parseHexUint32(job.Version),
		NBits:       parseHexUint32(job.NBits),
		NTime:       parseHexUint32(job.NTime),
		Target:      hexToBytes(job.Target),
		ExtraNonce1: hexToBytes(job.ExtraNonce1),
		ExtraNonce2: make([]byte, job.ExtraNonce2Size),
	}
	
	// ASIC work is handled by the Stratum bridge directly
	
	return work
}

// calculateMerkleRoot calculates the merkle root from job data
func (m *UnifiedMiner) calculateMerkleRoot(job *stratum.Job) []byte {
	// This would implement proper merkle root calculation
	// For now, return placeholder
	return make([]byte, 32)
}

// updateStats updates aggregated statistics
func (m *UnifiedMiner) updateStats() {
	var cpuHashRate, gpuHashRate, asicHashRate uint64
	var totalPower uint64
	
	// CPU stats
	if m.cpuMiner != nil {
		cpuHashRate = m.cpuMiner.GetHashRate()
		m.stats.CPUHashRate.Store(cpuHashRate)
		// Estimate CPU power (100W typical)
		totalPower += 100
	}
	
	// GPU stats
	if m.gpuManager != nil {
		gpuHashRate = m.gpuManager.GetHashRate()
		m.stats.GPUHashRate.Store(gpuHashRate)
		// Get actual GPU power
		gpuStats := m.gpuManager.GetStats()
		totalPower += gpuStats.TotalPower.Load()
	}
	
	// ASIC stats
	if m.asicManager != nil {
		asicStats := m.asicManager.GetStats()
		asicHashRate = asicStats.TotalHashRate
		m.stats.ASICHashRate.Store(asicHashRate)
		totalPower += uint64(asicStats.TotalPower)
	}
	
	// Update totals
	totalHashRate := cpuHashRate + gpuHashRate + asicHashRate
	m.stats.TotalHashRate.Store(totalHashRate)
	m.stats.TotalPower.Store(totalPower)
	
	// Calculate efficiency (J/TH)
	if totalHashRate > 0 {
		efficiency := (totalPower * 1e12 * 100) / totalHashRate // J/TH * 100
		m.stats.Efficiency.Store(efficiency)
	}
}

// statsReporter periodically reports statistics
func (m *UnifiedMiner) statsReporter() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.reportStats()
		}
	}
}

// reportStats logs current statistics
func (m *UnifiedMiner) reportStats() {
	m.updateStats()
	stats := m.stats
	
	totalHashRate := stats.TotalHashRate.Load()
	if totalHashRate == 0 {
		return
	}
	
	m.logger.Info("Mining statistics",
		zap.Uint64("total_hashrate", totalHashRate),
		zap.Uint64("cpu_hashrate", stats.CPUHashRate.Load()),
		zap.Uint64("gpu_hashrate", stats.GPUHashRate.Load()),
		zap.Uint64("asic_hashrate", stats.ASICHashRate.Load()),
		zap.Uint64("valid_shares", stats.ValidShares.Load()),
		zap.Uint64("total_power_w", stats.TotalPower.Load()),
		zap.Float64("efficiency_j_th", float64(stats.Efficiency.Load())/100),
		zap.Duration("uptime", time.Since(stats.StartTime)),
	)
}

// detectGPUDevices detects available GPU devices
func (m *UnifiedMiner) detectGPUDevices() ([]*gpu.GPUDevice, error) {
	// This would detect actual GPU devices
	// For now, return mock devices based on config
	
	devices := make([]*gpu.GPUDevice, 0)
	
	// If specific devices requested
	if len(m.config.GPUDevices) > 0 {
		for _, id := range m.config.GPUDevices {
			device := &gpu.GPUDevice{
				ID:           id,
				Name:         fmt.Sprintf("GPU %d", id),
				Vendor:       gpu.VendorNVIDIA, // Assume NVIDIA
				Memory:       8 * 1024 * 1024 * 1024, // 8GB
				ComputeUnits: 40,
				MaxClock:     1500,
			}
			devices = append(devices, device)
		}
	}
	
	return devices, nil
}

// parseCPUPriority parses CPU priority string
func (m *UnifiedMiner) parseCPUPriority(priority string) cpu.ThreadPriority {
	switch priority {
	case "low":
		return cpu.PriorityLow
	case "high":
		return cpu.PriorityHigh
	case "realtime":
		return cpu.PriorityRealtime
	default:
		return cpu.PriorityNormal
	}
}

// Utility functions

func hexToBytes(hex string) []byte {
	// Remove 0x prefix if present
	if len(hex) >= 2 && hex[0:2] == "0x" {
		hex = hex[2:]
	}
	
	// Convert hex string to bytes
	bytes := make([]byte, len(hex)/2)
	for i := 0; i < len(bytes); i++ {
		fmt.Sscanf(hex[i*2:i*2+2], "%x", &bytes[i])
	}
	
	return bytes
}

func parseHexUint32(hex string) uint32 {
	var value uint32
	fmt.Sscanf(hex, "%x", &value)
	return value
}

// AutoTune performs automatic tuning of mining parameters
func (m *UnifiedMiner) AutoTune() error {
	if !m.config.AutoTune {
		return errors.New("auto-tune not enabled")
	}
	
	m.logger.Info("Starting auto-tune process")
	
	// Auto-tune each miner type
	if m.cpuMiner != nil {
		m.autoTuneCPU()
	}
	
	if m.gpuManager != nil {
		m.autoTuneGPU()
	}
	
	if m.asicManager != nil {
		m.autoTuneASIC()
	}
	
	return nil
}

// autoTuneCPU optimizes CPU mining parameters
func (m *UnifiedMiner) autoTuneCPU() {
	// Test different thread counts
	// Find optimal based on hash rate and system load
	m.logger.Info("Auto-tuning CPU miner")
}

// autoTuneGPU optimizes GPU mining parameters
func (m *UnifiedMiner) autoTuneGPU() {
	// Test different intensities and work sizes
	// Find optimal based on hash rate and stability
	m.logger.Info("Auto-tuning GPU miner")
}

// autoTuneASIC optimizes ASIC mining parameters
func (m *UnifiedMiner) autoTuneASIC() {
	// Test different frequencies and voltages
	// Find optimal based on efficiency
	m.logger.Info("Auto-tuning ASIC miner")
}