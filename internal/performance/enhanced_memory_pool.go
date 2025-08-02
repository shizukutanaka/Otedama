package performance

import (
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"go.uber.org/zap"
)

// EnhancedMemoryPool provides advanced memory pooling with GC optimization
type EnhancedMemoryPool struct {
	logger *zap.Logger
	
	// Pools by size class
	pools      []*sizeClassPool
	
	// Statistics
	stats      PoolStats
	
	// GC optimization
	gcTuner    *GCTuner
	
	// Memory pressure monitoring
	pressure   *MemoryPressureMonitor
	
	// Configuration
	config     PoolConfig
}

// PoolConfig defines memory pool configuration
type PoolConfig struct {
	// Size classes
	MinSize        int     `yaml:"min_size"`         // Minimum allocation size
	MaxSize        int     `yaml:"max_size"`         // Maximum allocation size
	SizeMultiplier float64 `yaml:"size_multiplier"`  // Size class multiplier
	
	// Pool limits
	MaxItemsPerPool int     `yaml:"max_items_per_pool"`
	PreAllocate     bool    `yaml:"pre_allocate"`
	
	// GC tuning
	EnableGCTuning  bool    `yaml:"enable_gc_tuning"`
	TargetPauseTime int     `yaml:"target_pause_time_ms"`
	MaxMemoryMB     int     `yaml:"max_memory_mb"`
	
	// Monitoring
	EnableStats     bool    `yaml:"enable_stats"`
	StatsInterval   time.Duration `yaml:"stats_interval"`
}

// PoolStats tracks pool statistics
type PoolStats struct {
	allocations   atomic.Uint64
	deallocations atomic.Uint64
	hits          atomic.Uint64
	misses        atomic.Uint64
	gcCycles      atomic.Uint64
	totalAllocated atomic.Uint64
	currentInUse   atomic.Uint64
}

// sizeClassPool manages a pool for a specific size class
type sizeClassPool struct {
	size       int
	pool       sync.Pool
	allocated  atomic.Int64
	inUse      atomic.Int64
	hitRate    atomic.Value // float64
}

// GCTuner optimizes garbage collection for memory pools
type GCTuner struct {
	logger         *zap.Logger
	enabled        atomic.Bool
	targetPause    time.Duration
	lastTuneTime   atomic.Int64
	gcPercent      atomic.Int32
	memStats       runtime.MemStats
	mu             sync.RWMutex
}

// MemoryPressureMonitor tracks memory pressure
type MemoryPressureMonitor struct {
	logger          *zap.Logger
	threshold       uint64
	criticalThreshold uint64
	lastCheck       atomic.Int64
	pressure        atomic.Value // PressureLevel
	callbacks       []PressureCallback
	mu              sync.RWMutex
}

// PressureLevel indicates memory pressure level
type PressureLevel int

const (
	PressureNormal PressureLevel = iota
	PressureModerate
	PressureHigh
	PressureCritical
)

// PressureCallback is called when memory pressure changes
type PressureCallback func(level PressureLevel)

// Buffer represents a pooled buffer
type Buffer struct {
	data      []byte
	pool      *sizeClassPool
	refCount  atomic.Int32
	lastUsed  atomic.Int64
}

// NewEnhancedMemoryPool creates an optimized memory pool
func NewEnhancedMemoryPool(logger *zap.Logger, config PoolConfig) *EnhancedMemoryPool {
	// Set defaults
	if config.MinSize <= 0 {
		config.MinSize = 64
	}
	if config.MaxSize <= 0 {
		config.MaxSize = 16 * 1024 * 1024 // 16MB
	}
	if config.SizeMultiplier <= 1 {
		config.SizeMultiplier = 2
	}
	if config.MaxItemsPerPool <= 0 {
		config.MaxItemsPerPool = 1000
	}
	
	emp := &EnhancedMemoryPool{
		logger:   logger,
		config:   config,
		gcTuner:  NewGCTuner(logger, time.Duration(config.TargetPauseTime)*time.Millisecond),
		pressure: NewMemoryPressureMonitor(logger, uint64(config.MaxMemoryMB)*1024*1024),
	}
	
	// Create size class pools
	emp.createSizeClasses()
	
	// Pre-allocate if requested
	if config.PreAllocate {
		emp.preAllocate()
	}
	
	// Start GC tuning if enabled
	if config.EnableGCTuning {
		emp.gcTuner.Start()
		go emp.gcOptimizationLoop()
	}
	
	// Start monitoring
	if config.EnableStats {
		go emp.statsReporter()
	}
	
	go emp.memoryPressureMonitor()
	
	logger.Info("Enhanced memory pool initialized",
		zap.Int("size_classes", len(emp.pools)),
		zap.Int("min_size", config.MinSize),
		zap.Int("max_size", config.MaxSize),
		zap.Bool("gc_tuning", config.EnableGCTuning),
	)
	
	return emp
}

