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

// GenericCommunicator implements a generic ASIC communicator using cgminer API
// This works with most ASICs that support the standard cgminer RPC API
type GenericCommunicator struct {
	logger   *zap.Logger
	conn     net.Conn
	address  string
	port     int
	mu       sync.Mutex
	
	// Connection state
	connected bool
}

// CGMinerCommand represents a cgminer API command
type CGMinerCommand struct {
	Command   string `json:"command"`
	Parameter string `json:"parameter,omitempty"`
}

// CGMinerSummaryResponse represents the summary command response
type CGMinerSummaryResponse struct {
	STATUS []struct {
		Code        int    `json:"Code"`
		Description string `json:"Description"`
		Status      string `json:"STATUS"`
		When        int64  `json:"When"`
	} `json:"STATUS"`
	SUMMARY []struct {
		Elapsed            int64   `json:"Elapsed"`
		MHSav              float64 `json:"MHS av"`
		MHS5s              float64 `json:"MHS 5s"`
		MHS1m              float64 `json:"MHS 1m"`
		MHS5m              float64 `json:"MHS 5m"`
		MHS15m             float64 `json:"MHS 15m"`
		FoundBlocks        int     `json:"Found Blocks"`
		Getworks           uint64  `json:"Getworks"`
		Accepted           uint64  `json:"Accepted"`
		Rejected           uint64  `json:"Rejected"`
		HardwareErrors     uint64  `json:"Hardware Errors"`
		Utility            float64 `json:"Utility"`
		Discarded          uint64  `json:"Discarded"`
		Stale              uint64  `json:"Stale"`
		GetFailures        uint64  `json:"Get Failures"`
		LocalWork          uint64  `json:"Local Work"`
		RemoteFailures     uint64  `json:"Remote Failures"`
		NetworkBlocks      uint64  `json:"Network Blocks"`
		TotalMH            float64 `json:"Total MH"`
		WorkUtility        float64 `json:"Work Utility"`
		DifficultyAccepted float64 `json:"Difficulty Accepted"`
		DifficultyRejected float64 `json:"Difficulty Rejected"`
		DifficultyStale    float64 `json:"Difficulty Stale"`
		BestShare          uint64  `json:"Best Share"`
		DeviceHardware     float64 `json:"Device Hardware%"`
		DeviceRejected     float64 `json:"Device Rejected%"`
		PoolRejected       float64 `json:"Pool Rejected%"`
		PoolStale          float64 `json:"Pool Stale%"`
		LastGetwork        int64   `json:"Last getwork"`
	} `json:"SUMMARY"`
}

// CGMinerDevsResponse represents the devs command response
type CGMinerDevsResponse struct {
	STATUS []struct {
		Code        int    `json:"Code"`
		Description string `json:"Description"`
		Status      string `json:"STATUS"`
		When        int64  `json:"When"`
	} `json:"STATUS"`
	DEVS []struct {
		GPU                  int     `json:"GPU,omitempty"`
		ASC                  int     `json:"ASC,omitempty"`
		PGA                  int     `json:"PGA,omitempty"`
		Name                 string  `json:"Name"`
		ID                   int     `json:"ID"`
		Enabled              string  `json:"Enabled"`
		Status               string  `json:"Status"`
		Temperature          float32 `json:"Temperature"`
		MHSav                float64 `json:"MHS av"`
		MHS5s                float64 `json:"MHS 5s"`
		MHS1m                float64 `json:"MHS 1m"`
		MHS5m                float64 `json:"MHS 5m"`
		MHS15m               float64 `json:"MHS 15m"`
		Accepted             uint64  `json:"Accepted"`
		Rejected             uint64  `json:"Rejected"`
		HardwareErrors       uint64  `json:"Hardware Errors"`
		Utility              float64 `json:"Utility"`
		LastSharePool        int     `json:"Last Share Pool"`
		LastShareTime        int64   `json:"Last Share Time"`
		TotalMH              float64 `json:"Total MH"`
		Diff1Work            uint64  `json:"Diff1 Work"`
		DifficultyAccepted   float64 `json:"Difficulty Accepted"`
		DifficultyRejected   float64 `json:"Difficulty Rejected"`
		LastShareDifficulty  float64 `json:"Last Share Difficulty"`
		LastValidWork        int64   `json:"Last Valid Work"`
		DeviceHardware       float64 `json:"Device Hardware%"`
		DeviceRejected       float64 `json:"Device Rejected%"`
		DeviceElapsed        int64   `json:"Device Elapsed"`
	} `json:"DEVS"`
}

// NewGenericCommunicator creates a new generic ASIC communicator
func NewGenericCommunicator(logger *zap.Logger) *GenericCommunicator {
	return &GenericCommunicator{
		logger: logger,
	}
}

// Connect establishes connection to the ASIC
func (g *GenericCommunicator) Connect(address string, port int) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	
	if g.connected {
		return errors.New("already connected")
	}
	
	// Default cgminer API port
	if port == 0 {
		port = 4028
	}
	
	// Connect with timeout
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", address, port), 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	g.conn = conn
	g.address = address
	g.port = port
	g.connected = true
	
	g.logger.Debug("Connected to generic ASIC",
		zap.String("address", address),
		zap.Int("port", port),
	)
	
	return nil
}

// Disconnect closes the connection to the ASIC
func (g *GenericCommunicator) Disconnect() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	
	if !g.connected {
		return nil
	}
	
	if g.conn != nil {
		g.conn.Close()
	}
	
	g.connected = false
	return nil
}

// IsConnected returns connection status
func (g *GenericCommunicator) IsConnected() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.connected
}

