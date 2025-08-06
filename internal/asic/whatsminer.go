package asic

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"sync"
	"time"

	"go.uber.org/zap"
)

// WhatsMinerCommunicator implements communication with WhatsMiner ASICs
type WhatsMinerCommunicator struct {
	logger   *zap.Logger
	conn     net.Conn
	address  string
	port     int
	mu       sync.Mutex
	
	// Connection state
	connected bool
	
	// Authentication
	token     string
	tokenTime time.Time
}

// WhatsMinerCommand represents a command to send to the ASIC
type WhatsMinerCommand struct {
	Cmd   string `json:"cmd"`
	Token string `json:"token,omitempty"`
}

// WhatsMinerResponse is the base response structure
type WhatsMinerResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
}

// WhatsMinerSummaryResponse represents the summary response
type WhatsMinerSummaryResponse struct {
	WhatsMinerResponse
	Summary struct {
		Elapsed            int64   `json:"elapsed"`
		MHS5s              float64 `json:"mhs_5s"`
		MHSAv              float64 `json:"mhs_av"`
		MHS30m             float64 `json:"mhs_30m"`
		FoundBlocks        int     `json:"found_blocks"`
		Accepted           uint64  `json:"accepted"`
		Rejected           uint64  `json:"rejected"`
		HardwareErrors     uint64  `json:"hw_errors"`
		Utility            float64 `json:"utility"`
		Stale              uint64  `json:"stale"`
		TotalAccepted      uint64  `json:"total_accepted"`
		TotalRejected      uint64  `json:"total_rejected"`
		TotalStale         uint64  `json:"total_stale"`
		BestShare          uint64  `json:"best_share"`
		Temperature        float32 `json:"temperature"`
		Freq               int     `json:"freq"`
		FanSpeedIn         int     `json:"fan_speed_in"`
		FanSpeedOut        int     `json:"fan_speed_out"`
		PowerConsumption   float32 `json:"power_consumption"`
		PowerEfficiency    float32 `json:"power_efficiency"`
		PowerType          string  `json:"power_type"`
		UptimeStr          string  `json:"uptime"`
		Version            string  `json:"version"`
		MAC                string  `json:"mac"`
		Hostname           string  `json:"hostname"`
	} `json:"summary"`
}

// WhatsMinerDevDetailResponse represents detailed device information
type WhatsMinerDevDetailResponse struct {
	WhatsMinerResponse
	DevDetail []struct {
		ID            int     `json:"id"`
		HashBoard     int     `json:"hashboard"`
		Temperature   float32 `json:"temperature"`
		TempChip      float32 `json:"temp_chip"`
		TempPCB       float32 `json:"temp_pcb"`
		MHS5s         float64 `json:"mhs_5s"`
		MHSAv         float64 `json:"mhs_av"`
		HardwareError int     `json:"hw"`
		ChipNum       int     `json:"chip_num"`
		Frequency     int     `json:"freq"`
		Voltage       float32 `json:"voltage"`
	} `json:"devdetail"`
}

// WhatsMinerPowerResponse represents power information
type WhatsMinerPowerResponse struct {
	WhatsMinerResponse
	Power struct {
		InputVoltage    float32 `json:"input_voltage"`
		InputCurrent    float32 `json:"input_current"`
		InputPower      float32 `json:"input_power"`
		OutputVoltage   float32 `json:"output_voltage"`
		OutputCurrent   float32 `json:"output_current"`
		OutputPower     float32 `json:"output_power"`
		Efficiency      float32 `json:"efficiency"`
		PowerLimit      int     `json:"power_limit"`
		PowerLimitRatio float32 `json:"power_limit_ratio"`
		PSUType         string  `json:"psu_type"`
		PSUSerial       string  `json:"psu_serial"`
	} `json:"power"`
}

// NewWhatsMinerCommunicator creates a new WhatsMiner ASIC communicator
func NewWhatsMinerCommunicator(logger *zap.Logger) *WhatsMinerCommunicator {
	return &WhatsMinerCommunicator{
		logger: logger,
	}
}

// Connect establishes connection to the ASIC
func (w *WhatsMinerCommunicator) Connect(address string, port int) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	if w.connected {
		return errors.New("already connected")
	}
	
	// Default WhatsMiner API port
	if port == 0 {
		port = 4028
	}
	
	// Connect with timeout
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", address, port), 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	w.conn = conn
	w.address = address
	w.port = port
	w.connected = true
	
	// Get authentication token
	if err := w.authenticate(); err != nil {
		w.conn.Close()
		w.connected = false
		return fmt.Errorf("failed to authenticate: %w", err)
	}
	
	w.logger.Debug("Connected to WhatsMiner ASIC",
		zap.String("address", address),
		zap.Int("port", port),
	)
	
	return nil
}

