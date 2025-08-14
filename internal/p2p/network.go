//go:build legacy_p2p
// +build legacy_p2p

package p2p

// Legacy-only P2P module: excluded from production builds.
// See internal/legacy/README.md for details.
import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/discovery/mdns"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	"github.com/multiformats/go-multiaddr"
)

// NetworkConfig holds P2P network configuration
type NetworkConfig struct {
	ListenAddr   string
	BootstrapPeers []string
	PrivateKey   crypto.PrivKey
	PublicKey    crypto.PubKey
	ProtocolID   protocol.ID
}

// Peer represents a network peer
type Peer struct {
	ID       peer.ID
	Address  multiaddr.Multiaddr
	Latency  time.Duration
	LastSeen time.Time
}

// Network manages P2P network connections and messaging
type Network struct {
	host      host.Host
	config    *NetworkConfig
	peers     map[peer.ID]*Peer
	peerMutex sync.RWMutex
	ctx       context.Context
	cancel    context.CancelFunc
	
	// Channels for communication
	incomingMessages chan *Message
	outgoingMessages chan *Message
	peerConnected    chan *Peer
	peerDisconnected chan peer.ID
}

// Message represents a network message
type Message struct {
	From    peer.ID
	To      peer.ID
	Type    string
	Data    []byte
	Time    time.Time
}

// NewNetwork creates a new P2P network instance
func NewNetwork(config *NetworkConfig) (*Network, error) {
	ctx, cancel := context.WithCancel(context.Background())
	
	n := &Network{
		config:           config,
		peers:            make(map[peer.ID]*Peer),
		ctx:              ctx,
		cancel:           cancel,
		incomingMessages: make(chan *Message, 1000),
		outgoingMessages: make(chan *Message, 1000),
		peerConnected:    make(chan *Peer, 100),
		peerDisconnected: make(chan peer.ID, 100),
	}

	// Initialize libp2p host
	host, err := libp2p.New(
		libp2p.ListenAddrStrings(config.ListenAddr),
		libp2p.Identity(config.PrivateKey),
		libp2p.Security(noise.ID, noise.New),
		libp2p.DefaultTransports,
		libp2p.DefaultMuxers,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create libp2p host: %w", err)
	}

	n.host = host

	// Set up protocol handlers
	n.setupProtocolHandlers()

	// Start peer discovery
	n.startPeerDiscovery()

	// Start message processing
	n.startMessageProcessing()

	return n, nil
}

// Start begins network operations
func (n *Network) Start() error {
	log.Printf("Starting P2P network on %s", n.host.Addrs())
	
	// Connect to bootstrap peers
	if err := n.connectToBootstrapPeers(); err != nil {
		log.Printf("Warning: failed to connect to some bootstrap peers: %v", err)
	}

	// Start background goroutines
	go n.peerManager()
	go n.messageBroadcaster()
	go n.healthChecker()

	return nil
}

// Stop gracefully shuts down the network
func (n *Network) Stop() error {
	n.cancel()
	return n.host.Close()
}

// Broadcast sends a message to all connected peers
func (n *Network) Broadcast(msgType string, data []byte) error {
	msg := &Message{
		From: n.host.ID(),
		Type: msgType,
		Data: data,
		Time: time.Now(),
	}

	select {
	case n.outgoingMessages <- msg:
		return nil
	case <-time.After(100 * time.Millisecond):
		return fmt.Errorf("message queue full")
	}
}

// SendToPeer sends a message to a specific peer
func (n *Network) SendToPeer(peerID peer.ID, msgType string, data []byte) error {
	msg := &Message{
		From: n.host.ID(),
		To:   peerID,
		Type: msgType,
		Data: data,
		Time: time.Now(),
	}

	select {
	case n.outgoingMessages <- msg:
		return nil
	case <-time.After(100 * time.Millisecond):
		return fmt.Errorf("message queue full")
	}
}

// GetPeerCount returns the current number of connected peers
func (n *Network) GetPeerCount() int {
	n.peerMutex.RLock()
	defer n.peerMutex.RUnlock()
	return len(n.peers)
}

// GetPeers returns a list of connected peers
func (n *Network) GetPeers() []*Peer {
	n.peerMutex.RLock()
	defer n.peerMutex.RUnlock()
	
	peers := make([]*Peer, 0, len(n.peers))
	for _, peer := range n.peers {
		peers = append(peers, peer)
	}
	return peers
}

// setupProtocolHandlers configures protocol message handlers
func (n *Network) setupProtocolHandlers() {
	n.host.SetStreamHandler(n.config.ProtocolID, func(stream network.Stream) {
		defer stream.Close()
		
		// Handle incoming messages
		buf := make([]byte, 1024)
		for {
			n, err := stream.Read(buf)
			if err != nil {
				return
			}

			msg := &Message{
				From: stream.Conn().RemotePeer(),
				Data: buf[:n],
				Time: time.Now(),
			}

			select {
			case n.incomingMessages <- msg:
			case <-time.After(100 * time.Millisecond):
				log.Printf("incoming message queue full")
			}
		}
	})
}

