package p2p

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"time"

	"github.com/shizukutanaka/Otedama/internal/zkp"
	"go.uber.org/zap"
)

// Pool represents the main P2P mining pool with optional ZKP support
type Pool struct {
	*ZKPPool       // Embed ZKP pool for full functionality
	config         PoolConfig
	logger         *zap.Logger
	zkpManager     *zkp.Manager // Use the simple manager interface
}

// PoolConfig defines the configuration for the P2P pool
type PoolConfig struct {
	ListenAddr      string         `yaml:"listen_addr"`
	MaxPeers        int            `yaml:"max_peers"`
	ShareDifficulty float64        `yaml:"share_difficulty"`
	BlockTime       time.Duration  `yaml:"block_time"`
	PayoutThreshold float64        `yaml:"payout_threshold"`
	FeePercentage   float64        `yaml:"fee_percentage"`
	ZKPConfig       *ZKPConfig     `yaml:"zkp_config,omitempty"`
}

// NewPool creates a new P2P mining pool
func NewPool(config PoolConfig, logger *zap.Logger, zkpManager *zkp.Manager) (*Pool, error) {
	// If ZKP is not configured, use a basic pool
	if config.ZKPConfig == nil || !config.ZKPConfig.Enabled {
		config.ZKPConfig = &ZKPConfig{
			Enabled: false,
		}
	}
	
	// Create ZKP pool configuration
	zkpPoolConfig := ZKPPoolConfig{
		ListenAddr:      config.ListenAddr,
		MaxMiners:       config.MaxPeers,
		ConnectionTimeout: 30 * time.Second,
		Algorithm:       "sha256d", // Default algorithm
		ShareDifficulty: config.ShareDifficulty,
		PayoutThreshold: config.PayoutThreshold,
		FeePercentage:   config.FeePercentage,
		ZKPConfig:       config.ZKPConfig,
	}
	
	// Create the ZKP pool
	zkpPool, err := NewZKPPool(zkpPoolConfig, logger, zkpManager)
	if err != nil {
		return nil, fmt.Errorf("failed to create ZKP pool: %w", err)
	}
	
	pool := &Pool{
		ZKPPool:    zkpPool,
		config:     config,
		logger:     logger,
		zkpManager: zkpManager,
	}
	
	logger.Info("P2P mining pool created",
		zap.String("listen_addr", config.ListenAddr),
		zap.Bool("zkp_enabled", config.ZKPConfig.Enabled))
	
	return pool, nil
}

// Start begins pool operations
func (p *Pool) Start(ctx context.Context) error {
	// Use the embedded ZKP pool's Start method
	return p.ZKPPool.Start(ctx)
}

// Stop halts pool operations
func (p *Pool) Stop() error {
	// Use the embedded ZKP pool's Stop method
	return p.ZKPPool.Stop()
}

// GetPeerCount returns the number of connected peers
func (p *Pool) GetPeerCount() int {
	return p.ZKPPool.getMinerCount()
}

// GetTotalShares returns the total number of shares
func (p *Pool) GetTotalShares() uint64 {
	return p.ZKPPool.totalShares
}

// GetBlockHeight returns the current block height
func (p *Pool) GetBlockHeight() uint64 {
	return p.ZKPPool.getCurrentHeight()
}

// Config is an alias for backward compatibility
type Config = PoolConfig

// Additional types for compatibility

type Peer struct {
	ID        string    `json:"id"`
	Conn      net.Conn  `json:"-"`
	Address   string    `json:"address"`
	HashRate  uint64    `json:"hash_rate"`
	Shares    uint64    `json:"shares"`
	LastSeen  time.Time `json:"last_seen"`
	Connected time.Time `json:"connected"`
}

type Share struct {
	ID        string    `json:"id"`
	PeerID    string    `json:"peer_id"`
	Data      []byte    `json:"data"`
	Hash      []byte    `json:"hash"`
	Nonce     uint32    `json:"nonce"`
	Timestamp time.Time `json:"timestamp"`
	Valid     bool      `json:"valid"`
}

type Block struct {
	Height    uint64    `json:"height"`
	Hash      []byte    `json:"hash"`
	PrevHash  []byte    `json:"prev_hash"`
	Timestamp time.Time `json:"timestamp"`
	Miner     string    `json:"miner"`
	Shares    uint64    `json:"shares"`
}

// MiningShare represents a share submission (for compatibility)
type MiningShare struct {
	ID         string    `json:"id"`
	MinerID    string    `json:"miner_id"`
	JobID      string    `json:"job_id"`
	Nonce      uint64    `json:"nonce"`
	Hash       []byte    `json:"hash"`
	Timestamp  time.Time `json:"timestamp"`
	Difficulty float64   `json:"difficulty"`
}

// Transaction represents a blockchain transaction
type Transaction struct {
	ID        string    `json:"id"`
	From      string    `json:"from"`
	To        string    `json:"to"`
	Amount    float64   `json:"amount"`
	Fee       float64   `json:"fee"`
	Timestamp time.Time `json:"timestamp"`
	Data      []byte    `json:"data"`
}
