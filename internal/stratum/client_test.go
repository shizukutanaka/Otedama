package stratum

import (
	"bufio"
	"encoding/json"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

// Test fixtures and helpers

func createTestClientInstance() *Client {
	return &Client{
		ID:         "test_client_123",
		RemoteAddr: "127.0.0.1:12345",
		WorkerName: "test_worker",
		UserAgent:  "test_miner/1.0",
		ConnectedAt: time.Now(),
	}
}

func createMockConnection() (*mockConn, *mockConn) {
	server := &mockConn{
		readChan:  make(chan []byte, 10),
		writeChan: make(chan []byte, 10),
		closed:    make(chan struct{}),
	}
	client := &mockConn{
		readChan:  server.writeChan,  // Client reads what server writes
		writeChan: server.readChan,   // Client writes what server reads
		closed:    server.closed,
	}
	return server, client
}

// Mock connection for testing
type mockConn struct {
	readChan  chan []byte
	writeChan chan []byte
	closed    chan struct{}
	isClosed  atomic.Bool
	mu        sync.Mutex
}

func (m *mockConn) Read(b []byte) (n int, error) {
	select {
	case data := <-m.readChan:
		copy(b, data)
		return len(data), nil
	case <-m.closed:
		return 0, net.ErrClosed
	}
}

func (m *mockConn) Write(b []byte) (n int, error) {
	if m.isClosed.Load() {
		return 0, net.ErrClosed
	}
	
	data := make([]byte, len(b))
	copy(data, b)
	
	select {
	case m.writeChan <- data:
		return len(b), nil
	case <-m.closed:
		return 0, net.ErrClosed
	default:
		return 0, net.ErrClosed
	}
}

func (m *mockConn) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	
	if !m.isClosed.CompareAndSwap(false, true) {
		return nil // Already closed
	}
	
	close(m.closed)
	return nil
}

func (m *mockConn) LocalAddr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 3333}
}

func (m *mockConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 12345}
}

func (m *mockConn) SetDeadline(t time.Time) error {
	return nil
}

func (m *mockConn) SetReadDeadline(t time.Time) error {
	return nil
}

func (m *mockConn) SetWriteDeadline(t time.Time) error {
	return nil
}

// Tests

func TestClientCreation(t *testing.T) {
	client := createTestClientInstance()

	assert.Equal(t, "test_client_123", client.ID)
	assert.Equal(t, "127.0.0.1:12345", client.RemoteAddr)
	assert.Equal(t, "test_worker", client.WorkerName)
	assert.Equal(t, "test_miner/1.0", client.UserAgent)
	assert.False(t, client.Connected.Load())
	assert.False(t, client.Authorized.Load())
	assert.Equal(t, uint64(0), client.SharesSubmitted.Load())
	assert.Equal(t, uint64(0), client.SharesAccepted.Load())
	assert.Equal(t, uint64(0), client.SharesRejected.Load())
	assert.Equal(t, uint64(0), client.CurrentHashRate.Load())
}

func TestClientConnectionState(t *testing.T) {
	client := createTestClientInstance()

	// Test initial state
	assert.False(t, client.Connected.Load())
	assert.False(t, client.Authorized.Load())

	// Test state changes
	client.Connected.Store(true)
	assert.True(t, client.Connected.Load())

	client.Authorized.Store(true)
	assert.True(t, client.Authorized.Load())

	// Test disconnect
	client.Connected.Store(false)
	assert.False(t, client.Connected.Load())
}

func TestClientStatistics(t *testing.T) {
	client := createTestClientInstance()

	// Test initial statistics
	assert.Equal(t, uint64(0), client.SharesSubmitted.Load())
	assert.Equal(t, uint64(0), client.SharesAccepted.Load())
	assert.Equal(t, uint64(0), client.SharesRejected.Load())

	// Test incrementing statistics
	client.SharesSubmitted.Add(10)
	assert.Equal(t, uint64(10), client.SharesSubmitted.Load())

	client.SharesAccepted.Add(8)
	assert.Equal(t, uint64(8), client.SharesAccepted.Load())

	client.SharesRejected.Add(2)
	assert.Equal(t, uint64(2), client.SharesRejected.Load())

	// Test hash rate
	client.CurrentHashRate.Store(1000000) // 1 MH/s
	assert.Equal(t, uint64(1000000), client.CurrentHashRate.Load())
}

