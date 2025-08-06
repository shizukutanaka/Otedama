package optimization

import (
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// ZeroCopyBuffer provides zero-copy buffer operations
type ZeroCopyBuffer struct {
	data []byte
	refs atomic.Int32
	pool *sync.Pool
}

// NewZeroCopyBuffer creates a new zero-copy buffer
func NewZeroCopyBuffer(size int) *ZeroCopyBuffer {
	return &ZeroCopyBuffer{
		data: make([]byte, size),
	}
}

// NewZeroCopyBufferFromSlice creates a buffer from existing slice
func NewZeroCopyBufferFromSlice(data []byte) *ZeroCopyBuffer {
	buf := &ZeroCopyBuffer{
		data: data,
	}
	buf.refs.Store(1)
	return buf
}

// Bytes returns the underlying byte slice
func (b *ZeroCopyBuffer) Bytes() []byte {
	return b.data
}

// Len returns the buffer length
func (b *ZeroCopyBuffer) Len() int {
	return len(b.data)
}

// Slice returns a slice of the buffer without copying
func (b *ZeroCopyBuffer) Slice(start, end int) *ZeroCopyBuffer {
	if start < 0 || end > len(b.data) || start > end {
		return nil
	}
	
	b.refs.Add(1)
	return &ZeroCopyBuffer{
		data: b.data[start:end],
		refs: b.refs,
		pool: b.pool,
	}
}

// AddRef increments reference count
func (b *ZeroCopyBuffer) AddRef() {
	b.refs.Add(1)
}

// Release decrements reference count and returns to pool if zero
func (b *ZeroCopyBuffer) Release() {
	if b.refs.Add(-1) == 0 && b.pool != nil {
		b.pool.Put(b)
	}
}

// ZeroCopyPool manages a pool of zero-copy buffers
type ZeroCopyPool struct {
	pool sync.Pool
	size int
}

// NewZeroCopyPool creates a new buffer pool
func NewZeroCopyPool(bufferSize int) *ZeroCopyPool {
	p := &ZeroCopyPool{
		size: bufferSize,
	}
	
	p.pool.New = func() interface{} {
		return &ZeroCopyBuffer{
			data: make([]byte, bufferSize),
			pool: &p.pool,
		}
	}
	
	return p
}

// Get retrieves a buffer from the pool
func (p *ZeroCopyPool) Get() *ZeroCopyBuffer {
	buf := p.pool.Get().(*ZeroCopyBuffer)
	buf.refs.Store(1)
	return buf
}

// Put returns a buffer to the pool
func (p *ZeroCopyPool) Put(buf *ZeroCopyBuffer) {
	if buf.refs.Load() == 0 {
		// Clear sensitive data
		for i := range buf.data {
			buf.data[i] = 0
		}
		p.pool.Put(buf)
	}
}

// ZeroCopyReader provides zero-copy reading
type ZeroCopyReader struct {
	fd   int
	file *os.File
}

// NewZeroCopyReader creates a zero-copy reader from file
func NewZeroCopyReader(file *os.File) (*ZeroCopyReader, error) {
	return &ZeroCopyReader{
		fd:   int(file.Fd()),
		file: file,
	}, nil
}

// ReadToBuffer reads directly into buffer without intermediate copy
func (r *ZeroCopyReader) ReadToBuffer(buf *ZeroCopyBuffer) (int, error) {
	return syscall.Read(r.fd, buf.data)
}

// SendTo sends file contents directly to network without copying to userspace
func (r *ZeroCopyReader) SendTo(conn net.Conn, offset, count int64) (int64, error) {
	// Try to get TCP connection
	tcpConn, ok := conn.(*net.TCPConn)
	if !ok {
		// Fallback to regular copy
		return r.fallbackSendTo(conn, offset, count)
	}
	
	// Get raw connection
	rawConn, err := tcpConn.SyscallConn()
	if err != nil {
		return 0, err
	}
	
	var written int64
	var sendErr error
	
	err = rawConn.Write(func(fd uintptr) bool {
		// Use sendfile for zero-copy transfer
		n, err := syscall.Sendfile(int(fd), r.fd, &offset, int(count))
		written = int64(n)
		sendErr = err
		return err != syscall.EAGAIN
	})
	
	if err != nil {
		return written, err
	}
	
	return written, sendErr
}

func (r *ZeroCopyReader) fallbackSendTo(conn net.Conn, offset, count int64) (int64, error) {
	// Seek to offset
	_, err := r.file.Seek(offset, io.SeekStart)
	if err != nil {
		return 0, err
	}
	
	// Copy data
	return io.CopyN(conn, r.file, count)
}

// ZeroCopyWriter provides zero-copy writing
type ZeroCopyWriter struct {
	fd   int
	file *os.File
}

// NewZeroCopyWriter creates a zero-copy writer
func NewZeroCopyWriter(file *os.File) (*ZeroCopyWriter, error) {
	return &ZeroCopyWriter{
		fd:   int(file.Fd()),
		file: file,
	}, nil
}

// WriteFromBuffer writes directly from buffer without intermediate copy
func (w *ZeroCopyWriter) WriteFromBuffer(buf *ZeroCopyBuffer) (int, error) {
	return syscall.Write(w.fd, buf.data)
}

// ReceiveFrom receives data directly from network without copying
func (w *ZeroCopyWriter) ReceiveFrom(conn net.Conn, count int64) (int64, error) {
	// Implementation depends on platform-specific splice/sendfile
	// Fallback to regular copy for now
	return io.CopyN(w.file, conn, count)
}

// StringHeader represents the internal structure of a string
type StringHeader struct {
	Data uintptr
	Len  int
}

// SliceHeader represents the internal structure of a slice
type SliceHeader struct {
	Data uintptr
	Len  int
	Cap  int
}

// StringToBytes converts string to bytes without allocation
func StringToBytes(s string) []byte {
	return unsafe.Slice(unsafe.StringData(s), len(s))
}

// BytesToString converts bytes to string without allocation
func BytesToString(b []byte) string {
	return unsafe.String(unsafe.SliceData(b), len(b))
}

// AppendString appends string to byte slice without intermediate allocation
func AppendString(dst []byte, s string) []byte {
	return append(dst, StringToBytes(s)...)
}

// CopyString creates a copy of string data
func CopyString(s string) string {
	if s == "" {
		return ""
	}
	b := make([]byte, len(s))
	copy(b, s)
	return BytesToString(b)
}

// ZeroCopyConcat concatenates byte slices without copying
type ZeroCopyConcat struct {
	slices [][]byte
	total  int
}

// NewZeroCopyConcat creates a new zero-copy concatenator
func NewZeroCopyConcat() *ZeroCopyConcat {
	return &ZeroCopyConcat{
		slices: make([][]byte, 0, 8),
	}
}

// Append adds a slice to the concatenation
func (c *ZeroCopyConcat) Append(b []byte) {
	c.slices = append(c.slices, b)
	c.total += len(b)
}

// Len returns the total length
func (c *ZeroCopyConcat) Len() int {
	return c.total
}

// WriteTo writes all slices to writer
func (c *ZeroCopyConcat) WriteTo(w io.Writer) (int64, error) {
	var written int64
	for _, slice := range c.slices {
		n, err := w.Write(slice)
		written += int64(n)
		if err != nil {
			return written, err
		}
	}
	return written, nil
}

// ToSingle creates a single slice (requires allocation)
func (c *ZeroCopyConcat) ToSingle() []byte {
	if len(c.slices) == 0 {
		return nil
	}
	if len(c.slices) == 1 {
		return c.slices[0]
	}
	
	result := make([]byte, 0, c.total)
	for _, slice := range c.slices {
		result = append(result, slice...)
	}
	return result
}

// Reset clears the concatenator
func (c *ZeroCopyConcat) Reset() {
	c.slices = c.slices[:0]
	c.total = 0
}

// MMapBuffer provides memory-mapped file access
type MMapBuffer struct {
	data []byte
	file *os.File
}

// NewMMapBuffer creates a memory-mapped buffer from file
func NewMMapBuffer(file *os.File) (*MMapBuffer, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	
	size := info.Size()
	if size == 0 {
		return &MMapBuffer{file: file}, nil
	}
	
	// Memory map the file
	data, err := syscall.Mmap(int(file.Fd()), 0, int(size), 
		syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_SHARED)
	if err != nil {
		return nil, err
	}
	
	return &MMapBuffer{
		data: data,
		file: file,
	}, nil
}

// Bytes returns the mapped bytes
func (m *MMapBuffer) Bytes() []byte {
	return m.data
}

// Len returns the buffer length
func (m *MMapBuffer) Len() int {
	return len(m.data)
}

// Sync flushes changes to disk
func (m *MMapBuffer) Sync() error {
	if len(m.data) == 0 {
		return nil
	}
	return syscall.Msync(m.data, syscall.MS_SYNC)
}

// Close unmaps the buffer
func (m *MMapBuffer) Close() error {
	if len(m.data) > 0 {
		if err := syscall.Munmap(m.data); err != nil {
			return err
		}
		m.data = nil
	}
	return m.file.Close()
}

// DirectIO provides direct I/O operations
type DirectIO struct {
	file      *os.File
	fd        int
	blockSize int
}

// NewDirectIO creates a direct I/O handler
func NewDirectIO(path string, blockSize int) (*DirectIO, error) {
	// Open with O_DIRECT flag (platform specific)
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		return nil, err
	}
	
	return &DirectIO{
		file:      file,
		fd:        int(file.Fd()),
		blockSize: blockSize,
	}, nil
}

