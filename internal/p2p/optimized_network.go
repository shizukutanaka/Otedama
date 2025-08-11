package p2p

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/memory"
	"go.uber.org/zap"
)

// Network represents the P2P network implementation
type Network struct {
	logger *zap.Logger
	
	// Network identity
	nodeID     NodeID
	listenAddr string
	
	// Connection management
	peers      map[NodeID]*Peer
	peersMu    sync.RWMutex
	maxPeers   int
	
	// Connection pools
	connPool   *ConnectionPool
	poolMgr    *memory.PoolManager
	
	// Message handling
	msgHandlers map[MessageType]MessageHandler
	handlersMu  sync.RWMutex
	
	// Network statistics
	stats struct {
		messagesReceived atomic.Uint64
		messagesSent     atomic.Uint64
		bytesReceived    atomic.Uint64
		bytesSent        atomic.Uint64
		peersConnected   atomic.Int32
		peersDisconnected atomic.Int32
	}
	
	// Network state
	running    atomic.Bool
	listener   net.Listener
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
	
	// Protocol configuration
	protocolVersion uint32
	networkMagic    uint32
	
	// Performance tuning
	readTimeout     time.Duration
	writeTimeout    time.Duration
	keepAliveInterval time.Duration
	
	// Discovery
	bootstrapNodes []string
	dht           *DHT
}

// NodeID represents a unique node identifier
type NodeID [32]byte

// Peer represents a connected peer
type Peer struct {
	ID           NodeID
	conn         net.Conn
	addr         string
	version      uint32
	
	// State
	connected    time.Time
	lastSeen     time.Time
	latency      time.Duration
	
	// Statistics
	messagesSent     atomic.Uint64
	messagesReceived atomic.Uint64
	bytesSent        atomic.Uint64
	bytesReceived    atomic.Uint64
	
	// Channels
	sendChan     chan *Message
	stopChan     chan struct{}
	
	// Connection state
	mu           sync.RWMutex
	disconnected atomic.Bool
}

// Message represents a P2P message
type Message struct {
	Type      MessageType
	Payload   []byte
	Timestamp time.Time
}

// MessageType represents the type of P2P message
type MessageType uint32

const (
	MessageTypePing MessageType = iota
	MessageTypePong
	MessageTypeGetPeers
	MessageTypePeers
	MessageTypeShare
	MessageTypeBlock
	MessageTypeTransaction
	MessageTypeGetBlocks
	MessageTypeGetData
	MessageTypeInv
	MessageTypeNotFound
	MessageTypeError
)

// MessageHandler handles incoming messages
type MessageHandler func(peer *Peer, msg *Message) error

// ConnectionPool manages reusable connections
type ConnectionPool struct {
	connections map[string][]*pooledConn
	mu          sync.RWMutex
	maxIdle     int
	maxActive   int
	idleTimeout time.Duration
}

type pooledConn struct {
	conn     net.Conn
	lastUsed time.Time
	inUse    atomic.Bool
}

// DHT provides distributed hash table functionality
type DHT struct {
	buckets    []*KBucket
	localID    NodeID
	mu         sync.RWMutex
}

// KBucket represents a k-bucket in the DHT
type KBucket struct {
	nodes    []NodeID
	maxSize  int
	mu       sync.RWMutex
}

// NetworkConfig contains network configuration
type NetworkConfig struct {
	ListenAddr        string
	MaxPeers          int
	BootstrapNodes    []string
	ProtocolVersion   uint32
	NetworkMagic      uint32
	ReadTimeout       time.Duration
	WriteTimeout      time.Duration
	KeepAliveInterval time.Duration
}

