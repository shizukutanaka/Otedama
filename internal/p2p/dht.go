package p2p

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/big"
	"net"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"
)

// DHTNode represents a node in the distributed hash table
type DHTNode struct {
	ID       NodeID
	Address  string
	LastSeen time.Time
	RTT      time.Duration // Round-trip time
}

// NodeID is a 256-bit identifier for nodes
type NodeID [32]byte

// DHTConfig contains DHT configuration
type DHTConfig struct {
	NodeID          NodeID
	BootstrapNodes  []string
	BucketSize      int           // K parameter in Kademlia
	Alpha           int           // Concurrency parameter
	RefreshInterval time.Duration
	StoreInterval   time.Duration
	ExpireTime      time.Duration
}

// DHT implements a Kademlia-based distributed hash table
type DHT struct {
	logger         *zap.Logger
	config         DHTConfig
	localNode      *DHTNode
	routingTable   *RoutingTable
	storage        sync.Map // key -> value storage
	pendingQueries sync.Map // queryID -> callback
	mu             sync.RWMutex
	shutdown       chan struct{}
}

// RoutingTable manages K-buckets for the DHT
type RoutingTable struct {
	localID  NodeID
	buckets  [256]*KBucket // 256 buckets for 256-bit IDs
	mu       sync.RWMutex
	logger   *zap.Logger
}

// KBucket stores K closest nodes
type KBucket struct {
	nodes    []*DHTNode
	capacity int
	mu       sync.RWMutex
}

// DHTMessage represents a message in the DHT protocol
type DHTMessage struct {
	Type      string                 `json:"type"`
	ID        string                 `json:"id"`
	Sender    NodeID                 `json:"sender"`
	Target    NodeID                 `json:"target,omitempty"`
	Key       string                 `json:"key,omitempty"`
	Value     []byte                 `json:"value,omitempty"`
	Nodes     []DHTNode              `json:"nodes,omitempty"`
	Token     string                 `json:"token,omitempty"`
	Data      map[string]interface{} `json:"data,omitempty"`
}

// NewDHT creates a new distributed hash table
func NewDHT(config DHTConfig, logger *zap.Logger) (*DHT, error) {
	if config.BucketSize == 0 {
		config.BucketSize = 20 // Default K value
	}
	if config.Alpha == 0 {
		config.Alpha = 3 // Default alpha value
	}
	if config.RefreshInterval == 0 {
		config.RefreshInterval = 1 * time.Hour
	}
	if config.StoreInterval == 0 {
		config.StoreInterval = 1 * time.Hour
	}
	if config.ExpireTime == 0 {
		config.ExpireTime = 24 * time.Hour
	}

	dht := &DHT{
		logger: logger,
		config: config,
		localNode: &DHTNode{
			ID:       config.NodeID,
			LastSeen: time.Now(),
		},
		routingTable: NewRoutingTable(config.NodeID, config.BucketSize, logger),
		shutdown:     make(chan struct{}),
	}

	return dht, nil
}

// NewRoutingTable creates a new routing table
func NewRoutingTable(localID NodeID, bucketSize int, logger *zap.Logger) *RoutingTable {
	rt := &RoutingTable{
		localID: localID,
		logger:  logger,
	}

	// Initialize all buckets
	for i := range rt.buckets {
		rt.buckets[i] = &KBucket{
			capacity: bucketSize,
		}
	}

	return rt
}

// Start starts the DHT node
func (dht *DHT) Start(listenAddr string) error {
	dht.logger.Info("Starting DHT node",
		zap.String("node_id", hex.EncodeToString(dht.localNode.ID[:])),
		zap.String("listen_addr", listenAddr))

	// Update local node address
	dht.localNode.Address = listenAddr

	// Bootstrap from known nodes
	if err := dht.bootstrap(); err != nil {
		dht.logger.Warn("Bootstrap failed", zap.Error(err))
	}

	// Start maintenance routines
	go dht.refreshRoutine()
	go dht.expireRoutine()

	return nil
}

// Stop stops the DHT node
func (dht *DHT) Stop() error {
	close(dht.shutdown)
	return nil
}

