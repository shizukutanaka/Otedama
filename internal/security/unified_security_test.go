package security

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

func TestNewSecurityManager(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableAuth:        true,
		JWTSecret:         "test-secret-key-minimum-32-chars",
		TokenExpiry:       24 * time.Hour,
		EnableRateLimit:   true,
		RequestsPerMinute: 60,
		BurstSize:         10,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)
	assert.NotNil(t, sm)
	assert.NotNil(t, sm.authManager)
	assert.NotNil(t, sm.rateLimiter)
}

func TestSecurityManager_Authenticate(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableAuth:   true,
		JWTSecret:    "test-secret-key-minimum-32-chars",
		TokenExpiry:  24 * time.Hour,
		DefaultRole:  "user",
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	err = sm.Start()
	require.NoError(t, err)
	defer sm.Stop()

	// Test authentication
	session, err := sm.Authenticate("testuser", "password123")
	assert.NoError(t, err)
	assert.NotNil(t, session)
	assert.Equal(t, "testuser", session.Username)
	assert.Equal(t, "user", session.Role)
}

func TestSecurityManager_ValidateSession(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableAuth:   true,
		JWTSecret:    "test-secret-key-minimum-32-chars",
		TokenExpiry:  1 * time.Hour,
		DefaultRole:  "user",
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	// Create session
	session, err := sm.Authenticate("testuser", "password123")
	require.NoError(t, err)

	// Validate session
	validatedSession, err := sm.ValidateSession(session.ID)
	assert.NoError(t, err)
	assert.NotNil(t, validatedSession)
	assert.Equal(t, session.ID, validatedSession.ID)

	// Test invalid session
	_, err = sm.ValidateSession("invalid-session-id")
	assert.Error(t, err)
}

func TestSecurityManager_GenerateToken(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableAuth:   true,
		JWTSecret:    "test-secret-key-minimum-32-chars",
		TokenExpiry:  1 * time.Hour,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	// Generate token
	token, err := sm.GenerateToken("user123", []string{"read", "write"})
	assert.NoError(t, err)
	assert.NotEmpty(t, token)
}

func TestSecurityManager_CheckPermission(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableRBAC:   true,
		DefaultRole:  "viewer",
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	// Check permission for viewer role
	hasPermission := sm.CheckPermission("user123", "monitoring", "view")
	assert.True(t, hasPermission)

	// Check permission viewer doesn't have
	hasPermission = sm.CheckPermission("user123", "mining", "start")
	assert.False(t, hasPermission)
}

func TestSecurityManager_CheckRateLimit(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableRateLimit:   true,
		RequestsPerMinute: 60,
		BurstSize:         5,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	identifier := "test-client"

	// Should allow initial requests
	for i := 0; i < 5; i++ {
		allowed := sm.CheckRateLimit(identifier)
		assert.True(t, allowed)
	}

	// Burst exceeded, might be rate limited
	// This depends on timing and implementation
}

func TestSecurityManager_CheckConnection(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableDDoS:        true,
		MaxConnections:    5,
		ConnectionTimeout: 30 * time.Second,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	ip := "192.168.1.1"

	// Should allow initial connections
	for i := 0; i < 5; i++ {
		allowed := sm.CheckConnection(ip)
		assert.True(t, allowed)
	}

	// Max connections reached
	allowed := sm.CheckConnection(ip)
	assert.False(t, allowed)
}

func TestSecurityManager_Encrypt_Decrypt(t *testing.T) {
	logger := zap.NewNop()
	
	// Generate 32-byte key for AES-256
	key := []byte("this-is-a-32-byte-key-for-aes256")
	
	config := &SecurityConfig{
		EncryptionKey: key,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	plaintext := []byte("sensitive data to encrypt")

	// Encrypt
	ciphertext, err := sm.Encrypt(plaintext)
	assert.NoError(t, err)
	assert.NotEqual(t, plaintext, ciphertext)

	// Decrypt
	decrypted, err := sm.Decrypt(ciphertext)
	assert.NoError(t, err)
	assert.Equal(t, plaintext, decrypted)
}

func TestSecurityManager_DetectThreat(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableAudit: true,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	// Test SQL injection detection
	threat := sm.DetectThreat("SELECT * FROM users WHERE id = '1' OR '1'='1'", "192.168.1.1")
	assert.NotNil(t, threat)
	assert.Equal(t, "sql_injection", threat.Type)

	// Test path traversal detection
	threat = sm.DetectThreat("GET /../../etc/passwd", "192.168.1.2")
	assert.NotNil(t, threat)
	assert.Equal(t, "path_traversal", threat.Type)

	// Test XSS detection
	threat = sm.DetectThreat("<script>alert('xss')</script>", "192.168.1.3")
	assert.NotNil(t, threat)
	assert.Equal(t, "xss_attempt", threat.Type)

	// Test benign activity
	threat = sm.DetectThreat("normal request data", "192.168.1.4")
	assert.Nil(t, threat)
}

func TestSecurityManager_AuthMiddleware(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableAuth:   true,
		JWTSecret:    "test-secret-key-minimum-32-chars",
		TokenExpiry:  1 * time.Hour,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	// Generate token
	token, err := sm.GenerateToken("user123", []string{"read"})
	require.NoError(t, err)

	// Create test handler
	handler := sm.AuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Test with valid token
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler(rec, req)
	assert.Equal(t, http.StatusOK, rec.Code)

	// Test without token
	req = httptest.NewRequest("GET", "/test", nil)
	rec = httptest.NewRecorder()
	handler(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)

	// Test with invalid token
	req = httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer invalid-token")
	rec = httptest.NewRecorder()
	handler(rec, req)
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}

func TestSecurityManager_RateLimitMiddleware(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableRateLimit:   true,
		RequestsPerMinute: 60,
		BurstSize:         5,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	handler := sm.RateLimitMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	// Make multiple requests
	for i := 0; i < 5; i++ {
		req := httptest.NewRequest("GET", "/test", nil)
		req.RemoteAddr = "192.168.1.1:12345"
		rec := httptest.NewRecorder()
		handler(rec, req)
		assert.Equal(t, http.StatusOK, rec.Code)
	}
}

func TestSecurityManager_SecurityHeadersMiddleware(t *testing.T) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableSecHeaders: true,
		CSPPolicy:        "default-src 'self'",
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(t, err)

	handler := sm.SecurityHeadersMiddleware(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/test", nil)
	rec := httptest.NewRecorder()
	handler(rec, req)

	assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
	assert.Equal(t, "DENY", rec.Header().Get("X-Frame-Options"))
	assert.Equal(t, "1; mode=block", rec.Header().Get("X-XSS-Protection"))
	assert.Contains(t, rec.Header().Get("Strict-Transport-Security"), "max-age=")
	assert.Equal(t, "default-src 'self'", rec.Header().Get("Content-Security-Policy"))
}

func BenchmarkSecurityManager_Encrypt(b *testing.B) {
	logger := zap.NewNop()
	key := []byte("this-is-a-32-byte-key-for-aes256")
	config := &SecurityConfig{
		EncryptionKey: key,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(b, err)

	data := []byte("benchmark test data for encryption")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = sm.Encrypt(data)
	}
}

func BenchmarkSecurityManager_CheckRateLimit(b *testing.B) {
	logger := zap.NewNop()
	config := &SecurityConfig{
		EnableRateLimit:   true,
		RequestsPerMinute: 600,
		BurstSize:         10,
	}

	sm, err := NewSecurityManager(logger, config)
	require.NoError(b, err)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = sm.CheckRateLimit("benchmark-client")
	}
}