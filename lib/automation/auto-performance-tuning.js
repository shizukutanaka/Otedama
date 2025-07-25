/**
 * Auto Performance Tuning System - Otedama
 * AI-driven performance optimization
 * 
 * Features:
 * - Real-time performance monitoring
 * - Automatic parameter tuning
 * - Resource allocation optimization
 * - Bottleneck detection
 * - Predictive scaling
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import os from 'os';

const logger = createLogger('AutoTuning');

export class AutoPerformanceTuning extends EventEmitter {
  constructor(poolManager, config = {}) {
    super();
    
    this.poolManager = poolManager;
    this.config = {
      enabled: config.enabled !== false,
      monitoringInterval: config.monitoringInterval || 30000, // 30 seconds
      tuningInterval: config.tuningInterval || 300000, // 5 minutes
      metricsWindow: config.metricsWindow || 3600000, // 1 hour
      aggressiveness: config.aggressiveness || 0.5, // 0-1 scale
      targets: {
        cpuUsage: config.targets?.cpuUsage || 0.7,
        memoryUsage: config.targets?.memoryUsage || 0.8,
        shareAcceptRate: config.targets?.shareAcceptRate || 0.99,
        latency: config.targets?.latency || 100, // ms
        efficiency: config.targets?.efficiency || 0.95
      }
    };
    
    this.metrics = {
      cpu: [],
      memory: [],
      network: [],
      shares: [],
      database: [],
      custom: new Map()
    };
    
    this.tuningHistory = [];
    this.currentTunings = new Map();
    this.monitoringTimer = null;
    this.tuningTimer = null;
  }
  
  /**
   * Start auto tuning
   */
  start() {
    if (!this.config.enabled) {
      logger.info('Auto performance tuning is disabled');
      return;
    }
    
    logger.info('Starting auto performance tuning...');
    
    // Start monitoring
    this.monitoringTimer = setInterval(() => {
      this.collectMetrics();
    }, this.config.monitoringInterval);
    
    // Start tuning
    this.tuningTimer = setInterval(() => {
      this.performTuning();
    }, this.config.tuningInterval);
    
    // Initial collection
    this.collectMetrics();
    
    logger.info('Auto performance tuning started');
  }
  
  /**
   * Collect performance metrics
   */
  async collectMetrics() {
    const timestamp = Date.now();
    
    try {
      // CPU metrics
      const cpuUsage = await this.getCPUMetrics();
      this.recordMetric('cpu', {
        timestamp,
        usage: cpuUsage.usage,
        loadAvg: os.loadavg()[0],
        cores: os.cpus().length
      });
      
      // Memory metrics
      const memoryMetrics = this.getMemoryMetrics();
      this.recordMetric('memory', {
        timestamp,
        used: memoryMetrics.used,
        total: memoryMetrics.total,
        percentage: memoryMetrics.percentage,
        heap: process.memoryUsage().heapUsed
      });
      
      // Pool metrics
      const poolStats = this.poolManager.getStats();
      this.recordMetric('shares', {
        timestamp,
        rate: this.calculateShareRate(),
        accepted: poolStats.validShares || 0,
        rejected: poolStats.invalidShares || 0,
        efficiency: this.calculateEfficiency(poolStats)
      });
      
      // Network metrics
      this.recordMetric('network', {
        timestamp,
        connections: poolStats.totalMiners,
        bandwidth: this.estimateBandwidth(poolStats),
        latency: await this.measureLatency()
      });
      
      // Database metrics
      if (this.poolManager.storage) {
        const dbStats = await this.getDatabaseMetrics();
        this.recordMetric('database', dbStats);
      }
      
      this.emit('metrics:collected', this.getLatestMetrics());
      
    } catch (error) {
      logger.error('Failed to collect metrics:', error);
    }
  }
  
  /**
   * Record metric
   */
  recordMetric(type, data) {
    this.metrics[type].push(data);
    
    // Cleanup old metrics
    const cutoff = Date.now() - this.config.metricsWindow;
    this.metrics[type] = this.metrics[type].filter(m => m.timestamp > cutoff);
  }
  
  /**
   * Perform automatic tuning
   */
  async performTuning() {
    logger.debug('Performing auto tuning analysis...');
    
    const analysis = this.analyzePerformance();
    const recommendations = this.generateRecommendations(analysis);
    
    if (recommendations.length === 0) {
      logger.debug('No tuning recommendations');
      return;
    }
    
    logger.info(`Generated ${recommendations.length} tuning recommendations`);
    
    // Apply recommendations based on aggressiveness
    for (const recommendation of recommendations) {
      if (recommendation.confidence >= (1 - this.config.aggressiveness)) {
        await this.applyTuning(recommendation);
      }
    }
  }
  
  /**
   * Analyze performance
   */
  analyzePerformance() {
    const analysis = {
      cpu: this.analyzeCPU(),
      memory: this.analyzeMemory(),
      network: this.analyzeNetwork(),
      shares: this.analyzeShares(),
      database: this.analyzeDatabase(),
      bottlenecks: []
    };
    
    // Identify bottlenecks
    if (analysis.cpu.average > this.config.targets.cpuUsage) {
      analysis.bottlenecks.push({
        type: 'cpu',
        severity: 'high',
        value: analysis.cpu.average
      });
    }
    
    if (analysis.memory.percentage > this.config.targets.memoryUsage) {
      analysis.bottlenecks.push({
        type: 'memory',
        severity: 'high',
        value: analysis.memory.percentage
      });
    }
    
    if (analysis.shares.efficiency < this.config.targets.efficiency) {
      analysis.bottlenecks.push({
        type: 'efficiency',
        severity: 'medium',
        value: analysis.shares.efficiency
      });
    }
    
    return analysis;
  }
  
  /**
   * Generate tuning recommendations
   */
  generateRecommendations(analysis) {
    const recommendations = [];
    
    // CPU optimizations
    if (analysis.cpu.average > this.config.targets.cpuUsage) {
      if (analysis.cpu.trend === 'increasing') {
        recommendations.push({
          type: 'scale',
          action: 'increase_workers',
          value: Math.ceil(analysis.cpu.average / this.config.targets.cpuUsage),
          confidence: 0.8,
          reason: 'CPU usage trending high'
        });
      }
      
      recommendations.push({
        type: 'tune',
        parameter: 'shareValidationWorkers',
        action: 'increase',
        value: Math.min(16, this.poolManager.config.shareValidationWorkers + 2),
        confidence: 0.7,
        reason: 'High CPU usage on share validation'
      });
    }
    
    // Memory optimizations
    if (analysis.memory.percentage > this.config.targets.memoryUsage) {
      recommendations.push({
        type: 'tune',
        parameter: 'cacheSize',
        action: 'decrease',
        value: Math.floor(this.poolManager.storage?.cacheSize * 0.8) || 50 * 1024 * 1024,
        confidence: 0.7,
        reason: 'Memory pressure detected'
      });
      
      if (analysis.memory.heap > 1024 * 1024 * 1024) { // 1GB
        recommendations.push({
          type: 'maintenance',
          action: 'garbage_collect',
          confidence: 0.9,
          reason: 'High heap usage'
        });
      }
    }
    
    // Network optimizations
    if (analysis.network.connectionsPerWorker > 1000) {
      recommendations.push({
        type: 'scale',
        action: 'increase_workers',
        value: Math.ceil(analysis.network.totalConnections / 1000),
        confidence: 0.8,
        reason: 'High connection count per worker'
      });
    }
    
    // Share processing optimizations
    if (analysis.shares.efficiency < this.config.targets.shareAcceptRate) {
      recommendations.push({
        type: 'tune',
        parameter: 'difficulty',
        action: 'adjust',
        value: this.calculateOptimalDifficulty(analysis.shares),
        confidence: 0.6,
        reason: 'Share efficiency below target'
      });
    }
    
    // Database optimizations
    if (analysis.database.queryTime > 100) {
      recommendations.push({
        type: 'maintenance',
        action: 'optimize_database',
        confidence: 0.8,
        reason: 'Slow database queries'
      });
    }
    
    return recommendations;
  }
  
  /**
   * Apply tuning recommendation
   */
  async applyTuning(recommendation) {
    logger.info(`Applying tuning: ${recommendation.type} - ${recommendation.action}`);
    
    const tuning = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      recommendation,
      previousValue: null,
      newValue: recommendation.value,
      status: 'pending'
    };
    
    try {
      switch (recommendation.type) {
        case 'scale':
          await this.applyScaling(recommendation, tuning);
          break;
          
        case 'tune':
          await this.applyParameterTuning(recommendation, tuning);
          break;
          
        case 'maintenance':
          await this.applyMaintenance(recommendation, tuning);
          break;
      }
      
      tuning.status = 'success';
      this.tuningHistory.push(tuning);
      this.currentTunings.set(tuning.id, tuning);
      
      logger.info(`Tuning applied successfully: ${recommendation.action}`);
      this.emit('tuning:applied', tuning);
      
      // Monitor effect
      setTimeout(() => {
        this.evaluateTuning(tuning);
      }, 60000); // Check after 1 minute
      
    } catch (error) {
      tuning.status = 'failed';
      tuning.error = error.message;
      logger.error(`Failed to apply tuning:`, error);
      this.emit('tuning:failed', tuning);
    }
  }
  
  /**
   * Apply scaling changes
   */
  async applyScaling(recommendation, tuning) {
    if (recommendation.action === 'increase_workers') {
      if (this.poolManager.autoScaling) {
        const currentWorkers = this.poolManager.workers.size;
        const targetWorkers = Math.min(recommendation.value, this.poolManager.config.workerProcesses);
        
        if (targetWorkers > currentWorkers) {
          for (let i = currentWorkers; i < targetWorkers; i++) {
            this.poolManager.forkWorker();
          }
          
          tuning.previousValue = currentWorkers;
          tuning.newValue = targetWorkers;
        }
      }
    }
  }
  
  /**
   * Apply parameter tuning
   */
  async applyParameterTuning(recommendation, tuning) {
    const param = recommendation.parameter;
    const currentValue = this.getNestedProperty(this.poolManager.config, param);
    
    tuning.previousValue = currentValue;
    
    switch (param) {
      case 'shareValidationWorkers':
        this.poolManager.config.shareValidationWorkers = recommendation.value;
        // Would need to restart validation workers
        break;
        
      case 'cacheSize':
        if (this.poolManager.storage) {
          this.poolManager.storage.cacheSize = recommendation.value;
        }
        break;
        
      case 'difficulty':
        // Adjust vardiff settings
        if (this.poolManager.pool?.vardiff) {
          this.poolManager.pool.vardiff.targetTime = recommendation.value;
        }
        break;
    }
  }
  
  /**
   * Apply maintenance actions
   */
  async applyMaintenance(recommendation, tuning) {
    switch (recommendation.action) {
      case 'garbage_collect':
        if (global.gc) {
          global.gc();
          logger.info('Forced garbage collection');
        }
        break;
        
      case 'optimize_database':
        if (this.poolManager.storage?.database) {
          await this.poolManager.storage.database.run('VACUUM');
          await this.poolManager.storage.database.run('ANALYZE');
          logger.info('Database optimized');
        }
        break;
    }
  }
  
  /**
   * Evaluate tuning effectiveness
   */
  async evaluateTuning(tuning) {
    const beforeMetrics = this.getMetricsAround(tuning.timestamp - 300000); // 5 min before
    const afterMetrics = this.getMetricsAround(Date.now());
    
    const improvement = this.calculateImprovement(beforeMetrics, afterMetrics, tuning.recommendation.type);
    
    tuning.effectiveness = improvement;
    
    if (improvement < 0) {
      // Tuning made things worse, consider reverting
      logger.warn(`Tuning ${tuning.id} had negative impact: ${improvement}%`);
      
      if (this.config.aggressiveness > 0.3) {
        await this.revertTuning(tuning);
      }
    } else {
      logger.info(`Tuning ${tuning.id} improved performance by ${improvement}%`);
    }
    
    this.emit('tuning:evaluated', { tuning, improvement });
  }
  
  /**
   * Revert tuning
   */
  async revertTuning(tuning) {
    if (tuning.previousValue === null) return;
    
    logger.info(`Reverting tuning ${tuning.id}`);
    
    try {
      const revertRecommendation = {
        ...tuning.recommendation,
        value: tuning.previousValue
      };
      
      await this.applyTuning(revertRecommendation);
      
      tuning.reverted = true;
      this.emit('tuning:reverted', tuning);
      
    } catch (error) {
      logger.error('Failed to revert tuning:', error);
    }
  }
  
  /**
   * CPU analysis
   */
  analyzeCPU() {
    const cpuMetrics = this.metrics.cpu;
    if (cpuMetrics.length === 0) return { average: 0, trend: 'stable' };
    
    const average = cpuMetrics.reduce((sum, m) => sum + m.usage, 0) / cpuMetrics.length;
    const recent = cpuMetrics.slice(-5);
    const older = cpuMetrics.slice(-10, -5);
    
    const recentAvg = recent.reduce((sum, m) => sum + m.usage, 0) / recent.length;
    const olderAvg = older.length > 0 ? 
      older.reduce((sum, m) => sum + m.usage, 0) / older.length : recentAvg;
    
    const trend = recentAvg > olderAvg * 1.1 ? 'increasing' : 
                  recentAvg < olderAvg * 0.9 ? 'decreasing' : 'stable';
    
    return { average, trend, current: cpuMetrics[cpuMetrics.length - 1]?.usage || 0 };
  }
  
  /**
   * Memory analysis
   */
  analyzeMemory() {
    const memMetrics = this.metrics.memory;
    if (memMetrics.length === 0) return { percentage: 0, trend: 'stable' };
    
    const latest = memMetrics[memMetrics.length - 1];
    const average = memMetrics.reduce((sum, m) => sum + m.percentage, 0) / memMetrics.length;
    
    return {
      percentage: latest?.percentage || 0,
      average,
      heap: latest?.heap || 0,
      trend: this.calculateTrend(memMetrics.map(m => m.percentage))
    };
  }
  
  /**
   * Network analysis
   */
  analyzeNetwork() {
    const netMetrics = this.metrics.network;
    if (netMetrics.length === 0) return { totalConnections: 0, connectionsPerWorker: 0 };
    
    const latest = netMetrics[netMetrics.length - 1];
    const workerCount = this.poolManager.workers?.size || 1;
    
    return {
      totalConnections: latest?.connections || 0,
      connectionsPerWorker: (latest?.connections || 0) / workerCount,
      bandwidth: latest?.bandwidth || 0,
      latency: latest?.latency || 0
    };
  }
  
  /**
   * Share analysis
   */
  analyzeShares() {
    const shareMetrics = this.metrics.shares;
    if (shareMetrics.length === 0) return { efficiency: 1, rate: 0 };
    
    const totalAccepted = shareMetrics.reduce((sum, m) => sum + m.accepted, 0);
    const totalRejected = shareMetrics.reduce((sum, m) => sum + m.rejected, 0);
    const efficiency = totalAccepted / (totalAccepted + totalRejected + 1);
    
    const avgRate = shareMetrics.reduce((sum, m) => sum + m.rate, 0) / shareMetrics.length;
    
    return {
      efficiency,
      rate: avgRate,
      trend: this.calculateTrend(shareMetrics.map(m => m.rate))
    };
  }
  
  /**
   * Database analysis
   */
  analyzeDatabase() {
    const dbMetrics = this.metrics.database;
    if (dbMetrics.length === 0) return { queryTime: 0 };
    
    const avgQueryTime = dbMetrics.reduce((sum, m) => sum + (m.queryTime || 0), 0) / dbMetrics.length;
    
    return {
      queryTime: avgQueryTime,
      connections: dbMetrics[dbMetrics.length - 1]?.connections || 0
    };
  }
  
  /**
   * Get CPU metrics
   */
  async getCPUMetrics() {
    const startUsage = process.cpuUsage();
    const startTime = process.hrtime.bigint();
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const endUsage = process.cpuUsage(startUsage);
    const endTime = process.hrtime.bigint();
    
    const userTime = endUsage.user;
    const systemTime = endUsage.system;
    const totalTime = userTime + systemTime;
    const elapsedTime = Number(endTime - startTime);
    
    return {
      usage: totalTime / elapsedTime / os.cpus().length
    };
  }
  
  /**
   * Get memory metrics
   */
  getMemoryMetrics() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    
    return {
      total,
      used,
      free,
      percentage: used / total
    };
  }
  
  /**
   * Get database metrics
   */
  async getDatabaseMetrics() {
    const startTime = Date.now();
    
    try {
      // Simple query to test performance
      await this.poolManager.storage.database.get('SELECT COUNT(*) FROM miners');
      
      const queryTime = Date.now() - startTime;
      
      return {
        timestamp: Date.now(),
        queryTime,
        connections: 1 // Would need actual connection pool size
      };
    } catch (error) {
      return {
        timestamp: Date.now(),
        queryTime: 0,
        error: error.message
      };
    }
  }
  
  /**
   * Calculate share rate
   */
  calculateShareRate() {
    const recentShares = this.metrics.shares.slice(-5);
    if (recentShares.length < 2) return 0;
    
    const timeDiff = recentShares[recentShares.length - 1].timestamp - recentShares[0].timestamp;
    const shareCount = recentShares.reduce((sum, m) => sum + m.accepted + m.rejected, 0);
    
    return shareCount / (timeDiff / 1000); // Shares per second
  }
  
  /**
   * Calculate efficiency
   */
  calculateEfficiency(stats) {
    const total = (stats.validShares || 0) + (stats.invalidShares || 0);
    return total > 0 ? (stats.validShares || 0) / total : 1;
  }
  
  /**
   * Estimate bandwidth
   */
  estimateBandwidth(stats) {
    // Rough estimate: 1KB per share + 100 bytes per miner per second
    const shareRate = this.calculateShareRate();
    const minerCount = stats.totalMiners || 0;
    
    return (shareRate * 1024) + (minerCount * 100);
  }
  
  /**
   * Measure latency
   */
  async measureLatency() {
    // Simple ping to local stratum
    const start = Date.now();
    
    try {
      await fetch(`http://localhost:${this.poolManager.config.apiPort}/health`);
      return Date.now() - start;
    } catch (error) {
      return 999;
    }
  }
  
  /**
   * Calculate optimal difficulty
   */
  calculateOptimalDifficulty(shareAnalysis) {
    // Target 1 share per 30 seconds
    const targetShareRate = 1 / 30;
    const currentRate = shareAnalysis.rate;
    
    if (currentRate > 0) {
      return Math.max(1, Math.floor(currentRate / targetShareRate));
    }
    
    return 16; // Default
  }
  
  /**
   * Calculate trend
   */
  calculateTrend(values) {
    if (values.length < 3) return 'stable';
    
    const recent = values.slice(-Math.floor(values.length / 3));
    const older = values.slice(0, Math.floor(values.length / 3));
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    
    if (recentAvg > olderAvg * 1.1) return 'increasing';
    if (recentAvg < olderAvg * 0.9) return 'decreasing';
    return 'stable';
  }
  
  /**
   * Get metrics around timestamp
   */
  getMetricsAround(timestamp, window = 60000) {
    const metrics = {};
    
    for (const [type, data] of Object.entries(this.metrics)) {
      metrics[type] = data.filter(m => 
        Math.abs(m.timestamp - timestamp) < window
      );
    }
    
    return metrics;
  }
  
  /**
   * Calculate improvement
   */
  calculateImprovement(before, after, type) {
    switch (type) {
      case 'scale':
        // Check CPU usage improvement
        const cpuBefore = before.cpu.reduce((sum, m) => sum + m.usage, 0) / before.cpu.length;
        const cpuAfter = after.cpu.reduce((sum, m) => sum + m.usage, 0) / after.cpu.length;
        return ((cpuBefore - cpuAfter) / cpuBefore) * 100;
        
      case 'tune':
        // Check overall efficiency
        const effBefore = before.shares.reduce((sum, m) => sum + m.efficiency, 0) / before.shares.length;
        const effAfter = after.shares.reduce((sum, m) => sum + m.efficiency, 0) / after.shares.length;
        return ((effAfter - effBefore) / effBefore) * 100;
        
      default:
        return 0;
    }
  }
  
  /**
   * Get nested property
   */
  getNestedProperty(obj, path) {
    return path.split('.').reduce((curr, prop) => curr?.[prop], obj);
  }
  
  /**
   * Get latest metrics
   */
  getLatestMetrics() {
    const latest = {};
    
    for (const [type, data] of Object.entries(this.metrics)) {
      if (Array.isArray(data) && data.length > 0) {
        latest[type] = data[data.length - 1];
      }
    }
    
    return latest;
  }
  
  /**
   * Get tuning report
   */
  getTuningReport() {
    const successfulTunings = this.tuningHistory.filter(t => t.status === 'success' && !t.reverted);
    const revertedTunings = this.tuningHistory.filter(t => t.reverted);
    
    return {
      totalTunings: this.tuningHistory.length,
      successful: successfulTunings.length,
      reverted: revertedTunings.length,
      currentTunings: Array.from(this.currentTunings.values()),
      metrics: this.getLatestMetrics(),
      recommendations: this.generateRecommendations(this.analyzePerformance())
    };
  }
  
  /**
   * Stop auto tuning
   */
  stop() {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }
    
    if (this.tuningTimer) {
      clearInterval(this.tuningTimer);
      this.tuningTimer = null;
    }
    
    logger.info('Auto performance tuning stopped');
  }
}

export default AutoPerformanceTuning;
