package optimization

import (
	"context"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// PredictiveScaler implements automated resource pre-scaling based on patterns
// Following John Carmack's principle: "The best optimization is when the game doesn't have to do something"
type PredictiveScaler struct {
	logger *zap.Logger
	config *ScalerConfig
	
	// Pattern recognition
	patternAnalyzer  *PatternAnalyzer
	usagePredictor   *UsagePredictor
	
	// Resource monitoring
	resourceMonitor  *ResourceMonitor
	
	// Scaling engines
	cpuScaler        *CPUScaler
	memoryScaler     *MemoryScaler
	networkScaler    *NetworkScaler
	storageScaler    *StorageScaler
	
	// Historical data
	historicalData   *HistoricalDataStore
	
	// Scaling decisions
	scalingDecisions *ScalingDecisionEngine
	
	// Metrics
	metrics          *ScalerMetrics
	
	// Lifecycle
	ctx              context.Context
	cancel           context.CancelFunc
	wg               sync.WaitGroup
}

// ScalerConfig contains predictive scaler configuration
type ScalerConfig struct {
	// Prediction settings
	PredictionWindow      time.Duration
	PredictionInterval    time.Duration
	ConfidenceThreshold   float64
	
	// Pattern detection
	PatternWindowDays     int
	MinPatternOccurrences int
	SeasonalityEnabled    bool
	
	// Scaling thresholds
	CPUScaleUpThreshold   float64
	CPUScaleDownThreshold float64
	MemScaleUpThreshold   float64
	MemScaleDownThreshold float64
	
	// Pre-scaling settings
	PreScaleMinutes       int
	ScaleCooldown         time.Duration
	MaxScaleRatio         float64
	MinScaleRatio         float64
	
	// Resource limits
	MaxCPUCores           int
	MaxMemoryGB           int
	MaxNetworkMbps        int
	MaxStorageGB          int
	
	// Cost optimization
	CostAware             bool
	MaxHourlyCost         float64
}

// PatternAnalyzer analyzes usage patterns
type PatternAnalyzer struct {
	patterns        map[PatternType]*Pattern
	patternsMu      sync.RWMutex
	windowDays      int
	minOccurrences  int
}

// Pattern represents a detected usage pattern
type Pattern struct {
	Type            PatternType
	TimeOfDay       []time.Duration // Times when pattern occurs
	DaysOfWeek      []time.Weekday
	Intensity       float64
	Duration        time.Duration
	Confidence      float64
	Occurrences     int
	LastSeen        time.Time
	PredictedNext   time.Time
}

// PatternType represents types of patterns
type PatternType string

const (
	PatternDaily     PatternType = "daily"
	PatternWeekly    PatternType = "weekly"
	PatternMonthly   PatternType = "monthly"
	PatternEvent     PatternType = "event"
	PatternAnomaly   PatternType = "anomaly"
)

// UsagePredictor predicts future resource usage
type UsagePredictor struct {
	models          map[ResourceType]*PredictionModel
	modelsMu        sync.RWMutex
	confidence      float64
}

// PredictionModel represents a prediction model
type PredictionModel struct {
	ResourceType    ResourceType
	TimeSeriesData  []TimeSeriesPoint
	Coefficients    []float64
	Seasonality     *SeasonalityModel
	Accuracy        float64
	LastTrained     time.Time
}

// ResourceType represents types of resources
type ResourceType string

const (
	ResourceCPU     ResourceType = "cpu"
	ResourceMemory  ResourceType = "memory"
	ResourceNetwork ResourceType = "network"
	ResourceStorage ResourceType = "storage"
)

// ScalerMetrics tracks scaler performance
type ScalerMetrics struct {
	Predictions         atomic.Uint64
	AccuratePredictions atomic.Uint64
	ScaleUpEvents       atomic.Uint64
	ScaleDownEvents     atomic.Uint64
	PreScaleSuccess     atomic.Uint64
	CostSavings         atomic.Uint64 // Cents
	AvgPredictionError  atomic.Uint64 // Percentage * 100
}

// NewPredictiveScaler creates a new predictive scaler
func NewPredictiveScaler(logger *zap.Logger, config *ScalerConfig) (*PredictiveScaler, error) {
	if config == nil {
		config = DefaultScalerConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	ps := &PredictiveScaler{
		logger:           logger,
		config:           config,
		patternAnalyzer:  NewPatternAnalyzer(config),
		usagePredictor:   NewUsagePredictor(config),
		resourceMonitor:  NewResourceMonitor(logger),
		cpuScaler:        NewCPUScaler(logger, config),
		memoryScaler:     NewMemoryScaler(logger, config),
		networkScaler:    NewNetworkScaler(logger, config),
		storageScaler:    NewStorageScaler(logger, config),
		historicalData:   NewHistoricalDataStore(),
		scalingDecisions: NewScalingDecisionEngine(logger, config),
		metrics:          &ScalerMetrics{},
		ctx:              ctx,
		cancel:           cancel,
	}
	
	return ps, nil
}

// Start starts the predictive scaler
func (ps *PredictiveScaler) Start() error {
	ps.logger.Info("Starting predictive scaler",
		zap.Duration("prediction_window", ps.config.PredictionWindow),
		zap.Int("pre_scale_minutes", ps.config.PreScaleMinutes),
		zap.Bool("cost_aware", ps.config.CostAware),
	)
	
	// Load historical data
	if err := ps.historicalData.Load(); err != nil {
		ps.logger.Warn("Failed to load historical data", zap.Error(err))
	}
	
	// Start background workers
	ps.wg.Add(1)
	go ps.monitoringLoop()
	
	ps.wg.Add(1)
	go ps.predictionLoop()
	
	ps.wg.Add(1)
	go ps.scalingLoop()
	
	ps.wg.Add(1)
	go ps.patternDetectionLoop()
	
	return nil
}

// Stop stops the predictive scaler
func (ps *PredictiveScaler) Stop() error {
	ps.logger.Info("Stopping predictive scaler")
	
	// Save historical data
	if err := ps.historicalData.Save(); err != nil {
		ps.logger.Error("Failed to save historical data", zap.Error(err))
	}
	
	ps.cancel()
	ps.wg.Wait()
	
	return nil
}

// PredictUsage predicts resource usage for a future time
func (ps *PredictiveScaler) PredictUsage(resourceType ResourceType, targetTime time.Time) (*UsagePrediction, error) {
	// Get relevant patterns
	patterns := ps.patternAnalyzer.GetPatternsForTime(targetTime)
	
	// Get base prediction from model
	basePrediction := ps.usagePredictor.Predict(resourceType, targetTime)
	
	// Adjust for patterns
	adjustedValue := basePrediction.Value
	for _, pattern := range patterns {
		if ps.isPatternRelevant(pattern, resourceType, targetTime) {
			adjustedValue *= (1 + pattern.Intensity)
		}
	}
	
	// Apply bounds
	adjustedValue = ps.applyResourceBounds(resourceType, adjustedValue)
	
	prediction := &UsagePrediction{
		ResourceType: resourceType,
		Timestamp:    targetTime,
		Value:        adjustedValue,
		Confidence:   basePrediction.Confidence,
		LowerBound:   adjustedValue * 0.8,
		UpperBound:   adjustedValue * 1.2,
	}
	
	ps.metrics.Predictions.Add(1)
	
	return prediction, nil
}

// GetMetrics returns current metrics
func (ps *PredictiveScaler) GetMetrics() ScalerStats {
	totalPredictions := ps.metrics.Predictions.Load()
	accuratePredictions := ps.metrics.AccuratePredictions.Load()
	
	accuracy := float64(0)
	if totalPredictions > 0 {
		accuracy = float64(accuratePredictions) / float64(totalPredictions)
	}
	
	return ScalerStats{
		TotalPredictions:    totalPredictions,
		PredictionAccuracy:  accuracy,
		ScaleUpEvents:       ps.metrics.ScaleUpEvents.Load(),
		ScaleDownEvents:     ps.metrics.ScaleDownEvents.Load(),
		PreScaleSuccess:     ps.metrics.PreScaleSuccess.Load(),
		CostSavings:         float64(ps.metrics.CostSavings.Load()) / 100.0,
		AvgPredictionError:  float64(ps.metrics.AvgPredictionError.Load()) / 100.0,
		DetectedPatterns:    ps.patternAnalyzer.GetPatternCount(),
	}
}

// Private methods

func (ps *PredictiveScaler) monitoringLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ps.collectResourceMetrics()
			
		case <-ps.ctx.Done():
			return
		}
	}
}

