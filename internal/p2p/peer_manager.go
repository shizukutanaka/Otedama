package p2p

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shizukutanaka/Otedama/internal/core"
	"github.com/shizukutanaka/Otedama/internal/datastructures"
	"go.uber.org/zap"
)

const (
	// Peer management constants
	MaxPeers              = 50
	MinPeers              = 10
	MaxPeersPerIP         = 2
	ConnectionTimeout     = 30 * time.Second
	HandshakeTimeout      = 10 * time.Second
	PingInterval          = 30 * time.Second
	PeerCleanupInterval   = 5 * time.Minute
	ReconnectInterval     = 1 * time.Minute
	MaxReconnectAttempts  = 3
	BanDuration           = 1 * time.Hour
)

// PeerManager manages peer connections
type PeerManager struct {
	logger        *zap.Logger
	nodeID        NodeID
	dht           *DistributedHashTable
	errorHandler  *core.ErrorHandler
	
	// Peer storage
	peers         sync.Map // peerID -> *Peer
	peersByIP     sync.Map // IP -> count
	bannedPeers   sync.Map // peerID -> banTime
	
	// Connection management
	connPool      *ConnectionPool
	incomingConn  chan net.Conn
	
	// Metrics
	metrics       *PeerMetrics
	
	// Control
	maxPeers      int
	listenAddr    string
	listener      net.Listener
	stopCh        chan struct{}
	wg            sync.WaitGroup
}

// Peer represents a connected peer
type Peer struct {
	ID            NodeID
	Addr          net.Addr
	Conn          net.Conn
	State         PeerState
	Version       string
	Capabilities  []string
	
	// Connection info
	ConnectedAt   time.Time
	LastSeen      time.Time
	LastPing      time.Time
	RTT           time.Duration
	
	// Statistics
	BytesSent     atomic.Uint64
	BytesReceived atomic.Uint64
	MessagesSent  atomic.Uint64
	MessagesRecv  atomic.Uint64
	Errors        atomic.Uint32
	
	// Channels
	sendCh        chan Message
	recvCh        chan Message
	errCh         chan error
	closeCh       chan struct{}
	closeOnce     sync.Once
	
	// Mutex for state changes
	mu            sync.RWMutex
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

// PeerMetrics tracks peer-related metrics
type PeerMetrics struct {
	PeersConnected    atomic.Int32
	PeersTotal        atomic.Uint64
	ConnectionsFailed atomic.Uint64
	MessagesTotal     atomic.Uint64
	BytesTotal        atomic.Uint64
	AverageRTT        atomic.Int64 // microseconds
}

// Message represents a P2P message
type Message struct {
	Type      MessageType
	ID        uint64
	Timestamp time.Time
	Payload   []byte
}

// ConnectionPool manages connection reuse
type ConnectionPool struct {
	connections sync.Map // address -> *pooledConn
	maxIdle     time.Duration
	mu          sync.RWMutex
}

type pooledConn struct {
	conn      net.Conn
	lastUsed  time.Time
	inUse     atomic.Bool
}

// NewPeerManager creates a new peer manager
func NewPeerManager(nodeID NodeID, listenAddr string, dht *DistributedHashTable, logger *zap.Logger) *PeerManager {
	pm := &PeerManager{
		logger:       logger,
		nodeID:       nodeID,
		dht:          dht,
		errorHandler: core.NewErrorHandler(logger),
		maxPeers:     MaxPeers,
		listenAddr:   listenAddr,
		incomingConn: make(chan net.Conn, 10),
		stopCh:       make(chan struct{}),
		metrics:      &PeerMetrics{},
		connPool: &ConnectionPool{
			maxIdle: 5 * time.Minute,
		},
	}
	
	return pm
}

// Start starts the peer manager
func (pm *PeerManager) Start(ctx context.Context) error {
	// Start listener
	listener, err := net.Listen("tcp", pm.listenAddr)
	if err != nil {
		return fmt.Errorf("failed to start listener: %w", err)
	}
	pm.listener = listener
	
	// Start background routines
	pm.wg.Add(5)
	go pm.acceptRoutine(ctx)
	go pm.connectionHandler(ctx)
	go pm.pingRoutine(ctx)
	go pm.cleanupRoutine(ctx)
	go pm.discoveryRoutine(ctx)
	
	pm.logger.Info("Peer manager started",
		zap.String("listen_addr", pm.listenAddr),
		zap.String("node_id", fmt.Sprintf("%x", pm.nodeID[:8])))
	
	return nil
}

// Stop stops the peer manager
func (pm *PeerManager) Stop() {
	close(pm.stopCh)
	
	if pm.listener != nil {
		pm.listener.Close()
	}
	
	// Disconnect all peers
	pm.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		pm.disconnectPeer(peer, "shutdown")
		return true
	})
	
	pm.wg.Wait()
	pm.logger.Info("Peer manager stopped")
}

