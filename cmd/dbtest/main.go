package main

import (
	"log"
	"time"

	"github.com/shizukutanaka/Otedama/internal/database"
)

func main() {
	log.Println("Starting Otedama Database Test...")

	// Use default configuration
	config := database.DefaultConfig()
	log.Printf("Using database: %s", config.DSN)

	// Create database service
	log.Println("Initializing database service...")
	service, err := database.NewService(config)
	if err != nil {
		log.Fatalf("Failed to create database service: %v", err)
	}
	defer service.Close()

	// Initialize database
	log.Println("Initializing database...")
	if err := service.Initialize(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}

	// Perform health check
	log.Println("Performing health check...")
	if err := service.HealthCheck(); err != nil {
		log.Fatalf("Database health check failed: %v", err)
	}
	log.Println("Database health check passed!")

	// Get database stats
	log.Println("Getting database stats...")
	stats, err := service.GetStats()
	if err != nil {
		log.Printf("Failed to get database stats: %v", err)
	} else {
		log.Printf("Database stats: %+v", stats)
	}

	// Test worker repository
	log.Println("Testing worker repository...")
	workerRepo := service.GetWorkerRepository()

	// Create a test worker
	worker := &database.Worker{
		Name:         "test-worker-" + time.Now().Format("20060102150405"),
		WalletAddress: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
		Hashrate:     100.0,
		LastSeen:     time.Now().UTC(),
		CreatedAt:    time.Now().UTC(),
	}

	// Create worker
	if err := workerRepo.CreateWorker(nil, worker); err != nil {
		log.Printf("Failed to create worker: %v", err)
	} else {
		log.Printf("Created worker: %s", worker.Name)
	}

	log.Println("Database test completed successfully!")
}