func (ps *PredictiveScaler) predictionLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(ps.config.PredictionInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ps.generatePredictions()
			
		case <-ps.ctx.Done():
			return
		}
	}
}

func (ps *PredictiveScaler) scalingLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ps.evaluateScalingDecisions()
			
		case <-ps.ctx.Done():
			return
		}
	}
}

func (ps *PredictiveScaler) patternDetectionLoop() {
	defer ps.wg.Done()
	
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ps.detectPatterns()
			
		case <-ps.ctx.Done():
			return
		}
	}
}

func (ps *PredictiveScaler) collectResourceMetrics() {
	// Collect current resource usage
	cpuUsage := ps.resourceMonitor.GetCPUUsage()
	memUsage := ps.resourceMonitor.GetMemoryUsage()
	netUsage := ps.resourceMonitor.GetNetworkUsage()
	storageUsage := ps.resourceMonitor.GetStorageUsage()
	
	// Store in historical data
	now := time.Now()
	ps.historicalData.Add(ResourceCPU, now, cpuUsage)
	ps.historicalData.Add(ResourceMemory, now, memUsage)
	ps.historicalData.Add(ResourceNetwork, now, netUsage)
	ps.historicalData.Add(ResourceStorage, now, storageUsage)
	
	// Update prediction models
	ps.usagePredictor.UpdateModels(ps.historicalData)
}

func (ps *PredictiveScaler) generatePredictions() {
	now := time.Now()
	predictionTime := now.Add(time.Duration(ps.config.PreScaleMinutes) * time.Minute)
	
	// Generate predictions for each resource type
	for _, resourceType := range []ResourceType{ResourceCPU, ResourceMemory, ResourceNetwork, ResourceStorage} {
		prediction, err := ps.PredictUsage(resourceType, predictionTime)
		if err != nil {
			ps.logger.Error("Failed to generate prediction",
				zap.String("resource", string(resourceType)),
				zap.Error(err),
			)
			continue
		}
		
		// Store prediction for evaluation
		ps.scalingDecisions.AddPrediction(prediction)
		
		// Check if pre-scaling needed
		if ps.shouldPreScale(resourceType, prediction) {
			ps.logger.Info("Pre-scaling triggered",
				zap.String("resource", string(resourceType)),
				zap.Float64("predicted_usage", prediction.Value),
				zap.Time("target_time", predictionTime),
			)
		}
	}
}

