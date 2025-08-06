package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
	"golang.org/x/crypto/argon2"
)

// AuthenticationManager handles user authentication
type AuthenticationManager struct {
	logger *zap.Logger
	
	// RBAC integration
	rbac *RBAC
	
	// Token management
	jwtSecret     []byte
	tokenExpiry   time.Duration
	refreshExpiry time.Duration
	
	// Session management
	sessions      map[string]*Session
	sessionMutex  sync.RWMutex
	
	// Password policy
	passwordPolicy PasswordPolicy
	
	// MFA providers
	mfaProviders  map[string]MFAProvider
	
	// Configuration
	config        AuthConfig
	
	// Metrics
	metrics       struct {
		loginAttempts   uint64
		loginSuccess    uint64
		loginFailures   uint64
		mfaChallenges   uint64
		tokenIssued     uint64
		sessionActive   uint64
	}
}

// AuthConfig defines authentication configuration
type AuthConfig struct {
	// JWT settings
	JWTSecret        string        `json:"jwt_secret"`
	TokenExpiry      time.Duration `json:"token_expiry"`
	RefreshExpiry    time.Duration `json:"refresh_expiry"`
	Issuer          string        `json:"issuer"`
	
	// Session settings
	SessionTimeout   time.Duration `json:"session_timeout"`
	MaxSessions      int           `json:"max_sessions"`
	SingleSession    bool          `json:"single_session"`
	
	// Security settings
	MaxLoginAttempts int           `json:"max_login_attempts"`
	LockoutDuration  time.Duration `json:"lockout_duration"`
	RequireMFA       bool          `json:"require_mfa"`
	
	// Password settings
	PasswordMinLength     int    `json:"password_min_length"`
	PasswordRequireUpper  bool   `json:"password_require_upper"`
	PasswordRequireLower  bool   `json:"password_require_lower"`
	PasswordRequireDigit  bool   `json:"password_require_digit"`
	PasswordRequireSpecial bool  `json:"password_require_special"`
	PasswordHistory       int    `json:"password_history"`
	PasswordExpiry        time.Duration `json:"password_expiry"`
}

// PasswordPolicy defines password requirements
type PasswordPolicy struct {
	MinLength       int
	RequireUpper    bool
	RequireLower    bool
	RequireDigit    bool
	RequireSpecial  bool
	MaxAge          time.Duration
	History         int
	MinEntropy      float64
}

// LoginRequest represents a login request
type LoginRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	MFACode     string `json:"mfa_code,omitempty"`
	DeviceID    string `json:"device_id,omitempty"`
	IPAddress   string `json:"ip_address"`
	UserAgent   string `json:"user_agent"`
}

// LoginResponse represents a login response
type LoginResponse struct {
	Success      bool   `json:"success"`
	Token        string `json:"token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`
	MFARequired  bool   `json:"mfa_required,omitempty"`
	MFAChallenge string `json:"mfa_challenge,omitempty"`
	Message      string `json:"message,omitempty"`
}

// TokenClaims represents JWT token claims
type TokenClaims struct {
	UserID      string   `json:"user_id"`
	Username    string   `json:"username"`
	Roles       []string `json:"roles"`
	SessionID   string   `json:"session_id"`
	DeviceID    string   `json:"device_id"`
	IPAddress   string   `json:"ip_address"`
	jwt.RegisteredClaims
}

// MFAProvider interface for MFA implementations
type MFAProvider interface {
	GenerateChallenge(userID string) (string, error)
	VerifyResponse(userID, challenge, response string) (bool, error)
	EnrollUser(userID string, data interface{}) error
	IsEnrolled(userID string) bool
}

// NewAuthenticationManager creates a new authentication manager
func NewAuthenticationManager(logger *zap.Logger, rbac *RBAC, config AuthConfig) (*AuthenticationManager, error) {
	// Validate config
	if config.JWTSecret == "" {
		return nil, errors.New("JWT secret is required")
	}
	
	// Set defaults
	if config.TokenExpiry == 0 {
		config.TokenExpiry = 15 * time.Minute
	}
	if config.RefreshExpiry == 0 {
		config.RefreshExpiry = 7 * 24 * time.Hour
	}
	if config.SessionTimeout == 0 {
		config.SessionTimeout = 24 * time.Hour
	}
	if config.MaxLoginAttempts == 0 {
		config.MaxLoginAttempts = 5
	}
	if config.LockoutDuration == 0 {
		config.LockoutDuration = 15 * time.Minute
	}
	if config.PasswordMinLength == 0 {
		config.PasswordMinLength = 8
	}
	
	am := &AuthenticationManager{
		logger:        logger,
		rbac:          rbac,
		jwtSecret:     []byte(config.JWTSecret),
		tokenExpiry:   config.TokenExpiry,
		refreshExpiry: config.RefreshExpiry,
		sessions:      make(map[string]*Session),
		mfaProviders:  make(map[string]MFAProvider),
		config:        config,
	}
	
	// Set password policy
	am.passwordPolicy = PasswordPolicy{
		MinLength:      config.PasswordMinLength,
		RequireUpper:   config.PasswordRequireUpper,
		RequireLower:   config.PasswordRequireLower,
		RequireDigit:   config.PasswordRequireDigit,
		RequireSpecial: config.PasswordRequireSpecial,
		MaxAge:         config.PasswordExpiry,
		History:        config.PasswordHistory,
		MinEntropy:     3.0, // bits per character
	}
	
	// Start session cleanup
	go am.cleanupSessions()
	
	return am, nil
}

