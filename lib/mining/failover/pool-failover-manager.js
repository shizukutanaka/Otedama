/**
 * Mining Pool Failover and Load Balancing Manager
 * Ensures high availability and optimal performance
 */

import { EventEmitter } from 'events';
import net from 'net';
import dns from 'dns/promises';
import { logger } from '../../core/logger.js';

/**
 * Pool health states
 */
export const PoolHealth = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  DEAD: 'dead',
  UNKNOWN: 'unknown'
};

/**
 * Load balancing strategies
 */
export const LoadBalancingStrategy = {
  ROUND_ROBIN: 'round_robin',
  LEAST_CONNECTIONS: 'least_connections',
  WEIGHTED: 'weighted',
  LATENCY_BASED: 'latency_based',
  GEOGRAPHIC: 'geographic',
  PERFORMANCE_BASED: 'performance_based'
};

/**
 * Pool configuration
 */
export class PoolConfig {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.url = data.url;
    this.port = data.port;
    this.protocol = data.protocol || 'stratum+tcp';
    this.region = data.region;
    this.priority = data.priority || 1;
    this.weight = data.weight || 1;
    this.maxConnections = data.maxConnections || 1000;
    
    // Authentication
    this.username = data.username;
    this.password = data.password;
    
    // Features
    this.features = {
      vardiff: data.features?.vardiff || true,
      extranonce: data.features?.extranonce || true,
      stratumv2: data.features?.stratumv2 || false,
      ...data.features
    };
    
    // Health check config
    this.healthCheck = {
      interval: data.healthCheck?.interval || 30000,
      timeout: data.healthCheck?.timeout || 5000,
      retries: data.healthCheck?.retries || 3,
      ...data.healthCheck
    };
    
    // Current state
    this.health = PoolHealth.UNKNOWN;
    this.connections = 0;
    this.lastCheck = 0;
    this.consecutiveFailures = 0;
    this.metrics = {
      latency: 0,
      uptime: 0,
      successRate: 0,
      sharesAccepted: 0,
      sharesRejected: 0
    };
  }
  
  /**
   * Get pool score for ranking
   */
  getScore() {
    let score = this.priority * 100;
    
    // Health factor
    switch (this.health) {
      case PoolHealth.HEALTHY:
        score += 50;
        break;
      case PoolHealth.DEGRADED:
        score += 25;
        break;
      case PoolHealth.UNHEALTHY:
        score += 10;
        break;
      case PoolHealth.DEAD:
        score = 0;
        break;
    }
    
    // Performance factors
    score += (1 - this.metrics.latency / 1000) * 20; // Lower latency is better
    score += this.metrics.successRate * 30;
    score += this.metrics.uptime * 20;
    
    // Load factor
    const loadFactor = 1 - (this.connections / this.maxConnections);
    score += loadFactor * 10;
    
    return score * this.weight;
  }
}

/**
 * Pool health monitor
 */
export class PoolHealthMonitor {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.options = options;
    this.checkInterval = null;
    this.isRunning = false;
  }
  
  /**
   * Start monitoring
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.performHealthCheck();
    
    this.checkInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.pool.healthCheck.interval);
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    this.isRunning = false;
    
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
  
  /**
   * Perform health check
   */
  async performHealthCheck() {
    const startTime = Date.now();
    
    try {
      // DNS resolution check
      await this.checkDNS();
      
      // TCP connectivity check
      const connected = await this.checkConnectivity();
      if (!connected) {
        throw new Error('Connection failed');
      }
      
      // Stratum protocol check
      const stratumOk = await this.checkStratumProtocol();
      if (!stratumOk) {
        throw new Error('Stratum protocol check failed');
      }
      
      // Calculate latency
      const latency = Date.now() - startTime;
      this.pool.metrics.latency = latency;
      
      // Update health status
      if (latency < 100) {
        this.pool.health = PoolHealth.HEALTHY;
      } else if (latency < 500) {
        this.pool.health = PoolHealth.DEGRADED;
      } else {
        this.pool.health = PoolHealth.UNHEALTHY;
      }
      
      // Reset failure counter
      this.pool.consecutiveFailures = 0;
      this.pool.lastCheck = Date.now();
      
      // Update uptime
      this.updateUptime(true);
      
    } catch (error) {
      logger.warn(`Health check failed for pool ${this.pool.name}: ${error.message}`);
      
      this.pool.consecutiveFailures++;
      
      if (this.pool.consecutiveFailures >= this.pool.healthCheck.retries) {
        this.pool.health = PoolHealth.DEAD;
      } else {
        this.pool.health = PoolHealth.UNHEALTHY;
      }
      
      this.updateUptime(false);
    }
  }
  
  /**
   * Check DNS resolution
   */
  async checkDNS() {
    const hostname = new URL(this.pool.url).hostname;
    await dns.resolve4(hostname);
  }
  
  /**
   * Check TCP connectivity
   */
  checkConnectivity() {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, this.pool.healthCheck.timeout);
      
      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });
      
      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
      
      const hostname = new URL(this.pool.url).hostname;
      socket.connect(this.pool.port, hostname);
    });
  }
  
  /**
   * Check Stratum protocol
   */
  async checkStratumProtocol() {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let dataReceived = false;
      
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(dataReceived);
      }, this.pool.healthCheck.timeout);
      
      socket.on('connect', () => {
        // Send mining.subscribe
        const subscribe = JSON.stringify({
          id: 1,
          method: 'mining.subscribe',
          params: ['Otedama/1.0.0']
        }) + '\n';
        
        socket.write(subscribe);
      });
      
      socket.on('data', (data) => {
        dataReceived = true;
        clearTimeout(timeout);
        socket.destroy();
        
        try {
          const response = JSON.parse(data.toString());
          resolve(response.error === null);
        } catch (e) {
          resolve(false);
        }
      });
      
      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
      
      const hostname = new URL(this.pool.url).hostname;
      socket.connect(this.pool.port, hostname);
    });
  }
  
  /**
   * Update uptime metric
   */
  updateUptime(success) {
    // Simple exponential moving average
    const alpha = 0.1;
    const value = success ? 1 : 0;
    this.pool.metrics.uptime = alpha * value + (1 - alpha) * this.pool.metrics.uptime;
  }
}

