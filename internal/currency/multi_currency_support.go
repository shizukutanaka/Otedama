package currency

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"sync"
	"time"

	"go.uber.org/zap"
)

// MultiCurrencySupport handles multiple cryptocurrency support with real-time exchange rates
// Following Rob Pike's principle: "Errors are values"
type MultiCurrencySupport struct {
	logger *zap.Logger
	
	// Currency registry
	currencies    map[string]*Currency
	currenciesMu  sync.RWMutex
	
	// Exchange rates
	rates         map[string]map[string]float64 // from -> to -> rate
	ratesMu       sync.RWMutex
	ratesUpdated  time.Time
	
	// Price feeds
	priceFeeds    []PriceFeed
	
	// Mining algorithms
	algorithms    map[string]*Algorithm
	algorithmsMu  sync.RWMutex
	
	// Profit calculator
	calculator    *ProfitCalculator
	
	// Configuration
	config        MultiCurrencyConfig
	
	// Update control
	ctx           context.Context
	cancel        context.CancelFunc
	
	// Metrics
	metrics       struct {
		currenciesSupported uint64
		rateUpdates         uint64
		rateFetchErrors     uint64
		profitCalculations  uint64
		algorithmSwitches   uint64
	}
}

// MultiCurrencyConfig configures multi-currency support
type MultiCurrencyConfig struct {
	// Update settings
	UpdateInterval    time.Duration
	RetryInterval     time.Duration
	MaxRetries        int
	
	// Price feeds
	EnabledFeeds      []string
	FeedTimeout       time.Duration
	
	// Profit switching
	EnableProfitSwitch bool
	SwitchThreshold    float64 // percentage improvement required
	SwitchCooldown     time.Duration
	
	// Currency settings
	BaseCurrency      string
	DisplayCurrencies []string
}

// Currency represents a cryptocurrency
type Currency struct {
	Symbol          string
	Name            string
	Algorithm       string
	BlockTime       time.Duration
	BlockReward     *big.Float
	Difficulty      *big.Float
	NetworkHashrate *big.Float
	Price           float64
	MarketCap       float64
	Volume24h       float64
	PriceChange24h  float64
	LastUpdated     time.Time
	
	// Mining parameters
	PoolFee         float64
	ExtraConfig     map[string]interface{}
}

// Algorithm represents a mining algorithm
type Algorithm struct {
	Name            string
	Type            string // "CPU", "GPU", "ASIC"
	Currencies      []string
	HashRateUnits   string // "H/s", "KH/s", "MH/s", "GH/s", "TH/s"
	PowerEfficiency float64 // average watts per hash unit
	
	// Hardware requirements
	MinMemory       int64 // bytes
	OptimalTemp     float64
	
	// Performance factors
	CPUFactor       float64
	GPUFactor       float64
	ASICFactor      float64
}

// PriceFeed interface for exchange rate providers
type PriceFeed interface {
	GetPrices(symbols []string) (map[string]float64, error)
	GetExchangeRates(base string, targets []string) (map[string]float64, error)
	Name() string
}

// ProfitCalculator calculates mining profitability
type ProfitCalculator struct {
	logger *zap.Logger
	
	// Hardware specifications
	hashRates     map[string]float64 // algorithm -> hashrate
	powerUsage    map[string]float64 // algorithm -> watts
	
	// Costs
	electricityCost float64 // per kWh
	poolFees        map[string]float64
	
	// Results cache
	results       map[string]*ProfitResult
	resultsMu     sync.RWMutex
	lastCalc      time.Time
}

// ProfitResult contains profitability calculation results
type ProfitResult struct {
	Currency        string
	Algorithm       string
	Hashrate        float64
	Power           float64
	
	// Earnings
	CoinsPerDay     *big.Float
	RevenuePerDay   float64
	
	// Costs
	PowerCostPerDay float64
	PoolFeePerDay   float64
	
	// Profit
	ProfitPerDay    float64
	ProfitPerMonth  float64
	ROI             float64 // days to break even
	
	// Comparison
	ProfitRatio     float64 // compared to base currency
	Rank            int
}

// ExchangeRate represents a currency exchange rate
type ExchangeRate struct {
	From      string
	To        string
	Rate      float64
	Timestamp time.Time
	Source    string
}

