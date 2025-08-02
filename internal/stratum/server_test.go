package stratum

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestServer_Creation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &Config{
		Host:       "127.0.0.1",
		Port:       0, // Random port
		MaxClients: 100,
		Difficulty: 1.0,
		AuthMode:   AuthModeNone,
	}

	server, err := NewServer(logger, config)
	require.NoError(t, err)
	assert.NotNil(t, server)
}

func TestServer_StartStop(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &Config{
		Host:       "127.0.0.1",
		Port:       0,
		MaxClients: 10,
		Difficulty: 1.0,
		AuthMode:   AuthModeNone,
	}

	server, err := NewServer(logger, config)
	require.NoError(t, err)

	// Start server
	err = server.Start()
	require.NoError(t, err)

	// Wait for server to be ready
	time.Sleep(100 * time.Millisecond)

	// Get actual port
	addr := server.listener.Addr().(*net.TCPAddr)
	assert.Greater(t, addr.Port, 0)

	// Stop server
	err = server.Stop()
	require.NoError(t, err)
}

func TestServer_ClientConnection(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := setupTestServer(t, logger)
	defer server.Stop()

	// Connect client
	conn, err := net.Dial("tcp", server.listener.Addr().String())
	require.NoError(t, err)
	defer conn.Close()

	// Server should accept connection
	time.Sleep(100 * time.Millisecond)
	stats := server.GetStats()
	assert.Equal(t, 1, stats.ActiveClients)
}

func TestServer_Mining_Subscribe(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := setupTestServer(t, logger)
	defer server.Stop()

	client := connectTestClient(t, server)
	defer client.Close()

	// Send subscribe request
	request := &Request{
		ID:     1,
		Method: "mining.subscribe",
		Params: []interface{}{"test-miner/1.0"},
	}

	err := sendRequest(client, request)
	require.NoError(t, err)

	// Read response
	response := readResponse(t, client)
	assert.Equal(t, float64(1), response["id"])
	assert.Nil(t, response["error"])
	assert.NotNil(t, response["result"])
}

func TestServer_Mining_Authorize(t *testing.T) {
	tests := []struct {
		name     string
		authMode AuthMode
		username string
		password string
		wantErr  bool
	}{
		{
			name:     "No auth required",
			authMode: AuthModeNone,
			username: "test.worker",
			password: "x",
			wantErr:  false,
		},
		{
			name:     "Database auth valid",
			authMode: AuthModeDatabase,
			username: "validuser.worker",
			password: "password123",
			wantErr:  false,
		},
		{
			name:     "Wallet auth valid",
			authMode: AuthModeWallet,
			username: "bc1qtest123",
			password: "x",
			wantErr:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := zaptest.NewLogger(t)
			config := &Config{
				Host:       "127.0.0.1",
				Port:       0,
				MaxClients: 10,
				Difficulty: 1.0,
				AuthMode:   tt.authMode,
			}

			server, err := NewServer(logger, config)
			require.NoError(t, err)

			err = server.Start()
			require.NoError(t, err)
			defer server.Stop()

			client := connectTestClient(t, server)
			defer client.Close()

			// Subscribe first
			subscribe := &Request{
				ID:     1,
				Method: "mining.subscribe",
				Params: []interface{}{"test-miner/1.0"},
			}
			sendRequest(client, subscribe)
			readResponse(t, client)

			// Authorize
			authorize := &Request{
				ID:     2,
				Method: "mining.authorize",
				Params: []interface{}{tt.username, tt.password},
			}

			err = sendRequest(client, authorize)
			require.NoError(t, err)

			response := readResponse(t, client)
			if tt.wantErr {
				assert.NotNil(t, response["error"])
			} else {
				assert.Nil(t, response["error"])
				assert.Equal(t, true, response["result"])
			}
		})
	}
}

func TestServer_Mining_Submit(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := setupTestServer(t, logger)
	defer server.Stop()

	client := connectTestClient(t, server)
	defer client.Close()

	// Subscribe and authorize
	setupMiningClient(t, client)

	// Submit share
	submit := &Request{
		ID:     3,
		Method: "mining.submit",
		Params: []interface{}{
			"test.worker",
			"job123",
			"00000000",
			time.Now().Unix(),
			"12345678",
		},
	}

	err := sendRequest(client, submit)
	require.NoError(t, err)

	response := readResponse(t, client)
	assert.Nil(t, response["error"])
	assert.Equal(t, true, response["result"])

	// Check stats
	stats := server.GetStats()
	assert.Equal(t, uint64(1), stats.SharesSubmitted)
}

