package scenarios

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/core"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/p2p"
	"github.com/shizukutanaka/Otedama/internal/zkp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// TestFullMiningWorkflow tests the complete mining workflow from start to finish
func TestFullMiningWorkflow(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping E2E test in short mode")
	}

	logger := zaptest.NewLogger(t)
	
	// Create test configuration
	cfg := &config.Config{
		Mode:    "pool",
		Version: "3.0.0-test",
		Name:    "test-pool",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      2,
			Intensity:    50,
			AutoTuning:   true,
		},
		Network: config.NetworkConfig{
			ListenAddr:   ":0", // Auto-assign port
			MaxPeers:     10,
			EnableP2P:    true,
			DialTimeout:  5 * time.Second,
		},
		P2PPool: config.P2PPoolConfig{
			Enabled:         true,
			ShareDifficulty: 100.0,
			BlockTime:       1 * time.Minute,
			PayoutThreshold: 0.001,
			FeePercentage:   1.0,
		},
		ZKP: config.ZKPConfig{
			Enabled:               true,
			Protocol:              "groth16",
			Curve:                 "bn254",
			RequireHashpowerProof: true,
			MinHashpowerRequirement: 1000,
			ProofCacheSize:        100,
		},
		API: config.APIConfig{
			Enabled:    true,
			ListenAddr: ":0",
		},
		Dashboard: config.DashboardConfig{
			Enabled:    true,
			ListenAddr: ":0",
		},
		Storage: config.StorageConfig{
			DataDir:   t.TempDir(),
			CacheSize: 10000,
		},
	}

	// Create and start the Otedama system
	system, err := core.NewOtedamaSystem(cfg, logger)
	require.NoError(t, err, "Failed to create Otedama system")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Start the system
	err = system.Start(ctx)
	require.NoError(t, err, "Failed to start Otedama system")
	defer system.Stop(ctx)

	// Wait for system to initialize
	time.Sleep(2 * time.Second)

	// Run the complete workflow
	t.Run("system_health_check", func(t *testing.T) {
		health := system.GetHealthStatus()
		assert.NotNil(t, health)
		assert.NotEqual(t, "error", health.Overall)
		assert.Greater(t, health.Score, float64(50))
		
		// Check critical components
		for _, component := range []string{"mining_engine", "zkp_system", "p2p_network"} {
			comp, exists := health.Components[component]
			assert.True(t, exists, "Component %s should exist", component)
			if exists {
				assert.True(t, comp.Healthy, "Component %s should be healthy", component)
			}
		}
	})

	t.Run("zkp_proof_generation", func(t *testing.T) {
		// Generate hashpower proof
		zkpSystem := system.GetZKPSystem()
		require.NotNil(t, zkpSystem)

		claim := &zkp.ProofClaim{
			Type:      zkp.ProofTypeHashpower,
			Value:     10000, // 10 KH/s
			Threshold: 1000,  // 1 KH/s minimum
		}

		proof, err := zkpSystem.GenerateProof(ctx, claim)
		assert.NoError(t, err)
		assert.NotNil(t, proof)

		// Verify the proof
		valid, err := zkpSystem.VerifyProof(ctx, proof)
		assert.NoError(t, err)
		assert.True(t, valid)
	})

	t.Run("p2p_peer_connection", func(t *testing.T) {
		p2pPool := system.GetP2PPool()
		require.NotNil(t, p2pPool)

		// Create a test peer
		peer := &p2p.Peer{
			ID:      "test-peer-1",
			Address: "/ip4/127.0.0.1/tcp/30304",
			Version: "3.0.0",
			Capabilities: []string{"mining", "zkp"},
			ZKPProof: &p2p.ZKPProof{
				Type:      "hashpower",
				ProofData: []byte("test-proof"),
				Verified:  true,
			},
			ConnectedAt: time.Now(),
		}

		err := p2pPool.AddPeer(peer)
		assert.NoError(t, err)

		// Verify peer was added
		assert.Equal(t, 1, p2pPool.GetPeerCount())
		
		retrievedPeer, exists := p2pPool.GetPeer("test-peer-1")
		assert.True(t, exists)
		assert.Equal(t, peer.ID, retrievedPeer.ID)
	})

	t.Run("mining_job_submission", func(t *testing.T) {
		miningEngine := system.GetMiningEngine()
		require.NotNil(t, miningEngine)

		// Submit a mining job
		job := &mining.MiningJob{
			ID:         "test-job-1",
			Algorithm:  mining.AlgorithmSHA256d,
			Data:       []byte("test block header data"),
			Target:     "00000000ffff0000000000000000000000000000000000000000000000000000",
			Difficulty: 100.0,
			Height:     12345,
			Timestamp:  time.Now(),
		}

		err := miningEngine.SubmitJob(job)
		assert.NoError(t, err)

		// Wait for mining to process
		time.Sleep(500 * time.Millisecond)

		// Check mining stats
		stats := miningEngine.GetStats()
		assert.True(t, stats.IsRunning)
		assert.Greater(t, stats.HashRate, uint64(0))
	})

	t.Run("share_submission_workflow", func(t *testing.T) {
		p2pPool := system.GetP2PPool()
		require.NotNil(t, p2pPool)

		// Submit a share
		share := &p2p.Share{
			ID:         "test-share-1",
			MinerID:    "test-peer-1",
			JobID:      "test-job-1",
			Nonce:      12345,
			Hash:       "0000000000000000000000000000000000000000000000000000000000001234",
			Difficulty: 150.0,
			Timestamp:  time.Now(),
			Valid:      true,
		}

		err := p2pPool.SubmitShare(share)
		assert.NoError(t, err)

		// Check share statistics
		shareStats := p2pPool.GetShareStats()
		assert.Equal(t, uint64(1), shareStats.TotalShares)
		assert.Equal(t, uint64(1), shareStats.ValidShares)

		// Check miner shares
		minerShares := p2pPool.GetMinerShares("test-peer-1")
		assert.Len(t, minerShares, 1)
	})

	t.Run("api_endpoints", func(t *testing.T) {
		// Test API endpoints are accessible
		apiServer := system.GetAPIServer()
		require.NotNil(t, apiServer)

		// The actual HTTP testing would be done here
		// For now, we just verify the server exists
	})

	t.Run("performance_metrics", func(t *testing.T) {
		metrics := system.GetMetrics()
		assert.NotNil(t, metrics)
		
		// Check basic metrics
		assert.GreaterOrEqual(t, metrics.CPUUsage, float64(0))
		assert.Greater(t, metrics.MemoryUsage, uint64(0))
		assert.Greater(t, metrics.HashRate, uint64(0))
		assert.Equal(t, 1, metrics.ConnectedPeers)
		assert.Greater(t, metrics.Uptime, time.Duration(0))

		// Check performance metrics
		perf := system.GetPerformanceMetrics()
		assert.NotNil(t, perf)
		assert.GreaterOrEqual(t, perf.CPUEfficiency, float64(0))
		assert.GreaterOrEqual(t, perf.MemoryEfficiency, float64(0))
	})

	t.Run("reward_calculation", func(t *testing.T) {
		p2pPool := system.GetP2PPool()
		require.NotNil(t, p2pPool)

		// Simulate finding a block
		blockReward := 6.25
		rewards, err := p2pPool.CalculateRewards(blockReward)
		assert.NoError(t, err)
		
		// Should have rewards for our test miner
		assert.Greater(t, len(rewards), 0)
		
		// Check fee calculation
		totalRewards := 0.0
		for _, reward := range rewards {
			totalRewards += reward.Amount
		}
		expectedTotal := blockReward * (1 - cfg.P2PPool.FeePercentage/100)
		assert.InDelta(t, expectedTotal, totalRewards, 0.0001)
	})

	t.Run("system_shutdown", func(t *testing.T) {
		// Get final stats before shutdown
		finalStats := system.GetMetrics()
		assert.Greater(t, finalStats.SharesSubmitted, uint64(0))
		assert.Greater(t, finalStats.SharesAccepted, uint64(0))
		
		// Stop the system gracefully
		err := system.Stop(ctx)
		assert.NoError(t, err)
		
		// Verify system is stopped
		status := system.GetStatus()
		assert.Equal(t, core.StatusStopped, *status)
	})
}

