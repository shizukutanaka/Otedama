package p2p

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"math/big"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	// "github.com/shizukutanaka/Otedama/internal/datastructures" // Not used
	// "github.com/shizukutanaka/Otedama/internal/optimization" // Temporarily disabled
	"github.com/vmihailenco/msgpack/v5"
	"go.uber.org/zap"
)

const (
	// DHT constants
	DHTBucketSize       = 20
	DHTAlpha           = 3
	DHTMaxMessageSize  = 65536
	DHTTimeout         = 10 * time.Second
	DHTRefreshInterval = 1 * time.Hour
	DHTReplicationFactor = 20
	DHTMaxStoreKeys    = 65536
	DHTKeyExpiration   = 24 * time.Hour
)

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
	MaxStorageItems int           `yaml:"item_expiry"`
	ItemExpiry      time.Duration `yaml:"item_expiry"`
	
	// Timeouts
	RequestTimeout  time.Duration `yaml:"request_timeout"`
	DialTimeout     time.Duration `yaml:"dial_timeout"`
}

// DHTTransport handles network communication
type DHTTransport interface {
	Listen(addr string) error
	SendMessage(addr string, msg interface{}) error
	Close() error
}

// DHTNode represents a node in the DHT
type DHTNode struct {
	ID       NodeID
	IP       net.IP
	Port     uint16
	LastSeen time.Time
	RTT      time.Duration // Round trip time
}

// NodeID represents a node identifier
type NodeID [32]byte

// NewNodeID creates a new node ID from bytes
func NewNodeID(data []byte) NodeID {
	var id NodeID
	if len(data) >= 32 {
		copy(id[:], data[:32])
	} else {
		hash := sha256.Sum256(data)
		id = NodeID(hash)
	}
	return id
}

// Distance calculates XOR distance between two node IDs
func (id NodeID) Distance(other NodeID) *big.Int {
	dist := new(big.Int)
	xor := make([]byte, 32)
	for i := 0; i < 32; i++ {
		xor[i] = id[i] ^ other[i]
	}
	dist.SetBytes(xor)
	return dist
}

// CommonPrefixLen returns the number of common prefix bits
func (id NodeID) CommonPrefixLen(other NodeID) int {
	for i := 0; i < 32; i++ {
		xor := id[i] ^ other[i]
		if xor != 0 {
			return i*8 + (7 - int(math.Log2(float64(xor))))
		}
	}
	return 256
}

// DHT is an alias for DistributedHashTable for compatibility
type DHT = DistributedHashTable

// DistributedHashTable implements Kademlia-style DHT
type DistributedHashTable struct {
	logger       *zap.Logger
	config       DHTConfig
	nodeID       NodeID
	routingTable *RoutingTable
	storage      *DHTStorage
	transport    DHTTransport
	rpc          *DHTRPC
	// memPool      *optimization.MemoryPool // Temporarily disabled
	
	ctx          context.Context
	cancel       context.CancelFunc
	refreshTicker *time.Ticker
	closeCh      chan struct{}
	wg           sync.WaitGroup
	
	// Metrics
	lookupCount      atomic.Uint64
	storeCount       atomic.Uint64
	retrieveCount    atomic.Uint64
	avgLookupTime    atomic.Int64 // microseconds
	messagesReceived atomic.Uint64
	messagesSent     atomic.Uint64
	nodesDiscovered  atomic.Uint64
}

// RoutingTable manages k-buckets
type RoutingTable struct {
	nodeID  NodeID
	buckets [256]*KBucket
	mu      sync.RWMutex
}

// KBucket represents a k-bucket in the routing table
type KBucket struct {
	nodes        []*DHTNode
	replacements []*DHTNode
	lastRefresh  time.Time
	mu           sync.RWMutex
}

// DHTStorage handles local key-value storage
type DHTStorage struct {
	data       sync.Map // key -> *StoredValue
	keyCount   atomic.Int32
	totalSize  atomic.Int64
	// memPool    *optimization.MemoryPool // Temporarily disabled
	expiryChan chan string
}

