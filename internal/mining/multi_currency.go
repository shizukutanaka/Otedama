// Package mining provides multi-currency mining capabilities
package mining

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MultiCurrencyEngine manages mining across multiple cryptocurrencies
type MultiCurrencyEngine struct {
	logger       *zap.Logger
	
	// Currency management
	currencies   map[string]*Currency
	currencyMu   sync.RWMutex
	
	// Mining engines per currency
	engines      map[string]Engine
	enginesMu    sync.RWMutex
	
	// Profit tracking
	profitCalc   *MultiCurrencyProfitCalculator
	
	// Exchange rates
	exchangeRates *ExchangeRateManager
	
	// Portfolio management
	portfolio    *MiningPortfolio
	
	// Auto-switching
	autoSwitch   *CurrencySwitcher
	
	// Configuration
	config       MultiCurrencyConfig
	
	// State
	activeCurrency atomic.Value // string
	
	// Lifecycle
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// MultiCurrencyConfig configures multi-currency mining
type MultiCurrencyConfig struct {
	// Supported currencies
	Currencies           []CurrencyConfig
	
	// Switching parameters
	EnableAutoSwitch     bool
	SwitchThreshold      float64 // Minimum profit increase %
	SwitchCooldown       time.Duration
	
	// Portfolio parameters
	DiversificationRatio float64 // 0-1, how much to diversify
	RebalanceInterval    time.Duration
	
	// Exchange parameters
	ExchangeAPIs         []string
	ExchangeUpdateInterval time.Duration
}

// Currency represents a mineable cryptocurrency
type Currency struct {
	Symbol          string
	Name            string
	Algorithm       string
	
	// Network parameters
	BlockTime       time.Duration
	BlockReward     float64
	Difficulty      float64
	NetworkHashrate float64
	
	// Market data
	PriceUSD        float64
	PriceBTC        float64
	MarketCap       float64
	Volume24h       float64
	
	// Mining parameters
	PoolFee         float64
	MinPayout       float64
	PayoutInterval  time.Duration
	
	// Performance metrics
	CurrentHashrate atomic.Uint64
	AvgHashrate     *RollingAverage
	Profitability   atomic.Value // float64
	
	// State
	LastUpdate      time.Time
	Active          atomic.Bool
}

// CurrencyConfig configures a currency
type CurrencyConfig struct {
	Symbol    string
	Algorithm string
	PoolURL   string
	PoolFee   float64
	Enabled   bool
}

// MultiCurrencyProfitCalculator calculates profit across currencies
type MultiCurrencyProfitCalculator struct {
	electricityCost float64
	
	// Profitability cache
	cache        map[string]*ProfitabilityData
	cacheMu      sync.RWMutex
	cacheExpiry  time.Duration
}

// ProfitabilityData contains profitability information
type ProfitabilityData struct {
	Currency        string
	Revenue         float64
	Cost            float64
	Profit          float64
	ProfitPerMH     float64
	ROI             float64
	PaybackDays     float64
	Timestamp       time.Time
}

// ExchangeRateManager manages exchange rates
type ExchangeRateManager struct {
	rates        map[string]map[string]float64 // from -> to -> rate
	ratesMu      sync.RWMutex
	
	apis         []ExchangeAPI
	lastUpdate   time.Time
	updateMu     sync.Mutex
}

// ExchangeAPI provides exchange rate data
type ExchangeAPI interface {
	GetRates(currencies []string) (map[string]map[string]float64, error)
	Name() string
}

// MiningPortfolio manages mining portfolio allocation
type MiningPortfolio struct {
	allocations  map[string]*PortfolioAllocation
	mu           sync.RWMutex
	
	// Performance tracking
	totalValue   atomic.Value // float64
	dailyReturn  atomic.Value // float64
	
	// Rebalancing
	targetAllocs map[string]float64
	lastRebalance time.Time
}

// PortfolioAllocation represents allocation to a currency
type PortfolioAllocation struct {
	Currency       string
	Percentage     float64
	HashPower      float64
	CurrentValue   float64
	DailyEarnings  float64
	LastUpdate     time.Time
}

// CurrencySwitcher handles automatic currency switching
type CurrencySwitcher struct {
	currentCurrency string
	lastSwitch      time.Time
	switchHistory   []SwitchEvent
	mu              sync.RWMutex
	
	// Decision metrics
	profitThreshold float64
	riskTolerance   float64
}

// SwitchEvent records a currency switch
type SwitchEvent struct {
	From          string
	To            string
	Timestamp     time.Time
	ProfitGain    float64
	Reason        string
}

// RollingAverage maintains a rolling average
type RollingAverage struct {
	window   []float64
	sum      float64
	index    int
	size     int
	filled   bool
	mu       sync.Mutex
}

// NewMultiCurrencyEngine creates a new multi-currency mining engine
func NewMultiCurrencyEngine(config MultiCurrencyConfig, logger *zap.Logger) *MultiCurrencyEngine {
	ctx, cancel := context.WithCancel(context.Background())
	
	mce := &MultiCurrencyEngine{
		logger:     logger,
		currencies: make(map[string]*Currency),
		engines:    make(map[string]Engine),
		config:     config,
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Initialize components
	mce.profitCalc = &MultiCurrencyProfitCalculator{
		electricityCost: 0.10, // Default $0.10/kWh
		cache:           make(map[string]*ProfitabilityData),
		cacheExpiry:     5 * time.Minute,
	}
	
	mce.exchangeRates = &ExchangeRateManager{
		rates: make(map[string]map[string]float64),
		apis:  mce.createExchangeAPIs(config.ExchangeAPIs),
	}
	
	mce.portfolio = &MiningPortfolio{
		allocations:   make(map[string]*PortfolioAllocation),
		targetAllocs:  make(map[string]float64),
	}
	
	mce.autoSwitch = &CurrencySwitcher{
		profitThreshold: config.SwitchThreshold,
		switchHistory:   make([]SwitchEvent, 0, 1000),
	}
	
	// Initialize currencies
	for _, currConfig := range config.Currencies {
		if currConfig.Enabled {
			mce.addCurrency(currConfig)
		}
	}
	
	return mce
}

// Start begins multi-currency mining
func (mce *MultiCurrencyEngine) Start() error {
	mce.logger.Info("Starting multi-currency engine")
	
	// Start exchange rate updates
	mce.wg.Add(1)
	go mce.exchangeRateUpdateLoop()
	
	// Start profitability calculation
	mce.wg.Add(1)
	go mce.profitabilityUpdateLoop()
	
	// Start portfolio management
	mce.wg.Add(1)
	go mce.portfolioManagementLoop()
	
	// Start auto-switching if enabled
	if mce.config.EnableAutoSwitch {
		mce.wg.Add(1)
		go mce.autoSwitchLoop()
	}
	
	// Start with most profitable currency
	if best := mce.findMostProfitable(); best != nil {
		mce.switchToCurrency(best.Symbol)
	}
	
	return nil
}

// Stop gracefully stops multi-currency mining
func (mce *MultiCurrencyEngine) Stop() error {
	mce.logger.Info("Stopping multi-currency engine")
	
	// Stop all engines
	mce.enginesMu.RLock()
	for _, engine := range mce.engines {
		if err := engine.Stop(); err != nil {
			mce.logger.Error("Failed to stop engine", zap.Error(err))
		}
	}
	mce.enginesMu.RUnlock()
	
	mce.cancel()
	mce.wg.Wait()
	return nil
}

// AddCurrency adds a new currency for mining
func (mce *MultiCurrencyEngine) AddCurrency(symbol string, config CurrencyConfig) error {
	mce.currencyMu.Lock()
	defer mce.currencyMu.Unlock()
	
	if _, exists := mce.currencies[symbol]; exists {
		return fmt.Errorf("currency %s already exists", symbol)
	}
	
	currency := mce.createCurrency(config)
	mce.currencies[symbol] = currency
	
	// Create mining engine for this currency
	engine := mce.createEngineForCurrency(currency)
	mce.enginesMu.Lock()
	mce.engines[symbol] = engine
	mce.enginesMu.Unlock()
	
	mce.logger.Info("Added currency",
		zap.String("symbol", symbol),
		zap.String("algorithm", config.Algorithm))
	
	return nil
}

// RemoveCurrency removes a currency from mining
func (mce *MultiCurrencyEngine) RemoveCurrency(symbol string) error {
	mce.currencyMu.Lock()
	defer mce.currencyMu.Unlock()
	
	currency, exists := mce.currencies[symbol]
	if !exists {
		return fmt.Errorf("currency %s not found", symbol)
	}
	
	// Stop engine if active
	if currency.Active.Load() {
		mce.enginesMu.RLock()
		if engine, exists := mce.engines[symbol]; exists {
			engine.Stop()
		}
		mce.enginesMu.RUnlock()
	}
	
	delete(mce.currencies, symbol)
	
	mce.enginesMu.Lock()
	delete(mce.engines, symbol)
	mce.enginesMu.Unlock()
	
	return nil
}

// SwitchCurrency switches to mining a different currency
func (mce *MultiCurrencyEngine) SwitchCurrency(symbol string) error {
	mce.currencyMu.RLock()
	currency, exists := mce.currencies[symbol]
	mce.currencyMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("currency %s not found", symbol)
	}
	
	return mce.switchToCurrency(symbol)
}

// GetCurrentCurrency returns the currently mined currency
func (mce *MultiCurrencyEngine) GetCurrentCurrency() string {
	curr := mce.activeCurrency.Load()
	if curr == nil {
		return ""
	}
	return curr.(string)
}

// GetProfitability returns profitability data for all currencies
func (mce *MultiCurrencyEngine) GetProfitability() map[string]*ProfitabilityData {
	mce.profitCalc.cacheMu.RLock()
	defer mce.profitCalc.cacheMu.RUnlock()
	
	result := make(map[string]*ProfitabilityData)
	for symbol, data := range mce.profitCalc.cache {
		if time.Since(data.Timestamp) < mce.profitCalc.cacheExpiry {
			result[symbol] = data
		}
	}
	
	return result
}

// GetPortfolio returns current portfolio allocation
func (mce *MultiCurrencyEngine) GetPortfolio() map[string]*PortfolioAllocation {
	mce.portfolio.mu.RLock()
	defer mce.portfolio.mu.RUnlock()
	
	result := make(map[string]*PortfolioAllocation)
	for symbol, alloc := range mce.portfolio.allocations {
		result[symbol] = &PortfolioAllocation{
			Currency:      alloc.Currency,
			Percentage:    alloc.Percentage,
			HashPower:     alloc.HashPower,
			CurrentValue:  alloc.CurrentValue,
			DailyEarnings: alloc.DailyEarnings,
			LastUpdate:    alloc.LastUpdate,
		}
	}
	
	return result
}

// Internal methods

func (mce *MultiCurrencyEngine) exchangeRateUpdateLoop() {
	defer mce.wg.Done()
	
	// Initial update
	mce.updateExchangeRates()
	
	ticker := time.NewTicker(mce.config.ExchangeUpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-mce.ctx.Done():
			return
		case <-ticker.C:
			mce.updateExchangeRates()
		}
	}
}