func TestClientDifficulty(t *testing.T) {
	client := createTestClientInstance()

	// Test initial difficulty (should be zero value)
	difficulty := client.Difficulty.Load()
	assert.Nil(t, difficulty)

	// Test setting difficulty
	client.Difficulty.Store(1000.0)
	difficulty = client.Difficulty.Load()
	assert.Equal(t, 1000.0, difficulty)

	// Test updating difficulty
	client.Difficulty.Store(2000.0)
	difficulty = client.Difficulty.Load()
	assert.Equal(t, 2000.0, difficulty)

	// Test difficulty adjustment timestamp
	now := time.Now().Unix()
	client.LastDiffAdjust.Store(now)
	assert.Equal(t, now, client.LastDiffAdjust.Load())
}

func TestClientActivityTracking(t *testing.T) {
	client := createTestClientInstance()

	// Test initial activity
	initialActivity := client.LastActivity.Load()
	assert.Equal(t, int64(0), initialActivity)

	// Test updating activity
	now := time.Now().Unix()
	client.LastActivity.Store(now)
	assert.Equal(t, now, client.LastActivity.Load())

	// Test activity in the past
	past := now - 3600 // 1 hour ago
	client.LastActivity.Store(past)
	assert.Equal(t, past, client.LastActivity.Load())
}

func TestClientRateLimiting(t *testing.T) {
	client := createTestClientInstance()

	// Test initial message count
	assert.Equal(t, uint64(0), client.messageCount.Load())

	// Test incrementing message count
	client.messageCount.Add(1)
	assert.Equal(t, uint64(1), client.messageCount.Load())

	client.messageCount.Add(5)
	assert.Equal(t, uint64(6), client.messageCount.Load())

	// Test reset timestamp
	now := time.Now().Unix()
	client.lastReset.Store(now)
	assert.Equal(t, now, client.lastReset.Load())
}

func TestClientMessageHandling(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := createTestConfig()
	
	server, err := NewServer(logger, config)
	require.NoError(t, err)

	stratumServer := server.(*StratumServer)
	
	// Create mock connection
	serverConn, clientConn := createMockConnection()
	defer serverConn.Close()
	defer clientConn.Close()

	// Test connection configuration
	err = stratumServer.configureConnection(serverConn)
	assert.NoError(t, err)

	// Test client creation
	client := stratumServer.createClient(serverConn)
	assert.NotNil(t, client)
	assert.NotEmpty(t, client.ID)
	assert.Equal(t, serverConn.RemoteAddr().String(), client.RemoteAddr)
	assert.True(t, client.Connected.Load())
	assert.NotNil(t, client.reader)
	assert.NotNil(t, client.writer)

	// Test difficulty initialization
	difficulty := client.Difficulty.Load()
	assert.Equal(t, config.Difficulty, difficulty)
}

func TestReadMessage(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := createTestConfig()
	
	server, err := NewServer(logger, config)
	require.NoError(t, err)

	stratumServer := server.(*StratumServer)
	
	// Create mock connection
	serverConn, clientConn := createMockConnection()
	defer serverConn.Close()
	defer clientConn.Close()

	client := stratumServer.createClient(serverConn)

	// Test valid JSON message
	validMessage := map[string]interface{}{
		"id":     1,
		"method": "mining.subscribe",
		"params": []interface{}{"test_miner/1.0"},
	}

	data, err := json.Marshal(validMessage)
	require.NoError(t, err)
	data = append(data, '\n')

	// Send message from client side
	go func() {
		clientConn.Write(data)
	}()

	// Read message on server side
	message, err := stratumServer.readMessage(client)
	assert.NoError(t, err)
	assert.NotNil(t, message)

	// Test invalid JSON
	go func() {
		clientConn.Write([]byte("invalid json\n"))
	}()

	message, err = stratumServer.readMessage(client)
	assert.Error(t, err)
	assert.Nil(t, message)

	// Test oversized message
	oversized := make([]byte, config.MaxMessageSize+100)
	for i := range oversized {
		oversized[i] = 'x'
	}
	oversized = append(oversized, '\n')

	go func() {
		clientConn.Write(oversized)
	}()

	message, err = stratumServer.readMessage(client)
	assert.Error(t, err)
	assert.Nil(t, message)
}

func TestSendMessage(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := createTestConfig()
	
	server, err := NewServer(logger, config)
	require.NoError(t, err)

	stratumServer := server.(*StratumServer)
	
	// Create mock connection
	serverConn, clientConn := createMockConnection()
	defer serverConn.Close()
	defer clientConn.Close()

	client := stratumServer.createClient(serverConn)

	// Test sending valid message
	message := &Message{
		ID:     1,
		Method: "mining.notify",
		Params: []interface{}{"job_id", "prev_hash"},
	}

	err = stratumServer.sendMessage(client, message)
	assert.NoError(t, err)

	// Read message on client side
	reader := bufio.NewReader(clientConn)
	line, err := reader.ReadBytes('\n')
	assert.NoError(t, err)

	var receivedMessage Message
	err = json.Unmarshal(line[:len(line)-1], &receivedMessage) // Remove newline
	assert.NoError(t, err)
	assert.Equal(t, message.ID, receivedMessage.ID)
	assert.Equal(t, message.Method, receivedMessage.Method)
}

