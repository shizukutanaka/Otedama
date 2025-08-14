package api

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// WSAuthConfig configures WebSocketAuth behavior
type WSAuthConfig struct {
	JWTSecret     string
	TokenTTL      time.Duration
	RefreshTTL    time.Duration
	EnableRefresh bool
}

// WebSocketAuth manages WebSocket authentication and encryption
type WebSocketAuth struct {
	logger       *zap.Logger
	sessions     sync.Map // sessionID -> *WSSession
	secretKey    []byte
	tokenExpiry  time.Duration
	rateLimiter  sync.Map // clientID -> *WSAuthRateLimiter
	stats        *WSAuthStats
	config       WSAuthConfig
}

// WSSession represents an authenticated WebSocket session
type WSSession struct {
	ID            string
	ClientID      string
	Token         string
	CreatedAt     time.Time
	LastActivity  time.Time
	Authenticated bool
	Permissions   []string
	EncryptionKey []byte
	GCMCipher     cipher.AEAD
	NonceCounter  atomic.Uint64
	ZKPProofID    string // Integration with ZKP system
}

// AuthMessage represents authentication message
type AuthMessage struct {
	Type      string `json:"type"`
	Token     string `json:"token,omitempty"`
	ClientID  string `json:"client_id,omitempty"`
	Signature string `json:"signature,omitempty"`
	Timestamp int64  `json:"timestamp,omitempty"`
	Nonce     string `json:"nonce,omitempty"`
}

// WSAuthStats tracks authentication statistics
// TokenClaims returned after token validation
// Extend with additional fields as needed.
type TokenClaims struct {
	UserID      string   `json:"user_id"`
	ClientID    string   `json:"client_id"`
	IssuedAt    int64    `json:"issued_at"`
	ExpiresAt   int64    `json:"expires_at"`
	Permissions []string `json:"permissions,omitempty"`
}

type WSAuthStats struct {
	TotalSessions      atomic.Uint64
	ActiveSessions     atomic.Uint64
	AuthFailures       atomic.Uint64
	EncryptedMessages  atomic.Uint64
	DecryptedMessages  atomic.Uint64
}

// incActiveSessions safely increments ActiveSessions
func (wa *WebSocketAuth) incActiveSessions() {
	wa.stats.ActiveSessions.Add(1)
}

// decActiveSessions safely decrements ActiveSessions without underflow
func (wa *WebSocketAuth) decActiveSessions() {
	for {
		current := wa.stats.ActiveSessions.Load()
		if current == 0 {
			return
		}
		if wa.stats.ActiveSessions.CompareAndSwap(current, current-1) {
			return
		}
	}
}

// WSAuthRateLimiter implements token bucket algorithm
type WSAuthRateLimiter struct {
	tokens    atomic.Int32
	lastReset atomic.Int64
	maxTokens int32
	mu        sync.Mutex
}

// NewWebSocketAuth creates a new WebSocket authentication manager
func NewWebSocketAuth(logger *zap.Logger, cfg WSAuthConfig) *WebSocketAuth {
	var secretKey []byte
	if cfg.JWTSecret != "" {
		// Derive key from configured secret (use SHA-256)
		sum := sha256.Sum256([]byte(cfg.JWTSecret))
		secretKey = sum[:]
	} else {
		// Generate random secret key for HMAC
		secretKey = make([]byte, 32)
		if _, err := rand.Read(secretKey); err != nil {
			logger.Error("Failed to generate secret key", zap.Error(err))
		}
	}

	// Default token TTL if not provided
	tokenTTL := cfg.TokenTTL
	if tokenTTL == 0 {
		tokenTTL = 24 * time.Hour
	}

	wa := &WebSocketAuth{
		logger:      logger,
		secretKey:   secretKey,
		tokenExpiry: tokenTTL,
		stats:       &WSAuthStats{},
		config:      cfg,
	}

	// Start cleanup goroutine
	go wa.cleanupRoutine()

	return wa
}

// GenerateToken generates a new authentication token
func (wa *WebSocketAuth) GenerateToken(clientID string) (string, error) {
	// Create token data
	tokenData := map[string]interface{}{
		"client_id": clientID,
		"issued_at": time.Now().Unix(),
		"expires_at": time.Now().Add(wa.tokenExpiry).Unix(),
		"nonce": wa.generateNonce(),
		// Optional user identifier; default to clientID if not otherwise managed by caller
		"user_id": clientID,
	}

	// Serialize token data
	data, err := json.Marshal(tokenData)
	if err != nil {
		return "", fmt.Errorf("failed to marshal token data: %w", err)
	}

	// Create HMAC signature
	mac := hmac.New(sha256.New, wa.secretKey)
	mac.Write(data)
	signature := mac.Sum(nil)

	// Combine data and signature
	token := base64.URLEncoding.EncodeToString(data) + "." + 
		base64.URLEncoding.EncodeToString(signature)

	return token, nil
}

