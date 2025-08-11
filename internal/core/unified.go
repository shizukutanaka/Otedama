package core

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/p2p"
	"github.com/shizukutanaka/Otedama/internal/pool"
	"github.com/shizukutanaka/Otedama/internal/stratum"
	"go.uber.org/zap"
)

// OtedamaSystem represents the complete mining system
// Following Robert C. Martin's clean architecture principles
type OtedamaSystem struct {
	ctx       context.Context
	cancel    context.CancelFunc
	logger    *zap.Logger
	config    *config.Config
	
	// Core components
	miningEngine  mining.Engine
	poolManager   *pool.Manager
	stratumServer *stratum.Server
	p2pNetwork    *p2p.Network
	
	// State management
	state     atomic.Value // stores SystemState
	startTime time.Time
	mu        sync.RWMutex
	wg        sync.WaitGroup
	
	// Graceful shutdown
	shutdownCh chan struct{}
	shutdownWg sync.WaitGroup
}

// SystemState represents the system state
type SystemState string

const (
	StateInitializing SystemState = "initializing"
	StateStarting     SystemState = "starting"
	StateRunning      SystemState = "running"
	StateStopping     SystemState = "stopping"
	StateStopped      SystemState = "stopped"
	StateError        SystemState = "error"
)

// NewOtedamaSystem creates a new mining system with dependency injection
func NewOtedamaSystem(cfg *config.Config, logger *zap.Logger) (*OtedamaSystem, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}
	if logger == nil {
		return nil, fmt.Errorf("logger is required")
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	system := &OtedamaSystem{
		ctx:        ctx,
		cancel:     cancel,
		logger:     logger,
		config:     cfg,
		startTime:  time.Now(),
		shutdownCh: make(chan struct{}),
	}
	
	// Set initial state
	system.state.Store(StateInitializing)
	
	// Initialize components with error handling
	if err := system.initializeComponents(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to initialize components: %w", err)
	}
	
	system.state.Store(StateStopped)
	return system, nil
}

// initializeComponents initializes all system components
func (s *OtedamaSystem) initializeComponents() error {
	s.logger.Info("Initializing Otedama components")
	
	// 1. Initialize mining engine
	if err := s.initializeMiningEngine(); err != nil {
		return fmt.Errorf("mining engine initialization failed: %w", err)
	}
	
	// 2. Initialize pool manager if enabled
	if s.config.Pool.Enable {
		if err := s.initializePoolManager(); err != nil {
			return fmt.Errorf("pool manager initialization failed: %w", err)
		}
	}
	
	// 3. Initialize Stratum server if enabled
	if s.config.Network.Stratum.Enable {
		if err := s.initializeStratumServer(); err != nil {
			return fmt.Errorf("stratum server initialization failed: %w", err)
		}
	}
	
	// 4. Initialize P2P network if enabled
	if s.config.Network.P2P.Enable {
		if err := s.initializeP2PNetwork(); err != nil {
			return fmt.Errorf("P2P network initialization failed: %w", err)
		}
	}
	
	
	s.logger.Info("All components initialized successfully")
	return nil
}

// initializeMiningEngine creates and configures the mining engine
func (s *OtedamaSystem) initializeMiningEngine() error {
	engineConfig := &mining.Config{
		CPUThreads:         s.config.Mining.CPUThreads,
		GPUDevices:         s.config.Mining.GPUDevices,
		ASICDevices:        s.config.Mining.ASICDevices,
		Algorithm:          s.config.Mining.Algorithm,
		Intensity:          s.config.Mining.Intensity,
		MaxMemoryMB:        s.config.Performance.MaxMemoryMB,
		JobQueueSize:       s.config.Performance.MaxJobQueueSize,
		MinShareDifficulty: 1000,
		AutoOptimize:       s.config.Mining.AutoOptimize,
		HugePages:          s.config.Performance.HugePages,
		NUMA:               s.config.Performance.NUMA,
	}
	
	engine, err := mining.NewEngine(s.logger, engineConfig)
	if err != nil {
		return err
	}
	
	s.miningEngine = engine
	return nil
}

// initializePoolManager creates the pool manager
func (s *OtedamaSystem) initializePoolManager() error {
	poolConfig := &pool.Config{
		Address:        s.config.Pool.Address,
		MaxConnections: s.config.Pool.MaxConnections,
		FeePercentage:  s.config.Pool.FeePercentage,
		PayoutInterval: s.config.Pool.PayoutInterval,
		MinimumPayout:  s.config.Pool.MinimumPayout,
	}
	
	manager, err := pool.NewManager(s.logger, poolConfig, s.miningEngine)
	if err != nil {
		return err
	}
	
	s.poolManager = manager
	return nil
}

