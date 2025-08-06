package asic

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"go.uber.org/zap"
)

// CanaanCommunicator implements communication with Canaan AvalonMiner ASICs
type CanaanCommunicator struct {
	logger   *zap.Logger
	conn     net.Conn
	address  string
	port     int
	mu       sync.Mutex
	
	// Connection state
	connected bool
}

// AvalonStatusResponse represents the Avalon status response
type AvalonStatusResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		Version        string  `json:"version"`
		CompileTime    string  `json:"compiletime"`
		Type           string  `json:"type"`
		Elapsed        int64   `json:"elapsed"`
		GHS5s          float64 `json:"ghs_5s"`
		GHSAv          float64 `json:"ghs_av"`
		TotalMH        float64 `json:"total_mh"`
		Accepted       uint64  `json:"accepted"`
		Rejected       uint64  `json:"rejected"`
		HardwareErrors uint64  `json:"hardware_errors"`
		Utility        float64 `json:"utility"`
		Stale          uint64  `json:"stale"`
		LocalWork      uint64  `json:"localwork"`
		WorkUtility    float64 `json:"work_utility"`
		BestShare      uint64  `json:"best_share"`
		DeviceCount    int     `json:"device_count"`
		Temperature    float32 `json:"temperature"`
		FanSpeed       int     `json:"fan_speed"`
		Frequency      int     `json:"frequency"`
		Voltage        float32 `json:"voltage"`
		PowerUsed      float32 `json:"power_used"`
		PowerSaved     float32 `json:"power_saved"`
		PowerMode      string  `json:"power_mode"`
		HashBoard      []struct {
			ID           int     `json:"id"`
			Enabled      bool    `json:"enabled"`
			Temperature  float32 `json:"temperature"`
			ChipCount    int     `json:"chip_count"`
			Frequency    int     `json:"frequency"`
			Voltage      float32 `json:"voltage"`
			GHS5s        float64 `json:"ghs_5s"`
			GHSAv        float64 `json:"ghs_av"`
			HardwareError uint64 `json:"hardware_error"`
		} `json:"hashboard"`
		Pool []struct {
			ID         int    `json:"id"`
			URL        string `json:"url"`
			Status     string `json:"status"`
			Priority   int    `json:"priority"`
			Accepted   uint64 `json:"accepted"`
			Rejected   uint64 `json:"rejected"`
			Stale      uint64 `json:"stale"`
			LastShare  int64  `json:"last_share"`
			Difficulty float64 `json:"difficulty"`
		} `json:"pool"`
	} `json:"data"`
}

// AvalonSystemInfoResponse represents system information
type AvalonSystemInfoResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		MacAddress     string `json:"mac_address"`
		Hostname       string `json:"hostname"`
		Model          string `json:"model"`
		SerialNumber   string `json:"serial_number"`
		FirmwareVersion string `json:"firmware_version"`
		HardwareVersion string `json:"hardware_version"`
		ManufactureDate string `json:"manufacture_date"`
		BootTime       int64  `json:"boot_time"`
		Uptime         int64  `json:"uptime"`
		LoadAverage    []float64 `json:"load_average"`
		MemoryTotal    int64  `json:"memory_total"`
		MemoryFree     int64  `json:"memory_free"`
		NetworkRX      uint64 `json:"network_rx"`
		NetworkTX      uint64 `json:"network_tx"`
	} `json:"data"`
}

// NewCanaanCommunicator creates a new Canaan ASIC communicator
func NewCanaanCommunicator(logger *zap.Logger) *CanaanCommunicator {
	return &CanaanCommunicator{
		logger: logger,
	}
}

// Connect establishes connection to the ASIC
func (c *CanaanCommunicator) Connect(address string, port int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	if c.connected {
		return errors.New("already connected")
	}
	
	// Default Avalon API port
	if port == 0 {
		port = 4028
	}
	
	// Connect with timeout
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", address, port), 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	c.conn = conn
	c.address = address
	c.port = port
	c.connected = true
	
	c.logger.Debug("Connected to Canaan ASIC",
		zap.String("address", address),
		zap.Int("port", port),
	)
	
	return nil
}

