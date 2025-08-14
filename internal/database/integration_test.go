package database

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDatabaseIntegration(t *testing.T) {
	// Skip this test in normal runs as it requires a database
	t.Skip("Skipping integration test - remove skip to run")

	// Use default configuration for testing
	config := DefaultConfig()
	config.DSN = "./test-data/test.db"

	// Initialize database
	factory, err := InitDatabase(config)
	require.NoError(t, err)
	defer factory.Close()

	// Test health check
	err = factory.HealthCheck()
	assert.NoError(t, err)

	// Test worker repository
	workerRepo := factory.GetWorkerRepository()
	
	// Create a test worker
	worker := &Worker{
		Name:         "test-worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Hashrate:     100.0,
		LastSeen:     time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}

	ctx := context.Background()
	err = workerRepo.CreateWorker(ctx, worker)
	assert.NoError(t, err)

	// Retrieve the worker
	retrievedWorker, err := workerRepo.GetWorkerByName(ctx, "test-worker")
	assert.NoError(t, err)
	assert.NotNil(t, retrievedWorker)
	assert.Equal(t, worker.Name, retrievedWorker.Name)
	assert.Equal(t, worker.WalletAddress, retrievedWorker.WalletAddress)

	// Test share repository
	shareRepo := factory.GetShareRepository()
	
	// Create a test share
	share := &Share{
		WorkerID:  retrievedWorker.ID,
		JobID:     "test-job-123",
		Nonce:     "abc123",
		Difficulty: 1000.0,
		CreatedAt:  time.Now().UTC(),
	}

	err = shareRepo.CreateShare(ctx, share)
	assert.NoError(t, err)

	// Retrieve shares by worker
	shares, err := shareRepo.GetSharesByWorker(ctx, retrievedWorker.ID)
	assert.NoError(t, err)
	assert.Len(t, shares, 1)
	assert.Equal(t, share.JobID, shares[0].JobID)

	// Test block repository
	blockRepo := factory.GetBlockRepository()
	
	// Create a test block
	block := &Block{
		Height:   1000,
		Hash:     "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
		WorkerID: &retrievedWorker.ID,
		Reward:   float64Ptr(12.5),
		Status:   "confirmed",
		CreatedAt: time.Now().UTC(),
	}

	err = blockRepo.CreateBlock(ctx, block)
	assert.NoError(t, err)

	// Retrieve block by hash
	retrievedBlock, err := blockRepo.GetBlockByHash(ctx, block.Hash)
	assert.NoError(t, err)
	assert.NotNil(t, retrievedBlock)
	assert.Equal(t, block.Height, retrievedBlock.Height)
	assert.Equal(t, block.Hash, retrievedBlock.Hash)

	// Test payout repository
	payoutRepo := factory.GetPayoutRepository()
	
	// Create a test payout
	payout := &Payout{
		WorkerID:  retrievedWorker.ID,
		Amount:    0.001,
		TxID:      stringPtr("tx-12345"),
		Status:    "pending",
		CreatedAt: time.Now().UTC(),
	}

	err = payoutRepo.CreatePayout(ctx, payout)
	assert.NoError(t, err)

	// Retrieve payouts by worker
	payouts, err := payoutRepo.GetPayoutsByWorker(ctx, retrievedWorker.ID)
	assert.NoError(t, err)
	assert.Len(t, payouts, 1)
	assert.Equal(t, payout.Amount, payouts[0].Amount)
}

// Helper functions for pointer creation
func float64Ptr(f float64) *float64 {
	return &f
}

func stringPtr(s string) *string {
	return &s
}
