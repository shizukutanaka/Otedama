/**
 * Prometheus Metrics Integration for Otedama
 * 
 * Implements comprehensive metrics collection:
 * - HTTP request metrics (latency, status codes, throughput)
 * - Database query performance
 * - Cache hit rates
 * - Mining statistics
 * - DEX trading metrics
 * - System resource usage
 * - Custom business metrics
 * 
 * Following observability best practices
 */

import { EventEmitter } from 'events';
import promClient from 'prom-client';
import { performance } from 'perf_hooks';

// Metric configuration
const METRICS_CONFIG = Object.freeze({
  // Buckets for histogram metrics
  HTTP_DURATION_BUCKETS: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  DB_DURATION_BUCKETS: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  CACHE_SIZE_BUCKETS: [10, 50, 100, 500, 1000, 5000, 10000],
  
  // Labels
  MAX_LABEL_VALUES: 100,
  
  // Collection
  DEFAULT_METRICS_INTERVAL: 10000, // 10 seconds
  CUSTOM_METRICS_INTERVAL: 5000,   // 5 seconds
});

/**
 * Metric definitions
 */
class MetricDefinitions {
  constructor(register = promClient.register) {
    this.register = register;
    this.metrics = {};
    
    this.defineHTTPMetrics();
    this.defineDatabaseMetrics();
    this.defineCacheMetrics();
    this.defineMiningMetrics();
    this.defineDEXMetrics();
    this.defineSystemMetrics();
    this.defineBusinessMetrics();
  }

  defineHTTPMetrics() {
    // Request count
    this.metrics.httpRequestsTotal = new promClient.Counter({
      name: 'otedama_http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register]
    });

    // Request duration
    this.metrics.httpRequestDuration = new promClient.Histogram({
      name: 'otedama_http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: METRICS_CONFIG.HTTP_DURATION_BUCKETS,
      registers: [this.register]
    });

    // Request size
    this.metrics.httpRequestSize = new promClient.Histogram({
      name: 'otedama_http_request_size_bytes',
      help: 'HTTP request size in bytes',
      labelNames: ['method', 'route'],
      buckets: [100, 1000, 10000, 100000, 1000000],
      registers: [this.register]
    });

    // Response size
    this.metrics.httpResponseSize = new promClient.Histogram({
      name: 'otedama_http_response_size_bytes',
      help: 'HTTP response size in bytes',
      labelNames: ['method', 'route'],
      buckets: [100, 1000, 10000, 100000, 1000000],
      registers: [this.register]
    });

    // Active connections
    this.metrics.httpActiveConnections = new promClient.Gauge({
      name: 'otedama_http_active_connections',
      help: 'Number of active HTTP connections',
      registers: [this.register]
    });
  }

  defineDatabaseMetrics() {
    // Query count
    this.metrics.dbQueriesTotal = new promClient.Counter({
      name: 'otedama_db_queries_total',
      help: 'Total number of database queries',
      labelNames: ['operation', 'table', 'status'],
      registers: [this.register]
    });

    // Query duration
    this.metrics.dbQueryDuration = new promClient.Histogram({
      name: 'otedama_db_query_duration_seconds',
      help: 'Database query execution time',
      labelNames: ['operation', 'table'],
      buckets: METRICS_CONFIG.DB_DURATION_BUCKETS,
      registers: [this.register]
    });

    // Connection pool
    this.metrics.dbConnectionsActive = new promClient.Gauge({
      name: 'otedama_db_connections_active',
      help: 'Number of active database connections',
      labelNames: ['pool_type'],
      registers: [this.register]
    });

    this.metrics.dbConnectionsIdle = new promClient.Gauge({
      name: 'otedama_db_connections_idle',
      help: 'Number of idle database connections',
      labelNames: ['pool_type'],
      registers: [this.register]
    });

    // Transaction metrics
    this.metrics.dbTransactionsTotal = new promClient.Counter({
      name: 'otedama_db_transactions_total',
      help: 'Total number of database transactions',
      labelNames: ['status'],
      registers: [this.register]
    });

    // Slow queries
    this.metrics.dbSlowQueries = new promClient.Counter({
      name: 'otedama_db_slow_queries_total',
      help: 'Total number of slow database queries',
      labelNames: ['operation', 'table'],
      registers: [this.register]
    });
  }