// ConnectPeer connects to a new peer
func (pm *PeerManager) ConnectPeer(addr string) error {
	// Check if we're at max peers
	if pm.metrics.PeersConnected.Load() >= int32(pm.maxPeers) {
		return fmt.Errorf("max peers reached")
	}
	
	// Check connection pool first
	if conn := pm.connPool.Get(addr); conn != nil {
		return pm.handleNewConnection(conn, false)
	}
	
	// Create new connection
	conn, err := net.DialTimeout("tcp", addr, ConnectionTimeout)
	if err != nil {
		pm.metrics.ConnectionsFailed.Add(1)
		return fmt.Errorf("failed to connect: %w", err)
	}
	
	return pm.handleNewConnection(conn, false)
}

// GetPeers returns connected peers
func (pm *PeerManager) GetPeers() []*Peer {
	var peers []*Peer
	
	pm.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		if peer.State == PeerStateConnected {
			peers = append(peers, peer)
		}
		return true
	})
	
	return peers
}

// GetPeer returns a specific peer
func (pm *PeerManager) GetPeer(id NodeID) *Peer {
	if value, ok := pm.peers.Load(id); ok {
		return value.(*Peer)
	}
	return nil
}

// BroadcastMessage broadcasts a message to all connected peers
func (pm *PeerManager) BroadcastMessage(msg Message) {
	peers := pm.GetPeers()
	
	for _, peer := range peers {
		select {
		case peer.sendCh <- msg:
		default:
			pm.logger.Warn("Peer send channel full",
				zap.String("peer_id", fmt.Sprintf("%x", peer.ID[:8])))
		}
	}
	
	pm.metrics.MessagesTotal.Add(uint64(len(peers)))
}

// SendMessage sends a message to a specific peer
func (pm *PeerManager) SendMessage(peerID NodeID, msg Message) error {
	peer := pm.GetPeer(peerID)
	if peer == nil {
		return fmt.Errorf("peer not found")
	}
	
	select {
	case peer.sendCh <- msg:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("send timeout")
	}
}

// GetMetrics returns peer metrics
func (pm *PeerManager) GetMetrics() map[string]interface{} {
	metrics := map[string]interface{}{
		"peers_connected":     pm.metrics.PeersConnected.Load(),
		"peers_total":         pm.metrics.PeersTotal.Load(),
		"connections_failed":  pm.metrics.ConnectionsFailed.Load(),
		"messages_total":      pm.metrics.MessagesTotal.Load(),
		"bytes_total":         pm.metrics.BytesTotal.Load(),
		"average_rtt_us":      pm.metrics.AverageRTT.Load(),
	}
	
	// Per-peer statistics
	peerStats := make(map[string]interface{})
	pm.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		peerID := fmt.Sprintf("%x", peer.ID[:8])
		peerStats[peerID] = map[string]interface{}{
			"state":           peer.State,
			"bytes_sent":      peer.BytesSent.Load(),
			"bytes_received":  peer.BytesReceived.Load(),
			"messages_sent":   peer.MessagesSent.Load(),
			"messages_recv":   peer.MessagesRecv.Load(),
			"errors":          peer.Errors.Load(),
			"rtt_ms":          peer.RTT.Milliseconds(),
			"connected_time":  time.Since(peer.ConnectedAt),
		}
		return true
	})
	metrics["peer_stats"] = peerStats
	
	return metrics
}

