package asic

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ASICType represents different ASIC manufacturers and models
type ASICType string

const (
	// Major ASIC manufacturers
	ASICTypeBitmain   ASICType = "bitmain"
	ASICTypeWhatsMiner ASICType = "whatsminer"
	ASICTypeCanaan    ASICType = "canaan"
	ASICTypeInnosilicon ASICType = "innosilicon"
	
	// Generic type for unknown ASICs
	ASICTypeGeneric   ASICType = "generic"
)

// ASICModel represents specific ASIC models
type ASICModel string

const (
	// Bitmain Antminer models
	ModelAntminerS19    ASICModel = "S19"
	ModelAntminerS19Pro ASICModel = "S19Pro"
	ModelAntminerS19XP  ASICModel = "S19XP"
	ModelAntminerT19    ASICModel = "T19"
	ModelAntminerS9     ASICModel = "S9"
	
	// WhatsMiner models
	ModelWhatsMinerM30S ASICModel = "M30S"
	ModelWhatsMinerM50  ASICModel = "M50"
	ModelWhatsMinerM60  ASICModel = "M60"
	
	// Canaan AvalonMiner models
	ModelAvalonMiner1246 ASICModel = "A1246"
	ModelAvalonMiner1366 ASICModel = "A1366"
	
	// Innosilicon models
	ModelInnosiliconT3  ASICModel = "T3"
)

// ChipType represents the ASIC chip architecture
type ChipType string

const (
	ChipTypeBM1397 ChipType = "BM1397" // Bitmain 7nm
	ChipTypeBM1398 ChipType = "BM1398" // Bitmain 5nm
	ChipTypeA3201  ChipType = "A3201"  // Canaan 7nm
	ChipTypeT3     ChipType = "T3"     // Innosilicon
)

// ASICStatus represents the current status of an ASIC device
type ASICStatus int

const (
	StatusOffline ASICStatus = iota
	StatusInitializing
	StatusIdle
	StatusMining
	StatusError
	StatusOverheating
	StatusMaintenance
)

// WorkMode represents ASIC operating modes
type WorkMode int

const (
	ModeNormal WorkMode = iota
	ModeLowPower
	ModeHighPerformance
	ModeSilent
)

// ASICDevice represents a physical ASIC mining device
type ASICDevice struct {
	// Device identification
	ID          string        `json:"id"`
	Type        ASICType      `json:"type"`
	Model       ASICModel     `json:"model"`
	SerialNumber string       `json:"serial_number"`
	FirmwareVersion string    `json:"firmware_version"`
	
	// Hardware specifications
	ChipType     ChipType      `json:"chip_type"`
	ChipCount    int           `json:"chip_count"`
	HashBoards   int           `json:"hash_boards"`
	Frequency    int           `json:"frequency_mhz"`
	
	// Performance metrics (atomic for thread safety)
	HashRate     atomic.Uint64 `json:"hash_rate"`      // H/s
	Temperature  atomic.Int32  `json:"temperature"`    // Celsius
	FanSpeed     atomic.Int32  `json:"fan_speed"`      // RPM
	PowerDraw    atomic.Int32  `json:"power_draw"`     // Watts
	Efficiency   atomic.Int32  `json:"efficiency"`     // J/TH
	
	// Status tracking
	Status       atomic.Int32  `json:"status"`
	WorkMode     atomic.Int32  `json:"work_mode"`
	LastSeen     atomic.Int64  `json:"last_seen"`
	Uptime       atomic.Int64  `json:"uptime"`
	
	// Error tracking
	HardwareErrors atomic.Uint64 `json:"hardware_errors"`
	RejectRate     atomic.Int32  `json:"reject_rate"` // percentage * 100
	
	// Communication
	comm         ASICCommunicator
	logger       *zap.Logger
	
	// Control
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.RWMutex
}

