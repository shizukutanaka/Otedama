package mining

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ProfitSwitcher automatically switches to the most profitable coin
type ProfitSwitcher struct {
	logger   *zap.Logger
	engine   Engine
	
	// State
	running         atomic.Bool
	currentCoin     atomic.Value // *CoinInfo
	switching       atomic.Bool
	
	// Configuration
	config          ProfitSwitcherConfig
	supportedCoins  map[string]*CoinInfo
	coinsMu         sync.RWMutex
	
	// Price tracking
	priceTracker    *PriceTracker
	difficultyCache map[string]float64
	cacheMu         sync.RWMutex
	
	// Performance history
	history         map[string]*CoinPerformance
	historyMu       sync.RWMutex
	
	// Switching logic
	lastSwitch      time.Time
	switchCount     atomic.Uint32
	
	// Context
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// ProfitSwitcherConfig configures profit switching behavior
type ProfitSwitcherConfig struct {
	Enabled          bool              `yaml:"enabled"`
	CheckInterval    time.Duration     `yaml:"check_interval"`
	MinSwitchTime    time.Duration     `yaml:"min_switch_time"`    // Minimum time between switches
	MinImprovement   float64           `yaml:"min_improvement"`     // Minimum % improvement to switch
	
	// API Configuration
	PriceAPIs        []PriceAPIConfig  `yaml:"price_apis"`
	
	// Supported coins
	Coins            []CoinConfig      `yaml:"coins"`
	
	// Advanced settings
	ConsiderFees     bool              `yaml:"consider_fees"`
	PowerCost        float64           `yaml:"power_cost"`          // $/kWh
	PoolFees         map[string]float64 `yaml:"pool_fees"`          // Pool fees by coin
	
	// Stability settings
	StabilityWeight  float64           `yaml:"stability_weight"`    // Weight for coin stability (0-1)
	HistoryWindow    time.Duration     `yaml:"history_window"`      // How long to track performance
}

// PriceAPIConfig configures a price API
type PriceAPIConfig struct {
	Name     string            `yaml:"name"`
	URL      string            `yaml:"url"`
	APIKey   string            `yaml:"api_key"`
	Interval time.Duration     `yaml:"interval"`
	Coins    map[string]string `yaml:"coins"` // coin symbol -> API symbol mapping
}

// CoinConfig configures a mineable coin
type CoinConfig struct {
	Symbol          string    `yaml:"symbol"`
	Name            string    `yaml:"name"`
	Algorithm       Algorithm `yaml:"algorithm"`
	PoolURL         string    `yaml:"pool_url"`
	WalletAddress   string    `yaml:"wallet_address"`
	ExtraConfig     map[string]interface{} `yaml:"extra_config"`
}

// CoinInfo contains information about a coin
type CoinInfo struct {
	Config          CoinConfig
	
	// Market data
	Price           float64   `json:"price"`
	Volume24h       float64   `json:"volume_24h"`
	MarketCap       float64   `json:"market_cap"`
	PriceChange24h  float64   `json:"price_change_24h"`
	
	// Mining data
	Difficulty      float64   `json:"difficulty"`
	BlockReward     float64   `json:"block_reward"`
	NetworkHashrate float64   `json:"network_hashrate"`
	BlockTime       float64   `json:"block_time"`
	
	// Calculated metrics
	Profitability   float64   `json:"profitability"`    // Revenue per hash
	ExpectedRevenue float64   `json:"expected_revenue"` // Daily revenue estimate
	
	// Metadata
	LastUpdate      time.Time `json:"last_update"`
}

// CoinPerformance tracks historical performance
type CoinPerformance struct {
	Symbol          string
	
	// Performance metrics
	TotalShares     uint64
	AcceptedShares  uint64
	RejectedShares  uint64
	TotalTime       time.Duration
	
	// Revenue tracking
	EstimatedRevenue float64
	ActualRevenue    float64
	
	// Stability metrics
	Switches        int
	Crashes         int
	AverageHashrate float64
	HashVariance    float64
	
	// Time tracking
	FirstSeen       time.Time
	LastActive      time.Time
}

// PriceTracker tracks cryptocurrency prices
type PriceTracker struct {
	logger      *zap.Logger
	apis        []PriceAPIConfig
	priceCache  map[string]float64
	cacheMu     sync.RWMutex
	httpClient  *http.Client
}

// NewProfitSwitcher creates a new profit switcher
func NewProfitSwitcher(logger *zap.Logger, engine Engine, config ProfitSwitcherConfig) *ProfitSwitcher {
	ctx, cancel := context.WithCancel(context.Background())
	
	ps := &ProfitSwitcher{
		logger:          logger,
		engine:          engine,
		config:          config,
		supportedCoins:  make(map[string]*CoinInfo),
		difficultyCache: make(map[string]float64),
		history:         make(map[string]*CoinPerformance),
		lastSwitch:      time.Now(),
		ctx:             ctx,
		cancel:          cancel,
	}
	
	// Initialize price tracker
	ps.priceTracker = &PriceTracker{
		logger:     logger,
		apis:       config.PriceAPIs,
		priceCache: make(map[string]float64),
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
	
	// Initialize supported coins
	ps.initializeCoinInfo()
	
	return ps
}

// Start begins profit switching
func (ps *ProfitSwitcher) Start() error {
	if !ps.running.CompareAndSwap(false, true) {
		return fmt.Errorf("profit switcher already running")
	}
	
	ps.logger.Info("Starting profit switcher",
		zap.Duration("check_interval", ps.config.CheckInterval),
		zap.Float64("min_improvement", ps.config.MinImprovement),
		zap.Int("supported_coins", len(ps.supportedCoins)),
	)
	
	// Start price tracking
	ps.wg.Add(1)
	go ps.priceUpdateLoop()
	
	// Start profit checking
	if ps.config.Enabled {
		ps.wg.Add(1)
		go ps.profitCheckLoop()
	}
	
	// Start performance tracking
	ps.wg.Add(1)
	go ps.performanceTrackingLoop()
	
	return nil
}

// Stop stops profit switching
func (ps *ProfitSwitcher) Stop() error {
	if !ps.running.CompareAndSwap(true, false) {
		return fmt.Errorf("profit switcher not running")
	}
	
	ps.logger.Info("Stopping profit switcher")
	
	ps.cancel()
	ps.wg.Wait()
	
	return nil
}

// GetCurrentCoin returns the currently mining coin
func (ps *ProfitSwitcher) GetCurrentCoin() *CoinInfo {
	if coin := ps.currentCoin.Load(); coin != nil {
		return coin.(*CoinInfo)
	}
	return nil
}

// GetCoinInfo returns information about all coins
func (ps *ProfitSwitcher) GetCoinInfo() map[string]*CoinInfo {
	ps.coinsMu.RLock()
	defer ps.coinsMu.RUnlock()
	
	coins := make(map[string]*CoinInfo)
	for k, v := range ps.supportedCoins {
		coins[k] = v
	}
	
	return coins
}

// GetPerformanceHistory returns performance history
func (ps *ProfitSwitcher) GetPerformanceHistory() map[string]*CoinPerformance {
	ps.historyMu.RLock()
	defer ps.historyMu.RUnlock()
	
	history := make(map[string]*CoinPerformance)
	for k, v := range ps.history {
		history[k] = v
	}
	
	return history
}

// ManualSwitch manually switches to a specific coin
func (ps *ProfitSwitcher) ManualSwitch(symbol string) error {
	ps.coinsMu.RLock()
	coin, exists := ps.supportedCoins[symbol]
	ps.coinsMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("unsupported coin: %s", symbol)
	}
	
	return ps.switchToCoin(coin)
}

// priceUpdateLoop updates cryptocurrency prices
func (ps *ProfitSwitcher) priceUpdateLoop() {
	defer ps.wg.Done()
	
	// Initial update
	ps.updatePrices()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.updatePrices()
		}
	}
}

