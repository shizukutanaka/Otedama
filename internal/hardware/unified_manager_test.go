package hardware

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewUnifiedManager(t *testing.T) {
	logger := zap.NewNop()
	
	manager := NewUnifiedManager(logger)
	
	assert.NotNil(t, manager)
	assert.NotNil(t, manager.devices)
	assert.NotNil(t, manager.stats)
	assert.NotNil(t, manager.ctx)
}

func TestUnifiedManagerInitialize(t *testing.T) {
	logger := zap.NewNop()
	
	config := &Config{
		CPU: CPUConfig{
			Enabled: true,
			Threads: 4,
		},
		GPU: GPUConfig{
			Enabled: false,
		},
		ASIC: ASICConfig{
			Enabled: false,
		},
		EnableMonitoring: true,
		UpdateInterval:   1 * time.Second,
	}
	
	manager := NewUnifiedManager(logger)
	manager.SetConfig(config)
	
	err := manager.Initialize()
	assert.NoError(t, err)
	
	// Should have at least CPU device
	devices := manager.GetDevices()
	assert.Greater(t, len(devices), 0)
}

func TestUnifiedManagerStartStop(t *testing.T) {
	logger := zap.NewNop()
	
	config := &Config{
		CPU: CPUConfig{
			Enabled: true,
			Threads: 2,
		},
		EnableMonitoring: false,
	}
	
	manager := NewUnifiedManager(logger)
	manager.SetConfig(config)
	
	err := manager.Initialize()
	require.NoError(t, err)
	
	// Test start
	err = manager.Start("sha256d")
	assert.NoError(t, err)
	
	// Start again should fail
	err = manager.Start("sha256d")
	assert.Error(t, err)
	
	// Test stop
	err = manager.Stop()
	assert.NoError(t, err)
	
	// Stop again should fail
	err = manager.Stop()
	assert.Error(t, err)
}

func TestCPUDevice(t *testing.T) {
	device := &CPUDevice{
		ID:      "cpu-test",
		Name:    "Test CPU",
		Cores:   8,
		Threads: 16,
	}
	
	device.Available.Store(true)
	device.Hashrate.Store(1000000)
	device.Temperature.Store(6500) // 65.00°C
	device.PowerUsage.Store(9500)  // 95.00W
	
	assert.Equal(t, "cpu-test", device.GetID())
	assert.Equal(t, "Test CPU", device.GetName())
	assert.Equal(t, DeviceTypeCPU, device.GetType())
	assert.True(t, device.IsAvailable())
	assert.Equal(t, uint64(1000000), device.GetHashrate())
	assert.Equal(t, 65.0, device.GetTemperature())
	assert.Equal(t, 95.0, device.GetPowerUsage())
	assert.Equal(t, uint64(0), device.GetMemoryUsage())
	
	// Test intensity setting
	err := device.SetIntensity(50)
	assert.NoError(t, err)
	assert.Equal(t, int32(50), device.Intensity.Load())
	
	// Test start/stop
	err = device.Start("sha256d")
	assert.NoError(t, err)
	assert.True(t, device.mining.Load())
	
	err = device.Stop()
	assert.NoError(t, err)
	assert.False(t, device.mining.Load())
}

func TestGPUDevice(t *testing.T) {
	device := &GPUDevice{
		ID:           "gpu-test",
		Name:         "Test GPU",
		Index:        0,
		Memory:       8589934592, // 8GB
		ComputeUnits: 36,
	}
	
	device.Available.Store(true)
	device.Hashrate.Store(100000000)
	device.Temperature.Store(7500) // 75.00°C
	device.PowerUsage.Store(25000) // 250.00W
	device.MemoryUsage.Store(4294967296) // 4GB
	device.FanSpeed.Store(80)
	
	assert.Equal(t, "gpu-test", device.GetID())
	assert.Equal(t, "Test GPU", device.GetName())
	assert.Equal(t, DeviceTypeGPU, device.GetType())
	assert.True(t, device.IsAvailable())
	assert.Equal(t, uint64(100000000), device.GetHashrate())
	assert.Equal(t, 75.0, device.GetTemperature())
	assert.Equal(t, 250.0, device.GetPowerUsage())
	assert.Equal(t, uint64(4294967296), device.GetMemoryUsage())
	
	// Test intensity setting
	err := device.SetIntensity(22)
	assert.NoError(t, err)
	assert.Equal(t, int32(22), device.Intensity.Load())
	
	// Test invalid intensity
	err = device.SetIntensity(35)
	assert.Error(t, err)
	
	err = device.SetIntensity(0)
	assert.Error(t, err)
}

