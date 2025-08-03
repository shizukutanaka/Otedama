package network

import (
	"context"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/zstd"
	"go.uber.org/zap"
	"golang.org/x/sys/unix"
)

// LatencyOptimizer reduces network latency through various techniques
// Following Carmack's principle: measure everything, optimize the bottlenecks
type LatencyOptimizer struct {
	logger *zap.Logger
	config OptimizerConfig
	
	// Compression
	encoder *zstd.Encoder
	decoder *zstd.Decoder
	
	// Batching
	batcher *MessageBatcher
	
	// Latency tracking
	latencyTracker *LatencyTracker
	
	// TCP optimization state
	tcpTuned sync.Map // map[net.Conn]bool
	
	// Statistics
	stats struct {
		bytesCompressed   atomic.Uint64
		bytesUncompressed atomic.Uint64
		messagesBatched   atomic.Uint64
		tcpOptimized      atomic.Uint64
	}
}

// OptimizerConfig defines optimizer settings
type OptimizerConfig struct {
	EnableCompression   bool          `yaml:"enable_compression"`
	CompressionLevel    int           `yaml:"compression_level"`
	EnableBatching      bool          `yaml:"enable_batching"`
	BatchSize           int           `yaml:"batch_size"`
	BatchTimeout        time.Duration `yaml:"batch_timeout"`
	EnableTCPTuning     bool          `yaml:"enable_tcp_tuning"`
	EnableQuickAck      bool          `yaml:"enable_quickack"`
	EnableNoDelay       bool          `yaml:"enable_nodelay"`
	SendBufferSize      int           `yaml:"send_buffer_size"`
	ReceiveBufferSize   int           `yaml:"receive_buffer_size"`
}

// MessageBatcher batches small messages together
type MessageBatcher struct {
	messages  [][]byte
	totalSize int
	mu        sync.Mutex
	flushChan chan struct{}
	maxSize   int
	timeout   time.Duration
}

// LatencyTracker tracks network latency
type LatencyTracker struct {
	samples sync.Map // map[string]*LatencySamples
}

// LatencySamples stores latency measurements
type LatencySamples struct {
	samples  []int64 // microseconds
	head     int
	count    int
	mu       sync.RWMutex
}

// NewLatencyOptimizer creates a new latency optimizer
func NewLatencyOptimizer(logger *zap.Logger, config OptimizerConfig) (*LatencyOptimizer, error) {
	opt := &LatencyOptimizer{
		logger:         logger,
		config:         config,
		latencyTracker: &LatencyTracker{},
	}
	
	// Initialize compression
	if config.EnableCompression {
		encoder, err := zstd.NewWriter(nil, 
			zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(config.CompressionLevel)))
		if err != nil {
			return nil, err
		}
		
		decoder, err := zstd.NewReader(nil)
		if err != nil {
			encoder.Close()
			return nil, err
		}
		
		opt.encoder = encoder
		opt.decoder = decoder
	}
	
	// Initialize batcher
	if config.EnableBatching {
		opt.batcher = &MessageBatcher{
			maxSize:   config.BatchSize,
			timeout:   config.BatchTimeout,
			flushChan: make(chan struct{}, 1),
		}
	}
	
	return opt, nil
}

// OptimizeConnection applies optimizations to a connection
func (o *LatencyOptimizer) OptimizeConnection(conn net.Conn) error {
	if !o.config.EnableTCPTuning {
		return nil
	}
	
	// Check if already optimized
	if _, ok := o.tcpTuned.Load(conn); ok {
		return nil
	}
	
	tcpConn, ok := conn.(*net.TCPConn)
	if !ok {
		return nil
	}
	
	// Apply TCP optimizations
	if err := o.applyTCPOptimizations(tcpConn); err != nil {
		o.logger.Warn("Failed to optimize TCP connection",
			zap.Error(err),
		)
		return err
	}
	
	o.tcpTuned.Store(conn, true)
	o.stats.tcpOptimized.Add(1)
	
	return nil
}

