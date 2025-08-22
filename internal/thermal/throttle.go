package thermal

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

// ThermalThrottler manages temperature-based throttling
type ThermalThrottler struct {
	devices      map[string]*ThermalDevice
	devicesMu    sync.RWMutex
	
	// Configuration
	config       *ThrottleConfig
	
	// Current state
	throttleLevel atomic.Int32 // 0-100%
	isThrottling  atomic.Bool
	
	// Statistics
	throttleEvents atomic.Uint64
	overheats      atomic.Uint64
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
}

// ThermalDevice represents a device with temperature monitoring
type ThermalDevice struct {
	ID           string
	Type         DeviceType
	Name         string
	
	// Temperature data
	currentTemp  atomic.Value // float64
	targetTemp   float64
	maxTemp      float64
	criticalTemp float64
	
	// Throttle state
	throttlePercent atomic.Int32
	lastUpdate      atomic.Value // time.Time
	
	// Statistics
	maxTempReached float64
	avgTemp        float64
	samples        int64
}

// DeviceType represents type of thermal device
type DeviceType int

const (
	DeviceCPU DeviceType = iota
	DeviceGPU
	DeviceASIC
	DeviceMemory
	DeviceVRM
)

// ThrottleConfig holds throttle configuration
type ThrottleConfig struct {
	// Temperature thresholds (Celsius)
	TargetTemp    float64
	WarningTemp   float64
	CriticalTemp  float64
	ShutdownTemp  float64
	
	// Throttle parameters
	MinThrottle   int // Minimum throttle percentage
	MaxThrottle   int // Maximum throttle percentage
	ThrottleStep  int // Throttle adjustment step
	
	// Control parameters
	UpdateInterval time.Duration
	Hysteresis     float64 // Temperature hysteresis
	
	// PID controller gains
	Kp float64 // Proportional gain
	Ki float64 // Integral gain
	Kd float64 // Derivative gain
}

// PIDController implements PID control for temperature
type PIDController struct {
	kp, ki, kd   float64
	setpoint     float64
	integral     float64
	lastError    float64
	lastTime     time.Time
	mu           sync.Mutex
}

// DefaultThrottleConfig returns default configuration
func DefaultThrottleConfig() *ThrottleConfig {
	return &ThrottleConfig{
		TargetTemp:     70.0,
		WarningTemp:    80.0,
		CriticalTemp:   90.0,
		ShutdownTemp:   95.0,
		MinThrottle:    0,
		MaxThrottle:    90,
		ThrottleStep:   5,
		UpdateInterval: 1 * time.Second,
		Hysteresis:     2.0,
		Kp:             2.0,
		Ki:             0.5,
		Kd:             1.0,
	}
}

// NewThermalThrottler creates a new thermal throttler
func NewThermalThrottler(ctx context.Context, config *ThrottleConfig) *ThermalThrottler {
	if config == nil {
		config = DefaultThrottleConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	tt := &ThermalThrottler{
		devices: make(map[string]*ThermalDevice),
		config:  config,
		ctx:     ctx,
		cancel:  cancel,
	}
	
	// Start monitoring
	go tt.monitorTemperatures()
	
	return tt
}

// RegisterDevice registers a thermal device
func (tt *ThermalThrottler) RegisterDevice(id string, deviceType DeviceType, name string) error {
	tt.devicesMu.Lock()
	defer tt.devicesMu.Unlock()
	
	if _, exists := tt.devices[id]; exists {
		return errors.New("device already registered")
	}
	
	device := &ThermalDevice{
		ID:           id,
		Type:         deviceType,
		Name:         name,
		targetTemp:   tt.config.TargetTemp,
		maxTemp:      tt.config.WarningTemp,
		criticalTemp: tt.config.CriticalTemp,
	}
	
	device.currentTemp.Store(0.0)
	device.lastUpdate.Store(time.Now())
	
	tt.devices[id] = device
	return nil
}

// UpdateTemperature updates device temperature
func (tt *ThermalThrottler) UpdateTemperature(deviceID string, temperature float64) error {
	tt.devicesMu.RLock()
	device, exists := tt.devices[deviceID]
	tt.devicesMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("device %s not found", deviceID)
	}
	
	// Update temperature
	device.currentTemp.Store(temperature)
	device.lastUpdate.Store(time.Now())
	
	// Update statistics
	device.avgTemp = (device.avgTemp*float64(device.samples) + temperature) / float64(device.samples+1)
	device.samples++
	
	if temperature > device.maxTempReached {
		device.maxTempReached = temperature
	}
	
	// Check for overheating
	if temperature >= device.criticalTemp {
		tt.overheats.Add(1)
	}
	
	// Calculate throttle level
	throttle := tt.calculateThrottle(device, temperature)
	device.throttlePercent.Store(throttle)
	
	// Update global throttle level
	tt.updateGlobalThrottle()
	
	return nil
}