  defineCacheMetrics() {
    // Cache operations
    this.metrics.cacheOperationsTotal = new promClient.Counter({
      name: 'otedama_cache_operations_total',
      help: 'Total number of cache operations',
      labelNames: ['operation', 'layer', 'status'],
      registers: [this.register]
    });

    // Hit rate
    this.metrics.cacheHitRate = new promClient.Gauge({
      name: 'otedama_cache_hit_rate',
      help: 'Cache hit rate (0-1)',
      labelNames: ['layer'],
      registers: [this.register]
    });

    // Cache size
    this.metrics.cacheSize = new promClient.Gauge({
      name: 'otedama_cache_size_entries',
      help: 'Number of entries in cache',
      labelNames: ['layer'],
      registers: [this.register]
    });

    // Cache memory
    this.metrics.cacheMemoryBytes = new promClient.Gauge({
      name: 'otedama_cache_memory_bytes',
      help: 'Memory used by cache in bytes',
      labelNames: ['layer'],
      registers: [this.register]
    });

    // Evictions
    this.metrics.cacheEvictionsTotal = new promClient.Counter({
      name: 'otedama_cache_evictions_total',
      help: 'Total number of cache evictions',
      labelNames: ['layer', 'reason'],
      registers: [this.register]
    });
  }

  defineMiningMetrics() {
    // Hashrate
    this.metrics.miningHashrate = new promClient.Gauge({
      name: 'otedama_mining_hashrate_hps',
      help: 'Current mining hashrate in hashes per second',
      labelNames: ['algorithm', 'device_type'],
      registers: [this.register]
    });

    // Shares
    this.metrics.miningSharesTotal = new promClient.Counter({
      name: 'otedama_mining_shares_total',
      help: 'Total number of mining shares',
      labelNames: ['status', 'algorithm'],
      registers: [this.register]
    });

    // Blocks
    this.metrics.miningBlocksFound = new promClient.Counter({
      name: 'otedama_mining_blocks_found_total',
      help: 'Total number of blocks found',
      labelNames: ['algorithm', 'currency'],
      registers: [this.register]
    });

    // Active miners
    this.metrics.miningActiveMiners = new promClient.Gauge({
      name: 'otedama_mining_active_miners',
      help: 'Number of active miners',
      labelNames: ['algorithm'],
      registers: [this.register]
    });

    // Pool difficulty
    this.metrics.miningPoolDifficulty = new promClient.Gauge({
      name: 'otedama_mining_pool_difficulty',
      help: 'Current pool difficulty',
      labelNames: ['algorithm'],
      registers: [this.register]
    });

    // Earnings
    this.metrics.miningEarnings = new promClient.Gauge({
      name: 'otedama_mining_earnings_total',
      help: 'Total mining earnings',
      labelNames: ['currency'],
      registers: [this.register]
    });
  }

  defineDEXMetrics() {
    // Orders
    this.metrics.dexOrdersTotal = new promClient.Counter({
      name: 'otedama_dex_orders_total',
      help: 'Total number of DEX orders',
      labelNames: ['pair', 'side', 'status'],
      registers: [this.register]
    });

    // Trades
    this.metrics.dexTradesTotal = new promClient.Counter({
      name: 'otedama_dex_trades_total',
      help: 'Total number of DEX trades',
      labelNames: ['pair'],
      registers: [this.register]
    });

    // Volume
    this.metrics.dexVolumeTotal = new promClient.Counter({
      name: 'otedama_dex_volume_total',
      help: 'Total DEX trading volume',
      labelNames: ['pair', 'currency'],
      registers: [this.register]
    });

    // Liquidity
    this.metrics.dexLiquidity = new promClient.Gauge({
      name: 'otedama_dex_liquidity',
      help: 'Total liquidity in pools',
      labelNames: ['pool', 'token'],
      registers: [this.register]
    });

    // Order book depth
    this.metrics.dexOrderBookDepth = new promClient.Gauge({
      name: 'otedama_dex_orderbook_depth',
      help: 'Order book depth',
      labelNames: ['pair', 'side'],
      registers: [this.register]
    });

    // Fees collected
    this.metrics.dexFeesCollected = new promClient.Counter({
      name: 'otedama_dex_fees_collected_total',
      help: 'Total fees collected',
      labelNames: ['pair', 'currency'],
      registers: [this.register]
    });
  }

