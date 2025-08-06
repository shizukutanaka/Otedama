package pool

import (
	"context"
	"errors"
	"math"
	"math/big"
	"sort"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/currency"
	"github.com/shizukutanaka/Otedama/internal/database"
	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
)

// extractWalletFromMetadata extracts the wallet address from worker metadata
// Returns the wallet address if found, otherwise returns an empty string
func extractWalletFromMetadata(metadata map[string]interface{}) string {
	if metadata == nil {
		return ""
	}
	
	// Try to get wallet address from metadata
	if wallet, ok := metadata["wallet"]; ok {
		if walletStr, ok := wallet.(string); ok {
			return walletStr
		}
	}
	
	// Try alternative keys that might contain the wallet address
	alternativeKeys := []string{"payout_address", "address", "wallet_address"}
	for _, key := range alternativeKeys {
		if addr, ok := metadata[key]; ok {
			if addrStr, ok := addr.(string); ok {
				return addrStr
			}
		}
	}
	
	return ""
}

// extractWalletFromMetadataWithValidation extracts the wallet address from worker metadata
// and validates it against the currency. Returns the wallet address if valid, otherwise returns an empty string
func extractWalletFromMetadataWithValidation(metadata map[string]interface{}, currency string) string {
	if metadata == nil {
		return ""
	}
	
	// Try to get wallet address from metadata
	if wallet, ok := metadata["wallet"]; ok {
		if walletStr, ok := wallet.(string); ok {
			// Validate wallet address
			if err := common.ValidateWalletAddress(walletStr, currency); err != nil {
				return ""
			}
			return walletStr
		}
	}
	
	// Try alternative keys that might contain the wallet address
	alternativeKeys := []string{"payout_address", "address", "wallet_address"}
	for _, key := range alternativeKeys {
		if addr, ok := metadata[key]; ok {
			if addrStr, ok := addr.(string); ok {
				// Validate wallet address
				if err := common.ValidateWalletAddress(addrStr, currency); err != nil {
					return ""
				}
				return addrStr
			}
		}
	}
	
	return ""
}

// PayoutCalculator calculates miner payouts based on shares
type PayoutCalculator struct {
	logger          *zap.Logger
	shareRepo       *database.ShareRepository
	workerRepo      *database.WorkerRepository
	payoutRepo      *database.PayoutRepository
	blockRepo       *database.BlockRepository
	currencyManager *currency.CurrencyManager
	
	// Configuration per currency
	configs         map[string]*PayoutConfig
	configsMu       sync.RWMutex
	
	// Cache per currency
	workerShares    map[string]map[string]*WorkerShareInfo // currency -> worker -> shares
	sharesMu        sync.RWMutex
}

// PayoutConfig contains payout calculator configuration
type PayoutConfig struct {
	// Payout scheme
	Scheme               PayoutScheme
	
	// PPLNS configuration
	PPLNSWindow          int // Number of shares to consider
	
	// Payment thresholds
	MinimumPayout        *big.Int
	PayoutFee            *big.Int
	
	// Pool fee
	PoolFeePercent       float64
	
	// Currency settings
	Currency             string
	CoinbaseMaturity     int // Blocks before coinbase can be spent
	
	// Timing
	PayoutInterval       time.Duration
	CalculationInterval  time.Duration
}

// PayoutScheme represents the payout calculation method
type PayoutScheme string

const (
	// PPLNS - Pay Per Last N Shares (most common, reduces pool hopping)
	PPLNS PayoutScheme = "PPLNS"
	
	// PPS - Pay Per Share (immediate payment, most stable for miners)
	PPS PayoutScheme = "PPS"
	
	// PROP - Proportional (simple but vulnerable to pool hopping)
	PROP PayoutScheme = "PROP"
	
	// FPPS - Full Pay Per Share (PPS + transaction fees)
	FPPS PayoutScheme = "FPPS"
)

// WorkerShareInfo tracks share information for a worker
type WorkerShareInfo struct {
	WorkerID      string
	ValidShares   int64
	ShareValue    *big.Int
	LastShareTime time.Time
	Address       string
	Currency      string
}