// Disconnect closes the connection to the ASIC
func (w *WhatsMinerCommunicator) Disconnect() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	if !w.connected {
		return nil
	}
	
	if w.conn != nil {
		w.conn.Close()
	}
	
	w.connected = false
	w.token = ""
	return nil
}

// IsConnected returns connection status
func (w *WhatsMinerCommunicator) IsConnected() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.connected
}

// GetStatus retrieves device status
func (w *WhatsMinerCommunicator) GetStatus() (*DeviceStatus, error) {
	// Get summary information
	summary, err := w.sendCommand("summary", true)
	if err != nil {
		return nil, err
	}
	
	var summaryResp WhatsMinerSummaryResponse
	if err := json.Unmarshal(summary, &summaryResp); err != nil {
		return nil, fmt.Errorf("failed to parse summary response: %w", err)
	}
	
	if summaryResp.Code != 0 {
		return nil, fmt.Errorf("API error: %s", summaryResp.Msg)
	}
	
	// Get detailed device information
	devDetail, err := w.sendCommand("devdetail", true)
	if err != nil {
		return nil, err
	}
	
	var devResp WhatsMinerDevDetailResponse
	if err := json.Unmarshal(devDetail, &devResp); err != nil {
		return nil, fmt.Errorf("failed to parse devdetail response: %w", err)
	}
	
	status := &DeviceStatus{
		Uptime:         time.Duration(summaryResp.Summary.Elapsed) * time.Second,
		MHSAvg:         summaryResp.Summary.MHSAv,
		MHS5s:          summaryResp.Summary.MHS5s,
		Accepted:       summaryResp.Summary.Accepted,
		Rejected:       summaryResp.Summary.Rejected,
		HardwareErrors: summaryResp.Summary.HardwareErrors,
		Utility:        summaryResp.Summary.Utility,
		Frequency:      summaryResp.Summary.Freq,
		FanSpeeds:      []int{summaryResp.Summary.FanSpeedIn, summaryResp.Summary.FanSpeedOut},
	}
	
	// Process temperatures from hash boards
	status.Temperatures = make(map[string]float32)
	status.Temperatures["avg"] = summaryResp.Summary.Temperature
	
	for i, board := range devResp.DevDetail {
		status.Temperatures[fmt.Sprintf("board_%d", i)] = board.Temperature
		status.Temperatures[fmt.Sprintf("chip_%d", i)] = board.TempChip
		status.Temperatures[fmt.Sprintf("pcb_%d", i)] = board.TempPCB
	}
	
	return status, nil
}

// GetHashRate retrieves current hash rate
func (w *WhatsMinerCommunicator) GetHashRate() (uint64, error) {
	status, err := w.GetStatus()
	if err != nil {
		return 0, err
	}
	
	// Convert MH/s to H/s
	return uint64(status.MHS5s * 1e6), nil
}

// GetTemperature retrieves temperature readings
func (w *WhatsMinerCommunicator) GetTemperature() (map[string]float32, error) {
	status, err := w.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.Temperatures, nil
}

// GetFanSpeed retrieves fan speeds
func (w *WhatsMinerCommunicator) GetFanSpeed() ([]int, error) {
	status, err := w.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.FanSpeeds, nil
}

// GetPowerStats retrieves power consumption statistics
func (w *WhatsMinerCommunicator) GetPowerStats() (*PowerStats, error) {
	// Get power information
	power, err := w.sendCommand("power_summary", true)
	if err != nil {
		return nil, err
	}
	
	var powerResp WhatsMinerPowerResponse
	if err := json.Unmarshal(power, &powerResp); err != nil {
		return nil, fmt.Errorf("failed to parse power response: %w", err)
	}
	
	if powerResp.Code != 0 {
		return nil, fmt.Errorf("API error: %s", powerResp.Msg)
	}
	
	return &PowerStats{
		InputVoltage:  powerResp.Power.InputVoltage,
		InputCurrent:  powerResp.Power.InputCurrent,
		InputPower:    powerResp.Power.InputPower,
		OutputVoltage: powerResp.Power.OutputVoltage,
		OutputCurrent: powerResp.Power.OutputCurrent,
		OutputPower:   powerResp.Power.OutputPower,
		Efficiency:    powerResp.Power.Efficiency,
	}, nil
}

// SetFrequency sets the chip frequency
func (w *WhatsMinerCommunicator) SetFrequency(mhz int) error {
	cmd := fmt.Sprintf("set_freq|%d", mhz)
	_, err := w.sendCommand(cmd, true)
	return err
}

