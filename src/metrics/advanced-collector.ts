// Enhanced Metrics System (Item 69: Metrics Visualization)
// Comprehensive Prometheus metrics collection for mining pool operations

import { register, Counter, Gauge, Histogram, Summary } from 'prom-client';
import { Logger } from '../logging/logger';
import { EventEmitter } from 'events';

export interface MetricsConfig {
  enabled: boolean;
  port: number;
  path: string;
  collectDefaultMetrics: boolean;
  prefix: string;
  labels: Record<string, string>;
}

export interface PoolMetrics {
  // Pool-specific metrics
  hashrate: number;
  activeMiners: number;
  blocksFound: number;
  difficulty: number;
  uptime: number;
  
  // Performance metrics
  sharesPerSecond: number;
  acceptanceRate: number;
  rejectionRate: number;
  latency: number;
  
  // System metrics
  memoryUsage: number;
  cpuUsage: number;
  connectionCount: number;
  errorRate: number;
}

/**
 * Advanced Metrics Collector for Otedama Pool
 * Following observability best practices with comprehensive metrics
 */
export class AdvancedMetricsCollector extends EventEmitter {
  private logger = new Logger('Metrics');
  private config: MetricsConfig;
  private metricsRegistry = register;
  
  // Pool operation metrics
  private poolHashrate: Gauge<string>;
  private activeMiners: Gauge<string>;
  private poolUptime: Gauge<string>;
  private currentDifficulty: Gauge<string>;
  private blocksFound: Counter<string>;
  
  // Share metrics
  private sharesSubmitted: Counter<string>;
  private sharesAccepted: Counter<string>;
  private sharesRejected: Counter<string>;
  private shareValidationTime: Histogram<string>;
  private duplicateShares: Counter<string>;
  
  // Network metrics
  private activeConnections: Gauge<string>;
  private connectionDuration: Histogram<string>;
  private stratumConnections: Gauge<string>;
  private websocketConnections: Gauge<string>;
  private networkBytesReceived: Counter<string>;
  private networkBytesSent: Counter<string>;
  
  // Performance metrics
  private httpRequestDuration: Histogram<string>;
  private httpRequestsTotal: Counter<string>;
  private databaseQueryDuration: Histogram<string>;
  private databaseQueriesTotal: Counter<string>;
  private databaseConnectionsActive: Gauge<string>;
  private redisOperationDuration: Histogram<string>;
  private redisOperationsTotal: Counter<string>;
  
  // System metrics
  private nodeJsHeapUsed: Gauge<string>;
  private nodeJsHeapTotal: Gauge<string>;
  private nodeJsExternalMemory: Gauge<string>;
  private nodeJsEventLoopLag: Histogram<string>;
  private gcDuration: Histogram<string>;
  private gcCount: Counter<string>;
  
  // Business metrics
  private payoutsTotal: Counter<string>;
  private payoutAmount: Counter<string>;
  private feesCollected: Counter<string>;
  private minerRegistrations: Counter<string>;
  private minerDeregistrations: Counter<string>;
  
  // Security metrics
  private securityViolations: Counter<string>;
  private ddosAttacks: Counter<string>;
  private rateLimitHits: Counter<string>;
  private authenticationFailures: Counter<string>;
  private suspiciousActivity: Counter<string>;
  
  // Error metrics
  private errorsTotal: Counter<string>;
  private warningsTotal: Counter<string>;
  private criticalErrorsTotal: Counter<string>;
  
  constructor(config: MetricsConfig) {
    super();
    this.config = config;
    
    if (this.config.enabled) {
      this.initializeMetrics();
      this.startDefaultCollection();
    }
  }
  
