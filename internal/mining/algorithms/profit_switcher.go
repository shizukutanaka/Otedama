package algorithms

import (
	"fmt"
	"math"
	"sort"
	"sync"
	"time"
)

// ProfitSwitcher manages algorithm switching based on profitability
type ProfitSwitcher struct {
	algorithms       map[string]*AlgorithmProfit
	currentAlgorithm string
	switchThreshold  float64 // Minimum profit increase to switch (%)
	switchCooldown   time.Duration
	lastSwitch       time.Time
	priceFeeds       map[string]*PriceFeed
	hashRates        map[string]float64
	powerConsumption map[string]float64
	electricityCost  float64 // USD per kWh
	mu               sync.RWMutex
}

// AlgorithmProfit represents algorithm profitability data
type AlgorithmProfit struct {
	Algorithm        *Algorithm
	CurrentPrice     float64    // USD per coin
	BlockReward      float64    // Coins per block
	BlockTime        float64    // Seconds per block
	NetworkHashRate  float64    // Network hash rate (H/s)
	Difficulty       float64    // Current difficulty
	EstimatedHashRate float64   // Our estimated hash rate (H/s)
	PowerUsage       float64    // Watts
	ProfitPerDay     float64    // USD per day
	ProfitPerMH      float64    // USD per MH/s per day
	LastUpdated      time.Time
}

// PriceFeed represents a price feed for a cryptocurrency
type PriceFeed struct {
	Symbol      string
	Price       float64
	Change24h   float64
	Volume24h   float64
	LastUpdated time.Time
	Source      string
}

// SwitchDecision represents a switching decision
type SwitchDecision struct {
	FromAlgorithm    string
	ToAlgorithm      string
	CurrentProfit    float64
	NewProfit        float64
	ProfitIncrease   float64
	Reason           string
	Timestamp        time.Time
	ShouldSwitch     bool
}

// NewProfitSwitcher creates a new profit switcher
func NewProfitSwitcher() *ProfitSwitcher {
	return &ProfitSwitcher{
		algorithms:       make(map[string]*AlgorithmProfit),
		switchThreshold:  10.0, // 10% minimum increase
		switchCooldown:   5 * time.Minute,
		priceFeeds:       make(map[string]*PriceFeed),
		hashRates:        make(map[string]float64),
		powerConsumption: make(map[string]float64),
		electricityCost:  0.10, // $0.10 per kWh default
	}
}

// AddAlgorithm adds an algorithm for profitability monitoring
func (ps *ProfitSwitcher) AddAlgorithm(name string, algorithm *Algorithm, config ProfitConfig) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	
	ps.algorithms[name] = &AlgorithmProfit{
		Algorithm:         algorithm,
		CurrentPrice:      config.Price,
		BlockReward:       config.BlockReward,
		BlockTime:         config.BlockTime,
		NetworkHashRate:   config.NetworkHashRate,
		Difficulty:        config.Difficulty,
		EstimatedHashRate: config.EstimatedHashRate,
		PowerUsage:        config.PowerUsage,
		LastUpdated:       time.Now(),
	}
	
	ps.hashRates[name] = config.EstimatedHashRate
	ps.powerConsumption[name] = config.PowerUsage
	
	// Calculate initial profitability
	ps.calculateProfitability(name)
}

// ProfitConfig represents profitability configuration
type ProfitConfig struct {
	Price             float64
	BlockReward       float64
	BlockTime         float64
	NetworkHashRate   float64
	Difficulty        float64
	EstimatedHashRate float64
	PowerUsage        float64
}

// UpdatePriceFeed updates price feed for an algorithm
func (ps *ProfitSwitcher) UpdatePriceFeed(algorithm string, feed *PriceFeed) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	
	ps.priceFeeds[algorithm] = feed
	
	// Update algorithm price
	if algoProfit, exists := ps.algorithms[algorithm]; exists {
		algoProfit.CurrentPrice = feed.Price
		algoProfit.LastUpdated = time.Now()
		ps.calculateProfitability(algorithm)
	}
}

// UpdateNetworkStats updates network statistics for an algorithm
func (ps *ProfitSwitcher) UpdateNetworkStats(algorithm string, hashRate, difficulty float64) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	
	if algoProfit, exists := ps.algorithms[algorithm]; exists {
		algoProfit.NetworkHashRate = hashRate
		algoProfit.Difficulty = difficulty
		algoProfit.LastUpdated = time.Now()
		ps.calculateProfitability(algorithm)
	}
}

