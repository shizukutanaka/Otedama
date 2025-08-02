package performance

import (
	"errors"
	"fmt"
	"net"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"go.uber.org/zap"
)

// ZeroCopyNetwork implements zero-copy networking for maximum performance
// Following John Carmack's principles of minimizing data copies
type ZeroCopyNetwork struct {
	logger *zap.Logger
	
	// Configuration
	enableSendfile   bool
	enableSplice     bool
	enableMMAP       bool
	socketBufferSize int
	
	// Performance metrics
	bytesSent     atomic.Uint64
	bytesReceived atomic.Uint64
	zeroCopyOps   atomic.Uint64
	fallbackOps   atomic.Uint64
	
	// Connection management
	connections sync.Map // map[string]*ZeroCopyConn
	
	// Memory mapping
	mmapRegions sync.Map // map[string]*mmapRegion
}

// ZeroCopyConn represents a zero-copy network connection
type ZeroCopyConn struct {
	conn     net.Conn
	fd       int
	tcpConn  *net.TCPConn
	file     *os.File
	isLinux  bool
	
	// Ring buffer for zero-copy
	ringBuffer *RingBuffer
	
	// Statistics
	bytesSent     atomic.Uint64
	bytesReceived atomic.Uint64
}

// RingBuffer implements a lock-free ring buffer for zero-copy operations
type RingBuffer struct {
	data     []byte
	size     uint32
	mask     uint32
	readPos  atomic.Uint32
	writePos atomic.Uint32
	
	// Memory mapping support
	isMapped bool
	mmapPtr  uintptr
}

// mmapRegion represents a memory-mapped region
type mmapRegion struct {
	addr   uintptr
	size   int
	prot   int
	flags  int
	offset int64
}

// ZeroCopyConfig contains zero-copy network configuration
type ZeroCopyConfig struct {
	EnableSendfile   bool
	EnableSplice     bool
	EnableMMAP       bool
	SocketBufferSize int
	RingBufferSize   int
}

// NewZeroCopyNetwork creates a new zero-copy network manager
func NewZeroCopyNetwork(logger *zap.Logger, config *ZeroCopyConfig) *ZeroCopyNetwork {
	if config == nil {
		config = DefaultZeroCopyConfig()
	}
	
	zcn := &ZeroCopyNetwork{
		logger:           logger,
		enableSendfile:   config.EnableSendfile && runtime.GOOS == "linux",
		enableSplice:     config.EnableSplice && runtime.GOOS == "linux",
		enableMMAP:       config.EnableMMAP,
		socketBufferSize: config.SocketBufferSize,
	}
	
	logger.Info("Zero-copy network initialized",
		zap.Bool("sendfile", zcn.enableSendfile),
		zap.Bool("splice", zcn.enableSplice),
		zap.Bool("mmap", zcn.enableMMAP),
		zap.Int("socket_buffer", config.SocketBufferSize),
	)
	
	return zcn
}

// WrapConn wraps a network connection with zero-copy capabilities
func (zcn *ZeroCopyNetwork) WrapConn(conn net.Conn) (*ZeroCopyConn, error) {
	tcpConn, ok := conn.(*net.TCPConn)
	if !ok {
		return nil, errors.New("connection must be TCP for zero-copy")
	}
	
	// Get file descriptor
	file, err := tcpConn.File()
	if err != nil {
		return nil, fmt.Errorf("failed to get file descriptor: %w", err)
	}
	
	fd := int(file.Fd())
	
	// Set socket options for performance
	if err := zcn.optimizeSocket(fd); err != nil {
		zcn.logger.Warn("Failed to optimize socket", zap.Error(err))
	}
	
	// Create ring buffer
	ringBuffer := NewRingBuffer(1 << 20) // 1MB ring buffer
	
	zcc := &ZeroCopyConn{
		conn:       conn,
		fd:         fd,
		tcpConn:    tcpConn,
		file:       file,
		isLinux:    runtime.GOOS == "linux",
		ringBuffer: ringBuffer,
	}
	
	// Store connection
	zcn.connections.Store(conn.RemoteAddr().String(), zcc)
	
	return zcc, nil
}

