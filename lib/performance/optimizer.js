/**
 * Performance Optimizer for Otedama
 * Military-grade performance optimization and monitoring
 * 
 * Optimizations:
 * - Zero-overhead abstractions (Carmack)
 * - Clean performance interfaces (Martin)
 * - Simple monitoring APIs (Pike)
 */

import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
import { cpus, totalmem, freemem, loadavg } from 'os';
import { Worker } from 'worker_threads';

// Performance constants
const PERF_CONSTANTS = Object.freeze({
  // Monitoring intervals
  METRICS_INTERVAL: 1000,     // 1 second
  ALERT_INTERVAL: 5000,       // 5 seconds  
  CLEANUP_INTERVAL: 300000,   // 5 minutes
  
  // Memory management
  GC_THRESHOLD: 0.8,          // 80% memory usage
  GC_INTERVAL: 60000,         // 1 minute
  
  // Cache settings
  DEFAULT_CACHE_SIZE: 100 * 1024 * 1024, // 100MB
  CACHE_TTL: 3600000,         // 1 hour
  MAX_CACHE_ENTRIES: 100000,
  
  // Alert thresholds
  THRESHOLDS: {
    CPU_USAGE: 85,              // 85%
    MEMORY_USAGE: 90,           // 90%
    HEAP_USAGE: 85,             // 85%
    EVENT_LOOP_LAG: 100,        // 100ms
    GC_PAUSE: 50,               // 50ms
    RESPONSE_TIME: 1000         // 1000ms
  },
  
  // Performance targets
  TARGETS: {
    CPU_USAGE: 70,              // 70%
    MEMORY_USAGE: 75,           // 75%
    RESPONSE_TIME: 200,         // 200ms
    THROUGHPUT: 10000           // 10k ops/sec
  }
});

/**
 * High-performance LRU Cache with TTL
 */
class OptimizedCache {
  constructor(maxSize = PERF_CONSTANTS.DEFAULT_CACHE_SIZE, maxEntries = PERF_CONSTANTS.MAX_CACHE_ENTRIES) {
    this.maxSize = maxSize;
    this.maxEntries = maxEntries;
    this.currentSize = 0;
    this.entries = new Map();
    
    // Performance tracking
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      size: 0,
      entries: 0
    };
    
    // Cleanup interval
    setInterval(() => this.cleanup(), PERF_CONSTANTS.CLEANUP_INTERVAL);
  }
  
  // Get value with LRU update
  get(key) {
    const entry = this.entries.get(key);
    
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    
    // Check TTL
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.delete(key);
      this.stats.misses++;
      return null;
    }
    
    // Update LRU - move to end
    this.entries.delete(key);
    this.entries.set(key, entry);
    
    this.stats.hits++;
    return entry.value;
  }
  
  // Set value with size management
  set(key, value, ttl = PERF_CONSTANTS.CACHE_TTL) {
    const size = this.calculateSize(value);
    const expiresAt = ttl > 0 ? Date.now() + ttl : null;
    
    // Remove existing entry
    if (this.entries.has(key)) {
      const oldEntry = this.entries.get(key);
      this.currentSize -= oldEntry.size;
      this.entries.delete(key);
    }
    
    // Check size limits
    this.evictToFit(size);
    
    // Add new entry
    const entry = {
      value,
      size,
      expiresAt,
      createdAt: Date.now()
    };
    
    this.entries.set(key, entry);
    this.currentSize += size;
    
    this.stats.sets++;
    this.updateStats();
    
    return true;
  }
  
  // Delete entry
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    
    this.entries.delete(key);
    this.currentSize -= entry.size;
    
    this.stats.deletes++;
    this.updateStats();
    
    return true;
  }
  
  // Check if key exists and is valid
  has(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }
    
    return true;
  }
  
  // Clear all entries
  clear() {
    this.entries.clear();
    this.currentSize = 0;
    this.updateStats();
  }
  
  // Evict entries to fit new size
  evictToFit(newSize) {
    // Check entry count limit
    while (this.entries.size >= this.maxEntries) {
      const firstKey = this.entries.keys().next().value;
      this.delete(firstKey);
      this.stats.evictions++;
    }
    
    // Check size limit
    while (this.currentSize + newSize > this.maxSize && this.entries.size > 0) {
      const firstKey = this.entries.keys().next().value;
      this.delete(firstKey);
      this.stats.evictions++;
    }
  }
  
  // Calculate memory size of value
  calculateSize(value) {
    if (Buffer.isBuffer(value)) {
      return value.length;
    }
    
    if (typeof value === 'string') {
      return Buffer.byteLength(value, 'utf8');
    }
    
    if (typeof value === 'object') {
      return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    
    return 8; // Estimate for primitives
  }
  
  // Cleanup expired entries
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.delete(key);
        cleaned++;
      }
    }
    
    return cleaned;
  }
  
  // Update stats
  updateStats() {
    this.stats.size = this.currentSize;
    this.stats.entries = this.entries.size;
  }
  
  // Get cache statistics
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0 
      ? (this.stats.hits / (this.stats.hits + this.stats.misses)) * 100 
      : 0;
    
    return {
      ...this.stats,
      hitRate: hitRate.toFixed(2),
      memoryUsage: ((this.currentSize / this.maxSize) * 100).toFixed(2),
      entryUsage: ((this.entries.size / this.maxEntries) * 100).toFixed(2)
    };
  }
}

