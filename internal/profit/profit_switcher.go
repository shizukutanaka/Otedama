package profit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/currency"
	"github.com/shizukutanaka/Otedama/internal/mining"
	"go.uber.org/zap"
)

// ProfitSwitcher automatically switches between cryptocurrencies based on profitability
type ProfitSwitcher struct {
	logger *zap.Logger
	config ProfitSwitcherConfig
	
	// Dependencies
	currencyManager  *currency.CurrencyManager
	miningEngine     mining.Engine
	blockchainMgr    *currency.ClientManager
	
	// Profitability tracking
	profitMetrics    map[string]*ProfitMetric
	metricsMu        sync.RWMutex
	
	// Exchange rates
	exchangeRates    map[string]float64
	ratesMu          sync.RWMutex
	lastRateUpdate   time.Time
	
	// Mining costs
	powerCost        float64 // $/kWh
	totalHashPower   map[string]float64 // Algorithm -> Hashrate
	powerConsumption map[string]float64 // Algorithm -> Watts
	
	// Current mining state
	currentCurrency  atomic.Value // string
	switchHistory    []*SwitchEvent
	historyMu        sync.RWMutex
	
	// Statistics
	stats            *SwitcherStats
	
	// Channels
	metricsChan      chan *MiningMetrics
	switchChan       chan *SwitchDecision
	
	// Lifecycle
	ctx              context.Context
	cancel           context.CancelFunc
	wg               sync.WaitGroup
}

// ProfitSwitcherConfig contains profit switcher configuration
type ProfitSwitcherConfig struct {
	// Switching parameters
	MinProfitThreshold    float64       // Minimum profit increase to switch (%)
	MinSwitchInterval     time.Duration // Minimum time between switches
	MaxSwitchesPerDay     int           // Maximum switches per day
	
	// Calculation parameters
	CalculationInterval   time.Duration // How often to recalculate profitability
	ExchangeUpdateInterval time.Duration // How often to update exchange rates
	HistoryWindow         time.Duration // Window for historical analysis
	
	// Cost parameters
	PowerCostPerKWh       float64       // Electricity cost
	PoolFeePercent        float64       // Pool fee percentage
	
	// Exchange API
	ExchangeAPIEndpoint   string
	ExchangeAPIKey        string
	
	// Algorithm preferences
	PreferredAlgorithms   []string      // Preferred mining algorithms
	BlacklistedCurrencies []string      // Currencies to avoid
}

// ProfitMetric tracks profitability metrics for a currency
type ProfitMetric struct {
	Currency         string
	Algorithm        string
	CurrentDifficulty float64
	BlockReward      float64
	BlockTime        time.Duration
	ExchangeRate     float64 // to USD
	
	// Calculated metrics
	EstimatedRevenue float64 // $/day
	EstimatedCost    float64 // $/day
	NetProfit        float64 // $/day
	ProfitMargin     float64 // %
	ROI              float64 // Return on investment
	
	// Historical data
	Last24hAvgProfit float64
	Last7dAvgProfit  float64
	Volatility       float64
	
	LastUpdate       time.Time
}

// SwitchEvent records a currency switch event
type SwitchEvent struct {
	Timestamp        time.Time
	FromCurrency     string
	ToCurrency       string
	FromProfit       float64
	ToProfit         float64
	ProfitIncrease   float64
	Reason           string
}

// SwitchDecision represents a decision to switch currencies
type SwitchDecision struct {
	TargetCurrency   string
	CurrentProfit    float64
	TargetProfit     float64
	ProfitIncrease   float64
	Confidence       float64
	Reasons          []string
	Timestamp        time.Time
}

// MiningMetrics contains current mining metrics
type MiningMetrics struct {
	Currency         string
	Hashrate         float64
	SharesSubmitted  uint64
	BlocksFound      uint64
	Revenue          float64
	Timestamp        time.Time
}

// SwitcherStats tracks profit switcher statistics
type SwitcherStats struct {
	TotalSwitches       atomic.Uint64
	SuccessfulSwitches  atomic.Uint64
	FailedSwitches      atomic.Uint64
	TotalRevenue        atomic.Value // float64
	TotalCost           atomic.Value // float64
	AverageProfitMargin atomic.Value // float64
	BestCurrency        atomic.Value // string
	LastSwitch          atomic.Value // time.Time
}