// PayoutResult contains the result of payout calculation
type PayoutResult struct {
	BlockHeight   int64
	BlockReward   *big.Int
	PoolFee       *big.Int
	TotalShares   int64
	Payouts       []*WorkerPayout
	Currency      string
}

// WorkerPayout represents payout for a single worker
type WorkerPayout struct {
	WorkerID    string
	Address     string
	Amount      *big.Int
	ShareCount  int64
	Percentage  float64
	Currency    string
}

// NewPayoutCalculator creates a new payout calculator
func NewPayoutCalculator(
	logger *zap.Logger,
	shareRepo *database.ShareRepository,
	workerRepo *database.WorkerRepository,
	payoutRepo *database.PayoutRepository,
	blockRepo *database.BlockRepository,
	currencyManager *currency.CurrencyManager,
) *PayoutCalculator {
	
	pc := &PayoutCalculator{
		logger:          logger,
		shareRepo:       shareRepo,
		workerRepo:      workerRepo,
		payoutRepo:      payoutRepo,
		blockRepo:       blockRepo,
		currencyManager: currencyManager,
		configs:         make(map[string]*PayoutConfig),
		workerShares:    make(map[string]map[string]*WorkerShareInfo),
	}
	
	// Initialize default configurations for supported currencies
	pc.initializeDefaultConfigs()
	
	// Start calculation routine
	go pc.calculationRoutine()
	
	return pc
}

// initializeDefaultConfigs sets up default payout configurations for each currency
func (pc *PayoutCalculator) initializeDefaultConfigs() {
	currencies := pc.currencyManager.ListCurrencies()
	
	for _, curr := range currencies {
		config := &PayoutConfig{
			Scheme:               PPLNS,
			PPLNSWindow:          100000,
			MinimumPayout:        curr.MinPayout,
			PayoutFee:            curr.PayoutFee,
			PoolFeePercent:       2.0, // 2% default pool fee
			Currency:             curr.Symbol,
			CoinbaseMaturity:     curr.Confirmations,
			PayoutInterval:       1 * time.Hour,
			CalculationInterval:  5 * time.Minute,
		}
		
		pc.configsMu.Lock()
		pc.configs[curr.Symbol] = config
		pc.configsMu.Unlock()
		
		// Initialize worker shares map for this currency
		pc.sharesMu.Lock()
		pc.workerShares[curr.Symbol] = make(map[string]*WorkerShareInfo)
		pc.sharesMu.Unlock()
	}
}

// SetPayoutConfig sets the payout configuration for a specific currency
func (pc *PayoutCalculator) SetPayoutConfig(currency string, config *PayoutConfig) error {
	pc.configsMu.Lock()
	defer pc.configsMu.Unlock()
	
	pc.configs[currency] = config
	return nil
}

// GetPayoutConfig returns the payout configuration for a currency
func (pc *PayoutCalculator) GetPayoutConfig(currency string) (*PayoutConfig, error) {
	pc.configsMu.RLock()
	defer pc.configsMu.RUnlock()
	
	config, ok := pc.configs[currency]
	if !ok {
		return nil, errors.New("no configuration for currency: " + currency)
	}
	
	return config, nil
}

