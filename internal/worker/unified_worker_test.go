package worker

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewManager(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	assert.NotNil(t, manager)
	assert.NotNil(t, manager.workers)
	assert.NotNil(t, manager.stats)
}

func TestWorkerRegistration(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register worker
	worker := &Worker{
		ID:            "worker1",
		Name:          "Test Worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Status:        StatusActive,
	}

	err := manager.RegisterWorker(worker)
	assert.NoError(t, err)

	// Get worker
	retrieved, err := manager.GetWorker("worker1")
	assert.NoError(t, err)
	assert.NotNil(t, retrieved)
	assert.Equal(t, worker.ID, retrieved.ID)
	assert.Equal(t, worker.Name, retrieved.Name)

	// Try to register duplicate
	err = manager.RegisterWorker(worker)
	assert.Error(t, err)
}

func TestWorkerUnregistration(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register worker
	worker := &Worker{
		ID:            "worker1",
		Name:          "Test Worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Status:        StatusActive,
	}

	err := manager.RegisterWorker(worker)
	require.NoError(t, err)

	// Unregister worker
	err = manager.UnregisterWorker("worker1")
	assert.NoError(t, err)

	// Try to get unregistered worker
	retrieved, err := manager.GetWorker("worker1")
	assert.Error(t, err)
	assert.Nil(t, retrieved)
}

func TestWorkerStatusUpdate(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register worker
	worker := &Worker{
		ID:            "worker1",
		Name:          "Test Worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Status:        StatusActive,
	}

	err := manager.RegisterWorker(worker)
	require.NoError(t, err)

	// Update status
	err = manager.UpdateWorkerStatus("worker1", StatusInactive)
	assert.NoError(t, err)

	// Verify update
	retrieved, err := manager.GetWorker("worker1")
	assert.NoError(t, err)
	assert.Equal(t, StatusInactive, retrieved.Status)
}

func TestWorkerStatistics(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register worker
	worker := &Worker{
		ID:            "worker1",
		Name:          "Test Worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Status:        StatusActive,
	}

	err := manager.RegisterWorker(worker)
	require.NoError(t, err)

	// Update statistics
	stats := &Statistics{
		WorkerID:       "worker1",
		HashRate:       1000000,
		SharesAccepted: 100,
		SharesRejected: 5,
		SharesStale:    2,
		LastShareTime:  time.Now(),
		Uptime:         time.Hour,
	}

	err = manager.UpdateStatistics(stats)
	assert.NoError(t, err)

	// Get statistics
	retrieved, err := manager.GetStatistics("worker1")
	assert.NoError(t, err)
	assert.NotNil(t, retrieved)
	assert.Equal(t, uint64(1000000), retrieved.HashRate)
	assert.Equal(t, uint64(100), retrieved.SharesAccepted)
}

func TestWorkerPool(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register multiple workers
	for i := 0; i < 10; i++ {
		worker := &Worker{
			ID:            fmt.Sprintf("worker%d", i),
			Name:          fmt.Sprintf("Worker %d", i),
			WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
			Status:        StatusActive,
		}
		err := manager.RegisterWorker(worker)
		require.NoError(t, err)
	}

	// Get all workers
	workers := manager.GetAllWorkers()
	assert.Len(t, workers, 10)

	// Get active workers
	activeWorkers := manager.GetActiveWorkers()
	assert.Len(t, activeWorkers, 10)

	// Update some to inactive
	for i := 0; i < 5; i++ {
		err := manager.UpdateWorkerStatus(fmt.Sprintf("worker%d", i), StatusInactive)
		require.NoError(t, err)
	}

	// Check active count
	activeWorkers = manager.GetActiveWorkers()
	assert.Len(t, activeWorkers, 5)
}

func TestWorkerHeartbeat(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register worker
	worker := &Worker{
		ID:            "worker1",
		Name:          "Test Worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Status:        StatusActive,
	}

	err := manager.RegisterWorker(worker)
	require.NoError(t, err)

	// Send heartbeat
	err = manager.Heartbeat("worker1")
	assert.NoError(t, err)

	// Get worker and check last seen
	retrieved, err := manager.GetWorker("worker1")
	assert.NoError(t, err)
	assert.WithinDuration(t, time.Now(), retrieved.LastSeen, time.Second)
}

func TestWorkerConfigUpdate(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register worker
	worker := &Worker{
		ID:            "worker1",
		Name:          "Test Worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Status:        StatusActive,
		Config: WorkerConfig{
			Threads:   4,
			Intensity: 10,
		},
	}

	err := manager.RegisterWorker(worker)
	require.NoError(t, err)

	// Update config
	newConfig := WorkerConfig{
		Threads:   8,
		Intensity: 15,
	}

	err = manager.UpdateWorkerConfig("worker1", newConfig)
	assert.NoError(t, err)

	// Verify update
	retrieved, err := manager.GetWorker("worker1")
	assert.NoError(t, err)
	assert.Equal(t, 8, retrieved.Config.Threads)
	assert.Equal(t, 15, retrieved.Config.Intensity)
}