// Disconnect closes the connection to the ASIC
func (c *CanaanCommunicator) Disconnect() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	if !c.connected {
		return nil
	}
	
	if c.conn != nil {
		c.conn.Close()
	}
	
	c.connected = false
	return nil
}

// IsConnected returns connection status
func (c *CanaanCommunicator) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

// GetStatus retrieves device status
func (c *CanaanCommunicator) GetStatus() (*DeviceStatus, error) {
	// Get status information
	statusData, err := c.sendCommand("status")
	if err != nil {
		return nil, err
	}
	
	var statusResp AvalonStatusResponse
	if err := json.Unmarshal(statusData, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse status response: %w", err)
	}
	
	if statusResp.Code != 0 {
		return nil, fmt.Errorf("API error: %s", statusResp.Msg)
	}
	
	data := statusResp.Data
	
	status := &DeviceStatus{
		Uptime:         time.Duration(data.Elapsed) * time.Second,
		MHSAvg:         data.GHSAv * 1000, // Convert GH/s to MH/s
		MHS5s:          data.GHS5s * 1000,
		Accepted:       data.Accepted,
		Rejected:       data.Rejected,
		HardwareErrors: data.HardwareErrors,
		Utility:        data.Utility,
		Frequency:      data.Frequency,
		Voltage:        data.Voltage,
		FanSpeeds:      []int{data.FanSpeed},
	}
	
	// Process temperatures
	status.Temperatures = make(map[string]float32)
	status.Temperatures["main"] = data.Temperature
	
	for i, board := range data.HashBoard {
		if board.Enabled {
			status.Temperatures[fmt.Sprintf("board_%d", i)] = board.Temperature
		}
	}
	
	// Set last share time from pools
	for _, pool := range data.Pool {
		if pool.LastShare > 0 {
			status.LastShare = time.Unix(pool.LastShare, 0)
			break
		}
	}
	
	return status, nil
}

// GetHashRate retrieves current hash rate
func (c *CanaanCommunicator) GetHashRate() (uint64, error) {
	status, err := c.GetStatus()
	if err != nil {
		return 0, err
	}
	
	// Convert MH/s to H/s
	return uint64(status.MHS5s * 1e6), nil
}

// GetTemperature retrieves temperature readings
func (c *CanaanCommunicator) GetTemperature() (map[string]float32, error) {
	status, err := c.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.Temperatures, nil
}

// GetFanSpeed retrieves fan speeds
func (c *CanaanCommunicator) GetFanSpeed() ([]int, error) {
	status, err := c.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.FanSpeeds, nil
}

// GetPowerStats retrieves power consumption statistics
func (c *CanaanCommunicator) GetPowerStats() (*PowerStats, error) {
	statusData, err := c.sendCommand("status")
	if err != nil {
		return nil, err
	}
	
	var statusResp AvalonStatusResponse
	if err := json.Unmarshal(statusData, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse status response: %w", err)
	}
	
	if statusResp.Code != 0 {
		return nil, fmt.Errorf("API error: %s", statusResp.Msg)
	}
	
	data := statusResp.Data
	
	// Calculate efficiency
	hashRate := data.GHS5s * 1e9 // Convert to H/s
	var efficiency float32
	if hashRate > 0 {
		efficiency = data.PowerUsed / float32(hashRate/1e12) // W per TH/s
	}
	
	return &PowerStats{
		InputPower:  data.PowerUsed,
		OutputPower: data.PowerUsed - data.PowerSaved,
		Efficiency:  efficiency,
	}, nil
}

