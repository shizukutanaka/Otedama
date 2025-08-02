package core

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/api"
	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/dashboard"
	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/monitoring"
	"github.com/otedama/otedama/internal/p2p"
	"github.com/otedama/otedama/internal/security"
	"github.com/otedama/otedama/internal/stratum"
	"github.com/otedama/otedama/internal/zkp"
	"go.uber.org/zap"
)

// System represents the main system orchestrator
// Following John Carmack's principle: "Focus on performance"
// Robert C. Martin's principle: "Clean architecture with clear boundaries"  
// Rob Pike's principle: "Simplicity is the ultimate sophistication"
type System struct {
	logger *zap.Logger
	config *config.Config
	
	// Core components
	miningEngine  *mining.Engine
	stratumServer *stratum.Server
	p2pPool      *p2p.Pool
	apiServer    *api.Server
	dashboard    *dashboard.Server
	
	// Security and ZKP
	security     *security.Manager
	zkpManager   *zkp.Manager
	
	// Monitoring
	monitor      *monitoring.Monitor
	
	// State management
	state        atomic.Int32
	startTime    time.Time
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// SystemState represents the system state
type SystemState int32

const (
	StateInitialized SystemState = iota
	StateStarting
	StateRunning
	StateStopping
	StateStopped
	StateError
)

// NewSystem creates a new system instance
func NewSystem(cfg *config.Config, logger *zap.Logger) (*System, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}
	if logger == nil {
		return nil, fmt.Errorf("logger is required")
	}
	
	sys := &System{
		logger:    logger,
		config:    cfg,
		startTime: time.Now(),
	}
	
	// Initialize components
	if err := sys.initializeComponents(); err != nil {
		return nil, fmt.Errorf("failed to initialize components: %w", err)
	}
	
	sys.state.Store(int32(StateInitialized))
	
	logger.Info("Otedama system initialized",
		zap.String("version", cfg.Version),
		zap.String("mode", cfg.Mode),
	)
	
	return sys, nil
}

// Start starts the system
func (s *System) Start() error {
	if !s.state.CompareAndSwap(int32(StateInitialized), int32(StateStarting)) {
		return fmt.Errorf("system already started or in invalid state")
	}
	
	s.logger.Info("Starting Otedama system...")
	
	// Create context
	s.ctx, s.cancel = context.WithCancel(context.Background())
	
	// Start security first
	if err := s.startSecurity(); err != nil {
		s.state.Store(int32(StateError))
		return fmt.Errorf("failed to start security: %w", err)
	}
	
	// Start monitoring
	if err := s.startMonitoring(); err != nil {
		s.state.Store(int32(StateError))
		return fmt.Errorf("failed to start monitoring: %w", err)
	}
	
	// Start core services
	if err := s.startCoreServices(); err != nil {
		s.state.Store(int32(StateError))
		return fmt.Errorf("failed to start core services: %w", err)
	}
	
	// Start background tasks
	s.startBackgroundTasks()
	
	s.state.Store(int32(StateRunning))
	
	s.logger.Info("Otedama system started successfully",
		zap.Duration("startup_time", time.Since(s.startTime)),
	)
	
	return nil
}

// Stop stops the system gracefully
func (s *System) Stop() error {
	if !s.state.CompareAndSwap(int32(StateRunning), int32(StateStopping)) {
		return fmt.Errorf("system not running")
	}
	
	s.logger.Info("Stopping Otedama system...")
	
	// Cancel context
	if s.cancel != nil {
		s.cancel()
	}
	
	// Stop services in reverse order
	s.stopCoreServices()
	s.stopMonitoring()
	s.stopSecurity()
	
	// Wait for all goroutines
	s.wg.Wait()
	
	s.state.Store(int32(StateStopped))
	
	s.logger.Info("Otedama system stopped",
		zap.Duration("uptime", time.Since(s.startTime)),
	)
	
	return nil
}

// GetState returns the current system state
func (s *System) GetState() SystemState {
	return SystemState(s.state.Load())
}

// GetStats returns system statistics
func (s *System) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"state":      s.GetState().String(),
		"uptime":     time.Since(s.startTime).String(),
		"start_time": s.startTime,
		"version":    s.config.Version,
		"mode":       s.config.Mode,
	}
	
	// Add component stats
	if s.miningEngine != nil {
		stats["mining"] = s.miningEngine.GetStats()
	}
	
	if s.p2pPool != nil {
		stats["p2p"] = s.p2pPool.GetStats()
	}
	
	if s.monitor != nil {
		stats["monitoring"] = s.monitor.GetStats()
	}
	
	return stats
}

// Private methods

