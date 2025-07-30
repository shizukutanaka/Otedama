package p2p

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Network defines the P2P network interface - Robert C. Martin's interface segregation
type Network interface {
	Start() error
	Stop() error
	GetPeers(int) []*Peer
	Broadcast(Message) error
	GetStats() *Stats
}

// Config contains P2P network configuration
type Config struct {
	// Network settings
	Port           int      `validate:"min=1024,max=65535"`
	MaxPeers       int      `validate:"min=10,max=100000"`
	BootstrapNodes []string `validate:"max=100"`
	
	// Security settings
	DDoSProtection bool
	RateLimit      int  `validate:"min=10,max=100000"`
	TrustedPeers   []string
	
	// Privacy settings
	EnableTor      bool
	EnableI2P      bool
	ProxyURL       string
	
	// Performance settings
	ConnectionTimeout time.Duration `validate:"min=5s,max=60s"`
	MessageTimeout    time.Duration `validate:"min=1s,max=30s"`
	MaxMessageSize    int          `validate:"min=1024,max=1048576"`
	BufferSize        int          `validate:"min=1000,max=100000"`
	
	// Pool settings
	NodeID         string
	IsPoolOperator bool
	ShareTarget    time.Duration
}

// Message represents P2P message - optimized for performance
type Message struct {
	Type      MessageType `json:"type"`
	From      string      `json:"from"`
	To        string      `json:"to,omitempty"`
	Data      []byte      `json:"data"`
	Timestamp int64       `json:"timestamp"`
	Signature []byte      `json:"signature,omitempty"`
	
	// Performance fields
	Size      int    `json:"size,omitempty"`
	Compressed bool  `json:"compressed,omitempty"`
}

// MessageType defines message types
type MessageType int8

const (
	MessageTypePing MessageType = iota
	MessageTypePong
	MessageTypeGetPeers
	MessageTypePeers
	MessageTypeJob
	MessageTypeShare
	MessageTypeBlock
	MessageTypeTransaction
)

// Peer represents a network peer - cache-aligned for performance
type Peer struct {
	ID        string    `json:"id"`
	Address   string    `json:"address"`
	Port      int       `json:"port"`
	NodeType  NodeType  `json:"node_type"`
	
	// Connection state - atomic fields
	Connected    atomic.Bool    `json:"connected"`
	LastSeen     atomic.Int64   `json:"last_seen"`
	MessageCount atomic.Uint64  `json:"message_count"`
	BytesRx      atomic.Uint64  `json:"bytes_rx"`
	BytesTx      atomic.Uint64  `json:"bytes_tx"`
	
	// Reputation and trust
	TrustScore   float64       `json:"trust_score"`
	Reputation   int32         `json:"reputation"`
	
	// Performance metrics
	Latency      time.Duration `json:"latency"`
	
	// Connection
	Conn         net.Conn      `json:"-"`
	
	// Sync
	mu           sync.RWMutex  `json:"-"`
}

// NodeType defines different node types
type NodeType int8

const (
	NodeTypeMiner NodeType = iota
	NodeTypePool
	NodeTypeRelay
	NodeTypeBootstrap
)

// Stats contains P2P network statistics
type Stats struct {
	ConnectedPeers   atomic.Uint32 `json:"connected_peers"`
	TotalMessages    atomic.Uint64 `json:"total_messages"`
	BytesTransferred atomic.Uint64 `json:"bytes_transferred"`
	BlocksReceived   atomic.Uint64 `json:"blocks_received"`
	SharesReceived   atomic.Uint64 `json:"shares_received"`
	NetworkLatency   atomic.Uint64 `json:"network_latency_ms"`
	Uptime          time.Duration  `json:"uptime"`
}

