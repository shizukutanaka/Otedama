// Package optimization provides performance optimization for Otedama
package optimization

import (
	"context"
	"runtime"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// PowerMode represents the power management mode
type PowerMode int

const (
	PowerModeEfficiency PowerMode = iota
	PowerModeBalanced
	PowerModePerformance
	PowerModeTurbo
)

// PerformanceOptimizer manages performance optimizations
type PerformanceOptimizer struct {
	logger *zap.Logger
	
	// Power management
	powerMode     atomic.Int32
	powerProfile  *PowerProfile
	
	// Resource management
	cpuLimit      atomic.Int32
	memoryLimit   atomic.Uint64
	
	// Auto-tuning
	autoTuning    atomic.Bool
	tuningMetrics *TuningMetrics
	
	// Cache optimization
	cacheManager  *CacheManager
	
	// GC optimization
	gcController  *GCController
	
	// Thread pool
	threadPool    *ThreadPool
	
	// Statistics
	stats         *OptimizationStats
	
	// Lifecycle
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
}

// PowerProfile defines power mode characteristics
type PowerProfile struct {
	Name              string
	CPUMultiplier     float64
	MemoryMultiplier  float64
	ThreadMultiplier  float64
	GCPercent         int
	UpdateInterval    time.Duration
}

// TuningMetrics tracks auto-tuning metrics
type TuningMetrics struct {
	Hashrate         atomic.Uint64
	PowerUsage       atomic.Uint64
	Temperature      atomic.Uint64
	Efficiency       atomic.Uint64
	LastAdjustment   atomic.Int64
}

// OptimizationStats tracks optimization statistics
type OptimizationStats struct {
	TuningAdjustments atomic.Uint64
	CacheHits         atomic.Uint64
	CacheMisses       atomic.Uint64
	GCRuns            atomic.Uint64
	ThreadPoolTasks   atomic.Uint64
}

// CacheManager manages various caches
type CacheManager struct {
	l1Cache    *LRUCache
	l2Cache    *LRUCache
	bufferPool *sync.Pool
	stats      *CacheStats
}

// CacheStats tracks cache statistics
type CacheStats struct {
	L1Hits    atomic.Uint64
	L1Misses  atomic.Uint64
	L2Hits    atomic.Uint64
	L2Misses  atomic.Uint64
	Evictions atomic.Uint64
}

// GCController manages garbage collection
type GCController struct {
	targetPercent int
	minInterval   time.Duration
	lastGC        time.Time
	mu            sync.Mutex
}

// ThreadPool manages worker threads
type ThreadPool struct {
	workers   int
	taskQueue chan func()
	wg        sync.WaitGroup
}

// LRUCache implements a simple LRU cache
type LRUCache struct {
	capacity int
	items    map[string]*cacheItem
	order    *cacheList
	mu       sync.RWMutex
}

type cacheItem struct {
	key   string
	value interface{}
	prev  *cacheItem
	next  *cacheItem
}

type cacheList struct {
	head *cacheItem
	tail *cacheItem
}

// Power profiles
var powerProfiles = map[PowerMode]*PowerProfile{
	PowerModeEfficiency: {
		Name:             "Efficiency",
		CPUMultiplier:    0.6,
		MemoryMultiplier: 0.7,
		ThreadMultiplier: 0.5,
		GCPercent:        100,
		UpdateInterval:   30 * time.Second,
	},
	PowerModeBalanced: {
		Name:             "Balanced",
		CPUMultiplier:    0.8,
		MemoryMultiplier: 0.85,
		ThreadMultiplier: 0.75,
		GCPercent:        50,
		UpdateInterval:   15 * time.Second,
	},
	PowerModePerformance: {
		Name:             "Performance",
		CPUMultiplier:    1.0,
		MemoryMultiplier: 1.0,
		ThreadMultiplier: 1.0,
		GCPercent:        25,
		UpdateInterval:   10 * time.Second,
	},
	PowerModeTurbo: {
		Name:             "Turbo",
		CPUMultiplier:    1.2,
		MemoryMultiplier: 1.2,
		ThreadMultiplier: 1.5,
		GCPercent:        10,
		UpdateInterval:   5 * time.Second,
	},
}

// NewPerformanceOptimizer creates a new performance optimizer
func NewPerformanceOptimizer(logger *zap.Logger) *PerformanceOptimizer {
	ctx, cancel := context.WithCancel(context.Background())
	
	po := &PerformanceOptimizer{
		logger:        logger,
		powerProfile:  powerProfiles[PowerModeBalanced],
		tuningMetrics: &TuningMetrics{},
		stats:         &OptimizationStats{},
		ctx:           ctx,
		cancel:        cancel,
	}
	
	// Initialize components
	po.cacheManager = NewCacheManager()
	po.gcController = NewGCController()
	po.threadPool = NewThreadPool(runtime.NumCPU())
	
	// Set default power mode
	po.SetPowerMode(PowerModeBalanced)
	
	return po
}

// Start starts the performance optimizer
func (po *PerformanceOptimizer) Start() error {
	po.logger.Info("Starting performance optimizer")
	
	// Start thread pool
	po.threadPool.Start()
	
	// Start optimization loop
	po.wg.Add(1)
	go po.optimizationLoop()
	
	// Start auto-tuning if enabled
	if po.autoTuning.Load() {
		po.wg.Add(1)
		go po.autoTuneLoop()
	}
	
	po.logger.Info("Performance optimizer started",
		zap.String("power_mode", po.powerProfile.Name))
	
	return nil
}

// Stop stops the performance optimizer
func (po *PerformanceOptimizer) Stop() error {
	po.logger.Info("Stopping performance optimizer")
	
	// Cancel context
	po.cancel()
	
	// Stop thread pool
	po.threadPool.Stop()
	
	// Wait for goroutines
	po.wg.Wait()
	
	po.logger.Info("Performance optimizer stopped")
	return nil
}

// SetPowerMode sets the power management mode
func (po *PerformanceOptimizer) SetPowerMode(mode PowerMode) {
	profile, exists := powerProfiles[mode]
	if !exists {
		return
	}
	
	po.powerMode.Store(int32(mode))
	po.powerProfile = profile
	
	// Apply profile settings
	po.applyPowerProfile(profile)
	
	po.logger.Info("Power mode changed",
		zap.String("mode", profile.Name))
}

// GetPowerMode returns the current power mode
func (po *PerformanceOptimizer) GetPowerMode() PowerMode {
	return PowerMode(po.powerMode.Load())
}

// EnableAutoTuning enables automatic performance tuning
func (po *PerformanceOptimizer) EnableAutoTuning() {
	if po.autoTuning.CompareAndSwap(false, true) {
		po.wg.Add(1)
		go po.autoTuneLoop()
		
		po.logger.Info("Auto-tuning enabled")
	}
}

// DisableAutoTuning disables automatic performance tuning
func (po *PerformanceOptimizer) DisableAutoTuning() {
	po.autoTuning.Store(false)
	po.logger.Info("Auto-tuning disabled")
}

// SetCPULimit sets the CPU usage limit
func (po *PerformanceOptimizer) SetCPULimit(percent int) {
	po.cpuLimit.Store(int32(percent))
	
	// Apply limit
	threads := int(float64(runtime.NumCPU()) * float64(percent) / 100)
	if threads < 1 {
		threads = 1
	}
	runtime.GOMAXPROCS(threads)
	
	po.logger.Info("CPU limit set",
		zap.Int("percent", percent),
		zap.Int("threads", threads))
}

// SetMemoryLimit sets the memory usage limit
func (po *PerformanceOptimizer) SetMemoryLimit(bytes uint64) {
	po.memoryLimit.Store(bytes)
	
	// Apply limit
	debug.SetMemoryLimit(int64(bytes))
	
	po.logger.Info("Memory limit set",
		zap.Uint64("bytes", bytes))
}

// GetStatistics returns optimization statistics
func (po *PerformanceOptimizer) GetStatistics() map[string]interface{} {
	return map[string]interface{}{
		"power_mode":         po.powerProfile.Name,
		"auto_tuning":        po.autoTuning.Load(),
		"cpu_limit":          po.cpuLimit.Load(),
		"memory_limit":       po.memoryLimit.Load(),
		"tuning_adjustments": po.stats.TuningAdjustments.Load(),
		"cache_hits":         po.stats.CacheHits.Load(),
		"cache_misses":       po.stats.CacheMisses.Load(),
		"gc_runs":            po.stats.GCRuns.Load(),
		"thread_pool_tasks":  po.stats.ThreadPoolTasks.Load(),
		"efficiency":         po.tuningMetrics.Efficiency.Load(),
	}
}

// Private methods

func (po *PerformanceOptimizer) applyPowerProfile(profile *PowerProfile) {
	// Set GOMAXPROCS
	threads := int(float64(runtime.NumCPU()) * profile.ThreadMultiplier)
	if threads < 1 {
		threads = 1
	}
	runtime.GOMAXPROCS(threads)
	
	// Set GC percentage
	debug.SetGCPercent(profile.GCPercent)
	
	// Update GC controller
	po.gcController.SetTargetPercent(profile.GCPercent)
	
	po.logger.Debug("Power profile applied",
		zap.String("profile", profile.Name),
		zap.Int("threads", threads),
		zap.Int("gc_percent", profile.GCPercent))
}

func (po *PerformanceOptimizer) optimizationLoop() {
	defer po.wg.Done()
	
	ticker := time.NewTicker(po.powerProfile.UpdateInterval)
	defer ticker.Stop()
	
	for {
		select {
		case <-po.ctx.Done():
			return
		case <-ticker.C:
			po.performOptimizations()
		}
	}
}

func (po *PerformanceOptimizer) performOptimizations() {
	// Run GC if needed
	if po.gcController.ShouldRunGC() {
		runtime.GC()
		po.stats.GCRuns.Add(1)
	}
	
	// Clear caches if memory pressure
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	memLimit := po.memoryLimit.Load()
	if memLimit > 0 && m.Alloc > memLimit*9/10 {
		po.cacheManager.ClearL2()
		po.logger.Debug("Cleared L2 cache due to memory pressure")
	}
	
	// Adjust thread pool size based on load
	// This is simplified - in production, use more sophisticated logic
}

func (po *PerformanceOptimizer) autoTuneLoop() {
	defer po.wg.Done()
	
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	
	for {
		select {
		case <-po.ctx.Done():
			return
		default:
			if !po.autoTuning.Load() {
				return
			}
		}
		
		select {
		case <-ticker.C:
			po.autoTune()
		}
	}
}

func (po *PerformanceOptimizer) autoTune() {
	// Calculate efficiency
	hashrate := po.tuningMetrics.Hashrate.Load()
	powerUsage := po.tuningMetrics.PowerUsage.Load()
	
	if powerUsage > 0 {
		efficiency := (hashrate * 1000) / powerUsage
		po.tuningMetrics.Efficiency.Store(efficiency)
		
		// Adjust power mode based on efficiency
		// This is simplified - in production, use more sophisticated logic
		currentMode := po.GetPowerMode()
		
		if efficiency < 500 && currentMode != PowerModeEfficiency {
			po.SetPowerMode(PowerModeEfficiency)
			po.stats.TuningAdjustments.Add(1)
		} else if efficiency > 1500 && currentMode != PowerModeTurbo {
			po.SetPowerMode(PowerModeTurbo)
			po.stats.TuningAdjustments.Add(1)
		}
	}
	
	po.tuningMetrics.LastAdjustment.Store(time.Now().Unix())
}

// CacheManager implementation

func NewCacheManager() *CacheManager {
	return &CacheManager{
		l1Cache: NewLRUCache(1000),
		l2Cache: NewLRUCache(10000),
		bufferPool: &sync.Pool{
			New: func() interface{} {
				return make([]byte, 4096)
			},
		},
		stats: &CacheStats{},
	}
}

func (cm *CacheManager) Get(key string) (interface{}, bool) {
	// Check L1 cache
	if val, ok := cm.l1Cache.Get(key); ok {
		cm.stats.L1Hits.Add(1)
		return val, true
	}
	cm.stats.L1Misses.Add(1)
	
	// Check L2 cache
	if val, ok := cm.l2Cache.Get(key); ok {
		cm.stats.L2Hits.Add(1)
		// Promote to L1
		cm.l1Cache.Put(key, val)
		return val, true
	}
	cm.stats.L2Misses.Add(1)
	
	return nil, false
}

func (cm *CacheManager) Put(key string, value interface{}) {
	cm.l1Cache.Put(key, value)
	cm.l2Cache.Put(key, value)
}

func (cm *CacheManager) ClearL1() {
	cm.l1Cache.Clear()
}

func (cm *CacheManager) ClearL2() {
	cm.l2Cache.Clear()
}

func (cm *CacheManager) GetBuffer() []byte {
	return cm.bufferPool.Get().([]byte)
}

func (cm *CacheManager) PutBuffer(buf []byte) {
	cm.bufferPool.Put(buf)
}

// GCController implementation

func NewGCController() *GCController {
	return &GCController{
		targetPercent: 50,
		minInterval:   10 * time.Second,
		lastGC:        time.Now(),
	}
}

func (gc *GCController) SetTargetPercent(percent int) {
	gc.mu.Lock()
	defer gc.mu.Unlock()
	gc.targetPercent = percent
}

func (gc *GCController) ShouldRunGC() bool {
	gc.mu.Lock()
	defer gc.mu.Unlock()
	
	// Check minimum interval
	if time.Since(gc.lastGC) < gc.minInterval {
		return false
	}
	
	// Check memory usage
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	
	// Run GC if allocation exceeds threshold
	threshold := uint64(float64(m.NextGC) * float64(gc.targetPercent) / 100)
	if m.Alloc > threshold {
		gc.lastGC = time.Now()
		return true
	}
	
	return false
}

// ThreadPool implementation

func NewThreadPool(workers int) *ThreadPool {
	return &ThreadPool{
		workers:   workers,
		taskQueue: make(chan func(), 1000),
	}
}

func (tp *ThreadPool) Start() {
	for i := 0; i < tp.workers; i++ {
		tp.wg.Add(1)
		go tp.worker()
	}
}

func (tp *ThreadPool) Stop() {
	close(tp.taskQueue)
	tp.wg.Wait()
}

func (tp *ThreadPool) Submit(task func()) {
	select {
	case tp.taskQueue <- task:
	default:
		// Queue full, execute directly
		task()
	}
}

func (tp *ThreadPool) worker() {
	defer tp.wg.Done()
	
	for task := range tp.taskQueue {
		task()
	}
}

// LRUCache implementation

func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity: capacity,
		items:    make(map[string]*cacheItem),
		order:    &cacheList{},
	}
}

