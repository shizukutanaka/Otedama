package ledger

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// SyncManager handles ledger synchronization across the P2P network
type SyncManager struct {
	logger        *zap.Logger
	ledgerManager *LedgerManager
	nodeID        string
	
	// Sync state
	syncPeers     map[string]*SyncPeer
	syncInProgress bool
	lastSyncTime   time.Time
	syncInterval   time.Duration
	
	// Statistics
	syncCount      int
	syncErrors     int
	ledgersReceived int
	ledgersSent     int
	
	mu sync.RWMutex
	
	// Callbacks
	onSyncComplete func(peersSync int, ledgersReceived int)
	sendMessage    func(peerID string, message []byte) error
}

// SyncPeer represents a peer in the sync process
type SyncPeer struct {
	PeerID       string
	LastHeight   uint64
	LastSyncTime time.Time
	SyncErrors   int
	TrustScore   float64
}

// SyncConfig contains sync manager configuration
type SyncConfig struct {
	SyncInterval   time.Duration `yaml:"sync_interval"`
	MaxSyncPeers   int           `yaml:"max_sync_peers"`
	SyncBatchSize  int           `yaml:"sync_batch_size"`
	RetryAttempts  int           `yaml:"retry_attempts"`
}

// NewSyncManager creates a new sync manager
func NewSyncManager(logger *zap.Logger, ledgerManager *LedgerManager, nodeID string, config SyncConfig) *SyncManager {
	// Set defaults
	if config.SyncInterval <= 0 {
		config.SyncInterval = 5 * time.Minute
	}
	if config.MaxSyncPeers <= 0 {
		config.MaxSyncPeers = 10
	}
	if config.SyncBatchSize <= 0 {
		config.SyncBatchSize = 100
	}
	
	return &SyncManager{
		logger:        logger,
		ledgerManager: ledgerManager,
		nodeID:        nodeID,
		syncPeers:     make(map[string]*SyncPeer),
		syncInterval:  config.SyncInterval,
	}
}

// StartSync begins the synchronization process
func (sm *SyncManager) StartSync() error {
	sm.mu.Lock()
	if sm.syncInProgress {
		sm.mu.Unlock()
		return fmt.Errorf("sync already in progress")
	}
	sm.syncInProgress = true
	sm.mu.Unlock()
	
	defer func() {
		sm.mu.Lock()
		sm.syncInProgress = false
		sm.lastSyncTime = time.Now()
		sm.mu.Unlock()
	}()
	
	sm.logger.Info("Starting ledger synchronization")
	
	// Get list of peers to sync with
	peers := sm.getActivePeers()
	if len(peers) == 0 {
		return fmt.Errorf("no peers available for sync")
	}
	
	// Request ledgers from each peer
	var wg sync.WaitGroup
	ledgersReceived := 0
	successfulPeers := 0
	
	for _, peer := range peers {
		wg.Add(1)
		go func(p *SyncPeer) {
			defer wg.Done()
			
			count, err := sm.syncWithPeer(p)
			if err != nil {
				sm.logger.Error("Failed to sync with peer",
					zap.String("peer_id", p.PeerID),
					zap.Error(err),
				)
				p.SyncErrors++
			} else {
				ledgersReceived += count
				successfulPeers++
				p.LastSyncTime = time.Now()
			}
		}(peer)
	}
	
	wg.Wait()
	
	// Update statistics
	sm.mu.Lock()
	sm.syncCount++
	sm.ledgersReceived += ledgersReceived
	sm.mu.Unlock()
	
	// Notify callback
	if sm.onSyncComplete != nil {
		sm.onSyncComplete(successfulPeers, ledgersReceived)
	}
	
	sm.logger.Info("Ledger synchronization completed",
		zap.Int("peers_synced", successfulPeers),
		zap.Int("ledgers_received", ledgersReceived),
	)
	
	return nil
}

