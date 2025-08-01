package currency

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ProfitSwitcher automatically switches mining to the most profitable currency
// Following John Carmack's principle: "If you want to set off and go develop some grand new thing, you don't need millions of dollars of capitalization."
type ProfitSwitcher struct {
	logger *zap.Logger
	
	// Components
	multiCurrency *MultiCurrencySupport
	miner         MinerInterface
	
	// Current state
	currentCurrency string
	currentAlgo     string
	lastSwitch      time.Time
	switchMu        sync.RWMutex
	
	// Configuration
	config          ProfitSwitcherConfig
	
	// Control
	ctx             context.Context
	cancel          context.CancelFunc
	
	// Metrics
	metrics         struct {
		switchCount        uint64
		profitGained       float64
		uptimeByAlgo       map[string]time.Duration
		lastCheckProfit    float64
		totalMiningTime    time.Duration
		switchDecisions    uint64
		switchesSkipped    uint64
	}
}

// ProfitSwitcherConfig configures the profit switcher
type ProfitSwitcherConfig struct {
	// Switching parameters
	CheckInterval      time.Duration
	MinSwitchInterval  time.Duration
	ProfitThreshold    float64 // Minimum % improvement to switch
	
	// Stability
	StabilityPeriod    time.Duration // Time to wait before considering switch
	ConfirmationChecks int           // Number of checks before switching
	
	// Constraints
	AllowedAlgorithms  []string
	ExcludedCurrencies []string
	
	// Fees
	SwitchingCost      float64 // Cost in $ per switch
	DowntimePerSwitch  time.Duration
	
	// Advanced
	PredictiveSwitching bool
	MarketTrendWeight   float64
}

// MinerInterface represents the mining software interface
type MinerInterface interface {
	GetCurrentAlgorithm() string
	GetCurrentCurrency() string
	GetHashrate(algorithm string) (float64, error)
	GetPowerUsage(algorithm string) (float64, error)
	SwitchCurrency(currency string, algorithm string, config map[string]interface{}) error
	IsRunning() bool
}

// SwitchDecision represents a switching decision
type SwitchDecision struct {
	FromCurrency     string
	ToCurrency       string
	FromAlgorithm    string
	ToAlgorithm      string
	CurrentProfit    float64
	ExpectedProfit   float64
	ImprovementRatio float64
	Confidence       float64
	Reasons          []string
	Timestamp        time.Time
}

// SwitchHistory tracks switching history
type SwitchHistory struct {
	decisions     []*SwitchDecision
	maxHistory    int
	mu            sync.RWMutex
}

// NewProfitSwitcher creates a new profit switcher
func NewProfitSwitcher(logger *zap.Logger, multiCurrency *MultiCurrencySupport, miner MinerInterface, config ProfitSwitcherConfig) (*ProfitSwitcher, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	ps := &ProfitSwitcher{
		logger:        logger,
		multiCurrency: multiCurrency,
		miner:         miner,
		config:        config,
		ctx:           ctx,
		cancel:        cancel,
	}
	
	// Initialize metrics
	ps.metrics.uptimeByAlgo = make(map[string]time.Duration)
	
	// Get current state
	ps.currentAlgo = miner.GetCurrentAlgorithm()
	ps.currentCurrency = miner.GetCurrentCurrency()
	ps.lastSwitch = time.Now()
	
	// Start monitoring
	go ps.monitorLoop()
	
	logger.Info("Started profit switcher",
		zap.String("current_currency", ps.currentCurrency),
		zap.String("current_algorithm", ps.currentAlgo),
		zap.Duration("check_interval", config.CheckInterval))
	
	return ps, nil
}

