// Package p2p implements secure, high-performance P2P networking
// Following Rob Pike's simplicity and concurrency principles
package p2p

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/crypto/nacl/box"
	"golang.org/x/time/rate"
)

// Network represents a secure P2P network node
type Network struct {
	logger   *zap.Logger
	config   *NetworkConfig
	
	// Network state
	listener net.Listener
	peers    *PeerManager
	router   *MessageRouter
	
	// Security
	identity *Identity
	limiter  *rate.Limiter
	
	// Lifecycle
	ctx      context.Context
	cancel   context.CancelFunc
	running  atomic.Bool
	wg       sync.WaitGroup
}

// NetworkConfig holds network configuration
type NetworkConfig struct {
	ListenAddr      string
	MaxPeers        int
	MaxMessageSize  int
	TLSEnabled      bool
	TLSCert         string
	TLSKey          string
	RateLimitPerSec int
}

// NewNetwork creates a new P2P network node
func NewNetwork(logger *zap.Logger, config *NetworkConfig) (*Network, error) {
	if config == nil {
		config = DefaultNetworkConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	network := &Network{
		logger:  logger,
		config:  config,
		ctx:     ctx,
		cancel:  cancel,
		limiter: rate.NewLimiter(rate.Limit(config.RateLimitPerSec), config.RateLimitPerSec),
	}
	
	// Generate identity
	identity, err := GenerateIdentity()
	if err != nil {
		cancel()
		return nil, err
	}
	network.identity = identity
	
	// Initialize components
	network.peers = NewPeerManager(logger, config.MaxPeers)
	network.router = NewMessageRouter(logger)
	
	return network, nil
}

// Start begins network operations
func (n *Network) Start() error {
	if !n.running.CompareAndSwap(false, true) {
		return errors.New("already running")
	}
	
	// Start listener
	listener, err := n.createListener()
	if err != nil {
		n.running.Store(false)
		return err
	}
	n.listener = listener
	
	// Start accepting connections
	n.wg.Add(1)
	go n.acceptLoop()
	
	// Start maintenance
	n.wg.Add(1)
	go n.maintenance()
	
	n.logger.Info("P2P network started",
		zap.String("address", n.config.ListenAddr),
		zap.String("peer_id", n.identity.ID))
	
	return nil
}

// Stop halts network operations
func (n *Network) Stop() error {
	if !n.running.CompareAndSwap(true, false) {
		return errors.New("not running")
	}
	
	n.cancel()
	
	if n.listener != nil {
		n.listener.Close()
	}
	
	n.peers.DisconnectAll()
	
	n.wg.Wait()
	
	n.logger.Info("P2P network stopped")
	return nil
}

// Connect establishes connection to a peer
func (n *Network) Connect(address string) error {
	if !n.running.Load() {
		return errors.New("network not running")
	}
	
	// Rate limiting
	if !n.limiter.Allow() {
		return errors.New("rate limited")
	}
	
	// Dial peer
	conn, err := n.dial(address)
	if err != nil {
		return err
	}
	
	// Create peer
	peer := NewPeer(conn, n.logger)
	
	// Handshake
	if err := n.handshake(peer); err != nil {
		conn.Close()
		return err
	}
	
	// Add peer
	if err := n.peers.Add(peer); err != nil {
		conn.Close()
		return err
	}
	
	// Start peer handler
	n.wg.Add(1)
	go n.handlePeer(peer)
	
	return nil
}

// Broadcast sends message to all peers
func (n *Network) Broadcast(msg *Message) error {
	if !n.running.Load() {
		return errors.New("network not running")
	}
	
	peers := n.peers.GetAll()
	var lastErr error
	
	for _, peer := range peers {
		if err := peer.Send(msg); err != nil {
			lastErr = err
		}
	}
	
	return lastErr
}

// GetPeers returns connected peers
func (n *Network) GetPeers() []*Peer {
	return n.peers.GetAll()
}

// GetPeerCount returns number of connected peers
func (n *Network) GetPeerCount() int {
	return n.peers.Count()
}

// Private methods

func (n *Network) createListener() (net.Listener, error) {
	if n.config.TLSEnabled {
		cert, err := tls.LoadX509KeyPair(n.config.TLSCert, n.config.TLSKey)
		if err != nil {
			return nil, err
		}
		
		tlsConfig := &tls.Config{
			Certificates: []tls.Certificate{cert},
			MinVersion:   tls.VersionTLS13,
		}
		
		return tls.Listen("tcp", n.config.ListenAddr, tlsConfig)
	}
	
	return net.Listen("tcp", n.config.ListenAddr)
}

func (n *Network) dial(address string) (net.Conn, error) {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	
	if n.config.TLSEnabled {
		tlsConfig := &tls.Config{
			MinVersion: tls.VersionTLS13,
		}
		return tls.DialWithDialer(dialer, "tcp", address, tlsConfig)
	}
	
	return dialer.Dial("tcp", address)
}

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
		
		// Handle connection
		n.wg.Add(1)
		go n.handleConnection(conn)
	}
}

