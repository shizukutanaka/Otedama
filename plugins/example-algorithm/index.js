/**
 * Example Mining Algorithm Plugin
 * Demonstrates how to implement a custom mining algorithm
 */

import { Plugin } from '../../lib/plugins.js';
import { createHash } from 'crypto';

export default class ExampleAlgorithmPlugin extends Plugin {
  constructor(api, config) {
    super(api, config);
    
    this.algorithmName = config.algorithm || 'example-pow';
    this.targetDifficulty = config.difficulty || 16;
    this.stats = {
      hashesComputed: 0,
      blocksFound: 0,
      lastBlockTime: null
    };
  }
  
  async initialize() {
    this.logger.info('Example Algorithm Plugin initializing', {
      algorithm: this.algorithmName,
      difficulty: this.targetDifficulty
    });
    
    // Register our mining algorithm
    this.api.registerCapability('mining.algorithm', {
      name: this.algorithmName,
      displayName: 'Example PoW',
      description: 'Example Proof of Work algorithm for demonstration',
      hashUnit: 'H/s',
      coins: ['EXAMPLE'],
      handler: this.createMiner.bind(this)
    });
    
    // Register configuration hook
    this.api.hooks.register('mining.config', (config) => {
      if (config.algorithm === this.algorithmName) {
        config.pluginConfig = {
          difficulty: this.targetDifficulty,
          blockTime: this.config.blockTime
        };
      }
      return config;
    });
    
    // Listen for mining events
    this.api.events.on('share.submitted', this.onShareSubmitted.bind(this));
    this.api.events.on('block.found', this.onBlockFound.bind(this));
  }
  
  async enable() {
    this.logger.info('Example Algorithm Plugin enabled');
    
    // Start statistics reporting
    this.statsInterval = setInterval(() => {
      this.reportStats();
    }, 60000); // Every minute
    
    // Emit ready event
    this.api.events.emit('ready');
  }
  
  async disable() {
    this.logger.info('Example Algorithm Plugin disabled');
    
    // Stop statistics reporting
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }
  
  async cleanup() {
    // Cleanup resources
    this.stats = null;
  }
  
  /**
   * Create a miner instance for this algorithm
   */
  createMiner(options) {
    return new ExampleMiner(this, options);
  }
  
  /**
   * Handle share submission
   */
  onShareSubmitted(data) {
    if (data.algorithm === this.algorithmName) {
      this.stats.hashesComputed += data.hashes || 0;
    }
  }
  
  /**
   * Handle block found
   */
  onBlockFound(data) {
    if (data.algorithm === this.algorithmName) {
      this.stats.blocksFound++;
      this.stats.lastBlockTime = Date.now();
      
      this.logger.info('Block found!', {
        algorithm: this.algorithmName,
        block: data.blockHash,
        miner: data.minerId
      });
    }
  }
  
  /**
   * Report statistics
   */
  reportStats() {
    const hashrate = this.stats.hashesComputed / 60; // Per second
    
    this.api.events.emit('stats', {
      algorithm: this.algorithmName,
      hashrate,
      blocksFound: this.stats.blocksFound,
      lastBlockTime: this.stats.lastBlockTime
    });
    
    // Reset counter
    this.stats.hashesComputed = 0;
  }
}

/**
 * Example Miner Implementation
 */
class ExampleMiner {
  constructor(plugin, options) {
    this.plugin = plugin;
    this.options = options;
    this.workerId = options.workerId;
    this.difficulty = plugin.targetDifficulty;
    this.mining = false;
    this.hashCount = 0;
  }
  
  /**
   * Start mining
   */
  start(job) {
    if (this.mining) {
      return;
    }
    
    this.mining = true;
    this.currentJob = job;
    
    // Start mining in next tick to not block
    setImmediate(() => this.mine());
  }
  
  /**
   * Stop mining
   */
  stop() {
    this.mining = false;
  }
  
  /**
   * Mining loop
   */
  async mine() {
    const startTime = Date.now();
    let nonce = 0;
    
    while (this.mining && this.currentJob) {
      // Create block header
      const header = this.createBlockHeader(this.currentJob, nonce);
      
      // Calculate hash
      const hash = this.calculateHash(header);
      this.hashCount++;
      
      // Check if hash meets difficulty
      if (this.meetsTarget(hash, this.difficulty)) {
        // Submit share
        this.submitShare({
          jobId: this.currentJob.id,
          nonce,
          hash: hash.toString('hex'),
          difficulty: this.difficulty
        });
      }
      
      nonce++;
      
      // Yield periodically
      if (nonce % 1000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
        
        // Report hashrate
        const elapsed = (Date.now() - startTime) / 1000;
        const hashrate = this.hashCount / elapsed;
        
        this.plugin.api.events.emit('miner.stats', {
          workerId: this.workerId,
          hashrate,
          shares: Math.floor(this.hashCount / 1000000)
        });
      }
    }
  }
  
  /**
   * Create block header
   */
  createBlockHeader(job, nonce) {
    return Buffer.concat([
      Buffer.from(job.prevHash, 'hex'),
      Buffer.from(job.merkleRoot, 'hex'),
      Buffer.from(job.timestamp.toString(16).padStart(8, '0'), 'hex'),
      Buffer.from(job.bits, 'hex'),
      Buffer.from(nonce.toString(16).padStart(8, '0'), 'hex')
    ]);
  }
  
  /**
   * Calculate hash using our example algorithm
   */
  calculateHash(data) {
    // Example: Double SHA-256 (like Bitcoin)
    const hash1 = createHash('sha256').update(data).digest();
    const hash2 = createHash('sha256').update(hash1).digest();
    return hash2;
  }
  
  /**
   * Check if hash meets difficulty target
   */
  meetsTarget(hash, difficulty) {
    // Count leading zero bits
    let zeros = 0;
    
    for (let i = 0; i < hash.length; i++) {
      if (hash[i] === 0) {
        zeros += 8;
      } else {
        // Count leading zeros in byte
        let byte = hash[i];
        while ((byte & 0x80) === 0 && zeros % 8 < 7) {
          zeros++;
          byte <<= 1;
        }
        break;
      }
    }
    
    return zeros >= difficulty;
  }
  
  /**
   * Submit share to pool
   */
  submitShare(share) {
    this.plugin.api.events.emit('share.found', {
      ...share,
      workerId: this.workerId,
      algorithm: this.plugin.algorithmName,
      timestamp: Date.now()
    });
  }
}