package optimization

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

type ProfitSwitcher struct {
	logger              *zap.Logger
	mu                  sync.RWMutex
	ctx                 context.Context
	cancel              context.CancelFunc
	
	// Configuration
	config              *ProfitSwitcherConfig
	
	// Market data
	marketData          map[string]*MarketData
	exchangeRates       map[string]float64
	
	// Profitability tracking
	profitCalculator    *ProfitCalculator
	algorithmHistory    map[string]*AlgorithmProfitHistory
	
	// Switching logic
	switchingRules      []*SwitchingRule
	switchingHistory    []*SwitchEvent
	
	// Performance tracking
	metrics             *ProfitSwitcherMetrics
	
	// External data sources
	dataProviders       map[string]DataProvider
	
	// Decision engine
	decisionEngine      *ProfitDecisionEngine
}

type ProfitSwitcherConfig struct {
	UpdateInterval        time.Duration `json:"update_interval"`
	MinSwitchInterval     time.Duration `json:"min_switch_interval"`
	ProfitThreshold       float64       `json:"profit_threshold"`
	SwitchingCostPercent  float64       `json:"switching_cost_percent"`
	StabilityWindow       time.Duration `json:"stability_window"`
	MaxSwitchesPerHour    int           `json:"max_switches_per_hour"`
	EnablePredictive      bool          `json:"enable_predictive"`
	RiskTolerance         float64       `json:"risk_tolerance"`
	MinimumProfit         float64       `json:"minimum_profit"`
}

type MarketData struct {
	Algorithm           string      `json:"algorithm"`
	Cryptocurrency      string      `json:"cryptocurrency"`
	NetworkHashrate     float64     `json:"network_hashrate"`
	Difficulty          float64     `json:"difficulty"`
	BlockReward         float64     `json:"block_reward"`
	BlockTime           float64     `json:"block_time"`
	ExchangeRate        float64     `json:"exchange_rate"`
	Volume24h           float64     `json:"volume_24h"`
	PriceVolatility     float64     `json:"price_volatility"`
	FeeRate             float64     `json:"fee_rate"`
	LastUpdated         time.Time   `json:"last_updated"`
	Source              string      `json:"source"`
}

type AlgorithmProfitHistory struct {
	Algorithm           string                    `json:"algorithm"`
	ProfitHistory       []ProfitDataPoint         `json:"profit_history"`
	AverageProfit       float64                   `json:"average_profit"`
	ProfitTrend         float64                   `json:"profit_trend"`
	Volatility          float64                   `json:"volatility"`
	LastUpdate          time.Time                 `json:"last_update"`
	PredictedProfit     map[time.Duration]float64 `json:"predicted_profit"`
}

type ProfitDataPoint struct {
	Timestamp           time.Time `json:"timestamp"`
	EstimatedProfit     float64   `json:"estimated_profit"`
	ActualProfit        float64   `json:"actual_profit"`
	Hashrate            float64   `json:"hashrate"`
	PowerCost           float64   `json:"power_cost"`
	PoolFees            float64   `json:"pool_fees"`
	SwitchingCost       float64   `json:"switching_cost"`
	NetProfit           float64   `json:"net_profit"`
}

type SwitchingRule struct {
	Name                string              `json:"name"`
	Description         string              `json:"description"`
	Priority            int                 `json:"priority"`
	Conditions          []ProfitCondition   `json:"conditions"`
	MinProfitImprovement float64            `json:"min_profit_improvement"`
	CooldownPeriod      time.Duration       `json:"cooldown_period"`
	DeviceTypes         []string            `json:"device_types"`
	Enabled             bool                `json:"enabled"`
}

type ProfitCondition struct {
	Parameter           string              `json:"parameter"`
	Operator            string              `json:"operator"`
	Value               float64             `json:"value"`
	TimeWindow          time.Duration       `json:"time_window"`
}

type SwitchEvent struct {
	DeviceID            string              `json:"device_id"`
	Timestamp           time.Time           `json:"timestamp"`
	FromAlgorithm       string              `json:"from_algorithm"`
	ToAlgorithm         string              `json:"to_algorithm"`
	ExpectedImprovement float64             `json:"expected_improvement"`
	ActualImprovement   float64             `json:"actual_improvement"`
	SwitchingCost       float64             `json:"switching_cost"`
	Rule                string              `json:"rule"`
	Success             bool                `json:"success"`
	Reason              string              `json:"reason"`
}

