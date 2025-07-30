package p2p

import (
	"context"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// SimpleDiscovery provides lightweight peer discovery
// Following Rob Pike's principle: "Don't communicate by sharing memory; share memory by communicating"
type SimpleDiscovery struct {
	logger      *zap.Logger
	localPeerID string
	listenAddr  string
	
	// Known peers
	peers      map[string]*PeerInfo
	peersMutex sync.RWMutex
	
	// Bootstrap nodes
	bootstrapNodes []string
	
	// Discovery settings
	maxPeers        int
	discoveryPeriod time.Duration
	
	// State
	running atomic.Bool
	ctx     context.Context
	cancel  context.CancelFunc
}

// PeerInfo contains information about a peer
type PeerInfo struct {
	ID         string
	Address    string
	LastSeen   time.Time
	Reputation int
	Active     bool
}

// NewSimpleDiscovery creates a new discovery service
func NewSimpleDiscovery(logger *zap.Logger, peerID, listenAddr string) *SimpleDiscovery {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &SimpleDiscovery{
		logger:          logger,
		localPeerID:     peerID,
		listenAddr:      listenAddr,
		peers:           make(map[string]*PeerInfo),
		maxPeers:        100,
		discoveryPeriod: 30 * time.Second,
		ctx:             ctx,
		cancel:          cancel,
	}
}

// SetBootstrapNodes sets the bootstrap nodes
func (sd *SimpleDiscovery) SetBootstrapNodes(nodes []string) {
	sd.bootstrapNodes = nodes
}

// Start starts the discovery service
func (sd *SimpleDiscovery) Start() error {
	if !sd.running.CompareAndSwap(false, true) {
		return fmt.Errorf("discovery already running")
	}
	
	// Connect to bootstrap nodes
	sd.connectToBootstrapNodes()
	
	// Start discovery routine
	go sd.discoveryLoop()
	
	// Start peer maintenance routine
	go sd.peerMaintenanceLoop()
	
	// Start UDP listener for peer announcements
	go sd.listenForAnnouncements()
	
	sd.logger.Info("Discovery service started",
		zap.String("peer_id", sd.localPeerID),
		zap.String("listen_addr", sd.listenAddr),
	)
	
	return nil
}

// Stop stops the discovery service
func (sd *SimpleDiscovery) Stop() {
	if sd.running.CompareAndSwap(true, false) {
		sd.cancel()
		sd.logger.Info("Discovery service stopped")
	}
}

// GetPeers returns a list of known peers
func (sd *SimpleDiscovery) GetPeers(limit int) []PeerInfo {
	sd.peersMutex.RLock()
	defer sd.peersMutex.RUnlock()
	
	peers := make([]PeerInfo, 0, len(sd.peers))
	for _, peer := range sd.peers {
		if peer.Active {
			peers = append(peers, *peer)
			if limit > 0 && len(peers) >= limit {
				break
			}
		}
	}
	
	return peers
}

// AddPeer adds a new peer
func (sd *SimpleDiscovery) AddPeer(peerID, address string) {
	sd.peersMutex.Lock()
	defer sd.peersMutex.Unlock()
	
	if peerID == sd.localPeerID {
		return // Don't add self
	}
	
	if peer, exists := sd.peers[peerID]; exists {
		// Update existing peer
		peer.LastSeen = time.Now()
		peer.Active = true
	} else {
		// Add new peer
		sd.peers[peerID] = &PeerInfo{
			ID:         peerID,
			Address:    address,
			LastSeen:   time.Now(),
			Reputation: 0,
			Active:     true,
		}
		
		sd.logger.Debug("Added new peer",
			zap.String("peer_id", peerID),
			zap.String("address", address),
		)
	}
}

// RemovePeer removes a peer
func (sd *SimpleDiscovery) RemovePeer(peerID string) {
	sd.peersMutex.Lock()
	defer sd.peersMutex.Unlock()
	
	delete(sd.peers, peerID)
}

// Private methods

func (sd *SimpleDiscovery) connectToBootstrapNodes() {
	for _, node := range sd.bootstrapNodes {
		go func(addr string) {
			if err := sd.connectToPeer(addr); err != nil {
				sd.logger.Warn("Failed to connect to bootstrap node",
					zap.String("address", addr),
					zap.Error(err),
				)
			}
		}(node)
	}
}

func (sd *SimpleDiscovery) connectToPeer(address string) error {
	conn, err := net.DialTimeout("tcp", address, 10*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	
	// Send handshake
	handshake := fmt.Sprintf("HELLO %s %s\n", sd.localPeerID, sd.listenAddr)
	if _, err := conn.Write([]byte(handshake)); err != nil {
		return err
	}
	
	// Read response
	buf := make([]byte, 1024)
	n, err := conn.Read(buf)
	if err != nil {
		return err
	}
	
	// Parse peer list from response
	sd.parsePeerList(string(buf[:n]))
	
	return nil
}

func (sd *SimpleDiscovery) parsePeerList(data string) {
	// Simple format: PEERS peer1:addr1,peer2:addr2,...
	// This is a simplified implementation
	// Real implementation would use proper protocol
}

func (sd *SimpleDiscovery) discoveryLoop() {
	ticker := time.NewTicker(sd.discoveryPeriod)
	defer ticker.Stop()
	
	for {
		select {
		case <-sd.ctx.Done():
			return
		case <-ticker.C:
			sd.discoverNewPeers()
		}
	}
}

func (sd *SimpleDiscovery) discoverNewPeers() {
	// Get current peers
	peers := sd.GetPeers(10)
	
	// Ask each peer for their peer list
	for _, peer := range peers {
		go func(p PeerInfo) {
			if err := sd.requestPeerList(p); err != nil {
				sd.logger.Debug("Failed to get peer list",
					zap.String("peer_id", p.ID),
					zap.Error(err),
				)
			}
		}(peer)
	}
}

func (sd *SimpleDiscovery) requestPeerList(peer PeerInfo) error {
	conn, err := net.DialTimeout("tcp", peer.Address, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	
	// Send peer list request
	if _, err := conn.Write([]byte("GETPEERS\n")); err != nil {
		return err
	}
	
	// Read response
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return err
	}
	
	// Parse and add new peers
	sd.parsePeerList(string(buf[:n]))
	
	return nil
}

func (sd *SimpleDiscovery) peerMaintenanceLoop() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-sd.ctx.Done():
			return
		case <-ticker.C:
			sd.cleanupInactivePeers()
		}
	}
}

