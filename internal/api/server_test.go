package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewServer(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
		CORS: struct {
			Enabled bool
			Origins []string
			MaxAge  int
		}{
			Enabled: true,
			Origins: []string{"*"},
			MaxAge:  3600,
		},
		Auth: struct {
			Enabled            bool
			JWTSecret          string
			TokenExpiry        time.Duration
			RefreshTokenExpiry time.Duration
		}{
			Enabled:     false,
			TokenExpiry: 24 * time.Hour,
		},
	}
	
	server := NewServer(logger, config)
	
	assert.NotNil(t, server)
	assert.NotNil(t, server.router)
	assert.NotNil(t, server.wsClients)
	assert.NotNil(t, server.broadcast)
}

func TestHealthEndpoints(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
	}
	
	server := NewServer(logger, config)
	
	tests := []struct {
		name       string
		endpoint   string
		method     string
		statusCode int
	}{
		{
			name:       "Health check",
			endpoint:   "/health",
			method:     "GET",
			statusCode: http.StatusOK,
		},
		{
			name:       "Liveness probe",
			endpoint:   "/health/live",
			method:     "GET",
			statusCode: http.StatusOK,
		},
		{
			name:       "Readiness probe",
			endpoint:   "/health/ready",
			method:     "GET",
			statusCode: http.StatusServiceUnavailable, // No mining engine set
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, err := http.NewRequest(tt.method, tt.endpoint, nil)
			require.NoError(t, err)
			
			rr := httptest.NewRecorder()
			server.router.ServeHTTP(rr, req)
			
			assert.Equal(t, tt.statusCode, rr.Code)
		})
	}
}

func TestStatusEndpoint(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
	}
	
	server := NewServer(logger, config)
	
	req, err := http.NewRequest("GET", "/api/v1/status", nil)
	require.NoError(t, err)
	
	rr := httptest.NewRecorder()
	server.router.ServeHTTP(rr, req)
	
	assert.Equal(t, http.StatusOK, rr.Code)
	
	var response map[string]interface{}
	err = json.Unmarshal(rr.Body.Bytes(), &response)
	require.NoError(t, err)
	
	assert.Equal(t, "online", response["status"])
	assert.Contains(t, response, "version")
	assert.Contains(t, response, "uptime")
	assert.Contains(t, response, "system")
}

func TestInfoEndpoint(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
	}
	
	server := NewServer(logger, config)
	
	req, err := http.NewRequest("GET", "/api/v1/info", nil)
	require.NoError(t, err)
	
	rr := httptest.NewRecorder()
	server.router.ServeHTTP(rr, req)
	
	assert.Equal(t, http.StatusOK, rr.Code)
	
	var response map[string]interface{}
	err = json.Unmarshal(rr.Body.Bytes(), &response)
	require.NoError(t, err)
	
	assert.Equal(t, "Otedama", response["name"])
	assert.Contains(t, response, "features")
	assert.Contains(t, response, "algorithms")
}

func TestMiningEndpoints(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
	}
	
	server := NewServer(logger, config)
	
	// Set mock mining engine
	mockEngine := &mockMiningEngine{
		running: false,
		stats: map[string]interface{}{
			"hashrate": uint64(1000000),
			"shares":   uint64(100),
		},
	}
	server.SetMiningEngine(mockEngine)
	
	// Test stats endpoint
	req, err := http.NewRequest("GET", "/api/v1/mining/stats", nil)
	require.NoError(t, err)
	
	rr := httptest.NewRecorder()
	server.router.ServeHTTP(rr, req)
	
	assert.Equal(t, http.StatusOK, rr.Code)
	
	var stats map[string]interface{}
	err = json.Unmarshal(rr.Body.Bytes(), &stats)
	require.NoError(t, err)
	
	assert.Equal(t, uint64(1000000), uint64(stats["hashrate"].(float64)))
}

func TestCORSMiddleware(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
		CORS: struct {
			Enabled bool
			Origins []string
			MaxAge  int
		}{
			Enabled: true,
			Origins: []string{"{{.FRONTEND_URL}}"},
			MaxAge:  3600,
		},
	}
	
	server := NewServer(logger, config)
	
	req, err := http.NewRequest("OPTIONS", "/api/v1/status", nil)
	require.NoError(t, err)
	req.Header.Set("Origin", "{{.FRONTEND_URL}}")
	
	rr := httptest.NewRecorder()
	server.router.ServeHTTP(rr, req)
	
	assert.Equal(t, http.StatusNoContent, rr.Code)
	assert.Equal(t, "{{.FRONTEND_URL}}", rr.Header().Get("Access-Control-Allow-Origin"))
	assert.Contains(t, rr.Header().Get("Access-Control-Allow-Methods"), "GET")
}