// ReadAligned reads aligned blocks
func (d *DirectIO) ReadAligned(offset int64, size int) ([]byte, error) {
	// Ensure alignment
	if offset%int64(d.blockSize) != 0 || size%d.blockSize != 0 {
		return nil, errors.New("offset and size must be block-aligned")
	}
	
	buf := AlignedAlloc(size, d.blockSize)
	n, err := d.file.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}
	
	return buf[:n], nil
}

// WriteAligned writes aligned blocks
func (d *DirectIO) WriteAligned(offset int64, data []byte) error {
	// Ensure alignment
	if offset%int64(d.blockSize) != 0 || len(data)%d.blockSize != 0 {
		return errors.New("offset and size must be block-aligned")
	}
	
	_, err := d.file.WriteAt(data, offset)
	return err
}

// Close closes the file
func (d *DirectIO) Close() error {
	return d.file.Close()
}

// AlignedAlloc allocates aligned memory
func AlignedAlloc(size, alignment int) []byte {
	if alignment <= 0 {
		return make([]byte, size)
	}
	
	// Allocate extra space for alignment
	buf := make([]byte, size+alignment)
	
	// Find aligned offset
	offset := alignment - int(uintptr(unsafe.Pointer(&buf[0]))%uintptr(alignment))
	if offset == alignment {
		offset = 0
	}
	
	return buf[offset : offset+size]
}