// NewNetwork creates a new P2P network
func NewNetwork(logger *zap.Logger, config *NetworkConfig) (*Network, error) {
	// Generate node ID
	nodeID := NodeID{}
	if _, err := rand.Read(nodeID[:]); err != nil {
		return nil, fmt.Errorf("failed to generate node ID: %w", err)
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	network := &Network{
		logger:            logger,
		nodeID:            nodeID,
		listenAddr:        config.ListenAddr,
		peers:             make(map[NodeID]*Peer),
		maxPeers:          config.MaxPeers,
		msgHandlers:       make(map[MessageType]MessageHandler),
		protocolVersion:   config.ProtocolVersion,
		networkMagic:      config.NetworkMagic,
		readTimeout:       config.ReadTimeout,
		writeTimeout:      config.WriteTimeout,
		keepAliveInterval: config.KeepAliveInterval,
		bootstrapNodes:    config.BootstrapNodes,
		ctx:               ctx,
		cancel:            cancel,
	}
	
	// Initialize connection pool
	network.connPool = &ConnectionPool{
		connections: make(map[string][]*pooledConn),
		maxIdle:     10,
		maxActive:   100,
		idleTimeout: 5 * time.Minute,
	}
	
	// Initialize memory pool manager
	network.poolMgr = memory.GetGlobalPoolManager()
	
	// Initialize DHT
	network.dht = &DHT{
		localID: nodeID,
		buckets: make([]*KBucket, 256),
	}
	for i := range network.dht.buckets {
		network.dht.buckets[i] = &KBucket{
			nodes:   make([]NodeID, 0, 20),
			maxSize: 20,
		}
	}
	
	// Register default message handlers
	network.registerDefaultHandlers()
	
	return network, nil
}

// Start starts the P2P network
func (n *Network) Start() error {
	if !n.running.CompareAndSwap(false, true) {
		return errors.New("network already running")
	}
	
	// Start listening
	listener, err := net.Listen("tcp", n.listenAddr)
	if err != nil {
		n.running.Store(false)
		return fmt.Errorf("failed to start listener: %w", err)
	}
	n.listener = listener
	
	n.logger.Info("P2P network started",
		zap.String("node_id", fmt.Sprintf("%x", n.nodeID[:8])),
		zap.String("listen_addr", n.listenAddr))
	
	// Start accept loop
	n.wg.Add(1)
	go n.acceptLoop()
	
	// Start maintenance tasks
	n.wg.Add(1)
	go n.maintenanceLoop()
	
	// Bootstrap network
	n.wg.Add(1)
	go n.bootstrap()
	
	return nil
}

// Stop stops the P2P network
func (n *Network) Stop() error {
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
	
	// Disconnect all peers
	n.disconnectAllPeers()
	
	// Wait for goroutines
	n.wg.Wait()
	
	n.logger.Info("P2P network stopped")
	return nil
}

// acceptLoop accepts incoming connections
func (n *Network) acceptLoop() {
	defer n.wg.Done()
	
	for n.running.Load() {
		conn, err := n.listener.Accept()
		if err != nil {
			if n.running.Load() {
				n.logger.Error("Accept error", zap.Error(err))
			}
			continue
		}
		
		// Handle connection in goroutine
		go n.handleIncomingConnection(conn)
	}
}

// handleIncomingConnection handles an incoming connection
func (n *Network) handleIncomingConnection(conn net.Conn) {
	// Check peer limit
	if n.stats.peersConnected.Load() >= int32(n.maxPeers) {
		conn.Close()
		return
	}
	
	// Perform handshake
	peer, err := n.performHandshake(conn, false)
	if err != nil {
		n.logger.Debug("Handshake failed", zap.Error(err))
		conn.Close()
		return
	}
	
	// Add peer
	n.addPeer(peer)
	
	// Start peer handlers
	n.wg.Add(2)
	go n.handlePeerMessages(peer)
	go n.handlePeerSend(peer)
}

// Connect connects to a peer
func (n *Network) Connect(addr string) error {
	// Check if already connected
	n.peersMu.RLock()
	for _, peer := range n.peers {
		if peer.addr == addr {
			n.peersMu.RUnlock()
			return errors.New("already connected")
		}
	}
	n.peersMu.RUnlock()
	
	// Check peer limit
	if n.stats.peersConnected.Load() >= int32(n.maxPeers) {
		return errors.New("max peers reached")
	}
	
	// Try to get connection from pool
	conn := n.connPool.get(addr)
	if conn == nil {
		// Create new connection
		var err error
		conn, err = net.DialTimeout("tcp", addr, 10*time.Second)
		if err != nil {
			return fmt.Errorf("dial failed: %w", err)
		}
	}
	
	// Perform handshake
	peer, err := n.performHandshake(conn, true)
	if err != nil {
		conn.Close()
		return fmt.Errorf("handshake failed: %w", err)
	}
	
	// Add peer
	n.addPeer(peer)
	
	// Start peer handlers
	n.wg.Add(2)
	go n.handlePeerMessages(peer)
	go n.handlePeerSend(peer)
	
	return nil
}

// performHandshake performs the P2P handshake
func (n *Network) performHandshake(conn net.Conn, initiator bool) (*Peer, error) {
	// Set deadline for handshake
	conn.SetDeadline(time.Now().Add(30 * time.Second))
	defer conn.SetDeadline(time.Time{})
	
	peer := &Peer{
		conn:      conn,
		addr:      conn.RemoteAddr().String(),
		connected: time.Now(),
		lastSeen:  time.Now(),
		sendChan:  make(chan *Message, 100),
		stopChan:  make(chan struct{}),
	}
	
	if initiator {
		// Send version message
		if err := n.sendVersion(conn); err != nil {
			return nil, err
		}
		
		// Receive version message
		version, nodeID, err := n.receiveVersion(conn)
		if err != nil {
			return nil, err
		}
		
		peer.version = version
		peer.ID = nodeID
	} else {
		// Receive version message
		version, nodeID, err := n.receiveVersion(conn)
		if err != nil {
			return nil, err
		}
		
		peer.version = version
		peer.ID = nodeID
		
		// Send version message
		if err := n.sendVersion(conn); err != nil {
			return nil, err
		}
	}
	
	return peer, nil
}

// sendVersion sends a version message
func (n *Network) sendVersion(conn net.Conn) error {
	buf := n.poolMgr.Get(64)
	defer n.poolMgr.Put(buf)
	
	// Build version message
	binary.BigEndian.PutUint32(buf.Data[0:4], n.networkMagic)
	binary.BigEndian.PutUint32(buf.Data[4:8], n.protocolVersion)
	copy(buf.Data[8:40], n.nodeID[:])
	binary.BigEndian.PutUint64(buf.Data[40:48], uint64(time.Now().Unix()))
	
	_, err := conn.Write(buf.Data[:48])
	return err
}

// receiveVersion receives a version message
func (n *Network) receiveVersion(conn net.Conn) (uint32, NodeID, error) {
	buf := n.poolMgr.Get(64)
	defer n.poolMgr.Put(buf)
	
	if _, err := io.ReadFull(conn, buf.Data[:48]); err != nil {
		return 0, NodeID{}, err
	}
	
	// Parse version message
	magic := binary.BigEndian.Uint32(buf.Data[0:4])
	if magic != n.networkMagic {
		return 0, NodeID{}, errors.New("invalid network magic")
	}
	
	version := binary.BigEndian.Uint32(buf.Data[4:8])
	var nodeID NodeID
	copy(nodeID[:], buf.Data[8:40])
	
	return version, nodeID, nil
}

// addPeer adds a peer to the network
func (n *Network) addPeer(peer *Peer) {
	n.peersMu.Lock()
	n.peers[peer.ID] = peer
	n.peersMu.Unlock()
	
	n.stats.peersConnected.Add(1)
	
	// Add to DHT
	n.dht.addNode(peer.ID)
	
	n.logger.Info("Peer connected",
		zap.String("peer_id", fmt.Sprintf("%x", peer.ID[:8])),
		zap.String("addr", peer.addr))
}

// removePeer removes a peer from the network
func (n *Network) removePeer(peer *Peer) {
	n.peersMu.Lock()
	delete(n.peers, peer.ID)
	n.peersMu.Unlock()
	
	n.stats.peersDisconnected.Add(1)
	n.stats.peersConnected.Add(-1)
	
	// Remove from DHT
	n.dht.removeNode(peer.ID)
	
	// Return connection to pool if reusable
	if !peer.disconnected.Load() {
		n.connPool.put(peer.addr, peer.conn)
	}
	
	n.logger.Info("Peer disconnected",
		zap.String("peer_id", fmt.Sprintf("%x", peer.ID[:8])),
		zap.String("addr", peer.addr))
}

// handlePeerMessages handles incoming messages from a peer
func (n *Network) handlePeerMessages(peer *Peer) {
	defer n.wg.Done()
	defer n.removePeer(peer)
	
	buf := n.poolMgr.Get(65536) // 64KB buffer
	defer n.poolMgr.Put(buf)
	
	for {
		// Set read deadline
		peer.conn.SetReadDeadline(time.Now().Add(n.readTimeout))
		
		// Read message header
		if _, err := io.ReadFull(peer.conn, buf.Data[:8]); err != nil {
			if err != io.EOF {
				n.logger.Debug("Read error", zap.Error(err))
			}
			return
		}
		
		// Parse header
		msgType := MessageType(binary.BigEndian.Uint32(buf.Data[0:4]))
		msgSize := binary.BigEndian.Uint32(buf.Data[4:8])
		
		// Validate message size
		if msgSize > 16*1024*1024 { // 16MB max
			n.logger.Warn("Message too large", zap.Uint32("size", msgSize))
			return
		}
		
		// Read message payload
		payload := n.poolMgr.Get(int(msgSize))
		defer n.poolMgr.Put(payload)
		
		if _, err := io.ReadFull(peer.conn, payload.Data[:msgSize]); err != nil {
			n.logger.Debug("Read payload error", zap.Error(err))
			return
		}
		
		// Update statistics
		peer.bytesReceived.Add(uint64(8 + msgSize))
		peer.messagesReceived.Add(1)
		peer.lastSeen = time.Now()
		n.stats.bytesReceived.Add(uint64(8 + msgSize))
		n.stats.messagesReceived.Add(1)
		
		// Create message
		msg := &Message{
			Type:      msgType,
			Payload:   payload.Data[:msgSize],
			Timestamp: time.Now(),
		}
		
		// Handle message
		if err := n.handleMessage(peer, msg); err != nil {
			n.logger.Debug("Message handling error",
				zap.Error(err),
				zap.Uint32("type", uint32(msgType)))
		}
	}
}

// handlePeerSend handles sending messages to a peer
func (n *Network) handlePeerSend(peer *Peer) {
	defer n.wg.Done()
	
	ticker := time.NewTicker(n.keepAliveInterval)
	defer ticker.Stop()
	
	for {
		select {
		case msg := <-peer.sendChan:
			if err := n.sendMessage(peer, msg); err != nil {
				n.logger.Debug("Send error", zap.Error(err))
				return
			}
			
		case <-ticker.C:
			// Send ping to keep connection alive
			ping := &Message{
				Type:      MessageTypePing,
				Timestamp: time.Now(),
			}
			if err := n.sendMessage(peer, ping); err != nil {
				return
			}
			
		case <-peer.stopChan:
			return
			
		case <-n.ctx.Done():
			return
		}
	}
}

// sendMessage sends a message to a peer
func (n *Network) sendMessage(peer *Peer, msg *Message) error {
	// Get buffer from pool
	size := 8 + len(msg.Payload)
	buf := n.poolMgr.Get(size)
	defer n.poolMgr.Put(buf)
	
	// Build message
	binary.BigEndian.PutUint32(buf.Data[0:4], uint32(msg.Type))
	binary.BigEndian.PutUint32(buf.Data[4:8], uint32(len(msg.Payload)))
	if len(msg.Payload) > 0 {
		copy(buf.Data[8:], msg.Payload)
	}
	
	// Set write deadline
	peer.conn.SetWriteDeadline(time.Now().Add(n.writeTimeout))
	
	// Send message
	if _, err := peer.conn.Write(buf.Data[:size]); err != nil {
		return err
	}
	
	// Update statistics
	peer.bytesSent.Add(uint64(size))
	peer.messagesSent.Add(1)
	n.stats.bytesSent.Add(uint64(size))
	n.stats.messagesSent.Add(1)
	
	return nil
}

// handleMessage handles an incoming message
func (n *Network) handleMessage(peer *Peer, msg *Message) error {
	n.handlersMu.RLock()
	handler, exists := n.msgHandlers[msg.Type]
	n.handlersMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("unknown message type: %d", msg.Type)
	}
	
	return handler(peer, msg)
}

