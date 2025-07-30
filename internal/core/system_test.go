package core

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

func TestNewOtedamaSystem(t *testing.T) {
	tests := []struct {
		name    string
		config  *config.Config
		logger  *zap.Logger
		wantErr bool
	}{
		{
			name: "valid_config",
			config: &config.Config{
				Mode:    "auto",
				Version: "3.0.0",
				Mining: config.MiningConfig{
					Algorithm:    "sha256d",
					HardwareType: "cpu",
					Threads:      4,
				},
				Network: config.NetworkConfig{
					ListenAddr:   ":30303",
					MaxPeers:     100,
					EnableP2P:    true,
					DialTimeout:  15 * time.Second,
				},
				ZKP: config.ZKPConfig{
					Enabled:  true,
					Protocol: "groth16",
					Curve:    "bn254",
				},
			},
			logger:  zaptest.NewLogger(t),
			wantErr: false,
		},
		{
			name:    "nil_config",
			config:  nil,
			logger:  zaptest.NewLogger(t),
			wantErr: true,
		},
		{
			name: "nil_logger",
			config: &config.Config{
				Mode:    "solo",
				Version: "3.0.0",
			},
			logger:  nil,
			wantErr: false, // Should create nop logger
		},
		{
			name: "enterprise_mode",
			config: &config.Config{
				Mode:    "enterprise",
				Version: "3.0.0",
				Enterprise: config.EnterpriseConfig{
					Enabled:      true,
					MultiTenant:  true,
					ClusterMode:  true,
				},
			},
			logger:  zaptest.NewLogger(t),
			wantErr: false,
		},
		{
			name: "government_mode",
			config: &config.Config{
				Mode:    "government",
				Version: "3.0.0",
				Government: config.GovernmentConfig{
					Enabled:             true,
					KYCIntegration:      false,
					AMLMonitoring:       true,
					SanctionsScreening:  true,
				},
			},
			logger:  zaptest.NewLogger(t),
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			system, err := NewOtedamaSystem(tt.config, tt.logger)
			
			if tt.wantErr {
				assert.Error(t, err)
				assert.Nil(t, system)
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, system)
				assert.Equal(t, StatusInitializing, system.status)
				assert.NotNil(t, system.errorHandler)
				assert.NotNil(t, system.recoveryManager)
				assert.NotNil(t, system.circuitBreaker)
			}
		})
	}
}

func TestOtedamaSystem_StartStop(t *testing.T) {
	logger := zaptest.NewLogger(t)
	cfg := &config.Config{
		Mode:    "auto",
		Version: "3.0.0",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      2,
		},
		Network: config.NetworkConfig{
			ListenAddr: ":30303",
			MaxPeers:   10,
		},
	}

	system, err := NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	t.Run("start_system", func(t *testing.T) {
		err := system.Start(ctx)
		assert.NoError(t, err)
		assert.Equal(t, StatusRunning, system.status)
		assert.NotZero(t, system.startTime)
		
		// Give time for components to initialize
		time.Sleep(100 * time.Millisecond)
	})

	t.Run("start_already_running", func(t *testing.T) {
		err := system.Start(ctx)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "already running")
	})

	t.Run("get_status", func(t *testing.T) {
		status := system.GetStatus()
		assert.NotNil(t, status)
		assert.Equal(t, StatusRunning, *status)
	})

	t.Run("get_metrics", func(t *testing.T) {
		metrics := system.GetMetrics()
		assert.NotNil(t, metrics)
		assert.GreaterOrEqual(t, metrics.CPUUsage, float64(0))
		assert.Greater(t, metrics.MemoryUsage, uint64(0))
		assert.Greater(t, metrics.Uptime, time.Duration(0))
		assert.NotZero(t, metrics.LastUpdate)
	})

	t.Run("get_health_status", func(t *testing.T) {
		health := system.GetHealthStatus()
		assert.NotNil(t, health)
		assert.NotEmpty(t, health.Overall)
		assert.NotZero(t, health.LastCheck)
		assert.GreaterOrEqual(t, health.Score, float64(0))
	})

	t.Run("get_performance_metrics", func(t *testing.T) {
		perf := system.GetPerformanceMetrics()
		assert.NotNil(t, perf)
		assert.NotZero(t, perf.LastMeasurement)
	})

	t.Run("stop_system", func(t *testing.T) {
		err := system.Stop(ctx)
		assert.NoError(t, err)
		assert.Equal(t, StatusStopped, system.status)
	})

	t.Run("stop_already_stopped", func(t *testing.T) {
		err := system.Stop(ctx)
		assert.NoError(t, err) // Should not error
	})
}

