package auth

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap/zaptest"
)

func TestRBAC_CreateRole(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{})
	
	// Create permission first
	perm := &Permission{
		ID:       "test.read",
		Name:     "Test Read",
		Resource: "test",
		Action:   "read",
		Active:   true,
	}
	err := rbac.CreatePermission(perm)
	require.NoError(t, err)
	
	// Create role
	role := &Role{
		ID:          "test_role",
		Name:        "Test Role",
		Description: "Test role description",
		Permissions: []string{"test.read"},
		Active:      true,
	}
	
	err = rbac.CreateRole(role)
	assert.NoError(t, err)
	
	// Try to create duplicate
	err = rbac.CreateRole(role)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
	
	// Try to create role with non-existent permission
	invalidRole := &Role{
		ID:          "invalid_role",
		Name:        "Invalid Role",
		Permissions: []string{"non.existent"},
		Active:      true,
	}
	err = rbac.CreateRole(invalidRole)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "does not exist")
}

func TestRBAC_CreateUser(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{})
	
	// Create user
	user := &User{
		ID:       "test_user",
		Username: "testuser",
		Email:    "test@example.com",
		Roles:    []string{"viewer"}, // Default role
		Active:   true,
	}
	
	err := rbac.CreateUser(user)
	assert.NoError(t, err)
	
	// Try to create duplicate
	err = rbac.CreateUser(user)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
	
	// Try to create user with non-existent role
	invalidUser := &User{
		ID:       "invalid_user",
		Username: "invaliduser",
		Roles:    []string{"non_existent_role"},
		Active:   true,
	}
	err = rbac.CreateUser(invalidUser)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "does not exist")
}

func TestRBAC_CheckAccess(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{EnableCache: true})
	
	// Create test user with miner role
	user := &User{
		ID:       "test_miner",
		Username: "miner1",
		Roles:    []string{"miner"},
		Active:   true,
	}
	err := rbac.CreateUser(user)
	require.NoError(t, err)
	
	// Test access checks
	tests := []struct {
		name     string
		request  AccessRequest
		expected bool
	}{
		{
			name: "Miner can start mining",
			request: AccessRequest{
				UserID:   "test_miner",
				Resource: "mining",
				Action:   "start",
			},
			expected: true,
		},
		{
			name: "Miner can view stats",
			request: AccessRequest{
				UserID:   "test_miner",
				Resource: "mining",
				Action:   "read",
			},
			expected: true,
		},
		{
			name: "Miner cannot manage pool",
			request: AccessRequest{
				UserID:   "test_miner",
				Resource: "pool",
				Action:   "manage",
			},
			expected: false,
		},
		{
			name: "Miner cannot create users",
			request: AccessRequest{
				UserID:   "test_miner",
				Resource: "user",
				Action:   "create",
			},
			expected: false,
		},
		{
			name: "Non-existent user denied",
			request: AccessRequest{
				UserID:   "non_existent",
				Resource: "mining",
				Action:   "start",
			},
			expected: false,
		},
	}
	
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := rbac.CheckAccess(context.Background(), tt.request)
			assert.Equal(t, tt.expected, response.Allowed)
		})
	}
	
	// Test cache hit
	// Make same request twice
	req := AccessRequest{
		UserID:   "test_miner",
		Resource: "mining",
		Action:   "start",
	}
	
	response1 := rbac.CheckAccess(context.Background(), req)
	response2 := rbac.CheckAccess(context.Background(), req)
	
	assert.Equal(t, response1.Allowed, response2.Allowed)
	assert.Contains(t, response2.Reason, "cached")
}

