package asic

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// FarmManager manages multiple ASIC devices as a farm
type FarmManager struct {
	logger   *zap.Logger
	manager  *ASICManager
	
	// Farm organization
	groups   sync.Map // map[string]*DeviceGroup
	racks    sync.Map // map[string]*Rack
	
	// Farm-wide settings
	config   *FarmConfig
	
	// Statistics
	stats    *FarmStats
	
	// Automation
	scheduler *MaintenanceScheduler
	alerter   *AlertManager
	
	// Control
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

// FarmConfig contains farm-wide configuration
type FarmConfig struct {
	// Organization
	DefaultGroupSize int           `json:"default_group_size"`
	RackCapacity     int           `json:"rack_capacity"`
	
	// Operation modes
	LoadBalancing    bool          `json:"load_balancing"`
	AutoFailover     bool          `json:"auto_failover"`
	PowerOptimization bool         `json:"power_optimization"`
	
	// Limits
	MaxPowerDraw     float32       `json:"max_power_draw"`     // kW
	MaxTemperature   float32       `json:"max_temperature"`    // Celsius
	
	// Maintenance
	MaintenanceWindow struct {
		StartHour int           `json:"start_hour"` // 0-23
		Duration  time.Duration `json:"duration"`
		DaysOfWeek []int        `json:"days_of_week"` // 0=Sunday
	} `json:"maintenance_window"`
	
	// Alerts
	AlertThresholds struct {
		HashRateDrop    float64 `json:"hash_rate_drop"`    // percentage
		EfficiencyDrop  float64 `json:"efficiency_drop"`   // percentage
		ErrorRate       float64 `json:"error_rate"`        // percentage
		OfflineTimeout  time.Duration `json:"offline_timeout"`
	} `json:"alert_thresholds"`
}

// DeviceGroup represents a logical group of devices
type DeviceGroup struct {
	ID          string
	Name        string
	Description string
	DeviceIDs   []string
	Policy      *GroupPolicy
	
	// Statistics
	TotalHashRate atomic.Uint64
	TotalPower    atomic.Uint64 // Watts
	ActiveDevices atomic.Int32
}

// GroupPolicy defines operation policy for a device group
type GroupPolicy struct {
	WorkMode        WorkMode
	TargetHashRate  uint64   // H/s
	MaxPowerDraw    float32  // Watts
	RedundancyLevel int      // Number of backup devices
	Priority        int      // Higher priority gets work first
}

// Rack represents a physical rack of devices
type Rack struct {
	ID          string
	Location    string
	Capacity    int
	DeviceSlots map[int]string // slot -> deviceID
	
	// Environmental
	Temperature float32
	Humidity    float32
	Airflow     float32
	
	// Power
	PowerCapacity float32 // kW
	PowerUsed     float32 // kW
	PDUs          []PDU
}

// PDU represents a Power Distribution Unit
type PDU struct {
	ID            string
	Model         string
	TotalOutlets  int
	UsedOutlets   int
	MaxCurrent    float32 // Amps
	CurrentDraw   float32 // Amps
	Voltage       float32 // Volts
}

// FarmStats contains farm-wide statistics
type FarmStats struct {
	// Aggregate metrics
	TotalDevices      atomic.Int32
	ActiveDevices     atomic.Int32
	TotalHashRate     atomic.Uint64 // H/s
	TotalPowerDraw    atomic.Uint64 // Watts
	AverageEfficiency atomic.Uint64 // J/TH * 100
	
	// Historical data
	DailyProduction   map[string]float64 // date -> coins
	PowerCostHistory  map[string]float64 // date -> cost
	
	// Uptime
	FarmUptime        time.Duration
	AverageDeviceUptime time.Duration
}

// MaintenanceScheduler handles scheduled maintenance
type MaintenanceScheduler struct {
	logger    *zap.Logger
	schedules sync.Map // map[string]*MaintenanceSchedule
}

// MaintenanceSchedule represents a maintenance task
type MaintenanceSchedule struct {
	ID          string
	Name        string
	DeviceGroup string
	TaskType    MaintenanceType
	Schedule    string // cron expression
	LastRun     time.Time
	NextRun     time.Time
	Enabled     bool
}

// MaintenanceType defines types of maintenance tasks
type MaintenanceType int

const (
	MaintenanceRestart MaintenanceType = iota
	MaintenanceFirmwareUpdate
	MaintenanceClean
	MaintenanceDiagnostic
	MaintenanceRotation
)

// AlertManager handles farm alerts
type AlertManager struct {
	logger     *zap.Logger
	alerts     sync.Map // map[string]*Alert
	handlers   []AlertHandler
}

// Alert represents a farm alert
type Alert struct {
	ID          string
	Severity    AlertSeverity
	Type        AlertType
	DeviceID    string
	GroupID     string
	Message     string
	Details     map[string]interface{}
	Timestamp   time.Time
	Acknowledged bool
}

// AlertSeverity defines alert severity levels
type AlertSeverity int

const (
	AlertInfo AlertSeverity = iota
	AlertWarning
	AlertError
	AlertCritical
)

// AlertType defines types of alerts
type AlertType string

const (
	AlertTypeHashRateDrop    AlertType = "hash_rate_drop"
	AlertTypeDeviceOffline   AlertType = "device_offline"
	AlertTypeOverheating     AlertType = "overheating"
	AlertTypePowerIssue      AlertType = "power_issue"
	AlertTypeHardwareFailure AlertType = "hardware_failure"
	AlertTypeEfficiencyDrop  AlertType = "efficiency_drop"
	AlertTypeMaintenanceDue  AlertType = "maintenance_due"
)

// AlertHandler processes alerts
type AlertHandler interface {
	HandleAlert(alert *Alert) error
}

// NewFarmManager creates a new farm manager
func NewFarmManager(logger *zap.Logger, manager *ASICManager, config *FarmConfig) *FarmManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	farm := &FarmManager{
		logger:  logger,
		manager: manager,
		config:  config,
		stats:   &FarmStats{
			DailyProduction:  make(map[string]float64),
			PowerCostHistory: make(map[string]float64),
		},
		scheduler: &MaintenanceScheduler{
			logger: logger,
		},
		alerter: &AlertManager{
			logger: logger,
		},
		ctx:     ctx,
		cancel:  cancel,
	}
	
	return farm
}

