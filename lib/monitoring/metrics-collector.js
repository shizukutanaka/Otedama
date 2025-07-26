/**
 * Metrics Collector - Otedama
 * High-performance metrics collection for national-scale mining operations
 * 
 * Design Principles:
 * - Carmack: Minimal overhead with ring buffers
 * - Martin: Clean separation of collection and reporting
 * - Pike: Simple interface for complex metrics
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import os from 'os';

const logger = createStructuredLogger('MetricsCollector');

/**
 * Time-series data store using ring buffers
 */
class TimeSeriesBuffer {
  constructor(size = 3600) { // 1 hour at 1-second resolution
    this.size = size;
    this.buffer = new Float64Array(size);
    this.timestamps = new Float64Array(size);
    this.index = 0;
    this.count = 0;
  }
  
  add(value, timestamp = Date.now()) {
    this.buffer[this.index] = value;
    this.timestamps[this.index] = timestamp;
    this.index = (this.index + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  
  getLatest(n = 60) {
    const result = [];
    const start = this.count < this.size ? 0 : this.index;
    
    for (let i = 0; i < Math.min(n, this.count); i++) {
      const idx = (start + this.count - i - 1) % this.size;
      result.push({
        value: this.buffer[idx],
        timestamp: this.timestamps[idx]
      });
    }
    
    return result.reverse();
  }
  
  getAverage(seconds = 60) {
    const data = this.getLatest(seconds);
    if (data.length === 0) return 0;
    
    const sum = data.reduce((acc, item) => acc + item.value, 0);
    return sum / data.length;
  }
  
  getMax(seconds = 60) {
    const data = this.getLatest(seconds);
    if (data.length === 0) return 0;
    
    return Math.max(...data.map(item => item.value));
  }
  
  getMin(seconds = 60) {
    const data = this.getLatest(seconds);
    if (data.length === 0) return 0;
    
    return Math.min(...data.map(item => item.value));
  }
}

/**
 * Metrics Collector
 */
export class MetricsCollector extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      collectInterval: config.collectInterval || 1000, // 1 second
      retentionPeriod: config.retentionPeriod || 86400000, // 24 hours
      alertThresholds: config.alertThresholds || {},
      ...config
    };
    
    // Metric buffers
    this.metrics = {
      // Pool metrics
      hashrate: new TimeSeriesBuffer(86400), // 24 hours at 1-second resolution
      difficulty: new TimeSeriesBuffer(3600),
      miners: new TimeSeriesBuffer(3600),
      workers: new TimeSeriesBuffer(3600),
      
      // Share metrics
      sharesPerSecond: new TimeSeriesBuffer(3600),
      shareAcceptRate: new TimeSeriesBuffer(3600),
      averageShareTime: new TimeSeriesBuffer(3600),
      
      // Block metrics
      blocksFound: new TimeSeriesBuffer(86400),
      blockEffort: new TimeSeriesBuffer(3600),
      
      // Network metrics
      connections: new TimeSeriesBuffer(3600),
      bandwidth: new TimeSeriesBuffer(3600),
      latency: new TimeSeriesBuffer(3600),
      
      // System metrics
      cpuUsage: new TimeSeriesBuffer(3600),
      memoryUsage: new TimeSeriesBuffer(3600),
      diskUsage: new TimeSeriesBuffer(3600),
      
      // Economic metrics
      revenue: new TimeSeriesBuffer(86400),
      payouts: new TimeSeriesBuffer(86400),
      fees: new TimeSeriesBuffer(86400)
    };
    
    // Counters
    this.counters = {
      totalShares: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      totalBlocks: 0,
      totalRevenue: 0,
      totalPayouts: 0,
      totalFees: 0
    };
    
    // Current values
    this.current = {
      hashrate: 0,
      difficulty: 0,
      miners: 0,
      workers: 0,
      efficiency: 0,
      uptime: 0
    };
    
    // Alert state
    this.alerts = new Map();
    
