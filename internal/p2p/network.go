package p2p

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// P2PNetwork represents the P2P network node
type P2PNetwork struct {
	mu              sync.RWMutex
	ctx             context.Context
	cancel          context.CancelFunc
	nodeID          string
	port            int
	peers           map[string]*Peer
	listener        net.Listener
	messageHandlers map[MessageType]MessageHandler
	discovery       *PeerDiscovery
	routing         *RoutingTable
	consensus       *ConsensusEngine
	bandwidth       *BandwidthManager
	stats           *NetworkStats
}

// Peer represents a connected peer
type Peer struct {
	ID            string
	Address       string
	Conn          net.Conn
	LastSeen      time.Time
	Latency       time.Duration
	Version       string
	Capabilities  []string
	Score         int32
	State         PeerState
	sendQueue     chan Message
	receiveQueue  chan Message
	ctx           context.Context
	cancel        context.CancelFunc
}

// PeerState represents peer connection state
type PeerState int

const (
	PeerStateConnecting PeerState = iota
	PeerStateHandshaking
	PeerStateConnected
	PeerStateDisconnecting
	PeerStateDisconnected
)

// Message represents a P2P message
type Message struct {
	Type      MessageType    `json:"type"`
	ID        string         `json:"id"`
	From      string         `json:"from"`
	To        string         `json:"to,omitempty"`
	Timestamp int64          `json:"timestamp"`
	Payload   []byte         `json:"payload"`
	Signature []byte         `json:"signature,omitempty"`
	Nonce     uint64         `json:"nonce"`
}

// MessageType defines message types
type MessageType uint16

const (
	MessageTypePing MessageType = iota
	MessageTypePong
	MessageTypeHandshake
	MessageTypeGetPeers
	MessageTypePeers
	MessageTypeShare
	MessageTypeBlock
	MessageTypeTransaction
	MessageTypeGetData
	MessageTypeData
	MessageTypeBroadcast
	MessageTypeConsensus
)

// MessageHandler handles specific message types
type MessageHandler func(peer *Peer, msg Message) error

// PeerDiscovery handles peer discovery
type PeerDiscovery struct {
	mu             sync.RWMutex
	bootstrapNodes []string
	dht            *DHT
	mdns           *MDNS
	upnp           *UPnP
	natpmp         *NATPMP
}

// DHT implements distributed hash table
type DHT struct {
	mu         sync.RWMutex
	nodeID     string
	buckets    []*KBucket
	dataStore  map[string][]byte
	replication int
}

// KBucket represents a k-bucket in Kademlia
type KBucket struct {
	nodes    []*DHTNode
	capacity int
	lastSeen time.Time
}

// DHTNode represents a node in DHT
type DHTNode struct {
	ID       string
	Address  string
	LastSeen time.Time
	RTT      time.Duration
}

// RoutingTable manages peer routing
type RoutingTable struct {
	mu     sync.RWMutex
	routes map[string]*Route
	graph  *NetworkGraph
}

// Route represents a network route
type Route struct {
	Destination string
	NextHop     string
	Metric      int
	LastUpdated time.Time
}

// NetworkGraph represents network topology
type NetworkGraph struct {
	nodes map[string]*GraphNode
	edges map[string]map[string]*GraphEdge
}

// GraphNode represents a node in network graph
type GraphNode struct {
	ID         string
	Properties map[string]interface{}
}

// GraphEdge represents an edge in network graph
type GraphEdge struct {
	From   string
	To     string
	Weight float64
}

// ConsensusEngine handles distributed consensus
type ConsensusEngine struct {
	mu            sync.RWMutex
	algorithm     ConsensusAlgorithm
	currentRound  uint64
	validators    map[string]*Validator
	pendingVotes  map[string][]Vote
	committedBlocks []Block
}

// ConsensusAlgorithm defines consensus mechanism
type ConsensusAlgorithm interface {
	Propose(ctx context.Context, data []byte) (*Proposal, error)
	Vote(ctx context.Context, proposal *Proposal) (*Vote, error)
	Finalize(ctx context.Context, votes []Vote) (*Block, error)
}