// CheckProfitability checks if switching would be profitable
func (ps *ProfitSwitcher) CheckProfitability() (*SwitchDecision, error) {
	ps.metrics.switchDecisions++
	
	// Get current hashrates and power usage
	hashRates := make(map[string]float64)
	powerUsage := make(map[string]float64)
	
	for _, algo := range ps.getAllowedAlgorithms() {
		hashrate, err := ps.miner.GetHashrate(algo)
		if err != nil {
			ps.logger.Warn("Failed to get hashrate",
				zap.String("algorithm", algo),
				zap.Error(err))
			continue
		}
		
		power, err := ps.miner.GetPowerUsage(algo)
		if err != nil {
			ps.logger.Warn("Failed to get power usage",
				zap.String("algorithm", algo),
				zap.Error(err))
			continue
		}
		
		hashRates[algo] = hashrate
		powerUsage[algo] = power
	}
	
	// Calculate profitability for all currencies
	// Using a default electricity cost - this should be configurable
	electricityCost := 0.10 // $0.10 per kWh
	
	results, err := ps.multiCurrency.CalculateProfitability(hashRates, powerUsage, electricityCost)
	if err != nil {
		return nil, fmt.Errorf("failed to calculate profitability: %w", err)
	}
	
	// Find current profit
	var currentProfit float64
	for _, result := range results {
		if result.Currency == ps.currentCurrency {
			currentProfit = result.ProfitPerDay
			ps.metrics.lastCheckProfit = currentProfit
			break
		}
	}
	
	// Find best alternative
	var bestResult *ProfitResult
	for _, result := range results {
		// Skip excluded currencies
		if ps.isExcluded(result.Currency) {
			continue
		}
		
		// Skip if not allowed algorithm
		if !ps.isAllowedAlgorithm(result.Algorithm) {
			continue
		}
		
		// Skip current currency
		if result.Currency == ps.currentCurrency {
			continue
		}
		
		// Check if better than current best
		if bestResult == nil || result.ProfitPerDay > bestResult.ProfitPerDay {
			bestResult = result
		}
	}
	
	if bestResult == nil {
		return nil, errors.New("no alternative currency found")
	}
	
	// Calculate improvement ratio
	improvementRatio := 0.0
	if currentProfit > 0 {
		improvementRatio = (bestResult.ProfitPerDay - currentProfit) / currentProfit
	}
	
	// Build decision
	decision := &SwitchDecision{
		FromCurrency:     ps.currentCurrency,
		ToCurrency:       bestResult.Currency,
		FromAlgorithm:    ps.currentAlgo,
		ToAlgorithm:      bestResult.Algorithm,
		CurrentProfit:    currentProfit,
		ExpectedProfit:   bestResult.ProfitPerDay,
		ImprovementRatio: improvementRatio,
		Confidence:       ps.calculateConfidence(bestResult, results),
		Timestamp:        time.Now(),
		Reasons:          []string{},
	}
	
	// Add decision reasons
	if improvementRatio > ps.config.ProfitThreshold {
		decision.Reasons = append(decision.Reasons,
			fmt.Sprintf("Profit improvement: %.2f%%", improvementRatio*100))
	}
	
	if bestResult.Rank == 1 {
		decision.Reasons = append(decision.Reasons, "Most profitable currency")
	}
	
	ps.logger.Debug("Profitability check completed",
		zap.String("current", ps.currentCurrency),
		zap.Float64("current_profit", currentProfit),
		zap.String("best", bestResult.Currency),
		zap.Float64("best_profit", bestResult.ProfitPerDay),
		zap.Float64("improvement", improvementRatio))
	
	return decision, nil
}

