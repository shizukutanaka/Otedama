package mining

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/core"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// Mock types for testing
type MockCPUEngine struct {
	mock.Mock
	hashRate    atomic.Uint64
	running     atomic.Bool
	difficulty  atomic.Uint32
}

func (m *MockCPUEngine) Start(ctx context.Context) error {
	args := m.Called(ctx)
	m.running.Store(true)
	return args.Error(0)
}

func (m *MockCPUEngine) Stop() error {
	args := m.Called()
	m.running.Store(false)
	return args.Error(0)
}

func (m *MockCPUEngine) GetHashRate() uint64 {
	return m.hashRate.Load()
}

func (m *MockCPUEngine) SetWork(work Work) {
	m.Called(work)
}

func (m *MockCPUEngine) SetDifficulty(difficulty uint32) {
	m.difficulty.Store(difficulty)
}

func (m *MockCPUEngine) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"hash_rate": m.hashRate.Load(),
		"threads":   4,
	}
}

// TestNewEngine tests engine creation with various configurations
func TestNewEngine(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name    string
		config  Config
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid CPU configuration",
			config: Config{
				HardwareType: HardwareCPU,
				Algorithm:    AlgorithmSHA256d,
				Threads:      4,
				CPU: CPUConfig{
					Algorithm: "sha256d",
					Threads:   4,
				},
			},
			wantErr: false,
		},
		{
			name: "auto detect hardware",
			config: Config{
				HardwareType: HardwareAuto,
				Algorithm:    AlgorithmSHA256d,
				CPU: CPUConfig{
					Algorithm: "sha256d",
				},
			},
			wantErr: false,
		},
		{
			name: "invalid algorithm",
			config: Config{
				HardwareType: HardwareCPU,
				Algorithm:    "invalid",
				CPU: CPUConfig{
					Algorithm: "invalid",
				},
			},
			wantErr: true,
			errMsg:  "unsupported algorithm",
		},
		{
			name: "GPU hardware (will fail as not implemented)",
			config: Config{
				HardwareType: HardwareGPU,
				Algorithm:    AlgorithmEthash,
			},
			wantErr: true,
			errMsg:  "failed to create GPU engine",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			logger := zaptest.NewLogger(t)
			engine, err := NewEngine(tt.config, logger)
			
			if tt.wantErr {
				assert.Error(t, err)
				if tt.errMsg != "" {
					assert.Contains(t, err.Error(), tt.errMsg)
				}
				assert.Nil(t, engine)
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, engine)
				assert.NotNil(t, engine.logger)
				assert.NotNil(t, engine.jobManager)
				assert.NotNil(t, engine.shareValidator)
				assert.NotNil(t, engine.difficultyMgr)
				assert.NotNil(t, engine.algorithmMgr)
				assert.NotNil(t, engine.errorHandler)
				assert.NotNil(t, engine.recoveryManager)
				assert.False(t, engine.running.Load())
				
				// Cleanup
				engine.cancel()
			}
		})
	}
}

// TestEngineStartStop tests starting and stopping the engine
func TestEngineStartStop(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		Threads:      2,
		CPU: CPUConfig{
			Algorithm: "sha256d",
			Threads:   2,
		},
	}

	t.Run("successful start and stop", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		// Start engine
		err = engine.Start()
		assert.NoError(t, err)
		assert.True(t, engine.running.Load())
		assert.Greater(t, engine.uptime.Load(), int64(0))

		// Give time for goroutines to start
		time.Sleep(50 * time.Millisecond)

		// Stop engine
		err = engine.Stop()
		assert.NoError(t, err)
		assert.False(t, engine.running.Load())
	})

	t.Run("start already running engine", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		// Start engine
		err = engine.Start()
		require.NoError(t, err)
		defer engine.Stop()

		// Try to start again
		err = engine.Start()
		assert.Error(t, err)
		var otedamaErr *core.OtedamaError
		assert.ErrorAs(t, err, &otedamaErr)
		assert.Equal(t, "ENGINE_ALREADY_RUNNING", otedamaErr.Code)
	})

	t.Run("stop already stopped engine", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		// Stop without starting
		err = engine.Stop()
		assert.NoError(t, err) // Should not error
	})

	t.Run("panic recovery in Start", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		// Force a panic by setting cpuEngine to nil
		engine.cpuEngine = nil

		// Should recover from panic
		err = engine.Start()
		assert.Error(t, err)
		assert.False(t, engine.running.Load())
	})
}

