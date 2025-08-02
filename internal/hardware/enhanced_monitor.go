package hardware

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// EnhancedMonitor provides advanced hardware monitoring with history and predictions
type EnhancedMonitor struct {
	*Monitor
	
	// Historical data
	history      *MetricsHistory
	
	// Rate calculators
	cpuRate      *RateCalculator
	diskRate     *RateCalculator
	netRate      *RateCalculator
	
	// Predictive analysis
	predictor    *MetricsPredictor
	
	// Fan control
	fanControl   *FanController
	
	// Throttling detection
	throttle     *ThrottleDetector
}

// MetricsHistory stores historical metrics data
type MetricsHistory struct {
	mu            sync.RWMutex
	maxSize       int
	retention     time.Duration
	metrics       []*Metrics
	cpuHistory    []float64
	tempHistory   []float64
	powerHistory  []float64
}

// RateCalculator calculates rates over time
type RateCalculator struct {
	mu           sync.RWMutex
	lastValue    uint64
	lastTime     time.Time
	currentRate  float64
	avgRate      float64
	peakRate     float64
}

// MetricsPredictor predicts future resource usage
type MetricsPredictor struct {
	logger       *zap.Logger
	history      *MetricsHistory
	predictions  map[string]Prediction
	mu           sync.RWMutex
}

// Prediction represents a resource usage prediction
type Prediction struct {
	Resource     string    `json:"resource"`
	CurrentValue float64   `json:"current_value"`
	Trend        string    `json:"trend"` // "increasing", "decreasing", "stable"
	PredictedMax float64   `json:"predicted_max"`
	TimeToMax    time.Duration `json:"time_to_max"`
	Confidence   float64   `json:"confidence"` // 0-1
}

// FanController manages fan speeds based on temperature
type FanController struct {
	logger       *zap.Logger
	enabled      atomic.Bool
	mode         atomic.Value // FanMode
	targetTemp   atomic.Value // float64
	curves       map[string]FanCurve
	mu           sync.RWMutex
}

// FanMode represents fan control mode
type FanMode string

const (
	FanModeAuto        FanMode = "auto"
	FanModeManual      FanMode = "manual"
	FanModeAggressive  FanMode = "aggressive"
	FanModeSilent      FanMode = "silent"
	FanModeCustom      FanMode = "custom"
)

// FanCurve defines temperature to fan speed mapping
type FanCurve struct {
	Name   string
	Points []FanPoint
}

// FanPoint represents a temperature/fan speed pair
type FanPoint struct {
	Temperature float64 `json:"temperature"`
	FanSpeed    int     `json:"fan_speed"` // 0-100%
}

// ThrottleDetector detects CPU/GPU throttling
type ThrottleDetector struct {
	logger          *zap.Logger
	cpuThrottled    atomic.Bool
	gpuThrottled    atomic.Bool
	lastCPUFreq     atomic.Value // float64
	lastGPUFreq     atomic.Value // float64
	throttleEvents  []ThrottleEvent
	mu              sync.RWMutex
}

// ThrottleEvent represents a throttling event
type ThrottleEvent struct {
	Component   string    `json:"component"`
	StartTime   time.Time `json:"start_time"`
	EndTime     time.Time `json:"end_time"`
	Reason      string    `json:"reason"` // "thermal", "power", "current"
	MaxTemp     float64   `json:"max_temperature"`
	FreqDrop    float64   `json:"frequency_drop_percent"`
}

// NewEnhancedMonitor creates an enhanced hardware monitor
func NewEnhancedMonitor(logger *zap.Logger, config Config) *EnhancedMonitor {
	baseMonitor := NewMonitor(logger, config)
	
	em := &EnhancedMonitor{
		Monitor: baseMonitor,
		history: &MetricsHistory{
			maxSize:   1000,
			retention: 24 * time.Hour,
			metrics:   make([]*Metrics, 0, 1000),
		},
		cpuRate:    &RateCalculator{},
		diskRate:   &RateCalculator{},
		netRate:    &RateCalculator{},
		predictor:  NewMetricsPredictor(logger),
		fanControl: NewFanController(logger),
		throttle:   NewThrottleDetector(logger),
	}
	
	// Initialize fan curves
	em.fanControl.InitializeDefaultCurves()
	
	return em
}

