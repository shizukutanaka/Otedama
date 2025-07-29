package core

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/otedama/otedama/internal/api"
	"github.com/otedama/otedama/internal/config"
	"github.com/otedama/otedama/internal/logging"
	"github.com/otedama/otedama/internal/mining"
	"github.com/otedama/otedama/internal/monitoring"
	"github.com/otedama/otedama/internal/network"
	"github.com/otedama/otedama/internal/p2p"
	"github.com/otedama/otedama/internal/stratum"
	"go.uber.org/zap"
)

// System はアプリケーション全体を管理する
type System struct {
	config         *config.Config
	logger         *zap.Logger
	logManager     *logging.Manager
	monitor        *monitoring.Monitor
	network        *network.Manager
	cpuMiner       *mining.Engine
	gpuMiner       *mining.GPUMiner
	asicMiner      *mining.ASICMiner
	jobDistributor *mining.JobDistributor
	pool           *p2p.Pool
	stratumServer  *stratum.Server
	api            *api.Server
	mu             sync.RWMutex
	running        bool
}

// NewSystem は新しいシステムを作成
func NewSystem(cfg *config.Config, logger *zap.Logger, logManager *logging.Manager) (*System, error) {
	s := &System{
		config:     cfg,
		logger:     logger,
		logManager: logManager,
	}

	// モニタリング初期化
	s.monitor = monitoring.NewMonitor(logger)

	// ネットワークマネージャー初期化
	netMgr, err := network.NewManager(cfg.Network, logger)
	if err != nil {
		return nil, fmt.Errorf("failed to create network manager: %w", err)
	}
	s.network = netMgr

	// モードに応じてコンポーネントを初期化
	if err := s.initializeComponents(); err != nil {
		return nil, err
	}

	// APIサーバー初期化（常に有効）
	apiServer, err := api.NewServer(cfg.API, logger, logManager)
	if err != nil {
		return nil, fmt.Errorf("failed to create API server: %w", err)
	}
	s.api = apiServer

	return s, nil
}

// initializeComponents はモードに応じてコンポーネントを初期化
func (s *System) initializeComponents() error {
	switch s.config.Mode {
	case "solo":
		return s.initializeSoloMode()
	case "pool":
		return s.initializePoolMode()
	case "miner":
		return s.initializeMinerMode()
	case "auto":
		// 自動モード: 利用可能なリソースに基づいて判断
		if len(s.config.Mining.Pools) > 0 {
			return s.initializeMinerMode()
		}
		return s.initializePoolMode()
	default:
		return fmt.Errorf("unknown mode: %s", s.config.Mode)
	}
}

// initializeSoloMode はソロマイニングモードを初期化
func (s *System) initializeSoloMode() error {
	s.logger.Info("Initializing solo mining mode")

	// ジョブディストリビューター初期化
	s.jobDistributor = mining.NewJobDistributor()

	// マイニングエンジン初期化
	if err := s.initializeMiners(); err != nil {
		return err
	}

	return nil
}

// initializePoolMode はプールモードを初期化
func (s *System) initializePoolMode() error {
	s.logger.Info("Initializing pool mode")

	// P2Pプール初期化
	poolCfg := p2p.PoolConfig{
		ListenAddr:      s.config.Network.ListenAddr,
		ShareDifficulty: s.config.P2PPool.ShareDifficulty,
		BlockTime:       s.config.P2PPool.BlockTime,
		PayoutThreshold: s.config.P2PPool.PayoutThreshold,
		FeePercentage:   s.config.P2PPool.FeePercentage,
	}

	pool, err := p2p.NewPool(poolCfg, s.logger)
	if err != nil {
		return fmt.Errorf("failed to create P2P pool: %w", err)
	}
	s.pool = pool

	// Stratumサーバー初期化
	if s.config.Stratum.Enabled {
		stratumCfg := stratum.Config{
			ListenAddr: s.config.Stratum.ListenAddr,
			MaxClients: s.config.Stratum.MaxClients,
			VarDiff:    s.config.Stratum.VarDiff,
			MinDiff:    s.config.Stratum.MinDiff,
			MaxDiff:    s.config.Stratum.MaxDiff,
			TargetTime: s.config.Stratum.TargetTime,
		}

		s.stratumServer = stratum.NewServer(stratumCfg)
	}

	// ジョブディストリビューター初期化
	s.jobDistributor = mining.NewJobDistributor()

	// マイニングエンジン初期化（プールも自己マイニング可能）
	if err := s.initializeMiners(); err != nil {
		return err
	}

	return nil
}

