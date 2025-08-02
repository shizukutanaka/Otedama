package hardware

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"go.uber.org/zap"
)

// NvidiaGPUMonitor monitors NVIDIA GPUs using nvidia-smi
type NvidiaGPUMonitor struct {
	logger    *zap.Logger
	available bool
}

// NewNvidiaGPUMonitor creates a new NVIDIA GPU monitor
func NewNvidiaGPUMonitor(logger *zap.Logger) *NvidiaGPUMonitor {
	monitor := &NvidiaGPUMonitor{
		logger: logger,
	}

	// Check if nvidia-smi is available
	if _, err := exec.LookPath("nvidia-smi"); err == nil {
		monitor.available = true
		logger.Info("NVIDIA GPU monitoring available")
	} else {
		logger.Info("NVIDIA GPU monitoring not available (nvidia-smi not found)")
	}

	return monitor
}

// GetGPUCount returns the number of GPUs
func (m *NvidiaGPUMonitor) GetGPUCount() int {
	if !m.available {
		return 0
	}

	cmd := exec.Command("nvidia-smi", "--query-gpu=count", "--format=csv,noheader")
	output, err := cmd.Output()
	if err != nil {
		m.logger.Error("Failed to get GPU count", zap.Error(err))
		return 0
	}

	count, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil {
		m.logger.Error("Failed to parse GPU count", zap.Error(err))
		return 0
	}

	return count
}

// GetGPUMetrics returns metrics for a specific GPU
func (m *NvidiaGPUMonitor) GetGPUMetrics(index int) (*GPUMetrics, error) {
	if !m.available {
		return nil, fmt.Errorf("NVIDIA GPU monitoring not available")
	}

	// Query multiple metrics at once
	query := "name,temperature.gpu,power.draw,fan.speed,memory.total,memory.used,memory.free,utilization.gpu,clocks.gr,clocks.mem"
	cmd := exec.Command("nvidia-smi", "--query-gpu="+query, "--format=csv,noheader,nounits", "-i", strconv.Itoa(index))
	
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to query GPU %d: %w", index, err)
	}

	// Parse the output
	fields := strings.Split(strings.TrimSpace(string(output)), ", ")
	if len(fields) < 10 {
		return nil, fmt.Errorf("unexpected nvidia-smi output format")
	}

	metrics := &GPUMetrics{
		Index: index,
		Name:  fields[0],
	}

	// Parse temperature
	if temp, err := strconv.ParseFloat(fields[1], 64); err == nil {
		metrics.Temperature = temp
	}

	// Parse power draw
	if power, err := strconv.ParseFloat(fields[2], 64); err == nil {
		metrics.Power = power
	}

	// Parse fan speed
	if fan, err := strconv.Atoi(fields[3]); err == nil {
		metrics.FanSpeed = fan
	}

	// Parse memory total (MiB to bytes)
	if memTotal, err := strconv.ParseUint(fields[4], 10, 64); err == nil {
		metrics.MemoryTotal = memTotal * 1024 * 1024
	}

	// Parse memory used (MiB to bytes)
	if memUsed, err := strconv.ParseUint(fields[5], 10, 64); err == nil {
		metrics.MemoryUsed = memUsed * 1024 * 1024
	}

	// Parse memory free (MiB to bytes)
	if memFree, err := strconv.ParseUint(fields[6], 10, 64); err == nil {
		metrics.MemoryFree = memFree * 1024 * 1024
	}

	// Parse GPU utilization
	if usage, err := strconv.ParseFloat(fields[7], 64); err == nil {
		metrics.Usage = usage
	}

	// Parse core clock
	if clockCore, err := strconv.Atoi(fields[8]); err == nil {
		metrics.ClockCore = clockCore
	}

	// Parse memory clock
	if clockMem, err := strconv.Atoi(fields[9]); err == nil {
		metrics.ClockMemory = clockMem
	}

	// Calculate memory usage percentage
	if metrics.MemoryTotal > 0 {
		metrics.MemoryUsage = float64(metrics.MemoryUsed) / float64(metrics.MemoryTotal) * 100
	}

	return metrics, nil
}