// syncWithPeer synchronizes ledgers with a specific peer
func (sm *SyncManager) syncWithPeer(peer *SyncPeer) (int, error) {
	// Get our latest height
	latestHeight := sm.getLatestHeight()
	
	// Request ledgers from peer
	request := &SyncRequest{
		Type:       "sync_request",
		NodeID:     sm.nodeID,
		FromHeight: peer.LastHeight + 1,
		ToHeight:   latestHeight + 1000, // Request ahead
		Timestamp:  time.Now(),
	}
	
	requestData, err := json.Marshal(request)
	if err != nil {
		return 0, err
	}
	
	// Send request to peer
	if err := sm.sendMessage(peer.PeerID, requestData); err != nil {
		return 0, fmt.Errorf("failed to send sync request: %w", err)
	}
	
	// In a real implementation, we would wait for response
	// For now, return success
	return 0, nil
}

// HandleSyncRequest processes a sync request from a peer
func (sm *SyncManager) HandleSyncRequest(request *SyncRequest, peerID string) error {
	sm.logger.Debug("Handling sync request",
		zap.String("peer_id", peerID),
		zap.Uint64("from_height", request.FromHeight),
		zap.Uint64("to_height", request.ToHeight),
	)
	
	// Get requested ledgers
	ledgers := sm.getLedgerRange(request.FromHeight, request.ToHeight)
	
	// Create response
	response := &SyncResponse{
		Type:      "sync_response",
		NodeID:    sm.nodeID,
		Ledgers:   ledgers,
		Timestamp: time.Now(),
	}
	
	responseData, err := json.Marshal(response)
	if err != nil {
		return err
	}
	
	// Send response
	if err := sm.sendMessage(peerID, responseData); err != nil {
		return fmt.Errorf("failed to send sync response: %w", err)
	}
	
	// Update statistics
	sm.mu.Lock()
	sm.ledgersSent += len(ledgers)
	sm.mu.Unlock()
	
	return nil
}

// HandleSyncResponse processes a sync response from a peer
func (sm *SyncManager) HandleSyncResponse(response *SyncResponse, peerID string) error {
	sm.logger.Debug("Handling sync response",
		zap.String("peer_id", peerID),
		zap.Int("ledger_count", len(response.Ledgers)),
	)
	
	// Process each ledger
	for _, ledger := range response.Ledgers {
		if err := sm.ledgerManager.ReceiveLedger(ledger, peerID); err != nil {
			sm.logger.Warn("Failed to process ledger",
				zap.String("block_hash", ledger.BlockHash),
				zap.Error(err),
			)
		}
	}
	
	// Update peer info
	sm.mu.Lock()
	if peer, exists := sm.syncPeers[peerID]; exists {
		if len(response.Ledgers) > 0 {
			lastLedger := response.Ledgers[len(response.Ledgers)-1]
			peer.LastHeight = lastLedger.BlockHeight
		}
	}
	sm.mu.Unlock()
	
	return nil
}

// AddPeer adds a peer to the sync manager
func (sm *SyncManager) AddPeer(peerID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	if _, exists := sm.syncPeers[peerID]; !exists {
		sm.syncPeers[peerID] = &SyncPeer{
			PeerID:     peerID,
			TrustScore: 0.5, // Start with neutral trust
		}
	}
}

// RemovePeer removes a peer from the sync manager
func (sm *SyncManager) RemovePeer(peerID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	delete(sm.syncPeers, peerID)
}

// SetSendMessage sets the message sending callback
func (sm *SyncManager) SetSendMessage(callback func(peerID string, message []byte) error) {
	sm.sendMessage = callback
}

// SetOnSyncComplete sets the sync completion callback
func (sm *SyncManager) SetOnSyncComplete(callback func(peersSync int, ledgersReceived int)) {
	sm.onSyncComplete = callback
}

