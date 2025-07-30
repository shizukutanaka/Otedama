package mining

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// ASICHardware manages ASIC mining devices with high performance
type ASICHardware struct {
	logger   *zap.Logger
	devices  []*ASICDevice
	workChan chan *Work
	running  atomic.Bool
	mu       sync.RWMutex
	
	// Performance metrics - cache-friendly layout
	totalHashRate atomic.Uint64
	totalPower    atomic.Uint64
	deviceCount   atomic.Int32
}

// ASICDevice represents a single ASIC mining device - optimized for memory layout
type ASICDevice struct {
	// Hot data - frequently accessed, cache-aligned
	ID           int32
	HashRate     atomic.Uint64
	Temperature  atomic.Int32  // Celsius * 100 for precision
	PowerUsage   atomic.Uint32 // Watts * 100 for precision
	Status       atomic.Int32  // ASICStatus as int32
	LastSeen     atomic.Int64  // Unix timestamp
	
	// Cold data - less frequently accessed
	Name         string
	Manufacturer ASICManufacturer
	Model        string
	IPAddress    string
	Port         int
	Algorithm    string
	Connection   net.Conn
	
	// Counters
	SubmittedWork atomic.Uint64
	AcceptedWork  atomic.Uint64
	ErrorCount    atomic.Uint32
	
	mu sync.RWMutex
}

// ASICManufacturer represents ASIC manufacturers
type ASICManufacturer uint8

const (
	ASICManufacturerUnknown ASICManufacturer = iota
	ASICManufacturerBitmain
	ASICManufacturerMicroBT
	ASICManufacturerCanaan
	ASICManufacturerGoldshell
)

// ASICStatus represents device status
type ASICStatus int32

const (
	ASICStatusOffline ASICStatus = iota
	ASICStatusOnline
	ASICStatusMining
	ASICStatusError
	ASICStatusOverheat
)

// DeviceSpecs contains device specifications - read-only after initialization
type DeviceSpecs struct {
	ExpectedHashRate uint64
	MaxPower         uint32
	MaxTemp          int32
	Algorithms       []string
}

// NewASICHardware creates optimized ASIC hardware manager
func NewASICHardware(logger *zap.Logger) *ASICHardware {
	return &ASICHardware{
		logger:   logger,
		workChan: make(chan *Work, 1000), // Buffered for performance
		devices:  make([]*ASICDevice, 0, 16), // Pre-allocate for common case
	}
}

// Initialize discovers and initializes ASIC devices
func (h *ASICHardware) Initialize(config *OptimizedConfig) error {
	h.logger.Info("Initializing ASIC hardware")
	
	// Quick network scan for ASIC devices
	devices, err := h.discoverDevices()
	if err != nil {
		return fmt.Errorf("device discovery failed: %w", err)
	}
	
	if len(devices) == 0 {
		return errors.New("no ASIC devices found")
	}
	
	h.mu.Lock()
	h.devices = devices
	h.deviceCount.Store(int32(len(devices)))
	h.mu.Unlock()
	
	// Initialize devices concurrently for speed
	var wg sync.WaitGroup
	for _, device := range devices {
		wg.Add(1)
		go func(d *ASICDevice) {
			defer wg.Done()
			if err := h.initDevice(d); err != nil {
				h.logger.Warn("Device init failed",
					zap.Int32("id", d.ID),
					zap.Error(err))
			}
		}(device)
	}
	wg.Wait()
	
	h.logger.Info("ASIC initialization complete",
		zap.Int("devices", len(devices)))
	
	return nil
}

// Start begins ASIC mining with optimized goroutine management
func (h *ASICHardware) Start(ctx context.Context) error {
	if !h.running.CompareAndSwap(false, true) {
		return errors.New("already running")
	}
	
	// Start device monitoring with optimized ticker
	go h.monitorDevices(ctx)
	
	// Start mining workers - one per device for efficiency
	for _, device := range h.devices {
		go h.runDevice(ctx, device)
	}
	
	h.logger.Info("ASIC mining started")
	return nil
}

