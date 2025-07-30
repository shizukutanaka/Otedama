// +build integration

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/core"
	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/p2p"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

// TestIntegrationFullSystemStartup tests complete system initialization
func TestIntegrationFullSystemStartup(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	
	logger := zaptest.NewLogger(t)
	
	// Create system configuration
	cfg := &config.Config{
		Mode:    "pool",
		Version: "test",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      2,
			Intensity:    50,
		},
		Network: config.NetworkConfig{
			ListenAddr: ":0", // Random port
			MaxPeers:   10,
			EnableP2P:  true,
		},
		P2PPool: config.P2PPoolConfig{
			Enabled:         true,
			ShareDifficulty: 1000,
			BlockTime:       10 * time.Minute,
			FeePercentage:   1.0,
		},
		ZKP: config.ZKPConfig{
			Enabled:  true,
			Protocol: "groth16",
			Curve:    "bn254",
		},
		API: config.APIConfig{
			Enabled:    true,
			ListenAddr: ":0", // Random port
		},
		Monitoring: config.MonitoringConfig{
			Enabled: true,
		},
	}
	
	// Create and start system
	system, err := core.NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)
	
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	
	// Start system
	err = system.Start(ctx)
	require.NoError(t, err)
	
	// Allow system to fully initialize
	time.Sleep(2 * time.Second)
	
	// Verify all components are running
	t.Run("SystemStatus", func(t *testing.T) {
		status := system.GetStatus()
		assert.NotNil(t, status)
		assert.Equal(t, core.StatusRunning, *status)
	})
	
	t.Run("MiningEngine", func(t *testing.T) {
		// Mining engine should be running
		metrics := system.GetMetrics()
		assert.NotNil(t, metrics)
		assert.GreaterOrEqual(t, metrics.MiningHashRate, float64(0))
	})
	
	t.Run("P2PNetwork", func(t *testing.T) {
		// P2P network should be initialized
		health := system.GetHealthStatus()
		assert.NotNil(t, health)
		
		if p2pHealth, ok := health.Components["p2p_network"]; ok {
			assert.True(t, p2pHealth.Healthy)
		}
	})
	
	t.Run("ZKPSystem", func(t *testing.T) {
		// ZKP system should be ready
		health := system.GetHealthStatus()
		if zkpHealth, ok := health.Components["zkp_system"]; ok {
			assert.True(t, zkpHealth.Healthy)
		}
	})
	
	// Stop system
	err = system.Stop(ctx)
	assert.NoError(t, err)
}

// TestIntegrationMiningWorkflow tests complete mining workflow
func TestIntegrationMiningWorkflow(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	
	logger := zaptest.NewLogger(t)
	
	// Create mining engine
	miningConfig := &mining.Config{
		Algorithm:    "sha256d",
		HardwareType: mining.HardwareCPU,
		MaxWorkers:   2,
		Difficulty:   100,
	}
	
	engine := mining.NewUnifiedEngine(logger, miningConfig)
	require.NotNil(t, engine)
	
	// Start engine
	err := engine.Start()
	require.NoError(t, err)
	defer engine.Stop()
	
	// Submit a job
	job := &mining.Job{
		ID:        "integration_job_1",
		Height:    1000,
		PrevHash:  make([]byte, 32),
		Target:    make([]byte, 32),
		Timestamp: time.Now().Unix(),
	}
	
	err = engine.SubmitJob(job)
	assert.NoError(t, err)
	
	// Wait for mining to start
	time.Sleep(500 * time.Millisecond)
	
	// Check stats
	stats := engine.GetStats()
	assert.NotNil(t, stats)
	assert.Equal(t, uint64(1), stats.JobsReceived)
	assert.True(t, stats.CurrentHashRate > 0)
	
	// Submit a share
	share := &mining.Share{
		JobID:     job.ID,
		Nonce:     12345,
		NTime:     uint32(time.Now().Unix()),
		WorkerID:  "integration_worker",
		Timestamp: time.Now(),
	}
	
	valid, err := engine.ValidateShare(share)
	assert.NoError(t, err)
	// Validation result depends on actual computation
	_ = valid
	
	// Final stats check
	finalStats := engine.GetStats()
	assert.Equal(t, uint64(1), finalStats.SharesSubmitted)
}

