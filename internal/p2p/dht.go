package p2p

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/bits"
	"math/rand"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DHT implements a Kademlia-style distributed hash table for P2P node discovery
type DHT struct {
	logger      *zap.Logger
	config      DHTConfig
	
	// Node identity
	nodeID      NodeID
	
	// Routing table
	routingTable *RoutingTable
	
	// Storage
	storage     *DHTStorage
	
	// Network
	transport   DHTTransport
	
	// Lifecycle
	ctx         context.Context
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	
	// Statistics
	stats       DHTStats
}

// DHTConfig defines DHT configuration
type DHTConfig struct {
	// Node settings
	NodeID          string        `yaml:"node_id"`      // Optional, auto-generated if empty
	BootstrapNodes  []string      `yaml:"bootstrap_nodes"`
	
	// Network settings
	ListenAddr      string        `yaml:"listen_addr"`
	MaxPeers        int           `yaml:"max_peers"`
	
	// Protocol settings
	BucketSize      int           `yaml:"bucket_size"`  // K in Kademlia
	Alpha           int           `yaml:"alpha"`        // Parallelism factor
	RefreshInterval time.Duration `yaml:"refresh_interval"`
	
	// Storage settings
	MaxStorageItems int           `yaml:"max_storage_items"`
	ItemExpiry      time.Duration `yaml:"item_expiry"`
	
	// Timeouts
	RequestTimeout  time.Duration `yaml:"request_timeout"`
	DialTimeout     time.Duration `yaml:"dial_timeout"`
}

// NodeID represents a node identifier in the DHT
type NodeID [32]byte

// Node represents a node in the DHT network
type Node struct {
	ID       NodeID    `json:"id"`
	Address  string    `json:"address"`
	LastSeen time.Time `json:"last_seen"`
	RTT      time.Duration `json:"rtt"`
}

// RoutingTable manages the K-buckets for the DHT
type RoutingTable struct {
	localID  NodeID
	buckets  [256]*KBucket // One bucket per bit
	mu       sync.RWMutex
}

// KBucket holds up to K nodes
type KBucket struct {
	nodes       []*Node
	maxSize     int
	lastUpdated time.Time
	mu          sync.RWMutex
}

// DHTStorage stores key-value pairs
type DHTStorage struct {
	items    sync.Map // map[string]StorageItem
	maxItems int
}

// StorageItem represents a stored value
type StorageItem struct {
	Key        string    `json:"key"`
	Value      []byte    `json:"value"`
	Publisher  NodeID    `json:"publisher"`
	Timestamp  time.Time `json:"timestamp"`
	Expiry     time.Time `json:"expiry"`
}

// DHTTransport handles network communication
type DHTTransport interface {
	Listen(addr string) error
	SendMessage(addr string, msg Message) error
	Close() error
}

// Message types for DHT protocol
type MessageType string

const (
	MessagePing      MessageType = "ping"
	MessagePong      MessageType = "pong"
	MessageFindNode  MessageType = "find_node"
	MessageFindValue MessageType = "find_value"
	MessageStore     MessageType = "store"
	MessageNodes     MessageType = "nodes"
	MessageValue     MessageType = "value"
)

// Message represents a DHT protocol message
type Message struct {
	Type      MessageType `json:"type"`
	ID        string      `json:"id"`
	Sender    NodeID      `json:"sender"`
	Target    NodeID      `json:"target,omitempty"`
	Key       string      `json:"key,omitempty"`
	Value     []byte      `json:"value,omitempty"`
	Nodes     []*Node     `json:"nodes,omitempty"`
	Timestamp time.Time   `json:"timestamp"`
}

// DHTStats tracks DHT statistics
type DHTStats struct {
	messagesReceived atomic.Uint64
	messagesSent     atomic.Uint64
	nodesDiscovered  atomic.Uint64
	lookups          atomic.Uint64
	stores           atomic.Uint64
	hits             atomic.Uint64
	misses           atomic.Uint64
}

