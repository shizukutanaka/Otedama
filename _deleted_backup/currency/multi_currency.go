package currency

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MultiCurrencyManager manages multiple cryptocurrency support
type MultiCurrencyManager struct {
	logger         *zap.Logger
	config         MultiCurrencyConfig
	currencies     sync.Map // symbol -> *Currency
	wallets        sync.Map // symbol -> *Wallet
	exchangeRates  *ExchangeRateManager
	converter      *CurrencyConverter
	validator      *AddressValidator
	feeCalculator  *FeeCalculator
	stats          *CurrencyStats
	mu             sync.RWMutex
}

// MultiCurrencyConfig contains multi-currency configuration
type MultiCurrencyConfig struct {
	// Supported currencies
	EnabledCurrencies []string
	BaseCurrency      string
	
	// Exchange rate settings
	UpdateInterval    time.Duration
	RateProviders     []string
	
	// Transaction settings
	MinConfirmations  map[string]int
	TransactionFees   map[string]*big.Int
	
	// Wallet settings
	WalletPath        string
	EncryptWallets    bool
	
	// Network settings
	NetworkTimeout    time.Duration
	MaxRetries        int
}

// Currency represents a cryptocurrency
type Currency struct {
	Symbol          string
	Name            string
	Type            CurrencyType
	Algorithm       string
	Decimals        int
	MinAmount       *big.Int
	MaxAmount       *big.Int
	Confirmations   int
	BlockTime       time.Duration
	NetworkFee      *big.Int
	Enabled         bool
	NetworkParams   NetworkParams
}

// CurrencyType represents the type of currency
type CurrencyType string

const (
	CurrencyTypeBitcoin  CurrencyType = "bitcoin"
	CurrencyTypeEthereum CurrencyType = "ethereum"
	CurrencyTypeMonero   CurrencyType = "monero"
	CurrencyTypeLitecoin CurrencyType = "litecoin"
	CurrencyTypeCustom   CurrencyType = "custom"
)

// NetworkParams contains network-specific parameters
type NetworkParams struct {
	ChainID         *big.Int
	NetworkID       string
	RPCEndpoint     string
	ExplorerURL     string
	P2PPort         int
	RPCPort         int
	TestNet         bool
}

// Wallet represents a cryptocurrency wallet
type Wallet struct {
	Currency      string
	Address       string
	PrivateKey    []byte // Encrypted
	PublicKey     []byte
	Balance       *big.Int
	PendingBalance *big.Int
	LastSync      time.Time
	Transactions  []*Transaction
	mu            sync.RWMutex
}

// Transaction represents a cryptocurrency transaction
type Transaction struct {
	ID            string
	Currency      string
	Type          TransactionType
	From          string
	To            string
	Amount        *big.Int
	Fee           *big.Int
	Hash          string
	BlockNumber   uint64
	Confirmations int
	Status        TransactionStatus
	Timestamp     time.Time
	Metadata      map[string]interface{}
}

// TransactionType represents transaction type
type TransactionType string

const (
	TransactionTypeDeposit  TransactionType = "deposit"
	TransactionTypeWithdraw TransactionType = "withdraw"
	TransactionTypeMining   TransactionType = "mining"
	TransactionTypeFee      TransactionType = "fee"
)

// TransactionStatus represents transaction status
type TransactionStatus string

const (
	TransactionStatusPending   TransactionStatus = "pending"
	TransactionStatusConfirmed TransactionStatus = "confirmed"
	TransactionStatusFailed    TransactionStatus = "failed"
	TransactionStatusOrphaned  TransactionStatus = "orphaned"
)

// ExchangeRateManager manages exchange rates
type ExchangeRateManager struct {
	rates     sync.Map // "FROM-TO" -> *ExchangeRate
	providers []RateProvider
	mu        sync.RWMutex
}

// ExchangeRate represents an exchange rate
type ExchangeRate struct {
	From      string
	To        string
	Rate      float64
	Timestamp time.Time
	Provider  string
}

// RateProvider interface for exchange rate providers
type RateProvider interface {
	GetRate(from, to string) (float64, error)
	GetName() string
}

