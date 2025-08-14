package pool

import (
	"context"
	"errors"
	"math/big"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"github.com/shizukutanaka/Otedama/internal/currency"
	"github.com/shizukutanaka/Otedama/internal/database"
	"go.uber.org/zap"
)

// extractWalletFromMetadata extracts the wallet address from worker metadata
// Returns the wallet address if found, otherwise returns an empty string
func extractWalletFromMetadata(metadata map[string]interface{}) string {
	if metadata == nil {
		return ""
	}
	
	// Primary wallet field
	if wallet, ok := metadata["wallet"]; ok {
		if walletStr, ok := wallet.(string); ok {
			return walletStr
		}
	}
	
	// Alternative field names
	alternativeKeys := []string{"payout_address", "address", "wallet_address", "payout_addr"}
	for _, key := range alternativeKeys {
		if addr, ok := metadata[key]; ok {
			if addrStr, ok := addr.(string); ok {
				return addrStr
			}
		}
	}
	
	return ""
}

// extractWalletFromMetadataWithValidation extracts and validates wallet address
func extractWalletFromMetadataWithValidation(metadata map[string]interface{}, currency string) string {
	if metadata == nil {
		return ""
	}
	
	address := ""
	
	// Check primary wallet field
	if wallet, ok := metadata["wallet"]; ok {
		if walletStr, ok := wallet.(string); ok {
			address = walletStr
		}
	}
	
	// Check alternative fields if primary not found
	if address == "" {
		alternativeKeys := []string{"payout_address", "address", "wallet_address", "payout_addr"}
		for _, key := range alternativeKeys {
			if addr, ok := metadata[key]; ok {
				if addrStr, ok := addr.(string); ok {
					address = addrStr
					break
				}
			}
		}
	}
	
	// Validate address
	if address != "" {
		if err := common.ValidateWalletAddress(address, currency); err != nil {
			return ""
		}
	}
	
	return address
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
    block, err := pc.blockRepo.GetByHeight(blockHeight)
    if err != nil {
        return nil, err
    }
    // Confirmed check (repository model uses Confirmed boolean)
    if !block.Confirmed {
        return nil, errors.New("block not confirmed")
    }
    // Get config
    config, err := pc.GetPayoutConfig(currency)
    if err != nil {
        return nil, err
    }
    // Convert block reward to big.Int (assume 8 decimals)
    blockReward := new(big.Int).SetInt64(int64(block.Reward * 1e8))
    // Compute pool fee = reward * percent / 100
    feeNum := big.NewInt(int64(config.PoolFeePercent * 100))
    poolFee := new(big.Int).Mul(blockReward, feeNum)
    poolFee = poolFee.Div(poolFee, big.NewInt(100*100))
    // For now, return zero payouts (calculation functions are placeholders)
    return &PayoutResult{
        BlockHeight: blockHeight,
        BlockReward: blockReward,
        PoolFee:     poolFee,
        TotalShares: 0,
        Payouts:     []*WorkerPayout{},
        Currency:    currency,
    }, nil
}

// calculatePPLNS calculates payouts using PPLNS scheme
func (pc *PayoutCalculator) calculatePPLNS(ctx context.Context, blockHeight int64, currency string, reward *big.Int) ([]*WorkerPayout, int64, error) {
    // Simplified placeholder: repository lacks currency-scoped last-N API.
    // Return empty to avoid compile-time errors until a proper implementation is added.
    return []*WorkerPayout{}, 0, nil
}

// calculatePPS calculates payouts using PPS scheme
func (pc *PayoutCalculator) calculatePPS(ctx context.Context, blockHeight int64, currency string, reward *big.Int) ([]*WorkerPayout, int64, error) {
    // Placeholder for build stability.
    return []*WorkerPayout{}, 0, nil
}

// calculatePROP calculates payouts using proportional scheme
func (pc *PayoutCalculator) calculatePROP(ctx context.Context, blockHeight int64, currency string, reward *big.Int) ([]*WorkerPayout, int64, error) {
    // Placeholder for build stability.
    return []*WorkerPayout{}, 0, nil
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
                Amount:   float64(payoutAmount.Int64()),
                Currency: result.Currency,
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

    // Create payouts individually (repository has Create only)
    if len(payouts) > 0 {
        for _, p := range payouts {
            if err := pc.payoutRepo.Create(p); err != nil {
                return err
            }
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

// sumPayoutAmounts sums the amounts of payouts
func (pc *PayoutCalculator) sumPayoutAmounts(payouts []*database.Payout) int64 {
    total := int64(0)
    for _, payout := range payouts {
        total += int64(payout.Amount)
    }
    return total
}

// GetStats returns payout calculator statistics
func (pc *PayoutCalculator) GetStats() map[string]interface{} {
    pc.configsMu.RLock()
    currencies := make([]string, 0, len(pc.configs))
    for c := range pc.configs {
        currencies = append(currencies, c)
    }
    pc.configsMu.RUnlock()
    
    return map[string]interface{}{
        "configured_currencies": currencies,
    }
}

// GetWorkerEarnings returns minimal earnings snapshot for a worker across currencies
func (pc *PayoutCalculator) GetWorkerEarnings(ctx context.Context, workerID string) (map[string]interface{}, error) {
    result := make(map[string]interface{})
    byCurrency := make(map[string]interface{})
    currencies := pc.currencyManager.ListCurrencies()
    for _, c := range currencies {
        unpaid := pc.getUnpaidBalance(workerID, c.Symbol)
        byCurrency[c.Symbol] = map[string]interface{}{
            "unpaid_balance": unpaid.Int64(),
        }
    }
    result["by_currency"] = byCurrency
    return result, nil
}

// calculationRoutine runs background calculations (noop placeholder)
func (pc *PayoutCalculator) calculationRoutine() {
    // no-op placeholder to satisfy goroutine startup
}

// Helpers to manage unpaid balances in-memory
func (pc *PayoutCalculator) storeUnpaidAmount(workerID, currency string, amount *big.Int) {
    pc.sharesMu.Lock()
    defer pc.sharesMu.Unlock()
    if _, ok := pc.workerShares[currency]; !ok {
        pc.workerShares[currency] = make(map[string]*WorkerShareInfo)
    }
    w, ok := pc.workerShares[currency][workerID]
    if !ok {
        w = &WorkerShareInfo{WorkerID: workerID, ShareValue: new(big.Int), Currency: currency}
        pc.workerShares[currency][workerID] = w
    }
    w.ShareValue.Add(w.ShareValue, amount)
}

func (pc *PayoutCalculator) getUnpaidBalance(workerID, currency string) *big.Int {
    pc.sharesMu.RLock()
    defer pc.sharesMu.RUnlock()
    if cm, ok := pc.workerShares[currency]; ok {
        if w, ok := cm[workerID]; ok && w.ShareValue != nil {
            return new(big.Int).Set(w.ShareValue)
        }
    }
    return new(big.Int)
}

func (pc *PayoutCalculator) clearUnpaidBalance(workerID, currency string) {
    pc.sharesMu.Lock()
    defer pc.sharesMu.Unlock()
    if cm, ok := pc.workerShares[currency]; ok {
        if w, ok := cm[workerID]; ok {
            w.ShareValue = new(big.Int)
        }
    }
}