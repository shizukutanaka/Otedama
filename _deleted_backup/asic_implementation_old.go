package mining

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/mining/algorithms"
	"go.uber.org/zap"
)

// ASICHardware implements ASIC mining with support for multiple manufacturers
type ASICHardware struct {
	logger      *zap.Logger
	config      *OptimizedConfig
	devices     []*ASICDevice
	workChan    chan *Work
	shareChan   chan *Share
	hashRate    atomic.Uint64
	running     atomic.Bool
	ctx         context.Context
	cancel      context.CancelFunc
	metrics     *ASICMetrics
	pools       []*PoolConnection
}

// ASICDevice represents a single ASIC mining device
type ASICDevice struct {
	ID            int
	Name          string
	Manufacturer  ASICManufacturer
	Model         string
	Algorithm     string
	IPAddress     string
	Port          int
	HashRate      atomic.Uint64
	Temperature   atomic.Uint64 // Fixed-point storage
	PowerUsage    atomic.Uint64 // Fixed-point storage
	FanSpeed      atomic.Uint64 // RPM
	Voltage       atomic.Uint64 // Fixed-point storage
	Frequency     atomic.Uint64 // MHz
	Status        ASICStatus
	Connection    net.Conn
	LastSeen      time.Time
	ErrorCount    atomic.Uint64
	SubmittedWork atomic.Uint64
	AcceptedWork  atomic.Uint64
	RejectedWork  atomic.Uint64
}

// ASICManufacturer represents ASIC manufacturers
type ASICManufacturer int

const (
	ASICManufacturerUnknown ASICManufacturer = iota
	ASICManufacturerBitmain
	ASICManufacturerCanaan
	ASICManufacturerInnosilicon
	ASICManufacturerMicroBT
	ASICManufacturerGoldshell
	ASICManufacturerIBeLink
)

// ASICStatus represents ASIC device status
type ASICStatus int

const (
	ASICStatusOffline ASICStatus = iota
	ASICStatusOnline
	ASICStatusMining
	ASICStatusError
	ASICStatusOverheated
	ASICStatusLowHashRate
)

// ASICMetrics tracks ASIC mining performance
type ASICMetrics struct {
	TotalHashRate       atomic.Uint64
	AverageTemp         atomic.Uint64
	TotalPowerUsage     atomic.Uint64
	TotalSubmittedWork  atomic.Uint64
	TotalAcceptedWork   atomic.Uint64
	TotalRejectedWork   atomic.Uint64
	PoolSwitchCount     atomic.Uint64
	RestartCount        atomic.Uint64
	ErrorRate           atomic.Uint64 // Errors per hour * 100
}

// PoolConnection represents a connection to a mining pool
type PoolConnection struct {
	URL      string
	User     string
	Password string
	Priority int
	Conn     net.Conn
	Active   bool
}

// NewASICHardware creates a new ASIC hardware instance
func NewASICHardware(logger *zap.Logger) *ASICHardware {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &ASICHardware{
		logger:    logger,
		workChan:  make(chan *Work, 100),
		shareChan: make(chan *Share, 10000),
		ctx:       ctx,
		cancel:    cancel,
		metrics:   &ASICMetrics{},
	}
}

// Initialize initializes ASIC hardware
func (h *ASICHardware) Initialize(config *OptimizedConfig) error {
	h.config = config

	// Scan for ASIC devices on network
	devices, err := h.discoverASICDevices()
	if err != nil {
		return fmt.Errorf("ASIC discovery failed: %w", err)
	}

	if len(devices) == 0 {
		return errors.New("no ASIC devices found")
	}

	h.devices = devices
	h.logger.Info("ASIC devices discovered",
		zap.Int("count", len(devices)),
		zap.String("algorithm", config.Algorithm))

	// Initialize pool connections
	if err := h.initializePools(); err != nil {
		return fmt.Errorf("pool initialization failed: %w", err)
	}

	// Initialize each ASIC device
	for _, device := range h.devices {
		if err := h.initializeDevice(device); err != nil {
			h.logger.Warn("Failed to initialize ASIC device",
				zap.Int("device_id", device.ID),
				zap.String("name", device.Name),
				zap.Error(err))
			continue
		}
	}

	return nil
}

