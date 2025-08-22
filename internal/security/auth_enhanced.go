package security

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base32"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
)

// AuthenticationManager handles advanced authentication
type AuthenticationManager struct {
	mu                 sync.RWMutex
	users              map[string]*User
	sessions           map[string]*AuthSession
	passwordPolicy     *PasswordPolicy
	mfaEnabled         bool
	accountLockout     *AccountLockoutPolicy
	bruteForceProtection *BruteForceProtection
}

// User represents a user account
type User struct {
	ID              string                 `json:"id"`
	Username        string                 `json:"username"`
	Email           string                 `json:"email"`
	PasswordHash    string                 `json:"password_hash"`
	Salt            string                 `json:"salt"`
	MFASecret       string                 `json:"mfa_secret,omitempty"`
	MFAEnabled      bool                   `json:"mfa_enabled"`
	Roles           []string               `json:"roles"`
	Permissions     []string               `json:"permissions"`
	CreatedAt       time.Time              `json:"created_at"`
	LastLogin       time.Time              `json:"last_login"`
	FailedAttempts  int                    `json:"failed_attempts"`
	LockedUntil     time.Time              `json:"locked_until,omitempty"`
	PasswordExpiry  time.Time              `json:"password_expiry"`
	ForcePasswordChange bool               `json:"force_password_change"`
	Metadata        map[string]interface{} `json:"metadata,omitempty"`
}

