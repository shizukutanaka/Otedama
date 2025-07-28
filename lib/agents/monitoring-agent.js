import os from 'os';
import { BaseAgent } from './base-agent.js';
import { createStructuredLogger } from '../core/structured-logger.js';
// import { performanceMonitor } from '../monitoring/realtime-performance-monitor.js';

const logger = createStructuredLogger('MonitoringAgent');

export class MonitoringAgent extends BaseAgent {
  constructor(config = {}) {
    super({
      ...config,
      name: config.name || 'MonitoringAgent',
      type: 'monitoring',
      interval: config.interval || 30000 // 30 seconds
    });
    
    this.thresholds = {
      cpu: config.cpuThreshold || 80,
      memory: config.memoryThreshold || 85,
      disk: config.diskThreshold || 90,
      responseTime: config.responseTimeThreshold || 1000,
      errorRate: config.errorRateThreshold || 5
    };
    
    this.metrics = {
      system: {},
      application: {},
      mining: {},
      network: {}
    };
    
    this.history = [];
    this.historyLimit = config.historyLimit || 100;
  }

  async onInitialize() {
    logger.info('Initializing Monitoring Agent');
    // Initialize performance monitoring connections
    this.setContext('startTime', Date.now());
  }

  async run() {
    const metrics = await this.collectMetrics();
    const analysis = this.analyzeMetrics(metrics);
    
    // Store in history
    this.updateHistory(metrics);
    
    // Check for anomalies
    const anomalies = this.detectAnomalies(metrics);
    if (anomalies.length > 0) {
      this.handleAnomalies(anomalies);
    }

    // Generate alerts if needed
    const alerts = this.generateAlerts(metrics, analysis);
    for (const alert of alerts) {
      this.emit('alert', alert);
    }

    return {
      metrics,
      analysis,
      anomalies,
      alerts
    };
  }

  async collectMetrics() {
    const metrics = {
      timestamp: Date.now(),
      system: await this.collectSystemMetrics(),
      application: await this.collectApplicationMetrics(),
      mining: await this.collectMiningMetrics(),
      network: await this.collectNetworkMetrics()
    };

    this.metrics = metrics;
    return metrics;
  }