// Start starts the farm manager
func (f *FarmManager) Start() error {
	f.logger.Info("Starting ASIC farm manager")
	
	// Start monitoring
	f.wg.Add(1)
	go f.monitorLoop()
	
	// Start automation
	f.wg.Add(1)
	go f.automationLoop()
	
	// Start maintenance scheduler
	f.wg.Add(1)
	go f.maintenanceLoop()
	
	// Start alert processor
	f.wg.Add(1)
	go f.alertLoop()
	
	return nil
}

// Stop stops the farm manager
func (f *FarmManager) Stop() error {
	f.logger.Info("Stopping ASIC farm manager")
	
	f.cancel()
	f.wg.Wait()
	
	return nil
}

// CreateGroup creates a new device group
func (f *FarmManager) CreateGroup(name, description string, policy *GroupPolicy) (*DeviceGroup, error) {
	group := &DeviceGroup{
		ID:          fmt.Sprintf("group_%d", time.Now().Unix()),
		Name:        name,
		Description: description,
		Policy:      policy,
		DeviceIDs:   make([]string, 0),
	}
	
	f.groups.Store(group.ID, group)
	
	f.logger.Info("Created device group",
		zap.String("group_id", group.ID),
		zap.String("name", name),
	)
	
	return group, nil
}

// AddDeviceToGroup adds a device to a group
func (f *FarmManager) AddDeviceToGroup(deviceID, groupID string) error {
	value, ok := f.groups.Load(groupID)
	if !ok {
		return fmt.Errorf("group not found: %s", groupID)
	}
	
	group := value.(*DeviceGroup)
	
	// Check if device exists
	if _, err := f.manager.GetDevice(deviceID); err != nil {
		return err
	}
	
	// Add to group
	group.DeviceIDs = append(group.DeviceIDs, deviceID)
	
	// Apply group policy
	if err := f.applyGroupPolicy(deviceID, group.Policy); err != nil {
		return err
	}
	
	f.logger.Info("Added device to group",
		zap.String("device_id", deviceID),
		zap.String("group_id", groupID),
	)
	
	return nil
}