// CalculateBlockPayout calculates payouts for a found block
func (pc *PayoutCalculator) CalculateBlockPayout(ctx context.Context, blockHeight int64, currency string) (*PayoutResult, error) {
	// Get block information
	block, err := pc.blockRepo.GetByHeight(ctx, blockHeight)
	if err != nil {
		return nil, err
	}
	
	if block.Status != "confirmed" {
		return nil, errors.New("block not confirmed")
	}
	
	// Get payout configuration for currency
	config, err := pc.GetPayoutConfig(currency)
	if err != nil {
		return nil, err
	}
	
	// Convert block reward to big.Int
	blockReward := new(big.Int).SetInt64(int64(block.Reward * 1e8)) // Assuming 8 decimals
	
	// Calculate pool fee
	poolFeeAmount := new(big.Int).Mul(blockReward, big.NewInt(int64(config.PoolFeePercent*100)))
	poolFeeAmount.Div(poolFeeAmount, big.NewInt(10000)) // Divide by 100*100 for percentage
	
	distributableReward := new(big.Int).Sub(blockReward, poolFeeAmount)
	
	// Get shares based on payout scheme
	var workerPayouts []*WorkerPayout
	var totalShares int64
	
	switch config.Scheme {
	case PPLNS:
		workerPayouts, totalShares, err = pc.calculatePPLNS(ctx, blockHeight, currency, distributableReward)
	case PPS:
		workerPayouts, totalShares, err = pc.calculatePPS(ctx, blockHeight, currency, distributableReward)
	case PROP:
		workerPayouts, totalShares, err = pc.calculatePROP(ctx, blockHeight, currency, distributableReward)
	default:
		return nil, errors.New("unknown payout scheme")
	}
	
	if err != nil {
		return nil, err
	}
	
	// Filter out payouts below minimum or with invalid/missing wallet addresses
	filteredPayouts := make([]*WorkerPayout, 0)
	for _, payout := range workerPayouts {
		// Skip payouts with empty wallet addresses
		if payout.Address == "" {
			pc.logger.Warn("Skipping payout for worker with empty wallet address",
				zap.String("worker_id", payout.WorkerID),
				zap.String("currency", payout.Currency))
			// Store unpaid amount for future payout when wallet is updated
			pc.storeUnpaidAmount(payout.WorkerID, currency, payout.Amount)
			continue
		}
		
		if payout.Amount.Cmp(config.MinimumPayout) >= 0 {
			filteredPayouts = append(filteredPayouts, payout)
		} else {
			// Store unpaid amount for future payout
			pc.logger.Debug("Payout below minimum threshold",
				zap.String("worker_id", payout.WorkerID),
				zap.String("address", payout.Address),
				zap.String("amount", payout.Amount.String()))
			pc.storeUnpaidAmount(payout.WorkerID, currency, payout.Amount)
		}
	}
	
	result := &PayoutResult{
		BlockHeight: blockHeight,
		BlockReward: blockReward,
		PoolFee:     poolFeeAmount,
		TotalShares: totalShares,
		Payouts:     filteredPayouts,
		Currency:    currency,
	}
	
	return result, nil
}

// calculatePPLNS calculates payouts using PPLNS scheme
func (pc *PayoutCalculator) calculatePPLNS(ctx context.Context, blockHeight int64, currency string, reward *big.Int) ([]*WorkerPayout, int64, error) {
	// Get payout configuration
	config, err := pc.GetPayoutConfig(currency)
	if err != nil {
		return nil, 0, err
	}
	
	// Get last N shares for this currency
	shares, err := pc.shareRepo.GetLastNSharesByCurrency(ctx, currency, config.PPLNSWindow)
	if err != nil {
		return nil, 0, err
	}
	
	// Calculate share values per worker
	workerShares := make(map[string]*WorkerShareInfo)
	totalShareValue := new(big.Int)
	
	for _, share := range shares {
		if share.Valid {
			worker, exists := workerShares[share.WorkerID]
			if !exists {
				// Get worker info
				workerInfo, err := pc.workerRepo.Get(ctx, share.WorkerID)
				if err != nil {
					continue
				}
				
				worker = &WorkerShareInfo{
					WorkerID:   share.WorkerID,
					Address:    extractWalletFromMetadataWithValidation(workerInfo.Metadata, currency),
					ShareValue: new(big.Int),
					Currency:   currency,
				}
				workerShares[share.WorkerID] = worker
			}
			
			// Add share value (weighted by difficulty)
			shareValue := big.NewInt(int64(share.Difficulty * 1e8)) // Convert to fixed point
			worker.ValidShares++
			worker.ShareValue.Add(worker.ShareValue, shareValue)
			totalShareValue.Add(totalShareValue, shareValue)
		}
	}
	
	// Calculate payouts
	payouts := make([]*WorkerPayout, 0, len(workerShares))
	
	for workerID, info := range workerShares {
		// Calculate percentage (shareValue / totalShareValue)
		percentage := new(big.Float).SetInt(info.ShareValue)
		totalFloat := new(big.Float).SetInt(totalShareValue)
		percentage.Quo(percentage, totalFloat)
		
		// Calculate amount (reward * percentage)
		amount := new(big.Float).SetInt(reward)
		amount.Mul(amount, percentage)
		amountInt, _ := amount.Int(nil)
		
		// Get percentage as float64 for display
		percentFloat, _ := percentage.Float64()
		
		payout := &WorkerPayout{
			WorkerID:   workerID,
			Address:    info.Address,
			Amount:     amountInt,
			ShareCount: info.ValidShares,
			Percentage: percentFloat * 100,
			Currency:   currency,
		}
		
		payouts = append(payouts, payout)
	}
	
	// Sort by amount descending
	sort.Slice(payouts, func(i, j int) bool {
		return payouts[i].Amount.Cmp(payouts[j].Amount) > 0
	})
	
	return payouts, int64(len(shares)), nil
}

