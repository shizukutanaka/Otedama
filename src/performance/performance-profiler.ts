// src/performance/performance-profiler.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { performance, PerformanceObserver } from 'perf_hooks';
import { cpuUsage, memoryUsage } from 'process';
import * as v8 from 'v8';
import { EventEmitter } from 'events';

export interface ProfilerConfig {
  enabled: boolean;
  sampleInterval: number; // milliseconds
  maxSamples: number;
  thresholds: {
    cpu: number; // percentage
    memory: number; // bytes
    latency: number; // milliseconds
    gcTime: number; // milliseconds
  };
  features: {
    cpu: boolean;
    memory: boolean;
    network: boolean;
    database: boolean;
    eventLoop: boolean;
    gc: boolean;
  };
}

export interface PerformanceMetric {
  timestamp: number;
  type: 'cpu' | 'memory' | 'network' | 'database' | 'event-loop' | 'gc' | 'custom';
  name: string;
  value: number;
  unit: string;
  tags: Record<string, string>;
  duration?: number;
  details?: any;
}

export interface ProfileSession {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  metrics: PerformanceMetric[];
  summary: ProfileSummary;
}

export interface ProfileSummary {
  totalDuration: number;
  cpuUsage: {
    avg: number;
    max: number;
    min: number;
  };
  memoryUsage: {
    avg: number;
    max: number;
    peak: number;
  };
  gcMetrics: {
    totalTime: number;
    collections: number;
    avgPause: number;
  };
  eventLoopLag: {
    avg: number;
    max: number;
    p95: number;
  };
  hotspots: Hotspot[];
  recommendations: string[];
}

export interface Hotspot {
  name: string;
  type: 'function' | 'operation' | 'query';
  totalTime: number;
  callCount: number;
  avgTime: number;
  impact: 'high' | 'medium' | 'low';
}

export interface PerformanceTrace {
  id: string;
  name: string;
  startTime: number;
  endTime: number;
  duration: number;
  tags: Record<string, string>;
  children: PerformanceTrace[];
  metadata: any;
}