// CreateRack creates a new rack
func (f *FarmManager) CreateRack(id, location string, capacity int, powerCapacity float32) (*Rack, error) {
	rack := &Rack{
		ID:            id,
		Location:      location,
		Capacity:      capacity,
		DeviceSlots:   make(map[int]string),
		PowerCapacity: powerCapacity,
		PDUs:          make([]PDU, 0),
	}
	
	f.racks.Store(rack.ID, rack)
	
	f.logger.Info("Created rack",
		zap.String("rack_id", id),
		zap.String("location", location),
		zap.Int("capacity", capacity),
	)
	
	return rack, nil
}

// AssignDeviceToRack assigns a device to a rack slot
func (f *FarmManager) AssignDeviceToRack(deviceID, rackID string, slot int) error {
	value, ok := f.racks.Load(rackID)
	if !ok {
		return fmt.Errorf("rack not found: %s", rackID)
	}
	
	rack := value.(*Rack)
	
	// Check slot availability
	if slot < 0 || slot >= rack.Capacity {
		return fmt.Errorf("invalid slot: %d", slot)
	}
	
	if _, occupied := rack.DeviceSlots[slot]; occupied {
		return fmt.Errorf("slot %d already occupied", slot)
	}
	
	// Check if device exists
	device, err := f.manager.GetDevice(deviceID)
	if err != nil {
		return err
	}
	
	// Check power capacity
	devicePower := float32(device.PowerDraw.Load()) / 1000 // Convert to kW
	if rack.PowerUsed+devicePower > rack.PowerCapacity {
		return fmt.Errorf("insufficient power capacity in rack")
	}
	
	// Assign to slot
	rack.DeviceSlots[slot] = deviceID
	rack.PowerUsed += devicePower
	
	f.logger.Info("Assigned device to rack",
		zap.String("device_id", deviceID),
		zap.String("rack_id", rackID),
		zap.Int("slot", slot),
	)
	
	return nil
}

// GetFarmStats returns current farm statistics
func (f *FarmManager) GetFarmStats() *FarmStats {
	// Update aggregate stats
	devices := f.manager.GetAllDevices()
	
	var totalHashRate uint64
	var totalPower uint64
	var activeCount int32
	var totalEfficiency uint64
	var efficiencyCount int32
	
	for _, device := range devices {
		if device.GetStatus() == StatusMining {
			activeCount++
			totalHashRate += device.HashRate.Load()
			totalPower += uint64(device.PowerDraw.Load())
			
			eff := device.Efficiency.Load()
			if eff > 0 {
				totalEfficiency += uint64(eff)
				efficiencyCount++
			}
		}
	}
	
	f.stats.TotalDevices.Store(int32(len(devices)))
	f.stats.ActiveDevices.Store(activeCount)
	f.stats.TotalHashRate.Store(totalHashRate)
	f.stats.TotalPowerDraw.Store(totalPower)
	
	if efficiencyCount > 0 {
		avgEfficiency := totalEfficiency / uint64(efficiencyCount)
		f.stats.AverageEfficiency.Store(avgEfficiency)
	}
	
	return f.stats
}

