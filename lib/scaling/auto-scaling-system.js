/**
 * Auto-Scaling and Load Balancing System
 * Dynamic resource management with intelligent scaling
 */

import { EventEmitter } from 'events';
import cluster from 'cluster';
import os from 'os';
import { getLogger } from '../core/logger.js';

const logger = getLogger('AutoScalingSystem');

/**
 * Auto-scaling orchestrator
 */
export class AutoScalingOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      minInstances: 1,
      maxInstances: os.cpus().length * 2,
      targetCPU: 70,
      targetMemory: 80,
      targetResponseTime: 200,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.3,
      cooldownPeriod: 60000, // 1 minute
      metricsWindow: 300000, // 5 minutes
      healthCheckInterval: 10000,
      ...options
    };
    
    this.instances = new Map();
    this.metrics = new Map();
    this.scalingHistory = [];
    this.lastScaleTime = 0;
    this.isScaling = false;
    
    if (cluster.isMaster) {
      this.initializeMaster();
    }
  }

  /**
   * Initialize master process
   */
  initializeMaster() {
    // Start with minimum instances
    for (let i = 0; i < this.options.minInstances; i++) {
      this.spawnWorker();
    }
    
    // Setup monitoring
    this.startMetricsCollection();
    this.startHealthChecks();
    this.startAutoScaling();
    
    // Handle worker events
    cluster.on('exit', (worker, code, signal) => {
      logger.error(`Worker ${worker.process.pid} died (${signal || code})`);
      this.handleWorkerExit(worker);
    });
    
    cluster.on('message', (worker, message) => {
      this.handleWorkerMessage(worker, message);
    });
  }

  /**
   * Spawn new worker
   */
  spawnWorker() {
    const worker = cluster.fork();
    
    const instance = {
      id: worker.id,
      pid: worker.process.pid,
      startTime: Date.now(),
      status: 'starting',
      metrics: {
        cpu: 0,
        memory: 0,
        requests: 0,
        responseTime: [],
        errors: 0
      }
    };
    
    this.instances.set(worker.id, instance);
    
    logger.info(`Spawned worker ${worker.process.pid}`);
    this.emit('spawn', instance);
    
    return worker;
  }

  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    setInterval(() => {
      this.collectMetrics();
    }, 5000); // Every 5 seconds
  }

  /**
   * Collect metrics from workers
   */
  async collectMetrics() {
    const metrics = {
      timestamp: Date.now(),
      cpu: 0,
      memory: 0,
      requests: 0,
      responseTime: 0,
      errors: 0,
      instances: this.instances.size
    };
    
    // Aggregate metrics from all instances
    for (const [id, instance] of this.instances) {
      if (instance.status === 'running') {
        metrics.cpu += instance.metrics.cpu;
        metrics.memory += instance.metrics.memory;
        metrics.requests += instance.metrics.requests;
        metrics.errors += instance.metrics.errors;
        
        if (instance.metrics.responseTime.length > 0) {
          const avgResponseTime = instance.metrics.responseTime.reduce((a, b) => a + b, 0) / 
                                 instance.metrics.responseTime.length;
          metrics.responseTime += avgResponseTime;
        }
      }
    }
    
    // Calculate averages
    const runningInstances = Array.from(this.instances.values())
      .filter(i => i.status === 'running').length;
    
    if (runningInstances > 0) {
      metrics.cpu /= runningInstances;
      metrics.memory /= runningInstances;
      metrics.responseTime /= runningInstances;
    }
    
    // Store metrics
    this.metrics.set(metrics.timestamp, metrics);
    
    // Clean old metrics
    const cutoff = Date.now() - this.options.metricsWindow;
    for (const [timestamp] of this.metrics) {
      if (timestamp < cutoff) {
        this.metrics.delete(timestamp);
      }
    }
    
    this.emit('metrics', metrics);
  }

  /**
   * Start health checks
   */
  startHealthChecks() {
    setInterval(() => {
      this.checkHealth();
    }, this.options.healthCheckInterval);
  }

  /**
   * Check health of all instances
   */
  async checkHealth() {
    for (const [id, instance] of this.instances) {
      const worker = cluster.workers[id];
      
      if (!worker || worker.isDead()) {
        instance.status = 'dead';
        continue;
      }
      
      // Send health check ping
      worker.send({ type: 'health-check' });
      
      // Set timeout for response
      const timeout = setTimeout(() => {
        instance.status = 'unhealthy';
        logger.warn(`Worker ${instance.pid} is unhealthy`);
      }, 5000);
      
      // Store timeout to clear later
      instance.healthCheckTimeout = timeout;
    }
  }

  /**
   * Start auto-scaling logic
   */
  startAutoScaling() {
    setInterval(() => {
      this.evaluateScaling();
    }, 30000); // Every 30 seconds
  }

  /**
   * Evaluate if scaling is needed
   */
  async evaluateScaling() {
    if (this.isScaling || this.isInCooldown()) {
      return;
    }
    
    const decision = this.makeScalingDecision();
    
    if (decision.action === 'scale-up') {
      await this.scaleUp(decision.count);
    } else if (decision.action === 'scale-down') {
      await this.scaleDown(decision.count);
    }
  }

  /**
   * Make scaling decision based on metrics
   */
  makeScalingDecision() {
    const recentMetrics = this.getRecentMetrics();
    
    if (recentMetrics.length === 0) {
      return { action: 'none' };
    }
    
    // Calculate average metrics
    const avgMetrics = this.calculateAverageMetrics(recentMetrics);
    
    // Calculate scaling score
    const cpuScore = avgMetrics.cpu / this.options.targetCPU;
    const memoryScore = avgMetrics.memory / this.options.targetMemory;
    const responseTimeScore = avgMetrics.responseTime / this.options.targetResponseTime;
    
    const scalingScore = Math.max(cpuScore, memoryScore, responseTimeScore);
    
    const currentInstances = this.getRunningInstances().length;
    
    // Scale up decision
    if (scalingScore > this.options.scaleUpThreshold) {
      const targetInstances = Math.ceil(currentInstances * scalingScore);
      const maxAllowed = Math.min(targetInstances, this.options.maxInstances);
      const toSpawn = maxAllowed - currentInstances;
      
      if (toSpawn > 0) {
        return {
          action: 'scale-up',
          count: toSpawn,
          reason: `High load: CPU ${avgMetrics.cpu.toFixed(1)}%, Memory ${avgMetrics.memory.toFixed(1)}%, Response time ${avgMetrics.responseTime.toFixed(0)}ms`
        };
      }
    }
    
    // Scale down decision
    if (scalingScore < this.options.scaleDownThreshold) {
      const targetInstances = Math.floor(currentInstances * scalingScore) || 1;
      const minAllowed = Math.max(targetInstances, this.options.minInstances);
      const toKill = currentInstances - minAllowed;
      
      if (toKill > 0) {
        return {
          action: 'scale-down',
          count: toKill,
          reason: `Low load: CPU ${avgMetrics.cpu.toFixed(1)}%, Memory ${avgMetrics.memory.toFixed(1)}%, Response time ${avgMetrics.responseTime.toFixed(0)}ms`
        };
      }
    }
    
    return { action: 'none' };
  }

  /**
   * Scale up
   */
  async scaleUp(count) {
    this.isScaling = true;
    
    logger.info(`Scaling up by ${count} instances`);
    
    const newWorkers = [];
    for (let i = 0; i < count; i++) {
      newWorkers.push(this.spawnWorker());
    }
    
    // Wait for workers to be ready
    await this.waitForWorkersReady(newWorkers);
    
    this.lastScaleTime = Date.now();
    this.scalingHistory.push({
      timestamp: Date.now(),
      action: 'scale-up',
      count,
      instances: this.instances.size
    });
    
    this.isScaling = false;
    this.emit('scaled', { action: 'up', count });
  }

  /**
   * Scale down
   */
  async scaleDown(count) {
    this.isScaling = true;
    
    logger.info(`Scaling down by ${count} instances`);
    
    // Select workers to terminate (oldest first)
    const workers = this.getRunningInstances()
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, count);
    
    // Gracefully shutdown workers
    for (const instance of workers) {
      const worker = cluster.workers[instance.id];
      if (worker) {
        worker.send({ type: 'shutdown' });
        
        // Give worker time to cleanup
        setTimeout(() => {
          if (!worker.isDead()) {
            worker.kill();
          }
        }, 30000); // 30 seconds grace period
      }
    }
    
    this.lastScaleTime = Date.now();
    this.scalingHistory.push({
      timestamp: Date.now(),
      action: 'scale-down',
      count,
      instances: this.instances.size - count
    });
    
    this.isScaling = false;
    this.emit('scaled', { action: 'down', count });
  }

  /**
   * Wait for workers to be ready
   */
  async waitForWorkersReady(workers) {
    return new Promise((resolve) => {
      let readyCount = 0;
      const checkReady = () => {
        readyCount = workers.filter(w => {
          const instance = this.instances.get(w.id);
          return instance && instance.status === 'running';
        }).length;
        
        if (readyCount === workers.length) {
          resolve();
        } else {
          setTimeout(checkReady, 1000);
        }
      };
      
      checkReady();
    });
  }

  /**
   * Handle worker exit
   */
  handleWorkerExit(worker) {
    const instance = this.instances.get(worker.id);
    
    if (instance) {
      instance.status = 'dead';
      this.instances.delete(worker.id);
      
      // Respawn if below minimum
      if (this.getRunningInstances().length < this.options.minInstances) {
        this.spawnWorker();
      }
    }
  }

  /**
   * Handle worker message
   */
  handleWorkerMessage(worker, message) {
    const instance = this.instances.get(worker.id);
    if (!instance) return;
    
    switch (message.type) {
      case 'ready':
        instance.status = 'running';
        logger.info(`Worker ${instance.pid} is ready`);
        break;
        
      case 'metrics':
        Object.assign(instance.metrics, message.data);
        break;
        
      case 'health-check-response':
        if (instance.healthCheckTimeout) {
          clearTimeout(instance.healthCheckTimeout);
          instance.healthCheckTimeout = null;
        }
        instance.status = 'running';
        instance.lastHealthCheck = Date.now();
        break;
    }
  }

  /**
   * Get recent metrics
   */
  getRecentMetrics() {
    const cutoff = Date.now() - 60000; // Last minute
    return Array.from(this.metrics.values())
      .filter(m => m.timestamp > cutoff);
  }

  /**
   * Calculate average metrics
   */
  calculateAverageMetrics(metrics) {
    const sum = metrics.reduce((acc, m) => ({
      cpu: acc.cpu + m.cpu,
      memory: acc.memory + m.memory,
      responseTime: acc.responseTime + m.responseTime,
      requests: acc.requests + m.requests,
      errors: acc.errors + m.errors
    }), { cpu: 0, memory: 0, responseTime: 0, requests: 0, errors: 0 });
    
    return {
      cpu: sum.cpu / metrics.length,
      memory: sum.memory / metrics.length,
      responseTime: sum.responseTime / metrics.length,
      requests: sum.requests / metrics.length,
      errors: sum.errors / metrics.length
    };
  }

  /**
   * Get running instances
   */
  getRunningInstances() {
    return Array.from(this.instances.values())
      .filter(i => i.status === 'running');
  }

  /**
   * Check if in cooldown
   */
  isInCooldown() {
    return Date.now() - this.lastScaleTime < this.options.cooldownPeriod;
  }

  /**
   * Get scaling status
   */
  getStatus() {
    return {
      instances: {
        total: this.instances.size,
        running: this.getRunningInstances().length,
        min: this.options.minInstances,
        max: this.options.maxInstances
      },
      metrics: this.getRecentMetrics(),
      isScaling: this.isScaling,
      inCooldown: this.isInCooldown(),
      history: this.scalingHistory.slice(-10)
    };
  }
}

