package memory

import (
	"context"
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// Manager manages memory usage and prevents leaks
type Manager struct {
	logger        *zap.Logger
	config        Config
	
	// Memory tracking
	allocations   sync.Map // map[string]*Allocation
	totalAlloc    atomic.Uint64
	
	// Leak detection
	leakDetector  *LeakDetector
	
	// GC control
	gcTrigger     atomic.Uint64
	lastGC        atomic.Int64
	
	// Resource limits
	memoryLimit   uint64
	
	// Cleanup functions
	cleanupFuncs  []CleanupFunc
	cleanupMu     sync.Mutex
	
	stopChan      chan struct{}
}

// Config defines memory manager configuration
type Config struct {
	MemoryLimit      uint64        `yaml:"memory_limit"`
	GCInterval       time.Duration `yaml:"gc_interval"`
	LeakCheckInterval time.Duration `yaml:"leak_check_interval"`
	EnableProfiling  bool          `yaml:"enable_profiling"`
	ForceGCThreshold float64       `yaml:"force_gc_threshold"`
}

// Allocation tracks a memory allocation
type Allocation struct {
	Size      uint64
	Stack     string
	Timestamp time.Time
	Type      string
}

// CleanupFunc is a function that cleans up resources
type CleanupFunc func() error

// LeakDetector detects memory leaks
type LeakDetector struct {
	allocations  map[uintptr]*Allocation
	mu           sync.RWMutex
	threshold    time.Duration
}

// NewManager creates a new memory manager
func NewManager(logger *zap.Logger, config Config) *Manager {
	return &Manager{
		logger:       logger,
		config:       config,
		memoryLimit:  config.MemoryLimit,
		leakDetector: NewLeakDetector(5 * time.Minute),
		stopChan:     make(chan struct{}),
	}
}

// Start begins memory management
func (m *Manager) Start(ctx context.Context) error {
	m.logger.Info("Starting memory manager",
		zap.Uint64("memory_limit_mb", m.memoryLimit/1024/1024),
		zap.Duration("gc_interval", m.config.GCInterval),
	)
	
	// Set memory limit
	if m.memoryLimit > 0 {
		debug.SetMemoryLimit(int64(m.memoryLimit))
	}
	
	// Start monitoring
	go m.monitorLoop(ctx)
	
	// Start leak detection
	if m.config.LeakCheckInterval > 0 {
		go m.leakDetectionLoop(ctx)
	}
	
	return nil
}

// Stop halts memory management
func (m *Manager) Stop() error {
	close(m.stopChan)
	
	// Run cleanup functions
	m.cleanupMu.Lock()
	defer m.cleanupMu.Unlock()
	
	for _, cleanup := range m.cleanupFuncs {
		if err := cleanup(); err != nil {
			m.logger.Error("Cleanup failed", zap.Error(err))
		}
	}
	
	return nil
}

// RegisterCleanup registers a cleanup function
func (m *Manager) RegisterCleanup(fn CleanupFunc) {
	m.cleanupMu.Lock()
	defer m.cleanupMu.Unlock()
	m.cleanupFuncs = append(m.cleanupFuncs, fn)
}

// TrackAllocation tracks a memory allocation
func (m *Manager) TrackAllocation(key string, size uint64, allocType string) {
	allocation := &Allocation{
		Size:      size,
		Stack:     getStackTrace(3),
		Timestamp: time.Now(),
		Type:      allocType,
	}
	
	m.allocations.Store(key, allocation)
	m.totalAlloc.Add(size)
	
	// Check if we need to trigger GC
	if m.totalAlloc.Load() > m.gcTrigger.Load() {
		m.triggerGC("allocation_threshold")
	}
}

// ReleaseAllocation releases a tracked allocation
func (m *Manager) ReleaseAllocation(key string) {
	if val, ok := m.allocations.LoadAndDelete(key); ok {
		if alloc, ok := val.(*Allocation); ok {
			m.totalAlloc.Add(^(alloc.Size - 1)) // Subtract
		}
	}
}

// monitorLoop monitors memory usage
func (m *Manager) monitorLoop(ctx context.Context) {
	ticker := time.NewTicker(m.config.GCInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.stopChan:
			return
		case <-ticker.C:
			m.checkMemoryUsage()
		}
	}
}

