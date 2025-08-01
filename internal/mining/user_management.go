package mining

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/crypto/bcrypt"
)

// UserManager manages multi-user access with roles and permissions
type UserManager struct {
	logger *zap.Logger
	
	// User storage
	users      map[string]*User
	usersMu    sync.RWMutex
	
	// Session management
	sessions   map[string]*Session
	sessionsMu sync.RWMutex
	
	// Role management
	roles      map[string]*Role
	rolesMu    sync.RWMutex
	
	// Permission management
	permissions map[string]*Permission
	permsMu     sync.RWMutex
	
	// API keys
	apiKeys    map[string]*APIKey
	apiKeysMu  sync.RWMutex
	
	// Audit log
	auditLog   *AuditLogger
	
	// Configuration
	config     UserManagerConfig
	
	// Metrics
	totalUsers atomic.Uint64
	activeSessions atomic.Uint64
	
	// Lifecycle
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

// UserManagerConfig configures user management
type UserManagerConfig struct {
	// Session settings
	SessionTimeout      time.Duration
	MaxSessionsPerUser  int
	
	// Security settings
	MinPasswordLength   int
	RequireMFA          bool
	PasswordExpiry      time.Duration
	
	// API settings
	APIKeyLength        int
	APIKeyExpiry        time.Duration
	
	// Audit settings
	AuditRetention      time.Duration
	AuditLogPath        string
}

// User represents a system user
type User struct {
	ID              string
	Username        string
	Email           string
	PasswordHash    string
	
	// Profile
	FullName        string
	Organization    string
	Department      string
	
	// Roles and permissions
	Roles           []string
	Permissions     []string
	
	// Security
	MFAEnabled      bool
	MFASecret       string
	LastLogin       *time.Time
	PasswordChanged time.Time
	
	// Status
	Active          bool
	Locked          bool
	LockReason      string
	
	// Metadata
	CreatedAt       time.Time
	UpdatedAt       time.Time
	CreatedBy       string
	
	// Settings
	Preferences     map[string]interface{}
	
	// Resource limits
	ResourceQuota   *ResourceQuota
}

// Session represents an active user session
type Session struct {
	ID              string
	UserID          string
	Token           string
	
	// Session info
	IPAddress       string
	UserAgent       string
	Location        string
	
	// Timing
	CreatedAt       time.Time
	LastActivity    time.Time
	ExpiresAt       time.Time
	
	// Security
	MFAVerified     bool
	Permissions     []string // Cached permissions
}

// Role represents a user role
type Role struct {
	ID              string
	Name            string
	Description     string
	
	// Permissions
	Permissions     []string
	
	// Hierarchy
	ParentRole      string
	Priority        int
	
	// Status
	Active          bool
	System          bool // Cannot be modified
	
	// Metadata
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// Permission represents a system permission
type Permission struct {
	ID              string
	Name            string
	Resource        string
	Action          string
	Description     string
	
	// Scope
	Scope           string // "global", "organization", "personal"
	
	// Dependencies
	RequiredPerms   []string
	
	// Metadata
	CreatedAt       time.Time
	System          bool
}

// APIKey represents an API access key
type APIKey struct {
	ID              string
	Key             string
	UserID          string
	Name            string
	Description     string
	
	// Permissions
	Permissions     []string
	RateLimit       int // Requests per minute
	
	// Security
	IPWhitelist     []string
	LastUsed        *time.Time
	UseCount        uint64
	
	// Status
	Active          bool
	ExpiresAt       *time.Time
	
	// Metadata
	CreatedAt       time.Time
}

// ResourceQuota defines resource limits for a user
type ResourceQuota struct {
	// Mining resources
	MaxHashRate     float64
	MaxPowerUsage   float64
	MaxGPUs         int
	MaxCPUThreads   int
	
	// Storage
	MaxStorage      int64 // Bytes
	
	// Network
	MaxBandwidth    int64 // Bytes per second
	
	// Time restrictions
	AllowedHours    []int // Hours of day allowed
	AllowedDays     []int // Days of week allowed
}

// AuditLogger logs user actions
type AuditLogger struct {
	entries    []*AuditEntry
	entriesMu  sync.RWMutex
	maxEntries int
}

// AuditEntry represents an audit log entry
type AuditEntry struct {
	ID              string
	Timestamp       time.Time
	UserID          string
	Username        string
	Action          string
	Resource        string
	ResourceID      string
	Details         map[string]interface{}
	IPAddress       string
	Success         bool
	ErrorMessage    string
}

// Predefined roles
var (
	RoleAdmin = &Role{
		ID:          "admin",
		Name:        "Administrator",
		Description: "Full system access",
		Permissions: []string{"*"},
		System:      true,
		Priority:    100,
	}
	
	RoleOperator = &Role{
		ID:          "operator",
		Name:        "Operator",
		Description: "Mining operations management",
		Permissions: []string{
			"mining.start", "mining.stop", "mining.configure",
			"pool.switch", "hardware.monitor", "alerts.view",
		},
		System:   true,
		Priority: 50,
	}
	
	RoleViewer = &Role{
		ID:          "viewer",
		Name:        "Viewer",
		Description: "Read-only access",
		Permissions: []string{
			"*.view", "*.read", "stats.export",
		},
		System:   true,
		Priority: 10,
	}
)

// NewUserManager creates a new user manager
func NewUserManager(logger *zap.Logger, config UserManagerConfig) *UserManager {
	ctx, cancel := context.WithCancel(context.Background())
	
	um := &UserManager{
		logger:      logger,
		config:      config,
		users:       make(map[string]*User),
		sessions:    make(map[string]*Session),
		roles:       make(map[string]*Role),
		permissions: make(map[string]*Permission),
		apiKeys:     make(map[string]*APIKey),
		ctx:         ctx,
		cancel:      cancel,
	}
	
	// Initialize audit logger
	um.auditLog = &AuditLogger{
		entries:    make([]*AuditEntry, 0, 10000),
		maxEntries: 10000,
	}
	
	// Initialize default roles
	um.initializeDefaultRoles()
	
	// Initialize default permissions
	um.initializeDefaultPermissions()
	
	// Create default admin user
	um.createDefaultAdmin()
	
	return um
}

// Start begins user management services
func (um *UserManager) Start() error {
	um.logger.Info("Starting user management")
	
	// Start session cleanup
	um.wg.Add(1)
	go um.sessionCleanup()
	
	// Start audit log rotation
	um.wg.Add(1)
	go um.auditLogRotation()
	
	// Start quota enforcement
	um.wg.Add(1)
	go um.quotaEnforcement()
	
	return nil
}

// Stop stops user management services
func (um *UserManager) Stop() error {
	um.logger.Info("Stopping user management")
	
	um.cancel()
	um.wg.Wait()
	
	// Save audit log
	um.saveAuditLog()
	
	return nil
}

// CreateUser creates a new user
func (um *UserManager) CreateUser(creator string, userReq *CreateUserRequest) (*User, error) {
	// Validate request
	if err := um.validateUserRequest(userReq); err != nil {
		return nil, err
	}
	
	// Check permissions
	if !um.hasPermission(creator, "users.create") {
		um.auditLog.Log(&AuditEntry{
			UserID:   creator,
			Action:   "create_user",
			Resource: "user",
			Success:  false,
			ErrorMessage: "permission denied",
		})
		return nil, errors.New("permission denied")
	}
	
	// Hash password
	hash, err := bcrypt.GenerateFromPassword([]byte(userReq.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}
	
	// Create user
	user := &User{
		ID:           um.generateID(),
		Username:     userReq.Username,
		Email:        userReq.Email,
		PasswordHash: string(hash),
		FullName:     userReq.FullName,
		Organization: userReq.Organization,
		Department:   userReq.Department,
		Roles:        userReq.Roles,
		Active:       true,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
		CreatedBy:    creator,
		PasswordChanged: time.Now(),
		Preferences:  make(map[string]interface{}),
	}
	
	// Set resource quota
	if userReq.ResourceQuota != nil {
		user.ResourceQuota = userReq.ResourceQuota
	} else {
		user.ResourceQuota = um.getDefaultQuota()
	}
	
	// Save user
	um.usersMu.Lock()
	um.users[user.ID] = user
	um.usersMu.Unlock()
	
	um.totalUsers.Add(1)
	
	// Audit log
	um.auditLog.Log(&AuditEntry{
		UserID:     creator,
		Action:     "create_user",
		Resource:   "user",
		ResourceID: user.ID,
		Details: map[string]interface{}{
			"username": user.Username,
			"roles":    user.Roles,
		},
		Success: true,
	})
	
	um.logger.Info("User created",
		zap.String("user_id", user.ID),
		zap.String("username", user.Username),
		zap.String("created_by", creator),
	)
	
	return user, nil
}

// AuthenticateUser authenticates a user
func (um *UserManager) AuthenticateUser(username, password string) (*User, error) {
	um.usersMu.RLock()
	var user *User
	for _, u := range um.users {
		if u.Username == username {
			user = u
			break
		}
	}
	um.usersMu.RUnlock()
	
	if user == nil {
		return nil, errors.New("invalid username or password")
	}
	
	// Check if user is active
	if !user.Active {
		return nil, errors.New("user account is disabled")
	}
	
	// Check if user is locked
	if user.Locked {
		return nil, fmt.Errorf("user account is locked: %s", user.LockReason)
	}
	
	// Verify password
	err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password))
	if err != nil {
		// Log failed attempt
		um.auditLog.Log(&AuditEntry{
			UserID:   user.ID,
			Username: user.Username,
			Action:   "login_failed",
			Resource: "session",
			Success:  false,
			ErrorMessage: "invalid password",
		})
		return nil, errors.New("invalid username or password")
	}
	
	// Check password expiry
	if um.config.PasswordExpiry > 0 {
		if time.Since(user.PasswordChanged) > um.config.PasswordExpiry {
			return nil, errors.New("password expired")
		}
	}
	
	// Update last login
	now := time.Now()
	user.LastLogin = &now
	
	return user, nil
}

// CreateSession creates a new user session
func (um *UserManager) CreateSession(user *User, ipAddress, userAgent string) (*Session, error) {
	// Check max sessions
	activeSessions := um.getActiveSessionCount(user.ID)
	if activeSessions >= um.config.MaxSessionsPerUser {
		return nil, errors.New("maximum sessions exceeded")
	}
	
	// Generate session token
	token := um.generateToken()
	
	// Get user permissions
	permissions := um.getUserPermissions(user)
	
	// Create session
	session := &Session{
		ID:           um.generateID(),
		UserID:       user.ID,
		Token:        token,
		IPAddress:    ipAddress,
		UserAgent:    userAgent,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
		ExpiresAt:    time.Now().Add(um.config.SessionTimeout),
		Permissions:  permissions,
	}
	
	// Save session
	um.sessionsMu.Lock()
	um.sessions[session.Token] = session
	um.sessionsMu.Unlock()
	
	um.activeSessions.Add(1)
	
	// Audit log
	um.auditLog.Log(&AuditEntry{
		UserID:    user.ID,
		Username:  user.Username,
		Action:    "create_session",
		Resource:  "session",
		ResourceID: session.ID,
		IPAddress: ipAddress,
		Success:   true,
	})
	
	return session, nil
}

// ValidateSession validates a session token
func (um *UserManager) ValidateSession(token string) (*Session, *User, error) {
	um.sessionsMu.RLock()
	session, exists := um.sessions[token]
	um.sessionsMu.RUnlock()
	
	if !exists {
		return nil, nil, errors.New("invalid session")
	}
	
	// Check expiry
	if time.Now().After(session.ExpiresAt) {
		um.destroySession(token)
		return nil, nil, errors.New("session expired")
	}
	
	// Get user
	um.usersMu.RLock()
	user, exists := um.users[session.UserID]
	um.usersMu.RUnlock()
	
	if !exists {
		um.destroySession(token)
		return nil, nil, errors.New("user not found")
	}
	
	// Update last activity
	session.LastActivity = time.Now()
	
	return session, user, nil
}

// HasPermission checks if a user has a permission
func (um *UserManager) HasPermission(userID, permission string) bool {
	return um.hasPermission(userID, permission)
}

// CreateAPIKey creates a new API key
func (um *UserManager) CreateAPIKey(userID string, req *CreateAPIKeyRequest) (*APIKey, error) {
	// Check permissions
	if !um.hasPermission(userID, "api_keys.create") {
		return nil, errors.New("permission denied")
	}
	
	// Generate key
	keyBytes := make([]byte, um.config.APIKeyLength)
	if _, err := rand.Read(keyBytes); err != nil {
		return nil, fmt.Errorf("failed to generate key: %w", err)
	}
	key := base64.URLEncoding.EncodeToString(keyBytes)
	
	// Create API key
	apiKey := &APIKey{
		ID:          um.generateID(),
		Key:         key,
		UserID:      userID,
		Name:        req.Name,
		Description: req.Description,
		Permissions: req.Permissions,
		RateLimit:   req.RateLimit,
		IPWhitelist: req.IPWhitelist,
		Active:      true,
		CreatedAt:   time.Now(),
	}
	
	if um.config.APIKeyExpiry > 0 {
		expiry := time.Now().Add(um.config.APIKeyExpiry)
		apiKey.ExpiresAt = &expiry
	}
	
	// Save API key
	um.apiKeysMu.Lock()
	um.apiKeys[apiKey.Key] = apiKey
	um.apiKeysMu.Unlock()
	
	// Audit log
	um.auditLog.Log(&AuditEntry{
		UserID:     userID,
		Action:     "create_api_key",
		Resource:   "api_key",
		ResourceID: apiKey.ID,
		Details: map[string]interface{}{
			"name":        apiKey.Name,
			"permissions": apiKey.Permissions,
		},
		Success: true,
	})
	
	return apiKey, nil
}

// ValidateAPIKey validates an API key
func (um *UserManager) ValidateAPIKey(key string) (*APIKey, *User, error) {
	um.apiKeysMu.RLock()
	apiKey, exists := um.apiKeys[key]
	um.apiKeysMu.RUnlock()
	
	if !exists {
		return nil, nil, errors.New("invalid API key")
	}
	
	// Check if active
	if !apiKey.Active {
		return nil, nil, errors.New("API key is disabled")
	}
	
	// Check expiry
	if apiKey.ExpiresAt != nil && time.Now().After(*apiKey.ExpiresAt) {
		return nil, nil, errors.New("API key expired")
	}
	
	// Get user
	um.usersMu.RLock()
	user, exists := um.users[apiKey.UserID]
	um.usersMu.RUnlock()
	
	if !exists {
		return nil, nil, errors.New("user not found")
	}
	
	// Update usage
	now := time.Now()
	apiKey.LastUsed = &now
	apiKey.UseCount++
	
	return apiKey, user, nil
}

// GetUserStats returns user statistics
func (um *UserManager) GetUserStats() *UserStats {
	um.usersMu.RLock()
	totalUsers := len(um.users)
	activeUsers := 0
	lockedUsers := 0
	
	roleCount := make(map[string]int)
	for _, user := range um.users {
		if user.Active {
			activeUsers++
		}
		if user.Locked {
			lockedUsers++
		}
		for _, role := range user.Roles {
			roleCount[role]++
		}
	}
	um.usersMu.RUnlock()
	
	um.sessionsMu.RLock()
	activeSessions := len(um.sessions)
	um.sessionsMu.RUnlock()
	
	um.apiKeysMu.RLock()
	activeAPIKeys := 0
	for _, key := range um.apiKeys {
		if key.Active {
			activeAPIKeys++
		}
	}
	um.apiKeysMu.RUnlock()
	
	return &UserStats{
		TotalUsers:     totalUsers,
		ActiveUsers:    activeUsers,
		LockedUsers:    lockedUsers,
		ActiveSessions: activeSessions,
		ActiveAPIKeys:  activeAPIKeys,
		RoleDistribution: roleCount,
	}
}

// Internal methods

func (um *UserManager) initializeDefaultRoles() {
	um.rolesMu.Lock()
	defer um.rolesMu.Unlock()
	
	um.roles[RoleAdmin.ID] = RoleAdmin
	um.roles[RoleOperator.ID] = RoleOperator
	um.roles[RoleViewer.ID] = RoleViewer
	
	// Create custom roles
	um.roles["engineer"] = &Role{
		ID:          "engineer",
		Name:        "Engineer",
		Description: "Technical operations and configuration",
		Permissions: []string{
			"mining.*", "hardware.*", "cooling.*",
			"energy.*", "maintenance.*",
		},
		Priority: 60,
		Active:   true,
	}
	
	um.roles["analyst"] = &Role{
		ID:          "analyst",
		Name:        "Analyst",
		Description: "Data analysis and reporting",
		Permissions: []string{
			"*.view", "*.read", "stats.*", "reports.*",
			"analytics.*", "export.*",
		},
		Priority: 30,
		Active:   true,
	}
}

func (um *UserManager) initializeDefaultPermissions() {
	um.permsMu.Lock()
	defer um.permsMu.Unlock()
	
	// Mining permissions
	um.addPermission("mining.start", "mining", "start", "Start mining operations")
	um.addPermission("mining.stop", "mining", "stop", "Stop mining operations")
	um.addPermission("mining.configure", "mining", "configure", "Configure mining settings")
	um.addPermission("mining.view", "mining", "view", "View mining status")
	
	// Hardware permissions
	um.addPermission("hardware.configure", "hardware", "configure", "Configure hardware settings")
	um.addPermission("hardware.monitor", "hardware", "monitor", "Monitor hardware status")
	um.addPermission("hardware.maintain", "hardware", "maintain", "Perform hardware maintenance")
	
	// User permissions
	um.addPermission("users.create", "users", "create", "Create new users")
	um.addPermission("users.modify", "users", "modify", "Modify user accounts")
	um.addPermission("users.delete", "users", "delete", "Delete user accounts")
	um.addPermission("users.view", "users", "view", "View user information")
	
	// API permissions
	um.addPermission("api_keys.create", "api_keys", "create", "Create API keys")
	um.addPermission("api_keys.revoke", "api_keys", "revoke", "Revoke API keys")
	
	// System permissions
	um.addPermission("system.configure", "system", "configure", "Configure system settings")
	um.addPermission("system.shutdown", "system", "shutdown", "Shutdown system")
	um.addPermission("audit.view", "audit", "view", "View audit logs")
}

func (um *UserManager) addPermission(id, resource, action, description string) {
	um.permissions[id] = &Permission{
		ID:          id,
		Name:        id,
		Resource:    resource,
		Action:      action,
		Description: description,
		Scope:       "global",
		CreatedAt:   time.Now(),
		System:      true,
	}
}

func (um *UserManager) createDefaultAdmin() {
	// Check if admin exists
	um.usersMu.RLock()
	for _, user := range um.users {
		for _, role := range user.Roles {
			if role == "admin" {
				um.usersMu.RUnlock()
				return
			}
		}
	}
	um.usersMu.RUnlock()
	
	// Create default admin
	hash, _ := bcrypt.GenerateFromPassword([]byte("admin123"), bcrypt.DefaultCost)
	
	admin := &User{
		ID:           "admin",
		Username:     "admin",
		Email:        "admin@otedama.local",
		PasswordHash: string(hash),
		FullName:     "System Administrator",
		Roles:        []string{"admin"},
		Active:       true,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
		CreatedBy:    "system",
		PasswordChanged: time.Now(),
		Preferences:  make(map[string]interface{}),
		ResourceQuota: &ResourceQuota{
			MaxHashRate:   -1, // Unlimited
			MaxPowerUsage: -1,
			MaxGPUs:       -1,
			MaxCPUThreads: -1,
			MaxStorage:    -1,
			MaxBandwidth:  -1,
		},
	}
	
	um.usersMu.Lock()
	um.users[admin.ID] = admin
	um.usersMu.Unlock()
	
	um.logger.Info("Created default admin user")
}

func (um *UserManager) sessionCleanup() {
	defer um.wg.Done()
	
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-um.ctx.Done():
			return
		case <-ticker.C:
			um.cleanupExpiredSessions()
		}
	}
}

