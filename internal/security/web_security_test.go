package security

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestWebSecurityManager_CSRF(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := WebSecurityConfig{
		EnableCSRF:      true,
		CSRFTokenLength: 32,
		CSRFTokenExpiry: 1 * time.Hour,
	}
	
	wsm, err := NewWebSecurityManager(logger, config)
	require.NoError(t, err)
	
	// Test CSRF token generation
	token1, err := wsm.GenerateCSRFToken("user1")
	require.NoError(t, err)
	assert.NotEmpty(t, token1)
	
	token2, err := wsm.GenerateCSRFToken("user1")
	require.NoError(t, err)
	assert.NotEqual(t, token1, token2)
	
	// Test CSRF validation middleware
	handler := wsm.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	
	// Test GET request (should pass without CSRF)
	req := httptest.NewRequest("GET", "/test", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	assert.Equal(t, http.StatusOK, rr.Code)
	
	// Test POST request without CSRF token (should fail)
	req = httptest.NewRequest("POST", "/test", nil)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	assert.Equal(t, http.StatusForbidden, rr.Code)
	
	// Test POST request with valid CSRF token (should pass)
	req = httptest.NewRequest("POST", "/test", nil)
	req.Header.Set("X-CSRF-Token", token1)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	assert.Equal(t, http.StatusOK, rr.Code)
}

func TestWebSecurityManager_XSS(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := WebSecurityConfig{
		EnableXSSProtection: true,
	}
	
	wsm, err := NewWebSecurityManager(logger, config)
	require.NoError(t, err)
	
	handler := wsm.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	
	tests := []struct {
		name       string
		url        string
		shouldFail bool
	}{
		{
			name:       "Clean URL",
			url:        "/test?param=value",
			shouldFail: false,
		},
		{
			name:       "Script tag in parameter",
			url:        "/test?param=<script>alert('xss')</script>",
			shouldFail: true,
		},
		{
			name:       "JavaScript URL",
			url:        "/test?redirect=javascript:alert('xss')",
			shouldFail: true,
		},
		{
			name:       "Event handler",
			url:        "/test?param=<img src=x onerror=alert('xss')>",
			shouldFail: true,
		},
		{
			name:       "Data URI",
			url:        "/test?param=data:text/html,<script>alert('xss')</script>",
			shouldFail: true,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.url, nil)
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, req)
			
			if tt.shouldFail {
				assert.Equal(t, http.StatusBadRequest, rr.Code)
			} else {
				assert.Equal(t, http.StatusOK, rr.Code)
			}
		})
	}
}