type ProfitCalculator struct {
	logger              *zap.Logger
	electricityCost     float64
	poolFeePercent      float64
	hardwareDepreciation float64
}

type ProfitSwitcherMetrics struct {
	mu                      sync.RWMutex
	TotalSwitches           uint64            `json:"total_switches"`
	SuccessfulSwitches      uint64            `json:"successful_switches"`
	TotalProfitGain         float64           `json:"total_profit_gain"`
	AverageProfitGain       float64           `json:"average_profit_gain"`
	BestSwitch              *SwitchEvent      `json:"best_switch"`
	SwitchesByAlgorithm     map[string]uint64 `json:"switches_by_algorithm"`
	ProfitAccuracy          float64           `json:"profit_accuracy"`
	LastUpdate              time.Time         `json:"last_update"`
}

type DataProvider interface {
	GetMarketData(algorithm string) (*MarketData, error)
	GetExchangeRate(cryptocurrency string) (float64, error)
	IsHealthy() bool
}

type ProfitDecisionEngine struct {
	logger              *zap.Logger
	weightsModel        map[string]float64
	riskModel           *RiskModel
	predictionHorizon   time.Duration
}

type RiskModel struct {
	VolatilityWeight    float64   `json:"volatility_weight"`
	TrendWeight         float64   `json:"trend_weight"`
	LiquidityWeight     float64   `json:"liquidity_weight"`
	RiskFreeRate        float64   `json:"risk_free_rate"`
}

func NewProfitSwitcher(logger *zap.Logger, config *ProfitSwitcherConfig) *ProfitSwitcher {
	ctx, cancel := context.WithCancel(context.Background())
	
	if config == nil {
		config = &ProfitSwitcherConfig{
			UpdateInterval:       60 * time.Second,
			MinSwitchInterval:    5 * time.Minute,
			ProfitThreshold:      5.0, // 5% minimum improvement
			SwitchingCostPercent: 1.0, // 1% switching cost
			StabilityWindow:      30 * time.Minute,
			MaxSwitchesPerHour:   4,
			EnablePredictive:     true,
			RiskTolerance:        0.3,
			MinimumProfit:        0.01, // $0.01 minimum daily profit
		}
	}
	
	ps := &ProfitSwitcher{
		logger:            logger,
		ctx:               ctx,
		cancel:            cancel,
		config:            config,
		marketData:        make(map[string]*MarketData),
		exchangeRates:     make(map[string]float64),
		algorithmHistory:  make(map[string]*AlgorithmProfitHistory),
		switchingHistory:  make([]*SwitchEvent, 0),
		dataProviders:     make(map[string]DataProvider),
		metrics:           &ProfitSwitcherMetrics{
			SwitchesByAlgorithm: make(map[string]uint64),
		},
	}
	
	// Initialize components
	ps.profitCalculator = NewProfitCalculator(logger, 0.12, 1.0, 0.1) // 12¢/kWh, 1% pool fee, 10% depreciation
	ps.decisionEngine = NewProfitDecisionEngine(logger)
	
	// Initialize switching rules
	ps.initializeSwitchingRules()
	
	return ps
}

func NewProfitCalculator(logger *zap.Logger, electricityCost, poolFeePercent, hardwareDepreciation float64) *ProfitCalculator {
	return &ProfitCalculator{
		logger:               logger,
		electricityCost:      electricityCost,
		poolFeePercent:       poolFeePercent,
		hardwareDepreciation: hardwareDepreciation,
	}
}

func NewProfitDecisionEngine(logger *zap.Logger) *ProfitDecisionEngine {
	return &ProfitDecisionEngine{
		logger:            logger,
		predictionHorizon: 24 * time.Hour,
		weightsModel: map[string]float64{
			"profit":       0.4,
			"stability":    0.2,
			"trend":        0.2,
			"risk":         0.1,
			"switching_cost": 0.1,
		},
		riskModel: &RiskModel{
			VolatilityWeight: 0.3,
			TrendWeight:      0.4,
			LiquidityWeight:  0.3,
			RiskFreeRate:     0.02, // 2% annual risk-free rate
		},
	}
}

func (ps *ProfitSwitcher) Start() error {
	ps.logger.Info("Starting profit switcher")
	
	// Start market data updates
	go ps.marketDataUpdater()
	
	// Start profit calculation loop
	go ps.profitCalculationLoop()
	
	// Start switching decision loop
	go ps.switchingDecisionLoop()
	
	// Start metrics update loop
	go ps.metricsUpdateLoop()
	
	return nil
}