// initializeMinerMode はマイナーモードを初期化
func (s *System) initializeMinerMode() error {
	s.logger.Info("Initializing miner mode")

	// ジョブディストリビューター初期化
	s.jobDistributor = mining.NewJobDistributor()

	// マイニングエンジン初期化
	if err := s.initializeMiners(); err != nil {
		return err
	}

	return nil
}

// initializeMiners はマイニングエンジンを初期化
func (s *System) initializeMiners() error {
	// CPUマイナー
	if s.config.Mining.EnableCPU {
		cpuMiner, err := mining.NewEngine(mining.Config{
			Algorithm:   s.config.Mining.Algorithm,
			Threads:     s.config.Mining.Threads,
			CPUAffinity: s.config.Performance.CPUAffinity,
		}, s.logger)
		if err != nil {
			return fmt.Errorf("failed to create CPU miner: %w", err)
		}
		s.cpuMiner = cpuMiner
	}

	// GPUマイナー
	if s.config.Mining.EnableGPU {
		gpuMiner, err := mining.NewGPUMiner()
		if err != nil {
			s.logger.Warn("Failed to initialize GPU miner", zap.Error(err))
		} else {
			s.gpuMiner = gpuMiner
		}
	}

	// ASICマイナー
	if s.config.Mining.EnableASIC {
		asicMiner, err := mining.NewASICMiner()
		if err != nil {
			s.logger.Warn("Failed to initialize ASIC miner", zap.Error(err))
		} else {
			s.asicMiner = asicMiner
		}
	}

	return nil
}

// Start はシステムを開始
func (s *System) Start(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.running {
		return fmt.Errorf("system already running")
	}

	s.logger.Info("Starting system components")

	// モニタリング開始
	if err := s.monitor.Start(ctx); err != nil {
		return fmt.Errorf("failed to start monitor: %w", err)
	}

	// ネットワーク開始
	if err := s.network.Start(ctx); err != nil {
		return fmt.Errorf("failed to start network: %w", err)
	}

	// モードに応じてコンポーネントを開始
	switch s.config.Mode {
	case "solo":
		if err := s.startSoloMode(ctx); err != nil {
			return err
		}
	case "pool":
		if err := s.startPoolMode(ctx); err != nil {
			return err
		}
	case "miner":
		if err := s.startMinerMode(ctx); err != nil {
			return err
		}
	case "auto":
		if len(s.config.Mining.Pools) > 0 {
			if err := s.startMinerMode(ctx); err != nil {
				return err
			}
		} else {
			if err := s.startPoolMode(ctx); err != nil {
				return err
			}
		}
	}

	// APIサーバー開始
	if err := s.api.Start(ctx); err != nil {
		return fmt.Errorf("failed to start API server: %w", err)
	}

	// 統計収集開始
	go s.collectStats(ctx)

	s.running = true
	return nil
}

// startSoloMode はソロマイニングモードを開始
func (s *System) startSoloMode(ctx context.Context) error {
	// マイナー開始
	if s.cpuMiner != nil {
		if err := s.cpuMiner.Start(ctx); err != nil {
			return fmt.Errorf("failed to start CPU miner: %w", err)
		}
	}

	if s.gpuMiner != nil {
		if err := s.gpuMiner.Start(ctx, s.config.Mining.Algorithm); err != nil {
			s.logger.Warn("Failed to start GPU miner", zap.Error(err))
		}
	}

	if s.asicMiner != nil {
		if err := s.asicMiner.Start(ctx); err != nil {
			s.logger.Warn("Failed to start ASIC miner", zap.Error(err))
		}
	}

	return nil
}

