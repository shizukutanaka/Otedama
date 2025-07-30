package security

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest"
)

// TestNewDDoSProtection tests DDoS protection creation
func TestNewDDoSProtection(t *testing.T) {
	t.Parallel()
	
	tests := []struct {
		name   string
		config DDoSConfig
		verify func(t *testing.T, ddos *DDoSProtection)
	}{
		{
			name: "default config",
			config: DDoSConfig{},
			verify: func(t *testing.T, ddos *DDoSProtection) {
				assert.NotNil(t, ddos)
				assert.Equal(t, 100, ddos.config.RequestsPerSecond)
				assert.Equal(t, 200, ddos.config.BurstSize)
				assert.Equal(t, 10000, ddos.config.ConnectionLimit)
				assert.Equal(t, 100, ddos.config.IPConnectionLimit)
				assert.Equal(t, 1*time.Hour, ddos.config.BlockDuration)
				assert.NotNil(t, ddos.globalLimiter)
				assert.NotNil(t, ddos.connectionTracker)
				assert.NotNil(t, ddos.patternDetector)
				assert.NotNil(t, ddos.whitelist)
				assert.NotNil(t, ddos.blacklist)
				assert.NotNil(t, ddos.stats)
			},
		},
		{
			name: "custom config",
			config: DDoSConfig{
				RequestsPerSecond:    200,
				BurstSize:           300,
				ConnectionLimit:     5000,
				IPConnectionLimit:   50,
				BlockDuration:       30 * time.Minute,
				EnableChallenge:     true,
				EnablePatternDetection: true,
				EnableMLDetection:   true,
				EnableGeoBlocking:   true,
				WhitelistedIPs:      []string{"192.168.1.1", "10.0.0.1"},
				BlacklistedIPs:      []string{"192.168.2.1", "10.0.1.1"},
			},
			verify: func(t *testing.T, ddos *DDoSProtection) {
				assert.Equal(t, 200, ddos.config.RequestsPerSecond)
				assert.Equal(t, 300, ddos.config.BurstSize)
				assert.Equal(t, 5000, ddos.config.ConnectionLimit)
				assert.Equal(t, 50, ddos.config.IPConnectionLimit)
				assert.Equal(t, 30*time.Minute, ddos.config.BlockDuration)
				assert.True(t, ddos.config.EnableChallenge)
				assert.NotNil(t, ddos.anomalyDetector)
				assert.NotNil(t, ddos.geoBlocker)
				assert.True(t, ddos.whitelist.Contains("192.168.1.1"))
				assert.True(t, ddos.blacklist.Contains("192.168.2.1"))
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			
			logger := zaptest.NewLogger(t)
			ddos := NewDDoSProtection(tt.config, logger)
			
			assert.NotNil(t, ddos)
			tt.verify(t, ddos)
		})
	}
}

// TestDDoSStartStop tests starting and stopping DDoS protection
func TestDDoSStartStop(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		RequestsPerSecond: 100,
		CleanupInterval:  1 * time.Minute,
	}
	
	ddos := NewDDoSProtection(config, logger)
	require.NotNil(t, ddos)

	t.Run("successful start and stop", func(t *testing.T) {
		ctx := context.Background()
		
		err := ddos.Start(ctx)
		assert.NoError(t, err)
		assert.True(t, ddos.running.Load())
		
		// Give time for workers to start
		time.Sleep(10 * time.Millisecond)
		
		err = ddos.Stop()
		assert.NoError(t, err)
		assert.False(t, ddos.running.Load())
	})

	t.Run("start already running", func(t *testing.T) {
		ctx := context.Background()
		err := ddos.Start(ctx)
		require.NoError(t, err)
		defer ddos.Stop()
		
		// Try to start again
		err = ddos.Start(ctx)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "already running")
	})

	t.Run("stop not running", func(t *testing.T) {
		// Create new instance
		ddos2 := NewDDoSProtection(config, logger)
		
		err := ddos2.Stop()
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "not running")
	})
}

