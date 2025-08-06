package core

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"go.uber.org/zap"
)

// LifecycleManager manages application lifecycle
type LifecycleManager struct {
	logger         *zap.Logger
	mu             sync.RWMutex
	components     []Component
	state          State
	shutdownChan   chan struct{}
	shutdownOnce   sync.Once
	gracefulPeriod time.Duration
}

// State represents the application state
type State int

const (
	StateStarting State = iota
	StateRunning
	StateShuttingDown
	StateStopped
)

// Component represents a managed component
type Component interface {
	// Name returns the component name
	Name() string
	
	// Start starts the component
	Start(ctx context.Context) error
	
	// Stop stops the component
	Stop(ctx context.Context) error
	
	// Health returns the component health status
	Health() ComponentHealth
}

// ComponentHealth represents component health
type ComponentHealth struct {
	Healthy bool
	Message string
	Details map[string]interface{}
}

// NewLifecycleManager creates a new lifecycle manager
func NewLifecycleManager(logger *zap.Logger, gracefulPeriod time.Duration) *LifecycleManager {
	return &LifecycleManager{
		logger:         logger,
		components:     make([]Component, 0),
		state:          StateStarting,
		shutdownChan:   make(chan struct{}),
		gracefulPeriod: gracefulPeriod,
	}
}

// RegisterComponent registers a component
func (lm *LifecycleManager) RegisterComponent(component Component) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	
	lm.components = append(lm.components, component)
	lm.logger.Info("Component registered",
		zap.String("component", component.Name()),
	)
}

// Start starts all components
func (lm *LifecycleManager) Start(ctx context.Context) error {
	lm.mu.Lock()
	if lm.state != StateStarting {
		lm.mu.Unlock()
		return fmt.Errorf("invalid state for start: %v", lm.state)
	}
	lm.mu.Unlock()
	
	lm.logger.Info("Starting lifecycle manager",
		zap.Int("components", len(lm.components)),
	)
	
	// Start components in order
	for _, component := range lm.components {
		lm.logger.Info("Starting component",
			zap.String("component", component.Name()),
		)
		
		if err := component.Start(ctx); err != nil {
			lm.logger.Error("Failed to start component",
				zap.String("component", component.Name()),
				zap.Error(err),
			)
			
			// Stop already started components
			lm.stopComponents(ctx)
			return fmt.Errorf("failed to start %s: %w", component.Name(), err)
		}
		
		lm.logger.Info("Component started successfully",
			zap.String("component", component.Name()),
		)
	}
	
	lm.mu.Lock()
	lm.state = StateRunning
	lm.mu.Unlock()
	
	// Setup signal handlers
	lm.setupSignalHandlers()
	
	lm.logger.Info("All components started successfully")
	return nil
}

// Stop stops all components
func (lm *LifecycleManager) Stop() error {
	var err error
	lm.shutdownOnce.Do(func() {
		lm.mu.Lock()
		if lm.state != StateRunning {
			lm.mu.Unlock()
			err = fmt.Errorf("invalid state for stop: %v", lm.state)
			return
		}
		lm.state = StateShuttingDown
		lm.mu.Unlock()
		
		lm.logger.Info("Initiating graceful shutdown",
			zap.Duration("grace_period", lm.gracefulPeriod),
		)
		
		// Create context with timeout
		ctx, cancel := context.WithTimeout(context.Background(), lm.gracefulPeriod)
		defer cancel()
		
		// Stop components
		lm.stopComponents(ctx)
		
		lm.mu.Lock()
		lm.state = StateStopped
		lm.mu.Unlock()
		
		// Close shutdown channel
		close(lm.shutdownChan)
		
		lm.logger.Info("Shutdown complete")
	})
	
	return err
}

// Wait waits for shutdown
func (lm *LifecycleManager) Wait() <-chan struct{} {
	return lm.shutdownChan
}

// Health returns overall system health
func (lm *LifecycleManager) Health() (bool, map[string]ComponentHealth) {
	lm.mu.RLock()
	defer lm.mu.RUnlock()
	
	if lm.state != StateRunning {
		return false, nil
	}
	
	health := make(map[string]ComponentHealth)
	allHealthy := true
	
	for _, component := range lm.components {
		componentHealth := component.Health()
		health[component.Name()] = componentHealth
		
		if !componentHealth.Healthy {
			allHealthy = false
		}
	}
	
	return allHealthy, health
}

// State returns the current lifecycle state
func (lm *LifecycleManager) State() State {
	lm.mu.RLock()
	defer lm.mu.RUnlock()
	return lm.state
}

// Private methods

func (lm *LifecycleManager) setupSignalHandlers() {
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	
	go func() {
		sig := <-sigChan
		lm.logger.Info("Received signal",
			zap.String("signal", sig.String()),
		)
		
		if err := lm.Stop(); err != nil {
			lm.logger.Error("Error during shutdown",
				zap.Error(err),
			)
		}
	}()
}

func (lm *LifecycleManager) stopComponents(ctx context.Context) {
	// Stop components in reverse order
	for i := len(lm.components) - 1; i >= 0; i-- {
		component := lm.components[i]
		
		lm.logger.Info("Stopping component",
			zap.String("component", component.Name()),
		)
		
		if err := component.Stop(ctx); err != nil {
			lm.logger.Error("Failed to stop component",
				zap.String("component", component.Name()),
				zap.Error(err),
			)
		} else {
			lm.logger.Info("Component stopped successfully",
				zap.String("component", component.Name()),
			)
		}
	}
}

// String returns string representation of state
func (s State) String() string {
	switch s {
	case StateStarting:
		return "starting"
	case StateRunning:
		return "running"
	case StateShuttingDown:
		return "shutting_down"
	case StateStopped:
		return "stopped"
	default:
		return "unknown"
	}
}