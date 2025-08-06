package security

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Test fixtures and helpers

func createTestConfig() RateLimitConfig {
	return RateLimitConfig{
		RequestsPerSecond:  10,
		BurstSize:         20,
		CleanupInterval:   1 * time.Minute,
		ExpiryTime:        5 * time.Minute,
		EnableIPLimit:     true,
		EnableUserLimit:   true,
		TrustXForwardedFor: false,
		EndpointLimits: map[string]EndpointLimit{
			"/api/heavy": {
				RequestsPerSecond: 1,
				BurstSize:         2,
			},
		},
	}
}

func createTestRateLimiter() *RateLimiter {
	config := createTestConfig()
	return NewRateLimiter(config)
}

// Tests

func TestNewRateLimiter(t *testing.T) {
	tests := []struct {
		name   string
		config RateLimitConfig
	}{
		{
			name:   "valid config",
			config: createTestConfig(),
		},
		{
			name: "default values",
			config: RateLimitConfig{
				RequestsPerSecond: 0, // Should use default
				BurstSize:         0, // Should use default
			},
		},
		{
			name: "custom values",
			config: RateLimitConfig{
				RequestsPerSecond: 100,
				BurstSize:         200,
				CleanupInterval:   30 * time.Second,
				ExpiryTime:        10 * time.Minute,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rl := NewRateLimiter(tt.config)
			assert.NotNil(t, rl)
			assert.NotNil(t, rl.limiters)
			assert.NotNil(t, rl.whitelist)
			assert.NotNil(t, rl.blacklist)

			// Check default values are applied
			if tt.config.RequestsPerSecond <= 0 {
				assert.Equal(t, 10, rl.config.RequestsPerSecond)
			}
			if tt.config.BurstSize <= 0 {
				assert.Equal(t, 20, rl.config.BurstSize)
			}
		})
	}
}

func TestBasicRateLimiting(t *testing.T) {
	config := RateLimitConfig{
		RequestsPerSecond: 2, // Very low for testing
		BurstSize:         3,
		EnableIPLimit:     true,
	}
	rl := NewRateLimiter(config)

	key := "test_key"
	endpoint := "/api/test"

	// First few requests should be allowed (burst)
	for i := 0; i < 3; i++ {
		allowed := rl.Allow(key, endpoint)
		assert.True(t, allowed, "Request %d should be allowed", i+1)
	}

	// Next request should be denied (burst exhausted)
	allowed := rl.Allow(key, endpoint)
	assert.False(t, allowed, "Request should be denied after burst")

	// Wait for rate limit to replenish
	time.Sleep(600 * time.Millisecond) // Allow 1 more request

	allowed = rl.Allow(key, endpoint)
	assert.True(t, allowed, "Request should be allowed after waiting")
}

func TestAllowN(t *testing.T) {
	config := RateLimitConfig{
		RequestsPerSecond: 10,
		BurstSize:         20,
		EnableIPLimit:     true,
	}
	rl := NewRateLimiter(config)

	key := "test_key"
	endpoint := "/api/test"

	// Test allowing multiple events at once
	allowed := rl.AllowN(key, endpoint, 5)
	assert.True(t, allowed, "5 events should be allowed")

	allowed = rl.AllowN(key, endpoint, 15)
	assert.True(t, allowed, "15 more events should be allowed (total 20)")

	// This should exceed the burst
	allowed = rl.AllowN(key, endpoint, 1)
	assert.False(t, allowed, "1 more event should be denied")
}

func TestWait(t *testing.T) {
	config := RateLimitConfig{
		RequestsPerSecond: 100, // High rate for quick test
		BurstSize:         1,   // Small burst
		EnableIPLimit:     true,
	}
	rl := NewRateLimiter(config)

	key := "test_key"
	endpoint := "/api/test"

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// First request should succeed immediately
	err := rl.Wait(ctx, key, endpoint)
	assert.NoError(t, err)

	// Second request should wait briefly
	start := time.Now()
	err = rl.Wait(ctx, key, endpoint)
	duration := time.Since(start)

	assert.NoError(t, err)
	assert.Greater(t, duration, 5*time.Millisecond, "Should have waited")
	assert.Less(t, duration, 100*time.Millisecond, "Should not wait too long")
}

func TestWaitTimeout(t *testing.T) {
	config := RateLimitConfig{
		RequestsPerSecond: 1, // Very slow
		BurstSize:         1,
		EnableIPLimit:     true,
	}
	rl := NewRateLimiter(config)

	key := "test_key"
	endpoint := "/api/test"

	// Exhaust the limiter
	rl.Allow(key, endpoint)

	// Try to wait with short timeout
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	err := rl.Wait(ctx, key, endpoint)
	assert.Error(t, err)
	assert.Equal(t, context.DeadlineExceeded, err)
}