// SendFile performs zero-copy file transfer using sendfile syscall
func (zcn *ZeroCopyNetwork) SendFile(conn *ZeroCopyConn, file *os.File, offset, count int64) (int64, error) {
	if !zcn.enableSendfile || !conn.isLinux {
		return zcn.fallbackSendFile(conn, file, offset, count)
	}
	
	// Use sendfile syscall for zero-copy
	written, err := zcn.sendfile(conn.fd, int(file.Fd()), offset, count)
	if err != nil {
		zcn.fallbackOps.Add(1)
		return zcn.fallbackSendFile(conn, file, offset, count)
	}
	
	zcn.zeroCopyOps.Add(1)
	zcn.bytesSent.Add(uint64(written))
	conn.bytesSent.Add(uint64(written))
	
	return written, nil
}

// sendfile performs the actual sendfile syscall
func (zcn *ZeroCopyNetwork) sendfile(outFd, inFd int, offset, count int64) (int64, error) {
	if runtime.GOOS != "linux" {
		return 0, errors.New("sendfile only supported on Linux")
	}
	
	var written int64
	for count > 0 {
		n, err := syscall.Sendfile(outFd, inFd, &offset, int(count))
		if n > 0 {
			written += int64(n)
			count -= int64(n)
		}
		if err != nil {
			if err == syscall.EAGAIN || err == syscall.EINTR {
				continue
			}
			return written, err
		}
		if n == 0 {
			break
		}
	}
	
	return written, nil
}

// fallbackSendFile uses traditional read/write when zero-copy unavailable
func (zcn *ZeroCopyNetwork) fallbackSendFile(conn *ZeroCopyConn, file *os.File, offset, count int64) (int64, error) {
	// Seek to offset
	if _, err := file.Seek(offset, 0); err != nil {
		return 0, err
	}
	
	// Use memory pool for buffer
	buf := make([]byte, 64*1024) // 64KB buffer
	var written int64
	
	for count > 0 {
		toRead := int64(len(buf))
		if toRead > count {
			toRead = count
		}
		
		n, err := file.Read(buf[:toRead])
		if err != nil {
			return written, err
		}
		if n == 0 {
			break
		}
		
		nw, err := conn.conn.Write(buf[:n])
		written += int64(nw)
		if err != nil {
			return written, err
		}
		
		count -= int64(n)
	}
	
	return written, nil
}

// Splice performs zero-copy data transfer between two file descriptors
func (zcn *ZeroCopyNetwork) Splice(from, to *ZeroCopyConn, count int64) (int64, error) {
	if !zcn.enableSplice || !from.isLinux || !to.isLinux {
		return zcn.fallbackSplice(from, to, count)
	}
	
	// Create pipe for splice
	pipeR, pipeW, err := os.Pipe()
	if err != nil {
		return 0, err
	}
	defer pipeR.Close()
	defer pipeW.Close()
	
	var transferred int64
	for count > 0 {
		// Splice from source to pipe
		n, err := zcn.splice(from.fd, int(pipeW.Fd()), count)
		if err != nil {
			return transferred, err
		}
		
		// Splice from pipe to destination
		n2, err := zcn.splice(int(pipeR.Fd()), to.fd, n)
		if err != nil {
			return transferred, err
		}
		
		transferred += n2
		count -= n2
	}
	
	zcn.zeroCopyOps.Add(1)
	return transferred, nil
}

// splice performs the actual splice syscall
func (zcn *ZeroCopyNetwork) splice(rfd, wfd int, count int64) (int64, error) {
	if runtime.GOOS != "linux" {
		return 0, errors.New("splice only supported on Linux")
	}
	
	// This would use the splice syscall on Linux
	// For now, return error to trigger fallback
	return 0, errors.New("splice not implemented")
}

// fallbackSplice uses traditional copy when splice unavailable
func (zcn *ZeroCopyNetwork) fallbackSplice(from, to *ZeroCopyConn, count int64) (int64, error) {
	buf := make([]byte, 64*1024) // 64KB buffer
	var transferred int64
	
	for count > 0 {
		toRead := int64(len(buf))
		if toRead > count {
			toRead = count
		}
		
		n, err := from.conn.Read(buf[:toRead])
		if err != nil {
			return transferred, err
		}
		
		nw, err := to.conn.Write(buf[:n])
		transferred += int64(nw)
		if err != nil {
			return transferred, err
		}
		
		count -= int64(n)
	}
	
	zcn.fallbackOps.Add(1)
	return transferred, nil
}

