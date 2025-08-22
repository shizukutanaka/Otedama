package optimization

import (
	"math"
	"sync"
	"time"

	"go.uber.org/zap"
)

type PowerManager struct {
	logger              *zap.Logger
	mu                  sync.RWMutex
	powerLimit          float64
	
	// Power profiles for different device types
	powerProfiles       map[string]*PowerProfile
	
	// Active power monitoring
	devicePowerStates   map[string]*DevicePowerState
	
	// Power management strategies
	powerStrategies     map[string]*PowerStrategy
	
	// Load balancing
	loadBalancer        *LoadBalancer
	
	// Power saving modes
	powerSavingModes    map[string]*PowerSavingMode
	
	// Metrics
	metrics            *PowerMetrics
}

type PowerProfile struct {
	DeviceType         string    `json:"device_type"`
	MaxPowerDraw       float64   `json:"max_power_draw"`
	IdlePower          float64   `json:"idle_power"`
	EfficiencyRating   float64   `json:"efficiency_rating"`
	PowerCurve         []PowerPoint `json:"power_curve"`
	VoltageRange       VoltageRange `json:"voltage_range"`
	PowerScalingFactor float64   `json:"power_scaling_factor"`
	CreatedAt          time.Time `json:"created_at"`
}

type PowerPoint struct {
	Performance        float64   `json:"performance"` // Percentage
	PowerConsumption   float64   `json:"power_consumption"` // Watts
	Efficiency         float64   `json:"efficiency"` // Performance per Watt
}

type VoltageRange struct {
	Min                float64   `json:"min"`
	Max                float64   `json:"max"`
	Default            float64   `json:"default"`
	Step               float64   `json:"step"`
}

type DevicePowerState struct {
	DeviceID           string              `json:"device_id"`
	CurrentPower       float64             `json:"current_power"`
	PowerLimit         float64             `json:"power_limit"`
	PowerBudget        float64             `json:"power_budget"`
	PowerHistory       []PowerReading      `json:"power_history"`
	PowerTrend         float64             `json:"power_trend"`
	Efficiency         float64             `json:"efficiency"`
	LastUpdate         time.Time           `json:"last_update"`
	PowerSavingMode    string              `json:"power_saving_mode"`
	LoadBalanceWeight  float64             `json:"load_balance_weight"`
	PowerAlerts        []PowerAlert        `json:"power_alerts"`
}

type PowerReading struct {
	Timestamp          time.Time `json:"timestamp"`
	Power              float64   `json:"power"`
	Voltage            float64   `json:"voltage"`
	Current            float64   `json:"current"`
	Frequency          float64   `json:"frequency"`
	Performance        float64   `json:"performance"`
	Efficiency         float64   `json:"efficiency"`
	Temperature        float64   `json:"temperature"`
}

type PowerStrategy struct {
	Name               string              `json:"name"`
	Description        string              `json:"description"`
	DeviceTypes        []string            `json:"device_types"`
	Steps              []PowerStep         `json:"steps"`
	Effectiveness      float64             `json:"effectiveness"`
	Priority           int                 `json:"priority"`
	Conditions         []PowerCondition    `json:"conditions"`
}

type PowerStep struct {
	PowerThreshold     float64             `json:"power_threshold"`
	Action             PowerAction         `json:"action"`
	Parameter          string              `json:"parameter"`
	Value              float64             `json:"value"`
	Duration           time.Duration       `json:"duration"`
	ExpectedSaving     float64             `json:"expected_saving"`
}

type PowerAction int

const (
	PowerActionVoltageReduction PowerAction = iota
	PowerActionFrequencyScaling
	PowerActionPowerCapping
	PowerActionLoadRebalancing
	PowerActionSleepMode
	PowerActionDynamicScaling
	PowerActionEfficiencyOptimization
)

type PowerCondition struct {
	Parameter          string              `json:"parameter"`
	Operator           string              `json:"operator"` // >, <, ==, >=, <=
	Value              float64             `json:"value"`
}

type LoadBalancer struct {
	logger             *zap.Logger
	devices            map[string]*LoadBalanceDevice
	totalPowerBudget   float64
	balancingStrategy  string
	lastBalance        time.Time
	balanceInterval    time.Duration
}