func TestASICDevice(t *testing.T) {
	device := &ASICDevice{
		ID:         "asic-test",
		Name:       "Test ASIC",
		Model:      "TestMiner S19",
		SerialPort: "/dev/ttyUSB0",
		ChipCount:  288,
	}
	
	device.Available.Store(true)
	device.Hashrate.Store(110000000000000) // 110 TH/s
	device.Temperature.Store(8000)         // 80.00°C
	device.PowerUsage.Store(325000)        // 3250.00W
	device.Frequency.Store(650)
	
	assert.Equal(t, "asic-test", device.GetID())
	assert.Equal(t, "Test ASIC", device.GetName())
	assert.Equal(t, DeviceTypeASIC, device.GetType())
	assert.True(t, device.IsAvailable())
	assert.Equal(t, uint64(110000000000000), device.GetHashrate())
	assert.Equal(t, 80.0, device.GetTemperature())
	assert.Equal(t, 3250.0, device.GetPowerUsage())
	assert.Equal(t, uint64(0), device.GetMemoryUsage())
	
	// Test frequency setting via intensity
	err := device.SetIntensity(70)
	assert.NoError(t, err)
	assert.Equal(t, int32(700), device.Frequency.Load())
}

func TestHardwareMonitor(t *testing.T) {
	logger := zap.NewNop()
	
	// Create test devices
	devices := []MiningDevice{
		&CPUDevice{ID: "cpu-0", Name: "CPU 0"},
		&GPUDevice{ID: "gpu-0", Name: "GPU 0"},
	}
	
	monitor := NewHardwareMonitor(logger, devices, 100*time.Millisecond)
	monitor.SetLimits(85.0, 500.0)
	
	// Set high temperature on CPU
	devices[0].(*CPUDevice).Temperature.Store(9000) // 90°C
	devices[0].(*CPUDevice).Available.Store(true)
	
	// Start monitoring
	monitor.Start()
	
	// Wait for alert
	time.Sleep(200 * time.Millisecond)
	
	// Check if alert was generated
	select {
	case alert := <-monitor.alerts:
		assert.Equal(t, "temperature", alert.Type)
		assert.Equal(t, "CPU 0", alert.Device)
		assert.Equal(t, "critical", alert.Severity)
	default:
		t.Error("Expected temperature alert")
	}
	
	monitor.Stop()
}

func TestPowerManagement(t *testing.T) {
	logger := zap.NewNop()
	
	config := &Config{
		CPU: CPUConfig{
			Enabled: true,
		},
		PowerLimit:       300.0,
		TemperatureLimit: 85.0,
	}
	
	manager := NewUnifiedManager(logger)
	manager.SetConfig(config)
	
	// Test power limit setting
	err := manager.SetPowerLimit(250.0)
	assert.NoError(t, err)
	assert.Equal(t, uint64(250), manager.powerLimit.Load())
	
	// Test temperature limit setting
	err = manager.SetTemperatureLimit(80.0)
	assert.NoError(t, err)
	assert.Equal(t, uint64(80), manager.tempLimit.Load())
}

func TestMetricsCollection(t *testing.T) {
	logger := zap.NewNop()
	
	config := &Config{
		CPU: CPUConfig{
			Enabled: true,
		},
	}
	
	manager := NewUnifiedManager(logger)
	manager.SetConfig(config)
	
	err := manager.Initialize()
	require.NoError(t, err)
	
	// Add test device with metrics
	testDevice := &CPUDevice{
		ID:   "test-cpu",
		Name: "Test CPU",
	}
	testDevice.Available.Store(true)
	testDevice.Hashrate.Store(1000000)
	testDevice.PowerUsage.Store(10000) // 100W
	testDevice.Temperature.Store(6500)  // 65°C
	
	manager.devices = append(manager.devices, testDevice)
	
	// Get metrics
	metrics := manager.GetMetrics()
	
	assert.Contains(t, metrics, "devices_total")
	assert.Contains(t, metrics, "devices_active")
	assert.Contains(t, metrics, "total_hashrate")
	assert.Contains(t, metrics, "total_power")
	assert.Contains(t, metrics, "average_temp")
	assert.Contains(t, metrics, "error_count")
	assert.Contains(t, metrics, "restart_count")
	
	assert.Greater(t, metrics["total_hashrate"].(uint64), uint64(0))
	assert.Greater(t, metrics["average_temp"].(float64), float64(0))
}

