package auth

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"
)

// RBAC provides Role-Based Access Control
type RBAC struct {
	logger *zap.Logger
	
	// Storage
	roles       map[string]*Role
	permissions map[string]*Permission
	users       map[string]*User
	
	// Mutex for thread safety
	mu          sync.RWMutex
	
	// Configuration
	config      RBACConfig
	
	// Cache
	cache       *PermissionCache
}

// RBACConfig defines RBAC configuration
type RBACConfig struct {
	// Cache settings
	EnableCache      bool          `json:"enable_cache"`
	CacheTTL         time.Duration `json:"cache_ttl"`
	CacheMaxSize     int           `json:"cache_max_size"`
	
	// Security settings
	RequireMFA       []string      `json:"require_mfa"`
	SessionTimeout   time.Duration `json:"session_timeout"`
	
	// Audit settings
	EnableAudit      bool          `json:"enable_audit"`
	AuditLogPath     string        `json:"audit_log_path"`
}

// Role represents a user role
type Role struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Permissions []string               `json:"permissions"`
	ParentRoles []string               `json:"parent_roles"`
	Metadata    map[string]interface{} `json:"metadata"`
	CreatedAt   time.Time              `json:"created_at"`
	UpdatedAt   time.Time              `json:"updated_at"`
	Active      bool                   `json:"active"`
}

// Permission represents an access permission
type Permission struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Resource    string                 `json:"resource"`
	Action      string                 `json:"action"`
	Description string                 `json:"description"`
	Conditions  []Condition            `json:"conditions"`
	Metadata    map[string]interface{} `json:"metadata"`
	CreatedAt   time.Time              `json:"created_at"`
	Active      bool                   `json:"active"`
}

// User represents a system user
type User struct {
	ID             string                 `json:"id"`
	Username       string                 `json:"username"`
	Email          string                 `json:"email"`
	Roles          []string               `json:"roles"`
	DirectPerms    []string               `json:"direct_permissions"`
	Attributes     map[string]interface{} `json:"attributes"`
	MFAEnabled     bool                   `json:"mfa_enabled"`
	LastLogin      time.Time              `json:"last_login"`
	CreatedAt      time.Time              `json:"created_at"`
	UpdatedAt      time.Time              `json:"updated_at"`
	Active         bool                   `json:"active"`
	PasswordHash   string                 `json:"-"`
}

// Condition represents a permission condition
type Condition struct {
	Type       string                 `json:"type"`
	Field      string                 `json:"field"`
	Operator   string                 `json:"operator"`
	Value      interface{}            `json:"value"`
	Parameters map[string]interface{} `json:"parameters"`
}

// Session represents a user session
type Session struct {
	ID          string
	UserID      string
	Roles       []string
	Permissions []string
	IPAddress   string
	UserAgent   string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	MFAVerified bool
}

// AccessRequest represents an access check request
type AccessRequest struct {
	UserID     string
	Resource   string
	Action     string
	Context    map[string]interface{}
}

// AccessResponse represents an access check response
type AccessResponse struct {
	Allowed    bool
	Reason     string
	RequireMFA bool
}

// NewRBAC creates a new RBAC system
func NewRBAC(logger *zap.Logger, config RBACConfig) *RBAC {
	// Set defaults
	if config.CacheTTL == 0 {
		config.CacheTTL = 5 * time.Minute
	}
	if config.CacheMaxSize == 0 {
		config.CacheMaxSize = 10000
	}
	if config.SessionTimeout == 0 {
		config.SessionTimeout = 24 * time.Hour
	}
	
	rbac := &RBAC{
		logger:      logger,
		roles:       make(map[string]*Role),
		permissions: make(map[string]*Permission),
		users:       make(map[string]*User),
		config:      config,
	}
	
	// Initialize cache if enabled
	if config.EnableCache {
		rbac.cache = NewPermissionCache(config.CacheTTL, config.CacheMaxSize)
	}
	
	// Initialize default roles and permissions
	rbac.initializeDefaults()
	
	return rbac
}

