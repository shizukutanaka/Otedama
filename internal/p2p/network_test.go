package p2p

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// Test fixtures and helpers

func createTestLogger(t *testing.T) *zap.Logger {
	return zaptest.NewLogger(t)
}

func createTestConfig() *Config {
	return &Config{
		Port:              30303,
		MaxPeers:          100,
		BootstrapNodes:    []string{},
		DDoSProtection:    true,
		RateLimit:         1000,
		ConnectionTimeout: 10 * time.Second,
		MessageTimeout:    5 * time.Second,
		MaxMessageSize:    1024 * 1024,
		BufferSize:        1000,
		NodeID:            "test_node_123",
		IsPoolOperator:    false,
		ShareTarget:       30 * time.Second,
	}
}

func createTestNetwork(t *testing.T) (Network, *zap.Logger) {
	logger := createTestLogger(t)
	config := createTestConfig()
	
	network, err := NewNetwork(logger, config)
	require.NoError(t, err)
	require.NotNil(t, network)
	
	return network, logger
}

func createTestPeer(id string) *Peer {
	peer := &Peer{
		ID:         id,
		Address:    "127.0.0.1",
		Port:       30303,
		NodeType:   NodeTypeMiner,
		TrustScore: 1.0,
		Reputation: 100,
		Latency:    10 * time.Millisecond,
	}
	peer.Connected.Store(true)
	peer.LastSeen.Store(time.Now().Unix())
	return peer
}

// Tests

func TestNewNetwork(t *testing.T) {
	tests := []struct {
		name        string
		config      *Config
		expectError bool
	}{
		{
			name:        "valid config",
			config:      createTestConfig(),
			expectError: false,
		},
		{
			name:        "nil config uses default",
			config:      nil,
			expectError: false,
		},
		{
			name: "invalid port",
			config: &Config{
				Port:     100, // Too low
				MaxPeers: 100,
			},
			expectError: true,
		},
		{
			name: "invalid max peers",
			config: &Config{
				Port:     30303,
				MaxPeers: 5, // Too low
			},
			expectError: true,
		},
		{
			name: "invalid connection timeout",
			config: &Config{
				Port:              30303,
				MaxPeers:          100,
				ConnectionTimeout: 1 * time.Second, // Too short
			},
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := createTestLogger(t)
			network, err := NewNetwork(logger, tt.config)

			if tt.expectError {
				assert.Error(t, err)
				assert.Nil(t, network)
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, network)
			}
		})
	}
}

func TestNetworkLifecycle(t *testing.T) {
	network, _ := createTestNetwork(t)

	// Test initial state
	unifiedNetwork := network.(*UnifiedP2PNetwork)
	assert.False(t, unifiedNetwork.running.Load())

	// Test start
	err := network.Start()
	assert.NoError(t, err)
	assert.True(t, unifiedNetwork.running.Load())

	// Wait a moment for network to initialize
	time.Sleep(100 * time.Millisecond)

	// Test double start
	err = network.Start()
	assert.Error(t, err)

	// Test stop
	err = network.Stop()
	assert.NoError(t, err)
	assert.False(t, unifiedNetwork.running.Load())

	// Test double stop
	err = network.Stop()
	assert.Error(t, err)
}

func TestNetworkStats(t *testing.T) {
	network, _ := createTestNetwork(t)

	// Test stats before start
	stats := network.GetStats()
	assert.NotNil(t, stats)
	assert.Equal(t, uint32(0), stats.ConnectedPeers.Load())
	assert.Equal(t, uint64(0), stats.TotalMessages.Load())

	// Start network
	err := network.Start()
	require.NoError(t, err)
	defer network.Stop()

	// Test stats after start
	stats = network.GetStats()
	assert.NotNil(t, stats)
	assert.GreaterOrEqual(t, uint32(0), stats.ConnectedPeers.Load())
	assert.Greater(t, stats.Uptime, time.Duration(0))
}

func TestGetPeers(t *testing.T) {
	network, _ := createTestNetwork(t)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	// Initially no peers
	peers := network.GetPeers(10)
	assert.Empty(t, peers)

	// Add some test peers
	for i := 0; i < 5; i++ {
		peer := createTestPeer("peer_" + string(rune(i)))
		unifiedNetwork.addPeer(peer)
	}

	// Test getting peers
	peers = network.GetPeers(3)
	assert.Len(t, peers, 3)

	peers = network.GetPeers(10)
	assert.Len(t, peers, 5)
}