// startPoolMode はプールモードを開始
func (s *System) startPoolMode(ctx context.Context) error {
	// P2Pプール開始
	if s.pool != nil {
		if err := s.pool.Start(ctx); err != nil {
			return fmt.Errorf("failed to start P2P pool: %w", err)
		}
	}

	// Stratumサーバー開始
	if s.stratumServer != nil {
		if err := s.stratumServer.Start(ctx); err != nil {
			return fmt.Errorf("failed to start Stratum server: %w", err)
		}
	}

	// プールも自己マイニング可能
	return s.startSoloMode(ctx)
}

// startMinerMode はマイナーモードを開始
func (s *System) startMinerMode(ctx context.Context) error {
	// プールに接続
	for _, pool := range s.config.Mining.Pools {
		s.logger.Info("Connecting to pool", zap.String("url", pool.URL))
		// TODO: Stratumクライアント実装
	}

	// マイナー開始
	return s.startSoloMode(ctx)
}

// Shutdown はシステムをシャットダウン
func (s *System) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.running {
		return nil
	}

	s.logger.Info("Shutting down system components")

	// APIサーバー停止
	if s.api != nil {
		if err := s.api.Shutdown(ctx); err != nil {
			s.logger.Error("Failed to shutdown API server", zap.Error(err))
		}
	}

	// マイナー停止
	if s.cpuMiner != nil {
		if err := s.cpuMiner.Stop(); err != nil {
			s.logger.Error("Failed to stop CPU miner", zap.Error(err))
		}
	}

	if s.gpuMiner != nil {
		if err := s.gpuMiner.Stop(); err != nil {
			s.logger.Error("Failed to stop GPU miner", zap.Error(err))
		}
	}

	if s.asicMiner != nil {
		if err := s.asicMiner.Stop(); err != nil {
			s.logger.Error("Failed to stop ASIC miner", zap.Error(err))
		}
	}

	// Stratumサーバー停止
	if s.stratumServer != nil {
		if err := s.stratumServer.Stop(); err != nil {
			s.logger.Error("Failed to stop Stratum server", zap.Error(err))
		}
	}

	// P2Pプール停止
	if s.pool != nil {
		if err := s.pool.Stop(); err != nil {
			s.logger.Error("Failed to stop P2P pool", zap.Error(err))
		}
	}

	// ネットワーク停止
	if s.network != nil {
		if err := s.network.Stop(); err != nil {
			s.logger.Error("Failed to stop network", zap.Error(err))
		}
	}

	// モニタリング停止
	if s.monitor != nil {
		if err := s.monitor.Stop(); err != nil {
			s.logger.Error("Failed to stop monitor", zap.Error(err))
		}
	}

	s.running = false
	return nil
}

// collectStats は統計情報を収集
func (s *System) collectStats(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			stats := s.GetStats()
			s.monitor.UpdateStats(stats)
			s.api.UpdateStats(stats)
		}
	}
}

// GetStats は統計情報を取得
func (s *System) GetStats() map[string]interface{} {
	stats := make(map[string]interface{})

	// システム情報
	stats["mode"] = s.config.Mode
	stats["uptime"] = time.Since(s.monitor.StartTime()).Seconds()

	// マイニング統計
	if s.cpuMiner != nil {
		stats["cpu_hashrate"] = s.cpuMiner.GetHashRate()
	}

	if s.gpuMiner != nil {
		gpuStats := s.gpuMiner.GetStats()
		stats["gpu_hashrate"] = gpuStats["hash_count"]
		stats["gpu_temperature"] = gpuStats["temperature"]
	}

	if s.asicMiner != nil {
		// TODO: ASIC統計
	}

	// プール統計
	if s.pool != nil {
		stats["pool_shares"] = s.pool.GetTotalShares()
		stats["pool_blocks"] = s.pool.GetBlockHeight()
		stats["pool_peers"] = s.pool.GetPeerCount()
	}

	// Stratum統計
	if s.stratumServer != nil {
		stats["stratum_clients"] = s.stratumServer.GetClientCount()
		stats["stratum_jobs"] = s.stratumServer.GetJobsSent()
	}

	// ネットワーク統計
	if s.network != nil {
		stats["network_peers"] = s.network.GetPeerCount()
		stats["network_bandwidth"] = s.network.GetBandwidthStats()
	}

	return stats
}