// initializeDefaults sets up default roles and permissions
func (r *RBAC) initializeDefaults() {
	// System permissions
	systemPermissions := []Permission{
		{
			ID:       "system.admin",
			Name:     "System Administration",
			Resource: "system",
			Action:   "*",
			Active:   true,
		},
		{
			ID:       "user.create",
			Name:     "Create User",
			Resource: "user",
			Action:   "create",
			Active:   true,
		},
		{
			ID:       "user.read",
			Name:     "Read User",
			Resource: "user",
			Action:   "read",
			Active:   true,
		},
		{
			ID:       "user.update",
			Name:     "Update User",
			Resource: "user",
			Action:   "update",
			Active:   true,
		},
		{
			ID:       "user.delete",
			Name:     "Delete User",
			Resource: "user",
			Action:   "delete",
			Active:   true,
		},
		{
			ID:       "mining.start",
			Name:     "Start Mining",
			Resource: "mining",
			Action:   "start",
			Active:   true,
		},
		{
			ID:       "mining.stop",
			Name:     "Stop Mining",
			Resource: "mining",
			Action:   "stop",
			Active:   true,
		},
		{
			ID:       "mining.stats",
			Name:     "View Mining Stats",
			Resource: "mining",
			Action:   "read",
			Active:   true,
		},
		{
			ID:       "wallet.create",
			Name:     "Create Wallet",
			Resource: "wallet",
			Action:   "create",
			Active:   true,
		},
		{
			ID:       "wallet.view",
			Name:     "View Wallet",
			Resource: "wallet",
			Action:   "read",
			Active:   true,
		},
		{
			ID:       "wallet.transfer",
			Name:     "Transfer Funds",
			Resource: "wallet",
			Action:   "transfer",
			Active:   true,
		},
		{
			ID:       "pool.manage",
			Name:     "Manage Pool",
			Resource: "pool",
			Action:   "manage",
			Active:   true,
		},
	}
	
	for _, perm := range systemPermissions {
		perm.CreatedAt = time.Now()
		r.permissions[perm.ID] = &perm
	}
	
	// Default roles
	defaultRoles := []Role{
		{
			ID:          "admin",
			Name:        "Administrator",
			Description: "Full system access",
			Permissions: []string{"system.admin"},
			Active:      true,
		},
		{
			ID:          "operator",
			Name:        "Operator",
			Description: "Pool operation management",
			Permissions: []string{
				"user.read", "user.update",
				"mining.start", "mining.stop", "mining.stats",
				"pool.manage",
			},
			Active: true,
		},
		{
			ID:          "miner",
			Name:        "Miner",
			Description: "Basic mining access",
			Permissions: []string{
				"mining.start", "mining.stop", "mining.stats",
				"wallet.view",
			},
			Active: true,
		},
		{
			ID:          "viewer",
			Name:        "Viewer",
			Description: "Read-only access",
			Permissions: []string{
				"mining.stats", "wallet.view",
			},
			Active: true,
		},
	}
	
	for _, role := range defaultRoles {
		role.CreatedAt = time.Now()
		role.UpdatedAt = time.Now()
		r.roles[role.ID] = &role
	}
}

// CreateRole creates a new role
func (r *RBAC) CreateRole(role *Role) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	if _, exists := r.roles[role.ID]; exists {
		return fmt.Errorf("role %s already exists", role.ID)
	}
	
	// Validate permissions
	for _, permID := range role.Permissions {
		if _, exists := r.permissions[permID]; !exists {
			return fmt.Errorf("permission %s does not exist", permID)
		}
	}
	
	// Validate parent roles
	for _, parentID := range role.ParentRoles {
		if _, exists := r.roles[parentID]; !exists {
			return fmt.Errorf("parent role %s does not exist", parentID)
		}
	}
	
	role.CreatedAt = time.Now()
	role.UpdatedAt = time.Now()
	r.roles[role.ID] = role
	
	r.logger.Info("Role created",
		zap.String("role_id", role.ID),
		zap.String("name", role.Name),
	)
	
	return nil
}

