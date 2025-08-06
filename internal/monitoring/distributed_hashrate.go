package monitoring

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/p2p"
	"go.uber.org/zap"
)

// DistributedHashrateMonitor monitors hashrate across the P2P network
// John Carmack's optimization with distributed system monitoring
type DistributedHashrateMonitor struct {
	logger *zap.Logger
	config DistributedHashrateConfig
	
	// P2P integration
	p2pPool         *p2p.Pool
	
	// Local hashrate tracking
	localHashrate   atomic.Uint64
	localWorkers    atomic.Int32
	
	// Network hashrate tracking
	networkHashrate map[string]*PeerHashrate
	networkMu       sync.RWMutex
	
	// Aggregated stats
	totalHashrate   atomic.Uint64
	totalWorkers    atomic.Int32
	
	// History tracking
	history         *HashRateHistory
	
	// Reporting
	reporters       []HashRateReporter
	
	// Lifecycle
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
}

// DistributedHashrateConfig contains configuration
type DistributedHashrateConfig struct {
	// Update intervals
	LocalUpdateInterval    time.Duration `json:"local_update_interval"`
	NetworkUpdateInterval  time.Duration `json:"network_update_interval"`
	BroadcastInterval      time.Duration `json:"broadcast_interval"`
	
	// History settings
	HistoryRetention       time.Duration `json:"history_retention"`
	HistoryResolution      time.Duration `json:"history_resolution"`
	
	// Network settings
	MaxPeers               int           `json:"max_peers"`
	PeerTimeout            time.Duration `json:"peer_timeout"`
	
	// Reporting
	EnableReporting        bool          `json:"enable_reporting"`
	ReportingEndpoints     []string      `json:"reporting_endpoints"`
}

// PeerHashrate represents hashrate data from a peer
type PeerHashrate struct {
	PeerID          string
	Hashrate        uint64
	Workers         int32
	Algorithm       string
	LastUpdate      time.Time
	
	// Additional metrics
	SharesSubmitted uint64
	SharesAccepted  uint64
	Difficulty      float64
	
	// Network info
	Latency         time.Duration
	Version         string
}

// HashRateHistory tracks historical hashrate data
type HashRateHistory struct {
	mu              sync.RWMutex
	
	// Time series data
	timestamps      []time.Time
	localHashrates  []uint64
	totalHashrates  []uint64
	workerCounts    []int32
	
	// Aggregated by period
	hourly          map[time.Time]*AggregatedHashrate
	daily           map[time.Time]*AggregatedHashrate
	
	// Settings
	maxEntries      int
	retention       time.Duration
}

// AggregatedHashrate represents aggregated hashrate data
type AggregatedHashrate struct {
	Period          time.Time
	AvgHashrate     uint64
	MinHashrate     uint64
	MaxHashrate     uint64
	AvgWorkers      int32
	TotalShares     uint64
	
	// By algorithm
	AlgorithmStats  map[string]*AlgorithmHashrate
}

// AlgorithmHashrate represents hashrate by algorithm
type AlgorithmHashrate struct {
	Algorithm   string
	Hashrate    uint64
	Workers     int32
	Efficiency  float64
}

// HashRateReporter interface for hashrate reporting
type HashRateReporter interface {
	Name() string
	Report(stats *NetworkHashrateStats) error
}

// NetworkHashrateStats represents network-wide hashrate statistics
type NetworkHashrateStats struct {
	Timestamp       time.Time
	
	// Local node
	LocalHashrate   uint64
	LocalWorkers    int32
	
	// Network totals
	NetworkHashrate uint64
	NetworkWorkers  int32
	ActivePeers     int
	
	// By peer
	PeerStats       []PeerHashrate
	
	// By algorithm
	AlgorithmStats  map[string]*AlgorithmHashrate
	
	// Performance
	NetworkEfficiency float64
	AverageLatency    time.Duration
}

// NewDistributedHashrateMonitor creates a new distributed hashrate monitor
func NewDistributedHashrateMonitor(logger *zap.Logger, config DistributedHashrateConfig, p2pPool *p2p.Pool) *DistributedHashrateMonitor {
	ctx, cancel := context.WithCancel(context.Background())
	
	monitor := &DistributedHashrateMonitor{
		logger:          logger,
		config:          config,
		p2pPool:         p2pPool,
		networkHashrate: make(map[string]*PeerHashrate),
		history:         NewHashRateHistory(config.HistoryRetention),
		reporters:       make([]HashRateReporter, 0),
		ctx:             ctx,
		cancel:          cancel,
	}
	
	// Initialize reporters
	if config.EnableReporting {
		for _, endpoint := range config.ReportingEndpoints {
			reporter := NewHTTPHashrateReporter(endpoint)
			monitor.RegisterReporter(reporter)
		}
	}
	
	return monitor
}