// FindNode finds nodes closest to the target ID
func (dht *DHT) FindNode(targetID NodeID) ([]*DHTNode, error) {
	// Get initial nodes from routing table
	closest := dht.routingTable.FindClosest(targetID, dht.config.Alpha)
	
	// If we have no nodes, return empty
	if len(closest) == 0 {
		return nil, fmt.Errorf("no nodes in routing table")
	}

	// Perform iterative lookup
	queried := make(map[string]bool)
	results := make([]*DHTNode, 0)
	mu := sync.Mutex{}

	for {
		// Find unqueried nodes
		toQuery := make([]*DHTNode, 0)
		for _, node := range closest {
			if !queried[node.ID.String()] && node.ID != dht.localNode.ID {
				toQuery = append(toQuery, node)
				if len(toQuery) >= dht.config.Alpha {
					break
				}
			}
		}

		if len(toQuery) == 0 {
			break
		}

		// Query nodes in parallel
		var wg sync.WaitGroup
		for _, node := range toQuery {
			queried[node.ID.String()] = true
			wg.Add(1)

			go func(n *DHTNode) {
				defer wg.Done()
				
				// Send FIND_NODE request
				nodes, err := dht.sendFindNode(n, targetID)
				if err != nil {
					dht.logger.Debug("FIND_NODE failed",
						zap.String("node", n.Address),
						zap.Error(err))
					return
				}

				// Add discovered nodes
				mu.Lock()
				for _, discovered := range nodes {
					dht.routingTable.AddNode(discovered)
					results = append(results, discovered)
				}
				mu.Unlock()
			}(node)
		}

		wg.Wait()

		// Update closest nodes
		mu.Lock()
		closest = dht.sortByDistance(append(closest, results...), targetID)
		if len(closest) > dht.config.BucketSize {
			closest = closest[:dht.config.BucketSize]
		}
		mu.Unlock()
	}

	return closest, nil
}

// Store stores a key-value pair in the DHT
func (dht *DHT) Store(key string, value []byte) error {
	keyHash := dht.hashKey(key)
	
	// Store locally
	dht.storage.Store(key, &StoredValue{
		Value:     value,
		Timestamp: time.Now(),
	})

	// Find nodes to store on
	nodes, err := dht.FindNode(keyHash)
	if err != nil {
		return fmt.Errorf("failed to find nodes: %w", err)
	}

	// Store on K closest nodes
	stored := 0
	for _, node := range nodes {
		if node.ID == dht.localNode.ID {
			continue
		}

		if err := dht.sendStore(node, key, value); err != nil {
			dht.logger.Debug("STORE failed",
				zap.String("node", node.Address),
				zap.Error(err))
			continue
		}

		stored++
		if stored >= dht.config.BucketSize {
			break
		}
	}

	if stored == 0 {
		return fmt.Errorf("failed to store on any nodes")
	}

	return nil
}

// Get retrieves a value from the DHT
func (dht *DHT) Get(key string) ([]byte, error) {
	// Check local storage first
	if val, ok := dht.storage.Load(key); ok {
		if sv, ok := val.(*StoredValue); ok {
			if time.Since(sv.Timestamp) < dht.config.ExpireTime {
				return sv.Value, nil
			}
			dht.storage.Delete(key)
		}
	}

	keyHash := dht.hashKey(key)

	// Find nodes that might have the value
	nodes, err := dht.FindNode(keyHash)
	if err != nil {
		return nil, fmt.Errorf("failed to find nodes: %w", err)
	}

	// Query nodes for the value
	for _, node := range nodes {
		if node.ID == dht.localNode.ID {
			continue
		}

		value, err := dht.sendFindValue(node, key)
		if err != nil {
			continue
		}

		if value != nil {
			// Cache the value locally
			dht.storage.Store(key, &StoredValue{
				Value:     value,
				Timestamp: time.Now(),
			})
			return value, nil
		}
	}

	return nil, fmt.Errorf("value not found")
}

