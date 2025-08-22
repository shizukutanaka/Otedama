package resources

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// QuotaManager manages resource quotas
type QuotaManager struct {
	quotas   map[string]*Quota
	quotasMu sync.RWMutex
	
	// Global limits
	maxMemory    int64
	maxCPU       float64
	maxGoroutines int
	maxConnections int
	
	// Current usage
	memoryUsed     atomic.Int64
	cpuUsed        atomic.Value // float64
	goroutinesUsed atomic.Int32
	connectionsUsed atomic.Int32
	
	// Statistics
	violations atomic.Uint64
	denials    atomic.Uint64
}

// Quota represents a resource quota
type Quota struct {
	Name        string
	Type        ResourceType
	Limit       int64
	Used        atomic.Int64
	SoftLimit   int64
	HardLimit   int64
	
	// Time-based quotas
	Window      time.Duration
	windowStart time.Time
	windowUsed  atomic.Int64
	
	// Rate limiting
	rateLimit   int64
	ratePeriod  time.Duration
	lastReset   time.Time
	rateUsed    atomic.Int64
	
	mu sync.Mutex
}

// ResourceType represents type of resource
type ResourceType int

const (
	ResourceMemory ResourceType = iota
	ResourceCPU
	ResourceDisk
	ResourceNetwork
	ResourceGoroutines
	ResourceConnections
	ResourceRequests
)

// QuotaConfig holds quota configuration
type QuotaConfig struct {
	MaxMemoryMB     int64
	MaxCPUPercent   float64
	MaxGoroutines   int
	MaxConnections  int
	MaxDiskGB       int64
	MaxNetworkMbps  int64
}

// DefaultQuotaConfig returns default quota configuration
func DefaultQuotaConfig() *QuotaConfig {
	return &QuotaConfig{
		MaxMemoryMB:    4096,  // 4GB
		MaxCPUPercent:  80.0,
		MaxGoroutines:  10000,
		MaxConnections: 1000,
		MaxDiskGB:      100,
		MaxNetworkMbps: 1000,
	}
}

// NewQuotaManager creates a new quota manager
func NewQuotaManager(config *QuotaConfig) *QuotaManager {
	if config == nil {
		config = DefaultQuotaConfig()
	}
	
	qm := &QuotaManager{
		quotas:         make(map[string]*Quota),
		maxMemory:      config.MaxMemoryMB * 1024 * 1024,
		maxCPU:         config.MaxCPUPercent,
		maxGoroutines:  config.MaxGoroutines,
		maxConnections: config.MaxConnections,
	}
	
	// Start monitoring
	go qm.monitor()
	
	return qm
}

// CreateQuota creates a new quota
func (qm *QuotaManager) CreateQuota(name string, resourceType ResourceType, limit int64) error {
	qm.quotasMu.Lock()
	defer qm.quotasMu.Unlock()
	
	if _, exists := qm.quotas[name]; exists {
		return errors.New("quota already exists")
	}
	
	quota := &Quota{
		Name:      name,
		Type:      resourceType,
		Limit:     limit,
		SoftLimit: int64(float64(limit) * 0.8),
		HardLimit: limit,
	}
	
	qm.quotas[name] = quota
	return nil
}

// CreateTimeWindowQuota creates a time-window based quota
func (qm *QuotaManager) CreateTimeWindowQuota(name string, resourceType ResourceType, limit int64, window time.Duration) error {
	qm.quotasMu.Lock()
	defer qm.quotasMu.Unlock()
	
	if _, exists := qm.quotas[name]; exists {
		return errors.New("quota already exists")
	}
	
	quota := &Quota{
		Name:        name,
		Type:        resourceType,
		Limit:       limit,
		Window:      window,
		windowStart: time.Now(),
		SoftLimit:   int64(float64(limit) * 0.8),
		HardLimit:   limit,
	}
	
	qm.quotas[name] = quota
	return nil
}

// CreateRateLimitQuota creates a rate-limited quota
func (qm *QuotaManager) CreateRateLimitQuota(name string, resourceType ResourceType, limit int64, period time.Duration) error {
	qm.quotasMu.Lock()
	defer qm.quotasMu.Unlock()
	
	if _, exists := qm.quotas[name]; exists {
		return errors.New("quota already exists")
	}
	
	quota := &Quota{
		Name:       name,
		Type:       resourceType,
		rateLimit:  limit,
		ratePeriod: period,
		lastReset:  time.Now(),
	}
	
	qm.quotas[name] = quota
	return nil
}

// Acquire acquires resources from quota
func (qm *QuotaManager) Acquire(name string, amount int64) error {
	qm.quotasMu.RLock()
	quota, exists := qm.quotas[name]
	qm.quotasMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("quota %s not found", name)
	}
	
	return qm.acquireFromQuota(quota, amount)
}