// checkMemoryUsage checks current memory usage
func (m *Manager) checkMemoryUsage() {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	
	// Log memory stats
	m.logger.Debug("Memory stats",
		zap.Uint64("alloc_mb", stats.Alloc/1024/1024),
		zap.Uint64("total_alloc_mb", stats.TotalAlloc/1024/1024),
		zap.Uint64("sys_mb", stats.Sys/1024/1024),
		zap.Uint32("num_gc", stats.NumGC),
		zap.Uint64("heap_alloc_mb", stats.HeapAlloc/1024/1024),
		zap.Uint64("heap_inuse_mb", stats.HeapInuse/1024/1024),
	)
	
	// Check if we need to force GC
	if m.config.ForceGCThreshold > 0 {
		usagePercent := float64(stats.Alloc) / float64(m.memoryLimit) * 100
		if usagePercent > m.config.ForceGCThreshold {
			m.triggerGC("threshold_exceeded")
		}
	}
	
	// Update GC trigger
	m.gcTrigger.Store(stats.NextGC)
	
	// Check for memory pressure
	if stats.Sys > m.memoryLimit && m.memoryLimit > 0 {
		m.logger.Warn("Memory limit exceeded",
			zap.Uint64("current_mb", stats.Sys/1024/1024),
			zap.Uint64("limit_mb", m.memoryLimit/1024/1024),
		)
		m.performEmergencyCleanup()
	}
}

// triggerGC triggers garbage collection
func (m *Manager) triggerGC(reason string) {
	lastGC := m.lastGC.Load()
	now := time.Now().Unix()
	
	// Avoid GC thrashing
	if now-lastGC < 1 {
		return
	}
	
	m.logger.Debug("Triggering GC", zap.String("reason", reason))
	
	runtime.GC()
	m.lastGC.Store(now)
	
	// Also free OS memory
	debug.FreeOSMemory()
}

// performEmergencyCleanup performs emergency memory cleanup
func (m *Manager) performEmergencyCleanup() {
	m.logger.Warn("Performing emergency memory cleanup")
	
	// Clear old allocations
	cutoff := time.Now().Add(-5 * time.Minute)
	var keysToDelete []string
	
	m.allocations.Range(func(key, value interface{}) bool {
		if alloc, ok := value.(*Allocation); ok {
			if alloc.Timestamp.Before(cutoff) {
				keysToDelete = append(keysToDelete, key.(string))
			}
		}
		return true
	})
	
	for _, key := range keysToDelete {
		m.ReleaseAllocation(key)
	}
	
	// Force GC
	runtime.GC()
	debug.FreeOSMemory()
}

// leakDetectionLoop runs leak detection
func (m *Manager) leakDetectionLoop(ctx context.Context) {
	ticker := time.NewTicker(m.config.LeakCheckInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.stopChan:
			return
		case <-ticker.C:
			m.detectLeaks()
		}
	}
}

// detectLeaks checks for potential memory leaks
func (m *Manager) detectLeaks() {
	var suspiciousAllocs []string
	threshold := time.Now().Add(-10 * time.Minute)
	
	m.allocations.Range(func(key, value interface{}) bool {
		if alloc, ok := value.(*Allocation); ok {
			if alloc.Timestamp.Before(threshold) && alloc.Size > 1024*1024 { // 1MB
				suspiciousAllocs = append(suspiciousAllocs, fmt.Sprintf(
					"Key: %s, Size: %d MB, Age: %s, Type: %s",
					key,
					alloc.Size/1024/1024,
					time.Since(alloc.Timestamp),
					alloc.Type,
				))
			}
		}
		return true
	})
	
	if len(suspiciousAllocs) > 0 {
		m.logger.Warn("Potential memory leaks detected",
			zap.Int("count", len(suspiciousAllocs)),
			zap.Strings("allocations", suspiciousAllocs),
		)
	}
}