func TestWhitelist(t *testing.T) {
	rl := createTestRateLimiter()
	
	key := "whitelisted_key"
	endpoint := "/api/test"

	// Add to whitelist
	rl.AddToWhitelist(key)

	// Should always be allowed, even with high request rate
	for i := 0; i < 100; i++ {
		allowed := rl.Allow(key, endpoint)
		assert.True(t, allowed, "Whitelisted key should always be allowed")
	}

	// Remove from whitelist
	rl.RemoveFromWhitelist(key)

	// Now it should be rate limited
	// Allow some requests to go through first
	for i := 0; i < 20; i++ {
		rl.Allow(key, endpoint)
	}

	// Should now be limited
	allowed := rl.Allow(key, endpoint)
	assert.False(t, allowed, "Should be rate limited after removing from whitelist")
}

func TestBlacklist(t *testing.T) {
	rl := createTestRateLimiter()
	
	key := "blacklisted_key"
	endpoint := "/api/test"

	// Add to blacklist
	rl.AddToBlacklist(key)

	// Should always be denied
	allowed := rl.Allow(key, endpoint)
	assert.False(t, allowed, "Blacklisted key should be denied")

	// Remove from blacklist
	rl.RemoveFromBlacklist(key)

	// Should now work normally
	allowed = rl.Allow(key, endpoint)
	assert.True(t, allowed, "Should be allowed after removing from blacklist")
}

func TestEndpointSpecificLimits(t *testing.T) {
	config := createTestConfig()
	rl := NewRateLimiter(config)

	key := "test_key"
	regularEndpoint := "/api/regular"
	restrictedEndpoint := "/api/heavy"

	// Regular endpoint should use default limits
	for i := 0; i < 20; i++ { // Burst size is 20
		allowed := rl.Allow(key, regularEndpoint)
		assert.True(t, allowed, "Regular endpoint should allow burst")
	}

	// Heavy endpoint should use restricted limits (burst size 2)
	key2 := "test_key_2"
	for i := 0; i < 2; i++ {
		allowed := rl.Allow(key2, restrictedEndpoint)
		assert.True(t, allowed, "Heavy endpoint should allow small burst")
	}

	// Third request should be denied
	allowed := rl.Allow(key2, restrictedEndpoint)
	assert.False(t, allowed, "Heavy endpoint should deny after small burst")
}

func TestHTTPMiddleware(t *testing.T) {
	config := RateLimitConfig{
		RequestsPerSecond: 2,
		BurstSize:         3,
		EnableIPLimit:     true,
	}
	rl := NewRateLimiter(config)

	// Create test handler
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// Wrap with rate limiting middleware
	rateLimitedHandler := rl.HTTPMiddleware()(handler)

	// First few requests should succeed
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "/test", nil)
		req.RemoteAddr = "127.0.0.1:12345"
		w := httptest.NewRecorder()

		rateLimitedHandler.ServeHTTP(w, req)
		assert.Equal(t, http.StatusOK, w.Code, "Request %d should succeed", i+1)
	}

	// Next request should be rate limited
	req := httptest.NewRequest("GET", "/test", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	w := httptest.NewRecorder()

	rateLimitedHandler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusTooManyRequests, w.Code)
}

func TestKeyExtraction(t *testing.T) {
	tests := []struct {
		name           string
		config         RateLimitConfig
		setupRequest   func(*http.Request)
		expectedPrefix string
	}{
		{
			name: "IP-based limiting",
			config: RateLimitConfig{
				EnableIPLimit:   true,
				EnableUserLimit: false,
			},
			setupRequest: func(r *http.Request) {
				r.RemoteAddr = "192.168.1.100:12345"
			},
			expectedPrefix: "ip:",
		},
		{
			name: "User-based limiting",
			config: RateLimitConfig{
				EnableIPLimit:   false,
				EnableUserLimit: true,
			},
			setupRequest: func(r *http.Request) {
				r.Header.Set("X-User-ID", "user123")
			},
			expectedPrefix: "user:",
		},
		{
			name: "X-Forwarded-For header",
			config: RateLimitConfig{
				EnableIPLimit:      true,
				TrustXForwardedFor: true,
			},
			setupRequest: func(r *http.Request) {
				r.RemoteAddr = "127.0.0.1:12345"
				r.Header.Set("X-Forwarded-For", "203.0.113.1, 192.168.1.1")
			},
			expectedPrefix: "ip:",
		},
		{
			name: "X-Real-IP header",
			config: RateLimitConfig{
				EnableIPLimit:      true,
				TrustXForwardedFor: true,
			},
			setupRequest: func(r *http.Request) {
				r.RemoteAddr = "127.0.0.1:12345"
				r.Header.Set("X-Real-IP", "203.0.113.2")
			},
			expectedPrefix: "ip:",
		},
		{
			name: "Global fallback",
			config: RateLimitConfig{
				EnableIPLimit:   false,
				EnableUserLimit: false,
			},
			setupRequest: func(r *http.Request) {
				// No special headers
			},
			expectedPrefix: "global",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rl := NewRateLimiter(tt.config)

			req := httptest.NewRequest("GET", "/test", nil)
			tt.setupRequest(req)

			key := rl.extractKey(req)
			
			if tt.expectedPrefix == "global" {
				assert.Equal(t, "global", key)
			} else {
				assert.True(t, len(key) > len(tt.expectedPrefix), "Key should be longer than prefix")
				assert.Contains(t, key, tt.expectedPrefix, "Key should contain expected prefix")
			}
		})
	}
}