// NewDHT creates a new distributed hash table
func NewDHT(logger *zap.Logger, config DHTConfig) (*DHT, error) {
	// Set defaults
	if config.BucketSize <= 0 {
		config.BucketSize = 20 // Kademlia default
	}
	if config.Alpha <= 0 {
		config.Alpha = 3
	}
	if config.RefreshInterval <= 0 {
		config.RefreshInterval = time.Hour
	}
	if config.MaxStorageItems <= 0 {
		config.MaxStorageItems = 10000
	}
	if config.ItemExpiry <= 0 {
		config.ItemExpiry = 24 * time.Hour
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 10 * time.Second
	}
	if config.DialTimeout <= 0 {
		config.DialTimeout = 5 * time.Second
	}
	
	// Generate or parse node ID
	var nodeID NodeID
	if config.NodeID != "" {
		id, err := hex.DecodeString(config.NodeID)
		if err != nil {
			return nil, fmt.Errorf("invalid node ID: %w", err)
		}
		copy(nodeID[:], id)
	} else {
		nodeID = GenerateNodeID()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	dht := &DHT{
		logger:       logger,
		config:       config,
		nodeID:       nodeID,
		routingTable: NewRoutingTable(nodeID, config.BucketSize),
		storage:      NewDHTStorage(config.MaxStorageItems),
		ctx:          ctx,
		cancel:       cancel,
	}
	
	return dht, nil
}

// Start begins DHT operations
func (d *DHT) Start() error {
	d.logger.Info("Starting DHT",
		zap.String("node_id", d.nodeID.String()),
		zap.String("listen_addr", d.config.ListenAddr),
	)
	
	// Create transport
	d.transport = NewUDPTransport(d.logger, d.handleMessage)
	if err := d.transport.Listen(d.config.ListenAddr); err != nil {
		return fmt.Errorf("failed to start transport: %w", err)
	}
	
	// Start background workers
	d.wg.Add(3)
	go d.refreshLoop()
	go d.expireLoop()
	go d.statsReporter()
	
	// Bootstrap if nodes configured
	if len(d.config.BootstrapNodes) > 0 {
		go d.bootstrap()
	}
	
	return nil
}

// Stop halts DHT operations
func (d *DHT) Stop() error {
	d.logger.Info("Stopping DHT")
	d.cancel()
	
	if d.transport != nil {
		d.transport.Close()
	}
	
	d.wg.Wait()
	return nil
}

// FindNode searches for nodes close to the target ID
func (d *DHT) FindNode(targetID NodeID) ([]*Node, error) {
	d.stats.lookups.Add(1)
	
	// Get closest nodes from routing table
	closest := d.routingTable.GetClosestNodes(targetID, d.config.BucketSize)
	
	// If we don't have enough nodes, perform iterative lookup
	if len(closest) < d.config.BucketSize {
		return d.iterativeFindNode(targetID)
	}
	
	return closest, nil
}

// Store stores a key-value pair in the DHT
func (d *DHT) Store(key string, value []byte) error {
	d.stats.stores.Add(1)
	
	// Hash key to get target ID
	keyID := HashKey(key)
	
	// Find nodes responsible for this key
	nodes, err := d.FindNode(keyID)
	if err != nil {
		return err
	}
	
	// Store locally if we're one of the closest nodes
	if d.isCloser(d.nodeID, nodes, keyID) {
		d.storage.Store(key, value, d.nodeID)
	}
	
	// Send store requests to K closest nodes
	storeMsg := Message{
		Type:      MessageStore,
		ID:        generateMessageID(),
		Sender:    d.nodeID,
		Key:       key,
		Value:     value,
		Timestamp: time.Now(),
	}
	
	for _, node := range nodes[:min(d.config.BucketSize, len(nodes))] {
		if node.ID == d.nodeID {
			continue
		}
		go d.transport.SendMessage(node.Address, storeMsg)
	}
	
	return nil
}

// Get retrieves a value from the DHT
func (d *DHT) Get(key string) ([]byte, error) {
	// Check local storage first
	if item, ok := d.storage.Get(key); ok {
		d.stats.hits.Add(1)
		return item.Value, nil
	}
	
	d.stats.misses.Add(1)
	
	// Perform iterative find value
	return d.iterativeFindValue(key)
}

// GetStats returns DHT statistics
func (d *DHT) GetStats() map[string]interface{} {
	totalNodes := 0
	d.routingTable.mu.RLock()
	for _, bucket := range d.routingTable.buckets {
		if bucket != nil {
			totalNodes += len(bucket.nodes)
		}
	}
	d.routingTable.mu.RUnlock()
	
	return map[string]interface{}{
		"node_id":           d.nodeID.String(),
		"total_nodes":       totalNodes,
		"messages_received": d.stats.messagesReceived.Load(),
		"messages_sent":     d.stats.messagesSent.Load(),
		"nodes_discovered":  d.stats.nodesDiscovered.Load(),
		"lookups":          d.stats.lookups.Load(),
		"stores":           d.stats.stores.Load(),
		"hits":             d.stats.hits.Load(),
		"misses":           d.stats.misses.Load(),
		"hit_rate":         d.calculateHitRate(),
	}
}

// Private methods

func (d *DHT) handleMessage(msg Message, from net.Addr) {
	d.stats.messagesReceived.Add(1)
	
	// Update routing table with sender
	node := &Node{
		ID:       msg.Sender,
		Address:  from.String(),
		LastSeen: time.Now(),
	}
	d.routingTable.AddNode(node)
	
	switch msg.Type {
	case MessagePing:
		d.handlePing(msg, from)
	case MessageFindNode:
		d.handleFindNode(msg, from)
	case MessageFindValue:
		d.handleFindValue(msg, from)
	case MessageStore:
		d.handleStore(msg, from)
	}
}

func (d *DHT) handlePing(msg Message, from net.Addr) {
	// Respond with pong
	pong := Message{
		Type:      MessagePong,
		ID:        msg.ID,
		Sender:    d.nodeID,
		Timestamp: time.Now(),
	}
	d.transport.SendMessage(from.String(), pong)
}

func (d *DHT) handleFindNode(msg Message, from net.Addr) {
	// Find closest nodes to target
	nodes := d.routingTable.GetClosestNodes(msg.Target, d.config.BucketSize)
	
	// Send response
	response := Message{
		Type:      MessageNodes,
		ID:        msg.ID,
		Sender:    d.nodeID,
		Nodes:     nodes,
		Timestamp: time.Now(),
	}
	d.transport.SendMessage(from.String(), response)
}

func (d *DHT) handleFindValue(msg Message, from net.Addr) {
	// Check if we have the value
	if item, ok := d.storage.Get(msg.Key); ok {
		// Send value
		response := Message{
			Type:      MessageValue,
			ID:        msg.ID,
			Sender:    d.nodeID,
			Key:       msg.Key,
			Value:     item.Value,
			Timestamp: time.Now(),
		}
		d.transport.SendMessage(from.String(), response)
		return
	}
	
	// Otherwise, return closest nodes
	keyID := HashKey(msg.Key)
	nodes := d.routingTable.GetClosestNodes(keyID, d.config.BucketSize)
	
	response := Message{
		Type:      MessageNodes,
		ID:        msg.ID,
		Sender:    d.nodeID,
		Nodes:     nodes,
		Timestamp: time.Now(),
	}
	d.transport.SendMessage(from.String(), response)
}

func (d *DHT) handleStore(msg Message, from net.Addr) {
	// Store the value
	d.storage.Store(msg.Key, msg.Value, msg.Sender)
}

func (d *DHT) iterativeFindNode(targetID NodeID) ([]*Node, error) {
	// Implement iterative node lookup
	seen := make(map[string]bool)
	closest := d.routingTable.GetClosestNodes(targetID, d.config.BucketSize)
	
	for i := 0; i < 3; i++ { // Max 3 iterations
		// Query Alpha nodes in parallel
		var wg sync.WaitGroup
		results := make(chan []*Node, d.config.Alpha)
		
		for j := 0; j < d.config.Alpha && j < len(closest); j++ {
			node := closest[j]
			if seen[node.ID.String()] {
				continue
			}
			seen[node.ID.String()] = true
			
			wg.Add(1)
			go func(n *Node) {
				defer wg.Done()
				nodes := d.queryNode(n, targetID)
				results <- nodes
			}(node)
		}
		
		wg.Wait()
		close(results)
		
		// Merge results
		for nodes := range results {
			for _, n := range nodes {
				if !seen[n.ID.String()] {
					closest = append(closest, n)
				}
			}
		}
		
		// Sort by distance
		sort.Slice(closest, func(i, j int) bool {
			return d.nodeID.Distance(closest[i].ID) < d.nodeID.Distance(closest[j].ID)
		})
		
		// Keep only K closest
		if len(closest) > d.config.BucketSize {
			closest = closest[:d.config.BucketSize]
		}
	}
	
	return closest, nil
}

func (d *DHT) iterativeFindValue(key string) ([]byte, error) {
	// Similar to iterativeFindNode but returns value if found
	// Implementation omitted for brevity
	return nil, fmt.Errorf("value not found")
}

func (d *DHT) queryNode(node *Node, targetID NodeID) []*Node {
	msg := Message{
		Type:      MessageFindNode,
		ID:        generateMessageID(),
		Sender:    d.nodeID,
		Target:    targetID,
		Timestamp: time.Now(),
	}
	
	// Send message and wait for response
	// This is simplified - real implementation would use channels
	d.transport.SendMessage(node.Address, msg)
	d.stats.messagesSent.Add(1)
	
	// Return empty for now
	return []*Node{}
}

func (d *DHT) bootstrap() {
	for _, addr := range d.config.BootstrapNodes {
		// Ping bootstrap node
		ping := Message{
			Type:      MessagePing,
			ID:        generateMessageID(),
			Sender:    d.nodeID,
			Timestamp: time.Now(),
		}
		d.transport.SendMessage(addr, ping)
		
		// Find nodes close to ourselves
		d.iterativeFindNode(d.nodeID)
	}
}

func (d *DHT) refreshLoop() {
	defer d.wg.Done()
	ticker := time.NewTicker(d.config.RefreshInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-d.ctx.Done():
			return
		case <-ticker.C:
			d.refresh()
		}
	}
}

