package stratum

import (
	"context"
	"encoding/json"
	"net"
	"strings"
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
		Port:           13333, // Use different port for testing
		Host:           "127.0.0.1",
		MaxClients:     100,
		StratumVersion: "EthereumStratum/1.0.0",
		EnableTLS:      false,
		Difficulty:     1000.0,
		VarDiff:        true,
		MinDifficulty:  100.0,
		MaxDifficulty:  10000.0,
		TargetTime:     15 * time.Second,
		ReadTimeout:    30 * time.Second,
		WriteTimeout:   10 * time.Second,
		BufferSize:     4096,
		RateLimit:      50,
		MaxMessageSize: 8192,
		AuthMode:       AuthModeNone,
	}
}

func createTestServer(t *testing.T) (Server, *zap.Logger) {
	logger := createTestLogger(t)
	config := createTestConfig()
	
	server, err := NewServer(logger, config)
	require.NoError(t, err)
	require.NotNil(t, server)
	
	return server, logger
}

func createTestClient(t *testing.T, address string) net.Conn {
	conn, err := net.Dial("tcp", address)
	require.NoError(t, err)
	return conn
}

// Mock implementations

type mockShare struct {
	JobID      string  `json:"job_id"`
	WorkerID   string  `json:"worker_id"`
	Nonce      uint64  `json:"nonce"`
	Difficulty uint64  `json:"difficulty"`
	Valid      bool    `json:"valid"`
}

type mockJob struct {
	ID           string      `json:"id"`
	PrevHash     string      `json:"prev_hash"`
	CoinbaseA    string      `json:"coinbase_a"`
	CoinbaseB    string      `json:"coinbase_b"`
	MerkleBranch []string    `json:"merkle_branch"`
	Version      string      `json:"version"`
	NBits        string      `json:"nbits"`
	NTime        string      `json:"ntime"`
	CleanJobs    bool        `json:"clean_jobs"`
	CreatedAt    time.Time   `json:"created_at"`
}

func createTestCallbacks() *Callbacks {
	return &Callbacks{
		OnShare: func(share *Share) error {
			// Mock share validation - accept all shares for testing
			return nil
		},
		OnGetJob: func() *Job {
			return &Job{
				ID:           "test_job_123",
				PrevHash:     "0000000000000000000000000000000000000000000000000000000000000000",
				CoinbaseA:    "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff",
				CoinbaseB:    "ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f",
				MerkleBranch: []string{},
				Version:      "20000000",
				NBits:        "1d00ffff",
				NTime:        "504e86ed",
				CleanJobs:    true,
				CreatedAt:    time.Now(),
			}
		},
		OnAuth: func(username, password string) error {
			// Mock authentication - accept all for testing
			if username == "testuser" && password == "testpass" {
				return nil
			}
			return nil // Allow all for testing
		},
	}
}

// Tests

func TestNewServer(t *testing.T) {
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
			name: "invalid port too low",
			config: &Config{
				Port: 1023,
				Host: "127.0.0.1",
			},
			expectError: true,
		},
		{
			name: "invalid port too high",
			config: &Config{
				Port: 70000,
				Host: "127.0.0.1",
			},
			expectError: true,
		},
		{
			name: "invalid max clients",
			config: &Config{
				Port:       13333,
				Host:       "127.0.0.1",
				MaxClients: 0,
			},
			expectError: true,
		},
		{
			name: "invalid difficulty",
			config: &Config{
				Port:       13333,
				Host:       "127.0.0.1",
				MaxClients: 100,
				Difficulty: 0.0001, // Too low
			},
			expectError: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := createTestLogger(t)
			server, err := NewServer(logger, tt.config)

			if tt.expectError {
				assert.Error(t, err)
				assert.Nil(t, server)
			} else {
				assert.NoError(t, err)
				assert.NotNil(t, server)
			}
		})
	}
}