// CurrencyConverter converts between currencies
type CurrencyConverter struct {
	rates *ExchangeRateManager
}

// AddressValidator validates cryptocurrency addresses
type AddressValidator struct {
	validators map[string]AddressValidatorFunc
}

// AddressValidatorFunc validates an address for a currency
type AddressValidatorFunc func(address string) bool

// FeeCalculator calculates transaction fees
type FeeCalculator struct {
	baseFees     map[string]*big.Int
	dynamicFees  sync.Map // currency -> current fee
	feeProviders map[string]FeeProvider
}

// FeeProvider interface for fee estimation
type FeeProvider interface {
	EstimateFee(currency string, priority string) (*big.Int, error)
}

// CurrencyStats tracks currency statistics
type CurrencyStats struct {
	TotalTransactions   sync.Map // currency -> count
	TotalVolume         sync.Map // currency -> amount
	FailedTransactions  sync.Map // currency -> count
	AverageConfirmTime  sync.Map // currency -> duration
	LastBlockTime       sync.Map // currency -> time.Time
}

// NewMultiCurrencyManager creates a new multi-currency manager
func NewMultiCurrencyManager(config MultiCurrencyConfig, logger *zap.Logger) (*MultiCurrencyManager, error) {
	if config.BaseCurrency == "" {
		config.BaseCurrency = "USD"
	}
	if config.UpdateInterval == 0 {
		config.UpdateInterval = 5 * time.Minute
	}
	if config.NetworkTimeout == 0 {
		config.NetworkTimeout = 30 * time.Second
	}

	mcm := &MultiCurrencyManager{
		logger:        logger,
		config:        config,
		exchangeRates: NewExchangeRateManager(),
		converter:     NewCurrencyConverter(nil), // Will set rates later
		validator:     NewAddressValidator(),
		feeCalculator: NewFeeCalculator(),
		stats:         &CurrencyStats{},
	}

	// Set converter rates
	mcm.converter.rates = mcm.exchangeRates

	// Initialize supported currencies
	mcm.initializeCurrencies()

	// Initialize wallets
	if err := mcm.initializeWallets(); err != nil {
		return nil, fmt.Errorf("failed to initialize wallets: %w", err)
	}

	return mcm, nil
}

// initializeCurrencies initializes supported currencies
func (mcm *MultiCurrencyManager) initializeCurrencies() {
	// Bitcoin
	mcm.addCurrency(&Currency{
		Symbol:        "BTC",
		Name:          "Bitcoin",
		Type:          CurrencyTypeBitcoin,
		Algorithm:     "SHA256",
		Decimals:      8,
		MinAmount:     big.NewInt(546), // Dust limit in satoshis
		Confirmations: 6,
		BlockTime:     10 * time.Minute,
		NetworkParams: NetworkParams{
			NetworkID:   "mainnet",
			P2PPort:     8333,
			RPCPort:     8332,
			ExplorerURL: "https://blockstream.info",
		},
		Enabled: mcm.isCurrencyEnabled("BTC"),
	})

	// Ethereum
	mcm.addCurrency(&Currency{
		Symbol:        "ETH",
		Name:          "Ethereum",
		Type:          CurrencyTypeEthereum,
		Algorithm:     "Ethash",
		Decimals:      18,
		MinAmount:     big.NewInt(1), // 1 wei
		Confirmations: 12,
		BlockTime:     15 * time.Second,
		NetworkParams: NetworkParams{
			ChainID:     big.NewInt(1),
			NetworkID:   "1",
			P2PPort:     30303,
			RPCPort:     8545,
			ExplorerURL: "https://etherscan.io",
		},
		Enabled: mcm.isCurrencyEnabled("ETH"),
	})

	// Litecoin
	mcm.addCurrency(&Currency{
		Symbol:        "LTC",
		Name:          "Litecoin",
		Type:          CurrencyTypeLitecoin,
		Algorithm:     "Scrypt",
		Decimals:      8,
		MinAmount:     big.NewInt(54600), // Dust limit
		Confirmations: 6,
		BlockTime:     2*time.Minute + 30*time.Second,
		NetworkParams: NetworkParams{
			NetworkID:   "mainnet",
			P2PPort:     9333,
			RPCPort:     9332,
			ExplorerURL: "https://blockchair.com/litecoin",
		},
		Enabled: mcm.isCurrencyEnabled("LTC"),
	})

	// Monero
	mcm.addCurrency(&Currency{
		Symbol:        "XMR",
		Name:          "Monero",
		Type:          CurrencyTypeMonero,
		Algorithm:     "RandomX",
		Decimals:      12,
		MinAmount:     big.NewInt(1),
		Confirmations: 10,
		BlockTime:     2 * time.Minute,
		NetworkParams: NetworkParams{
			NetworkID:   "mainnet",
			P2PPort:     18080,
			RPCPort:     18081,
			ExplorerURL: "https://xmrchain.net",
		},
		Enabled: mcm.isCurrencyEnabled("XMR"),
	})
}

