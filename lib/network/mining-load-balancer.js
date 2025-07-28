/**
 * Mining Pool Load Balancer for Otedama
 * Simple but effective load balancing for national-scale mining operations
 * 
 * Design principles:
 * - Carmack: Performance-first with minimal overhead
 * - Martin: Clean separation of concerns
 * - Pike: Simple and reliable operation
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('MiningLoadBalancer');

/**
 * Load balancing strategies
 */
export const BalancingStrategy = {
  ROUND_ROBIN: 'round_robin',
  LEAST_CONNECTIONS: 'least_connections',
  WEIGHTED_ROUND_ROBIN: 'weighted_round_robin',
  HASH_BASED: 'hash_based',
  GEOGRAPHIC: 'geographic'
};

/**
 * Backend mining server representation
 */
class BackendServer {
  constructor(config) {
    this.id = config.id;
    this.host = config.host;
    this.port = config.port;
    this.weight = config.weight || 1;
    this.region = config.region || 'default';
    this.isHealthy = true;
    this.activeConnections = 0;
    this.totalConnections = 0;
    this.lastResponseTime = 0;
    this.lastHealthCheck = Date.now();
    this.maxConnections = config.maxConnections || 10000;
  }

  canAcceptConnection() {
    return this.isHealthy && this.activeConnections < this.maxConnections;
  }

  addConnection() {
    this.activeConnections++;
    this.totalConnections++;
  }

  removeConnection() {
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  getConnectionRatio() {
    return this.activeConnections / this.maxConnections;
  }

  updateHealth(healthy, responseTime = 0) {
    this.isHealthy = healthy;
    this.lastResponseTime = responseTime;
    this.lastHealthCheck = Date.now();
  }
}

/**
 * Mining Load Balancer
 * Distributes mining connections across multiple backend servers
 */
export class MiningLoadBalancer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.strategy = options.strategy || BalancingStrategy.LEAST_CONNECTIONS;
    this.healthCheckInterval = options.healthCheckInterval || 30000;
    this.healthCheckTimeout = options.healthCheckTimeout || 5000;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    
    this.backends = new Map();
    this.roundRobinIndex = 0;
    this.isRunning = false;
    this.healthCheckTimer = null;
    
