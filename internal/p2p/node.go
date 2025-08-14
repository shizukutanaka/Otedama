package p2p

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"go.uber.org/zap"
)

// Node represents a P2P node in the mining network
type Node struct {
	host      host.Host
	config    *Config
	logger    *zap.Logger
	ctx       context.Context
	cancel    context.CancelFunc
	
	// Network state
	peers     map[string]*Peer
	peersMu   sync.RWMutex
	
	// Mining coordination
	miningProtocol *MiningProtocol
	shareProtocol  *ShareProtocol
	blockProtocol  *BlockProtocol
	
	// Consensus
	consensus *Consensus
	
	// Resource management
	resourceManager *ResourceManager
	
	// Health monitoring
	healthMonitor *HealthMonitor
}

// Config contains P2P node configuration
type Config struct {
	Port           int
	BootstrapNodes []string
	MaxPeers       int
	ProtocolID     string
	NetworkID      string
}

// NewNode creates a new P2P node
func NewNode(config *Config) *Node {
	ctx, cancel := context.WithCancel(context.Background())
	
	node := &Node{
		config:    config,
		peers:     make(map[string]*Peer),
		ctx:       ctx,
		cancel:    cancel,
	}
	
	// Initialize protocols
	node.miningProtocol = NewMiningProtocol()
	node.shareProtocol = NewShareProtocol()
	node.blockProtocol = NewBlockProtocol()
	
	// Initialize consensus
	node.consensus = NewConsensus()
	
	// Initialize resource management
	node.resourceManager = NewResourceManager()
	
	// Initialize health monitoring
	node.healthMonitor = NewHealthMonitor()
	
	return node
}

