// +build integration

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/pool"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestMiningWithStratumServer(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Start stratum server
	serverConfig := config.StratumConfig{
		ListenAddr:     "127.0.0.1:13333",
		Difficulty:     1.0,
		MinDifficulty:  0.001,
		MaxDifficulty:  1000.0,
		VarDiffWindow:  30,
		TargetTime:     10,
	}
	
	server, err := stratum.NewServer(logger, serverConfig)
	require.NoError(t, err)
	
	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()
	
	// Give server time to start
	time.Sleep(100 * time.Millisecond)
	
	// Create mining engine
	miningConfig := config.MiningConfig{
		Algorithm: "sha256d",
		Threads:   2,
		Intensity: 10,
	}
	
	engine, err := mining.NewEngine(logger, miningConfig)
	require.NoError(t, err)
	
	err = engine.Start()
	require.NoError(t, err)
	defer engine.Stop()
	
	// Create stratum client
	poolConfig := config.PoolConfig{
		URL:           "stratum+tcp://127.0.0.1:13333",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		WorkerName:    "test-worker",
		Password:      "x",
	}
	
	client, err := stratum.NewClient(logger, poolConfig)
	require.NoError(t, err)
	
	err = client.Connect()
	require.NoError(t, err)
	defer client.Disconnect()
	
	// Set stratum client on engine
	engine.SetStratumClient(client)
	
	// Broadcast a test job
	testJob := &stratum.Job{
		ID:           "test-job-1",
		PrevHash:     "0000000000000000000000000000000000000000000000000000000000000000",
		CoinBase1:    "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
		CoinBase2:    "ffffffff",
		MerkleBranch: []string{},
		Version:      "00000002",
		NBits:        "1d00ffff",
		NTime:        "5c2b3f40",
		Difficulty:   1.0,
		CreatedAt:    time.Now(),
	}
	
	server.BroadcastJob(testJob, true)
	
	// Wait for client to receive job
	time.Sleep(500 * time.Millisecond)
	
	// Check that client received the job
	currentJob := client.GetCurrentJob()
	assert.NotNil(t, currentJob)
	assert.Equal(t, testJob.ID, currentJob.ID)
	
	// Let mining run for a bit
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	
	nonceChan := make(chan uint64, 1)
	go engine.Mine(ctx, &mining.Job{
		ID:     currentJob.ID,
		Target: "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		Data:   make([]byte, 80),
	}, nonceChan)
	
	select {
	case <-nonceChan:
		// Found a nonce
		t.Log("Found valid nonce")
	case <-ctx.Done():
		// Timeout expected for difficult target
		t.Log("Mining timeout (expected)")
	}
	
	// Check hash rate
	hashRate := engine.GetHashRate()
	assert.Greater(t, hashRate, uint64(0))
}

func TestPoolManagerIntegration(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Create pool manager
	poolConfig := config.PoolConfig{
		Name:          "TestPool",
		FeePercent:    1.0,
		PayoutScheme:  "PPLNS",
		MinPayout:     0.001,
		PayoutInterval: 24 * time.Hour,
	}
	
	poolManager, err := pool.NewManager(logger, poolConfig)
	require.NoError(t, err)
	
	err = poolManager.Start()
	require.NoError(t, err)
	defer poolManager.Stop()
	
	// Register a worker
	workerID := "test-worker-1"
	walletAddr := "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
	
	err = poolManager.RegisterWorker(workerID, walletAddr)
	assert.NoError(t, err)
	
	// Submit shares
	for i := 0; i < 10; i++ {
		share := &pool.Share{
			WorkerID:   workerID,
			JobID:      "job-1",
			Nonce:      uint64(i),
			Difficulty: 1.0,
			Timestamp:  time.Now(),
		}
		
		valid, err := poolManager.SubmitShare(share)
		assert.NoError(t, err)
		assert.True(t, valid)
	}
	
	// Get worker stats
	stats, err := poolManager.GetWorkerStats(workerID)
	assert.NoError(t, err)
	assert.NotNil(t, stats)
	assert.Equal(t, uint64(10), stats.SharesAccepted)
	
	// Calculate rewards
	blockReward := 6.25
	rewards := poolManager.CalculateRewards(blockReward)
	assert.NotEmpty(t, rewards)
	assert.Contains(t, rewards, workerID)
	assert.Greater(t, rewards[workerID], 0.0)
}

func TestMiningEngineMultiAlgorithm(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	algorithms := []string{"sha256d", "scrypt", "ethash"}
	
	for _, algo := range algorithms {
		t.Run(algo, func(t *testing.T) {
			config := config.MiningConfig{
				Algorithm: algo,
				Threads:   1,
				Intensity: 5,
			}
			
			engine, err := mining.NewEngine(logger, config)
			require.NoError(t, err)
			
			err = engine.Start()
			require.NoError(t, err)
			
			// Test hashing
			data := []byte("test data for hashing")
			hash := engine.Hash(data)
			assert.NotNil(t, hash)
			assert.NotEmpty(t, hash)
			
			// Test mining
			job := &mining.Job{
				ID:         "test-job",
				Target:     "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
				Data:       make([]byte, 80),
				NonceStart: 0,
				NonceEnd:   1000,
			}
			
			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()
			
			nonceChan := make(chan uint64, 1)
			go engine.Mine(ctx, job, nonceChan)
			
			select {
			case nonce := <-nonceChan:
				t.Logf("Found nonce: %d", nonce)
			case <-ctx.Done():
				t.Log("Mining timeout")
			}
			
			err = engine.Stop()
			assert.NoError(t, err)
		})
	}
}