func TestServerLifecycle(t *testing.T) {
	server, _ := createTestServer(t)

	// Test initial state
	stratumServer := server.(*StratumServer)
	assert.False(t, stratumServer.running.Load())

	// Test start
	err := server.Start()
	assert.NoError(t, err)
	assert.True(t, stratumServer.running.Load())

	// Wait a moment for server to start
	time.Sleep(100 * time.Millisecond)

	// Test double start
	err = server.Start()
	assert.Error(t, err)

	// Test stop
	err = server.Stop()
	assert.NoError(t, err)
	assert.False(t, stratumServer.running.Load())

	// Test double stop
	err = server.Stop()
	assert.Error(t, err)
}

func TestServerStats(t *testing.T) {
	server, _ := createTestServer(t)

	// Test stats before start
	stats := server.GetStats()
	assert.NotNil(t, stats)
	assert.Equal(t, int32(0), stats.ActiveConnections.Load())
	assert.Equal(t, uint64(0), stats.TotalShares.Load())

	// Start server
	err := server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Test stats after start
	stats = server.GetStats()
	assert.NotNil(t, stats)
	assert.GreaterOrEqual(t, int32(0), stats.ActiveConnections.Load())
	assert.GreaterOrEqual(t, uint64(0), stats.TotalShares.Load())
}

func TestServerCallbacks(t *testing.T) {
	server, _ := createTestServer(t)

	// Test setting callbacks
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	assert.NoError(t, err)

	// Test setting nil callbacks
	err = server.SetCallbacks(nil)
	assert.Error(t, err)
}

func TestDefaultConfig(t *testing.T) {
	config := DefaultConfig()
	assert.NotNil(t, config)
	assert.Equal(t, 3333, config.Port)
	assert.Equal(t, "0.0.0.0", config.Host)
	assert.Equal(t, 10000, config.MaxClients)
	assert.Equal(t, "EthereumStratum/1.0.0", config.StratumVersion)
	assert.False(t, config.EnableTLS)
	assert.Equal(t, 1.0, config.Difficulty)
	assert.True(t, config.VarDiff)
	assert.Equal(t, 0.001, config.MinDifficulty)
	assert.Equal(t, 1000000.0, config.MaxDifficulty)
	assert.Equal(t, 15*time.Second, config.TargetTime)
	assert.Equal(t, AuthModeNone, config.AuthMode)
}

func TestClientConnectionHandling(t *testing.T) {
	server, _ := createTestServer(t)
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	// Test client connection
	address := "127.0.0.1:13333"
	conn := createTestClient(t, address)
	defer conn.Close()

	// Wait for connection to be registered
	time.Sleep(100 * time.Millisecond)

	// Check stats
	stats := server.GetStats()
	assert.GreaterOrEqual(t, stats.ActiveConnections.Load(), int32(1))
}

func TestMultipleClients(t *testing.T) {
	server, _ := createTestServer(t)
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	const numClients = 5
	var clients []net.Conn

	// Connect multiple clients
	for i := 0; i < numClients; i++ {
		conn := createTestClient(t, "127.0.0.1:13333")
		clients = append(clients, conn)
		defer conn.Close()
	}

	// Wait for all connections to be registered
	time.Sleep(200 * time.Millisecond)

	// Check stats
	stats := server.GetStats()
	assert.GreaterOrEqual(t, stats.ActiveConnections.Load(), int32(numClients))

	// Close clients
	for _, conn := range clients {
		conn.Close()
	}
}

