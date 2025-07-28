/**
 * Automated Pool Switcher - Otedama
 * Automatically switches to most profitable pool/coin configuration
 * 
 * Design: John Carmack - Performance-oriented switching
 * Architecture: Robert C. Martin - Clean separation of concerns
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { ProfitCalculator } from './profit-calculator.js';
import { StratumClient } from '../network/stratum-client.js';

const logger = createStructuredLogger('PoolSwitcher');

/**
 * Pool configuration structure
 */
export class PoolConfig {
  constructor(data) {
    this.id = data.id;
    this.name = data.name;
    this.url = data.url;
    this.port = data.port;
    this.coin = data.coin;
    this.algorithm = data.algorithm;
    this.username = data.username;
    this.password = data.password || 'x';
    this.tls = data.tls || false;
    this.fee = data.fee || 1.0;
    this.minPayout = data.minPayout || 0.001;
    this.region = data.region || 'global';
    this.priority = data.priority || 0;
    this.enabled = data.enabled !== false;
  }
}

/**
 * Automated Pool Switcher
 */
export class PoolSwitcher extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      checkInterval: config.checkInterval || 300000, // 5 minutes
      switchThreshold: config.switchThreshold || 5, // 5% improvement required
      minRuntime: config.minRuntime || 600000, // 10 minutes minimum
      cooldownPeriod: config.cooldownPeriod || 1800000, // 30 minutes
      maxSwitchesPerDay: config.maxSwitchesPerDay || 10,
      testDuration: config.testDuration || 60000, // 1 minute test
      profitWindow: config.profitWindow || 3600000, // 1 hour average
      ...config
    };
    
    // Components
    this.profitCalculator = config.profitCalculator || new ProfitCalculator();
    this.stratumClients = new Map();
    
    // State
    this.pools = new Map();
    this.currentPool = null;
    this.hardware = null;
    this.switchHistory = [];
    this.profitHistory = new Map();
    this.testResults = new Map();
    
    // Timers
    this.checkTimer = null;
    this.currentSession = null;
    
    // Statistics
    this.stats = {
      totalSwitches: 0,
      successfulSwitches: 0,
      failedSwitches: 0,
      profitImprovement: 0,
      uptimePerPool: new Map(),
      sharesPerPool: new Map()
    };
  }
  
  /**
   * Initialize pool switcher
   */
  async initialize(hardware) {
    this.hardware = hardware;
    
    logger.info('Initializing pool switcher', {
      pools: this.pools.size,
      hardware: hardware.name
    });
    
    // Start monitoring
    this.startMonitoring();
    
    // Connect to initial pool
    if (this.pools.size > 0) {
      await this.selectBestPool();
    }
    
    this.emit('initialized');
  }
  
  /**
   * Add pool configuration
   */
  addPool(poolData) {
    const pool = new PoolConfig(poolData);
    
    // Validate pool supports hardware algorithm
    if (this.hardware && this.hardware.algorithms) {
      if (!this.hardware.algorithms.includes(pool.algorithm)) {
        logger.warn(`Pool ${pool.name} algorithm ${pool.algorithm} not supported by hardware`);
        return false;
      }
    }
    
    this.pools.set(pool.id, pool);
    
    logger.info('Pool added', {
      id: pool.id,
      name: pool.name,
      coin: pool.coin
    });
    
    return true;
  }
  
  /**
   * Remove pool
   */
  removePool(poolId) {
    const pool = this.pools.get(poolId);
    if (!pool) return false;
    
    // Disconnect if current
    if (this.currentPool?.id === poolId) {
      this.disconnectFromPool(poolId);
    }
    
    this.pools.delete(poolId);
    return true;
  }
  
  /**
   * Select best pool based on profitability
   */
  async selectBestPool() {
    if (!this.hardware) {
      logger.error('No hardware configured');
      return null;
    }
    
    const candidates = [];
    
    // Calculate profit for each pool
    for (const pool of this.pools.values()) {
      if (!pool.enabled) continue;
      
      try {
        // Get test results if available
        const testResult = this.testResults.get(pool.id);
        const effectiveHashrate = testResult?.hashrate || this.hardware.hashrate;
        
        // Calculate profitability
        const profit = this.profitCalculator.calculateProfit({
          ...this.hardware,
          hashrate: effectiveHashrate
        }, {
          coin: pool.coin,
          poolFee: pool.fee
        });
        
        // Add pool-specific factors
        const latency = await this.measureLatency(pool);
        const reliability = this.getPoolReliability(pool.id);
        
        // Calculate weighted score
        const score = this.calculatePoolScore(profit, latency, reliability, pool);
        
        candidates.push({
          pool,
          profit,
          latency,
          reliability,
          score
        });
        
      } catch (error) {
        logger.warn(`Failed to calculate profit for pool ${pool.name}:`, error.message);
      }
    }
    
    // Sort by score
    candidates.sort((a, b) => b.score - a.score);
    
    if (candidates.length === 0) {
      logger.warn('No suitable pools found');
      return null;
    }
    
    const best = candidates[0];
    
    // Check if switch is worthwhile
    if (this.currentPool) {
      const currentScore = await this.getCurrentPoolScore();
      const improvement = ((best.score - currentScore) / currentScore) * 100;
      
      if (improvement < this.config.switchThreshold) {
        logger.debug('Best pool not worth switching', {
          current: this.currentPool.name,
          best: best.pool.name,
          improvement: improvement.toFixed(2)
        });
        return this.currentPool;
      }
    }
    
    // Switch to best pool
    await this.switchToPool(best.pool);
    
    return best.pool;
  }
  
  /**
   * Switch to specific pool
   */
  async switchToPool(pool) {
    if (this.currentPool?.id === pool.id) {
      return true; // Already connected
    }
    
    // Check cooldown
    if (!this.canSwitch()) {
      logger.info('Cannot switch - cooldown period active');
      return false;
    }
    
    logger.info('Switching pool', {
      from: this.currentPool?.name || 'none',
      to: pool.name
    });
    
    try {
      // Disconnect from current
      if (this.currentPool) {
        await this.disconnectFromPool(this.currentPool.id);
      }
      
      // Connect to new pool
      const connected = await this.connectToPool(pool);
      
      if (connected) {
        this.currentPool = pool;
        this.recordSwitch(pool);
        this.stats.successfulSwitches++;
        
        this.emit('pool:switched', {
          pool: pool.name,
          coin: pool.coin
        });
        
        return true;
      } else {
        this.stats.failedSwitches++;
        return false;
      }
      
    } catch (error) {
      logger.error('Pool switch failed:', error);
      this.stats.failedSwitches++;
      return false;
    }
  }
  
  /**
   * Connect to pool
   */
  async connectToPool(pool) {
    try {
      // Create stratum client
      const client = new StratumClient({
        host: pool.url,
        port: pool.port,
        tls: pool.tls
      });
      
      // Set up event handlers
      client.on('connected', () => {
        logger.info(`Connected to pool ${pool.name}`);
        this.startSession(pool);
      });
      
      client.on('disconnected', () => {
        logger.warn(`Disconnected from pool ${pool.name}`);
        this.endSession(pool);
      });
      
      client.on('job', (job) => {
        this.emit('job', { pool: pool.name, job });
      });
      
      client.on('share:accepted', (share) => {
        this.recordShare(pool.id, true);
        this.emit('share:accepted', { pool: pool.name, share });
      });
      
      client.on('share:rejected', (share) => {
        this.recordShare(pool.id, false);
        this.emit('share:rejected', { pool: pool.name, share });
      });
      
      // Connect
      await client.connect();
      
      // Authorize
      await client.authorize(pool.username, pool.password);
      
      // Store client
      this.stratumClients.set(pool.id, client);
      
      return true;
      
    } catch (error) {
      logger.error(`Failed to connect to pool ${pool.name}:`, error);
      return false;
    }
  }
  
  /**
   * Disconnect from pool
   */
  async disconnectFromPool(poolId) {
    const client = this.stratumClients.get(poolId);
    if (!client) return;
    
    try {
      await client.disconnect();
      this.stratumClients.delete(poolId);
      this.endSession(this.pools.get(poolId));
      
    } catch (error) {
      logger.error(`Error disconnecting from pool:`, error);
    }
  }
  
  /**
   * Test pool performance
   */
  async testPool(pool) {
    logger.info(`Testing pool ${pool.name}`);
    
    const startTime = Date.now();
    const testClient = new StratumClient({
      host: pool.url,
      port: pool.port,
      tls: pool.tls
    });
    
    const testResult = {
      poolId: pool.id,
      startTime,
      shares: 0,
      accepted: 0,
      rejected: 0,
      hashrate: 0,
      latency: [],
      errors: 0
    };
    
    try {
      // Set up monitoring
      testClient.on('share:accepted', () => {
        testResult.accepted++;
        testResult.shares++;
      });
      
      testClient.on('share:rejected', () => {
        testResult.rejected++;
        testResult.shares++;
      });
      
      testClient.on('error', () => {
        testResult.errors++;
      });
      
      // Connect and test
      await testClient.connect();
      await testClient.authorize(pool.username, pool.password);
      
      // Run test for configured duration
      await new Promise(resolve => setTimeout(resolve, this.config.testDuration));
      
      // Calculate results
      const duration = Date.now() - startTime;
      testResult.duration = duration;
      testResult.acceptRate = testResult.shares > 0 
        ? (testResult.accepted / testResult.shares) * 100 
        : 0;
      
      // Estimate effective hashrate from shares
      testResult.hashrate = this.estimateHashrateFromShares(
        testResult.accepted,
        duration / 1000,
        pool.algorithm
      );
      
      // Store result
      this.testResults.set(pool.id, testResult);
      
      logger.info(`Pool test completed for ${pool.name}`, {
        shares: testResult.shares,
        acceptRate: testResult.acceptRate.toFixed(2)
      });
      
    } catch (error) {
      logger.error(`Pool test failed for ${pool.name}:`, error);
      testResult.errors++;
      
    } finally {
      await testClient.disconnect();
    }
    
    return testResult;
  }
  
  /**
   * Calculate pool score
   */
  calculatePoolScore(profit, latency, reliability, pool) {
    // Base score from profit
    let score = profit.profit.daily;
    
    // Latency penalty (ms)
    const latencyPenalty = Math.max(0, (latency - 50) / 1000);
    score *= (1 - latencyPenalty);
    
    // Reliability bonus
    score *= (0.8 + (reliability * 0.2));
    
    // Priority bonus
    score *= (1 + (pool.priority * 0.1));
    
    // Regional bonus (if specified)
    if (pool.region === this.config.preferredRegion) {
      score *= 1.05;
    }
    
    return score;
  }
  
  /**
   * Get current pool score
   */
  async getCurrentPoolScore() {
    if (!this.currentPool || !this.hardware) return 0;
    
    const profit = this.profitCalculator.calculateProfit(this.hardware, {
      coin: this.currentPool.coin,
      poolFee: this.currentPool.fee
    });
    
    const latency = await this.measureLatency(this.currentPool);
    const reliability = this.getPoolReliability(this.currentPool.id);
    
    return this.calculatePoolScore(profit, latency, reliability, this.currentPool);
  }
  
  /**
   * Measure pool latency
   */
  async measureLatency(pool) {
    const client = this.stratumClients.get(pool.id);
    if (!client || !client.connected) {
      return 999; // High penalty for disconnected
    }
    
    try {
      const start = Date.now();
      await client.ping();
      return Date.now() - start;
      
    } catch (error) {
      return 999;
    }
  }
  
  /**
   * Get pool reliability score
   */
  getPoolReliability(poolId) {
    const stats = this.stats.sharesPerPool.get(poolId);
    if (!stats || stats.total === 0) {
      return 0.5; // Default for new pools
    }
    
    const acceptRate = stats.accepted / stats.total;
    const uptime = this.stats.uptimePerPool.get(poolId) || 0;
    const uptimeRate = Math.min(1, uptime / (7 * 24 * 3600 * 1000)); // 7 day max
    
    return (acceptRate * 0.7) + (uptimeRate * 0.3);
  }
  
  /**
   * Check if can switch
   */
  canSwitch() {
    // Check daily limit
    const today = new Date().toDateString();
    const todaySwitches = this.switchHistory.filter(s => 
      new Date(s.timestamp).toDateString() === today
    ).length;
    
    if (todaySwitches >= this.config.maxSwitchesPerDay) {
      return false;
    }
    
    // Check cooldown
    if (this.switchHistory.length > 0) {
      const lastSwitch = this.switchHistory[this.switchHistory.length - 1];
      if (Date.now() - lastSwitch.timestamp < this.config.cooldownPeriod) {
        return false;
      }
    }
    
    // Check minimum runtime
    if (this.currentSession) {
      if (Date.now() - this.currentSession.startTime < this.config.minRuntime) {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Record switch
   */
  recordSwitch(pool) {
    const record = {
      timestamp: Date.now(),
      poolId: pool.id,
      poolName: pool.name,
      coin: pool.coin
    };
    
    this.switchHistory.push(record);
    this.stats.totalSwitches++;
    
    // Keep only last 100 switches
    if (this.switchHistory.length > 100) {
      this.switchHistory.shift();
    }
  }
  
  /**
   * Start session tracking
   */
  startSession(pool) {
    this.currentSession = {
      poolId: pool.id,
      startTime: Date.now(),
      shares: { accepted: 0, rejected: 0, total: 0 }
    };
  }
  
  /**
   * End session tracking
   */
  endSession(pool) {
    if (!this.currentSession) return;
    
    const duration = Date.now() - this.currentSession.startTime;
    
    // Update uptime
    const currentUptime = this.stats.uptimePerPool.get(pool.id) || 0;
    this.stats.uptimePerPool.set(pool.id, currentUptime + duration);
    
    this.currentSession = null;
  }
  
  /**
   * Record share result
   */
  recordShare(poolId, accepted) {
    // Update pool stats
    const stats = this.stats.sharesPerPool.get(poolId) || {
      accepted: 0,
      rejected: 0,
      total: 0
    };
    
    stats.total++;
    if (accepted) {
      stats.accepted++;
    } else {
      stats.rejected++;
    }
    
    this.stats.sharesPerPool.set(poolId, stats);
    
    // Update session
    if (this.currentSession && this.currentSession.poolId === poolId) {
      this.currentSession.shares.total++;
      if (accepted) {
        this.currentSession.shares.accepted++;
      } else {
        this.currentSession.shares.rejected++;
      }
    }
  }
  
  /**
   * Estimate hashrate from shares
   */
  estimateHashrateFromShares(shares, seconds, algorithm) {
    // Rough estimation based on typical share difficulty
    const difficultyMap = {
      sha256: 65536,
      ethash: 4000000000,
      scrypt: 65536,
      kawpow: 256000,
      randomx: 256000
    };
    
    const difficulty = difficultyMap[algorithm] || 65536;
    const hashesPerShare = difficulty * Math.pow(2, 32);
    const totalHashes = shares * hashesPerShare;
    
    return totalHashes / seconds;
  }
  
  /**
   * Start monitoring
   */
  startMonitoring() {
    this.checkTimer = setInterval(async () => {
      try {
        await this.selectBestPool();
        this.emit('check:completed');
        
      } catch (error) {
        logger.error('Pool check failed:', error);
      }
    }, this.config.checkInterval);
  }
  
  /**
   * Get switching statistics
   */
  getStatistics() {
    const poolStats = [];
    
    for (const [poolId, pool] of this.pools) {
      const shares = this.stats.sharesPerPool.get(poolId) || {
        accepted: 0,
        rejected: 0,
        total: 0
      };
      
      const uptime = this.stats.uptimePerPool.get(poolId) || 0;
      
      poolStats.push({
        pool: pool.name,
        coin: pool.coin,
        shares,
        acceptRate: shares.total > 0 
          ? (shares.accepted / shares.total * 100).toFixed(2) 
          : 0,
        uptime: uptime,
        uptimeHours: (uptime / 3600000).toFixed(2)
      });
    }
    
    return {
      currentPool: this.currentPool?.name || 'none',
      totalSwitches: this.stats.totalSwitches,
      successfulSwitches: this.stats.successfulSwitches,
      failedSwitches: this.stats.failedSwitches,
      successRate: this.stats.totalSwitches > 0
        ? (this.stats.successfulSwitches / this.stats.totalSwitches * 100).toFixed(2)
        : 0,
      poolStats,
      recentSwitches: this.switchHistory.slice(-10)
    };
  }
  
  /**
   * Export configuration
   */
  exportConfig() {
    const pools = Array.from(this.pools.values()).map(pool => ({
      id: pool.id,
      name: pool.name,
      url: pool.url,
      port: pool.port,
      coin: pool.coin,
      algorithm: pool.algorithm,
      username: pool.username,
      tls: pool.tls,
      fee: pool.fee,
      region: pool.region,
      priority: pool.priority,
      enabled: pool.enabled
    }));
    
    return {
      pools,
      config: {
        checkInterval: this.config.checkInterval,
        switchThreshold: this.config.switchThreshold,
        minRuntime: this.config.minRuntime,
        cooldownPeriod: this.config.cooldownPeriod,
        maxSwitchesPerDay: this.config.maxSwitchesPerDay
      }
    };
  }
  
  /**
   * Import configuration
   */
  importConfig(data) {
    // Clear existing pools
    this.pools.clear();
    
    // Import pools
    for (const poolData of data.pools) {
      this.addPool(poolData);
    }
    
    // Update config
    Object.assign(this.config, data.config);
    
    logger.info('Configuration imported', {
      pools: data.pools.length
    });
  }
  
  /**
   * Shutdown switcher
   */
  async shutdown() {
    // Stop monitoring
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    
    // Disconnect all pools
    for (const poolId of this.stratumClients.keys()) {
      await this.disconnectFromPool(poolId);
    }
    
    this.removeAllListeners();
    logger.info('Pool switcher shutdown');
  }
}

/**
 * Create pool switcher instance
 */
export function createPoolSwitcher(config) {
  return new PoolSwitcher(config);
}

export default PoolSwitcher;