// AddNode adds a node to the routing table
func (rt *RoutingTable) AddNode(node *DHTNode) error {
	if node.ID == rt.localID {
		return nil // Don't add self
	}

	bucketIdx := rt.getBucketIndex(node.ID)
	bucket := rt.buckets[bucketIdx]

	bucket.mu.Lock()
	defer bucket.mu.Unlock()

	// Check if node already exists
	for i, existing := range bucket.nodes {
		if existing.ID == node.ID {
			// Update existing node
			bucket.nodes[i] = node
			return nil
		}
	}

	// Add new node if bucket not full
	if len(bucket.nodes) < bucket.capacity {
		bucket.nodes = append(bucket.nodes, node)
		rt.logger.Debug("Added node to routing table",
			zap.String("node_id", hex.EncodeToString(node.ID[:])),
			zap.Int("bucket", bucketIdx))
		return nil
	}

	// Bucket is full - implement replacement policy
	// Find least recently seen node
	var oldestIdx int
	oldestTime := bucket.nodes[0].LastSeen
	for i, n := range bucket.nodes {
		if n.LastSeen.Before(oldestTime) {
			oldestIdx = i
			oldestTime = n.LastSeen
		}
	}

	// Replace if new node is more recent
	if node.LastSeen.After(oldestTime) {
		bucket.nodes[oldestIdx] = node
	}

	return nil
}

// FindClosest finds the K closest nodes to a target ID
func (rt *RoutingTable) FindClosest(targetID NodeID, count int) []*DHTNode {
	rt.mu.RLock()
	defer rt.mu.RUnlock()

	allNodes := make([]*DHTNode, 0)

	// Collect all nodes from buckets
	for _, bucket := range rt.buckets {
		bucket.mu.RLock()
		allNodes = append(allNodes, bucket.nodes...)
		bucket.mu.RUnlock()
	}

	// Sort by distance to target
	sort.Slice(allNodes, func(i, j int) bool {
		return compareDistance(allNodes[i].ID, allNodes[j].ID, targetID) < 0
	})

	// Return up to count nodes
	if len(allNodes) > count {
		return allNodes[:count]
	}
	return allNodes
}

// getBucketIndex calculates which bucket a node ID belongs to
func (rt *RoutingTable) getBucketIndex(nodeID NodeID) int {
	// XOR with local ID
	distance := xorDistance(rt.localID, nodeID)
	
	// Find first non-zero bit
	for i := 0; i < 256; i++ {
		byteIdx := i / 8
		bitIdx := uint(7 - (i % 8))
		
		if distance[byteIdx]&(1<<bitIdx) != 0 {
			return 255 - i
		}
	}
	
	return 0
}

// Utility functions

// hashKey generates a node ID from a key
func (dht *DHT) hashKey(key string) NodeID {
	hash := sha256.Sum256([]byte(key))
	return NodeID(hash)
}

// xorDistance calculates XOR distance between two node IDs
func xorDistance(a, b NodeID) NodeID {
	var result NodeID
	for i := range a {
		result[i] = a[i] ^ b[i]
	}
	return result
}

// compareDistance compares distances from two nodes to a target
func compareDistance(a, b, target NodeID) int {
	distA := xorDistance(a, target)
	distB := xorDistance(b, target)
	
	aInt := new(big.Int).SetBytes(distA[:])
	bInt := new(big.Int).SetBytes(distB[:])
	
	return aInt.Cmp(bInt)
}

// sortByDistance sorts nodes by distance to target
func (dht *DHT) sortByDistance(nodes []*DHTNode, target NodeID) []*DHTNode {
	sorted := make([]*DHTNode, len(nodes))
	copy(sorted, nodes)
	
	sort.Slice(sorted, func(i, j int) bool {
		return compareDistance(sorted[i].ID, sorted[j].ID, target) < 0
	})
	
	return sorted
}

// String returns string representation of NodeID
func (id NodeID) String() string {
	return hex.EncodeToString(id[:])
}

