package pool

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// BlockSubmitter handles block submission to the blockchain
type BlockSubmitter struct {
	logger       *zap.Logger
	blockRepo    *database.BlockRepository
	shareRepo    *database.ShareRepository
	
	// Blockchain clients
	clients      map[string]BlockchainClient
	clientsMu    sync.RWMutex
	
	// Submission tracking
	submissions  map[string]*SubmissionInfo
	submissionMu sync.RWMutex
	
	// Configuration
	config       SubmitterConfig
}

// SubmitterConfig contains block submitter configuration
type SubmitterConfig struct {
	// Submission settings
	MaxRetries           int
	RetryDelay           time.Duration
	SubmissionTimeout    time.Duration
	
	// Confirmation settings
	RequiredConfirmations int
	ConfirmationInterval  time.Duration
	ConfirmationTimeout   time.Duration
	
	// Orphan detection
	OrphanCheckDepth     int
	OrphanCheckInterval  time.Duration
}

// BlockchainClient interface for blockchain operations
type BlockchainClient interface {
	SubmitBlock(blockData []byte) (string, error)
	GetBlockInfo(blockHash string) (*BlockInfo, error)
	GetBlockHeight() (int64, error)
	GetBlockByHeight(height int64) (*BlockInfo, error)
}

// BlockInfo contains blockchain block information
type BlockInfo struct {
	Hash          string
	Height        int64
	Confirmations int
	Timestamp     time.Time
	PreviousHash  string
	Miner         string
	Reward        float64
}

// SubmissionInfo tracks block submission
type SubmissionInfo struct {
	BlockHeight   int64
	BlockHash     string
	SubmittedAt   time.Time
	Confirmations int
	Status        string
	LastChecked   time.Time
}

// NewBlockSubmitter creates a new block submitter
func NewBlockSubmitter(
	logger *zap.Logger,
	blockRepo *database.BlockRepository,
	shareRepo *database.ShareRepository,
	config SubmitterConfig,
) *BlockSubmitter {
	// Set defaults
	if config.MaxRetries <= 0 {
		config.MaxRetries = 3
	}
	if config.RetryDelay <= 0 {
		config.RetryDelay = 5 * time.Second
	}
	if config.SubmissionTimeout <= 0 {
		config.SubmissionTimeout = 30 * time.Second
	}
	if config.RequiredConfirmations <= 0 {
		config.RequiredConfirmations = 6
	}
	if config.ConfirmationInterval <= 0 {
		config.ConfirmationInterval = 1 * time.Minute
	}
	if config.ConfirmationTimeout <= 0 {
		config.ConfirmationTimeout = 2 * time.Hour
	}
	if config.OrphanCheckDepth <= 0 {
		config.OrphanCheckDepth = 100
	}
	if config.OrphanCheckInterval <= 0 {
		config.OrphanCheckInterval = 10 * time.Minute
	}
	
	bs := &BlockSubmitter{
		logger:      logger,
		blockRepo:   blockRepo,
		shareRepo:   shareRepo,
		config:      config,
		clients:     make(map[string]BlockchainClient),
		submissions: make(map[string]*SubmissionInfo),
	}
	
	// Start confirmation monitoring
	go bs.confirmationRoutine()
	
	// Start orphan detection
	go bs.orphanDetectionRoutine()
	
	return bs
}

// RegisterClient registers a blockchain client for a currency
func (bs *BlockSubmitter) RegisterClient(currency string, client BlockchainClient) {
	bs.clientsMu.Lock()
	defer bs.clientsMu.Unlock()
	
	bs.clients[currency] = client
	bs.logger.Info("Registered blockchain client", zap.String("currency", currency))
}