// TestIntegrationP2PNetworkCommunication tests P2P network communication
func TestIntegrationP2PNetworkCommunication(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	
	logger := zaptest.NewLogger(t)
	
	// Create two P2P networks
	config1 := &p2p.Config{
		Port:           0, // Random port
		MaxPeers:       10,
		DDoSProtection: true,
	}
	
	config2 := &p2p.Config{
		Port:           0, // Random port
		MaxPeers:       10,
		DDoSProtection: true,
	}
	
	network1, err := p2p.NewNetwork(logger, config1)
	require.NoError(t, err)
	
	network2, err := p2p.NewNetwork(logger, config2)
	require.NoError(t, err)
	
	// Start both networks
	err = network1.Start()
	require.NoError(t, err)
	defer network1.Stop()
	
	err = network2.Start()
	require.NoError(t, err)
	defer network2.Stop()
	
	// Allow networks to initialize
	time.Sleep(500 * time.Millisecond)
	
	// Get actual addresses
	p2p1 := network1.(*p2p.UnifiedP2PNetwork)
	p2p2 := network2.(*p2p.UnifiedP2PNetwork)
	
	addr1 := p2p1.listener.Addr().String()
	addr2 := p2p2.listener.Addr().String()
	
	// Connect networks
	config1.BootstrapNodes = []string{addr2}
	err = p2p1.connectBootstrap()
	assert.NoError(t, err)
	
	// Wait for connection
	time.Sleep(1 * time.Second)
	
	// Check peers
	peers1 := network1.GetPeers(10)
	assert.Greater(t, len(peers1), 0)
	
	// Test message broadcast
	testMsg := p2p.Message{
		Type: p2p.MessageTypeBlock,
		Data: []byte("integration test block"),
	}
	
	err = network1.Broadcast(testMsg)
	assert.NoError(t, err)
	
	// Check stats
	stats1 := network1.GetStats()
	assert.Greater(t, stats1.TotalMessages.Load(), uint64(0))
}

// TestIntegrationLoadTesting tests system under load
func TestIntegrationLoadTesting(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	
	logger := zaptest.NewLogger(t)
	
	// Create system with minimal configuration
	cfg := &config.Config{
		Mode:    "miner",
		Version: "test",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      4,
			Intensity:    80,
		},
		Network: config.NetworkConfig{
			ListenAddr: ":0",
			MaxPeers:   50,
		},
	}
	
	system, err := core.NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)
	
	ctx := context.Background()
	
	// Start system
	err = system.Start(ctx)
	require.NoError(t, err)
	defer system.Stop(ctx)
	
	// Allow system to stabilize
	time.Sleep(1 * time.Second)
	
	// Simulate load
	done := make(chan bool)
	workers := 10
	operations := 100
	
	// Concurrent metric reads
	for i := 0; i < workers; i++ {
		go func() {
			defer func() { done <- true }()
			
			for j := 0; j < operations; j++ {
				system.GetMetrics()
				system.GetHealthStatus()
				time.Sleep(10 * time.Millisecond)
			}
		}()
	}
	
	// Wait for completion
	for i := 0; i < workers; i++ {
		<-done
	}
	
	// System should still be healthy
	health := system.GetHealthStatus()
	assert.Equal(t, "healthy", health.Overall)
}

// TestIntegrationErrorRecovery tests system recovery from errors
func TestIntegrationErrorRecovery(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	
	logger := zaptest.NewLogger(t)
	
	// Create system
	cfg := &config.Config{
		Mode:    "auto",
		Version: "test",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      2,
		},
	}
	
	system, err := core.NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)
	
	ctx := context.Background()
	
	// Start system
	err = system.Start(ctx)
	require.NoError(t, err)
	
	// Simulate component failure by stopping and restarting
	err = system.Stop(ctx)
	assert.NoError(t, err)
	
	// Restart system
	err = system.Start(ctx)
	assert.NoError(t, err)
	
	// System should recover
	time.Sleep(1 * time.Second)
	
	health := system.GetHealthStatus()
	assert.Equal(t, "healthy", health.Overall)
	
	// Clean shutdown
	err = system.Stop(ctx)
	assert.NoError(t, err)
}

// BenchmarkIntegrationSystemOperations benchmarks integrated operations
func BenchmarkIntegrationSystemOperations(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	cfg := &config.Config{
		Mode:    "miner",
		Version: "bench",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      2,
		},
	}
	
	system, err := core.NewOtedamaSystem(cfg, logger)
	require.NoError(b, err)
	
	ctx := context.Background()
	err = system.Start(ctx)
	require.NoError(b, err)
	defer system.Stop(ctx)
	
	// Allow system to stabilize
	time.Sleep(500 * time.Millisecond)
	
	b.Run("GetMetrics", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			system.GetMetrics()
		}
	})
	
	b.Run("GetHealthStatus", func(b *testing.B) {
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			system.GetHealthStatus()
		}
	})
}