package p2p

import (
	"context"
	"fmt"
	"math/rand"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// AutoDiscovery provides automated peer discovery and management
// Following Rob Pike's principle: "Concurrency is not parallelism"
type AutoDiscovery struct {
	logger *zap.Logger
	config *DiscoveryConfig
	
	// Discovery mechanisms
	dht           *DHT
	mdns          *MDNSDiscovery
	bootstrapper  *Bootstrapper
	
	// Peer management
	peerManager   *PeerManager
	peerStore     *PeerStore
	connManager   *ConnectionManager
	
	// Discovery state
	active        atomic.Bool
	discoveryRate atomic.Uint64
	peersFound    atomic.Uint64
	
	// Lifecycle
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
}

// DiscoveryConfig contains discovery configuration
type DiscoveryConfig struct {
	// Discovery methods
	EnableDHT         bool
	EnableMDNS        bool
	EnableBootstrap   bool
	
	// Network settings
	ListenAddr        string
	BootstrapPeers    []string
	MaxPeers          int
	MinPeers          int
	
	// Discovery intervals
	DHTInterval       time.Duration
	MDNSInterval      time.Duration
	PeerCheckInterval time.Duration
	
	// Connection settings
	DialTimeout       time.Duration
	KeepAliveInterval time.Duration
	MaxRetries        int
	
	// Security
	RequireAuth       bool
	TLSEnabled        bool
}

// PeerManager manages peer lifecycle
type PeerManager struct {
	logger        *zap.Logger
	config        *DiscoveryConfig
	
	// Peer tracking
	activePeers   map[string]*Peer
	peersMu       sync.RWMutex
	
	// Peer scoring
	peerScores    map[string]*PeerScore
	scoresMu      sync.RWMutex
	
	// Connection pool
	connPool      *ConnectionPool
}

// PeerScore tracks peer quality
type PeerScore struct {
	PeerID          string
	ResponseTime    time.Duration
	SharesAccepted  uint64
	SharesRejected  uint64
	UptimeSeconds   uint64
	LastSeen        time.Time
	Score           float64
}

// ConnectionManager manages network connections
type ConnectionManager struct {
	logger        *zap.Logger
	
	// Connection tracking
	connections   map[string]*Connection
	connMu        sync.RWMutex
	
	// Resource limits
	maxConns      int
	maxBandwidth  uint64
	
	// Metrics
	bytesIn       atomic.Uint64
	bytesOut      atomic.Uint64
	connCount     atomic.Int32
}

// NewAutoDiscovery creates a new auto discovery system
func NewAutoDiscovery(logger *zap.Logger, config *DiscoveryConfig) *AutoDiscovery {
	if config == nil {
		config = DefaultDiscoveryConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	ad := &AutoDiscovery{
		logger:       logger,
		config:       config,
		peerManager:  NewPeerManager(logger, config),
		peerStore:    NewPeerStore(),
		connManager:  NewConnectionManager(logger, config.MaxPeers),
		ctx:          ctx,
		cancel:       cancel,
	}
	
	// Initialize discovery mechanisms
	if config.EnableDHT {
		ad.dht = NewDHT(logger, config.ListenAddr)
	}
	
	if config.EnableMDNS {
		ad.mdns = NewMDNSDiscovery(logger)
	}
	
	if config.EnableBootstrap {
		ad.bootstrapper = NewBootstrapper(logger, config.BootstrapPeers)
	}
	
	return ad
}

// Start starts the auto discovery system
func (ad *AutoDiscovery) Start() error {
	if !ad.active.CompareAndSwap(false, true) {
		return fmt.Errorf("auto discovery already running")
	}
	
	ad.logger.Info("Starting auto discovery",
		zap.Bool("dht", ad.config.EnableDHT),
		zap.Bool("mdns", ad.config.EnableMDNS),
		zap.Bool("bootstrap", ad.config.EnableBootstrap),
	)
	
	// Start discovery mechanisms
	if ad.dht != nil {
		if err := ad.dht.Start(); err != nil {
			return fmt.Errorf("failed to start DHT: %w", err)
		}
	}
	
	if ad.mdns != nil {
		if err := ad.mdns.Start(); err != nil {
			return fmt.Errorf("failed to start mDNS: %w", err)
		}
	}
	
	// Start discovery loops
	ad.wg.Add(1)
	go ad.discoveryLoop()
	
	ad.wg.Add(1)
	go ad.peerManagementLoop()
	
	ad.wg.Add(1)
	go ad.connectionHealthLoop()
	
	// Bootstrap initial peers
	if ad.bootstrapper != nil {
		go ad.bootstrapPeers()
	}
	
	return nil
}

// Stop stops the auto discovery system
func (ad *AutoDiscovery) Stop() error {
	if !ad.active.CompareAndSwap(true, false) {
		return fmt.Errorf("auto discovery not running")
	}
	
	ad.logger.Info("Stopping auto discovery")
	
	// Cancel context
	ad.cancel()
	
	// Stop discovery mechanisms
	if ad.dht != nil {
		ad.dht.Stop()
	}
	
	if ad.mdns != nil {
		ad.mdns.Stop()
	}
	
	// Wait for goroutines
	ad.wg.Wait()
	
	// Close connections
	ad.connManager.CloseAll()
	
	return nil
}

// GetPeers returns current connected peers
func (ad *AutoDiscovery) GetPeers() []*Peer {
	return ad.peerManager.GetActivePeers()
}

// GetStats returns discovery statistics
func (ad *AutoDiscovery) GetStats() DiscoveryStats {
	return DiscoveryStats{
		PeersFound:      ad.peersFound.Load(),
		DiscoveryRate:   ad.discoveryRate.Load(),
		ActivePeers:     len(ad.GetPeers()),
		TotalBytesIn:    ad.connManager.bytesIn.Load(),
		TotalBytesOut:   ad.connManager.bytesOut.Load(),
		ConnectionCount: int(ad.connManager.connCount.Load()),
	}
}

// Private methods

func (ad *AutoDiscovery) discoveryLoop() {
	defer ad.wg.Done()
	
	dhtTicker := time.NewTicker(ad.config.DHTInterval)
	mdnsTicker := time.NewTicker(ad.config.MDNSInterval)
	
	defer dhtTicker.Stop()
	defer mdnsTicker.Stop()
	
	for {
		select {
		case <-dhtTicker.C:
			if ad.dht != nil {
				ad.discoverDHTPeers()
			}
			
		case <-mdnsTicker.C:
			if ad.mdns != nil {
				ad.discoverMDNSPeers()
			}
			
		case <-ad.ctx.Done():
			return
		}
	}
}

func (ad *AutoDiscovery) peerManagementLoop() {
	defer ad.wg.Done()
	
	ticker := time.NewTicker(ad.config.PeerCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ad.managePeers()
			
		case <-ad.ctx.Done():
			return
		}
	}
}

func (ad *AutoDiscovery) connectionHealthLoop() {
	defer ad.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			ad.checkConnectionHealth()
			
		case <-ad.ctx.Done():
			return
		}
	}
}