type LoadBalanceDevice struct {
	DeviceID           string    `json:"device_id"`
	CurrentPower       float64   `json:"current_power"`
	PowerCapacity      float64   `json:"power_capacity"`
	Efficiency         float64   `json:"efficiency"`
	Priority           int       `json:"priority"`
	Weight             float64   `json:"weight"`
	LastUpdate         time.Time `json:"last_update"`
}

type PowerSavingMode struct {
	Name               string              `json:"name"`
	Description        string              `json:"description"`
	PowerReduction     float64             `json:"power_reduction"` // Percentage
	PerformanceImpact  float64             `json:"performance_impact"`
	Conditions         []PowerCondition    `json:"conditions"`
	Actions            []PowerStep         `json:"actions"`
	AutoActivate       bool                `json:"auto_activate"`
	MinDuration        time.Duration       `json:"min_duration"`
}

type PowerAlert struct {
	Level              AlertLevel    `json:"level"`
	Message            string        `json:"message"`
	PowerValue         float64       `json:"power_value"`
	Threshold          float64       `json:"threshold"`
	Timestamp          time.Time     `json:"timestamp"`
	DeviceID           string        `json:"device_id"`
	ActionTaken        string        `json:"action_taken"`
}

type PowerMetrics struct {
	mu                     sync.RWMutex
	TotalPowerSaved        float64           `json:"total_power_saved"`
	AveragePowerDraw       float64           `json:"average_power_draw"`
	PeakPowerDraw          float64           `json:"peak_power_draw"`
	PowerEfficiency        float64           `json:"power_efficiency"`
	LoadBalanceOperations  uint64            `json:"load_balance_operations"`
	PowerOptimizations     uint64            `json:"power_optimizations"`
	PowerSavingActivations map[string]uint64 `json:"power_saving_activations"`
	UptimeWithPowerSaving  time.Duration     `json:"uptime_with_power_saving"`
	LastUpdate             time.Time         `json:"last_update"`
}

func NewPowerManager(logger *zap.Logger, powerLimit float64) *PowerManager {
	pm := &PowerManager{
		logger:            logger,
		powerLimit:        powerLimit,
		powerProfiles:     make(map[string]*PowerProfile),
		devicePowerStates: make(map[string]*DevicePowerState),
		powerStrategies:   make(map[string]*PowerStrategy),
		powerSavingModes:  make(map[string]*PowerSavingMode),
		metrics:           &PowerMetrics{
			PowerSavingActivations: make(map[string]uint64),
		},
	}
	
	// Initialize load balancer
	pm.loadBalancer = &LoadBalancer{
		logger:            logger,
		devices:           make(map[string]*LoadBalanceDevice),
		totalPowerBudget:  powerLimit,
		balancingStrategy: "efficiency_weighted",
		balanceInterval:   30 * time.Second,
	}
	
	// Initialize default power profiles
	pm.initializeDefaultProfiles()
	
	// Initialize power strategies
	pm.initializePowerStrategies()
	
	// Initialize power saving modes
	pm.initializePowerSavingModes()
	
	return pm
}