func TestCleanup(t *testing.T) {
	config := RateLimitConfig{
		RequestsPerSecond: 10,
		BurstSize:         20,
		CleanupInterval:   100 * time.Millisecond,
		ExpiryTime:        200 * time.Millisecond,
		EnableIPLimit:     true,
	}
	rl := NewRateLimiter(config)

	// Create some limiters
	keys := []string{"key1", "key2", "key3"}
	for _, key := range keys {
		rl.Allow(key, "/test")
	}

	// Check they exist
	rl.mu.RLock()
	initialCount := len(rl.limiters)
	rl.mu.RUnlock()
	assert.Equal(t, len(keys), initialCount)

	// Wait for cleanup to run
	time.Sleep(400 * time.Millisecond)

	// Check they've been cleaned up
	rl.mu.RLock()
	finalCount := len(rl.limiters)
	rl.mu.RUnlock()
	assert.Equal(t, 0, finalCount, "All limiters should be cleaned up")
}

func TestConcurrentAccess(t *testing.T) {
	rl := createTestRateLimiter()

	const numGoroutines = 10
	const requestsPerGoroutine = 100

	var wg sync.WaitGroup
	wg.Add(numGoroutines)

	// Concurrent access from multiple goroutines
	for i := 0; i < numGoroutines; i++ {
		go func(goroutineID int) {
			defer wg.Done()

			key := "concurrent_key_" + string(rune(goroutineID))
			for j := 0; j < requestsPerGoroutine; j++ {
				rl.Allow(key, "/test")
				
				// Also test other operations
				if j%10 == 0 {
					rl.AddToWhitelist(key + "_temp")
					rl.RemoveFromWhitelist(key + "_temp")
				}
			}
		}(i)
	}

	wg.Wait()

	// Verify state is consistent
	stats := rl.GetStats()
	assert.GreaterOrEqual(t, stats["active_limiters"], 0)
}

func TestDDoSProtection(t *testing.T) {
	ddosConfig := DDoSConfig{
		MaxConnectionsPerIP:       5,
		SuspiciousThreshold:       10,
		BanDuration:              1 * time.Minute,
		EnableSYNProtection:      true,
		EnableSlowlorisProtection: true,
		RequestTimeout:           10 * time.Second,
		MaxRequestSize:           1024,
	}

	rateLimiter := createTestRateLimiter()
	ddos := NewDDoSProtection(ddosConfig, rateLimiter)

	ip := "192.168.1.100"

	// Test connection limiting
	for i := 0; i < 5; i++ {
		allowed := ddos.CheckConnection(ip)
		assert.True(t, allowed, "Connection %d should be allowed", i+1)
	}

	// 6th connection should be denied
	allowed := ddos.CheckConnection(ip)
	assert.False(t, allowed, "6th connection should be denied")

	// Release connections
	for i := 0; i < 5; i++ {
		ddos.ReleaseConnection(ip)
	}

	// Should be able to connect again
	allowed = ddos.CheckConnection(ip)
	assert.True(t, allowed, "Should be able to connect after releasing")
}