// Background routines

func (pm *PeerManager) acceptRoutine(ctx context.Context) {
	defer pm.wg.Done()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-pm.stopCh:
			return
		default:
			conn, err := pm.listener.Accept()
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Temporary() {
					time.Sleep(100 * time.Millisecond)
					continue
				}
				return
			}
			
			// Check if we can accept more connections
			if pm.metrics.PeersConnected.Load() >= int32(pm.maxPeers) {
				conn.Close()
				continue
			}
			
			select {
			case pm.incomingConn <- conn:
			default:
				conn.Close()
			}
		}
	}
}

func (pm *PeerManager) connectionHandler(ctx context.Context) {
	defer pm.wg.Done()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-pm.stopCh:
			return
		case conn := <-pm.incomingConn:
			go pm.handleNewConnection(conn, true)
		}
	}
}

func (pm *PeerManager) handleNewConnection(conn net.Conn, incoming bool) error {
	// Set connection deadline for handshake
	conn.SetDeadline(time.Now().Add(HandshakeTimeout))
	
	// Create peer
	peer := &Peer{
		Conn:        conn,
		Addr:        conn.RemoteAddr(),
		State:       PeerStateHandshaking,
		ConnectedAt: time.Now(),
		LastSeen:    time.Now(),
		sendCh:      make(chan Message, 100),
		recvCh:      make(chan Message, 100),
		errCh:       make(chan error, 10),
		closeCh:     make(chan struct{}),
	}
	
	// Perform handshake
	if err := pm.performHandshake(peer, incoming); err != nil {
		conn.Close()
		return fmt.Errorf("handshake failed: %w", err)
	}
	
	// Check if peer is banned
	if banTime, banned := pm.bannedPeers.Load(peer.ID); banned {
		if time.Now().Before(banTime.(time.Time)) {
			conn.Close()
			return fmt.Errorf("peer is banned")
		}
		pm.bannedPeers.Delete(peer.ID)
	}
	
	// Check if we already have this peer
	if _, exists := pm.peers.Load(peer.ID); exists {
		conn.Close()
		return fmt.Errorf("peer already connected")
	}
	
	// Check peers per IP limit
	ip := getIP(peer.Addr)
	if count, _ := pm.peersByIP.LoadOrStore(ip, int32(0)); count.(int32) >= MaxPeersPerIP {
		conn.Close()
		return fmt.Errorf("too many connections from IP")
	}
	pm.peersByIP.Store(ip, count.(int32)+1)
	
	// Reset deadline
	conn.SetDeadline(time.Time{})
	
	// Store peer
	peer.State = PeerStateConnected
	pm.peers.Store(peer.ID, peer)
	pm.metrics.PeersConnected.Add(1)
	pm.metrics.PeersTotal.Add(1)
	
	// Start peer routines
	go pm.peerReadRoutine(peer)
	go pm.peerWriteRoutine(peer)
	go pm.peerHandleRoutine(peer)
	
	// Add to DHT
	if pm.dht != nil {
		pm.dht.AddNode(&DHTNode{
			ID:       peer.ID,
			IP:       net.ParseIP(ip),
			Port:     getPort(peer.Addr),
			LastSeen: time.Now(),
		})
	}
	
	pm.logger.Info("Peer connected",
		zap.String("peer_id", fmt.Sprintf("%x", peer.ID[:8])),
		zap.String("addr", peer.Addr.String()),
		zap.Bool("incoming", incoming))
	
	return nil
}