func (n *Network) handleConnection(conn net.Conn) {
	defer n.wg.Done()
	
	// Rate limiting
	if !n.limiter.Allow() {
		conn.Close()
		return
	}
	
	// Create peer
	peer := NewPeer(conn, n.logger)
	
	// Handshake
	if err := n.handshake(peer); err != nil {
		conn.Close()
		n.logger.Debug("Handshake failed", zap.Error(err))
		return
	}
	
	// Add peer
	if err := n.peers.Add(peer); err != nil {
		conn.Close()
		return
	}
	
	// Handle peer
	n.handlePeer(peer)
}

func (n *Network) handlePeer(peer *Peer) {
	defer n.wg.Done()
	defer n.peers.Remove(peer.ID)
	
	n.logger.Debug("Peer connected", zap.String("peer_id", peer.ID))
	
	// Message loop
	for n.running.Load() {
		msg, err := peer.Receive()
		if err != nil {
			if err != io.EOF {
				n.logger.Debug("Receive error", zap.Error(err))
			}
			break
		}
		
		// Route message
		if err := n.router.Route(msg, peer); err != nil {
			n.logger.Debug("Routing error", zap.Error(err))
		}
	}
	
	n.logger.Debug("Peer disconnected", zap.String("peer_id", peer.ID))
}

func (n *Network) handshake(peer *Peer) error {
	// Send our identity
	if err := peer.Send(&Message{
		Type:    MessageHandshake,
		Payload: n.identity.PublicKey[:],
	}); err != nil {
		return err
	}
	
	// Receive peer identity
	msg, err := peer.ReceiveTimeout(5 * time.Second)
	if err != nil {
		return err
	}
	
	if msg.Type != MessageHandshake {
		return errors.New("invalid handshake")
	}
	
	// Set peer public key
	copy(peer.PublicKey[:], msg.Payload)
	
	return nil
}

func (n *Network) maintenance() {
	defer n.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			n.peers.Cleanup()
		case <-n.ctx.Done():
			return
		}
	}
}

// Peer represents a network peer
type Peer struct {
	ID        string
	PublicKey [32]byte
	conn      net.Conn
	logger    *zap.Logger
	
	// Stats
	lastSeen  time.Time
	bytesSent atomic.Uint64
	bytesRecv atomic.Uint64
	
	// Channels
	sendCh chan *Message
	done   chan struct{}
	once   sync.Once
}

// NewPeer creates a new peer
func NewPeer(conn net.Conn, logger *zap.Logger) *Peer {
	return &Peer{
		ID:       conn.RemoteAddr().String(),
		conn:     conn,
		logger:   logger,
		lastSeen: time.Now(),
		sendCh:   make(chan *Message, 100),
		done:     make(chan struct{}),
	}
}

// Send sends a message to the peer
func (p *Peer) Send(msg *Message) error {
	select {
	case p.sendCh <- msg:
		return nil
	case <-p.done:
		return errors.New("peer disconnected")
	default:
		return errors.New("send queue full")
	}
}

// Receive receives a message from the peer
func (p *Peer) Receive() (*Message, error) {
	return p.readMessage()
}

// ReceiveTimeout receives with timeout
func (p *Peer) ReceiveTimeout(timeout time.Duration) (*Message, error) {
	p.conn.SetReadDeadline(time.Now().Add(timeout))
	defer p.conn.SetReadDeadline(time.Time{})
	return p.readMessage()
}

// Close closes the peer connection
func (p *Peer) Close() {
	p.once.Do(func() {
		close(p.done)
		p.conn.Close()
	})
}

func (p *Peer) readMessage() (*Message, error) {
	// Read header
	header := make([]byte, 8)
	if _, err := io.ReadFull(p.conn, header); err != nil {
		return nil, err
	}
	
	// Parse header
	msgType := MessageType(binary.BigEndian.Uint32(header[:4]))
	payloadLen := binary.BigEndian.Uint32(header[4:])
	
	// Validate size
	if payloadLen > MaxMessageSize {
		return nil, errors.New("message too large")
	}
	
	// Read payload
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(p.conn, payload); err != nil {
		return nil, err
	}
	
	p.bytesRecv.Add(uint64(8 + payloadLen))
	p.lastSeen = time.Now()
	
	return &Message{
		Type:    msgType,
		Payload: payload,
	}, nil
}