func TestDDoSRequestAnalysis(t *testing.T) {
	ddosConfig := DDoSConfig{
		MaxRequestSize:            1024,
		EnableSlowlorisProtection: true,
	}

	ddos := NewDDoSProtection(ddosConfig, nil)

	tests := []struct {
		name     string
		setupReq func(*http.Request)
		expected bool
	}{
		{
			name: "normal request",
			setupReq: func(r *http.Request) {
				r.Header.Set("User-Agent", "Mozilla/5.0")
				r.ContentLength = 100
			},
			expected: true,
		},
		{
			name: "oversized request",
			setupReq: func(r *http.Request) {
				r.Header.Set("User-Agent", "Mozilla/5.0")
				r.ContentLength = 2048 // Exceeds limit
			},
			expected: false,
		},
		{
			name: "missing user agent",
			setupReq: func(r *http.Request) {
				r.ContentLength = 100
				// No User-Agent header
			},
			expected: false,
		},
		{
			name: "too many headers",
			setupReq: func(r *http.Request) {
				r.Header.Set("User-Agent", "Mozilla/5.0")
				r.Header.Set("Connection", "keep-alive")
				r.ContentLength = 100
				
				// Add many headers to simulate slowloris
				for i := 0; i < 150; i++ {
					r.Header.Set("X-Custom-"+string(rune(i)), "value")
				}
			},
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/test", nil)
			tt.setupReq(req)

			result := ddos.AnalyzeRequest(req)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestDDoSHTTPMiddleware(t *testing.T) {
	ddosConfig := DDoSConfig{
		MaxConnectionsPerIP: 2,
		RequestTimeout:      100 * time.Millisecond,
		MaxRequestSize:      1024,
	}

	ddos := NewDDoSProtection(ddosConfig, nil)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	middleware := ddos.HTTPMiddleware()
	protectedHandler := middleware(handler)

	// First two requests should succeed
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest("GET", "/test", nil)
		req.RemoteAddr = "192.168.1.100:12345"
		req.Header.Set("User-Agent", "test")
		w := httptest.NewRecorder()

		protectedHandler.ServeHTTP(w, req)
		assert.Equal(t, http.StatusOK, w.Code, "Request %d should succeed", i+1)
	}

	// Third request should be denied
	req := httptest.NewRequest("GET", "/test", nil)
	req.RemoteAddr = "192.168.1.100:12345"
	req.Header.Set("User-Agent", "test")
	w := httptest.NewRecorder()

	protectedHandler.ServeHTTP(w, req)
	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
}

func TestGetStats(t *testing.T) {
	rl := createTestRateLimiter()

	// Create some activity
	rl.Allow("key1", "/test")
	rl.Allow("key2", "/test")
	rl.AddToWhitelist("whitelist_key")
	rl.AddToBlacklist("blacklist_key")

	stats := rl.GetStats()
	assert.NotNil(t, stats)
	assert.Contains(t, stats, "active_limiters")
	assert.Contains(t, stats, "whitelisted_keys")
	assert.Contains(t, stats, "blacklisted_keys")
	assert.Contains(t, stats, "config")

	assert.GreaterOrEqual(t, stats["active_limiters"], 0)
	assert.Equal(t, 1, stats["whitelisted_keys"])
	assert.Equal(t, 1, stats["blacklisted_keys"])
}

// Benchmark tests

func BenchmarkRateLimiterAllow(b *testing.B) {
	rl := createTestRateLimiter()
	key := "benchmark_key"
	endpoint := "/test"

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		rl.Allow(key, endpoint)
	}
}

func BenchmarkRateLimiterAllowDifferentKeys(b *testing.B) {
	rl := createTestRateLimiter()
	endpoint := "/test"

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		key := "key_" + string(rune(i%1000)) // Cycle through 1000 keys
		rl.Allow(key, endpoint)
	}
}

func BenchmarkConcurrentRateLimiting(b *testing.B) {
	rl := createTestRateLimiter()
	endpoint := "/test"

	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			key := "concurrent_key_" + string(rune(i%100))
			rl.Allow(key, endpoint)
			i++
		}
	})
}

func BenchmarkHTTPMiddleware(b *testing.B) {
	rl := createTestRateLimiter()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	middleware := rl.HTTPMiddleware()
	rateLimitedHandler := middleware(handler)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req := httptest.NewRequest("GET", "/test", nil)
		req.RemoteAddr = "127.0.0.1:12345"
		w := httptest.NewRecorder()

		rateLimitedHandler.ServeHTTP(w, req)
	}
}

func BenchmarkKeyExtraction(b *testing.B) {
	rl := createTestRateLimiter()

	req := httptest.NewRequest("GET", "/test", nil)
	req.RemoteAddr = "192.168.1.100:12345"
	req.Header.Set("X-User-ID", "user123")
	req.Header.Set("X-Forwarded-For", "203.0.113.1, 192.168.1.1")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		key := rl.extractKey(req)
		_ = key
	}
}

func BenchmarkDDoSCheckConnection(b *testing.B) {
	ddos := NewDDoSProtection(DDoSConfig{
		MaxConnectionsPerIP: 100,
	}, nil)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ip := "192.168.1." + string(rune(i%255))
		ddos.CheckConnection(ip)
	}
}