// Start begins enhanced monitoring
func (em *EnhancedMonitor) Start(ctx context.Context) error {
	// Start base monitor
	if err := em.Monitor.Start(ctx); err != nil {
		return err
	}
	
	// Start enhanced features
	go em.historicalTracking(ctx)
	go em.rateCalculation(ctx)
	go em.predictiveAnalysis(ctx)
	go em.throttleDetection(ctx)
	
	if em.fanControl.enabled.Load() {
		go em.fanControl.Run(ctx, em)
	}
	
	return nil
}

// GetHistory returns historical metrics
func (em *EnhancedMonitor) GetHistory(duration time.Duration) []*Metrics {
	return em.history.GetRecent(duration)
}

// GetPredictions returns resource usage predictions
func (em *EnhancedMonitor) GetPredictions() map[string]Prediction {
	em.predictor.mu.RLock()
	defer em.predictor.mu.RUnlock()
	
	// Return a copy
	predictions := make(map[string]Prediction)
	for k, v := range em.predictor.predictions {
		predictions[k] = v
	}
	return predictions
}

// GetThrottleEvents returns recent throttle events
func (em *EnhancedMonitor) GetThrottleEvents() []ThrottleEvent {
	em.throttle.mu.RLock()
	defer em.throttle.mu.RUnlock()
	
	events := make([]ThrottleEvent, len(em.throttle.throttleEvents))
	copy(events, em.throttle.throttleEvents)
	return events
}

// SetFanMode sets the fan control mode
func (em *EnhancedMonitor) SetFanMode(mode FanMode) {
	em.fanControl.SetMode(mode)
}

// SetFanCurve sets a custom fan curve
func (em *EnhancedMonitor) SetFanCurve(name string, curve FanCurve) {
	em.fanControl.SetCustomCurve(name, curve)
}

// Private methods

func (em *EnhancedMonitor) historicalTracking(ctx context.Context) {
	ticker := time.NewTicker(em.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			metrics := em.GetMetrics()
			em.history.Add(metrics)
			
			// Update specific histories for prediction
			em.history.mu.Lock()
			em.history.cpuHistory = append(em.history.cpuHistory, metrics.CPU.Usage)
			if len(em.history.cpuHistory) > 100 {
				em.history.cpuHistory = em.history.cpuHistory[1:]
			}
			
			if metrics.CPU.Temperature > 0 {
				em.history.tempHistory = append(em.history.tempHistory, metrics.CPU.Temperature)
				if len(em.history.tempHistory) > 100 {
					em.history.tempHistory = em.history.tempHistory[1:]
				}
			}
			
			// Track GPU temperature/power
			for _, gpu := range metrics.GPU {
				if gpu.Temperature > 0 {
					em.history.tempHistory = append(em.history.tempHistory, gpu.Temperature)
				}
				if gpu.Power > 0 {
					em.history.powerHistory = append(em.history.powerHistory, gpu.Power)
					if len(em.history.powerHistory) > 100 {
						em.history.powerHistory = em.history.powerHistory[1:]
					}
				}
			}
			em.history.mu.Unlock()
		}
	}
}

func (em *EnhancedMonitor) rateCalculation(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			metrics := em.GetMetrics()
			
			// Update disk rates
			em.diskRate.Update(metrics.Disk.ReadBytes + metrics.Disk.WriteBytes)
			
			// Update network rates
			em.netRate.Update(metrics.Network.BytesSent + metrics.Network.BytesRecv)
			
			// Apply calculated rates back to metrics
			em.mu.Lock()
			em.metrics.Disk.ReadRate = em.diskRate.GetRate() / 2  // Approximate
			em.metrics.Disk.WriteRate = em.diskRate.GetRate() / 2
			em.metrics.Network.SendRate = em.netRate.GetRate() / 2
			em.metrics.Network.RecvRate = em.netRate.GetRate() / 2
			em.mu.Unlock()
		}
	}
}

func (em *EnhancedMonitor) predictiveAnalysis(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			em.predictor.Analyze(em.history)
		}
	}
}

func (em *EnhancedMonitor) throttleDetection(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			metrics := em.GetMetrics()
			em.throttle.Check(metrics)
		}
	}
}

// MetricsHistory methods

func (mh *MetricsHistory) Add(metrics *Metrics) {
	mh.mu.Lock()
	defer mh.mu.Unlock()
	
	mh.metrics = append(mh.metrics, metrics)
	
	// Enforce max size
	if len(mh.metrics) > mh.maxSize {
		mh.metrics = mh.metrics[len(mh.metrics)-mh.maxSize:]
	}
	
	// Remove old entries
	cutoff := time.Now().Add(-mh.retention)
	var keep []*Metrics
	for _, m := range mh.metrics {
		if m.UpdatedAt.After(cutoff) {
			keep = append(keep, m)
		}
	}
	mh.metrics = keep
}

