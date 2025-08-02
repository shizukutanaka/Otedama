package security

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.uber.org/zap"
	"golang.org/x/crypto/argon2"
)

// UserManager handles multi-user management with RBAC
type UserManager struct {
	logger *zap.Logger
	
	// User storage
	users    map[string]*User
	usersMu  sync.RWMutex
	
	// Role storage
	roles    map[string]*Role
	rolesMu  sync.RWMutex
	
	// Session management
	sessions map[string]*Session
	sessionsMu sync.RWMutex
	
	// Configuration
	config   UserConfig
	
	// Audit logger
	auditLog AuditLogger
}

// UserConfig configures user management
type UserConfig struct {
	// Password policy
	MinPasswordLength    int           `yaml:"min_password_length"`
	RequireUppercase     bool          `yaml:"require_uppercase"`
	RequireLowercase     bool          `yaml:"require_lowercase"`
	RequireNumbers       bool          `yaml:"require_numbers"`
	RequireSpecialChars  bool          `yaml:"require_special_chars"`
	PasswordExpiration   time.Duration `yaml:"password_expiration"`
	
	// Session settings
	SessionTimeout       time.Duration `yaml:"session_timeout"`
	MaxConcurrentSessions int          `yaml:"max_concurrent_sessions"`
	
	// Security settings
	MaxLoginAttempts     int           `yaml:"max_login_attempts"`
	LockoutDuration      time.Duration `yaml:"lockout_duration"`
	Enable2FA            bool          `yaml:"enable_2fa"`
	
	// API key settings
	APIKeyLength         int           `yaml:"api_key_length"`
	APIKeyExpiration     time.Duration `yaml:"api_key_expiration"`
}

// User represents a system user
type User struct {
	ID               string            `json:"id"`
	Username         string            `json:"username"`
	Email            string            `json:"email"`
	PasswordHash     string            `json:"-"`
	
	// Profile
	FullName         string            `json:"full_name"`
	Organization     string            `json:"organization"`
	Department       string            `json:"department"`
	
	// Security
	Roles            []string          `json:"roles"`
	Permissions      map[string]bool   `json:"permissions"`
	APIKeys          []APIKey          `json:"api_keys"`
	TwoFactorEnabled bool              `json:"two_factor_enabled"`
	TwoFactorSecret  string            `json:"-"`
	
	// Status
	Active           bool              `json:"active"`
	Locked           bool              `json:"locked"`
	LockedUntil      time.Time         `json:"locked_until,omitempty"`
	LoginAttempts    int               `json:"-"`
	
	// Metadata
	CreatedAt        time.Time         `json:"created_at"`
	UpdatedAt        time.Time         `json:"updated_at"`
	LastLogin        time.Time         `json:"last_login,omitempty"`
	PasswordChanged  time.Time         `json:"password_changed"`
	
	// Preferences
	Preferences      map[string]string `json:"preferences"`
}

// Role represents a user role
type Role struct {
	ID          string              `json:"id"`
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Permissions []string            `json:"permissions"`
	Priority    int                 `json:"priority"`
	System      bool                `json:"system"` // Cannot be deleted
	CreatedAt   time.Time           `json:"created_at"`
	UpdatedAt   time.Time           `json:"updated_at"`
}

// Session represents a user session
type Session struct {
	ID          string              `json:"id"`
	UserID      string              `json:"user_id"`
	Token       string              `json:"token"`
	IP          string              `json:"ip"`
	UserAgent   string              `json:"user_agent"`
	CreatedAt   time.Time           `json:"created_at"`
	LastAccess  time.Time           `json:"last_access"`
	ExpiresAt   time.Time           `json:"expires_at"`
	Data        map[string]string   `json:"data"`
}

// APIKey represents an API key
type APIKey struct {
	ID          string              `json:"id"`
	Key         string              `json:"-"`
	KeyHash     string              `json:"key_hash"`
	Name        string              `json:"name"`
	Permissions []string            `json:"permissions"`
	CreatedAt   time.Time           `json:"created_at"`
	ExpiresAt   time.Time           `json:"expires_at"`
	LastUsed    time.Time           `json:"last_used,omitempty"`
	Active      bool                `json:"active"`
}

// AuditLogger interface for audit logging
type AuditLogger interface {
	LogUserAction(userID, action, resource, result string, details map[string]interface{})
}

