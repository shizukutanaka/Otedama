package app

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/p2p"
	"go.uber.org/zap"
)

type Application struct {
	config       *config.Config
	logger       *zap.Logger
	miningEngine *mining.Engine
	p2pNetwork   *p2p.Network
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

func New(cfg *config.Config, logger *zap.Logger) (*Application, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &Application{
		config: cfg,
		logger: logger,
		ctx:    ctx,
		cancel: cancel,
	}, nil
}

func (a *Application) Initialize() error {
	a.logger.Info("Initializing Otedama application")
	
	// Initialize mining engine
	engine, err := mining.NewEngine(a.config, a.logger)
	if err != nil {
		return fmt.Errorf("failed to initialize mining engine: %w", err)
	}
	a.miningEngine = engine
	
	// Initialize P2P network if enabled
	if a.config.P2P.Enabled {
		network, err := p2p.NewNetwork(a.config, a.logger)
		if err != nil {
			return fmt.Errorf("failed to initialize P2P network: %w", err)
		}
		a.p2pNetwork = network
	}
	
	return nil
}

func (a *Application) Start() error {
	a.logger.Info("Starting Otedama application")
	
	// Start mining engine
	if err := a.miningEngine.Start(a.ctx); err != nil {
		return fmt.Errorf("failed to start mining engine: %w", err)
	}
	
	// Start P2P network if enabled
	if a.p2pNetwork != nil {
		if err := a.p2pNetwork.Start(a.ctx); err != nil {
			return fmt.Errorf("failed to start P2P network: %w", err)
		}
	}
	
	// Setup signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	
	go func() {
		<-sigChan
		a.logger.Info("Received shutdown signal")
		a.Shutdown()
	}()
	
	a.logger.Info("Otedama application started successfully")
	return nil
}

func (a *Application) Wait() {
	a.wg.Wait()
}

func (a *Application) Shutdown() {
	a.logger.Info("Shutting down Otedama application")
	
	// Cancel context to signal shutdown
	a.cancel()
	
	// Stop components with timeout
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	
	// Stop mining engine
	if a.miningEngine != nil {
		if err := a.miningEngine.Stop(shutdownCtx); err != nil {
			a.logger.Error("Error stopping mining engine", zap.Error(err))
		}
	}
	
	// Stop P2P network
	if a.p2pNetwork != nil {
		if err := a.p2pNetwork.Stop(shutdownCtx); err != nil {
			a.logger.Error("Error stopping P2P network", zap.Error(err))
		}
	}
	
	a.logger.Info("Otedama application shutdown complete")
}

func (a *Application) GetMiningEngine() *mining.Engine {
	return a.miningEngine
}

func (a *Application) GetP2PNetwork() *p2p.Network {
	return a.p2pNetwork
}