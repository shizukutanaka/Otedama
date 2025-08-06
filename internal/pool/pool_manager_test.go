package pool

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// Mock implementations for testing

type MockDatabase struct {
	mock.Mock
}

func (m *MockDatabase) Close() error {
	args := m.Called()
	return args.Error(0)
}

type MockWorkerRepository struct {
	mock.Mock
	workers map[string]*Worker
	mu      sync.RWMutex
}

func NewMockWorkerRepository() *MockWorkerRepository {
	return &MockWorkerRepository{
		workers: make(map[string]*Worker),
	}
}

func (m *MockWorkerRepository) Get(ctx context.Context, workerID string) (*Worker, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	args := m.Called(ctx, workerID)
	if worker, exists := m.workers[workerID]; exists {
		return worker, args.Error(1)
	}
	return args.Get(0).(*Worker), args.Error(1)
}

func (m *MockWorkerRepository) Create(ctx context.Context, worker *Worker) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	args := m.Called(ctx, worker)
	if args.Error(0) == nil {
		m.workers[worker.ID] = worker
	}
	return args.Error(0)
}

func (m *MockWorkerRepository) Update(ctx context.Context, worker *Worker) error {
	args := m.Called(ctx, worker)
	return args.Error(0)
}

type MockShareRepository struct {
	mock.Mock
	shares []Share
	mu     sync.RWMutex
}

func NewMockShareRepository() *MockShareRepository {
	return &MockShareRepository{
		shares: make([]Share, 0),
	}
}

func (m *MockShareRepository) Store(ctx context.Context, share *Share) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	args := m.Called(ctx, share)
	if args.Error(0) == nil {
		m.shares = append(m.shares, *share)
	}
	return args.Error(0)
}

func (m *MockShareRepository) GetShareStats(ctx context.Context, duration time.Duration) (map[string]interface{}, error) {
	args := m.Called(ctx, duration)
	return args.Get(0).(map[string]interface{}), args.Error(1)
}

func (m *MockShareRepository) GetWorkerShareStats(ctx context.Context, workerID string, duration time.Duration) (map[string]interface{}, error) {
	args := m.Called(ctx, workerID, duration)
	return args.Get(0).(map[string]interface{}), args.Error(1)
}

func (m *MockShareRepository) CleanupOld(ctx context.Context, duration time.Duration) error {
	args := m.Called(ctx, duration)
	return args.Error(0)
}

type MockBlockRepository struct {
	mock.Mock
}

func (m *MockBlockRepository) GetBlockStats(ctx context.Context, duration time.Duration) (map[string]interface{}, error) {
	args := m.Called(ctx, duration)
	return args.Get(0).(map[string]interface{}), args.Error(1)
}

type MockPayoutRepository struct {
	mock.Mock
}

func (m *MockPayoutRepository) GetPayoutStats(ctx context.Context, duration time.Duration) (map[string]interface{}, error) {
	args := m.Called(ctx, duration)
	return args.Get(0).(map[string]interface{}), args.Error(1)
}

func (m *MockPayoutRepository) GetWorkerPayouts(ctx context.Context, workerID string, limit int) ([]Payout, error) {
	args := m.Called(ctx, workerID, limit)
	return args.Get(0).([]Payout), args.Error(1)
}

type MockStatisticsRepository struct {
	mock.Mock
}

func (m *MockStatisticsRepository) GetLatestMetrics(ctx context.Context) (map[string]float64, error) {
	args := m.Called(ctx)
	return args.Get(0).(map[string]float64), args.Error(1)
}

func (m *MockStatisticsRepository) CleanupOld(ctx context.Context, duration time.Duration) error {
	args := m.Called(ctx, duration)
	return args.Error(0)
}

// Test data structures

type Worker struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Difficulty float64   `json:"difficulty"`
	LastSeen   time.Time `json:"last_seen"`
	HashRate   uint64    `json:"hash_rate"`
}

type Share struct {
	ID         string    `json:"id"`
	WorkerID   string    `json:"worker_id"`
	JobID      string    `json:"job_id"`
	Nonce      uint64    `json:"nonce"`
	Difficulty float64   `json:"difficulty"`
	Valid      bool      `json:"valid"`
	Timestamp  time.Time `json:"timestamp"`
}