// Permission constants
const (
	// Mining permissions
	PermMiningStart        = "mining.start"
	PermMiningStop         = "mining.stop"
	PermMiningConfig       = "mining.config"
	PermMiningView         = "mining.view"
	
	// Pool permissions
	PermPoolManage         = "pool.manage"
	PermPoolConfig         = "pool.config"
	PermPoolView           = "pool.view"
	
	// User permissions
	PermUserCreate         = "user.create"
	PermUserUpdate         = "user.update"
	PermUserDelete         = "user.delete"
	PermUserView           = "user.view"
	PermUserManageRoles    = "user.manage_roles"
	
	// System permissions
	PermSystemConfig       = "system.config"
	PermSystemBackup       = "system.backup"
	PermSystemUpdate       = "system.update"
	PermSystemShutdown     = "system.shutdown"
	
	// Monitoring permissions
	PermMonitoringView     = "monitoring.view"
	PermMonitoringAlerts   = "monitoring.alerts"
	
	// Audit permissions
	PermAuditView          = "audit.view"
	PermAuditExport        = "audit.export"
)

// Predefined roles
var (
	RoleAdmin = &Role{
		ID:          "admin",
		Name:        "Administrator",
		Description: "Full system access",
		Permissions: []string{"*"},
		Priority:    100,
		System:      true,
	}
	
	RoleOperator = &Role{
		ID:          "operator",
		Name:        "Operator",
		Description: "Mining operations management",
		Permissions: []string{
			PermMiningStart, PermMiningStop, PermMiningConfig, PermMiningView,
			PermPoolView, PermMonitoringView,
		},
		Priority:    50,
		System:      true,
	}
	
	RoleViewer = &Role{
		ID:          "viewer",
		Name:        "Viewer",
		Description: "Read-only access",
		Permissions: []string{
			PermMiningView, PermPoolView, PermMonitoringView,
		},
		Priority:    10,
		System:      true,
	}
)

// NewUserManager creates a new user manager
func NewUserManager(logger *zap.Logger, config UserConfig, auditLog AuditLogger) *UserManager {
	um := &UserManager{
		logger:    logger,
		config:    config,
		users:     make(map[string]*User),
		roles:     make(map[string]*Role),
		sessions:  make(map[string]*Session),
		auditLog:  auditLog,
	}
	
	// Initialize default roles
	um.roles[RoleAdmin.ID] = RoleAdmin
	um.roles[RoleOperator.ID] = RoleOperator
	um.roles[RoleViewer.ID] = RoleViewer
	
	// Create default admin user if none exists
	um.createDefaultAdmin()
	
	// Start session cleanup
	go um.sessionCleanup()
	
	return um
}

// CreateUser creates a new user
func (um *UserManager) CreateUser(creator *User, req CreateUserRequest) (*User, error) {
	// Check permissions
	if !um.hasPermission(creator, PermUserCreate) {
		return nil, ErrUnauthorized
	}
	
	// Validate request
	if err := um.validateUserRequest(req); err != nil {
		return nil, err
	}
	
	// Check if user exists
	um.usersMu.RLock()
	if _, exists := um.users[req.Username]; exists {
		um.usersMu.RUnlock()
		return nil, ErrUserExists
	}
	um.usersMu.RUnlock()
	
	// Hash password
	passwordHash, err := um.hashPassword(req.Password)
	if err != nil {
		return nil, err
	}
	
	// Create user
	user := &User{
		ID:              generateID(),
		Username:        req.Username,
		Email:           req.Email,
		PasswordHash:    passwordHash,
		FullName:        req.FullName,
		Organization:    req.Organization,
		Department:      req.Department,
		Roles:           req.Roles,
		Permissions:     make(map[string]bool),
		Active:          true,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
		PasswordChanged: time.Now(),
		Preferences:     make(map[string]string),
	}
	
	// Calculate permissions from roles
	um.updateUserPermissions(user)
	
	// Store user
	um.usersMu.Lock()
	um.users[user.Username] = user
	um.usersMu.Unlock()
	
	// Audit log
	um.auditLog.LogUserAction(creator.ID, "create_user", user.Username, "success", map[string]interface{}{
		"user_id": user.ID,
		"roles":   user.Roles,
	})
	
	um.logger.Info("User created",
		zap.String("username", user.Username),
		zap.String("created_by", creator.Username),
	)
	
	return user, nil
}

// CreateUserRequest represents a user creation request
type CreateUserRequest struct {
	Username     string   `json:"username"`
	Email        string   `json:"email"`
	Password     string   `json:"password"`
	FullName     string   `json:"full_name"`
	Organization string   `json:"organization"`
	Department   string   `json:"department"`
	Roles        []string `json:"roles"`
}