// Get returns a buffer from the pool
func (emp *EnhancedMemoryPool) Get(size int) *Buffer {
	// Find appropriate size class
	pool := emp.getSizeClassPool(size)
	if pool == nil {
		// Size too large, allocate directly
		emp.stats.misses.Add(1)
		return &Buffer{
			data: make([]byte, size),
		}
	}
	
	// Try to get from pool
	if obj := pool.pool.Get(); obj != nil {
		buffer := obj.(*Buffer)
		buffer.refCount.Store(1)
		buffer.lastUsed.Store(time.Now().UnixNano())
		
		// Resize if needed
		if cap(buffer.data) < size {
			buffer.data = make([]byte, size)
		} else {
			buffer.data = buffer.data[:size]
		}
		
		emp.stats.hits.Add(1)
		pool.inUse.Add(1)
		emp.stats.currentInUse.Add(1)
		
		return buffer
	}
	
	// Allocate new buffer
	emp.stats.misses.Add(1)
	emp.stats.allocations.Add(1)
	pool.allocated.Add(1)
	pool.inUse.Add(1)
	emp.stats.currentInUse.Add(1)
	emp.stats.totalAllocated.Add(uint64(pool.size))
	
	return &Buffer{
		data:     make([]byte, size, pool.size),
		pool:     pool,
		refCount: atomic.Int32{},
		lastUsed: atomic.Int64{},
	}
}

// Put returns a buffer to the pool
func (emp *EnhancedMemoryPool) Put(buffer *Buffer) {
	if buffer == nil || buffer.pool == nil {
		return
	}
	
	// Check reference count
	if buffer.refCount.Add(-1) > 0 {
		return // Still in use
	}
	
	emp.stats.deallocations.Add(1)
	buffer.pool.inUse.Add(-1)
	emp.stats.currentInUse.Add(-1)
	
	// Clear sensitive data
	emp.clearBuffer(buffer.data)
	
	// Check memory pressure
	if emp.pressure.GetLevel() >= PressureHigh {
		// Don't return to pool under high pressure
		return
	}
	
	// Return to pool
	buffer.pool.pool.Put(buffer)
}

// GetStats returns pool statistics
func (emp *EnhancedMemoryPool) GetStats() map[string]interface{} {
	stats := map[string]interface{}{
		"allocations":    emp.stats.allocations.Load(),
		"deallocations":  emp.stats.deallocations.Load(),
		"hits":          emp.stats.hits.Load(),
		"misses":        emp.stats.misses.Load(),
		"hit_rate":      emp.calculateHitRate(),
		"gc_cycles":     emp.stats.gcCycles.Load(),
		"total_allocated": emp.stats.totalAllocated.Load(),
		"current_in_use": emp.stats.currentInUse.Load(),
		"memory_pressure": emp.pressure.GetLevel().String(),
	}
	
	// Add per-size-class stats
	sizeStats := make([]map[string]interface{}, 0, len(emp.pools))
	for _, pool := range emp.pools {
		sizeStats = append(sizeStats, map[string]interface{}{
			"size":      pool.size,
			"allocated": pool.allocated.Load(),
			"in_use":    pool.inUse.Load(),
			"hit_rate":  pool.hitRate.Load(),
		})
	}
	stats["size_classes"] = sizeStats
	
	// Add GC stats
	if emp.config.EnableGCTuning {
		stats["gc_tuning"] = emp.gcTuner.GetStats()
	}
	
	return stats
}

// SetMemoryPressureCallback adds a callback for memory pressure changes
func (emp *EnhancedMemoryPool) SetMemoryPressureCallback(cb PressureCallback) {
	emp.pressure.AddCallback(cb)
}

// Private methods

func (emp *EnhancedMemoryPool) createSizeClasses() {
	size := emp.config.MinSize
	for size <= emp.config.MaxSize {
		pool := &sizeClassPool{
			size: size,
		}
		pool.pool.New = func() interface{} {
			return &Buffer{
				data: make([]byte, 0, pool.size),
				pool: pool,
			}
		}
		pool.hitRate.Store(0.0)
		emp.pools = append(emp.pools, pool)
		
		size = int(float64(size) * emp.config.SizeMultiplier)
	}
}