// addCurrency adds a currency to the manager
func (mcm *MultiCurrencyManager) addCurrency(currency *Currency) {
	mcm.currencies.Store(currency.Symbol, currency)
	
	// Initialize stats
	mcm.stats.TotalTransactions.Store(currency.Symbol, uint64(0))
	mcm.stats.TotalVolume.Store(currency.Symbol, big.NewInt(0))
	mcm.stats.FailedTransactions.Store(currency.Symbol, uint64(0))
}

// isCurrencyEnabled checks if a currency is enabled
func (mcm *MultiCurrencyManager) isCurrencyEnabled(symbol string) bool {
	if len(mcm.config.EnabledCurrencies) == 0 {
		return true // All enabled by default
	}
	
	for _, enabled := range mcm.config.EnabledCurrencies {
		if enabled == symbol {
			return true
		}
	}
	return false
}

// initializeWallets initializes wallets for enabled currencies
func (mcm *MultiCurrencyManager) initializeWallets() error {
	mcm.currencies.Range(func(key, value interface{}) bool {
		currency := value.(*Currency)
		if !currency.Enabled {
			return true
		}

		wallet, err := mcm.createWallet(currency.Symbol)
		if err != nil {
			mcm.logger.Warn("Failed to create wallet",
				zap.String("currency", currency.Symbol),
				zap.Error(err))
		} else {
			mcm.wallets.Store(currency.Symbol, wallet)
		}
		
		return true
	})

	return nil
}

// createWallet creates a new wallet for a currency
func (mcm *MultiCurrencyManager) createWallet(symbol string) (*Wallet, error) {
	// This is a simplified implementation
	// In production, would use proper key generation
	
	wallet := &Wallet{
		Currency:       symbol,
		Address:        mcm.generateAddress(symbol),
		Balance:        big.NewInt(0),
		PendingBalance: big.NewInt(0),
		LastSync:       time.Now(),
		Transactions:   make([]*Transaction, 0),
	}

	return wallet, nil
}

// Start starts the multi-currency manager
func (mcm *MultiCurrencyManager) Start(ctx context.Context) error {
	mcm.logger.Info("Starting multi-currency manager",
		zap.Int("currencies", mcm.getEnabledCount()))

	// Start exchange rate updates
	go mcm.updateExchangeRates(ctx)

	// Start wallet sync
	go mcm.syncWallets(ctx)

	// Start transaction monitoring
	go mcm.monitorTransactions(ctx)

	return nil
}

// GetBalance gets balance for a currency
func (mcm *MultiCurrencyManager) GetBalance(symbol string) (*big.Int, error) {
	wallet, err := mcm.getWallet(symbol)
	if err != nil {
		return nil, err
	}

	wallet.mu.RLock()
	defer wallet.mu.RUnlock()
	
	return new(big.Int).Set(wallet.Balance), nil
}