// RegisterHandler registers a message handler
func (n *Network) RegisterHandler(msgType MessageType, handler MessageHandler) {
	n.handlersMu.Lock()
	n.msgHandlers[msgType] = handler
	n.handlersMu.Unlock()
}

// registerDefaultHandlers registers default message handlers
func (n *Network) registerDefaultHandlers() {
	// Ping handler
	n.RegisterHandler(MessageTypePing, func(peer *Peer, msg *Message) error {
		// Send pong
		pong := &Message{
			Type:      MessageTypePong,
			Payload:   msg.Payload,
			Timestamp: time.Now(),
		}
		select {
		case peer.sendChan <- pong:
		default:
		}
		return nil
	})
	
	// Pong handler
	n.RegisterHandler(MessageTypePong, func(peer *Peer, msg *Message) error {
		// Calculate latency
		if len(msg.Payload) == 8 {
			sent := binary.BigEndian.Uint64(msg.Payload)
			peer.latency = time.Since(time.Unix(0, int64(sent)))
		}
		return nil
	})
	
	// GetPeers handler
	n.RegisterHandler(MessageTypeGetPeers, func(peer *Peer, msg *Message) error {
		// Send known peers
		peers := n.getRandomPeers(20)
		payload := make([]byte, len(peers)*32)
		for i, p := range peers {
			copy(payload[i*32:], p[:])
		}
		
		reply := &Message{
			Type:      MessageTypePeers,
			Payload:   payload,
			Timestamp: time.Now(),
		}
		select {
		case peer.sendChan <- reply:
		default:
		}
		return nil
	})
	
	// Peers handler
	n.RegisterHandler(MessageTypePeers, func(peer *Peer, msg *Message) error {
		// Parse peer list
		count := len(msg.Payload) / 32
		for i := 0; i < count; i++ {
			var nodeID NodeID
			copy(nodeID[:], msg.Payload[i*32:(i+1)*32])
			n.dht.addNode(nodeID)
		}
		return nil
	})
}

