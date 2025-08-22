// Package p2p implements the P2P network layer
// DHT-based peer discovery with automatic failover
package p2p

import (
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
	"sync/atomic"
	"time"

	"github.com/otedama/otedama/internal/config"
	"go.uber.org/zap"
)

// Network represents the P2P network
type Network struct {
	logger     *zap.Logger
	config     *config.P2PConfig
	
	// Identity
	nodeID     [32]byte
	listenAddr string
	
	// Peer management
	peers      sync.Map // map[string]*Peer
	peerCount  atomic.Int32
	maxPeers   int32
	
	// DHT for peer discovery
	dht        *DHT
	
	// Network listener
	listener   net.Listener
	
	// Message handling
	handlers   map[MessageType]MessageHandler
	handlerMux sync.RWMutex
	
	// Statistics
	stats      Statistics
	
	// Control
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// Peer represents a network peer
type Peer struct {
	ID           [32]byte
	Address      string
	conn         net.Conn
	reader       *json.Decoder
	writer       *json.Encoder
	writeMux     sync.Mutex
	
	// State
	connected    atomic.Bool
	lastSeen     atomic.Int64
	latency      atomic.Int64
	
	// Statistics
	messagesSent atomic.Uint64
	messagesRecv atomic.Uint64
	bytesSent    atomic.Uint64
	bytesRecv    atomic.Uint64
	
	// Callbacks
	network      *Network
}

// Message represents a P2P message
type Message struct {
	Type      MessageType     `json:"type"`
	ID        string          `json:"id"`
	Timestamp int64           `json:"timestamp"`
	Sender    string          `json:"sender"`
	Payload   json.RawMessage `json:"payload"`
}

// MessageType represents the type of message
type MessageType uint16

const (
	MessageTypePing MessageType = iota
	MessageTypePong
	MessageTypeJob
	MessageTypeShare
	MessageTypeBlock
	MessageTypePeerList
	MessageTypeGetPeers
	MessageTypeDHTStore
	MessageTypeDHTFind
)

// MessageHandler handles incoming messages
type MessageHandler func(peer *Peer, msg *Message) error

// Statistics tracks network statistics
type Statistics struct {
	PeersConnected   atomic.Int32
	MessagesReceived atomic.Uint64
	MessagesSent     atomic.Uint64
	BytesReceived    atomic.Uint64
	BytesSent        atomic.Uint64
	JobsRelayed      atomic.Uint64
	SharesRelayed    atomic.Uint64
	BlocksRelayed    atomic.Uint64
}

// DHT implements a simplified distributed hash table
type DHT struct {
	nodeID       [32]byte
	buckets      [256]*Bucket
	bucketsMux   sync.RWMutex
	store        sync.Map // map[string][]byte
}

// Bucket represents a K-bucket in the DHT
type Bucket struct {
	peers    []*DHTNode
	peersMux sync.RWMutex
}

// DHTNode represents a node in the DHT
type DHTNode struct {
	ID       [32]byte
	Address  string
	LastSeen time.Time
}

// NewNetwork creates a new P2P network
func NewNetwork(logger *zap.Logger, config *config.P2PConfig) *Network {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Generate node ID
	var nodeID [32]byte
	rand.Read(nodeID[:])
	
	network := &Network{
		logger:     logger,
		config:     config,
		nodeID:     nodeID,
		listenAddr: fmt.Sprintf("0.0.0.0:%d", config.Port),
		maxPeers:   int32(config.MaxPeers),
		handlers:   make(map[MessageType]MessageHandler),
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Initialize DHT
	network.dht = &DHT{
		nodeID: nodeID,
	}
	for i := range network.dht.buckets {
		network.dht.buckets[i] = &Bucket{}
	}
	
	// Register default handlers
	network.registerDefaultHandlers()
	
	return network
}

// Start starts the P2P network
func (n *Network) Start() error {
	// Start listener
	listener, err := net.Listen("tcp", n.listenAddr)
	if err != nil {
		return fmt.Errorf("failed to start listener: %w", err)
	}
	n.listener = listener
	
	// Start accept loop
	n.wg.Add(1)
	go n.acceptLoop()
	
	// Start maintenance loop
	n.wg.Add(1)
	go n.maintenanceLoop()
	
	// Bootstrap network
	if n.config.Discovery.Enable {
		n.wg.Add(1)
		go n.discoveryLoop()
	}
	
	// Connect to bootstrap nodes
	for _, addr := range n.config.BootstrapNodes {
		go n.ConnectToPeer(addr)
	}
	
	n.logger.Info("P2P network started",
		zap.String("nodeID", hex.EncodeToString(n.nodeID[:])),
		zap.String("address", n.listenAddr))
	
	return nil
}

// Stop stops the P2P network
func (n *Network) Stop() {
	n.logger.Info("Stopping P2P network")
	
	// Cancel context
	n.cancel()
	
	// Close listener
	if n.listener != nil {
		n.listener.Close()
	}
	
	// Disconnect all peers
	n.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		peer.Disconnect()
		return true
	})
	
	// Wait for goroutines
	n.wg.Wait()
	
	n.logger.Info("P2P network stopped")
}