    // Collection state
    this.collecting = false;
    this.collectTimer = null;
    
    this.logger = logger;
  }
  
  /**
   * Start metrics collection
   */
  start() {
    if (this.collecting) return;
    
    this.collecting = true;
    this.startTime = Date.now();
    
    // Start collection timer
    this.collectTimer = setInterval(() => {
      this.collectMetrics();
    }, this.config.collectInterval);
    
    this.logger.info('Metrics collection started');
  }
  
  /**
   * Stop metrics collection
   */
  stop() {
    if (!this.collecting) return;
    
    this.collecting = false;
    
    if (this.collectTimer) {
      clearInterval(this.collectTimer);
      this.collectTimer = null;
    }
    
    this.logger.info('Metrics collection stopped');
  }
  
  /**
   * Collect system metrics
   */
  collectMetrics() {
    const now = Date.now();
    
    // System metrics
    const cpuUsage = this.getCPUUsage();
    const memoryUsage = this.getMemoryUsage();
    
    this.metrics.cpuUsage.add(cpuUsage, now);
    this.metrics.memoryUsage.add(memoryUsage, now);
    
    // Update uptime
    this.current.uptime = now - this.startTime;
    
    // Check thresholds and generate alerts
    this.checkThresholds();
    
    // Emit collected metrics
    this.emit('metrics:collected', {
      timestamp: now,
      metrics: this.getCurrentMetrics()
    });
  }
  
  /**
   * Update pool metrics
   */
  updatePoolMetrics(data) {
    const now = Date.now();
    
    if (data.hashrate !== undefined) {
      this.current.hashrate = data.hashrate;
      this.metrics.hashrate.add(data.hashrate, now);
    }
    
    if (data.difficulty !== undefined) {
      this.current.difficulty = data.difficulty;
      this.metrics.difficulty.add(data.difficulty, now);
    }
    
    if (data.miners !== undefined) {
      this.current.miners = data.miners;
      this.metrics.miners.add(data.miners, now);
    }
    
    if (data.workers !== undefined) {
      this.current.workers = data.workers;
      this.metrics.workers.add(data.workers, now);
    }
  }
  
  /**
   * Record share submission
   */
  recordShare(accepted, difficulty) {
    const now = Date.now();
    
    this.counters.totalShares++;
    
    if (accepted) {
      this.counters.acceptedShares++;
    } else {
      this.counters.rejectedShares++;
    }
    
    // Calculate shares per second
    const recentShares = this.metrics.sharesPerSecond.getLatest(10);
    const sharesPerSecond = recentShares.length > 0 ? 
      recentShares.length / 10 : 0;
    
    this.metrics.sharesPerSecond.add(sharesPerSecond, now);
    
    // Calculate acceptance rate
    const acceptRate = this.counters.totalShares > 0 ?
      this.counters.acceptedShares / this.counters.totalShares : 0;
    
    this.metrics.shareAcceptRate.add(acceptRate * 100, now);
  }
  
  /**
   * Record block found
   */
  recordBlock(block) {
    const now = Date.now();
    
    this.counters.totalBlocks++;
    this.metrics.blocksFound.add(1, now);
    
    // Calculate block effort (shares since last block)
    const sharesSinceLastBlock = this.counters.totalShares;
    const expectedShares = block.difficulty;
    const effort = (sharesSinceLastBlock / expectedShares) * 100;
    
    this.metrics.blockEffort.add(effort, now);
    
    // Emit block found event
    this.emit('block:found', {
      timestamp: now,
      height: block.height,
      hash: block.hash,
      effort: effort
    });
  }
  
  /**
   * Record financial metrics
   */
  recordFinancial(type, amount) {
    const now = Date.now();
    
    switch (type) {
      case 'revenue':
        this.counters.totalRevenue += amount;
        this.metrics.revenue.add(amount, now);
        break;
        
      case 'payout':
        this.counters.totalPayouts += amount;
        this.metrics.payouts.add(amount, now);
        break;
        
      case 'fee':
        this.counters.totalFees += amount;
        this.metrics.fees.add(amount, now);
        break;
    }
  }
  
  /**
   * Get CPU usage percentage
   */
  getCPUUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);
    
    return usage;
  }
  
  /**
   * Get memory usage percentage
   */
  getMemoryUsage() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    return (usedMem / totalMem) * 100;
  }
  
  /**
   * Check alert thresholds
   */
  checkThresholds() {
    const thresholds = this.config.alertThresholds;
    
    // CPU usage alert
    if (thresholds.cpuUsage) {
      const cpuUsage = this.metrics.cpuUsage.getAverage(60);
      if (cpuUsage > thresholds.cpuUsage) {
        this.triggerAlert('high_cpu_usage', {
          current: cpuUsage,
          threshold: thresholds.cpuUsage
        });
      }
    }
    
    // Memory usage alert
    if (thresholds.memoryUsage) {
      const memUsage = this.metrics.memoryUsage.getAverage(60);
      if (memUsage > thresholds.memoryUsage) {
        this.triggerAlert('high_memory_usage', {
          current: memUsage,
          threshold: thresholds.memoryUsage
        });
      }
    }
    
    // Low hashrate alert
    if (thresholds.minHashrate) {
      const hashrate = this.current.hashrate;
      if (hashrate < thresholds.minHashrate && hashrate > 0) {
        this.triggerAlert('low_hashrate', {
          current: hashrate,
          threshold: thresholds.minHashrate
        });
      }
    }
    
    // Share rejection rate alert
    if (thresholds.maxRejectRate) {
      const rejectRate = 100 - this.metrics.shareAcceptRate.getAverage(300);
      if (rejectRate > thresholds.maxRejectRate) {
        this.triggerAlert('high_reject_rate', {
          current: rejectRate,
          threshold: thresholds.maxRejectRate
        });
      }
    }
  }
  
  /**
   * Trigger alert
   */
  triggerAlert(type, data) {
    const alert = this.alerts.get(type);
    const now = Date.now();
    
    // Debounce alerts (don't trigger same alert within 5 minutes)
    if (alert && now - alert.timestamp < 300000) {
      return;
    }
    
    const alertData = {
      type,
      timestamp: now,
      data,
      severity: this.getAlertSeverity(type)
    };
    
    this.alerts.set(type, alertData);
    
    this.logger.warn('Alert triggered', alertData);
    this.emit('alert', alertData);
  }
  
  /**
   * Get alert severity
   */
  getAlertSeverity(type) {
    const severityMap = {
      high_cpu_usage: 'warning',
      high_memory_usage: 'warning',
      low_hashrate: 'critical',
      high_reject_rate: 'error',
      no_blocks_found: 'warning',
      pool_offline: 'critical'
    };
    
    return severityMap[type] || 'info';
  }
  
  /**
   * Get current metrics snapshot
   */
  getCurrentMetrics() {
    return {
      pool: {
        hashrate: this.current.hashrate,
        hashrateAvg1h: this.metrics.hashrate.getAverage(3600),
        hashrateAvg24h: this.metrics.hashrate.getAverage(86400),
        difficulty: this.current.difficulty,
        miners: this.current.miners,
        workers: this.current.workers,
        efficiency: this.calculateEfficiency()
      },
      shares: {
        total: this.counters.totalShares,
        accepted: this.counters.acceptedShares,
        rejected: this.counters.rejectedShares,
        acceptRate: this.metrics.shareAcceptRate.getAverage(300),
        sharesPerSecond: this.metrics.sharesPerSecond.getAverage(60)
      },
      blocks: {
        total: this.counters.totalBlocks,
        last24h: this.getBlocksLast24h(),
        averageEffort: this.metrics.blockEffort.getAverage(3600)
      },
      system: {
        cpuUsage: this.metrics.cpuUsage.getAverage(60),
        memoryUsage: this.metrics.memoryUsage.getAverage(60),
        uptime: this.current.uptime,
        connections: this.metrics.connections.getLatest(1)[0]?.value || 0
      },
      financial: {
        totalRevenue: this.counters.totalRevenue,
        totalPayouts: this.counters.totalPayouts,
        totalFees: this.counters.totalFees,
        revenue24h: this.getRevenueLast24h(),
        profitMargin: this.calculateProfitMargin()
      }
    };
  }
  
  /**
   * Calculate mining efficiency
   */
  calculateEfficiency() {
    if (this.current.hashrate === 0) return 0;
    
    const theoreticalShares = this.current.hashrate / this.current.difficulty;
    const actualShares = this.metrics.sharesPerSecond.getAverage(300);
    
    return (actualShares / theoreticalShares) * 100;
  }
  
  /**
   * Get blocks found in last 24 hours
   */
  getBlocksLast24h() {
    const blocks = this.metrics.blocksFound.getLatest(86400);
    return blocks.reduce((sum, item) => sum + item.value, 0);
  }
  
  /**
   * Get revenue in last 24 hours
   */
  getRevenueLast24h() {
    const revenue = this.metrics.revenue.getLatest(86400);
    return revenue.reduce((sum, item) => sum + item.value, 0);
  }
  
  /**
   * Calculate profit margin
   */
  calculateProfitMargin() {
    if (this.counters.totalRevenue === 0) return 0;
    
    const profit = this.counters.totalRevenue - this.counters.totalPayouts;
    return (profit / this.counters.totalRevenue) * 100;
  }
  
  /**
   * Get historical data
   */
  getHistoricalData(metric, duration = 3600) {
    if (!this.metrics[metric]) {
      throw new Error(`Unknown metric: ${metric}`);
    }
    
    return this.metrics[metric].getLatest(duration);
  }
  
  /**
   * Export metrics for external monitoring
   */
  exportMetrics(format = 'prometheus') {
    switch (format) {
      case 'prometheus':
        return this.exportPrometheus();
      case 'json':
        return this.getCurrentMetrics();
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }
  
  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus() {
    const metrics = this.getCurrentMetrics();
    const lines = [];
    
    // Pool metrics
    lines.push(`# HELP otedama_hashrate_total Pool hashrate in H/s`);
    lines.push(`# TYPE otedama_hashrate_total gauge`);
    lines.push(`otedama_hashrate_total ${metrics.pool.hashrate}`);
    
    lines.push(`# HELP otedama_miners_active Active miners`);
    lines.push(`# TYPE otedama_miners_active gauge`);
    lines.push(`otedama_miners_active ${metrics.pool.miners}`);
    
    // Share metrics
    lines.push(`# HELP otedama_shares_total Total shares submitted`);
    lines.push(`# TYPE otedama_shares_total counter`);
    lines.push(`otedama_shares_total ${metrics.shares.total}`);
    
    lines.push(`# HELP otedama_share_accept_rate Share acceptance rate`);
    lines.push(`# TYPE otedama_share_accept_rate gauge`);
    lines.push(`otedama_share_accept_rate ${metrics.shares.acceptRate}`);
    
    // Block metrics
    lines.push(`# HELP otedama_blocks_found_total Total blocks found`);
    lines.push(`# TYPE otedama_blocks_found_total counter`);
    lines.push(`otedama_blocks_found_total ${metrics.blocks.total}`);
    
    // System metrics
    lines.push(`# HELP otedama_cpu_usage_percent CPU usage percentage`);
    lines.push(`# TYPE otedama_cpu_usage_percent gauge`);
    lines.push(`otedama_cpu_usage_percent ${metrics.system.cpuUsage}`);
    
    lines.push(`# HELP otedama_memory_usage_percent Memory usage percentage`);
    lines.push(`# TYPE otedama_memory_usage_percent gauge`);
    lines.push(`otedama_memory_usage_percent ${metrics.system.memoryUsage}`);
    
    return lines.join('\n');
  }
}

export default MetricsCollector;