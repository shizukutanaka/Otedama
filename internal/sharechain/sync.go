package sharechain

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
)

// SyncManager handles sharechain synchronization with peers
type SyncManager struct {
	logger     *zap.Logger
	sharechain *Sharechain
	nodeID     string
	
	// Sync state
	syncPeers    map[string]*SyncPeer
	syncInProgress bool
	lastSyncTime   time.Time
	
	// Configuration
	syncInterval   time.Duration
	batchSize      int
	maxPeers       int
	
	// Statistics
	syncCount      int
	blocksReceived int
	blocksSent     int
	syncErrors     int
	
	mu sync.RWMutex
	
	// Callbacks
	onSyncComplete func(peersSync int, blocksReceived int)
	requestBlocks  func(peerID string, fromHeight, toHeight uint64) error
	sendBlocks     func(peerID string, blocks []*SharechainBlock) error
}

// SyncPeer represents a peer in the sync process
type SyncPeer struct {
	PeerID       string
	Height       uint64
	LastHash     string
	LastSyncTime time.Time
	SyncErrors   int
	Syncing      bool
}

// SyncConfig contains sync manager configuration
type SyncConfig struct {
	SyncInterval time.Duration `yaml:"sync_interval"`
	BatchSize    int           `yaml:"batch_size"`
	MaxPeers     int           `yaml:"max_peers"`
}

// NewSyncManager creates a new sync manager
func NewSyncManager(logger *zap.Logger, sharechain *Sharechain, nodeID string, config SyncConfig) *SyncManager {
	// Set defaults
	if config.SyncInterval <= 0 {
		config.SyncInterval = 30 * time.Second
	}
	if config.BatchSize <= 0 {
		config.BatchSize = 100
	}
	if config.MaxPeers <= 0 {
		config.MaxPeers = 10
	}
	
	return &SyncManager{
		logger:       logger,
		sharechain:   sharechain,
		nodeID:       nodeID,
		syncPeers:    make(map[string]*SyncPeer),
		syncInterval: config.SyncInterval,
		batchSize:    config.BatchSize,
		maxPeers:     config.MaxPeers,
	}
}

// Start starts the sync manager
func (sm *SyncManager) Start(ctx context.Context) {
	// Start sync loop
	go sm.syncLoop(ctx)
	
	sm.logger.Info("Sharechain sync manager started",
		zap.Duration("sync_interval", sm.syncInterval),
	)
}

// AddPeer adds a peer for synchronization
func (sm *SyncManager) AddPeer(peerID string, height uint64, lastHash string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	if _, exists := sm.syncPeers[peerID]; exists {
		// Update existing peer
		sm.syncPeers[peerID].Height = height
		sm.syncPeers[peerID].LastHash = lastHash
	} else {
		// Add new peer
		sm.syncPeers[peerID] = &SyncPeer{
			PeerID:   peerID,
			Height:   height,
			LastHash: lastHash,
		}
	}
	
	sm.logger.Debug("Added sync peer",
		zap.String("peer_id", peerID),
		zap.Uint64("height", height),
	)
}

// RemovePeer removes a peer from synchronization
func (sm *SyncManager) RemovePeer(peerID string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	delete(sm.syncPeers, peerID)
}

// HandleBlocksRequest handles a request for blocks from a peer
func (sm *SyncManager) HandleBlocksRequest(peerID string, fromHeight, toHeight uint64) error {
	sm.logger.Debug("Handling blocks request",
		zap.String("peer_id", peerID),
		zap.Uint64("from_height", fromHeight),
		zap.Uint64("to_height", toHeight),
	)
	
	// Limit batch size
	if toHeight-fromHeight > uint64(sm.batchSize) {
		toHeight = fromHeight + uint64(sm.batchSize)
	}
	
	// Get blocks
	blocks := make([]*SharechainBlock, 0, toHeight-fromHeight)
	for height := fromHeight; height <= toHeight; height++ {
		block, err := sm.sharechain.GetBlock(height)
		if err != nil {
			break // No more blocks
		}
		blocks = append(blocks, block)
	}
	
	if len(blocks) == 0 {
		return fmt.Errorf("no blocks found in range %d-%d", fromHeight, toHeight)
	}
	
	// Send blocks to peer
	if sm.sendBlocks != nil {
		if err := sm.sendBlocks(peerID, blocks); err != nil {
			return fmt.Errorf("failed to send blocks: %w", err)
		}
	}
	
	sm.mu.Lock()
	sm.blocksSent += len(blocks)
	sm.mu.Unlock()
	
	return nil
}