  async collectSystemMetrics() {
    const cpus = os.cpus();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    
    // Calculate CPU usage
    const cpuUsage = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return acc + ((total - idle) / total) * 100;
    }, 0) / cpus.length;

    return {
      cpu: {
        usage: cpuUsage,
        cores: cpus.length,
        model: cpus[0]?.model
      },
      memory: {
        total: totalMemory,
        used: usedMemory,
        free: freeMemory,
        percentage: (usedMemory / totalMemory) * 100
      },
      uptime: os.uptime(),
      loadAverage: os.loadavg(),
      platform: os.platform(),
      hostname: os.hostname()
    };
  }

  async collectApplicationMetrics() {
    try {
      const memoryUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      return {
        memory: {
          heapTotal: memoryUsage.heapTotal,
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external,
          rss: memoryUsage.rss
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system
        },
        uptime: process.uptime(),
        pid: process.pid,
        version: process.version
      };
    } catch (error) {
      logger.error('Failed to collect application metrics:', error);
      return {};
    }
  }

  async collectMiningMetrics() {
    try {
      // This would integrate with actual mining metrics
      return {
        hashrate: this.getContext('hashrate') || 0,
        difficulty: this.getContext('difficulty') || 0,
        blockHeight: this.getContext('blockHeight') || 0,
        connectedMiners: this.getContext('connectedMiners') || 0,
        sharesSubmitted: this.getContext('sharesSubmitted') || 0,
        sharesAccepted: this.getContext('sharesAccepted') || 0,
        poolEfficiency: this.getContext('poolEfficiency') || 0
      };
    } catch (error) {
      logger.error('Failed to collect mining metrics:', error);
      return {};
    }
  }

  async collectNetworkMetrics() {
    try {
      return {
        connections: this.getContext('activeConnections') || 0,
        bandwidth: {
          in: this.getContext('bandwidthIn') || 0,
          out: this.getContext('bandwidthOut') || 0
        },
        latency: this.getContext('networkLatency') || 0,
        packetLoss: this.getContext('packetLoss') || 0
      };
    } catch (error) {
      logger.error('Failed to collect network metrics:', error);
      return {};
    }
  }

  analyzeMetrics(metrics) {
    const analysis = {
      health: 'good',
      score: 100,
      issues: [],
      recommendations: []
    };

    // Analyze CPU
    if (metrics.system.cpu.usage > this.thresholds.cpu) {
      analysis.issues.push({
        type: 'cpu',
        severity: 'high',
        message: `CPU usage is ${metrics.system.cpu.usage.toFixed(1)}%`
      });
      analysis.score -= 20;
    }

    // Analyze Memory
    if (metrics.system.memory.percentage > this.thresholds.memory) {
      analysis.issues.push({
        type: 'memory',
        severity: 'high',
        message: `Memory usage is ${metrics.system.memory.percentage.toFixed(1)}%`
      });
      analysis.score -= 20;
    }

    // Analyze Mining Performance
    if (metrics.mining.poolEfficiency < 95) {
      analysis.issues.push({
        type: 'mining',
        severity: 'medium',
        message: `Pool efficiency is ${metrics.mining.poolEfficiency}%`
      });
      analysis.score -= 10;
    }

    // Determine overall health
    if (analysis.score >= 80) {
      analysis.health = 'good';
    } else if (analysis.score >= 60) {
      analysis.health = 'fair';
    } else {
      analysis.health = 'poor';
    }

    // Generate recommendations
    if (analysis.issues.length > 0) {
      analysis.recommendations = this.generateRecommendations(analysis.issues);
    }

    return analysis;
  }

  detectAnomalies(metrics) {
    const anomalies = [];

    // Compare with historical data
    if (this.history.length > 10) {
      const recentHistory = this.history.slice(-10);
      const avgCpu = recentHistory.reduce((acc, h) => acc + h.system.cpu.usage, 0) / recentHistory.length;
      const avgMemory = recentHistory.reduce((acc, h) => acc + h.system.memory.percentage, 0) / recentHistory.length;

      // Detect sudden spikes
      if (metrics.system.cpu.usage > avgCpu * 1.5) {
        anomalies.push({
          type: 'cpu_spike',
          severity: 'medium',
          current: metrics.system.cpu.usage,
          average: avgCpu
        });
      }

      if (metrics.system.memory.percentage > avgMemory * 1.3) {
        anomalies.push({
          type: 'memory_spike',
          severity: 'medium',
          current: metrics.system.memory.percentage,
          average: avgMemory
        });
      }
    }

    return anomalies;
  }

  handleAnomalies(anomalies) {
    for (const anomaly of anomalies) {
      logger.warn(`Anomaly detected: ${anomaly.type}`, anomaly);
      
      // Emit anomaly event for other agents to respond
      this.emit('anomaly', anomaly);
    }
  }

  generateAlerts(metrics, analysis) {
    const alerts = [];

    for (const issue of analysis.issues) {
      if (issue.severity === 'high') {
        alerts.push({
          level: 'critical',
          type: issue.type,
          message: issue.message,
          timestamp: Date.now(),
          metrics: metrics[issue.type] || {}
        });
      }
    }

    return alerts;
  }

  generateRecommendations(issues) {
    const recommendations = [];

    for (const issue of issues) {
      switch (issue.type) {
        case 'cpu':
          recommendations.push('Consider scaling up compute resources or optimizing CPU-intensive operations');
          break;
        case 'memory':
          recommendations.push('Memory usage is high. Consider increasing memory allocation or optimizing memory usage');
          break;
        case 'mining':
          recommendations.push('Mining efficiency is below optimal. Check network connectivity and miner configurations');
          break;
      }
    }

    return recommendations;
  }

  updateHistory(metrics) {
    this.history.push(metrics);
    
    // Keep history within limit
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }
  }

  async receiveMessage(payload) {
    await super.receiveMessage(payload);
    
    if (payload.action === 'increasedMonitoring') {
      // Temporarily increase monitoring frequency
      const originalInterval = this.interval;
      this.interval = 10000; // 10 seconds
      
      setTimeout(() => {
        this.interval = originalInterval;
      }, 300000); // Reset after 5 minutes
      
      // Restart with new interval
      this.stop();
      this.start();
      
      return { status: 'monitoring_increased', duration: 300000 };
    }
    
    if (payload.action === 'detailedMetrics') {
      // Collect more detailed metrics
      const detailedMetrics = await this.collectDetailedMetrics();
      return { status: 'detailed_metrics', data: detailedMetrics };
    }
    
    return { status: 'received' };
  }

  async collectDetailedMetrics() {
    // Collect more granular metrics for troubleshooting
    const processInfo = {
      handles: process._getActiveHandles?.().length || 0,
      requests: process._getActiveRequests?.().length || 0,
      environment: process.env.NODE_ENV
    };

    return {
      ...await this.collectMetrics(),
      process: processInfo,
      timestamp: Date.now()
    };
  }

  getMetricsSummary() {
    return {
      current: this.metrics,
      history: this.history.slice(-10),
      thresholds: this.thresholds
    };
  }
}