func (ps *ProfitSwitcher) Stop() error {
	ps.logger.Info("Stopping profit switcher")
	ps.cancel()
	return nil
}

func (ps *ProfitSwitcher) initializeSwitchingRules() {
	ps.switchingRules = []*SwitchingRule{
		{
			Name:                "High Profit Opportunity",
			Description:         "Switch when significant profit improvement is available",
			Priority:            1,
			MinProfitImprovement: 10.0, // 10% improvement required
			CooldownPeriod:      5 * time.Minute,
			DeviceTypes:         []string{"GPU", "CPU", "ASIC"},
			Enabled:             true,
			Conditions: []ProfitCondition{
				{Parameter: "profit_improvement", Operator: ">", Value: 10.0},
				{Parameter: "stability_score", Operator: ">", Value: 0.7},
			},
		},
		{
			Name:                "Moderate Profit Switch",
			Description:         "Switch for moderate but stable profit improvements",
			Priority:            2,
			MinProfitImprovement: 5.0,
			CooldownPeriod:      15 * time.Minute,
			DeviceTypes:         []string{"GPU", "CPU"},
			Enabled:             true,
			Conditions: []ProfitCondition{
				{Parameter: "profit_improvement", Operator: ">", Value: 5.0},
				{Parameter: "trend_positive", Operator: "==", Value: 1.0},
				{Parameter: "volatility", Operator: "<", Value: 0.2},
			},
		},
		{
			Name:                "Emergency Loss Prevention",
			Description:         "Switch away from unprofitable algorithms",
			Priority:            0, // Highest priority
			MinProfitImprovement: 0.0,
			CooldownPeriod:      1 * time.Minute,
			DeviceTypes:         []string{"GPU", "CPU", "ASIC"},
			Enabled:             true,
			Conditions: []ProfitCondition{
				{Parameter: "current_profit", Operator: "<", Value: 0.0},
				{Parameter: "trend_negative", Operator: "==", Value: 1.0},
			},
		},
	}
}

func (ps *ProfitSwitcher) marketDataUpdater() {
	ticker := time.NewTicker(ps.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.updateMarketData()
		}
	}
}

func (ps *ProfitSwitcher) updateMarketData() {
	algorithms := []string{"ethash", "kawpow", "randomx", "scrypt", "sha256d"}
	
	for _, algorithm := range algorithms {
		for providerName, provider := range ps.dataProviders {
			if !provider.IsHealthy() {
				continue
			}
			
			data, err := provider.GetMarketData(algorithm)
			if err != nil {
				ps.logger.Warn("Failed to get market data",
					zap.String("algorithm", algorithm),
					zap.String("provider", providerName),
					zap.Error(err))
				continue
			}
			
			ps.mu.Lock()
			ps.marketData[algorithm] = data
			ps.mu.Unlock()
			
			ps.logger.Debug("Market data updated",
				zap.String("algorithm", algorithm),
				zap.String("provider", providerName),
				zap.Float64("difficulty", data.Difficulty),
				zap.Float64("block_reward", data.BlockReward))
			
			break // Use first successful provider
		}
	}
}

func (ps *ProfitSwitcher) profitCalculationLoop() {
	ticker := time.NewTicker(ps.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.updateProfitCalculations()
		}
	}
}

func (ps *ProfitSwitcher) updateProfitCalculations() {
	ps.mu.RLock()
	algorithms := make([]string, 0, len(ps.marketData))
	for algorithm := range ps.marketData {
		algorithms = append(algorithms, algorithm)
	}
	ps.mu.RUnlock()
	
	for _, algorithm := range algorithms {
		ps.calculateAndStoreProfitHistory(algorithm)
	}
}