func (mh *MetricsHistory) GetRecent(duration time.Duration) []*Metrics {
	mh.mu.RLock()
	defer mh.mu.RUnlock()
	
	cutoff := time.Now().Add(-duration)
	var result []*Metrics
	
	for i := len(mh.metrics) - 1; i >= 0; i-- {
		if mh.metrics[i].UpdatedAt.Before(cutoff) {
			break
		}
		result = append(result, mh.metrics[i])
	}
	
	// Reverse to chronological order
	for i := 0; i < len(result)/2; i++ {
		j := len(result) - 1 - i
		result[i], result[j] = result[j], result[i]
	}
	
	return result
}

// RateCalculator methods

func (rc *RateCalculator) Update(value uint64) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	
	now := time.Now()
	if !rc.lastTime.IsZero() {
		duration := now.Sub(rc.lastTime).Seconds()
		if duration > 0 && value >= rc.lastValue {
			rate := float64(value-rc.lastValue) / duration / 1024 / 1024 // MB/s
			rc.currentRate = rate
			
			// Update average
			if rc.avgRate == 0 {
				rc.avgRate = rate
			} else {
				rc.avgRate = rc.avgRate*0.9 + rate*0.1 // Exponential moving average
			}
			
			// Update peak
			if rate > rc.peakRate {
				rc.peakRate = rate
			}
		}
	}
	
	rc.lastValue = value
	rc.lastTime = now
}

func (rc *RateCalculator) GetRate() float64 {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.currentRate
}

func (rc *RateCalculator) GetAvgRate() float64 {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.avgRate
}

func (rc *RateCalculator) GetPeakRate() float64 {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.peakRate
}

// MetricsPredictor methods

func NewMetricsPredictor(logger *zap.Logger) *MetricsPredictor {
	return &MetricsPredictor{
		logger:      logger,
		predictions: make(map[string]Prediction),
	}
}

func (mp *MetricsPredictor) Analyze(history *MetricsHistory) {
	mp.mu.Lock()
	defer mp.mu.Unlock()
	
	// Analyze CPU usage trend
	if len(history.cpuHistory) >= 10 {
		trend, predicted := mp.analyzeTrend(history.cpuHistory)
		mp.predictions["cpu"] = Prediction{
			Resource:     "CPU",
			CurrentValue: history.cpuHistory[len(history.cpuHistory)-1],
			Trend:        trend,
			PredictedMax: predicted,
			TimeToMax:    mp.estimateTimeToMax(history.cpuHistory, predicted),
			Confidence:   mp.calculateConfidence(history.cpuHistory),
		}
	}
	
	// Analyze temperature trend
	if len(history.tempHistory) >= 10 {
		trend, predicted := mp.analyzeTrend(history.tempHistory)
		mp.predictions["temperature"] = Prediction{
			Resource:     "Temperature",
			CurrentValue: history.tempHistory[len(history.tempHistory)-1],
			Trend:        trend,
			PredictedMax: predicted,
			TimeToMax:    mp.estimateTimeToMax(history.tempHistory, predicted),
			Confidence:   mp.calculateConfidence(history.tempHistory),
		}
	}
}

func (mp *MetricsPredictor) analyzeTrend(values []float64) (string, float64) {
	if len(values) < 2 {
		return "stable", values[len(values)-1]
	}
	
	// Simple linear regression
	n := float64(len(values))
	var sumX, sumY, sumXY, sumX2 float64
	
	for i, y := range values {
		x := float64(i)
		sumX += x
		sumY += y
		sumXY += x * y
		sumX2 += x * x
	}
	
	// Calculate slope
	slope := (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX)
	
	// Determine trend
	var trend string
	if slope > 0.5 {
		trend = "increasing"
	} else if slope < -0.5 {
		trend = "decreasing"
	} else {
		trend = "stable"
	}
	
	// Predict future value (next 10 points)
	intercept := (sumY - slope*sumX) / n
	predicted := slope*(n+10) + intercept
	
	// Clamp to reasonable range
	if predicted < 0 {
		predicted = 0
	} else if predicted > 100 {
		predicted = 100
	}
	
	return trend, predicted
}