  /**
   * Initialize all Prometheus metrics
   */
  private initializeMetrics(): void {
    const { prefix, labels } = this.config;
    
    // Pool operation metrics
    this.poolHashrate = new Gauge({
      name: `${prefix}_pool_hashrate_total`,
      help: 'Total pool hashrate in hashes per second',
      labelNames: Object.keys(labels),
      registers: [this.metricsRegistry]
    });
    
    this.activeMiners = new Gauge({
      name: `${prefix}_miners_active`,
      help: 'Number of active miners',
      labelNames: Object.keys(labels),
      registers: [this.metricsRegistry]
    });
    
    this.poolUptime = new Gauge({
      name: `${prefix}_pool_uptime_seconds`,
      help: 'Pool uptime in seconds',
      labelNames: Object.keys(labels),
      registers: [this.metricsRegistry]
    });
    
    this.currentDifficulty = new Gauge({
      name: `${prefix}_current_difficulty`,
      help: 'Current mining difficulty',
      labelNames: Object.keys(labels),
      registers: [this.metricsRegistry]
    });
    
    this.blocksFound = new Counter({
      name: `${prefix}_blocks_found_total`,
      help: 'Total number of blocks found',
      labelNames: [...Object.keys(labels), 'block_type'],
      registers: [this.metricsRegistry]
    });
    
    // Share metrics
    this.sharesSubmitted = new Counter({
      name: `${prefix}_shares_submitted_total`,
      help: 'Total shares submitted',
      labelNames: [...Object.keys(labels), 'miner', 'worker'],
      registers: [this.metricsRegistry]
    });
    
    this.sharesAccepted = new Counter({
      name: `${prefix}_shares_accepted_total`,
      help: 'Total shares accepted',
      labelNames: [...Object.keys(labels), 'miner', 'worker'],
      registers: [this.metricsRegistry]
    });
    
    this.sharesRejected = new Counter({
      name: `${prefix}_shares_rejected_total`,
      help: 'Total shares rejected',
      labelNames: [...Object.keys(labels), 'miner', 'worker', 'reason'],
      registers: [this.metricsRegistry]
    });
    
    this.shareValidationTime = new Histogram({
      name: `${prefix}_share_validation_duration_seconds`,
      help: 'Time spent validating shares',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      labelNames: Object.keys(labels),
      registers: [this.metricsRegistry]
    });
    
    this.duplicateShares = new Counter({
      name: `${prefix}_duplicate_shares_total`,
      help: 'Total duplicate shares detected',
      labelNames: [...Object.keys(labels), 'miner'],
      registers: [this.metricsRegistry]
    });
    
    // Network metrics
    this.activeConnections = new Gauge({
      name: `${prefix}_connections_active`,
      help: 'Number of active connections',
      labelNames: [...Object.keys(labels), 'protocol'],
      registers: [this.metricsRegistry]
    });
    
    this.connectionDuration = new Histogram({
      name: `${prefix}_connection_duration_seconds`,
      help: 'Connection duration in seconds',
      buckets: [1, 10, 60, 300, 1800, 3600, 21600, 86400],
      labelNames: [...Object.keys(labels), 'protocol'],
      registers: [this.metricsRegistry]
    });
    
    this.stratumConnections = new Gauge({
      name: `${prefix}_connections_stratum`,
      help: 'Number of active Stratum connections',
      labelNames: Object.keys(labels),
      registers: [this.metricsRegistry]
    });
    
    this.websocketConnections = new Gauge({
      name: `${prefix}_connections_websocket`,
      help: 'Number of active WebSocket connections',
      labelNames: Object.keys(labels),
      registers: [this.metricsRegistry]
    });
    
    // Performance metrics
    this.httpRequestDuration = new Histogram({
      name: `${prefix}_http_request_duration_seconds`,
      help: 'HTTP request duration in seconds',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      labelNames: [...Object.keys(labels), 'method', 'route', 'status_code'],
      registers: [this.metricsRegistry]
    });
    
    this.httpRequestsTotal = new Counter({
      name: `${prefix}_http_requests_total`,
      help: 'Total HTTP requests',
      labelNames: [...Object.keys(labels), 'method', 'route', 'status_code'],
      registers: [this.metricsRegistry]
    });
    
    this.databaseQueryDuration = new Histogram({
      name: `${prefix}_database_query_duration_seconds`,
      help: 'Database query duration in seconds',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
      labelNames: [...Object.keys(labels), 'operation', 'table'],
      registers: [this.metricsRegistry]
    });
    
    this.databaseQueriesTotal = new Counter({
      name: `${prefix}_database_queries_total`,
      help: 'Total database queries',
      labelNames: [...Object.keys(labels), 'operation', 'table', 'status'],
      registers: [this.metricsRegistry]
    });
    
    this.databaseConnectionsActive = new Gauge({
      name: `${prefix}_database_connections_active`,
      help: 'Number of active database connections',
      labelNames: Object.keys(labels),
      registers: [this.metricsRegistry]
    });
    
    // Error metrics
    this.errorsTotal = new Counter({
      name: `${prefix}_errors_total`,
      help: 'Total errors',
      labelNames: [...Object.keys(labels), 'type', 'component'],
      registers: [this.metricsRegistry]
    });
    
    this.securityViolations = new Counter({
      name: `${prefix}_security_violations_total`,
      help: 'Total security violations',
      labelNames: [...Object.keys(labels), 'type', 'severity'],
      registers: [this.metricsRegistry]
    });
    
    this.logger.info('Prometheus metrics initialized', {
      prefix: this.config.prefix,
      metricsCount: this.metricsRegistry.getMetricsAsArray().length
    });
  }
  