// Validator represents a consensus validator
type Validator struct {
	ID     string
	Stake  uint64
	Power  uint64
	Active bool
}

// Proposal represents a consensus proposal
type Proposal struct {
	ID        string
	Round     uint64
	Data      []byte
	Proposer  string
	Timestamp time.Time
	Signature []byte
}

// Vote represents a consensus vote
type Vote struct {
	ProposalID string
	Voter      string
	Accept     bool
	Timestamp  time.Time
	Signature  []byte
}

// Block represents a finalized block
type Block struct {
	Height    uint64
	Hash      []byte
	PrevHash  []byte
	Data      []byte
	Timestamp time.Time
	Votes     []Vote
}

// BandwidthManager manages network bandwidth
type BandwidthManager struct {
	mu               sync.RWMutex
	uploadLimit      int64
	downloadLimit    int64
	uploadUsed       int64
	downloadUsed     int64
	peerLimits       map[string]*BandwidthLimit
	rateLimiters     map[string]*TokenBucket
}

// BandwidthLimit represents per-peer bandwidth limit
type BandwidthLimit struct {
	Upload   int64
	Download int64
}

// TokenBucket implements token bucket rate limiting
type TokenBucket struct {
	capacity int64
	tokens   int64
	rate     int64
	lastFill time.Time
}

// NetworkStats tracks network statistics
type NetworkStats struct {
	MessagessSent     uint64
	MessagesReceived  uint64
	BytesSent         uint64
	BytesReceived     uint64
	PeersConnected    uint32
	PeersDiscovered   uint64
	ConnectionsFailed uint64
	AverageLatency    uint64
}

// NewP2PNetwork creates a new P2P network node
func NewP2PNetwork(port int, bootstrapNodes []string) (*P2PNetwork, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	// Generate node ID
	nodeID := generateNodeID()
	
	p2p := &P2PNetwork{
		ctx:             ctx,
		cancel:          cancel,
		nodeID:          nodeID,
		port:            port,
		peers:           make(map[string]*Peer),
		messageHandlers: make(map[MessageType]MessageHandler),
		stats:           &NetworkStats{},
		discovery: &PeerDiscovery{
			bootstrapNodes: bootstrapNodes,
			dht:           NewDHT(nodeID),
			mdns:          NewMDNS(),
			upnp:          NewUPnP(),
			natpmp:        NewNATPMP(),
		},
		routing: &RoutingTable{
			routes: make(map[string]*Route),
			graph:  NewNetworkGraph(),
		},
		consensus: &ConsensusEngine{
			validators:      make(map[string]*Validator),
			pendingVotes:   make(map[string][]Vote),
			committedBlocks: make([]Block, 0),
		},
		bandwidth: &BandwidthManager{
			uploadLimit:   100 * 1024 * 1024,   // 100 MB/s
			downloadLimit: 100 * 1024 * 1024,   // 100 MB/s
			peerLimits:    make(map[string]*BandwidthLimit),
			rateLimiters:  make(map[string]*TokenBucket),
		},
	}
	
	// Register default message handlers
	p2p.registerDefaultHandlers()
	
	return p2p, nil
}

// Start starts the P2P network
func (p2p *P2PNetwork) Start() error {
	// Start TCP listener
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", p2p.port))
	if err != nil {
		return fmt.Errorf("failed to start listener: %w", err)
	}
	p2p.listener = listener
	
	// Configure NAT traversal
	go p2p.discovery.configureNAT(p2p.port)
	
	// Start accepting connections
	go p2p.acceptConnections()
	
	// Start peer discovery
	go p2p.discovery.start(p2p.ctx)
	
	// Bootstrap network
	go p2p.bootstrap()
	
	// Start maintenance routines
	go p2p.maintenanceLoop()
	
	return nil
}

// Stop stops the P2P network
func (p2p *P2PNetwork) Stop() error {
	p2p.cancel()
	
	// Close all peer connections
	p2p.mu.Lock()
	for _, peer := range p2p.peers {
		peer.Close()
	}
	p2p.mu.Unlock()
	
	// Close listener
	if p2p.listener != nil {
		p2p.listener.Close()
	}
	
	return nil
}

