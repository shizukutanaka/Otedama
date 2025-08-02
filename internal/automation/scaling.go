package automation

import (
	"context"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// AutoScaler provides automatic scaling based on metrics
type AutoScaler struct {
	logger *zap.Logger
	config *ScalingConfig
	
	// Current state
	currentInstances atomic.Int32
	desiredInstances atomic.Int32
	
	// Scaling decisions
	scaler          ScalingStrategy
	cooldownTracker *CooldownTracker
	
	// Metrics
	metricsProvider MetricsProvider
	
	// Instance management
	instanceManager InstanceManager
	
	// Status
	running atomic.Bool
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// ScalingConfig contains auto-scaling configuration
type ScalingConfig struct {
	// Instance limits
	MinInstances int `yaml:"min_instances"`
	MaxInstances int `yaml:"max_instances"`
	
	// Scaling triggers
	ScaleUpThreshold   float64       `yaml:"scale_up_threshold"`
	ScaleDownThreshold float64       `yaml:"scale_down_threshold"`
	
	// Timing
	EvaluationInterval time.Duration `yaml:"evaluation_interval"`
	ScaleUpCooldown    time.Duration `yaml:"scale_up_cooldown"`
	ScaleDownCooldown  time.Duration `yaml:"scale_down_cooldown"`
	
	// Scaling strategy
	Strategy           string        `yaml:"strategy"` // reactive, predictive, scheduled
	
	// Metrics
	MetricName         string        `yaml:"metric_name"`
	MetricAggregation  string        `yaml:"metric_aggregation"` // avg, max, min
	
	// Advanced settings
	PredictiveScaling  bool          `yaml:"predictive_scaling"`
	CostOptimization   bool          `yaml:"cost_optimization"`
	
	// Schedule-based scaling
	Schedules          []ScalingSchedule `yaml:"schedules"`
}

// ScalingSchedule defines scheduled scaling
type ScalingSchedule struct {
	Name         string `yaml:"name"`
	CronExpr     string `yaml:"cron"`
	MinInstances int    `yaml:"min_instances"`
	MaxInstances int    `yaml:"max_instances"`
}

// ScalingStrategy defines scaling algorithm
type ScalingStrategy interface {
	Calculate(current int, metrics []Metric, config *ScalingConfig) int
}

// MetricsProvider provides metrics for scaling decisions
type MetricsProvider interface {
	GetMetrics(ctx context.Context, name string, duration time.Duration) ([]Metric, error)
}

// InstanceManager manages instances
type InstanceManager interface {
	Scale(ctx context.Context, targetCount int) error
	GetCurrentCount(ctx context.Context) (int, error)
	GetInstances(ctx context.Context) ([]Instance, error)
}

// Instance represents a managed instance
type Instance struct {
	ID          string
	State       InstanceState
	LaunchTime  time.Time
	IPAddress   string
	Metrics     map[string]float64
}

// InstanceState represents instance state
type InstanceState string

const (
	InstanceStatePending     InstanceState = "pending"
	InstanceStateRunning     InstanceState = "running"
	InstanceStateStopping    InstanceState = "stopping"
	InstanceStateTerminated  InstanceState = "terminated"
)

// NewAutoScaler creates a new auto-scaler
func NewAutoScaler(logger *zap.Logger, config *ScalingConfig, metricsProvider MetricsProvider, instanceManager InstanceManager) *AutoScaler {
	ctx, cancel := context.WithCancel(context.Background())
	
	as := &AutoScaler{
		logger:          logger,
		config:          config,
		metricsProvider: metricsProvider,
		instanceManager: instanceManager,
		cooldownTracker: NewCooldownTracker(),
		ctx:             ctx,
		cancel:          cancel,
	}
	
	// Initialize scaling strategy
	as.initializeStrategy()
	
	// Set initial instance count
	if count, err := instanceManager.GetCurrentCount(ctx); err == nil {
		as.currentInstances.Store(int32(count))
		as.desiredInstances.Store(int32(count))
	}
	
	return as
}

// Start starts the auto-scaler
func (as *AutoScaler) Start() error {
	if !as.running.CompareAndSwap(false, true) {
		return fmt.Errorf("auto-scaler already running")
	}
	
	as.logger.Info("Starting auto-scaler",
		zap.Int("min_instances", as.config.MinInstances),
		zap.Int("max_instances", as.config.MaxInstances),
		zap.String("strategy", as.config.Strategy),
	)
	
	// Start scaling loop
	as.wg.Add(1)
	go as.scalingLoop()
	
	// Start schedule handler if configured
	if len(as.config.Schedules) > 0 {
		as.wg.Add(1)
		go as.scheduleLoop()
	}
	
	return nil
}

// Stop stops the auto-scaler
func (as *AutoScaler) Stop() error {
	if !as.running.CompareAndSwap(true, false) {
		return fmt.Errorf("auto-scaler not running")
	}
	
	as.logger.Info("Stopping auto-scaler")
	
	as.cancel()
	as.wg.Wait()
	
	return nil
}

// scalingLoop runs the main scaling evaluation loop
func (as *AutoScaler) scalingLoop() {
	defer as.wg.Done()
	
	ticker := time.NewTicker(as.config.EvaluationInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-as.ctx.Done():
			return
		case <-ticker.C:
			as.evaluate()
		}
	}
}

// evaluate evaluates scaling needs
func (as *AutoScaler) evaluate() {
	// Get current instance count
	current := int(as.currentInstances.Load())
	
	// Get metrics
	metrics, err := as.metricsProvider.GetMetrics(as.ctx, as.config.MetricName, 5*time.Minute)
	if err != nil {
		as.logger.Error("Failed to get metrics for scaling", zap.Error(err))
		return
	}
	
	if len(metrics) == 0 {
		as.logger.Debug("No metrics available for scaling decision")
		return
	}
	
	// Calculate desired instances
	desired := as.scaler.Calculate(current, metrics, as.config)
	
	// Apply limits
	desired = as.applyLimits(desired)
	
	// Check if scaling needed
	if desired != current {
		as.logger.Info("Scaling decision",
			zap.Int("current", current),
			zap.Int("desired", desired),
			zap.Int("delta", desired-current),
		)
		
		// Check cooldown
		if as.canScale(desired > current) {
			as.scale(desired)
		} else {
			as.logger.Debug("Scaling in cooldown period")
		}
	}
}

// scale performs scaling operation
func (as *AutoScaler) scale(targetCount int) {
	current := int(as.currentInstances.Load())
	
	// Update desired count
	as.desiredInstances.Store(int32(targetCount))
	
	// Perform scaling
	err := as.instanceManager.Scale(as.ctx, targetCount)
	if err != nil {
		as.logger.Error("Scaling operation failed",
			zap.Int("target", targetCount),
			zap.Error(err),
		)
		return
	}
	
	// Update current count
	as.currentInstances.Store(int32(targetCount))
	
	// Record cooldown
	if targetCount > current {
		as.cooldownTracker.RecordScaleUp()
	} else {
		as.cooldownTracker.RecordScaleDown()
	}
	
	as.logger.Info("Scaling operation completed",
		zap.Int("previous", current),
		zap.Int("current", targetCount),
	)
}

// canScale checks if scaling is allowed (cooldown)
func (as *AutoScaler) canScale(isScaleUp bool) bool {
	if isScaleUp {
		return as.cooldownTracker.CanScaleUp(as.config.ScaleUpCooldown)
	}
	return as.cooldownTracker.CanScaleDown(as.config.ScaleDownCooldown)
}

// applyLimits applies min/max instance limits
func (as *AutoScaler) applyLimits(desired int) int {
	if desired < as.config.MinInstances {
		return as.config.MinInstances
	}
	if desired > as.config.MaxInstances {
		return as.config.MaxInstances
	}
	return desired
}

// initializeStrategy initializes the scaling strategy
func (as *AutoScaler) initializeStrategy() {
	switch as.config.Strategy {
	case "reactive":
		as.scaler = &ReactiveScalingStrategy{}
	case "predictive":
		as.scaler = &PredictiveScalingStrategy{
			logger: as.logger,
		}
	case "scheduled":
		as.scaler = &ScheduledScalingStrategy{
			schedules: as.config.Schedules,
		}
	default:
		as.scaler = &ReactiveScalingStrategy{}
	}
}

// GetStatus returns current scaling status
func (as *AutoScaler) GetStatus() map[string]interface{} {
	instances, _ := as.instanceManager.GetInstances(as.ctx)
	
	return map[string]interface{}{
		"running":           as.running.Load(),
		"current_instances": as.currentInstances.Load(),
		"desired_instances": as.desiredInstances.Load(),
		"min_instances":     as.config.MinInstances,
		"max_instances":     as.config.MaxInstances,
		"strategy":          as.config.Strategy,
		"instances":         instances,
	}
}

// ReactiveScalingStrategy implements reactive scaling based on current metrics
type ReactiveScalingStrategy struct{}

// Calculate calculates desired instances based on metrics
func (r *ReactiveScalingStrategy) Calculate(current int, metrics []Metric, config *ScalingConfig) int {
	if len(metrics) == 0 {
		return current
	}
	
	// Calculate aggregate metric value
	var value float64
	switch config.MetricAggregation {
	case "max":
		value = r.calculateMax(metrics)
	case "min":
		value = r.calculateMin(metrics)
	default: // avg
		value = r.calculateAverage(metrics)
	}
	
	// Determine scaling action
	if value > config.ScaleUpThreshold {
		// Scale up
		increment := int(math.Ceil(float64(current) * 0.2)) // 20% increase
		if increment < 1 {
			increment = 1
		}
		return current + increment
	} else if value < config.ScaleDownThreshold {
		// Scale down
		decrement := int(math.Floor(float64(current) * 0.1)) // 10% decrease
		if decrement < 1 && current > config.MinInstances {
			decrement = 1
		}
		return current - decrement
	}
	
	return current
}

func (r *ReactiveScalingStrategy) calculateAverage(metrics []Metric) float64 {
	sum := 0.0
	for _, m := range metrics {
		sum += m.Value
	}
	return sum / float64(len(metrics))
}

func (r *ReactiveScalingStrategy) calculateMax(metrics []Metric) float64 {
	max := metrics[0].Value
	for _, m := range metrics[1:] {
		if m.Value > max {
			max = m.Value
		}
	}
	return max
}

func (r *ReactiveScalingStrategy) calculateMin(metrics []Metric) float64 {
	min := metrics[0].Value
	for _, m := range metrics[1:] {
		if m.Value < min {
			min = m.Value
		}
	}
	return min
}

// PredictiveScalingStrategy implements predictive scaling using ML
type PredictiveScalingStrategy struct {
	logger       *zap.Logger
	predictor    *MetricPredictor
	historyMu    sync.RWMutex
	metricHistory []Metric
}

// Calculate calculates desired instances using prediction
func (p *PredictiveScalingStrategy) Calculate(current int, metrics []Metric, config *ScalingConfig) int {
	// Add to history
	p.historyMu.Lock()
	p.metricHistory = append(p.metricHistory, metrics...)
	if len(p.metricHistory) > 1000 {
		p.metricHistory = p.metricHistory[len(p.metricHistory)-1000:]
	}
	p.historyMu.Unlock()
	
	// Need enough history for prediction
	if len(p.metricHistory) < 100 {
		// Fall back to reactive
		reactive := &ReactiveScalingStrategy{}
		return reactive.Calculate(current, metrics, config)
	}
	
	// Predict future load
	prediction := p.predictFutureLoad(15 * time.Minute)
	
	// Calculate required instances for predicted load
	if prediction > config.ScaleUpThreshold {
		// Calculate how many instances needed
		capacityPerInstance := config.ScaleUpThreshold / float64(current)
		requiredInstances := int(math.Ceil(prediction / capacityPerInstance))
		return requiredInstances
	} else if prediction < config.ScaleDownThreshold {
		// Can reduce instances
		capacityPerInstance := config.ScaleDownThreshold / float64(current)
		requiredInstances := int(math.Ceil(prediction / capacityPerInstance))
		return requiredInstances
	}
	
	return current
}

// predictFutureLoad predicts future load
func (p *PredictiveScalingStrategy) predictFutureLoad(duration time.Duration) float64 {
	p.historyMu.RLock()
	defer p.historyMu.RUnlock()
	
	if len(p.metricHistory) < 10 {
		return 0
	}
	
	// Simple linear regression for demonstration
	// In production, use proper ML models
	
	// Calculate trend
	n := len(p.metricHistory)
	sumX, sumY, sumXY, sumX2 := 0.0, 0.0, 0.0, 0.0
	
	for i, metric := range p.metricHistory {
		x := float64(i)
		y := metric.Value
		sumX += x
		sumY += y
		sumXY += x * y
		sumX2 += x * x
	}
	
	// Calculate slope
	slope := (float64(n)*sumXY - sumX*sumY) / (float64(n)*sumX2 - sumX*sumX)
	intercept := (sumY - slope*sumX) / float64(n)
	
	// Predict future value
	futureX := float64(n) + duration.Seconds()/60 // Assuming 1-minute intervals
	prediction := slope*futureX + intercept
	
	// Add seasonality adjustment (simplified)
	hourOfDay := time.Now().Hour()
	seasonalFactor := 1.0
	if hourOfDay >= 9 && hourOfDay <= 17 { // Business hours
		seasonalFactor = 1.2
	} else if hourOfDay >= 22 || hourOfDay <= 6 { // Night hours
		seasonalFactor = 0.7
	}
	
	return prediction * seasonalFactor
}

// ScheduledScalingStrategy implements schedule-based scaling
type ScheduledScalingStrategy struct {
	schedules []ScalingSchedule
}

// Calculate returns desired instances based on schedule
func (s *ScheduledScalingStrategy) Calculate(current int, metrics []Metric, config *ScalingConfig) int {
	// Find active schedule
	now := time.Now()
	
	for _, schedule := range s.schedules {
		if s.isScheduleActive(schedule, now) {
			// Use schedule's min/max as target
			target := (schedule.MinInstances + schedule.MaxInstances) / 2
			return target
		}
	}
	
	// No active schedule, maintain current
	return current
}

// isScheduleActive checks if schedule is active
func (s *ScheduledScalingStrategy) isScheduleActive(schedule ScalingSchedule, now time.Time) bool {
	// This would parse cron expression and check
	// For now, simple hour-based check
	hour := now.Hour()
	
	// Example: business hours schedule
	if schedule.Name == "business_hours" {
		return hour >= 8 && hour <= 18
	}
	
	return false
}

// CooldownTracker tracks scaling cooldown periods
type CooldownTracker struct {
	lastScaleUp   time.Time
	lastScaleDown time.Time
	mu            sync.RWMutex
}

// NewCooldownTracker creates a new cooldown tracker
func NewCooldownTracker() *CooldownTracker {
	return &CooldownTracker{}
}

// CanScaleUp checks if scale up is allowed
func (ct *CooldownTracker) CanScaleUp(cooldown time.Duration) bool {
	ct.mu.RLock()
	defer ct.mu.RUnlock()
	
	return time.Since(ct.lastScaleUp) >= cooldown
}

// CanScaleDown checks if scale down is allowed
func (ct *CooldownTracker) CanScaleDown(cooldown time.Duration) bool {
	ct.mu.RLock()
	defer ct.mu.RUnlock()
	
	return time.Since(ct.lastScaleDown) >= cooldown
}

// RecordScaleUp records a scale up operation
func (ct *CooldownTracker) RecordScaleUp() {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	
	ct.lastScaleUp = time.Now()
}

// RecordScaleDown records a scale down operation
func (ct *CooldownTracker) RecordScaleDown() {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	
	ct.lastScaleDown = time.Now()
}

// MetricPredictor predicts future metric values
type MetricPredictor struct {
	model interface{} // ML model placeholder
}

// scheduleLoop handles scheduled scaling
func (as *AutoScaler) scheduleLoop() {
	defer as.wg.Done()
	
	// Check schedules every minute
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-as.ctx.Done():
			return
		case <-ticker.C:
			// Re-evaluate with schedule strategy
			if as.config.Strategy == "scheduled" {
				as.evaluate()
			}
		}
	}
}