package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// WebSecurityManager provides comprehensive web security features
type WebSecurityManager struct {
	logger *zap.Logger
	
	// CSRF protection
	csrfTokens     map[string]*CSRFToken
	csrfMutex      sync.RWMutex
	csrfSecret     []byte
	
	// Content Security Policy
	cspPolicy      string
	
	// Security headers
	securityHeaders map[string]string
	
	// XSS protection
	xssPatterns    []*regexp.Regexp
	sanitizer      *HTMLSanitizer
	
	// Configuration
	config         WebSecurityConfig
	
	// Metrics
	metrics        struct {
		csrfBlocked    uint64
		xssBlocked     uint64
		injectionBlocked uint64
	}
}

// WebSecurityConfig defines web security configuration
type WebSecurityConfig struct {
	// CSRF settings
	EnableCSRF       bool          `json:"enable_csrf"`
	CSRFTokenLength  int           `json:"csrf_token_length"`
	CSRFTokenExpiry  time.Duration `json:"csrf_token_expiry"`
	CSRFCookieName   string        `json:"csrf_cookie_name"`
	CSRFHeaderName   string        `json:"csrf_header_name"`
	CSRFFieldName    string        `json:"csrf_field_name"`
	
	// XSS settings
	EnableXSSProtection bool     `json:"enable_xss_protection"`
	AllowedTags        []string `json:"allowed_tags"`
	AllowedAttributes  []string `json:"allowed_attributes"`
	
	// Security headers
	EnableSecurityHeaders bool              `json:"enable_security_headers"`
	CustomHeaders        map[string]string `json:"custom_headers"`
	
	// Content Security Policy
	CSPDirectives      map[string]string `json:"csp_directives"`
	CSPReportOnly      bool              `json:"csp_report_only"`
	CSPReportURI       string            `json:"csp_report_uri"`
	
	// Cookie settings
	CookieSecure       bool              `json:"cookie_secure"`
	CookieHTTPOnly     bool              `json:"cookie_httponly"`
	CookieSameSite     string            `json:"cookie_samesite"`
	CookieDomain       string            `json:"cookie_domain"`
	
	// Other settings
	TrustedProxies     []string          `json:"trusted_proxies"`
	AllowedOrigins     []string          `json:"allowed_origins"`
}

// CSRFToken represents a CSRF token
type CSRFToken struct {
	Token     string
	ExpiresAt time.Time
	UserID    string
}

// HTMLSanitizer sanitizes HTML content
type HTMLSanitizer struct {
	allowedTags       map[string]bool
	allowedAttributes map[string]bool
	urlSchemes        map[string]bool
}

// NewWebSecurityManager creates a new web security manager
func NewWebSecurityManager(logger *zap.Logger, config WebSecurityConfig) (*WebSecurityManager, error) {
	// Generate CSRF secret
	csrfSecret := make([]byte, 32)
	if _, err := rand.Read(csrfSecret); err != nil {
		return nil, fmt.Errorf("failed to generate CSRF secret: %w", err)
	}
	
	wsm := &WebSecurityManager{
		logger:      logger,
		csrfTokens:  make(map[string]*CSRFToken),
		csrfSecret:  csrfSecret,
		config:      config,
	}
	
	// Set defaults
	if config.CSRFTokenLength == 0 {
		config.CSRFTokenLength = 32
	}
	if config.CSRFTokenExpiry == 0 {
		config.CSRFTokenExpiry = 24 * time.Hour
	}
	if config.CSRFCookieName == "" {
		config.CSRFCookieName = "csrf_token"
	}
	if config.CSRFHeaderName == "" {
		config.CSRFHeaderName = "X-CSRF-Token"
	}
	if config.CSRFFieldName == "" {
		config.CSRFFieldName = "csrf_token"
	}
	
	// Initialize components
	wsm.initializeSecurityHeaders()
	wsm.initializeCSP()
	wsm.initializeXSSProtection()
	wsm.initializeSanitizer()
	
	// Start cleanup routine
	go wsm.cleanupExpiredTokens()
	
	return wsm, nil
}