func TestSendJob(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := createTestConfig()
	
	server, err := NewServer(logger, config)
	require.NoError(t, err)

	stratumServer := server.(*StratumServer)
	
	// Create mock connection
	serverConn, clientConn := createMockConnection()
	defer serverConn.Close()
	defer clientConn.Close()

	client := stratumServer.createClient(serverConn)

	// Test sending job
	job := &Job{
		ID:           "test_job_123",
		PrevHash:     "0000000000000000000000000000000000000000000000000000000000000000",
		CoinbaseA:    "coinbase_a",
		CoinbaseB:    "coinbase_b",
		MerkleBranch: []string{},
		Version:      "20000000",
		NBits:        "1d00ffff",
		NTime:        "504e86ed",
		CreatedAt:    time.Now(),
	}

	stratumServer.sendJob(client, job, true)

	// Read message on client side
	reader := bufio.NewReader(clientConn)
	line, err := reader.ReadBytes('\n')
	assert.NoError(t, err)

	var message Message
	err = json.Unmarshal(line[:len(line)-1], &message)
	assert.NoError(t, err)
	assert.Equal(t, "mining.notify", message.Method)
	assert.NotEmpty(t, message.Params)
}

func TestSendDifficulty(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := createTestConfig()
	
	server, err := NewServer(logger, config)
	require.NoError(t, err)

	stratumServer := server.(*StratumServer)
	
	// Create mock connection
	serverConn, clientConn := createMockConnection()
	defer serverConn.Close()
	defer clientConn.Close()

	client := stratumServer.createClient(serverConn)

	// Test sending difficulty
	difficulty := 2000.0
	stratumServer.sendDifficulty(client, difficulty)

	// Read message on client side
	reader := bufio.NewReader(clientConn)
	line, err := reader.ReadBytes('\n')
	assert.NoError(t, err)

	var message Message
	err = json.Unmarshal(line[:len(line)-1], &message)
	assert.NoError(t, err)
	assert.Equal(t, "mining.set_difficulty", message.Method)
	assert.Len(t, message.Params, 1)
	assert.Equal(t, difficulty, message.Params[0])
}

func TestConcurrentClientOperations(t *testing.T) {
	client := createTestClientInstance()

	const numGoroutines = 10
	const operationsPerGoroutine = 100

	var wg sync.WaitGroup
	wg.Add(numGoroutines * 3) // 3 types of operations

	// Concurrent share submissions
	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < operationsPerGoroutine; j++ {
				client.SharesSubmitted.Add(1)
				if j%2 == 0 {
					client.SharesAccepted.Add(1)
				} else {
					client.SharesRejected.Add(1)
				}
			}
		}()
	}

	// Concurrent difficulty updates
	for i := 0; i < numGoroutines; i++ {
		go func(id int) {
			defer wg.Done()
			for j := 0; j < operationsPerGoroutine; j++ {
				difficulty := float64(1000 + id*100 + j)
				client.Difficulty.Store(difficulty)
				client.LastDiffAdjust.Store(time.Now().Unix())
			}
		}(i)
	}

	// Concurrent activity updates
	for i := 0; i < numGoroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < operationsPerGoroutine; j++ {
				client.LastActivity.Store(time.Now().Unix())
				client.CurrentHashRate.Store(uint64(1000000 + j))
				client.messageCount.Add(1)
			}
		}()
	}

	wg.Wait()

	// Verify final state is consistent
	totalShares := client.SharesSubmitted.Load()
	acceptedShares := client.SharesAccepted.Load()
	rejectedShares := client.SharesRejected.Load()

	assert.Equal(t, uint64(numGoroutines*operationsPerGoroutine), totalShares)
	assert.Equal(t, acceptedShares+rejectedShares, totalShares)
	assert.Greater(t, client.LastActivity.Load(), int64(0))
	assert.Greater(t, client.CurrentHashRate.Load(), uint64(0))
}