// NewMultiCurrencySupport creates a new multi-currency support instance
func NewMultiCurrencySupport(logger *zap.Logger, config MultiCurrencyConfig) (*MultiCurrencySupport, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	mcs := &MultiCurrencySupport{
		logger:     logger,
		currencies: make(map[string]*Currency),
		rates:      make(map[string]map[string]float64),
		algorithms: make(map[string]*Algorithm),
		config:     config,
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Initialize price feeds
	if err := mcs.initializePriceFeeds(); err != nil {
		cancel()
		return nil, fmt.Errorf("failed to initialize price feeds: %w", err)
	}
	
	// Initialize profit calculator
	mcs.calculator = &ProfitCalculator{
		logger:      logger,
		hashRates:   make(map[string]float64),
		powerUsage:  make(map[string]float64),
		poolFees:    make(map[string]float64),
		results:     make(map[string]*ProfitResult),
	}
	
	// Load default currencies and algorithms
	mcs.loadDefaults()
	
	// Start update loop
	go mcs.updateLoop()
	
	logger.Info("Initialized multi-currency support",
		zap.String("base_currency", config.BaseCurrency),
		zap.Int("feeds", len(mcs.priceFeeds)),
		zap.Bool("profit_switching", config.EnableProfitSwitch))
	
	return mcs, nil
}

// AddCurrency adds support for a new currency
func (mcs *MultiCurrencySupport) AddCurrency(currency *Currency) error {
	mcs.currenciesMu.Lock()
	defer mcs.currenciesMu.Unlock()
	
	if _, exists := mcs.currencies[currency.Symbol]; exists {
		return fmt.Errorf("currency %s already exists", currency.Symbol)
	}
	
	mcs.currencies[currency.Symbol] = currency
	mcs.metrics.currenciesSupported++
	
	mcs.logger.Info("Added currency support",
		zap.String("symbol", currency.Symbol),
		zap.String("name", currency.Name),
		zap.String("algorithm", currency.Algorithm))
	
	return nil
}

// UpdateRates updates exchange rates from all feeds
func (mcs *MultiCurrencySupport) UpdateRates() error {
	mcs.logger.Debug("Updating exchange rates")
	
	// Get list of currencies
	mcs.currenciesMu.RLock()
	symbols := make([]string, 0, len(mcs.currencies))
	for symbol := range mcs.currencies {
		symbols = append(symbols, symbol)
	}
	mcs.currenciesMu.RUnlock()
	
	// Aggregate rates from all feeds
	aggregatedRates := make(map[string]map[string][]float64)
	
	for _, feed := range mcs.priceFeeds {
		// Get prices in base currency
		prices, err := feed.GetPrices(symbols)
		if err != nil {
			mcs.logger.Warn("Failed to get prices from feed",
				zap.String("feed", feed.Name()),
				zap.Error(err))
			mcs.metrics.rateFetchErrors++
			continue
		}
		
		// Update currency prices
		mcs.currenciesMu.Lock()
		for symbol, price := range prices {
			if currency, exists := mcs.currencies[symbol]; exists {
				currency.Price = price
				currency.LastUpdated = time.Now()
			}
		}
		mcs.currenciesMu.Unlock()
		
		// Get exchange rates
		if len(mcs.config.DisplayCurrencies) > 0 {
			rates, err := feed.GetExchangeRates(mcs.config.BaseCurrency, mcs.config.DisplayCurrencies)
			if err != nil {
				mcs.logger.Warn("Failed to get exchange rates",
					zap.String("feed", feed.Name()),
					zap.Error(err))
				continue
			}
			
			// Aggregate rates
			for target, rate := range rates {
				if aggregatedRates[mcs.config.BaseCurrency] == nil {
					aggregatedRates[mcs.config.BaseCurrency] = make(map[string][]float64)
				}
				aggregatedRates[mcs.config.BaseCurrency][target] = append(
					aggregatedRates[mcs.config.BaseCurrency][target], rate)
			}
		}
	}
	
	// Calculate median rates
	mcs.ratesMu.Lock()
	for from, targets := range aggregatedRates {
		if mcs.rates[from] == nil {
			mcs.rates[from] = make(map[string]float64)
		}
		for to, rates := range targets {
			mcs.rates[from][to] = calculateMedian(rates)
		}
	}
	mcs.ratesUpdated = time.Now()
	mcs.ratesMu.Unlock()
	
	mcs.metrics.rateUpdates++
	
	mcs.logger.Info("Updated exchange rates",
		zap.Int("currencies", len(symbols)),
		zap.Time("timestamp", time.Now()))
	
	return nil
}

// GetExchangeRate returns the exchange rate between two currencies
func (mcs *MultiCurrencySupport) GetExchangeRate(from, to string) (float64, error) {
	mcs.ratesMu.RLock()
	defer mcs.ratesMu.RUnlock()
	
	if from == to {
		return 1.0, nil
	}
	
	// Direct rate
	if rates, exists := mcs.rates[from]; exists {
		if rate, exists := rates[to]; exists {
			return rate, nil
		}
	}
	
	// Inverse rate
	if rates, exists := mcs.rates[to]; exists {
		if rate, exists := rates[from]; exists && rate > 0 {
			return 1.0 / rate, nil
		}
	}
	
	// Cross rate through base currency
	if from != mcs.config.BaseCurrency && to != mcs.config.BaseCurrency {
		rate1, err1 := mcs.GetExchangeRate(from, mcs.config.BaseCurrency)
		rate2, err2 := mcs.GetExchangeRate(mcs.config.BaseCurrency, to)
		
		if err1 == nil && err2 == nil {
			return rate1 * rate2, nil
		}
	}
	
	return 0, fmt.Errorf("no exchange rate available for %s to %s", from, to)
}

// CalculateProfitability calculates mining profitability for all currencies
func (mcs *MultiCurrencySupport) CalculateProfitability(hashRates map[string]float64, powerUsage map[string]float64, electricityCost float64) ([]*ProfitResult, error) {
	mcs.calculator.hashRates = hashRates
	mcs.calculator.powerUsage = powerUsage
	mcs.calculator.electricityCost = electricityCost
	
	results := make([]*ProfitResult, 0)
	
	mcs.currenciesMu.RLock()
	defer mcs.currenciesMu.RUnlock()
	
	for symbol, currency := range mcs.currencies {
		// Get algorithm
		mcs.algorithmsMu.RLock()
		algorithm, exists := mcs.algorithms[currency.Algorithm]
		mcs.algorithmsMu.RUnlock()
		
		if !exists {
			continue
		}
		
		// Check if we have hashrate for this algorithm
		hashrate, hasHashrate := hashRates[algorithm.Name]
		power, hasPower := powerUsage[algorithm.Name]
		
		if !hasHashrate || !hasPower {
			continue
		}
		
		// Calculate earnings
		result := mcs.calculateCurrencyProfit(currency, algorithm, hashrate, power, electricityCost)
		results = append(results, result)
	}
	
	// Sort by profitability
	mcs.sortProfitResults(results)
	
	// Update cache
	mcs.calculator.resultsMu.Lock()
	mcs.calculator.results = make(map[string]*ProfitResult)
	for _, result := range results {
		mcs.calculator.results[result.Currency] = result
	}
	mcs.calculator.lastCalc = time.Now()
	mcs.calculator.resultsMu.Unlock()
	
	mcs.metrics.profitCalculations++
	
	return results, nil
}

// GetMostProfitable returns the most profitable currency to mine
func (mcs *MultiCurrencySupport) GetMostProfitable(algorithm string) (*Currency, *ProfitResult, error) {
	mcs.calculator.resultsMu.RLock()
	defer mcs.calculator.resultsMu.RUnlock()
	
	var bestCurrency *Currency
	var bestResult *ProfitResult
	maxProfit := -math.MaxFloat64
	
	for symbol, result := range mcs.calculator.results {
		if algorithm != "" && result.Algorithm != algorithm {
			continue
		}
		
		if result.ProfitPerDay > maxProfit {
			mcs.currenciesMu.RLock()
			currency := mcs.currencies[symbol]
			mcs.currenciesMu.RUnlock()
			
			if currency != nil {
				bestCurrency = currency
				bestResult = result
				maxProfit = result.ProfitPerDay
			}
		}
	}
	
	if bestCurrency == nil {
		return nil, nil, errors.New("no profitable currency found")
	}
	
	return bestCurrency, bestResult, nil
}

// Implementation methods

func (mcs *MultiCurrencySupport) initializePriceFeeds() error {
	for _, feedName := range mcs.config.EnabledFeeds {
		var feed PriceFeed
		
		switch feedName {
		case "coingecko":
			feed = NewCoinGeckoFeed(mcs.config.FeedTimeout)
		case "coinmarketcap":
			feed = NewCoinMarketCapFeed("", mcs.config.FeedTimeout) // API key would be configured
		case "binance":
			feed = NewBinanceFeed(mcs.config.FeedTimeout)
		default:
			mcs.logger.Warn("Unknown price feed", zap.String("feed", feedName))
			continue
		}
		
		mcs.priceFeeds = append(mcs.priceFeeds, feed)
	}
	
	if len(mcs.priceFeeds) == 0 {
		return errors.New("no price feeds configured")
	}
	
	return nil
}

func (mcs *MultiCurrencySupport) loadDefaults() {
	// Load default algorithms
	defaultAlgorithms := []Algorithm{
		{
			Name:          "ethash",
			Type:          "GPU",
			HashRateUnits: "MH/s",
			MinMemory:     4 * 1024 * 1024 * 1024,
			CPUFactor:     0.1,
			GPUFactor:     1.0,
			ASICFactor:    10.0,
		},
		{
			Name:          "kawpow",
			Type:          "GPU",
			HashRateUnits: "MH/s",
			MinMemory:     3 * 1024 * 1024 * 1024,
			CPUFactor:     0.05,
			GPUFactor:     1.0,
			ASICFactor:    0.0,
		},
		{
			Name:          "randomx",
			Type:          "CPU",
			HashRateUnits: "H/s",
			MinMemory:     2 * 1024 * 1024 * 1024,
			CPUFactor:     1.0,
			GPUFactor:     0.3,
			ASICFactor:    0.0,
		},
		{
			Name:          "sha256",
			Type:          "ASIC",
			HashRateUnits: "TH/s",
			MinMemory:     512 * 1024 * 1024,
			CPUFactor:     0.00001,
			GPUFactor:     0.0001,
			ASICFactor:    1.0,
		},
	}
	
	for _, algo := range defaultAlgorithms {
		mcs.algorithmsMu.Lock()
		mcs.algorithms[algo.Name] = &algo
		mcs.algorithmsMu.Unlock()
	}
	
	// Load default currencies
	defaultCurrencies := []Currency{
		{
			Symbol:    "ETH",
			Name:      "Ethereum",
			Algorithm: "ethash",
			BlockTime: 13 * time.Second,
		},
		{
			Symbol:    "RVN",
			Name:      "Ravencoin",
			Algorithm: "kawpow",
			BlockTime: 1 * time.Minute,
		},
		{
			Symbol:    "XMR",
			Name:      "Monero",
			Algorithm: "randomx",
			BlockTime: 2 * time.Minute,
		},
		{
			Symbol:    "BTC",
			Name:      "Bitcoin",
			Algorithm: "sha256",
			BlockTime: 10 * time.Minute,
		},
	}
	
	for _, currency := range defaultCurrencies {
		mcs.AddCurrency(&currency)
	}
}

func (mcs *MultiCurrencySupport) updateLoop() {
	ticker := time.NewTicker(mcs.config.UpdateInterval)
	defer ticker.Stop()
	
	// Initial update
	mcs.UpdateRates()
	
	for {
		select {
		case <-ticker.C:
			if err := mcs.UpdateRates(); err != nil {
				mcs.logger.Error("Failed to update rates", zap.Error(err))
			}
		case <-mcs.ctx.Done():
			return
		}
	}
}

func (mcs *MultiCurrencySupport) calculateCurrencyProfit(currency *Currency, algorithm *Algorithm, hashrate, power, electricityCost float64) *ProfitResult {
	result := &ProfitResult{
		Currency:  currency.Symbol,
		Algorithm: algorithm.Name,
		Hashrate:  hashrate,
		Power:     power,
	}
	
	// Convert hashrate to appropriate units
	hashrateInBaseUnits := mcs.convertHashrate(hashrate, algorithm.HashRateUnits)
	
	// Calculate coins per day
	if currency.NetworkHashrate != nil && currency.BlockReward != nil && currency.NetworkHashrate.Sign() > 0 {
		// coins_per_day = (hashrate / network_hashrate) * blocks_per_day * block_reward * (1 - pool_fee)
		blocksPerDay := 86400.0 / currency.BlockTime.Seconds()
		
		userShare := new(big.Float).SetFloat64(hashrateInBaseUnits)
		userShare.Quo(userShare, currency.NetworkHashrate)
		
		coinsPerDay := new(big.Float).Mul(userShare, currency.BlockReward)
		coinsPerDay.Mul(coinsPerDay, big.NewFloat(blocksPerDay))
		coinsPerDay.Mul(coinsPerDay, big.NewFloat(1.0-currency.PoolFee))
		
		result.CoinsPerDay = coinsPerDay
		
		// Calculate revenue
		coinsFloat, _ := coinsPerDay.Float64()
		result.RevenuePerDay = coinsFloat * currency.Price
	}
	
	// Calculate costs
	result.PowerCostPerDay = (power / 1000.0) * 24.0 * electricityCost // kWh * $/kWh
	result.PoolFeePerDay = result.RevenuePerDay * currency.PoolFee
	
	// Calculate profit
	result.ProfitPerDay = result.RevenuePerDay - result.PowerCostPerDay - result.PoolFeePerDay
	result.ProfitPerMonth = result.ProfitPerDay * 30
	
	// Calculate ROI (simplified - doesn't include hardware cost)
	if result.ProfitPerDay > 0 {
		result.ROI = 1000.0 / result.ProfitPerDay // Assuming $1000 hardware cost
	}
	
	return result
}

func (mcs *MultiCurrencySupport) convertHashrate(hashrate float64, units string) float64 {
	// Convert to base H/s
	switch units {
	case "KH/s":
		return hashrate * 1000
	case "MH/s":
		return hashrate * 1000000
	case "GH/s":
		return hashrate * 1000000000
	case "TH/s":
		return hashrate * 1000000000000
	default:
		return hashrate
	}
}

func (mcs *MultiCurrencySupport) sortProfitResults(results []*ProfitResult) {
	// Sort by profit (descending)
	for i := 0; i < len(results); i++ {
		for j := i + 1; j < len(results); j++ {
			if results[j].ProfitPerDay > results[i].ProfitPerDay {
				results[i], results[j] = results[j], results[i]
			}
		}
	}
	
	// Assign ranks
	for i, result := range results {
		result.Rank = i + 1
		if i > 0 && results[0].ProfitPerDay > 0 {
			result.ProfitRatio = result.ProfitPerDay / results[0].ProfitPerDay
		} else {
			result.ProfitRatio = 1.0
		}
	}
}

// Price feed implementations

type CoinGeckoFeed struct {
	client  *http.Client
	baseURL string
}

func NewCoinGeckoFeed(timeout time.Duration) *CoinGeckoFeed {
	return &CoinGeckoFeed{
		client: &http.Client{
			Timeout: timeout,
		},
		baseURL: "https://api.coingecko.com/api/v3",
	}
}

func (cgf *CoinGeckoFeed) Name() string {
	return "coingecko"
}

func (cgf *CoinGeckoFeed) GetPrices(symbols []string) (map[string]float64, error) {
	// Map symbols to CoinGecko IDs
	symbolToID := map[string]string{
		"BTC": "bitcoin",
		"ETH": "ethereum",
		"XMR": "monero",
		"RVN": "ravencoin",
	}
	
	ids := make([]string, 0, len(symbols))
	for _, symbol := range symbols {
		if id, exists := symbolToID[symbol]; exists {
			ids = append(ids, id)
		}
	}
	
	// Make API request
	url := fmt.Sprintf("%s/simple/price?ids=%s&vs_currencies=usd",
		cgf.baseURL, strings.Join(ids, ","))
	
	resp, err := cgf.client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d", resp.StatusCode)
	}
	
	// Parse response
	var data map[string]map[string]float64
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}
	
	// Convert back to symbols
	prices := make(map[string]float64)
	for symbol, id := range symbolToID {
		if priceData, exists := data[id]; exists {
			if price, exists := priceData["usd"]; exists {
				prices[symbol] = price
			}
		}
	}
	
	return prices, nil
}