// acquireFromQuota acquires from specific quota
func (qm *QuotaManager) acquireFromQuota(quota *Quota, amount int64) error {
	quota.mu.Lock()
	defer quota.mu.Unlock()
	
	// Check time window
	if quota.Window > 0 {
		now := time.Now()
		if now.Sub(quota.windowStart) > quota.Window {
			// Reset window
			quota.windowStart = now
			quota.windowUsed.Store(0)
		}
		
		if quota.windowUsed.Load()+amount > quota.Limit {
			qm.denials.Add(1)
			return errors.New("time window quota exceeded")
		}
		
		quota.windowUsed.Add(amount)
		return nil
	}
	
	// Check rate limit
	if quota.rateLimit > 0 {
		now := time.Now()
		if now.Sub(quota.lastReset) > quota.ratePeriod {
			// Reset rate limit
			quota.lastReset = now
			quota.rateUsed.Store(0)
		}
		
		if quota.rateUsed.Load()+amount > quota.rateLimit {
			qm.denials.Add(1)
			return errors.New("rate limit exceeded")
		}
		
		quota.rateUsed.Add(amount)
		return nil
	}
	
	// Check regular quota
	current := quota.Used.Load()
	if current+amount > quota.HardLimit {
		qm.denials.Add(1)
		return errors.New("quota exceeded")
	}
	
	if current+amount > quota.SoftLimit {
		qm.violations.Add(1)
		// Log warning but allow
	}
	
	quota.Used.Add(amount)
	
	// Update global usage
	switch quota.Type {
	case ResourceMemory:
		qm.memoryUsed.Add(amount)
	case ResourceGoroutines:
		qm.goroutinesUsed.Add(int32(amount))
	case ResourceConnections:
		qm.connectionsUsed.Add(int32(amount))
	}
	
	return nil
}

// Release releases resources back to quota
func (qm *QuotaManager) Release(name string, amount int64) error {
	qm.quotasMu.RLock()
	quota, exists := qm.quotas[name]
	qm.quotasMu.RUnlock()
	
	if !exists {
		return fmt.Errorf("quota %s not found", name)
	}
	
	quota.Used.Add(-amount)
	
	// Update global usage
	switch quota.Type {
	case ResourceMemory:
		qm.memoryUsed.Add(-amount)
	case ResourceGoroutines:
		qm.goroutinesUsed.Add(-int32(amount))
	case ResourceConnections:
		qm.connectionsUsed.Add(-int32(amount))
	}
	
	return nil
}

// CheckAvailable checks if resources are available
func (qm *QuotaManager) CheckAvailable(name string, amount int64) bool {
	qm.quotasMu.RLock()
	quota, exists := qm.quotas[name]
	qm.quotasMu.RUnlock()
	
	if !exists {
		return false
	}
	
	return quota.Used.Load()+amount <= quota.Limit
}

// GetUsage returns current usage for a quota
func (qm *QuotaManager) GetUsage(name string) (int64, error) {
	qm.quotasMu.RLock()
	quota, exists := qm.quotas[name]
	qm.quotasMu.RUnlock()
	
	if !exists {
		return 0, fmt.Errorf("quota %s not found", name)
	}
	
	return quota.Used.Load(), nil
}

// GetQuotaInfo returns quota information
func (qm *QuotaManager) GetQuotaInfo(name string) (*QuotaInfo, error) {
	qm.quotasMu.RLock()
	quota, exists := qm.quotas[name]
	qm.quotasMu.RUnlock()
	
	if !exists {
		return nil, fmt.Errorf("quota %s not found", name)
	}
	
	used := quota.Used.Load()
	return &QuotaInfo{
		Name:       quota.Name,
		Type:       quota.Type.String(),
		Used:       used,
		Limit:      quota.Limit,
		Available:  quota.Limit - used,
		Percentage: float64(used) / float64(quota.Limit) * 100,
	}, nil
}

// QuotaInfo contains quota information
type QuotaInfo struct {
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Used       int64   `json:"used"`
	Limit      int64   `json:"limit"`
	Available  int64   `json:"available"`
	Percentage float64 `json:"percentage"`
}

// monitor monitors resource usage
func (qm *QuotaManager) monitor() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		// Monitor memory
		var memStats runtime.MemStats
		runtime.ReadMemStats(&memStats)
		
		if int64(memStats.Alloc) > qm.maxMemory {
			// Trigger memory cleanup
			runtime.GC()
		}
		
		// Monitor goroutines
		numGoroutines := runtime.NumGoroutine()
		if numGoroutines > qm.maxGoroutines {
			// Log warning
			qm.violations.Add(1)
		}
	}
}

