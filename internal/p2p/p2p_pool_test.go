package p2p

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

// TestPoolCreation tests basic pool creation
func TestPoolCreation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: "127.0.0.1:0", // random port
		MaxPeers:   10,
		MinPeers:   2,
		Algorithm:  "sha256d",
	}

	pool, err := NewPool(logger, config)
	require.NoError(t, err)
	require.NotNil(t, pool)

	assert.Equal(t, config.MaxPeers, pool.config.MaxPeers)
	assert.NotEmpty(t, pool.nodeID)
}

// TestPoolLifecycle tests pool start and stop
func TestPoolLifecycle(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr:        "127.0.0.1:0",
		MaxPeers:          5,
		ConnectionTimeout: 5 * time.Second,
	}

	pool, err := NewPool(logger, config)
	require.NoError(t, err)

	// Start pool
	err = pool.Start()
	assert.NoError(t, err)
	assert.Equal(t, int32(1), pool.running.Load())

	// Verify listener is active
	assert.NotNil(t, pool.listener)
	addr := pool.listener.Addr()
	assert.NotEmpty(t, addr.String())

	// Stop pool
	err = pool.Stop()
	assert.NoError(t, err)
	assert.Equal(t, int32(0), pool.running.Load())
}

// TestPeerManagement tests adding and removing peers
func TestPeerManagement(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr: "127.0.0.1:0",
		MaxPeers:   3,
	}

	pool, err := NewPool(logger, config)
	require.NoError(t, err)

	// Create mock peers
	peer1 := &Peer{
		ID:      "peer1",
		Address: "192.168.1.1:3333",
		Wallet:  "wallet1",
	}

	peer2 := &Peer{
		ID:      "peer2",
		Address: "192.168.1.2:3333",
		Wallet:  "wallet2",
	}

	// Add peers
	pool.peers.Store(peer1.ID, peer1)
	pool.peerCount.Add(1)

	pool.peers.Store(peer2.ID, peer2)
	pool.peerCount.Add(1)

	assert.Equal(t, int32(2), pool.peerCount.Load())

	// Check peer retrieval
	p, ok := pool.peers.Load(peer1.ID)
	assert.True(t, ok)
	assert.Equal(t, peer1.ID, p.(*Peer).ID)

	// Remove peer
	pool.peers.Delete(peer1.ID)
	pool.peerCount.Add(-1)

	assert.Equal(t, int32(1), pool.peerCount.Load())
	_, ok = pool.peers.Load(peer1.ID)
	assert.False(t, ok)
}

// TestShareSubmission tests share submission and validation
func TestShareSubmission(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := Config{
		ListenAddr:      "127.0.0.1:0",
		ShareDifficulty: 1.0,
	}

	pool, err := NewPool(logger, config)
	require.NoError(t, err)

	// Create test share
	share := &Share{
		ID:         "share1",
		PeerID:     "peer1",
		JobID:      "job1",
		Nonce:      12345,
		Hash:       []byte{0x01, 0x02, 0x03},
		Difficulty: 1.5,
		Timestamp:  time.Now(),
		Valid:      true,
	}

	// Submit share
	pool.shares.Store(share.ID, share)
	pool.totalShares.Add(1)
	if share.Valid {
		pool.validShares.Add(1)
	}

	// Verify stats
	assert.Equal(t, uint64(1), pool.totalShares.Load())
	assert.Equal(t, uint64(1), pool.validShares.Load())

	// Check share retrieval
	s, ok := pool.shares.Load(share.ID)
	assert.True(t, ok)
	assert.Equal(t, share.ID, s.(*Share).ID)
}

