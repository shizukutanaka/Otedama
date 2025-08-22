package api

import (
	"net/http"
	"testing"
	"time"
)

func TestMultiRateLimiter(t *testing.T) {
	// Define endpoint-specific configurations
	endpointConfigs := []EndpointRateLimitConfig{
		{
			Path:              "/api/v1/specific",
			Methods:           []string{"GET"},
			RequestsPerMinute: 5,
			Burst:             1,
		},
	}

	// Create a new MultiRateLimiter with a global limit and one specific endpoint limit
	// Global: 10 rpm, Specific: 5 rpm
	mrl := NewMultiRateLimiter(10, 1, endpointConfigs)

	// --- Test Case 1: Specific Endpoint Rate Limiting --- //
	reqSpecific, _ := http.NewRequest("GET", "/api/v1/specific", nil)
	reqSpecific.RemoteAddr = "127.0.0.1:12345"

	// First request should be allowed by specific limiter (5 rpm)
	if !mrl.Allow(reqSpecific) {
		t.Error("Expected first request to specific endpoint to be allowed")
	}

	// Second request should be denied (burst is 1)
	if mrl.Allow(reqSpecific) {
		t.Error("Expected second request to specific endpoint to be denied")
	}

	// --- Test Case 2: Global Rate Limiting (Fallback) --- //
	reqGlobal, _ := http.NewRequest("GET", "/api/v1/global", nil)
	reqGlobal.RemoteAddr = "127.0.0.1:54321"

	// First request should be allowed by global limiter (10 rpm)
	if !mrl.Allow(reqGlobal) {
		t.Error("Expected first request to global endpoint to be allowed")
	}

	// Second request should be denied (burst is 1)
	if mrl.Allow(reqGlobal) {
		t.Error("Expected second request to global endpoint to be denied")
	}

	// --- Test Case 3: Different IPs should have different limiters --- //
	reqSpecific2, _ := http.NewRequest("GET", "/api/v1/specific", nil)
	reqSpecific2.RemoteAddr = "192.168.1.1:12345"

	// This request should be allowed as it's from a new IP
	if !mrl.Allow(reqSpecific2) {
		t.Error("Expected request from new IP to be allowed")
	}
}

func TestSingleRateLimiter_Cleanup(t *testing.T) {
	// Create a single rate limiter with a very short TTL for testing
	rl := newSingleRateLimiter(1, time.Minute, 1)
	rl.ttl = 100 * time.Millisecond

	// Add a visitor
	_ = rl.getVisitor("127.0.0.1:1111")

	if len(rl.visitors) != 1 {
		t.Fatalf("Expected 1 visitor, got %d", len(rl.visitors))
	}

	// Wait for longer than the TTL for cleanup to run
	time.Sleep(2 * time.Minute)

	rl.mu.RLock()
	defer rl.mu.RUnlock()
	if len(rl.visitors) != 0 {
		t.Errorf("Expected visitor to be cleaned up, but %d remain", len(rl.visitors))
	}
}
