package p2p

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

// TestNewNetwork tests network creation
func TestNewNetwork(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	t.Run("DefaultConfig", func(t *testing.T) {
		network, err := NewNetwork(logger, nil)
		assert.NoError(t, err)
		assert.NotNil(t, network)
		
		// Check default values
		p2p := network.(*UnifiedP2PNetwork)
		assert.Equal(t, 30303, p2p.config.Port)
		assert.Equal(t, 1000, p2p.config.MaxPeers)
		assert.True(t, p2p.config.DDoSProtection)
	})
	
	t.Run("CustomConfig", func(t *testing.T) {
		config := &Config{
			Port:           9999,
			MaxPeers:       50,
			DDoSProtection: false,
			RateLimit:      500,
		}
		
		network, err := NewNetwork(logger, config)
		assert.NoError(t, err)
		assert.NotNil(t, network)
		
		p2p := network.(*UnifiedP2PNetwork)
		assert.Equal(t, 9999, p2p.config.Port)
		assert.Equal(t, 50, p2p.config.MaxPeers)
		assert.False(t, p2p.config.DDoSProtection)
	})
	
	t.Run("InvalidConfig", func(t *testing.T) {
		config := &Config{
			Port:     999, // Invalid port
			MaxPeers: 5,   // Too few peers
		}
		
		network, err := NewNetwork(logger, config)
		assert.Error(t, err)
		assert.Nil(t, network)
	})
}

// TestNetworkStartStop tests network lifecycle
func TestNetworkStartStop(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	// Use random port to avoid conflicts
	config := &Config{
		Port:     0, // Let OS assign port
		MaxPeers: 10,
	}
	
	network, err := NewNetwork(logger, config)
	require.NoError(t, err)
	
	t.Run("Start", func(t *testing.T) {
		err := network.Start()
		assert.NoError(t, err)
		
		// Give time for initialization
		time.Sleep(100 * time.Millisecond)
		
		// Check network is running
		p2p := network.(*UnifiedP2PNetwork)
		assert.True(t, p2p.running.Load())
		assert.NotNil(t, p2p.listener)
	})
	
	t.Run("StartAgain", func(t *testing.T) {
		// Starting again should error
		err := network.Start()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "already running")
	})
	
	t.Run("Stop", func(t *testing.T) {
		err := network.Stop()
		assert.NoError(t, err)
		
		// Check network is stopped
		p2p := network.(*UnifiedP2PNetwork)
		assert.False(t, p2p.running.Load())
	})
	
	t.Run("StopAgain", func(t *testing.T) {
		// Stopping again should error
		err := network.Stop()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "not running")
	})
}

// TestPeerManagement tests peer operations
func TestPeerManagement(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	network, err := NewNetwork(logger, nil)
	require.NoError(t, err)
	
	p2p := network.(*UnifiedP2PNetwork)
	
	t.Run("AddPeer", func(t *testing.T) {
		peer := &Peer{
			ID:       "test_peer_1",
			Address:  "127.0.0.1",
			Port:     30303,
			NodeType: NodeTypeMiner,
		}
		peer.Connected.Store(true)
		
		p2p.addPeer(peer)
		
		// Check peer was added
		assert.Equal(t, int32(1), p2p.peerCount.Load())
		
		// Get peers
		peers := network.GetPeers(10)
		assert.Len(t, peers, 1)
		assert.Equal(t, "test_peer_1", peers[0].ID)
	})
	
	t.Run("RemovePeer", func(t *testing.T) {
		p2p.removePeer("test_peer_1")
		
		// Check peer was removed
		assert.Equal(t, int32(0), p2p.peerCount.Load())
		
		peers := network.GetPeers(10)
		assert.Len(t, peers, 0)
	})
	
	t.Run("MaxPeers", func(t *testing.T) {
		// Set low max peers
		p2p.config.MaxPeers = 2
		
		// Add peers up to limit
		for i := 0; i < 3; i++ {
			peer := &Peer{
				ID:      fmt.Sprintf("peer_%d", i),
				Address: "127.0.0.1",
				Port:    30303 + i,
			}
			peer.Connected.Store(true)
			p2p.addPeer(peer)
		}
		
		// Should only have 2 peers
		assert.Equal(t, int32(2), p2p.peerCount.Load())
	})
}