// ASICCommunicator defines the interface for ASIC communication protocols
type ASICCommunicator interface {
	Connect(address string, port int) error
	Disconnect() error
	IsConnected() bool
	
	// Commands
	GetStatus() (*DeviceStatus, error)
	GetHashRate() (uint64, error)
	GetTemperature() (map[string]float32, error)
	GetFanSpeed() ([]int, error)
	GetPowerStats() (*PowerStats, error)
	
	// Control
	SetFrequency(mhz int) error
	SetFanSpeed(percentage int) error
	SetWorkMode(mode WorkMode) error
	Reboot() error
	
	// Work management
	SendWork(work *MiningWork) error
	GetWorkStatus() (*WorkStatus, error)
}

// DeviceStatus contains comprehensive ASIC status information
type DeviceStatus struct {
	Uptime         time.Duration          `json:"uptime"`
	MHSAvg         float64               `json:"mhs_avg"`
	MHS5s          float64               `json:"mhs_5s"`
	Accepted       uint64                `json:"accepted"`
	Rejected       uint64                `json:"rejected"`
	HardwareErrors uint64                `json:"hardware_errors"`
	Utility        float64               `json:"utility"`
	LastShare      time.Time             `json:"last_share"`
	Temperatures   map[string]float32    `json:"temperatures"`
	FanSpeeds      []int                 `json:"fan_speeds"`
	Frequency      int                   `json:"frequency"`
	Voltage        float32               `json:"voltage"`
}

// PowerStats contains power consumption information
type PowerStats struct {
	InputVoltage   float32 `json:"input_voltage"`
	InputCurrent   float32 `json:"input_current"`
	InputPower     float32 `json:"input_power"`
	OutputVoltage  float32 `json:"output_voltage"`
	OutputCurrent  float32 `json:"output_current"`
	OutputPower    float32 `json:"output_power"`
	Efficiency     float32 `json:"efficiency"`
}

// MiningWork represents work to be processed by the ASIC
type MiningWork struct {
	JobID        string    `json:"job_id"`
	PrevHash     string    `json:"prev_hash"`
	CoinbaseA    string    `json:"coinbase_a"`
	CoinbaseB    string    `json:"coinbase_b"`
	MerkleBranch []string  `json:"merkle_branch"`
	Version      uint32    `json:"version"`
	NBits        uint32    `json:"nbits"`
	NTime        uint32    `json:"ntime"`
	CleanJobs    bool      `json:"clean_jobs"`
	Target       string    `json:"target"`
}

// WorkStatus represents the current work processing status
type WorkStatus struct {
	CurrentJobID   string    `json:"current_job_id"`
	WorkQueueSize  int       `json:"work_queue_size"`
	ProcessedWork  uint64    `json:"processed_work"`
	ValidShares    uint64    `json:"valid_shares"`
	StaleShares    uint64    `json:"stale_shares"`
	DuplicateShares uint64   `json:"duplicate_shares"`
}

// ASICManager manages multiple ASIC devices
type ASICManager struct {
	logger       *zap.Logger
	devices      sync.Map // map[string]*ASICDevice
	deviceCount  atomic.Int32
	
	// Configuration
	config       *ManagerConfig
	
	// Monitoring
	monitor      *ASICMonitor
	
	// Control
	ctx          context.Context
	cancel       context.CancelFunc
	wg           sync.WaitGroup
}

// ManagerConfig contains ASIC manager configuration
type ManagerConfig struct {
	// Discovery settings
	AutoDiscovery     bool          `json:"auto_discovery"`
	DiscoveryInterval time.Duration `json:"discovery_interval"`
	ScanSubnets       []string      `json:"scan_subnets"`
	
	// Monitoring settings
	MonitorInterval   time.Duration `json:"monitor_interval"`
	HealthCheckInterval time.Duration `json:"health_check_interval"`
	
	// Control settings
	AutoRestart       bool          `json:"auto_restart"`
	OverheatThreshold int           `json:"overheat_threshold"` // Celsius
	MinHashRate       uint64        `json:"min_hash_rate"`      // H/s
	
	// Performance settings
	DefaultWorkMode   WorkMode      `json:"default_work_mode"`
	PowerLimit        int           `json:"power_limit"`        // Watts
}