// initializeStratumServer creates the Stratum server
func (s *OtedamaSystem) initializeStratumServer() error {
	stratumConfig := &stratum.Config{
		Address:         s.config.Network.Stratum.ListenAddr,
		MaxConnections:  s.config.Network.Stratum.MaxConnections,
		ExtraNonceSize:  s.config.Network.Stratum.ExtraNonceSize,
		TargetTime:      s.config.Network.Stratum.TargetTime,
		RetargetTime:    s.config.Network.Stratum.RetargetTime,
		VariancePercent: s.config.Network.Stratum.VariancePercent,
	}
	
	server, err := stratum.NewServer(s.logger, stratumConfig, s.miningEngine)
	if err != nil {
		return err
	}
	
	s.stratumServer = server
	return nil
}

// initializeP2PNetwork creates the P2P network
func (s *OtedamaSystem) initializeP2PNetwork() error {
	p2pConfig := &p2p.Config{
		ListenAddr:      s.config.Network.P2P.ListenAddr,
		MaxPeers:        s.config.Network.P2P.MaxPeers,
		BootstrapNodes:  s.config.Network.P2P.BootstrapNodes,
		EnableDiscovery: s.config.Network.P2P.EnableDiscovery,
	}
	
	network, err := p2p.NewNetwork(s.logger, p2pConfig)
	if err != nil {
		return err
	}
	
	s.p2pNetwork = network
	return nil
}


// Start starts all system components
func (s *OtedamaSystem) Start() error {
	if !s.setState(StateStopped, StateStarting) {
		return fmt.Errorf("system not in stopped state")
	}
	
	s.logger.Info("Starting Otedama system",
		zap.String("version", "2.1.4"),
		zap.String("algorithm", s.config.Mining.Algorithm),
	)
	
	// Start components in order
	startOrder := []struct {
		name    string
		starter func() error
		enabled bool
	}{
		{"Mining Engine", s.startMiningEngine, true},
		{"Pool Manager", s.startPoolManager, s.config.Pool.Enable},
		{"Stratum Server", s.startStratumServer, s.config.Network.Stratum.Enable},
		{"P2P Network", s.startP2PNetwork, s.config.Network.P2P.Enable},
	}
	
	for _, component := range startOrder {
		if !component.enabled {
			continue
		}
		
		s.logger.Info("Starting component", zap.String("component", component.name))
		if err := component.starter(); err != nil {
			s.setState(StateStarting, StateError)
			// Cleanup started components
			s.cleanup()
			return fmt.Errorf("failed to start %s: %w", component.name, err)
		}
	}
	
	// Start monitoring
	s.wg.Add(1)
	go s.monitorSystem()
	
	s.setState(StateStarting, StateRunning)
	s.logger.Info("Otedama system started successfully")
	return nil
}

// Stop gracefully stops all system components
func (s *OtedamaSystem) Stop() error {
	if !s.setState(StateRunning, StateStopping) {
		return fmt.Errorf("system not running")
	}
	
	s.logger.Info("Stopping Otedama system")
	
	// Signal shutdown
	close(s.shutdownCh)
	
	// Cancel context
	s.cancel()
	
	// Stop components in reverse order
	stopOrder := []struct {
		name    string
		stopper func() error
		enabled bool
	}{
		{"P2P Network", s.stopP2PNetwork, s.p2pNetwork != nil},
		{"Stratum Server", s.stopStratumServer, s.stratumServer != nil},
		{"Pool Manager", s.stopPoolManager, s.poolManager != nil},
		{"Mining Engine", s.stopMiningEngine, s.miningEngine != nil},
	}
	
	var stopErrors []error
	for _, component := range stopOrder {
		if !component.enabled {
			continue
		}
		
		s.logger.Info("Stopping component", zap.String("component", component.name))
		if err := component.stopper(); err != nil {
			s.logger.Error("Failed to stop component",
				zap.String("component", component.name),
				zap.Error(err),
			)
			stopErrors = append(stopErrors, err)
		}
	}
	
	// Wait for all goroutines
	s.wg.Wait()
	
	s.setState(StateStopping, StateStopped)
	s.logger.Info("Otedama system stopped")
	
	if len(stopErrors) > 0 {
		return fmt.Errorf("encountered %d errors during shutdown", len(stopErrors))
	}
	
	return nil
}

// Component start methods
func (s *OtedamaSystem) startMiningEngine() error {
	if s.miningEngine == nil {
		return fmt.Errorf("mining engine not initialized")
	}
	return s.miningEngine.Start()
}

func (s *OtedamaSystem) startPoolManager() error {
	if s.poolManager == nil {
		return nil
	}
	return s.poolManager.Start()
}

