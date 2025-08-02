package websocket

import (
	"context"
	"sync"
	"time"

	"go.uber.org/zap"
)

// MiningStatsSource provides real-time mining statistics
type MiningStatsSource struct {
	logger      *zap.Logger
	subscribers sync.Map // map[string]chan MiningStats
	stats       MiningStats
	mu          sync.RWMutex
	updateFunc  func() MiningStats
}

// MiningStats represents current mining statistics
type MiningStats struct {
	Hashrate      float64            `json:"hashrate"`
	Shares        ShareStats         `json:"shares"`
	Workers       []WorkerStats      `json:"workers"`
	Earnings      EarningsStats      `json:"earnings"`
	Algorithms    map[string]AlgoStats `json:"algorithms"`
	UpdatedAt     time.Time          `json:"updated_at"`
}

// ShareStats represents share statistics
type ShareStats struct {
	Accepted     uint64  `json:"accepted"`
	Rejected     uint64  `json:"rejected"`
	Stale        uint64  `json:"stale"`
	Invalid      uint64  `json:"invalid"`
	Difficulty   float64 `json:"difficulty"`
	EffortPercent float64 `json:"effort_percent"`
}

// WorkerStats represents per-worker statistics
type WorkerStats struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Hashrate     float64   `json:"hashrate"`
	SharesValid  uint64    `json:"shares_valid"`
	SharesTotal  uint64    `json:"shares_total"`
	LastSeen     time.Time `json:"last_seen"`
	Status       string    `json:"status"`
}

// EarningsStats represents earnings information
type EarningsStats struct {
	Balance      float64   `json:"balance"`
	Paid         float64   `json:"paid"`
	Pending      float64   `json:"pending"`
	TodayEarned  float64   `json:"today_earned"`
	EstimatedDaily float64 `json:"estimated_daily"`
}

// AlgoStats represents per-algorithm statistics
type AlgoStats struct {
	Hashrate     float64 `json:"hashrate"`
	Workers      int     `json:"workers"`
	Profitability float64 `json:"profitability"`
}

// NewMiningStatsSource creates a new mining stats data source
func NewMiningStatsSource(logger *zap.Logger, updateFunc func() MiningStats) *MiningStatsSource {
	return &MiningStatsSource{
		logger:     logger,
		updateFunc: updateFunc,
	}
}

// Subscribe adds a client subscription
func (mss *MiningStatsSource) Subscribe(clientID string, params map[string]interface{}) error {
	ch := make(chan MiningStats, 10)
	mss.subscribers.Store(clientID, ch)
	
	// Start update loop for this subscriber
	go mss.updateLoop(clientID, ch)
	
	return nil
}

// Unsubscribe removes a client subscription
func (mss *MiningStatsSource) Unsubscribe(clientID string) error {
	if val, ok := mss.subscribers.LoadAndDelete(clientID); ok {
		close(val.(chan MiningStats))
	}
	return nil
}

// GetSnapshot returns current stats snapshot
func (mss *MiningStatsSource) GetSnapshot() (interface{}, error) {
	mss.mu.RLock()
	defer mss.mu.RUnlock()
	return mss.stats, nil
}

// Update refreshes the statistics
func (mss *MiningStatsSource) Update() {
	if mss.updateFunc == nil {
		return
	}
	
	newStats := mss.updateFunc()
	newStats.UpdatedAt = time.Now()
	
	mss.mu.Lock()
	mss.stats = newStats
	mss.mu.Unlock()
	
	// Notify all subscribers
	mss.subscribers.Range(func(key, value interface{}) bool {
		ch := value.(chan MiningStats)
		select {
		case ch <- newStats:
		default:
			// Channel full, skip
		}
		return true
	})
}

func (mss *MiningStatsSource) updateLoop(clientID string, ch chan MiningStats) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Check if still subscribed
			if _, ok := mss.subscribers.Load(clientID); !ok {
				return
			}
			
			mss.mu.RLock()
			stats := mss.stats
			mss.mu.RUnlock()
			
			select {
			case ch <- stats:
			default:
				// Channel full
			}
			
		case _, ok := <-ch:
			if !ok {
				return
			}
		}
	}
}

// HardwareMonitorSource provides real-time hardware monitoring data
type HardwareMonitorSource struct {
	logger      *zap.Logger
	subscribers sync.Map // map[string]chan HardwareStats
	stats       HardwareStats
	mu          sync.RWMutex
	updateFunc  func() HardwareStats
}

// HardwareStats represents hardware monitoring data
type HardwareStats struct {
	CPU       CPUStats      `json:"cpu"`
	GPU       []GPUStats    `json:"gpu"`
	Memory    MemoryStats   `json:"memory"`
	Disk      DiskStats     `json:"disk"`
	Network   NetworkStats  `json:"network"`
	UpdatedAt time.Time     `json:"updated_at"`
}

