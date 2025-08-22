package optimization

import (
	"math"
	"sync"
	"time"

	"go.uber.org/zap"
)

type ThermalManager struct {
	logger              *zap.Logger
	mu                  sync.RWMutex
	thermalThreshold    float64
	
	// Thermal profiles for different device types
	thermalProfiles     map[string]*ThermalProfile
	
	// Active thermal monitoring
	deviceThermals      map[string]*DeviceThermalState
	
	// Thermal management strategies
	coolingStrategies   map[string]*CoolingStrategy
	
	// Emergency procedures
	emergencyThreshold  float64
	emergencyActions    []EmergencyAction
	
	// Metrics
	metrics            *ThermalMetrics
}

type ThermalProfile struct {
	DeviceType         string    `json:"device_type"`
	MaxSafeTemp        float64   `json:"max_safe_temp"`
	CriticalTemp       float64   `json:"critical_temp"`
	TargetTemp         float64   `json:"target_temp"`
	ThermalTimeConstant float64  `json:"thermal_time_constant"` // seconds
	CoolingEfficiency  float64   `json:"cooling_efficiency"`
	PowerTempCoeff     float64   `json:"power_temp_coeff"`     // °C per Watt
	CreatedAt          time.Time `json:"created_at"`
}

type DeviceThermalState struct {
	DeviceID           string              `json:"device_id"`
	CurrentTemp        float64             `json:"current_temp"`
	TargetTemp         float64             `json:"target_temp"`
	TempHistory        []TempReading       `json:"temp_history"`
	ThermalTrend       float64             `json:"thermal_trend"`
	LastUpdate         time.Time           `json:"last_update"`
	ThrottleLevel      int                 `json:"throttle_level"`
	CoolingStrategy    string              `json:"cooling_strategy"`
	EmergencyMode      bool                `json:"emergency_mode"`
	ThermalAlerts      []ThermalAlert      `json:"thermal_alerts"`
}

type TempReading struct {
	Timestamp          time.Time `json:"timestamp"`
	CoreTemp           float64   `json:"core_temp"`
	MemoryTemp         float64   `json:"memory_temp"`
	VRMTemp            float64   `json:"vrm_temp"`
	AmbientTemp        float64   `json:"ambient_temp"`
	FanRPM             int       `json:"fan_rpm"`
	PowerDraw          float64   `json:"power_draw"`
}

type CoolingStrategy struct {
	Name               string              `json:"name"`
	Description        string              `json:"description"`
	DeviceTypes        []string            `json:"device_types"`
	Steps              []CoolingStep       `json:"steps"`
	Effectiveness      float64             `json:"effectiveness"`
	ResponseTime       time.Duration       `json:"response_time"`
	Priority           int                 `json:"priority"`
}

type CoolingStep struct {
	TempThreshold      float64             `json:"temp_threshold"`
	Action             CoolingAction       `json:"action"`
	Parameter          string              `json:"parameter"`
	Value              float64             `json:"value"`
	Duration           time.Duration       `json:"duration"`
	Reversible         bool                `json:"reversible"`
}

type CoolingAction int

const (
	CoolingActionFanSpeed CoolingAction = iota
	CoolingActionPowerLimit
	CoolingActionClockReduction
	CoolingActionIntensityReduction
	CoolingActionVoltageReduction
	CoolingActionTemporaryStop
	CoolingActionEmergencyShutdown
)

type EmergencyAction struct {
	Name               string        `json:"name"`
	TriggerTemp        float64       `json:"trigger_temp"`
	Action             func(deviceID string) error `json:"-"`
	Description        string        `json:"description"`
	Severity           int           `json:"severity"`
}

type ThermalAlert struct {
	Level              AlertLevel    `json:"level"`
	Message            string        `json:"message"`
	Temperature        float64       `json:"temperature"`
	Threshold          float64       `json:"threshold"`
	Timestamp          time.Time     `json:"timestamp"`
	DeviceID           string        `json:"device_id"`
	ActionTaken        string        `json:"action_taken"`
}

type AlertLevel int

const (
	AlertLevelInfo AlertLevel = iota
	AlertLevelWarning
	AlertLevelCritical
	AlertLevelEmergency
)