// SubmitBlock submits a found block to the blockchain
func (bs *BlockSubmitter) SubmitBlock(ctx context.Context, share *Share, job *MiningJob, currency string) error {
	bs.clientsMu.RLock()
	client, exists := bs.clients[currency]
	bs.clientsMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("no client registered for currency: %s", currency)
	}
	
	// Construct block data from share and job
	blockData, err := bs.constructBlockData(share, job)
	if err != nil {
		return fmt.Errorf("failed to construct block data: %w", err)
	}
	
	// Submit with retries
	var blockHash string
	var submitErr error
	
	for attempt := 0; attempt <= bs.config.MaxRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(bs.config.RetryDelay)
			bs.logger.Info("Retrying block submission",
				zap.Int("attempt", attempt),
				zap.Int64("height", job.Height),
			)
		}
		
		submitCtx, cancel := context.WithTimeout(ctx, bs.config.SubmissionTimeout)
		blockHash, submitErr = client.SubmitBlock(blockData)
		cancel()
		
		if submitErr == nil {
			break
		}
		
		bs.logger.Warn("Block submission failed",
			zap.Int("attempt", attempt),
			zap.Error(submitErr),
		)
	}
	
	if submitErr != nil {
		return fmt.Errorf("failed to submit block after %d attempts: %w", bs.config.MaxRetries, submitErr)
	}
	
	// Record block in database
	block := &database.Block{
		Height:       job.Height,
		Hash:         blockHash,
		PreviousHash: job.PreviousHash,
		Difficulty:   job.NetworkDifficulty,
		Reward:       job.BlockReward,
		Miner:        share.WorkerID,
		Status:       "pending",
	}
	
	err = bs.blockRepo.Create(block)
	if err != nil {
		bs.logger.Error("Failed to save block record",
			zap.Int64("height", job.Height),
			zap.Error(err),
		)
	}
	
	// Track submission for confirmation
	bs.trackSubmission(job.Height, blockHash)
	
	bs.logger.Info("Block submitted successfully",
		zap.Int64("height", job.Height),
		zap.String("hash", blockHash),
		zap.String("worker", share.WorkerID),
		zap.Float64("reward", job.BlockReward),
	)
	
	return nil
}

// CheckConfirmations checks confirmations for a submitted block
func (bs *BlockSubmitter) CheckConfirmations(ctx context.Context, blockHash string, currency string) (int, error) {
	bs.clientsMu.RLock()
	client, exists := bs.clients[currency]
	bs.clientsMu.RUnlock()
	
	if !exists {
		return 0, fmt.Errorf("no client registered for currency: %s", currency)
	}
	
	blockInfo, err := client.GetBlockInfo(blockHash)
	if err != nil {
		return 0, err
	}
	
	return blockInfo.Confirmations, nil
}

// GetSubmissionStatus returns the status of a block submission
func (bs *BlockSubmitter) GetSubmissionStatus(blockHeight int64) *SubmissionInfo {
	bs.submissionMu.RLock()
	defer bs.submissionMu.RUnlock()
	
	for _, info := range bs.submissions {
		if info.BlockHeight == blockHeight {
			return info
		}
	}
	
	return nil
}

// Private methods

func (bs *BlockSubmitter) constructBlockData(share *Share, job *MiningJob) ([]byte, error) {
	// Combine block template with nonce and other mining data
	blockData := make([]byte, len(job.BlockTemplate))
	copy(blockData, job.BlockTemplate)
	
	// Apply nonce
	nonce, err := hex.DecodeString(share.Nonce)
	if err != nil {
		return nil, fmt.Errorf("invalid nonce: %w", err)
	}
	
	// This is simplified - actual implementation would depend on the blockchain
	// For Bitcoin-like chains, we'd need to properly construct the block header
	// with merkle root, timestamp, nonce, etc.
	
	// Add coinbase data
	blockData = append(blockData, job.CoinbaseData...)
	
	// Add nonce at appropriate position
	blockData = append(blockData, nonce...)
	
	return blockData, nil
}

func (bs *BlockSubmitter) trackSubmission(blockHeight int64, blockHash string) {
	bs.submissionMu.Lock()
	defer bs.submissionMu.Unlock()
	
	bs.submissions[blockHash] = &SubmissionInfo{
		BlockHeight:   blockHeight,
		BlockHash:     blockHash,
		SubmittedAt:   time.Now(),
		Confirmations: 0,
		Status:        "pending",
		LastChecked:   time.Now(),
	}
}

func (bs *BlockSubmitter) confirmationRoutine() {
	ticker := time.NewTicker(bs.config.ConfirmationInterval)
	defer ticker.Stop()
	
	for range ticker.C {
		bs.checkPendingConfirmations()
	}
}