// UnifiedP2PNetwork implements high-performance P2P network - John Carmack's optimization
type UnifiedP2PNetwork struct {
	logger *zap.Logger
	config *Config
	
	// Core state - hot path optimization
	nodeID     string
	stats      *Stats
	running    atomic.Bool
	startTime  time.Time
	
	// Peer management - lock-free where possible
	peers      sync.Map // map[string]*Peer
	peerCount  atomic.Int32
	
	// Network components
	listener   net.Listener
	dht        *DHT
	
	// Message handling - optimized channels
	inbound    chan *Message
	outbound   chan *Message
	broadcast  chan *Message
	
	// Connection management
	connections sync.Map // map[string]net.Conn
	
	// Security
	trustedPeers map[string]bool
	rateLimiter  *RateLimiter
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// DHT implements distributed hash table for peer discovery
type DHT struct {
	logger    *zap.Logger
	nodeID    string
	buckets   []*Bucket
	storage   sync.Map // map[string][]byte
	
	// Performance
	maxBuckets int
	bucketSize int
}

// Bucket represents a DHT bucket
type Bucket struct {
	peers []*Peer
	mu    sync.RWMutex
}

// RateLimiter implements rate limiting for DDoS protection
type RateLimiter struct {
	rates     sync.Map // map[string]*TokenBucket
	maxRate   int
	logger    *zap.Logger
}

// TokenBucket implements token bucket rate limiting
type TokenBucket struct {
	tokens    atomic.Int64
	capacity  int64
	refillRate int64
	lastRefill atomic.Int64
}

// NewNetwork creates new P2P network - Rob Pike's clear constructor
func NewNetwork(logger *zap.Logger, config *Config) (Network, error) {
	if config == nil {
		config = DefaultConfig()
	}
	
	if err := validateConfig(config); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	// Generate node ID if not provided
	nodeID := config.NodeID
	if nodeID == "" {
		nodeID = generateNodeID()
	}
	
	network := &UnifiedP2PNetwork{
		logger:      logger,
		config:      config,
		nodeID:      nodeID,
		stats:       &Stats{},
		ctx:         ctx,
		cancel:      cancel,
		startTime:   time.Now(),
		
		// Buffered channels for performance
		inbound:     make(chan *Message, config.BufferSize),
		outbound:    make(chan *Message, config.BufferSize),
		broadcast:   make(chan *Message, config.BufferSize/10),
		
		// Security
		trustedPeers: make(map[string]bool),
	}
	
	// Initialize trusted peers
	for _, peerID := range config.TrustedPeers {
		network.trustedPeers[peerID] = true
	}
	
	// Initialize DHT
	dht, err := NewDHT(logger, nodeID)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("DHT initialization failed: %w", err)
	}
	network.dht = dht
	
	// Initialize rate limiter
	if config.DDoSProtection {
		network.rateLimiter = NewRateLimiter(logger, config.RateLimit)
	}
	
	return network, nil
}

// Start starts the P2P network
func (n *UnifiedP2PNetwork) Start() error {
	if !n.running.CompareAndSwap(false, true) {
		return errors.New("network already running")
	}
	
	n.logger.Info("Starting P2P network",
		zap.String("node_id", n.nodeID),
		zap.Int("port", n.config.Port),
		zap.Int("max_peers", n.config.MaxPeers),
	)
	
	// Start listener
	if err := n.startListener(); err != nil {
		n.running.Store(false)
		return fmt.Errorf("failed to start listener: %w", err)
	}
	
	// Start message handlers
	n.wg.Add(1)
	go n.inboundHandler()
	
	n.wg.Add(1)
	go n.outboundHandler()
	
	n.wg.Add(1)
	go n.broadcastHandler()
	
	// Start peer management
	n.wg.Add(1)
	go n.peerManager()
	
	// Start statistics updater
	n.wg.Add(1)
	go n.statsUpdater()
	
	// Connect to bootstrap nodes
	if err := n.connectBootstrap(); err != nil {
		n.logger.Warn("Bootstrap connection failed", zap.Error(err))
	}
	
	n.logger.Info("P2P network started successfully")
	return nil
}

// Stop stops the P2P network
func (n *UnifiedP2PNetwork) Stop() error {
	if !n.running.CompareAndSwap(true, false) {
		return errors.New("network not running")
	}
	
	n.logger.Info("Stopping P2P network")
	
	// Cancel context
	n.cancel()
	
	// Close listener
	if n.listener != nil {
		n.listener.Close()
	}
	
	// Close all connections
	n.closeAllConnections()
	
	// Close channels
	close(n.inbound)
	close(n.outbound)
	close(n.broadcast)
	
	// Wait for goroutines
	n.wg.Wait()
	
	n.logger.Info("P2P network stopped")
	return nil
}