// profitCheckLoop checks profitability and switches coins
func (ps *ProfitSwitcher) profitCheckLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(ps.config.CheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.checkAndSwitch()
		}
	}
}

// performanceTrackingLoop tracks mining performance
func (ps *ProfitSwitcher) performanceTrackingLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.updatePerformanceMetrics()
		}
	}
}

// checkAndSwitch checks profitability and switches if beneficial
func (ps *ProfitSwitcher) checkAndSwitch() {
	// Check if enough time has passed since last switch
	if time.Since(ps.lastSwitch) < ps.config.MinSwitchTime {
		return
	}
	
	// Calculate profitability for all coins
	profitabilities := ps.calculateProfitabilities()
	
	// Sort by profitability
	sort.Slice(profitabilities, func(i, j int) bool {
		return profitabilities[i].score > profitabilities[j].score
	})
	
	if len(profitabilities) == 0 {
		return
	}
	
	// Get current coin
	current := ps.GetCurrentCoin()
	best := profitabilities[0]
	
	// Check if should switch
	if current == nil || best.coin.Config.Symbol != current.Config.Symbol {
		var improvement float64
		if current != nil && current.Profitability > 0 {
			improvement = (best.score - current.Profitability) / current.Profitability * 100
		} else {
			improvement = 100 // Always switch if no current coin
		}
		
		if improvement >= ps.config.MinImprovement {
			ps.logger.Info("Switching to more profitable coin",
				zap.String("from", ps.getCoinSymbol(current)),
				zap.String("to", best.coin.Config.Symbol),
				zap.Float64("improvement", improvement),
				zap.Float64("score", best.score),
			)
			
			if err := ps.switchToCoin(best.coin); err != nil {
				ps.logger.Error("Failed to switch coin", zap.Error(err))
			}
		}
	}
}

