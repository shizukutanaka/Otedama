// src/tracing/distributed-tracer.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { trace, context, Span, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { EventEmitter } from 'events';
import crypto from 'crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  baggage?: Record<string, string>;
  flags?: number;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  tags: Record<string, any>;
  logs: TraceLog[];
  status: 'ok' | 'error' | 'timeout';
  process: {
    serviceName: string;
    processId: string;
    hostName: string;
  };
  references?: TraceReference[];
}

export interface TraceLog {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  fields?: Record<string, any>;
}

export interface TraceReference {
  type: 'child_of' | 'follows_from';
  traceId: string;
  spanId: string;
}

export interface DistributedTracingConfig {
  enabled: boolean;
  serviceName: string;
  sampleRate: number; // 0.0 to 1.0
  maxSpanDuration: number; // milliseconds
  exporters: {
    jaeger?: {
      enabled: boolean;
      endpoint: string;
    };
    zipkin?: {
      enabled: boolean;
      endpoint: string;
    };
    otlp?: {
      enabled: boolean;
      endpoint: string;
    };
  };
  propagation: {
    b3: boolean;
    jaeger: boolean;
    tracecontext: boolean;
  };
}

export interface TraceMetrics {
  totalSpans: number;
  activeSpans: number;
  errorSpans: number;
  avgDuration: number;
  p95Duration: number;
  p99Duration: number;
  throughput: number; // spans per second
  serviceMap: Map<string, Set<string>>; // service dependencies
}

