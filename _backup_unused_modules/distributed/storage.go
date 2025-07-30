package distributed

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/gob"
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DistributedStorage implements a distributed hash table with replication
type DistributedStorage struct {
	nodeID          NodeID
	localStore      *LocalStore
	routingTable    *RoutingTable
	replicationFactor int
	
	// Network communication
	transport       Transport
	
	// Pending operations
	pendingOps      map[string]*PendingOperation
	pendingMu       sync.RWMutex
	
	// Statistics
	stats           StorageStats
	
	logger          *zap.Logger
	shutdownChan    chan struct{}
	wg              sync.WaitGroup
}

// NodeID represents a node identifier in the DHT
type NodeID [32]byte

// LocalStore manages local storage
type LocalStore struct {
	data        map[string]*StoredValue
	mu          sync.RWMutex
	maxSize     int64
	currentSize int64
}

// StoredValue represents a stored value with metadata
type StoredValue struct {
	Key         string
	Value       []byte
	Timestamp   time.Time
	TTL         time.Duration
	Replicas    []NodeID
	Version     uint64
	Checksum    [32]byte
}

// RoutingTable manages DHT routing
type RoutingTable struct {
	buckets     [256]*KBucket
	selfID      NodeID
	mu          sync.RWMutex
}

// KBucket represents a k-bucket in Kademlia
type KBucket struct {
	contacts    []*Contact
	maxSize     int
	lastUpdated time.Time
	mu          sync.RWMutex
}

// Contact represents a network contact
type Contact struct {
	ID          NodeID
	Address     string
	LastSeen    time.Time
	FailCount   int
}

// Transport interface for network communication
type Transport interface {
	SendMessage(target NodeID, msg Message) error
	ReceiveMessages() <-chan ReceivedMessage
	Close() error
}

// Message types
type Message struct {
	Type        MessageType
	SenderID    NodeID
	RequestID   string
	Payload     interface{}
}

// MessageType represents the type of message
type MessageType uint8

const (
	MessageTypePing MessageType = iota
	MessageTypeStore
	MessageTypeFindNode
	MessageTypeFindValue
	MessageTypeReplicate
	MessageTypeDelete
	MessageTypeAck
)

// ReceivedMessage represents a received message
type ReceivedMessage struct {
	Message Message
	From    string
}

// PendingOperation represents an in-flight operation
type PendingOperation struct {
	Type        OperationType
	Key         string
	Value       []byte
	ResponseChan chan OperationResult
	Timeout     time.Time
	Retries     int
}

// OperationType represents the type of operation
type OperationType uint8

const (
	OperationTypeStore OperationType = iota
	OperationTypeRetrieve
	OperationTypeDelete
	OperationTypeReplicate
)

// OperationResult represents the result of an operation
type OperationResult struct {
	Success bool
	Value   []byte
	Error   error
	Nodes   []NodeID
}

// StorageStats contains storage statistics
type StorageStats struct {
	TotalKeys        atomic.Uint64
	TotalSize        atomic.Uint64
	StoreOperations  atomic.Uint64
	RetrieveOperations atomic.Uint64
	ReplicationCount atomic.Uint64
	NetworkMessages  atomic.Uint64
}

// Config contains storage configuration
type Config struct {
	NodeID            NodeID
	BindAddress       string
	MaxStorageSize    int64
	ReplicationFactor int
	BucketSize        int
	Alpha             int // Parallelism factor
	RequestTimeout    time.Duration
}

// NewDistributedStorage creates a new distributed storage instance
func NewDistributedStorage(config Config, transport Transport, logger *zap.Logger) *DistributedStorage {
	ds := &DistributedStorage{
		nodeID:            config.NodeID,
		replicationFactor: config.ReplicationFactor,
		transport:         transport,
		pendingOps:        make(map[string]*PendingOperation),
		logger:            logger,
		shutdownChan:      make(chan struct{}),
	}
	
	// Initialize local store
	ds.localStore = &LocalStore{
		data:    make(map[string]*StoredValue),
		maxSize: config.MaxStorageSize,
	}
	
	// Initialize routing table
	ds.routingTable = &RoutingTable{
		selfID: config.NodeID,
	}
	
	// Initialize k-buckets
	for i := 0; i < 256; i++ {
		ds.routingTable.buckets[i] = &KBucket{
			maxSize: config.BucketSize,
		}
	}
	
	return ds
}