// TestCheckRequest tests request validation
func TestCheckRequest(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		RequestsPerSecond: 10,
		BurstSize:        20,
		BlockDuration:    5 * time.Minute,
		EnableChallenge:  true,
		SuspiciousThreshold: 3,
		BlockingThreshold:   5,
		WhitelistedIPs:   []string{"192.168.1.100"},
		BlacklistedIPs:   []string{"192.168.2.100"},
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	tests := []struct {
		name              string
		ip                string
		req               RequestInfo
		expectedAllowed   bool
		expectedChallenge bool
		expectedReason    string
	}{
		{
			name: "whitelisted IP",
			ip:   "192.168.1.100",
			req: RequestInfo{
				Timestamp: time.Now(),
				Path:      "/api/test",
			},
			expectedAllowed:   true,
			expectedChallenge: false,
			expectedReason:    "whitelisted",
		},
		{
			name: "blacklisted IP",
			ip:   "192.168.2.100",
			req: RequestInfo{
				Timestamp: time.Now(),
				Path:      "/api/test",
			},
			expectedAllowed:   false,
			expectedChallenge: false,
			expectedReason:    "blacklisted",
		},
		{
			name: "normal request",
			ip:   "192.168.3.100",
			req: RequestInfo{
				Timestamp: time.Now(),
				Path:      "/api/test",
				UserAgent: "Mozilla/5.0",
			},
			expectedAllowed:   true,
			expectedChallenge: false,
			expectedReason:    "allowed",
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			allowed, challengeRequired, reason := ddos.CheckRequest(tt.ip, tt.req)
			
			assert.Equal(t, tt.expectedAllowed, allowed)
			assert.Equal(t, tt.expectedChallenge, challengeRequired)
			assert.Equal(t, tt.expectedReason, reason)
		})
	}
}

// TestRateLimiting tests rate limiting functionality
func TestRateLimiting(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		RequestsPerSecond: 5,
		BurstSize:        10,
		EnableChallenge:  true,
		SuspiciousThreshold: 3,
		BlockingThreshold:   5,
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	t.Run("IP rate limiting", func(t *testing.T) {
		ip := "192.168.1.50"
		
		// Burst requests
		allowedCount := 0
		challengeCount := 0
		blockedCount := 0
		
		for i := 0; i < 20; i++ {
			req := RequestInfo{
				Timestamp: time.Now(),
				Path:      fmt.Sprintf("/api/test%d", i),
			}
			
			allowed, challengeRequired, _ := ddos.CheckRequest(ip, req)
			
			if allowed {
				allowedCount++
			} else if challengeRequired {
				challengeCount++
			} else {
				blockedCount++
			}
			
			time.Sleep(10 * time.Millisecond)
		}
		
		// Should have some requests limited
		assert.Greater(t, blockedCount+challengeCount, 0)
		assert.Greater(t, allowedCount, 0)
	})

	t.Run("global rate limiting", func(t *testing.T) {
		var wg sync.WaitGroup
		blockedGlobal := atomic.Int32{}
		
		// Multiple IPs hitting global limit
		for i := 0; i < 10; i++ {
			wg.Add(1)
			go func(id int) {
				defer wg.Done()
				ip := fmt.Sprintf("192.168.10.%d", id)
				
				for j := 0; j < 5; j++ {
					req := RequestInfo{
						Timestamp: time.Now(),
						Path:      "/api/test",
					}
					
					allowed, _, reason := ddos.CheckRequest(ip, req)
					if !allowed && strings.Contains(reason, "global rate limit") {
						blockedGlobal.Add(1)
					}
					
					time.Sleep(1 * time.Millisecond)
				}
			}(i)
		}
		
		wg.Wait()
		
		// Should have some requests hit global limit
		assert.Greater(t, blockedGlobal.Load(), int32(0))
	})
}

