package currency

import (
	"fmt"
	"math/big"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// Currency represents a supported cryptocurrency
type Currency struct {
	// Basic info
	Symbol      string `json:"symbol"`      // BTC, ETH, LTC, etc.
	Name        string `json:"name"`        // Bitcoin, Ethereum, Litecoin
	Network     string `json:"network"`     // mainnet, testnet
	Decimals    int    `json:"decimals"`    // Number of decimal places
	
	// Mining parameters
	Algorithm    string        `json:"algorithm"`     // sha256, ethash, scrypt, etc.
	BlockTime    time.Duration `json:"block_time"`    // Target block time
	Confirmations int          `json:"confirmations"` // Required confirmations
	
	// Chain parameters
	ChainID      int64  `json:"chain_id"`      // For chains that use chain ID
	NetworkMagic uint32 `json:"network_magic"` // Network magic bytes
	
	// Addresses
	AddressPrefix    byte   `json:"address_prefix"`     // Address version byte
	P2SHPrefix       byte   `json:"p2sh_prefix"`        // P2SH address prefix
	Bech32HRP        string `json:"bech32_hrp"`         // Bech32 human-readable part
	
	// Units
	BaseUnit         string `json:"base_unit"`          // satoshi, wei, etc.
	DisplayUnit      string `json:"display_unit"`       // BTC, ETH, etc.
	UnitsPerCoin     *big.Int `json:"units_per_coin"`   // 100000000 for BTC
	
	// Pool configuration
	MinPayout        *big.Int `json:"min_payout"`        // Minimum payout amount
	PayoutFee        *big.Int `json:"payout_fee"`        // Transaction fee for payouts
	DefaultDifficulty float64 `json:"default_difficulty"` // Default mining difficulty
	
	// RPC configuration
	RPCHost          string `json:"rpc_host"`
	RPCPort          int    `json:"rpc_port"`
	RPCUser          string `json:"rpc_user"`
	RPCPassword      string `json:"rpc_password"`
	RPCSSL           bool   `json:"rpc_ssl"`
	
	// Extra configuration
	ExtraConfig      map[string]interface{} `json:"extra_config"`
}

// CurrencyManager manages multiple cryptocurrency configurations
type CurrencyManager struct {
	logger      *zap.Logger
	currencies  map[string]*Currency
	mu          sync.RWMutex
	
	// Default currency
	defaultCurrency string
	
	// Exchange rates (optional)
	exchangeRates map[string]float64
	ratesUpdated  time.Time
}

// NewCurrencyManager creates a new currency manager
func NewCurrencyManager(logger *zap.Logger) *CurrencyManager {
	cm := &CurrencyManager{
		logger:        logger,
		currencies:    make(map[string]*Currency),
		exchangeRates: make(map[string]float64),
	}
	
	// Initialize with default currencies
	cm.initializeDefaultCurrencies()
	
	return cm
}

// initializeDefaultCurrencies sets up commonly used cryptocurrencies
func (cm *CurrencyManager) initializeDefaultCurrencies() {
	// Bitcoin
	cm.AddCurrency(&Currency{
		Symbol:       "BTC",
		Name:         "Bitcoin",
		Network:      "mainnet",
		Decimals:     8,
		Algorithm:    "sha256",
		BlockTime:    10 * time.Minute,
		Confirmations: 6,
		NetworkMagic: 0xD9B4BEF9,
		AddressPrefix: 0x00,
		P2SHPrefix:    0x05,
		Bech32HRP:     "bc",
		BaseUnit:      "satoshi",
		DisplayUnit:   "BTC",
		UnitsPerCoin:  big.NewInt(100000000),
		MinPayout:     big.NewInt(10000000),  // 0.1 BTC
		PayoutFee:     big.NewInt(10000),     // 0.0001 BTC
		DefaultDifficulty: 1.0,
		RPCPort:       8332,
	})
	
	// Bitcoin Cash
	cm.AddCurrency(&Currency{
		Symbol:       "BCH",
		Name:         "Bitcoin Cash",
		Network:      "mainnet",
		Decimals:     8,
		Algorithm:    "sha256",
		BlockTime:    10 * time.Minute,
		Confirmations: 6,
		AddressPrefix: 0x00,
		P2SHPrefix:    0x05,
		BaseUnit:      "satoshi",
		DisplayUnit:   "BCH",
		UnitsPerCoin:  big.NewInt(100000000),
		MinPayout:     big.NewInt(10000000),
		PayoutFee:     big.NewInt(1000),
		DefaultDifficulty: 1.0,
		RPCPort:       8332,
	})
	
	// Litecoin
	cm.AddCurrency(&Currency{
		Symbol:       "LTC",
		Name:         "Litecoin",
		Network:      "mainnet",
		Decimals:     8,
		Algorithm:    "scrypt",
		BlockTime:    150 * time.Second,
		Confirmations: 6,
		NetworkMagic: 0xDBB6C0FB,
		AddressPrefix: 0x30,
		P2SHPrefix:    0x32,
		Bech32HRP:     "ltc",
		BaseUnit:      "litoshi",
		DisplayUnit:   "LTC",
		UnitsPerCoin:  big.NewInt(100000000),
		MinPayout:     big.NewInt(10000000),
		PayoutFee:     big.NewInt(10000),
		DefaultDifficulty: 1.0,
		RPCPort:       9332,
	})
	
	// Ethereum
	cm.AddCurrency(&Currency{
		Symbol:       "ETH",
		Name:         "Ethereum",
		Network:      "mainnet",
		Decimals:     18,
		Algorithm:    "ethash",
		BlockTime:    13 * time.Second,
		Confirmations: 12,
		ChainID:      1,
		BaseUnit:      "wei",
		DisplayUnit:   "ETH",
		UnitsPerCoin:  new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil),
		MinPayout:     new(big.Int).Exp(big.NewInt(10), big.NewInt(17), nil), // 0.1 ETH
		PayoutFee:     new(big.Int).Exp(big.NewInt(10), big.NewInt(15), nil), // 0.001 ETH
		DefaultDifficulty: 1.0,
		RPCPort:       8545,
	})
	
	// Ethereum Classic
	cm.AddCurrency(&Currency{
		Symbol:       "ETC",
		Name:         "Ethereum Classic",
		Network:      "mainnet",
		Decimals:     18,
		Algorithm:    "etchash",
		BlockTime:    13 * time.Second,
		Confirmations: 12,
		ChainID:      61,
		BaseUnit:      "wei",
		DisplayUnit:   "ETC",
		UnitsPerCoin:  new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil),
		MinPayout:     new(big.Int).Exp(big.NewInt(10), big.NewInt(17), nil),
		PayoutFee:     new(big.Int).Exp(big.NewInt(10), big.NewInt(15), nil),
		DefaultDifficulty: 1.0,
		RPCPort:       8545,
	})
	
	// Monero
	cm.AddCurrency(&Currency{
		Symbol:       "XMR",
		Name:         "Monero",
		Network:      "mainnet",
		Decimals:     12,
		Algorithm:    "randomx",
		BlockTime:    2 * time.Minute,
		Confirmations: 10,
		BaseUnit:      "piconero",
		DisplayUnit:   "XMR",
		UnitsPerCoin:  new(big.Int).Exp(big.NewInt(10), big.NewInt(12), nil),
		MinPayout:     new(big.Int).Exp(big.NewInt(10), big.NewInt(11), nil), // 0.1 XMR
		PayoutFee:     new(big.Int).Exp(big.NewInt(10), big.NewInt(9), nil),  // 0.001 XMR
		DefaultDifficulty: 1.0,
		RPCPort:       18081,
	})
	
	// Ravencoin
	cm.AddCurrency(&Currency{
		Symbol:       "RVN",
		Name:         "Ravencoin",
		Network:      "mainnet",
		Decimals:     8,
		Algorithm:    "kawpow",
		BlockTime:    60 * time.Second,
		Confirmations: 100,
		AddressPrefix: 0x3C,
		P2SHPrefix:    0x7A,
		BaseUnit:      "sat",
		DisplayUnit:   "RVN",
		UnitsPerCoin:  big.NewInt(100000000),
		MinPayout:     big.NewInt(1000000000), // 10 RVN
		PayoutFee:     big.NewInt(100000),      // 0.001 RVN
		DefaultDifficulty: 1.0,
		RPCPort:       8766,
	})
	
	// Ergo
	cm.AddCurrency(&Currency{
		Symbol:       "ERG",
		Name:         "Ergo",
		Network:      "mainnet",
		Decimals:     9,
		Algorithm:    "autolykos2",
		BlockTime:    2 * time.Minute,
		Confirmations: 10,
		BaseUnit:      "nanoerg",
		DisplayUnit:   "ERG",
		UnitsPerCoin:  big.NewInt(1000000000),
		MinPayout:     big.NewInt(100000000), // 0.1 ERG
		PayoutFee:     big.NewInt(1000000),   // 0.001 ERG
		DefaultDifficulty: 1.0,
		RPCPort:       9053,
	})
	
	cm.defaultCurrency = "BTC"
}