func (ps *PredictiveScaler) evaluateScalingDecisions() {
	decisions := ps.scalingDecisions.GetPendingDecisions()
	
	for _, decision := range decisions {
		if decision.ShouldExecute(time.Now()) {
			ps.executeScaling(decision)
		}
	}
	
	// Evaluate past predictions
	ps.evaluatePredictionAccuracy()
}

func (ps *PredictiveScaler) detectPatterns() {
	// Get historical data for pattern analysis
	data := ps.historicalData.GetRange(time.Now().AddDate(0, 0, -ps.config.PatternWindowDays), time.Now())
	
	// Detect different types of patterns
	dailyPatterns := ps.detectDailyPatterns(data)
	weeklyPatterns := ps.detectWeeklyPatterns(data)
	
	// Update pattern analyzer
	for _, pattern := range dailyPatterns {
		ps.patternAnalyzer.AddPattern(pattern)
	}
	
	for _, pattern := range weeklyPatterns {
		ps.patternAnalyzer.AddPattern(pattern)
	}
	
	ps.logger.Info("Pattern detection completed",
		zap.Int("daily_patterns", len(dailyPatterns)),
		zap.Int("weekly_patterns", len(weeklyPatterns)),
	)
}

func (ps *PredictiveScaler) detectDailyPatterns(data map[ResourceType][]TimeSeriesPoint) []*Pattern {
	patterns := make([]*Pattern, 0)
	
	for resourceType, points := range data {
		// Group by hour of day
		hourlyAverages := make(map[int][]float64)
		
		for _, point := range points {
			hour := point.Timestamp.Hour()
			hourlyAverages[hour] = append(hourlyAverages[hour], point.Value)
		}
		
		// Find significant deviations
		for hour, values := range hourlyAverages {
			if len(values) >= ps.config.MinPatternOccurrences {
				avg := calculateAverage(values)
				stdDev := calculateStdDev(values)
				
				// Pattern detected if consistent high usage
				if stdDev/avg < 0.3 && avg > ps.getBaselineUsage(resourceType)*1.5 {
					pattern := &Pattern{
						Type:        PatternDaily,
						TimeOfDay:   []time.Duration{time.Duration(hour) * time.Hour},
						Intensity:   (avg - ps.getBaselineUsage(resourceType)) / ps.getBaselineUsage(resourceType),
						Duration:    1 * time.Hour,
						Confidence:  1 - (stdDev / avg),
						Occurrences: len(values),
						LastSeen:    time.Now(),
					}
					patterns = append(patterns, pattern)
				}
			}
		}
	}
	
	return patterns
}

func (ps *PredictiveScaler) detectWeeklyPatterns(data map[ResourceType][]TimeSeriesPoint) []*Pattern {
	patterns := make([]*Pattern, 0)
	
	for resourceType, points := range data {
		// Group by day of week and hour
		weeklyData := make(map[time.Weekday]map[int][]float64)
		
		for _, point := range points {
			weekday := point.Timestamp.Weekday()
			hour := point.Timestamp.Hour()
			
			if weeklyData[weekday] == nil {
				weeklyData[weekday] = make(map[int][]float64)
			}
			
			weeklyData[weekday][hour] = append(weeklyData[weekday][hour], point.Value)
		}
		
		// Find weekly patterns
		for weekday, hourlyData := range weeklyData {
			for hour, values := range hourlyData {
				if len(values) >= ps.config.MinPatternOccurrences/7 {
					avg := calculateAverage(values)
					stdDev := calculateStdDev(values)
					
					if stdDev/avg < 0.3 && avg > ps.getBaselineUsage(resourceType)*1.5 {
						pattern := &Pattern{
							Type:        PatternWeekly,
							TimeOfDay:   []time.Duration{time.Duration(hour) * time.Hour},
							DaysOfWeek:  []time.Weekday{weekday},
							Intensity:   (avg - ps.getBaselineUsage(resourceType)) / ps.getBaselineUsage(resourceType),
							Duration:    1 * time.Hour,
							Confidence:  1 - (stdDev / avg),
							Occurrences: len(values),
							LastSeen:    time.Now(),
						}
						patterns = append(patterns, pattern)
					}
				}
			}
		}
	}
	
	return patterns
}

func (ps *PredictiveScaler) shouldPreScale(resourceType ResourceType, prediction *UsagePrediction) bool {
	// Check confidence threshold
	if prediction.Confidence < ps.config.ConfidenceThreshold {
		return false
	}
	
	// Check scaling thresholds
	switch resourceType {
	case ResourceCPU:
		return prediction.Value > ps.config.CPUScaleUpThreshold
	case ResourceMemory:
		return prediction.Value > ps.config.MemScaleUpThreshold
	default:
		return false
	}
}