// ValidateToken validates an authentication token and returns claims
func (wa *WebSocketAuth) ValidateToken(token string) (*TokenClaims, error) {
	// Split token into data and signature
	parts := splitToken(token)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid token format")
	}

	// Decode data
	data, err := base64.URLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("failed to decode token data: %w", err)
	}

	// Decode signature
	signature, err := base64.URLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("failed to decode signature: %w", err)
	}

	// Verify signature
	mac := hmac.New(sha256.New, wa.secretKey)
	mac.Write(data)
	expectedSignature := mac.Sum(nil)

	if !hmac.Equal(signature, expectedSignature) {
		return nil, fmt.Errorf("invalid signature")
	}

	// Parse token data
	var tokenData map[string]interface{}
	if err := json.Unmarshal(data, &tokenData); err != nil {
		return nil, fmt.Errorf("failed to parse token data: %w", err)
	}

	// Check expiration
	expiresAtFloat, ok := tokenData["expires_at"].(float64)
	if !ok || time.Now().Unix() > int64(expiresAtFloat) {
		return nil, fmt.Errorf("token expired")
	}

	// Convert to typed claims
	var userID, clientID string
	if v, ok := tokenData["client_id"].(string); ok {
		clientID = v
	}
	if v, ok := tokenData["user_id"].(string); ok && v != "" {
		userID = v
	} else {
		userID = clientID
	}

	issuedAt := time.Now().Unix()
	if v, ok := tokenData["issued_at"].(float64); ok {
		issuedAt = int64(v)
	}

	claims := &TokenClaims{
		UserID:    userID,
		ClientID:  clientID,
		IssuedAt:  issuedAt,
		ExpiresAt: int64(expiresAtFloat),
	}
	
	// Add permissions based on user type
	if claims.UserID == "admin" {
		claims.Permissions = []string{"admin", "read", "write"}
	} else {
		claims.Permissions = []string{"read"}
	}
	
	return claims, nil
}

// AuthenticateConnection authenticates a WebSocket connection
func (wa *WebSocketAuth) AuthenticateConnection(conn *websocket.Conn) (*WSSession, error) {
	// Set authentication timeout
	conn.SetReadDeadline(time.Now().Add(30 * time.Second))

	// Read authentication message
	var authMsg AuthMessage
	if err := conn.ReadJSON(&authMsg); err != nil {
		return nil, fmt.Errorf("failed to read auth message: %w", err)
	}

	// Validate authentication type
	if authMsg.Type != "auth" {
		return nil, fmt.Errorf("expected auth message, got: %s", authMsg.Type)
	}

	// Validate token
	tokenData, err := wa.ValidateToken(authMsg.Token)
	if err != nil {
		return nil, fmt.Errorf("token validation failed: %w", err)
	}

	// Extract client ID
	clientID := tokenData.ClientID

	// Verify client ID matches
	if clientID != authMsg.ClientID {
		return nil, fmt.Errorf("client ID mismatch")
	}

	// Check rate limit
	if !wa.checkRateLimit(clientID) {
		wa.stats.AuthFailures.Add(1)
		return nil, fmt.Errorf("rate limit exceeded")
	}

	// Create session
	session := &WSSession{
		ID:            wa.generateSessionID(),
		ClientID:      clientID,
		Token:         authMsg.Token,
		CreatedAt:     time.Now(),
		LastActivity:  time.Now(),
		Authenticated: true,
		EncryptionKey: wa.generateEncryptionKey(),
	}

	// Initialize AES-GCM cipher
	if err := wa.initializeEncryption(session); err != nil {
		wa.stats.AuthFailures.Add(1)
		return nil, fmt.Errorf("failed to initialize encryption: %w", err)
	}

	// Extract ZKP proof ID if present
	// Note: ZKP proof ID is not currently included in TokenClaims
	// If needed, it should be added to the TokenClaims struct and populated during token generation

	// Store session
	wa.sessions.Store(session.ID, session)
	wa.stats.TotalSessions.Add(1)
	wa.incActiveSessions()

	// Reset read deadline
	conn.SetReadDeadline(time.Time{})

	// Send authentication success
	response := map[string]interface{}{
		"type": "auth_success",
		"session_id": session.ID,
		"encryption_key": base64.StdEncoding.EncodeToString(session.EncryptionKey),
		"zkp_enabled": session.ZKPProofID != "",
	}

	if err := conn.WriteJSON(response); err != nil {
		wa.sessions.Delete(session.ID)
		wa.decActiveSessions()
		return nil, fmt.Errorf("failed to send auth response: %w", err)
	}

	wa.logger.Info("WebSocket authenticated",
		zap.String("session_id", session.ID),
		zap.String("client_id", clientID),
		zap.Bool("zkp_enabled", session.ZKPProofID != ""))

	return session, nil
}