func (c *LRUCache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	item, ok := c.items[key]
	c.mu.RUnlock()
	
	if !ok {
		return nil, false
	}
	
	// Move to front
	c.mu.Lock()
	c.moveToFront(item)
	c.mu.Unlock()
	
	return item.value, true
}

func (c *LRUCache) Put(key string, value interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	// Check if exists
	if item, ok := c.items[key]; ok {
		item.value = value
		c.moveToFront(item)
		return
	}
	
	// Add new item
	item := &cacheItem{
		key:   key,
		value: value,
	}
	
	c.items[key] = item
	c.addToFront(item)
	
	// Evict if necessary
	if len(c.items) > c.capacity {
		c.evictLRU()
	}
}

func (c *LRUCache) Clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	
	c.items = make(map[string]*cacheItem)
	c.order = &cacheList{}
}

func (c *LRUCache) moveToFront(item *cacheItem) {
	c.removeFromList(item)
	c.addToFront(item)
}

func (c *LRUCache) addToFront(item *cacheItem) {
	item.next = c.order.head
	item.prev = nil
	
	if c.order.head != nil {
		c.order.head.prev = item
	}
	
	c.order.head = item
	
	if c.order.tail == nil {
		c.order.tail = item
	}
}

func (c *LRUCache) removeFromList(item *cacheItem) {
	if item.prev != nil {
		item.prev.next = item.next
	} else {
		c.order.head = item.next
	}
	
	if item.next != nil {
		item.next.prev = item.prev
	} else {
		c.order.tail = item.prev
	}
}

func (c *LRUCache) evictLRU() {
	if c.order.tail == nil {
		return
	}
	
	item := c.order.tail
	c.removeFromList(item)
	delete(c.items, item.key)
}

// UpdateMetrics updates tuning metrics
func (po *PerformanceOptimizer) UpdateMetrics(hashrate, powerUsage, temperature uint64) {
	po.tuningMetrics.Hashrate.Store(hashrate)
	po.tuningMetrics.PowerUsage.Store(powerUsage)
	po.tuningMetrics.Temperature.Store(temperature)
}
