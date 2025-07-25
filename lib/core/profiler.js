/**
 * Performance Profiler - Otedama
 * Performance monitoring and optimization tools
 * 
 * Design: Measure everything that matters (Carmack)
 */

import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
import { createLogger } from './logger.js';

const logger = createLogger('Profiler');

/**
 * Performance metrics collector
 */
export class MetricsCollector {
  constructor(name, options = {}) {
    this.name = name;
    this.options = {
      maxSamples: options.maxSamples || 1000,
      percentiles: options.percentiles || [50, 90, 95, 99],
      ...options
    };
    
    this.samples = [];
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }
  
  record(value) {
    this.count++;
    this.sum += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    
    // Keep sample for percentile calculation
    this.samples.push(value);
    
    // Limit samples to prevent memory growth
    if (this.samples.length > this.options.maxSamples) {
      // Remove oldest sample
      const removed = this.samples.shift();
      
      // Update sum (approximate, may drift over time)
      this.sum -= removed;
      this.count--;
    }
  }
  
  getStats() {
    if (this.count === 0) {
      return {
        count: 0,
        mean: 0,
        min: 0,
        max: 0,
        percentiles: {}
      };
    }
    
    // Calculate percentiles
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentiles = {};
    
    for (const p of this.options.percentiles) {
      const index = Math.floor((sorted.length - 1) * (p / 100));
      percentiles[`p${p}`] = sorted[index];
    }
    
    return {
      count: this.count,
      mean: this.sum / this.count,
      min: this.min,
      max: this.max,
      percentiles
    };
  }
  
  reset() {
    this.samples = [];
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }
}

/**
 * Function profiler
 */
export class FunctionProfiler {
  constructor(name, fn, options = {}) {
    this.name = name;
    this.fn = fn;
    this.options = options;
    this.metrics = new MetricsCollector(name, options);
    this.errors = 0;
  }
  
  wrap() {
    const self = this;
    
    return async function(...args) {
      const start = performance.now();
      
      try {
        const result = await self.fn.apply(this, args);
        const duration = performance.now() - start;
        
        self.metrics.record(duration);
        
        return result;
      } catch (error) {
        self.errors++;
        const duration = performance.now() - start;
        self.metrics.record(duration);
        
        throw error;
      }
    };
  }
  
  getStats() {
    return {
      ...this.metrics.getStats(),
      errors: this.errors,
      errorRate: this.metrics.count > 0 ? this.errors / this.metrics.count : 0
    };
  }
}

/**
 * Main profiler class
 */