// RegisterReporter registers a hashrate reporter
func (dhm *DistributedHashrateMonitor) RegisterReporter(reporter HashRateReporter) {
	dhm.reporters = append(dhm.reporters, reporter)
	dhm.logger.Info("Registered hashrate reporter", zap.String("name", reporter.Name()))
}

// Start starts the distributed hashrate monitor
func (dhm *DistributedHashrateMonitor) Start() {
	// Start update loops
	dhm.wg.Add(1)
	go dhm.localUpdateLoop()
	
	dhm.wg.Add(1)
	go dhm.networkUpdateLoop()
	
	dhm.wg.Add(1)
	go dhm.broadcastLoop()
	
	// Start P2P message handler
	if dhm.p2pPool != nil {
		dhm.setupP2PHandlers()
	}
	
	// Start history aggregation
	dhm.wg.Add(1)
	go dhm.historyAggregationLoop()
	
	dhm.logger.Info("Distributed hashrate monitor started")
}

// Stop stops the distributed hashrate monitor
func (dhm *DistributedHashrateMonitor) Stop() {
	dhm.cancel()
	dhm.wg.Wait()
	
	dhm.logger.Info("Distributed hashrate monitor stopped")
}

// UpdateLocalHashrate updates local hashrate
func (dhm *DistributedHashrateMonitor) UpdateLocalHashrate(hashrate uint64, workers int32) {
	dhm.localHashrate.Store(hashrate)
	dhm.localWorkers.Store(workers)
	
	// Update history
	dhm.history.Record(time.Now(), hashrate, dhm.totalHashrate.Load(), dhm.totalWorkers.Load())
}

// GetNetworkStats returns current network hashrate statistics
func (dhm *DistributedHashrateMonitor) GetNetworkStats() *NetworkHashrateStats {
	stats := &NetworkHashrateStats{
		Timestamp:      time.Now(),
		LocalHashrate:  dhm.localHashrate.Load(),
		LocalWorkers:   dhm.localWorkers.Load(),
		NetworkHashrate: dhm.totalHashrate.Load(),
		NetworkWorkers:  dhm.totalWorkers.Load(),
		PeerStats:      make([]PeerHashrate, 0),
		AlgorithmStats: make(map[string]*AlgorithmHashrate),
	}
	
	// Collect peer stats
	dhm.networkMu.RLock()
	for _, peer := range dhm.networkHashrate {
		if time.Since(peer.LastUpdate) < dhm.config.PeerTimeout {
			stats.PeerStats = append(stats.PeerStats, *peer)
			stats.ActivePeers++
			
			// Aggregate by algorithm
			if algo, exists := stats.AlgorithmStats[peer.Algorithm]; exists {
				algo.Hashrate += peer.Hashrate
				algo.Workers += peer.Workers
			} else {
				stats.AlgorithmStats[peer.Algorithm] = &AlgorithmHashrate{
					Algorithm: peer.Algorithm,
					Hashrate:  peer.Hashrate,
					Workers:   peer.Workers,
				}
			}
		}
	}
	dhm.networkMu.RUnlock()
	
	// Calculate efficiency
	if stats.NetworkHashrate > 0 {
		totalShares := uint64(0)
		totalLatency := time.Duration(0)
		
		for _, peer := range stats.PeerStats {
			totalShares += peer.SharesAccepted
			totalLatency += peer.Latency
		}
		
		if len(stats.PeerStats) > 0 {
			stats.AverageLatency = totalLatency / time.Duration(len(stats.PeerStats))
		}
		
		// Simple efficiency calculation
		stats.NetworkEfficiency = float64(totalShares) / float64(stats.NetworkHashrate) * 100
	}
	
	return stats
}

// GetHistory returns hashrate history
func (dhm *DistributedHashrateMonitor) GetHistory(duration time.Duration) *HashRateHistory {
	return dhm.history.GetRecent(duration)
}

