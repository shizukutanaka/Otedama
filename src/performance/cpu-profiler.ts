// src/performance/cpu-profiler.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { performance } from 'perf_hooks';
import { cpuUsage } from 'process';
import { EventEmitter } from 'events';
import * as v8 from 'v8';

export interface CPUSnapshot {
  timestamp: number;
  user: number; // microseconds
  system: number; // microseconds
  total: number; // microseconds
  usage: number; // percentage
  loadAverage: number[];
  activeHandles: number;
  activeRequests: number;
}

export interface CPUProfilerConfig {
  enabled: boolean;
  sampleInterval: number; // milliseconds
  maxSamples: number;
  thresholds: {
    usage: number; // percentage
    loadAverage: number;
    sustainedHighUsage: {
      threshold: number; // percentage
      duration: number; // milliseconds
    };
  };
  profiling: {
    enabled: boolean;
    duration: number; // milliseconds for sampling
    sampleRate: number; // samples per second
  };
}

export interface CPUProfile {
  id: string;
  timestamp: number;
  duration: number;
  samples: CPUSample[];
  summary: CPUProfileSummary;
  hotFunctions: HotFunction[];
}

export interface CPUSample {
  timestamp: number;
  stackTrace: string[];
  hitCount: number;
}

export interface CPUProfileSummary {
  totalSamples: number;
  selfTime: number;
  totalTime: number;
  topFunctions: string[];
  cpuIntensive: boolean;
}

export interface HotFunction {
  name: string;
  selfTime: number;
  totalTime: number;
  hitCount: number;
  percentage: number;
  optimizable: boolean;
  recommendations: string[];
}

export interface CPUAnalysis {
  avgUsage: number;
  peakUsage: number;
  trend: 'stable' | 'increasing' | 'decreasing' | 'volatile';
  sustainedHighUsage: boolean;
  loadBalance: 'good' | 'moderate' | 'poor';
  bottlenecks: string[];
  recommendations: string[];
  efficiency: number; // 0-100
}

export interface CPUAlert {
  type: 'high_usage' | 'sustained_load' | 'load_spike' | 'inefficiency';
  timestamp: number;
  value: number;
  threshold: number;
  duration?: number;
  message: string;
}