// NewASICManager creates a new ASIC manager
func NewASICManager(logger *zap.Logger, config *ManagerConfig) *ASICManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	manager := &ASICManager{
		logger: logger,
		config: config,
		ctx:    ctx,
		cancel: cancel,
	}
	
	// Initialize monitor
	manager.monitor = NewASICMonitor(logger, manager)
	
	return manager
}

// Start starts the ASIC manager
func (m *ASICManager) Start() error {
	m.logger.Info("Starting ASIC manager")
	
	// Start device discovery if enabled
	if m.config.AutoDiscovery {
		m.wg.Add(1)
		go m.discoveryLoop()
	}
	
	// Start monitoring
	m.wg.Add(1)
	go m.monitoringLoop()
	
	// Start health checks
	m.wg.Add(1)
	go m.healthCheckLoop()
	
	return nil
}

// Stop stops the ASIC manager
func (m *ASICManager) Stop() error {
	m.logger.Info("Stopping ASIC manager")
	
	m.cancel()
	m.wg.Wait()
	
	// Disconnect all devices
	m.devices.Range(func(key, value interface{}) bool {
		device := value.(*ASICDevice)
		device.Disconnect()
		return true
	})
	
	return nil
}

// AddDevice adds a new ASIC device
func (m *ASICManager) AddDevice(address string, port int, deviceType ASICType) (*ASICDevice, error) {
	// Create appropriate communicator based on device type
	comm, err := m.createCommunicator(deviceType)
	if err != nil {
		return nil, fmt.Errorf("failed to create communicator: %w", err)
	}
	
	// Connect to device
	if err := comm.Connect(address, port); err != nil {
		return nil, fmt.Errorf("failed to connect to device: %w", err)
	}
	
	// Get device information
	status, err := comm.GetStatus()
	if err != nil {
		comm.Disconnect()
		return nil, fmt.Errorf("failed to get device status: %w", err)
	}
	
	// Create device instance
	device := m.createDevice(address, deviceType, comm, status)
	
	// Register device
	m.devices.Store(device.ID, device)
	m.deviceCount.Add(1)
	
	// Start device monitoring
	device.Start()
	
	m.logger.Info("Added ASIC device",
		zap.String("device_id", device.ID),
		zap.String("type", string(device.Type)),
		zap.String("model", string(device.Model)),
	)
	
	return device, nil
}

// RemoveDevice removes an ASIC device
func (m *ASICManager) RemoveDevice(deviceID string) error {
	value, ok := m.devices.LoadAndDelete(deviceID)
	if !ok {
		return fmt.Errorf("device not found: %s", deviceID)
	}
	
	device := value.(*ASICDevice)
	device.Stop()
	
	m.deviceCount.Add(-1)
	
	m.logger.Info("Removed ASIC device", zap.String("device_id", deviceID))
	return nil
}

// GetDevice returns a specific device
func (m *ASICManager) GetDevice(deviceID string) (*ASICDevice, error) {
	value, ok := m.devices.Load(deviceID)
	if !ok {
		return nil, fmt.Errorf("device not found: %s", deviceID)
	}
	
	return value.(*ASICDevice), nil
}

// GetAllDevices returns all managed devices
func (m *ASICManager) GetAllDevices() []*ASICDevice {
	var devices []*ASICDevice
	
	m.devices.Range(func(key, value interface{}) bool {
		devices = append(devices, value.(*ASICDevice))
		return true
	})
	
	return devices
}

// GetStats returns aggregated statistics for all devices
func (m *ASICManager) GetStats() map[string]interface{} {
	stats := make(map[string]interface{})
	
	var totalHashRate uint64
	var totalPower int32
	var activeDevices int32
	var totalErrors uint64
	
	m.devices.Range(func(key, value interface{}) bool {
		device := value.(*ASICDevice)
		
		if device.GetStatus() == StatusMining {
			activeDevices++
			totalHashRate += device.HashRate.Load()
			totalPower += device.PowerDraw.Load()
			totalErrors += device.HardwareErrors.Load()
		}
		
		return true
	})
	
	stats["total_devices"] = m.deviceCount.Load()
	stats["active_devices"] = activeDevices
	stats["total_hash_rate"] = totalHashRate
	stats["total_power"] = totalPower
	stats["total_errors"] = totalErrors
	stats["average_efficiency"] = m.calculateAverageEfficiency()
	
	return stats
}

