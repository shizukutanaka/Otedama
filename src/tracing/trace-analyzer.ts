// src/tracing/trace-analyzer.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { TraceSpan, TraceMetrics } from './distributed-tracer';
import { EventEmitter } from 'events';

export interface TraceAnalysis {
  traceId: string;
  serviceCoverage: string[];
  totalDuration: number;
  criticalPath: TraceSpan[];
  bottlenecks: Bottleneck[];
  errorRate: number;
  spans: TraceSpan[];
  serviceInteractions: ServiceInteraction[];
  performance: {
    slowestOperations: { operation: string; avgDuration: number; count: number }[];
    errorProneOperations: { operation: string; errorRate: number; count: number }[];
  };
}

export interface Bottleneck {
  spanId: string;
  operationName: string;
  duration: number;
  percentage: number; // percentage of total trace time
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestions: string[];
}

export interface ServiceInteraction {
  from: string;
  to: string;
  operationType: string;
  count: number;
  avgDuration: number;
  errorRate: number;
}

export interface PerformanceInsight {
  type: 'latency_spike' | 'error_burst' | 'throughput_drop' | 'dependency_issue';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  affectedServices: string[];
  timeRange: { start: number; end: number };
  metrics: Record<string, number>;
  recommendations: string[];
}

export interface ServiceDependency {
  service: string;
  dependencies: {
    service: string;
    callCount: number;
    avgLatency: number;
    errorRate: number;
    reliability: number; // 0-1 scale
  }[];
  health: 'healthy' | 'degraded' | 'unhealthy';
  sla: {
    availability: number;
    latencyP95: number;
    errorRate: number;
  };
}

