package security

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// RateLimiter provides rate limiting functionality for API endpoints
type RateLimiter struct {
	mu        sync.RWMutex
	limiters  map[string]*userLimiter
	config    RateLimitConfig
	whitelist map[string]bool
	blacklist map[string]bool
}

// RateLimitConfig defines rate limiting parameters
type RateLimitConfig struct {
	// Requests per second
	RequestsPerSecond int
	// Burst size
	BurstSize int
	// Cleanup interval for expired limiters
	CleanupInterval time.Duration
	// Expiry time for inactive limiters
	ExpiryTime time.Duration
	// Enable IP-based limiting
	EnableIPLimit bool
	// Enable user-based limiting
	EnableUserLimit bool
	// Custom limits per endpoint
	EndpointLimits map[string]EndpointLimit
	// Trust X-Forwarded-For headers (only enable behind trusted proxy)
	TrustXForwardedFor bool
}

// EndpointLimit defines limits for specific endpoints
type EndpointLimit struct {
	RequestsPerSecond int
	BurstSize         int
}

// userLimiter tracks rate limit state for a user/IP
type userLimiter struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// NewRateLimiter creates a new rate limiter
func NewRateLimiter(config RateLimitConfig) *RateLimiter {
	// Set defaults
	if config.RequestsPerSecond <= 0 {
		config.RequestsPerSecond = 10
	}
	if config.BurstSize <= 0 {
		config.BurstSize = 20
	}
	if config.CleanupInterval <= 0 {
		config.CleanupInterval = 1 * time.Minute
	}
	if config.ExpiryTime <= 0 {
		config.ExpiryTime = 5 * time.Minute
	}
	
	rl := &RateLimiter{
		limiters:  make(map[string]*userLimiter),
		config:    config,
		whitelist: make(map[string]bool),
		blacklist: make(map[string]bool),
	}
	
	// Start cleanup routine
	go rl.cleanupRoutine()
	
	return rl
}

// Allow checks if a request should be allowed
func (rl *RateLimiter) Allow(key string, endpoint string) bool {
	// Check blacklist
	if rl.isBlacklisted(key) {
		return false
	}
	
	// Check whitelist
	if rl.isWhitelisted(key) {
		return true
	}
	
	// Get or create limiter
	limiter := rl.getLimiter(key, endpoint)
	
	// Check rate limit
	return limiter.Allow()
}

// AllowN checks if n events should be allowed
func (rl *RateLimiter) AllowN(key string, endpoint string, n int) bool {
	if rl.isBlacklisted(key) {
		return false
	}
	
	if rl.isWhitelisted(key) {
		return true
	}
	
	limiter := rl.getLimiter(key, endpoint)
	return limiter.AllowN(time.Now(), n)
}

// Wait blocks until the request can proceed
func (rl *RateLimiter) Wait(ctx context.Context, key string, endpoint string) error {
	if rl.isBlacklisted(key) {
		return fmt.Errorf("key %s is blacklisted", key)
	}
	
	if rl.isWhitelisted(key) {
		return nil
	}
	
	limiter := rl.getLimiter(key, endpoint)
	return limiter.Wait(ctx)
}

// AddToWhitelist adds a key to the whitelist
func (rl *RateLimiter) AddToWhitelist(key string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.whitelist[key] = true
}

// RemoveFromWhitelist removes a key from the whitelist
func (rl *RateLimiter) RemoveFromWhitelist(key string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.whitelist, key)
}

// AddToBlacklist adds a key to the blacklist
func (rl *RateLimiter) AddToBlacklist(key string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.blacklist[key] = true
}

// RemoveFromBlacklist removes a key from the blacklist
func (rl *RateLimiter) RemoveFromBlacklist(key string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.blacklist, key)
}

// HTTPMiddleware returns an HTTP middleware for rate limiting
func (rl *RateLimiter) HTTPMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract key from request
			key := rl.extractKey(r)
			endpoint := r.URL.Path
			
			// Check rate limit
			if !rl.Allow(key, endpoint) {
				http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			
			next.ServeHTTP(w, r)
		})
	}
}