func TestClientRegistration(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := createTestConfig()
	
	server, err := NewServer(logger, config)
	require.NoError(t, err)

	stratumServer := server.(*StratumServer)
	client := createTestClientInstance()

	// Test registration
	initialCount := stratumServer.clientCount.Load()
	stratumServer.registerClient(client)

	// Check client is stored
	storedClient, exists := stratumServer.clients.Load(client.ID)
	assert.True(t, exists)
	assert.Equal(t, client, storedClient)

	// Check count increased
	assert.Equal(t, initialCount+1, stratumServer.clientCount.Load())

	// Test unregistration
	stratumServer.unregisterClient(client)

	// Check client is removed
	_, exists = stratumServer.clients.Load(client.ID)
	assert.False(t, exists)

	// Check count decreased
	assert.Equal(t, initialCount, stratumServer.clientCount.Load())

	// Check client state
	assert.False(t, client.Connected.Load())
}

func TestClientMemoryUsage(t *testing.T) {
	// Test that client structs don't consume excessive memory
	clients := make([]*Client, 1000)

	for i := 0; i < 1000; i++ {
		client := createTestClientInstance()
		client.ID = "client_" + string(rune(i))
		clients[i] = client
	}

	// All clients should be properly initialized
	for _, client := range clients {
		assert.NotEmpty(t, client.ID)
		assert.False(t, client.Connected.Load())
		assert.Equal(t, uint64(0), client.SharesSubmitted.Load())
	}

	// Memory should be reasonable (this is more of a smoke test)
	assert.Len(t, clients, 1000)
}

// Benchmark tests

func BenchmarkClientStatsAccess(b *testing.B) {
	client := createTestClientInstance()
	client.SharesSubmitted.Store(1000)
	client.SharesAccepted.Store(950)
	client.CurrentHashRate.Store(5000000)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = client.SharesSubmitted.Load()
		_ = client.SharesAccepted.Load()
		_ = client.CurrentHashRate.Load()
		_ = client.Connected.Load()
		_ = client.Authorized.Load()
	}
}

func BenchmarkClientStatsUpdate(b *testing.B) {
	client := createTestClientInstance()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		client.SharesSubmitted.Add(1)
		if i%10 == 0 {
			client.SharesAccepted.Add(1)
		}
		client.CurrentHashRate.Store(uint64(5000000 + i))
		client.LastActivity.Store(time.Now().Unix())
	}
}

func BenchmarkDifficultyUpdate(b *testing.B) {
	client := createTestClientInstance()

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		difficulty := float64(1000 + i)
		client.Difficulty.Store(difficulty)
		client.LastDiffAdjust.Store(time.Now().Unix())
	}
}

func BenchmarkConcurrentClientAccess(b *testing.B) {
	client := createTestClientInstance()

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			// Mix of read and write operations
			switch b.N % 4 {
			case 0:
				client.SharesSubmitted.Add(1)
			case 1:
				_ = client.SharesSubmitted.Load()
			case 2:
				client.LastActivity.Store(time.Now().Unix())
			case 3:
				_ = client.Connected.Load()
			}
		}
	})
}

func BenchmarkMessageSerialization(b *testing.B) {
	message := &Message{
		ID:     1,
		Method: "mining.notify",
		Params: []interface{}{
			"job_123",
			"0000000000000000000000000000000000000000000000000000000000000000",
			"coinbase_a",
			"coinbase_b",
			[]string{},
			"20000000",
			"1d00ffff",
			"504e86ed",
			true,
		},
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		data, err := json.Marshal(message)
		if err != nil {
			b.Fatal(err)
		}
		_ = data
	}
}

// Test message types

type Message struct {
	ID     interface{}   `json:"id"`
	Method string        `json:"method,omitempty"`
	Params []interface{} `json:"params,omitempty"`
	Result interface{}   `json:"result,omitempty"`
	Error  interface{}   `json:"error,omitempty"`
}

type Job struct {
	ID           string    `json:"id"`
	PrevHash     string    `json:"prev_hash"`
	CoinbaseA    string    `json:"coinbase_a"`
	CoinbaseB    string    `json:"coinbase_b"`
	MerkleBranch []string  `json:"merkle_branch"`
	Version      string    `json:"version"`
	NBits        string    `json:"nbits"`
	NTime        string    `json:"ntime"`
	CleanJobs    bool      `json:"clean_jobs"`
	CreatedAt    time.Time `json:"created_at"`
}

type Share struct {
	JobID      string `json:"job_id"`
	WorkerID   string `json:"worker_id"`
	Nonce      string `json:"nonce"`
	Result     string `json:"result"`
	Timestamp  int64  `json:"timestamp"`
}

// Authentication modes
type AuthenticationMode int

const (
	AuthModeNone AuthenticationMode = iota
	AuthModeBasic
	AuthModeToken
)