// ConnectToPeer connects to a peer
func (n *Network) ConnectToPeer(address string) error {
	// Check if already connected
	if _, exists := n.peers.Load(address); exists {
		return fmt.Errorf("already connected to %s", address)
	}
	
	// Check max peers
	if n.peerCount.Load() >= n.maxPeers {
		return fmt.Errorf("max peers reached")
	}
	
	// Connect
	conn, err := net.DialTimeout("tcp", address, 10*time.Second)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	
	// Create peer
	peer := n.createPeer(conn, address)
	
	// Handshake
	if err := n.handshake(peer); err != nil {
		conn.Close()
		return fmt.Errorf("handshake failed: %w", err)
	}
	
	// Add peer
	n.addPeer(peer)
	
	// Start peer handlers
	go peer.readLoop()
	go peer.pingLoop()
	
	n.logger.Info("Connected to peer", zap.String("address", address))
	return nil
}

// Broadcast broadcasts a message to all peers
func (n *Network) Broadcast(msg *Message) {
	msg.Sender = hex.EncodeToString(n.nodeID[:])
	msg.Timestamp = time.Now().Unix()
	
	n.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		if peer.connected.Load() {
			go peer.Send(msg)
		}
		return true
	})
}

// RegisterHandler registers a message handler
func (n *Network) RegisterHandler(msgType MessageType, handler MessageHandler) {
	n.handlerMux.Lock()
	defer n.handlerMux.Unlock()
	n.handlers[msgType] = handler
}

// GetPeers returns connected peers
func (n *Network) GetPeers() []*Peer {
	var peers []*Peer
	n.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		if peer.connected.Load() {
			peers = append(peers, peer)
		}
		return true
	})
	return peers
}

// GetStatistics returns network statistics
func (n *Network) GetStatistics() map[string]interface{} {
	return map[string]interface{}{
		"node_id":          hex.EncodeToString(n.nodeID[:]),
		"peers_connected":  n.peerCount.Load(),
		"messages_recv":    n.stats.MessagesReceived.Load(),
		"messages_sent":    n.stats.MessagesSent.Load(),
		"bytes_recv":       n.stats.BytesReceived.Load(),
		"bytes_sent":       n.stats.BytesSent.Load(),
		"jobs_relayed":     n.stats.JobsRelayed.Load(),
		"shares_relayed":   n.stats.SharesRelayed.Load(),
		"blocks_relayed":   n.stats.BlocksRelayed.Load(),
	}
}

// Internal methods

// acceptLoop accepts incoming connections
func (n *Network) acceptLoop() {
	defer n.wg.Done()
	
	for {
		conn, err := n.listener.Accept()
		if err != nil {
			select {
			case <-n.ctx.Done():
				return
			default:
				n.logger.Error("Accept error", zap.Error(err))
				continue
			}
		}
		
		// Check max peers
		if n.peerCount.Load() >= n.maxPeers {
			conn.Close()
			continue
		}
		
		// Handle connection
		go n.handleConnection(conn)
	}
}

// handleConnection handles an incoming connection
func (n *Network) handleConnection(conn net.Conn) {
	address := conn.RemoteAddr().String()
	
	// Create peer
	peer := n.createPeer(conn, address)
	
	// Handshake
	if err := n.handshake(peer); err != nil {
		n.logger.Error("Handshake failed", zap.Error(err))
		conn.Close()
		return
	}
	
	// Add peer
	n.addPeer(peer)
	
	// Start peer handlers
	go peer.readLoop()
	go peer.pingLoop()
	
	n.logger.Info("Accepted peer connection", zap.String("address", address))
}

// createPeer creates a new peer
func (n *Network) createPeer(conn net.Conn, address string) *Peer {
	// Set connection options
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		tcpConn.SetKeepAlive(true)
		tcpConn.SetKeepAlivePeriod(30 * time.Second)
		tcpConn.SetNoDelay(true)
	}
	
	peer := &Peer{
		Address: address,
		conn:    conn,
		reader:  json.NewDecoder(conn),
		writer:  json.NewEncoder(conn),
		network: n,
	}
	
	peer.connected.Store(true)
	peer.lastSeen.Store(time.Now().Unix())
	
	return peer
}

