/**
 * Advanced Load Balancer
 * Intelligent load distribution with health monitoring
 * 
 * Features:
 * - Weighted round-robin
 * - Least connections
 * - Response time based
 * - Circuit breaker pattern
 * - Health checks
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('LoadBalancer');

/**
 * Load balancing algorithms
 */
export const Algorithm = {
  ROUND_ROBIN: 'round_robin',
  WEIGHTED_ROUND_ROBIN: 'weighted_round_robin',
  LEAST_CONNECTIONS: 'least_connections',
  LEAST_RESPONSE_TIME: 'least_response_time',
  IP_HASH: 'ip_hash',
  RANDOM: 'random'
};

/**
 * Backend server state
 */
class Backend {
  constructor(config) {
    this.id = config.id;
    this.host = config.host;
    this.port = config.port;
    this.weight = config.weight || 1;
    this.maxConnections = config.maxConnections || 1000;
    
    // State
    this.healthy = true;
    this.connections = 0;
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.responseTime = 0;
    this.lastHealthCheck = 0;
    
    // Circuit breaker
    this.circuitBreaker = {
      state: 'closed', // closed, open, half-open
      failures: 0,
      lastFailure: 0,
      successfulRequests: 0
    };
    
    // Statistics
    this.stats = {
      requestsPerSecond: 0,
      avgResponseTime: 0,
      errorRate: 0,
      uptime: 100
    };
  }
  
  /**
   * Check if backend can accept requests
   */
  canAcceptRequest() {
    if (!this.healthy) return false;
    if (this.connections >= this.maxConnections) return false;
    if (this.circuitBreaker.state === 'open') {
      // Check if we should transition to half-open
      if (Date.now() - this.circuitBreaker.lastFailure > 30000) {
        this.circuitBreaker.state = 'half-open';
        return true;
      }
      return false;
    }
    return true;
  }
  
  /**
   * Record successful request
   */
  recordSuccess(responseTime) {
    this.totalRequests++;
    this.responseTime = (this.responseTime * 0.9) + (responseTime * 0.1); // EMA
    
    if (this.circuitBreaker.state === 'half-open') {
      this.circuitBreaker.successfulRequests++;
      if (this.circuitBreaker.successfulRequests >= 5) {
        this.circuitBreaker.state = 'closed';
        this.circuitBreaker.failures = 0;
        this.circuitBreaker.successfulRequests = 0;
      }
    }
  }
  
  /**
   * Record failed request
   */
  recordFailure() {
    this.totalRequests++;
    this.failedRequests++;
    this.circuitBreaker.failures++;
    this.circuitBreaker.lastFailure = Date.now();
    
    // Open circuit if too many failures
    if (this.circuitBreaker.failures >= 5) {
      this.circuitBreaker.state = 'open';
      logger.warn(`Circuit breaker opened for backend ${this.id}`);
    }
  }
  
  /**
   * Update statistics
   */
  updateStats() {
    const now = Date.now();
    const timeDelta = (now - this.lastStatsUpdate) / 1000;
    
    if (timeDelta > 0) {
      this.stats.requestsPerSecond = 
        (this.totalRequests - this.lastTotalRequests) / timeDelta;
      this.stats.avgResponseTime = this.responseTime;
      this.stats.errorRate = this.failedRequests / Math.max(this.totalRequests, 1);
    }
    
    this.lastStatsUpdate = now;
    this.lastTotalRequests = this.totalRequests;
  }
}

/**
 * Advanced Load Balancer
 */
