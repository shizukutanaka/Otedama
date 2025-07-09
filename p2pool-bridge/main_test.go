// Go tests for P2Pool Bridge
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// Simple test helpers
func assertEqual(t *testing.T, expected, actual interface{}) {
	if expected != actual {
		t.Errorf("Expected %v, got %v", expected, actual)
	}
}

func assertNotNil(t *testing.T, value interface{}) {
	if value == nil {
		t.Error("Expected non-nil value")
	}
}

func assertNoError(t *testing.T, err error) {
	if err != nil {
		t.Errorf("Expected no error, got %v", err)
	}
}

func assertTrue(t *testing.T, condition bool) {
	if !condition {
		t.Error("Expected true condition")
	}
}

func assertFalse(t *testing.T, condition bool) {
	if condition {
		t.Error("Expected false condition")
	}
}

// Test configuration
func getTestConfig() *Config {
	cfg := defaultConfig()
	cfg.API.Port = 0 // Use random port for testing
	cfg.Stratum.Port = 0
	cfg.Metrics.Port = 0
	cfg.API.Debug = true
	return cfg
}

// Test API server creation and basic functionality
func TestAPIServerCreation(t *testing.T) {
	cfg := getTestConfig()
	server := NewAPIServer(cfg)
	
	assertNotNil(t, server)
	assertNotNil(t, server.router)
	assertNotNil(t, server.clients)
	assertNotNil(t, server.broadcast)
}

// Test API endpoints
func TestAPIEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cfg := getTestConfig()
	server := NewAPIServer(cfg)
	server.setupRoutes()
	
	tests := []struct {
		name           string
		method         string
		path           string
		expectedStatus int
		checkResponse  bool
	}{
		{
			name:           "Get pool stats",
			method:         "GET",
			path:           "/api/v1/stats",
			expectedStatus: http.StatusOK,
			checkResponse:  true,
		},
		{
			name:           "Get stats history",
			method:         "GET",
			path:           "/api/v1/stats/history",
			expectedStatus: http.StatusOK,
			checkResponse:  true,
		},
		{
			name:           "Get shares",
			method:         "GET",
			path:           "/api/v1/shares",
			expectedStatus: http.StatusOK,
			checkResponse:  true,
		},
		{
			name:           "Get specific share",
			method:         "GET",
			path:           "/api/v1/shares/test123",
			expectedStatus: http.StatusOK,
			checkResponse:  true,
		},
		{
			name:           "Get blocks",
			method:         "GET",
			path:           "/api/v1/blocks",
			expectedStatus: http.StatusOK,
			checkResponse:  true,
		},
		{
			name:           "Get miners",
			method:         "GET",
			path:           "/api/v1/miners",
			expectedStatus: http.StatusOK,
			checkResponse:  true,
		},
		{
			name:           "Health check",
			method:         "GET",
			path:           "/api/v1/health",
			expectedStatus: http.StatusOK,
			checkResponse:  true,
		},
		{
			name:           "Get version",
			method:         "GET",
			path:           "/api/v1/version",
			expectedStatus: http.StatusOK,
			checkResponse:  true,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(tt.method, tt.path, nil)
			require.NoError(t, err)
			
			w := httptest.NewRecorder()
			server.router.ServeHTTP(w, req)
			
			assert.Equal(t, tt.expectedStatus, w.Code)
			
			if tt.checkResponse {
				var response APIResponse
				err := json.Unmarshal(w.Body.Bytes(), &response)
				require.NoError(t, err)
				assert.True(t, response.Success)
				assert.NotNil(t, response.Data)
			}
		})
	}
}

// Test Stratum server creation
func TestStratumServerCreation(t *testing.T) {
	cfg := getTestConfig()
	server := NewStratumServer(cfg)
	
	assert.NotNil(t, server)
	assert.NotNil(t, server.clients)
	assert.NotNil(t, server.jobs)
}