/**
 * System metrics collector
 */
class MetricsCollector {
  constructor() {
    this.metrics = {
      system: {
        cpuUsage: 0,
        memoryUsage: 0,
        loadAverage: [0, 0, 0],
        uptime: 0
      },
      process: {
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        rss: 0,
        cpuUsage: { user: 0, system: 0 }
      },
      performance: {
        eventLoopLag: 0,
        gcPauses: [],
        responseTime: 0,
        throughput: 0
      }
    };
    
    this.responseTimeWindow = [];
    this.throughputCounter = 0;
    this.lastThroughputReset = Date.now();
    
    // Event loop lag measurement
    this.eventLoopStart = performance.now();
    
    // GC monitoring
    this.setupGCMonitoring();
    
    // Start collection
    this.startCollection();
  }
  
  setupGCMonitoring() {
    if (typeof global.gc === 'function') {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (const entry of entries) {
          if (entry.entryType === 'gc') {
            this.metrics.performance.gcPauses.push({
              duration: entry.duration,
              kind: entry.kind,
              timestamp: entry.startTime
            });
            
            // Keep only recent GC pauses (last 5 minutes)
            const cutoff = performance.now() - 300000;
            this.metrics.performance.gcPauses = this.metrics.performance.gcPauses
              .filter(pause => pause.timestamp > cutoff);
          }
        }
      });
      