// HandleBlocksResponse handles blocks received from a peer
func (sm *SyncManager) HandleBlocksResponse(peerID string, blocks []*SharechainBlock) error {
	sm.logger.Debug("Handling blocks response",
		zap.String("peer_id", peerID),
		zap.Int("block_count", len(blocks)),
	)
	
	// Sync with sharechain
	if err := sm.sharechain.SyncWith(blocks); err != nil {
		sm.mu.Lock()
		sm.syncErrors++
		if peer, exists := sm.syncPeers[peerID]; exists {
			peer.SyncErrors++
		}
		sm.mu.Unlock()
		
		return fmt.Errorf("failed to sync blocks: %w", err)
	}
	
	sm.mu.Lock()
	sm.blocksReceived += len(blocks)
	if peer, exists := sm.syncPeers[peerID]; exists {
		peer.LastSyncTime = time.Now()
		peer.Syncing = false
		
		// Update peer height if we got blocks
		if len(blocks) > 0 {
			lastBlock := blocks[len(blocks)-1]
			peer.Height = lastBlock.Height
			peer.LastHash = lastBlock.Hash
		}
	}
	sm.mu.Unlock()
	
	return nil
}

// GetSyncStatus returns the current sync status
func (sm *SyncManager) GetSyncStatus() map[string]interface{} {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	localHeight := sm.sharechain.GetCurrentHeight()
	
	// Find highest peer
	highestPeer := uint64(0)
	activePeers := 0
	for _, peer := range sm.syncPeers {
		if peer.Height > highestPeer {
			highestPeer = peer.Height
		}
		if time.Since(peer.LastSyncTime) < 5*time.Minute {
			activePeers++
		}
	}
	
	synced := localHeight >= highestPeer
	
	return map[string]interface{}{
		"synced":          synced,
		"local_height":    localHeight,
		"highest_peer":    highestPeer,
		"active_peers":    activePeers,
		"total_peers":     len(sm.syncPeers),
		"sync_count":      sm.syncCount,
		"blocks_received": sm.blocksReceived,
		"blocks_sent":     sm.blocksSent,
		"sync_errors":     sm.syncErrors,
		"last_sync_time":  sm.lastSyncTime,
	}
}

// SetRequestBlocks sets the block request callback
func (sm *SyncManager) SetRequestBlocks(callback func(peerID string, fromHeight, toHeight uint64) error) {
	sm.requestBlocks = callback
}

// SetSendBlocks sets the block sending callback
func (sm *SyncManager) SetSendBlocks(callback func(peerID string, blocks []*SharechainBlock) error) {
	sm.sendBlocks = callback
}

// SetOnSyncComplete sets the sync completion callback
func (sm *SyncManager) SetOnSyncComplete(callback func(peersSync int, blocksReceived int)) {
	sm.onSyncComplete = callback
}

// Private methods

// syncLoop periodically syncs with peers
func (sm *SyncManager) syncLoop(ctx context.Context) {
	ticker := time.NewTicker(sm.syncInterval)
	defer ticker.Stop()
	
	// Initial sync
	sm.syncWithPeers()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sm.syncWithPeers()
		}
	}
}

// syncWithPeers syncs with all peers
func (sm *SyncManager) syncWithPeers() {
	sm.mu.Lock()
	if sm.syncInProgress {
		sm.mu.Unlock()
		return
	}
	sm.syncInProgress = true
	sm.mu.Unlock()
	
	defer func() {
		sm.mu.Lock()
		sm.syncInProgress = false
		sm.lastSyncTime = time.Now()
		sm.mu.Unlock()
	}()
	
	// Get current height
	localHeight := sm.sharechain.GetCurrentHeight()
	
	// Get peers to sync with
	peers := sm.getPeersToSync(localHeight)
	if len(peers) == 0 {
		return
	}
	
	sm.logger.Debug("Starting sharechain sync",
		zap.Int("peer_count", len(peers)),
		zap.Uint64("local_height", localHeight),
	)
	
	// Sync with each peer
	var wg sync.WaitGroup
	blocksReceived := 0
	successfulPeers := 0
	
	for _, peer := range peers {
		wg.Add(1)
		go func(p *SyncPeer) {
			defer wg.Done()
			
			count, err := sm.syncWithPeer(p, localHeight)
			if err != nil {
				sm.logger.Debug("Failed to sync with peer",
					zap.String("peer_id", p.PeerID),
					zap.Error(err),
				)
			} else {
				blocksReceived += count
				successfulPeers++
			}
		}(peer)
	}
	
	wg.Wait()
	
	sm.mu.Lock()
	sm.syncCount++
	sm.mu.Unlock()
	
	// Notify callback
	if sm.onSyncComplete != nil && blocksReceived > 0 {
		sm.onSyncComplete(successfulPeers, blocksReceived)
	}
	
	if blocksReceived > 0 {
		sm.logger.Info("Sharechain sync completed",
			zap.Int("blocks_received", blocksReceived),
			zap.Int("peers_synced", successfulPeers),
		)
	}
}

