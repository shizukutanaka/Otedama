package pool

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/currency"
	"github.com/shizukutanaka/Otedama/internal/database"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"go.uber.org/zap"
)

// ShareValidator validates mining shares
type ShareValidator struct {
	logger           *zap.Logger
	shareRepo        *database.ShareRepository
	workerRepo       *database.WorkerRepository
	statsRepo        *database.StatisticsRepository
	jobManager       *JobManager
	difficultyAdjust *DifficultyAdjuster
	currencyManager  *currency.CurrencyManager
	clientManager    *currency.ClientManager

	// Validation cache
	recentShares map[string]time.Time
	sharesMu     sync.RWMutex

	// Metrics per currency
	metrics   map[string]*ShareMetrics
	metricsMu sync.RWMutex

	// Configuration
	config ShareValidatorConfig
}

// ShareMetrics tracks metrics for a specific currency
type ShareMetrics struct {
	ValidShares     uint64
	InvalidShares   uint64
	DuplicateShares uint64
	StaleShares     uint64
	BlocksFound     uint64
}

// ShareValidatorConfig contains share validator configuration
type ShareValidatorConfig struct {
	// Duplicate window
	DuplicateWindow time.Duration

	// Stale job window
	StaleJobWindow time.Duration

	// Minimum share difficulty
	MinShareDifficulty float64

	// Maximum time future
	MaxTimeFuture time.Duration

	// Share validation timeout
	ValidationTimeout time.Duration

	// Cleanup interval
	CleanupInterval time.Duration
}

// Share represents a submitted share
type Share struct {
	WorkerID   string
	JobID      string
	Nonce      string
	Hash       string
	Timestamp  time.Time
	Difficulty float64
	UserAgent  string
	RemoteAddr string
	Currency   string // Currency symbol
	Algorithm  string // Mining algorithm
}

// ValidationResult contains share validation result
type ValidationResult struct {
	Valid       bool
	Reason      string
	ShareDiff   float64
	BlockFound  bool
	BlockHeight int64
	Reward      float64
}

// NewShareValidator creates a new share validator
func NewShareValidator(
	logger *zap.Logger,
	shareRepo *database.ShareRepository,
	workerRepo *database.WorkerRepository,
	statsRepo *database.StatisticsRepository,
	jobManager *JobManager,
	currencyManager *currency.CurrencyManager,
	clientManager *currency.ClientManager,
	config ShareValidatorConfig,
) *ShareValidator {
	// Set defaults
	if config.DuplicateWindow <= 0 {
		config.DuplicateWindow = 5 * time.Minute
	}
	if config.StaleJobWindow <= 0 {
		config.StaleJobWindow = 2 * time.Minute
	}
	if config.MinShareDifficulty <= 0 {
		config.MinShareDifficulty = 1.0
	}
	if config.MaxTimeFuture <= 0 {
		config.MaxTimeFuture = 10 * time.Second
	}
	if config.ValidationTimeout <= 0 {
		config.ValidationTimeout = 5 * time.Second
	}
	if config.CleanupInterval <= 0 {
		config.CleanupInterval = 10 * time.Minute
	}

	sv := &ShareValidator{
		logger:           logger,
		shareRepo:        shareRepo,
		workerRepo:       workerRepo,
		statsRepo:        statsRepo,
		jobManager:       jobManager,
		currencyManager:  currencyManager,
		clientManager:    clientManager,
		config:           config,
		recentShares:     make(map[string]time.Time),
		metrics:          make(map[string]*ShareMetrics),
		difficultyAdjust: NewDifficultyAdjuster(logger, config.MinShareDifficulty),
	}

	// Start cleanup routine
	go sv.cleanupRoutine()

	return sv
}

