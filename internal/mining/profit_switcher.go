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

// ProfitSwitcher automatically switches to the most profitable algorithm
type ProfitSwitcher struct {
	logger *zap.Logger
	config *ProfitConfig
	
	// Components
	engine       MiningEngine
	calculator   *ProfitCalculator
	priceTracker *PriceTracker
	
	// Current state
	currentAlgo  atomic.Value // string
	currentCoin  atomic.Value // string
	
	// Profitability data
	profitData   sync.Map // algorithm -> ProfitData
	
	// Statistics
	stats        *ProfitStats
	
	// Control
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
	running      atomic.Bool
}

// ProfitConfig contains profit switching configuration
type ProfitConfig struct {
	// Switching settings
	Enabled              bool
	CheckInterval        time.Duration
	MinimumDifference    float64 // Minimum % difference to switch
	SwitchDelay          time.Duration
	
	// Cost settings
	ElectricityCost      float64 // $ per kWh
	PoolFees             map[string]float64
	
	// Hardware settings
	PowerConsumption     float64 // Watts
	HashRates            map[string]float64 // Algorithm -> H/s
	
	// API settings
	PriceAPIs            []string
	ExchangeAPIs         []string
	DifficultyAPIs       []string
	
	// Coin settings
	EnabledCoins         []string
	PreferredExchange    string
}

// ProfitData contains profitability data for an algorithm
type ProfitData struct {
	Algorithm       string
	Coin            string
	Hashrate        float64
	Power           float64
	Revenue         float64
	ElectricityCost float64
	PoolFee         float64
	NetProfit       float64
	ProfitPerDay    float64
	ROI             float64
	UpdatedAt       time.Time
}

// ProfitCalculator calculates mining profitability
type ProfitCalculator struct {
	config       *ProfitConfig
	coinData     sync.Map
	exchangeRate atomic.Value // float64
	mu           sync.RWMutex
}

// CoinData contains coin-specific data
type CoinData struct {
	Name           string
	Symbol         string
	Algorithm      string
	Price          float64
	Difficulty     float64
	BlockReward    float64
	BlockTime      float64
	NetworkHashrate float64
	UpdatedAt      time.Time
}

// PriceTracker tracks cryptocurrency prices
type PriceTracker struct {
	prices      sync.Map
	lastUpdate  atomic.Value // time.Time
	updateMutex sync.Mutex
}

// ProfitStats tracks profit switching statistics
type ProfitStats struct {
	TotalSwitches       atomic.Uint64
	CurrentProfit       atomic.Value // float64
	BestDailyProfit     atomic.Value // float64
	AverageProfit       atomic.Value // float64
	TotalRevenue        atomic.Value // float64
	TotalElectricityCost atomic.Value // float64
	UptimeHours         atomic.Value // float64
	
	// Per-algorithm stats
	AlgorithmTime       sync.Map // algorithm -> duration
	AlgorithmRevenue    sync.Map // algorithm -> float64
	AlgorithmSwitches   sync.Map // algorithm -> uint64
}

// MiningEngine interface for the mining engine
type MiningEngine interface {
	SetAlgorithm(algorithm string) error
	GetHashrate() float64
	GetPowerUsage() float64
	IsRunning() bool
}

// AlgorithmInfo contains information about a mining algorithm

// SupportedAlgorithms lists all supported algorithms with their coins
var SupportedAlgorithms = []AlgorithmInfo{
	{Name: "sha256d", Coins: []string{"BTC", "BCH", "BSV"}, DefaultCoin: "BTC", Type: "ASIC"},
	{Name: "scrypt", Coins: []string{"LTC", "DOGE"}, DefaultCoin: "LTC", Type: "ASIC"},
	{Name: "ethash", Coins: []string{"ETC"}, DefaultCoin: "ETC", Type: "GPU"},
	{Name: "randomx", Coins: []string{"XMR"}, DefaultCoin: "XMR", Type: "CPU"},
	{Name: "cryptonight", Coins: []string{"BCN", "XMO"}, DefaultCoin: "BCN", Type: "GPU"},
	{Name: "x11", Coins: []string{"DASH"}, DefaultCoin: "DASH", Type: "ASIC"},
	{Name: "blake2b", Coins: []string{"NANO", "SC"}, DefaultCoin: "SC", Type: "GPU"},
}