func (mce *MultiCurrencyEngine) updateExchangeRates() {
	mce.exchangeRates.updateMu.Lock()
	defer mce.exchangeRates.updateMu.Unlock()
	
	// Get list of currencies
	mce.currencyMu.RLock()
	symbols := make([]string, 0, len(mce.currencies))
	for symbol := range mce.currencies {
		symbols = append(symbols, symbol)
	}
	mce.currencyMu.RUnlock()
	
	// Fetch rates from each API
	allRates := make(map[string]map[string]float64)
	for _, api := range mce.exchangeRates.apis {
		rates, err := api.GetRates(symbols)
		if err != nil {
			mce.logger.Error("Failed to get exchange rates",
				zap.String("api", api.Name()),
				zap.Error(err))
			continue
		}
		
		// Merge rates
		for from, toRates := range rates {
			if allRates[from] == nil {
				allRates[from] = make(map[string]float64)
			}
			for to, rate := range toRates {
				allRates[from][to] = rate
			}
		}
	}
	
	// Update rates
	mce.exchangeRates.ratesMu.Lock()
	mce.exchangeRates.rates = allRates
	mce.exchangeRates.lastUpdate = time.Now()
	mce.exchangeRates.ratesMu.Unlock()
}

func (mce *MultiCurrencyEngine) profitabilityUpdateLoop() {
	defer mce.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-mce.ctx.Done():
			return
		case <-ticker.C:
			mce.updateAllProfitability()
		}
	}
}