func (ps *ProfitSwitcher) calculateAndStoreProfitHistory(algorithm string) {
	ps.mu.RLock()
	marketData, exists := ps.marketData[algorithm]
	ps.mu.RUnlock()
	
	if !exists {
		return
	}
	
	// Calculate profit for reference hardware (will be adjusted per device)
	referenceHashrate := ps.getReferenceHashrate(algorithm)
	referencePower := ps.getReferencePower(algorithm)
	
	profit := ps.profitCalculator.CalculateProfit(
		referenceHashrate,
		referencePower,
		marketData,
	)
	
	dataPoint := ProfitDataPoint{
		Timestamp:       time.Now(),
		EstimatedProfit: profit.EstimatedDailyProfit,
		Hashrate:        referenceHashrate,
		PowerCost:       profit.DailyPowerCost,
		PoolFees:        profit.DailyPoolFees,
		NetProfit:       profit.NetDailyProfit,
	}
	
	ps.mu.Lock()
	history, exists := ps.algorithmHistory[algorithm]
	if !exists {
		history = &AlgorithmProfitHistory{
			Algorithm:       algorithm,
			ProfitHistory:   make([]ProfitDataPoint, 0),
			PredictedProfit: make(map[time.Duration]float64),
		}
		ps.algorithmHistory[algorithm] = history
	}
	
	// Add data point
	history.ProfitHistory = append(history.ProfitHistory, dataPoint)
	
	// Limit history size
	maxHistory := 1440 // 24 hours at 1-minute intervals
	if len(history.ProfitHistory) > maxHistory {
		history.ProfitHistory = history.ProfitHistory[len(history.ProfitHistory)-maxHistory:]
	}
	
	// Update statistics
	ps.updateProfitStatistics(history)
	
	// Update predictions if enabled
	if ps.config.EnablePredictive {
		ps.updateProfitPredictions(history)
	}
	
	history.LastUpdate = time.Now()
	ps.mu.Unlock()
}

func (ps *ProfitSwitcher) updateProfitStatistics(history *AlgorithmProfitHistory) {
	if len(history.ProfitHistory) == 0 {
		return
	}
	
	// Calculate average profit
	totalProfit := 0.0
	for _, point := range history.ProfitHistory {
		totalProfit += point.NetProfit
	}
	history.AverageProfit = totalProfit / float64(len(history.ProfitHistory))
	
	// Calculate trend (linear regression slope)
	history.ProfitTrend = ps.calculateProfitTrend(history.ProfitHistory)
	
	// Calculate volatility (standard deviation)
	history.Volatility = ps.calculateProfitVolatility(history.ProfitHistory, history.AverageProfit)
}

func (ps *ProfitSwitcher) calculateProfitTrend(history []ProfitDataPoint) float64 {
	if len(history) < 2 {
		return 0
	}
	
	n := float64(len(history))
	sumX := n * (n - 1) / 2
	sumY := 0.0
	sumXY := 0.0
	sumX2 := n * (n - 1) * (2*n - 1) / 6
	
	for i, point := range history {
		x := float64(i)
		y := point.NetProfit
		sumY += y
		sumXY += x * y
	}
	
	denominator := n*sumX2 - sumX*sumX
	if denominator == 0 {
		return 0
	}
	
	return (n*sumXY - sumX*sumY) / denominator
}

func (ps *ProfitSwitcher) calculateProfitVolatility(history []ProfitDataPoint, average float64) float64 {
	if len(history) < 2 {
		return 0
	}
	
	sumSquaredDiff := 0.0
	for _, point := range history {
		diff := point.NetProfit - average
		sumSquaredDiff += diff * diff
	}
	
	variance := sumSquaredDiff / float64(len(history)-1)
	return math.Sqrt(variance)
}

func (ps *ProfitSwitcher) updateProfitPredictions(history *AlgorithmProfitHistory) {
	// Simple time series prediction using moving averages and trend
	predictions := make(map[time.Duration]float64)
	
	horizons := []time.Duration{
		1 * time.Hour,
		4 * time.Hour,
		12 * time.Hour,
		24 * time.Hour,
	}
	
	for _, horizon := range horizons {
		prediction := ps.predictProfitAtHorizon(history, horizon)
		predictions[horizon] = prediction
	}
	
	history.PredictedProfit = predictions
}

func (ps *ProfitSwitcher) predictProfitAtHorizon(history *AlgorithmProfitHistory, horizon time.Duration) float64 {
	if len(history.ProfitHistory) == 0 {
		return 0
	}
	
	// Simple prediction: current average + trend * time
	hoursAhead := horizon.Hours()
	prediction := history.AverageProfit + (history.ProfitTrend * hoursAhead)
	
	// Apply confidence interval based on volatility
	confidenceFactor := 0.95 // 95% confidence
	uncertainty := history.Volatility * math.Sqrt(hoursAhead) * confidenceFactor
	
	// Return conservative estimate (lower bound)
	return prediction - uncertainty
}

func (ps *ProfitSwitcher) switchingDecisionLoop() {
	ticker := time.NewTicker(ps.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.evaluateSwitchingOpportunities()
		}
	}
}

func (ps *ProfitSwitcher) evaluateSwitchingOpportunities() {
	// This would be called for each device, simplified for demonstration
	ps.logger.Debug("Evaluating switching opportunities")
}