func TestJobSubmission(t *testing.T) {
	logger := zap.NewNop()
	
	manager := NewUnifiedManager(logger)
	
	job := &MiningJob{
		ID:         "test-job-1",
		Algorithm:  "sha256d",
		Target:     []byte{0xFF, 0xFF},
		Data:       []byte{0x01, 0x02, 0x03},
		ExtraNonce: []byte{0x00, 0x00},
		Height:     700000,
		Difficulty: 1000000.0,
		Timestamp:  time.Now(),
	}
	
	err := manager.SubmitJob(job)
	assert.NoError(t, err)
}

func TestBenchmarking(t *testing.T) {
	logger := zap.NewNop()
	
	manager := NewUnifiedManager(logger)
	
	// CPU benchmark
	cpuResults := manager.BenchmarkCPU()
	assert.NotNil(t, cpuResults)
	assert.Contains(t, cpuResults, "sha256d")
	assert.Contains(t, cpuResults, "scrypt")
	assert.Contains(t, cpuResults, "randomx")
	
	// All results should be positive
	for algo, hashrate := range cpuResults {
		assert.Greater(t, hashrate, float64(0), "Algorithm %s should have positive hashrate", algo)
	}
	
	// GPU benchmark (will be empty if no GPUs)
	gpuResults := manager.BenchmarkGPU()
	assert.NotNil(t, gpuResults)
}

func TestDeviceFailureHandling(t *testing.T) {
	logger := zap.NewNop()
	
	config := &Config{
		CPU: CPUConfig{
			Enabled: true,
		},
		TemperatureLimit: 85.0,
		PowerLimit:       200.0,
	}
	
	manager := NewUnifiedManager(logger)
	manager.SetConfig(config)
	
	// Create overheating GPU device
	gpu := &GPUDevice{
		ID:   "gpu-hot",
		Name: "Hot GPU",
	}
	gpu.Available.Store(true)
	gpu.Temperature.Store(9000) // 90°C - over limit
	gpu.Intensity.Store(25)
	
	manager.devices = append(manager.devices, gpu)
	
	// Handle overheat
	manager.handleOverheat(gpu)
	
	// Intensity should be reduced
	assert.Less(t, gpu.Intensity.Load(), int32(25))
	
	// Create high power device
	gpu2 := &GPUDevice{
		ID:   "gpu-power",
		Name: "Power GPU",
	}
	gpu2.Available.Store(true)
	gpu2.PowerUsage.Store(25000) // 250W - over limit
	gpu2.Intensity.Store(20)
	
	// Handle power limit
	manager.handlePowerLimit(gpu2)
	
	// Intensity should be reduced
	assert.Less(t, gpu2.Intensity.Load(), int32(20))
}

// Benchmark tests

func BenchmarkDeviceMetrics(b *testing.B) {
	device := &CPUDevice{
		ID:   "bench-cpu",
		Name: "Benchmark CPU",
	}
	device.Available.Store(true)
	device.Hashrate.Store(1000000)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = device.GetHashrate()
		_ = device.GetTemperature()
		_ = device.GetPowerUsage()
	}
}

func BenchmarkMetricsCollection(b *testing.B) {
	logger := zap.NewNop()
	manager := NewUnifiedManager(logger)
	
	// Add some test devices
	for i := 0; i < 10; i++ {
		device := &CPUDevice{
			ID:   fmt.Sprintf("cpu-%d", i),
			Name: fmt.Sprintf("CPU %d", i),
		}
		device.Available.Store(true)
		device.Hashrate.Store(uint64(1000000 * (i + 1)))
		manager.devices = append(manager.devices, device)
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = manager.GetMetrics()
	}
}

func BenchmarkJobSubmission(b *testing.B) {
	logger := zap.NewNop()
	manager := NewUnifiedManager(logger)
	
	job := &MiningJob{
		ID:        "bench-job",
		Algorithm: "sha256d",
		Target:    []byte{0xFF, 0xFF},
		Data:      []byte{0x01, 0x02, 0x03},
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = manager.SubmitJob(job)
	}
}