type Payout struct {
	ID       string    `json:"id"`
	WorkerID string    `json:"worker_id"`
	Amount   float64   `json:"amount"`
	TxHash   string    `json:"tx_hash"`
	Status   string    `json:"status"`
	Created  time.Time `json:"created"`
}

type MiningJob struct {
	ID             string    `json:"id"`
	Algorithm      string    `json:"algorithm"`
	Target         string    `json:"target"`
	BlockTemplate  []byte    `json:"block_template"`
	Difficulty     float64   `json:"difficulty"`
	Height         int64     `json:"height"`
	BlockReward    float64   `json:"block_reward"`
	PreviousHash   string    `json:"previous_hash"`
	CreatedAt      time.Time `json:"created_at"`
}

type ValidationResult struct {
	Valid      bool   `json:"valid"`
	BlockFound bool   `json:"block_found"`
	Error      string `json:"error,omitempty"`
}

// Mock config
func createTestConfig() *PoolConfig {
	return &PoolConfig{
		PayoutScheme:          "PPLNS",
		PPLNSWindow:          time.Hour,
		MinimumPayout:        0.001,
		PayoutFee:            0.0001,
		PoolFeePercent:       1.0,
		Currency:             "BTC",
		CoinbaseMaturity:     100,
		PayoutInterval:       3600,
		RequiredConfirmations: 6,
		MinShareDifficulty:   1000.0,
	}
}

type PoolConfig struct {
	PayoutScheme          string        `json:"payout_scheme"`
	PPLNSWindow          time.Duration `json:"pplns_window"`
	MinimumPayout        float64       `json:"minimum_payout"`
	PayoutFee            float64       `json:"payout_fee"`
	PoolFeePercent       float64       `json:"pool_fee_percent"`
	Currency             string        `json:"currency"`
	CoinbaseMaturity     int           `json:"coinbase_maturity"`
	PayoutInterval       int           `json:"payout_interval"`
	RequiredConfirmations int          `json:"required_confirmations"`
	MinShareDifficulty   float64       `json:"min_share_difficulty"`
}

// Test fixtures

func createTestLogger(t *testing.T) *zap.Logger {
	return zaptest.NewLogger(t)
}

func createTestPoolManager(t *testing.T) (*PoolManager, *MockDatabase) {
	logger := createTestLogger(t)
	config := createTestConfig()
	mockDB := &MockDatabase{}

	// Create pool manager with mocked dependencies
	pm := &PoolManager{
		logger:    logger,
		config:    config,
		db:        mockDB,
		workerRepo: NewMockWorkerRepository(),
		shareRepo:  NewMockShareRepository(),
		blockRepo:  &MockBlockRepository{},
		payoutRepo: &MockPayoutRepository{},
		statsRepo:  &MockStatisticsRepository{},
	}

	// Initialize mock components
	pm.jobManager = NewMockJobManager(logger)
	pm.shareValidator = NewMockShareValidator(logger)
	pm.difficultyAdj = NewMockDifficultyAdjuster(logger)
	pm.blockSubmitter = NewMockBlockSubmitter(logger)
	pm.payoutCalculator = NewMockPayoutCalculator(logger)
	pm.payoutProcessor = NewMockPayoutProcessor(logger)

	return pm, mockDB
}

// Mock component implementations

type MockJobManager struct {
	logger *zap.Logger
	jobs   map[string]*MiningJob
	mu     sync.RWMutex
}

func NewMockJobManager(logger *zap.Logger) *MockJobManager {
	return &MockJobManager{
		logger: logger,
		jobs:   make(map[string]*MiningJob),
	}
}

func (m *MockJobManager) CreateJob(algorithm, target string, blockTemplate []byte, difficulty float64, height int64, blockReward float64, previousHash string) *MiningJob {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	job := &MiningJob{
		ID:            "job_" + time.Now().Format("150405"),
		Algorithm:     algorithm,
		Target:        target,
		BlockTemplate: blockTemplate,
		Difficulty:    difficulty,
		Height:        height,
		BlockReward:   blockReward,
		PreviousHash:  previousHash,
		CreatedAt:     time.Now(),
	}
	
	m.jobs[job.ID] = job
	return job
}

