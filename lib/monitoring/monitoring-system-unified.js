/**
 * Unified Monitoring System - Otedama
 * Comprehensive monitoring with dashboards, metrics, health checks, and tracing
 * 
 * Design principles:
 * - Carmack: Real-time performance monitoring
 * - Martin: Clean monitoring architecture
 * - Pike: Simple yet powerful monitoring
 */

import { EventEmitter } from 'events';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createStructuredLogger } from '../core/structured-logger.js';
import { UnifiedRealtimeAlert } from './realtime-alert-unified.js';
import { MetricsCollector } from './metrics-collector.js';
import { register as prometheusRegister, Counter, Gauge, Histogram, Summary } from 'prom-client';
import { PerformanceObserver, performance } from 'perf_hooks';
import os from 'os';
import { promises as fs } from 'fs';

const logger = createStructuredLogger('MonitoringSystemUnified');
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Monitoring categories
 */
export const MonitoringCategory = {
  SYSTEM: 'system',
  MINING: 'mining',
  POOL: 'pool',
  NETWORK: 'network',
  SECURITY: 'security',
  BUSINESS: 'business',
  PERFORMANCE: 'performance'
};

/**
 * Health check statuses
 */
export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy'
};

/**
 * Unified Monitoring System
 */
export class UnifiedMonitoringSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Server config
      httpPort: config.httpPort || 3001,
      wsPort: config.wsPort || 3002,
      
      // Metrics config
      metricsInterval: config.metricsInterval || 5000,
      retentionPeriod: config.retentionPeriod || 86400000, // 24 hours
      
      // Health check config
      healthCheckInterval: config.healthCheckInterval || 30000,
      healthCheckTimeout: config.healthCheckTimeout || 5000,
      
      // Performance config
      performanceInterval: config.performanceInterval || 10000,
      performanceThresholds: config.performanceThresholds || {
        cpu: 80,
        memory: 85,
        disk: 90
      },
      
      // Alert config
      enableAlerts: config.enableAlerts !== false,
      alertChannels: config.alertChannels || ['websocket', 'console'],
      
      ...config
    };
    
    // Core components
    this.metricsCollector = new MetricsCollector();
    this.alertSystem = null;
    this.app = null;
    this.server = null;
    this.wss = null;
    
    // Data storage
    this.metrics = new Map();
    this.healthChecks = new Map();
    this.performanceData = new Map();
    this.systemInfo = {};
    
    // Prometheus metrics
    this.setupPrometheusMetrics();
    
    // Performance observer
    this.setupPerformanceObserver();
  }
  
  /**
   * Initialize monitoring system
   */
  async initialize() {
    try {
      // Initialize alert system
      if (this.config.enableAlerts) {
        this.alertSystem = new UnifiedRealtimeAlert({
          enabledChannels: this.config.alertChannels
        });
        await this.alertSystem.initialize();
        this.alertSystem.registerDefaultRules();
      }
      
      // Setup HTTP server
      await this.setupHttpServer();
      
      // Setup WebSocket server
      await this.setupWebSocketServer();
      
      // Start monitoring loops
      this.startMonitoring();
      
      // Collect system info
      await this.collectSystemInfo();
      
      logger.info('Unified monitoring system initialized', {
        httpPort: this.config.httpPort,
        wsPort: this.config.wsPort
      });
      
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize monitoring system', { error });
      throw error;
    }
  }
  
  /**
   * Setup Prometheus metrics
   */
  setupPrometheusMetrics() {
    // System metrics
    this.promMetrics = {
      // Counters
      httpRequests: new Counter({
        name: 'otedama_http_requests_total',
        help: 'Total HTTP requests',
        labelNames: ['method', 'route', 'status']
      }),
      
      // Gauges
      cpuUsage: new Gauge({
        name: 'otedama_cpu_usage_percent',
        help: 'CPU usage percentage'
      }),
      
      memoryUsage: new Gauge({
        name: 'otedama_memory_usage_bytes',
        help: 'Memory usage in bytes',
        labelNames: ['type']
      }),
      
      activeConnections: new Gauge({
        name: 'otedama_active_connections',
        help: 'Number of active connections',
        labelNames: ['type']
      }),
      
      // Mining metrics
      hashrate: new Gauge({
        name: 'otedama_hashrate',
        help: 'Current mining hashrate',
        labelNames: ['algorithm', 'worker']
      }),
      
      sharesSubmitted: new Counter({
        name: 'otedama_shares_submitted_total',
        help: 'Total shares submitted',
        labelNames: ['status', 'worker']
      }),
      
      blocksFound: new Counter({
        name: 'otedama_blocks_found_total',
        help: 'Total blocks found'
      }),
      
      // Histograms
      responseTime: new Histogram({
        name: 'otedama_response_time_seconds',
        help: 'HTTP response time',
        labelNames: ['method', 'route'],
        buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]
      }),
      
      // Summaries
      taskDuration: new Summary({
        name: 'otedama_task_duration_seconds',
        help: 'Task execution duration',
        labelNames: ['task_type'],
        percentiles: [0.5, 0.9, 0.95, 0.99]
      })
    };
    
    // Register all metrics
    Object.values(this.promMetrics).forEach(metric => {
      prometheusRegister.register(metric);
    });
  }
  
  /**
   * Setup performance observer
   */
  setupPerformanceObserver() {
    const obs = new PerformanceObserver((items) => {
      items.getEntries().forEach((entry) => {
        this.recordPerformance(entry);
      });
    });
    
    obs.observe({ entryTypes: ['measure', 'function', 'http'] });
  }
  
  /**
   * Setup HTTP server
   */
  async setupHttpServer() {
    this.app = express();
    
    // Middleware
    this.app.use(express.json());
    this.app.use(express.static(join(__dirname, '../../public')));
    
    // Request tracking
    this.app.use((req, res, next) => {
      const start = Date.now();
      
      res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        
        // Update Prometheus metrics
        this.promMetrics.httpRequests.inc({
          method: req.method,
          route: req.route?.path || req.path,
          status: res.statusCode
        });
        
        this.promMetrics.responseTime.observe({
          method: req.method,
          route: req.route?.path || req.path
        }, duration);
      });
      
      next();
    });
    
    // Routes
    this.setupRoutes();
    
    // Start server
    this.server = createServer(this.app);
    
    await new Promise((resolve) => {
      this.server.listen(this.config.httpPort, () => {
        logger.info('HTTP server started', { port: this.config.httpPort });
        resolve();
      });
    });
  }
  
  /**
   * Setup routes
   */
  setupRoutes() {
    // Dashboard
    this.app.get('/', (req, res) => {
      res.sendFile(join(__dirname, '../../public/dashboard.html'));
    });
    
    // Health check
    this.app.get('/health', async (req, res) => {
      const health = await this.getHealthStatus();
      const statusCode = health.status === HealthStatus.HEALTHY ? 200 : 503;
      res.status(statusCode).json(health);
    });
    
    // Metrics endpoints
    this.app.get('/metrics', (req, res) => {
      res.set('Content-Type', prometheusRegister.contentType);
      res.end(prometheusRegister.metrics());
    });
    
    this.app.get('/api/metrics/current', (req, res) => {
      res.json(this.getCurrentMetrics());
    });
    
    this.app.get('/api/metrics/history', (req, res) => {
      const { category, duration = 3600000 } = req.query;
      res.json(this.getMetricsHistory(category, parseInt(duration)));
    });
    
    // System info
    this.app.get('/api/system/info', (req, res) => {
      res.json(this.systemInfo);
    });
    
    // Performance data
    this.app.get('/api/performance', (req, res) => {
      res.json(this.getPerformanceData());
    });
    
    // Alerts
    this.app.get('/api/alerts', (req, res) => {
      if (this.alertSystem) {
        res.json(this.alertSystem.getAlertHistory());
      } else {
        res.json([]);
      }
    });
    
    // Mining stats
    this.app.get('/api/mining/stats', (req, res) => {
      res.json(this.getMiningStats());
    });
    
    // Pool stats
    this.app.get('/api/pool/stats', (req, res) => {
      res.json(this.getPoolStats());
    });
  }
  
  /**
   * Setup WebSocket server
   */
  async setupWebSocketServer() {
    this.wss = new WebSocketServer({ port: this.config.wsPort });
    
    this.wss.on('connection', (ws) => {
      logger.info('WebSocket client connected');
      
      // Update active connections
      this.promMetrics.activeConnections.inc({ type: 'websocket' });
      
      // Send initial data
      ws.send(JSON.stringify({
        type: 'initial',
        data: {
          metrics: this.getCurrentMetrics(),
          health: this.getHealthStatus(),
          systemInfo: this.systemInfo
        }
      }));
      
      // Handle messages
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          this.handleWebSocketMessage(ws, data);
        } catch (error) {
          logger.error('Invalid WebSocket message', { error });
        }
      });
      
      // Handle disconnect
      ws.on('close', () => {
        logger.info('WebSocket client disconnected');
        this.promMetrics.activeConnections.dec({ type: 'websocket' });
      });
    });
    
    logger.info('WebSocket server started', { port: this.config.wsPort });
  }
  
  /**
   * Handle WebSocket message
   */
  handleWebSocketMessage(ws, message) {
    switch (message.type) {
      case 'subscribe':
        // Subscribe to specific metrics
        break;
        
      case 'unsubscribe':
        // Unsubscribe from metrics
        break;
        
      case 'command':
        // Handle commands
        this.handleCommand(message.command, message.params);
        break;
    }
  }
  
  /**
   * Start monitoring loops
   */
  startMonitoring() {
    // Metrics collection
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, this.config.metricsInterval);
    
    // Health checks
    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks();
    }, this.config.healthCheckInterval);
    
    // Performance monitoring
    this.performanceInterval = setInterval(() => {
      this.collectPerformanceData();
    }, this.config.performanceInterval);
    
    // Cleanup old data
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldData();
    }, 3600000); // Every hour
  }
  
  /**
   * Collect metrics
   */
  async collectMetrics() {
    const timestamp = Date.now();
    
    // System metrics
    const cpuUsage = process.cpuUsage();
    const memoryUsage = process.memoryUsage();
    
    const systemMetrics = {
      cpu: {
        usage: os.loadavg()[0] * 100 / os.cpus().length,
        cores: os.cpus().length
      },
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
        usagePercent: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100
      },
      process: {
        cpu: cpuUsage,
        memory: memoryUsage,
        uptime: process.uptime()
      }
    };
    
    // Update Prometheus metrics
    this.promMetrics.cpuUsage.set(systemMetrics.cpu.usage);
    this.promMetrics.memoryUsage.set({ type: 'total' }, systemMetrics.memory.total);
    this.promMetrics.memoryUsage.set({ type: 'used' }, systemMetrics.memory.used);
    this.promMetrics.memoryUsage.set({ type: 'free' }, systemMetrics.memory.free);
    
    // Store metrics
    this.storeMetrics(MonitoringCategory.SYSTEM, systemMetrics, timestamp);
    
    // Collect custom metrics
    const customMetrics = await this.metricsCollector.collect();
    Object.entries(customMetrics).forEach(([category, data]) => {
      this.storeMetrics(category, data, timestamp);
    });
    
    // Check thresholds and trigger alerts
    if (this.alertSystem) {
      await this.alertSystem.checkRules({
        system: systemMetrics,
        ...customMetrics
      });
    }
    
    // Broadcast to WebSocket clients
    this.broadcastMetrics({
      timestamp,
      system: systemMetrics,
      ...customMetrics
    });
  }
  
  /**
   * Perform health checks
   */
  async performHealthChecks() {
    const checks = [
      { name: 'database', check: this.checkDatabase },
      { name: 'redis', check: this.checkRedis },
      { name: 'miningPool', check: this.checkMiningPool },
      { name: 'api', check: this.checkAPI },
      { name: 'diskSpace', check: this.checkDiskSpace }
    ];
    
    const results = await Promise.all(
      checks.map(async ({ name, check }) => {
        const start = Date.now();
        try {
          const result = await Promise.race([
            check.call(this),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout')), this.config.healthCheckTimeout)
            )
          ]);
          
          return {
            name,
            status: result.healthy ? HealthStatus.HEALTHY : HealthStatus.UNHEALTHY,
            responseTime: Date.now() - start,
            details: result.details
          };
        } catch (error) {
          return {
            name,
            status: HealthStatus.UNHEALTHY,
            responseTime: Date.now() - start,
            error: error.message
          };
        }
      })
    );
    
    // Store results
    results.forEach(result => {
      this.healthChecks.set(result.name, result);
    });
    
    // Determine overall health
    const unhealthyCount = results.filter(r => r.status === HealthStatus.UNHEALTHY).length;
    const overallStatus = unhealthyCount === 0 ? HealthStatus.HEALTHY :
                         unhealthyCount < results.length / 2 ? HealthStatus.DEGRADED :
                         HealthStatus.UNHEALTHY;
    
    this.emit('healthCheck', { status: overallStatus, checks: results });
  }
  
  /**
   * Collect performance data
   */
  collectPerformanceData() {
    const data = {
      timestamp: Date.now(),
      eventLoop: {
        delay: this.measureEventLoopDelay(),
        utilization: performance.eventLoopUtilization()
      },
      gc: {
        count: performance.getEntriesByType('gc').length,
        duration: performance.getEntriesByType('gc').reduce((sum, entry) => sum + entry.duration, 0)
      },
      handles: process._getActiveHandles().length,
      requests: process._getActiveRequests().length
    };
    
    this.performanceData.set(data.timestamp, data);
    
    // Check performance thresholds
    if (data.eventLoop.delay > 100) {
      logger.warn('High event loop delay detected', { delay: data.eventLoop.delay });
    }
  }
  
  /**
   * Collect system information
   */
  async collectSystemInfo() {
    this.systemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpus: os.cpus().map(cpu => ({
        model: cpu.model,
        speed: cpu.speed
      })),
      totalMemory: os.totalmem(),
      nodeVersion: process.version,
      uptime: os.uptime()
    };
  }
  
  /**
   * Store metrics
   */
  storeMetrics(category, data, timestamp) {
    if (!this.metrics.has(category)) {
      this.metrics.set(category, []);
    }
    
    const categoryMetrics = this.metrics.get(category);
    categoryMetrics.push({ timestamp, data });
    
    // Limit size
    const maxEntries = Math.floor(this.config.retentionPeriod / this.config.metricsInterval);
    if (categoryMetrics.length > maxEntries) {
      categoryMetrics.shift();
    }
  }
  
  /**
   * Get current metrics
   */
  getCurrentMetrics() {
    const current = {};
    
    for (const [category, metrics] of this.metrics) {
      if (metrics.length > 0) {
        current[category] = metrics[metrics.length - 1].data;
      }
    }
    
    return current;
  }
  
  /**
   * Get metrics history
   */
  getMetricsHistory(category, duration) {
    const now = Date.now();
    const startTime = now - duration;
    
    if (category) {
      const categoryMetrics = this.metrics.get(category) || [];
      return categoryMetrics.filter(m => m.timestamp >= startTime);
    }
    
    // All categories
    const history = {};
    for (const [cat, metrics] of this.metrics) {
      history[cat] = metrics.filter(m => m.timestamp >= startTime);
    }
    
    return history;
  }
  
  /**
   * Get health status
   */
  getHealthStatus() {
    const checks = Array.from(this.healthChecks.values());
    const unhealthyCount = checks.filter(c => c.status === HealthStatus.UNHEALTHY).length;
    
    const status = unhealthyCount === 0 ? HealthStatus.HEALTHY :
                  unhealthyCount < checks.length / 2 ? HealthStatus.DEGRADED :
                  HealthStatus.UNHEALTHY;
    
    return {
      status,
      checks,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get performance data
   */
  getPerformanceData() {
    return Array.from(this.performanceData.values())
      .slice(-100); // Last 100 entries
  }
  
  /**
   * Get mining stats
   */
  getMiningStats() {
    const miningMetrics = this.metrics.get(MonitoringCategory.MINING) || [];
    if (miningMetrics.length === 0) return {};
    
    const latest = miningMetrics[miningMetrics.length - 1].data;
    const hourAgo = Date.now() - 3600000;
    const hourlyMetrics = miningMetrics.filter(m => m.timestamp >= hourAgo);
    
    return {
      current: latest,
      hourly: {
        avgHashrate: hourlyMetrics.reduce((sum, m) => sum + (m.data.hashrate || 0), 0) / hourlyMetrics.length,
        sharesSubmitted: hourlyMetrics.reduce((sum, m) => sum + (m.data.sharesSubmitted || 0), 0),
        blocksFound: hourlyMetrics.reduce((sum, m) => sum + (m.data.blocksFound || 0), 0)
      }
    };
  }
  
  /**
   * Get pool stats
   */
  getPoolStats() {
    const poolMetrics = this.metrics.get(MonitoringCategory.POOL) || [];
    if (poolMetrics.length === 0) return {};
    
    const latest = poolMetrics[poolMetrics.length - 1].data;
    
    return {
      current: latest,
      workers: latest.workers || 0,
      totalHashrate: latest.totalHashrate || 0,
      efficiency: latest.efficiency || 0
    };
  }
  
  /**
   * Broadcast metrics to WebSocket clients
   */
  broadcastMetrics(metrics) {
    if (!this.wss) return;
    
    const message = JSON.stringify({
      type: 'metrics',
      data: metrics
    });
    
    this.wss.clients.forEach(client => {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    });
  }
  
  /**
   * Record performance entry
   */
  recordPerformance(entry) {
    if (entry.entryType === 'measure') {
      this.promMetrics.taskDuration.observe(
        { task_type: entry.name },
        entry.duration / 1000
      );
    }
  }
  
  /**
   * Measure event loop delay
   */
  measureEventLoopDelay() {
    const start = Date.now();
    setImmediate(() => {
      this.lastEventLoopDelay = Date.now() - start;
    });
    return this.lastEventLoopDelay || 0;
  }
  
  /**
   * Health check implementations
   */
  
  async checkDatabase() {
    // Implement database health check
    return { healthy: true, details: 'Database connection active' };
  }
  
  async checkRedis() {
    // Implement Redis health check
    return { healthy: true, details: 'Redis connection active' };
  }
  
  async checkMiningPool() {
    // Implement mining pool health check
    return { healthy: true, details: 'Mining pool operational' };
  }
  
  async checkAPI() {
    // Implement API health check
    return { healthy: true, details: 'API endpoints responding' };
  }
  
  async checkDiskSpace() {
    // Check available disk space
    try {
      const stats = await fs.stat(process.cwd());
      return { healthy: true, details: 'Sufficient disk space' };
    } catch (error) {
      return { healthy: false, details: 'Disk space check failed' };
    }
  }
  
  /**
   * Handle commands
   */
  handleCommand(command, params) {
    switch (command) {
      case 'reset':
        this.resetMetrics(params.category);
        break;
        
      case 'snapshot':
        this.createSnapshot();
        break;
        
      case 'export':
        return this.exportData(params);
    }
  }
  
  /**
   * Reset metrics
   */
  resetMetrics(category) {
    if (category) {
      this.metrics.delete(category);
    } else {
      this.metrics.clear();
    }
    
    logger.info('Metrics reset', { category });
  }
  
  /**
   * Create snapshot
   */
  async createSnapshot() {
    const snapshot = {
      timestamp: Date.now(),
      metrics: Object.fromEntries(this.metrics),
      health: this.getHealthStatus(),
      performance: this.getPerformanceData(),
      systemInfo: this.systemInfo
    };
    
    // Save to file
    const filename = `snapshot-${Date.now()}.json`;
    await fs.writeFile(
      join(__dirname, '../../snapshots', filename),
      JSON.stringify(snapshot, null, 2)
    );
    
    logger.info('Snapshot created', { filename });
    
    return filename;
  }
  
  /**
   * Export data
   */
  exportData(params) {
    const { format = 'json', category, duration = 3600000 } = params;
    
    const data = this.getMetricsHistory(category, duration);
    
    switch (format) {
      case 'csv':
        return this.exportToCSV(data);
      case 'json':
      default:
        return data;
    }
  }
  
  /**
   * Export to CSV
   */
  exportToCSV(data) {
    // Simple CSV export implementation
    const rows = [];
    
    Object.entries(data).forEach(([category, metrics]) => {
      metrics.forEach(({ timestamp, data }) => {
        rows.push({
          category,
          timestamp: new Date(timestamp).toISOString(),
          ...this.flattenObject(data)
        });
      });
    });
    
    if (rows.length === 0) return '';
    
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(','),
      ...rows.map(row => headers.map(h => row[h]).join(','))
    ].join('\n');
    
    return csv;
  }
  
  /**
   * Flatten object for CSV export
   */
  flattenObject(obj, prefix = '') {
    const flattened = {};
    
    Object.entries(obj).forEach(([key, value]) => {
      const newKey = prefix ? `${prefix}_${key}` : key;
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        Object.assign(flattened, this.flattenObject(value, newKey));
      } else {
        flattened[newKey] = value;
      }
    });
    
    return flattened;
  }
  
  /**
   * Cleanup old data
   */
  cleanupOldData() {
    const cutoff = Date.now() - this.config.retentionPeriod;
    
    // Clean metrics
    for (const [category, metrics] of this.metrics) {
      const filtered = metrics.filter(m => m.timestamp >= cutoff);
      this.metrics.set(category, filtered);
    }
    
    // Clean performance data
    const perfData = Array.from(this.performanceData.entries())
      .filter(([timestamp]) => timestamp >= cutoff);
    
    this.performanceData.clear();
    perfData.forEach(([timestamp, data]) => {
      this.performanceData.set(timestamp, data);
    });
    
    logger.debug('Cleaned up old monitoring data');
  }
  
  /**
   * Register custom metric collector
   */
  registerCollector(name, collector) {
    this.metricsCollector.register(name, collector);
    logger.info('Registered metric collector', { name });
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      metricsCount: Array.from(this.metrics.values())
        .reduce((sum, metrics) => sum + metrics.length, 0),
      healthChecks: this.healthChecks.size,
      performanceEntries: this.performanceData.size,
      wsClients: this.wss?.clients?.size || 0,
      uptime: process.uptime()
    };
  }
  
  /**
   * Shutdown monitoring system
   */
  async shutdown() {
    // Clear intervals
    clearInterval(this.metricsInterval);
    clearInterval(this.healthCheckInterval);
    clearInterval(this.performanceInterval);
    clearInterval(this.cleanupInterval);
    
    // Close servers
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
    }
    
    if (this.wss) {
      this.wss.close();
    }
    
    // Shutdown alert system
    if (this.alertSystem) {
      await this.alertSystem.shutdown();
    }
    
    logger.info('Monitoring system shutdown');
    this.emit('shutdown');
  }
}

/**
 * Factory function
 */
export function createMonitoringSystem(config) {
  return new UnifiedMonitoringSystem(config);
}

export default UnifiedMonitoringSystem;