// Start begins ASIC mining
func (h *ASICHardware) Start(ctx context.Context) error {
	if !h.running.CompareAndSwap(false, true) {
		return errors.New("ASIC mining already running")
	}

	// Start mining on each device
	for _, device := range h.devices {
		go h.runDeviceMining(ctx, device)
	}

	// Start monitoring goroutines
	go h.monitorDevices(ctx)
	go h.managePoolConnections(ctx)
	go h.processShares(ctx)
	go h.healthCheck(ctx)

	h.logger.Info("ASIC mining started",
		zap.Int("devices", len(h.devices)))

	return nil
}

// Stop halts ASIC mining
func (h *ASICHardware) Stop() error {
	if !h.running.CompareAndSwap(true, false) {
		return nil
	}

	h.cancel()
	close(h.workChan)

	// Stop mining on all devices
	for _, device := range h.devices {
		h.stopDevice(device)
	}

	// Close pool connections
	for _, pool := range h.pools {
		if pool.Conn != nil {
			pool.Conn.Close()
		}
	}

	h.logger.Info("ASIC mining stopped")
	return nil
}

// SubmitWork submits new mining work to ASICs
func (h *ASICHardware) SubmitWork(work *Work) error {
	if !h.running.Load() {
		return errors.New("ASIC mining not running")
	}

	select {
	case h.workChan <- work:
		return nil
	default:
		return errors.New("ASIC work queue full")
	}
}

// GetHashRate returns combined hash rate of all ASICs
func (h *ASICHardware) GetHashRate() uint64 {
	return h.metrics.TotalHashRate.Load()
}

// GetTemperature returns average ASIC temperature
func (h *ASICHardware) GetTemperature() float64 {
	return float64(h.metrics.AverageTemp.Load()) / 100.0
}

// GetPowerUsage returns total ASIC power usage
func (h *ASICHardware) GetPowerUsage() float64 {
	return float64(h.metrics.TotalPowerUsage.Load()) / 100.0
}

// discoverASICDevices discovers ASIC devices on the network
func (h *ASICHardware) discoverASICDevices() ([]*ASICDevice, error) {
	var devices []*ASICDevice
	
	// Common ASIC IP ranges and ports
	ipRanges := []string{
		"192.168.1.0/24",
		"192.168.0.0/24",
		"10.0.0.0/24",
	}
	
	ports := []int{4028, 22, 80, 8080} // Common ASIC ports
	
	for _, ipRange := range ipRanges {
		discovered, err := h.scanIPRange(ipRange, ports)
		if err != nil {
			h.logger.Warn("Failed to scan IP range",
				zap.String("range", ipRange),
				zap.Error(err))
			continue
		}
		devices = append(devices, discovered...)
	}
	
	return devices, nil
}

// scanIPRange scans an IP range for ASIC devices
func (h *ASICHardware) scanIPRange(ipRange string, ports []int) ([]*ASICDevice, error) {
	var devices []*ASICDevice
	
	// Parse IP range
	_, ipnet, err := net.ParseCIDR(ipRange)
	if err != nil {
		return nil, err
	}
	
	// Generate IPs in range
	for ip := ipnet.IP.Mask(ipnet.Mask); ipnet.Contains(ip); h.incrementIP(ip) {
		for _, port := range ports {
			device := h.probeASIC(ip.String(), port)
			if device != nil {
				devices = append(devices, device)
				break // Found device, don't check other ports
			}
		}
	}
	
	return devices, nil
}

// incrementIP increments an IP address
func (h *ASICHardware) incrementIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] > 0 {
			break
		}
	}
}

// probeASIC probes an IP:port for ASIC device
func (h *ASICHardware) probeASIC(ip string, port int) *ASICDevice {
	// Try to connect to potential ASIC
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", ip, port), 2*time.Second)
	if err != nil {
		return nil
	}
	defer conn.Close()
	
	// Try to identify ASIC type
	manufacturer, model := h.identifyASIC(conn, ip, port)
	if manufacturer == ASICManufacturerUnknown {
		return nil
	}
	
	device := &ASICDevice{
		ID:           len(h.devices),
		Name:         fmt.Sprintf("%s %s", h.manufacturerName(manufacturer), model),
		Manufacturer: manufacturer,
		Model:        model,
		IPAddress:    ip,
		Port:         port,
		Status:       ASICStatusOffline,
		LastSeen:     time.Now(),
	}
	
	// Get algorithm support
	device.Algorithm = h.getDeviceAlgorithm(manufacturer, model)
	
	h.logger.Info("ASIC device discovered",
		zap.String("ip", ip),
		zap.Int("port", port),
		zap.String("name", device.Name),
		zap.String("algorithm", device.Algorithm))
	
	return device
}