// ExecuteSwitch executes a currency switch
func (ps *ProfitSwitcher) ExecuteSwitch(decision *SwitchDecision) error {
	ps.switchMu.Lock()
	defer ps.switchMu.Unlock()
	
	// Check cooldown
	if time.Since(ps.lastSwitch) < ps.config.MinSwitchInterval {
		ps.metrics.switchesSkipped++
		return errors.New("switch cooldown active")
	}
	
	// Check if improvement is worth it
	switchCost := ps.calculateSwitchCost(decision)
	netImprovement := decision.ExpectedProfit - decision.CurrentProfit - switchCost
	
	if netImprovement <= 0 {
		ps.metrics.switchesSkipped++
		return fmt.Errorf("switch not profitable after costs: net improvement $%.4f", netImprovement)
	}
	
	ps.logger.Info("Executing currency switch",
		zap.String("from", decision.FromCurrency),
		zap.String("to", decision.ToCurrency),
		zap.Float64("expected_improvement", decision.ImprovementRatio))
	
	// Get currency configuration
	ps.multiCurrency.currenciesMu.RLock()
	currency := ps.multiCurrency.currencies[decision.ToCurrency]
	ps.multiCurrency.currenciesMu.RUnlock()
	
	if currency == nil {
		return errors.New("target currency not found")
	}
	
	// Build miner configuration
	minerConfig := map[string]interface{}{
		"algorithm": decision.ToAlgorithm,
		"pool_url":  currency.ExtraConfig["pool_url"],
		"wallet":    currency.ExtraConfig["wallet"],
		"extra":     currency.ExtraConfig,
	}
	
	// Execute switch
	startTime := time.Now()
	
	err := ps.miner.SwitchCurrency(decision.ToCurrency, decision.ToAlgorithm, minerConfig)
	if err != nil {
		return fmt.Errorf("miner switch failed: %w", err)
	}
	
	// Update state
	ps.updateMiningTime(ps.currentAlgo, time.Since(ps.lastSwitch))
	
	ps.currentCurrency = decision.ToCurrency
	ps.currentAlgo = decision.ToAlgorithm
	ps.lastSwitch = time.Now()
	ps.metrics.switchCount++
	
	// Calculate actual downtime
	actualDowntime := time.Since(startTime)
	
	ps.logger.Info("Currency switch completed",
		zap.String("new_currency", decision.ToCurrency),
		zap.String("new_algorithm", decision.ToAlgorithm),
		zap.Duration("downtime", actualDowntime))
	
	return nil
}

// GetCurrentStatus returns the current switching status
func (ps *ProfitSwitcher) GetCurrentStatus() map[string]interface{} {
	ps.switchMu.RLock()
	defer ps.switchMu.RUnlock()
	
	return map[string]interface{}{
		"current_currency":   ps.currentCurrency,
		"current_algorithm":  ps.currentAlgo,
		"last_switch":        ps.lastSwitch,
		"time_on_current":    time.Since(ps.lastSwitch),
		"last_profit_check":  ps.metrics.lastCheckProfit,
		"switch_count":       ps.metrics.switchCount,
		"switches_skipped":   ps.metrics.switchesSkipped,
		"total_mining_time":  ps.metrics.totalMiningTime,
	}
}

// Implementation methods

func (ps *ProfitSwitcher) monitorLoop() {
	ticker := time.NewTicker(ps.config.CheckInterval)
	defer ticker.Stop()
	
	confirmationCount := 0
	var pendingDecision *SwitchDecision
	
	for {
		select {
		case <-ticker.C:
			// Check if miner is running
			if !ps.miner.IsRunning() {
				continue
			}
			
			// Check profitability
			decision, err := ps.CheckProfitability()
			if err != nil {
				ps.logger.Debug("Profitability check failed", zap.Error(err))
				confirmationCount = 0
				pendingDecision = nil
				continue
			}
			
			// Check if switch is warranted
			if decision.ImprovementRatio < ps.config.ProfitThreshold {
				confirmationCount = 0
				pendingDecision = nil
				continue
			}
			
			// Confirmation logic
			if pendingDecision != nil && pendingDecision.ToCurrency == decision.ToCurrency {
				confirmationCount++
				
				if confirmationCount >= ps.config.ConfirmationChecks {
					// Execute switch
					if err := ps.ExecuteSwitch(decision); err != nil {
						ps.logger.Error("Failed to execute switch", zap.Error(err))
					}
					confirmationCount = 0
					pendingDecision = nil
				}
			} else {
				// New decision
				confirmationCount = 1
				pendingDecision = decision
			}
			
		case <-ps.ctx.Done():
			return
		}
	}
}