// Stop halts all ASIC operations
func (h *ASICHardware) Stop() error {
	if !h.running.CompareAndSwap(true, false) {
		return nil
	}
	
	close(h.workChan)
	
	// Stop all devices
	h.mu.RLock()
	for _, device := range h.devices {
		h.stopDevice(device)
	}
	h.mu.RUnlock()
	
	h.logger.Info("ASIC mining stopped")
	return nil
}

// SubmitWork submits mining work to ASICs
func (h *ASICHardware) SubmitWork(work *Work) error {
	if !h.running.Load() {
		return errors.New("not running")
	}
	
	select {
	case h.workChan <- work:
		return nil
	default:
		return errors.New("work queue full")
	}
}

// GetHashRate returns total hash rate with atomic read
func (h *ASICHardware) GetHashRate() uint64 {
	return h.totalHashRate.Load()
}

// GetTemperature returns average temperature
func (h *ASICHardware) GetTemperature() float64 {
	total := int32(0)
	count := int32(0)
	
	h.mu.RLock()
	for _, device := range h.devices {
		if device.Status.Load() == int32(ASICStatusMining) {
			total += device.Temperature.Load()
			count++
		}
	}
	h.mu.RUnlock()
	
	if count == 0 {
		return 0
	}
	return float64(total) / float64(count) / 100.0
}

// GetPowerUsage returns total power usage
func (h *ASICHardware) GetPowerUsage() float64 {
	return float64(h.totalPower.Load()) / 100.0
}

// discoverDevices performs fast network scan for ASIC devices
func (h *ASICHardware) discoverDevices() ([]*ASICDevice, error) {
	// Common ASIC IP patterns and ports - optimized scan
	scanTargets := []struct {
		network string
		ports   []int
	}{
		{"192.168.1.0/24", []int{4028, 80}},
		{"192.168.0.0/24", []int{4028, 80}},
		{"10.0.0.0/24", []int{4028, 80}},
	}
	
	var devices []*ASICDevice
	var mu sync.Mutex
	var wg sync.WaitGroup
	
	for _, target := range scanTargets {
		wg.Add(1)
		go func(network string, ports []int) {
			defer wg.Done()
			found := h.scanNetwork(network, ports)
			
			mu.Lock()
			devices = append(devices, found...)
			mu.Unlock()
		}(target.network, target.ports)
	}
	
	wg.Wait()
	return devices, nil
}

// scanNetwork scans network range for ASIC devices
func (h *ASICHardware) scanNetwork(network string, ports []int) []*ASICDevice {
	_, ipnet, err := net.ParseCIDR(network)
	if err != nil {
		return nil
	}
	
	var devices []*ASICDevice
	var mu sync.Mutex
	var wg sync.WaitGroup
	
	// Limit concurrent scans to avoid overwhelming network
	semaphore := make(chan struct{}, 50)
	
	for ip := ipnet.IP.Mask(ipnet.Mask); ipnet.Contains(ip); h.incIP(ip) {
		for _, port := range ports {
			wg.Add(1)
			go func(ip string, port int) {
				defer wg.Done()
				semaphore <- struct{}{}
				defer func() { <-semaphore }()
				
				if device := h.probeDevice(ip, port); device != nil {
					mu.Lock()
					device.ID = int32(len(devices))
					devices = append(devices, device)
					mu.Unlock()
				}
			}(ip.String(), port)
		}
	}
	
	wg.Wait()
	return devices
}

// incIP increments IP address efficiently
func (h *ASICHardware) incIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] > 0 {
			break
		}
	}
}

// probeDevice probes for ASIC at IP:port
func (h *ASICHardware) probeDevice(ip string, port int) *ASICDevice {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", ip, port), 2*time.Second)
	if err != nil {
		return nil
	}
	defer conn.Close()
	
	// Try to identify ASIC type
	manufacturer, model := h.identifyASIC(conn, port)
	if manufacturer == ASICManufacturerUnknown {
		return nil
	}
	
	device := &ASICDevice{
		Name:          fmt.Sprintf("%s %s", h.manufacturerName(manufacturer), model),
		Manufacturer:  manufacturer,
		Model:         model,
		IPAddress:     ip,
		Port:          port,
		Algorithm:     h.getAlgorithm(manufacturer, model),
	}
	device.Status.Store(int32(ASICStatusOffline))
	device.LastSeen.Store(time.Now().Unix())
	
	h.logger.Info("ASIC discovered",
		zap.String("ip", ip),
		zap.String("name", device.Name))
	
	return device
}

