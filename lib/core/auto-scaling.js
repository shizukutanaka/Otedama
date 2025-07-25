/**
 * Auto-scaling Manager - Otedama
 * Automatic resource scaling based on load
 * 
 * Features:
 * - Dynamic worker process management
 * - Load-based scaling decisions
 * - Resource usage monitoring
 * - Predictive scaling
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import cluster from 'cluster';
import os from 'os';

const logger = createLogger('AutoScalingManager');

export class AutoScalingManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      minWorkers: config.minWorkers || 2,
      maxWorkers: config.maxWorkers || os.cpus().length,
      scaleUpThreshold: config.scaleUpThreshold || 0.8, // 80% CPU
      scaleDownThreshold: config.scaleDownThreshold || 0.3, // 30% CPU
      cooldownPeriod: config.cooldownPeriod || 60000, // 1 minute
      metricsInterval: config.metricsInterval || 10000, // 10 seconds
      memoryLimit: config.memoryLimit || 0.85 // 85% memory usage
    };
    
    this.metrics = {
      cpu: [],
      memory: [],
      connections: [],
      shareRate: []
    };
    
    this.workers = new Map();
    this.lastScaleAction = 0;
    this.metricsTimer = null;
  }
  
  /**
   * Start auto-scaling
   */
  start() {
    if (!cluster.isMaster && !cluster.isPrimary) {
      logger.warn('Auto-scaling can only run on master process');
      return;
    }
    
    logger.info('Starting auto-scaling manager...');
    
    // Start metrics collection
    this.metricsTimer = setInterval(() => {
      this.collectMetrics();
      this.evaluateScaling();
    }, this.config.metricsInterval);
    
    // Initialize with minimum workers
    this.ensureMinimumWorkers();
  }
  
  /**
   * Collect system metrics
   */
  async collectMetrics() {
    const cpuUsage = await this.getCPUUsage();
    const memoryUsage = process.memoryUsage();
    const totalMemory = os.totalmem();
    
    // Store metrics (keep last 5 minutes)
    this.metrics.cpu.push({
      timestamp: Date.now(),
      value: cpuUsage
    });
    
    this.metrics.memory.push({
      timestamp: Date.now(),
      value: memoryUsage.heapUsed / totalMemory
    });
    
    // Cleanup old metrics
    const fiveMinutesAgo = Date.now() - 300000;
    Object.keys(this.metrics).forEach(key => {
      this.metrics[key] = this.metrics[key].filter(m => m.timestamp > fiveMinutesAgo);
    });
  }
  
  /**
   * Get CPU usage
   */
  async getCPUUsage() {
    const startUsage = process.cpuUsage();
    const startTime = process.hrtime.bigint();
    
    // Wait 100ms
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const endUsage = process.cpuUsage(startUsage);
    const endTime = process.hrtime.bigint();
    
    const userTime = endUsage.user;
    const systemTime = endUsage.system;
    const totalTime = userTime + systemTime;
    const elapsedTime = Number(endTime - startTime);
    
    return totalTime / elapsedTime;
  }
  
  /**
   * Evaluate scaling needs
   */
  evaluateScaling() {
    // Check cooldown
    if (Date.now() - this.lastScaleAction < this.config.cooldownPeriod) {
      return;
    }
    
    const avgCPU = this.getAverageMetric('cpu');
    const avgMemory = this.getAverageMetric('memory');
    const currentWorkers = this.workers.size;
    
    logger.debug(`Metrics - CPU: ${(avgCPU * 100).toFixed(1)}%, Memory: ${(avgMemory * 100).toFixed(1)}%, Workers: ${currentWorkers}`);
    
    // Scale up conditions
    if (avgCPU > this.config.scaleUpThreshold && currentWorkers < this.config.maxWorkers) {
      this.scaleUp();
    }
    // Scale down conditions
    else if (avgCPU < this.config.scaleDownThreshold && 
             avgMemory < this.config.memoryLimit &&
             currentWorkers > this.config.minWorkers) {
      this.scaleDown();
    }
  }
  
  /**
   * Get average metric value
   */
  getAverageMetric(type) {
    const values = this.metrics[type];
    if (values.length === 0) return 0;
    
    const sum = values.reduce((acc, m) => acc + m.value, 0);
    return sum / values.length;
  }
  
  /**
   * Scale up - add worker
   */
  scaleUp() {
    const worker = cluster.fork();
    this.workers.set(worker.id, {
      id: worker.id,
      pid: worker.process.pid,
      startTime: Date.now()
    });
    
    this.lastScaleAction = Date.now();
    
    logger.info(`Scaled up to ${this.workers.size} workers`);
    this.emit('scale:up', { workers: this.workers.size });
  }
  
  /**
   * Scale down - remove worker
   */
  scaleDown() {
    // Find oldest worker
    let oldestWorker = null;
    let oldestTime = Date.now();
    
    for (const [id, workerInfo] of this.workers) {
      if (workerInfo.startTime < oldestTime) {
        oldestTime = workerInfo.startTime;
        oldestWorker = cluster.workers[id];
      }
    }
    
    if (oldestWorker) {
      // Graceful shutdown
      oldestWorker.send({ cmd: 'shutdown' });
      setTimeout(() => {
        if (!oldestWorker.isDead()) {
          oldestWorker.kill();
        }
      }, 5000);
      
      this.workers.delete(oldestWorker.id);
      this.lastScaleAction = Date.now();
      
      logger.info(`Scaled down to ${this.workers.size} workers`);
      this.emit('scale:down', { workers: this.workers.size });
    }
  }
  
  /**
   * Ensure minimum workers
   */
  ensureMinimumWorkers() {
    const currentWorkers = Object.keys(cluster.workers).length;
    const needed = this.config.minWorkers - currentWorkers;
    
    for (let i = 0; i < needed; i++) {
      this.scaleUp();
    }
  }
  
  /**
   * Register worker
   */
  registerWorker(worker) {
    this.workers.set(worker.id, {
      id: worker.id,
      pid: worker.process.pid,
      startTime: Date.now()
    });
  }
  
  /**
   * Unregister worker
   */
  unregisterWorker(workerId) {
    this.workers.delete(workerId);
  }
  
  /**
   * Get scaling statistics
   */
  getStats() {
    return {
      currentWorkers: this.workers.size,
      minWorkers: this.config.minWorkers,
      maxWorkers: this.config.maxWorkers,
      avgCPU: this.getAverageMetric('cpu'),
      avgMemory: this.getAverageMetric('memory'),
      lastScaleAction: this.lastScaleAction
    };
  }
  
  /**
   * Stop auto-scaling
   */
  stop() {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
    
    logger.info('Auto-scaling manager stopped');
  }
}

export default AutoScalingManager;
