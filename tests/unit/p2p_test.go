package unit

import (
	"context"
	"testing"
	"time"

	"github.com/shizukutanaka/Otedama/internal/p2p"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestP2PPool_Creation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := p2p.Config{
		ListenAddr: ":0",
		MaxPeers:   10,
		MinPeers:   1,
	}

	pool, err := p2p.NewPool(config, logger)
	require.NoError(t, err)
	assert.NotNil(t, pool)
}

func TestP2PPool_StartStop(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := p2p.Config{
		ListenAddr: ":0",
		MaxPeers:   10,
		MinPeers:   1,
	}

	pool, err := p2p.NewPool(config, logger)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Start pool
	err = pool.Start(ctx)
	require.NoError(t, err)

	// Wait a bit
	time.Sleep(100 * time.Millisecond)

	// Stop pool
	err = pool.Stop()
	require.NoError(t, err)
}

func TestP2PPool_PeerManagement(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := p2p.Config{
		ListenAddr: ":0",
		MaxPeers:   5,
		MinPeers:   1,
	}

	pool, err := p2p.NewPool(config, logger)
	require.NoError(t, err)

	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(t, err)
	defer pool.Stop()

	// Test adding peer
	peer := &p2p.Peer{
		ID:      "test-peer-1",
		Address: "127.0.0.1:1234",
		Wallet:  "test-wallet",
	}

	// Simulate peer connection
	pool.AddPeer(peer)

	// Check peer count
	stats := pool.GetStats()
	assert.Equal(t, 1, stats.PeerCount)

	// Remove peer
	pool.RemovePeer(peer.ID)

	// Check peer count again
	stats = pool.GetStats()
	assert.Equal(t, 0, stats.PeerCount)
}

func TestP2PPool_ShareSubmission(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := p2p.Config{
		ListenAddr:      ":0",
		MaxPeers:        10,
		MinPeers:        1,
		ShareDifficulty: 1.0,
	}

	pool, err := p2p.NewPool(config, logger)
	require.NoError(t, err)

	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(t, err)
	defer pool.Stop()

	// Create a mock peer
	peer := &p2p.Peer{
		ID:      "test-miner",
		Address: "127.0.0.1:5678",
		Wallet:  "test-wallet",
	}
	pool.AddPeer(peer)

	// Submit a share
	share := &p2p.Share{
		ID:         "share-1",
		PeerID:     peer.ID,
		JobID:      "job-1",
		Nonce:      12345,
		Hash:       []byte("test-hash"),
		Difficulty: 1.0,
		Timestamp:  time.Now(),
	}

	err = pool.SubmitShare(share)
	require.NoError(t, err)

	// Check stats
	stats := pool.GetStats()
	assert.Equal(t, uint64(1), stats.TotalShares)
}

func TestP2PPool_ConnectionPool(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	// Test connection pool creation
	connPool := p2p.NewConnectionPool(logger, 5, 10)
	assert.NotNil(t, connPool)

	ctx := context.Background()
	
	// Test getting connection (will fail without actual server)
	conn, err := connPool.Get(ctx, "127.0.0.1:8080")
	assert.Error(t, err) // Expected to fail without server
	assert.Nil(t, conn)
}

func TestP2PPool_CircuitBreaker(t *testing.T) {
	cb := &p2p.CircuitBreaker{}

	// Initially should allow
	assert.True(t, cb.Allow())

	// Record failures
	for i := 0; i < 6; i++ {
		cb.RecordFailure()
	}

	// Should now be open
	assert.False(t, cb.Allow())

	// Record success shouldn't immediately close
	cb.RecordSuccess()
	assert.False(t, cb.Allow())
}

func TestP2PPool_LoadBalancer(t *testing.T) {
	logger := zaptest.NewLogger(t)
	lb := &p2p.LoadBalancer{
		logger: logger,
	}

	// Add some nodes
	nodes := []*p2p.NodeInfo{
		{Address: "node1:8080", Connections: atomic.Int32{}},
		{Address: "node2:8080", Connections: atomic.Int32{}},
		{Address: "node3:8080", Connections: atomic.Int32{}},
	}

	nodes[0].Connections.Store(5)
	nodes[1].Connections.Store(2)
	nodes[2].Connections.Store(8)

	for _, node := range nodes {
		lb.nodes.Store(node.Address, node)
	}

	// Select node should pick the one with least connections
	selected, err := lb.SelectNode()
	require.NoError(t, err)
	assert.Equal(t, "node2:8080", selected.Address)
}

func TestP2PPool_RateLimiter(t *testing.T) {
	rl := &p2p.RateLimiter{}

	peerID := "test-peer"

	// Should allow initially
	assert.True(t, rl.Allow(peerID))

	// Should continue to allow within limits
	for i := 0; i < 50; i++ {
		assert.True(t, rl.Allow(peerID))
	}

	// Note: Full rate limiting test would require time-based testing
}

// Benchmark tests

func BenchmarkP2PPool_ShareSubmission(b *testing.B) {
	logger := zaptest.NewLogger(b)
	config := p2p.Config{
		ListenAddr:      ":0",
		MaxPeers:        100,
		MinPeers:        1,
		ShareDifficulty: 1.0,
	}

	pool, err := p2p.NewPool(config, logger)
	require.NoError(b, err)

	ctx := context.Background()
	err = pool.Start(ctx)
	require.NoError(b, err)
	defer pool.Stop()

	// Add a peer
	peer := &p2p.Peer{
		ID:      "bench-miner",
		Address: "127.0.0.1:9999",
		Wallet:  "bench-wallet",
	}
	pool.AddPeer(peer)

	b.ResetTimer()

	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			share := &p2p.Share{
				ID:         fmt.Sprintf("share-%d", i),
				PeerID:     peer.ID,
				JobID:      "job-1",
				Nonce:      uint64(i),
				Hash:       []byte("test-hash"),
				Difficulty: 1.0,
				Timestamp:  time.Now(),
			}
			pool.SubmitShare(share)
			i++
		}
	})
}

func BenchmarkP2PPool_ConnectionPool(b *testing.B) {
	logger := zaptest.NewLogger(b)
	connPool := p2p.NewConnectionPool(logger, 10, 100)

	ctx := context.Background()

	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			// Simulate connection get/put
			conn, _ := connPool.Get(ctx, "127.0.0.1:8080")
			if conn != nil {
				connPool.Put(conn)
			}
		}
	})
}