type ThermalMetrics struct {
	mu                     sync.RWMutex
	TotalThrottleEvents    uint64            `json:"total_throttle_events"`
	EmergencyShutdowns     uint64            `json:"emergency_shutdowns"`
	AverageTemp            float64           `json:"average_temp"`
	MaxRecordedTemp        float64           `json:"max_recorded_temp"`
	CoolingActionsApplied  map[CoolingAction]uint64 `json:"cooling_actions_applied"`
	ThermalAlertsGenerated uint64            `json:"thermal_alerts_generated"`
	UptimeImpact           time.Duration     `json:"uptime_impact"`
	LastUpdate             time.Time         `json:"last_update"`
}

func NewThermalManager(logger *zap.Logger, thermalThreshold float64) *ThermalManager {
	tm := &ThermalManager{
		logger:           logger,
		thermalThreshold: thermalThreshold,
		emergencyThreshold: thermalThreshold + 15, // 15°C above normal threshold
		thermalProfiles:  make(map[string]*ThermalProfile),
		deviceThermals:   make(map[string]*DeviceThermalState),
		coolingStrategies: make(map[string]*CoolingStrategy),
		metrics:          &ThermalMetrics{
			CoolingActionsApplied: make(map[CoolingAction]uint64),
		},
	}
	
	// Initialize default thermal profiles
	tm.initializeDefaultProfiles()
	
	// Initialize cooling strategies
	tm.initializeCoolingStrategies()
	
	// Initialize emergency actions
	tm.initializeEmergencyActions()
	
	return tm
}

func (tm *ThermalManager) initializeDefaultProfiles() {
	// GPU thermal profile
	tm.thermalProfiles["GPU"] = &ThermalProfile{
		DeviceType:          "GPU",
		MaxSafeTemp:         85.0,
		CriticalTemp:        95.0,
		TargetTemp:          75.0,
		ThermalTimeConstant: 30.0,
		CoolingEfficiency:   0.8,
		PowerTempCoeff:      0.3, // 0.3°C per Watt
		CreatedAt:           time.Now(),
	}
	
	// CPU thermal profile
	tm.thermalProfiles["CPU"] = &ThermalProfile{
		DeviceType:          "CPU",
		MaxSafeTemp:         80.0,
		CriticalTemp:        90.0,
		TargetTemp:          70.0,
		ThermalTimeConstant: 20.0,
		CoolingEfficiency:   0.9,
		PowerTempCoeff:      0.4,
		CreatedAt:           time.Now(),
	}
	
	// ASIC thermal profile
	tm.thermalProfiles["ASIC"] = &ThermalProfile{
		DeviceType:          "ASIC",
		MaxSafeTemp:         90.0,
		CriticalTemp:        100.0,
		TargetTemp:          80.0,
		ThermalTimeConstant: 45.0,
		CoolingEfficiency:   0.7,
		PowerTempCoeff:      0.25,
		CreatedAt:           time.Now(),
	}
}