// Broadcast broadcasts a message to all peers
func (n *Network) Broadcast(msg *Message) {
	n.peersMu.RLock()
	peers := make([]*Peer, 0, len(n.peers))
	for _, peer := range n.peers {
		peers = append(peers, peer)
	}
	n.peersMu.RUnlock()
	
	for _, peer := range peers {
		select {
		case peer.sendChan <- msg:
		default:
			// Channel full, skip
		}
	}
}

// SendToPeer sends a message to a specific peer
func (n *Network) SendToPeer(peerID NodeID, msg *Message) error {
	n.peersMu.RLock()
	peer, exists := n.peers[peerID]
	n.peersMu.RUnlock()
	
	if !exists {
		return errors.New("peer not found")
	}
	
	select {
	case peer.sendChan <- msg:
		return nil
	default:
		return errors.New("peer channel full")
	}
}

// GetPeers returns a list of connected peers
func (n *Network) GetPeers() []NodeID {
	n.peersMu.RLock()
	defer n.peersMu.RUnlock()
	
	peers := make([]NodeID, 0, len(n.peers))
	for id := range n.peers {
		peers = append(peers, id)
	}
	
	return peers
}

// getRandomPeers returns random peers
func (n *Network) getRandomPeers(count int) []NodeID {
	n.peersMu.RLock()
	defer n.peersMu.RUnlock()
	
	if len(n.peers) <= count {
		peers := make([]NodeID, 0, len(n.peers))
		for id := range n.peers {
			peers = append(peers, id)
		}
		return peers
	}
	
	// Select random peers
	peers := make([]NodeID, 0, count)
	for id := range n.peers {
		peers = append(peers, id)
		if len(peers) >= count {
			break
		}
	}
	
	return peers
}