// Start starts the distributed storage service
func (ds *DistributedStorage) Start() error {
	ds.logger.Info("Starting distributed storage", 
		zap.String("node_id", fmt.Sprintf("%x", ds.nodeID[:8])))
	
	// Start message handler
	ds.wg.Add(1)
	go ds.handleMessages()
	
	// Start maintenance routines
	ds.wg.Add(1)
	go ds.maintenanceLoop()
	
	// Start replication monitor
	ds.wg.Add(1)
	go ds.replicationMonitor()
	
	return nil
}

// Stop stops the distributed storage service
func (ds *DistributedStorage) Stop() error {
	ds.logger.Info("Stopping distributed storage")
	
	close(ds.shutdownChan)
	ds.wg.Wait()
	
	return ds.transport.Close()
}

// Store stores a key-value pair in the distributed storage
func (ds *DistributedStorage) Store(key string, value []byte, ttl time.Duration) error {
	// Calculate key hash
	keyHash := sha256.Sum256([]byte(key))
	keyID := NodeID(keyHash)
	
	// Find closest nodes
	closestNodes := ds.routingTable.FindClosestNodes(keyID, ds.replicationFactor)
	
	// Create stored value
	storedValue := &StoredValue{
		Key:       key,
		Value:     value,
		Timestamp: time.Now(),
		TTL:       ttl,
		Version:   1,
		Checksum:  sha256.Sum256(value),
	}
	
	// Store locally if we're one of the closest nodes
	if ds.shouldStoreLocally(keyID, closestNodes) {
		if err := ds.localStore.Store(key, storedValue); err != nil {
			return err
		}
	}
	
	// Replicate to other nodes
	replicationChan := make(chan OperationResult, len(closestNodes))
	for _, node := range closestNodes {
		if node.ID == ds.nodeID {
			continue
		}
		
		go ds.replicateToNode(node, key, storedValue, replicationChan)
	}
	
	// Wait for replication confirmations
	successCount := 0
	requiredReplicas := (ds.replicationFactor + 1) / 2 // Majority
	
	for i := 0; i < len(closestNodes)-1; i++ {
		select {
		case result := <-replicationChan:
			if result.Success {
				successCount++
				if successCount >= requiredReplicas {
					return nil
				}
			}
		case <-time.After(5 * time.Second):
			// Timeout
		}
	}
	
	if successCount < requiredReplicas {
		return errors.New("insufficient replicas created")
	}
	
	return nil
}

// Retrieve retrieves a value from the distributed storage
func (ds *DistributedStorage) Retrieve(key string) ([]byte, error) {
	// Check local store first
	if value, err := ds.localStore.Get(key); err == nil {
		return value.Value, nil
	}
	
	// Calculate key hash
	keyHash := sha256.Sum256([]byte(key))
	keyID := NodeID(keyHash)
	
	// Find nodes that might have the value
	closestNodes := ds.routingTable.FindClosestNodes(keyID, ds.replicationFactor*2)
	
	// Query nodes in parallel
	valueChan := make(chan *StoredValue, len(closestNodes))
	for _, node := range closestNodes {
		if node.ID == ds.nodeID {
			continue
		}
		
		go ds.queryNode(node, key, valueChan)
	}
	
	// Collect responses
	var bestValue *StoredValue
	responseCount := 0
	
	for i := 0; i < len(closestNodes)-1; i++ {
		select {
		case value := <-valueChan:
			responseCount++
			if value != nil {
				if bestValue == nil || value.Version > bestValue.Version {
					bestValue = value
				}
			}
			
			// Return early if we have enough responses
			if responseCount >= ds.replicationFactor {
				if bestValue != nil {
					return bestValue.Value, nil
				}
			}
			
		case <-time.After(2 * time.Second):
			// Continue with partial results
		}
	}
	
	if bestValue != nil {
		return bestValue.Value, nil
	}
	
	return nil, errors.New("key not found")
}

// Delete deletes a key from the distributed storage
func (ds *DistributedStorage) Delete(key string) error {
	// Calculate key hash
	keyHash := sha256.Sum256([]byte(key))
	keyID := NodeID(keyHash)
	
	// Find nodes that might have the value
	closestNodes := ds.routingTable.FindClosestNodes(keyID, ds.replicationFactor*2)
	
	// Delete from local store
	ds.localStore.Delete(key)
	
	// Send delete messages to other nodes
	for _, node := range closestNodes {
		if node.ID == ds.nodeID {
			continue
		}
		
		msg := Message{
			Type:      MessageTypeDelete,
			SenderID:  ds.nodeID,
			RequestID: generateRequestID(),
			Payload:   key,
		}
		
		ds.transport.SendMessage(node.ID, msg)
	}
	
	return nil
}