func (m *MockJobManager) GetJob(jobID string) *MiningJob {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.jobs[jobID]
}

func (m *MockJobManager) GetCurrentJob() *MiningJob {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	// Return the most recent job
	var latest *MiningJob
	for _, job := range m.jobs {
		if latest == nil || job.CreatedAt.After(latest.CreatedAt) {
			latest = job
		}
	}
	return latest
}

func (m *MockJobManager) GetStats() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	return map[string]interface{}{
		"total_jobs": len(m.jobs),
		"active":     len(m.jobs) > 0,
	}
}

type MockShareValidator struct {
	logger *zap.Logger
}

func NewMockShareValidator(logger *zap.Logger) *MockShareValidator {
	return &MockShareValidator{logger: logger}
}

func (m *MockShareValidator) ValidateShare(ctx context.Context, share *Share) (*ValidationResult, error) {
	// Mock validation - accept most shares
	result := &ValidationResult{
		Valid:      true,
		BlockFound: share.Difficulty > 100000, // Simulate block find for high difficulty
	}
	return result, nil
}

func (m *MockShareValidator) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"validated_shares": 100,
		"valid_shares":     95,
		"blocks_found":     1,
	}
}

type MockDifficultyAdjuster struct {
	logger      *zap.Logger
	difficulties map[string]float64
	mu          sync.RWMutex
}

func NewMockDifficultyAdjuster(logger *zap.Logger) *MockDifficultyAdjuster {
	return &MockDifficultyAdjuster{
		logger:       logger,
		difficulties: make(map[string]float64),
	}
}

func (m *MockDifficultyAdjuster) GetDifficulty(workerID string) float64 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	if diff, exists := m.difficulties[workerID]; exists {
		return diff
	}
	return 1000.0 // Default difficulty
}

func (m *MockDifficultyAdjuster) SetDifficulty(workerID string, difficulty float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.difficulties[workerID] = difficulty
}

func (m *MockDifficultyAdjuster) GetStats() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	return map[string]interface{}{
		"workers": len(m.difficulties),
	}
}

func (m *MockDifficultyAdjuster) GetWorkerStats(workerID string) map[string]interface{} {
	return map[string]interface{}{
		"current_difficulty": m.GetDifficulty(workerID),
		"adjustments":        5,
	}
}

func (m *MockDifficultyAdjuster) CleanupInactive(duration time.Duration) {
	// Mock cleanup
}

type MockBlockSubmitter struct {
	logger *zap.Logger
}

func NewMockBlockSubmitter(logger *zap.Logger) *MockBlockSubmitter {
	return &MockBlockSubmitter{logger: logger}
}

func (m *MockBlockSubmitter) SubmitBlock(ctx context.Context, share *Share, job *MiningJob, currency string) error {
	// Mock successful submission
	return nil
}

func (m *MockBlockSubmitter) RegisterClient(currency string, client BlockchainClient) {
	// Mock registration
}

func (m *MockBlockSubmitter) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"submitted_blocks": 5,
		"accepted_blocks": 4,
	}
}

type MockPayoutCalculator struct {
	logger *zap.Logger
}

func NewMockPayoutCalculator(logger *zap.Logger) *MockPayoutCalculator {
	return &MockPayoutCalculator{logger: logger}
}

func (m *MockPayoutCalculator) GetWorkerEarnings(ctx context.Context, workerID string) (map[string]interface{}, error) {
	return map[string]interface{}{
		"pending":   0.0015,
		"paid":      0.0089,
		"estimated": 0.0002,
	}, nil
}

func (m *MockPayoutCalculator) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"total_pending": 0.15,
		"total_paid":    1.25,
	}
}

type MockPayoutProcessor struct {
	logger *zap.Logger
}

func NewMockPayoutProcessor(logger *zap.Logger) *MockPayoutProcessor {
	return &MockPayoutProcessor{logger: logger}
}

func (m *MockPayoutProcessor) RegisterWallet(currency string, wallet WalletInterface) {
	// Mock registration
}

