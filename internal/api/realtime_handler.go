package api

import (
	"context"
	"encoding/json"
	"encoding/hex"
	"net/http"
	"sync"
	"time"

	"github.com/shizukutanaka/Otedama/internal/mining"
	"github.com/shizukutanaka/Otedama/internal/p2p"
	"go.uber.org/zap"
)

// RealtimeHandler manages real-time updates for WebSocket clients
// Robert C. Martin's clean architecture with dependency injection
type RealtimeHandler struct {
	logger      *zap.Logger
	hub         *WebSocketHub
	
	// Data sources
	miningEngine mining.Engine
	p2pPool      *p2p.Pool
	
	// Update intervals
	updateIntervals map[MessageType]time.Duration
	
	// Lifecycle
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
}

// RealtimeConfig contains realtime handler configuration
type RealtimeConfig struct {
	// Update intervals
	HashRateInterval   time.Duration `json:"hashrate_interval"`
	StatsInterval      time.Duration `json:"stats_interval"`
	WorkerInterval     time.Duration `json:"worker_interval"`
	
	// Feature flags
	EnableHashRate     bool          `json:"enable_hashrate"`
	EnableShares       bool          `json:"enable_shares"`
	EnableBlocks       bool          `json:"enable_blocks"`
	EnableStats        bool          `json:"enable_stats"`
	EnableDifficulty   bool          `json:"enable_difficulty"`
}

// NewRealtimeHandler creates a new realtime handler
func NewRealtimeHandler(logger *zap.Logger, hub *WebSocketHub, engine mining.Engine, pool *p2p.Pool) *RealtimeHandler {
	ctx, cancel := context.WithCancel(context.Background())
	
	handler := &RealtimeHandler{
		logger:       logger,
		hub:          hub,
		miningEngine: engine,
		p2pPool:      pool,
		updateIntervals: map[MessageType]time.Duration{
			MessageTypeHashRate:    1 * time.Second,
			MessageTypePoolStats:   5 * time.Second,
			MessageTypeSystemStats: 10 * time.Second,
			MessageTypeWorkerStats: 5 * time.Second,
		},
		ctx:    ctx,
		cancel: cancel,
	}
	
	return handler
}

// Start starts the realtime handler
func (rh *RealtimeHandler) Start() {
	// Start update workers
	for msgType, interval := range rh.updateIntervals {
		rh.wg.Add(1)
		go rh.updateWorker(msgType, interval)
	}
	
	// Start event listeners
	rh.setupEventListeners()
	
	rh.logger.Info("Realtime handler started")
}

// Stop stops the realtime handler
func (rh *RealtimeHandler) Stop() {
	rh.cancel()
	rh.wg.Wait()
	
	rh.logger.Info("Realtime handler stopped")
}

// updateWorker sends periodic updates
func (rh *RealtimeHandler) updateWorker(msgType MessageType, interval time.Duration) {
	defer rh.wg.Done()
	
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			rh.sendUpdate(msgType)
			
		case <-rh.ctx.Done():
			return
		}
	}
}

// sendUpdate sends an update based on message type
func (rh *RealtimeHandler) sendUpdate(msgType MessageType) {
	switch msgType {
	case MessageTypeHashRate:
		rh.sendHashRateUpdate()
		
	case MessageTypePoolStats:
		rh.sendPoolStatsUpdate()
		
	case MessageTypeSystemStats:
		rh.sendSystemStatsUpdate()
		
	case MessageTypeWorkerStats:
		rh.sendWorkerStatsUpdate()
	}
}

// sendHashRateUpdate sends hashrate update
func (rh *RealtimeHandler) sendHashRateUpdate() {
	if rh.miningEngine == nil {
		return
	}
	
	stats := rh.miningEngine.GetStats()
	
	update := HashRateUpdate{
		Total:   stats.TotalHashRate,
		Workers: make(map[string]uint64),
		Average: stats.TotalHashRate,
	}
	
	// Add worker hashrates
	update.Workers["cpu"] = stats.CPUHashRate
	update.Workers["gpu"] = stats.GPUHashRate
	update.Workers["asic"] = stats.ASICHashRate
	
	rh.hub.BroadcastHashRate(update)
}

