/**
 * Auto-Scaling System - Otedama
 * Dynamically adjusts resources based on load and performance metrics
 */

import { EventEmitter } from 'events';
import cluster from 'cluster';
import os from 'os';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('AutoScaler');

export class AutoScaler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Scaling thresholds
      cpuThresholdHigh: options.cpuThresholdHigh || 80,
      cpuThresholdLow: options.cpuThresholdLow || 20,
      memoryThresholdHigh: options.memoryThresholdHigh || 85,
      memoryThresholdLow: options.memoryThresholdLow || 30,
      connectionThresholdHigh: options.connectionThresholdHigh || 90,
      connectionThresholdLow: options.connectionThresholdLow || 30,
      
      // Scaling limits
      minWorkers: options.minWorkers || 2,
      maxWorkers: options.maxWorkers || os.cpus().length * 2,
      minPoolSize: options.minPoolSize || 10,
      maxPoolSize: options.maxPoolSize || 1000,
      
      // Timing
      checkInterval: options.checkInterval || 30000, // 30 seconds
      cooldownPeriod: options.cooldownPeriod || 300000, // 5 minutes
      warmupTime: options.warmupTime || 60000, // 1 minute
      
      // Scaling factors
      scaleUpFactor: options.scaleUpFactor || 1.5,
      scaleDownFactor: options.scaleDownFactor || 0.8,
      
      // Features
      predictiveScaling: options.predictiveScaling !== false,
      costOptimization: options.costOptimization !== false,
      
      ...options
    };
    
    // State
    this.metrics = {
      cpu: [],
      memory: [],
      connections: [],
      throughput: [],
      latency: []
    };
    
    this.scaling = {
      lastScaleUp: 0,
      lastScaleDown: 0,
      currentWorkers: 0,
      targetWorkers: 0,
      poolSizes: new Map(),
      isScaling: false
    };
    
    // Predictions
    this.predictions = {
      nextHourLoad: 0,
      peakTime: null,
      lowTime: null
    };
    
    // Cost tracking
    this.costMetrics = {
      hourlyRate: options.hourlyRate || 0.10, // $/hour per worker
      totalCost: 0,
      savings: 0
    };
    
    // Statistics
    this.stats = {
      scaleUpCount: 0,
      scaleDownCount: 0,
      totalSavings: 0,
      avgResponseTime: 0,
      peakConnections: 0
    };
    
    this.checkTimer = null;
    this.metricsCollector = null;
  }
  
  /**
   * Start auto-scaling
   */
  async start() {
    if (cluster.isPrimary) {
      await this.startPrimary();
    } else {
      await this.startWorker();
    }
  }
  
  /**
   * Start primary process
   */
  async startPrimary() {
    logger.info('Starting auto-scaler in primary mode');
    
    // Initialize workers
    this.scaling.currentWorkers = this.options.minWorkers;
    for (let i = 0; i < this.options.minWorkers; i++) {
      this.spawnWorker();
    }
    
    // Start metrics collection
    this.startMetricsCollection();
    
    // Start scaling checks
    this.checkTimer = setInterval(() => {
      this.checkScaling();
    }, this.options.checkInterval);
    
    // Handle worker messages
    cluster.on('message', (worker, message) => {
      if (message.type === 'metrics') {
        this.handleWorkerMetrics(worker, message.data);
      }
    });
    
    // Handle worker exit
    cluster.on('exit', (worker, code, signal) => {
      logger.warn('Worker died', { 
        worker: worker.id, 
        code, 
        signal,
        suicide: worker.exitedAfterDisconnect
      });
      
      // Restart worker if not intentional
      if (!worker.exitedAfterDisconnect) {
        this.spawnWorker();
      }
    });
    
    this.emit('started', {
      mode: 'primary',
      workers: this.scaling.currentWorkers
    });
  }
  
  /**
   * Start worker process
   */
  async startWorker() {
    logger.info('Starting auto-scaler in worker mode', {
      worker: cluster.worker.id
    });
    
    // Send metrics to primary
    setInterval(() => {
      const metrics = this.collectWorkerMetrics();
      process.send({
        type: 'metrics',
        data: metrics
      });
    }, 5000); // Every 5 seconds
    
    this.emit('started', {
      mode: 'worker',
      id: cluster.worker.id
    });
  }
  
  /**
   * Spawn new worker
   */
  spawnWorker() {
    const worker = cluster.fork();
    
    worker.on('online', () => {
      logger.info('Worker spawned', { worker: worker.id });
      
      // Allow warmup time
      setTimeout(() => {
        worker.ready = true;
      }, this.options.warmupTime);
    });
    
    return worker;
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    this.metricsCollector = setInterval(() => {
      const metrics = this.collectSystemMetrics();
      this.recordMetrics(metrics);
      
      // Predict future load if enabled
      if (this.options.predictiveScaling) {
        this.predictLoad();
      }
      
      // Track costs
      if (this.options.costOptimization) {
        this.trackCosts();
      }
    }, 10000); // Every 10 seconds
  }
  
  /**
   * Collect system metrics
   */
  collectSystemMetrics() {
    const cpus = os.cpus();
    const totalCpu = cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return acc + (1 - idle / total) * 100;
    }, 0) / cpus.length;
    
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memUsage = ((totalMem - freeMem) / totalMem) * 100;
    
    return {
      cpu: totalCpu,
      memory: memUsage,
      loadAvg: os.loadavg()[0],
      timestamp: Date.now()
    };
  }
  
  /**
   * Collect worker metrics
   */
  collectWorkerMetrics() {
    return {
      workerId: cluster.worker.id,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      connections: this.getWorkerConnections(),
      throughput: this.getWorkerThroughput(),
      timestamp: Date.now()
    };
  }
  
  /**
   * Record metrics
   */
  recordMetrics(metrics) {
    // Keep sliding window of metrics
    const maxHistory = 60; // 10 minutes at 10s intervals
    
    this.metrics.cpu.push(metrics.cpu);
    this.metrics.memory.push(metrics.memory);
    
    // Trim old data
    Object.keys(this.metrics).forEach(key => {
      if (this.metrics[key].length > maxHistory) {
        this.metrics[key] = this.metrics[key].slice(-maxHistory);
      }
    });
  }
  
  /**
   * Check if scaling is needed
   */
  async checkScaling() {
    if (this.scaling.isScaling) {
      return; // Already scaling
    }
    
    const decision = this.makeScalingDecision();
    
    if (decision.action === 'scale_up') {
      await this.scaleUp(decision.amount);
    } else if (decision.action === 'scale_down') {
      await this.scaleDown(decision.amount);
    }
    
    // Emit metrics
    this.emit('metrics', {
      metrics: this.getCurrentMetrics(),
      scaling: this.scaling,
      decision
    });
  }
  
  /**
   * Make scaling decision
   */
  makeScalingDecision() {
    const avgCpu = this.getAverage(this.metrics.cpu);
    const avgMemory = this.getAverage(this.metrics.memory);
    const connections = this.getTotalConnections();
    const maxConnections = this.scaling.currentWorkers * 1000; // Assume 1000 per worker
    const connectionPercent = (connections / maxConnections) * 100;
    
    // Check if we're in cooldown
    const now = Date.now();
    const canScaleUp = now - this.scaling.lastScaleUp > this.options.cooldownPeriod;
    const canScaleDown = now - this.scaling.lastScaleDown > this.options.cooldownPeriod;
    
    // Predictive scaling
    if (this.options.predictiveScaling && this.predictions.nextHourLoad > 80) {
      if (canScaleUp) {
        return {
          action: 'scale_up',
          amount: Math.ceil(this.scaling.currentWorkers * 0.3),
          reason: 'predictive_high_load',
          metrics: { predicted: this.predictions.nextHourLoad }
        };
      }
    }
    
    // Reactive scaling - Scale up
    if (avgCpu > this.options.cpuThresholdHigh || 
        avgMemory > this.options.memoryThresholdHigh || 
        connectionPercent > this.options.connectionThresholdHigh) {
      
      if (canScaleUp && this.scaling.currentWorkers < this.options.maxWorkers) {
        const factor = Math.max(
          avgCpu / this.options.cpuThresholdHigh,
          avgMemory / this.options.memoryThresholdHigh,
          connectionPercent / this.options.connectionThresholdHigh
        );
        
        return {
          action: 'scale_up',
          amount: Math.ceil(this.scaling.currentWorkers * (factor - 1)),
          reason: 'high_load',
          metrics: { cpu: avgCpu, memory: avgMemory, connections: connectionPercent }
        };
      }
    }
    
    // Reactive scaling - Scale down
    if (avgCpu < this.options.cpuThresholdLow && 
        avgMemory < this.options.memoryThresholdLow && 
        connectionPercent < this.options.connectionThresholdLow) {
      
      if (canScaleDown && this.scaling.currentWorkers > this.options.minWorkers) {
        return {
          action: 'scale_down',
          amount: Math.floor(this.scaling.currentWorkers * 0.2),
          reason: 'low_load',
          metrics: { cpu: avgCpu, memory: avgMemory, connections: connectionPercent }
        };
      }
    }
    
    return { action: 'none', reason: 'within_thresholds' };
  }
  
  /**
   * Scale up
   */
  async scaleUp(amount) {
    this.scaling.isScaling = true;
    const startWorkers = this.scaling.currentWorkers;
    const targetWorkers = Math.min(
      startWorkers + amount,
      this.options.maxWorkers
    );
    
    logger.info('Scaling up', {
      from: startWorkers,
      to: targetWorkers,
      amount: targetWorkers - startWorkers
    });
    
    // Spawn new workers
    const promises = [];
    for (let i = startWorkers; i < targetWorkers; i++) {
      promises.push(this.spawnWorkerAsync());
    }
    
    await Promise.all(promises);
    
    this.scaling.currentWorkers = targetWorkers;
    this.scaling.lastScaleUp = Date.now();
    this.scaling.isScaling = false;
    this.stats.scaleUpCount++;
    
    this.emit('scaled_up', {
      from: startWorkers,
      to: targetWorkers,
      timestamp: Date.now()
    });
  }
  
  /**
   * Scale down
   */
  async scaleDown(amount) {
    this.scaling.isScaling = true;
    const startWorkers = this.scaling.currentWorkers;
    const targetWorkers = Math.max(
      startWorkers - amount,
      this.options.minWorkers
    );
    
    logger.info('Scaling down', {
      from: startWorkers,
      to: targetWorkers,
      amount: startWorkers - targetWorkers
    });
    
    // Gracefully shutdown workers
    const workers = Object.values(cluster.workers);
    const toShutdown = workers.slice(targetWorkers);
    
    for (const worker of toShutdown) {
      worker.disconnect();
      
      // Give time for graceful shutdown
      setTimeout(() => {
        if (!worker.isDead()) {
          worker.kill();
        }
      }, 30000); // 30 seconds
    }
    
    this.scaling.currentWorkers = targetWorkers;
    this.scaling.lastScaleDown = Date.now();
    this.scaling.isScaling = false;
    this.stats.scaleDownCount++;
    
    // Calculate cost savings
    if (this.options.costOptimization) {
      const hoursSaved = (startWorkers - targetWorkers) * (this.options.checkInterval / 3600000);
      const savings = hoursSaved * this.costMetrics.hourlyRate;
      this.costMetrics.savings += savings;
      this.stats.totalSavings += savings;
    }
    
    this.emit('scaled_down', {
      from: startWorkers,
      to: targetWorkers,
      timestamp: Date.now(),
      savings: this.costMetrics.savings
    });
  }
  
  /**
   * Spawn worker async
   */
  async spawnWorkerAsync() {
    return new Promise((resolve) => {
      const worker = this.spawnWorker();
      worker.once('online', () => {
        setTimeout(resolve, this.options.warmupTime);
      });
    });
  }
  
  /**
   * Predict future load
   */
  predictLoad() {
    // Simple prediction based on historical patterns
    // In production, use ML models
    
    const hour = new Date().getHours();
    const dayOfWeek = new Date().getDay();
    
    // Simulate load patterns
    const baseLoad = 50;
    const hourlyPattern = Math.sin((hour - 6) * Math.PI / 12) * 30;
    const weekdayBonus = dayOfWeek >= 1 && dayOfWeek <= 5 ? 10 : -10;
    const randomVariation = (Math.random() - 0.5) * 20;
    
    this.predictions.nextHourLoad = Math.max(0, Math.min(100,
      baseLoad + hourlyPattern + weekdayBonus + randomVariation
    ));
    
    // Predict peak and low times
    this.predictions.peakTime = '14:00';
    this.predictions.lowTime = '03:00';
  }
  
  /**
   * Track costs
   */
  trackCosts() {
    const hourlyWorkers = this.scaling.currentWorkers;
    const hourlyCost = hourlyWorkers * this.costMetrics.hourlyRate;
    
    // Update total cost (per check interval)
    const intervalHours = this.options.checkInterval / 3600000;
    this.costMetrics.totalCost += hourlyCost * intervalHours;
  }
  
  /**
   * Get average of array
   */
  getAverage(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  
  /**
   * Get total connections (placeholder)
   */
  getTotalConnections() {
    // In production, aggregate from all workers
    return Math.floor(Math.random() * 10000);
  }
  
  /**
   * Get worker connections (placeholder)
   */
  getWorkerConnections() {
    // In production, get actual connection count
    return Math.floor(Math.random() * 1000);
  }
  
  /**
   * Get worker throughput (placeholder)
   */
  getWorkerThroughput() {
    // In production, measure actual throughput
    return Math.floor(Math.random() * 1000000);
  }
  
  /**
   * Handle worker metrics
   */
  handleWorkerMetrics(worker, metrics) {
    // Aggregate worker metrics
    if (!this.scaling.poolSizes.has(worker.id)) {
      this.scaling.poolSizes.set(worker.id, {
        connections: 0,
        throughput: 0,
        cpu: 0,
        memory: 0
      });
    }
    
    const poolMetrics = this.scaling.poolSizes.get(worker.id);
    poolMetrics.connections = metrics.connections;
    poolMetrics.throughput = metrics.throughput;
    poolMetrics.cpu = metrics.cpu.user + metrics.cpu.system;
    poolMetrics.memory = metrics.memory.heapUsed;
  }
  
  /**
   * Get current metrics
   */
  getCurrentMetrics() {
    return {
      cpu: this.getAverage(this.metrics.cpu),
      memory: this.getAverage(this.metrics.memory),
      workers: this.scaling.currentWorkers,
      connections: this.getTotalConnections(),
      predictions: this.predictions,
      costs: this.costMetrics
    };
  }
  
  /**
   * Adjust pool sizes dynamically
   */
  async adjustPoolSizes(poolName, currentSize) {
    const metrics = this.getCurrentMetrics();
    const loadFactor = metrics.cpu / 100;
    
    // Calculate optimal pool size
    const optimalSize = Math.max(
      this.options.minPoolSize,
      Math.min(
        this.options.maxPoolSize,
        Math.ceil(currentSize * (1 + loadFactor))
      )
    );
    
    return optimalSize;
  }
  
  /**
   * Get scaling recommendations
   */
  getRecommendations() {
    const metrics = this.getCurrentMetrics();
    const recommendations = [];
    
    if (metrics.cpu > 70) {
      recommendations.push({
        type: 'scale_up',
        reason: 'High CPU usage',
        action: 'Add more workers or upgrade CPU'
      });
    }
    
    if (metrics.memory > 80) {
      recommendations.push({
        type: 'optimize',
        reason: 'High memory usage',
        action: 'Optimize memory usage or add more RAM'
      });
    }
    
    if (this.predictions.nextHourLoad > 85) {
      recommendations.push({
        type: 'prepare',
        reason: 'Predicted high load',
        action: 'Pre-scale resources before peak time'
      });
    }
    
    if (this.costMetrics.totalCost > 1000) {
      recommendations.push({
        type: 'cost',
        reason: 'High operational cost',
        action: 'Consider reserved instances or optimization'
      });
    }
    
    return recommendations;
  }
  
  /**
   * Get status
   */
  getStatus() {
    return {
      scaling: this.scaling,
      metrics: this.getCurrentMetrics(),
      predictions: this.predictions,
      costs: this.costMetrics,
      stats: this.stats,
      recommendations: this.getRecommendations()
    };
  }
  
  /**
   * Stop auto-scaling
   */
  async stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }
    
    if (this.metricsCollector) {
      clearInterval(this.metricsCollector);
    }
    
    // Gracefully shutdown all workers
    if (cluster.isPrimary) {
      const workers = Object.values(cluster.workers);
      for (const worker of workers) {
        worker.disconnect();
      }
    }
    
    logger.info('Auto-scaler stopped', this.stats);
  }
}

export default AutoScaler;