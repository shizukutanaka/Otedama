// src/performance/memory-profiler.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { performance } from 'perf_hooks';
import { memoryUsage } from 'process';
import * as v8 from 'v8';
import { EventEmitter } from 'events';

export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  v8HeapStats: v8.HeapStatistics;
  v8HeapSpaceStats: v8.HeapSpaceStatistics[];
}

export interface MemoryLeak {
  objectType: string;
  count: number;
  sizeDelta: number;
  retainedSize: number;
  firstDetected: number;
  lastSeen: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  growthRate: number; // objects per second
}

export interface MemoryProfilerConfig {
  enabled: boolean;
  snapshotInterval: number; // milliseconds
  maxSnapshots: number;
  leakDetection: {
    enabled: boolean;
    thresholdGrowth: number; // MB per minute
    minSampleSize: number;
    maxObjectGrowth: number; // objects per minute
  };
  heapDumpTrigger: {
    enabled: boolean;
    memoryThreshold: number; // MB
    growthThreshold: number; // MB per minute
  };
  gcAnalysis: {
    enabled: boolean;
    trackStats: boolean;
  };
}

export interface HeapDump {
  id: string;
  timestamp: number;
  filePath: string;
  heapUsed: number;
  reason: string;
  metadata: any;
}

export interface GCStats {
  totalCollections: number;
  totalTime: number;
  avgPauseTime: number;
  maxPauseTime: number;
  minPauseTime: number;
  collections: {
    minor: number;
    major: number;
    incremental: number;
  };
  timeSpent: {
    minor: number;
    major: number;
    incremental: number;
  };
}

export interface MemoryAnalysis {
  trend: 'stable' | 'growing' | 'shrinking' | 'oscillating';
  growthRate: number; // MB per minute
  peakUsage: number;
  avgUsage: number;
  memoryEfficiency: number; // percentage
  leaks: MemoryLeak[];
  recommendations: string[];
  heapFragmentation: number;
  gcPressure: 'low' | 'medium' | 'high';
}