// AddCurrency adds a new currency configuration
func (cm *CurrencyManager) AddCurrency(currency *Currency) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	
	if currency.Symbol == "" {
		return fmt.Errorf("currency symbol cannot be empty")
	}
	
	// Normalize symbol to uppercase
	currency.Symbol = strings.ToUpper(currency.Symbol)
	
	// Validate currency configuration
	if err := cm.validateCurrency(currency); err != nil {
		return fmt.Errorf("invalid currency configuration: %w", err)
	}
	
	cm.currencies[currency.Symbol] = currency
	cm.logger.Info("Added currency",
		zap.String("symbol", currency.Symbol),
		zap.String("name", currency.Name),
		zap.String("algorithm", currency.Algorithm),
	)
	
	return nil
}

// GetCurrency returns currency configuration by symbol
func (cm *CurrencyManager) GetCurrency(symbol string) (*Currency, error) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	
	symbol = strings.ToUpper(symbol)
	currency, exists := cm.currencies[symbol]
	if !exists {
		return nil, fmt.Errorf("currency %s not found", symbol)
	}
	
	return currency, nil
}

// GetDefaultCurrency returns the default currency
func (cm *CurrencyManager) GetDefaultCurrency() (*Currency, error) {
	return cm.GetCurrency(cm.defaultCurrency)
}