func (ps *ProfitSwitcher) ShouldSwitchAlgorithm(deviceID string, currentAlgorithm string, deviceHashrates map[string]float64, devicePower float64) (string, float64, bool) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	
	// Check if switching is allowed (cooldown, rate limits)
	if !ps.canSwitchNow(deviceID) {
		return currentAlgorithm, 0, false
	}
	
	currentProfit := ps.calculateDeviceProfit(currentAlgorithm, deviceHashrates[currentAlgorithm], devicePower)
	
	bestAlgorithm := currentAlgorithm
	bestProfit := currentProfit
	bestImprovement := 0.0
	
	// Evaluate all algorithms
	for algorithm, hashrate := range deviceHashrates {
		if algorithm == currentAlgorithm {
			continue
		}
		
		profit := ps.calculateDeviceProfit(algorithm, hashrate, devicePower)
		
		// Calculate switching cost
		switchingCost := ps.calculateSwitchingCost(currentProfit, ps.config.SwitchingCostPercent)
		adjustedProfit := profit - switchingCost
		
		improvement := (adjustedProfit - currentProfit) / math.Max(0.01, math.Abs(currentProfit)) * 100
		
		if adjustedProfit > bestProfit && improvement > ps.config.ProfitThreshold {
			// Check switching rules
			if ps.shouldSwitchByRules(deviceID, currentAlgorithm, algorithm, improvement) {
				bestAlgorithm = algorithm
				bestProfit = adjustedProfit
				bestImprovement = improvement
			}
		}
	}
	
	shouldSwitch := bestAlgorithm != currentAlgorithm && bestImprovement > ps.config.ProfitThreshold
	
	if shouldSwitch {
		ps.recordSwitchDecision(deviceID, currentAlgorithm, bestAlgorithm, bestImprovement)
	}
	
	return bestAlgorithm, bestImprovement, shouldSwitch
}

func (ps *ProfitSwitcher) calculateDeviceProfit(algorithm string, hashrate, power float64) float64 {
	marketData, exists := ps.marketData[algorithm]
	if !exists {
		return 0
	}
	
	profit := ps.profitCalculator.CalculateProfit(hashrate, power, marketData)
	return profit.NetDailyProfit
}

func (ps *ProfitSwitcher) calculateSwitchingCost(currentProfit, costPercent float64) float64 {
	// Switching cost includes:
	// 1. Lost mining time during switch
	// 2. Potential optimization reset
	// 3. Pool connection overhead
	
	baseCost := math.Abs(currentProfit) * (costPercent / 100.0)
	
	// Fixed time cost (assume 2 minutes downtime)
	timeCost := currentProfit * (2.0 / (24.0 * 60.0)) // 2 minutes out of 1440 minutes/day
	
	return baseCost + timeCost
}

func (ps *ProfitSwitcher) canSwitchNow(deviceID string) bool {
	// Check recent switch history for this device
	recentSwitches := ps.countRecentSwitches(deviceID, time.Hour)
	if recentSwitches >= ps.config.MaxSwitchesPerHour {
		return false
	}
	
	// Check minimum interval since last switch
	lastSwitch := ps.getLastSwitchTime(deviceID)
	if time.Since(lastSwitch) < ps.config.MinSwitchInterval {
		return false
	}
	
	return true
}

func (ps *ProfitSwitcher) countRecentSwitches(deviceID string, window time.Duration) int {
	cutoff := time.Now().Add(-window)
	count := 0
	
	for _, switchEvent := range ps.switchingHistory {
		if switchEvent.DeviceID == deviceID && switchEvent.Timestamp.After(cutoff) {
			count++
		}
	}
	
	return count
}

func (ps *ProfitSwitcher) getLastSwitchTime(deviceID string) time.Time {
	var lastTime time.Time
	
	for _, switchEvent := range ps.switchingHistory {
		if switchEvent.DeviceID == deviceID && switchEvent.Timestamp.After(lastTime) {
			lastTime = switchEvent.Timestamp
		}
	}
	
	return lastTime
}

