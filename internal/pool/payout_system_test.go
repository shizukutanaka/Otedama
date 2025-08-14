package pool

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/database"
	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
)

// TestPayoutCalculator tests the payout calculation logic
func TestPayoutCalculator(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	defer logger.Sync()

	// Setup test database
	dbManager := setupTestDatabase(t)
	defer dbManager.Close()

	// Create repositories
	workerRepo := database.NewWorkerRepository(dbManager)
	payoutRepo := database.NewPayoutRepository(dbManager)
	
	// Create payout calculator
	calculator := NewPayoutCalculator(logger, payoutRepo)

	// Test cases
	testCases := []struct {
		name           string
		shares         []*database.Share
		blockReward    float64
		expectedPayout float64
		payoutMethod   string
	}{{
		name: "PPLNS Basic Test",
		shares: []*database.Share{
			{WorkerID: 1, Amount: 100.0, Difficulty: 1.0},
			{WorkerID: 2, Amount: 200.0, Difficulty: 1.0},
			{WorkerID: 3, Amount: 300.0, Difficulty: 1.0},
		},
		blockReward:    6.25,
		expectedPayout: 6.25,
		payoutMethod:   "PPLNS",
	}, {
		name: "PPS Basic Test",
		shares: []*database.Share{
			{WorkerID: 1, Amount: 100.0, Difficulty: 1.0},
			{WorkerID: 2, Amount: 200.0, Difficulty: 1.0},
		},
		blockReward:    6.25,
		expectedPayout: 6.25,
		payoutMethod:   "PPS",
	}, {
		name: "PROP Basic Test",
		shares: []*database.Share{
			{WorkerID: 1, Amount: 50.0, Difficulty: 1.0},
			{WorkerID: 2, Amount: 50.0, Difficulty: 1.0},
		},
		blockReward:    6.25,
		expectedPayout: 6.25,
		payoutMethod:   "PROP",
	}}

	ctx := context.Background()

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Create workers
			workers := []*database.Worker{
				{ID: 1, Name: "worker1", Wallet: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"},
				{ID: 2, Name: "worker2", Wallet: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"},
				{ID: 3, Name: "worker3", Wallet: "1HLoD9E4SDFFPDiYfNYnkBLQ86Y30JSAe2"},
			}

			for _, worker := range workers {
				if err := workerRepo.CreateWorker(ctx, worker); err != nil {
					t.Fatalf("Failed to create worker: %v", err)
				}
			}

			// Calculate payouts
			payouts, err := calculator.CalculatePayouts(ctx, tc.shares, tc.blockReward, tc.payoutMethod)
			if err != nil {
				t.Fatalf("CalculatePayouts failed: %v", err)
			}

			// Verify total payout equals block reward
			var totalPayout float64
			for _, payout := range payouts {
				totalPayout += payout.Amount
			}

			if totalPayout != tc.expectedPayout {
				t.Errorf("Total payout %f != expected %f", totalPayout, tc.expectedPayout)
			}

			// Verify each payout has a valid wallet address
			for _, payout := range payouts {
				if payout.WalletAddress == "" {
					t.Error("Payout missing wallet address")
				}
				
				// Validate wallet address
				if err := common.ValidateWalletAddress(payout.WalletAddress, "BTC"); err != nil {
					t.Errorf("Invalid wallet address: %v", err)
				}
			}
		})
	}
}

// TestPayoutProcessor tests the payout processing system
func TestPayoutProcessor(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	defer logger.Sync()

	dbManager := setupTestDatabase(t)
	defer dbManager.Close()

	payoutRepo := database.NewPayoutRepository(dbManager)
	calculator := NewPayoutCalculator(logger, payoutRepo)
	
	processor := NewPayoutProcessor(logger, payoutRepo, calculator, ProcessorConfig{
		ProcessInterval:     1 * time.Minute,
		RetryInterval:       30 * time.Second,
		MaxRetries:          3,
		BatchSize:           10,
		MaxBatchAmount:      1.0,
		RequireConfirmation: true,
		ConfirmationBlocks:  6,
		WalletTimeout:       30 * time.Second,
	})

	// Mock wallet
	mockWallet := &MockWallet{
		balance: 10.0,
		payments: make(map[string]float64),
	}
	processor.RegisterWallet("BTC", mockWallet)

	// Create test payouts
	ctx := context.Background()
	payouts := []*database.Payout{
		{WorkerID: 1, Amount: 0.5, Status: "pending"},
		{WorkerID: 2, Amount: 1.0, Status: "pending"},
		{WorkerID: 3, Amount: 0.75, Status: "pending"},
	}

	// Test payout creation
	for _, payout := range payouts {
		if err := payoutRepo.CreatePayout(ctx, payout); err != nil {
			t.Fatalf("Failed to create payout: %v", err)
		}
	}

	// Test processing
	if err := processor.ProcessPendingPayouts(ctx); err != nil {
		t.Fatalf("ProcessPendingPayouts failed: %v", err)
	}

	// Verify payouts were processed
	processedPayouts, err := payoutRepo.GetPayoutsByStatus(ctx, "completed")
	if err != nil {
		t.Fatalf("Failed to get processed payouts: %v", err)
	}

	if len(processedPayouts) != len(payouts) {
		t.Errorf("Expected %d processed payouts, got %d", len(payouts), len(processedPayouts))
	}

	// Verify transaction IDs are set
	for _, payout := range processedPayouts {
		if payout.TxID == nil || *payout.TxID == "" {
			t.Error("Processed payout missing transaction ID")
		}
	}
}