func (emp *EnhancedMemoryPool) getSizeClassPool(size int) *sizeClassPool {
	// Binary search for appropriate size class
	left, right := 0, len(emp.pools)-1
	
	for left <= right {
		mid := (left + right) / 2
		if emp.pools[mid].size >= size {
			if mid == 0 || emp.pools[mid-1].size < size {
				return emp.pools[mid]
			}
			right = mid - 1
		} else {
			left = mid + 1
		}
	}
	
	// Size too large
	if len(emp.pools) > 0 && emp.pools[len(emp.pools)-1].size < size {
		return nil
	}
	
	return emp.pools[0]
}

func (emp *EnhancedMemoryPool) preAllocate() {
	for _, pool := range emp.pools {
		// Pre-allocate 10% of max items
		count := emp.config.MaxItemsPerPool / 10
		for i := 0; i < count; i++ {
			buffer := &Buffer{
				data: make([]byte, 0, pool.size),
				pool: pool,
			}
			pool.pool.Put(buffer)
			pool.allocated.Add(1)
		}
	}
}

func (emp *EnhancedMemoryPool) clearBuffer(data []byte) {
	// Fast clear using assembly if available
	if len(data) > 0 {
		ptr := unsafe.Pointer(&data[0])
		size := uintptr(len(data))
		memclr(ptr, size)
	}
}

//go:linkname memclr runtime.memclrNoHeapPointers
func memclr(ptr unsafe.Pointer, n uintptr)

func (emp *EnhancedMemoryPool) calculateHitRate() float64 {
	hits := emp.stats.hits.Load()
	total := hits + emp.stats.misses.Load()
	if total == 0 {
		return 0
	}
	return float64(hits) / float64(total) * 100
}

func (emp *EnhancedMemoryPool) gcOptimizationLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	
	for {
		<-ticker.C
		
		// Update pool hit rates
		for _, pool := range emp.pools {
			allocated := pool.allocated.Load()
			inUse := pool.inUse.Load()
			if allocated > 0 {
				hitRate := float64(inUse) / float64(allocated) * 100
				pool.hitRate.Store(hitRate)
			}
		}
		
		// Tune GC based on memory usage
		emp.gcTuner.Tune()
		emp.stats.gcCycles.Add(1)
		
		// Trim pools if under memory pressure
		if emp.pressure.GetLevel() >= PressureModerate {
			emp.trimPools()
		}
	}
}

func (emp *EnhancedMemoryPool) trimPools() {
	for _, pool := range emp.pools {
		// Remove unused buffers
		trimmed := 0
		maxTrim := int(pool.allocated.Load() - pool.inUse.Load()) / 2
		
		for i := 0; i < maxTrim; i++ {
			if obj := pool.pool.Get(); obj != nil {
				// Don't put it back
				pool.allocated.Add(-1)
				trimmed++
			} else {
				break
			}
		}
		
		if trimmed > 0 {
			emp.logger.Debug("Trimmed pool",
				zap.Int("size", pool.size),
				zap.Int("trimmed", trimmed),
			)
		}
	}
}

func (emp *EnhancedMemoryPool) memoryPressureMonitor() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	
	for {
		<-ticker.C
		emp.pressure.Check()
	}
}

func (emp *EnhancedMemoryPool) statsReporter() {
	ticker := time.NewTicker(emp.config.StatsInterval)
	defer ticker.Stop()
	
	for {
		<-ticker.C
		stats := emp.GetStats()
		emp.logger.Info("Memory pool statistics", zap.Any("stats", stats))
	}
}

// GCTuner methods

func NewGCTuner(logger *zap.Logger, targetPause time.Duration) *GCTuner {
	tuner := &GCTuner{
		logger:      logger,
		targetPause: targetPause,
	}
	tuner.gcPercent.Store(100) // Default GOGC
	return tuner
}

func (gt *GCTuner) Start() {
	gt.enabled.Store(true)
	gt.logger.Info("GC tuner started",
		zap.Duration("target_pause", gt.targetPause),
	)
}