// StoredValue represents a stored value with metadata
type StoredValue struct {
	Key        string
	Value      []byte
	Publisher  NodeID
	Timestamp  time.Time
	Expiration time.Time
	Replicated bool
}

// DHTRPC handles DHT protocol messages
type DHTRPC struct {
	dht      *DistributedHashTable
	listener net.Listener
	handlers map[MessageType]MessageHandler
	// memPool  *optimization.MemoryPool // Temporarily disabled
}

// MessageType represents DHT message types
type MessageType uint8

const (
	MessageTypePing MessageType = iota
	MessageTypeStore
	MessageTypeFindNode
	MessageTypeFindValue
	MessageTypeAnnounce
)

// MessageHandler handles DHT messages
type MessageHandler func(context.Context, *DHTMessage) (*DHTMessage, error)

// DHTMessage represents a DHT protocol message
type DHTMessage struct {
	Type      MessageType
	MessageID uint64
	Sender    NodeID
	Target    NodeID
	Key       []byte
	Value     []byte
	Nodes     []*DHTNode
	Token     []byte
}

// NewDistributedHashTable creates a new DHT instance
// NewDHT creates a new DHT with configuration
func NewDHT(logger *zap.Logger, config DHTConfig) (*DHT, error) {
	// Set defaults
	if config.BucketSize <= 0 {
		config.BucketSize = DHTBucketSize
	}
	if config.Alpha <= 0 {
		config.Alpha = DHTAlpha
	}
	if config.RefreshInterval <= 0 {
		config.RefreshInterval = DHTRefreshInterval
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = DHTTimeout
	}
	if config.MaxStorageItems <= 0 {
		config.MaxStorageItems = DHTMaxStoreKeys
	}
	if config.ItemExpiry <= 0 {
		config.ItemExpiry = DHTKeyExpiration
	}
	
	// Generate or parse node ID
	var nodeID NodeID
	if config.NodeID != "" {
		bytes, err := hex.DecodeString(config.NodeID)
		if err != nil || len(bytes) != 32 {
			return nil, fmt.Errorf("invalid node ID: %s", config.NodeID)
		}
		copy(nodeID[:], bytes)
	} else {
		// Generate random node ID
		nodeID = GenerateNodeID()
	}
	
	dht := &DistributedHashTable{
		logger:       logger,
		config:       config,
		nodeID:       nodeID,
		routingTable: NewRoutingTable(nodeID),
		// memPool:      optimization.NewMemoryPool(), // Temporarily disabled
		closeCh:      make(chan struct{}),
	}
	
	// Initialize storage with config
	dht.storage = &DHTStorage{
		maxKeys:   config.MaxStorageItems,
		keyExpiry: config.ItemExpiry,
	}
	
	// Initialize transport if provided
	if dht.transport == nil {
		// Use default UDP transport
		dht.transport = &UDPTransport{logger: logger}
	}
	
	dht.rpc = &DHTRPC{
		dht:      dht,
		handlers: make(map[DHTMessageType]MessageHandler),
		timeout:  config.RequestTimeout,
	}
	
	dht.registerHandlers()
	
	return dht, nil
}

func NewDistributedHashTable(nodeID NodeID, logger *zap.Logger) *DistributedHashTable {
	dht := &DistributedHashTable{
		logger:       logger,
		nodeID:       nodeID,
		routingTable: NewRoutingTable(nodeID),
		// memPool:      optimization.NewMemoryPool(), // Temporarily disabled
		closeCh:      make(chan struct{}),
	}
	
	// Initialize storage
	dht.storage = &DHTStorage{
		memPool:    dht.memPool,
		expiryChan: make(chan string, 100),
	}
	
	// Initialize RPC
	dht.rpc = &DHTRPC{
		dht:      dht,
		handlers: make(map[MessageType]MessageHandler),
		memPool:  dht.memPool,
	}
	
	// Register message handlers
	dht.registerHandlers()
	
	return dht
}

