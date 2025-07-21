/**
 * Memory Profiler for Otedama
 * 
 * Implements comprehensive memory profiling and leak detection:
 * - Heap snapshots and analysis
 * - Memory leak detection
 * - Object allocation tracking
 * - Garbage collection monitoring
 * - Memory usage alerts
 * 
 * Following performance-first principles (John Carmack)
 */

import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
import v8 from 'v8';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Memory profiler constants
const PROFILER_CONSTANTS = Object.freeze({
  // Thresholds
  MEMORY_LIMIT: 1024 * 1024 * 1024,    // 1GB
  HEAP_LIMIT: 800 * 1024 * 1024,       // 800MB
  LEAK_GROWTH_RATE: 0.1,                // 10% growth indicates potential leak
  GC_INTERVAL: 60000,                   // 1 minute
  
  // Sampling
  SAMPLE_INTERVAL: 5000,                // 5 seconds
  SNAPSHOT_INTERVAL: 300000,            // 5 minutes
  MAX_SAMPLES: 720,                     // 1 hour of samples at 5s intervals
  MAX_SNAPSHOTS: 10,                    // Keep last 10 snapshots
  
  // Analysis
  OBJECT_TRACKING_LIMIT: 1000,          // Track top 1000 objects
  ALLOCATION_TRACKING_SIZE: 1024,       // Track allocations > 1KB
  
  // Reporting
  REPORT_INTERVAL: 60000,               // 1 minute
  SNAPSHOT_DIR: './memory-snapshots'
});

/**
 * Memory sample data point
 */
class MemorySample {
  constructor() {
    const usage = process.memoryUsage();
    
    this.timestamp = Date.now();
    this.heapUsed = usage.heapUsed;
    this.heapTotal = usage.heapTotal;
    this.external = usage.external;
    this.arrayBuffers = usage.arrayBuffers;
    this.rss = usage.rss;
    
    // Calculate percentages
    this.heapUsagePercent = (usage.heapUsed / usage.heapTotal) * 100;
    this.systemUsagePercent = (usage.rss / PROFILER_CONSTANTS.MEMORY_LIMIT) * 100;
  }
}

/**
 * Object allocation tracker
 */
class AllocationTracker {
  constructor() {
    this.allocations = new Map();
    this.totalAllocations = 0;
    this.totalSize = 0;
  }

  track(type, size, stackTrace) {
    if (size < PROFILER_CONSTANTS.ALLOCATION_TRACKING_SIZE) return;
    
    const key = `${type}:${this.simplifyStack(stackTrace)}`;
    
    if (!this.allocations.has(key)) {
      this.allocations.set(key, {
        type,
        count: 0,
        totalSize: 0,
        avgSize: 0,
        lastSeen: Date.now(),
        stack: stackTrace
      });
    }
    
    const allocation = this.allocations.get(key);
    allocation.count++;
    allocation.totalSize += size;
    allocation.avgSize = allocation.totalSize / allocation.count;
    allocation.lastSeen = Date.now();
    
    this.totalAllocations++;
    this.totalSize += size;
    
    // Limit map size
    if (this.allocations.size > PROFILER_CONSTANTS.OBJECT_TRACKING_LIMIT) {
      this.pruneOldAllocations();
    }
  }

  getTopAllocations(limit = 10) {
    return Array.from(this.allocations.values())
      .sort((a, b) => b.totalSize - a.totalSize)
      .slice(0, limit);
  }

  simplifyStack(stack) {
    if (!stack) return 'unknown';
    const lines = stack.split('\n').slice(1, 3);
    return lines.map(line => {
      const match = line.match(/at\s+(.+?)\s+\(/);
      return match ? match[1] : 'anonymous';
    }).join(' <- ');
  }

  pruneOldAllocations() {
    const cutoff = Date.now() - 300000; // 5 minutes
    for (const [key, allocation] of this.allocations.entries()) {
      if (allocation.lastSeen < cutoff) {
        this.allocations.delete(key);
      }
    }
  }

  reset() {
    this.allocations.clear();
    this.totalAllocations = 0;
    this.totalSize = 0;
  }
}

/**
 * Memory leak detector
 */
class LeakDetector {
  constructor() {
    this.samples = [];
    this.leakCandidates = new Map();
  }

  addSample(sample) {
    this.samples.push(sample);
    
    // Keep only recent samples
    if (this.samples.length > PROFILER_CONSTANTS.MAX_SAMPLES) {
      this.samples.shift();
    }
  }