func (ad *AutoDiscovery) discoverDHTPeers() {
	peers, err := ad.dht.FindPeers(ad.ctx, "otedama-mining-pool")
	if err != nil {
		ad.logger.Warn("DHT discovery failed", zap.Error(err))
		return
	}
	
	for _, peer := range peers {
		if ad.peerManager.ShouldConnect(peer) {
			go ad.connectToPeer(peer)
			ad.peersFound.Add(1)
		}
	}
	
	ad.discoveryRate.Store(uint64(len(peers)))
}

func (ad *AutoDiscovery) discoverMDNSPeers() {
	peers, err := ad.mdns.Discover(ad.ctx, 5*time.Second)
	if err != nil {
		ad.logger.Warn("mDNS discovery failed", zap.Error(err))
		return
	}
	
	for _, peer := range peers {
		if ad.peerManager.ShouldConnect(peer) {
			go ad.connectToPeer(peer)
			ad.peersFound.Add(1)
		}
	}
}

func (ad *AutoDiscovery) bootstrapPeers() {
	ad.logger.Info("Bootstrapping peers",
		zap.Int("count", len(ad.config.BootstrapPeers)),
	)
	
	for _, addr := range ad.config.BootstrapPeers {
		peer := &Peer{
			ID:      generatePeerID(),
			Address: addr,
		}
		
		if ad.peerManager.ShouldConnect(peer) {
			go ad.connectToPeer(peer)
		}
	}
}