// identifyASIC identifies ASIC manufacturer and model
func (h *ASICHardware) identifyASIC(conn net.Conn, ip string, port int) (ASICManufacturer, string) {
	// Try different manufacturer-specific protocols
	
	// Try Bitmain (CGMiner API)
	if manufacturer, model := h.probeBitmain(conn); manufacturer != ASICManufacturerUnknown {
		return manufacturer, model
	}
	
	// Try MicroBT
	if manufacturer, model := h.probeMicroBT(conn); manufacturer != ASICManufacturerUnknown {
		return manufacturer, model
	}
	
	// Try Canaan
	if manufacturer, model := h.probeCanaan(conn); manufacturer != ASICManufacturerUnknown {
		return manufacturer, model
	}
	
	// Try Innosilicon
	if manufacturer, model := h.probeInnosilicon(conn); manufacturer != ASICManufacturerUnknown {
		return manufacturer, model
	}
	
	return ASICManufacturerUnknown, ""
}

// probeBitmain probes for Bitmain ASICs using CGMiner API
func (h *ASICHardware) probeBitmain(conn net.Conn) (ASICManufacturer, string) {
	// Send CGMiner API command
	cmd := `{"command":"version"}`
	
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := conn.Write([]byte(cmd))
	if err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	response := make([]byte, 1024)
	n, err := conn.Read(response)
	if err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	// Parse response to identify model
	var result map[string]interface{}
	if err := json.Unmarshal(response[:n], &result); err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	// Check for Bitmain signature
	if version, ok := result["VERSION"]; ok {
		if versionArray, ok := version.([]interface{}); ok && len(versionArray) > 0 {
			if versionInfo, ok := versionArray[0].(map[string]interface{}); ok {
				if description, ok := versionInfo["Description"].(string); ok {
					if model := h.extractBitmainModel(description); model != "" {
						return ASICManufacturerBitmain, model
					}
				}
			}
		}
	}
	
	return ASICManufacturerUnknown, ""
}

// probeMicroBT probes for MicroBT ASICs
func (h *ASICHardware) probeMicroBT(conn net.Conn) (ASICManufacturer, string) {
	// MicroBT-specific detection logic
	// Try HTTP API first
	cmd := "GET /cgi-bin/get_system_info HTTP/1.1\r\nHost: " + conn.RemoteAddr().String() + "\r\n\r\n"
	
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := conn.Write([]byte(cmd))
	if err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	response := make([]byte, 2048)
	n, err := conn.Read(response)
	if err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	responseStr := string(response[:n])
	if model := h.extractMicroBTModel(responseStr); model != "" {
		return ASICManufacturerMicroBT, model
	}
	
	return ASICManufacturerUnknown, ""
}

// probeCanaan probes for Canaan ASICs
func (h *ASICHardware) probeCanaan(conn net.Conn) (ASICManufacturer, string) {
	// Canaan-specific detection logic
	return ASICManufacturerUnknown, ""
}

// probeInnosilicon probes for Innosilicon ASICs
func (h *ASICHardware) probeInnosilicon(conn net.Conn) (ASICManufacturer, string) {
	// Innosilicon-specific detection logic
	return ASICManufacturerUnknown, ""
}

// extractBitmainModel extracts model from Bitmain description
func (h *ASICHardware) extractBitmainModel(description string) string {
	// Parse description to extract model (e.g., "Antminer S19 Pro")
	models := []string{"S21", "S19", "S17", "S15", "S9", "L7", "L3", "D7", "Z15", "T19", "T17"}
	for _, model := range models {
		if contains(description, model) {
			return "Antminer " + model
		}
	}
	return ""
}

// extractMicroBTModel extracts model from MicroBT response
func (h *ASICHardware) extractMicroBTModel(response string) string {
	// Parse response to extract model (e.g., "WhatsMiner M63S")
	models := []string{"M63", "M60", "M56", "M53", "M50", "M32", "M31", "M30"}
	for _, model := range models {
		if contains(response, model) {
			return "WhatsMiner " + model
		}
	}
	return ""
}

// contains checks if string contains substring (case-insensitive)
func contains(s, substr string) bool {
	return len(s) >= len(substr) && 
		   (s == substr || 
			len(s) > len(substr) && 
			(s[:len(substr)] == substr || 
			 s[len(s)-len(substr):] == substr ||
			 findSubstring(s, substr)))
}

func findSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// manufacturerName returns string name for manufacturer
func (h *ASICHardware) manufacturerName(manufacturer ASICManufacturer) string {
	switch manufacturer {
	case ASICManufacturerBitmain:
		return "Bitmain"
	case ASICManufacturerMicroBT:
		return "MicroBT"
	case ASICManufacturerCanaan:
		return "Canaan"
	case ASICManufacturerInnosilicon:
		return "Innosilicon"
	case ASICManufacturerGoldshell:
		return "Goldshell"
	case ASICManufacturerIBeLink:
		return "iBeLink"
	default:
		return "Unknown"
	}
}

// getDeviceAlgorithm returns supported algorithm for device
func (h *ASICHardware) getDeviceAlgorithm(manufacturer ASICManufacturer, model string) string {
	// Return algorithm based on manufacturer and model
	switch manufacturer {
	case ASICManufacturerBitmain:
		if contains(model, "S") {
			return "sha256" // Bitcoin ASICs
		} else if contains(model, "L") {
			return "scrypt" // Litecoin ASICs
		} else if contains(model, "D") {
			return "x11" // Dash ASICs
		}
	case ASICManufacturerMicroBT:
		return "sha256" // Primarily Bitcoin ASICs
	case ASICManufacturerGoldshell:
		if contains(model, "LT") {
			return "scrypt"
		} else if contains(model, "HS") {
			return "handshake"
		}
	}
	
	return "sha256" // Default to Bitcoin
}

// initializePools initializes pool connections
func (h *ASICHardware) initializePools() error {
	h.pools = make([]*PoolConnection, 0)
	
	// Add pools from config
	for _, poolConfig := range h.config.PoolURL {
		pool := &PoolConnection{
			URL:      poolConfig,
			User:     h.config.WalletAddr,
			Password: "x",
			Priority: 1,
		}
		h.pools = append(h.pools, pool)
	}
	
	// Connect to primary pool
	if len(h.pools) > 0 {
		if err := h.connectToPool(h.pools[0]); err != nil {
			return fmt.Errorf("failed to connect to primary pool: %w", err)
		}
	}
	
	return nil
}

// connectToPool connects to a mining pool
func (h *ASICHardware) connectToPool(pool *PoolConnection) error {
	// Parse pool URL
	conn, err := net.Dial("tcp", pool.URL)
	if err != nil {
		return err
	}
	
	pool.Conn = conn
	pool.Active = true
	
	h.logger.Info("Connected to mining pool",
		zap.String("url", pool.URL))
	
	return nil
}

// initializeDevice initializes a specific ASIC device
func (h *ASICHardware) initializeDevice(device *ASICDevice) error {
	// Connect to device
	conn, err := net.Dial("tcp", fmt.Sprintf("%s:%d", device.IPAddress, device.Port))
	if err != nil {
		return err
	}
	device.Connection = conn
	
	// Configure device for mining
	if err := h.configureDevice(device); err != nil {
		return err
	}
	
	// Read initial status
	if err := h.updateDeviceStatus(device); err != nil {
		h.logger.Warn("Failed to read device status",
			zap.Int("device_id", device.ID),
			zap.Error(err))
	}
	
	device.Status = ASICStatusOnline
	h.logger.Info("ASIC device initialized",
		zap.Int("device_id", device.ID),
		zap.String("name", device.Name))
	
	return nil
}

// configureDevice configures ASIC device for mining
func (h *ASICHardware) configureDevice(device *ASICDevice) error {
	switch device.Manufacturer {
	case ASICManufacturerBitmain:
		return h.configureBitmainDevice(device)
	case ASICManufacturerMicroBT:
		return h.configureMicroBTDevice(device)
	default:
		h.logger.Warn("Unsupported ASIC manufacturer for configuration",
			zap.String("manufacturer", h.manufacturerName(device.Manufacturer)))
		return nil
	}
}

// configureBitmainDevice configures Bitmain ASIC
func (h *ASICHardware) configureBitmainDevice(device *ASICDevice) error {
	// Set pool configuration
	cmd := fmt.Sprintf(`{"command":"addpool","parameter":"%s,%s,%s"}`,
		h.pools[0].URL, h.pools[0].User, h.pools[0].Password)
	
	return h.sendDeviceCommand(device, cmd)
}