  detectLeaks() {
    if (this.samples.length < 10) return [];
    
    const recentSamples = this.samples.slice(-60); // Last 5 minutes
    if (recentSamples.length < 10) return [];
    
    // Calculate growth rate
    const firstSample = recentSamples[0];
    const lastSample = recentSamples[recentSamples.length - 1];
    const timeDiff = (lastSample.timestamp - firstSample.timestamp) / 1000; // seconds
    
    const heapGrowth = lastSample.heapUsed - firstSample.heapUsed;
    const heapGrowthRate = heapGrowth / firstSample.heapUsed;
    
    const leaks = [];
    
    // Check for consistent heap growth
    if (heapGrowthRate > PROFILER_CONSTANTS.LEAK_GROWTH_RATE) {
      const avgGrowthPerSecond = heapGrowth / timeDiff;
      
      leaks.push({
        type: 'heap_growth',
        severity: heapGrowthRate > 0.3 ? 'high' : 'medium',
        growthRate: heapGrowthRate,
        growthPerSecond: avgGrowthPerSecond,
        timeSpan: timeDiff,
        currentHeap: lastSample.heapUsed,
        message: `Heap growing at ${(heapGrowthRate * 100).toFixed(1)}% over ${Math.round(timeDiff)}s`
      });
    }
    
    // Check for external memory growth
    const externalGrowth = lastSample.external - firstSample.external;
    const externalGrowthRate = externalGrowth / (firstSample.external || 1);
    
    if (externalGrowthRate > PROFILER_CONSTANTS.LEAK_GROWTH_RATE) {
      leaks.push({
        type: 'external_memory',
        severity: externalGrowthRate > 0.5 ? 'high' : 'medium',
        growthRate: externalGrowthRate,
        currentExternal: lastSample.external,
        message: `External memory growing at ${(externalGrowthRate * 100).toFixed(1)}%`
      });
    }
    
    return leaks;
  }

  getMemoryTrend() {
    if (this.samples.length < 2) return null;
    
    const recent = this.samples.slice(-12); // Last minute
    const heapValues = recent.map(s => s.heapUsed);
    
    // Simple linear regression
    const n = heapValues.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = heapValues.reduce((a, b) => a + b, 0);
    const sumXY = heapValues.reduce((sum, y, x) => sum + x * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return {
      slope: slope * 1000, // Bytes per second
      direction: slope > 0 ? 'increasing' : 'decreasing',
      confidence: this.calculateConfidence(heapValues, slope, intercept)
    };
  }

  calculateConfidence(values, slope, intercept) {
    const predictions = values.map((_, i) => slope * i + intercept);
    const errors = values.map((v, i) => Math.abs(v - predictions[i]));
    const avgError = errors.reduce((a, b) => a + b, 0) / errors.length;
    const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
    
    return Math.max(0, 1 - (avgError / avgValue));
  }
}

/**
 * Object pool monitor
 */
class ObjectPoolMonitor {
  constructor() {
    this.pools = new Map();
  }

  registerPool(name, pool) {
    this.pools.set(name, {
      pool,
      stats: {
        created: 0,
        reused: 0,
        destroyed: 0
      }
    });
  }

  getPoolStats() {
    const stats = {};
    
    for (const [name, data] of this.pools.entries()) {
      const pool = data.pool;
      stats[name] = {
        ...data.stats,
        size: pool.size || 0,
        available: pool.available || 0,
        efficiency: data.stats.reused / (data.stats.created + data.stats.reused) || 0
      };
    }
    
    return stats;
  }
}

/**
 * Main Memory Profiler
 */
export class MemoryProfiler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableSnapshots: options.enableSnapshots !== false,
      enableAllocationTracking: options.enableAllocationTracking !== false,
      enableLeakDetection: options.enableLeakDetection !== false,
      enableGCMonitoring: options.enableGCMonitoring !== false,
      snapshotDir: options.snapshotDir || PROFILER_CONSTANTS.SNAPSHOT_DIR,
      ...options
    };
    
    // Components
    this.samples = [];
    this.allocationTracker = new AllocationTracker();
    this.leakDetector = new LeakDetector();
    this.objectPoolMonitor = new ObjectPoolMonitor();
    
    // State
    this.baseline = null;
    this.isRunning = false;
    this.gcStats = {
      count: 0,
      totalPause: 0,
      maxPause: 0,
      lastGC: null
    };
    
    // Setup snapshot directory
    if (this.options.enableSnapshots && !existsSync(this.options.snapshotDir)) {
      mkdirSync(this.options.snapshotDir, { recursive: true });
    }
    