export class PerformanceProfiler extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private config: ProfilerConfig;
  private isActive: boolean = false;
  private currentSession: ProfileSession | null = null;
  private sessions: Map<string, ProfileSession> = new Map();
  private observers: PerformanceObserver[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private traceStack: PerformanceTrace[] = [];
  private activeTraces: Map<string, PerformanceTrace> = new Map();
  private cpuBaseline: { user: number; system: number } = { user: 0, system: 0 };
  private eventLoopLagHistogram: number[] = [];

  constructor(config: ProfilerConfig, logger: Logger, cache: RedisCache) {
    super();
    this.config = config;
    this.logger = logger;
    this.cache = cache;

    if (config.enabled) {
      this.initialize();
    }
  }

  private initialize(): void {
    this.setupPerformanceObservers();
    this.startSystemMetricsCollection();
    this.startEventLoopMonitoring();
    
    this.logger.info('Performance profiler initialized', {
      sampleInterval: this.config.sampleInterval,
      features: this.config.features
    });
  }

  private setupPerformanceObservers(): void {
    // HTTP requests observer
    if (this.config.features.network) {
      const httpObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach(entry => {
          this.recordMetric({
            timestamp: Date.now(),
            type: 'network',
            name: 'http_request',
            value: entry.duration,
            unit: 'ms',
            tags: {
              method: (entry as any).detail?.method || 'unknown',
              url: entry.name
            },
            duration: entry.duration
          });
        });
      });
      httpObserver.observe({ entryTypes: ['measure'] });
      this.observers.push(httpObserver);
    }

    // GC observer
    if (this.config.features.gc) {
      const gcObserver = new PerformanceObserver((list) => {
        list.getEntries().forEach(entry => {
          this.recordMetric({
            timestamp: Date.now(),
            type: 'gc',
            name: 'garbage_collection',
            value: entry.duration,
            unit: 'ms',
            tags: {
              kind: (entry as any).detail?.kind || 'unknown'
            },
            duration: entry.duration
          });

          // Check GC threshold
          if (entry.duration > this.config.thresholds.gcTime) {
            this.emit('threshold-exceeded', {
              type: 'gc',
              value: entry.duration,
              threshold: this.config.thresholds.gcTime
            });
          }
        });
      });
      gcObserver.observe({ entryTypes: ['gc'] });
      this.observers.push(gcObserver);
    }
  }

  private startSystemMetricsCollection(): void {
    if (!this.config.features.cpu && !this.config.features.memory) return;

    const timer = setInterval(() => {
      if (!this.isActive) return;

      // CPU metrics
      if (this.config.features.cpu) {
        const cpuData = cpuUsage(this.cpuBaseline);
        const cpuPercent = ((cpuData.user + cpuData.system) / 1000000) / this.config.sampleInterval * 100;
        
        this.recordMetric({
          timestamp: Date.now(),
          type: 'cpu',
          name: 'cpu_usage',
          value: cpuPercent,
          unit: 'percent',
          tags: {},
          details: {
            user: cpuData.user,
            system: cpuData.system
          }
        });

        // Check CPU threshold
        if (cpuPercent > this.config.thresholds.cpu) {
          this.emit('threshold-exceeded', {
            type: 'cpu',
            value: cpuPercent,
            threshold: this.config.thresholds.cpu
          });
        }

        this.cpuBaseline = cpuUsage();
      }

      // Memory metrics
      if (this.config.features.memory) {
        const memData = memoryUsage();
        const v8HeapStats = v8.getHeapStatistics();
        
        this.recordMetric({
          timestamp: Date.now(),
          type: 'memory',
          name: 'memory_usage',
          value: memData.heapUsed,
          unit: 'bytes',
          tags: { type: 'heap_used' },
          details: {
            ...memData,
            v8: v8HeapStats
          }
        });

        // Check memory threshold
        if (memData.heapUsed > this.config.thresholds.memory) {
          this.emit('threshold-exceeded', {
            type: 'memory',
            value: memData.heapUsed,
            threshold: this.config.thresholds.memory
          });
        }
      }
    }, this.config.sampleInterval);

    this.timers.set('system-metrics', timer);
  }

  private startEventLoopMonitoring(): void {
    if (!this.config.features.eventLoop) return;

    let start = performance.now();
    
    const measureEventLoopLag = () => {
      const lag = performance.now() - start;
      this.eventLoopLagHistogram.push(lag);
      
      // Keep only recent measurements
      if (this.eventLoopLagHistogram.length > 1000) {
        this.eventLoopLagHistogram = this.eventLoopLagHistogram.slice(-1000);
      }

      this.recordMetric({
        timestamp: Date.now(),
        type: 'event-loop',
        name: 'event_loop_lag',
        value: lag,
        unit: 'ms',
        tags: {}
      });

      start = performance.now();
      setImmediate(measureEventLoopLag);
    };

    setImmediate(measureEventLoopLag);
  }

  // Session management
  public startSession(name: string): string {
    const sessionId = `prof_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.currentSession = {
      id: sessionId,
      name,
      startTime: Date.now(),
      metrics: [],
      summary: this.createEmptySummary()
    };

    this.sessions.set(sessionId, this.currentSession);
    this.isActive = true;
    this.cpuBaseline = cpuUsage();

    this.logger.info(`Profile session started: ${name}`, { sessionId });
    this.emit('session-started', { sessionId, name });

    return sessionId;
  }

  public stopSession(sessionId?: string): ProfileSession | null {
    const session = sessionId ? this.sessions.get(sessionId) : this.currentSession;
    if (!session) return null;

    session.endTime = Date.now();
    session.summary = this.generateSummary(session);

    if (session === this.currentSession) {
      this.isActive = false;
      this.currentSession = null;
    }

    this.logger.info(`Profile session stopped: ${session.name}`, { 
      sessionId: session.id,
      duration: session.endTime - session.startTime,
      metricsCount: session.metrics.length
    });

    this.emit('session-stopped', session);
    return session;
  }

  // Tracing API
  public startTrace(name: string, tags: Record<string, string> = {}): string {
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const trace: PerformanceTrace = {
      id: traceId,
      name,
      startTime: performance.now(),
      endTime: 0,
      duration: 0,
      tags,
      children: [],
      metadata: {}
    };

    this.activeTraces.set(traceId, trace);
    
    // Add to parent trace if exists
    if (this.traceStack.length > 0) {
      const parent = this.traceStack[this.traceStack.length - 1];
      parent.children.push(trace);
    }

    this.traceStack.push(trace);
    return traceId;
  }

  public endTrace(traceId: string, metadata: any = {}): PerformanceTrace | null {
    const trace = this.activeTraces.get(traceId);
    if (!trace) return null;

    trace.endTime = performance.now();
    trace.duration = trace.endTime - trace.startTime;
    trace.metadata = metadata;

    // Remove from stack and active traces
    const stackIndex = this.traceStack.findIndex(t => t.id === traceId);
    if (stackIndex >= 0) {
      this.traceStack.splice(stackIndex, 1);
    }
    this.activeTraces.delete(traceId);

    // Record as metric
    this.recordMetric({
      timestamp: Date.now(),
      type: 'custom',
      name: trace.name,
      value: trace.duration,
      unit: 'ms',
      tags: trace.tags,
      duration: trace.duration,
      details: metadata
    });

    return trace;
  }

  // Convenience tracing methods
  public async profile<T>(name: string, fn: () => Promise<T>, tags: Record<string, string> = {}): Promise<T> {
    const traceId = this.startTrace(name, tags);
    
    try {
      const result = await fn();
      this.endTrace(traceId);
      return result;
    } catch (error) {
      this.endTrace(traceId, { error: error.message });
      throw error;
    }
  }

  public profileSync<T>(name: string, fn: () => T, tags: Record<string, string> = {}): T {
    const traceId = this.startTrace(name, tags);
    
    try {
      const result = fn();
      this.endTrace(traceId);
      return result;
    } catch (error) {
      this.endTrace(traceId, { error: error.message });
      throw error;
    }
  }

  // Database operation profiling
  public profileDatabaseQuery(query: string, operation: string = 'query'): (result: any, error?: Error) => void {
    if (!this.config.features.database) {
      return () => {};
    }

    const startTime = performance.now();
    const traceId = this.startTrace(`db_${operation}`, { query: query.substring(0, 100) });

    return (result: any, error?: Error) => {
      const duration = performance.now() - startTime;
      
      this.recordMetric({
        timestamp: Date.now(),
        type: 'database',
        name: 'database_query',
        value: duration,
        unit: 'ms',
        tags: { operation, status: error ? 'error' : 'success' },
        duration,
        details: { query, error: error?.message }
      });

      this.endTrace(traceId, { 
        query, 
        operation, 
        error: error?.message,
        recordCount: Array.isArray(result) ? result.length : 1
      });

      // Check database latency threshold
      if (duration > this.config.thresholds.latency) {
        this.emit('threshold-exceeded', {
          type: 'database',
          value: duration,
          threshold: this.config.thresholds.latency,
          details: { query, operation }
        });
      }
    };
  }

  // Metric recording
  private recordMetric(metric: PerformanceMetric): void {
    if (this.currentSession) {
      this.currentSession.metrics.push(metric);
      
      // Limit metrics to prevent memory issues
      if (this.currentSession.metrics.length > this.config.maxSamples) {
        this.currentSession.metrics = this.currentSession.metrics.slice(-this.config.maxSamples);
      }
    }

    this.emit('metric-recorded', metric);
  }

  // Analysis and reporting
  private generateSummary(session: ProfileSession): ProfileSummary {
    const metrics = session.metrics;
    const duration = (session.endTime || Date.now()) - session.startTime;

    // CPU analysis
    const cpuMetrics = metrics.filter(m => m.type === 'cpu');
    const cpuValues = cpuMetrics.map(m => m.value);
    
    // Memory analysis
    const memoryMetrics = metrics.filter(m => m.type === 'memory');
    const memoryValues = memoryMetrics.map(m => m.value);

    // GC analysis
    const gcMetrics = metrics.filter(m => m.type === 'gc');
    const gcTime = gcMetrics.reduce((sum, m) => sum + m.value, 0);

    // Event loop analysis
    const eventLoopMetrics = metrics.filter(m => m.type === 'event-loop');
    const eventLoopValues = eventLoopMetrics.map(m => m.value);

    // Hotspot analysis
    const hotspots = this.identifyHotspots(metrics);

    // Generate recommendations
    const recommendations = this.generateRecommendations(metrics, hotspots);

    return {
      totalDuration: duration,
      cpuUsage: {
        avg: this.average(cpuValues),
        max: Math.max(...cpuValues, 0),
        min: Math.min(...cpuValues, 0)
      },
      memoryUsage: {
        avg: this.average(memoryValues),
        max: Math.max(...memoryValues, 0),
        peak: Math.max(...memoryValues, 0)
      },
      gcMetrics: {
        totalTime: gcTime,
        collections: gcMetrics.length,
        avgPause: gcMetrics.length > 0 ? gcTime / gcMetrics.length : 0
      },
      eventLoopLag: {
        avg: this.average(eventLoopValues),
        max: Math.max(...eventLoopValues, 0),
        p95: this.percentile(eventLoopValues, 95)
      },
      hotspots,
      recommendations
    };
  }

  private identifyHotspots(metrics: PerformanceMetric[]): Hotspot[] {
    // Group metrics by name and calculate statistics
    const groups = new Map<string, PerformanceMetric[]>();
    
    metrics.forEach(metric => {
      if (!groups.has(metric.name)) {
        groups.set(metric.name, []);
      }
      groups.get(metric.name)!.push(metric);
    });

    const hotspots: Hotspot[] = [];

    for (const [name, metricGroup] of groups.entries()) {
      const totalTime = metricGroup.reduce((sum, m) => sum + (m.duration || m.value), 0);
      const callCount = metricGroup.length;
      const avgTime = totalTime / callCount;

      // Determine impact based on total time and frequency
      let impact: 'high' | 'medium' | 'low' = 'low';
      if (totalTime > 1000 && callCount > 10) impact = 'high';
      else if (totalTime > 500 || callCount > 5) impact = 'medium';

      if (impact !== 'low' || totalTime > 100) {
        hotspots.push({
          name,
          type: this.getHotspotType(name),
          totalTime,
          callCount,
          avgTime,
          impact
        });
      }
    }

    // Sort by impact and total time
    return hotspots.sort((a, b) => {
      const impactOrder = { high: 3, medium: 2, low: 1 };
      const impactDiff = impactOrder[b.impact] - impactOrder[a.impact];
      return impactDiff !== 0 ? impactDiff : b.totalTime - a.totalTime;
    });
  }

  private getHotspotType(name: string): 'function' | 'operation' | 'query' {
    if (name.includes('query') || name.includes('database')) return 'query';
    if (name.includes('_') || name.includes('operation')) return 'operation';
    return 'function';
  }

  private generateRecommendations(metrics: PerformanceMetric[], hotspots: Hotspot[]): string[] {
    const recommendations: string[] = [];

    // CPU recommendations
    const cpuMetrics = metrics.filter(m => m.type === 'cpu');
    const avgCpu = this.average(cpuMetrics.map(m => m.value));
    if (avgCpu > 80) {
      recommendations.push('High CPU usage detected. Consider optimizing CPU-intensive operations or scaling horizontally.');
    }

    // Memory recommendations
    const memoryMetrics = metrics.filter(m => m.type === 'memory');
    const maxMemory = Math.max(...memoryMetrics.map(m => m.value), 0);
    if (maxMemory > this.config.thresholds.memory * 0.8) {
      recommendations.push('Memory usage is approaching the threshold. Consider memory optimization or increasing memory limits.');
    }

    // GC recommendations
    const gcMetrics = metrics.filter(m => m.type === 'gc');
    const totalGcTime = gcMetrics.reduce((sum, m) => sum + m.value, 0);
    if (totalGcTime > 1000) { // More than 1 second in GC
      recommendations.push('High garbage collection time detected. Consider reducing object allocations or tuning GC parameters.');
    }

    // Hotspot recommendations
    const highImpactHotspots = hotspots.filter(h => h.impact === 'high');
    if (highImpactHotspots.length > 0) {
      recommendations.push(`Optimize high-impact operations: ${highImpactHotspots.map(h => h.name).join(', ')}`);
    }

    // Database recommendations
    const dbMetrics = metrics.filter(m => m.type === 'database');
    const slowQueries = dbMetrics.filter(m => m.value > this.config.thresholds.latency);
    if (slowQueries.length > 0) {
      recommendations.push(`${slowQueries.length} slow database queries detected. Consider query optimization or indexing.`);
    }

    return recommendations;
  }

  // Utility methods
  private average(values: number[]): number {
    return values.length > 0 ? values.reduce((sum, val) => sum + val, 0) / values.length : 0;
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private createEmptySummary(): ProfileSummary {
    return {
      totalDuration: 0,
      cpuUsage: { avg: 0, max: 0, min: 0 },
      memoryUsage: { avg: 0, max: 0, peak: 0 },
      gcMetrics: { totalTime: 0, collections: 0, avgPause: 0 },
      eventLoopLag: { avg: 0, max: 0, p95: 0 },
      hotspots: [],
      recommendations: []
    };
  }

  // Public API
  public getActiveSessions(): ProfileSession[] {
    return Array.from(this.sessions.values()).filter(s => !s.endTime);
  }

  public getCompletedSessions(): ProfileSession[] {
    return Array.from(this.sessions.values()).filter(s => s.endTime);
  }

  public getSession(sessionId: string): ProfileSession | undefined {
    return this.sessions.get(sessionId);
  }

  public async exportSession(sessionId: string, format: 'json' | 'csv' = 'json'): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (format === 'csv') {
      return this.exportToCsv(session);
    }

    return JSON.stringify(session, null, 2);
  }

  private exportToCsv(session: ProfileSession): string {
    const headers = ['timestamp', 'type', 'name', 'value', 'unit', 'duration', 'tags'];
    const rows = [headers.join(',')];

    session.metrics.forEach(metric => {
      const row = [
        metric.timestamp.toString(),
        metric.type,
        metric.name,
        metric.value.toString(),
        metric.unit,
        (metric.duration || '').toString(),
        JSON.stringify(metric.tags)
      ];
      rows.push(row.join(','));
    });

    return rows.join('\n');
  }

  public clearOldSessions(maxAge: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    let cleared = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.endTime && session.endTime < cutoff) {
        this.sessions.delete(sessionId);
        cleared++;
      }
    }

    if (cleared > 0) {
      this.logger.info(`Cleared ${cleared} old profile sessions`);
    }

    return cleared;
  }

  public getMetrics(): {
    totalSessions: number;
    activeSessions: number;
    totalMetrics: number;
    memoryUsage: number;
  } {
    const totalMetrics = Array.from(this.sessions.values())
      .reduce((sum, session) => sum + session.metrics.length, 0);

    return {
      totalSessions: this.sessions.size,
      activeSessions: this.getActiveSessions().length,
      totalMetrics,
      memoryUsage: process.memoryUsage().heapUsed
    };
  }

  public destroy(): void {
    this.isActive = false;
    
    // Clear all timers
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();

    // Disconnect observers
    this.observers.forEach(observer => observer.disconnect());
    this.observers = [];

    // Clear sessions
    this.sessions.clear();
    this.activeTraces.clear();
    this.traceStack = [];

    this.logger.info('Performance profiler destroyed');
  }
}
