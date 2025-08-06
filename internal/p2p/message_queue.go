package p2p

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// MessageQueue provides high-performance message queuing for P2P network
// Following Rob Pike's CSP principles with channels
type MessageQueue struct {
	logger *zap.Logger
	
	// Priority queues
	urgent    chan *QueuedMessage
	high      chan *QueuedMessage
	normal    chan *QueuedMessage
	low       chan *QueuedMessage
	
	// Persistence layer
	persister *MessagePersister
	
	// Flow control
	flowController *FlowController
	
	// Message deduplication
	deduplicator *MessageDeduplicator
	
	// Compression
	compressor *MessageCompressor
	
	// Stats
	stats struct {
		enqueued      atomic.Uint64
		dequeued      atomic.Uint64
		dropped       atomic.Uint64
		compressed    atomic.Uint64
		deduplicated  atomic.Uint64
		persisted     atomic.Uint64
	}
	
	// Configuration
	config *QueueConfig
	
	// Lifecycle
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// QueueConfig contains queue configuration
type QueueConfig struct {
	UrgentSize    int
	HighSize      int
	NormalSize    int
	LowSize       int
	
	EnablePersistence    bool
	EnableCompression    bool
	EnableDeduplication  bool
	
	CompressionThreshold int    // bytes
	DeduplicationWindow  time.Duration
	PersistencePath      string
	
	MaxMessageSize       int
	MessageTTL           time.Duration
}

// QueuedMessage wraps a message with metadata
type QueuedMessage struct {
	Message   *Message
	Priority  MessagePriority
	Timestamp int64
	Retries   int
	TTL       time.Duration
	
	// Routing
	NextHop   string
	FinalDest string
	
	// Reliability
	RequiresAck bool
	AckTimeout  time.Duration
	
	// Internal
	id        uint64
	compressed bool
}

// MessagePriority defines message priority levels
type MessagePriority int

const (
	PriorityLow MessagePriority = iota
	PriorityNormal
	PriorityHigh
	PriorityUrgent
)

// MessagePersister handles message persistence
type MessagePersister struct {
	logger   *zap.Logger
	dbPath   string
	
	// Write-ahead log
	wal      *WriteAheadLog
	
	// Batch writer
	batch    []*QueuedMessage
	batchMu  sync.Mutex
	batchSize int
}

// FlowController manages message flow
type FlowController struct {
	logger *zap.Logger
	
	// Rate limiting per peer
	peerRates sync.Map // map[string]*RateController
	
	// Congestion control
	congestionWindow atomic.Int32
	slowStartThresh  atomic.Int32
	
	// Backpressure
	backpressure atomic.Bool
}

// MessageDeduplicator prevents duplicate messages
type MessageDeduplicator struct {
	// Sliding window of message hashes
	window     *SlidingWindow
	windowSize time.Duration
	
	// Bloom filter for fast checks
	bloom      *BloomFilter
	bloomSize  uint64
	bloomHashes int
}

// MessageCompressor handles message compression
type MessageCompressor struct {
	threshold int
	
	// Compression pools
	lz4Pool   sync.Pool
	zstdPool  sync.Pool
	gzipPool  sync.Pool
}

// NewMessageQueue creates a new message queue
func NewMessageQueue(logger *zap.Logger, config *QueueConfig) *MessageQueue {
	if config == nil {
		config = DefaultQueueConfig()
	}
	
	ctx, cancel := context.WithCancel(context.Background())
	
	mq := &MessageQueue{
		logger: logger,
		config: config,
		ctx:    ctx,
		cancel: cancel,
		
		// Initialize channels
		urgent: make(chan *QueuedMessage, config.UrgentSize),
		high:   make(chan *QueuedMessage, config.HighSize),
		normal: make(chan *QueuedMessage, config.NormalSize),
		low:    make(chan *QueuedMessage, config.LowSize),
	}
	
	// Initialize components
	if config.EnablePersistence {
		mq.persister = NewMessagePersister(logger, config.PersistencePath)
	}
	
	if config.EnableCompression {
		mq.compressor = NewMessageCompressor(config.CompressionThreshold)
	}
	
	if config.EnableDeduplication {
		mq.deduplicator = NewMessageDeduplicator(config.DeduplicationWindow)
	}
	
	mq.flowController = NewFlowController(logger)
	
	return mq
}

// Start starts the message queue
func (mq *MessageQueue) Start() error {
	// Start persistence
	if mq.persister != nil {
		if err := mq.persister.Start(); err != nil {
			return err
		}
	}
	
	// Start worker goroutines
	mq.wg.Add(1)
	go mq.persistenceWorker()
	
	mq.wg.Add(1)
	go mq.expirationWorker()
	
	mq.logger.Info("Message queue started")
	return nil
}

// Stop stops the message queue
func (mq *MessageQueue) Stop() {
	mq.cancel()
	
	// Close channels
	close(mq.urgent)
	close(mq.high)
	close(mq.normal)
	close(mq.low)
	
	mq.wg.Wait()
	
	// Stop persistence
	if mq.persister != nil {
		mq.persister.Stop()
	}
	
	mq.logger.Info("Message queue stopped")
}

// Enqueue adds a message to the queue
func (mq *MessageQueue) Enqueue(msg *Message, priority MessagePriority) error {
	// Validate message
	if msg == nil || len(msg.Data) == 0 {
		return errors.New("invalid message")
	}
	
	if len(msg.Data) > mq.config.MaxMessageSize {
		return errors.New("message too large")
	}
	
	// Check flow control
	if mq.flowController.ShouldDrop(msg.From) {
		mq.stats.dropped.Add(1)
		return errors.New("flow control: message dropped")
	}
	
	// Create queued message
	qm := &QueuedMessage{
		Message:   msg,
		Priority:  priority,
		Timestamp: time.Now().UnixNano(),
		TTL:       mq.config.MessageTTL,
		id:        atomic.AddUint64(&messageIDCounter, 1),
	}
	
	// Check deduplication
	if mq.deduplicator != nil && mq.deduplicator.IsDuplicate(msg) {
		mq.stats.deduplicated.Add(1)
		return nil // Silently drop duplicates
	}
	
	// Compress if needed
	if mq.compressor != nil && len(msg.Data) > mq.config.CompressionThreshold {
		compressed, err := mq.compressor.Compress(msg.Data)
		if err == nil && len(compressed) < len(msg.Data) {
			msg.Data = compressed
			msg.Compressed = true
			qm.compressed = true
			mq.stats.compressed.Add(1)
		}
	}
	
	// Select queue based on priority
	var targetQueue chan *QueuedMessage
	switch priority {
	case PriorityUrgent:
		targetQueue = mq.urgent
	case PriorityHigh:
		targetQueue = mq.high
	case PriorityNormal:
		targetQueue = mq.normal
	case PriorityLow:
		targetQueue = mq.low
	default:
		targetQueue = mq.normal
	}
	
	// Try to enqueue
	select {
	case targetQueue <- qm:
		mq.stats.enqueued.Add(1)
		
		// Persist if enabled
		if mq.persister != nil && priority >= PriorityHigh {
			mq.persister.Persist(qm)
			mq.stats.persisted.Add(1)
		}
		
		return nil
		
	case <-time.After(100 * time.Millisecond):
		mq.stats.dropped.Add(1)
		return errors.New("queue full")
	}
}

// Dequeue retrieves the next message
func (mq *MessageQueue) Dequeue(ctx context.Context) (*QueuedMessage, error) {
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
			
		// Check queues in priority order
		case msg := <-mq.urgent:
			if mq.isMessageValid(msg) {
				mq.stats.dequeued.Add(1)
				return mq.processDequeued(msg)
			}
			
		case msg := <-mq.high:
			if mq.isMessageValid(msg) {
				mq.stats.dequeued.Add(1)
				return mq.processDequeued(msg)
			}
			
		case msg := <-mq.normal:
			if mq.isMessageValid(msg) {
				mq.stats.dequeued.Add(1)
				return mq.processDequeued(msg)
			}
			
		case msg := <-mq.low:
			if mq.isMessageValid(msg) {
				mq.stats.dequeued.Add(1)
				return mq.processDequeued(msg)
			}
			
		default:
			// Non-blocking check for urgent messages
			select {
			case msg := <-mq.urgent:
				if mq.isMessageValid(msg) {
					mq.stats.dequeued.Add(1)
					return mq.processDequeued(msg)
				}
			case <-time.After(10 * time.Millisecond):
				// Continue loop
			}
		}
	}
}