func (d *DHT) refresh() {
	// Refresh buckets that haven't been updated recently
	d.routingTable.mu.RLock()
	for i, bucket := range d.routingTable.buckets {
		if bucket != nil && time.Since(bucket.lastUpdated) > d.config.RefreshInterval {
			// Generate random ID in this bucket's range
			targetID := d.generateIDInBucket(i)
			go d.iterativeFindNode(targetID)
		}
	}
	d.routingTable.mu.RUnlock()
}

func (d *DHT) generateIDInBucket(bucketIndex int) NodeID {
	// Generate ID with specific distance from local ID
	var id NodeID
	// Implementation details omitted
	return id
}

func (d *DHT) expireLoop() {
	defer d.wg.Done()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-d.ctx.Done():
			return
		case <-ticker.C:
			d.storage.ExpireOldItems()
		}
	}
}

func (d *DHT) statsReporter() {
	defer d.wg.Done()
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-d.ctx.Done():
			return
		case <-ticker.C:
			stats := d.GetStats()
			d.logger.Info("DHT statistics", zap.Any("stats", stats))
		}
	}
}

func (d *DHT) isCloser(nodeID NodeID, nodes []*Node, targetID NodeID) bool {
	if len(nodes) == 0 {
		return true
	}
	
	ourDistance := nodeID.Distance(targetID)
	furthestDistance := nodes[len(nodes)-1].ID.Distance(targetID)
	
	return ourDistance < furthestDistance
}