func (pm *PeerManager) performHandshake(peer *Peer, incoming bool) error {
	// Send handshake
	handshake := &HandshakeMessage{
		Version:      "1.0.0",
		NodeID:       pm.nodeID,
		Capabilities: []string{"mining", "storage", "relay"},
		Timestamp:    time.Now().Unix(),
	}
	
	if err := writeHandshake(peer.Conn, handshake); err != nil {
		return err
	}
	
	// Read handshake
	remoteHandshake, err := readHandshake(peer.Conn)
	if err != nil {
		return err
	}
	
	// Validate handshake
	if remoteHandshake.Version != handshake.Version {
		return fmt.Errorf("version mismatch")
	}
	
	// Set peer info
	peer.ID = remoteHandshake.NodeID
	peer.Version = remoteHandshake.Version
	peer.Capabilities = remoteHandshake.Capabilities
	
	return nil
}

func (pm *PeerManager) peerReadRoutine(peer *Peer) {
	defer pm.disconnectPeer(peer, "read error")
	
	for {
		select {
		case <-peer.closeCh:
			return
		default:
			msg, err := readMessage(peer.Conn)
			if err != nil {
				peer.errCh <- err
				return
			}
			
			peer.LastSeen = time.Now()
			peer.BytesReceived.Add(uint64(len(msg.Payload) + 16))
			peer.MessagesRecv.Add(1)
			
			select {
			case peer.recvCh <- *msg:
			case <-peer.closeCh:
				return
			}
		}
	}
}

func (pm *PeerManager) peerWriteRoutine(peer *Peer) {
	defer pm.disconnectPeer(peer, "write error")
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-peer.closeCh:
			return
			
		case msg := <-peer.sendCh:
			if err := writeMessage(peer.Conn, &msg); err != nil {
				peer.errCh <- err
				return
			}
			
			peer.BytesSent.Add(uint64(len(msg.Payload) + 16))
			peer.MessagesSent.Add(1)
			pm.metrics.MessagesTotal.Add(1)
			pm.metrics.BytesTotal.Add(uint64(len(msg.Payload)))
			
		case <-ticker.C:
			// Send keepalive
			ping := Message{
				Type:      MessageTypePing,
				ID:        generateMessageID(),
				Timestamp: time.Now(),
			}
			
			if err := writeMessage(peer.Conn, &ping); err != nil {
				peer.errCh <- err
				return
			}
			
			peer.LastPing = time.Now()
		}
	}
}

func (pm *PeerManager) peerHandleRoutine(peer *Peer) {
	for {
		select {
		case <-peer.closeCh:
			return
			
		case msg := <-peer.recvCh:
			pm.handlePeerMessage(peer, &msg)
			
		case err := <-peer.errCh:
			peer.Errors.Add(1)
			pm.logger.Warn("Peer error",
				zap.String("peer_id", fmt.Sprintf("%x", peer.ID[:8])),
				zap.Error(err))
			
			if peer.Errors.Load() > 10 {
				pm.disconnectPeer(peer, "too many errors")
				return
			}
		}
	}
}

func (pm *PeerManager) handlePeerMessage(peer *Peer, msg *Message) {
	switch msg.Type {
	case MessageTypePing:
		// Send pong
		pong := Message{
			Type:      MessageTypePing,
			ID:        msg.ID,
			Timestamp: time.Now(),
		}
		
		select {
		case peer.sendCh <- pong:
			// Update RTT
			if peer.LastPing.Unix() > 0 {
				rtt := time.Since(peer.LastPing)
				peer.RTT = rtt
				pm.updateAverageRTT(rtt)
			}
		default:
		}
		
	default:
		// Handle other message types
		// This would be extended based on protocol needs
	}
}

func (pm *PeerManager) pingRoutine(ctx context.Context) {
	defer pm.wg.Done()
	
	ticker := time.NewTicker(PingInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-pm.stopCh:
			return
		case <-ticker.C:
			pm.pingPeers()
		}
	}
}

func (pm *PeerManager) pingPeers() {
	now := time.Now()
	
	pm.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		
		// Check if peer is responsive
		if now.Sub(peer.LastSeen) > 2*PingInterval {
			pm.disconnectPeer(peer, "ping timeout")
			return true
		}
		
		// Send ping
		ping := Message{
			Type:      MessageTypePing,
			ID:        generateMessageID(),
			Timestamp: now,
		}
		
		select {
		case peer.sendCh <- ping:
			peer.LastPing = now
		default:
		}
		
		return true
	})
}

