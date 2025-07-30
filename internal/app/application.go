package app

import (
	"context"
	"fmt"
	"time"

	"github.com/shizukutanaka/Otedama/internal/cli"
	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/core"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/monitoring"
	"github.com/shizukutanaka/Otedama/internal/p2p"
	"github.com/shizukutanaka/Otedama/internal/security"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"github.com/shizukutanaka/Otedama/internal/zkp"
	"go.uber.org/zap"
)

// Constants - John Carmack's explicit constants
const (
	ShutdownTimeout = 30 * time.Second
	StartupTimeout  = 10 * time.Second
)

// Application represents the unified Otedama system - Robert C. Martin's single responsibility
type Application struct {
	ctx     context.Context
	logger  *zap.Logger
	config  *config.Config
	
	// Core components - dependency injection pattern
	engine     mining.Engine
	zkpSystem  zkp.System
	p2pNetwork p2p.Network
	stratum    stratum.Server
	monitor    monitoring.Monitor
	security   security.Manager
}

// New creates a new application instance - Rob Pike's clear constructor
func New(ctx context.Context, logger *zap.Logger, cfg *config.Config) (*Application, error) {
	app := &Application{
		ctx:    ctx,
		logger: logger,
		config: cfg,
	}
	
	if err := app.initializeComponents(); err != nil {
		return nil, fmt.Errorf("failed to initialize components: %w", err)
	}
	
	return app, nil
}

// Start starts all application components - John Carmack's error handling
func (a *Application) Start() error {
	a.logger.Info("Starting Otedama application",
		zap.String("mode", a.config.Mode),
		zap.String("algorithm", a.config.Mining.Algorithm),
		zap.Bool("zkp_enabled", a.config.ZKP.Enabled),
	)
	
	// Start components in dependency order
	components := []struct {
		name string
		fn   func() error
	}{
		{"security", a.security.Start},
		{"monitoring", a.monitor.Start},
		{"zkp_system", a.zkpSystem.Start},
		{"p2p_network", a.p2pNetwork.Start},
		{"stratum_server", a.startStratum},
		{"mining_engine", a.engine.Start},
	}
	
	for _, comp := range components {
		if err := comp.fn(); err != nil {
			return fmt.Errorf("failed to start %s: %w", comp.name, err)
		}
		a.logger.Debug("Component started", zap.String("component", comp.name))
	}
	
	a.logger.Info("All components started successfully")
	return nil
}

// Shutdown gracefully shuts down all components - circuit breaker pattern
func (a *Application) Shutdown(ctx context.Context) error {
	a.logger.Info("Shutting down application")
	
	// Shutdown in reverse order
	shutdownFns := []func() error{
		a.engine.Stop,
		a.stopStratum,
		a.p2pNetwork.Stop,
		a.zkpSystem.Stop,
		a.monitor.Stop,
		a.security.Stop,
	}
	
	for i, fn := range shutdownFns {
		if err := fn(); err != nil {
			a.logger.Error("Shutdown error", 
				zap.Int("component", i), 
				zap.Error(err),
			)
		}
	}
	
	return nil
}

// initializeComponents sets up all system components - dependency inversion
func (a *Application) initializeComponents() error {
	var err error
	
	// Initialize security manager first - security first principle
	a.security, err = security.NewManager(a.logger, &a.config.Security)
	if err != nil {
		return fmt.Errorf("failed to create security manager: %w", err)
	}
	
	// Initialize monitoring - observability
	a.monitor, err = monitoring.NewMonitor(a.logger, &a.config.Monitoring)
	if err != nil {
		return fmt.Errorf("failed to create monitor: %w", err)
	}
	
	// Initialize ZKP KYC system - privacy first
	if a.config.ZKP.Enabled {
		a.zkpSystem, err = zkp.NewSystem(a.logger, &a.config.ZKP)
		if err != nil {
			return fmt.Errorf("failed to create ZKP system: %w", err)
		}
	} else {
		a.zkpSystem = zkp.NewNoOpSystem()
	}
	
	// Initialize P2P network - decentralization
	a.p2pNetwork, err = p2p.NewNetwork(a.logger, &a.config.P2P)
	if err != nil {
		return fmt.Errorf("failed to create P2P network: %w", err)
	}
	
	// Initialize Stratum server for pool mode
	if a.config.Mode == "pool" || a.config.Mode == "auto" {
		a.stratum, err = stratum.NewServer(a.logger, &a.config.Stratum)
		if err != nil {
			return fmt.Errorf("failed to create Stratum server: %w", err)
		}
	}
	
	// Initialize mining engine - core functionality
	a.engine, err = mining.NewEngine(a.logger, &a.config.Mining)
	if err != nil {
		return fmt.Errorf("failed to create mining engine: %w", err)
	}
	
	a.logger.Debug("All components initialized")
	return nil
}