// NewProfitSwitcher creates a new profit switcher
func NewProfitSwitcher(logger *zap.Logger, config ProfitSwitcherConfig, deps ProfitSwitcherDeps) *ProfitSwitcher {
	ctx, cancel := context.WithCancel(context.Background())
	
	ps := &ProfitSwitcher{
		logger:           logger,
		config:           config,
		currencyManager:  deps.CurrencyManager,
		miningEngine:     deps.MiningEngine,
		blockchainMgr:    deps.BlockchainManager,
		profitMetrics:    make(map[string]*ProfitMetric),
		exchangeRates:    make(map[string]float64),
		totalHashPower:   make(map[string]float64),
		powerConsumption: make(map[string]float64),
		switchHistory:    make([]*SwitchEvent, 0),
		stats:            &SwitcherStats{},
		metricsChan:      make(chan *MiningMetrics, 100),
		switchChan:       make(chan *SwitchDecision, 10),
		powerCost:        config.PowerCostPerKWh,
		ctx:              ctx,
		cancel:           cancel,
	}
	
	// Initialize hardware profiles
	ps.initializeHardwareProfiles()
	
	// Set initial currency
	ps.currentCurrency.Store("")
	
	return ps
}

// ProfitSwitcherDeps contains dependencies for the profit switcher
type ProfitSwitcherDeps struct {
	CurrencyManager   *currency.CurrencyManager
	MiningEngine      mining.Engine
	BlockchainManager *currency.ClientManager
}

// Start starts the profit switcher
func (ps *ProfitSwitcher) Start() error {
	ps.logger.Info("Starting profit switcher",
		zap.Float64("min_profit_threshold", ps.config.MinProfitThreshold),
		zap.Duration("min_switch_interval", ps.config.MinSwitchInterval),
	)
	
	// Start workers
	ps.wg.Add(1)
	go ps.profitCalculator()
	
	ps.wg.Add(1)
	go ps.exchangeRateUpdater()
	
	ps.wg.Add(1)
	go ps.metricsProcessor()
	
	ps.wg.Add(1)
	go ps.switchProcessor()
	
	ps.wg.Add(1)
	go ps.statsUpdater()
	
	// Perform initial calculation
	ps.calculateAllProfitability()
	
	// Select initial currency
	if err := ps.selectInitialCurrency(); err != nil {
		return fmt.Errorf("failed to select initial currency: %w", err)
	}
	
	return nil
}

// Stop stops the profit switcher
func (ps *ProfitSwitcher) Stop() error {
	ps.logger.Info("Stopping profit switcher")
	ps.cancel()
	ps.wg.Wait()
	return nil
}

// GetCurrentCurrency returns the currently mined currency
func (ps *ProfitSwitcher) GetCurrentCurrency() string {
	if curr := ps.currentCurrency.Load(); curr != nil {
		return curr.(string)
	}
	return ""
}

// GetProfitMetrics returns profit metrics for all currencies
func (ps *ProfitSwitcher) GetProfitMetrics() map[string]*ProfitMetric {
	ps.metricsMu.RLock()
	defer ps.metricsMu.RUnlock()
	
	metrics := make(map[string]*ProfitMetric)
	for k, v := range ps.profitMetrics {
		metrics[k] = v
	}
	
	return metrics
}

// UpdateMiningMetrics updates current mining metrics
func (ps *ProfitSwitcher) UpdateMiningMetrics(metrics *MiningMetrics) {
	select {
	case ps.metricsChan <- metrics:
	default:
		ps.logger.Warn("Metrics channel full, dropping metrics")
	}
}

// initializeHardwareProfiles sets up hardware consumption profiles
func (ps *ProfitSwitcher) initializeHardwareProfiles() {
	// Example hardware profiles (watts per TH/s or equivalent)
	ps.powerConsumption["sha256"] = 30.0    // ASIC efficiency
	ps.powerConsumption["scrypt"] = 800.0   // Scrypt ASIC
	ps.powerConsumption["ethash"] = 150.0   // GPU mining
	ps.powerConsumption["randomx"] = 200.0  // CPU mining
	ps.powerConsumption["kawpow"] = 180.0   // GPU mining
	ps.powerConsumption["autolykos2"] = 140.0 // GPU mining
}