func (pm *PeerManager) cleanupRoutine(ctx context.Context) {
	defer pm.wg.Done()
	
	ticker := time.NewTicker(PeerCleanupInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-pm.stopCh:
			return
		case <-ticker.C:
			pm.cleanupPeers()
			pm.cleanupBans()
			pm.connPool.Cleanup()
		}
	}
}

func (pm *PeerManager) cleanupPeers() {
	// Remove disconnected peers
	var toRemove []NodeID
	
	pm.peers.Range(func(key, value interface{}) bool {
		peer := value.(*Peer)
		if peer.State == PeerStateDisconnected {
			toRemove = append(toRemove, key.(NodeID))
		}
		return true
	})
	
	for _, id := range toRemove {
		pm.peers.Delete(id)
	}
}

func (pm *PeerManager) cleanupBans() {
	now := time.Now()
	var toRemove []NodeID
	
	pm.bannedPeers.Range(func(key, value interface{}) bool {
		if now.After(value.(time.Time)) {
			toRemove = append(toRemove, key.(NodeID))
		}
		return true
	})
	
	for _, id := range toRemove {
		pm.bannedPeers.Delete(id)
	}
}

func (pm *PeerManager) discoveryRoutine(ctx context.Context) {
	defer pm.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-pm.stopCh:
			return
		case <-ticker.C:
			pm.discoverPeers(ctx)
		}
	}
}

func (pm *PeerManager) discoverPeers(ctx context.Context) {
	currentPeers := pm.metrics.PeersConnected.Load()
	
	if currentPeers < int32(MinPeers) && pm.dht != nil {
		// Need more peers, use DHT to find them
		needed := MinPeers - int(currentPeers)
		
		// Find random nodes
		randomID := generateRandomNodeID()
		nodes := pm.dht.FindNode(ctx, randomID, needed*2)
		
		for _, node := range nodes {
			if pm.metrics.PeersConnected.Load() >= int32(MinPeers) {
				break
			}
			
			// Skip if already connected
			if pm.GetPeer(node.ID) != nil {
				continue
			}
			
			// Try to connect
			addr := fmt.Sprintf("%s:%d", node.IP, node.Port)
			go pm.ConnectPeer(addr)
		}
	}
}

func (pm *PeerManager) disconnectPeer(peer *Peer, reason string) {
	peer.closeOnce.Do(func() {
		peer.mu.Lock()
		peer.State = PeerStateDisconnected
		peer.mu.Unlock()
		
		close(peer.closeCh)
		peer.Conn.Close()
		
		// Remove from peers map
		pm.peers.Delete(peer.ID)
		pm.metrics.PeersConnected.Add(-1)
		
		// Update IP count
		ip := getIP(peer.Addr)
		if count, ok := pm.peersByIP.Load(ip); ok {
			newCount := count.(int32) - 1
			if newCount <= 0 {
				pm.peersByIP.Delete(ip)
			} else {
				pm.peersByIP.Store(ip, newCount)
			}
		}
		
		// Return connection to pool if reusable
		if reason != "banned" && peer.Errors.Load() < 5 {
			pm.connPool.Put(peer.Addr.String(), peer.Conn)
		}
		
		pm.logger.Info("Peer disconnected",
			zap.String("peer_id", fmt.Sprintf("%x", peer.ID[:8])),
			zap.String("reason", reason))
	})
}

func (pm *PeerManager) banPeer(peerID NodeID, duration time.Duration) {
	pm.bannedPeers.Store(peerID, time.Now().Add(duration))
	
	// Disconnect if connected
	if peer := pm.GetPeer(peerID); peer != nil {
		pm.disconnectPeer(peer, "banned")
	}
}

func (pm *PeerManager) updateAverageRTT(rtt time.Duration) {
	// Simple moving average
	oldAvg := pm.metrics.AverageRTT.Load()
	newAvg := (oldAvg*9 + rtt.Microseconds()) / 10
	pm.metrics.AverageRTT.Store(newAvg)
}