func (cgf *CoinGeckoFeed) GetExchangeRates(base string, targets []string) (map[string]float64, error) {
	// CoinGecko doesn't provide direct fiat exchange rates
	// This would need to be implemented with a different API
	rates := make(map[string]float64)
	for _, target := range targets {
		if target == "USD" && base == "USD" {
			rates[target] = 1.0
		}
	}
	return rates, nil
}

type CoinMarketCapFeed struct {
	client  *http.Client
	apiKey  string
	baseURL string
}

func NewCoinMarketCapFeed(apiKey string, timeout time.Duration) *CoinMarketCapFeed {
	return &CoinMarketCapFeed{
		client: &http.Client{
			Timeout: timeout,
		},
		apiKey:  apiKey,
		baseURL: "https://pro-api.coinmarketcap.com/v1",
	}
}

func (cmcf *CoinMarketCapFeed) Name() string {
	return "coinmarketcap"
}

func (cmcf *CoinMarketCapFeed) GetPrices(symbols []string) (map[string]float64, error) {
	// Implementation would use CoinMarketCap API
	// Requires API key
	return make(map[string]float64), nil
}

func (cmcf *CoinMarketCapFeed) GetExchangeRates(base string, targets []string) (map[string]float64, error) {
	// Implementation would use CoinMarketCap API
	return make(map[string]float64), nil
}