// TestRateLimiting tests rate limiting functionality
func TestRateLimiting(t *testing.T) {
	limiter := NewRateLimiter(10, 20) // 10 req/s, burst 20

	// Should allow initial burst
	for i := 0; i < 20; i++ {
		allowed := limiter.Allow()
		assert.True(t, allowed, "burst request %d should be allowed", i)
	}

	// Next request should be rate limited
	allowed := limiter.Allow()
	assert.False(t, allowed, "request beyond burst should be limited")

	// Wait for token replenishment
	time.Sleep(100 * time.Millisecond)
	allowed = limiter.Allow()
	assert.True(t, allowed, "request after wait should be allowed")
}

// TestCircuitBreaker tests circuit breaker functionality
func TestCircuitBreaker(t *testing.T) {
	cb := NewCircuitBreaker(3, 1*time.Second)

	// Record failures
	for i := 0; i < 3; i++ {
		cb.RecordFailure()
	}

	// Circuit should be open
	assert.False(t, cb.Allow(), "circuit should be open after failures")

	// Wait for timeout
	time.Sleep(1100 * time.Millisecond)

	// Circuit should be half-open
	assert.True(t, cb.Allow(), "circuit should be half-open after timeout")

	// Record success
	cb.RecordSuccess()

	// Circuit should be closed
	assert.True(t, cb.Allow(), "circuit should be closed after success")
}

// TestConnectionPooling tests connection pool functionality
func TestConnectionPooling(t *testing.T) {
	pool := NewConnectionPool(3, 30*time.Second)

	// Create mock connections
	conn1 := &mockConn{id: "conn1"}
	conn2 := &mockConn{id: "conn2"}

	// Add connections
	pool.Add("peer1", conn1)
	pool.Add("peer2", conn2)

	// Get connection
	conn, ok := pool.Get("peer1")
	assert.True(t, ok)
	assert.Equal(t, "conn1", conn.(*mockConn).id)

	// Remove connection
	pool.Remove("peer1")
	_, ok = pool.Get("peer1")
	assert.False(t, ok)
}

// TestPeerReputation tests reputation system
func TestPeerReputation(t *testing.T) {
	rep := NewReputationSystem()

	// Initialize peer reputations
	rep.Initialize("peer1", 100)
	rep.Initialize("peer2", 100)

	// Update reputations
	rep.UpdateReputation("peer1", 10)  // good behavior
	rep.UpdateReputation("peer2", -20) // bad behavior

	// Check reputations
	assert.Equal(t, 110, rep.GetReputation("peer1"))
	assert.Equal(t, 80, rep.GetReputation("peer2"))

	// Check if peer is trusted
	assert.True(t, rep.IsTrusted("peer1", 100))
	assert.False(t, rep.IsTrusted("peer2", 90))
}

// TestShareCaching tests share cache functionality
func TestShareCaching(t *testing.T) {
	cache := NewShareCache(100, 5*time.Minute)

	share := &Share{
		ID:     "share1",
		PeerID: "peer1",
		Hash:   []byte{0x01, 0x02, 0x03},
	}

	// Add to cache
	cache.Add(share)

	// Check if exists
	assert.True(t, cache.Contains(share.ID))

	// Get from cache
	cached, ok := cache.Get(share.ID)
	assert.True(t, ok)
	assert.Equal(t, share.ID, cached.ID)

	// Remove from cache
	cache.Remove(share.ID)
	assert.False(t, cache.Contains(share.ID))
}

// BenchmarkShareSubmission benchmarks share submission performance
func BenchmarkShareSubmission(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := Config{
		ListenAddr: "127.0.0.1:0",
	}

	pool, err := NewPool(logger, config)
	require.NoError(b, err)

	share := &Share{
		ID:     "bench-share",
		PeerID: "bench-peer",
		Valid:  true,
	}

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			shareID := fmt.Sprintf("%s-%d", share.ID, i)
			pool.shares.Store(shareID, share)
			pool.totalShares.Add(1)
			i++
		}
	})
}

// mockConn is a mock connection for testing
type mockConn struct {
	id string
	net.Conn
}

func (m *mockConn) Close() error {
	return nil
}