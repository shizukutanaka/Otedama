package power

import (
	"context"
	"fmt"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

// EfficiencyManager manages power efficiency modes
type EfficiencyManager struct {
	// Current mode
	currentMode atomic.Value // PowerMode
	
	// Device management
	devices      map[string]*PowerDevice
	devicesMu    sync.RWMutex
	
	// Configuration
	config       *EfficiencyConfig
	
	// Power monitoring
	totalPower   atomic.Value // float64
	efficiency   atomic.Value // float64 (hash/watt)
	
	// Statistics
	modeChanges  atomic.Uint64
	totalEnergy  atomic.Value // float64 (kWh)
	lastUpdate   atomic.Value // time.Time
	
	// Control
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// PowerMode represents different power efficiency modes
type PowerMode int

const (
	PowerModeEco PowerMode = iota
	PowerModeBalanced
	PowerModePerformance
	PowerModeTurbo
	PowerModeAdaptive
)

// PowerDevice represents a device with power management
type PowerDevice struct {
	ID           string
	Type         DeviceType
	Name         string
	
	// Power limits
	MinPower     float64 // Watts
	MaxPower     float64 // Watts
	CurrentPower atomic.Value // float64
	TargetPower  atomic.Value // float64
	
	// Performance
	MinHashrate  float64 // H/s
	MaxHashrate  float64 // H/s
	CurrentHashrate atomic.Value // float64
	
	// Efficiency curve
	EfficiencyCurve []EfficiencyPoint
	
	// Thermal
	Temperature  atomic.Value // float64
	TempLimit    float64
	
	// Control
	PowerScale   atomic.Value // float64 (0.0-1.0)
	ClockScale   atomic.Value // float64 (0.0-1.0)
	VoltageScale atomic.Value // float64 (0.0-1.0)
	
	// Statistics
	TotalEnergy  float64 // kWh
	Runtime      time.Duration
	StartTime    time.Time
}

// DeviceType represents type of power device
type DeviceType int

const (
	DeviceTypeCPU DeviceType = iota
	DeviceTypeGPU
	DeviceTypeASIC
	DeviceTypeFPGA
)

// EfficiencyPoint represents a point on efficiency curve
type EfficiencyPoint struct {
	PowerPercent float64
	Hashrate     float64
	Efficiency   float64 // H/W
}

// EfficiencyConfig holds efficiency configuration
type EfficiencyConfig struct {
	// Mode settings
	DefaultMode      PowerMode
	AutoSwitch       bool
	SwitchThreshold  float64 // Efficiency threshold for auto switch
	
	// Power limits
	MaxTotalPower    float64 // Watts
	PowerMargin      float64 // Safety margin (0.0-1.0)
	
	// Update intervals
	MonitorInterval  time.Duration
	AdjustInterval   time.Duration
	
	// Adaptive settings
	AdaptiveWindow   time.Duration
	EfficiencyTarget float64 // Target H/W
	
	// Economic settings
	ElectricityCost  float64 // $/kWh
	CoinPrice        float64 // $/coin
	BlockReward      float64 // coins
}

// PowerProfile represents a power efficiency profile
type PowerProfile struct {
	Name         string
	Mode         PowerMode
	CPUScale     float64
	GPUScale     float64
	ASICScale    float64
	TempLimit    float64
	Description  string
}

// DefaultEfficiencyConfig returns default configuration
func DefaultEfficiencyConfig() *EfficiencyConfig {
	return &EfficiencyConfig{
		DefaultMode:      PowerModeBalanced,
		AutoSwitch:       true,
		SwitchThreshold:  0.8,
		MaxTotalPower:    1000.0, // 1kW
		PowerMargin:      0.1,    // 10%
		MonitorInterval:  1 * time.Second,
		AdjustInterval:   10 * time.Second,
		AdaptiveWindow:   5 * time.Minute,
		EfficiencyTarget: 1000.0, // 1 kH/W
		ElectricityCost:  0.10,   // $0.10/kWh
		CoinPrice:        50000.0, // $50k
		BlockReward:      6.25,    // BTC
	}
}

// NewEfficiencyManager creates a new efficiency manager
func NewEfficiencyManager(ctx context.Context, config *EfficiencyConfig) *EfficiencyManager {
	if config == nil {
		config = DefaultEfficiencyConfig()
	}
	
	ctx, cancel := context.WithCancel(ctx)
	
	em := &EfficiencyManager{
		devices: make(map[string]*PowerDevice),
		config:  config,
		ctx:     ctx,
		cancel:  cancel,
	}
	
	em.currentMode.Store(config.DefaultMode)
	em.totalPower.Store(0.0)
	em.efficiency.Store(0.0)
	em.totalEnergy.Store(0.0)
	em.lastUpdate.Store(time.Now())
	
	// Start workers
	em.wg.Add(1)
	go em.monitor()
	
	em.wg.Add(1)
	go em.optimizer()
	
	return em
}

// RegisterDevice registers a power device
func (em *EfficiencyManager) RegisterDevice(id string, deviceType DeviceType, name string, minPower, maxPower, minHashrate, maxHashrate float64) error {
	em.devicesMu.Lock()
	defer em.devicesMu.Unlock()
	
	if _, exists := em.devices[id]; exists {
		return fmt.Errorf("device %s already registered", id)
	}
	
	device := &PowerDevice{
		ID:          id,
		Type:        deviceType,
		Name:        name,
		MinPower:    minPower,
		MaxPower:    maxPower,
		MinHashrate: minHashrate,
		MaxHashrate: maxHashrate,
		TempLimit:   85.0, // Default 85°C
		StartTime:   time.Now(),
	}
	
	// Initialize atomic values
	device.CurrentPower.Store(minPower)
	device.TargetPower.Store(minPower)
	device.CurrentHashrate.Store(minHashrate)
	device.Temperature.Store(50.0)
	device.PowerScale.Store(0.5)
	device.ClockScale.Store(0.5)
	device.VoltageScale.Store(0.9)
	
	// Generate efficiency curve
	device.EfficiencyCurve = em.generateEfficiencyCurve(device)
	
	em.devices[id] = device
	
	// Apply current mode
	em.applyModeToDevice(device, em.GetCurrentMode())
	
	return nil
}

// SetMode sets the power efficiency mode
func (em *EfficiencyManager) SetMode(mode PowerMode) error {
	oldMode := em.currentMode.Load().(PowerMode)
	if oldMode == mode {
		return nil
	}
	
	em.currentMode.Store(mode)
	em.modeChanges.Add(1)
	
	// Apply to all devices
	em.devicesMu.RLock()
	for _, device := range em.devices {
		em.applyModeToDevice(device, mode)
	}
	em.devicesMu.RUnlock()
	
	fmt.Printf("Power mode changed from %s to %s\n", oldMode.String(), mode.String())
	return nil
}

// GetCurrentMode returns the current power mode
func (em *EfficiencyManager) GetCurrentMode() PowerMode {
	return em.currentMode.Load().(PowerMode)
}

// applyModeToDevice applies power mode to a device
func (em *EfficiencyManager) applyModeToDevice(device *PowerDevice, mode PowerMode) {
	var powerScale, clockScale, voltageScale float64
	
	switch mode {
	case PowerModeEco:
		powerScale = 0.3
		clockScale = 0.4
		voltageScale = 0.8
	case PowerModeBalanced:
		powerScale = 0.6
		clockScale = 0.7
		voltageScale = 0.9
	case PowerModePerformance:
		powerScale = 0.8
		clockScale = 0.9
		voltageScale = 1.0
	case PowerModeTurbo:
		powerScale = 1.0
		clockScale = 1.0
		voltageScale = 1.1
	case PowerModeAdaptive:
		// Use current optimal settings
		return
	}
	
	device.PowerScale.Store(powerScale)
	device.ClockScale.Store(clockScale)
	device.VoltageScale.Store(voltageScale)
	
	// Calculate target power and hashrate
	targetPower := device.MinPower + (device.MaxPower-device.MinPower)*powerScale
	targetHashrate := em.calculateHashrateFromPower(device, targetPower)
	
	device.TargetPower.Store(targetPower)
	
	// Simulate power adjustment
	go em.adjustDevicePower(device, targetPower, targetHashrate)
}

// calculateHashrateFromPower calculates hashrate from power using efficiency curve
func (em *EfficiencyManager) calculateHashrateFromPower(device *PowerDevice, power float64) float64 {
	if len(device.EfficiencyCurve) == 0 {
		// Linear approximation
		powerRatio := (power - device.MinPower) / (device.MaxPower - device.MinPower)
		return device.MinHashrate + (device.MaxHashrate-device.MinHashrate)*powerRatio
	}
	
	// Interpolate from efficiency curve
	powerPercent := power / device.MaxPower * 100
	
	for i, point := range device.EfficiencyCurve {
		if point.PowerPercent >= powerPercent {
			if i == 0 {
				return point.Hashrate
			}
			
			// Linear interpolation
			prev := device.EfficiencyCurve[i-1]
			ratio := (powerPercent - prev.PowerPercent) / (point.PowerPercent - prev.PowerPercent)
			return prev.Hashrate + (point.Hashrate-prev.Hashrate)*ratio
		}
	}
	
	// Beyond curve, use last point
	last := device.EfficiencyCurve[len(device.EfficiencyCurve)-1]
	return last.Hashrate
}

// adjustDevicePower adjusts device power gradually
func (em *EfficiencyManager) adjustDevicePower(device *PowerDevice, targetPower, targetHashrate float64) {
	currentPower := device.CurrentPower.Load().(float64)
	currentHashrate := device.CurrentHashrate.Load().(float64)
	
	steps := 10
	powerStep := (targetPower - currentPower) / float64(steps)
	hashrateStep := (targetHashrate - currentHashrate) / float64(steps)
	
	for i := 0; i < steps; i++ {
		newPower := currentPower + powerStep*float64(i+1)
		newHashrate := currentHashrate + hashrateStep*float64(i+1)
		
		device.CurrentPower.Store(newPower)
		device.CurrentHashrate.Store(newHashrate)
		
		time.Sleep(100 * time.Millisecond)
	}
}

// UpdateDevicePower updates device power consumption
func (em *EfficiencyManager) UpdateDevicePower(deviceID string, power float64) error {
	em.devicesMu.RLock()
	device, exists := em.devices[deviceID]
	em.devicesMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("device %s not found", deviceID)
	}
	
	device.CurrentPower.Store(power)
	
	// Update total power
	em.updateTotalPower()
	
	return nil
}

// UpdateDeviceHashrate updates device hashrate
func (em *EfficiencyManager) UpdateDeviceHashrate(deviceID string, hashrate float64) error {
	em.devicesMu.RLock()
	device, exists := em.devices[deviceID]
	em.devicesMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("device %s not found", deviceID)
	}
	
	device.CurrentHashrate.Store(hashrate)
	
	// Update efficiency
	em.updateEfficiency()
	
	return nil
}