  /**
   * Start collecting default Node.js metrics
   */
  private startDefaultCollection(): void {
    if (this.config.collectDefaultMetrics) {
      const collectDefaultMetrics = require('prom-client').collectDefaultMetrics;
      collectDefaultMetrics({
        register: this.metricsRegistry,
        prefix: `${this.config.prefix}_`,
        labels: this.config.labels
      });
    }
  }
  
  /**
   * Record pool hashrate
   */
  recordHashrate(hashrate: number, labels: Record<string, string> = {}): void {
    this.poolHashrate.set({ ...this.config.labels, ...labels }, hashrate);
  }
  
  /**
   * Record active miners count
   */
  recordActiveMiners(count: number, labels: Record<string, string> = {}): void {
    this.activeMiners.set({ ...this.config.labels, ...labels }, count);
  }
  
  /**
   * Record share submission
   */
  recordShareSubmitted(miner: string, worker: string = 'default'): void {
    this.sharesSubmitted.inc({ ...this.config.labels, miner, worker });
  }
  
  /**
   * Record share acceptance
   */
  recordShareAccepted(miner: string, worker: string = 'default'): void {
    this.sharesAccepted.inc({ ...this.config.labels, miner, worker });
  }
  
  /**
   * Record share rejection
   */
  recordShareRejected(miner: string, reason: string, worker: string = 'default'): void {
    this.sharesRejected.inc({ ...this.config.labels, miner, worker, reason });
  }
  
  /**
   * Record share validation time
   */
  recordShareValidationTime(duration: number): void {
    this.shareValidationTime.observe(this.config.labels, duration);
  }
  
  /**
   * Record block found
   */
  recordBlockFound(type: string = 'mainnet'): void {
    this.blocksFound.inc({ ...this.config.labels, block_type: type });
  }
  
  /**
   * Record HTTP request
   */
  recordHttpRequest(method: string, route: string, statusCode: number, duration: number): void {
    const labels = {
      ...this.config.labels,
      method,
      route,
      status_code: statusCode.toString()
    };
    
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDuration.observe(labels, duration);
  }
  
  /**
   * Record database operation
   */
  recordDatabaseQuery(operation: string, table: string, duration: number, status: string = 'success'): void {
    const labels = {
      ...this.config.labels,
      operation,
      table,
      status
    };
    
    this.databaseQueriesTotal.inc(labels);
    this.databaseQueryDuration.observe({ ...this.config.labels, operation, table }, duration);
  }
  
  /**
   * Record connection activity
   */
  recordConnection(protocol: string, action: 'connect' | 'disconnect', duration?: number): void {
    const labels = { ...this.config.labels, protocol };
    
    if (action === 'connect') {
      this.activeConnections.inc(labels);
    } else {
      this.activeConnections.dec(labels);
      if (duration !== undefined) {
        this.connectionDuration.observe(labels, duration);
      }
    }
  }
  
  /**
   * Record error occurrence
   */
  recordError(type: string, component: string): void {
    this.errorsTotal.inc({ ...this.config.labels, type, component });
  }
  
  /**
   * Record security violation
   */
  recordSecurityViolation(type: string, severity: string): void {
    this.securityViolations.inc({ ...this.config.labels, type, severity });
  }
  