type BinanceFeed struct {
	client  *http.Client
	baseURL string
}

func NewBinanceFeed(timeout time.Duration) *BinanceFeed {
	return &BinanceFeed{
		client: &http.Client{
			Timeout: timeout,
		},
		baseURL: "https://api.binance.com/api/v3",
	}
}

func (bf *BinanceFeed) Name() string {
	return "binance"
}

func (bf *BinanceFeed) GetPrices(symbols []string) (map[string]float64, error) {
	prices := make(map[string]float64)
	
	// Get ticker prices
	resp, err := bf.client.Get(bf.baseURL + "/ticker/price")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	var tickers []struct {
		Symbol string `json:"symbol"`
		Price  string `json:"price"`
	}
	
	if err := json.NewDecoder(resp.Body).Decode(&tickers); err != nil {
		return nil, err
	}
	
	// Extract prices for requested symbols
	for _, symbol := range symbols {
		for _, ticker := range tickers {
			if ticker.Symbol == symbol+"USDT" || ticker.Symbol == symbol+"BUSD" {
				var price float64
				fmt.Sscanf(ticker.Price, "%f", &price)
				prices[symbol] = price
				break
			}
		}
	}
	
	return prices, nil
}

func (bf *BinanceFeed) GetExchangeRates(base string, targets []string) (map[string]float64, error) {
	// Binance primarily deals with crypto
	// Fiat rates would need a different implementation
	return make(map[string]float64), nil
}

