/**
 * GC Optimizer - Otedama v1.1.8
 * ガベージコレクション最適化エンジン
 * 
 * Features:
 * - Predictive GC triggering
 * - Memory pressure detection
 * - Object lifecycle management
 * - Heap fragmentation prevention
 * - Generational GC optimization
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';
import v8 from 'v8';
import os from 'os';

const logger = createStructuredLogger('GCOptimizer');

/**
 * Memory pressure detector
 */
export class MemoryPressureDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      checkInterval: options.checkInterval || 5000, // 5 seconds
      warningThreshold: options.warningThreshold || 0.8, // 80% memory usage
      criticalThreshold: options.criticalThreshold || 0.9, // 90% memory usage
      heapGrowthThreshold: options.heapGrowthThreshold || 0.1, // 10% growth
      ...options
    };
    
    this.lastHeapUsed = 0;
    this.pressureLevel = 'normal'; // normal, warning, critical
    this.history = [];
    this.maxHistory = 20;
    
    this.stats = {
      warningEvents: 0,
      criticalEvents: 0,
      totalChecks: 0,
      avgMemoryUsage: 0
    };
  }
  
  /**
   * Start memory pressure monitoring
   */
  start() {
    this.timer = setInterval(() => {
      this.checkMemoryPressure();
    }, this.options.checkInterval);
    
    logger.info('Memory pressure detector started');
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  
  /**
   * Check current memory pressure
   */
  checkMemoryPressure() {
    const memUsage = process.memoryUsage();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const systemUsage = (totalMemory - freeMemory) / totalMemory;
    
    // Calculate heap usage ratio
    const heapUsage = memUsage.heapUsed / memUsage.heapTotal;
    
    // Calculate heap growth
    const heapGrowth = this.lastHeapUsed > 0 ? 
      (memUsage.heapUsed - this.lastHeapUsed) / this.lastHeapUsed : 0;
    
    // Record history
    const record = {
      timestamp: Date.now(),
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      heapUsage,
      systemUsage,
      heapGrowth,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers || 0
    };
    
    this.history.push(record);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
    
    // Update stats
    this.stats.totalChecks++;
    this.stats.avgMemoryUsage = (this.stats.avgMemoryUsage * (this.stats.totalChecks - 1) + heapUsage) / this.stats.totalChecks;
    
    // Determine pressure level
    const newPressureLevel = this.calculatePressureLevel(record);
    
    if (newPressureLevel !== this.pressureLevel) {
      this.pressureLevel = newPressureLevel;
      this.emit('pressureChange', { level: newPressureLevel, data: record });
      
      if (newPressureLevel === 'warning') {
        this.stats.warningEvents++;
        this.emit('pressure:warning', record);
      } else if (newPressureLevel === 'critical') {
        this.stats.criticalEvents++;
        this.emit('pressure:critical', record);
      }
    }
    
    // Emit high pressure events
    if (newPressureLevel === 'warning' || newPressureLevel === 'critical') {
      this.emit('pressure:high', record);
    }
    
    this.lastHeapUsed = memUsage.heapUsed;
  }
  
  /**
   * Calculate memory pressure level
   */
  calculatePressureLevel(record) {
    // Check multiple pressure indicators
    const indicators = [];
    
    // Heap usage pressure
    if (record.heapUsage > this.options.criticalThreshold) {
      indicators.push('critical');
    } else if (record.heapUsage > this.options.warningThreshold) {
      indicators.push('warning');
    }
    
    // Heap growth pressure
    if (record.heapGrowth > this.options.heapGrowthThreshold) {
      indicators.push('warning');
    }
    
    // System memory pressure
    if (record.systemUsage > 0.9) {
      indicators.push('critical');
    } else if (record.systemUsage > 0.8) {
      indicators.push('warning');
    }
    
    // External memory pressure
    const externalRatio = record.external / record.heapTotal;
    if (externalRatio > 0.5) {
      indicators.push('warning');
    }
    
    // Trend analysis
    if (this.history.length >= 5) {
      const trend = this.analyzeTrend();
      if (trend.isIncreasing && trend.rate > 0.05) {
        indicators.push('warning');
      }
    }
    
    // Determine overall level
    if (indicators.includes('critical')) {
      return 'critical';
    } else if (indicators.includes('warning')) {
      return 'warning';
    }
    
    return 'normal';
  }
  
  /**
   * Analyze memory usage trend
   */
  analyzeTrend() {
    if (this.history.length < 3) {
      return { isIncreasing: false, rate: 0 };
    }
    
    const recent = this.history.slice(-5);
    let increasingCount = 0;
    let totalRate = 0;
    
    for (let i = 1; i < recent.length; i++) {
      const rate = (recent[i].heapUsed - recent[i-1].heapUsed) / recent[i-1].heapUsed;
      if (rate > 0) {
        increasingCount++;
        totalRate += rate;
      }
    }
    
    return {
      isIncreasing: increasingCount > recent.length / 2,
      rate: totalRate / (recent.length - 1)
    };
  }
  
  /**
   * Get current memory status
   */
  getStatus() {
    const current = this.history[this.history.length - 1] || {};
    
    return {
      pressureLevel: this.pressureLevel,
      current,
      stats: this.stats,
      trend: this.analyzeTrend()
    };
  }
}