// GetBalances gets all balances
func (mcm *MultiCurrencyManager) GetBalances() map[string]*big.Int {
	balances := make(map[string]*big.Int)
	
	mcm.wallets.Range(func(key, value interface{}) bool {
		symbol := key.(string)
		wallet := value.(*Wallet)
		
		wallet.mu.RLock()
		balances[symbol] = new(big.Int).Set(wallet.Balance)
		wallet.mu.RUnlock()
		
		return true
	})

	return balances
}

// Convert converts amount between currencies
func (mcm *MultiCurrencyManager) Convert(amount *big.Int, from, to string) (*big.Int, error) {
	if from == to {
		return new(big.Int).Set(amount), nil
	}

	rate, err := mcm.exchangeRates.GetRate(from, to)
	if err != nil {
		return nil, fmt.Errorf("failed to get exchange rate: %w", err)
	}

	// Get decimal places for target currency
	toCurrency, err := mcm.getCurrency(to)
	if err != nil {
		return nil, err
	}

	// Convert using rate
	result := mcm.converter.Convert(amount, rate.Rate, toCurrency.Decimals)
	
	return result, nil
}

// SendTransaction sends a transaction
func (mcm *MultiCurrencyManager) SendTransaction(symbol, to string, amount *big.Int) (*Transaction, error) {
	// Validate currency
	currency, err := mcm.getCurrency(symbol)
	if err != nil {
		return nil, err
	}

	// Validate address
	if !mcm.validator.ValidateAddress(symbol, to) {
		return nil, fmt.Errorf("invalid address for %s", symbol)
	}

	// Check balance
	balance, err := mcm.GetBalance(symbol)
	if err != nil {
		return nil, err
	}

	// Calculate fee
	fee, err := mcm.feeCalculator.CalculateFee(symbol, "normal")
	if err != nil {
		return nil, err
	}

	totalRequired := new(big.Int).Add(amount, fee)
	if balance.Cmp(totalRequired) < 0 {
		return nil, fmt.Errorf("insufficient balance: have %s, need %s", 
			balance.String(), totalRequired.String())
	}

	// Create transaction
	tx := &Transaction{
		ID:        mcm.generateTransactionID(),
		Currency:  symbol,
		Type:      TransactionTypeWithdraw,
		From:      mcm.getWalletAddress(symbol),
		To:        to,
		Amount:    amount,
		Fee:       fee,
		Status:    TransactionStatusPending,
		Timestamp: time.Now(),
	}

	// Send transaction (placeholder)
	txHash, err := mcm.broadcastTransaction(currency, tx)
	if err != nil {
		tx.Status = TransactionStatusFailed
		mcm.recordFailedTransaction(symbol)
		return nil, err
	}

	tx.Hash = txHash

	// Update wallet
	wallet, _ := mcm.getWallet(symbol)
	wallet.mu.Lock()
	wallet.Balance.Sub(wallet.Balance, totalRequired)
	wallet.PendingBalance.Add(wallet.PendingBalance, amount)
	wallet.Transactions = append(wallet.Transactions, tx)
	wallet.mu.Unlock()

	// Update stats
	mcm.updateTransactionStats(symbol, amount)

	mcm.logger.Info("Transaction sent",
		zap.String("currency", symbol),
		zap.String("to", to),
		zap.String("amount", amount.String()),
		zap.String("tx_hash", txHash))

	return tx, nil
}

// updateExchangeRates updates exchange rates periodically
func (mcm *MultiCurrencyManager) updateExchangeRates(ctx context.Context) {
	ticker := time.NewTicker(mcm.config.UpdateInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			mcm.fetchExchangeRates()
		}
	}
}

// fetchExchangeRates fetches latest exchange rates
func (mcm *MultiCurrencyManager) fetchExchangeRates() {
	currencies := mcm.getEnabledCurrencies()
	
	for _, from := range currencies {
		for _, to := range currencies {
			if from == to {
				continue
			}

			// Try each provider
			for _, provider := range mcm.exchangeRates.providers {
				rate, err := provider.GetRate(from, to)
				if err != nil {
					continue
				}

				mcm.exchangeRates.UpdateRate(&ExchangeRate{
					From:      from,
					To:        to,
					Rate:      rate,
					Timestamp: time.Now(),
					Provider:  provider.GetName(),
				})
				break
			}
		}
		
		// Also get rate to base currency
		if from != mcm.config.BaseCurrency {
			for _, provider := range mcm.exchangeRates.providers {
				rate, err := provider.GetRate(from, mcm.config.BaseCurrency)
				if err == nil {
					mcm.exchangeRates.UpdateRate(&ExchangeRate{
						From:      from,
						To:        mcm.config.BaseCurrency,
						Rate:      rate,
						Timestamp: time.Now(),
						Provider:  provider.GetName(),
					})
					break
				}
			}
		}
	}
}