func (sd *SimpleDiscovery) cleanupInactivePeers() {
	sd.peersMutex.Lock()
	defer sd.peersMutex.Unlock()
	
	now := time.Now()
	for peerID, peer := range sd.peers {
		if now.Sub(peer.LastSeen) > 5*time.Minute {
			peer.Active = false
			
			// Remove very old peers
			if now.Sub(peer.LastSeen) > 30*time.Minute {
				delete(sd.peers, peerID)
				sd.logger.Debug("Removed inactive peer",
					zap.String("peer_id", peerID),
				)
			}
		}
	}
}

func (sd *SimpleDiscovery) listenForAnnouncements() {
	// Listen on UDP for peer announcements
	addr, err := net.ResolveUDPAddr("udp", ":30303")
	if err != nil {
		sd.logger.Error("Failed to resolve UDP address", zap.Error(err))
		return
	}
	
	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		sd.logger.Error("Failed to listen for announcements", zap.Error(err))
		return
	}
	defer conn.Close()
	
	buf := make([]byte, 1024)
	for sd.running.Load() {
		conn.SetReadDeadline(time.Now().Add(1 * time.Second))
		n, remoteAddr, err := conn.ReadFromUDP(buf)
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			sd.logger.Error("Failed to read UDP", zap.Error(err))
			continue
		}
		
		// Parse announcement
		sd.handleAnnouncement(buf[:n], remoteAddr)
	}
}

func (sd *SimpleDiscovery) handleAnnouncement(data []byte, addr *net.UDPAddr) {
	// Simple format: ANNOUNCE peer_id listen_port
	// Real implementation would validate and verify
}

// MDNSDiscovery provides local network discovery using mDNS
type MDNSDiscovery struct {
	logger  *zap.Logger
	service string
	port    int
	
	discovered chan PeerInfo
}

// NewMDNSDiscovery creates a new mDNS discovery service
func NewMDNSDiscovery(logger *zap.Logger, service string, port int) *MDNSDiscovery {
	return &MDNSDiscovery{
		logger:     logger,
		service:    service,
		port:       port,
		discovered: make(chan PeerInfo, 10),
	}
}

// Start starts mDNS discovery
func (md *MDNSDiscovery) Start() error {
	// Simplified mDNS implementation
	// Real implementation would use proper mDNS library
	go md.broadcast()
	go md.listen()
	return nil
}

// GetDiscoveredPeers returns a channel of discovered peers
func (md *MDNSDiscovery) GetDiscoveredPeers() <-chan PeerInfo {
	return md.discovered
}

func (md *MDNSDiscovery) broadcast() {
	// Broadcast our presence on local network
	// Simplified implementation
}

func (md *MDNSDiscovery) listen() {
	// Listen for other peers on local network
	// Simplified implementation
}

// DHT provides a simple distributed hash table for peer discovery
type SimpleDHT struct {
	logger      *zap.Logger
	nodeID      string
	routingTable map[string]*DHTNode
	mu          sync.RWMutex
}

// DHTNode represents a node in the DHT
type DHTNode struct {
	ID       string
	Address  string
	Distance int // XOR distance from our node ID
	LastSeen time.Time
}

// NewSimpleDHT creates a new DHT
func NewSimpleDHT(logger *zap.Logger, nodeID string) *SimpleDHT {
	return &SimpleDHT{
		logger:       logger,
		nodeID:       nodeID,
		routingTable: make(map[string]*DHTNode),
	}
}

// FindNode finds nodes close to a target ID
func (dht *SimpleDHT) FindNode(targetID string) []DHTNode {
	dht.mu.RLock()
	defer dht.mu.RUnlock()
	
	// Return k closest nodes to target
	// Simplified implementation - just return some nodes
	nodes := make([]DHTNode, 0, 8)
	for _, node := range dht.routingTable {
		nodes = append(nodes, *node)
		if len(nodes) >= 8 {
			break
		}
	}
	
	return nodes
}

// AddNode adds a node to the routing table
func (dht *SimpleDHT) AddNode(node DHTNode) {
	dht.mu.Lock()
	defer dht.mu.Unlock()
	
	dht.routingTable[node.ID] = &node
}

// Bootstrap connects to initial nodes
func (dht *SimpleDHT) Bootstrap(bootstrapNodes []string) {
	for _, addr := range bootstrapNodes {
		// Connect and exchange routing information
		// Simplified implementation
	}
}