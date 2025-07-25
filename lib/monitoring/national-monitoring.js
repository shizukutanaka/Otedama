/**
 * National-Grade Monitoring System for Otedama
 * Real-time monitoring with Prometheus integration
 * 
 * Design:
 * - Carmack: Low-overhead metrics collection
 * - Martin: Clean monitoring interfaces
 * - Pike: Simple but comprehensive metrics
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import promClient from 'prom-client';
import os from 'os';

// Initialize Prometheus registry
const register = new promClient.Registry();

// Default metrics
promClient.collectDefaultMetrics({ register });

/**
 * Custom metrics for mining pool
 */
const metrics = {
  // Pool metrics
  poolHashrate: new promClient.Gauge({
    name: 'pool_hashrate_total',
    help: 'Total pool hashrate in H/s',
    registers: [register]
  }),
  
  minersActive: new promClient.Gauge({
    name: 'pool_miners_active',
    help: 'Number of active miners',
    registers: [register]
  }),
  
  sharesAccepted: new promClient.Counter({
    name: 'pool_shares_accepted_total',
    help: 'Total accepted shares',
    labelNames: ['algorithm'],
    registers: [register]
  }),
  
  sharesRejected: new promClient.Counter({
    name: 'pool_shares_rejected_total',
    help: 'Total rejected shares',
    labelNames: ['algorithm', 'reason'],
    registers: [register]
  }),
  
  blocksFound: new promClient.Counter({
    name: 'pool_blocks_found_total',
    help: 'Total blocks found',
    labelNames: ['algorithm'],
    registers: [register]
  }),
  
  paymentsSent: new promClient.Counter({
    name: 'pool_payments_sent_total',
    help: 'Total payments sent',
    registers: [register]
  }),
  
  paymentAmount: new promClient.Histogram({
    name: 'pool_payment_amount',
    help: 'Payment amounts distribution',
    buckets: [0.001, 0.01, 0.1, 1, 10, 100],
    registers: [register]
  }),
  
  // Network metrics
  p2pPeers: new promClient.Gauge({
    name: 'p2p_peers_total',
    help: 'Total P2P network peers',
    registers: [register]
  }),
  
  p2pMessages: new promClient.Counter({
    name: 'p2p_messages_total',
    help: 'Total P2P messages',
    labelNames: ['type', 'direction'],
    registers: [register]
  }),
  
  networkLatency: new promClient.Histogram({
    name: 'network_latency_ms',
    help: 'Network latency in milliseconds',
    labelNames: ['peer_region'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
    registers: [register]
  }),
  
  // Security metrics
  requestsBlocked: new promClient.Counter({
    name: 'security_requests_blocked_total',
    help: 'Total blocked requests',
    labelNames: ['reason'],
    registers: [register]
  }),
  
  attacksDetected: new promClient.Counter({
    name: 'security_attacks_detected_total',
    help: 'Total detected attacks',
    labelNames: ['type'],
    registers: [register]
  }),
  
  blacklistedIPs: new promClient.Gauge({
    name: 'security_blacklisted_ips',
    help: 'Number of blacklisted IPs',
    registers: [register]
  }),
  
  // Performance metrics
  shareValidationTime: new promClient.Histogram({
    name: 'share_validation_duration_ms',
    help: 'Share validation time in milliseconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100],
    registers: [register]
  }),
  
  blockTemplateGeneration: new promClient.Histogram({
    name: 'block_template_generation_ms',
    help: 'Block template generation time',
    buckets: [10, 25, 50, 100, 250, 500, 1000],
    registers: [register]
  }),
  
  // System metrics
  cpuUsage: new promClient.Gauge({
    name: 'system_cpu_usage_percent',
    help: 'CPU usage percentage',
    labelNames: ['core'],
    registers: [register]
  }),
  
  memoryUsage: new promClient.Gauge({
    name: 'system_memory_usage_bytes',
    help: 'Memory usage in bytes',
    labelNames: ['type'],
    registers: [register]
  }),
  
  diskUsage: new promClient.Gauge({
    name: 'system_disk_usage_bytes',
    help: 'Disk usage in bytes',
    labelNames: ['path'],
    registers: [register]
  })
};

/**
 * Alert rules for monitoring
 */
const alertRules = {
  // Critical alerts
  poolHashrateDropped: {
    condition: (current, threshold) => current < threshold * 0.5,
    severity: 'critical',
    message: 'Pool hashrate dropped below 50%'
  },
  
  noMinersConnected: {
    condition: (miners) => miners === 0,
    severity: 'critical',
    message: 'No miners connected to pool'
  },
  
  highErrorRate: {
    condition: (rate) => rate > 0.1,
    severity: 'critical',
    message: 'Share error rate above 10%'
  },
  
  // Warning alerts
  highMemoryUsage: {
    condition: (usage) => usage > 0.9,
    severity: 'warning',
    message: 'Memory usage above 90%'
  },
  
  highCPUUsage: {
    condition: (usage) => usage > 0.8,
    severity: 'warning',
    message: 'CPU usage above 80%'
  },
  
  lowPeerCount: {
    condition: (peers) => peers < 10,
    severity: 'warning',
    message: 'P2P peer count below 10'
  }
};

/**
 * National monitoring system
 */
export class NationalMonitoringSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      collectInterval: options.collectInterval || 10000, // 10 seconds
      retentionPeriod: options.retentionPeriod || 86400000, // 24 hours
      alerting: options.alerting !== false,
      ...options
    };
    
    this.logger = createStructuredLogger('MonitoringSystem');
    this.metrics = metrics;
    this.register = register;
    this.alerts = new Map();
    this.history = new Map();
    
    // System monitoring
    this.systemMonitor = null;
    
    this.initialized = false;
  }
  
  /**
   * Initialize monitoring
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Start system monitoring
      this.startSystemMonitoring();
      
      // Start collection interval
      this.collectionInterval = setInterval(() => {
        this.collectMetrics();
      }, this.options.collectInterval);
      
      // Start alert checking
      if (this.options.alerting) {
        this.alertInterval = setInterval(() => {
          this.checkAlerts();
        }, 30000); // Check every 30 seconds
      }
      
      this.initialized = true;
      this.logger.info('National monitoring system initialized');
      
    } catch (error) {
      this.logger.error('Failed to initialize monitoring', error);
      throw error;
    }
  }
  
  /**
   * Update pool metrics
   */
  updatePoolMetrics(data) {
    if (data.hashrate !== undefined) {
      this.metrics.poolHashrate.set(data.hashrate);
    }
    
    if (data.miners !== undefined) {
      this.metrics.minersActive.set(data.miners);
    }
    
    if (data.sharesAccepted) {
      this.metrics.sharesAccepted.inc({
        algorithm: data.algorithm || 'unknown'
      }, data.sharesAccepted);
    }
    
    if (data.sharesRejected) {
      this.metrics.sharesRejected.inc({
        algorithm: data.algorithm || 'unknown',
        reason: data.rejectReason || 'unknown'
      }, data.sharesRejected);
    }
    
    if (data.blockFound) {
      this.metrics.blocksFound.inc({
        algorithm: data.algorithm || 'unknown'
      });
    }
  }
  
  /**
   * Update network metrics
   */
  updateNetworkMetrics(data) {
    if (data.peers !== undefined) {
      this.metrics.p2pPeers.set(data.peers);
    }
    
    if (data.message) {
      this.metrics.p2pMessages.inc({
        type: data.messageType || 'unknown',
        direction: data.direction || 'unknown'
      });
    }
    
    if (data.latency !== undefined && data.region) {
      this.metrics.networkLatency.observe({
        peer_region: data.region
      }, data.latency);
    }
  }
  
  /**
   * Update security metrics
   */
  updateSecurityMetrics(data) {
    if (data.blocked) {
      this.metrics.requestsBlocked.inc({
        reason: data.reason || 'unknown'
      });
    }
    
    if (data.attack) {
      this.metrics.attacksDetected.inc({
        type: data.attackType || 'unknown'
      });
    }
    
    if (data.blacklistedIPs !== undefined) {
      this.metrics.blacklistedIPs.set(data.blacklistedIPs);
    }
  }
  
  /**
   * Record performance metric
   */
  recordPerformance(metric, duration, labels = {}) {
    switch (metric) {
      case 'shareValidation':
        this.metrics.shareValidationTime.observe(labels, duration);
        break;
      case 'blockTemplate':
        this.metrics.blockTemplateGeneration.observe(labels, duration);
        break;
    }
  }
  
  /**
   * Start system monitoring
   */
  startSystemMonitoring() {
    // CPU monitoring
    const cpus = os.cpus();
    let previousCPU = cpus.map(cpu => ({
      idle: cpu.times.idle,
      total: Object.values(cpu.times).reduce((a, b) => a + b, 0)
    }));
    
    this.systemMonitor = setInterval(() => {
      // CPU usage
      const currentCPUs = os.cpus();
      currentCPUs.forEach((cpu, index) => {
        const currentTotal = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const totalDiff = currentTotal - previousCPU[index].total;
        const idleDiff = cpu.times.idle - previousCPU[index].idle;
        
        const usage = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
        
        this.metrics.cpuUsage.set({ core: `${index}` }, usage);
        
        previousCPU[index] = {
          idle: cpu.times.idle,
          total: currentTotal
        };
      });
      
      // Average CPU
      const avgCPU = currentCPUs.reduce((sum, cpu, index) => {
        const currentTotal = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        const totalDiff = currentTotal - previousCPU[index].total;
        const idleDiff = cpu.times.idle - previousCPU[index].idle;
        return sum + (totalDiff > 0 ? (1 - idleDiff / totalDiff) : 0);
      }, 0) / currentCPUs.length * 100;
      
      this.metrics.cpuUsage.set({ core: 'average' }, avgCPU);
      
      // Memory usage
      const mem = process.memoryUsage();
      this.metrics.memoryUsage.set({ type: 'heap' }, mem.heapUsed);
      this.metrics.memoryUsage.set({ type: 'rss' }, mem.rss);
      this.metrics.memoryUsage.set({ type: 'external' }, mem.external);
      
      // System memory
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      this.metrics.memoryUsage.set({ type: 'system_used' }, totalMem - freeMem);
      this.metrics.memoryUsage.set({ type: 'system_total' }, totalMem);
      
    }, 5000); // Every 5 seconds
  }
  
  /**
   * Collect metrics snapshot
   */
  collectMetrics() {
    const snapshot = {
      timestamp: Date.now(),
      pool: {
        hashrate: this.metrics.poolHashrate._getValue() || 0,
        miners: this.metrics.minersActive._getValue() || 0
      },
      network: {
        peers: this.metrics.p2pPeers._getValue() || 0
      },
      system: {
        cpu: this.metrics.cpuUsage._getValue({ core: 'average' }) || 0,
        memory: this.metrics.memoryUsage._getValue({ type: 'heap' }) || 0
      }
    };
    
    // Store in history
    const key = Math.floor(snapshot.timestamp / 60000); // 1 minute buckets
    if (!this.history.has(key)) {
      this.history.set(key, []);
    }
    this.history.get(key).push(snapshot);
    
    // Clean old history
    const cutoff = Date.now() - this.options.retentionPeriod;
    for (const [k, v] of this.history) {
      if (k * 60000 < cutoff) {
        this.history.delete(k);
      }
    }
    
    this.emit('metrics:collected', snapshot);
  }
  
  /**
   * Check alert conditions
   */
  checkAlerts() {
    const currentMetrics = {
      poolHashrate: this.metrics.poolHashrate._getValue() || 0,
      minersActive: this.metrics.minersActive._getValue() || 0,
      cpuUsage: this.metrics.cpuUsage._getValue({ core: 'average' }) || 0,
      memoryUsage: (this.metrics.memoryUsage._getValue({ type: 'heap' }) || 0) / 
                   (this.metrics.memoryUsage._getValue({ type: 'system_total' }) || 1),
      peerCount: this.metrics.p2pPeers._getValue() || 0
    };
    
    // Check each alert rule
    for (const [name, rule] of Object.entries(alertRules)) {
      let triggered = false;
      
      switch (name) {
        case 'poolHashrateDropped':
          // Need baseline to compare
          const baseline = this.getBaselineHashrate();
          if (baseline > 0) {
            triggered = rule.condition(currentMetrics.poolHashrate, baseline);
          }
          break;
          
        case 'noMinersConnected':
          triggered = rule.condition(currentMetrics.minersActive);
          break;
          
        case 'highMemoryUsage':
          triggered = rule.condition(currentMetrics.memoryUsage);
          break;
          
        case 'highCPUUsage':
          triggered = rule.condition(currentMetrics.cpuUsage);
          break;
          
        case 'lowPeerCount':
          triggered = rule.condition(currentMetrics.peerCount);
          break;
      }
      
      // Handle alert state changes
      const wasActive = this.alerts.has(name);
      
      if (triggered && !wasActive) {
        // New alert
        this.alerts.set(name, {
          triggered: Date.now(),
          severity: rule.severity,
          message: rule.message
        });
        
        this.emit('alert:triggered', {
          name,
          severity: rule.severity,
          message: rule.message,
          metrics: currentMetrics
        });
        
        this.logger.warn(`Alert triggered: ${rule.message}`, {
          alert: name,
          severity: rule.severity
        });
        
      } else if (!triggered && wasActive) {
        // Alert resolved
        const alert = this.alerts.get(name);
        this.alerts.delete(name);
        
        this.emit('alert:resolved', {
          name,
          duration: Date.now() - alert.triggered,
          message: alert.message
        });
        
        this.logger.info(`Alert resolved: ${alert.message}`, {
          alert: name,
          duration: Date.now() - alert.triggered
        });
      }
    }
  }
  
  /**
   * Get baseline hashrate (1 hour average)
   */
  getBaselineHashrate() {
    const oneHourAgo = Date.now() - 3600000;
    let total = 0;
    let count = 0;
    
    for (const [key, snapshots] of this.history) {
      const timestamp = key * 60000;
      if (timestamp > oneHourAgo) {
        for (const snapshot of snapshots) {
          total += snapshot.pool.hashrate;
          count++;
        }
      }
    }
    
    return count > 0 ? total / count : 0;
  }
  
  /**
   * Get metrics for Prometheus
   */
  async getMetrics() {
    return this.register.metrics();
  }
  
  /**
   * Get current alerts
   */
  getAlerts() {
    return Array.from(this.alerts.entries()).map(([name, alert]) => ({
      name,
      ...alert,
      active: true
    }));
  }
  
  /**
   * Get historical data
   */
  getHistory(duration = 3600000) { // 1 hour default
    const cutoff = Date.now() - duration;
    const data = [];
    
    for (const [key, snapshots] of this.history) {
      const timestamp = key * 60000;
      if (timestamp > cutoff) {
        data.push(...snapshots);
      }
    }
    
    return data.sort((a, b) => a.timestamp - b.timestamp);
  }
  
  /**
   * Create custom metric
   */
  createMetric(name, type, help, options = {}) {
    let metric;
    
    switch (type) {
      case 'counter':
        metric = new promClient.Counter({
          name,
          help,
          labelNames: options.labels || [],
          registers: [this.register]
        });
        break;
        
      case 'gauge':
        metric = new promClient.Gauge({
          name,
          help,
          labelNames: options.labels || [],
          registers: [this.register]
        });
        break;
        
      case 'histogram':
        metric = new promClient.Histogram({
          name,
          help,
          labelNames: options.labels || [],
          buckets: options.buckets || promClient.Histogram.defaultBuckets,
          registers: [this.register]
        });
        break;
        
      case 'summary':
        metric = new promClient.Summary({
          name,
          help,
          labelNames: options.labels || [],
          percentiles: options.percentiles || [0.5, 0.9, 0.99],
          registers: [this.register]
        });
        break;
        
      default:
        throw new Error(`Unknown metric type: ${type}`);
    }
    
    this.metrics[name] = metric;
    return metric;
  }
  
  /**
   * Shutdown monitoring
   */
  shutdown() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }
    
    if (this.alertInterval) {
      clearInterval(this.alertInterval);
    }
    
    if (this.systemMonitor) {
      clearInterval(this.systemMonitor);
    }
    
    this.register.clear();
    this.initialized = false;
    
    this.logger.info('Monitoring system shut down');
  }
}

// Export singleton instance
let monitoringInstance = null;

export function getMonitoringSystem(options = {}) {
  if (!monitoringInstance) {
    monitoringInstance = new NationalMonitoringSystem(options);
  }
  return monitoringInstance;
}

// Export metrics for direct access
export { metrics, register };

export default NationalMonitoringSystem;