func (gt *GCTuner) Tune() {
	if !gt.enabled.Load() {
		return
	}
	
	// Get current memory stats
	runtime.ReadMemStats(&gt.memStats)
	
	// Calculate average pause time
	var totalPause uint64
	numGC := gt.memStats.NumGC
	if numGC > 256 {
		numGC = 256
	}
	for i := 0; i < int(numGC); i++ {
		totalPause += gt.memStats.PauseNs[i]
	}
	avgPause := time.Duration(totalPause / uint64(numGC))
	
	// Adjust GOGC based on pause time
	currentGOGC := gt.gcPercent.Load()
	newGOGC := currentGOGC
	
	if avgPause > gt.targetPause {
		// Pause time too high, increase GOGC to reduce GC frequency
		newGOGC = int32(float64(currentGOGC) * 1.1)
		if newGOGC > 800 {
			newGOGC = 800
		}
	} else if avgPause < gt.targetPause/2 {
		// Can afford more frequent GC for lower memory usage
		newGOGC = int32(float64(currentGOGC) * 0.9)
		if newGOGC < 50 {
			newGOGC = 50
		}
	}
	
	if newGOGC != currentGOGC {
		debug.SetGCPercent(int(newGOGC))
		gt.gcPercent.Store(newGOGC)
		gt.logger.Debug("Adjusted GC percentage",
			zap.Int32("old_gogc", currentGOGC),
			zap.Int32("new_gogc", newGOGC),
			zap.Duration("avg_pause", avgPause),
		)
	}
	
	gt.lastTuneTime.Store(time.Now().Unix())
}

func (gt *GCTuner) GetStats() map[string]interface{} {
	runtime.ReadMemStats(&gt.memStats)
	
	return map[string]interface{}{
		"gc_percent":     gt.gcPercent.Load(),
		"num_gc":        gt.memStats.NumGC,
		"gc_cpu_percent": gt.memStats.GCCPUFraction * 100,
		"heap_alloc_mb":  gt.memStats.HeapAlloc / 1024 / 1024,
		"heap_sys_mb":    gt.memStats.HeapSys / 1024 / 1024,
		"next_gc_mb":     gt.memStats.NextGC / 1024 / 1024,
		"last_tune":      time.Unix(gt.lastTuneTime.Load(), 0),
	}
}

// MemoryPressureMonitor methods

func NewMemoryPressureMonitor(logger *zap.Logger, threshold uint64) *MemoryPressureMonitor {
	mpm := &MemoryPressureMonitor{
		logger:            logger,
		threshold:         threshold,
		criticalThreshold: threshold * 9 / 10, // 90% is critical
		callbacks:         make([]PressureCallback, 0),
	}
	mpm.pressure.Store(PressureNormal)
	return mpm
}

func (mpm *MemoryPressureMonitor) Check() {
	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	
	var newLevel PressureLevel
	used := memStats.Alloc
	
	switch {
	case used >= mpm.criticalThreshold:
		newLevel = PressureCritical
	case used >= mpm.threshold*8/10: // 80%
		newLevel = PressureHigh
	case used >= mpm.threshold*6/10: // 60%
		newLevel = PressureModerate
	default:
		newLevel = PressureNormal
	}
	
	oldLevel := mpm.pressure.Load().(PressureLevel)
	if newLevel != oldLevel {
		mpm.pressure.Store(newLevel)
		mpm.logger.Info("Memory pressure changed",
			zap.String("old", oldLevel.String()),
			zap.String("new", newLevel.String()),
			zap.Uint64("used_mb", used/1024/1024),
			zap.Uint64("threshold_mb", mpm.threshold/1024/1024),
		)
		
		// Notify callbacks
		mpm.mu.RLock()
		callbacks := make([]PressureCallback, len(mpm.callbacks))
		copy(callbacks, mpm.callbacks)
		mpm.mu.RUnlock()
		
		for _, cb := range callbacks {
			go cb(newLevel)
		}
	}
	
	mpm.lastCheck.Store(time.Now().Unix())
}

func (mpm *MemoryPressureMonitor) GetLevel() PressureLevel {
	return mpm.pressure.Load().(PressureLevel)
}

func (mpm *MemoryPressureMonitor) AddCallback(cb PressureCallback) {
	mpm.mu.Lock()
	mpm.callbacks = append(mpm.callbacks, cb)
	mpm.mu.Unlock()
}

func (pl PressureLevel) String() string {
	switch pl {
	case PressureNormal:
		return "normal"
	case PressureModerate:
		return "moderate"
	case PressureHigh:
		return "high"
	case PressureCritical:
		return "critical"
	default:
		return "unknown"
	}
}

// Buffer methods

// AddRef increases the reference count
func (b *Buffer) AddRef() {
	b.refCount.Add(1)
}

// Data returns the buffer data
func (b *Buffer) Data() []byte {
	return b.data
}

// Resize changes the buffer size
func (b *Buffer) Resize(newSize int) error {
	if newSize > cap(b.data) {
		return fmt.Errorf("cannot resize beyond capacity: %d > %d", newSize, cap(b.data))
	}
	b.data = b.data[:newSize]
	return nil
}

// Clear zeros the buffer
func (b *Buffer) Clear() {
	for i := range b.data {
		b.data[i] = 0
	}
}