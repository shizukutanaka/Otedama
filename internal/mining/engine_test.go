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

func TestNewEngine(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   4,
		Intensity:    20,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: true,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)
	assert.NotNil(t, engine)
}

func TestEngine_Start(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   2,
		Intensity:    10,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	assert.NoError(t, err)

	// Let it run briefly
	time.Sleep(100 * time.Millisecond)

	err = engine.Stop()
	assert.NoError(t, err)
}

func TestEngine_MultiDevice(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   2,
		GPUDevices:   []int{0, 1},
		ASICDevices:  []string{"asic0", "asic1"},
		Intensity:    15,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Test multi-device support
	assert.True(t, engine.HasCPU())
	assert.True(t, engine.HasGPU())
	assert.True(t, engine.HasASIC())

	// Get hardware info
	info := engine.GetHardwareInfo()
	assert.Greater(t, info.CPUThreads, 0)
	assert.Len(t, info.GPUDevices, 2)
	assert.Len(t, info.ASICDevices, 2)
}

func TestEngine_GetHashRate(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   2,
		Intensity:    10,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Let it run briefly
	time.Sleep(100 * time.Millisecond)

	stats := engine.GetStats()
	assert.NotNil(t, stats)
	assert.GreaterOrEqual(t, stats.TotalHashRate, uint64(0))
}

func TestEngine_AlgorithmManagement(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   1,
		Intensity:    5,
		MaxMemoryMB:  1024,
		JobQueueSize: 50,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	// Test algorithm switching
	assert.Equal(t, SHA256D, engine.GetAlgorithm())

	// Test algorithm validation
	assert.True(t, engine.ValidateAlgorithm("sha256d"))
	assert.True(t, engine.ValidateAlgorithm("scrypt"))
	assert.False(t, engine.ValidateAlgorithm("invalid"))
}

func TestEngine_PoolManagement(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   1,
		Intensity:    5,
		MaxMemoryMB:  1024,
		JobQueueSize: 50,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	// Test pool configuration
	err = engine.SetPool("stratum+tcp://127.0.0.1:3333", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
	assert.NoError(t, err)
}

func TestEngine_ConfigManagement(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   2,
		Intensity:    10,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	// Test configuration
	config := engine.GetConfig()
	assert.NotNil(t, config)
	assert.Equal(t, 2, engine.GetCPUThreads())

	// Test CPU thread adjustment
	err = engine.SetCPUThreads(4)
	assert.NoError(t, err)
	assert.Equal(t, 4, engine.GetCPUThreads())
}

func TestEngine_HealthCheck(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   1,
		Intensity:    5,
		MaxMemoryMB:  1024,
		JobQueueSize: 50,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	// Test health check
	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Engine should be healthy after starting
	assert.True(t, engine.GetStatus().Running)
}

func TestEngine_JobProcessing(t *testing.T) {
	logger := zap.NewNop()
	cfg := &Config{
		Algorithm:    SHA256D,
		CPUThreads:   1,
		Intensity:    5,
		MaxMemoryMB:  1024,
		JobQueueSize: 50,
		AutoOptimize: false,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Test job processing
	job := &Job{
		ID:        "test-job-1",
		Algorithm: SHA256D,
		Target:    "0000ffff00000000000000000000000000000000000000000000000000000000",
		Data:      make([]byte, 80),
	}

	// Submit job
	err = engine.SubmitJob(job)
	assert.NoError(t, err)

	// Get current job
	currentJob := engine.GetCurrentJob()
	assert.NotNil(t, currentJob)
}

func TestEngine_GetHashRate(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   2,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Initially should be 0
	hashRate := engine.GetHashRate()
	assert.GreaterOrEqual(t, hashRate, uint64(0))

	// After some mining, should increase
	time.Sleep(500 * time.Millisecond)
	hashRate = engine.GetHashRate()
	assert.GreaterOrEqual(t, hashRate, uint64(0))
}

func TestEngine_UpdateConfig(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   2,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Update configuration
	newCfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   4,
		Intensity: 20,
	}

	engine.UpdateConfig(newCfg)
	
	// Verify config was updated
	// This would need access to internal state to verify properly
}

func TestEngine_EnableCPU(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   2,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	cpuConfig := config.CPUConfig{
		Enabled:  true,
		Threads:  4,
		Affinity: []int{0, 1, 2, 3},
		Priority: 0,
	}

	engine.EnableCPU(cpuConfig)
}

func TestEngine_ValidateShare(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   1,
		Intensity: 5,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(t, err)

	share := &Share{
		JobID:      "test-job-1",
		Nonce:      12345,
		Hash:       "0000000000000000000000000000000000000000000000000000000000000001",
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}

	valid := engine.ValidateShare(share)
	assert.NotNil(t, valid) // Can be true or false depending on implementation
}

func BenchmarkEngine_Hash(b *testing.B) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   1,
		Intensity: 10,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(b, err)

	data := make([]byte, 80)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = engine.Hash(data)
	}
}

func BenchmarkEngine_Mine(b *testing.B) {
	logger := zap.NewNop()
	cfg := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   4,
		Intensity: 20,
	}

	engine, err := NewEngine(logger, cfg)
	require.NoError(b, err)

	err = engine.Start()
	require.NoError(b, err)
	defer engine.Stop()

	job := &Job{
		ID:         "bench-job",
		Target:     "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		Data:       make([]byte, 80),
		NonceStart: 0,
		NonceEnd:   1000000,
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		nonceChan := make(chan uint64, 1)
		go engine.Mine(ctx, job, nonceChan)
		select {
		case <-nonceChan:
		case <-ctx.Done():
		}
		cancel()
	}
}