// Connect connects to a peer
func (p2p *P2PNetwork) Connect(address string) (*Peer, error) {
	// Check if already connected
	p2p.mu.RLock()
	for _, peer := range p2p.peers {
		if peer.Address == address {
			p2p.mu.RUnlock()
			return peer, nil
		}
	}
	p2p.mu.RUnlock()
	
	// Dial peer
	conn, err := net.DialTimeout("tcp", address, 10*time.Second)
	if err != nil {
		atomic.AddUint64(&p2p.stats.ConnectionsFailed, 1)
		return nil, fmt.Errorf("failed to connect: %w", err)
	}
	
	// Create peer
	peer := p2p.createPeer(conn)
	
	// Perform handshake
	if err := p2p.handshake(peer); err != nil {
		peer.Close()
		return nil, fmt.Errorf("handshake failed: %w", err)
	}
	
	// Add to peer list
	p2p.mu.Lock()
	p2p.peers[peer.ID] = peer
	p2p.mu.Unlock()
	
	atomic.AddUint32(&p2p.stats.PeersConnected, 1)
	
	// Start peer handlers
	go p2p.handlePeerMessages(peer)
	go p2p.handlePeerSend(peer)
	
	return peer, nil
}

// Broadcast broadcasts a message to all peers
func (p2p *P2PNetwork) Broadcast(msgType MessageType, payload []byte) error {
	msg := Message{
		Type:      msgType,
		ID:        generateMessageID(),
		From:      p2p.nodeID,
		Timestamp: time.Now().Unix(),
		Payload:   payload,
		Nonce:     generateNonce(),
	}
	
	// Sign message
	msg.Signature = p2p.signMessage(msg)
	
	// Send to all connected peers
	p2p.mu.RLock()
	peers := make([]*Peer, 0, len(p2p.peers))
	for _, peer := range p2p.peers {
		peers = append(peers, peer)
	}
	p2p.mu.RUnlock()
	
	for _, peer := range peers {
		select {
		case peer.sendQueue <- msg:
			atomic.AddUint64(&p2p.stats.MessagessSent, 1)
		case <-time.After(100 * time.Millisecond):
			// Skip slow peers
		}
	}
	
	return nil
}

// SendTo sends a message to a specific peer
func (p2p *P2PNetwork) SendTo(peerID string, msgType MessageType, payload []byte) error {
	p2p.mu.RLock()
	peer, exists := p2p.peers[peerID]
	p2p.mu.RUnlock()
	
	if !exists {
		return errors.New("peer not found")
	}
	
	msg := Message{
		Type:      msgType,
		ID:        generateMessageID(),
		From:      p2p.nodeID,
		To:        peerID,
		Timestamp: time.Now().Unix(),
		Payload:   payload,
		Nonce:     generateNonce(),
	}
	
	// Sign message
	msg.Signature = p2p.signMessage(msg)
	
	select {
	case peer.sendQueue <- msg:
		atomic.AddUint64(&p2p.stats.MessagessSent, 1)
		return nil
	case <-time.After(5 * time.Second):
		return errors.New("send timeout")
	}
}

// acceptConnections accepts incoming connections
func (p2p *P2PNetwork) acceptConnections() {
	for {
		select {
		case <-p2p.ctx.Done():
			return
		default:
			conn, err := p2p.listener.Accept()
			if err != nil {
				if p2p.ctx.Err() != nil {
					return
				}
				continue
			}
			
			go p2p.handleIncomingConnection(conn)
		}
	}
}

// handleIncomingConnection handles incoming connection
func (p2p *P2PNetwork) handleIncomingConnection(conn net.Conn) {
	// Create peer
	peer := p2p.createPeer(conn)
	
	// Perform handshake
	if err := p2p.handshake(peer); err != nil {
		peer.Close()
		return
	}
	
	// Check peer limit
	p2p.mu.Lock()
	if len(p2p.peers) >= 100 {
		p2p.mu.Unlock()
		peer.Close()
		return
	}
	
	// Add to peer list
	p2p.peers[peer.ID] = peer
	p2p.mu.Unlock()
	
	atomic.AddUint32(&p2p.stats.PeersConnected, 1)
	
	// Start peer handlers
	go p2p.handlePeerMessages(peer)
	go p2p.handlePeerSend(peer)
}

