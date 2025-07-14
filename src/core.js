import { EventEmitter } from 'events';
import { ConfigManager } from './config.js';
import { Logger } from './logger.js';
import { OtedamaDB } from './database.js';
import { SecurityManager } from './security-manager.js';
import { P2PNetwork } from './p2p-network.js';
import { WorkerPool } from './worker-pool.js';
import { MiningEngine } from './mining-engine.js';
import { StratumServer } from './stratum-server.js';
import { APIServer } from './api-server.js';
import { UnifiedDEX } from './unified-dex.js';
import { FeeManager } from './fee-manager.js';
import { PaymentManager } from './payment-manager.js';
import { LendingProtocol } from './defi-lending.js';
import { CrossChainBridge } from './cross-chain.js';
import { GovernanceProtocol } from './governance.js';
import { PerformanceOptimizer } from './performance-optimizer.js';
import { AutoRecovery } from './auto-recovery.js';
import { BackupManager } from './backup-manager.js';
import { MonitoringSystem } from './monitoring-system.js';
import { DDoSProtection } from './ddos-protection.js';
import { RateLimiter } from './rate-limiter.js';
import { AuthenticationSystem } from './authentication.js';
import { ALGO_CONFIG } from './constants.js';

/**
 * Otedama Core - Central coordination of all components
 * 運営側の手数料は自動的にBTCで徴収され、改変不可能です。
 * マイニング報酬は自動的に支払われます。
 * DEX/DeFiは完全自動で運営されます。
 */
export class OtedamaCore extends EventEmitter {
  constructor() {
    super();
    this.logger = new Logger('Core');
    this.config = new ConfigManager();
    this.components = {};
    this.startTime = Date.now();
    
    // Immutable operator BTC address (cannot be changed)
    this.OPERATOR_BTC_ADDRESS = '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';
    this.OPERATOR_FEE_RATE = 0.001; // 0.1% fixed
  }