func (ps *ProfitSwitcher) getAllowedAlgorithms() []string {
	if len(ps.config.AllowedAlgorithms) > 0 {
		return ps.config.AllowedAlgorithms
	}
	
	// Return all known algorithms
	ps.multiCurrency.algorithmsMu.RLock()
	defer ps.multiCurrency.algorithmsMu.RUnlock()
	
	algos := make([]string, 0, len(ps.multiCurrency.algorithms))
	for name := range ps.multiCurrency.algorithms {
		algos = append(algos, name)
	}
	
	return algos
}

func (ps *ProfitSwitcher) isAllowedAlgorithm(algo string) bool {
	if len(ps.config.AllowedAlgorithms) == 0 {
		return true
	}
	
	for _, allowed := range ps.config.AllowedAlgorithms {
		if allowed == algo {
			return true
		}
	}
	
	return false
}

func (ps *ProfitSwitcher) isExcluded(currency string) bool {
	for _, excluded := range ps.config.ExcludedCurrencies {
		if excluded == currency {
			return true
		}
	}
	return false
}

func (ps *ProfitSwitcher) calculateConfidence(best *ProfitResult, all []*ProfitResult) float64 {
	if len(all) <= 1 {
		return 1.0
	}
	
	// Base confidence on profit margin compared to second best
	secondBest := float64(0)
	for _, result := range all {
		if result.Currency != best.Currency && result.ProfitPerDay > secondBest {
			secondBest = result.ProfitPerDay
		}
	}
	
	if secondBest <= 0 {
		return 1.0
	}
	
	margin := (best.ProfitPerDay - secondBest) / secondBest
	
	// Confidence increases with margin
	confidence := margin
	if confidence > 1.0 {
		confidence = 1.0
	}
	
	return confidence
}

func (ps *ProfitSwitcher) calculateSwitchCost(decision *SwitchDecision) float64 {
	// Fixed switching cost
	cost := ps.config.SwitchingCost
	
	// Add opportunity cost from downtime
	downtimeHours := ps.config.DowntimePerSwitch.Hours()
	opportunityCost := decision.CurrentProfit * (downtimeHours / 24.0)
	
	cost += opportunityCost
	
	return cost
}

func (ps *ProfitSwitcher) updateMiningTime(algo string, duration time.Duration) {
	ps.metrics.uptimeByAlgo[algo] += duration
	ps.metrics.totalMiningTime += duration
}

// GetMetrics returns profit switcher metrics
func (ps *ProfitSwitcher) GetMetrics() map[string]interface{} {
	ps.switchMu.RLock()
	defer ps.switchMu.RUnlock()
	
	uptimeByAlgo := make(map[string]string)
	for algo, duration := range ps.metrics.uptimeByAlgo {
		uptimeByAlgo[algo] = duration.String()
	}
	
	avgSwitchInterval := time.Duration(0)
	if ps.metrics.switchCount > 0 {
		avgSwitchInterval = ps.metrics.totalMiningTime / time.Duration(ps.metrics.switchCount)
	}
	
	return map[string]interface{}{
		"switch_count":         ps.metrics.switchCount,
		"profit_gained":        ps.metrics.profitGained,
		"uptime_by_algorithm":  uptimeByAlgo,
		"last_check_profit":    ps.metrics.lastCheckProfit,
		"total_mining_time":    ps.metrics.totalMiningTime.String(),
		"switch_decisions":     ps.metrics.switchDecisions,
		"switches_skipped":     ps.metrics.switchesSkipped,
		"avg_switch_interval":  avgSwitchInterval.String(),
		"current_currency":     ps.currentCurrency,
		"current_algorithm":    ps.currentAlgo,
		"profit_threshold":     ps.config.ProfitThreshold,
	}
}