export class DistributedTracer extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private config: DistributedTracingConfig;
  private activeSpans: Map<string, TraceSpan> = new Map();
  private completedSpans: TraceSpan[] = [];
  private metrics: TraceMetrics;
  private samplingRules: Map<string, number> = new Map();
  private processInfo: { serviceName: string; processId: string; hostName: string };

  constructor(config: DistributedTracingConfig, logger: Logger, cache: RedisCache) {
    super();
    this.config = config;
    this.logger = logger;
    this.cache = cache;
    
    this.processInfo = {
      serviceName: config.serviceName,
      processId: process.pid.toString(),
      hostName: process.env.HOSTNAME || require('os').hostname()
    };

    this.metrics = {
      totalSpans: 0,
      activeSpans: 0,
      errorSpans: 0,
      avgDuration: 0,
      p95Duration: 0,
      p99Duration: 0,
      throughput: 0,
      serviceMap: new Map()
    };

    if (config.enabled) {
      this.initialize();
    }
  }

  private initialize(): void {
    this.startMetricsCollection();
    this.startSpanExport();
    
    this.logger.info('Distributed tracer initialized', {
      serviceName: this.config.serviceName,
      sampleRate: this.config.sampleRate
    });
  }

  private startMetricsCollection(): void {
    setInterval(() => {
      this.updateMetrics();
    }, 10000); // Every 10 seconds
  }

  private startSpanExport(): void {
    setInterval(() => {
      this.exportSpans();
    }, 5000); // Every 5 seconds
  }

  // Span lifecycle management
  public startSpan(
    operationName: string,
    parentContext?: TraceContext,
    tags: Record<string, any> = {}
  ): TraceSpan {
    if (!this.shouldSample(operationName)) {
      return this.createNoOpSpan(operationName);
    }

    const traceId = parentContext?.traceId || this.generateTraceId();
    const spanId = this.generateSpanId();
    
    const span: TraceSpan = {
      traceId,
      spanId,
      parentSpanId: parentContext?.spanId,
      operationName,
      startTime: Date.now(),
      tags: {
        'service.name': this.processInfo.serviceName,
        'process.pid': this.processInfo.processId,
        'host.name': this.processInfo.hostName,
        ...tags
      },
      logs: [],
      status: 'ok',
      process: this.processInfo,
      references: parentContext ? [{
        type: 'child_of',
        traceId: parentContext.traceId,
        spanId: parentContext.spanId
      }] : undefined
    };

    this.activeSpans.set(spanId, span);
    this.metrics.activeSpans = this.activeSpans.size;
    this.metrics.totalSpans++;

    this.emit('span-started', span);
    return span;
  }

  public finishSpan(spanId: string, status: 'ok' | 'error' | 'timeout' = 'ok'): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = status;

    // Check for timeout
    if (span.duration > this.config.maxSpanDuration) {
      span.status = 'timeout';
      span.tags['timeout'] = true;
    }

    // Move to completed spans
    this.activeSpans.delete(spanId);
    this.completedSpans.push(span);

    // Limit completed spans to prevent memory issues
    if (this.completedSpans.length > 10000) {
      this.completedSpans = this.completedSpans.slice(-5000);
    }

    this.metrics.activeSpans = this.activeSpans.size;
    if (status === 'error') {
      this.metrics.errorSpans++;
    }

    this.emit('span-finished', span);
  }

  public setSpanTag(spanId: string, key: string, value: any): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.tags[key] = value;
    }
  }

  public logSpanEvent(
    spanId: string,
    level: TraceLog['level'],
    message: string,
    fields?: Record<string, any>
  ): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.logs.push({
        timestamp: Date.now(),
        level,
        message,
        fields
      });
    }
  }

  public recordSpanError(spanId: string, error: Error): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.tags['error'] = true;
      span.tags['error.message'] = error.message;
      span.tags['error.stack'] = error.stack;
      
      this.logSpanEvent(spanId, 'error', error.message, {
        'error.kind': error.constructor.name,
        'error.object': error.toString()
      });
    }
  }

  // Convenience methods for common operations
  public async traceAsyncOperation<T>(
    operationName: string,
    fn: (span: TraceSpan) => Promise<T>,
    parentContext?: TraceContext,
    tags?: Record<string, any>
  ): Promise<T> {
    const span = this.startSpan(operationName, parentContext, tags);
    
    try {
      const result = await fn(span);
      this.finishSpan(span.spanId, 'ok');
      return result;
    } catch (error) {
      this.recordSpanError(span.spanId, error as Error);
      this.finishSpan(span.spanId, 'error');
      throw error;
    }
  }

  public traceSyncOperation<T>(
    operationName: string,
    fn: (span: TraceSpan) => T,
    parentContext?: TraceContext,
    tags?: Record<string, any>
  ): T {
    const span = this.startSpan(operationName, parentContext, tags);
    
    try {
      const result = fn(span);
      this.finishSpan(span.spanId, 'ok');
      return result;
    } catch (error) {
      this.recordSpanError(span.spanId, error as Error);
      this.finishSpan(span.spanId, 'error');
      throw error;
    }
  }

  // Mining-specific tracing
  public traceMiningWork(
    minerId: string,
    workId: string,
    algorithm: string,
    parentContext?: TraceContext
  ): TraceSpan {
    return this.startSpan('mining.work', parentContext, {
      'mining.miner_id': minerId,
      'mining.work_id': workId,
      'mining.algorithm': algorithm,
      'component': 'mining'
    });
  }

  public traceShareSubmission(
    minerId: string,
    shareId: string,
    difficulty: number,
    parentContext?: TraceContext
  ): TraceSpan {
    return this.startSpan('mining.share_submission', parentContext, {
      'mining.miner_id': minerId,
      'mining.share_id': shareId,
      'mining.difficulty': difficulty,
      'component': 'mining'
    });
  }

  public traceP2PMessage(
    messageType: string,
    peerId: string,
    size: number,
    parentContext?: TraceContext
  ): TraceSpan {
    return this.startSpan('p2p.message', parentContext, {
      'p2p.message_type': messageType,
      'p2p.peer_id': peerId,
      'p2p.message_size': size,
      'component': 'p2p'
    });
  }

  public traceDatabaseQuery(
    operation: string,
    table: string,
    queryTime: number,
    parentContext?: TraceContext
  ): TraceSpan {
    return this.startSpan('db.query', parentContext, {
      'db.operation': operation,
      'db.table': table,
      'db.query_time': queryTime,
      'component': 'database'
    });
  }

  // Context propagation
  public extractContext(headers: Record<string, string>): TraceContext | null {
    // B3 propagation
    if (this.config.propagation.b3) {
      const traceId = headers['x-b3-traceid'];
      const spanId = headers['x-b3-spanid'];
      const parentSpanId = headers['x-b3-parentspanid'];
      
      if (traceId && spanId) {
        return { traceId, spanId, parentSpanId };
      }
    }

    // Jaeger propagation
    if (this.config.propagation.jaeger) {
      const uberTrace = headers['uber-trace-id'];
      if (uberTrace) {
        const parts = uberTrace.split(':');
        if (parts.length >= 2) {
          return {
            traceId: parts[0],
            spanId: parts[1],
            parentSpanId: parts[2] || undefined
          };
        }
      }
    }

    // W3C Trace Context
    if (this.config.propagation.tracecontext) {
      const traceparent = headers['traceparent'];
      if (traceparent) {
        const parts = traceparent.split('-');
        if (parts.length === 4) {
          return {
            traceId: parts[1],
            spanId: parts[2]
          };
        }
      }
    }

    return null;
  }

  public injectContext(context: TraceContext, headers: Record<string, string>): void {
    // B3 propagation
    if (this.config.propagation.b3) {
      headers['x-b3-traceid'] = context.traceId;
      headers['x-b3-spanid'] = context.spanId;
      if (context.parentSpanId) {
        headers['x-b3-parentspanid'] = context.parentSpanId;
      }
      headers['x-b3-sampled'] = '1';
    }

    // Jaeger propagation
    if (this.config.propagation.jaeger) {
      let uberTrace = `${context.traceId}:${context.spanId}`;
      if (context.parentSpanId) {
        uberTrace += `:${context.parentSpanId}`;
      }
      uberTrace += ':1'; // sampled
      headers['uber-trace-id'] = uberTrace;
    }

    // W3C Trace Context
    if (this.config.propagation.tracecontext) {
      headers['traceparent'] = `00-${context.traceId}-${context.spanId}-01`;
    }
  }

  // Sampling
  private shouldSample(operationName: string): boolean {
    // Check operation-specific sampling rules
    const opSampleRate = this.samplingRules.get(operationName);
    if (opSampleRate !== undefined) {
      return Math.random() < opSampleRate;
    }

    // Default sampling
    return Math.random() < this.config.sampleRate;
  }

  public setSamplingRule(operationName: string, sampleRate: number): void {
    this.samplingRules.set(operationName, Math.max(0, Math.min(1, sampleRate)));
  }

  // Metrics and monitoring
  private updateMetrics(): void {
    const durations = this.completedSpans
      .filter(span => span.duration !== undefined)
      .map(span => span.duration!);

    if (durations.length > 0) {
      this.metrics.avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
      
      const sorted = durations.sort((a, b) => a - b);
      const p95Index = Math.floor(sorted.length * 0.95);
      const p99Index = Math.floor(sorted.length * 0.99);
      
      this.metrics.p95Duration = sorted[p95Index] || 0;
      this.metrics.p99Duration = sorted[p99Index] || 0;
    }

    // Calculate throughput (spans completed in last minute)
    const oneMinuteAgo = Date.now() - 60000;
    const recentSpans = this.completedSpans.filter(span => 
      span.endTime && span.endTime >= oneMinuteAgo
    );
    this.metrics.throughput = recentSpans.length / 60;

    // Update service map
    this.updateServiceMap();

    this.emit('metrics-updated', this.metrics);
  }

  private updateServiceMap(): void {
    this.metrics.serviceMap.clear();
    
    for (const span of this.completedSpans) {
      const serviceName = span.tags['service.name'] || 'unknown';
      
      if (!this.metrics.serviceMap.has(serviceName)) {
        this.metrics.serviceMap.set(serviceName, new Set());
      }
      
      // Add called services
      const calledService = span.tags['called.service'];
      if (calledService) {
        this.metrics.serviceMap.get(serviceName)!.add(calledService);
      }
    }
  }

  private async exportSpans(): Promise<void> {
    if (this.completedSpans.length === 0) return;

    const spansToExport = this.completedSpans.splice(0, 100); // Export in batches
    
    try {
      // Export to configured backends
      const exportPromises: Promise<any>[] = [];

      if (this.config.exporters.jaeger?.enabled) {
        exportPromises.push(this.exportToJaeger(spansToExport));
      }

      if (this.config.exporters.zipkin?.enabled) {
        exportPromises.push(this.exportToZipkin(spansToExport));
      }

      if (this.config.exporters.otlp?.enabled) {
        exportPromises.push(this.exportToOTLP(spansToExport));
      }

      await Promise.allSettled(exportPromises);
      
      // Store in cache for debugging
      await this.storeSpansInCache(spansToExport);
      
    } catch (error) {
      this.logger.error('Failed to export spans:', error);
      // Put spans back for retry
      this.completedSpans.unshift(...spansToExport);
    }
  }

  private async exportToJaeger(spans: TraceSpan[]): Promise<void> {
    // Simplified Jaeger export (would use actual Jaeger client in production)
    this.logger.debug(`Exporting ${spans.length} spans to Jaeger`);
  }

  private async exportToZipkin(spans: TraceSpan[]): Promise<void> {
    // Simplified Zipkin export
    this.logger.debug(`Exporting ${spans.length} spans to Zipkin`);
  }

  private async exportToOTLP(spans: TraceSpan[]): Promise<void> {
    // Simplified OTLP export
    this.logger.debug(`Exporting ${spans.length} spans to OTLP`);
  }

  private async storeSpansInCache(spans: TraceSpan[]): Promise<void> {
    for (const span of spans) {
      const key = `trace:${span.traceId}:${span.spanId}`;
      await this.cache.set(key, JSON.stringify(span), 3600); // 1 hour
    }
  }

  // Utility methods
  private generateTraceId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private generateSpanId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private createNoOpSpan(operationName: string): TraceSpan {
    return {
      traceId: '0',
      spanId: '0',
      operationName,
      startTime: Date.now(),
      tags: {},
      logs: [],
      status: 'ok',
      process: this.processInfo
    };
  }

  // Public API
  public getMetrics(): TraceMetrics {
    return { ...this.metrics };
  }

  public getActiveSpans(): TraceSpan[] {
    return Array.from(this.activeSpans.values());
  }

  public getTrace(traceId: string): TraceSpan[] {
    return this.completedSpans.filter(span => span.traceId === traceId);
  }

  public async searchSpans(query: {
    serviceName?: string;
    operationName?: string;
    tags?: Record<string, any>;
    duration?: { min?: number; max?: number };
    timeRange?: { start: number; end: number };
    limit?: number;
  }): Promise<TraceSpan[]> {
    let results = [...this.completedSpans];

    if (query.serviceName) {
      results = results.filter(span => 
        span.tags['service.name'] === query.serviceName
      );
    }

    if (query.operationName) {
      results = results.filter(span => 
        span.operationName === query.operationName
      );
    }

    if (query.tags) {
      results = results.filter(span => {
        return Object.entries(query.tags!).every(([key, value]) => 
          span.tags[key] === value
        );
      });
    }

    if (query.duration) {
      results = results.filter(span => {
        if (!span.duration) return false;
        if (query.duration!.min && span.duration < query.duration!.min) return false;
        if (query.duration!.max && span.duration > query.duration!.max) return false;
        return true;
      });
    }

    if (query.timeRange) {
      results = results.filter(span => {
        return span.startTime >= query.timeRange!.start && 
               span.startTime <= query.timeRange!.end;
      });
    }

    // Sort by start time (newest first)
    results.sort((a, b) => b.startTime - a.startTime);

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  public getServiceMap(): Map<string, Set<string>> {
    return new Map(this.metrics.serviceMap);
  }

  public destroy(): void {
    this.activeSpans.clear();
    this.completedSpans = [];
    this.samplingRules.clear();
    
    this.logger.info('Distributed tracer destroyed');
  }
}
