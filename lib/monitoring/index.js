/**
 * Unified Monitoring Module for Otedama
 * Consolidates monitoring and real-time monitoring functionality
 */

// Import core monitoring components
import { 
  MetricsCollector, 
  AlertManager, 
  BusinessAnalytics, 
  HealthMonitor 
} from './core.js';

// Import real-time monitoring
import { RealTimeMonitor } from './realtime.js';

// Re-export all functionality
export {
  // Core monitoring
  MetricsCollector,
  AlertManager,
  BusinessAnalytics,
  HealthMonitor,
  
  // Real-time monitoring
  RealTimeMonitor
};

/**
 * Unified Monitoring Manager
 * Integrates core metrics collection with real-time monitoring
 */
export class UnifiedMonitoringManager {
  constructor(options = {}) {
    // Initialize core components
    this.metrics = new MetricsCollector(options.metrics || {});
    this.alerts = new AlertManager(options.alerts || {});
    this.analytics = new BusinessAnalytics(options.database, options.cache);
    this.health = new HealthMonitor();
    this.realtime = new RealTimeMonitor();
    
    // Setup integration between components
    this.setupIntegration();
    
    // Start monitoring
    if (options.autoStart !== false) {
      this.start();
    }
  }
  
  /**
   * Setup integration between monitoring components
   */
  setupIntegration() {
    // Forward real-time metrics to core metrics collector
    this.realtime.on('metrics', (data) => {
      if (data.system) {
        this.metrics.gauge('system.cpu', data.system.cpuUsage);
        this.metrics.gauge('system.memory', data.system.memoryUsage);
        this.metrics.gauge('system.load', data.system.loadAverage[0]);
      }
      
      if (data.pool) {
        this.metrics.gauge('pool.hashrate', data.pool.totalHashrate);
        this.metrics.gauge('pool.miners', data.pool.activeMiners);
        this.metrics.gauge('pool.workers', data.pool.activeWorkers);
      }
      
      if (data.network) {
        this.metrics.gauge('network.peers', data.network.connectedPeers);
        this.metrics.gauge('network.bandwidth.in', data.network.bandwidthIn);
        this.metrics.gauge('network.bandwidth.out', data.network.bandwidthOut);
      }
    });
    
    // Forward alerts from real-time monitor to alert manager
    this.realtime.on('alert', (alert) => {
      this.alerts.check(alert.metric, alert.value, {
        source: 'realtime',
        ...alert
      });
    });
    
    // Setup health checks for real-time components
    this.health.addCheck('realtime_monitor', async () => {
      const subscriptions = this.realtime.subscriptions.size;
      const metrics = this.realtime.getLatestMetrics();
      
      return {
        healthy: subscriptions >= 0 && metrics !== null,
        details: {
          subscriptions,
          lastUpdate: metrics ? metrics.timestamp : null
        }
      };
    });
  }
  
  /**
   * Start all monitoring services
   */
  start() {
    // Start core monitoring
    this.metrics.startSystemMetrics();
    
    // Start real-time monitoring
    this.realtime.startMonitoring();
    
    // Start health checks
    this.startHealthChecks();
  }
  
  /**
   * Stop all monitoring services
   */
  stop() {
    // Stop monitoring services
    this.metrics.stopSystemMetrics();
    this.realtime.stopMonitoring();
    
    // Clear intervals
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }
  }
  
  /**
   * Start periodic health checks
   */
  startHealthChecks() {
    this.healthInterval = setInterval(async () => {
      const health = await this.health.check();
      
      if (!health.healthy) {
        this.alerts.trigger('system_health', 0, {
          checks: health.checks,
          timestamp: Date.now()
        });
      }
    }, 60000); // Check every minute
  }
  
  /**
   * Get comprehensive monitoring status
   */
  getStatus() {
    return {
      metrics: {
        collected: this.metrics.getMetricNames(),
        system: this.metrics.getMetric('system.*')
      },
      alerts: {
        active: this.alerts.getActiveAlerts(),
        history: this.alerts.getHistory()
      },
      realtime: {
        subscriptions: this.realtime.subscriptions.size,
        metrics: this.realtime.getLatestMetrics()
      },
      health: this.health.getLastCheckResult()
    };
  }
  
  /**
   * Get business analytics
   */
  async getAnalytics(type, options = {}) {
    switch (type) {
      case 'mining':
        return await this.analytics.getMiningAnalytics(options);
      case 'revenue':
        return await this.analytics.getRevenueAnalytics(options);
      case 'user':
        return await this.analytics.getUserAnalytics(options);
      case 'performance':
        return await this.analytics.getPerformanceAnalytics(options);
      default:
        throw new Error(`Unknown analytics type: ${type}`);
    }
  }
  
  /**
   * Subscribe to real-time updates
   */
  subscribe(ws, channels) {
    return this.realtime.subscribe(ws, channels);
  }
  
  /**
   * Unsubscribe from real-time updates
   */
  unsubscribe(ws) {
    return this.realtime.unsubscribe(ws);
  }
  
  /**
   * Add custom metric
   */
  addMetric(name, type, value, tags = {}) {
    return this.metrics[type](name, value, tags);
  }
  
  /**
   * Add custom alert rule
   */
  addAlertRule(name, threshold, condition = 'gt') {
    this.alerts.setThreshold(name, threshold, condition);
  }
  
  /**
   * Add custom health check
   */
  addHealthCheck(name, checkFn) {
    return this.health.addCheck(name, checkFn);
  }
  
  /**
   * Export metrics for external systems
   */
  exportMetrics(format = 'prometheus') {
    const metrics = this.metrics.getAllMetrics();
    
    switch (format) {
      case 'prometheus':
        return this.formatPrometheus(metrics);
      case 'json':
        return JSON.stringify(metrics, null, 2);
      default:
        return metrics;
    }
  }
  
  /**
   * Format metrics for Prometheus
   */
  formatPrometheus(metrics) {
    let output = '';
    
    for (const [name, data] of Object.entries(metrics)) {
      const metricName = name.replace(/\./g, '_');
      output += `# TYPE ${metricName} ${data.type}\n`;
      output += `${metricName} ${data.value} ${Date.now()}\n`;
    }
    
    return output;
  }
}

// Export default instance for convenience
export default UnifiedMonitoringManager;