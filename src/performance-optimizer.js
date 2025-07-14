import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { advancedCache } from './cache-manager.js';
import os from 'os';
import { performance } from 'perf_hooks';

/**
 * Performance Optimizer
 * システムパフォーマンスの自動最適化
 * 
 * Features:
 * - Memory usage optimization
 * - CPU utilization monitoring
 * - Automatic garbage collection tuning
 * - Resource limit management
 * - Performance metrics collection
 */
export class PerformanceOptimizer extends EventEmitter {
  constructor() {
    super();
    this.logger = new Logger('Performance');
    
    // Performance metrics
    this.metrics = {
      memory: {
        used: 0,
        free: 0,
        total: 0,
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        rss: 0
      },
      cpu: {
        usage: 0,
        loadAverage: [0, 0, 0],
        cores: os.cpus().length
      },
      network: {
        connections: 0,
        bandwidth: 0
      },
      operations: {
        miningHashrate: 0,
        dexTransactions: 0,
        p2pMessages: 0
      }
    };
    
    // Optimization settings
    this.settings = {
      memoryThreshold: 0.8, // 80% memory usage threshold
      cpuThreshold: 0.9, // 90% CPU usage threshold
      gcInterval: 300000, // 5 minutes
      metricsInterval: 10000, // 10 seconds
      optimizationInterval: 60000 // 1 minute
    };
    
    // Resource limits
    this.limits = {
      maxMemory: Math.floor(os.totalmem() * 0.8), // 80% of system memory
      maxConnections: 10000,
      maxConcurrentOperations: 1000
    };
    
    // Performance history
    this.history = {
      memory: [],
      cpu: [],
      operations: []
    };
    
    // Optimization strategies
    this.strategies = new Map();
    this.initializeStrategies();
    
    // Start monitoring
    this.startMonitoring();
    
    this.logger.info('Performance optimizer initialized');
  }

  /**
   * Initialize optimization strategies
   */
  initializeStrategies() {
    // Memory optimization strategies
    this.strategies.set('memory:high', {
      name: 'High Memory Usage',
      condition: () => this.metrics.memory.used / this.metrics.memory.total > this.settings.memoryThreshold,
      actions: [
        () => this.forceGarbageCollection(),
        () => this.clearCaches(),
        () => this.reduceBufferSizes(),
        () => this.compactDataStructures()
      ]
    });
    
    // CPU optimization strategies
    this.strategies.set('cpu:high', {
      name: 'High CPU Usage',
      condition: () => this.metrics.cpu.usage > this.settings.cpuThreshold,
      actions: [
        () => this.throttleOperations(),
        () => this.optimizeAlgorithms(),
        () => this.distributeLoad()
      ]
    });
    
    // Network optimization strategies
    this.strategies.set('network:congestion', {
      name: 'Network Congestion',
      condition: () => this.metrics.network.connections > this.limits.maxConnections * 0.9,
      actions: [
        () => this.limitConnections(),
        () => this.compressData(),
        () => this.batchOperations()
      ]
    });
  }

  /**
   * Start performance monitoring
   */
  startMonitoring() {
    // Metrics collection
    this.metricsTimer = setInterval(() => {
      this.collectMetrics();
    }, this.settings.metricsInterval);
    
    // Optimization checks
    this.optimizationTimer = setInterval(() => {
      this.runOptimizations();
    }, this.settings.optimizationInterval);
    
    // Periodic garbage collection
    this.gcTimer = setInterval(() => {
      this.performGarbageCollection();
    }, this.settings.gcInterval);
    
    // Process monitoring
    this.setupProcessMonitoring();
    
    this.logger.info('Performance monitoring started');
  }

  /**
   * Collect performance metrics
   */
  collectMetrics() {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    
    // Memory metrics
    this.metrics.memory = {
      used: totalMem - freeMem,
      free: freeMem,
      total: totalMem,
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss
    };
    
    // CPU metrics
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    this.metrics.cpu.usage = 1 - totalIdle / totalTick;
    this.metrics.cpu.loadAverage = os.loadavg();
    
    // Add to history
    this.addToHistory('memory', this.metrics.memory);
    this.addToHistory('cpu', this.metrics.cpu);
    
    // Emit metrics
    this.emit('metrics', this.metrics);
  }

  /**
   * Run optimization strategies
   */
  runOptimizations() {
    for (const [key, strategy] of this.strategies) {
      if (strategy.condition()) {
        this.logger.info(`Triggering optimization: ${strategy.name}`);
        
        for (const action of strategy.actions) {
          try {
            action();
          } catch (error) {
            this.logger.error(`Optimization action failed: ${error.message}`);
          }
        }
        
        this.emit('optimization', {
          strategy: key,
          name: strategy.name,
          timestamp: Date.now()
        });
      }
    }
  }