func (p *Peer) writeMessage(msg *Message) error {
	// Prepare header
	header := make([]byte, 8)
	binary.BigEndian.PutUint32(header[:4], uint32(msg.Type))
	binary.BigEndian.PutUint32(header[4:], uint32(len(msg.Payload)))
	
	// Write header and payload
	if _, err := p.conn.Write(header); err != nil {
		return err
	}
	if _, err := p.conn.Write(msg.Payload); err != nil {
		return err
	}
	
	p.bytesSent.Add(uint64(8 + len(msg.Payload)))
	return nil
}

// PeerManager manages peer connections
type PeerManager struct {
	logger   *zap.Logger
	maxPeers int
	peers    map[string]*Peer
	mu       sync.RWMutex
}

// NewPeerManager creates a peer manager
func NewPeerManager(logger *zap.Logger, maxPeers int) *PeerManager {
	return &PeerManager{
		logger:   logger,
		maxPeers: maxPeers,
		peers:    make(map[string]*Peer),
	}
}

// Add adds a peer
func (pm *PeerManager) Add(peer *Peer) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	if len(pm.peers) >= pm.maxPeers {
		return errors.New("max peers reached")
	}
	
	if _, exists := pm.peers[peer.ID]; exists {
		return errors.New("peer already connected")
	}
	
	pm.peers[peer.ID] = peer
	return nil
}

// Remove removes a peer
func (pm *PeerManager) Remove(id string) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	if peer, exists := pm.peers[id]; exists {
		peer.Close()
		delete(pm.peers, id)
	}
}

// Get returns a peer by ID
func (pm *PeerManager) Get(id string) *Peer {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	return pm.peers[id]
}

// GetAll returns all peers
func (pm *PeerManager) GetAll() []*Peer {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	
	peers := make([]*Peer, 0, len(pm.peers))
	for _, peer := range pm.peers {
		peers = append(peers, peer)
	}
	return peers
}

// Count returns peer count
func (pm *PeerManager) Count() int {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	return len(pm.peers)
}

// DisconnectAll disconnects all peers
func (pm *PeerManager) DisconnectAll() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	for _, peer := range pm.peers {
		peer.Close()
	}
	pm.peers = make(map[string]*Peer)
}

// Cleanup removes stale peers
func (pm *PeerManager) Cleanup() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	
	timeout := 5 * time.Minute
	now := time.Now()
	
	for id, peer := range pm.peers {
		if now.Sub(peer.lastSeen) > timeout {
			peer.Close()
			delete(pm.peers, id)
			pm.logger.Debug("Removed stale peer", zap.String("peer_id", id))
		}
	}
}

// MessageRouter routes messages to handlers
type MessageRouter struct {
	logger   *zap.Logger
	handlers map[MessageType]MessageHandler
	mu       sync.RWMutex
}

// NewMessageRouter creates a message router
func NewMessageRouter(logger *zap.Logger) *MessageRouter {
	return &MessageRouter{
		logger:   logger,
		handlers: make(map[MessageType]MessageHandler),
	}
}

// Register registers a message handler
func (r *MessageRouter) Register(msgType MessageType, handler MessageHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlers[msgType] = handler
}

// Route routes a message to appropriate handler
func (r *MessageRouter) Route(msg *Message, peer *Peer) error {
	r.mu.RLock()
	handler, exists := r.handlers[msg.Type]
	r.mu.RUnlock()
	
	if !exists {
		return errors.New("no handler for message type")
	}
	
	return handler(msg, peer)
}

// Identity represents node identity
type Identity struct {
	ID         string
	PublicKey  [32]byte
	PrivateKey [32]byte
}

// GenerateIdentity generates a new identity
func GenerateIdentity() (*Identity, error) {
	publicKey, privateKey, err := box.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	
	return &Identity{
		ID:         fmt.Sprintf("%x", publicKey[:8]),
		PublicKey:  *publicKey,
		PrivateKey: *privateKey,
	}, nil
}

// Message represents a network message
type Message struct {
	Type    MessageType
	Payload []byte
}

// MessageType defines message types
type MessageType uint32

const (
	MessageHandshake MessageType = iota
	MessagePing
	MessagePong
	MessageJob
	MessageShare
	MessageBlock
)

// MessageHandler handles messages
type MessageHandler func(*Message, *Peer) error

// Constants
const (
	MaxMessageSize = 1 << 20 // 1 MB
)

// DefaultNetworkConfig returns default configuration
func DefaultNetworkConfig() *NetworkConfig {
	return &NetworkConfig{
		ListenAddr:      "0.0.0.0:18555",
		MaxPeers:        100,
		MaxMessageSize:  MaxMessageSize,
		TLSEnabled:      true,
		RateLimitPerSec: 1000,
	}
}