// Start starts the P2P node
func (n *Node) Start() error {
	// Create libp2p host
	host, err := libp2p.New(
		libp2p.ListenAddrStrings(fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", n.config.Port)),
		libp2p.EnableAutoRelay(),
		libp2p.EnableNATService(),
	)
	if err != nil {
		return fmt.Errorf("failed to create libp2p host: %w", err)
	}
	
	n.host = host
	
	// Set up protocol handlers
	n.setupProtocolHandlers()
	
	// Connect to bootstrap nodes
	if err := n.connectToBootstrapNodes(); err != nil {
		return fmt.Errorf("failed to connect to bootstrap nodes: %w", err)
	}
	
	// Start health monitoring
	if err := n.healthMonitor.Start(); err != nil {
		return fmt.Errorf("failed to start health monitoring: %w", err)
	}
	
	return nil
}

// Stop stops the P2P node
func (n *Node) Stop() error {
	if n.host != nil {
		return n.host.Close()
	}
	
	n.cancel()
	return nil
}

// setupProtocolHandlers sets up protocol handlers
func (n *Node) setupProtocolHandlers() {
	// Mining protocol handler
	n.host.SetStreamHandler(protocol.ID("/otedama/mining/1.0.0"), func(stream network.Stream) {
		defer stream.Close()
		n.handleMiningStream(stream)
	})
	
	// Share protocol handler
	n.host.SetStreamHandler(protocol.ID("/otedama/share/1.0.0"), func(stream network.Stream) {
		defer stream.Close()
		n.handleShareStream(stream)
	})
	
	// Block protocol handler
	n.host.SetStreamHandler(protocol.ID("/otedama/block/1.0.0"), func(stream network.Stream) {
		defer stream.Close()
		n.handleBlockStream(stream)
	})
	
	// Peer discovery handler
	n.host.SetStreamHandler(protocol.ID("/otedama/discovery/1.0.0"), func(stream network.Stream) {
		defer stream.Close()
		n.handleDiscoveryStream(stream)
	})
}

// handleMiningStream handles mining protocol streams
func (n *Node) handleMiningStream(stream network.Stream) {
	// Read mining request
	var request MiningRequest
	if err := json.NewDecoder(stream).Decode(&request); err != nil {
		n.logger.Error("Failed to decode mining request", zap.Error(err))
		return
	}
	
	// Process mining request
	response := n.miningProtocol.ProcessRequest(request)
	
	// Send response
	if err := json.NewEncoder(stream).Encode(response); err != nil {
		n.logger.Error("Failed to encode mining response", zap.Error(err))
		return
	}
}

// handleShareStream handles share protocol streams
func (n *Node) handleShareStream(stream network.Stream) {
	// Read share submission
	var share ShareSubmission
	if err := json.NewDecoder(stream).Decode(&share); err != nil {
		n.logger.Error("Failed to decode share submission", zap.Error(err))
		return
	}
	
	// Process share
	response := n.shareProtocol.ProcessShare(share)
	
	// Send response
	if err := json.NewEncoder(stream).Encode(response); err != nil {
		n.logger.Error("Failed to encode share response", zap.Error(err))
		return
	}
}

// handleBlockStream handles block protocol streams
func (n *Node) handleBlockStream(stream network.Stream) {
	// Read block announcement
	var block BlockAnnouncement
	if err := json.NewDecoder(stream).Decode(&block); err != nil {
		n.logger.Error("Failed to decode block announcement", zap.Error(err))
		return
	}
	
	// Process block
	response := n.blockProtocol.ProcessBlock(block)
	
	// Send response
	if err := json.NewEncoder(stream).Encode(response); err != nil {
		n.logger.Error("Failed to encode block response", zap.Error(err))
		return
	}
}

// handleDiscoveryStream handles peer discovery streams
func (n *Node) handleDiscoveryStream(stream network.Stream) {
	// Read discovery request
	var request DiscoveryRequest
	if err := json.NewDecoder(stream).Decode(&request); err != nil {
		n.logger.Error("Failed to decode discovery request", zap.Error(err))
		return
	}
	
	// Process discovery request
	response := n.processDiscoveryRequest(request)
	
	// Send response
	if err := json.NewEncoder(stream).Encode(response); err != nil {
		n.logger.Error("Failed to encode discovery response", zap.Error(err))
		return
	}
}

// connectToBootstrapNodes connects to bootstrap nodes
func (n *Node) connectToBootstrapNodes() error {
	for _, addr := range n.config.BootstrapNodes {
		peerInfo, err := peer.AddrInfoFromString(addr)
		if err != nil {
			n.logger.Error("Failed to parse bootstrap node", zap.String("addr", addr), zap.Error(err))
			continue
		}
		
		if err := n.host.Connect(n.ctx, *peerInfo); err != nil {
			n.logger.Error("Failed to connect to bootstrap node", zap.String("addr", addr), zap.Error(err))
			continue
		}
		
		n.logger.Info("Connected to bootstrap node", zap.String("addr", addr))
	}
	
	return nil
}

// ConnectPeer connects to a peer
func (n *Node) ConnectPeer(peerAddress string) error {
	peerInfo, err := peer.AddrInfoFromString(peerAddress)
	if err != nil {
		return fmt.Errorf("failed to parse peer address: %w", err)
	}
	
	if err := n.host.Connect(n.ctx, *peerInfo); err != nil {
		return fmt.Errorf("failed to connect to peer: %w", err)
	}
	
	n.peersMu.Lock()
	n.peers[peerAddress] = &Peer{ID: peerAddress, ConnectedAt: time.Now()}
	n.peersMu.Unlock()
	
	return nil
}

// DisconnectPeer disconnects from a peer
func (n *Node) DisconnectPeer(peerID string) error {
	peerInfo := peer.ID(peerID)
	
	if err := n.host.Network().ClosePeer(peerInfo); err != nil {
		return fmt.Errorf("failed to disconnect from peer: %w", err)
	}
	
	n.peersMu.Lock()
	delete(n.peers, peerID)
	n.peersMu.Unlock()
	
	return nil
}

// GetPeers returns connected peers
func (n *Node) GetPeers() []string {
	n.peersMu.RLock()
	defer n.peersMu.RUnlock()
	
	peers := make([]string, 0, len(n.peers))
	for peerID := range n.peers {
		peers = append(peers, peerID)
	}
	
	return peers
}

// GetPeerCount returns the number of connected peers
func (n *Node) GetPeerCount() int {
	n.peersMu.RLock()
	defer n.peersMu.RUnlock()
	
	return len(n.peers)
}

// BroadcastMiningJob broadcasts a mining job to all peers
func (n *Node) BroadcastMiningJob(job *MiningJob) error {
	jobData, err := json.Marshal(job)
	if err != nil {
		return fmt.Errorf("failed to marshal mining job: %w", err)
	}
	
	// Send to all connected peers
	for peerID := range n.peers {
		if err := n.sendToPeer(peerID, jobData); err != nil {
			n.logger.Error("Failed to send mining job to peer", zap.String("peer", peerID), zap.Error(err))
		}
	}
	
	return nil
}

// BroadcastShare broadcasts a share to all peers
func (n *Node) BroadcastShare(share *Share) error {
	shareData, err := json.Marshal(share)
	if err != nil {
		return fmt.Errorf("failed to marshal share: %w", err)
	}
	
	// Send to all connected peers
	for peerID := range n.peers {
		if err := n.sendToPeer(peerID, shareData); err != nil {
			n.logger.Error("Failed to send share to peer", zap.String("peer", peerID), zap.Error(err))
		}
	}
	
	return nil
}

// BroadcastBlock broadcasts a block to all peers
func (n *Node) BroadcastBlock(block *Block) error {
	blockData, err := json.Marshal(block)
	if err != nil {
		return fmt.Errorf("failed to marshal block: %w", err)
	}
	
	// Send to all connected peers
	for peerID := range n.peers {
		if err := n.sendToPeer(peerID, blockData); err != nil {
			n.logger.Error("Failed to send block to peer", zap.String("peer", peerID), zap.Error(err))
		}
	}
	
	return nil
}

// sendToPeer sends data to a specific peer
func (n *Node) sendToPeer(peerID string, data []byte) error {
	peerAddr := peer.ID(peerID)
	
	// Create stream to peer
	stream, err := n.host.NewStream(n.ctx, peerAddr, protocol.ID("/otedama/data/1.0.0"))
	if err != nil {
		return fmt.Errorf("failed to create stream to peer: %w", err)
	}
	defer stream.Close()
	
	// Send data
	if _, err := stream.Write(data); err != nil {
		return fmt.Errorf("failed to send data to peer: %w", err)
	}
	
	return nil
}

// processDiscoveryRequest processes a discovery request
func (n *Node) processDiscoveryRequest(request DiscoveryRequest) DiscoveryResponse {
	// Get current peers
	peers := n.GetPeers()
	
	// Create response
	response := DiscoveryResponse{
		Peers: peers,
		Timestamp: time.Now(),
	}
	
	return response
}

// HealthCheck performs a health check
func (n *Node) HealthCheck() error {
	// Check host status
	if n.host == nil {
		return fmt.Errorf("host not initialized")
	}
	
	// Check peer connections
	if len(n.host.Network().Peers()) == 0 {
		return fmt.Errorf("no peer connections")
	}
	
	// Check protocol handlers
	for _, protocol := range []string{"/otedama/mining/1.0.0", "/otedama/share/1.0.0", "/otedama/block/1.0.0"} {
		if _, err := n.host.Peerstore().Peers(); err != nil {
			return fmt.Errorf("protocol %s not available: %w", protocol, err)
		}
	}
	
	return nil
}

// GetLocalAddress returns the local address
func (n *Node) GetLocalAddress() string {
	if n.host == nil {
		return ""
	}
	
	addrs := n.host.Addrs()
	if len(addrs) > 0 {
		return addrs[0].String()
	}
	
	return ""
}

// GetPeerInfo returns peer information
func (n *Node) GetPeerInfo() map[string]interface{} {
	info := make(map[string]interface{})
	
	info["local_address"] = n.GetLocalAddress()
	info["peer_count"] = n.GetPeerCount()
	info["peers"] = n.GetPeers()
	
	return info
}

// Close closes the P2P node
func (n *Node) Close() error {
	return n.Stop()
}

// DefaultConfig returns default P2P configuration
func DefaultConfig() *Config {
	return &Config{
		Port:           3334,
		BootstrapNodes: []string{
			"/dns4/node1.otedama.com/tcp/3334/p2p/QmPeer1",
			"/dns4/node2.otedama.com/tcp/3334/p2p/QmPeer2",
		},
		MaxPeers:   50,
		ProtocolID: "otedama",
		NetworkID:  "mainnet",
	}
}
