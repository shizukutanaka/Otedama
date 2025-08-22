package p2p

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"go.uber.org/zap"
)

// MessageType defines P2P message types
type MessageType uint8

const (
	MessageTypePing MessageType = iota
	MessageTypePong
	MessageTypeWork
	MessageTypeShare
	MessageTypeBlock
	MessageTypePeerList
	MessageTypeGetPeers
)

// Message represents a P2P message
type Message struct {
	Type      MessageType `json:"type"`
	ID        string      `json:"id"`
	Timestamp int64       `json:"timestamp"`
	Data      []byte      `json:"data"`
	From      string      `json:"from"`
}

// SimplePeer represents a peer connection
type SimplePeer struct {
	ID       string
	Address  string
	conn     net.Conn
	reader   *bufio.Reader
	writer   *bufio.Writer
	lastSeen time.Time
	mu       sync.RWMutex
}

// SimpleNetwork provides a simple TCP-based P2P network
type SimpleNetwork struct {
	logger    *zap.Logger
	nodeID    string
	listener  net.Listener
	peers     map[string]*SimplePeer
	peersMu   sync.RWMutex
	handlers  map[MessageType]MessageHandler
	ctx       context.Context
	cancel    context.CancelFunc
	
	// Configuration
	listenAddr     string
	maxPeers       int
	pingInterval   time.Duration
	peerTimeout    time.Duration
	bootstrapNodes []string
}

// MessageHandler processes incoming messages
type MessageHandler func(peer *SimplePeer, msg *Message) error

// NetworkConfig holds network configuration
type NetworkConfig struct {
	ListenAddr     string
	MaxPeers       int
	PingInterval   time.Duration
	PeerTimeout    time.Duration
	BootstrapNodes []string
}

// NewSimpleNetwork creates a new P2P network
func NewSimpleNetwork(logger *zap.Logger, config *NetworkConfig) (*SimpleNetwork, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Generate node ID
	nodeID := generateNodeID()
	
	network := &SimpleNetwork{
		logger:         logger,
		nodeID:         nodeID,
		peers:          make(map[string]*SimplePeer),
		handlers:       make(map[MessageType]MessageHandler),
		ctx:            ctx,
		cancel:         cancel,
		listenAddr:     config.ListenAddr,
		maxPeers:       config.MaxPeers,
		pingInterval:   config.PingInterval,
		peerTimeout:    config.PeerTimeout,
		bootstrapNodes: config.BootstrapNodes,
	}
	
	// Register default handlers
	network.registerDefaultHandlers()
	
	return network, nil
}

// Start begins network operations
func (n *SimpleNetwork) Start() error {
	// Start TCP listener
	listener, err := net.Listen("tcp", n.listenAddr)
	if err != nil {
		return fmt.Errorf("failed to start listener: %w", err)
	}
	n.listener = listener
	
	n.logger.Info("P2P network started",
		zap.String("nodeID", n.nodeID),
		zap.String("address", n.listenAddr))
	
	// Start accepting connections
	go n.acceptConnections()
	
	// Connect to bootstrap nodes
	go n.connectToBootstrapNodes()
	
	// Start maintenance tasks
	go n.maintenanceLoop()
	
	return nil
}

// Stop gracefully shuts down the network
func (n *SimpleNetwork) Stop() error {
	n.cancel()
	
	if n.listener != nil {
		n.listener.Close()
	}
	
	// Close all peer connections
	n.peersMu.Lock()
	for _, peer := range n.peers {
		peer.conn.Close()
	}
	n.peersMu.Unlock()
	
	n.logger.Info("P2P network stopped")
	return nil
}

// RegisterHandler registers a message handler
func (n *SimpleNetwork) RegisterHandler(msgType MessageType, handler MessageHandler) {
	n.handlers[msgType] = handler
}

// Broadcast sends a message to all connected peers
func (n *SimpleNetwork) Broadcast(msgType MessageType, data []byte) error {
	msg := &Message{
		Type:      msgType,
		ID:        generateMessageID(),
		Timestamp: time.Now().Unix(),
		Data:      data,
		From:      n.nodeID,
	}
	
	n.peersMu.RLock()
	defer n.peersMu.RUnlock()
	
	var errors []error
	for _, peer := range n.peers {
		if err := n.sendMessage(peer, msg); err != nil {
			errors = append(errors, err)
		}
	}
	
	if len(errors) > 0 {
		return fmt.Errorf("broadcast failed for %d peers", len(errors))
	}
	
	return nil
}