    // Setup GC monitoring
    if (this.options.enableGCMonitoring) {
      this.setupGCMonitoring();
    }
  }

  /**
   * Start profiling
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.baseline = new MemorySample();
    
    // Start sampling
    this.sampleInterval = setInterval(() => {
      this.takeSample();
    }, PROFILER_CONSTANTS.SAMPLE_INTERVAL);
    
    // Start snapshot interval
    if (this.options.enableSnapshots) {
      this.snapshotInterval = setInterval(() => {
        this.takeSnapshot();
      }, PROFILER_CONSTANTS.SNAPSHOT_INTERVAL);
    }
    
    // Start reporting
    this.reportInterval = setInterval(() => {
      this.generateReport();
    }, PROFILER_CONSTANTS.REPORT_INTERVAL);
    
    this.emit('started');
  }

  /**
   * Stop profiling
   */
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.sampleInterval) {
      clearInterval(this.sampleInterval);
      this.sampleInterval = null;
    }
    
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
    
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
    
    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.gcObserver = null;
    }
    
    this.emit('stopped');
  }

  /**
   * Take a memory sample
   */
  takeSample() {
    const sample = new MemorySample();
    this.samples.push(sample);
    
    // Keep only recent samples
    if (this.samples.length > PROFILER_CONSTANTS.MAX_SAMPLES) {
      this.samples.shift();
    }
    
    // Add to leak detector
    if (this.options.enableLeakDetection) {
      this.leakDetector.addSample(sample);
      
      // Check for leaks periodically
      if (this.samples.length % 12 === 0) { // Every minute
        const leaks = this.leakDetector.detectLeaks();
        if (leaks.length > 0) {
          this.emit('leak:detected', leaks);
        }
      }
    }
    
    // Check thresholds
    this.checkThresholds(sample);
    
    this.emit('sample', sample);
  }

  /**
   * Take a heap snapshot
   */
  async takeSnapshot(name = null) {
    if (!this.options.enableSnapshots) return null;
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = name || `heap-${timestamp}.heapsnapshot`;
    const filepath = join(this.options.snapshotDir, filename);
    
    try {
      const snapshot = v8.writeHeapSnapshot(filepath);
      
      this.emit('snapshot:created', { 
        path: filepath,
        size: snapshot
      });
      
      // Cleanup old snapshots
      this.cleanupSnapshots();
      
      return filepath;
    } catch (error) {
      this.emit('snapshot:error', error);
      return null;
    }
  }

  /**
   * Force garbage collection (if --expose-gc flag is set)
   */
  forceGC() {
    if (global.gc) {
      const before = process.memoryUsage().heapUsed;
      global.gc();
      const after = process.memoryUsage().heapUsed;
      const freed = before - after;
      
      this.emit('gc:forced', { 
        before, 
        after, 
        freed,
        freedMB: (freed / 1024 / 1024).toFixed(2)
      });
      
      return freed;
    }
    
    return 0;
  }

  /**
   * Get current memory usage
   */
  getCurrentUsage() {
    const sample = new MemorySample();
    const baseline = this.baseline || sample;
    
    return {
      current: {
        heapUsed: sample.heapUsed,
        heapTotal: sample.heapTotal,
        external: sample.external,
        rss: sample.rss,
        heapUsagePercent: sample.heapUsagePercent,
        systemUsagePercent: sample.systemUsagePercent
      },
      delta: {
        heapUsed: sample.heapUsed - baseline.heapUsed,
        heapTotal: sample.heapTotal - baseline.heapTotal,
        external: sample.external - baseline.external,
        rss: sample.rss - baseline.rss
      },
      formatted: {
        heapUsed: this.formatBytes(sample.heapUsed),
        heapTotal: this.formatBytes(sample.heapTotal),
        external: this.formatBytes(sample.external),
        rss: this.formatBytes(sample.rss)
      }
    };
  }

  /**
   * Get memory statistics
   */
  getStats() {
    const current = this.getCurrentUsage();
    const trend = this.leakDetector.getMemoryTrend();
    const poolStats = this.objectPoolMonitor.getPoolStats();
    
    return {
      ...current,
      trend,
      samples: this.samples.length,
      gc: { ...this.gcStats },
      allocations: {
        total: this.allocationTracker.totalAllocations,
        totalSize: this.allocationTracker.totalSize,
        tracked: this.allocationTracker.allocations.size,
        top: this.allocationTracker.getTopAllocations(5)
      },
      pools: poolStats,
      uptime: this.baseline ? Date.now() - this.baseline.timestamp : 0
    };
  }

  /**
   * Generate memory report
   */
  generateReport() {
    const stats = this.getStats();
    const leaks = this.leakDetector.detectLeaks();
    
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        heapUsed: stats.formatted.heapUsed,
        heapPercent: stats.current.heapUsagePercent.toFixed(1) + '%',
        trend: stats.trend ? `${stats.trend.direction} at ${this.formatBytes(Math.abs(stats.trend.slope))}/s` : 'stable',
        gcCount: stats.gc.count,
        leaks: leaks.length
      },
      details: stats,
      alerts: []
    };
    
    // Add alerts
    if (stats.current.heapUsagePercent > 80) {
      report.alerts.push({
        level: 'warning',
        message: `High heap usage: ${stats.current.heapUsagePercent.toFixed(1)}%`
      });
    }
    
    if (stats.current.heapUsed > PROFILER_CONSTANTS.HEAP_LIMIT) {
      report.alerts.push({
        level: 'critical',
        message: `Heap limit exceeded: ${stats.formatted.heapUsed}`
      });
    }
    
    if (leaks.length > 0) {
      report.alerts.push({
        level: 'warning',
        message: `Potential memory leaks detected: ${leaks.length}`
      });
    }
    
    this.emit('report', report);
    
    return report;
  }

  /**
   * Register object pool for monitoring
   */
  registerObjectPool(name, pool) {
    this.objectPoolMonitor.registerPool(name, pool);
  }

  /**
   * Track allocation manually
   */
  trackAllocation(type, size, stackTrace = null) {
    if (!this.options.enableAllocationTracking) return;
    
    this.allocationTracker.track(
      type, 
      size, 
      stackTrace || new Error().stack
    );
  }

  // Private methods

  setupGCMonitoring() {
    try {
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        
        for (const entry of entries) {
          if (entry.kind === 1) { // Major GC
            this.gcStats.count++;
            this.gcStats.totalPause += entry.duration;
            this.gcStats.maxPause = Math.max(this.gcStats.maxPause, entry.duration);
            this.gcStats.lastGC = {
              timestamp: Date.now(),
              duration: entry.duration,
              type: 'major'
            };
            
            this.emit('gc', {
              type: 'major',
              duration: entry.duration
            });
          }
        }
      });
      
      obs.observe({ entryTypes: ['gc'] });
      this.gcObserver = obs;
    } catch (error) {
      this.emit('error', {
        type: 'gc_monitoring',
        error: error.message
      });
    }
  }

  checkThresholds(sample) {
    // Check heap usage
    if (sample.heapUsed > PROFILER_CONSTANTS.HEAP_LIMIT) {
      this.emit('threshold:exceeded', {
        type: 'heap',
        value: sample.heapUsed,
        limit: PROFILER_CONSTANTS.HEAP_LIMIT,
        severity: 'critical'
      });
    } else if (sample.heapUsagePercent > 80) {
      this.emit('threshold:exceeded', {
        type: 'heap_percent',
        value: sample.heapUsagePercent,
        limit: 80,
        severity: 'warning'
      });
    }
    
    // Check RSS
    if (sample.rss > PROFILER_CONSTANTS.MEMORY_LIMIT) {
      this.emit('threshold:exceeded', {
        type: 'rss',
        value: sample.rss,
        limit: PROFILER_CONSTANTS.MEMORY_LIMIT,
        severity: 'critical'
      });
    }
  }

  cleanupSnapshots() {
    try {
      const files = readdirSync(this.options.snapshotDir)
        .filter(f => f.endsWith('.heapsnapshot'))
        .map(f => ({
          name: f,
          path: join(this.options.snapshotDir, f),
          mtime: statSync(join(this.options.snapshotDir, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime);
      
      if (files.length > PROFILER_CONSTANTS.MAX_SNAPSHOTS) {
        const toDelete = files.slice(PROFILER_CONSTANTS.MAX_SNAPSHOTS);
        for (const file of toDelete) {
          unlinkSync(file.path);
        }
      }
    } catch (error) {
      this.emit('error', {
        type: 'snapshot_cleanup',
        error: error.message
      });
    }
  }

  formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    
    return `${value.toFixed(2)} ${units[unit]}`;
  }

  /**
   * Reset profiler state
   */
  reset() {
    this.samples = [];
    this.allocationTracker.reset();
    this.leakDetector = new LeakDetector();
    this.baseline = new MemorySample();
    this.gcStats = {
      count: 0,
      totalPause: 0,
      maxPause: 0,
      lastGC: null
    };
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    this.stop();
    this.removeAllListeners();
  }
}

export default MemoryProfiler;