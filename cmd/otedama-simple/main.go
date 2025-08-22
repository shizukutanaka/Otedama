package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/mining"
	"go.uber.org/zap"
)

func main() {
	// Initialize logger
	logger, err := zap.NewProduction()
	if err != nil {
		log.Fatal("Failed to initialize logger:", err)
	}
	defer logger.Sync()

	// Load configuration
	cfg, err := config.Load("config.yaml")
	if err != nil {
		logger.Fatal("Failed to load config", zap.Error(err))
	}

	// Initialize mining engine
	engine := mining.NewEngine()
	
	// Start mining if configured
	if cfg.Mining.AutoStart {
		logger.Info("Starting mining engine")
		if err := engine.Start(); err != nil {
			logger.Error("Failed to start mining", zap.Error(err))
		} else {
			logger.Info("Mining started successfully")
		}
	}

	// Wait for interrupt signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	
	fmt.Println("Otedama P2P Mining Pool is running. Press Ctrl+C to stop.")
	<-sigChan
	
	logger.Info("Shutting down...")
	engine.Stop()
	logger.Info("Shutdown complete")
}