/**
 * Load balancer with multiple algorithms
 */
export class LoadBalancer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      algorithm: 'round-robin', // round-robin, least-connections, weighted, ip-hash
      healthCheckInterval: 5000,
      healthCheckTimeout: 3000,
      maxRetries: 3,
      stickySession: false,
      sessionTimeout: 3600000, // 1 hour
      ...options
    };
    
    this.backends = new Map();
    this.currentIndex = 0;
    this.sessions = new Map();
    
    this.startHealthChecks();
    this.startSessionCleanup();
  }

  /**
   * Add backend server
   */
  addBackend(id, config) {
    const backend = {
      id,
      host: config.host,
      port: config.port,
      weight: config.weight || 1,
      maxConnections: config.maxConnections || 1000,
      connections: 0,
      healthy: true,
      lastHealthCheck: Date.now(),
      responseTime: [],
      requestCount: 0,
      errorCount: 0
    };
    
    this.backends.set(id, backend);
    
    logger.info(`Added backend ${id} (${config.host}:${config.port})`);
    this.emit('backend-added', backend);
  }

  /**
   * Remove backend server
   */
  removeBackend(id) {
    const backend = this.backends.get(id);
    if (backend) {
      this.backends.delete(id);
      logger.info(`Removed backend ${id}`);
      this.emit('backend-removed', backend);
    }
  }

  /**
   * Get next backend based on algorithm
   */
  getNextBackend(context = {}) {
    const healthyBackends = this.getHealthyBackends();
    
    if (healthyBackends.length === 0) {
      throw new Error('No healthy backends available');
    }
    
    // Check sticky session
    if (this.options.stickySession && context.sessionId) {
      const sessionBackend = this.sessions.get(context.sessionId);
      if (sessionBackend && this.backends.get(sessionBackend)?.healthy) {
        return this.backends.get(sessionBackend);
      }
    }
    
    let selected;
    
    switch (this.options.algorithm) {
      case 'round-robin':
        selected = this.roundRobin(healthyBackends);
        break;
        
      case 'least-connections':
        selected = this.leastConnections(healthyBackends);
        break;
        
      case 'weighted':
        selected = this.weighted(healthyBackends);
        break;
        
      case 'ip-hash':
        selected = this.ipHash(healthyBackends, context.ip);
        break;
        
      case 'response-time':
        selected = this.responseTime(healthyBackends);
        break;
        
      default:
        selected = this.roundRobin(healthyBackends);
    }
    
    // Update sticky session
    if (this.options.stickySession && context.sessionId) {
      this.sessions.set(context.sessionId, selected.id);
    }
    
    // Update connection count
    selected.connections++;
    
    return selected;
  }

  /**
   * Round-robin algorithm
   */
  roundRobin(backends) {
    const selected = backends[this.currentIndex % backends.length];
    this.currentIndex++;
    return selected;
  }

  /**
   * Least connections algorithm
   */
  leastConnections(backends) {
    return backends.reduce((min, backend) => 
      backend.connections < min.connections ? backend : min
    );
  }

  /**
   * Weighted round-robin algorithm
   */
  weighted(backends) {
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
   * IP hash algorithm
   */
  ipHash(backends, ip) {
    if (!ip) return this.roundRobin(backends);
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < ip.length; i++) {
      hash = ((hash << 5) - hash) + ip.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    
    const index = Math.abs(hash) % backends.length;
    return backends[index];
  }

  /**
   * Response time based algorithm
   */
  responseTime(backends) {
    // Select backend with lowest average response time
    return backends.reduce((best, backend) => {
      const avgResponseTime = backend.responseTime.length > 0
        ? backend.responseTime.reduce((a, b) => a + b, 0) / backend.responseTime.length
        : 0;
      
      const bestAvgResponseTime = best.responseTime.length > 0
        ? best.responseTime.reduce((a, b) => a + b, 0) / best.responseTime.length
        : 0;
      
      return avgResponseTime < bestAvgResponseTime ? backend : best;
    });
  }

  /**
   * Release connection
   */
  releaseConnection(backendId, responseTime) {
    const backend = this.backends.get(backendId);
    if (backend) {
      backend.connections = Math.max(0, backend.connections - 1);
      backend.requestCount++;
      
      if (responseTime) {
        backend.responseTime.push(responseTime);
        if (backend.responseTime.length > 100) {
          backend.responseTime.shift();
        }
      }
    }
  }

  /**
   * Report error
   */
  reportError(backendId) {
    const backend = this.backends.get(backendId);
    if (backend) {
      backend.errorCount++;
      
      // Mark unhealthy if too many errors
      if (backend.errorCount > 10) {
        backend.healthy = false;
        logger.warn(`Backend ${backendId} marked unhealthy due to errors`);
      }
    }
  }

  /**
   * Start health checks
   */
  startHealthChecks() {
    setInterval(() => {
      this.performHealthChecks();
    }, this.options.healthCheckInterval);
  }

  /**
   * Perform health checks
   */
  async performHealthChecks() {
    const checks = [];
    
    for (const [id, backend] of this.backends) {
      checks.push(this.checkBackendHealth(backend));
    }
    
    await Promise.all(checks);
  }

  /**
   * Check backend health
   */
  async checkBackendHealth(backend) {
    try {
      const start = Date.now();
      
      // Simulate health check (in production, make actual HTTP request)
      const response = await this.makeHealthCheckRequest(backend);
      
      const responseTime = Date.now() - start;
      
      backend.healthy = response.status === 200;
      backend.lastHealthCheck = Date.now();
      backend.responseTime.push(responseTime);
      
      if (backend.responseTime.length > 100) {
        backend.responseTime.shift();
      }
      
      if (!backend.healthy) {
        logger.warn(`Backend ${backend.id} health check failed`);
      }
      
    } catch (error) {
      backend.healthy = false;
      backend.lastHealthCheck = Date.now();
      logger.error(`Backend ${backend.id} health check error:`, error);
    }
  }

  /**
   * Make health check request
   */
  async makeHealthCheckRequest(backend) {
    // In production, use actual HTTP client
    return new Promise((resolve) => {
      setTimeout(() => {
        // Simulate random health
        resolve({ status: Math.random() > 0.1 ? 200 : 503 });
      }, Math.random() * 100);
    });
  }

  /**
   * Start session cleanup
   */
  startSessionCleanup() {
    if (!this.options.stickySession) return;
    
    setInterval(() => {
      const now = Date.now();
      const timeout = this.options.sessionTimeout;
      
      for (const [sessionId, timestamp] of this.sessions) {
        if (now - timestamp > timeout) {
          this.sessions.delete(sessionId);
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Get healthy backends
   */
  getHealthyBackends() {
    return Array.from(this.backends.values())
      .filter(b => b.healthy && b.connections < b.maxConnections);
  }

  /**
   * Get load balancer status
   */
  getStatus() {
    const backends = Array.from(this.backends.values()).map(b => ({
      id: b.id,
      host: b.host,
      port: b.port,
      healthy: b.healthy,
      connections: b.connections,
      requestCount: b.requestCount,
      errorCount: b.errorCount,
      avgResponseTime: b.responseTime.length > 0
        ? b.responseTime.reduce((a, b) => a + b, 0) / b.responseTime.length
        : 0
    }));
    
    return {
      algorithm: this.options.algorithm,
      backends,
      totalBackends: this.backends.size,
      healthyBackends: this.getHealthyBackends().length,
      activeSessions: this.sessions.size
    };
  }
}

/**
 * Service mesh for microservices
 */
export class ServiceMesh extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      discovery: 'consul', // consul, etcd, kubernetes
      circuitBreaker: {
        threshold: 5,
        timeout: 60000,
        resetTimeout: 30000
      },
      retry: {
        maxAttempts: 3,
        backoff: 'exponential'
      },
      timeout: 30000,
      ...options
    };
    
    this.services = new Map();
    this.circuits = new Map();
    
    this.initializeDiscovery();
  }

  /**
   * Initialize service discovery
   */
  initializeDiscovery() {
    // In production, connect to actual service discovery
    setInterval(() => {
      this.discoverServices();
    }, 10000); // Every 10 seconds
  }

  /**
   * Discover services
   */
  async discoverServices() {
    // Simulate service discovery
    const discovered = [
      { name: 'auth', instances: [{ host: 'localhost', port: 3001 }] },
      { name: 'trading', instances: [{ host: 'localhost', port: 3002 }] },
      { name: 'mining', instances: [{ host: 'localhost', port: 3003 }] }
    ];
    
    for (const service of discovered) {
      this.updateService(service.name, service.instances);
    }
  }

  /**
   * Update service instances
   */
  updateService(name, instances) {
    if (!this.services.has(name)) {
      this.services.set(name, {
        name,
        instances: [],
        loadBalancer: new LoadBalancer({ algorithm: 'round-robin' })
      });
    }
    
    const service = this.services.get(name);
    
    // Update load balancer
    for (const instance of instances) {
      const id = `${instance.host}:${instance.port}`;
      service.loadBalancer.addBackend(id, instance);
    }
    
    service.instances = instances;
    
    this.emit('service-updated', { name, instances });
  }

  /**
   * Call service with circuit breaker and retry
   */
  async call(serviceName, request) {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service ${serviceName} not found`);
    }
    
    // Check circuit breaker
    const circuit = this.getCircuitBreaker(serviceName);
    if (circuit.isOpen()) {
      throw new Error(`Circuit breaker open for ${serviceName}`);
    }
    
    let lastError;
    const { maxAttempts, backoff } = this.options.retry;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Get backend
        const backend = service.loadBalancer.getNextBackend();
        
        // Make request
        const response = await this.makeRequest(backend, request);
        
        // Success - close circuit
        circuit.recordSuccess();
        
        // Release connection
        service.loadBalancer.releaseConnection(backend.id, response.time);
        
        return response;
        
      } catch (error) {
        lastError = error;
        circuit.recordFailure();
        
        // Calculate backoff
        const delay = backoff === 'exponential'
          ? Math.pow(2, attempt) * 1000
          : 1000;
        
        if (attempt < maxAttempts - 1) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Make request to backend
   */
  async makeRequest(backend, request) {
    // In production, use actual HTTP client
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, this.options.timeout);
      
      // Simulate request
      setTimeout(() => {
        clearTimeout(timeout);
        
        if (Math.random() > 0.9) {
          reject(new Error('Service error'));
        } else {
          resolve({
            data: { result: 'success' },
            time: Math.random() * 100
          });
        }
      }, Math.random() * 200);
    });
  }

  /**
   * Get circuit breaker for service
   */
  getCircuitBreaker(serviceName) {
    if (!this.circuits.has(serviceName)) {
      this.circuits.set(serviceName, new CircuitBreaker(this.options.circuitBreaker));
    }
    
    return this.circuits.get(serviceName);
  }

  /**
   * Get mesh status
   */
  getStatus() {
    const services = {};
    
    for (const [name, service] of this.services) {
      services[name] = {
        instances: service.instances.length,
        healthy: service.loadBalancer.getHealthyBackends().length,
        circuit: this.circuits.has(name) ? this.circuits.get(name).getState() : 'closed'
      };
    }
    
    return {
      services,
      totalServices: this.services.size,
      circuits: {
        open: Array.from(this.circuits.values()).filter(c => c.isOpen()).length,
        halfOpen: Array.from(this.circuits.values()).filter(c => c.isHalfOpen()).length,
        closed: Array.from(this.circuits.values()).filter(c => c.isClosed()).length
      }
    };
  }
}

/**
 * Circuit breaker implementation
 */
class CircuitBreaker {
  constructor(options) {
    this.options = options;
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
  }

  isOpen() {
    return this.state === 'open' && Date.now() < this.nextAttempt;
  }

  isHalfOpen() {
    return this.state === 'open' && Date.now() >= this.nextAttempt;
  }

  isClosed() {
    return this.state === 'closed';
  }

  recordSuccess() {
    this.failures = 0;
    this.successes++;
    
    if (this.state === 'open') {
      this.state = 'closed';
    }
  }

  recordFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.options.threshold) {
      this.state = 'open';
      this.nextAttempt = Date.now() + this.options.resetTimeout;
    }
  }

  getState() {
    if (this.isHalfOpen()) return 'half-open';
    return this.state;
  }
}

export default {
  AutoScalingOrchestrator,
  LoadBalancer,
  ServiceMesh
};