// SetDefaultCurrency sets the default currency
func (cm *CurrencyManager) SetDefaultCurrency(symbol string) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	
	symbol = strings.ToUpper(symbol)
	if _, exists := cm.currencies[symbol]; !exists {
		return fmt.Errorf("currency %s not found", symbol)
	}
	
	cm.defaultCurrency = symbol
	return nil
}

// ListCurrencies returns all supported currencies
func (cm *CurrencyManager) ListCurrencies() []*Currency {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	
	currencies := make([]*Currency, 0, len(cm.currencies))
	for _, currency := range cm.currencies {
		currencies = append(currencies, currency)
	}
	
	return currencies
}

// GetCurrenciesByAlgorithm returns currencies that use a specific algorithm
func (cm *CurrencyManager) GetCurrenciesByAlgorithm(algorithm string) []*Currency {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	
	algorithm = strings.ToLower(algorithm)
	var currencies []*Currency
	
	for _, currency := range cm.currencies {
		if strings.ToLower(currency.Algorithm) == algorithm {
			currencies = append(currencies, currency)
		}
	}
	
	return currencies
}

// UpdateCurrency updates an existing currency configuration
func (cm *CurrencyManager) UpdateCurrency(symbol string, updates map[string]interface{}) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	
	symbol = strings.ToUpper(symbol)
	currency, exists := cm.currencies[symbol]
	if !exists {
		return fmt.Errorf("currency %s not found", symbol)
	}
	
	// Apply updates (simplified - in production would use reflection or specific update methods)
	if minPayout, ok := updates["min_payout"].(*big.Int); ok {
		currency.MinPayout = minPayout
	}
	if payoutFee, ok := updates["payout_fee"].(*big.Int); ok {
		currency.PayoutFee = payoutFee
	}
	if difficulty, ok := updates["default_difficulty"].(float64); ok {
		currency.DefaultDifficulty = difficulty
	}
	
	cm.logger.Info("Updated currency configuration",
		zap.String("symbol", symbol),
		zap.Any("updates", updates),
	)
	
	return nil
}

// RemoveCurrency removes a currency from the manager
func (cm *CurrencyManager) RemoveCurrency(symbol string) error {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	
	symbol = strings.ToUpper(symbol)
	if symbol == cm.defaultCurrency {
		return fmt.Errorf("cannot remove default currency")
	}
	
	if _, exists := cm.currencies[symbol]; !exists {
		return fmt.Errorf("currency %s not found", symbol)
	}
	
	delete(cm.currencies, symbol)
	cm.logger.Info("Removed currency", zap.String("symbol", symbol))
	
	return nil
}