// ValidateShare validates a submitted share
func (sv *ShareValidator) ValidateShare(ctx context.Context, share *Share) (*ValidationResult, error) {
	// Create validation context with timeout
	ctx, cancel := context.WithTimeout(ctx, sv.config.ValidationTimeout)
	defer cancel()

	result := &ValidationResult{}

	// Update worker last seen
	go sv.workerRepo.UpdateLastSeen(context.Background(), share.WorkerID)

	// 1. Check timestamp
	if err := sv.validateTimestamp(share.Timestamp); err != nil {
		sv.incrementInvalid()
		result.Valid = false
		result.Reason = err.Error()
		return result, nil
	}

	// 2. Check for duplicate
	if sv.isDuplicate(share) {
		sv.incrementDuplicate()
		result.Valid = false
		result.Reason = "duplicate share"
		return result, nil
	}

	// 3. Get job
	job := sv.jobManager.GetJob(share.JobID)
	if job == nil {
		sv.incrementStale()
		result.Valid = false
		result.Reason = "unknown job"
		return result, nil
	}

	// 4. Check if job is stale
	if time.Since(job.CreatedAt) > sv.config.StaleJobWindow {
		sv.incrementStale()
		result.Valid = false
		result.Reason = "stale job"
		return result, nil
	}

	// 5. Validate proof of work
	shareDiff, err := sv.validateProofOfWork(share, job)
	if err != nil {
		sv.incrementInvalid()
		result.Valid = false
		result.Reason = fmt.Sprintf("invalid proof of work: %v", err)
		return result, nil
	}

	result.ShareDiff = shareDiff

	// 6. Check minimum difficulty
	if shareDiff < sv.config.MinShareDifficulty {
		sv.incrementInvalid()
		result.Valid = false
		result.Reason = fmt.Sprintf("difficulty too low: %.2f < %.2f", shareDiff, sv.config.MinShareDifficulty)
		return result, nil
	}

	// 7. Check if block found
	if shareDiff >= job.NetworkDifficulty {
		result.BlockFound = true
		result.BlockHeight = job.Height
		result.Reward = job.BlockReward

		// Submit block
		go sv.submitBlock(share, job)
	}

	// Share is valid
	sv.incrementValid()
	result.Valid = true

	// Record share
	dbShare := &database.Share{
		WorkerID:    share.WorkerID,
		JobID:       share.JobID,
		Nonce:       share.Nonce,
		Hash:        share.Hash,
		Difficulty:  shareDiff,
		Valid:       true,
		BlockHeight: &result.BlockHeight,
		Reward:      result.Reward,
	}

	if err := sv.shareRepo.Create(ctx, dbShare); err != nil {
		sv.logger.Error("Failed to save share", zap.Error(err))
	}

	// Update worker stats
	go sv.updateWorkerStats(share.WorkerID, share.Currency, shareDiff, result.Valid)

	// Adjust difficulty
	sv.difficultyAdjust.RecordShare(share.WorkerID, time.Now())

	return result, nil
}

// Private methods

func (sv *ShareValidator) validateTimestamp(timestamp time.Time) error {
	now := time.Now()

	// Check if timestamp is too far in the future
	if timestamp.After(now.Add(sv.config.MaxTimeFuture)) {
		return errors.New("timestamp too far in future")
	}

	// Check if timestamp is too old
	if timestamp.Before(now.Add(-sv.config.StaleJobWindow)) {
		return errors.New("timestamp too old")
	}

	return nil
}

func (sv *ShareValidator) isDuplicate(share *Share) bool {
	sv.sharesMu.Lock()
	defer sv.sharesMu.Unlock()

	key := fmt.Sprintf("%s:%s:%s", share.WorkerID, share.JobID, share.Nonce)

	if lastSeen, exists := sv.recentShares[key]; exists {
		if time.Since(lastSeen) < sv.config.DuplicateWindow {
			return true
		}
	}

	sv.recentShares[key] = time.Now()
	return false
}