// CreatePermission creates a new permission
func (r *RBAC) CreatePermission(perm *Permission) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	if _, exists := r.permissions[perm.ID]; exists {
		return fmt.Errorf("permission %s already exists", perm.ID)
	}
	
	perm.CreatedAt = time.Now()
	r.permissions[perm.ID] = perm
	
	// Clear cache
	if r.cache != nil {
		r.cache.Clear()
	}
	
	r.logger.Info("Permission created",
		zap.String("permission_id", perm.ID),
		zap.String("resource", perm.Resource),
		zap.String("action", perm.Action),
	)
	
	return nil
}

// CreateUser creates a new user
func (r *RBAC) CreateUser(user *User) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	if _, exists := r.users[user.ID]; exists {
		return fmt.Errorf("user %s already exists", user.ID)
	}
	
	// Validate roles
	for _, roleID := range user.Roles {
		if _, exists := r.roles[roleID]; !exists {
			return fmt.Errorf("role %s does not exist", roleID)
		}
	}
	
	user.CreatedAt = time.Now()
	user.UpdatedAt = time.Now()
	r.users[user.ID] = user
	
	r.logger.Info("User created",
		zap.String("user_id", user.ID),
		zap.String("username", user.Username),
		zap.Strings("roles", user.Roles),
	)
	
	return nil
}

// AssignRole assigns a role to a user
func (r *RBAC) AssignRole(userID, roleID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	user, exists := r.users[userID]
	if !exists {
		return fmt.Errorf("user %s not found", userID)
	}
	
	if _, exists := r.roles[roleID]; !exists {
		return fmt.Errorf("role %s not found", roleID)
	}
	
	// Check if already assigned
	for _, existingRole := range user.Roles {
		if existingRole == roleID {
			return nil
		}
	}
	
	user.Roles = append(user.Roles, roleID)
	user.UpdatedAt = time.Now()
	
	// Clear cache for user
	if r.cache != nil {
		r.cache.RemoveUser(userID)
	}
	
	r.logger.Info("Role assigned to user",
		zap.String("user_id", userID),
		zap.String("role_id", roleID),
	)
	
	return nil
}

// RemoveRole removes a role from a user
func (r *RBAC) RemoveRole(userID, roleID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	
	user, exists := r.users[userID]
	if !exists {
		return fmt.Errorf("user %s not found", userID)
	}
	
	// Remove role
	var newRoles []string
	for _, role := range user.Roles {
		if role != roleID {
			newRoles = append(newRoles, role)
		}
	}
	
	user.Roles = newRoles
	user.UpdatedAt = time.Now()
	
	// Clear cache for user
	if r.cache != nil {
		r.cache.RemoveUser(userID)
	}
	
	r.logger.Info("Role removed from user",
		zap.String("user_id", userID),
		zap.String("role_id", roleID),
	)
	
	return nil
}

// CheckAccess checks if a user has access to perform an action
func (r *RBAC) CheckAccess(ctx context.Context, req AccessRequest) AccessResponse {
	// Check cache first
	if r.cache != nil {
		if allowed, found := r.cache.Get(req.UserID, req.Resource, req.Action); found {
			return AccessResponse{
				Allowed: allowed,
				Reason:  "cached result",
			}
		}
	}
	
	r.mu.RLock()
	user, exists := r.users[req.UserID]
	r.mu.RUnlock()
	
	if !exists || !user.Active {
		return AccessResponse{
			Allowed: false,
			Reason:  "user not found or inactive",
		}
	}
	
	// Collect all permissions
	permissions := r.getUserPermissions(user)
	
	// Check permissions
	allowed := false
	requireMFA := false
	
	for _, permID := range permissions {
		r.mu.RLock()
		perm, exists := r.permissions[permID]
		r.mu.RUnlock()
		
		if !exists || !perm.Active {
			continue
		}
		
		// Check resource and action match
		if r.matchesPermission(perm, req.Resource, req.Action) {
			// Check conditions
			if r.checkConditions(perm.Conditions, req.Context) {
				allowed = true
				
				// Check if MFA required
				for _, mfaResource := range r.config.RequireMFA {
					if mfaResource == req.Resource || mfaResource == "*" {
						requireMFA = true
						break
					}
				}
				
				break
			}
		}
	}
	
	// Cache result
	if r.cache != nil && !requireMFA {
		r.cache.Set(req.UserID, req.Resource, req.Action, allowed)
	}
	
	// Audit log
	if r.config.EnableAudit {
		r.logAccessAttempt(req, allowed)
	}
	
	return AccessResponse{
		Allowed:    allowed,
		RequireMFA: requireMFA,
		Reason:     r.getAccessReason(allowed, requireMFA),
	}
}