// UpdateHashRate updates our hash rate for an algorithm
func (ps *ProfitSwitcher) UpdateHashRate(algorithm string, hashRate float64) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	
	ps.hashRates[algorithm] = hashRate
	
	if algoProfit, exists := ps.algorithms[algorithm]; exists {
		algoProfit.EstimatedHashRate = hashRate
		ps.calculateProfitability(algorithm)
	}
}

// SetElectricityCost sets electricity cost per kWh
func (ps *ProfitSwitcher) SetElectricityCost(costPerKWh float64) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	
	ps.electricityCost = costPerKWh
	
	// Recalculate all profitabilities
	for algorithm := range ps.algorithms {
		ps.calculateProfitability(algorithm)
	}
}

// calculateProfitability calculates profitability for an algorithm
func (ps *ProfitSwitcher) calculateProfitability(algorithm string) {
	algoProfit, exists := ps.algorithms[algorithm]
	if !exists {
		return
	}
	
	// Calculate blocks per day
	secondsPerDay := 86400.0
	blocksPerDay := secondsPerDay / algoProfit.BlockTime
	
	// Calculate our share of network hash rate
	networkShare := 0.0
	if algoProfit.NetworkHashRate > 0 {
		networkShare = algoProfit.EstimatedHashRate / algoProfit.NetworkHashRate
	}
	
	// Calculate coins earned per day
	coinsPerDay := blocksPerDay * algoProfit.BlockReward * networkShare
	
	// Calculate revenue per day
	revenuePerDay := coinsPerDay * algoProfit.CurrentPrice
	
	// Calculate power cost per day
	powerKW := algoProfit.PowerUsage / 1000.0
	powerCostPerDay := powerKW * 24 * ps.electricityCost
	
	// Calculate net profit per day
	algoProfit.ProfitPerDay = revenuePerDay - powerCostPerDay
	
	// Calculate profit per MH/s per day
	if algoProfit.EstimatedHashRate > 0 {
		hashRateMH := algoProfit.EstimatedHashRate / 1000000.0
		algoProfit.ProfitPerMH = algoProfit.ProfitPerDay / hashRateMH
	}
}

// GetMostProfitableAlgorithm returns the most profitable algorithm
func (ps *ProfitSwitcher) GetMostProfitableAlgorithm() string {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	
	maxProfit := -math.Inf(1)
	mostProfitable := ""
	
	for name, algoProfit := range ps.algorithms {
		if algoProfit.ProfitPerDay > maxProfit {
			maxProfit = algoProfit.ProfitPerDay
			mostProfitable = name
		}
	}
	
	return mostProfitable
}

// EvaluateSwitchDecision evaluates whether to switch algorithms
func (ps *ProfitSwitcher) EvaluateSwitchDecision() *SwitchDecision {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	
	// Check cooldown period
	if time.Since(ps.lastSwitch) < ps.switchCooldown {
		return &SwitchDecision{
			FromAlgorithm: ps.currentAlgorithm,
			ToAlgorithm:   ps.currentAlgorithm,
			Reason:        "Switch cooldown active",
			Timestamp:     time.Now(),
			ShouldSwitch:  false,
		}
	}
	
	currentProfit := 0.0
	if ps.currentAlgorithm != "" {
		if current, exists := ps.algorithms[ps.currentAlgorithm]; exists {
			currentProfit = current.ProfitPerDay
		}
	}
	
	// Find most profitable algorithm
	maxProfit := -math.Inf(1)
	bestAlgorithm := ""
	
	for name, algoProfit := range ps.algorithms {
		if algoProfit.ProfitPerDay > maxProfit {
			maxProfit = algoProfit.ProfitPerDay
			bestAlgorithm = name
		}
	}
	
	// Calculate profit increase percentage
	profitIncrease := 0.0
	if currentProfit > 0 {
		profitIncrease = ((maxProfit - currentProfit) / currentProfit) * 100
	} else if maxProfit > 0 {
		profitIncrease = 100.0 // Switching from no profit to profit
	}
	
	shouldSwitch := false
	reason := ""
	
	if ps.currentAlgorithm == "" {
		shouldSwitch = true
		reason = "Initial algorithm selection"
	} else if bestAlgorithm != ps.currentAlgorithm && profitIncrease >= ps.switchThreshold {
		shouldSwitch = true
		reason = fmt.Sprintf("Profit increase of %.2f%% exceeds threshold", profitIncrease)
	} else if bestAlgorithm != ps.currentAlgorithm {
		reason = fmt.Sprintf("Profit increase of %.2f%% below threshold of %.2f%%", profitIncrease, ps.switchThreshold)
	} else {
		reason = "Current algorithm is most profitable"
	}
	
	return &SwitchDecision{
		FromAlgorithm:  ps.currentAlgorithm,
		ToAlgorithm:    bestAlgorithm,
		CurrentProfit:  currentProfit,
		NewProfit:      maxProfit,
		ProfitIncrease: profitIncrease,
		Reason:         reason,
		Timestamp:      time.Now(),
		ShouldSwitch:   shouldSwitch,
	}
}