func (ps *ProfitSwitcher) shouldSwitchByRules(deviceID, fromAlgorithm, toAlgorithm string, improvement float64) bool {
	// Sort rules by priority
	rules := make([]*SwitchingRule, len(ps.switchingRules))
	copy(rules, ps.switchingRules)
	
	sort.Slice(rules, func(i, j int) bool {
		return rules[i].Priority < rules[j].Priority // Lower number = higher priority
	})
	
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		
		// Check if rule applies to this device type (simplified)
		// In real implementation, would check actual device type
		
		// Check conditions
		if ps.evaluateRuleConditions(rule, fromAlgorithm, toAlgorithm, improvement) {
			ps.logger.Info("Switching rule matched",
				zap.String("device_id", deviceID),
				zap.String("rule", rule.Name),
				zap.String("from", fromAlgorithm),
				zap.String("to", toAlgorithm),
				zap.Float64("improvement", improvement))
			return true
		}
	}
	
	return false
}

func (ps *ProfitSwitcher) evaluateRuleConditions(rule *SwitchingRule, fromAlgorithm, toAlgorithm string, improvement float64) bool {
	// Check minimum improvement
	if improvement < rule.MinProfitImprovement {
		return false
	}
	
	// Evaluate specific conditions
	for _, condition := range rule.Conditions {
		if !ps.evaluateProfitCondition(condition, fromAlgorithm, toAlgorithm, improvement) {
			return false
		}
	}
	
	return true
}

func (ps *ProfitSwitcher) evaluateProfitCondition(condition ProfitCondition, fromAlgorithm, toAlgorithm string, improvement float64) bool {
	var value float64
	
	switch condition.Parameter {
	case "profit_improvement":
		value = improvement
	case "stability_score":
		value = ps.getAlgorithmStabilityScore(toAlgorithm)
	case "trend_positive":
		trend := ps.getAlgorithmTrend(toAlgorithm)
		value = 0
		if trend > 0 {
			value = 1
		}
	case "trend_negative":
		trend := ps.getAlgorithmTrend(fromAlgorithm)
		value = 0
		if trend < 0 {
			value = 1
		}
	case "volatility":
		value = ps.getAlgorithmVolatility(toAlgorithm)
	case "current_profit":
		value = ps.getCurrentAlgorithmProfit(fromAlgorithm)
	default:
		return false
	}
	
	return ps.compareValues(value, condition.Operator, condition.Value)
}

func (ps *ProfitSwitcher) compareValues(actual float64, operator string, expected float64) bool {
	switch operator {
	case ">":
		return actual > expected
	case "<":
		return actual < expected
	case ">=":
		return actual >= expected
	case "<=":
		return actual <= expected
	case "==":
		return math.Abs(actual-expected) < 0.0001
	case "!=":
		return math.Abs(actual-expected) >= 0.0001
	default:
		return false
	}
}

func (ps *ProfitSwitcher) getAlgorithmStabilityScore(algorithm string) float64 {
	history, exists := ps.algorithmHistory[algorithm]
	if !exists || len(history.ProfitHistory) < 10 {
		return 0.5 // Default neutral score
	}
	
	// Stability based on inverse of volatility
	if history.Volatility == 0 {
		return 1.0
	}
	
	stabilityScore := 1.0 / (1.0 + history.Volatility)
	return math.Max(0, math.Min(1, stabilityScore))
}

func (ps *ProfitSwitcher) getAlgorithmTrend(algorithm string) float64 {
	history, exists := ps.algorithmHistory[algorithm]
	if !exists {
		return 0
	}
	
	return history.ProfitTrend
}

func (ps *ProfitSwitcher) getAlgorithmVolatility(algorithm string) float64 {
	history, exists := ps.algorithmHistory[algorithm]
	if !exists {
		return 1.0 // High volatility default
	}
	
	return history.Volatility
}

func (ps *ProfitSwitcher) getCurrentAlgorithmProfit(algorithm string) float64 {
	history, exists := ps.algorithmHistory[algorithm]
	if !exists || len(history.ProfitHistory) == 0 {
		return 0
	}
	
	return history.ProfitHistory[len(history.ProfitHistory)-1].NetProfit
}

func (ps *ProfitSwitcher) recordSwitchDecision(deviceID, fromAlgorithm, toAlgorithm string, expectedImprovement float64) {
	switchEvent := &SwitchEvent{
		DeviceID:            deviceID,
		Timestamp:           time.Now(),
		FromAlgorithm:       fromAlgorithm,
		ToAlgorithm:         toAlgorithm,
		ExpectedImprovement: expectedImprovement,
		SwitchingCost:       ps.calculateSwitchingCost(ps.getCurrentAlgorithmProfit(fromAlgorithm), ps.config.SwitchingCostPercent),
		Success:             true, // Will be updated later
		Reason:              "Profit optimization",
	}
	
	ps.switchingHistory = append(ps.switchingHistory, switchEvent)
	
	// Limit history size
	maxHistory := 1000
	if len(ps.switchingHistory) > maxHistory {
		ps.switchingHistory = ps.switchingHistory[len(ps.switchingHistory)-maxHistory:]
	}
	
	// Update metrics
	ps.updateSwitchingMetrics(switchEvent)
}