// SetFanSpeed sets the fan speed percentage
func (w *WhatsMinerCommunicator) SetFanSpeed(percentage int) error {
	// WhatsMiner uses RPM, not percentage
	// Convert percentage to RPM (assuming max 6000 RPM)
	rpm := percentage * 60
	
	cmd := fmt.Sprintf("set_fanspeed|%d", rpm)
	_, err := w.sendCommand(cmd, true)
	return err
}

// SetWorkMode sets the operating mode
func (w *WhatsMinerCommunicator) SetWorkMode(mode WorkMode) error {
	var powerLimit int
	switch mode {
	case ModeNormal:
		powerLimit = 100
	case ModeLowPower:
		powerLimit = 75
	case ModeHighPerformance:
		powerLimit = 120
	default:
		return fmt.Errorf("unsupported work mode: %v", mode)
	}
	
	cmd := fmt.Sprintf("set_power_limit|%d", powerLimit)
	_, err := w.sendCommand(cmd, true)
	return err
}

// Reboot restarts the ASIC
func (w *WhatsMinerCommunicator) Reboot() error {
	_, err := w.sendCommand("reboot", true)
	return err
}

// SendWork sends mining work to the device
func (w *WhatsMinerCommunicator) SendWork(work *MiningWork) error {
	// WhatsMiner ASICs receive work through Stratum protocol
	return errors.New("work submission through API not supported - use Stratum")
}

// GetWorkStatus retrieves work processing status
func (w *WhatsMinerCommunicator) GetWorkStatus() (*WorkStatus, error) {
	// Get pool information
	pools, err := w.sendCommand("pools", true)
	if err != nil {
		return nil, err
	}
	
	// Parse pools response
	// This would need proper parsing based on WhatsMiner's pools response format
	
	// For now, return basic information from summary
	status, err := w.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return &WorkStatus{
		ValidShares: status.Accepted,
		StaleShares: 0, // Would need to parse from pools response
	}, nil
}

// authenticate gets an authentication token from the device
func (w *WhatsMinerCommunicator) authenticate() error {
	// Check if token is still valid (tokens typically expire after 30 minutes)
	if w.token != "" && time.Since(w.tokenTime) < 25*time.Minute {
		return nil
	}
	
	// Get token
	resp, err := w.sendCommand("get_token", false)
	if err != nil {
		return err
	}
	
	// Parse token response
	var tokenResp struct {
		WhatsMinerResponse
		Token string `json:"token"`
	}
	
	if err := json.Unmarshal(resp, &tokenResp); err != nil {
		return fmt.Errorf("failed to parse token response: %w", err)
	}
	
	if tokenResp.Code != 0 {
		return fmt.Errorf("failed to get token: %s", tokenResp.Msg)
	}
	
	w.token = tokenResp.Token
	w.tokenTime = time.Now()
	
	return nil
}

// sendCommand sends a command to the ASIC and returns the response
func (w *WhatsMinerCommunicator) sendCommand(command string, needAuth bool) ([]byte, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	
	if !w.connected {
		return nil, errors.New("not connected")
	}
	
	// Re-authenticate if needed
	if needAuth && (w.token == "" || time.Since(w.tokenTime) >= 25*time.Minute) {
		if err := w.authenticate(); err != nil {
			return nil, err
		}
	}
	
	// Construct command
	cmd := WhatsMinerCommand{
		Cmd: command,
	}
	
	if needAuth && w.token != "" {
		cmd.Token = w.token
	}
	
	cmdJSON, err := json.Marshal(cmd)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal command: %w", err)
	}
	
	// Send command
	if err := w.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	if _, err := w.conn.Write(cmdJSON); err != nil {
		return nil, fmt.Errorf("failed to send command: %w", err)
	}
	
	// Add newline
	if _, err := w.conn.Write([]byte("\n")); err != nil {
		return nil, err
	}
	
	// Read response
	if err := w.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	// Read response (WhatsMiner responses can be large)
	buffer := make([]byte, 65536)
	n, err := w.conn.Read(buffer)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}
	
	response := buffer[:n]
	
	w.logger.Debug("WhatsMiner API response",
		zap.String("command", command),
		zap.String("response", string(response)),
	)
	
	return response, nil
}

// generateToken generates an authentication token
func generateToken(password string) string {
	// WhatsMiner uses MD5 hash of password as token
	h := md5.New()
	h.Write([]byte(password))
	return hex.EncodeToString(h.Sum(nil))
}

// parseWhatsMinerModel determines the specific WhatsMiner model from version info
func parseWhatsMinerModel(version string) ASICModel {
	switch {
	case contains(version, "M60"):
		return ModelWhatsMinerM60
	case contains(version, "M50"):
		return ModelWhatsMinerM50
	case contains(version, "M30S"):
		return ModelWhatsMinerM30S
	default:
		return ASICModel("Unknown")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && s[:len(substr)] == substr
}