// disconnectAllPeers disconnects all peers
func (n *Network) disconnectAllPeers() {
	n.peersMu.Lock()
	peers := make([]*Peer, 0, len(n.peers))
	for _, peer := range n.peers {
		peers = append(peers, peer)
	}
	n.peersMu.Unlock()
	
	for _, peer := range peers {
		peer.disconnected.Store(true)
		close(peer.stopChan)
		peer.conn.Close()
	}
}

// maintenanceLoop performs periodic maintenance tasks
func (n *Network) maintenanceLoop() {
	defer n.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			n.performMaintenance()
		case <-n.ctx.Done():
			return
		}
	}
}

// performMaintenance performs maintenance tasks
func (n *Network) performMaintenance() {
	// Remove stale peers
	n.peersMu.Lock()
	for id, peer := range n.peers {
		if time.Since(peer.lastSeen) > 5*time.Minute {
			delete(n.peers, id)
			peer.disconnected.Store(true)
			peer.conn.Close()
			close(peer.stopChan)
		}
	}
	n.peersMu.Unlock()
	
	// Clean connection pool
	n.connPool.cleanup()
	
	// Try to connect to more peers if below target
	if n.stats.peersConnected.Load() < int32(n.maxPeers/2) {
		n.discoverPeers()
	}
}