// ProfitabilityScore represents a coin's profitability score
type ProfitabilityScore struct {
	coin  *CoinInfo
	score float64
}

// calculateProfitabilities calculates profitability scores for all coins
func (ps *ProfitSwitcher) calculateProfitabilities() []ProfitabilityScore {
	ps.coinsMu.RLock()
	defer ps.coinsMu.RUnlock()
	
	var scores []ProfitabilityScore
	
	for _, coin := range ps.supportedCoins {
		score := ps.calculateCoinScore(coin)
		if score > 0 {
			scores = append(scores, ProfitabilityScore{
				coin:  coin,
				score: score,
			})
		}
	}
	
	return scores
}

// calculateCoinScore calculates a comprehensive score for a coin
func (ps *ProfitSwitcher) calculateCoinScore(coin *CoinInfo) float64 {
	// Base profitability
	profitability := ps.calculateProfitability(coin)
	if profitability <= 0 {
		return 0
	}
	
	score := profitability
	
	// Apply stability weight
	if ps.config.StabilityWeight > 0 {
		stability := ps.getCoinStability(coin.Config.Symbol)
		score = score*(1-ps.config.StabilityWeight) + stability*ps.config.StabilityWeight
	}
	
	// Consider fees
	if ps.config.ConsiderFees {
		poolFee := ps.config.PoolFees[coin.Config.Symbol]
		score *= (1 - poolFee/100)
	}
	
	// Consider market conditions
	if coin.PriceChange24h < -10 { // Significant drop
		score *= 0.9 // Reduce score
	} else if coin.PriceChange24h > 10 { // Significant rise
		score *= 1.1 // Increase score
	}
	
	return score
}

// calculateProfitability calculates coin profitability
func (ps *ProfitSwitcher) calculateProfitability(coin *CoinInfo) float64 {
	if coin.Price <= 0 || coin.Difficulty <= 0 {
		return 0
	}
	
	// Get expected hashrate for this algorithm
	hashrate := ps.getExpectedHashrate(coin.Config.Algorithm)
	if hashrate <= 0 {
		return 0
	}
	
	// Calculate expected coins per day
	// This is a simplified calculation - actual implementation would be coin-specific
	secondsPerDay := float64(86400)
	coinsPerDay := (hashrate / coin.Difficulty) * coin.BlockReward * (secondsPerDay / coin.BlockTime)
	
	// Calculate revenue
	revenue := coinsPerDay * coin.Price
	
	// Subtract power costs if configured
	if ps.config.PowerCost > 0 {
		powerUsage := ps.getPowerUsage(coin.Config.Algorithm) // in kW
		powerCost := powerUsage * 24 * ps.config.PowerCost
		revenue -= powerCost
	}
	
	return revenue
}