func (ps *PredictiveScaler) executeScaling(decision *ScalingDecision) {
	ps.logger.Info("Executing scaling decision",
		zap.String("resource", string(decision.ResourceType)),
		zap.String("action", string(decision.Action)),
		zap.Float64("scale_factor", decision.ScaleFactor),
	)
	
	var err error
	switch decision.ResourceType {
	case ResourceCPU:
		err = ps.cpuScaler.Scale(decision.ScaleFactor)
	case ResourceMemory:
		err = ps.memoryScaler.Scale(decision.ScaleFactor)
	case ResourceNetwork:
		err = ps.networkScaler.Scale(decision.ScaleFactor)
	case ResourceStorage:
		err = ps.storageScaler.Scale(decision.ScaleFactor)
	}
	
	if err != nil {
		ps.logger.Error("Scaling failed",
			zap.String("resource", string(decision.ResourceType)),
			zap.Error(err),
		)
	} else {
		if decision.Action == ScaleUp {
			ps.metrics.ScaleUpEvents.Add(1)
		} else {
			ps.metrics.ScaleDownEvents.Add(1)
		}
		
		// Calculate cost impact
		if ps.config.CostAware {
			costImpact := ps.calculateCostImpact(decision)
			if costImpact < 0 {
				ps.metrics.CostSavings.Add(uint64(-costImpact * 100))
			}
		}
	}
	
	decision.Executed = true
	decision.ExecutedAt = time.Now()
}

func (ps *PredictiveScaler) evaluatePredictionAccuracy() {
	// Get predictions made PreScaleMinutes ago
	evaluationTime := time.Now().Add(-time.Duration(ps.config.PreScaleMinutes) * time.Minute)
	predictions := ps.scalingDecisions.GetPredictionsForTime(evaluationTime)
	
	for _, prediction := range predictions {
		actualUsage := ps.historicalData.GetValue(prediction.ResourceType, prediction.Timestamp)
		if actualUsage > 0 {
			error := math.Abs(prediction.Value-actualUsage) / actualUsage
			
			if error < 0.2 { // Within 20% is considered accurate
				ps.metrics.AccuratePredictions.Add(1)
			}
			
			// Update average error
			currentAvg := ps.metrics.AvgPredictionError.Load()
			newAvg := (currentAvg*9 + uint64(error*100)) / 10
			ps.metrics.AvgPredictionError.Store(newAvg)
		}
	}
}

func (ps *PredictiveScaler) isPatternRelevant(pattern *Pattern, resourceType ResourceType, targetTime time.Time) bool {
	// Check if pattern applies to target time
	targetHour := targetTime.Hour()
	targetWeekday := targetTime.Weekday()
	
	switch pattern.Type {
	case PatternDaily:
		for _, tod := range pattern.TimeOfDay {
			if int(tod.Hours()) == targetHour {
				return true
			}
		}
	case PatternWeekly:
		for _, dow := range pattern.DaysOfWeek {
			if dow == targetWeekday {
				for _, tod := range pattern.TimeOfDay {
					if int(tod.Hours()) == targetHour {
						return true
					}
				}
			}
		}
	}
	
	return false
}

func (ps *PredictiveScaler) applyResourceBounds(resourceType ResourceType, value float64) float64 {
	switch resourceType {
	case ResourceCPU:
		return math.Min(value, float64(ps.config.MaxCPUCores))
	case ResourceMemory:
		return math.Min(value, float64(ps.config.MaxMemoryGB))
	case ResourceNetwork:
		return math.Min(value, float64(ps.config.MaxNetworkMbps))
	case ResourceStorage:
		return math.Min(value, float64(ps.config.MaxStorageGB))
	}
	return value
}

func (ps *PredictiveScaler) getBaselineUsage(resourceType ResourceType) float64 {
	// Get average usage over past week
	data := ps.historicalData.GetRange(
		time.Now().AddDate(0, 0, -7),
		time.Now(),
	)
	
	if points, exists := data[resourceType]; exists && len(points) > 0 {
		total := 0.0
		for _, point := range points {
			total += point.Value
		}
		return total / float64(len(points))
	}
	
	// Default baselines
	switch resourceType {
	case ResourceCPU:
		return 2.0 // 2 cores
	case ResourceMemory:
		return 4.0 // 4 GB
	case ResourceNetwork:
		return 100.0 // 100 Mbps
	case ResourceStorage:
		return 50.0 // 50 GB
	}
	
	return 1.0
}

func (ps *PredictiveScaler) calculateCostImpact(decision *ScalingDecision) float64 {
	// Simplified cost calculation
	baseCost := 0.0
	
	switch decision.ResourceType {
	case ResourceCPU:
		baseCost = 0.05 // $0.05 per core per hour
	case ResourceMemory:
		baseCost = 0.01 // $0.01 per GB per hour
	case ResourceNetwork:
		baseCost = 0.001 // $0.001 per Mbps per hour
	case ResourceStorage:
		baseCost = 0.0001 // $0.0001 per GB per hour
	}
	
	if decision.Action == ScaleUp {
		return baseCost * decision.ScaleFactor
	}
	
	return -baseCost * (1 - decision.ScaleFactor)
}

// Helper components

// PatternAnalyzer implementation
func NewPatternAnalyzer(config *ScalerConfig) *PatternAnalyzer {
	return &PatternAnalyzer{
		patterns:       make(map[PatternType]*Pattern),
		windowDays:     config.PatternWindowDays,
		minOccurrences: config.MinPatternOccurrences,
	}
}

