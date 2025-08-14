package pool

import (
	"context"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/config"
	"github.com/shizukutanaka/Otedama/internal/currency"
	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// PoolManager orchestrates all mining pool components including share validation,
// job distribution, payout calculation, and block submission.
// It follows a modular design for easy maintenance and testing.
type PoolManager struct {
	logger *zap.Logger
	config *config.PoolConfig
	
	// Database repositories - grouped for clarity
	db               *database.DB
	workerRepo       *database.WorkerRepository
	shareRepo        *database.ShareRepository
	blockRepo        *database.BlockRepository
	payoutRepo       *database.PayoutRepository
	statsRepo        *database.StatisticsRepository
	
	// Core pool components
	shareValidator   *ShareValidator      // Validates submitted shares
	jobManager       *JobManager          // Manages mining jobs
	difficultyAdj    *DifficultyAdjuster  // Adjusts worker difficulty
	blockSubmitter   *BlockSubmitter      // Submits blocks to blockchain
	payoutCalculator *PayoutCalculator    // Calculates miner rewards
	payoutProcessor  *PayoutProcessor     // Processes payouts
	
	// Lifecycle management
	running   bool              // Current running state
	runningMu sync.RWMutex      // Protects running state
	ctx       context.Context   // Context for cancellation
	cancel    context.CancelFunc // Cancel function
}

// NewPoolManager creates a new pool manager with all necessary components.
// It initializes repositories, validators, and processors with appropriate configurations.
func NewPoolManager(logger *zap.Logger, config *config.PoolConfig, db *database.DB) (*PoolManager, error) {
	// Initialize database repositories
	workerRepo := &database.WorkerRepository{db: db}
	shareRepo := &database.ShareRepository{db: db}
	blockRepo := &database.BlockRepository{db: db}
	payoutRepo := &database.PayoutRepository{db: db}
	statsRepo := &database.StatisticsRepository{db: db}
	
	// Create job manager
	jobManager := NewJobManager(logger, 2*time.Minute)
	
	// Create difficulty adjuster
	difficultyAdj := NewDifficultyAdjuster(logger, config.MinShareDifficulty)
	
	// Create share validator
	shareValidatorConfig := ShareValidatorConfig{
		DuplicateWindow:    5 * time.Minute,
		StaleJobWindow:     2 * time.Minute,
		MinShareDifficulty: config.MinShareDifficulty,
		MaxTimeFuture:      10 * time.Second,
		ValidationTimeout:  5 * time.Second,
		CleanupInterval:    10 * time.Minute,
	}
	
	// Create currency manager and client manager
	currencyManager := currency.NewCurrencyManager(logger)
	clientManager := currency.NewClientManager(logger, currencyManager)
	
	shareValidator := NewShareValidator(
		logger,
		shareRepo,
		workerRepo,
		statsRepo,
		jobManager,
		currencyManager,
		clientManager,
		shareValidatorConfig,
	)
	
	// Create block submitter
	submitterConfig := SubmitterConfig{
		MaxRetries:            3,
		RetryDelay:            5 * time.Second,
		SubmissionTimeout:     30 * time.Second,
		RequiredConfirmations: config.RequiredConfirmations,
		ConfirmationInterval:  1 * time.Minute,
		ConfirmationTimeout:   2 * time.Hour,
		OrphanCheckDepth:      100,
		OrphanCheckInterval:   10 * time.Minute,
	}
	
	blockSubmitter := NewBlockSubmitter(logger, blockRepo, shareRepo, submitterConfig)
	
	// Create payout calculator (uses currency manager for per-currency configs)
	payoutCalculator := NewPayoutCalculator(
		logger,
		shareRepo,
		workerRepo,
		payoutRepo,
		blockRepo,
		currencyManager,
	)
	
	// Create payout processor
	processorConfig := ProcessorConfig{
		ProcessInterval:     10 * time.Minute,
		RetryInterval:       5 * time.Minute,
		MaxRetries:          3,
		BatchSize:           100,
		MaxBatchAmount:      10.0,
		RequireConfirmation: true,
		ConfirmationBlocks:  config.RequiredConfirmations,
		WalletTimeout:       30 * time.Second,
	}
	
	payoutProcessor := NewPayoutProcessor(logger, payoutRepo, payoutCalculator, processorConfig)
	
	pm := &PoolManager{
		logger:           logger,
		config:           config,
		db:               db,
		workerRepo:       workerRepo,
		shareRepo:        shareRepo,
		blockRepo:        blockRepo,
		payoutRepo:       payoutRepo,
		statsRepo:        statsRepo,
		shareValidator:   shareValidator,
		jobManager:       jobManager,
		difficultyAdj:    difficultyAdj,
		blockSubmitter:   blockSubmitter,
		payoutCalculator: payoutCalculator,
		payoutProcessor:  payoutProcessor,
	}
	
	return pm, nil
}

// Start starts the pool manager
func (pm *PoolManager) Start() error {
	pm.runningMu.Lock()
	defer pm.runningMu.Unlock()
	
	if pm.running {
		return nil
	}
	
	pm.ctx, pm.cancel = context.WithCancel(context.Background())
	pm.running = true
	
	// Start monitoring routines
	go pm.statsRoutine()
	go pm.cleanupRoutine()
	
	pm.logger.Info("Pool manager started")
	return nil
}

// Stop stops the pool manager
func (pm *PoolManager) Stop() error {
	pm.runningMu.Lock()
	defer pm.runningMu.Unlock()
	
	if !pm.running {
		return nil
	}
	
	pm.cancel()
	pm.running = false
	
	pm.logger.Info("Pool manager stopped")
	return nil
}

// SubmitShare processes a submitted share
func (pm *PoolManager) SubmitShare(ctx context.Context, share *Share) (*ValidationResult, error) {
	// Validate share
	result, err := pm.shareValidator.ValidateShare(ctx, share)
	if err != nil {
		return nil, err
	}
	
	// If block found, submit it
	if result.BlockFound {
		job := pm.jobManager.GetJob(share.JobID)
		if job != nil {
			go func() {
				err := pm.blockSubmitter.SubmitBlock(context.Background(), share, job, pm.config.Currency)
				if err != nil {
					pm.logger.Error("Failed to submit block",
						zap.Int64("height", job.Height),
						zap.Error(err),
					)
				}
			}()
		}
	}
	
	return result, nil
}

// CreateJob creates a new mining job with the specified parameters.
// It delegates to the job manager which handles job rotation and cleanup.
func (pm *PoolManager) CreateJob(
	algorithm string,
	target string,
	blockTemplate []byte,
	networkDifficulty float64,
	height int64,
	blockReward float64,
	previousHash string,
) *MiningJob {
	return pm.jobManager.CreateJob(
		algorithm,
		target,
		blockTemplate,
		networkDifficulty,
		height,
		blockReward,
		previousHash,
	)
}

// GetWorkerDifficulty returns the current difficulty for a specific worker.
// The difficulty is dynamically adjusted based on the worker's performance.
func (pm *PoolManager) GetWorkerDifficulty(workerID string) float64 {
	return pm.difficultyAdj.GetDifficulty(workerID)
}

// GetCurrentJob returns the current mining job
func (pm *PoolManager) GetCurrentJob() *MiningJob {
	return pm.jobManager.GetCurrentJob()
}

// RegisterBlockchainClient registers a blockchain client
func (pm *PoolManager) RegisterBlockchainClient(currency string, client BlockchainClient) {
	pm.blockSubmitter.RegisterClient(currency, client)
}

// RegisterWallet registers a wallet for payouts
func (pm *PoolManager) RegisterWallet(currency string, wallet WalletInterface) {
	pm.payoutProcessor.RegisterWallet(currency, wallet)
}

// GetPoolStats returns comprehensive pool statistics including shares, blocks,
// payouts, and component health information for the last 24 hours.
func (pm *PoolManager) GetPoolStats(ctx context.Context) (map[string]interface{}, error) {
	stats := make(map[string]interface{})
	
	// Gather share statistics for the last 24 hours
	shareStats, err := pm.shareRepo.GetShareStats(ctx, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	stats["shares"] = shareStats
	
	// Get block stats
	blockStats, err := pm.blockRepo.GetBlockStats(ctx, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	stats["blocks"] = blockStats
	
	// Get payout stats
	payoutStats, err := pm.payoutRepo.GetPayoutStats(ctx, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	stats["payouts"] = payoutStats
	
	// Get component stats
	stats["share_validator"] = pm.shareValidator.GetStats()
	stats["job_manager"] = pm.jobManager.GetStats()
	stats["difficulty_adjuster"] = pm.difficultyAdj.GetStats()
	stats["block_submitter"] = pm.blockSubmitter.GetStats()
	stats["payout_calculator"] = pm.payoutCalculator.GetStats()
	
	// Get processing stats
	processingStats, err := pm.payoutProcessor.GetProcessingStats(ctx)
	if err == nil {
		stats["payout_processor"] = processingStats
	}
	
	// Add pool configuration
	stats["config"] = map[string]interface{}{
		"payout_scheme":          pm.config.PayoutScheme,
		"minimum_payout":         pm.config.MinimumPayout,
		"pool_fee_percent":       pm.config.PoolFeePercent,
		"currency":               pm.config.Currency,
		"required_confirmations": pm.config.RequiredConfirmations,
	}
	
	return stats, nil
}

// GetWorkerStats returns statistics for a specific worker
func (pm *PoolManager) GetWorkerStats(ctx context.Context, workerID string) (map[string]interface{}, error) {
	stats := make(map[string]interface{})
	
	// Get worker info
	worker, err := pm.workerRepo.Get(ctx, workerID)
	if err != nil {
		return nil, err
	}
	stats["worker"] = worker
	
	// Get share stats
	shareStats, err := pm.shareRepo.GetWorkerShareStats(ctx, workerID, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	stats["shares"] = shareStats
	
	// Get difficulty stats
	stats["difficulty"] = pm.difficultyAdj.GetWorkerStats(workerID)
	
	// Get earnings
	earnings, err := pm.payoutCalculator.GetWorkerEarnings(ctx, workerID)
	if err != nil {
		return nil, err
	}
	stats["earnings"] = earnings
	
	// Get recent payouts
	payouts, err := pm.payoutRepo.GetWorkerPayouts(ctx, workerID, 10)
	if err != nil {
		return nil, err
	}
	stats["recent_payouts"] = payouts
	
	return stats, nil
}

// Private methods

func (pm *PoolManager) statsRoutine() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			pm.recordPoolStats()
		case <-pm.ctx.Done():
			return
		}
	}
}

func (pm *PoolManager) recordPoolStats() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	
	// Get latest metrics
	metrics, err := pm.statsRepo.GetLatestMetrics(ctx)
	if err != nil {
		pm.logger.Error("Failed to get latest metrics", zap.Error(err))
		return
	}
	
	// Log pool health
	pm.logger.Info("Pool health",
		zap.Float64("total_hashrate", metrics["pool_hashrate"]),
		zap.Float64("active_workers", metrics["active_workers"]),
		zap.Float64("shares_per_minute", metrics["shares_per_minute"]),
	)
}

func (pm *PoolManager) cleanupRoutine() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			pm.performCleanup()
		case <-pm.ctx.Done():
			return
		}
	}
}

func (pm *PoolManager) performCleanup() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	
	// Cleanup old shares
	err := pm.shareRepo.CleanupOld(ctx, 7*24*time.Hour)
	if err != nil {
		pm.logger.Error("Failed to cleanup old shares", zap.Error(err))
	}
	
	// Cleanup old statistics
	err = pm.statsRepo.CleanupOld(ctx, 30*24*time.Hour)
	if err != nil {
		pm.logger.Error("Failed to cleanup old statistics", zap.Error(err))
	}
	
	// Cleanup inactive workers
	pm.difficultyAdj.CleanupInactive(24 * time.Hour)
}