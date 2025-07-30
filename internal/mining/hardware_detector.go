package mining

import (
	"fmt"
	"runtime"
	"strings"

	"github.com/jaypipes/ghw"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/mem"
	"go.uber.org/zap"
)

// HardwareType represents the type of mining hardware
type HardwareType string

const (
	HardwareCPU  HardwareType = "CPU"
	HardwareGPU  HardwareType = "GPU"
	HardwareASIC HardwareType = "ASIC"
)

// HardwareInfo contains information about available mining hardware
type HardwareInfo struct {
	Type         HardwareType
	Name         string
	Vendor       string
	Memory       uint64 // in bytes
	ComputeUnits int
	MaxThreads   int
	Temperature  float64
	PowerLimit   int
	IsAvailable  bool
}

// HardwareDetector detects and manages mining hardware
type HardwareDetector struct {
	logger    *zap.Logger
	cpuInfo   []HardwareInfo
	gpuInfo   []HardwareInfo
	asicInfo  []HardwareInfo
}

// NewHardwareDetector creates a new hardware detector
func NewHardwareDetector(logger *zap.Logger) *HardwareDetector {
	return &HardwareDetector{
		logger: logger,
	}
}

// DetectHardware detects all available mining hardware
func (d *HardwareDetector) DetectHardware() error {
	d.logger.Info("Detecting mining hardware...")

	// Detect CPU
	if err := d.detectCPU(); err != nil {
		d.logger.Warn("Failed to detect CPU", zap.Error(err))
	}

	// Detect GPU
	if err := d.detectGPU(); err != nil {
		d.logger.Warn("Failed to detect GPU", zap.Error(err))
	}

	// Detect ASIC (placeholder - requires specific drivers)
	if err := d.detectASIC(); err != nil {
		d.logger.Debug("No ASIC hardware detected", zap.Error(err))
	}

	d.logger.Info("Hardware detection complete",
		zap.Int("cpus", len(d.cpuInfo)),
		zap.Int("gpus", len(d.gpuInfo)),
		zap.Int("asics", len(d.asicInfo)))

	return nil
}

// detectCPU detects CPU information
func (d *HardwareDetector) detectCPU() error {
	cpuInfo, err := cpu.Info()
	if err != nil {
		return fmt.Errorf("failed to get CPU info: %w", err)
	}

	virtualMem, err := mem.VirtualMemory()
	if err != nil {
		return fmt.Errorf("failed to get memory info: %w", err)
	}

	for _, info := range cpuInfo {
		hw := HardwareInfo{
			Type:         HardwareCPU,
			Name:         info.ModelName,
			Vendor:       info.VendorID,
			Memory:       virtualMem.Total,
			ComputeUnits: int(info.Cores),
			MaxThreads:   runtime.NumCPU(),
			IsAvailable:  true,
		}

		// Get CPU temperature if available
		// Note: cpu.Temperature is not available in gopsutil/v3
		// Temperature monitoring would require platform-specific implementation
		hw.Temperature = 0.0

		d.cpuInfo = append(d.cpuInfo, hw)
	}

	return nil
}

// detectGPU detects GPU information
func (d *HardwareDetector) detectGPU() error {
	gpu, err := ghw.GPU()
	if err != nil {
		return fmt.Errorf("failed to get GPU info: %w", err)
	}

	for _, card := range gpu.GraphicsCards {
		hw := HardwareInfo{
			Type:        HardwareGPU,
			Name:        card.DeviceInfo.Product.Name,
			Vendor:      card.DeviceInfo.Vendor.Name,
			IsAvailable: true,
		}

		// Parse GPU memory from node info if available
		if card.Node != nil {
			// This is a simplified approach - actual implementation
			// would need to parse memory info properly
			hw.Memory = 4 * 1024 * 1024 * 1024 // Default 4GB
		}

		// Detect NVIDIA GPUs
		if strings.Contains(strings.ToLower(hw.Vendor), "nvidia") {
			hw.ComputeUnits = d.getNVIDIAComputeUnits(hw.Name)
		}

		// Detect AMD GPUs
		if strings.Contains(strings.ToLower(hw.Vendor), "amd") ||
			strings.Contains(strings.ToLower(hw.Vendor), "advanced micro devices") {
			hw.ComputeUnits = d.getAMDComputeUnits(hw.Name)
		}

		d.gpuInfo = append(d.gpuInfo, hw)
	}

	return nil
}

// detectASIC detects ASIC miners (placeholder implementation)
func (d *HardwareDetector) detectASIC() error {
	// ASIC detection would require specific drivers and APIs
	// This is a placeholder for future implementation
	return fmt.Errorf("ASIC detection not implemented")
}