// configureMicroBTDevice configures MicroBT ASIC
func (h *ASICHardware) configureMicroBTDevice(device *ASICDevice) error {
	// MicroBT uses HTTP API for configuration
	// Implementation would use HTTP requests
	return nil
}

// sendDeviceCommand sends command to ASIC device
func (h *ASICHardware) sendDeviceCommand(device *ASICDevice, command string) error {
	if device.Connection == nil {
		return errors.New("device not connected")
	}
	
	device.Connection.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := device.Connection.Write([]byte(command))
	if err != nil {
		return err
	}
	
	// Read response
	device.Connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	response := make([]byte, 2048)
	_, err = device.Connection.Read(response)
	if err != nil {
		return err
	}
	
	return nil
}

// runDeviceMining runs mining on a specific ASIC device
func (h *ASICHardware) runDeviceMining(ctx context.Context, device *ASICDevice) {
	h.logger.Debug("Starting mining on ASIC device",
		zap.Int("device_id", device.ID),
		zap.String("name", device.Name))

	ticker := time.NewTicker(30 * time.Second) // Update every 30 seconds
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case work := <-h.workChan:
			h.submitWorkToDevice(device, work)
		case <-ticker.C:
			// Update device status periodically
			if err := h.updateDeviceStatus(device); err != nil {
				h.logger.Error("Failed to update device status",
					zap.Int("device_id", device.ID),
					zap.Error(err))
				device.ErrorCount.Add(1)
			}
		}
	}
}

// submitWorkToDevice submits work to ASIC device
func (h *ASICHardware) submitWorkToDevice(device *ASICDevice, work *Work) {
	// Convert work to device-specific format and submit
	device.SubmittedWork.Add(1)
	
	// Simulate work submission based on manufacturer
	switch device.Manufacturer {
	case ASICManufacturerBitmain:
		h.submitBitmainWork(device, work)
	case ASICManufacturerMicroBT:
		h.submitMicroBTWork(device, work)
	default:
		h.logger.Warn("Unsupported manufacturer for work submission",
			zap.String("manufacturer", h.manufacturerName(device.Manufacturer)))
	}
}

// submitBitmainWork submits work to Bitmain ASIC
func (h *ASICHardware) submitBitmainWork(device *ASICDevice, work *Work) {
	// Format work for CGMiner API
	cmd := fmt.Sprintf(`{"command":"notify","parameter":"%s,%s,%d"}`,
		work.JobID, fmt.Sprintf("%x", work.BlockHeader), work.Target)
	
	if err := h.sendDeviceCommand(device, cmd); err != nil {
		h.logger.Error("Failed to submit work to Bitmain device",
			zap.Int("device_id", device.ID),
			zap.Error(err))
		device.ErrorCount.Add(1)
	}
}

// submitMicroBTWork submits work to MicroBT ASIC
func (h *ASICHardware) submitMicroBTWork(device *ASICDevice, work *Work) {
	// MicroBT work submission via HTTP API
	// Implementation would use HTTP POST
}

// updateDeviceStatus updates device status and metrics
func (h *ASICHardware) updateDeviceStatus(device *ASICDevice) error {
	switch device.Manufacturer {
	case ASICManufacturerBitmain:
		return h.updateBitmainStatus(device)
	case ASICManufacturerMicroBT:
		return h.updateMicroBTStatus(device)
	default:
		return nil
	}
}

// updateBitmainStatus updates Bitmain device status
func (h *ASICHardware) updateBitmainStatus(device *ASICDevice) error {
	// Get device stats
	cmd := `{"command":"stats"}`
	if err := h.sendDeviceCommand(device, cmd); err != nil {
		return err
	}
	
	// Parse response and update metrics
	// For simulation, set some values
	device.HashRate.Store(100000000000) // 100 TH/s
	device.Temperature.Store(7500)      // 75°C
	device.PowerUsage.Store(320000)     // 3200W
	device.FanSpeed.Store(3000)         // 3000 RPM
	device.LastSeen = time.Now()
	device.Status = ASICStatusMining
	
	return nil
}

// updateMicroBTStatus updates MicroBT device status
func (h *ASICHardware) updateMicroBTStatus(device *ASICDevice) error {
	// Get device stats via HTTP API
	// For simulation, set some values
	device.HashRate.Store(120000000000) // 120 TH/s
	device.Temperature.Store(7000)      // 70°C
	device.PowerUsage.Store(350000)     // 3500W
	device.FanSpeed.Store(3200)         // 3200 RPM
	device.LastSeen = time.Now()
	device.Status = ASICStatusMining
	
	return nil
}