// OptimizePowerDistribution optimizes power usage across the farm
func (f *FarmManager) OptimizePowerDistribution() error {
	if !f.config.PowerOptimization {
		return errors.New("power optimization not enabled")
	}
	
	f.logger.Info("Starting power optimization")
	
	// Get all devices grouped by efficiency
	devices := f.manager.GetAllDevices()
	
	// Sort by efficiency (J/TH)
	// Lower is better
	efficientDevices := make([]*ASICDevice, 0)
	for _, device := range devices {
		if device.GetStatus() == StatusMining {
			efficientDevices = append(efficientDevices, device)
		}
	}
	
	// Sort by efficiency
	sortDevicesByEfficiency(efficientDevices)
	
	// Calculate power budget
	currentPower := float32(f.stats.TotalPowerDraw.Load()) / 1000 // kW
	powerBudget := f.config.MaxPowerDraw
	
	if currentPower <= powerBudget {
		f.logger.Info("Power usage within budget",
			zap.Float32("current_kw", currentPower),
			zap.Float32("budget_kw", powerBudget),
		)
		return nil
	}
	
	// Need to reduce power
	powerToReduce := currentPower - powerBudget
	f.logger.Info("Reducing power consumption",
		zap.Float32("reduce_kw", powerToReduce),
	)
	
	// Start reducing power from least efficient devices
	for i := len(efficientDevices) - 1; i >= 0 && powerToReduce > 0; i-- {
		device := efficientDevices[i]
		
		// Switch to low power mode
		if err := device.SetWorkMode(ModeLowPower); err != nil {
			f.logger.Error("Failed to set low power mode",
				zap.String("device_id", device.ID),
				zap.Error(err),
			)
			continue
		}
		
		// Estimate power reduction (25% reduction in low power mode)
		devicePower := float32(device.PowerDraw.Load()) / 1000
		reduction := devicePower * 0.25
		powerToReduce -= reduction
		
		f.logger.Info("Switched device to low power mode",
			zap.String("device_id", device.ID),
			zap.Float32("power_saved_kw", reduction),
		)
	}
	
	return nil
}

// PerformLoadBalancing balances work across device groups
func (f *FarmManager) PerformLoadBalancing() error {
	if !f.config.LoadBalancing {
		return errors.New("load balancing not enabled")
	}
	
	f.logger.Info("Performing load balancing")
	
	// Calculate target hash rate per group
	totalHashRate := f.stats.TotalHashRate.Load()
	
	var groupCount int
	f.groups.Range(func(_, _ interface{}) bool {
		groupCount++
		return true
	})
	
	if groupCount == 0 {
		return errors.New("no device groups configured")
	}
	
	targetHashRatePerGroup := totalHashRate / uint64(groupCount)
	
	// Balance each group
	f.groups.Range(func(key, value interface{}) bool {
		group := value.(*DeviceGroup)
		f.balanceGroup(group, targetHashRatePerGroup)
		return true
	})
	
	return nil
}

// Private methods

func (f *FarmManager) monitorLoop() {
	defer f.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			f.updateFarmMetrics()
			f.checkAlertConditions()
		case <-f.ctx.Done():
			return
		}
	}
}

func (f *FarmManager) automationLoop() {
	defer f.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if f.config.PowerOptimization {
				f.OptimizePowerDistribution()
			}
			if f.config.LoadBalancing {
				f.PerformLoadBalancing()
			}
		case <-f.ctx.Done():
			return
		}
	}
}

func (f *FarmManager) maintenanceLoop() {
	defer f.wg.Done()
	
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			f.checkMaintenanceSchedules()
		case <-f.ctx.Done():
			return
		}
	}
}

func (f *FarmManager) alertLoop() {
	defer f.wg.Done()
	
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			f.processAlerts()
		case <-f.ctx.Done():
			return
		}
	}
}

func (f *FarmManager) updateFarmMetrics() {
	// Update group metrics
	f.groups.Range(func(key, value interface{}) bool {
		group := value.(*DeviceGroup)
		f.updateGroupMetrics(group)
		return true
	})
	
	// Update rack metrics
	f.racks.Range(func(key, value interface{}) bool {
		rack := value.(*Rack)
		f.updateRackMetrics(rack)
		return true
	})
}

