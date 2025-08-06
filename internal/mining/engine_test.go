package mining

import (
	"context"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// Test fixtures and helper functions

func createTestLogger(t *testing.T) *zap.Logger {
	return zaptest.NewLogger(t)
}

func createTestConfig() *Config {
	return &Config{
		CPUThreads:   2,
		Algorithm:    "sha256d",
		Intensity:    50,
		MaxMemoryMB:  1024,
		JobQueueSize: 100,
		AutoOptimize: false,
		HugePages:    false,
		NUMA:         false,
	}
}

func createTestEngine(t *testing.T) (Engine, *zap.Logger) {
	logger := createTestLogger(t)
	config := createTestConfig()
	
	engine, err := NewEngine(logger, config)
	require.NoError(t, err)
	require.NotNil(t, engine)
	
	return engine, logger
}

// TestNewEngine tests engine creation
func TestNewEngine(t *testing.T) {
	tests := []struct {
		name        string
		config      *Config
		expectError bool
	}{
		{
			name:        "valid config",
			config:      createTestConfig(),
			expectError: false,
		},
		{
			name:        "nil config uses default",
			config:      nil,
			expectError: false,
		},
		{
			name: "invalid CPU threads",
			config: &Config{
				CPUThreads: -1,
				Algorithm:  "sha256d",
			},
			expectError: true,
		},
		{
			name: "invalid algorithm",
			config: &Config{
				CPUThreads: 2,
				Algorithm:  "invalid_algo",
			},
			expectError: true,
		},
		{
			name: "invalid memory limit",
			config: &Config{
				CPUThreads:  2,
				Algorithm:   "sha256d",
				MaxMemoryMB: 100, // Too low
			},
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := createTestLogger(t)
			engine, err := NewEngine(logger, tt.config)

			if tt.expectError {
				assert.Error(t, err)
				assert.Nil(t, engine)
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, engine)
			}
		})
	}
}

// TestEngineLifecycle tests start/stop functionality
func TestEngineLifecycle(t *testing.T) {
	engine, _ := createTestEngine(t)

	// Test initial state
	assert.False(t, engine.(*UnifiedEngine).running.Load())

	// Test start
	err := engine.Start()
	assert.NoError(t, err)
	assert.True(t, engine.(*UnifiedEngine).running.Load())

	// Test double start
	err = engine.Start()
	assert.Error(t, err)

	// Test stop
	err = engine.Stop()
	assert.NoError(t, err)
	assert.False(t, engine.(*UnifiedEngine).running.Load())

	// Test double stop
	err = engine.Stop()
	assert.Error(t, err)
}

// TestEngineStats tests statistics functionality
func TestEngineStats(t *testing.T) {
	engine, _ := createTestEngine(t)

	// Test stats before start
	stats := engine.GetStats()
	assert.NotNil(t, stats)
	assert.Equal(t, uint64(0), stats.TotalHashRate)
	assert.Equal(t, uint64(0), stats.SharesSubmitted)
	assert.Equal(t, uint64(0), stats.SharesAccepted)

	// Start engine
	err := engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Test stats after start
	stats = engine.GetStats()
	assert.NotNil(t, stats)
	assert.GreaterOrEqual(t, int32(0), stats.ActiveWorkers)
	assert.Greater(t, stats.Uptime, time.Duration(0))

	// Test reset stats
	engine.ResetStats()
	stats = engine.GetStats()
	assert.Equal(t, uint64(0), stats.TotalHashRate)
}

// TestEngineConfiguration tests configuration methods
func TestEngineConfiguration(t *testing.T) {
	engine, _ := createTestEngine(t)

	// Test algorithm switching
	currentAlgo := engine.GetAlgorithm()
	assert.Equal(t, AlgorithmType("sha256d"), currentAlgo)

	err := engine.SwitchAlgorithm("scrypt")
	assert.NoError(t, err)
	assert.Equal(t, AlgorithmType("scrypt"), engine.GetAlgorithm())

	// Test CPU threads
	threads := engine.GetCPUThreads()
	assert.Equal(t, 2, threads)

	err = engine.SetCPUThreads(4)
	assert.NoError(t, err)
	assert.Equal(t, 4, engine.GetCPUThreads())

	// Test invalid CPU threads
	err = engine.SetCPUThreads(-1)
	assert.Error(t, err)

	err = engine.SetCPUThreads(300)
	assert.Error(t, err)

	// Test pool configuration
	err = engine.SetPool("stratum+tcp://pool.example.com:3333", "1A2b3C4d5E6f")
	assert.NoError(t, err)

	// Test GPU settings (placeholder)
	err = engine.SetGPUSettings(1500, 8000, 250)
	assert.NoError(t, err)
}