func (tm *ThermalManager) initializeCoolingStrategies() {
	// Progressive GPU cooling strategy
	tm.coolingStrategies["progressive_gpu"] = &CoolingStrategy{
		Name:         "Progressive GPU Cooling",
		Description:  "Gradual cooling steps for GPU devices",
		DeviceTypes:  []string{"GPU"},
		Effectiveness: 0.85,
		ResponseTime: 5 * time.Second,
		Priority:     1,
		Steps: []CoolingStep{
			{
				TempThreshold: 80.0,
				Action:        CoolingActionFanSpeed,
				Parameter:     "fan_speed",
				Value:         85.0, // Increase to 85%
				Duration:      30 * time.Second,
				Reversible:    true,
			},
			{
				TempThreshold: 85.0,
				Action:        CoolingActionPowerLimit,
				Parameter:     "power_limit",
				Value:         0.9, // Reduce to 90%
				Duration:      60 * time.Second,
				Reversible:    true,
			},
			{
				TempThreshold: 90.0,
				Action:        CoolingActionClockReduction,
				Parameter:     "core_clock",
				Value:         0.85, // Reduce to 85%
				Duration:      120 * time.Second,
				Reversible:    true,
			},
			{
				TempThreshold: 95.0,
				Action:        CoolingActionEmergencyShutdown,
				Parameter:     "emergency",
				Value:         1.0,
				Duration:      0,
				Reversible:    false,
			},
		},
	}
	
	// Aggressive CPU cooling strategy
	tm.coolingStrategies["aggressive_cpu"] = &CoolingStrategy{
		Name:         "Aggressive CPU Cooling",
		Description:  "Fast response cooling for CPU devices",
		DeviceTypes:  []string{"CPU"},
		Effectiveness: 0.9,
		ResponseTime: 3 * time.Second,
		Priority:     1,
		Steps: []CoolingStep{
			{
				TempThreshold: 75.0,
				Action:        CoolingActionIntensityReduction,
				Parameter:     "intensity",
				Value:         0.8, // Reduce to 80%
				Duration:      15 * time.Second,
				Reversible:    true,
			},
			{
				TempThreshold: 80.0,
				Action:        CoolingActionClockReduction,
				Parameter:     "core_clock",
				Value:         0.9,
				Duration:      30 * time.Second,
				Reversible:    true,
			},
			{
				TempThreshold: 85.0,
				Action:        CoolingActionTemporaryStop,
				Parameter:     "mining",
				Value:         1.0,
				Duration:      60 * time.Second,
				Reversible:    true,
			},
		},
	}
	
	// Conservative ASIC cooling
	tm.coolingStrategies["conservative_asic"] = &CoolingStrategy{
		Name:         "Conservative ASIC Cooling",
		Description:  "Gentle cooling approach for ASIC devices",
		DeviceTypes:  []string{"ASIC"},
		Effectiveness: 0.75,
		ResponseTime: 10 * time.Second,
		Priority:     1,
		Steps: []CoolingStep{
			{
				TempThreshold: 85.0,
				Action:        CoolingActionFanSpeed,
				Parameter:     "fan_speed",
				Value:         95.0,
				Duration:      60 * time.Second,
				Reversible:    true,
			},
			{
				TempThreshold: 90.0,
				Action:        CoolingActionClockReduction,
				Parameter:     "frequency",
				Value:         0.95,
				Duration:      120 * time.Second,
				Reversible:    true,
			},
			{
				TempThreshold: 95.0,
				Action:        CoolingActionTemporaryStop,
				Parameter:     "mining",
				Value:         1.0,
				Duration:      300 * time.Second,
				Reversible:    true,
			},
		},
	}
}

func (tm *ThermalManager) initializeEmergencyActions() {
	tm.emergencyActions = []EmergencyAction{
		{
			Name:        "Critical Temperature Shutdown",
			TriggerTemp: 100.0,
			Description: "Emergency shutdown at critical temperature",
			Severity:    5,
			Action: func(deviceID string) error {
				// Implementation would stop mining immediately
				tm.logger.Error("Emergency thermal shutdown triggered",
					zap.String("device_id", deviceID),
					zap.Float64("trigger_temp", 100.0))
				return nil
			},
		},
		{
			Name:        "Thermal Runaway Protection",
			TriggerTemp: 105.0,
			Description: "Hardware protection activation",
			Severity:    10,
			Action: func(deviceID string) error {
				// Implementation would trigger hardware safety systems
				tm.logger.Error("Thermal runaway protection activated",
					zap.String("device_id", deviceID))
				return nil
			},
		},
	}
}

func (tm *ThermalManager) ApplyThermalConstraints(device *DeviceState, settings DeviceSettings) DeviceSettings {
	adjustedSettings := settings
	
	profile := tm.getThermalProfile(device.Type)
	if profile == nil {
		return adjustedSettings
	}
	
	// Predict temperature with new settings
	predictedTemp := tm.predictTemperature(device, settings)
	
	// Apply constraints if temperature would exceed safe limits
	if predictedTemp > profile.MaxSafeTemp {
		adjustedSettings = tm.applyThermalReduction(device, settings, predictedTemp, profile)
		
		tm.logger.Warn("Thermal constraints applied",
			zap.String("device_id", device.ID),
			zap.Float64("predicted_temp", predictedTemp),
			zap.Float64("max_safe_temp", profile.MaxSafeTemp))
	}
	
	return adjustedSettings
}