// profitCalculator continuously calculates profitability
func (ps *ProfitSwitcher) profitCalculator() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(ps.config.CalculationInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
			
		case <-ticker.C:
			ps.calculateAllProfitability()
			ps.evaluateSwitching()
		}
	}
}

func (ps *ProfitSwitcher) calculateAllProfitability() {
	currencies := ps.currencyManager.ListCurrencies()
	
	ps.metricsMu.Lock()
	defer ps.metricsMu.Unlock()
	
	for _, curr := range currencies {
		// Skip blacklisted currencies
		if ps.isCurrencyBlacklisted(curr.Symbol) {
			continue
		}
		
		metric := ps.calculateProfitability(curr)
		ps.profitMetrics[curr.Symbol] = metric
	}
	
	ps.logger.Debug("Profitability calculated",
		zap.Int("currencies", len(ps.profitMetrics)),
	)
}

func (ps *ProfitSwitcher) calculateProfitability(curr *currency.Currency) *ProfitMetric {
	metric := &ProfitMetric{
		Currency:    curr.Symbol,
		Algorithm:   curr.Algorithm,
		LastUpdate:  time.Now(),
	}
	
	// Get current network difficulty
	client, err := ps.blockchainMgr.GetClient(context.Background(), curr.Symbol)
	if err == nil && client != nil {
		difficulty, err := client.GetDifficulty(context.Background())
		if err == nil {
			metric.CurrentDifficulty = difficulty
		}
		
		// Get block reward from block template
		template, err := client.GetBlockTemplate(context.Background())
		if err == nil && template.CoinbaseValue != nil {
			// Convert from smallest unit to currency unit
			reward := new(big.Float).SetInt(template.CoinbaseValue)
			unitsPerCoin := new(big.Float).SetInt(curr.UnitsPerCoin)
			reward.Quo(reward, unitsPerCoin)
			rewardFloat, _ := reward.Float64()
			metric.BlockReward = rewardFloat
		}
		
		// Use currency config for block time
		metric.BlockTime = curr.BlockTime
	}
	
	// Get exchange rate
	ps.ratesMu.RLock()
	metric.ExchangeRate = ps.exchangeRates[curr.Symbol]
	ps.ratesMu.RUnlock()
	
	// Get hashrate for this algorithm
	hashrate := ps.totalHashPower[curr.Algorithm]
	if hashrate == 0 {
		return metric
	}
	
	// Calculate daily revenue
	if metric.BlockTime > 0 && metric.CurrentDifficulty > 0 {
		blocksPerDay := (24 * time.Hour) / metric.BlockTime
		networkHashrate := metric.CurrentDifficulty * math.Pow(2, 32) / metric.BlockTime.Seconds()
		poolShare := hashrate / networkHashrate
		
		dailyBlocks := float64(blocksPerDay) * poolShare
		dailyRevenue := dailyBlocks * metric.BlockReward * metric.ExchangeRate
		
		// Subtract pool fee
		metric.EstimatedRevenue = dailyRevenue * (1 - ps.config.PoolFeePercent/100)
	}
	
	// Calculate daily cost
	powerConsumption := ps.powerConsumption[curr.Algorithm] * (hashrate / 1e12) // TH/s
	dailyPowerKWh := powerConsumption * 24 / 1000 // Convert W to kWh
	metric.EstimatedCost = dailyPowerKWh * ps.powerCost
	
	// Calculate profit metrics
	metric.NetProfit = metric.EstimatedRevenue - metric.EstimatedCost
	
	if metric.EstimatedRevenue > 0 {
		metric.ProfitMargin = (metric.NetProfit / metric.EstimatedRevenue) * 100
		metric.ROI = (metric.NetProfit / metric.EstimatedCost) * 100
	}
	
	// Calculate historical averages
	ps.calculateHistoricalMetrics(metric)
	
	return metric
}