// UpdateDeviceTemperature updates device temperature
func (em *EfficiencyManager) UpdateDeviceTemperature(deviceID string, temperature float64) error {
	em.devicesMu.RLock()
	device, exists := em.devices[deviceID]
	em.devicesMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("device %s not found", deviceID)
	}
	
	device.Temperature.Store(temperature)
	
	// Check thermal throttling
	if temperature > device.TempLimit {
		em.thermalThrottle(device)
	}
	
	return nil
}

// thermalThrottle performs thermal throttling
func (em *EfficiencyManager) thermalThrottle(device *PowerDevice) {
	currentScale := device.PowerScale.Load().(float64)
	newScale := currentScale * 0.9 // Reduce by 10%
	
	if newScale < 0.3 {
		newScale = 0.3 // Minimum 30%
	}
	
	device.PowerScale.Store(newScale)
	
	// Recalculate target power
	targetPower := device.MinPower + (device.MaxPower-device.MinPower)*newScale
	device.TargetPower.Store(targetPower)
	
	fmt.Printf("Thermal throttling device %s: %.1f%% power\n", device.Name, newScale*100)
}

// updateTotalPower updates total power consumption
func (em *EfficiencyManager) updateTotalPower() {
	var total float64
	
	em.devicesMu.RLock()
	for _, device := range em.devices {
		total += device.CurrentPower.Load().(float64)
	}
	em.devicesMu.RUnlock()
	
	em.totalPower.Store(total)
	
	// Check power limit
	if total > em.config.MaxTotalPower*(1-em.config.PowerMargin) {
		em.powerLimit()
	}
}