func (um *UserManager) cleanupExpiredSessions() {
	um.sessionsMu.Lock()
	defer um.sessionsMu.Unlock()
	
	now := time.Now()
	expired := make([]string, 0)
	
	for token, session := range um.sessions {
		if now.After(session.ExpiresAt) {
			expired = append(expired, token)
		}
	}
	
	for _, token := range expired {
		delete(um.sessions, token)
		um.activeSessions.Add(^uint64(0)) // Decrement
	}
	
	if len(expired) > 0 {
		um.logger.Debug("Cleaned up expired sessions", zap.Int("count", len(expired)))
	}
}

func (um *UserManager) auditLogRotation() {
	defer um.wg.Done()
	
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	
	for {
		select {
		case <-um.ctx.Done():
			return
		case <-ticker.C:
			um.rotateAuditLog()
		}
	}
}

func (um *UserManager) rotateAuditLog() {
	um.auditLog.entriesMu.Lock()
	defer um.auditLog.entriesMu.Unlock()
	
	if um.config.AuditRetention > 0 {
		cutoff := time.Now().Add(-um.config.AuditRetention)
		newEntries := make([]*AuditEntry, 0)
		
		for _, entry := range um.auditLog.entries {
			if entry.Timestamp.After(cutoff) {
				newEntries = append(newEntries, entry)
			}
		}
		
		um.auditLog.entries = newEntries
	}
}