// syncWallets syncs wallet balances
func (mcm *MultiCurrencyManager) syncWallets(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			mcm.wallets.Range(func(key, value interface{}) bool {
				symbol := key.(string)
				wallet := value.(*Wallet)
				
				if err := mcm.syncWallet(symbol, wallet); err != nil {
					mcm.logger.Error("Wallet sync failed",
						zap.String("currency", symbol),
						zap.Error(err))
				}
				
				return true
			})
		}
	}
}

// syncWallet syncs a single wallet
func (mcm *MultiCurrencyManager) syncWallet(symbol string, wallet *Wallet) error {
	// This would connect to the actual blockchain
	// For now, it's a placeholder
	
	wallet.mu.Lock()
	wallet.LastSync = time.Now()
	wallet.mu.Unlock()
	
	return nil
}

// monitorTransactions monitors pending transactions
func (mcm *MultiCurrencyManager) monitorTransactions(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			mcm.checkPendingTransactions()
		}
	}
}

// checkPendingTransactions checks status of pending transactions
func (mcm *MultiCurrencyManager) checkPendingTransactions() {
	mcm.wallets.Range(func(key, value interface{}) bool {
		wallet := value.(*Wallet)
		
		wallet.mu.Lock()
		for _, tx := range wallet.Transactions {
			if tx.Status == TransactionStatusPending {
				// Check transaction status (placeholder)
				// In production, would query blockchain
				if mcm.isTransactionConfirmed(tx) {
					tx.Status = TransactionStatusConfirmed
					tx.Confirmations = 6 // Placeholder
					
					// Update pending balance
					if tx.Type == TransactionTypeWithdraw {
						wallet.PendingBalance.Sub(wallet.PendingBalance, tx.Amount)
					}
				}
			}
		}
		wallet.mu.Unlock()
		
		return true
	})
}

// Helper methods

func (mcm *MultiCurrencyManager) getCurrency(symbol string) (*Currency, error) {
	if val, ok := mcm.currencies.Load(symbol); ok {
		return val.(*Currency), nil
	}
	return nil, fmt.Errorf("currency not found: %s", symbol)
}

func (mcm *MultiCurrencyManager) getWallet(symbol string) (*Wallet, error) {
	if val, ok := mcm.wallets.Load(symbol); ok {
		return val.(*Wallet), nil
	}
	return nil, fmt.Errorf("wallet not found: %s", symbol)
}

func (mcm *MultiCurrencyManager) getWalletAddress(symbol string) string {
	wallet, err := mcm.getWallet(symbol)
	if err != nil {
		return ""
	}
	return wallet.Address
}

func (mcm *MultiCurrencyManager) getEnabledCurrencies() []string {
	var currencies []string
	mcm.currencies.Range(func(key, value interface{}) bool {
		currency := value.(*Currency)
		if currency.Enabled {
			currencies = append(currencies, currency.Symbol)
		}
		return true
	})
	return currencies
}

func (mcm *MultiCurrencyManager) getEnabledCount() int {
	count := 0
	mcm.currencies.Range(func(_, value interface{}) bool {
		if value.(*Currency).Enabled {
			count++
		}
		return true
	})
	return count
}

func (mcm *MultiCurrencyManager) generateAddress(symbol string) string {
	// Simplified address generation
	// In production, would use proper address generation
	return fmt.Sprintf("%s_addr_%d", symbol, time.Now().UnixNano())
}