func (tm *ThermalManager) predictTemperature(device *DeviceState, settings DeviceSettings) float64 {
	profile := tm.getThermalProfile(device.Type)
	if profile == nil {
		return device.Thermal.CoreTemp
	}
	
	// Estimate power consumption with new settings
	predictedPower := tm.estimatePowerConsumption(device, settings)
	powerIncrease := predictedPower - device.Power.CurrentPower
	
	// Calculate temperature increase based on power
	tempIncrease := powerIncrease * profile.PowerTempCoeff
	
	// Factor in cooling efficiency
	coolingFactor := 1.0
	if settings.FanSpeed > device.Settings.FanSpeed {
		fanIncrease := float64(settings.FanSpeed-device.Settings.FanSpeed) / 100.0
		coolingFactor = 1.0 - (fanIncrease * profile.CoolingEfficiency * 0.1)
	}
	
	predictedTemp := device.Thermal.CoreTemp + (tempIncrease * coolingFactor)
	
	// Account for ambient temperature and thermal time constant
	ambientOffset := tm.getAmbientTemperatureOffset()
	predictedTemp += ambientOffset
	
	return math.Max(20.0, predictedTemp) // Minimum room temperature
}

func (tm *ThermalManager) estimatePowerConsumption(device *DeviceState, settings DeviceSettings) float64 {
	basePower := device.Power.CurrentPower
	
	// Power scaling factors
	intensityFactor := float64(settings.Intensity) / math.Max(1, float64(device.Settings.Intensity))
	
	clockFactor := 1.0
	if device.Settings.CoreClock > 0 {
		clockFactor = float64(settings.CoreClock) / float64(device.Settings.CoreClock)
	}
	
	// Power consumption typically scales quadratically with clock speed
	powerFactor := intensityFactor*0.5 + math.Pow(clockFactor, 1.8)*0.5
	
	estimatedPower := basePower * powerFactor
	
	// Apply power limit if set
	if settings.PowerLimit > 0 {
		estimatedPower = math.Min(estimatedPower, float64(settings.PowerLimit))
	}
	
	return estimatedPower
}

func (tm *ThermalManager) applyThermalReduction(device *DeviceState, settings DeviceSettings, predictedTemp float64, profile *ThermalProfile) DeviceSettings {
	adjusted := settings
	
	// Calculate how much we need to reduce temperature
	tempExcess := predictedTemp - profile.MaxSafeTemp
	reductionNeeded := tempExcess / profile.PowerTempCoeff // Convert to power reduction needed
	
	// Apply reductions in order of preference
	
	// 1. Increase fan speed first (if possible)
	if adjusted.FanSpeed < 100 {
		maxFanIncrease := 100 - adjusted.FanSpeed
		fanIncrease := math.Min(float64(maxFanIncrease), tempExcess*5) // 5% fan per °C
		adjusted.FanSpeed = int(float64(adjusted.FanSpeed) + fanIncrease)
		
		// Recalculate temperature after fan adjustment
		predictedTemp = tm.predictTemperature(device, adjusted)
		tempExcess = predictedTemp - profile.MaxSafeTemp
	}
	
	// 2. Reduce power limit if still too hot
	if tempExcess > 0 && adjusted.PowerLimit > 0 {
		powerReduction := math.Min(0.2, tempExcess*0.05) // Max 20% reduction
		newPowerLimit := float64(adjusted.PowerLimit) * (1 - powerReduction)
		adjusted.PowerLimit = int(math.Max(50, newPowerLimit)) // Minimum 50W
		
		predictedTemp = tm.predictTemperature(device, adjusted)
		tempExcess = predictedTemp - profile.MaxSafeTemp
	}
	
	// 3. Reduce intensity if still needed
	if tempExcess > 0 {
		intensityReduction := math.Min(0.3, tempExcess*0.1) // Max 30% reduction
		newIntensity := float64(adjusted.Intensity) * (1 - intensityReduction)
		adjusted.Intensity = int(math.Max(1, newIntensity))
		
		predictedTemp = tm.predictTemperature(device, adjusted)
		tempExcess = predictedTemp - profile.MaxSafeTemp
	}
	
	// 4. Reduce clocks as last resort
	if tempExcess > 0 {
		clockReduction := math.Min(0.15, tempExcess*0.05) // Max 15% reduction
		
		if adjusted.CoreClock > 0 {
			newCoreClock := float64(adjusted.CoreClock) * (1 - clockReduction)
			adjusted.CoreClock = int(newCoreClock)
		}
		
		if adjusted.MemoryClock > 0 && device.Type == "GPU" {
			newMemClock := float64(adjusted.MemoryClock) * (1 - clockReduction)
			adjusted.MemoryClock = int(newMemClock)
		}
	}
	
	return adjusted
}