/**
 * GC optimization engine
 */
export class GCOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enablePredictiveGC: options.enablePredictiveGC !== false,
      gcThreshold: options.gcThreshold || 0.85, // Trigger GC at 85% heap usage
      minGCInterval: options.minGCInterval || 30000, // Minimum 30s between forced GCs
      maxHeapGrowth: options.maxHeapGrowth || 0.2, // 20% heap growth triggers GC
      ...options
    };
    
    this.lastGCTime = 0;
    this.gcHistory = [];
    this.maxGCHistory = 50;
    
    // Performance metrics
    this.metrics = {
      totalGCs: 0,
      predictiveGCs: 0,
      emergencyGCs: 0,
      avgGCTime: 0,
      heapSizeBefore: 0,
      heapSizeAfter: 0,
      totalReclaimed: 0
    };
  }
  
  /**
   * Initialize GC optimizer
   */
  initialize() {
    // Monitor V8 GC events if available
    if (v8.getHeapStatistics) {
      this.startV8Monitoring();
    }
    
    // Start predictive GC if enabled
    if (this.options.enablePredictiveGC) {
      this.startPredictiveGC();
    }
    
    logger.info('GC optimizer initialized', {
      predictiveGC: this.options.enablePredictiveGC,
      gcThreshold: this.options.gcThreshold
    });
  }
  
  /**
   * Start V8 GC monitoring
   */
  startV8Monitoring() {
    // Hook into V8 GC events (if available in Node.js version)
    process.on('warning', (warning) => {
      if (warning.name === 'HeapSpaceWarning') {
        this.handleHeapSpaceWarning(warning);
      }
    });
    
    // Regular heap statistics monitoring
    this.heapTimer = setInterval(() => {
      this.analyzeHeapStatistics();
    }, 10000); // Every 10 seconds
  }
  
  /**
   * Start predictive GC monitoring
   */
  startPredictiveGC() {
    this.predictiveTimer = setInterval(() => {
      this.checkPredictiveGC();
    }, 5000); // Check every 5 seconds
  }
  
  /**
   * Analyze heap statistics for optimization opportunities
   */
  analyzeHeapStatistics() {
    if (!v8.getHeapStatistics) return;
    
    const stats = v8.getHeapStatistics();\n    const heapSpaces = v8.getHeapSpaceStatistics();\n    \n    // Record statistics\n    const record = {\n      timestamp: Date.now(),\n      totalHeapSize: stats.total_heap_size,\n      totalHeapSizeExecutable: stats.total_heap_size_executable,\n      totalPhysicalSize: stats.total_physical_size,\n      totalAvailableSize: stats.total_available_size,\n      usedHeapSize: stats.used_heap_size,\n      heapSizeLimit: stats.heap_size_limit,\n      mallocedMemory: stats.malloced_memory,\n      peakMallocedMemory: stats.peak_malloced_memory,\n      doesZapGarbage: stats.does_zap_garbage,\n      numberOfNativeContexts: stats.number_of_native_contexts,\n      numberOfDetachedContexts: stats.number_of_detached_contexts,\n      spaces: heapSpaces\n    };\n    \n    this.gcHistory.push(record);\n    if (this.gcHistory.length > this.maxGCHistory) {\n      this.gcHistory.shift();\n    }\n    \n    // Analyze for optimization opportunities\n    this.analyzeOptimizationOpportunities(record);\n  }\n  \n  /**\n   * Check if predictive GC should be triggered\n   */\n  checkPredictiveGC() {\n    if (!this.options.enablePredictiveGC) return;\n    \n    const memUsage = process.memoryUsage();\n    const heapUsage = memUsage.heapUsed / memUsage.heapTotal;\n    const now = Date.now();\n    \n    // Check minimum interval\n    if (now - this.lastGCTime < this.options.minGCInterval) {\n      return;\n    }\n    \n    // Check heap usage threshold\n    if (heapUsage > this.options.gcThreshold) {\n      this.triggerPredictiveGC('heap_threshold');\n      return;\n    }\n    \n    // Check heap growth rate\n    if (this.gcHistory.length >= 2) {\n      const recent = this.gcHistory.slice(-2);\n      const growthRate = (recent[1].usedHeapSize - recent[0].usedHeapSize) / recent[0].usedHeapSize;\n      \n      if (growthRate > this.options.maxHeapGrowth) {\n        this.triggerPredictiveGC('heap_growth');\n        return;\n      }\n    }\n    \n    // Check for memory fragmentation\n    if (this.detectFragmentation()) {\n      this.triggerPredictiveGC('fragmentation');\n    }\n  }\n  \n  /**\n   * Trigger predictive garbage collection\n   */\n  triggerPredictiveGC(reason) {\n    const startTime = performance.now();\n    const beforeStats = process.memoryUsage();\n    \n    try {\n      if (global.gc) {\n        global.gc();\n        \n        const afterStats = process.memoryUsage();\n        const gcTime = performance.now() - startTime;\n        const reclaimed = beforeStats.heapUsed - afterStats.heapUsed;\n        \n        // Update metrics\n        this.metrics.totalGCs++;\n        this.metrics.predictiveGCs++;\n        this.metrics.avgGCTime = (this.metrics.avgGCTime * (this.metrics.totalGCs - 1) + gcTime) / this.metrics.totalGCs;\n        this.metrics.totalReclaimed += reclaimed;\n        this.lastGCTime = Date.now();\n        \n        logger.debug('Predictive GC completed', {\n          reason,\n          gcTime: gcTime.toFixed(2) + 'ms',\n          reclaimed: Math.round(reclaimed / 1024 / 1024) + 'MB',\n          heapBefore: Math.round(beforeStats.heapUsed / 1024 / 1024) + 'MB',\n          heapAfter: Math.round(afterStats.heapUsed / 1024 / 1024) + 'MB'\n        });\n        \n        this.emit('gc:completed', {\n          type: 'predictive',\n          reason,\n          gcTime,\n          reclaimed,\n          beforeStats,\n          afterStats\n        });\n        \n      } else {\n        logger.warn('GC not available - run with --expose-gc flag');\n      }\n    } catch (error) {\n      logger.error('GC execution failed', { error: error.message });\n    }\n  }\n  \n  /**\n   * Detect memory fragmentation\n   */\n  detectFragmentation() {\n    if (!v8.getHeapSpaceStatistics) return false;\n    \n    const spaces = v8.getHeapSpaceStatistics();\n    let fragmentationScore = 0;\n    \n    for (const space of spaces) {\n      if (space.space_size > 0) {\n        const utilization = space.space_used_size / space.space_size;\n        if (utilization < 0.5) { // Less than 50% utilization indicates fragmentation\n          fragmentationScore += (0.5 - utilization);\n        }\n      }\n    }\n    \n    // Fragmentation threshold\n    return fragmentationScore > 0.3;\n  }\n  \n  /**\n   * Analyze optimization opportunities\n   */\n  analyzeOptimizationOpportunities(record) {\n    const recommendations = [];\n    \n    // Check heap size efficiency\n    const heapEfficiency = record.usedHeapSize / record.totalHeapSize;\n    if (heapEfficiency < 0.5) {\n      recommendations.push({\n        type: 'heap_compaction',\n        severity: 'medium',\n        description: 'Heap is less than 50% utilized, consider compaction'\n      });\n    }\n    \n    // Check for excessive native contexts\n    if (record.numberOfDetachedContexts > 10) {\n      recommendations.push({\n        type: 'context_cleanup',\n        severity: 'high',\n        description: `${record.numberOfDetachedContexts} detached contexts detected`\n      });\n    }\n    \n    // Check malloc usage\n    const mallocRatio = record.mallocedMemory / record.usedHeapSize;\n    if (mallocRatio > 0.3) {\n      recommendations.push({\n        type: 'malloc_optimization',\n        severity: 'medium',\n        description: 'High malloc usage detected, consider buffer pooling'\n      });\n    }\n    \n    if (recommendations.length > 0) {\n      this.emit('optimization:recommendations', recommendations);\n    }\n  }\n  \n  /**\n   * Handle heap space warnings\n   */\n  handleHeapSpaceWarning(warning) {\n    logger.warn('Heap space warning received', {\n      message: warning.message,\n      stack: warning.stack\n    });\n    \n    // Trigger emergency GC\n    this.triggerEmergencyGC('heap_warning');\n  }\n  \n  /**\n   * Trigger emergency GC\n   */\n  triggerEmergencyGC(reason) {\n    this.metrics.emergencyGCs++;\n    \n    logger.warn('Triggering emergency GC', { reason });\n    \n    // Force immediate GC regardless of interval\n    this.triggerPredictiveGC(reason);\n    \n    this.emit('gc:emergency', { reason });\n  }\n  \n  /**\n   * Get GC optimizer statistics\n   */\n  getStats() {\n    const currentHeap = process.memoryUsage();\n    \n    return {\n      metrics: this.metrics,\n      currentHeap: {\n        used: Math.round(currentHeap.heapUsed / 1024 / 1024),\n        total: Math.round(currentHeap.heapTotal / 1024 / 1024),\n        usage: currentHeap.heapUsed / currentHeap.heapTotal\n      },\n      lastGC: this.lastGCTime,\n      timeSinceLastGC: Date.now() - this.lastGCTime,\n      historySize: this.gcHistory.length\n    };\n  }\n  \n  /**\n   * Shutdown GC optimizer\n   */\n  shutdown() {\n    if (this.heapTimer) {\n      clearInterval(this.heapTimer);\n    }\n    \n    if (this.predictiveTimer) {\n      clearInterval(this.predictiveTimer);\n    }\n    \n    logger.info('GC optimizer shutdown completed');\n  }\n}\n\n/**\n * Object pool manager for GC optimization\n */\nexport class ObjectPoolManager {\n  constructor() {\n    this.pools = new Map();\n    this.stats = {\n      totalPools: 0,\n      totalObjects: 0,\n      reuseRate: 0\n    };\n  }\n  \n  /**\n   * Create optimized object pool\n   */\n  createPool(name, factory, reset, options = {}) {\n    const pool = {\n      name,\n      factory,\n      reset,\n      objects: [],\n      maxSize: options.maxSize || 100,\n      created: 0,\n      reused: 0,\n      lastCleanup: Date.now()\n    };\n    \n    this.pools.set(name, pool);\n    this.stats.totalPools++;\n    \n    return pool;\n  }\n  \n  /**\n   * Get object from pool\n   */\n  acquire(poolName) {\n    const pool = this.pools.get(poolName);\n    if (!pool) {\n      throw new Error(`Pool '${poolName}' not found`);\n    }\n    \n    let obj;\n    \n    if (pool.objects.length > 0) {\n      obj = pool.objects.pop();\n      pool.reused++;\n    } else {\n      obj = pool.factory();\n      pool.created++;\n    }\n    \n    this.stats.totalObjects++;\n    this.updateReuseRate();\n    \n    return obj;\n  }\n  \n  /**\n   * Return object to pool\n   */\n  release(poolName, obj) {\n    const pool = this.pools.get(poolName);\n    if (!pool || pool.objects.length >= pool.maxSize) {\n      return false;\n    }\n    \n    // Reset object state\n    if (pool.reset) {\n      pool.reset(obj);\n    }\n    \n    pool.objects.push(obj);\n    return true;\n  }\n  \n  /**\n   * Update reuse rate statistics\n   */\n  updateReuseRate() {\n    let totalReused = 0;\n    let totalCreated = 0;\n    \n    for (const pool of this.pools.values()) {\n      totalReused += pool.reused;\n      totalCreated += pool.created;\n    }\n    \n    this.stats.reuseRate = totalCreated > 0 ? totalReused / totalCreated : 0;\n  }\n  \n  /**\n   * Aggressive cleanup for memory pressure\n   */\n  aggressiveCleanup() {\n    let cleanedObjects = 0;\n    \n    for (const pool of this.pools.values()) {\n      const objectsToKeep = Math.floor(pool.objects.length * 0.3); // Keep only 30%\n      const removed = pool.objects.length - objectsToKeep;\n      \n      pool.objects = pool.objects.slice(0, objectsToKeep);\n      cleanedObjects += removed;\n      pool.lastCleanup = Date.now();\n    }\n    \n    logger.debug(`Aggressive cleanup removed ${cleanedObjects} pooled objects`);\n    return cleanedObjects;\n  }\n  \n  /**\n   * Get pool statistics\n   */\n  getStats() {\n    const poolStats = {};\n    \n    for (const [name, pool] of this.pools) {\n      poolStats[name] = {\n        size: pool.objects.length,\n        maxSize: pool.maxSize,\n        created: pool.created,\n        reused: pool.reused,\n        reuseRate: pool.created > 0 ? pool.reused / pool.created : 0,\n        utilization: pool.objects.length / pool.maxSize\n      };\n    }\n    \n    return {\n      ...this.stats,\n      pools: poolStats\n    };\n  }\n}\n\nexport default {\n  MemoryPressureDetector,\n  GCOptimizer,\n  ObjectPoolManager\n};"