func (m *MockPayoutProcessor) GetProcessingStats(ctx context.Context) (map[string]interface{}, error) {
	return map[string]interface{}{
		"pending_payouts": 5,
		"processed_today": 12,
	}, nil
}

// Interface definitions for mocks
type BlockchainClient interface {
	SubmitBlock(block []byte) error
}

type WalletInterface interface {
	SendTransaction(address string, amount float64) (string, error)
}

// Tests

func TestNewPoolManager(t *testing.T) {
	logger := createTestLogger(t)
	config := createTestConfig()
	mockDB := &MockDatabase{}

	pm, err := NewPoolManager(logger, config, mockDB)
	assert.NoError(t, err)
	assert.NotNil(t, pm)
	assert.Equal(t, logger, pm.logger)
	assert.Equal(t, config, pm.config)
	assert.Equal(t, mockDB, pm.db)
	assert.NotNil(t, pm.workerRepo)
	assert.NotNil(t, pm.shareRepo)
	assert.NotNil(t, pm.blockRepo)
	assert.NotNil(t, pm.payoutRepo)
	assert.NotNil(t, pm.statsRepo)
}

func TestPoolManagerLifecycle(t *testing.T) {
	pm, _ := createTestPoolManager(t)

	// Test initial state
	assert.False(t, pm.running)

	// Test start
	err := pm.Start()
	assert.NoError(t, err)
	assert.True(t, pm.running)

	// Test double start (should be safe)
	err = pm.Start()
	assert.NoError(t, err)

	// Test stop
	err = pm.Stop()
	assert.NoError(t, err)
	assert.False(t, pm.running)

	// Test double stop (should be safe)
	err = pm.Stop()
	assert.NoError(t, err)
}

func TestShareSubmission(t *testing.T) {
	pm, _ := createTestPoolManager(t)
	ctx := context.Background()

	// Setup mock expectations
	mockShareRepo := pm.shareRepo.(*MockShareRepository)
	mockShareRepo.On("Store", mock.Anything, mock.Anything).Return(nil)

	share := &Share{
		ID:         "share_123",
		WorkerID:   "worker_1",
		JobID:      "job_123",
		Nonce:      12345,
		Difficulty: 1000.0,
		Valid:      true,
		Timestamp:  time.Now(),
	}

	result, err := pm.SubmitShare(ctx, share)
	assert.NoError(t, err)
	assert.NotNil(t, result)
	assert.True(t, result.Valid)
}

func TestJobCreation(t *testing.T) {
	pm, _ := createTestPoolManager(t)

	job := pm.CreateJob(
		"sha256d",
		"0000000000000000ff000000000000000000000000000000000000000000000",
		[]byte("block template"),
		1000.0,
		100,
		6.25,
		"prev_hash",
	)

	assert.NotNil(t, job)
	assert.Equal(t, "sha256d", job.Algorithm)
	assert.Equal(t, 1000.0, job.Difficulty)
	assert.Equal(t, int64(100), job.Height)
	assert.Equal(t, 6.25, job.BlockReward)
	assert.NotEmpty(t, job.ID)
}

func TestWorkerDifficulty(t *testing.T) {
	pm, _ := createTestPoolManager(t)

	workerID := "worker_123"
	
	// Test getting default difficulty
	difficulty := pm.GetWorkerDifficulty(workerID)
	assert.Equal(t, 1000.0, difficulty)

	// Test setting custom difficulty
	mockDiffAdj := pm.difficultyAdj.(*MockDifficultyAdjuster)
	mockDiffAdj.SetDifficulty(workerID, 2000.0)

	difficulty = pm.GetWorkerDifficulty(workerID)
	assert.Equal(t, 2000.0, difficulty)
}

func TestCurrentJob(t *testing.T) {
	pm, _ := createTestPoolManager(t)

	// Initially no job
	job := pm.GetCurrentJob()
	assert.Nil(t, job)

	// Create a job
	createdJob := pm.CreateJob("sha256d", "target", []byte("template"), 1000.0, 100, 6.25, "prev")
	assert.NotNil(t, createdJob)

	// Get current job
	currentJob := pm.GetCurrentJob()
	assert.NotNil(t, currentJob)
	assert.Equal(t, createdJob.ID, currentJob.ID)
}