func (mce *MultiCurrencyEngine) updateAllProfitability() {
	mce.currencyMu.RLock()
	currencies := make([]*Currency, 0, len(mce.currencies))
	for _, currency := range mce.currencies {
		currencies = append(currencies, currency)
	}
	mce.currencyMu.RUnlock()
	
	var wg sync.WaitGroup
	for _, currency := range currencies {
		wg.Add(1)
		go func(curr *Currency) {
			defer wg.Done()
			mce.updateCurrencyProfitability(curr)
		}(currency)
	}
	wg.Wait()
}

func (mce *MultiCurrencyEngine) updateCurrencyProfitability(currency *Currency) {
	// Get current hashrate for this algorithm
	hashrate := float64(currency.CurrentHashrate.Load())
	if hashrate == 0 {
		hashrate = mce.estimateHashrate(currency.Algorithm)
	}
	
	// Calculate daily revenue
	blocksPerDay := (hashrate / currency.NetworkHashrate) * (86400 / currency.BlockTime.Seconds())
	coinsPerDay := blocksPerDay * currency.BlockReward
	revenuePerDay := coinsPerDay * currency.PriceUSD
	
	// Calculate costs
	power := mce.estimatePower(currency.Algorithm, hashrate)
	powerCostPerDay := (power / 1000) * 24 * mce.profitCalc.electricityCost
	poolFeePerDay := revenuePerDay * currency.PoolFee
	
	// Calculate profit
	profitPerDay := revenuePerDay - powerCostPerDay - poolFeePerDay
	
	// Calculate additional metrics
	profitPerMH := profitPerDay / (hashrate / 1000000)
	roi := profitPerDay / powerCostPerDay
	paybackDays := 1000 / profitPerDay // Assuming $1000 hardware cost
	
	// Update cache
	profitData := &ProfitabilityData{
		Currency:    currency.Symbol,
		Revenue:     revenuePerDay,
		Cost:        powerCostPerDay + poolFeePerDay,
		Profit:      profitPerDay,
		ProfitPerMH: profitPerMH,
		ROI:         roi,
		PaybackDays: paybackDays,
		Timestamp:   time.Now(),
	}
	
	mce.profitCalc.cacheMu.Lock()
	mce.profitCalc.cache[currency.Symbol] = profitData
	mce.profitCalc.cacheMu.Unlock()
	
	// Update currency profitability
	currency.Profitability.Store(profitPerDay)
}