func TestOtedamaSystem_ModeOperations(t *testing.T) {
	tests := []struct {
		name         string
		mode         string
		expectations func(*testing.T, *OtedamaSystem)
	}{
		{
			name: "auto_mode",
			mode: "auto",
			expectations: func(t *testing.T, s *OtedamaSystem) {
				assert.Equal(t, ModeAuto, s.mode)
			},
		},
		{
			name: "solo_mode",
			mode: "solo",
			expectations: func(t *testing.T, s *OtedamaSystem) {
				assert.Equal(t, ModeSolo, s.mode)
				assert.NotNil(t, s.miningEngine)
			},
		},
		{
			name: "pool_mode",
			mode: "pool",
			expectations: func(t *testing.T, s *OtedamaSystem) {
				assert.Equal(t, ModePool, s.mode)
				assert.NotNil(t, s.p2pPool)
			},
		},
		{
			name: "miner_mode",
			mode: "miner",
			expectations: func(t *testing.T, s *OtedamaSystem) {
				assert.Equal(t, ModeMiner, s.mode)
				assert.NotNil(t, s.miningEngine)
			},
		},
		{
			name: "benchmark_mode",
			mode: "benchmark",
			expectations: func(t *testing.T, s *OtedamaSystem) {
				assert.Equal(t, ModeBenchmark, s.mode)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := zaptest.NewLogger(t)
			cfg := &config.Config{
				Mode:    tt.mode,
				Version: "3.0.0",
				Mining: config.MiningConfig{
					Algorithm: "sha256d",
				},
			}

			system, err := NewOtedamaSystem(cfg, logger)
			require.NoError(t, err)
			
			tt.expectations(t, system)
		})
	}
}

func TestOtedamaSystem_RunBenchmarks(t *testing.T) {
	logger := zaptest.NewLogger(t)
	cfg := &config.Config{
		Mode:    "benchmark",
		Version: "3.0.0",
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
	}

	system, err := NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	err = system.RunBenchmarks(ctx)
	assert.NoError(t, err)

	results := system.GetBenchmarkResults()
	assert.NotEmpty(t, results)

	// Check for expected benchmarks
	expectedBenchmarks := []string{
		"mining_sha256d",
		"zkp_gen_groth16",
		"zkp_verify_groth16",
		"p2p_messaging",
		"memory_allocation",
		"network_serialization",
		"crypto_operations",
		"database_operations",
	}

	for _, name := range expectedBenchmarks {
		result, exists := results[name]
		assert.True(t, exists, "Benchmark %s should exist", name)
		if exists {
			assert.Greater(t, result.OpsPerSecond, float64(0))
			assert.Greater(t, result.Duration, time.Duration(0))
			assert.Greater(t, result.Iterations, 0)
			assert.NotZero(t, result.Timestamp)
		}
	}

	// Check profiler stats
	stats := system.GetProfilerStats()
	assert.NotNil(t, stats)
}