// TestConnectionTracking tests connection tracking
func TestConnectionTracking(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		ConnectionLimit:   10,
		IPConnectionLimit: 3,
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	t.Run("track and untrack connections", func(t *testing.T) {
		err := ddos.TrackConnection("conn1", "192.168.1.1", 8080, "tcp")
		assert.NoError(t, err)
		
		err = ddos.TrackConnection("conn2", "192.168.1.1", 8081, "tcp")
		assert.NoError(t, err)
		
		// Verify connection count
		count := ddos.connectionTracker.GetIPConnectionCount("192.168.1.1")
		assert.Equal(t, 2, count)
		
		// Untrack one connection
		ddos.UntrackConnection("conn1")
		
		count = ddos.connectionTracker.GetIPConnectionCount("192.168.1.1")
		assert.Equal(t, 1, count)
	})

	t.Run("IP connection limit", func(t *testing.T) {
		ip := "192.168.2.1"
		
		// Add connections up to limit
		for i := 0; i < 3; i++ {
			connID := fmt.Sprintf("conn%d", i)
			err := ddos.TrackConnection(connID, ip, 8080+i, "tcp")
			assert.NoError(t, err)
		}
		
		// Try to add one more
		err := ddos.TrackConnection("conn4", ip, 8083, "tcp")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "IP connection limit")
		
		// Clean up
		for i := 0; i < 3; i++ {
			ddos.UntrackConnection(fmt.Sprintf("conn%d", i))
		}
	})

	t.Run("global connection limit", func(t *testing.T) {
		// Fill up to global limit
		for i := 0; i < 10; i++ {
			ip := fmt.Sprintf("192.168.3.%d", i)
			connID := fmt.Sprintf("global_conn%d", i)
			err := ddos.TrackConnection(connID, ip, 8080, "tcp")
			require.NoError(t, err)
		}
		
		// Try to add one more
		err := ddos.TrackConnection("overflow", "192.168.3.100", 8080, "tcp")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "global connection limit")
		
		// Clean up
		for i := 0; i < 10; i++ {
			ddos.UntrackConnection(fmt.Sprintf("global_conn%d", i))
		}
	})
}

// TestChallenge tests challenge generation and verification
func TestChallenge(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		EnableChallenge:     true,
		ChallengeType:      "proof_of_work",
		ChallengeDifficulty: 2,
		MaxChallengeRetries: 3,
		ChallengeExpiry:    5 * time.Minute,
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	t.Run("generate and verify challenge", func(t *testing.T) {
		ip := "192.168.1.10"
		
		// Generate challenge
		challengeID, err := ddos.GenerateChallenge(ip)
		assert.NoError(t, err)
		assert.NotEmpty(t, challengeID)
		
		// Get challenge details (would need to expose for testing)
		val, ok := ddos.challengeManager.challenges.Load(challengeID)
		require.True(t, ok)
		challenge := val.(*Challenge)
		
		// Calculate solution
		solution := ddos.challengeManager.calculatePoWSolution(challenge.Data, config.ChallengeDifficulty)
		
		// Verify correct solution
		valid := ddos.VerifyChallenge(ip, challengeID, solution)
		assert.True(t, valid)
		
		// Challenge should be removed after successful verification
		_, ok = ddos.challengeManager.challenges.Load(challengeID)
		assert.False(t, ok)
	})

	t.Run("verify with wrong IP", func(t *testing.T) {
		ip := "192.168.1.11"
		challengeID, err := ddos.GenerateChallenge(ip)
		require.NoError(t, err)
		
		// Try to verify from different IP
		valid := ddos.VerifyChallenge("192.168.1.12", challengeID, "any_solution")
		assert.False(t, valid)
	})

	t.Run("verify with wrong solution", func(t *testing.T) {
		ip := "192.168.1.13"
		challengeID, err := ddos.GenerateChallenge(ip)
		require.NoError(t, err)
		
		// Verify with incorrect solution
		valid := ddos.VerifyChallenge(ip, challengeID, "wrong_solution")
		assert.False(t, valid)
	})

	t.Run("max retry limit", func(t *testing.T) {
		ip := "192.168.1.14"
		challengeID, err := ddos.GenerateChallenge(ip)
		require.NoError(t, err)
		
		// Exceed retry limit
		for i := 0; i <= config.MaxChallengeRetries; i++ {
			ddos.VerifyChallenge(ip, challengeID, "wrong_solution")
		}
		
		// Challenge should be removed
		_, ok := ddos.challengeManager.challenges.Load(challengeID)
		assert.False(t, ok)
	})
}