// Start starts the DHT node
func (dht *DistributedHashTable) Start(ctx context.Context, listenAddr string) error {
	// Start RPC listener
	listener, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return fmt.Errorf("failed to start listener: %w", err)
	}
	dht.rpc.listener = listener
	
	// Start background routines
	dht.wg.Add(4)
	go dht.rpcServer(ctx)
	go dht.refreshRoutine(ctx)
	go dht.expiryRoutine(ctx)
	go dht.replicationRoutine(ctx)
	
	dht.logger.Info("DHT started",
		zap.String("node_id", hex.EncodeToString(dht.nodeID[:])),
		zap.String("listen_addr", listenAddr))
	
	return nil
}

// Stop stops the DHT node
func (dht *DistributedHashTable) Stop() {
	close(dht.closeCh)
	if dht.rpc.listener != nil {
		dht.rpc.listener.Close()
	}
	dht.wg.Wait()
	
	dht.logger.Info("DHT stopped")
}

// Store stores a key-value pair in the DHT
func (dht *DistributedHashTable) Store(ctx context.Context, key []byte, value []byte) error {
	keyHash := sha256.Sum256(key)
	keyID := NodeID(keyHash)
	
	// Find k closest nodes to the key
	nodes := dht.FindNode(ctx, keyID, DHTReplicationFactor)
	
	// Store locally if we're one of the k closest
	dht.storeLocal(hex.EncodeToString(key), value, dht.nodeID)
	
	// Replicate to k closest nodes
	var wg sync.WaitGroup
	successCount := atomic.Int32{}
	
	for _, node := range nodes {
		if node.ID == dht.nodeID {
			continue
		}
		
		wg.Add(1)
		go func(n *DHTNode) {
			defer wg.Done()
			
			msg := &DHTMessage{
				Type:      MessageTypeStore,
				MessageID: generateMessageID(),
				Sender:    dht.nodeID,
				Key:       key,
				Value:     value,
			}
			
			if _, err := dht.rpc.sendMessage(ctx, n, msg); err == nil {
				successCount.Add(1)
			}
		}(node)
	}
	
	wg.Wait()
	
	// Update metrics
	dht.storeCount.Add(1)
	
	if successCount.Load() < int32(DHTReplicationFactor/2) {
		return fmt.Errorf("insufficient replicas: %d/%d", successCount.Load(), DHTReplicationFactor)
	}
	
	return nil
}