// Private methods

func (m *ASICManager) createCommunicator(deviceType ASICType) (ASICCommunicator, error) {
	switch deviceType {
	case ASICTypeBitmain:
		return NewBitmainCommunicator(m.logger), nil
	case ASICTypeWhatsMiner:
		return NewWhatsMinerCommunicator(m.logger), nil
	case ASICTypeCanaan:
		return NewCanaanCommunicator(m.logger), nil
	case ASICTypeInnosilicon:
		return NewInnosiliconCommunicator(m.logger), nil
	default:
		return NewGenericCommunicator(m.logger), nil
	}
}

func (m *ASICManager) createDevice(address string, deviceType ASICType, comm ASICCommunicator, status *DeviceStatus) *ASICDevice {
	ctx, cancel := context.WithCancel(m.ctx)
	
	device := &ASICDevice{
		ID:       fmt.Sprintf("%s_%d", address, time.Now().Unix()),
		Type:     deviceType,
		comm:     comm,
		logger:   m.logger.With(zap.String("device", address)),
		ctx:      ctx,
		cancel:   cancel,
	}
	
	// Set initial values
	device.Status.Store(int32(StatusInitializing))
	device.WorkMode.Store(int32(m.config.DefaultWorkMode))
	device.LastSeen.Store(time.Now().Unix())
	
	return device
}

func (m *ASICManager) discoveryLoop() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(m.config.DiscoveryInterval)
	defer ticker.Stop()
	
	// Initial discovery
	m.discoverDevices()
	
	for {
		select {
		case <-ticker.C:
			m.discoverDevices()
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *ASICManager) discoverDevices() {
	m.logger.Debug("Starting ASIC device discovery")
	
	// Scan configured subnets
	for _, subnet := range m.config.ScanSubnets {
		m.scanSubnet(subnet)
	}
}

func (m *ASICManager) scanSubnet(subnet string) {
	// Implementation would scan the subnet for ASIC devices
	// This is a placeholder for the actual network scanning logic
	m.logger.Debug("Scanning subnet for ASIC devices", zap.String("subnet", subnet))
}

func (m *ASICManager) monitoringLoop() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(m.config.MonitorInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			m.updateDeviceMetrics()
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *ASICManager) updateDeviceMetrics() {
	m.devices.Range(func(key, value interface{}) bool {
		device := value.(*ASICDevice)
		device.UpdateMetrics()
		return true
	})
}

func (m *ASICManager) healthCheckLoop() {
	defer m.wg.Done()
	
	ticker := time.NewTicker(m.config.HealthCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			m.performHealthChecks()
		case <-m.ctx.Done():
			return
		}
	}
}

func (m *ASICManager) performHealthChecks() {
	m.devices.Range(func(key, value interface{}) bool {
		device := value.(*ASICDevice)
		
		// Check temperature
		temp := device.Temperature.Load()
		if temp > int32(m.config.OverheatThreshold) {
			m.handleOverheating(device)
		}
		
		// Check hash rate
		hashRate := device.HashRate.Load()
		if hashRate < m.config.MinHashRate && device.GetStatus() == StatusMining {
			m.handleLowHashRate(device)
		}
		
		// Check connectivity
		if !device.IsConnected() {
			m.handleDisconnected(device)
		}
		
		return true
	})
}

func (m *ASICManager) handleOverheating(device *ASICDevice) {
	m.logger.Warn("ASIC device overheating",
		zap.String("device_id", device.ID),
		zap.Int32("temperature", device.Temperature.Load()),
	)
	
	// Set to low power mode
	device.SetWorkMode(ModeLowPower)
	
	// Increase fan speed
	device.SetFanSpeed(100)
}

func (m *ASICManager) handleLowHashRate(device *ASICDevice) {
	m.logger.Warn("ASIC device low hash rate",
		zap.String("device_id", device.ID),
		zap.Uint64("hash_rate", device.HashRate.Load()),
	)
	
	if m.config.AutoRestart {
		device.Restart()
	}
}