// sendPoolStatsUpdate sends pool statistics update
func (rh *RealtimeHandler) sendPoolStatsUpdate() {
	if rh.p2pPool == nil {
		return
	}
	
	// Get pool stats
	totalShares := rh.p2pPool.totalShares.Load()
	validShares := rh.p2pPool.validShares.Load()
	peerCount := rh.p2pPool.peerCount.Load()
	
	update := PoolStatsUpdate{
		TotalShares:   totalShares,
		ValidShares:   validShares,
		InvalidShares: totalShares - validShares,
		ActiveMiners:  int(peerCount),
		Difficulty:    rh.getDifficulty(),
		LastBlockTime: rh.getLastBlockTime(),
	}
	
	data, _ := json.Marshal(update)
	rh.hub.broadcast <- Message{
		Type:      MessageTypePoolStats,
		Data:      data,
		Timestamp: time.Now().Unix(),
	}
}

// sendSystemStatsUpdate sends system statistics update
func (rh *RealtimeHandler) sendSystemStatsUpdate() {
	update := SystemStatsUpdate{
		CPUUsage:    rh.getCPUUsage(),
		MemoryUsage: rh.getMemoryUsage(),
		DiskUsage:   rh.getDiskUsage(),
		NetworkIO:   rh.getNetworkIO(),
		Uptime:      rh.getUptime(),
	}
	
	data, _ := json.Marshal(update)
	rh.hub.broadcast <- Message{
		Type:      MessageTypeSystemStats,
		Data:      data,
		Timestamp: time.Now().Unix(),
	}
}

// sendWorkerStatsUpdate sends worker statistics update
func (rh *RealtimeHandler) sendWorkerStatsUpdate() {
	workers := rh.getWorkerStats()
	
	update := WorkerStatsUpdate{
		Workers: workers,
		Total:   len(workers),
		Active:  rh.getActiveWorkerCount(workers),
	}
	
	data, _ := json.Marshal(update)
	rh.hub.broadcast <- Message{
		Type:      MessageTypeWorkerStats,
		Data:      data,
		Timestamp: time.Now().Unix(),
	}
}

// setupEventListeners sets up event listeners
func (rh *RealtimeHandler) setupEventListeners() {
	// Share submission callback
	if rh.miningEngine != nil {
		rh.setupMiningCallbacks()
	}
	
	// P2P events
	if rh.p2pPool != nil {
		rh.setupP2PCallbacks()
	}
}

// setupMiningCallbacks sets up mining engine callbacks
func (rh *RealtimeHandler) setupMiningCallbacks() {
	// This would be implemented based on actual mining engine interface
	// For example:
	// rh.miningEngine.OnShareSubmitted(rh.handleShareSubmitted)
	// rh.miningEngine.OnBlockFound(rh.handleBlockFound)
}

// setupP2PCallbacks sets up P2P pool callbacks
func (rh *RealtimeHandler) setupP2PCallbacks() {
	// This would be implemented based on actual P2P pool interface
	// For example:
	// rh.p2pPool.OnPeerConnected(rh.handlePeerConnected)
	// rh.p2pPool.OnShareReceived(rh.handleShareReceived)
}

// Event handlers

// handleShareSubmitted handles share submission events
func (rh *RealtimeHandler) handleShareSubmitted(share *mining.Share) {
	update := ShareUpdate{
		ShareID:    share.ID,
		WorkerID:   share.WorkerID,
		Difficulty: share.Difficulty,
		Valid:      share.Valid,
		Hash:       hex.EncodeToString(share.Hash[:]),
	}
	
	rh.hub.BroadcastShare(update)
}

// handleBlockFound handles block found events
func (rh *RealtimeHandler) handleBlockFound(block *BlockInfo) {
	update := BlockUpdate{
		Height:     block.Height,
		Hash:       block.Hash,
		Reward:     block.Reward,
		Difficulty: block.Difficulty,
		FoundBy:    block.FoundBy,
	}
	
	rh.hub.BroadcastBlock(update)
}

// Helper methods

func (rh *RealtimeHandler) getDifficulty() float64 {
	// Get current network difficulty
	return 1000000.0 // Placeholder
}

func (rh *RealtimeHandler) getLastBlockTime() int64 {
	// Get last block timestamp
	return time.Now().Add(-10 * time.Minute).Unix()
}

func (rh *RealtimeHandler) getCPUUsage() float64 {
	// Get CPU usage percentage
	return 45.5 // Placeholder
}

func (rh *RealtimeHandler) getMemoryUsage() MemoryUsage {
	return MemoryUsage{
		Total: 16 * 1024 * 1024 * 1024, // 16GB
		Used:  8 * 1024 * 1024 * 1024,  // 8GB
		Free:  8 * 1024 * 1024 * 1024,  // 8GB
	}
}