// NewProfitSwitcher creates a new profit switcher
func NewProfitSwitcher(logger *zap.Logger, config *ProfitConfig, engine MiningEngine) *ProfitSwitcher {
	ctx, cancel := context.WithCancel(context.Background())
	
	ps := &ProfitSwitcher{
		logger:       logger,
		config:       config,
		engine:       engine,
		calculator:   NewProfitCalculator(config),
		priceTracker: NewPriceTracker(),
		stats:        NewProfitStats(),
		ctx:          ctx,
		cancel:       cancel,
	}
	
	// Set initial algorithm
	ps.currentAlgo.Store("sha256d")
	ps.currentCoin.Store("BTC")
	
	return ps
}

// Start starts the profit switcher
func (ps *ProfitSwitcher) Start() error {
	if !ps.running.CompareAndSwap(false, true) {
		return fmt.Errorf("profit switcher already running")
	}
	
	ps.logger.Info("Starting profit switcher",
		zap.Duration("check_interval", ps.config.CheckInterval),
		zap.Float64("min_difference", ps.config.MinimumDifference))
	
	// Initial price update
	ps.updatePrices()
	ps.updateDifficulties()
	
	// Start monitoring loops
	ps.wg.Add(1)
	go ps.profitCheckLoop()
	
	ps.wg.Add(1)
	go ps.priceUpdateLoop()
	
	ps.wg.Add(1)
	go ps.statsUpdateLoop()
	
	return nil
}

// Stop stops the profit switcher
func (ps *ProfitSwitcher) Stop() error {
	if !ps.running.CompareAndSwap(true, false) {
		return fmt.Errorf("profit switcher not running")
	}
	
	ps.logger.Info("Stopping profit switcher")
	
	ps.cancel()
	ps.wg.Wait()
	
	return nil
}

// GetCurrentAlgorithm returns the current mining algorithm
func (ps *ProfitSwitcher) GetCurrentAlgorithm() string {
	return ps.currentAlgo.Load().(string)
}

// GetCurrentCoin returns the current mining coin
func (ps *ProfitSwitcher) GetCurrentCoin() string {
	return ps.currentCoin.Load().(string)
}

// GetProfitability returns profitability data for all algorithms
func (ps *ProfitSwitcher) GetProfitability() []ProfitData {
	var profits []ProfitData
	
	ps.profitData.Range(func(key, value interface{}) bool {
		profits = append(profits, value.(ProfitData))
		return true
	})
	
	// Sort by profitability
	sort.Slice(profits, func(i, j int) bool {
		return profits[i].NetProfit > profits[j].NetProfit
	})
	
	return profits
}

// GetStatistics returns profit switching statistics
func (ps *ProfitSwitcher) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	stats["total_switches"] = ps.stats.TotalSwitches.Load()
	stats["current_profit"] = ps.stats.CurrentProfit.Load()
	stats["best_daily_profit"] = ps.stats.BestDailyProfit.Load()
	stats["average_profit"] = ps.stats.AverageProfit.Load()
	stats["total_revenue"] = ps.stats.TotalRevenue.Load()
	stats["total_electricity_cost"] = ps.stats.TotalElectricityCost.Load()
	stats["uptime_hours"] = ps.stats.UptimeHours.Load()
	
	// Per-algorithm stats
	algoStats := make(map[string]interface{})
	ps.stats.AlgorithmTime.Range(func(key, value interface{}) bool {
		algo := key.(string)
		algoStats[algo] = map[string]interface{}{
			"time":     value,
			"revenue":  ps.getAlgoRevenue(algo),
			"switches": ps.getAlgoSwitches(algo),
		}
		return true
	})
	stats["algorithms"] = algoStats
	
	return stats
}

// Private methods

