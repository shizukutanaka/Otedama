package p2p

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DHT implements distributed hash table for peer discovery - John Carmack's optimization
func NewDHT(logger *zap.Logger, nodeID string) (*DHT, error) {
	dht := &DHT{
		logger:     logger.With(zap.String("component", "dht")),
		nodeID:     nodeID,
		maxBuckets: 160, // 160 bits for SHA-1
		bucketSize: 20,  // K-bucket size
	}
	
	// Initialize buckets
	dht.buckets = make([]*Bucket, dht.maxBuckets)
	for i := range dht.buckets {
		dht.buckets[i] = &Bucket{
			peers: make([]*Peer, 0, dht.bucketSize),
		}
	}
	
	return dht, nil
}

// AddPeer adds peer to appropriate DHT bucket
func (d *DHT) AddPeer(peer *Peer) {
	if peer.ID == d.nodeID {
		return // Don't add ourselves
	}
	
	bucketIndex := d.getBucketIndex(peer.ID)
	if bucketIndex >= len(d.buckets) {
		return
	}
	
	bucket := d.buckets[bucketIndex]
	bucket.mu.Lock()
	defer bucket.mu.Unlock()
	
	// Check if peer already exists
	for i, existingPeer := range bucket.peers {
		if existingPeer.ID == peer.ID {
			// Update existing peer
			bucket.peers[i] = peer
			return
		}
	}
	
	// Add new peer
	if len(bucket.peers) < d.bucketSize {
		bucket.peers = append(bucket.peers, peer)
	} else {
		// Bucket full, replace least recently seen peer
		d.replaceLRUPeer(bucket, peer)
	}
	
	d.logger.Debug("Added peer to DHT",
		zap.String("peer_id", peer.ID),
		zap.Int("bucket", bucketIndex),
	)
}

// FindClosestPeers finds K closest peers to target ID
func (d *DHT) FindClosestPeers(targetID string, k int) []*Peer {
	var allPeers []*Peer
	
	// Collect peers from all buckets
	for _, bucket := range d.buckets {
		bucket.mu.RLock()
		allPeers = append(allPeers, bucket.peers...)
		bucket.mu.RUnlock()
	}
	
	// Sort by XOR distance to target
	sort.Slice(allPeers, func(i, j int) bool {
		distI := d.xorDistance(allPeers[i].ID, targetID)
		distJ := d.xorDistance(allPeers[j].ID, targetID)
		return d.compareDistance(distI, distJ) < 0
	})
	
	// Return closest K peers
	if len(allPeers) > k {
		allPeers = allPeers[:k]
	}
	
	return allPeers
}

// Store stores key-value pair in DHT
func (d *DHT) Store(key string, value []byte) {
	d.storage.Store(key, value)
	d.logger.Debug("Stored value in DHT", zap.String("key", key))
}

// Retrieve retrieves value by key from DHT
func (d *DHT) Retrieve(key string) ([]byte, bool) {
	if value, exists := d.storage.Load(key); exists {
		return value.([]byte), true
	}
	return nil, false
}

// RemovePeer removes peer from DHT
func (d *DHT) RemovePeer(peerID string) {
	bucketIndex := d.getBucketIndex(peerID)
	if bucketIndex >= len(d.buckets) {
		return
	}
	
	bucket := d.buckets[bucketIndex]
	bucket.mu.Lock()
	defer bucket.mu.Unlock()
	
	for i, peer := range bucket.peers {
		if peer.ID == peerID {
			// Remove peer
			bucket.peers = append(bucket.peers[:i], bucket.peers[i+1:]...)
			d.logger.Debug("Removed peer from DHT", zap.String("peer_id", peerID))
			break
		}
	}
}

// GetBucketStats returns statistics for each bucket
func (d *DHT) GetBucketStats() []int {
	stats := make([]int, len(d.buckets))
	
	for i, bucket := range d.buckets {
		bucket.mu.RLock()
		stats[i] = len(bucket.peers)
		bucket.mu.RUnlock()
	}
	
	return stats
}

// Private methods for DHT

func (d *DHT) getBucketIndex(peerID string) int {
	distance := d.xorDistance(d.nodeID, peerID)
	
	// Find the position of the most significant bit
	for i := 0; i < len(distance); i++ {
		if distance[i] != 0 {
			// Find the MSB position in this byte
			for bit := 7; bit >= 0; bit-- {
				if distance[i]&(1<<bit) != 0 {
					return i*8 + (7 - bit)
				}
			}
		}
	}
	
	return len(d.buckets) - 1 // Maximum distance
}

