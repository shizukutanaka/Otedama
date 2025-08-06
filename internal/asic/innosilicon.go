package asic

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// InnosiliconCommunicator implements communication with Innosilicon ASICs
type InnosiliconCommunicator struct {
	logger   *zap.Logger
	conn     net.Conn
	address  string
	port     int
	mu       sync.Mutex
	
	// Connection state
	connected bool
}

// InnosiliconStatusResponse represents the status response
type InnosiliconStatusResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Type           string  `json:"type"`
		Version        string  `json:"version"`
		MinerId        string  `json:"miner_id"`
		CompileTime    string  `json:"compile_time"`
		UpTime         int64   `json:"uptime"`
		
		// Performance metrics
		HashRateRT     float64 `json:"hashrate_rt"`     // Real-time hash rate in GH/s
		HashRateAvg    float64 `json:"hashrate_avg"`    // Average hash rate in GH/s
		HashRate5m     float64 `json:"hashrate_5m"`     // 5-minute hash rate in GH/s
		
		// Share statistics
		SharesAccepted uint64  `json:"shares_accepted"`
		SharesRejected uint64  `json:"shares_rejected"`
		SharesStale    uint64  `json:"shares_stale"`
		SharesTotal    uint64  `json:"shares_total"`
		RejectRate     float64 `json:"reject_rate"`
		
		// Hardware info
		BoardCount     int     `json:"board_count"`
		ChipCount      int     `json:"chip_count"`
		HardwareErrors uint64  `json:"hardware_errors"`
		
		// Temperature and fans
		TempInput      float32 `json:"temp_input"`
		TempOutput     float32 `json:"temp_output"`
		TempMax        float32 `json:"temp_max"`
		FanCount       int     `json:"fan_count"`
		FanSpeed       []int   `json:"fan_speed"`
		
		// Power
		PowerUsage     float32 `json:"power_usage"`
		PowerLimit     float32 `json:"power_limit"`
		PowerEfficiency float32 `json:"power_efficiency"`
		
		// Pools
		PoolCount      int     `json:"pool_count"`
		ActivePool     int     `json:"active_pool"`
		
		// Boards detail
		Boards []struct {
			ID             int     `json:"id"`
			Status         string  `json:"status"`
			HashRate       float64 `json:"hashrate"`
			Temperature    float32 `json:"temperature"`
			ChipCount      int     `json:"chip_count"`
			HardwareErrors uint64  `json:"hardware_errors"`
			Frequency      int     `json:"frequency"`
			Voltage        float32 `json:"voltage"`
		} `json:"boards"`
		
		// Pools detail
		Pools []struct {
			ID          int    `json:"id"`
			URL         string `json:"url"`
			User        string `json:"user"`
			Status      string `json:"status"`
			Priority    int    `json:"priority"`
			Accepted    uint64 `json:"accepted"`
			Rejected    uint64 `json:"rejected"`
			Stale       uint64 `json:"stale"`
			LastShare   int64  `json:"last_share"`
			Difficulty  float64 `json:"difficulty"`
		} `json:"pools"`
	} `json:"data"`
}

// InnosiliconHardwareResponse represents hardware information
type InnosiliconHardwareResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Model          string `json:"model"`
		SerialNumber   string `json:"serial_number"`
		MacAddress     string `json:"mac_address"`
		IPAddress      string `json:"ip_address"`
		Hostname       string `json:"hostname"`
		KernelVersion  string `json:"kernel_version"`
		FileSystem     string `json:"file_system"`
		MemoryTotal    int64  `json:"memory_total"`
		MemoryFree     int64  `json:"memory_free"`
		LoadAverage    []float64 `json:"load_average"`
	} `json:"data"`
}

// NewInnosiliconCommunicator creates a new Innosilicon ASIC communicator
func NewInnosiliconCommunicator(logger *zap.Logger) *InnosiliconCommunicator {
	return &InnosiliconCommunicator{
		logger: logger,
	}
}

// Connect establishes connection to the ASIC
func (i *InnosiliconCommunicator) Connect(address string, port int) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	
	if i.connected {
		return errors.New("already connected")
	}
	
	// Default Innosilicon API port
	if port == 0 {
		port = 4111 // Innosilicon uses a different default port
	}
	
	// Connect with timeout
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", address, port), 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	i.conn = conn
	i.address = address
	i.port = port
	i.connected = true
	
	i.logger.Debug("Connected to Innosilicon ASIC",
		zap.String("address", address),
		zap.Int("port", port),
	)
	
	return nil
}

// Disconnect closes the connection to the ASIC
func (i *InnosiliconCommunicator) Disconnect() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	
	if !i.connected {
		return nil
	}
	
	if i.conn != nil {
		i.conn.Close()
	}
	
	i.connected = false
	return nil
}