func (ps *ProfitSwitcher) profitCheckLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(ps.config.CheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.checkProfitability()
		}
	}
}

func (ps *ProfitSwitcher) priceUpdateLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.updatePrices()
			ps.updateDifficulties()
		}
	}
}

func (ps *ProfitSwitcher) statsUpdateLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	startTime := time.Now()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			uptime := time.Since(startTime).Hours()
			ps.stats.UptimeHours.Store(uptime)
			ps.updateStats()
		}
	}
}

func (ps *ProfitSwitcher) checkProfitability() {
	ps.logger.Debug("Checking profitability")
	
	// Calculate profitability for each algorithm
	profits := ps.calculateAllProfits()
	
	// Find most profitable
	bestAlgo, bestProfit := ps.findBestAlgorithm(profits)
	
	// Update current profit
	currentAlgo := ps.currentAlgo.Load().(string)
	if currentProfit, exists := profits[currentAlgo]; exists {
		ps.stats.CurrentProfit.Store(currentProfit.NetProfit)
	}
	
	// Check if should switch
	if ps.shouldSwitch(bestAlgo, bestProfit) {
		ps.switchAlgorithm(bestAlgo, bestProfit)
	}
}

func (ps *ProfitSwitcher) calculateAllProfits() map[string]ProfitData {
	profits := make(map[string]ProfitData)
	
	for _, algoInfo := range SupportedAlgorithms {
		// Skip if no hashrate configured
		hashrate, exists := ps.config.HashRates[algoInfo.Name]
		if !exists || hashrate == 0 {
			continue
		}
		
		// Calculate for each coin
		for _, coin := range algoInfo.Coins {
			if !ps.isCoinEnabled(coin) {
				continue
			}
			
			profitData := ps.calculator.Calculate(algoInfo.Name, coin, hashrate)
			
			// Use best profit for this algorithm
			if existing, exists := profits[algoInfo.Name]; !exists || profitData.NetProfit > existing.NetProfit {
				profits[algoInfo.Name] = profitData
			}
		}
	}
	
	// Store profit data
	for algo, data := range profits {
		ps.profitData.Store(algo, data)
	}
	
	return profits
}

func (ps *ProfitSwitcher) findBestAlgorithm(profits map[string]ProfitData) (string, ProfitData) {
	var bestAlgo string
	var bestProfit ProfitData
	maxProfit := -math.MaxFloat64
	
	for algo, profit := range profits {
		if profit.NetProfit > maxProfit {
			maxProfit = profit.NetProfit
			bestAlgo = algo
			bestProfit = profit
		}
	}
	
	return bestAlgo, bestProfit
}

func (ps *ProfitSwitcher) shouldSwitch(newAlgo string, newProfit ProfitData) bool {
	currentAlgo := ps.currentAlgo.Load().(string)
	
	// Don't switch to same algorithm
	if currentAlgo == newAlgo {
		return false
	}
	
	// Get current profitability
	currentProfitData, exists := ps.profitData.Load(currentAlgo)
	if !exists {
		return true // Switch if no data for current
	}
	
	currentProfit := currentProfitData.(ProfitData).NetProfit
	
	// Calculate improvement percentage
	improvement := ((newProfit.NetProfit - currentProfit) / math.Abs(currentProfit)) * 100
	
	// Check if improvement is significant enough
	if improvement < ps.config.MinimumDifference {
		ps.logger.Debug("Profit improvement too small",
			zap.Float64("improvement", improvement),
			zap.Float64("minimum", ps.config.MinimumDifference))
		return false
	}
	
	ps.logger.Info("Significant profit improvement found",
		zap.String("from", currentAlgo),
		zap.String("to", newAlgo),
		zap.Float64("improvement", improvement))
	
	return true
}

