package middleware

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/shizukutanaka/Otedama/internal/common"
	"github.com/shizukutanaka/Otedama/internal/security"
	"go.uber.org/zap"
)

// TokenValidatorFunc validates an auth token and returns user claims/context
type TokenValidatorFunc func(string) (interface{}, error)

// SessionValidatorFunc validates a session ID and returns the session/context
type SessionValidatorFunc func(string) (interface{}, error)

// SecurityMiddleware provides comprehensive security middleware
type SecurityMiddleware struct {
	logger       *zap.Logger
	webSecurity  *security.WebSecurityManager
	validator    *security.InputValidator
	rateLimiter  common.RateLimiter
	config       SecurityConfig
	tokenValidator   TokenValidatorFunc
	sessionValidator SessionValidatorFunc
}

// SecurityConfig defines security middleware configuration
type SecurityConfig struct {
	// Authentication
	EnableAuth         bool     `json:"enable_auth"`
	AuthHeader        string   `json:"auth_header"`
	AuthCookieName    string   `json:"auth_cookie_name"`
	RequireAuth       []string `json:"require_auth"`
	ExcludeAuth       []string `json:"exclude_auth"`
	
	// API Key authentication
	EnableAPIKey      bool     `json:"enable_api_key"`
	APIKeyHeader      string   `json:"api_key_header"`
	APIKeyParam       string   `json:"api_key_param"`
	
	// Request validation
	MaxRequestSize    int64    `json:"max_request_size"`
	MaxHeaderSize     int      `json:"max_header_size"`
	MaxFormSize       int64    `json:"max_form_size"`
	
	// Timeout
	RequestTimeout    time.Duration `json:"request_timeout"`
	
	// IP filtering
	EnableIPFilter    bool     `json:"enable_ip_filter"`
	AllowedIPs        []string `json:"allowed_ips"`
	BlockedIPs        []string `json:"blocked_ips"`
	
	// User agent filtering
	BlockedUserAgents []string `json:"blocked_user_agents"`
}

// NewSecurityMiddleware creates a new security middleware
func NewSecurityMiddleware(
	logger *zap.Logger,
	webSecurity *security.WebSecurityManager,
	validator *security.InputValidator,
	rateLimiter common.RateLimiter,
	config SecurityConfig,
	tokenValidator TokenValidatorFunc,
	sessionValidator SessionValidatorFunc,
) *SecurityMiddleware {
	// Set defaults
	if config.AuthHeader == "" {
		config.AuthHeader = "Authorization"
	}
	if config.AuthCookieName == "" {
		config.AuthCookieName = "session_token"
	}
	if config.APIKeyHeader == "" {
		config.APIKeyHeader = "X-API-Key"
	}
	if config.MaxRequestSize == 0 {
		config.MaxRequestSize = 10 * 1024 * 1024 // 10MB
	}
	if config.MaxHeaderSize == 0 {
		config.MaxHeaderSize = 1024 * 1024 // 1MB
	}
	if config.MaxFormSize == 0 {
		config.MaxFormSize = 10 * 1024 * 1024 // 10MB
	}
	if config.RequestTimeout == 0 {
		config.RequestTimeout = 30 * time.Second
	}
	
	return &SecurityMiddleware{
		logger:           logger,
		webSecurity:      webSecurity,
		validator:        validator,
		rateLimiter:      rateLimiter,
		config:           config,
		tokenValidator:   tokenValidator,
		sessionValidator: sessionValidator,
	}
}

// Middleware returns the security middleware handler
func (sm *SecurityMiddleware) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Apply request size limits
		r.Body = http.MaxBytesReader(w, r.Body, sm.config.MaxRequestSize)
		
		// Apply timeout
		ctx, cancel := context.WithTimeout(r.Context(), sm.config.RequestTimeout)
		defer cancel()
		r = r.WithContext(ctx)
		
		// Check IP filtering
		if sm.config.EnableIPFilter {
			if err := sm.checkIPFilter(r); err != nil {
				sm.logger.Warn("IP filter blocked request",
					zap.String("ip", getClientIP(r)),
					zap.Error(err),
				)
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
		}
		
		// Check user agent
		if err := sm.checkUserAgent(r); err != nil {
			sm.logger.Warn("User agent blocked",
				zap.String("user_agent", r.UserAgent()),
				zap.Error(err),
			)
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		
		// Apply rate limiting
		if sm.rateLimiter != nil {
			clientID := getClientIP(r)
			if !sm.rateLimiter.Allow(clientID) {
				sm.logger.Warn("Rate limit exceeded",
					zap.String("client_id", clientID),
				)
				http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
				return
			}
		}
		
		// Apply web security (XSS, CSRF, headers)
		sm.webSecurity.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Check authentication if required
			if sm.requiresAuth(r.URL.Path) {
				user, err := sm.authenticate(r)
				if err != nil {
					sm.logger.Warn("Authentication failed",
						zap.String("path", r.URL.Path),
						zap.Error(err),
					)
					http.Error(w, "Unauthorized", http.StatusUnauthorized)
					return
				}
				
				// Add user to context
				ctx := context.WithValue(r.Context(), "user", user)
				r = r.WithContext(ctx)
			}
			
			// Validate request
			if err := sm.validateRequest(r); err != nil {
				sm.logger.Warn("Request validation failed",
					zap.String("path", r.URL.Path),
					zap.Error(err),
				)
				http.Error(w, "Bad Request", http.StatusBadRequest)
				return
			}
			
			// Process request
			next.ServeHTTP(w, r)
		})).ServeHTTP(w, r)
	})
}

