package profit

import (
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

// ProfitAnalyzer provides detailed profitability analysis
type ProfitAnalyzer struct {
	logger *zap.Logger
	
	// Analysis data
	historicalData   map[string][]*HistoricalDataPoint
	dataMu           sync.RWMutex
	
	// Market analysis
	marketTrends     map[string]*MarketTrend
	trendsMu         sync.RWMutex
	
	// Configuration
	config           AnalyzerConfig
}

// AnalyzerConfig contains analyzer configuration
type AnalyzerConfig struct {
	// Analysis parameters
	AnalysisWindow      time.Duration // How far back to analyze
	MinDataPoints       int           // Minimum data points for analysis
	TrendSensitivity    float64       // Sensitivity for trend detection
	
	// Forecasting
	ForecastHorizon     time.Duration // How far to forecast
	ConfidenceLevel     float64       // Confidence level for predictions
	
	// Risk parameters
	MaxRiskTolerance    float64       // Maximum acceptable risk
	VolatilityThreshold float64       // Volatility threshold for warnings
}

// HistoricalDataPoint represents historical profitability data
type HistoricalDataPoint struct {
	Timestamp       time.Time
	Currency        string
	Difficulty      float64
	ExchangeRate    float64
	Revenue         float64
	Cost            float64
	Profit          float64
	ProfitMargin    float64
	Hashrate        float64
	BlocksFound     int
	NetworkHashrate float64
}

// MarketTrend represents market trend analysis
type MarketTrend struct {
	Currency        string
	TrendDirection  string  // "up", "down", "stable"
	TrendStrength   float64 // 0-1
	Momentum        float64
	Support         float64 // Support level
	Resistance      float64 // Resistance level
	Volatility      float64
	LastUpdate      time.Time
}

// ProfitabilityReport represents a comprehensive profitability report
type ProfitabilityReport struct {
	GeneratedAt     time.Time
	Currency        string
	Period          time.Duration
	
	// Current metrics
	CurrentProfit   float64
	CurrentMargin   float64
	CurrentROI      float64
	
	// Historical analysis
	AverageProfit   float64
	MaxProfit       float64
	MinProfit       float64
	ProfitStdDev    float64
	
	// Trend analysis
	Trend           *MarketTrend
	TrendForecast   *ProfitForecast
	
	// Risk analysis
	RiskScore       float64
	RiskFactors     []string
	
	// Recommendations
	Recommendations []Recommendation
	
	// Comparative analysis
	Ranking         int
	BetterOptions   []AlternativeOption
}

// ProfitForecast represents profit forecast
type ProfitForecast struct {
	Period          time.Duration
	ExpectedProfit  float64
	BestCase        float64
	WorstCase       float64
	Confidence      float64
	Assumptions     []string
}

// Recommendation represents an actionable recommendation
type Recommendation struct {
	Type            string // "switch", "hold", "optimize", "warning"
	Priority        string // "high", "medium", "low"
	Action          string
	Reason          string
	ExpectedImpact  float64
	Confidence      float64
}

// AlternativeOption represents an alternative currency option
type AlternativeOption struct {
	Currency        string
	ExpectedProfit  float64
	ProfitIncrease  float64
	RiskScore       float64
	SwitchingCost   float64
}

// NewProfitAnalyzer creates a new profit analyzer
func NewProfitAnalyzer(logger *zap.Logger, config AnalyzerConfig) *ProfitAnalyzer {
	return &ProfitAnalyzer{
		logger:         logger,
		historicalData: make(map[string][]*HistoricalDataPoint),
		marketTrends:   make(map[string]*MarketTrend),
		config:         config,
	}
}

// RecordDataPoint records a historical data point
func (pa *ProfitAnalyzer) RecordDataPoint(data *HistoricalDataPoint) {
	pa.dataMu.Lock()
	defer pa.dataMu.Unlock()
	
	// Add to historical data
	pa.historicalData[data.Currency] = append(pa.historicalData[data.Currency], data)
	
	// Limit data size
	maxPoints := int(pa.config.AnalysisWindow.Hours()) * 60 // One point per minute
	if len(pa.historicalData[data.Currency]) > maxPoints {
		pa.historicalData[data.Currency] = pa.historicalData[data.Currency][len(pa.historicalData[data.Currency])-maxPoints:]
	}
	
	// Update trend analysis
	go pa.updateTrendAnalysis(data.Currency)
}

// GenerateReport generates a comprehensive profitability report
func (pa *ProfitAnalyzer) GenerateReport(currency string, metric *ProfitMetric) *ProfitabilityReport {
	report := &ProfitabilityReport{
		GeneratedAt:   time.Now(),
		Currency:      currency,
		Period:        pa.config.AnalysisWindow,
		CurrentProfit: metric.NetProfit,
		CurrentMargin: metric.ProfitMargin,
		CurrentROI:    metric.ROI,
	}
	
	// Historical analysis
	pa.analyzeHistoricalData(report, currency)
	
	// Trend analysis
	pa.trendsMu.RLock()
	if trend, exists := pa.marketTrends[currency]; exists {
		report.Trend = trend
	}
	pa.trendsMu.RUnlock()
	
	// Generate forecast
	report.TrendForecast = pa.generateForecast(currency, metric)
	
	// Risk analysis
	report.RiskScore = pa.calculateRiskScore(currency, metric)
	report.RiskFactors = pa.identifyRiskFactors(currency, metric)
	
	// Generate recommendations
	report.Recommendations = pa.generateRecommendations(report, metric)
	
	// Comparative analysis
	report.BetterOptions = pa.findBetterOptions(currency, metric)
	
	return report
}

// analyzeHistoricalData performs historical data analysis
func (pa *ProfitAnalyzer) analyzeHistoricalData(report *ProfitabilityReport, currency string) {
	pa.dataMu.RLock()
	defer pa.dataMu.RUnlock()
	
	data := pa.historicalData[currency]
	if len(data) == 0 {
		return
	}
	
	// Calculate statistics
	var profits []float64
	for _, point := range data {
		profits = append(profits, point.Profit)
	}
	
	report.AverageProfit = pa.mean(profits)
	report.MaxProfit = pa.max(profits)
	report.MinProfit = pa.min(profits)
	report.ProfitStdDev = pa.stdDev(profits)
}

// generateForecast generates profit forecast
func (pa *ProfitAnalyzer) generateForecast(currency string, metric *ProfitMetric) *ProfitForecast {
	forecast := &ProfitForecast{
		Period:     pa.config.ForecastHorizon,
		Confidence: pa.config.ConfidenceLevel,
	}
	
	pa.dataMu.RLock()
	data := pa.historicalData[currency]
	pa.dataMu.RUnlock()
	
	if len(data) < pa.config.MinDataPoints {
		forecast.ExpectedProfit = metric.NetProfit
		forecast.BestCase = metric.NetProfit * 1.2
		forecast.WorstCase = metric.NetProfit * 0.8
		forecast.Confidence = 0.5
		forecast.Assumptions = []string{"Limited historical data"}
		return forecast
	}
	
	// Simple linear regression for trend
	trend := pa.calculateTrend(data)
	
	// Project forward
	hoursAhead := pa.config.ForecastHorizon.Hours()
	forecast.ExpectedProfit = metric.NetProfit + (trend * hoursAhead)
	
	// Calculate confidence intervals
	volatility := pa.calculateVolatility(data)
	interval := volatility * math.Sqrt(hoursAhead) * 1.96 // 95% confidence
	
	forecast.BestCase = forecast.ExpectedProfit + interval
	forecast.WorstCase = forecast.ExpectedProfit - interval
	
	// Ensure non-negative
	if forecast.WorstCase < 0 {
		forecast.WorstCase = 0
	}
	
	// Add assumptions
	forecast.Assumptions = []string{
		fmt.Sprintf("Based on %d data points", len(data)),
		fmt.Sprintf("Assumes %.1f%% volatility", volatility*100),
		"Difficulty remains relatively stable",
		"Exchange rates follow current trends",
	}
	
	return forecast
}

// calculateRiskScore calculates risk score for a currency
func (pa *ProfitAnalyzer) calculateRiskScore(currency string, metric *ProfitMetric) float64 {
	riskScore := 0.0
	
	// Volatility risk
	volatilityRisk := metric.Volatility / pa.config.VolatilityThreshold
	if volatilityRisk > 1.0 {
		volatilityRisk = 1.0
	}
	riskScore += volatilityRisk * 0.3
	
	// Profit margin risk
	marginRisk := 0.0
	if metric.ProfitMargin < 10 {
		marginRisk = 1.0 - (metric.ProfitMargin / 10)
	}
	riskScore += marginRisk * 0.3
	
	// Market trend risk
	pa.trendsMu.RLock()
	if trend, exists := pa.marketTrends[currency]; exists {
		if trend.TrendDirection == "down" {
			riskScore += trend.TrendStrength * 0.2
		}
	}
	pa.trendsMu.RUnlock()
	
	// Historical consistency risk
	pa.dataMu.RLock()
	if data := pa.historicalData[currency]; len(data) > 0 {
		profits := make([]float64, len(data))
		for i, point := range data {
			profits[i] = point.Profit
		}
		cv := pa.coefficientOfVariation(profits)
		consistencyRisk := cv / 0.5 // 0.5 is threshold
		if consistencyRisk > 1.0 {
			consistencyRisk = 1.0
		}
		riskScore += consistencyRisk * 0.2
	}
	pa.dataMu.RUnlock()
	
	return riskScore
}

// identifyRiskFactors identifies specific risk factors
func (pa *ProfitAnalyzer) identifyRiskFactors(currency string, metric *ProfitMetric) []string {
	factors := []string{}
	
	if metric.Volatility > pa.config.VolatilityThreshold {
		factors = append(factors, fmt.Sprintf("High volatility (%.1f%%)", metric.Volatility*100))
	}
	
	if metric.ProfitMargin < 10 {
		factors = append(factors, fmt.Sprintf("Low profit margin (%.1f%%)", metric.ProfitMargin))
	}
	
	pa.trendsMu.RLock()
	if trend, exists := pa.marketTrends[currency]; exists {
		if trend.TrendDirection == "down" {
			factors = append(factors, fmt.Sprintf("Downward trend (strength: %.1f)", trend.TrendStrength))
		}
		if trend.Momentum < -0.5 {
			factors = append(factors, "Negative momentum")
		}
	}
	pa.trendsMu.RUnlock()
	
	// Check for difficulty spikes
	pa.dataMu.RLock()
	if data := pa.historicalData[currency]; len(data) > 10 {
		recent := data[len(data)-10:]
		difficultyChange := (recent[len(recent)-1].Difficulty - recent[0].Difficulty) / recent[0].Difficulty
		if difficultyChange > 0.1 {
			factors = append(factors, fmt.Sprintf("Rapid difficulty increase (%.1f%%)", difficultyChange*100))
		}
	}
	pa.dataMu.RUnlock()
	
	return factors
}

// generateRecommendations generates actionable recommendations
func (pa *ProfitAnalyzer) generateRecommendations(report *ProfitabilityReport, metric *ProfitMetric) []Recommendation {
	recommendations := []Recommendation{}
	
	// Risk-based recommendations
	if report.RiskScore > pa.config.MaxRiskTolerance {
		recommendations = append(recommendations, Recommendation{
			Type:           "warning",
			Priority:       "high",
			Action:         "Consider switching to lower-risk currency",
			Reason:         fmt.Sprintf("Risk score (%.2f) exceeds tolerance", report.RiskScore),
			ExpectedImpact: -report.RiskScore * 100,
			Confidence:     0.8,
		})
	}
	
	// Trend-based recommendations
	if report.Trend != nil {
		if report.Trend.TrendDirection == "down" && report.Trend.TrendStrength > 0.7 {
			recommendations = append(recommendations, Recommendation{
				Type:           "switch",
				Priority:       "high",
				Action:         "Switch to more profitable currency",
				Reason:         "Strong downward trend detected",
				ExpectedImpact: -report.Trend.TrendStrength * 50,
				Confidence:     report.Trend.TrendStrength,
			})
		} else if report.Trend.TrendDirection == "up" && report.Trend.TrendStrength > 0.7 {
			recommendations = append(recommendations, Recommendation{
				Type:           "hold",
				Priority:       "medium",
				Action:         "Continue mining current currency",
				Reason:         "Strong upward trend detected",
				ExpectedImpact: report.Trend.TrendStrength * 30,
				Confidence:     report.Trend.TrendStrength,
			})
		}
	}
	
	// Optimization recommendations
	if metric.ProfitMargin > 0 && metric.ProfitMargin < 20 {
		recommendations = append(recommendations, Recommendation{
			Type:           "optimize",
			Priority:       "medium",
			Action:         "Optimize power consumption",
			Reason:         "Low profit margin detected",
			ExpectedImpact: 10,
			Confidence:     0.7,
		})
	}
	
	// Forecast-based recommendations
	if report.TrendForecast != nil {
		if report.TrendForecast.WorstCase < 0 {
			recommendations = append(recommendations, Recommendation{
				Type:           "warning",
				Priority:       "high",
				Action:         "Prepare for potential losses",
				Reason:         "Forecast shows potential negative profit",
				ExpectedImpact: report.TrendForecast.WorstCase,
				Confidence:     report.TrendForecast.Confidence,
			})
		}
	}
	
	// Sort by priority
	sort.Slice(recommendations, func(i, j int) bool {
		priority := map[string]int{"high": 3, "medium": 2, "low": 1}
		return priority[recommendations[i].Priority] > priority[recommendations[j].Priority]
	})
	
	return recommendations
}

// findBetterOptions finds better alternative currencies
func (pa *ProfitAnalyzer) findBetterOptions(currentCurrency string, currentMetric *ProfitMetric) []AlternativeOption {
	// This would integrate with the profit switcher to get all metrics
	// For now, return empty
	return []AlternativeOption{}
}

// updateTrendAnalysis updates trend analysis for a currency
func (pa *ProfitAnalyzer) updateTrendAnalysis(currency string) {
	pa.dataMu.RLock()
	data := pa.historicalData[currency]
	pa.dataMu.RUnlock()
	
	if len(data) < pa.config.MinDataPoints {
		return
	}
	
	trend := &MarketTrend{
		Currency:   currency,
		LastUpdate: time.Now(),
	}
	
	// Calculate trend direction and strength
	trendValue := pa.calculateTrend(data)
	if trendValue > pa.config.TrendSensitivity {
		trend.TrendDirection = "up"
		trend.TrendStrength = math.Min(trendValue/0.1, 1.0)
	} else if trendValue < -pa.config.TrendSensitivity {
		trend.TrendDirection = "down"
		trend.TrendStrength = math.Min(-trendValue/0.1, 1.0)
	} else {
		trend.TrendDirection = "stable"
		trend.TrendStrength = 0.1
	}
	
	// Calculate momentum
	trend.Momentum = pa.calculateMomentum(data)
	
	// Calculate support and resistance
	trend.Support, trend.Resistance = pa.calculateSupportResistance(data)
	
	// Calculate volatility
	trend.Volatility = pa.calculateVolatility(data)
	
	pa.trendsMu.Lock()
	pa.marketTrends[currency] = trend
	pa.trendsMu.Unlock()
}

// Statistical helper methods

func (pa *ProfitAnalyzer) mean(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func (pa *ProfitAnalyzer) max(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	max := values[0]
	for _, v := range values[1:] {
		if v > max {
			max = v
		}
	}
	return max
}

func (pa *ProfitAnalyzer) min(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	min := values[0]
	for _, v := range values[1:] {
		if v < min {
			min = v
		}
	}
	return min
}

func (pa *ProfitAnalyzer) stdDev(values []float64) float64 {
	if len(values) < 2 {
		return 0
	}
	mean := pa.mean(values)
	sumSquares := 0.0
	for _, v := range values {
		sumSquares += math.Pow(v-mean, 2)
	}
	return math.Sqrt(sumSquares / float64(len(values)-1))
}

func (pa *ProfitAnalyzer) coefficientOfVariation(values []float64) float64 {
	mean := pa.mean(values)
	if mean == 0 {
		return 0
	}
	return pa.stdDev(values) / mean
}

func (pa *ProfitAnalyzer) calculateTrend(data []*HistoricalDataPoint) float64 {
	if len(data) < 2 {
		return 0
	}
	
	// Simple linear regression
	n := float64(len(data))
	sumX, sumY, sumXY, sumX2 := 0.0, 0.0, 0.0, 0.0
	
	for i, point := range data {
		x := float64(i)
		y := point.Profit
		sumX += x
		sumY += y
		sumXY += x * y
		sumX2 += x * x
	}
	
	// Calculate slope
	slope := (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX)
	
	return slope
}

func (pa *ProfitAnalyzer) calculateMomentum(data []*HistoricalDataPoint) float64 {
	if len(data) < 10 {
		return 0
	}
	
	// Rate of change over last 10 periods
	current := data[len(data)-1].Profit
	past := data[len(data)-10].Profit
	
	if past == 0 {
		return 0
	}
	
	return (current - past) / past
}

func (pa *ProfitAnalyzer) calculateSupportResistance(data []*HistoricalDataPoint) (float64, float64) {
	if len(data) == 0 {
		return 0, 0
	}
	
	profits := make([]float64, len(data))
	for i, point := range data {
		profits[i] = point.Profit
	}
	
	// Simple approach: use recent min/max
	recentData := profits
	if len(profits) > 100 {
		recentData = profits[len(profits)-100:]
	}
	
	support := pa.min(recentData)
	resistance := pa.max(recentData)
	
	return support, resistance
}

func (pa *ProfitAnalyzer) calculateVolatility(data []*HistoricalDataPoint) float64 {
	if len(data) < 2 {
		return 0
	}
	
	// Calculate returns
	returns := make([]float64, len(data)-1)
	for i := 1; i < len(data); i++ {
		if data[i-1].Profit != 0 {
			returns[i-1] = (data[i].Profit - data[i-1].Profit) / data[i-1].Profit
		}
	}
	
	// Return standard deviation of returns
	return pa.stdDev(returns)
}

// GetMarketTrends returns current market trends
func (pa *ProfitAnalyzer) GetMarketTrends() map[string]*MarketTrend {
	pa.trendsMu.RLock()
	defer pa.trendsMu.RUnlock()
	
	trends := make(map[string]*MarketTrend)
	for k, v := range pa.marketTrends {
		trends[k] = v
	}
	
	return trends
}

// GetHistoricalSummary returns historical data summary
func (pa *ProfitAnalyzer) GetHistoricalSummary(currency string) map[string]interface{} {
	pa.dataMu.RLock()
	defer pa.dataMu.RUnlock()
	
	data := pa.historicalData[currency]
	if len(data) == 0 {
		return nil
	}
	
	profits := make([]float64, len(data))
	for i, point := range data {
		profits[i] = point.Profit
	}
	
	return map[string]interface{}{
		"data_points":    len(data),
		"period_start":   data[0].Timestamp,
		"period_end":     data[len(data)-1].Timestamp,
		"average_profit": pa.mean(profits),
		"max_profit":     pa.max(profits),
		"min_profit":     pa.min(profits),
		"std_deviation":  pa.stdDev(profits),
		"volatility":     pa.calculateVolatility(data),
	}
}