// GetStatus retrieves device status
func (g *GenericCommunicator) GetStatus() (*DeviceStatus, error) {
	// Get summary information
	summary, err := g.sendCommand("summary", "")
	if err != nil {
		return nil, err
	}
	
	var summaryResp CGMinerSummaryResponse
	if err := json.Unmarshal(summary, &summaryResp); err != nil {
		return nil, fmt.Errorf("failed to parse summary response: %w", err)
	}
	
	if len(summaryResp.SUMMARY) == 0 {
		return nil, errors.New("no summary data")
	}
	
	// Get device information
	devs, err := g.sendCommand("devs", "")
	if err != nil {
		return nil, err
	}
	
	var devsResp CGMinerDevsResponse
	if err := json.Unmarshal(devs, &devsResp); err != nil {
		return nil, fmt.Errorf("failed to parse devs response: %w", err)
	}
	
	summ := summaryResp.SUMMARY[0]
	
	status := &DeviceStatus{
		Uptime:         time.Duration(summ.Elapsed) * time.Second,
		MHSAvg:         summ.MHSav,
		MHS5s:          summ.MHS5s,
		Accepted:       summ.Accepted,
		Rejected:       summ.Rejected,
		HardwareErrors: summ.HardwareErrors,
		Utility:        summ.Utility,
		LastShare:      time.Unix(summ.LastGetwork, 0),
	}
	
	// Process device temperatures
	status.Temperatures = make(map[string]float32)
	for i, dev := range devsResp.DEVS {
		if dev.Temperature > 0 {
			status.Temperatures[fmt.Sprintf("dev_%d", i)] = dev.Temperature
		}
	}
	
	return status, nil
}

// GetHashRate retrieves current hash rate
func (g *GenericCommunicator) GetHashRate() (uint64, error) {
	status, err := g.GetStatus()
	if err != nil {
		return 0, err
	}
	
	// Convert MH/s to H/s
	return uint64(status.MHS5s * 1e6), nil
}

// GetTemperature retrieves temperature readings
func (g *GenericCommunicator) GetTemperature() (map[string]float32, error) {
	status, err := g.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.Temperatures, nil
}

// GetFanSpeed retrieves fan speeds
func (g *GenericCommunicator) GetFanSpeed() ([]int, error) {
	// Generic cgminer API doesn't typically provide fan speed
	// Return empty array
	return []int{}, nil
}

// GetPowerStats retrieves power consumption statistics
func (g *GenericCommunicator) GetPowerStats() (*PowerStats, error) {
	// Generic cgminer API doesn't provide power statistics
	// Estimate based on hash rate
	hashRate, err := g.GetHashRate()
	if err != nil {
		return nil, err
	}
	
	// Estimate power based on typical efficiency (40 J/TH as average)
	efficiency := 40.0 // J/TH
	powerWatts := float32(float64(hashRate) / 1e12 * efficiency)
	
	return &PowerStats{
		InputPower:  powerWatts,
		OutputPower: powerWatts * 0.93, // Assume 93% PSU efficiency
		Efficiency:  93.0,
	}, nil
}

// SetFrequency sets the chip frequency
func (g *GenericCommunicator) SetFrequency(mhz int) error {
	// Generic implementation - may not work with all ASICs
	_, err := g.sendCommand("setconfig", fmt.Sprintf("freq,value=%d", mhz))
	return err
}

// SetFanSpeed sets the fan speed percentage
func (g *GenericCommunicator) SetFanSpeed(percentage int) error {
	// Generic implementation - may not work with all ASICs
	_, err := g.sendCommand("setconfig", fmt.Sprintf("fan,value=%d", percentage))
	return err
}

// SetWorkMode sets the operating mode
func (g *GenericCommunicator) SetWorkMode(mode WorkMode) error {
	// Generic cgminer API doesn't support work modes
	return errors.New("work mode not supported by generic communicator")
}

// Reboot restarts the ASIC
func (g *GenericCommunicator) Reboot() error {
	_, err := g.sendCommand("restart", "")
	return err
}

// SendWork sends mining work to the device
func (g *GenericCommunicator) SendWork(work *MiningWork) error {
	// Generic ASICs receive work through Stratum protocol
	return errors.New("work submission through API not supported - use Stratum")
}

// GetWorkStatus retrieves work processing status
func (g *GenericCommunicator) GetWorkStatus() (*WorkStatus, error) {
	// Get pools information
	pools, err := g.sendCommand("pools", "")
	if err != nil {
		return nil, err
	}
	
	// Parse pools response to extract work information
	// This would need a proper pools response structure
	
	// For now, return basic information from summary
	status, err := g.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return &WorkStatus{
		ValidShares: status.Accepted,
		StaleShares: 0, // Not available in summary
	}, nil
}

// sendCommand sends a command to the ASIC and returns the response
func (g *GenericCommunicator) sendCommand(command, parameter string) ([]byte, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	
	if !g.connected {
		return nil, errors.New("not connected")
	}
	
	// Construct command in cgminer format
	var cmdStr string
	if parameter != "" {
		cmdStr = fmt.Sprintf(`{"command":"%s","parameter":"%s"}`, command, parameter)
	} else {
		cmdStr = fmt.Sprintf(`{"command":"%s"}`, command)
	}
	
	// Send command
	if err := g.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	if _, err := g.conn.Write([]byte(cmdStr)); err != nil {
		return nil, fmt.Errorf("failed to send command: %w", err)
	}
	
	// Read response
	if err := g.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	// Read until we get a complete response
	buffer := make([]byte, 4096)
	n, err := g.conn.Read(buffer)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}
	
	response := buffer[:n]
	
	g.logger.Debug("CGMiner API response",
		zap.String("command", command),
		zap.String("response", string(response)),
	)
	
	return response, nil
}