// bootstrap connects to initial nodes
func (dht *DHT) bootstrap() error {
	if len(dht.config.BootstrapNodes) == 0 {
		return nil
	}

	dht.logger.Info("Bootstrapping DHT",
		zap.Int("bootstrap_nodes", len(dht.config.BootstrapNodes)))

	for _, addr := range dht.config.BootstrapNodes {
		// Parse address and generate node ID from it
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			host = addr
		}
		
		nodeID := sha256.Sum256([]byte(host))
		node := &DHTNode{
			ID:       NodeID(nodeID),
			Address:  addr,
			LastSeen: time.Now(),
		}

		// Add to routing table
		dht.routingTable.AddNode(node)

		// Find nodes near our ID
		nodes, err := dht.sendFindNode(node, dht.localNode.ID)
		if err != nil {
			dht.logger.Warn("Bootstrap node unreachable",
				zap.String("addr", addr),
				zap.Error(err))
			continue
		}

		// Add discovered nodes
		for _, n := range nodes {
			dht.routingTable.AddNode(n)
		}
	}

	return nil
}

// refreshRoutine periodically refreshes buckets
func (dht *DHT) refreshRoutine() {
	ticker := time.NewTicker(dht.config.RefreshInterval)
	defer ticker.Stop()

	for {
		select {
		case <-dht.shutdown:
			return
		case <-ticker.C:
			dht.refresh()
		}
	}
}

// refresh refreshes stale buckets
func (dht *DHT) refresh() {
	dht.logger.Debug("Refreshing DHT buckets")

	// Generate random IDs in each bucket's range
	for i := 0; i < 256; i++ {
		// Create random ID in bucket's range
		var randomID NodeID
		rand.Read(randomID[:])
		
		// Set appropriate prefix bits
		prefixBytes := i / 8
		prefixBits := i % 8
		
		// Copy prefix from local ID
		for j := 0; j < prefixBytes; j++ {
			randomID[j] = dht.localNode.ID[j]
		}
		
		// Set prefix bits
		if prefixBits > 0 {
			mask := byte(0xFF << (8 - prefixBits))
			randomID[prefixBytes] = (dht.localNode.ID[prefixBytes] & mask) | 
				(randomID[prefixBytes] & ^mask)
		}

		// Find nodes near this ID
		go dht.FindNode(randomID)
	}
}

// expireRoutine removes expired values
func (dht *DHT) expireRoutine() {
	ticker := time.NewTicker(dht.config.StoreInterval)
	defer ticker.Stop()

	for {
		select {
		case <-dht.shutdown:
			return
		case <-ticker.C:
			dht.expireValues()
		}
	}
}

// expireValues removes expired stored values
func (dht *DHT) expireValues() {
	now := time.Now()
	expired := 0

	dht.storage.Range(func(key, value interface{}) bool {
		if sv, ok := value.(*StoredValue); ok {
			if now.Sub(sv.Timestamp) > dht.config.ExpireTime {
				dht.storage.Delete(key)
				expired++
			}
		}
		return true
	})

	if expired > 0 {
		dht.logger.Debug("Expired stored values", zap.Int("count", expired))
	}
}

// StoredValue represents a value stored in the DHT
type StoredValue struct {
	Value     []byte
	Timestamp time.Time
}

// Network message handlers (stubs for actual implementation)

func (dht *DHT) sendFindNode(node *DHTNode, targetID NodeID) ([]*DHTNode, error) {
	// TODO: Implement actual network communication
	// This is a stub that returns empty results
	return []*DHTNode{}, nil
}

func (dht *DHT) sendStore(node *DHTNode, key string, value []byte) error {
	// TODO: Implement actual network communication
	return nil
}

func (dht *DHT) sendFindValue(node *DHTNode, key string) ([]byte, error) {
	// TODO: Implement actual network communication
	return nil, fmt.Errorf("not implemented")
}

// GetStats returns DHT statistics
func (dht *DHT) GetStats() map[string]interface{} {
	stats := make(map[string]interface{})
	
	// Count total nodes in routing table
	totalNodes := 0
	for _, bucket := range dht.routingTable.buckets {
		bucket.mu.RLock()
		totalNodes += len(bucket.nodes)
		bucket.mu.RUnlock()
	}

	// Count stored values
	storedValues := 0
	dht.storage.Range(func(_, _ interface{}) bool {
		storedValues++
		return true
	})

	stats["node_id"] = dht.localNode.ID.String()
	stats["total_nodes"] = totalNodes
	stats["stored_values"] = storedValues
	stats["bucket_size"] = dht.config.BucketSize
	
	return stats
}