func TestRBAC_RoleHierarchy(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{})
	
	// Create parent role
	parentRole := &Role{
		ID:          "parent_role",
		Name:        "Parent Role",
		Permissions: []string{"user.read"},
		Active:      true,
	}
	err := rbac.CreateRole(parentRole)
	require.NoError(t, err)
	
	// Create child role that inherits from parent
	childRole := &Role{
		ID:          "child_role",
		Name:        "Child Role",
		Permissions: []string{"user.update"},
		ParentRoles: []string{"parent_role"},
		Active:      true,
	}
	err = rbac.CreateRole(childRole)
	require.NoError(t, err)
	
	// Create user with child role
	user := &User{
		ID:       "test_hierarchy",
		Username: "hierarchy_user",
		Roles:    []string{"child_role"},
		Active:   true,
	}
	err = rbac.CreateUser(user)
	require.NoError(t, err)
	
	// Check that user has both permissions
	// Direct permission from child role
	response := rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "test_hierarchy",
		Resource: "user",
		Action:   "update",
	})
	assert.True(t, response.Allowed)
	
	// Inherited permission from parent role
	response = rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "test_hierarchy",
		Resource: "user",
		Action:   "read",
	})
	assert.True(t, response.Allowed)
}

func TestRBAC_DirectPermissions(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{})
	
	// Create custom permission
	perm := &Permission{
		ID:       "special.action",
		Name:     "Special Action",
		Resource: "special",
		Action:   "action",
		Active:   true,
	}
	err := rbac.CreatePermission(perm)
	require.NoError(t, err)
	
	// Create user with direct permission
	user := &User{
		ID:          "special_user",
		Username:    "specialuser",
		Roles:       []string{"viewer"}, // Basic role
		DirectPerms: []string{"special.action"},
		Active:      true,
	}
	err = rbac.CreateUser(user)
	require.NoError(t, err)
	
	// Check direct permission
	response := rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "special_user",
		Resource: "special",
		Action:   "action",
	})
	assert.True(t, response.Allowed)
}

func TestRBAC_Conditions(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{})
	
	// Create permission with conditions
	perm := &Permission{
		ID:       "conditional.access",
		Name:     "Conditional Access",
		Resource: "conditional",
		Action:   "access",
		Conditions: []Condition{
			{
				Type:     "equals",
				Field:    "department",
				Operator: "==",
				Value:    "engineering",
			},
		},
		Active: true,
	}
	err := rbac.CreatePermission(perm)
	require.NoError(t, err)
	
	// Create role with conditional permission
	role := &Role{
		ID:          "conditional_role",
		Name:        "Conditional Role",
		Permissions: []string{"conditional.access"},
		Active:      true,
	}
	err = rbac.CreateRole(role)
	require.NoError(t, err)
	
	// Create user with conditional role
	user := &User{
		ID:       "conditional_user",
		Username: "conditionaluser",
		Roles:    []string{"conditional_role"},
		Active:   true,
	}
	err = rbac.CreateUser(user)
	require.NoError(t, err)
	
	// Test with matching condition
	response := rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "conditional_user",
		Resource: "conditional",
		Action:   "access",
		Context: map[string]interface{}{
			"department": "engineering",
		},
	})
	assert.True(t, response.Allowed)
	
	// Test with non-matching condition
	response = rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "conditional_user",
		Resource: "conditional",
		Action:   "access",
		Context: map[string]interface{}{
			"department": "marketing",
		},
	})
	assert.False(t, response.Allowed)
	
	// Test with missing context
	response = rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "conditional_user",
		Resource: "conditional",
		Action:   "access",
		Context:  map[string]interface{}{},
	})
	assert.False(t, response.Allowed)
}

func TestRBAC_WildcardPermissions(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{})
	
	// Admin has wildcard permission
	adminUser := &User{
		ID:       "admin_user",
		Username: "admin",
		Roles:    []string{"admin"},
		Active:   true,
	}
	err := rbac.CreateUser(adminUser)
	require.NoError(t, err)
	
	// Test wildcard access
	resources := []string{"user", "mining", "wallet", "pool", "system"}
	actions := []string{"create", "read", "update", "delete", "manage"}
	
	for _, resource := range resources {
		for _, action := range actions {
			response := rbac.CheckAccess(context.Background(), AccessRequest{
				UserID:   "admin_user",
				Resource: resource,
				Action:   action,
			})
			assert.True(t, response.Allowed, "Admin should have access to %s:%s", resource, action)
		}
	}
}