func (um *UserManager) quotaEnforcement() {
	defer um.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-um.ctx.Done():
			return
		case <-ticker.C:
			um.enforceQuotas()
		}
	}
}

func (um *UserManager) enforceQuotas() {
	// In production, would check actual resource usage
	// and enforce limits
}

func (um *UserManager) hasPermission(userID, permission string) bool {
	um.usersMu.RLock()
	user, exists := um.users[userID]
	um.usersMu.RUnlock()
	
	if !exists {
		return false
	}
	
	// Check direct permissions
	for _, perm := range user.Permissions {
		if perm == permission || perm == "*" {
			return true
		}
		// Check wildcard permissions
		if matchPermission(perm, permission) {
			return true
		}
	}
	
	// Check role permissions
	for _, roleID := range user.Roles {
		um.rolesMu.RLock()
		role, exists := um.roles[roleID]
		um.rolesMu.RUnlock()
		
		if exists {
			for _, perm := range role.Permissions {
				if perm == permission || perm == "*" {
					return true
				}
				if matchPermission(perm, permission) {
					return true
				}
			}
		}
	}
	
	return false
}

func (um *UserManager) getUserPermissions(user *User) []string {
	perms := make(map[string]bool)
	
	// Add direct permissions
	for _, perm := range user.Permissions {
		perms[perm] = true
	}
	
	// Add role permissions
	for _, roleID := range user.Roles {
		um.rolesMu.RLock()
		role, exists := um.roles[roleID]
		um.rolesMu.RUnlock()
		
		if exists {
			for _, perm := range role.Permissions {
				perms[perm] = true
			}
		}
	}
	
	// Convert to slice
	result := make([]string, 0, len(perms))
	for perm := range perms {
		result = append(result, perm)
	}
	
	return result
}