// ExecuteSwitch executes algorithm switch
func (ps *ProfitSwitcher) ExecuteSwitch(toAlgorithm string) error {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	
	if _, exists := ps.algorithms[toAlgorithm]; !exists {
		return fmt.Errorf("algorithm %s not found", toAlgorithm)
	}
	
	ps.currentAlgorithm = toAlgorithm
	ps.lastSwitch = time.Now()
	
	return nil
}

// GetProfitabilityReport returns detailed profitability report
func (ps *ProfitSwitcher) GetProfitabilityReport() *ProfitabilityReport {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	
	algorithms := make([]*AlgorithmProfitSummary, 0, len(ps.algorithms))
	
	for name, algoProfit := range ps.algorithms {
		summary := &AlgorithmProfitSummary{
			Name:              name,
			Algorithm:         algoProfit.Algorithm.DisplayName,
			ProfitPerDay:      algoProfit.ProfitPerDay,
			ProfitPerMH:       algoProfit.ProfitPerMH,
			CurrentPrice:      algoProfit.CurrentPrice,
			BlockReward:       algoProfit.BlockReward,
			NetworkHashRate:   algoProfit.NetworkHashRate,
			EstimatedHashRate: algoProfit.EstimatedHashRate,
			PowerUsage:        algoProfit.PowerUsage,
			IsCurrent:         name == ps.currentAlgorithm,
			LastUpdated:       algoProfit.LastUpdated,
		}
		algorithms = append(algorithms, summary)
	}
	
	// Sort by profitability
	sort.Slice(algorithms, func(i, j int) bool {
		return algorithms[i].ProfitPerDay > algorithms[j].ProfitPerDay
	})
	
	return &ProfitabilityReport{
		Algorithms:       algorithms,
		CurrentAlgorithm: ps.currentAlgorithm,
		ElectricityCost:  ps.electricityCost,
		SwitchThreshold:  ps.switchThreshold,
		LastSwitch:       ps.lastSwitch,
		Timestamp:        time.Now(),
	}
}

// ProfitabilityReport represents a profitability report
type ProfitabilityReport struct {
	Algorithms       []*AlgorithmProfitSummary
	CurrentAlgorithm string
	ElectricityCost  float64
	SwitchThreshold  float64
	LastSwitch       time.Time
	Timestamp        time.Time
}

// AlgorithmProfitSummary represents algorithm profit summary
type AlgorithmProfitSummary struct {
	Name              string
	Algorithm         string
	ProfitPerDay      float64
	ProfitPerMH       float64
	CurrentPrice      float64
	BlockReward       float64
	NetworkHashRate   float64
	EstimatedHashRate float64
	PowerUsage        float64
	IsCurrent         bool
	LastUpdated       time.Time
}

// AutoSwitcher automatically switches algorithms based on profitability
type AutoSwitcher struct {
	profitSwitcher *ProfitSwitcher
	enabled        bool
	interval       time.Duration
	stopChan       chan bool
	switchCallback func(string, string) error
	mu             sync.RWMutex
}

// NewAutoSwitcher creates a new auto switcher
func NewAutoSwitcher(profitSwitcher *ProfitSwitcher, switchCallback func(string, string) error) *AutoSwitcher {
	return &AutoSwitcher{
		profitSwitcher: profitSwitcher,
		enabled:        false,
		interval:       1 * time.Minute,
		stopChan:       make(chan bool),
		switchCallback: switchCallback,
	}
}