// initializeSecurityHeaders sets up security headers
func (wsm *WebSecurityManager) initializeSecurityHeaders() {
	wsm.securityHeaders = map[string]string{
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":          "DENY",
		"X-XSS-Protection":         "1; mode=block",
		"Referrer-Policy":          "strict-origin-when-cross-origin",
		"Permissions-Policy":       "geolocation=(), microphone=(), camera=()",
		"Cross-Origin-Opener-Policy": "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "same-origin",
	}
	
	// Add HSTS if using HTTPS
	if wsm.config.CookieSecure {
		wsm.securityHeaders["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
	}
	
	// Add custom headers
	for k, v := range wsm.config.CustomHeaders {
		wsm.securityHeaders[k] = v
	}
}

// initializeCSP sets up Content Security Policy
func (wsm *WebSecurityManager) initializeCSP() {
	// Default CSP directives
	defaultDirectives := map[string]string{
		"default-src":  "'self'",
		"script-src":   "'self' 'unsafe-inline' 'unsafe-eval'",
		"style-src":    "'self' 'unsafe-inline'",
		"img-src":      "'self' data: https:",
		"font-src":     "'self'",
		"connect-src":  "'self'",
		"frame-src":    "'none'",
		"object-src":   "'none'",
		"base-uri":     "'self'",
		"form-action":  "'self'",
	}
	
	// Merge with custom directives
	for directive, value := range wsm.config.CSPDirectives {
		defaultDirectives[directive] = value
	}
	
	// Build CSP header
	var cspParts []string
	for directive, value := range defaultDirectives {
		cspParts = append(cspParts, fmt.Sprintf("%s %s", directive, value))
	}
	
	// Add report-uri if configured
	if wsm.config.CSPReportURI != "" {
		cspParts = append(cspParts, fmt.Sprintf("report-uri %s", wsm.config.CSPReportURI))
	}
	
	wsm.cspPolicy = strings.Join(cspParts, "; ")
}

// initializeXSSProtection sets up XSS protection patterns
func (wsm *WebSecurityManager) initializeXSSProtection() {
	// Common XSS patterns
	patterns := []string{
		`<script[^>]*>.*?</script>`,
		`javascript:`,
		`on\w+\s*=`,
		`<iframe[^>]*>`,
		`<object[^>]*>`,
		`<embed[^>]*>`,
		`<link[^>]*>`,
		`vbscript:`,
		`data:text/html`,
	}
	
	wsm.xssPatterns = make([]*regexp.Regexp, len(patterns))
	for i, pattern := range patterns {
		wsm.xssPatterns[i] = regexp.MustCompile("(?i)" + pattern)
	}
}

// initializeSanitizer sets up HTML sanitizer
func (wsm *WebSecurityManager) initializeSanitizer() {
	// Default allowed tags
	allowedTags := map[string]bool{
		"p": true, "br": true, "strong": true, "em": true,
		"u": true, "i": true, "b": true, "a": true,
		"ul": true, "ol": true, "li": true,
		"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
		"blockquote": true, "code": true, "pre": true,
	}
	
	// Add custom allowed tags
	for _, tag := range wsm.config.AllowedTags {
		allowedTags[tag] = true
	}
	
	// Default allowed attributes
	allowedAttributes := map[string]bool{
		"href": true, "title": true, "alt": true,
		"class": true, "id": true,
	}
	
	// Add custom allowed attributes
	for _, attr := range wsm.config.AllowedAttributes {
		allowedAttributes[attr] = true
	}
	
	// Allowed URL schemes
	urlSchemes := map[string]bool{
		"http": true, "https": true, "mailto": true,
	}
	
	wsm.sanitizer = &HTMLSanitizer{
		allowedTags:       allowedTags,
		allowedAttributes: allowedAttributes,
		urlSchemes:        urlSchemes,
	}
}

// Middleware returns security middleware
func (wsm *WebSecurityManager) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Apply security headers
		if wsm.config.EnableSecurityHeaders {
			wsm.applySecurityHeaders(w)
		}
		
		// Apply CSP
		wsm.applyCSP(w)
		
		// CSRF protection for state-changing methods
		if wsm.config.EnableCSRF && wsm.isStateChangingMethod(r.Method) {
			if err := wsm.validateCSRFToken(r); err != nil {
				wsm.metrics.csrfBlocked++
				wsm.logger.Warn("CSRF token validation failed",
					zap.String("method", r.Method),
					zap.String("path", r.URL.Path),
					zap.Error(err),
				)
				http.Error(w, "CSRF token validation failed", http.StatusForbidden)
				return
			}
		}
		
		// XSS protection
		if wsm.config.EnableXSSProtection {
			if wsm.detectXSS(r) {
				wsm.metrics.xssBlocked++
				wsm.logger.Warn("XSS attempt detected",
					zap.String("method", r.Method),
					zap.String("path", r.URL.Path),
				)
				http.Error(w, "XSS attempt detected", http.StatusBadRequest)
				return
			}
		}
		
		// Process request
		next.ServeHTTP(w, r)
	})
}

// GenerateCSRFToken generates a new CSRF token
func (wsm *WebSecurityManager) GenerateCSRFToken(userID string) (string, error) {
	// Generate random token
	tokenBytes := make([]byte, wsm.config.CSRFTokenLength)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}
	
	token := base64.URLEncoding.EncodeToString(tokenBytes)
	
	// Store token
	wsm.csrfMutex.Lock()
	wsm.csrfTokens[token] = &CSRFToken{
		Token:     token,
		ExpiresAt: time.Now().Add(wsm.config.CSRFTokenExpiry),
		UserID:    userID,
	}
	wsm.csrfMutex.Unlock()
	
	return token, nil
}