// IsConnected returns connection status
func (i *InnosiliconCommunicator) IsConnected() bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.connected
}

// GetStatus retrieves device status
func (i *InnosiliconCommunicator) GetStatus() (*DeviceStatus, error) {
	// Get comprehensive status
	statusData, err := i.sendCommand("status", nil)
	if err != nil {
		return nil, err
	}
	
	var statusResp InnosiliconStatusResponse
	if err := json.Unmarshal(statusData, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse status response: %w", err)
	}
	
	if statusResp.Code != 0 {
		return nil, fmt.Errorf("API error: %s", statusResp.Message)
	}
	
	data := statusResp.Data
	
	status := &DeviceStatus{
		Uptime:         time.Duration(data.UpTime) * time.Second,
		MHSAvg:         data.HashRateAvg * 1000, // Convert GH/s to MH/s
		MHS5s:          data.HashRateRT * 1000,  // Use real-time as 5s
		Accepted:       data.SharesAccepted,
		Rejected:       data.SharesRejected,
		HardwareErrors: data.HardwareErrors,
		Utility:        float64(data.SharesAccepted) / float64(data.UpTime) * 60, // shares per minute
		FanSpeeds:      data.FanSpeed,
	}
	
	// Process temperatures
	status.Temperatures = make(map[string]float32)
	status.Temperatures["input"] = data.TempInput
	status.Temperatures["output"] = data.TempOutput
	status.Temperatures["max"] = data.TempMax
	
	// Add board temperatures
	for idx, board := range data.Boards {
		status.Temperatures[fmt.Sprintf("board_%d", idx)] = board.Temperature
	}
	
	// Get frequency from first active board
	for _, board := range data.Boards {
		if board.Status == "active" || board.Status == "running" {
			status.Frequency = board.Frequency
			status.Voltage = board.Voltage
			break
		}
	}
	
	// Set last share time from active pool
	if data.ActivePool >= 0 && data.ActivePool < len(data.Pools) {
		pool := data.Pools[data.ActivePool]
		if pool.LastShare > 0 {
			status.LastShare = time.Unix(pool.LastShare, 0)
		}
	}
	
	return status, nil
}

// GetHashRate retrieves current hash rate
func (i *InnosiliconCommunicator) GetHashRate() (uint64, error) {
	status, err := i.GetStatus()
	if err != nil {
		return 0, err
	}
	
	// Convert MH/s to H/s
	return uint64(status.MHS5s * 1e6), nil
}

// GetTemperature retrieves temperature readings
func (i *InnosiliconCommunicator) GetTemperature() (map[string]float32, error) {
	status, err := i.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.Temperatures, nil
}

// GetFanSpeed retrieves fan speeds
func (i *InnosiliconCommunicator) GetFanSpeed() ([]int, error) {
	status, err := i.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.FanSpeeds, nil
}

// GetPowerStats retrieves power consumption statistics
func (i *InnosiliconCommunicator) GetPowerStats() (*PowerStats, error) {
	statusData, err := i.sendCommand("status", nil)
	if err != nil {
		return nil, err
	}
	
	var statusResp InnosiliconStatusResponse
	if err := json.Unmarshal(statusData, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse status response: %w", err)
	}
	
	if statusResp.Code != 0 {
		return nil, fmt.Errorf("API error: %s", statusResp.Message)
	}
	
	data := statusResp.Data
	
	// Calculate output power (assuming 93% PSU efficiency)
	outputPower := data.PowerUsage * 0.93
	
	return &PowerStats{
		InputPower:  data.PowerUsage,
		OutputPower: outputPower,
		Efficiency:  data.PowerEfficiency,
	}, nil
}

