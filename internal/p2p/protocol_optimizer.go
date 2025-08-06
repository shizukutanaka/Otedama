package p2p

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	// "github.com/shizukutanaka/Otedama/internal/optimization" // Temporarily disabled
	"go.uber.org/zap"
	"golang.org/x/sys/unix"
)

// ProtocolOptimizer implements high-performance network protocol optimizations
// Inspired by John Carmack's network code in Quake/Doom
type ProtocolOptimizer struct {
	logger *zap.Logger
	
	// Zero-copy memory pool
	// memPool *optimization.ZeroCopyPool // Temporarily disabled
	
	// Connection management
	connections sync.Map // map[connID]*OptimizedConn
	
	// Protocol settings
	config ProtocolConfig
	
	// Performance metrics
	metrics struct {
		packetsReceived atomic.Uint64
		packetsSent     atomic.Uint64
		bytesReceived   atomic.Uint64
		bytesSent       atomic.Uint64
		latencyNanos    atomic.Uint64
		compressionRatio atomic.Uint64
	}
	
	// Packet recycling
	packetPool sync.Pool
	
	// TCP optimizations
	tcpNoDelay bool
	tcpQuickAck bool
	
	// Context for lifecycle
	ctx    context.Context
	cancel context.CancelFunc
}

// ProtocolConfig configures protocol optimization
type ProtocolConfig struct {
	// Buffer sizes
	ReadBufferSize  int
	WriteBufferSize int
	
	// Packet settings
	MaxPacketSize   int
	PacketTimeout   time.Duration
	
	// Compression
	EnableCompression bool
	CompressionLevel  int
	
	// Batching
	EnableBatching   bool
	BatchSize        int
	BatchTimeout     time.Duration
	
	// Network optimizations
	EnableTCPNoDelay bool
	EnableQuickAck   bool
	EnableZeroCopy   bool
	
	// Reliability
	RetryCount       int
	RetryBackoff     time.Duration
}

// OptimizedConn represents an optimized network connection
type OptimizedConn struct {
	conn     net.Conn
	connID   uint64
	
	// Buffered I/O with zero-copy
	reader   *bufio.Reader
	writer   *bufio.Writer
	
	// Packet batching
	batchBuffer []byte // *optimization.Buffer
	batchCount  int
	batchTimer  *time.Timer
	batchMu     sync.Mutex
	
	// Statistics
	stats ConnStats
	
	// State
	closed atomic.Bool
	
	// Direct socket access for optimizations
	fd int
}

// ConnStats tracks connection statistics
type ConnStats struct {
	PacketsSent     atomic.Uint64
	PacketsReceived atomic.Uint64
	BytesSent       atomic.Uint64
	BytesReceived   atomic.Uint64
	LastActivity    atomic.Int64
	RTTNanos        atomic.Uint64
}

// Packet represents an optimized network packet
type Packet struct {
	// Header (8 bytes)
	Type      uint8
	Flags     uint8
	Sequence  uint16
	Length    uint32
	
	// Timestamp for RTT calculation
	Timestamp int64
	
	// Payload
	Data      []byte // *optimization.Buffer
	
	// For packet pool recycling
	pool      *sync.Pool
}

// Packet types
const (
	PacketTypeData     = 0x01
	PacketTypePing     = 0x02
	PacketTypeAck      = 0x03
	PacketTypeBatch    = 0x04
	PacketTypeControl  = 0x05
)

// Packet flags
const (
	FlagCompressed = 0x01
	FlagEncrypted  = 0x02
	FlagReliable   = 0x04
	FlagUrgent     = 0x08
)