func (um *UserManager) getActiveSessionCount(userID string) int {
	um.sessionsMu.RLock()
	defer um.sessionsMu.RUnlock()
	
	count := 0
	for _, session := range um.sessions {
		if session.UserID == userID {
			count++
		}
	}
	
	return count
}

func (um *UserManager) destroySession(token string) {
	um.sessionsMu.Lock()
	delete(um.sessions, token)
	um.sessionsMu.Unlock()
	
	um.activeSessions.Add(^uint64(0)) // Decrement
}

func (um *UserManager) validateUserRequest(req *CreateUserRequest) error {
	if req.Username == "" {
		return errors.New("username is required")
	}
	
	if req.Email == "" {
		return errors.New("email is required")
	}
	
	if len(req.Password) < um.config.MinPasswordLength {
		return fmt.Errorf("password must be at least %d characters", um.config.MinPasswordLength)
	}
	
	// Check if username exists
	um.usersMu.RLock()
	for _, user := range um.users {
		if user.Username == req.Username {
			um.usersMu.RUnlock()
			return errors.New("username already exists")
		}
		if user.Email == req.Email {
			um.usersMu.RUnlock()
			return errors.New("email already exists")
		}
	}
	um.usersMu.RUnlock()
	
	return nil
}

func (um *UserManager) getDefaultQuota() *ResourceQuota {
	return &ResourceQuota{
		MaxHashRate:   100.0,
		MaxPowerUsage: 1000.0,
		MaxGPUs:       2,
		MaxCPUThreads: 8,
		MaxStorage:    10 * 1024 * 1024 * 1024, // 10GB
		MaxBandwidth:  100 * 1024 * 1024,       // 100MB/s
	}
}