func (m *ASICManager) handleDisconnected(device *ASICDevice) {
	m.logger.Error("ASIC device disconnected",
		zap.String("device_id", device.ID),
	)
	
	// Attempt reconnection
	device.Reconnect()
}

func (m *ASICManager) calculateAverageEfficiency() float64 {
	var totalEfficiency int64
	var count int32
	
	m.devices.Range(func(key, value interface{}) bool {
		device := value.(*ASICDevice)
		if device.GetStatus() == StatusMining {
			totalEfficiency += int64(device.Efficiency.Load())
			count++
		}
		return true
	})
	
	if count == 0 {
		return 0
	}
	
	return float64(totalEfficiency) / float64(count) / 100 // Convert from percentage * 100
}

// Device methods

// Start starts the ASIC device monitoring
func (d *ASICDevice) Start() error {
	d.Status.Store(int32(StatusIdle))
	go d.monitorLoop()
	return nil
}

// Stop stops the ASIC device
func (d *ASICDevice) Stop() error {
	d.cancel()
	return d.Disconnect()
}

// Disconnect disconnects from the ASIC device
func (d *ASICDevice) Disconnect() error {
	if d.comm != nil {
		return d.comm.Disconnect()
	}
	return nil
}

// IsConnected checks if the device is connected
func (d *ASICDevice) IsConnected() bool {
	if d.comm != nil {
		return d.comm.IsConnected()
	}
	return false
}

// GetStatus returns the current device status
func (d *ASICDevice) GetStatus() ASICStatus {
	return ASICStatus(d.Status.Load())
}

// SetWorkMode sets the device work mode
func (d *ASICDevice) SetWorkMode(mode WorkMode) error {
	if err := d.comm.SetWorkMode(mode); err != nil {
		return err
	}
	d.WorkMode.Store(int32(mode))
	return nil
}

// SetFanSpeed sets the fan speed percentage
func (d *ASICDevice) SetFanSpeed(percentage int) error {
	return d.comm.SetFanSpeed(percentage)
}

// SetFrequency sets the chip frequency
func (d *ASICDevice) SetFrequency(mhz int) error {
	if err := d.comm.SetFrequency(mhz); err != nil {
		return err
	}
	d.Frequency = mhz
	return nil
}

// Restart restarts the ASIC device
func (d *ASICDevice) Restart() error {
	d.logger.Info("Restarting ASIC device", zap.String("device_id", d.ID))
	return d.comm.Reboot()
}

// Reconnect attempts to reconnect to the device
func (d *ASICDevice) Reconnect() error {
	// Implementation depends on the specific device type
	return errors.New("reconnect not implemented")
}

// UpdateMetrics updates device metrics from hardware
func (d *ASICDevice) UpdateMetrics() error {
	// Get current status
	status, err := d.comm.GetStatus()
	if err != nil {
		return err
	}
	
	// Update hash rate
	d.HashRate.Store(uint64(status.MHS5s * 1e6)) // Convert MH/s to H/s
	
	// Update temperature (use highest temp)
	var maxTemp float32
	for _, temp := range status.Temperatures {
		if temp > maxTemp {
			maxTemp = temp
		}
	}
	d.Temperature.Store(int32(maxTemp))
	
	// Update fan speed (use average)
	if len(status.FanSpeeds) > 0 {
		var totalSpeed int
		for _, speed := range status.FanSpeeds {
			totalSpeed += speed
		}
		d.FanSpeed.Store(int32(totalSpeed / len(status.FanSpeeds)))
	}
	
	// Update hardware errors
	d.HardwareErrors.Store(status.HardwareErrors)
	
	// Update reject rate
	if status.Accepted+status.Rejected > 0 {
		rejectRate := float64(status.Rejected) / float64(status.Accepted+status.Rejected) * 10000 // percentage * 100
		d.RejectRate.Store(int32(rejectRate))
	}
	
	// Update last seen
	d.LastSeen.Store(time.Now().Unix())
	
	// Get power stats
	powerStats, err := d.comm.GetPowerStats()
	if err == nil {
		d.PowerDraw.Store(int32(powerStats.InputPower))
		
		// Calculate efficiency (J/TH)
		if d.HashRate.Load() > 0 {
			efficiency := float64(powerStats.InputPower) / (float64(d.HashRate.Load()) / 1e12) // W / TH/s
			d.Efficiency.Store(int32(efficiency * 100)) // Store as percentage * 100
		}
	}
	
	return nil
}