func (ps *ProfitSwitcher) calculateHistoricalMetrics(metric *ProfitMetric) {
	// In production, fetch from database
	// For now, use current values with some variance
	metric.Last24hAvgProfit = metric.NetProfit * 0.95
	metric.Last7dAvgProfit = metric.NetProfit * 0.90
	metric.Volatility = 0.15 // 15% volatility
}

// exchangeRateUpdater updates exchange rates
func (ps *ProfitSwitcher) exchangeRateUpdater() {
	defer ps.wg.Done()
	
	// Initial update
	ps.updateExchangeRates()
	
	ticker := time.NewTicker(ps.config.ExchangeUpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
			
		case <-ticker.C:
			ps.updateExchangeRates()
		}
	}
}

func (ps *ProfitSwitcher) updateExchangeRates() {
	// Example API call - replace with actual exchange API
	url := fmt.Sprintf("%s/v1/ticker/24hr", ps.config.ExchangeAPIEndpoint)
	
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		ps.logger.Error("Failed to create exchange rate request", zap.Error(err))
		return
	}
	
	if ps.config.ExchangeAPIKey != "" {
		req.Header.Set("X-API-Key", ps.config.ExchangeAPIKey)
	}
	
	resp, err := client.Do(req)
	if err != nil {
		ps.logger.Error("Failed to fetch exchange rates", zap.Error(err))
		return
	}
	defer resp.Body.Close()
	
	var rates []ExchangeRate
	if err := json.NewDecoder(resp.Body).Decode(&rates); err != nil {
		ps.logger.Error("Failed to decode exchange rates", zap.Error(err))
		return
	}
	
	ps.ratesMu.Lock()
	for _, rate := range rates {
		if rate.Symbol != "" && rate.Price > 0 {
			ps.exchangeRates[rate.Symbol] = rate.Price
		}
	}
	ps.lastRateUpdate = time.Now()
	ps.ratesMu.Unlock()
	
	ps.logger.Info("Exchange rates updated",
		zap.Int("currencies", len(rates)),
	)
}

// ExchangeRate represents exchange rate data
type ExchangeRate struct {
	Symbol string  `json:"symbol"`
	Price  float64 `json:"price"`
	Volume float64 `json:"volume"`
}

// evaluateSwitching evaluates whether to switch currencies
func (ps *ProfitSwitcher) evaluateSwitching() {
	currentCurrency := ps.GetCurrentCurrency()
	if currentCurrency == "" {
		return
	}
	
	ps.metricsMu.RLock()
	currentMetric := ps.profitMetrics[currentCurrency]
	ps.metricsMu.RUnlock()
	
	if currentMetric == nil {
		return
	}
	
	// Check if we can switch (rate limiting)
	if !ps.canSwitch() {
		return
	}
	
	// Find best alternative
	bestAlternative := ps.findBestAlternative(currentMetric)
	if bestAlternative == nil {
		return
	}
	
	// Calculate profit increase
	profitIncrease := ((bestAlternative.NetProfit - currentMetric.NetProfit) / currentMetric.NetProfit) * 100
	
	// Check if profit increase meets threshold
	if profitIncrease < ps.config.MinProfitThreshold {
		return
	}
	
	// Create switch decision
	decision := &SwitchDecision{
		TargetCurrency: bestAlternative.Currency,
		CurrentProfit:  currentMetric.NetProfit,
		TargetProfit:   bestAlternative.NetProfit,
		ProfitIncrease: profitIncrease,
		Confidence:     ps.calculateConfidence(bestAlternative),
		Reasons:        ps.generateSwitchReasons(currentMetric, bestAlternative),
		Timestamp:      time.Now(),
	}
	
	// Submit decision
	select {
	case ps.switchChan <- decision:
	default:
		ps.logger.Warn("Switch channel full, dropping decision")
	}
}