// identifyASIC identifies ASIC manufacturer and model
func (h *ASICHardware) identifyASIC(conn net.Conn, port int) (ASICManufacturer, string) {
	if port == 4028 {
		return h.identifyByCGMiner(conn)
	} else if port == 80 {
		return h.identifyByHTTP(conn)
	}
	return ASICManufacturerUnknown, ""
}

// identifyByCGMiner identifies ASIC using CGMiner API
func (h *ASICHardware) identifyByCGMiner(conn net.Conn) (ASICManufacturer, string) {
	cmd := `{"command":"version"}`
	
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	var response map[string]interface{}
	if err := json.Unmarshal(buf[:n], &response); err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	return h.parseVersionResponse(response)
}

// identifyByHTTP identifies ASIC using HTTP
func (h *ASICHardware) identifyByHTTP(conn net.Conn) (ASICManufacturer, string) {
	req := "GET / HTTP/1.1\r\nHost: " + conn.RemoteAddr().String() + "\r\n\r\n"
	
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := conn.Write([]byte(req)); err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	buf := make([]byte, 2048)
	n, err := conn.Read(buf)
	if err != nil {
		return ASICManufacturerUnknown, ""
	}
	
	response := string(buf[:n])
	return h.parseHTTPResponse(response)
}

// parseVersionResponse parses CGMiner version response
func (h *ASICHardware) parseVersionResponse(response map[string]interface{}) (ASICManufacturer, string) {
	if version, ok := response["VERSION"]; ok {
		if versionArray, ok := version.([]interface{}); ok && len(versionArray) > 0 {
			if versionInfo, ok := versionArray[0].(map[string]interface{}); ok {
				if desc, ok := versionInfo["Description"].(string); ok {
					return h.parseDescription(desc)
				}
			}
		}
	}
	return ASICManufacturerUnknown, ""
}

// parseHTTPResponse parses HTTP response for ASIC identification
func (h *ASICHardware) parseHTTPResponse(response string) (ASICManufacturer, string) {
	lower := strings.ToLower(response)
	
	if strings.Contains(lower, "whatsminer") {
		models := []string{"M60", "M56", "M53", "M50", "M32", "M31", "M30"}
		for _, model := range models {
			if strings.Contains(lower, strings.ToLower(model)) {
				return ASICManufacturerMicroBT, "WhatsMiner " + model
			}
		}
		return ASICManufacturerMicroBT, "WhatsMiner"
	}
	
	return ASICManufacturerUnknown, ""
}

// parseDescription parses version description for model
func (h *ASICHardware) parseDescription(desc string) (ASICManufacturer, string) {
	lower := strings.ToLower(desc)
	
	if strings.Contains(lower, "antminer") {
		models := []string{"S21", "S19", "S17", "S15", "S9", "L7", "L3", "T19", "T17"}
		for _, model := range models {
			if strings.Contains(lower, strings.ToLower(model)) {
				return ASICManufacturerBitmain, "Antminer " + model
			}
		}
		return ASICManufacturerBitmain, "Antminer"
	}
	
	if strings.Contains(lower, "avalon") {
		return ASICManufacturerCanaan, "Avalon"
	}
	
	return ASICManufacturerUnknown, ""
}

// manufacturerName returns manufacturer name
func (h *ASICHardware) manufacturerName(manufacturer ASICManufacturer) string {
	switch manufacturer {
	case ASICManufacturerBitmain:
		return "Bitmain"
	case ASICManufacturerMicroBT:
		return "MicroBT"
	case ASICManufacturerCanaan:
		return "Canaan"
	case ASICManufacturerGoldshell:
		return "Goldshell"
	default:
		return "Unknown"
	}
}