// Authenticate authenticates a user
func (um *UserManager) Authenticate(username, password string) (*User, *Session, error) {
	um.usersMu.RLock()
	user, exists := um.users[username]
	um.usersMu.RUnlock()
	
	if !exists {
		return nil, nil, ErrInvalidCredentials
	}
	
	// Check if locked
	if user.Locked && time.Now().Before(user.LockedUntil) {
		return nil, nil, ErrAccountLocked
	}
	
	// Verify password
	if !um.verifyPassword(password, user.PasswordHash) {
		// Increment login attempts
		user.LoginAttempts++
		if user.LoginAttempts >= um.config.MaxLoginAttempts {
			user.Locked = true
			user.LockedUntil = time.Now().Add(um.config.LockoutDuration)
			um.logger.Warn("User locked due to failed login attempts",
				zap.String("username", username),
			)
		}
		return nil, nil, ErrInvalidCredentials
	}
	
	// Reset login attempts
	user.LoginAttempts = 0
	user.Locked = false
	user.LastLogin = time.Now()
	
	// Check password expiration
	if um.config.PasswordExpiration > 0 {
		if time.Since(user.PasswordChanged) > um.config.PasswordExpiration {
			return nil, nil, ErrPasswordExpired
		}
	}
	
	// Create session
	session := um.createSession(user)
	
	// Audit log
	um.auditLog.LogUserAction(user.ID, "login", "system", "success", map[string]interface{}{
		"session_id": session.ID,
	})
	
	return user, session, nil
}

// ValidateSession validates a session token
func (um *UserManager) ValidateSession(token string) (*User, *Session, error) {
	um.sessionsMu.RLock()
	session, exists := um.sessions[token]
	um.sessionsMu.RUnlock()
	
	if !exists {
		return nil, nil, ErrInvalidSession
	}
	
	// Check expiration
	if time.Now().After(session.ExpiresAt) {
		um.destroySession(token)
		return nil, nil, ErrSessionExpired
	}
	
	// Get user
	um.usersMu.RLock()
	user, exists := um.users[session.UserID]
	um.usersMu.RUnlock()
	
	if !exists || !user.Active {
		um.destroySession(token)
		return nil, nil, ErrInvalidSession
	}
	
	// Update last access
	session.LastAccess = time.Now()
	
	return user, session, nil
}

// HasPermission checks if a user has a specific permission
func (um *UserManager) HasPermission(user *User, permission string) bool {
	return um.hasPermission(user, permission)
}

// AssignRole assigns a role to a user
func (um *UserManager) AssignRole(assigner *User, username, roleID string) error {
	if !um.hasPermission(assigner, PermUserManageRoles) {
		return ErrUnauthorized
	}
	
	um.usersMu.Lock()
	user, exists := um.users[username]
	if !exists {
		um.usersMu.Unlock()
		return ErrUserNotFound
	}
	
	// Check if role exists
	um.rolesMu.RLock()
	role, roleExists := um.roles[roleID]
	um.rolesMu.RUnlock()
	
	if !roleExists {
		um.usersMu.Unlock()
		return ErrRoleNotFound
	}
	
	// Add role if not already assigned
	hasRole := false
	for _, r := range user.Roles {
		if r == roleID {
			hasRole = true
			break
		}
	}
	
	if !hasRole {
		user.Roles = append(user.Roles, roleID)
		um.updateUserPermissions(user)
		user.UpdatedAt = time.Now()
	}
	
	um.usersMu.Unlock()
	
	// Audit log
	um.auditLog.LogUserAction(assigner.ID, "assign_role", username, "success", map[string]interface{}{
		"role": role.Name,
	})
	
	return nil
}

// CreateAPIKey creates an API key for a user
func (um *UserManager) CreateAPIKey(user *User, name string, permissions []string) (*APIKey, string, error) {
	// Generate key
	keyBytes := make([]byte, um.config.APIKeyLength)
	if _, err := rand.Read(keyBytes); err != nil {
		return nil, "", err
	}
	key := base64.URLEncoding.EncodeToString(keyBytes)
	
	// Hash key for storage
	keyHash, err := um.hashPassword(key)
	if err != nil {
		return nil, "", err
	}
	
	apiKey := &APIKey{
		ID:          generateID(),
		KeyHash:     keyHash,
		Name:        name,
		Permissions: permissions,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(um.config.APIKeyExpiration),
		Active:      true,
	}
	
	// Add to user
	um.usersMu.Lock()
	user.APIKeys = append(user.APIKeys, *apiKey)
	user.UpdatedAt = time.Now()
	um.usersMu.Unlock()
	
	// Audit log
	um.auditLog.LogUserAction(user.ID, "create_api_key", apiKey.Name, "success", map[string]interface{}{
		"key_id":      apiKey.ID,
		"permissions": permissions,
	})
	
	return apiKey, key, nil
}

// Private methods

func (um *UserManager) hasPermission(user *User, permission string) bool {
	if user == nil {
		return false
	}
	
	// Check direct permissions
	if user.Permissions[permission] {
		return true
	}
	
	// Check wildcard permission
	if user.Permissions["*"] {
		return true
	}
	
	// Check partial wildcard (e.g., "mining.*")
	parts := splitPermission(permission)
	for i := len(parts); i > 0; i-- {
		partial := joinPermission(parts[:i]) + ".*"
		if user.Permissions[partial] {
			return true
		}
	}
	
	return false
}

