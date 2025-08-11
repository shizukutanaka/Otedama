package optimization

import (
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
	
	"go.uber.org/zap"
)

// PressureAwarePool implements a memory pool that adapts based on system memory pressure
type PressureAwarePool struct {
	pool            sync.Pool
	pressure        atomic.Uint64
	maxMemoryMB     uint64
	currentUsageMB  atomic.Uint64
	lastGC          atomic.Int64
	metrics         *MemoryMetrics
	logger          *zap.Logger
	
	// Adaptive parameters
	highPressureThreshold float64
	lowPressureThreshold  float64
	gcInterval            time.Duration
	
	// Pool size management
	minPoolSize     int
	maxPoolSize     int
	currentPoolSize atomic.Int32
	
	// Cleanup
	cleanupInterval time.Duration
	stopChan        chan struct{}
	wg              sync.WaitGroup
}

// MemoryMetrics tracks memory usage statistics
type MemoryMetrics struct {
	AllocsMB       atomic.Uint64
	ReleasesMB     atomic.Uint64
	GCCycles       atomic.Uint64
	PressureEvents atomic.Uint64
	RejectedAllocs atomic.Uint64
}

// NewPressureAwarePool creates a new pressure-aware memory pool
func NewPressureAwarePool(logger *zap.Logger, maxMemoryMB uint64, newFunc func() interface{}) *PressureAwarePool {
	p := &PressureAwarePool{
		pool: sync.Pool{
			New: newFunc,
		},
		maxMemoryMB:           maxMemoryMB,
		metrics:               &MemoryMetrics{},
		logger:                logger,
		highPressureThreshold: 0.8, // 80% memory usage
		lowPressureThreshold:  0.5, // 50% memory usage
		gcInterval:            30 * time.Second,
		minPoolSize:           10,
		maxPoolSize:           1000,
		cleanupInterval:       1 * time.Minute,
		stopChan:              make(chan struct{}),
	}
	
	// Start monitoring goroutine
	p.wg.Add(1)
	go p.monitor()
	
	return p
}

// Get retrieves an object from the pool
func (p *PressureAwarePool) Get() interface{} {
	// Check memory pressure
	if p.isHighPressure() {
		p.metrics.RejectedAllocs.Add(1)
		
		// Try to trigger GC if needed
		if p.shouldTriggerGC() {
			p.triggerGC()
		}
		
		// If still high pressure, create new object instead of pooling
		if p.isHighPressure() {
			return p.pool.New()
		}
	}
	
	obj := p.pool.Get()
	if obj == nil {
		obj = p.pool.New()
	}
	
	// Track allocation
	p.trackAllocation(obj)
	
	return obj
}

// Put returns an object to the pool
func (p *PressureAwarePool) Put(obj interface{}) {
	// Don't pool if under high memory pressure
	if p.isHighPressure() {
		// Let GC collect it
		p.trackRelease(obj)
		return
	}
	
	// Check pool size limits
	currentSize := p.currentPoolSize.Load()
	if currentSize >= int32(p.maxPoolSize) {
		// Pool is full, let GC collect it
		p.trackRelease(obj)
		return
	}
	
	// Clear the object if it implements Clearable interface
	if clearable, ok := obj.(Clearable); ok {
		clearable.Clear()
	}
	
	p.pool.Put(obj)
	p.currentPoolSize.Add(1)
	p.trackRelease(obj)
}

// Clearable interface for objects that can be cleared before reuse
type Clearable interface {
	Clear()
}

// isHighPressure checks if memory pressure is high
func (p *PressureAwarePool) isHighPressure() bool {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	usageMB := m.Alloc / 1024 / 1024
	p.currentUsageMB.Store(usageMB)
	
	pressureRatio := float64(usageMB) / float64(p.maxMemoryMB)
	p.pressure.Store(uint64(pressureRatio * 100))
	
	if pressureRatio > p.highPressureThreshold {
		p.metrics.PressureEvents.Add(1)
		return true
	}
	
	return false
}

// shouldTriggerGC determines if GC should be triggered
func (p *PressureAwarePool) shouldTriggerGC() bool {
	lastGC := p.lastGC.Load()
	now := time.Now().Unix()
	
	// Don't trigger GC too frequently
	if now-lastGC < int64(p.gcInterval.Seconds()) {
		return false
	}
	
	return true
}

// triggerGC triggers garbage collection
func (p *PressureAwarePool) triggerGC() {
	runtime.GC()
	debug.FreeOSMemory()
	p.lastGC.Store(time.Now().Unix())
	p.metrics.GCCycles.Add(1)
	
	p.logger.Debug("Triggered GC due to memory pressure",
		zap.Uint64("current_mb", p.currentUsageMB.Load()),
		zap.Uint64("max_mb", p.maxMemoryMB),
		zap.Uint64("pressure", p.pressure.Load()),
	)
}

// trackAllocation tracks memory allocation
func (p *PressureAwarePool) trackAllocation(obj interface{}) {
	// Estimate object size (simplified)
	size := estimateSize(obj)
	p.metrics.AllocsMB.Add(size / 1024 / 1024)
}

// trackRelease tracks memory release
func (p *PressureAwarePool) trackRelease(obj interface{}) {
	size := estimateSize(obj)
	p.metrics.ReleasesMB.Add(size / 1024 / 1024)
	p.currentPoolSize.Add(-1)
}

// monitor runs the background monitoring goroutine
func (p *PressureAwarePool) monitor() {
	defer p.wg.Done()
	
	ticker := time.NewTicker(p.cleanupInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-p.stopChan:
			return
		case <-ticker.C:
			p.performCleanup()
		}
	}
}