  defineSystemMetrics() {
    // Memory usage
    this.metrics.systemMemoryUsage = new promClient.Gauge({
      name: 'otedama_system_memory_bytes',
      help: 'System memory usage in bytes',
      labelNames: ['type'],
      registers: [this.register]
    });

    // CPU usage
    this.metrics.systemCpuUsage = new promClient.Gauge({
      name: 'otedama_system_cpu_percentage',
      help: 'System CPU usage percentage',
      labelNames: ['core'],
      registers: [this.register]
    });

    // Event loop lag
    this.metrics.systemEventLoopLag = new promClient.Histogram({
      name: 'otedama_system_event_loop_lag_seconds',
      help: 'Event loop lag in seconds',
      buckets: [0.001, 0.01, 0.1, 1],
      registers: [this.register]
    });

    // GC metrics
    this.metrics.systemGcDuration = new promClient.Histogram({
      name: 'otedama_system_gc_duration_seconds',
      help: 'Garbage collection duration',
      labelNames: ['type'],
      buckets: [0.001, 0.01, 0.1, 1],
      registers: [this.register]
    });

    // Process uptime
    this.metrics.systemUptime = new promClient.Gauge({
      name: 'otedama_system_uptime_seconds',
      help: 'System uptime in seconds',
      registers: [this.register]
    });
  }

  defineBusinessMetrics() {
    // User registrations
    this.metrics.businessUsersTotal = new promClient.Counter({
      name: 'otedama_business_users_total',
      help: 'Total number of registered users',
      labelNames: ['type'],
      registers: [this.register]
    });

    // Revenue
    this.metrics.businessRevenue = new promClient.Counter({
      name: 'otedama_business_revenue_total',
      help: 'Total revenue',
      labelNames: ['source', 'currency'],
      registers: [this.register]
    });

    // API usage
    this.metrics.businessApiCalls = new promClient.Counter({
      name: 'otedama_business_api_calls_total',
      help: 'Total API calls',
      labelNames: ['endpoint', 'client_type'],
      registers: [this.register]
    });

    // Error rate
    this.metrics.businessErrorRate = new promClient.Gauge({
      name: 'otedama_business_error_rate',
      help: 'Business logic error rate',
      labelNames: ['component'],
      registers: [this.register]
    });

    // SLA compliance
    this.metrics.businessSlaCompliance = new promClient.Gauge({
      name: 'otedama_business_sla_compliance',
      help: 'SLA compliance percentage',
      labelNames: ['metric'],
      registers: [this.register]
    });
  }

  get(name) {
    return this.metrics[name];
  }

  getAll() {
    return this.metrics;
  }
}

/**
 * Metrics Collector
 */