// GetStats returns queue statistics
func (mq *MessageQueue) GetStats() map[string]uint64 {
	return map[string]uint64{
		"enqueued":      mq.stats.enqueued.Load(),
		"dequeued":      mq.stats.dequeued.Load(),
		"dropped":       mq.stats.dropped.Load(),
		"compressed":    mq.stats.compressed.Load(),
		"deduplicated":  mq.stats.deduplicated.Load(),
		"persisted":     mq.stats.persisted.Load(),
		"urgent_size":   uint64(len(mq.urgent)),
		"high_size":     uint64(len(mq.high)),
		"normal_size":   uint64(len(mq.normal)),
		"low_size":      uint64(len(mq.low)),
	}
}

// Private methods

func (mq *MessageQueue) isMessageValid(msg *QueuedMessage) bool {
	if msg == nil {
		return false
	}
	
	// Check TTL
	age := time.Since(time.Unix(0, msg.Timestamp))
	if age > msg.TTL {
		return false
	}
	
	return true
}

func (mq *MessageQueue) processDequeued(msg *QueuedMessage) (*QueuedMessage, error) {
	// Decompress if needed
	if msg.compressed && mq.compressor != nil {
		decompressed, err := mq.compressor.Decompress(msg.Message.Data)
		if err != nil {
			return nil, err
		}
		msg.Message.Data = decompressed
		msg.Message.Compressed = false
		msg.compressed = false
	}
	
	// Update flow control
	mq.flowController.RecordDequeue(msg.Message.From)
	
	return msg, nil
}

