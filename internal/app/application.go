package app

import (
	"context"
	"fmt"
	"time"

	"github.com/shizukutanaka/Otedama/internal/api"
	"github.com/shizukutanaka/Otedama/internal/cli"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/core"
	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// Constants - John Carmack's explicit constants
const (
	ShutdownTimeout = 30 * time.Second
	StartupTimeout  = 10 * time.Second
)

// Application represents the unified Otedama system - Robert C. Martin's single responsibility
type Application struct {
	ctx    context.Context
	logger *zap.Logger
	config *config.Config
	system *core.OtedamaSystem
	apiServer *api.Server
}

// New creates a new application instance - Rob Pike's clear constructor
func New(ctx context.Context, logger *zap.Logger, cfg *config.Config) (*Application, error) {
	// Initialize database if pool is enabled
	var db *database.DB
	var err error
	
	if cfg.Pool.Enabled {
		db, err = InitializeDatabase(cfg, logger)
		if err != nil {
			return nil, fmt.Errorf("failed to initialize database: %w", err)
		}
	}
	
	// Create the unified Otedama system
	system, err := core.NewOtedamaSystem(cfg, logger, db)
	if err != nil {
		return nil, fmt.Errorf("failed to create Otedama system: %w", err)
	}
	
	app := &Application{
		ctx:    ctx,
		logger: logger,
		config: cfg,
		system: system,
	}
	
	return app, nil
}

// Start starts all application components - John Carmack's error handling
func (a *Application) Start() error {
	a.logger.Info("Starting Otedama application",
		zap.String("algorithm", a.config.Mining.Algorithm),
		zap.Int("cpu_threads", a.config.Mining.CPUThreads),
		zap.Bool("gpu_enabled", a.config.Mining.GPUEnabled),
	)
	
	// Start the unified system
	if err := a.system.Start(); err != nil {
		return fmt.Errorf("failed to start system: %w", err)
	}

	// Start API server with injected engine and pool manager
	if a.config.API.Enabled {
		srv, err := api.NewServer(
			convertAPIConfig(a.config.API),
			a.logger,
			a.system.GetMiningEngine(),
			a.system.GetPoolManager(),
		)
		if err != nil {
			return fmt.Errorf("failed to create API server: %w", err)
		}
		if err := srv.Start(a.ctx); err != nil {
			return fmt.Errorf("failed to start API server: %w", err)
		}
		a.apiServer = srv
	}
	
	a.logger.Info("Otedama application started successfully",
		zap.String("state", a.system.GetState()),
	)
	
	return nil
}

// Shutdown gracefully shuts down all components - circuit breaker pattern
func (a *Application) Shutdown(ctx context.Context) error {
	a.logger.Info("Shutting down Otedama application")
	
	// Create shutdown context with timeout
	shutdownCtx, cancel := context.WithTimeout(ctx, ShutdownTimeout)
	defer cancel()
	
	// Stop API server first to stop accepting new requests
	if a.apiServer != nil {
		if err := a.apiServer.Shutdown(shutdownCtx); err != nil {
			a.logger.Warn("API server shutdown error", zap.Error(err))
		}
	}

	// Stop the system
	if err := a.system.Stop(); err != nil {
		a.logger.Error("System shutdown error", zap.Error(err))
		return err
	}
	
	// Ensure shutdown completes within timeout
	done := make(chan struct{})
	go func() {
		// Wait for system to fully stop
		for a.system.GetState() != "stopped" {
			time.Sleep(100 * time.Millisecond)
		}
		close(done)
	}()
	
	select {
	case <-done:
		a.logger.Info("Application shutdown complete")
		return nil
	case <-shutdownCtx.Done():
		return fmt.Errorf("shutdown timeout exceeded")
	}
}

// GetStats returns application statistics - monitoring interface
func (a *Application) GetStats() map[string]interface{} {
	stats := a.system.GetStats()
	if statsMap, ok := stats.(map[string]interface{}); ok {
		return statsMap
	}
	return make(map[string]interface{})
}

// LoadConfig loads and validates configuration - Rob Pike's error handling
func LoadConfig(configFile string, flags *cli.Flags) (*config.Config, error) {
	// Create a logger for config loading
	tempLogger, _ := zap.NewProduction()
	defer tempLogger.Sync()
	
	// Load base configuration
	manager, err := config.NewManager(tempLogger, configFile)
	if err != nil {
		return nil, fmt.Errorf("failed to create config manager: %w", err)
	}
	cfg := manager.Get()
	
	// Apply CLI flag overrides
	if err := applyFlagOverrides(cfg, flags); err != nil {
		return nil, fmt.Errorf("failed to apply flag overrides: %w", err)
	}
	
	// Validate configuration using the validator
	validator := config.NewValidator()
	if err := validator.Validate(cfg); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}
	
	return cfg, nil
}

// applyFlagOverrides applies CLI flags to configuration
func applyFlagOverrides(cfg *config.Config, flags *cli.Flags) error {
	// Basic settings are already handled by the config manager
	
	// Mining settings
	if flags.Algorithm != "auto" {
		cfg.Mining.Algorithm = flags.Algorithm
	}
	
	if flags.Threads > 0 {
		cfg.Mining.CPUThreads = flags.Threads
	}
	
	// Hardware selection
	if flags.CPUOnly {
		cfg.Mining.GPUEnabled = false
	}
	if flags.GPUOnly {
		cfg.Mining.CPUThreads = 0 // Disable CPU mining
	}
	
	// Additional flags handled elsewhere
	
	// Network settings
	if flags.Port > 0 {
		cfg.Network.P2P.ListenAddr = fmt.Sprintf(":%d", flags.Port)
	}
	if flags.APIPort > 0 {
		cfg.API.ListenAddr = fmt.Sprintf(":%d", flags.APIPort)
	}
	if flags.StratumPort > 0 {
		cfg.Network.Stratum.ListenAddr = fmt.Sprintf(":%d", flags.StratumPort)
	}
	
	// Performance settings are handled elsewhere
	// Most of the performance flags reference fields that don't exist in the current config structure
	
	// Security settings
	// National security features not in current config structure
	/*if flags.NationalSecurity {
		cfg.Government.Enabled = true
		cfg.Security.HardwareSecurityModule = true
		cfg.Security.ZeroTrustEnabled = true
	}*/
	
	// Privacy settings
	/*if flags.Anonymous {
		cfg.Privacy.AnonymousMining = true
		cfg.Privacy.EnableTor = true
		cfg.Privacy.EnableI2P = true
	}*/
	
	// Development settings
	/*if flags.Debug {
		cfg.LogLevel = "debug"
		cfg.Development.Enabled = true
		cfg.Development.DebugLogging = true
	}*/
	
	return nil
}

// parseCPUAffinity parses CPU affinity string into integer array
func parseCPUAffinity(affinity string) []int {
	// Simple implementation - in production, parse comma-separated values
	// e.g., "0,1,2,3" -> [0,1,2,3]
	return []int{}
}

// convertAPIConfig maps top-level config.APIConfig into api.Config expected by the API server
func convertAPIConfig(src config.APIConfig) api.Config {
    return api.Config{
        Enabled:      src.Enabled,
        ListenAddr:   src.ListenAddr,
        EnableTLS:    src.TLSEnabled,
        CertFile:     src.TLSCert,
        KeyFile:      src.TLSKey,
        RateLimit:    src.RateLimit,
        AllowOrigins: src.AllowOrigins,
        // Auth and TOTP-related fields will use env/default fallbacks in api.NewServer
    }
}
