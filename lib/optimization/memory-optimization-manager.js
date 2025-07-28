const { EventEmitter } = require('events');
const v8 = require('v8');
const os = require('os');

class MemoryOptimizationManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            gcInterval: options.gcInterval || 60000,
            heapSnapshotInterval: options.heapSnapshotInterval || 300000,
            memoryThreshold: options.memoryThreshold || 0.85,
            cacheSize: options.cacheSize || 100 * 1024 * 1024, // 100MB
            compressionEnabled: options.compressionEnabled !== false,
            ...options
        };
        
        this.memoryPools = new Map();
        this.caches = new Map();
        this.heapSnapshots = [];
        this.isOptimizing = false;
    }

    async initialize() {
        this.setupMemoryPools();
        this.startMemoryMonitoring();
        this.startGarbageCollection();
        
        this.emit('initialized');
    }

    setupMemoryPools() {
        // Create typed array pools
        const sizes = [1024, 4096, 16384, 65536, 262144, 1048576];
        
        sizes.forEach(size => {
            this.memoryPools.set(size, {
                buffers: [],
                inUse: new Set(),
                allocated: 0,
                maxPoolSize: 10
            });
        });
    }

    allocate(size) {
        const poolSize = this.findPoolSize(size);
        const pool = this.memoryPools.get(poolSize);
        
        if (pool && pool.buffers.length > 0) {
            const buffer = pool.buffers.pop();
            pool.inUse.add(buffer);
            return buffer.slice(0, size);
        }
        
        const buffer = Buffer.allocUnsafe(poolSize);
        if (pool) {
            pool.inUse.add(buffer);
            pool.allocated++;
        }
        
        return buffer.slice(0, size);
    }

    free(buffer) {
        const size = this.findPoolSize(buffer.length);
        const pool = this.memoryPools.get(size);
        
        if (pool && pool.inUse.has(buffer)) {
            pool.inUse.delete(buffer);
            
            if (pool.buffers.length < pool.maxPoolSize) {
                buffer.fill(0); // Clear sensitive data
                pool.buffers.push(buffer);
            }
        }
    }

    findPoolSize(size) {
        for (const [poolSize] of this.memoryPools) {
            if (size <= poolSize) return poolSize;
        }
        return size;
    }

    startMemoryMonitoring() {
        this.monitoringInterval = setInterval(() => {
            const stats = this.getMemoryStats();
            this.emit('memory:stats', stats);
            
            if (stats.heapUsedPercent > this.config.memoryThreshold) {
                this.optimizeMemory();
            }
        }, 5000);
    }

    getMemoryStats() {
        const memUsage = process.memoryUsage();
        const heapStats = v8.getHeapStatistics();
        const osFreeMem = os.freemem();
        const osTotalMem = os.totalmem();
        
        return {
            rss: memUsage.rss,
            heapTotal: memUsage.heapTotal,
            heapUsed: memUsage.heapUsed,
            external: memUsage.external,
            arrayBuffers: memUsage.arrayBuffers,
            heapUsedPercent: memUsage.heapUsed / heapStats.heap_size_limit,
            heapSizeLimit: heapStats.heap_size_limit,
            totalHeapSize: heapStats.total_heap_size,
            totalHeapSizeExecutable: heapStats.total_heap_size_executable,
            totalPhysicalSize: heapStats.total_physical_size,
            totalAvailableSize: heapStats.total_available_size,
            mallocedMemory: heapStats.malloced_memory,
            peakMallocedMemory: heapStats.peak_malloced_memory,
            doesZapGarbage: heapStats.does_zap_garbage,
            numberOfNativeContexts: heapStats.number_of_native_contexts,
            numberOfDetachedContexts: heapStats.number_of_detached_contexts,
            osFreeMem,
            osTotalMem,
            osFreeMemPercent: osFreeMem / osTotalMem
        };
    }

    async optimizeMemory() {
        if (this.isOptimizing) return;
        
        this.isOptimizing = true;
        this.emit('optimization:start');
        
        try {
            // Clear unused caches
            this.clearUnusedCaches();
            
            // Compact memory pools
            this.compactMemoryPools();
            
            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }
            
            // Trim heap if needed
            await this.trimHeap();
            
            this.emit('optimization:complete');
        } finally {
            this.isOptimizing = false;
        }
    }

    clearUnusedCaches() {
        const now = Date.now();
        
        for (const [key, cache] of this.caches) {
            if (now - cache.lastAccess > 60000) { // 1 minute
                this.caches.delete(key);
            }
        }
    }

    compactMemoryPools() {
        for (const [size, pool] of this.memoryPools) {
            // Remove excess buffers
            while (pool.buffers.length > pool.maxPoolSize / 2) {
                pool.buffers.pop();
            }
            
            // Adjust pool size based on usage
            const usageRatio = pool.inUse.size / (pool.buffers.length + pool.inUse.size);
            if (usageRatio > 0.8) {
                pool.maxPoolSize = Math.min(pool.maxPoolSize * 1.5, 50);
            } else if (usageRatio < 0.2) {
                pool.maxPoolSize = Math.max(pool.maxPoolSize * 0.7, 5);
            }
        }
    }

    async trimHeap() {
        const stats = v8.getHeapStatistics();
        const usagePercent = stats.used_heap_size / stats.heap_size_limit;
        
        if (usagePercent > 0.9) {
            // Create heap snapshot for analysis
            if (this.config.heapSnapshotInterval) {
                await this.createHeapSnapshot();
            }
            
            // Clear WeakMaps and WeakSets
            this.clearWeakReferences();
        }
    }

    clearWeakReferences() {
        // This is a placeholder - actual implementation would
        // need to track WeakMaps/WeakSets in the application
    }

    async createHeapSnapshot() {
        const snapshot = v8.writeHeapSnapshot();
        
        this.heapSnapshots.push({
            timestamp: Date.now(),
            filename: snapshot,
            stats: this.getMemoryStats()
        });
        
        // Keep only recent snapshots
        while (this.heapSnapshots.length > 5) {
            this.heapSnapshots.shift();
        }
        
        this.emit('heap:snapshot', snapshot);
    }

    startGarbageCollection() {
        this.gcInterval = setInterval(() => {
            if (global.gc && this.shouldRunGC()) {
                const before = process.memoryUsage().heapUsed;
                global.gc();
                const after = process.memoryUsage().heapUsed;
                
                this.emit('gc:complete', {
                    freed: before - after,
                    heapUsed: after
                });
            }
        }, this.config.gcInterval);
    }

    shouldRunGC() {
        const stats = this.getMemoryStats();
        return stats.heapUsedPercent > 0.7 || stats.osFreeMemPercent < 0.1;
    }

    createCache(name, options = {}) {
        const cache = new MemoryEfficientCache({
            maxSize: options.maxSize || 1000,
            ttl: options.ttl || 3600000,
            compression: this.config.compressionEnabled,
            ...options
        });
        
        this.caches.set(name, cache);
        return cache;
    }

    getCache(name) {
        return this.caches.get(name);
    }

    stop() {
        if (this.monitoringInterval) clearInterval(this.monitoringInterval);
        if (this.gcInterval) clearInterval(this.gcInterval);
        
        // Clear all caches
        this.caches.clear();
        
        // Free all pooled memory
        for (const [_, pool] of this.memoryPools) {
            pool.buffers = [];
            pool.inUse.clear();
        }
        
        this.emit('stopped');
    }
}

