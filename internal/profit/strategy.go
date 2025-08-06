package profit

import (
	"fmt"
	"math"
	"sort"
	"time"

	"go.uber.org/zap"
)

// SwitchingStrategy defines the interface for profit switching strategies
type SwitchingStrategy interface {
	// Evaluate evaluates whether to switch currencies
	Evaluate(current *ProfitMetric, alternatives map[string]*ProfitMetric) (*SwitchDecision, error)
	
	// Name returns the strategy name
	Name() string
	
	// Configure configures the strategy
	Configure(params map[string]interface{}) error
}

// StrategyFactory creates switching strategies
type StrategyFactory struct {
	logger *zap.Logger
}

// NewStrategyFactory creates a new strategy factory
func NewStrategyFactory(logger *zap.Logger) *StrategyFactory {
	return &StrategyFactory{logger: logger}
}

// CreateStrategy creates a switching strategy by name
func (sf *StrategyFactory) CreateStrategy(name string) (SwitchingStrategy, error) {
	switch name {
	case "aggressive":
		return NewAggressiveStrategy(sf.logger), nil
	case "conservative":
		return NewConservativeStrategy(sf.logger), nil
	case "balanced":
		return NewBalancedStrategy(sf.logger), nil
	case "momentum":
		return NewMomentumStrategy(sf.logger), nil
	case "risk_adjusted":
		return NewRiskAdjustedStrategy(sf.logger), nil
	default:
		return nil, fmt.Errorf("unknown strategy: %s", name)
	}
}

// AggressiveStrategy switches currencies aggressively for maximum profit
type AggressiveStrategy struct {
	logger        *zap.Logger
	minThreshold  float64
	maxVolatility float64
}

// NewAggressiveStrategy creates an aggressive switching strategy
func NewAggressiveStrategy(logger *zap.Logger) *AggressiveStrategy {
	return &AggressiveStrategy{
		logger:        logger,
		minThreshold:  5.0,  // 5% minimum profit increase
		maxVolatility: 0.5,  // 50% max volatility tolerance
	}
}

func (as *AggressiveStrategy) Name() string {
	return "aggressive"
}

func (as *AggressiveStrategy) Configure(params map[string]interface{}) error {
	if threshold, ok := params["min_threshold"].(float64); ok {
		as.minThreshold = threshold
	}
	if volatility, ok := params["max_volatility"].(float64); ok {
		as.maxVolatility = volatility
	}
	return nil
}

func (as *AggressiveStrategy) Evaluate(current *ProfitMetric, alternatives map[string]*ProfitMetric) (*SwitchDecision, error) {
	if current == nil || len(alternatives) == 0 {
		return nil, nil
	}
	
	// Find highest profit alternative
	var best *ProfitMetric
	maxProfit := current.NetProfit
	
	for _, alt := range alternatives {
		if alt.NetProfit > maxProfit && alt.Volatility <= as.maxVolatility {
			maxProfit = alt.NetProfit
			best = alt
		}
	}
	
	if best == nil {
		return nil, nil
	}
	
	// Calculate profit increase
	profitIncrease := ((best.NetProfit - current.NetProfit) / current.NetProfit) * 100
	
	if profitIncrease < as.minThreshold {
		return nil, nil
	}
	
	return &SwitchDecision{
		TargetCurrency: best.Currency,
		CurrentProfit:  current.NetProfit,
		TargetProfit:   best.NetProfit,
		ProfitIncrease: profitIncrease,
		Confidence:     0.8,
		Reasons: []string{
			fmt.Sprintf("%.1f%% profit increase", profitIncrease),
			"Aggressive strategy: maximizing profit",
		},
		Timestamp: time.Now(),
	}, nil
}

// ConservativeStrategy switches currencies conservatively with risk management
type ConservativeStrategy struct {
	logger           *zap.Logger
	minThreshold     float64
	maxVolatility    float64
	minMargin        float64
	stabilityPeriod  time.Duration
}