// validateCSRFToken validates CSRF token
func (wsm *WebSecurityManager) validateCSRFToken(r *http.Request) error {
	// Get token from request
	token := wsm.getCSRFTokenFromRequest(r)
	if token == "" {
		return fmt.Errorf("CSRF token not found")
	}
	
	// Validate token
	wsm.csrfMutex.RLock()
	csrfToken, exists := wsm.csrfTokens[token]
	wsm.csrfMutex.RUnlock()
	
	if !exists {
		return fmt.Errorf("invalid CSRF token")
	}
	
	if time.Now().After(csrfToken.ExpiresAt) {
		return fmt.Errorf("CSRF token expired")
	}
	
	return nil
}

// getCSRFTokenFromRequest extracts CSRF token from request
func (wsm *WebSecurityManager) getCSRFTokenFromRequest(r *http.Request) string {
	// Check header
	if token := r.Header.Get(wsm.config.CSRFHeaderName); token != "" {
		return token
	}
	
	// Check form field
	if token := r.FormValue(wsm.config.CSRFFieldName); token != "" {
		return token
	}
	
	// Check cookie
	if cookie, err := r.Cookie(wsm.config.CSRFCookieName); err == nil {
		return cookie.Value
	}
	
	return ""
}

// SetCSRFCookie sets CSRF token cookie
func (wsm *WebSecurityManager) SetCSRFCookie(w http.ResponseWriter, token string) {
	cookie := &http.Cookie{
		Name:     wsm.config.CSRFCookieName,
		Value:    token,
		Path:     "/",
		Expires:  time.Now().Add(wsm.config.CSRFTokenExpiry),
		Secure:   wsm.config.CookieSecure,
		HttpOnly: wsm.config.CookieHTTPOnly,
		SameSite: wsm.parseSameSite(wsm.config.CookieSameSite),
	}
	
	if wsm.config.CookieDomain != "" {
		cookie.Domain = wsm.config.CookieDomain
	}
	
	http.SetCookie(w, cookie)
}

// detectXSS detects potential XSS attacks
func (wsm *WebSecurityManager) detectXSS(r *http.Request) bool {
	// Check URL parameters
	for _, values := range r.URL.Query() {
		for _, value := range values {
			if wsm.containsXSS(value) {
				return true
			}
		}
	}
	
	// Check form values
	if err := r.ParseForm(); err == nil {
		for _, values := range r.Form {
			for _, value := range values {
				if wsm.containsXSS(value) {
					return true
				}
			}
		}
	}
	
	// Check headers
	suspiciousHeaders := []string{"Referer", "User-Agent", "X-Forwarded-For"}
	for _, header := range suspiciousHeaders {
		if wsm.containsXSS(r.Header.Get(header)) {
			return true
		}
	}
	
	return false
}

// containsXSS checks if input contains XSS patterns
func (wsm *WebSecurityManager) containsXSS(input string) bool {
	for _, pattern := range wsm.xssPatterns {
		if pattern.MatchString(input) {
			return true
		}
	}
	return false
}

// SanitizeHTML sanitizes HTML input
func (wsm *WebSecurityManager) SanitizeHTML(input string) string {
	// HTML escape by default
	output := html.EscapeString(input)
	
	// If sanitizer is configured, apply more sophisticated sanitization
	if wsm.sanitizer != nil {
		output = wsm.sanitizer.Sanitize(input)
	}
	
	return output
}

// ValidateInput validates and sanitizes user input
func (wsm *WebSecurityManager) ValidateInput(input string, inputType string) (string, error) {
	// Remove null bytes
	input = strings.ReplaceAll(input, "\x00", "")
	
	// Trim whitespace
	input = strings.TrimSpace(input)
	
	// Validate based on type
	switch inputType {
	case "email":
		if !wsm.isValidEmail(input) {
			return "", fmt.Errorf("invalid email format")
		}
		
	case "url":
		if !wsm.isValidURL(input) {
			return "", fmt.Errorf("invalid URL format")
		}
		
	case "alphanumeric":
		if !wsm.isAlphanumeric(input) {
			return "", fmt.Errorf("input must be alphanumeric")
		}
		
	case "numeric":
		if !wsm.isNumeric(input) {
			return "", fmt.Errorf("input must be numeric")
		}
		
	case "text":
		// General text, just sanitize
		input = wsm.SanitizeHTML(input)
		
	default:
		return "", fmt.Errorf("unknown input type: %s", inputType)
	}
	
	return input, nil
}

// applySecurityHeaders applies security headers to response
func (wsm *WebSecurityManager) applySecurityHeaders(w http.ResponseWriter) {
	for header, value := range wsm.securityHeaders {
		w.Header().Set(header, value)
	}
}

