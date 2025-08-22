package mining

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewEngine(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
		CPU: CPUConfig{
			Enabled: true,
			Threads: 4,
		},
		GPU: GPUConfig{
			Enabled:   false,
			Intensity: 20,
		},
	}
	
	engine := NewEngine(logger, config)
	
	assert.NotNil(t, engine)
	assert.Equal(t, config, engine.config)
	assert.NotNil(t, engine.algorithms)
	assert.NotNil(t, engine.stats)
}

func TestEngineInitialize(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
		CPU: CPUConfig{
			Enabled: true,
		},
	}
	
	engine := NewEngine(logger, config)
	
	// Mock hardware manager
	mockHardware := &mockHardwareManager{}
	engine.hardware = mockHardware
	
	err := engine.Initialize()
	assert.NoError(t, err)
}

func TestEngineStartStop(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
		CPU: CPUConfig{
			Enabled: true,
			Threads: 2,
		},
	}
	
	engine := NewEngine(logger, config)
	
	// Mock hardware
	mockHardware := &mockHardwareManager{}
	engine.hardware = mockHardware
	
	// Initialize
	err := engine.Initialize()
	require.NoError(t, err)
	
	// Start
	err = engine.Start()
	assert.NoError(t, err)
	assert.True(t, engine.running.Load())
	
	// Start again should fail
	err = engine.Start()
	assert.Error(t, err)
	
	// Stop
	err = engine.Stop()
	assert.NoError(t, err)
	assert.False(t, engine.running.Load())
	
	// Stop again should fail
	err = engine.Stop()
	assert.Error(t, err)
}

func TestEngineSetJob(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
	}
	
	engine := NewEngine(logger, config)
	
	job := &Job{
		ID:         "test-job-1",
		Algorithm:  "sha256d",
		Target:     []byte{0xFF, 0xFF},
		Header:     []byte{0x01, 0x02, 0x03},
		Height:     100,
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}
	
	engine.SetJob(job)
	
	currentJob := engine.currentJob.Load()
	assert.NotNil(t, currentJob)
	assert.Equal(t, job.ID, currentJob.ID)
}

func TestEngineSubmitShare(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
	}
	
	engine := NewEngine(logger, config)
	
	// Set a job first
	job := &Job{
		ID:         "test-job-1",
		Algorithm:  "sha256d",
		Target:     []byte{0xFF, 0xFF, 0xFF, 0xFF},
		Header:     []byte{0x01, 0x02, 0x03},
		Height:     100,
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}
	engine.SetJob(job)
	
	// Submit a share
	nonce := uint64(12345)
	hash := []byte{0x00, 0x00, 0xFF, 0xFF}
	
	err := engine.SubmitShare(nonce, hash)
	assert.NoError(t, err)
	
	// Check statistics
	assert.Greater(t, engine.stats.SharesAccepted.Load(), uint64(0))
}

func TestEngineGetStatistics(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
	}
	
	engine := NewEngine(logger, config)
	
	stats := engine.GetStatistics()
	
	assert.NotNil(t, stats)
	assert.Contains(t, stats, "running")
	assert.Contains(t, stats, "algorithm")
	assert.Contains(t, stats, "hashrate")
	assert.Contains(t, stats, "shares_accepted")
	assert.Contains(t, stats, "shares_rejected")
}

func TestEnginePowerModes(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
	}
	
	engine := NewEngine(logger, config)
	
	// Test optimize for latency
	engine.OptimizeForLatency()
	// Should not panic
	
	// Test optimize for efficiency
	engine.OptimizeForEfficiency()
	// Should not panic
}

func TestEngineWorkerManagement(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
		CPU: CPUConfig{
			Enabled: true,
		},
	}
	
	engine := NewEngine(logger, config)
	
	// Create test workers
	engine.workers = []*Worker{
		{ID: "worker-1", Active: atomic.Bool{}},
		{ID: "worker-2", Active: atomic.Bool{}},
	}
	
	// Get workers
	workers := engine.GetWorkers()
	assert.Len(t, workers, 2)
	
	// Enable worker
	err := engine.EnableWorker("worker-1")
	assert.NoError(t, err)
	assert.True(t, engine.workers[0].Active.Load())
	
	// Disable worker
	err = engine.DisableWorker("worker-1")
	assert.NoError(t, err)
	assert.False(t, engine.workers[0].Active.Load())
	
	// Non-existent worker
	err = engine.EnableWorker("worker-999")
	assert.Error(t, err)
}

// Mock hardware manager for testing
type mockHardwareManager struct{}

func (m *mockHardwareManager) Initialize() error {
	return nil
}

func (m *mockHardwareManager) Start(algorithm string) error {
	return nil
}

func (m *mockHardwareManager) Stop() error {
	return nil
}

func (m *mockHardwareManager) GetDevices() []interface{} {
	return []interface{}{}
}

func (m *mockHardwareManager) SubmitJob(job *HardwareJob) error {
	return nil
}

func (m *mockHardwareManager) GetMetrics() map[string]interface{} {
	return map[string]interface{}{
		"devices_total": 1,
		"hashrate":      1000000,
	}
}

func (m *mockHardwareManager) SetPowerLimit(watts float64) error {
	return nil
}

func (m *mockHardwareManager) SetTemperatureLimit(celsius float64) error {
	return nil
}

// Benchmark tests
func BenchmarkEngineSubmitShare(b *testing.B) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
	}
	
	engine := NewEngine(logger, config)
	
	job := &Job{
		ID:         "bench-job",
		Algorithm:  "sha256d",
		Target:     []byte{0xFF, 0xFF, 0xFF, 0xFF},
		Header:     []byte{0x01, 0x02, 0x03},
		Height:     100,
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}
	engine.SetJob(job)
	
	nonce := uint64(0)
	hash := []byte{0x00, 0x00, 0xFF, 0xFF}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		engine.SubmitShare(nonce, hash)
		nonce++
	}
}

func BenchmarkEngineGetStatistics(b *testing.B) {
	logger := zap.NewNop()
	config := &Config{
		Algorithm: "sha256d",
	}
	
	engine := NewEngine(logger, config)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = engine.GetStatistics()
	}
}