export class MetricsCollector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      defaultLabels: options.defaultLabels || {},
      includeDefaultMetrics: options.includeDefaultMetrics !== false,
      defaultMetricsInterval: options.defaultMetricsInterval || METRICS_CONFIG.DEFAULT_METRICS_INTERVAL,
      prefix: options.prefix || 'otedama_',
      ...options
    };

    // Create registry
    this.register = new promClient.Registry();
    
    // Set default labels
    this.register.setDefaultLabels(this.options.defaultLabels);
    
    // Initialize metrics
    this.metrics = new MetricDefinitions(this.register);
    
    // Collectors
    this.collectors = new Map();
    
    // Start default metrics collection
    if (this.options.includeDefaultMetrics) {
      promClient.collectDefaultMetrics({
        register: this.register,
        prefix: this.options.prefix,
        gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5]
      });
    }
    
    // Start custom collectors
    this.startCollectors();
  }

  /**
   * Record HTTP request
   */
  recordHttpRequest(method, route, statusCode, duration, requestSize = 0, responseSize = 0) {
    this.metrics.get('httpRequestsTotal').inc({ 
      method, 
      route: this.sanitizeRoute(route), 
      status_code: statusCode 
    });
    
    this.metrics.get('httpRequestDuration').observe(
      { method, route: this.sanitizeRoute(route), status_code: statusCode },
      duration
    );
    
    if (requestSize > 0) {
      this.metrics.get('httpRequestSize').observe(
        { method, route: this.sanitizeRoute(route) },
        requestSize
      );
    }
    
    if (responseSize > 0) {
      this.metrics.get('httpResponseSize').observe(
        { method, route: this.sanitizeRoute(route) },
        responseSize
      );
    }
  }

  /**
   * Record database query
   */
  recordDbQuery(operation, table, duration, status = 'success') {
    this.metrics.get('dbQueriesTotal').inc({ 
      operation, 
      table: this.sanitizeLabel(table), 
      status 
    });
    
    this.metrics.get('dbQueryDuration').observe(
      { operation, table: this.sanitizeLabel(table) },
      duration
    );
    
    // Track slow queries
    if (duration > 0.1) { // 100ms
      this.metrics.get('dbSlowQueries').inc({ 
        operation, 
        table: this.sanitizeLabel(table) 
      });
    }
  }

  /**
   * Record cache operation
   */
  recordCacheOperation(operation, layer, status) {
    this.metrics.get('cacheOperationsTotal').inc({ 
      operation, 
      layer, 
      status 
    });
  }

  /**
   * Update cache stats
   */
  updateCacheStats(layer, stats) {
    if (stats.hitRate !== undefined) {
      this.metrics.get('cacheHitRate').set({ layer }, stats.hitRate);
    }
    
    if (stats.size !== undefined) {
      this.metrics.get('cacheSize').set({ layer }, stats.size);
    }
    
    if (stats.memory !== undefined) {
      this.metrics.get('cacheMemoryBytes').set({ layer }, stats.memory);
    }
  }

  /**
   * Record mining share
   */
  recordMiningShare(status, algorithm) {
    this.metrics.get('miningSharesTotal').inc({ 
      status, 
      algorithm: this.sanitizeLabel(algorithm) 
    });
  }

  /**
   * Update mining stats
   */
  updateMiningStats(stats) {
    if (stats.hashrate) {
      Object.entries(stats.hashrate).forEach(([key, value]) => {
        const [algorithm, deviceType] = key.split(':');
        this.metrics.get('miningHashrate').set(
          { algorithm, device_type: deviceType || 'unknown' },
          value
        );
      });
    }
    
    if (stats.activeMiners) {
      Object.entries(stats.activeMiners).forEach(([algorithm, count]) => {
        this.metrics.get('miningActiveMiners').set({ algorithm }, count);
      });
    }
    
    if (stats.difficulty) {
      Object.entries(stats.difficulty).forEach(([algorithm, difficulty]) => {
        this.metrics.get('miningPoolDifficulty').set({ algorithm }, difficulty);
      });
    }
  }

  /**
   * Record DEX order
   */
  recordDexOrder(pair, side, status) {
    this.metrics.get('dexOrdersTotal').inc({ 
      pair: this.sanitizeLabel(pair), 
      side, 
      status 
    });
  }

  /**
   * Record DEX trade
   */
  recordDexTrade(pair, volume, price) {
    this.metrics.get('dexTradesTotal').inc({ 
      pair: this.sanitizeLabel(pair) 
    });
    
    // Assuming volume is in base currency
    this.metrics.get('dexVolumeTotal').inc(
      { pair: this.sanitizeLabel(pair), currency: 'base' },
      volume
    );
  }

  /**
   * Update system metrics
   */
  updateSystemMetrics() {
    const memoryUsage = process.memoryUsage();
    
    this.metrics.get('systemMemoryUsage').set({ type: 'heap_used' }, memoryUsage.heapUsed);
    this.metrics.get('systemMemoryUsage').set({ type: 'heap_total' }, memoryUsage.heapTotal);
    this.metrics.get('systemMemoryUsage').set({ type: 'external' }, memoryUsage.external);
    this.metrics.get('systemMemoryUsage').set({ type: 'rss' }, memoryUsage.rss);
    
    this.metrics.get('systemUptime').set(process.uptime());
  }

  /**
   * Create HTTP middleware
   */
  httpMiddleware() {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      const startTime = Date.now();
      
      // Track active connections
      this.metrics.get('httpActiveConnections').inc();
      
      // Store original methods
      const originalEnd = res.end;
      const originalWrite = res.write;
      
      let responseSize = 0;
      
      // Override write to track response size
      res.write = function(...args) {
        if (args[0]) {
          responseSize += Buffer.byteLength(args[0]);
        }
        return originalWrite.apply(res, args);
      };
      
      // Override end to record metrics
      res.end = (...args) => {
        if (args[0]) {
          responseSize += Buffer.byteLength(args[0]);
        }
        
        // Calculate duration
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        
        // Record metrics
        this.recordHttpRequest(
          req.method,
          req.route?.path || req.path || req.url,
          res.statusCode,
          duration,
          req.get('content-length') || 0,
          responseSize
        );
        
        // Decrement active connections
        this.metrics.get('httpActiveConnections').dec();
        
        // Call original end
        return originalEnd.apply(res, args);
      };
      
      next();
    };
  }

  /**
   * Get metrics endpoint handler
   */
  metricsEndpoint() {
    return async (req, res) => {
      try {
        res.set('Content-Type', this.register.contentType);
        const metrics = await this.register.metrics();
        res.end(metrics);
      } catch (error) {
        res.status(500).end(error.message);
      }
    };
  }

  /**
   * Start metric collectors
   */
  startCollectors() {
    // System metrics collector
    this.collectors.set('system', setInterval(() => {
      this.updateSystemMetrics();
    }, METRICS_CONFIG.CUSTOM_METRICS_INTERVAL));
  }

  /**
   * Register custom collector
   */
  registerCollector(name, interval, collector) {
    if (this.collectors.has(name)) {
      throw new Error(`Collector ${name} already registered`);
    }
    
    const intervalId = setInterval(() => {
      try {
        collector(this);
      } catch (error) {
        this.emit('collector:error', { name, error });
      }
    }, interval);
    
    this.collectors.set(name, intervalId);
  }

  /**
   * Sanitize route for labels
   */
  sanitizeRoute(route) {
    // Replace dynamic segments with placeholders
    return route
      .replace(/\/\d+/g, '/:id')
      .replace(/\/[a-f0-9-]{36}/gi, '/:uuid')
      .replace(/\/0x[a-f0-9]+/gi, '/:hash');
  }

  /**
   * Sanitize label value
   */
  sanitizeLabel(value) {
    if (!value) return 'unknown';
    
    // Limit cardinality
    const str = String(value).toLowerCase();
    
    // Check if we've seen too many values for this label
    if (this.labelCardinality && this.labelCardinality.get(str) > METRICS_CONFIG.MAX_LABEL_VALUES) {
      return 'other';
    }
    
    return str.replace(/[^a-z0-9_]/g, '_').substring(0, 50);
  }

  /**
   * Get all metrics as JSON
   */
  async getMetricsJson() {
    const metrics = await this.register.getMetricsAsJSON();
    return metrics;
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.register.resetMetrics();
  }

  /**
   * Cleanup
   */
  cleanup() {
    // Stop all collectors
    for (const [name, intervalId] of this.collectors.entries()) {
      clearInterval(intervalId);
    }
    this.collectors.clear();
    
    this.removeAllListeners();
  }
}

// Export singleton instance
export const metricsCollector = new MetricsCollector();

export default MetricsCollector;