// TestEngineHardwareDetection tests hardware detection
func TestEngineHardwareDetection(t *testing.T) {
	engine, _ := createTestEngine(t)

	// Test hardware detection
	assert.True(t, engine.HasCPU()) // Always true since we configured CPU threads
	assert.False(t, engine.HasGPU()) // No GPU devices configured
	assert.False(t, engine.HasASIC()) // No ASIC devices configured

	// Test hardware info
	info := engine.GetHardwareInfo()
	assert.NotNil(t, info)
	assert.Equal(t, 2, info.CPUThreads)
	assert.NotNil(t, info.GPUDevices)
	assert.NotNil(t, info.ASICDevices)
}

// TestShareSubmission tests share submission functionality
func TestShareSubmission(t *testing.T) {
	engine, _ := createTestEngine(t)

	// Test submitting share before engine starts
	share := &Share{
		JobID:      "test_job_1",
		WorkerID:   "test_worker_1",
		Nonce:      12345,
		Difficulty: 1000,
		Algorithm:  SHA256D,
		Timestamp:  time.Now().Unix(),
	}

	err := engine.SubmitShare(share)
	assert.Error(t, err) // Should fail when engine not running

	// Start engine
	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Test valid share submission
	err = engine.SubmitShare(share)
	assert.NoError(t, err)

	// Test invalid share submission
	invalidShare := &Share{}
	err = engine.SubmitShare(invalidShare)
	assert.Error(t, err)

	// Test nil share
	err = engine.SubmitShare(nil)
	assert.Error(t, err)
}

// TestJobManagement tests job management functionality
func TestJobManagement(t *testing.T) {
	engine, _ := createTestEngine(t)

	// Test getting current job
	job := engine.GetCurrentJob()
	assert.NotNil(t, job)
	assert.NotEmpty(t, job.ID)
	assert.Equal(t, AlgorithmType("sha256d"), job.Algorithm)

	// Test job fields
	assert.Greater(t, job.Height, uint64(0))
	assert.Greater(t, job.Timestamp, uint32(0))
	assert.Equal(t, uint32(0x1d00ffff), job.Bits)
}

// TestConcurrentOperations tests thread safety
func TestConcurrentOperations(t *testing.T) {
	engine, _ := createTestEngine(t)

	err := engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	const numGoroutines = 10
	const operationsPerGoroutine = 100

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	// Concurrent statistics access
	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < operationsPerGoroutine; j++ {
				stats := engine.GetStats()
				assert.NotNil(t, stats)

				// Test concurrent share submission
				share := &Share{
					JobID:      "concurrent_job",
					WorkerID:   "concurrent_worker",
					Nonce:      uint64(j),
					Difficulty: 1000,
					Algorithm:  SHA256D,
					Timestamp:  time.Now().Unix(),
				}
				engine.SubmitShare(share)

				// Test concurrent job access
				job := engine.GetCurrentJob()
				assert.NotNil(t, job)

				runtime.Gosched() // Yield to other goroutines
			}
		}()
	}

	wg.Wait()

	// Verify final state is consistent
	stats := engine.GetStats()
	assert.NotNil(t, stats)
}

// TestMemoryUsage tests memory optimization
func TestMemoryUsage(t *testing.T) {
	config := createTestConfig()
	config.MaxMemoryMB = 512 // Set a memory limit
	
	logger := createTestLogger(t)
	engine, err := NewEngine(logger, config)
	require.NoError(t, err)

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Monitor memory usage
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	initialMem := m.Alloc

	// Simulate memory pressure
	for i := 0; i < 1000; i++ {
		job := engine.GetCurrentJob()
		assert.NotNil(t, job)

		share := &Share{
			JobID:      "memory_test_job",
			WorkerID:   "memory_test_worker",
			Nonce:      uint64(i),
			Difficulty: 1000,
			Algorithm:  SHA256D,
			Timestamp:  time.Now().Unix(),
		}
		engine.SubmitShare(share)
	}

	runtime.ReadMemStats(&m)
	finalMem := m.Alloc

	// Memory should not grow excessively
	memGrowth := finalMem - initialMem
	maxAllowedGrowth := uint64(config.MaxMemoryMB) * 1024 * 1024 / 2 // 50% of limit
	assert.LessOrEqual(t, memGrowth, maxAllowedGrowth, 
		"Memory growth exceeded expectations: %d bytes", memGrowth)
}