// handshake performs peer handshake
func (n *Network) handshake(peer *Peer) error {
	// Send our node ID
	handshake := map[string]interface{}{
		"node_id": hex.EncodeToString(n.nodeID[:]),
		"version": "Otedama",
	}
	
	if err := peer.writer.Encode(handshake); err != nil {
		return err
	}
	
	// Receive peer's node ID
	var response map[string]interface{}
	if err := peer.reader.Decode(&response); err != nil {
		return err
	}
	
	// Parse peer ID
	if nodeIDStr, ok := response["node_id"].(string); ok {
		nodeIDBytes, err := hex.DecodeString(nodeIDStr)
		if err != nil {
			return err
		}
		copy(peer.ID[:], nodeIDBytes)
	}
	
	return nil
}

// addPeer adds a peer to the network
func (n *Network) addPeer(peer *Peer) {
	n.peers.Store(peer.Address, peer)
	n.peerCount.Add(1)
	n.stats.PeersConnected.Add(1)
	
	// Add to DHT
	n.dht.AddNode(&DHTNode{
		ID:       peer.ID,
		Address:  peer.Address,
		LastSeen: time.Now(),
	})
}

// removePeer removes a peer from the network
func (n *Network) removePeer(peer *Peer) {
	n.peers.Delete(peer.Address)
	n.peerCount.Add(-1)
	n.stats.PeersConnected.Add(-1)
}

// maintenanceLoop performs network maintenance
func (n *Network) maintenanceLoop() {
	defer n.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			n.maintenance()
		}
	}
}

// maintenance performs maintenance tasks
func (n *Network) maintenance() {
	// Remove disconnected peers
	n.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		
		// Check if peer is still connected
		if !peer.connected.Load() {
			n.removePeer(peer)
			return true
		}
		
		// Check last seen time
		lastSeen := peer.lastSeen.Load()
		if time.Now().Unix()-lastSeen > 120 {
			peer.Disconnect()
			n.removePeer(peer)
		}
		
		return true
	})
	
	// Connect to more peers if needed
	if n.peerCount.Load() < n.maxPeers/2 {
		n.requestPeers()
	}
}

// discoveryLoop performs peer discovery
func (n *Network) discoveryLoop() {
	defer n.wg.Done()
	
	ticker := time.NewTicker(n.config.Discovery.Interval)
	defer ticker.Stop()
	
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			n.discoverPeers()
		}
	}
}

// discoverPeers discovers new peers
func (n *Network) discoverPeers() {
	// Use DHT to find peers
	if n.config.Discovery.DHT {
		n.dhtDiscovery()
	}
	
	// Request peer lists
	n.requestPeers()
}

// dhtDiscovery performs DHT-based discovery
func (n *Network) dhtDiscovery() {
	// Find nodes close to our ID
	nodes := n.dht.FindClosest(n.nodeID, 10)
	
	for _, node := range nodes {
		// Try to connect
		if n.peerCount.Load() < n.maxPeers {
			go n.ConnectToPeer(node.Address)
		}
	}
}

// requestPeers requests peer lists from connected peers
func (n *Network) requestPeers() {
	msg := &Message{
		Type: MessageTypeGetPeers,
	}
	n.Broadcast(msg)
}

// registerDefaultHandlers registers default message handlers
func (n *Network) registerDefaultHandlers() {
	// Ping handler
	n.RegisterHandler(MessageTypePing, func(peer *Peer, msg *Message) error {
		// Send pong
		pong := &Message{
			Type: MessageTypePong,
			ID:   msg.ID,
		}
		return peer.Send(pong)
	})
	
	// Pong handler
	n.RegisterHandler(MessageTypePong, func(peer *Peer, msg *Message) error {
		// Update latency
		// (simplified - would need to track ping times)
		peer.latency.Store(10)
		return nil
	})
	
	// Get peers handler
	n.RegisterHandler(MessageTypeGetPeers, func(peer *Peer, msg *Message) error {
		// Send peer list
		peers := n.GetPeers()
		peerList := make([]string, 0, len(peers))
		for _, p := range peers {
			if p.Address != peer.Address {
				peerList = append(peerList, p.Address)
			}
		}
		
		payload, _ := json.Marshal(peerList)
		response := &Message{
			Type:    MessageTypePeerList,
			Payload: payload,
		}
		return peer.Send(response)
	})
	
	// Peer list handler
	n.RegisterHandler(MessageTypePeerList, func(peer *Peer, msg *Message) error {
		var peerList []string
		if err := json.Unmarshal(msg.Payload, &peerList); err != nil {
			return err
		}
		
		// Connect to new peers
		for _, addr := range peerList {
			if n.peerCount.Load() >= n.maxPeers {
				break
			}
			go n.ConnectToPeer(addr)
		}
		
		return nil
	})
}