// CompressMessage compresses a message if beneficial
func (o *LatencyOptimizer) CompressMessage(data []byte) ([]byte, bool) {
	if !o.config.EnableCompression || len(data) < 100 {
		return data, false
	}
	
	compressed := o.encoder.EncodeAll(data, nil)
	
	// Only use compression if it reduces size
	if len(compressed) < len(data)*9/10 {
		o.stats.bytesUncompressed.Add(uint64(len(data)))
		o.stats.bytesCompressed.Add(uint64(len(compressed)))
		return compressed, true
	}
	
	return data, false
}

// DecompressMessage decompresses a message
func (o *LatencyOptimizer) DecompressMessage(data []byte) ([]byte, error) {
	return o.decoder.DecodeAll(data, nil)
}

// BatchMessage adds a message to the batch
func (o *LatencyOptimizer) BatchMessage(data []byte) ([]byte, bool) {
	if !o.config.EnableBatching || len(data) > o.config.BatchSize/2 {
		return data, false
	}
	
	o.batcher.mu.Lock()
	defer o.batcher.mu.Unlock()
	
	// Add to batch
	o.batcher.messages = append(o.batcher.messages, data)
	o.batcher.totalSize += len(data)
	
	// Check if batch is ready
	if o.batcher.totalSize >= o.batcher.maxSize || len(o.batcher.messages) >= 10 {
		batch := o.createBatch()
		o.stats.messagesBatched.Add(uint64(len(o.batcher.messages)))
		o.batcher.messages = nil
		o.batcher.totalSize = 0
		return batch, true
	}
	
	// Start timeout timer
	if len(o.batcher.messages) == 1 {
		go o.batchTimeout()
	}
	
	return nil, false
}

// RecordLatency records a latency measurement
func (o *LatencyOptimizer) RecordLatency(endpoint string, latency time.Duration) {
	samples := o.getOrCreateSamples(endpoint)
	samples.Add(latency.Microseconds())
}

// GetLatencyStats returns latency statistics
func (o *LatencyOptimizer) GetLatencyStats(endpoint string) LatencyStats {
	samples := o.getOrCreateSamples(endpoint)
	return samples.GetStats()
}

// GetOptimizationStats returns optimization statistics
func (o *LatencyOptimizer) GetOptimizationStats() OptimizationStats {
	compressionRatio := float64(0)
	compressed := o.stats.bytesCompressed.Load()
	uncompressed := o.stats.bytesUncompressed.Load()
	if uncompressed > 0 {
		compressionRatio = float64(compressed) / float64(uncompressed)
	}
	
	return OptimizationStats{
		BytesCompressed:   compressed,
		BytesUncompressed: uncompressed,
		CompressionRatio:  compressionRatio,
		MessagesBatched:   o.stats.messagesBatched.Load(),
		TCPOptimized:      o.stats.tcpOptimized.Load(),
	}
}

// Private methods

func (o *LatencyOptimizer) applyTCPOptimizations(conn *net.TCPConn) error {
	// Get raw connection
	rawConn, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	
	var sockErr error
	err = rawConn.Control(func(fd uintptr) {
		// TCP_NODELAY
		if o.config.EnableNoDelay {
			sockErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_NODELAY, 1)
			if sockErr != nil {
				return
			}
		}
		
		// TCP_QUICKACK (Linux only)
		if o.config.EnableQuickAck {
			sockErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_QUICKACK, 1)
			if sockErr != nil && sockErr != unix.ENOPROTOOPT {
				return
			}
		}
		
		// Socket buffers
		if o.config.SendBufferSize > 0 {
			sockErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_SNDBUF, o.config.SendBufferSize)
			if sockErr != nil {
				return
			}
		}
		
		if o.config.ReceiveBufferSize > 0 {
			sockErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_RCVBUF, o.config.ReceiveBufferSize)
			if sockErr != nil {
				return
			}
		}
		
		// TCP_USER_TIMEOUT (Linux)
		sockErr = unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_USER_TIMEOUT, 30000)
		if sockErr != nil && sockErr != unix.ENOPROTOOPT {
			return
		}
	})
	
	if err != nil {
		return err
	}
	
	return sockErr
}