func (pa *PatternAnalyzer) AddPattern(pattern *Pattern) {
	pa.patternsMu.Lock()
	defer pa.patternsMu.Unlock()
	
	// Update or add pattern
	if existing, exists := pa.patterns[pattern.Type]; exists {
		// Merge patterns
		existing.Occurrences += pattern.Occurrences
		existing.LastSeen = pattern.LastSeen
		existing.Confidence = (existing.Confidence + pattern.Confidence) / 2
	} else {
		pa.patterns[pattern.Type] = pattern
	}
}

func (pa *PatternAnalyzer) GetPatternsForTime(targetTime time.Time) []*Pattern {
	pa.patternsMu.RLock()
	defer pa.patternsMu.RUnlock()
	
	relevantPatterns := make([]*Pattern, 0)
	for _, pattern := range pa.patterns {
		// Check if pattern is still valid
		if time.Since(pattern.LastSeen) < 7*24*time.Hour {
			relevantPatterns = append(relevantPatterns, pattern)
		}
	}
	
	return relevantPatterns
}

func (pa *PatternAnalyzer) GetPatternCount() int {
	pa.patternsMu.RLock()
	defer pa.patternsMu.RUnlock()
	return len(pa.patterns)
}

// UsagePredictor implementation
func NewUsagePredictor(config *ScalerConfig) *UsagePredictor {
	return &UsagePredictor{
		models:     make(map[ResourceType]*PredictionModel),
		confidence: config.ConfidenceThreshold,
	}
}

func (up *UsagePredictor) Predict(resourceType ResourceType, targetTime time.Time) *UsagePrediction {
	up.modelsMu.RLock()
	model, exists := up.models[resourceType]
	up.modelsMu.RUnlock()
	
	if !exists || model == nil {
		// Return default prediction
		return &UsagePrediction{
			ResourceType: resourceType,
			Timestamp:    targetTime,
			Value:        1.0,
			Confidence:   0.5,
		}
	}
	
	// Simple linear prediction with seasonality
	baseValue := up.calculateTrend(model, targetTime)
	seasonalAdjustment := up.calculateSeasonality(model, targetTime)
	
	predictedValue := baseValue * seasonalAdjustment
	
	return &UsagePrediction{
		ResourceType: resourceType,
		Timestamp:    targetTime,
		Value:        predictedValue,
		Confidence:   model.Accuracy,
	}
}

func (up *UsagePredictor) UpdateModels(historicalData *HistoricalDataStore) {
	for _, resourceType := range []ResourceType{ResourceCPU, ResourceMemory, ResourceNetwork, ResourceStorage} {
		data := historicalData.GetRecent(resourceType, 168) // Last week
		if len(data) < 24 { // Need at least 24 hours of data
			continue
		}
		
		model := up.trainModel(resourceType, data)
		
		up.modelsMu.Lock()
		up.models[resourceType] = model
		up.modelsMu.Unlock()
	}
}

func (up *UsagePredictor) trainModel(resourceType ResourceType, data []TimeSeriesPoint) *PredictionModel {
	model := &PredictionModel{
		ResourceType:   resourceType,
		TimeSeriesData: data,
		LastTrained:    time.Now(),
	}
	
	// Calculate simple linear regression coefficients
	n := float64(len(data))
	sumX, sumY, sumXY, sumX2 := 0.0, 0.0, 0.0, 0.0
	
	for i, point := range data {
		x := float64(i)
		y := point.Value
		sumX += x
		sumY += y
		sumXY += x * y
		sumX2 += x * x
	}
	
	// Calculate slope and intercept
	slope := (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX)
	intercept := (sumY - slope*sumX) / n
	
	model.Coefficients = []float64{intercept, slope}
	
	// Calculate accuracy
	model.Accuracy = up.calculateModelAccuracy(model, data)
	
	// Train seasonality model
	model.Seasonality = up.trainSeasonalityModel(data)
	
	return model
}

func (up *UsagePredictor) calculateTrend(model *PredictionModel, targetTime time.Time) float64 {
	// Simple linear extrapolation
	if len(model.Coefficients) < 2 {
		return 1.0
	}
	
	// Calculate hours since model training
	hoursSinceTraining := targetTime.Sub(model.LastTrained).Hours()
	
	// Apply linear model
	return model.Coefficients[0] + model.Coefficients[1]*hoursSinceTraining
}

func (up *UsagePredictor) calculateSeasonality(model *PredictionModel, targetTime time.Time) float64 {
	if model.Seasonality == nil {
		return 1.0
	}
	
	// Get hour of day and day of week factors
	hour := targetTime.Hour()
	weekday := targetTime.Weekday()
	
	hourFactor := model.Seasonality.HourlyFactors[hour]
	weekdayFactor := model.Seasonality.WeekdayFactors[weekday]
	
	return hourFactor * weekdayFactor
}

func (up *UsagePredictor) calculateModelAccuracy(model *PredictionModel, data []TimeSeriesPoint) float64 {
	if len(data) < 2 {
		return 0.5
	}
	
	// Calculate mean absolute percentage error
	totalError := 0.0
	count := 0
	
	for i := 1; i < len(data); i++ {
		predicted := model.Coefficients[0] + model.Coefficients[1]*float64(i)
		actual := data[i].Value
		
		if actual > 0 {
			error := math.Abs(predicted-actual) / actual
			totalError += error
			count++
		}
	}
	
	if count == 0 {
		return 0.5
	}
	
	mape := totalError / float64(count)
	return math.Max(0, 1-mape)
}