func (ps *ProfitSwitcher) switchAlgorithm(algo string, profitData ProfitData) {
	ps.logger.Info("Switching algorithm",
		zap.String("from", ps.currentAlgo.Load().(string)),
		zap.String("to", algo),
		zap.String("coin", profitData.Coin),
		zap.Float64("expected_profit", profitData.ProfitPerDay))
	
	// Update statistics
	ps.stats.TotalSwitches.Add(1)
	ps.incrementAlgoSwitches(algo)
	
	// Delay before switching (to avoid rapid switching)
	time.Sleep(ps.config.SwitchDelay)
	
	// Switch mining engine
	if err := ps.engine.SetAlgorithm(algo); err != nil {
		ps.logger.Error("Failed to switch algorithm",
			zap.String("algorithm", algo),
			zap.Error(err))
		return
	}
	
	// Update current algorithm
	ps.currentAlgo.Store(algo)
	ps.currentCoin.Store(profitData.Coin)
	
	// Update best profit if applicable
	if profitData.ProfitPerDay > ps.stats.BestDailyProfit.Load().(float64) {
		ps.stats.BestDailyProfit.Store(profitData.ProfitPerDay)
	}
}

func (ps *ProfitSwitcher) updatePrices() {
	ps.logger.Debug("Updating prices")
	
	for _, api := range ps.config.PriceAPIs {
		prices, err := ps.fetchPrices(api)
		if err != nil {
			ps.logger.Warn("Failed to fetch prices",
				zap.String("api", api),
				zap.Error(err))
			continue
		}
		
		// Update price tracker
		for coin, price := range prices {
			ps.priceTracker.UpdatePrice(coin, price)
		}
		
		break // Use first successful API
	}
}

func (ps *ProfitSwitcher) updateDifficulties() {
	ps.logger.Debug("Updating difficulties")
	
	for _, api := range ps.config.DifficultyAPIs {
		difficulties, err := ps.fetchDifficulties(api)
		if err != nil {
			ps.logger.Warn("Failed to fetch difficulties",
				zap.String("api", api),
				zap.Error(err))
			continue
		}
		
		// Update calculator
		for coin, difficulty := range difficulties {
			ps.calculator.UpdateDifficulty(coin, difficulty)
		}
		
		break // Use first successful API
	}
}