// TestMessageHandling tests message sending and receiving
func TestMessageHandling(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	network, err := NewNetwork(logger, nil)
	require.NoError(t, err)
	
	p2p := network.(*UnifiedP2PNetwork)
	
	// Start network
	require.NoError(t, network.Start())
	defer network.Stop()
	
	t.Run("Broadcast", func(t *testing.T) {
		msg := Message{
			Type: MessageTypeBlock,
			Data: []byte("test block data"),
		}
		
		err := network.Broadcast(msg)
		assert.NoError(t, err)
		
		// Message should be queued
		select {
		case broadcastMsg := <-p2p.broadcast:
			assert.Equal(t, MessageTypeBlock, broadcastMsg.Type)
			assert.Equal(t, p2p.nodeID, broadcastMsg.From)
			assert.NotZero(t, broadcastMsg.Timestamp)
		case <-time.After(time.Second):
			t.Fatal("Broadcast message not received")
		}
	})
	
	t.Run("MessageTypes", func(t *testing.T) {
		// Test different message types
		types := []MessageType{
			MessageTypePing,
			MessageTypePong,
			MessageTypeGetPeers,
			MessageTypePeers,
			MessageTypeJob,
			MessageTypeShare,
			MessageTypeBlock,
		}
		
		for _, msgType := range types {
			msg := Message{
				Type: msgType,
				From: "test_peer",
				Data: []byte("test"),
			}
			
			// Process message
			p2p.processInboundMessage(&msg)
			// Should not panic
		}
	})
}

// TestDHTOperations tests DHT functionality
func TestDHTOperations(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	nodeID := "test_node_123"
	dht, err := NewDHT(logger, nodeID)
	require.NoError(t, err)
	require.NotNil(t, dht)
	
	t.Run("StoreRetrieve", func(t *testing.T) {
		key := "test_key"
		value := []byte("test_value")
		
		// Store value
		err := dht.Store(key, value)
		assert.NoError(t, err)
		
		// Retrieve value
		retrieved, found := dht.Get(key)
		assert.True(t, found)
		assert.Equal(t, value, retrieved)
	})
	
	t.Run("FindNode", func(t *testing.T) {
		// Add some peers to buckets
		for i := 0; i < 5; i++ {
			peer := &Peer{
				ID:      fmt.Sprintf("peer_%d", i),
				Address: fmt.Sprintf("192.168.1.%d", i),
				Port:    30303,
			}
			dht.AddPeer(peer)
		}
		
		// Find closest nodes
		closest := dht.FindClosest("target_node", 3)
		assert.LessOrEqual(t, len(closest), 3)
	})
}

// TestRateLimiter tests rate limiting
func TestRateLimiter(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	limiter := NewRateLimiter(logger, 10) // 10 requests per second
	
	t.Run("AllowedRequests", func(t *testing.T) {
		ip := "192.168.1.1"
		
		// First 10 requests should be allowed
		for i := 0; i < 10; i++ {
			assert.True(t, limiter.Allow(ip))
		}
	})
	
	t.Run("BlockedRequests", func(t *testing.T) {
		ip := "192.168.1.2"
		
		// Exhaust rate limit
		for i := 0; i < 10; i++ {
			limiter.Allow(ip)
		}
		
		// Next request should be blocked
		assert.False(t, limiter.Allow(ip))
	})
	
	t.Run("MultipleIPs", func(t *testing.T) {
		// Different IPs should have separate limits
		ip1 := "192.168.1.3"
		ip2 := "192.168.1.4"
		
		// Use all tokens for ip1
		for i := 0; i < 10; i++ {
			limiter.Allow(ip1)
		}
		
		// ip2 should still be allowed
		assert.True(t, limiter.Allow(ip2))
	})
}

// TestConnectionHandling tests connection management
func TestConnectionHandling(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	// Create two networks
	config1 := &Config{Port: 0, MaxPeers: 10}
	config2 := &Config{Port: 0, MaxPeers: 10}
	
	network1, err := NewNetwork(logger, config1)
	require.NoError(t, err)
	
	network2, err := NewNetwork(logger, config2)
	require.NoError(t, err)
	
	// Start both networks
	require.NoError(t, network1.Start())
	defer network1.Stop()
	
	require.NoError(t, network2.Start())
	defer network2.Stop()
	
	time.Sleep(100 * time.Millisecond)
	
	t.Run("ConnectPeer", func(t *testing.T) {
		p2p1 := network1.(*UnifiedP2PNetwork)
		p2p2 := network2.(*UnifiedP2PNetwork)
		
		// Get actual listen address
		addr2 := p2p2.listener.Addr().String()
		
		// Connect network1 to network2
		err := p2p1.connectToPeer(addr2)
		assert.NoError(t, err)
		
		// Give time for connection
		time.Sleep(100 * time.Millisecond)
		
		// Check connection established
		assert.Greater(t, p2p1.peerCount.Load(), int32(0))
	})
}