// NewProtocolOptimizer creates a new protocol optimizer
func NewProtocolOptimizer(logger *zap.Logger, config ProtocolConfig) *ProtocolOptimizer {
	ctx, cancel := context.WithCancel(context.Background())
	
	po := &ProtocolOptimizer{
		logger:     logger,
		// memPool:    optimization.NewZeroCopyPool(), // Temporarily disabled
		config:     config,
		tcpNoDelay: config.EnableTCPNoDelay,
		tcpQuickAck: config.EnableQuickAck,
		ctx:        ctx,
		cancel:     cancel,
	}
	
	// Initialize packet pool
	po.packetPool.New = func() interface{} {
		return &Packet{
			pool: &po.packetPool,
		}
	}
	
	return po
}

// OptimizeConnection applies optimizations to a network connection
func (po *ProtocolOptimizer) OptimizeConnection(conn net.Conn) (*OptimizedConn, error) {
	// Apply TCP optimizations
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		if err := po.applyTCPOptimizations(tcpConn); err != nil {
			return nil, err
		}
	}
	
	// Create optimized connection
	oc := &OptimizedConn{
		conn:   conn,
		connID: atomic.AddUint64(&connIDCounter, 1),
		reader: bufio.NewReaderSize(conn, po.config.ReadBufferSize),
		writer: bufio.NewWriterSize(conn, po.config.WriteBufferSize),
	}
	
	// Initialize batch buffer if batching enabled
	if po.config.EnableBatching {
		oc.batchBuffer = po.memPool.Allocate(po.config.MaxPacketSize * po.config.BatchSize)
		oc.batchTimer = time.NewTimer(po.config.BatchTimeout)
		oc.batchTimer.Stop()
	}
	
	// Get file descriptor for advanced optimizations
	if po.config.EnableZeroCopy {
		oc.fd = po.getSocketFD(conn)
	}
	
	// Store connection
	po.connections.Store(oc.connID, oc)
	
	// Start connection handler
	go po.handleConnection(oc)
	
	return oc, nil
}

// SendPacket sends an optimized packet
func (po *ProtocolOptimizer) SendPacket(oc *OptimizedConn, pktType uint8, data []byte) error {
	if oc.closed.Load() {
		return ErrConnectionClosed
	}
	
	// Get packet from pool
	pkt := po.packetPool.Get().(*Packet)
	defer po.putPacket(pkt)
	
	// Prepare packet
	pkt.Type = pktType
	pkt.Flags = 0
	pkt.Sequence = uint16(oc.stats.PacketsSent.Add(1) & 0xFFFF)
	pkt.Length = uint32(len(data))
	pkt.Timestamp = time.Now().UnixNano()
	
	// Copy data to zero-copy buffer
	pkt.Data = po.memPool.Allocate(len(data))
	copy(pkt.Data.Data(), data)
	defer pkt.Data.Release()
	
	// Apply compression if enabled
	if po.config.EnableCompression && len(data) > 64 {
		compressed := po.compress(pkt.Data)
		if compressed.Len() < pkt.Data.Len() {
			pkt.Data.Release()
			pkt.Data = compressed
			pkt.Flags |= FlagCompressed
			pkt.Length = uint32(compressed.Len())
		} else {
			compressed.Release()
		}
	}
	
	// Send packet
	if po.config.EnableBatching && pktType == PacketTypeData {
		return po.batchPacket(oc, pkt)
	}
	
	return po.sendPacketDirect(oc, pkt)
}