func (d *DHT) xorDistance(id1, id2 string) []byte {
	// Convert IDs to bytes and XOR them
	bytes1 := d.idToBytes(id1)
	bytes2 := d.idToBytes(id2)
	
	distance := make([]byte, len(bytes1))
	for i := range distance {
		distance[i] = bytes1[i] ^ bytes2[i]
	}
	
	return distance
}

func (d *DHT) idToBytes(id string) []byte {
	// Convert hex string to bytes
	bytes, err := hex.DecodeString(id)
	if err != nil {
		// Fallback: hash the ID
		h := sha256.Sum256([]byte(id))
		return h[:]
	}
	return bytes
}

func (d *DHT) compareDistance(dist1, dist2 []byte) int {
	for i := range dist1 {
		if dist1[i] < dist2[i] {
			return -1
		} else if dist1[i] > dist2[i] {
			return 1
		}
	}
	return 0
}

func (d *DHT) replaceLRUPeer(bucket *Bucket, newPeer *Peer) {
	// Find least recently seen peer
	oldestIndex := 0
	oldestTime := bucket.peers[0].LastSeen.Load()
	
	for i, peer := range bucket.peers {
		lastSeen := peer.LastSeen.Load()
		if lastSeen < oldestTime {
			oldestTime = lastSeen
			oldestIndex = i
		}
	}
	
	// Replace with new peer
	bucket.peers[oldestIndex] = newPeer
}

// RateLimiter implements token bucket rate limiting for DDoS protection
func NewRateLimiter(logger *zap.Logger, maxRate int) *RateLimiter {
	return &RateLimiter{
		maxRate: maxRate,
		logger:  logger.With(zap.String("component", "rate_limiter")),
	}
}

// Allow checks if request is allowed under rate limit
func (rl *RateLimiter) Allow(clientID string) bool {
	bucket := rl.getBucket(clientID)
	return bucket.Allow()
}

// GetStats returns rate limiting statistics
func (rl *RateLimiter) GetStats() map[string]interface{} {
	stats := make(map[string]interface{})
	
	bucketCount := 0
	rl.rates.Range(func(key, value interface{}) bool {
		bucketCount++
		return true
	})
	
	stats["active_buckets"] = bucketCount
	stats["max_rate"] = rl.maxRate
	
	return stats
}

// Cleanup removes expired rate limit buckets
func (rl *RateLimiter) Cleanup() {
	now := time.Now().Unix()
	
	rl.rates.Range(func(key, value interface{}) bool {
		bucket := value.(*TokenBucket)
		
		// Remove buckets that haven't been used for 10 minutes
		if now-bucket.lastRefill.Load() > 600 {
			rl.rates.Delete(key)
		}
		
		return true
	})
}

func (rl *RateLimiter) getBucket(clientID string) *TokenBucket {
	if bucket, exists := rl.rates.Load(clientID); exists {
		return bucket.(*TokenBucket)
	}
	
	// Create new bucket
	bucket := &TokenBucket{
		capacity:   int64(rl.maxRate),
		refillRate: int64(rl.maxRate / 60), // Per second
	}
	bucket.tokens.Store(bucket.capacity)
	bucket.lastRefill.Store(time.Now().Unix())
	
	rl.rates.Store(clientID, bucket)
	return bucket
}

// Allow checks if token is available in bucket
func (tb *TokenBucket) Allow() bool {
	now := time.Now().Unix()
	lastRefill := tb.lastRefill.Load()
	
	// Refill tokens based on time elapsed
	if now > lastRefill {
		elapsed := now - lastRefill
		tokensToAdd := elapsed * tb.refillRate
		
		currentTokens := tb.tokens.Load()
		newTokens := currentTokens + tokensToAdd
		
		if newTokens > tb.capacity {
			newTokens = tb.capacity
		}
		
		tb.tokens.Store(newTokens)
		tb.lastRefill.Store(now)
	}
	
	// Try to consume a token
	for {
		currentTokens := tb.tokens.Load()
		if currentTokens <= 0 {
			return false
		}
		
		if tb.tokens.CompareAndSwap(currentTokens, currentTokens-1) {
			return true
		}
	}
}

// PeerDiscovery implements peer discovery mechanisms
type PeerDiscovery struct {
	logger    *zap.Logger
	dht       *DHT
	network   *UnifiedP2PNetwork
	
	// Discovery strategies
	bootstrapNodes []string
	mdnsEnabled    bool
	dnsEnabled     bool
	
	// State
	running       atomic.Bool
	discoveryRate time.Duration
}

