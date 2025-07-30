package currency

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MultiCurrencyManager handles multiple cryptocurrency support
type MultiCurrencyManager struct {
	logger *zap.Logger
	config Config
	
	// Currency handlers
	currencies map[string]*Currency
	handlers   map[string]CurrencyHandler
	mu         sync.RWMutex
	
	// Exchange rates
	exchangeRates map[string]map[string]*ExchangeRate
	ratesLock     sync.RWMutex
	
	// Wallets
	wallets map[string]*Wallet
	
	// Payout manager
	payoutManager *PayoutManager
	
	// Statistics
	stats *CurrencyStats
}

// Config defines multi-currency configuration
type Config struct {
	// Supported currencies
	Currencies []CurrencyConfig `yaml:"currencies"`
	
	// Exchange settings
	ExchangeUpdateInterval time.Duration `yaml:"exchange_update_interval"`
	ExchangeAPIs          []string      `yaml:"exchange_apis"`
	
	// Payout settings
	PayoutInterval        time.Duration `yaml:"payout_interval"`
	MinPayoutThreshold    string        `yaml:"min_payout_threshold"`
	PayoutBatchSize       int           `yaml:"payout_batch_size"`
	
	// Fee settings
	ExchangeFeePercent    float64       `yaml:"exchange_fee_percent"`
	WithdrawalFeePercent  float64       `yaml:"withdrawal_fee_percent"`
}

// CurrencyConfig defines configuration for a specific currency
type CurrencyConfig struct {
	Symbol          string  `yaml:"symbol"`
	Name            string  `yaml:"name"`
	Enabled         bool    `yaml:"enabled"`
	Decimals        int     `yaml:"decimals"`
	MinConfirmations int    `yaml:"min_confirmations"`
	NetworkFee      string  `yaml:"network_fee"`
	WalletAddress   string  `yaml:"wallet_address"`
	NodeURL         string  `yaml:"node_url"`
	ChainID         int64   `yaml:"chain_id"`
}

// Currency represents a supported cryptocurrency
type Currency struct {
	Symbol          string
	Name            string
	Decimals        int
	MinConfirmations int
	NetworkFee      *big.Int
	ChainID         int64
	
	// State
	Enabled         atomic.Bool
	LastBlockHeight atomic.Uint64
	LastUpdateTime  atomic.Value // time.Time
}

// CurrencyHandler interface for currency-specific operations
type CurrencyHandler interface {
	// Blockchain operations
	GetBalance(address string) (*big.Int, error)
	GetTransaction(txHash string) (*Transaction, error)
	SendTransaction(tx *Transaction) (string, error)
	GetBlockHeight() (uint64, error)
	ValidateAddress(address string) bool
	
	// Mining specific
	SubmitBlock(block []byte) error
	GetWork() ([]byte, error)
}

// Wallet represents a currency wallet
type Wallet struct {
	Currency string
	Address  string
	Balance  *big.Int
	mu       sync.RWMutex
}

// Transaction represents a blockchain transaction
type Transaction struct {
	Hash          string
	From          string
	To            string
	Amount        *big.Int
	Fee           *big.Int
	Confirmations int
	Timestamp     time.Time
	Status        TransactionStatus
}

// TransactionStatus represents transaction status
type TransactionStatus int

const (
	StatusPending TransactionStatus = iota
	StatusConfirmed
	StatusFailed
)

// ExchangeRate represents exchange rate between currencies
type ExchangeRate struct {
	From      string
	To        string
	Rate      float64
	Timestamp time.Time
	Source    string
}

// CurrencyStats tracks currency statistics
type CurrencyStats struct {
	TotalReceived   map[string]*big.Int
	TotalSent       map[string]*big.Int
	TotalExchanged  map[string]*big.Int
	TransactionCount map[string]uint64
	mu              sync.RWMutex
}

// PayoutManager handles automatic payouts
type PayoutManager struct {
	logger        *zap.Logger
	manager       *MultiCurrencyManager
	pendingPayouts map[string][]*Payout
	mu            sync.RWMutex
}

// Payout represents a pending payout
type Payout struct {
	Currency  string
	Address   string
	Amount    *big.Int
	Scheduled time.Time
	Attempts  int
	LastError error
}