func TestOtedamaSystem_ComponentIntegration(t *testing.T) {
	logger := zaptest.NewLogger(t)
	cfg := &config.Config{
		Mode:    "pool",
		Version: "3.0.0",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      2,
		},
		Network: config.NetworkConfig{
			ListenAddr: ":30303",
			MaxPeers:   10,
			EnableP2P:  true,
		},
		P2PPool: config.P2PPoolConfig{
			Enabled:         true,
			ShareDifficulty: 1000.0,
			BlockTime:       10 * time.Minute,
			FeePercentage:   0.5,
		},
		ZKP: config.ZKPConfig{
			Enabled:               true,
			Protocol:              "groth16",
			Curve:                 "bn254",
			RequireHashpowerProof: true,
			MinHashpowerRequirement: 10000,
		},
		API: config.APIConfig{
			Enabled:    true,
			ListenAddr: ":8080",
		},
		Dashboard: config.DashboardConfig{
			Enabled:    true,
			ListenAddr: ":8888",
		},
		Monitoring: config.MonitoringConfig{
			Enabled:         true,
			MetricsInterval: 1 * time.Second,
		},
	}

	system, err := NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Start the system
	err = system.Start(ctx)
	require.NoError(t, err)
	defer system.Stop(ctx)

	// Allow components to initialize
	time.Sleep(500 * time.Millisecond)

	t.Run("mining_engine_integration", func(t *testing.T) {
		assert.NotNil(t, system.miningEngine)
		// Mining engine should be initialized
	})

	t.Run("p2p_pool_integration", func(t *testing.T) {
		assert.NotNil(t, system.p2pPool)
		// P2P pool should be initialized
	})

	t.Run("zkp_system_integration", func(t *testing.T) {
		assert.NotNil(t, system.zkpSystem)
		// ZKP system should be initialized
	})

	t.Run("api_server_integration", func(t *testing.T) {
		assert.NotNil(t, system.apiServer)
		// API server should be running
	})

	t.Run("monitoring_integration", func(t *testing.T) {
		assert.NotNil(t, system.monitoringSystem)
		
		// Check that metrics are being collected
		metrics := system.GetMetrics()
		assert.NotNil(t, metrics)
		assert.NotZero(t, metrics.LastUpdate)
	})

	t.Run("health_checks", func(t *testing.T) {
		health := system.GetHealthStatus()
		assert.NotNil(t, health)
		assert.NotEmpty(t, health.Components)
		
		// Check key components
		expectedComponents := []string{
			"mining_engine",
			"zkp_system",
			"p2p_network",
			"api_server",
			"monitoring_system",
		}
		
		for _, comp := range expectedComponents {
			_, exists := health.Components[comp]
			assert.True(t, exists, "Component %s should have health status", comp)
		}
	})
}

func TestOtedamaSystem_ErrorRecovery(t *testing.T) {
	logger := zaptest.NewLogger(t)
	cfg := &config.Config{
		Mode:    "auto",
		Version: "3.0.0",
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
	}

	system, err := NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)

	t.Run("error_handler", func(t *testing.T) {
		assert.NotNil(t, system.errorHandler)
		// Error handler should be properly initialized
	})

	t.Run("recovery_manager", func(t *testing.T) {
		assert.NotNil(t, system.recoveryManager)
		// Recovery manager should be properly initialized
	})

	t.Run("circuit_breaker", func(t *testing.T) {
		assert.NotNil(t, system.circuitBreaker)
		// Circuit breaker should be properly initialized
	})
}

func TestOtedamaSystem_ConcurrentOperations(t *testing.T) {
	logger := zaptest.NewLogger(t)
	cfg := &config.Config{
		Mode:    "auto",
		Version: "3.0.0",
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
	}

	system, err := NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)

	ctx := context.Background()
	err = system.Start(ctx)
	require.NoError(t, err)
	defer system.Stop(ctx)

	// Run concurrent operations
	done := make(chan bool, 4)
	
	// Concurrent metrics reads
	go func() {
		for i := 0; i < 100; i++ {
			_ = system.GetMetrics()
			time.Sleep(time.Millisecond)
		}
		done <- true
	}()

	// Concurrent health checks
	go func() {
		for i := 0; i < 100; i++ {
			_ = system.GetHealthStatus()
			time.Sleep(time.Millisecond)
		}
		done <- true
	}()

	// Concurrent performance metrics
	go func() {
		for i := 0; i < 100; i++ {
			_ = system.GetPerformanceMetrics()
			time.Sleep(time.Millisecond)
		}
		done <- true
	}()

	// Concurrent status checks
	go func() {
		for i := 0; i < 100; i++ {
			_ = system.GetStatus()
			time.Sleep(time.Millisecond)
		}
		done <- true
	}()

	// Wait for all operations with timeout
	for i := 0; i < 4; i++ {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("Concurrent operations timed out")
		}
	}
}

func BenchmarkOtedamaSystem(b *testing.B) {
	logger := zap.NewNop()
	cfg := &config.Config{
		Mode:    "auto",
		Version: "3.0.0",
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
	}

	system, err := NewOtedamaSystem(cfg, logger)
	require.NoError(b, err)

	ctx := context.Background()
	err = system.Start(ctx)
	require.NoError(b, err)
	defer system.Stop(ctx)

	b.Run("GetMetrics", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = system.GetMetrics()
		}
	})

	b.Run("GetHealthStatus", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = system.GetHealthStatus()
		}
	})

	b.Run("GetPerformanceMetrics", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			_ = system.GetPerformanceMetrics()
		}
	})
}