  async initialize() {
    this.logger.info('Initializing core components...');

    try {
      // Initialize database with batching optimization
      this.components.db = new OtedamaDB();
      await this.components.db.initialize();
      global.db = this.components.db;
      this.logger.info('Database initialized with query batching optimization');
      
      // Initialize security
      this.components.security = new SecurityManager();
      global.security = this.components.security;
      
      // Initialize DDoS protection
      this.components.ddosProtection = new DDoSProtection({
        maxRequestsPerWindow: 1000,
        maxConnectionsPerIP: 20,
        enableChallenge: true,
        enableAdaptive: true
      });
      global.ddosProtection = this.components.ddosProtection;
      this.logger.info('DDoS protection system initialized');
      
      // Initialize rate limiter
      this.components.rateLimiter = new RateLimiter({
        api: { windowMs: 60000, maxRequests: 1000 },
        stratum: { maxConnectionsPerIP: 10 },
        dex: { maxTransactions: 100 },
        mining: { maxSharesPerMiner: 10000 }
      });
      global.rateLimiter = this.components.rateLimiter;
      this.logger.info('Rate limiting system initialized');
      
      // Initialize authentication system
      this.components.auth = new AuthenticationSystem(this.components.db, {
        jwtSecret: this.config.get('auth.jwtSecret'),
        mfaEnabled: true,
        maxLoginAttempts: 5
      });
      await this.components.auth.initialize();
      global.auth = this.components.auth;
      this.logger.info('Authentication system initialized');
      
      // Initialize fee manager (IMMUTABLE OPERATOR FEE SYSTEM)
      this.components.feeManager = new FeeManager(this.config, this.components.db);
      this.components.feeManager.setOperatorAddress(this.OPERATOR_BTC_ADDRESS);
      this.components.feeManager.setOperatorFeeRate(this.OPERATOR_FEE_RATE);
      global.feeManager = this.components.feeManager;
      this.logger.info('Fee manager initialized with IMMUTABLE settings');
      
      // Initialize payment manager (AUTOMATED PAYMENT SYSTEM)
      this.components.paymentManager = new PaymentManager(
        this.config,
        this.components.db,
        this.components.feeManager
      );
      global.paymentManager = this.components.paymentManager;
      this.logger.info('Automated payment manager initialized');
      
      // Initialize P2P network with latency optimization
      this.components.p2p = new P2PNetwork(
        this.config.get('network.p2pPort'),
        this.config.get('network.maxPeers'),
        {
          enableBandwidthControl: true,
          enablePeerValidation: true,
          connectionTimeout: 30000,
          maxMessageSize: 1024 * 1024 // 1MB
        }
      );
      global.p2p = this.components.p2p;
      this.logger.info('P2P network initialized with latency optimization');
      
      // Initialize Unified DEX (V2 AMM + V3 Concentrated Liquidity)
      this.components.dex = new UnifiedDEX(this.components.feeManager);
      global.dex = this.components.dex;
      this.logger.info('Unified DEX system initialized with V2 AMM and V3 concentrated liquidity');
      
      // Initialize lending protocol (AUTOMATED DEFI)
      this.components.lending = new LendingProtocol(
        this.components.feeManager,
        this.components.dex // Use unified DEX as price oracle
      );
      global.lending = this.components.lending;
      this.logger.info('Automated lending protocol initialized');
      
      // Initialize cross-chain bridge (AUTOMATED BRIDGE)
      this.components.bridge = new CrossChainBridge(this.components.feeManager);
      global.bridge = this.components.bridge;
      this.logger.info('Automated cross-chain bridge initialized');
      
      // Initialize governance (AUTOMATED GOVERNANCE)
      this.components.governance = new GovernanceProtocol(this.components.feeManager);
      global.governance = this.components.governance;
      this.logger.info('Automated governance protocol initialized');
      
      // Initialize performance optimizer
      this.components.performance = new PerformanceOptimizer();
      global.performance = this.components.performance;
      this.logger.info('Performance optimizer initialized');
      
      // Initialize auto recovery system
      this.components.autoRecovery = new AutoRecovery(this);
      global.autoRecovery = this.components.autoRecovery;
      this.logger.info('Auto recovery system initialized');
      
      // Initialize backup manager
      this.components.backupManager = new BackupManager(this.config, this.components.db);
      global.backupManager = this.components.backupManager;
      this.logger.info('Automated backup system initialized');
      
      // Initialize monitoring system
      this.components.monitoring = new MonitoringSystem();
      global.monitoring = this.components.monitoring;
      this.logger.info('Advanced monitoring system initialized');
      
      // Initialize mining engine if enabled
      if (this.config.get('mining.enabled')) {
        const wallet = this.config.get('mining.walletAddress');
        if (!wallet) {
          this.logger.warn('Mining disabled: No wallet address configured');
        } else {
          this.components.mining = new MiningEngine(this.config.get('mining'));
          global.mining = this.components.mining;
          
          // Connect mining rewards to automated payment system
          this.components.mining.on('share', async (share) => {
            if (share.valid) {
              const reward = this.calculateReward(share.difficulty);
              await this.components.paymentManager.creditMiner(
                'local',
                wallet,
                reward,
                this.config.get('mining.currency')
              );
              
              // Automatic operator fee collection
              await this.components.feeManager.collectOperatorFee(
                reward,
                this.config.get('mining.currency')
              );
            }
          });
        }
      }
      
      // Initialize Stratum server
      this.components.stratum = new StratumServer(this.config.data);
      global.stratum = this.components.stratum;
      
      // Connect stratum to automated payment system
      this.components.stratum.on('share', async (share) => {
        if (share.valid && share.wallet) {
          const reward = this.calculateReward(share.difficulty);
          await this.components.paymentManager.creditMiner(
            share.clientId,
            share.wallet,
            reward,
            this.config.get('mining.currency')
          );
          
          // Automatic operator fee collection (IMMUTABLE)
          await this.components.feeManager.collectOperatorFee(
            reward,
            this.config.get('mining.currency')
          );
        }
      });
      
      // Initialize API server with security
      this.components.api = new APIServer({
        ...this.config.data,
        auth: this.components.auth,
        rateLimiter: this.components.rateLimiter,
        ddosProtection: this.components.ddosProtection
      });
      global.api = this.components.api;
      this.logger.info('API server initialized with enhanced security');
      
      // Setup automated event handlers
      this.setupAutomatedEventHandlers();
      
      // Start automated background processes
      this.startAutomatedProcesses();
      
      this.logger.info('Core initialization complete - All systems automated');
      
    } catch (error) {
      this.logger.error('Initialization failed:', error);
      throw error;
    }
  }