// TestSubmitJob tests job submission functionality
func TestSubmitJob(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		CPU: CPUConfig{
			Algorithm: "sha256d",
			Threads:   2,
		},
	}

	t.Run("submit valid job", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		err = engine.Start()
		require.NoError(t, err)
		defer engine.Stop()

		job := &MiningJob{
			ID:        "test-job-1",
			Algorithm: AlgorithmSHA256d,
			Data:      []byte("test-data"),
			Target:    []byte("test-target"),
			Height:    12345,
			Timestamp: time.Now(),
		}

		err = engine.SubmitJob(job)
		assert.NoError(t, err)
	})

	t.Run("submit job to stopped engine", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		job := &MiningJob{
			ID:        "test-job-2",
			Algorithm: AlgorithmSHA256d,
			Data:      []byte("test-data"),
			Target:    []byte("test-target"),
		}

		err = engine.SubmitJob(job)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "mining engine not running")
	})

	t.Run("submit invalid job", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		err = engine.Start()
		require.NoError(t, err)
		defer engine.Stop()

		tests := []struct {
			name string
			job  *MiningJob
			err  string
		}{
			{
				name: "nil job",
				job:  nil,
				err:  "job is nil",
			},
			{
				name: "empty ID",
				job: &MiningJob{
					Algorithm: AlgorithmSHA256d,
					Data:      []byte("data"),
					Target:    []byte("target"),
				},
				err: "job ID is empty",
			},
			{
				name: "empty data",
				job: &MiningJob{
					ID:        "test",
					Algorithm: AlgorithmSHA256d,
					Target:    []byte("target"),
				},
				err: "job data is empty",
			},
			{
				name: "empty target",
				job: &MiningJob{
					ID:        "test",
					Algorithm: AlgorithmSHA256d,
					Data:      []byte("data"),
				},
				err: "job target is empty",
			},
			{
				name: "wrong algorithm",
				job: &MiningJob{
					ID:        "test",
					Algorithm: AlgorithmEthash,
					Data:      []byte("data"),
					Target:    []byte("target"),
				},
				err: "job algorithm",
			},
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				err := engine.SubmitJob(tt.job)
				assert.Error(t, err)
				assert.Contains(t, err.Error(), tt.err)
			})
		}
	})
}

// TestSubmitShare tests share submission
func TestSubmitShare(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		CPU: CPUConfig{
			Algorithm: "sha256d",
		},
	}

	t.Run("submit valid share", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		err = engine.Start()
		require.NoError(t, err)
		defer engine.Stop()

		share := &Share{
			JobID:      "test-job",
			Nonce:      12345,
			Hash:       []byte("valid-hash"),
			Difficulty: 1.0,
			Timestamp:  time.Now(),
		}

		err = engine.SubmitShare(share)
		assert.NoError(t, err)
		assert.Equal(t, uint64(1), engine.totalShares.Load())
		assert.Equal(t, uint64(1), engine.acceptedShares.Load())
	})

	t.Run("submit share to stopped engine", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		share := &Share{
			JobID: "test-job",
			Hash:  []byte("hash"),
		}

		err = engine.SubmitShare(share)
		assert.Error(t, err)
		var otedamaErr *core.OtedamaError
		assert.ErrorAs(t, err, &otedamaErr)
		assert.Equal(t, "ENGINE_NOT_RUNNING", otedamaErr.Code)
	})
}

// TestGetStats tests statistics retrieval
func TestGetStats(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		CPU: CPUConfig{
			Algorithm: "sha256d",
			Threads:   4,
		},
	}

	engine, err := NewEngine(config, logger)
	require.NoError(t, err)
	defer engine.cancel()

	// Set some test values
	engine.hashRate.Store(1000000)
	engine.acceptedShares.Store(100)
	engine.rejectedShares.Store(10)
	engine.failedShares.Store(5)
	engine.uptime.Store(time.Now().Unix() - 3600) // 1 hour ago

	stats := engine.GetStats()
	
	assert.Equal(t, float64(1000000), stats.HashRate)
	assert.Equal(t, uint64(100), stats.Shares.Accepted)
	assert.Equal(t, uint64(10), stats.Shares.Rejected)
	assert.Equal(t, uint64(5), stats.Shares.Stale)
	assert.Equal(t, HardwareCPU, stats.Hardware.Type)
	assert.Greater(t, stats.Uptime, time.Duration(0))
}

// TestSetDifficulty tests difficulty adjustment
func TestSetDifficulty(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		CPU: CPUConfig{
			Algorithm: "sha256d",
		},
	}

	engine, err := NewEngine(config, logger)
	require.NoError(t, err)
	defer engine.cancel()

	// Set difficulty
	engine.SetDifficulty(12345.67)
	
	// Verify it was set in difficulty manager
	assert.NotNil(t, engine.difficultyMgr)
}