// createPeer creates a new peer
func (p2p *P2PNetwork) createPeer(conn net.Conn) *Peer {
	ctx, cancel := context.WithCancel(p2p.ctx)
	
	return &Peer{
		Conn:         conn,
		Address:      conn.RemoteAddr().String(),
		State:        PeerStateConnecting,
		LastSeen:     time.Now(),
		sendQueue:    make(chan Message, 100),
		receiveQueue: make(chan Message, 100),
		ctx:          ctx,
		cancel:       cancel,
	}
}

// handshake performs peer handshake
func (p2p *P2PNetwork) handshake(peer *Peer) error {
	peer.State = PeerStateHandshaking
	
	// Send handshake message
	handshake := map[string]interface{}{
		"node_id":      p2p.nodeID,
		"version":      "1.0.0",
		"capabilities": []string{"mining", "consensus", "relay"},
		"timestamp":    time.Now().Unix(),
	}
	
	handshakeData, _ := json.Marshal(handshake)
	
	msg := Message{
		Type:      MessageTypeHandshake,
		ID:        generateMessageID(),
		From:      p2p.nodeID,
		Timestamp: time.Now().Unix(),
		Payload:   handshakeData,
	}
	
	// Send handshake
	if err := p2p.sendMessage(peer.Conn, msg); err != nil {
		return err
	}
	
	// Receive handshake response
	response, err := p2p.receiveMessage(peer.Conn)
	if err != nil {
		return err
	}
	
	if response.Type != MessageTypeHandshake {
		return errors.New("invalid handshake response")
	}
	
	// Parse handshake data
	var peerHandshake map[string]interface{}
	if err := json.Unmarshal(response.Payload, &peerHandshake); err != nil {
		return err
	}
	
	// Update peer info
	peer.ID = peerHandshake["node_id"].(string)
	peer.Version = peerHandshake["version"].(string)
	if caps, ok := peerHandshake["capabilities"].([]interface{}); ok {
		peer.Capabilities = make([]string, len(caps))
		for i, cap := range caps {
			peer.Capabilities[i] = cap.(string)
		}
	}
	
	peer.State = PeerStateConnected
	return nil
}

// handlePeerMessages handles incoming messages from peer
func (p2p *P2PNetwork) handlePeerMessages(peer *Peer) {
	defer func() {
		p2p.removePeer(peer)
		peer.Close()
	}()
	
	for {
		select {
		case <-peer.ctx.Done():
			return
		default:
			// Receive message
			msg, err := p2p.receiveMessage(peer.Conn)
			if err != nil {
				if err != io.EOF {
					// Log error
				}
				return
			}
			
			// Update stats
			atomic.AddUint64(&p2p.stats.MessagesReceived, 1)
			atomic.AddUint64(&p2p.stats.BytesReceived, uint64(len(msg.Payload)))
			
			// Update peer last seen
			peer.LastSeen = time.Now()
			
			// Handle message
			if handler, exists := p2p.messageHandlers[msg.Type]; exists {
				go handler(peer, msg)
			}
		}
	}
}

// handlePeerSend handles outgoing messages to peer
func (p2p *P2PNetwork) handlePeerSend(peer *Peer) {
	for {
		select {
		case <-peer.ctx.Done():
			return
		case msg := <-peer.sendQueue:
			if err := p2p.sendMessage(peer.Conn, msg); err != nil {
				return
			}
			
			// Update stats
			atomic.AddUint64(&p2p.stats.BytesSent, uint64(len(msg.Payload)))
		}
	}
}

// sendMessage sends a message over connection
func (p2p *P2PNetwork) sendMessage(conn net.Conn, msg Message) error {
	// Check bandwidth limit
	if !p2p.bandwidth.AllowUpload(len(msg.Payload)) {
		return errors.New("bandwidth limit exceeded")
	}
	
	// Serialize message
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	
	// Write length prefix
	length := uint32(len(data))
	if err := binary.Write(conn, binary.BigEndian, length); err != nil {
		return err
	}
	
	// Write message
	if _, err := conn.Write(data); err != nil {
		return err
	}
	
	return nil
}