func (ps *ProfitSwitcher) fetchPrices(apiURL string) (map[string]float64, error) {
	// Simplified price fetching
	resp, err := http.Get(apiURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	var prices map[string]float64
	if err := json.NewDecoder(resp.Body).Decode(&prices); err != nil {
		return nil, err
	}
	
	return prices, nil
}

func (ps *ProfitSwitcher) fetchDifficulties(apiURL string) (map[string]float64, error) {
	// Simplified difficulty fetching
	resp, err := http.Get(apiURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	
	var difficulties map[string]float64
	if err := json.NewDecoder(resp.Body).Decode(&difficulties); err != nil {
		return nil, err
	}
	
	return difficulties, nil
}

func (ps *ProfitSwitcher) updateStats() {
	// Calculate average profit
	totalProfit := 0.0
	count := 0
	
	ps.profitData.Range(func(key, value interface{}) bool {
		profitData := value.(ProfitData)
		totalProfit += profitData.NetProfit
		count++
		return true
	})
	
	if count > 0 {
		ps.stats.AverageProfit.Store(totalProfit / float64(count))
	}
	
	// Update revenue and costs
	if ps.engine.IsRunning() {
		hourlyRevenue := ps.stats.CurrentProfit.Load().(float64) / 24
		currentRevenue := ps.stats.TotalRevenue.Load().(float64)
		ps.stats.TotalRevenue.Store(currentRevenue + hourlyRevenue/60) // Per minute update
		
		hourlyCost := ps.config.PowerConsumption * ps.config.ElectricityCost / 1000
		currentCost := ps.stats.TotalElectricityCost.Load().(float64)
		ps.stats.TotalElectricityCost.Store(currentCost + hourlyCost/60)
	}
}

func (ps *ProfitSwitcher) isCoinEnabled(coin string) bool {
	for _, enabled := range ps.config.EnabledCoins {
		if enabled == coin {
			return true
		}
	}
	return false
}

func (ps *ProfitSwitcher) getAlgoRevenue(algo string) float64 {
	value, exists := ps.stats.AlgorithmRevenue.Load(algo)
	if !exists {
		return 0
	}
	return value.(float64)
}

func (ps *ProfitSwitcher) getAlgoSwitches(algo string) uint64 {
	value, exists := ps.stats.AlgorithmSwitches.Load(algo)
	if !exists {
		return 0
	}
	return value.(uint64)
}

func (ps *ProfitSwitcher) incrementAlgoSwitches(algo string) {
	value, _ := ps.stats.AlgorithmSwitches.LoadOrStore(algo, uint64(0))
	current := value.(uint64)
	ps.stats.AlgorithmSwitches.Store(algo, current+1)
}

// Factory functions

func NewProfitCalculator(config *ProfitConfig) *ProfitCalculator {
	pc := &ProfitCalculator{
		config: config,
	}
	pc.exchangeRate.Store(1.0)
	return pc
}

func (pc *ProfitCalculator) Calculate(algorithm, coin string, hashrate float64) ProfitData {
	// Get coin data
	value, exists := pc.coinData.Load(coin)
	if !exists {
		// Return zero profit if no data
		return ProfitData{
			Algorithm: algorithm,
			Coin:      coin,
			Hashrate:  hashrate,
			UpdatedAt: time.Now(),
		}
	}
	
	coinData := value.(CoinData)
	
	// Calculate revenue (simplified)
	// Revenue = (Hashrate / NetworkHashrate) * BlockReward * BlocksPerDay * Price
	blocksPerDay := 86400 / coinData.BlockTime
	dailyRevenue := (hashrate / coinData.NetworkHashrate) * coinData.BlockReward * blocksPerDay * coinData.Price
	
	// Calculate costs
	powerKWh := pc.config.PowerConsumption / 1000
	dailyElectricityCost := powerKWh * 24 * pc.config.ElectricityCost
	
	// Pool fee
	poolFee := dailyRevenue * pc.config.PoolFees[algorithm]
	
	// Net profit
	netProfit := dailyRevenue - dailyElectricityCost - poolFee
	
	// ROI (days to break even on hardware cost - simplified)
	roi := 0.0
	if netProfit > 0 {
		roi = 1000 / netProfit // Assuming $1000 hardware cost
	}
	
	return ProfitData{
		Algorithm:       algorithm,
		Coin:            coin,
		Hashrate:        hashrate,
		Power:           pc.config.PowerConsumption,
		Revenue:         dailyRevenue,
		ElectricityCost: dailyElectricityCost,
		PoolFee:         poolFee,
		NetProfit:       netProfit,
		ProfitPerDay:    netProfit,
		ROI:             roi,
		UpdatedAt:       time.Now(),
	}
}

func (pc *ProfitCalculator) UpdateDifficulty(coin string, difficulty float64) {
	value, exists := pc.coinData.Load(coin)
	if !exists {
		value = CoinData{Symbol: coin}
	}
	
	data := value.(CoinData)
	data.Difficulty = difficulty
	data.UpdatedAt = time.Now()
	
	pc.coinData.Store(coin, data)
}

func NewPriceTracker() *PriceTracker {
	pt := &PriceTracker{}
	pt.lastUpdate.Store(time.Now())
	return pt
}

func (pt *PriceTracker) UpdatePrice(coin string, price float64) {
	pt.prices.Store(coin, price)
	pt.lastUpdate.Store(time.Now())
}

func (pt *PriceTracker) GetPrice(coin string) (float64, bool) {
	value, exists := pt.prices.Load(coin)
	if !exists {
		return 0, false
	}
	return value.(float64), true
}

func NewProfitStats() *ProfitStats {
	ps := &ProfitStats{}
	ps.CurrentProfit.Store(0.0)
	ps.BestDailyProfit.Store(0.0)
	ps.AverageProfit.Store(0.0)
	ps.TotalRevenue.Store(0.0)
	ps.TotalElectricityCost.Store(0.0)
	ps.UptimeHours.Store(0.0)
	return ps
}