// updateEfficiency updates overall efficiency
func (em *EfficiencyManager) updateEfficiency() {
	var totalHashrate, totalPower float64
	
	em.devicesMu.RLock()
	for _, device := range em.devices {
		totalHashrate += device.CurrentHashrate.Load().(float64)
		totalPower += device.CurrentPower.Load().(float64)
	}
	em.devicesMu.RUnlock()
	
	if totalPower > 0 {
		efficiency := totalHashrate / totalPower
		em.efficiency.Store(efficiency)
	}
}

// powerLimit performs power limiting
func (em *EfficiencyManager) powerLimit() {
	fmt.Printf("Power limit reached, reducing consumption\n")
	
	// Find least efficient devices and reduce their power
	em.devicesMu.RLock()
	devices := make([]*PowerDevice, 0, len(em.devices))
	for _, device := range em.devices {
		devices = append(devices, device)
	}
	em.devicesMu.RUnlock()
	
	// Sort by efficiency (least efficient first)
	// This is simplified - production code would properly sort
	for _, device := range devices {
		currentScale := device.PowerScale.Load().(float64)
		if currentScale > 0.3 {
			newScale := currentScale * 0.95
			device.PowerScale.Store(newScale)
			
			targetPower := device.MinPower + (device.MaxPower-device.MinPower)*newScale
			device.TargetPower.Store(targetPower)
			break
		}
	}
}