      observer.observe({ entryTypes: ['gc'] });
    }
  }
  
  startCollection() {
    setInterval(() => {
      this.collectSystemMetrics();
      this.collectProcessMetrics();
      this.collectPerformanceMetrics();
    }, PERF_CONSTANTS.METRICS_INTERVAL);
  }
  
  collectSystemMetrics() {
    // CPU usage (approximation based on load average)
    const loads = loadavg();
    const cpuCount = cpus().length;
    this.metrics.system.cpuUsage = Math.min(100, (loads[0] / cpuCount) * 100);
    
    // Memory usage
    const totalMem = totalmem();
    const freeMem = freemem();
    this.metrics.system.memoryUsage = ((totalMem - freeMem) / totalMem) * 100;
    
    this.metrics.system.loadAverage = loads;
    this.metrics.system.uptime = process.uptime();
  }
  
  collectProcessMetrics() {
    const memUsage = process.memoryUsage();
    this.metrics.process.heapUsed = memUsage.heapUsed;
    this.metrics.process.heapTotal = memUsage.heapTotal;
    this.metrics.process.external = memUsage.external;
    this.metrics.process.rss = memUsage.rss;
    
    this.metrics.process.cpuUsage = process.cpuUsage();
  }
  
  collectPerformanceMetrics() {
    // Event loop lag
    const now = performance.now();
    const lag = now - this.eventLoopStart - PERF_CONSTANTS.METRICS_INTERVAL;
    this.metrics.performance.eventLoopLag = Math.max(0, lag);
    this.eventLoopStart = now;
    
    // Calculate average response time
    if (this.responseTimeWindow.length > 0) {
      const sum = this.responseTimeWindow.reduce((a, b) => a + b, 0);
      this.metrics.performance.responseTime = sum / this.responseTimeWindow.length;
      
      // Keep only recent response times (last minute)
      if (this.responseTimeWindow.length > 60) {
        this.responseTimeWindow = this.responseTimeWindow.slice(-60);
      }
    }
    
    // Calculate throughput
    const timeSinceReset = now - this.lastThroughputReset;
    if (timeSinceReset >= 1000) { // Every second
      this.metrics.performance.throughput = (this.throughputCounter / timeSinceReset) * 1000;
      this.throughputCounter = 0;
      this.lastThroughputReset = now;
    }
  }
  
  recordResponseTime(duration) {
    this.responseTimeWindow.push(duration);
    this.throughputCounter++;
  }
  
  getMetrics() {
    return JSON.parse(JSON.stringify(this.metrics));
  }
  
  // Check if any metric exceeds threshold
  checkThresholds() {
    const alerts = [];
    
    if (this.metrics.system.cpuUsage > PERF_CONSTANTS.THRESHOLDS.CPU_USAGE) {
      alerts.push({
        type: 'cpu_usage',
        value: this.metrics.system.cpuUsage,
        threshold: PERF_CONSTANTS.THRESHOLDS.CPU_USAGE,
        severity: 'high'
      });
    }
    
    if (this.metrics.system.memoryUsage > PERF_CONSTANTS.THRESHOLDS.MEMORY_USAGE) {
      alerts.push({
        type: 'memory_usage',
        value: this.metrics.system.memoryUsage,
        threshold: PERF_CONSTANTS.THRESHOLDS.MEMORY_USAGE,
        severity: 'critical'
      });
    }
    
    const heapUsage = (this.metrics.process.heapUsed / this.metrics.process.heapTotal) * 100;
    if (heapUsage > PERF_CONSTANTS.THRESHOLDS.HEAP_USAGE) {
      alerts.push({
        type: 'heap_usage',
        value: heapUsage,
        threshold: PERF_CONSTANTS.THRESHOLDS.HEAP_USAGE,
        severity: 'high'
      });
    }
    
    if (this.metrics.performance.eventLoopLag > PERF_CONSTANTS.THRESHOLDS.EVENT_LOOP_LAG) {
      alerts.push({
        type: 'event_loop_lag',
        value: this.metrics.performance.eventLoopLag,
        threshold: PERF_CONSTANTS.THRESHOLDS.EVENT_LOOP_LAG,
        severity: 'medium'
      });
    }
    
    return alerts;
  }
}

/**
 * Memory manager with automatic optimization
 */
class MemoryManager {
  constructor() {
    this.gcStats = {
      forced: 0,
      automatic: 0,
      lastGC: Date.now()
    };
    
    // Start memory monitoring
    this.startMonitoring();
  }
  
  startMonitoring() {
    setInterval(() => {
      this.checkMemoryPressure();
    }, PERF_CONSTANTS.GC_INTERVAL);
  }
  
  checkMemoryPressure() {
    const memUsage = process.memoryUsage();
    const heapUsage = memUsage.heapUsed / memUsage.heapTotal;
    
    // Force GC if memory pressure is high
    if (heapUsage > PERF_CONSTANTS.GC_THRESHOLD && global.gc) {
      const beforeGC = memUsage.heapUsed;
      const gcStart = performance.now();
      
      global.gc();
      
      const afterGC = process.memoryUsage().heapUsed;
      const gcDuration = performance.now() - gcStart;
      
      this.gcStats.forced++;
      this.gcStats.lastGC = Date.now();
      
      // Log significant memory releases
      const freed = beforeGC - afterGC;
      if (freed > 10 * 1024 * 1024) { // 10MB
        console.log(`GC freed ${Math.round(freed / 1024 / 1024)}MB in ${gcDuration.toFixed(2)}ms`);
      }
    }
  }
  
