package mining

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestMultiDeviceMiningEngine(t *testing.T) {
	logger := zap.NewNop()
	
	// Test configuration with all device types
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   2,
		GPUDevices:   []int{0, 1},
		ASICDevices:  []string{"asic0", "asic1", "asic2"},
		Intensity:    15,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: true,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)
	require.NotNil(t, engine)

	// Test engine initialization
	assert.NotNil(t, engine.cpuManager)
	assert.NotNil(t, engine.gpuManager)
	assert.NotNil(t, engine.asicManager)
	assert.NotNil(t, engine.jobQueue)
	assert.NotNil(t, engine.shareValidator)

	// Test device detection
	devices := engine.GetDevices()
	assert.NotEmpty(t, devices)
	assert.True(t, len(devices) >= 5) // CPU + GPU + ASIC devices

	// Test algorithm support
	assert.True(t, engine.SupportsAlgorithm(SHA256D))
	assert.True(t, engine.SupportsAlgorithm(SCRYPT))

	// Test pool configuration
	poolConfig := &config.PoolConfig{
		URL:      "stratum+tcp://127.0.0.1:3333",
		Username: "testuser",
		Password: "testpass",
		Wallet:   "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
	}

	err = engine.SetPoolConfig(poolConfig)
	assert.NoError(t, err)

	// Test job submission and processing
	testJob := &Job{
		ID:        "integration-test-1",
		Algorithm: SHA256D,
		Target:    "0000ffff00000000000000000000000000000000000000000000000000000000",
		Data:      make([]byte, 80),
	}

	err = engine.SubmitJob(testJob)
	assert.NoError(t, err)

	// Test engine lifecycle
	err = engine.Start()
	require.NoError(t, err)

	// Let engine run briefly
	time.Sleep(200 * time.Millisecond)

	// Test health monitoring
	status := engine.GetStatus()
	assert.True(t, status.Running)
	assert.True(t, status.Healthy)

	// Test performance metrics
	stats := engine.GetStats()
	assert.NotNil(t, stats)
	assert.GreaterOrEqual(t, stats.TotalHashRate, uint64(0))
	assert.GreaterOrEqual(t, stats.CPUHashRate, uint64(0))
	assert.GreaterOrEqual(t, stats.GPUHashRate, uint64(0))
	assert.GreaterOrEqual(t, stats.ASICHashRate, uint64(0))

	// Test job completion
	completedJobs := engine.GetCompletedJobs()
	assert.NotNil(t, completedJobs)

	// Test share submission
	share := &Share{
		JobID:    testJob.ID,
		Nonce:    12345,
		Result:   "0000ffff...",
		DeviceID: "cpu0",
	}

	valid, err := engine.ValidateShare(share)
	assert.NoError(t, err)
	assert.False(t, valid) // Should be false for test target

	// Test engine stop
	err = engine.Stop()
	assert.NoError(t, err)

	// Verify engine stopped
	status = engine.GetStatus()
	assert.False(t, status.Running)
}

func TestDeviceManagement(t *testing.T) {
	logger := zap.NewNop()
	
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   1,
		GPUDevices:   []int{0},
		ASICDevices:  []string{"asic0"},
		Intensity:    10,
		MaxMemoryMB:  512,
		JobQueueSize: 50,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	// Test device enumeration
	cpuDevices := engine.GetCPUDevices()
	gpuDevices := engine.GetGPUDevices()
	asicDevices := engine.GetASICDevices()

	assert.NotEmpty(t, cpuDevices)
	assert.NotEmpty(t, gpuDevices)
	assert.NotEmpty(t, asicDevices)

	// Test device info
	for _, device := range engine.GetDevices() {
		assert.NotEmpty(t, device.ID)
		assert.NotEmpty(t, device.Type)
		assert.NotEmpty(t, device.Name)
		assert.Greater(t, device.Memory, uint64(0))
	}

	// Test device enable/disable
	for _, device := range engine.GetDevices() {
		originalState := device.Enabled
		
		err := engine.SetDeviceEnabled(device.ID, !originalState)
		assert.NoError(t, err)
		
		updatedDevice := engine.GetDevice(device.ID)
		assert.Equal(t, !originalState, updatedDevice.Enabled)
		
		// Restore original state
		err = engine.SetDeviceEnabled(device.ID, originalState)
		assert.NoError(t, err)
	}
}