// ReceivePacket receives an optimized packet
func (po *ProtocolOptimizer) ReceivePacket(oc *OptimizedConn) (*Packet, error) {
	if oc.closed.Load() {
		return nil, ErrConnectionClosed
	}
	
	// Read packet header (16 bytes)
	header := make([]byte, 16)
	if _, err := io.ReadFull(oc.reader, header); err != nil {
		return nil, err
	}
	
	// Parse header
	pkt := po.packetPool.Get().(*Packet)
	pkt.Type = header[0]
	pkt.Flags = header[1]
	pkt.Sequence = binary.BigEndian.Uint16(header[2:4])
	pkt.Length = binary.BigEndian.Uint32(header[4:8])
	pkt.Timestamp = int64(binary.BigEndian.Uint64(header[8:16]))
	
	// Validate packet size
	if pkt.Length > uint32(po.config.MaxPacketSize) {
		po.putPacket(pkt)
		return nil, ErrPacketTooLarge
	}
	
	// Read payload with zero-copy if possible
	if po.config.EnableZeroCopy && oc.fd > 0 {
		pkt.Data = po.memPool.Allocate(int(pkt.Length))
		if err := po.zeroCopyRead(oc, pkt.Data); err != nil {
			pkt.Data.Release()
			po.putPacket(pkt)
			return nil, err
		}
	} else {
		// Standard read
		pkt.Data = po.memPool.Allocate(int(pkt.Length))
		if _, err := io.ReadFull(oc.reader, pkt.Data.Data()); err != nil {
			pkt.Data.Release()
			po.putPacket(pkt)
			return nil, err
		}
	}
	
	// Decompress if needed
	if pkt.Flags&FlagCompressed != 0 {
		decompressed := po.decompress(pkt.Data)
		pkt.Data.Release()
		pkt.Data = decompressed
	}
	
	// Update statistics
	oc.stats.PacketsReceived.Add(1)
	oc.stats.BytesReceived.Add(uint64(pkt.Length))
	oc.stats.LastActivity.Store(time.Now().Unix())
	
	// Calculate RTT
	if pkt.Type == PacketTypeAck {
		rtt := time.Now().UnixNano() - pkt.Timestamp
		oc.stats.RTTNanos.Store(uint64(rtt))
	}
	
	return pkt, nil
}

// Internal methods

func (po *ProtocolOptimizer) applyTCPOptimizations(conn *net.TCPConn) error {
	// Set TCP_NODELAY for low latency
	if po.tcpNoDelay {
		if err := conn.SetNoDelay(true); err != nil {
			return err
		}
	}
	
	// Set socket options for performance
	rawConn, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	
	return rawConn.Control(func(fd uintptr) {
		// Enable TCP quick ACK
		if po.tcpQuickAck {
			unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_QUICKACK, 1)
		}
		
		// Set socket buffer sizes
		unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_RCVBUF, po.config.ReadBufferSize)
		unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_SNDBUF, po.config.WriteBufferSize)
		
		// Enable TCP keep-alive
		unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_KEEPALIVE, 1)
		unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_KEEPIDLE, 60)
		unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_KEEPINTVL, 10)
		unix.SetsockoptInt(int(fd), unix.IPPROTO_TCP, unix.TCP_KEEPCNT, 6)
	})
}

func (po *ProtocolOptimizer) sendPacketDirect(oc *OptimizedConn, pkt *Packet) error {
	// Build packet header
	header := make([]byte, 16)
	header[0] = pkt.Type
	header[1] = pkt.Flags
	binary.BigEndian.PutUint16(header[2:4], pkt.Sequence)
	binary.BigEndian.PutUint32(header[4:8], pkt.Length)
	binary.BigEndian.PutUint64(header[8:16], uint64(pkt.Timestamp))
	
	// Send with zero-copy if possible
	if po.config.EnableZeroCopy && oc.fd > 0 {
		// Use sendmsg for zero-copy
		return po.zeroCopyWrite(oc, header, pkt.Data.Data())
	}
	
	// Standard send
	oc.batchMu.Lock()
	defer oc.batchMu.Unlock()
	
	if _, err := oc.writer.Write(header); err != nil {
		return err
	}
	if _, err := oc.writer.Write(pkt.Data.Data()); err != nil {
		return err
	}
	if err := oc.writer.Flush(); err != nil {
		return err
	}
	
	// Update statistics
	oc.stats.PacketsSent.Add(1)
	oc.stats.BytesSent.Add(uint64(16 + pkt.Length))
	
	return nil
}