// TestMiningPoolFailover tests pool failover scenarios
func TestMiningPoolFailover(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping E2E test in short mode")
	}

	logger := zaptest.NewLogger(t)
	
	// Create configuration with multiple pools
	cfg := &config.Config{
		Mode:    "miner",
		Version: "3.0.0-test",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      1,
			Pools: []config.PoolConfig{
				{
					URL:      "stratum+tcp://primary.pool:3333",
					User:     "test.worker1",
					Pass:     "x",
					Priority: 1,
				},
				{
					URL:      "stratum+tcp://backup.pool:3333",
					User:     "test.worker1",
					Pass:     "x",
					Priority: 2,
					Backup:   true,
				},
			},
		},
	}

	system, err := core.NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)

	ctx := context.Background()
	err = system.Start(ctx)
	require.NoError(t, err)
	defer system.Stop(ctx)

	// Test failover logic
	t.Run("primary_pool_failure", func(t *testing.T) {
		// Simulate primary pool failure
		// The system should automatically switch to backup pool
		
		time.Sleep(2 * time.Second)
		
		// Check that mining continues
		stats := system.GetMetrics()
		assert.True(t, stats.HashRate > 0, "Mining should continue after failover")
	})
}

// TestHighLoadScenario tests the system under high load
func TestHighLoadScenario(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping E2E test in short mode")
	}

	logger := zaptest.NewLogger(t)
	
	cfg := &config.Config{
		Mode:    "pool",
		Version: "3.0.0-test",
		Mining: config.MiningConfig{
			Algorithm:    "sha256d",
			HardwareType: "cpu",
			Threads:      4,
		},
		Network: config.NetworkConfig{
			MaxPeers: 100,
		},
		P2PPool: config.P2PPoolConfig{
			Enabled:         true,
			ShareDifficulty: 10.0,
		},
	}

	system, err := core.NewOtedamaSystem(cfg, logger)
	require.NoError(t, err)

	ctx := context.Background()
	err = system.Start(ctx)
	require.NoError(t, err)
	defer system.Stop(ctx)

	// Simulate high load
	t.Run("concurrent_peer_connections", func(t *testing.T) {
		p2pPool := system.GetP2PPool()
		
		// Add many peers concurrently
		done := make(chan bool, 50)
		for i := 0; i < 50; i++ {
			go func(id int) {
				peer := &p2p.Peer{
					ID:      fmt.Sprintf("load-test-peer-%d", id),
					Address: fmt.Sprintf("/ip4/10.0.0.%d/tcp/30303", id+1),
					ZKPProof: &p2p.ZKPProof{
						Verified: true,
					},
				}
				p2pPool.AddPeer(peer)
				done <- true
			}(i)
		}

		// Wait for all peers
		for i := 0; i < 50; i++ {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("Timeout adding peers")
			}
		}

		// Verify system stability
		health := system.GetHealthStatus()
		assert.NotEqual(t, "error", health.Overall)
	})

	t.Run("high_share_submission_rate", func(t *testing.T) {
		p2pPool := system.GetP2PPool()
		
		// Submit many shares concurrently
		shareCount := 1000
		done := make(chan bool, shareCount)
		
		for i := 0; i < shareCount; i++ {
			go func(id int) {
				share := &p2p.Share{
					ID:         fmt.Sprintf("load-share-%d", id),
					MinerID:    fmt.Sprintf("load-test-peer-%d", id%50),
					JobID:      "load-test-job",
					Nonce:      uint64(id),
					Difficulty: 15.0,
					Timestamp:  time.Now(),
					Valid:      true,
				}
				p2pPool.SubmitShare(share)
				done <- true
			}(i)
		}

		// Wait for all shares
		submitted := 0
		timeout := time.After(10 * time.Second)
		for submitted < shareCount {
			select {
			case <-done:
				submitted++
			case <-timeout:
				t.Logf("Submitted %d/%d shares before timeout", submitted, shareCount)
				break
			}
		}

		// Check share statistics
		stats := p2pPool.GetShareStats()
		assert.Greater(t, stats.TotalShares, uint64(0))
		
		// System should remain healthy
		health := system.GetHealthStatus()
		assert.Greater(t, health.Score, float64(50))
	})
}