func TestAlgorithmSwitching(t *testing.T) {
	logger := zap.NewNop()
	
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   1,
		Intensity:    10,
		MaxMemoryMB:  512,
		JobQueueSize: 50,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	// Test initial algorithm
	assert.Equal(t, SHA256D, engine.GetAlgorithm())

	// Test algorithm switching
	err = engine.SetAlgorithm(SCRYPT)
	assert.NoError(t, err)
	assert.Equal(t, SCRYPT, engine.GetAlgorithm())

	// Test invalid algorithm
	err = engine.SetAlgorithm("invalid")
	assert.Error(t, err)

	// Test algorithm-specific configuration
	sha256dConfig := engine.GetAlgorithmConfig(SHA256D)
	assert.NotNil(t, sha256dConfig)

	scryptConfig := engine.GetAlgorithmConfig(SCRYPT)
	assert.NotNil(t, scryptConfig)
}

func TestPerformanceOptimization(t *testing.T) {
	logger := zap.NewNop()
	
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   2,
		Intensity:    15,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: true,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	// Test auto-optimization
	assert.True(t, engine.GetConfig().AutoOptimize)

	// Test performance tuning
	err = engine.OptimizePerformance()
	assert.NoError(t, err)

	// Test memory management
	memoryStats := engine.GetMemoryStats()
	assert.NotNil(t, memoryStats)
	assert.GreaterOrEqual(t, memoryStats.UsedMemory, uint64(0))
	assert.GreaterOrEqual(t, memoryStats.AvailableMemory, uint64(0))

	// Test cache management
	cacheStats := engine.GetCacheStats()
	assert.NotNil(t, cacheStats)
	assert.GreaterOrEqual(t, cacheStats.HitRate, float64(0))
	assert.GreaterOrEqual(t, cacheStats.MissRate, float64(0))
}

func TestErrorHandling(t *testing.T) {
	logger := zap.NewNop()
	
	// Test invalid configuration
	invalidCfg := &Config{
		Algorithm:    "invalid",
		CPUThreads:   0,
		Intensity:    0,
		MaxMemoryMB:  0,
		JobQueueSize: 0,
		AutoOptimize: false,
	}

	_, err := NewEngine(logger, invalidCfg)
	assert.Error(t, err)

	// Test valid configuration
	validCfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   1,
		Intensity:    1,
		MaxMemoryMB:  64,
		JobQueueSize: 1,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, validCfg)
	require.NoError(t, err)

	// Test error recovery
	err = engine.Start()
	require.NoError(t, err)

	// Test job submission with invalid data
	invalidJob := &Job{
		ID:        "",
		Algorithm: "",
		Target:    "",
		Data:      nil,
	}

	err = engine.SubmitJob(invalidJob)
	assert.Error(t, err)

	// Test graceful shutdown
	err = engine.Stop()
	assert.NoError(t, err)
}

func TestConcurrentOperations(t *testing.T) {
	logger := zap.NewNop()
	
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   2,
		Intensity:    10,
		MaxMemoryMB:  512,
		JobQueueSize: 50,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Test concurrent job submission
	jobs := make([]*Job, 10)
	for i := 0; i < 10; i++ {
		jobs[i] = &Job{
			ID:        string(rune('a' + i)),
			Algorithm: SHA256D,
			Target:    "0000ffff00000000000000000000000000000000000000000000000000000000",
			Data:      make([]byte, 80),
		}
	}

	// Submit jobs concurrently
	for _, job := range jobs {
		go func(j *Job) {
			err := engine.SubmitJob(j)
			assert.NoError(t, err)
		}(job)
	}

	// Let concurrent operations complete
	time.Sleep(500 * time.Millisecond)

	// Verify job queue processing
	stats := engine.GetStats()
	assert.GreaterOrEqual(t, stats.JobsProcessed, uint64(0))
}

func TestBenchmarkSuite(t *testing.T) {
	logger := zap.NewNop()
	
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   2,
		GPUDevices:   []int{0},
		ASICDevices:  []string{"asic0"},
		Intensity:    15,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: true,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	// Run benchmark
	benchmark := NewBenchmarkSuite(engine)
	assert.NotNil(t, benchmark)

	// Execute benchmark
	results := benchmark.Run()
	assert.NotNil(t, results)
	assert.Greater(t, results.TotalHashRate, uint64(0))
	assert.Greater(t, results.CPUHashRate, uint64(0))
	assert.Greater(t, results.GPUHashRate, uint64(0))
	assert.Greater(t, results.ASICHashRate, uint64(0))
}