func (pm *PowerManager) initializeDefaultProfiles() {
	// GPU power profile
	pm.powerProfiles["GPU"] = &PowerProfile{
		DeviceType:       "GPU",
		MaxPowerDraw:     350.0,
		IdlePower:        25.0,
		EfficiencyRating: 0.85,
		PowerScalingFactor: 1.8, // Power scales as frequency^1.8
		VoltageRange: VoltageRange{
			Min:     0.8,
			Max:     1.2,
			Default: 1.0,
			Step:    0.025,
		},
		PowerCurve: []PowerPoint{
			{Performance: 0.0, PowerConsumption: 25.0, Efficiency: 0.0},
			{Performance: 25.0, PowerConsumption: 100.0, Efficiency: 0.25},
			{Performance: 50.0, PowerConsumption: 180.0, Efficiency: 0.28},
			{Performance: 75.0, PowerConsumption: 280.0, Efficiency: 0.27},
			{Performance: 100.0, PowerConsumption: 350.0, Efficiency: 0.29},
		},
		CreatedAt: time.Now(),
	}
	
	// CPU power profile
	pm.powerProfiles["CPU"] = &PowerProfile{
		DeviceType:       "CPU",
		MaxPowerDraw:     200.0,
		IdlePower:        15.0,
		EfficiencyRating: 0.9,
		PowerScalingFactor: 1.6,
		VoltageRange: VoltageRange{
			Min:     0.7,
			Max:     1.1,
			Default: 0.9,
			Step:    0.025,
		},
		PowerCurve: []PowerPoint{
			{Performance: 0.0, PowerConsumption: 15.0, Efficiency: 0.0},
			{Performance: 25.0, PowerConsumption: 50.0, Efficiency: 0.5},
			{Performance: 50.0, PowerConsumption: 100.0, Efficiency: 0.5},
			{Performance: 75.0, PowerConsumption: 150.0, Efficiency: 0.5},
			{Performance: 100.0, PowerConsumption: 200.0, Efficiency: 0.5},
		},
		CreatedAt: time.Now(),
	}
	
	// ASIC power profile
	pm.powerProfiles["ASIC"] = &PowerProfile{
		DeviceType:       "ASIC",
		MaxPowerDraw:     1500.0,
		IdlePower:        50.0,
		EfficiencyRating: 0.95,
		PowerScalingFactor: 1.5,
		VoltageRange: VoltageRange{
			Min:     0.8,
			Max:     1.0,
			Default: 0.9,
			Step:    0.01,
		},
		PowerCurve: []PowerPoint{
			{Performance: 0.0, PowerConsumption: 50.0, Efficiency: 0.0},
			{Performance: 50.0, PowerConsumption: 750.0, Efficiency: 0.067},
			{Performance: 80.0, PowerConsumption: 1200.0, Efficiency: 0.067},
			{Performance: 100.0, PowerConsumption: 1500.0, Efficiency: 0.067},
		},
		CreatedAt: time.Now(),
	}
}

func (pm *PowerManager) initializePowerStrategies() {
	// Efficient GPU power strategy
	pm.powerStrategies["efficient_gpu"] = &PowerStrategy{
		Name:         "Efficient GPU Power Management",
		Description:  "Optimize GPU power consumption for best efficiency",
		DeviceTypes:  []string{"GPU"},
		Effectiveness: 0.85,
		Priority:     1,
		Steps: []PowerStep{
			{
				PowerThreshold: 300.0,
				Action:         PowerActionVoltageReduction,
				Parameter:      "voltage",
				Value:          0.95, // Reduce to 95%
				Duration:       30 * time.Second,
				ExpectedSaving: 15.0, // 15W expected saving
			},
			{
				PowerThreshold: 320.0,
				Action:         PowerActionFrequencyScaling,
				Parameter:      "core_frequency",
				Value:          0.9, // Reduce to 90%
				Duration:       60 * time.Second,
				ExpectedSaving: 25.0,
			},
			{
				PowerThreshold: 340.0,
				Action:         PowerActionPowerCapping,
				Parameter:      "power_limit",
				Value:          300.0, // Cap at 300W
				Duration:       120 * time.Second,
				ExpectedSaving: 40.0,
			},
		},
		Conditions: []PowerCondition{
			{Parameter: "temperature", Operator: "<", Value: 90.0},
			{Parameter: "efficiency", Operator: ">", Value: 0.2},
		},
	}
	
	// Adaptive CPU power strategy
	pm.powerStrategies["adaptive_cpu"] = &PowerStrategy{
		Name:         "Adaptive CPU Power Management",
		Description:  "Dynamic CPU power scaling based on workload",
		DeviceTypes:  []string{"CPU"},
		Effectiveness: 0.9,
		Priority:     1,
		Steps: []PowerStep{
			{
				PowerThreshold: 150.0,
				Action:         PowerActionDynamicScaling,
				Parameter:      "frequency",
				Value:          0.95,
				Duration:       15 * time.Second,
				ExpectedSaving: 10.0,
			},
			{
				PowerThreshold: 180.0,
				Action:         PowerActionEfficiencyOptimization,
				Parameter:      "voltage_frequency",
				Value:          0.9,
				Duration:       30 * time.Second,
				ExpectedSaving: 20.0,
			},
		},
	}
}

