package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
	"sync"
	"time"
	
	"golang.org/x/time/rate"
)

// AuthMiddleware provides API key authentication with timing attack protection
func AuthMiddleware(apiKey string) func(http.Handler) http.Handler {
	// Pre-compute hash of the valid API key
	validKeyHash := sha256.Sum256([]byte(apiKey))
	
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get API key from header
			key := r.Header.Get("X-API-Key")
			if key == "" {
				// Try to get from Authorization header
				auth := r.Header.Get("Authorization")
				if strings.HasPrefix(auth, "Bearer ") {
					key = strings.TrimPrefix(auth, "Bearer ")
				}
			}
			
			// Never get API key from query parameters (security risk)
			
			// Validate API key using constant-time comparison
			providedKeyHash := sha256.Sum256([]byte(key))
			if subtle.ConstantTimeCompare(validKeyHash[:], providedKeyHash[:]) != 1 {
				// Add random delay to prevent timing attacks
				time.Sleep(time.Duration(rand.Intn(100)) * time.Millisecond)
				
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("WWW-Authenticate", `Bearer realm="api"`)
				w.WriteHeader(http.StatusUnauthorized)
				w.Write([]byte(`{"error": "Invalid or missing API key"}`))
				return
			}
			
			next.ServeHTTP(w, r)
		})
	}
}

// RateLimitMiddleware provides rate limiting per IP
type RateLimitMiddleware struct {
	limiters sync.Map
	rate     int
	burst    int
}

// NewRateLimitMiddleware creates a new rate limiter
func NewRateLimitMiddleware(requestsPerSecond, burst int) *RateLimitMiddleware {
	return &RateLimitMiddleware{
		rate:  requestsPerSecond,
		burst: burst,
	}
}

// Middleware returns the middleware handler
func (rl *RateLimitMiddleware) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get client IP
			ip := getClientIP(r)
			
			// Get or create limiter for this IP
			limiterInterface, _ := rl.limiters.LoadOrStore(ip, rate.NewLimiter(rate.Limit(rl.rate), rl.burst))
			limiter := limiterInterface.(*rate.Limiter)
			
			// Check if request is allowed
			if !limiter.Allow() {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("X-RateLimit-Limit", string(rl.rate))
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("X-RateLimit-Reset", string(time.Now().Add(time.Second).Unix()))
				w.WriteHeader(http.StatusTooManyRequests)
				w.Write([]byte(`{"error": "Rate limit exceeded"}`))
				return
			}
			
			next.ServeHTTP(w, r)
		})
	}
}

// getClientIP extracts client IP from request
func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header
	forwarded := r.Header.Get("X-Forwarded-For")
	if forwarded != "" {
		// Take the first IP in the chain
		parts := strings.Split(forwarded, ",")
		return strings.TrimSpace(parts[0])
	}
	
	// Check X-Real-IP header
	realIP := r.Header.Get("X-Real-IP")
	if realIP != "" {
		return realIP
	}
	
	// Fall back to RemoteAddr
	addr := r.RemoteAddr
	if colon := strings.LastIndex(addr, ":"); colon != -1 {
		addr = addr[:colon]
	}
	
	return addr
}

// CORSMiddleware provides CORS support
func CORSMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			
			// Check if origin is allowed
			allowed := false
			for _, allowedOrigin := range allowedOrigins {
				if allowedOrigin == "*" || allowedOrigin == origin {
					allowed = true
					break
				}
			}
			
			if allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization")
				w.Header().Set("Access-Control-Max-Age", "86400")
			}
			
			// Handle preflight requests
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			
			next.ServeHTTP(w, r)
		})
	}
}