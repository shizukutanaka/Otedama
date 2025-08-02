package app

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestApplication_Creation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "pool",
		Network: config.NetworkConfig{
			ListenAddr: ":0",
			MaxPeers:   10,
			EnableP2P:  true,
		},
		Mining: config.MiningConfig{
			Algorithm:       "sha256d",
			ShareDifficulty: 1.0,
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)
	assert.NotNil(t, app)
}

func TestApplication_StartStop(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "solo",
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
			Threads:   1,
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)

	// Start application
	err = app.Start()
	assert.NoError(t, err)

	// Wait a bit
	time.Sleep(100 * time.Millisecond)

	// Should be running
	assert.True(t, app.IsRunning())

	// Shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = app.Shutdown(shutdownCtx)
	assert.NoError(t, err)

	// Should not be running
	assert.False(t, app.IsRunning())
}

func TestApplication_PoolMode(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "pool",
		Network: config.NetworkConfig{
			ListenAddr: "127.0.0.1:0",
			MaxPeers:   10,
			EnableP2P:  true,
		},
		Mining: config.MiningConfig{
			Algorithm:       "sha256d",
			ShareDifficulty: 1.0,
		},
		Stratum: config.StratumConfig{
			Enabled:    true,
			ListenAddr: "127.0.0.1:0",
			MaxClients: 100,
		},
		P2P: config.P2PConfig{
			Enabled:         true,
			MaxConnections:  50,
			MinConnections:  5,
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)

	err = app.Start()
	assert.NoError(t, err)

	// Verify components are initialized
	assert.NotNil(t, app.pool)
	assert.NotNil(t, app.stratumServer)

	// Shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = app.Shutdown(shutdownCtx)
	assert.NoError(t, err)
}

func TestApplication_SoloMode(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "solo",
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
			Threads:   2,
			CPUMiner: config.CPUMinerConfig{
				Enabled:  true,
				Threads:  2,
				Priority: 5,
			},
		},
		Wallet: config.WalletConfig{
			Address: "bc1qtest123456789",
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)

	err = app.Start()
	assert.NoError(t, err)

	// Verify mining engine is initialized
	assert.NotNil(t, app.miningEngine)

	// Shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = app.Shutdown(shutdownCtx)
	assert.NoError(t, err)
}

func TestApplication_ConfigReload(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "pool",
		Network: config.NetworkConfig{
			ListenAddr: ":0",
			MaxPeers:   10,
		},
		Mining: config.MiningConfig{
			Algorithm:       "sha256d",
			ShareDifficulty: 1.0,
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)

	err = app.Start()
	assert.NoError(t, err)

	// Modify config
	newCfg := *cfg
	newCfg.Mining.ShareDifficulty = 2.0

	// Reload config
	err = app.ReloadConfig(&newCfg)
	assert.NoError(t, err)

	// Verify config was updated
	assert.Equal(t, 2.0, app.config.Mining.ShareDifficulty)

	// Shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = app.Shutdown(shutdownCtx)
	assert.NoError(t, err)
}

func TestApplication_HealthCheck(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "pool",
		Network: config.NetworkConfig{
			ListenAddr: ":0",
			MaxPeers:   10,
		},
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
		Monitoring: config.MonitoringConfig{
			Enabled:         true,
			MetricsInterval: 1 * time.Second,
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)

	err = app.Start()
	assert.NoError(t, err)

	// Perform health check
	health := app.HealthCheck()
	assert.Equal(t, "healthy", health.Status)
	assert.NotEmpty(t, health.Components)

	// Shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = app.Shutdown(shutdownCtx)
	assert.NoError(t, err)
}

func TestApplication_Stats(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "pool",
		Network: config.NetworkConfig{
			ListenAddr: ":0",
			MaxPeers:   10,
		},
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)

	err = app.Start()
	assert.NoError(t, err)

	// Get stats
	stats := app.GetStats()
	assert.NotNil(t, stats)
	assert.Equal(t, "pool", stats.Mode)
	assert.NotNil(t, stats.Uptime)

	// Shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = app.Shutdown(shutdownCtx)
	assert.NoError(t, err)
}

func TestApplication_InvalidMode(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "invalid",
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
	}

	app, err := New(ctx, logger, cfg)
	assert.Error(t, err)
	assert.Nil(t, app)
}

func TestApplication_GracefulShutdown(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "pool",
		Network: config.NetworkConfig{
			ListenAddr: ":0",
			MaxPeers:   10,
		},
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)

	err = app.Start()
	assert.NoError(t, err)

	// Test shutdown with short timeout
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 1*time.Millisecond)
	defer cancel()

	// Should handle timeout gracefully
	err = app.Shutdown(shutdownCtx)
	// Error is expected due to timeout, but should not panic
	_ = err
}

func TestApplication_ConcurrentOperations(t *testing.T) {
	logger := zaptest.NewLogger(t)
	ctx := context.Background()
	
	cfg := &config.Config{
		Mode: "pool",
		Network: config.NetworkConfig{
			ListenAddr: ":0",
			MaxPeers:   10,
		},
		Mining: config.MiningConfig{
			Algorithm: "sha256d",
		},
	}

	app, err := New(ctx, logger, cfg)
	require.NoError(t, err)

	err = app.Start()
	assert.NoError(t, err)

	// Perform concurrent operations
	done := make(chan bool, 4)

	// Stats reader
	go func() {
		for i := 0; i < 10; i++ {
			app.GetStats()
			time.Sleep(10 * time.Millisecond)
		}
		done <- true
	}()

	// Health checker
	go func() {
		for i := 0; i < 10; i++ {
			app.HealthCheck()
			time.Sleep(10 * time.Millisecond)
		}
		done <- true
	}()

	// Config reloader
	go func() {
		for i := 0; i < 5; i++ {
			newCfg := *cfg
			newCfg.Mining.ShareDifficulty = float64(i + 1)
			app.ReloadConfig(&newCfg)
			time.Sleep(20 * time.Millisecond)
		}
		done <- true
	}()

	// Status checker
	go func() {
		for i := 0; i < 10; i++ {
			app.IsRunning()
			time.Sleep(10 * time.Millisecond)
		}
		done <- true
	}()

	// Wait for all goroutines
	for i := 0; i < 4; i++ {
		<-done
	}

	// Shutdown
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = app.Shutdown(shutdownCtx)
	assert.NoError(t, err)
}