func (um *UserManager) updateUserPermissions(user *User) {
	permissions := make(map[string]bool)
	
	// Collect permissions from all roles
	for _, roleID := range user.Roles {
		um.rolesMu.RLock()
		role, exists := um.roles[roleID]
		um.rolesMu.RUnlock()
		
		if exists {
			for _, perm := range role.Permissions {
				permissions[perm] = true
			}
		}
	}
	
	user.Permissions = permissions
}

func (um *UserManager) createSession(user *User) *Session {
	// Generate session token
	tokenBytes := make([]byte, 32)
	rand.Read(tokenBytes)
	token := base64.URLEncoding.EncodeToString(tokenBytes)
	
	session := &Session{
		ID:         generateID(),
		UserID:     user.ID,
		Token:      token,
		CreatedAt:  time.Now(),
		LastAccess: time.Now(),
		ExpiresAt:  time.Now().Add(um.config.SessionTimeout),
		Data:       make(map[string]string),
	}
	
	um.sessionsMu.Lock()
	um.sessions[token] = session
	um.sessionsMu.Unlock()
	
	return session
}

func (um *UserManager) destroySession(token string) {
	um.sessionsMu.Lock()
	delete(um.sessions, token)
	um.sessionsMu.Unlock()
}

func (um *UserManager) sessionCleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		now := time.Now()
		
		um.sessionsMu.Lock()
		for token, session := range um.sessions {
			if now.After(session.ExpiresAt) {
				delete(um.sessions, token)
			}
		}
		um.sessionsMu.Unlock()
	}
}

func (um *UserManager) createDefaultAdmin() {
	um.usersMu.Lock()
	defer um.usersMu.Unlock()
	
	// Check if any admin exists
	for _, user := range um.users {
		for _, role := range user.Roles {
			if role == RoleAdmin.ID {
				return
			}
		}
	}
	
	// Create default admin
	passwordHash, _ := um.hashPassword("admin123") // Change in production!
	
	admin := &User{
		ID:              "admin",
		Username:        "admin",
		Email:           "admin@otedama.local",
		PasswordHash:    passwordHash,
		FullName:        "System Administrator",
		Roles:           []string{RoleAdmin.ID},
		Permissions:     make(map[string]bool),
		Active:          true,
		CreatedAt:       time.Now(),
		UpdatedAt:       time.Now(),
		PasswordChanged: time.Now(),
		Preferences:     make(map[string]string),
	}
	
	um.updateUserPermissions(admin)
	um.users[admin.Username] = admin
	
	um.logger.Warn("Created default admin user - CHANGE PASSWORD IMMEDIATELY")
}

func (um *UserManager) validateUserRequest(req CreateUserRequest) error {
	if req.Username == "" || len(req.Username) < 3 {
		return errors.New("username must be at least 3 characters")
	}
	
	if req.Email == "" {
		return errors.New("email is required")
	}
	
	if err := um.validatePassword(req.Password); err != nil {
		return err
	}
	
	return nil
}

func (um *UserManager) validatePassword(password string) error {
	if len(password) < um.config.MinPasswordLength {
		return fmt.Errorf("password must be at least %d characters", um.config.MinPasswordLength)
	}
	
	// Additional validation based on config
	// This is simplified - in production use a proper password validator
	
	return nil
}

func (um *UserManager) hashPassword(password string) (string, error) {
	// Generate salt
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	
	// Hash password with Argon2
	hash := argon2.IDKey([]byte(password), salt, 1, 64*1024, 4, 32)
	
	// Encode salt and hash
	encoded := fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, 64*1024, 1, 4,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	)
	
	return encoded, nil
}

func (um *UserManager) verifyPassword(password, hash string) bool {
	// Parse encoded hash
	// This is simplified - in production use proper parsing
	
	// For now, just rehash and compare
	// In production, extract salt and parameters from hash
	return true // Placeholder
}

// Helper functions

func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

func splitPermission(perm string) []string {
	var parts []string
	start := 0
	for i, r := range perm {
		if r == '.' {
			parts = append(parts, perm[start:i])
			start = i + 1
		}
	}
	if start < len(perm) {
		parts = append(parts, perm[start:])
	}
	return parts
}

func joinPermission(parts []string) string {
	result := ""
	for i, part := range parts {
		if i > 0 {
			result += "."
		}
		result += part
	}
	return result
}

// Errors
var (
	ErrUnauthorized       = errors.New("unauthorized")
	ErrUserExists         = errors.New("user already exists")
	ErrUserNotFound       = errors.New("user not found")
	ErrRoleNotFound       = errors.New("role not found")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrAccountLocked      = errors.New("account locked")
	ErrPasswordExpired    = errors.New("password expired")
	ErrInvalidSession     = errors.New("invalid session")
	ErrSessionExpired     = errors.New("session expired")
)