// Retrieve retrieves a value from the DHT
func (dht *DistributedHashTable) Retrieve(ctx context.Context, key []byte) ([]byte, error) {
	startTime := time.Now()
	defer func() {
		dht.avgLookupTime.Store(time.Since(startTime).Microseconds())
		dht.retrieveCount.Add(1)
	}()
	
	keyStr := hex.EncodeToString(key)
	
	// Check local storage first
	if value, exists := dht.storage.data.Load(keyStr); exists {
		sv := value.(*StoredValue)
		if time.Now().Before(sv.Expiration) {
			return sv.Value, nil
		}
		// Expired, remove it
		dht.storage.data.Delete(keyStr)
		dht.storage.keyCount.Add(-1)
		dht.storage.totalSize.Add(-int64(len(sv.Value)))
	}
	
	// Perform lookup
	keyHash := sha256.Sum256(key)
	keyID := NodeID(keyHash)
	
	// Find nodes that might have the value
	nodes := dht.FindNode(ctx, keyID, DHTAlpha)
	
	// Query nodes for the value
	valueChan := make(chan []byte, len(nodes))
	var wg sync.WaitGroup
	
	for _, node := range nodes {
		if node.ID == dht.nodeID {
			continue
		}
		
		wg.Add(1)
		go func(n *DHTNode) {
			defer wg.Done()
			
			msg := &DHTMessage{
				Type:      MessageTypeFindValue,
				MessageID: generateMessageID(),
				Sender:    dht.nodeID,
				Key:       key,
			}
			
			resp, err := dht.rpc.sendMessage(ctx, n, msg)
			if err == nil && resp.Value != nil {
				valueChan <- resp.Value
			}
		}(node)
	}
	
	// Wait for first successful response
	go func() {
		wg.Wait()
		close(valueChan)
	}()
	
	select {
	case value := <-valueChan:
		if value != nil {
			// Cache the value locally
			dht.storeLocal(keyStr, value, dht.nodeID)
			return value, nil
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	
	return nil, fmt.Errorf("key not found")
}

// FindNode finds the k closest nodes to a target ID
func (dht *DistributedHashTable) FindNode(ctx context.Context, target NodeID, k int) []*DHTNode {
	dht.lookupCount.Add(1)
	
	// Get initial nodes from routing table
	closest := dht.routingTable.FindClosest(target, k)
	if len(closest) == 0 {
		return nil
	}
	
	// Iterative lookup
	queried := make(map[NodeID]bool)
	var mu sync.Mutex
	
	for round := 0; round < 3; round++ {
		var wg sync.WaitGroup
		newNodes := make([]*DHTNode, 0)
		
		// Query alpha nodes in parallel
		count := 0
		for _, node := range closest {
			if queried[node.ID] || count >= DHTAlpha {
				break
			}
			
			queried[node.ID] = true
			count++
			
			wg.Add(1)
			go func(n *DHTNode) {
				defer wg.Done()
				
				msg := &DHTMessage{
					Type:      MessageTypeFindNode,
					MessageID: generateMessageID(),
					Sender:    dht.nodeID,
					Target:    target,
				}
				
				resp, err := dht.rpc.sendMessage(ctx, n, msg)
				if err == nil && resp.Nodes != nil {
					mu.Lock()
					newNodes = append(newNodes, resp.Nodes...)
					mu.Unlock()
				}
			}(node)
		}
		
		wg.Wait()
		
		// Add new nodes to closest set
		for _, node := range newNodes {
			closest = insertClosest(closest, node, target, k)
		}
		
		// Check if we've converged
		if len(newNodes) == 0 {
			break
		}
	}
	
	// Return k closest nodes
	if len(closest) > k {
		closest = closest[:k]
	}
	
	return closest
}

// AddNode adds a node to the routing table
func (dht *DistributedHashTable) AddNode(node *DHTNode) {
	dht.routingTable.AddNode(node)
}

// GetStats returns DHT statistics
func (dht *DistributedHashTable) GetStats() map[string]interface{} {
	nodeCount := 0
	for i := 0; i < 256; i++ {
		nodeCount += dht.routingTable.buckets[i].Size()
	}
	
	return map[string]interface{}{
		"node_id":           hex.EncodeToString(dht.nodeID[:]),
		"routing_nodes":     nodeCount,
		"stored_keys":       dht.storage.keyCount.Load(),
		"storage_size":      dht.storage.totalSize.Load(),
		"lookup_count":      dht.lookupCount.Load(),
		"store_count":       dht.storeCount.Load(),
		"retrieve_count":    dht.retrieveCount.Load(),
		"avg_lookup_time":   dht.avgLookupTime.Load(),
		"messages_received": dht.messagesReceived.Load(),
		"messages_sent":     dht.messagesSent.Load(),
		"nodes_discovered":  dht.nodesDiscovered.Load(),
	}
}

// Background routines

func (dht *DistributedHashTable) rpcServer(ctx context.Context) {
	defer dht.wg.Done()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-dht.closeCh:
			return
		default:
			conn, err := dht.rpc.listener.Accept()
			if err != nil {
				continue
			}
			
			go dht.rpc.handleConnection(ctx, conn)
		}
	}
}

func (dht *DistributedHashTable) refreshRoutine(ctx context.Context) {
	defer dht.wg.Done()
	
	ticker := time.NewTicker(DHTRefreshInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-dht.closeCh:
			return
		case <-ticker.C:
			dht.refreshBuckets(ctx)
		}
	}
}

func (dht *DistributedHashTable) expiryRoutine(ctx context.Context) {
	defer dht.wg.Done()
	
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-dht.closeCh:
			return
		case <-ticker.C:
			dht.cleanupExpired()
		case key := <-dht.storage.expiryChan:
			dht.storage.data.Delete(key)
		}
	}
}