func (pm *PowerManager) initializePowerSavingModes() {
	// Eco mode
	pm.powerSavingModes["eco_mode"] = &PowerSavingMode{
		Name:              "Eco Mode",
		Description:       "Reduce power consumption with minimal performance impact",
		PowerReduction:    20.0, // 20% power reduction
		PerformanceImpact: 10.0, // 10% performance impact
		AutoActivate:      true,
		MinDuration:       5 * time.Minute,
		Conditions: []PowerCondition{
			{Parameter: "total_power", Operator: ">", Value: pm.powerLimit * 0.9},
		},
		Actions: []PowerStep{
			{
				Action:         PowerActionVoltageReduction,
				Parameter:      "voltage",
				Value:          0.9,
				ExpectedSaving: 15.0,
			},
			{
				Action:         PowerActionFrequencyScaling,
				Parameter:      "frequency",
				Value:          0.95,
				ExpectedSaving: 10.0,
			},
		},
	}
	
	// Deep power saving
	pm.powerSavingModes["deep_save"] = &PowerSavingMode{
		Name:              "Deep Power Save",
		Description:       "Maximum power reduction for emergency situations",
		PowerReduction:    40.0,
		PerformanceImpact: 30.0,
		AutoActivate:      false,
		MinDuration:       10 * time.Minute,
		Actions: []PowerStep{
			{
				Action:         PowerActionPowerCapping,
				Parameter:      "power_limit",
				Value:          0.6, // 60% of normal limit
				ExpectedSaving: 40.0,
			},
			{
				Action:         PowerActionFrequencyScaling,
				Parameter:      "frequency",
				Value:          0.8,
				ExpectedSaving: 20.0,
			},
		},
	}
}

func (pm *PowerManager) ApplyPowerConstraints(device *DeviceState, settings DeviceSettings) DeviceSettings {
	adjustedSettings := settings
	
	profile := pm.getPowerProfile(device.Type)
	if profile == nil {
		return adjustedSettings
	}
	
	// Predict power consumption with new settings
	predictedPower := pm.predictPowerConsumption(device, settings)
	
	// Apply constraints if power would exceed limits
	if predictedPower > profile.MaxPowerDraw || predictedPower > pm.powerLimit {
		adjustedSettings = pm.applyPowerReduction(device, settings, predictedPower, profile)
		
		pm.logger.Warn("Power constraints applied",
			zap.String("device_id", device.ID),
			zap.Float64("predicted_power", predictedPower),
			zap.Float64("power_limit", pm.powerLimit))
	}
	
	return adjustedSettings
}

func (pm *PowerManager) predictPowerConsumption(device *DeviceState, settings DeviceSettings) float64 {
	profile := pm.getPowerProfile(device.Type)
	if profile == nil {
		return device.Power.CurrentPower
	}
	
	// Calculate power based on performance scaling
	performanceRatio := pm.calculatePerformanceRatio(device, settings)
	
	// Use power curve if available
	if len(profile.PowerCurve) > 0 {
		return pm.interpolatePowerFromCurve(profile.PowerCurve, performanceRatio*100)
	}
	
	// Fallback to simple scaling
	basePower := profile.IdlePower
	activePower := profile.MaxPowerDraw - profile.IdlePower
	
	// Power scales non-linearly with performance
	powerFactor := math.Pow(performanceRatio, profile.PowerScalingFactor)
	
	predictedPower := basePower + (activePower * powerFactor)
	
	// Apply power limit if set in settings
	if settings.PowerLimit > 0 {
		predictedPower = math.Min(predictedPower, float64(settings.PowerLimit))
	}
	
	return predictedPower
}

func (pm *PowerManager) calculatePerformanceRatio(device *DeviceState, settings DeviceSettings) float64 {
	// Calculate performance scaling based on settings changes
	intensityRatio := float64(settings.Intensity) / math.Max(1, float64(device.Settings.Intensity))
	
	clockRatio := 1.0
	if device.Settings.CoreClock > 0 {
		clockRatio = float64(settings.CoreClock) / float64(device.Settings.CoreClock)
	}
	
	// Combine ratios
	performanceRatio := intensityRatio*0.6 + clockRatio*0.4
	
	return math.Max(0.1, math.Min(1.2, performanceRatio)) // Clamp between 10% and 120%
}