func (po *ProtocolOptimizer) batchPacket(oc *OptimizedConn, pkt *Packet) error {
	oc.batchMu.Lock()
	defer oc.batchMu.Unlock()
	
	// Add to batch buffer
	header := make([]byte, 16)
	header[0] = pkt.Type
	header[1] = pkt.Flags
	binary.BigEndian.PutUint16(header[2:4], pkt.Sequence)
	binary.BigEndian.PutUint32(header[4:8], pkt.Length)
	binary.BigEndian.PutUint64(header[8:16], uint64(pkt.Timestamp))
	
	// Check if batch buffer has space
	needed := 16 + int(pkt.Length)
	if oc.batchBuffer.Len()+needed > oc.batchBuffer.Cap() {
		// Flush current batch
		if err := po.flushBatch(oc); err != nil {
			return err
		}
	}
	
	// Add to batch
	copy(oc.batchBuffer.Data()[oc.batchBuffer.Len():], header)
	copy(oc.batchBuffer.Data()[oc.batchBuffer.Len()+16:], pkt.Data.Data())
	oc.batchBuffer.Resize(oc.batchBuffer.Len() + needed)
	oc.batchCount++
	
	// Start batch timer if this is first packet
	if oc.batchCount == 1 {
		oc.batchTimer.Reset(po.config.BatchTimeout)
		go func() {
			<-oc.batchTimer.C
			oc.batchMu.Lock()
			po.flushBatch(oc)
			oc.batchMu.Unlock()
		}()
	}
	
	// Flush if batch is full
	if oc.batchCount >= po.config.BatchSize {
		return po.flushBatch(oc)
	}
	
	return nil
}

func (po *ProtocolOptimizer) flushBatch(oc *OptimizedConn) error {
	if oc.batchCount == 0 {
		return nil
	}
	
	// Stop timer
	oc.batchTimer.Stop()
	
	// Create batch packet
	batchPkt := &Packet{
		Type:      PacketTypeBatch,
		Flags:     0,
		Sequence:  uint16(oc.stats.PacketsSent.Add(1) & 0xFFFF),
		Length:    uint32(oc.batchBuffer.Len()),
		Timestamp: time.Now().UnixNano(),
		Data:      oc.batchBuffer,
	}
	
	// Send batch
	if err := po.sendPacketDirect(oc, batchPkt); err != nil {
		return err
	}
	
	// Reset batch
	oc.batchBuffer.Zero()
	oc.batchBuffer.Resize(0)
	oc.batchCount = 0
	
	return nil
}

func (po *ProtocolOptimizer) handleConnection(oc *OptimizedConn) {
	defer func() {
		oc.closed.Store(true)
		oc.conn.Close()
		po.connections.Delete(oc.connID)
		if oc.batchBuffer != nil {
			oc.batchBuffer.Release()
		}
	}()
	
	// Connection handler loop
	for {
		select {
		case <-po.ctx.Done():
			return
		default:
			// Set read deadline
			oc.conn.SetReadDeadline(time.Now().Add(po.config.PacketTimeout))
			
			// Read packet
			pkt, err := po.ReceivePacket(oc)
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					continue
				}
				po.logger.Debug("Connection error", zap.Error(err))
				return
			}
			
			// Process packet
			po.processPacket(oc, pkt)
			
			// Return packet to pool
			pkt.Data.Release()
			po.putPacket(pkt)
		}
	}
}