func (ad *AutoDiscovery) connectToPeer(peer *Peer) {
	ad.logger.Debug("Connecting to peer",
		zap.String("peer_id", peer.ID),
		zap.String("address", peer.Address),
	)
	
	conn, err := ad.connManager.Connect(ad.ctx, peer)
	if err != nil {
		ad.logger.Warn("Failed to connect to peer",
			zap.String("peer_id", peer.ID),
			zap.Error(err),
		)
		return
	}
	
	// Add to peer manager
	if err := ad.peerManager.AddPeer(peer, conn); err != nil {
		ad.logger.Warn("Failed to add peer",
			zap.String("peer_id", peer.ID),
			zap.Error(err),
		)
		conn.Close()
		return
	}
	
	ad.logger.Info("Connected to peer",
		zap.String("peer_id", peer.ID),
	)
}

func (ad *AutoDiscovery) managePeers() {
	activePeers := ad.peerManager.GetActivePeers()
	
	// Remove dead peers
	for _, peer := range activePeers {
		if !ad.peerManager.IsPeerAlive(peer) {
			ad.logger.Info("Removing dead peer",
				zap.String("peer_id", peer.ID),
			)
			ad.peerManager.RemovePeer(peer.ID)
			ad.connManager.Disconnect(peer.ID)
		}
	}
	
	// Ensure minimum peers
	if len(activePeers) < ad.config.MinPeers {
		ad.logger.Info("Below minimum peers, triggering discovery",
			zap.Int("current", len(activePeers)),
			zap.Int("min", ad.config.MinPeers),
		)
		
		// Trigger immediate discovery
		go ad.discoverDHTPeers()
		go ad.discoverMDNSPeers()
	}
	
	// Prune excess peers
	if len(activePeers) > ad.config.MaxPeers {
		ad.logger.Info("Above maximum peers, pruning",
			zap.Int("current", len(activePeers)),
			zap.Int("max", ad.config.MaxPeers),
		)
		
		// Remove lowest scoring peers
		ad.peerManager.PruneWorstPeers(len(activePeers) - ad.config.MaxPeers)
	}
}

func (ad *AutoDiscovery) checkConnectionHealth() {
	conns := ad.connManager.GetActiveConnections()
	
	for _, conn := range conns {
		if err := conn.Ping(); err != nil {
			ad.logger.Warn("Connection health check failed",
				zap.String("peer_id", conn.PeerID),
				zap.Error(err),
			)
			
			// Mark peer as unhealthy
			ad.peerManager.MarkUnhealthy(conn.PeerID)
		}
	}
}

// Helper components

// NewPeerManager creates a new peer manager
func NewPeerManager(logger *zap.Logger, config *DiscoveryConfig) *PeerManager {
	return &PeerManager{
		logger:      logger,
		config:      config,
		activePeers: make(map[string]*Peer),
		peerScores:  make(map[string]*PeerScore),
		connPool:    NewConnectionPool(config.MaxPeers),
	}
}

func (pm *PeerManager) ShouldConnect(peer *Peer) bool {
	pm.peersMu.RLock()
	_, exists := pm.activePeers[peer.ID]
	pm.peersMu.RUnlock()
	
	return !exists && len(pm.activePeers) < pm.config.MaxPeers
}

func (pm *PeerManager) AddPeer(peer *Peer, conn *Connection) error {
	pm.peersMu.Lock()
	defer pm.peersMu.Unlock()
	
	if _, exists := pm.activePeers[peer.ID]; exists {
		return fmt.Errorf("peer already exists")
	}
	
	pm.activePeers[peer.ID] = peer
	
	// Initialize peer score
	pm.scoresMu.Lock()
	pm.peerScores[peer.ID] = &PeerScore{
		PeerID:   peer.ID,
		LastSeen: time.Now(),
		Score:    50.0, // Start with neutral score
	}
	pm.scoresMu.Unlock()
	
	return nil
}

func (pm *PeerManager) RemovePeer(peerID string) {
	pm.peersMu.Lock()
	delete(pm.activePeers, peerID)
	pm.peersMu.Unlock()
	
	pm.scoresMu.Lock()
	delete(pm.peerScores, peerID)
	pm.scoresMu.Unlock()
}

func (pm *PeerManager) GetActivePeers() []*Peer {
	pm.peersMu.RLock()
	defer pm.peersMu.RUnlock()
	
	peers := make([]*Peer, 0, len(pm.activePeers))
	for _, peer := range pm.activePeers {
		peers = append(peers, peer)
	}
	
	return peers
}

func (pm *PeerManager) IsPeerAlive(peer *Peer) bool {
	pm.scoresMu.RLock()
	score, exists := pm.peerScores[peer.ID]
	pm.scoresMu.RUnlock()
	
	if !exists {
		return false
	}
	
	return time.Since(score.LastSeen) < 2*time.Minute
}