// calculateThrottle calculates throttle percentage for a device
func (tt *ThermalThrottler) calculateThrottle(device *ThermalDevice, temp float64) int32 {
	// Simple proportional control
	if temp <= device.targetTemp {
		return 0
	}
	
	if temp >= tt.config.ShutdownTemp {
		return int32(tt.config.MaxThrottle)
	}
	
	// Linear interpolation
	range_ := device.criticalTemp - device.targetTemp
	excess := temp - device.targetTemp
	throttle := int32((excess / range_) * float64(tt.config.MaxThrottle))
	
	// Apply limits
	if throttle < int32(tt.config.MinThrottle) {
		throttle = int32(tt.config.MinThrottle)
	}
	if throttle > int32(tt.config.MaxThrottle) {
		throttle = int32(tt.config.MaxThrottle)
	}
	
	return throttle
}

// updateGlobalThrottle updates global throttle level
func (tt *ThermalThrottler) updateGlobalThrottle() {
	tt.devicesMu.RLock()
	defer tt.devicesMu.RUnlock()
	
	var maxThrottle int32
	for _, device := range tt.devices {
		throttle := device.throttlePercent.Load()
		if throttle > maxThrottle {
			maxThrottle = throttle
		}
	}
	
	tt.throttleLevel.Store(maxThrottle)
	
	if maxThrottle > 0 {
		if !tt.isThrottling.Load() {
			tt.isThrottling.Store(true)
			tt.throttleEvents.Add(1)
		}
	} else {
		tt.isThrottling.Store(false)
	}
}

// GetThrottleLevel returns current throttle level (0-100%)
func (tt *ThermalThrottler) GetThrottleLevel() int {
	return int(tt.throttleLevel.Load())
}

// IsThrottling returns if throttling is active
func (tt *ThermalThrottler) IsThrottling() bool {
	return tt.isThrottling.Load()
}

// GetDeviceTemperature returns device temperature
func (tt *ThermalThrottler) GetDeviceTemperature(deviceID string) (float64, error) {
	tt.devicesMu.RLock()
	device, exists := tt.devices[deviceID]
	tt.devicesMu.RUnlock()
	
	if !exists {
		return 0, fmt.Errorf("device %s not found", deviceID)
	}
	
	return device.currentTemp.Load().(float64), nil
}

// monitorTemperatures monitors device temperatures
func (tt *ThermalThrottler) monitorTemperatures() {
	ticker := time.NewTicker(tt.config.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			tt.checkTemperatures()
			
		case <-tt.ctx.Done():
			return
		}
	}
}

// checkTemperatures checks all device temperatures
func (tt *ThermalThrottler) checkTemperatures() {
	tt.devicesMu.RLock()
	defer tt.devicesMu.RUnlock()
	
	for _, device := range tt.devices {
		// Check for stale data
		if time.Since(device.lastUpdate.Load().(time.Time)) > 10*time.Second {
			// No recent update, assume safe temperature
			device.currentTemp.Store(device.targetTemp)
			device.throttlePercent.Store(0)
		}
		
		// Check for critical temperature
		temp := device.currentTemp.Load().(float64)
		if temp >= tt.config.ShutdownTemp {
			// Emergency shutdown
			fmt.Printf("CRITICAL: Device %s temperature %.1f°C exceeds shutdown threshold!\n", 
				device.Name, temp)
		}
	}
}

// GetStatistics returns throttler statistics
func (tt *ThermalThrottler) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	stats["throttle_level"] = tt.throttleLevel.Load()
	stats["is_throttling"] = tt.isThrottling.Load()
	stats["throttle_events"] = tt.throttleEvents.Load()
	stats["overheats"] = tt.overheats.Load()
	
	// Device statistics
	tt.devicesMu.RLock()
	deviceStats := make([]map[string]interface{}, 0, len(tt.devices))
	for _, device := range tt.devices {
		deviceStats = append(deviceStats, map[string]interface{}{
			"id":           device.ID,
			"name":         device.Name,
			"type":         device.Type.String(),
			"temperature":  device.currentTemp.Load(),
			"throttle":     device.throttlePercent.Load(),
			"avg_temp":     device.avgTemp,
			"max_temp":     device.maxTempReached,
		})
	}
	tt.devicesMu.RUnlock()
	
	stats["devices"] = deviceStats
	
	return stats
}

// Stop stops the thermal throttler
func (tt *ThermalThrottler) Stop() {
	tt.cancel()
}

// String returns string representation of DeviceType
func (dt DeviceType) String() string {
	switch dt {
	case DeviceCPU:
		return "CPU"
	case DeviceGPU:
		return "GPU"
	case DeviceASIC:
		return "ASIC"
	case DeviceMemory:
		return "Memory"
	case DeviceVRM:
		return "VRM"
	default:
		return "Unknown"
	}
}

// NewPIDController creates a new PID controller
func NewPIDController(kp, ki, kd, setpoint float64) *PIDController {
	return &PIDController{
		kp:       kp,
		ki:       ki,
		kd:       kd,
		setpoint: setpoint,
		lastTime: time.Now(),
	}
}

