/**
 * Practical Scaling System - Otedama
 * Simple, effective scaling for national-level deployment
 * 
 * Design Principles:
 * - Carmack: Performance-first, measure everything
 * - Martin: Clear separation of concerns
 * - Pike: Simple solutions that work in practice
 */

import { EventEmitter } from 'events';
import cluster from 'cluster';
import os from 'os';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('PracticalScaling');

/**
 * Simple but effective auto-scaling manager
 */
export class AutoScaler {
  constructor(config = {}) {
    this.config = {
      minWorkers: config.minWorkers || 1,
      maxWorkers: config.maxWorkers || os.cpus().length * 2,
      targetCPU: config.targetCPU || 70, // Target 70% CPU usage
      targetMemory: config.targetMemory || 80, // Target 80% memory usage
      scaleUpThreshold: config.scaleUpThreshold || 85,
      scaleDownThreshold: config.scaleDownThreshold || 50,
      checkInterval: config.checkInterval || 30000, // 30 seconds
      cooldownPeriod: config.cooldownPeriod || 300000, // 5 minutes
      ...config
    };
    
    this.workers = new Map();
    this.lastScaleAction = 0;
    this.metrics = {
      cpuUsage: 0,
      memoryUsage: 0,
      connections: 0,
      requestsPerSecond: 0
    };
    
    this.monitoringInterval = null;
  }
  
  /**
   * Start auto-scaling
   */
  start() {
    if (cluster.isMaster) {
      this.startMaster();
    } else {
      this.startWorker();
    }
  }
  
  /**
   * Master process - manages workers
   */
  startMaster() {
    logger.info('Starting auto-scaler in master mode', {
      minWorkers: this.config.minWorkers,
      maxWorkers: this.config.maxWorkers
    });
    
    // Start initial workers
    for (let i = 0; i < this.config.minWorkers; i++) {
      this.addWorker();
    }
    
    // Handle worker death
    cluster.on('exit', (worker, code, signal) => {
      logger.warn('Worker died', { 
        pid: worker.process.pid, 
        code, 
        signal 
      });
      
      this.workers.delete(worker.id);
      
      // Restart worker if we're below minimum
      if (this.workers.size < this.config.minWorkers) {
        this.addWorker();
      }
    });
    
    // Start monitoring
    this.startMonitoring();
  }
  
  /**
   * Worker process - runs the actual mining pool
   */
  startWorker() {
    logger.info('Starting worker process', { 
      pid: process.pid,
      workerId: cluster.worker.id 
    });
    
    // Worker-specific initialization would go here
    // This would start the actual mining pool server
  }
  
  /**
   * Add a new worker
   */
  addWorker() {
    if (this.workers.size >= this.config.maxWorkers) {
      logger.warn('Cannot add worker - at maximum capacity');
      return null;
    }
    
    const worker = cluster.fork();
    this.workers.set(worker.id, {
      worker,
      started: Date.now(),
      connections: 0,
      requests: 0
    });
    
    logger.info('Added worker', { 
      workerId: worker.id,
      totalWorkers: this.workers.size 
    });
    
    return worker;
  }
  
  /**
   * Remove a worker
   */
  removeWorker() {
    if (this.workers.size <= this.config.minWorkers) {
      logger.warn('Cannot remove worker - at minimum capacity');
      return false;
    }
    
    // Find least busy worker
    let leastBusyWorker = null;
    let minConnections = Infinity;
    
    for (const workerInfo of this.workers.values()) {
      if (workerInfo.connections < minConnections) {
        minConnections = workerInfo.connections;
        leastBusyWorker = workerInfo;
      }
    }
    
    if (leastBusyWorker) {
      logger.info('Removing worker', { 
        workerId: leastBusyWorker.worker.id,
        connections: leastBusyWorker.connections 
      });
      
      this.workers.delete(leastBusyWorker.worker.id);
      leastBusyWorker.worker.kill('SIGTERM');
      return true;
    }
    
    return false;
  }
  
  /**
   * Start system monitoring
   */
  startMonitoring() {
    this.monitoringInterval = setInterval(() => {
      this.collectMetrics();
      this.makeScalingDecision();
    }, this.config.checkInterval);
    
    logger.info('Started monitoring with interval', { 
      interval: this.config.checkInterval 
    });
  }
  
  /**
   * Collect system metrics
   */
  collectMetrics() {
    // CPU usage
    const cpuUsage = process.cpuUsage();
    this.metrics.cpuUsage = (cpuUsage.user + cpuUsage.system) / 1000000;
    
    // Memory usage
    const memUsage = process.memoryUsage();
    this.metrics.memoryUsage = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    // Worker metrics
    let totalConnections = 0;
    let totalRequests = 0;
    
    for (const workerInfo of this.workers.values()) {
      totalConnections += workerInfo.connections || 0;
      totalRequests += workerInfo.requests || 0;
    }
    
    this.metrics.connections = totalConnections;
    this.metrics.requestsPerSecond = totalRequests / (this.config.checkInterval / 1000);
  }
  
