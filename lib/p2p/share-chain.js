/**
 * P2P Share Chain Implementation for Otedama
 * Implements a decentralized share chain like P2Pool
 * 
 * Design principles:
 * - Carmack: High-performance share validation
 * - Martin: Clean separation of consensus logic
 * - Pike: Simple but robust chain management
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('ShareChain');

/**
 * Share block in the P2P share chain
 */
export class ShareBlock {
  constructor(data = {}) {
    this.version = data.version || 1;
    this.height = data.height || 0;
    this.timestamp = data.timestamp || Date.now();
    this.previousHash = data.previousHash || '0'.repeat(64);
    this.merkleRoot = data.merkleRoot || '';
    this.difficulty = data.difficulty || 1;
    this.nonce = data.nonce || 0;
    this.minerId = data.minerId || '';
    this.shares = data.shares || [];
    this.coinbasePayouts = data.coinbasePayouts || new Map();
    this.hash = data.hash || '';
  }

  /**
   * Calculate block hash
   */
  calculateHash() {
    const data = `${this.version}${this.height}${this.timestamp}${this.previousHash}${this.merkleRoot}${this.difficulty}${this.nonce}${this.minerId}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Validate block structure
   */
  isValid() {
    // Check required fields
    if (!this.minerId || !this.previousHash) return false;
    
    // Verify hash meets difficulty
    const targetDifficulty = this.getDifficultyTarget();
    const blockHashBigInt = BigInt('0x' + this.hash);
    
    return blockHashBigInt <= targetDifficulty;
  }

  /**
   * Get difficulty target as BigInt
   */
  getDifficultyTarget() {
    const maxTarget = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    return maxTarget / BigInt(this.difficulty);
  }

  /**
   * Calculate coinbase payouts for PPLNS window
   */
  calculatePayouts(shareWindow, blockReward) {
    const payouts = new Map();
    let totalDifficulty = 0n;
    
    // Calculate total difficulty in window
    for (const share of shareWindow) {
      totalDifficulty += BigInt(share.difficulty);
    }
    
    if (totalDifficulty === 0n) return payouts;
    
    // Calculate payouts proportional to difficulty
    for (const share of shareWindow) {
      const minerDifficulty = BigInt(share.difficulty);
      const payoutAmount = (blockReward * minerDifficulty) / totalDifficulty;
      
      const currentPayout = payouts.get(share.minerId) || 0n;
      payouts.set(share.minerId, currentPayout + payoutAmount);
    }
    
    this.coinbasePayouts = payouts;
    return payouts;
  }

  /**
   * Serialize block for network transmission
   */
  serialize() {
    return {
      version: this.version,
      height: this.height,
      timestamp: this.timestamp,
      previousHash: this.previousHash,
      merkleRoot: this.merkleRoot,
      difficulty: this.difficulty,
      nonce: this.nonce,
      minerId: this.minerId,
      shares: this.shares,
      coinbasePayouts: Array.from(this.coinbasePayouts.entries()),
      hash: this.hash
    };
  }

  /**
   * Deserialize from network data
   */
  static deserialize(data) {
    const block = new ShareBlock(data);
    if (data.coinbasePayouts) {
      block.coinbasePayouts = new Map(data.coinbasePayouts);
    }
    return block;
  }
}

/**
 * P2P Share Chain Manager
 */
export class ShareChain extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Chain parameters
      targetBlockTime: config.targetBlockTime || 30000, // 30 seconds like P2Pool
      shareWindow: config.shareWindow || 2160, // ~6 hours of shares
      minDifficulty: config.minDifficulty || 1000,
      maxDifficulty: config.maxDifficulty || 1000000000,
      difficultyAdjustmentInterval: config.difficultyAdjustmentInterval || 20,
      
      // Consensus parameters
      maxReorgDepth: config.maxReorgDepth || 100,
      confirmationDepth: config.confirmationDepth || 6,
      
      // Network parameters
      propagationTimeout: config.propagationTimeout || 5000,
      validationTimeout: config.validationTimeout || 1000,
      
      ...config
    };
    
    // Chain state
    this.blocks = new Map(); // height -> block
    this.blocksByHash = new Map(); // hash -> block
    this.currentHeight = -1;
    this.currentDifficulty = this.config.minDifficulty;
    this.lastBlock = null;
    
    // Share tracking
    this.pendingShares = [];
    this.shareWindow = [];
    
    // Fork management
    this.forks = new Map(); // hash -> [blocks]
    this.longestChainHeight = 0;
    
    // Performance metrics
    this.metrics = {
      blocksFound: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      reorgs: 0,
      averageBlockTime: this.config.targetBlockTime
    };
  }

  /**
   * Initialize genesis block
   */
  async initialize() {
    const genesisBlock = new ShareBlock({
      height: 0,
      timestamp: Date.now(),
      previousHash: '0'.repeat(64),
      difficulty: this.config.minDifficulty,
      minerId: 'genesis',
      hash: '0'.repeat(64)
    });
    
    genesisBlock.hash = genesisBlock.calculateHash();
    
    await this.addBlock(genesisBlock);
    
    logger.info('Share chain initialized', {
      genesisHash: genesisBlock.hash,
      difficulty: this.config.minDifficulty
    });
  }

  /**
   * Add new block to chain
   */
  async addBlock(block) {
    // Validate block
    if (!await this.validateBlock(block)) {
      throw new Error('Invalid block');
    }
    
    // Check if this extends the main chain
    if (block.previousHash === this.lastBlock?.hash) {
      // Extends main chain
      this.blocks.set(block.height, block);
      this.blocksByHash.set(block.hash, block);
      this.currentHeight = block.height;
      this.lastBlock = block;
      
      // Update share window
      this.updateShareWindow();
      
      // Adjust difficulty if needed
      if (block.height % this.config.difficultyAdjustmentInterval === 0) {
        this.adjustDifficulty();
      }
      
      this.metrics.blocksFound++;
      
      this.emit('block', block);
      
    } else {
      // Potential fork - handle reorganization
      await this.handleFork(block);
    }
  }

  /**
   * Validate block
   */
  async validateBlock(block) {
    // Basic validation
    if (!block.isValid()) {
      logger.debug('Block validation failed: invalid structure');
      return false;
    }
    
    // Check previous block exists (except genesis)
    if (block.height > 0) {
      const previousBlock = this.blocksByHash.get(block.previousHash);
      if (!previousBlock) {
        logger.debug('Block validation failed: previous block not found');
        return false;
      }
      
      // Verify height
      if (block.height !== previousBlock.height + 1) {
        logger.debug('Block validation failed: incorrect height');
        return false;
      }
      
      // Verify timestamp
      if (block.timestamp <= previousBlock.timestamp) {
        logger.debug('Block validation failed: timestamp not increasing');
        return false;
      }
    }
    
    // Verify difficulty
    if (Math.abs(block.difficulty - this.currentDifficulty) > this.currentDifficulty * 0.5) {
      logger.debug('Block validation failed: difficulty out of range');
      return false;
    }
    
    return true;
  }

  /**
   * Handle potential chain fork
   */
  async handleFork(block) {
    logger.warn('Fork detected', {
      blockHeight: block.height,
      blockHash: block.hash,
      previousHash: block.previousHash
    });
    
    // Find common ancestor
    const forkChain = await this.buildForkChain(block);
    
    if (!forkChain) {
      logger.error('Cannot build fork chain');
      return;
    }
    
    // Compare cumulative difficulty
    const mainChainDifficulty = await this.getChainDifficulty(this.currentHeight, forkChain.length);
    const forkChainDifficulty = this.calculateChainDifficulty(forkChain);
    
    if (forkChainDifficulty > mainChainDifficulty) {
      // Fork has more work - reorganize
      await this.reorganize(forkChain);
      this.metrics.reorgs++;
    } else {
      // Store fork for potential future use
      this.forks.set(block.hash, forkChain);
    }
  }

  /**
   * Build fork chain from block
   */
  async buildForkChain(block) {
    const chain = [block];
    let current = block;
    
    // Walk back to find common ancestor
    while (current.previousHash !== '0'.repeat(64)) {
      const previous = this.blocksByHash.get(current.previousHash);
      if (previous) {
        // Found common ancestor
        break;
      }
      
      // Check if we have this block in forks
      let found = false;
      for (const [hash, forkBlocks] of this.forks) {
        const forkBlock = forkBlocks.find(b => b.hash === current.previousHash);
        if (forkBlock) {
          chain.unshift(forkBlock);
          current = forkBlock;
          found = true;
          break;
        }
      }
      
      if (!found) {
        return null; // Cannot build complete chain
      }
    }
    
    return chain;
  }

  /**
   * Calculate chain difficulty
   */
  calculateChainDifficulty(blocks) {
    return blocks.reduce((total, block) => total + BigInt(block.difficulty), 0n);
  }

  /**
   * Get main chain difficulty for range
   */
  async getChainDifficulty(fromHeight, length) {
    let totalDifficulty = 0n;
    
    for (let i = 0; i < length; i++) {
      const block = this.blocks.get(fromHeight - i);
      if (block) {
        totalDifficulty += BigInt(block.difficulty);
      }
    }
    
    return totalDifficulty;
  }

  /**
   * Reorganize chain
   */
  async reorganize(newChain) {
    logger.info('Chain reorganization', {
      oldHeight: this.currentHeight,
      newLength: newChain.length
    });
    
    // Find common ancestor height
    const commonHeight = newChain[0].height - 1;
    
    // Remove blocks after common ancestor
    for (let height = this.currentHeight; height > commonHeight; height--) {
      const block = this.blocks.get(height);
      if (block) {
        this.blocks.delete(height);
        this.blocksByHash.delete(block.hash);
      }
    }
    
    // Add new chain blocks
    for (const block of newChain) {
      this.blocks.set(block.height, block);
      this.blocksByHash.set(block.hash, block);
    }
    
    // Update chain state
    this.currentHeight = newChain[newChain.length - 1].height;
    this.lastBlock = newChain[newChain.length - 1];
    
    // Update share window
    this.updateShareWindow();
    
    this.emit('reorganization', {
      commonHeight,
      oldHeight: commonHeight + 1,
      newHeight: this.currentHeight
    });
  }

  /**
   * Add share to pending
   */
  addShare(share) {
    this.pendingShares.push({
      ...share,
      timestamp: Date.now()
    });
    
    this.metrics.sharesAccepted++;
    this.emit('share', share);
  }

  /**
   * Create new block from pending shares
   */
  async createBlock(minerId, mainBlockHash) {
    const previousBlock = this.lastBlock;
    
    const newBlock = new ShareBlock({
      version: 1,
      height: previousBlock.height + 1,
      timestamp: Date.now(),
      previousHash: previousBlock.hash,
      difficulty: this.currentDifficulty,
      minerId,
      shares: [...this.pendingShares]
    });
    
    // Calculate merkle root from shares
    newBlock.merkleRoot = this.calculateMerkleRoot(newBlock.shares);
    
    // If this share found a main chain block, calculate payouts
    if (mainBlockHash) {
      const blockReward = this.config.blockReward || 625000000n; // Example: 6.25 coins
      newBlock.calculatePayouts(this.shareWindow, blockReward);
    }
    
    // Clear pending shares
    this.pendingShares = [];
    
    return newBlock;
  }

  /**
   * Mine a block (find valid nonce)
   */
  async mineBlock(block, targetDifficulty) {
    let nonce = 0;
    const target = block.getDifficultyTarget();
    
    while (true) {
      block.nonce = nonce;
      block.hash = block.calculateHash();
      
      const hashBigInt = BigInt('0x' + block.hash);
      if (hashBigInt <= target) {
        return block;
      }
      
      nonce++;
      
      // Yield periodically to avoid blocking
      if (nonce % 10000 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  /**
   * Update share window for PPLNS
   */
  updateShareWindow() {
    this.shareWindow = [];
    
    // Collect shares from last N blocks
    for (let i = 0; i < this.config.shareWindow && i <= this.currentHeight; i++) {
      const block = this.blocks.get(this.currentHeight - i);
      if (block && block.shares) {
        this.shareWindow.push(...block.shares);
      }
    }
  }

  /**
   * Adjust difficulty based on block times
   */
  adjustDifficulty() {
    if (this.currentHeight < this.config.difficultyAdjustmentInterval) {
      return;
    }
    
    // Calculate average block time
    const blocks = [];
    for (let i = 0; i < this.config.difficultyAdjustmentInterval; i++) {
      const block = this.blocks.get(this.currentHeight - i);
      if (block) blocks.push(block);
    }
    
    if (blocks.length < 2) return;
    
    const timeSpan = blocks[0].timestamp - blocks[blocks.length - 1].timestamp;
    const averageBlockTime = timeSpan / (blocks.length - 1);
    
    // Adjust difficulty
    const targetTime = this.config.targetBlockTime;
    const adjustmentFactor = targetTime / averageBlockTime;
    
    // Limit adjustment to prevent attacks
    const maxAdjustment = 4;
    const limitedFactor = Math.max(1 / maxAdjustment, Math.min(maxAdjustment, adjustmentFactor));
    
    this.currentDifficulty = Math.floor(this.currentDifficulty * limitedFactor);
    this.currentDifficulty = Math.max(this.config.minDifficulty, 
                                     Math.min(this.config.maxDifficulty, this.currentDifficulty));
    
    // Update metrics
    this.metrics.averageBlockTime = averageBlockTime;
    
    logger.info('Difficulty adjusted', {
      oldDifficulty: Math.floor(this.currentDifficulty / limitedFactor),
      newDifficulty: this.currentDifficulty,
      averageBlockTime,
      adjustmentFactor: limitedFactor
    });
  }

  /**
   * Calculate merkle root from shares
   */
  calculateMerkleRoot(shares) {
    if (shares.length === 0) return '0'.repeat(64);
    
    // Create leaf hashes
    let hashes = shares.map(share => 
      crypto.createHash('sha256')
        .update(JSON.stringify(share))
        .digest('hex')
    );
    
    // Build merkle tree
    while (hashes.length > 1) {
      const newHashes = [];
      
      for (let i = 0; i < hashes.length; i += 2) {
        const left = hashes[i];
        const right = hashes[i + 1] || left; // Duplicate last if odd
        
        const combined = crypto.createHash('sha256')
          .update(left + right)
          .digest('hex');
          
        newHashes.push(combined);
      }
      
      hashes = newHashes;
    }
    
    return hashes[0];
  }

  /**
   * Get current chain statistics
   */
  getStats() {
    return {
      height: this.currentHeight,
      difficulty: this.currentDifficulty,
      lastBlockHash: this.lastBlock?.hash,
      lastBlockTime: this.lastBlock?.timestamp,
      shareWindowSize: this.shareWindow.length,
      pendingShares: this.pendingShares.length,
      forks: this.forks.size,
      ...this.metrics
    };
  }

  /**
   * Get shares for miner in current window
   */
  getMinerShares(minerId) {
    return this.shareWindow.filter(share => share.minerId === minerId);
  }

  /**
   * Get expected payout for miner
   */
  getExpectedPayout(minerId, blockReward) {
    const minerShares = this.getMinerShares(minerId);
    if (minerShares.length === 0) return 0n;
    
    let minerDifficulty = 0n;
    let totalDifficulty = 0n;
    
    for (const share of this.shareWindow) {
      const difficulty = BigInt(share.difficulty);
      totalDifficulty += difficulty;
      if (share.minerId === minerId) {
        minerDifficulty += difficulty;
      }
    }
    
    if (totalDifficulty === 0n) return 0n;
    
    return (blockReward * minerDifficulty) / totalDifficulty;
  }

  /**
   * Serialize chain state for persistence
   */
  serialize() {
    const blocks = [];
    for (let i = 0; i <= this.currentHeight; i++) {
      const block = this.blocks.get(i);
      if (block) {
        blocks.push(block.serialize());
      }
    }
    
    return {
      blocks,
      currentHeight: this.currentHeight,
      currentDifficulty: this.currentDifficulty,
      metrics: this.metrics
    };
  }

  /**
   * Deserialize chain state
   */
  static async deserialize(data, config) {
    const chain = new ShareChain(config);
    
    // Restore blocks
    for (const blockData of data.blocks) {
      const block = ShareBlock.deserialize(blockData);
      chain.blocks.set(block.height, block);
      chain.blocksByHash.set(block.hash, block);
    }
    
    chain.currentHeight = data.currentHeight;
    chain.currentDifficulty = data.currentDifficulty;
    chain.lastBlock = chain.blocks.get(chain.currentHeight);
    chain.metrics = data.metrics;
    
    // Rebuild share window
    chain.updateShareWindow();
    
    return chain;
  }
}

export default ShareChain;