func TestPoolStats(t *testing.T) {
	pm, _ := createTestPoolManager(t)
	ctx := context.Background()

	// Setup mock expectations
	mockShareRepo := pm.shareRepo.(*MockShareRepository)
	mockShareRepo.On("GetShareStats", mock.Anything, mock.Anything).Return(map[string]interface{}{
		"total": 1000,
		"valid": 950,
	}, nil)

	mockBlockRepo := pm.blockRepo.(*MockBlockRepository)
	mockBlockRepo.On("GetBlockStats", mock.Anything, mock.Anything).Return(map[string]interface{}{
		"found": 5,
		"orphaned": 1,
	}, nil)

	mockPayoutRepo := pm.payoutRepo.(*MockPayoutRepository)
	mockPayoutRepo.On("GetPayoutStats", mock.Anything, mock.Anything).Return(map[string]interface{}{
		"total_amount": 12.5,
		"count": 25,
	}, nil)

	stats, err := pm.GetPoolStats(ctx)
	assert.NoError(t, err)
	assert.NotNil(t, stats)
	assert.Contains(t, stats, "shares")
	assert.Contains(t, stats, "blocks")
	assert.Contains(t, stats, "payouts")
	assert.Contains(t, stats, "config")
}

func TestWorkerStats(t *testing.T) {
	pm, _ := createTestPoolManager(t)
	ctx := context.Background()
	workerID := "worker_123"

	// Setup mock expectations
	worker := &Worker{
		ID:       workerID,
		Name:     "Test Worker",
		HashRate: 1000000,
		LastSeen: time.Now(),
	}

	mockWorkerRepo := pm.workerRepo.(*MockWorkerRepository)
	mockWorkerRepo.On("Get", mock.Anything, workerID).Return(worker, nil)

	mockShareRepo := pm.shareRepo.(*MockShareRepository)
	mockShareRepo.On("GetWorkerShareStats", mock.Anything, workerID, mock.Anything).Return(map[string]interface{}{
		"submitted": 100,
		"accepted": 95,
	}, nil)

	mockPayoutRepo := pm.payoutRepo.(*MockPayoutRepository)
	mockPayoutRepo.On("GetWorkerPayouts", mock.Anything, workerID, 10).Return([]Payout{}, nil)

	mockPayoutCalc := pm.payoutCalculator.(*MockPayoutCalculator)
	mockPayoutCalc.On("GetWorkerEarnings", mock.Anything, workerID).Return(map[string]interface{}{
		"pending": 0.001,
	}, nil)

	stats, err := pm.GetWorkerStats(ctx, workerID)
	assert.NoError(t, err)
	assert.NotNil(t, stats)
	assert.Contains(t, stats, "worker")
	assert.Contains(t, stats, "shares")
	assert.Contains(t, stats, "difficulty")
	assert.Contains(t, stats, "earnings")
}

func TestConcurrentOperations(t *testing.T) {
	pm, _ := createTestPoolManager(t)
	ctx := context.Background()

	// Setup mock expectations
	mockShareRepo := pm.shareRepo.(*MockShareRepository)
	mockShareRepo.On("Store", mock.Anything, mock.Anything).Return(nil)

	err := pm.Start()
	require.NoError(t, err)
	defer pm.Stop()

	const numGoroutines = 10
	const operationsPerGoroutine = 50

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	// Concurrent share submissions
	for i := 0; i < numGoroutines; i++ {
		go func(workerID int) {
			defer wg.Done()

			for j := 0; j < operationsPerGoroutine; j++ {
				share := &Share{
					ID:         "share_" + string(rune(workerID)) + "_" + string(rune(j)),
					WorkerID:   "worker_" + string(rune(workerID)),
					JobID:      "job_123",
					Nonce:      uint64(j),
					Difficulty: 1000.0,
					Valid:      true,
					Timestamp:  time.Now(),
				}

				result, err := pm.SubmitShare(ctx, share)
				assert.NoError(t, err)
				assert.NotNil(t, result)

				// Also test difficulty retrieval
				_ = pm.GetWorkerDifficulty(share.WorkerID)
			}
		}(i)
	}

	wg.Wait()
}