func (mce *MultiCurrencyEngine) portfolioManagementLoop() {
	defer mce.wg.Done()
	
	ticker := time.NewTicker(mce.config.RebalanceInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-mce.ctx.Done():
			return
		case <-ticker.C:
			mce.rebalancePortfolio()
		}
	}
}

func (mce *MultiCurrencyEngine) rebalancePortfolio() {
	// Get current profitability
	profitData := mce.GetProfitability()
	
	// Calculate optimal allocation
	allocations := mce.calculateOptimalAllocation(profitData)
	
	// Update portfolio
	mce.portfolio.mu.Lock()
	defer mce.portfolio.mu.Unlock()
	
	totalValue := 0.0
	totalEarnings := 0.0
	
	for symbol, percentage := range allocations {
		if profit, exists := profitData[symbol]; exists {
			alloc := &PortfolioAllocation{
				Currency:      symbol,
				Percentage:    percentage,
				HashPower:     percentage * 100, // Simplified
				CurrentValue:  profit.Profit * 30, // 30 day value
				DailyEarnings: profit.Profit,
				LastUpdate:    time.Now(),
			}
			
			mce.portfolio.allocations[symbol] = alloc
			totalValue += alloc.CurrentValue
			totalEarnings += alloc.DailyEarnings
		}
	}
	
	mce.portfolio.totalValue.Store(totalValue)
	mce.portfolio.dailyReturn.Store(totalEarnings)
	mce.portfolio.lastRebalance = time.Now()
}

func (mce *MultiCurrencyEngine) calculateOptimalAllocation(profitData map[string]*ProfitabilityData) map[string]float64 {
	// Sort by profitability
	type profitEntry struct {
		symbol string
		profit float64
	}
	
	entries := make([]profitEntry, 0, len(profitData))
	totalProfit := 0.0
	
	for symbol, data := range profitData {
		if data.Profit > 0 {
			entries = append(entries, profitEntry{symbol, data.Profit})
			totalProfit += data.Profit
		}
	}
	
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].profit > entries[j].profit
	})
	
	// Calculate allocations based on diversification ratio
	allocations := make(map[string]float64)
	
	if len(entries) == 0 {
		return allocations
	}
	
	// Allocate based on profitability and diversification
	diversificationWeight := mce.config.DiversificationRatio
	concentrationWeight := 1.0 - diversificationWeight
	
	for i, entry := range entries {
		// Base allocation proportional to profit
		baseAlloc := entry.profit / totalProfit
		
		// Concentration bonus for top performers
		rank := float64(i + 1)
		concentrationBonus := concentrationWeight * math.Exp(-rank/2)
		
		// Diversification ensures minimum allocation
		diversificationAlloc := diversificationWeight / float64(len(entries))
		
		// Final allocation
		allocation := baseAlloc*concentrationWeight + concentrationBonus + diversificationAlloc
		allocations[entry.symbol] = allocation
	}
	
	// Normalize to 100%
	total := 0.0
	for _, alloc := range allocations {
		total += alloc
	}
	
	for symbol, alloc := range allocations {
		allocations[symbol] = alloc / total
	}
	
	return allocations
}