func (mq *MessageQueue) persistenceWorker() {
	defer mq.wg.Done()
	
	if mq.persister == nil {
		return
	}
	
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-mq.ctx.Done():
			return
		case <-ticker.C:
			mq.persister.Flush()
		}
	}
}

func (mq *MessageQueue) expirationWorker() {
	defer mq.wg.Done()
	
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-mq.ctx.Done():
			return
		case <-ticker.C:
			// Clean expired messages from persistence
			if mq.persister != nil {
				mq.persister.CleanExpired(mq.config.MessageTTL)
			}
		}
	}
}

// Helper types and methods

var messageIDCounter uint64

// DefaultQueueConfig returns default queue configuration
func DefaultQueueConfig() *QueueConfig {
	return &QueueConfig{
		UrgentSize:           100,
		HighSize:             1000,
		NormalSize:           10000,
		LowSize:              50000,
		EnablePersistence:    true,
		EnableCompression:    true,
		EnableDeduplication:  true,
		CompressionThreshold: 1024,
		DeduplicationWindow:  5 * time.Minute,
		PersistencePath:      "./data/p2p_messages",
		MaxMessageSize:       1024 * 1024, // 1MB
		MessageTTL:           5 * time.Minute,
	}
}

// NewMessagePersister creates a message persister
func NewMessagePersister(logger *zap.Logger, path string) *MessagePersister {
	return &MessagePersister{
		logger:    logger,
		dbPath:    path,
		batchSize: 100,
	}
}

// Start starts the persister
func (mp *MessagePersister) Start() error {
	// Initialize WAL
	mp.wal = NewWriteAheadLog(mp.dbPath)
	return mp.wal.Open()
}

// Stop stops the persister
func (mp *MessagePersister) Stop() {
	mp.Flush()
	if mp.wal != nil {
		mp.wal.Close()
	}
}

// Persist adds a message to persistence
func (mp *MessagePersister) Persist(msg *QueuedMessage) {
	mp.batchMu.Lock()
	mp.batch = append(mp.batch, msg)
	
	if len(mp.batch) >= mp.batchSize {
		mp.flushBatch()
	}
	mp.batchMu.Unlock()
}

// Flush flushes pending messages
func (mp *MessagePersister) Flush() {
	mp.batchMu.Lock()
	defer mp.batchMu.Unlock()
	mp.flushBatch()
}

func (mp *MessagePersister) flushBatch() {
	if len(mp.batch) == 0 {
		return
	}
	
	// Write to WAL
	for _, msg := range mp.batch {
		data := mp.serializeMessage(msg)
		mp.wal.Write(data)
	}
	
	mp.batch = mp.batch[:0]
}

func (mp *MessagePersister) serializeMessage(msg *QueuedMessage) []byte {
	// Simple serialization - in production use protobuf
	buf := make([]byte, 8+len(msg.Message.Data))
	binary.BigEndian.PutUint64(buf[:8], msg.id)
	copy(buf[8:], msg.Message.Data)
	return buf
}