class MemoryEfficientCache {
    constructor(options) {
        this.maxSize = options.maxSize;
        this.ttl = options.ttl;
        this.compression = options.compression;
        this.cache = new Map();
        this.accessOrder = [];
        this.lastAccess = Date.now();
    }

    set(key, value) {
        this.lastAccess = Date.now();
        
        let storedValue = value;
        if (this.compression && Buffer.isBuffer(value)) {
            storedValue = this.compress(value);
        }
        
        if (this.cache.has(key)) {
            this.updateAccessOrder(key);
        } else {
            if (this.cache.size >= this.maxSize) {
                this.evictLRU();
            }
            this.accessOrder.push(key);
        }
        
        this.cache.set(key, {
            value: storedValue,
            timestamp: Date.now(),
            compressed: this.compression && Buffer.isBuffer(value)
        });
    }

    get(key) {
        this.lastAccess = Date.now();
        
        const entry = this.cache.get(key);
        if (!entry) return null;
        
        if (this.ttl && Date.now() - entry.timestamp > this.ttl) {
            this.delete(key);
            return null;
        }
        
        this.updateAccessOrder(key);
        
        if (entry.compressed) {
            return this.decompress(entry.value);
        }
        
        return entry.value;
    }

    delete(key) {
        this.cache.delete(key);
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
            this.accessOrder.splice(index, 1);
        }
    }

    updateAccessOrder(key) {
        const index = this.accessOrder.indexOf(key);
        if (index > -1) {
            this.accessOrder.splice(index, 1);
        }
        this.accessOrder.push(key);
    }

    evictLRU() {
        const lru = this.accessOrder.shift();
        if (lru) {
            this.cache.delete(lru);
        }
    }

    compress(buffer) {
        const zlib = require('zlib');
        return zlib.gzipSync(buffer);
    }

    decompress(buffer) {
        const zlib = require('zlib');
        return zlib.gunzipSync(buffer);
    }

    clear() {
        this.cache.clear();
        this.accessOrder = [];
    }

    get size() {
        return this.cache.size;
    }
}

module.exports = MemoryOptimizationManager;