// GetStatistics returns quota statistics
func (qm *QuotaManager) GetStatistics() map[string]interface{} {
	stats := make(map[string]interface{})
	
	stats["violations"] = qm.violations.Load()
	stats["denials"] = qm.denials.Load()
	stats["memory_used"] = qm.memoryUsed.Load()
	stats["goroutines_used"] = qm.goroutinesUsed.Load()
	stats["connections_used"] = qm.connectionsUsed.Load()
	
	// Get quota details
	qm.quotasMu.RLock()
	quotaStats := make([]map[string]interface{}, 0, len(qm.quotas))
	for _, quota := range qm.quotas {
		used := quota.Used.Load()
		quotaStats = append(quotaStats, map[string]interface{}{
			"name":       quota.Name,
			"type":       quota.Type.String(),
			"used":       used,
			"limit":      quota.Limit,
			"percentage": float64(used) / float64(quota.Limit) * 100,
		})
	}
	qm.quotasMu.RUnlock()
	
	stats["quotas"] = quotaStats
	
	return stats
}

// String returns string representation of ResourceType
func (rt ResourceType) String() string {
	switch rt {
	case ResourceMemory:
		return "memory"
	case ResourceCPU:
		return "cpu"
	case ResourceDisk:
		return "disk"
	case ResourceNetwork:
		return "network"
	case ResourceGoroutines:
		return "goroutines"
	case ResourceConnections:
		return "connections"
	case ResourceRequests:
		return "requests"
	default:
		return "unknown"
	}
}

// ResourceLimiter provides resource limiting with context
type ResourceLimiter struct {
	manager *QuotaManager
	quota   string
}

// NewResourceLimiter creates a new resource limiter
func NewResourceLimiter(manager *QuotaManager, quota string) *ResourceLimiter {
	return &ResourceLimiter{
		manager: manager,
		quota:   quota,
	}
}

// WithQuota executes function with quota
func (rl *ResourceLimiter) WithQuota(ctx context.Context, amount int64, fn func() error) error {
	// Acquire quota
	if err := rl.manager.Acquire(rl.quota, amount); err != nil {
		return err
	}
	
	// Ensure release
	defer rl.manager.Release(rl.quota, amount)
	
	// Execute with context
	done := make(chan error, 1)
	go func() {
		done <- fn()
	}()
	
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Semaphore provides counting semaphore for resource limiting
type Semaphore struct {
	permits chan struct{}
}

// NewSemaphore creates a new semaphore
func NewSemaphore(permits int) *Semaphore {
	sem := &Semaphore{
		permits: make(chan struct{}, permits),
	}
	
	// Fill with permits
	for i := 0; i < permits; i++ {
		sem.permits <- struct{}{}
	}
	
	return sem
}

// Acquire acquires a permit
func (s *Semaphore) Acquire(ctx context.Context) error {
	select {
	case <-s.permits:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// TryAcquire tries to acquire a permit without blocking
func (s *Semaphore) TryAcquire() bool {
	select {
	case <-s.permits:
		return true
	default:
		return false
	}
}

// Release releases a permit
func (s *Semaphore) Release() {
	select {
	case s.permits <- struct{}{}:
	default:
		// Permit channel full, ignore
	}
}

// TokenBucket implements token bucket algorithm
type TokenBucket struct {
	capacity int64
	tokens   atomic.Int64
	refillRate int64
	lastRefill atomic.Value // time.Time
	mu       sync.Mutex
}

// NewTokenBucket creates a new token bucket
func NewTokenBucket(capacity, refillRate int64) *TokenBucket {
	tb := &TokenBucket{
		capacity:   capacity,
		refillRate: refillRate,
	}
	tb.tokens.Store(capacity)
	tb.lastRefill.Store(time.Now())
	
	// Start refill routine
	go tb.refillRoutine()
	
	return tb
}

// Take takes tokens from bucket
func (tb *TokenBucket) Take(tokens int64) bool {
	tb.refill()
	
	current := tb.tokens.Load()
	if current < tokens {
		return false
	}
	
	return tb.tokens.CompareAndSwap(current, current-tokens)
}

// refill refills the bucket
func (tb *TokenBucket) refill() {
	tb.mu.Lock()
	defer tb.mu.Unlock()
	
	now := time.Now()
	lastRefill := tb.lastRefill.Load().(time.Time)
	elapsed := now.Sub(lastRefill)
	
	tokensToAdd := int64(elapsed.Seconds()) * tb.refillRate
	if tokensToAdd > 0 {
		current := tb.tokens.Load()
		newTokens := current + tokensToAdd
		if newTokens > tb.capacity {
			newTokens = tb.capacity
		}
		tb.tokens.Store(newTokens)
		tb.lastRefill.Store(now)
	}
}

// refillRoutine periodically refills bucket
func (tb *TokenBucket) refillRoutine() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	
	for range ticker.C {
		tb.refill()
	}
}