func (ps *ProfitSwitcher) updateSwitchingMetrics(switchEvent *SwitchEvent) {
	ps.metrics.mu.Lock()
	defer ps.metrics.mu.Unlock()
	
	ps.metrics.TotalSwitches++
	ps.metrics.SwitchesByAlgorithm[switchEvent.ToAlgorithm]++
	
	if switchEvent.Success {
		ps.metrics.SuccessfulSwitches++
		
		if switchEvent.ActualImprovement > 0 {
			ps.metrics.TotalProfitGain += switchEvent.ActualImprovement
			
			// Update average
			successfulCount := float64(ps.metrics.SuccessfulSwitches)
			ps.metrics.AverageProfitGain = (ps.metrics.AverageProfitGain*(successfulCount-1) + switchEvent.ActualImprovement) / successfulCount
		}
		
		// Track best switch
		if ps.metrics.BestSwitch == nil || switchEvent.ActualImprovement > ps.metrics.BestSwitch.ActualImprovement {
			ps.metrics.BestSwitch = switchEvent
		}
	}
	
	ps.metrics.LastUpdate = time.Now()
}

func (ps *ProfitSwitcher) metricsUpdateLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ps.ctx.Done():
			return
		case <-ticker.C:
			ps.updateProfitAccuracy()
		}
	}
}

func (ps *ProfitSwitcher) updateProfitAccuracy() {
	// Calculate accuracy of profit predictions vs actual results
	recentSwitches := ps.getRecentSwitches(24 * time.Hour)
	
	if len(recentSwitches) == 0 {
		return
	}
	
	totalError := 0.0
	validPredictions := 0
	
	for _, switchEvent := range recentSwitches {
		if switchEvent.ActualImprovement != 0 { // Has actual data
			error := math.Abs(switchEvent.ExpectedImprovement - switchEvent.ActualImprovement)
			relativeError := error / math.Max(1.0, math.Abs(switchEvent.ExpectedImprovement))
			totalError += relativeError
			validPredictions++
		}
	}
	
	if validPredictions > 0 {
		averageError := totalError / float64(validPredictions)
		accuracy := math.Max(0, 1.0-averageError)
		
		ps.metrics.mu.Lock()
		ps.metrics.ProfitAccuracy = accuracy
		ps.metrics.mu.Unlock()
	}
}

func (ps *ProfitSwitcher) getRecentSwitches(window time.Duration) []*SwitchEvent {
	cutoff := time.Now().Add(-window)
	recent := make([]*SwitchEvent, 0)
	
	for _, switchEvent := range ps.switchingHistory {
		if switchEvent.Timestamp.After(cutoff) {
			recent = append(recent, switchEvent)
		}
	}
	
	return recent
}

func (ps *ProfitSwitcher) getReferenceHashrate(algorithm string) float64 {
	// Reference hashrates for different algorithms (simplified)
	references := map[string]float64{
		"ethash":  30000000,    // 30 MH/s
		"kawpow":  25000000,    // 25 MH/s
		"randomx": 5000,        // 5 KH/s
		"scrypt":  500000,      // 500 KH/s
		"sha256d": 50000000000, // 50 GH/s
	}
	
	if hashrate, exists := references[algorithm]; exists {
		return hashrate
	}
	
	return 1000000 // 1 MH/s default
}

func (ps *ProfitSwitcher) getReferencePower(algorithm string) float64 {
	// Reference power consumption for different algorithms (simplified)
	references := map[string]float64{
		"ethash":  250.0, // 250W
		"kawpow":  280.0, // 280W
		"randomx": 150.0, // 150W
		"scrypt":  200.0, // 200W
		"sha256d": 1500.0, // 1500W (ASIC)
	}
	
	if power, exists := references[algorithm]; exists {
		return power
	}
	
	return 200.0 // 200W default
}

// Profit calculation methods for ProfitCalculator

