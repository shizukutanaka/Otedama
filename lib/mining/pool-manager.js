/**
 * Otedama Mining Pool Manager
 * Unified, production-ready mining pool system
 * 
 * Integrates:
 * - P2P mining pool with federation
 * - Enhanced Stratum V2 server
 * - Real blockchain payments
 * - Advanced ASIC support
 * - Hardware detection and optimization
 * - Enterprise monitoring
 * 
 * Design: Performance-first, clean architecture, simplicity
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { P2PMiningPool } from './p2p-mining-pool.js';
import { StratumV2Server } from './stratum-v2/stratum-v2-server.js';
import { EnhancedPaymentProcessor } from './enhanced-payment-processor.js';
import { EnhancedASICController } from './enhanced-asic-controller.js';
import { HardwareDetector } from './hardware/hardware-detector.js';
import { createStorageManager } from '../storage/index.js';
import { createMonitoringSystem } from '../monitoring/index.js';
import { configManager } from '../core/config-manager.js';
import { healthCheckManager } from '../core/health-check.js';
import { createAPIServer } from '../api/pool-api-server.js';
import { profiler } from '../core/profiler.js';
import { AutoScalingManager } from '../core/auto-scaling.js';
import { MultiCoinProfitSwitcher } from './multi-coin-profit-switcher.js';
import { MiningAnalytics } from './analytics.js';
import { FaultRecoverySystem } from '../core/fault-recovery.js';
import { RemoteManagementAPI } from '../api/remote-management.js';
import { initializeAutomation } from '../automation/index.js';
import { SoloMiningManager } from './solo-mining-manager.js';
import { SoloPoolIntegration, MiningMode } from './solo-pool-integration.js';
import { MultiCoinPayoutManager, PayoutCurrency } from './multi-coin-payout-manager.js';
import cluster from 'cluster';
import os from 'os';

const logger = createLogger('MiningPoolManager');

/**
 * Pool operating modes
 */
export const PoolMode = {
  STANDALONE: 'standalone',    // Single pool instance
  FEDERATED: 'federated',      // P2P federated pool
  CLUSTER: 'cluster',          // Multi-process cluster
  HYBRID: 'hybrid'             // Combination of modes
};

/**
 * Otedama Mining Pool Manager
 */