// monitorDevices monitors ASIC device health
func (h *ASICHardware) monitorDevices(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.updateMetrics()
			h.checkDeviceHealth()
		}
	}
}

// updateMetrics updates overall ASIC metrics
func (h *ASICHardware) updateMetrics() {
	totalHashRate := uint64(0)
	totalTemp := uint64(0)
	totalPower := uint64(0)
	totalSubmitted := uint64(0)
	totalAccepted := uint64(0)
	totalRejected := uint64(0)
	deviceCount := 0

	for _, device := range h.devices {
		if device.Status == ASICStatusMining || device.Status == ASICStatusOnline {
			totalHashRate += device.HashRate.Load()
			totalTemp += device.Temperature.Load()
			totalPower += device.PowerUsage.Load()
			totalSubmitted += device.SubmittedWork.Load()
			totalAccepted += device.AcceptedWork.Load()
			totalRejected += device.RejectedWork.Load()
			deviceCount++
		}
	}

	h.metrics.TotalHashRate.Store(totalHashRate)
	h.metrics.TotalPowerUsage.Store(totalPower)
	h.metrics.TotalSubmittedWork.Store(totalSubmitted)
	h.metrics.TotalAcceptedWork.Store(totalAccepted)
	h.metrics.TotalRejectedWork.Store(totalRejected)

	if deviceCount > 0 {
		avgTemp := totalTemp / uint64(deviceCount)
		h.metrics.AverageTemp.Store(avgTemp)
	}
}

// checkDeviceHealth checks device health and handles issues
func (h *ASICHardware) checkDeviceHealth() {
	for _, device := range h.devices {
		// Check temperature
		temp := float64(device.Temperature.Load()) / 100.0
		if temp > 90.0 {
			device.Status = ASICStatusOverheated
			h.logger.Warn("ASIC device overheated",
				zap.Int("device_id", device.ID),
				zap.Float64("temperature", temp))
			
			// Try to reduce power or restart device
			h.handleOverheatedDevice(device)
		}
		
		// Check last seen time
		if time.Since(device.LastSeen) > 2*time.Minute {
			device.Status = ASICStatusOffline
			h.logger.Warn("ASIC device offline",
				zap.Int("device_id", device.ID),
				zap.String("last_seen", device.LastSeen.Format(time.RFC3339)))
			
			// Try to reconnect
			go h.reconnectDevice(device)
		}
		
		// Check hash rate
		expectedHashRate := h.getExpectedHashRate(device)
		actualHashRate := device.HashRate.Load()
		if actualHashRate < expectedHashRate/2 {
			device.Status = ASICStatusLowHashRate
			h.logger.Warn("ASIC device low hash rate",
				zap.Int("device_id", device.ID),
				zap.Uint64("actual", actualHashRate),
				zap.Uint64("expected", expectedHashRate))
		}
	}
}

// handleOverheatedDevice handles overheated ASIC device
func (h *ASICHardware) handleOverheatedDevice(device *ASICDevice) {
	// Try to reduce frequency or restart device
	h.logger.Info("Handling overheated device",
		zap.Int("device_id", device.ID))
	
	// Implementation would reduce power settings or restart device
}

// reconnectDevice attempts to reconnect to offline device
func (h *ASICHardware) reconnectDevice(device *ASICDevice) {
	h.logger.Info("Attempting to reconnect to device",
		zap.Int("device_id", device.ID))
	
	// Close existing connection
	if device.Connection != nil {
		device.Connection.Close()
		device.Connection = nil
	}
	
	// Try to reconnect
	conn, err := net.DialTimeout("tcp", 
		fmt.Sprintf("%s:%d", device.IPAddress, device.Port), 
		10*time.Second)
	if err != nil {
		h.logger.Error("Failed to reconnect to device",
			zap.Int("device_id", device.ID),
			zap.Error(err))
		return
	}
	
	device.Connection = conn
	device.Status = ASICStatusOnline
	device.LastSeen = time.Now()
	
	h.logger.Info("Successfully reconnected to device",
		zap.Int("device_id", device.ID))
}