// SetFrequency sets the chip frequency
func (c *CanaanCommunicator) SetFrequency(mhz int) error {
	cmd := fmt.Sprintf("set_frequency:%d", mhz)
	resp, err := c.sendCommand(cmd)
	if err != nil {
		return err
	}
	
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	
	if err := json.Unmarshal(resp, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	if result.Code != 0 {
		return fmt.Errorf("failed to set frequency: %s", result.Msg)
	}
	
	return nil
}

// SetFanSpeed sets the fan speed percentage
func (c *CanaanCommunicator) SetFanSpeed(percentage int) error {
	// Ensure percentage is within valid range
	if percentage < 0 {
		percentage = 0
	}
	if percentage > 100 {
		percentage = 100
	}
	
	cmd := fmt.Sprintf("set_fan:%d", percentage)
	resp, err := c.sendCommand(cmd)
	if err != nil {
		return err
	}
	
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	
	if err := json.Unmarshal(resp, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	if result.Code != 0 {
		return fmt.Errorf("failed to set fan speed: %s", result.Msg)
	}
	
	return nil
}

// SetWorkMode sets the operating mode
func (c *CanaanCommunicator) SetWorkMode(mode WorkMode) error {
	var modeStr string
	switch mode {
	case ModeNormal:
		modeStr = "normal"
	case ModeLowPower:
		modeStr = "eco"
	case ModeHighPerformance:
		modeStr = "turbo"
	default:
		return fmt.Errorf("unsupported work mode: %v", mode)
	}
	
	cmd := fmt.Sprintf("set_power_mode:%s", modeStr)
	resp, err := c.sendCommand(cmd)
	if err != nil {
		return err
	}
	
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	
	if err := json.Unmarshal(resp, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	if result.Code != 0 {
		return fmt.Errorf("failed to set work mode: %s", result.Msg)
	}
	
	return nil
}

// Reboot restarts the ASIC
func (c *CanaanCommunicator) Reboot() error {
	resp, err := c.sendCommand("reboot")
	if err != nil {
		return err
	}
	
	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
	}
	
	if err := json.Unmarshal(resp, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	if result.Code != 0 {
		return fmt.Errorf("reboot failed: %s", result.Msg)
	}
	
	return nil
}

// SendWork sends mining work to the device
func (c *CanaanCommunicator) SendWork(work *MiningWork) error {
	// Canaan ASICs receive work through Stratum protocol
	return errors.New("work submission through API not supported - use Stratum")
}

// GetWorkStatus retrieves work processing status
func (c *CanaanCommunicator) GetWorkStatus() (*WorkStatus, error) {
	statusData, err := c.sendCommand("status")
	if err != nil {
		return nil, err
	}
	
	var statusResp AvalonStatusResponse
	if err := json.Unmarshal(statusData, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse status response: %w", err)
	}
	
	if statusResp.Code != 0 {
		return nil, fmt.Errorf("API error: %s", statusResp.Msg)
	}
	
	data := statusResp.Data
	
	// Calculate totals from all pools
	var totalAccepted, totalRejected, totalStale uint64
	for _, pool := range data.Pool {
		totalAccepted += pool.Accepted
		totalRejected += pool.Rejected
		totalStale += pool.Stale
	}
	
	return &WorkStatus{
		ValidShares: totalAccepted,
		StaleShares: totalStale,
	}, nil
}

// sendCommand sends a command to the ASIC and returns the response
func (c *CanaanCommunicator) sendCommand(command string) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	if !c.connected {
		return nil, errors.New("not connected")
	}
	
	// Construct command in JSON format
	cmd := map[string]string{
		"command": command,
	}
	
	cmdJSON, err := json.Marshal(cmd)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal command: %w", err)
	}
	
	// Send command
	if err := c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	if _, err := c.conn.Write(cmdJSON); err != nil {
		return nil, fmt.Errorf("failed to send command: %w", err)
	}
	
	// Add newline
	if _, err := c.conn.Write([]byte("\n")); err != nil {
		return nil, err
	}
	
	// Read response
	if err := c.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	// Read response
	buffer := make([]byte, 32768)
	n, err := c.conn.Read(buffer)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}
	
	response := buffer[:n]
	
	c.logger.Debug("Canaan API response",
		zap.String("command", command),
		zap.String("response", string(response)),
	)
	
	return response, nil
}

// parseCanaanModel determines the specific AvalonMiner model from version info
func parseCanaanModel(model string) ASICModel {
	switch model {
	case "1246":
		return ModelAvalonMiner1246
	case "1366":
		return ModelAvalonMiner1366
	default:
		return ASICModel(fmt.Sprintf("A%s", model))
	}
}