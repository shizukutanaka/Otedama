/**
 * Enhanced Pool Manager
 * Comprehensive pool management with monitoring, auto-scaling, and fault tolerance
 */

const EventEmitter = require('events');
const { createLogger } = require('../core/logger');
const SecureStratumServer = require('../mining/secure-stratum-server');
const EnhancedShareValidator = require('../mining/share-validator-enhanced');
const AdvancedPaymentSystem = require('../payments/advanced-payment-system');
const PaymentDatabase = require('../payments/payment-database');
const BlockchainMonitor = require('../blockchain/blockchain-monitor');
const PoolWallet = require('../wallet/pool-wallet');
const { RateLimiterMemory } = require('rate-limiter-flexible');
const crypto = require('crypto');
const { immutableFeeConfig, getPoolFee, getOperatorAddress } = require('../core/immutable-fee-config');

const logger = createLogger('pool-manager-enhanced');

class EnhancedPoolManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Pool identity
      poolName: options.poolName || 'Otedama Pool',
      poolUrl: options.poolUrl || 'otedama.io',
      
      // Stratum settings
      stratumPort: options.stratumPort || 3333,
      stratumHost: options.stratumHost || '0.0.0.0',
      maxMiners: options.maxMiners || 10000,
      
      // Blockchain settings
      coin: options.coin || 'BTC',
      network: options.network || 'mainnet',
      blockchainNode: options.blockchainNode || 'http://localhost:8332',
      
      // Payment settings
      paymentScheme: options.paymentScheme || 'PPLNS',
      // poolFee is now immutable and loaded from immutable config
      minimumPayment: options.minimumPayment || 0.001,
      
      // Performance
      shareValidationWorkers: options.shareValidationWorkers || 4,
      vardiffEnabled: options.vardiffEnabled !== false,
      vardiffTarget: options.vardiffTarget || 15, // seconds between shares
      
      // Security
      ddosProtection: options.ddosProtection !== false,
      banDuration: options.banDuration || 3600000, // 1 hour
      
      // Monitoring
      statsInterval: options.statsInterval || 60000, // 1 minute
      healthCheckInterval: options.healthCheckInterval || 30000, // 30 seconds
      
      // Auto-scaling
      autoScaling: options.autoScaling !== false,
      scaleUpThreshold: options.scaleUpThreshold || 0.8, // 80% capacity
      scaleDownThreshold: options.scaleDownThreshold || 0.3, // 30% capacity
      
      // Database
      database: options.database || {},
      
      ...options
    };
    
    // Core components
    this.stratumServer = null;
    this.shareValidator = null;
    this.paymentSystem = null;
    this.blockchainMonitor = null;
    this.database = null;
    
    // Pool state
    this.state = {
      status: 'initializing',
      startTime: Date.now(),
      currentBlock: null,
      networkDifficulty: 0,
      estimatedHashrate: 0,
      connectedMiners: 0,
      totalShares: 0,
      blocksFound: 0
    };
    
    // Wallet instance (to be initialized)
    this.wallet = null;
    
    // Miner management
    this.miners = new Map();
    this.minersByAddress = new Map();
    
    // Job management
    this.jobs = new Map();
    this.currentJob = null;
    this.jobCounter = 0;
    
    // Rate limiting
    this.connectionLimiter = new RateLimiterMemory({
      points: 100,
      duration: 60,
      blockDuration: this.options.banDuration / 1000
    });
    
    // Statistics
    this.stats = {
      shares: {
        valid: 0,
        invalid: 0,
        duplicate: 0,
        lowDiff: 0
      },
      blocks: {
        found: 0,
        confirmed: 0,
        orphaned: 0,
        pending: 0
      },
      miners: {
        connected: 0,
        authorized: 0,
        banned: 0
      },
      performance: {
        sharesPerSecond: 0,
        averageShareTime: 0,
        poolHashrate: 0,
        poolEfficiency: 0
      }
    };
    
    // Monitoring
    this.monitors = {
      stats: null,
      health: null,
      blockchain: null
    };
    
    // Health status
    this.health = {
      stratum: false,
      blockchain: false,
      database: false,
      payments: false,
      overall: false
    };
  }
  
  /**
   * Initialize the pool
   */
  async initialize() {
    try {
      logger.info(`Initializing ${this.options.poolName}...`);
      
      // Initialize immutable fee configuration first
      await immutableFeeConfig.initialize();
      
      // Log immutable configuration
      logger.info('===== POOL FEE CONFIGURATION (IMMUTABLE) =====');
      logger.info(`Pool Fee: ${getPoolFee() * 100}%`);
      logger.info(`Operator Address: ${getOperatorAddress(this.options.network)}`);
      logger.info('=============================================');
      
      // Initialize database
      await this.initializeDatabase();
      
      // Initialize wallet
      await this.initializeWallet();
      
      // Initialize blockchain monitoring
      await this.initializeBlockchain();
      
      // Initialize share validator
      await this.initializeShareValidator();
      
      // Initialize payment system
      await this.initializePaymentSystem();
      
      // Initialize stratum server
      await this.initializeStratumServer();
      
      // Start monitoring
      this.startMonitoring();
      
      // Update state
      this.state.status = 'running';
      this.updateHealth();
      
      logger.info(`${this.options.poolName} initialized successfully`);
      this.emit('initialized');
      
      return true;
      
    } catch (error) {
      logger.error('Failed to initialize pool:', error);
      this.state.status = 'error';
      throw error;
    }
  }
  
  /**
   * Initialize database
   */
  async initializeDatabase() {
    this.database = new PaymentDatabase(this.options.database);
    await this.database.initialize();
    
    this.health.database = true;
    logger.info('Database initialized');
  }
  
  /**
   * Initialize wallet
   */
  async initializeWallet() {
    this.wallet = new PoolWallet({
      network: this.options.network === 'mainnet' ? 
        require('bitcoinjs-lib').networks.bitcoin : 
        require('bitcoinjs-lib').networks.testnet,
      encryptionKey: this.options.walletEncryptionKey || crypto.randomBytes(32).toString('hex'),
      rpcClient: null // Will be set after blockchain monitor is initialized
    });
    
    await this.wallet.initialize();
    logger.info('Pool wallet initialized');
  }
  
  /**
   * Initialize blockchain monitoring
   */
  async initializeBlockchain() {
    this.blockchainMonitor = new BlockchainMonitor({
      node: this.options.blockchainNode,
      coin: this.options.coin,
      network: this.options.network,
      confirmations: 100
    });
    
    // Blockchain event handlers
    this.blockchainMonitor.on('new-block', (block) => {
      this.handleNewBlock(block);
    });
    
    this.blockchainMonitor.on('block-confirmed', (block) => {
      this.handleBlockConfirmed(block);
    });
    
    this.blockchainMonitor.on('connected', () => {
      this.health.blockchain = true;
      logger.info('Connected to blockchain node');
    });
    
    this.blockchainMonitor.on('disconnected', () => {
      this.health.blockchain = false;
      logger.error('Disconnected from blockchain node');
    });
    
    await this.blockchainMonitor.start();
    
    // Set RPC client in wallet
    this.wallet.options.rpcClient = this.blockchainMonitor.rpcClient;
  }
  
  /**
   * Initialize share validator
   */
  async initializeShareValidator() {
    this.shareValidator = new EnhancedShareValidator({
      workerPoolSize: this.options.shareValidationWorkers,
      strictValidation: true,
      banThreshold: 100
    });
    
    // Validator event handlers
    this.shareValidator.on('share-valid', (result) => {
      this.handleValidShare(result);
    });
    
    this.shareValidator.on('share-invalid', (result) => {
      this.handleInvalidShare(result);
    });
    
    this.shareValidator.on('block-found', (data) => {
      this.handleBlockFound(data);
    });
    
    this.shareValidator.on('miner-banned', (data) => {
      this.handleMinerBanned(data);
    });
    
    await this.shareValidator.initialize();
    logger.info('Share validator initialized');
  }
  
  /**
   * Initialize payment system
   */
  async initializePaymentSystem() {
    this.paymentSystem = new AdvancedPaymentSystem({
      scheme: this.options.paymentScheme,
      // poolFee is now loaded from immutable config
      minimumPayout: this.options.minimumPayment,
      dbPool: this.database.pool,
      network: this.options.network
    });
    
    // Payment event handlers
    this.paymentSystem.on('payment-sent', (data) => {
      logger.info(`Payment sent: ${data.amount} to ${data.address}`);
    });
    
    this.paymentSystem.on('hot-wallet-low', (data) => {
      logger.warn('Hot wallet balance low:', data);
      this.emit('alert', {
        type: 'hot_wallet_low',
        severity: 'high',
        data
      });
    });
    
    await this.paymentSystem.initialize(this.wallet);
    
    this.health.payments = true;
    logger.info('Payment system initialized');
  }
  
  /**
   * Initialize stratum server
   */
  async initializeStratumServer() {
    this.stratumServer = new SecureStratumServer({
      port: this.options.stratumPort,
      host: this.options.stratumHost,
      maxConnections: this.options.maxMiners,
      banDuration: this.options.banDuration
    });
    
    // Stratum event handlers
    this.stratumServer.on('miner-connected', (miner) => {
      this.handleMinerConnected(miner);
    });
    
    this.stratumServer.on('miner-disconnected', (miner) => {
      this.handleMinerDisconnected(miner);
    });
    
    this.stratumServer.on('share-submitted', async (miner, share, callback) => {
      await this.handleShareSubmitted(miner, share, callback);
    });
    
    await this.stratumServer.start();
    
    this.health.stratum = true;
    logger.info(`Stratum server listening on ${this.options.stratumHost}:${this.options.stratumPort}`);
  }
  
  /**
   * Handle new block from blockchain
   */
  async handleNewBlock(block) {
    logger.info(`New block detected: ${block.height} (${block.hash})`);
    
    // Update state
    this.state.currentBlock = block;
    this.state.networkDifficulty = block.difficulty;
    
    // Create new job
    const job = await this.createNewJob(block);
    
    // Broadcast to miners
    this.stratumServer.broadcastJob(job, true);
    
    this.emit('new-block', block);
  }
  
  /**
   * Handle block confirmation
   */
  async handleBlockConfirmed(block) {
    logger.info(`Block confirmed: ${block.height}`);
    
    // Check if it's our block
    const ourBlock = await this.database.getBlock(block.height);
    if (ourBlock && ourBlock.hash === block.hash) {
      // Process payment
      await this.paymentSystem.processBlockReward(block, block.reward);
      
      // Update stats
      this.stats.blocks.confirmed++;
      
      this.emit('block-confirmed', block);
    }
  }
  
  /**
   * Create new mining job
   */
  async createNewJob(block) {
    const jobId = (++this.jobCounter).toString(16);
    
    const job = {
      id: jobId,
      prevHash: block.previousHash,
      coinbase1: this.generateCoinbase1(block),
      coinbase2: this.generateCoinbase2(),
      merkleTree: block.merkleTree || [],
      version: block.version.toString(16).padStart(8, '0'),
      bits: block.bits.toString(16).padStart(8, '0'),
      time: Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'),
      clean: true,
      height: block.height
    };
    
    this.jobs.set(jobId, job);
    this.currentJob = job;
    
    // Clean old jobs
    this.cleanOldJobs();
    
    return job;
  }
  
  /**
   * Generate coinbase1
   */
  generateCoinbase1(block) {
    // Simplified - in production would build proper coinbase transaction
    const height = Buffer.allocUnsafe(4);
    height.writeUInt32LE(block.height, 0);
    
    const coinbase = Buffer.concat([
      Buffer.from('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff', 'hex'),
      Buffer.from([height.length]),
      height,
      Buffer.from(`2f${this.options.poolName}/`, 'utf8')
    ]);
    
    return coinbase.toString('hex');
  }
  
  /**
   * Generate coinbase2
   */
  generateCoinbase2() {
    // Simplified - in production would include pool address and proper outputs
    return 'ffffffff01' + '00f2052a01000000' + '1976a914' + '0000000000000000000000000000000000000000' + '88ac00000000';
  }
  
  /**
   * Handle miner connection
   */
  async handleMinerConnected(miner) {
    try {
      // Rate limiting
      await this.connectionLimiter.consume(miner.ip);
      
      // Add to tracking
      this.miners.set(miner.id, {
        ...miner,
        stats: {
          shares: 0,
          validShares: 0,
          invalidShares: 0,
          hashrate: 0,
          difficulty: this.options.vardiffEnabled ? 16 : 65536
        }
      });
      
      // Update stats
      this.stats.miners.connected++;
      this.state.connectedMiners = this.miners.size;
      
      logger.info(`Miner connected: ${miner.address || miner.id} from ${miner.ip}`);
      this.emit('miner-connected', miner);
      
    } catch (error) {
      logger.warn(`Connection rejected from ${miner.ip}:`, error.message);
      miner.socket.end();
    }
  }
  
  /**
   * Handle miner disconnection
   */
  handleMinerDisconnected(miner) {
    const minerData = this.miners.get(miner.id);
    if (minerData) {
      // Update miner map by address
      if (minerData.address) {
        const addressMiners = this.minersByAddress.get(minerData.address) || [];
        const index = addressMiners.indexOf(miner.id);
        if (index !== -1) {
          addressMiners.splice(index, 1);
        }
        
        if (addressMiners.length === 0) {
          this.minersByAddress.delete(minerData.address);
        }
      }
      
      // Remove from tracking
      this.miners.delete(miner.id);
    }
    
    // Update stats
    this.stats.miners.connected--;
    this.state.connectedMiners = this.miners.size;
    
    logger.info(`Miner disconnected: ${miner.address || miner.id}`);
    this.emit('miner-disconnected', miner);
  }
  
  /**
   * Handle share submission
   */
  async handleShareSubmitted(miner, share, callback) {
    const minerData = this.miners.get(miner.id);
    if (!minerData) {
      callback(false, false, 'Unknown miner');
      return;
    }
    
    try {
      // Get job
      const job = this.jobs.get(share.jobId);
      if (!job) {
        callback(false, false, 'Job not found');
        minerData.stats.invalidShares++;
        return;
      }
      
      // Add miner info to share
      share.minerAddress = miner.address;
      share.difficulty = minerData.stats.difficulty;
      
      // Validate share
      const result = await this.shareValidator.validateShare(share, job, miner);
      
      if (result.valid) {
        // Update miner stats
        minerData.stats.shares++;
        minerData.stats.validShares++;
        
        // Record share
        await this.paymentSystem.recordShare(share, miner);
        await this.database.recordShare({
          minerAddress: miner.address,
          jobId: share.jobId,
          difficulty: share.difficulty,
          shareDiff: result.shareDifficulty,
          blockHeight: job.height
        });
        
        // Update hashrate
        this.updateMinerHashrate(minerData);
        
        // Adjust difficulty if vardiff enabled
        if (this.options.vardiffEnabled) {
          this.adjustMinerDifficulty(minerData);
        }
        
        // Update pool stats
        this.stats.shares.valid++;
        this.state.totalShares++;
        
        callback(true, result.isBlock);
        
      } else {
        // Update stats
        minerData.stats.invalidShares++;
        this.stats.shares[result.reason] = (this.stats.shares[result.reason] || 0) + 1;
        
        callback(false, false, result.reason);
      }
      
    } catch (error) {
      logger.error('Error processing share:', error);
      callback(false, false, 'Internal error');
    }
  }
  
  /**
   * Handle valid share
   */
  handleValidShare(result) {
    // Additional processing if needed
  }
  
  /**
   * Handle invalid share
   */
  handleInvalidShare(result) {
    // Track patterns
    if (result.miner) {
      const minerData = this.miners.get(result.miner.id);
      if (minerData) {
        const invalidRate = minerData.stats.invalidShares / minerData.stats.shares;
        if (invalidRate > 0.5 && minerData.stats.shares > 100) {
          logger.warn(`High invalid rate for miner ${result.miner.address}: ${(invalidRate * 100).toFixed(2)}%`);
        }
      }
    }
  }
  
  /**
   * Handle block found
   */
  async handleBlockFound(data) {
    logger.info(`🎉 BLOCK FOUND by ${data.miner.address}!`);
    
    // Record block
    await this.database.recordBlock({
      height: this.currentJob.height,
      hash: data.share.hash,
      reward: this.calculateBlockReward(this.currentJob.height),
      finderAddress: data.miner.address
    });
    
    // Update stats
    this.stats.blocks.found++;
    this.stats.blocks.pending++;
    this.state.blocksFound++;
    
    // Update miner stats
    const minerData = this.miners.get(data.miner.id);
    if (minerData) {
      minerData.stats.blocksFound = (minerData.stats.blocksFound || 0) + 1;
    }
    
    this.emit('block-found', {
      height: this.currentJob.height,
      hash: data.share.hash,
      miner: data.miner,
      share: data.share
    });
  }
  
  /**
   * Handle miner ban
   */
  handleMinerBanned(data) {
    const minerData = this.miners.get(data.miner.id);
    if (minerData) {
      minerData.banned = true;
      minerData.banReason = data.reason;
      
      // Disconnect miner
      const stratumMiner = this.stratumServer.miners.get(data.miner.id);
      if (stratumMiner) {
        stratumMiner.socket.end();
      }
    }
    
    this.stats.miners.banned++;
    
    logger.warn(`Miner banned: ${data.miner.address || data.miner.id} - ${data.reason}`);
    this.emit('miner-banned', data);
  }
  
  /**
   * Update miner hashrate
   */
  updateMinerHashrate(minerData) {
    const timeDiff = Date.now() - (minerData.lastShareTime || minerData.connectedAt);
    if (timeDiff < 60000) return; // Need at least 1 minute of data
    
    const sharesPerSecond = minerData.stats.validShares / (timeDiff / 1000);
    minerData.stats.hashrate = sharesPerSecond * minerData.stats.difficulty * Math.pow(2, 32);
    minerData.lastShareTime = Date.now();
  }
  
  /**
   * Adjust miner difficulty (vardiff)
   */
  adjustMinerDifficulty(minerData) {
    if (!minerData.lastDifficultyAdjustment) {
      minerData.lastDifficultyAdjustment = Date.now();
      minerData.sharesAtLastAdjustment = minerData.stats.validShares;
      return;
    }
    
    const timeSinceAdjustment = Date.now() - minerData.lastDifficultyAdjustment;
    if (timeSinceAdjustment < 120000) return; // Adjust every 2 minutes
    
    const sharesSinceAdjustment = minerData.stats.validShares - minerData.sharesAtLastAdjustment;
    const actualShareTime = timeSinceAdjustment / sharesSinceAdjustment / 1000;
    
    let newDifficulty = minerData.stats.difficulty;
    
    if (actualShareTime < this.options.vardiffTarget * 0.5) {
      // Too many shares, increase difficulty
      newDifficulty = Math.min(minerData.stats.difficulty * 2, 65536);
    } else if (actualShareTime > this.options.vardiffTarget * 2) {
      // Too few shares, decrease difficulty
      newDifficulty = Math.max(minerData.stats.difficulty / 2, 1);
    }
    
    if (newDifficulty !== minerData.stats.difficulty) {
      minerData.stats.difficulty = newDifficulty;
      minerData.lastDifficultyAdjustment = Date.now();
      minerData.sharesAtLastAdjustment = minerData.stats.validShares;
      
      // Send new difficulty to miner
      const stratumMiner = this.stratumServer.miners.get(minerData.id);
      if (stratumMiner) {
        stratumMiner.difficulty = newDifficulty;
        this.stratumServer.sendDifficulty(stratumMiner);
      }
      
      logger.debug(`Adjusted difficulty for ${minerData.address}: ${newDifficulty}`);
    }
  }
  
  /**
   * Calculate block reward
   */
  calculateBlockReward(height) {
    // Bitcoin halving schedule
    const halvings = Math.floor(height / 210000);
    const reward = 50 / Math.pow(2, halvings);
    return reward;
  }
  
  /**
   * Clean old jobs
   */
  cleanOldJobs() {
    const maxJobs = 20;
    if (this.jobs.size > maxJobs) {
      const sortedJobs = Array.from(this.jobs.entries())
        .sort((a, b) => parseInt(a[0], 16) - parseInt(b[0], 16));
      
      const toRemove = sortedJobs.slice(0, sortedJobs.length - maxJobs);
      for (const [jobId] of toRemove) {
        this.jobs.delete(jobId);
      }
    }
  }
  
  /**
   * Start monitoring
   */
  startMonitoring() {
    // Statistics monitoring
    this.monitors.stats = setInterval(() => {
      this.updateStatistics();
      this.emit('stats', this.getStatistics());
    }, this.options.statsInterval);
    
    // Health monitoring
    this.monitors.health = setInterval(() => {
      this.updateHealth();
      this.checkAutoScaling();
    }, this.options.healthCheckInterval);
    
    logger.info('Monitoring started');
  }
  
  /**
   * Update statistics
   */
  updateStatistics() {
    // Calculate pool hashrate
    let poolHashrate = 0;
    for (const [, miner] of this.miners) {
      poolHashrate += miner.stats.hashrate || 0;
    }
    
    this.stats.performance.poolHashrate = poolHashrate;
    this.state.estimatedHashrate = poolHashrate;
    
    // Calculate shares per second
    const timeDiff = Date.now() - this.state.startTime;
    this.stats.performance.sharesPerSecond = this.state.totalShares / (timeDiff / 1000);
    
    // Calculate efficiency
    const totalShares = this.stats.shares.valid + this.stats.shares.invalid;
    this.stats.performance.poolEfficiency = totalShares > 0 
      ? (this.stats.shares.valid / totalShares) * 100 
      : 0;
  }
  
  /**
   * Update health status
   */
  updateHealth() {
    const wasHealthy = this.health.overall;
    
    // Check all components
    this.health.overall = 
      this.health.stratum && 
      this.health.blockchain && 
      this.health.database && 
      this.health.payments;
    
    if (wasHealthy && !this.health.overall) {
      logger.error('Pool health degraded');
      this.emit('health-degraded', this.health);
    } else if (!wasHealthy && this.health.overall) {
      logger.info('Pool health restored');
      this.emit('health-restored', this.health);
    }
  }
  
  /**
   * Check auto-scaling
   */
  checkAutoScaling() {
    if (!this.options.autoScaling) return;
    
    const utilization = this.miners.size / this.options.maxMiners;
    
    if (utilization > this.options.scaleUpThreshold) {
      this.emit('scale-up-needed', {
        currentCapacity: this.options.maxMiners,
        utilization: utilization * 100
      });
    } else if (utilization < this.options.scaleDownThreshold) {
      this.emit('scale-down-possible', {
        currentCapacity: this.options.maxMiners,
        utilization: utilization * 100
      });
    }
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      pool: {
        name: this.options.poolName,
        status: this.state.status,
        uptime: Date.now() - this.state.startTime,
        currentBlock: this.state.currentBlock?.height,
        networkDifficulty: this.state.networkDifficulty,
        connectedMiners: this.state.connectedMiners,
        hashrate: this.state.estimatedHashrate
      },
      shares: this.stats.shares,
      blocks: this.stats.blocks,
      miners: this.stats.miners,
      performance: this.stats.performance,
      health: this.health
    };
  }
  
  /**
   * Get miner statistics
   */
  getMinerStats(address) {
    const minerIds = this.minersByAddress.get(address) || [];
    
    let combinedStats = {
      workers: minerIds.length,
      shares: 0,
      validShares: 0,
      invalidShares: 0,
      hashrate: 0,
      blocksFound: 0
    };
    
    for (const minerId of minerIds) {
      const miner = this.miners.get(minerId);
      if (miner) {
        combinedStats.shares += miner.stats.shares;
        combinedStats.validShares += miner.stats.validShares;
        combinedStats.invalidShares += miner.stats.invalidShares;
        combinedStats.hashrate += miner.stats.hashrate;
        combinedStats.blocksFound += miner.stats.blocksFound || 0;
      }
    }
    
    return combinedStats;
  }
  
  /**
   * Shutdown pool
   */
  async shutdown() {
    logger.info('Shutting down pool...');
    
    this.state.status = 'stopping';
    
    // Stop monitoring
    for (const monitor of Object.values(this.monitors)) {
      if (monitor) clearInterval(monitor);
    }
    
    // Stop components
    if (this.stratumServer) {
      await this.stratumServer.stop();
    }
    
    if (this.shareValidator) {
      await this.shareValidator.shutdown();
    }
    
    if (this.paymentSystem) {
      await this.paymentSystem.shutdown();
    }
    
    if (this.blockchainMonitor) {
      await this.blockchainMonitor.stop();
    }
    
    if (this.database) {
      await this.database.close();
    }
    
    this.state.status = 'stopped';
    logger.info('Pool shutdown complete');
    
    this.emit('shutdown');
  }
}

module.exports = EnhancedPoolManager;