// CPUStats represents CPU statistics
type CPUStats struct {
	Usage       float64   `json:"usage"`
	Temperature float64   `json:"temperature"`
	Frequency   float64   `json:"frequency"`
	Cores       []float64 `json:"cores"`
}

// GPUStats represents GPU statistics
type GPUStats struct {
	Index       int     `json:"index"`
	Name        string  `json:"name"`
	Usage       float64 `json:"usage"`
	Memory      float64 `json:"memory"`
	Temperature float64 `json:"temperature"`
	Power       float64 `json:"power"`
	FanSpeed    float64 `json:"fan_speed"`
}

// MemoryStats represents memory statistics
type MemoryStats struct {
	Used      uint64  `json:"used"`
	Total     uint64  `json:"total"`
	Available uint64  `json:"available"`
	Percent   float64 `json:"percent"`
}

// DiskStats represents disk statistics
type DiskStats struct {
	Used    uint64  `json:"used"`
	Total   uint64  `json:"total"`
	Free    uint64  `json:"free"`
	Percent float64 `json:"percent"`
}

// NetworkStats represents network statistics
type NetworkStats struct {
	BytesSent uint64  `json:"bytes_sent"`
	BytesRecv uint64  `json:"bytes_recv"`
	SendRate  float64 `json:"send_rate"`
	RecvRate  float64 `json:"recv_rate"`
}

// NewHardwareMonitorSource creates a new hardware monitor data source
func NewHardwareMonitorSource(logger *zap.Logger, updateFunc func() HardwareStats) *HardwareMonitorSource {
	return &HardwareMonitorSource{
		logger:     logger,
		updateFunc: updateFunc,
	}
}

// Subscribe adds a client subscription
func (hms *HardwareMonitorSource) Subscribe(clientID string, params map[string]interface{}) error {
	ch := make(chan HardwareStats, 10)
	hms.subscribers.Store(clientID, ch)
	
	// Start update loop for this subscriber
	interval := time.Second
	if val, ok := params["interval"]; ok {
		if intervalMs, ok := val.(float64); ok {
			interval = time.Duration(intervalMs) * time.Millisecond
		}
	}
	
	go hms.updateLoop(clientID, ch, interval)
	
	return nil
}

// Unsubscribe removes a client subscription
func (hms *HardwareMonitorSource) Unsubscribe(clientID string) error {
	if val, ok := hms.subscribers.LoadAndDelete(clientID); ok {
		close(val.(chan HardwareStats))
	}
	return nil
}

// GetSnapshot returns current hardware snapshot
func (hms *HardwareMonitorSource) GetSnapshot() (interface{}, error) {
	hms.mu.RLock()
	defer hms.mu.RUnlock()
	return hms.stats, nil
}

// Update refreshes the hardware statistics
func (hms *HardwareMonitorSource) Update() {
	if hms.updateFunc == nil {
		return
	}
	
	newStats := hms.updateFunc()
	newStats.UpdatedAt = time.Now()
	
	hms.mu.Lock()
	hms.stats = newStats
	hms.mu.Unlock()
	
	// Notify all subscribers
	hms.subscribers.Range(func(key, value interface{}) bool {
		ch := value.(chan HardwareStats)
		select {
		case ch <- newStats:
		default:
			// Channel full, skip
		}
		return true
	})
}

func (hms *HardwareMonitorSource) updateLoop(clientID string, ch chan HardwareStats, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Check if still subscribed
			if _, ok := hms.subscribers.Load(clientID); !ok {
				return
			}
			
			hms.mu.RLock()
			stats := hms.stats
			hms.mu.RUnlock()
			
			select {
			case ch <- stats:
			default:
				// Channel full
			}
			
		case _, ok := <-ch:
			if !ok {
				return
			}
		}
	}
}

// P2PNetworkSource provides real-time P2P network data
type P2PNetworkSource struct {
	logger      *zap.Logger
	subscribers sync.Map // map[string]chan P2PStats
	stats       P2PStats
	mu          sync.RWMutex
	updateFunc  func() P2PStats
}

// P2PStats represents P2P network statistics
type P2PStats struct {
	NodeID      string      `json:"node_id"`
	PeerCount   int         `json:"peer_count"`
	Peers       []PeerInfo  `json:"peers"`
	ShareChain  ShareChainInfo `json:"share_chain"`
	NetworkHash float64     `json:"network_hash"`
	UpdatedAt   time.Time   `json:"updated_at"`
}

// PeerInfo represents information about a peer
type PeerInfo struct {
	ID          string    `json:"id"`
	Address     string    `json:"address"`
	Version     string    `json:"version"`
	Hashrate    float64   `json:"hashrate"`
	ShareCount  uint64    `json:"share_count"`
	LastSeen    time.Time `json:"last_seen"`
	Latency     int       `json:"latency_ms"`
}

// ShareChainInfo represents share chain statistics
type ShareChainInfo struct {
	Height      uint64    `json:"height"`
	Difficulty  float64   `json:"difficulty"`
	ShareRate   float64   `json:"share_rate"`
	OrphanRate  float64   `json:"orphan_rate"`
}