func (mcm *MultiCurrencyManager) generateTransactionID() string {
	return fmt.Sprintf("tx_%d", time.Now().UnixNano())
}

func (mcm *MultiCurrencyManager) broadcastTransaction(currency *Currency, tx *Transaction) (string, error) {
	// Placeholder for transaction broadcasting
	// In production, would interact with blockchain
	return fmt.Sprintf("0x%x", time.Now().UnixNano()), nil
}

func (mcm *MultiCurrencyManager) isTransactionConfirmed(tx *Transaction) bool {
	// Placeholder
	// In production, would check blockchain
	return time.Since(tx.Timestamp) > 10*time.Minute
}

func (mcm *MultiCurrencyManager) updateTransactionStats(symbol string, amount *big.Int) {
	// Update transaction count
	if val, ok := mcm.stats.TotalTransactions.Load(symbol); ok {
		mcm.stats.TotalTransactions.Store(symbol, val.(uint64)+1)
	}

	// Update volume
	if val, ok := mcm.stats.TotalVolume.Load(symbol); ok {
		current := val.(*big.Int)
		mcm.stats.TotalVolume.Store(symbol, new(big.Int).Add(current, amount))
	}
}

func (mcm *MultiCurrencyManager) recordFailedTransaction(symbol string) {
	if val, ok := mcm.stats.FailedTransactions.Load(symbol); ok {
		mcm.stats.FailedTransactions.Store(symbol, val.(uint64)+1)
	}
}

// GetStats returns currency statistics
func (mcm *MultiCurrencyManager) GetStats() map[string]interface{} {
	stats := make(map[string]interface{})
	
	// Currency stats
	currencies := make(map[string]interface{})
	mcm.currencies.Range(func(key, value interface{}) bool {
		symbol := key.(string)
		currency := value.(*Currency)
		
		var txCount, failedCount uint64
		var volume *big.Int
		
		if val, ok := mcm.stats.TotalTransactions.Load(symbol); ok {
			txCount = val.(uint64)
		}
		if val, ok := mcm.stats.FailedTransactions.Load(symbol); ok {
			failedCount = val.(uint64)
		}
		if val, ok := mcm.stats.TotalVolume.Load(symbol); ok {
			volume = val.(*big.Int)
		} else {
			volume = big.NewInt(0)
		}
		
		currencies[symbol] = map[string]interface{}{
			"enabled":           currency.Enabled,
			"total_transactions": txCount,
			"failed_transactions": failedCount,
			"total_volume":       volume.String(),
			"confirmations":      currency.Confirmations,
			"block_time":         currency.BlockTime.String(),
		}
		
		return true
	})
	stats["currencies"] = currencies
	
	// Wallet stats
	wallets := make(map[string]interface{})
	mcm.wallets.Range(func(key, value interface{}) bool {
		symbol := key.(string)
		wallet := value.(*Wallet)
		
		wallet.mu.RLock()
		wallets[symbol] = map[string]interface{}{
			"address":         wallet.Address,
			"balance":         wallet.Balance.String(),
			"pending_balance": wallet.PendingBalance.String(),
			"last_sync":       wallet.LastSync,
			"tx_count":        len(wallet.Transactions),
		}
		wallet.mu.RUnlock()
		
		return true
	})
	stats["wallets"] = wallets
	
	// Exchange rates
	rates := make(map[string]interface{})
	mcm.exchangeRates.rates.Range(func(key, value interface{}) bool {
		pair := key.(string)
		rate := value.(*ExchangeRate)
		rates[pair] = map[string]interface{}{
			"rate":      rate.Rate,
			"timestamp": rate.Timestamp,
			"provider":  rate.Provider,
		}
		return true
	})
	stats["exchange_rates"] = rates
	
	return stats
}

// Component implementations

// NewExchangeRateManager creates a new exchange rate manager
func NewExchangeRateManager() *ExchangeRateManager {
	return &ExchangeRateManager{
		providers: make([]RateProvider, 0),
	}
}

func (erm *ExchangeRateManager) UpdateRate(rate *ExchangeRate) {
	key := fmt.Sprintf("%s-%s", rate.From, rate.To)
	erm.rates.Store(key, rate)
}