  async start() {
    this.logger.info('Starting all automated services...');
    
    try {
      // Start P2P network
      await this.components.p2p.start();
      this.logger.info('P2P network started');
      
      // Start mining engine
      if (this.components.mining) {
        const algo = this.config.get('mining.algorithm');
        const difficulty = ALGO_CONFIG[algo]?.difficulty || 1000000;
        await this.components.mining.start({ difficulty });
        this.logger.info('Mining engine started');
      }
      
      // Start Stratum server
      await this.components.stratum.start();
      this.logger.info('Stratum server started');
      
      // Initialize automated default pools and protocols
      await this.initializeAutomatedDefaults();
      
      // Start API server
      await this.components.api.start();
      this.logger.info('API server started');
      
      // Start automated periodic broadcasts
      this.startAutomatedBroadcasts();
      
      this.logger.info('All automated services running - Zero manual intervention required');
      this.emit('ready');
      
    } catch (error) {
      this.logger.error('Startup failed:', error);
      throw error;
    }
  }

  async stop() {
    this.logger.info('Stopping all services...');
    
    // Stop automated processes
    if (this.automatedProcesses) {
      for (const process of this.automatedProcesses) {
        clearInterval(process);
      }
    }
    
    // Stop periodic broadcasts
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
    }
    
    // Stop components in reverse order
    const stopOrder = [
      'api', 'auth', 'rateLimiter', 'ddosProtection', 'monitoring', 
      'backupManager', 'autoRecovery', 'performance', 'bridge', 
      'governance', 'lending', 'dex', 'stratum', 'mining', 
      'p2p', 'paymentManager', 'feeManager', 'db'
    ];
    
    for (const component of stopOrder) {
      if (this.components[component]) {
        try {
          if (typeof this.components[component].stop === 'function') {
            await this.components[component].stop();
          } else if (typeof this.components[component].close === 'function') {
            await this.components[component].close();
          }
          this.logger.info(`${component} stopped`);
        } catch (error) {
          this.logger.error(`Error stopping ${component}:`, error.message);
        }
      }
    }
    