// getExpectedHashRate returns expected hash rate for device
func (h *ASICHardware) getExpectedHashRate(device *ASICDevice) uint64 {
	// Return expected hash rate based on model
	switch device.Model {
	case "Antminer S21":
		return 200000000000 // 200 TH/s
	case "Antminer S19 Pro":
		return 110000000000 // 110 TH/s
	case "WhatsMiner M63S":
		return 390000000000 // 390 TH/s
	case "WhatsMiner M60":
		return 172000000000 // 172 TH/s
	default:
		return 100000000000 // 100 TH/s default
	}
}

// managePoolConnections manages pool connections and failover
func (h *ASICHardware) managePoolConnections(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.checkPoolConnections()
		}
	}
}

// checkPoolConnections checks pool connection health
func (h *ASICHardware) checkPoolConnections() {
	for _, pool := range h.pools {
		if pool.Active && pool.Conn != nil {
			// Test connection by sending ping
			pool.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_, err := pool.Conn.Write([]byte("ping\n"))
			if err != nil {
				h.logger.Warn("Pool connection failed",
					zap.String("url", pool.URL),
					zap.Error(err))
				
				pool.Active = false
				pool.Conn.Close()
				pool.Conn = nil
				
				// Try to connect to backup pool
				h.switchToBackupPool()
			}
		}
	}
}

// switchToBackupPool switches to backup pool
func (h *ASICHardware) switchToBackupPool() {
	for _, pool := range h.pools {
		if !pool.Active {
			if err := h.connectToPool(pool); err == nil {
				h.logger.Info("Switched to backup pool",
					zap.String("url", pool.URL))
				h.metrics.PoolSwitchCount.Add(1)
				return
			}
		}
	}
	
	h.logger.Error("No backup pools available")
}

// processShares processes mining shares from ASICs
func (h *ASICHardware) processShares(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case share := <-h.shareChan:
			if h.validateASICShare(share) {
				h.logger.Debug("ASIC share found",
					zap.String("job_id", share.JobID),
					zap.Uint64("nonce", share.Nonce))
				// Submit to pool
				h.submitShareToPool(share)
			}
		}
	}
}

// validateASICShare validates mining share from ASIC
func (h *ASICHardware) validateASICShare(share *Share) bool {
	if share == nil || len(share.Hash) != 32 {
		return false
	}

	difficulty := calculateDifficulty(share.Hash)
	return difficulty >= share.Difficulty
}

// submitShareToPool submits share to mining pool
func (h *ASICHardware) submitShareToPool(share *Share) {
	// Find active pool connection
	for _, pool := range h.pools {
		if pool.Active && pool.Conn != nil {
			// Submit share in appropriate format
			shareData := fmt.Sprintf(`{"method":"mining.submit","params":["%s","%s","%016x","%016x","%x"],"id":1}`,
				pool.User, share.JobID, share.Nonce, uint64(time.Now().Unix()), share.Hash)
			
			pool.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_, err := pool.Conn.Write([]byte(shareData + "\n"))
			if err != nil {
				h.logger.Error("Failed to submit share to pool",
					zap.String("pool", pool.URL),
					zap.Error(err))
			}
			break
		}
	}
}

// healthCheck performs periodic health checks
func (h *ASICHardware) healthCheck(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.performHealthCheck()
		}
	}
}

// performHealthCheck performs comprehensive health check
func (h *ASICHardware) performHealthCheck() {
	offlineDevices := 0
	overheatedDevices := 0
	lowHashRateDevices := 0
	
	for _, device := range h.devices {
		switch device.Status {
		case ASICStatusOffline:
			offlineDevices++
		case ASICStatusOverheated:
			overheatedDevices++
		case ASICStatusLowHashRate:
			lowHashRateDevices++
		}
	}
	
	h.logger.Info("ASIC health check completed",
		zap.Int("total_devices", len(h.devices)),
		zap.Int("offline", offlineDevices),
		zap.Int("overheated", overheatedDevices),
		zap.Int("low_hashrate", lowHashRateDevices))
	
	// Take corrective actions if needed
	if offlineDevices > len(h.devices)/2 {
		h.logger.Error("More than 50% of devices offline")
		// Could trigger alerts or automatic recovery
	}
}

// stopDevice stops mining on a specific device
func (h *ASICHardware) stopDevice(device *ASICDevice) {
	if device.Connection != nil {
		// Send stop command based on manufacturer
		switch device.Manufacturer {
		case ASICManufacturerBitmain:
			h.sendDeviceCommand(device, `{"command":"quit"}`)
		case ASICManufacturerMicroBT:
			// MicroBT stop command
		}
		
		device.Connection.Close()
		device.Connection = nil
	}
	
	device.Status = ASICStatusOffline
}