// Start starts automatic switching
func (as *AutoSwitcher) Start() {
	as.mu.Lock()
	defer as.mu.Unlock()
	
	if as.enabled {
		return
	}
	
	as.enabled = true
	go as.switchLoop()
}

// Stop stops automatic switching
func (as *AutoSwitcher) Stop() {
	as.mu.Lock()
	defer as.mu.Unlock()
	
	if !as.enabled {
		return
	}
	
	as.enabled = false
	close(as.stopChan)
	as.stopChan = make(chan bool)
}

// SetInterval sets switching evaluation interval
func (as *AutoSwitcher) SetInterval(interval time.Duration) {
	as.mu.Lock()
	defer as.mu.Unlock()
	
	as.interval = interval
}

// switchLoop runs the automatic switching loop
func (as *AutoSwitcher) switchLoop() {
	ticker := time.NewTicker(as.interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			as.evaluateAndSwitch()
		case <-as.stopChan:
			return
		}
	}
}

// evaluateAndSwitch evaluates and executes switch if needed
func (as *AutoSwitcher) evaluateAndSwitch() {
	decision := as.profitSwitcher.EvaluateSwitchDecision()
	
	if decision.ShouldSwitch && decision.ToAlgorithm != decision.FromAlgorithm {
		if as.switchCallback != nil {
			if err := as.switchCallback(decision.FromAlgorithm, decision.ToAlgorithm); err == nil {
				as.profitSwitcher.ExecuteSwitch(decision.ToAlgorithm)
			}
		} else {
			as.profitSwitcher.ExecuteSwitch(decision.ToAlgorithm)
		}
	}
}

// Market data simulation for testing

// SimulatedMarketData provides simulated market data for testing
type SimulatedMarketData struct {
	prices       map[string]float64
	baseNetHash  map[string]float64
	volatility   float64
	mu           sync.RWMutex
}

// NewSimulatedMarketData creates simulated market data
func NewSimulatedMarketData() *SimulatedMarketData {
	return &SimulatedMarketData{
		prices: map[string]float64{
			"bitcoin":  50000.0,
			"ethereum": 3000.0,
			"litecoin": 150.0,
			"monero":   200.0,
			"ravencoin": 0.05,
		},
		baseNetHash: map[string]float64{
			"bitcoin":   200000000000000000000.0, // 200 EH/s
			"ethereum":  300000000000000000.0,    // 300 TH/s
			"litecoin":  500000000000000.0,       // 500 GH/s
			"monero":    2000000000.0,            // 2 GH/s
			"ravencoin": 50000000000000.0,        // 50 TH/s
		},
		volatility: 0.1, // 10% volatility
	}
}

// UpdatePrices updates simulated prices with volatility
func (smd *SimulatedMarketData) UpdatePrices() {
	smd.mu.Lock()
	defer smd.mu.Unlock()
	
	for coin, price := range smd.prices {
		// Random price movement
		change := (math.Sin(float64(time.Now().Unix())/3600.0) + 
				  math.Cos(float64(time.Now().Unix())/1800.0)) * smd.volatility
		newPrice := price * (1.0 + change)
		if newPrice > 0 {
			smd.prices[coin] = newPrice
		}
	}
}

// GetPrice returns current price for a coin
func (smd *SimulatedMarketData) GetPrice(coin string) float64 {
	smd.mu.RLock()
	defer smd.mu.RUnlock()
	
	return smd.prices[coin]
}

// GetNetworkHashRate returns simulated network hash rate
func (smd *SimulatedMarketData) GetNetworkHashRate(coin string) float64 {
	smd.mu.RLock()
	defer smd.mu.RUnlock()
	
	baseHash := smd.baseNetHash[coin]
	// Add some variation
	variation := math.Sin(float64(time.Now().Unix())/7200.0) * 0.2
	return baseHash * (1.0 + variation)
}

// ProfitabilityAnalyzer analyzes long-term profitability trends
type ProfitabilityAnalyzer struct {
	historicalData map[string][]ProfitDataPoint
	mu             sync.RWMutex
}

// ProfitDataPoint represents a historical profit data point
type ProfitDataPoint struct {
	Timestamp      time.Time
	ProfitPerDay   float64
	ProfitPerMH    float64
	Price          float64
	NetworkHashRate float64
	Difficulty     float64
}

// NewProfitabilityAnalyzer creates a new profitability analyzer
func NewProfitabilityAnalyzer() *ProfitabilityAnalyzer {
	return &ProfitabilityAnalyzer{
		historicalData: make(map[string][]ProfitDataPoint),
	}
}

