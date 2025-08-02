package p2p

import (
	"encoding/json"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// MessageHandlers provides implementations for handling different message types
type MessageHandlers struct {
	logger   *zap.Logger
	protocol *Protocol
	
	// Dependencies (would be injected in real implementation)
	shareHandler  ShareHandler
	jobHandler    JobHandler
	blockHandler  BlockHandler
	ledgerHandler LedgerHandler
	txHandler     TransactionHandler
}

// Handler interfaces for different subsystems
type ShareHandler interface {
	ProcessShare(share *SharePayload, peerID string) error
}

type JobHandler interface {
	ProcessJob(job *JobPayload, peerID string) error
	GetCurrentJob() (*JobPayload, error)
}

type BlockHandler interface {
	ProcessBlock(block *BlockPayload, peerID string) error
	ValidateBlock(block *BlockPayload) error
}

type LedgerHandler interface {
	ProcessLedger(ledger *LedgerPayload, peerID string) error
	GetLedger(blockHash string) (*LedgerPayload, error)
}

type TransactionHandler interface {
	ProcessTransaction(tx *TxPayload, peerID string) error
	ValidateTransaction(tx *TxPayload) error
}

// NewMessageHandlers creates a new message handlers instance
func NewMessageHandlers(logger *zap.Logger, protocol *Protocol) *MessageHandlers {
	return &MessageHandlers{
		logger:   logger,
		protocol: protocol,
	}
}

// RegisterAll registers all message handlers with the protocol
func (mh *MessageHandlers) RegisterAll() {
	mh.protocol.RegisterHandler(ShareMessage, mh.handleShare)
	mh.protocol.RegisterHandler(JobMessage, mh.handleJob)
	mh.protocol.RegisterHandler(BlockMessage, mh.handleBlock)
	mh.protocol.RegisterHandler(LedgerMessage, mh.handleLedger)
	mh.protocol.RegisterHandler(TxMessage, mh.handleTransaction)
	mh.protocol.RegisterHandler(PeerListMessage, mh.handlePeerList)
	mh.protocol.RegisterHandler(HandshakeMessage, mh.handleHandshake)
	mh.protocol.RegisterHandler(SyncMessage, mh.handleSync)
}

// handleShare handles incoming share messages
func (mh *MessageHandlers) handleShare(msg *P2PMessage, peerID string) error {
	// Parse payload
	share, err := ParseMessage(ShareMessage, msg.Payload)
	if err != nil {
		return fmt.Errorf("failed to parse share: %w", err)
	}
	
	sharePayload := share.(*SharePayload)
	
	// Validate share
	if err := ValidateMessage(ShareMessage, sharePayload); err != nil {
		return fmt.Errorf("invalid share: %w", err)
	}
	
	mh.logger.Debug("Received share",
		zap.String("peer_id", peerID),
		zap.String("miner_id", sharePayload.MinerID),
		zap.String("job_id", sharePayload.JobID),
		zap.Uint64("nonce", sharePayload.Nonce),
	)
	
	// Process share if handler available
	if mh.shareHandler != nil {
		if err := mh.shareHandler.ProcessShare(sharePayload, peerID); err != nil {
			return fmt.Errorf("failed to process share: %w", err)
		}
	}
	
	// Propagate to other peers
	mh.propagateMessage(msg, peerID)
	
	return nil
}

// handleJob handles incoming job messages
func (mh *MessageHandlers) handleJob(msg *P2PMessage, peerID string) error {
	// Parse payload
	job, err := ParseMessage(JobMessage, msg.Payload)
	if err != nil {
		return fmt.Errorf("failed to parse job: %w", err)
	}
	
	jobPayload := job.(*JobPayload)
	
	// Validate job
	if err := ValidateMessage(JobMessage, jobPayload); err != nil {
		return fmt.Errorf("invalid job: %w", err)
	}
	
	// Check if job is expired
	if time.Now().After(jobPayload.ExpiresAt) {
		return fmt.Errorf("job has expired")
	}
	
	mh.logger.Debug("Received job",
		zap.String("peer_id", peerID),
		zap.String("job_id", jobPayload.JobID),
		zap.Uint64("height", jobPayload.BlockHeight),
		zap.Float64("difficulty", jobPayload.Difficulty),
	)
	
	// Process job if handler available
	if mh.jobHandler != nil {
		if err := mh.jobHandler.ProcessJob(jobPayload, peerID); err != nil {
			return fmt.Errorf("failed to process job: %w", err)
		}
	}
	
	// Propagate to other peers
	mh.propagateMessage(msg, peerID)
	
	return nil
}

// handleBlock handles incoming block messages
func (mh *MessageHandlers) handleBlock(msg *P2PMessage, peerID string) error {
	// Parse payload
	block, err := ParseMessage(BlockMessage, msg.Payload)
	if err != nil {
		return fmt.Errorf("failed to parse block: %w", err)
	}
	
	blockPayload := block.(*BlockPayload)
	
	// Validate block
	if err := ValidateMessage(BlockMessage, blockPayload); err != nil {
		return fmt.Errorf("invalid block: %w", err)
	}
	
	mh.logger.Info("Received block",
		zap.String("peer_id", peerID),
		zap.String("block_hash", blockPayload.BlockHash),
		zap.Uint64("height", blockPayload.BlockHeight),
		zap.String("miner_id", blockPayload.MinerID),
	)
	
	// Validate block if handler available
	if mh.blockHandler != nil {
		if err := mh.blockHandler.ValidateBlock(blockPayload); err != nil {
			return fmt.Errorf("block validation failed: %w", err)
		}
		
		if err := mh.blockHandler.ProcessBlock(blockPayload, peerID); err != nil {
			return fmt.Errorf("failed to process block: %w", err)
		}
	}
	
	// Propagate to other peers
	mh.propagateMessage(msg, peerID)
	
	return nil
}

// handleLedger handles incoming ledger messages
func (mh *MessageHandlers) handleLedger(msg *P2PMessage, peerID string) error {
	// Parse payload
	ledger, err := ParseMessage(LedgerMessage, msg.Payload)
	if err != nil {
		return fmt.Errorf("failed to parse ledger: %w", err)
	}
	
	ledgerPayload := ledger.(*LedgerPayload)
	
	// Validate ledger
	if err := ValidateMessage(LedgerMessage, ledgerPayload); err != nil {
		return fmt.Errorf("invalid ledger: %w", err)
	}
	
	mh.logger.Debug("Received ledger",
		zap.String("peer_id", peerID),
		zap.String("block_hash", ledgerPayload.BlockHash),
		zap.Uint64("height", ledgerPayload.BlockHeight),
		zap.Uint64("total_reward", ledgerPayload.TotalReward),
		zap.Int("shares_count", len(ledgerPayload.Shares)),
	)
	
	// Process ledger if handler available
	if mh.ledgerHandler != nil {
		if err := mh.ledgerHandler.ProcessLedger(ledgerPayload, peerID); err != nil {
			return fmt.Errorf("failed to process ledger: %w", err)
		}
	}
	
	// Propagate to other peers
	mh.propagateMessage(msg, peerID)
	
	return nil
}

// handleTransaction handles incoming transaction messages
func (mh *MessageHandlers) handleTransaction(msg *P2PMessage, peerID string) error {
	// Parse payload
	tx, err := ParseMessage(TxMessage, msg.Payload)
	if err != nil {
		return fmt.Errorf("failed to parse transaction: %w", err)
	}
	
	txPayload := tx.(*TxPayload)
	
	// Validate transaction
	if err := ValidateMessage(TxMessage, txPayload); err != nil {
		return fmt.Errorf("invalid transaction: %w", err)
	}
	
	mh.logger.Debug("Received transaction",
		zap.String("peer_id", peerID),
		zap.String("tx_id", txPayload.TxID),
		zap.String("from", txPayload.From),
		zap.String("to", txPayload.To),
		zap.Uint64("amount", txPayload.Amount),
	)
	
	// Validate and process transaction if handler available
	if mh.txHandler != nil {
		if err := mh.txHandler.ValidateTransaction(txPayload); err != nil {
			return fmt.Errorf("transaction validation failed: %w", err)
		}
		
		if err := mh.txHandler.ProcessTransaction(txPayload, peerID); err != nil {
			return fmt.Errorf("failed to process transaction: %w", err)
		}
	}
	
	// Propagate to other peers
	mh.propagateMessage(msg, peerID)
	
	return nil
}

// handlePeerList handles incoming peer list messages
func (mh *MessageHandlers) handlePeerList(msg *P2PMessage, peerID string) error {
	// Parse payload
	peerList, err := ParseMessage(PeerListMessage, msg.Payload)
	if err != nil {
		return fmt.Errorf("failed to parse peer list: %w", err)
	}
	
	peerListPayload := peerList.(*PeerListPayload)
	
	mh.logger.Debug("Received peer list",
		zap.String("peer_id", peerID),
		zap.Int("peer_count", len(peerListPayload.Peers)),
	)
	
	// Add new peers
	for _, peerInfo := range peerListPayload.Peers {
		// Don't add ourselves
		if peerInfo.ID == mh.protocol.nodeID {
			continue
		}
		
		// Don't add the sender
		if peerInfo.ID == peerID {
			continue
		}
		
		// Check if we already know this peer
		peers := mh.protocol.GetPeers()
		known := false
		for _, p := range peers {
			if p.ID == peerInfo.ID {
				known = true
				break
			}
		}
		
		if !known {
			// Add new peer
			if err := mh.protocol.AddPeer(peerInfo.ID, peerInfo.Address); err != nil {
				mh.logger.Debug("Failed to add peer",
					zap.String("peer_id", peerInfo.ID),
					zap.Error(err),
				)
			} else {
				mh.logger.Info("Discovered new peer",
					zap.String("peer_id", peerInfo.ID),
					zap.String("address", peerInfo.Address),
				)
			}
		}
	}
	
	return nil
}

// handleHandshake handles incoming handshake messages
func (mh *MessageHandlers) handleHandshake(msg *P2PMessage, peerID string) error {
	// Parse payload
	handshake, err := ParseMessage(HandshakeMessage, msg.Payload)
	if err != nil {
		return fmt.Errorf("failed to parse handshake: %w", err)
	}
	
	handshakePayload := handshake.(*HandshakePayload)
	
	mh.logger.Info("Received handshake",
		zap.String("peer_id", peerID),
		zap.String("node_id", handshakePayload.NodeID),
		zap.String("version", handshakePayload.Version),
		zap.Uint64("height", handshakePayload.Height),
		zap.Strings("capabilities", handshakePayload.Capabilities),
	)
	
	// Update peer information
	mh.protocol.mu.Lock()
	if peer, exists := mh.protocol.peers[peerID]; exists {
		peer.Version = handshakePayload.Version
		peer.LastSeen = time.Now()
	}
	mh.protocol.mu.Unlock()
	
	// Send our peer list
	peers := mh.protocol.GetPeers()
	peerInfos := make([]PeerInfo, 0, len(peers))
	for _, peer := range peers {
		peerInfos = append(peerInfos, PeerInfo{
			ID:         peer.ID,
			Address:    peer.Address,
			Version:    peer.Version,
			LastSeen:   peer.LastSeen,
			TrustLevel: peer.TrustLevel,
		})
	}
	
	peerListPayload := &PeerListPayload{
		Peers: peerInfos,
	}
	
	// Send peer list back
	if err := mh.protocol.SendMessage(peerID, PeerListMessage, peerListPayload); err != nil {
		mh.logger.Error("Failed to send peer list",
			zap.String("peer_id", peerID),
			zap.Error(err),
		)
	}
	
	return nil
}

// handleSync handles sync request/response messages
func (mh *MessageHandlers) handleSync(msg *P2PMessage, peerID string) error {
	// Try to parse as sync request
	var syncReq SyncRequestPayload
	if err := json.Unmarshal(msg.Payload, &syncReq); err == nil {
		return mh.handleSyncRequest(&syncReq, peerID)
	}
	
	// Try to parse as sync response
	var syncResp SyncResponsePayload
	if err := json.Unmarshal(msg.Payload, &syncResp); err == nil {
		return mh.handleSyncResponse(&syncResp, peerID)
	}
	
	return fmt.Errorf("invalid sync message format")
}

// handleSyncRequest handles sync request messages
func (mh *MessageHandlers) handleSyncRequest(req *SyncRequestPayload, peerID string) error {
	mh.logger.Debug("Received sync request",
		zap.String("peer_id", peerID),
		zap.Uint64("from_height", req.FromHeight),
		zap.Uint64("to_height", req.ToHeight),
		zap.String("data_type", req.DataType),
	)
	
	// TODO: Implement actual sync logic based on data type
	// For now, send empty response
	
	resp := &SyncResponsePayload{
		FromHeight: req.FromHeight,
		ToHeight:   req.ToHeight,
		DataType:   req.DataType,
		Data:       json.RawMessage("[]"),
	}
	
	return mh.protocol.SendMessage(peerID, SyncMessage, resp)
}

// handleSyncResponse handles sync response messages
func (mh *MessageHandlers) handleSyncResponse(resp *SyncResponsePayload, peerID string) error {
	mh.logger.Debug("Received sync response",
		zap.String("peer_id", peerID),
		zap.Uint64("from_height", resp.FromHeight),
		zap.Uint64("to_height", resp.ToHeight),
		zap.String("data_type", resp.DataType),
	)
	
	// TODO: Process sync response data based on type
	
	return nil
}

// propagateMessage propagates a message to other peers
func (mh *MessageHandlers) propagateMessage(msg *P2PMessage, excludePeer string) {
	// Get all peers except the sender
	peers := mh.protocol.GetPeers()
	
	for _, peer := range peers {
		if peer.ID == excludePeer {
			continue
		}
		
		// Forward the original message
		data, err := json.Marshal(msg)
		if err != nil {
			mh.logger.Error("Failed to marshal message for propagation",
				zap.Error(err),
			)
			continue
		}
		
		if mh.protocol.sendToPeer != nil {
			if err := mh.protocol.sendToPeer(peer.ID, data); err != nil {
				mh.logger.Debug("Failed to propagate message",
					zap.String("peer_id", peer.ID),
					zap.Error(err),
				)
			}
		}
	}
}

// SetShareHandler sets the share handler
func (mh *MessageHandlers) SetShareHandler(handler ShareHandler) {
	mh.shareHandler = handler
}

// SetJobHandler sets the job handler
func (mh *MessageHandlers) SetJobHandler(handler JobHandler) {
	mh.jobHandler = handler
}

// SetBlockHandler sets the block handler
func (mh *MessageHandlers) SetBlockHandler(handler BlockHandler) {
	mh.blockHandler = handler
}

// SetLedgerHandler sets the ledger handler
func (mh *MessageHandlers) SetLedgerHandler(handler LedgerHandler) {
	mh.ledgerHandler = handler
}

// SetTransactionHandler sets the transaction handler
func (mh *MessageHandlers) SetTransactionHandler(handler TransactionHandler) {
	mh.txHandler = handler
}