// SendWork sends mining work to the device
func (d *ASICDevice) SendWork(work *MiningWork) error {
	if d.GetStatus() != StatusMining && d.GetStatus() != StatusIdle {
		return fmt.Errorf("device not ready for work: status=%v", d.GetStatus())
	}
	
	if err := d.comm.SendWork(work); err != nil {
		return err
	}
	
	d.Status.Store(int32(StatusMining))
	return nil
}

// GetWorkStatus returns the current work status
func (d *ASICDevice) GetWorkStatus() (*WorkStatus, error) {
	return d.comm.GetWorkStatus()
}

// monitorLoop continuously monitors the device
func (d *ASICDevice) monitorLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if err := d.UpdateMetrics(); err != nil {
				d.logger.Error("Failed to update metrics",
					zap.String("device_id", d.ID),
					zap.Error(err),
				)
				d.Status.Store(int32(StatusError))
			}
		case <-d.ctx.Done():
			return
		}
	}
}

// ASICMonitor provides advanced monitoring capabilities
type ASICMonitor struct {
	logger  *zap.Logger
	manager *ASICManager
}

// NewASICMonitor creates a new ASIC monitor
func NewASICMonitor(logger *zap.Logger, manager *ASICManager) *ASICMonitor {
	return &ASICMonitor{
		logger:  logger,
		manager: manager,
	}
}

// GetHealthReport generates a comprehensive health report
func (m *ASICMonitor) GetHealthReport() map[string]interface{} {
	report := make(map[string]interface{})
	
	var healthyDevices, warningDevices, errorDevices int
	var deviceReports []map[string]interface{}
	
	m.manager.devices.Range(func(key, value interface{}) bool {
		device := value.(*ASICDevice)
		deviceReport := m.getDeviceHealth(device)
		deviceReports = append(deviceReports, deviceReport)
		
		switch deviceReport["health_status"].(string) {
		case "healthy":
			healthyDevices++
		case "warning":
			warningDevices++
		case "error":
			errorDevices++
		}
		
		return true
	})
	
	report["healthy_devices"] = healthyDevices
	report["warning_devices"] = warningDevices
	report["error_devices"] = errorDevices
	report["devices"] = deviceReports
	report["timestamp"] = time.Now().Unix()
	
	return report
}

func (m *ASICMonitor) getDeviceHealth(device *ASICDevice) map[string]interface{} {
	health := make(map[string]interface{})
	
	health["device_id"] = device.ID
	health["status"] = device.GetStatus().String()
	health["hash_rate"] = device.HashRate.Load()
	health["temperature"] = device.Temperature.Load()
	health["power_draw"] = device.PowerDraw.Load()
	health["efficiency"] = float64(device.Efficiency.Load()) / 100
	health["hardware_errors"] = device.HardwareErrors.Load()
	health["reject_rate"] = float64(device.RejectRate.Load()) / 100
	health["uptime"] = device.Uptime.Load()
	
	// Determine health status
	healthStatus := "healthy"
	
	if device.Temperature.Load() > 85 {
		healthStatus = "warning"
	}
	if device.Temperature.Load() > 95 {
		healthStatus = "error"
	}
	if device.GetStatus() == StatusError {
		healthStatus = "error"
	}
	if device.RejectRate.Load() > 500 { // > 5%
		healthStatus = "warning"
	}
	
	health["health_status"] = healthStatus
	
	return health
}

// String returns string representation of ASICStatus
func (s ASICStatus) String() string {
	switch s {
	case StatusOffline:
		return "offline"
	case StatusInitializing:
		return "initializing"
	case StatusIdle:
		return "idle"
	case StatusMining:
		return "mining"
	case StatusError:
		return "error"
	case StatusOverheating:
		return "overheating"
	case StatusMaintenance:
		return "maintenance"
	default:
		return "unknown"
	}
}