export class TraceAnalyzer extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private spans: Map<string, TraceSpan[]> = new Map(); // traceId -> spans
  private insights: PerformanceInsight[] = [];
  private serviceDependencies: Map<string, ServiceDependency> = new Map();

  constructor(logger: Logger, cache: RedisCache) {
    super();
    this.logger = logger;
    this.cache = cache;
    
    this.startPeriodicAnalysis();
  }

  private startPeriodicAnalysis(): void {
    // Run analysis every 5 minutes
    setInterval(() => {
      this.runAnalysis();
    }, 300000);
    
    // Generate insights every 10 minutes
    setInterval(() => {
      this.generateInsights();
    }, 600000);
  }

  public addSpans(spans: TraceSpan[]): void {
    for (const span of spans) {
      if (!this.spans.has(span.traceId)) {
        this.spans.set(span.traceId, []);
      }
      this.spans.get(span.traceId)!.push(span);
    }

    // Limit stored spans to prevent memory issues
    if (this.spans.size > 1000) {
      const oldestTraces = Array.from(this.spans.keys())
        .sort()
        .slice(0, 200);
      
      for (const traceId of oldestTraces) {
        this.spans.delete(traceId);
      }
    }
  }

  public analyzeTrace(traceId: string): TraceAnalysis | null {
    const spans = this.spans.get(traceId);
    if (!spans || spans.length === 0) {
      return null;
    }

    const sortedSpans = spans.sort((a, b) => a.startTime - b.startTime);
    const rootSpan = this.findRootSpan(sortedSpans);
    
    if (!rootSpan) {
      return null;
    }

    const totalDuration = this.calculateTotalDuration(sortedSpans);
    const criticalPath = this.findCriticalPath(sortedSpans);
    const bottlenecks = this.identifyBottlenecks(sortedSpans, totalDuration);
    const serviceCoverage = this.getServiceCoverage(sortedSpans);
    const serviceInteractions = this.analyzeServiceInteractions(sortedSpans);
    const errorRate = this.calculateErrorRate(sortedSpans);
    const performance = this.analyzePerformance(sortedSpans);

    return {
      traceId,
      serviceCoverage,
      totalDuration,
      criticalPath,
      bottlenecks,
      errorRate,
      spans: sortedSpans,
      serviceInteractions,
      performance
    };
  }

  private findRootSpan(spans: TraceSpan[]): TraceSpan | null {
    // Find span with no parent
    return spans.find(span => !span.parentSpanId) || spans[0] || null;
  }

  private calculateTotalDuration(spans: TraceSpan[]): number {
    const rootSpan = this.findRootSpan(spans);
    if (!rootSpan || !rootSpan.duration) {
      return 0;
    }
    return rootSpan.duration;
  }

  private findCriticalPath(spans: TraceSpan[]): TraceSpan[] {
    // Find the longest path from root to leaf
    const spanMap = new Map<string, TraceSpan>();
    const children = new Map<string, string[]>();

    // Build span map and parent-child relationships
    for (const span of spans) {
      spanMap.set(span.spanId, span);
      
      if (span.parentSpanId) {
        if (!children.has(span.parentSpanId)) {
          children.set(span.parentSpanId, []);
        }
        children.get(span.parentSpanId)!.push(span.spanId);
      }
    }

    const rootSpan = this.findRootSpan(spans);
    if (!rootSpan) return [];

    // DFS to find longest path
    const findLongestPath = (spanId: string): TraceSpan[] => {
      const span = spanMap.get(spanId);
      if (!span) return [];

      const childSpanIds = children.get(spanId) || [];
      if (childSpanIds.length === 0) {
        return [span];
      }

      let longestChildPath: TraceSpan[] = [];
      let maxDuration = 0;

      for (const childId of childSpanIds) {
        const childPath = findLongestPath(childId);
        const pathDuration = childPath.reduce((sum, s) => sum + (s.duration || 0), 0);
        
        if (pathDuration > maxDuration) {
          maxDuration = pathDuration;
          longestChildPath = childPath;
        }
      }

      return [span, ...longestChildPath];
    };

    return findLongestPath(rootSpan.spanId);
  }

  private identifyBottlenecks(spans: TraceSpan[], totalDuration: number): Bottleneck[] {
    if (totalDuration === 0) return [];

    const bottlenecks: Bottleneck[] = [];

    for (const span of spans) {
      if (!span.duration) continue;

      const percentage = (span.duration / totalDuration) * 100;
      
      // Consider spans that take more than 10% of total time as potential bottlenecks
      if (percentage > 10) {
        let severity: Bottleneck['severity'] = 'low';
        if (percentage > 50) severity = 'critical';
        else if (percentage > 30) severity = 'high';
        else if (percentage > 20) severity = 'medium';

        const suggestions = this.generateBottleneckSuggestions(span);

        bottlenecks.push({
          spanId: span.spanId,
          operationName: span.operationName,
          duration: span.duration,
          percentage,
          severity,
          suggestions
        });
      }
    }

    return bottlenecks.sort((a, b) => b.percentage - a.percentage);
  }

  private generateBottleneckSuggestions(span: TraceSpan): string[] {
    const suggestions: string[] = [];

    // Database-related suggestions
    if (span.operationName.includes('db') || span.tags['component'] === 'database') {
      suggestions.push('Consider adding database indexes');
      suggestions.push('Review query optimization');
      suggestions.push('Check connection pool settings');
    }

    // Network-related suggestions
    if (span.operationName.includes('http') || span.operationName.includes('p2p')) {
      suggestions.push('Consider implementing caching');
      suggestions.push('Review network timeouts');
      suggestions.push('Check for connection reuse');
    }

    // Mining-related suggestions
    if (span.tags['component'] === 'mining') {
      suggestions.push('Optimize algorithm implementation');
      suggestions.push('Consider parallel processing');
      suggestions.push('Review hardware utilization');
    }

    // General suggestions for slow operations
    if (span.duration && span.duration > 1000) {
      suggestions.push('Consider async processing');
      suggestions.push('Implement circuit breaker pattern');
      suggestions.push('Add performance monitoring');
    }

    return suggestions;
  }

  private getServiceCoverage(spans: TraceSpan[]): string[] {
    const services = new Set<string>();
    
    for (const span of spans) {
      const serviceName = span.tags['service.name'] || span.process.serviceName;
      if (serviceName) {
        services.add(serviceName);
      }
    }

    return Array.from(services);
  }

  private analyzeServiceInteractions(spans: TraceSpan[]): ServiceInteraction[] {
    const interactions = new Map<string, {
      count: number;
      totalDuration: number;
      errors: number;
    }>();

    for (const span of spans) {
      const fromService = span.tags['service.name'] || span.process.serviceName;
      const toService = span.tags['called.service'];
      
      if (fromService && toService) {
        const key = `${fromService}->${toService}:${span.operationName}`;
        
        if (!interactions.has(key)) {
          interactions.set(key, { count: 0, totalDuration: 0, errors: 0 });
        }

        const interaction = interactions.get(key)!;
        interaction.count++;
        interaction.totalDuration += span.duration || 0;
        
        if (span.status === 'error') {
          interaction.errors++;
        }
      }
    }

    const result: ServiceInteraction[] = [];
    
    for (const [key, data] of interactions.entries()) {
      const [services, operationType] = key.split(':');
      const [from, to] = services.split('->');
      
      result.push({
        from,
        to,
        operationType,
        count: data.count,
        avgDuration: data.totalDuration / data.count,
        errorRate: (data.errors / data.count) * 100
      });
    }

    return result.sort((a, b) => b.count - a.count);
  }

  private calculateErrorRate(spans: TraceSpan[]): number {
    if (spans.length === 0) return 0;
    
    const errorSpans = spans.filter(span => span.status === 'error');
    return (errorSpans.length / spans.length) * 100;
  }

  private analyzePerformance(spans: TraceSpan[]): TraceAnalysis['performance'] {
    const operationStats = new Map<string, {
      durations: number[];
      errors: number;
      count: number;
    }>();

    for (const span of spans) {
      if (!operationStats.has(span.operationName)) {
        operationStats.set(span.operationName, {
          durations: [],
          errors: 0,
          count: 0
        });
      }

      const stats = operationStats.get(span.operationName)!;
      stats.count++;
      
      if (span.duration) {
        stats.durations.push(span.duration);
      }
      
      if (span.status === 'error') {
        stats.errors++;
      }
    }

    const slowestOperations = Array.from(operationStats.entries())
      .map(([operation, stats]) => ({
        operation,
        avgDuration: stats.durations.reduce((sum, d) => sum + d, 0) / stats.durations.length || 0,
        count: stats.count
      }))
      .filter(op => op.avgDuration > 0)
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 10);

    const errorProneOperations = Array.from(operationStats.entries())
      .map(([operation, stats]) => ({
        operation,
        errorRate: (stats.errors / stats.count) * 100,
        count: stats.count
      }))
      .filter(op => op.errorRate > 0)
      .sort((a, b) => b.errorRate - a.errorRate)
      .slice(0, 10);

    return {
      slowestOperations,
      errorProneOperations
    };
  }

  private async runAnalysis(): Promise<void> {
    try {
      this.analyzeServiceDependencies();
      this.emit('analysis-completed');
    } catch (error) {
      this.logger.error('Trace analysis failed:', error);
    }
  }

  private analyzeServiceDependencies(): void {
    const serviceStats = new Map<string, {
      calls: Map<string, { count: number; totalLatency: number; errors: number }>;
      totalCalls: number;
      totalErrors: number;
    }>();

    // Collect service interaction data
    for (const spans of this.spans.values()) {
      for (const span of spans) {
        const serviceName = span.tags['service.name'] || span.process.serviceName;
        const calledService = span.tags['called.service'];
        
        if (!serviceName) continue;

        if (!serviceStats.has(serviceName)) {
          serviceStats.set(serviceName, {
            calls: new Map(),
            totalCalls: 0,
            totalErrors: 0
          });
        }

        const stats = serviceStats.get(serviceName)!;
        stats.totalCalls++;
        
        if (span.status === 'error') {
          stats.totalErrors++;
        }

        if (calledService) {
          if (!stats.calls.has(calledService)) {
            stats.calls.set(calledService, { count: 0, totalLatency: 0, errors: 0 });
          }

          const callStats = stats.calls.get(calledService)!;
          callStats.count++;
          callStats.totalLatency += span.duration || 0;
          
          if (span.status === 'error') {
            callStats.errors++;
          }
        }
      }
    }

    // Build service dependencies
    for (const [serviceName, stats] of serviceStats.entries()) {
      const dependencies = Array.from(stats.calls.entries()).map(([depService, callStats]) => ({
        service: depService,
        callCount: callStats.count,
        avgLatency: callStats.totalLatency / callStats.count,
        errorRate: (callStats.errors / callStats.count) * 100,
        reliability: Math.max(0, 1 - (callStats.errors / callStats.count))
      }));

      const errorRate = (stats.totalErrors / stats.totalCalls) * 100;
      let health: ServiceDependency['health'] = 'healthy';
      
      if (errorRate > 10) health = 'unhealthy';
      else if (errorRate > 5) health = 'degraded';

      const avgLatency = dependencies.length > 0 
        ? dependencies.reduce((sum, dep) => sum + dep.avgLatency, 0) / dependencies.length 
        : 0;

      this.serviceDependencies.set(serviceName, {
        service: serviceName,
        dependencies,
        health,
        sla: {
          availability: (1 - errorRate / 100) * 100,
          latencyP95: avgLatency * 1.5, // Rough estimate
          errorRate
        }
      });
    }
  }

  private generateInsights(): void {
    try {
      this.insights = [];
      
      this.detectLatencySpikes();
      this.detectErrorBursts();
      this.detectThroughputDrops();
      this.detectDependencyIssues();

      if (this.insights.length > 0) {
        this.emit('insights-generated', this.insights);
      }
    } catch (error) {
      this.logger.error('Failed to generate insights:', error);
    }
  }

  private detectLatencySpikes(): void {
    // Analyze recent spans for latency anomalies
    const recentSpans = this.getRecentSpans(3600000); // Last hour
    const operationLatencies = new Map<string, number[]>();

    for (const span of recentSpans) {
      if (!span.duration) continue;
      
      if (!operationLatencies.has(span.operationName)) {
        operationLatencies.set(span.operationName, []);
      }
      operationLatencies.get(span.operationName)!.push(span.duration);
    }

    for (const [operation, latencies] of operationLatencies.entries()) {
      if (latencies.length < 10) continue;
      
      const avg = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
      const max = Math.max(...latencies);
      
      // Detect spike if max is significantly higher than average
      if (max > avg * 3 && max > 1000) {
        this.insights.push({
          type: 'latency_spike',
          severity: max > avg * 5 ? 'critical' : 'high',
          title: `Latency spike detected in ${operation}`,
          description: `Maximum latency (${max}ms) is ${(max / avg).toFixed(1)}x higher than average (${avg.toFixed(1)}ms)`,
          affectedServices: [operation],
          timeRange: { start: Date.now() - 3600000, end: Date.now() },
          metrics: { avgLatency: avg, maxLatency: max, multiplier: max / avg },
          recommendations: [
            'Investigate root cause of latency spike',
            'Check for resource contention',
            'Review recent deployments',
            'Monitor for recurring patterns'
          ]
        });
      }
    }
  }

  private detectErrorBursts(): void {
    const recentSpans = this.getRecentSpans(1800000); // Last 30 minutes
    const timeWindows = new Map<number, { total: number; errors: number }>();
    
    // Group spans by 5-minute windows
    for (const span of recentSpans) {
      const window = Math.floor(span.startTime / 300000) * 300000;
      
      if (!timeWindows.has(window)) {
        timeWindows.set(window, { total: 0, errors: 0 });
      }
      
      const windowStats = timeWindows.get(window)!;
      windowStats.total++;
      
      if (span.status === 'error') {
        windowStats.errors++;
      }
    }

    // Detect error bursts
    for (const [window, stats] of timeWindows.entries()) {
      if (stats.total < 10) continue;
      
      const errorRate = (stats.errors / stats.total) * 100;
      
      if (errorRate > 20) {
        this.insights.push({
          type: 'error_burst',
          severity: errorRate > 50 ? 'critical' : 'high',
          title: `Error burst detected`,
          description: `Error rate spiked to ${errorRate.toFixed(1)}% (${stats.errors}/${stats.total} requests)`,
          affectedServices: [],
          timeRange: { start: window, end: window + 300000 },
          metrics: { errorRate, errorCount: stats.errors, totalRequests: stats.total },
          recommendations: [
            'Check error logs for common patterns',
            'Verify service health',
            'Review recent changes',
            'Implement circuit breaker if needed'
          ]
        });
      }
    }
  }

  private detectThroughputDrops(): void {
    const recentSpans = this.getRecentSpans(3600000); // Last hour
    const hourlySpans = recentSpans.length;
    
    // Simple throughput analysis (would be more sophisticated in production)
    if (hourlySpans < 100) { // Threshold for low throughput
      this.insights.push({
        type: 'throughput_drop',
        severity: hourlySpans < 50 ? 'high' : 'medium',
        title: 'Low throughput detected',
        description: `Only ${hourlySpans} spans recorded in the last hour`,
        affectedServices: [],
        timeRange: { start: Date.now() - 3600000, end: Date.now() },
        metrics: { hourlySpans },
        recommendations: [
          'Check if services are running',
          'Verify load balancer configuration',
          'Review traffic patterns',
          'Check for blocking operations'
        ]
      });
    }
  }

  private detectDependencyIssues(): void {
    for (const [serviceName, dependency] of this.serviceDependencies.entries()) {
      if (dependency.health === 'unhealthy') {
        this.insights.push({
          type: 'dependency_issue',
          severity: 'critical',
          title: `Unhealthy service: ${serviceName}`,
          description: `Service ${serviceName} has degraded health (${dependency.sla.errorRate.toFixed(1)}% error rate)`,
          affectedServices: [serviceName],
          timeRange: { start: Date.now() - 3600000, end: Date.now() },
          metrics: { 
            errorRate: dependency.sla.errorRate,
            availability: dependency.sla.availability,
            avgLatency: dependency.sla.latencyP95
          },
          recommendations: [
            'Investigate service health checks',
            'Review error logs',
            'Check resource utilization',
            'Consider scaling or failover'
          ]
        });
      }
    }
  }

  private getRecentSpans(timeWindowMs: number): TraceSpan[] {
    const cutoff = Date.now() - timeWindowMs;
    const recentSpans: TraceSpan[] = [];
    
    for (const spans of this.spans.values()) {
      for (const span of spans) {
        if (span.startTime >= cutoff) {
          recentSpans.push(span);
        }
      }
    }
    
    return recentSpans;
  }

  // Public API
  public getInsights(severity?: PerformanceInsight['severity']): PerformanceInsight[] {
    if (severity) {
      return this.insights.filter(insight => insight.severity === severity);
    }
    return [...this.insights];
  }

  public getServiceDependencies(): Map<string, ServiceDependency> {
    return new Map(this.serviceDependencies);
  }

  public getServiceHealth(serviceName: string): ServiceDependency | null {
    return this.serviceDependencies.get(serviceName) || null;
  }

  public async searchTraces(query: {
    serviceName?: string;
    operationName?: string;
    minDuration?: number;
    hasErrors?: boolean;
    timeRange?: { start: number; end: number };
    limit?: number;
  }): Promise<TraceAnalysis[]> {
    const results: TraceAnalysis[] = [];
    
    for (const [traceId, spans] of this.spans.entries()) {
      const analysis = this.analyzeTrace(traceId);
      if (!analysis) continue;

      // Apply filters
      let matches = true;

      if (query.serviceName && !analysis.serviceCoverage.includes(query.serviceName)) {
        matches = false;
      }

      if (query.operationName && !analysis.spans.some(s => s.operationName === query.operationName)) {
        matches = false;
      }

      if (query.minDuration && analysis.totalDuration < query.minDuration) {
        matches = false;
      }

      if (query.hasErrors !== undefined && (analysis.errorRate > 0) !== query.hasErrors) {
        matches = false;
      }

      if (query.timeRange) {
        const traceStart = Math.min(...analysis.spans.map(s => s.startTime));
        if (traceStart < query.timeRange.start || traceStart > query.timeRange.end) {
          matches = false;
        }
      }

      if (matches) {
        results.push(analysis);
      }
    }

    // Sort by total duration (slowest first)
    results.sort((a, b) => b.totalDuration - a.totalDuration);

    if (query.limit) {
      return results.slice(0, query.limit);
    }

    return results;
  }

  public getTraceStatistics(): {
    totalTraces: number;
    avgSpansPerTrace: number;
    avgTraceDuration: number;
    errorRate: number;
    topOperations: { operation: string; count: number; avgDuration: number }[];
  } {
    let totalSpans = 0;
    let totalDuration = 0;
    let errorSpans = 0;
    const operationStats = new Map<string, { count: number; totalDuration: number }>();

    for (const spans of this.spans.values()) {
      totalSpans += spans.length;
      
      for (const span of spans) {
        if (span.duration) {
          totalDuration += span.duration;
        }
        
        if (span.status === 'error') {
          errorSpans++;
        }

        if (!operationStats.has(span.operationName)) {
          operationStats.set(span.operationName, { count: 0, totalDuration: 0 });
        }

        const stats = operationStats.get(span.operationName)!;
        stats.count++;
        stats.totalDuration += span.duration || 0;
      }
    }

    const topOperations = Array.from(operationStats.entries())
      .map(([operation, stats]) => ({
        operation,
        count: stats.count,
        avgDuration: stats.totalDuration / stats.count
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalTraces: this.spans.size,
      avgSpansPerTrace: totalSpans / this.spans.size,
      avgTraceDuration: totalDuration / this.spans.size,
      errorRate: (errorSpans / totalSpans) * 100,
      topOperations
    };
  }

  public destroy(): void {
    this.spans.clear();
    this.insights = [];
    this.serviceDependencies.clear();
    
    this.logger.info('Trace analyzer destroyed');
  }
}