// calculatePPS calculates payouts using PPS scheme
func (pc *PayoutCalculator) calculatePPS(ctx context.Context, blockHeight int64, currency string, reward *big.Int) ([]*WorkerPayout, int64, error) {
	// For PPS, we pay a fixed amount per share regardless of blocks found
	// This requires the pool to have reserves
	
	// Get payout configuration
	config, err := pc.GetPayoutConfig(currency)
	if err != nil {
		return nil, 0, err
	}
	
	// Get unpaid shares since last payout for this currency
	shares, err := pc.shareRepo.GetUnpaidSharesByCurrency(ctx, currency)
	if err != nil {
		return nil, 0, err
	}
	
	// Calculate expected block value
	// This would normally be based on network difficulty and block reward
	expectedBlockValue := new(big.Int).Set(reward) // Simplified
	shareValueFloat := new(big.Float).SetInt(expectedBlockValue)
	shareValueFloat.Quo(shareValueFloat, big.NewFloat(float64(config.PPLNSWindow)))
	
	// Calculate payouts
	workerPayouts := make(map[string]*WorkerPayout)
	
	for _, share := range shares {
		if share.Valid {
			payout, exists := workerPayouts[share.WorkerID]
			if !exists {
				workerInfo, err := pc.workerRepo.Get(ctx, share.WorkerID)
				if err != nil {
					continue
				}
				
				payout = &WorkerPayout{
					WorkerID: share.WorkerID,
					Address:  extractWalletFromMetadataWithValidation(workerInfo.Metadata, currency),
					Amount:   new(big.Int),
					Currency: currency,
				}
				workerPayouts[share.WorkerID] = payout
			}
			
			payout.ShareCount++
			
			// Calculate share amount
			shareAmount := new(big.Float).Set(shareValueFloat)
			shareAmount.Mul(shareAmount, big.NewFloat(share.Difficulty))
			shareAmountInt, _ := shareAmount.Int(nil)
			payout.Amount.Add(payout.Amount, shareAmountInt)
		}
	}
	
	// Convert to slice
	payouts := make([]*WorkerPayout, 0, len(workerPayouts))
	for _, payout := range workerPayouts {
		payouts = append(payouts, payout)
	}
	
	return payouts, int64(len(shares)), nil
}