// getExpectedHashrate returns expected hashrate for an algorithm
func (ps *ProfitSwitcher) getExpectedHashrate(algo Algorithm) float64 {
	// In production, this would get actual hashrate from hardware
	// For now, return estimates based on algorithm
	switch algo {
	case AlgorithmSHA256:
		return 100e12 // 100 TH/s
	case AlgorithmScrypt:
		return 1e9 // 1 GH/s
	case AlgorithmEthash:
		return 100e6 // 100 MH/s
	case AlgorithmRandomX:
		return 10e3 // 10 KH/s
	default:
		return 0
	}
}

// getPowerUsage returns power usage for an algorithm in kW
func (ps *ProfitSwitcher) getPowerUsage(algo Algorithm) float64 {
	// In production, this would get actual power usage
	// For now, return estimates
	switch algo {
	case AlgorithmSHA256:
		return 3.0 // 3000W
	case AlgorithmScrypt:
		return 1.5 // 1500W
	case AlgorithmEthash:
		return 0.3 // 300W
	case AlgorithmRandomX:
		return 0.1 // 100W
	default:
		return 0.5 // 500W default
	}
}

// getCoinStability returns stability score (0-1) for a coin
func (ps *ProfitSwitcher) getCoinStability(symbol string) float64 {
	ps.historyMu.RLock()
	perf, exists := ps.history[symbol]
	ps.historyMu.RUnlock()
	
	if !exists || perf.TotalTime < 1*time.Hour {
		return 0.5 // Neutral for new coins
	}
	
	// Calculate stability based on:
	// - Share acceptance rate
	// - Hashrate variance
	// - Crash frequency
	
	acceptanceRate := float64(perf.AcceptedShares) / float64(perf.TotalShares+1)
	crashRate := float64(perf.Crashes) / (perf.TotalTime.Hours() + 1)
	varianceScore := 1 / (1 + perf.HashVariance/perf.AverageHashrate)
	
	stability := (acceptanceRate*0.4 + varianceScore*0.4 + (1-math.Min(crashRate, 1))*0.2)
	
	return math.Max(0, math.Min(1, stability))
}

// switchToCoin switches mining to a different coin
func (ps *ProfitSwitcher) switchToCoin(coin *CoinInfo) error {
	if !ps.switching.CompareAndSwap(false, true) {
		return fmt.Errorf("switch already in progress")
	}
	defer ps.switching.Store(false)
	
	// Stop current mining
	if err := ps.engine.Stop(); err != nil {
		return fmt.Errorf("failed to stop engine: %w", err)
	}
	
	// Configure for new coin
	if err := ps.engine.SetAlgorithm(coin.Config.Algorithm); err != nil {
		return fmt.Errorf("failed to set algorithm: %w", err)
	}
	
	// Update pool configuration
	if err := ps.engine.SetPool(coin.Config.PoolURL, coin.Config.WalletAddress); err != nil {
		return fmt.Errorf("failed to set pool: %w", err)
	}
	
	// Apply extra configuration
	for key, value := range coin.Config.ExtraConfig {
		if err := ps.engine.SetConfig(key, value); err != nil {
			ps.logger.Warn("Failed to set config",
				zap.String("key", key),
				zap.Error(err),
			)
		}
	}
	
	// Start mining
	if err := ps.engine.Start(); err != nil {
		return fmt.Errorf("failed to start engine: %w", err)
	}
	
	// Update state
	ps.currentCoin.Store(coin)
	ps.lastSwitch = time.Now()
	ps.switchCount.Add(1)
	
	// Update history
	ps.recordSwitch(coin.Config.Symbol)
	
	return nil
}

// updatePrices updates cryptocurrency prices
func (ps *ProfitSwitcher) updatePrices() {
	for _, api := range ps.config.PriceAPIs {
		ps.updatePricesFromAPI(api)
	}
	
	// Update profitability calculations
	ps.updateProfitabilities()
}

// updatePricesFromAPI updates prices from a specific API
func (ps *ProfitSwitcher) updatePricesFromAPI(api PriceAPIConfig) {
	// In production, this would make actual API calls
	// For now, simulate with random prices
	
	ps.coinsMu.Lock()
	defer ps.coinsMu.Unlock()
	
	for symbol, coin := range ps.supportedCoins {
		// Simulate price update
		if coin.Price == 0 {
			// Initial price
			switch symbol {
			case "BTC":
				coin.Price = 50000
			case "ETH":
				coin.Price = 3000
			case "LTC":
				coin.Price = 100
			default:
				coin.Price = 10
			}
		} else {
			// Random walk
			change := (0.5 - ps.random()) * 0.02 // ±1% change
			coin.Price *= (1 + change)
		}
		
		coin.PriceChange24h = (ps.random() - 0.5) * 20 // ±10%
		coin.LastUpdate = time.Now()
		
		// Update difficulty (simulate)
		if coin.Difficulty == 0 {
			coin.Difficulty = 1e12
		}
		coin.Difficulty *= (1 + (ps.random()-0.5)*0.01) // ±0.5% change
	}
}