// startPeerDiscovery initializes peer discovery mechanisms
func (n *Network) startPeerDiscovery() {
	// mDNS discovery for local network peers
	service := mdns.NewMdnsService(n.host, "otedama-p2p", mdns.WithRegistration(true))
	
	go func() {
		if err := service.Start(); err != nil {
			log.Printf("mDNS service error: %v", err)
		}
	}()
}

// connectToBootstrapPeers connects to configured bootstrap peers
func (n *Network) connectToBootstrapPeers() error {
	for _, addr := range n.config.BootstrapPeers {
		ma, err := multiaddr.NewMultiaddr(addr)
		if err != nil {
			continue
		}

		peerAddr, err := peer.AddrInfoFromP2pAddr(ma)
		if err != nil {
			continue
		}

		if err := n.host.Connect(n.ctx, *peerAddr); err != nil {
			log.Printf("Failed to connect to bootstrap peer %s: %v", addr, err)
			continue
		}

		n.addPeer(&Peer{
			ID:       peerAddr.ID,
			Address:  ma,
			LastSeen: time.Now(),
		})
	}
	return nil
}

// addPeer adds a new peer to the peer list
func (n *Network) addPeer(peer *Peer) {
	n.peerMutex.Lock()
	defer n.peerMutex.Unlock()
	n.peers[peer.ID] = peer
}

// removePeer removes a peer from the peer list
func (n *Network) removePeer(peerID peer.ID) {
	n.peerMutex.Lock()
	defer n.peerMutex.Unlock()
	delete(n.peers, peerID)
}

// peerManager manages peer connections and health
func (n *Network) peerManager() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			n.checkPeerHealth()
		}
	}
}

// checkPeerHealth performs health checks on connected peers
func (n *Network) checkPeerHealth() {
	n.peerMutex.Lock()
	defer n.peerMutex.Unlock()

	now := time.Now()
	for id, peer := range n.peers {
		if now.Sub(peer.LastSeen) > 5*time.Minute {
			delete(n.peers, id)
			n.peerDisconnected <- id
		}
	}
}

// messageBroadcaster broadcasts messages to connected peers
func (n *Network) messageBroadcaster() {
	for {
		select {
		case <-n.ctx.Done():
			return
		case msg := <-n.outgoingMessages:
			n.broadcastMessage(msg)
		}
	}
}

// broadcastMessage sends a message to all connected peers
func (n *Network) broadcastMessage(msg *Message) {
	n.peerMutex.RLock()
	defer n.peerMutex.RUnlock()

	for peerID := range n.peers {
		if msg.To != "" && msg.To != peerID {
			continue
		}

		stream, err := n.host.NewStream(n.ctx, peerID, n.config.ProtocolID)
		if err != nil {
			log.Printf("Failed to create stream to peer %s: %v", peerID, err)
			continue
		}

		_, err = stream.Write(msg.Data)
		stream.Close()
		if err != nil {
			log.Printf("Failed to send message to peer %s: %v", peerID, err)
			continue
		}
	}
}

// messageProcessing processes incoming messages
func (n *Network) startMessageProcessing() {
	go func() {
		for {
			select {
			case <-n.ctx.Done():
				return
			case msg := <-n.incomingMessages:
				n.processMessage(msg)
			}
		}
	}
}

// processMessage handles an incoming message
func (n *Network) processMessage(msg *Message) {
	// Route message based on type
	switch msg.Type {
	case "mining_job":
		n.handleMiningJob(msg)
	case "mining_result":
		n.handleMiningResult(msg)
	case "peer_info":
		n.handlePeerInfo(msg)
	case "heartbeat":
		n.handleHeartbeat(msg)
	default:
		log.Printf("Unknown message type: %s", msg.Type)
	}
}

// handleMiningJob processes mining job messages
func (n *Network) handleMiningJob(msg *Message) {
	// Implementation for handling mining job distribution
	log.Printf("Received mining job from %s", msg.From)
}

// handleMiningResult processes mining result messages
func (n *Network) handleMiningResult(msg *Message) {
	// Implementation for handling mining results
	log.Printf("Received mining result from %s", msg.From)
}

// handlePeerInfo processes peer information messages
func (n *Network) handlePeerInfo(msg *Message) {
	// Implementation for handling peer information
	log.Printf("Received peer info from %s", msg.From)
}

// handleHeartbeat processes heartbeat messages
func (n *Network) handleHeartbeat(msg *Message) {
	n.peerMutex.Lock()
	defer n.peerMutex.Unlock()
	
	if peer, exists := n.peers[msg.From]; exists {
		peer.LastSeen = time.Now()
	}
}

// healthChecker monitors overall network health
func (n *Network) healthChecker() {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-n.ctx.Done():
			return
		case <-ticker.C:
			n.logNetworkHealth()
		}
	}
}

// logNetworkHealth logs current network health metrics
func (n *Network) logNetworkHealth() {
	peerCount := n.GetPeerCount()
	log.Printf("Network health: %d connected peers", peerCount)
}

// GetNetworkStats returns current network statistics
func (n *Network) GetNetworkStats() map[string]interface{} {
	n.peerMutex.RLock()
	defer n.peerMutex.RUnlock()

	return map[string]interface{}{
		"peer_count":     len(n.peers),
		"local_address":  n.host.Addrs(),
		"peer_id":        n.host.ID().String(),
		"protocols":      n.host.Mux().Protocols(),
	}
}