export class Profiler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enabled: options.enabled !== false,
      sampleRate: options.sampleRate || 1, // Sample all by default
      reportInterval: options.reportInterval || 60000, // 1 minute
      gcTracking: options.gcTracking !== false,
      ...options
    };
    
    this.metrics = new Map();
    this.functionProfilers = new Map();
    this.marks = new Map();
    this.observer = null;
    this.reportTimer = null;
    this.gcStats = {
      count: 0,
      totalDuration: 0,
      types: {}
    };
  }
  
  /**
   * Start profiling
   */
  start() {
    if (!this.options.enabled) return;
    
    // Setup performance observer
    this.setupObserver();
    
    // Start reporting
    if (this.options.reportInterval > 0) {
      this.reportTimer = setInterval(() => {
        this.report();
      }, this.options.reportInterval);
    }
    
    logger.info('Profiler started');
    this.emit('started');
  }
  
  /**
   * Stop profiling
   */
  stop() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
    
    logger.info('Profiler stopped');
    this.emit('stopped');
  }
  
  /**
   * Setup performance observer
   */
  setupObserver() {
    if (this.observer) return;
    
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.handleEntry(entry);
      }
    });
    
    // Observe different entry types
    this.observer.observe({ 
      entryTypes: ['measure', 'function', 'gc']
    });
  }
  
  /**
   * Handle performance entry
   */
  handleEntry(entry) {
    if (entry.entryType === 'gc' && this.options.gcTracking) {
      this.handleGC(entry);
    } else if (entry.entryType === 'measure') {
      this.handleMeasure(entry);
    }
  }
  
  /**
   * Handle GC event
   */
  handleGC(entry) {
    this.gcStats.count++;
    this.gcStats.totalDuration += entry.duration;
    
    const type = entry.kind || 'unknown';
    if (!this.gcStats.types[type]) {
      this.gcStats.types[type] = { count: 0, duration: 0 };
    }
    
    this.gcStats.types[type].count++;
    this.gcStats.types[type].duration += entry.duration;
    
    if (entry.duration > 10) { // Log long GC pauses
      logger.warn(`Long GC pause detected: ${entry.duration.toFixed(2)}ms (${type})`);
      this.emit('gc:pause', { duration: entry.duration, type });
    }
  }
  
  /**
   * Handle measure
   */
  handleMeasure(entry) {
    const metric = this.getOrCreateMetric(entry.name);
    metric.record(entry.duration);
  }
  
  /**
   * Mark a point in time
   */
  mark(name) {
    if (!this.options.enabled) return;
    
    performance.mark(name);
    this.marks.set(name, performance.now());
  }
  
  /**
   * Measure between two marks
   */
  measure(name, startMark, endMark = null) {
    if (!this.options.enabled) return;
    
    // Check sample rate
    if (Math.random() > this.options.sampleRate) return;
    
    try {
      if (endMark) {
        performance.measure(name, startMark, endMark);
      } else {
        // Measure from start mark to now
        const startTime = this.marks.get(startMark);
        if (startTime) {
          const duration = performance.now() - startTime;
          const metric = this.getOrCreateMetric(name);
          metric.record(duration);
        }
      }
    } catch (error) {
      logger.debug(`Failed to measure ${name}:`, error.message);
    }
  }
  
  /**
   * Time a function execution
   */
  async time(name, fn) {
    if (!this.options.enabled) return fn();
    
    const start = performance.now();
    
    try {
      const result = await fn();
      const duration = performance.now() - start;
      
      const metric = this.getOrCreateMetric(name);
      metric.record(duration);
      
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      
      const metric = this.getOrCreateMetric(name);
      metric.record(duration);
      
      throw error;
    }
  }
  
  /**
   * Profile a function
   */
  profile(name, fn, options = {}) {
    if (this.functionProfilers.has(name)) {
      return this.functionProfilers.get(name).wrap();
    }
    
    const profiler = new FunctionProfiler(name, fn, options);
    this.functionProfilers.set(name, profiler);
    
    return profiler.wrap();
  }
  
  /**
   * Record a custom metric
   */
  recordMetric(name, value) {
    if (!this.options.enabled) return;
    
    const metric = this.getOrCreateMetric(name);
    metric.record(value);
  }
  
  /**
   * Get or create metric
   */
  getOrCreateMetric(name) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, new MetricsCollector(name));
    }
    
    return this.metrics.get(name);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const stats = {
      metrics: {},
      functions: {},
      gc: this.gcStats
    };
    
    // Collect metric stats
    for (const [name, metric] of this.metrics) {
      stats.metrics[name] = metric.getStats();
    }
    
    // Collect function stats
    for (const [name, profiler] of this.functionProfilers) {
      stats.functions[name] = profiler.getStats();
    }
    
    return stats;
  }
  
  /**
   * Generate report
   */
  report() {
    const stats = this.getStats();
    
    // Log summary
    logger.info('Performance Report:');
    
    // Top slowest operations
    const slowest = Object.entries(stats.metrics)
      .map(([name, stat]) => ({ name, ...stat }))
      .sort((a, b) => (b.percentiles.p95 || 0) - (a.percentiles.p95 || 0))
      .slice(0, 5);
    
    if (slowest.length > 0) {
      logger.info('Top 5 slowest operations (p95):');
      for (const op of slowest) {
        logger.info(`  ${op.name}: ${op.percentiles.p95?.toFixed(2)}ms`);
      }
    }
    
    // GC stats
    if (this.gcStats.count > 0) {
      const avgGC = this.gcStats.totalDuration / this.gcStats.count;
      logger.info(`GC: ${this.gcStats.count} collections, avg ${avgGC.toFixed(2)}ms`);
    }
    
    this.emit('report', stats);
  }
  
  /**
   * Reset all metrics
   */
  reset() {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
    
    this.gcStats = {
      count: 0,
      totalDuration: 0,
      types: {}
    };
    
    this.marks.clear();
  }
  
  /**
   * Create a scoped timer
   */
  createTimer(name) {
    const start = performance.now();
    
    return {
      end: () => {
        if (!this.options.enabled) return;
        
        const duration = performance.now() - start;
        const metric = this.getOrCreateMetric(name);
        metric.record(duration);
        
        return duration;
      }
    };
  }
  
  /**
   * Express middleware
   */
  middleware(options = {}) {
    const {
      includeParams = false,
      includePath = true
    } = options;
    
    return (req, res, next) => {
      if (!this.options.enabled) return next();
      
      const timer = this.createTimer(
        includePath ? `http:${req.method}:${req.path}` : `http:${req.method}`
      );
      
      // Override res.end to capture response time
      const originalEnd = res.end;
      res.end = function(...args) {
        timer.end();
        originalEnd.apply(res, args);
      };
      
      next();
    };
  }
}