func (sv *ShareValidator) validateProofOfWork(share *Share, job *MiningJob) (float64, error) {
	// Get currency configuration
	currency, err := sv.currencyManager.GetCurrency(share.Currency)
	if err != nil {
		return 0, fmt.Errorf("invalid currency: %w", err)
	}

	// Reconstruct block header
	header := job.BlockTemplate

	// Apply nonce
	nonce, err := hex.DecodeString(share.Nonce)
	if err != nil {
		return 0, fmt.Errorf("invalid nonce format: %w", err)
	}

	// Calculate hash based on algorithm
	var hash []byte

	// Use mining engine for algorithm-specific hashing
	engine := mining.GetEngine(currency.Algorithm)
	if engine == nil {
		return 0, fmt.Errorf("unsupported algorithm: %s", currency.Algorithm)
	}

	// Calculate hash using the appropriate algorithm
	hash, err = engine.CalculateHash(append(header, nonce...))
	if err != nil {
		return 0, fmt.Errorf("hash calculation failed: %w", err)
	}

	// Verify hash matches submitted hash
	submittedHash, err := hex.DecodeString(share.Hash)
	if err != nil {
		return 0, fmt.Errorf("invalid hash format: %w", err)
	}

	if !bytesEqual(hash, submittedHash) {
		return 0, errors.New("hash mismatch")
	}

	// Calculate difficulty
	hashBig := new(big.Int).SetBytes(reverseBytes(hash))
	targetBig := new(big.Int).SetBytes(hex2bytes(job.Target))

	if targetBig.Cmp(big.NewInt(0)) == 0 {
		return 0, errors.New("invalid target")
	}

	// Difficulty = target_max / target_current
	maxTarget := new(big.Int).Lsh(big.NewInt(1), 256)
	maxTarget.Sub(maxTarget, big.NewInt(1))

	difficulty := new(big.Float).SetInt(maxTarget)
	targetFloat := new(big.Float).SetInt(targetBig)
	difficulty.Quo(difficulty, targetFloat)

	diffFloat, _ := difficulty.Float64()

	// Check if hash meets target
	if hashBig.Cmp(targetBig) > 0 {
		return diffFloat, errors.New("hash above target")
	}

	return diffFloat, nil
}

func (sv *ShareValidator) submitBlock(share *Share, job *MiningJob) {
	sv.logger.Info("Block found!",
		zap.String("worker", share.WorkerID),
		zap.String("hash", share.Hash),
		zap.Int64("height", job.Height),
		zap.Float64("reward", job.BlockReward),
		zap.String("currency", share.Currency),
	)

	// Submit to blockchain
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		// Get blockchain client
		client, err := sv.clientManager.GetClient(ctx, share.Currency)
		if err != nil {
			sv.logger.Error("Failed to get blockchain client",
				zap.String("currency", share.Currency),
				zap.Error(err),
			)
			return
		}

		// Construct block data
		blockData := hex.EncodeToString(append(job.BlockTemplate, []byte(share.Nonce)...))

		// Submit block
		if err := client.SubmitBlock(ctx, blockData); err != nil {
			sv.logger.Error("Failed to submit block",
				zap.String("currency", share.Currency),
				zap.String("hash", share.Hash),
				zap.Error(err),
			)
			return
		}

		// Update metrics
		sv.metricsMu.Lock()
		if metrics, ok := sv.metrics[share.Currency]; ok {
			metrics.BlocksFound++
		} else {
			sv.metrics[share.Currency] = &ShareMetrics{BlocksFound: 1}
		}
		sv.metricsMu.Unlock()

		sv.logger.Info("Block submitted successfully",
			zap.String("currency", share.Currency),
			zap.String("hash", share.Hash),
		)
	}()
}

func (sv *ShareValidator) updateWorkerStats(workerID string, currency string, difficulty float64, valid bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Get worker
	worker, err := sv.workerRepo.Get(ctx, workerID)
	if err != nil {
		sv.logger.Error("Failed to get worker",
			zap.String("worker_id", workerID),
			zap.Error(err),
		)
		return
	}

	// Update stats
	worker.TotalShares++
	if valid {
		worker.ValidShares++
	} else {
		worker.InvalidShares++
	}

	// Update hashrate (simple moving average)
	// Hashrate = shares * difficulty / time
	worker.TotalHashrate = difficulty * 1e6 / 600 // Assuming 10 minute window

	// Save
	if err := sv.workerRepo.Update(ctx, worker); err != nil {
		sv.logger.Error("Failed to update worker stats",
			zap.String("worker_id", workerID),
			zap.Error(err),
		)
	}

	// Record statistics
	stat := &database.Statistic{
		MetricName:  "worker_hashrate",
		MetricValue: worker.TotalHashrate,
		WorkerID:    &workerID,
		Metadata: map[string]interface{}{
			"difficulty": difficulty,
			"valid":      valid,
			"currency":   currency,
		},
	}

	if err := sv.statsRepo.Record(ctx, stat); err != nil {
		sv.logger.Error("Failed to record statistics",
			zap.Error(err),
		)
	}
}

