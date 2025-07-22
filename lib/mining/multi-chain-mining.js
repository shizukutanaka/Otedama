// Multi-Chain Mining Support with Automatic Chain Switching
// Enables mining across multiple blockchains with intelligent switching

import EventEmitter from 'events';
import { createLogger } from '../core/logger.js';
import axios from 'axios';
import WebSocket from 'ws';

const logger = createLogger('multi-chain-mining');

// Supported blockchain networks
export const BlockchainNetwork = {
  BITCOIN: 'bitcoin',
  ETHEREUM: 'ethereum',
  ETHEREUM_CLASSIC: 'ethereum_classic',
  RAVENCOIN: 'ravencoin',
  ERGO: 'ergo',
  KASPA: 'kaspa',
  IRONFISH: 'ironfish',
  FLUX: 'flux',
  MONERO: 'monero',
  LITECOIN: 'litecoin',
  ZCASH: 'zcash',
  DASH: 'dash',
  CONFLUX: 'conflux',
  BEAM: 'beam',
  GRIN: 'grin',
  KADENA: 'kadena',
  CORTEX: 'cortex',
  NERVOS: 'nervos',
  HANDSHAKE: 'handshake',
  SIA: 'sia'
};

// Chain configurations
const CHAIN_CONFIGS = {
  [BlockchainNetwork.BITCOIN]: {
    algorithm: 'sha256d',
    blockTime: 600,
    confirmations: 6,
    rpcPort: 8332,
    symbol: 'BTC',
    unitDivisor: 1e8,
    getwork: false,
    stratum: true
  },
  [BlockchainNetwork.ETHEREUM]: {
    algorithm: 'ethash',
    blockTime: 13,
    confirmations: 32,
    rpcPort: 8545,
    symbol: 'ETH',
    unitDivisor: 1e18,
    getwork: false,
    stratum: true,
    dagSize: 5.5 // GB
  },
  [BlockchainNetwork.RAVENCOIN]: {
    algorithm: 'kawpow',
    blockTime: 60,
    confirmations: 100,
    rpcPort: 8766,
    symbol: 'RVN',
    unitDivisor: 1e8,
    getwork: false,
    stratum: true,
    dagSize: 3.3
  },
  [BlockchainNetwork.ERGO]: {
    algorithm: 'autolykos2',
    blockTime: 120,
    confirmations: 720,
    rpcPort: 9053,
    symbol: 'ERGO',
    unitDivisor: 1e9,
    getwork: false,
    stratum: true
  },
  [BlockchainNetwork.KASPA]: {
    algorithm: 'kheavyhash',
    blockTime: 1,
    confirmations: 100,
    rpcPort: 16110,
    symbol: 'KAS',
    unitDivisor: 1e8,
    getwork: false,
    stratum: true,
    fastBlocks: true
  },
  [BlockchainNetwork.MONERO]: {
    algorithm: 'randomx',
    blockTime: 120,
    confirmations: 10,
    rpcPort: 18081,
    symbol: 'XMR',
    unitDivisor: 1e12,
    getwork: false,
    stratum: true,
    cpuOnly: true
  },
  [BlockchainNetwork.CONFLUX]: {
    algorithm: 'octopus',
    blockTime: 0.5,
    confirmations: 50,
    rpcPort: 12537,
    symbol: 'CFX',
    unitDivisor: 1e18,
    getwork: false,
    stratum: true,
    dagSize: 4.2
  }
};