// startStratum starts Stratum server if configured
func (a *Application) startStratum() error {
	if a.stratum == nil {
		return nil // Not configured
	}
	
	// Set up callbacks - dependency inversion
	callbacks := &stratum.Callbacks{
		OnShare:  a.handleShare,
		OnGetJob: a.getNewJob,
		OnAuth:   a.authenticateWorker,
	}
	
	a.stratum.SetCallbacks(callbacks)
	return a.stratum.Start()
}

// stopStratum stops Stratum server
func (a *Application) stopStratum() error {
	if a.stratum == nil {
		return nil
	}
	return a.stratum.Stop()
}

// handleShare processes submitted shares - business logic separation
func (a *Application) handleShare(share *stratum.Share) error {
	// Authenticate with ZKP if enabled
	if a.config.ZKP.Enabled {
		if !a.zkpSystem.IsVerified(share.WorkerName) {
			return fmt.Errorf("worker not ZKP verified: %s", share.WorkerName)
		}
	}
	
	// Convert to mining share
	miningShare := &mining.Share{
		JobID:      share.JobID,
		WorkerID:   share.WorkerName,
		Nonce:      share.Nonce,
		Timestamp:  share.Timestamp,
		Difficulty: share.Difficulty,
		Hash:       share.Hash,
	}
	
	// Submit to mining engine
	return a.engine.SubmitShare(miningShare)
}

// getNewJob generates new mining job
func (a *Application) getNewJob() *stratum.Job {
	// Get job from mining engine
	miningJob := a.engine.GetCurrentJob()
	if miningJob == nil {
		return nil
	}
	
	// Convert to Stratum job
	return &stratum.Job{
		ID:           miningJob.ID,
		PrevHash:     miningJob.PrevHash,
		CoinbaseA:    miningJob.CoinbaseA,
		CoinbaseB:    miningJob.CoinbaseB,
		MerkleBranch: miningJob.MerkleBranch,
		Version:      miningJob.Version,
		NBits:        miningJob.NBits,
		NTime:        miningJob.NTime,
		CleanJobs:    miningJob.CleanJobs,
	}
}

// authenticateWorker authenticates worker with ZKP
func (a *Application) authenticateWorker(workerName, password string) error {
	if !a.config.ZKP.Enabled {
		return nil // No authentication required
	}
	
	// Verify ZKP proof in password field
	proof, err := zkp.ParseProof(password)
	if err != nil {
		return fmt.Errorf("invalid ZKP proof: %w", err)
	}
	
	// Verify the proof
	if err := a.zkpSystem.VerifyProof(workerName, proof); err != nil {
		return fmt.Errorf("ZKP verification failed: %w", err)
	}
	
	a.logger.Debug("Worker authenticated via ZKP", zap.String("worker", workerName))
	return nil
}

// GetStats returns application statistics - monitoring interface
func (a *Application) GetStats() *Stats {
	return &Stats{
		Engine:  a.engine.GetStats(),
		ZKP:     a.zkpSystem.GetStats(),
		P2P:     a.p2pNetwork.GetStats(),
		Monitor: a.monitor.GetStats(),
	}
}

// Stats aggregates system statistics
type Stats struct {
	Engine  *mining.Stats
	ZKP     *zkp.Stats
	P2P     *p2p.Stats
	Monitor *monitoring.Stats
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
		cfg.Mining.CPUThreads = flags.Threads
	}
	
	// Hardware selection
	if flags.CPUOnly {
		cfg.Mining.GPUEnabled = false
		cfg.Mining.ASICEnabled = false
	}
	if flags.GPUOnly {
		cfg.Mining.CPUEnabled = false
		cfg.Mining.ASICEnabled = false
	}
	if flags.ASICOnly {
		cfg.Mining.CPUEnabled = false
		cfg.Mining.GPUEnabled = false
	}
	
	// ZKP settings
	cfg.ZKP.Enabled = flags.ZKP
	if flags.ZKPProtocol != "" {
		cfg.ZKP.Protocol = flags.ZKPProtocol
	}
	
	// Network settings
	if flags.Port > 0 {
		cfg.P2P.Port = flags.Port
	}
	if flags.APIPort > 0 {
		cfg.API.Port = flags.APIPort
	}
	if flags.StratumPort > 0 {
		cfg.Stratum.Port = flags.StratumPort
	}
	
	// Performance settings
	cfg.Mining.AutoTune = flags.AutoTune
	cfg.Performance.HugePagesEnabled = flags.HugePages
	cfg.Performance.NUMAEnabled = flags.NUMA
	
	if flags.CPUAffinity != "" {
		cfg.Performance.CPUAffinity = flags.CPUAffinity
	}
	
	return nil
}