func (po *ProtocolOptimizer) processPacket(oc *OptimizedConn, pkt *Packet) {
	switch pkt.Type {
	case PacketTypePing:
		// Send pong
		po.SendPacket(oc, PacketTypeAck, pkt.Data.Data())
		
	case PacketTypeBatch:
		// Process batched packets
		offset := 0
		for offset < pkt.Data.Len() {
			if offset+16 > pkt.Data.Len() {
				break
			}
			
			// Parse sub-packet header
			header := pkt.Data.Data()[offset : offset+16]
			subPkt := &Packet{
				Type:      header[0],
				Flags:     header[1],
				Sequence:  binary.BigEndian.Uint16(header[2:4]),
				Length:    binary.BigEndian.Uint32(header[4:8]),
				Timestamp: int64(binary.BigEndian.Uint64(header[8:16])),
			}
			
			offset += 16
			if offset+int(subPkt.Length) > pkt.Data.Len() {
				break
			}
			
			// Extract sub-packet data
			subPkt.Data = po.memPool.ZeroCopySlice(pkt.Data, offset, int(subPkt.Length))
			offset += int(subPkt.Length)
			
			// Process sub-packet
			po.processPacket(oc, subPkt)
		}
	}
}

func (po *ProtocolOptimizer) compress(data []byte) []byte {
	// Simple compression implementation
	// In production, use lz4 or similar
	return data.Clone()
}

func (po *ProtocolOptimizer) decompress(data []byte) []byte {
	// Simple decompression implementation
	// In production, use lz4 or similar
	return data.Clone()
}

func (po *ProtocolOptimizer) zeroCopyRead(oc *OptimizedConn, buf []byte) error {
	// Zero-copy read using splice or similar
	// This is a simplified version
	_, err := oc.reader.Read(buf.Data())
	return err
}

func (po *ProtocolOptimizer) zeroCopyWrite(oc *OptimizedConn, header, data []byte) error {
	// Zero-copy write using sendmsg
	// This is a simplified version
	if _, err := oc.writer.Write(header); err != nil {
		return err
	}
	if _, err := oc.writer.Write(data); err != nil {
		return err
	}
	return oc.writer.Flush()
}

func (po *ProtocolOptimizer) getSocketFD(conn net.Conn) int {
	// Get file descriptor for zero-copy operations
	// This is platform-specific
	return -1
}

func (po *ProtocolOptimizer) putPacket(pkt *Packet) {
	pkt.Type = 0
	pkt.Flags = 0
	pkt.Sequence = 0
	pkt.Length = 0
	pkt.Timestamp = 0
	pkt.Data = nil
	pkt.pool.Put(pkt)
}

// GetStats returns protocol statistics
func (po *ProtocolOptimizer) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"packets_received":  po.metrics.packetsReceived.Load(),
		"packets_sent":      po.metrics.packetsSent.Load(),
		"bytes_received":    po.metrics.bytesReceived.Load(),
		"bytes_sent":        po.metrics.bytesSent.Load(),
		"avg_latency_ns":    po.metrics.latencyNanos.Load(),
		"compression_ratio": po.metrics.compressionRatio.Load(),
		"active_connections": po.countConnections(),
		"memory_stats":      po.memPool.GetStats(),
	}
}

func (po *ProtocolOptimizer) countConnections() int {
	count := 0
	po.connections.Range(func(_, _ interface{}) bool {
		count++
		return true
	})
	return count
}

// Errors
var (
	ErrConnectionClosed = net.ErrClosed
	ErrPacketTooLarge   = errors.New("packet too large")
)

// Global connection ID counter
var connIDCounter uint64

// OptimizedConn methods

// Close closes the connection
func (oc *OptimizedConn) Close() error {
	oc.closed.Store(true)
	return oc.conn.Close()
}

// GetStats returns connection statistics
func (oc *OptimizedConn) GetStats() ConnStats {
	return ConnStats{
		PacketsSent:     atomic.LoadUint64(&oc.stats.PacketsSent.v),
		PacketsReceived: atomic.LoadUint64(&oc.stats.PacketsReceived.v),
		BytesSent:       atomic.LoadUint64(&oc.stats.BytesSent.v),
		BytesReceived:   atomic.LoadUint64(&oc.stats.BytesReceived.v),
		LastActivity:    atomic.LoadInt64(&oc.stats.LastActivity.v),
		RTTNanos:        atomic.LoadUint64(&oc.stats.RTTNanos.v),
	}
}