// NewConservativeStrategy creates a conservative switching strategy
func NewConservativeStrategy(logger *zap.Logger) *ConservativeStrategy {
	return &ConservativeStrategy{
		logger:          logger,
		minThreshold:    15.0, // 15% minimum profit increase
		maxVolatility:   0.2,  // 20% max volatility
		minMargin:       20.0, // 20% minimum profit margin
		stabilityPeriod: 24 * time.Hour,
	}
}

func (cs *ConservativeStrategy) Name() string {
	return "conservative"
}

func (cs *ConservativeStrategy) Configure(params map[string]interface{}) error {
	if threshold, ok := params["min_threshold"].(float64); ok {
		cs.minThreshold = threshold
	}
	if volatility, ok := params["max_volatility"].(float64); ok {
		cs.maxVolatility = volatility
	}
	if margin, ok := params["min_margin"].(float64); ok {
		cs.minMargin = margin
	}
	return nil
}

func (cs *ConservativeStrategy) Evaluate(current *ProfitMetric, alternatives map[string]*ProfitMetric) (*SwitchDecision, error) {
	if current == nil || len(alternatives) == 0 {
		return nil, nil
	}
	
	// Filter stable alternatives
	stable := make([]*ProfitMetric, 0)
	
	for _, alt := range alternatives {
		if alt.Volatility <= cs.maxVolatility && 
		   alt.ProfitMargin >= cs.minMargin &&
		   alt.Last24hAvgProfit > 0 {
			stable = append(stable, alt)
		}
	}
	
	if len(stable) == 0 {
		return nil, nil
	}
	
	// Sort by stability-adjusted profit
	sort.Slice(stable, func(i, j int) bool {
		// Adjust profit by volatility
		profitI := stable[i].NetProfit * (1 - stable[i].Volatility)
		profitJ := stable[j].NetProfit * (1 - stable[j].Volatility)
		return profitI > profitJ
	})
	
	best := stable[0]
	
	// Calculate profit increase
	profitIncrease := ((best.NetProfit - current.NetProfit) / current.NetProfit) * 100
	
	if profitIncrease < cs.minThreshold {
		return nil, nil
	}
	
	// Additional safety check
	if current.Volatility < cs.maxVolatility && current.ProfitMargin > cs.minMargin {
		// Current is already stable, require higher threshold
		if profitIncrease < cs.minThreshold*1.5 {
			return nil, nil
		}
	}
	
	return &SwitchDecision{
		TargetCurrency: best.Currency,
		CurrentProfit:  current.NetProfit,
		TargetProfit:   best.NetProfit,
		ProfitIncrease: profitIncrease,
		Confidence:     0.9,
		Reasons: []string{
			fmt.Sprintf("%.1f%% profit increase", profitIncrease),
			fmt.Sprintf("Low volatility: %.1f%%", best.Volatility*100),
			fmt.Sprintf("Good profit margin: %.1f%%", best.ProfitMargin),
			"Conservative strategy: prioritizing stability",
		},
		Timestamp: time.Now(),
	}, nil
}

// BalancedStrategy balances profit and risk
type BalancedStrategy struct {
	logger          *zap.Logger
	minThreshold    float64
	riskWeight      float64
	profitWeight    float64
}

// NewBalancedStrategy creates a balanced switching strategy
func NewBalancedStrategy(logger *zap.Logger) *BalancedStrategy {
	return &BalancedStrategy{
		logger:       logger,
		minThreshold: 10.0, // 10% minimum profit increase
		riskWeight:   0.4,
		profitWeight: 0.6,
	}
}

func (bs *BalancedStrategy) Name() string {
	return "balanced"
}

func (bs *BalancedStrategy) Configure(params map[string]interface{}) error {
	if threshold, ok := params["min_threshold"].(float64); ok {
		bs.minThreshold = threshold
	}
	if risk, ok := params["risk_weight"].(float64); ok {
		bs.riskWeight = risk
		bs.profitWeight = 1 - risk
	}
	return nil
}

