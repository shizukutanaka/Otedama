package security

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/argon2"
)

// MFAProvider defines multi-factor authentication provider interface
type MFAProvider interface {
	GenerateSecret() (string, error)
	GenerateQRCode(user, secret string) ([]byte, error)
	ValidateCode(secret, code string) bool
	GenerateBackupCodes() ([]string, error)
}

// AuthManager handles all authentication including MFA
type AuthManager struct {
	mu               sync.RWMutex
	jwtSecret        []byte
	totpWindow       int
	sessionStore     map[string]*Session
	mfaSecrets       map[string]string
	backupCodes      map[string][]string
	failedAttempts   map[string]int
	blockedIPs       map[string]time.Time
	trustedDevices   map[string][]string
	auditLog         *AuditLogger
	rateLimiter      *RateLimiter
	maxFailedAttempts int
	blockDuration    time.Duration
}

// Session represents authenticated session with MFA status
type Session struct {
	ID              string
	UserID          string
	IPAddress       string
	UserAgent       string
	MFAVerified     bool
	CreatedAt       time.Time
	LastActivity    time.Time
	ExpiresAt       time.Time
	RefreshToken    string
	DeviceID        string
	Permissions     []string
}

// NewAuthManager creates new authentication manager with MFA support
func NewAuthManager(jwtSecret []byte) *AuthManager {
	return &AuthManager{
		jwtSecret:         jwtSecret,
		totpWindow:        2,
		sessionStore:      make(map[string]*Session),
		mfaSecrets:        make(map[string]string),
		backupCodes:       make(map[string][]string),
		failedAttempts:    make(map[string]int),
		blockedIPs:        make(map[string]time.Time),
		trustedDevices:    make(map[string][]string),
		auditLog:          NewAuditLogger(),
		rateLimiter:       NewRateLimiter(),
		maxFailedAttempts: 5,
		blockDuration:     30 * time.Minute,
	}
}

// TOTPProvider implements time-based one-time password
type TOTPProvider struct {
	issuer string
	digits int
	period int
}

// NewTOTPProvider creates new TOTP provider
func NewTOTPProvider(issuer string) *TOTPProvider {
	return &TOTPProvider{
		issuer: issuer,
		digits: 6,
		period: 30,
	}
}

// GenerateSecret generates TOTP secret
func (t *TOTPProvider) GenerateSecret() (string, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret), nil
}

// ValidateCode validates TOTP code with time window
func (t *TOTPProvider) ValidateCode(secret, code string, window int) bool {
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		return false
	}

	now := time.Now().Unix() / int64(t.period)
	
	// Check within time window
	for i := -window; i <= window; i++ {
		counter := now + int64(i)
		expectedCode := t.generateCode(decoded, counter)
		if code == expectedCode {
			return true
		}
	}
	
	return false
}

// generateCode generates TOTP code for given counter
func (t *TOTPProvider) generateCode(secret []byte, counter int64) string {
	// Convert counter to bytes
	buf := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		buf[i] = byte(counter & 0xff)
		counter >>= 8
	}
	
	// Generate HMAC
	h := hmac.New(sha256.New, secret)
	h.Write(buf)
	sum := h.Sum(nil)
	
	// Dynamic truncation
	offset := sum[len(sum)-1] & 0x0f
	code := int32(sum[offset]&0x7f)<<24 |
		int32(sum[offset+1]&0xff)<<16 |
		int32(sum[offset+2]&0xff)<<8 |
		int32(sum[offset+3]&0xff)
	
	// Generate digits
	modulo := int32(1)
	for i := 0; i < t.digits; i++ {
		modulo *= 10
	}
	
	return fmt.Sprintf("%0*d", t.digits, code%modulo)
}

// GenerateBackupCodes generates recovery backup codes
func (t *TOTPProvider) GenerateBackupCodes() ([]string, error) {
	codes := make([]string, 10)
	for i := range codes {
		b := make([]byte, 4)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		codes[i] = fmt.Sprintf("%08X", b)
	}
	return codes, nil
}