// Utility functions

func calculateMedian(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	
	if len(values) == 1 {
		return values[0]
	}
	
	// Sort values
	sorted := make([]float64, len(values))
	copy(sorted, values)
	
	for i := 0; i < len(sorted); i++ {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[j] < sorted[i] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	
	// Calculate median
	mid := len(sorted) / 2
	if len(sorted)%2 == 0 {
		return (sorted[mid-1] + sorted[mid]) / 2
	}
	return sorted[mid]
}

// GetMetrics returns multi-currency metrics
func (mcs *MultiCurrencySupport) GetMetrics() map[string]interface{} {
	mcs.currenciesMu.RLock()
	currencyCount := len(mcs.currencies)
	mcs.currenciesMu.RUnlock()
	
	mcs.algorithmsMu.RLock()
	algorithmCount := len(mcs.algorithms)
	mcs.algorithmsMu.RUnlock()
	
	return map[string]interface{}{
		"currencies_supported":  mcs.metrics.currenciesSupported,
		"currencies_active":     currencyCount,
		"algorithms_supported":  algorithmCount,
		"rate_updates":          mcs.metrics.rateUpdates,
		"rate_fetch_errors":     mcs.metrics.rateFetchErrors,
		"profit_calculations":   mcs.metrics.profitCalculations,
		"algorithm_switches":    mcs.metrics.algorithmSwitches,
		"rates_last_updated":    mcs.ratesUpdated,
		"price_feeds_active":    len(mcs.priceFeeds),
		"profit_switching":      mcs.config.EnableProfitSwitch,
		"base_currency":         mcs.config.BaseCurrency,
	}
}

// Stop stops the multi-currency support
func (mcs *MultiCurrencySupport) Stop() {
	mcs.logger.Info("Stopping multi-currency support")
	mcs.cancel()
}