func (f *FarmManager) updateGroupMetrics(group *DeviceGroup) {
	var totalHashRate uint64
	var totalPower uint64
	var activeCount int32
	
	for _, deviceID := range group.DeviceIDs {
		device, err := f.manager.GetDevice(deviceID)
		if err != nil {
			continue
		}
		
		if device.GetStatus() == StatusMining {
			activeCount++
			totalHashRate += device.HashRate.Load()
			totalPower += uint64(device.PowerDraw.Load())
		}
	}
	
	group.TotalHashRate.Store(totalHashRate)
	group.TotalPower.Store(totalPower)
	group.ActiveDevices.Store(activeCount)
}

func (f *FarmManager) updateRackMetrics(rack *Rack) {
	var totalPower float32
	
	for _, deviceID := range rack.DeviceSlots {
		device, err := f.manager.GetDevice(deviceID)
		if err != nil {
			continue
		}
		
		totalPower += float32(device.PowerDraw.Load()) / 1000 // Convert to kW
	}
	
	rack.PowerUsed = totalPower
}

func (f *FarmManager) checkAlertConditions() {
	thresholds := f.config.AlertThresholds
	
	// Check each device
	devices := f.manager.GetAllDevices()
	for _, device := range devices {
		// Check offline
		lastSeen := time.Unix(device.LastSeen.Load(), 0)
		if time.Since(lastSeen) > thresholds.OfflineTimeout {
			f.createAlert(AlertTypeDeviceOffline, device.ID, "Device offline", AlertError)
		}
		
		// Check temperature
		temp := device.Temperature.Load()
		if temp > int32(f.config.MaxTemperature) {
			f.createAlert(AlertTypeOverheating, device.ID, "Device overheating", AlertCritical)
		}
		
		// Check efficiency drop
		// Implementation depends on historical data
	}
}

func (f *FarmManager) createAlert(alertType AlertType, deviceID, message string, severity AlertSeverity) {
	alert := &Alert{
		ID:        fmt.Sprintf("alert_%d", time.Now().UnixNano()),
		Type:      alertType,
		Severity:  severity,
		DeviceID:  deviceID,
		Message:   message,
		Timestamp: time.Now(),
		Details:   make(map[string]interface{}),
	}
	
	f.alerter.alerts.Store(alert.ID, alert)
	
	// Process alert handlers
	for _, handler := range f.alerter.handlers {
		go handler.HandleAlert(alert)
	}
}

func (f *FarmManager) processAlerts() {
	// Process pending alerts
	f.alerter.alerts.Range(func(key, value interface{}) bool {
		alert := value.(*Alert)
		if !alert.Acknowledged {
			// Log unacknowledged alerts
			f.logger.Warn("Unacknowledged alert",
				zap.String("alert_id", alert.ID),
				zap.String("type", string(alert.Type)),
				zap.String("message", alert.Message),
			)
		}
		return true
	})
}

func (f *FarmManager) checkMaintenanceSchedules() {
	// Check if in maintenance window
	now := time.Now()
	window := f.config.MaintenanceWindow
	
	if now.Hour() >= window.StartHour && now.Hour() < window.StartHour+int(window.Duration.Hours()) {
		// Check day of week
		for _, day := range window.DaysOfWeek {
			if int(now.Weekday()) == day {
				f.performScheduledMaintenance()
				break
			}
		}
	}
}

func (f *FarmManager) performScheduledMaintenance() {
	f.scheduler.schedules.Range(func(key, value interface{}) bool {
		schedule := value.(*MaintenanceSchedule)
		if schedule.Enabled && time.Since(schedule.LastRun) > 24*time.Hour {
			f.executeMaintenance(schedule)
			schedule.LastRun = time.Now()
		}
		return true
	})
}

func (f *FarmManager) executeMaintenance(schedule *MaintenanceSchedule) {
	f.logger.Info("Executing maintenance",
		zap.String("schedule_id", schedule.ID),
		zap.String("name", schedule.Name),
	)
	
	// Execute based on task type
	switch schedule.TaskType {
	case MaintenanceRestart:
		// Restart devices in group
		if schedule.DeviceGroup != "" {
			f.restartDeviceGroup(schedule.DeviceGroup)
		}
	case MaintenanceFirmwareUpdate:
		// Firmware updates would be handled here
	case MaintenanceDiagnostic:
		// Run diagnostics
		f.runDiagnostics(schedule.DeviceGroup)
	}
}

