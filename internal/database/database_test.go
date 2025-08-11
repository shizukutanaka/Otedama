package database

import (
	"database/sql"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "github.com/mattn/go-sqlite3"
)

func setupTestDB(t *testing.T) *DB {
	cfg := config.DatabaseConfig{
		Type:            "sqlite3",
		DSN:             ":memory:",
		MaxConnections:  10,
		MaxIdleConns:    5,
		ConnMaxLifetime: 5 * time.Minute,
	}

	db, err := New(cfg)
	require.NoError(t, err)
	require.NotNil(t, db)

	// Run migrations
	err = db.Migrate()
	require.NoError(t, err)

	return db
}

func TestNew(t *testing.T) {
	t.Run("SQLite", func(t *testing.T) {
		cfg := config.DatabaseConfig{
			Type: "sqlite3",
			DSN:  ":memory:",
		}

		db, err := New(cfg)
		assert.NoError(t, err)
		assert.NotNil(t, db)
		assert.Equal(t, "sqlite3", db.driver)

		err = db.Close()
		assert.NoError(t, err)
	})

	t.Run("Unsupported", func(t *testing.T) {
		cfg := config.DatabaseConfig{
			Type: "unsupported",
			DSN:  "dummy",
		}

		db, err := New(cfg)
		assert.Error(t, err)
		assert.Nil(t, db)
	})
}

func TestDB_Migrate(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Check if tables exist
	tables := []string{"blocks", "shares", "workers", "payouts", "statistics"}
	
	for _, table := range tables {
		var name string
		query := "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
		err := db.QueryRow(query, table).Scan(&name)
		assert.NoError(t, err)
		assert.Equal(t, table, name)
	}
}

func TestBlockRepository_Create(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	block := &Block{
		Height:     100,
		Hash:       "0000000000000000000000000000000000000000000000000000000000000001",
		PrevHash:   "0000000000000000000000000000000000000000000000000000000000000000",
		Difficulty: 1.0,
		Nonce:      12345,
		Reward:     50.0,
		MinedBy:    "miner1",
		MinedAt:    time.Now(),
		Currency:   "BTC",
	}

	err := db.blocks.Create(block)
	assert.NoError(t, err)
	assert.NotZero(t, block.ID)
}

func TestBlockRepository_GetByHeight(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Create a block
	block := &Block{
		Height:     200,
		Hash:       "0000000000000000000000000000000000000000000000000000000000000002",
		PrevHash:   "0000000000000000000000000000000000000000000000000000000000000001",
		Difficulty: 2.0,
		Nonce:      54321,
		Reward:     25.0,
		MinedBy:    "miner2",
		MinedAt:    time.Now(),
		Currency:   "BTC",
	}

	err := db.blocks.Create(block)
	require.NoError(t, err)

	// Get by height
	retrieved, err := db.blocks.GetByHeight(200)
	assert.NoError(t, err)
	assert.NotNil(t, retrieved)
	assert.Equal(t, block.Height, retrieved.Height)
	assert.Equal(t, block.Hash, retrieved.Hash)

	// Get non-existent
	retrieved, err = db.blocks.GetByHeight(999)
	assert.NoError(t, err)
	assert.Nil(t, retrieved)
}

func TestShareRepository_Create(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	share := &Share{
		WorkerID:    "worker1",
		JobID:       "job1",
		Difficulty:  1.0,
		ShareDiff:   2.0,
		Valid:       true,
		Hash:        "hash123",
		SubmittedAt: time.Now(),
	}

	err := db.shares.Create(share)
	assert.NoError(t, err)
	assert.NotZero(t, share.ID)
}

func TestShareRepository_GetWorkerShares(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Create shares
	now := time.Now()
	shares := []*Share{
		{
			WorkerID:    "worker1",
			JobID:       "job1",
			Difficulty:  1.0,
			ShareDiff:   1.5,
			Valid:       true,
			SubmittedAt: now.Add(-30 * time.Minute),
		},
		{
			WorkerID:    "worker1",
			JobID:       "job2",
			Difficulty:  2.0,
			ShareDiff:   2.5,
			Valid:       true,
			SubmittedAt: now.Add(-10 * time.Minute),
		},
		{
			WorkerID:    "worker2",
			JobID:       "job3",
			Difficulty:  1.0,
			ShareDiff:   1.0,
			Valid:       false,
			SubmittedAt: now.Add(-5 * time.Minute),
		},
	}

	for _, share := range shares {
		err := db.shares.Create(share)
		require.NoError(t, err)
	}

	// Get worker1 shares from last hour
	since := now.Add(-1 * time.Hour)
	workerShares, err := db.shares.GetWorkerShares("worker1", since)
	assert.NoError(t, err)
	assert.Len(t, workerShares, 2)
}

func TestWorkerRepository_Create(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	worker := &Worker{
		ID:         "worker123",
		Name:       "TestWorker",
		WalletAddr: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Active:     true,
		CreatedAt:  time.Now(),
		LastSeen:   time.Now(),
	}

	err := db.workers.Create(worker)
	assert.NoError(t, err)
}

func TestWorkerRepository_GetByID(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Create worker
	worker := &Worker{
		ID:         "worker456",
		Name:       "TestWorker2",
		WalletAddr: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Active:     true,
		CreatedAt:  time.Now(),
		LastSeen:   time.Now(),
	}

	err := db.workers.Create(worker)
	require.NoError(t, err)

	// Get by ID
	retrieved, err := db.workers.GetByID("worker456")
	assert.NoError(t, err)
	assert.NotNil(t, retrieved)
	assert.Equal(t, worker.ID, retrieved.ID)
	assert.Equal(t, worker.Name, retrieved.Name)

	// Get non-existent
	retrieved, err = db.workers.GetByID("nonexistent")
	assert.NoError(t, err)
	assert.Nil(t, retrieved)
}