// CleanExpired removes expired messages
func (mp *MessagePersister) CleanExpired(ttl time.Duration) {
	// Implementation would scan and remove old messages
}

// NewFlowController creates a flow controller
func NewFlowController(logger *zap.Logger) *FlowController {
	fc := &FlowController{
		logger: logger,
	}
	fc.congestionWindow.Store(10)
	fc.slowStartThresh.Store(64)
	return fc
}

// ShouldDrop determines if a message should be dropped
func (fc *FlowController) ShouldDrop(peerID string) bool {
	if fc.backpressure.Load() {
		return true
	}
	
	// Check per-peer rate
	rate, _ := fc.peerRates.LoadOrStore(peerID, NewRateController(100)) // 100 msg/s default
	rc := rate.(*RateController)
	
	return !rc.Allow()
}

// RecordDequeue records a dequeue event
func (fc *FlowController) RecordDequeue(peerID string) {
	// Update congestion window
	cwnd := fc.congestionWindow.Load()
	thresh := fc.slowStartThresh.Load()
	
	if cwnd < thresh {
		// Slow start
		fc.congestionWindow.Add(1)
	} else {
		// Congestion avoidance
		if cwnd < 1000 { // Max window
			fc.congestionWindow.Add(1)
		}
	}
}

// RateController implements token bucket rate limiting
type RateController struct {
	tokens    atomic.Int64
	capacity  int64
	refillRate int64
	lastRefill atomic.Int64
}

// NewRateController creates a rate controller
func NewRateController(ratePerSecond int64) *RateController {
	rc := &RateController{
		capacity:   ratePerSecond,
		refillRate: ratePerSecond,
	}
	rc.tokens.Store(ratePerSecond)
	rc.lastRefill.Store(time.Now().UnixNano())
	return rc
}

// Allow checks if operation is allowed
func (rc *RateController) Allow() bool {
	rc.refill()
	
	if rc.tokens.Load() > 0 {
		rc.tokens.Add(-1)
		return true
	}
	return false
}

func (rc *RateController) refill() {
	now := time.Now().UnixNano()
	last := rc.lastRefill.Load()
	elapsed := now - last
	
	if elapsed > int64(time.Second) {
		tokensToAdd := (elapsed * rc.refillRate) / int64(time.Second)
		current := rc.tokens.Load()
		
		newTokens := current + tokensToAdd
		if newTokens > rc.capacity {
			newTokens = rc.capacity
		}
		
		rc.tokens.Store(newTokens)
		rc.lastRefill.Store(now)
	}
}

// NewMessageDeduplicator creates a message deduplicator
func NewMessageDeduplicator(windowSize time.Duration) *MessageDeduplicator {
	return &MessageDeduplicator{
		window:      NewSlidingWindow(windowSize),
		windowSize:  windowSize,
		bloom:       NewBloomFilter(1000000, 0.01), // 1M items, 1% false positive
		bloomSize:   1000000,
		bloomHashes: 7,
	}
}

// IsDuplicate checks if message is duplicate
func (md *MessageDeduplicator) IsDuplicate(msg *Message) bool {
	hash := md.hashMessage(msg)
	
	// Quick bloom filter check
	if !md.bloom.Contains(hash) {
		md.bloom.Add(hash)
		md.window.Add(hash)
		return false
	}
	
	// Detailed check in sliding window
	return md.window.Contains(hash)
}

func (md *MessageDeduplicator) hashMessage(msg *Message) []byte {
	h := sha256.New()
	h.Write([]byte(msg.From))
	h.Write([]byte(msg.Type))
	binary.Write(h, binary.BigEndian, msg.Timestamp)
	h.Write(msg.Data)
	return h.Sum(nil)
}

// NewMessageCompressor creates a message compressor
func NewMessageCompressor(threshold int) *MessageCompressor {
	return &MessageCompressor{
		threshold: threshold,
		lz4Pool: sync.Pool{
			New: func() interface{} {
				return make([]byte, 0, 65536)
			},
		},
	}
}