func (um *UserManager) generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (um *UserManager) generateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)
}

func (um *UserManager) saveAuditLog() {
	// In production, would save to persistent storage
}

// Helper functions

func matchPermission(pattern, permission string) bool {
	// Simple wildcard matching
	if pattern == "*" {
		return true
	}
	
	// Resource wildcard (e.g., "mining.*")
	if len(pattern) > 2 && pattern[len(pattern)-2:] == ".*" {
		prefix := pattern[:len(pattern)-2]
		return len(permission) >= len(prefix) && permission[:len(prefix)] == prefix
	}
	
	// Action wildcard (e.g., "*.view")
	if len(pattern) > 2 && pattern[:2] == "*." {
		suffix := pattern[2:]
		return len(permission) >= len(suffix) && permission[len(permission)-len(suffix):] == suffix
	}
	
	return pattern == permission
}

// Request/Response types

type CreateUserRequest struct {
	Username      string
	Email         string
	Password      string
	FullName      string
	Organization  string
	Department    string
	Roles         []string
	ResourceQuota *ResourceQuota
}

type CreateAPIKeyRequest struct {
	Name        string
	Description string
	Permissions []string
	RateLimit   int
	IPWhitelist []string
}

type UserStats struct {
	TotalUsers       int
	ActiveUsers      int
	LockedUsers      int
	ActiveSessions   int
	ActiveAPIKeys    int
	RoleDistribution map[string]int
}