func (mce *MultiCurrencyEngine) autoSwitchLoop() {
	defer mce.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-mce.ctx.Done():
			return
		case <-ticker.C:
			mce.evaluateAutoSwitch()
		}
	}
}

func (mce *MultiCurrencyEngine) evaluateAutoSwitch() {
	// Check cooldown
	if time.Since(mce.autoSwitch.lastSwitch) < mce.config.SwitchCooldown {
		return
	}
	
	currentCurrency := mce.GetCurrentCurrency()
	if currentCurrency == "" {
		return
	}
	
	// Get current profitability
	profitData := mce.GetProfitability()
	currentProfit := 0.0
	if data, exists := profitData[currentCurrency]; exists {
		currentProfit = data.Profit
	}
	
	// Find best alternative
	bestCurrency := ""
	bestProfit := currentProfit
	
	for symbol, data := range profitData {
		if symbol != currentCurrency && data.Profit > bestProfit {
			bestCurrency = symbol
			bestProfit = data.Profit
		}
	}
	
	// Check if switch is worthwhile
	if bestCurrency != "" {
		profitIncrease := (bestProfit - currentProfit) / currentProfit * 100
		if profitIncrease >= mce.config.SwitchThreshold {
			mce.logger.Info("Auto-switching currency",
				zap.String("from", currentCurrency),
				zap.String("to", bestCurrency),
				zap.Float64("profit_increase", profitIncrease))
			
			if err := mce.switchToCurrency(bestCurrency); err == nil {
				// Record switch event
				event := SwitchEvent{
					From:       currentCurrency,
					To:         bestCurrency,
					Timestamp:  time.Now(),
					ProfitGain: profitIncrease,
					Reason:     "Auto-switch: higher profitability",
				}
				
				mce.autoSwitch.mu.Lock()
				mce.autoSwitch.switchHistory = append(mce.autoSwitch.switchHistory, event)
				if len(mce.autoSwitch.switchHistory) > 1000 {
					mce.autoSwitch.switchHistory = mce.autoSwitch.switchHistory[len(mce.autoSwitch.switchHistory)-1000:]
				}
				mce.autoSwitch.lastSwitch = time.Now()
				mce.autoSwitch.mu.Unlock()
			}
		}
	}
}

func (mce *MultiCurrencyEngine) switchToCurrency(symbol string) error {
	// Stop current mining
	current := mce.GetCurrentCurrency()
	if current != "" {
		mce.enginesMu.RLock()
		if engine, exists := mce.engines[current]; exists {
			engine.Stop()
		}
		mce.enginesMu.RUnlock()
		
		mce.currencyMu.RLock()
		if currency, exists := mce.currencies[current]; exists {
			currency.Active.Store(false)
		}
		mce.currencyMu.RUnlock()
	}
	
	// Start new currency
	mce.enginesMu.RLock()
	engine, exists := mce.engines[symbol]
	mce.enginesMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("engine not found for currency %s", symbol)
	}
	
	if err := engine.Start(); err != nil {
		return fmt.Errorf("failed to start engine: %w", err)
	}
	
	mce.currencyMu.RLock()
	if currency, exists := mce.currencies[symbol]; exists {
		currency.Active.Store(true)
	}
	mce.currencyMu.RUnlock()
	
	mce.activeCurrency.Store(symbol)
	mce.autoSwitch.currentCurrency = symbol
	
	return nil
}

func (mce *MultiCurrencyEngine) findMostProfitable() *Currency {
	mce.updateAllProfitability()
	
	mce.currencyMu.RLock()
	defer mce.currencyMu.RUnlock()
	
	var best *Currency
	var bestProfit float64
	
	for _, currency := range mce.currencies {
		profit := 0.0
		if p := currency.Profitability.Load(); p != nil {
			profit = p.(float64)
		}
		
		if profit > bestProfit {
			best = currency
			bestProfit = profit
		}
	}
	
	return best
}

// Helper methods