// NewMultiCurrencyManager creates a new multi-currency manager
func NewMultiCurrencyManager(logger *zap.Logger, config Config) (*MultiCurrencyManager, error) {
	mcm := &MultiCurrencyManager{
		logger:        logger,
		config:        config,
		currencies:    make(map[string]*Currency),
		handlers:      make(map[string]CurrencyHandler),
		exchangeRates: make(map[string]map[string]*ExchangeRate),
		wallets:       make(map[string]*Wallet),
		stats: &CurrencyStats{
			TotalReceived:    make(map[string]*big.Int),
			TotalSent:        make(map[string]*big.Int),
			TotalExchanged:   make(map[string]*big.Int),
			TransactionCount: make(map[string]uint64),
		},
	}
	
	// Initialize currencies
	for _, currConfig := range config.Currencies {
		if !currConfig.Enabled {
			continue
		}
		
		currency := &Currency{
			Symbol:           currConfig.Symbol,
			Name:             currConfig.Name,
			Decimals:         currConfig.Decimals,
			MinConfirmations: currConfig.MinConfirmations,
			ChainID:          currConfig.ChainID,
		}
		
		// Parse network fee
		fee, ok := new(big.Int).SetString(currConfig.NetworkFee, 10)
		if !ok {
			fee = big.NewInt(0)
		}
		currency.NetworkFee = fee
		
		currency.Enabled.Store(true)
		mcm.currencies[currConfig.Symbol] = currency
		
		// Create handler based on currency type
		handler, err := mcm.createHandler(currConfig)
		if err != nil {
			logger.Warn("Failed to create currency handler",
				zap.String("currency", currConfig.Symbol),
				zap.Error(err),
			)
			continue
		}
		
		mcm.handlers[currConfig.Symbol] = handler
		
		// Initialize wallet
		mcm.wallets[currConfig.Symbol] = &Wallet{
			Currency: currConfig.Symbol,
			Address:  currConfig.WalletAddress,
			Balance:  big.NewInt(0),
		}
		
		logger.Info("Initialized currency",
			zap.String("symbol", currConfig.Symbol),
			zap.String("name", currConfig.Name),
		)
	}
	
	// Initialize payout manager
	mcm.payoutManager = &PayoutManager{
		logger:         logger,
		manager:        mcm,
		pendingPayouts: make(map[string][]*Payout),
	}
	
	return mcm, nil
}

// Start begins currency operations
func (mcm *MultiCurrencyManager) Start(ctx context.Context) error {
	mcm.logger.Info("Starting multi-currency manager")
	
	// Start exchange rate updater
	go mcm.exchangeRateUpdater(ctx)
	
	// Start balance updater
	go mcm.balanceUpdater(ctx)
	
	// Start payout processor
	go mcm.payoutManager.processPayouts(ctx)
	
	return nil
}

// GetSupportedCurrencies returns list of supported currencies
func (mcm *MultiCurrencyManager) GetSupportedCurrencies() []string {
	mcm.mu.RLock()
	defer mcm.mu.RUnlock()
	
	var currencies []string
	for symbol, currency := range mcm.currencies {
		if currency.Enabled.Load() {
			currencies = append(currencies, symbol)
		}
	}
	
	return currencies
}

// GetBalance returns balance for a currency
func (mcm *MultiCurrencyManager) GetBalance(currency string) (*big.Int, error) {
	mcm.mu.RLock()
	wallet, exists := mcm.wallets[currency]
	mcm.mu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("currency not supported: %s", currency)
	}
	
	wallet.mu.RLock()
	defer wallet.mu.RUnlock()
	
	return new(big.Int).Set(wallet.Balance), nil
}

// Exchange converts between currencies
func (mcm *MultiCurrencyManager) Exchange(from, to string, amount *big.Int) (*big.Int, error) {
	// Get exchange rate
	rate, err := mcm.GetExchangeRate(from, to)
	if err != nil {
		return nil, fmt.Errorf("failed to get exchange rate: %w", err)
	}
	
	// Calculate converted amount
	amountFloat := new(big.Float).SetInt(amount)
	rateFloat := big.NewFloat(rate.Rate)
	resultFloat := new(big.Float).Mul(amountFloat, rateFloat)
	
	// Apply exchange fee
	feeMultiplier := big.NewFloat(1 - mcm.config.ExchangeFeePercent/100)
	resultFloat.Mul(resultFloat, feeMultiplier)
	
	// Convert back to big.Int
	result, _ := resultFloat.Int(nil)
	
	// Update statistics
	mcm.updateExchangeStats(from, to, amount, result)
	
	mcm.logger.Info("Currency exchanged",
		zap.String("from", from),
		zap.String("to", to),
		zap.String("amount", amount.String()),
		zap.String("result", result.String()),
		zap.Float64("rate", rate.Rate),
	)
	
	return result, nil
}

