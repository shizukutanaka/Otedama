package asic

import (
	"bufio"
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

// BitmainCommunicator implements communication with Bitmain Antminer ASICs
type BitmainCommunicator struct {
	logger   *zap.Logger
	conn     net.Conn
	address  string
	port     int
	mu       sync.Mutex
	
	// Connection state
	connected bool
}

// BitmainCommand represents a command to send to the ASIC
type BitmainCommand struct {
	Command   string                 `json:"command"`
	Parameter string                 `json:"parameter,omitempty"`
}

// BitmainResponse represents a response from the ASIC
type BitmainResponse struct {
	STATUS []struct {
		Code        int    `json:"Code"`
		Description string `json:"Description"`
		Status      string `json:"STATUS"`
		When        int64  `json:"When"`
	} `json:"STATUS"`
}

// DevstatResponse represents the devs command response
type DevstatResponse struct {
	BitmainResponse
	DEVS []struct {
		ID              int     `json:"ID"`
		Enabled         string  `json:"Enabled"`
		Status          string  `json:"Status"`
		Temperature     float32 `json:"Temperature"`
		MHSav           float64 `json:"MHS av"`
		MHS5s           float64 `json:"MHS 5s"`
		Accepted        uint64  `json:"Accepted"`
		Rejected        uint64  `json:"Rejected"`
		HardwareErrors  uint64  `json:"Hardware Errors"`
		Utility         float64 `json:"Utility"`
		LastShareTime   int64   `json:"Last Share Time"`
		TotalMH         float64 `json:"Total MH"`
		Frequency       int     `json:"Frequency"`
		FanSpeed        int     `json:"Fan Speed"`
	} `json:"DEVS"`
}

// StatsResponse represents the stats command response
type StatsResponse struct {
	BitmainResponse
	STATS []struct {
		ID            int                    `json:"ID"`
		Elapsed       int64                  `json:"Elapsed"`
		GHS5s         float64                `json:"GHS 5s"`
		GHSav         float64                `json:"GHS av"`
		TempChip      []float32              `json:"temp_chip"`
		TempPCB       []float32              `json:"temp_pcb"`
		TempMax       float32                `json:"temp_max"`
		FanNum        int                    `json:"fan_num"`
		Fan           []int                  `json:"fan"`
		FreqAvg       []float64              `json:"freq_avg"`
		TotalRateIdeal float64               `json:"total_rateideal"`
		TotalFreqAvg  float64                `json:"total_freqavg"`
		ChainACS      string                 `json:"chain_acs"`
		ChainHW       []uint64               `json:"chain_hw"`
		ChainRate     []float64              `json:"chain_rate"`
		ChainXtime    string                 `json:"chain_xtime"`
		ChainOpenCore []int                  `json:"chain_opencore"`
		MinerVersion  string                 `json:"miner_version"`
		CompileTime   string                 `json:"CompileTime"`
		Type          string                 `json:"Type"`
	} `json:"STATS"`
}

// PoolsResponse represents the pools command response
type PoolsResponse struct {
	BitmainResponse
	POOLS []struct {
		Pool          int    `json:"POOL"`
		URL           string `json:"URL"`
		Status        string `json:"Status"`
		Priority      int    `json:"Priority"`
		Quota         int    `json:"Quota"`
		LongPoll      string `json:"Long Poll"`
		Getworks      uint64 `json:"Getworks"`
		Accepted      uint64 `json:"Accepted"`
		Rejected      uint64 `json:"Rejected"`
		Works         uint64 `json:"Works"`
		Discarded     uint64 `json:"Discarded"`
		Stale         uint64 `json:"Stale"`
		GetFailures   uint64 `json:"Get Failures"`
		RemoteFailures uint64 `json:"Remote Failures"`
		User          string `json:"User"`
		LastShareTime int64  `json:"Last Share Time"`
		Diff1Shares   uint64 `json:"Diff1 Shares"`
		ProxyType     string `json:"Proxy Type"`
		Proxy         string `json:"Proxy"`
		DifficultyAccepted float64 `json:"Difficulty Accepted"`
		DifficultyRejected float64 `json:"Difficulty Rejected"`
		DifficultyStale    float64 `json:"Difficulty Stale"`
		LastShareDifficulty float64 `json:"Last Share Difficulty"`
		WorkDifficulty     float64 `json:"Work Difficulty"`
		HasStratum        bool    `json:"Has Stratum"`
		StratumActive     bool    `json:"Stratum Active"`
		StratumURL        string  `json:"Stratum URL"`
		StratumDifficulty float64 `json:"Stratum Difficulty"`
		HasGBT           bool     `json:"Has GBT"`
		BestShare        uint64   `json:"Best Share"`
		PoolRejectedPercentage float64 `json:"Pool Rejected%"`
		PoolStalePercentage    float64 `json:"Pool Stale%"`
		BadWork               uint64   `json:"Bad Work"`
		CurrentBlockHeight    uint64   `json:"Current Block Height"`
		CurrentBlockVersion   uint32   `json:"Current Block Version"`
	} `json:"POOLS"`
}

// NewBitmainCommunicator creates a new Bitmain ASIC communicator
func NewBitmainCommunicator(logger *zap.Logger) *BitmainCommunicator {
	return &BitmainCommunicator{
		logger: logger,
	}
}

// Connect establishes connection to the ASIC
func (b *BitmainCommunicator) Connect(address string, port int) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	if b.connected {
		return errors.New("already connected")
	}
	
	// Connect with timeout
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", address, port), 10*time.Second)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	b.conn = conn
	b.address = address
	b.port = port
	b.connected = true
	
	b.logger.Debug("Connected to Bitmain ASIC",
		zap.String("address", address),
		zap.Int("port", port),
	)
	
	return nil
}