// handleMessages handles incoming messages
func (ds *DistributedStorage) handleMessages() {
	defer ds.wg.Done()
	
	msgChan := ds.transport.ReceiveMessages()
	
	for {
		select {
		case <-ds.shutdownChan:
			return
			
		case msg := <-msgChan:
			ds.stats.NetworkMessages.Add(1)
			
			switch msg.Message.Type {
			case MessageTypePing:
				ds.handlePing(msg)
			case MessageTypeStore:
				ds.handleStore(msg)
			case MessageTypeFindNode:
				ds.handleFindNode(msg)
			case MessageTypeFindValue:
				ds.handleFindValue(msg)
			case MessageTypeReplicate:
				ds.handleReplicate(msg)
			case MessageTypeDelete:
				ds.handleDelete(msg)
			}
		}
	}
}

// LocalStore methods

func (ls *LocalStore) Store(key string, value *StoredValue) error {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	
	// Check size limits
	newSize := ls.currentSize + int64(len(value.Value))
	if oldValue, exists := ls.data[key]; exists {
		newSize -= int64(len(oldValue.Value))
	}
	
	if newSize > ls.maxSize {
		return errors.New("storage limit exceeded")
	}
	
	ls.data[key] = value
	ls.currentSize = newSize
	
	return nil
}

func (ls *LocalStore) Get(key string) (*StoredValue, error) {
	ls.mu.RLock()
	defer ls.mu.RUnlock()
	
	value, exists := ls.data[key]
	if !exists {
		return nil, errors.New("key not found")
	}
	
	// Check TTL
	if value.TTL > 0 && time.Since(value.Timestamp) > value.TTL {
		return nil, errors.New("key expired")
	}
	
	return value, nil
}

func (ls *LocalStore) Delete(key string) {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	
	if value, exists := ls.data[key]; exists {
		ls.currentSize -= int64(len(value.Value))
		delete(ls.data, key)
	}
}

// RoutingTable methods

func (rt *RoutingTable) FindClosestNodes(target NodeID, count int) []*Contact {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	
	// Collect all contacts
	var allContacts []*Contact
	for _, bucket := range rt.buckets {
		bucket.mu.RLock()
		allContacts = append(allContacts, bucket.contacts...)
		bucket.mu.RUnlock()
	}
	
	// Sort by distance to target
	sort.Slice(allContacts, func(i, j int) bool {
		return compareDistance(allContacts[i].ID, allContacts[j].ID, target) < 0
	})
	
	// Return closest nodes
	if len(allContacts) < count {
		return allContacts
	}
	return allContacts[:count]
}

func (rt *RoutingTable) AddContact(contact *Contact) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	
	// Find appropriate bucket
	bucketIdx := rt.getBucketIndex(contact.ID)
	bucket := rt.buckets[bucketIdx]
	
	bucket.mu.Lock()
	defer bucket.mu.Unlock()
	
	// Check if contact already exists
	for i, c := range bucket.contacts {
		if c.ID == contact.ID {
			// Update existing contact
			bucket.contacts[i] = contact
			bucket.lastUpdated = time.Now()
			return
		}
	}
	
	// Add new contact if bucket not full
	if len(bucket.contacts) < bucket.maxSize {
		bucket.contacts = append(bucket.contacts, contact)
		bucket.lastUpdated = time.Now()
	}
}

func (rt *RoutingTable) getBucketIndex(nodeID NodeID) int {
	// XOR distance between self and node
	distance := xorDistance(rt.selfID, nodeID)
	
	// Find first set bit (most significant)
	for i := 0; i < 256; i++ {
		byteIdx := i / 8
		bitIdx := uint(7 - (i % 8))
		
		if distance[byteIdx]&(1<<bitIdx) != 0 {
			return i
		}
	}
	
	return 255
}

// Helper functions

func xorDistance(a, b NodeID) NodeID {
	var result NodeID
	for i := 0; i < 32; i++ {
		result[i] = a[i] ^ b[i]
	}
	return result
}

func compareDistance(a, b, target NodeID) int {
	distA := xorDistance(a, target)
	distB := xorDistance(b, target)
	
	for i := 0; i < 32; i++ {
		if distA[i] < distB[i] {
			return -1
		}
		if distA[i] > distB[i] {
			return 1
		}
	}
	
	return 0
}