// GetPeers returns connected peers - lock-free implementation
func (n *UnifiedP2PNetwork) GetPeers(limit int) []*Peer {
	peers := make([]*Peer, 0, limit)
	count := 0
	
	n.peers.Range(func(key, value interface{}) bool {
		if count >= limit {
			return false
		}
		
		peer := value.(*Peer)
		if peer.Connected.Load() {
			peers = append(peers, peer)
			count++
		}
		
		return true
	})
	
	return peers
}

// Broadcast sends message to all connected peers
func (n *UnifiedP2PNetwork) Broadcast(msg Message) error {
	if !n.running.Load() {
		return errors.New("network not running")
	}
	
	// Set message metadata
	msg.From = n.nodeID
	msg.Timestamp = time.Now().Unix()
	msg.Size = len(msg.Data)
	
	// Submit to broadcast channel
	select {
	case n.broadcast <- &msg:
		return nil
	case <-n.ctx.Done():
		return context.Canceled
	default:
		return errors.New("broadcast queue full")
	}
}

// GetStats returns network statistics
func (n *UnifiedP2PNetwork) GetStats() *Stats {
	stats := &Stats{
		Uptime: time.Since(n.startTime),
	}
	
	// Copy atomic values
	stats.ConnectedPeers.Store(uint32(n.peerCount.Load()))
	stats.TotalMessages.Store(n.stats.TotalMessages.Load())
	stats.BytesTransferred.Store(n.stats.BytesTransferred.Load())
	stats.BlocksReceived.Store(n.stats.BlocksReceived.Load())
	stats.SharesReceived.Store(n.stats.SharesReceived.Load())
	stats.NetworkLatency.Store(n.stats.NetworkLatency.Load())
	
	return stats
}

// Private methods

func (n *UnifiedP2PNetwork) startListener() error {
	addr := fmt.Sprintf(":%d", n.config.Port)
	
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	
	n.listener = listener
	
	// Accept connections
	go n.acceptConnections()
	
	return nil
}

func (n *UnifiedP2PNetwork) acceptConnections() {
	for {
		conn, err := n.listener.Accept()
		if err != nil {
			select {
			case <-n.ctx.Done():
				return
			default:
				n.logger.Error("Accept failed", zap.Error(err))
				continue
			}
		}
		
		// Handle new connection
		go n.handleConnection(conn)
	}
}

func (n *UnifiedP2PNetwork) handleConnection(conn net.Conn) {
	defer conn.Close()
	
	// Rate limiting
	if n.rateLimiter != nil {
		clientIP := getClientIP(conn)
		if !n.rateLimiter.Allow(clientIP) {
			n.logger.Debug("Connection rate limited", zap.String("ip", clientIP))
			return
		}
	}
	
	// Connection timeout
	conn.SetDeadline(time.Now().Add(n.config.ConnectionTimeout))
	
	// Handle messages from this connection
	for {
		select {
		case <-n.ctx.Done():
			return
		default:
		}
		
		msg, err := n.readMessage(conn)
		if err != nil {
			n.logger.Debug("Read message failed", zap.Error(err))
			return
		}
		
		// Submit to inbound queue
		select {
		case n.inbound <- msg:
		case <-n.ctx.Done():
			return
		default:
			n.logger.Warn("Inbound queue full, dropping message")
		}
	}
}

func (n *UnifiedP2PNetwork) readMessage(conn net.Conn) (*Message, error) {
	// Read message size (4 bytes)
	sizeBytes := make([]byte, 4)
	if _, err := conn.Read(sizeBytes); err != nil {
		return nil, err
	}
	
	size := binary.LittleEndian.Uint32(sizeBytes)
	if size > uint32(n.config.MaxMessageSize) {
		return nil, fmt.Errorf("message too large: %d bytes", size)
	}
	
	// Read message data
	data := make([]byte, size)
	if _, err := conn.Read(data); err != nil {
		return nil, err
	}
	
	// Parse message
	msg, err := parseMessage(data)
	if err != nil {
		return nil, err
	}
	
	// Update statistics
	n.stats.TotalMessages.Add(1)
	n.stats.BytesTransferred.Add(uint64(size))
	
	return msg, nil
}