func (pm *PowerManager) interpolatePowerFromCurve(curve []PowerPoint, performance float64) float64 {
	if len(curve) == 0 {
		return 0
	}
	
	// Find the two points to interpolate between
	if performance <= curve[0].Performance {
		return curve[0].PowerConsumption
	}
	
	if performance >= curve[len(curve)-1].Performance {
		return curve[len(curve)-1].PowerConsumption
	}
	
	// Linear interpolation
	for i := 0; i < len(curve)-1; i++ {
		if performance >= curve[i].Performance && performance <= curve[i+1].Performance {
			ratio := (performance - curve[i].Performance) / (curve[i+1].Performance - curve[i].Performance)
			return curve[i].PowerConsumption + ratio*(curve[i+1].PowerConsumption-curve[i].PowerConsumption)
		}
	}
	
	return curve[len(curve)-1].PowerConsumption
}

func (pm *PowerManager) applyPowerReduction(device *DeviceState, settings DeviceSettings, predictedPower float64, profile *PowerProfile) DeviceSettings {
	adjusted := settings
	targetPower := math.Min(profile.MaxPowerDraw, pm.powerLimit)
	
	powerExcess := predictedPower - targetPower
	if powerExcess <= 0 {
		return adjusted
	}
	
	// Apply power reduction strategies in order of preference
	
	// 1. Apply power limit directly if available
	if adjusted.PowerLimit == 0 || float64(adjusted.PowerLimit) > targetPower {
		adjusted.PowerLimit = int(targetPower)
		predictedPower = pm.predictPowerConsumption(device, adjusted)
		powerExcess = predictedPower - targetPower
	}
	
	// 2. Reduce core frequency if still needed
	if powerExcess > 0 && adjusted.CoreClock > 0 {
		// Calculate required frequency reduction
		freqReduction := math.Min(0.2, powerExcess/50.0) // Max 20% reduction
		newCoreClock := float64(adjusted.CoreClock) * (1 - freqReduction)
		adjusted.CoreClock = int(math.Max(float64(device.Settings.CoreClock)*0.8, newCoreClock))
		
		predictedPower = pm.predictPowerConsumption(device, adjusted)
		powerExcess = predictedPower - targetPower
	}
	
	// 3. Reduce intensity as last resort
	if powerExcess > 0 {
		intensityReduction := math.Min(0.3, powerExcess/30.0) // Max 30% reduction
		newIntensity := float64(adjusted.Intensity) * (1 - intensityReduction)
		adjusted.Intensity = int(math.Max(1, newIntensity))
	}
	
	return adjusted
}

func (pm *PowerManager) MonitorPower(deviceID string, powerReading PowerReading) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	powerState, exists := pm.devicePowerStates[deviceID]
	if !exists {
		powerState = &DevicePowerState{
			DeviceID:     deviceID,
			PowerHistory: make([]PowerReading, 0),
			PowerAlerts:  make([]PowerAlert, 0),
		}
		pm.devicePowerStates[deviceID] = powerState
	}
	
	// Update current state
	powerState.CurrentPower = powerReading.Power
	powerState.Efficiency = powerReading.Efficiency
	powerState.LastUpdate = powerReading.Timestamp
	
	// Add to history
	powerState.PowerHistory = append(powerState.PowerHistory, powerReading)
	
	// Limit history size
	maxHistory := 100
	if len(powerState.PowerHistory) > maxHistory {
		powerState.PowerHistory = powerState.PowerHistory[len(powerState.PowerHistory)-maxHistory:]
	}
	
	// Calculate power trend
	powerState.PowerTrend = pm.calculatePowerTrend(powerState.PowerHistory)
	
	// Check for power alerts
	pm.checkPowerAlerts(deviceID, powerState, powerReading)
	
	// Apply power optimization if needed
	pm.applyPowerOptimizationIfNeeded(deviceID, powerState)
	
	// Update load balancer
	pm.updateLoadBalancer(deviceID, powerReading)
	
	// Update metrics
	pm.updatePowerMetrics(powerReading)
}

func (pm *PowerManager) calculatePowerTrend(history []PowerReading) float64 {
	if len(history) < 2 {
		return 0
	}
	
	// Calculate power trend over recent readings
	recentCount := 10
	if len(history) < recentCount {
		recentCount = len(history)
	}
	
	recent := history[len(history)-recentCount:]
	
	// Simple linear regression
	n := float64(len(recent))
	sumX := n * (n - 1) / 2
	sumY := 0.0
	sumXY := 0.0
	sumX2 := n * (n - 1) * (2*n - 1) / 6
	
	for i, reading := range recent {
		x := float64(i)
		y := reading.Power
		sumY += y
		sumXY += x * y
	}
	
	denominator := n*sumX2 - sumX*sumX
	if denominator == 0 {
		return 0
	}
	
	trend := (n*sumXY - sumX*sumY) / denominator
	return trend
}