// getUserPermissions collects all permissions for a user
func (r *RBAC) getUserPermissions(user *User) []string {
	permSet := make(map[string]bool)
	
	// Direct permissions
	for _, perm := range user.DirectPerms {
		permSet[perm] = true
	}
	
	// Role permissions
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	processedRoles := make(map[string]bool)
	var rolesToProcess []string
	rolesToProcess = append(rolesToProcess, user.Roles...)
	
	for len(rolesToProcess) > 0 {
		roleID := rolesToProcess[0]
		rolesToProcess = rolesToProcess[1:]
		
		if processedRoles[roleID] {
			continue
		}
		processedRoles[roleID] = true
		
		role, exists := r.roles[roleID]
		if !exists || !role.Active {
			continue
		}
		
		// Add role permissions
		for _, perm := range role.Permissions {
			permSet[perm] = true
		}
		
		// Add parent roles
		rolesToProcess = append(rolesToProcess, role.ParentRoles...)
	}
	
	// Convert to slice
	var permissions []string
	for perm := range permSet {
		permissions = append(permissions, perm)
	}
	
	return permissions
}

// matchesPermission checks if permission matches request
func (r *RBAC) matchesPermission(perm *Permission, resource, action string) bool {
	// Wildcard matching
	if perm.Resource == "*" || perm.Resource == resource {
		if perm.Action == "*" || perm.Action == action {
			return true
		}
	}
	
	// Hierarchical matching (e.g., "user.*" matches "user.profile")
	if strings.HasSuffix(perm.Resource, ".*") {
		prefix := strings.TrimSuffix(perm.Resource, ".*")
		if strings.HasPrefix(resource, prefix+".") {
			if perm.Action == "*" || perm.Action == action {
				return true
			}
		}
	}
	
	return false
}

// checkConditions evaluates permission conditions
func (r *RBAC) checkConditions(conditions []Condition, context map[string]interface{}) bool {
	for _, cond := range conditions {
		if !r.evaluateCondition(cond, context) {
			return false
		}
	}
	return true
}

// evaluateCondition evaluates a single condition
func (r *RBAC) evaluateCondition(cond Condition, context map[string]interface{}) bool {
	value, exists := context[cond.Field]
	if !exists {
		return false
	}
	
	switch cond.Type {
	case "equals":
		return fmt.Sprintf("%v", value) == fmt.Sprintf("%v", cond.Value)
		
	case "not_equals":
		return fmt.Sprintf("%v", value) != fmt.Sprintf("%v", cond.Value)
		
	case "contains":
		return strings.Contains(fmt.Sprintf("%v", value), fmt.Sprintf("%v", cond.Value))
		
	case "in":
		if list, ok := cond.Value.([]interface{}); ok {
			for _, item := range list {
				if fmt.Sprintf("%v", value) == fmt.Sprintf("%v", item) {
					return true
				}
			}
		}
		return false
		
	case "time_range":
		// Check if current time is within range
		if cond.Parameters != nil {
			startStr, _ := cond.Parameters["start"].(string)
			endStr, _ := cond.Parameters["end"].(string)
			start, _ := time.Parse(time.RFC3339, startStr)
			end, _ := time.Parse(time.RFC3339, endStr)
			now := time.Now()
			return now.After(start) && now.Before(end)
		}
		return false
		
	case "ip_range":
		// Check if IP is in allowed range
		// Implementation would check IP ranges
		return true
		
	default:
		return false
	}
}

