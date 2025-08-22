package optimization

import (
	"fmt"
	"math"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

type MLPredictor struct {
	logger          *zap.Logger
	mu              sync.RWMutex
	
	// Training data
	trainingData    []*TrainingExample
	models          map[string]*RegressionModel
	
	// Feature engineering
	featureExtractor *FeatureExtractor
	
	// Model performance
	modelMetrics    map[string]*ModelMetrics
	
	// Configuration
	config          *MLConfig
}

type MLConfig struct {
	MaxTrainingExamples int     `json:"max_training_examples"`
	ModelUpdateInterval time.Duration `json:"model_update_interval"`
	MinAccuracy         float64 `json:"min_accuracy"`
	FeatureWindow       int     `json:"feature_window"`
	EnableOnlineLearning bool   `json:"enable_online_learning"`
}

type TrainingExample struct {
	DeviceID        string                 `json:"device_id"`
	DeviceType      string                 `json:"device_type"`
	Algorithm       string                 `json:"algorithm"`
	Settings        DeviceSettings         `json:"settings"`
	Features        []float64              `json:"features"`
	Target          float64                `json:"target"` // Hashrate
	Timestamp       time.Time              `json:"timestamp"`
	ValidationSet   bool                   `json:"validation_set"`
}

type RegressionModel struct {
	Weights         []float64              `json:"weights"`
	Bias            float64                `json:"bias"`
	FeatureScale    []float64              `json:"feature_scale"`
	FeatureMean     []float64              `json:"feature_mean"`
	TrainingCount   int                    `json:"training_count"`
	LastUpdated     time.Time              `json:"last_updated"`
	Accuracy        float64                `json:"accuracy"`
	Algorithm       string                 `json:"algorithm"`
	DeviceType      string                 `json:"device_type"`
}

type ModelMetrics struct {
	MAE             float64                `json:"mae"`  // Mean Absolute Error
	RMSE            float64                `json:"rmse"` // Root Mean Square Error
	R2              float64                `json:"r2"`   // R-squared
	PredictionCount int64                  `json:"prediction_count"`
	LastEvaluation  time.Time              `json:"last_evaluation"`
	ErrorHistory    []float64              `json:"error_history"`
}

type FeatureExtractor struct {
	logger          *zap.Logger
	historicalData  map[string][]*PerformanceSnapshot
	mu              sync.RWMutex
}

type PerformanceSnapshot struct {
	Timestamp       time.Time              `json:"timestamp"`
	Hashrate        float64                `json:"hashrate"`
	Temperature     float64                `json:"temperature"`
	Power           float64                `json:"power"`
	Settings        DeviceSettings         `json:"settings"`
	Algorithm       string                 `json:"algorithm"`
}

func NewMLPredictor(logger *zap.Logger) *MLPredictor {
	config := &MLConfig{
		MaxTrainingExamples:  10000,
		ModelUpdateInterval:  time.Hour,
		MinAccuracy:         0.8,
		FeatureWindow:       20,
		EnableOnlineLearning: true,
	}
	
	return &MLPredictor{
		logger:           logger,
		trainingData:     make([]*TrainingExample, 0),
		models:           make(map[string]*RegressionModel),
		modelMetrics:     make(map[string]*ModelMetrics),
		featureExtractor: NewFeatureExtractor(logger),
		config:           config,
	}
}

func NewFeatureExtractor(logger *zap.Logger) *FeatureExtractor {
	return &FeatureExtractor{
		logger:         logger,
		historicalData: make(map[string][]*PerformanceSnapshot),
	}
}

func (ml *MLPredictor) PredictHashrate(device *DeviceState, algorithm string) float64 {
	modelKey := fmt.Sprintf("%s_%s", device.Type, algorithm)
	
	ml.mu.RLock()
	model, exists := ml.models[modelKey]
	ml.mu.RUnlock()
	
	if !exists || model.Accuracy < ml.config.MinAccuracy {
		// Fallback to simple estimation
		return ml.simpleHashrateEstimation(device, algorithm)
	}
	
	// Extract features
	features := ml.featureExtractor.ExtractFeatures(device, algorithm)
	if len(features) != len(model.Weights) {
		ml.logger.Warn("Feature dimension mismatch",
			zap.String("model_key", modelKey),
			zap.Int("expected", len(model.Weights)),
			zap.Int("actual", len(features)))
		return ml.simpleHashrateEstimation(device, algorithm)
	}
	
	// Normalize features
	normalizedFeatures := ml.normalizeFeatures(features, model.FeatureMean, model.FeatureScale)
	
	// Predict
	prediction := model.Bias
	for i, feature := range normalizedFeatures {
		prediction += feature * model.Weights[i]
	}
	
	// Update metrics
	ml.updatePredictionMetrics(modelKey)
	
	// Ensure reasonable bounds
	prediction = math.Max(0, prediction)
	prediction = math.Min(prediction, device.Performance.Hashrate*5) // Max 5x current hashrate
	
	return prediction
}

func (ml *MLPredictor) AddTrainingExample(device *DeviceState, algorithm string, actualHashrate float64) {
	features := ml.featureExtractor.ExtractFeatures(device, algorithm)
	
	example := &TrainingExample{
		DeviceID:    device.ID,
		DeviceType:  device.Type,
		Algorithm:   algorithm,
		Settings:    device.Settings,
		Features:    features,
		Target:      actualHashrate,
		Timestamp:   time.Now(),
		ValidationSet: ml.shouldUseForValidation(),
	}
	
	ml.mu.Lock()
	ml.trainingData = append(ml.trainingData, example)
	
	// Limit training data size
	if len(ml.trainingData) > ml.config.MaxTrainingExamples {
		// Remove oldest examples
		copy(ml.trainingData, ml.trainingData[len(ml.trainingData)-ml.config.MaxTrainingExamples:])
		ml.trainingData = ml.trainingData[:ml.config.MaxTrainingExamples]
	}
	ml.mu.Unlock()
	
	// Online learning update
	if ml.config.EnableOnlineLearning {
		go ml.updateModelOnline(device.Type, algorithm, example)
	}
	
	ml.logger.Debug("Training example added",
		zap.String("device_id", device.ID),
		zap.String("algorithm", algorithm),
		zap.Float64("hashrate", actualHashrate))
}

func (ml *MLPredictor) TrainModels() error {
	ml.logger.Info("Starting model training")
	
	ml.mu.RLock()
	trainingExamples := make([]*TrainingExample, len(ml.trainingData))
	copy(trainingExamples, ml.trainingData)
	ml.mu.RUnlock()
	
	if len(trainingExamples) < 10 {
		return fmt.Errorf("insufficient training data: %d examples", len(trainingExamples))
	}
	
	// Group by device type and algorithm
	groups := ml.groupTrainingData(trainingExamples)
	
	for key, examples := range groups {
		if len(examples) < 5 {
			ml.logger.Warn("Insufficient data for model",
				zap.String("model_key", key),
				zap.Int("examples", len(examples)))
			continue
		}
		
		// Split into training and validation
		trainData, validData := ml.splitTrainingData(examples)
		
		// Train model
		model, err := ml.trainRegressionModel(trainData)
		if err != nil {
			ml.logger.Error("Failed to train model",
				zap.String("model_key", key),
				zap.Error(err))
			continue
		}
		
		// Evaluate model
		metrics := ml.evaluateModel(model, validData)
		
		ml.mu.Lock()
		ml.models[key] = model
		ml.modelMetrics[key] = metrics
		ml.mu.Unlock()
		
		ml.logger.Info("Model trained successfully",
			zap.String("model_key", key),
			zap.Float64("accuracy", model.Accuracy),
			zap.Float64("rmse", metrics.RMSE),
			zap.Int("training_examples", len(trainData)))
	}
	
	return nil
}

func (ml *MLPredictor) groupTrainingData(examples []*TrainingExample) map[string][]*TrainingExample {
	groups := make(map[string][]*TrainingExample)
	
	for _, example := range examples {
		key := fmt.Sprintf("%s_%s", example.DeviceType, example.Algorithm)
		groups[key] = append(groups[key], example)
	}
	
	return groups
}

func (ml *MLPredictor) splitTrainingData(examples []*TrainingExample) ([]*TrainingExample, []*TrainingExample) {
	// Sort by timestamp to ensure temporal consistency
	sort.Slice(examples, func(i, j int) bool {
		return examples[i].Timestamp.Before(examples[j].Timestamp)
	})
	
	// 80/20 split
	splitIndex := int(float64(len(examples)) * 0.8)
	
	return examples[:splitIndex], examples[splitIndex:]
}

func (ml *MLPredictor) trainRegressionModel(examples []*TrainingExample) (*RegressionModel, error) {
	if len(examples) == 0 {
		return nil, fmt.Errorf("no training examples provided")
	}
	
	// Extract features and targets
	featureMatrix := make([][]float64, len(examples))
	targets := make([]float64, len(examples))
	
	for i, example := range examples {
		featureMatrix[i] = example.Features
		targets[i] = example.Target
	}
	
	// Calculate feature statistics for normalization
	featureMean, featureScale := ml.calculateFeatureStatistics(featureMatrix)
	
	// Normalize features
	normalizedMatrix := ml.normalizeFeatureMatrix(featureMatrix, featureMean, featureScale)
	
	// Train using gradient descent
	weights, bias, err := ml.gradientDescent(normalizedMatrix, targets)
	if err != nil {
		return nil, err
	}
	
	// Calculate accuracy on training data
	accuracy := ml.calculateAccuracy(normalizedMatrix, targets, weights, bias)
	
	model := &RegressionModel{
		Weights:       weights,
		Bias:          bias,
		FeatureScale:  featureScale,
		FeatureMean:   featureMean,
		TrainingCount: len(examples),
		LastUpdated:   time.Now(),
		Accuracy:      accuracy,
		Algorithm:     examples[0].Algorithm,
		DeviceType:    examples[0].DeviceType,
	}
	
	return model, nil
}

func (ml *MLPredictor) gradientDescent(features [][]float64, targets []float64) ([]float64, float64, error) {
	if len(features) == 0 {
		return nil, 0, fmt.Errorf("no features provided")
	}
	
	numFeatures := len(features[0])
	numSamples := len(features)
	
	// Initialize weights and bias
	weights := make([]float64, numFeatures)
	bias := 0.0
	
	// Hyperparameters
	learningRate := 0.01
	maxIterations := 1000
	tolerance := 1e-6
	
	for iteration := 0; iteration < maxIterations; iteration++ {
		// Calculate predictions
		predictions := make([]float64, numSamples)
		for i := range predictions {
			predictions[i] = bias
			for j := 0; j < numFeatures; j++ {
				predictions[i] += weights[j] * features[i][j]
			}
		}
		
		// Calculate cost
		cost := 0.0
		for i := range predictions {
			diff := predictions[i] - targets[i]
			cost += diff * diff
		}
		cost /= float64(2 * numSamples)
		
		// Calculate gradients
		weightGradients := make([]float64, numFeatures)
		biasGradient := 0.0
		
		for i := 0; i < numSamples; i++ {
			error := predictions[i] - targets[i]
			biasGradient += error
			
			for j := 0; j < numFeatures; j++ {
				weightGradients[j] += error * features[i][j]
			}
		}
		
		biasGradient /= float64(numSamples)
		for j := range weightGradients {
			weightGradients[j] /= float64(numSamples)
		}
		
		// Update parameters
		bias -= learningRate * biasGradient
		for j := range weights {
			weights[j] -= learningRate * weightGradients[j]
		}
		
		// Check convergence
		gradientNorm := biasGradient * biasGradient
		for j := range weightGradients {
			gradientNorm += weightGradients[j] * weightGradients[j]
		}
		
		if math.Sqrt(gradientNorm) < tolerance {
			break
		}
	}
	
	return weights, bias, nil
}

func (ml *MLPredictor) calculateFeatureStatistics(features [][]float64) ([]float64, []float64) {
	if len(features) == 0 {
		return nil, nil
	}
	
	numFeatures := len(features[0])
	mean := make([]float64, numFeatures)
	scale := make([]float64, numFeatures)
	
	// Calculate mean
	for i := 0; i < len(features); i++ {
		for j := 0; j < numFeatures; j++ {
			mean[j] += features[i][j]
		}
	}
	
	for j := range mean {
		mean[j] /= float64(len(features))
	}
	
	// Calculate standard deviation
	for i := 0; i < len(features); i++ {
		for j := 0; j < numFeatures; j++ {
			diff := features[i][j] - mean[j]
			scale[j] += diff * diff
		}
	}
	
	for j := range scale {
		scale[j] = math.Sqrt(scale[j] / float64(len(features)))
		if scale[j] == 0 {
			scale[j] = 1 // Avoid division by zero
		}
	}
	
	return mean, scale
}

func (ml *MLPredictor) normalizeFeatureMatrix(features [][]float64, mean, scale []float64) [][]float64 {
	normalized := make([][]float64, len(features))
	
	for i := range features {
		normalized[i] = ml.normalizeFeatures(features[i], mean, scale)
	}
	
	return normalized
}

func (ml *MLPredictor) normalizeFeatures(features, mean, scale []float64) []float64 {
	if len(features) != len(mean) || len(features) != len(scale) {
		return features // Return original if dimensions don't match
	}
	
	normalized := make([]float64, len(features))
	for i := range features {
		normalized[i] = (features[i] - mean[i]) / scale[i]
	}
	
	return normalized
}

func (ml *MLPredictor) calculateAccuracy(features [][]float64, targets []float64, weights []float64, bias float64) float64 {
	if len(features) == 0 {
		return 0
	}
	
	totalError := 0.0
	totalVariance := 0.0
	
	// Calculate mean target
	meanTarget := 0.0
	for _, target := range targets {
		meanTarget += target
	}
	meanTarget /= float64(len(targets))
	
	// Calculate predictions and errors
	for i, target := range targets {
		prediction := bias
		for j, weight := range weights {
			prediction += weight * features[i][j]
		}
		
		totalError += (prediction - target) * (prediction - target)
		totalVariance += (target - meanTarget) * (target - meanTarget)
	}
	
	// R-squared calculation
	if totalVariance == 0 {
		return 0
	}
	
	r2 := 1 - (totalError / totalVariance)
	return math.Max(0, r2) // Ensure non-negative
}

func (ml *MLPredictor) evaluateModel(model *RegressionModel, validationData []*TrainingExample) *ModelMetrics {
	if len(validationData) == 0 {
		return &ModelMetrics{
			MAE:            0,
			RMSE:           0,
			R2:             0,
			LastEvaluation: time.Now(),
		}
	}
	
	predictions := make([]float64, len(validationData))
	targets := make([]float64, len(validationData))
	
	// Generate predictions
	for i, example := range validationData {
		targets[i] = example.Target
		
		normalizedFeatures := ml.normalizeFeatures(example.Features, model.FeatureMean, model.FeatureScale)
		prediction := model.Bias
		
		for j, feature := range normalizedFeatures {
			prediction += feature * model.Weights[j]
		}
		
		predictions[i] = math.Max(0, prediction) // Ensure non-negative
	}
	
	// Calculate metrics
	mae := ml.calculateMAE(predictions, targets)
	rmse := ml.calculateRMSE(predictions, targets)
	r2 := ml.calculateR2(predictions, targets)
	
	return &ModelMetrics{
		MAE:             mae,
		RMSE:            rmse,
		R2:              r2,
		PredictionCount: int64(len(predictions)),
		LastEvaluation:  time.Now(),
		ErrorHistory:    ml.calculateErrorHistory(predictions, targets),
	}
}

func (ml *MLPredictor) calculateMAE(predictions, targets []float64) float64 {
	if len(predictions) != len(targets) || len(predictions) == 0 {
		return 0
	}
	
	totalError := 0.0
	for i := range predictions {
		totalError += math.Abs(predictions[i] - targets[i])
	}
	
	return totalError / float64(len(predictions))
}

func (ml *MLPredictor) calculateRMSE(predictions, targets []float64) float64 {
	if len(predictions) != len(targets) || len(predictions) == 0 {
		return 0
	}
	
	totalSquaredError := 0.0
	for i := range predictions {
		error := predictions[i] - targets[i]
		totalSquaredError += error * error
	}
	
	return math.Sqrt(totalSquaredError / float64(len(predictions)))
}

func (ml *MLPredictor) calculateR2(predictions, targets []float64) float64 {
	if len(predictions) != len(targets) || len(predictions) == 0 {
		return 0
	}
	
	// Calculate mean of targets
	meanTarget := 0.0
	for _, target := range targets {
		meanTarget += target
	}
	meanTarget /= float64(len(targets))
	
	// Calculate sum of squares
	totalSumSquares := 0.0
	residualSumSquares := 0.0
	
	for i := range predictions {
		totalSumSquares += (targets[i] - meanTarget) * (targets[i] - meanTarget)
		residualSumSquares += (targets[i] - predictions[i]) * (targets[i] - predictions[i])
	}
	
	if totalSumSquares == 0 {
		return 0
	}
	
	return 1 - (residualSumSquares / totalSumSquares)
}

func (ml *MLPredictor) calculateErrorHistory(predictions, targets []float64) []float64 {
	errors := make([]float64, len(predictions))
	for i := range predictions {
		errors[i] = math.Abs(predictions[i] - targets[i])
	}
	return errors
}

func (ml *MLPredictor) updateModelOnline(deviceType, algorithm string, example *TrainingExample) {
	modelKey := fmt.Sprintf("%s_%s", deviceType, algorithm)
	
	ml.mu.Lock()
	model, exists := ml.models[modelKey]
	ml.mu.Unlock()
	
	if !exists {
		return // No model to update
	}
	
	// Simple online learning update using stochastic gradient descent
	normalizedFeatures := ml.normalizeFeatures(example.Features, model.FeatureMean, model.FeatureScale)
	
	// Predict with current model
	prediction := model.Bias
	for i, feature := range normalizedFeatures {
		prediction += feature * model.Weights[i]
	}
	
	// Calculate error
	error := prediction - example.Target
	
	// Update weights and bias
	learningRate := 0.001 / math.Sqrt(float64(model.TrainingCount))
	
	ml.mu.Lock()
	model.Bias -= learningRate * error
	for i, feature := range normalizedFeatures {
		model.Weights[i] -= learningRate * error * feature
	}
	model.TrainingCount++
	model.LastUpdated = time.Now()
	ml.mu.Unlock()
}

func (ml *MLPredictor) simpleHashrateEstimation(device *DeviceState, algorithm string) float64 {
	// Fallback estimation when no ML model is available
	baseHashrate := device.Performance.Hashrate
	
	// Apply algorithm-specific multipliers
	multipliers := map[string]float64{
		"ethash":      1.0,
		"kawpow":      0.85,
		"randomx":     0.1,
		"scrypt":      0.9,
		"cryptonight": 0.8,
		"sha256d":     1.0,
	}
	
	multiplier, exists := multipliers[algorithm]
	if !exists {
		multiplier = 0.5 // Conservative default
	}
	
	return baseHashrate * multiplier
}

func (ml *MLPredictor) shouldUseForValidation() bool {
	// Use 20% of examples for validation
	return len(ml.trainingData)%5 == 0
}

func (ml *MLPredictor) updatePredictionMetrics(modelKey string) {
	ml.mu.Lock()
	defer ml.mu.Unlock()
	
	metrics, exists := ml.modelMetrics[modelKey]
	if !exists {
		return
	}
	
	metrics.PredictionCount++
}

func (fe *FeatureExtractor) ExtractFeatures(device *DeviceState, algorithm string) []float64 {
	features := make([]float64, 0, 20) // Estimate capacity
	
	// Device settings features
	features = append(features, float64(device.Settings.Intensity))
	features = append(features, float64(device.Settings.CoreClock))
	features = append(features, float64(device.Settings.MemoryClock))
	features = append(features, float64(device.Settings.PowerLimit))
	features = append(features, float64(device.Settings.FanSpeed))
	features = append(features, float64(device.Settings.Threads))
	
	// Current performance features
	features = append(features, device.Performance.Hashrate)
	features = append(features, device.Performance.Efficiency)
	features = append(features, device.Performance.ErrorRate)
	
	// Thermal features
	features = append(features, device.Thermal.CoreTemp)
	features = append(features, device.Thermal.MemoryTemp)
	features = append(features, float64(device.Thermal.FanRPM))
	
	// Power features
	features = append(features, device.Power.CurrentPower)
	features = append(features, device.Power.Voltage)
	features = append(features, device.Power.PowerEfficiency)
	
	// Algorithm-specific features
	algorithmFeatures := fe.getAlgorithmFeatures(algorithm)
	features = append(features, algorithmFeatures...)
	
	// Historical performance features
	historicalFeatures := fe.getHistoricalFeatures(device.ID)
	features = append(features, historicalFeatures...)
	
	return features
}

func (fe *FeatureExtractor) getAlgorithmFeatures(algorithm string) []float64 {
	// Algorithm characteristics
	features := make([]float64, 3)
	
	switch algorithm {
	case "ethash", "etchash":
		features[0] = 1.0 // Memory intensive
		features[1] = 0.5 // Medium compute
		features[2] = 0.8 // GPU optimized
	case "kawpow":
		features[0] = 0.7 // Moderately memory intensive
		features[1] = 0.8 // High compute
		features[2] = 0.9 // GPU optimized
	case "randomx":
		features[0] = 0.3 // Low memory intensity
		features[1] = 0.9 // High compute
		features[2] = 0.1 // CPU optimized
	case "scrypt":
		features[0] = 0.6 // Moderate memory
		features[1] = 0.4 // Low compute
		features[2] = 0.7 // Both CPU/GPU
	default:
		features[0] = 0.5
		features[1] = 0.5
		features[2] = 0.5
	}
	
	return features
}

func (fe *FeatureExtractor) getHistoricalFeatures(deviceID string) []float64 {
	fe.mu.RLock()
	history, exists := fe.historicalData[deviceID]
	fe.mu.RUnlock()
	
	if !exists || len(history) == 0 {
		return []float64{0, 0} // No historical data
	}
	
	// Calculate recent average and trend
	recentCount := 10
	if len(history) < recentCount {
		recentCount = len(history)
	}
	
	recentSnapshots := history[len(history)-recentCount:]
	
	// Average hashrate
	avgHashrate := 0.0
	for _, snapshot := range recentSnapshots {
		avgHashrate += snapshot.Hashrate
	}
	avgHashrate /= float64(len(recentSnapshots))
	
	// Hashrate trend (simple linear regression slope)
	trend := 0.0
	if len(recentSnapshots) > 1 {
		n := float64(len(recentSnapshots))
		sumX := n * (n - 1) / 2
		sumY := 0.0
		sumXY := 0.0
		sumX2 := n * (n - 1) * (2*n - 1) / 6
		
		for i, snapshot := range recentSnapshots {
			x := float64(i)
			y := snapshot.Hashrate
			sumY += y
			sumXY += x * y
		}
		
		if n*sumX2 - sumX*sumX != 0 {
			trend = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX)
		}
	}
	
	return []float64{avgHashrate, trend}
}