// Disconnect closes the connection to the ASIC
func (b *BitmainCommunicator) Disconnect() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	if !b.connected {
		return nil
	}
	
	if b.conn != nil {
		b.conn.Close()
	}
	
	b.connected = false
	return nil
}

// IsConnected returns connection status
func (b *BitmainCommunicator) IsConnected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connected
}

// GetStatus retrieves device status
func (b *BitmainCommunicator) GetStatus() (*DeviceStatus, error) {
	// Get device statistics
	devs, err := b.sendCommand("devs", "")
	if err != nil {
		return nil, err
	}
	
	var devstat DevstatResponse
	if err := json.Unmarshal(devs, &devstat); err != nil {
		return nil, fmt.Errorf("failed to parse devs response: %w", err)
	}
	
	if len(devstat.DEVS) == 0 {
		return nil, errors.New("no devices found")
	}
	
	// Get detailed stats
	stats, err := b.sendCommand("stats", "")
	if err != nil {
		return nil, err
	}
	
	var statsResp StatsResponse
	if err := json.Unmarshal(stats, &statsResp); err != nil {
		return nil, fmt.Errorf("failed to parse stats response: %w", err)
	}
	
	// Combine data into DeviceStatus
	status := &DeviceStatus{
		Uptime:         time.Duration(statsResp.STATS[0].Elapsed) * time.Second,
		MHSAvg:         devstat.DEVS[0].MHSav,
		MHS5s:          devstat.DEVS[0].MHS5s,
		Accepted:       devstat.DEVS[0].Accepted,
		Rejected:       devstat.DEVS[0].Rejected,
		HardwareErrors: devstat.DEVS[0].HardwareErrors,
		Utility:        devstat.DEVS[0].Utility,
		LastShare:      time.Unix(devstat.DEVS[0].LastShareTime, 0),
		Frequency:      devstat.DEVS[0].Frequency,
	}
	
	// Process temperatures
	status.Temperatures = make(map[string]float32)
	for i, temp := range statsResp.STATS[0].TempChip {
		status.Temperatures[fmt.Sprintf("chip_%d", i)] = temp
	}
	for i, temp := range statsResp.STATS[0].TempPCB {
		status.Temperatures[fmt.Sprintf("pcb_%d", i)] = temp
	}
	status.Temperatures["max"] = statsResp.STATS[0].TempMax
	
	// Process fan speeds
	status.FanSpeeds = statsResp.STATS[0].Fan
	
	return status, nil
}