// getNVIDIAComputeUnits estimates compute units for NVIDIA GPUs
func (d *HardwareDetector) getNVIDIAComputeUnits(model string) int {
	model = strings.ToLower(model)

	// RTX 40 series
	if strings.Contains(model, "rtx 4090") {
		return 16384
	}
	if strings.Contains(model, "rtx 4080") {
		return 9728
	}
	if strings.Contains(model, "rtx 4070 ti") {
		return 7680
	}
	if strings.Contains(model, "rtx 4070") {
		return 5888
	}
	if strings.Contains(model, "rtx 4060 ti") {
		return 4352
	}
	if strings.Contains(model, "rtx 4060") {
		return 3072
	}

	// RTX 30 series
	if strings.Contains(model, "rtx 3090") {
		return 10496
	}
	if strings.Contains(model, "rtx 3080") {
		return 8704
	}
	if strings.Contains(model, "rtx 3070") {
		return 5888
	}
	if strings.Contains(model, "rtx 3060") {
		return 3584
	}

	// Default for unknown NVIDIA GPUs
	return 2048
}

// getAMDComputeUnits estimates compute units for AMD GPUs
func (d *HardwareDetector) getAMDComputeUnits(model string) int {
	model = strings.ToLower(model)

	// RX 7000 series
	if strings.Contains(model, "rx 7900 xtx") {
		return 6144
	}
	if strings.Contains(model, "rx 7900 xt") {
		return 5376
	}
	if strings.Contains(model, "rx 7800 xt") {
		return 3840
	}
	if strings.Contains(model, "rx 7700 xt") {
		return 3456
	}
	if strings.Contains(model, "rx 7600") {
		return 2048
	}

	// RX 6000 series
	if strings.Contains(model, "rx 6900 xt") {
		return 5120
	}
	if strings.Contains(model, "rx 6800 xt") {
		return 4608
	}
	if strings.Contains(model, "rx 6800") {
		return 3840
	}
	if strings.Contains(model, "rx 6700 xt") {
		return 2560
	}
	if strings.Contains(model, "rx 6600") {
		return 1792
	}

	// Default for unknown AMD GPUs
	return 1536
}

// GetAvailableHardware returns all available hardware for mining
func (d *HardwareDetector) GetAvailableHardware() []HardwareInfo {
	var hardware []HardwareInfo
	hardware = append(hardware, d.cpuInfo...)
	hardware = append(hardware, d.gpuInfo...)
	hardware = append(hardware, d.asicInfo...)
	return hardware
}

// GetHardwareByType returns hardware of a specific type
func (d *HardwareDetector) GetHardwareByType(hwType HardwareType) []HardwareInfo {
	switch hwType {
	case HardwareCPU:
		return d.cpuInfo
	case HardwareGPU:
		return d.gpuInfo
	case HardwareASIC:
		return d.asicInfo
	default:
		return nil
	}
}

// GetBestHardwareForAlgorithm returns the best hardware for a specific algorithm
func (d *HardwareDetector) GetBestHardwareForAlgorithm(algoName string) (HardwareInfo, error) {
	// This would use the algorithm registry to determine the best hardware
	// For now, return a simple implementation
	
	algo := strings.ToLower(algoName)
	
	// CPU-optimized algorithms
	if strings.Contains(algo, "randomx") || strings.Contains(algo, "cryptonight") ||
		strings.Contains(algo, "argon") || strings.Contains(algo, "yescrypt") {
		if len(d.cpuInfo) > 0 {
			return d.cpuInfo[0], nil
		}
	}
	
	// GPU-optimized algorithms (most algorithms)
	if len(d.gpuInfo) > 0 {
		// Return GPU with most compute units
		best := d.gpuInfo[0]
		for _, gpu := range d.gpuInfo {
			if gpu.ComputeUnits > best.ComputeUnits {
				best = gpu
			}
		}
		return best, nil
	}
	
	// Fallback to CPU
	if len(d.cpuInfo) > 0 {
		return d.cpuInfo[0], nil
	}
	
	return HardwareInfo{}, fmt.Errorf("no suitable hardware found for algorithm %s", algoName)
}

// EstimateHashrate estimates the hashrate for given hardware and algorithm
func (d *HardwareDetector) EstimateHashrate(hw HardwareInfo, algoName string) uint64 {
	// This is a simplified estimation - real values would come from benchmarking
	baseRate := uint64(1000) // 1 KH/s base
	
	switch hw.Type {
	case HardwareCPU:
		baseRate = uint64(hw.ComputeUnits) * 100 // 100 H/s per core
		
		// Boost for CPU-friendly algorithms
		if strings.Contains(strings.ToLower(algoName), "randomx") {
			baseRate *= 10
		}
		
	case HardwareGPU:
		baseRate = uint64(hw.ComputeUnits) * 1000 // 1 KH/s per compute unit
		
		// Adjust for memory-hard algorithms
		if strings.Contains(strings.ToLower(algoName), "ethash") ||
			strings.Contains(strings.ToLower(algoName), "etchash") {
			if hw.Memory >= 4*1024*1024*1024 { // 4GB+ memory
				baseRate *= 10
			}
		}
		
	case HardwareASIC:
		// ASICs are much faster for supported algorithms
		baseRate = 1000 * 1000 * 1000 // 1 GH/s base
	}
	
	return baseRate
}