func (fe *FeatureExtractor) AddPerformanceSnapshot(deviceID string, snapshot *PerformanceSnapshot) {
	fe.mu.Lock()
	defer fe.mu.Unlock()
	
	if fe.historicalData[deviceID] == nil {
		fe.historicalData[deviceID] = make([]*PerformanceSnapshot, 0)
	}
	
	fe.historicalData[deviceID] = append(fe.historicalData[deviceID], snapshot)
	
	// Limit history size
	maxHistory := 100
	if len(fe.historicalData[deviceID]) > maxHistory {
		fe.historicalData[deviceID] = fe.historicalData[deviceID][len(fe.historicalData[deviceID])-maxHistory:]
	}
}

func (ml *MLPredictor) GetModelMetrics() map[string]*ModelMetrics {
	ml.mu.RLock()
	defer ml.mu.RUnlock()
	
	// Return copy to avoid race conditions
	metricsCopy := make(map[string]*ModelMetrics)
	for k, v := range ml.modelMetrics {
		metricsCopy[k] = &ModelMetrics{
			MAE:             v.MAE,
			RMSE:            v.RMSE,
			R2:              v.R2,
			PredictionCount: v.PredictionCount,
			LastEvaluation:  v.LastEvaluation,
			ErrorHistory:    append([]float64(nil), v.ErrorHistory...),
		}
	}
	
	return metricsCopy
}

func (ml *MLPredictor) GetTrainingDataStats() map[string]int {
	ml.mu.RLock()
	defer ml.mu.RUnlock()
	
	stats := make(map[string]int)
	
	for _, example := range ml.trainingData {
		key := fmt.Sprintf("%s_%s", example.DeviceType, example.Algorithm)
		stats[key]++
	}
	
	return stats
}