func TestWebSecurityManager_Headers(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := WebSecurityConfig{
		EnableSecurityHeaders: true,
		CookieSecure:         true,
		CustomHeaders: map[string]string{
			"X-Custom-Header": "custom-value",
		},
	}
	
	wsm, err := NewWebSecurityManager(logger, config)
	require.NoError(t, err)
	
	handler := wsm.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	
	req := httptest.NewRequest("GET", "/test", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	
	// Check security headers
	assert.Equal(t, "nosniff", rr.Header().Get("X-Content-Type-Options"))
	assert.Equal(t, "DENY", rr.Header().Get("X-Frame-Options"))
	assert.Equal(t, "1; mode=block", rr.Header().Get("X-XSS-Protection"))
	assert.Equal(t, "strict-origin-when-cross-origin", rr.Header().Get("Referrer-Policy"))
	assert.Contains(t, rr.Header().Get("Strict-Transport-Security"), "max-age=31536000")
	assert.Equal(t, "custom-value", rr.Header().Get("X-Custom-Header"))
}

func TestWebSecurityManager_CSP(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := WebSecurityConfig{
		EnableSecurityHeaders: true,
		CSPDirectives: map[string]string{
			"script-src": "'self' 'unsafe-inline' https://trusted.com",
			"img-src":    "'self' data: https:",
		},
		CSPReportURI: "/csp-report",
	}
	
	wsm, err := NewWebSecurityManager(logger, config)
	require.NoError(t, err)
	
	handler := wsm.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	
	req := httptest.NewRequest("GET", "/test", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	
	csp := rr.Header().Get("Content-Security-Policy")
	assert.Contains(t, csp, "script-src 'self' 'unsafe-inline' https://trusted.com")
	assert.Contains(t, csp, "img-src 'self' data: https:")
	assert.Contains(t, csp, "report-uri /csp-report")
}

func TestWebSecurityManager_SanitizeHTML(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := WebSecurityConfig{
		AllowedTags:       []string{"p", "strong", "em"},
		AllowedAttributes: []string{"class"},
	}
	
	wsm, err := NewWebSecurityManager(logger, config)
	require.NoError(t, err)
	
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "Plain text",
			input:    "Hello World",
			expected: "Hello World",
		},
		{
			name:     "Script tag",
			input:    "<script>alert('xss')</script>",
			expected: "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
		},
		{
			name:     "Event handler",
			input:    "<div onclick='alert()'>Click</div>",
			expected: "&lt;div onclick=&#39;alert()&#39;&gt;Click&lt;/div&gt;",
		},
		{
			name:     "Allowed tags",
			input:    "<p>Hello <strong>World</strong></p>",
			expected: "&lt;p&gt;Hello &lt;strong&gt;World&lt;/strong&gt;&lt;/p&gt;",
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := wsm.SanitizeHTML(tt.input)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestWebSecurityManager_InputValidation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := WebSecurityConfig{}
	
	wsm, err := NewWebSecurityManager(logger, config)
	require.NoError(t, err)
	
	tests := []struct {
		name      string
		input     string
		inputType string
		valid     bool
	}{
		{
			name:      "Valid email",
			input:     "test@example.com",
			inputType: "email",
			valid:     true,
		},
		{
			name:      "Invalid email",
			input:     "not-an-email",
			inputType: "email",
			valid:     false,
		},
		{
			name:      "Valid URL",
			input:     "https://example.com",
			inputType: "url",
			valid:     true,
		},
		{
			name:      "Invalid URL",
			input:     "javascript:alert('xss')",
			inputType: "url",
			valid:     false,
		},
		{
			name:      "Valid alphanumeric",
			input:     "Test123",
			inputType: "alphanumeric",
			valid:     true,
		},
		{
			name:      "Invalid alphanumeric",
			input:     "Test@123",
			inputType: "alphanumeric",
			valid:     false,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := wsm.ValidateInput(tt.input, tt.inputType)
			if tt.valid {
				assert.NoError(t, err)
				assert.NotEmpty(t, result)
			} else {
				assert.Error(t, err)
			}
		})
	}
}

func TestWebSecurityManager_CORS(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := WebSecurityConfig{}
	
	wsm, err := NewWebSecurityManager(logger, config)
	require.NoError(t, err)
	
	corsConfig := CORSConfig{
		AllowedOrigins:   []string{"https://example.com", "https://*.trusted.com"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE"},
		AllowedHeaders:   []string{"Content-Type", "Authorization"},
		AllowCredentials: true,
		MaxAge:          3600,
	}
	
	handler := wsm.CORSMiddleware(corsConfig)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	
	// Test allowed origin
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Origin", "https://example.com")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	
	assert.Equal(t, "https://example.com", rr.Header().Get("Access-Control-Allow-Origin"))
	assert.Equal(t, "true", rr.Header().Get("Access-Control-Allow-Credentials"))
	
	// Test wildcard subdomain
	req = httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Origin", "https://sub.trusted.com")
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	
	assert.Equal(t, "https://sub.trusted.com", rr.Header().Get("Access-Control-Allow-Origin"))
	
	// Test disallowed origin
	req = httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Origin", "https://evil.com")
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	
	assert.Empty(t, rr.Header().Get("Access-Control-Allow-Origin"))
	
	// Test preflight request
	req = httptest.NewRequest("OPTIONS", "/test", nil)
	req.Header.Set("Origin", "https://example.com")
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	
	assert.Equal(t, http.StatusNoContent, rr.Code)
	assert.Equal(t, "GET, POST, PUT, DELETE", rr.Header().Get("Access-Control-Allow-Methods"))
}

func TestWebSecurityManager_FormValidation(t *testing.T) {
	logger := zaptest.NewLogger(t)
	config := WebSecurityConfig{
		EnableXSSProtection: true,
	}
	
	wsm, err := NewWebSecurityManager(logger, config)
	require.NoError(t, err)
	
	handler := wsm.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	
	// Test form data with XSS
	form := url.Values{}
	form.Add("name", "John Doe")
	form.Add("comment", "<script>alert('xss')</script>")
	
	req := httptest.NewRequest("POST", "/test", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	
	assert.Equal(t, http.StatusBadRequest, rr.Code)
}