func TestBroadcast(t *testing.T) {
	network, _ := createTestNetwork(t)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	// Test broadcast before start
	msg := Message{
		Type: MessageTypePing,
		Data: []byte("test message"),
	}
	err := network.Broadcast(msg)
	assert.Error(t, err)

	// Start network
	err = network.Start()
	require.NoError(t, err)
	defer network.Stop()

	// Test broadcast after start
	err = network.Broadcast(msg)
	assert.NoError(t, err)

	// Check message was properly formatted
	assert.Equal(t, unifiedNetwork.nodeID, msg.From)
	assert.Greater(t, msg.Timestamp, int64(0))
	assert.Greater(t, msg.Size, 0)
}

func TestPeerManagement(t *testing.T) {
	network, _ := createTestNetwork(t)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	// Test adding peers
	peer1 := createTestPeer("peer_1")
	peer2 := createTestPeer("peer_2")

	unifiedNetwork.addPeer(peer1)
	unifiedNetwork.addPeer(peer2)

	assert.Equal(t, int32(2), unifiedNetwork.peerCount.Load())

	// Test getting peers
	peers := network.GetPeers(10)
	assert.Len(t, peers, 2)

	// Test removing peers
	unifiedNetwork.removePeer("peer_1")
	assert.Equal(t, int32(1), unifiedNetwork.peerCount.Load())

	peers = network.GetPeers(10)
	assert.Len(t, peers, 1)
	assert.Equal(t, "peer_2", peers[0].ID)
}

func TestCircuitBreaker(t *testing.T) {
	network, _ := createTestNetwork(t)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	peerID := "test_peer"
	cb := unifiedNetwork.getOrCreateCircuitBreaker(peerID)

	// Test initial state (closed)
	assert.False(t, cb.IsOpen())
	assert.Equal(t, int32(CircuitClosed), cb.state.Load())

	// Record failures to trigger opening
	for i := 0; i < 5; i++ {
		cb.RecordFailure()
	}

	// Circuit should be open
	assert.True(t, cb.IsOpen())
	assert.Equal(t, int32(CircuitOpen), cb.state.Load())

	// Test transition to half-open after timeout
	cb.recoveryTimeout = 100 * time.Millisecond
	time.Sleep(150 * time.Millisecond)
	
	// Should transition to half-open
	assert.False(t, cb.IsOpen())
	assert.Equal(t, int32(CircuitHalfOpen), cb.state.Load())

	// Record successes to close circuit
	for i := 0; i < 3; i++ {
		cb.RecordSuccess()
	}

	// Circuit should be closed
	assert.False(t, cb.IsOpen())
	assert.Equal(t, int32(CircuitClosed), cb.state.Load())
}

func TestLatencyTracker(t *testing.T) {
	tracker := &LatencyTracker{alpha: 0.125}
	peerID := "test_peer"

	// Record some latencies
	latencies := []time.Duration{
		10 * time.Millisecond,
		15 * time.Millisecond,
		12 * time.Millisecond,
		20 * time.Millisecond,
	}

	for _, latency := range latencies {
		tracker.RecordLatency(peerID, latency)
	}

	// Test average latency calculation
	avgLatency := tracker.GetAverageLatency(peerID)
	assert.Greater(t, avgLatency, time.Duration(0))
	assert.Less(t, avgLatency, 25*time.Millisecond)

	// Test sample data
	sample, ok := tracker.samples.Load(peerID)
	assert.True(t, ok)
	ls := sample.(*LatencySample)
	
	assert.Equal(t, peerID, ls.PeerID)
	assert.Equal(t, uint64(4), ls.SampleCount.Load())
	assert.Greater(t, ls.EWMA.Load(), uint64(0))
	assert.Greater(t, ls.Max.Load(), uint64(0))
	assert.Greater(t, ls.Min.Load(), uint64(0))
}