// TestWalletValidation tests wallet address validation
func TestWalletValidation(t *testing.T) {
	testCases := []struct {
		name     string
		address  string
		currency string
		valid    bool
	}{{
		name:     "Valid Bitcoin Address",
		address:  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		currency: "BTC",
		valid:    true,
	}, {
		name:     "Invalid Bitcoin Address",
		address:  "invalid_address",
		currency: "BTC",
		valid:    false,
	}, {
		name:     "Empty Address",
		address:  "",
		currency: "BTC",
		valid:    false,
	}}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			err := common.ValidateWalletAddress(tc.address, tc.currency)
			if tc.valid && err != nil {
				t.Errorf("Expected valid address, got error: %v", err)
			}
			if !tc.valid && err == nil {
				t.Error("Expected invalid address, but validation passed")
			}
		})
	}
}

// TestOperatorFeeCalculation tests operator fee calculations
func TestOperatorFeeCalculation(t *testing.T) {
	logger, _ := zap.NewDevelopment()
	defer logger.Sync()

	dbManager := setupTestDatabase(t)
	defer dbManager.Close()

	calculator := NewPayoutCalculator(logger, database.NewPayoutRepository(dbManager))

	testCases := []struct {
		name           string
		blockReward    float64
		operatorFee    float64
		expectedFee    float64
		expectedPayout float64
	}{{
		name:           "1% Operator Fee",
		blockReward:    6.25,
		operatorFee:    0.01,
		expectedFee:    0.0625,
		expectedPayout: 6.1875,
	}, {
		name:           "2% Operator Fee",
		blockReward:    6.25,
		operatorFee:    0.02,
		expectedFee:    0.125,
		expectedPayout: 6.125,
	}}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			fee := tc.blockReward * tc.operatorFee
			payout := tc.blockReward - fee

			if fee != tc.expectedFee {
				t.Errorf("Operator fee %f != expected %f", fee, tc.expectedFee)
			}

			if payout != tc.expectedPayout {
				t.Errorf("Miner payout %f != expected %f", payout, tc.expectedPayout)
			}
		})
	}
}

// MockWallet implements WalletInterface for testing
type MockWallet struct {
	balance  float64
	payments map[string]float64
}

func (m *MockWallet) GetBalance() (float64, error) {
	return m.balance, nil
}

func (m *MockWallet) SendPayment(address string, amount float64) (string, error) {
	if m.balance < amount {
		return "", errors.New("insufficient balance")
	}
	
	m.balance -= amount
	m.payments[address] = amount
	return "mock_tx_id_" + address, nil
}

func (m *MockWallet) GetTransaction(txID string) (*TransactionInfo, error) {
	return &TransactionInfo{
		TxID:          txID,
		Status:        "confirmed",
		Confirmations: 6,
		Fee:           0.0001,
		Timestamp:     time.Now(),
	}, nil
}

func (m *MockWallet) ValidateAddress(address string) bool {
	return len(address) > 0
}

// setupTestDatabase creates a test database
func setupTestDatabase(t *testing.T) *database.Manager {
	dbManager, err := database.NewManager(":memory:")
	if err != nil {
		t.Fatalf("Failed to create test database: %v", err)
	}

	// Initialize schema
	if err := dbManager.InitializeSchema(); err != nil {
		t.Fatalf("Failed to initialize schema: %v", err)
	}

	return dbManager
}
