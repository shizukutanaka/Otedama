package common

import (
    "context"
    "fmt"
    "sync"
    "time"
    
    "go.uber.org/zap"
)

// ManagerType defines the type of manager
type ManagerType string

const (
    ManagerTypeConnection ManagerType = "connection"
    ManagerTypePeer       ManagerType = "peer"
    ManagerTypeUser       ManagerType = "user"
    ManagerTypeMemory     ManagerType = "memory"
    ManagerTypeLogging    ManagerType = "logging"
    ManagerTypeSecurity   ManagerType = "security"
)

// UnifiedManager provides a base manager implementation
type UnifiedManager struct {
    Type   ManagerType
    Name   string
    Logger *zap.Logger
    Stats  *UnifiedStats
    
    items     map[string]interface{}
    maxItems  int
    
    ctx       context.Context
    cancel    context.CancelFunc
    wg        sync.WaitGroup
    mu        sync.RWMutex
}

// ManagerConfig contains manager configuration
type ManagerConfig struct {
    Type     ManagerType
    Name     string
    MaxItems int
}

// NewUnifiedManager creates a new manager instance
func NewUnifiedManager(config *ManagerConfig, logger *zap.Logger) *UnifiedManager {
    ctx, cancel := context.WithCancel(context.Background())
    
    return &UnifiedManager{
        Type:     config.Type,
        Name:     config.Name,
        Logger:   logger,
        Stats:    NewUnifiedStats(config.Name),
        items:    make(map[string]interface{}),
        maxItems: config.MaxItems,
        ctx:      ctx,
        cancel:   cancel,
    }
}

// Start starts the manager
func (m *UnifiedManager) Start() error {
    m.Logger.Info("Starting manager",
        zap.String("type", string(m.Type)),
        zap.String("name", m.Name),
    )
    
    // Start cleanup routine
    m.wg.Add(1)
    go m.cleanupRoutine()
    
    return nil
}

// Stop stops the manager
func (m *UnifiedManager) Stop() error {
    m.Logger.Info("Stopping manager", zap.String("name", m.Name))
    m.cancel()
    m.wg.Wait()
    return nil
}

// Add adds an item to the manager
func (m *UnifiedManager) Add(id string, item interface{}) error {
    m.mu.Lock()
    defer m.mu.Unlock()
    
    if m.maxItems > 0 && len(m.items) >= m.maxItems {
        return fmt.Errorf("maximum items reached: %d", m.maxItems)
    }
    
    if _, exists := m.items[id]; exists {
        return fmt.Errorf("item already exists: %s", id)
    }
    
    m.items[id] = item
    m.Stats.IncrementSuccess()
    return nil
}

// Get retrieves an item from the manager
func (m *UnifiedManager) Get(id string) (interface{}, error) {
    m.mu.RLock()
    defer m.mu.RUnlock()
    
    item, exists := m.items[id]
    if !exists {
        m.Stats.IncrementFailure()
        return nil, fmt.Errorf("item not found: %s", id)
    }
    
    m.Stats.IncrementSuccess()
    return item, nil
}

// Remove removes an item from the manager
func (m *UnifiedManager) Remove(id string) error {
    m.mu.Lock()
    defer m.mu.Unlock()
    
    if _, exists := m.items[id]; !exists {
        return fmt.Errorf("item not found: %s", id)
    }
    
    delete(m.items, id)
    return nil
}

// List returns all item IDs
func (m *UnifiedManager) List() []string {
    m.mu.RLock()
    defer m.mu.RUnlock()
    
    ids := make([]string, 0, len(m.items))
    for id := range m.items {
        ids = append(ids, id)
    }
    return ids
}

// Count returns the number of items
func (m *UnifiedManager) Count() int {
    m.mu.RLock()
    defer m.mu.RUnlock()
    return len(m.items)
}

// Clear removes all items
func (m *UnifiedManager) Clear() {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.items = make(map[string]interface{})
}

// GetStats returns manager statistics
func (m *UnifiedManager) GetStats() map[string]interface{} {
    stats := m.Stats.GetSnapshot()
    stats["item_count"] = m.Count()
    stats["max_items"] = m.maxItems
    return stats
}

// cleanupRoutine performs periodic cleanup
func (m *UnifiedManager) cleanupRoutine() {
    defer m.wg.Done()
    
    ticker := time.NewTicker(1 * time.Minute)
    defer ticker.Stop()
    
    for {
        select {
        case <-m.ctx.Done():
            return
        case <-ticker.C:
            m.cleanup()
        }
    }
}

// cleanup performs cleanup based on manager type
func (m *UnifiedManager) cleanup() {
    m.mu.Lock()
    defer m.mu.Unlock()
    
    // Type-specific cleanup logic
    switch m.Type {
    case ManagerTypeConnection, ManagerTypePeer:
        // Clean up stale connections
        m.cleanupStaleItems(5 * time.Minute)
    case ManagerTypeMemory:
        // Clean up based on memory pressure
        if len(m.items) > m.maxItems*80/100 {
            m.cleanupOldestItems(m.maxItems / 10)
        }
    }
}

// cleanupStaleItems removes items older than maxAge
func (m *UnifiedManager) cleanupStaleItems(maxAge time.Duration) {
    // Implementation depends on item type having LastSeen or similar field
    toRemove := []string{}
    
    for id, item := range m.items {
        // Type assertion based on manager type
        if stale := m.isStale(item, maxAge); stale {
            toRemove = append(toRemove, id)
        }
    }
    
    for _, id := range toRemove {
        delete(m.items, id)
        m.Logger.Debug("Removed stale item", zap.String("id", id))
    }
}

// cleanupOldestItems removes the n oldest items
func (m *UnifiedManager) cleanupOldestItems(n int) {
    if n <= 0 || len(m.items) == 0 {
        return
    }
    
    // Simple implementation: remove first n items
    removed := 0
    for id := range m.items {
        if removed >= n {
            break
        }
        delete(m.items, id)
        removed++
    }
}

// isStale checks if an item is stale (placeholder)
func (m *UnifiedManager) isStale(item interface{}, maxAge time.Duration) bool {
    // This would need type-specific implementation
    return false
}