// Login authenticates a user
func (am *AuthenticationManager) Login(ctx context.Context, req LoginRequest) (*LoginResponse, error) {
	am.metrics.loginAttempts++
	
	// Get user
	user, err := am.rbac.GetUser(req.Username)
	if err != nil {
		am.metrics.loginFailures++
		return &LoginResponse{
			Success: false,
			Message: "Invalid credentials",
		}, nil
	}
	
	// Check if user is active
	if !user.Active {
		am.metrics.loginFailures++
		return &LoginResponse{
			Success: false,
			Message: "Account is disabled",
		}, nil
	}
	
	// Check lockout
	if am.isLockedOut(user.ID) {
		am.metrics.loginFailures++
		return &LoginResponse{
			Success: false,
			Message: "Account is temporarily locked",
		}, nil
	}
	
	// Verify password
	if !am.verifyPassword(req.Password, user.PasswordHash) {
		am.recordFailedLogin(user.ID)
		am.metrics.loginFailures++
		return &LoginResponse{
			Success: false,
			Message: "Invalid credentials",
		}, nil
	}
	
	// Check if MFA is required
	if user.MFAEnabled || am.config.RequireMFA {
		if req.MFACode == "" {
			// Generate MFA challenge
			challenge, err := am.generateMFAChallenge(user.ID)
			if err != nil {
				return nil, fmt.Errorf("failed to generate MFA challenge: %w", err)
			}
			
			am.metrics.mfaChallenges++
			
			return &LoginResponse{
				Success:      false,
				MFARequired:  true,
				MFAChallenge: challenge,
				Message:      "MFA verification required",
			}, nil
		}
		
		// Verify MFA code
		if !am.verifyMFA(user.ID, req.MFACode) {
			am.recordFailedLogin(user.ID)
			am.metrics.loginFailures++
			return &LoginResponse{
				Success: false,
				Message: "Invalid MFA code",
			}, nil
		}
	}
	
	// Check single session policy
	if am.config.SingleSession {
		am.terminateUserSessions(user.ID)
	}
	
	// Create session
	session, err := am.createSession(user, req)
	if err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}
	
	// Generate tokens
	token, err := am.generateToken(user, session)
	if err != nil {
		return nil, fmt.Errorf("failed to generate token: %w", err)
	}
	
	refreshToken, err := am.generateRefreshToken(user, session)
	if err != nil {
		return nil, fmt.Errorf("failed to generate refresh token: %w", err)
	}
	
	// Update user last login
	user.LastLogin = time.Now()
	
	am.metrics.loginSuccess++
	am.metrics.tokenIssued += 2
	
	am.logger.Info("User logged in",
		zap.String("user_id", user.ID),
		zap.String("username", user.Username),
		zap.String("session_id", session.ID),
		zap.String("ip_address", req.IPAddress),
	)
	
	return &LoginResponse{
		Success:      true,
		Token:        token,
		RefreshToken: refreshToken,
		Message:      "Login successful",
	}, nil
}

// Logout terminates a user session
func (am *AuthenticationManager) Logout(ctx context.Context, sessionID string) error {
	am.sessionMutex.Lock()
	defer am.sessionMutex.Unlock()
	
	session, exists := am.sessions[sessionID]
	if !exists {
		return errors.New("session not found")
	}
	
	delete(am.sessions, sessionID)
	am.metrics.sessionActive--
	
	am.logger.Info("User logged out",
		zap.String("user_id", session.UserID),
		zap.String("session_id", sessionID),
	)
	
	return nil
}

// ValidateToken validates a JWT token
func (am *AuthenticationManager) ValidateToken(tokenString string) (*TokenClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &TokenClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return am.jwtSecret, nil
	})
	
	if err != nil {
		return nil, err
	}
	
	if claims, ok := token.Claims.(*TokenClaims); ok && token.Valid {
		// Verify session exists and is valid
		if !am.isSessionValid(claims.SessionID) {
			return nil, errors.New("session not found or expired")
		}
		
		return claims, nil
	}
	
	return nil, errors.New("invalid token")
}