func (bs *BalancedStrategy) Evaluate(current *ProfitMetric, alternatives map[string]*ProfitMetric) (*SwitchDecision, error) {
	if current == nil || len(alternatives) == 0 {
		return nil, nil
	}
	
	// Calculate scores for all alternatives
	type scoredMetric struct {
		metric *ProfitMetric
		score  float64
	}
	
	scored := make([]scoredMetric, 0)
	currentScore := bs.calculateScore(current)
	
	for _, alt := range alternatives {
		score := bs.calculateScore(alt)
		if score > currentScore {
			scored = append(scored, scoredMetric{alt, score})
		}
	}
	
	if len(scored) == 0 {
		return nil, nil
	}
	
	// Sort by score
	sort.Slice(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})
	
	best := scored[0].metric
	
	// Calculate profit increase
	profitIncrease := ((best.NetProfit - current.NetProfit) / current.NetProfit) * 100
	
	if profitIncrease < bs.minThreshold {
		return nil, nil
	}
	
	return &SwitchDecision{
		TargetCurrency: best.Currency,
		CurrentProfit:  current.NetProfit,
		TargetProfit:   best.NetProfit,
		ProfitIncrease: profitIncrease,
		Confidence:     0.85,
		Reasons: []string{
			fmt.Sprintf("%.1f%% profit increase", profitIncrease),
			fmt.Sprintf("Balanced score improvement: %.2f", scored[0].score-currentScore),
			"Balanced strategy: optimizing profit/risk ratio",
		},
		Timestamp: time.Now(),
	}, nil
}

func (bs *BalancedStrategy) calculateScore(metric *ProfitMetric) float64 {
	// Normalize profit (assume max profit of $1000/day)
	profitScore := math.Min(metric.NetProfit/1000, 1.0)
	
	// Risk score (inverse of volatility)
	riskScore := 1.0 - metric.Volatility
	
	// Combined score
	return bs.profitWeight*profitScore + bs.riskWeight*riskScore
}

// MomentumStrategy follows market momentum
type MomentumStrategy struct {
	logger           *zap.Logger
	minThreshold     float64
	momentumPeriod   time.Duration
	trendStrength    float64
}

// NewMomentumStrategy creates a momentum-based switching strategy
func NewMomentumStrategy(logger *zap.Logger) *MomentumStrategy {
	return &MomentumStrategy{
		logger:         logger,
		minThreshold:   8.0, // 8% minimum profit increase
		momentumPeriod: 7 * 24 * time.Hour,
		trendStrength:  0.6,
	}
}

func (ms *MomentumStrategy) Name() string {
	return "momentum"
}

func (ms *MomentumStrategy) Configure(params map[string]interface{}) error {
	if threshold, ok := params["min_threshold"].(float64); ok {
		ms.minThreshold = threshold
	}
	if strength, ok := params["trend_strength"].(float64); ok {
		ms.trendStrength = strength
	}
	return nil
}