func (o *LatencyOptimizer) createBatch() []byte {
	// Simple batch format: [count][size1][msg1][size2][msg2]...
	totalSize := 4 // count
	for _, msg := range o.batcher.messages {
		totalSize += 4 + len(msg) // size + message
	}
	
	batch := make([]byte, totalSize)
	pos := 0
	
	// Write count
	batch[pos] = byte(len(o.batcher.messages))
	batch[pos+1] = byte(len(o.batcher.messages) >> 8)
	batch[pos+2] = byte(len(o.batcher.messages) >> 16)
	batch[pos+3] = byte(len(o.batcher.messages) >> 24)
	pos += 4
	
	// Write messages
	for _, msg := range o.batcher.messages {
		// Write size
		batch[pos] = byte(len(msg))
		batch[pos+1] = byte(len(msg) >> 8)
		batch[pos+2] = byte(len(msg) >> 16)
		batch[pos+3] = byte(len(msg) >> 24)
		pos += 4
		
		// Write message
		copy(batch[pos:], msg)
		pos += len(msg)
	}
	
	return batch
}

func (o *LatencyOptimizer) batchTimeout() {
	time.Sleep(o.batcher.timeout)
	
	o.batcher.mu.Lock()
	defer o.batcher.mu.Unlock()
	
	if len(o.batcher.messages) > 0 {
		select {
		case o.batcher.flushChan <- struct{}{}:
		default:
		}
	}
}

func (o *LatencyOptimizer) getOrCreateSamples(endpoint string) *LatencySamples {
	if val, ok := o.latencyTracker.samples.Load(endpoint); ok {
		return val.(*LatencySamples)
	}
	
	samples := &LatencySamples{
		samples: make([]int64, 1000),
	}
	
	actual, _ := o.latencyTracker.samples.LoadOrStore(endpoint, samples)
	return actual.(*LatencySamples)
}

// LatencySamples methods

func (s *LatencySamples) Add(latency int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	s.samples[s.head] = latency
	s.head = (s.head + 1) % len(s.samples)
	
	if s.count < len(s.samples) {
		s.count++
	}
}

func (s *LatencySamples) GetStats() LatencyStats {
	s.mu.RLock()
	defer s.mu.RUnlock()
	
	if s.count == 0 {
		return LatencyStats{}
	}
	
	// Calculate statistics
	sum := int64(0)
	min := int64(^uint64(0) >> 1)
	max := int64(0)
	
	// Copy samples for percentile calculation
	samples := make([]int64, s.count)
	for i := 0; i < s.count; i++ {
		val := s.samples[i]
		samples[i] = val
		sum += val
		if val < min {
			min = val
		}
		if val > max {
			max = val
		}
	}
	
	avg := sum / int64(s.count)
	
	// Calculate percentiles (simplified - in production use proper algorithm)
	p50 := samples[s.count/2]
	p95 := samples[s.count*95/100]
	p99 := samples[s.count*99/100]
	
	return LatencyStats{
		Min:     time.Duration(min) * time.Microsecond,
		Max:     time.Duration(max) * time.Microsecond,
		Average: time.Duration(avg) * time.Microsecond,
		P50:     time.Duration(p50) * time.Microsecond,
		P95:     time.Duration(p95) * time.Microsecond,
		P99:     time.Duration(p99) * time.Microsecond,
		Count:   s.count,
	}
}

// Data structures

// LatencyStats contains latency statistics
type LatencyStats struct {
	Min     time.Duration
	Max     time.Duration
	Average time.Duration
	P50     time.Duration
	P95     time.Duration
	P99     time.Duration
	Count   int
}

// OptimizationStats contains optimization statistics
type OptimizationStats struct {
	BytesCompressed   uint64
	BytesUncompressed uint64
	CompressionRatio  float64
	MessagesBatched   uint64
	TCPOptimized      uint64
}