// localUpdateLoop updates local hashrate metrics
func (dhm *DistributedHashrateMonitor) localUpdateLoop() {
	defer dhm.wg.Done()
	
	ticker := time.NewTicker(dhm.config.LocalUpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dhm.updateLocalMetrics()
			
		case <-dhm.ctx.Done():
			return
		}
	}
}

// updateLocalMetrics updates local metrics
func (dhm *DistributedHashrateMonitor) updateLocalMetrics() {
	// This would be called by the mining engine
	// For now, just update totals
	dhm.updateTotals()
}

// networkUpdateLoop updates network hashrate metrics
func (dhm *DistributedHashrateMonitor) networkUpdateLoop() {
	defer dhm.wg.Done()
	
	ticker := time.NewTicker(dhm.config.NetworkUpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dhm.cleanupStalePeripals()
			dhm.updateTotals()
			dhm.reportStats()
			
		case <-dhm.ctx.Done():
			return
		}
	}
}

// broadcastLoop broadcasts local hashrate to peers
func (dhm *DistributedHashrateMonitor) broadcastLoop() {
	defer dhm.wg.Done()
	
	ticker := time.NewTicker(dhm.config.BroadcastInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			dhm.broadcastHashrate()
			
		case <-dhm.ctx.Done():
			return
		}
	}
}

// broadcastHashrate broadcasts local hashrate to peers
func (dhm *DistributedHashrateMonitor) broadcastHashrate() {
	if dhm.p2pPool == nil {
		return
	}
	
	// Create hashrate message
	msg := &HashrateMessage{
		Type:      "hashrate_update",
		PeerID:    dhm.p2pPool.GetLocalPeerID(),
		Timestamp: time.Now(),
		Data: HashrateData{
			Hashrate:        dhm.localHashrate.Load(),
			Workers:         dhm.localWorkers.Load(),
			Algorithm:       "sha256d", // Get from mining engine
			SharesSubmitted: 0, // Get from mining engine
			SharesAccepted:  0, // Get from mining engine
			Difficulty:      0, // Get from mining engine
			Version:         "2.1.4",
		},
	}
	
	// Broadcast to all peers
	data, _ := json.Marshal(msg)
	dhm.p2pPool.Broadcast("hashrate", data)
}

// setupP2PHandlers sets up P2P message handlers
func (dhm *DistributedHashrateMonitor) setupP2PHandlers() {
	// Register hashrate message handler
	dhm.p2pPool.RegisterHandler("hashrate", dhm.handleHashrateMessage)
	
	// Register query handler
	dhm.p2pPool.RegisterHandler("hashrate_query", dhm.handleHashrateQuery)
}

// handleHashrateMessage handles incoming hashrate messages
func (dhm *DistributedHashrateMonitor) handleHashrateMessage(peerID string, data []byte) {
	var msg HashrateMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		dhm.logger.Error("Failed to unmarshal hashrate message",
			zap.String("peer", peerID),
			zap.Error(err),
		)
		return
	}
	
	// Update peer hashrate
	dhm.networkMu.Lock()
	dhm.networkHashrate[peerID] = &PeerHashrate{
		PeerID:          peerID,
		Hashrate:        msg.Data.Hashrate,
		Workers:         msg.Data.Workers,
		Algorithm:       msg.Data.Algorithm,
		LastUpdate:      msg.Timestamp,
		SharesSubmitted: msg.Data.SharesSubmitted,
		SharesAccepted:  msg.Data.SharesAccepted,
		Difficulty:      msg.Data.Difficulty,
		Latency:         time.Since(msg.Timestamp),
		Version:         msg.Data.Version,
	}
	dhm.networkMu.Unlock()
	
	// Update totals
	dhm.updateTotals()
}

// handleHashrateQuery handles hashrate query requests
func (dhm *DistributedHashrateMonitor) handleHashrateQuery(peerID string, data []byte) {
	// Respond with current stats
	stats := dhm.GetNetworkStats()
	response, _ := json.Marshal(stats)
	
	dhm.p2pPool.SendToPeer(peerID, "hashrate_response", response)
}

// cleanupStalePeripals removes stale peer data
func (dhm *DistributedHashrateMonitor) cleanupStalePeripals() {
	dhm.networkMu.Lock()
	defer dhm.networkMu.Unlock()
	
	cutoff := time.Now().Add(-dhm.config.PeerTimeout)
	
	for peerID, peer := range dhm.networkHashrate {
		if peer.LastUpdate.Before(cutoff) {
			delete(dhm.networkHashrate, peerID)
			dhm.logger.Debug("Removed stale peer",
				zap.String("peer", peerID),
				zap.Duration("age", time.Since(peer.LastUpdate)),
			)
		}
	}
}

