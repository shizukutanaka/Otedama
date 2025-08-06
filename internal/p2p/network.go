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

// P2PStats contains P2P network statistics
type P2PStats struct {
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
	
	// Reliability components
	circuitBreakers sync.Map // map[string]*CircuitBreaker
	latencyTracker  *LatencyTracker
	throughputMeter *ThroughputMeter
	healthChecker   *ConnectionHealthChecker
	
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

// DHT type is now provided by dht_implementation.go


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

// Reliability types

// CircuitBreaker prevents cascading failures
type CircuitBreaker struct {
	logger       *zap.Logger
	peerID       string
	
	// Configuration
	failureThreshold int
	recoveryTimeout  time.Duration
	halfOpenMax     int
	
	// State
	state          atomic.Int32 // 0=closed, 1=open, 2=half-open
	failures       atomic.Int32
	lastFailure    atomic.Int64
	successCount   atomic.Int32
}

// CircuitBreakerState constants
const (
	CircuitClosed = iota
	CircuitOpen
	CircuitHalfOpen
)

// LatencyTracker tracks network latency with EWMA
type LatencyTracker struct {
	// Exponential weighted moving average
	samples     sync.Map // map[string]*LatencySample
	alpha       float64  // EWMA alpha parameter (0.125 = smooth, 0.5 = responsive)
}

// LatencySample holds latency data
type LatencySample struct {
	PeerID      string
	EWMA        atomic.Uint64 // microseconds
	Min         atomic.Uint64
	Max         atomic.Uint64
	SampleCount atomic.Uint64
}

// ThroughputMeter measures network throughput
type ThroughputMeter struct {
	// Sliding window for throughput calculation
	windows     sync.Map // map[string]*ThroughputWindow
	windowSize  time.Duration
	bucketCount int
}

// ThroughputWindow tracks throughput over time
type ThroughputWindow struct {
	PeerID      string
	StartTime   atomic.Int64
	Buckets     []atomic.Uint64
	CurrentIdx  atomic.Int32
}

// ConnectionHealthChecker monitors connection health
type ConnectionHealthChecker struct {
	logger         *zap.Logger
	checkInterval  time.Duration
	timeout        time.Duration
	maxFailures    int
	
	// Health status
	healthStatus   sync.Map // map[string]*HealthStatus
}

// HealthStatus tracks peer health
type HealthStatus struct {
	PeerID         string
	LastCheck      atomic.Int64
	ConsecutiveFails atomic.Int32
	ResponseTime   atomic.Int64 // microseconds
	PacketLoss     atomic.Uint32 // percentage * 100
	Healthy        atomic.Bool
}

// NewNetwork creates new P2P network - Rob Pike's clear constructor.
// It validates configuration, creates the network instance, and initializes components.
func NewNetwork(logger *zap.Logger, config *Config) (Network, error) {
	// Validate and prepare configuration
	config, err := prepareConfig(config)
	if err != nil {
		return nil, err
	}
	
	// Create base network instance
	network := createBaseNetwork(logger, config)
	
	// Initialize network components
	if err := initializeNetworkComponents(network, config); err != nil {
		return nil, fmt.Errorf("failed to initialize components: %w", err)
	}
	
	return network, nil
}

// prepareConfig validates and prepares the configuration.
// Extracted to isolate configuration logic.
func prepareConfig(config *Config) (*Config, error) {
	if config == nil {
		config = DefaultConfig()
	}
	
	if err := validateConfig(config); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	
	// Generate node ID if not provided
	if config.NodeID == "" {
		config.NodeID = generateNodeID()
	}
	
	return config, nil
}

// createBaseNetwork creates the base network instance with core fields.
// Extracted to separate instance creation from initialization.
func createBaseNetwork(logger *zap.Logger, config *Config) *UnifiedP2PNetwork {
	ctx, cancel := context.WithCancel(context.Background())
	
	return &UnifiedP2PNetwork{
		logger:    logger,
		config:    config,
		nodeID:    config.NodeID,
		stats:     &Stats{},
		ctx:       ctx,
		cancel:    cancel,
		startTime: time.Now(),
		
		// Initialize channels
		inbound:   make(chan *Message, config.BufferSize),
		outbound:  make(chan *Message, config.BufferSize),
		broadcast: make(chan *Message, config.BufferSize/10),
		
		// Initialize maps
		trustedPeers: make(map[string]bool),
	}
}

// initializeNetworkComponents initializes all network components.
// Extracted to organize component initialization.
func initializeNetworkComponents(network *UnifiedP2PNetwork, config *Config) error {
	// Initialize reliability components
	initializeReliabilityComponents(network)
	
	// Initialize security components
	initializeSecurityComponents(network, config)
	
	// Initialize DHT
	if err := initializeDHT(network, config); err != nil {
		return err
	}
	
	return nil
}

// initializeReliabilityComponents sets up reliability tracking components.
// Extracted to group related initialization.
func initializeReliabilityComponents(network *UnifiedP2PNetwork) {
	network.latencyTracker = &LatencyTracker{
		alpha: 0.125, // Smooth EWMA
	}
	
	network.throughputMeter = &ThroughputMeter{
		windowSize:  time.Minute,
		bucketCount: 60,
	}
	
	network.healthChecker = &ConnectionHealthChecker{
		logger:        network.logger,
		checkInterval: 30 * time.Second,
		timeout:       5 * time.Second,
		maxFailures:   3,
	}
}

// initializeSecurityComponents sets up security features.
// Extracted to isolate security initialization.
func initializeSecurityComponents(network *UnifiedP2PNetwork, config *Config) {
	// Initialize trusted peers
	for _, peerID := range config.TrustedPeers {
		network.trustedPeers[peerID] = true
	}
	
	// Initialize rate limiter if DDoS protection is enabled
	if config.DDoSProtection {
		network.rateLimiter = NewRateLimiter(network.logger, config.RateLimit)
	}
}

// initializeDHT sets up the distributed hash table.
// Extracted to isolate DHT initialization.
func initializeDHT(network *UnifiedP2PNetwork, config *Config) error {
	dhtConfig := &DHTConfig{
		NodeID:          network.nodeID,
		BootstrapNodes:  config.BootstrapNodes,
		BucketSize:      20,
		Alpha:           3,
		RefreshInterval: 30 * time.Minute,
	}
	
	network.dht = NewDHTImplementation(network.logger, dhtConfig, nil)
	return nil
}

// Circuit Breaker methods

// getCircuitBreaker retrieves circuit breaker for peer
func (n *UnifiedP2PNetwork) getCircuitBreaker(peerID string) *CircuitBreaker {
	if cb, ok := n.circuitBreakers.Load(peerID); ok {
		return cb.(*CircuitBreaker)
	}
	return nil
}

// getOrCreateCircuitBreaker gets or creates circuit breaker
func (n *UnifiedP2PNetwork) getOrCreateCircuitBreaker(peerID string) *CircuitBreaker {
	cb, _ := n.circuitBreakers.LoadOrStore(peerID, &CircuitBreaker{
		logger:           n.logger,
		peerID:           peerID,
		failureThreshold: 5,
		recoveryTimeout:  30 * time.Second,
		halfOpenMax:      3,
	})
	return cb.(*CircuitBreaker)
}

// IsOpen returns true if circuit is open
func (cb *CircuitBreaker) IsOpen() bool {
	state := cb.state.Load()
	if state == CircuitOpen {
		// Check if recovery timeout has passed
		lastFailure := cb.lastFailure.Load()
		if time.Since(time.Unix(0, lastFailure)) > cb.recoveryTimeout {
			// Transition to half-open
			cb.state.CompareAndSwap(CircuitOpen, CircuitHalfOpen)
			cb.successCount.Store(0)
			return false
		}
		return true
	}
	return false
}

// RecordFailure records a failure
func (cb *CircuitBreaker) RecordFailure() {
	cb.failures.Add(1)
	cb.lastFailure.Store(time.Now().UnixNano())
	
	if cb.failures.Load() >= int32(cb.failureThreshold) {
		cb.state.Store(CircuitOpen)
		cb.logger.Warn("Circuit breaker opened", zap.String("peer", cb.peerID))
	}
}

// RecordSuccess records a success
func (cb *CircuitBreaker) RecordSuccess() {
	state := cb.state.Load()
	
	if state == CircuitHalfOpen {
		success := cb.successCount.Add(1)
		if success >= int32(cb.halfOpenMax) {
			// Transition to closed
			cb.state.Store(CircuitClosed)
			cb.failures.Store(0)
			cb.logger.Info("Circuit breaker closed", zap.String("peer", cb.peerID))
		}
	} else if state == CircuitClosed {
		// Reset failure count on success
		cb.failures.Store(0)
	}
}

// Latency Tracker methods

// RecordLatency records a latency sample.
// It updates EWMA, min/max values, and sample count for the peer.
func (lt *LatencyTracker) RecordLatency(peerID string, latency time.Duration) {
	// Get or create latency sample for peer
	sample := lt.getOrCreateSample(peerID)
	microseconds := uint64(latency.Microseconds())
	
	// Update all latency metrics
	lt.updateEWMA(sample, microseconds)
	lt.updateMinLatency(sample, microseconds)
	lt.updateMaxLatency(sample, microseconds)
	
	sample.SampleCount.Add(1)
}

// getOrCreateSample retrieves or creates a latency sample for a peer.
// Extracted for clarity and reusability.
func (lt *LatencyTracker) getOrCreateSample(peerID string) *LatencySample {
	sample, _ := lt.samples.LoadOrStore(peerID, &LatencySample{
		PeerID: peerID,
		Min:    ^uint64(0), // max uint64
	})
	return sample.(*LatencySample)
}

// updateEWMA updates the exponentially weighted moving average.
// Extracted to isolate EWMA calculation logic.
func (lt *LatencyTracker) updateEWMA(sample *LatencySample, microseconds uint64) {
	oldEWMA := sample.EWMA.Load()
	
	var newEWMA uint64
	if oldEWMA == 0 {
		newEWMA = microseconds
	} else {
		newEWMA = uint64(lt.alpha*float64(microseconds) + (1-lt.alpha)*float64(oldEWMA))
	}
	
	sample.EWMA.Store(newEWMA)
}

// updateMinLatency atomically updates the minimum latency.
// Extracted for clarity and to reduce complexity.
func (lt *LatencyTracker) updateMinLatency(sample *LatencySample, microseconds uint64) {
	for {
		min := sample.Min.Load()
		if microseconds >= min || sample.Min.CompareAndSwap(min, microseconds) {
			break
		}
	}
}

// updateMaxLatency atomically updates the maximum latency.
// Extracted for clarity and to reduce complexity.
func (lt *LatencyTracker) updateMaxLatency(sample *LatencySample, microseconds uint64) {
	for {
		max := sample.Max.Load()
		if microseconds <= max || sample.Max.CompareAndSwap(max, microseconds) {
			break
		}
	}
}

// GetAverageLatency returns average latency for a peer
func (lt *LatencyTracker) GetAverageLatency(peerID string) time.Duration {
	if sample, ok := lt.samples.Load(peerID); ok {
		ls := sample.(*LatencySample)
		return time.Duration(ls.EWMA.Load()) * time.Microsecond
	}
	return 0
}

// Throughput Meter methods

// RecordBytes records bytes transferred
func (tm *ThroughputMeter) RecordBytes(peerID string, bytes uint64) {
	window, _ := tm.windows.LoadOrStore(peerID, tm.newWindow(peerID))
	tw := window.(*ThroughputWindow)
	
	// Calculate bucket index
	now := time.Now()
	elapsed := now.Sub(time.Unix(0, tw.StartTime.Load()))
	bucketIdx := int32(elapsed.Seconds()) % int32(tm.bucketCount)
	
	// Add to current bucket
	tw.Buckets[bucketIdx].Add(bytes)
	tw.CurrentIdx.Store(bucketIdx)
}

// GetThroughput returns throughput in bytes per second
func (tm *ThroughputMeter) GetThroughput(peerID string) float64 {
	if window, ok := tm.windows.Load(peerID); ok {
		tw := window.(*ThroughputWindow)
		
		var total uint64
		for i := range tw.Buckets {
			total += tw.Buckets[i].Load()
		}
		
		// Bytes per second
		return float64(total) / tm.windowSize.Seconds()
	}
	return 0
}

func (tm *ThroughputMeter) newWindow(peerID string) *ThroughputWindow {
	tw := &ThroughputWindow{
		PeerID:  peerID,
		Buckets: make([]atomic.Uint64, tm.bucketCount),
	}
	tw.StartTime.Store(time.Now().UnixNano())
	return tw
}

// Health Checker methods

// CheckPeer checks peer health
func (hc *ConnectionHealthChecker) CheckPeer(peer *Peer) {
	start := time.Now()
	
	// Simple ping check
	conn := peer.Conn
	if conn == nil {
		hc.recordFailure(peer.ID)
		return
	}
	
	// Set deadline
	conn.SetDeadline(time.Now().Add(hc.timeout))
	defer conn.SetDeadline(time.Time{})
	
	// Send ping
	pingData := make([]byte, 8)
	binary.BigEndian.PutUint64(pingData, uint64(time.Now().UnixNano()))
	
	_, err := conn.Write(append([]byte{byte(MessageTypePing)}, pingData...))
	if err != nil {
		hc.recordFailure(peer.ID)
		return
	}
	
	// Read pong
	response := make([]byte, 9)
	_, err = conn.Read(response)
	if err != nil || response[0] != byte(MessageTypePong) {
		hc.recordFailure(peer.ID)
		return
	}
	
	// Record success
	latency := time.Since(start)
	hc.recordSuccess(peer.ID, latency)
}

func (hc *ConnectionHealthChecker) recordFailure(peerID string) {
	status, _ := hc.healthStatus.LoadOrStore(peerID, &HealthStatus{
		PeerID: peerID,
	})
	health := status.(*HealthStatus)
	
	health.ConsecutiveFails.Add(1)
	health.LastCheck.Store(time.Now().UnixNano())
	
	if health.ConsecutiveFails.Load() >= int32(hc.maxFailures) {
		health.Healthy.Store(false)
	}
}

func (hc *ConnectionHealthChecker) recordSuccess(peerID string, latency time.Duration) {
	status, _ := hc.healthStatus.LoadOrStore(peerID, &HealthStatus{
		PeerID: peerID,
	})
	health := status.(*HealthStatus)
	
	health.ConsecutiveFails.Store(0)
	health.LastCheck.Store(time.Now().UnixNano())
	health.ResponseTime.Store(latency.Microseconds())
	health.Healthy.Store(true)
}

// Start starts the P2P network.
// It initializes the listener, starts background goroutines, and connects to bootstrap nodes.
func (n *UnifiedP2PNetwork) Start() error {
	// Ensure network isn't already running
	if err := n.ensureNotRunning(); err != nil {
		return err
	}
	
	n.logStartup()
	
	// Initialize network listener
	if err := n.initializeListener(); err != nil {
		return err
	}
	
	// Start all background services
	n.startBackgroundServices()
	
	// Connect to bootstrap nodes
	n.initializeBootstrapConnections()
	
	n.logger.Info("P2P network started successfully")
	return nil
}

// ensureNotRunning checks if the network is already running.
// Extracted to isolate state validation logic.
func (n *UnifiedP2PNetwork) ensureNotRunning() error {
	if !n.running.CompareAndSwap(false, true) {
		return errors.New("network already running")
	}
	return nil
}

// logStartup logs network startup information.
// Extracted for clarity and potential future expansion.
func (n *UnifiedP2PNetwork) logStartup() {
	n.logger.Info("Starting P2P network",
		zap.String("node_id", n.nodeID),
		zap.Int("port", n.config.Port),
		zap.Int("max_peers", n.config.MaxPeers),
	)
}

// initializeListener starts the network listener.
// Extracted to isolate listener initialization and error handling.
func (n *UnifiedP2PNetwork) initializeListener() error {
	if err := n.startListener(); err != nil {
		n.running.Store(false)
		return fmt.Errorf("failed to start listener: %w", err)
	}
	return nil
}

// startBackgroundServices starts all background goroutines.
// Extracted to centralize goroutine management.
func (n *UnifiedP2PNetwork) startBackgroundServices() {
	// Start message handling services
	n.startMessageHandlers()
	
	// Start management services
	n.startManagementServices()
}

// startMessageHandlers starts message processing goroutines.
// Extracted to group related services.
func (n *UnifiedP2PNetwork) startMessageHandlers() {
	n.wg.Add(3)
	go n.inboundHandler()
	go n.outboundHandler()
	go n.broadcastHandler()
}

// startManagementServices starts management and monitoring goroutines.
// Extracted to group related services.
func (n *UnifiedP2PNetwork) startManagementServices() {
	n.wg.Add(3)
	go n.peerManager()
	go n.statsUpdater()
	go n.healthMonitor()
}

// initializeBootstrapConnections connects to bootstrap nodes.
// Extracted to isolate bootstrap logic and error handling.
func (n *UnifiedP2PNetwork) initializeBootstrapConnections() {
	if err := n.connectBootstrap(); err != nil {
		n.logger.Warn("Bootstrap connection failed", zap.Error(err))
	}
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
	// Check circuit breaker
	cb := n.getOrCreateCircuitBreaker(msg.To)
	if cb.IsOpen() {
		n.logger.Debug("Circuit breaker open for peer", zap.String("peer", msg.To))
		return
	}
	
	// Find peer connection
	conn, exists := n.connections.Load(msg.To)
	if !exists {
		n.logger.Debug("No connection to peer", zap.String("peer", msg.To))
		cb.RecordFailure()
		return
	}
	
	// Send message
	if err := n.writeMessage(conn.(net.Conn), msg); err != nil {
		n.logger.Error("Failed to send message", zap.Error(err))
		cb.RecordFailure()
		n.removePeer(msg.To)
	} else {
		cb.RecordSuccess()
		// Record throughput
		n.throughputMeter.RecordBytes(msg.To, uint64(msg.Size))
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
		
		// Record latency in tracker
		n.latencyTracker.RecordLatency(msg.From, latency)
		
		// Record success for circuit breaker
		if cb := n.getCircuitBreaker(msg.From); cb != nil {
			cb.RecordSuccess()
		}
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

// healthMonitor periodically checks connection health
func (n *UnifiedP2PNetwork) healthMonitor() {
	defer n.wg.Done()
	
	ticker := time.NewTicker(n.healthChecker.checkInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			n.checkConnectionHealth()
		case <-n.ctx.Done():
			return
		}
	}
}

func (n *UnifiedP2PNetwork) checkConnectionHealth() {
	peers := n.GetPeers(100)
	
	for _, peer := range peers {
		go n.healthChecker.CheckPeer(peer)
	}
}

// RecordFailure records a peer failure for reliability tracking
func (n *UnifiedP2PNetwork) RecordFailure(peerID string) {
	cb := n.getOrCreateCircuitBreaker(peerID)
	cb.RecordFailure()
	
	// Update health status
	if health, ok := n.healthChecker.healthStatus.Load(peerID); ok {
		hs := health.(*HealthStatus)
		hs.ConsecutiveFails.Add(1)
		if hs.ConsecutiveFails.Load() >= int32(n.healthChecker.maxFailures) {
			hs.Healthy.Store(false)
		}
	}
}

// RecordSuccess records a peer success
func (n *UnifiedP2PNetwork) RecordSuccess(peerID string) {
	cb := n.getCircuitBreaker(peerID)
	if cb != nil {
		cb.RecordSuccess()
	}
	
	// Update health status
	if health, ok := n.healthChecker.healthStatus.Load(peerID); ok {
		hs := health.(*HealthStatus)
		hs.ConsecutiveFails.Store(0)
		hs.Healthy.Store(true)
	}
}

// SelectHealthyPeer selects a healthy peer based on various criteria
func (n *UnifiedP2PNetwork) SelectHealthyPeer(excludeList []string) (*Peer, error) {
	peers := n.GetPeers(100)
	if len(peers) == 0 {
		return nil, errors.New("no peers available")
	}
	
	// Filter healthy peers
	healthyPeers := make([]*Peer, 0, len(peers))
	excludeMap := make(map[string]bool)
	for _, id := range excludeList {
		excludeMap[id] = true
	}
	
	for _, peer := range peers {
		if excludeMap[peer.ID] {
			continue
		}
		
		// Check circuit breaker
		if cb := n.getCircuitBreaker(peer.ID); cb != nil && cb.IsOpen() {
			continue
		}
		
		// Check health status
		if health, ok := n.healthChecker.healthStatus.Load(peer.ID); ok {
			hs := health.(*HealthStatus)
			if !hs.Healthy.Load() {
				continue
			}
		}
		
		healthyPeers = append(healthyPeers, peer)
	}
	
	if len(healthyPeers) == 0 {
		return nil, errors.New("no healthy peers available")
	}
	
	// Select peer with best latency
	var bestPeer *Peer
	bestLatency := time.Duration(^uint64(0) >> 1) // max duration
	
	for _, peer := range healthyPeers {
		latency := n.latencyTracker.GetAverageLatency(peer.ID)
		if latency > 0 && latency < bestLatency {
			bestLatency = latency
			bestPeer = peer
		}
	}
	
	// If no peer with latency data, return random healthy peer
	if bestPeer == nil {
		bestPeer = healthyPeers[0]
	}
	
	return bestPeer, nil
}