// SendToPeer sends a message to a specific peer
func (n *SimpleNetwork) SendToPeer(peerID string, msgType MessageType, data []byte) error {
	n.peersMu.RLock()
	peer, exists := n.peers[peerID]
	n.peersMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("peer not found: %s", peerID)
	}
	
	msg := &Message{
		Type:      msgType,
		ID:        generateMessageID(),
		Timestamp: time.Now().Unix(),
		Data:      data,
		From:      n.nodeID,
	}
	
	return n.sendMessage(peer, msg)
}

// GetPeerCount returns the number of connected peers
func (n *SimpleNetwork) GetPeerCount() int {
	n.peersMu.RLock()
	defer n.peersMu.RUnlock()
	return len(n.peers)
}

// GetPeers returns a list of connected peer IDs
func (n *SimpleNetwork) GetPeers() []string {
	n.peersMu.RLock()
	defer n.peersMu.RUnlock()
	
	peers := make([]string, 0, len(n.peers))
	for id := range n.peers {
		peers = append(peers, id)
	}
	return peers
}

// acceptConnections accepts incoming peer connections
func (n *SimpleNetwork) acceptConnections() {
	for {
		select {
		case <-n.ctx.Done():
			return
		default:
			conn, err := n.listener.Accept()
			if err != nil {
				if n.ctx.Err() != nil {
					return
				}
				n.logger.Error("Failed to accept connection", zap.Error(err))
				continue
			}
			
			go n.handleConnection(conn, true)
		}
	}
}

// handleConnection handles a peer connection
func (n *SimpleNetwork) handleConnection(conn net.Conn, incoming bool) {
	defer conn.Close()
	
	// Perform handshake
	peer, err := n.performHandshake(conn, incoming)
	if err != nil {
		n.logger.Error("Handshake failed", zap.Error(err))
		return
	}
	
	// Check peer limit
	if n.GetPeerCount() >= n.maxPeers {
		n.logger.Info("Max peers reached, rejecting connection",
			zap.String("peerID", peer.ID))
		return
	}
	
	// Add peer
	n.addPeer(peer)
	defer n.removePeer(peer.ID)
	
	n.logger.Info("Peer connected",
		zap.String("peerID", peer.ID),
		zap.String("address", peer.Address))
	
	// Handle messages
	for {
		select {
		case <-n.ctx.Done():
			return
		default:
			// Read message
			msg, err := n.readMessage(peer)
			if err != nil {
				if err != io.EOF {
					n.logger.Error("Failed to read message",
						zap.String("peerID", peer.ID),
						zap.Error(err))
				}
				return
			}
			
			// Update last seen
			peer.mu.Lock()
			peer.lastSeen = time.Now()
			peer.mu.Unlock()
			
			// Handle message
			if handler, exists := n.handlers[msg.Type]; exists {
				if err := handler(peer, msg); err != nil {
					n.logger.Error("Handler error",
						zap.String("peerID", peer.ID),
						zap.Error(err))
				}
			}
		}
	}
}

// performHandshake performs the connection handshake
func (n *SimpleNetwork) performHandshake(conn net.Conn, incoming bool) (*SimplePeer, error) {
	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)
	
	// Send our node ID
	if err := writeString(writer, n.nodeID); err != nil {
		return nil, err
	}
	
	// Read peer's node ID
	peerID, err := readString(reader)
	if err != nil {
		return nil, err
	}
	
	// Validate peer ID
	if peerID == n.nodeID {
		return nil, fmt.Errorf("self-connection detected")
	}
	
	peer := &SimplePeer{
		ID:       peerID,
		Address:  conn.RemoteAddr().String(),
		conn:     conn,
		reader:   reader,
		writer:   writer,
		lastSeen: time.Now(),
	}
	
	return peer, nil
}

// sendMessage sends a message to a peer
func (n *SimpleNetwork) sendMessage(peer *SimplePeer, msg *Message) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	peer.mu.Lock()
	defer peer.mu.Unlock()
	
	// Write message length
	if err := binary.Write(peer.writer, binary.BigEndian, uint32(len(data))); err != nil {
		return err
	}
	
	// Write message data
	if _, err := peer.writer.Write(data); err != nil {
		return err
	}
	
	return peer.writer.Flush()
}

// readMessage reads a message from a peer
func (n *SimpleNetwork) readMessage(peer *SimplePeer) (*Message, error) {
	peer.mu.RLock()
	reader := peer.reader
	peer.mu.RUnlock()
	
	// Read message length
	var length uint32
	if err := binary.Read(reader, binary.BigEndian, &length); err != nil {
		return nil, err
	}
	
	// Validate length
	if length > 10*1024*1024 { // 10MB max
		return nil, fmt.Errorf("message too large: %d", length)
	}
	
	// Read message data
	data := make([]byte, length)
	if _, err := io.ReadFull(reader, data); err != nil {
		return nil, err
	}
	
	// Unmarshal message
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	
	return &msg, nil
}