// APIKeyMiddleware provides API key authentication
func (sm *SecurityMiddleware) APIKeyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !sm.config.EnableAPIKey {
			next.ServeHTTP(w, r)
			return
		}
		
		// Get API key from request
		apiKey := sm.getAPIKey(r)
		if apiKey == "" {
			http.Error(w, "API key required", http.StatusUnauthorized)
			return
		}
		
		// Validate API key
		if !sm.validateAPIKey(apiKey) {
			http.Error(w, "Invalid API key", http.StatusUnauthorized)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}

// checkIPFilter checks IP filtering rules
func (sm *SecurityMiddleware) checkIPFilter(r *http.Request) error {
	clientIP := getClientIP(r)
	
	// Check blocked IPs
	for _, blocked := range sm.config.BlockedIPs {
		if clientIP == blocked {
			return fmt.Errorf("IP address blocked: %s", clientIP)
		}
	}
	
	// Check allowed IPs if configured
	if len(sm.config.AllowedIPs) > 0 {
		allowed := false
		for _, allowedIP := range sm.config.AllowedIPs {
			if clientIP == allowedIP {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("IP address not allowed: %s", clientIP)
		}
	}
	
	return nil
}

// checkUserAgent checks user agent filtering
func (sm *SecurityMiddleware) checkUserAgent(r *http.Request) error {
	userAgent := r.UserAgent()
	
	for _, blocked := range sm.config.BlockedUserAgents {
		if strings.Contains(strings.ToLower(userAgent), strings.ToLower(blocked)) {
			return fmt.Errorf("user agent blocked: %s", userAgent)
		}
	}
	
	return nil
}

// requiresAuth checks if path requires authentication
func (sm *SecurityMiddleware) requiresAuth(path string) bool {
	if !sm.config.EnableAuth {
		return false
	}
	
	// Check exclude list
	for _, excluded := range sm.config.ExcludeAuth {
		if matched, _ := matchPath(excluded, path); matched {
			return false
		}
	}
	
	// Check require list
	if len(sm.config.RequireAuth) == 0 {
		return true // Require auth for all paths by default
	}
	
	for _, required := range sm.config.RequireAuth {
		if matched, _ := matchPath(required, path); matched {
			return true
		}
	}
	
	return false
}

// authenticate performs authentication
func (sm *SecurityMiddleware) authenticate(r *http.Request) (interface{}, error) {
	// Check Authorization header
	authHeader := r.Header.Get(sm.config.AuthHeader)
	if authHeader != "" {
		// Parse Bearer token
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) == 2 && strings.ToLower(parts[0]) == "bearer" {
			token := parts[1]
			// Validate token
			return sm.validateToken(token)
		}
	}
	
	// Check cookie
	if cookie, err := r.Cookie(sm.config.AuthCookieName); err == nil {
		// Validate session token
		return sm.validateSession(cookie.Value)
	}
	
	return nil, fmt.Errorf("no valid authentication found")
}

// getAPIKey extracts API key from request
func (sm *SecurityMiddleware) getAPIKey(r *http.Request) string {
	// Check header
	if key := r.Header.Get(sm.config.APIKeyHeader); key != "" {
		return key
	}
	
	// Check query parameter
	if sm.config.APIKeyParam != "" {
		if key := r.URL.Query().Get(sm.config.APIKeyParam); key != "" {
			return key
		}
	}
	
	return ""
}

