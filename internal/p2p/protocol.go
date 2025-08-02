package p2p

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MessageType represents P2P message types
type MessageType string

const (
	// Core message types from SPEC.md
	ShareMessage    MessageType = "share"
	JobMessage      MessageType = "job"
	BlockMessage    MessageType = "block"
	LedgerMessage   MessageType = "ledger"
	PingMessage     MessageType = "ping"
	TxMessage       MessageType = "tx"
	PeerListMessage MessageType = "peerlist"
	
	// Additional protocol messages
	HandshakeMessage MessageType = "handshake"
	AckMessage       MessageType = "ack"
	ErrorMessage     MessageType = "error"
	SyncMessage      MessageType = "sync"
)

// P2PMessage represents a message in the P2P network
type P2PMessage struct {
	Type      MessageType `json:"type"`
	SenderID  string      `json:"sender_id"`
	Payload   []byte      `json:"payload"`
	Signature []byte      `json:"signature"`
	Timestamp time.Time   `json:"timestamp"`
	Nonce     uint64      `json:"nonce"`
	Version   string      `json:"version"`
}

// Protocol handles P2P communication protocol
type Protocol struct {
	logger     *zap.Logger
	nodeID     string
	privateKey *ecdsa.PrivateKey
	version    string
	
	// Message handling
	handlers      map[MessageType]MessageHandler
	messageQueue  chan *P2PMessage
	outgoingQueue chan *OutgoingMessage
	
	// Peer management
	peers         map[string]*Peer
	trustedPeers  map[string]bool
	blockedPeers  map[string]time.Time
	
	// Message deduplication
	seenMessages  map[string]time.Time
	messageExpiry time.Duration
	
	// Statistics
	msgSent     atomic.Uint64
	msgReceived atomic.Uint64
	msgDropped  atomic.Uint64
	
	// Configuration
	maxMessageSize int
	rateLimit      int
	spamThreshold  int
	
	mu sync.RWMutex
	
	// Callbacks
	onPeerConnected    func(peerID string)
	onPeerDisconnected func(peerID string)
	sendToPeer         func(peerID string, data []byte) error
}

// MessageHandler handles a specific message type
type MessageHandler func(msg *P2PMessage, peerID string) error

// Peer represents a connected peer
type Peer struct {
	ID            string
	Address       string
	PublicKey     *ecdsa.PublicKey
	LastSeen      time.Time
	MessageCount  int
	SpamScore     int
	TrustLevel    float64
	Version       string
}

// OutgoingMessage represents a message to be sent
type OutgoingMessage struct {
	TargetPeer string
	Message    *P2PMessage
	Retries    int
}

// ProtocolConfig contains protocol configuration
type ProtocolConfig struct {
	Version        string        `yaml:"version"`
	MaxMessageSize int           `yaml:"max_message_size"`
	RateLimit      int           `yaml:"rate_limit"`
	SpamThreshold  int           `yaml:"spam_threshold"`
	MessageExpiry  time.Duration `yaml:"message_expiry"`
}

// NewProtocol creates a new P2P protocol instance
func NewProtocol(logger *zap.Logger, nodeID string, privateKey *ecdsa.PrivateKey, config ProtocolConfig) *Protocol {
	// Set defaults
	if config.Version == "" {
		config.Version = "1.0.0"
	}
	if config.MaxMessageSize <= 0 {
		config.MaxMessageSize = 10 * 1024 * 1024 // 10MB
	}
	if config.RateLimit <= 0 {
		config.RateLimit = 100 // messages per second
	}
	if config.SpamThreshold <= 0 {
		config.SpamThreshold = 50
	}
	if config.MessageExpiry <= 0 {
		config.MessageExpiry = 5 * time.Minute
	}
	
	p := &Protocol{
		logger:         logger,
		nodeID:         nodeID,
		privateKey:     privateKey,
		version:        config.Version,
		handlers:       make(map[MessageType]MessageHandler),
		messageQueue:   make(chan *P2PMessage, 1000),
		outgoingQueue:  make(chan *OutgoingMessage, 1000),
		peers:          make(map[string]*Peer),
		trustedPeers:   make(map[string]bool),
		blockedPeers:   make(map[string]time.Time),
		seenMessages:   make(map[string]time.Time),
		messageExpiry:  config.MessageExpiry,
		maxMessageSize: config.MaxMessageSize,
		rateLimit:      config.RateLimit,
		spamThreshold:  config.SpamThreshold,
	}
	
	// Register default handlers
	p.registerDefaultHandlers()
	
	return p
}