// calculatePROP calculates payouts using proportional scheme
func (pc *PayoutCalculator) calculatePROP(ctx context.Context, blockHeight int64, currency string, reward *big.Int) ([]*WorkerPayout, int64, error) {
	// Get all shares for this block round and currency
	shares, err := pc.shareRepo.GetSharesForBlockByCurrency(ctx, blockHeight, currency)
	if err != nil {
		return nil, 0, err
	}
	
	// Calculate proportional payouts
	workerShares := make(map[string]*WorkerShareInfo)
	totalDifficulty := new(big.Int)
	
	for _, share := range shares {
		if share.Valid {
			worker, exists := workerShares[share.WorkerID]
			if !exists {
				workerInfo, err := pc.workerRepo.Get(ctx, share.WorkerID)
				if err != nil {
					continue
				}
				
				worker = &WorkerShareInfo{
					WorkerID:   share.WorkerID,
					Address:    extractWalletFromMetadataWithValidation(workerInfo.Metadata, currency),
					ShareValue: new(big.Int),
					Currency:   currency,
				}
				workerShares[share.WorkerID] = worker
			}
			
			worker.ValidShares++
			
			// Add difficulty as big.Int
			difficultyInt := big.NewInt(int64(share.Difficulty * 1e8))
			worker.ShareValue.Add(worker.ShareValue, difficultyInt)
			totalDifficulty.Add(totalDifficulty, difficultyInt)
		}
	}
	
	// Calculate payouts
	payouts := make([]*WorkerPayout, 0, len(workerShares))
	
	for workerID, info := range workerShares {
		// Calculate percentage
		percentage := new(big.Float).SetInt(info.ShareValue)
		totalFloat := new(big.Float).SetInt(totalDifficulty)
		percentage.Quo(percentage, totalFloat)
		
		// Calculate amount
		amount := new(big.Float).SetInt(reward)
		amount.Mul(amount, percentage)
		amountInt, _ := amount.Int(nil)
		
		// Get percentage as float64
		percentFloat, _ := percentage.Float64()
		
		payout := &WorkerPayout{
			WorkerID:   workerID,
			Address:    info.Address,
			Amount:     amountInt,
			ShareCount: info.ValidShares,
			Percentage: percentFloat * 100,
			Currency:   currency,
		}
		
		payouts = append(payouts, payout)
	}
	
	return payouts, int64(len(shares)), nil
}

// ProcessPayouts creates payout records for distribution
func (pc *PayoutCalculator) ProcessPayouts(ctx context.Context, result *PayoutResult) error {
	// Get payout configuration
	config, err := pc.GetPayoutConfig(result.Currency)
	if err != nil {
		return err
	}
	
	payouts := make([]*database.Payout, 0, len(result.Payouts))
	
	for _, workerPayout := range result.Payouts {
		// Check for unpaid balance
		unpaidBalance := pc.getUnpaidBalance(workerPayout.WorkerID, result.Currency)
		totalAmount := new(big.Int).Add(workerPayout.Amount, unpaidBalance)
		
		if totalAmount.Cmp(config.MinimumPayout) >= 0 {
			// Subtract fee from amount
			payoutAmount := new(big.Int).Sub(totalAmount, config.PayoutFee)
			
			payout := &database.Payout{
				WorkerID: workerPayout.WorkerID,
				Amount:   payoutAmount.Int64(), // Convert for database storage
				Currency: result.Currency,
				Address:  workerPayout.Address,
				Status:   "pending",
			}
			
			payouts = append(payouts, payout)
			
			// Clear unpaid balance
			pc.clearUnpaidBalance(workerPayout.WorkerID, result.Currency)
		} else {
			// Add to unpaid balance
			pc.storeUnpaidAmount(workerPayout.WorkerID, result.Currency, workerPayout.Amount)
		}
	}
	
	// Create payouts in batch
	if len(payouts) > 0 {
		err := pc.payoutRepo.CreateBatch(ctx, payouts)
		if err != nil {
			return err
		}
		
		pc.logger.Info("Created payouts",
			zap.Int64("block_height", result.BlockHeight),
			zap.Int("payout_count", len(payouts)),
			zap.String("currency", result.Currency),
			zap.Int64("total_amount", pc.sumPayoutAmounts(payouts)),
		)
	}
	
	return nil
}

// GetPendingPayouts returns all pending payouts for a currency
func (pc *PayoutCalculator) GetPendingPayouts(ctx context.Context, currency string) ([]*database.Payout, error) {
	return pc.payoutRepo.ListPendingByCurrency(ctx, currency)
}