// GetHashRate retrieves current hash rate
func (b *BitmainCommunicator) GetHashRate() (uint64, error) {
	status, err := b.GetStatus()
	if err != nil {
		return 0, err
	}
	
	// Convert MH/s to H/s
	return uint64(status.MHS5s * 1e6), nil
}

// GetTemperature retrieves temperature readings
func (b *BitmainCommunicator) GetTemperature() (map[string]float32, error) {
	status, err := b.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.Temperatures, nil
}

// GetFanSpeed retrieves fan speeds
func (b *BitmainCommunicator) GetFanSpeed() ([]int, error) {
	status, err := b.GetStatus()
	if err != nil {
		return nil, err
	}
	
	return status.FanSpeeds, nil
}

// GetPowerStats retrieves power consumption statistics
func (b *BitmainCommunicator) GetPowerStats() (*PowerStats, error) {
	// Bitmain ASICs don't typically provide detailed power stats via API
	// This would need to be implemented based on specific model capabilities
	// or external power monitoring
	
	// For now, estimate based on hash rate and known efficiency
	hashRate, err := b.GetHashRate()
	if err != nil {
		return nil, err
	}
	
	// Estimate power based on typical efficiency (e.g., 30 J/TH for S19)
	efficiency := 30.0 // J/TH
	powerWatts := float32(float64(hashRate) / 1e12 * efficiency)
	
	return &PowerStats{
		InputPower:  powerWatts,
		OutputPower: powerWatts * 0.95, // Assume 95% PSU efficiency
		Efficiency:  95.0,
	}, nil
}

// SetFrequency sets the chip frequency
func (b *BitmainCommunicator) SetFrequency(mhz int) error {
	// Command format depends on specific Antminer model
	// This is a generic implementation
	_, err := b.sendCommand("bitmain-freq", strconv.Itoa(mhz))
	return err
}

// SetFanSpeed sets the fan speed percentage
func (b *BitmainCommunicator) SetFanSpeed(percentage int) error {
	// Ensure percentage is within valid range
	if percentage < 0 {
		percentage = 0
	}
	if percentage > 100 {
		percentage = 100
	}
	
	// Convert percentage to PWM value (0-255)
	pwm := percentage * 255 / 100
	
	_, err := b.sendCommand("bitmain-fan", strconv.Itoa(pwm))
	return err
}

// SetWorkMode sets the operating mode
func (b *BitmainCommunicator) SetWorkMode(mode WorkMode) error {
	var modeStr string
	switch mode {
	case ModeNormal:
		modeStr = "0"
	case ModeLowPower:
		modeStr = "1"
	case ModeHighPerformance:
		modeStr = "2"
	default:
		return fmt.Errorf("unsupported work mode: %v", mode)
	}
	
	_, err := b.sendCommand("bitmain-work-mode", modeStr)
	return err
}

// Reboot restarts the ASIC
func (b *BitmainCommunicator) Reboot() error {
	_, err := b.sendCommand("restart", "")
	return err
}

// SendWork sends mining work to the device
func (b *BitmainCommunicator) SendWork(work *MiningWork) error {
	// Bitmain ASICs typically receive work through Stratum protocol
	// This would need to integrate with the pool configuration
	return errors.New("work submission through API not supported - use Stratum")
}

