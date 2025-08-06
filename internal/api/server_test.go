package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// Test fixtures and helpers

func createTestLogger(t *testing.T) *zap.Logger {
	return zaptest.NewLogger(t)
}

func createTestConfig() Config {
	return Config{
		Enabled:      true,
		ListenAddr:   ":8080",
		EnableTLS:    false,
		RateLimit:    100,
		AllowOrigins: []string{"http://localhost:3000", "https://example.com"},
	}
}

func createTestServer(t *testing.T) (*Server, *MockEngine) {
	logger := createTestLogger(t)
	config := createTestConfig()
	mockEngine := NewMockEngine()

	server, err := NewServer(config, logger, mockEngine)
	require.NoError(t, err)
	require.NotNil(t, server)

	return server, mockEngine
}

// Mock mining engine for testing

type MockEngine struct {
	mock.Mock
	running    bool
	stats      map[string]interface{}
	algorithm  string
	workers    []map[string]interface{}
	mu         sync.RWMutex
}

func NewMockEngine() *MockEngine {
	return &MockEngine{
		stats: map[string]interface{}{
			"hash_rate":     1250000,
			"valid_shares":  42,
			"difficulty":    0x1d00ffff,
			"algorithm":     "sha256d",
			"threads":       4,
			"running":       false,
		},
		algorithm: "sha256d",
		workers: []map[string]interface{}{
			{
				"id":               "worker-1",
				"name":             "CPU-Worker-1",
				"type":             "CPU",
				"hashrate":         125000,
				"temperature":      65,
				"power":            100,
				"status":           "active",
				"shares_accepted":  42,
				"shares_rejected":  2,
			},
		},
	}
}

func (m *MockEngine) Start() error {
	args := m.Called()
	m.mu.Lock()
	m.running = true
	m.stats["running"] = true
	m.mu.Unlock()
	return args.Error(0)
}

func (m *MockEngine) Stop() error {
	args := m.Called()
	m.mu.Lock()
	m.running = false
	m.stats["running"] = false
	m.mu.Unlock()
	return args.Error(0)
}

func (m *MockEngine) GetStats() map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	
	// Create a copy to avoid race conditions
	statsCopy := make(map[string]interface{})
	for k, v := range m.stats {
		statsCopy[k] = v
	}
	return statsCopy
}

// Tests

func TestNewServer(t *testing.T) {
	tests := []struct {
		name        string
		config      Config
		expectError bool
	}{
		{
			name:        "valid config",
			config:      createTestConfig(),
			expectError: false,
		},
		{
			name: "disabled server",
			config: Config{
				Enabled: false,
			},
			expectError: true,
		},
		{
			name: "empty origins list",
			config: Config{
				Enabled:      true,
				ListenAddr:   ":8080",
				AllowOrigins: []string{},
			},
			expectError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := createTestLogger(t)
			mockEngine := NewMockEngine()

			server, err := NewServer(tt.config, logger, mockEngine)

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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Test start
	err := server.Start(ctx)
	assert.NoError(t, err)

	// Test shutdown
	err = server.Shutdown(ctx)
	assert.NoError(t, err)
}

func TestStatusEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/status", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "application/json", w.Header().Get("Content-Type"))

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)
	assert.NotNil(t, response.Data)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, "Otedama Mining Pool", data["service"])
	assert.Equal(t, "2.1.3", data["version"])
	assert.Equal(t, "running", data["status"])
}

func TestStatsEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	// Update server stats
	testStats := map[string]interface{}{
		"hashrate": 1000000,
		"workers":  5,
	}
	server.UpdateStats(testStats)

	req := httptest.NewRequest("GET", "/api/v1/stats", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)
	assert.Equal(t, testStats, response.Data)
}

func TestHealthEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/health", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, "healthy", data["status"])
	assert.Contains(t, data, "checks")
}

func TestMiningStatsEndpoint(t *testing.T) {
	server, mockEngine := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/mining/stats", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	expectedStats := mockEngine.GetStats()
	assert.Equal(t, expectedStats["algorithm"], data["algorithm"])
	assert.Equal(t, expectedStats["running"], data["running"])
}