// Peer methods

// Send sends a message to the peer
func (p *Peer) Send(msg *Message) error {
	if !p.connected.Load() {
		return fmt.Errorf("peer not connected")
	}
	
	p.writeMux.Lock()
	defer p.writeMux.Unlock()
	
	// Set message metadata
	msg.Timestamp = time.Now().Unix()
	msg.Sender = hex.EncodeToString(p.network.nodeID[:])
	
	// Encode message
	if err := p.writer.Encode(msg); err != nil {
		return err
	}
	
	p.messagesSent.Add(1)
	p.network.stats.MessagesSent.Add(1)
	
	return nil
}

// Disconnect disconnects the peer
func (p *Peer) Disconnect() {
	if !p.connected.CompareAndSwap(true, false) {
		return
	}
	
	if p.conn != nil {
		p.conn.Close()
	}
}

// readLoop reads messages from the peer
func (p *Peer) readLoop() {
	defer p.Disconnect()
	
	for {
		// Set read deadline
		p.conn.SetReadDeadline(time.Now().Add(120 * time.Second))
		
		// Read message
		var msg Message
		if err := p.reader.Decode(&msg); err != nil {
			if err != io.EOF {
				p.network.logger.Error("Read error", zap.Error(err))
			}
			return
		}
		
		// Update statistics
		p.messagesRecv.Add(1)
		p.lastSeen.Store(time.Now().Unix())
		p.network.stats.MessagesReceived.Add(1)
		
		// Handle message
		p.handleMessage(&msg)
	}
}

// handleMessage handles an incoming message
func (p *Peer) handleMessage(msg *Message) {
	// Get handler
	p.network.handlerMux.RLock()
	handler, exists := p.network.handlers[msg.Type]
	p.network.handlerMux.RUnlock()
	
	if !exists {
		p.network.logger.Warn("No handler for message type",
			zap.Uint16("type", uint16(msg.Type)))
		return
	}
	
	// Call handler
	if err := handler(p, msg); err != nil {
		p.network.logger.Error("Handler error",
			zap.Uint16("type", uint16(msg.Type)),
			zap.Error(err))
	}
}

// pingLoop sends periodic pings
func (p *Peer) pingLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-p.network.ctx.Done():
			return
		case <-ticker.C:
			if !p.connected.Load() {
				return
			}
			
			// Send ping
			ping := &Message{
				Type: MessageTypePing,
				ID:   generateMessageID(),
			}
			
			if err := p.Send(ping); err != nil {
				p.Disconnect()
				return
			}
		}
	}
}

// DHT methods

// AddNode adds a node to the DHT
func (d *DHT) AddNode(node *DHTNode) {
	// Calculate bucket index
	bucketIdx := d.getBucketIndex(node.ID)
	
	bucket := d.buckets[bucketIdx]
	bucket.peersMux.Lock()
	defer bucket.peersMux.Unlock()
	
	// Check if node exists
	for i, n := range bucket.peers {
		if n.ID == node.ID {
			// Update existing node
			bucket.peers[i] = node
			return
		}
	}
	
	// Add new node (limit bucket size)
	if len(bucket.peers) < 20 {
		bucket.peers = append(bucket.peers, node)
	}
}

// FindClosest finds the closest nodes to a target ID
func (d *DHT) FindClosest(target [32]byte, count int) []*DHTNode {
	var nodes []*DHTNode
	
	// Collect all nodes
	for _, bucket := range d.buckets {
		bucket.peersMux.RLock()
		nodes = append(nodes, bucket.peers...)
		bucket.peersMux.RUnlock()
	}
	
	// Sort by distance to target
	// (simplified - would use XOR distance in real DHT)
	
	// Return up to count nodes
	if len(nodes) > count {
		nodes = nodes[:count]
	}
	
	return nodes
}

// getBucketIndex calculates the bucket index for a node ID
func (d *DHT) getBucketIndex(nodeID [32]byte) int {
	// Simplified bucket calculation
	return int(nodeID[0])
}

// Utility functions

// generateMessageID generates a unique message ID
func generateMessageID() string {
	var id [16]byte
	rand.Read(id[:])
	return hex.EncodeToString(id[:])
}

// calculateDistance calculates XOR distance between two IDs
func calculateDistance(a, b [32]byte) [32]byte {
	var distance [32]byte
	for i := range a {
		distance[i] = a[i] ^ b[i]
	}
	return distance
}