func (up *UsagePredictor) trainSeasonalityModel(data []TimeSeriesPoint) *SeasonalityModel {
	model := &SeasonalityModel{
		HourlyFactors:  make([]float64, 24),
		WeekdayFactors: make([]float64, 7),
	}
	
	// Calculate average for each hour and weekday
	hourlyTotals := make([]float64, 24)
	hourlyCounts := make([]int, 24)
	weekdayTotals := make([]float64, 7)
	weekdayCounts := make([]int, 7)
	
	overallAvg := 0.0
	for _, point := range data {
		hour := point.Timestamp.Hour()
		weekday := point.Timestamp.Weekday()
		
		hourlyTotals[hour] += point.Value
		hourlyCounts[hour]++
		weekdayTotals[weekday] += point.Value
		weekdayCounts[weekday]++
		overallAvg += point.Value
	}
	
	if len(data) > 0 {
		overallAvg /= float64(len(data))
	}
	
	// Calculate factors
	for i := 0; i < 24; i++ {
		if hourlyCounts[i] > 0 && overallAvg > 0 {
			model.HourlyFactors[i] = (hourlyTotals[i] / float64(hourlyCounts[i])) / overallAvg
		} else {
			model.HourlyFactors[i] = 1.0
		}
	}
	
	for i := 0; i < 7; i++ {
		if weekdayCounts[i] > 0 && overallAvg > 0 {
			model.WeekdayFactors[i] = (weekdayTotals[i] / float64(weekdayCounts[i])) / overallAvg
		} else {
			model.WeekdayFactors[i] = 1.0
		}
	}
	
	return model
}

// ResourceMonitor implementation
type ResourceMonitor struct {
	logger *zap.Logger
	// In production, would interface with actual system metrics
}

func NewResourceMonitor(logger *zap.Logger) *ResourceMonitor {
	return &ResourceMonitor{logger: logger}
}

func (rm *ResourceMonitor) GetCPUUsage() float64 {
	// Simulated CPU usage
	return 2.5 + math.Sin(float64(time.Now().Unix())/3600)*0.5
}

func (rm *ResourceMonitor) GetMemoryUsage() float64 {
	// Simulated memory usage in GB
	return 4.0 + math.Cos(float64(time.Now().Unix())/3600)*1.0
}

func (rm *ResourceMonitor) GetNetworkUsage() float64 {
	// Simulated network usage in Mbps
	return 100.0 + math.Sin(float64(time.Now().Unix())/1800)*20.0
}

func (rm *ResourceMonitor) GetStorageUsage() float64 {
	// Simulated storage usage in GB
	return 50.0 + float64(time.Now().Unix()%(3600*24))/3600
}

// Resource scalers
type CPUScaler struct {
	logger     *zap.Logger
	config     *ScalerConfig
	currentCPU atomic.Uint32
}

func NewCPUScaler(logger *zap.Logger, config *ScalerConfig) *CPUScaler {
	return &CPUScaler{
		logger: logger,
		config: config,
	}
}

func (cs *CPUScaler) Scale(factor float64) error {
	current := cs.currentCPU.Load()
	newValue := uint32(float64(current) * factor)
	
	if newValue > uint32(cs.config.MaxCPUCores) {
		newValue = uint32(cs.config.MaxCPUCores)
	}
	
	cs.currentCPU.Store(newValue)
	cs.logger.Info("CPU scaled",
		zap.Uint32("from", current),
		zap.Uint32("to", newValue),
	)
	
	return nil
}

type MemoryScaler struct {
	logger       *zap.Logger
	config       *ScalerConfig
	currentMemGB atomic.Uint32
}

func NewMemoryScaler(logger *zap.Logger, config *ScalerConfig) *MemoryScaler {
	return &MemoryScaler{
		logger: logger,
		config: config,
	}
}

func (ms *MemoryScaler) Scale(factor float64) error {
	current := ms.currentMemGB.Load()
	newValue := uint32(float64(current) * factor)
	
	if newValue > uint32(ms.config.MaxMemoryGB) {
		newValue = uint32(ms.config.MaxMemoryGB)
	}
	
	ms.currentMemGB.Store(newValue)
	ms.logger.Info("Memory scaled",
		zap.Uint32("from_gb", current),
		zap.Uint32("to_gb", newValue),
	)
	
	return nil
}

type NetworkScaler struct {
	logger         *zap.Logger
	config         *ScalerConfig
	currentBandwidth atomic.Uint32
}

func NewNetworkScaler(logger *zap.Logger, config *ScalerConfig) *NetworkScaler {
	return &NetworkScaler{
		logger: logger,
		config: config,
	}
}

func (ns *NetworkScaler) Scale(factor float64) error {
	current := ns.currentBandwidth.Load()
	newValue := uint32(float64(current) * factor)
	
	if newValue > uint32(ns.config.MaxNetworkMbps) {
		newValue = uint32(ns.config.MaxNetworkMbps)
	}
	
	ns.currentBandwidth.Store(newValue)
	ns.logger.Info("Network scaled",
		zap.Uint32("from_mbps", current),
		zap.Uint32("to_mbps", newValue),
	)
	
	return nil
}