func (d *DHT) calculateHitRate() float64 {
	hits := d.stats.hits.Load()
	total := hits + d.stats.misses.Load()
	if total == 0 {
		return 0
	}
	return float64(hits) / float64(total) * 100
}

// NodeID methods

// GenerateNodeID creates a random node ID
func GenerateNodeID() NodeID {
	var id NodeID
	hash := sha256.Sum256([]byte(fmt.Sprintf("%d%d", time.Now().UnixNano(), rand.Int())))
	copy(id[:], hash[:])
	return id
}

// HashKey converts a string key to a NodeID
func HashKey(key string) NodeID {
	return sha256.Sum256([]byte(key))
}

// String returns hex representation of NodeID
func (n NodeID) String() string {
	return hex.EncodeToString(n[:])
}

// Distance calculates XOR distance between two NodeIDs
func (n NodeID) Distance(other NodeID) int {
	for i := 0; i < 32; i++ {
		xor := n[i] ^ other[i]
		if xor != 0 {
			return i*8 + bits.LeadingZeros8(xor)
		}
	}
	return 256
}

// RoutingTable methods

func NewRoutingTable(localID NodeID, bucketSize int) *RoutingTable {
	rt := &RoutingTable{
		localID: localID,
	}
	
	// Initialize buckets
	for i := range rt.buckets {
		rt.buckets[i] = &KBucket{
			maxSize: bucketSize,
			nodes:   make([]*Node, 0, bucketSize),
		}
	}
	
	return rt
}