func (pm *PowerManager) checkPowerAlerts(deviceID string, powerState *DevicePowerState, reading PowerReading) {
	alerts := []PowerAlert{}
	
	// Check power limit alerts
	if reading.Power > pm.powerLimit {
		alert := PowerAlert{
			Level:      AlertLevelWarning,
			Message:    "Power consumption above global limit",
			PowerValue: reading.Power,
			Threshold:  pm.powerLimit,
			Timestamp:  reading.Timestamp,
			DeviceID:   deviceID,
		}
		alerts = append(alerts, alert)
	}
	
	// Check device-specific power limits
	profile := pm.getPowerProfile(deviceID)
	if profile != nil && reading.Power > profile.MaxPowerDraw {
		alert := PowerAlert{
			Level:      AlertLevelCritical,
			Message:    "Power consumption above device maximum",
			PowerValue: reading.Power,
			Threshold:  profile.MaxPowerDraw,
			Timestamp:  reading.Timestamp,
			DeviceID:   deviceID,
		}
		alerts = append(alerts, alert)
	}
	
	// Check efficiency alerts
	if reading.Efficiency < 0.5 {
		alert := PowerAlert{
			Level:      AlertLevelWarning,
			Message:    "Low power efficiency detected",
			PowerValue: reading.Efficiency,
			Threshold:  0.5,
			Timestamp:  reading.Timestamp,
			DeviceID:   deviceID,
		}
		alerts = append(alerts, alert)
	}
	
	// Add alerts to device power state
	powerState.PowerAlerts = append(powerState.PowerAlerts, alerts...)
	
	// Limit alert history
	maxAlerts := 50
	if len(powerState.PowerAlerts) > maxAlerts {
		powerState.PowerAlerts = powerState.PowerAlerts[len(powerState.PowerAlerts)-maxAlerts:]
	}
}

func (pm *PowerManager) applyPowerOptimizationIfNeeded(deviceID string, powerState *DevicePowerState) {
	if powerState.CurrentPower <= pm.powerLimit*0.9 {
		return // No optimization needed
	}
	
	// Apply power saving strategies
	pm.logger.Info("Applying power optimization",
		zap.String("device_id", deviceID),
		zap.Float64("current_power", powerState.CurrentPower),
		zap.Float64("power_limit", pm.powerLimit))
	
	// This would trigger actual power optimization measures
	pm.metrics.mu.Lock()
	pm.metrics.PowerOptimizations++
	pm.metrics.mu.Unlock()
}

func (pm *PowerManager) updateLoadBalancer(deviceID string, reading PowerReading) {
	pm.loadBalancer.devices[deviceID] = &LoadBalanceDevice{
		DeviceID:      deviceID,
		CurrentPower:  reading.Power,
		PowerCapacity: pm.powerLimit, // Simplified
		Efficiency:    reading.Efficiency,
		Priority:      1,
		Weight:        reading.Efficiency, // Weight by efficiency
		LastUpdate:    reading.Timestamp,
	}
	
	// Perform load balancing if needed
	if time.Since(pm.loadBalancer.lastBalance) > pm.loadBalancer.balanceInterval {
		pm.performLoadBalancing()
	}
}

func (pm *PowerManager) performLoadBalancing() {
	if len(pm.loadBalancer.devices) < 2 {
		return // Need at least 2 devices to balance
	}
	
	totalPower := 0.0
	totalWeight := 0.0
	
	// Calculate totals
	for _, device := range pm.loadBalancer.devices {
		totalPower += device.CurrentPower
		totalWeight += device.Weight
	}
	
	// Check if rebalancing is needed
	if totalPower <= pm.loadBalancer.totalPowerBudget*0.95 {
		return // Within acceptable limits
	}
	
	// Redistribute power based on efficiency weights
	for deviceID, device := range pm.loadBalancer.devices {
		targetPower := (device.Weight / totalWeight) * pm.loadBalancer.totalPowerBudget
		
		if device.CurrentPower > targetPower*1.1 { // 10% tolerance
			pm.logger.Info("Load balancing adjustment needed",
				zap.String("device_id", deviceID),
				zap.Float64("current_power", device.CurrentPower),
				zap.Float64("target_power", targetPower))
		}
	}
	
	pm.loadBalancer.lastBalance = time.Now()
	
	pm.metrics.mu.Lock()
	pm.metrics.LoadBalanceOperations++
	pm.metrics.mu.Unlock()
}