// GetStats returns memory statistics
func (m *Manager) GetStats() map[string]interface{} {
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	
	allocCount := 0
	m.allocations.Range(func(_, _ interface{}) bool {
		allocCount++
		return true
	})
	
	return map[string]interface{}{
		"alloc_mb":          stats.Alloc / 1024 / 1024,
		"total_alloc_mb":    stats.TotalAlloc / 1024 / 1024,
		"sys_mb":            stats.Sys / 1024 / 1024,
		"heap_alloc_mb":     stats.HeapAlloc / 1024 / 1024,
		"heap_inuse_mb":     stats.HeapInuse / 1024 / 1024,
		"num_gc":            stats.NumGC,
		"gc_pause_ms":       stats.PauseNs[(stats.NumGC+255)%256] / 1e6,
		"tracked_allocs":    allocCount,
		"tracked_size_mb":   m.totalAlloc.Load() / 1024 / 1024,
		"goroutines":        runtime.NumGoroutine(),
	}
}

// NewLeakDetector creates a new leak detector
func NewLeakDetector(threshold time.Duration) *LeakDetector {
	return &LeakDetector{
		allocations: make(map[uintptr]*Allocation),
		threshold:   threshold,
	}
}

// Track tracks an allocation
func (ld *LeakDetector) Track(ptr uintptr, size uint64) {
	ld.mu.Lock()
	defer ld.mu.Unlock()
	
	ld.allocations[ptr] = &Allocation{
		Size:      size,
		Stack:     getStackTrace(3),
		Timestamp: time.Now(),
	}
}

// Release releases a tracked allocation
func (ld *LeakDetector) Release(ptr uintptr) {
	ld.mu.Lock()
	defer ld.mu.Unlock()
	
	delete(ld.allocations, ptr)
}

// Check checks for leaks
func (ld *LeakDetector) Check() []*Allocation {
	ld.mu.RLock()
	defer ld.mu.RUnlock()
	
	var leaks []*Allocation
	threshold := time.Now().Add(-ld.threshold)
	
	for _, alloc := range ld.allocations {
		if alloc.Timestamp.Before(threshold) {
			leaks = append(leaks, alloc)
		}
	}
	
	return leaks
}

// getStackTrace returns the current stack trace
func getStackTrace(skip int) string {
	buf := make([]byte, 4096)
	n := runtime.Stack(buf, false)
	return string(buf[:n])
}

// MemoryPool provides object pooling to reduce allocations
type MemoryPool struct {
	pool sync.Pool
	size int
	hits atomic.Uint64
	miss atomic.Uint64
}

// NewMemoryPool creates a new memory pool
func NewMemoryPool(size int, factory func() interface{}) *MemoryPool {
	return &MemoryPool{
		size: size,
		pool: sync.Pool{
			New: factory,
		},
	}
}

// Get retrieves an object from the pool
func (mp *MemoryPool) Get() interface{} {
	obj := mp.pool.Get()
	if obj != nil {
		mp.hits.Add(1)
	} else {
		mp.miss.Add(1)
	}
	return obj
}

// Put returns an object to the pool
func (mp *MemoryPool) Put(obj interface{}) {
	// Reset object if it implements Resetter interface
	if resetter, ok := obj.(interface{ Reset() }); ok {
		resetter.Reset()
	}
	mp.pool.Put(obj)
}

// Stats returns pool statistics
func (mp *MemoryPool) Stats() (hits, misses uint64) {
	return mp.hits.Load(), mp.miss.Load()
}