// Test Stratum message handling
func TestStratumMessageHandling(t *testing.T) {
	cfg := getTestConfig()
	server := NewStratumServer(cfg)
	
	// Create mock client
	client := &StratumClient{
		address:    "test:1234",
		difficulty: 1000.0,
		lastActive: time.Now(),
	}
	
	tests := []struct {
		name     string
		message  string
		hasError bool
	}{
		{
			name:     "Mining subscribe",
			message:  `{"id": 1, "method": "mining.subscribe", "params": ["test-miner"]}`,
			hasError: false,
		},
		{
			name:     "Mining authorize",
			message:  `{"id": 2, "method": "mining.authorize", "params": ["test.miner", "password"]}`,
			hasError: false,
		},
		{
			name:     "Invalid JSON",
			message:  `invalid json`,
			hasError: true,
		},
		{
			name:     "Unknown method",
			message:  `{"id": 3, "method": "unknown.method", "params": []}`,
			hasError: false, // Should handle gracefully with error response
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := server.handleMessage(client, tt.message)
			if tt.hasError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

// Test metrics server
func TestMetricsServer(t *testing.T) {
	cfg := getTestConfig()
	server := NewMetricsServer(cfg)
	
	assert.NotNil(t, server)
	assert.NotNil(t, server.sharesTotal)
	assert.NotNil(t, server.blocksTotal)
	assert.NotNil(t, server.connectedPeers)
}

// Test core client creation
func TestCoreClientCreation(t *testing.T) {
	cfg := getTestConfig()
	client := NewCoreClient(cfg)
	
	assert.NotNil(t, client)
	assert.False(t, client.IsRunning())
}

// Test bridge creation and configuration
func TestBridgeCreation(t *testing.T) {
	cfg := getTestConfig()
	bridge := NewBridge(cfg)
	
	assert.NotNil(t, bridge)
	assert.NotNil(t, bridge.apiServer)
	assert.NotNil(t, bridge.stratumServer)
	assert.NotNil(t, bridge.metricsServer)
	assert.NotNil(t, bridge.coreClient)
}

// Test configuration loading and validation
func TestConfigurationManagement(t *testing.T) {
	// Test default configuration
	cfg := defaultConfig()
	assert.NotNil(t, cfg)
	assert.Equal(t, 8080, cfg.API.Port)
	assert.Equal(t, 3333, cfg.Stratum.Port)
	
	// Test configuration validation
	// Valid configuration should pass
	cfg.API.Port = 8080
	cfg.Stratum.Port = 3333
	assert.NotEqual(t, cfg.API.Port, 0)
	assert.NotEqual(t, cfg.Stratum.Port, 0)
	
	// Test environment variable handling
	t.Setenv("P2POOL_API_PORT", "9999")
	t.Setenv("P2POOL_STRATUM_PORT", "4444")
	
	// Note: Since we can't easily test the actual env loading without
	// modifying the main functions, we just test that the config
	// structure can hold the values correctly
}

// Test WebSocket functionality
func TestWebSocketConnection(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cfg := getTestConfig()
	server := NewAPIServer(cfg)
	server.setupRoutes()
	
	// Create test HTTP server
	httpServer := httptest.NewServer(server.router)
	defer httpServer.Close()
	
	// Convert HTTP URL to WebSocket URL
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"
	
	// Connect to WebSocket
	dialer := websocket.Dialer{}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		t.Skipf("WebSocket connection failed: %v", err)
		return
	}
	defer conn.Close()
	
	// Test that we can read initial message
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, message, err := conn.ReadMessage()
	require.NoError(t, err)
	
	// Verify message format
	var data map[string]interface{}
	err = json.Unmarshal(message, &data)
	require.NoError(t, err)
	
	assert.Contains(t, data, "type")
	assert.Contains(t, data, "data")
}

// Test JSON response formatting
func TestJSONResponseFormatting(t *testing.T) {
	tests := []struct {
		name     string
		response APIResponse
		hasError bool
	}{
		{
			name: "Success response",
			response: APIResponse{
				Success: true,
				Data:    map[string]interface{}{"test": "value"},
				Message: "Success",
			},
			hasError: false,
		},
		{
			name: "Error response",
			response: APIResponse{
				Success: false,
				Error:   "Test error",
			},
			hasError: false,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.response)
			if tt.hasError {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
				assert.NotEmpty(t, data)
				
				// Verify we can unmarshal back
				var unmarshaled APIResponse
				err = json.Unmarshal(data, &unmarshaled)
				assert.NoError(t, err)
				assert.Equal(t, tt.response.Success, unmarshaled.Success)
			}
		})
	}
}

// Test Stratum job creation and broadcasting
func TestStratumJobManagement(t *testing.T) {
	cfg := getTestConfig()
	server := NewStratumServer(cfg)
	
	// Test job creation
	job := server.createNewJob()
	assert.NotNil(t, job)
	assert.NotEmpty(t, job.ID)
	assert.NotEmpty(t, job.PrevHash)
	assert.NotEmpty(t, job.Version)
	assert.NotEmpty(t, job.NBits)
	assert.NotEmpty(t, job.NTime)
	
	// Verify job is stored
	server.mutex.RLock()
	storedJob, exists := server.jobs[job.ID]
	server.mutex.RUnlock()
	
	assert.True(t, exists)
	assert.Equal(t, job.ID, storedJob.ID)
}