func (ps *ProfitSwitcher) canSwitch() bool {
	// Check last switch time
	if lastSwitch := ps.stats.LastSwitch.Load(); lastSwitch != nil {
		if time.Since(lastSwitch.(time.Time)) < ps.config.MinSwitchInterval {
			return false
		}
	}
	
	// Check daily switch limit
	ps.historyMu.RLock()
	defer ps.historyMu.RUnlock()
	
	switchesToday := 0
	cutoff := time.Now().Add(-24 * time.Hour)
	
	for _, event := range ps.switchHistory {
		if event.Timestamp.After(cutoff) {
			switchesToday++
		}
	}
	
	return switchesToday < ps.config.MaxSwitchesPerDay
}

func (ps *ProfitSwitcher) findBestAlternative(current *ProfitMetric) *ProfitMetric {
	ps.metricsMu.RLock()
	defer ps.metricsMu.RUnlock()
	
	var best *ProfitMetric
	maxProfit := current.NetProfit
	
	for _, metric := range ps.profitMetrics {
		if metric.Currency == current.Currency {
			continue
		}
		
		// Check algorithm preference
		if !ps.isAlgorithmPreferred(metric.Algorithm) {
			continue
		}
		
		// Consider volatility-adjusted profit
		adjustedProfit := metric.NetProfit * (1 - metric.Volatility)
		
		if adjustedProfit > maxProfit {
			maxProfit = adjustedProfit
			best = metric
		}
	}
	
	return best
}

func (ps *ProfitSwitcher) calculateConfidence(metric *ProfitMetric) float64 {
	confidence := 1.0
	
	// Reduce confidence based on volatility
	confidence *= (1 - metric.Volatility)
	
	// Reduce confidence if exchange rate is stale
	ps.ratesMu.RLock()
	rateAge := time.Since(ps.lastRateUpdate)
	ps.ratesMu.RUnlock()
	
	if rateAge > time.Hour {
		confidence *= 0.8
	}
	
	// Reduce confidence if metrics are old
	if time.Since(metric.LastUpdate) > 30*time.Minute {
		confidence *= 0.9
	}
	
	return confidence
}

func (ps *ProfitSwitcher) generateSwitchReasons(current, target *ProfitMetric) []string {
	reasons := []string{}
	
	profitIncrease := ((target.NetProfit - current.NetProfit) / current.NetProfit) * 100
	reasons = append(reasons, fmt.Sprintf("%.1f%% profit increase", profitIncrease))
	
	if target.ProfitMargin > current.ProfitMargin {
		reasons = append(reasons, fmt.Sprintf("Better profit margin: %.1f%% vs %.1f%%", 
			target.ProfitMargin, current.ProfitMargin))
	}
	
	if target.Volatility < current.Volatility {
		reasons = append(reasons, "Lower volatility")
	}
	
	if target.ROI > current.ROI {
		reasons = append(reasons, fmt.Sprintf("Higher ROI: %.1f%% vs %.1f%%",
			target.ROI, current.ROI))
	}
	
	return reasons
}

// switchProcessor processes switch decisions
func (ps *ProfitSwitcher) switchProcessor() {
	defer ps.wg.Done()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
			
		case decision := <-ps.switchChan:
			ps.processSwitch(decision)
		}
	}
}

func (ps *ProfitSwitcher) processSwitch(decision *SwitchDecision) {
	currentCurrency := ps.GetCurrentCurrency()
	
	ps.logger.Info("Processing currency switch",
		zap.String("from", currentCurrency),
		zap.String("to", decision.TargetCurrency),
		zap.Float64("profit_increase", decision.ProfitIncrease),
		zap.Float64("confidence", decision.Confidence),
		zap.Strings("reasons", decision.Reasons),
	)
	
	// Execute switch
	if err := ps.executeCurrencySwitch(decision.TargetCurrency); err != nil {
		ps.logger.Error("Failed to switch currency",
			zap.String("target", decision.TargetCurrency),
			zap.Error(err),
		)
		ps.stats.FailedSwitches.Add(1)
		return
	}
	
	// Record switch event
	event := &SwitchEvent{
		Timestamp:      decision.Timestamp,
		FromCurrency:   currentCurrency,
		ToCurrency:     decision.TargetCurrency,
		FromProfit:     decision.CurrentProfit,
		ToProfit:       decision.TargetProfit,
		ProfitIncrease: decision.ProfitIncrease,
		Reason:         fmt.Sprintf("Automatic switch: %v", decision.Reasons),
	}
	
	ps.historyMu.Lock()
	ps.switchHistory = append(ps.switchHistory, event)
	if len(ps.switchHistory) > 1000 {
		ps.switchHistory = ps.switchHistory[500:]
	}
	ps.historyMu.Unlock()
	
	// Update statistics
	ps.stats.TotalSwitches.Add(1)
	ps.stats.SuccessfulSwitches.Add(1)
}