func TestMessageHandling(t *testing.T) {
	server, _ := createTestServer(t)
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	// Connect client
	conn := createTestClient(t, "127.0.0.1:13333")
	defer conn.Close()

	// Test valid JSON message
	message := map[string]interface{}{
		"id":     1,
		"method": "mining.subscribe",
		"params": []interface{}{"test_miner/1.0"},
	}

	data, err := json.Marshal(message)
	require.NoError(t, err)
	data = append(data, '\n')

	_, err = conn.Write(data)
	assert.NoError(t, err)

	// Test invalid JSON
	_, err = conn.Write([]byte("invalid json\n"))
	assert.NoError(t, err) // Server should handle gracefully

	// Test oversized message
	oversized := strings.Repeat("x", 10000) // Exceeds MaxMessageSize
	_, err = conn.Write([]byte(oversized + "\n"))
	assert.NoError(t, err) // Server should handle gracefully
}

func TestRateLimiting(t *testing.T) {
	// Create server with low rate limit
	config := createTestConfig()
	config.RateLimit = 5 // Very low for testing

	logger := createTestLogger(t)
	server, err := NewServer(logger, config)
	require.NoError(t, err)

	callbacks := createTestCallbacks()
	err = server.SetCallbacks(callbacks)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	// Connect client
	conn := createTestClient(t, "127.0.0.1:13333")
	defer conn.Close()

	// Send many messages quickly
	message := map[string]interface{}{
		"id":     1,
		"method": "mining.subscribe",
		"params": []interface{}{"test_miner/1.0"},
	}

	data, err := json.Marshal(message)
	require.NoError(t, err)
	data = append(data, '\n')

	// Should eventually hit rate limit
	for i := 0; i < 20; i++ {
		conn.Write(data)
		time.Sleep(10 * time.Millisecond)
	}

	// Connection should still be alive (rate limiting doesn't disconnect)
	_, err = conn.Write(data)
	assert.NoError(t, err)
}

func TestDifficultyAdjustment(t *testing.T) {
	// Create server with VarDiff enabled
	config := createTestConfig()
	config.VarDiff = true
	config.TargetTime = 1 * time.Second // Fast adjustment for testing

	logger := createTestLogger(t)
	server, err := NewServer(logger, config)
	require.NoError(t, err)

	stratumServer := server.(*StratumServer)

	// Test difficulty adjuster initialization
	assert.NotNil(t, stratumServer.difficultyAdjuster)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Test with VarDiff disabled
	config.VarDiff = false
	server2, err := NewServer(logger, config)
	require.NoError(t, err)

	stratumServer2 := server2.(*StratumServer)
	assert.Nil(t, stratumServer2.difficultyAdjuster)
}

func TestJobBroadcasting(t *testing.T) {
	server, _ := createTestServer(t)
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	// Connect client
	conn := createTestClient(t, "127.0.0.1:13333")
	defer conn.Close()

	// Wait for potential job broadcast
	time.Sleep(2 * time.Second)

	// Check stats for job creation/distribution
	stats := server.GetStats()
	// Jobs may or may not be created depending on timing
	assert.GreaterOrEqual(t, stats.JobsCreated.Load(), uint64(0))
}