func (ms *MomentumStrategy) Evaluate(current *ProfitMetric, alternatives map[string]*ProfitMetric) (*SwitchDecision, error) {
	if current == nil || len(alternatives) == 0 {
		return nil, nil
	}
	
	// Find currencies with positive momentum
	momentum := make([]*ProfitMetric, 0)
	
	for _, alt := range alternatives {
		// Check 7-day trend
		if alt.Last7dAvgProfit > 0 && alt.Last24hAvgProfit > alt.Last7dAvgProfit {
			// Positive momentum
			momentumStrength := (alt.Last24hAvgProfit - alt.Last7dAvgProfit) / alt.Last7dAvgProfit
			if momentumStrength >= ms.trendStrength {
				momentum = append(momentum, alt)
			}
		}
	}
	
	if len(momentum) == 0 {
		return nil, nil
	}
	
	// Sort by momentum strength
	sort.Slice(momentum, func(i, j int) bool {
		strengthI := (momentum[i].Last24hAvgProfit - momentum[i].Last7dAvgProfit) / momentum[i].Last7dAvgProfit
		strengthJ := (momentum[j].Last24hAvgProfit - momentum[j].Last7dAvgProfit) / momentum[j].Last7dAvgProfit
		return strengthI > strengthJ
	})
	
	best := momentum[0]
	
	// Calculate profit increase
	profitIncrease := ((best.NetProfit - current.NetProfit) / current.NetProfit) * 100
	
	if profitIncrease < ms.minThreshold {
		return nil, nil
	}
	
	momentumStrength := (best.Last24hAvgProfit - best.Last7dAvgProfit) / best.Last7dAvgProfit
	
	return &SwitchDecision{
		TargetCurrency: best.Currency,
		CurrentProfit:  current.NetProfit,
		TargetProfit:   best.NetProfit,
		ProfitIncrease: profitIncrease,
		Confidence:     0.75 + (momentumStrength * 0.15),
		Reasons: []string{
			fmt.Sprintf("%.1f%% profit increase", profitIncrease),
			fmt.Sprintf("Strong momentum: %.1f%%", momentumStrength*100),
			"Momentum strategy: following market trends",
		},
		Timestamp: time.Now(),
	}, nil
}

// RiskAdjustedStrategy uses risk-adjusted returns
type RiskAdjustedStrategy struct {
	logger          *zap.Logger
	minSharpeRatio  float64
	riskFreeRate    float64
}

// NewRiskAdjustedStrategy creates a risk-adjusted switching strategy
func NewRiskAdjustedStrategy(logger *zap.Logger) *RiskAdjustedStrategy {
	return &RiskAdjustedStrategy{
		logger:         logger,
		minSharpeRatio: 1.5,
		riskFreeRate:   0.02, // 2% daily risk-free rate
	}
}

func (ras *RiskAdjustedStrategy) Name() string {
	return "risk_adjusted"
}

func (ras *RiskAdjustedStrategy) Configure(params map[string]interface{}) error {
	if ratio, ok := params["min_sharpe_ratio"].(float64); ok {
		ras.minSharpeRatio = ratio
	}
	if rate, ok := params["risk_free_rate"].(float64); ok {
		ras.riskFreeRate = rate
	}
	return nil
}

func (ras *RiskAdjustedStrategy) Evaluate(current *ProfitMetric, alternatives map[string]*ProfitMetric) (*SwitchDecision, error) {
	if current == nil || len(alternatives) == 0 {
		return nil, nil
	}
	
	// Calculate Sharpe ratio for current
	currentSharpe := ras.calculateSharpeRatio(current)
	
	// Find alternatives with better risk-adjusted returns
	type sharpeMetric struct {
		metric *ProfitMetric
		sharpe float64
	}
	
	better := make([]sharpeMetric, 0)
	
	for _, alt := range alternatives {
		sharpe := ras.calculateSharpeRatio(alt)
		if sharpe > currentSharpe && sharpe >= ras.minSharpeRatio {
			better = append(better, sharpeMetric{alt, sharpe})
		}
	}
	
	if len(better) == 0 {
		return nil, nil
	}
	
	// Sort by Sharpe ratio
	sort.Slice(better, func(i, j int) bool {
		return better[i].sharpe > better[j].sharpe
	})
	
	best := better[0]
	
	// Calculate profit increase
	profitIncrease := ((best.metric.NetProfit - current.NetProfit) / current.NetProfit) * 100
	
	return &SwitchDecision{
		TargetCurrency: best.metric.Currency,
		CurrentProfit:  current.NetProfit,
		TargetProfit:   best.metric.NetProfit,
		ProfitIncrease: profitIncrease,
		Confidence:     math.Min(0.7 + (best.sharpe-currentSharpe)*0.1, 0.95),
		Reasons: []string{
			fmt.Sprintf("%.1f%% profit increase", profitIncrease),
			fmt.Sprintf("Better Sharpe ratio: %.2f vs %.2f", best.sharpe, currentSharpe),
			"Risk-adjusted strategy: optimizing risk/return",
		},
		Timestamp: time.Now(),
	}, nil
}