func (ps *ProfitSwitcher) executeCurrencySwitch(targetCurrency string) error {
	// Stop current mining
	if err := (*ps.miningEngine).Stop(); err != nil {
		return fmt.Errorf("failed to stop mining: %w", err)
	}
	
	// Update mining configuration
	currency, err := ps.currencyManager.GetCurrency(targetCurrency)
	if err != nil {
		return fmt.Errorf("target currency not found: %w", err)
	}
	
	// Reconfigure mining engine
	if err := (*ps.miningEngine).SetActiveCurrency(targetCurrency); err != nil {
		return fmt.Errorf("failed to set active currency: %w", err)
	}
	
	// Start mining with new currency
	if err := (*ps.miningEngine).Start(); err != nil {
		return fmt.Errorf("failed to start mining: %w", err)
	}
	
	// Update current currency
	ps.currentCurrency.Store(targetCurrency)
	
	ps.logger.Info("Successfully switched currency",
		zap.String("currency", targetCurrency),
		zap.String("algorithm", currency.Algorithm),
	)
	
	return nil
}

// metricsProcessor processes mining metrics
func (ps *ProfitSwitcher) metricsProcessor() {
	defer ps.wg.Done()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
			
		case metrics := <-ps.metricsChan:
			ps.processMetrics(metrics)
		}
	}
}

func (ps *ProfitSwitcher) processMetrics(metrics *MiningMetrics) {
	// Update revenue tracking
	if totalRevenue := ps.stats.TotalRevenue.Load(); totalRevenue != nil {
		newTotal := totalRevenue.(float64) + metrics.Revenue
		ps.stats.TotalRevenue.Store(newTotal)
	} else {
		ps.stats.TotalRevenue.Store(metrics.Revenue)
	}
	
	// Update cost tracking
	ps.metricsMu.RLock()
	currentMetric := ps.profitMetrics[metrics.Currency]
	ps.metricsMu.RUnlock()
	
	if currentMetric != nil {
		dailyCost := currentMetric.EstimatedCost
		hourlyCost := dailyCost / 24
		minuteCost := hourlyCost / 60
		
		if totalCost := ps.stats.TotalCost.Load(); totalCost != nil {
			newTotal := totalCost.(float64) + minuteCost
			ps.stats.TotalCost.Store(newTotal)
		} else {
			ps.stats.TotalCost.Store(minuteCost)
		}
	}
}

// statsUpdater updates statistics
func (ps *ProfitSwitcher) statsUpdater() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
			
		case <-ticker.C:
			ps.updateStats()
		}
	}
}

func (ps *ProfitSwitcher) updateStats() {
	// Calculate average profit margin
	ps.metricsMu.RLock()
	totalMargin := 0.0
	count := 0
	
	for _, metric := range ps.profitMetrics {
		if metric.ProfitMargin > 0 {
			totalMargin += metric.ProfitMargin
			count++
		}
	}
	ps.metricsMu.RUnlock()
	
	if count > 0 {
		avgMargin := totalMargin / float64(count)
		ps.stats.AverageProfitMargin.Store(avgMargin)
	}
}

// Helper methods

func (ps *ProfitSwitcher) selectInitialCurrency() error {
	ps.metricsMu.RLock()
	defer ps.metricsMu.RUnlock()
	
	if len(ps.profitMetrics) == 0 {
		return errors.New("no profit metrics available")
	}
	
	// Sort by profitability
	currencies := make([]*ProfitMetric, 0, len(ps.profitMetrics))
	for _, metric := range ps.profitMetrics {
		currencies = append(currencies, metric)
	}
	
	sort.Slice(currencies, func(i, j int) bool {
		return currencies[i].NetProfit > currencies[j].NetProfit
	})
	
	// Select most profitable
	selected := currencies[0]
	
	return ps.executeCurrencySwitch(selected.Currency)
}