// Authenticate performs primary authentication
func (am *AuthManager) Authenticate(username, password, ipAddress string) (*Session, error) {
	am.mu.Lock()
	defer am.mu.Unlock()

	// Check if IP is blocked
	if blocked, exists := am.blockedIPs[ipAddress]; exists {
		if time.Now().Before(blocked) {
			am.auditLog.LogFailedAuth(username, ipAddress, "IP blocked")
			return nil, errors.New("IP address is temporarily blocked")
		}
		delete(am.blockedIPs, ipAddress)
	}

	// Check rate limit
	if !am.rateLimiter.Allow(ipAddress) {
		am.auditLog.LogFailedAuth(username, ipAddress, "Rate limited")
		return nil, errors.New("rate limit exceeded")
	}

	// Verify password (using Argon2id)
	if !am.verifyPassword(username, password) {
		am.failedAttempts[ipAddress]++
		if am.failedAttempts[ipAddress] >= am.maxFailedAttempts {
			am.blockedIPs[ipAddress] = time.Now().Add(am.blockDuration)
			am.auditLog.LogSecurityEvent("IP_BLOCKED", ipAddress, username)
		}
		am.auditLog.LogFailedAuth(username, ipAddress, "Invalid credentials")
		return nil, errors.New("invalid credentials")
	}

	// Reset failed attempts on successful auth
	delete(am.failedAttempts, ipAddress)

	// Create session (MFA not verified yet)
	sessionID := am.generateSessionID()
	session := &Session{
		ID:           sessionID,
		UserID:       username,
		IPAddress:    ipAddress,
		MFAVerified:  false,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
		ExpiresAt:    time.Now().Add(24 * time.Hour),
		RefreshToken: am.generateRefreshToken(),
	}

	am.sessionStore[sessionID] = session
	am.auditLog.LogSuccessfulAuth(username, ipAddress, "Primary auth successful")

	return session, nil
}

// VerifyMFA verifies multi-factor authentication code
func (am *AuthManager) VerifyMFA(sessionID, code, deviceID string) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	session, exists := am.sessionStore[sessionID]
	if !exists {
		return errors.New("invalid session")
	}

	if session.MFAVerified {
		return errors.New("MFA already verified")
	}

	// Check if device is trusted
	if am.isDeviceTrusted(session.UserID, deviceID) {
		session.MFAVerified = true
		session.DeviceID = deviceID
		am.auditLog.LogMFASuccess(session.UserID, "Trusted device")
		return nil
	}

	// Get user's MFA secret
	secret, exists := am.mfaSecrets[session.UserID]
	if !exists {
		return errors.New("MFA not configured for user")
	}

	// Try TOTP code first
	totp := NewTOTPProvider("Otedama")
	if totp.ValidateCode(secret, code, am.totpWindow) {
		session.MFAVerified = true
		session.DeviceID = deviceID
		am.auditLog.LogMFASuccess(session.UserID, "TOTP")
		return nil
	}

	// Try backup codes
	if am.validateBackupCode(session.UserID, code) {
		session.MFAVerified = true
		session.DeviceID = deviceID
		am.auditLog.LogMFASuccess(session.UserID, "Backup code")
		return nil
	}

	am.auditLog.LogMFAFailure(session.UserID, session.IPAddress)
	return errors.New("invalid MFA code")
}

// SetupMFA sets up multi-factor authentication for user
func (am *AuthManager) SetupMFA(userID string) (secret string, backupCodes []string, err error) {
	am.mu.Lock()
	defer am.mu.Unlock()

	// Generate TOTP secret
	totp := NewTOTPProvider("Otedama")
	secret, err = totp.GenerateSecret()
	if err != nil {
		return "", nil, err
	}

	// Generate backup codes
	backupCodes, err = totp.GenerateBackupCodes()
	if err != nil {
		return "", nil, err
	}

	// Store secret and backup codes
	am.mfaSecrets[userID] = secret
	am.backupCodes[userID] = am.hashBackupCodes(backupCodes)

	am.auditLog.LogSecurityEvent("MFA_SETUP", userID, "MFA configured")
	
	return secret, backupCodes, nil
}