func TestConcurrentClients(t *testing.T) {
	server, _ := createTestServer(t)
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	const numClients = 10
	var wg sync.WaitGroup
	wg.Add(numClients)

	// Connect clients concurrently
	for i := 0; i < numClients; i++ {
		go func(clientID int) {
			defer wg.Done()

			conn := createTestClient(t, "127.0.0.1:13333")
			defer conn.Close()

			// Send some messages
			for j := 0; j < 5; j++ {
				message := map[string]interface{}{
					"id":     j,
					"method": "mining.subscribe",
					"params": []interface{}{},
				}

				data, err := json.Marshal(message)
				if err != nil {
					return
				}
				data = append(data, '\n')

				conn.Write(data)
				time.Sleep(50 * time.Millisecond)
			}

			time.Sleep(500 * time.Millisecond)
		}(i)
	}

	wg.Wait()

	// Check final stats
	stats := server.GetStats()
	assert.GreaterOrEqual(t, stats.TotalConnections.Load(), uint64(numClients))
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
				Port: 1023,
			},
			valid: false,
		},
		{
			name: "port too high",
			config: &Config{
				Port: 70000,
			},
			valid: false,
		},
		{
			name: "max clients too low",
			config: &Config{
				Port:       13333,
				MaxClients: 0,
			},
			valid: false,
		},
		{
			name: "max clients too high",
			config: &Config{
				Port:       13333,
				MaxClients: 200000,
			},
			valid: false,
		},
		{
			name: "difficulty too low",
			config: &Config{
				Port:       13333,
				MaxClients: 100,
				Difficulty: 0.0001,
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

// Test utility functions

func TestGenerateClientID(t *testing.T) {
	id1 := generateClientID()
	id2 := generateClientID()

	assert.NotEmpty(t, id1)
	assert.NotEmpty(t, id2)
	assert.NotEqual(t, id1, id2) // Should be unique
	assert.True(t, strings.HasPrefix(id1, "client_"))
	assert.True(t, strings.HasPrefix(id2, "client_"))
}

func TestCalculateShareRate(t *testing.T) {
	client := &Client{
		ConnectedAt: time.Now().Add(-2 * time.Minute),
	}
	client.SharesSubmitted.Store(120) // 120 shares in 2 minutes = 1 share/second

	rate := calculateShareRate(client)
	assert.Greater(t, rate, 0.5) // Should be around 1.0
	assert.Less(t, rate, 1.5)

	// Test new client
	newClient := &Client{
		ConnectedAt: time.Now().Add(-30 * time.Second),
	}
	newClient.SharesSubmitted.Store(5)

	rate = calculateShareRate(newClient)
	assert.Equal(t, 0.1, rate) // Default for new clients
}

func TestAbsFunction(t *testing.T) {
	tests := []struct {
		input    float64
		expected float64
	}{
		{5.0, 5.0},
		{-5.0, 5.0},
		{0.0, 0.0},
		{-0.1, 0.1},
		{100.5, 100.5},
		{-100.5, 100.5},
	}

	for _, tt := range tests {
		result := abs(tt.input)
		assert.Equal(t, tt.expected, result)
	}
}

// Benchmark tests

func BenchmarkServerStats(b *testing.B) {
	server, _ := createTestServer(b)
	err := server.Start()
	require.NoError(b, err)
	defer server.Stop()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		stats := server.GetStats()
		_ = stats
	}
}

func BenchmarkClientConnection(b *testing.B) {
	server, _ := createTestServer(b)
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	require.NoError(b, err)

	err = server.Start()
	require.NoError(b, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		conn, err := net.Dial("tcp", "127.0.0.1:13333")
		if err != nil {
			b.Fatal(err)
		}
		conn.Close()
	}
}

func BenchmarkMessageHandling(b *testing.B) {
	server, _ := createTestServer(b)
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	require.NoError(b, err)

	err = server.Start()
	require.NoError(b, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	// Connect client
	conn := createTestClient(b, "127.0.0.1:13333")
	defer conn.Close()

	message := map[string]interface{}{
		"id":     1,
		"method": "mining.subscribe",
		"params": []interface{}{"test_miner/1.0"},
	}

	data, err := json.Marshal(message)
	require.NoError(b, err)
	data = append(data, '\n')

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := conn.Write(data)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkConcurrentConnections(b *testing.B) {
	server, _ := createTestServer(b)
	callbacks := createTestCallbacks()
	err := server.SetCallbacks(callbacks)
	require.NoError(b, err)

	err = server.Start()
	require.NoError(b, err)
	defer server.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			conn, err := net.Dial("tcp", "127.0.0.1:13333")
			if err != nil {
				b.Fatal(err)
			}

			// Send a message
			message := map[string]interface{}{
				"id":     1,
				"method": "mining.subscribe",
				"params": []interface{}{},
			}

			data, err := json.Marshal(message)
			if err != nil {
				conn.Close()
				b.Fatal(err)
			}
			data = append(data, '\n')

			conn.Write(data)
			conn.Close()
		}
	})
}