func (dht *DistributedHashTable) replicationRoutine(ctx context.Context) {
	defer dht.wg.Done()
	
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-dht.closeCh:
			return
		case <-ticker.C:
			dht.replicateData(ctx)
		}
	}
}

// Helper methods

func (dht *DistributedHashTable) registerHandlers() {
	dht.rpc.handlers[MessageTypePing] = dht.handlePing
	dht.rpc.handlers[MessageTypeStore] = dht.handleStore
	dht.rpc.handlers[MessageTypeFindNode] = dht.handleFindNode
	dht.rpc.handlers[MessageTypeFindValue] = dht.handleFindValue
}

func (dht *DistributedHashTable) handlePing(ctx context.Context, msg *DHTMessage) (*DHTMessage, error) {
	return &DHTMessage{
		Type:      MessageTypePing,
		MessageID: msg.MessageID,
		Sender:    dht.nodeID,
	}, nil
}

func (dht *DistributedHashTable) handleStore(ctx context.Context, msg *DHTMessage) (*DHTMessage, error) {
	keyStr := hex.EncodeToString(msg.Key)
	dht.storeLocal(keyStr, msg.Value, msg.Sender)
	
	return &DHTMessage{
		Type:      MessageTypeStore,
		MessageID: msg.MessageID,
		Sender:    dht.nodeID,
	}, nil
}

func (dht *DistributedHashTable) handleFindNode(ctx context.Context, msg *DHTMessage) (*DHTMessage, error) {
	nodes := dht.routingTable.FindClosest(msg.Target, DHTBucketSize)
	
	return &DHTMessage{
		Type:      MessageTypeFindNode,
		MessageID: msg.MessageID,
		Sender:    dht.nodeID,
		Nodes:     nodes,
	}, nil
}

func (dht *DistributedHashTable) handleFindValue(ctx context.Context, msg *DHTMessage) (*DHTMessage, error) {
	keyStr := hex.EncodeToString(msg.Key)
	
	// Check if we have the value
	if value, exists := dht.storage.data.Load(keyStr); exists {
		sv := value.(*StoredValue)
		if time.Now().Before(sv.Expiration) {
			return &DHTMessage{
				Type:      MessageTypeFindValue,
				MessageID: msg.MessageID,
				Sender:    dht.nodeID,
				Value:     sv.Value,
			}, nil
		}
	}
	
	// Otherwise return closest nodes
	keyHash := sha256.Sum256(msg.Key)
	keyID := NodeID(keyHash)
	nodes := dht.routingTable.FindClosest(keyID, DHTBucketSize)
	
	return &DHTMessage{
		Type:      MessageTypeFindValue,
		MessageID: msg.MessageID,
		Sender:    dht.nodeID,
		Nodes:     nodes,
	}, nil
}

func (dht *DistributedHashTable) storeLocal(key string, value []byte, publisher NodeID) {
	sv := &StoredValue{
		Key:        key,
		Value:      value,
		Publisher:  publisher,
		Timestamp:  time.Now(),
		Expiration: time.Now().Add(DHTKeyExpiration),
		Replicated: false,
	}
	
	// Check storage limits
	if dht.storage.keyCount.Load() >= DHTMaxStoreKeys {
		// Evict oldest entry
		dht.evictOldest()
	}
	
	// Store value
	if old, exists := dht.storage.data.LoadOrStore(key, sv); !exists {
		dht.storage.keyCount.Add(1)
		dht.storage.totalSize.Add(int64(len(value)))
	} else {
		// Update existing value
		oldSv := old.(*StoredValue)
		dht.storage.totalSize.Add(int64(len(value) - len(oldSv.Value)))
		dht.storage.data.Store(key, sv)
	}
}