type StorageScaler struct {
	logger        *zap.Logger
	config        *ScalerConfig
	currentStorage atomic.Uint32
}

func NewStorageScaler(logger *zap.Logger, config *ScalerConfig) *StorageScaler {
	return &StorageScaler{
		logger: logger,
		config: config,
	}
}

func (ss *StorageScaler) Scale(factor float64) error {
	current := ss.currentStorage.Load()
	newValue := uint32(float64(current) * factor)
	
	if newValue > uint32(ss.config.MaxStorageGB) {
		newValue = uint32(ss.config.MaxStorageGB)
	}
	
	ss.currentStorage.Store(newValue)
	ss.logger.Info("Storage scaled",
		zap.Uint32("from_gb", current),
		zap.Uint32("to_gb", newValue),
	)
	
	return nil
}

// HistoricalDataStore stores time series data
type HistoricalDataStore struct {
	data   map[ResourceType][]TimeSeriesPoint
	dataMu sync.RWMutex
}

func NewHistoricalDataStore() *HistoricalDataStore {
	return &HistoricalDataStore{
		data: make(map[ResourceType][]TimeSeriesPoint),
	}
}

func (hds *HistoricalDataStore) Add(resourceType ResourceType, timestamp time.Time, value float64) {
	hds.dataMu.Lock()
	defer hds.dataMu.Unlock()
	
	if hds.data[resourceType] == nil {
		hds.data[resourceType] = make([]TimeSeriesPoint, 0, 10000)
	}
	
	hds.data[resourceType] = append(hds.data[resourceType], TimeSeriesPoint{
		Timestamp: timestamp,
		Value:     value,
	})
	
	// Keep only recent data (1 month)
	cutoff := time.Now().AddDate(0, -1, 0)
	filtered := make([]TimeSeriesPoint, 0)
	for _, point := range hds.data[resourceType] {
		if point.Timestamp.After(cutoff) {
			filtered = append(filtered, point)
		}
	}
	hds.data[resourceType] = filtered
}

func (hds *HistoricalDataStore) GetRange(start, end time.Time) map[ResourceType][]TimeSeriesPoint {
	hds.dataMu.RLock()
	defer hds.dataMu.RUnlock()
	
	result := make(map[ResourceType][]TimeSeriesPoint)
	
	for resourceType, points := range hds.data {
		filtered := make([]TimeSeriesPoint, 0)
		for _, point := range points {
			if point.Timestamp.After(start) && point.Timestamp.Before(end) {
				filtered = append(filtered, point)
			}
		}
		result[resourceType] = filtered
	}
	
	return result
}

func (hds *HistoricalDataStore) GetRecent(resourceType ResourceType, hours int) []TimeSeriesPoint {
	hds.dataMu.RLock()
	defer hds.dataMu.RUnlock()
	
	cutoff := time.Now().Add(-time.Duration(hours) * time.Hour)
	filtered := make([]TimeSeriesPoint, 0)
	
	if points, exists := hds.data[resourceType]; exists {
		for _, point := range points {
			if point.Timestamp.After(cutoff) {
				filtered = append(filtered, point)
			}
		}
	}
	
	return filtered
}

func (hds *HistoricalDataStore) GetValue(resourceType ResourceType, timestamp time.Time) float64 {
	hds.dataMu.RLock()
	defer hds.dataMu.RUnlock()
	
	if points, exists := hds.data[resourceType]; exists {
		// Find closest point
		minDiff := time.Duration(math.MaxInt64)
		closestValue := 0.0
		
		for _, point := range points {
			diff := timestamp.Sub(point.Timestamp)
			if diff < 0 {
				diff = -diff
			}
			if diff < minDiff {
				minDiff = diff
				closestValue = point.Value
			}
		}
		
		if minDiff < 5*time.Minute {
			return closestValue
		}
	}
	
	return 0
}

func (hds *HistoricalDataStore) Load() error {
	// In production, would load from persistent storage
	return nil
}

func (hds *HistoricalDataStore) Save() error {
	// In production, would save to persistent storage
	return nil
}

// ScalingDecisionEngine manages scaling decisions
type ScalingDecisionEngine struct {
	logger        *zap.Logger
	config        *ScalerConfig
	decisions     []*ScalingDecision
	decisionsMu   sync.RWMutex
	predictions   []*UsagePrediction
	predictionsMu sync.RWMutex
}

func NewScalingDecisionEngine(logger *zap.Logger, config *ScalerConfig) *ScalingDecisionEngine {
	return &ScalingDecisionEngine{
		logger:      logger,
		config:      config,
		decisions:   make([]*ScalingDecision, 0),
		predictions: make([]*UsagePrediction, 0),
	}
}

func (sde *ScalingDecisionEngine) AddPrediction(prediction *UsagePrediction) {
	sde.predictionsMu.Lock()
	defer sde.predictionsMu.Unlock()
	
	sde.predictions = append(sde.predictions, prediction)
	
	// Create scaling decision if needed
	decision := sde.evaluatePrediction(prediction)
	if decision != nil {
		sde.decisionsMu.Lock()
		sde.decisions = append(sde.decisions, decision)
		sde.decisionsMu.Unlock()
	}
	
	// Cleanup old predictions
	cutoff := time.Now().Add(-24 * time.Hour)
	filtered := make([]*UsagePrediction, 0)
	for _, p := range sde.predictions {
		if p.Timestamp.After(cutoff) {
			filtered = append(filtered, p)
		}
	}
	sde.predictions = filtered
}