// GenerateJWT generates JWT token for authenticated session
func (am *AuthManager) GenerateJWT(session *Session) (string, error) {
	if !session.MFAVerified {
		return "", errors.New("MFA verification required")
	}

	claims := jwt.MapClaims{
		"sub":         session.UserID,
		"sid":         session.ID,
		"iat":         time.Now().Unix(),
		"exp":         session.ExpiresAt.Unix(),
		"mfa":         true,
		"permissions": session.Permissions,
		"device_id":   session.DeviceID,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(am.jwtSecret)
}

// ValidateJWT validates JWT token
func (am *AuthManager) ValidateJWT(tokenString string) (*Session, error) {
	token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return am.jwtSecret, nil
	})

	if err != nil || !token.Valid {
		return nil, errors.New("invalid token")
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, errors.New("invalid claims")
	}

	sessionID, ok := claims["sid"].(string)
	if !ok {
		return nil, errors.New("missing session ID")
	}

	am.mu.RLock()
	session, exists := am.sessionStore[sessionID]
	am.mu.RUnlock()

	if !exists {
		return nil, errors.New("session not found")
	}

	if time.Now().After(session.ExpiresAt) {
		return nil, errors.New("session expired")
	}

	// Update last activity
	am.mu.Lock()
	session.LastActivity = time.Now()
	am.mu.Unlock()

	return session, nil
}

// TrustDevice marks device as trusted for MFA bypass
func (am *AuthManager) TrustDevice(userID, deviceID string) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	if am.trustedDevices[userID] == nil {
		am.trustedDevices[userID] = []string{}
	}

	// Limit trusted devices per user
	if len(am.trustedDevices[userID]) >= 5 {
		am.trustedDevices[userID] = am.trustedDevices[userID][1:]
	}

	am.trustedDevices[userID] = append(am.trustedDevices[userID], deviceID)
	am.auditLog.LogSecurityEvent("DEVICE_TRUSTED", userID, deviceID)
	
	return nil
}

// RevokeSession revokes active session
func (am *AuthManager) RevokeSession(sessionID string) error {
	am.mu.Lock()
	defer am.mu.Unlock()

	session, exists := am.sessionStore[sessionID]
	if !exists {
		return errors.New("session not found")
	}

	delete(am.sessionStore, sessionID)
	am.auditLog.LogSecurityEvent("SESSION_REVOKED", session.UserID, sessionID)
	
	return nil
}

// RefreshToken refreshes authentication token
func (am *AuthManager) RefreshToken(refreshToken string) (*Session, error) {
	am.mu.Lock()
	defer am.mu.Unlock()

	// Find session with matching refresh token
	for _, session := range am.sessionStore {
		if session.RefreshToken == refreshToken {
			if time.Now().After(session.ExpiresAt) {
				return nil, errors.New("refresh token expired")
			}

			// Extend session
			session.ExpiresAt = time.Now().Add(24 * time.Hour)
			session.RefreshToken = am.generateRefreshToken()
			session.LastActivity = time.Now()

			am.auditLog.LogSecurityEvent("TOKEN_REFRESHED", session.UserID, session.ID)
			return session, nil
		}
	}

	return nil, errors.New("invalid refresh token")
}

// Helper functions

func (am *AuthManager) verifyPassword(username, password string) bool {
	// This should connect to database to get stored hash
	// For now, using example with Argon2id
	storedHash := am.getStoredPasswordHash(username)
	
	// Argon2id parameters
	memory := uint32(64 * 1024)
	iterations := uint32(3)
	parallelism := uint8(2)
	saltLength := uint32(16)
	keyLength := uint32(32)
	
	parts := strings.Split(storedHash, "$")
	if len(parts) != 3 {
		return false
	}
	
	salt, _ := base64.RawStdEncoding.DecodeString(parts[1])
	hash, _ := base64.RawStdEncoding.DecodeString(parts[2])
	
	calculatedHash := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, keyLength)
	
	return hmac.Equal(hash, calculatedHash)
}

func (am *AuthManager) getStoredPasswordHash(username string) string {
	// This should fetch from database
	// Example hash for demonstration
	return "argon2id$YmFzZTY0c2FsdA$YmFzZTY0aGFzaA"
}

