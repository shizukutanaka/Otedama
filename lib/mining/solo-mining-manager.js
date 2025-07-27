/**
 * Solo Mining Manager - Otedama
 * Enables solo mining alongside pool operation
 * 
 * Features:
 * - Independent solo mining operation
 * - Direct blockchain connection
 * - Coinbase transaction management
 * - Concurrent pool/solo mining
 * - Automatic block submission
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { Worker } from 'worker_threads';
import os from 'os';
import { AlgorithmManager } from './algorithms/index.js';
import { HardwareDetector } from './hardware/hardware-detector.js';
import { GPUMiningManager } from './gpu-mining.js';
import { ASICMiningManager } from './asic-mining.js';

const logger = createLogger('SoloMiningManager');

/**
 * Solo Mining Manager
 */
export class SoloMiningManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    // Configuration
    this.config = {
      // Blockchain RPC
      rpcUrl: config.rpcUrl || process.env.BITCOIN_RPC_URL || 'http://localhost:8332',
      rpcUser: config.rpcUser || process.env.BITCOIN_RPC_USER || 'user',
      rpcPassword: config.rpcPassword || process.env.BITCOIN_RPC_PASSWORD || 'pass',
      
      // Mining settings
      algorithm: config.algorithm || 'sha256',
      coinbaseAddress: config.coinbaseAddress || null,
      coinbaseMessage: config.coinbaseMessage || 'Otedama Solo Mining',
      
      // Hardware settings
      threads: config.threads || Math.max(1, Math.floor(os.cpus().length / 2)),
      cpuEnabled: config.cpuEnabled !== false,
      gpuEnabled: config.gpuEnabled || false,
      asicEnabled: config.asicEnabled || false,
      intensity: config.intensity || 20,
      
      // Performance settings
      blockUpdateInterval: config.blockUpdateInterval || 15000, // 15 seconds
      shareAllocationRatio: config.shareAllocationRatio || 0.5, // 50% of resources for solo
      
      // Advanced settings
      extraNonce1Size: config.extraNonce1Size || 4,
      extraNonce2Size: config.extraNonce2Size || 4
    };
    
    // Validate configuration
    if (!this.config.coinbaseAddress) {
      throw new Error('Coinbase address is required for solo mining');
    }
    
    // State
    this.mining = false;
    this.connected = false;
    this.currentTemplate = null;
    this.extraNonce1 = crypto.randomBytes(this.config.extraNonce1Size);
    this.extraNonce2 = 0;
    
    // Workers
    this.workers = [];
    this.algorithmManager = null;
    this.hardwareDetector = null;
    this.gpuManager = null;
    this.asicManager = null;
    
    // Statistics
    this.stats = {
      startTime: Date.now(),
      blocksFound: 0,
      sharesProcessed: 0,
      hashrate: 0,
      difficulty: 0,
      networkDifficulty: 0,
      estimatedTimeToBlock: 0
    };
    
    // Timers
    this.blockUpdateTimer = null;
    this.statsTimer = null;
  }
  
  /**
   * Initialize solo mining manager
   */
  async initialize() {
    logger.info('Initializing solo mining manager...');
    
    try {
      // Initialize algorithm manager
      this.algorithmManager = new AlgorithmManager();
      await this.algorithmManager.initialize();
      
      // Detect hardware
      if (this.config.cpuEnabled || this.config.gpuEnabled) {
        this.hardwareDetector = new HardwareDetector();
        const hardware = await this.hardwareDetector.detect();
        
        logger.info('Detected hardware for solo mining:');
        if (hardware.cpu) {
          logger.info(`  CPU: ${hardware.cpu.model} (${hardware.cpu.cores} cores)`);
        }
        
        for (const gpu of hardware.gpus) {
          logger.info(`  GPU: ${gpu.name} (${gpu.memory}MB)`);
        }
      }
      
      // Initialize CPU workers
      if (this.config.cpuEnabled) {
        await this.initializeCPUWorkers();
      }
      
      // Initialize GPU mining
      if (this.config.gpuEnabled) {
        await this.initializeGPUMining();
      }
      
      // Initialize ASIC mining
      if (this.config.asicEnabled) {
        await this.initializeASICMining();
      }
      
      // Test blockchain connection
      await this.testBlockchainConnection();
      
      logger.info('Solo mining manager initialized');
      this.emit('initialized');
      
    } catch (error) {
      logger.error('Failed to initialize solo mining manager:', error);
      throw error;
    }
  }
  
  /**
   * Test blockchain connection
   */
  async testBlockchainConnection() {
    try {
      const info = await this.rpcCall('getblockchaininfo', []);
      logger.info(`Connected to blockchain: ${info.chain}, height: ${info.blocks}`);
      this.connected = true;
      this.stats.networkDifficulty = info.difficulty;
    } catch (error) {
      logger.error('Failed to connect to blockchain:', error);
      throw new Error('Blockchain connection failed');
    }
  }
  
  /**
   * Initialize CPU workers
   */
  async initializeCPUWorkers() {
    logger.info(`Initializing ${this.config.threads} CPU mining threads for solo mining...`);
    
    for (let i = 0; i < this.config.threads; i++) {
      const worker = new Worker(new URL('./workers/cpu-worker.js', import.meta.url), {
        workerData: {
          threadId: i,
          algorithm: this.config.algorithm,
          mode: 'solo'
        }
      });
      
      worker.on('message', message => {
        this.handleWorkerMessage(worker, message);
      });
      
      worker.on('error', error => {
        logger.error(`Solo CPU worker ${i} error:`, error);
      });
      
      this.workers.push({
        type: 'cpu',
        id: i,
        worker,
        hashrate: 0
      });
    }
  }
  
  /**
   * Initialize GPU mining
   */
  async initializeGPUMining() {
    logger.info('Initializing GPU mining for solo...');
    
    this.gpuManager = new GPUMiningManager({
      algorithm: this.config.algorithm,
      intensity: this.config.intensity,
      mode: 'solo'
    });
    
    const initialized = await this.gpuManager.initialize();
    
    if (initialized) {
      this.gpuManager.on('share', share => {
        this.processShare(share);
      });
      
      this.gpuManager.on('stats', stats => {
        this.updateGPUStats(stats);
      });
    }
  }
  
  /**
   * Initialize ASIC mining
   */
  async initializeASICMining() {
    logger.info('Initializing ASIC mining for solo...');
    
    this.asicManager = new ASICMiningManager();
    await this.asicManager.initialize();
    
    if (this.asicManager.devices.length > 0) {
      logger.info(`Found ${this.asicManager.devices.length} ASIC devices for solo mining`);
      
      this.asicManager.on('share', share => {
        this.processShare(share);
      });
      
      this.asicManager.on('stats:updated', stats => {
        this.updateASICStats(stats);
      });
    }
  }
  
  /**
   * Start solo mining
   */
  async start() {
    if (this.mining) {
      logger.warn('Solo mining already started');
      return;
    }
    
    logger.info('Starting solo mining...');
    
    try {
      // Get initial block template
      await this.updateBlockTemplate();
      
      // Start block template updates
      this.blockUpdateTimer = setInterval(() => {
        this.updateBlockTemplate().catch(error => {
          logger.error('Failed to update block template:', error);
        });
      }, this.config.blockUpdateInterval);
      
      // Start statistics updates
      this.statsTimer = setInterval(() => {
        this.updateStatistics();
        this.logStatistics();
      }, 10000); // Every 10 seconds
      
      // Start mining
      this.mining = true;
      this.stats.startTime = Date.now();
      
      // Start all workers
      this.broadcastToWorkers({
        type: 'start',
        mode: 'solo'
      });
      
      // Start GPU mining
      if (this.gpuManager) {
        await this.gpuManager.start(this.currentTemplate, this.stats.difficulty);
      }
      
      // Start ASIC mining
      if (this.asicManager) {
        await this.asicManager.startSoloMining(this.currentTemplate);
      }
      
      logger.info('Solo mining started');
      this.emit('started');
      
    } catch (error) {
      logger.error('Failed to start solo mining:', error);
      throw error;
    }
  }
  
  /**
   * Stop solo mining
   */
  async stop() {
    logger.info('Stopping solo mining...');
    
    this.mining = false;
    
    // Stop timers
    if (this.blockUpdateTimer) {
      clearInterval(this.blockUpdateTimer);
      this.blockUpdateTimer = null;
    }
    
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    
    // Stop workers
    this.broadcastToWorkers({
      type: 'stop'
    });
    
    // Stop GPU mining
    if (this.gpuManager) {
      await this.gpuManager.stop();
    }
    
    // Stop ASIC mining
    if (this.asicManager) {
      await this.asicManager.stopSoloMining();
    }
    
    // Terminate workers
    for (const workerInfo of this.workers) {
      await workerInfo.worker.terminate();
    }
    this.workers = [];
    
    logger.info('Solo mining stopped');
    this.emit('stopped');
  }
  
  /**
   * Update block template
   */
  async updateBlockTemplate() {
    try {
      // Get block template from blockchain
      const template = await this.rpcCall('getblocktemplate', [{
        capabilities: ['coinbasetxn', 'workid', 'coinbase/append'],
        rules: ['segwit']
      }]);
      
      // Create coinbase transaction
      const coinbaseTx = this.createCoinbaseTransaction(template);
      
      // Update current template
      this.currentTemplate = {
        ...template,
        coinbaseTx,
        jobId: crypto.randomBytes(8).toString('hex'),
        prevHash: template.previousblockhash,
        merkleRoot: this.calculateMerkleRoot(coinbaseTx, template.transactions),
        timestamp: Math.floor(Date.now() / 1000),
        cleanJobs: true
      };
      
      // Update difficulty
      this.stats.difficulty = this.calculateDifficulty(template.bits);
      this.stats.networkDifficulty = template.difficulty;
      
      // Broadcast new work to workers
      this.broadcastToWorkers({
        type: 'newJob',
        job: this.currentTemplate,
        extraNonce1: this.extraNonce1.toString('hex'),
        extraNonce2Size: this.config.extraNonce2Size,
        difficulty: this.stats.difficulty
      });
      
      logger.debug(`Updated block template: height ${template.height}, difficulty ${this.stats.difficulty}`);
      
    } catch (error) {
      logger.error('Failed to update block template:', error);
      throw error;
    }
  }
  
  /**
   * Create coinbase transaction
   */
  createCoinbaseTransaction(template) {
    const coinbaseValue = template.coinbasevalue;
    const height = template.height;
    
    // Build coinbase script
    const heightBuffer = Buffer.alloc(4);
    heightBuffer.writeUInt32LE(height, 0);
    
    const coinbaseScript = Buffer.concat([
      Buffer.from([0x03]), // Height length
      heightBuffer.slice(0, 3), // Height (little endian)
      Buffer.from(this.config.coinbaseMessage, 'utf8')
    ]);
    
    // Build coinbase transaction
    const tx = {
      version: 1,
      inputs: [{
        prevTxId: Buffer.alloc(32, 0),
        outputIndex: 0xffffffff,
        script: coinbaseScript,
        sequence: 0xffffffff
      }],
      outputs: [{
        value: coinbaseValue,
        script: this.createPayToAddress(this.config.coinbaseAddress)
      }],
      lockTime: 0
    };
    
    return tx;
  }
  
  /**
   * Create pay-to-address script
   */
  createPayToAddress(address) {
    // Simplified P2PKH script creation
    // In production, use proper address decoding
    const addressHash = crypto.createHash('sha256')
      .update(address)
      .digest()
      .slice(0, 20);
    
    return Buffer.concat([
      Buffer.from([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 <push 20>
      addressHash,
      Buffer.from([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
    ]);
  }
  
  /**
   * Calculate merkle root
   */
  calculateMerkleRoot(coinbaseTx, transactions) {
    const txHashes = [this.hashTransaction(coinbaseTx)];
    
    for (const tx of transactions) {
      txHashes.push(Buffer.from(tx.txid, 'hex'));
    }
    
    // Calculate merkle root
    let level = txHashes;
    while (level.length > 1) {
      const nextLevel = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left;
        const combined = Buffer.concat([left, right]);
        const hash = crypto.createHash('sha256')
          .update(crypto.createHash('sha256').update(combined).digest())
          .digest();
        nextLevel.push(hash);
      }
      level = nextLevel;
    }
    
    return level[0];
  }
  
  /**
   * Hash transaction
   */
  hashTransaction(tx) {
    // Simplified transaction serialization
    const serialized = Buffer.concat([
      Buffer.from([tx.version]),
      // ... serialize inputs and outputs
      Buffer.from([tx.lockTime])
    ]);
    
    return crypto.createHash('sha256')
      .update(crypto.createHash('sha256').update(serialized).digest())
      .digest();
  }
  
  /**
   * Calculate difficulty from bits
   */
  calculateDifficulty(bits) {
    const bitsNum = parseInt(bits, 16);
    const exponent = bitsNum >> 24;
    const mantissa = bitsNum & 0xffffff;
    const target = mantissa * Math.pow(2, 8 * (exponent - 3));
    const maxTarget = Math.pow(2, 256) - 1;
    return maxTarget / target;
  }
  
  /**
   * Handle worker message
   */
  handleWorkerMessage(worker, message) {
    switch (message.type) {
      case 'share':
        this.processShare(message.share);
        break;
        
      case 'hashrate':
        const workerInfo = this.workers.find(w => w.worker === worker);
        if (workerInfo) {
          workerInfo.hashrate = message.hashrate;
        }
        break;
        
      case 'error':
        logger.error('Solo worker error:', message.error);
        break;
    }
  }
  
  /**
   * Process share
   */
  async processShare(share) {
    this.stats.sharesProcessed++;
    
    // Check if share meets network difficulty
    const shareHash = this.calculateShareHash(share);
    const shareDifficulty = this.calculateShareDifficulty(shareHash);
    
    if (shareDifficulty >= this.stats.networkDifficulty) {
      // We found a block!
      logger.info('═══════════════════════════════════════════');
      logger.info('       SOLO BLOCK FOUND!                    ');
      logger.info('═══════════════════════════════════════════');
      logger.info(`Hash: ${shareHash.toString('hex')}`);
      logger.info(`Height: ${this.currentTemplate.height}`);
      logger.info('═══════════════════════════════════════════');
      
      await this.submitBlock(share);
    }
  }
  
  /**
   * Calculate share hash
   */
  calculateShareHash(share) {
    // Build block header
    const header = Buffer.concat([
      Buffer.from(this.currentTemplate.version.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(this.currentTemplate.prevHash, 'hex'),
      this.currentTemplate.merkleRoot,
      Buffer.from(share.time.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(this.currentTemplate.bits, 'hex'),
      Buffer.from(share.nonce, 'hex')
    ]);
    
    // Double SHA256
    return crypto.createHash('sha256')
      .update(crypto.createHash('sha256').update(header).digest())
      .digest();
  }
  
  /**
   * Calculate share difficulty
   */
  calculateShareDifficulty(hash) {
    let difficulty = 0;
    for (let i = hash.length - 1; i >= 0; i--) {
      if (hash[i] === 0) {
        difficulty += 8;
      } else {
        difficulty += Math.floor(Math.log2(256 / hash[i]));
        break;
      }
    }
    return Math.pow(2, difficulty);
  }
  
  /**
   * Submit block to blockchain
   */
  async submitBlock(share) {
    try {
      // Build complete block
      const block = this.buildBlock(share);
      
      // Submit to blockchain
      const result = await this.rpcCall('submitblock', [block]);
      
      if (result === null) {
        // Block accepted!
        this.stats.blocksFound++;
        logger.info('Block accepted by network!');
        this.emit('block:found', {
          height: this.currentTemplate.height,
          hash: this.calculateShareHash(share).toString('hex'),
          reward: this.currentTemplate.coinbasevalue / 1e8
        });
      } else {
        logger.error('Block rejected:', result);
      }
      
    } catch (error) {
      logger.error('Failed to submit block:', error);
    }
  }
  
  /**
   * Build complete block
   */
  buildBlock(share) {
    // This is a simplified implementation
    // In production, properly serialize the entire block
    const header = Buffer.concat([
      Buffer.from(this.currentTemplate.version.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(this.currentTemplate.prevHash, 'hex'),
      this.currentTemplate.merkleRoot,
      Buffer.from(share.time.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(this.currentTemplate.bits, 'hex'),
      Buffer.from(share.nonce, 'hex')
    ]);
    
    // Add transaction count and transactions
    const txCount = Buffer.from([this.currentTemplate.transactions.length + 1]);
    const coinbaseTx = this.serializeTransaction(this.currentTemplate.coinbaseTx);
    
    let block = Buffer.concat([header, txCount, coinbaseTx]);
    
    for (const tx of this.currentTemplate.transactions) {
      block = Buffer.concat([block, Buffer.from(tx.data, 'hex')]);
    }
    
    return block.toString('hex');
  }
  
  /**
   * Serialize transaction
   */
  serializeTransaction(tx) {
    // Simplified transaction serialization
    return Buffer.concat([
      Buffer.from([tx.version]),
      // ... serialize inputs and outputs
      Buffer.from([tx.lockTime])
    ]);
  }
  
  /**
   * Broadcast message to workers
   */
  broadcastToWorkers(message) {
    for (const workerInfo of this.workers) {
      workerInfo.worker.postMessage(message);
    }
  }
  
  /**
   * Update statistics
   */
  updateStatistics() {
    // Calculate total hashrate
    let totalHashrate = 0;
    
    // CPU hashrate
    for (const worker of this.workers) {
      totalHashrate += worker.hashrate;
    }
    
    // GPU hashrate
    if (this.gpuManager && this.gpuManager.stats) {
      totalHashrate += this.gpuManager.stats.hashrate;
    }
    
    // ASIC hashrate
    if (this.asicManager && this.asicManager.stats) {
      totalHashrate += this.asicManager.stats.totalHashrate;
    }
    
    this.stats.hashrate = totalHashrate;
    
    // Calculate estimated time to block
    if (this.stats.hashrate > 0 && this.stats.networkDifficulty > 0) {
      const expectedShares = this.stats.networkDifficulty * Math.pow(2, 32);
      const sharesPerSecond = this.stats.hashrate;
      this.stats.estimatedTimeToBlock = expectedShares / sharesPerSecond;
    }
  }
  
  /**
   * Update GPU statistics
   */
  updateGPUStats(stats) {
    // GPU stats are handled in updateStatistics
  }
  
  /**
   * Update ASIC statistics
   */
  updateASICStats(stats) {
    // ASIC stats are handled in updateStatistics
  }
  
  /**
   * Log statistics
   */
  logStatistics() {
    const runtime = (Date.now() - this.stats.startTime) / 1000;
    
    logger.info('==== Solo Mining Statistics ====');
    logger.info(`Hashrate: ${this.formatHashrate(this.stats.hashrate)}`);
    logger.info(`Shares processed: ${this.stats.sharesProcessed}`);
    logger.info(`Blocks found: ${this.stats.blocksFound}`);
    logger.info(`Network difficulty: ${this.stats.networkDifficulty.toExponential(2)}`);
    logger.info(`Est. time to block: ${this.formatDuration(this.stats.estimatedTimeToBlock)}`);
    logger.info(`Runtime: ${this.formatDuration(runtime)}`);
    logger.info('================================');
  }
  
  /**
   * Format hashrate
   */
  formatHashrate(hashrate) {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
    let unitIndex = 0;
    let value = hashrate;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex++;
    }
    
    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }
  
  /**
   * Format duration
   */
  formatDuration(seconds) {
    if (!isFinite(seconds)) return 'N/A';
    
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`;
    } else {
      return `${minutes}m ${secs}s`;
    }
  }
  
  /**
   * Make RPC call to blockchain
   */
  async rpcCall(method, params = []) {
    const auth = Buffer.from(`${this.config.rpcUser}:${this.config.rpcPassword}`).toString('base64');
    
    const response = await fetch(this.config.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: Date.now(),
        method,
        params
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error.message);
    }
    
    return data.result;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
      efficiency: this.stats.blocksFound > 0 ? 
        (this.stats.blocksFound / this.stats.sharesProcessed * 100) : 0
    };
  }
}

export default SoloMiningManager;