// NewPeerDiscovery creates peer discovery system
func NewPeerDiscovery(logger *zap.Logger, dht *DHT, network *UnifiedP2PNetwork) *PeerDiscovery {
	return &PeerDiscovery{
		logger:        logger.With(zap.String("component", "peer_discovery")),
		dht:           dht,
		network:       network,
		discoveryRate: 30 * time.Second,
		mdnsEnabled:   true,
		dnsEnabled:    true,
	}
}

// Start starts peer discovery
func (pd *PeerDiscovery) Start() error {
	if !pd.running.CompareAndSwap(false, true) {
		return nil // Already running
	}
	
	pd.logger.Info("Starting peer discovery")
	
	// Start discovery routines
	go pd.bootstrapDiscovery()
	go pd.dhtDiscovery()
	
	if pd.mdnsEnabled {
		go pd.mdnsDiscovery()
	}
	
	if pd.dnsEnabled {
		go pd.dnsDiscovery()
	}
	
	return nil
}

// Stop stops peer discovery
func (pd *PeerDiscovery) Stop() error {
	if !pd.running.CompareAndSwap(true, false) {
		return nil // Already stopped
	}
	
	pd.logger.Info("Stopping peer discovery")
	return nil
}

// Private discovery methods

func (pd *PeerDiscovery) bootstrapDiscovery() {
	ticker := time.NewTicker(pd.discoveryRate)
	defer ticker.Stop()
	
	for pd.running.Load() {
		select {
		case <-ticker.C:
			pd.discoverFromBootstrap()
		}
	}
}

func (pd *PeerDiscovery) dhtDiscovery() {
	ticker := time.NewTicker(pd.discoveryRate)
	defer ticker.Stop()
	
	for pd.running.Load() {
		select {
		case <-ticker.C:
			pd.discoverFromDHT()
		}
	}
}

func (pd *PeerDiscovery) mdnsDiscovery() {
	// mDNS discovery for local network peers
	ticker := time.NewTicker(pd.discoveryRate * 2)
	defer ticker.Stop()
	
	for pd.running.Load() {
		select {
		case <-ticker.C:
			pd.discoverViaMDNS()
		}
	}
}

func (pd *PeerDiscovery) dnsDiscovery() {
	// DNS-based peer discovery
	ticker := time.NewTicker(pd.discoveryRate * 4)
	defer ticker.Stop()
	
	for pd.running.Load() {
		select {
		case <-ticker.C:
			pd.discoverViaDNS()
		}
	}
}

func (pd *PeerDiscovery) discoverFromBootstrap() {
	// Connect to bootstrap nodes and request peers
	for _, nodeAddr := range pd.bootstrapNodes {
		if err := pd.network.connectToPeer(nodeAddr); err != nil {
			pd.logger.Debug("Failed to connect to bootstrap node",
				zap.String("address", nodeAddr),
				zap.Error(err),
			)
		}
	}
}

func (pd *PeerDiscovery) discoverFromDHT() {
	// Use DHT to find new peers
	randomID := generateNodeID()
	closestPeers := pd.dht.FindClosestPeers(randomID, 10)
	
	for _, peer := range closestPeers {
		if !peer.Connected.Load() {
			address := fmt.Sprintf("%s:%d", peer.Address, peer.Port)
			if err := pd.network.connectToPeer(address); err != nil {
				pd.logger.Debug("Failed to connect to DHT peer",
					zap.String("peer_id", peer.ID),
					zap.Error(err),
				)
			}
		}
	}
}

func (pd *PeerDiscovery) discoverViaMDNS() {
	// Simplified mDNS discovery
	pd.logger.Debug("Performing mDNS discovery")
	// In a real implementation, this would use mDNS protocol
}

func (pd *PeerDiscovery) discoverViaDNS() {
	// Simplified DNS discovery
	pd.logger.Debug("Performing DNS discovery")
	// In a real implementation, this would query DNS for peer lists
}

// NetworkSecurity implements additional security measures
type NetworkSecurity struct {
	logger         *zap.Logger
	rateLimiter    *RateLimiter
	trustedPeers   map[string]bool
	bannedPeers    sync.Map // map[string]time.Time
	
	// Reputation system
	peerReputations sync.Map // map[string]*PeerReputation
	
	// Threat detection
	threatDetector *ThreatDetector
}