func (am *AuthManager) generateSessionID() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

func (am *AuthManager) generateRefreshToken() string {
	b := make([]byte, 64)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

func (am *AuthManager) isDeviceTrusted(userID, deviceID string) bool {
	devices, exists := am.trustedDevices[userID]
	if !exists {
		return false
	}
	
	for _, trusted := range devices {
		if trusted == deviceID {
			return true
		}
	}
	
	return false
}

func (am *AuthManager) validateBackupCode(userID, code string) bool {
	codes, exists := am.backupCodes[userID]
	if !exists {
		return false
	}
	
	hashedCode := am.hashBackupCode(code)
	for i, stored := range codes {
		if stored == hashedCode {
			// Remove used backup code
			am.backupCodes[userID] = append(codes[:i], codes[i+1:]...)
			return true
		}
	}
	
	return false
}

func (am *AuthManager) hashBackupCode(code string) string {
	hash := sha256.Sum256([]byte(code))
	return base64.StdEncoding.EncodeToString(hash[:])
}

func (am *AuthManager) hashBackupCodes(codes []string) []string {
	hashed := make([]string, len(codes))
	for i, code := range codes {
		hashed[i] = am.hashBackupCode(code)
	}
	return hashed
}

// AuditLogger logs security events
type AuditLogger struct {
	mu     sync.Mutex
	events []AuditEvent
}

type AuditEvent struct {
	Timestamp time.Time
	Type      string
	UserID    string
	IPAddress string
	Details   string
	Success   bool
}

func NewAuditLogger() *AuditLogger {
	return &AuditLogger{
		events: make([]AuditEvent, 0),
	}
}

func (al *AuditLogger) LogSuccessfulAuth(userID, ipAddress, details string) {
	al.log(AuditEvent{
		Timestamp: time.Now(),
		Type:      "AUTH_SUCCESS",
		UserID:    userID,
		IPAddress: ipAddress,
		Details:   details,
		Success:   true,
	})
}

func (al *AuditLogger) LogFailedAuth(userID, ipAddress, reason string) {
	al.log(AuditEvent{
		Timestamp: time.Now(),
		Type:      "AUTH_FAILED",
		UserID:    userID,
		IPAddress: ipAddress,
		Details:   reason,
		Success:   false,
	})
}

func (al *AuditLogger) LogMFASuccess(userID, method string) {
	al.log(AuditEvent{
		Timestamp: time.Now(),
		Type:      "MFA_SUCCESS",
		UserID:    userID,
		Details:   method,
		Success:   true,
	})
}

func (al *AuditLogger) LogMFAFailure(userID, ipAddress string) {
	al.log(AuditEvent{
		Timestamp: time.Now(),
		Type:      "MFA_FAILED",
		UserID:    userID,
		IPAddress: ipAddress,
		Success:   false,
	})
}

func (al *AuditLogger) LogSecurityEvent(eventType, userID, details string) {
	al.log(AuditEvent{
		Timestamp: time.Now(),
		Type:      eventType,
		UserID:    userID,
		Details:   details,
		Success:   true,
	})
}

func (al *AuditLogger) log(event AuditEvent) {
	al.mu.Lock()
	defer al.mu.Unlock()
	al.events = append(al.events, event)
	// In production, write to persistent storage
}

// RateLimiter implements rate limiting
type RateLimiter struct {
	mu       sync.RWMutex
	requests map[string][]time.Time
	limit    int
	window   time.Duration
}

func NewRateLimiter() *RateLimiter {
	return &RateLimiter{
		requests: make(map[string][]time.Time),
		limit:    10,
		window:   time.Minute,
	}
}

func (rl *RateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	windowStart := now.Add(-rl.window)

	// Clean old requests
	if requests, exists := rl.requests[key]; exists {
		validRequests := []time.Time{}
		for _, t := range requests {
			if t.After(windowStart) {
				validRequests = append(validRequests, t)
			}
		}
		rl.requests[key] = validRequests
	}

	// Check limit
	if len(rl.requests[key]) >= rl.limit {
		return false
	}

	// Add new request
	rl.requests[key] = append(rl.requests[key], now)
	return true
}