export class OtedamaMiningPoolManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    // Load configuration
    this.config = this.loadConfiguration(config);
    
    // Core components
    this.storage = null;
    this.monitoring = null;
    this.pool = null;
    this.stratumV2 = null;
    this.paymentProcessor = null;
    this.asicController = null;
    this.hardwareDetector = null;
    this.apiServer = null;
    
    // Advanced components
    this.autoScaling = null;
    this.profitSwitcher = null;
    this.analytics = null;
    this.faultRecovery = null;
    this.remoteManagement = null;
    
    // Automation systems
    this.automation = null;
    
    // Solo mining manager
    this.soloMiningManager = null;
    this.soloPoolIntegration = null;
    
    // Multi-coin payout manager
    this.multiCoinPayoutManager = null;
    
    // Cluster management
    this.workers = new Map();
    this.isClusterMaster = cluster.isMaster || cluster.isPrimary;
    
    // Statistics
    this.stats = {
      startTime: Date.now(),
      poolMode: this.config.poolMode,
      totalMiners: 0,
      totalHashrate: 0,
      totalShares: 0,
      blocksFound: 0,
      totalPayments: 0
    };
    
    // Health checks
    this.setupHealthChecks();
  }
  
  /**
   * Load configuration with defaults
   */
  loadConfiguration(config) {
    const defaults = {
      // Pool settings
      poolName: 'Otedama Mining Pool',
      poolMode: PoolMode.HYBRID,
      algorithm: 'sha256',
      paymentScheme: 'PPLNS',
      minimumPayment: 0.001,
      poolFee: 0.01,
      
      // Network settings
      stratumPort: 3333,
      stratumV2Port: 3336,
      p2pPort: 8333,
      apiPort: 8080,
      
      // Performance settings
      workerProcesses: Math.min(4, os.cpus().length),
      shareValidationWorkers: 8,
      maxConnections: 10000,
      
      // Hardware settings
      enableCPUMining: true,
      enableGPUMining: true,
      enableASICMining: true,
      asicDiscovery: true,
      
      // Storage settings
      dataDir: './data',
      dbFile: 'otedama-pool.db',
      
      // Blockchain settings
      blockchainRPC: {
        bitcoin: {
          enabled: true,
          rpcUrl: process.env.BITCOIN_RPC_URL || 'http://localhost:8332',
          rpcUser: process.env.BITCOIN_RPC_USER || 'user',
          rpcPassword: process.env.BITCOIN_RPC_PASSWORD || 'pass'
        }
      },
      
      // Security settings
      enableDDoSProtection: true,
      enableSSL: false,
      sslCert: null,
      sslKey: null,
      
      // Advanced features
      enableAutoScaling: true,
      enableProfitSwitching: false,
      enableAnalytics: true,
      enableFaultRecovery: true,
      enableRemoteManagement: true,
      remoteManagementPort: 9443,
      adminKeys: config.adminKeys || [],
      
      // Automation systems
      enableAutomation: true,
      automation: {
        enableAutoDeployment: true,
        enableAutoBackup: true,
        enableAutoTuning: true,
        enableSecurityMonitoring: true
      },
      
      // Solo mining settings
      enableSoloMining: config.soloMining?.enabled || false,
      soloMining: {
        enabled: config.soloMining?.enabled || false,
        coinbaseAddress: config.soloMining?.payoutAddress || config.soloCoinbaseAddress || null,
        fee: config.soloMining?.fee || 0.005, // 0.5% - industry's lowest!
        minPayout: config.soloMining?.minPayout || 0, // No minimum for solo
        shareAllocationRatio: config.soloMining?.resourceAllocation || 0.5, // 50% of resources
        blockUpdateInterval: config.soloMining?.blockUpdateInterval || 15000, // 15 seconds
        threads: config.soloMining?.threads || Math.max(1, Math.floor(os.cpus().length / 4)),
        separateStratumPort: config.soloMining?.separateStratumPort || 3334
      }
    };
    
    // Merge with environment variables and provided config
    return configManager.merge(defaults, config);
  }
  
  /**
   * Initialize mining pool manager
   */
  async initialize() {
    const initTimer = profiler.createTimer('pool-initialization');
    
    try {
      logger.info('Initializing Otedama Mining Pool Manager...');
      logger.info(`Pool Mode: ${this.config.poolMode}`);
      logger.info(`Algorithm: ${this.config.algorithm}`);
      logger.info(`Payment Scheme: ${this.config.paymentScheme}`);
      
      // Initialize storage
      await this.initializeStorage();
      
      // Initialize monitoring
      await this.initializeMonitoring();
      
      // Initialize based on mode
      switch (this.config.poolMode) {
        case PoolMode.CLUSTER:
          await this.initializeCluster();
          break;
          
        case PoolMode.FEDERATED:
          await this.initializeFederated();
          break;
          
        case PoolMode.HYBRID:
          await this.initializeHybrid();
          break;
          
        default:
          await this.initializeStandalone();
      }
      
      // Initialize hardware detection
      if (this.config.enableCPUMining || this.config.enableGPUMining) {
        await this.initializeHardwareDetection();
      }
      
      // Initialize ASIC controller
      if (this.config.enableASICMining) {
        await this.initializeASICController();
      }
      
      // Initialize API server
      await this.initializeAPIServer();
      
      // Initialize advanced features
      if (this.config.enableAutoScaling && this.isClusterMaster) {
        await this.initializeAutoScaling();
      }
      
      if (this.config.enableProfitSwitching) {
        await this.initializeProfitSwitching();
      }
      
      if (this.config.enableAnalytics) {
        await this.initializeAnalytics();
      }
      
      if (this.config.enableFaultRecovery) {
        await this.initializeFaultRecovery();
      }
      
      if (this.config.enableRemoteManagement) {
        await this.initializeRemoteManagement();
      }
      
      // Initialize automation systems
      if (this.config.enableAutomation && this.isClusterMaster) {
        await this.initializeAutomationSystems();
      }
      
      // Initialize solo mining if enabled
      if (this.config.enableSoloMining || this.config.soloMining.enabled) {
        await this.initializeSoloMining();
        await this.initializeSoloPoolIntegration();
      }
      
      // Initialize multi-coin payout system
      if (this.config.payouts?.multiCoinEnabled) {
        await this.initializeMultiCoinPayouts();
      }
      
      initTimer.end();
      logger.info(`Pool initialization completed in ${initTimer.getDuration()}ms`);
      
      this.emit('initialized');
      
    } catch (error) {
      initTimer.end();
      logger.error('Pool initialization failed:', error);
      throw error;
    }
  }
  
  /**
   * Initialize storage system
   */
  async initializeStorage() {
    logger.info('Initializing storage system...');
    
    this.storage = createStorageManager({
      dataDir: this.config.dataDir,
      dbFile: this.config.dbFile,
      enableCache: true,
      cacheSize: 100 * 1024 * 1024 // 100MB
    });
    
    await this.storage.initialize();
    
    // Run migrations
    await this.storage.database.migrate();
    
    logger.info('Storage system initialized');
  }
  
  /**
   * Initialize monitoring system
   */
  async initializeMonitoring() {
    logger.info('Initializing monitoring system...');
    
    this.monitoring = createMonitoringSystem({
      enablePrometheus: true,
      prometheusPort: 9090,
      enableWebSocket: true,
      wsPort: 8081
    });
    
    await this.monitoring.start();
    
    // Register custom metrics
    this.monitoring.registerGauge('pool_miners_total', 'Total connected miners');
    this.monitoring.registerGauge('pool_hashrate_total', 'Total pool hashrate');
    this.monitoring.registerCounter('pool_shares_total', 'Total shares submitted');
    this.monitoring.registerCounter('pool_blocks_found', 'Total blocks found');
    
    logger.info('Monitoring system initialized');
  }
  
  /**
   * Initialize standalone mode
   */
  async initializeStandalone() {
    logger.info('Initializing standalone pool...');
    
    // Create P2P mining pool
    this.pool = new P2PMiningPool({
      ...this.config,
      p2pEnabled: false
    });
    
    await this.setupPoolHandlers();
    await this.pool.start();
    
    // Initialize payment processor
    await this.initializePaymentProcessor();
    
    // Start Stratum V2 if enabled
    if (this.config.stratumV2Port) {
      await this.initializeStratumV2();
    }
  }
  
  /**
   * Initialize federated mode
   */
  async initializeFederated() {
    logger.info('Initializing federated pool...');
    
    // Create P2P mining pool with federation enabled
    this.pool = new P2PMiningPool({
      ...this.config,
      p2pEnabled: true,
      maxPeers: 50
    });
    
    await this.setupPoolHandlers();
    await this.pool.start();
    
    // Initialize payment processor
    await this.initializePaymentProcessor();
    
    // Start Stratum V2
    if (this.config.stratumV2Port) {
      await this.initializeStratumV2();
    }
  }
  
  /**
   * Initialize cluster mode
   */
  async initializeCluster() {
    if (this.isClusterMaster) {
      logger.info('Initializing cluster master...');
      
      // Fork worker processes
      for (let i = 0; i < this.config.workerProcesses; i++) {
        this.forkWorker();
      }
      
      // Handle worker messages
      cluster.on('message', (worker, message) => {
        this.handleWorkerMessage(worker, message);
      });
      
      // Handle worker exit
      cluster.on('exit', (worker, code, signal) => {
        logger.error(`Worker ${worker.process.pid} died (${signal || code})`);
        this.workers.delete(worker.id);
        
        // Restart worker
        if (!this.isShuttingDown) {
          this.forkWorker();
        }
      });
      
    } else {
      // Worker process
      logger.info(`Initializing cluster worker ${process.pid}...`);
      await this.initializeStandalone();
    }
  }
  
  /**
   * Initialize hybrid mode
   */
  async initializeHybrid() {
    logger.info('Initializing hybrid pool...');
    
    if (this.isClusterMaster) {
      // Master process handles P2P federation
      this.pool = new P2PMiningPool({
        ...this.config,
        p2pEnabled: true,
        port: null // Don't bind stratum in master
      });
      
      await this.setupPoolHandlers();
      await this.pool.startP2PNetwork();
      
      // Fork worker processes for stratum handling
      for (let i = 0; i < this.config.workerProcesses; i++) {
        this.forkWorker();
      }
      
      // Initialize payment processor in master
      await this.initializePaymentProcessor();
      
    } else {
      // Worker processes handle stratum connections
      const workerPort = this.config.stratumPort + cluster.worker.id;
      
      this.pool = new P2PMiningPool({
        ...this.config,
        port: workerPort,
        p2pEnabled: false
      });
      
      await this.setupPoolHandlers();
      await this.pool.start();
    }
  }
  
  /**
   * Fork worker process
   */
  forkWorker() {
    const worker = cluster.fork();
    this.workers.set(worker.id, {
      id: worker.id,
      pid: worker.process.pid,
      startTime: Date.now(),
      stats: {
        connections: 0,
        shares: 0,
        hashrate: 0
      }
    });
    
    logger.info(`Forked worker ${worker.process.pid}`);
  }
  
  /**
   * Handle worker message
   */
  handleWorkerMessage(worker, message) {
    switch (message.type) {
      case 'stats':
        const workerInfo = this.workers.get(worker.id);
        if (workerInfo) {
          workerInfo.stats = message.data;
          this.updateClusterStats();
        }
        break;
        
      case 'share':
        // Broadcast share to other workers if needed
        this.broadcastToWorkers(message, worker.id);
        break;
        
      case 'block':
        // Handle block found by worker
        this.handleBlockFound(message.data);
        break;
    }
  }
  
  /**
   * Broadcast message to workers
   */
  broadcastToWorkers(message, excludeId = null) {
    for (const [id, worker] of this.workers) {
      if (id !== excludeId && worker.send) {
        worker.send(message);
      }
    }
  }
  
  /**
   * Update cluster statistics
   */
  updateClusterStats() {
    let totalConnections = 0;
    let totalShares = 0;
    let totalHashrate = 0;
    
    for (const worker of this.workers.values()) {
      totalConnections += worker.stats.connections || 0;
      totalShares += worker.stats.shares || 0;
      totalHashrate += worker.stats.hashrate || 0;
    }
    
    this.stats.totalMiners = totalConnections;
    this.stats.totalShares = totalShares;
    this.stats.totalHashrate = totalHashrate;
    
    // Update monitoring
    this.monitoring.setGauge('pool_miners_total', totalConnections);
    this.monitoring.setGauge('pool_hashrate_total', totalHashrate);
  }
  
  /**
   * Initialize payment processor
   */
  async initializePaymentProcessor() {
    logger.info('Initializing payment processor...');
    
    this.paymentProcessor = new EnhancedPaymentProcessor({
      scheme: this.config.paymentScheme,
      minimumPayment: this.config.minimumPayment,
      poolFee: this.config.poolFee,
      paymentInterval: this.config.paymentInterval || 3600000,
      blockchain: this.config.blockchainRPC,
      poolPrivateKey: this.config.poolPrivateKey,
      poolAddress: this.config.poolAddress
    });
    
    await this.paymentProcessor.initialize(this.storage);
    
    // Handle payment events
    this.paymentProcessor.on('payment:sent', (payment) => {
      this.stats.totalPayments++;
      this.monitoring.incrementCounter('pool_payments_sent', 1);
      this.emit('payment:sent', payment);
    });
    
    logger.info('Payment processor initialized');
  }
  
  /**
   * Initialize Stratum V2 server
   */
  async initializeStratumV2() {
    logger.info('Initializing Stratum V2 server...');
    
    this.stratumV2 = new StratumV2Server({
      port: this.config.stratumV2Port,
      requireEncryption: this.config.enableSSL,
      certificatePath: this.config.sslCert,
      keyPath: this.config.sslKey
    });
    
    // Handle Stratum V2 events
    this.stratumV2.on('share:submitted', async ({ channel, share }) => {
      // Forward to pool for validation
      if (this.pool) {
        await this.pool.handleSubmit(
          { id: channel.connectionId, address: channel.userIdentity },
          null,
          [share.jobId, share.extranonce1, share.extranonce2, share.time, share.nonce]
        );
      }
    });
    
    // Forward new jobs
    if (this.pool) {
      this.pool.on('job:new', (job) => {
        this.stratumV2.broadcastNewJob(job);
      });
    }
    
    await this.stratumV2.start();
    logger.info(`Stratum V2 server started on port ${this.config.stratumV2Port}`);
  }
  
  /**
   * Initialize hardware detection
   */
  async initializeHardwareDetection() {
    logger.info('Initializing hardware detection...');
    
    this.hardwareDetector = new HardwareDetector();
    const hardware = await this.hardwareDetector.detect();
    
    logger.info('Detected hardware:');
    if (hardware.cpu) {
      logger.info(`  CPU: ${hardware.cpu.model} (${hardware.cpu.cores} cores)`);
    }
    
    for (const gpu of hardware.gpus) {
      logger.info(`  GPU: ${gpu.name} (${gpu.memory}MB)`);
    }
    
    for (const asic of hardware.asics) {
      logger.info(`  ASIC: ${asic.model}`);
    }
    
    this.emit('hardware:detected', hardware);
  }
  
  /**
   * Initialize ASIC controller
   */
  async initializeASICController() {
    logger.info('Initializing ASIC controller...');
    
    this.asicController = new EnhancedASICController({
      discoveryEnabled: this.config.asicDiscovery,
      autoConnect: true,
      poolConfig: {
        url: `stratum+tcp://localhost:${this.config.stratumPort}`,
        worker: 'asic',
        password: 'x'
      }
    });
    
    // Handle ASIC events
    this.asicController.on('device:added', (device) => {
      logger.info(`ASIC added: ${device.model} (${device.ip})`);
      this.emit('asic:added', device);
    });
    
    this.asicController.on('stats:updated', (stats) => {
      // Add ASIC hashrate to total
      this.stats.totalHashrate += stats.totalHashrate;
      this.monitoring.setGauge('asic_hashrate_total', stats.totalHashrate);
    });
    
    await this.asicController.initialize();
  }
  
  /**
   * Initialize API server
   */
  async initializeAPIServer() {
    logger.info('Initializing API server...');
    
    this.apiServer = createAPIServer(this, {
      port: this.config.apiPort,
      enableCORS: true,
      enableWebSocket: true
    });
    
    await this.apiServer.start();
    
    logger.info(`API server started on port ${this.config.apiPort}`);
    logger.info(`Web dashboard available at http://localhost:${this.config.apiPort}`);
  }
  
  /**
   * Initialize auto-scaling
   */
  async initializeAutoScaling() {
    logger.info('Initializing auto-scaling...');
    
    this.autoScaling = new AutoScalingManager({
      minWorkers: 2,
      maxWorkers: this.config.workerProcesses,
      scaleUpThreshold: 0.8,
      scaleDownThreshold: 0.3
    });
    
    // Register existing workers
    for (const [id, worker] of this.workers) {
      this.autoScaling.registerWorker(worker);
    }
    
    // Handle scaling events
    this.autoScaling.on('scale:up', () => {
      this.forkWorker();
    });
    
    this.autoScaling.on('scale:down', ({ workerId }) => {
      const worker = cluster.workers[workerId];
      if (worker) {
        worker.disconnect();
      }
    });
    
    this.autoScaling.start();
    logger.info('Auto-scaling initialized');
  }
  
  /**
   * Initialize profit switching
   */
  async initializeProfitSwitching() {
    logger.info('Initializing profit switching...');
    
    this.profitSwitcher = new MultiCoinProfitSwitcher({
      enabledCoins: this.config.enabledCoins || ['BTC', 'BCH', 'LTC'],
      defaultCoin: this.config.algorithm === 'sha256' ? 'BTC' : 'LTC',
      electricityCost: this.config.electricityCost || 0.10,
      poolFee: this.config.poolFee
    });
    
    // Handle coin switches
    this.profitSwitcher.on('coin:switched', async ({ from, to, config }) => {
      logger.info(`Switching from ${from} to ${to}`);
      
      // Update pool configuration
      this.config.algorithm = config.algorithm;
      
      // Restart pool with new coin
      if (this.pool) {
        await this.pool.stop();
        await this.pool.start();
      }
      
      this.emit('coin:switched', { from, to });
    });
    
    await this.profitSwitcher.start();
    logger.info('Profit switching initialized');
  }
  
  /**
   * Initialize analytics
   */
  async initializeAnalytics() {
    logger.info('Initializing mining analytics...');
    
    this.analytics = new MiningAnalytics(this.storage, {
      retentionDays: 30,
      analysisInterval: 300000 // 5 minutes
    });
    
    await this.analytics.initialize();
    
    // Handle analytics events
    this.analytics.on('anomaly:detected', (anomaly) => {
      logger.warn('Anomaly detected:', anomaly);
      this.emit('anomaly:detected', anomaly);
    });
    
    this.analytics.on('efficiency:alert', (alert) => {
      logger.warn('Efficiency alert:', alert);
      this.emit('efficiency:alert', alert);
    });
    
    // Start recording metrics
    setInterval(() => {
      this.analytics.recordMetrics(this.getStats());
    }, 60000); // Every minute
    
    logger.info('Mining analytics initialized');
  }
  
  /**
   * Initialize fault recovery
   */
  async initializeFaultRecovery() {
    logger.info('Initializing fault recovery system...');
    
    this.faultRecovery = new FaultRecoverySystem({
      checkInterval: 30000,
      maxRestarts: 3,
      notificationWebhook: this.config.alertWebhook
    });
    
    // Register components for monitoring
    if (this.pool) {
      this.faultRecovery.registerComponent('pool', this.pool);
    }
    
    if (this.stratumV2) {
      this.faultRecovery.registerComponent('stratumV2', this.stratumV2);
    }
    
    if (this.paymentProcessor) {
      this.faultRecovery.registerComponent('payments', this.paymentProcessor);
    }
    
    if (this.storage) {
      this.faultRecovery.registerComponent('storage', this.storage);
    }
    
    if (this.apiServer) {
      this.faultRecovery.registerComponent('api', this.apiServer);
    }
    
    // Handle critical failures
    this.faultRecovery.on('system:critical', async () => {
      logger.error('CRITICAL: System failure detected');
      // Could trigger emergency procedures
      this.emit('system:critical');
    });
    
    await this.faultRecovery.initialize();
    logger.info('Fault recovery system initialized');
  }
  
  /**
   * Initialize remote management
   */
  async initializeRemoteManagement() {
    logger.info('Initializing remote management API...');
    
    this.remoteManagement = new RemoteManagementAPI(this, {
      port: this.config.remoteManagementPort,
      adminKeys: this.config.adminKeys,
      authSecret: this.config.authSecret
    });
    
    await this.remoteManagement.start();
    
    logger.info(`Remote management API started on port ${this.config.remoteManagementPort}`);
  }
  
  /**
   * Initialize automation systems
   */
  async initializeAutomationSystems() {
    logger.info('Initializing automation systems...');
    
    this.automation = await initializeAutomation(this, {
      enableAutoDeployment: this.config.automation.enableAutoDeployment,
      enableAutoBackup: this.config.automation.enableAutoBackup,
      enableAutoTuning: this.config.automation.enableAutoTuning,
      enableSecurityMonitoring: this.config.automation.enableSecurityMonitoring,
      
      deployment: {
        healthCheckUrl: `http://localhost:${this.config.apiPort}/health`,
        rollbackOnFailure: true
      },
      
      backup: {
        backupDir: './backups',
        schedule: '0 2 * * *', // 2 AM daily
        retentionDays: 30,
        compressionEnabled: true,
        encryptionEnabled: true
      },
      
      tuning: {
        enabled: true,
        aggressiveness: 0.5,
        targets: {
          cpuUsage: 0.7,
          memoryUsage: 0.8,
          efficiency: 0.95
        }
      },
      
      security: {
        enabled: true,
        maxConnectionsPerIP: 5,
        maxSharesPerSecond: 100,
        alertWebhook: process.env.SECURITY_WEBHOOK
      }
    });
    
    // Setup automation event handlers
    if (this.automation.deployment) {
      this.automation.deployment.on('deployment:success', (deployment) => {
        logger.info('Deployment successful:', deployment.id);
        this.emit('deployment:success', deployment);
      });
    }
    
    if (this.automation.backup) {
      this.automation.backup.on('backup:success', (backup) => {
        logger.info('Backup successful:', backup.id);
        this.emit('backup:success', backup);
      });
    }
    
    if (this.automation.tuning) {
      this.automation.tuning.on('tuning:applied', (tuning) => {
        logger.info('Performance tuning applied:', tuning.recommendation.action);
        this.emit('tuning:applied', tuning);
      });
    }
    
    if (this.automation.security) {
      this.automation.security.on('threat:detected', (threat) => {
        logger.warn('Security threat detected:', threat);
        this.emit('security:threat', threat);
      });
    }
    
    logger.info('Automation systems initialized');
  }
  
  /**
   * Initialize solo mining
   */
  async initializeSoloMining() {
    logger.info('Initializing solo mining manager...');
    
    // Validate configuration
    if (!this.config.soloMining.coinbaseAddress) {
      logger.error('Solo mining enabled but no coinbase address provided');
      throw new Error('Coinbase address required for solo mining');
    }
    
    // Create solo mining manager
    this.soloMiningManager = new SoloMiningManager({
      // Blockchain RPC from pool config
      rpcUrl: this.config.blockchainRPC.bitcoin.rpcUrl,
      rpcUser: this.config.blockchainRPC.bitcoin.rpcUser,
      rpcPassword: this.config.blockchainRPC.bitcoin.rpcPassword,
      
      // Mining settings
      algorithm: this.config.algorithm,
      coinbaseAddress: this.config.soloMining.coinbaseAddress,
      coinbaseMessage: `Otedama Solo Mining - ${this.config.poolName}`,
      
      // Hardware allocation
      threads: this.config.soloMining.threads,
      cpuEnabled: this.config.enableCPUMining,
      gpuEnabled: this.config.enableGPUMining,
      asicEnabled: false, // ASICs handled by pool
      
      // Performance settings
      shareAllocationRatio: this.config.soloMining.shareAllocationRatio,
      blockUpdateInterval: this.config.soloMining.blockUpdateInterval
    });
    
    // Initialize solo mining
    await this.soloMiningManager.initialize();
    
    // Handle solo mining events
    this.soloMiningManager.on('block:found', (block) => {
      logger.info('Solo mining block found!', block);
      this.stats.blocksFound++; // Count solo blocks too
      this.monitoring.incrementCounter('solo_blocks_found', 1);
      this.emit('solo:block:found', block);
    });
    
    this.soloMiningManager.on('error', (error) => {
      logger.error('Solo mining error:', error);
      this.emit('solo:error', error);
    });
    
    // Register with monitoring
    this.monitoring.registerGauge('solo_hashrate', 'Solo mining hashrate');
    this.monitoring.registerCounter('solo_blocks_found', 'Solo blocks found');
    this.monitoring.registerGauge('solo_shares_processed', 'Solo shares processed');
    
    logger.info('Solo mining manager initialized');
  }
  
  /**
   * Initialize solo pool integration
   */
  async initializeSoloPoolIntegration() {
    logger.info('Initializing solo pool integration...');
    
    this.soloPoolIntegration = new SoloPoolIntegration({
      soloFee: this.config.soloMining.fee,
      poolFee: this.config.poolFee,
      minPayout: this.config.soloMining.minPayout,
      separatePort: this.config.soloMining.separateStratumPort !== this.config.stratumPort,
      soloPort: this.config.soloMining.separateStratumPort,
      allowModeSwitching: true
    });
    
    // Handle solo pool events
    this.soloPoolIntegration.on('solo:block:found', (block) => {
      logger.info('Solo block found through pool!', block);
      this.emit('solo:pool:block', block);
    });
    
    this.soloPoolIntegration.on('mode:switched', ({ minerId, oldMode, newMode }) => {
      logger.info(`Miner ${minerId} switched from ${oldMode} to ${newMode}`);
      this.emit('miner:mode:switched', { minerId, oldMode, newMode });
    });
    
    this.soloPoolIntegration.on('payout:processed', (payout) => {
      logger.info('Solo payout processed:', payout);
      this.emit('solo:payout', payout);
    });
    
    // Start cleanup timer
    setInterval(() => {
      this.soloPoolIntegration.cleanupInactiveMiners();
    }, 60000); // Every minute
    
    logger.info('Solo pool integration initialized');
  }
  
  /**
   * Initialize multi-coin payout system
   */
  async initializeMultiCoinPayouts() {
    logger.info('Initializing multi-coin payout system...');
    
    this.multiCoinPayoutManager = new MultiCoinPayoutManager({
      poolFee: this.config.payouts?.fees?.pool || this.config.poolFee,
      soloFee: this.config.payouts?.fees?.solo || this.config.soloMining.fee,
      conversionFee: this.config.payouts?.fees?.conversion || 0.003,
      
      primaryExchange: this.config.payouts?.exchange?.primary || 'binance',
      fallbackExchange: this.config.payouts?.exchange?.fallback || 'kraken',
      
      minPayoutNative: this.config.payouts?.minimums?.native || 0.001,
      minPayoutBTC: this.config.payouts?.minimums?.btc || 0.0001,
      
      supportedCoins: this.config.payouts?.supportedCoins || [
        'BTC', 'ETH', 'LTC', 'BCH', 'DOGE', 'RVN', 'ERG', 'KAS', 'ZEC', 'XMR'
      ],
      
      autoConvertThreshold: 0.01,
      bulkConvertInterval: this.config.payouts?.exchange?.bulkConvertInterval || 3600000,
      maxSlippage: this.config.payouts?.exchange?.maxSlippage || 0.01
    });
    
    // Handle payout events
    this.multiCoinPayoutManager.on('conversion:completed', (conversion) => {
      logger.info('Conversion completed:', conversion);
      this.emit('conversion:completed', conversion);
    });
    
    this.multiCoinPayoutManager.on('payout:processed', (payout) => {
      logger.info('Payout processed:', payout);
      this.emit('payout:processed', payout);
    });
    
    this.multiCoinPayoutManager.on('rates:updated', (rates) => {
      logger.debug('Exchange rates updated:', rates);
      this.emit('rates:updated', rates);
    });
    
    // Update payment processor to use multi-coin system
    if (this.paymentProcessor) {
      this.paymentProcessor.setPayoutManager(this.multiCoinPayoutManager);
    }
    
    logger.info('Multi-coin payout system initialized');
    logger.info(`Supported coins: ${this.config.payouts?.supportedCoins?.join(', ')}`);
    logger.info(`Fees: Pool ${this.config.payouts?.fees?.pool * 100}%, Solo ${this.config.payouts?.fees?.solo * 100}%, Conversion ${this.config.payouts?.fees?.conversion * 100}%`);
  }
  
  /**
   * Setup pool event handlers
   */
  async setupPoolHandlers() {
    if (!this.pool) return;
    
    // Share events
    this.pool.on('share:valid', (share) => {
      this.stats.totalShares++;
      this.monitoring.incrementCounter('pool_shares_total', 1);
      
      // Send stats to master in cluster mode
      if (!this.isClusterMaster && process.send) {
        process.send({
          type: 'stats',
          data: this.pool.getStats()
        });
      }
    });
    
    // Block events
    this.pool.on('block:found', async (block) => {
      this.stats.blocksFound++;
      this.monitoring.incrementCounter('pool_blocks_found', 1);
      
      logger.info('═══════════════════════════════════════════');
      logger.info('              BLOCK FOUND!                  ');
      logger.info('═══════════════════════════════════════════');
      logger.info(`Height: ${block.height}`);
      logger.info(`Hash: ${block.hash}`);
      logger.info(`Reward: ${block.reward}`);
      logger.info('═══════════════════════════════════════════');
      
      // Process payments
      if (this.paymentProcessor) {
        await this.paymentProcessor.processBlock(block);
      }
      
      // Notify master in cluster mode
      if (!this.isClusterMaster && process.send) {
        process.send({
          type: 'block',
          data: block
        });
      }
      
      this.emit('block:found', block);
    });
    
    // Miner events
    this.pool.on('miner:connected', (miner) => {
      this.stats.totalMiners++;
      this.emit('miner:connected', miner);
    });
    
    this.pool.on('miner:disconnected', (miner) => {
      this.stats.totalMiners--;
      this.emit('miner:disconnected', miner);
    });
    
    // Stats updates
    this.pool.on('stats:updated', (stats) => {
      this.stats = { ...this.stats, ...stats };
      this.updateMonitoring();
    });
  }
  
  /**
   * Update monitoring metrics
   */
  updateMonitoring() {
    this.monitoring.setGauge('pool_miners_total', this.stats.totalMiners);
    this.monitoring.setGauge('pool_hashrate_total', this.stats.totalHashrate);
    this.monitoring.setCounter('pool_shares_total', this.stats.totalShares);
    this.monitoring.setCounter('pool_blocks_found', this.stats.blocksFound);
  }
  
  /**
   * Setup health checks
   */
  setupHealthChecks() {
    // Pool health check
    healthCheckManager.register('pool', async () => {
      const healthy = this.pool && this.pool.stratumServer && this.pool.stratumServer.listening;
      return {
        healthy,
        message: healthy ? 'Pool is running' : 'Pool is not running',
        details: {
          miners: this.stats.totalMiners,
          hashrate: this.stats.totalHashrate
        }
      };
    });
    
    // Storage health check
    healthCheckManager.register('storage', async () => {
      const healthy = this.storage && this.storage.database && this.storage.database.open;
      return {
        healthy,
        message: healthy ? 'Storage is healthy' : 'Storage is unhealthy'
      };
    });
    
    // Payment processor health check
    healthCheckManager.register('payments', async () => {
      const healthy = this.paymentProcessor && !this.paymentProcessor.isProcessing;
      const stats = this.paymentProcessor ? this.paymentProcessor.getStats() : {};
      return {
        healthy,
        message: healthy ? 'Payment processor is healthy' : 'Payment processor is busy',
        details: stats
      };
    });
    
    // Solo mining health check
    healthCheckManager.register('solo-mining', async () => {
      if (!this.soloMiningManager) {
        return {
          healthy: true,
          message: 'Solo mining not enabled'
        };
      }
      
      const healthy = this.soloMiningManager.mining && this.soloMiningManager.connected;
      const stats = this.soloMiningManager.getStats();
      return {
        healthy,
        message: healthy ? 'Solo mining is running' : 'Solo mining is not running',
        details: {
          hashrate: stats.hashrate,
          blocksFound: stats.blocksFound,
          sharesProcessed: stats.sharesProcessed
        }
      };
    });
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    const uptime = Date.now() - this.stats.startTime;
    
    const stats = {
      ...this.stats,
      uptime,
      poolEfficiency: this.stats.totalShares > 0 ? 
        (this.stats.blocksFound / this.stats.totalShares * 100) : 0,
      workers: this.isClusterMaster ? this.workers.size : 1,
      asics: this.asicController ? this.asicController.getStats() : null,
      payments: this.paymentProcessor ? this.paymentProcessor.getStats() : null
    };
    
    // Add solo mining stats if enabled
    if (this.soloMiningManager) {
      stats.soloMining = this.soloMiningManager.getStats();
    }
    
    return stats;
  }
  
  /**
   * Start mining pool
   */
  async start() {
    logger.info('Starting Otedama Mining Pool...');
    
    await this.initialize();
    
    logger.info('');
    logger.info('╔═══════════════════════════════════════════════════════════╗');
    logger.info('║                                                           ║');
    logger.info('║               OTEDAMA MINING POOL                         ║');
    logger.info('║            Professional P2P Mining Platform               ║');
    logger.info('║                                                           ║');
    logger.info('╚═══════════════════════════════════════════════════════════╝');
    logger.info('');
    logger.info(`Pool Name: ${this.config.poolName}`);
    logger.info(`Algorithm: ${this.config.algorithm}`);
    logger.info(`Payment Scheme: ${this.config.paymentScheme}`);
    logger.info(`Pool Fee: ${this.config.poolFee * 100}%`);
    logger.info(`Stratum Port: ${this.config.stratumPort}`);
    logger.info(`Stratum V2 Port: ${this.config.stratumV2Port || 'Disabled'}`);
    logger.info(`API Port: ${this.config.apiPort}`);
    logger.info('');
    logger.info('Pool is ready for miners!');
    logger.info('');
    
    // Start solo mining if enabled
    if (this.soloMiningManager) {
      logger.info('');
      logger.info('Starting solo mining alongside pool...');
      await this.soloMiningManager.start();
      logger.info(`Solo mining active with ${this.config.soloMining.shareAllocationRatio * 100}% resource allocation`);
    }
    
    this.emit('started');
  }
  
  /**
   * Stop mining pool
   */
  async stop() {
    logger.info('Stopping Otedama Mining Pool...');
    
    this.isShuttingDown = true;
    
    // Stop components
    if (this.pool) {
      await this.pool.stop();
    }
    
    if (this.stratumV2) {
      await this.stratumV2.stop();
    }
    
    if (this.paymentProcessor) {
      await this.paymentProcessor.shutdown();
    }
    
    if (this.asicController) {
      await this.asicController.shutdown();
    }
    
    if (this.apiServer) {
      await this.apiServer.stop();
    }
    
    if (this.remoteManagement) {
      await this.remoteManagement.stop();
    }
    
    if (this.faultRecovery) {
      await this.faultRecovery.shutdown();
    }
    
    if (this.analytics) {
      await this.analytics.shutdown();
    }
    
    if (this.profitSwitcher) {
      this.profitSwitcher.stop();
    }
    
    if (this.autoScaling) {
      this.autoScaling.stop();
    }
    
    // Stop automation systems
    if (this.automation) {
      if (this.automation.tuning) {
        this.automation.tuning.stop();
      }
      if (this.automation.security) {
        this.automation.security.stop();
      }
      if (this.automation.backup) {
        this.automation.backup.stop();
      }
    }
    
    if (this.monitoring) {
      this.monitoring.stop();
    }
    
    if (this.storage) {
      await this.storage.shutdown();
    }
    
    // Stop solo mining
    if (this.soloMiningManager) {
      await this.soloMiningManager.stop();
    }
    
    // Stop cluster workers
    if (this.isClusterMaster) {
      for (const worker of this.workers.values()) {
        worker.kill();
      }
    }
    
    logger.info('Pool stopped');
    this.emit('stopped');
  }
}

/**
 * Create pool manager instance
 */
export function createMiningPoolManager(config) {
  return new OtedamaMiningPoolManager(config);
}

export default OtedamaMiningPoolManager;
