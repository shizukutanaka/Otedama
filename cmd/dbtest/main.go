//go:build ignore
package main

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"os"
	"time"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/database"
	"github.com/otedama/otedama/internal/models"
	"go.uber.org/zap"
)

func main() {
	log.Println("Starting Otedama Database Test...")

	cfg := &config.Config{
		Database: config.DatabaseConfig{
			Type: "postgres",
			DSN:  getEnv("TEST_DB_DSN", "host=localhost port=5432 user=otedama password=otedama dbname=otedama_test sslmode=disable"),
		},
	}
	log.Printf("Using database: %s", cfg.Database.DSN)

	logger, _ := zap.NewDevelopment()

	log.Println("Initializing database...")
	db, err := database.NewDB(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	if err := database.Migrate(db, "sqlite3"); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}
	log.Println("Database initialized and migrations run successfully")

	if err := db.Ping(); err != nil {
		log.Fatalf("Database health check failed: %v", err)
	}
	log.Println("Database health check passed")

	ctx := context.Background()

	// Run tests for each repository
	workerID, err := testWorkerRepo(ctx, db)
	if err != nil {
		log.Fatalf("Worker repository test failed: %v", err)
	}

	if err := testShareRepo(ctx, db, workerID); err != nil {
		log.Fatalf("Share repository test failed: %v", err)
	}

	if err := testPayoutRepo(ctx, db, logger, workerID); err != nil {
		log.Fatalf("Payout repository test failed: %v", err)
	}

	if err := testFeeRepo(ctx, db, logger); err != nil {
		log.Fatalf("Fee repository test failed: %v", err)
	}


	log.Println("Database test completed successfully!")
}

func testWorkerRepo(ctx context.Context, db *database.DB) (int64, error) {
	log.Println("--- Testing Worker Repository ---")
	workerRepo := database.NewWorkerRepository(db)

	worker := &models.Worker{
		Name:          "test-worker-" + time.Now().Format("20060102150405"),
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Hashrate:      100.0,
		LastSeen:      time.Now().UTC(),
		CreatedAt:     time.Now().UTC(),
	}

	if err := workerRepo.CreateWorker(ctx, worker); err != nil {
		return 0, fmt.Errorf("failed to create worker: %w", err)
	}
	log.Printf("Created worker: %s (ID: %d)", worker.Name, worker.ID)
	log.Println("--- Worker Repository Test Complete ---")
	return worker.ID, nil
}

func testShareRepo(ctx context.Context, db *database.DB, workerID int64) error {
	log.Println("--- Testing Share Repository ---")
	shareRepo := database.NewShareRepository(db.DB)

	log.Println("Creating shares...")
	for i := 0; i < 5; i++ {
		share := &models.Share{
			WorkerID:   workerID,
			JobID:      fmt.Sprintf("job-%d", i),
			Nonce:      int64(1000 + i),
			Difficulty: 10.0,
			CreatedAt:  time.Now().UTC().Add(-time.Duration(i) * time.Minute),
			IsValid:    true,
		}
		if err := shareRepo.CreateShare(ctx, share); err != nil {
			return fmt.Errorf("failed to create share: %w", err)
		}
	}
	log.Println("Shares created successfully.")

	log.Println("Testing GetSharesByTimeRange...")
	startTime := time.Now().UTC().Add(-10 * time.Minute)
	endTime := time.Now().UTC()
	shares, err := shareRepo.GetSharesByTimeRange(ctx, startTime, endTime)
	if err != nil {
		return fmt.Errorf("failed to get shares by time range: %w", err)
	}
	log.Printf("Found %d shares in the last 10 minutes.", len(shares))
	log.Println("--- Share Repository Test Complete ---")
	return nil
}

func testPayoutRepo(ctx context.Context, db *database.DB, logger *zap.Logger, workerID int64) error {
	log.Println("--- Testing Payout Repository ---")
	payoutRepo := database.NewPayoutRepository(db, logger)

	log.Println("Creating payouts...")
	for i := 0; i < 3; i++ {
		payout := &models.Payout{
			WorkerID:  workerID,
			Amount:    1.5 * float64(i+1),
			Status:    "completed",
			CreatedAt: time.Now().UTC().Add(-time.Duration(i) * time.Hour),
		}
		if err := payoutRepo.CreatePayout(ctx, payout); err != nil {
			return fmt.Errorf("failed to create payout: %w", err)
		}
	}
	log.Println("Payouts created successfully.")

	log.Println("Testing GetPayoutsByTimeRange...")
	startTime := time.Now().UTC().Add(-24 * time.Hour)
	endTime := time.Now().UTC()
	payouts, err := payoutRepo.GetPayoutsByTimeRange(ctx, startTime, endTime)
	if err != nil {
		return fmt.Errorf("failed to get payouts by time range: %w", err)
	}
	log.Printf("Found %d payouts in the last 24 hours.", len(payouts))
	log.Println("--- Payout Repository Test Complete ---")
	return nil
}

func testFeeRepo(ctx context.Context, db *database.DB, logger *zap.Logger) error {
	log.Println("--- Testing Fee Distribution Repository ---")
	feeRepo := database.NewFeeDistributionRepository(db, logger)

	feeDist := &models.FeeDistribution{
		Currency:       "BTC",
		BlockHeight:    800000,
		TotalFees:      big.NewInt(100000000),
		OperatorFee:    big.NewInt(10000000),
		DevelopmentFee: big.NewInt(5000000),
		ReserveFee:     big.NewInt(5000000),
		Status:         "completed",
		CreatedAt:      time.Now().UTC(),
	}

	if err := feeRepo.CreateFeeDistribution(ctx, feeDist); err != nil {
		return fmt.Errorf("failed to create fee distribution: %w", err)
	}
	log.Println("Fee distribution created successfully.")

	log.Println("Testing GetDistributionHistory...")
	history, err := feeRepo.GetDistributionHistory(ctx, "BTC", 10)
	if err != nil {
		return fmt.Errorf("failed to get fee distribution history: %w", err)
	}
	log.Printf("Found %d records in fee distribution history for BTC.", len(history))
	log.Println("--- Fee Distribution Repository Test Complete ---")
	return nil
}

func getEnv(key, fallback string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return fallback
}