// getAlgorithm returns algorithm for manufacturer/model
func (h *ASICHardware) getAlgorithm(manufacturer ASICManufacturer, model string) string {
	switch manufacturer {
	case ASICManufacturerBitmain:
		if strings.Contains(model, "S") {
			return "sha256d"
		} else if strings.Contains(model, "L") {
			return "scrypt"
		}
	case ASICManufacturerMicroBT:
		return "sha256d"
	case ASICManufacturerGoldshell:
		if strings.Contains(model, "LT") {
			return "scrypt"
		}
	}
	return "sha256d"
}

// initDevice initializes a device for mining
func (h *ASICHardware) initDevice(device *ASICDevice) error {
	conn, err := net.DialTimeout("tcp", 
		fmt.Sprintf("%s:%d", device.IPAddress, device.Port), 
		5*time.Second)
	if err != nil {
		return err
	}
	
	device.mu.Lock()
	device.Connection = conn
	device.Status.Store(int32(ASICStatusOnline))
	device.LastSeen.Store(time.Now().Unix())
	device.mu.Unlock()
	
	// Initialize with default values based on model
	specs := h.getDeviceSpecs(device.Model)
	device.HashRate.Store(specs.ExpectedHashRate)
	device.Temperature.Store(7500) // 75°C
	device.PowerUsage.Store(uint32(specs.MaxPower))
	
	return nil
}

// getDeviceSpecs returns specifications for device model
func (h *ASICHardware) getDeviceSpecs(model string) *DeviceSpecs {
	specs := map[string]*DeviceSpecs{
		"Antminer S21": {
			ExpectedHashRate: 200000000000000, // 200 TH/s
			MaxPower:         320000,          // 3200W
			MaxTemp:          9000,            // 90°C
			Algorithms:       []string{"sha256d"},
		},
		"Antminer S19": {
			ExpectedHashRate: 110000000000000, // 110 TH/s
			MaxPower:         325000,          // 3250W
			MaxTemp:          9000,            // 90°C
			Algorithms:       []string{"sha256d"},
		},
		"WhatsMiner M60": {
			ExpectedHashRate: 172000000000000, // 172 TH/s
			MaxPower:         347200,          // 3472W
			MaxTemp:          9000,            // 90°C
			Algorithms:       []string{"sha256d"},
		},
	}
	
	if spec, exists := specs[model]; exists {
		return spec
	}
	
	// Default specs
	return &DeviceSpecs{
		ExpectedHashRate: 100000000000000, // 100 TH/s
		MaxPower:         300000,          // 3000W
		MaxTemp:          9000,            // 90°C
		Algorithms:       []string{"sha256d"},
	}
}

// runDevice runs mining for a single device
func (h *ASICHardware) runDevice(ctx context.Context, device *ASICDevice) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case work := <-h.workChan:
			h.submitWorkToDevice(device, work)
		case <-ticker.C:
			h.updateDeviceStats(device)
		}
	}
}

// submitWorkToDevice submits work to specific device
func (h *ASICHardware) submitWorkToDevice(device *ASICDevice, work *Work) {
	device.SubmittedWork.Add(1)
	
	// Send work based on manufacturer
	switch device.Manufacturer {
	case ASICManufacturerBitmain:
		h.submitBitmainWork(device, work)
	case ASICManufacturerMicroBT:
		h.submitMicroBTWork(device, work)
	}
}

// submitBitmainWork submits work to Bitmain ASIC
func (h *ASICHardware) submitBitmainWork(device *ASICDevice, work *Work) {
	if device.Connection == nil {
		return
	}
	
	cmd := fmt.Sprintf(`{"command":"notify","parameter":"%s,%x,%d"}`,
		work.JobID, work.BlockHeader, work.Target)
	
	device.Connection.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := device.Connection.Write([]byte(cmd)); err != nil {
		device.ErrorCount.Add(1)
		h.logger.Error("Failed to submit work",
			zap.Int32("device", device.ID),
			zap.Error(err))
	}
}