    this.logger.info('All services stopped');
  }

  setupAutomatedEventHandlers() {
    // Unified DEX automated events
    this.components.dex.on('swap', (data) => {
      this.broadcast('dex', { event: 'swap', ...data });
    });
    
    this.components.dex.on('liquidity:added', (data) => {
      this.broadcast('dex', { event: 'liquidity:added', ...data });
    });
    
    this.components.dex.on('pool:created', (data) => {
      this.broadcast('dex', { event: 'pool:created', ...data });
    });
    
    this.components.dex.on('arbitrage:detected', (data) => {
      this.broadcast('dex', { event: 'arbitrage:detected', ...data });
    });
    
    // Lending automated events
    this.components.lending.on('supply', (data) => {
      this.broadcast('lending', { event: 'supply', ...data });
      // Automated interest calculation
      this.components.lending.updateInterestRates(data.asset);
    });
    
    this.components.lending.on('borrow', (data) => {
      this.broadcast('lending', { event: 'borrow', ...data });
      // Automated collateral health check
      this.components.lending.checkCollateralHealth(data.borrower);
    });
    
    this.components.lending.on('liquidation', (data) => {
      this.broadcast('lending', { event: 'liquidation', ...data });
    });
    
    // Bridge automated events
    this.components.bridge.on('transfer:initiated', (data) => {
      this.broadcast('bridge', { event: 'transfer:initiated', ...data });
      // Automated cross-chain relay
      this.components.bridge.autoRelay(data.transferId);
    });
    
    // Governance automated events
    this.components.governance.on('proposal:created', (data) => {
      this.broadcast('governance', { event: 'proposal:created', ...data });
    });
    
    this.components.governance.on('vote:cast', (data) => {
      this.broadcast('governance', { event: 'vote:cast', ...data });
      // Automated proposal execution if passed
      this.components.governance.checkProposalExecution(data.proposalId);
    });
    
    // Performance optimization events
    this.components.performance.on('optimization', (data) => {
      this.logger.info(`Performance optimization triggered: ${data.name}`);
      this.broadcast('performance', { event: 'optimization', ...data });
    });
    
    this.components.performance.on('gc', (data) => {
      this.logger.debug(`Garbage collection completed: ${Math.round(data.freed / 1024 / 1024)}MB freed`);
    });
    
    // Auto recovery events
    this.components.autoRecovery.on('component:recovered', (data) => {
      this.logger.info(`Component recovered: ${data.component}`);
      this.broadcast('recovery', { event: 'recovered', ...data });
    });
    
    this.components.autoRecovery.on('component:failed', (data) => {
      this.logger.error(`Component failed: ${data.component} - ${data.reason}`);
      this.broadcast('recovery', { event: 'failed', ...data });
    });
    
    this.components.autoRecovery.on('health:check', (health) => {
      this.broadcast('health', health);
    });
    
    // Backup events
    this.components.backupManager.on('backup:complete', (data) => {
      this.logger.info(`Backup completed: ${data.id} (${data.size} bytes)`);
      this.broadcast('backup', { event: 'complete', ...data });
    });
    
    this.components.backupManager.on('backup:failed', (data) => {
      this.logger.error(`Backup failed: ${data.error}`);
      this.broadcast('backup', { event: 'failed', ...data });
    });
    
    // Monitoring events
    this.components.monitoring.on('alert:triggered', (alert) => {
      this.logger.warn(`Alert triggered: ${alert.name}`, alert.data);
      this.broadcast('alert', { event: 'triggered', ...alert });
    });
    
    this.components.monitoring.on('alert:cleared', (data) => {
      this.logger.info(`Alert cleared: ${data.name}`);
      this.broadcast('alert', { event: 'cleared', ...data });
    });
    
    // Mining automated events
    if (this.components.mining) {
      this.components.mining.on('block', (block) => {
        this.broadcast('mining', { event: 'block', block });
        // Automated block reward distribution
        this.components.paymentManager.distributeBlockReward(block);
      });
    }
    
    // Stratum automated events
    this.components.stratum.on('miner:connected', (minerId) => {
      this.broadcast('miners', { event: 'connected', minerId });
      // Automated difficulty adjustment for new miner
      this.components.stratum.autoAdjustDifficulty(minerId);
    });
    
    this.components.stratum.on('miner:disconnected', (minerId) => {
      this.broadcast('miners', { event: 'disconnected', minerId });
    });
  }

  startAutomatedProcesses() {
    this.automatedProcesses = [];
    
    // Automated fee collection every 5 minutes (IMMUTABLE)
    this.automatedProcesses.push(setInterval(() => {
      this.components.feeManager.processOperatorFeeCollection();
    }, 300000)); // 5 minutes
    
    // Automated payment processing every hour
    this.automatedProcesses.push(setInterval(() => {
      this.components.paymentManager.processAutomaticPayouts();
    }, 3600000)); // 1 hour
    
    // Automated DEX processes are handled internally by UnifiedDEX
    // No need for external interval management
    
    // Automated lending liquidations every 2 minutes
    this.automatedProcesses.push(setInterval(() => {
      this.components.lending.processAutomaticLiquidations();
    }, 120000)); // 2 minutes
    
    // Automated cross-chain relaying every 30 seconds
    this.automatedProcesses.push(setInterval(() => {
      this.components.bridge.processAutomaticRelays();
    }, 30000)); // 30 seconds
    
    // Automated governance execution every 15 minutes
    this.automatedProcesses.push(setInterval(() => {
      this.components.governance.processAutomaticExecutions();
    }, 900000)); // 15 minutes
    
    this.logger.info('All automated background processes started');
  }

  startAutomatedBroadcasts() {
    this.broadcastTimer = setInterval(() => {
      const stats = this.getAutomatedStats();
      this.broadcast('stats', stats);
    }, 5000);
  }

  broadcast(channel, data) {
    if (this.components.api) {
      this.components.api.broadcast(channel, data);
    }
  }

  async initializeAutomatedDefaults() {
    try {
      // V2 Pools (automated market making)
      const v2Pools = [
        { token0: 'BTC', token1: 'USDT', fee: 0.003 },
        { token0: 'ETH', token1: 'USDT', fee: 0.003 },
        { token0: 'RVN', token1: 'USDT', fee: 0.003 },
        { token0: 'XMR', token1: 'USDT', fee: 0.003 },
        { token0: 'LTC', token1: 'USDT', fee: 0.003 }
      ];
      
      for (const pool of v2Pools) {
        try {
          const result = this.components.dex.createV2Pool(pool.token0, pool.token1, pool.fee);
          
          if (!result.exists) {
            // Add initial automated liquidity
            const liquidityAmounts = {
              'BTC-USDT': ['10000000', '430000000000'], // 0.1 BTC, 43000 USDT
              'ETH-USDT': ['100000000', '250000000000'], // 1 ETH, 2500 USDT
              'RVN-USDT': ['100000000000', '3000000'], // 1000 RVN, 30 USDT
              'XMR-USDT': ['100000000', '15000000000'], // 1 XMR, 150 USDT
              'LTC-USDT': ['100000000', '8000000000'] // 1 LTC, 80 USDT
            };
            
            const pairKey = `${pool.token0}-${pool.token1}`;
            if (liquidityAmounts[pairKey]) {
              await this.components.dex.addLiquidity(
                pool.token0,
                pool.token1,
                liquidityAmounts[pairKey][0],
                liquidityAmounts[pairKey][1],
                { version: 'v2', provider: 'system' }
              );
              this.logger.info(`Initialized automated V2 pool ${result.poolId}`);
            }
          }
        } catch (e) {
          this.logger.debug(`V2 pool initialization error: ${e.message}`);
        }
      }
      
      // V3 Pools (concentrated liquidity with automated range management)
      const v3Pools = [
        { token0: 'BTC', token1: 'USDT', fee: 500 },  // 0.05% for stable pairs
        { token0: 'ETH', token1: 'USDT', fee: 3000 }, // 0.3% for medium volatility
        { token0: 'ETH', token1: 'BTC', fee: 3000 }
      ];
      
      for (const pool of v3Pools) {
        try {
          const initialPrices = {
            'BTC-USDT': 43000,
            'ETH-USDT': 2500,
            'ETH-BTC': 2500 / 43000
          };
          
          const price = initialPrices[`${pool.token0}-${pool.token1}`] || 1;
          const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(price) * 2 ** 96));
          
          const result = this.components.dex.createV3Pool(
            pool.token0,
            pool.token1,
            pool.fee,
            sqrtPriceX96
          );
          
          if (!result.exists) {
            this.logger.info(`Initialized automated V3 pool ${result.poolKey}`);
          }
        } catch (e) {
          this.logger.debug(`V3 pool initialization error: ${e.message}`);
        }
      }
      
      // Initialize automated lending markets
      const lendingMarkets = [
        { asset: 'BTC', collateralFactor: 0.75, liquidationThreshold: 0.85 },
        { asset: 'ETH', collateralFactor: 0.75, liquidationThreshold: 0.85 },
        { asset: 'USDT', collateralFactor: 0.80, liquidationThreshold: 0.90 },
        { asset: 'USDC', collateralFactor: 0.80, liquidationThreshold: 0.90 }
      ];
      
      for (const market of lendingMarkets) {
        try {
          this.components.lending.createMarket(market.asset, market);
          this.logger.info(`Created automated lending market for ${market.asset}`);
        } catch (e) {
          // Market might already exist
        }
      }
      
      // Initialize automated bridge liquidity
      const bridgeAssets = ['BTC', 'ETH', 'USDT'];
      const chains = ['ETH', 'BSC', 'POLYGON'];
      
      for (const chain of chains) {
        for (const asset of bridgeAssets) {
          this.components.bridge.addLiquidity(
            chain,
            asset,
            BigInt(1000e18), // Initial automated liquidity
            'system'
          );
        }
      }
      
      // Initialize automated governance token distribution
      this.components.governance.tokenBalances.set('system', BigInt(100000000e18)); // 100M tokens
      
      this.logger.info('All automated defaults initialized');
      
    } catch (error) {
      this.logger.warn('Failed to initialize automated defaults:', error.message);
    }
  }

  calculateReward(difficulty) {
    // Automated reward calculation with operator fee deduction
    const baseReward = 1000000000; // 10 coins in satoshi
    const adjustedReward = baseReward * (difficulty / 1000000);
    const operatorFee = adjustedReward * this.OPERATOR_FEE_RATE;
    return Math.floor(adjustedReward - operatorFee);
  }

  getAutomatedStats() {
    const poolStats = this.components.db.getPoolStats();
    const feeStats = this.components.feeManager.getStats();
    const paymentStats = this.components.paymentManager.getPaymentStats();
    const dexStats = this.components.dex.getStats();
    const lendingStats = this.components.lending ? this.components.lending.getGlobalStats() : null;
    const bridgeStats = this.components.bridge ? this.components.bridge.getStats() : null;
    const performanceStats = this.components.performance ? this.components.performance.getPerformanceReport() : null;
    const dbBatcherStats = this.components.db ? this.components.db.getBatcherReport() : null;
    const p2pNetworkStats = this.components.p2p ? this.components.p2p.getNetworkStats() : null;
    const ddosStats = this.components.ddosProtection ? this.components.ddosProtection.getStats() : null;
    const rateLimiterStats = this.components.rateLimiter ? this.components.rateLimiter.getStats() : null;
    const authStats = this.components.auth ? this.components.auth.getStats() : null;
    
    const memUsage = process.memoryUsage();
    
    return {
      pool: {
        miners: this.components.stratum?.getConnectionCount() || 0,
        hashrate: this.components.stratum?.getTotalHashrate() || 0,
        shares: poolStats,
        efficiency: poolStats.total > 0 ? ((poolStats.valid / poolStats.total) * 100).toFixed(2) : '100.00'
      },
      fees: {
        ...feeStats,
        operatorAddress: this.OPERATOR_BTC_ADDRESS,
        operatorFeeRate: this.OPERATOR_FEE_RATE,
        collectedToday: feeStats.collectedToday || 0
      },
      payments: {
        ...paymentStats,
        automaticPayouts: true,
        lastPayout: paymentStats.lastPayout
      },
      dex: dexStats,
      lending: {
        ...lendingStats,
        autoLiquidation: true
      },
      bridge: {
        ...bridgeStats,
        autoRelay: true
      },
      mining: this.components.mining?.getStats() || null,
      p2p: {
        peers: this.components.p2p?.getPeerCount() || 0
      },
      automation: {
        operatorFeeCollection: true,
        automaticPayouts: true,
        dexRebalancing: true,
        lendingLiquidation: true,
        bridgeRelaying: true,
        governanceExecution: true,
        performanceOptimization: true,
        autoRecovery: true,
        autoBackup: true,
        monitoring: true
      },
      performance: performanceStats,
      optimization: {
        databaseBatcher: dbBatcherStats,
        networkOptimization: p2pNetworkStats?.optimization
      },
      security: {
        ddos: ddosStats,
        rateLimiter: rateLimiterStats,
        authentication: authStats,
        activeSessions: authStats?.currentSessions || 0,
        blockedIPs: ddosStats?.currentBlacklisted || 0
      },
      health: this.components.autoRecovery ? this.components.autoRecovery.getSystemHealth() : null,
      monitoring: this.components.monitoring ? this.components.monitoring.getCurrentMetrics() : null,
      backup: {
        lastBackup: this.components.backupManager?.lastBackupTime || 0,
        backups: this.components.backupManager?.getBackupList().length || 0
      },
      system: {
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        memory: Math.round(memUsage.heapUsed / 1024 / 1024),
        version: '0.5',
        fullyAutomated: true
      }
    };
  }
}