func generateRequestID() string {
	b := make([]byte, 16)
	binary.BigEndian.PutUint64(b, uint64(time.Now().UnixNano()))
	binary.BigEndian.PutUint64(b[8:], uint64(rand.Int63()))
	return fmt.Sprintf("%x", b)
}

func (ds *DistributedStorage) shouldStoreLocally(keyID NodeID, closestNodes []*Contact) bool {
	for _, node := range closestNodes {
		if node.ID == ds.nodeID {
			return true
		}
	}
	return false
}

// maintenanceLoop performs periodic maintenance tasks
func (ds *DistributedStorage) maintenanceLoop() {
	defer ds.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ds.shutdownChan:
			return
			
		case <-ticker.C:
			// Clean expired entries
			ds.cleanExpiredEntries()
			
			// Refresh buckets
			ds.refreshBuckets()
			
			// Check replication health
			ds.checkReplicationHealth()
		}
	}
}

func (ds *DistributedStorage) cleanExpiredEntries() {
	ds.localStore.mu.Lock()
	defer ds.localStore.mu.Unlock()
	
	var keysToDelete []string
	
	for key, value := range ds.localStore.data {
		if value.TTL > 0 && time.Since(value.Timestamp) > value.TTL {
			keysToDelete = append(keysToDelete, key)
		}
	}
	
	for _, key := range keysToDelete {
		delete(ds.localStore.data, key)
		ds.stats.TotalKeys.Add(^uint64(0)) // Decrement
	}
}

func (ds *DistributedStorage) refreshBuckets() {
	// Implement bucket refresh logic
	// This would involve sending FIND_NODE messages to keep routing table fresh
}

func (ds *DistributedStorage) checkReplicationHealth() {
	// Check if stored values have sufficient replicas
	// Re-replicate if necessary
}

// replicationMonitor monitors and maintains replication levels
func (ds *DistributedStorage) replicationMonitor() {
	defer ds.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-ds.shutdownChan:
			return
			
		case <-ticker.C:
			ds.ensureReplication()
		}
	}
}

func (ds *DistributedStorage) ensureReplication() {
	ds.localStore.mu.RLock()
	keys := make([]string, 0, len(ds.localStore.data))
	for k := range ds.localStore.data {
		keys = append(keys, k)
	}
	ds.localStore.mu.RUnlock()
	
	for _, key := range keys {
		value, err := ds.localStore.Get(key)
		if err != nil {
			continue
		}
		
		// Check current replica count
		keyHash := sha256.Sum256([]byte(key))
		keyID := NodeID(keyHash)
		
		closestNodes := ds.routingTable.FindClosestNodes(keyID, ds.replicationFactor)
		activeReplicas := 0
		
		for _, node := range closestNodes {
			// Ping node to check if active
			if ds.pingNode(node) {
				activeReplicas++
			}
		}
		
		// Re-replicate if needed
		if activeReplicas < ds.replicationFactor {
			ds.logger.Info("Re-replicating value",
				zap.String("key", key),
				zap.Int("current_replicas", activeReplicas),
				zap.Int("target_replicas", ds.replicationFactor))
			
			ds.Store(key, value.Value, value.TTL)
		}
	}
}

func (ds *DistributedStorage) pingNode(contact *Contact) bool {
	msg := Message{
		Type:      MessageTypePing,
		SenderID:  ds.nodeID,
		RequestID: generateRequestID(),
	}
	
	err := ds.transport.SendMessage(contact.ID, msg)
	return err == nil
}

// Message handlers

func (ds *DistributedStorage) handlePing(msg ReceivedMessage) {
	// Update routing table
	contact := &Contact{
		ID:       msg.Message.SenderID,
		Address:  msg.From,
		LastSeen: time.Now(),
	}
	ds.routingTable.AddContact(contact)
	
	// Send pong
	response := Message{
		Type:      MessageTypeAck,
		SenderID:  ds.nodeID,
		RequestID: msg.Message.RequestID,
	}
	
	ds.transport.SendMessage(msg.Message.SenderID, response)
}