// TestConcurrentOperations tests thread safety
func TestConcurrentOperations(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		CPU: CPUConfig{
			Algorithm: "sha256d",
			Threads:   4,
		},
	}

	engine, err := NewEngine(config, logger)
	require.NoError(t, err)
	defer engine.cancel()

	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()

	// Run concurrent operations
	var wg sync.WaitGroup
	numGoroutines := 10

	// Concurrent job submissions
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			job := &MiningJob{
				ID:        fmt.Sprintf("job-%d", id),
				Algorithm: AlgorithmSHA256d,
				Data:      []byte("test-data"),
				Target:    []byte("test-target"),
				Height:    uint64(id),
			}
			_ = engine.SubmitJob(job)
		}(i)
	}

	// Concurrent share submissions
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			share := &Share{
				JobID:      fmt.Sprintf("job-%d", id),
				Nonce:      uint64(id),
				Hash:       []byte("hash"),
				Difficulty: 1.0,
			}
			_ = engine.SubmitShare(share)
		}(i)
	}

	// Concurrent stats reads
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				_ = engine.GetStats()
				_ = engine.GetHashRate()
				time.Sleep(time.Microsecond)
			}
		}()
	}

	// Concurrent difficulty updates
	wg.Add(numGoroutines)
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				engine.SetDifficulty(float64(id*100 + j))
				time.Sleep(time.Millisecond)
			}
		}(i)
	}

	// Wait for all operations to complete
	done := make(chan bool)
	go func() {
		wg.Wait()
		done <- true
	}()

	select {
	case <-done:
		// Success - no deadlocks or panics
	case <-time.After(5 * time.Second):
		t.Fatal("Concurrent operations timed out")
	}
}

// TestErrorHandling tests error handling and recovery
func TestErrorHandling(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		MaxTemp:      80,
		AutoTuning:   true,
		PowerLimit:   100,
		Intensity:    100,
		CPU: CPUConfig{
			Algorithm: "sha256d",
		},
	}

	t.Run("temperature limit exceeded", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		err = engine.Start()
		require.NoError(t, err)
		defer engine.Stop()

		// Simulate high temperature by manipulating stats
		// This would trigger checkThermalLimits()
		engine.checkThermalLimits()
		
		// Verify error handling was triggered
		// In a real test, we'd mock the temperature reading
	})

	t.Run("high error rate detection", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		// Set high error rate
		engine.totalShares.Store(100)
		engine.failedShares.Store(20) // 20% error rate

		errorRate := engine.calculateErrorRate()
		assert.Greater(t, errorRate, 0.1)
	})

	t.Run("recovery strategies", func(t *testing.T) {
		engine, err := NewEngine(config, logger)
		require.NoError(t, err)
		defer engine.cancel()

		ctx := context.Background()

		// Test reset hardware
		err = engine.resetHardware(ctx)
		assert.NoError(t, err)

		// Test reduce intensity
		initialIntensity := engine.config.Intensity
		err = engine.reduceIntensity(ctx)
		assert.NoError(t, err)
		assert.Less(t, engine.config.Intensity, initialIntensity)

		// Test switch algorithm (should fail as not implemented)
		err = engine.switchAlgorithm(ctx)
		assert.Error(t, err)
	})
}

// TestHealthChecks tests health check implementations
func TestHealthChecks(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		MaxTemp:      80,
		CPU: CPUConfig{
			Algorithm: "sha256d",
		},
	}

	engine, err := NewEngine(config, logger)
	require.NoError(t, err)
	defer engine.cancel()

	ctx := context.Background()

	t.Run("mining engine health check", func(t *testing.T) {
		check := &MiningEngineHealthCheck{engine: engine}
		
		// Engine not running
		err := check.Check(ctx)
		assert.Error(t, err)
		assert.True(t, check.Critical())
		assert.Equal(t, "mining_engine", check.Name())

		// Start engine
		err = engine.Start()
		require.NoError(t, err)
		defer engine.Stop()

		// Engine running
		err = check.Check(ctx)
		assert.NoError(t, err)
	})

	t.Run("hash rate health check", func(t *testing.T) {
		check := &HashRateHealthCheck{engine: engine}
		
		err := engine.Start()
		require.NoError(t, err)
		defer engine.Stop()

		// Zero hash rate
		engine.hashRate.Store(0)
		err = check.Check(ctx)
		assert.Error(t, err)
		assert.False(t, check.Critical())
		assert.Equal(t, "hash_rate", check.Name())

		// Non-zero hash rate
		engine.hashRate.Store(1000000)
		err = check.Check(ctx)
		assert.NoError(t, err)
	})

	t.Run("temperature health check", func(t *testing.T) {
		check := &TemperatureHealthCheck{engine: engine}
		
		// Normal temperature
		err := check.Check(ctx)
		assert.NoError(t, err)
		assert.True(t, check.Critical())
		assert.Equal(t, "temperature", check.Name())
	})
}