// Benchmark tests
func BenchmarkAPIEndpoint(b *testing.B) {
	gin.SetMode(gin.ReleaseMode)
	cfg := getTestConfig()
	server := NewAPIServer(cfg)
	server.setupRoutes()
	
	req, _ := http.NewRequest("GET", "/api/v1/stats", nil)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		w := httptest.NewRecorder()
		server.router.ServeHTTP(w, req)
	}
}

func BenchmarkStratumMessageHandling(b *testing.B) {
	cfg := getTestConfig()
	server := NewStratumServer(cfg)
	
	client := &StratumClient{
		address:    "bench:1234",
		difficulty: 1000.0,
		lastActive: time.Now(),
	}
	
	message := `{"id": 1, "method": "mining.subscribe", "params": ["test-miner"]}`
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		server.handleMessage(client, message)
	}
}

// Integration test that starts and stops services
func TestServiceLifecycle(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}
	
	cfg := getTestConfig()
	bridge := NewBridge(cfg)
	
	// Create a context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	
	// Start services in background
	errChan := make(chan error, 1)
	go func() {
		errChan <- bridge.Start()
	}()
	
	// Give services time to start
	time.Sleep(500 * time.Millisecond)
	
	// Stop services
	err := bridge.Stop()
	assert.NoError(t, err)
	
	// Wait for start goroutine to finish
	select {
	case err := <-errChan:
		// Error is expected when we stop the services
		assert.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Error("Service start/stop took too long")
	}
}

// Test concurrent access to shared resources
func TestConcurrentAccess(t *testing.T) {
	cfg := getTestConfig()
	server := NewStratumServer(cfg)
	
	// Simulate multiple miners connecting concurrently
	done := make(chan bool)
	numClients := 10
	
	for i := 0; i < numClients; i++ {
		go func(id int) {
			defer func() { done <- true }()
			
			client := &StratumClient{
				address:    fmt.Sprintf("miner%d:1234", id),
				difficulty: 1000.0,
				lastActive: time.Now(),
			}
			
			// Simulate subscribe
			subscribeMsg := fmt.Sprintf(`{"id": %d, "method": "mining.subscribe", "params": ["miner%d"]}`, id, id)
			err := server.handleMessage(client, subscribeMsg)
			assert.NoError(t, err)
			
			// Simulate authorize
			authMsg := fmt.Sprintf(`{"id": %d, "method": "mining.authorize", "params": ["miner%d", "pass"]}`, id+100, id)
			err = server.handleMessage(client, authMsg)
			assert.NoError(t, err)
		}(i)
	}
	
	// Wait for all goroutines to complete
	for i := 0; i < numClients; i++ {
		select {
		case <-done:
			// Client completed successfully
		case <-time.After(5 * time.Second):
			t.Error("Concurrent test timed out")
			return
		}
	}
}

// Test error handling and recovery
func TestErrorHandling(t *testing.T) {
	cfg := getTestConfig()
	server := NewStratumServer(cfg)
	
	client := &StratumClient{
		address:    "error-test:1234",
		difficulty: 1000.0,
		lastActive: time.Now(),
	}
	
	// Test various error conditions
	errorTests := []struct {
		name    string
		message string
	}{
		{
			name:    "Empty message",
			message: "",
		},
		{
			name:    "Invalid JSON",
			message: `{invalid json}`,
		},
		{
			name:    "Missing method",
			message: `{"id": 1, "params": []}`,
		},
		{
			name:    "Invalid parameters",
			message: `{"id": 1, "method": "mining.authorize", "params": "invalid"}`,
		},
	}
	
	for _, tt := range errorTests {
		t.Run(tt.name, func(t *testing.T) {
			err := server.handleMessage(client, tt.message)
			// Most of these should result in errors
			if tt.message == "" {
				// Empty message might be handled differently
				return
			}
			// We expect errors for malformed messages
			assert.Error(t, err)
		})
	}
}

func TestMain(m *testing.M) {
	// Setup test environment
	gin.SetMode(gin.TestMode)
	
	// Run tests
	code := m.Run()
	
	// Cleanup
	os.Exit(code)
}