func (mp *MetricsPredictor) estimateTimeToMax(values []float64, predicted float64) time.Duration {
	if len(values) < 2 {
		return 0
	}
	
	current := values[len(values)-1]
	if predicted <= current {
		return 0
	}
	
	// Calculate average rate of change
	rateSum := 0.0
	count := 0
	for i := 1; i < len(values); i++ {
		if values[i] > values[i-1] {
			rateSum += values[i] - values[i-1]
			count++
		}
	}
	
	if count == 0 {
		return 0
	}
	
	avgRate := rateSum / float64(count)
	if avgRate <= 0 {
		return 0
	}
	
	// Estimate time to reach predicted max
	pointsToMax := (predicted - current) / avgRate
	return time.Duration(pointsToMax) * time.Minute
}

func (mp *MetricsPredictor) calculateConfidence(values []float64) float64 {
	if len(values) < 10 {
		return 0.1
	}
	
	// Calculate variance
	mean := 0.0
	for _, v := range values {
		mean += v
	}
	mean /= float64(len(values))
	
	variance := 0.0
	for _, v := range values {
		diff := v - mean
		variance += diff * diff
	}
	variance /= float64(len(values))
	
	// Lower variance = higher confidence
	if variance < 1 {
		return 0.9
	} else if variance < 5 {
		return 0.7
	} else if variance < 10 {
		return 0.5
	}
	return 0.3
}

// FanController methods

func NewFanController(logger *zap.Logger) *FanController {
	fc := &FanController{
		logger: logger,
		curves: make(map[string]FanCurve),
	}
	fc.mode.Store(FanModeAuto)
	fc.targetTemp.Store(70.0)
	return fc
}

func (fc *FanController) InitializeDefaultCurves() {
	// Silent curve
	fc.curves["silent"] = FanCurve{
		Name: "silent",
		Points: []FanPoint{
			{Temperature: 0, FanSpeed: 20},
			{Temperature: 50, FanSpeed: 30},
			{Temperature: 70, FanSpeed: 50},
			{Temperature: 80, FanSpeed: 70},
			{Temperature: 90, FanSpeed: 100},
		},
	}
	
	// Balanced curve
	fc.curves["balanced"] = FanCurve{
		Name: "balanced",
		Points: []FanPoint{
			{Temperature: 0, FanSpeed: 30},
			{Temperature: 50, FanSpeed: 40},
			{Temperature: 60, FanSpeed: 60},
			{Temperature: 70, FanSpeed: 80},
			{Temperature: 80, FanSpeed: 100},
		},
	}
	
	// Aggressive curve
	fc.curves["aggressive"] = FanCurve{
		Name: "aggressive",
		Points: []FanPoint{
			{Temperature: 0, FanSpeed: 40},
			{Temperature: 50, FanSpeed: 60},
			{Temperature: 60, FanSpeed: 80},
			{Temperature: 70, FanSpeed: 100},
		},
	}
}

func (fc *FanController) SetMode(mode FanMode) {
	fc.mode.Store(mode)
	fc.logger.Info("Fan mode changed", zap.String("mode", string(mode)))
}

func (fc *FanController) SetCustomCurve(name string, curve FanCurve) {
	fc.mu.Lock()
	fc.curves[name] = curve
	fc.mu.Unlock()
}

func (fc *FanController) Run(ctx context.Context, monitor *EnhancedMonitor) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			metrics := monitor.GetMetrics()
			fc.adjustFans(metrics)
		}
	}
}

func (fc *FanController) adjustFans(metrics *Metrics) {
	mode := fc.mode.Load().(FanMode)
	
	// Get maximum temperature
	maxTemp := metrics.CPU.Temperature
	for _, gpu := range metrics.GPU {
		if gpu.Temperature > maxTemp {
			maxTemp = gpu.Temperature
		}
	}
	
	if maxTemp == 0 {
		return // No temperature data
	}
	
	// Calculate fan speed based on mode
	var targetSpeed int
	
	switch mode {
	case FanModeManual:
		// User-controlled, don't adjust
		return
		
	case FanModeSilent:
		targetSpeed = fc.calculateSpeed(maxTemp, fc.curves["silent"])
		
	case FanModeAggressive:
		targetSpeed = fc.calculateSpeed(maxTemp, fc.curves["aggressive"])
		
	case FanModeAuto:
		targetSpeed = fc.calculateSpeed(maxTemp, fc.curves["balanced"])
		
	case FanModeCustom:
		if curve, ok := fc.curves["custom"]; ok {
			targetSpeed = fc.calculateSpeed(maxTemp, curve)
		} else {
			targetSpeed = fc.calculateSpeed(maxTemp, fc.curves["balanced"])
		}
	}
	
	// Apply fan speed (platform-specific implementation needed)
	fc.logger.Debug("Fan speed adjustment",
		zap.Float64("temperature", maxTemp),
		zap.Int("target_speed", targetSpeed),
		zap.String("mode", string(mode)),
	)
}