// GetExchangeRate returns exchange rate between currencies
func (mcm *MultiCurrencyManager) GetExchangeRate(from, to string) (*ExchangeRate, error) {
	mcm.ratesLock.RLock()
	defer mcm.ratesLock.RUnlock()
	
	if from == to {
		return &ExchangeRate{
			From:      from,
			To:        to,
			Rate:      1.0,
			Timestamp: time.Now(),
		}, nil
	}
	
	// Direct rate
	if rates, exists := mcm.exchangeRates[from]; exists {
		if rate, exists := rates[to]; exists {
			return rate, nil
		}
	}
	
	// Try reverse rate
	if rates, exists := mcm.exchangeRates[to]; exists {
		if rate, exists := rates[from]; exists {
			return &ExchangeRate{
				From:      from,
				To:        to,
				Rate:      1.0 / rate.Rate,
				Timestamp: rate.Timestamp,
				Source:    rate.Source,
			}, nil
		}
	}
	
	// Try through USD
	var fromUSD, toUSD *ExchangeRate
	
	if rates, exists := mcm.exchangeRates[from]; exists {
		fromUSD = rates["USD"]
	}
	
	if rates, exists := mcm.exchangeRates[to]; exists {
		toUSD = rates["USD"]
	}
	
	if fromUSD != nil && toUSD != nil {
		return &ExchangeRate{
			From:      from,
			To:        to,
			Rate:      fromUSD.Rate / toUSD.Rate,
			Timestamp: time.Now(),
			Source:    "calculated",
		}, nil
	}
	
	return nil, fmt.Errorf("no exchange rate available for %s to %s", from, to)
}

// SchedulePayout schedules a payout
func (mcm *MultiCurrencyManager) SchedulePayout(currency, address string, amount *big.Int) error {
	// Validate currency
	if _, exists := mcm.currencies[currency]; !exists {
		return fmt.Errorf("unsupported currency: %s", currency)
	}
	
	// Validate address
	if handler, exists := mcm.handlers[currency]; exists {
		if !handler.ValidateAddress(address) {
			return fmt.Errorf("invalid address: %s", address)
		}
	}
	
	// Check minimum threshold
	minThreshold, _ := new(big.Int).SetString(mcm.config.MinPayoutThreshold, 10)
	if amount.Cmp(minThreshold) < 0 {
		return fmt.Errorf("amount below minimum threshold")
	}
	
	payout := &Payout{
		Currency:  currency,
		Address:   address,
		Amount:    amount,
		Scheduled: time.Now(),
	}
	
	mcm.payoutManager.addPayout(payout)
	
	return nil
}

// CreateHandler creates a currency-specific handler
func (mcm *MultiCurrencyManager) createHandler(config CurrencyConfig) (CurrencyHandler, error) {
	switch config.Symbol {
	case "BTC":
		return NewBitcoinHandler(config)
	case "ETH":
		return NewEthereumHandler(config)
	case "LTC":
		return NewLitecoinHandler(config)
	default:
		return NewGenericHandler(config)
	}
}

// Background routines

func (mcm *MultiCurrencyManager) exchangeRateUpdater(ctx context.Context) {
	ticker := time.NewTicker(mcm.config.ExchangeUpdateInterval)
	defer ticker.Stop()
	
	// Initial update
	mcm.updateExchangeRates()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			mcm.updateExchangeRates()
		}
	}
}

func (mcm *MultiCurrencyManager) updateExchangeRates() {
	// Fetch rates from configured APIs
	for _, apiURL := range mcm.config.ExchangeAPIs {
		rates, err := mcm.fetchExchangeRates(apiURL)
		if err != nil {
			mcm.logger.Warn("Failed to fetch exchange rates",
				zap.String("api", apiURL),
				zap.Error(err),
			)
			continue
		}
		
		// Update rates
		mcm.ratesLock.Lock()
		for _, rate := range rates {
			if mcm.exchangeRates[rate.From] == nil {
				mcm.exchangeRates[rate.From] = make(map[string]*ExchangeRate)
			}
			mcm.exchangeRates[rate.From][rate.To] = rate
		}
		mcm.ratesLock.Unlock()
		
		mcm.logger.Debug("Updated exchange rates",
			zap.String("source", apiURL),
			zap.Int("rates", len(rates)),
		)
		
		break // Use first successful API
	}
}