// Update calculates PID output
func (pid *PIDController) Update(measured float64) float64 {
	pid.mu.Lock()
	defer pid.mu.Unlock()
	
	now := time.Now()
	dt := now.Sub(pid.lastTime).Seconds()
	if dt <= 0 {
		dt = 0.001 // Minimum time step
	}
	
	// Calculate error
	error := pid.setpoint - measured
	
	// Proportional term
	p := pid.kp * error
	
	// Integral term
	pid.integral += error * dt
	i := pid.ki * pid.integral
	
	// Derivative term
	derivative := (error - pid.lastError) / dt
	d := pid.kd * derivative
	
	// Update state
	pid.lastError = error
	pid.lastTime = now
	
	// Calculate output
	output := p + i + d
	
	// Clamp output to 0-100%
	if output < 0 {
		output = 0
	}
	if output > 100 {
		output = 100
	}
	
	return output
}

// Reset resets the PID controller
func (pid *PIDController) Reset() {
	pid.mu.Lock()
	defer pid.mu.Unlock()
	
	pid.integral = 0
	pid.lastError = 0
	pid.lastTime = time.Now()
}

// SetSetpoint updates the setpoint
func (pid *PIDController) SetSetpoint(setpoint float64) {
	pid.mu.Lock()
	defer pid.mu.Unlock()
	pid.setpoint = setpoint
}

// AdaptiveThrottler provides adaptive throttling
type AdaptiveThrottler struct {
	throttler    *ThermalThrottler
	pid          *PIDController
	learningRate float64
	history      []float64
	historySize  int
	mu           sync.Mutex
}

// NewAdaptiveThrottler creates adaptive throttler
func NewAdaptiveThrottler(throttler *ThermalThrottler) *AdaptiveThrottler {
	config := throttler.config
	pid := NewPIDController(config.Kp, config.Ki, config.Kd, config.TargetTemp)
	
	return &AdaptiveThrottler{
		throttler:    throttler,
		pid:          pid,
		learningRate: 0.1,
		historySize:  100,
		history:      make([]float64, 0, 100),
	}
}

// UpdateThrottle updates throttle with adaptive control
func (at *AdaptiveThrottler) UpdateThrottle(deviceID string, temperature float64) (int, error) {
	// Get PID output
	throttlePercent := at.pid.Update(temperature)
	
	// Update history
	at.mu.Lock()
	at.history = append(at.history, temperature)
	if len(at.history) > at.historySize {
		at.history = at.history[1:]
	}
	
	// Adapt PID gains based on performance
	if len(at.history) >= 10 {
		at.adaptGains()
	}
	at.mu.Unlock()
	
	// Apply throttle
	throttle := int(throttlePercent)
	if err := at.throttler.UpdateTemperature(deviceID, temperature); err != nil {
		return 0, err
	}
	
	return throttle, nil
}

// adaptGains adapts PID gains based on performance
func (at *AdaptiveThrottler) adaptGains() {
	// Calculate variance of temperature
	var sum, sumSq float64
	for _, temp := range at.history {
		sum += temp
		sumSq += temp * temp
	}
	
	n := float64(len(at.history))
	mean := sum / n
	variance := (sumSq / n) - (mean * mean)
	
	// Adjust gains based on variance
	if variance > 10 { // High variance, reduce gains
		at.pid.kp *= (1 - at.learningRate)
		at.pid.ki *= (1 - at.learningRate)
		at.pid.kd *= (1 - at.learningRate)
	} else if variance < 1 { // Low variance, increase gains
		at.pid.kp *= (1 + at.learningRate)
		at.pid.ki *= (1 + at.learningRate)
		at.pid.kd *= (1 + at.learningRate)
	}
	
	// Clamp gains
	at.pid.kp = math.Max(0.1, math.Min(10.0, at.pid.kp))
	at.pid.ki = math.Max(0.01, math.Min(1.0, at.pid.ki))
	at.pid.kd = math.Max(0.1, math.Min(5.0, at.pid.kd))
}

// FanController controls cooling fans
type FanController struct {
	fans    map[string]*Fan
	fansMu  sync.RWMutex
	minRPM  int
	maxRPM  int
}

// Fan represents a cooling fan
type Fan struct {
	ID       string
	CurrentRPM atomic.Int32
	TargetRPM  atomic.Int32
}

// NewFanController creates fan controller
func NewFanController() *FanController {
	return &FanController{
		fans:   make(map[string]*Fan),
		minRPM: 500,
		maxRPM: 3000,
	}
}

// SetFanSpeed sets fan speed based on temperature
func (fc *FanController) SetFanSpeed(fanID string, tempPercent float64) error {
	fc.fansMu.Lock()
	fan, exists := fc.fans[fanID]
	if !exists {
		fan = &Fan{ID: fanID}
		fc.fans[fanID] = fan
	}
	fc.fansMu.Unlock()
	
	// Calculate target RPM
	rpm := fc.minRPM + int(tempPercent/100.0*float64(fc.maxRPM-fc.minRPM))
	fan.TargetRPM.Store(int32(rpm))
	
	// Simulate gradual speed change
	current := fan.CurrentRPM.Load()
	target := fan.TargetRPM.Load()
	
	if current < target {
		fan.CurrentRPM.Store(current + 100)
	} else if current > target {
		fan.CurrentRPM.Store(current - 100)
	}
	
	return nil
}