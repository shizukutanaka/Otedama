package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/otedama/otedama/internal/app"
	"github.com/otedama/otedama/internal/cli"
	"go.uber.org/zap"
)

// Application metadata - Rob Pike's simplicity principle
const (
	AppName        = "Otedama"
	AppVersion     = "3.0.0"
	AppBuild       = "2025.08.02"
	AppDescription = "Professional P2P Mining Pool Software"
)

func main() {
	// John Carmack's performance focus - optimize from start
	runtime.GOMAXPROCS(runtime.NumCPU())
	
	// Parse CLI flags and initialize logger - Rob Pike's clear interfaces
	flags := cli.ParseFlags()
	logger := initLogger(flags.LogLevel)
	defer func() {
		_ = logger.Sync() // Handle errors gracefully
	}()

	// Robert C. Martin's single responsibility - handle utility commands separately
	if handleUtilityCommands(flags, logger) {
		return
	}

	// Create application context with timeout - defensive programming
	ctx, cancel := createApplicationContext()
	defer cancel()

	// Run main application - John Carmack's unified engine approach
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

// createApplicationContext creates context with proper cancellation - defensive design
func createApplicationContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Handle signals gracefully
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	
	go func() {
		<-c
		cancel()
	}()
	
	return ctx, cancel
}

// handleUtilityCommands processes one-shot commands - Robert C. Martin's single responsibility
func handleUtilityCommands(flags *cli.Flags, logger *zap.Logger) bool {
	handler := cli.NewUtilityHandler(logger, AppName, AppVersion, AppBuild, AppDescription)
	
	switch {
	case flags.Version:
		handler.ShowVersion()
		return true
	case flags.Init:
		return handler.GenerateConfig(flags.ConfigFile)
	case flags.GenKeys:
		return handler.GenerateKeys()
	case flags.Health:
		return handler.HealthCheck(flags)
	case flags.Stats:
		return handler.ShowStats(flags)
	case flags.Benchmark:
		return handler.RunBenchmark(flags)
	case flags.Diagnose:
		return handler.RunDiagnostics(flags)
	case flags.Validate:
		return handler.ValidateConfig(flags.ConfigFile)
	}
	
	return false
}

// runApplication creates and runs the main application - John Carmack's performance-first design
func runApplication(ctx context.Context, flags *cli.Flags, logger *zap.Logger) error {
	// Load and validate configuration - fail fast principle
	config, err := app.LoadConfig(flags.ConfigFile, flags)
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}

	// Create application with dependency injection - Robert C. Martin's dependency inversion
	application, err := app.New(ctx, logger, config)
	if err != nil {
		return fmt.Errorf("failed to create application: %w", err)
	}

	// Start application services - John Carmack's engine initialization pattern
	logger.Info("Starting Otedama", 
		zap.String("version", AppVersion),
		zap.String("build", AppBuild),
		zap.Int("cpu_cores", runtime.NumCPU()),
		zap.String("go_version", runtime.Version()),
	)
	
	if err := application.Start(); err != nil {
		return fmt.Errorf("failed to start application: %w", err)
	}

	// Main application loop - wait for shutdown
	<-ctx.Done()
	logger.Info("Received shutdown signal")

	// Graceful shutdown with timeout - robust error handling
	return performGracefulShutdown(application, logger)
}

// performGracefulShutdown handles application shutdown - defensive programming
func performGracefulShutdown(app *app.Application, logger *zap.Logger) error {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	shutdownComplete := make(chan error, 1)
	
	// Perform shutdown in separate goroutine to respect timeout
	go func() {
		shutdownComplete <- app.Shutdown(shutdownCtx)
	}()

	select {
	case err := <-shutdownComplete:
		if err != nil {
			logger.Error("Shutdown error", zap.Error(err))
			return err
		}
		logger.Info("Shutdown complete")
		return nil
	case <-shutdownCtx.Done():
		logger.Error("Shutdown timeout exceeded")
		return fmt.Errorf("shutdown timeout exceeded")
	}
}
