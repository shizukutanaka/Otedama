package network

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// ConnectionPool provides a simple and efficient connection pool
// Following John Carmack's approach: optimize for the common case
type ConnectionPool struct {
	// Configuration
	address     string
	maxConns    int
	minConns    int
	dialTimeout time.Duration
	idleTimeout time.Duration
	
	// Pool state
	conns     chan *poolConn
	numOpen   atomic.Int32
	numIdle   atomic.Int32
	closed    atomic.Bool
	
	// Synchronization
	mu      sync.Mutex
	factory func() (net.Conn, error)
}

// poolConn wraps a connection with metadata
type poolConn struct {
	conn      net.Conn
	createdAt time.Time
	lastUsed  time.Time
	pool      *ConnectionPool
}

// NewConnectionPool creates a new connection pool
func NewConnectionPool(address string, minConns, maxConns int) *ConnectionPool {
	if minConns < 1 {
		minConns = 1
	}
	if maxConns < minConns {
		maxConns = minConns * 2
	}
	
	pool := &ConnectionPool{
		address:     address,
		minConns:    minConns,
		maxConns:    maxConns,
		dialTimeout: 30 * time.Second,
		idleTimeout: 5 * time.Minute,
		conns:       make(chan *poolConn, maxConns),
	}
	
	// Default factory for TCP connections
	pool.factory = func() (net.Conn, error) {
		return net.DialTimeout("tcp", address, pool.dialTimeout)
	}
	
	// Initialize minimum connections
	for i := 0; i < minConns; i++ {
		conn, err := pool.createConn()
		if err == nil {
			pool.conns <- conn
			pool.numIdle.Add(1)
		}
	}
	
	// Start cleaner
	go pool.cleaner()
	
	return pool
}

// Get retrieves a connection from the pool
func (pool *ConnectionPool) Get(ctx context.Context) (net.Conn, error) {
	if pool.closed.Load() {
		return nil, errors.New("pool is closed")
	}
	
	// Try to get from pool
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case conn := <-pool.conns:
		pool.numIdle.Add(-1)
		
		// Check if connection is still alive
		if pool.isAlive(conn) {
			conn.lastUsed = time.Now()
			return &wrappedConn{poolConn: conn}, nil
		}
		
		// Connection is dead, close it
		conn.conn.Close()
		pool.numOpen.Add(-1)
		
		// Fall through to create new connection
	default:
		// No idle connections available
	}
	
	// Create new connection if under limit
	if int(pool.numOpen.Load()) < pool.maxConns {
		conn, err := pool.createConn()
		if err != nil {
			return nil, err
		}
		return &wrappedConn{poolConn: conn}, nil
	}
	
	// Wait for available connection
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case conn := <-pool.conns:
		pool.numIdle.Add(-1)
		conn.lastUsed = time.Now()
		return &wrappedConn{poolConn: conn}, nil
	}
}

// Put returns a connection to the pool
func (pool *ConnectionPool) Put(conn net.Conn) error {
	if pool.closed.Load() {
		return conn.Close()
	}
	
	wc, ok := conn.(*wrappedConn)
	if !ok {
		return errors.New("invalid connection type")
	}
	
	// Don't return bad connections to pool
	if wc.err != nil {
		pool.numOpen.Add(-1)
		return wc.poolConn.conn.Close()
	}
	
	// Try to return to pool
	select {
	case pool.conns <- wc.poolConn:
		pool.numIdle.Add(1)
		return nil
	default:
		// Pool is full, close connection
		pool.numOpen.Add(-1)
		return wc.poolConn.conn.Close()
	}
}

// Close closes the pool
func (pool *ConnectionPool) Close() error {
	if !pool.closed.CompareAndSwap(false, true) {
		return nil
	}
	
	close(pool.conns)
	
	// Close all connections
	for conn := range pool.conns {
		conn.conn.Close()
	}
	
	return nil
}

// Stats returns pool statistics
func (pool *ConnectionPool) Stats() PoolStats {
	return PoolStats{
		Open:    int(pool.numOpen.Load()),
		Idle:    int(pool.numIdle.Load()),
		MaxOpen: pool.maxConns,
	}
}

// Private methods

