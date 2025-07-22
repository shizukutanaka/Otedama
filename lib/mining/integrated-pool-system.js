// Integrated P2P Mining Pool System V2
// Combines all mining components with real hardware control

import EventEmitter from 'events';
import { createLogger } from '../core/logger.js';
import { PBFTConsensus } from '../consensus/pbft-consensus.js';
import { KademliaDHT } from '../p2p/kademlia-dht.js';
import { AdvancedProfitSwitcher } from './profit-switching-v2.js';
import { GPUKernelManager } from './gpu/gpu-kernel-manager.js';
import { MinerManager } from './miner-manager.js';
import { HardwareInterface } from './hardware-interface.js';
import { ShareChain } from './share-chain.js';
import { MergedMiningManager } from './merged-mining.js';
import { algorithmRegistry } from './algorithms/index.js';
import { createConnectionPool } from '../core/connection-pool.js';
import { createMetricsCollector } from '../core/metrics.js';

const logger = createLogger('integrated-pool-system-v2');

export class IntegratedMiningPoolSystemV2 extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      poolName: config.poolName || 'Otedama P2P Pool',
      nodeId: config.nodeId || this.generateNodeId(),
      p2pPort: config.p2pPort || 3333,
      stratumPort: config.stratumPort || 3334,
      apiPort: config.apiPort || 8080,
      consensus: {
        byzantineNodes: 0.33,
        checkpointInterval: 100,
        ...config.consensus
      },
      dht: {
        k: 20,
        alpha: 3,
        refreshInterval: 3600000,
        ...config.dht
      },
      mining: {
        autoSelectAlgorithm: true,
        profitSwitching: true,
        gpuMining: true,
        cpuMining: true,
        externalMiners: true,
        hardwareControl: true,
        ...config.mining
      },
      hardware: {
        pollingInterval: 5000,
        temperatureLimit: 83,
        powerLimit: 300,
        enableOverclocking: false,
        ...config.hardware
      },
      miners: {
        autoDownload: true,
        autoStart: true,
        restartOnFailure: true,
        maxRestarts: 3,
        ...config.miners
      },
      shareChain: {
        windowSize: 8640, // 24 hours worth of shares
        shareInterval: 10, // seconds
        ...config.shareChain
      },
      mergedMining: {
        enabled: config.mergedMining?.enabled || false,
        auxiliaryChains: config.mergedMining?.auxiliaryChains || [],
        ...config.mergedMining
      },
      performance: {
        workerThreads: config.workerThreads || require('os').cpus().length,
        maxConnections: config.maxConnections || 10000,
        shareValidationBatchSize: config.shareValidationBatchSize || 100,
        ...config.performance
      },
      ...config
    };
    
    // Core components
    this.consensus = null;
    this.dht = null;
    this.profitSwitcher = null;
    this.gpuManager = null;
    this.minerManager = null;
    this.hardwareInterface = null;
    this.shareChain = null;
    this.mergedMiningManager = null;
    this.stratumServer = null;
    this.connectionPool = null;
    this.metrics = null;
    
    // Mining state
    this.miners = new Map();
    this.shares = new Map();
    this.blocks = new Map();
    this.currentAlgorithm = null;
    this.currentCoin = null;
    this.miningEnabled = false;
    
    // Hardware state
    this.hardwareStatus = {
      cpus: [],
      gpus: new Map(),
      asics: []
    };
    
    // Statistics
    this.stats = {
      totalHashrate: 0,
      totalMiners: 0,
      totalShares: 0,
      totalBlocks: 0,
      hardwareHashrate: 0,
      externalHashrate: 0,
      uptime: Date.now()
    };
  }

  async initialize() {
    logger.info(`Initializing ${this.config.poolName} V2`);
    
    try {
      // Initialize metrics collection
      this.metrics = createMetricsCollector({
        serviceName: 'integrated-mining-pool-v2',
        labels: { pool: this.config.poolName }
      });
      
      // Initialize connection pool
      this.connectionPool = createConnectionPool({
        maxConnections: this.config.performance.maxConnections,
        connectionTimeout: 30000
      });
      
      // Initialize hardware interface first
      if (this.config.mining.hardwareControl) {
        await this.initializeHardware();
      }
      
      // Initialize P2P components
      await this.initializeP2P();
      
      // Initialize consensus
      await this.initializeConsensus();
      
      // Initialize share chain
      await this.initializeShareChain();
      
      // Initialize merged mining if enabled
      if (this.config.mergedMining.enabled) {
        await this.initializeMergedMining();
      }
      
      // Initialize mining components
      await this.initializeMining();
      
      // Initialize external miners
      if (this.config.mining.externalMiners) {
        await this.initializeExternalMiners();
      }
      
      // Initialize Stratum server
      await this.initializeStratum();
      
      // Start monitoring
      this.startMonitoring();
      
      logger.info('Integrated mining pool system V2 initialized successfully');
      
      this.emit('initialized', {
        nodeId: this.config.nodeId,
        p2pPort: this.config.p2pPort,
        stratumPort: this.config.stratumPort,
        hardwareEnabled: this.config.mining.hardwareControl,
        externalMinersEnabled: this.config.mining.externalMiners
      });
      
    } catch (error) {
      logger.error('Failed to initialize pool system:', error);
      throw error;
    }
  }

  async initializeHardware() {
    logger.info('Initializing hardware interface');
    
    this.hardwareInterface = new HardwareInterface(this.config.hardware);
    await this.hardwareInterface.initialize();
    
    // Get hardware statistics
    const hwStats = this.hardwareInterface.getStatistics();
    
    // Store hardware information
    this.hardwareStatus.cpus = [hwStats.cpu];
    this.hardwareStatus.gpus = new Map(Object.entries(hwStats.gpus));
    
    // Set up hardware event handlers
    this.hardwareInterface.on('hardware-update', (stats) => {
      this.handleHardwareUpdate(stats);
    });
    
    this.hardwareInterface.on('thermal-throttle', (data) => {
      this.handleThermalThrottle(data);
    });
    
    logger.info(`Hardware initialized: ${this.hardwareStatus.cpus.length} CPUs, ${this.hardwareStatus.gpus.size} GPUs`);
  }

  async initializeExternalMiners() {
    logger.info('Initializing external miner manager');
    
    this.minerManager = new MinerManager(this.config.miners);
    
    // Initialize with pool configuration
    await this.minerManager.initialize({
      algorithm: this.currentAlgorithm,
      url: `stratum+tcp://localhost:${this.config.stratumPort}`,
      wallet: this.config.poolWallet || 'pool-wallet',
      password: 'x'
    }, this.hardwareStatus);
    
    // Set up miner manager event handlers
    this.minerManager.on('miner-started', (data) => {
      logger.info(`External miner started: ${data.type}`);
      this.updateMiningStatus();
    });
    
    this.minerManager.on('miner-stopped', (data) => {
      logger.info(`External miner stopped: ${data.type}`);
      this.updateMiningStatus();
    });
    
    this.minerManager.on('hashrate-update', (data) => {
      this.handleExternalHashrateUpdate(data);
    });
    
    this.minerManager.on('shares-update', (data) => {
      this.handleExternalSharesUpdate(data);
    });
    
    this.minerManager.on('temperature-warning', (data) => {
      logger.warn(`Temperature warning from ${data.type}: ${data.temperature}°C`);
      this.handleTemperatureWarning(data);
    });
    
    // Auto-configure miners based on hardware
    if (this.config.miners.autoStart) {
      await this.minerManager.autoConfigureMiners();
    }
  }

  async initializeShareChain() {
    logger.info('Initializing share chain');
    
    this.shareChain = new ShareChain(this.config.shareChain);
    await this.shareChain.initialize();
    
    // Set up share chain event handlers
    this.shareChain.on('share-added', (share) => {
      this.metrics.increment('sharechain_shares_added');
    });
    
    this.shareChain.on('share-removed', (share) => {
      this.metrics.increment('sharechain_shares_removed');
    });
  }

  async initializeMergedMining() {
    logger.info('Initializing merged mining');
    
    this.mergedMiningManager = new MergedMiningManager(this.config.mergedMining);
    
    // Register auxiliary chains
    for (const chain of this.config.mergedMining.auxiliaryChains) {
      await this.mergedMiningManager.registerAuxiliaryChain(chain);
    }
    
    logger.info(`Merged mining initialized with ${this.config.mergedMining.auxiliaryChains.length} auxiliary chains`);
  }

  async initializeP2P() {
    // Initialize Kademlia DHT
    this.dht = new KademliaDHT(this.config.nodeId, this.config.dht);
    await this.dht.initialize();
    
    // Set up DHT event handlers
    this.dht.on('send-message', async (data) => {
      await this.handleDHTMessage(data);
    });
    
    // Bootstrap DHT network
    if (this.config.bootstrapNodes) {
      for (const node of this.config.bootstrapNodes) {
        await this.dht.ping(node);
      }
    }
    
    logger.info('P2P network initialized');
  }

  async initializeConsensus() {
    // Get initial nodes from DHT
    const nodes = await this.discoverNodes();
    
    // Initialize PBFT consensus
    this.consensus = new PBFTConsensus(this.config.nodeId, this.config.consensus);
    await this.consensus.initialize(nodes);
    
    // Set up consensus event handlers
    this.consensus.on('executed', (data) => {
      this.handleConsensusExecution(data);
    });
    
    this.consensus.on('message-sent', async (data) => {
      await this.handleConsensusMessage(data);
    });
    
    logger.info('Consensus mechanism initialized');
  }

  async initializeMining() {
    // Initialize GPU manager if enabled
    if (this.config.mining.gpuMining) {
      this.gpuManager = new GPUKernelManager({
        preferredBackend: 'auto',
        autoTuning: true
      });
      
      try {
        await this.gpuManager.initialize();
        logger.info('GPU mining initialized');
      } catch (error) {
        logger.warn('GPU initialization failed, falling back to CPU:', error);
        this.config.mining.gpuMining = false;
      }
    }
    
    // Initialize profit switcher if enabled
    if (this.config.mining.profitSwitching) {
      this.profitSwitcher = new AdvancedProfitSwitcher({
        updateInterval: 300000, // 5 minutes
        switchThreshold: 0.05   // 5% profit difference
      });
      
      await this.profitSwitcher.initialize();
      
      // Register supported coins
      this.registerSupportedCoins();
      
      // Handle profit switching
      this.profitSwitcher.on('switch', async (data) => {
        await this.handleAlgorithmSwitch(data);
      });
      
      logger.info('Profit switching initialized');
    }
    
    // Select initial algorithm
    await this.selectMiningAlgorithm();
  }

  async initializeStratum() {
    const { StratumServer } = await import('../stratum/stratum-server.js');
    
    this.stratumServer = new StratumServer({
      port: this.config.stratumPort,
      poolName: this.config.poolName,
      connectionPool: this.connectionPool
    });
    
    // Set up Stratum event handlers
    this.stratumServer.on('client-connected', (client) => {
      this.handleMinerConnect(client);
    });
    
    this.stratumServer.on('client-disconnected', (client) => {
      this.handleMinerDisconnect(client);
    });
    
    this.stratumServer.on('share-submitted', async (share) => {
      await this.handleShareSubmission(share);
    });
    
    await this.stratumServer.start();
    
    logger.info(`Stratum server listening on port ${this.config.stratumPort}`);
  }

  registerSupportedCoins() {
    // Register coins with profit switcher
    const coins = [
      {
        symbol: 'BTC',
        name: 'Bitcoin',
        algorithm: 'sha256',
        blockReward: 6.25,
        blockTime: 600,
        poolInfo: { url: 'stratum+tcp://btc.pool.com:3333', fee: 0.01 }
      },
      {
        symbol: 'ETH',
        name: 'Ethereum',
        algorithm: 'ethash',
        blockReward: 2,
        blockTime: 13,
        poolInfo: { url: 'stratum+tcp://eth.pool.com:3333', fee: 0.01 }
      },
      {
        symbol: 'RVN',
        name: 'Ravencoin',
        algorithm: 'kawpow',
        blockReward: 5000,
        blockTime: 60,
        poolInfo: { url: 'stratum+tcp://rvn.pool.com:3333', fee: 0.01 }
      },
      {
        symbol: 'ERGO',
        name: 'Ergo',
        algorithm: 'autolykos2',
        blockReward: 67.5,
        blockTime: 120,
        poolInfo: { url: 'stratum+tcp://ergo.pool.com:3333', fee: 0.01 }
      },
      {
        symbol: 'KAS',
        name: 'Kaspa',
        algorithm: 'kheavyhash',
        blockReward: 100,
        blockTime: 1,
        poolInfo: { url: 'stratum+tcp://kas.pool.com:3333', fee: 0.01 }
      },
      {
        symbol: 'IRON',
        name: 'IronFish',
        algorithm: 'fishhash',
        blockReward: 20,
        blockTime: 60,
        poolInfo: { url: 'stratum+tcp://iron.pool.com:3333', fee: 0.01 }
      },
      {
        symbol: 'DNX',
        name: 'Dynex',
        algorithm: 'dynexsolve',
        blockReward: 10,
        blockTime: 120,
        poolInfo: { url: 'stratum+tcp://dnx.pool.com:3333', fee: 0.01 }
      }
    ];
    
    // Register algorithms with actual hardware hashrates
    for (const coin of coins) {
      this.profitSwitcher.registerCoin(coin);
      
      const algorithm = algorithmRegistry.get(coin.algorithm);
      if (algorithm) {
        this.profitSwitcher.registerAlgorithm({
          name: coin.algorithm,
          hashrate: this.estimateActualHashrate(coin.algorithm),
          power: this.estimateActualPower(coin.algorithm)
        });
      }
    }
  }

  estimateActualHashrate(algorithm) {
    // Calculate actual hashrate based on detected hardware
    let totalHashrate = 0;
    
    // Add GPU hashrates
    for (const [gpuId, gpu] of this.hardwareStatus.gpus) {
      const gpuHashrate = this.getGPUHashrateForAlgorithm(gpu, algorithm);
      totalHashrate += gpuHashrate;
    }
    
    // Add CPU hashrate if CPU mining is enabled
    if (this.config.mining.cpuMining && this.isCPUAlgorithm(algorithm)) {
      const cpuHashrate = this.getCPUHashrateForAlgorithm(algorithm);
      totalHashrate += cpuHashrate;
    }
    
    return totalHashrate || this.estimateHashrate(algorithm);
  }

  getGPUHashrateForAlgorithm(gpu, algorithm) {
    // Realistic hashrates for common GPUs (in H/s)
    const hashrates = {
      'NVIDIA GeForce RTX 3090': {
        ethash: 120000000,      // 120 MH/s
        kawpow: 58000000,       // 58 MH/s
        autolykos2: 280000000,  // 280 MH/s
        kheavyhash: 2800000000, // 2.8 GH/s
        fishhash: 45000000      // 45 MH/s
      },
      'NVIDIA GeForce RTX 3080': {
        ethash: 98000000,       // 98 MH/s
        kawpow: 47000000,       // 47 MH/s
        autolykos2: 230000000,  // 230 MH/s
        kheavyhash: 2200000000, // 2.2 GH/s
        fishhash: 38000000      // 38 MH/s
      },
      'AMD Radeon RX 6900 XT': {
        ethash: 64000000,       // 64 MH/s
        kawpow: 32000000,       // 32 MH/s
        autolykos2: 175000000,  // 175 MH/s
        kheavyhash: 1500000000, // 1.5 GH/s
        fishhash: 28000000      // 28 MH/s
      }
    };
    
    // Try to match GPU name
    for (const [model, algos] of Object.entries(hashrates)) {
      if (gpu.name && gpu.name.includes(model.split(' ').slice(-2).join(' '))) {
        return algos[algorithm] || 0;
      }
    }
    
    // Default estimates based on GPU type
    if (gpu.type === 'nvidia') {
      return this.estimateHashrate(algorithm) * 0.8;
    } else if (gpu.type === 'amd') {
      return this.estimateHashrate(algorithm) * 0.6;
    }
    
    return 0;
  }

  getCPUHashrateForAlgorithm(algorithm) {
    // CPU hashrates
    const cpuHashrates = {
      randomx: 10000,     // 10 KH/s for modern CPU
      cryptonight: 5000,  // 5 KH/s
      argon2: 20000,      // 20 KH/s
      dynexsolve: 1000    // 1 KH/s
    };
    
    return cpuHashrates[algorithm] || 0;
  }

  isCPUAlgorithm(algorithm) {
    const cpuAlgorithms = ['randomx', 'cryptonight', 'argon2', 'dynexsolve'];
    return cpuAlgorithms.includes(algorithm);
  }

  estimateActualPower(algorithm) {
    // Calculate actual power consumption based on hardware
    let totalPower = 0;
    
    // Add GPU power
    for (const [gpuId, gpu] of this.hardwareStatus.gpus) {
      totalPower += gpu.powerLimit || 250; // Default 250W per GPU
    }
    
    // Add CPU power if CPU mining
    if (this.config.mining.cpuMining && this.isCPUAlgorithm(algorithm)) {
      totalPower += 100; // Assume 100W for CPU mining
    }
    
    return totalPower || this.estimatePower(algorithm);
  }

  estimateHashrate(algorithm) {
    // Fallback estimates
    const estimates = {
      sha256: this.config.mining.gpuMining ? 10000000000 : 1000000,
      ethash: this.config.mining.gpuMining ? 50000000 : 100000,
      kawpow: this.config.mining.gpuMining ? 25000000 : 50000,
      autolykos2: this.config.mining.gpuMining ? 100000000 : 500000,
      kheavyhash: this.config.mining.gpuMining ? 1000000000 : 5000000,
      fishhash: this.config.mining.gpuMining ? 30000000 : 100000,
      dynexsolve: this.config.mining.gpuMining ? 5000000 : 1000
    };
    
    return estimates[algorithm] || 1000000;
  }

  estimatePower(algorithm) {
    // Fallback power estimates
    const estimates = {
      sha256: this.config.mining.gpuMining ? 300 : 100,
      ethash: this.config.mining.gpuMining ? 250 : 80,
      kawpow: this.config.mining.gpuMining ? 280 : 90,
      autolykos2: this.config.mining.gpuMining ? 200 : 70,
      kheavyhash: this.config.mining.gpuMining ? 320 : 110,
      fishhash: this.config.mining.gpuMining ? 240 : 85,
      dynexsolve: this.config.mining.gpuMining ? 150 : 100
    };
    
    return estimates[algorithm] || 200;
  }

  async selectMiningAlgorithm() {
    if (this.config.mining.profitSwitching && this.profitSwitcher) {
      // Let profit switcher select best coin
      const best = this.profitSwitcher.selectBestCoin();
      if (best) {
        this.currentCoin = best.symbol;
        this.currentAlgorithm = best.coin.algorithm;
      }
    } else if (this.config.mining.algorithm) {
      // Use configured algorithm
      this.currentAlgorithm = this.config.mining.algorithm;
      this.currentCoin = this.config.mining.coin || 'UNKNOWN';
    } else {
      // Default to SHA256
      this.currentAlgorithm = 'sha256';
      this.currentCoin = 'BTC';
    }
    
    logger.info(`Selected algorithm: ${this.currentAlgorithm} (${this.currentCoin})`);
  }

  async handleAlgorithmSwitch(data) {
    logger.info(`Switching algorithm from ${data.from} to ${data.to}`);
    
    this.currentCoin = data.to;
    this.currentAlgorithm = data.algorithm;
    
    // Update external miners if enabled
    if (this.minerManager) {
      // Stop current miners
      await this.minerManager.stopAllMiners();
      
      // Reconfigure for new algorithm
      await this.minerManager.initialize({
        algorithm: this.currentAlgorithm,
        url: `stratum+tcp://localhost:${this.config.stratumPort}`,
        wallet: this.config.poolWallet || 'pool-wallet',
        password: 'x'
      }, this.hardwareStatus);
      
      // Start miners for new algorithm
      await this.minerManager.autoConfigureMiners();
    }
    
    // Notify all connected miners
    this.broadcastToMiners({
      type: 'algorithm-switch',
      algorithm: data.algorithm,
      coin: data.to,
      estimatedProfit: data.estimatedProfit
    });
    
    // Update metrics
    this.metrics.increment('algorithm_switches_total', {
      from: data.from,
      to: data.to
    });
  }

  async discoverNodes() {
    // Discover nodes through DHT
    const nodeIds = await this.dht.findNode(this.config.nodeId);
    
    return nodeIds.map(node => ({
      id: node.id.toString('hex'),
      publicKey: node.publicKey || node.id.toString('hex'),
      endpoint: `${node.address}:${node.port}`
    }));
  }

  generateNodeId() {
    return require('crypto').randomBytes(32).toString('hex');
  }

  // Hardware event handlers
  handleHardwareUpdate(stats) {
    // Update hardware status
    this.hardwareStatus.cpus = [stats.cpu];
    this.hardwareStatus.gpus = new Map(Object.entries(stats.gpus));
    
    // Update metrics
    for (const [gpuId, gpu] of Object.entries(stats.gpus)) {
      this.metrics.gauge('gpu_temperature', gpu.temperature, { gpu: gpuId });
      this.metrics.gauge('gpu_power', gpu.power, { gpu: gpuId });
      this.metrics.gauge('gpu_hashrate', gpu.hashrate || 0, { gpu: gpuId });
    }
    
    this.emit('hardware-stats', stats);
  }

  handleThermalThrottle(data) {
    logger.warn(`GPU ${data.gpuId} thermal throttling at ${data.temperature}°C`);
    
    // Reduce power limit to cool down
    if (this.hardwareInterface && this.config.hardware.enableOverclocking) {
      const gpu = this.hardwareStatus.gpus.get(data.gpuId);
      if (gpu && gpu.powerLimit) {
        const newPowerLimit = gpu.powerLimit * 0.9; // Reduce by 10%
        this.hardwareInterface.setGPUPowerLimit(data.gpuId, newPowerLimit)
          .catch(err => logger.error('Failed to reduce power limit:', err));
      }
    }
    
    this.emit('thermal-throttle', data);
  }

  handleExternalHashrateUpdate(data) {
    // Update external miner hashrate tracking
    const stats = this.minerManager.getStatistics();
    this.stats.externalHashrate = stats.total.hashrate;
    
    this.updateTotalHashrate();
  }

  handleExternalSharesUpdate(data) {
    // Track shares from external miners
    this.metrics.increment('external_shares_total', {
      miner: data.type,
      status: 'accepted'
    });
  }

  handleTemperatureWarning(data) {
    // Handle high temperature from external miners
    if (data.temperature > 90) {
      logger.error(`Critical temperature on ${data.type}: ${data.temperature}°C`);
      
      // Stop the overheating miner
      if (this.minerManager) {
        this.minerManager.stopMiner(data.type)
          .catch(err => logger.error('Failed to stop overheating miner:', err));
      }
    }
  }

  // Miner management
  handleMinerConnect(client) {
    const minerId = client.id;
    
    this.miners.set(minerId, {
      id: minerId,
      client: client,
      worker: client.worker,
      hashrate: 0,
      shares: {
        accepted: 0,
        rejected: 0,
        stale: 0
      },
      connectedAt: Date.now(),
      lastShareAt: null,
      isExternal: client.userAgent?.includes('xmrig') || 
                  client.userAgent?.includes('t-rex') ||
                  client.userAgent?.includes('teamredminer')
    });
    
    this.stats.totalMiners++;
    
    // Register miner in DHT
    this.dht.registerMiner(minerId, {
      worker: client.worker,
      address: client.address,
      algorithm: this.currentAlgorithm
    });
    
    logger.info(`Miner connected: ${minerId} (${client.worker})`);
    
    this.emit('miner-connected', { minerId, worker: client.worker });
  }

  handleMinerDisconnect(client) {
    const minerId = client.id;
    const miner = this.miners.get(minerId);
    
    if (miner) {
      this.miners.delete(minerId);
      this.stats.totalMiners--;
      
      logger.info(`Miner disconnected: ${minerId} (${miner.worker})`);
      
      this.emit('miner-disconnected', { minerId, worker: miner.worker });
    }
  }

  // Share handling
  async handleShareSubmission(share) {
    const startTime = Date.now();
    
    try {
      // Add share metadata
      share.id = this.generateShareId();
      share.timestamp = Date.now();
      share.poolNode = this.config.nodeId;
      
      // Store share locally
      this.shares.set(share.id, share);
      
      // Add to share chain
      if (this.shareChain) {
        await this.shareChain.addShare({
          ...share,
          value: this.calculateShareValue(share)
        });
      }
      
      // Validate through consensus
      const result = await this.consensus.handleShareValidation(share);
      
      // Update miner stats
      const miner = this.miners.get(share.minerId);
      if (miner) {
        if (result.valid) {
          miner.shares.accepted++;
          miner.lastShareAt = Date.now();
          
          // Update hashrate estimate
          this.updateMinerHashrate(miner, share);
        } else {
          miner.shares.rejected++;
        }
      }
      
      // Store share in DHT
      if (result.valid) {
        await this.dht.registerShare(share.id, {
          ...share,
          validation: result
        });
      }
      
      // Update metrics
      const processingTime = Date.now() - startTime;
      this.metrics.histogram('share_processing_duration_ms', processingTime);
      this.metrics.increment('shares_total', {
        status: result.valid ? 'accepted' : 'rejected'
      });
      
      this.stats.totalShares++;
      
      // Check if share is a block
      if (result.valid && this.isBlockShare(share)) {
        await this.handleBlockFound(share);
      }
      
      return result;
      
    } catch (error) {
      logger.error('Error processing share:', error);
      
      this.metrics.increment('share_errors_total');
      
      return {
        valid: false,
        error: error.message
      };
    }
  }

  calculateShareValue(share) {
    // Calculate share value based on difficulty
    const difficulty = BigInt('0x' + share.difficulty);
    return Number(difficulty) / 1000000; // Normalize
  }

  updateMinerHashrate(miner, share) {
    // Simple hashrate estimation based on share difficulty and frequency
    const timeSinceLastShare = miner.lastShareAt ? 
      (Date.now() - miner.lastShareAt) / 1000 : 60;
    
    const difficulty = BigInt('0x' + share.difficulty);
    const hashrate = Number(difficulty) / timeSinceLastShare;
    
    // Exponential moving average
    miner.hashrate = miner.hashrate * 0.9 + hashrate * 0.1;
    
    // Update total pool hashrate
    this.updatePoolHashrate();
  }

  updatePoolHashrate() {
    let stratumHashrate = 0;
    
    for (const miner of this.miners.values()) {
      if (!miner.isExternal) {
        stratumHashrate += miner.hashrate;
      }
    }
    
    // Combine stratum and external hashrates
    this.stats.totalHashrate = stratumHashrate + this.stats.externalHashrate;
    
    this.metrics.gauge('pool_hashrate_total', this.stats.totalHashrate);
    this.metrics.gauge('pool_hashrate_stratum', stratumHashrate);
    this.metrics.gauge('pool_hashrate_external', this.stats.externalHashrate);
  }

  updateTotalHashrate() {
    this.updatePoolHashrate();
  }

  updateMiningStatus() {
    // Check if any miners are running
    if (this.minerManager) {
      const stats = this.minerManager.getStatistics();
      this.miningEnabled = Object.keys(stats.miners).length > 0;
    }
  }

  isBlockShare(share) {
    // Check if share meets network difficulty
    const networkDifficulty = this.getNetworkDifficulty();
    const shareDifficulty = BigInt('0x' + share.difficulty);
    
    return shareDifficulty >= networkDifficulty;
  }

  getNetworkDifficulty() {
    // Get current network difficulty for the coin
    // This would connect to the blockchain in production
    const difficulties = {
      BTC: BigInt('0x00000000000000000007a4290000000000000000000000000000000000000000'),
      ETH: BigInt('0x0000000000000000000000000000000000000000000000000000100000000000'),
      RVN: BigInt('0x0000000000000000000000000000000000000000000000000000001000000000'),
      ERGO: BigInt('0x0000000000000000000000000000000000000000000000000000002000000000'),
      KAS: BigInt('0x0000000000000000000000000000000000000000000000000000000800000000'),
      IRON: BigInt('0x0000000000000000000000000000000000000000000000000000001500000000'),
      DNX: BigInt('0x0000000000000000000000000000000000000000000000000000003000000000')
    };
    
    return difficulties[this.currentCoin] || BigInt('0x0000000000000000000000000000000000000000000000000000010000000000');
  }

  async handleBlockFound(share) {
    logger.info(`Block found! Height: ${share.height}, Hash: ${share.hash}`);
    
    this.stats.totalBlocks++;
    
    // Store block
    const block = {
      height: share.height,
      hash: share.hash,
      finder: share.minerId,
      timestamp: Date.now(),
      reward: this.calculateBlockReward(),
      coin: this.currentCoin,
      algorithm: this.currentAlgorithm
    };
    
    this.blocks.set(share.hash, block);
    
    // Handle merged mining rewards if applicable
    if (this.mergedMiningManager) {
      const auxRewards = await this.mergedMiningManager.checkAuxiliaryBlocks(share);
      if (auxRewards.length > 0) {
        block.auxiliaryRewards = auxRewards;
        logger.info(`Found ${auxRewards.length} auxiliary chain blocks!`);
      }
    }
    
    // Broadcast block found event
    this.emit('block-found', block);
    
    // Submit block to network (would connect to daemon in production)
    // await this.submitBlock(share);
    
    // Distribute rewards
    await this.distributeBlockReward(block);
  }

  calculateBlockReward() {
    // Get block reward for current coin
    const rewards = {
      BTC: 6.25,
      ETH: 2,
      RVN: 5000,
      ERGO: 67.5,
      KAS: 100,
      IRON: 20,
      DNX: 10
    };
    
    return rewards[this.currentCoin] || 1;
  }

  async distributeBlockReward(block) {
    logger.info('Distributing block reward');
    
    const blockReward = block.reward;
    const poolFee = blockReward * 0.01; // 1% pool fee
    const minerReward = blockReward - poolFee;
    
    if (this.shareChain) {
      // Calculate PPLNS rewards based on share chain
      const rewards = this.shareChain.calculateRewards(minerReward);
      
      logger.info(`Distributing rewards to ${rewards.length} miners`);
      
      for (const reward of rewards) {
        logger.info(`Rewarding ${reward.amount} ${this.currentCoin} to miner ${reward.minerId}`);
        
        this.emit('reward-distributed', {
          minerId: reward.minerId,
          amount: reward.amount,
          coin: this.currentCoin,
          blockHash: block.hash
        });
      }
    } else {
      // Fallback: give full reward to block finder
      const finder = this.miners.get(block.finder);
      if (finder) {
        logger.info(`Rewarding ${minerReward} ${this.currentCoin} to ${finder.worker}`);
      }
    }
    
    // Handle auxiliary rewards from merged mining
    if (block.auxiliaryRewards) {
      for (const auxReward of block.auxiliaryRewards) {
        logger.info(`Distributing ${auxReward.amount} ${auxReward.coin} from auxiliary chain`);
      }
    }
  }

  generateShareId() {
    return require('crypto').randomBytes(16).toString('hex');
  }

  // DHT message handling
  async handleDHTMessage(data) {
    try {
      const response = await this.dht.handleRPC(data.message, data.to);
      
      // Send response back through P2P network
      this.emit('dht-response', {
        to: data.to,
        response: response
      });
    } catch (error) {
      logger.error('Error handling DHT message:', error);
    }
  }

  // Consensus message handling
  async handleConsensusMessage(data) {
    // Route consensus messages through P2P network
    const node = await this.dht.findNode(Buffer.from(data.to, 'hex'));
    
    if (node && node.length > 0) {
      // Send to closest node
      this.emit('consensus-forward', {
        to: node[0],
        message: data.message
      });
    }
  }

  handleConsensusExecution(data) {
    if (data.type === 'share-validation') {
      logger.debug(`Share ${data.result.shareId} validated: ${data.result.valid}`);
    }
  }

  // Broadcast to all connected miners
  broadcastToMiners(message) {
    for (const miner of this.miners.values()) {
      try {
        miner.client.send(message);
      } catch (error) {
        logger.error(`Failed to send to miner ${miner.id}:`, error);
      }
    }
  }

  // Mining profiles for different hardware
  async applyMiningProfile(profileName) {
    const profiles = {
      'efficiency': {
        name: 'Efficiency',
        gpus: {
          'nvidia-0': { powerLimit: 200, coreClock: 1400, memoryClock: 8000, fanSpeed: 70 },
          'nvidia-1': { powerLimit: 200, coreClock: 1400, memoryClock: 8000, fanSpeed: 70 }
        }
      },
      'performance': {
        name: 'Performance',
        gpus: {
          'nvidia-0': { powerLimit: 300, coreClock: 1800, memoryClock: 10000, fanSpeed: 80 },
          'nvidia-1': { powerLimit: 300, coreClock: 1800, memoryClock: 10000, fanSpeed: 80 }
        }
      },
      'quiet': {
        name: 'Quiet',
        gpus: {
          'nvidia-0': { powerLimit: 150, coreClock: 1200, memoryClock: 7000, fanSpeed: 50 },
          'nvidia-1': { powerLimit: 150, coreClock: 1200, memoryClock: 7000, fanSpeed: 50 }
        }
      }
    };
    
    const profile = profiles[profileName];
    if (!profile) {
      throw new Error(`Unknown mining profile: ${profileName}`);
    }
    
    if (this.hardwareInterface) {
      await this.hardwareInterface.applyMiningProfile(profile);
    }
    
    logger.info(`Applied mining profile: ${profile.name}`);
  }

  // Monitoring
  startMonitoring() {
    // Periodic statistics update
    setInterval(() => {
      this.updateStatistics();
    }, 60000); // Every minute
    
    // Health check
    setInterval(() => {
      this.performHealthCheck();
    }, 30000); // Every 30 seconds
    
    // Hardware optimization
    if (this.config.mining.hardwareControl) {
      setInterval(() => {
        this.optimizeHardware();
      }, 300000); // Every 5 minutes
    }
  }

  updateStatistics() {
    const stats = {
      ...this.stats,
      uptime: Date.now() - this.stats.uptime,
      currentAlgorithm: this.currentAlgorithm,
      currentCoin: this.currentCoin,
      p2pNodes: this.dht?.getStatistics().routingTable.totalNodes || 0,
      consensusView: this.consensus?.getStatistics().view || 0,
      shareChainLength: this.shareChain?.getLength() || 0,
      hardwareStatus: {
        cpus: this.hardwareStatus.cpus.length,
        gpus: this.hardwareStatus.gpus.size,
        temperature: this.getAverageTemperature()
      },
      externalMiners: this.minerManager?.getStatistics() || null
    };
    
    // Update metrics
    this.metrics.gauge('miners_connected', stats.totalMiners);
    this.metrics.gauge('pool_hashrate', stats.totalHashrate);
    this.metrics.gauge('p2p_nodes', stats.p2pNodes);
    
    this.emit('statistics', stats);
  }

  getAverageTemperature() {
    let totalTemp = 0;
    let count = 0;
    
    for (const gpu of this.hardwareStatus.gpus.values()) {
      if (gpu.temperature) {
        totalTemp += gpu.temperature;
        count++;
      }
    }
    
    return count > 0 ? totalTemp / count : 0;
  }

  async performHealthCheck() {
    const health = {
      status: 'healthy',
      components: {
        p2p: this.dht ? 'ok' : 'error',
        consensus: this.consensus ? 'ok' : 'error',
        stratum: this.stratumServer ? 'ok' : 'error',
        gpu: this.gpuManager ? 'ok' : 'warning',
        hardware: this.hardwareInterface ? 'ok' : 'warning',
        externalMiners: this.minerManager ? 'ok' : 'warning',
        shareChain: this.shareChain ? 'ok' : 'error'
      },
      metrics: {
        miners: this.stats.totalMiners,
        hashrate: this.stats.totalHashrate,
        shares: this.stats.totalShares,
        blocks: this.stats.totalBlocks,
        temperature: this.getAverageTemperature()
      }
    };
    
    // Check component health
    if (this.stats.totalMiners === 0 && !this.miningEnabled) {
      health.status = 'warning';
      health.components.stratum = 'warning';
    }
    
    if (!this.dht || this.dht.getStatistics().routingTable.totalNodes === 0) {
      health.status = 'degraded';
      health.components.p2p = 'error';
    }
    
    if (this.getAverageTemperature() > 85) {
      health.status = 'warning';
      health.components.hardware = 'warning';
    }
    
    this.emit('health-check', health);
  }

  async optimizeHardware() {
    if (!this.hardwareInterface || !this.config.hardware.enableOverclocking) {
      return;
    }
    
    // Auto-tune based on temperature and performance
    for (const [gpuId, gpu] of this.hardwareStatus.gpus) {
      if (gpu.temperature > 80) {
        // Reduce power if too hot
        const newPowerLimit = gpu.powerLimit * 0.95;
        await this.hardwareInterface.setGPUPowerLimit(gpuId, newPowerLimit)
          .catch(err => logger.error('Failed to adjust power limit:', err));
      } else if (gpu.temperature < 70 && gpu.utilization?.gpu > 95) {
        // Increase power if cool and fully utilized
        const newPowerLimit = Math.min(gpu.powerLimit * 1.05, this.config.hardware.powerLimit);
        await this.hardwareInterface.setGPUPowerLimit(gpuId, newPowerLimit)
          .catch(err => logger.error('Failed to adjust power limit:', err));
      }
    }
  }

  // API methods
  getPoolStatistics() {
    return {
      pool: {
        name: this.config.poolName,
        nodeId: this.config.nodeId,
        algorithm: this.currentAlgorithm,
        coin: this.currentCoin,
        version: 'v2.0.0'
      },
      stats: this.stats,
      miners: Array.from(this.miners.values()).map(m => ({
        id: m.id,
        worker: m.worker,
        hashrate: m.hashrate,
        shares: m.shares,
        isExternal: m.isExternal
      })),
      network: {
        p2pNodes: this.dht?.getStatistics().routingTable.totalNodes || 0,
        consensusView: this.consensus?.getStatistics().view || 0,
        shareChainLength: this.shareChain?.getLength() || 0
      },
      hardware: {
        cpus: this.hardwareStatus.cpus,
        gpus: Array.from(this.hardwareStatus.gpus.values()),
        temperature: this.getAverageTemperature()
      },
      externalMiners: this.minerManager?.getStatistics() || null
    };
  }

  getMinerStatistics(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return null;
    
    const shareHistory = this.shareChain ? 
      this.shareChain.getMinerShares(minerId) : [];
    
    return {
      id: miner.id,
      worker: miner.worker,
      hashrate: miner.hashrate,
      shares: miner.shares,
      connectedAt: miner.connectedAt,
      lastShareAt: miner.lastShareAt,
      shareHistory: shareHistory,
      earnings: this.calculateMinerEarnings(minerId)
    };
  }

  calculateMinerEarnings(minerId) {
    if (!this.shareChain) {
      return { pending: 0, paid: 0, total: 0 };
    }
    
    const pendingReward = this.shareChain.estimateMinerReward(minerId, this.calculateBlockReward());
    
    return {
      pending: pendingReward,
      paid: 0, // Would track actual payments
      total: pendingReward
    };
  }

  // Control methods
  async startMining() {
    if (this.miningEnabled) {
      logger.warn('Mining already started');
      return;
    }
    
    logger.info('Starting mining operations');
    
    if (this.minerManager && this.config.mining.externalMiners) {
      await this.minerManager.autoConfigureMiners();
    }
    
    this.miningEnabled = true;
    this.emit('mining-started');
  }

  async stopMining() {
    if (!this.miningEnabled) {
      logger.warn('Mining already stopped');
      return;
    }
    
    logger.info('Stopping mining operations');
    
    if (this.minerManager) {
      await this.minerManager.stopAllMiners();
    }
    
    this.miningEnabled = false;
    this.emit('mining-stopped');
  }

  // Shutdown
  async shutdown() {
    logger.info('Shutting down integrated mining pool system V2');
    
    // Stop mining
    if (this.miningEnabled) {
      await this.stopMining();
    }
    
    // Stop components
    if (this.stratumServer) {
      await this.stratumServer.stop();
    }
    
    if (this.profitSwitcher) {
      this.profitSwitcher.stop();
    }
    
    if (this.minerManager) {
      await this.minerManager.shutdown();
    }
    
    if (this.hardwareInterface) {
      await this.hardwareInterface.shutdown();
    }
    
    if (this.shareChain) {
      await this.shareChain.stop();
    }
    
    if (this.dht) {
      this.dht.stop();
    }
    
    if (this.gpuManager) {
      await this.gpuManager.cleanup();
    }
    
    // Close connections
    if (this.connectionPool) {
      await this.connectionPool.close();
    }
    
    logger.info('Shutdown complete');
  }
}

export default IntegratedMiningPoolSystemV2;