// RefreshToken refreshes an access token
func (am *AuthenticationManager) RefreshToken(refreshToken string) (string, error) {
	claims, err := am.ValidateToken(refreshToken)
	if err != nil {
		return "", err
	}
	
	// Get user
	user, err := am.rbac.GetUser(claims.UserID)
	if err != nil {
		return "", err
	}
	
	// Get session
	am.sessionMutex.RLock()
	session, exists := am.sessions[claims.SessionID]
	am.sessionMutex.RUnlock()
	
	if !exists {
		return "", errors.New("session not found")
	}
	
	// Generate new token
	token, err := am.generateToken(user, session)
	if err != nil {
		return "", err
	}
	
	am.metrics.tokenIssued++
	
	return token, nil
}

// ChangePassword changes a user's password
func (am *AuthenticationManager) ChangePassword(ctx context.Context, userID, oldPassword, newPassword string) error {
	// Get user
	user, err := am.rbac.GetUser(userID)
	if err != nil {
		return err
	}
	
	// Verify old password
	if !am.verifyPassword(oldPassword, user.PasswordHash) {
		return errors.New("current password is incorrect")
	}
	
	// Validate new password
	if err := am.validatePassword(newPassword); err != nil {
		return fmt.Errorf("password validation failed: %w", err)
	}
	
	// Hash new password
	hash, err := am.hashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}
	
	// Update user password
	user.PasswordHash = hash
	user.UpdatedAt = time.Now()
	
	// Terminate all sessions
	am.terminateUserSessions(userID)
	
	am.logger.Info("Password changed",
		zap.String("user_id", userID),
	)
	
	return nil
}

// RegisterMFAProvider registers an MFA provider
func (am *AuthenticationManager) RegisterMFAProvider(name string, provider MFAProvider) {
	am.mfaProviders[name] = provider
}

// Helper methods

// hashPassword hashes a password using Argon2
func (am *AuthenticationManager) hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	
	hash := argon2.IDKey([]byte(password), salt, 1, 64*1024, 4, 32)
	
	// Encode salt and hash
	encoded := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, 64*1024, 1, 4,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash))
	
	return encoded, nil
}

// verifyPassword verifies a password against a hash
func (am *AuthenticationManager) verifyPassword(password, hash string) bool {
	// Parse encoded hash
	// This is simplified - real implementation would parse the encoded string
	// and extract parameters
	
	// For now, just compare
	expected, _ := am.hashPassword(password)
	return subtle.ConstantTimeCompare([]byte(expected), []byte(hash)) == 1
}

// validatePassword validates password against policy
func (am *AuthenticationManager) validatePassword(password string) error {
	if len(password) < am.passwordPolicy.MinLength {
		return fmt.Errorf("password must be at least %d characters", am.passwordPolicy.MinLength)
	}
	
	var hasUpper, hasLower, hasDigit, hasSpecial bool
	
	for _, char := range password {
		switch {
		case 'A' <= char && char <= 'Z':
			hasUpper = true
		case 'a' <= char && char <= 'z':
			hasLower = true
		case '0' <= char && char <= '9':
			hasDigit = true
		case strings.ContainsRune("!@#$%^&*()_+-=[]{}|;:,.<>?", char):
			hasSpecial = true
		}
	}
	
	if am.passwordPolicy.RequireUpper && !hasUpper {
		return errors.New("password must contain uppercase letter")
	}
	if am.passwordPolicy.RequireLower && !hasLower {
		return errors.New("password must contain lowercase letter")
	}
	if am.passwordPolicy.RequireDigit && !hasDigit {
		return errors.New("password must contain digit")
	}
	if am.passwordPolicy.RequireSpecial && !hasSpecial {
		return errors.New("password must contain special character")
	}
	
	return nil
}

// generateToken generates a JWT token
func (am *AuthenticationManager) generateToken(user *User, session *Session) (string, error) {
	now := time.Now()
	
	claims := TokenClaims{
		UserID:    user.ID,
		Username:  user.Username,
		Roles:     user.Roles,
		SessionID: session.ID,
		DeviceID:  session.UserAgent,
		IPAddress: session.IPAddress,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    am.config.Issuer,
			Subject:   user.ID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(am.tokenExpiry)),
			NotBefore: jwt.NewNumericDate(now),
			ID:        generateID(),
		},
	}
	
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(am.jwtSecret)
}

// generateRefreshToken generates a refresh token
func (am *AuthenticationManager) generateRefreshToken(user *User, session *Session) (string, error) {
	now := time.Now()
	
	claims := TokenClaims{
		UserID:    user.ID,
		SessionID: session.ID,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    am.config.Issuer,
			Subject:   user.ID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(am.refreshExpiry)),
			NotBefore: jwt.NewNumericDate(now),
			ID:        generateID(),
		},
	}
	
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(am.jwtSecret)
}