func (pool *ConnectionPool) createConn() (*poolConn, error) {
	conn, err := pool.factory()
	if err != nil {
		return nil, err
	}
	
	pool.numOpen.Add(1)
	
	return &poolConn{
		conn:      conn,
		createdAt: time.Now(),
		lastUsed:  time.Now(),
		pool:      pool,
	}, nil
}

func (pool *ConnectionPool) isAlive(pc *poolConn) bool {
	// Check idle timeout
	if time.Since(pc.lastUsed) > pool.idleTimeout {
		return false
	}
	
	// Quick check if connection is still valid
	// Set a very short deadline for the check
	pc.conn.SetReadDeadline(time.Now().Add(1 * time.Millisecond))
	defer pc.conn.SetReadDeadline(time.Time{})
	
	// Try to read 0 bytes - this will fail if connection is closed
	buf := make([]byte, 0)
	_, err := pc.conn.Read(buf)
	
	// If we get a timeout, the connection is still alive
	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return true
	}
	
	return err == nil
}

func (pool *ConnectionPool) cleaner() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case <-ticker.C:
			if pool.closed.Load() {
				return
			}
			
			// Clean up idle connections
			pool.cleanIdleConns()
		}
	}
}

func (pool *ConnectionPool) cleanIdleConns() {
	// Get current number of idle connections
	idle := int(pool.numIdle.Load())
	
	// Keep at least minConns
	toRemove := idle - pool.minConns
	if toRemove <= 0 {
		return
	}
	
	removed := 0
	for i := 0; i < idle && removed < toRemove; i++ {
		select {
		case conn := <-pool.conns:
			if time.Since(conn.lastUsed) > pool.idleTimeout {
				conn.conn.Close()
				pool.numOpen.Add(-1)
				pool.numIdle.Add(-1)
				removed++
			} else {
				// Put it back
				pool.conns <- conn
			}
		default:
			return
		}
	}
}

// wrappedConn wraps a pooled connection
type wrappedConn struct {
	*poolConn
	err error
}

func (wc *wrappedConn) Read(b []byte) (n int, err error) {
	n, err = wc.conn.Read(b)
	if err != nil && !isTemporary(err) {
		wc.err = err
	}
	return
}

func (wc *wrappedConn) Write(b []byte) (n int, err error) {
	n, err = wc.conn.Write(b)
	if err != nil && !isTemporary(err) {
		wc.err = err
	}
	return
}

func (wc *wrappedConn) Close() error {
	return wc.pool.Put(wc)
}

func (wc *wrappedConn) LocalAddr() net.Addr {
	return wc.conn.LocalAddr()
}

func (wc *wrappedConn) RemoteAddr() net.Addr {
	return wc.conn.RemoteAddr()
}

func (wc *wrappedConn) SetDeadline(t time.Time) error {
	return wc.conn.SetDeadline(t)
}

func (wc *wrappedConn) SetReadDeadline(t time.Time) error {
	return wc.conn.SetReadDeadline(t)
}

func (wc *wrappedConn) SetWriteDeadline(t time.Time) error {
	return wc.conn.SetWriteDeadline(t)
}

// PoolStats contains pool statistics
type PoolStats struct {
	Open    int
	Idle    int
	MaxOpen int
}

// isTemporary checks if an error is temporary
func isTemporary(err error) bool {
	if netErr, ok := err.(net.Error); ok {
		return netErr.Temporary()
	}
	return false
}

// StratumConnectionPool is a specialized pool for Stratum connections
type StratumConnectionPool struct {
	*ConnectionPool
	
	// Stratum-specific configuration
	workerName string
	password   string
}

// NewStratumConnectionPool creates a new Stratum connection pool
func NewStratumConnectionPool(address, workerName, password string) *StratumConnectionPool {
	pool := &StratumConnectionPool{
		ConnectionPool: NewConnectionPool(address, 2, 10),
		workerName:     workerName,
		password:       password,
	}
	
	// Override factory to handle Stratum handshake
	pool.factory = pool.createStratumConn
	
	return pool
}

func (scp *StratumConnectionPool) createStratumConn() (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", scp.address, scp.dialTimeout)
	if err != nil {
		return nil, err
	}
	
	// TODO: Perform Stratum handshake here
	// For now, just return the connection
	
	return conn, nil
}