// GetStats returns current rate limiter statistics
func (rl *RateLimiter) GetStats() map[string]interface{} {
	rl.mu.RLock()
	defer rl.mu.RUnlock()
	
	return map[string]interface{}{
		"active_limiters":   len(rl.limiters),
		"whitelisted_keys":  len(rl.whitelist),
		"blacklisted_keys":  len(rl.blacklist),
		"config":            rl.config,
	}
}

// Private methods

func (rl *RateLimiter) getLimiter(key string, endpoint string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	
	// Check if limiter exists
	if ul, exists := rl.limiters[key]; exists {
		ul.lastSeen = time.Now()
		return ul.limiter
	}
	
	// Create new limiter
	rps := rl.config.RequestsPerSecond
	burst := rl.config.BurstSize
	
	// Check for endpoint-specific limits
	if endpointLimit, exists := rl.config.EndpointLimits[endpoint]; exists {
		rps = endpointLimit.RequestsPerSecond
		burst = endpointLimit.BurstSize
	}
	
	limiter := rate.NewLimiter(rate.Limit(rps), burst)
	rl.limiters[key] = &userLimiter{
		limiter:  limiter,
		lastSeen: time.Now(),
	}
	
	return limiter
}

func (rl *RateLimiter) isWhitelisted(key string) bool {
	rl.mu.RLock()
	defer rl.mu.RUnlock()
	return rl.whitelist[key]
}

func (rl *RateLimiter) isBlacklisted(key string) bool {
	rl.mu.RLock()
	defer rl.mu.RUnlock()
	return rl.blacklist[key]
}

func (rl *RateLimiter) extractKey(r *http.Request) string {
	// Try to get user ID from header or context
	userID := r.Header.Get("X-User-ID")
	if userID != "" && rl.config.EnableUserLimit {
		return "user:" + userID
	}
	
	// Fall back to IP address
	if rl.config.EnableIPLimit {
		ip, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			ip = r.RemoteAddr
		}
		
		// Check for X-Forwarded-For header (with validation)
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" && rl.config.TrustXForwardedFor {
			// Parse the header properly
			ips := strings.Split(xff, ",")
			if len(ips) > 0 {
				// Take the first IP and trim whitespace
				firstIP := strings.TrimSpace(ips[0])
				// Validate IP format
				if net.ParseIP(firstIP) != nil {
					ip = firstIP
				}
				// If invalid, fall back to RemoteAddr
			}
		} else if realIP := r.Header.Get("X-Real-IP"); realIP != "" && rl.config.TrustXForwardedFor {
			// Also check X-Real-IP header
			if net.ParseIP(realIP) != nil {
				ip = realIP
			}
		}
		
		return "ip:" + ip
	}
	
	// Default to global rate limit
	return "global"
}

func (rl *RateLimiter) cleanupRoutine() {
	ticker := time.NewTicker(rl.config.CleanupInterval)
	defer ticker.Stop()
	
	for range ticker.C {
		rl.cleanup()
	}
}

func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	
	now := time.Now()
	for key, ul := range rl.limiters {
		if now.Sub(ul.lastSeen) > rl.config.ExpiryTime {
			delete(rl.limiters, key)
		}
	}
}

// DDoSProtection provides DDoS protection mechanisms
type DDoSProtection struct {
	rateLimiter      *RateLimiter
	connectionLimit  int
	activeConns      sync.Map // map[string]int
	suspiciousIPs    sync.Map // map[string]time.Time
	config           DDoSConfig
}

// DDoSConfig defines DDoS protection parameters
type DDoSConfig struct {
	// Maximum connections per IP
	MaxConnectionsPerIP int
	// Suspicious behavior threshold
	SuspiciousThreshold int
	// Ban duration for suspicious IPs
	BanDuration time.Duration
	// Enable SYN flood protection
	EnableSYNProtection bool
	// Enable slowloris protection
	EnableSlowlorisProtection bool
	// Request timeout
	RequestTimeout time.Duration
	// Maximum request size
	MaxRequestSize int64
}