func TestWorkerShareTracking(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register worker
	worker := &Worker{
		ID:            "worker1",
		Name:          "Test Worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Status:        StatusActive,
	}

	err := manager.RegisterWorker(worker)
	require.NoError(t, err)

	// Submit shares
	for i := 0; i < 10; i++ {
		err = manager.RecordShare("worker1", true, 1.0)
		assert.NoError(t, err)
	}

	// Submit rejected shares
	for i := 0; i < 2; i++ {
		err = manager.RecordShare("worker1", false, 1.0)
		assert.NoError(t, err)
	}

	// Get statistics
	stats, err := manager.GetStatistics("worker1")
	assert.NoError(t, err)
	assert.Equal(t, uint64(10), stats.SharesAccepted)
	assert.Equal(t, uint64(2), stats.SharesRejected)
}

func TestWorkerRewardsCalculation(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register workers
	workers := []struct {
		ID     string
		Shares uint64
	}{
		{"worker1", 100},
		{"worker2", 200},
		{"worker3", 300},
	}

	for _, w := range workers {
		worker := &Worker{
			ID:            w.ID,
			Name:          fmt.Sprintf("Worker %s", w.ID),
			WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
			Status:        StatusActive,
		}
		err := manager.RegisterWorker(worker)
		require.NoError(t, err)

		// Record shares
		for i := uint64(0); i < w.Shares; i++ {
			err = manager.RecordShare(w.ID, true, 1.0)
			require.NoError(t, err)
		}
	}

	// Calculate rewards
	totalReward := 6.25
	rewards := manager.CalculateRewards(totalReward)

	assert.Len(t, rewards, 3)
	assert.InDelta(t, 1.04166, rewards["worker1"], 0.001)
	assert.InDelta(t, 2.08333, rewards["worker2"], 0.001)
	assert.InDelta(t, 3.125, rewards["worker3"], 0.001)
}

func TestWorkerCleanup(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register workers with different last seen times
	now := time.Now()
	workers := []struct {
		ID       string
		LastSeen time.Time
	}{
		{"worker1", now},
		{"worker2", now.Add(-30 * time.Minute)},
		{"worker3", now.Add(-2 * time.Hour)},
	}

	for _, w := range workers {
		worker := &Worker{
			ID:            w.ID,
			Name:          fmt.Sprintf("Worker %s", w.ID),
			WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
			Status:        StatusActive,
			LastSeen:      w.LastSeen,
		}
		err := manager.RegisterWorker(worker)
		require.NoError(t, err)
	}

	// Clean up inactive workers (> 1 hour)
	removed := manager.CleanupInactiveWorkers(1 * time.Hour)
	assert.Equal(t, 1, removed)

	// Verify cleanup
	workers := manager.GetAllWorkers()
	assert.Len(t, workers, 2)
	
	_, err := manager.GetWorker("worker3")
	assert.Error(t, err)
}

func TestWorkerPersistence(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register workers
	for i := 0; i < 5; i++ {
		worker := &Worker{
			ID:            fmt.Sprintf("worker%d", i),
			Name:          fmt.Sprintf("Worker %d", i),
			WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
			Status:        StatusActive,
		}
		err := manager.RegisterWorker(worker)
		require.NoError(t, err)
	}

	// Export state
	state, err := manager.ExportState()
	assert.NoError(t, err)
	assert.NotNil(t, state)

	// Create new manager
	newManager := NewManager(logger)

	// Import state
	err = newManager.ImportState(state)
	assert.NoError(t, err)

	// Verify import
	workers := newManager.GetAllWorkers()
	assert.Len(t, workers, 5)
}

func TestConcurrentWorkerOperations(t *testing.T) {
	logger := zap.NewNop()
	manager := NewManager(logger)

	// Register base worker
	worker := &Worker{
		ID:            "worker1",
		Name:          "Test Worker",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Status:        StatusActive,
	}
	err := manager.RegisterWorker(worker)
	require.NoError(t, err)

	// Concurrent operations
	done := make(chan bool, 3)

	// Goroutine 1: Update statistics
	go func() {
		for i := 0; i < 100; i++ {
			manager.RecordShare("worker1", true, 1.0)
		}
		done <- true
	}()

	// Goroutine 2: Send heartbeats
	go func() {
		for i := 0; i < 100; i++ {
			manager.Heartbeat("worker1")
		}
		done <- true
	}()

	// Goroutine 3: Get statistics
	go func() {
		for i := 0; i < 100; i++ {
			manager.GetStatistics("worker1")
		}
		done <- true
	}()

	// Wait for completion
	for i := 0; i < 3; i++ {
		<-done
	}

	// Verify final state
	stats, err := manager.GetStatistics("worker1")
	assert.NoError(t, err)
	assert.Equal(t, uint64(100), stats.SharesAccepted)
}