  // Manual garbage collection
  forceGC() {
    if (global.gc) {
      global.gc();
      this.gcStats.forced++;
      this.gcStats.lastGC = Date.now();
      return true;
    }
    return false;
  }
  
  getStats() {
    return { ...this.gcStats };
  }
}

/**
 * CPU optimization and profiling
 */
class CPUOptimizer {
  constructor() {
    this.cpuProfiles = new Map();
    this.hotspots = new Map();
    this.optimizations = new Map();
  }
  
  // Profile function execution
  profile(name, fn) {
    return (...args) => {
      const start = performance.now();
      
      try {
        const result = fn.apply(this, args);
        
        // Handle async functions
        if (result && typeof result.then === 'function') {
          return result.finally(() => {
            this.recordExecution(name, performance.now() - start);
          });
        }
        
        this.recordExecution(name, performance.now() - start);
        return result;
        
      } catch (error) {
        this.recordExecution(name, performance.now() - start, error);
        throw error;
      }
    };
  }
  
  recordExecution(name, duration, error = null) {
    if (!this.cpuProfiles.has(name)) {
      this.cpuProfiles.set(name, {
        calls: 0,
        totalTime: 0,
        avgTime: 0,
        minTime: Infinity,
        maxTime: 0,
        errors: 0
      });
    }
    
    const profile = this.cpuProfiles.get(name);
    profile.calls++;
    profile.totalTime += duration;
    profile.avgTime = profile.totalTime / profile.calls;
    profile.minTime = Math.min(profile.minTime, duration);
    profile.maxTime = Math.max(profile.maxTime, duration);
    
    if (error) {
      profile.errors++;
    }
    
    // Identify hotspots
    if (duration > 100) { // 100ms threshold
      this.recordHotspot(name, duration);
    }
  }
  
  recordHotspot(name, duration) {
    if (!this.hotspots.has(name)) {
      this.hotspots.set(name, []);
    }
    
    this.hotspots.get(name).push({
      duration,
      timestamp: Date.now()
    });
    
    // Keep only recent hotspots
    const cutoff = Date.now() - 300000; // 5 minutes
    const recent = this.hotspots.get(name).filter(h => h.timestamp > cutoff);
    this.hotspots.set(name, recent);
  }
  
  getProfiles() {
    return Object.fromEntries(this.cpuProfiles);
  }
  
  getHotspots() {
    return Object.fromEntries(this.hotspots);
  }
  
  // Suggest optimizations based on profiles
  suggestOptimizations() {
    const suggestions = [];
    
    for (const [name, profile] of this.cpuProfiles) {
      if (profile.avgTime > 50) { // 50ms average
        suggestions.push({
          function: name,
          issue: 'High average execution time',
          avgTime: profile.avgTime,
          suggestion: 'Consider optimizing algorithm or adding caching'
        });
      }
      
      if (profile.maxTime > 1000) { // 1 second max
        suggestions.push({
          function: name,
          issue: 'Very slow execution detected',
          maxTime: profile.maxTime,
          suggestion: 'Add timeout or break into smaller chunks'
        });
      }
      
      if (profile.errors / profile.calls > 0.1) { // 10% error rate
        suggestions.push({
          function: name,
          issue: 'High error rate',
          errorRate: (profile.errors / profile.calls * 100).toFixed(1),
          suggestion: 'Improve error handling and validation'
        });
      }
    }
    
    return suggestions;
  }
}

/**
 * Main Performance Optimizer
 */
