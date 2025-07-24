/**
 * Advanced Memory Management System
 * 高度なメモリ管理システム
 */

const { EventEmitter } = require('events');
const v8 = require('v8');
const { performance } = require('perf_hooks');

class AdvancedMemoryManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Memory limits
            maxHeapSize: config.maxHeapSize || process.env.NODE_OPTIONS?.match(/--max-old-space-size=(\d+)/)?.[1] || 4096,
            warningThreshold: config.warningThreshold || 0.75,
            criticalThreshold: config.criticalThreshold || 0.85,
            emergencyThreshold: config.emergencyThreshold || 0.95,
            
            // Garbage collection
            gcInterval: config.gcInterval || 300000, // 5 minutes
            aggressiveGcThreshold: config.aggressiveGcThreshold || 0.8,
            enableManualGC: config.enableManualGC !== false && global.gc,
            
            // Memory tracking
            trackingInterval: config.trackingInterval || 5000,
            historySize: config.historySize || 100,
            
            // Object pooling
            enableObjectPooling: config.enableObjectPooling !== false,
            poolConfigs: config.poolConfigs || {},
            
            // Memory leak detection
            enableLeakDetection: config.enableLeakDetection !== false,
            leakDetectionInterval: config.leakDetectionInterval || 60000,
            leakGrowthThreshold: config.leakGrowthThreshold || 0.1, // 10% growth
            
            // Heap snapshots
            enableHeapSnapshots: config.enableHeapSnapshots || false,
            heapSnapshotInterval: config.heapSnapshotInterval || 3600000, // 1 hour
            maxHeapSnapshots: config.maxHeapSnapshots || 5,
            
            ...config
        };
        
        // Memory state
        this.memoryState = {
            level: 'normal', // normal, warning, critical, emergency
            lastGC: Date.now(),
            gcCount: 0,
            leakSuspected: false
        };
        
        // Memory history
        this.memoryHistory = [];
        
        // Object pools
        this.objectPools = new Map();
        
        // Memory pressure handlers
        this.pressureHandlers = {
            warning: [],
            critical: [],
            emergency: []
        };
        
        // Heap snapshots
        this.heapSnapshots = [];
        
        // Initialize
        this.initialize();
    }
    
    initialize() {
        console.log('高度なメモリ管理システムを初期化中...');
        
        // Start memory tracking
        this.startMemoryTracking();
        
        // Start garbage collection management
        if (this.config.enableManualGC) {
            this.startGarbageCollectionManagement();
        }
        
        // Start leak detection
        if (this.config.enableLeakDetection) {
            this.startLeakDetection();
        }
        
        // Initialize object pools
        if (this.config.enableObjectPooling) {
            this.initializeObjectPools();
        }
        
        // Setup heap snapshot scheduling
        if (this.config.enableHeapSnapshots) {
            this.scheduleHeapSnapshots();
        }
        
        // Setup process handlers
        this.setupProcessHandlers();
        
        console.log('✓ メモリ管理システムの初期化完了');
    }
    
    /**
     * Start memory tracking
     */
    startMemoryTracking() {
        this.trackingInterval = setInterval(() => {
            const memoryUsage = this.getDetailedMemoryUsage();
            
            // Add to history
            this.memoryHistory.push({
                timestamp: Date.now(),
                ...memoryUsage
            });
            
            // Maintain history size
            if (this.memoryHistory.length > this.config.historySize) {
                this.memoryHistory.shift();
            }
            
            // Check memory pressure
            this.checkMemoryPressure(memoryUsage);
            
            // Emit metrics
            this.emit('memory-metrics', memoryUsage);
        }, this.config.trackingInterval);
    }
    
    /**
     * Get detailed memory usage
     */
    getDetailedMemoryUsage() {
        const usage = process.memoryUsage();
        const heapStats = v8.getHeapStatistics();
        const heapSpaces = v8.getHeapSpaceStatistics();
        
        return {
            // Process memory
            rss: usage.rss,
            heapTotal: usage.heapTotal,
            heapUsed: usage.heapUsed,
            external: usage.external,
            arrayBuffers: usage.arrayBuffers || 0,
            
            // V8 heap statistics
            totalHeapSize: heapStats.total_heap_size,
            totalHeapSizeExecutable: heapStats.total_heap_size_executable,
            totalPhysicalSize: heapStats.total_physical_size,
            totalAvailableSize: heapStats.total_available_size,
            usedHeapSize: heapStats.used_heap_size,
            heapSizeLimit: heapStats.heap_size_limit,
            mallocedMemory: heapStats.malloced_memory,
            peakMallocedMemory: heapStats.peak_malloced_memory,
            
            // Heap spaces
            heapSpaces: heapSpaces.map(space => ({
                spaceName: space.space_name,
                spaceSize: space.space_size,
                spaceUsedSize: space.space_used_size,
                spaceAvailableSize: space.space_available_size,
                physicalSpaceSize: space.physical_space_size
            })),
            
            // Calculated metrics
            heapUsagePercent: (heapStats.used_heap_size / heapStats.heap_size_limit) * 100,
            externalPercent: (usage.external / usage.heapTotal) * 100
        };
    }
    
    /**
     * Check memory pressure
     */
    checkMemoryPressure(memoryUsage) {
        const heapUsagePercent = memoryUsage.heapUsagePercent / 100;
        const previousLevel = this.memoryState.level;
        
        if (heapUsagePercent >= this.config.emergencyThreshold) {
            this.memoryState.level = 'emergency';
        } else if (heapUsagePercent >= this.config.criticalThreshold) {
            this.memoryState.level = 'critical';
        } else if (heapUsagePercent >= this.config.warningThreshold) {
            this.memoryState.level = 'warning';
        } else {
            this.memoryState.level = 'normal';
        }
        
        // Trigger handlers if level changed
        if (this.memoryState.level !== previousLevel) {
            this.handleMemoryPressureChange(previousLevel, this.memoryState.level);
        }
        
        // Perform aggressive GC if needed
        if (heapUsagePercent >= this.config.aggressiveGcThreshold && this.config.enableManualGC) {
            this.performAggressiveGC();
        }
    }
    
    /**
     * Handle memory pressure level change
     */
    handleMemoryPressureChange(oldLevel, newLevel) {
        console.log(`メモリ圧力レベル変更: ${oldLevel} → ${newLevel}`);
        
        this.emit('memory-pressure-changed', {
            oldLevel,
            newLevel,
            timestamp: Date.now()
        });
        
        // Execute pressure handlers
        if (newLevel !== 'normal' && this.pressureHandlers[newLevel]) {
            for (const handler of this.pressureHandlers[newLevel]) {
                try {
                    handler(newLevel);
                } catch (error) {
                    console.error('メモリ圧力ハンドラーエラー:', error);
                }
            }
        }
        
        // Take automatic actions based on level
        switch (newLevel) {
            case 'emergency':
                this.handleEmergencyMemoryPressure();
                break;
            case 'critical':
                this.handleCriticalMemoryPressure();
                break;
            case 'warning':
                this.handleWarningMemoryPressure();
                break;
        }
    }
    
    /**
     * Handle emergency memory pressure
     */
    handleEmergencyMemoryPressure() {
        console.error('緊急メモリ圧力！即座の対応が必要です。');
        
        // Force garbage collection
        if (this.config.enableManualGC) {
            global.gc(true); // Full GC
        }
        
        // Clear all caches
        this.emit('clear-all-caches', { reason: 'emergency-memory-pressure' });
        
        // Destroy non-essential object pools
        this.destroyNonEssentialPools();
        
        // Request graceful shutdown if still critical
        setTimeout(() => {
            const current = this.getDetailedMemoryUsage();
            if (current.heapUsagePercent / 100 >= this.config.emergencyThreshold) {
                this.emit('request-graceful-shutdown', { 
                    reason: 'sustained-emergency-memory-pressure' 
                });
            }
        }, 5000);
    }
    
    /**
     * Handle critical memory pressure
     */
    handleCriticalMemoryPressure() {
        console.warn('クリティカルメモリ圧力検出');
        
        // Aggressive garbage collection
        if (this.config.enableManualGC) {
            global.gc();
        }
        
        // Reduce cache sizes
        this.emit('reduce-cache-sizes', { factor: 0.5 });
        
        // Pause non-essential operations
        this.emit('pause-non-essential-operations');
    }
    
    /**
     * Handle warning memory pressure
     */
    handleWarningMemoryPressure() {
        console.warn('メモリ使用量警告レベル');
        
        // Suggest garbage collection
        if (this.config.enableManualGC) {
            global.gc();
        }
        
        // Trim caches
        this.emit('trim-caches');
    }
    
    /**
     * Start garbage collection management
     */
    startGarbageCollectionManagement() {
        // Regular GC interval
        this.gcInterval = setInterval(() => {
            const shouldGC = this.shouldPerformGC();
            
            if (shouldGC) {
                this.performScheduledGC();
            }
        }, this.config.gcInterval);
        
        // Monitor GC events
        const obs = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            entries.forEach((entry) => {
                if (entry.entryType === 'gc') {
                    this.handleGCEvent(entry);
                }
            });
        });
        
        obs.observe({ entryTypes: ['gc'] });
    }
    
    /**
     * Determine if GC should be performed
     */
    shouldPerformGC() {
        const timeSinceLastGC = Date.now() - this.memoryState.lastGC;
        const memoryUsage = this.getDetailedMemoryUsage();
        
        // Always GC if memory pressure is high
        if (memoryUsage.heapUsagePercent / 100 >= this.config.warningThreshold) {
            return true;
        }
        
        // GC if enough time has passed
        if (timeSinceLastGC >= this.config.gcInterval) {
            return true;
        }
        
        return false;
    }
    
    /**
     * Perform scheduled garbage collection
     */
    performScheduledGC() {
        const before = process.memoryUsage();
        
        global.gc();
        
        const after = process.memoryUsage();
        const freed = {
            heapUsed: before.heapUsed - after.heapUsed,
            external: before.external - after.external,
            arrayBuffers: (before.arrayBuffers || 0) - (after.arrayBuffers || 0)
        };
        
        this.memoryState.lastGC = Date.now();
        this.memoryState.gcCount++;
        
        this.emit('gc-performed', {
            type: 'scheduled',
            before,
            after,
            freed,
            timestamp: Date.now()
        });
    }
    
    /**
     * Perform aggressive garbage collection
     */
    performAggressiveGC() {
        console.log('アグレッシブGCを実行中...');
        
        const before = process.memoryUsage();
        
        // Multiple GC passes
        for (let i = 0; i < 3; i++) {
            global.gc(true); // Full GC
        }
        
        const after = process.memoryUsage();
        const freed = {
            heapUsed: before.heapUsed - after.heapUsed,
            external: before.external - after.external,
            arrayBuffers: (before.arrayBuffers || 0) - (after.arrayBuffers || 0)
        };
        
        this.memoryState.lastGC = Date.now();
        this.memoryState.gcCount++;
        
        this.emit('gc-performed', {
            type: 'aggressive',
            before,
            after,
            freed,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle GC event from PerformanceObserver
     */
    handleGCEvent(entry) {
        const gcInfo = {
            kind: entry.detail?.kind,
            flags: entry.detail?.flags,
            duration: entry.duration,
            timestamp: entry.startTime
        };
        
        this.emit('gc-event', gcInfo);
    }
    
    /**
     * Start leak detection
     */
    startLeakDetection() {
        let previousHeapUsed = process.memoryUsage().heapUsed;
        let growthCount = 0;
        
        this.leakDetectionInterval = setInterval(() => {
            const currentHeapUsed = process.memoryUsage().heapUsed;
            const growth = (currentHeapUsed - previousHeapUsed) / previousHeapUsed;
            
            if (growth > this.config.leakGrowthThreshold) {
                growthCount++;
                
                if (growthCount >= 3) {
                    // Suspected memory leak
                    this.memoryState.leakSuspected = true;
                    
                    this.emit('memory-leak-suspected', {
                        previousHeapUsed,
                        currentHeapUsed,
                        growth: growth * 100,
                        timestamp: Date.now()
                    });
                    
                    // Take heap snapshot for analysis
                    if (this.config.enableHeapSnapshots) {
                        this.takeHeapSnapshot('leak-detection');
                    }
                }
            } else {
                growthCount = 0;
            }
            
            previousHeapUsed = currentHeapUsed;
        }, this.config.leakDetectionInterval);
    }
    
    /**
     * Initialize object pools
     */
    initializeObjectPools() {
        const defaultPools = {
            buffer: {
                factory: () => Buffer.allocUnsafe(4096),
                reset: (buffer) => buffer.fill(0),
                max: 1000
            },
            array: {
                factory: () => [],
                reset: (array) => { array.length = 0; },
                max: 1000
            },
            object: {
                factory: () => ({}),
                reset: (obj) => { 
                    for (const key in obj) delete obj[key]; 
                },
                max: 1000
            }
        };
        
        // Merge with user-defined pools
        const pools = { ...defaultPools, ...this.config.poolConfigs };
        
        for (const [name, config] of Object.entries(pools)) {
            this.createObjectPool(name, config);
        }
    }
    
    /**
     * Create an object pool
     */
    createObjectPool(name, config) {
        const pool = new ObjectPool(config);
        this.objectPools.set(name, pool);
        
        console.log(`オブジェクトプール作成: ${name} (最大: ${config.max})`);
    }
    
    /**
     * Get object from pool
     */
    acquire(poolName) {
        const pool = this.objectPools.get(poolName);
        if (!pool) {
            throw new Error(`Unknown object pool: ${poolName}`);
        }
        
        return pool.acquire();
    }
    
    /**
     * Return object to pool
     */
    release(poolName, object) {
        const pool = this.objectPools.get(poolName);
        if (!pool) {
            throw new Error(`Unknown object pool: ${poolName}`);
        }
        
        pool.release(object);
    }
    
    /**
     * Destroy non-essential pools
     */
    destroyNonEssentialPools() {
        for (const [name, pool] of this.objectPools) {
            if (!['buffer', 'array', 'object'].includes(name)) {
                pool.clear();
                console.log(`非必須オブジェクトプールを破棄: ${name}`);
            }
        }
    }
    
    /**
     * Schedule heap snapshots
     */
    scheduleHeapSnapshots() {
        this.heapSnapshotInterval = setInterval(() => {
            this.takeHeapSnapshot('scheduled');
        }, this.config.heapSnapshotInterval);
    }
    
    /**
     * Take heap snapshot
     */
    takeHeapSnapshot(reason = 'manual') {
        const filename = `heap-${reason}-${Date.now()}.heapsnapshot`;
        const stream = v8.getHeapSnapshot();
        const fs = require('fs');
        const path = require('path');
        
        // Ensure snapshots directory exists
        const snapshotsDir = path.join(process.cwd(), 'heap-snapshots');
        if (!fs.existsSync(snapshotsDir)) {
            fs.mkdirSync(snapshotsDir, { recursive: true });
        }
        
        const filepath = path.join(snapshotsDir, filename);
        const fileStream = fs.createWriteStream(filepath);
        
        stream.pipe(fileStream);
        
        fileStream.on('finish', () => {
            this.heapSnapshots.push({
                filename,
                filepath,
                reason,
                timestamp: Date.now(),
                size: fs.statSync(filepath).size
            });
            
            // Maintain max snapshots
            if (this.heapSnapshots.length > this.config.maxHeapSnapshots) {
                const oldSnapshot = this.heapSnapshots.shift();
                fs.unlinkSync(oldSnapshot.filepath);
            }
            
            this.emit('heap-snapshot-taken', {
                filename,
                reason,
                timestamp: Date.now()
            });
        });
    }
    
    /**
     * Register memory pressure handler
     */
    registerPressureHandler(level, handler) {
        if (!this.pressureHandlers[level]) {
            throw new Error(`Invalid pressure level: ${level}`);
        }
        
        this.pressureHandlers[level].push(handler);
    }
    
    /**
     * Get memory statistics
     */
    getMemoryStatistics() {
        const current = this.getDetailedMemoryUsage();
        
        // Calculate trends
        const trend = this.calculateMemoryTrend();
        
        return {
            current,
            state: this.memoryState,
            trend,
            history: this.memoryHistory.slice(-10), // Last 10 entries
            objectPools: this.getObjectPoolStatistics()
        };
    }
    
    /**
     * Calculate memory trend
     */
    calculateMemoryTrend() {
        if (this.memoryHistory.length < 2) {
            return { direction: 'stable', rate: 0 };
        }
        
        const recent = this.memoryHistory.slice(-10);
        const first = recent[0];
        const last = recent[recent.length - 1];
        
        const heapChange = last.heapUsed - first.heapUsed;
        const timeChange = last.timestamp - first.timestamp;
        const rate = heapChange / timeChange * 1000; // Bytes per second
        
        return {
            direction: heapChange > 0 ? 'increasing' : heapChange < 0 ? 'decreasing' : 'stable',
            rate,
            percentage: (heapChange / first.heapUsed * 100).toFixed(2)
        };
    }
    
    /**
     * Get object pool statistics
     */
    getObjectPoolStatistics() {
        const stats = {};
        
        for (const [name, pool] of this.objectPools) {
            stats[name] = pool.getStatistics();
        }
        
        return stats;
    }
    
    /**
     * Setup process handlers
     */
    setupProcessHandlers() {
        // Handle process warnings
        process.on('warning', (warning) => {
            if (warning.name === 'MaxListenersExceededWarning') {
                console.warn('最大リスナー数超過警告:', warning);
                this.emit('max-listeners-warning', warning);
            }
        });
        
        // Handle uncaught exceptions related to memory
        process.on('uncaughtException', (error) => {
            if (error.message.includes('out of memory') || 
                error.message.includes('heap out of memory')) {
                console.error('メモリ不足エラー:', error);
                this.emit('out-of-memory', error);
            }
        });
    }
    
    /**
     * Cleanup
     */
    cleanup() {
        // Clear intervals
        if (this.trackingInterval) clearInterval(this.trackingInterval);
        if (this.gcInterval) clearInterval(this.gcInterval);
        if (this.leakDetectionInterval) clearInterval(this.leakDetectionInterval);
        if (this.heapSnapshotInterval) clearInterval(this.heapSnapshotInterval);
        
        // Clear object pools
        for (const pool of this.objectPools.values()) {
            pool.clear();
        }
        
        // Clear history
        this.memoryHistory = [];
    }
}

/**
 * Object Pool implementation
 */
class ObjectPool {
    constructor(config) {
        this.factory = config.factory;
        this.reset = config.reset || (() => {});
        this.max = config.max || 100;
        
        this.available = [];
        this.inUse = new WeakSet();
        
        this.stats = {
            created: 0,
            acquired: 0,
            released: 0,
            recycled: 0
        };
    }
    
    acquire() {
        let object;
        
        if (this.available.length > 0) {
            object = this.available.pop();
            this.stats.recycled++;
        } else {
            object = this.factory();
            this.stats.created++;
        }
        
        this.inUse.add(object);
        this.stats.acquired++;
        
        return object;
    }
    
    release(object) {
        if (!this.inUse.has(object)) {
            return;
        }
        
        this.inUse.delete(object);
        
        if (this.available.length < this.max) {
            this.reset(object);
            this.available.push(object);
        }
        
        this.stats.released++;
    }
    
    clear() {
        this.available = [];
    }
    
    getStatistics() {
        return {
            available: this.available.length,
            maxSize: this.max,
            ...this.stats
        };
    }
}

module.exports = AdvancedMemoryManager;