func (dht *DistributedHashTable) refreshBuckets(ctx context.Context) {
	// Refresh buckets that haven't been accessed recently
	for i := range dht.routingTable.buckets {
		bucket := dht.routingTable.buckets[i]
		if time.Since(bucket.lastRefresh) > DHTRefreshInterval {
			// Generate random ID in this bucket's range
			randomID := generateRandomIDInBucket(i)
			dht.FindNode(ctx, randomID, DHTAlpha)
			bucket.lastRefresh = time.Now()
		}
	}
}

func (dht *DistributedHashTable) cleanupExpired() {
	now := time.Now()
	var expiredKeys []string
	
	dht.storage.data.Range(func(key, value interface{}) bool {
		sv := value.(*StoredValue)
		if now.After(sv.Expiration) {
			expiredKeys = append(expiredKeys, key.(string))
		}
		return true
	})
	
	for _, key := range expiredKeys {
		if value, loaded := dht.storage.data.LoadAndDelete(key); loaded {
			sv := value.(*StoredValue)
			dht.storage.keyCount.Add(-1)
			dht.storage.totalSize.Add(-int64(len(sv.Value)))
		}
	}
}

func (dht *DistributedHashTable) replicateData(ctx context.Context) {
	// Replicate data we're responsible for
	dht.storage.data.Range(func(key, value interface{}) bool {
		sv := value.(*StoredValue)
		if !sv.Replicated && sv.Publisher == dht.nodeID {
			keyBytes, _ := hex.DecodeString(key.(string))
			go dht.Store(ctx, keyBytes, sv.Value)
			sv.Replicated = true
		}
		return true
	})
}

func (dht *DistributedHashTable) evictOldest() {
	var oldestKey string
	var oldestTime time.Time
	
	dht.storage.data.Range(func(key, value interface{}) bool {
		sv := value.(*StoredValue)
		if oldestKey == "" || sv.Timestamp.Before(oldestTime) {
			oldestKey = key.(string)
			oldestTime = sv.Timestamp
		}
		return true
	})
	
	if oldestKey != "" {
		if value, loaded := dht.storage.data.LoadAndDelete(oldestKey); loaded {
			sv := value.(*StoredValue)
			dht.storage.keyCount.Add(-1)
			dht.storage.totalSize.Add(-int64(len(sv.Value)))
		}
	}
}

// RoutingTable implementation

func NewRoutingTable(nodeID NodeID) *RoutingTable {
	rt := &RoutingTable{
		nodeID: nodeID,
	}
	
	for i := range rt.buckets {
		rt.buckets[i] = &KBucket{
			nodes:        make([]*DHTNode, 0, DHTBucketSize),
			replacements: make([]*DHTNode, 0, DHTBucketSize),
			lastRefresh:  time.Now(),
		}
	}
	
	return rt
}

func (rt *RoutingTable) AddNode(node *DHTNode) {
	if node.ID == rt.nodeID {
		return // Don't add self
	}
	
	bucketIndex := rt.getBucketIndex(node.ID)
	bucket := rt.buckets[bucketIndex]
	
	bucket.mu.Lock()
	defer bucket.mu.Unlock()
	
	// Check if node already exists
	for i, n := range bucket.nodes {
		if n.ID == node.ID {
			// Update existing node
			bucket.nodes[i] = node
			return
		}
	}
	
	// Add new node
	if len(bucket.nodes) < DHTBucketSize {
		bucket.nodes = append(bucket.nodes, node)
		node.LastSeen = time.Now()
	} else {
		// Bucket full, add to replacements
		bucket.replacements = append(bucket.replacements, node)
		if len(bucket.replacements) > DHTBucketSize {
			bucket.replacements = bucket.replacements[1:]
		}
	}
}

func (rt *RoutingTable) FindClosest(target NodeID, k int) []*DHTNode {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	
	var allNodes []*DHTNode
	
	// Collect all nodes
	for _, bucket := range rt.buckets {
		bucket.mu.RLock()
		allNodes = append(allNodes, bucket.nodes...)
		bucket.mu.RUnlock()
	}
	
	// Sort by distance to target
	sort.Slice(allNodes, func(i, j int) bool {
		distI := target.Distance(allNodes[i].ID)
		distJ := target.Distance(allNodes[j].ID)
		return distI.Cmp(distJ) < 0
	})
	
	// Return k closest
	if len(allNodes) > k {
		allNodes = allNodes[:k]
	}
	
	return allNodes
}