// NewP2PNetworkSource creates a new P2P network data source
func NewP2PNetworkSource(logger *zap.Logger, updateFunc func() P2PStats) *P2PNetworkSource {
	return &P2PNetworkSource{
		logger:     logger,
		updateFunc: updateFunc,
	}
}

// Subscribe adds a client subscription
func (pns *P2PNetworkSource) Subscribe(clientID string, params map[string]interface{}) error {
	ch := make(chan P2PStats, 10)
	pns.subscribers.Store(clientID, ch)
	
	// Start update loop for this subscriber
	go pns.updateLoop(clientID, ch)
	
	return nil
}

// Unsubscribe removes a client subscription
func (pns *P2PNetworkSource) Unsubscribe(clientID string) error {
	if val, ok := pns.subscribers.LoadAndDelete(clientID); ok {
		close(val.(chan P2PStats))
	}
	return nil
}

// GetSnapshot returns current P2P network snapshot
func (pns *P2PNetworkSource) GetSnapshot() (interface{}, error) {
	pns.mu.RLock()
	defer pns.mu.RUnlock()
	return pns.stats, nil
}

// Update refreshes the P2P network statistics
func (pns *P2PNetworkSource) Update() {
	if pns.updateFunc == nil {
		return
	}
	
	newStats := pns.updateFunc()
	newStats.UpdatedAt = time.Now()
	
	pns.mu.Lock()
	pns.stats = newStats
	pns.mu.Unlock()
	
	// Notify all subscribers
	pns.subscribers.Range(func(key, value interface{}) bool {
		ch := value.(chan P2PStats)
		select {
		case ch <- newStats:
		default:
			// Channel full, skip
		}
		return true
	})
}

func (pns *P2PNetworkSource) updateLoop(clientID string, ch chan P2PStats) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			// Check if still subscribed
			if _, ok := pns.subscribers.Load(clientID); !ok {
				return
			}
			
			pns.mu.RLock()
			stats := pns.stats
			pns.mu.RUnlock()
			
			select {
			case ch <- stats:
			default:
				// Channel full
			}
			
		case _, ok := <-ch:
			if !ok {
				return
			}
		}
	}
}

// AlertSource provides real-time alerts
type AlertSource struct {
	logger      *zap.Logger
	subscribers sync.Map // map[string]chan Alert
	alerts      []Alert
	mu          sync.RWMutex
	maxAlerts   int
}

// Alert represents a system alert
type Alert struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Severity  string    `json:"severity"`
	Component string    `json:"component"`
	Message   string    `json:"message"`
	Details   map[string]interface{} `json:"details,omitempty"`
	Timestamp time.Time `json:"timestamp"`
	Resolved  bool      `json:"resolved"`
}

// NewAlertSource creates a new alert data source
func NewAlertSource(logger *zap.Logger, maxAlerts int) *AlertSource {
	if maxAlerts <= 0 {
		maxAlerts = 100
	}
	return &AlertSource{
		logger:    logger,
		maxAlerts: maxAlerts,
		alerts:    make([]Alert, 0, maxAlerts),
	}
}

// Subscribe adds a client subscription
func (as *AlertSource) Subscribe(clientID string, params map[string]interface{}) error {
	ch := make(chan Alert, 10)
	as.subscribers.Store(clientID, ch)
	return nil
}

// Unsubscribe removes a client subscription
func (as *AlertSource) Unsubscribe(clientID string) error {
	if val, ok := as.subscribers.LoadAndDelete(clientID); ok {
		close(val.(chan Alert))
	}
	return nil
}

// GetSnapshot returns current alerts
func (as *AlertSource) GetSnapshot() (interface{}, error) {
	as.mu.RLock()
	defer as.mu.RUnlock()
	
	// Return only unresolved alerts
	unresolved := make([]Alert, 0)
	for _, alert := range as.alerts {
		if !alert.Resolved {
			unresolved = append(unresolved, alert)
		}
	}
	
	return unresolved, nil
}

// AddAlert adds a new alert and notifies subscribers
func (as *AlertSource) AddAlert(alert Alert) {
	as.mu.Lock()
	as.alerts = append(as.alerts, alert)
	
	// Maintain max alerts
	if len(as.alerts) > as.maxAlerts {
		as.alerts = as.alerts[len(as.alerts)-as.maxAlerts:]
	}
	as.mu.Unlock()
	
	// Notify all subscribers
	as.subscribers.Range(func(key, value interface{}) bool {
		ch := value.(chan Alert)
		select {
		case ch <- alert:
		default:
			// Channel full, skip
		}
		return true
	})
}

// ResolveAlert marks an alert as resolved
func (as *AlertSource) ResolveAlert(alertID string) {
	as.mu.Lock()
	defer as.mu.Unlock()
	
	for i := range as.alerts {
		if as.alerts[i].ID == alertID {
			as.alerts[i].Resolved = true
			break
		}
	}
}