// TestPatternDetection tests suspicious pattern detection
func TestPatternDetection(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		RequestsPerSecond:     100,
		EnablePatternDetection: true,
		BlockDuration:         5 * time.Minute,
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	t.Run("rapid fire pattern", func(t *testing.T) {
		ip := "192.168.5.1"
		
		// Send rapid requests
		for i := 0; i < 15; i++ {
			req := RequestInfo{
				Timestamp: time.Now(),
				Path:      fmt.Sprintf("/api/test%d", i),
				UserAgent: "TestBot",
			}
			ddos.recordRequest(ip, req)
		}
		
		// Check for pattern detection
		suspicious, pattern := ddos.detectSuspiciousPattern(ip)
		assert.True(t, suspicious)
		assert.NotNil(t, pattern)
		assert.Equal(t, "rapid_fire", pattern.ID)
	})

	t.Run("scanner pattern", func(t *testing.T) {
		ip := "192.168.5.2"
		
		// Simulate scanning behavior
		scanPaths := []string{
			"/admin",
			"/wp-admin",
			"/.git/config",
			"/phpmyadmin",
			"/.env",
		}
		
		for _, path := range scanPaths {
			req := RequestInfo{
				Timestamp: time.Now(),
				Path:      path,
				UserAgent: "Scanner/1.0",
			}
			ddos.recordRequest(ip, req)
			time.Sleep(100 * time.Millisecond)
		}
		
		// Check for pattern detection
		suspicious, pattern := ddos.detectSuspiciousPattern(ip)
		assert.True(t, suspicious)
		assert.NotNil(t, pattern)
		assert.Equal(t, "scanner", pattern.ID)
		assert.Equal(t, "block", pattern.Action)
	})

	t.Run("bot behavior pattern", func(t *testing.T) {
		ip := "192.168.5.3"
		
		// Multiple user agents from same IP
		userAgents := []string{
			"Mozilla/5.0",
			"Chrome/91.0",
			"bot",
			"crawler",
			"spider",
			"",
		}
		
		for i, ua := range userAgents {
			req := RequestInfo{
				Timestamp: time.Now(),
				Path:      fmt.Sprintf("/api/endpoint%d", i),
				UserAgent: ua,
			}
			ddos.recordRequest(ip, req)
		}
		
		// Check for pattern detection
		suspicious, pattern := ddos.detectSuspiciousPattern(ip)
		assert.True(t, suspicious)
		assert.NotNil(t, pattern)
		assert.Equal(t, "bot_behavior", pattern.ID)
	})
}

// TestIPList tests IP list functionality
func TestIPList(t *testing.T) {
	t.Parallel()
	
	t.Run("permanent entries", func(t *testing.T) {
		list := NewIPList("test")
		
		// Add IPs
		list.Add("192.168.1.1")
		list.Add("192.168.1.2")
		
		// Check contains
		assert.True(t, list.Contains("192.168.1.1"))
		assert.True(t, list.Contains("192.168.1.2"))
		assert.False(t, list.Contains("192.168.1.3"))
		
		// Check size
		assert.Equal(t, 2, list.Size())
		
		// Remove IP
		list.Remove("192.168.1.1")
		assert.False(t, list.Contains("192.168.1.1"))
		assert.Equal(t, 1, list.Size())
	})

	t.Run("temporary entries", func(t *testing.T) {
		list := NewIPList("test")
		
		// Add temporary IP
		list.AddTemporary("192.168.2.1", 100*time.Millisecond)
		
		// Should contain immediately
		assert.True(t, list.Contains("192.168.2.1"))
		
		// Wait for expiry
		time.Sleep(150 * time.Millisecond)
		
		// Should not contain after expiry
		assert.False(t, list.Contains("192.168.2.1"))
	})

	t.Run("cleanup expired", func(t *testing.T) {
		list := NewIPList("test")
		
		// Add multiple temporary entries
		list.AddTemporary("192.168.3.1", 50*time.Millisecond)
		list.AddTemporary("192.168.3.2", 200*time.Millisecond)
		list.AddTemporary("192.168.3.3", 50*time.Millisecond)
		
		assert.Equal(t, 3, list.Size())
		
		// Wait for some to expire
		time.Sleep(100 * time.Millisecond)
		
		// Cleanup
		list.CleanupExpired()
		
		// Only one should remain
		assert.Equal(t, 1, list.Size())
		assert.True(t, list.Contains("192.168.3.2"))
	})
}