func TestWorkerLifecycle(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	// Start stratum server
	serverConfig := config.StratumConfig{
		ListenAddr: "127.0.0.1:13334",
		Difficulty: 1.0,
	}
	
	server, err := stratum.NewServer(logger, serverConfig)
	require.NoError(t, err)
	
	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()
	
	// Connect multiple workers
	numWorkers := 5
	clients := make([]*stratum.Client, numWorkers)
	engines := make([]mining.Engine, numWorkers)
	
	for i := 0; i < numWorkers; i++ {
		// Create mining engine
		miningConfig := config.MiningConfig{
			Algorithm: "sha256d",
			Threads:   1,
			Intensity: 5,
		}
		
		engine, err := mining.NewEngine(logger, miningConfig)
		require.NoError(t, err)
		
		err = engine.Start()
		require.NoError(t, err)
		engines[i] = engine
		
		// Create stratum client
		poolConfig := config.PoolConfig{
			URL:           "stratum+tcp://127.0.0.1:13334",
			WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
			WorkerName:    fmt.Sprintf("worker-%d", i),
			Password:      "x",
		}
		
		client, err := stratum.NewClient(logger, poolConfig)
		require.NoError(t, err)
		
		err = client.Connect()
		require.NoError(t, err)
		clients[i] = client
		
		engine.SetStratumClient(client)
	}
	
	// Broadcast job to all workers
	testJob := &stratum.Job{
		ID:           "multi-worker-job",
		PrevHash:     "0000000000000000000000000000000000000000000000000000000000000000",
		CoinBase1:    "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
		CoinBase2:    "ffffffff",
		MerkleBranch: []string{},
		Version:      "00000002",
		NBits:        "1d00ffff",
		NTime:        "5c2b3f40",
		Difficulty:   1.0,
		CreatedAt:    time.Now(),
	}
	
	server.BroadcastJob(testJob, true)
	
	// Let workers mine
	time.Sleep(2 * time.Second)
	
	// Disconnect workers one by one
	for i := 0; i < numWorkers; i++ {
		clients[i].Disconnect()
		err = engines[i].Stop()
		assert.NoError(t, err)
		
		// Check server stats after each disconnection
		// Server should handle disconnections gracefully
		time.Sleep(100 * time.Millisecond)
	}
}

func TestShareValidation(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	logger := zap.NewNop()
	
	poolConfig := config.PoolConfig{
		Name:       "TestPool",
		FeePercent: 1.0,
	}
	
	poolManager, err := pool.NewManager(logger, poolConfig)
	require.NoError(t, err)
	
	err = poolManager.Start()
	require.NoError(t, err)
	defer poolManager.Stop()
	
	// Register worker
	workerID := "validation-worker"
	walletAddr := "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
	
	err = poolManager.RegisterWorker(workerID, walletAddr)
	require.NoError(t, err)
	
	// Test valid share
	validShare := &pool.Share{
		WorkerID:   workerID,
		JobID:      "job-1",
		Nonce:      12345,
		Hash:       "0000000000000000000000000000000000000000000000000000000000000001",
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}
	
	valid, err := poolManager.SubmitShare(validShare)
	assert.NoError(t, err)
	assert.True(t, valid)
	
	// Test duplicate share (should be rejected)
	dupShare := &pool.Share{
		WorkerID:   workerID,
		JobID:      "job-1",
		Nonce:      12345, // Same nonce
		Hash:       "0000000000000000000000000000000000000000000000000000000000000001",
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}
	
	valid, err = poolManager.SubmitShare(dupShare)
	assert.NoError(t, err)
	assert.False(t, valid)
	
	// Test stale share (old job)
	staleShare := &pool.Share{
		WorkerID:   workerID,
		JobID:      "old-job",
		Nonce:      54321,
		Hash:       "0000000000000000000000000000000000000000000000000000000000000002",
		Difficulty: 1.0,
		Timestamp:  time.Now().Add(-10 * time.Minute),
	}
	
	valid, err = poolManager.SubmitShare(staleShare)
	assert.NoError(t, err)
	assert.False(t, valid)
	
	// Check worker stats
	stats, err := poolManager.GetWorkerStats(workerID)
	assert.NoError(t, err)
	assert.Equal(t, uint64(1), stats.SharesAccepted)
	assert.Equal(t, uint64(1), stats.SharesRejected) // Duplicate
	assert.Equal(t, uint64(1), stats.SharesStale)    // Stale
}