// Stop stops the profit switcher
func (ps *ProfitSwitcher) Stop() {
	ps.logger.Info("Stopping profit switcher")
	ps.cancel()
}

// ProfitPredictor predicts future profitability
type ProfitPredictor struct {
	logger        *zap.Logger
	multiCurrency *MultiCurrencySupport
	historySize   int
	history       map[string][]*ProfitDataPoint
	mu            sync.RWMutex
}

// ProfitDataPoint represents historical profit data
type ProfitDataPoint struct {
	Timestamp   time.Time
	Profit      float64
	Difficulty  float64
	Price       float64
	NetworkHash float64
}

// NewProfitPredictor creates a new profit predictor
func NewProfitPredictor(logger *zap.Logger, multiCurrency *MultiCurrencySupport, historySize int) *ProfitPredictor {
	return &ProfitPredictor{
		logger:        logger,
		multiCurrency: multiCurrency,
		historySize:   historySize,
		history:       make(map[string][]*ProfitDataPoint),
	}
}

// AddDataPoint adds a historical data point
func (pp *ProfitPredictor) AddDataPoint(currency string, point *ProfitDataPoint) {
	pp.mu.Lock()
	defer pp.mu.Unlock()
	
	if pp.history[currency] == nil {
		pp.history[currency] = make([]*ProfitDataPoint, 0, pp.historySize)
	}
	
	pp.history[currency] = append(pp.history[currency], point)
	
	// Maintain history size
	if len(pp.history[currency]) > pp.historySize {
		pp.history[currency] = pp.history[currency][1:]
	}
}

// PredictProfit predicts future profit for a currency
func (pp *ProfitPredictor) PredictProfit(currency string, hours int) (float64, error) {
	pp.mu.RLock()
	defer pp.mu.RUnlock()
	
	history, exists := pp.history[currency]
	if !exists || len(history) < 2 {
		return 0, errors.New("insufficient historical data")
	}
	
	// Simple linear regression
	// In production, use more sophisticated time series analysis
	n := len(history)
	sumX, sumY, sumXY, sumX2 := 0.0, 0.0, 0.0, 0.0
	
	for i, point := range history {
		x := float64(i)
		y := point.Profit
		
		sumX += x
		sumY += y
		sumXY += x * y
		sumX2 += x * x
	}
	
	// Calculate slope and intercept
	slope := (float64(n)*sumXY - sumX*sumY) / (float64(n)*sumX2 - sumX*sumX)
	intercept := (sumY - slope*sumX) / float64(n)
	
	// Predict future value
	futureX := float64(n-1) + float64(hours)
	prediction := slope*futureX + intercept
	
	// Ensure non-negative
	if prediction < 0 {
		prediction = 0
	}
	
	return prediction, nil
}

// GetTrend returns the profit trend for a currency
func (pp *ProfitPredictor) GetTrend(currency string) string {
	pp.mu.RLock()
	defer pp.mu.RUnlock()
	
	history, exists := pp.history[currency]
	if !exists || len(history) < 2 {
		return "unknown"
	}
	
	// Compare recent average to older average
	mid := len(history) / 2
	oldAvg, newAvg := 0.0, 0.0
	
	for i := 0; i < mid; i++ {
		oldAvg += history[i].Profit
	}
	oldAvg /= float64(mid)
	
	for i := mid; i < len(history); i++ {
		newAvg += history[i].Profit
	}
	newAvg /= float64(len(history) - mid)
	
	// Determine trend
	change := (newAvg - oldAvg) / oldAvg
	
	if change > 0.1 {
		return "strong_up"
	} else if change > 0.02 {
		return "up"
	} else if change < -0.1 {
		return "strong_down"
	} else if change < -0.02 {
		return "down"
	}
	
	return "stable"
}