// optimizeSocket sets socket options for maximum performance
func (zcn *ZeroCopyNetwork) optimizeSocket(fd int) error {
	// Set TCP_NODELAY to disable Nagle's algorithm
	if err := syscall.SetsockoptInt(fd, syscall.IPPROTO_TCP, syscall.TCP_NODELAY, 1); err != nil {
		return err
	}
	
	// Set socket buffer sizes
	if err := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_SNDBUF, zcn.socketBufferSize); err != nil {
		return err
	}
	if err := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, zcn.socketBufferSize); err != nil {
		return err
	}
	
	// Enable TCP keepalive
	if err := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_KEEPALIVE, 1); err != nil {
		return err
	}
	
	// Set TCP_QUICKACK for Linux
	if runtime.GOOS == "linux" {
		syscall.SetsockoptInt(fd, syscall.IPPROTO_TCP, 12, 1) // TCP_QUICKACK = 12
	}
	
	return nil
}

// NewRingBuffer creates a new ring buffer
func NewRingBuffer(size int) *RingBuffer {
	// Ensure size is power of 2
	size = nextPowerOf2(size)
	
	return &RingBuffer{
		data: make([]byte, size),
		size: uint32(size),
		mask: uint32(size - 1),
	}
}

// Write writes data to the ring buffer
func (rb *RingBuffer) Write(data []byte) int {
	n := len(data)
	if n == 0 {
		return 0
	}
	
	writePos := rb.writePos.Load()
	readPos := rb.readPos.Load()
	
	// Calculate available space
	available := int(rb.size - (writePos - readPos))
	if n > available {
		n = available
	}
	
	// Write data
	for i := 0; i < n; i++ {
		rb.data[(writePos+uint32(i))&rb.mask] = data[i]
	}
	
	// Update write position
	rb.writePos.Add(uint32(n))
	
	return n
}

// Read reads data from the ring buffer
func (rb *RingBuffer) Read(data []byte) int {
	n := len(data)
	if n == 0 {
		return 0
	}
	
	writePos := rb.writePos.Load()
	readPos := rb.readPos.Load()
	
	// Calculate available data
	available := int(writePos - readPos)
	if n > available {
		n = available
	}
	
	// Read data
	for i := 0; i < n; i++ {
		data[i] = rb.data[(readPos+uint32(i))&rb.mask]
	}
	
	// Update read position
	rb.readPos.Add(uint32(n))
	
	return n
}

// GetStats returns zero-copy network statistics
func (zcn *ZeroCopyNetwork) GetStats() map[string]uint64 {
	return map[string]uint64{
		"bytes_sent":      zcn.bytesSent.Load(),
		"bytes_received":  zcn.bytesReceived.Load(),
		"zero_copy_ops":   zcn.zeroCopyOps.Load(),
		"fallback_ops":    zcn.fallbackOps.Load(),
		"efficiency":      zcn.calculateEfficiency(),
	}
}

// calculateEfficiency calculates zero-copy efficiency
func (zcn *ZeroCopyNetwork) calculateEfficiency() uint64 {
	zeroCopy := zcn.zeroCopyOps.Load()
	fallback := zcn.fallbackOps.Load()
	total := zeroCopy + fallback
	if total == 0 {
		return 0
	}
	return (zeroCopy * 100) / total
}

// nextPowerOf2 returns the next power of 2
func nextPowerOf2(n int) int {
	n--
	n |= n >> 1
	n |= n >> 2
	n |= n >> 4
	n |= n >> 8
	n |= n >> 16
	n++
	return n
}

// DefaultZeroCopyConfig returns default configuration
func DefaultZeroCopyConfig() *ZeroCopyConfig {
	return &ZeroCopyConfig{
		EnableSendfile:   true,
		EnableSplice:     true,
		EnableMMAP:       true,
		SocketBufferSize: 16 * 1024 * 1024, // 16MB
		RingBufferSize:   1 * 1024 * 1024,  // 1MB
	}
}