func TestServer_Mining_SetDifficulty(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := setupTestServer(t, logger)
	defer server.Stop()

	client := connectTestClient(t, server)
	defer client.Close()

	setupMiningClient(t, client)

	// Server should send difficulty notification
	notification := readNotification(t, client)
	assert.Equal(t, "mining.set_difficulty", notification["method"])
	assert.NotNil(t, notification["params"])
}

func TestServer_Mining_Notify(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := setupTestServer(t, logger)
	defer server.Stop()

	client := connectTestClient(t, server)
	defer client.Close()

	setupMiningClient(t, client)

	// Trigger new job
	server.BroadcastNewJob()

	// Should receive job notification
	notification := readNotification(t, client)
	assert.Equal(t, "mining.notify", notification["method"])
	
	params := notification["params"].([]interface{})
	assert.GreaterOrEqual(t, len(params), 8)
}

func TestServer_MaxClients(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := &Config{
		Host:       "127.0.0.1",
		Port:       0,
		MaxClients: 2,
		Difficulty: 1.0,
		AuthMode:   AuthModeNone,
	}

	server, err := NewServer(logger, config)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)
	defer server.Stop()

	// Connect max clients
	clients := make([]net.Conn, config.MaxClients)
	for i := 0; i < config.MaxClients; i++ {
		conn, err := net.Dial("tcp", server.listener.Addr().String())
		require.NoError(t, err)
		clients[i] = conn
		defer conn.Close()
	}

	// Wait for connections to be established
	time.Sleep(200 * time.Millisecond)

	// Try to connect one more client
	conn, err := net.Dial("tcp", server.listener.Addr().String())
	if err == nil {
		defer conn.Close()
		// Should be disconnected soon
		time.Sleep(200 * time.Millisecond)
		
		// Try to read, should fail
		buf := make([]byte, 1)
		_, err = conn.Read(buf)
		assert.Error(t, err)
	}
}

func TestServer_ClientDisconnection(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := setupTestServer(t, logger)
	defer server.Stop()

	// Connect multiple clients
	clients := make([]net.Conn, 3)
	for i := 0; i < 3; i++ {
		conn, err := net.Dial("tcp", server.listener.Addr().String())
		require.NoError(t, err)
		clients[i] = conn
	}

	// Wait for connections
	time.Sleep(100 * time.Millisecond)
	stats := server.GetStats()
	assert.Equal(t, 3, stats.ActiveClients)

	// Disconnect one client
	clients[1].Close()

	// Wait for server to detect disconnection
	time.Sleep(100 * time.Millisecond)
	stats = server.GetStats()
	assert.Equal(t, 2, stats.ActiveClients)

	// Clean up
	clients[0].Close()
	clients[2].Close()
}

func TestServer_ConcurrentClients(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := setupTestServer(t, logger)
	defer server.Stop()

	numClients := 10
	var wg sync.WaitGroup

	for i := 0; i < numClients; i++ {
		wg.Add(1)
		go func(clientID int) {
			defer wg.Done()

			client := connectTestClient(t, server)
			defer client.Close()

			// Each client subscribes and submits shares
			setupMiningClient(t, client)

			// Submit a few shares
			for j := 0; j < 5; j++ {
				submit := &Request{
					ID:     uint64(100 + j),
					Method: "mining.submit",
					Params: []interface{}{
						fmt.Sprintf("worker%d", clientID),
						fmt.Sprintf("job%d", j),
						"00000000",
						time.Now().Unix(),
						fmt.Sprintf("%08x", j),
					},
				}

				err := sendRequest(client, submit)
				assert.NoError(t, err)

				response := readResponse(t, client)
				assert.Nil(t, response["error"])
			}
		}(i)
	}

	wg.Wait()

	// Verify stats
	stats := server.GetStats()
	assert.Equal(t, uint64(numClients*5), stats.SharesSubmitted)
}