// Start starts the protocol message processing
func (p *Protocol) Start() {
	// Start message processor
	go p.processMessages()
	
	// Start outgoing message processor
	go p.processOutgoing()
	
	// Start cleanup routine
	go p.cleanupRoutine()
	
	p.logger.Info("P2P protocol started",
		zap.String("node_id", p.nodeID),
		zap.String("version", p.version),
	)
}

// RegisterHandler registers a message handler
func (p *Protocol) RegisterHandler(msgType MessageType, handler MessageHandler) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	p.handlers[msgType] = handler
	p.logger.Debug("Registered message handler",
		zap.String("type", string(msgType)),
	)
}

// SendMessage sends a message to a specific peer
func (p *Protocol) SendMessage(peerID string, msgType MessageType, payload interface{}) error {
	// Check if peer is blocked
	if p.isPeerBlocked(peerID) {
		return fmt.Errorf("peer is blocked: %s", peerID)
	}
	
	// Serialize payload
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}
	
	// Check message size
	if len(payloadBytes) > p.maxMessageSize {
		return fmt.Errorf("message too large: %d bytes", len(payloadBytes))
	}
	
	// Create message
	msg := &P2PMessage{
		Type:      msgType,
		SenderID:  p.nodeID,
		Payload:   payloadBytes,
		Timestamp: time.Now(),
		Nonce:     p.generateNonce(),
		Version:   p.version,
	}
	
	// Sign message
	if err := p.signMessage(msg); err != nil {
		return fmt.Errorf("failed to sign message: %w", err)
	}
	
	// Queue for sending
	outgoing := &OutgoingMessage{
		TargetPeer: peerID,
		Message:    msg,
		Retries:    3,
	}
	
	select {
	case p.outgoingQueue <- outgoing:
		p.msgSent.Add(1)
		return nil
	default:
		return fmt.Errorf("outgoing queue full")
	}
}

// BroadcastMessage broadcasts a message to all peers
func (p *Protocol) BroadcastMessage(msgType MessageType, payload interface{}) error {
	p.mu.RLock()
	peers := make([]string, 0, len(p.peers))
	for peerID := range p.peers {
		peers = append(peers, peerID)
	}
	p.mu.RUnlock()
	
	var lastErr error
	successCount := 0
	
	for _, peerID := range peers {
		if err := p.SendMessage(peerID, msgType, payload); err != nil {
			lastErr = err
			p.logger.Debug("Failed to send to peer",
				zap.String("peer_id", peerID),
				zap.Error(err),
			)
		} else {
			successCount++
		}
	}
	
	if successCount == 0 && lastErr != nil {
		return fmt.Errorf("broadcast failed: %w", lastErr)
	}
	
	p.logger.Debug("Message broadcast",
		zap.String("type", string(msgType)),
		zap.Int("success_count", successCount),
		zap.Int("total_peers", len(peers)),
	)
	
	return nil
}

// ReceiveMessage processes an incoming message
func (p *Protocol) ReceiveMessage(data []byte, peerID string) error {
	// Deserialize message
	var msg P2PMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return fmt.Errorf("failed to unmarshal message: %w", err)
	}
	
	// Check message size
	if len(data) > p.maxMessageSize {
		p.msgDropped.Add(1)
		return fmt.Errorf("message too large: %d bytes", len(data))
	}
	
	// Check if peer is blocked
	if p.isPeerBlocked(peerID) {
		p.msgDropped.Add(1)
		return fmt.Errorf("peer is blocked: %s", peerID)
	}
	
	// Check for duplicate message
	msgID := p.getMessageID(&msg)
	if p.isMessageSeen(msgID) {
		p.msgDropped.Add(1)
		return nil // Silently drop duplicate
	}
	
	// Verify signature
	if err := p.verifyMessage(&msg); err != nil {
		p.msgDropped.Add(1)
		p.updatePeerSpamScore(peerID, 10)
		return fmt.Errorf("invalid signature: %w", err)
	}
	
	// Check timestamp
	if time.Since(msg.Timestamp) > p.messageExpiry {
		p.msgDropped.Add(1)
		return fmt.Errorf("message expired")
	}
	
	// Mark message as seen
	p.markMessageSeen(msgID)
	
	// Update peer info
	p.updatePeerInfo(peerID, &msg)
	
	// Queue for processing
	select {
	case p.messageQueue <- &msg:
		p.msgReceived.Add(1)
		return nil
	default:
		p.msgDropped.Add(1)
		return fmt.Errorf("message queue full")
	}
}