// updateTotals updates total network hashrate
func (dhm *DistributedHashrateMonitor) updateTotals() {
	totalHashrate := dhm.localHashrate.Load()
	totalWorkers := dhm.localWorkers.Load()
	
	dhm.networkMu.RLock()
	for _, peer := range dhm.networkHashrate {
		if time.Since(peer.LastUpdate) < dhm.config.PeerTimeout {
			totalHashrate += peer.Hashrate
			totalWorkers += peer.Workers
		}
	}
	dhm.networkMu.RUnlock()
	
	dhm.totalHashrate.Store(totalHashrate)
	dhm.totalWorkers.Store(totalWorkers)
}

// reportStats reports statistics to registered reporters
func (dhm *DistributedHashrateMonitor) reportStats() {
	if len(dhm.reporters) == 0 {
		return
	}
	
	stats := dhm.GetNetworkStats()
	
	for _, reporter := range dhm.reporters {
		if err := reporter.Report(stats); err != nil {
			dhm.logger.Error("Failed to report stats",
				zap.String("reporter", reporter.Name()),
				zap.Error(err),
			)
		}
	}
}

// historyAggregationLoop aggregates historical data
func (dhm *DistributedHashrateMonitor) historyAggregationLoop() {
	defer dhm.wg.Done()
	
	// Aggregate hourly
	hourlyTicker := time.NewTicker(time.Hour)
	defer hourlyTicker.Stop()
	
	// Aggregate daily
	dailyTicker := time.NewTicker(24 * time.Hour)
	defer dailyTicker.Stop()
	
	for {
		select {
		case <-hourlyTicker.C:
			dhm.history.AggregateHourly()
			
		case <-dailyTicker.C:
			dhm.history.AggregateDaily()
			dhm.history.Cleanup()
			
		case <-dhm.ctx.Done():
			return
		}
	}
}

// HashRateHistory implementation

func NewHashRateHistory(retention time.Duration) *HashRateHistory {
	return &HashRateHistory{
		timestamps:     make([]time.Time, 0, 10000),
		localHashrates: make([]uint64, 0, 10000),
		totalHashrates: make([]uint64, 0, 10000),
		workerCounts:   make([]int32, 0, 10000),
		hourly:         make(map[time.Time]*AggregatedHashrate),
		daily:          make(map[time.Time]*AggregatedHashrate),
		maxEntries:     10000,
		retention:      retention,
	}
}

func (hrh *HashRateHistory) Record(timestamp time.Time, local, total uint64, workers int32) {
	hrh.mu.Lock()
	defer hrh.mu.Unlock()
	
	hrh.timestamps = append(hrh.timestamps, timestamp)
	hrh.localHashrates = append(hrh.localHashrates, local)
	hrh.totalHashrates = append(hrh.totalHashrates, total)
	hrh.workerCounts = append(hrh.workerCounts, workers)
	
	// Limit size
	if len(hrh.timestamps) > hrh.maxEntries {
		keep := len(hrh.timestamps) - hrh.maxEntries/2
		hrh.timestamps = hrh.timestamps[keep:]
		hrh.localHashrates = hrh.localHashrates[keep:]
		hrh.totalHashrates = hrh.totalHashrates[keep:]
		hrh.workerCounts = hrh.workerCounts[keep:]
	}
}

func (hrh *HashRateHistory) GetRecent(duration time.Duration) *HashRateHistory {
	hrh.mu.RLock()
	defer hrh.mu.RUnlock()
	
	cutoff := time.Now().Add(-duration)
	
	// Find start index
	startIdx := 0
	for i, ts := range hrh.timestamps {
		if ts.After(cutoff) {
			startIdx = i
			break
		}
	}
	
	// Create subset
	recent := &HashRateHistory{
		timestamps:     hrh.timestamps[startIdx:],
		localHashrates: hrh.localHashrates[startIdx:],
		totalHashrates: hrh.totalHashrates[startIdx:],
		workerCounts:   hrh.workerCounts[startIdx:],
		hourly:         make(map[time.Time]*AggregatedHashrate),
		daily:          make(map[time.Time]*AggregatedHashrate),
	}
	
	// Copy relevant aggregated data
	for ts, data := range hrh.hourly {
		if ts.After(cutoff) {
			recent.hourly[ts] = data
		}
	}
	
	for ts, data := range hrh.daily {
		if ts.After(cutoff) {
			recent.daily[ts] = data
		}
	}
	
	return recent
}