// receiveMessage receives a message from connection
func (p2p *P2PNetwork) receiveMessage(conn net.Conn) (Message, error) {
	var msg Message
	
	// Read length prefix
	var length uint32
	if err := binary.Read(conn, binary.BigEndian, &length); err != nil {
		return msg, err
	}
	
	// Sanity check
	if length > 10*1024*1024 { // 10MB max
		return msg, errors.New("message too large")
	}
	
	// Check bandwidth limit
	if !p2p.bandwidth.AllowDownload(int(length)) {
		return msg, errors.New("bandwidth limit exceeded")
	}
	
	// Read message
	data := make([]byte, length)
	if _, err := io.ReadFull(conn, data); err != nil {
		return msg, err
	}
	
	// Deserialize message
	if err := json.Unmarshal(data, &msg); err != nil {
		return msg, err
	}
	
	return msg, nil
}

// removePeer removes a peer from the network
func (p2p *P2PNetwork) removePeer(peer *Peer) {
	p2p.mu.Lock()
	delete(p2p.peers, peer.ID)
	p2p.mu.Unlock()
	
	atomic.AddUint32(&p2p.stats.PeersConnected, ^uint32(0))
}

// bootstrap bootstraps the network
func (p2p *P2PNetwork) bootstrap() {
	for _, node := range p2p.discovery.bootstrapNodes {
		if _, err := p2p.Connect(node); err != nil {
			// Log error
		}
	}
}

// maintenanceLoop performs periodic maintenance
func (p2p *P2PNetwork) maintenanceLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-p2p.ctx.Done():
			return
		case <-ticker.C:
			p2p.maintenance()
		}
	}
}

// maintenance performs network maintenance
func (p2p *P2PNetwork) maintenance() {
	// Ping peers
	p2p.pingPeers()
	
	// Remove stale peers
	p2p.removeStalePeers()
	
	// Discover new peers
	p2p.discoverPeers()
	
	// Update routing table
	p2p.updateRouting()
}

// pingPeers pings all connected peers
func (p2p *P2PNetwork) pingPeers() {
	p2p.mu.RLock()
	peers := make([]*Peer, 0, len(p2p.peers))
	for _, peer := range p2p.peers {
		peers = append(peers, peer)
	}
	p2p.mu.RUnlock()
	
	for _, peer := range peers {
		go func(p *Peer) {
			start := time.Now()
			if err := p2p.SendTo(p.ID, MessageTypePing, []byte{}); err == nil {
				// Wait for pong
				// Update latency
				p.Latency = time.Since(start)
			}
		}(peer)
	}
}

// removeStale Peers removes inactive peers
func (p2p *P2PNetwork) removeStalePeers() {
	threshold := time.Now().Add(-5 * time.Minute)
	
	p2p.mu.Lock()
	for id, peer := range p2p.peers {
		if peer.LastSeen.Before(threshold) {
			peer.Close()
			delete(p2p.peers, id)
		}
	}
	p2p.mu.Unlock()
}

// discoverPeers discovers new peers
func (p2p *P2PNetwork) discoverPeers() {
	// Request peers from connected nodes
	p2p.Broadcast(MessageTypeGetPeers, []byte{})
}

// updateRouting updates routing table
func (p2p *P2PNetwork) updateRouting() {
	p2p.routing.Update(p2p.peers)
}

// signMessage signs a message
func (p2p *P2PNetwork) signMessage(msg Message) []byte {
	// Simplified signature
	data := fmt.Sprintf("%d:%s:%s:%d", msg.Type, msg.ID, msg.From, msg.Timestamp)
	hash := sha256.Sum256([]byte(data))
	return hash[:]
}