func (fc *FanController) calculateSpeed(temp float64, curve FanCurve) int {
	// Linear interpolation between curve points
	for i := 0; i < len(curve.Points)-1; i++ {
		p1 := curve.Points[i]
		p2 := curve.Points[i+1]
		
		if temp >= p1.Temperature && temp <= p2.Temperature {
			// Interpolate
			ratio := (temp - p1.Temperature) / (p2.Temperature - p1.Temperature)
			speed := p1.FanSpeed + int(ratio*float64(p2.FanSpeed-p1.FanSpeed))
			return speed
		}
	}
	
	// Above highest point
	if len(curve.Points) > 0 && temp > curve.Points[len(curve.Points)-1].Temperature {
		return curve.Points[len(curve.Points)-1].FanSpeed
	}
	
	// Below lowest point
	if len(curve.Points) > 0 {
		return curve.Points[0].FanSpeed
	}
	
	return 50 // Default
}

// ThrottleDetector methods

func NewThrottleDetector(logger *zap.Logger) *ThrottleDetector {
	td := &ThrottleDetector{
		logger:         logger,
		throttleEvents: make([]ThrottleEvent, 0, 100),
	}
	td.lastCPUFreq.Store(0.0)
	td.lastGPUFreq.Store(0.0)
	return td
}

func (td *ThrottleDetector) Check(metrics *Metrics) {
	// Check CPU throttling
	currentCPUFreq := metrics.CPU.Frequency
	lastCPUFreq := td.lastCPUFreq.Load().(float64)
	
	if lastCPUFreq > 0 && currentCPUFreq < lastCPUFreq*0.9 {
		if !td.cpuThrottled.Load() {
			td.cpuThrottled.Store(true)
			td.startThrottleEvent("CPU", metrics.CPU.Temperature, 
				(lastCPUFreq-currentCPUFreq)/lastCPUFreq*100)
		}
	} else if td.cpuThrottled.Load() && currentCPUFreq >= lastCPUFreq*0.95 {
		td.cpuThrottled.Store(false)
		td.endThrottleEvent("CPU")
	}
	
	td.lastCPUFreq.Store(currentCPUFreq)
	
	// Check GPU throttling
	for _, gpu := range metrics.GPU {
		// Similar logic for GPU
		// Platform-specific implementation needed
	}
}

func (td *ThrottleDetector) startThrottleEvent(component string, temp, freqDrop float64) {
	td.mu.Lock()
	defer td.mu.Unlock()
	
	event := ThrottleEvent{
		Component:   component,
		StartTime:   time.Now(),
		MaxTemp:     temp,
		FreqDrop:    freqDrop,
		Reason:      td.determineReason(temp),
	}
	
	td.throttleEvents = append(td.throttleEvents, event)
	
	// Keep only recent events
	if len(td.throttleEvents) > 100 {
		td.throttleEvents = td.throttleEvents[len(td.throttleEvents)-100:]
	}
	
	td.logger.Warn("Throttling detected",
		zap.String("component", component),
		zap.Float64("temperature", temp),
		zap.Float64("frequency_drop", freqDrop),
	)
}

func (td *ThrottleDetector) endThrottleEvent(component string) {
	td.mu.Lock()
	defer td.mu.Unlock()
	
	// Find and update the last event for this component
	for i := len(td.throttleEvents) - 1; i >= 0; i-- {
		if td.throttleEvents[i].Component == component && td.throttleEvents[i].EndTime.IsZero() {
			td.throttleEvents[i].EndTime = time.Now()
			
			duration := td.throttleEvents[i].EndTime.Sub(td.throttleEvents[i].StartTime)
			td.logger.Info("Throttling ended",
				zap.String("component", component),
				zap.Duration("duration", duration),
			)
			break
		}
	}
}

func (td *ThrottleDetector) determineReason(temp float64) string {
	if temp > 85 {
		return "thermal"
	}
	// Could check power consumption to determine if power throttling
	return "unknown"
}