// SetFrequency sets the chip frequency
func (i *InnosiliconCommunicator) SetFrequency(mhz int) error {
	params := map[string]interface{}{
		"frequency": mhz,
	}
	
	resp, err := i.sendCommand("set_frequency", params)
	if err != nil {
		return err
	}
	
	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	
	if err := json.Unmarshal(resp, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	if result.Code != 0 {
		return fmt.Errorf("failed to set frequency: %s", result.Message)
	}
	
	return nil
}

// SetFanSpeed sets the fan speed percentage
func (i *InnosiliconCommunicator) SetFanSpeed(percentage int) error {
	// Ensure percentage is within valid range
	if percentage < 0 {
		percentage = 0
	}
	if percentage > 100 {
		percentage = 100
	}
	
	params := map[string]interface{}{
		"fan_speed": percentage,
	}
	
	resp, err := i.sendCommand("set_fan", params)
	if err != nil {
		return err
	}
	
	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	
	if err := json.Unmarshal(resp, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	if result.Code != 0 {
		return fmt.Errorf("failed to set fan speed: %s", result.Message)
	}
	
	return nil
}

// SetWorkMode sets the operating mode
func (i *InnosiliconCommunicator) SetWorkMode(mode WorkMode) error {
	var powerLimit float32
	switch mode {
	case ModeNormal:
		powerLimit = 0 // Use default
	case ModeLowPower:
		// Get current power and reduce by 25%
		status, err := i.GetStatus()
		if err != nil {
			return err
		}
		powerLimit = status.Voltage * 0.75
	case ModeHighPerformance:
		powerLimit = 0 // Remove limit
	default:
		return fmt.Errorf("unsupported work mode: %v", mode)
	}
	
	params := map[string]interface{}{
		"power_limit": powerLimit,
	}
	
	resp, err := i.sendCommand("set_power_limit", params)
	if err != nil {
		return err
	}
	
	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	
	if err := json.Unmarshal(resp, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	if result.Code != 0 {
		return fmt.Errorf("failed to set work mode: %s", result.Message)
	}
	
	return nil
}

// Reboot restarts the ASIC
func (i *InnosiliconCommunicator) Reboot() error {
	resp, err := i.sendCommand("reboot", nil)
	if err != nil {
		return err
	}
	
	var result struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	}
	
	if err := json.Unmarshal(resp, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	
	if result.Code != 0 {
		return fmt.Errorf("reboot failed: %s", result.Message)
	}
	
	return nil
}

// SendWork sends mining work to the device
func (i *InnosiliconCommunicator) SendWork(work *MiningWork) error {
	// Innosilicon ASICs receive work through Stratum protocol
	return errors.New("work submission through API not supported - use Stratum")
}

// GetWorkStatus retrieves work processing status
func (i *InnosiliconCommunicator) GetWorkStatus() (*WorkStatus, error) {
	statusData, err := i.sendCommand("status", nil)
	if err != nil {
		return nil, err
	}
	
	var statusResp InnosiliconStatusResponse
	if err := json.Unmarshal(statusData, &statusResp); err != nil {
		return nil, fmt.Errorf("failed to parse status response: %w", err)
	}
	
	if statusResp.Code != 0 {
		return nil, fmt.Errorf("API error: %s", statusResp.Message)
	}
	
	data := statusResp.Data
	
	// Get work info from active pool
	var currentJobID string
	if data.ActivePool >= 0 && data.ActivePool < len(data.Pools) {
		currentJobID = fmt.Sprintf("pool_%d", data.ActivePool)
	}
	
	return &WorkStatus{
		CurrentJobID:    currentJobID,
		ProcessedWork:   data.SharesTotal,
		ValidShares:     data.SharesAccepted,
		StaleShares:     data.SharesStale,
		DuplicateShares: 0, // Not available in API
	}, nil
}

// sendCommand sends a command to the ASIC and returns the response
func (i *InnosiliconCommunicator) sendCommand(command string, params map[string]interface{}) ([]byte, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	
	if !i.connected {
		return nil, errors.New("not connected")
	}
	
	// Construct command in JSON-RPC format
	request := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  command,
		"id":      1,
	}
	
	if params != nil {
		request["params"] = params
	}
	
	cmdJSON, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal command: %w", err)
	}
	
	// Send command
	if err := i.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	if _, err := i.conn.Write(cmdJSON); err != nil {
		return nil, fmt.Errorf("failed to send command: %w", err)
	}
	
	// Add newline
	if _, err := i.conn.Write([]byte("\n")); err != nil {
		return nil, err
	}
	
	// Read response
	if err := i.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	// Read response
	buffer := make([]byte, 65536)
	n, err := i.conn.Read(buffer)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}
	
	response := buffer[:n]
	
	i.logger.Debug("Innosilicon API response",
		zap.String("command", command),
		zap.String("response", string(response)),
	)
	
	return response, nil
}

// parseInnosiliconModel determines the specific Innosilicon model from type info
func parseInnosiliconModel(typeStr string) ASICModel {
	typeStr = strings.ToUpper(typeStr)
	
	if strings.Contains(typeStr, "T3") {
		return ModelInnosiliconT3
	}
	
	// Extract model from type string (e.g., "T2T-30T" -> "T2T")
	parts := strings.Split(typeStr, "-")
	if len(parts) > 0 {
		return ASICModel(parts[0])
	}
	
	return ASICModel("Unknown")
}

// calculatePowerEfficiency calculates power efficiency in J/TH
func calculatePowerEfficiency(powerWatts float32, hashRateGHS float64) float32 {
	if hashRateGHS <= 0 {
		return 0
	}
	
	// Convert GH/s to TH/s
	hashRateTHS := hashRateGHS / 1000
	
	// Calculate J/TH
	return powerWatts / float32(hashRateTHS)
}