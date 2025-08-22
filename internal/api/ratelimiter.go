// Package api provides REST API and WebSocket server for Otedama
// Clean, efficient API following REST principles
package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// MultiRateLimiter manages multiple rate limiters for different endpoints.
type MultiRateLimiter struct {
	globalLimiter    *singleRateLimiter
	endpointLimiters map[string]*singleRateLimiter
	mu               sync.RWMutex
}

// singleRateLimiter manages rate limiters for a single configuration.
type singleRateLimiter struct {
	visitors map[string]*visitor
	mu       sync.RWMutex
	rate     rate.Limit
	burst    int
	ttl      time.Duration
}

// visitor represents a user with a rate limiter.
type visitor struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// NewMultiRateLimiter creates a new rate limiter for multiple endpoints.
func NewMultiRateLimiter(globalRpm, globalBurst int, endpoints []EndpointRateLimitConfig) *MultiRateLimiter {
	mrl := &MultiRateLimiter{
		endpointLimiters: make(map[string]*singleRateLimiter),
	}

	if globalRpm > 0 {
		mrl.globalLimiter = newSingleRateLimiter(globalRpm, time.Minute, globalBurst)
	}

	for _, e := range endpoints {
		rl := newSingleRateLimiter(e.RequestsPerMinute, time.Minute, e.Burst)
		// register for each method
		for _, method := range e.Methods {
			key := method + " " + e.Path
			mrl.endpointLimiters[key] = rl
		}
	}

	return mrl
}

// Allow checks if a request is allowed based on its path and method.
func (mrl *MultiRateLimiter) Allow(r *http.Request) bool {
	// Try to find a specific limiter for the endpoint
	key := r.Method + " " + r.URL.Path

	mrl.mu.RLock()
	limiter, exists := mrl.endpointLimiters[key]
	mrl.mu.RUnlock()

	if exists {
		return limiter.allow(r.RemoteAddr)
	}

	// Fallback to the global limiter
	if mrl.globalLimiter != nil {
		return mrl.globalLimiter.allow(r.RemoteAddr)
	}

	return true // No rate limiting configured
}

// newSingleRateLimiter creates a new IP-based rate limiter for a single configuration.
func newSingleRateLimiter(rpm int, t time.Duration, b int) *singleRateLimiter {
	if rpm <= 0 {
		rpm = 60 // Default requests per minute
	}
	if b <= 0 {
		b = rpm
	}
	limiter := &singleRateLimiter{
		visitors: make(map[string]*visitor),
		rate:     rate.Limit(float64(rpm) / t.Seconds()),
		burst:    b,
		ttl:      3 * time.Minute,
	}
	go limiter.cleanupVisitors()
	return limiter
}

// allow checks if a request from a given IP is allowed.
func (l *singleRateLimiter) allow(ip string) bool {
	return l.getVisitor(ip).limiter.Allow()
}

// getVisitor retrieves or creates a visitor for a given IP.
func (l *singleRateLimiter) getVisitor(ip string) *visitor {
	ip, _, err := net.SplitHostPort(ip)
	if err != nil {
		ip = strings.TrimSpace(ip) // Handle cases without port
	}

	l.mu.RLock()
	v, exists := l.visitors[ip]
	l.mu.RUnlock()

	if !exists {
		limiter := rate.NewLimiter(l.rate, l.burst)
		v = &visitor{limiter, time.Now()}
		l.mu.Lock()
		l.visitors[ip] = v
		l.mu.Unlock()
	}

	v.lastSeen = time.Now()
	return v
}

// cleanupVisitors removes old visitors to prevent memory leaks.
func (l *singleRateLimiter) cleanupVisitors() {
	for {
		time.Sleep(time.Minute)
		l.mu.Lock()
		for ip, v := range l.visitors {
			if time.Since(v.lastSeen) > l.ttl {
				delete(l.visitors, ip)
			}
		}
		l.mu.Unlock()
	}
}