func (s *OtedamaSystem) startStratumServer() error {
	if s.stratumServer == nil {
		return nil
	}
	s.shutdownWg.Add(1)
	go func() {
		defer s.shutdownWg.Done()
		if err := s.stratumServer.ListenAndServe(); err != nil {
			s.logger.Error("Stratum server error", zap.Error(err))
		}
	}()
	return nil
}

func (s *OtedamaSystem) startP2PNetwork() error {
	if s.p2pNetwork == nil {
		return nil
	}
	return s.p2pNetwork.Start()
}


// Component stop methods
func (s *OtedamaSystem) stopMiningEngine() error {
	if s.miningEngine == nil {
		return nil
	}
	return s.miningEngine.Stop()
}

func (s *OtedamaSystem) stopPoolManager() error {
	if s.poolManager == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.poolManager.Shutdown(ctx)
}

func (s *OtedamaSystem) stopStratumServer() error {
	if s.stratumServer == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.stratumServer.Shutdown(ctx)
}

func (s *OtedamaSystem) stopP2PNetwork() error {
	if s.p2pNetwork == nil {
		return nil
	}
	return s.p2pNetwork.Stop()
}


// GetState returns the current system state
func (s *OtedamaSystem) GetState() string {
	return string(s.state.Load().(SystemState))
}

// setState atomically sets the system state
func (s *OtedamaSystem) setState(expected, new SystemState) bool {
	return s.state.CompareAndSwap(expected, new)
}

// GetStats returns system statistics
func (s *OtedamaSystem) GetStats() interface{} {
	stats := make(map[string]interface{})
	
	// Get mining stats
	if s.miningEngine != nil {
		miningStats := s.miningEngine.GetStats()
		stats["mining"] = miningStats
	}
	
	// Get pool stats
	if s.poolManager != nil {
		poolStats := s.poolManager.GetStats()
		stats["pool"] = poolStats
	}
	
	// Get P2P stats
	if s.p2pNetwork != nil {
		p2pStats := s.p2pNetwork.GetStats()
		stats["p2p"] = p2pStats
	}
	
	// System stats
	stats["system"] = map[string]interface{}{
		"state":      s.GetState(),
		"uptime":     time.Since(s.startTime).Seconds(),
		"start_time": s.startTime,
		"version":    "2.1.4",
	}
	
	return stats
}

// monitorSystem monitors system health
func (s *OtedamaSystem) monitorSystem() {
	defer s.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.shutdownCh:
			return
		case <-ticker.C:
			s.performHealthCheck()
		}
	}
}

// performHealthCheck checks system health
func (s *OtedamaSystem) performHealthCheck() {
	// Check mining engine
	if s.miningEngine != nil {
		status := s.miningEngine.GetStatus()
		if !status.Running && s.GetState() == string(StateRunning) {
			s.logger.Warn("Mining engine not running, attempting restart")
			if err := s.miningEngine.Start(); err != nil {
				s.logger.Error("Failed to restart mining engine", zap.Error(err))
			}
		}
	}
	
	// Add more health checks as needed
}

// cleanup cleans up partially started components
func (s *OtedamaSystem) cleanup() {
	s.logger.Info("Cleaning up components")
	
	// Stop any started components
	if s.p2pNetwork != nil {
		_ = s.stopP2PNetwork()
	}
	if s.stratumServer != nil {
		_ = s.stopStratumServer()
	}
	if s.poolManager != nil {
		_ = s.stopPoolManager()
	}
	if s.miningEngine != nil {
		_ = s.stopMiningEngine()
	}
}

// Restart restarts the system
func (s *OtedamaSystem) Restart() error {
	s.logger.Info("Restarting Otedama system")
	
	// Stop the system
	if err := s.Stop(); err != nil {
		return fmt.Errorf("failed to stop system: %w", err)
	}
	
	// Wait a moment
	time.Sleep(2 * time.Second)
	
	// Start the system
	if err := s.Start(); err != nil {
		return fmt.Errorf("failed to start system: %w", err)
	}
	
	return nil
}

// GetVersion returns the system version
func (s *OtedamaSystem) GetVersion() string {
	return "2.1.4"
}

// IsHealthy returns true if the system is healthy
func (s *OtedamaSystem) IsHealthy() bool {
	state := s.GetState()
	return state == string(StateRunning)
}

// GetConfig returns the current configuration
func (s *OtedamaSystem) GetConfig() *config.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config
}

// UpdateConfig updates the configuration (requires restart)
func (s *OtedamaSystem) UpdateConfig(newConfig *config.Config) error {
	s.mu.Lock()
	s.config = newConfig
	s.mu.Unlock()
	
	return s.Restart()
}