// GetStatistics returns sync manager statistics
func (sm *SyncManager) GetStatistics() map[string]interface{} {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	return map[string]interface{}{
		"sync_count":       sm.syncCount,
		"sync_errors":      sm.syncErrors,
		"ledgers_received": sm.ledgersReceived,
		"ledgers_sent":     sm.ledgersSent,
		"active_peers":     len(sm.syncPeers),
		"last_sync_time":   sm.lastSyncTime,
	}
}

// Private methods

// getActivePeers returns a list of active peers for syncing
func (sm *SyncManager) getActivePeers() []*SyncPeer {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	peers := make([]*SyncPeer, 0, len(sm.syncPeers))
	for _, peer := range sm.syncPeers {
		// Skip peers with too many errors
		if peer.SyncErrors < 5 {
			peers = append(peers, peer)
		}
	}
	
	return peers
}

// getLatestHeight returns the latest block height we have
func (sm *SyncManager) getLatestHeight() uint64 {
	stats := sm.ledgerManager.GetStatistics()
	if blocks, ok := stats["total_blocks"].(uint64); ok {
		return blocks
	}
	return 0
}

// getLedgerRange returns ledgers in the specified height range
func (sm *SyncManager) getLedgerRange(fromHeight, toHeight uint64) []*RewardLedger {
	var ledgers []*RewardLedger
	
	for height := fromHeight; height <= toHeight; height++ {
		if ledger, err := sm.ledgerManager.GetLedgerByHeight(height); err == nil {
			ledgers = append(ledgers, ledger)
		}
		
		// Limit batch size
		if len(ledgers) >= 100 {
			break
		}
	}
	
	return ledgers
}

// SyncRequest represents a ledger sync request
type SyncRequest struct {
	Type       string    `json:"type"`
	NodeID     string    `json:"node_id"`
	FromHeight uint64    `json:"from_height"`
	ToHeight   uint64    `json:"to_height"`
	Timestamp  time.Time `json:"timestamp"`
}

// SyncResponse represents a ledger sync response
type SyncResponse struct {
	Type      string          `json:"type"`
	NodeID    string          `json:"node_id"`
	Ledgers   []*RewardLedger `json:"ledgers"`
	Timestamp time.Time       `json:"timestamp"`
}

// AutoSync provides automatic periodic synchronization
type AutoSync struct {
	manager      *SyncManager
	logger       *zap.Logger
	interval     time.Duration
	stopChan     chan struct{}
	running      bool
	mu           sync.Mutex
}

// NewAutoSync creates a new auto sync instance
func NewAutoSync(manager *SyncManager, logger *zap.Logger, interval time.Duration) *AutoSync {
	return &AutoSync{
		manager:  manager,
		logger:   logger,
		interval: interval,
		stopChan: make(chan struct{}),
	}
}

// Start begins automatic synchronization
func (as *AutoSync) Start() error {
	as.mu.Lock()
	if as.running {
		as.mu.Unlock()
		return fmt.Errorf("auto sync already running")
	}
	as.running = true
	as.mu.Unlock()
	
	go as.syncLoop()
	
	as.logger.Info("Started automatic ledger synchronization",
		zap.Duration("interval", as.interval),
	)
	
	return nil
}

// Stop stops automatic synchronization
func (as *AutoSync) Stop() {
	as.mu.Lock()
	if !as.running {
		as.mu.Unlock()
		return
	}
	as.running = false
	as.mu.Unlock()
	
	close(as.stopChan)
	as.logger.Info("Stopped automatic ledger synchronization")
}

// syncLoop runs the automatic sync loop
func (as *AutoSync) syncLoop() {
	ticker := time.NewTicker(as.interval)
	defer ticker.Stop()
	
	// Initial sync
	if err := as.manager.StartSync(); err != nil {
		as.logger.Error("Initial sync failed", zap.Error(err))
	}
	
	for {
		select {
		case <-ticker.C:
			if err := as.manager.StartSync(); err != nil {
				as.logger.Error("Automatic sync failed", zap.Error(err))
			}
		case <-as.stopChan:
			return
		}
	}
}