func (tm *ThermalManager) MonitorTemperature(deviceID string, tempReading TempReading) {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	
	thermal, exists := tm.deviceThermals[deviceID]
	if !exists {
		thermal = &DeviceThermalState{
			DeviceID:     deviceID,
			TempHistory:  make([]TempReading, 0),
			ThermalAlerts: make([]ThermalAlert, 0),
		}
		tm.deviceThermals[deviceID] = thermal
	}
	
	// Update current state
	thermal.CurrentTemp = tempReading.CoreTemp
	thermal.LastUpdate = tempReading.Timestamp
	
	// Add to history
	thermal.TempHistory = append(thermal.TempHistory, tempReading)
	
	// Limit history size
	maxHistory := 100
	if len(thermal.TempHistory) > maxHistory {
		thermal.TempHistory = thermal.TempHistory[len(thermal.TempHistory)-maxHistory:]
	}
	
	// Calculate thermal trend
	thermal.ThermalTrend = tm.calculateThermalTrend(thermal.TempHistory)
	
	// Check for thermal alerts
	tm.checkThermalAlerts(deviceID, thermal, tempReading)
	
	// Apply cooling if needed
	tm.applyCoolingIfNeeded(deviceID, thermal)
	
	// Update metrics
	tm.updateThermalMetrics(tempReading)
}

func (tm *ThermalManager) calculateThermalTrend(history []TempReading) float64 {
	if len(history) < 2 {
		return 0
	}
	
	// Calculate temperature trend over recent readings
	recentCount := 10
	if len(history) < recentCount {
		recentCount = len(history)
	}
	
	recent := history[len(history)-recentCount:]
	
	// Simple linear regression to find trend
	n := float64(len(recent))
	sumX := n * (n - 1) / 2 // Sum of indices
	sumY := 0.0
	sumXY := 0.0
	sumX2 := n * (n - 1) * (2*n - 1) / 6
	
	for i, reading := range recent {
		x := float64(i)
		y := reading.CoreTemp
		sumY += y
		sumXY += x * y
	}
	
	// Calculate slope (trend)
	denominator := n*sumX2 - sumX*sumX
	if denominator == 0 {
		return 0
	}
	
	trend := (n*sumXY - sumX*sumY) / denominator
	return trend
}

func (tm *ThermalManager) checkThermalAlerts(deviceID string, thermal *DeviceThermalState, reading TempReading) {
	alerts := []ThermalAlert{}
	
	// Check warning thresholds
	if reading.CoreTemp > tm.thermalThreshold {
		alert := ThermalAlert{
			Level:       AlertLevelWarning,
			Message:     "Temperature above threshold",
			Temperature: reading.CoreTemp,
			Threshold:   tm.thermalThreshold,
			Timestamp:   reading.Timestamp,
			DeviceID:    deviceID,
		}
		alerts = append(alerts, alert)
	}
	
	// Check critical thresholds
	if reading.CoreTemp > tm.emergencyThreshold {
		alert := ThermalAlert{
			Level:       AlertLevelCritical,
			Message:     "Temperature in critical range",
			Temperature: reading.CoreTemp,
			Threshold:   tm.emergencyThreshold,
			Timestamp:   reading.Timestamp,
			DeviceID:    deviceID,
		}
		alerts = append(alerts, alert)
	}
	
	// Check emergency thresholds
	for _, emergency := range tm.emergencyActions {
		if reading.CoreTemp > emergency.TriggerTemp {
			alert := ThermalAlert{
				Level:       AlertLevelEmergency,
				Message:     emergency.Description,
				Temperature: reading.CoreTemp,
				Threshold:   emergency.TriggerTemp,
				Timestamp:   reading.Timestamp,
				DeviceID:    deviceID,
				ActionTaken: emergency.Name,
			}
			alerts = append(alerts, alert)
			
			// Trigger emergency action
			if err := emergency.Action(deviceID); err != nil {
				tm.logger.Error("Emergency action failed",
					zap.String("device_id", deviceID),
					zap.String("action", emergency.Name),
					zap.Error(err))
			}
		}
	}
	
	// Add alerts to device thermal state
	thermal.ThermalAlerts = append(thermal.ThermalAlerts, alerts...)
	
	// Limit alert history
	maxAlerts := 50
	if len(thermal.ThermalAlerts) > maxAlerts {
		thermal.ThermalAlerts = thermal.ThermalAlerts[len(thermal.ThermalAlerts)-maxAlerts:]
	}
	
	// Update metrics
	tm.metrics.mu.Lock()
	tm.metrics.ThermalAlertsGenerated += uint64(len(alerts))
	tm.metrics.mu.Unlock()
}