// monitor monitors power consumption and efficiency
func (em *EfficiencyManager) monitor() {
	defer em.wg.Done()
	
	ticker := time.NewTicker(em.config.MonitorInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			em.updateTotalPower()
			em.updateEfficiency()
			em.updateEnergyConsumption()
			
		case <-em.ctx.Done():
			return
		}
	}
}

// updateEnergyConsumption updates total energy consumption
func (em *EfficiencyManager) updateEnergyConsumption() {
	now := time.Now()
	lastUpdate := em.lastUpdate.Load().(time.Time)
	elapsed := now.Sub(lastUpdate).Hours()
	
	if elapsed > 0 {
		power := em.totalPower.Load().(float64) / 1000.0 // Convert to kW
		energy := power * elapsed
		
		currentEnergy := em.totalEnergy.Load().(float64)
		em.totalEnergy.Store(currentEnergy + energy)
		em.lastUpdate.Store(now)
		
		// Update device energy
		em.devicesMu.RLock()
		for _, device := range em.devices {
			devicePower := device.CurrentPower.Load().(float64) / 1000.0
			device.TotalEnergy += devicePower * elapsed
		}
		em.devicesMu.RUnlock()
	}
}

// optimizer optimizes power efficiency
func (em *EfficiencyManager) optimizer() {
	defer em.wg.Done()
	
	ticker := time.NewTicker(em.config.AdjustInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if em.GetCurrentMode() == PowerModeAdaptive {
				em.adaptiveOptimization()
			}
			
		case <-em.ctx.Done():
			return
		}
	}
}

// adaptiveOptimization performs adaptive power optimization
func (em *EfficiencyManager) adaptiveOptimization() {
	currentEfficiency := em.efficiency.Load().(float64)
	target := em.config.EfficiencyTarget
	
	if currentEfficiency < target*0.9 {
		// Efficiency too low, try to optimize
		em.optimizeForEfficiency()
	} else if currentEfficiency > target*1.1 {
		// Very efficient, can increase performance
		em.optimizeForPerformance()
	}
}