func (pm *PeerManager) MarkUnhealthy(peerID string) {
	pm.scoresMu.Lock()
	defer pm.scoresMu.Unlock()
	
	if score, exists := pm.peerScores[peerID]; exists {
		score.Score *= 0.9 // Reduce score by 10%
	}
}

func (pm *PeerManager) PruneWorstPeers(count int) {
	// Get all peer scores
	pm.scoresMu.RLock()
	scores := make([]*PeerScore, 0, len(pm.peerScores))
	for _, score := range pm.peerScores {
		scores = append(scores, score)
	}
	pm.scoresMu.RUnlock()
	
	// Sort by score (lowest first)
	sortPeersByScore(scores)
	
	// Remove worst peers
	for i := 0; i < count && i < len(scores); i++ {
		pm.RemovePeer(scores[i].PeerID)
	}
}

// NewConnectionManager creates a new connection manager
func NewConnectionManager(logger *zap.Logger, maxConns int) *ConnectionManager {
	return &ConnectionManager{
		logger:      logger,
		connections: make(map[string]*Connection),
		maxConns:    maxConns,
	}
}

func (cm *ConnectionManager) Connect(ctx context.Context, peer *Peer) (*Connection, error) {
	if int(cm.connCount.Load()) >= cm.maxConns {
		return nil, fmt.Errorf("max connections reached")
	}
	
	// Dial peer
	dialer := &net.Dialer{
		Timeout: 10 * time.Second,
	}
	
	conn, err := dialer.DialContext(ctx, "tcp", peer.Address)
	if err != nil {
		return nil, err
	}
	
	// Create connection wrapper
	connection := &Connection{
		PeerID:    peer.ID,
		Conn:      conn,
		CreatedAt: time.Now(),
	}
	
	cm.connMu.Lock()
	cm.connections[peer.ID] = connection
	cm.connMu.Unlock()
	
	cm.connCount.Add(1)
	
	return connection, nil
}

func (cm *ConnectionManager) Disconnect(peerID string) {
	cm.connMu.Lock()
	conn, exists := cm.connections[peerID]
	if exists {
		delete(cm.connections, peerID)
	}
	cm.connMu.Unlock()
	
	if conn != nil {
		conn.Close()
		cm.connCount.Add(-1)
	}
}

func (cm *ConnectionManager) GetActiveConnections() []*Connection {
	cm.connMu.RLock()
	defer cm.connMu.RUnlock()
	
	conns := make([]*Connection, 0, len(cm.connections))
	for _, conn := range cm.connections {
		conns = append(conns, conn)
	}
	
	return conns
}

func (cm *ConnectionManager) CloseAll() {
	cm.connMu.Lock()
	defer cm.connMu.Unlock()
	
	for _, conn := range cm.connections {
		conn.Close()
	}
	
	cm.connections = make(map[string]*Connection)
	cm.connCount.Store(0)
}

// Helper structures

type DiscoveryStats struct {
	PeersFound      uint64
	DiscoveryRate   uint64
	ActivePeers     int
	TotalBytesIn    uint64
	TotalBytesOut   uint64
	ConnectionCount int
}

// Helper functions

func generatePeerID() string {
	return fmt.Sprintf("peer_%d_%d", time.Now().Unix(), rand.Int63())
}

func sortPeersByScore(scores []*PeerScore) {
	// Simple bubble sort for small lists
	for i := 0; i < len(scores)-1; i++ {
		for j := 0; j < len(scores)-i-1; j++ {
			if scores[j].Score > scores[j+1].Score {
				scores[j], scores[j+1] = scores[j+1], scores[j]
			}
		}
	}
}

// DefaultDiscoveryConfig returns default discovery configuration
func DefaultDiscoveryConfig() *DiscoveryConfig {
	return &DiscoveryConfig{
		EnableDHT:         true,
		EnableMDNS:        true,
		EnableBootstrap:   true,
		ListenAddr:        ":30303",
		MaxPeers:          50,
		MinPeers:          5,
		DHTInterval:       1 * time.Minute,
		MDNSInterval:      30 * time.Second,
		PeerCheckInterval: 30 * time.Second,
		DialTimeout:       10 * time.Second,
		KeepAliveInterval: 30 * time.Second,
		MaxRetries:        3,
		RequireAuth:       true,
		TLSEnabled:        true,
	}
}