func (f *FarmManager) restartDeviceGroup(groupID string) {
	value, ok := f.groups.Load(groupID)
	if !ok {
		return
	}
	
	group := value.(*DeviceGroup)
	for _, deviceID := range group.DeviceIDs {
		device, err := f.manager.GetDevice(deviceID)
		if err != nil {
			continue
		}
		
		device.Restart()
	}
}

func (f *FarmManager) runDiagnostics(groupID string) {
	// Implementation for diagnostics
	f.logger.Info("Running diagnostics", zap.String("group_id", groupID))
}

func (f *FarmManager) applyGroupPolicy(deviceID string, policy *GroupPolicy) error {
	device, err := f.manager.GetDevice(deviceID)
	if err != nil {
		return err
	}
	
	// Apply work mode
	if err := device.SetWorkMode(policy.WorkMode); err != nil {
		return err
	}
	
	// Other policy applications would go here
	
	return nil
}

func (f *FarmManager) balanceGroup(group *DeviceGroup, targetHashRate uint64) {
	currentHashRate := group.TotalHashRate.Load()
	
	if currentHashRate < targetHashRate {
		// Need to increase hash rate
		diff := targetHashRate - currentHashRate
		f.logger.Info("Increasing group hash rate",
			zap.String("group_id", group.ID),
			zap.Uint64("increase", diff),
		)
		
		// Switch idle devices to mining
		for _, deviceID := range group.DeviceIDs {
			device, err := f.manager.GetDevice(deviceID)
			if err != nil {
				continue
			}
			
			if device.GetStatus() == StatusIdle {
				// Start mining
				// Implementation depends on work distribution
			}
		}
	} else if currentHashRate > targetHashRate*1.1 { // 10% tolerance
		// Reduce hash rate if significantly over target
		f.logger.Info("Reducing group hash rate",
			zap.String("group_id", group.ID),
			zap.Uint64("current", currentHashRate),
			zap.Uint64("target", targetHashRate),
		)
	}
}

// Helper functions

func sortDevicesByEfficiency(devices []*ASICDevice) {
	// Simple bubble sort for demonstration
	// In production, use sort.Slice
	for i := 0; i < len(devices)-1; i++ {
		for j := 0; j < len(devices)-i-1; j++ {
			eff1 := devices[j].Efficiency.Load()
			eff2 := devices[j+1].Efficiency.Load()
			if eff1 > eff2 { // Higher efficiency value means worse efficiency
				devices[j], devices[j+1] = devices[j+1], devices[j]
			}
		}
	}
}

// AddAlertHandler adds an alert handler
func (f *FarmManager) AddAlertHandler(handler AlertHandler) {
	f.alerter.handlers = append(f.alerter.handlers, handler)
}

// ScheduleMaintenance schedules a maintenance task
func (f *FarmManager) ScheduleMaintenance(name, groupID string, taskType MaintenanceType, schedule string) error {
	maintenance := &MaintenanceSchedule{
		ID:          fmt.Sprintf("maint_%d", time.Now().Unix()),
		Name:        name,
		DeviceGroup: groupID,
		TaskType:    taskType,
		Schedule:    schedule,
		Enabled:     true,
	}
	
	f.scheduler.schedules.Store(maintenance.ID, maintenance)
	
	f.logger.Info("Scheduled maintenance",
		zap.String("maintenance_id", maintenance.ID),
		zap.String("name", name),
	)
	
	return nil
}

// ExportFarmConfig exports the farm configuration
func (f *FarmManager) ExportFarmConfig() ([]byte, error) {
	return json.MarshalIndent(f.config, "", "  ")
}

// ImportFarmConfig imports a farm configuration
func (f *FarmManager) ImportFarmConfig(data []byte) error {
	var config FarmConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("failed to parse config: %w", err)
	}
	
	f.config = &config
	return nil
}