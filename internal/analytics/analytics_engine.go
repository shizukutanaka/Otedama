package analytics

import (
	"context"
	"math"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/currency"
	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// AnalyticsEngine provides advanced statistics and analytics
type AnalyticsEngine struct {
	logger          *zap.Logger
	db              *database.DB
	statsRepo       *database.StatisticsRepository
	shareRepo       *database.ShareRepository
	blockRepo       *database.BlockRepository
	workerRepo      *database.WorkerRepository
	payoutRepo      *database.PayoutRepository
	currencyManager *currency.CurrencyManager
	
	// Cache
	cache           *AnalyticsCache
	cacheMu         sync.RWMutex
	
	// Configuration
	config          AnalyticsConfig
	
	// Background workers
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// AnalyticsConfig contains analytics configuration
type AnalyticsConfig struct {
	// Cache settings
	CacheTTL             time.Duration
	CacheCleanupInterval time.Duration
	
	// Calculation intervals
	StatsUpdateInterval  time.Duration
	TrendAnalysisWindow  time.Duration
	
	// Retention settings
	DetailedDataRetention time.Duration
	AggregatedDataRetention time.Duration
	
	// Performance settings
	MaxConcurrentQueries int
	QueryTimeout         time.Duration
}

// AnalyticsCache stores frequently accessed analytics data
type AnalyticsCache struct {
	poolStats       map[string]*PoolStatistics      // currency -> stats
	workerStats     map[string]*WorkerStatistics    // workerID -> stats
	currencyTrends  map[string]*CurrencyTrends      // currency -> trends
	lastUpdate      time.Time
}

// PoolStatistics contains pool-wide statistics
type PoolStatistics struct {
	Currency         string
	Hashrate         float64
	HashrateUnit     string
	ActiveWorkers    int
	TotalWorkers     int
	ValidShares      int64
	InvalidShares    int64
	SharesPerMinute  float64
	BlocksFound      int
	BlocksOrphaned   int
	TotalPaid        int64
	PendingPayouts   int64
	PoolEfficiency   float64
	LastBlockTime    *time.Time
	EstimatedDaily   float64
	UpdatedAt        time.Time
}

// WorkerStatistics contains worker-specific statistics
type WorkerStatistics struct {
	WorkerID         string
	Hashrate         float64
	HashrateUnit     string
	ValidShares      int64
	InvalidShares    int64
	Efficiency       float64
	LastShareTime    *time.Time
	TotalEarned      int64
	PendingBalance   int64
	PayoutHistory    []*PayoutSummary
	ShareHistory     []*ShareSummary
	UpdatedAt        time.Time
}

// CurrencyTrends contains trend analysis for a currency
type CurrencyTrends struct {
	Currency          string
	HashrateHistory   []DataPoint
	DifficultyHistory []DataPoint
	BlockTimeHistory  []DataPoint
	ShareRateHistory  []DataPoint
	EfficiencyHistory []DataPoint
	PriceHistory      []DataPoint
	UpdatedAt         time.Time
}

// DataPoint represents a time-series data point
type DataPoint struct {
	Timestamp time.Time   `json:"timestamp"`
	Value     float64     `json:"value"`
	Label     string      `json:"label,omitempty"`
	Metadata  interface{} `json:"metadata,omitempty"`
}

// PayoutSummary contains payout summary information
type PayoutSummary struct {
	PayoutID    int64     `json:"payout_id"`
	Amount      int64     `json:"amount"`
	Currency    string    `json:"currency"`
	TxID        string    `json:"tx_id"`
	PaidAt      time.Time `json:"paid_at"`
}

// ShareSummary contains share summary information
type ShareSummary struct {
	Timestamp   time.Time `json:"timestamp"`
	Difficulty  float64   `json:"difficulty"`
	Valid       bool      `json:"valid"`
	BlockFound  bool      `json:"block_found"`
}

// NewAnalyticsEngine creates a new analytics engine
func NewAnalyticsEngine(
	logger *zap.Logger,
	db *database.DB,
	currencyManager *currency.CurrencyManager,
	config AnalyticsConfig,
) *AnalyticsEngine {
	// Set defaults
	if config.CacheTTL <= 0 {
		config.CacheTTL = 5 * time.Minute
	}
	if config.CacheCleanupInterval <= 0 {
		config.CacheCleanupInterval = 10 * time.Minute
	}
	if config.StatsUpdateInterval <= 0 {
		config.StatsUpdateInterval = 1 * time.Minute
	}
	if config.TrendAnalysisWindow <= 0 {
		config.TrendAnalysisWindow = 24 * time.Hour
	}
	if config.DetailedDataRetention <= 0 {
		config.DetailedDataRetention = 7 * 24 * time.Hour
	}
	if config.AggregatedDataRetention <= 0 {
		config.AggregatedDataRetention = 90 * 24 * time.Hour
	}
	if config.MaxConcurrentQueries <= 0 {
		config.MaxConcurrentQueries = 10
	}
	if config.QueryTimeout <= 0 {
		config.QueryTimeout = 30 * time.Second
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	ae := &AnalyticsEngine{
		logger:          logger,
		db:              db,
		statsRepo:       database.NewStatisticsRepository(db, logger),
		shareRepo:       database.NewShareRepository(db, logger),
		blockRepo:       database.NewBlockRepository(db, logger),
		workerRepo:      database.NewWorkerRepository(db, logger),
		payoutRepo:      database.NewPayoutRepository(db, logger),
		currencyManager: currencyManager,
		config:          config,
		ctx:             ctx,
		cancel:          cancel,
		cache: &AnalyticsCache{
			poolStats:      make(map[string]*PoolStatistics),
			workerStats:    make(map[string]*WorkerStatistics),
			currencyTrends: make(map[string]*CurrencyTrends),
		},
	}
	
	// Start background workers
	ae.startBackgroundWorkers()
	
	return ae
}

// Start starts the analytics engine
func (ae *AnalyticsEngine) Start() error {
	ae.logger.Info("Starting analytics engine")
	
	// Initialize cache
	if err := ae.refreshCache(); err != nil {
		ae.logger.Error("Failed to initialize cache", zap.Error(err))
	}
	
	return nil
}

// Stop stops the analytics engine
func (ae *AnalyticsEngine) Stop() error {
	ae.logger.Info("Stopping analytics engine")
	
	ae.cancel()
	ae.wg.Wait()
	
	return nil
}

// GetPoolStatistics returns pool statistics for a currency
func (ae *AnalyticsEngine) GetPoolStatistics(currency string) (*PoolStatistics, error) {
	// Check cache first
	ae.cacheMu.RLock()
	if stats, exists := ae.cache.poolStats[currency]; exists {
		if time.Since(stats.UpdatedAt) < ae.config.CacheTTL {
			ae.cacheMu.RUnlock()
			return stats, nil
		}
	}
	ae.cacheMu.RUnlock()
	
	// Calculate fresh statistics
	ctx, cancel := context.WithTimeout(ae.ctx, ae.config.QueryTimeout)
	defer cancel()
	
	stats, err := ae.calculatePoolStatistics(ctx, currency)
	if err != nil {
		return nil, err
	}
	
	// Update cache
	ae.cacheMu.Lock()
	ae.cache.poolStats[currency] = stats
	ae.cacheMu.Unlock()
	
	return stats, nil
}

// GetWorkerStatistics returns statistics for a specific worker
func (ae *AnalyticsEngine) GetWorkerStatistics(workerID string) (*WorkerStatistics, error) {
	// Check cache first
	ae.cacheMu.RLock()
	if stats, exists := ae.cache.workerStats[workerID]; exists {
		if time.Since(stats.UpdatedAt) < ae.config.CacheTTL {
			ae.cacheMu.RUnlock()
			return stats, nil
		}
	}
	ae.cacheMu.RUnlock()
	
	// Calculate fresh statistics
	ctx, cancel := context.WithTimeout(ae.ctx, ae.config.QueryTimeout)
	defer cancel()
	
	stats, err := ae.calculateWorkerStatistics(ctx, workerID)
	if err != nil {
		return nil, err
	}
	
	// Update cache
	ae.cacheMu.Lock()
	ae.cache.workerStats[workerID] = stats
	ae.cacheMu.Unlock()
	
	return stats, nil
}

// GetCurrencyTrends returns trend analysis for a currency
func (ae *AnalyticsEngine) GetCurrencyTrends(currency string) (*CurrencyTrends, error) {
	// Check cache first
	ae.cacheMu.RLock()
	if trends, exists := ae.cache.currencyTrends[currency]; exists {
		if time.Since(trends.UpdatedAt) < ae.config.CacheTTL {
			ae.cacheMu.RUnlock()
			return trends, nil
		}
	}
	ae.cacheMu.RUnlock()
	
	// Calculate fresh trends
	ctx, cancel := context.WithTimeout(ae.ctx, ae.config.QueryTimeout)
	defer cancel()
	
	trends, err := ae.calculateCurrencyTrends(ctx, currency)
	if err != nil {
		return nil, err
	}
	
	// Update cache
	ae.cacheMu.Lock()
	ae.cache.currencyTrends[currency] = trends
	ae.cacheMu.Unlock()
	
	return trends, nil
}

// GetGlobalStatistics returns statistics across all currencies
func (ae *AnalyticsEngine) GetGlobalStatistics() (map[string]interface{}, error) {
	currencies := ae.currencyManager.ListCurrencies()
	
	totalHashrate := float64(0)
	totalWorkers := 0
	totalBlocksFound := 0
	totalPaid := int64(0)
	currencyStats := make(map[string]*PoolStatistics)
	
	for _, curr := range currencies {
		stats, err := ae.GetPoolStatistics(curr.Symbol)
		if err != nil {
			ae.logger.Warn("Failed to get pool statistics",
				zap.String("currency", curr.Symbol),
				zap.Error(err),
			)
			continue
		}
		
		currencyStats[curr.Symbol] = stats
		totalHashrate += stats.Hashrate
		totalWorkers += stats.ActiveWorkers
		totalBlocksFound += stats.BlocksFound
		totalPaid += stats.TotalPaid
	}
	
	return map[string]interface{}{
		"total_hashrate":    totalHashrate,
		"total_workers":     totalWorkers,
		"total_blocks":      totalBlocksFound,
		"total_paid":        totalPaid,
		"currency_stats":    currencyStats,
		"currencies_active": len(currencyStats),
		"timestamp":         time.Now(),
	}, nil
}

// GetWorkerRankings returns top workers by various metrics
func (ae *AnalyticsEngine) GetWorkerRankings(currency string, metric string, limit int) ([]map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(ae.ctx, ae.config.QueryTimeout)
	defer cancel()
	
	switch metric {
	case "hashrate":
		return ae.getWorkersByHashrate(ctx, currency, limit)
	case "shares":
		return ae.getWorkersByShares(ctx, currency, limit)
	case "earnings":
		return ae.getWorkersByEarnings(ctx, currency, limit)
	case "efficiency":
		return ae.getWorkersByEfficiency(ctx, currency, limit)
	default:
		return nil, fmt.Errorf("unknown ranking metric: %s", metric)
	}
}

// GetBlockStatistics returns block finding statistics
func (ae *AnalyticsEngine) GetBlockStatistics(currency string, period time.Duration) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(ae.ctx, ae.config.QueryTimeout)
	defer cancel()
	
	since := time.Now().Add(-period)
	
	// Get blocks found
	blocks, err := ae.blockRepo.GetBlocksInPeriod(ctx, currency, since, time.Now())
	if err != nil {
		return nil, err
	}
	
	// Calculate statistics
	totalBlocks := len(blocks)
	orphanedBlocks := 0
	totalReward := int64(0)
	blockTimes := make([]float64, 0)
	
	var lastBlockTime *time.Time
	for i, block := range blocks {
		if block.Status == "orphaned" {
			orphanedBlocks++
		} else {
			totalReward += int64(block.Reward)
		}
		
		if i > 0 && lastBlockTime != nil {
			blockTime := block.Timestamp.Sub(*lastBlockTime).Minutes()
			blockTimes = append(blockTimes, blockTime)
		}
		lastBlockTime = &block.Timestamp
	}
	
	// Calculate average block time
	avgBlockTime := float64(0)
	if len(blockTimes) > 0 {
		sum := float64(0)
		for _, bt := range blockTimes {
			sum += bt
		}
		avgBlockTime = sum / float64(len(blockTimes))
	}
	
	// Calculate luck (actual vs expected blocks)
	curr, _ := ae.currencyManager.GetCurrency(currency)
	expectedBlocks := float64(period) / float64(curr.BlockTime)
	luck := float64(totalBlocks) / expectedBlocks * 100
	
	return map[string]interface{}{
		"total_blocks":      totalBlocks,
		"orphaned_blocks":   orphanedBlocks,
		"orphan_rate":       float64(orphanedBlocks) / float64(totalBlocks) * 100,
		"total_reward":      totalReward,
		"average_block_time": avgBlockTime,
		"expected_blocks":   expectedBlocks,
		"luck":              luck,
		"period":            period.String(),
		"currency":          currency,
	}, nil
}

// GetPayoutStatistics returns payout statistics
func (ae *AnalyticsEngine) GetPayoutStatistics(currency string, period time.Duration) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(ae.ctx, ae.config.QueryTimeout)
	defer cancel()
	
	return ae.payoutRepo.GetPayoutStatsByCurrency(ctx, currency, period)
}

// GetEfficiencyAnalysis returns pool efficiency metrics
func (ae *AnalyticsEngine) GetEfficiencyAnalysis(currency string) (map[string]interface{}, error) {
	ctx, cancel := context.WithTimeout(ae.ctx, ae.config.QueryTimeout)
	defer cancel()
	
	// Get share statistics
	validShares, invalidShares, err := ae.getShareCounts(ctx, currency, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	
	totalShares := validShares + invalidShares
	shareEfficiency := float64(0)
	if totalShares > 0 {
		shareEfficiency = float64(validShares) / float64(totalShares) * 100
	}
	
	// Get stale share rate
	staleShares, err := ae.getStaleShareCount(ctx, currency, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	
	staleRate := float64(0)
	if totalShares > 0 {
		staleRate = float64(staleShares) / float64(totalShares) * 100
	}
	
	// Get duplicate share rate
	duplicateShares, err := ae.getDuplicateShareCount(ctx, currency, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	
	duplicateRate := float64(0)
	if totalShares > 0 {
		duplicateRate = float64(duplicateShares) / float64(totalShares) * 100
	}
	
	// Calculate overall efficiency score
	efficiencyScore := shareEfficiency * (1 - (staleRate+duplicateRate)/100)
	
	// Get worker efficiency distribution
	efficiencyDistribution, err := ae.getWorkerEfficiencyDistribution(ctx, currency)
	if err != nil {
		return nil, err
	}
	
	return map[string]interface{}{
		"share_efficiency":       shareEfficiency,
		"stale_rate":            staleRate,
		"duplicate_rate":        duplicateRate,
		"overall_efficiency":    efficiencyScore,
		"valid_shares_24h":      validShares,
		"invalid_shares_24h":    invalidShares,
		"total_shares_24h":      totalShares,
		"efficiency_distribution": efficiencyDistribution,
		"currency":              currency,
		"timestamp":             time.Now(),
	}, nil
}

// GetPredictiveAnalytics returns predictive analytics
func (ae *AnalyticsEngine) GetPredictiveAnalytics(currency string) (map[string]interface{}, error) {
	// Get historical data
	trends, err := ae.GetCurrencyTrends(currency)
	if err != nil {
		return nil, err
	}
	
	// Simple moving average predictions
	hashratePrediction := ae.predictNextValue(trends.HashrateHistory, 6)
	difficultyPrediction := ae.predictNextValue(trends.DifficultyHistory, 6)
	
	// Estimate next block time based on current hashrate and difficulty
	poolStats, err := ae.GetPoolStatistics(currency)
	if err != nil {
		return nil, err
	}
	
	curr, _ := ae.currencyManager.GetCurrency(currency)
	networkHashrate := difficultyPrediction * 2 / curr.BlockTime.Seconds() // Simplified
	poolShare := poolStats.Hashrate / networkHashrate
	expectedBlockTime := curr.BlockTime.Minutes() / poolShare
	
	// Revenue prediction
	blockReward := float64(625000000) // Simplified, should get from currency config
	dailyBlocks := 24 * 60 / expectedBlockTime
	dailyRevenue := dailyBlocks * blockReward * (1 - poolStats.PoolFee/100)
	
	return map[string]interface{}{
		"hashrate_prediction": map[string]interface{}{
			"next_hour":  hashratePrediction,
			"trend":      ae.calculateTrend(trends.HashrateHistory),
			"confidence": 0.75, // Simplified confidence score
		},
		"difficulty_prediction": map[string]interface{}{
			"next_adjustment": difficultyPrediction,
			"trend":          ae.calculateTrend(trends.DifficultyHistory),
		},
		"block_prediction": map[string]interface{}{
			"expected_time_minutes": expectedBlockTime,
			"daily_blocks":         dailyBlocks,
			"pool_share":           poolShare * 100,
		},
		"revenue_prediction": map[string]interface{}{
			"daily_revenue":  dailyRevenue,
			"weekly_revenue": dailyRevenue * 7,
			"monthly_revenue": dailyRevenue * 30,
		},
		"currency":  currency,
		"timestamp": time.Now(),
	}, nil
}

// Private calculation methods

func (ae *AnalyticsEngine) calculatePoolStatistics(ctx context.Context, currency string) (*PoolStatistics, error) {
	stats := &PoolStatistics{
		Currency:  currency,
		UpdatedAt: time.Now(),
	}
	
	// Get current hashrate
	hashrate, err := ae.getCurrentHashrate(ctx, currency)
	if err != nil {
		return nil, err
	}
	stats.Hashrate = hashrate
	stats.HashrateUnit = ae.formatHashrateUnit(hashrate)
	
	// Get worker counts
	activeWorkers, totalWorkers, err := ae.getWorkerCounts(ctx, currency)
	if err != nil {
		return nil, err
	}
	stats.ActiveWorkers = activeWorkers
	stats.TotalWorkers = totalWorkers
	
	// Get share statistics
	validShares, invalidShares, err := ae.getShareCounts(ctx, currency, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	stats.ValidShares = validShares
	stats.InvalidShares = invalidShares
	
	// Calculate shares per minute
	stats.SharesPerMinute = float64(validShares+invalidShares) / (24 * 60)
	
	// Calculate efficiency
	if validShares+invalidShares > 0 {
		stats.PoolEfficiency = float64(validShares) / float64(validShares+invalidShares) * 100
	}
	
	// Get block statistics
	blocks, orphans, lastBlock, err := ae.getBlockStats(ctx, currency, 24*time.Hour)
	if err != nil {
		return nil, err
	}
	stats.BlocksFound = blocks
	stats.BlocksOrphaned = orphans
	stats.LastBlockTime = lastBlock
	
	// Get payout statistics
	totalPaid, pendingPayouts, err := ae.getPayoutStats(ctx, currency)
	if err != nil {
		return nil, err
	}
	stats.TotalPaid = totalPaid
	stats.PendingPayouts = pendingPayouts
	
	// Estimate daily earnings
	if blocks > 0 {
		avgBlockReward := float64(totalPaid) / float64(blocks)
		stats.EstimatedDaily = avgBlockReward * 144 // Assuming ~144 blocks/day for BTC
	}
	
	return stats, nil
}

func (ae *AnalyticsEngine) calculateWorkerStatistics(ctx context.Context, workerID string) (*WorkerStatistics, error) {
	stats := &WorkerStatistics{
		WorkerID:  workerID,
		UpdatedAt: time.Now(),
	}
	
	// Get worker info
	worker, err := ae.workerRepo.Get(ctx, workerID)
	if err != nil {
		return nil, err
	}
	
	// Get current hashrate
	hashrate, err := ae.getWorkerHashrate(ctx, workerID)
	if err != nil {
		return nil, err
	}
	stats.Hashrate = hashrate
	stats.HashrateUnit = ae.formatHashrateUnit(hashrate)
	
	// Get share counts
	stats.ValidShares = worker.ValidShares
	stats.InvalidShares = worker.InvalidShares
	
	// Calculate efficiency
	totalShares := stats.ValidShares + stats.InvalidShares
	if totalShares > 0 {
		stats.Efficiency = float64(stats.ValidShares) / float64(totalShares) * 100
	}
	
	// Get last share time
	lastShare, err := ae.shareRepo.GetLastShareByWorker(ctx, workerID)
	if err == nil && lastShare != nil {
		stats.LastShareTime = &lastShare.CreatedAt
	}
	
	// Get earnings
	stats.TotalEarned = worker.TotalEarnings
	// Pending balance would come from payout calculator
	
	// Get payout history
	payouts, err := ae.payoutRepo.GetWorkerPayouts(ctx, workerID, 10)
	if err == nil {
		stats.PayoutHistory = make([]*PayoutSummary, len(payouts))
		for i, payout := range payouts {
			stats.PayoutHistory[i] = &PayoutSummary{
				PayoutID: payout.ID,
				Amount:   int64(payout.Amount),
				Currency: payout.Currency,
				TxID:     payout.TxID,
				PaidAt:   *payout.PaidAt,
			}
		}
	}
	
	// Get recent share history
	shares, err := ae.shareRepo.GetWorkerShares(ctx, workerID, 100)
	if err == nil {
		stats.ShareHistory = make([]*ShareSummary, len(shares))
		for i, share := range shares {
			stats.ShareHistory[i] = &ShareSummary{
				Timestamp:  share.CreatedAt,
				Difficulty: share.Difficulty,
				Valid:      share.Valid,
				BlockFound: share.BlockHeight != nil,
			}
		}
	}
	
	return stats, nil
}

func (ae *AnalyticsEngine) calculateCurrencyTrends(ctx context.Context, currency string) (*CurrencyTrends, error) {
	trends := &CurrencyTrends{
		Currency:  currency,
		UpdatedAt: time.Now(),
	}
	
	// Get hashrate history
	hashrateHistory, err := ae.statsRepo.GetHashrateHistoryByCurrency(ctx, currency, ae.config.TrendAnalysisWindow, 24)
	if err != nil {
		return nil, err
	}
	
	trends.HashrateHistory = make([]DataPoint, len(hashrateHistory))
	for i, point := range hashrateHistory {
		trends.HashrateHistory[i] = DataPoint{
			Timestamp: point["timestamp"].(time.Time),
			Value:     point["hashrate"].(float64),
		}
	}
	
	// Get difficulty history (would need blockchain data)
	trends.DifficultyHistory = ae.generateMockDifficultyHistory(24)
	
	// Get block time history
	blockTimes, err := ae.getBlockTimeHistory(ctx, currency, 24)
	if err == nil {
		trends.BlockTimeHistory = blockTimes
	}
	
	// Get share rate history
	shareRates, err := ae.getShareRateHistory(ctx, currency, 24)
	if err == nil {
		trends.ShareRateHistory = shareRates
	}
	
	// Get efficiency history
	efficiencyHistory, err := ae.getEfficiencyHistory(ctx, currency, 24)
	if err == nil {
		trends.EfficiencyHistory = efficiencyHistory
	}
	
	// Get price history (would need external API)
	trends.PriceHistory = ae.generateMockPriceHistory(24)
	
	return trends, nil
}

// Helper methods

func (ae *AnalyticsEngine) formatHashrateUnit(hashrate float64) string {
	units := []string{"H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"}
	unitIndex := 0
	
	for hashrate >= 1000 && unitIndex < len(units)-1 {
		hashrate /= 1000
		unitIndex++
	}
	
	return units[unitIndex]
}

func (ae *AnalyticsEngine) predictNextValue(history []DataPoint, windowSize int) float64 {
	if len(history) < windowSize {
		windowSize = len(history)
	}
	
	if windowSize == 0 {
		return 0
	}
	
	// Simple moving average
	sum := float64(0)
	for i := len(history) - windowSize; i < len(history); i++ {
		sum += history[i].Value
	}
	
	return sum / float64(windowSize)
}

func (ae *AnalyticsEngine) calculateTrend(history []DataPoint) string {
	if len(history) < 2 {
		return "stable"
	}
	
	// Compare last value with average of previous values
	lastValue := history[len(history)-1].Value
	avgPrevious := float64(0)
	
	count := min(5, len(history)-1)
	for i := len(history) - count - 1; i < len(history)-1; i++ {
		avgPrevious += history[i].Value
	}
	avgPrevious /= float64(count)
	
	changePercent := (lastValue - avgPrevious) / avgPrevious * 100
	
	if changePercent > 5 {
		return "increasing"
	} else if changePercent < -5 {
		return "decreasing"
	}
	
	return "stable"
}

func (ae *AnalyticsEngine) startBackgroundWorkers() {
	// Stats update worker
	ae.wg.Add(1)
	go func() {
		defer ae.wg.Done()
		ae.statsUpdateWorker()
	}()
	
	// Cache cleanup worker
	ae.wg.Add(1)
	go func() {
		defer ae.wg.Done()
		ae.cacheCleanupWorker()
	}()
	
	// Data retention worker
	ae.wg.Add(1)
	go func() {
		defer ae.wg.Done()
		ae.dataRetentionWorker()
	}()
}

func (ae *AnalyticsEngine) statsUpdateWorker() {
	ticker := time.NewTicker(ae.config.StatsUpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ae.ctx.Done():
			return
		case <-ticker.C:
			if err := ae.updatePoolStatistics(); err != nil {
				ae.logger.Error("Failed to update pool statistics", zap.Error(err))
			}
		}
	}
}

func (ae *AnalyticsEngine) cacheCleanupWorker() {
	ticker := time.NewTicker(ae.config.CacheCleanupInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ae.ctx.Done():
			return
		case <-ticker.C:
			ae.cleanupCache()
		}
	}
}

func (ae *AnalyticsEngine) dataRetentionWorker() {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ae.ctx.Done():
			return
		case <-ticker.C:
			if err := ae.cleanupOldData(); err != nil {
				ae.logger.Error("Failed to cleanup old data", zap.Error(err))
			}
		}
	}
}

func (ae *AnalyticsEngine) refreshCache() error {
	// Refresh pool statistics for all currencies
	currencies := ae.currencyManager.ListCurrencies()
	for _, curr := range currencies {
		if _, err := ae.GetPoolStatistics(curr.Symbol); err != nil {
			ae.logger.Warn("Failed to refresh pool statistics",
				zap.String("currency", curr.Symbol),
				zap.Error(err),
			)
		}
	}
	
	return nil
}

func (ae *AnalyticsEngine) cleanupCache() {
	ae.cacheMu.Lock()
	defer ae.cacheMu.Unlock()
	
	now := time.Now()
	
	// Cleanup expired pool stats
	for currency, stats := range ae.cache.poolStats {
		if now.Sub(stats.UpdatedAt) > ae.config.CacheTTL*2 {
			delete(ae.cache.poolStats, currency)
		}
	}
	
	// Cleanup expired worker stats
	for workerID, stats := range ae.cache.workerStats {
		if now.Sub(stats.UpdatedAt) > ae.config.CacheTTL*2 {
			delete(ae.cache.workerStats, workerID)
		}
	}
	
	// Cleanup expired trends
	for currency, trends := range ae.cache.currencyTrends {
		if now.Sub(trends.UpdatedAt) > ae.config.CacheTTL*2 {
			delete(ae.cache.currencyTrends, currency)
		}
	}
}

func (ae *AnalyticsEngine) cleanupOldData() error {
	ctx, cancel := context.WithTimeout(ae.ctx, 5*time.Minute)
	defer cancel()
	
	// Cleanup old detailed statistics
	detailedCutoff := time.Now().Add(-ae.config.DetailedDataRetention)
	if err := ae.statsRepo.DeleteOldStatistics(ctx, detailedCutoff); err != nil {
		return err
	}
	
	// Aggregate old data before deletion
	aggregateCutoff := time.Now().Add(-ae.config.AggregatedDataRetention)
	if err := ae.aggregateOldData(ctx, detailedCutoff, aggregateCutoff); err != nil {
		return err
	}
	
	return nil
}

// Placeholder methods for missing implementations

func (ae *AnalyticsEngine) getCurrentHashrate(ctx context.Context, currency string) (float64, error) {
	// Implementation would query recent statistics
	return 1000000000, nil // 1 GH/s placeholder
}

func (ae *AnalyticsEngine) getWorkerCounts(ctx context.Context, currency string) (active, total int, err error) {
	// Implementation would query worker statistics
	return 10, 50, nil // Placeholder
}

func (ae *AnalyticsEngine) getShareCounts(ctx context.Context, currency string, period time.Duration) (valid, invalid int64, err error) {
	// Implementation would query share repository
	return 10000, 100, nil // Placeholder
}

func (ae *AnalyticsEngine) getBlockStats(ctx context.Context, currency string, period time.Duration) (blocks, orphans int, lastBlock *time.Time, err error) {
	// Implementation would query block repository
	now := time.Now()
	return 5, 0, &now, nil // Placeholder
}

func (ae *AnalyticsEngine) getPayoutStats(ctx context.Context, currency string) (totalPaid, pending int64, err error) {
	// Implementation would query payout repository
	return 1000000000, 10000000, nil // Placeholder
}

func (ae *AnalyticsEngine) getWorkerHashrate(ctx context.Context, workerID string) (float64, error) {
	// Implementation would query recent worker statistics
	return 100000000, nil // 100 MH/s placeholder
}

func (ae *AnalyticsEngine) generateMockDifficultyHistory(points int) []DataPoint {
	history := make([]DataPoint, points)
	baseValue := 1000000.0
	for i := 0; i < points; i++ {
		history[i] = DataPoint{
			Timestamp: time.Now().Add(-time.Duration(points-i) * time.Hour),
			Value:     baseValue + math.Sin(float64(i))*100000,
		}
	}
	return history
}

func (ae *AnalyticsEngine) generateMockPriceHistory(points int) []DataPoint {
	history := make([]DataPoint, points)
	baseValue := 50000.0
	for i := 0; i < points; i++ {
		history[i] = DataPoint{
			Timestamp: time.Now().Add(-time.Duration(points-i) * time.Hour),
			Value:     baseValue + math.Sin(float64(i)*0.5)*1000,
		}
	}
	return history
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}