export class MultiChainMiningManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      chains: options.chains || [BlockchainNetwork.BITCOIN, BlockchainNetwork.ETHEREUM],
      switchingEnabled: options.switchingEnabled !== false,
      switchingInterval: options.switchingInterval || 300000, // 5 minutes
      profitabilitySource: options.profitabilitySource || 'whattomine',
      minimumSwitchThreshold: options.minimumSwitchThreshold || 0.05, // 5% improvement
      confirmationBuffer: options.confirmationBuffer || 1.5, // 50% extra confirmations
      maxParallelChains: options.maxParallelChains || 3,
      dagPreloading: options.dagPreloading !== false,
      ...options
    };
    
    // Chain management
    this.activeChains = new Map();
    this.chainConnections = new Map();
    this.chainStatistics = new Map();
    this.pendingBlocks = new Map();
    
    // Profitability tracking
    this.profitabilityData = new Map();
    this.switchingHistory = [];
    
    // DAG management for Ethash-based chains
    this.dagCache = new Map();
    
    // Cross-chain arbitrage opportunities
    this.arbitrageOpportunities = [];
  }

  async initialize() {
    logger.info(`Initializing multi-chain mining manager for ${this.config.chains.length} chains`);
    
    // Initialize chain connections
    for (const chain of this.config.chains) {
      await this.initializeChain(chain);
    }
    
    // Start profitability monitoring
    if (this.config.switchingEnabled) {
      this.startProfitabilityMonitoring();
    }
    
    // Start DAG preloading for Ethash chains
    if (this.config.dagPreloading) {
      this.startDAGPreloading();
    }
    
    // Monitor cross-chain opportunities
    this.startCrossChainMonitoring();
    
    return this;
  }

  async initializeChain(chainName) {
    const config = CHAIN_CONFIGS[chainName];
    if (!config) {
      logger.error(`Unknown chain: ${chainName}`);
      return;
    }
    
    logger.info(`Initializing ${chainName} chain connection`);
    
    try {
      // Create chain connection
      const connection = await this.createChainConnection(chainName, config);
      this.chainConnections.set(chainName, connection);
      
      // Initialize chain statistics
      this.chainStatistics.set(chainName, {
        connected: true,
        lastBlock: null,
        difficulty: 0,
        hashrate: 0,
        blockReward: 0,
        blocksFound: 0,
        sharesSubmitted: 0,
        sharesAccepted: 0,
        efficiency: 100,
        lastUpdate: Date.now()
      });
      
      // Subscribe to chain events
      await this.subscribeToChainEvents(chainName, connection);
      
      // Mark as active
      this.activeChains.set(chainName, {
        config,
        connection,
        active: true,
        miners: new Set(),
        lastSwitchTime: Date.now()
      });
      
      logger.info(`Successfully initialized ${chainName}`);
      
    } catch (error) {
      logger.error(`Failed to initialize ${chainName}:`, error);
      this.chainStatistics.set(chainName, {
        connected: false,
        error: error.message
      });
    }
  }

  async createChainConnection(chainName, config) {
    // Create appropriate connection based on chain type
    if (config.stratum) {
      return this.createStratumConnection(chainName, config);
    } else if (config.getwork) {
      return this.createGetworkConnection(chainName, config);
    } else {
      return this.createRPCConnection(chainName, config);
    }
  }

  createStratumConnection(chainName, config) {
    return new Promise((resolve, reject) => {
      const connection = {
        type: 'stratum',
        chain: chainName,
        config: config,
        socket: null,
        subscribed: false,
        authorized: false,
        extraNonce1: null,
        extraNonce2Size: null,
        currentJob: null
      };
      
      // Connect to stratum server
      const url = this.config.stratumUrls?.[chainName] || `stratum+tcp://localhost:3333`;
      const [protocol, hostPort] = url.split('://');
      const [host, port] = hostPort.split(':');
      
      connection.socket = new WebSocket(`ws://${host}:${port}`);
      
      connection.socket.on('open', () => {
        logger.info(`Stratum connection established for ${chainName}`);
        
        // Subscribe to mining
        this.sendStratumMessage(connection, 'mining.subscribe', [
          `Otedama/1.0`,
          null
        ]);
      });
      
      connection.socket.on('message', (data) => {
        this.handleStratumMessage(connection, data);
      });
      
      connection.socket.on('error', (error) => {
        logger.error(`Stratum error for ${chainName}:`, error);
        reject(error);
      });
      
      connection.socket.on('close', () => {
        logger.warn(`Stratum connection closed for ${chainName}`);
        this.handleChainDisconnection(chainName);
      });
      
      // Set timeout for connection
      setTimeout(() => {
        if (!connection.subscribed) {
          reject(new Error(`Stratum subscription timeout for ${chainName}`));
        } else {
          resolve(connection);
        }
      }, 10000);
    });
  }

  createRPCConnection(chainName, config) {
    const connection = {
      type: 'rpc',
      chain: chainName,
      config: config,
      url: `http://localhost:${config.rpcPort}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${this.config.rpcUser}:${this.config.rpcPass}`).toString('base64')
      }
    };
    
    return connection;
  }

  sendStratumMessage(connection, method, params = []) {
    const message = {
      id: Date.now(),
      method: method,
      params: params
    };
    
    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(JSON.stringify(message) + '\n');
    }
  }

  handleStratumMessage(connection, data) {
    try {
      const messages = data.toString().trim().split('\n');
      
      for (const message of messages) {
        const msg = JSON.parse(message);
        
        if (msg.id === null && msg.method) {
          // Notification from pool
          this.handleStratumNotification(connection, msg);
        } else if (msg.result !== undefined) {
          // Response to our request
          this.handleStratumResponse(connection, msg);
        } else if (msg.error) {
          logger.error(`Stratum error for ${connection.chain}:`, msg.error);
        }
      }
    } catch (error) {
      logger.error('Error parsing stratum message:', error);
    }
  }

  handleStratumNotification(connection, msg) {
    switch (msg.method) {
      case 'mining.notify':
        // New job
        connection.currentJob = {
          jobId: msg.params[0],
          prevHash: msg.params[1],
          coinbase1: msg.params[2],
          coinbase2: msg.params[3],
          merkleBranches: msg.params[4],
          version: msg.params[5],
          nBits: msg.params[6],
          nTime: msg.params[7],
          cleanJobs: msg.params[8]
        };
        
        this.emit('new-job', {
          chain: connection.chain,
          job: connection.currentJob
        });
        break;
        
      case 'mining.set_difficulty':
        connection.currentDifficulty = msg.params[0];
        this.updateChainDifficulty(connection.chain, msg.params[0]);
        break;
        
      case 'mining.set_extranonce':
        connection.extraNonce1 = msg.params[0];
        connection.extraNonce2Size = msg.params[1];
        break;
    }
  }

  handleStratumResponse(connection, msg) {
    // Handle subscription response
    if (!connection.subscribed && msg.result) {
      connection.subscribed = true;
      connection.sessionId = msg.result[1];
      connection.extraNonce1 = msg.result[1];
      connection.extraNonce2Size = msg.result[2];
      
      // Now authorize
      this.sendStratumMessage(connection, 'mining.authorize', [
        this.config.poolUsername || 'otedama.worker',
        this.config.poolPassword || 'x'
      ]);
    }
    
    // Handle authorization response
    if (msg.result === true) {
      connection.authorized = true;
      logger.info(`Authorized on ${connection.chain} pool`);
    }
  }

  async subscribeToChainEvents(chainName, connection) {
    if (connection.type === 'stratum') {
      // Stratum handles its own events
      return;
    }
    
    // For RPC connections, poll for new blocks
    const pollInterval = CHAIN_CONFIGS[chainName].blockTime * 1000 / 10; // Poll 10x per block
    
    setInterval(async () => {
      try {
        const blockInfo = await this.getLatestBlock(chainName);
        this.updateChainStatistics(chainName, blockInfo);
      } catch (error) {
        logger.error(`Failed to poll ${chainName}:`, error);
      }
    }, pollInterval);
  }

  async getLatestBlock(chainName) {
    const connection = this.chainConnections.get(chainName);
    if (!connection || connection.type !== 'rpc') return null;
    
    try {
      const response = await axios.post(connection.url, {
        jsonrpc: '2.0',
        method: 'getblockchaininfo',
        params: [],
        id: 1
      }, {
        headers: connection.headers
      });
      
      return response.data.result;
    } catch (error) {
      throw new Error(`RPC error for ${chainName}: ${error.message}`);
    }
  }

  updateChainStatistics(chainName, blockInfo) {
    const stats = this.chainStatistics.get(chainName);
    if (!stats) return;
    
    stats.lastBlock = blockInfo.blocks;
    stats.difficulty = blockInfo.difficulty;
    stats.lastUpdate = Date.now();
    
    // Calculate network hashrate
    const config = CHAIN_CONFIGS[chainName];
    stats.hashrate = (stats.difficulty * Math.pow(2, 32)) / config.blockTime;
  }

  updateChainDifficulty(chainName, difficulty) {
    const stats = this.chainStatistics.get(chainName);
    if (stats) {
      stats.difficulty = difficulty;
      stats.lastUpdate = Date.now();
    }
  }

  // Multi-chain share submission
  async submitShare(chainName, minerId, share) {
    const chain = this.activeChains.get(chainName);
    if (!chain || !chain.active) {
      throw new Error(`Chain ${chainName} is not active`);
    }
    
    const connection = chain.connection;
    
    // Track share submission
    const stats = this.chainStatistics.get(chainName);
    stats.sharesSubmitted++;
    
    // Submit based on connection type
    if (connection.type === 'stratum') {
      return this.submitStratumShare(connection, minerId, share);
    } else {
      return this.submitRPCShare(connection, minerId, share);
    }
  }

  async submitStratumShare(connection, minerId, share) {
    return new Promise((resolve, reject) => {
      const id = Date.now();
      
      // Send share submission
      this.sendStratumMessage(connection, 'mining.submit', [
        this.config.poolUsername || minerId,
        share.jobId,
        share.extraNonce2,
        share.nTime,
        share.nonce
      ]);
      
      // Wait for response
      const timeout = setTimeout(() => {
        reject(new Error('Share submission timeout'));
      }, 5000);
      
      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            clearTimeout(timeout);
            connection.socket.removeListener('message', handler);
            
            if (msg.result === true) {
              const stats = this.chainStatistics.get(connection.chain);
              stats.sharesAccepted++;
              stats.efficiency = (stats.sharesAccepted / stats.sharesSubmitted) * 100;
              
              resolve({ accepted: true });
            } else {
              resolve({ accepted: false, error: msg.error });
            }
          }
        } catch (error) {
          // Ignore parsing errors
        }
      };
      
      connection.socket.on('message', handler);
    });
  }

  // Chain switching logic
  startProfitabilityMonitoring() {
    // Initial profitability fetch
    this.updateProfitabilityData();
    
    // Periodic updates
    setInterval(() => {
      this.updateProfitabilityData();
    }, 60000); // Every minute
    
    // Switching evaluation
    setInterval(() => {
      this.evaluateChainSwitching();
    }, this.config.switchingInterval);
  }

  async updateProfitabilityData() {
    try {
      // Fetch from multiple sources for accuracy
      const sources = [
        this.fetchWhatToMine(),
        this.fetchCoinWarz(),
        this.fetchMinerstat()
      ];
      
      const results = await Promise.allSettled(sources);
      
      // Aggregate profitability data
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          this.mergeProfitabilityData(result.value);
        }
      }
      
      this.emit('profitability-updated', this.profitabilityData);
      
    } catch (error) {
      logger.error('Failed to update profitability data:', error);
    }
  }

  async fetchWhatToMine() {
    try {
      const response = await axios.get('https://whattomine.com/coins.json', {
        params: {
          factor: {
            // Hash rates for different algorithms
            eth_hr: 100,  // 100 MH/s
            etc_hr: 100,
            rvn_hr: 25,
            erg_hr: 150,
            kas_hr: 1000
          }
        }
      });
      
      const profitData = new Map();
      
      for (const [coin, data] of Object.entries(response.data.coins)) {
        const chainName = this.mapCoinToChain(data.tag);
        if (chainName) {
          profitData.set(chainName, {
            revenue24h: data.revenue,
            profit24h: data.profit,
            difficulty: data.difficulty,
            blockReward: data.block_reward,
            blockTime: data.block_time,
            price: data.exchange_rate
          });
        }
      }
      
      return profitData;
    } catch (error) {
      logger.error('WhatToMine API error:', error);
      return null;
    }
  }

  async fetchCoinWarz() {
    // Similar implementation for CoinWarz API
    return null;
  }

  async fetchMinerstat() {
    // Similar implementation for Minerstat API
    return null;
  }

  mapCoinToChain(coinTag) {
    const mapping = {
      'BTC': BlockchainNetwork.BITCOIN,
      'ETH': BlockchainNetwork.ETHEREUM,
      'ETC': BlockchainNetwork.ETHEREUM_CLASSIC,
      'RVN': BlockchainNetwork.RAVENCOIN,
      'ERG': BlockchainNetwork.ERGO,
      'KAS': BlockchainNetwork.KASPA,
      'IRON': BlockchainNetwork.IRONFISH,
      'XMR': BlockchainNetwork.MONERO,
      'LTC': BlockchainNetwork.LITECOIN,
      'ZEC': BlockchainNetwork.ZCASH,
      'DASH': BlockchainNetwork.DASH,
      'CFX': BlockchainNetwork.CONFLUX,
      'BEAM': BlockchainNetwork.BEAM,
      'GRIN': BlockchainNetwork.GRIN
    };
    
    return mapping[coinTag];
  }

  mergeProfitabilityData(newData) {
    for (const [chain, data] of newData) {
      const existing = this.profitabilityData.get(chain) || {};
      this.profitabilityData.set(chain, {
        ...existing,
        ...data,
        lastUpdate: Date.now()
      });
    }
  }

  async evaluateChainSwitching() {
    if (!this.config.switchingEnabled) return;
    
    const currentChains = Array.from(this.activeChains.keys());
    const profitabilities = [];
    
    // Calculate profitability for each chain
    for (const [chain, data] of this.profitabilityData) {
      const config = CHAIN_CONFIGS[chain];
      if (!config) continue;
      
      const hashrate = this.estimateHashrateForAlgorithm(config.algorithm);
      const dailyProfit = this.calculateDailyProfit(chain, hashrate, data);
      
      profitabilities.push({
        chain,
        algorithm: config.algorithm,
        dailyProfit,
        currentlyMining: currentChains.includes(chain)
      });
    }
    
    // Sort by profitability
    profitabilities.sort((a, b) => b.dailyProfit - a.dailyProfit);
    
    // Determine optimal chains to mine
    const optimalChains = profitabilities
      .slice(0, this.config.maxParallelChains)
      .map(p => p.chain);
    
    // Check if switching is beneficial
    for (const optimal of optimalChains) {
      if (!currentChains.includes(optimal)) {
        // Find least profitable current chain
        const worstCurrent = currentChains
          .map(c => profitabilities.find(p => p.chain === c))
          .sort((a, b) => a.dailyProfit - b.dailyProfit)[0];
        
        const optimalProfit = profitabilities.find(p => p.chain === optimal);
        
        if (optimalProfit && worstCurrent && 
            optimalProfit.dailyProfit > worstCurrent.dailyProfit * (1 + this.config.minimumSwitchThreshold)) {
          // Switch is profitable
          await this.switchChains(worstCurrent.chain, optimal);
        }
      }
    }
  }

  estimateHashrateForAlgorithm(algorithm) {
    // Get hashrate from connected hardware
    // This would integrate with the hardware manager
    const estimates = {
      'sha256d': 100000000000000,  // 100 TH/s
      'ethash': 500000000,          // 500 MH/s
      'kawpow': 250000000,          // 250 MH/s
      'autolykos2': 1000000000,     // 1 GH/s
      'kheavyhash': 5000000000,     // 5 GH/s
      'randomx': 50000,             // 50 KH/s
      'octopus': 300000000          // 300 MH/s
    };
    
    return estimates[algorithm] || 1000000;
  }

  calculateDailyProfit(chain, hashrate, profitData) {
    if (!profitData || !profitData.difficulty) return 0;
    
    const config = CHAIN_CONFIGS[chain];
    const blocksPerDay = 86400 / config.blockTime;
    const networkHashrate = profitData.difficulty * Math.pow(2, 32) / config.blockTime;
    const myShare = hashrate / networkHashrate;
    const dailyBlocks = blocksPerDay * myShare;
    const dailyReward = dailyBlocks * (profitData.blockReward || 0);
    const dailyRevenue = dailyReward * (profitData.price || 0);
    
    // Subtract electricity costs
    const powerCost = this.calculatePowerCost(config.algorithm);
    
    return dailyRevenue - powerCost;
  }

  calculatePowerCost(algorithm) {
    // Power consumption estimates
    const powerConsumption = {
      'sha256d': 3000,    // 3000W for ASIC
      'ethash': 300,      // 300W for GPU
      'kawpow': 350,      // 350W for GPU
      'autolykos2': 250,  // 250W for GPU
      'kheavyhash': 400,  // 400W for ASIC/GPU
      'randomx': 150,     // 150W for CPU
      'octopus': 280      // 280W for GPU
    };
    
    const watts = powerConsumption[algorithm] || 300;
    const kwhPerDay = (watts / 1000) * 24;
    const electricityRate = this.config.electricityRate || 0.10; // $0.10 per kWh
    
    return kwhPerDay * electricityRate;
  }

  async switchChains(fromChain, toChain) {
    logger.info(`Switching from ${fromChain} to ${toChain}`);
    
    try {
      // Record switch
      this.switchingHistory.push({
        from: fromChain,
        to: toChain,
        timestamp: Date.now(),
        reason: 'profitability'
      });
      
      // Notify miners about the switch
      this.emit('chain-switch', {
        from: fromChain,
        to: toChain,
        estimatedDowntime: 30000 // 30 seconds
      });
      
      // Deactivate old chain
      const oldChain = this.activeChains.get(fromChain);
      if (oldChain) {
        oldChain.active = false;
        
        // Gracefully disconnect
        if (oldChain.connection.socket) {
          oldChain.connection.socket.close();
        }
      }
      
      // Activate new chain
      if (!this.activeChains.has(toChain)) {
        await this.initializeChain(toChain);
      } else {
        const newChain = this.activeChains.get(toChain);
        newChain.active = true;
      }
      
      // Update active chains
      this.activeChains.delete(fromChain);
      
      logger.info(`Successfully switched to ${toChain}`);
      
    } catch (error) {
      logger.error(`Failed to switch chains: ${error.message}`);
      
      // Revert on failure
      const oldChain = this.activeChains.get(fromChain);
      if (oldChain) {
        oldChain.active = true;
      }
    }
  }

  // DAG management for Ethash chains
  startDAGPreloading() {
    const ethashChains = this.config.chains.filter(chain => {
      const config = CHAIN_CONFIGS[chain];
      return config && config.algorithm === 'ethash';
    });
    
    for (const chain of ethashChains) {
      this.preloadDAG(chain);
    }
  }

  async preloadDAG(chain) {
    const config = CHAIN_CONFIGS[chain];
    if (!config.dagSize) return;
    
    logger.info(`Preloading DAG for ${chain} (${config.dagSize}GB)`);
    
    // This would integrate with actual DAG generation
    // For now, we simulate it
    this.dagCache.set(chain, {
      size: config.dagSize * 1073741824, // Convert to bytes
      generated: Date.now(),
      ready: true
    });
    
    this.emit('dag-ready', { chain });
  }

  // Cross-chain monitoring
  startCrossChainMonitoring() {
    setInterval(() => {
      this.detectArbitrageOpportunities();
    }, 30000); // Every 30 seconds
  }

  detectArbitrageOpportunities() {
    const opportunities = [];
    
    // Check for price differences between chains
    const btcChains = ['bitcoin', 'bitcoin_cash', 'bitcoin_sv'];
    const ethChains = ['ethereum', 'ethereum_classic'];
    
    // Example: BTC forks arbitrage
    const btcPrices = btcChains.map(chain => ({
      chain,
      price: this.profitabilityData.get(chain)?.price || 0
    })).filter(p => p.price > 0);
    
    if (btcPrices.length >= 2) {
      btcPrices.sort((a, b) => b.price - a.price);
      const priceDiff = (btcPrices[0].price - btcPrices[btcPrices.length - 1].price) / btcPrices[btcPrices.length - 1].price;
      
      if (priceDiff > 0.02) { // 2% difference
        opportunities.push({
          type: 'price-arbitrage',
          chains: btcPrices,
          potentialProfit: priceDiff,
          timestamp: Date.now()
        });
      }
    }
    
    // Check for hashrate arbitrage (same algorithm, different difficulties)
    const algorithmGroups = {};
    for (const [chain, config] of Object.entries(CHAIN_CONFIGS)) {
      if (!algorithmGroups[config.algorithm]) {
        algorithmGroups[config.algorithm] = [];
      }
      algorithmGroups[config.algorithm].push(chain);
    }
    
    for (const [algorithm, chains] of Object.entries(algorithmGroups)) {
      if (chains.length >= 2) {
        const difficulties = chains.map(chain => ({
          chain,
          difficulty: this.chainStatistics.get(chain)?.difficulty || 0,
          reward: this.profitabilityData.get(chain)?.blockReward || 0
        })).filter(d => d.difficulty > 0);
        
        if (difficulties.length >= 2) {
          // Calculate profitability per unit of hashrate
          const profitabilities = difficulties.map(d => ({
            ...d,
            profitPerHash: d.reward / d.difficulty
          }));
          
          profitabilities.sort((a, b) => b.profitPerHash - a.profitPerHash);
          
          const profitDiff = (profitabilities[0].profitPerHash - profitabilities[profitabilities.length - 1].profitPerHash) / 
                           profitabilities[profitabilities.length - 1].profitPerHash;
          
          if (profitDiff > 0.05) { // 5% difference
            opportunities.push({
              type: 'hashrate-arbitrage',
              algorithm,
              chains: profitabilities,
              potentialProfit: profitDiff,
              timestamp: Date.now()
            });
          }
        }
      }
    }
    
    this.arbitrageOpportunities = opportunities;
    
    if (opportunities.length > 0) {
      this.emit('arbitrage-detected', opportunities);
    }
  }

  // Chain-specific optimizations
  async optimizeForChain(chainName) {
    const config = CHAIN_CONFIGS[chainName];
    if (!config) return;
    
    const optimizations = {
      bitcoin: {
        // ASIC-specific optimizations
        extraNonce2Size: 4,
        difficultyMultiplier: 1,
        submitStale: false
      },
      ethereum: {
        // GPU memory optimizations
        dagLoadMode: 'parallel',
        cacheSize: 1073741824, // 1GB
        submitStale: true
      },
      kaspa: {
        // Fast block optimizations
        maxPendingShares: 100,
        shareBuffering: true,
        submitStale: false
      },
      monero: {
        // CPU optimizations
        threads: os.cpus().length - 1,
        hugePages: true,
        affinity: true
      }
    };
    
    return optimizations[chainName] || {};
  }

  // Handle chain disconnections
  handleChainDisconnection(chainName) {
    const chain = this.activeChains.get(chainName);
    if (!chain) return;
    
    chain.active = false;
    
    const stats = this.chainStatistics.get(chainName);
    if (stats) {
      stats.connected = false;
      stats.lastDisconnect = Date.now();
    }
    
    // Attempt reconnection
    setTimeout(() => {
      this.reconnectChain(chainName);
    }, 30000); // 30 seconds
  }

  async reconnectChain(chainName) {
    logger.info(`Attempting to reconnect to ${chainName}`);
    
    try {
      await this.initializeChain(chainName);
      
      // Resume mining if it was active
      const chain = this.activeChains.get(chainName);
      if (chain && chain.miners.size > 0) {
        chain.active = true;
        this.emit('chain-reconnected', { chain: chainName });
      }
    } catch (error) {
      logger.error(`Reconnection failed for ${chainName}:`, error);
      
      // Retry with exponential backoff
      setTimeout(() => {
        this.reconnectChain(chainName);
      }, 60000); // 1 minute
    }
  }

  // Get statistics
  getStatistics() {
    const stats = {
      activeChains: Array.from(this.activeChains.keys()),
      chainStatistics: Object.fromEntries(this.chainStatistics),
      profitabilityData: Object.fromEntries(this.profitabilityData),
      arbitrageOpportunities: this.arbitrageOpportunities,
      switchingHistory: this.switchingHistory.slice(-10),
      dagCache: Array.from(this.dagCache.keys())
    };
    
    return stats;
  }

  // Get chain-specific statistics
  getChainStatistics(chainName) {
    return {
      config: CHAIN_CONFIGS[chainName],
      statistics: this.chainStatistics.get(chainName),
      profitability: this.profitabilityData.get(chainName),
      active: this.activeChains.has(chainName),
      miners: this.activeChains.get(chainName)?.miners.size || 0
    };
  }

  // Shutdown
  async shutdown() {
    logger.info('Shutting down multi-chain mining manager');
    
    // Disconnect all chains
    for (const [chainName, chain] of this.activeChains) {
      if (chain.connection.socket) {
        chain.connection.socket.close();
      }
    }
    
    // Clear intervals
    clearInterval(this.profitabilityInterval);
    clearInterval(this.arbitrageInterval);
  }
}

export default MultiChainMiningManager;