// RecordProfitData records profit data point
func (pa *ProfitabilityAnalyzer) RecordProfitData(algorithm string, data ProfitDataPoint) {
	pa.mu.Lock()
	defer pa.mu.Unlock()
	
	if _, exists := pa.historicalData[algorithm]; !exists {
		pa.historicalData[algorithm] = make([]ProfitDataPoint, 0)
	}
	
	pa.historicalData[algorithm] = append(pa.historicalData[algorithm], data)
	
	// Keep only last 7 days of data
	cutoff := time.Now().Add(-7 * 24 * time.Hour)
	filtered := make([]ProfitDataPoint, 0)
	for _, point := range pa.historicalData[algorithm] {
		if point.Timestamp.After(cutoff) {
			filtered = append(filtered, point)
		}
	}
	pa.historicalData[algorithm] = filtered
}

// GetProfitTrend calculates profit trend for an algorithm
func (pa *ProfitabilityAnalyzer) GetProfitTrend(algorithm string, duration time.Duration) float64 {
	pa.mu.RLock()
	defer pa.mu.RUnlock()
	
	data, exists := pa.historicalData[algorithm]
	if !exists || len(data) < 2 {
		return 0.0
	}
	
	cutoff := time.Now().Add(-duration)
	filteredData := make([]ProfitDataPoint, 0)
	for _, point := range data {
		if point.Timestamp.After(cutoff) {
			filteredData = append(filteredData, point)
		}
	}
	
	if len(filteredData) < 2 {
		return 0.0
	}
	
	// Calculate linear trend
	first := filteredData[0].ProfitPerDay
	last := filteredData[len(filteredData)-1].ProfitPerDay
	
	if first > 0 {
		return ((last - first) / first) * 100
	}
	
	return 0.0
}

// GetAverageProfitability calculates average profitability over duration
func (pa *ProfitabilityAnalyzer) GetAverageProfitability(algorithm string, duration time.Duration) float64 {
	pa.mu.RLock()
	defer pa.mu.RUnlock()
	
	data, exists := pa.historicalData[algorithm]
	if !exists || len(data) == 0 {
		return 0.0
	}
	
	cutoff := time.Now().Add(-duration)
	sum := 0.0
	count := 0
	
	for _, point := range data {
		if point.Timestamp.After(cutoff) {
			sum += point.ProfitPerDay
			count++
		}
	}
	
	if count > 0 {
		return sum / float64(count)
	}
	
	return 0.0
}

// Utility functions for profit switching

// CalculateSwitchingCost calculates cost of switching algorithms
func CalculateSwitchingCost(fromAlgo, toAlgo string, downtime time.Duration, currentHashRate float64) float64 {
	// Calculate lost revenue during switching
	// This is a simplified calculation
	downtimeHours := downtime.Hours()
	dailyRevenue := currentHashRate * 0.001 // Simplified calculation
	lostRevenue := dailyRevenue * (downtimeHours / 24.0)
	
	return lostRevenue
}

// OptimizeSwitchThreshold optimizes switching threshold based on historical data
func OptimizeSwitchThreshold(analyzer *ProfitabilityAnalyzer, algorithms []string) float64 {
	// Analyze volatility and switch frequency to optimize threshold
	// This is a simplified implementation
	
	totalVolatility := 0.0
	count := 0
	
	for _, algo := range algorithms {
		trend := analyzer.GetProfitTrend(algo, 24*time.Hour)
		volatility := math.Abs(trend)
		totalVolatility += volatility
		count++
	}
	
	if count > 0 {
		avgVolatility := totalVolatility / float64(count)
		// Set threshold to 2x average volatility to avoid frequent switching
		return math.Max(5.0, avgVolatility*2.0)
	}
	
	return 10.0 // Default threshold
}

// EstimateOptimalSwitchingInterval estimates optimal switching evaluation interval
func EstimateOptimalSwitchingInterval(marketVolatility float64) time.Duration {
	// Higher volatility = more frequent evaluation
	// Lower volatility = less frequent evaluation
	
	if marketVolatility > 0.3 { // High volatility
		return 1 * time.Minute
	} else if marketVolatility > 0.1 { // Medium volatility
		return 3 * time.Minute
	} else { // Low volatility
		return 10 * time.Minute
	}
}