export class CPUProfiler extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private config: CPUProfilerConfig;
  private isActive: boolean = false;
  private snapshots: CPUSnapshot[] = [];
  private profiles: Map<string, CPUProfile> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private cpuBaseline: { user: number; system: number } = { user: 0, system: 0 };
  private highUsageStartTime: number | null = null;
  private functionTimings: Map<string, { totalTime: number; callCount: number }> = new Map();

  constructor(config: CPUProfilerConfig, logger: Logger, cache: RedisCache) {
    super();
    this.config = config;
    this.logger = logger;
    this.cache = cache;

    if (config.enabled) {
      this.initialize();
    }
  }

  private initialize(): void {
    this.cpuBaseline = cpuUsage();
    this.startCPUMonitoring();
    
    this.logger.info('CPU profiler initialized', {
      sampleInterval: this.config.sampleInterval,
      profiling: this.config.profiling.enabled,
      thresholds: this.config.thresholds
    });
  }

  private startCPUMonitoring(): void {
    const timer = setInterval(() => {
      if (!this.isActive) return;

      const snapshot = this.takeCPUSnapshot();
      this.snapshots.push(snapshot);

      // Limit snapshots
      if (this.snapshots.length > this.config.maxSamples) {
        this.snapshots = this.snapshots.slice(-this.config.maxSamples);
      }

      // Check thresholds
      this.checkThresholds(snapshot);

      this.emit('cpu-snapshot', snapshot);
    }, this.config.sampleInterval);

    this.timers.set('cpu-monitoring', timer);
  }

  private takeCPUSnapshot(): CPUSnapshot {
    const cpuData = cpuUsage(this.cpuBaseline);
    const totalCPU = cpuData.user + cpuData.system;
    
    // Calculate CPU usage percentage
    const intervalMs = this.config.sampleInterval;
    const usage = ((totalCPU / 1000) / intervalMs) * 100; // Convert to percentage

    // Get load average (Unix-like systems)
    let loadAverage: number[] = [];
    try {
      const os = require('os');
      loadAverage = os.loadavg();
    } catch (error) {
      // Fallback for systems without load average
      loadAverage = [0, 0, 0];
    }

    const snapshot: CPUSnapshot = {
      timestamp: Date.now(),
      user: cpuData.user,
      system: cpuData.system,
      total: totalCPU,
      usage: Math.min(100, Math.max(0, usage)), // Clamp between 0-100
      loadAverage,
      activeHandles: (process as any)._getActiveHandles?.()?.length || 0,
      activeRequests: (process as any)._getActiveRequests?.()?.length || 0
    };

    // Update baseline for next measurement
    this.cpuBaseline = cpuUsage();

    return snapshot;
  }

  private checkThresholds(snapshot: CPUSnapshot): void {
    // High CPU usage threshold
    if (snapshot.usage > this.config.thresholds.usage) {
      if (this.highUsageStartTime === null) {
        this.highUsageStartTime = snapshot.timestamp;
      }

      const alert: CPUAlert = {
        type: 'high_usage',
        timestamp: snapshot.timestamp,
        value: snapshot.usage,
        threshold: this.config.thresholds.usage,
        message: `CPU usage is ${snapshot.usage.toFixed(1)}%, exceeding threshold of ${this.config.thresholds.usage}%`
      };

      this.emit('cpu-alert', alert);

      // Check sustained high usage
      const duration = snapshot.timestamp - this.highUsageStartTime;
      if (duration > this.config.thresholds.sustainedHighUsage.duration) {
        const sustainedAlert: CPUAlert = {
          type: 'sustained_load',
          timestamp: snapshot.timestamp,
          value: snapshot.usage,
          threshold: this.config.thresholds.sustainedHighUsage.threshold,
          duration,
          message: `Sustained high CPU usage for ${duration}ms`
        };

        this.emit('cpu-alert', sustainedAlert);
      }
    } else {
      this.highUsageStartTime = null;
    }

    // Load average threshold
    if (snapshot.loadAverage[0] > this.config.thresholds.loadAverage) {
      const alert: CPUAlert = {
        type: 'load_spike',
        timestamp: snapshot.timestamp,
        value: snapshot.loadAverage[0],
        threshold: this.config.thresholds.loadAverage,
        message: `Load average (1m) is ${snapshot.loadAverage[0].toFixed(2)}, exceeding threshold of ${this.config.thresholds.loadAverage}`
      };

      this.emit('cpu-alert', alert);
    }
  }

  // CPU Profiling with sampling
  public async startProfiling(duration?: number): Promise<string> {
    if (!this.config.profiling.enabled) {
      throw new Error('CPU profiling is disabled in configuration');
    }

    const profileId = `cpu_prof_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const profileDuration = duration || this.config.profiling.duration;

    this.logger.info(`Starting CPU profiling session: ${profileId}`, { duration: profileDuration });

    // Start V8 CPU profiler if available
    let v8ProfilerStarted = false;
    try {
      if (v8.startDebugging) {
        v8.startDebugging();
        v8ProfilerStarted = true;
      }
    } catch (error) {
      this.logger.debug('V8 profiler not available, using manual sampling');
    }

    const samples: CPUSample[] = [];
    const startTime = performance.now();
    const sampleInterval = 1000 / this.config.profiling.sampleRate; // ms per sample

    // Manual sampling (simplified)
    const samplingTimer = setInterval(() => {
      const sample = this.takeSample();
      if (sample) {
        samples.push(sample);
      }
    }, sampleInterval);

    // Stop profiling after duration
    return new Promise((resolve) => {
      setTimeout(() => {
        clearInterval(samplingTimer);

        if (v8ProfilerStarted) {
          try {
            v8.stopDebugging();
          } catch (error) {
            this.logger.debug('Error stopping V8 profiler:', error);
          }
        }

        const endTime = performance.now();
        const actualDuration = endTime - startTime;

        const profile: CPUProfile = {
          id: profileId,
          timestamp: Date.now(),
          duration: actualDuration,
          samples,
          summary: this.generateProfileSummary(samples),
          hotFunctions: this.identifyHotFunctions(samples)
        };

        this.profiles.set(profileId, profile);
        this.logger.info(`CPU profiling completed: ${profileId}`, { 
          samples: samples.length,
          duration: actualDuration 
        });

        this.emit('profiling-completed', profile);
        resolve(profileId);
      }, profileDuration);
    });
  }

  private takeSample(): CPUSample | null {
    try {
      // Get stack trace (simplified approach)
      const error = new Error();
      const stack = error.stack?.split('\n').slice(1) || [];
      
      // Clean up stack trace
      const stackTrace = stack
        .map(line => line.trim())
        .filter(line => line.startsWith('at '))
        .map(line => line.substring(3))
        .slice(0, 10); // Limit depth

      return {
        timestamp: performance.now(),
        stackTrace,
        hitCount: 1
      };
    } catch (error) {
      return null;
    }
  }

  private generateProfileSummary(samples: CPUSample[]): CPUProfileSummary {
    const totalSamples = samples.length;
    const functionCounts = new Map<string, number>();

    // Count function occurrences
    samples.forEach(sample => {
      sample.stackTrace.forEach(func => {
        functionCounts.set(func, (functionCounts.get(func) || 0) + 1);
      });
    });

    // Get top functions
    const topFunctions = Array.from(functionCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([func]) => func);

    // Estimate if CPU intensive
    const cpuIntensive = totalSamples > 100 && this.getRecentCPUUsage() > 50;

    return {
      totalSamples,
      selfTime: 0, // Would be calculated from detailed timing
      totalTime: 0, // Would be calculated from detailed timing
      topFunctions,
      cpuIntensive
    };
  }

  private identifyHotFunctions(samples: CPUSample[]): HotFunction[] {
    const functionStats = new Map<string, { hits: number; selfTime: number }>();

    // Analyze samples
    samples.forEach(sample => {
      sample.stackTrace.forEach((func, depth) => {
        if (!functionStats.has(func)) {
          functionStats.set(func, { hits: 0, selfTime: 0 });
        }
        
        const stats = functionStats.get(func)!;
        stats.hits++;
        
        // Estimate self time (functions at top of stack get more credit)
        stats.selfTime += depth === 0 ? 1.0 : 1.0 / (depth + 1);
      });
    });

    // Convert to HotFunction objects
    const hotFunctions: HotFunction[] = [];
    
    for (const [name, stats] of functionStats.entries()) {
      if (stats.hits < 3) continue; // Filter out low-frequency functions

      const percentage = (stats.hits / samples.length) * 100;
      const hotFunction: HotFunction = {
        name,
        selfTime: stats.selfTime,
        totalTime: stats.hits, // Simplified
        hitCount: stats.hits,
        percentage,
        optimizable: this.isFunctionOptimizable(name),
        recommendations: this.generateFunctionRecommendations(name, stats)
      };

      hotFunctions.push(hotFunction);
    }

    // Sort by percentage and return top 20
    return hotFunctions
      .sort((a, b) => b.percentage - a.percentage)
      .slice(0, 20);
  }

  private isFunctionOptimizable(functionName: string): boolean {
    // Simple heuristics for optimization potential
    const optimizablePatterns = [
      /for.*loop/i,
      /array.*map|filter|reduce/i,
      /json.*parse|stringify/i,
      /database.*query/i,
      /file.*read|write/i,
      /crypto.*hash/i
    ];

    return optimizablePatterns.some(pattern => pattern.test(functionName));
  }

  private generateFunctionRecommendations(functionName: string, stats: any): string[] {
    const recommendations: string[] = [];

    if (stats.hits > 100) {
      recommendations.push('High frequency function - consider caching results');
    }

    if (functionName.includes('sync')) {
      recommendations.push('Synchronous operation detected - consider async alternative');
    }

    if (functionName.includes('JSON')) {
      recommendations.push('JSON operations - consider using faster parsers or reducing data size');
    }

    if (functionName.includes('loop') || functionName.includes('forEach')) {
      recommendations.push('Loop detected - consider optimizing algorithm or using native methods');
    }

    return recommendations;
  }

  private getRecentCPUUsage(): number {
    if (this.snapshots.length === 0) return 0;
    
    const recentSnapshots = this.snapshots.slice(-5);
    const avgUsage = recentSnapshots.reduce((sum, s) => sum + s.usage, 0) / recentSnapshots.length;
    
    return avgUsage;
  }

  // Public API
  public start(): void {
    this.isActive = true;
    this.logger.info('CPU profiler started');
  }

  public stop(): void {
    this.isActive = false;
    this.logger.info('CPU profiler stopped');
  }

  public getCurrentSnapshot(): CPUSnapshot {
    return this.takeCPUSnapshot();
  }

  public getSnapshots(count?: number): CPUSnapshot[] {
    if (count) {
      return this.snapshots.slice(-count);
    }
    return [...this.snapshots];
  }

  public getProfile(profileId: string): CPUProfile | undefined {
    return this.profiles.get(profileId);
  }

  public getProfiles(): CPUProfile[] {
    return Array.from(this.profiles.values());
  }

  public analyzeCPUUsage(timeWindowMinutes: number = 30): CPUAnalysis {
    const windowMs = timeWindowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const relevantSnapshots = this.snapshots.filter(s => s.timestamp >= cutoff);
    
    if (relevantSnapshots.length < 2) {
      return this.createEmptyAnalysis();
    }

    const usageValues = relevantSnapshots.map(s => s.usage);
    const avgUsage = usageValues.reduce((sum, val) => sum + val, 0) / usageValues.length;
    const peakUsage = Math.max(...usageValues);

    // Calculate trend
    const trend = this.calculateCPUTrend(relevantSnapshots);

    // Check sustained high usage
    const sustainedHighUsage = this.checkSustainedHighUsage(relevantSnapshots);

    // Analyze load balance
    const loadBalance = this.analyzeLoadBalance(relevantSnapshots);

    // Identify bottlenecks
    const bottlenecks = this.identifyBottlenecks(relevantSnapshots);

    // Calculate efficiency
    const efficiency = this.calculateCPUEfficiency(relevantSnapshots);

    // Generate recommendations
    const recommendations = this.generateCPURecommendations(
      avgUsage, peakUsage, trend, sustainedHighUsage, loadBalance, bottlenecks
    );

    return {
      avgUsage,
      peakUsage,
      trend,
      sustainedHighUsage,
      loadBalance,
      bottlenecks,
      recommendations,
      efficiency
    };
  }

  private calculateCPUTrend(snapshots: CPUSnapshot[]): CPUAnalysis['trend'] {
    if (snapshots.length < 3) return 'stable';

    const values = snapshots.map(s => s.usage);
    const variance = this.calculateVariance(values);

    // High variance indicates volatility
    if (variance > 400) return 'volatile';

    // Check overall trend
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));

    const firstAvg = firstHalf.reduce((sum, val) => sum + val, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, val) => sum + val, 0) / secondHalf.length;

    const difference = secondAvg - firstAvg;

    if (Math.abs(difference) < 5) return 'stable';
    return difference > 0 ? 'increasing' : 'decreasing';
  }

  private checkSustainedHighUsage(snapshots: CPUSnapshot[]): boolean {
    const threshold = this.config.thresholds.sustainedHighUsage.threshold;
    const minDuration = this.config.thresholds.sustainedHighUsage.duration;

    let highUsageStart: number | null = null;

    for (const snapshot of snapshots) {
      if (snapshot.usage > threshold) {
        if (highUsageStart === null) {
          highUsageStart = snapshot.timestamp;
        } else if (snapshot.timestamp - highUsageStart >= minDuration) {
          return true;
        }
      } else {
        highUsageStart = null;
      }
    }

    return false;
  }

  private analyzeLoadBalance(snapshots: CPUSnapshot[]): CPUAnalysis['loadBalance'] {
    // Simplified load balance analysis based on load average
    const loadAverages = snapshots.map(s => s.loadAverage[0]).filter(la => la > 0);
    
    if (loadAverages.length === 0) return 'good';

    const avgLoad = loadAverages.reduce((sum, val) => sum + val, 0) / loadAverages.length;
    const cores = require('os').cpus().length;
    const loadRatio = avgLoad / cores;

    if (loadRatio < 0.7) return 'good';
    if (loadRatio < 1.2) return 'moderate';
    return 'poor';
  }

  private identifyBottlenecks(snapshots: CPUSnapshot[]): string[] {
    const bottlenecks: string[] = [];

    // High CPU usage
    const avgUsage = snapshots.reduce((sum, s) => sum + s.usage, 0) / snapshots.length;
    if (avgUsage > 80) {
      bottlenecks.push('High CPU utilization');
    }

    // High load average
    const avgLoad = snapshots
      .map(s => s.loadAverage[0])
      .filter(la => la > 0)
      .reduce((sum, val, _, arr) => sum + val / arr.length, 0);
    
    if (avgLoad > require('os').cpus().length) {
      bottlenecks.push('High load average indicates system overload');
    }

    // Many active handles/requests
    const avgHandles = snapshots.reduce((sum, s) => sum + s.activeHandles, 0) / snapshots.length;
    const avgRequests = snapshots.reduce((sum, s) => sum + s.activeRequests, 0) / snapshots.length;

    if (avgHandles > 100) {
      bottlenecks.push('High number of active handles');
    }

    if (avgRequests > 50) {
      bottlenecks.push('High number of active requests');
    }

    return bottlenecks;
  }

  private calculateCPUEfficiency(snapshots: CPUSnapshot[]): number {
    // Simplified efficiency calculation
    const totalUsage = snapshots.reduce((sum, s) => sum + s.usage, 0);
    const maxPossibleUsage = snapshots.length * 100;
    
    return (totalUsage / maxPossibleUsage) * 100;
  }

  private generateCPURecommendations(
    avgUsage: number,
    peakUsage: number,
    trend: CPUAnalysis['trend'],
    sustainedHighUsage: boolean,
    loadBalance: CPUAnalysis['loadBalance'],
    bottlenecks: string[]
  ): string[] {
    const recommendations: string[] = [];

    if (avgUsage > 80) {
      recommendations.push('High average CPU usage - consider scaling or optimization');
    }

    if (peakUsage > 95) {
      recommendations.push('CPU usage peaks near 100% - investigate CPU-intensive operations');
    }

    if (trend === 'increasing') {
      recommendations.push('CPU usage trending upward - monitor for potential issues');
    }

    if (trend === 'volatile') {
      recommendations.push('Volatile CPU usage - investigate sporadic workloads');
    }

    if (sustainedHighUsage) {
      recommendations.push('Sustained high CPU usage detected - immediate optimization needed');
    }

    if (loadBalance === 'poor') {
      recommendations.push('Poor load balancing - consider distributing workload or adding capacity');
    }

    if (bottlenecks.length > 0) {
      recommendations.push(`Address identified bottlenecks: ${bottlenecks.join(', ')}`);
    }

    return recommendations;
  }

  private calculateVariance(values: number[]): number {
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    return squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;
  }

  private createEmptyAnalysis(): CPUAnalysis {
    return {
      avgUsage: 0,
      peakUsage: 0,
      trend: 'stable',
      sustainedHighUsage: false,
      loadBalance: 'good',
      bottlenecks: [],
      recommendations: ['Insufficient data for analysis'],
      efficiency: 0
    };
  }

  // Function-level profiling
  public profileFunction<T>(name: string, fn: () => T): T {
    const start = performance.now();
    
    try {
      const result = fn();
      const duration = performance.now() - start;
      this.recordFunctionTiming(name, duration);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.recordFunctionTiming(name, duration);
      throw error;
    }
  }

  public async profileAsyncFunction<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    
    try {
      const result = await fn();
      const duration = performance.now() - start;
      this.recordFunctionTiming(name, duration);
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.recordFunctionTiming(name, duration);
      throw error;
    }
  }

  private recordFunctionTiming(name: string, duration: number): void {
    const current = this.functionTimings.get(name) || { totalTime: 0, callCount: 0 };
    current.totalTime += duration;
    current.callCount++;
    this.functionTimings.set(name, current);
  }

  public getFunctionTimings(): Array<{ name: string; avgTime: number; totalTime: number; callCount: number }> {
    return Array.from(this.functionTimings.entries())
      .map(([name, stats]) => ({
        name,
        avgTime: stats.totalTime / stats.callCount,
        totalTime: stats.totalTime,
        callCount: stats.callCount
      }))
      .sort((a, b) => b.totalTime - a.totalTime);
  }

  public getCPUReport(): string {
    const latest = this.snapshots[this.snapshots.length - 1];
    if (!latest) return 'No CPU data available';

    const analysis = this.analyzeCPUUsage(30);

    return `CPU Report:
- Current Usage: ${latest.usage.toFixed(1)}%
- Average Usage (30m): ${analysis.avgUsage.toFixed(1)}%
- Peak Usage: ${analysis.peakUsage.toFixed(1)}%
- Trend: ${analysis.trend}
- Load Average: ${latest.loadAverage.map(la => la.toFixed(2)).join(', ')}
- Active Handles: ${latest.activeHandles}
- Active Requests: ${latest.activeRequests}
- Profiles: ${this.profiles.size}
- Function Timings: ${this.functionTimings.size}`;
  }

  public clearOldData(maxAge: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const originalLength = this.snapshots.length;
    
    this.snapshots = this.snapshots.filter(snapshot => snapshot.timestamp >= cutoff);
    
    // Clear old profiles
    for (const [id, profile] of this.profiles.entries()) {
      if (profile.timestamp < cutoff) {
        this.profiles.delete(id);
      }
    }

    const removed = originalLength - this.snapshots.length;
    if (removed > 0) {
      this.logger.info(`Cleared ${removed} old CPU snapshots`);
    }
    
    return removed;
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
    this.profiles.clear();
    this.functionTimings.clear();

    this.logger.info('CPU profiler destroyed');
  }
}