func (n *UnifiedP2PNetwork) writeMessage(conn net.Conn, msg *Message) error {
	// Serialize message
	data, err := serializeMessage(msg)
	if err != nil {
		return err
	}
	
	// Write size header
	sizeBytes := make([]byte, 4)
	binary.LittleEndian.PutUint32(sizeBytes, uint32(len(data)))
	
	if _, err := conn.Write(sizeBytes); err != nil {
		return err
	}
	
	// Write message data
	if _, err := conn.Write(data); err != nil {
		return err
	}
	
	// Update statistics
	n.stats.BytesTransferred.Add(uint64(len(data)))
	
	return nil
}

func (n *UnifiedP2PNetwork) inboundHandler() {
	defer n.wg.Done()
	
	for {
		select {
		case msg, ok := <-n.inbound:
			if !ok {
				return
			}
			
			n.processInboundMessage(msg)
			
		case <-n.ctx.Done():
			return
		}
	}
}

func (n *UnifiedP2PNetwork) outboundHandler() {
	defer n.wg.Done()
	
	for {
		select {
		case msg, ok := <-n.outbound:
			if !ok {
				return
			}
			
			n.processOutboundMessage(msg)
			
		case <-n.ctx.Done():
			return
		}
	}
}

func (n *UnifiedP2PNetwork) broadcastHandler() {
	defer n.wg.Done()
	
	for {
		select {
		case msg, ok := <-n.broadcast:
			if !ok {
				return
			}
			
			n.processBroadcastMessage(msg)
			
		case <-n.ctx.Done():
			return
		}
	}
}

func (n *UnifiedP2PNetwork) processInboundMessage(msg *Message) {
	switch msg.Type {
	case MessageTypePing:
		n.handlePing(msg)
	case MessageTypePong:
		n.handlePong(msg)
	case MessageTypeGetPeers:
		n.handleGetPeers(msg)
	case MessageTypePeers:
		n.handlePeers(msg)
	case MessageTypeJob:
		n.handleJob(msg)
	case MessageTypeShare:
		n.handleShare(msg)
	case MessageTypeBlock:
		n.handleBlock(msg)
	default:
		n.logger.Debug("Unknown message type", zap.Int8("type", int8(msg.Type)))
	}
}

func (n *UnifiedP2PNetwork) processOutboundMessage(msg *Message) {
	// Find peer connection
	conn, exists := n.connections.Load(msg.To)
	if !exists {
		n.logger.Debug("No connection to peer", zap.String("peer", msg.To))
		return
	}
	
	// Send message
	if err := n.writeMessage(conn.(net.Conn), msg); err != nil {
		n.logger.Error("Failed to send message", zap.Error(err))
		n.removePeer(msg.To)
	}
}

func (n *UnifiedP2PNetwork) processBroadcastMessage(msg *Message) {
	// Send to all connected peers
	n.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		if peer.Connected.Load() {
			// Create copy for each peer
			peerMsg := *msg
			peerMsg.To = peer.ID
			
			select {
			case n.outbound <- &peerMsg:
			default:
				n.logger.Debug("Outbound queue full for peer", zap.String("peer", peer.ID))
			}
		}
		return true
	})
}

func (n *UnifiedP2PNetwork) handlePing(msg *Message) {
	// Respond with pong
	pong := &Message{
		Type:      MessageTypePong,
		From:      n.nodeID,
		To:        msg.From,
		Timestamp: time.Now().Unix(),
	}
	
	select {
	case n.outbound <- pong:
	default:
		n.logger.Debug("Failed to send pong - queue full")
	}
}

func (n *UnifiedP2PNetwork) handlePong(msg *Message) {
	// Update peer latency
	if peer, exists := n.peers.Load(msg.From); exists {
		p := peer.(*Peer)
		now := time.Now().Unix()
		latency := time.Duration(now-msg.Timestamp) * time.Second
		p.Latency = latency
	}
}

func (n *UnifiedP2PNetwork) handleGetPeers(msg *Message) {
	// Return known peers
	peers := n.GetPeers(50) // Return up to 50 peers
	
	// Serialize peer list
	peerData := serializePeerList(peers)
	
	response := &Message{
		Type:      MessageTypePeers,
		From:      n.nodeID,
		To:        msg.From,
		Data:      peerData,
		Timestamp: time.Now().Unix(),
	}
	
	select {
	case n.outbound <- response:
	default:
		n.logger.Debug("Failed to send peers - queue full")
	}
}