  /**
   * Make scaling decision based on metrics
   */
  makeScalingDecision() {
    const now = Date.now();
    
    // Check cooldown period
    if (now - this.lastScaleAction < this.config.cooldownPeriod) {
      return;
    }
    
    const { cpuUsage, memoryUsage, connections } = this.metrics;
    const avgLoad = (cpuUsage + memoryUsage) / 2;
    
    logger.debug('Scaling metrics', {
      workers: this.workers.size,
      cpuUsage: cpuUsage.toFixed(2),
      memoryUsage: memoryUsage.toFixed(2),
      avgLoad: avgLoad.toFixed(2),
      connections
    });
    
    // Scale up if overloaded
    if (avgLoad > this.config.scaleUpThreshold) {
      if (this.addWorker()) {
        this.lastScaleAction = now;
        logger.info('Scaled up due to high load', {
          avgLoad: avgLoad.toFixed(2),
          newWorkerCount: this.workers.size
        });
      }
    }
    // Scale down if underutilized
    else if (avgLoad < this.config.scaleDownThreshold && this.workers.size > this.config.minWorkers) {
      if (this.removeWorker()) {
        this.lastScaleAction = now;
        logger.info('Scaled down due to low load', {
          avgLoad: avgLoad.toFixed(2),
          newWorkerCount: this.workers.size
        });
      }
    }
  }
  
  /**
   * Get current scaling status
   */
  getStatus() {
    return {
      workers: this.workers.size,
      metrics: this.metrics,
      config: this.config,
      lastScaleAction: this.lastScaleAction
    };
  }
  
  /**
   * Stop auto-scaling
   */
  stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    
    // Gracefully shutdown all workers
    for (const workerInfo of this.workers.values()) {
      workerInfo.worker.kill('SIGTERM');
    }
    
    logger.info('Auto-scaler stopped');
  }
}

/**
 * Simple load balancer for distributing connections
 */
export class SimpleLoadBalancer {
  constructor() {
    this.servers = [];
    this.currentIndex = 0;
    this.healthChecks = new Map();
  }
  
  /**
   * Add server to load balancer
   */
  addServer(server) {
    this.servers.push(server);
    this.healthChecks.set(server.id, {
      healthy: true,
      lastCheck: Date.now(),
      failures: 0
    });
    
    logger.info('Added server to load balancer', { 
      serverId: server.id,
      totalServers: this.servers.length 
    });
  }
  
  /**
   * Remove server from load balancer
   */
  removeServer(serverId) {
    this.servers = this.servers.filter(s => s.id !== serverId);
    this.healthChecks.delete(serverId);
    
    // Reset index if it's out of bounds
    if (this.currentIndex >= this.servers.length) {
      this.currentIndex = 0;
    }
    
    logger.info('Removed server from load balancer', { 
      serverId,
      totalServers: this.servers.length 
    });
  }
  
  /**
   * Get next available server (round-robin)
   */
  getNextServer() {
    if (this.servers.length === 0) {
      return null;
    }
    
    let attempts = 0;
    const maxAttempts = this.servers.length;
    
    while (attempts < maxAttempts) {
      const server = this.servers[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.servers.length;
      
      const health = this.healthChecks.get(server.id);
      if (health && health.healthy) {
        return server;
      }
      
      attempts++;
    }
    
    // All servers unhealthy, return first available
    return this.servers[0] || null;
  }
  
  /**
   * Mark server as healthy/unhealthy
   */
  updateServerHealth(serverId, healthy) {
    const health = this.healthChecks.get(serverId);
    if (health) {
      health.healthy = healthy;
      health.lastCheck = Date.now();
      
      if (!healthy) {
        health.failures++;
      } else {
        health.failures = 0;
      }
      
      logger.debug('Updated server health', { 
        serverId, 
        healthy, 
        failures: health.failures 
      });
    }
  }
  
  /**
   * Get load balancer status
   */
  getStatus() {
    return {
      totalServers: this.servers.length,
      healthyServers: Array.from(this.healthChecks.values()).filter(h => h.healthy).length,
      currentIndex: this.currentIndex,
      servers: this.servers.map(s => ({
        id: s.id,
        healthy: this.healthChecks.get(s.id)?.healthy || false,
        failures: this.healthChecks.get(s.id)?.failures || 0
      }))
    };
  }
}

/**
 * Distributed configuration manager
 */
export class DistributedConfig {
  constructor() {
    this.config = new Map();
    this.listeners = new Map();
  }
  
  /**
   * Set configuration value
   */
  set(key, value) {
    const oldValue = this.config.get(key);
    this.config.set(key, value);
    
    // Notify listeners
    const keyListeners = this.listeners.get(key) || [];
    for (const listener of keyListeners) {
      try {
        listener(value, oldValue);
      } catch (error) {
        logger.error('Config listener error', { key, error });
      }
    }
    
    logger.debug('Config updated', { key, value });
  }
  
  /**
   * Get configuration value
   */
  get(key, defaultValue = null) {
    return this.config.get(key) || defaultValue;
  }
  
  /**
   * Listen for configuration changes
   */
  watch(key, listener) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key).push(listener);
  }
  
  /**
   * Broadcast configuration to all workers
   */
  broadcast(key, value) {
    if (cluster.isMaster) {
      for (const worker of Object.values(cluster.workers)) {
        worker.send({ type: 'config', key, value });
      }
    }
    
    this.set(key, value);
  }
}

// Export singletons
export const autoScaler = new AutoScaler();
export const loadBalancer = new SimpleLoadBalancer();
export const distributedConfig = new DistributedConfig();

export default {
  AutoScaler,
  SimpleLoadBalancer,
  DistributedConfig,
  autoScaler,
  loadBalancer,
  distributedConfig
};