// Compress compresses data
func (mc *MessageCompressor) Compress(data []byte) ([]byte, error) {
	if len(data) < mc.threshold {
		return data, nil
	}
	
	// Simple implementation - would use LZ4 in production
	buf := mc.lz4Pool.Get().([]byte)
	defer mc.lz4Pool.Put(buf)
	
	// Placeholder compression
	compressed := make([]byte, len(data))
	copy(compressed, data)
	return compressed, nil
}

// Decompress decompresses data
func (mc *MessageCompressor) Decompress(data []byte) ([]byte, error) {
	// Placeholder decompression
	return data, nil
}

// WriteAheadLog provides simple WAL functionality
type WriteAheadLog struct {
	path string
	file *sync.Mutex // Placeholder for file handle
}

// NewWriteAheadLog creates a WAL
func NewWriteAheadLog(path string) *WriteAheadLog {
	return &WriteAheadLog{
		path: path,
		file: &sync.Mutex{},
	}
}

// Open opens the WAL
func (wal *WriteAheadLog) Open() error {
	// Implementation would open file
	return nil
}

// Close closes the WAL
func (wal *WriteAheadLog) Close() error {
	// Implementation would close file
	return nil
}

// Write writes to the WAL
func (wal *WriteAheadLog) Write(data []byte) error {
	wal.file.Lock()
	defer wal.file.Unlock()
	// Implementation would write to file
	return nil
}

// SlidingWindow provides time-based sliding window
type SlidingWindow struct {
	items      []windowItem
	mu         sync.Mutex
	windowSize time.Duration
}

type windowItem struct {
	hash      []byte
	timestamp int64
}

// NewSlidingWindow creates a sliding window
func NewSlidingWindow(size time.Duration) *SlidingWindow {
	return &SlidingWindow{
		items:      make([]windowItem, 0, 1000),
		windowSize: size,
	}
}

// Add adds item to window
func (sw *SlidingWindow) Add(hash []byte) {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	
	sw.items = append(sw.items, windowItem{
		hash:      hash,
		timestamp: time.Now().UnixNano(),
	})
	
	// Clean old items
	sw.clean()
}

// Contains checks if item exists
func (sw *SlidingWindow) Contains(hash []byte) bool {
	sw.mu.Lock()
	defer sw.mu.Unlock()
	
	sw.clean()
	
	for _, item := range sw.items {
		if bytesEqual(item.hash, hash) {
			return true
		}
	}
	return false
}

func (sw *SlidingWindow) clean() {
	cutoff := time.Now().Add(-sw.windowSize).UnixNano()
	
	// Find first non-expired item
	idx := 0
	for idx < len(sw.items) && sw.items[idx].timestamp < cutoff {
		idx++
	}
	
	// Remove expired items
	if idx > 0 {
		sw.items = sw.items[idx:]
	}
}

// BloomFilter provides probabilistic deduplication
type BloomFilter struct {
	bits     []uint64
	size     uint64
	numHashes int
}

// NewBloomFilter creates a bloom filter
func NewBloomFilter(size uint64, falsePositiveRate float64) *BloomFilter {
	// Calculate optimal parameters
	numBits := uint64(float64(size) * -1.44 * math.Log2(falsePositiveRate))
	numHashes := int(float64(numBits) / float64(size) * 0.693)
	
	return &BloomFilter{
		bits:      make([]uint64, (numBits+63)/64),
		size:      numBits,
		numHashes: numHashes,
	}
}

// Add adds item to bloom filter
func (bf *BloomFilter) Add(data []byte) {
	for i := 0; i < bf.numHashes; i++ {
		h := bf.hash(data, i) % bf.size
		bf.bits[h/64] |= 1 << (h % 64)
	}
}

// Contains checks if item might exist
func (bf *BloomFilter) Contains(data []byte) bool {
	for i := 0; i < bf.numHashes; i++ {
		h := bf.hash(data, i) % bf.size
		if bf.bits[h/64]&(1<<(h%64)) == 0 {
			return false
		}
	}
	return true
}

func (bf *BloomFilter) hash(data []byte, seed int) uint64 {
	// Simple hash - would use murmur3 in production
	h := uint64(seed)
	for _, b := range data {
		h = h*31 + uint64(b)
	}
	return h
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Priority string representations
func (p MessagePriority) String() string {
	switch p {
	case PriorityUrgent:
		return "urgent"
	case PriorityHigh:
		return "high"
	case PriorityNormal:
		return "normal"
	case PriorityLow:
		return "low"
	default:
		return "unknown"
	}
}