func (rh *RealtimeHandler) getDiskUsage() DiskUsage {
	return DiskUsage{
		Total: 1024 * 1024 * 1024 * 1024, // 1TB
		Used:  512 * 1024 * 1024 * 1024,  // 512GB
		Free:  512 * 1024 * 1024 * 1024,  // 512GB
	}
}

func (rh *RealtimeHandler) getNetworkIO() NetworkIO {
	return NetworkIO{
		BytesIn:  1024 * 1024 * 100, // 100MB
		BytesOut: 1024 * 1024 * 200, // 200MB
		PacketsIn: 1000000,
		PacketsOut: 2000000,
	}
}

func (rh *RealtimeHandler) getUptime() int64 {
	// Return uptime in seconds
	return int64(time.Since(time.Now().Add(-24 * time.Hour)).Seconds())
}

func (rh *RealtimeHandler) getWorkerStats() []WorkerInfo {
	// Get worker statistics
	return []WorkerInfo{
		{
			ID:       "worker-1",
			Name:     "GPU-Worker-1",
			Type:     "GPU",
			HashRate: 500000000, // 500 MH/s
			Shares:   1000,
			Valid:    950,
			Invalid:  50,
			LastSeen: time.Now().Unix(),
		},
		{
			ID:       "worker-2",
			Name:     "CPU-Worker-1",
			Type:     "CPU",
			HashRate: 1000000, // 1 MH/s
			Shares:   100,
			Valid:    98,
			Invalid:  2,
			LastSeen: time.Now().Unix(),
		},
	}
}

func (rh *RealtimeHandler) getActiveWorkerCount(workers []WorkerInfo) int {
	count := 0
	threshold := time.Now().Add(-5 * time.Minute).Unix()
	
	for _, worker := range workers {
		if worker.LastSeen > threshold {
			count++
		}
	}
	
	return count
}

// Update structures

// PoolStatsUpdate represents pool statistics update
type PoolStatsUpdate struct {
	TotalShares   uint64  `json:"total_shares"`
	ValidShares   uint64  `json:"valid_shares"`
	InvalidShares uint64  `json:"invalid_shares"`
	ActiveMiners  int     `json:"active_miners"`
	Difficulty    float64 `json:"difficulty"`
	LastBlockTime int64   `json:"last_block_time"`
}

// SystemStatsUpdate represents system statistics update
type SystemStatsUpdate struct {
	CPUUsage    float64     `json:"cpu_usage"`
	MemoryUsage MemoryUsage `json:"memory_usage"`
	DiskUsage   DiskUsage   `json:"disk_usage"`
	NetworkIO   NetworkIO   `json:"network_io"`
	Uptime      int64       `json:"uptime"`
}

// WorkerStatsUpdate represents worker statistics update
type WorkerStatsUpdate struct {
	Workers []WorkerInfo `json:"workers"`
	Total   int          `json:"total"`
	Active  int          `json:"active"`
}

// Supporting structures

// MemoryUsage represents memory usage
type MemoryUsage struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}

// DiskUsage represents disk usage
type DiskUsage struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
	Free  uint64 `json:"free"`
}

// NetworkIO represents network I/O stats
type NetworkIO struct {
	BytesIn    uint64 `json:"bytes_in"`
	BytesOut   uint64 `json:"bytes_out"`
	PacketsIn  uint64 `json:"packets_in"`
	PacketsOut uint64 `json:"packets_out"`
}

// WorkerInfo represents worker information
type WorkerInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	HashRate uint64 `json:"hashrate"`
	Shares   uint64 `json:"shares"`
	Valid    uint64 `json:"valid"`
	Invalid  uint64 `json:"invalid"`
	LastSeen int64  `json:"last_seen"`
}

// BlockInfo represents block information
type BlockInfo struct {
	Height     uint64  `json:"height"`
	Hash       string  `json:"hash"`
	Reward     float64 `json:"reward"`
	Difficulty float64 `json:"difficulty"`
	FoundBy    string  `json:"found_by"`
}

// HTTP handlers

// HandleWebSocket handles WebSocket upgrade requests
func (rh *RealtimeHandler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	rh.hub.ServeWS(w, r)
}

// HandleStats handles stats API requests
func (rh *RealtimeHandler) HandleStats(w http.ResponseWriter, r *http.Request) {
	stats := map[string]interface{}{
		"websocket": rh.hub.GetStats(),
		"mining":    rh.miningEngine.GetStats(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}