// ValidateSession validates an existing session
func (wa *WebSocketAuth) ValidateSession(sessionID string) (*WSSession, error) {
	sessionInterface, exists := wa.sessions.Load(sessionID)
	if !exists {
		return nil, fmt.Errorf("session not found")
	}

	session := sessionInterface.(*WSSession)

	// Check if session is still valid
	if time.Since(session.LastActivity) > 30*time.Minute {
		wa.sessions.Delete(sessionID)
		return nil, fmt.Errorf("session expired")
	}

	// Update last activity
	session.LastActivity = time.Now()
	wa.sessions.Store(sessionID, session)

	return session, nil
}

// EncryptMessage encrypts a message using AES-GCM
func (wa *WebSocketAuth) EncryptMessage(session *WSSession, message []byte) ([]byte, error) {
	if session.GCMCipher == nil {
		return nil, fmt.Errorf("encryption not initialized")
	}

	// Generate nonce with counter
	nonce := make([]byte, session.GCMCipher.NonceSize())
	counter := session.NonceCounter.Add(1)
	
	// Put counter in the first 8 bytes of nonce
	for i := 0; i < 8; i++ {
		nonce[i] = byte(counter >> (8 * i))
	}
	
	// Add random bytes for the rest
	if _, err := rand.Read(nonce[8:]); err != nil {
		return nil, fmt.Errorf("failed to generate nonce: %w", err)
	}

	// Encrypt the message
	ciphertext := session.GCMCipher.Seal(nonce, nonce, message, nil)
	
	wa.stats.EncryptedMessages.Add(1)
	return ciphertext, nil
}

// DecryptMessage decrypts a message using AES-GCM
func (wa *WebSocketAuth) DecryptMessage(session *WSSession, ciphertext []byte) ([]byte, error) {
	if session.GCMCipher == nil {
		return nil, fmt.Errorf("encryption not initialized")
	}

	if len(ciphertext) < session.GCMCipher.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}

	// Extract nonce and ciphertext
	nonce := ciphertext[:session.GCMCipher.NonceSize()]
	ciphertext = ciphertext[session.GCMCipher.NonceSize():]

	// Decrypt the message
	plaintext, err := session.GCMCipher.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decryption failed: %w", err)
	}

	wa.stats.DecryptedMessages.Add(1)
	return plaintext, nil
}

// RevokeSession revokes a session
func (wa *WebSocketAuth) RevokeSession(sessionID string) {
	if _, loaded := wa.sessions.LoadAndDelete(sessionID); loaded {
		wa.decActiveSessions()
		wa.logger.Info("Session revoked", zap.String("session_id", sessionID))
	}
}

// CleanupExpiredSessions removes expired sessions
func (wa *WebSocketAuth) CleanupExpiredSessions() {
	expiredCount := 0
	wa.sessions.Range(func(key, value interface{}) bool {
		session := value.(*WSSession)
		if time.Since(session.LastActivity) > 30*time.Minute {
			if wa.sessions.CompareAndDelete(key, value) {
				expiredCount++
				wa.decActiveSessions()
				wa.logger.Debug("Cleaned up expired session", zap.String("session_id", session.ID))
			}
		}
		return true
	})
	
	if expiredCount > 0 {
		wa.logger.Info("Cleaned up expired sessions", zap.Int("count", expiredCount))
	}
}

// cleanupRoutine runs periodic cleanup tasks
func (wa *WebSocketAuth) cleanupRoutine() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		wa.CleanupExpiredSessions()
		wa.cleanupRateLimiters()
	}
}

// cleanupRateLimiters removes old rate limiters
func (wa *WebSocketAuth) cleanupRateLimiters() {
	now := time.Now().Unix()
	wa.rateLimiter.Range(func(key, value interface{}) bool {
		limiter := value.(*WSAuthRateLimiter)
		lastReset := limiter.lastReset.Load()
		
		// Remove rate limiters not used for 1 hour
		if now-lastReset > 3600 {
			wa.rateLimiter.Delete(key)
		}
		return true
	})
}

// generateNonce generates a random nonce
func (wa *WebSocketAuth) generateNonce() string {
	nonce := make([]byte, 16)
	rand.Read(nonce)
	return base64.URLEncoding.EncodeToString(nonce)
}