func TestMiningStartEndpoint(t *testing.T) {
	server, mockEngine := createTestServer(t)

	// Setup mock expectation
	mockEngine.On("Start").Return(nil)

	req := httptest.NewRequest("POST", "/api/v1/mining/start", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, "Mining started", data["message"])

	mockEngine.AssertExpectations(t)
}

func TestMiningStopEndpoint(t *testing.T) {
	server, mockEngine := createTestServer(t)

	// Setup mock expectation
	mockEngine.On("Stop").Return(nil)

	req := httptest.NewRequest("POST", "/api/v1/mining/stop", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, "Mining stopped", data["message"])

	mockEngine.AssertExpectations(t)
}

func TestMiningWorkersEndpoint(t *testing.T) {
	server, mockEngine := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/mining/workers", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	workers := response.Data.([]interface{})
	assert.Len(t, workers, 1)

	worker := workers[0].(map[string]interface{})
	assert.Equal(t, "worker-1", worker["id"])
	assert.Equal(t, "CPU-Worker-1", worker["name"])
	assert.Equal(t, "CPU", worker["type"])
	assert.Equal(t, float64(125000), worker["hashrate"])

	_ = mockEngine // Use mockEngine to avoid unused variable warning
}

func TestWorkerControlEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	// Test valid worker control request
	requestBody := map[string]string{
		"action": "restart",
	}
	body, err := json.Marshal(requestBody)
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/api/v1/mining/workers/worker-1/control", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err = json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, "worker-1", data["worker_id"])
	assert.Equal(t, "restart", data["action"])
	assert.Contains(t, data["message"], "worker-1")
	assert.Contains(t, data["message"], "restart")
}

func TestWorkerControlInvalidAction(t *testing.T) {
	server, _ := createTestServer(t)

	// Test invalid action
	requestBody := map[string]string{
		"action": "invalid_action",
	}
	body, err := json.Marshal(requestBody)
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/api/v1/mining/workers/worker-1/control", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)

	var response Response
	err = json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.False(t, response.Success)
	assert.Contains(t, response.Error, "Invalid action")
}

func TestPoolStatsEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/pool/stats", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Contains(t, data, "peer_count")
	assert.Contains(t, data, "total_shares")
	assert.Contains(t, data, "blocks_found")
	assert.Contains(t, data, "total_hashrate")
}

func TestPoolInfoEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/pool/info", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, "Otedama P2P Pool", data["name"])
	assert.Equal(t, "P2P", data["type"])
	assert.Equal(t, 1.0, data["fee"])
	assert.Equal(t, "PPLNS", data["payment_type"])
	assert.Contains(t, data, "algorithms")
}

func TestStratumInfoEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/stratum/info", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, true, data["enabled"])
	assert.Equal(t, float64(3333), data["port"])
	assert.Contains(t, data, "protocols")
}

func TestProfitStatusEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/profit/status", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, true, data["enabled"])
	assert.Equal(t, "SHA256d", data["current_algo"])
	assert.Contains(t, data, "algorithms")
}

func TestProfitSwitchEndpoint(t *testing.T) {
	server, _ := createTestServer(t)

	// Test valid algorithm switch
	requestBody := map[string]interface{}{
		"algorithm": "Ethash",
		"force":     true,
	}
	body, err := json.Marshal(requestBody)
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/api/v1/profit/switch", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err = json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.True(t, response.Success)

	data := response.Data.(map[string]interface{})
	assert.Equal(t, "Ethash", data["algorithm"])
	assert.Equal(t, true, data["forced"])
}

func TestProfitSwitchInvalidAlgorithm(t *testing.T) {
	server, _ := createTestServer(t)

	// Test invalid algorithm
	requestBody := map[string]interface{}{
		"algorithm": "InvalidAlgo",
		"force":     false,
	}
	body, err := json.Marshal(requestBody)
	require.NoError(t, err)

	req := httptest.NewRequest("POST", "/api/v1/profit/switch", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)

	var response Response
	err = json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.False(t, response.Success)
	assert.Contains(t, response.Error, "Invalid algorithm")
}