// bootstrap bootstraps the network
func (n *Network) bootstrap() {
	defer n.wg.Done()
	
	for _, addr := range n.bootstrapNodes {
		if err := n.Connect(addr); err != nil {
			n.logger.Debug("Bootstrap connection failed",
				zap.String("addr", addr),
				zap.Error(err))
		}
	}
	
	// Request peers from connected nodes
	time.Sleep(2 * time.Second)
	n.discoverPeers()
}

// discoverPeers discovers new peers
func (n *Network) discoverPeers() {
	msg := &Message{
		Type:      MessageTypeGetPeers,
		Timestamp: time.Now(),
	}
	n.Broadcast(msg)
}

// GetStats returns network statistics
func (n *Network) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"node_id":            fmt.Sprintf("%x", n.nodeID[:8]),
		"peers_connected":    n.stats.peersConnected.Load(),
		"peers_disconnected": n.stats.peersDisconnected.Load(),
		"messages_received":  n.stats.messagesReceived.Load(),
		"messages_sent":      n.stats.messagesSent.Load(),
		"bytes_received":     n.stats.bytesReceived.Load(),
		"bytes_sent":         n.stats.bytesSent.Load(),
	}
}

// ConnectionPool methods

func (cp *ConnectionPool) get(addr string) net.Conn {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	
	conns, exists := cp.connections[addr]
	if !exists || len(conns) == 0 {
		return nil
	}
	
	// Find an available connection
	for i, pc := range conns {
		if !pc.inUse.Load() && time.Since(pc.lastUsed) < cp.idleTimeout {
			pc.inUse.Store(true)
			cp.connections[addr] = append(conns[:i], conns[i+1:]...)
			return pc.conn
		}
	}
	
	return nil
}

func (cp *ConnectionPool) put(addr string, conn net.Conn) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	
	if len(cp.connections[addr]) >= cp.maxIdle {
		conn.Close()
		return
	}
	
	cp.connections[addr] = append(cp.connections[addr], &pooledConn{
		conn:     conn,
		lastUsed: time.Now(),
	})
}

func (cp *ConnectionPool) cleanup() {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	
	for addr, conns := range cp.connections {
		active := make([]*pooledConn, 0, len(conns))
		for _, pc := range conns {
			if time.Since(pc.lastUsed) < cp.idleTimeout {
				active = append(active, pc)
			} else {
				pc.conn.Close()
			}
		}
		
		if len(active) > 0 {
			cp.connections[addr] = active
		} else {
			delete(cp.connections, addr)
		}
	}
}

// DHT methods

func (d *DHT) addNode(nodeID NodeID) {
	d.mu.Lock()
	defer d.mu.Unlock()
	
	// Find appropriate bucket
	distance := d.distance(d.localID, nodeID)
	bucketIdx := d.getBucketIndex(distance)
	
	if bucketIdx < len(d.buckets) {
		bucket := d.buckets[bucketIdx]
		bucket.mu.Lock()
		
		// Check if node already exists
		for _, id := range bucket.nodes {
			if id == nodeID {
				bucket.mu.Unlock()
				return
			}
		}
		
		// Add node if bucket not full
		if len(bucket.nodes) < bucket.maxSize {
			bucket.nodes = append(bucket.nodes, nodeID)
		}
		
		bucket.mu.Unlock()
	}
}

func (d *DHT) removeNode(nodeID NodeID) {
	d.mu.Lock()
	defer d.mu.Unlock()
	
	// Find appropriate bucket
	distance := d.distance(d.localID, nodeID)
	bucketIdx := d.getBucketIndex(distance)
	
	if bucketIdx < len(d.buckets) {
		bucket := d.buckets[bucketIdx]
		bucket.mu.Lock()
		
		// Remove node if found
		for i, id := range bucket.nodes {
			if id == nodeID {
				bucket.nodes = append(bucket.nodes[:i], bucket.nodes[i+1:]...)
				break
			}
		}
		
		bucket.mu.Unlock()
	}
}

func (d *DHT) distance(a, b NodeID) NodeID {
	var result NodeID
	for i := range result {
		result[i] = a[i] ^ b[i]
	}
	return result
}

func (d *DHT) getBucketIndex(distance NodeID) int {
	for i, b := range distance {
		if b != 0 {
			for j := 7; j >= 0; j-- {
				if b&(1<<uint(j)) != 0 {
					return i*8 + (7 - j)
				}
			}
		}
	}
	return len(d.buckets) - 1
}