// optimizeForEfficiency optimizes for power efficiency
func (em *EfficiencyManager) optimizeForEfficiency() {
	em.devicesMu.RLock()
	defer em.devicesMu.RUnlock()
	
	for _, device := range em.devices {
		// Find optimal operating point
		optimalPoint := em.findOptimalEfficiencyPoint(device)
		if optimalPoint != nil {
			powerScale := optimalPoint.PowerPercent / 100.0
			device.PowerScale.Store(powerScale)
			
			targetPower := device.MaxPower * powerScale
			device.TargetPower.Store(targetPower)
		}
	}
}

// optimizeForPerformance optimizes for performance
func (em *EfficiencyManager) optimizeForPerformance() {
	em.devicesMu.RLock()
	defer em.devicesMu.RUnlock()
	
	// Check if we have power headroom
	totalPower := em.totalPower.Load().(float64)
	headroom := em.config.MaxTotalPower - totalPower
	
	if headroom > 50 { // At least 50W headroom
		// Increase power for best performing devices
		for _, device := range em.devices {
			currentScale := device.PowerScale.Load().(float64)
			if currentScale < 0.9 {
				newScale := math.Min(currentScale*1.05, 0.9)
				device.PowerScale.Store(newScale)
				
				targetPower := device.MinPower + (device.MaxPower-device.MinPower)*newScale
				device.TargetPower.Store(targetPower)
			}
		}
	}
}

// findOptimalEfficiencyPoint finds optimal efficiency point
func (em *EfficiencyManager) findOptimalEfficiencyPoint(device *PowerDevice) *EfficiencyPoint {
	if len(device.EfficiencyCurve) == 0 {
		return nil
	}
	
	var best *EfficiencyPoint
	maxEfficiency := 0.0
	
	for i := range device.EfficiencyCurve {
		point := &device.EfficiencyCurve[i]
		if point.Efficiency > maxEfficiency {
			maxEfficiency = point.Efficiency
			best = point
		}
	}
	
	return best
}

// generateEfficiencyCurve generates efficiency curve for device
func (em *EfficiencyManager) generateEfficiencyCurve(device *PowerDevice) []EfficiencyPoint {
	curve := make([]EfficiencyPoint, 0, 11)
	
	for i := 0; i <= 10; i++ {
		powerPercent := float64(i) * 10
		power := device.MaxPower * powerPercent / 100.0
		
		// Generate realistic efficiency curve
		// Most devices are most efficient at 60-80% power
		var efficiency float64
		if powerPercent < 30 {
			efficiency = 0.5 + powerPercent*0.02
		} else if powerPercent < 80 {
			efficiency = 1.1 + (powerPercent-30)*0.01
		} else {
			efficiency = 1.6 - (powerPercent-80)*0.02
		}
		
		hashrate := device.MaxHashrate * powerPercent / 100.0 * efficiency
		
		curve = append(curve, EfficiencyPoint{
			PowerPercent: powerPercent,
			Hashrate:     hashrate,
			Efficiency:   hashrate / power,
		})
	}
	
	return curve
}

// GetPowerProfiles returns available power profiles
func (em *EfficiencyManager) GetPowerProfiles() []PowerProfile {
	return []PowerProfile{
		{
			Name:        "Eco",
			Mode:        PowerModeEco,
			CPUScale:    0.3,
			GPUScale:    0.3,
			ASICScale:   0.4,
			TempLimit:   70.0,
			Description: "Maximum efficiency, minimum power consumption",
		},
		{
			Name:        "Balanced",
			Mode:        PowerModeBalanced,
			CPUScale:    0.6,
			GPUScale:    0.6,
			ASICScale:   0.7,
			TempLimit:   80.0,
			Description: "Balanced performance and efficiency",
		},
		{
			Name:        "Performance",
			Mode:        PowerModePerformance,
			CPUScale:    0.8,
			GPUScale:    0.8,
			ASICScale:   0.9,
			TempLimit:   85.0,
			Description: "High performance with good efficiency",
		},
		{
			Name:        "Turbo",
			Mode:        PowerModeTurbo,
			CPUScale:    1.0,
			GPUScale:    1.0,
			ASICScale:   1.0,
			TempLimit:   90.0,
			Description: "Maximum performance, high power consumption",
		},
		{
			Name:        "Adaptive",
			Mode:        PowerModeAdaptive,
			CPUScale:    0.0, // Dynamic
			GPUScale:    0.0, // Dynamic
			ASICScale:   0.0, // Dynamic
			TempLimit:   85.0,
			Description: "Automatically adjusts for optimal efficiency",
		},
	}
}