// GetUser retrieves a user
func (r *RBAC) GetUser(userID string) (*User, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	user, exists := r.users[userID]
	if !exists {
		return nil, fmt.Errorf("user %s not found", userID)
	}
	
	// Return copy to prevent modification
	userCopy := *user
	return &userCopy, nil
}

// GetRole retrieves a role
func (r *RBAC) GetRole(roleID string) (*Role, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	role, exists := r.roles[roleID]
	if !exists {
		return nil, fmt.Errorf("role %s not found", roleID)
	}
	
	roleCopy := *role
	return &roleCopy, nil
}

// ListUsers lists all users
func (r *RBAC) ListUsers() []*User {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	users := make([]*User, 0, len(r.users))
	for _, user := range r.users {
		userCopy := *user
		users = append(users, &userCopy)
	}
	
	return users
}

// ListRoles lists all roles
func (r *RBAC) ListRoles() []*Role {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	roles := make([]*Role, 0, len(r.roles))
	for _, role := range r.roles {
		roleCopy := *role
		roles = append(roles, &roleCopy)
	}
	
	return roles
}

// Helper methods

func (r *RBAC) getAccessReason(allowed, requireMFA bool) string {
	if allowed && requireMFA {
		return "access allowed but MFA required"
	}
	if allowed {
		return "access allowed"
	}
	return "access denied"
}

func (r *RBAC) logAccessAttempt(req AccessRequest, allowed bool) {
	r.logger.Info("Access attempt",
		zap.String("user_id", req.UserID),
		zap.String("resource", req.Resource),
		zap.String("action", req.Action),
		zap.Bool("allowed", allowed),
		zap.Any("context", req.Context),
	)
}

// PermissionCache provides caching for permission checks
type PermissionCache struct {
	cache     map[string]cacheEntry
	mu        sync.RWMutex
	ttl       time.Duration
	maxSize   int
}

type cacheEntry struct {
	allowed   bool
	timestamp time.Time
}

func NewPermissionCache(ttl time.Duration, maxSize int) *PermissionCache {
	pc := &PermissionCache{
		cache:   make(map[string]cacheEntry),
		ttl:     ttl,
		maxSize: maxSize,
	}
	
	// Start cleanup routine
	go pc.cleanup()
	
	return pc
}

func (pc *PermissionCache) Get(userID, resource, action string) (bool, bool) {
	key := fmt.Sprintf("%s:%s:%s", userID, resource, action)
	
	pc.mu.RLock()
	defer pc.mu.RUnlock()
	
	entry, exists := pc.cache[key]
	if !exists {
		return false, false
	}
	
	if time.Since(entry.timestamp) > pc.ttl {
		return false, false
	}
	
	return entry.allowed, true
}

func (pc *PermissionCache) Set(userID, resource, action string, allowed bool) {
	key := fmt.Sprintf("%s:%s:%s", userID, resource, action)
	
	pc.mu.Lock()
	defer pc.mu.Unlock()
	
	// Check size limit
	if len(pc.cache) >= pc.maxSize {
		// Remove oldest entry
		var oldestKey string
		var oldestTime time.Time
		for k, v := range pc.cache {
			if oldestTime.IsZero() || v.timestamp.Before(oldestTime) {
				oldestKey = k
				oldestTime = v.timestamp
			}
		}
		delete(pc.cache, oldestKey)
	}
	
	pc.cache[key] = cacheEntry{
		allowed:   allowed,
		timestamp: time.Now(),
	}
}

func (pc *PermissionCache) RemoveUser(userID string) {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	
	prefix := userID + ":"
	for key := range pc.cache {
		if strings.HasPrefix(key, prefix) {
			delete(pc.cache, key)
		}
	}
}

func (pc *PermissionCache) Clear() {
	pc.mu.Lock()
	defer pc.mu.Unlock()
	
	pc.cache = make(map[string]cacheEntry)
}

func (pc *PermissionCache) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	
	for range ticker.C {
		pc.mu.Lock()
		now := time.Now()
		for key, entry := range pc.cache {
			if now.Sub(entry.timestamp) > pc.ttl {
				delete(pc.cache, key)
			}
		}
		pc.mu.Unlock()
	}
}