// validateRequest validates the incoming request
func (sm *SecurityMiddleware) validateRequest(r *http.Request) error {
	// Validate headers
	headerSize := 0
	for name, values := range r.Header {
		headerSize += len(name)
		for _, value := range values {
			headerSize += len(value)
		}
	}
	
	if headerSize > sm.config.MaxHeaderSize {
		return fmt.Errorf("header size exceeds maximum")
	}
	
	// Validate query parameters
	for param, values := range r.URL.Query() {
		for _, value := range values {
			result := sm.validator.Validate(value, "text")
			if !result.Valid {
				return fmt.Errorf("invalid query parameter %s: %v", param, result.Errors)
			}
		}
	}
	
	// Validate form data if present
	if r.Method == "POST" || r.Method == "PUT" || r.Method == "PATCH" {
		if err := r.ParseMultipartForm(sm.config.MaxFormSize); err == nil {
			// Validate form fields
			for field, values := range r.MultipartForm.Value {
				for _, value := range values {
					result := sm.validator.Validate(value, "text")
					if !result.Valid {
						return fmt.Errorf("invalid form field %s: %v", field, result.Errors)
					}
				}
			}
			
			// Validate uploaded files
			for field, files := range r.MultipartForm.File {
				for _, file := range files {
					result := sm.validator.ValidateFileUpload(
						file.Filename,
						file.Size,
						file.Header.Get("Content-Type"),
					)
					if !result.Valid {
						return fmt.Errorf("invalid file upload %s: %v", field, result.Errors)
					}
				}
			}
		}
	}
	
	return nil
}

// validateToken validates authentication token
func (sm *SecurityMiddleware) validateToken(token string) (interface{}, error) {
	if sm.tokenValidator == nil {
		return nil, fmt.Errorf("token validator not configured")
	}
	claims, err := sm.tokenValidator(token)
	if err != nil {
		sm.logger.Debug("token validation failed", zap.Error(err))
		return nil, err
	}
	return claims, nil
}

// validateSession validates session token
func (sm *SecurityMiddleware) validateSession(sessionID string) (interface{}, error) {
	if sm.sessionValidator == nil {
		return nil, fmt.Errorf("session validator not configured")
	}
	session, err := sm.sessionValidator(sessionID)
	if err != nil {
		sm.logger.Debug("session validation failed", zap.Error(err))
		return nil, err
	}
	return session, nil
}

// validateAPIKey validates API key
func (sm *SecurityMiddleware) validateAPIKey(apiKey string) bool {
	// API key validation implementation
	// This would check against your API key storage
	return false
}

// Helper functions

// getClientIP extracts client IP from request
func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first IP if multiple
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			return strings.TrimSpace(parts[0])
		}
	}
	
	// Check X-Real-IP header
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	
	// Fall back to RemoteAddr
	ip := r.RemoteAddr
	if idx := strings.LastIndex(ip, ":"); idx != -1 {
		ip = ip[:idx]
	}
	
	return ip
}

// matchPath matches a path pattern
func matchPath(pattern, path string) (bool, error) {
	// Simple pattern matching
	// Supports * wildcard
	if pattern == "*" {
		return true, nil
	}
	
	if strings.HasSuffix(pattern, "*") {
		prefix := strings.TrimSuffix(pattern, "*")
		return strings.HasPrefix(path, prefix), nil
	}
	
	return pattern == path, nil
}

// ResponseWriter wrapper for capturing response details
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

func (rw *responseWriter) Write(data []byte) (int, error) {
	if !rw.written {
		rw.WriteHeader(http.StatusOK)
	}
	return rw.ResponseWriter.Write(data)
}

// LoggingMiddleware adds security logging
func (sm *SecurityMiddleware) LoggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		
		// Wrap response writer
		wrapped := &responseWriter{
			ResponseWriter: w,
			statusCode:     http.StatusOK,
		}
		
		// Process request
		next.ServeHTTP(wrapped, r)
		
		// Log request
		duration := time.Since(start)
		sm.logger.Info("Security audit",
			zap.String("method", r.Method),
			zap.String("path", r.URL.Path),
			zap.String("client_ip", getClientIP(r)),
			zap.Int("status", wrapped.statusCode),
			zap.Duration("duration", duration),
			zap.String("user_agent", r.UserAgent()),
		)
		
		// Log security events
		if wrapped.statusCode == http.StatusUnauthorized {
			sm.logger.Warn("Unauthorized access attempt",
				zap.String("path", r.URL.Path),
				zap.String("client_ip", getClientIP(r)),
			)
		}
		
		if wrapped.statusCode == http.StatusForbidden {
			sm.logger.Warn("Forbidden access attempt",
				zap.String("path", r.URL.Path),
				zap.String("client_ip", getClientIP(r)),
			)
		}
	})
}