func (bs *BlockSubmitter) checkPendingConfirmations() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	
	// Get pending blocks from database
	pendingBlocks, err := bs.blockRepo.GetPendingBlocks(ctx)
	if err != nil {
		bs.logger.Error("Failed to get pending blocks", zap.Error(err))
		return
	}
	
	for _, block := range pendingBlocks {
		// Check each registered client
		bs.clientsMu.RLock()
		clients := make(map[string]BlockchainClient)
		for currency, client := range bs.clients {
			clients[currency] = client
		}
		bs.clientsMu.RUnlock()
		
		for currency, client := range clients {
			blockInfo, err := client.GetBlockInfo(block.Hash)
			if err != nil {
				continue
			}
			
			// Update confirmations
			bs.updateSubmissionInfo(block.Hash, blockInfo.Confirmations)
			
			// Check if confirmed
			if blockInfo.Confirmations >= bs.config.RequiredConfirmations {
				err = bs.blockRepo.UpdateStatus(ctx, block.ID, "confirmed", &blockInfo.Confirmations)
				if err != nil {
					bs.logger.Error("Failed to update block status",
						zap.Int64("block_id", block.ID),
						zap.Error(err),
					)
				} else {
					bs.logger.Info("Block confirmed",
						zap.Int64("height", block.Height),
						zap.String("hash", block.Hash),
						zap.Int("confirmations", blockInfo.Confirmations),
					)
				}
			}
			
			// Check for timeout
			if time.Since(block.CreatedAt) > bs.config.ConfirmationTimeout {
				// Mark as orphaned if still pending
				if blockInfo.Confirmations < bs.config.RequiredConfirmations {
					err = bs.blockRepo.UpdateStatus(ctx, block.ID, "orphaned", nil)
					if err != nil {
						bs.logger.Error("Failed to mark block as orphaned",
							zap.Int64("block_id", block.ID),
							zap.Error(err),
						)
					}
				}
			}
			
			break // Found in one client is enough
		}
	}
}

func (bs *BlockSubmitter) updateSubmissionInfo(blockHash string, confirmations int) {
	bs.submissionMu.Lock()
	defer bs.submissionMu.Unlock()
	
	if info, exists := bs.submissions[blockHash]; exists {
		info.Confirmations = confirmations
		info.LastChecked = time.Now()
		
		if confirmations >= bs.config.RequiredConfirmations {
			info.Status = "confirmed"
		}
	}
}

func (bs *BlockSubmitter) orphanDetectionRoutine() {
	ticker := time.NewTicker(bs.config.OrphanCheckInterval)
	defer ticker.Stop()
	
	for range ticker.C {
		bs.detectOrphanedBlocks()
	}
}

func (bs *BlockSubmitter) detectOrphanedBlocks() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	
	// Get recent confirmed blocks
	recentBlocks, err := bs.blockRepo.GetRecentBlocks(ctx, bs.config.OrphanCheckDepth)
	if err != nil {
		bs.logger.Error("Failed to get recent blocks", zap.Error(err))
		return
	}
	
	// Check each block against blockchain
	bs.clientsMu.RLock()
	clients := make(map[string]BlockchainClient)
	for currency, client := range bs.clients {
		clients[currency] = client
	}
	bs.clientsMu.RUnlock()
	
	for _, block := range recentBlocks {
		if block.Status != "confirmed" {
			continue
		}
		
		// Check if block exists at the expected height
		orphaned := true
		
		for _, client := range clients {
			chainBlock, err := client.GetBlockByHeight(block.Height)
			if err != nil {
				continue
			}
			
			if chainBlock.Hash == block.Hash {
				orphaned = false
				break
			}
		}
		
		if orphaned {
			// Mark as orphaned
			err = bs.blockRepo.UpdateStatus(ctx, block.ID, "orphaned", nil)
			if err != nil {
				bs.logger.Error("Failed to mark block as orphaned",
					zap.Int64("block_id", block.ID),
					zap.Error(err),
				)
			} else {
				bs.logger.Warn("Orphaned block detected",
					zap.Int64("height", block.Height),
					zap.String("hash", block.Hash),
				)
			}
		}
	}
}

// GetStats returns block submission statistics
func (bs *BlockSubmitter) GetStats() map[string]interface{} {
	bs.submissionMu.RLock()
	defer bs.submissionMu.RUnlock()
	
	pendingCount := 0
	confirmedCount := 0
	
	for _, info := range bs.submissions {
		switch info.Status {
		case "pending":
			pendingCount++
		case "confirmed":
			confirmedCount++
		}
	}
	
	bs.clientsMu.RLock()
	registeredCurrencies := make([]string, 0, len(bs.clients))
	for currency := range bs.clients {
		registeredCurrencies = append(registeredCurrencies, currency)
	}
	bs.clientsMu.RUnlock()
	
	return map[string]interface{}{
		"total_submissions":      len(bs.submissions),
		"pending_submissions":    pendingCount,
		"confirmed_submissions":  confirmedCount,
		"registered_currencies":  registeredCurrencies,
		"required_confirmations": bs.config.RequiredConfirmations,
		"orphan_check_depth":     bs.config.OrphanCheckDepth,
	}
}