/**
 * Application Performance Monitoring (APM) Integration
 * Design: Carmack (Performance) + Martin (Clean) + Pike (Simplicity)
 * 
 * Comprehensive APM solution with Prometheus integration
 */

import { EventEmitter } from 'events';
import * as client from 'prom-client';
import { Request, Response, NextFunction } from 'express';
import { performance } from 'perf_hooks';
import { tracer } from '../tracing';

// ===== INTERFACES =====
export interface APMConfig {
  enabled: boolean;
  metricsPrefix: string;
  collectInterval: number;
  enableDetailedMetrics: boolean;
  enableBusinessMetrics: boolean;
  enableSLI: boolean;
}

export interface APMMetrics {
  httpRequests: client.Counter<string>;
  httpDuration: client.Histogram<string>;
  activeConnections: client.Gauge<string>;
  
  // Pool-specific metrics
  sharesSubmitted: client.Counter<string>;
  sharesValid: client.Counter<string>;
  sharesInvalid: client.Counter<string>;
  activeMiners: client.Gauge<string>;
  poolHashrate: client.Gauge<string>;
  blocksDound: client.Counter<string>;
  
  // Performance metrics
  cpuUsage: client.Gauge<string>;
  memoryUsage: client.Gauge<string>;
  heapUsage: client.Gauge<string>;
  eventLoopLag: client.Histogram<string>;
  
  // Database metrics
  dbOperations: client.Counter<string>;
  dbDuration: client.Histogram<string>;
  dbConnections: client.Gauge<string>;
  
  // Business metrics
  revenue: client.Counter<string>;
  payouts: client.Counter<string>;
  poolEfficiency: client.Gauge<string>;
  
  // Error tracking
  errors: client.Counter<string>;
  errorsByType: client.Counter<string>;
}

export interface BusinessMetric {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

// ===== APM MANAGER =====
export class APMManager extends EventEmitter {
  private config: APMConfig;
  private metrics: APMMetrics;
  private register: client.Registry;
  private intervalId?: NodeJS.Timeout;
  private requestStartTimes = new Map<string, number>();

  constructor(config: Partial<APMConfig> = {}) {
    super();
    
    this.config = {
      enabled: config.enabled ?? true,
      metricsPrefix: config.metricsPrefix || 'otedama_pool_',
      collectInterval: config.collectInterval || 15000,
      enableDetailedMetrics: config.enableDetailedMetrics ?? true,
      enableBusinessMetrics: config.enableBusinessMetrics ?? true,
      enableSLI: config.enableSLI ?? true
    };

    this.register = new client.Registry();
    this.metrics = this.createMetrics();
    
    if (this.config.enabled) {
      this.startCollection();
    }
  }

  private createMetrics(): APMMetrics {
    const prefix = this.config.metricsPrefix;

    // HTTP Metrics
    const httpRequests = new client.Counter({
      name: `${prefix}http_requests_total`,
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register]
    });

