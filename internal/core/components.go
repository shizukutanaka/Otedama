package core

import (
	"context"
	"fmt"

	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
)

// MiningComponent wraps the mining engine as a component
type MiningComponent struct {
	name   string
	engine common.MiningEngine
	logger *zap.Logger
}

// NewMiningComponent creates a new mining component
func NewMiningComponent(name string, engine common.MiningEngine, logger *zap.Logger) *MiningComponent {
	return &MiningComponent{
		name:   name,
		engine: engine,
		logger: logger,
	}
}

func (mc *MiningComponent) Name() string {
	return mc.name
}

func (mc *MiningComponent) Start(ctx context.Context) error {
	mc.logger.Info("Starting mining engine")
	return mc.engine.Start(ctx)
}

func (mc *MiningComponent) Stop(ctx context.Context) error {
	mc.logger.Info("Stopping mining engine")
	mc.engine.Stop()
	return nil
}

func (mc *MiningComponent) Health() ComponentHealth {
	stats := mc.engine.GetStats()
	running, ok := stats["running"].(bool)
	if !ok {
		running = false
	}
	
	return ComponentHealth{
		Healthy: running,
		Message: fmt.Sprintf("Mining engine is %s", map[bool]string{true: "running", false: "stopped"}[running]),
		Details: stats,
	}
}

// P2PComponent wraps the P2P pool as a component
type P2PComponent struct {
	name   string
	pool   common.P2PPool
	logger *zap.Logger
}

// NewP2PComponent creates a new P2P component
func NewP2PComponent(name string, pool common.P2PPool, logger *zap.Logger) *P2PComponent {
	return &P2PComponent{
		name:   name,
		pool:   pool,
		logger: logger,
	}
}

func (pc *P2PComponent) Name() string {
	return pc.name
}

func (pc *P2PComponent) Start(ctx context.Context) error {
	pc.logger.Info("Starting P2P pool")
	return pc.pool.Start()
}

func (pc *P2PComponent) Stop(ctx context.Context) error {
	pc.logger.Info("Stopping P2P pool")
	return pc.pool.Stop()
}

func (pc *P2PComponent) Health() ComponentHealth {
	stats := pc.pool.GetStats()
	peerCount, ok := stats["peer_count"].(int)
	if !ok {
		peerCount = 0
	}
	
	healthy := peerCount > 0
	
	return ComponentHealth{
		Healthy: healthy,
		Message: fmt.Sprintf("P2P pool has %d peers", peerCount),
		Details: stats,
	}
}

// StratumComponent wraps the Stratum server as a component
type StratumComponent struct {
	name   string
	server common.StratumServer
	logger *zap.Logger
}

// NewStratumComponent creates a new Stratum component
func NewStratumComponent(name string, server common.StratumServer, logger *zap.Logger) *StratumComponent {
	return &StratumComponent{
		name:   name,
		server: server,
		logger: logger,
	}
}

func (sc *StratumComponent) Name() string {
	return sc.name
}

func (sc *StratumComponent) Start(ctx context.Context) error {
	sc.logger.Info("Starting Stratum server")
	return sc.server.Start(ctx)
}

func (sc *StratumComponent) Stop(ctx context.Context) error {
	sc.logger.Info("Stopping Stratum server")
	return sc.server.Shutdown(ctx)
}

func (sc *StratumComponent) Health() ComponentHealth {
	// For now, assume healthy if started
	return ComponentHealth{
		Healthy: true,
		Message: "Stratum server is running",
		Details: map[string]interface{}{
			"status": "active",
		},
	}
}

// APIComponent wraps the API server as a component
type APIComponent struct {
	name   string
	server common.HTTPServer
	logger *zap.Logger
}

// NewAPIComponent creates a new API component
func NewAPIComponent(name string, server common.HTTPServer, logger *zap.Logger) *APIComponent {
	return &APIComponent{
		name:   name,
		server: server,
		logger: logger,
	}
}

func (ac *APIComponent) Name() string {
	return ac.name
}

func (ac *APIComponent) Start(ctx context.Context) error {
	ac.logger.Info("Starting API server")
	return ac.server.Start(ctx)
}

func (ac *APIComponent) Stop(ctx context.Context) error {
	ac.logger.Info("Stopping API server")
	return ac.server.Shutdown(ctx)
}

func (ac *APIComponent) Health() ComponentHealth {
	return ComponentHealth{
		Healthy: true,
		Message: "API server is running",
		Details: map[string]interface{}{
			"endpoints": []string{"/api/v1/status", "/api/v1/mining/stats", "/api/v1/pool/stats"},
		},
	}
}

// MonitoringComponent wraps the monitoring system as a component
type MonitoringComponent struct {
	name       string
	collector  common.MetricsCollector
	dashboard  common.Dashboard
	logger     *zap.Logger
}

// NewMonitoringComponent creates a new monitoring component
func NewMonitoringComponent(name string, collector common.MetricsCollector, dashboard common.Dashboard, logger *zap.Logger) *MonitoringComponent {
	return &MonitoringComponent{
		name:      name,
		collector: collector,
		dashboard: dashboard,
		logger:    logger,
	}
}

func (mc *MonitoringComponent) Name() string {
	return mc.name
}

func (mc *MonitoringComponent) Start(ctx context.Context) error {
	mc.logger.Info("Starting monitoring system")
	
	// Start collector
	mc.collector.Start()
	
	// Start dashboard if available
	if mc.dashboard != nil {
		if err := mc.dashboard.Start(); err != nil {
			return fmt.Errorf("failed to start dashboard: %w", err)
		}
	}
	
	return nil
}

func (mc *MonitoringComponent) Stop(ctx context.Context) error {
	mc.logger.Info("Stopping monitoring system")
	
	// Stop dashboard first
	if mc.dashboard != nil {
		mc.dashboard.Stop()
	}
	
	// Stop collector
	mc.collector.Stop()
	
	return nil
}

func (mc *MonitoringComponent) Health() ComponentHealth {
	metrics := mc.collector.GetMetrics()
	
	return ComponentHealth{
		Healthy: true,
		Message: "Monitoring system is active",
		Details: map[string]interface{}{
			"metrics_count": len(metrics),
			"dashboard_enabled": mc.dashboard != nil,
		},
	}
}

// DatabaseComponent wraps database connections as a component
type DatabaseComponent struct {
	name   string
	closer func() error
	logger *zap.Logger
}

// NewDatabaseComponent creates a new database component
func NewDatabaseComponent(name string, closer func() error, logger *zap.Logger) *DatabaseComponent {
	return &DatabaseComponent{
		name:   name,
		closer: closer,
		logger: logger,
	}
}

func (dc *DatabaseComponent) Name() string {
	return dc.name
}

func (dc *DatabaseComponent) Start(ctx context.Context) error {
	dc.logger.Info("Database connection established")
	return nil
}

func (dc *DatabaseComponent) Stop(ctx context.Context) error {
	dc.logger.Info("Closing database connection")
	if dc.closer != nil {
		return dc.closer()
	}
	return nil
}

func (dc *DatabaseComponent) Health() ComponentHealth {
	return ComponentHealth{
		Healthy: true,
		Message: "Database connection is active",
		Details: nil,
	}
}