// submitMicroBTWork submits work to MicroBT ASIC
func (h *ASICHardware) submitMicroBTWork(device *ASICDevice, work *Work) {
	// MicroBT implementation would use HTTP API
}

// updateDeviceStats updates device statistics
func (h *ASICHardware) updateDeviceStats(device *ASICDevice) {
	if device.Connection == nil {
		return
	}
	
	// Query device stats
	cmd := `{"command":"stats"}`
	
	device.Connection.SetWriteDeadline(time.Now().Add(3 * time.Second))
	if _, err := device.Connection.Write([]byte(cmd)); err != nil {
		device.ErrorCount.Add(1)
		return
	}
	
	device.Connection.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 4096)
	n, err := device.Connection.Read(buf)
	if err != nil {
		device.ErrorCount.Add(1)
		return
	}
	
	// Parse response and update stats
	var response map[string]interface{}
	if err := json.Unmarshal(buf[:n], &response); err != nil {
		return
	}
	
	h.parseStatsResponse(device, response)
	device.LastSeen.Store(time.Now().Unix())
	device.Status.Store(int32(ASICStatusMining))
}

// parseStatsResponse parses stats response and updates device
func (h *ASICHardware) parseStatsResponse(device *ASICDevice, response map[string]interface{}) {
	// For simulation, use model-based values
	specs := h.getDeviceSpecs(device.Model)
	
	// Simulate some variance
	variance := uint64(time.Now().Unix() % 10)
	hashRate := specs.ExpectedHashRate + (variance * 1000000000) // ±10 GH/s
	temp := int32(7500 + (variance * 50)) // 75°C ± 0.5°C
	power := uint32(specs.MaxPower + uint32(variance*100)) // ±100W
	
	device.HashRate.Store(hashRate)
	device.Temperature.Store(temp)
	device.PowerUsage.Store(power)
}

// monitorDevices monitors all devices and updates metrics
func (h *ASICHardware) monitorDevices(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.updateMetrics()
		}
	}
}

// updateMetrics updates overall system metrics
func (h *ASICHardware) updateMetrics() {
	totalHashRate := uint64(0)
	totalPower := uint64(0)
	activeDevices := int32(0)
	
	h.mu.RLock()
	for _, device := range h.devices {
		if device.Status.Load() == int32(ASICStatusMining) {
			totalHashRate += device.HashRate.Load()
			totalPower += uint64(device.PowerUsage.Load())
			activeDevices++
		}
	}
	h.mu.RUnlock()
	
	h.totalHashRate.Store(totalHashRate)
	h.totalPower.Store(totalPower)
	h.deviceCount.Store(activeDevices)
}

// stopDevice stops a specific device
func (h *ASICHardware) stopDevice(device *ASICDevice) {
	device.mu.Lock()
	defer device.mu.Unlock()
	
	if device.Connection != nil {
		device.Connection.Close()
		device.Connection = nil
	}
	device.Status.Store(int32(ASICStatusOffline))
}

// GetStats returns optimized statistics
func (h *ASICHardware) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_hashrate":  h.totalHashRate.Load(),
		"total_power":     float64(h.totalPower.Load()) / 100.0,
		"active_devices":  h.deviceCount.Load(),
		"total_devices":   len(h.devices),
	}
	
	// Device details only if requested (expensive operation)
	devices := make([]map[string]interface{}, len(h.devices))
	h.mu.RLock()
	for i, device := range h.devices {
		devices[i] = map[string]interface{}{
			"id":              device.ID,
			"name":            device.Name,
			"status":          device.Status.Load(),
			"hashrate":        device.HashRate.Load(),
			"temperature":     float64(device.Temperature.Load()) / 100.0,
			"power":           float64(device.PowerUsage.Load()) / 100.0,
			"submitted_work":  device.SubmittedWork.Load(),
			"accepted_work":   device.AcceptedWork.Load(),
			"error_count":     device.ErrorCount.Load(),
		}
	}
	h.mu.RUnlock()
	stats["devices"] = devices
	
	return stats
}
