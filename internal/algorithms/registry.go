package algorithms

import (
    "fmt"
    "sync"
    "time"
)

// Algorithm represents metadata about a mining algorithm.
type Algorithm struct {
    Name         string
    Difficulty   float64
    BlockReward  float64
    LastUpdate   time.Time
}

// Registry provides a threadsafe registry of supported algorithms.
// It is intentionally lightweight to satisfy current dependencies in the mining package.
type Registry struct {
    mu      sync.RWMutex
    entries map[string]*Algorithm
}

// NewRegistry returns an empty algorithm registry.
func NewRegistry() *Registry {
    return &Registry{
        entries: make(map[string]*Algorithm),
    }
}

// ListCPUFriendly returns algorithms suitable for CPU mining.
// For now, return all registered algorithms; future work can apply heuristics.
func (r *Registry) ListCPUFriendly() []*Algorithm {
    r.mu.RLock()
    defer r.mu.RUnlock()
    var list []*Algorithm
    for _, a := range r.entries {
        list = append(list, a)
    }
    return list
}

// ListGPUOptimized returns algorithms with efficient GPU implementations.
// Placeholder: currently returns all entries.
func (r *Registry) ListGPUOptimized() []*Algorithm {
    return r.ListCPUFriendly()
}

// Register adds or replaces an algorithm entry.
func (r *Registry) Register(name string, algo *Algorithm) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.entries[name] = algo
}

// Get retrieves an algorithm by name.
func (r *Registry) Get(name string) (*Algorithm, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    algo, ok := r.entries[name]
    if !ok {
        return nil, fmt.Errorf("algorithm %s not found", name)
    }
    return algo, nil
}