// generateSessionID generates a unique session ID
func (wa *WebSocketAuth) generateSessionID() string {
	id := make([]byte, 32)
	rand.Read(id)
	return base64.URLEncoding.EncodeToString(id)
}

// generateEncryptionKey generates a session encryption key
func (wa *WebSocketAuth) generateEncryptionKey() []byte {
	key := make([]byte, 32)
	rand.Read(key)
	return key
}

// splitToken splits a token into parts
func splitToken(token string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(token); i++ {
		if token[i] == '.' {
			parts = append(parts, token[start:i])
			start = i + 1
		}
	}
	if start < len(token) {
		parts = append(parts, token[start:])
	}
	return parts
}

// GetActiveSessionCount returns the number of active sessions
func (wa *WebSocketAuth) GetActiveSessionCount() int {
	count := 0
	wa.sessions.Range(func(_, _ interface{}) bool {
		count++
		return true
	})
	return count
}

// GetSessionStats returns session statistics
func (wa *WebSocketAuth) GetSessionStats() map[string]interface{} {
	stats := map[string]interface{}{
		"total_sessions":      wa.stats.TotalSessions.Load(),
		"active_sessions":     wa.stats.ActiveSessions.Load(),
		"auth_failures":       wa.stats.AuthFailures.Load(),
		"encrypted_messages":  wa.stats.EncryptedMessages.Load(),
		"decrypted_messages":  wa.stats.DecryptedMessages.Load(),
		"auth_method":         "HMAC-SHA256",
		"encryption_method":   "AES-256-GCM",
		"token_expiry":        wa.tokenExpiry.String(),
	}

	// Calculate average session duration
	var totalDuration time.Duration
	var sessionCount int
	var zkpEnabledCount int

	wa.sessions.Range(func(_, value interface{}) bool {
		session := value.(*WSSession)
		totalDuration += time.Since(session.CreatedAt)
		sessionCount++
		if session.ZKPProofID != "" {
			zkpEnabledCount++
		}
		return true
	})

	if sessionCount > 0 {
		stats["avg_session_duration"] = totalDuration / time.Duration(sessionCount)
		stats["zkp_enabled_sessions"] = zkpEnabledCount
	}

	return stats
}

// initializeEncryption sets up AES-GCM encryption for a session
func (wa *WebSocketAuth) initializeEncryption(session *WSSession) error {
	block, err := aes.NewCipher(session.EncryptionKey)
	if err != nil {
		return fmt.Errorf("failed to create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return fmt.Errorf("failed to create GCM: %w", err)
	}

	session.GCMCipher = gcm
	return nil
}

// checkRateLimit checks if a client is within rate limits
func (wa *WebSocketAuth) checkRateLimit(clientID string) bool {
	now := time.Now().Unix()
	maxTokens := int32(10) // 10 auth attempts per minute

	// Get or create rate limiter
	limiterInterface, _ := wa.rateLimiter.LoadOrStore(clientID, &WSAuthRateLimiter{
		maxTokens: maxTokens,
	})
	limiter := limiterInterface.(*WSAuthRateLimiter)

	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	// Reset tokens if minute has passed
	lastReset := limiter.lastReset.Load()
	if now-lastReset >= 60 {
		limiter.tokens.Store(maxTokens)
		limiter.lastReset.Store(now)
	}

	// Check if tokens available
	currentTokens := limiter.tokens.Load()
	if currentTokens <= 0 {
		return false
	}

	// Consume a token
	limiter.tokens.Add(-1)
	return true
}

// GenerateTokenWithZKP generates a token with ZKP proof ID
func (wa *WebSocketAuth) GenerateTokenWithZKP(clientID string, zkpProofID string) (string, error) {
	// Create token data with ZKP proof ID
	tokenData := map[string]interface{}{
		"client_id":     clientID,
		"issued_at":     time.Now().Unix(),
		"expires_at":    time.Now().Add(wa.tokenExpiry).Unix(),
		"nonce":         wa.generateNonce(),
		"zkp_proof_id":  zkpProofID,
	}

	// Serialize token data
	data, err := json.Marshal(tokenData)
	if err != nil {
		return "", fmt.Errorf("failed to marshal token data: %w", err)
	}

	// Create HMAC signature
	mac := hmac.New(sha256.New, wa.secretKey)
	mac.Write(data)
	signature := mac.Sum(nil)

	// Combine data and signature
	token := base64.URLEncoding.EncodeToString(data) + "." + 
		base64.URLEncoding.EncodeToString(signature)

	return token, nil
}