// TestConfigValidation tests configuration validation
func TestConfigValidation(t *testing.T) {
	tests := []struct {
		name   string
		config *Config
		valid  bool
	}{
		{
			name:   "valid config",
			config: createTestConfig(),
			valid:  true,
		},
		{
			name: "negative CPU threads",
			config: &Config{
				CPUThreads: -1,
				Algorithm:  "sha256d",
			},
			valid: false,
		},
		{
			name: "too many CPU threads",
			config: &Config{
				CPUThreads: 300,
				Algorithm:  "sha256d",
			},
			valid: false,
		},
		{
			name: "invalid algorithm",
			config: &Config{
				CPUThreads: 2,
				Algorithm:  "invalid",
			},
			valid: false,
		},
		{
			name: "memory too low",
			config: &Config{
				CPUThreads:  2,
				Algorithm:   "sha256d",
				MaxMemoryMB: 100,
			},
			valid: false,
		},
		{
			name: "memory too high",
			config: &Config{
				CPUThreads:  2,
				Algorithm:   "sha256d",
				MaxMemoryMB: 50000,
			},
			valid: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateConfig(tt.config)
			if tt.valid {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

// TestAlgorithmParsing tests algorithm string parsing
func TestAlgorithmParsing(t *testing.T) {
	tests := []struct {
		input    string
		expected AlgorithmType
	}{
		{"sha256", SHA256},
		{"SHA256", SHA256},
		{"sha256d", SHA256D},
		{"SHA256D", SHA256D},
		{"scrypt", Scrypt},
		{"Scrypt", Scrypt},
		{"ethash", Ethash},
		{"Ethash", Ethash},
		{"randomx", RandomX},
		{"RandomX", RandomX},
		{"kawpow", KawPow},
		{"KawPow", KawPow},
		{"invalid", "unknown"},
		{"", "unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := ParseAlgorithm(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

// TestStatsHistory tests statistics history functionality
func TestStatsHistory(t *testing.T) {
	engine, _ := createTestEngine(t)

	err := engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Initially no history
	history := engine.GetStatsHistory(time.Hour)
	assert.Empty(t, history)

	// Reset stats should clear history
	engine.ResetStats()
	history = engine.GetStatsHistory(time.Hour)
	assert.Empty(t, history)
}

// TestDefaultConfig tests default configuration
func TestDefaultConfig(t *testing.T) {
	config := DefaultConfig()
	assert.NotNil(t, config)
	assert.Equal(t, runtime.NumCPU(), config.CPUThreads)
	assert.Equal(t, "sha256d", config.Algorithm)
	assert.Equal(t, 80, config.Intensity)
	assert.Equal(t, 4096, config.MaxMemoryMB)
	assert.Equal(t, 1000, config.JobQueueSize)
	assert.True(t, config.AutoOptimize)
	assert.False(t, config.HugePages)
	assert.False(t, config.NUMA)
}

// Benchmark tests

func BenchmarkEngineStats(b *testing.B) {
	engine, _ := createTestEngine(b)
	err := engine.Start()
	require.NoError(b, err)
	defer engine.Stop()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		stats := engine.GetStats()
		_ = stats
	}
}

func BenchmarkShareSubmission(b *testing.B) {
	engine, _ := createTestEngine(b)
	err := engine.Start()
	require.NoError(b, err)
	defer engine.Stop()

	share := &Share{
		JobID:      "benchmark_job",
		WorkerID:   "benchmark_worker",
		Nonce:      12345,
		Difficulty: 1000,
		Algorithm:  SHA256D,
		Timestamp:  time.Now().Unix(),
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		err := engine.SubmitShare(share)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkJobGeneration(b *testing.B) {
	engine, _ := createTestEngine(b)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		job := engine.GetCurrentJob()
		_ = job
	}
}

func BenchmarkAlgorithmSwitching(b *testing.B) {
	engine, _ := createTestEngine(b)

	algorithms := []AlgorithmType{SHA256D, Scrypt, Ethash, RandomX, KawPow}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		algo := algorithms[i%len(algorithms)]
		err := engine.SwitchAlgorithm(algo)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkConcurrentOperations(b *testing.B) {
	engine, _ := createTestEngine(b)
	err := engine.Start()
	require.NoError(b, err)
	defer engine.Stop()

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			// Mix of different operations
			switch b.N % 3 {
			case 0:
				stats := engine.GetStats()
				_ = stats
			case 1:
				job := engine.GetCurrentJob()
				_ = job
			case 2:
				share := &Share{
					JobID:      "concurrent_job",
					WorkerID:   "concurrent_worker",
					Nonce:      uint64(b.N),
					Difficulty: 1000,
					Algorithm:  SHA256D,
					Timestamp:  time.Now().Unix(),
				}
				engine.SubmitShare(share)
			}
		}
	})
}

// Test helper functions

func TestMemoryAlignment(t *testing.T) {
	// Test memory alignment function
	tests := []struct {
		input    uintptr
		expected uintptr
	}{
		{0, 0},
		{1, 64},
		{63, 64},
		{64, 64},
		{65, 128},
		{127, 128},
		{128, 128},
	}

	for _, tt := range tests {
		result := alignMemory(tt.input)
		assert.Equal(t, tt.expected, result)
	}
}

func TestAllocateAligned(t *testing.T) {
	// Test aligned memory allocation
	sizes := []int{1, 32, 64, 128, 256, 1024}

	for _, size := range sizes {
		data := allocateAligned(size)
		assert.NotNil(t, data)
		assert.GreaterOrEqual(t, len(data), size)
		
		// Check alignment (address should be aligned to 64 bytes)
		addr := uintptr(unsafe.Pointer(&data[0]))
		assert.Equal(t, uintptr(0), addr%64)
	}
}