// PeerReputation tracks peer reputation
type PeerReputation struct {
	Score          atomic.Int64  // -1000 to 1000
	LastUpdate     atomic.Int64  // Unix timestamp
	MessageCount   atomic.Uint64
	ValidShares    atomic.Uint64
	InvalidShares  atomic.Uint64
	Disconnections atomic.Uint64
}

// ThreatDetector detects malicious behavior
type ThreatDetector struct {
	logger            *zap.Logger
	
	// Anomaly detection
	messageRates      sync.Map // map[string]*MessageRateTracker
	connectionAttempts sync.Map // map[string]*ConnectionTracker
	
	// Thresholds
	maxMessageRate    int
	maxConnections    int
	suspiciousScore   int64
}

// MessageRateTracker tracks message rates per peer
type MessageRateTracker struct {
	Count      atomic.Uint64
	Window     time.Duration
	LastReset  atomic.Int64
}

// ConnectionTracker tracks connection attempts
type ConnectionTracker struct {
	Attempts   atomic.Uint64
	LastAttempt atomic.Int64
	Blocked    atomic.Bool
}

// NewNetworkSecurity creates network security system
func NewNetworkSecurity(logger *zap.Logger, rateLimiter *RateLimiter) *NetworkSecurity {
	return &NetworkSecurity{
		logger:       logger.With(zap.String("component", "network_security")),
		rateLimiter:  rateLimiter,
		trustedPeers: make(map[string]bool),
		threatDetector: &ThreatDetector{
			logger:          logger.With(zap.String("component", "threat_detector")),
			maxMessageRate:  1000,
			maxConnections:  10,
			suspiciousScore: -100,
		},
	}
}

// CheckPeer checks if peer is allowed to connect
func (ns *NetworkSecurity) CheckPeer(peerID string, clientIP string) bool {
	// Check if banned
	if banTime, exists := ns.bannedPeers.Load(peerID); exists {
		if time.Now().Before(banTime.(time.Time)) {
			ns.logger.Debug("Peer is banned", zap.String("peer_id", peerID))
			return false
		} else {
			// Ban expired, remove it
			ns.bannedPeers.Delete(peerID)
		}
	}
	
	// Check rate limit
	if !ns.rateLimiter.Allow(clientIP) {
		ns.logger.Debug("Peer rate limited", zap.String("client_ip", clientIP))
		return false
	}
	
	// Check reputation
	if rep, exists := ns.peerReputations.Load(peerID); exists {
		reputation := rep.(*PeerReputation)
		if reputation.Score.Load() < ns.threatDetector.suspiciousScore {
			ns.logger.Debug("Peer has low reputation", 
				zap.String("peer_id", peerID),
				zap.Int64("score", reputation.Score.Load()),
			)
			return false
		}
	}
	
	return true
}

// UpdatePeerReputation updates peer reputation based on behavior
func (ns *NetworkSecurity) UpdatePeerReputation(peerID string, action string, value int) {
	rep, _ := ns.peerReputations.LoadOrStore(peerID, &PeerReputation{})
	reputation := rep.(*PeerReputation)
	
	switch action {
	case "valid_share":
		reputation.ValidShares.Add(1)
		reputation.Score.Add(1)
	case "invalid_share":
		reputation.InvalidShares.Add(1)
		reputation.Score.Add(-5)
	case "disconnect":
		reputation.Disconnections.Add(1)
		reputation.Score.Add(-2)
	case "message":
		reputation.MessageCount.Add(1)
	}
	
	reputation.LastUpdate.Store(time.Now().Unix())
	
	// Check if peer should be banned
	if reputation.Score.Load() < -500 {
		ns.BanPeer(peerID, 24*time.Hour)
	}
}

// BanPeer bans a peer for specified duration
func (ns *NetworkSecurity) BanPeer(peerID string, duration time.Duration) {
	banUntil := time.Now().Add(duration)
	ns.bannedPeers.Store(peerID, banUntil)
	
	ns.logger.Warn("Peer banned",
		zap.String("peer_id", peerID),
		zap.Duration("duration", duration),
	)
}

// GetSecurityStats returns security statistics
func (ns *NetworkSecurity) GetSecurityStats() map[string]interface{} {
	stats := make(map[string]interface{})
	
	// Count banned peers
	bannedCount := 0
	ns.bannedPeers.Range(func(key, value interface{}) bool {
		bannedCount++
		return true
	})
	
	// Count peers with reputation
	reputationCount := 0
	ns.peerReputations.Range(func(key, value interface{}) bool {
		reputationCount++
		return true
	})
	
	stats["banned_peers"] = bannedCount
	stats["peers_with_reputation"] = reputationCount
	
	return stats
}