func (ps *ProfitSwitcher) isCurrencyBlacklisted(currency string) bool {
	for _, blacklisted := range ps.config.BlacklistedCurrencies {
		if blacklisted == currency {
			return true
		}
	}
	return false
}

func (ps *ProfitSwitcher) isAlgorithmPreferred(algorithm string) bool {
	if len(ps.config.PreferredAlgorithms) == 0 {
		return true
	}
	
	for _, preferred := range ps.config.PreferredAlgorithms {
		if preferred == algorithm {
			return true
		}
	}
	
	return false
}

// GetStats returns profit switcher statistics
func (ps *ProfitSwitcher) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_switches":      ps.stats.TotalSwitches.Load(),
		"successful_switches": ps.stats.SuccessfulSwitches.Load(),
		"failed_switches":     ps.stats.FailedSwitches.Load(),
		"current_currency":    ps.GetCurrentCurrency(),
	}
	
	if totalRevenue := ps.stats.TotalRevenue.Load(); totalRevenue != nil {
		stats["total_revenue"] = totalRevenue.(float64)
	}
	
	if totalCost := ps.stats.TotalCost.Load(); totalCost != nil {
		stats["total_cost"] = totalCost.(float64)
	}
	
	if avgMargin := ps.stats.AverageProfitMargin.Load(); avgMargin != nil {
		stats["average_profit_margin"] = avgMargin.(float64)
	}
	
	if bestCurrency := ps.stats.BestCurrency.Load(); bestCurrency != nil {
		stats["best_currency"] = bestCurrency.(string)
	}
	
	if lastSwitch := ps.stats.LastSwitch.Load(); lastSwitch != nil {
		stats["last_switch"] = lastSwitch.(time.Time)
	}
	
	// Add recent switch history
	ps.historyMu.RLock()
	recentSwitches := make([]*SwitchEvent, 0)
	cutoff := time.Now().Add(-24 * time.Hour)
	for _, event := range ps.switchHistory {
		if event.Timestamp.After(cutoff) {
			recentSwitches = append(recentSwitches, event)
		}
	}
	ps.historyMu.RUnlock()
	
	stats["recent_switches"] = recentSwitches
	
	return stats
}

// ManualSwitch manually switches to a specific currency
func (ps *ProfitSwitcher) ManualSwitch(currency string, reason string) error {
	// Validate currency
	ps.metricsMu.RLock()
	metric, exists := ps.profitMetrics[currency]
	ps.metricsMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("currency %s not supported", currency)
	}
	
	currentCurrency := ps.GetCurrentCurrency()
	
	// Execute switch
	if err := ps.executeCurrencySwitch(currency); err != nil {
		return err
	}
	
	// Record manual switch
	event := &SwitchEvent{
		Timestamp:    time.Now(),
		FromCurrency: currentCurrency,
		ToCurrency:   currency,
		FromProfit:   0,
		ToProfit:     metric.NetProfit,
		Reason:       fmt.Sprintf("Manual switch: %s", reason),
	}
	
	ps.historyMu.Lock()
	ps.switchHistory = append(ps.switchHistory, event)
	ps.historyMu.Unlock()
	
	ps.stats.TotalSwitches.Add(1)
	ps.stats.SuccessfulSwitches.Add(1)
	ps.stats.LastSwitch.Store(time.Now())
	
	return nil
}

// SetHashPower sets the available hash power for an algorithm
func (ps *ProfitSwitcher) SetHashPower(algorithm string, hashrate float64) {
	ps.totalHashPower[algorithm] = hashrate
	
	// Recalculate profitability for affected currencies
	ps.calculateAllProfitability()
}

// SetPowerCost updates the electricity cost
func (ps *ProfitSwitcher) SetPowerCost(costPerKWh float64) {
	ps.powerCost = costPerKWh
	
	// Recalculate all profitability with new cost
	ps.calculateAllProfitability()
}