func TestRBAC_AssignRemoveRole(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{})
	
	// Create user with viewer role
	user := &User{
		ID:       "dynamic_user",
		Username: "dynamicuser",
		Roles:    []string{"viewer"},
		Active:   true,
	}
	err := rbac.CreateUser(user)
	require.NoError(t, err)
	
	// Initially cannot start mining
	response := rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "dynamic_user",
		Resource: "mining",
		Action:   "start",
	})
	assert.False(t, response.Allowed)
	
	// Assign miner role
	err = rbac.AssignRole("dynamic_user", "miner")
	assert.NoError(t, err)
	
	// Now can start mining
	response = rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "dynamic_user",
		Resource: "mining",
		Action:   "start",
	})
	assert.True(t, response.Allowed)
	
	// Remove miner role
	err = rbac.RemoveRole("dynamic_user", "miner")
	assert.NoError(t, err)
	
	// Cannot start mining again
	response = rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "dynamic_user",
		Resource: "mining",
		Action:   "start",
	})
	assert.False(t, response.Allowed)
}

func TestRBAC_InactiveEntities(t *testing.T) {
	logger := zaptest.NewLogger(t)
	rbac := NewRBAC(logger, RBACConfig{})
	
	// Create inactive user
	user := &User{
		ID:       "inactive_user",
		Username: "inactiveuser",
		Roles:    []string{"miner"},
		Active:   false,
	}
	err := rbac.CreateUser(user)
	require.NoError(t, err)
	
	// Inactive user should be denied
	response := rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "inactive_user",
		Resource: "mining",
		Action:   "start",
	})
	assert.False(t, response.Allowed)
	assert.Contains(t, response.Reason, "inactive")
	
	// Create inactive permission
	perm := &Permission{
		ID:       "inactive.permission",
		Name:     "Inactive Permission",
		Resource: "inactive",
		Action:   "test",
		Active:   false,
	}
	err = rbac.CreatePermission(perm)
	require.NoError(t, err)
	
	// Create role with inactive permission
	role := &Role{
		ID:          "test_inactive_perm",
		Name:        "Test Inactive Permission",
		Permissions: []string{"inactive.permission"},
		Active:      true,
	}
	err = rbac.CreateRole(role)
	require.NoError(t, err)
	
	// Create active user with role
	activeUser := &User{
		ID:       "active_user_inactive_perm",
		Username: "activeuser",
		Roles:    []string{"test_inactive_perm"},
		Active:   true,
	}
	err = rbac.CreateUser(activeUser)
	require.NoError(t, err)
	
	// Should not have access due to inactive permission
	response = rbac.CheckAccess(context.Background(), AccessRequest{
		UserID:   "active_user_inactive_perm",
		Resource: "inactive",
		Action:   "test",
	})
	assert.False(t, response.Allowed)
}

func TestPermissionCache(t *testing.T) {
	cache := NewPermissionCache(100*time.Millisecond, 10)
	
	// Test set and get
	cache.Set("user1", "resource1", "action1", true)
	allowed, found := cache.Get("user1", "resource1", "action1")
	assert.True(t, found)
	assert.True(t, allowed)
	
	// Test cache miss
	_, found = cache.Get("user2", "resource1", "action1")
	assert.False(t, found)
	
	// Test TTL expiration
	time.Sleep(150 * time.Millisecond)
	_, found = cache.Get("user1", "resource1", "action1")
	assert.False(t, found)
	
	// Test remove user
	cache.Set("user3", "resource1", "action1", true)
	cache.Set("user3", "resource2", "action2", false)
	cache.RemoveUser("user3")
	
	_, found = cache.Get("user3", "resource1", "action1")
	assert.False(t, found)
	_, found = cache.Get("user3", "resource2", "action2")
	assert.False(t, found)
	
	// Test clear
	cache.Set("user4", "resource1", "action1", true)
	cache.Clear()
	_, found = cache.Get("user4", "resource1", "action1")
	assert.False(t, found)
}