// AuthSession represents an authenticated session
type AuthSession struct {
	ID          string                 `json:"id"`
	UserID      string                 `json:"user_id"`
	Username    string                 `json:"username"`
	IPAddress   string                 `json:"ip_address"`
	UserAgent   string                 `json:"user_agent"`
	CreatedAt   time.Time              `json:"created_at"`
	LastAccess  time.Time              `json:"last_access"`
	ExpiresAt   time.Time              `json:"expires_at"`
	Permissions []string               `json:"permissions"`
	MFAVerified bool                   `json:"mfa_verified"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

// PasswordPolicy defines password requirements
type PasswordPolicy struct {
	MinLength        int  `json:"min_length"`
	RequireUppercase bool `json:"require_uppercase"`
	RequireLowercase bool `json:"require_lowercase"`
	RequireDigits    bool `json:"require_digits"`
	RequireSymbols   bool `json:"require_symbols"`
	MaxAge           time.Duration `json:"max_age"`
	HistoryCount     int  `json:"history_count"`
	NoCommonPasswords bool `json:"no_common_passwords"`
}

// AccountLockoutPolicy defines account lockout rules
type AccountLockoutPolicy struct {
	MaxFailedAttempts int           `json:"max_failed_attempts"`
	LockoutDuration   time.Duration `json:"lockout_duration"`
	ResetAfter        time.Duration `json:"reset_after"`
}

// BruteForceProtection protects against brute force attacks
type BruteForceProtection struct {
	attempts map[string]*AttemptTracker
	mu       sync.RWMutex
}

// AttemptTracker tracks authentication attempts per IP
type AttemptTracker struct {
	Count     int       `json:"count"`
	LastAttempt time.Time `json:"last_attempt"`
	BlockedUntil time.Time `json:"blocked_until,omitempty"`
}

// NewAuthenticationManager creates a new authentication manager
func NewAuthenticationManager() *AuthenticationManager {
	return &AuthenticationManager{
		users:    make(map[string]*User),
		sessions: make(map[string]*AuthSession),
		passwordPolicy: &PasswordPolicy{
			MinLength:        12,
			RequireUppercase: true,
			RequireLowercase: true,
			RequireDigits:    true,
			RequireSymbols:   true,
			MaxAge:           90 * 24 * time.Hour, // 90 days
			HistoryCount:     5,
			NoCommonPasswords: true,
		},
		accountLockout: &AccountLockoutPolicy{
			MaxFailedAttempts: 5,
			LockoutDuration:   15 * time.Minute,
			ResetAfter:        24 * time.Hour,
		},
		bruteForceProtection: &BruteForceProtection{
			attempts: make(map[string]*AttemptTracker),
		},
	}
}

// CreateUser creates a new user account
func (am *AuthenticationManager) CreateUser(username, email, password string, roles []string) (*User, error) {
	am.mu.Lock()
	defer am.mu.Unlock()
	
	// Check if user already exists
	for _, user := range am.users {
		if user.Username == username || user.Email == email {
			return nil, fmt.Errorf("user already exists")
		}
	}
	
	// Validate password policy
	if err := am.validatePassword(password); err != nil {
		return nil, fmt.Errorf("password policy violation: %w", err)
	}
	
	// Generate salt and hash password
	salt := generateSalt()
	passwordHash, err := am.hashPassword(password, salt)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}
	
	// Create user
	user := &User{
		ID:           generateUserID(),
		Username:     username,
		Email:        email,
		PasswordHash: passwordHash,
		Salt:         salt,
		Roles:        roles,
		CreatedAt:    time.Now(),
		PasswordExpiry: time.Now().Add(am.passwordPolicy.MaxAge),
		Metadata:     make(map[string]interface{}),
	}
	
	am.users[user.ID] = user
	return user, nil
}

// Authenticate authenticates a user
func (am *AuthenticationManager) Authenticate(username, password, ipAddress, userAgent string, mfaToken string) (*AuthSession, error) {
	am.mu.Lock()
	defer am.mu.Unlock()
	
	// Check brute force protection
	if am.isIPBlocked(ipAddress) {
		am.recordFailedAttempt(ipAddress)
		return nil, fmt.Errorf("IP address temporarily blocked due to too many failed attempts")
	}
	
	// Find user
	var user *User
	for _, u := range am.users {
		if u.Username == username {
			user = u
			break
		}
	}
	
	if user == nil {
		am.recordFailedAttempt(ipAddress)
		return nil, fmt.Errorf("invalid credentials")
	}
	
	// Check account lockout
	if user.LockedUntil.After(time.Now()) {
		return nil, fmt.Errorf("account locked until %v", user.LockedUntil)
	}
	
	// Verify password
	if !am.verifyPassword(password, user.Salt, user.PasswordHash) {
		user.FailedAttempts++
		am.recordFailedAttempt(ipAddress)
		
		// Check for account lockout
		if user.FailedAttempts >= am.accountLockout.MaxFailedAttempts {
			user.LockedUntil = time.Now().Add(am.accountLockout.LockoutDuration)
		}
		
		return nil, fmt.Errorf("invalid credentials")
	}
	
	// Check MFA if enabled
	if user.MFAEnabled {
		if mfaToken == "" {
			return nil, fmt.Errorf("MFA token required")
		}
		
		if !am.verifyMFAToken(user.MFASecret, mfaToken) {
			am.recordFailedAttempt(ipAddress)
			return nil, fmt.Errorf("invalid MFA token")
		}
	}
	
	// Check password expiry
	if user.PasswordExpiry.Before(time.Now()) {
		return nil, fmt.Errorf("password expired, must be changed")
	}
	
	// Reset failed attempts
	user.FailedAttempts = 0
	user.LastLogin = time.Now()
	am.resetFailedAttempts(ipAddress)
	
	// Create session
	session := &AuthSession{
		ID:          generateSessionID(),
		UserID:      user.ID,
		Username:    user.Username,
		IPAddress:   ipAddress,
		UserAgent:   userAgent,
		CreatedAt:   time.Now(),
		LastAccess:  time.Now(),
		ExpiresAt:   time.Now().Add(24 * time.Hour), // 24 hour session
		Permissions: user.Permissions,
		MFAVerified: user.MFAEnabled,
		Metadata:    make(map[string]interface{}),
	}
	
	am.sessions[session.ID] = session
	return session, nil
}

// ValidateSession validates a session
func (am *AuthenticationManager) ValidateSession(sessionID string) (*AuthSession, error) {
	am.mu.RLock()
	defer am.mu.RUnlock()
	
	session, exists := am.sessions[sessionID]
	if !exists {
		return nil, fmt.Errorf("session not found")
	}
	
	if session.ExpiresAt.Before(time.Now()) {
		delete(am.sessions, sessionID)
		return nil, fmt.Errorf("session expired")
	}
	
	// Update last access
	session.LastAccess = time.Now()
	return session, nil
}

// EnableMFA enables multi-factor authentication for a user
func (am *AuthenticationManager) EnableMFA(userID string) (string, error) {
	am.mu.Lock()
	defer am.mu.Unlock()
	
	user, exists := am.users[userID]
	if !exists {
		return "", fmt.Errorf("user not found")
	}
	
	// Generate MFA secret
	secret := generateMFASecret()
	user.MFASecret = secret
	user.MFAEnabled = true
	
	return secret, nil
}

// validatePassword validates password against policy
func (am *AuthenticationManager) validatePassword(password string) error {
	policy := am.passwordPolicy
	
	if len(password) < policy.MinLength {
		return fmt.Errorf("password must be at least %d characters", policy.MinLength)
	}
	
	if policy.RequireUppercase && !containsUppercase(password) {
		return fmt.Errorf("password must contain uppercase letters")
	}
	
	if policy.RequireLowercase && !containsLowercase(password) {
		return fmt.Errorf("password must contain lowercase letters")
	}
	
	if policy.RequireDigits && !containsDigits(password) {
		return fmt.Errorf("password must contain digits")
	}
	
	if policy.RequireSymbols && !containsSymbols(password) {
		return fmt.Errorf("password must contain symbols")
	}
	
	if policy.NoCommonPasswords && isCommonPassword(password) {
		return fmt.Errorf("password is too common")
	}
	
	return nil
}

// hashPassword hashes a password using Argon2
func (am *AuthenticationManager) hashPassword(password, salt string) (string, error) {
	// Argon2 parameters
	time := uint32(1)
	memory := uint32(64 * 1024) // 64 MB
	threads := uint8(4)
	keyLen := uint32(32)
	
	hash := argon2.IDKey([]byte(password), []byte(salt), time, memory, threads, keyLen)
	return base32.StdEncoding.EncodeToString(hash), nil
}

// verifyPassword verifies a password against its hash
func (am *AuthenticationManager) verifyPassword(password, salt, hash string) bool {
	expectedHash, err := am.hashPassword(password, salt)
	if err != nil {
		return false
	}
	
	// Use constant time comparison to prevent timing attacks
	return subtle.ConstantTimeCompare([]byte(expectedHash), []byte(hash)) == 1
}

// isIPBlocked checks if an IP is blocked due to brute force
func (am *AuthenticationManager) isIPBlocked(ipAddress string) bool {
	am.bruteForceProtection.mu.RLock()
	defer am.bruteForceProtection.mu.RUnlock()
	
	tracker, exists := am.bruteForceProtection.attempts[ipAddress]
	if !exists {
		return false
	}
	
	return tracker.BlockedUntil.After(time.Now())
}

// recordFailedAttempt records a failed authentication attempt
func (am *AuthenticationManager) recordFailedAttempt(ipAddress string) {
	am.bruteForceProtection.mu.Lock()
	defer am.bruteForceProtection.mu.Unlock()
	
	tracker, exists := am.bruteForceProtection.attempts[ipAddress]
	if !exists {
		tracker = &AttemptTracker{}
		am.bruteForceProtection.attempts[ipAddress] = tracker
	}
	
	tracker.Count++
	tracker.LastAttempt = time.Now()
	
	// Block after 10 failed attempts
	if tracker.Count >= 10 {
		tracker.BlockedUntil = time.Now().Add(30 * time.Minute)
	}
}

// resetFailedAttempts resets failed attempts for an IP
func (am *AuthenticationManager) resetFailedAttempts(ipAddress string) {
	am.bruteForceProtection.mu.Lock()
	defer am.bruteForceProtection.mu.Unlock()
	
	delete(am.bruteForceProtection.attempts, ipAddress)
}

// verifyMFAToken verifies a TOTP token
func (am *AuthenticationManager) verifyMFAToken(secret, token string) bool {
	// Simplified TOTP verification
	// In production, use a proper TOTP library like github.com/pquerna/otp
	currentTime := time.Now().Unix() / 30
	
	// Check current time window and adjacent windows for clock skew
	for i := -1; i <= 1; i++ {
		timeStep := currentTime + int64(i)
		expectedToken := generateTOTP(secret, timeStep)
		if subtle.ConstantTimeCompare([]byte(token), []byte(expectedToken)) == 1 {
			return true
		}
	}
	
	return false
}

// Helper functions

func generateSalt() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return base32.StdEncoding.EncodeToString(bytes)
}

func generateUserID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return base32.StdEncoding.EncodeToString(bytes)
}

func generateSessionID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return base32.StdEncoding.EncodeToString(bytes)
}

func generateMFASecret() string {
	bytes := make([]byte, 20)
	rand.Read(bytes)
	return base32.StdEncoding.EncodeToString(bytes)
}

func containsUppercase(s string) bool {
	for _, r := range s {
		if r >= 'A' && r <= 'Z' {
			return true
		}
	}
	return false
}

func containsLowercase(s string) bool {
	for _, r := range s {
		if r >= 'a' && r <= 'z' {
			return true
		}
	}
	return false
}

func containsDigits(s string) bool {
	for _, r := range s {
		if r >= '0' && r <= '9' {
			return true
		}
	}
	return false
}

func containsSymbols(s string) bool {
	symbols := "!@#$%^&*()_+-=[]{}|;:,.<>?"
	for _, r := range s {
		for _, symbol := range symbols {
			if r == symbol {
				return true
			}
		}
	}
	return false
}

func isCommonPassword(password string) bool {
	// Common passwords list (simplified)
	commonPasswords := []string{
		"password", "123456", "password123", "admin", "qwerty",
		"letmein", "welcome", "monkey", "dragon", "master",
	}
	
	lowerPassword := strings.ToLower(password)
	for _, common := range commonPasswords {
		if lowerPassword == common {
			return true
		}
	}
	
	return false
}

func generateTOTP(secret string, timeStep int64) string {
	// Simplified TOTP generation
	// In production, use proper TOTP implementation
	return fmt.Sprintf("%06d", (timeStep*123456)%1000000)
}

// SecurityHeaders middleware adds security headers
type SecurityHeaders struct {
	CSPPolicy           string
	HSTSMaxAge         int
	FrameOptions       string
	ContentTypeOptions bool
	XSSProtection      bool
	ReferrerPolicy     string
}

// DefaultSecurityHeaders returns default security headers
func DefaultSecurityHeaders() *SecurityHeaders {
	return &SecurityHeaders{
		CSPPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
		HSTSMaxAge: 31536000, // 1 year
		FrameOptions: "DENY",
		ContentTypeOptions: true,
		XSSProtection: true,
		ReferrerPolicy: "strict-origin-when-cross-origin",
	}
}

// Apply applies security headers to HTTP response
func (sh *SecurityHeaders) Apply(w http.ResponseWriter) {
	if sh.CSPPolicy != "" {
		w.Header().Set("Content-Security-Policy", sh.CSPPolicy)
	}
	
	if sh.HSTSMaxAge > 0 {
		w.Header().Set("Strict-Transport-Security", fmt.Sprintf("max-age=%d; includeSubDomains", sh.HSTSMaxAge))
	}
	
	if sh.FrameOptions != "" {
		w.Header().Set("X-Frame-Options", sh.FrameOptions)
	}
	
	if sh.ContentTypeOptions {
		w.Header().Set("X-Content-Type-Options", "nosniff")
	}
	
	if sh.XSSProtection {
		w.Header().Set("X-XSS-Protection", "1; mode=block")
	}
	
	if sh.ReferrerPolicy != "" {
		w.Header().Set("Referrer-Policy", sh.ReferrerPolicy)
	}
	
	// Additional security headers
	w.Header().Set("X-Permitted-Cross-Domain-Policies", "none")
	w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
}

// Middleware returns HTTP middleware for security headers
func (sh *SecurityHeaders) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sh.Apply(w)
		next.ServeHTTP(w, r)
	})
}