func TestRateLimiting(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
		RateLimit: struct {
			Enabled           bool
			RequestsPerMinute int
			Burst             int
			Endpoints         []EndpointLimit
		}{
			Enabled:           true,
			RequestsPerMinute: 10,
			Burst:             2,
		},
	}
	
	server := NewServer(logger, config)
	
	// Set mock security manager
	mockSecurity := &mockSecurityManager{
		rateLimitAllowed: true,
	}
	server.SetSecurity(mockSecurity)
	
	// Test rate limiting
	for i := 0; i < 5; i++ {
		req, err := http.NewRequest("GET", "/api/v1/status", nil)
		require.NoError(t, err)
		
		rr := httptest.NewRecorder()
		server.router.ServeHTTP(rr, req)
		
		if i < 2 {
			assert.Equal(t, http.StatusOK, rr.Code)
		}
	}
}

func TestWebSocketUpgrade(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
	}
	
	server := NewServer(logger, config)
	
	// Create test server
	ts := httptest.NewServer(server.router)
	defer ts.Close()
	
	// Test WebSocket endpoint exists
	req, err := http.NewRequest("GET", "/ws", nil)
	require.NoError(t, err)
	req.Header.Set("Connection", "upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	
	rr := httptest.NewRecorder()
	server.router.ServeHTTP(rr, req)
	
	// Should attempt upgrade (will fail in test environment)
	assert.NotEqual(t, http.StatusNotFound, rr.Code)
}

func TestAuthentication(t *testing.T) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
		Auth: struct {
			Enabled            bool
			JWTSecret          string
			TokenExpiry        time.Duration
			RefreshTokenExpiry time.Duration
		}{
			Enabled:   true,
			JWTSecret: "test-secret",
		},
	}
	
	server := NewServer(logger, config)
	
	// Set mock security manager
	mockSecurity := &mockSecurityManager{
		validToken: false,
	}
	server.SetSecurity(mockSecurity)
	
	// Test protected endpoint without auth
	req, err := http.NewRequest("POST", "/api/v1/mining/start", nil)
	require.NoError(t, err)
	
	rr := httptest.NewRecorder()
	server.router.ServeHTTP(rr, req)
	
	assert.Equal(t, http.StatusUnauthorized, rr.Code)
	
	// Test with invalid token
	req.Header.Set("Authorization", "Bearer invalid-token")
	rr = httptest.NewRecorder()
	server.router.ServeHTTP(rr, req)
	
	assert.Equal(t, http.StatusUnauthorized, rr.Code)
}

// Mock implementations for testing

type mockMiningEngine struct {
	running bool
	stats   map[string]interface{}
}

func (m *mockMiningEngine) GetStatistics() map[string]interface{} {
	return m.stats
}

func (m *mockMiningEngine) Start() error {
	m.running = true
	return nil
}

func (m *mockMiningEngine) Stop() error {
	m.running = false
	return nil
}

func (m *mockMiningEngine) SetPowerLimit(watts float64) error {
	return nil
}

func (m *mockMiningEngine) SetTemperatureLimit(celsius float64) error {
	return nil
}

func (m *mockMiningEngine) GetWorkers() []interface{} {
	return []interface{}{}
}

type mockSecurityManager struct {
	validToken       bool
	rateLimitAllowed bool
}

func (m *mockSecurityManager) ValidateJWT(token string) (*JWTClaims, error) {
	if m.validToken {
		return &JWTClaims{
			UserID:    "test-user",
			Username:  "test",
			Role:      "admin",
			ExpiresAt: time.Now().Add(1 * time.Hour),
		}, nil
	}
	return nil, assert.AnError
}

func (m *mockSecurityManager) GenerateJWT(userID string, claims map[string]interface{}) (string, error) {
	return "test-token", nil
}

func (m *mockSecurityManager) CheckRateLimit(ip string, requests int) bool {
	return m.rateLimitAllowed
}

func (m *mockSecurityManager) IsIPAllowed(ip string) bool {
	return true
}

// Benchmark tests

func BenchmarkStatusEndpoint(b *testing.B) {
	logger := zap.NewNop()
	config := &Config{
		Enable:  true,
		Address: ":8080",
	}
	
	server := NewServer(logger, config)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req, _ := http.NewRequest("GET", "/api/v1/status", nil)
		rr := httptest.NewRecorder()
		server.router.ServeHTTP(rr, req)
	}
}

func BenchmarkJSONSerialization(b *testing.B) {
	data := map[string]interface{}{
		"status":    "online",
		"hashrate":  1000000,
		"shares":    100,
		"timestamp": time.Now(),
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		buf := &bytes.Buffer{}
		json.NewEncoder(buf).Encode(data)
	}
}