// performCleanup performs periodic pool cleanup
func (p *PressureAwarePool) performCleanup() {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	usageMB := m.Alloc / 1024 / 1024
	pressureRatio := float64(usageMB) / float64(p.maxMemoryMB)
	
	// Adaptive pool sizing based on pressure
	if pressureRatio > p.highPressureThreshold {
		// Shrink pool under high pressure
		p.shrinkPool()
	} else if pressureRatio < p.lowPressureThreshold {
		// Allow pool to grow under low pressure
		p.growPool()
	}
	
	// Log metrics periodically
	p.logger.Info("Memory pool metrics",
		zap.Uint64("usage_mb", usageMB),
		zap.Uint64("pressure_pct", p.pressure.Load()),
		zap.Int32("pool_size", p.currentPoolSize.Load()),
		zap.Uint64("allocs_mb", p.metrics.AllocsMB.Load()),
		zap.Uint64("releases_mb", p.metrics.ReleasesMB.Load()),
		zap.Uint64("gc_cycles", p.metrics.GCCycles.Load()),
		zap.Uint64("pressure_events", p.metrics.PressureEvents.Load()),
		zap.Uint64("rejected_allocs", p.metrics.RejectedAllocs.Load()),
	)
}

// shrinkPool reduces pool size under memory pressure
func (p *PressureAwarePool) shrinkPool() {
	// Force GC to clean up pooled objects
	runtime.GC()
	p.currentPoolSize.Store(int32(p.minPoolSize))
	
	p.logger.Debug("Shrinking pool due to memory pressure",
		zap.Int("new_size", p.minPoolSize),
	)
}

// growPool increases pool size when memory is available
func (p *PressureAwarePool) growPool() {
	newSize := p.currentPoolSize.Load() * 2
	if newSize > int32(p.maxPoolSize) {
		newSize = int32(p.maxPoolSize)
	}
	
	p.currentPoolSize.Store(newSize)
	
	p.logger.Debug("Growing pool due to low memory pressure",
		zap.Int32("new_size", newSize),
	)
}

// Stop stops the monitoring goroutine
func (p *PressureAwarePool) Stop() {
	close(p.stopChan)
	p.wg.Wait()
}

// GetMetrics returns current metrics
func (p *PressureAwarePool) GetMetrics() MemoryMetrics {
	return MemoryMetrics{
		AllocsMB:       atomic.Uint64{},
		ReleasesMB:     atomic.Uint64{},
		GCCycles:       atomic.Uint64{},
		PressureEvents: atomic.Uint64{},
		RejectedAllocs: atomic.Uint64{},
	}
}

// estimateSize estimates the size of an object in bytes
func estimateSize(obj interface{}) uint64 {
	// This is a simplified estimation
	// In production, use reflect or unsafe to get accurate size
	switch v := obj.(type) {
	case []byte:
		return uint64(len(v))
	case string:
		return uint64(len(v))
	default:
		// Default estimate for unknown types
		return 1024
	}
}

// AdaptiveMemoryManager manages multiple memory pools with global coordination
type AdaptiveMemoryManager struct {
	pools           map[string]*PressureAwarePool
	globalPressure  atomic.Uint64
	maxGlobalMemory uint64
	logger          *zap.Logger
	mu              sync.RWMutex
}

// NewAdaptiveMemoryManager creates a new adaptive memory manager
func NewAdaptiveMemoryManager(logger *zap.Logger, maxGlobalMemoryMB uint64) *AdaptiveMemoryManager {
	return &AdaptiveMemoryManager{
		pools:           make(map[string]*PressureAwarePool),
		maxGlobalMemory: maxGlobalMemoryMB,
		logger:          logger,
	}
}

// RegisterPool registers a new pool with the manager
func (amm *AdaptiveMemoryManager) RegisterPool(name string, pool *PressureAwarePool) {
	amm.mu.Lock()
	defer amm.mu.Unlock()
	
	amm.pools[name] = pool
	
	amm.logger.Info("Registered memory pool",
		zap.String("name", name),
		zap.Uint64("max_memory_mb", pool.maxMemoryMB),
	)
}

// GetPool retrieves a pool by name
func (amm *AdaptiveMemoryManager) GetPool(name string) *PressureAwarePool {
	amm.mu.RLock()
	defer amm.mu.RUnlock()
	
	return amm.pools[name]
}

// GlobalPressure returns the current global memory pressure
func (amm *AdaptiveMemoryManager) GlobalPressure() float64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	usageMB := m.Alloc / 1024 / 1024
	pressure := float64(usageMB) / float64(amm.maxGlobalMemory)
	amm.globalPressure.Store(uint64(pressure * 100))
	
	return pressure
}

// CoordinateCleanup performs coordinated cleanup across all pools
func (amm *AdaptiveMemoryManager) CoordinateCleanup() {
	amm.mu.RLock()
	defer amm.mu.RUnlock()
	
	pressure := amm.GlobalPressure()
	
	amm.logger.Info("Coordinating memory cleanup",
		zap.Float64("global_pressure", pressure),
		zap.Int("pool_count", len(amm.pools)),
	)
	
	// Trigger cleanup in all pools based on global pressure
	for name, pool := range amm.pools {
		if pressure > 0.7 {
			pool.shrinkPool()
			amm.logger.Debug("Shrinking pool due to global pressure",
				zap.String("pool", name),
			)
		}
	}
	
	// Force GC if pressure is critical
	if pressure > 0.9 {
		runtime.GC()
		debug.FreeOSMemory()
		amm.logger.Warn("Critical memory pressure, forced GC",
			zap.Float64("pressure", pressure),
		)
	}
}