// GetWorkerEarnings calculates total earnings for a worker across all currencies
func (pc *PayoutCalculator) GetWorkerEarnings(ctx context.Context, workerID string) (map[string]interface{}, error) {
	earningsByCurrency := make(map[string]interface{})
	
	// Get earnings for each currency
	currencies := pc.currencyManager.ListCurrencies()
	for _, curr := range currencies {
		// Get paid amount
		paidAmount, err := pc.payoutRepo.GetWorkerBalanceByCurrency(ctx, workerID, curr.Symbol)
		if err != nil {
			continue
		}
		
		// Get unpaid balance
		unpaidBalance := pc.getUnpaidBalance(workerID, curr.Symbol)
	
	// Get recent shares
	shares, err := pc.shareRepo.GetWorkerShares(ctx, workerID, 1000)
	if err != nil {
		return nil, err
	}
	
	validShares := int64(0)
	totalDifficulty := float64(0)
	for _, share := range shares {
		if share.Valid {
			validShares++
			totalDifficulty += share.Difficulty
		}
	}
	
	// Get payout history
	payouts, err := pc.payoutRepo.GetWorkerPayouts(ctx, workerID, 10)
	if err != nil {
		return nil, err
	}
	
		// Get recent shares
		shares, err := pc.shareRepo.GetWorkerSharesByCurrency(ctx, workerID, curr.Symbol, 1000)
		if err != nil {
			continue
		}
		
		validShares := int64(0)
		totalDifficulty := float64(0)
		for _, share := range shares {
			if share.Valid {
				validShares++
				totalDifficulty += share.Difficulty
			}
		}
		
		// Get payout history
		payouts, err := pc.payoutRepo.GetWorkerPayoutsByCurrency(ctx, workerID, curr.Symbol, 10)
		if err != nil {
			continue
		}
		
		earningsByCurrency[curr.Symbol] = map[string]interface{}{
			"paid_amount":      paidAmount,
			"unpaid_balance":   unpaidBalance.Int64(),
			"total_earnings":   new(big.Int).Add(big.NewInt(paidAmount), unpaidBalance).Int64(),
			"valid_shares":     validShares,
			"total_difficulty": totalDifficulty,
			"recent_payouts":   payouts,
		}
	}
	
	return map[string]interface{}{
		"by_currency": earningsByCurrency,
	}, nil
}

// EstimateEarnings estimates earnings based on hashrate for a currency
func (pc *PayoutCalculator) EstimateEarnings(currency string, hashrate float64, period time.Duration) (map[string]interface{}, error) {
	// Get currency and config
	curr, err := pc.currencyManager.GetCurrency(currency)
	if err != nil {
		return nil, err
	}
	
	config, err := pc.GetPayoutConfig(currency)
	if err != nil {
		return nil, err
	}
	
	// Estimate based on currency block time
	blocksPerPeriod := float64(period) / float64(curr.BlockTime)
	
	// Estimate share submission rate
	shareRate := hashrate / 1e9 // Simplified
	sharesPerBlock := shareRate * curr.BlockTime.Seconds()
	
	// Estimate earnings (simplified - would need network difficulty)
	// This is just a placeholder calculation
	poolShare := sharesPerBlock / float64(config.PPLNSWindow)
	
	return map[string]interface{}{
		"currency":        currency,
		"blocks_per_day":  86400.0 / curr.BlockTime.Seconds(),
		"estimated_share": poolShare,
		"pool_fee":        config.PoolFeePercent,
	}, nil
}

// Private methods

func (pc *PayoutCalculator) calculationRoutine() {
	// Process each currency independently
	for {
		time.Sleep(5 * time.Minute)
		
		pc.configsMu.RLock()
		currencies := make([]string, 0, len(pc.configs))
		for currency := range pc.configs {
			currencies = append(currencies, currency)
		}
		pc.configsMu.RUnlock()
		
		for _, currency := range currencies {
			go pc.processMaturedBlocksForCurrency(currency)
		}
	}
}