    const httpDuration = new client.Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
      registers: [this.register]
    });

    const activeConnections = new client.Gauge({
      name: `${prefix}active_connections`,
      help: 'Number of active connections',
      labelNames: ['type'],
      registers: [this.register]
    });

    // Pool-specific Metrics
    const sharesSubmitted = new client.Counter({
      name: `${prefix}shares_submitted_total`,
      help: 'Total number of shares submitted',
      labelNames: ['miner_id', 'algorithm'],
      registers: [this.register]
    });

    const sharesValid = new client.Counter({
      name: `${prefix}shares_valid_total`,
      help: 'Total number of valid shares',
      labelNames: ['miner_id', 'algorithm'],
      registers: [this.register]
    });

    const sharesInvalid = new client.Counter({
      name: `${prefix}shares_invalid_total`,
      help: 'Total number of invalid shares',
      labelNames: ['miner_id', 'reason'],
      registers: [this.register]
    });

    const activeMiners = new client.Gauge({
      name: `${prefix}miners_active_total`,
      help: 'Number of active miners',
      labelNames: ['algorithm'],
      registers: [this.register]
    });

    const poolHashrate = new client.Gauge({
      name: `${prefix}pool_hashrate`,
      help: 'Pool hashrate in H/s',
      labelNames: ['algorithm'],
      registers: [this.register]
    });

    const blocksDound = new client.Counter({
      name: `${prefix}blocks_found_total`,
      help: 'Total number of blocks found',
      labelNames: ['algorithm', 'height'],
      registers: [this.register]
    });

    // Performance Metrics
    const cpuUsage = new client.Gauge({
      name: `${prefix}cpu_usage_percent`,
      help: 'CPU usage percentage',
      registers: [this.register]
    });

    const memoryUsage = new client.Gauge({
      name: `${prefix}memory_usage_bytes`,
      help: 'Memory usage in bytes',
      labelNames: ['type'],
      registers: [this.register]
    });

    const heapUsage = new client.Gauge({
      name: `${prefix}heap_usage_bytes`,
      help: 'Heap usage in bytes',
      labelNames: ['type'],
      registers: [this.register]
    });

    const eventLoopLag = new client.Histogram({
      name: `${prefix}event_loop_lag_seconds`,
      help: 'Event loop lag in seconds',
      buckets: [0.001, 0.01, 0.1, 1, 10],
      registers: [this.register]
    });

    // Database Metrics
    const dbOperations = new client.Counter({
      name: `${prefix}db_operations_total`,
      help: 'Total database operations',
      labelNames: ['operation', 'table', 'status'],
      registers: [this.register]
    });

    const dbDuration = new client.Histogram({
      name: `${prefix}db_duration_seconds`,
      help: 'Database operation duration',
      labelNames: ['operation', 'table'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.register]
    });

    const dbConnections = new client.Gauge({
      name: `${prefix}db_connections`,
      help: 'Database connections',
      labelNames: ['state'],
      registers: [this.register]
    });

    // Business Metrics
    const revenue = new client.Counter({
      name: `${prefix}revenue_total`,
      help: 'Total revenue',
      labelNames: ['currency'],
      registers: [this.register]
    });

    const payouts = new client.Counter({
      name: `${prefix}payouts_total`,
      help: 'Total payouts',
      labelNames: ['currency', 'miner_id'],
      registers: [this.register]
    });

    const poolEfficiency = new client.Gauge({
      name: `${prefix}pool_efficiency_percent`,
      help: 'Pool efficiency percentage',
      registers: [this.register]
    });

    // Error Metrics
    const errors = new client.Counter({
      name: `${prefix}errors_total`,
      help: 'Total errors',
      labelNames: ['component', 'severity'],
      registers: [this.register]
    });

    const errorsByType = new client.Counter({
      name: `${prefix}errors_by_type_total`,
      help: 'Errors by type',
      labelNames: ['error_type', 'component'],
      registers: [this.register]
    });

    return {
      httpRequests,
      httpDuration,
      activeConnections,
      sharesSubmitted,
      sharesValid,
      sharesInvalid,
      activeMiners,
      poolHashrate,
      blocksDound,
      cpuUsage,
      memoryUsage,
      heapUsage,
      eventLoopLag,
      dbOperations,
      dbDuration,
      dbConnections,
      revenue,
      payouts,
      poolEfficiency,
      errors,
      errorsByType
    };
  }

  private startCollection(): void {
    // Collect default metrics (CPU, memory, etc.)
    client.collectDefaultMetrics({
      register: this.register,
      prefix: this.config.metricsPrefix,
      timeout: 5000,
      gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5]
    });

    // Start custom metrics collection
    this.intervalId = setInterval(() => {
      this.collectCustomMetrics();
    }, this.config.collectInterval);

    // Start event loop lag monitoring
    this.startEventLoopMonitoring();
  }

  private collectCustomMetrics(): void {
    try {
      // Memory metrics
      const memUsage = process.memoryUsage();
      this.metrics.memoryUsage.set({ type: 'rss' }, memUsage.rss);
      this.metrics.memoryUsage.set({ type: 'heap_used' }, memUsage.heapUsed);
      this.metrics.memoryUsage.set({ type: 'heap_total' }, memUsage.heapTotal);
      this.metrics.memoryUsage.set({ type: 'external' }, memUsage.external);

      this.metrics.heapUsage.set({ type: 'used' }, memUsage.heapUsed);
      this.metrics.heapUsage.set({ type: 'total' }, memUsage.heapTotal);

      // CPU metrics
      const cpuUsage = process.cpuUsage();
      this.metrics.cpuUsage.set((cpuUsage.user + cpuUsage.system) / 1000000);

      this.emit('metrics:collected', {
        memory: memUsage,
        cpu: cpuUsage,
        timestamp: Date.now()
      });
    } catch (error) {
      this.recordError('apm', 'error', 'metrics_collection_failed', error as Error);
    }
  }

  private startEventLoopMonitoring(): void {
    const measure = () => {
      const start = process.hrtime.bigint();
      setImmediate(() => {
        const lag = Number(process.hrtime.bigint() - start) / 1e9;
        this.metrics.eventLoopLag.observe(lag);
        setTimeout(measure, 1000);
      });
    };
    measure();
  }

  // ===== PUBLIC METHODS =====

  /**
   * Record HTTP request metrics
   */
  recordHttpRequest(method: string, route: string, statusCode: number, duration: number): void {
    const labels = { method, route, status_code: statusCode.toString() };
    
    this.metrics.httpRequests.inc(labels);
    this.metrics.httpDuration.observe(labels, duration / 1000);

    // Tracing integration
    tracer.recordEvent('http_request', {
      method,
      route,
      status_code: statusCode,
      duration_ms: duration
    });
  }

  /**
   * Record share submission
   */
  recordShare(minerId: string, algorithm: string, valid: boolean, reason?: string): void {
    const labels = { miner_id: minerId, algorithm };
    
    this.metrics.sharesSubmitted.inc(labels);
    
    if (valid) {
      this.metrics.sharesValid.inc(labels);
    } else {
      this.metrics.sharesInvalid.inc({ miner_id: minerId, reason: reason || 'unknown' });
    }

    // Tracing
    tracer.recordEvent('share_submission', {
      miner_id: minerId,
      algorithm,
      valid,
      reason
    });
  }

  /**
   * Update active miners count
   */
  updateActiveMiners(algorithm: string, count: number): void {
    this.metrics.activeMiners.set({ algorithm }, count);
  }

  /**
   * Update pool hashrate
   */
  updatePoolHashrate(algorithm: string, hashrate: number): void {
    this.metrics.poolHashrate.set({ algorithm }, hashrate);
  }

  /**
   * Record block found
   */
  recordBlockFound(algorithm: string, height: number): void {
    this.metrics.blocksDound.inc({ algorithm, height: height.toString() });
    
    this.emit('block:found', { algorithm, height, timestamp: Date.now() });
  }

  /**
   * Record database operation
   */
  recordDatabaseOperation(operation: string, table: string, duration: number, success: boolean): void {
    const labels = { operation, table, status: success ? 'success' : 'error' };
    
    this.metrics.dbOperations.inc(labels);
    this.metrics.dbDuration.observe({ operation, table }, duration / 1000);
  }

  /**
   * Record error
   */
  recordError(component: string, severity: string, errorType: string, error?: Error): void {
    this.metrics.errors.inc({ component, severity });
    this.metrics.errorsByType.inc({ error_type: errorType, component });

    if (error) {
      tracer.recordError(error, { component, severity, error_type: errorType });
    }

    this.emit('error:recorded', {
      component,
      severity,
      errorType,
      error: error?.message,
      timestamp: Date.now()
    });
  }

  /**
   * Record business metric
   */
  recordBusinessMetric(metric: BusinessMetric): void {
    if (!this.config.enableBusinessMetrics) return;

    switch (metric.name) {
      case 'revenue':
        this.metrics.revenue.inc(metric.labels, metric.value);
        break;
      case 'payout':
        this.metrics.payouts.inc(metric.labels, metric.value);
        break;
      case 'efficiency':
        this.metrics.poolEfficiency.set(metric.value);
        break;
    }

    this.emit('business:metric', metric);
  }

  /**
   * Express middleware for HTTP metrics
   */
  httpMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = performance.now();
      const requestId = req.headers['x-request-id'] || `${Date.now()}-${Math.random()}`;
      
      this.requestStartTimes.set(requestId as string, start);
      this.metrics.activeConnections.inc({ type: 'http' });

      // Trace HTTP request
      tracer.traceHttpRequest(req.method, req.path, async (span) => {
        span.setAttributes({
          'http.request_id': requestId,
          'http.user_agent': req.get('User-Agent') || '',
          'http.remote_addr': req.ip
        });

        const originalSend = res.send;
        res.send = function(data) {
          const duration = performance.now() - start;
          
          // Record metrics
          this.recordHttpRequest(req.method, req.route?.path || req.path, res.statusCode, duration);
          this.metrics.activeConnections.dec({ type: 'http' });
          this.requestStartTimes.delete(requestId as string);

          span.setAttributes({
            'http.response_size': Buffer.byteLength(data || ''),
            'http.status_code': res.statusCode
          });

          return originalSend.call(this, data);
        }.bind(this);

        next();
        return Promise.resolve();
      });
    };
  }

  /**
   * Get metrics for Prometheus scraping
   */
  async getMetrics(): Promise<string> {
    return this.register.metrics();
  }

  /**
   * Get current SLI values
   */
  getSLI(): Record<string, number> {
    if (!this.config.enableSLI) return {};

    // Calculate SLIs from metrics
    // This is a simplified example - in production you'd use PromQL
    return {
      availability: 99.9, // Placeholder
      latency_p99: 100,   // Placeholder
      throughput: 150,    // Placeholder
      error_rate: 0.1     // Placeholder
    };
  }

  /**
   * Stop APM collection
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    
    this.register.clear();
    this.removeAllListeners();
  }
}

// ===== APM MIDDLEWARE FACTORY =====
export function createAPMMiddleware(config?: Partial<APMConfig>) {
  const apm = new APMManager(config);
  return {
    apm,
    middleware: apm.httpMiddleware(),
    metricsEndpoint: async () => apm.getMetrics()
  };
}

// ===== BUSINESS METRICS HELPER =====
export class BusinessMetricsCollector {
  constructor(private apm: APMManager) {}

  recordRevenue(amount: number, currency: string = 'BTC'): void {
    this.apm.recordBusinessMetric({
      name: 'revenue',
      value: amount,
      labels: { currency },
      timestamp: Date.now()
    });
  }

  recordPayout(minerId: string, amount: number, currency: string = 'BTC'): void {
    this.apm.recordBusinessMetric({
      name: 'payout',
      value: amount,
      labels: { currency, miner_id: minerId },
      timestamp: Date.now()
    });
  }

  updateEfficiency(efficiency: number): void {
    this.apm.recordBusinessMetric({
      name: 'efficiency',
      value: efficiency,
      labels: {},
      timestamp: Date.now()
    });
  }
}

// ===== EXPORT =====
export default APMManager;