// getPeersToSync returns peers that need syncing
func (sm *SyncManager) getPeersToSync(localHeight uint64) []*SyncPeer {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	
	peers := make([]*SyncPeer, 0, len(sm.syncPeers))
	
	for _, peer := range sm.syncPeers {
		// Skip if already syncing
		if peer.Syncing {
			continue
		}
		
		// Skip if too many errors
		if peer.SyncErrors >= 5 {
			continue
		}
		
		// Skip if peer is behind us
		if peer.Height <= localHeight {
			continue
		}
		
		peers = append(peers, peer)
		
		// Limit number of peers
		if len(peers) >= sm.maxPeers {
			break
		}
	}
	
	return peers
}

// syncWithPeer syncs with a specific peer
func (sm *SyncManager) syncWithPeer(peer *SyncPeer, localHeight uint64) (int, error) {
	sm.mu.Lock()
	peer.Syncing = true
	sm.mu.Unlock()
	
	defer func() {
		sm.mu.Lock()
		peer.Syncing = false
		sm.mu.Unlock()
	}()
	
	// Request blocks from peer
	fromHeight := localHeight + 1
	toHeight := peer.Height
	
	// Limit batch size
	if toHeight-fromHeight > uint64(sm.batchSize) {
		toHeight = fromHeight + uint64(sm.batchSize)
	}
	
	if sm.requestBlocks != nil {
		if err := sm.requestBlocks(peer.PeerID, fromHeight, toHeight); err != nil {
			sm.mu.Lock()
			peer.SyncErrors++
			sm.mu.Unlock()
			return 0, err
		}
	}
	
	// In a real implementation, we would wait for the response
	// For now, return success
	return 0, nil
}

// SharechainMessage represents a sharechain protocol message
type SharechainMessage struct {
	Type      string          `json:"type"`
	PeerID    string          `json:"peer_id"`
	Height    uint64          `json:"height"`
	LastHash  string          `json:"last_hash"`
	Blocks    json.RawMessage `json:"blocks,omitempty"`
	FromHeight uint64         `json:"from_height,omitempty"`
	ToHeight   uint64         `json:"to_height,omitempty"`
}

// MessageType constants
const (
	MessageTypeStatus        = "status"
	MessageTypeBlocksRequest = "blocks_request"
	MessageTypeBlocksResponse = "blocks_response"
	MessageTypeNewBlock      = "new_block"
)

// CreateStatusMessage creates a status message
func CreateStatusMessage(nodeID string, height uint64, lastHash string) *SharechainMessage {
	return &SharechainMessage{
		Type:     MessageTypeStatus,
		PeerID:   nodeID,
		Height:   height,
		LastHash: lastHash,
	}
}

// CreateBlocksRequest creates a blocks request message
func CreateBlocksRequest(nodeID string, fromHeight, toHeight uint64) *SharechainMessage {
	return &SharechainMessage{
		Type:       MessageTypeBlocksRequest,
		PeerID:     nodeID,
		FromHeight: fromHeight,
		ToHeight:   toHeight,
	}
}

// CreateBlocksResponse creates a blocks response message
func CreateBlocksResponse(nodeID string, blocks []*SharechainBlock) (*SharechainMessage, error) {
	blocksData, err := json.Marshal(blocks)
	if err != nil {
		return nil, err
	}
	
	return &SharechainMessage{
		Type:   MessageTypeBlocksResponse,
		PeerID: nodeID,
		Blocks: blocksData,
	}, nil
}

// CreateNewBlockMessage creates a new block announcement message
func CreateNewBlockMessage(nodeID string, block *SharechainBlock) (*SharechainMessage, error) {
	blockData, err := json.Marshal(block)
	if err != nil {
		return nil, err
	}
	
	return &SharechainMessage{
		Type:   MessageTypeNewBlock,
		PeerID: nodeID,
		Height: block.Height,
		Blocks: blockData,
	}, nil
}