  /**
   * Force garbage collection
   */
  forceGarbageCollection() {
    if (global.gc) {
      const before = process.memoryUsage().heapUsed;
      global.gc();
      const after = process.memoryUsage().heapUsed;
      const freed = before - after;
      
      this.logger.debug(`Garbage collection freed ${Math.round(freed / 1024 / 1024)}MB`);
      
      this.emit('gc', {
        before,
        after,
        freed,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Perform scheduled garbage collection
   */
  performGarbageCollection() {
    const heapUsedPercent = process.memoryUsage().heapUsed / process.memoryUsage().heapTotal;
    
    if (heapUsedPercent > 0.7) {
      this.forceGarbageCollection();
    }
  }

  /**
   * Clear caches to free memory
   */
  clearCaches() {
    // Clear advanced cache with memory pressure handling
    if (advancedCache) {
      advancedCache.reduceMemoryUsage();
      this.logger.debug('Triggered cache memory reduction');
    }
    
    // Clear various caches in the system
    if (global.cacheManager) {
      global.cacheManager.clear();
    }
    
    // Clear module cache selectively
    const cacheKeys = Object.keys(require.cache);
    const oldCacheEntries = cacheKeys.filter(key => {
      const module = require.cache[key];
      return module && module.loaded && (Date.now() - module.loaded) > 3600000; // 1 hour
    });
    
    oldCacheEntries.forEach(key => {
      delete require.cache[key];
    });
    
    this.logger.debug(`Cleared ${oldCacheEntries.length} old cache entries`);
  }

  /**
   * Reduce buffer sizes to save memory
   */
  reduceBufferSizes() {
    if (global.bufferPool) {
      global.bufferPool.resize(Math.floor(global.bufferPool.maxSize * 0.8));
    }
    
    // Reduce network buffer sizes
    if (global.stratum) {
      global.stratum.setMaxBufferSize(65536); // 64KB
    }
  }

  /**
   * Compact data structures
   */
  compactDataStructures() {
    // Compact mining share history
    if (global.mining) {
      global.mining.compactShareHistory();
    }
    
    // Compact DEX trading history
    if (global.dex) {
      global.dex.compactTradingHistory();
    }
    
    // Compact P2P peer list
    if (global.p2p) {
      global.p2p.compactPeerList();
    }
    
    // Trigger cache cleanup
    if (advancedCache) {
      advancedCache.cleanup();
    }
  }

  /**
   * Throttle operations to reduce CPU usage
   */
  throttleOperations() {
    // Reduce mining intensity
    if (global.mining) {
      global.mining.setIntensity(Math.floor(global.mining.intensity * 0.9));
    }
    
    // Increase operation delays
    if (global.dex) {
      global.dex.setProcessingDelay(100); // 100ms delay
    }
  }

  /**
   * Optimize algorithms for better performance
   */
  optimizeAlgorithms() {
    // Switch to more efficient algorithms
    if (global.mining) {
      global.mining.enableOptimizations({
        simd: true,
        parallelization: true,
        caching: true
      });
    }
  }

  /**
   * Distribute load across available resources
   */
  distributeLoad() {
    const cpuCount = os.cpus().length;
    
    // Rebalance worker threads
    if (global.workerPool) {
      global.workerPool.setWorkerCount(Math.min(cpuCount, 8));
    }
  }

  /**
   * Limit network connections
   */
  limitConnections() {
    // Reduce max connections
    if (global.stratum) {
      global.stratum.setMaxConnections(Math.floor(this.limits.maxConnections * 0.8));
    }
    
    if (global.p2p) {
      global.p2p.setMaxPeers(Math.floor(global.p2p.maxPeers * 0.8));
    }
  }

  /**
   * Enable data compression
   */
  compressData() {
    // Enable compression for network communications
    if (global.stratum) {
      global.stratum.enableCompression(true);
    }
    
    if (global.api) {
      global.api.enableCompression(true);
    }
  }

  /**
   * Batch operations for efficiency
   */
  batchOperations() {
    // Enable batching for various operations
    if (global.db) {
      global.db.enableBatching(true);
      global.db.setBatchSize(100);
    }
    
    if (global.paymentManager) {
      global.paymentManager.enableBatchPayments(true);
    }
  }

  /**
   * Setup process monitoring
   */
  setupProcessMonitoring() {
    // Monitor uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception:', error);
      this.emit('error', {
        type: 'uncaughtException',
        error: error.message,
        stack: error.stack
      });
    });
    
    // Monitor unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection:', reason);
      this.emit('error', {
        type: 'unhandledRejection',
        reason,
        promise
      });
    });
    
    // Monitor warning events
    process.on('warning', (warning) => {
      this.logger.warn('Process warning:', warning);
      this.emit('warning', warning);
    });
    
    // Monitor cache performance
    if (advancedCache) {
      advancedCache.on('memoryPressure', (data) => {
        this.logger.warn('Cache memory pressure:', data);
        this.forceGarbageCollection();
      });
    }
  }

  /**
   * Add metrics to history
   */
  addToHistory(type, data) {
    if (!this.history[type]) {
      this.history[type] = [];
    }
    
    this.history[type].push({
      ...data,
      timestamp: Date.now()
    });
    
    // Keep only last hour of data
    const oneHourAgo = Date.now() - 3600000;
    this.history[type] = this.history[type].filter(item => item.timestamp > oneHourAgo);
  }