func (pm *PowerManager) updatePowerMetrics(reading PowerReading) {
	pm.metrics.mu.Lock()
	defer pm.metrics.mu.Unlock()
	
	// Update average power draw
	if pm.metrics.AveragePowerDraw == 0 {
		pm.metrics.AveragePowerDraw = reading.Power
	} else {
		pm.metrics.AveragePowerDraw = (pm.metrics.AveragePowerDraw*0.95 + reading.Power*0.05)
	}
	
	// Update peak power draw
	if reading.Power > pm.metrics.PeakPowerDraw {
		pm.metrics.PeakPowerDraw = reading.Power
	}
	
	// Update power efficiency
	if reading.Efficiency > 0 {
		if pm.metrics.PowerEfficiency == 0 {
			pm.metrics.PowerEfficiency = reading.Efficiency
		} else {
			pm.metrics.PowerEfficiency = (pm.metrics.PowerEfficiency*0.95 + reading.Efficiency*0.05)
		}
	}
	
	pm.metrics.LastUpdate = reading.Timestamp
}

func (pm *PowerManager) getPowerProfile(deviceType string) *PowerProfile {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	return pm.powerProfiles[deviceType]
}

func (pm *PowerManager) ActivatePowerSavingMode(modeName string, deviceID string) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	mode, exists := pm.powerSavingModes[modeName]
	if !exists {
		return fmt.Errorf("power saving mode not found: %s", modeName)
	}
	
	powerState, exists := pm.devicePowerStates[deviceID]
	if !exists {
		return fmt.Errorf("device not found: %s", deviceID)
	}
	
	powerState.PowerSavingMode = modeName
	
	pm.logger.Info("Power saving mode activated",
		zap.String("device_id", deviceID),
		zap.String("mode", modeName),
		zap.Float64("expected_reduction", mode.PowerReduction))
	
	// Update metrics
	pm.metrics.mu.Lock()
	pm.metrics.PowerSavingActivations[modeName]++
	pm.metrics.mu.Unlock()
	
	return nil
}

func (pm *PowerManager) GetDevicePowerState(deviceID string) (*DevicePowerState, bool) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	state, exists := pm.devicePowerStates[deviceID]
	if !exists {
		return nil, false
	}
	
	// Return copy
	stateCopy := *state
	stateCopy.PowerHistory = append([]PowerReading(nil), state.PowerHistory...)
	stateCopy.PowerAlerts = append([]PowerAlert(nil), state.PowerAlerts...)
	
	return &stateCopy, true
}

func (pm *PowerManager) GetPowerMetrics() *PowerMetrics {
	pm.metrics.mu.RLock()
	defer pm.metrics.mu.RUnlock()
	
	metricsCopy := *pm.metrics
	metricsCopy.PowerSavingActivations = make(map[string]uint64)
	for k, v := range pm.metrics.PowerSavingActivations {
		metricsCopy.PowerSavingActivations[k] = v
	}
	
	return &metricsCopy
}

func (pm *PowerManager) GetPowerSummary() map[string]interface{} {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	totalDevices := len(pm.devicePowerStates)
	totalPower := 0.0
	devicesOverLimit := 0
	averageEfficiency := 0.0
	
	for _, state := range pm.devicePowerStates {
		totalPower += state.CurrentPower
		if state.CurrentPower > pm.powerLimit/float64(totalDevices) {
			devicesOverLimit++
		}
		averageEfficiency += state.Efficiency
	}
	
	if totalDevices > 0 {
		averageEfficiency /= float64(totalDevices)
	}
	
	return map[string]interface{}{
		"total_devices":         totalDevices,
		"total_power":          totalPower,
		"power_limit":          pm.powerLimit,
		"power_utilization":    totalPower / pm.powerLimit * 100,
		"devices_over_limit":   devicesOverLimit,
		"average_efficiency":   averageEfficiency,
		"load_balance_devices": len(pm.loadBalancer.devices),
	}
}