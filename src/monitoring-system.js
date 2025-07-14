import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { performance } from 'perf_hooks';
import os from 'os';

/**
 * Advanced Monitoring System
 * リアルタイムパフォーマンスモニタリング
 * 
 * Features:
 * - Real-time metrics collection
 * - Historical data tracking
 * - Alert system
 * - Performance analytics
 * - Predictive analysis
 */
export class MonitoringSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new Logger('Monitoring');
    
    // Metrics storage
    this.metrics = {
      system: {
        cpu: [],
        memory: [],
        disk: [],
        network: []
      },
      mining: {
        hashrate: [],
        shares: [],
        efficiency: [],
        blockFinds: []
      },
      pool: {
        connections: [],
        bandwidth: [],
        latency: [],
        rejectionRate: []
      },
      dex: {
        transactions: [],
        volume: [],
        liquidity: [],
        slippage: []
      },
      payments: {
        processed: [],
        pending: [],
        failed: [],
        fees: []
      }
    };
    
    // Alert configuration
    this.alertConfig = {
      cpu: { threshold: 90, window: 300000 }, // 5 minutes
      memory: { threshold: 85, window: 300000 },
      hashrate: { threshold: 0.8, window: 600000 }, // 80% drop
      rejectionRate: { threshold: 0.05, window: 300000 }, // 5% rejection
      latency: { threshold: 1000, window: 60000 }, // 1 second
      failedPayments: { threshold: 5, window: 3600000 } // 5 per hour
    };
    
    // Analytics configuration
    this.analyticsConfig = {
      sampleInterval: 10000, // 10 seconds
      historySize: 8640, // 24 hours of 10-second samples
      aggregationIntervals: [60000, 300000, 3600000], // 1min, 5min, 1hour
      predictionWindow: 3600000 // 1 hour prediction
    };
    
    // Active alerts
    this.activeAlerts = new Map();
    
    // Start monitoring
    this.startMonitoring();
  }

  /**
   * Start monitoring system
   */
  startMonitoring() {
    // Start metric collection
    this.metricsTimer = setInterval(() => {
      this.collectMetrics();
    }, this.analyticsConfig.sampleInterval);
    
    // Start analytics processing
    this.analyticsTimer = setInterval(() => {
      this.processAnalytics();
    }, 60000); // Every minute
    
    // Start alert checking
    this.alertTimer = setInterval(() => {
      this.checkAlerts();
    }, 30000); // Every 30 seconds
    
    this.logger.info('Advanced monitoring system started');
  }

  /**
   * Collect all metrics
   */
  async collectMetrics() {
    const timestamp = Date.now();
    
    // System metrics
    await this.collectSystemMetrics(timestamp);
    
    // Mining metrics
    this.collectMiningMetrics(timestamp);
    
    // Pool metrics
    this.collectPoolMetrics(timestamp);
    
    // DEX metrics
    this.collectDEXMetrics(timestamp);
    
    // Payment metrics
    this.collectPaymentMetrics(timestamp);
    
    // Trim old data
    this.trimMetricsHistory();
    
    // Emit current metrics
    this.emit('metrics:collected', this.getCurrentMetrics());
  }

  /**
   * Collect system metrics
   */
  async collectSystemMetrics(timestamp) {
    // CPU usage
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    const cpuUsage = 100 - ~~(100 * totalIdle / totalTick);
    
    this.metrics.system.cpu.push({
      timestamp,
      usage: cpuUsage,
      cores: cpus.length,
      loadAverage: os.loadavg()
    });
    
    // Memory usage
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = (usedMem / totalMem) * 100;
    
    const processMemory = process.memoryUsage();
    
    this.metrics.system.memory.push({
      timestamp,
      total: totalMem,
      used: usedMem,
      free: freeMem,
      percentage: memUsage,
      process: {
        heapUsed: processMemory.heapUsed,
        heapTotal: processMemory.heapTotal,
        rss: processMemory.rss,
        external: processMemory.external
      }
    });
    
    // Network metrics (simplified)
    const networkInterfaces = os.networkInterfaces();
    let activeInterfaces = 0;
    
    for (const iface of Object.values(networkInterfaces)) {
      if (iface.some(config => !config.internal)) {
        activeInterfaces++;
      }
    }
    
    this.metrics.system.network.push({
      timestamp,
      interfaces: activeInterfaces,
      connections: global.stratum?.getConnectionCount() || 0,
      peers: global.p2p?.getPeerCount() || 0
    });
  }

  /**
   * Collect mining metrics
   */
  collectMiningMetrics(timestamp) {
    const mining = global.mining;
    const stratum = global.stratum;
    
    if (!mining && !stratum) return;
    
    // Hashrate
    const hashrate = stratum?.getTotalHashrate() || 0;
    const localHashrate = mining?.getStats().hashrate || 0;
    
    this.metrics.mining.hashrate.push({
      timestamp,
      total: hashrate,
      local: localHashrate,
      miners: stratum?.getConnectionCount() || 0
    });
    
    // Shares
    const poolStats = global.db?.getPoolStats() || { valid: 0, invalid: 0, total: 0 };
    const efficiency = poolStats.total > 0 ? (poolStats.valid / poolStats.total) * 100 : 100;
    
    this.metrics.mining.shares.push({
      timestamp,
      valid: poolStats.valid,
      invalid: poolStats.invalid,
      total: poolStats.total
    });
    
    this.metrics.mining.efficiency.push({
      timestamp,
      percentage: efficiency,
      rejectionRate: poolStats.total > 0 ? (poolStats.invalid / poolStats.total) * 100 : 0
    });
  }

  /**
   * Collect pool metrics
   */
  collectPoolMetrics(timestamp) {
    const stratum = global.stratum;
    if (!stratum) return;
    
    // Connections
    const connections = stratum.getConnectionCount();
    const connectionStats = stratum.getConnectionStats?.() || {};
    
    this.metrics.pool.connections.push({
      timestamp,
      active: connections,
      total: connectionStats.total || connections,
      dropped: connectionStats.dropped || 0
    });
    
    // Latency (average response time)
    const latencyStats = stratum.getLatencyStats?.() || { avg: 0, min: 0, max: 0 };
    
    this.metrics.pool.latency.push({
      timestamp,
      average: latencyStats.avg,
      min: latencyStats.min,
      max: latencyStats.max
    });
  }

  /**
   * Collect DEX metrics
   */
  collectDEXMetrics(timestamp) {
    const dex = global.dex;
    if (!dex) return;
    
    const stats = dex.getStats();
    
    // Transaction volume
    const volume24h = BigInt(stats.v2?.volume24h || 0) + BigInt(stats.v3?.volume24h || 0);
    
    this.metrics.dex.volume.push({
      timestamp,
      volume24h: volume24h.toString(),
      v2Volume: (stats.v2?.volume24h || 0).toString(),
      v3Volume: (stats.v3?.volume24h || 0).toString()
    });
    
    // Liquidity
    const totalTVL = (stats.v2?.tvl || 0) + (stats.v3?.tvl || 0);
    
    this.metrics.dex.liquidity.push({
      timestamp,
      tvl: totalTVL,
      v2Pools: stats.v2?.pools || 0,
      v3Pools: stats.v3?.pools || 0
    });
    
    // Transaction count
    this.metrics.dex.transactions.push({
      timestamp,
      count: stats.tradingHistory || 0,
      swaps: stats.unified?.swaps || 0
    });
  }

  /**
   * Collect payment metrics
   */
  collectPaymentMetrics(timestamp) {
    const paymentManager = global.paymentManager;
    const feeManager = global.feeManager;
    
    if (!paymentManager || !feeManager) return;
    
    const paymentStats = paymentManager.getPaymentStats();
    const feeStats = feeManager.getStats();
    
    // Payments
    this.metrics.payments.processed.push({
      timestamp,
      count: paymentStats.totalPayments?.RVN?.count || 0,
      total: paymentStats.totalPayments?.RVN?.total || 0
    });
    
    this.metrics.payments.pending.push({
      timestamp,
      queueLength: paymentStats.queueLength,
      pendingValue: Object.values(paymentStats.pendingBalances || {}).reduce((a, b) => a + b, 0)
    });
    
    // Fees
    this.metrics.payments.fees.push({
      timestamp,
      collected: feeStats.totalCollectedBTC || 0,
      pending: Object.values(feeStats.pendingFees || {}).reduce((a, b) => a + b, 0)
    });
  }

  /**
   * Process analytics
   */
  processAnalytics() {
    const analytics = {
      timestamp: Date.now(),
      system: this.analyzeSystemPerformance(),
      mining: this.analyzeMiningPerformance(),
      pool: this.analyzePoolPerformance(),
      dex: this.analyzeDEXPerformance(),
      payments: this.analyzePaymentPerformance(),
      predictions: this.generatePredictions()
    };
    
    this.emit('analytics:processed', analytics);
  }

  /**
   * Analyze system performance
   */
  analyzeSystemPerformance() {
    const cpuData = this.getRecentMetrics('system.cpu', 300000); // Last 5 minutes
    const memoryData = this.getRecentMetrics('system.memory', 300000);
    
    return {
      cpu: {
        average: this.calculateAverage(cpuData.map(d => d.usage)),
        trend: this.calculateTrend(cpuData.map(d => d.usage)),
        peak: Math.max(...cpuData.map(d => d.usage))
      },
      memory: {
        average: this.calculateAverage(memoryData.map(d => d.percentage)),
        trend: this.calculateTrend(memoryData.map(d => d.percentage)),
        peak: Math.max(...memoryData.map(d => d.percentage))
      }
    };
  }

  /**
   * Analyze mining performance
   */
  analyzeMiningPerformance() {
    const hashrateData = this.getRecentMetrics('mining.hashrate', 600000); // Last 10 minutes
    const efficiencyData = this.getRecentMetrics('mining.efficiency', 600000);
    
    return {
      hashrate: {
        average: this.calculateAverage(hashrateData.map(d => d.total)),
        trend: this.calculateTrend(hashrateData.map(d => d.total)),
        stability: this.calculateStability(hashrateData.map(d => d.total))
      },
      efficiency: {
        average: this.calculateAverage(efficiencyData.map(d => d.percentage)),
        trend: this.calculateTrend(efficiencyData.map(d => d.percentage))
      }
    };
  }

  /**
   * Analyze pool performance
   */
  analyzePoolPerformance() {
    const connectionData = this.getRecentMetrics('pool.connections', 300000);
    const latencyData = this.getRecentMetrics('pool.latency', 300000);
    
    return {
      connections: {
        average: this.calculateAverage(connectionData.map(d => d.active)),
        stability: this.calculateStability(connectionData.map(d => d.active))
      },
      latency: {
        average: this.calculateAverage(latencyData.map(d => d.average)),
        p95: this.calculatePercentile(latencyData.map(d => d.average), 95)
      }
    };
  }

  /**
   * Analyze DEX performance
   */
  analyzeDEXPerformance() {
    const volumeData = this.getRecentMetrics('dex.volume', 3600000); // Last hour
    const liquidityData = this.getRecentMetrics('dex.liquidity', 3600000);
    
    return {
      volume: {
        total: volumeData.length > 0 ? volumeData[volumeData.length - 1].volume24h : '0',
        trend: this.calculateTrend(volumeData.map(d => parseInt(d.volume24h)))
      },
      liquidity: {
        tvl: liquidityData.length > 0 ? liquidityData[liquidityData.length - 1].tvl : 0,
        trend: this.calculateTrend(liquidityData.map(d => d.tvl))
      }
    };
  }

  /**
   * Analyze payment performance
   */
  analyzePaymentPerformance() {
    const processedData = this.getRecentMetrics('payments.processed', 3600000);
    const pendingData = this.getRecentMetrics('payments.pending', 3600000);
    
    return {
      throughput: this.calculateAverage(processedData.map(d => d.count)),
      queueHealth: pendingData.length > 0 ? pendingData[pendingData.length - 1].queueLength : 0,
      successRate: this.calculatePaymentSuccessRate()
    };
  }

  /**
   * Generate predictions
   */
  generatePredictions() {
    const predictions = {
      hashrate: this.predictHashrate(),
      poolGrowth: this.predictPoolGrowth(),
      resourceUsage: this.predictResourceUsage()
    };
    
    return predictions;
  }

  /**
   * Predict hashrate trend
   */
  predictHashrate() {
    const hashrateData = this.getRecentMetrics('mining.hashrate', 3600000);
    if (hashrateData.length < 10) return null;
    
    const values = hashrateData.map(d => d.total);
    const trend = this.calculateTrend(values);
    const average = this.calculateAverage(values);
    
    // Simple linear prediction
    const prediction = average + (trend * 6); // 1 hour ahead
    
    return {
      current: values[values.length - 1],
      predicted: Math.max(0, prediction),
      trend: trend > 0 ? 'increasing' : trend < 0 ? 'decreasing' : 'stable'
    };
  }

  /**
   * Predict pool growth
   */
  predictPoolGrowth() {
    const connectionData = this.getRecentMetrics('pool.connections', 3600000);
    if (connectionData.length < 10) return null;
    
    const values = connectionData.map(d => d.active);
    const trend = this.calculateTrend(values);
    
    return {
      currentMiners: values[values.length - 1],
      predictedGrowth: trend * 6, // 1 hour
      capacityUsage: (values[values.length - 1] / (global.stratum?.maxConnections || 10000)) * 100
    };
  }

  /**
   * Predict resource usage
   */
  predictResourceUsage() {
    const cpuData = this.getRecentMetrics('system.cpu', 3600000);
    const memoryData = this.getRecentMetrics('system.memory', 3600000);
    
    return {
      cpu: {
        current: cpuData.length > 0 ? cpuData[cpuData.length - 1].usage : 0,
        predicted: this.calculateAverage(cpuData.map(d => d.usage)) + this.calculateTrend(cpuData.map(d => d.usage)) * 6
      },
      memory: {
        current: memoryData.length > 0 ? memoryData[memoryData.length - 1].percentage : 0,
        predicted: this.calculateAverage(memoryData.map(d => d.percentage)) + this.calculateTrend(memoryData.map(d => d.percentage)) * 6
      }
    };
  }

  /**
   * Check for alerts
   */
  checkAlerts() {
    // CPU alert
    this.checkThresholdAlert('cpu', 'system.cpu', 'usage', this.alertConfig.cpu);
    
    // Memory alert
    this.checkThresholdAlert('memory', 'system.memory', 'percentage', this.alertConfig.memory);
    
    // Hashrate drop alert
    this.checkHashrateAlert();
    
    // Rejection rate alert
    this.checkRejectionRateAlert();
    
    // Latency alert
    this.checkThresholdAlert('latency', 'pool.latency', 'average', this.alertConfig.latency);
    
    // Failed payments alert
    this.checkFailedPaymentsAlert();
  }

  /**
   * Check threshold-based alert
   */
  checkThresholdAlert(alertName, metricPath, field, config) {
    const data = this.getRecentMetrics(metricPath, config.window);
    if (data.length === 0) return;
    
    const values = data.map(d => d[field]);
    const average = this.calculateAverage(values);
    
    if (average > config.threshold) {
      this.triggerAlert(alertName, {
        current: average,
        threshold: config.threshold,
        severity: average > config.threshold * 1.2 ? 'critical' : 'warning'
      });
    } else {
      this.clearAlert(alertName);
    }
  }

  /**
   * Check hashrate alert
   */
  checkHashrateAlert() {
    const data = this.getRecentMetrics('mining.hashrate', this.alertConfig.hashrate.window);
    if (data.length < 2) return;
    
    const current = data[data.length - 1].total;
    const baseline = this.calculateAverage(data.slice(0, -1).map(d => d.total));
    
    if (baseline > 0 && current < baseline * this.alertConfig.hashrate.threshold) {
      this.triggerAlert('hashrate_drop', {
        current,
        baseline,
        drop: ((baseline - current) / baseline) * 100,
        severity: 'warning'
      });
    } else {
      this.clearAlert('hashrate_drop');
    }
  }

  /**
   * Check rejection rate alert
   */
  checkRejectionRateAlert() {
    const data = this.getRecentMetrics('mining.efficiency', this.alertConfig.rejectionRate.window);
    if (data.length === 0) return;
    
    const avgRejectionRate = this.calculateAverage(data.map(d => d.rejectionRate));
    
    if (avgRejectionRate > this.alertConfig.rejectionRate.threshold * 100) {
      this.triggerAlert('high_rejection', {
        rate: avgRejectionRate,
        threshold: this.alertConfig.rejectionRate.threshold * 100,
        severity: avgRejectionRate > 10 ? 'critical' : 'warning'
      });
    } else {
      this.clearAlert('high_rejection');
    }
  }

  /**
   * Check failed payments alert
   */
  checkFailedPaymentsAlert() {
    const data = this.getRecentMetrics('payments.failed', this.alertConfig.failedPayments.window);
    const failedCount = data.reduce((sum, d) => sum + (d.count || 0), 0);
    
    if (failedCount > this.alertConfig.failedPayments.threshold) {
      this.triggerAlert('payment_failures', {
        count: failedCount,
        threshold: this.alertConfig.failedPayments.threshold,
        severity: 'critical'
      });
    } else {
      this.clearAlert('payment_failures');
    }
  }

  /**
   * Trigger alert
   */
  triggerAlert(name, data) {
    const existingAlert = this.activeAlerts.get(name);
    
    if (!existingAlert) {
      const alert = {
        name,
        data,
        triggeredAt: Date.now(),
        acknowledged: false
      };
      
      this.activeAlerts.set(name, alert);
      this.logger.warn(`Alert triggered: ${name}`, data);
      this.emit('alert:triggered', alert);
    }
  }

  /**
   * Clear alert
   */
  clearAlert(name) {
    if (this.activeAlerts.has(name)) {
      const alert = this.activeAlerts.get(name);
      this.activeAlerts.delete(name);
      this.logger.info(`Alert cleared: ${name}`);
      this.emit('alert:cleared', { name, duration: Date.now() - alert.triggeredAt });
    }
  }

  /**
   * Helper functions
   */
  getRecentMetrics(path, timeWindow) {
    const parts = path.split('.');
    let data = this.metrics;
    
    for (const part of parts) {
      data = data[part];
      if (!data) return [];
    }
    
    const cutoff = Date.now() - timeWindow;
    return data.filter(d => d.timestamp > cutoff);
  }

  calculateAverage(values) {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  calculateTrend(values) {
    if (values.length < 2) return 0;
    
    // Simple linear regression
    const n = values.length;
    const sumX = values.reduce((sum, _, i) => sum + i, 0);
    const sumY = values.reduce((sum, val) => sum + val, 0);
    const sumXY = values.reduce((sum, val, i) => sum + i * val, 0);
    const sumX2 = values.reduce((sum, _, i) => sum + i * i, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }

  calculateStability(values) {
    if (values.length < 2) return 100;
    
    const avg = this.calculateAverage(values);
    if (avg === 0) return 100;
    
    const variance = values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const cv = (stdDev / avg) * 100;
    
    return Math.max(0, 100 - cv);
  }

  calculatePercentile(values, percentile) {
    if (values.length === 0) return 0;
    
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index];
  }

  calculatePaymentSuccessRate() {
    const processed = this.getRecentMetrics('payments.processed', 3600000);
    const failed = this.getRecentMetrics('payments.failed', 3600000);
    
    const totalProcessed = processed.reduce((sum, d) => sum + (d.count || 0), 0);
    const totalFailed = failed.reduce((sum, d) => sum + (d.count || 0), 0);
    const total = totalProcessed + totalFailed;
    
    return total > 0 ? (totalProcessed / total) * 100 : 100;
  }

  trimMetricsHistory() {
    const maxSize = this.analyticsConfig.historySize;
    
    // Trim all metric arrays
    const trimArray = (arr) => {
      if (arr.length > maxSize) {
        arr.splice(0, arr.length - maxSize);
      }
    };
    
    // Recursively trim all arrays in metrics
    const trimMetrics = (obj) => {
      for (const key in obj) {
        if (Array.isArray(obj[key])) {
          trimArray(obj[key]);
        } else if (typeof obj[key] === 'object') {
          trimMetrics(obj[key]);
        }
      }
    };
    
    trimMetrics(this.metrics);
  }

  getCurrentMetrics() {
    const getLatest = (path) => {
      const data = this.getRecentMetrics(path, 60000);
      return data.length > 0 ? data[data.length - 1] : null;
    };
    
    return {
      timestamp: Date.now(),
      system: {
        cpu: getLatest('system.cpu'),
        memory: getLatest('system.memory'),
        network: getLatest('system.network')
      },
      mining: {
        hashrate: getLatest('mining.hashrate'),
        efficiency: getLatest('mining.efficiency')
      },
      pool: {
        connections: getLatest('pool.connections'),
        latency: getLatest('pool.latency')
      },
      dex: {
        volume: getLatest('dex.volume'),
        liquidity: getLatest('dex.liquidity')
      },
      payments: {
        processed: getLatest('payments.processed'),
        pending: getLatest('payments.pending')
      },
      alerts: Array.from(this.activeAlerts.values())
    };
  }

  /**
   * Export metrics for external monitoring
   */
  exportMetrics(format = 'prometheus') {
    if (format === 'prometheus') {
      return this.exportPrometheusMetrics();
    } else if (format === 'json') {
      return this.getCurrentMetrics();
    }
    
    throw new Error(`Unsupported export format: ${format}`);
  }

  exportPrometheusMetrics() {
    const metrics = [];
    const current = this.getCurrentMetrics();
    
    // System metrics
    if (current.system.cpu) {
      metrics.push(`otedama_cpu_usage ${current.system.cpu.usage}`);
      metrics.push(`otedama_cpu_cores ${current.system.cpu.cores}`);
    }
    
    if (current.system.memory) {
      metrics.push(`otedama_memory_usage_percent ${current.system.memory.percentage}`);
      metrics.push(`otedama_memory_used_bytes ${current.system.memory.used}`);
      metrics.push(`otedama_process_heap_used_bytes ${current.system.memory.process.heapUsed}`);
    }
    
    // Mining metrics
    if (current.mining.hashrate) {
      metrics.push(`otedama_hashrate_total ${current.mining.hashrate.total}`);
      metrics.push(`otedama_miners_connected ${current.mining.hashrate.miners}`);
    }
    
    if (current.mining.efficiency) {
      metrics.push(`otedama_mining_efficiency_percent ${current.mining.efficiency.percentage}`);
      metrics.push(`otedama_share_rejection_rate ${current.mining.efficiency.rejectionRate}`);
    }
    
    // Pool metrics
    if (current.pool.connections) {
      metrics.push(`otedama_pool_connections ${current.pool.connections.active}`);
    }
    
    if (current.pool.latency) {
      metrics.push(`otedama_pool_latency_ms ${current.pool.latency.average}`);
    }
    
    // DEX metrics
    if (current.dex.liquidity) {
      metrics.push(`otedama_dex_tvl ${current.dex.liquidity.tvl}`);
      metrics.push(`otedama_dex_v2_pools ${current.dex.liquidity.v2Pools}`);
      metrics.push(`otedama_dex_v3_pools ${current.dex.liquidity.v3Pools}`);
    }
    
    // Payment metrics
    if (current.payments.pending) {
      metrics.push(`otedama_payment_queue_length ${current.payments.pending.queueLength}`);
    }
    
    // Alert metrics
    metrics.push(`otedama_active_alerts ${current.alerts.length}`);
    
    return metrics.join('\n');
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.analyticsTimer) clearInterval(this.analyticsTimer);
    if (this.alertTimer) clearInterval(this.alertTimer);
    
    this.logger.info('Monitoring system stopped');
  }
}