// GetAllGPUMetrics returns metrics for all GPUs
func (m *NvidiaGPUMonitor) GetAllGPUMetrics() ([]GPUMetrics, error) {
	count := m.GetGPUCount()
	if count == 0 {
		return nil, nil
	}

	metrics := make([]GPUMetrics, 0, count)
	for i := 0; i < count; i++ {
		gpuMetrics, err := m.GetGPUMetrics(i)
		if err != nil {
			m.logger.Warn("Failed to get metrics for GPU",
				zap.Int("index", i),
				zap.Error(err),
			)
			continue
		}
		metrics = append(metrics, *gpuMetrics)
	}

	return metrics, nil
}

// AMDGPUMonitor monitors AMD GPUs using rocm-smi
type AMDGPUMonitor struct {
	logger    *zap.Logger
	available bool
}

// NewAMDGPUMonitor creates a new AMD GPU monitor
func NewAMDGPUMonitor(logger *zap.Logger) *AMDGPUMonitor {
	monitor := &AMDGPUMonitor{
		logger: logger,
	}

	// Check if rocm-smi is available
	if _, err := exec.LookPath("rocm-smi"); err == nil {
		monitor.available = true
		logger.Info("AMD GPU monitoring available")
	} else {
		logger.Info("AMD GPU monitoring not available (rocm-smi not found)")
	}

	return monitor
}

// GetGPUCount returns the number of GPUs
func (m *AMDGPUMonitor) GetGPUCount() int {
	if !m.available {
		return 0
	}

	cmd := exec.Command("rocm-smi", "--showgpucount")
	output, err := cmd.Output()
	if err != nil {
		m.logger.Error("Failed to get GPU count", zap.Error(err))
		return 0
	}

	// Parse output to extract count
	lines := strings.Split(string(output), "\n")
	for _, line := range lines {
		if strings.Contains(line, "GPU count:") {
			parts := strings.Split(line, ":")
			if len(parts) >= 2 {
				count, err := strconv.Atoi(strings.TrimSpace(parts[1]))
				if err == nil {
					return count
				}
			}
		}
	}

	return 0
}

// GetGPUMetrics returns metrics for a specific GPU
func (m *AMDGPUMonitor) GetGPUMetrics(index int) (*GPUMetrics, error) {
	if !m.available {
		return nil, fmt.Errorf("AMD GPU monitoring not available")
	}

	metrics := &GPUMetrics{
		Index: index,
		Name:  fmt.Sprintf("AMD GPU %d", index),
	}

	// Get temperature
	cmd := exec.Command("rocm-smi", "-d", strconv.Itoa(index), "-t")
	if output, err := cmd.Output(); err == nil {
		// Parse temperature from output
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			if strings.Contains(line, "Temperature") {
				// Extract temperature value
				// This is simplified - actual parsing would be more complex
				parts := strings.Fields(line)
				for _, part := range parts {
					if temp, err := strconv.ParseFloat(strings.TrimSuffix(part, "C"), 64); err == nil {
						metrics.Temperature = temp
						break
					}
				}
			}
		}
	}

	// Get power
	cmd = exec.Command("rocm-smi", "-d", strconv.Itoa(index), "-p")
	if output, err := cmd.Output(); err == nil {
		// Parse power from output
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			if strings.Contains(line, "Power") {
				parts := strings.Fields(line)
				for _, part := range parts {
					if power, err := strconv.ParseFloat(strings.TrimSuffix(part, "W"), 64); err == nil {
						metrics.Power = power
						break
					}
				}
			}
		}
	}

	// Get utilization
	cmd = exec.Command("rocm-smi", "-d", strconv.Itoa(index), "-u")
	if output, err := cmd.Output(); err == nil {
		// Parse utilization from output
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			if strings.Contains(line, "GPU use") {
				parts := strings.Fields(line)
				for _, part := range parts {
					if usage, err := strconv.ParseFloat(strings.TrimSuffix(part, "%"), 64); err == nil {
						metrics.Usage = usage
						break
					}
				}
			}
		}
	}

	return metrics, nil
}

// GetAllGPUMetrics returns metrics for all GPUs
func (m *AMDGPUMonitor) GetAllGPUMetrics() ([]GPUMetrics, error) {
	count := m.GetGPUCount()
	if count == 0 {
		return nil, nil
	}

	metrics := make([]GPUMetrics, 0, count)
	for i := 0; i < count; i++ {
		gpuMetrics, err := m.GetGPUMetrics(i)
		if err != nil {
			m.logger.Warn("Failed to get metrics for GPU",
				zap.Int("index", i),
				zap.Error(err),
			)
			continue
		}
		metrics = append(metrics, *gpuMetrics)
	}

	return metrics, nil
}