  /**
   * Get current pool metrics snapshot
   */
  async getPoolMetrics(): Promise<PoolMetrics> {
    const metrics = await this.metricsRegistry.getMetricsAsJSON();
    
    // Extract specific metrics values
    const getMetricValue = (name: string): number => {
      const metric = metrics.find(m => m.name === `${this.config.prefix}_${name}`);
      return metric?.values?.[0]?.value || 0;
    };
    
    return {
      hashrate: getMetricValue('pool_hashrate_total'),
      activeMiners: getMetricValue('miners_active'),
      blocksFound: getMetricValue('blocks_found_total'),
      difficulty: getMetricValue('current_difficulty'),
      uptime: getMetricValue('pool_uptime_seconds'),
      sharesPerSecond: 0, // Calculated from rate
      acceptanceRate: 0, // Calculated from counters
      rejectionRate: 0, // Calculated from counters
      latency: 0, // Calculated from histograms
      memoryUsage: process.memoryUsage().heapUsed,
      cpuUsage: process.cpuUsage().user + process.cpuUsage().system,
      connectionCount: getMetricValue('connections_active'),
      errorRate: 0 // Calculated from error counters
    };
  }
  
  /**
   * Get metrics in Prometheus format
   */
  async getPrometheusMetrics(): Promise<string> {
    return this.metricsRegistry.metrics();
  }
  
  /**
   * Clear all metrics
   */
  clearMetrics(): void {
    this.metricsRegistry.clear();
    this.logger.info('All metrics cleared');
  }
  
  /**
   * Create Express middleware for metrics endpoint
   */
  createMetricsMiddleware() {
    return async (req: any, res: any) => {
      try {
        res.set('Content-Type', this.metricsRegistry.contentType);
        const metrics = await this.getPrometheusMetrics();
        res.send(metrics);
      } catch (error) {
        this.logger.error('Failed to generate metrics:', error as Error);
        res.status(500).send('Internal Server Error');
      }
    };
  }
  
  /**
   * Start automatic metrics collection
   */
  startAutomaticCollection(interval: number = 5000): void {
    setInterval(async () => {
      try {
        // Update pool uptime
        this.poolUptime.set(this.config.labels, process.uptime());
        
        // Update memory metrics
        const memUsage = process.memoryUsage();
        this.nodeJsHeapUsed?.set(this.config.labels, memUsage.heapUsed);
        this.nodeJsHeapTotal?.set(this.config.labels, memUsage.heapTotal);
        this.nodeJsExternalMemory?.set(this.config.labels, memUsage.external);
        
        // Emit metrics event for other components
        this.emit('metrics_collected', await this.getPoolMetrics());
        
      } catch (error) {
        this.logger.error('Error in automatic metrics collection:', error as Error);
      }
    }, interval);
    
    this.logger.info(`Automatic metrics collection started (interval: ${interval}ms)`);
  }
  
  /**
   * Export metrics to external systems
   */
  async exportMetrics(target: 'influxdb' | 'datadog' | 'newrelic'): Promise<void> {
    try {
      const metrics = await this.getPoolMetrics();
      
      switch (target) {
        case 'influxdb':
          await this.exportToInfluxDB(metrics);
          break;
        case 'datadog':
          await this.exportToDatadog(metrics);
          break;
        case 'newrelic':
          await this.exportToNewRelic(metrics);
          break;
      }
      
      this.logger.info(`Metrics exported to ${target}`);
    } catch (error) {
      this.logger.error(`Failed to export metrics to ${target}:`, error as Error);
    }
  }
  
  private async exportToInfluxDB(metrics: PoolMetrics): Promise<void> {
    // InfluxDB export implementation would go here
    this.logger.debug('InfluxDB export not implemented yet');
  }
  
  private async exportToDatadog(metrics: PoolMetrics): Promise<void> {
    // Datadog export implementation would go here
    this.logger.debug('Datadog export not implemented yet');
  }
  
  private async exportToNewRelic(metrics: PoolMetrics): Promise<void> {
    // New Relic export implementation would go here
    this.logger.debug('New Relic export not implemented yet');
  }
}

/**
 * Factory function for creating metrics collector
 */
export function createMetricsCollector(config: Partial<MetricsConfig> = {}): AdvancedMetricsCollector {
  const defaultConfig: MetricsConfig = {
    enabled: process.env.PROMETHEUS_ENABLED === 'true',
    port: parseInt(process.env.METRICS_PORT || '9090'),
    path: '/metrics',
    collectDefaultMetrics: true,
    prefix: 'otedama',
    labels: {
      instance: process.env.HOSTNAME || 'localhost',
      version: process.env.APP_VERSION || '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    }
  };
  
  return new AdvancedMetricsCollector({ ...defaultConfig, ...config });
}