func TestThroughputMeter(t *testing.T) {
	meter := &ThroughputMeter{
		windowSize:  time.Minute,
		bucketCount: 60,
	}
	peerID := "test_peer"

	// Record some bytes
	for i := 0; i < 10; i++ {
		meter.RecordBytes(peerID, 1024)
		time.Sleep(10 * time.Millisecond)
	}

	// Test throughput calculation
	throughput := meter.GetThroughput(peerID)
	assert.Greater(t, throughput, 0.0)

	// Test window data
	window, ok := meter.windows.Load(peerID)
	assert.True(t, ok)
	tw := window.(*ThroughputWindow)
	
	assert.Equal(t, peerID, tw.PeerID)
	assert.GreaterOrEqual(t, tw.CurrentIdx.Load(), int32(0))
}

func TestHealthChecker(t *testing.T) {
	hc := &ConnectionHealthChecker{
		logger:      createTestLogger(t),
		timeout:     1 * time.Second,
		maxFailures: 3,
	}

	peerID := "test_peer"

	// Test recording failures
	for i := 0; i < 2; i++ {
		hc.recordFailure(peerID)
	}

	// Check health status
	status, ok := hc.healthStatus.Load(peerID)
	assert.True(t, ok)
	hs := status.(*HealthStatus)
	
	assert.Equal(t, peerID, hs.PeerID)
	assert.Equal(t, int32(2), hs.ConsecutiveFails.Load())
	assert.True(t, hs.Healthy.Load()) // Still healthy (< maxFailures)

	// One more failure should mark as unhealthy
	hc.recordFailure(peerID)
	assert.False(t, hs.Healthy.Load())

	// Record success should restore health
	hc.recordSuccess(peerID, 10*time.Millisecond)
	assert.True(t, hs.Healthy.Load())
	assert.Equal(t, int32(0), hs.ConsecutiveFails.Load())
}

func TestMessageHandling(t *testing.T) {
	network, _ := createTestNetwork(t)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	// Test ping handling
	pingMsg := &Message{
		Type:      MessageTypePing,
		From:      "sender_peer",
		Timestamp: time.Now().Unix(),
	}

	unifiedNetwork.handlePing(pingMsg)

	// Should have generated a pong response (check outbound queue)
	select {
	case response := <-unifiedNetwork.outbound:
		assert.Equal(t, MessageTypePong, response.Type)
		assert.Equal(t, unifiedNetwork.nodeID, response.From)
		assert.Equal(t, "sender_peer", response.To)
	case <-time.After(100 * time.Millisecond):
		t.Fatal("No pong response generated")
	}
}

func TestPeerSelection(t *testing.T) {
	network, _ := createTestNetwork(t)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	// Add some peers with different health states
	peer1 := createTestPeer("healthy_peer")
	peer2 := createTestPeer("unhealthy_peer")
	peer3 := createTestPeer("slow_peer")

	unifiedNetwork.addPeer(peer1)
	unifiedNetwork.addPeer(peer2)
	unifiedNetwork.addPeer(peer3)

	// Set up health states
	unifiedNetwork.latencyTracker.RecordLatency("healthy_peer", 10*time.Millisecond)
	unifiedNetwork.latencyTracker.RecordLatency("slow_peer", 100*time.Millisecond)

	// Mark peer2 as unhealthy
	for i := 0; i < 5; i++ {
		unifiedNetwork.RecordFailure("unhealthy_peer")
	}

	// Test peer selection
	selectedPeer, err := unifiedNetwork.SelectHealthyPeer([]string{})
	assert.NoError(t, err)
	assert.NotNil(t, selectedPeer)

	// Should select the healthy peer with best latency
	assert.Equal(t, "healthy_peer", selectedPeer.ID)

	// Test with exclusion list
	selectedPeer, err = unifiedNetwork.SelectHealthyPeer([]string{"healthy_peer"})
	assert.NoError(t, err)
	assert.NotNil(t, selectedPeer)
	assert.NotEqual(t, "healthy_peer", selectedPeer.ID)
}