func (s *System) initializeComponents() error {
	var err error
	
	// Initialize security manager
	s.security, err = security.NewManager(s.logger, s.config.Security)
	if err != nil {
		return fmt.Errorf("failed to create security manager: %w", err)
	}
	
	// Initialize ZKP manager if enabled
	if s.config.ZKP.Enabled {
		s.zkpManager, err = zkp.NewManager(s.logger, s.config.ZKP)
		if err != nil {
			return fmt.Errorf("failed to create ZKP manager: %w", err)
		}
	}
	
	// Initialize mining engine
	s.miningEngine, err = mining.NewEngine(s.logger, s.config.Mining)
	if err != nil {
		return fmt.Errorf("failed to create mining engine: %w", err)
	}
	
	// Initialize P2P pool if enabled
	if s.config.P2PPool.Enabled {
		s.p2pPool, err = p2p.NewPool(s.logger, s.config.P2PPool)
		if err != nil {
			return fmt.Errorf("failed to create P2P pool: %w", err)
		}
	}
	
	// Initialize Stratum server if enabled
	if s.config.Stratum.Enabled {
		s.stratumServer, err = stratum.NewServer(s.logger, s.config.Stratum)
		if err != nil {
			return fmt.Errorf("failed to create stratum server: %w", err)
		}
	}
	
	// Initialize API server if enabled
	if s.config.API.Enabled {
		s.apiServer, err = api.NewServer(s.logger, s.config.API)
		if err != nil {
			return fmt.Errorf("failed to create API server: %w", err)
		}
	}
	
	// Initialize dashboard if enabled
	if s.config.Dashboard.Enabled {
		s.dashboard, err = dashboard.NewServer(s.logger, s.config.Dashboard)
		if err != nil {
			return fmt.Errorf("failed to create dashboard: %w", err)
		}
	}
	
	// Initialize monitoring
	s.monitor, err = monitoring.NewMonitor(s.logger, s.config.Monitoring)
	if err != nil {
		return fmt.Errorf("failed to create monitor: %w", err)
	}
	
	return nil
}

func (s *System) startSecurity() error {
	if err := s.security.Start(); err != nil {
		return fmt.Errorf("failed to start security manager: %w", err)
	}
	
	s.logger.Info("Security subsystem started")
	return nil
}

func (s *System) startMonitoring() error {
	if err := s.monitor.Start(); err != nil {
		return fmt.Errorf("failed to start monitor: %w", err)
	}
	
	s.logger.Info("Monitoring subsystem started")
	return nil
}

func (s *System) startCoreServices() error {
	// Start mining engine
	if err := s.miningEngine.Start(); err != nil {
		return fmt.Errorf("failed to start mining engine: %w", err)
	}
	
	// Start P2P pool
	if s.p2pPool != nil {
		if err := s.p2pPool.Start(s.ctx); err != nil {
			return fmt.Errorf("failed to start P2P pool: %w", err)
		}
	}
	
	// Start Stratum server
	if s.stratumServer != nil {
		if err := s.stratumServer.Start(); err != nil {
			return fmt.Errorf("failed to start stratum server: %w", err)
		}
	}
	
	// Start API server
	if s.apiServer != nil {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			if err := s.apiServer.Start(); err != nil {
				s.logger.Error("API server error", zap.Error(err))
			}
		}()
	}
	
	// Start dashboard
	if s.dashboard != nil {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			if err := s.dashboard.Start(); err != nil {
				s.logger.Error("Dashboard server error", zap.Error(err))
			}
		}()
	}
	
	s.logger.Info("Core services started")
	return nil
}

func (s *System) startBackgroundTasks() {
	// Start stats collector
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.collectStats()
	}()
	
	// Start performance optimizer
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.optimizePerformance()
	}()
}

func (s *System) stopCoreServices() {
	// Stop API server
	if s.apiServer != nil {
		s.apiServer.Stop()
	}
	
	// Stop dashboard
	if s.dashboard != nil {
		s.dashboard.Stop()
	}
	
	// Stop Stratum server
	if s.stratumServer != nil {
		s.stratumServer.Stop()
	}
	
	// Stop P2P pool
	if s.p2pPool != nil {
		s.p2pPool.Stop()
	}
	
	// Stop mining engine
	if s.miningEngine != nil {
		s.miningEngine.Stop()
	}
}

func (s *System) stopMonitoring() {
	if s.monitor != nil {
		s.monitor.Stop()
	}
}

func (s *System) stopSecurity() {
	if s.security != nil {
		s.security.Stop()
	}
}

// Background task implementations

func (s *System) collectStats() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			stats := s.GetStats()
			s.monitor.UpdateStats(stats)
			
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *System) optimizePerformance() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Simple performance optimization
			if s.miningEngine != nil {
				s.miningEngine.Optimize()
			}
			
		case <-s.ctx.Done():
			return
		}
	}
}

// String returns the string representation of SystemState
func (s SystemState) String() string {
	switch s {
	case StateInitialized:
		return "initialized"
	case StateStarting:
		return "starting"
	case StateRunning:
		return "running"
	case StateStopping:
		return "stopping"
	case StateStopped:
		return "stopped"
	case StateError:
		return "error"
	default:
		return "unknown"
	}
}