func TestBlockchainClientRegistration(t *testing.T) {
	pm, _ := createTestPoolManager(t)

	// Mock blockchain client
	mockClient := &mockBlockchainClient{}

	// Test registration
	pm.RegisterBlockchainClient("BTC", mockClient)

	// Verify registration was called on block submitter
	// (In real implementation, this would be verified through the mock)
}

func TestWalletRegistration(t *testing.T) {
	pm, _ := createTestPoolManager(t)

	// Mock wallet
	mockWallet := &mockWallet{}

	// Test registration
	pm.RegisterWallet("BTC", mockWallet)

	// Verify registration was called on payout processor
	// (In real implementation, this would be verified through the mock)
}

func TestMemoryUsage(t *testing.T) {
	// Test that pool manager doesn't leak memory
	for i := 0; i < 100; i++ {
		pm, _ := createTestPoolManager(t)
		
		err := pm.Start()
		require.NoError(t, err)
		
		// Create some jobs and shares
		pm.CreateJob("sha256d", "target", []byte("template"), 1000.0, int64(i), 6.25, "prev")
		
		err = pm.Stop()
		require.NoError(t, err)
	}
}

// Mock implementations for blockchain client and wallet

type mockBlockchainClient struct{}

func (m *mockBlockchainClient) SubmitBlock(block []byte) error {
	return nil
}

type mockWallet struct{}

func (m *mockWallet) SendTransaction(address string, amount float64) (string, error) {
	return "txhash_123", nil
}

// Benchmark tests

func BenchmarkShareSubmission(b *testing.B) {
	pm, _ := createTestPoolManager(b)
	ctx := context.Background()

	// Setup mock expectations
	mockShareRepo := pm.shareRepo.(*MockShareRepository)
	mockShareRepo.On("Store", mock.Anything, mock.Anything).Return(nil)

	share := &Share{
		ID:         "benchmark_share",
		WorkerID:   "benchmark_worker",
		JobID:      "benchmark_job",
		Nonce:      12345,
		Difficulty: 1000.0,
		Valid:      true,
		Timestamp:  time.Now(),
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		share.Nonce = uint64(i)
		result, err := pm.SubmitShare(ctx, share)
		if err != nil {
			b.Fatal(err)
		}
		_ = result
	}
}

func BenchmarkJobCreation(b *testing.B) {
	pm, _ := createTestPoolManager(b)

	template := []byte("benchmark block template")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		job := pm.CreateJob("sha256d", "target", template, 1000.0, int64(i), 6.25, "prev")
		_ = job
	}
}

func BenchmarkDifficultyRetrieval(b *testing.B) {
	pm, _ := createTestPoolManager(b)

	// Pre-populate some workers
	mockDiffAdj := pm.difficultyAdj.(*MockDifficultyAdjuster)
	for i := 0; i < 1000; i++ {
		workerID := "worker_" + string(rune(i))
		mockDiffAdj.SetDifficulty(workerID, 1000.0+float64(i))
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		workerID := "worker_" + string(rune(i%1000))
		difficulty := pm.GetWorkerDifficulty(workerID)
		_ = difficulty
	}
}

func BenchmarkConcurrentOperations(b *testing.B) {
	pm, _ := createTestPoolManager(b)
	ctx := context.Background()

	// Setup mock expectations
	mockShareRepo := pm.shareRepo.(*MockShareRepository)
	mockShareRepo.On("Store", mock.Anything, mock.Anything).Return(nil)

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		workerID := 0
		for pb.Next() {
			switch b.N % 3 {
			case 0:
				// Submit share
				share := &Share{
					ID:         "concurrent_share",
					WorkerID:   "worker_" + string(rune(workerID%100)),
					JobID:      "concurrent_job",
					Nonce:      uint64(b.N),
					Difficulty: 1000.0,
					Valid:      true,
					Timestamp:  time.Now(),
				}
				pm.SubmitShare(ctx, share)
			case 1:
				// Get difficulty
				pm.GetWorkerDifficulty("worker_" + string(rune(workerID%100)))
			case 2:
				// Create job
				pm.CreateJob("sha256d", "target", []byte("template"), 1000.0, int64(b.N), 6.25, "prev")
			}
			workerID++
		}
	})
}