// AddPeer adds a new peer
func (p *Protocol) AddPeer(peerID string, address string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	if _, exists := p.peers[peerID]; exists {
		return fmt.Errorf("peer already exists: %s", peerID)
	}
	
	peer := &Peer{
		ID:         peerID,
		Address:    address,
		LastSeen:   time.Now(),
		TrustLevel: 0.5, // Start with neutral trust
	}
	
	p.peers[peerID] = peer
	
	// Notify callback
	if p.onPeerConnected != nil {
		p.onPeerConnected(peerID)
	}
	
	p.logger.Info("Peer added",
		zap.String("peer_id", peerID),
		zap.String("address", address),
	)
	
	return nil
}

// RemovePeer removes a peer
func (p *Protocol) RemovePeer(peerID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	delete(p.peers, peerID)
	delete(p.trustedPeers, peerID)
	
	// Notify callback
	if p.onPeerDisconnected != nil {
		p.onPeerDisconnected(peerID)
	}
	
	p.logger.Info("Peer removed",
		zap.String("peer_id", peerID),
	)
}

// GetPeers returns all connected peers
func (p *Protocol) GetPeers() []*Peer {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	peers := make([]*Peer, 0, len(p.peers))
	for _, peer := range p.peers {
		peers = append(peers, peer)
	}
	
	return peers
}

// GetStatistics returns protocol statistics
func (p *Protocol) GetStatistics() map[string]interface{} {
	p.mu.RLock()
	peerCount := len(p.peers)
	trustedCount := len(p.trustedPeers)
	blockedCount := len(p.blockedPeers)
	p.mu.RUnlock()
	
	return map[string]interface{}{
		"messages_sent":     p.msgSent.Load(),
		"messages_received": p.msgReceived.Load(),
		"messages_dropped":  p.msgDropped.Load(),
		"peer_count":        peerCount,
		"trusted_peers":     trustedCount,
		"blocked_peers":     blockedCount,
		"protocol_version":  p.version,
	}
}

// SetSendToPeer sets the peer sending callback
func (p *Protocol) SetSendToPeer(callback func(peerID string, data []byte) error) {
	p.sendToPeer = callback
}

// SetOnPeerConnected sets the peer connected callback
func (p *Protocol) SetOnPeerConnected(callback func(peerID string)) {
	p.onPeerConnected = callback
}

// SetOnPeerDisconnected sets the peer disconnected callback
func (p *Protocol) SetOnPeerDisconnected(callback func(peerID string)) {
	p.onPeerDisconnected = callback
}

// Private methods

// registerDefaultHandlers registers default message handlers
func (p *Protocol) registerDefaultHandlers() {
	// Ping handler
	p.RegisterHandler(PingMessage, func(msg *P2PMessage, peerID string) error {
		// Send pong response
		pong := map[string]interface{}{
			"type":      "pong",
			"timestamp": time.Now(),
		}
		return p.SendMessage(peerID, AckMessage, pong)
	})
	
	// Error handler
	p.RegisterHandler(ErrorMessage, func(msg *P2PMessage, peerID string) error {
		var errData map[string]interface{}
		if err := json.Unmarshal(msg.Payload, &errData); err != nil {
			return err
		}
		
		p.logger.Warn("Received error from peer",
			zap.String("peer_id", peerID),
			zap.Any("error", errData),
		)
		
		return nil
	})
}

// processMessages processes incoming messages
func (p *Protocol) processMessages() {
	for msg := range p.messageQueue {
		// Get handler
		p.mu.RLock()
		handler, exists := p.handlers[msg.Type]
		p.mu.RUnlock()
		
		if !exists {
			p.logger.Warn("No handler for message type",
				zap.String("type", string(msg.Type)),
				zap.String("sender", msg.SenderID),
			)
			continue
		}
		
		// Execute handler
		if err := handler(msg, msg.SenderID); err != nil {
			p.logger.Error("Message handler error",
				zap.String("type", string(msg.Type)),
				zap.String("sender", msg.SenderID),
				zap.Error(err),
			)
			
			// Send error response
			errResp := map[string]interface{}{
				"error":   err.Error(),
				"msg_type": msg.Type,
			}
			p.SendMessage(msg.SenderID, ErrorMessage, errResp)
		}
	}
}

// processOutgoing processes outgoing messages
func (p *Protocol) processOutgoing() {
	for out := range p.outgoingQueue {
		// Serialize message
		data, err := json.Marshal(out.Message)
		if err != nil {
			p.logger.Error("Failed to marshal outgoing message",
				zap.Error(err),
			)
			continue
		}
		
		// Send to peer
		if p.sendToPeer != nil {
			if err := p.sendToPeer(out.TargetPeer, data); err != nil {
				p.logger.Debug("Failed to send message",
					zap.String("peer_id", out.TargetPeer),
					zap.Error(err),
				)
				
				// Retry if needed
				if out.Retries > 0 {
					out.Retries--
					select {
					case p.outgoingQueue <- out:
					default:
						// Queue full, drop message
					}
				}
			}
		}
	}
}