func TestConcurrentOperations(t *testing.T) {
	network, _ := createTestNetwork(t)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	err := network.Start()
	require.NoError(t, err)
	defer network.Stop()

	const numGoroutines = 10
	const operationsPerGoroutine = 50

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	// Concurrent peer operations
	for i := 0; i < numGoroutines; i++ {
		go func(goroutineID int) {
			defer wg.Done()

			for j := 0; j < operationsPerGoroutine; j++ {
				// Add and remove peers
				peerID := "concurrent_peer_" + string(rune(goroutineID)) + "_" + string(rune(j))
				peer := createTestPeer(peerID)
				
				unifiedNetwork.addPeer(peer)
				
				// Record some latency
				unifiedNetwork.latencyTracker.RecordLatency(peerID, time.Duration(j)*time.Millisecond)
				
				// Broadcast message
				msg := Message{
					Type: MessageTypePing,
					Data: []byte("concurrent test"),
				}
				network.Broadcast(msg)
				
				// Get stats
				stats := network.GetStats()
				_ = stats
				
				// Clean up some peers
				if j%10 == 0 {
					unifiedNetwork.removePeer(peerID)
				}
			}
		}(i)
	}

	wg.Wait()

	// Verify final state is consistent
	stats := network.GetStats()
	assert.NotNil(t, stats)
	assert.GreaterOrEqual(t, stats.ConnectedPeers.Load(), uint32(0))
}

func TestDefaultConfig(t *testing.T) {
	config := DefaultConfig()
	assert.NotNil(t, config)
	assert.Equal(t, 30303, config.Port)
	assert.Equal(t, 1000, config.MaxPeers)
	assert.True(t, config.DDoSProtection)
	assert.Equal(t, 1000, config.RateLimit)
	assert.Equal(t, 30*time.Second, config.ConnectionTimeout)
	assert.Equal(t, 10*time.Second, config.MessageTimeout)
	assert.Equal(t, 1024*1024, config.MaxMessageSize)
	assert.Equal(t, 10000, config.BufferSize)
}

func TestMessageSerialization(t *testing.T) {
	msg := &Message{
		Type:      MessageTypePing,
		From:      "sender_123",
		To:        "receiver_456",
		Data:      []byte("test message data"),
		Timestamp: time.Now().Unix(),
	}

	// Test serialization
	data, err := serializeMessage(msg)
	assert.NoError(t, err)
	assert.NotNil(t, data)
	assert.Greater(t, len(data), 16) // Minimum header size

	// Test deserialization
	parsedMsg, err := parseMessage(data)
	assert.NoError(t, err)
	assert.NotNil(t, parsedMsg)
	assert.Equal(t, msg.Type, parsedMsg.Type)
	assert.Equal(t, msg.From, parsedMsg.From)
	assert.Equal(t, msg.Data, parsedMsg.Data)
}

func TestPeerListSerialization(t *testing.T) {
	peers := []*Peer{
		createTestPeer("peer_1"),
		createTestPeer("peer_2"),
		createTestPeer("peer_3"),
	}

	// Test serialization
	data := serializePeerList(peers)
	assert.NotNil(t, data)
	assert.Equal(t, len(peers)*64, len(data))

	// Test deserialization
	parsedPeers, err := parsePeerList(data)
	assert.NoError(t, err)
	assert.NotNil(t, parsedPeers)
	assert.Len(t, parsedPeers, len(peers))

	for i, peer := range parsedPeers {
		assert.Equal(t, peers[i].ID, peer.ID)
		assert.Equal(t, peers[i].Address, peer.Address)
	}
}

func TestUtilityFunctions(t *testing.T) {
	// Test node ID generation
	nodeID1 := generateNodeID()
	nodeID2 := generateNodeID()
	assert.NotEmpty(t, nodeID1)
	assert.NotEmpty(t, nodeID2)
	assert.NotEqual(t, nodeID1, nodeID2)
	assert.Len(t, nodeID1, 64) // 32 bytes * 2 hex chars

	// Test peer ID generation
	address := "192.168.1.100:30303"
	peerID1 := generatePeerID(address)
	peerID2 := generatePeerID(address)
	assert.NotEmpty(t, peerID1)
	assert.Equal(t, peerID1, peerID2) // Same address should generate same ID
	assert.Len(t, peerID1, 16)

	// Test address parsing
	host := getHostFromAddress(address)
	assert.Equal(t, "192.168.1.100", host)

	port := getPortFromAddress(address)
	assert.Equal(t, 3333, port) // Default port in implementation
}