export class PerformanceOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = Object.freeze({
      cacheEnabled: options.cacheEnabled !== false,
      metricsEnabled: options.metricsEnabled !== false,
      profilingEnabled: options.profilingEnabled !== false,
      memoryManagement: options.memoryManagement !== false,
      ...options
    });
    
    // Core components
    this.cache = this.config.cacheEnabled ? new OptimizedCache(options.cacheSize, options.maxCacheEntries) : null;
    this.metricsCollector = this.config.metricsEnabled ? new MetricsCollector() : null;
    this.memoryManager = this.config.memoryManagement ? new MemoryManager() : null;
    this.cpuOptimizer = this.config.profilingEnabled ? new CPUOptimizer() : null;
    
    // Alert system
    this.alerts = [];
    this.alertCallbacks = new Map();
    
    // Performance baseline
    this.baseline = null;
    this.benchmarks = new Map();
    
    this.initialized = false;
  }
  
  async initialize() {
    if (this.initialized) return;
    
    // Establish performance baseline
    await this.establishBaseline();
    
    // Start alert monitoring
    this.startAlertMonitoring();
    
    // Start optimization recommendations
    this.startOptimizationEngine();
    
    this.initialized = true;
    this.emit('initialized');
  }
  
  async establishBaseline() {
    const baseline = {
      cpu: 0,
      memory: 0,
      responseTime: 0,
      throughput: 0,
      timestamp: Date.now()
    };
    
    // Run baseline benchmark
    const iterations = 1000;
    const start = performance.now();
    
    for (let i = 0; i < iterations; i++) {
      // Simple CPU benchmark
      Math.sqrt(i * Math.random());
    }
    
    baseline.responseTime = (performance.now() - start) / iterations;
    baseline.throughput = iterations / ((performance.now() - start) / 1000);
    
    if (this.metricsCollector) {
      const metrics = this.metricsCollector.getMetrics();
      baseline.cpu = metrics.system.cpuUsage;
      baseline.memory = metrics.system.memoryUsage;
    }
    
    this.baseline = baseline;
  }
  
  startAlertMonitoring() {
    if (!this.metricsCollector) return;
    
    setInterval(() => {
      const alerts = this.metricsCollector.checkThresholds();
      
      for (const alert of alerts) {
        this.handleAlert(alert);
      }
    }, PERF_CONSTANTS.ALERT_INTERVAL);
  }
  
  handleAlert(alert) {
    this.alerts.push({
      ...alert,
      timestamp: Date.now()
    });
    
    // Keep only recent alerts
    const cutoff = Date.now() - 3600000; // 1 hour
    this.alerts = this.alerts.filter(a => a.timestamp > cutoff);
    
    // Execute alert callbacks
    const callbacks = this.alertCallbacks.get(alert.type) || [];
    for (const callback of callbacks) {
      try {
        callback(alert);
      } catch (error) {
        console.error('Alert callback error:', error);
      }
    }
    
    this.emit('alert', alert);
  }
  
  startOptimizationEngine() {
    setInterval(() => {
      this.generateOptimizationRecommendations();
    }, 300000); // Every 5 minutes
  }
  
  generateOptimizationRecommendations() {
    const recommendations = [];
    
    if (this.metricsCollector) {
      const metrics = this.metricsCollector.getMetrics();
      
      // Memory optimization
      if (metrics.system.memoryUsage > 80) {
        recommendations.push({
          type: 'memory',
          priority: 'high',
          message: 'High memory usage detected',
          actions: ['Enable garbage collection', 'Reduce cache size', 'Clear unused data']
        });
      }
      
      // CPU optimization
      if (metrics.system.cpuUsage > 85) {
        recommendations.push({
          type: 'cpu',
          priority: 'high',
          message: 'High CPU usage detected',
          actions: ['Optimize hot code paths', 'Implement caching', 'Use worker threads']
        });
      }
    }
    
    if (this.cpuOptimizer) {
      const suggestions = this.cpuOptimizer.suggestOptimizations();
      recommendations.push(...suggestions.map(s => ({
        type: 'optimization',
        priority: 'medium',
        ...s
      })));
    }
    
    if (recommendations.length > 0) {
      this.emit('recommendations', recommendations);
    }
  }
  
  // Caching interface
  cacheGet(key) {
    return this.cache ? this.cache.get(key) : null;
  }
  
  cacheSet(key, value, ttl) {
    return this.cache ? this.cache.set(key, value, ttl) : false;
  }
  
  cacheDelete(key) {
    return this.cache ? this.cache.delete(key) : false;
  }
  
  cacheHas(key) {
    return this.cache ? this.cache.has(key) : false;
  }
  
  // Profiling interface
  profile(name, fn) {
    return this.cpuOptimizer ? this.cpuOptimizer.profile(name, fn) : fn;
  }
  
  // Memory management
  forceGC() {
    return this.memoryManager ? this.memoryManager.forceGC() : false;
  }
  
  // Benchmarking
  async benchmark(name, fn, iterations = 1000) {
    const results = [];
    
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await fn();
      results.push(performance.now() - start);
    }
    
    const stats = {
      min: Math.min(...results),
      max: Math.max(...results),
      avg: results.reduce((a, b) => a + b) / results.length,
      median: results.sort((a, b) => a - b)[Math.floor(results.length / 2)],
      iterations,
      timestamp: Date.now()
    };
    
    this.benchmarks.set(name, stats);
    return stats;
  }
  
  // Alert management
  onAlert(type, callback) {
    if (!this.alertCallbacks.has(type)) {
      this.alertCallbacks.set(type, []);
    }
    this.alertCallbacks.get(type).push(callback);
  }
  
  removeAlertCallback(type, callback) {
    const callbacks = this.alertCallbacks.get(type);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index !== -1) {
        callbacks.splice(index, 1);
      }
    }
  }
  
  // Performance metrics
  recordResponseTime(duration) {
    if (this.metricsCollector) {
      this.metricsCollector.recordResponseTime(duration);
    }
  }
  
  // Public API
  getMetrics() {
    const metrics = {
      baseline: this.baseline,
      alerts: this.alerts.length,
      benchmarks: Object.fromEntries(this.benchmarks)
    };
    
    if (this.metricsCollector) {
      metrics.system = this.metricsCollector.getMetrics();
    }
    
    if (this.cache) {
      metrics.cache = this.cache.getStats();
    }
    
    if (this.memoryManager) {
      metrics.memory = this.memoryManager.getStats();
    }
    
    if (this.cpuOptimizer) {
      metrics.cpu = {
        profiles: this.cpuOptimizer.getProfiles(),
        hotspots: this.cpuOptimizer.getHotspots()
      };
    }
    
    return metrics;
  }
  
  getPerformanceReport() {
    const metrics = this.getMetrics();
    const recommendations = this.cpuOptimizer ? this.cpuOptimizer.suggestOptimizations() : [];
    
    return {
      timestamp: Date.now(),
      metrics,
      recommendations,
      alerts: this.alerts.slice(-10), // Last 10 alerts
      health: this.calculateHealthScore(metrics)
    };
  }
  
  calculateHealthScore(metrics) {
    let score = 100;
    
    if (metrics.system) {
      // Deduct points for high resource usage
      if (metrics.system.system.cpuUsage > 70) {
        score -= (metrics.system.system.cpuUsage - 70) * 2;
      }
      
      if (metrics.system.system.memoryUsage > 75) {
        score -= (metrics.system.system.memoryUsage - 75) * 3;
      }
      
      if (metrics.system.performance.eventLoopLag > 50) {
        score -= (metrics.system.performance.eventLoopLag - 50) / 10;
      }
    }
    
    // Bonus points for good cache performance
    if (metrics.cache && parseFloat(metrics.cache.hitRate) > 80) {
      score += 5;
    }
    
    return Math.max(0, Math.min(100, Math.round(score)));
  }
  
  async shutdown() {
    this.initialized = false;
    this.emit('shutdown');
  }
}

export default PerformanceOptimizer;