  /**
   * Get performance report
   */
  getPerformanceReport() {
    const report = {
      current: this.metrics,
      limits: this.limits,
      history: {
        memory: this.getAverageMetrics('memory'),
        cpu: this.getAverageMetrics('cpu')
      },
      optimizations: {
        gcRuns: this.gcRuns || 0,
        cacheClears: this.cacheClears || 0,
        throttles: this.throttles || 0
      },
      cache: advancedCache ? advancedCache.getStats() : null,
      recommendations: this.getRecommendations()
    };
    
    return report;
  }

  /**
   * Get average metrics from history
   */
  getAverageMetrics(type) {
    const history = this.history[type] || [];
    if (history.length === 0) return null;
    
    const sum = history.reduce((acc, item) => {
      Object.keys(item).forEach(key => {
        if (typeof item[key] === 'number') {
          acc[key] = (acc[key] || 0) + item[key];
        }
      });
      return acc;
    }, {});
    
    Object.keys(sum).forEach(key => {
      sum[key] = sum[key] / history.length;
    });
    
    return sum;
  }

  /**
   * Get performance recommendations
   */
  getRecommendations() {
    const recommendations = [];
    
    // Memory recommendations
    if (this.metrics.memory.used / this.metrics.memory.total > 0.8) {
      recommendations.push({
        type: 'memory',
        severity: 'high',
        message: 'High memory usage detected. Consider increasing system memory or reducing concurrent operations.'
      });
    }
    
    // CPU recommendations
    if (this.metrics.cpu.usage > 0.9) {
      recommendations.push({
        type: 'cpu',
        severity: 'high',
        message: 'High CPU usage detected. Consider reducing mining intensity or upgrading hardware.'
      });
    }
    
    // Network recommendations
    if (this.metrics.network.connections > this.limits.maxConnections * 0.8) {
      recommendations.push({
        type: 'network',
        severity: 'medium',
        message: 'High connection count. Consider increasing connection limits or implementing connection pooling.'
      });
    }
    
    return recommendations;
  }

  /**
   * Set custom limits
   */
  setLimits(limits) {
    Object.assign(this.limits, limits);
    this.logger.info('Performance limits updated:', this.limits);
  }

  /**
   * Enable performance profiling
   */
  enableProfiling() {
    this.profiling = true;
    this.profileData = {
      operations: new Map(),
      slowOperations: []
    };
    
    this.logger.info('Performance profiling enabled');
  }

  /**
   * Profile an operation
   */
  async profileOperation(name, operation) {
    if (!this.profiling) {
      return await operation();
    }
    
    const start = performance.now();
    
    try {
      const result = await operation();
      const duration = performance.now() - start;
      
      // Track operation metrics
      if (!this.profileData.operations.has(name)) {
        this.profileData.operations.set(name, {
          count: 0,
          totalTime: 0,
          avgTime: 0,
          minTime: Infinity,
          maxTime: 0
        });
      }
      
      const stats = this.profileData.operations.get(name);
      stats.count++;
      stats.totalTime += duration;
      stats.avgTime = stats.totalTime / stats.count;
      stats.minTime = Math.min(stats.minTime, duration);
      stats.maxTime = Math.max(stats.maxTime, duration);
      
      // Track slow operations
      if (duration > 100) { // 100ms threshold
        this.profileData.slowOperations.push({
          name,
          duration,
          timestamp: Date.now()
        });
        
        // Keep only last 100 slow operations
        if (this.profileData.slowOperations.length > 100) {
          this.profileData.slowOperations.shift();
        }
      }
      
      return result;
      
    } catch (error) {
      const duration = performance.now() - start;
      this.logger.error(`Operation ${name} failed after ${duration}ms:`, error);
      throw error;
    }
  }

  /**
   * Get profiling report
   */
  getProfilingReport() {
    if (!this.profiling) {
      return { enabled: false };
    }
    
    const report = {
      enabled: true,
      operations: {},
      slowOperations: this.profileData.slowOperations,
      recommendations: []
    };
    
    // Convert operations map to object
    for (const [name, stats] of this.profileData.operations) {
      report.operations[name] = {
        ...stats,
        avgTime: Math.round(stats.avgTime * 100) / 100,
        minTime: Math.round(stats.minTime * 100) / 100,
        maxTime: Math.round(stats.maxTime * 100) / 100
      };
      
      // Add recommendations for slow operations
      if (stats.avgTime > 50) {
        report.recommendations.push({
          operation: name,
          message: `Operation "${name}" is slow (avg: ${stats.avgTime.toFixed(2)}ms). Consider optimization.`
        });
      }
    }
    
    return report;
  }

  /**
   * Stop performance monitoring
   */
  stop() {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    
    if (this.optimizationTimer) {
      clearInterval(this.optimizationTimer);
    }
    
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
    }
    
    this.logger.info('Performance optimizer stopped');
  }
}