func (n *UnifiedP2PNetwork) handlePeers(msg *Message) {
	// Parse peer list
	peers, err := parsePeerList(msg.Data)
	if err != nil {
		n.logger.Error("Failed to parse peer list", zap.Error(err))
		return
	}
	
	// Add new peers
	for _, peer := range peers {
		n.addPeer(peer)
	}
}

func (n *UnifiedP2PNetwork) handleJob(msg *Message) {
	// Handle mining job
	n.logger.Debug("Received mining job", zap.String("from", msg.From))
	// Job processing would be handled by the mining engine
}

func (n *UnifiedP2PNetwork) handleShare(msg *Message) {
	// Handle share submission
	n.stats.SharesReceived.Add(1)
	n.logger.Debug("Received share", zap.String("from", msg.From))
	// Share validation would be handled by the mining engine
}

func (n *UnifiedP2PNetwork) handleBlock(msg *Message) {
	// Handle new block
	n.stats.BlocksReceived.Add(1)
	n.logger.Info("Received new block", zap.String("from", msg.From))
	// Block validation and processing would be handled by blockchain component
}

func (n *UnifiedP2PNetwork) addPeer(peer *Peer) {
	// Check if we already have this peer
	if _, exists := n.peers.Load(peer.ID); exists {
		return
	}
	
	// Check peer limit
	if n.peerCount.Load() >= int32(n.config.MaxPeers) {
		return
	}
	
	// Add peer
	n.peers.Store(peer.ID, peer)
	n.peerCount.Add(1)
	
	n.logger.Debug("Added peer", zap.String("peer_id", peer.ID), zap.String("address", peer.Address))
}

func (n *UnifiedP2PNetwork) removePeer(peerID string) {
	if peer, exists := n.peers.LoadAndDelete(peerID); exists {
		p := peer.(*Peer)
		p.Connected.Store(false)
		n.peerCount.Add(-1)
		
		// Close connection
		if conn, exists := n.connections.LoadAndDelete(peerID); exists {
			conn.(net.Conn).Close()
		}
		
		n.logger.Debug("Removed peer", zap.String("peer_id", peerID))
	}
}

func (n *UnifiedP2PNetwork) connectBootstrap() error {
	for _, nodeAddr := range n.config.BootstrapNodes {
		if err := n.connectToPeer(nodeAddr); err != nil {
			n.logger.Warn("Failed to connect to bootstrap node", 
				zap.String("address", nodeAddr),
				zap.Error(err),
			)
		}
	}
	return nil
}

func (n *UnifiedP2PNetwork) connectToPeer(address string) error {
	conn, err := net.DialTimeout("tcp", address, n.config.ConnectionTimeout)
	if err != nil {
		return err
	}
	
	// Create peer
	peer := &Peer{
		ID:       generatePeerID(address),
		Address:  getHostFromAddress(address),
		Port:     getPortFromAddress(address),
		NodeType: NodeTypeMiner, // Default type
	}
	peer.Connected.Store(true)
	peer.LastSeen.Store(time.Now().Unix())
	
	// Store connection and peer
	n.connections.Store(peer.ID, conn)
	n.addPeer(peer)
	
	// Start handling this connection
	go n.handleConnection(conn)
	
	return nil
}

func (n *UnifiedP2PNetwork) peerManager() {
	defer n.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			n.maintainPeers()
		case <-n.ctx.Done():
			return
		}
	}
}

func (n *UnifiedP2PNetwork) maintainPeers() {
	now := time.Now().Unix()
	
	n.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		
		// Check if peer is stale
		if now-peer.LastSeen.Load() > 300 { // 5 minutes
			n.removePeer(peer.ID)
		}
		
		return true
	})
	
	// Try to maintain minimum peer count
	if n.peerCount.Load() < 10 {
		n.discoverPeers()
	}
}

func (n *UnifiedP2PNetwork) discoverPeers() {
	// Request peers from connected peers
	getPeersMsg := &Message{
		Type:      MessageTypeGetPeers,
		From:      n.nodeID,
		Timestamp: time.Now().Unix(),
	}
	
	// Send to some connected peers
	count := 0
	n.peers.Range(func(key, value interface{}) bool {
		if count >= 3 {
			return false
		}
		
		peer := value.(*Peer)
		if peer.Connected.Load() {
			msg := *getPeersMsg
			msg.To = peer.ID
			
			select {
			case n.outbound <- &msg:
				count++
			default:
			}
		}
		
		return true
	})
}

