package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"go.uber.org/zap/zaptest"
)

func TestNewServer(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Enabled:    true,
		ListenAddr: ":18080",
		EnableTLS:  false,
		RateLimit:  100,
	}
	
	server, err := NewServer(config, logger)
	if err != nil {
		t.Fatalf("Failed to create server: %v", err)
	}
	
	if server == nil {
		t.Fatal("Server should not be nil")
	}
}

func TestServerDisabled(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Enabled: false,
	}
	
	_, err := NewServer(config, logger)
	if err == nil {
		t.Error("Expected error when API server is disabled")
	}
}

func TestStatusHandler(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Enabled:    true,
		ListenAddr: ":18081",
		EnableTLS:  false,
		RateLimit:  100,
	}
	
	server, err := NewServer(config, logger)
	if err != nil {
		t.Fatalf("Failed to create server: %v", err)
	}
	
	// Create test request
	req, err := http.NewRequest("GET", "/api/v1/status", nil)
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}
	
	// Create response recorder
	rr := httptest.NewRecorder()
	
	// Call handler
	server.router.ServeHTTP(rr, req)
	
	// Check status code
	if status := rr.Code; status != http.StatusOK {
		t.Errorf("Expected status %d, got %d", http.StatusOK, status)
	}
	
	// Check response
	var response Response
	err = json.Unmarshal(rr.Body.Bytes(), &response)
	if err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}
	
	if !response.Success {
		t.Error("Expected success = true")
	}
	
	if response.Data == nil {
		t.Error("Expected data to be present")
	}
}

func TestStatsHandler(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Enabled:    true,
		ListenAddr: ":18082",
		EnableTLS:  false,
		RateLimit:  100,
	}
	
	server, err := NewServer(config, logger)
	if err != nil {
		t.Fatalf("Failed to create server: %v", err)
	}
	
	// Update stats
	testStats := map[string]interface{}{
		"test_metric": 123,
		"test_string": "value",
	}
	server.UpdateStats(testStats)
	
	// Create test request
	req, err := http.NewRequest("GET", "/api/v1/stats", nil)
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}
	
	// Create response recorder
	rr := httptest.NewRecorder()
	
	// Call handler
	server.router.ServeHTTP(rr, req)
	
	// Check status code
	if status := rr.Code; status != http.StatusOK {
		t.Errorf("Expected status %d, got %d", http.StatusOK, status)
	}
	
	// Check response
	var response Response
	err = json.Unmarshal(rr.Body.Bytes(), &response)
	if err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}
	
	if !response.Success {
		t.Error("Expected success = true")
	}
	
	// Check that our test stats are present
	dataMap, ok := response.Data.(map[string]interface{})
	if !ok {
		t.Fatal("Expected data to be a map")
	}
	
	if dataMap["test_metric"] != float64(123) { // JSON unmarshaling converts numbers to float64
		t.Errorf("Expected test_metric = 123, got %v", dataMap["test_metric"])
	}
}

func TestHealthHandler(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Enabled:    true,
		ListenAddr: ":18083",
		EnableTLS:  false,
		RateLimit:  100,
	}
	
	server, err := NewServer(config, logger)
	if err != nil {
		t.Fatalf("Failed to create server: %v", err)
	}
	
	// Create test request
	req, err := http.NewRequest("GET", "/api/v1/health", nil)
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}
	
	// Create response recorder
	rr := httptest.NewRecorder()
	
	// Call handler
	server.router.ServeHTTP(rr, req)
	
	// Check status code
	if status := rr.Code; status != http.StatusOK {
		t.Errorf("Expected status %d, got %d", http.StatusOK, status)
	}
	
	// Check response
	var response Response
	err = json.Unmarshal(rr.Body.Bytes(), &response)
	if err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}
	
	if !response.Success {
		t.Error("Expected success = true")
	}
}

func TestMiningStatsHandler(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Enabled:    true,
		ListenAddr: ":18084",
		EnableTLS:  false,
		RateLimit:  100,
	}
	
	server, err := NewServer(config, logger)
	if err != nil {
		t.Fatalf("Failed to create server: %v", err)
	}
	
	// Create test request
	req, err := http.NewRequest("GET", "/api/v1/mining/stats", nil)
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}
	
	// Create response recorder
	rr := httptest.NewRecorder()
	
	// Call handler
	server.router.ServeHTTP(rr, req)
	
	// Check status code
	if status := rr.Code; status != http.StatusOK {
		t.Errorf("Expected status %d, got %d", http.StatusOK, status)
	}
	
	// Check response contains mining stats
	var response Response
	err = json.Unmarshal(rr.Body.Bytes(), &response)
	if err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}
	
	if !response.Success {
		t.Error("Expected success = true")
	}
	
	dataMap, ok := response.Data.(map[string]interface{})
	if !ok {
		t.Fatal("Expected data to be a map")
	}
	
	// Check for expected mining stats fields
	expectedFields := []string{"hash_rate", "valid_shares", "difficulty", "algorithm", "threads", "running"}
	for _, field := range expectedFields {
		if _, exists := dataMap[field]; !exists {
			t.Errorf("Expected field %s to be present in mining stats", field)
		}
	}
}

func TestCORSMiddleware(t *testing.T) {
	logger := zaptest.NewLogger(t)
	
	config := Config{
		Enabled:    true,
		ListenAddr: ":18085",
		EnableTLS:  false,
		RateLimit:  100,
	}
	
	server, err := NewServer(config, logger)
	if err != nil {
		t.Fatalf("Failed to create server: %v", err)
	}
	
	// Create OPTIONS request
	req, err := http.NewRequest("OPTIONS", "/api/v1/status", nil)
	if err != nil {
		t.Fatalf("Failed to create request: %v", err)
	}
	
	// Create response recorder
	rr := httptest.NewRecorder()
	
	// Call handler
	server.router.ServeHTTP(rr, req)
	
	// Check status code
	if status := rr.Code; status != http.StatusOK {
		t.Errorf("Expected status %d for OPTIONS request, got %d", http.StatusOK, status)
	}
	
	// Check CORS headers
	if header := rr.Header().Get("Access-Control-Allow-Origin"); header != "*" {
		t.Errorf("Expected Access-Control-Allow-Origin header to be '*', got '%s'", header)
	}
	
	if header := rr.Header().Get("Access-Control-Allow-Methods"); header == "" {
		t.Error("Expected Access-Control-Allow-Methods header to be present")
	}
}

func BenchmarkStatusHandler(b *testing.B) {
	logger := zaptest.NewLogger(b)
	
	config := Config{
		Enabled:    true,
		ListenAddr: ":18086",
		EnableTLS:  false,
		RateLimit:  100,
	}
	
	server, err := NewServer(config, logger)
	if err != nil {
		b.Fatalf("Failed to create server: %v", err)
	}
	
	req, err := http.NewRequest("GET", "/api/v1/status", nil)
	if err != nil {
		b.Fatalf("Failed to create request: %v", err)
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rr := httptest.NewRecorder()
		server.router.ServeHTTP(rr, req)
	}
}