export class AdvancedLoadBalancer extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      algorithm: config.algorithm || Algorithm.WEIGHTED_ROUND_ROBIN,
      healthCheckInterval: config.healthCheckInterval || 5000,
      healthCheckTimeout: config.healthCheckTimeout || 2000,
      stickySession: config.stickySession || false,
      sessionTimeout: config.sessionTimeout || 3600000, // 1 hour
      maxRetries: config.maxRetries || 3
    };
    
    this.backends = new Map();
    this.currentIndex = 0;
    this.sessions = new Map(); // For sticky sessions
    this.healthCheckTimer = null;
    
    this.stats = {
      totalRequests: 0,
      totalFailures: 0,
      routingDecisions: {}
    };
  }
  
  /**
   * Add backend server
   */
  addBackend(config) {
    const backend = new Backend(config);
    this.backends.set(backend.id, backend);
    
    logger.info(`Added backend: ${backend.id} (${backend.host}:${backend.port})`);
    this.emit('backend:added', backend);
    
    return backend;
  }
  
  /**
   * Remove backend server
   */
  removeBackend(id) {
    const backend = this.backends.get(id);
    if (backend) {
      this.backends.delete(id);
      logger.info(`Removed backend: ${id}`);
      this.emit('backend:removed', backend);
    }
  }
  
  /**
   * Get next backend based on algorithm
   */
  getNextBackend(context = {}) {
    const availableBackends = Array.from(this.backends.values())
      .filter(b => b.canAcceptRequest());
    
    if (availableBackends.length === 0) {
      throw new Error('No available backends');
    }
    
    // Check sticky session
    if (this.config.stickySession && context.sessionId) {
      const sessionBackend = this.sessions.get(context.sessionId);
      if (sessionBackend && sessionBackend.canAcceptRequest()) {
        return sessionBackend;
      }
    }
    
    let selectedBackend;
    
    switch (this.config.algorithm) {
      case Algorithm.ROUND_ROBIN:
        selectedBackend = this.roundRobin(availableBackends);
        break;
        
      case Algorithm.WEIGHTED_ROUND_ROBIN:
        selectedBackend = this.weightedRoundRobin(availableBackends);
        break;
        
      case Algorithm.LEAST_CONNECTIONS:
        selectedBackend = this.leastConnections(availableBackends);
        break;
        
      case Algorithm.LEAST_RESPONSE_TIME:
        selectedBackend = this.leastResponseTime(availableBackends);
        break;
        
      case Algorithm.IP_HASH:
        selectedBackend = this.ipHash(availableBackends, context.clientIp);
        break;
        
      case Algorithm.RANDOM:
        selectedBackend = this.random(availableBackends);
        break;
        
      default:
        selectedBackend = this.roundRobin(availableBackends);
    }
    
    // Update sticky session
    if (this.config.stickySession && context.sessionId) {
      this.sessions.set(context.sessionId, selectedBackend);
      setTimeout(() => {
        this.sessions.delete(context.sessionId);
      }, this.config.sessionTimeout);
    }
    
    // Update stats
    this.stats.totalRequests++;
    if (!this.stats.routingDecisions[selectedBackend.id]) {
      this.stats.routingDecisions[selectedBackend.id] = 0;
    }
    this.stats.routingDecisions[selectedBackend.id]++;
    
    return selectedBackend;
  }
  
  /**
   * Round-robin selection
   */
  roundRobin(backends) {
    const backend = backends[this.currentIndex % backends.length];
    this.currentIndex++;
    return backend;
  }
  
  /**
   * Weighted round-robin selection
   */
  weightedRoundRobin(backends) {
    const totalWeight = backends.reduce((sum, b) => sum + b.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const backend of backends) {
      random -= backend.weight;
      if (random <= 0) {
        return backend;
      }
    }
    
    return backends[0];
  }
  
  /**
   * Least connections selection
   */
  leastConnections(backends) {
    return backends.reduce((min, backend) => 
      backend.connections < min.connections ? backend : min
    );
  }
  
  /**
   * Least response time selection
   */
  leastResponseTime(backends) {
    return backends.reduce((min, backend) => 
      backend.responseTime < min.responseTime ? backend : min
    );
  }
  
  /**
   * IP hash selection
   */
  ipHash(backends, clientIp) {
    if (!clientIp) return this.random(backends);
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < clientIp.length; i++) {
      hash = ((hash << 5) - hash) + clientIp.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    return backends[Math.abs(hash) % backends.length];
  }
  
  /**
   * Random selection
   */
  random(backends) {
    return backends[Math.floor(Math.random() * backends.length)];
  }
  
  /**
   * Route request with retries
   */
  async routeRequest(request, handler) {
    let lastError;
    let attempts = 0;
    
    while (attempts < this.config.maxRetries) {
      try {
        const backend = this.getNextBackend({
          clientIp: request.clientIp,
          sessionId: request.sessionId
        });
        
        backend.connections++;
        const startTime = Date.now();
        
        try {
          const result = await handler(backend, request);
          
          backend.connections--;
          backend.recordSuccess(Date.now() - startTime);
          
          return result;
          
        } catch (error) {
          backend.connections--;
          backend.recordFailure();
          
          throw error;
        }
        
      } catch (error) {
        lastError = error;
        attempts++;
        
        if (attempts < this.config.maxRetries) {
          logger.warn(`Request failed, retrying (${attempts}/${this.config.maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, 100 * attempts));
        }
      }
    }
    
    this.stats.totalFailures++;
    throw lastError || new Error('All retry attempts failed');
  }
  
  /**
   * Perform health check on backend
   */
  async healthCheckBackend(backend) {
    try {
      const startTime = Date.now();
      
      // Simple TCP health check - in production would be more sophisticated
      const healthy = await this.tcpHealthCheck(backend.host, backend.port);
      
      backend.healthy = healthy;
      backend.lastHealthCheck = Date.now();
      
      if (healthy) {
        backend.stats.uptime = 
          ((backend.stats.uptime * 99) + 100) / 100; // Moving average
      } else {
        backend.stats.uptime = 
          ((backend.stats.uptime * 99) + 0) / 100;
      }
      
      this.emit('health:check', { backend, healthy });
      
    } catch (error) {
      backend.healthy = false;
      logger.error(`Health check failed for ${backend.id}:`, error);
    }
  }
  
  /**
   * TCP health check
   */
  async tcpHealthCheck(host, port) {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, this.config.healthCheckTimeout);
      
      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });
      
      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
      
      socket.connect(port, host);
    });
  }
  
  /**
   * Start health checks
   */
  startHealthChecks() {
    this.healthCheckTimer = setInterval(() => {
      for (const backend of this.backends.values()) {
        this.healthCheckBackend(backend);
        backend.updateStats();
      }
    }, this.config.healthCheckInterval);
  }
  
  /**
   * Stop health checks
   */
  stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
  
  /**
   * Get load balancer statistics
   */
  getStats() {
    const backendStats = {};
    
    for (const [id, backend] of this.backends) {
      backendStats[id] = {
        healthy: backend.healthy,
        connections: backend.connections,
        totalRequests: backend.totalRequests,
        failedRequests: backend.failedRequests,
        avgResponseTime: backend.stats.avgResponseTime,
        errorRate: backend.stats.errorRate,
        uptime: backend.stats.uptime,
        circuitBreaker: backend.circuitBreaker.state
      };
    }
    
    return {
      algorithm: this.config.algorithm,
      totalRequests: this.stats.totalRequests,
      totalFailures: this.stats.totalFailures,
      backends: backendStats,
      routingDecisions: this.stats.routingDecisions
    };
  }
  
  /**
   * Drain backend (graceful removal)
   */
  async drainBackend(id) {
    const backend = this.backends.get(id);
    if (!backend) return;
    
    backend.healthy = false; // Stop new connections
    
    // Wait for existing connections to complete
    while (backend.connections > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    this.removeBackend(id);
  }
}

export default AdvancedLoadBalancer;