// addPeer adds a peer to the network
func (n *SimpleNetwork) addPeer(peer *SimplePeer) {
	n.peersMu.Lock()
	defer n.peersMu.Unlock()
	n.peers[peer.ID] = peer
}

// removePeer removes a peer from the network
func (n *SimpleNetwork) removePeer(peerID string) {
	n.peersMu.Lock()
	defer n.peersMu.Unlock()
	delete(n.peers, peerID)
}

// connectToBootstrapNodes connects to bootstrap nodes
func (n *SimpleNetwork) connectToBootstrapNodes() {
	for _, addr := range n.bootstrapNodes {
		if err := n.connectToPeer(addr); err != nil {
			n.logger.Error("Failed to connect to bootstrap node",
				zap.String("address", addr),
				zap.Error(err))
		}
	}
}

// connectToPeer connects to a peer at the given address
func (n *SimpleNetwork) connectToPeer(address string) error {
	conn, err := net.DialTimeout("tcp", address, 10*time.Second)
	if err != nil {
		return err
	}
	
	go n.handleConnection(conn, false)
	return nil
}

// maintenanceLoop performs periodic maintenance tasks
func (n *SimpleNetwork) maintenanceLoop() {
	pingTicker := time.NewTicker(n.pingInterval)
	cleanupTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()
	defer cleanupTicker.Stop()
	
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-pingTicker.C:
			n.pingPeers()
		case <-cleanupTicker.C:
			n.cleanupPeers()
		}
	}
}

// pingPeers sends ping messages to all peers
func (n *SimpleNetwork) pingPeers() {
	n.Broadcast(MessageTypePing, []byte{})
}

// cleanupPeers removes inactive peers
func (n *SimpleNetwork) cleanupPeers() {
	n.peersMu.Lock()
	defer n.peersMu.Unlock()
	
	now := time.Now()
	for id, peer := range n.peers {
		peer.mu.RLock()
		lastSeen := peer.lastSeen
		peer.mu.RUnlock()
		
		if now.Sub(lastSeen) > n.peerTimeout {
			n.logger.Info("Removing inactive peer",
				zap.String("peerID", id))
			peer.conn.Close()
			delete(n.peers, id)
		}
	}
}

// registerDefaultHandlers registers default message handlers
func (n *SimpleNetwork) registerDefaultHandlers() {
	// Ping handler
	n.RegisterHandler(MessageTypePing, func(peer *SimplePeer, msg *Message) error {
		return n.sendMessage(peer, &Message{
			Type:      MessageTypePong,
			ID:        generateMessageID(),
			Timestamp: time.Now().Unix(),
			From:      n.nodeID,
		})
	})
	
	// Pong handler
	n.RegisterHandler(MessageTypePong, func(peer *SimplePeer, msg *Message) error {
		return nil // Just update last seen
	})
	
	// Get peers handler
	n.RegisterHandler(MessageTypeGetPeers, func(peer *SimplePeer, msg *Message) error {
		peers := n.GetPeers()
		data, _ := json.Marshal(peers)
		return n.sendMessage(peer, &Message{
			Type:      MessageTypePeerList,
			ID:        generateMessageID(),
			Timestamp: time.Now().Unix(),
			Data:      data,
			From:      n.nodeID,
		})
	})
}

// Helper functions

func generateNodeID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func generateMessageID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func writeString(w *bufio.Writer, s string) error {
	data := []byte(s)
	if err := binary.Write(w, binary.BigEndian, uint32(len(data))); err != nil {
		return err
	}
	if _, err := w.Write(data); err != nil {
		return err
	}
	return w.Flush()
}

func readString(r *bufio.Reader) (string, error) {
	var length uint32
	if err := binary.Read(r, binary.BigEndian, &length); err != nil {
		return "", err
	}
	if length > 1024 {
		return "", fmt.Errorf("string too long: %d", length)
	}
	data := make([]byte, length)
	if _, err := io.ReadFull(r, data); err != nil {
		return "", err
	}
	return string(data), nil
}

// GetNetworkStats returns network statistics
func (n *SimpleNetwork) GetNetworkStats() map[string]interface{} {
	n.peersMu.RLock()
	defer n.peersMu.RUnlock()
	
	peerList := make([]map[string]interface{}, 0, len(n.peers))
	for _, peer := range n.peers {
		peer.mu.RLock()
		peerList = append(peerList, map[string]interface{}{
			"id":        peer.ID,
			"address":   peer.Address,
			"last_seen": peer.lastSeen,
		})
		peer.mu.RUnlock()
	}
	
	return map[string]interface{}{
		"node_id":     n.nodeID,
		"listen_addr": n.listenAddr,
		"peer_count":  len(n.peers),
		"max_peers":   n.maxPeers,
		"peers":       peerList,
	}
}
