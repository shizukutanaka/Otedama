package stratum

import (
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewClient(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.PoolConfig{
		URL:           "stratum+tcp://127.0.0.1:3333",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		WorkerName:    "test-worker",
		Password:      "x",
	}

	client, err := NewClient(logger, cfg)
	assert.NoError(t, err)
	assert.NotNil(t, client)
	assert.Equal(t, "127.0.0.1:3333", client.url)
	assert.Equal(t, "test-worker", client.workerName)
}

func TestNewServer(t *testing.T) {
	logger := zap.NewNop()
	cfg := config.StratumConfig{
		ListenAddr:     "127.0.0.1:3333",
		Difficulty:     1.0,
		MinDifficulty:  0.001,
		MaxDifficulty:  1000.0,
		VarDiffWindow:  30,
		TargetTime:     10,
	}

	server, err := NewServer(logger, cfg)
	assert.NoError(t, err)
	assert.NotNil(t, server)
	assert.Equal(t, "127.0.0.1:3333", server.listenAddr)
	assert.Equal(t, 1.0, server.difficulty)
}

func TestJobValidation(t *testing.T) {
	job := &Job{
		ID:           "job1",
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

	assert.True(t, job.IsValid())

	// Test invalid job
	invalidJob := &Job{
		ID: "",
	}
	assert.False(t, invalidJob.IsValid())
}

func TestShareValidation(t *testing.T) {
	share := &Share{
		JobID:      "job1",
		ExtraNonce: "00000001",
		NTime:      "5c2b3f40",
		Nonce:      "12345678",
		Difficulty: 1.0,
		Hash:       "0000000000000000000000000000000000000000000000000000000000000001",
	}

	assert.True(t, share.IsValid())

	// Test invalid share
	invalidShare := &Share{
		JobID: "",
	}
	assert.False(t, invalidShare.IsValid())
}

func TestMessageEncoding(t *testing.T) {
	msg := &Message{
		ID:     1,
		Method: "mining.subscribe",
		Params: []interface{}{"test-miner/1.0"},
	}

	encoded, err := msg.Encode()
	assert.NoError(t, err)
	assert.NotEmpty(t, encoded)

	// Decode and verify
	decoded := &Message{}
	err = decoded.Decode(encoded)
	assert.NoError(t, err)
	assert.Equal(t, msg.ID, decoded.ID)
	assert.Equal(t, msg.Method, decoded.Method)
}

func TestDifficultyAdjustment(t *testing.T) {
	adjuster := NewDifficultyAdjuster(1.0, 0.001, 100.0, 30, 10)

	// Test increase difficulty (fast shares)
	timestamps := make([]time.Time, 30)
	now := time.Now()
	for i := range timestamps {
		timestamps[i] = now.Add(time.Duration(-i) * time.Second)
	}
	
	newDiff := adjuster.CalculateNewDifficulty("worker1", timestamps)
	assert.Greater(t, newDiff, 1.0)

	// Test decrease difficulty (slow shares)
	for i := range timestamps {
		timestamps[i] = now.Add(time.Duration(-i*30) * time.Second)
	}
	
	newDiff = adjuster.CalculateNewDifficulty("worker2", timestamps)
	assert.Less(t, newDiff, 1.0)
}

func TestWorkerManager(t *testing.T) {
	manager := NewWorkerManager()

	// Register worker
	err := manager.RegisterWorker("worker1", "wallet1")
	assert.NoError(t, err)

	// Get worker
	worker := manager.GetWorker("worker1")
	assert.NotNil(t, worker)
	assert.Equal(t, "worker1", worker.ID)
	assert.Equal(t, "wallet1", worker.WalletAddress)

	// Update stats
	manager.UpdateWorkerStats("worker1", 1000000, time.Now())
	
	stats := manager.GetWorkerStats("worker1")
	assert.NotNil(t, stats)
	assert.Equal(t, uint64(1000000), stats.HashRate)

	// Unregister worker
	manager.UnregisterWorker("worker1")
	worker = manager.GetWorker("worker1")
	assert.Nil(t, worker)
}

func TestJobQueue(t *testing.T) {
	queue := NewJobQueue(10)

	// Add jobs
	for i := 0; i < 5; i++ {
		job := &Job{
			ID:        fmt.Sprintf("job%d", i),
			CreatedAt: time.Now(),
		}
		queue.Push(job)
	}

	assert.Equal(t, 5, queue.Len())

	// Pop jobs
	job := queue.Pop()
	assert.NotNil(t, job)
	assert.Equal(t, "job0", job.ID)

	assert.Equal(t, 4, queue.Len())

	// Clear queue
	queue.Clear()
	assert.Equal(t, 0, queue.Len())
}

func TestExtraNonceGenerator(t *testing.T) {
	generator := NewExtraNonceGenerator()

	// Generate multiple nonces
	nonces := make(map[string]bool)
	for i := 0; i < 100; i++ {
		nonce := generator.Generate()
		assert.NotEmpty(t, nonce)
		
		// Check uniqueness
		assert.False(t, nonces[nonce], "Duplicate nonce generated")
		nonces[nonce] = true
	}
}

func TestMerkleBranchCalculator(t *testing.T) {
	calculator := NewMerkleBranchCalculator()

	// Test with single transaction
	txHashes := []string{
		"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
	}
	
	branch := calculator.Calculate(txHashes)
	assert.NotNil(t, branch)
	assert.Len(t, branch, 0)

	// Test with multiple transactions
	txHashes = []string{
		"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
		"fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
		"abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		"0987654321fedcba0987654321fedcba0987654321fedcba0987654321fedcba",
	}
	
	branch = calculator.Calculate(txHashes)
	assert.NotNil(t, branch)
	assert.Greater(t, len(branch), 0)
}

func TestShareValidator(t *testing.T) {
	validator := NewShareValidator()

	share := &Share{
		JobID:      "job1",
		ExtraNonce: "00000001",
		NTime:      "5c2b3f40",
		Nonce:      "12345678",
		Difficulty: 1.0,
		Hash:       "0000000000000000000000000000000000000000000000000000000000000001",
	}

	job := &Job{
		ID:           "job1",
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

	// Test valid share
	err := validator.ValidateShare(share, job)
	assert.NoError(t, err)

	// Test invalid share (wrong job ID)
	share.JobID = "wrong-job"
	err = validator.ValidateShare(share, job)
	assert.Error(t, err)

	// Test stale share
	share.JobID = "job1"
	job.CreatedAt = time.Now().Add(-10 * time.Minute)
	err = validator.ValidateShare(share, job)
	assert.Error(t, err)
}

func TestSessionManager(t *testing.T) {
	manager := NewSessionManager(5 * time.Minute)

	// Create session
	session := manager.CreateSession("worker1", "127.0.0.1:12345")
	assert.NotNil(t, session)
	assert.Equal(t, "worker1", session.WorkerID)

	// Get session
	retrieved := manager.GetSession(session.ID)
	assert.NotNil(t, retrieved)
	assert.Equal(t, session.ID, retrieved.ID)

	// Update last seen
	manager.UpdateLastSeen(session.ID)
	
	// Remove session
	manager.RemoveSession(session.ID)
	retrieved = manager.GetSession(session.ID)
	assert.Nil(t, retrieved)
}

func TestStratumV2Support(t *testing.T) {
	logger := zap.NewNop()

	// Test V2 client
	v2Config := config.PoolConfig{
		URL:           "stratum2+tcp://127.0.0.1:3334",
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		WorkerName:    "test-worker",
		Password:      "x",
	}

	v2Client, err := NewClient(logger, v2Config)
	assert.NoError(t, err)
	assert.Equal(t, "StratumV2", v2Client.version)

	// Test V2 server
	v2ServerConfig := config.StratumConfig{
		ListenAddr:      "127.0.0.1:3334",
		Difficulty:      1.0,
		ProtocolVersion: 2,
	}

	v2Server, err := NewServer(logger, v2ServerConfig)
	assert.NoError(t, err)
	assert.Equal(t, 2, v2Server.protocolVersion)
}

func TestConnectionPooling(t *testing.T) {
	pool := NewConnectionPool(10, 30*time.Second)

	// Add connections
	for i := 0; i < 5; i++ {
		conn := &MockConnection{
			ID:      fmt.Sprintf("conn%d", i),
			Address: fmt.Sprintf("127.0.0.1:%d", 10000+i),
		}
		pool.Add(conn)
	}

	assert.Equal(t, 5, pool.Size())

	// Get connection
	conn := pool.Get("127.0.0.1:10000")
	assert.NotNil(t, conn)

	// Remove connection
	pool.Remove("127.0.0.1:10000")
	assert.Equal(t, 4, pool.Size())

	// Clear pool
	pool.Clear()
	assert.Equal(t, 0, pool.Size())
}

// MockConnection for testing
type MockConnection struct {
	ID      string
	Address string
}

func (m *MockConnection) GetID() string {
	return m.ID
}

func (m *MockConnection) GetAddress() string {
	return m.Address
}

func (m *MockConnection) Close() error {
	return nil
}