func (sde *ScalingDecisionEngine) GetPendingDecisions() []*ScalingDecision {
	sde.decisionsMu.RLock()
	defer sde.decisionsMu.RUnlock()
	
	pending := make([]*ScalingDecision, 0)
	for _, decision := range sde.decisions {
		if !decision.Executed {
			pending = append(pending, decision)
		}
	}
	
	return pending
}

func (sde *ScalingDecisionEngine) GetPredictionsForTime(targetTime time.Time) []*UsagePrediction {
	sde.predictionsMu.RLock()
	defer sde.predictionsMu.RUnlock()
	
	matching := make([]*UsagePrediction, 0)
	for _, prediction := range sde.predictions {
		diff := targetTime.Sub(prediction.Timestamp)
		if diff < 0 {
			diff = -diff
		}
		if diff < 5*time.Minute {
			matching = append(matching, prediction)
		}
	}
	
	return matching
}

func (sde *ScalingDecisionEngine) evaluatePrediction(prediction *UsagePrediction) *ScalingDecision {
	var threshold float64
	var action ScalingAction
	
	switch prediction.ResourceType {
	case ResourceCPU:
		if prediction.Value > sde.config.CPUScaleUpThreshold {
			threshold = sde.config.CPUScaleUpThreshold
			action = ScaleUp
		} else if prediction.Value < sde.config.CPUScaleDownThreshold {
			threshold = sde.config.CPUScaleDownThreshold
			action = ScaleDown
		} else {
			return nil
		}
	case ResourceMemory:
		if prediction.Value > sde.config.MemScaleUpThreshold {
			threshold = sde.config.MemScaleUpThreshold
			action = ScaleUp
		} else if prediction.Value < sde.config.MemScaleDownThreshold {
			threshold = sde.config.MemScaleDownThreshold
			action = ScaleDown
		} else {
			return nil
		}
	default:
		return nil
	}
	
	// Calculate scale factor
	scaleFactor := 1.0
	if action == ScaleUp {
		scaleFactor = math.Min(prediction.Value/threshold, sde.config.MaxScaleRatio)
	} else {
		scaleFactor = math.Max(prediction.Value/threshold, sde.config.MinScaleRatio)
	}
	
	return &ScalingDecision{
		ResourceType: prediction.ResourceType,
		Action:       action,
		ScaleFactor:  scaleFactor,
		TargetTime:   prediction.Timestamp.Add(-time.Duration(sde.config.PreScaleMinutes) * time.Minute),
		CreatedAt:    time.Now(),
		Prediction:   prediction,
	}
}

// Helper structures

type TimeSeriesPoint struct {
	Timestamp time.Time
	Value     float64
}

type SeasonalityModel struct {
	HourlyFactors  []float64
	WeekdayFactors []float64
}

type UsagePrediction struct {
	ResourceType ResourceType
	Timestamp    time.Time
	Value        float64
	Confidence   float64
	LowerBound   float64
	UpperBound   float64
}

type ScalingDecision struct {
	ResourceType ResourceType
	Action       ScalingAction
	ScaleFactor  float64
	TargetTime   time.Time
	CreatedAt    time.Time
	Executed     bool
	ExecutedAt   time.Time
	Prediction   *UsagePrediction
}

type ScalingAction string

const (
	ScaleUp   ScalingAction = "scale_up"
	ScaleDown ScalingAction = "scale_down"
)

func (sd *ScalingDecision) ShouldExecute(now time.Time) bool {
	return !sd.Executed && now.After(sd.TargetTime)
}

type ScalerStats struct {
	TotalPredictions   uint64
	PredictionAccuracy float64
	ScaleUpEvents      uint64
	ScaleDownEvents    uint64
	PreScaleSuccess    uint64
	CostSavings        float64
	AvgPredictionError float64
	DetectedPatterns   int
}

// Utility functions

func calculateAverage(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	
	total := 0.0
	for _, v := range values {
		total += v
	}
	return total / float64(len(values))
}

func calculateStdDev(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	
	avg := calculateAverage(values)
	total := 0.0
	
	for _, v := range values {
		diff := v - avg
		total += diff * diff
	}
	
	return math.Sqrt(total / float64(len(values)))
}

// DefaultScalerConfig returns default configuration
func DefaultScalerConfig() *ScalerConfig {
	return &ScalerConfig{
		PredictionWindow:      24 * time.Hour,
		PredictionInterval:    5 * time.Minute,
		ConfidenceThreshold:   0.8,
		PatternWindowDays:     30,
		MinPatternOccurrences: 5,
		SeasonalityEnabled:    true,
		CPUScaleUpThreshold:   0.8,
		CPUScaleDownThreshold: 0.3,
		MemScaleUpThreshold:   0.85,
		MemScaleDownThreshold: 0.4,
		PreScaleMinutes:       10,
		ScaleCooldown:         5 * time.Minute,
		MaxScaleRatio:         2.0,
		MinScaleRatio:         0.5,
		MaxCPUCores:           64,
		MaxMemoryGB:           256,
		MaxNetworkMbps:        10000,
		MaxStorageGB:          10000,
		CostAware:             true,
		MaxHourlyCost:         100.0,
	}
}