// TestStats tests statistics tracking
func TestStats(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	network, err := NewNetwork(logger, nil)
	require.NoError(t, err)
	
	p2p := network.(*UnifiedP2PNetwork)
	
	// Set some stats
	p2p.stats.TotalMessages.Store(1000)
	p2p.stats.BytesTransferred.Store(1024 * 1024)
	p2p.stats.BlocksReceived.Store(10)
	p2p.stats.SharesReceived.Store(500)
	p2p.peerCount.Store(5)
	
	stats := network.GetStats()
	assert.NotNil(t, stats)
	assert.Equal(t, uint32(5), stats.ConnectedPeers.Load())
	assert.Equal(t, uint64(1000), stats.TotalMessages.Load())
	assert.Equal(t, uint64(1024*1024), stats.BytesTransferred.Load())
	assert.Equal(t, uint64(10), stats.BlocksReceived.Load())
	assert.Equal(t, uint64(500), stats.SharesReceived.Load())
}

// BenchmarkNetworkOperations benchmarks network operations
func BenchmarkNetworkOperations(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	network, err := NewNetwork(logger, nil)
	require.NoError(b, err)
	
	require.NoError(b, network.Start())
	defer network.Stop()
	
	b.Run("Broadcast", func(b *testing.B) {
		msg := Message{
			Type: MessageTypeShare,
			Data: make([]byte, 256),
		}
		
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			network.Broadcast(msg)
		}
	})
	
	b.Run("GetPeers", func(b *testing.B) {
		// Add some peers
		p2p := network.(*UnifiedP2PNetwork)
		for i := 0; i < 100; i++ {
			peer := &Peer{
				ID:      fmt.Sprintf("bench_peer_%d", i),
				Address: "127.0.0.1",
				Port:    30303 + i,
			}
			peer.Connected.Store(true)
			p2p.peers.Store(peer.ID, peer)
		}
		
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			network.GetPeers(50)
		}
	})
	
	b.Run("MessageParsing", func(b *testing.B) {
		data := make([]byte, 1024)
		
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			msg := &Message{
				Type:      MessageTypeShare,
				From:      "benchmark_peer",
				Data:      data,
				Timestamp: time.Now().Unix(),
			}
			
			serialized, _ := serializeMessage(msg)
			parseMessage(serialized)
		}
	})
}

// TestConcurrentNetworkOperations tests thread safety
func TestConcurrentNetworkOperations(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	network, err := NewNetwork(logger, nil)
	require.NoError(t, err)
	
	require.NoError(t, network.Start())
	defer network.Stop()
	
	var wg sync.WaitGroup
	
	// Concurrent broadcasts
	wg.Add(10)
	for i := 0; i < 10; i++ {
		go func(id int) {
			defer wg.Done()
			
			for j := 0; j < 100; j++ {
				msg := Message{
					Type: MessageTypeShare,
					Data: []byte(fmt.Sprintf("msg_%d_%d", id, j)),
				}
				network.Broadcast(msg)
			}
		}(i)
	}
	
	// Concurrent peer operations
	wg.Add(10)
	for i := 0; i < 10; i++ {
		go func(id int) {
			defer wg.Done()
			
			p2p := network.(*UnifiedP2PNetwork)
			
			// Add and remove peers
			for j := 0; j < 50; j++ {
				peer := &Peer{
					ID:      fmt.Sprintf("concurrent_peer_%d_%d", id, j),
					Address: "127.0.0.1",
					Port:    40000 + id*100 + j,
				}
				peer.Connected.Store(true)
				
				p2p.addPeer(peer)
				time.Sleep(time.Microsecond)
				p2p.removePeer(peer.ID)
			}
		}(i)
	}
	
	// Concurrent stats reads
	wg.Add(10)
	for i := 0; i < 10; i++ {
		go func() {
			defer wg.Done()
			
			for j := 0; j < 100; j++ {
				network.GetStats()
				network.GetPeers(10)
				time.Sleep(time.Microsecond)
			}
		}()
	}
	
	// Wait for completion with timeout
	done := make(chan bool)
	go func() {
		wg.Wait()
		done <- true
	}()
	
	select {
	case <-done:
		// Success
	case <-time.After(5 * time.Second):
		t.Fatal("Concurrent operations timed out")
	}
}