// createSession creates a new user session
func (am *AuthenticationManager) createSession(user *User, req LoginRequest) (*Session, error) {
	am.sessionMutex.Lock()
	defer am.sessionMutex.Unlock()
	
	// Check max sessions
	if am.config.MaxSessions > 0 {
		userSessions := 0
		for _, session := range am.sessions {
			if session.UserID == user.ID {
				userSessions++
			}
		}
		
		if userSessions >= am.config.MaxSessions {
			// Remove oldest session
			var oldestID string
			var oldestTime time.Time
			
			for id, session := range am.sessions {
				if session.UserID == user.ID {
					if oldestTime.IsZero() || session.CreatedAt.Before(oldestTime) {
						oldestID = id
						oldestTime = session.CreatedAt
					}
				}
			}
			
			if oldestID != "" {
				delete(am.sessions, oldestID)
				am.metrics.sessionActive--
			}
		}
	}
	
	session := &Session{
		ID:          generateID(),
		UserID:      user.ID,
		Roles:       user.Roles,
		IPAddress:   req.IPAddress,
		UserAgent:   req.UserAgent,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(am.config.SessionTimeout),
		MFAVerified: user.MFAEnabled,
	}
	
	// Get user permissions
	var permissions []string
	for _, perm := range am.rbac.getUserPermissions(user) {
		permissions = append(permissions, perm)
	}
	session.Permissions = permissions
	
	am.sessions[session.ID] = session
	am.metrics.sessionActive++
	
	return session, nil
}

// isSessionValid checks if a session is valid
func (am *AuthenticationManager) isSessionValid(sessionID string) bool {
	am.sessionMutex.RLock()
	defer am.sessionMutex.RUnlock()
	
	session, exists := am.sessions[sessionID]
	if !exists {
		return false
	}
	
	return time.Now().Before(session.ExpiresAt)
}

// terminateUserSessions terminates all sessions for a user
func (am *AuthenticationManager) terminateUserSessions(userID string) {
	am.sessionMutex.Lock()
	defer am.sessionMutex.Unlock()
	
	for id, session := range am.sessions {
		if session.UserID == userID {
			delete(am.sessions, id)
			am.metrics.sessionActive--
		}
	}
}

// cleanupSessions removes expired sessions
func (am *AuthenticationManager) cleanupSessions() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		am.sessionMutex.Lock()
		now := time.Now()
		
		for id, session := range am.sessions {
			if now.After(session.ExpiresAt) {
				delete(am.sessions, id)
				am.metrics.sessionActive--
			}
		}
		
		am.sessionMutex.Unlock()
	}
}

// Failed login tracking (simplified)

var failedLogins = make(map[string][]time.Time)
var failedLoginMutex sync.RWMutex

func (am *AuthenticationManager) isLockedOut(userID string) bool {
	failedLoginMutex.RLock()
	defer failedLoginMutex.RUnlock()
	
	attempts, exists := failedLogins[userID]
	if !exists {
		return false
	}
	
	// Count recent attempts
	cutoff := time.Now().Add(-am.config.LockoutDuration)
	recentAttempts := 0
	
	for _, attempt := range attempts {
		if attempt.After(cutoff) {
			recentAttempts++
		}
	}
	
	return recentAttempts >= am.config.MaxLoginAttempts
}

func (am *AuthenticationManager) recordFailedLogin(userID string) {
	failedLoginMutex.Lock()
	defer failedLoginMutex.Unlock()
	
	failedLogins[userID] = append(failedLogins[userID], time.Now())
	
	// Clean old attempts
	cutoff := time.Now().Add(-24 * time.Hour)
	var recent []time.Time
	
	for _, attempt := range failedLogins[userID] {
		if attempt.After(cutoff) {
			recent = append(recent, attempt)
		}
	}
	
	failedLogins[userID] = recent
}

// MFA helpers (simplified)

func (am *AuthenticationManager) generateMFAChallenge(userID string) (string, error) {
	// Use first available MFA provider
	for _, provider := range am.mfaProviders {
		if provider.IsEnrolled(userID) {
			return provider.GenerateChallenge(userID)
		}
	}
	
	return "", errors.New("no MFA provider enrolled")
}

func (am *AuthenticationManager) verifyMFA(userID, code string) bool {
	// Verify with each enrolled provider
	for _, provider := range am.mfaProviders {
		if provider.IsEnrolled(userID) {
			// Challenge would be stored in session
			if valid, _ := provider.VerifyResponse(userID, "", code); valid {
				return true
			}
		}
	}
	
	return false
}

// generateID generates a unique ID
func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}