// NewDDoSProtection creates a new DDoS protection system
func NewDDoSProtection(config DDoSConfig, rateLimiter *RateLimiter) *DDoSProtection {
	// Set defaults
	if config.MaxConnectionsPerIP <= 0 {
		config.MaxConnectionsPerIP = 100
	}
	if config.SuspiciousThreshold <= 0 {
		config.SuspiciousThreshold = 1000
	}
	if config.BanDuration <= 0 {
		config.BanDuration = 1 * time.Hour
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = 30 * time.Second
	}
	if config.MaxRequestSize <= 0 {
		config.MaxRequestSize = 10 * 1024 * 1024 // 10MB
	}
	
	return &DDoSProtection{
		rateLimiter: rateLimiter,
		config:      config,
	}
}

// CheckConnection checks if a new connection should be allowed
func (dp *DDoSProtection) CheckConnection(ip string) bool {
	// Check if IP is banned
	if banTime, exists := dp.suspiciousIPs.Load(ip); exists {
		if time.Since(banTime.(time.Time)) < dp.config.BanDuration {
			return false
		}
		dp.suspiciousIPs.Delete(ip)
	}
	
	// Check connection count
	count := 0
	if val, exists := dp.activeConns.Load(ip); exists {
		count = val.(int)
	}
	
	if count >= dp.config.MaxConnectionsPerIP {
		// Mark as suspicious
		dp.markSuspicious(ip)
		return false
	}
	
	// Increment connection count
	dp.activeConns.Store(ip, count+1)
	return true
}

// ReleaseConnection decrements the connection count for an IP
func (dp *DDoSProtection) ReleaseConnection(ip string) {
	if val, exists := dp.activeConns.Load(ip); exists {
		count := val.(int)
		if count > 1 {
			dp.activeConns.Store(ip, count-1)
		} else {
			dp.activeConns.Delete(ip)
		}
	}
}

// AnalyzeRequest analyzes a request for suspicious patterns
func (dp *DDoSProtection) AnalyzeRequest(r *http.Request) bool {
	// Check request size
	if r.ContentLength > dp.config.MaxRequestSize {
		return false
	}
	
	// Check for slowloris attack patterns
	if dp.config.EnableSlowlorisProtection {
		if r.Header.Get("Connection") == "keep-alive" {
			// Check for incomplete headers
			if len(r.Header) > 100 {
				return false
			}
		}
	}
	
	// Check user agent
	userAgent := r.Header.Get("User-Agent")
	if userAgent == "" || len(userAgent) > 1000 {
		return false
	}
	
	return true
}

// HTTPMiddleware returns an HTTP middleware for DDoS protection
func (dp *DDoSProtection) HTTPMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				ip = r.RemoteAddr
			}
			
			// Check connection
			if !dp.CheckConnection(ip) {
				http.Error(w, "Too many connections", http.StatusServiceUnavailable)
				return
			}
			
			// Ensure connection is released
			defer dp.ReleaseConnection(ip)
			
			// Analyze request
			if !dp.AnalyzeRequest(r) {
				http.Error(w, "Bad request", http.StatusBadRequest)
				return
			}
			
			// Set timeout
			ctx, cancel := context.WithTimeout(r.Context(), dp.config.RequestTimeout)
			defer cancel()
			r = r.WithContext(ctx)
			
			next.ServeHTTP(w, r)
		})
	}
}

// GetStats returns DDoS protection statistics
func (dp *DDoSProtection) GetStats() map[string]interface{} {
	activeCount := 0
	dp.activeConns.Range(func(key, value interface{}) bool {
		activeCount++
		return true
	})
	
	suspiciousCount := 0
	dp.suspiciousIPs.Range(func(key, value interface{}) bool {
		suspiciousCount++
		return true
	})
	
	return map[string]interface{}{
		"active_connections": activeCount,
		"suspicious_ips":     suspiciousCount,
		"config":             dp.config,
	}
}

func (dp *DDoSProtection) markSuspicious(ip string) {
	dp.suspiciousIPs.Store(ip, time.Now())
	if dp.rateLimiter != nil {
		dp.rateLimiter.AddToBlacklist(ip)
	}
}