// validateCurrency validates currency configuration
func (cm *CurrencyManager) validateCurrency(currency *Currency) error {
	if currency.Name == "" {
		return fmt.Errorf("currency name cannot be empty")
	}
	if currency.Algorithm == "" {
		return fmt.Errorf("algorithm cannot be empty")
	}
	if currency.BlockTime <= 0 {
		return fmt.Errorf("block time must be positive")
	}
	if currency.Confirmations <= 0 {
		return fmt.Errorf("confirmations must be positive")
	}
	if currency.Decimals < 0 {
		return fmt.Errorf("decimals cannot be negative")
	}
	if currency.UnitsPerCoin == nil || currency.UnitsPerCoin.Sign() <= 0 {
		return fmt.Errorf("units per coin must be positive")
	}
	if currency.MinPayout == nil || currency.MinPayout.Sign() < 0 {
		return fmt.Errorf("minimum payout cannot be negative")
	}
	if currency.PayoutFee == nil || currency.PayoutFee.Sign() < 0 {
		return fmt.Errorf("payout fee cannot be negative")
	}
	if currency.DefaultDifficulty <= 0 {
		return fmt.Errorf("default difficulty must be positive")
	}
	
	return nil
}

// ConvertAmount converts amount from one currency to another using exchange rates
func (cm *CurrencyManager) ConvertAmount(amount *big.Int, fromSymbol, toSymbol string) (*big.Int, error) {
	if fromSymbol == toSymbol {
		return new(big.Int).Set(amount), nil
	}
	
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	
	fromRate, fromExists := cm.exchangeRates[fromSymbol]
	toRate, toExists := cm.exchangeRates[toSymbol]
	
	if !fromExists || !toExists {
		return nil, fmt.Errorf("exchange rates not available for conversion")
	}
	
	// Convert to USD first, then to target currency
	// amount * fromRate / toRate
	result := new(big.Float).SetInt(amount)
	result.Mul(result, big.NewFloat(fromRate))
	result.Quo(result, big.NewFloat(toRate))
	
	// Convert back to big.Int
	converted, _ := result.Int(nil)
	return converted, nil
}

// UpdateExchangeRates updates the exchange rates for currencies
func (cm *CurrencyManager) UpdateExchangeRates(rates map[string]float64) {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	
	cm.exchangeRates = rates
	cm.ratesUpdated = time.Now()
	
	cm.logger.Info("Updated exchange rates",
		zap.Int("currencies", len(rates)),
		zap.Time("updated", cm.ratesUpdated),
	)
}

// GetExchangeRate returns the exchange rate for a currency
func (cm *CurrencyManager) GetExchangeRate(symbol string) (float64, error) {
	cm.mu.RLock()
	defer cm.mu.RUnlock()
	
	rate, exists := cm.exchangeRates[symbol]
	if !exists {
		return 0, fmt.Errorf("exchange rate not available for %s", symbol)
	}
	
	return rate, nil
}

// FormatAmount formats an amount for display
func (cm *CurrencyManager) FormatAmount(amount *big.Int, symbol string) (string, error) {
	currency, err := cm.GetCurrency(symbol)
	if err != nil {
		return "", err
	}
	
	// Convert from base units to display units
	displayAmount := new(big.Float).SetInt(amount)
	divisor := new(big.Float).SetInt(currency.UnitsPerCoin)
	displayAmount.Quo(displayAmount, divisor)
	
	// Format with appropriate decimal places
	return fmt.Sprintf("%.*f %s", currency.Decimals, displayAmount, currency.DisplayUnit), nil
}

// ParseAmount parses a display amount to base units
func (cm *CurrencyManager) ParseAmount(amountStr string, symbol string) (*big.Int, error) {
	currency, err := cm.GetCurrency(symbol)
	if err != nil {
		return nil, err
	}
	
	// Parse the amount
	amount, ok := new(big.Float).SetString(amountStr)
	if !ok {
		return nil, fmt.Errorf("invalid amount format")
	}
	
	// Convert to base units
	amount.Mul(amount, new(big.Float).SetInt(currency.UnitsPerCoin))
	
	// Convert to big.Int
	result, _ := amount.Int(nil)
	return result, nil
}