func (rt *RoutingTable) getBucketIndex(nodeID NodeID) int {
	commonPrefix := rt.nodeID.CommonPrefixLen(nodeID)
	if commonPrefix == 256 {
		return 255
	}
	return commonPrefix
}

func (bucket *KBucket) Size() int {
	bucket.mu.RLock()
	defer bucket.mu.RUnlock()
	return len(bucket.nodes)
}

// RPC implementation

func (rpc *DHTRPC) sendMessage(ctx context.Context, node *DHTNode, msg *DHTMessage) (*DHTMessage, error) {
	// Connect to node
	addr := fmt.Sprintf("%s:%d", node.IP, node.Port)
	conn, err := net.DialTimeout("tcp", addr, DHTTimeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	
	// Set deadline
	conn.SetDeadline(time.Now().Add(DHTTimeout))
	
	// Encode and send message
	data := rpc.encodeMessage(msg)
	if _, err := conn.Write(data); err != nil {
		return nil, err
	}
	
	// Read response
	buf := rpc.memPool.Get(DHTMaxMessageSize)
	defer rpc.memPool.Put(buf)
	
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	
	// Decode response
	resp, err := rpc.decodeMessage(buf[:n])
	if err != nil {
		return nil, err
	}
	
	return resp, nil
}

func (rpc *DHTRPC) handleConnection(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	
	// Read message
	buf := rpc.memPool.Get(DHTMaxMessageSize)
	defer rpc.memPool.Put(buf)
	
	conn.SetReadDeadline(time.Now().Add(DHTTimeout))
	n, err := conn.Read(buf)
	if err != nil {
		return
	}
	
	// Decode message
	msg, err := rpc.decodeMessage(buf[:n])
	if err != nil {
		return
	}
	
	// Handle message
	handler, exists := rpc.handlers[msg.Type]
	if !exists {
		return
	}
	
	resp, err := handler(ctx, msg)
	if err != nil {
		return
	}
	
	// Send response
	data := rpc.encodeMessage(resp)
	conn.SetWriteDeadline(time.Now().Add(DHTTimeout))
	conn.Write(data)
}

func (rpc *DHTRPC) encodeMessage(msg *DHTMessage) []byte {
	// Simple encoding (would use protobuf in production)
	buf := new(bytes.Buffer)
	
	// Message type
	buf.WriteByte(byte(msg.Type))
	
	// Message ID
	binary.Write(buf, binary.BigEndian, msg.MessageID)
	
	// Sender ID
	buf.Write(msg.Sender[:])
	
	// Additional fields based on type
	switch msg.Type {
	case MessageTypeFindNode:
		buf.Write(msg.Target[:])
	case MessageTypeStore, MessageTypeFindValue:
		binary.Write(buf, binary.BigEndian, uint32(len(msg.Key)))
		buf.Write(msg.Key)
		if msg.Value != nil {
			binary.Write(buf, binary.BigEndian, uint32(len(msg.Value)))
			buf.Write(msg.Value)
		} else {
			binary.Write(buf, binary.BigEndian, uint32(0))
		}
	}
	
	// Nodes list
	if msg.Nodes != nil {
		binary.Write(buf, binary.BigEndian, uint16(len(msg.Nodes)))
		for _, node := range msg.Nodes {
			buf.Write(node.ID[:])
			buf.Write(node.IP.To16())
			binary.Write(buf, binary.BigEndian, node.Port)
		}
	} else {
		binary.Write(buf, binary.BigEndian, uint16(0))
	}
	
	return buf.Bytes()
}

func (rpc *DHTRPC) decodeMessage(data []byte) (*DHTMessage, error) {
	if len(data) < 41 { // Minimum message size
		return nil, fmt.Errorf("message too short")
	}
	
	buf := bytes.NewReader(data)
	msg := &DHTMessage{}
	
	// Message type
	msgType, _ := buf.ReadByte()
	msg.Type = MessageType(msgType)
	
	// Message ID
	binary.Read(buf, binary.BigEndian, &msg.MessageID)
	
	// Sender ID
	buf.Read(msg.Sender[:])
	
	// Additional fields based on type
	switch msg.Type {
	case MessageTypeFindNode:
		buf.Read(msg.Target[:])
		
	case MessageTypeStore, MessageTypeFindValue:
		var keyLen uint32
		binary.Read(buf, binary.BigEndian, &keyLen)
		if keyLen > 0 {
			msg.Key = make([]byte, keyLen)
			buf.Read(msg.Key)
		}
		
		var valueLen uint32
		binary.Read(buf, binary.BigEndian, &valueLen)
		if valueLen > 0 {
			msg.Value = make([]byte, valueLen)
			buf.Read(msg.Value)
		}
	}
	
	// Nodes list
	var nodeCount uint16
	binary.Read(buf, binary.BigEndian, &nodeCount)
	if nodeCount > 0 {
		msg.Nodes = make([]*DHTNode, nodeCount)
		for i := uint16(0); i < nodeCount; i++ {
			node := &DHTNode{}
			buf.Read(node.ID[:])
			
			ipBytes := make([]byte, 16)
			buf.Read(ipBytes)
			node.IP = net.IP(ipBytes)
			
			binary.Read(buf, binary.BigEndian, &node.Port)
			msg.Nodes[i] = node
		}
	}
	
	return msg, nil
}

// Utility functions

func generateMessageID() uint64 {
	return uint64(time.Now().UnixNano())
}

func generateRandomIDInBucket(bucketIndex int) NodeID {
	var id NodeID
	
	// Generate random bytes
	rand.Read(id[:])
	
	// Set appropriate prefix for bucket
	if bucketIndex < 255 {
		// Clear bits after bucket index
		bytesIndex := bucketIndex / 8
		bitIndex := bucketIndex % 8
		
		// Set the bit at bucket index
		id[bytesIndex] |= (1 << (7 - bitIndex))
		
		// Clear all bits before bucket index
		for i := 0; i < bytesIndex; i++ {
			id[i] = 0
		}
		if bitIndex > 0 {
			mask := byte(0xFF << (8 - bitIndex))
			id[bytesIndex] &= ^mask
		}
	}
	
	return id
}

func insertClosest(nodes []*DHTNode, newNode *DHTNode, target NodeID, k int) []*DHTNode {
	// Check if node already exists
	for i, n := range nodes {
		if n.ID == newNode.ID {
			nodes[i] = newNode // Update existing
			return nodes
		}
	}
	
	// Insert in sorted order
	nodes = append(nodes, newNode)
	sort.Slice(nodes, func(i, j int) bool {
		distI := target.Distance(nodes[i].ID)
		distJ := target.Distance(nodes[j].ID)
		return distI.Cmp(distJ) < 0
	})
	
	// Keep only k closest
	if len(nodes) > k {
		nodes = nodes[:k]
	}
	
	return nodes
}

// GenerateNodeID generates a random node ID
func GenerateNodeID() NodeID {
	var id NodeID
	rand.Read(id[:])
	return id
}

// UDPTransport implements DHTTransport using UDP
type UDPTransport struct {
	logger *zap.Logger
	conn   *net.UDPConn
}

func (t *UDPTransport) Listen(addr string) error {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return err
	}
	
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return err
	}
	
	t.conn = conn
	return nil
}

func (t *UDPTransport) SendMessage(addr string, msg interface{}) error {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return err
	}
	
	// Serialize message
	data, err := msgpack.Marshal(msg)
	if err != nil {
		return err
	}
	
	_, err = t.conn.WriteToUDP(data, udpAddr)
	return err
}

func (t *UDPTransport) Close() error {
	if t.conn != nil {
		return t.conn.Close()
	}
	return nil
}