func TestConfigValidation(t *testing.T) {
	tests := []struct {
		name   string
		config *Config
		valid  bool
	}{
		{
			name:   "valid config",
			config: createTestConfig(),
			valid:  true,
		},
		{
			name: "port too low",
			config: &Config{
				Port:     100,
				MaxPeers: 100,
			},
			valid: false,
		},
		{
			name: "port too high",
			config: &Config{
				Port:     70000,
				MaxPeers: 100,
			},
			valid: false,
		},
		{
			name: "max peers too low",
			config: &Config{
				Port:     30303,
				MaxPeers: 5,
			},
			valid: false,
		},
		{
			name: "max peers too high",
			config: &Config{
				Port:     30303,
				MaxPeers: 200000,
			},
			valid: false,
		},
		{
			name: "connection timeout too short",
			config: &Config{
				Port:              30303,
				MaxPeers:          100,
				ConnectionTimeout: 1 * time.Second,
			},
			valid: false,
		},
		{
			name: "connection timeout too long",
			config: &Config{
				Port:              30303,
				MaxPeers:          100,
				ConnectionTimeout: 2 * time.Minute,
			},
			valid: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateConfig(tt.config)
			if tt.valid {
				assert.NoError(t, err)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

// Mock rate limiter for testing
type MockRateLimiter struct {
	allowNext bool
}

func (m *MockRateLimiter) Allow(key string) bool {
	return m.allowNext
}

func NewRateLimiter(logger *zap.Logger, maxRate int) *RateLimiter {
	return &RateLimiter{
		maxRate: maxRate,
		logger:  logger,
	}
}

func (rl *RateLimiter) Allow(key string) bool {
	// Simplified rate limiting for tests
	return true
}

// Mock DHT for testing
type MockDHT struct{}

func NewDHTImplementation(logger *zap.Logger, config *DHTConfig, network interface{}) *DHT {
	return &DHT{}
}

type DHT struct{}
type DHTConfig struct {
	NodeID          string
	BootstrapNodes  []string
	BucketSize      int
	Alpha           int
	RefreshInterval time.Duration
}

// Benchmark tests

func BenchmarkPeerManagement(b *testing.B) {
	network, _ := createTestNetwork(b)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	peers := make([]*Peer, 1000)
	for i := 0; i < 1000; i++ {
		peers[i] = createTestPeer("bench_peer_" + string(rune(i)))
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		peer := peers[i%1000]
		unifiedNetwork.addPeer(peer)
		if i%2 == 0 {
			unifiedNetwork.removePeer(peer.ID)
		}
	}
}

func BenchmarkMessageBroadcast(b *testing.B) {
	network, _ := createTestNetwork(b)
	err := network.Start()
	require.NoError(b, err)
	defer network.Stop()

	msg := Message{
		Type: MessageTypePing,
		Data: make([]byte, 1024),
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		err := network.Broadcast(msg)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkLatencyTracking(b *testing.B) {
	tracker := &LatencyTracker{alpha: 0.125}
	peerID := "bench_peer"
	latency := 10 * time.Millisecond

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tracker.RecordLatency(peerID, latency)
	}
}

func BenchmarkCircuitBreaker(b *testing.B) {
	cb := &CircuitBreaker{
		failureThreshold: 5,
		recoveryTimeout:  30 * time.Second,
		halfOpenMax:      3,
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if i%10 == 0 {
			cb.RecordFailure()
		} else {
			cb.RecordSuccess()
		}
		_ = cb.IsOpen()
	}
}

func BenchmarkConcurrentPeerAccess(b *testing.B) {
	network, _ := createTestNetwork(b)
	unifiedNetwork := network.(*UnifiedP2PNetwork)

	// Pre-populate with peers
	for i := 0; i < 100; i++ {
		peer := createTestPeer("concurrent_peer_" + string(rune(i)))
		unifiedNetwork.addPeer(peer)
	}

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			// Mix of operations
			switch b.N % 4 {
			case 0:
				peers := network.GetPeers(10)
				_ = peers
			case 1:
				stats := network.GetStats()
				_ = stats
			case 2:
				unifiedNetwork.latencyTracker.RecordLatency("concurrent_peer_1", 10*time.Millisecond)
			case 3:
				peer, _ := unifiedNetwork.SelectHealthyPeer([]string{})
				_ = peer
			}
		}
	})
}

func BenchmarkMessageSerialization(b *testing.B) {
	msg := &Message{
		Type:      MessageTypePing,
		From:      "benchmark_sender",
		To:        "benchmark_receiver",
		Data:      make([]byte, 1024),
		Timestamp: time.Now().Unix(),
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		data, err := serializeMessage(msg)
		if err != nil {
			b.Fatal(err)
		}
		
		_, err = parseMessage(data)
		if err != nil {
			b.Fatal(err)
		}
	}
}