// registerDefaultHandlers registers default message handlers
func (p2p *P2PNetwork) registerDefaultHandlers() {
	// Ping handler
	p2p.messageHandlers[MessageTypePing] = func(peer *Peer, msg Message) error {
		return p2p.SendTo(peer.ID, MessageTypePong, []byte{})
	}
	
	// Pong handler
	p2p.messageHandlers[MessageTypePong] = func(peer *Peer, msg Message) error {
		// Update peer latency
		return nil
	}
	
	// GetPeers handler
	p2p.messageHandlers[MessageTypeGetPeers] = func(peer *Peer, msg Message) error {
		// Send known peers
		p2p.mu.RLock()
		peerList := make([]string, 0, len(p2p.peers))
		for _, p := range p2p.peers {
			if p.ID != peer.ID {
				peerList = append(peerList, p.Address)
			}
		}
		p2p.mu.RUnlock()
		
		data, _ := json.Marshal(peerList)
		return p2p.SendTo(peer.ID, MessageTypePeers, data)
	}
	
	// Peers handler
	p2p.messageHandlers[MessageTypePeers] = func(peer *Peer, msg Message) error {
		var peerList []string
		if err := json.Unmarshal(msg.Payload, &peerList); err != nil {
			return err
		}
		
		// Connect to new peers
		for _, addr := range peerList {
			go p2p.Connect(addr)
		}
		
		return nil
	}
}

// Peer methods

// Close closes the peer connection
func (p *Peer) Close() {
	p.cancel()
	if p.Conn != nil {
		p.Conn.Close()
	}
	p.State = PeerStateDisconnected
}

// Helper functions

func generateNodeID() string {
	b := make([]byte, 32)
	rand.Read(b)
	hash := sha256.Sum256(b)
	return fmt.Sprintf("%x", hash)
}

func generateMessageID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func generateNonce() uint64 {
	var nonce uint64
	binary.Read(rand.Reader, binary.BigEndian, &nonce)
	return nonce
}

// DHT methods

func NewDHT(nodeID string) *DHT {
	return &DHT{
		nodeID:      nodeID,
		buckets:     make([]*KBucket, 256),
		dataStore:   make(map[string][]byte),
		replication: 3,
	}
}

// Other component constructors

func NewMDNS() *MDNS {
	return &MDNS{}
}

func NewUPnP() *UPnP {
	return &UPnP{}
}

func NewNATPMP() *NATPMP {
	return &NATPMP{}
}

func NewNetworkGraph() *NetworkGraph {
	return &NetworkGraph{
		nodes: make(map[string]*GraphNode),
		edges: make(map[string]map[string]*GraphEdge),
	}
}

// RoutingTable methods

func (rt *RoutingTable) Update(peers map[string]*Peer) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	
	// Update routes based on peer connections
	for id, peer := range peers {
		rt.routes[id] = &Route{
			Destination: id,
			NextHop:     id,
			Metric:      1,
			LastUpdated: time.Now(),
		}
	}
}

// BandwidthManager methods

func (bm *BandwidthManager) AllowUpload(size int) bool {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	
	if bm.uploadUsed+int64(size) > bm.uploadLimit {
		return false
	}
	
	bm.uploadUsed += int64(size)
	return true
}

func (bm *BandwidthManager) AllowDownload(size int) bool {
	bm.mu.Lock()
	defer bm.mu.Unlock()
	
	if bm.downloadUsed+int64(size) > bm.downloadLimit {
		return false
	}
	
	bm.downloadUsed += int64(size)
	return true
}

// PeerDiscovery methods

func (pd *PeerDiscovery) start(ctx context.Context) {
	// Start mDNS discovery
	go pd.mdns.Start(ctx)
	
	// Start DHT
	go pd.dht.Start(ctx)
}

func (pd *PeerDiscovery) configureNAT(port int) {
	// Try UPnP
	if err := pd.upnp.AddPortMapping(port); err != nil {
		// Try NAT-PMP
		pd.natpmp.AddPortMapping(port)
	}
}

// Stub implementations for discovery mechanisms

type MDNS struct{}

func (m *MDNS) Start(ctx context.Context) {}

type UPnP struct{}

func (u *UPnP) AddPortMapping(port int) error { return nil }

type NATPMP struct{}

func (n *NATPMP) AddPortMapping(port int) error { return nil }

func (d *DHT) Start(ctx context.Context) {}