/**
 * Internal Load Balancer for Otedama
 * Distributes work across workers and services
 * 
 * Design principles:
 * - Carmack: Minimal overhead, fast routing
 * - Martin: Clean interfaces, pluggable strategies
 * - Pike: Simple and effective
 */

import { EventEmitter } from 'events';
import { logger } from './logger.js';

export const BalancingStrategy = {
  ROUND_ROBIN: 'round_robin',
  LEAST_CONNECTIONS: 'least_connections',
  WEIGHTED_ROUND_ROBIN: 'weighted_round_robin',
  RANDOM: 'random',
  LEAST_RESPONSE_TIME: 'least_response_time',
  HASH: 'hash'
};

export class Worker {
  constructor(id, options = {}) {
    this.id = id;
    this.weight = options.weight || 1;
    this.maxConnections = options.maxConnections || 100;
    this.tags = new Set(options.tags || []);
    
    // State
    this.active = true;
    this.connections = 0;
    this.totalRequests = 0;
    this.totalResponseTime = 0;
    this.errors = 0;
    this.lastError = null;
    this.lastUsed = Date.now();
    
    // Health tracking
    this.healthChecks = {
      passed: 0,
      failed: 0,
      lastCheck: null
    };
  }
  
  get load() {
    return this.connections / this.maxConnections;
  }
  
  get avgResponseTime() {
    return this.totalRequests > 0 
      ? this.totalResponseTime / this.totalRequests 
      : 0;
  }
  
  get errorRate() {
    return this.totalRequests > 0 
      ? this.errors / this.totalRequests 
      : 0;
  }
  
  get score() {
    // Calculate worker score for selection
    if (!this.active) return -1;
    
    // Consider multiple factors
    const loadFactor = 1 - this.load;
    const errorFactor = 1 - Math.min(this.errorRate, 0.5);
    const responseFactor = this.avgResponseTime > 0 
      ? 1 / (1 + this.avgResponseTime / 1000) 
      : 1;
    
    return (loadFactor * 0.4 + errorFactor * 0.4 + responseFactor * 0.2) * this.weight;
  }
}