// CalculateProfitability calculates mining profitability
func (em *EfficiencyManager) CalculateProfitability() map[string]float64 {
	totalHashrate := 0.0
	totalPower := em.totalPower.Load().(float64)
	totalEnergy := em.totalEnergy.Load().(float64)
	
	em.devicesMu.RLock()
	for _, device := range em.devices {
		totalHashrate += device.CurrentHashrate.Load().(float64)
	}
	em.devicesMu.RUnlock()
	
	// Simplified profitability calculation
	dailyHashrate := totalHashrate * 86400 // Hash/day
	networkHashrate := getCurrentNetworkHashrate() // Dynamic network hashrate
	blocksPerDay := 144.0 // Bitcoin: ~144 blocks/day
	
	// Revenue
	dailyBlocks := blocksPerDay * (dailyHashrate / networkHashrate)
	dailyRevenue := dailyBlocks * em.config.BlockReward * em.config.CoinPrice
	
	// Costs
	dailyPowerConsumption := totalPower * 24 / 1000.0 // kWh
	dailyCost := dailyPowerConsumption * em.config.ElectricityCost
	
	// Profit
	dailyProfit := dailyRevenue - dailyCost
	
	return map[string]float64{
		"daily_revenue":     dailyRevenue,
		"daily_cost":        dailyCost,
		"daily_profit":      dailyProfit,
		"efficiency":        totalHashrate / totalPower,
		"total_hashrate":    totalHashrate,
		"total_power":       totalPower,
		"total_energy":      totalEnergy,
		"power_cost_ratio":  dailyCost / dailyRevenue * 100,
	}
}

// GetStatistics returns efficiency statistics
func (em *EfficiencyManager) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	stats["current_mode"] = em.GetCurrentMode().String()
	stats["total_power"] = em.totalPower.Load()
	stats["efficiency"] = em.efficiency.Load()
	stats["total_energy"] = em.totalEnergy.Load()
	stats["mode_changes"] = em.modeChanges.Load()
	
	// Device statistics
	em.devicesMu.RLock()
	deviceStats := make([]map[string]interface{}, 0, len(em.devices))
	for _, device := range em.devices {
		deviceStats = append(deviceStats, map[string]interface{}{
			"id":           device.ID,
			"name":         device.Name,
			"type":         device.Type.String(),
			"power":        device.CurrentPower.Load(),
			"hashrate":     device.CurrentHashrate.Load(),
			"efficiency":   device.CurrentHashrate.Load().(float64) / device.CurrentPower.Load().(float64),
			"temperature":  device.Temperature.Load(),
			"power_scale":  device.PowerScale.Load(),
			"energy":       device.TotalEnergy,
		})
	}
	em.devicesMu.RUnlock()
	
	stats["devices"] = deviceStats
	stats["device_count"] = len(deviceStats)
	
	// Profitability
	stats["profitability"] = em.CalculateProfitability()
	
	return stats
}

// Stop stops the efficiency manager
func (em *EfficiencyManager) Stop() {
	em.cancel()
	em.wg.Wait()
}

// String returns string representation of PowerMode
func (pm PowerMode) String() string {
	switch pm {
	case PowerModeEco:
		return "eco"
	case PowerModeBalanced:
		return "balanced"
	case PowerModePerformance:
		return "performance"
	case PowerModeTurbo:
		return "turbo"
	case PowerModeAdaptive:
		return "adaptive"
	default:
		return "unknown"
	}
}

// String returns string representation of DeviceType
func (dt DeviceType) String() string {
	switch dt {
	case DeviceTypeCPU:
		return "CPU"
	case DeviceTypeGPU:
		return "GPU"
	case DeviceTypeASIC:
		return "ASIC"
	case DeviceTypeFPGA:
		return "FPGA"
	default:
		return "Unknown"
	}
}