func (rt *RoutingTable) AddNode(node *Node) {
	if node.ID == rt.localID {
		return // Don't add ourselves
	}
	
	// Find appropriate bucket
	distance := rt.localID.Distance(node.ID)
	bucketIndex := distance
	if bucketIndex >= 256 {
		bucketIndex = 255
	}
	
	rt.mu.Lock()
	bucket := rt.buckets[bucketIndex]
	rt.mu.Unlock()
	
	bucket.AddNode(node)
}

func (rt *RoutingTable) GetClosestNodes(targetID NodeID, count int) []*Node {
	var allNodes []*Node
	
	rt.mu.RLock()
	for _, bucket := range rt.buckets {
		bucket.mu.RLock()
		allNodes = append(allNodes, bucket.nodes...)
		bucket.mu.RUnlock()
	}
	rt.mu.RUnlock()
	
	// Sort by distance to target
	sort.Slice(allNodes, func(i, j int) bool {
		return allNodes[i].ID.Distance(targetID) < allNodes[j].ID.Distance(targetID)
	})
	
	// Return up to count nodes
	if len(allNodes) > count {
		return allNodes[:count]
	}
	return allNodes
}

// KBucket methods

func (kb *KBucket) AddNode(node *Node) {
	kb.mu.Lock()
	defer kb.mu.Unlock()
	
	// Check if node already exists
	for i, n := range kb.nodes {
		if n.ID == node.ID {
			// Update existing node
			kb.nodes[i] = node
			kb.lastUpdated = time.Now()
			return
		}
	}
	
	// Add new node if space available
	if len(kb.nodes) < kb.maxSize {
		kb.nodes = append(kb.nodes, node)
		kb.lastUpdated = time.Now()
		return
	}
	
	// Bucket full - implement replacement policy
	// For now, just ignore new node
}

// DHTStorage methods

func NewDHTStorage(maxItems int) *DHTStorage {
	return &DHTStorage{
		maxItems: maxItems,
	}
}

func (ds *DHTStorage) Store(key string, value []byte, publisher NodeID) {
	item := StorageItem{
		Key:       key,
		Value:     value,
		Publisher: publisher,
		Timestamp: time.Now(),
		Expiry:    time.Now().Add(24 * time.Hour),
	}
	ds.items.Store(key, item)
}

func (ds *DHTStorage) Get(key string) (StorageItem, bool) {
	if val, ok := ds.items.Load(key); ok {
		item := val.(StorageItem)
		if time.Now().Before(item.Expiry) {
			return item, true
		}
		// Expired, remove it
		ds.items.Delete(key)
	}
	return StorageItem{}, false
}

func (ds *DHTStorage) ExpireOldItems() {
	now := time.Now()
	ds.items.Range(func(key, value interface{}) bool {
		item := value.(StorageItem)
		if now.After(item.Expiry) {
			ds.items.Delete(key)
		}
		return true
	})
}

// Helper functions

func generateMessageID() string {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(time.Now().UnixNano()))
	return hex.EncodeToString(b)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}