/**
 * CPU profiler using v8 profiler
 */
export class CPUProfiler {
  constructor(options = {}) {
    this.options = {
      duration: options.duration || 10000, // 10 seconds
      samplingInterval: options.samplingInterval || 100, // microseconds
      ...options
    };
    
    this.profiling = false;
  }
  
  async profile(duration = this.options.duration) {
    if (this.profiling) {
      throw new Error('CPU profiling already in progress');
    }
    
    try {
      const v8Profiler = require('v8-profiler-next');
      
      this.profiling = true;
      const id = `cpu-profile-${Date.now()}`;
      
      // Start profiling
      v8Profiler.startProfiling(id, true);
      
      // Wait for duration
      await new Promise(resolve => setTimeout(resolve, duration));
      
      // Stop profiling
      const profile = v8Profiler.stopProfiling(id);
      
      // Export profile
      const result = await new Promise((resolve, reject) => {
        profile.export((error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });
      
      // Clean up
      profile.delete();
      
      return result;
      
    } catch (error) {
      logger.error('CPU profiling failed:', error);
      throw error;
    } finally {
      this.profiling = false;
    }
  }
}

/**
 * Memory profiler
 */
export class MemoryProfiler {
  constructor(options = {}) {
    this.options = options;
    this.baseline = null;
    this.snapshots = [];
  }
  
  captureBaseline() {
    this.baseline = process.memoryUsage();
    return this.baseline;
  }
  
  captureSnapshot() {
    const current = process.memoryUsage();
    const snapshot = {
      timestamp: Date.now(),
      usage: current
    };
    
    if (this.baseline) {
      snapshot.delta = {
        rss: current.rss - this.baseline.rss,
        heapTotal: current.heapTotal - this.baseline.heapTotal,
        heapUsed: current.heapUsed - this.baseline.heapUsed,
        external: current.external - this.baseline.external
      };
    }
    
    this.snapshots.push(snapshot);
    
    // Limit snapshots
    if (this.snapshots.length > 100) {
      this.snapshots.shift();
    }
    
    return snapshot;
  }
  
  analyze() {
    if (this.snapshots.length < 2) {
      return { error: 'Not enough snapshots for analysis' };
    }
    
    // Calculate growth rate
    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    const duration = last.timestamp - first.timestamp;
    
    const growth = {
      rss: (last.usage.rss - first.usage.rss) / duration * 1000, // bytes per second
      heapUsed: (last.usage.heapUsed - first.usage.heapUsed) / duration * 1000
    };
    
    // Find peak usage
    let peak = { heapUsed: 0 };
    for (const snapshot of this.snapshots) {
      if (snapshot.usage.heapUsed > peak.heapUsed) {
        peak = snapshot.usage;
      }
    }
    
    return {
      duration,
      growth,
      peak,
      current: last.usage,
      samples: this.snapshots.length
    };
  }
}

// Singleton instance
export const profiler = new Profiler();

export default {
  MetricsCollector,
  FunctionProfiler,
  Profiler,
  CPUProfiler,
  MemoryProfiler,
  profiler
};