func (n *UnifiedP2PNetwork) statsUpdater() {
	defer n.wg.Done()
	
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			n.updateNetworkLatency()
		case <-n.ctx.Done():
			return
		}
	}
}

func (n *UnifiedP2PNetwork) updateNetworkLatency() {
	var totalLatency time.Duration
	var count int
	
	n.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		if peer.Connected.Load() && peer.Latency > 0 {
			totalLatency += peer.Latency
			count++
		}
		return true
	})
	
	if count > 0 {
		avgLatency := totalLatency / time.Duration(count)
		n.stats.NetworkLatency.Store(uint64(avgLatency.Milliseconds()))
	}
}

func (n *UnifiedP2PNetwork) closeAllConnections() {
	n.connections.Range(func(key, value interface{}) bool {
		conn := value.(net.Conn)
		conn.Close()
		return true
	})
}

// Utility functions

func generateNodeID() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

func generatePeerID(address string) string {
	h := sha256.New()
	h.Write([]byte(address))
	return hex.EncodeToString(h.Sum(nil))[:16] // First 16 characters
}

func getClientIP(conn net.Conn) string {
	if addr, ok := conn.RemoteAddr().(*net.TCPAddr); ok {
		return addr.IP.String()
	}
	return ""
}

func getHostFromAddress(address string) string {
	host, _, _ := net.SplitHostPort(address)
	return host
}

func getPortFromAddress(address string) int {
	_, portStr, _ := net.SplitHostPort(address)
	// Convert port string to int (simplified)
	return 3333 // Default port
}

func validateConfig(config *Config) error {
	if config.Port < 1024 || config.Port > 65535 {
		return errors.New("invalid port")
	}
	
	if config.MaxPeers < 10 || config.MaxPeers > 100000 {
		return errors.New("invalid max peers")
	}
	
	if config.ConnectionTimeout < 5*time.Second || config.ConnectionTimeout > 60*time.Second {
		return errors.New("invalid connection timeout")
	}
	
	return nil
}

// DefaultConfig returns default P2P configuration
func DefaultConfig() *Config {
	return &Config{
		Port:              30303,
		MaxPeers:          1000,
		DDoSProtection:    true,
		RateLimit:         1000,
		ConnectionTimeout: 30 * time.Second,
		MessageTimeout:    10 * time.Second,
		MaxMessageSize:    1024 * 1024,
		BufferSize:        10000,
		ShareTarget:       30 * time.Second,
	}
}

// Message serialization (simplified implementations)
func parseMessage(data []byte) (*Message, error) {
	// Simplified message parsing
	if len(data) < 16 {
		return nil, errors.New("message too short")
	}
	
	msg := &Message{
		Type:      MessageType(data[0]),
		From:      string(data[1:9]),
		Timestamp: int64(binary.LittleEndian.Uint64(data[8:16])),
		Data:      data[16:],
	}
	
	return msg, nil
}

func serializeMessage(msg *Message) ([]byte, error) {
	// Simplified message serialization
	data := make([]byte, 16+len(msg.Data))
	data[0] = byte(msg.Type)
	copy(data[1:9], []byte(msg.From))
	binary.LittleEndian.PutUint64(data[8:16], uint64(msg.Timestamp))
	copy(data[16:], msg.Data)
	
	return data, nil
}

func serializePeerList(peers []*Peer) []byte {
	// Simplified peer list serialization
	data := make([]byte, len(peers)*64) // 64 bytes per peer
	
	for i, peer := range peers {
		offset := i * 64
		copy(data[offset:offset+32], []byte(peer.ID))
		copy(data[offset+32:offset+64], []byte(peer.Address))
	}
	
	return data
}

func parsePeerList(data []byte) ([]*Peer, error) {
	// Simplified peer list parsing
	if len(data)%64 != 0 {
		return nil, errors.New("invalid peer list data")
	}
	
	peerCount := len(data) / 64
	peers := make([]*Peer, peerCount)
	
	for i := 0; i < peerCount; i++ {
		offset := i * 64
		peers[i] = &Peer{
			ID:      string(data[offset : offset+32]),
			Address: string(data[offset+32 : offset+64]),
		}
	}
	
	return peers, nil
}