// AuditLogger methods

func (al *AuditLogger) Log(entry *AuditEntry) {
	al.entriesMu.Lock()
	defer al.entriesMu.Unlock()
	
	entry.ID = fmt.Sprintf("audit_%d", time.Now().UnixNano())
	entry.Timestamp = time.Now()
	
	al.entries = append(al.entries, entry)
	
	// Maintain max size
	if len(al.entries) > al.maxEntries {
		al.entries = al.entries[len(al.entries)-al.maxEntries:]
	}
}

func (al *AuditLogger) GetEntries(limit int, filter *AuditFilter) []*AuditEntry {
	al.entriesMu.RLock()
	defer al.entriesMu.RUnlock()
	
	result := make([]*AuditEntry, 0, limit)
	
	for i := len(al.entries) - 1; i >= 0 && len(result) < limit; i-- {
		entry := al.entries[i]
		
		if filter != nil {
			if filter.UserID != "" && entry.UserID != filter.UserID {
				continue
			}
			if filter.Action != "" && entry.Action != filter.Action {
				continue
			}
			if filter.Resource != "" && entry.Resource != filter.Resource {
				continue
			}
			if filter.Success != nil && entry.Success != *filter.Success {
				continue
			}
			if !filter.StartTime.IsZero() && entry.Timestamp.Before(filter.StartTime) {
				continue
			}
			if !filter.EndTime.IsZero() && entry.Timestamp.After(filter.EndTime) {
				continue
			}
		}
		
		result = append(result, entry)
	}
	
	return result
}

type AuditFilter struct {
	UserID    string
	Action    string
	Resource  string
	Success   *bool
	StartTime time.Time
	EndTime   time.Time
}