func (ds *DistributedStorage) handleStore(msg ReceivedMessage) {
	storeReq, ok := msg.Message.Payload.(*StoreRequest)
	if !ok {
		return
	}
	
	// Store the value
	err := ds.localStore.Store(storeReq.Key, storeReq.Value)
	
	// Send response
	response := Message{
		Type:      MessageTypeAck,
		SenderID:  ds.nodeID,
		RequestID: msg.Message.RequestID,
		Payload:   err == nil,
	}
	
	ds.transport.SendMessage(msg.Message.SenderID, response)
}

func (ds *DistributedStorage) handleFindNode(msg ReceivedMessage) {
	targetID, ok := msg.Message.Payload.(NodeID)
	if !ok {
		return
	}
	
	// Find closest nodes to target
	closestNodes := ds.routingTable.FindClosestNodes(targetID, 20)
	
	// Send response
	response := Message{
		Type:      MessageTypeAck,
		SenderID:  ds.nodeID,
		RequestID: msg.Message.RequestID,
		Payload:   closestNodes,
	}
	
	ds.transport.SendMessage(msg.Message.SenderID, response)
}

func (ds *DistributedStorage) handleFindValue(msg ReceivedMessage) {
	key, ok := msg.Message.Payload.(string)
	if !ok {
		return
	}
	
	// Check if we have the value
	value, err := ds.localStore.Get(key)
	
	var response Message
	if err == nil {
		response = Message{
			Type:      MessageTypeAck,
			SenderID:  ds.nodeID,
			RequestID: msg.Message.RequestID,
			Payload:   value,
		}
	} else {
		// Return closest nodes
		keyHash := sha256.Sum256([]byte(key))
		keyID := NodeID(keyHash)
		closestNodes := ds.routingTable.FindClosestNodes(keyID, 20)
		
		response = Message{
			Type:      MessageTypeAck,
			SenderID:  ds.nodeID,
			RequestID: msg.Message.RequestID,
			Payload:   closestNodes,
		}
	}
	
	ds.transport.SendMessage(msg.Message.SenderID, response)
}

func (ds *DistributedStorage) handleReplicate(msg ReceivedMessage) {
	replicateReq, ok := msg.Message.Payload.(*ReplicateRequest)
	if !ok {
		return
	}
	
	// Store the replicated value
	err := ds.localStore.Store(replicateReq.Key, replicateReq.Value)
	
	// Update statistics
	if err == nil {
		ds.stats.ReplicationCount.Add(1)
	}
	
	// Send response
	response := Message{
		Type:      MessageTypeAck,
		SenderID:  ds.nodeID,
		RequestID: msg.Message.RequestID,
		Payload:   err == nil,
	}
	
	ds.transport.SendMessage(msg.Message.SenderID, response)
}

func (ds *DistributedStorage) handleDelete(msg ReceivedMessage) {
	key, ok := msg.Message.Payload.(string)
	if !ok {
		return
	}
	
	ds.localStore.Delete(key)
	
	// Send acknowledgment
	response := Message{
		Type:      MessageTypeAck,
		SenderID:  ds.nodeID,
		RequestID: msg.Message.RequestID,
	}
	
	ds.transport.SendMessage(msg.Message.SenderID, response)
}

// Request types

type StoreRequest struct {
	Key   string
	Value *StoredValue
}

type FindValueRequest struct {
	Key string
}

type ReplicateRequest struct {
	Key   string
	Value *StoredValue
}

// replicateToNode replicates a value to a specific node
func (ds *DistributedStorage) replicateToNode(node *Contact, key string, value *StoredValue, resultChan chan OperationResult) {
	msg := Message{
		Type:      MessageTypeReplicate,
		SenderID:  ds.nodeID,
		RequestID: generateRequestID(),
		Payload: &ReplicateRequest{
			Key:   key,
			Value: value,
		},
	}
	
	err := ds.transport.SendMessage(node.ID, msg)
	
	result := OperationResult{
		Success: err == nil,
		Error:   err,
	}
	
	select {
	case resultChan <- result:
	default:
	}
}

// queryNode queries a node for a value
func (ds *DistributedStorage) queryNode(node *Contact, key string, valueChan chan *StoredValue) {
	msg := Message{
		Type:      MessageTypeFindValue,
		SenderID:  ds.nodeID,
		RequestID: generateRequestID(),
		Payload:   key,
	}
	
	err := ds.transport.SendMessage(node.ID, msg)
	if err != nil {
		select {
		case valueChan <- nil:
		default:
		}
		return
	}
	
	// In a real implementation, we would wait for the response
	// For now, return nil
	select {
	case valueChan <- nil:
	default:
	}
}