type ProfitResult struct {
	EstimatedDailyProfit float64 `json:"estimated_daily_profit"`
	DailyRevenue         float64 `json:"daily_revenue"`
	DailyPowerCost       float64 `json:"daily_power_cost"`
	DailyPoolFees        float64 `json:"daily_pool_fees"`
	NetDailyProfit       float64 `json:"net_daily_profit"`
	BreakEvenHashrate    float64 `json:"break_even_hashrate"`
	ROI                  float64 `json:"roi"`
}

func (pc *ProfitCalculator) CalculateProfit(hashrate, power float64, marketData *MarketData) *ProfitResult {
	// Calculate daily revenue
	hashrateShare := hashrate / marketData.NetworkHashrate
	blocksPerDay := (24 * 3600) / marketData.BlockTime
	dailyRevenue := hashrateShare * marketData.BlockReward * blocksPerDay * marketData.ExchangeRate
	
	// Calculate daily costs
	dailyPowerCost := (power / 1000) * 24 * pc.electricityCost // kWh * hours * rate
	dailyPoolFees := dailyRevenue * (pc.poolFeePercent / 100)
	
	// Calculate net profit
	netDailyProfit := dailyRevenue - dailyPowerCost - dailyPoolFees
	
	// Calculate break-even hashrate
	breakEvenRevenue := dailyPowerCost + dailyPoolFees
	breakEvenHashrate := (breakEvenRevenue / (marketData.BlockReward * blocksPerDay * marketData.ExchangeRate)) * marketData.NetworkHashrate
	
	// Calculate ROI (simplified)
	hardwareCost := 1000.0 // Assume $1000 hardware cost
	dailyDepreciation := hardwareCost * (pc.hardwareDepreciation / 365)
	adjustedProfit := netDailyProfit - dailyDepreciation
	roi := (adjustedProfit * 365) / hardwareCost * 100 // Annual ROI percentage
	
	return &ProfitResult{
		EstimatedDailyProfit: dailyRevenue,
		DailyRevenue:         dailyRevenue,
		DailyPowerCost:       dailyPowerCost,
		DailyPoolFees:        dailyPoolFees,
		NetDailyProfit:       netDailyProfit,
		BreakEvenHashrate:    breakEvenHashrate,
		ROI:                  roi,
	}
}

// Getter methods for metrics and status

func (ps *ProfitSwitcher) GetProfitMetrics() *ProfitSwitcherMetrics {
	ps.metrics.mu.RLock()
	defer ps.metrics.mu.RUnlock()
	
	metricsCopy := *ps.metrics
	metricsCopy.SwitchesByAlgorithm = make(map[string]uint64)
	for k, v := range ps.metrics.SwitchesByAlgorithm {
		metricsCopy.SwitchesByAlgorithm[k] = v
	}
	
	if ps.metrics.BestSwitch != nil {
		bestCopy := *ps.metrics.BestSwitch
		metricsCopy.BestSwitch = &bestCopy
	}
	
	return &metricsCopy
}

func (ps *ProfitSwitcher) GetAlgorithmProfitHistory(algorithm string) (*AlgorithmProfitHistory, bool) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	
	history, exists := ps.algorithmHistory[algorithm]
	if !exists {
		return nil, false
	}
	
	// Return copy
	historyCopy := *history
	historyCopy.ProfitHistory = append([]ProfitDataPoint(nil), history.ProfitHistory...)
	historyCopy.PredictedProfit = make(map[time.Duration]float64)
	for k, v := range history.PredictedProfit {
		historyCopy.PredictedProfit[k] = v
	}
	
	return &historyCopy, true
}

func (ps *ProfitSwitcher) GetSwitchingHistory(limit int) []*SwitchEvent {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	
	if limit <= 0 || limit > len(ps.switchingHistory) {
		limit = len(ps.switchingHistory)
	}
	
	startIndex := len(ps.switchingHistory) - limit
	history := make([]*SwitchEvent, limit)
	
	for i, switchEvent := range ps.switchingHistory[startIndex:] {
		eventCopy := *switchEvent
		history[i] = &eventCopy
	}
	
	return history
}

func (ps *ProfitSwitcher) GetCurrentMarketData() map[string]*MarketData {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	
	dataCopy := make(map[string]*MarketData)
	for k, v := range ps.marketData {
		marketCopy := *v
		dataCopy[k] = &marketCopy
	}
	
	return dataCopy
}

func (ps *ProfitSwitcher) AddDataProvider(name string, provider DataProvider) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	
	ps.dataProviders[name] = provider
	ps.logger.Info("Data provider added",
		zap.String("name", name),
		zap.Bool("healthy", provider.IsHealthy()))
}