// GetDetailedStats returns detailed ASIC statistics
func (h *ASICHardware) GetDetailedStats() map[string]interface{} {
	stats := make(map[string]interface{})
	
	stats["total_hashrate"] = h.metrics.TotalHashRate.Load()
	stats["average_temperature"] = float64(h.metrics.AverageTemp.Load()) / 100.0
	stats["total_power_usage"] = float64(h.metrics.TotalPowerUsage.Load()) / 100.0
	stats["total_submitted_work"] = h.metrics.TotalSubmittedWork.Load()
	stats["total_accepted_work"] = h.metrics.TotalAcceptedWork.Load()
	stats["total_rejected_work"] = h.metrics.TotalRejectedWork.Load()
	stats["pool_switch_count"] = h.metrics.PoolSwitchCount.Load()
	stats["restart_count"] = h.metrics.RestartCount.Load()
	
	// Calculate acceptance rate
	submitted := h.metrics.TotalSubmittedWork.Load()
	accepted := h.metrics.TotalAcceptedWork.Load()
	if submitted > 0 {
		stats["acceptance_rate"] = float64(accepted) / float64(submitted) * 100.0
	}
	
	// Per-device stats
	devices := make([]map[string]interface{}, len(h.devices))
	for i, device := range h.devices {
		devices[i] = map[string]interface{}{
			"id":              device.ID,
			"name":            device.Name,
			"manufacturer":    h.manufacturerName(device.Manufacturer),
			"model":           device.Model,
			"ip_address":      device.IPAddress,
			"status":          device.Status,
			"hashrate":        device.HashRate.Load(),
			"temperature":     float64(device.Temperature.Load()) / 100.0,
			"power_usage":     float64(device.PowerUsage.Load()) / 100.0,
			"fan_speed":       device.FanSpeed.Load(),
			"submitted_work":  device.SubmittedWork.Load(),
			"accepted_work":   device.AcceptedWork.Load(),
			"rejected_work":   device.RejectedWork.Load(),
			"error_count":     device.ErrorCount.Load(),
			"last_seen":       device.LastSeen.Format(time.RFC3339),
		}
	}
	stats["devices"] = devices
	
	// Pool stats
	pools := make([]map[string]interface{}, len(h.pools))
	for i, pool := range h.pools {
		pools[i] = map[string]interface{}{
			"url":      pool.URL,
			"active":   pool.Active,
			"priority": pool.Priority,
		}
	}
	stats["pools"] = pools
	
	return stats
}

// RestartDevice restarts a specific ASIC device
func (h *ASICHardware) RestartDevice(deviceID int) error {
	if deviceID >= len(h.devices) {
		return errors.New("device not found")
	}
	
	device := h.devices[deviceID]
	h.logger.Info("Restarting ASIC device",
		zap.Int("device_id", deviceID),
		zap.String("name", device.Name))
	
	// Stop device
	h.stopDevice(device)
	
	// Wait for device to restart
	time.Sleep(30 * time.Second)
	
	// Reinitialize device
	if err := h.initializeDevice(device); err != nil {
		return fmt.Errorf("failed to reinitialize device: %w", err)
	}
	
	h.metrics.RestartCount.Add(1)
	return nil
}

// SetDeviceFrequency sets mining frequency for device
func (h *ASICHardware) SetDeviceFrequency(deviceID int, frequency uint64) error {
	if deviceID >= len(h.devices) {
		return errors.New("device not found")
	}
	
	device := h.devices[deviceID]
	device.Frequency.Store(frequency)
	
	// Send frequency command to device
	cmd := fmt.Sprintf(`{"command":"ascset","parameter":"%d,freq,%d"}`, deviceID, frequency)
	return h.sendDeviceCommand(device, cmd)
}

// SetDeviceVoltage sets mining voltage for device
func (h *ASICHardware) SetDeviceVoltage(deviceID int, voltage uint64) error {
	if deviceID >= len(h.devices) {
		return errors.New("device not found")
	}
	
	device := h.devices[deviceID]
	device.Voltage.Store(voltage)
	
	// Send voltage command to device
	cmd := fmt.Sprintf(`{"command":"ascset","parameter":"%d,volt,%d"}`, deviceID, voltage)
	return h.sendDeviceCommand(device, cmd)
}