func (tm *ThermalManager) applyCoolingIfNeeded(deviceID string, thermal *DeviceThermalState) {
	if thermal.CurrentTemp <= tm.thermalThreshold {
		return
	}
	
	// Find appropriate cooling strategy
	// This would be implemented to actually apply cooling measures
	thermal.CoolingStrategy = "progressive_cooling"
	
	tm.logger.Info("Applying thermal cooling",
		zap.String("device_id", deviceID),
		zap.Float64("temperature", thermal.CurrentTemp),
		zap.String("strategy", thermal.CoolingStrategy))
}

func (tm *ThermalManager) updateThermalMetrics(reading TempReading) {
	tm.metrics.mu.Lock()
	defer tm.metrics.mu.Unlock()
	
	// Update average temperature
	if tm.metrics.AverageTemp == 0 {
		tm.metrics.AverageTemp = reading.CoreTemp
	} else {
		tm.metrics.AverageTemp = (tm.metrics.AverageTemp*0.95 + reading.CoreTemp*0.05)
	}
	
	// Update max recorded temperature
	if reading.CoreTemp > tm.metrics.MaxRecordedTemp {
		tm.metrics.MaxRecordedTemp = reading.CoreTemp
	}
	
	tm.metrics.LastUpdate = reading.Timestamp
}

func (tm *ThermalManager) getThermalProfile(deviceType string) *ThermalProfile {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	
	return tm.thermalProfiles[deviceType]
}

func (tm *ThermalManager) getAmbientTemperatureOffset() float64 {
	// Simplified ambient temperature modeling
	// In practice, this would read from ambient sensors
	return 0.0
}

func (tm *ThermalManager) GetDeviceThermalState(deviceID string) (*DeviceThermalState, bool) {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	
	state, exists := tm.deviceThermals[deviceID]
	if !exists {
		return nil, false
	}
	
	// Return copy
	stateCopy := *state
	stateCopy.TempHistory = append([]TempReading(nil), state.TempHistory...)
	stateCopy.ThermalAlerts = append([]ThermalAlert(nil), state.ThermalAlerts...)
	
	return &stateCopy, true
}

func (tm *ThermalManager) GetThermalMetrics() *ThermalMetrics {
	tm.metrics.mu.RLock()
	defer tm.metrics.mu.RUnlock()
	
	metricsCopy := *tm.metrics
	metricsCopy.CoolingActionsApplied = make(map[CoolingAction]uint64)
	for k, v := range tm.metrics.CoolingActionsApplied {
		metricsCopy.CoolingActionsApplied[k] = v
	}
	
	return &metricsCopy
}

func (tm *ThermalManager) GetThermalSummary() map[string]interface{} {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	
	summary := map[string]interface{}{
		"total_devices":      len(tm.deviceThermals),
		"thermal_threshold":  tm.thermalThreshold,
		"emergency_threshold": tm.emergencyThreshold,
		"devices_over_threshold": 0,
		"devices_in_emergency": 0,
		"average_temperature": tm.metrics.AverageTemp,
		"max_recorded_temp":   tm.metrics.MaxRecordedTemp,
	}
	
	overThreshold := 0
	inEmergency := 0
	
	for _, thermal := range tm.deviceThermals {
		if thermal.CurrentTemp > tm.thermalThreshold {
			overThreshold++
		}
		if thermal.EmergencyMode {
			inEmergency++
		}
	}
	
	summary["devices_over_threshold"] = overThreshold
	summary["devices_in_emergency"] = inEmergency
	
	return summary
}