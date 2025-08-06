package core

import (
	"context"
	"encoding/hex"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

// TestEngineCreation tests basic engine creation
func TestEngineCreation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &Config{}
	config.Mining.Algorithm = "sha256d"
	config.Mining.Threads = 2

	engine, err := NewOtedamaSystem(config, logger)
	require.NoError(t, err)
	require.NotNil(t, engine)

	assert.Equal(t, "sha256d", engine.miner.algorithm)
	assert.Equal(t, 2, engine.miner.threads)
}

// TestEngineLifecycle tests engine start/stop
func TestEngineLifecycle(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &Config{}
	config.Mining.Algorithm = "sha256d"
	config.Mining.Threads = 1
	config.API.Enabled = false // Disable API for test

	engine, err := NewOtedamaSystem(config, logger)
	require.NoError(t, err)

	// Start engine
	err = engine.Start()
	assert.NoError(t, err)
	assert.NotEqual(t, StateStopped, engine.GetState())

	// Allow initialization
	time.Sleep(100 * time.Millisecond)

	// Stop engine
	err = engine.Stop()
	assert.NoError(t, err)
	assert.Equal(t, StateStopped, engine.GetState())
}

// TestMinerHashing tests basic mining functionality
func TestMinerHashing(t *testing.T) {
	miner := &Miner{
		algorithm: "sha256d",
		threads:   1,
	}

	job := &Job{
		ID:    "test-job-1",
		Data:  []byte("test block header"),
		Nonce: []byte{0x00, 0x00, 0x00, 0x01},
	}

	ctx := context.Background()
	share, err := miner.Mine(ctx, job)
	require.NoError(t, err)
	require.NotNil(t, share)

	assert.Equal(t, job.ID, share.JobID)
	assert.NotEmpty(t, share.Hash)
	assert.NotEmpty(t, share.Nonce)

	// Verify hash format (should be hex)
	_, err = hex.DecodeString(share.Hash)
	assert.NoError(t, err)
}

// TestStatsTracking tests statistics tracking
func TestStatsTracking(t *testing.T) {
	stats := &Stats{
		StartTime: time.Now(),
	}

	// Add accepted shares
	for i := 0; i < 10; i++ {
		stats.AddShare(true)
	}

	// Add rejected shares
	for i := 0; i < 3; i++ {
		stats.AddShare(false)
	}

	assert.Equal(t, uint64(13), stats.TotalShares)
	assert.Equal(t, uint64(10), stats.AcceptedShares)
	assert.Equal(t, uint64(3), stats.RejectedShares)
}

// TestPoolClientShareSubmission tests pool client functionality
func TestPoolClientShareSubmission(t *testing.T) {
	client := &PoolClient{
		url:  "pool.example.com:3333",
		user: "testuser.worker1",
		pass: "x",
	}

	share := &Share{
		JobID: "job-123",
		Nonce: "00000001",
		Hash:  "abcdef1234567890",
		Time:  time.Now(),
	}

	// We can't test actual network connection in unit test
	// Just verify the structure is correct
	assert.Equal(t, "pool.example.com:3333", client.url)
	assert.Equal(t, "testuser.worker1", client.user)
	assert.NotNil(t, share)
}

// TestGetStats tests stats retrieval
func TestGetStats(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &Config{}
	config.Mining.Algorithm = "sha256d"

	engine, err := NewOtedamaSystem(config, logger)
	require.NoError(t, err)

	// Add some stats
	engine.stats.TotalShares = 100
	engine.stats.AcceptedShares = 95
	engine.stats.Hashrate = 1000000

	stats := engine.GetStats()
	statsMap, ok := stats.(map[string]interface{})
	require.True(t, ok)

	assert.Contains(t, statsMap, "total_shares")
	assert.Contains(t, statsMap, "accepted_shares")
	assert.Contains(t, statsMap, "hashrate")
}

// TestConcurrentShareSubmission tests concurrent share submission
func TestConcurrentShareSubmission(t *testing.T) {
	stats := &Stats{
		StartTime: time.Now(),
	}

	// Simulate concurrent share submissions
	done := make(chan bool)
	workers := 10
	sharesPerWorker := 100

	for i := 0; i < workers; i++ {
		go func() {
			for j := 0; j < sharesPerWorker; j++ {
				stats.AddShare(j%10 != 0) // 90% accepted
			}
			done <- true
		}()
	}

	// Wait for all workers
	for i := 0; i < workers; i++ {
		<-done
	}

	expectedTotal := uint64(workers * sharesPerWorker)
	expectedAccepted := uint64(workers * sharesPerWorker * 9 / 10)
	expectedRejected := expectedTotal - expectedAccepted

	assert.Equal(t, expectedTotal, stats.TotalShares)
	assert.Equal(t, expectedAccepted, stats.AcceptedShares)
	assert.Equal(t, expectedRejected, stats.RejectedShares)
}

// BenchmarkMining benchmarks mining performance
func BenchmarkMining(b *testing.B) {
	miner := &Miner{
		algorithm: "sha256d",
		threads:   1,
	}

	job := &Job{
		ID:    "bench-job",
		Data:  []byte("benchmark block header"),
		Nonce: []byte{0x00, 0x00, 0x00, 0x00},
	}

	ctx := context.Background()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		job.Nonce[3] = byte(i & 0xFF)
		miner.Mine(ctx, job)
	}
}

// BenchmarkStatsUpdate benchmarks stats update performance
func BenchmarkStatsUpdate(b *testing.B) {
	stats := &Stats{
		StartTime: time.Now(),
	}

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			stats.AddShare(true)
		}
	})
}