func (hrh *HashRateHistory) AggregateHourly() {
	hrh.mu.Lock()
	defer hrh.mu.Unlock()
	
	// Aggregate last hour
	now := time.Now()
	hourStart := now.Truncate(time.Hour).Add(-time.Hour)
	
	// Find data for the hour
	var hashrates []uint64
	var workers []int32
	
	for i, ts := range hrh.timestamps {
		if ts.After(hourStart) && ts.Before(hourStart.Add(time.Hour)) {
			hashrates = append(hashrates, hrh.totalHashrates[i])
			workers = append(workers, hrh.workerCounts[i])
		}
	}
	
	if len(hashrates) > 0 {
		agg := &AggregatedHashrate{
			Period:         hourStart,
			AvgHashrate:    calculateAverage(hashrates),
			MinHashrate:    findMin(hashrates),
			MaxHashrate:    findMax(hashrates),
			AvgWorkers:     int32(calculateAverageInt32(workers)),
			AlgorithmStats: make(map[string]*AlgorithmHashrate),
		}
		
		hrh.hourly[hourStart] = agg
	}
}

func (hrh *HashRateHistory) AggregateDaily() {
	hrh.mu.Lock()
	defer hrh.mu.Unlock()
	
	// Similar to hourly but for daily periods
}

func (hrh *HashRateHistory) Cleanup() {
	hrh.mu.Lock()
	defer hrh.mu.Unlock()
	
	cutoff := time.Now().Add(-hrh.retention)
	
	// Clean hourly data
	for ts := range hrh.hourly {
		if ts.Before(cutoff) {
			delete(hrh.hourly, ts)
		}
	}
	
	// Clean daily data
	for ts := range hrh.daily {
		if ts.Before(cutoff) {
			delete(hrh.daily, ts)
		}
	}
}

// Message structures

type HashrateMessage struct {
	Type      string       `json:"type"`
	PeerID    string       `json:"peer_id"`
	Timestamp time.Time    `json:"timestamp"`
	Data      HashrateData `json:"data"`
}

type HashrateData struct {
	Hashrate        uint64  `json:"hashrate"`
	Workers         int32   `json:"workers"`
	Algorithm       string  `json:"algorithm"`
	SharesSubmitted uint64  `json:"shares_submitted"`
	SharesAccepted  uint64  `json:"shares_accepted"`
	Difficulty      float64 `json:"difficulty"`
	Version         string  `json:"version"`
}

// HTTP Reporter implementation

type HTTPHashrateReporter struct {
	endpoint string
	client   *http.Client
}

func NewHTTPHashrateReporter(endpoint string) *HTTPHashrateReporter {
	return &HTTPHashrateReporter{
		endpoint: endpoint,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

func (hr *HTTPHashrateReporter) Name() string {
	return fmt.Sprintf("http:%s", hr.endpoint)
}

func (hr *HTTPHashrateReporter) Report(stats *NetworkHashrateStats) error {
	// Send stats to HTTP endpoint
	// This would POST JSON data to the endpoint
	return nil
}

// Helper functions

func calculateAverage(values []uint64) uint64 {
	if len(values) == 0 {
		return 0
	}
	
	sum := uint64(0)
	for _, v := range values {
		sum += v
	}
	
	return sum / uint64(len(values))
}

func calculateAverageInt32(values []int32) float64 {
	if len(values) == 0 {
		return 0
	}
	
	sum := int64(0)
	for _, v := range values {
		sum += int64(v)
	}
	
	return float64(sum) / float64(len(values))
}

func findMin(values []uint64) uint64 {
	if len(values) == 0 {
		return 0
	}
	
	min := values[0]
	for _, v := range values[1:] {
		if v < min {
			min = v
		}
	}
	
	return min
}

func findMax(values []uint64) uint64 {
	if len(values) == 0 {
		return 0
	}
	
	max := values[0]
	for _, v := range values[1:] {
		if v > max {
			max = v
		}
	}
	
	return max
}

// Stub import
import (
	"net/http"
)