// TestStats tests statistics collection
func TestStats(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		RequestsPerSecond: 100,
		WhitelistedIPs:   []string{"192.168.1.1"},
		BlacklistedIPs:   []string{"192.168.2.1"},
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	// Generate some traffic
	for i := 0; i < 10; i++ {
		req := RequestInfo{
			Timestamp: time.Now(),
			Path:      "/api/test",
		}
		
		// Whitelisted requests
		ddos.CheckRequest("192.168.1.1", req)
		
		// Blacklisted requests
		ddos.CheckRequest("192.168.2.1", req)
		
		// Normal requests
		ddos.CheckRequest("192.168.3.1", req)
	}
	
	// Get stats
	stats := ddos.GetStats()
	
	assert.Equal(t, uint64(30), stats["total_requests"])
	assert.Equal(t, uint64(10), stats["blocked_requests"])
	assert.Equal(t, 1, stats["blacklist_size"])
	assert.Equal(t, 1, stats["whitelist_size"])
}

// TestConcurrentRequests tests thread safety
func TestConcurrentRequests(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		RequestsPerSecond: 1000,
		BurstSize:        2000,
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	var wg sync.WaitGroup
	numGoroutines := 50
	requestsPerGoroutine := 100

	// Track results
	totalAllowed := atomic.Uint64{}
	totalBlocked := atomic.Uint64{}

	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			
			ip := fmt.Sprintf("192.168.10.%d", id%256)
			
			for j := 0; j < requestsPerGoroutine; j++ {
				req := RequestInfo{
					Timestamp: time.Now(),
					Path:      fmt.Sprintf("/api/endpoint%d", j),
					UserAgent: fmt.Sprintf("Client%d", id),
				}
				
				allowed, _, _ := ddos.CheckRequest(ip, req)
				
				if allowed {
					totalAllowed.Add(1)
				} else {
					totalBlocked.Add(1)
				}
				
				// Small delay to spread requests
				time.Sleep(time.Microsecond * 100)
			}
		}(i)
	}

	wg.Wait()

	// Verify totals
	total := totalAllowed.Load() + totalBlocked.Load()
	assert.Equal(t, uint64(numGoroutines*requestsPerGoroutine), total)
	
	// Should have both allowed and blocked requests
	assert.Greater(t, totalAllowed.Load(), uint64(0))
}

// TestCleanup tests cleanup functionality
func TestCleanup(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		RequestsPerSecond: 100,
		CleanupInterval:  100 * time.Millisecond,
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	// Add some IPs
	for i := 0; i < 10; i++ {
		ip := fmt.Sprintf("192.168.20.%d", i)
		limiter := ddos.getOrCreateIPLimiter(ip)
		
		// Set old activity for half of them
		if i < 5 {
			limiter.lastActivity.Store(time.Now().Add(-2 * time.Hour).Unix())
		} else {
			limiter.lastActivity.Store(time.Now().Unix())
		}
	}

	// Count IPs before cleanup
	countBefore := 0
	ddos.ipLimiters.Range(func(_, _ interface{}) bool {
		countBefore++
		return true
	})
	assert.Equal(t, 10, countBefore)

	// Wait for cleanup to run
	time.Sleep(200 * time.Millisecond)

	// Count IPs after cleanup
	countAfter := 0
	ddos.ipLimiters.Range(func(_, _ interface{}) bool {
		countAfter++
		return true
	})
	
	// Old IPs should be cleaned up
	assert.Less(t, countAfter, countBefore)
}