func (ras *RiskAdjustedStrategy) calculateSharpeRatio(metric *ProfitMetric) float64 {
	if metric.Volatility == 0 {
		return 0
	}
	
	// Daily return rate
	returnRate := metric.NetProfit / 100 // Assume $100 investment
	
	// Sharpe ratio = (Return - Risk Free Rate) / Volatility
	return (returnRate - ras.riskFreeRate) / metric.Volatility
}

// CompositStrategy combines multiple strategies
type CompositeStrategy struct {
	logger     *zap.Logger
	strategies []SwitchingStrategy
	weights    map[string]float64
	threshold  float64
}

// NewCompositeStrategy creates a composite strategy
func NewCompositeStrategy(logger *zap.Logger, strategies []SwitchingStrategy) *CompositeStrategy {
	weights := make(map[string]float64)
	for _, s := range strategies {
		weights[s.Name()] = 1.0 / float64(len(strategies))
	}
	
	return &CompositeStrategy{
		logger:     logger,
		strategies: strategies,
		weights:    weights,
		threshold:  0.6, // 60% agreement threshold
	}
}

func (cs *CompositeStrategy) Name() string {
	return "composite"
}

func (cs *CompositeStrategy) Configure(params map[string]interface{}) error {
	if threshold, ok := params["threshold"].(float64); ok {
		cs.threshold = threshold
	}
	
	// Configure individual strategies
	for _, strategy := range cs.strategies {
		if stratParams, ok := params[strategy.Name()].(map[string]interface{}); ok {
			strategy.Configure(stratParams)
		}
	}
	
	return nil
}

func (cs *CompositeStrategy) Evaluate(current *ProfitMetric, alternatives map[string]*ProfitMetric) (*SwitchDecision, error) {
	if current == nil || len(alternatives) == 0 {
		return nil, nil
	}
	
	// Collect decisions from all strategies
	decisions := make(map[string][]*SwitchDecision)
	
	for _, strategy := range cs.strategies {
		decision, err := strategy.Evaluate(current, alternatives)
		if err != nil {
			cs.logger.Error("Strategy evaluation failed",
				zap.String("strategy", strategy.Name()),
				zap.Error(err),
			)
			continue
		}
		
		if decision != nil {
			decisions[decision.TargetCurrency] = append(decisions[decision.TargetCurrency], decision)
		}
	}
	
	// Find consensus
	var bestCurrency string
	maxWeight := 0.0
	
	for currency, currencyDecisions := range decisions {
		weight := 0.0
		for _, decision := range currencyDecisions {
			for _, strategy := range cs.strategies {
				// Match decision to strategy (simplified)
				weight += cs.weights[strategy.Name()]
			}
		}
		
		if weight > maxWeight && weight >= cs.threshold {
			maxWeight = weight
			bestCurrency = currency
		}
	}
	
	if bestCurrency == "" {
		return nil, nil
	}
	
	// Create composite decision
	var totalProfit, totalIncrease, totalConfidence float64
	reasons := []string{}
	
	for _, decision := range decisions[bestCurrency] {
		totalProfit += decision.TargetProfit
		totalIncrease += decision.ProfitIncrease
		totalConfidence += decision.Confidence
		reasons = append(reasons, decision.Reasons...)
	}
	
	count := float64(len(decisions[bestCurrency]))
	
	return &SwitchDecision{
		TargetCurrency: bestCurrency,
		CurrentProfit:  current.NetProfit,
		TargetProfit:   totalProfit / count,
		ProfitIncrease: totalIncrease / count,
		Confidence:     totalConfidence / count,
		Reasons:        append(reasons, fmt.Sprintf("Composite strategy: %.0f%% agreement", maxWeight*100)),
		Timestamp:      time.Now(),
	}, nil
}