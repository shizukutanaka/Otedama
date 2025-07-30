package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/shizukutanaka/Otedama/internal/app"
	"github.com/shizukutanaka/Otedama/internal/cli"
	"go.uber.org/zap"
)

// Application metadata
const (
	AppName        = "Otedama"
	AppVersion     = "2.0.0"
	AppBuild       = "2025.01.30"
	AppDescription = "Enterprise-grade P2P Mining Pool with Zero-Knowledge Proof Authentication"
)

func main() {
	// Parse CLI flags and initialize logger - Rob Pike's simplicity
	flags := cli.ParseFlags()
	logger := initLogger(flags.LogLevel)
	defer logger.Sync()

	// Handle utility commands first - single responsibility
	if handleUtilityCommands(flags, logger) {
		return
	}

	// Create and run application - John Carmack's performance focus
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := runApplication(ctx, flags, logger); err != nil {
		logger.Fatal("Application failed", zap.Error(err))
	}
}

// initLogger creates optimized logger - Robert C. Martin's interface segregation
func initLogger(level string) *zap.Logger {
	logger, err := cli.InitLogger(level)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to initialize logger: %v\n", err)
		os.Exit(1)
	}
	return logger
}

// handleUtilityCommands processes one-shot commands - single responsibility principle
func handleUtilityCommands(flags *cli.Flags, logger *zap.Logger) bool {
	handler := cli.NewUtilityHandler(logger, AppName, AppVersion, AppBuild, AppDescription)
	
	switch {
	case flags.Version:
		handler.ShowVersion()
		return true
	case flags.Init:
		handler.GenerateConfig(flags.ConfigFile)
		return true
	case flags.GenKeys:
		handler.GenerateKeys()
		return true
	case flags.Health:
		return handler.HealthCheck(flags)
	case flags.Stats:
		return handler.ShowStats(flags)
	case flags.Benchmark:
		return handler.RunBenchmark(flags)
	}
	
	return false
}

// runApplication creates and runs the main application - dependency inversion
func runApplication(ctx context.Context, flags *cli.Flags, logger *zap.Logger) error {
	// Load configuration
	config, err := app.LoadConfig(flags.ConfigFile, flags)
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	// Create application - John Carmack's unified engine approach
	application, err := app.New(ctx, logger, config)
	if err != nil {
		return fmt.Errorf("failed to create application: %w", err)
	}

	// Start application
	if err := application.Start(); err != nil {
		return fmt.Errorf("failed to start application: %w", err)
	}

	// Wait for shutdown
	<-ctx.Done()
	logger.Info("Received shutdown signal")

	// Graceful shutdown - error recovery pattern
	shutdownCtx, cancel := context.WithTimeout(context.Background(), app.ShutdownTimeout)
	defer cancel()

	if err := application.Shutdown(shutdownCtx); err != nil {
		logger.Error("Shutdown error", zap.Error(err))
		return err
	}

	logger.Info("Shutdown complete")
	return nil
}
