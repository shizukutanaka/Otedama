//go:build ignore

package api

// Legacy/ignored: excluded from production builds.
// See internal/legacy/README.md for details.
import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"go.uber.org/zap"
	"github.com/prometheus/client_golang/prometheus"
)

var rateLimitBlocked = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "otedama_http_rate_limit_total",
		Help: "Total number of HTTP requests blocked by rate limiting",
	},
	[]string{"result"}, // blocked
)

func init() {
	prometheus.MustRegister(rateLimitBlocked)
}

// Middleware represents a middleware function
type Middleware func(http.Handler) http.Handler

// AuthMiddleware provides authentication middleware
func AuthMiddleware(logger *zap.Logger, auth *WebSocketAuth) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract token from header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				sendJSONError(w, http.StatusUnauthorized, "Missing authorization header")
				return
			}

			// Parse Bearer token
			parts := strings.Split(authHeader, " ")
			if len(parts) != 2 || parts[0] != "Bearer" {
				sendJSONError(w, http.StatusUnauthorized, "Invalid authorization format")
				return
			}

			token := parts[1]

			// Validate token
			claims, err := auth.ValidateToken(token)
			if err != nil {
				auth.stats.AuthFailures.Add(1)
				sendJSONError(w, http.StatusUnauthorized, "Invalid token")
				return
			}

			// Add claims to context
			ctx := context.WithValue(r.Context(), "claims", claims)
			ctx = context.WithValue(ctx, "user_id", claims.UserID)
			ctx = context.WithValue(ctx, "permissions", claims.Permissions)
			
			// Continue with request
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RequirePermission checks for specific permissions
func RequirePermission(permission string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get claims from context
			claims, ok := r.Context().Value("claims").(*TokenClaims)
			if !ok {
				sendJSONError(w, http.StatusUnauthorized, "No authentication claims")
				return
			}

			// Check permission
			hasPermission := false
			for _, p := range claims.Permissions {
				if p == permission || p == "*" {
					hasPermission = true
					break
				}
			}

			if !hasPermission {
				sendJSONError(w, http.StatusForbidden, "Insufficient permissions")
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// RateLimitMiddleware applies an IP-based token-bucket limiter.
// Pass a *RateLimiter created via NewRateLimiter.
func RateLimitMiddleware(rl *IPRateLimiter, logger *zap.Logger) Middleware {
    if rl == nil {
        // Fail closed – if limiter is nil deny all non-GET requests.
        return func(next http.Handler) http.Handler {
            return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.Method == http.MethodGet {
                    next.ServeHTTP(w, r)
                    return
                }
                sendJSONError(w, http.StatusTooManyRequests, "rate limiter unavailable")
            })
        }
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Use remote address directly; RateLimiter handles parsing.
            if !rl.Allow(r.RemoteAddr) {
                rateLimitBlocked.WithLabelValues("blocked").Inc()
                sendJSONError(w, http.StatusTooManyRequests, "too many requests")
                return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// LoggingMiddleware provides request logging
func LoggingMiddleware(logger *zap.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// Wrap response writer to capture status
			wrapped := &responseWriter{
				ResponseWriter: w,
				statusCode:     http.StatusOK,
			}

			// Process request
			next.ServeHTTP(wrapped, r)

			// Log request
			logger.Info("HTTP request",
				zap.String("method", r.Method),
				zap.String("path", r.URL.Path),
				zap.Int("status", wrapped.statusCode),
				zap.Duration("duration", time.Since(start)),
				zap.String("remote_addr", r.RemoteAddr),
				zap.String("user_agent", r.UserAgent()),
			)
		})
	}
}

// RecoveryMiddleware recovers from panics
func RecoveryMiddleware(logger *zap.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if err := common.Recover(); err != nil {
					logger.Error("Panic recovered",
						zap.Error(err),
						zap.String("path", r.URL.Path),
						zap.String("method", r.Method),
					)
					
					sendJSONError(w, http.StatusInternalServerError, "Internal server error")
				}
			}()

			next.ServeHTTP(w, r)
		})
	}
}

// RequireAdmin middleware ensures the user has admin permissions
func RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Get permissions from context
		permissionsInterface := r.Context().Value("permissions")
		permissions, ok := permissionsInterface.([]string)
		if !ok {
			sendJSONError(w, http.StatusUnauthorized, "Missing permissions")
			return
		}

		// Check if user has admin permission
		isAdmin := false
		for _, perm := range permissions {
			if perm == "admin" {
				isAdmin = true
				break
			}
		}

		if !isAdmin {
			sendJSONError(w, http.StatusForbidden, "Insufficient permissions")
			return
		}

		// Continue with request
		next.ServeHTTP(w, r)
	})
}

// SecurityHeadersMiddleware adds security headers
func SecurityHeadersMiddleware() Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Add security headers
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("X-XSS-Protection", "1; mode=block")
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			w.Header().Set("Content-Security-Policy", "default-src 'self'")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

			next.ServeHTTP(w, r)
		})
	}
}

// ValidateContentType ensures correct content type
func ValidateContentType(contentType string) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip for GET requests
			if r.Method == http.MethodGet || r.Method == http.MethodHead {
				next.ServeHTTP(w, r)
				return
			}

			// Check content type
			ct := r.Header.Get("Content-Type")
			if !strings.HasPrefix(ct, contentType) {
				sendJSONError(w, http.StatusUnsupportedMediaType, 
					"Content-Type must be " + contentType)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// Chain combines multiple middleware
func Chain(middlewares ...Middleware) Middleware {
	return func(final http.Handler) http.Handler {
		for i := len(middlewares) - 1; i >= 0; i-- {
			final = middlewares[i](final)
		}
		return final
	}
}

// responseWriter wraps http.ResponseWriter to capture status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
	written    bool
}

func (rw *responseWriter) WriteHeader(code int) {
	if !rw.written {
		rw.statusCode = code
		rw.ResponseWriter.WriteHeader(code)
		rw.written = true
	}
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	if !rw.written {
		rw.WriteHeader(http.StatusOK)
	}
	return rw.ResponseWriter.Write(b)
}

// Helper function to send JSON errors
func sendJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write([]byte(`{"error":"` + message + `"}`))
}