export class MemoryProfiler extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private config: MemoryProfilerConfig;
  private isActive: boolean = false;
  private snapshots: MemorySnapshot[] = [];
  private objectCounts: Map<string, { count: number; size: number; timestamp: number }[]> = new Map();
  private gcStats: GCStats;
  private heapDumps: HeapDump[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private baseline: MemorySnapshot | null = null;

  constructor(config: MemoryProfilerConfig, logger: Logger, cache: RedisCache) {
    super();
    this.config = config;
    this.logger = logger;
    this.cache = cache;
    this.gcStats = this.initializeGCStats();

    if (config.enabled) {
      this.initialize();
    }
  }

  private initialize(): void {
    this.startSnapshotCollection();
    
    if (this.config.gcAnalysis.enabled) {
      this.setupGCMonitoring();
    }

    this.logger.info('Memory profiler initialized', {
      snapshotInterval: this.config.snapshotInterval,
      leakDetection: this.config.leakDetection.enabled,
      heapDumpTrigger: this.config.heapDumpTrigger.enabled
    });
  }

  private startSnapshotCollection(): void {
    // Take initial baseline
    this.baseline = this.takeSnapshot();
    this.snapshots.push(this.baseline);

    const timer = setInterval(() => {
      if (!this.isActive) return;

      const snapshot = this.takeSnapshot();
      this.snapshots.push(snapshot);

      // Limit snapshots to prevent memory issues
      if (this.snapshots.length > this.config.maxSnapshots) {
        this.snapshots = this.snapshots.slice(-this.config.maxSnapshots);
      }

      // Check for memory leaks
      if (this.config.leakDetection.enabled) {
        this.detectMemoryLeaks();
      }

      // Check for heap dump trigger
      if (this.config.heapDumpTrigger.enabled) {
        this.checkHeapDumpTrigger(snapshot);
      }

      this.emit('snapshot-taken', snapshot);
    }, this.config.snapshotInterval);

    this.timers.set('snapshot-collection', timer);
  }

  private takeSnapshot(): MemorySnapshot {
    const mem = memoryUsage();
    const v8Stats = v8.getHeapStatistics();
    const v8SpaceStats = v8.getHeapSpaceStatistics();

    return {
      timestamp: Date.now(),
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      rss: mem.rss,
      v8HeapStats: v8Stats,
      v8HeapSpaceStats: v8SpaceStats
    };
  }

  private setupGCMonitoring(): void {
    // Hook into GC events using performance observer
    const { PerformanceObserver } = require('perf_hooks');
    
    const gcObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach(entry => {
        this.recordGCEvent(entry);
      });
    });

    try {
      gcObserver.observe({ entryTypes: ['gc'] });
    } catch (error) {
      this.logger.warn('GC monitoring not available in this Node.js version');
    }
  }

  private recordGCEvent(entry: any): void {
    const duration = entry.duration;
    const kind = entry.detail?.kind || 'unknown';

    this.gcStats.totalCollections++;
    this.gcStats.totalTime += duration;

    // Update min/max pause times
    if (this.gcStats.maxPauseTime === 0) {
      this.gcStats.maxPauseTime = duration;
      this.gcStats.minPauseTime = duration;
    } else {
      this.gcStats.maxPauseTime = Math.max(this.gcStats.maxPauseTime, duration);
      this.gcStats.minPauseTime = Math.min(this.gcStats.minPauseTime, duration);
    }

    this.gcStats.avgPauseTime = this.gcStats.totalTime / this.gcStats.totalCollections;

    // Categorize by GC type
    switch (kind) {
      case 'minor':
        this.gcStats.collections.minor++;
        this.gcStats.timeSpent.minor += duration;
        break;
      case 'major':
        this.gcStats.collections.major++;
        this.gcStats.timeSpent.major += duration;
        break;
      case 'incremental':
        this.gcStats.collections.incremental++;
        this.gcStats.timeSpent.incremental += duration;
        break;
    }

    // Emit warning for long GC pauses
    if (duration > 100) { // 100ms threshold
      this.emit('long-gc-pause', {
        duration,
        kind,
        timestamp: Date.now()
      });
    }
  }

  private detectMemoryLeaks(): void {
    if (this.snapshots.length < this.config.leakDetection.minSampleSize) {
      return;
    }

    const recentSnapshots = this.snapshots.slice(-this.config.leakDetection.minSampleSize);
    const timeWindow = recentSnapshots[recentSnapshots.length - 1].timestamp - recentSnapshots[0].timestamp;
    const timeWindowMinutes = timeWindow / (1000 * 60);

    // Check overall memory growth
    const startMemory = recentSnapshots[0].heapUsed / (1024 * 1024); // MB
    const endMemory = recentSnapshots[recentSnapshots.length - 1].heapUsed / (1024 * 1024); // MB
    const growthRate = (endMemory - startMemory) / timeWindowMinutes; // MB per minute

    if (growthRate > this.config.leakDetection.thresholdGrowth) {
      this.emit('memory-leak-detected', {
        type: 'overall-growth',
        growthRate,
        threshold: this.config.leakDetection.thresholdGrowth,
        timeWindow: timeWindowMinutes
      });
    }

    // Analyze heap space statistics for specific leaks
    this.analyzeHeapSpaces(recentSnapshots);
  }

  private analyzeHeapSpaces(snapshots: MemorySnapshot[]): void {
    const spaceTypes = ['new_space', 'old_space', 'code_space', 'map_space', 'large_object_space'];
    
    for (const spaceType of spaceTypes) {
      const growthRates = this.calculateSpaceGrowthRate(snapshots, spaceType);
      
      if (growthRates.length > 0) {
        const avgGrowthRate = growthRates.reduce((sum, rate) => sum + rate, 0) / growthRates.length;
        
        if (Math.abs(avgGrowthRate) > 1) { // 1 MB per minute threshold
          this.emit('heap-space-anomaly', {
            spaceType,
            growthRate: avgGrowthRate,
            trend: avgGrowthRate > 0 ? 'growing' : 'shrinking'
          });
        }
      }
    }
  }

  private calculateSpaceGrowthRate(snapshots: MemorySnapshot[], spaceType: string): number[] {
    const rates: number[] = [];
    
    for (let i = 1; i < snapshots.length; i++) {
      const current = snapshots[i];
      const previous = snapshots[i - 1];
      
      const currentSpace = current.v8HeapSpaceStats.find(s => s.space_name === spaceType);
      const previousSpace = previous.v8HeapSpaceStats.find(s => s.space_name === spaceType);
      
      if (currentSpace && previousSpace) {
        const timeDiff = (current.timestamp - previous.timestamp) / (1000 * 60); // minutes
        const sizeDiff = (currentSpace.space_used_size - previousSpace.space_used_size) / (1024 * 1024); // MB
        
        if (timeDiff > 0) {
          rates.push(sizeDiff / timeDiff);
        }
      }
    }
    
    return rates;
  }

  private checkHeapDumpTrigger(snapshot: MemorySnapshot): void {
    const heapUsedMB = snapshot.heapUsed / (1024 * 1024);
    
    // Trigger on absolute threshold
    if (heapUsedMB > this.config.heapDumpTrigger.memoryThreshold) {
      this.triggerHeapDump('memory-threshold-exceeded', { heapUsed: heapUsedMB });
      return;
    }

    // Trigger on growth rate
    if (this.snapshots.length >= 5) {
      const recentSnapshots = this.snapshots.slice(-5);
      const timeWindow = (recentSnapshots[4].timestamp - recentSnapshots[0].timestamp) / (1000 * 60);
      const memoryGrowth = (recentSnapshots[4].heapUsed - recentSnapshots[0].heapUsed) / (1024 * 1024);
      const growthRate = memoryGrowth / timeWindow;
      
      if (growthRate > this.config.heapDumpTrigger.growthThreshold) {
        this.triggerHeapDump('growth-rate-exceeded', { 
          growthRate,
          timeWindow 
        });
      }
    }
  }

  private async triggerHeapDump(reason: string, metadata: any = {}): Promise<HeapDump | null> {
    try {
      const timestamp = Date.now();
      const filename = `heap-dump-${timestamp}.heapsnapshot`;
      const filePath = `./logs/memory/${filename}`;
      
      // Create directory if it doesn't exist
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Generate heap dump (simplified - in production use v8.writeHeapSnapshot)
      v8.writeHeapSnapshot(filePath);
      
      const heapDump: HeapDump = {
        id: `dump_${timestamp}`,
        timestamp,
        filePath,
        heapUsed: this.snapshots[this.snapshots.length - 1]?.heapUsed || 0,
        reason,
        metadata
      };

      this.heapDumps.push(heapDump);
      
      // Keep only recent heap dumps
      if (this.heapDumps.length > 10) {
        const oldDump = this.heapDumps.shift();
        if (oldDump && fs.existsSync(oldDump.filePath)) {
          fs.unlinkSync(oldDump.filePath);
        }
      }

      this.logger.info(`Heap dump created: ${filename}`, { reason, metadata });
      this.emit('heap-dump-created', heapDump);
      
      return heapDump;
    } catch (error) {
      this.logger.error('Failed to create heap dump:', error);
      return null;
    }
  }

  // Public API
  public start(): void {
    this.isActive = true;
    this.logger.info('Memory profiler started');
  }

  public stop(): void {
    this.isActive = false;
    this.logger.info('Memory profiler stopped');
  }

  public getCurrentSnapshot(): MemorySnapshot {
    return this.takeSnapshot();
  }

  public getSnapshots(count?: number): MemorySnapshot[] {
    if (count) {
      return this.snapshots.slice(-count);
    }
    return [...this.snapshots];
  }

  public getGCStats(): GCStats {
    return { ...this.gcStats };
  }

  public getHeapDumps(): HeapDump[] {
    return [...this.heapDumps];
  }

  public analyzeMemoryUsage(timeWindowMinutes: number = 30): MemoryAnalysis {
    const windowMs = timeWindowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const relevantSnapshots = this.snapshots.filter(s => s.timestamp >= cutoff);
    
    if (relevantSnapshots.length < 2) {
      return this.createEmptyAnalysis();
    }

    // Calculate trend and growth rate
    const { trend, growthRate } = this.calculateTrend(relevantSnapshots);
    
    // Calculate memory statistics
    const heapValues = relevantSnapshots.map(s => s.heapUsed);
    const peakUsage = Math.max(...heapValues);
    const avgUsage = heapValues.reduce((sum, val) => sum + val, 0) / heapValues.length;
    
    // Calculate memory efficiency
    const heapTotalValues = relevantSnapshots.map(s => s.heapTotal);
    const avgHeapTotal = heapTotalValues.reduce((sum, val) => sum + val, 0) / heapTotalValues.length;
    const memoryEfficiency = (avgUsage / avgHeapTotal) * 100;
    
    // Analyze heap fragmentation
    const heapFragmentation = this.calculateHeapFragmentation(relevantSnapshots);
    
    // Determine GC pressure
    const gcPressure = this.calculateGCPressure();
    
    // Generate recommendations
    const recommendations = this.generateMemoryRecommendations(trend, growthRate, memoryEfficiency, gcPressure);

    return {
      trend,
      growthRate,
      peakUsage,
      avgUsage,
      memoryEfficiency,
      leaks: [], // TODO: Implement leak detection results
      recommendations,
      heapFragmentation,
      gcPressure
    };
  }

  private calculateTrend(snapshots: MemorySnapshot[]): { trend: MemoryAnalysis['trend'], growthRate: number } {
    if (snapshots.length < 2) {
      return { trend: 'stable', growthRate: 0 };
    }

    const values = snapshots.map(s => s.heapUsed);
    const timeValues = snapshots.map(s => s.timestamp);
    
    // Simple linear regression
    const n = values.length;
    const sumX = timeValues.reduce((sum, t) => sum + t, 0);
    const sumY = values.reduce((sum, v) => sum + v, 0);
    const sumXY = timeValues.reduce((acc, t, i) => acc + t * values[i], 0);
    const sumXX = timeValues.reduce((acc, t) => acc + t * t, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    // Convert slope to MB per minute
    const growthRate = (slope * 60 * 1000) / (1024 * 1024);
    
    let trend: MemoryAnalysis['trend'];
    if (Math.abs(growthRate) < 0.1) {
      trend = 'stable';
    } else if (growthRate > 0) {
      trend = 'growing';
    } else {
      trend = 'shrinking';
    }
    
    // Check for oscillation
    const changes = [];
    for (let i = 1; i < values.length; i++) {
      changes.push(values[i] - values[i - 1]);
    }
    
    const positiveChanges = changes.filter(c => c > 0).length;
    const negativeChanges = changes.filter(c => c < 0).length;
    const changeRatio = Math.min(positiveChanges, negativeChanges) / changes.length;
    
    if (changeRatio > 0.4) {
      trend = 'oscillating';
    }

    return { trend, growthRate };
  }

  private calculateHeapFragmentation(snapshots: MemorySnapshot[]): number {
    if (snapshots.length === 0) return 0;
    
    const latest = snapshots[snapshots.length - 1];
    const heapStats = latest.v8HeapStats;
    
    // Fragmentation = (heap_size_limit - used_heap_size) / heap_size_limit
    return ((heapStats.heap_size_limit - heapStats.used_heap_size) / heapStats.heap_size_limit) * 100;
  }

  private calculateGCPressure(): 'low' | 'medium' | 'high' {
    if (this.gcStats.totalCollections === 0) return 'low';
    
    const avgPauseTime = this.gcStats.avgPauseTime;
    const collectionsPerMinute = this.gcStats.totalCollections / (process.uptime() / 60);
    
    if (avgPauseTime > 50 || collectionsPerMinute > 10) {
      return 'high';
    } else if (avgPauseTime > 20 || collectionsPerMinute > 5) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  private generateMemoryRecommendations(
    trend: MemoryAnalysis['trend'],
    growthRate: number,
    efficiency: number,
    gcPressure: 'low' | 'medium' | 'high'
  ): string[] {
    const recommendations: string[] = [];

    if (trend === 'growing' && growthRate > 1) {
      recommendations.push('Memory usage is growing rapidly. Investigate potential memory leaks.');
    }

    if (efficiency < 60) {
      recommendations.push('Memory utilization is low. Consider reducing heap size or optimizing object allocation.');
    }

    if (gcPressure === 'high') {
      recommendations.push('High GC pressure detected. Consider optimizing object lifecycle or tuning GC parameters.');
    }

    if (trend === 'oscillating') {
      recommendations.push('Memory usage shows oscillating pattern. Consider connection pooling or caching optimizations.');
    }

    return recommendations;
  }

  private createEmptyAnalysis(): MemoryAnalysis {
    return {
      trend: 'stable',
      growthRate: 0,
      peakUsage: 0,
      avgUsage: 0,
      memoryEfficiency: 0,
      leaks: [],
      recommendations: ['Insufficient data for analysis'],
      heapFragmentation: 0,
      gcPressure: 'low'
    };
  }

  private initializeGCStats(): GCStats {
    return {
      totalCollections: 0,
      totalTime: 0,
      avgPauseTime: 0,
      maxPauseTime: 0,
      minPauseTime: 0,
      collections: {
        minor: 0,
        major: 0,
        incremental: 0
      },
      timeSpent: {
        minor: 0,
        major: 0,
        incremental: 0
      }
    };
  }

  public forceGC(): boolean {
    try {
      if (global.gc) {
        global.gc();
        this.logger.info('Forced garbage collection completed');
        return true;
      } else {
        this.logger.warn('Global GC not available. Start Node.js with --expose-gc flag.');
        return false;
      }
    } catch (error) {
      this.logger.error('Failed to force garbage collection:', error);
      return false;
    }
  }

  public clearOldSnapshots(maxAge: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const originalLength = this.snapshots.length;
    
    this.snapshots = this.snapshots.filter(snapshot => snapshot.timestamp >= cutoff);
    
    const removed = originalLength - this.snapshots.length;
    if (removed > 0) {
      this.logger.info(`Cleared ${removed} old memory snapshots`);
    }
    
    return removed;
  }

  public getMemoryReport(): string {
    const latest = this.snapshots[this.snapshots.length - 1];
    if (!latest) return 'No memory data available';

    const heapUsedMB = (latest.heapUsed / (1024 * 1024)).toFixed(2);
    const heapTotalMB = (latest.heapTotal / (1024 * 1024)).toFixed(2);
    const rssMB = (latest.rss / (1024 * 1024)).toFixed(2);
    const externalMB = (latest.external / (1024 * 1024)).toFixed(2);

    return `Memory Report:
- Heap Used: ${heapUsedMB} MB
- Heap Total: ${heapTotalMB} MB
- RSS: ${rssMB} MB
- External: ${externalMB} MB
- GC Collections: ${this.gcStats.totalCollections}
- Avg GC Pause: ${this.gcStats.avgPauseTime.toFixed(2)} ms
- Snapshots: ${this.snapshots.length}
- Heap Dumps: ${this.heapDumps.length}`;
  }

  public destroy(): void {
    this.isActive = false;
    
    // Clear timers
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();

    // Clear data
    this.snapshots = [];
    this.heapDumps = [];
    this.objectCounts.clear();

    this.logger.info('Memory profiler destroyed');
  }
}