export class LoadBalancer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      strategy: options.strategy || BalancingStrategy.LEAST_CONNECTIONS,
      healthCheckInterval: options.healthCheckInterval || 30000,
      maxFailures: options.maxFailures || 3,
      recoveryTime: options.recoveryTime || 60000,
      stickySession: options.stickySession || false,
      sessionTimeout: options.sessionTimeout || 3600000,
      ...options
    };
    
    // Worker pool
    this.workers = new Map();
    this.activeWorkers = [];
    
    // Strategy state
    this.roundRobinIndex = 0;
    this.sessions = new Map();
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0
    };
    
    // Health check timer
    this.healthCheckTimer = null;
    
    // Initialize strategies
    this.strategies = this._initializeStrategies();
  }
  
  _initializeStrategies() {
    return {
      [BalancingStrategy.ROUND_ROBIN]: () => this._roundRobin(),
      [BalancingStrategy.LEAST_CONNECTIONS]: () => this._leastConnections(),
      [BalancingStrategy.WEIGHTED_ROUND_ROBIN]: () => this._weightedRoundRobin(),
      [BalancingStrategy.RANDOM]: () => this._random(),
      [BalancingStrategy.LEAST_RESPONSE_TIME]: () => this._leastResponseTime(),
      [BalancingStrategy.HASH]: (key) => this._hash(key)
    };
  }
  
  addWorker(id, options = {}) {
    const worker = new Worker(id, options);
    this.workers.set(id, worker);
    this._updateActiveWorkers();
    
    logger.info(`Added worker ${id} to load balancer`, {
      weight: worker.weight,
      maxConnections: worker.maxConnections
    });
    
    this.emit('workerAdded', worker);
    return worker;
  }
  
  removeWorker(id) {
    const worker = this.workers.get(id);
    if (!worker) return false;
    
    this.workers.delete(id);
    this._updateActiveWorkers();
    
    // Clean up sessions
    for (const [sessionId, workerId] of this.sessions) {
      if (workerId === id) {
        this.sessions.delete(sessionId);
      }
    }
    
    logger.info(`Removed worker ${id} from load balancer`);
    this.emit('workerRemoved', worker);
    return true;
  }
  
  async selectWorker(options = {}) {
    const { sessionId, key, tags } = options;
    
    // Check sticky session
    if (this.options.stickySession && sessionId) {
      const workerId = this.sessions.get(sessionId);
      if (workerId) {
        const worker = this.workers.get(workerId);
        if (worker && worker.active) {
          return worker;
        }
      }
    }
    
    // Filter workers by tags if specified
    let candidates = this.activeWorkers;
    if (tags && tags.length > 0) {
      candidates = candidates.filter(worker => 
        tags.every(tag => worker.tags.has(tag))
      );
    }
    
    if (candidates.length === 0) {
      throw new Error('No available workers');
    }
    
    // Select using strategy
    const strategy = this.strategies[this.options.strategy];
    const worker = key 
      ? strategy(key) 
      : strategy();
    
    if (!worker) {
      throw new Error('Failed to select worker');
    }
    
    // Update sticky session
    if (this.options.stickySession && sessionId) {
      this.sessions.set(sessionId, worker.id);
      
      // Clean old sessions
      setTimeout(() => {
        this.sessions.delete(sessionId);
      }, this.options.sessionTimeout);
    }
    
    return worker;
  }
  
  async execute(workerId, task) {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }
    
    if (!worker.active) {
      throw new Error(`Worker ${workerId} is not active`);
    }
    
    const startTime = Date.now();
    worker.connections++;
    worker.totalRequests++;
    this.metrics.totalRequests++;
    
    try {
      // Execute task
      const result = await task(worker);
      
      // Update metrics
      const responseTime = Date.now() - startTime;
      worker.totalResponseTime += responseTime;
      worker.lastUsed = Date.now();
      this.metrics.successfulRequests++;
      this._updateAvgResponseTime(responseTime);
      
      this.emit('requestCompleted', {
        workerId,
        responseTime,
        success: true
      });
      
      return result;
    } catch (error) {
      // Track error
      worker.errors++;
      worker.lastError = error;
      this.metrics.failedRequests++;
      
      this.emit('requestFailed', {
        workerId,
        error,
        responseTime: Date.now() - startTime
      });
      
      // Check if worker should be marked unhealthy
      if (worker.errors >= this.options.maxFailures) {
        this._markWorkerUnhealthy(worker);
      }
      
      throw error;
    } finally {
      worker.connections--;
    }
  }
  
  // Strategy implementations
  _roundRobin() {
    if (this.activeWorkers.length === 0) return null;
    
    const worker = this.activeWorkers[this.roundRobinIndex];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.activeWorkers.length;
    
    return worker;
  }
  
  _leastConnections() {
    let selected = null;
    let minConnections = Infinity;
    
    for (const worker of this.activeWorkers) {
      if (worker.connections < minConnections) {
        minConnections = worker.connections;
        selected = worker;
      }
    }
    
    return selected;
  }
  
  _weightedRoundRobin() {
    // Calculate total weight
    const totalWeight = this.activeWorkers.reduce((sum, w) => sum + w.weight, 0);
    
    // Generate random number
    let random = Math.random() * totalWeight;
    
    // Select based on weight
    for (const worker of this.activeWorkers) {
      random -= worker.weight;
      if (random <= 0) {
        return worker;
      }
    }
    
    return this.activeWorkers[0];
  }
  
  _random() {
    const index = Math.floor(Math.random() * this.activeWorkers.length);
    return this.activeWorkers[index];
  }
  
  _leastResponseTime() {
    let selected = null;
    let minResponseTime = Infinity;
    
    for (const worker of this.activeWorkers) {
      const responseTime = worker.avgResponseTime;
      if (responseTime < minResponseTime) {
        minResponseTime = responseTime;
        selected = worker;
      }
    }
    
    return selected || this.activeWorkers[0];
  }
  
  _hash(key) {
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash) + key.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    const index = Math.abs(hash) % this.activeWorkers.length;
    return this.activeWorkers[index];
  }
  
  // Health management
  startHealthChecks(checkFunction) {
    this.healthCheckTimer = setInterval(async () => {
      for (const worker of this.workers.values()) {
        await this._checkWorkerHealth(worker, checkFunction);
      }
    }, this.options.healthCheckInterval);
  }
  
  stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
  
  async _checkWorkerHealth(worker, checkFunction) {
    try {
      const healthy = await checkFunction(worker);
      
      if (healthy) {
        worker.healthChecks.passed++;
        
        // Recover if was unhealthy
        if (!worker.active && 
            Date.now() - worker.healthChecks.lastCheck > this.options.recoveryTime) {
          this._markWorkerHealthy(worker);
        }
      } else {
        worker.healthChecks.failed++;
        
        // Mark unhealthy if too many failures
        if (worker.healthChecks.failed >= this.options.maxFailures) {
          this._markWorkerUnhealthy(worker);
        }
      }
      
      worker.healthChecks.lastCheck = Date.now();
    } catch (error) {
      logger.error(`Health check failed for worker ${worker.id}`, error);
      worker.healthChecks.failed++;
    }
  }
  
  _markWorkerUnhealthy(worker) {
    if (!worker.active) return;
    
    worker.active = false;
    this._updateActiveWorkers();
    
    logger.warn(`Worker ${worker.id} marked as unhealthy`, {
      errors: worker.errors,
      errorRate: worker.errorRate
    });
    
    this.emit('workerUnhealthy', worker);
  }
  
  _markWorkerHealthy(worker) {
    if (worker.active) return;
    
    worker.active = true;
    worker.errors = 0;
    worker.healthChecks.failed = 0;
    this._updateActiveWorkers();
    
    logger.info(`Worker ${worker.id} recovered and marked as healthy`);
    this.emit('workerHealthy', worker);
  }
  
  _updateActiveWorkers() {
    this.activeWorkers = Array.from(this.workers.values())
      .filter(w => w.active)
      .sort((a, b) => b.score - a.score);
  }
  
  _updateAvgResponseTime(responseTime) {
    const alpha = 0.1; // Exponential moving average factor
    this.metrics.avgResponseTime = 
      this.metrics.avgResponseTime * (1 - alpha) + responseTime * alpha;
  }
  
  // Management methods
  rebalance() {
    this._updateActiveWorkers();
    this.roundRobinIndex = 0;
    
    logger.info('Load balancer rebalanced', {
      totalWorkers: this.workers.size,
      activeWorkers: this.activeWorkers.length
    });
  }
  
  getWorkerStats(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker) return null;
    
    return {
      id: worker.id,
      active: worker.active,
      weight: worker.weight,
      connections: worker.connections,
      load: worker.load,
      totalRequests: worker.totalRequests,
      avgResponseTime: worker.avgResponseTime,
      errorRate: worker.errorRate,
      score: worker.score,
      lastUsed: worker.lastUsed
    };
  }
  
  getAllStats() {
    const workers = Array.from(this.workers.values()).map(w => this.getWorkerStats(w.id));
    
    return {
      strategy: this.options.strategy,
      totalWorkers: this.workers.size,
      activeWorkers: this.activeWorkers.length,
      metrics: this.metrics,
      workers
    };
  }
  
  reset() {
    for (const worker of this.workers.values()) {
      worker.connections = 0;
      worker.totalRequests = 0;
      worker.totalResponseTime = 0;
      worker.errors = 0;
      worker.lastError = null;
    }
    
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0
    };
  }
}

export default LoadBalancer;