// updateProfitabilities updates profitability calculations
func (ps *ProfitSwitcher) updateProfitabilities() {
	ps.coinsMu.Lock()
	defer ps.coinsMu.Unlock()
	
	for _, coin := range ps.supportedCoins {
		coin.Profitability = ps.calculateProfitability(coin)
		coin.ExpectedRevenue = coin.Profitability // Daily revenue
	}
}

// updatePerformanceMetrics updates performance tracking
func (ps *ProfitSwitcher) updatePerformanceMetrics() {
	current := ps.GetCurrentCoin()
	if current == nil {
		return
	}
	
	symbol := current.Config.Symbol
	
	ps.historyMu.Lock()
	defer ps.historyMu.Unlock()
	
	perf, exists := ps.history[symbol]
	if !exists {
		perf = &CoinPerformance{
			Symbol:    symbol,
			FirstSeen: time.Now(),
		}
		ps.history[symbol] = perf
	}
	
	// Update metrics
	stats := ps.engine.GetStats()
	perf.TotalShares = stats.SharesSubmitted
	perf.AcceptedShares = stats.SharesAccepted
	perf.RejectedShares = stats.SharesRejected
	perf.LastActive = time.Now()
	
	// Update hashrate tracking
	currentHashrate := float64(stats.CurrentHashRate)
	if perf.AverageHashrate == 0 {
		perf.AverageHashrate = currentHashrate
	} else {
		// Exponential moving average
		alpha := 0.1
		perf.AverageHashrate = alpha*currentHashrate + (1-alpha)*perf.AverageHashrate
		
		// Update variance
		diff := currentHashrate - perf.AverageHashrate
		perf.HashVariance = alpha*diff*diff + (1-alpha)*perf.HashVariance
	}
}

// recordSwitch records a coin switch in history
func (ps *ProfitSwitcher) recordSwitch(symbol string) {
	ps.historyMu.Lock()
	defer ps.historyMu.Unlock()
	
	perf, exists := ps.history[symbol]
	if !exists {
		perf = &CoinPerformance{
			Symbol:    symbol,
			FirstSeen: time.Now(),
		}
		ps.history[symbol] = perf
	}
	
	perf.Switches++
}

// initializeCoinInfo initializes coin information
func (ps *ProfitSwitcher) initializeCoinInfo() {
	for _, config := range ps.config.Coins {
		coin := &CoinInfo{
			Config:      config,
			BlockReward: ps.getDefaultBlockReward(config.Symbol),
			BlockTime:   ps.getDefaultBlockTime(config.Symbol),
		}
		ps.supportedCoins[config.Symbol] = coin
	}
}

// getDefaultBlockReward returns default block reward for a coin
func (ps *ProfitSwitcher) getDefaultBlockReward(symbol string) float64 {
	switch symbol {
	case "BTC":
		return 6.25
	case "ETH":
		return 2.0
	case "LTC":
		return 12.5
	default:
		return 1.0
	}
}

// getDefaultBlockTime returns default block time for a coin
func (ps *ProfitSwitcher) getDefaultBlockTime(symbol string) float64 {
	switch symbol {
	case "BTC":
		return 600 // 10 minutes
	case "ETH":
		return 13 // 13 seconds
	case "LTC":
		return 150 // 2.5 minutes
	default:
		return 60 // 1 minute
	}
}

// getCoinSymbol safely gets coin symbol
func (ps *ProfitSwitcher) getCoinSymbol(coin *CoinInfo) string {
	if coin == nil {
		return "none"
	}
	return coin.Config.Symbol
}

// random returns a random float between 0 and 1
func (ps *ProfitSwitcher) random() float64 {
	return float64(time.Now().UnixNano()%1000) / 1000
}