func TestServer_InvalidRequests(t *testing.T) {
	logger := zaptest.NewLogger(t)
	server := setupTestServer(t, logger)
	defer server.Stop()

	client := connectTestClient(t, server)
	defer client.Close()

	tests := []struct {
		name    string
		request string
		wantErr bool
	}{
		{
			name:    "Invalid JSON",
			request: "{invalid json}",
			wantErr: true,
		},
		{
			name:    "Missing method",
			request: `{"id":1,"params":[]}`,
			wantErr: true,
		},
		{
			name:    "Unknown method",
			request: `{"id":1,"method":"unknown.method","params":[]}`,
			wantErr: true,
		},
		{
			name:    "Invalid params type",
			request: `{"id":1,"method":"mining.subscribe","params":"not-array"}`,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := client.Write([]byte(tt.request + "\n"))
			require.NoError(t, err)

			response := readResponse(t, client)
			if tt.wantErr {
				assert.NotNil(t, response["error"])
			}
		})
	}
}

// Benchmark tests

func BenchmarkServer_HandleRequest(b *testing.B) {
	logger := zaptest.NewLogger(b)
	server := setupTestServer(b, logger)
	defer server.Stop()

	client := connectTestClient(b, server)
	defer client.Close()

	setupMiningClient(b, client)

	b.ResetTimer()

	for i := 0; i < b.N; i++ {
		submit := &Request{
			ID:     uint64(1000 + i),
			Method: "mining.submit",
			Params: []interface{}{
				"benchmark.worker",
				fmt.Sprintf("job%d", i),
				"00000000",
				time.Now().Unix(),
				fmt.Sprintf("%08x", i),
			},
		}

		err := sendRequest(client, submit)
		if err != nil {
			b.Fatal(err)
		}

		response := readResponse(b, client)
		if response["error"] != nil {
			b.Fatal("unexpected error in response")
		}
	}
}

func BenchmarkServer_ConcurrentClients(b *testing.B) {
	logger := zaptest.NewLogger(b)
	server := setupTestServer(b, logger)
	defer server.Stop()

	b.RunParallel(func(pb *testing.PB) {
		client := connectTestClient(b, server)
		defer client.Close()

		setupMiningClient(b, client)

		i := 0
		for pb.Next() {
			submit := &Request{
				ID:     uint64(10000 + i),
				Method: "mining.submit",
				Params: []interface{}{
					"bench.worker",
					fmt.Sprintf("job%d", i),
					"00000000",
					time.Now().Unix(),
					fmt.Sprintf("%08x", i),
				},
			}

			sendRequest(client, submit)
			readResponse(b, client)
			i++
		}
	})
}

// Helper functions

func setupTestServer(t testing.TB, logger *zap.Logger) *Server {
	config := &Config{
		Host:       "127.0.0.1",
		Port:       0,
		MaxClients: 100,
		Difficulty: 1.0,
		AuthMode:   AuthModeNone,
	}

	server, err := NewServer(logger, config)
	require.NoError(t, err)

	err = server.Start()
	require.NoError(t, err)

	// Wait for server to be ready
	time.Sleep(100 * time.Millisecond)

	return server
}

func connectTestClient(t testing.TB, server *Server) net.Conn {
	conn, err := net.Dial("tcp", server.listener.Addr().String())
	require.NoError(t, err)
	return conn
}

func setupMiningClient(t testing.TB, conn net.Conn) {
	// Subscribe
	subscribe := &Request{
		ID:     1,
		Method: "mining.subscribe",
		Params: []interface{}{"test-miner/1.0"},
	}
	sendRequest(conn, subscribe)
	readResponse(t, conn)

	// Authorize
	authorize := &Request{
		ID:     2,
		Method: "mining.authorize",
		Params: []interface{}{"test.worker", "x"},
	}
	sendRequest(conn, authorize)
	readResponse(t, conn)

	// Clear any notifications
	conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		// Drain notifications
	}
	conn.SetReadDeadline(time.Time{})
}

func sendRequest(conn net.Conn, req *Request) error {
	data, err := json.Marshal(req)
	if err != nil {
		return err
	}
	_, err = conn.Write(append(data, '\n'))
	return err
}

func readResponse(t testing.TB, conn net.Conn) map[string]interface{} {
	scanner := bufio.NewScanner(conn)
	require.True(t, scanner.Scan())
	
	var response map[string]interface{}
	err := json.Unmarshal(scanner.Bytes(), &response)
	require.NoError(t, err)
	
	return response
}

func readNotification(t testing.TB, conn net.Conn) map[string]interface{} {
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	defer conn.SetReadDeadline(time.Time{})

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		var msg map[string]interface{}
		err := json.Unmarshal(scanner.Bytes(), &msg)
		if err == nil && msg["id"] == nil {
			// This is a notification (no ID)
			return msg
		}
	}
	
	t.Fatal("no notification received")
	return nil
}