    // Statistics
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      failedConnections: 0,
      balancingDecisions: 0,
      healthChecks: 0,
      failedHealthChecks: 0
    };
  }

  /**
   * Add a backend mining server
   */
  addBackend(config) {
    const backend = new BackendServer(config);
    this.backends.set(backend.id, backend);
    
    logger.info('Backend server added', {
      id: backend.id,
      host: backend.host,
      port: backend.port,
      weight: backend.weight,
      region: backend.region
    });
    
    this.emit('backendAdded', backend);
    return backend.id;
  }

  /**
   * Remove a backend server
   */
  removeBackend(id) {
    const backend = this.backends.get(id);
    if (backend) {
      this.backends.delete(id);
      logger.info('Backend server removed', { id });
      this.emit('backendRemoved', backend);
      return true;
    }
    return false;
  }

  /**
   * Get the best backend server for a new connection
   */
  selectBackend(clientInfo = {}) {
    const healthyBackends = Array.from(this.backends.values())
      .filter(backend => backend.canAcceptConnection());
    
    if (healthyBackends.length === 0) {
      logger.error('No healthy backends available');
      this.stats.failedConnections++;
      return null;
    }

    let selectedBackend = null;

    switch (this.strategy) {
      case BalancingStrategy.ROUND_ROBIN:
        selectedBackend = this.selectRoundRobin(healthyBackends);
        break;
        
      case BalancingStrategy.LEAST_CONNECTIONS:
        selectedBackend = this.selectLeastConnections(healthyBackends);
        break;
        
      case BalancingStrategy.WEIGHTED_ROUND_ROBIN:
        selectedBackend = this.selectWeightedRoundRobin(healthyBackends);
        break;
        
      case BalancingStrategy.HASH_BASED:
        selectedBackend = this.selectHashBased(healthyBackends, clientInfo);
        break;
        
      case BalancingStrategy.GEOGRAPHIC:
        selectedBackend = this.selectGeographic(healthyBackends, clientInfo);
        break;
        
      default:
        selectedBackend = this.selectLeastConnections(healthyBackends);
    }

    if (selectedBackend) {
      selectedBackend.addConnection();
      this.stats.balancingDecisions++;
      this.stats.totalConnections++;
      this.stats.activeConnections++;
      
      logger.debug('Backend selected', {
        strategy: this.strategy,
        backend: selectedBackend.id,
        activeConnections: selectedBackend.activeConnections
      });
    }

    return selectedBackend;
  }

  /**
   * Round robin selection
   */
  selectRoundRobin(backends) {
    if (backends.length === 0) return null;
    
    const selected = backends[this.roundRobinIndex % backends.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % backends.length;
    
    return selected;
  }

  /**
   * Least connections selection
   */
  selectLeastConnections(backends) {
    return backends.reduce((min, current) => 
      current.activeConnections < min.activeConnections ? current : min
    );
  }

  /**
   * Weighted round robin selection
   */
  selectWeightedRoundRobin(backends) {
    const weightedBackends = [];
    
    backends.forEach(backend => {
      for (let i = 0; i < backend.weight; i++) {
        weightedBackends.push(backend);
      }
    });
    
    if (weightedBackends.length === 0) return null;
    
    const selected = weightedBackends[this.roundRobinIndex % weightedBackends.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % weightedBackends.length;
    
    return selected;
  }

  /**
   * Hash-based selection (sticky sessions)
   */
  selectHashBased(backends, clientInfo) {
    const key = clientInfo.ip || clientInfo.workerId || 'default';
    const hash = this.simpleHash(key);
    const index = hash % backends.length;
    
    return backends[index];
  }

  /**
   * Geographic selection
   */
  selectGeographic(backends, clientInfo) {
    const clientRegion = clientInfo.region || 'default';
    
    // First try to find a backend in the same region
    const regionalBackends = backends.filter(b => b.region === clientRegion);
    if (regionalBackends.length > 0) {
      return this.selectLeastConnections(regionalBackends);
    }
    
    // Fall back to least connections across all backends
    return this.selectLeastConnections(backends);
  }

  /**
   * Simple hash function
   */
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Release a connection from a backend
   */
  releaseConnection(backendId) {
    const backend = this.backends.get(backendId);
    if (backend) {
      backend.removeConnection();
      this.stats.activeConnections = Math.max(0, this.stats.activeConnections - 1);
      
      logger.debug('Connection released', {
        backend: backendId,
        activeConnections: backend.activeConnections
      });
    }
  }

  /**
   * Start the load balancer
   */
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.startHealthChecks();
    
    logger.info('Mining load balancer started', {
      strategy: this.strategy,
      backends: this.backends.size,
      healthCheckInterval: this.healthCheckInterval
    });
    
    this.emit('started');
  }

  /**
   * Stop the load balancer
   */
  async stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    logger.info('Mining load balancer stopped');
    this.emit('stopped');
  }

  /**
   * Start periodic health checks
   */
  startHealthChecks() {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthChecks();
    }, this.healthCheckInterval);
    
    // Perform initial health check
    setTimeout(() => this.performHealthChecks(), 1000);
  }

  /**
   * Perform health checks on all backends
   */
  async performHealthChecks() {
    const promises = Array.from(this.backends.values()).map(backend => 
      this.checkBackendHealth(backend)
    );
    
    await Promise.allSettled(promises);
    this.stats.healthChecks++;
  }

  /**
   * Check health of a single backend
   */
  async checkBackendHealth(backend) {
    try {
      const startTime = Date.now();
      
      // Simple TCP connection test
      const result = await this.testConnection(backend.host, backend.port);
      const responseTime = Date.now() - startTime;
      
      backend.updateHealth(result, responseTime);
      
      if (!result && backend.isHealthy) {
        logger.warn('Backend health check failed', {
          id: backend.id,
          host: backend.host,
          port: backend.port
        });
        this.emit('backendUnhealthy', backend);
      } else if (result && !backend.isHealthy) {
        logger.info('Backend recovered', {
          id: backend.id,
          host: backend.host,
          port: backend.port
        });
        this.emit('backendRecovered', backend);
      }
      
    } catch (error) {
      backend.updateHealth(false);
      this.stats.failedHealthChecks++;
      
      logger.error('Health check error', {
        backend: backend.id,
        error: error.message
      });
    }
  }

  /**
   * Test connection to a backend
   */
  async testConnection(host, port) {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, this.healthCheckTimeout);
      
      socket.connect(port, host, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });
      
      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /**
   * Get load balancer statistics
   */
  getStats() {
    const backendStats = Array.from(this.backends.values()).map(backend => ({
      id: backend.id,
      host: backend.host,
      port: backend.port,
      isHealthy: backend.isHealthy,
      activeConnections: backend.activeConnections,
      totalConnections: backend.totalConnections,
      connectionRatio: backend.getConnectionRatio(),
      lastResponseTime: backend.lastResponseTime,
      weight: backend.weight,
      region: backend.region
    }));
    
    return {
      ...this.stats,
      strategy: this.strategy,
      backends: backendStats,
      healthyBackends: backendStats.filter(b => b.isHealthy).length,
      totalBackends: backendStats.length
    };
  }

  /**
   * Update load balancing strategy
   */
  setStrategy(strategy) {
    if (Object.values(BalancingStrategy).includes(strategy)) {
      this.strategy = strategy;
      this.roundRobinIndex = 0; // Reset round robin index
      
      logger.info('Load balancing strategy updated', { strategy });
      this.emit('strategyChanged', strategy);
    } else {
      throw new Error(`Invalid load balancing strategy: ${strategy}`);
    }
  }

  /**
   * Get healthy backends count
   */
  getHealthyBackendsCount() {
    return Array.from(this.backends.values())
      .filter(backend => backend.isHealthy).length;
  }

  /**
   * Check if load balancer is healthy
   */
  isHealthy() {
    return this.getHealthyBackendsCount() > 0;
  }
}

export default MiningLoadBalancer;