func (pc *PayoutCalculator) processMaturedBlocksForCurrency(currency string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	
	config, err := pc.GetPayoutConfig(currency)
	if err != nil {
		return
	}
	
	// Get unprocessed mature blocks for this currency
	blocks, err := pc.blockRepo.GetUnprocessedMatureBlocksByCurrency(ctx, currency, config.CoinbaseMaturity)
	if err != nil {
		pc.logger.Error("Failed to get mature blocks", 
			zap.String("currency", currency),
			zap.Error(err),
		)
		return
	}
	
	for _, block := range blocks {
		// Calculate payouts
		result, err := pc.CalculateBlockPayout(ctx, block.Height, currency)
		if err != nil {
			pc.logger.Error("Failed to calculate payouts",
				zap.Int64("block", block.Height),
				zap.String("currency", currency),
				zap.Error(err),
			)
			continue
		}
		
		// Process payouts
		err = pc.ProcessPayouts(ctx, result)
		if err != nil {
			pc.logger.Error("Failed to process payouts",
				zap.Int64("block", block.Height),
				zap.String("currency", currency),
				zap.Error(err),
			)
			continue
		}
		
		// Mark block as processed
		err = pc.blockRepo.MarkProcessed(ctx, block.Height)
		if err != nil {
			pc.logger.Error("Failed to mark block processed",
				zap.Int64("block", block.Height),
				zap.String("currency", currency),
				zap.Error(err),
			)
		}
	}
}

func (pc *PayoutCalculator) storeUnpaidAmount(workerID, currency string, amount *big.Int) {
	pc.sharesMu.Lock()
	defer pc.sharesMu.Unlock()
	
	if _, exists := pc.workerShares[currency]; !exists {
		pc.workerShares[currency] = make(map[string]*WorkerShareInfo)
	}
	
	worker, exists := pc.workerShares[currency][workerID]
	if !exists {
		worker = &WorkerShareInfo{
			WorkerID:   workerID,
			ShareValue: new(big.Int),
			Currency:   currency,
		}
		pc.workerShares[currency][workerID] = worker
	}
	
	worker.ShareValue.Add(worker.ShareValue, amount)
}

func (pc *PayoutCalculator) getUnpaidBalance(workerID, currency string) *big.Int {
	pc.sharesMu.RLock()
	defer pc.sharesMu.RUnlock()
	
	if currencyWorkers, exists := pc.workerShares[currency]; exists {
		if worker, exists := currencyWorkers[workerID]; exists {
			return new(big.Int).Set(worker.ShareValue)
		}
	}
	
	return new(big.Int)
}

func (pc *PayoutCalculator) clearUnpaidBalance(workerID, currency string) {
	pc.sharesMu.Lock()
	defer pc.sharesMu.Unlock()
	
	if currencyWorkers, exists := pc.workerShares[currency]; exists {
		if worker, exists := currencyWorkers[workerID]; exists {
			worker.ShareValue = new(big.Int)
		}
	}
}

func (pc *PayoutCalculator) sumPayoutAmounts(payouts []*database.Payout) int64 {
	total := int64(0)
	for _, payout := range payouts {
		total += payout.Amount
	}
	return total
}


// GetStats returns payout calculator statistics
func (pc *PayoutCalculator) GetStats() map[string]interface{} {
	pc.sharesMu.RLock()
	defer pc.sharesMu.RUnlock()
	
	unpaidWorkers := 0
	totalUnpaid := float64(0)
	
	for _, worker := range pc.workerShares {
		if worker.ShareValue > 0 {
			unpaidWorkers++
			totalUnpaid += worker.ShareValue
		}
	}
	
	return map[string]interface{}{
		"payout_scheme":     pc.config.Scheme,
		"minimum_payout":    pc.config.MinimumPayout,
		"pool_fee_percent":  pc.config.PoolFeePercent,
		"payout_fee":        pc.config.PayoutFee,
		"unpaid_workers":    unpaidWorkers,
		"total_unpaid":      totalUnpaid,
		"currency":          pc.config.Currency,
		"pplns_window":      pc.config.PPLNSWindow,
	}
}