func (mce *MultiCurrencyEngine) addCurrency(config CurrencyConfig) {
	currency := mce.createCurrency(config)
	
	mce.currencyMu.Lock()
	mce.currencies[config.Symbol] = currency
	mce.currencyMu.Unlock()
	
	// Create engine
	engine := mce.createEngineForCurrency(currency)
	mce.enginesMu.Lock()
	mce.engines[config.Symbol] = engine
	mce.enginesMu.Unlock()
}

func (mce *MultiCurrencyEngine) createCurrency(config CurrencyConfig) *Currency {
	return &Currency{
		Symbol:      config.Symbol,
		Algorithm:   config.Algorithm,
		PoolFee:     config.PoolFee,
		AvgHashrate: NewRollingAverage(100),
		LastUpdate:  time.Now(),
	}
}

func (mce *MultiCurrencyEngine) createEngineForCurrency(currency *Currency) Engine {
	// This would create an actual mining engine
	// For now, return a placeholder
	return &placeholderEngine{currency: currency}
}

func (mce *MultiCurrencyEngine) createExchangeAPIs(urls []string) []ExchangeAPI {
	// This would create actual exchange API clients
	apis := make([]ExchangeAPI, 0)
	for _, url := range urls {
		apis = append(apis, &placeholderExchangeAPI{url: url})
	}
	return apis
}

func (mce *MultiCurrencyEngine) estimateHashrate(algorithm string) float64 {
	// Estimate based on algorithm
	estimates := map[string]float64{
		"sha256d": 100000000000,    // 100 GH/s
		"scrypt":  1000000,          // 1 MH/s
		"ethash":  30000000,         // 30 MH/s
		"randomx": 10000,            // 10 KH/s
		"kawpow":  20000000,         // 20 MH/s
	}
	
	if estimate, exists := estimates[algorithm]; exists {
		return estimate
	}
	return 1000000 // Default 1 MH/s
}

func (mce *MultiCurrencyEngine) estimatePower(algorithm string, hashrate float64) float64 {
	// Power consumption per MH/s
	powerPerMH := map[string]float64{
		"sha256d": 0.00001,  // Very efficient (ASICs)
		"scrypt":  0.5,      // Less efficient
		"ethash":  0.3,      // GPU mining
		"randomx": 10.0,     // CPU intensive
		"kawpow":  0.4,      // GPU mining
	}
	
	if ppm, exists := powerPerMH[algorithm]; exists {
		return (hashrate / 1000000) * ppm
	}
	return 100 // Default 100W
}

// RollingAverage implementation
func NewRollingAverage(size int) *RollingAverage {
	return &RollingAverage{
		window: make([]float64, size),
		size:   size,
	}
}

func (ra *RollingAverage) Add(value float64) {
	ra.mu.Lock()
	defer ra.mu.Unlock()
	
	if ra.filled {
		ra.sum -= ra.window[ra.index]
	}
	
	ra.window[ra.index] = value
	ra.sum += value
	ra.index = (ra.index + 1) % ra.size
	
	if !ra.filled && ra.index == 0 {
		ra.filled = true
	}
}

func (ra *RollingAverage) Average() float64 {
	ra.mu.Lock()
	defer ra.mu.Unlock()
	
	count := ra.size
	if !ra.filled {
		count = ra.index
	}
	
	if count == 0 {
		return 0
	}
	
	return ra.sum / float64(count)
}

// Placeholder implementations
type placeholderEngine struct {
	currency *Currency
	running  bool
}

func (e *placeholderEngine) Start() error {
	e.running = true
	return nil
}

func (e *placeholderEngine) Stop() error {
	e.running = false
	return nil
}

func (e *placeholderEngine) GetStats() *Stats {
	return &Stats{
		HashRate: uint64(e.currency.AvgHashrate.Average()),
	}
}

func (e *placeholderEngine) SubmitShare(share *Share) error {
	return nil
}

func (e *placeholderEngine) SwitchAlgorithm(algo Algorithm) error {
	return nil
}

func (e *placeholderEngine) GetCurrentJob() *Job {
	return nil
}

type placeholderExchangeAPI struct {
	url string
}

func (api *placeholderExchangeAPI) GetRates(currencies []string) (map[string]map[string]float64, error) {
	// Placeholder rates
	rates := make(map[string]map[string]float64)
	for _, currency := range currencies {
		rates[currency] = map[string]float64{
			"USD": 1000.0,
			"BTC": 0.02,
		}
	}
	return rates, nil
}

func (api *placeholderExchangeAPI) Name() string {
	return "placeholder"
}