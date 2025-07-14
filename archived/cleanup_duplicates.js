#!/usr/bin/env node

/**
 * Otedama - Cleanup duplicates and reorganize files
 */

import { promises as fs } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DuplicateRemover {
  constructor() {
    this.files = new Map();
    this.duplicates = [];
    this.actions = [];
  }

  async run() {
    console.log('Otedama - Duplicate File Cleanup\n');
    
    // 1. Remove old/backup files
    await this.removeOldFiles();
    
    // 2. Check for duplicate content
    await this.findDuplicates();
    
    // 3. Clean up core.js
    await this.cleanupCore();
    
    // 4. Remove unnecessary files
    await this.removeUnnecessaryFiles();
    
    console.log('\nCleanup complete!');
    console.log(`Actions taken: ${this.actions.length}`);
    this.actions.forEach(action => console.log(`  - ${action}`));
  }

  async removeOldFiles() {
    const oldFiles = [
      'index_old.js',
      'backup.js',
      'test.js',
      'monitor.js',
      'payment.js',
      'gpu.js',
      'examples/custom-algorithm.ts.old',
      'examples/deleted_api-client.ts',
      'examples/dex-usage.ts.old',
      'examples/enhanced-features.ts.old'
    ];

    for (const file of oldFiles) {
      try {
        await fs.unlink(path.join(__dirname, file));
        this.actions.push(`Removed old file: ${file}`);
      } catch (error) {
        // File might not exist
      }
    }
  }

  async findDuplicates() {
    const srcDir = path.join(__dirname, 'src');
    const files = await fs.readdir(srcDir);
    
    for (const file of files) {
      if (file.endsWith('.js')) {
        const filePath = path.join(srcDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const hash = createHash('sha256').update(content).digest('hex');
        
        if (this.files.has(hash)) {
          this.duplicates.push({
            file1: this.files.get(hash),
            file2: filePath
          });
        } else {
          this.files.set(hash, filePath);
        }
      }
    }
    
    if (this.duplicates.length > 0) {
      console.log('Found duplicate files:');
      this.duplicates.forEach(dup => {
        console.log(`  ${dup.file1} === ${dup.file2}`);
      });
    }
  }

  async cleanupCore() {
    const corePath = path.join(__dirname, 'src', 'core.js');
    
    try {
      const content = await fs.readFile(corePath, 'utf8');
      
      // Remove duplicate class definitions and clean up
      const cleanedContent = `import { EventEmitter } from 'events';
import { ConfigManager } from './config.js';
import { Logger } from './logger.js';
import { OtedamaDB } from './database.js';
import { SecurityManager } from './security-manager.js';
import { P2PNetwork } from './p2p-network.js';
import { WorkerPool } from './worker-pool.js';
import { MiningEngine } from './mining-engine.js';
import { StratumServer } from './stratum-server.js';
import { APIServer } from './api-server.js';
import { AutomatedDEX } from './automated-dex.js';
import { DEXV3 } from './dex-v3.js';
import { FeeManager } from './fee-manager.js';
import { PaymentManager } from './payment-manager.js';
import { LendingProtocol } from './defi-lending.js';
import { CrossChainBridge } from './cross-chain.js';
import { GovernanceProtocol } from './governance.js';
import { ALGO_CONFIG } from './constants.js';

/**
 * Otedama Core - Central coordination of all components
 */
export class OtedamaCore extends EventEmitter {
  constructor() {
    super();
    this.logger = new Logger('Core');
    this.config = new ConfigManager();
    this.components = {};
    this.startTime = Date.now();
  }

  async initialize() {
    this.logger.info('Initializing core components...');

    try {
      // Initialize database
      this.components.db = new OtedamaDB();
      global.db = this.components.db;
      
      // Initialize security
      this.components.security = new SecurityManager();
      global.security = this.components.security;
      
      // Initialize fee manager
      this.components.feeManager = new FeeManager(this.config, this.components.db);
      global.feeManager = this.components.feeManager;
      this.logger.info('Fee manager initialized with operator address:', this.components.feeManager.getOperatorAddress());
      
      // Initialize payment manager
      this.components.paymentManager = new PaymentManager(
        this.config,
        this.components.db,
        this.components.feeManager
      );
      global.paymentManager = this.components.paymentManager;
      
      // Initialize P2P network
      this.components.p2p = new P2PNetwork(
        this.config.get('network.p2pPort'),
        this.config.get('network.maxPeers')
      );
      global.p2p = this.components.p2p;
      
      // Initialize DEX V2
      this.components.dex = new AutomatedDEX(this.components.feeManager);
      global.dex = this.components.dex;
      
      // Initialize DEX V3
      this.components.dexV3 = new DEXV3(this.components.feeManager);
      global.dexV3 = this.components.dexV3;
      
      // Initialize lending protocol
      this.components.lending = new LendingProtocol(
        this.components.feeManager,
        this.components.dexV3
      );
      global.lending = this.components.lending;
      
      // Initialize cross-chain bridge
      this.components.bridge = new CrossChainBridge(this.components.feeManager);
      global.bridge = this.components.bridge;
      
      // Initialize governance
      this.components.governance = new GovernanceProtocol(this.components.feeManager);
      global.governance = this.components.governance;
      
      // Initialize mining engine if enabled
      if (this.config.get('mining.enabled')) {
        const wallet = this.config.get('mining.walletAddress');
        if (!wallet) {
          this.logger.warn('Mining disabled: No wallet address configured');
        } else {
          this.components.mining = new MiningEngine(this.config.get('mining'));
          global.mining = this.components.mining;
          
          // Connect mining rewards to payment system
          this.components.mining.on('share', async (share) => {
            if (share.valid) {
              const reward = this.calculateReward(share.difficulty);
              await this.components.paymentManager.creditMiner(
                'local',
                wallet,
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
      
      // Connect stratum to payment system
      this.components.stratum.on('share', async (share) => {
        if (share.valid && share.wallet) {
          const reward = this.calculateReward(share.difficulty);
          await this.components.paymentManager.creditMiner(
            share.clientId,
            share.wallet,
            reward,
            this.config.get('mining.currency')
          );
        }
      });
      
      // Initialize API server
      this.components.api = new APIServer(this.config.data);
      global.api = this.components.api;
      
      // Setup event handlers
      this.setupEventHandlers();
      
      this.logger.info('Core initialization complete');
      
    } catch (error) {
      this.logger.error('Initialization failed:', error);
      throw error;
    }
  }

  async start() {
    this.logger.info('Starting Otedama components...');
    
    try {
      // Start P2P network
      await this.components.p2p.start();
      
      // Start mining engine
      if (this.components.mining) {
        const algo = this.config.get('mining.algorithm');
        const difficulty = ALGO_CONFIG[algo]?.difficulty || 1000000;
        await this.components.mining.start({ difficulty });
      }
      
      // Start Stratum server
      await this.components.stratum.start();
      
      // Initialize default pools and protocols
      this.initializeDefaultPools();
      this.initializeDefaultProtocols();
      
      // Start API server
      await this.components.api.start();
      
      // Start periodic broadcasts
      this.startPeriodicBroadcasts();
      
      this.logger.info('All components started successfully');
      this.emit('ready');
      
    } catch (error) {
      this.logger.error('Startup failed:', error);
      throw error;
    }
  }

  async stop() {
    this.logger.info('Stopping Otedama components...');
    
    // Stop periodic broadcasts
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
    }
    
    // Stop components in reverse order
    const stopOrder = [
      'api', 'bridge', 'governance', 'lending', 'dexV3', 'dex',
      'stratum', 'mining', 'p2p', 'paymentManager', 'feeManager', 'db'
    ];
    
    for (const component of stopOrder) {
      if (this.components[component]) {
        try {
          if (typeof this.components[component].stop === 'function') {
            await this.components[component].stop();
          } else if (typeof this.components[component].close === 'function') {
            await this.components[component].close();
          }
          this.logger.info(\`\${component} stopped\`);
        } catch (error) {
          this.logger.error(\`Error stopping \${component}:\`, error.message);
        }
      }
    }
    
    this.logger.info('All components stopped');
  }

  setupEventHandlers() {
    // DEX events
    this.components.dex.on('swap', (data) => {
      this.broadcast('dex', { event: 'swap', version: 'v2', ...data });
    });
    
    this.components.dexV3.on('swap', (data) => {
      this.broadcast('dex', { event: 'swap', version: 'v3', ...data });
    });
    
    // Lending events
    this.components.lending.on('supply', (data) => {
      this.broadcast('lending', { event: 'supply', ...data });
    });
    
    // Mining events
    if (this.components.mining) {
      this.components.mining.on('block', (block) => {
        this.broadcast('mining', { event: 'block', block });
      });
    }
    
    // Stratum events
    this.components.stratum.on('miner:connected', (minerId) => {
      this.broadcast('miners', { event: 'connected', minerId });
    });
  }

  startPeriodicBroadcasts() {
    this.broadcastTimer = setInterval(() => {
      const stats = this.getStats();
      this.broadcast('stats', stats);
    }, 5000);
  }

  broadcast(channel, data) {
    if (this.components.api) {
      this.components.api.broadcast(channel, data);
    }
  }

  initializeDefaultPools() {
    try {
      // V2 Pools
      const v2Pools = [
        { token0: 'BTC', token1: 'USDT', fee: 0.3 },
        { token0: 'ETH', token1: 'USDT', fee: 0.3 },
        { token0: 'RVN', token1: 'USDT', fee: 0.3 }
      ];
      
      for (const pool of v2Pools) {
        try {
          const poolId = this.components.dex.createPool(pool.token0, pool.token1, pool.fee);
          
          // Add initial liquidity
          const liquidityAmounts = {
            'BTC-USDT': ['10000000', '430000000000'],
            'ETH-USDT': ['100000000', '250000000000'],
            'RVN-USDT': ['100000000000', '3000000']
          };
          
          if (liquidityAmounts[poolId]) {
            this.components.dex.addLiquidity(
              poolId,
              liquidityAmounts[poolId][0],
              liquidityAmounts[poolId][1],
              'system'
            );
          }
        } catch (e) {
          // Pool might already exist
        }
      }
      
      // V3 Pools with concentrated liquidity
      const v3Pools = [
        { token0: 'BTC', token1: 'USDT', fee: 500 },
        { token0: 'ETH', token1: 'USDT', fee: 3000 }
      ];
      
      for (const pool of v3Pools) {
        try {
          const initialPrices = {
            'BTC-USDT': 43000,
            'ETH-USDT': 2500
          };
          
          const price = initialPrices[\`\${pool.token0}-\${pool.token1}\`] || 1;
          const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(price) * 2 ** 96));
          
          this.components.dexV3.createPool(
            pool.token0,
            pool.token1,
            pool.fee,
            sqrtPriceX96
          );
        } catch (e) {
          // Pool might already exist
        }
      }
    } catch (error) {
      this.logger.warn('Failed to initialize pools:', error.message);
    }
  }

  initializeDefaultProtocols() {
    try {
      // Initialize lending markets
      const markets = [
        { asset: 'BTC', collateralFactor: 0.75, liquidationThreshold: 0.85 },
        { asset: 'ETH', collateralFactor: 0.75, liquidationThreshold: 0.85 },
        { asset: 'USDT', collateralFactor: 0.80, liquidationThreshold: 0.90 }
      ];
      
      for (const market of markets) {
        try {
          this.components.lending.createMarket(market.asset, market);
        } catch (e) {
          // Market might already exist
        }
      }
      
      // Initialize bridge liquidity
      const chains = ['ETH', 'BSC', 'POLYGON'];
      for (const chain of chains) {
        this.components.bridge.addLiquidity(
          chain,
          'USDT',
          BigInt(1000e18),
          'system'
        );
      }
      
      // Initialize governance token
      this.components.governance.tokenBalances.set('system', BigInt(100000000e18));
      
    } catch (error) {
      this.logger.warn('Failed to initialize protocols:', error.message);
    }
  }

  calculateReward(difficulty) {
    const baseReward = 1000000000; // 10 coins
    const adjustedReward = baseReward * (difficulty / 1000000);
    return Math.floor(adjustedReward);
  }

  getStats() {
    const poolStats = this.components.db.getPoolStats();
    const feeStats = this.components.feeManager.getStats();
    const paymentStats = this.components.paymentManager.getPaymentStats();
    const dexStats = this.components.dex.getStats();
    const dexV3Stats = {
      pools: this.components.dexV3.pools.size,
      positions: this.components.dexV3.positions.size
    };
    
    const memUsage = process.memoryUsage();
    
    return {
      pool: {
        miners: this.components.stratum?.getConnectionCount() || 0,
        hashrate: this.components.stratum?.getTotalHashrate() || 0,
        shares: poolStats,
        efficiency: poolStats.total > 0 ? ((poolStats.valid / poolStats.total) * 100).toFixed(2) : '100.00'
      },
      fees: feeStats,
      payments: paymentStats,
      dex: {
        v2: dexStats,
        v3: dexV3Stats
      },
      mining: this.components.mining?.getStats() || null,
      p2p: {
        peers: this.components.p2p?.getPeerCount() || 0
      },
      system: {
        uptime: Math.floor((Date.now() - this.startTime) / 1000),
        memory: Math.round(memUsage.heapUsed / 1024 / 1024),
        version: '5.0.0'
      }
    };
  }
}
`;

      await fs.writeFile(corePath, cleanedContent);
      this.actions.push('Cleaned up core.js - removed duplicate code');
    } catch (error) {
      console.error('Failed to cleanup core.js:', error.message);
    }
  }

  async removeUnnecessaryFiles() {
    // Check for empty or unnecessary files
    const filesToCheck = [
      'data/.gitkeep',
      'logs/.gitkeep',
      'examples/.gitkeep'
    ];

    for (const file of filesToCheck) {
      try {
        const filePath = path.join(__dirname, file);
        const stats = await fs.stat(filePath);
        if (stats.size === 0) {
          await fs.unlink(filePath);
          this.actions.push(`Removed empty file: ${file}`);
        }
      } catch (error) {
        // File might not exist
      }
    }
  }
}

// Run cleanup
const cleaner = new DuplicateRemover();
cleaner.run().catch(console.error);
