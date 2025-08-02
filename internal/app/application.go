package app

import (
	"context"
	"fmt"
	"time"

	"github.com/shizukutanaka/Otedama/internal/cli"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/core"
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
}

// New creates a new application instance - Rob Pike's clear constructor
func New(ctx context.Context, logger *zap.Logger, cfg *config.Config) (*Application, error) {
	// Create the unified Otedama system
	system, err := core.NewOtedamaSystem(cfg, logger)
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
		zap.String("version", a.config.Version),
		zap.String("mode", a.config.Mode),
		zap.String("algorithm", a.config.Mining.Algorithm),
		zap.Bool("zkp_enabled", a.config.ZKP.Enabled),
		zap.Bool("national_security", a.config.Government.Enabled),
	)
	
	// Start the unified system
	if err := a.system.Start(); err != nil {
		return fmt.Errorf("failed to start system: %w", err)
	}
	
	a.logger.Info("Otedama application started successfully",
		zap.String("state", a.system.GetState().String()),
	)
	
	return nil
}

// Shutdown gracefully shuts down all components - circuit breaker pattern
func (a *Application) Shutdown(ctx context.Context) error {
	a.logger.Info("Shutting down Otedama application")
	
	// Create shutdown context with timeout
	shutdownCtx, cancel := context.WithTimeout(ctx, ShutdownTimeout)
	defer cancel()
	
	// Stop the system
	if err := a.system.Stop(); err != nil {
		a.logger.Error("System shutdown error", zap.Error(err))
		return err
	}
	
	// Ensure shutdown completes within timeout
	done := make(chan struct{})
	go func() {
		// Wait for system to fully stop
		for a.system.GetState() != core.StateStopped {
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
	return a.system.GetStats()
}

// LoadConfig loads and validates configuration - Rob Pike's error handling
func LoadConfig(configFile string, flags *cli.Flags) (*config.Config, error) {
	// Load base configuration
	cfg, err := config.Load(configFile)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}
	
	// Apply CLI flag overrides
	if err := applyFlagOverrides(cfg, flags); err != nil {
		return nil, fmt.Errorf("failed to apply flag overrides: %w", err)
	}
	
	// Set version information
	cfg.Version = "3.0.0"
	cfg.Name = "Otedama Enterprise Mining Pool"
	
	// Validate configuration
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}
	
	return cfg, nil
}

// applyFlagOverrides applies CLI flags to configuration
func applyFlagOverrides(cfg *config.Config, flags *cli.Flags) error {
	// Basic settings
	if flags.Mode != "auto" {
		cfg.Mode = flags.Mode
	}
	
	// Mining settings
	if flags.Algorithm != "auto" {
		cfg.Mining.Algorithm = flags.Algorithm
	}
	
	if flags.Threads > 0 {
		cfg.Mining.Threads = flags.Threads
	}
	
	// Hardware selection
	if flags.CPUOnly {
		cfg.Mining.GPU.Enable = false
		cfg.Mining.ASIC.Enable = false
	}
	if flags.GPUOnly {
		cfg.Mining.CPU.Enable = false
		cfg.Mining.ASIC.Enable = false
	}
	if flags.ASICOnly {
		cfg.Mining.CPU.Enable = false
		cfg.Mining.GPU.Enable = false
	}
	
	// ZKP settings
	cfg.ZKP.Enabled = flags.ZKP
	if flags.ZKPProtocol != "" {
		cfg.ZKP.Protocol = flags.ZKPProtocol
	}
	
	// Network settings
	if flags.Port > 0 {
		cfg.Network.ListenAddr = fmt.Sprintf(":%d", flags.Port)
	}
	if flags.APIPort > 0 {
		cfg.API.ListenAddr = fmt.Sprintf(":%d", flags.APIPort)
	}
	if flags.StratumPort > 0 {
		cfg.Stratum.ListenAddr = fmt.Sprintf(":%d", flags.StratumPort)
	}
	
	// Performance settings
	cfg.Mining.AutoTuning = flags.AutoTune
	cfg.Performance.Memory.HugePagesEnabled = flags.HugePages
	cfg.Performance.Memory.NUMABalancing = flags.NUMA
	
	if flags.CPUAffinity != "" {
		// Parse CPU affinity string
		cfg.Performance.CPU.Affinity = parseCPUAffinity(flags.CPUAffinity)
	}
	
	// Security settings
	if flags.NationalSecurity {
		cfg.Government.Enabled = true
		cfg.Security.HardwareSecurityModule = true
		cfg.Security.ZeroTrustEnabled = true
	}
	
	// Privacy settings
	if flags.Anonymous {
		cfg.Privacy.AnonymousMining = true
		cfg.Privacy.EnableTor = true
		cfg.Privacy.EnableI2P = true
	}
	
	// Development settings
	if flags.Debug {
		cfg.LogLevel = "debug"
		cfg.Development.Enabled = true
		cfg.Development.DebugLogging = true
	}
	
	return nil
}

// parseCPUAffinity parses CPU affinity string into integer array
func parseCPUAffinity(affinity string) []int {
	// Simple implementation - in production, parse comma-separated values
	// e.g., "0,1,2,3" -> [0,1,2,3]
	return []int{}
}