// ConnectionPool methods

func (cp *ConnectionPool) Get(addr string) net.Conn {
	if value, ok := cp.connections.Load(addr); ok {
		pc := value.(*pooledConn)
		if pc.inUse.CompareAndSwap(false, true) {
			if time.Since(pc.lastUsed) < cp.maxIdle {
				return pc.conn
			}
			pc.conn.Close()
			cp.connections.Delete(addr)
		}
	}
	return nil
}

func (cp *ConnectionPool) Put(addr string, conn net.Conn) {
	pc := &pooledConn{
		conn:     conn,
		lastUsed: time.Now(),
	}
	cp.connections.Store(addr, pc)
}

func (cp *ConnectionPool) Cleanup() {
	now := time.Now()
	
	cp.connections.Range(func(key, value interface{}) bool {
		pc := value.(*pooledConn)
		if !pc.inUse.Load() && now.Sub(pc.lastUsed) > cp.maxIdle {
			pc.conn.Close()
			cp.connections.Delete(key)
		}
		return true
	})
}

// HandshakeMessage represents the handshake protocol
type HandshakeMessage struct {
	Version      string
	NodeID       NodeID
	Capabilities []string
	Timestamp    int64
}

// Helper functions

func writeMessage(conn net.Conn, msg *Message) error {
	// Set write deadline
	conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	
	// Simple encoding (would use proper encoding in production)
	data := make([]byte, 16+len(msg.Payload))
	data[0] = byte(msg.Type)
	binary.BigEndian.PutUint64(data[1:9], msg.ID)
	binary.BigEndian.PutUint64(data[9:17], uint64(msg.Timestamp.Unix()))
	copy(data[17:], msg.Payload)
	
	_, err := conn.Write(data)
	return err
}

func readMessage(conn net.Conn) (*Message, error) {
	// Set read deadline
	conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	
	// Read header
	header := make([]byte, 17)
	if _, err := io.ReadFull(conn, header); err != nil {
		return nil, err
	}
	
	msg := &Message{
		Type:      MessageType(header[0]),
		ID:        binary.BigEndian.Uint64(header[1:9]),
		Timestamp: time.Unix(int64(binary.BigEndian.Uint64(header[9:17])), 0),
	}
	
	// Read payload if any
	// This would need proper length encoding in production
	
	return msg, nil
}

func writeHandshake(conn net.Conn, hs *HandshakeMessage) error {
	// Simple encoding
	data := fmt.Sprintf("HANDSHAKE|%s|%x|%s|%d",
		hs.Version,
		hs.NodeID[:],
		strings.Join(hs.Capabilities, ","),
		hs.Timestamp)
	
	_, err := conn.Write([]byte(data))
	return err
}

func readHandshake(conn net.Conn) (*HandshakeMessage, error) {
	// Simple decoding
	buf := make([]byte, 1024)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	
	parts := strings.Split(string(buf[:n]), "|")
	if len(parts) != 5 || parts[0] != "HANDSHAKE" {
		return nil, fmt.Errorf("invalid handshake")
	}
	
	var nodeID NodeID
	fmt.Sscanf(parts[2], "%x", &nodeID[:])
	
	timestamp, _ := strconv.ParseInt(parts[4], 10, 64)
	
	return &HandshakeMessage{
		Version:      parts[1],
		NodeID:       nodeID,
		Capabilities: strings.Split(parts[3], ","),
		Timestamp:    timestamp,
	}, nil
}

func getIP(addr net.Addr) string {
	if tcpAddr, ok := addr.(*net.TCPAddr); ok {
		return tcpAddr.IP.String()
	}
	return ""
}

func getPort(addr net.Addr) uint16 {
	if tcpAddr, ok := addr.(*net.TCPAddr); ok {
		return uint16(tcpAddr.Port)
	}
	return 0
}

func generateRandomNodeID() NodeID {
	var id NodeID
	rand.Read(id[:])
	return id
}