func (erm *ExchangeRateManager) GetRate(from, to string) (*ExchangeRate, error) {
	key := fmt.Sprintf("%s-%s", from, to)
	if val, ok := erm.rates.Load(key); ok {
		return val.(*ExchangeRate), nil
	}
	
	// Try reverse rate
	reverseKey := fmt.Sprintf("%s-%s", to, from)
	if val, ok := erm.rates.Load(reverseKey); ok {
		rate := val.(*ExchangeRate)
		return &ExchangeRate{
			From:      from,
			To:        to,
			Rate:      1.0 / rate.Rate,
			Timestamp: rate.Timestamp,
			Provider:  rate.Provider,
		}, nil
	}
	
	return nil, fmt.Errorf("no rate found for %s-%s", from, to)
}

// NewCurrencyConverter creates a new currency converter
func NewCurrencyConverter(rates *ExchangeRateManager) *CurrencyConverter {
	return &CurrencyConverter{rates: rates}
}

func (cc *CurrencyConverter) Convert(amount *big.Int, rate float64, decimals int) *big.Int {
	// Convert to float for calculation
	amountFloat := new(big.Float).SetInt(amount)
	rateFloat := big.NewFloat(rate)
	
	// Multiply
	result := new(big.Float).Mul(amountFloat, rateFloat)
	
	// Convert back to int
	resultInt, _ := result.Int(nil)
	return resultInt
}

// NewAddressValidator creates a new address validator
func NewAddressValidator() *AddressValidator {
	av := &AddressValidator{
		validators: make(map[string]AddressValidatorFunc),
	}
	
	// Register validators
	av.validators["BTC"] = ValidateBitcoinAddress
	av.validators["ETH"] = ValidateEthereumAddress
	av.validators["LTC"] = ValidateLitecoinAddress
	av.validators["XMR"] = ValidateMoneroAddress
	
	return av
}

func (av *AddressValidator) ValidateAddress(currency, address string) bool {
	if validator, ok := av.validators[currency]; ok {
		return validator(address)
	}
	return false
}

// Address validators (simplified)
func ValidateBitcoinAddress(address string) bool {
	// Simplified validation
	return len(address) >= 26 && len(address) <= 35
}

func ValidateEthereumAddress(address string) bool {
	// Check if starts with 0x and has 40 hex chars
	return len(address) == 42 && address[:2] == "0x"
}

func ValidateLitecoinAddress(address string) bool {
	// Similar to Bitcoin
	return len(address) >= 26 && len(address) <= 35
}

func ValidateMoneroAddress(address string) bool {
	// Monero addresses are 95 chars
	return len(address) == 95
}

// NewFeeCalculator creates a new fee calculator
func NewFeeCalculator() *FeeCalculator {
	fc := &FeeCalculator{
		baseFees:     make(map[string]*big.Int),
		feeProviders: make(map[string]FeeProvider),
	}
	
	// Set base fees (in smallest unit)
	fc.baseFees["BTC"] = big.NewInt(10000)     // 0.0001 BTC
	fc.baseFees["ETH"] = big.NewInt(21000000000000000) // 0.021 ETH
	fc.baseFees["LTC"] = big.NewInt(100000)    // 0.001 LTC
	fc.baseFees["XMR"] = big.NewInt(100000000) // 0.0001 XMR
	
	return fc
}

func (fc *FeeCalculator) CalculateFee(currency, priority string) (*big.Int, error) {
	// Check dynamic fee first
	if val, ok := fc.dynamicFees.Load(currency); ok {
		return val.(*big.Int), nil
	}
	
	// Use base fee
	if fee, ok := fc.baseFees[currency]; ok {
		// Adjust for priority
		multiplier := int64(1)
		switch priority {
		case "high":
			multiplier = 2
		case "low":
			multiplier = 1
		default:
			multiplier = 1
		}
		
		return new(big.Int).Mul(fee, big.NewInt(multiplier)), nil
	}
	
	return nil, fmt.Errorf("no fee data for currency: %s", currency)
}