// cleanupRoutine periodically cleans up old data
func (p *Protocol) cleanupRoutine() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		p.cleanupSeenMessages()
		p.cleanupBlockedPeers()
		p.checkPeerHealth()
	}
}

// cleanupSeenMessages removes old message IDs
func (p *Protocol) cleanupSeenMessages() {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	now := time.Now()
	for msgID, seenTime := range p.seenMessages {
		if now.Sub(seenTime) > p.messageExpiry {
			delete(p.seenMessages, msgID)
		}
	}
}

// cleanupBlockedPeers removes expired blocks
func (p *Protocol) cleanupBlockedPeers() {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	now := time.Now()
	for peerID, blockTime := range p.blockedPeers {
		if now.After(blockTime) {
			delete(p.blockedPeers, peerID)
			p.logger.Info("Peer unblocked",
				zap.String("peer_id", peerID),
			)
		}
	}
}

// checkPeerHealth checks and removes inactive peers
func (p *Protocol) checkPeerHealth() {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	now := time.Now()
	for peerID, peer := range p.peers {
		if now.Sub(peer.LastSeen) > 10*time.Minute {
			delete(p.peers, peerID)
			p.logger.Info("Removed inactive peer",
				zap.String("peer_id", peerID),
			)
		}
	}
}

// signMessage signs a P2P message
func (p *Protocol) signMessage(msg *P2PMessage) error {
	// Create message hash
	data := fmt.Sprintf("%s:%s:%d:%d", 
		msg.Type, msg.SenderID, msg.Timestamp.Unix(), msg.Nonce)
	hash := sha256.Sum256([]byte(data))
	
	// Sign hash
	r, s, err := ecdsa.Sign(rand.Reader, p.privateKey, hash[:])
	if err != nil {
		return err
	}
	
	// Encode signature
	signature := append(r.Bytes(), s.Bytes()...)
	msg.Signature = signature
	
	return nil
}

// verifyMessage verifies a message signature
func (p *Protocol) verifyMessage(msg *P2PMessage) error {
	// TODO: Implement actual signature verification
	// This requires public key management for peers
	
	// For now, just check signature exists
	if len(msg.Signature) == 0 {
		return fmt.Errorf("no signature")
	}
	
	return nil
}

// generateNonce generates a random nonce
func (p *Protocol) generateNonce() uint64 {
	var nonce uint64
	binary.Read(rand.Reader, binary.BigEndian, &nonce)
	return nonce
}

// getMessageID generates a unique ID for a message
func (p *Protocol) getMessageID(msg *P2PMessage) string {
	data := fmt.Sprintf("%s:%s:%d:%d", 
		msg.Type, msg.SenderID, msg.Timestamp.Unix(), msg.Nonce)
	hash := sha256.Sum256([]byte(data))
	return fmt.Sprintf("%x", hash)
}

// isMessageSeen checks if a message has been seen before
func (p *Protocol) isMessageSeen(msgID string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	_, seen := p.seenMessages[msgID]
	return seen
}

// markMessageSeen marks a message as seen
func (p *Protocol) markMessageSeen(msgID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	p.seenMessages[msgID] = time.Now()
}

// isPeerBlocked checks if a peer is blocked
func (p *Protocol) isPeerBlocked(peerID string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	
	blockTime, blocked := p.blockedPeers[peerID]
	if !blocked {
		return false
	}
	
	return time.Now().Before(blockTime)
}

// updatePeerInfo updates peer information
func (p *Protocol) updatePeerInfo(peerID string, msg *P2PMessage) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	peer, exists := p.peers[peerID]
	if !exists {
		peer = &Peer{
			ID:         peerID,
			TrustLevel: 0.5,
		}
		p.peers[peerID] = peer
	}
	
	peer.LastSeen = time.Now()
	peer.MessageCount++
	peer.Version = msg.Version
}

// updatePeerSpamScore updates a peer's spam score
func (p *Protocol) updatePeerSpamScore(peerID string, delta int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	
	peer, exists := p.peers[peerID]
	if !exists {
		return
	}
	
	peer.SpamScore += delta
	
	// Block peer if spam score too high
	if peer.SpamScore >= p.spamThreshold {
		p.blockedPeers[peerID] = time.Now().Add(time.Hour)
		p.logger.Warn("Peer blocked for spam",
			zap.String("peer_id", peerID),
			zap.Int("spam_score", peer.SpamScore),
		)
	}
}