// applyCSP applies Content Security Policy
func (wsm *WebSecurityManager) applyCSP(w http.ResponseWriter) {
	if wsm.cspPolicy != "" {
		headerName := "Content-Security-Policy"
		if wsm.config.CSPReportOnly {
			headerName = "Content-Security-Policy-Report-Only"
		}
		w.Header().Set(headerName, wsm.cspPolicy)
	}
}

// isStateChangingMethod checks if HTTP method is state-changing
func (wsm *WebSecurityManager) isStateChangingMethod(method string) bool {
	return method == "POST" || method == "PUT" || method == "DELETE" || method == "PATCH"
}

// cleanupExpiredTokens removes expired CSRF tokens
func (wsm *WebSecurityManager) cleanupExpiredTokens() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for range ticker.C {
		wsm.csrfMutex.Lock()
		now := time.Now()
		for token, csrfToken := range wsm.csrfTokens {
			if now.After(csrfToken.ExpiresAt) {
				delete(wsm.csrfTokens, token)
			}
		}
		wsm.csrfMutex.Unlock()
	}
}

// Helper validation functions

func (wsm *WebSecurityManager) isValidEmail(email string) bool {
	emailRegex := regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)
	return emailRegex.MatchString(email)
}

func (wsm *WebSecurityManager) isValidURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return u.Scheme != "" && u.Host != ""
}

func (wsm *WebSecurityManager) isAlphanumeric(s string) bool {
	alphanumRegex := regexp.MustCompile(`^[a-zA-Z0-9]+$`)
	return alphanumRegex.MatchString(s)
}

func (wsm *WebSecurityManager) isNumeric(s string) bool {
	numericRegex := regexp.MustCompile(`^[0-9]+$`)
	return numericRegex.MatchString(s)
}

func (wsm *WebSecurityManager) parseSameSite(sameSite string) http.SameSite {
	switch strings.ToLower(sameSite) {
	case "lax":
		return http.SameSiteLaxMode
	case "strict":
		return http.SameSiteStrictMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteDefaultMode
	}
}

// HTMLSanitizer methods

// Sanitize sanitizes HTML content
func (hs *HTMLSanitizer) Sanitize(input string) string {
	// This is a simplified implementation
	// In production, use a proper HTML sanitization library
	
	// Remove script tags
	scriptRegex := regexp.MustCompile(`(?i)<script[^>]*>.*?</script>`)
	input = scriptRegex.ReplaceAllString(input, "")
	
	// Remove event handlers
	eventRegex := regexp.MustCompile(`(?i)\s*on\w+\s*=\s*["']?[^"']*["']?`)
	input = eventRegex.ReplaceAllString(input, "")
	
	// Remove javascript: URLs
	jsURLRegex := regexp.MustCompile(`(?i)javascript:`)
	input = jsURLRegex.ReplaceAllString(input, "")
	
	return input
}

// CORSConfig represents CORS configuration
type CORSConfig struct {
	AllowedOrigins   []string
	AllowedMethods   []string
	AllowedHeaders   []string
	ExposedHeaders   []string
	AllowCredentials bool
	MaxAge           int
}

// CORSMiddleware returns CORS middleware
func (wsm *WebSecurityManager) CORSMiddleware(config CORSConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			
			// Check if origin is allowed
			if wsm.isOriginAllowed(origin, config.AllowedOrigins) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				
				if config.AllowCredentials {
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				}
				
				if len(config.AllowedMethods) > 0 {
					w.Header().Set("Access-Control-Allow-Methods", strings.Join(config.AllowedMethods, ", "))
				}
				
				if len(config.AllowedHeaders) > 0 {
					w.Header().Set("Access-Control-Allow-Headers", strings.Join(config.AllowedHeaders, ", "))
				}
				
				if len(config.ExposedHeaders) > 0 {
					w.Header().Set("Access-Control-Expose-Headers", strings.Join(config.ExposedHeaders, ", "))
				}
				
				if config.MaxAge > 0 {
					w.Header().Set("Access-Control-Max-Age", fmt.Sprintf("%d", config.MaxAge))
				}
			}
			
			// Handle preflight requests
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			
			next.ServeHTTP(w, r)
		})
	}
}

// isOriginAllowed checks if origin is allowed
func (wsm *WebSecurityManager) isOriginAllowed(origin string, allowedOrigins []string) bool {
	for _, allowed := range allowedOrigins {
		if allowed == "*" || allowed == origin {
			return true
		}
		// Check for wildcard subdomain
		if strings.HasPrefix(allowed, "*.") {
			domain := strings.TrimPrefix(allowed, "*")
			if strings.HasSuffix(origin, domain) {
				return true
			}
		}
	}
	return false
}