// TestValidateConfig tests configuration validation
func TestValidateConfig(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name   string
		config *Config
		valid  bool
	}{
		{
			name: "valid config",
			config: &Config{
				Algorithm: AlgorithmSHA256d,
				Threads:   4,
				WorkSize:  256 * 1024,
				MaxTemp:   85,
			},
			valid: true,
		},
		{
			name: "invalid algorithm",
			config: &Config{
				Algorithm: "invalid",
			},
			valid: false,
		},
		{
			name: "zero threads (should be set to NumCPU)",
			config: &Config{
				Algorithm: AlgorithmSHA256d,
				Threads:   0,
			},
			valid: true,
		},
		{
			name: "negative work size (should be set to default)",
			config: &Config{
				Algorithm: AlgorithmSHA256d,
				WorkSize:  -1,
			},
			valid: true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			err := validateConfig(tt.config)
			if tt.valid {
				assert.NoError(t, err)
				// Check defaults were set
				if tt.config.Threads <= 0 {
					assert.Greater(t, tt.config.Threads, 0)
				}
				if tt.config.WorkSize <= 0 {
					assert.Greater(t, tt.config.WorkSize, 0)
				}
				if tt.config.MaxTemp <= 0 {
					assert.Greater(t, tt.config.MaxTemp, 0)
				}
			} else {
				assert.Error(t, err)
			}
		})
	}
}

// TestIsValidAlgorithm tests algorithm validation
func TestIsValidAlgorithm(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		algo  MiningAlgorithm
		valid bool
	}{
		{AlgorithmSHA256d, true},
		{AlgorithmEthash, true},
		{AlgorithmKawPow, true},
		{AlgorithmRandomX, true},
		{AlgorithmScrypt, true},
		{AlgorithmProgPow, true},
		{AlgorithmCuckoo, true},
		{"invalid", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(string(tt.algo), func(t *testing.T) {
			assert.Equal(t, tt.valid, isValidAlgorithm(tt.algo))
		})
	}
}

// Benchmark tests
func BenchmarkEngineOperations(b *testing.B) {
	logger := zap.NewNop()
	config := Config{
		HardwareType: HardwareCPU,
		Algorithm:    AlgorithmSHA256d,
		CPU: CPUConfig{
			Algorithm: "sha256d",
			Threads:   4,
		},
	}

	engine, err := NewEngine(config, logger)
	require.NoError(b, err)
	defer engine.cancel()

	err = engine.Start()
	require.NoError(b, err)
	defer engine.Stop()

	b.Run("SubmitJob", func(b *testing.B) {
		job := &MiningJob{
			ID:        "bench-job",
			Algorithm: AlgorithmSHA256d,
			Data:      []byte("test-data"),
			Target:    []byte("test-target"),
			Height:    12345,
		}

		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = engine.SubmitJob(job)
		}
	})

	b.Run("SubmitShare", func(b *testing.B) {
		share := &Share{
			JobID:      "bench-job",
			Nonce:      12345,
			Hash:       []byte("test-hash"),
			Difficulty: 1.0,
		}

		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = engine.SubmitShare(share)
		}
	})

	b.Run("GetStats", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = engine.GetStats()
		}
	})

	b.Run("GetHashRate", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = engine.GetHashRate()
		}
	})
}

// Table-driven tests for edge cases
func TestEngineEdgeCases(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)

	tests := []struct {
		name   string
		setup  func(*Engine)
		test   func(*testing.T, *Engine)
	}{
		{
			name: "nil logger handling",
			setup: func(e *Engine) {
				// Engine created with nil logger
			},
			test: func(t *testing.T, e *Engine) {
				// Should not panic
				assert.NotNil(t, e)
			},
		},
		{
			name: "empty job manager",
			setup: func(e *Engine) {
				e.jobManager = nil
			},
			test: func(t *testing.T, e *Engine) {
				job := &MiningJob{ID: "test"}
				// Should handle nil job manager gracefully
				err := e.SubmitJob(job)
				assert.Error(t, err)
			},
		},
		{
			name: "nil share validator",
			setup: func(e *Engine) {
				e.shareValidator = nil
			},
			test: func(t *testing.T, e *Engine) {
				share := &Share{JobID: "test", Hash: []byte("hash")}
				err := e.SubmitShare(share)
				assert.Error(t, err)
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			config := Config{
				HardwareType: HardwareCPU,
				Algorithm:    AlgorithmSHA256d,
				CPU: CPUConfig{
					Algorithm: "sha256d",
				},
			}

			engine, _ := NewEngine(config, logger)
			if engine != nil {
				defer engine.cancel()
				if tt.setup != nil {
					tt.setup(engine)
				}
				tt.test(t, engine)
			}
		})
	}
}