func TestWorkerRepository_UpdateStats(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Create worker
	worker := &Worker{
		ID:         "worker789",
		Name:       "TestWorker3",
		WalletAddr: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Active:     true,
		CreatedAt:  time.Now(),
		LastSeen:   time.Now(),
	}

	err := db.workers.Create(worker)
	require.NoError(t, err)

	// Update stats
	err = db.workers.UpdateStats("worker789", 1000000.0, 10, 1, 0)
	assert.NoError(t, err)

	// Verify update
	updated, err := db.workers.GetByID("worker789")
	assert.NoError(t, err)
	assert.Equal(t, 1000000.0, updated.HashRate)
	assert.Equal(t, int64(10), updated.SharesValid)
	assert.Equal(t, int64(1), updated.SharesStale)
}

func TestPayoutRepository_Create(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	payout := &Payout{
		WorkerID:  "worker1",
		Amount:    0.001,
		Currency:  "BTC",
		Status:    "pending",
		CreatedAt: time.Now(),
	}

	err := db.payouts.Create(payout)
	assert.NoError(t, err)
	assert.NotZero(t, payout.ID)
}

func TestPayoutRepository_GetPending(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Create payouts
	payouts := []*Payout{
		{
			WorkerID: "worker1",
			Amount:   0.001,
			Currency: "BTC",
			Status:   "pending",
		},
		{
			WorkerID: "worker2",
			Amount:   0.002,
			Currency: "BTC",
			Status:   "pending",
		},
		{
			WorkerID: "worker3",
			Amount:   0.003,
			Currency: "BTC",
			Status:   "completed",
		},
	}

	for _, payout := range payouts {
		err := db.payouts.Create(payout)
		require.NoError(t, err)
	}

	// Get pending
	pending, err := db.payouts.GetPending()
	assert.NoError(t, err)
	assert.Len(t, pending, 2)
}

func TestStatisticsRepository_Create(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	stats := &Statistics{
		Timestamp:     time.Now(),
		HashRate:      1000000000.0,
		Workers:       10,
		Difficulty:    1000.0,
		SharesValid:   100,
		SharesStale:   5,
		SharesInvalid: 2,
		BlocksFound:   1,
		TotalPayout:   0.1,
	}

	err := db.statistics.Create(stats)
	assert.NoError(t, err)
	assert.NotZero(t, stats.ID)
}

func TestStatisticsRepository_GetRecent(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Create statistics
	now := time.Now()
	for i := 0; i < 10; i++ {
		stats := &Statistics{
			Timestamp:  now.Add(time.Duration(-i) * time.Hour),
			HashRate:   float64(1000000000 * (i + 1)),
			Workers:    10 + i,
			Difficulty: 1000.0,
		}
		err := db.statistics.Create(stats)
		require.NoError(t, err)
	}

	// Get recent
	recent, err := db.statistics.GetRecent(5)
	assert.NoError(t, err)
	assert.Len(t, recent, 5)
	
	// Should be ordered by timestamp desc
	for i := 1; i < len(recent); i++ {
		assert.True(t, recent[i-1].Timestamp.After(recent[i].Timestamp))
	}
}

func TestDB_Transaction(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Start transaction
	tx, err := db.BeginTx(nil, nil)
	require.NoError(t, err)

	// Insert in transaction
	_, err = tx.Exec("INSERT INTO workers (id, name, wallet_address) VALUES (?, ?, ?)",
		"tx_worker", "TxWorker", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")
	assert.NoError(t, err)

	// Commit
	err = tx.Commit()
	assert.NoError(t, err)

	// Verify insert
	worker, err := db.workers.GetByID("tx_worker")
	assert.NoError(t, err)
	assert.NotNil(t, worker)
}

func TestDB_GetMetrics(t *testing.T) {
	db := setupTestDB(t)
	defer db.Close()

	// Execute some queries
	db.Execute("SELECT 1")
	db.Query("SELECT * FROM workers")
	
	metrics := db.GetMetrics()
	
	assert.Contains(t, metrics, "queries")
	assert.Contains(t, metrics, "transactions")
	assert.Contains(t, metrics, "errors")
	assert.Contains(t, metrics, "avg_query_time")
	assert.Contains(t, metrics, "open_connections")
}

func BenchmarkDB_Insert(b *testing.B) {
	db := setupTestDB(&testing.T{})
	defer db.Close()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		share := &Share{
			WorkerID:    "bench_worker",
			JobID:       fmt.Sprintf("job%d", i),
			Difficulty:  1.0,
			ShareDiff:   1.0,
			Valid:       true,
			SubmittedAt: time.Now(),
		}
		_ = db.shares.Create(share)
	}
}

func BenchmarkDB_Query(b *testing.B) {
	db := setupTestDB(&testing.T{})
	defer db.Close()

	// Insert some data
	for i := 0; i < 100; i++ {
		share := &Share{
			WorkerID:    "bench_worker",
			JobID:       fmt.Sprintf("job%d", i),
			Difficulty:  1.0,
			ShareDiff:   1.0,
			Valid:       true,
			SubmittedAt: time.Now(),
		}
		db.shares.Create(share)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = db.shares.GetWorkerShares("bench_worker", time.Now().Add(-1*time.Hour))
	}
}