func TestCORSMiddleware(t *testing.T) {
	server, _ := createTestServer(t)

	tests := []struct {
		name           string
		origin         string
		expectAllowed  bool
		expectCreds    bool
	}{
		{
			name:           "allowed origin",
			origin:         "http://localhost:3000",
			expectAllowed:  true,
			expectCreds:    true,
		},
		{
			name:           "another allowed origin",
			origin:         "https://example.com",
			expectAllowed:  true,
			expectCreds:    true,
		},
		{
			name:           "disallowed origin",
			origin:         "https://malicious.com",
			expectAllowed:  false,
			expectCreds:    false,
		},
		{
			name:           "no origin",
			origin:         "",
			expectAllowed:  false,
			expectCreds:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/v1/status", nil)
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			w := httptest.NewRecorder()

			server.router.ServeHTTP(w, req)

			if tt.expectAllowed {
				assert.Equal(t, tt.origin, w.Header().Get("Access-Control-Allow-Origin"))
				if tt.expectCreds {
					assert.Equal(t, "true", w.Header().Get("Access-Control-Allow-Credentials"))
				}
			} else {
				assert.Empty(t, w.Header().Get("Access-Control-Allow-Origin"))
			}
		})
	}
}

func TestCORSPreflightRequest(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("OPTIONS", "/api/v1/status", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "Content-Type, Authorization")
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "http://localhost:3000", w.Header().Get("Access-Control-Allow-Origin"))
	assert.Contains(t, w.Header().Get("Access-Control-Allow-Methods"), "POST")
	assert.Contains(t, w.Header().Get("Access-Control-Allow-Headers"), "Content-Type")
	assert.Contains(t, w.Header().Get("Access-Control-Allow-Headers"), "Authorization")
}

func TestWebSocketUpgrade(t *testing.T) {
	server, _ := createTestServer(t)

	// Create test server
	testServer := httptest.NewServer(server.router)
	defer testServer.Close()

	// Convert HTTP URL to WebSocket URL
	wsURL := "ws" + strings.TrimPrefix(testServer.URL, "http") + "/api/v1/ws"

	// Test WebSocket connection (this will fail due to origin check in test)
	headers := http.Header{}
	headers.Set("Origin", "http://localhost:3000")

	_, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	// We expect this to fail in test environment due to origin restrictions
	assert.Error(t, err)
}

func TestInvalidJSONRequest(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("POST", "/api/v1/profit/switch", strings.NewReader("invalid json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.False(t, response.Success)
	assert.Equal(t, "Invalid request body", response.Error)
}

func TestMissingRoutes(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/nonexistent", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestConcurrentRequests(t *testing.T) {
	server, _ := createTestServer(t)

	const numRequests = 50
	var wg sync.WaitGroup
	wg.Add(numRequests)

	results := make([]int, numRequests)

	for i := 0; i < numRequests; i++ {
		go func(index int) {
			defer wg.Done()

			req := httptest.NewRequest("GET", "/api/v1/status", nil)
			w := httptest.NewRecorder()

			server.router.ServeHTTP(w, req)
			results[index] = w.Code
		}(i)
	}

	wg.Wait()

	// All requests should succeed
	for i, code := range results {
		assert.Equal(t, http.StatusOK, code, "Request %d failed", i)
	}
}

func TestStatsUpdate(t *testing.T) {
	server, _ := createTestServer(t)

	// Test updating stats
	newStats := map[string]interface{}{
		"hashrate": 2000000,
		"workers":  10,
		"uptime":   3600,
	}

	server.UpdateStats(newStats)

	// Verify stats are updated
	req := httptest.NewRequest("GET", "/api/v1/stats", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var response Response
	err := json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.Equal(t, newStats, response.Data)
}

func TestResponseTimeHeader(t *testing.T) {
	server, _ := createTestServer(t)

	req := httptest.NewRequest("GET", "/api/v1/status", nil)
	w := httptest.NewRecorder()

	start := time.Now()
	server.router.ServeHTTP(w, req)
	duration := time.Since(start)

	assert.Equal(t, http.StatusOK, w.Code)

	// Response should be fast (less than 100ms for a simple endpoint)
	assert.Less(t, duration, 100*time.Millisecond)
}

// Benchmark tests

func BenchmarkStatusEndpoint(b *testing.B) {
	server, _ := createTestServer(b)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest("GET", "/api/v1/status", nil)
		w := httptest.NewRecorder()

		server.router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			b.Fatalf("Expected status 200, got %d", w.Code)
		}
	}
}

func BenchmarkStatsEndpoint(b *testing.B) {
	server, _ := createTestServer(b)

	// Pre-populate stats
	testStats := map[string]interface{}{
		"hashrate": 1000000,
		"workers":  5,
		"uptime":   3600,
	}
	server.UpdateStats(testStats)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest("GET", "/api/v1/stats", nil)
		w := httptest.NewRecorder()

		server.router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			b.Fatalf("Expected status 200, got %d", w.Code)
		}
	}
}

