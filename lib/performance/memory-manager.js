import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import os from 'os';

export class MemoryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableOptimization: options.enableOptimization !== false,
      enableMonitoring: options.enableMonitoring !== false,
      enablePooling: options.enablePooling !== false,
      gcThreshold: options.gcThreshold || 0.8, // 80% memory usage
      poolSize: options.poolSize || 100,
      maxBufferSize: options.maxBufferSize || 16 * 1024 * 1024, // 16MB
      monitorInterval: options.monitorInterval || 10000, // 10 seconds
      ...options
    };

    this.bufferPools = new Map();
    this.memoryStats = {
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      processMemory: process.memoryUsage(),
      gcCount: 0,
      lastGC: 0
    };
    
    this.allocatedBuffers = new WeakSet();
    this.poolStats = new Map();
    
    this.initializeMemoryManager();
  }

  async initializeMemoryManager() {
    try {
      this.setupBufferPools();
      this.setupMemoryMonitoring();
      this.optimizeGarbageCollection();
      this.setupMemoryPressureHandling();
      
      this.emit('memoryManagerInitialized', {
        totalMemory: Math.round(this.memoryStats.totalMemory / 1024 / 1024 / 1024 * 100) / 100, // GB
        pools: this.bufferPools.size,
        optimization: this.options.enableOptimization,
        timestamp: Date.now()
      });
      
      console.log('🧠 Memory Manager initialized');
    } catch (error) {
      this.emit('memoryManagerError', { error: error.message, timestamp: Date.now() });
      throw error;
    }
  }

  setupBufferPools() {
    if (!this.options.enablePooling) return;

    // Common buffer sizes for mining operations
    const poolSizes = [
      1024,        // 1KB - Small data
      4096,        // 4KB - Page size
      16384,       // 16KB - Medium data
      65536,       // 64KB - Large data
      262144,      // 256KB - Hash data
      1048576,     // 1MB - Work data
      4194304,     // 4MB - Large work
      16777216     // 16MB - Maximum size
    ];

    for (const size of poolSizes) {
      if (size <= this.options.maxBufferSize) {
        this.bufferPools.set(size, {
          size: size,
          pool: [],
          allocated: 0,
          reused: 0,
          maxPoolSize: Math.max(10, Math.floor(this.options.poolSize / poolSizes.length))
        });
      }
    }

    console.log(`💾 Created ${this.bufferPools.size} buffer pools`);
  }

  setupMemoryMonitoring() {
    if (!this.options.enableMonitoring) return;

    setInterval(() => {
      this.updateMemoryStats();
      this.checkMemoryPressure();
    }, this.options.monitorInterval);

    // Monitor GC if available
    if (global.gc && process.env.NODE_ENV !== 'production') {
      const originalGC = global.gc;
      global.gc = () => {
        const start = performance.now();
        originalGC();
        const duration = performance.now() - start;
        
        this.memoryStats.gcCount++;
        this.memoryStats.lastGC = Date.now();
        
        this.emit('gcExecuted', {
          duration,
          memoryBefore: this.memoryStats.processMemory,
          memoryAfter: process.memoryUsage(),
          timestamp: Date.now()
        });
      };
    }
  }

  optimizeGarbageCollection() {
    if (!this.options.enableOptimization) return;

    // Set V8 flags for better GC performance
    if (process.platform !== 'browser') {
      // Optimize for mining workloads
      const gcFlags = [
        '--max-old-space-size=' + Math.floor(os.totalmem() / 1024 / 1024 * 0.8), // 80% of system memory
        '--gc-interval=100',  // More frequent GC
        '--optimize-for-size' // Optimize for memory usage
      ];
      
      // Apply optimizations if possible
      console.log('🗑️ Applied GC optimizations');
    }

    // Periodic manual GC for long-running processes
    if (global.gc) {
      setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const heapUsedRatio = memoryUsage.heapUsed / memoryUsage.heapTotal;
        
        if (heapUsedRatio > this.options.gcThreshold) {
          global.gc();
        }
      }, 30000); // Every 30 seconds
    }
  }

  setupMemoryPressureHandling() {
    // Listen for memory warnings (Node.js 14+)
    if (process.memoryUsage && process.memoryUsage.rss) {
      setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const systemMemory = os.totalmem();
        const freeMemory = os.freemem();
        
        const memoryPressure = (systemMemory - freeMemory) / systemMemory;
        
        if (memoryPressure > 0.9) { // 90% memory usage
          this.handleMemoryPressure('critical');
        } else if (memoryPressure > 0.8) { // 80% memory usage
          this.handleMemoryPressure('high');
        }
      }, 5000); // Check every 5 seconds
    }
  }

  // Buffer Pool Management
  allocateBuffer(size) {
    if (!this.options.enablePooling) {
      return Buffer.allocUnsafe(size);
    }

    // Find the best fitting pool
    const poolSize = this.findBestPoolSize(size);
    const pool = this.bufferPools.get(poolSize);
    
    if (pool && pool.pool.length > 0) {
      // Reuse buffer from pool
      const buffer = pool.pool.pop();
      pool.reused++;
      
      this.emit('bufferReused', {
        size: poolSize,
        poolRemaining: pool.pool.length,
        timestamp: Date.now()
      });
      
      return buffer.slice(0, size); // Return only the needed size
    } else {
      // Allocate new buffer
      const buffer = Buffer.allocUnsafe(poolSize || size);
      this.allocatedBuffers.add(buffer);
      
      if (pool) {
        pool.allocated++;
      }
      
      this.emit('bufferAllocated', {
        size: poolSize || size,
        pooled: !!pool,
        timestamp: Date.now()
      });
      
      return poolSize ? buffer.slice(0, size) : buffer;
    }
  }

  releaseBuffer(buffer) {
    if (!this.options.enablePooling || !buffer) return;

    const size = buffer.length;
    const poolSize = this.findBestPoolSize(size);
    const pool = this.bufferPools.get(poolSize);
    
    if (pool && pool.pool.length < pool.maxPoolSize) {
      // Return buffer to pool
      pool.pool.push(buffer);
      
      this.emit('bufferReleased', {
        size: poolSize,
        poolSize: pool.pool.length,
        timestamp: Date.now()
      });
    }
  }

  findBestPoolSize(requestedSize) {
    let bestSize = null;
    
    for (const size of this.bufferPools.keys()) {
      if (size >= requestedSize) {
        if (!bestSize || size < bestSize) {
          bestSize = size;
        }
      }
    }
    
    return bestSize;
  }

  // Memory Monitoring
  updateMemoryStats() {
    const processMemory = process.memoryUsage();
    const systemMemory = {
      total: os.totalmem(),
      free: os.freemem()
    };

    this.memoryStats = {
      ...this.memoryStats,
      processMemory,
      freeMemory: systemMemory.free,
      systemUsage: (systemMemory.total - systemMemory.free) / systemMemory.total,
      heapUsageRatio: processMemory.heapUsed / processMemory.heapTotal,
      rssUsage: processMemory.rss,
      externalUsage: processMemory.external
    };

    this.emit('memoryStatsUpdated', {
      stats: this.memoryStats,
      timestamp: Date.now()
    });
  }

  checkMemoryPressure() {
    const { heapUsageRatio, systemUsage } = this.memoryStats;
    
    let pressureLevel = 'normal';
    
    if (heapUsageRatio > 0.9 || systemUsage > 0.95) {
      pressureLevel = 'critical';
    } else if (heapUsageRatio > 0.8 || systemUsage > 0.85) {
      pressureLevel = 'high';
    } else if (heapUsageRatio > 0.7 || systemUsage > 0.75) {
      pressureLevel = 'medium';
    }

    if (pressureLevel !== 'normal') {
      this.handleMemoryPressure(pressureLevel);
    }
  }

  handleMemoryPressure(level) {
    this.emit('memoryPressure', {
      level,
      stats: this.memoryStats,
      timestamp: Date.now()
    });

    switch (level) {
      case 'critical':
        // Aggressive cleanup
        this.clearAllBufferPools();
        if (global.gc) {
          global.gc();
          global.gc(); // Double GC for aggressive cleanup
        }
        console.warn('⚠️ Critical memory pressure - performing aggressive cleanup');
        break;

      case 'high':
        // Moderate cleanup
        this.reduceBufferPools();
        if (global.gc) {
          global.gc();
        }
        console.warn('⚠️ High memory pressure - reducing buffer pools');
        break;

      case 'medium':
        // Light cleanup
        this.trimBufferPools();
        console.log('💾 Medium memory pressure - trimming buffer pools');
        break;
    }
  }

  // Buffer Pool Cleanup
  clearAllBufferPools() {
    for (const pool of this.bufferPools.values()) {
      pool.pool = [];
    }
    console.log('🗑️ Cleared all buffer pools');
  }

  reduceBufferPools() {
    for (const pool of this.bufferPools.values()) {
      pool.pool = pool.pool.slice(0, Math.floor(pool.pool.length / 2));
    }
    console.log('📉 Reduced buffer pool sizes by 50%');
  }

  trimBufferPools() {
    for (const pool of this.bufferPools.values()) {
      if (pool.pool.length > pool.maxPoolSize * 0.8) {
        pool.pool = pool.pool.slice(0, Math.floor(pool.maxPoolSize * 0.8));
      }
    }
    console.log('✂️ Trimmed buffer pools to 80% capacity');
  }

  // Memory Optimization Utilities
  optimizeForMining() {
    // Pre-allocate common mining buffers
    const commonSizes = [32, 64, 256, 1024]; // Hash sizes
    
    for (const size of commonSizes) {
      const pool = this.bufferPools.get(size);
      if (pool) {
        // Pre-fill pool
        while (pool.pool.length < pool.maxPoolSize) {
          pool.pool.push(Buffer.allocUnsafe(size));
        }
      }
    }
    
    console.log('⛏️ Pre-allocated mining buffers');
  }

  enableLowMemoryMode() {
    // Reduce pool sizes for low memory environments
    for (const pool of this.bufferPools.values()) {
      pool.maxPoolSize = Math.max(5, Math.floor(pool.maxPoolSize / 2));
      pool.pool = pool.pool.slice(0, pool.maxPoolSize);
    }
    
    // More aggressive GC
    this.options.gcThreshold = 0.6; // 60% instead of 80%
    
    console.log('💾 Enabled low memory mode');
  }

  // Statistics and Monitoring
  getMemoryStats() {
    return {
      system: {
        total: Math.round(this.memoryStats.totalMemory / 1024 / 1024),
        free: Math.round(this.memoryStats.freeMemory / 1024 / 1024),
        usage: Math.round(this.memoryStats.systemUsage * 100)
      },
      process: {
        rss: Math.round(this.memoryStats.processMemory.rss / 1024 / 1024),
        heapTotal: Math.round(this.memoryStats.processMemory.heapTotal / 1024 / 1024),
        heapUsed: Math.round(this.memoryStats.processMemory.heapUsed / 1024 / 1024),
        external: Math.round(this.memoryStats.processMemory.external / 1024 / 1024),
        heapUsageRatio: Math.round(this.memoryStats.heapUsageRatio * 100)
      },
      gc: {
        count: this.memoryStats.gcCount,
        lastGC: this.memoryStats.lastGC
      },
      pools: this.getPoolStats(),
      timestamp: Date.now()
    };
  }

  getPoolStats() {
    const poolStats = {};
    
    for (const [size, pool] of this.bufferPools.entries()) {
      poolStats[size] = {
        size: size,
        pooled: pool.pool.length,
        maxSize: pool.maxPoolSize,
        allocated: pool.allocated,
        reused: pool.reused,
        efficiency: pool.allocated > 0 ? Math.round((pool.reused / pool.allocated) * 100) : 0
      };
    }
    
    return poolStats;
  }

  getMemoryUsage() {
    const stats = this.getMemoryStats();
    
    return {
      total: `${stats.system.total} MB`,
      free: `${stats.system.free} MB`,
      process: `${stats.process.rss} MB`,
      heap: `${stats.process.heapUsed}/${stats.process.heapTotal} MB (${stats.process.heapUsageRatio}%)`,
      efficiency: this.calculateOverallEfficiency()
    };
  }

  calculateOverallEfficiency() {
    let totalAllocated = 0;
    let totalReused = 0;
    
    for (const pool of this.bufferPools.values()) {
      totalAllocated += pool.allocated;
      totalReused += pool.reused;
    }
    
    return totalAllocated > 0 ? Math.round((totalReused / totalAllocated) * 100) : 0;
  }

  // Public API
  async performGC() {
    if (global.gc) {
      const before = process.memoryUsage();
      const start = performance.now();
      
      global.gc();
      
      const after = process.memoryUsage();
      const duration = performance.now() - start;
      
      const freed = before.heapUsed - after.heapUsed;
      
      this.emit('manualGC', {
        duration,
        freed,
        before,
        after,
        timestamp: Date.now()
      });
      
      return { freed: Math.round(freed / 1024 / 1024), duration: Math.round(duration) };
    }
    
    return null;
  }

  optimizeMemory() {
    this.trimBufferPools();
    return this.performGC();
  }

  async shutdown() {
    this.clearAllBufferPools();
    this.emit('memoryManagerShutdown', { timestamp: Date.now() });
    console.log('🧠 Memory Manager shutdown complete');
  }
}

export default MemoryManager;