func (mcm *MultiCurrencyManager) fetchExchangeRates(apiURL string) ([]*ExchangeRate, error) {
	// Implementation depends on specific API
	// This is a placeholder
	return []*ExchangeRate{
		{
			From:      "BTC",
			To:        "USD",
			Rate:      43000.0,
			Timestamp: time.Now(),
			Source:    apiURL,
		},
		{
			From:      "ETH",
			To:        "USD",
			Rate:      2300.0,
			Timestamp: time.Now(),
			Source:    apiURL,
		},
	}, nil
}

func (mcm *MultiCurrencyManager) balanceUpdater(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			mcm.updateBalances()
		}
	}
}

func (mcm *MultiCurrencyManager) updateBalances() {
	mcm.mu.RLock()
	defer mcm.mu.RUnlock()
	
	for currency, wallet := range mcm.wallets {
		handler, exists := mcm.handlers[currency]
		if !exists {
			continue
		}
		
		balance, err := handler.GetBalance(wallet.Address)
		if err != nil {
			mcm.logger.Warn("Failed to update balance",
				zap.String("currency", currency),
				zap.Error(err),
			)
			continue
		}
		
		wallet.mu.Lock()
		wallet.Balance = balance
		wallet.mu.Unlock()
	}
}

func (mcm *MultiCurrencyManager) updateExchangeStats(from, to string, fromAmount, toAmount *big.Int) {
	mcm.stats.mu.Lock()
	defer mcm.stats.mu.Unlock()
	
	// Initialize if needed
	if mcm.stats.TotalExchanged[from] == nil {
		mcm.stats.TotalExchanged[from] = big.NewInt(0)
	}
	if mcm.stats.TotalExchanged[to] == nil {
		mcm.stats.TotalExchanged[to] = big.NewInt(0)
	}
	
	// Update totals
	mcm.stats.TotalExchanged[from].Add(mcm.stats.TotalExchanged[from], fromAmount)
	mcm.stats.TotalExchanged[to].Add(mcm.stats.TotalExchanged[to], toAmount)
	mcm.stats.TransactionCount[from]++
	mcm.stats.TransactionCount[to]++
}

// PayoutManager implementation

func (pm *PayoutManager) addPayout(payout *Payout) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	pm.pendingPayouts[payout.Currency] = append(pm.pendingPayouts[payout.Currency], payout)
}

func (pm *PayoutManager) processPayouts(ctx context.Context) {
	ticker := time.NewTicker(pm.manager.config.PayoutInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pm.processPendingPayouts()
		}
	}
}

func (pm *PayoutManager) processPendingPayouts() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	for currency, payouts := range pm.pendingPayouts {
		if len(payouts) == 0 {
			continue
		}
		
		// Process in batches
		batchSize := pm.manager.config.PayoutBatchSize
		if batchSize == 0 {
			batchSize = 100
		}
		
		for i := 0; i < len(payouts); i += batchSize {
			end := i + batchSize
			if end > len(payouts) {
				end = len(payouts)
			}
			
			batch := payouts[i:end]
			pm.processBatch(currency, batch)
		}
		
		// Clear processed payouts
		pm.pendingPayouts[currency] = nil
	}
}

func (pm *PayoutManager) processBatch(currency string, payouts []*Payout) {
	handler, exists := pm.manager.handlers[currency]
	if !exists {
		pm.logger.Error("No handler for currency", zap.String("currency", currency))
		return
	}
	
	for _, payout := range payouts {
		tx := &Transaction{
			To:     payout.Address,
			Amount: payout.Amount,
			Fee:    pm.manager.currencies[currency].NetworkFee,
		}
		
		txHash, err := handler.SendTransaction(tx)
		if err != nil {
			payout.LastError = err
			payout.Attempts++
			
			pm.logger.Error("Payout failed",
				zap.String("currency", currency),
				zap.String("address", payout.Address),
				zap.String("amount", payout.Amount.String()),
				zap.Error(err),
			)
			
			// Re-add if not max attempts
			if payout.Attempts < 3 {
				pm.pendingPayouts[currency] = append(pm.pendingPayouts[currency], payout)
			}
		} else {
			pm.logger.Info("Payout sent",
				zap.String("currency", currency),
				zap.String("tx_hash", txHash),
				zap.String("address", payout.Address),
				zap.String("amount", payout.Amount.String()),
			)
		}
	}
}