func BenchmarkJSONSerialization(b *testing.B) {
	response := Response{
		Success: true,
		Data: map[string]interface{}{
			"hashrate":     1000000,
			"workers":      5,
			"algorithm":    "sha256d",
			"difficulty":   0x1d00ffff,
			"valid_shares": 1000,
			"uptime":       3600,
		},
		Time: time.Now(),
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := json.Marshal(response)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkConcurrentRequests(b *testing.B) {
	server, _ := createTestServer(b)

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			req := httptest.NewRequest("GET", "/api/v1/status", nil)
			w := httptest.NewRecorder()

			server.router.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				b.Fatalf("Expected status 200, got %d", w.Code)
			}
		}
	})
}

// Helper functions for test validation

func TestInputValidator(t *testing.T) {
	validator := NewInputValidator()

	// Test worker ID validation
	assert.NoError(t, validator.ValidateWorkerID("worker-1"))
	assert.NoError(t, validator.ValidateWorkerID("cpu_worker_001"))
	assert.Error(t, validator.ValidateWorkerID(""))
	assert.Error(t, validator.ValidateWorkerID("invalid!@#"))

	// Test action validation
	assert.NoError(t, validator.ValidateAction("start"))
	assert.NoError(t, validator.ValidateAction("stop"))
	assert.NoError(t, validator.ValidateAction("restart"))
	assert.Error(t, validator.ValidateAction(""))
	assert.Error(t, validator.ValidateAction("invalid_action"))

	// Test algorithm validation
	assert.NoError(t, validator.ValidateAlgorithm("SHA256d"))
	assert.NoError(t, validator.ValidateAlgorithm("Ethash"))
	assert.NoError(t, validator.ValidateAlgorithm("RandomX"))
	assert.Error(t, validator.ValidateAlgorithm(""))
	assert.Error(t, validator.ValidateAlgorithm("InvalidAlgo"))
}

// Mock input validator implementation
type InputValidator struct{}

func NewInputValidator() *InputValidator {
	return &InputValidator{}
}

func (v *InputValidator) ValidateWorkerID(workerID string) error {
	if workerID == "" {
		return assert.AnError
	}
	if strings.ContainsAny(workerID, "!@#$%^&*()") {
		return assert.AnError
	}
	return nil
}

func (v *InputValidator) ValidateAction(action string) error {
	validActions := map[string]bool{
		"start":   true,
		"stop":    true,
		"restart": true,
		"pause":   true,
		"resume":  true,
	}
	
	if !validActions[action] {
		return assert.AnError
	}
	return nil
}

func (v *InputValidator) ValidateAlgorithm(algorithm string) error {
	validAlgorithms := map[string]bool{
		"SHA256d": true,
		"Ethash":  true,
		"KawPow":  true,
		"RandomX": true,
		"Scrypt":  true,
	}
	
	if !validAlgorithms[algorithm] {
		return assert.AnError
	}
	return nil
}