// TestConnectionTracker tests the connection tracker
func TestConnectionTrackerOperations(t *testing.T) {
	t.Parallel()
	
	ct := NewConnectionTracker()

	t.Run("add and remove connections", func(t *testing.T) {
		conn1 := &TrackedConnection{
			ID:        "conn1",
			IP:        "192.168.1.1",
			Port:      8080,
			Protocol:  "tcp",
			StartTime: time.Now(),
		}
		
		conn2 := &TrackedConnection{
			ID:        "conn2",
			IP:        "192.168.1.1",
			Port:      8081,
			Protocol:  "tcp",
			StartTime: time.Now(),
		}
		
		// Add connections
		ct.AddConnection("conn1", conn1)
		ct.AddConnection("conn2", conn2)
		
		// Check counts
		assert.Equal(t, int64(2), ct.totalActive.Load())
		assert.Equal(t, 2, ct.GetIPConnectionCount("192.168.1.1"))
		
		// Remove one connection
		ct.RemoveConnection("conn1")
		
		assert.Equal(t, int64(1), ct.totalActive.Load())
		assert.Equal(t, 1, ct.GetIPConnectionCount("192.168.1.1"))
		
		// Remove second connection
		ct.RemoveConnection("conn2")
		
		assert.Equal(t, int64(0), ct.totalActive.Load())
		assert.Equal(t, 0, ct.GetIPConnectionCount("192.168.1.1"))
	})

	t.Run("concurrent operations", func(t *testing.T) {
		var wg sync.WaitGroup
		
		// Add connections concurrently
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func(id int) {
				defer wg.Done()
				conn := &TrackedConnection{
					ID:       fmt.Sprintf("concurrent_%d", id),
					IP:       fmt.Sprintf("10.0.0.%d", id%10),
					Port:     8080 + id,
					Protocol: "tcp",
				}
				ct.AddConnection(conn.ID, conn)
			}(i)
		}
		
		wg.Wait()
		assert.Equal(t, int64(100), ct.totalActive.Load())
		
		// Remove connections concurrently
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func(id int) {
				defer wg.Done()
				ct.RemoveConnection(fmt.Sprintf("concurrent_%d", id))
			}(i)
		}
		
		wg.Wait()
		assert.Equal(t, int64(0), ct.totalActive.Load())
	})
}

// Benchmark tests

func BenchmarkCheckRequest(b *testing.B) {
	logger := zap.NewNop()
	config := DDoSConfig{
		RequestsPerSecond: 10000,
		BurstSize:        20000,
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	_ = ddos.Start(ctx)
	defer ddos.Stop()
	
	req := RequestInfo{
		Timestamp: time.Now(),
		Path:      "/api/test",
		UserAgent: "BenchmarkClient",
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ip := fmt.Sprintf("192.168.1.%d", i%256)
		ddos.CheckRequest(ip, req)
	}
}

func BenchmarkPatternDetection(b *testing.B) {
	logger := zap.NewNop()
	config := DDoSConfig{
		EnablePatternDetection: true,
	}
	
	ddos := NewDDoSProtection(config, logger)
	
	// Pre-populate some history
	for i := 0; i < 100; i++ {
		ip := fmt.Sprintf("192.168.1.%d", i)
		for j := 0; j < 10; j++ {
			req := RequestInfo{
				Timestamp: time.Now(),
				Path:      fmt.Sprintf("/api/endpoint%d", j),
				UserAgent: "TestClient",
			}
			ddos.recordRequest(ip, req)
		}
	}
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ip := fmt.Sprintf("192.168.1.%d", i%100)
		ddos.detectSuspiciousPattern(ip)
	}
}

func BenchmarkChallengeGeneration(b *testing.B) {
	logger := zap.NewNop()
	config := DDoSConfig{
		EnableChallenge:     true,
		ChallengeType:      "proof_of_work",
		ChallengeDifficulty: 3,
	}
	
	ddos := NewDDoSProtection(config, logger)
	
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ip := fmt.Sprintf("192.168.1.%d", i%256)
		_, _ = ddos.GenerateChallenge(ip)
	}
}