func (sv *ShareValidator) cleanupRoutine() {
	ticker := time.NewTicker(sv.config.CleanupInterval)
	defer ticker.Stop()

	for range ticker.C {
		sv.cleanupDuplicateCache()
	}
}

func (sv *ShareValidator) cleanupDuplicateCache() {
	sv.sharesMu.Lock()
	defer sv.sharesMu.Unlock()

	cutoff := time.Now().Add(-sv.config.DuplicateWindow)

	for key, timestamp := range sv.recentShares {
		if timestamp.Before(cutoff) {
			delete(sv.recentShares, key)
		}
	}
}

// Metrics

func (sv *ShareValidator) incrementValid(currency string) {
	sv.metricsMu.Lock()
	defer sv.metricsMu.Unlock()

	if metrics, ok := sv.metrics[currency]; ok {
		metrics.ValidShares++
	} else {
		sv.metrics[currency] = &ShareMetrics{ValidShares: 1}
	}
}

func (sv *ShareValidator) incrementInvalid(currency string) {
	sv.metricsMu.Lock()
	defer sv.metricsMu.Unlock()

	if metrics, ok := sv.metrics[currency]; ok {
		metrics.InvalidShares++
	} else {
		sv.metrics[currency] = &ShareMetrics{InvalidShares: 1}
	}
}

func (sv *ShareValidator) incrementDuplicate(currency string) {
	sv.metricsMu.Lock()
	defer sv.metricsMu.Unlock()

	if metrics, ok := sv.metrics[currency]; ok {
		metrics.DuplicateShares++
	} else {
		sv.metrics[currency] = &ShareMetrics{DuplicateShares: 1}
	}
}

func (sv *ShareValidator) incrementStale(currency string) {
	sv.metricsMu.Lock()
	defer sv.metricsMu.Unlock()

	if metrics, ok := sv.metrics[currency]; ok {
		metrics.StaleShares++
	} else {
		sv.metrics[currency] = &ShareMetrics{StaleShares: 1}
	}
}

// GetStats returns validator statistics
func (sv *ShareValidator) GetStats() map[string]interface{} {
	sv.sharesMu.RLock()
	cacheSize := len(sv.recentShares)
	sv.sharesMu.RUnlock()

	sv.metricsMu.RLock()
	metricsByurrency := make(map[string]interface{})
	for currency, metrics := range sv.metrics {
		metricsByurrency[currency] = map[string]interface{}{
			"valid_shares":     metrics.ValidShares,
			"invalid_shares":   metrics.InvalidShares,
			"duplicate_shares": metrics.DuplicateShares,
			"stale_shares":     metrics.StaleShares,
			"blocks_found":     metrics.BlocksFound,
		}
	}
	sv.metricsMu.RUnlock()

	// Calculate totals across all currencies
	totalValid := uint64(0)
	totalInvalid := uint64(0)
	totalDuplicate := uint64(0)
	totalStale := uint64(0)
	totalBlocks := uint64(0)

	for _, metrics := range sv.metrics {
		totalValid += metrics.ValidShares
		totalInvalid += metrics.InvalidShares
		totalDuplicate += metrics.DuplicateShares
		totalStale += metrics.StaleShares
		totalBlocks += metrics.BlocksFound
	}

	total := totalValid + totalInvalid
	validRate := float64(0)
	if total > 0 {
		validRate = float64(totalValid) / float64(total) * 100
	}

	return map[string]interface{}{
		"valid_shares":     totalValid,
		"invalid_shares":   totalInvalid,
		"duplicate_shares": totalDuplicate,
		"stale_shares":     totalStale,
		"total_shares":     total,
		"valid_rate":       validRate,
		"blocks_found":     totalBlocks,
		"cache_size":       cacheSize,
		"by_currency":      metricsByurrency,
	}
}

// Helper functions

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func reverseBytes(data []byte) []byte {
	result := make([]byte, len(data))
	for i := range data {
		result[i] = data[len(data)-1-i]
	}
	return result
}

func hex2bytes(s string) []byte {
	b, _ := hex.DecodeString(s)
	return b
}