// GetWorkStatus retrieves work processing status
func (b *BitmainCommunicator) GetWorkStatus() (*WorkStatus, error) {
	// Get pool information
	pools, err := b.sendCommand("pools", "")
	if err != nil {
		return nil, err
	}
	
	var poolsResp PoolsResponse
	if err := json.Unmarshal(pools, &poolsResp); err != nil {
		return nil, fmt.Errorf("failed to parse pools response: %w", err)
	}
	
	if len(poolsResp.POOLS) == 0 {
		return nil, errors.New("no pools configured")
	}
	
	// Use data from active pool
	var activePool *struct {
		Pool          int    `json:"POOL"`
		URL           string `json:"URL"`
		Status        string `json:"Status"`
		Priority      int    `json:"Priority"`
		Quota         int    `json:"Quota"`
		LongPoll      string `json:"Long Poll"`
		Getworks      uint64 `json:"Getworks"`
		Accepted      uint64 `json:"Accepted"`
		Rejected      uint64 `json:"Rejected"`
		Works         uint64 `json:"Works"`
		Discarded     uint64 `json:"Discarded"`
		Stale         uint64 `json:"Stale"`
		GetFailures   uint64 `json:"Get Failures"`
		RemoteFailures uint64 `json:"Remote Failures"`
		User          string `json:"User"`
		LastShareTime int64  `json:"Last Share Time"`
		Diff1Shares   uint64 `json:"Diff1 Shares"`
		ProxyType     string `json:"Proxy Type"`
		Proxy         string `json:"Proxy"`
		DifficultyAccepted float64 `json:"Difficulty Accepted"`
		DifficultyRejected float64 `json:"Difficulty Rejected"`
		DifficultyStale    float64 `json:"Difficulty Stale"`
		LastShareDifficulty float64 `json:"Last Share Difficulty"`
		WorkDifficulty     float64 `json:"Work Difficulty"`
		HasStratum        bool    `json:"Has Stratum"`
		StratumActive     bool    `json:"Stratum Active"`
		StratumURL        string  `json:"Stratum URL"`
		StratumDifficulty float64 `json:"Stratum Difficulty"`
		HasGBT           bool     `json:"Has GBT"`
		BestShare        uint64   `json:"Best Share"`
		PoolRejectedPercentage float64 `json:"Pool Rejected%"`
		PoolStalePercentage    float64 `json:"Pool Stale%"`
		BadWork               uint64   `json:"Bad Work"`
		CurrentBlockHeight    uint64   `json:"Current Block Height"`
		CurrentBlockVersion   uint32   `json:"Current Block Version"`
	}
	
	for i := range poolsResp.POOLS {
		if poolsResp.POOLS[i].Status == "Alive" {
			activePool = &poolsResp.POOLS[i]
			break
		}
	}
	
	if activePool == nil {
		return nil, errors.New("no active pool")
	}
	
	return &WorkStatus{
		ProcessedWork:   activePool.Works,
		ValidShares:     activePool.Accepted,
		StaleShares:     activePool.Stale,
		DuplicateShares: activePool.Discarded,
	}, nil
}

// sendCommand sends a command to the ASIC and returns the response
func (b *BitmainCommunicator) sendCommand(command, parameter string) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	if !b.connected {
		return nil, errors.New("not connected")
	}
	
	// Construct command
	cmd := map[string]interface{}{
		"command": command,
	}
	if parameter != "" {
		cmd["parameter"] = parameter
	}
	
	cmdJSON, err := json.Marshal(cmd)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal command: %w", err)
	}
	
	// Send command
	if err := b.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	if _, err := b.conn.Write(cmdJSON); err != nil {
		return nil, fmt.Errorf("failed to send command: %w", err)
	}
	
	// Read response
	if err := b.conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return nil, err
	}
	
	reader := bufio.NewReader(b.conn)
	response, err := reader.ReadBytes('\x00')
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}
	
	// Remove null terminator
	response = response[:len(response)-1]
	
	b.logger.Debug("Bitmain API response",
		zap.String("command", command),
		zap.String("response", string(response)),
	)
	
	return response, nil
}

// parseBitmainModel determines the specific Antminer model from version info
func parseBitmainModel(version string) ASICModel {
	version = strings.ToUpper(version)
	
	switch {
	case strings.Contains(version, "S19 XP"):
		return ModelAntminerS19XP
	case strings.Contains(version, "S19 PRO"):
		return ModelAntminerS19Pro
	case strings.Contains(version, "S19"):
		return ModelAntminerS19
	case strings.Contains(version, "T19"):
		return ModelAntminerT19
	case strings.Contains(version, "S9"):
		return ModelAntminerS9
	default:
		return ASICModel("Unknown")
	}
}