/**
 * Pool failover and load balancing manager
 */
export class PoolFailoverManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      strategy: options.strategy || LoadBalancingStrategy.PERFORMANCE_BASED,
      maxPools: options.maxPools || 10,
      checkInterval: options.checkInterval || 30000,
      failoverThreshold: options.failoverThreshold || 3,
      returnThreshold: options.returnThreshold || 5,
      geoLocation: options.geoLocation || null,
      ...options
    };
    
    this.pools = new Map();
    this.monitors = new Map();
    this.activePools = new Set();
    this.primaryPool = null;
    this.currentPool = null;
    
    // Load balancing state
    this.roundRobinIndex = 0;
    this.connectionCounts = new Map();
    
    // Statistics
    this.stats = {
      failovers: 0,
      poolSwitches: 0,
      totalConnections: 0,
      successfulConnections: 0
    };
    
    this.isRunning = false;
  }
  
  /**
   * Add pool to manager
   */
  addPool(poolData) {
    const pool = new PoolConfig(poolData);
    this.pools.set(pool.id, pool);
    
    // Create health monitor
    const monitor = new PoolHealthMonitor(pool);
    this.monitors.set(pool.id, monitor);
    
    // Set primary pool if first or higher priority
    if (!this.primaryPool || pool.priority > this.primaryPool.priority) {
      this.primaryPool = pool;
    }
    
    logger.info(`Added pool: ${pool.name} (${pool.url}:${pool.port})`);
    
    this.emit('pool:added', pool);
  }
  
  /**
   * Remove pool
   */
  removePool(poolId) {
    const pool = this.pools.get(poolId);
    if (!pool) return;
    
    // Stop monitor
    const monitor = this.monitors.get(poolId);
    if (monitor) {
      monitor.stop();
      this.monitors.delete(poolId);
    }
    
    // Remove from active pools
    this.activePools.delete(poolId);
    
    // Remove pool
    this.pools.delete(poolId);
    
    // Update primary if needed
    if (this.primaryPool?.id === poolId) {
      this.selectNewPrimary();
    }
    
    logger.info(`Removed pool: ${pool.name}`);
    
    this.emit('pool:removed', pool);
  }
  
  /**
   * Start failover manager
   */
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    logger.info('Starting pool failover manager');
    
    // Start all monitors
    for (const monitor of this.monitors.values()) {
      monitor.start();
    }
    
    // Wait for initial health checks
    await this.waitForInitialChecks();
    
    // Select initial pool
    this.selectBestPool();
    
    // Start periodic rebalancing
    this.rebalanceInterval = setInterval(() => {
      this.rebalance();
    }, this.options.checkInterval);
    
    this.emit('started');
  }
  
  /**
   * Wait for initial health checks
   */
  async waitForInitialChecks() {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Update active pools
    this.updateActivePools();
  }
  
  /**
   * Update active pools based on health
   */
  updateActivePools() {
    this.activePools.clear();
    
    for (const [id, pool] of this.pools) {
      if (pool.health !== PoolHealth.DEAD) {
        this.activePools.add(id);
      }
    }
  }
  
  /**
   * Select best pool based on strategy
   */
  selectBestPool() {
    this.updateActivePools();
    
    if (this.activePools.size === 0) {
      logger.error('No active pools available');
      this.currentPool = null;
      return null;
    }
    
    let selectedPool;
    
    switch (this.options.strategy) {
      case LoadBalancingStrategy.ROUND_ROBIN:
        selectedPool = this.selectRoundRobin();
        break;
        
      case LoadBalancingStrategy.LEAST_CONNECTIONS:
        selectedPool = this.selectLeastConnections();
        break;
        
      case LoadBalancingStrategy.WEIGHTED:
        selectedPool = this.selectWeighted();
        break;
        
      case LoadBalancingStrategy.LATENCY_BASED:
        selectedPool = this.selectByLatency();
        break;
        
      case LoadBalancingStrategy.GEOGRAPHIC:
        selectedPool = this.selectGeographic();
        break;
        
      case LoadBalancingStrategy.PERFORMANCE_BASED:
        selectedPool = this.selectByPerformance();
        break;
        
      default:
        selectedPool = this.selectByPerformance();
    }
    
    if (selectedPool && selectedPool !== this.currentPool) {
      const oldPool = this.currentPool;
      this.currentPool = selectedPool;
      
      if (oldPool) {
        this.stats.poolSwitches++;
        logger.info(`Switched pool: ${oldPool.name} -> ${selectedPool.name}`);
      } else {
        logger.info(`Selected pool: ${selectedPool.name}`);
      }
      
      this.emit('pool:switched', {
        from: oldPool,
        to: selectedPool,
        reason: 'selection'
      });
    }
    
    return selectedPool;
  }
  
  /**
   * Round-robin selection
   */
  selectRoundRobin() {
    const activePools = Array.from(this.activePools).map(id => this.pools.get(id));
    
    if (activePools.length === 0) return null;
    
    const pool = activePools[this.roundRobinIndex % activePools.length];
    this.roundRobinIndex++;
    
    return pool;
  }
  
  /**
   * Least connections selection
   */
  selectLeastConnections() {
    let selectedPool = null;
    let minConnections = Infinity;
    
    for (const poolId of this.activePools) {
      const pool = this.pools.get(poolId);
      if (pool.connections < minConnections) {
        minConnections = pool.connections;
        selectedPool = pool;
      }
    }
    
    return selectedPool;
  }
  
  /**
   * Weighted selection
   */
  selectWeighted() {
    const activePools = Array.from(this.activePools).map(id => this.pools.get(id));
    
    // Calculate total weight
    const totalWeight = activePools.reduce((sum, pool) => sum + pool.weight, 0);
    
    // Random weighted selection
    let random = Math.random() * totalWeight;
    
    for (const pool of activePools) {
      random -= pool.weight;
      if (random <= 0) {
        return pool;
      }
    }
    
    return activePools[0];
  }
  
  /**
   * Latency-based selection
   */
  selectByLatency() {
    let selectedPool = null;
    let minLatency = Infinity;
    
    for (const poolId of this.activePools) {
      const pool = this.pools.get(poolId);
      if (pool.metrics.latency < minLatency) {
        minLatency = pool.metrics.latency;
        selectedPool = pool;
      }
    }
    
    return selectedPool;
  }
  
  /**
   * Geographic selection
   */
  selectGeographic() {
    if (!this.options.geoLocation) {
      return this.selectByPerformance();
    }
    
    // Find pools in same region
    const regionalPools = [];
    
    for (const poolId of this.activePools) {
      const pool = this.pools.get(poolId);
      if (pool.region === this.options.geoLocation.region) {
        regionalPools.push(pool);
      }
    }
    
    // If regional pools exist, select best one
    if (regionalPools.length > 0) {
      return regionalPools.reduce((best, pool) => {
        return pool.getScore() > best.getScore() ? pool : best;
      });
    }
    
    // Fallback to performance-based
    return this.selectByPerformance();
  }
  
  /**
   * Performance-based selection
   */
  selectByPerformance() {
    let selectedPool = null;
    let maxScore = -Infinity;
    
    for (const poolId of this.activePools) {
      const pool = this.pools.get(poolId);
      const score = pool.getScore();
      
      if (score > maxScore) {
        maxScore = score;
        selectedPool = pool;
      }
    }
    
    return selectedPool;
  }
  
  /**
   * Trigger failover
   */
  triggerFailover(reason) {
    logger.warn(`Triggering failover: ${reason}`);
    
    this.stats.failovers++;
    
    // Mark current pool as unhealthy
    if (this.currentPool) {
      this.currentPool.health = PoolHealth.UNHEALTHY;
      this.currentPool.consecutiveFailures++;
    }
    
    // Select new pool
    const newPool = this.selectBestPool();
    
    if (!newPool) {
      logger.error('Failover failed: No available pools');
      this.emit('failover:failed', { reason: 'no_pools_available' });
      return null;
    }
    
    this.emit('failover:triggered', {
      from: this.currentPool,
      to: newPool,
      reason
    });
    
    return newPool;
  }
  
  /**
   * Rebalance connections
   */
  rebalance() {
    // Check if primary pool has recovered
    if (this.primaryPool && 
        this.primaryPool !== this.currentPool &&
        this.primaryPool.health === PoolHealth.HEALTHY) {
      
      const primaryScore = this.primaryPool.getScore();
      const currentScore = this.currentPool?.getScore() || 0;
      
      // Switch back if primary is significantly better
      if (primaryScore > currentScore * 1.2) {
        logger.info('Switching back to primary pool');
        this.currentPool = this.primaryPool;
        
        this.emit('pool:switched', {
          from: this.currentPool,
          to: this.primaryPool,
          reason: 'primary_recovered'
        });
      }
    }
    
    // Check if better pool is available
    const bestPool = this.selectBestPool();
    
    if (bestPool && bestPool !== this.currentPool) {
      const currentScore = this.currentPool?.getScore() || 0;
      const bestScore = bestPool.getScore();
      
      // Switch if significantly better
      if (bestScore > currentScore * 1.5) {
        logger.info(`Rebalancing to better pool: ${bestPool.name}`);
      }
    }
  }
  
  /**
   * Get connection for mining
   */
  getConnection() {
    if (!this.currentPool) {
      this.selectBestPool();
    }
    
    if (!this.currentPool || this.currentPool.health === PoolHealth.DEAD) {
      const newPool = this.triggerFailover('current_pool_dead');
      if (!newPool) {
        throw new Error('No available pools');
      }
    }
    
    // Update connection count
    this.currentPool.connections++;
    this.stats.totalConnections++;
    
    return {
      pool: this.currentPool,
      url: this.currentPool.url,
      port: this.currentPool.port,
      auth: {
        username: this.currentPool.username,
        password: this.currentPool.password
      }
    };
  }
  
  /**
   * Release connection
   */
  releaseConnection(poolId) {
    const pool = this.pools.get(poolId);
    if (pool && pool.connections > 0) {
      pool.connections--;
    }
  }
  
  /**
   * Report connection success
   */
  reportSuccess(poolId) {
    const pool = this.pools.get(poolId);
    if (pool) {
      this.stats.successfulConnections++;
      pool.metrics.successRate = 
        (pool.metrics.successRate * 0.9) + 0.1; // EMA
    }
  }
  
  /**
   * Report connection failure
   */
  reportFailure(poolId, error) {
    const pool = this.pools.get(poolId);
    if (pool) {
      pool.consecutiveFailures++;
      pool.metrics.successRate = 
        (pool.metrics.successRate * 0.9); // EMA
      
      if (pool.consecutiveFailures >= this.options.failoverThreshold) {
        this.triggerFailover(`pool_failures_exceeded: ${error}`);
      }
    }
  }
  
  /**
   * Select new primary pool
   */
  selectNewPrimary() {
    let newPrimary = null;
    let highestPriority = -Infinity;
    
    for (const pool of this.pools.values()) {
      if (pool.priority > highestPriority) {
        highestPriority = pool.priority;
        newPrimary = pool;
      }
    }
    
    this.primaryPool = newPrimary;
  }
  
  /**
   * Get pool statistics
   */
  getPoolStats() {
    const poolStats = [];
    
    for (const pool of this.pools.values()) {
      poolStats.push({
        id: pool.id,
        name: pool.name,
        health: pool.health,
        connections: pool.connections,
        metrics: pool.metrics,
        score: pool.getScore(),
        isPrimary: pool === this.primaryPool,
        isCurrent: pool === this.currentPool
      });
    }
    
    return poolStats.sort((a, b) => b.score - a.score);
  }
  
  /**
   * Get manager statistics
   */
  getStats() {
    return {
      ...this.stats,
      strategy: this.options.strategy,
      totalPools: this.pools.size,
      activePools: this.activePools.size,
      currentPool: this.currentPool?.name,
      primaryPool: this.primaryPool?.name,
      pools: this.getPoolStats()
    };
  }
  
  /**
   * Stop failover manager
   */
  stop() {
    this.isRunning = false;
    
    // Stop all monitors
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
    
    // Clear intervals
    if (this.rebalanceInterval) {
      clearInterval(this.rebalanceInterval);
    }
    
    logger.info('Pool failover manager stopped');
    
    this.emit('stopped');
  }
}

export default PoolFailoverManager;