// TestEdgeCases tests edge cases
func TestEdgeCases(t *testing.T) {
	t.Parallel()
	
	logger := zaptest.NewLogger(t)

	t.Run("nil logger", func(t *testing.T) {
		config := DDoSConfig{}
		ddos := NewDDoSProtection(config, nil)
		assert.NotNil(t, ddos)
	})

	t.Run("empty IP", func(t *testing.T) {
		config := DDoSConfig{}
		ddos := NewDDoSProtection(config, logger)
		
		req := RequestInfo{Timestamp: time.Now()}
		allowed, _, _ := ddos.CheckRequest("", req)
		assert.True(t, allowed) // Should allow empty IP (handle gracefully)
	})

	t.Run("malformed IP", func(t *testing.T) {
		config := DDoSConfig{}
		ddos := NewDDoSProtection(config, logger)
		
		req := RequestInfo{Timestamp: time.Now()}
		allowed, _, _ := ddos.CheckRequest("not.an.ip.address", req)
		assert.True(t, allowed) // Should handle gracefully
	})

	t.Run("challenge when disabled", func(t *testing.T) {
		config := DDoSConfig{
			EnableChallenge: false,
		}
		ddos := NewDDoSProtection(config, logger)
		
		_, err := ddos.GenerateChallenge("192.168.1.1")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "not enabled")
		
		// Verify should return true when disabled
		valid := ddos.VerifyChallenge("192.168.1.1", "any", "any")
		assert.True(t, valid)
	})

	t.Run("ipv6 addresses", func(t *testing.T) {
		config := DDoSConfig{
			WhitelistedIPs: []string{"::1", "fe80::1"},
		}
		ddos := NewDDoSProtection(config, logger)
		
		req := RequestInfo{Timestamp: time.Now()}
		
		// IPv6 localhost
		allowed, _, reason := ddos.CheckRequest("::1", req)
		assert.True(t, allowed)
		assert.Equal(t, "whitelisted", reason)
		
		// IPv6 link-local
		allowed, _, reason = ddos.CheckRequest("fe80::1", req)
		assert.True(t, allowed)
		assert.Equal(t, "whitelisted", reason)
	})
}

// TestBlockingBehavior tests IP blocking functionality
func TestBlockingBehavior(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := DDoSConfig{
		RequestsPerSecond: 5,
		BlockingThreshold: 3,
		BlockDuration:    100 * time.Millisecond,
	}
	
	ddos := NewDDoSProtection(config, logger)
	ctx := context.Background()
	err := ddos.Start(ctx)
	require.NoError(t, err)
	defer ddos.Stop()

	ip := "192.168.100.1"
	
	// Trigger blocking by exceeding rate limit
	blockedCount := 0
	for i := 0; i < 10; i++ {
		req := RequestInfo{
			Timestamp: time.Now(),
			Path:      fmt.Sprintf("/test%d", i),
		}
		
		allowed, _, reason := ddos.CheckRequest(ip, req)
		if !allowed && strings.Contains(reason, "blocked") {
			blockedCount++
		}
		
		time.Sleep(10 * time.Millisecond)
	}
	
	// Should have triggered blocking
	assert.Greater(t, blockedCount, 0)
	
	// Check IP is blocked
	limiter := ddos.getOrCreateIPLimiter(ip)
	assert.True(t, limiter.blocked.Load())
	
	// Wait for block to expire
	time.Sleep(150 * time.Millisecond)
	
	// Should be able to make requests again
	req := RequestInfo{
		Timestamp: time.Now(),
		Path:      "/test-after-block",
	}
	allowed, _, _ := ddos.CheckRequest(ip, req)
	assert.True(t, allowed)
}

// Helper function to simulate connections
func simulateConnection(t *testing.T, address string) net.Conn {
	conn, err := net.Dial("tcp", address)
	require.NoError(t, err)
	return conn
}