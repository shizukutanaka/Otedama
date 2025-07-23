const EventEmitter = require('events');
const axios = require('axios');
const { BigNumber } = require('bignumber.js');

class AutoPoolSwitching extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Switching settings
      checkInterval: options.checkInterval || 300000, // 5 minutes
      switchThreshold: options.switchThreshold || 0.05, // 5% difference
      minSwitchInterval: options.minSwitchInterval || 3600000, // 1 hour
      
      // Pool evaluation
      evaluationWindow: options.evaluationWindow || 86400000, // 24 hours
      profitabilityWeight: options.profitabilityWeight || 0.5,
      reliabilityWeight: options.reliabilityWeight || 0.3,
      latencyWeight: options.latencyWeight || 0.2,
      
      // API endpoints
      priceApiUrl: options.priceApiUrl || 'https://api.coingecko.com/api/v3',
      poolApiUrls: options.poolApiUrls || [],
      
      // Features
      autoFailover: options.autoFailover !== false,
      predictiveSwitching: options.predictiveSwitching !== false,
      multiAlgoSupport: options.multiAlgoSupport !== false
    };
    
    this.pools = new Map();
    this.currentPool = null;
    this.lastSwitch = 0;
    this.priceCache = new Map();
    this.performanceHistory = new Map();
    
    this.isRunning = false;
    this.checkInterval = null;
  }
  
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.emit('started');
    
    // Initial pool discovery
    await this.discoverPools();
    
    // Start monitoring
    this.checkInterval = setInterval(() => {
      this.evaluateAndSwitch();
    }, this.config.checkInterval);
    
    // Initial evaluation
    await this.evaluateAndSwitch();
  }
  
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    this.emit('stopped');
  }
  
  async discoverPools() {
    // Default pools for major cryptocurrencies
    const defaultPools = [
      {
        id: 'otedama-p2p',
        name: 'Otedama P2P Pool',
        url: 'stratum+tcp://pool.otedama.com:3333',
        algorithms: ['SHA256', 'Scrypt', 'Ethash', 'RandomX', 'KawPow'],
        fee: 0.01,
        minPayout: 0.001,
        region: 'global',
        reputation: 0.95
      },
      {
        id: 'nicehash',
        name: 'NiceHash',
        url: 'stratum+tcp://stratum.nicehash.com:3333',
        algorithms: ['SHA256', 'Scrypt', 'Ethash', 'KawPow', 'Octopus'],
        fee: 0.02,
        minPayout: 0.001,
        region: 'global',
        reputation: 0.9
      },
      {
        id: 'f2pool',
        name: 'F2Pool',
        url: 'stratum+tcp://btc.f2pool.com:3333',
        algorithms: ['SHA256', 'Scrypt'],
        fee: 0.025,
        minPayout: 0.005,
        region: 'asia',
        reputation: 0.92
      },
      {
        id: 'ethermine',
        name: 'Ethermine',
        url: 'stratum+tcp://us1.ethermine.org:4444',
        algorithms: ['Ethash'],
        fee: 0.01,
        minPayout: 0.01,
        region: 'us',
        reputation: 0.94
      },
      {
        id: 'miningpoolhub',
        name: 'MiningPoolHub',
        url: 'stratum+tcp://hub.miningpoolhub.com:20593',
        algorithms: ['Ethash', 'Equihash', 'Lyra2REv2'],
        fee: 0.009,
        minPayout: 0.01,
        region: 'global',
        reputation: 0.88
      }
    ];
    
    // Add discovered pools
    for (const pool of defaultPools) {
      this.pools.set(pool.id, {
        ...pool,
        stats: {
          hashrate: 0,
          miners: 0,
          lastBlock: null,
          uptime: 0.99
        },
        performance: {
          latency: null,
          shares: { accepted: 0, rejected: 0 },
          earnings: new BigNumber(0)
        }
      });
    }
    
    // Fetch additional pools from APIs
    await this.fetchPoolsFromAPIs();
    
    this.emit('poolsDiscovered', Array.from(this.pools.values()));
  }
  
  async fetchPoolsFromAPIs() {
    // Fetch from miningpoolstats.stream API
    try {
      const response = await axios.get('https://miningpoolstats.stream/api/pools', {
        timeout: 5000
      });
      
      if (response.data && Array.isArray(response.data)) {
        for (const poolData of response.data) {
          if (poolData.poolId && !this.pools.has(poolData.poolId)) {
            this.pools.set(poolData.poolId, {
              id: poolData.poolId,
              name: poolData.name,
              url: poolData.url,
              algorithms: poolData.algorithms || [],
              fee: poolData.fee || 0.01,
              minPayout: poolData.minPayout || 0.001,
              region: poolData.region || 'unknown',
              reputation: poolData.rating || 0.5,
              stats: poolData.stats || {},
              performance: {
                latency: null,
                shares: { accepted: 0, rejected: 0 },
                earnings: new BigNumber(0)
              }
            });
          }
        }
      }
    } catch (error) {
      this.emit('apiError', { api: 'miningpoolstats', error: error.message });
    }
  }
  
  async evaluateAndSwitch() {
    try {
      // Check if enough time has passed since last switch
      if (Date.now() - this.lastSwitch < this.config.minSwitchInterval) {
        return;
      }
      
      // Update prices
      await this.updatePrices();
      
      // Evaluate all pools
      const evaluations = await this.evaluatePools();
      
      // Sort by score
      const rankedPools = evaluations.sort((a, b) => b.score - a.score);
      
      // Get best pool
      const bestPool = rankedPools[0];
      
      // Check if we should switch
      if (this.shouldSwitch(bestPool)) {
        await this.switchToPool(bestPool.pool);
      }
      
      this.emit('evaluationComplete', {
        current: this.currentPool?.id,
        best: bestPool.pool.id,
        evaluations: rankedPools
      });
      
    } catch (error) {
      this.emit('error', error);
    }
  }
  
  async evaluatePools() {
    const evaluations = [];
    
    for (const pool of this.pools.values()) {
      try {
        // Skip if pool doesn't support current algorithm
        if (this.currentAlgorithm && !pool.algorithms.includes(this.currentAlgorithm)) {
          continue;
        }
        
        // Calculate profitability
        const profitability = await this.calculateProfitability(pool);
        
        // Measure latency
        const latency = await this.measureLatency(pool);
        
        // Get reliability score
        const reliability = this.calculateReliability(pool);
        
        // Calculate weighted score
        const score = (
          profitability * this.config.profitabilityWeight +
          reliability * this.config.reliabilityWeight +
          (1 / (latency + 1)) * this.config.latencyWeight
        );
        
        evaluations.push({
          pool,
          profitability,
          latency,
          reliability,
          score,
          details: {
            estimatedDailyRevenue: this.estimateDailyRevenue(pool, profitability),
            effectiveFee: pool.fee,
            region: pool.region
          }
        });
        
      } catch (error) {
        this.emit('poolEvaluationError', { pool: pool.id, error: error.message });
      }
    }
    
    return evaluations;
  }
  
  async calculateProfitability(pool) {
    // Get current network difficulty and block reward
    const networkStats = await this.getNetworkStats(pool.algorithms[0]);
    
    // Get coin prices
    const prices = await this.getCoinPrices(pool.algorithms[0]);
    
    // Calculate expected revenue
    const hashrate = this.currentHashrate || 100000000; // 100 MH/s default
    const blocksPerDay = (hashrate / networkStats.difficulty) * 86400 / networkStats.blockTime;
    const coinsPerDay = blocksPerDay * networkStats.blockReward;
    const revenuePerDay = coinsPerDay * prices.usd;
    
    // Subtract pool fee
    const netRevenue = revenuePerDay * (1 - pool.fee);
    
    // Normalize to 0-1 scale
    return Math.min(netRevenue / 100, 1); // Assuming $100/day is maximum
  }
  
  async measureLatency(pool) {
    const start = Date.now();
    
    try {
      // Attempt to connect to pool
      const net = require('net');
      const url = new URL(pool.url);
      
      return new Promise((resolve) => {
        const socket = net.createConnection({
          host: url.hostname,
          port: parseInt(url.port) || 3333,
          timeout: 5000
        });
        
        socket.on('connect', () => {
          const latency = Date.now() - start;
          socket.destroy();
          pool.performance.latency = latency;
          resolve(latency);
        });
        
        socket.on('error', () => {
          socket.destroy();
          resolve(9999); // High latency for failed connections
        });
        
        socket.on('timeout', () => {
          socket.destroy();
          resolve(9999);
        });
      });
      
    } catch (error) {
      return 9999;
    }
  }
  
  calculateReliability(pool) {
    // Base reliability on reputation
    let reliability = pool.reputation || 0.5;
    
    // Adjust based on performance history
    const history = this.performanceHistory.get(pool.id);
    if (history && history.length > 0) {
      const recentHistory = history.slice(-100); // Last 100 shares
      const acceptRate = recentHistory.filter(h => h.accepted).length / recentHistory.length;
      reliability = reliability * 0.7 + acceptRate * 0.3;
    }
    
    // Adjust based on uptime
    if (pool.stats.uptime) {
      reliability = reliability * 0.8 + pool.stats.uptime * 0.2;
    }
    
    return reliability;
  }
  
  shouldSwitch(bestPool) {
    // Don't switch if no current pool
    if (!this.currentPool) {
      return true;
    }
    
    // Don't switch to same pool
    if (bestPool.pool.id === this.currentPool.id) {
      return false;
    }
    
    // Calculate improvement threshold
    const currentScore = this.getCurrentPoolScore();
    const improvement = (bestPool.score - currentScore) / currentScore;
    
    // Switch if improvement exceeds threshold
    return improvement > this.config.switchThreshold;
  }
  
  getCurrentPoolScore() {
    if (!this.currentPool) return 0;
    
    const pool = this.pools.get(this.currentPool.id);
    if (!pool) return 0;
    
    // Simple score based on recent performance
    const history = this.performanceHistory.get(pool.id);
    if (!history || history.length === 0) return 0.5;
    
    const recentHistory = history.slice(-100);
    const acceptRate = recentHistory.filter(h => h.accepted).length / recentHistory.length;
    
    return acceptRate * 0.8 + pool.reputation * 0.2;
  }
  
  async switchToPool(pool) {
    this.emit('switchingPool', {
      from: this.currentPool?.id,
      to: pool.id
    });
    
    try {
      // Disconnect from current pool
      if (this.currentPool) {
        await this.disconnectFromPool(this.currentPool);
      }
      
      // Connect to new pool
      await this.connectToPool(pool);
      
      // Update current pool
      this.currentPool = pool;
      this.lastSwitch = Date.now();
      
      this.emit('poolSwitched', {
        pool: pool.id,
        url: pool.url,
        algorithms: pool.algorithms
      });
      
      // Record switch in history
      this.recordSwitch(pool);
      
    } catch (error) {
      this.emit('switchError', { pool: pool.id, error: error.message });
      
      // Failover to backup pool
      if (this.config.autoFailover) {
        await this.failover();
      }
    }
  }
  
  async disconnectFromPool(pool) {
    // Implementation would disconnect from actual pool
    this.emit('poolDisconnected', pool.id);
  }
  
  async connectToPool(pool) {
    // Implementation would connect to actual pool
    // For now, just simulate connection
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    this.emit('poolConnected', {
      id: pool.id,
      url: pool.url
    });
  }
  
  async failover() {
    // Find backup pools
    const backupPools = Array.from(this.pools.values())
      .filter(p => p.id !== this.currentPool?.id)
      .sort((a, b) => b.reputation - a.reputation);
    
    for (const pool of backupPools) {
      try {
        await this.switchToPool(pool);
        break;
      } catch (error) {
        continue;
      }
    }
  }
  
  recordSwitch(pool) {
    const record = {
      timestamp: Date.now(),
      poolId: pool.id,
      reason: 'profitability',
      previousPool: this.currentPool?.id
    };
    
    // Store in history
    if (!this.switchHistory) {
      this.switchHistory = [];
    }
    
    this.switchHistory.push(record);
    
    // Keep only last 100 switches
    if (this.switchHistory.length > 100) {
      this.switchHistory = this.switchHistory.slice(-100);
    }
  }
  
  // Price and network data
  
  async updatePrices() {
    try {
      const coins = ['bitcoin', 'ethereum', 'monero', 'ravencoin'];
      const response = await axios.get(
        `${this.config.priceApiUrl}/simple/price?ids=${coins.join(',')}&vs_currencies=usd`
      );
      
      for (const [coin, data of Object.entries(response.data)) {
        this.priceCache.set(coin, {
          usd: data.usd,
          timestamp: Date.now()
        });
      }
      
    } catch (error) {
      this.emit('priceUpdateError', error.message);
    }
  }
  
  async getCoinPrices(algorithm) {
    // Map algorithm to coin
    const algorithmToCoin = {
      'SHA256': 'bitcoin',
      'Ethash': 'ethereum',
      'RandomX': 'monero',
      'KawPow': 'ravencoin'
    };
    
    const coin = algorithmToCoin[algorithm] || 'bitcoin';
    const cached = this.priceCache.get(coin);
    
    if (cached && Date.now() - cached.timestamp < 300000) {
      return cached;
    }
    
    // Update if cache is stale
    await this.updatePrices();
    return this.priceCache.get(coin) || { usd: 0 };
  }
  
  async getNetworkStats(algorithm) {
    // Simulated network stats
    // In production, would fetch from blockchain APIs
    const stats = {
      'SHA256': {
        difficulty: 25000000000000,
        blockTime: 600,
        blockReward: 6.25
      },
      'Ethash': {
        difficulty: 7500000000000000,
        blockTime: 13,
        blockReward: 2
      },
      'RandomX': {
        difficulty: 300000000000,
        blockTime: 120,
        blockReward: 1.2
      },
      'KawPow': {
        difficulty: 100000000000,
        blockTime: 60,
        blockReward: 5000
      }
    };
    
    return stats[algorithm] || stats['SHA256'];
  }
  
  estimateDailyRevenue(pool, profitabilityScore) {
    // Convert profitability score to estimated USD
    return profitabilityScore * 100; // Simplified
  }
  
  // Performance tracking
  
  recordShare(poolId, accepted) {
    if (!this.performanceHistory.has(poolId)) {
      this.performanceHistory.set(poolId, []);
    }
    
    const history = this.performanceHistory.get(poolId);
    history.push({
      timestamp: Date.now(),
      accepted
    });
    
    // Keep only last 1000 shares
    if (history.length > 1000) {
      this.performanceHistory.set(poolId, history.slice(-1000));
    }
  }
  
  // Public API
  
  getCurrentPool() {
    return this.currentPool;
  }
  
  getPools() {
    return Array.from(this.pools.values());
  }
  
  getStatistics() {
    return {
      currentPool: this.currentPool?.id,
      poolCount: this.pools.size,
      lastSwitch: this.lastSwitch,
      switchHistory: this.switchHistory || [],
      performanceHistory: Object.fromEntries(
        Array.from(this.performanceHistory.entries()).map(([poolId, history]) => [
          poolId,
          {
            totalShares: history.length,
            acceptedShares: history.filter(h => h.accepted).length,
            acceptRate: history.length > 0 
              ? history.filter(h => h.accepted).length / history.length 
              : 0
          }
        ])
      )
    };
  }
  
  setAlgorithm(algorithm) {
    this.currentAlgorithm = algorithm;
    this.emit('algorithmChanged', algorithm);
  }
  
  setHashrate(hashrate) {
    this.currentHashrate = hashrate;
  }
  
  // Manual controls
  
  async forceSwitch(poolId) {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error('Pool not found');
    }
    
    await this.switchToPool(pool);
  }
  
  addCustomPool(poolConfig) {
    const pool = {
      id: poolConfig.id || `custom-${Date.now()}`,
      name: poolConfig.name,
      url: poolConfig.url,
      algorithms: poolConfig.algorithms || [],
      fee: poolConfig.fee || 0.01,
      minPayout: poolConfig.minPayout || 0.001,
      region: poolConfig.region || 'custom',
      reputation: 0.5,
      stats: {},
      performance: {
        latency: null,
        shares: { accepted: 0, rejected: 0 },
        earnings: new BigNumber(0)
      }
    };
    
    this.pools.set(pool.id, pool);
    this.emit('poolAdded', pool);
    
    return pool.id;
  }
  
  removePool(poolId) {
    if (this.currentPool?.id === poolId) {
      throw new Error('Cannot remove current pool');
    }
    
    this.pools.delete(poolId);
    this.performanceHistory.delete(poolId);
    
    this.emit('poolRemoved', poolId);
  }
}

module.exports = AutoPoolSwitching;