// Share Chain Implementation for Continuous Proof of Work
// Provides a blockchain of shares for fair reward distribution

import EventEmitter from 'events';
import crypto from 'crypto';
import { createLogger } from '../core/logger.js';

const logger = createLogger('share-chain');

// Share chain constants
const SHARE_CHAIN_LENGTH = 8640; // 24 hours worth at 10 second intervals
const SHARE_TARGET_TIME = 10; // 10 seconds between shares
const DIFFICULTY_ADJUSTMENT_INTERVAL = 180; // Adjust every 30 minutes
const MAX_DIFFICULTY_ADJUSTMENT = 4; // Maximum 4x adjustment

export class ShareChain extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      chainLength: options.chainLength || SHARE_CHAIN_LENGTH,
      targetTime: options.targetTime || SHARE_TARGET_TIME,
      adjustmentInterval: options.adjustmentInterval || DIFFICULTY_ADJUSTMENT_INTERVAL,
      maxAdjustment: options.maxAdjustment || MAX_DIFFICULTY_ADJUSTMENT,
      ...options
    };
    
    // Chain state
    this.chain = [];
    this.pendingShares = new Map();
    this.currentDifficulty = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    this.lastAdjustment = Date.now();
    
    // Miner statistics
    this.minerStats = new Map();
    this.rewardWindow = [];
    
    // Fork handling
    this.forks = new Map();
    this.longestChainLength = 0;
    
    // Genesis share
    this.createGenesisShare();
  }

  createGenesisShare() {
    const genesisShare = {
      height: 0,
      hash: '0000000000000000000000000000000000000000000000000000000000000000',
      previousHash: null,
      timestamp: Date.now(),
      difficulty: this.currentDifficulty.toString(16),
      minerId: 'genesis',
      nonce: 0,
      merkleRoot: '0000000000000000000000000000000000000000000000000000000000000000',
      version: 1
    };
    
    this.chain.push(genesisShare);
    this.longestChainLength = 1;
    
    logger.info('Share chain initialized with genesis share');
  }

  async addShare(shareData) {
    try {
      // Validate share
      if (!this.validateShare(shareData)) {
        return { success: false, reason: 'Invalid share' };
      }
      
      // Check if share already exists
      if (this.findShare(shareData.hash)) {
        return { success: false, reason: 'Duplicate share' };
      }
      
      // Create share object
      const share = this.createShare(shareData);
      
      // Check if share extends the main chain
      const tip = this.getChainTip();
      if (share.previousHash === tip.hash) {
        // Extends main chain
        this.chain.push(share);
        this.longestChainLength = this.chain.length;
        
        // Update miner statistics
        this.updateMinerStats(share);
        
        // Check for difficulty adjustment
        if (this.shouldAdjustDifficulty()) {
          this.adjustDifficulty();
        }
        
        // Trim chain if too long
        if (this.chain.length > this.config.chainLength) {
          const removed = this.chain.shift();
          this.emit('share-pruned', removed);
        }
        
        // Calculate rewards
        this.updateRewardWindow(share);
        
        this.emit('share-added', share);
        
        return { success: true, share };
        
      } else {
        // Potential fork
        return this.handleFork(share);
      }
      
    } catch (error) {
      logger.error('Error adding share:', error);
      return { success: false, reason: error.message };
    }
  }

  createShare(data) {
    const previousShare = this.getChainTip();
    
    return {
      height: previousShare.height + 1,
      hash: data.hash,
      previousHash: previousShare.hash,
      timestamp: data.timestamp || Date.now(),
      difficulty: data.difficulty || this.currentDifficulty.toString(16),
      minerId: data.minerId,
      minerAddress: data.minerAddress,
      nonce: data.nonce,
      extraNonce: data.extraNonce,
      merkleRoot: this.calculateMerkleRoot(data),
      version: 1,
      // Additional mining data
      algorithm: data.algorithm,
      coin: data.coin,
      poolNode: data.poolNode,
      shareValue: this.calculateShareValue(data)
    };
  }

  validateShare(share) {
    // Basic validation
    if (!share.hash || !share.minerId || !share.nonce) {
      return false;
    }
    
    // Validate proof of work
    if (!this.validateProofOfWork(share)) {
      return false;
    }
    
    // Validate timestamp
    const now = Date.now();
    if (share.timestamp > now + 600000) { // Not more than 10 minutes in future
      return false;
    }
    
    return true;
  }

  validateProofOfWork(share) {
    const hashBuffer = Buffer.from(share.hash, 'hex');
    const targetBuffer = Buffer.from(share.difficulty || this.currentDifficulty.toString(16), 'hex');
    
    // Check if hash meets difficulty target
    for (let i = 0; i < 32; i++) {
      if (hashBuffer[i] < targetBuffer[i]) return true;
      if (hashBuffer[i] > targetBuffer[i]) return false;
    }
    
    return true;
  }

  calculateMerkleRoot(share) {
    // Calculate merkle root of share data
    const data = [
      share.minerId,
      share.nonce.toString(),
      share.timestamp.toString(),
      share.previousHash || ''
    ];
    
    return this.merkleRoot(data);
  }

  merkleRoot(leaves) {
    if (leaves.length === 0) return null;
    if (leaves.length === 1) return this.hash(leaves[0]);
    
    const tree = leaves.map(leaf => this.hash(leaf));
    
    while (tree.length > 1) {
      const newLevel = [];
      
      for (let i = 0; i < tree.length; i += 2) {
        const left = tree[i];
        const right = tree[i + 1] || left;
        newLevel.push(this.hash(left + right));
      }
      
      tree.splice(0, tree.length, ...newLevel);
    }
    
    return tree[0];
  }

  hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  calculateShareValue(share) {
    // Calculate the value of a share based on its difficulty
    const difficulty = BigInt('0x' + share.difficulty);
    const baseDifficulty = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
    
    // Share value is proportional to difficulty
    return Number(baseDifficulty) / Number(difficulty);
  }

  getChainTip() {
    return this.chain[this.chain.length - 1];
  }

  findShare(hash) {
    // Search in main chain
    const mainChainShare = this.chain.find(s => s.hash === hash);
    if (mainChainShare) return mainChainShare;
    
    // Search in forks
    for (const fork of this.forks.values()) {
      const forkShare = fork.find(s => s.hash === hash);
      if (forkShare) return forkShare;
    }
    
    return null;
  }

  handleFork(share) {
    logger.warn(`Fork detected at height ${share.height}`);
    
    // Find the fork point
    const forkPoint = this.findShareByHash(share.previousHash);
    if (!forkPoint) {
      return { success: false, reason: 'Invalid previous hash' };
    }
    
    // Create or extend fork
    const forkId = `fork-${Date.now()}-${share.hash.substr(0, 8)}`;
    let fork = this.forks.get(forkId);
    
    if (!fork) {
      // New fork
      fork = [share];
      this.forks.set(forkId, fork);
    } else {
      // Extend existing fork
      fork.push(share);
    }
    
    // Check if fork is longer than main chain
    const forkLength = forkPoint.height + fork.length;
    if (forkLength > this.longestChainLength) {
      // Fork is longer, reorganize
      return this.reorganizeChain(forkId, forkPoint);
    }
    
    this.emit('fork-detected', { forkId, share });
    
    return { success: true, share, fork: true };
  }

  findShareByHash(hash) {
    return this.chain.find(s => s.hash === hash);
  }

  reorganizeChain(forkId, forkPoint) {
    logger.info(`Reorganizing chain to fork ${forkId}`);
    
    const fork = this.forks.get(forkId);
    const removedShares = [];
    
    // Remove shares after fork point
    while (this.chain.length > forkPoint.height + 1) {
      removedShares.push(this.chain.pop());
    }
    
    // Add fork shares to main chain
    for (const share of fork) {
      this.chain.push(share);
    }
    
    // Remove fork
    this.forks.delete(forkId);
    
    // Update longest chain length
    this.longestChainLength = this.chain.length;
    
    // Re-calculate rewards
    this.recalculateRewards();
    
    this.emit('chain-reorganized', {
      forkId,
      removedShares,
      newTip: this.getChainTip()
    });
    
    return { success: true, reorganized: true };
  }

  updateMinerStats(share) {
    const stats = this.minerStats.get(share.minerId) || {
      shares: 0,
      totalValue: 0,
      lastShare: null,
      hashrate: 0
    };
    
    stats.shares++;
    stats.totalValue += share.shareValue;
    stats.lastShare = share.timestamp;
    
    // Estimate hashrate
    if (stats.previousShare) {
      const timeDiff = (share.timestamp - stats.previousShare) / 1000;
      const difficulty = BigInt('0x' + share.difficulty);
      stats.hashrate = Number(difficulty) / timeDiff;
    }
    stats.previousShare = share.timestamp;
    
    this.minerStats.set(share.minerId, stats);
  }

  shouldAdjustDifficulty() {
    const sharesSinceAdjustment = this.chain.filter(s => 
      s.timestamp > this.lastAdjustment
    ).length;
    
    return sharesSinceAdjustment >= this.config.adjustmentInterval;
  }

  adjustDifficulty() {
    const recentShares = this.chain.slice(-this.config.adjustmentInterval);
    if (recentShares.length < 2) return;
    
    const timeSpan = recentShares[recentShares.length - 1].timestamp - recentShares[0].timestamp;
    const expectedTime = this.config.targetTime * 1000 * (recentShares.length - 1);
    
    let adjustment = expectedTime / timeSpan;
    
    // Limit adjustment
    adjustment = Math.max(1 / this.config.maxAdjustment, adjustment);
    adjustment = Math.min(this.config.maxAdjustment, adjustment);
    
    // Apply adjustment
    const currentDiffNum = Number(this.currentDifficulty);
    const newDiffNum = Math.floor(currentDiffNum * adjustment);
    this.currentDifficulty = BigInt(newDiffNum);
    
    this.lastAdjustment = Date.now();
    
    logger.info(`Difficulty adjusted by ${(adjustment * 100).toFixed(2)}% to ${this.currentDifficulty.toString(16)}`);
    
    this.emit('difficulty-adjusted', {
      oldDifficulty: currentDiffNum,
      newDifficulty: newDiffNum,
      adjustment
    });
  }

  updateRewardWindow(share) {
    // Add share to reward window
    this.rewardWindow.push({
      height: share.height,
      minerId: share.minerId,
      value: share.shareValue,
      timestamp: share.timestamp
    });
    
    // Remove old shares (keep last N shares for PPLNS)
    const cutoff = share.height - this.config.chainLength;
    this.rewardWindow = this.rewardWindow.filter(s => s.height > cutoff);
  }

  calculateRewards(blockReward) {
    // PPLNS (Pay Per Last N Shares) reward calculation
    const totalValue = this.rewardWindow.reduce((sum, share) => sum + share.value, 0);
    const rewards = new Map();
    
    for (const share of this.rewardWindow) {
      const minerReward = (share.value / totalValue) * blockReward;
      const currentReward = rewards.get(share.minerId) || 0;
      rewards.set(share.minerId, currentReward + minerReward);
    }
    
    return rewards;
  }

  recalculateRewards() {
    // Rebuild reward window from current chain
    this.rewardWindow = [];
    
    const startHeight = Math.max(0, this.chain.length - this.config.chainLength);
    for (let i = startHeight; i < this.chain.length; i++) {
      const share = this.chain[i];
      this.rewardWindow.push({
        height: share.height,
        minerId: share.minerId,
        value: share.shareValue,
        timestamp: share.timestamp
      });
    }
  }

  getSharesInWindow(minerId = null) {
    if (minerId) {
      return this.rewardWindow.filter(s => s.minerId === minerId);
    }
    return [...this.rewardWindow];
  }

  getMinerStatistics(minerId) {
    const stats = this.minerStats.get(minerId);
    if (!stats) return null;
    
    const sharesInWindow = this.getSharesInWindow(minerId);
    const windowValue = sharesInWindow.reduce((sum, s) => sum + s.value, 0);
    const totalWindowValue = this.rewardWindow.reduce((sum, s) => sum + s.value, 0);
    
    return {
      ...stats,
      sharesInWindow: sharesInWindow.length,
      percentageOfWindow: totalWindowValue > 0 ? (windowValue / totalWindowValue) * 100 : 0,
      estimatedHashrate: stats.hashrate
    };
  }

  getChainStatistics() {
    const tip = this.getChainTip();
    const recentShares = this.chain.slice(-100);
    
    // Calculate average share time
    let avgShareTime = 0;
    if (recentShares.length > 1) {
      const timeSpan = recentShares[recentShares.length - 1].timestamp - recentShares[0].timestamp;
      avgShareTime = timeSpan / (recentShares.length - 1);
    }
    
    return {
      height: tip.height,
      tipHash: tip.hash,
      difficulty: this.currentDifficulty.toString(16),
      chainLength: this.chain.length,
      forkCount: this.forks.size,
      totalMiners: this.minerStats.size,
      rewardWindowSize: this.rewardWindow.length,
      averageShareTime: avgShareTime / 1000, // Convert to seconds
      targetShareTime: this.config.targetTime
    };
  }

  // Persistence methods
  serialize() {
    return {
      chain: this.chain,
      currentDifficulty: this.currentDifficulty.toString(16),
      lastAdjustment: this.lastAdjustment,
      minerStats: Array.from(this.minerStats.entries()),
      rewardWindow: this.rewardWindow
    };
  }

  deserialize(data) {
    this.chain = data.chain || [];
    this.currentDifficulty = BigInt('0x' + data.currentDifficulty);
    this.lastAdjustment = data.lastAdjustment || Date.now();
    this.minerStats = new Map(data.minerStats || []);
    this.rewardWindow = data.rewardWindow || [];
    this.longestChainLength = this.chain.length;
  }

  // Utility methods
  getSharesByMiner(minerId, limit = 100) {
    return this.chain
      .filter(s => s.minerId === minerId)
      .slice(-limit);
  }

  getSharesInTimeRange(startTime, endTime) {
    return this.chain.filter(s => 
      s.timestamp >= startTime && s.timestamp <= endTime
    );
  }

  verifyChainIntegrity() {
    if (this.chain.length === 0) return false;
    
    // Verify genesis
    if (this.chain[0].previousHash !== null) return false;
    
    // Verify chain links
    for (let i = 1; i < this.chain.length; i++) {
      if (this.chain[i].previousHash !== this.chain[i - 1].hash) {
        logger.error(`Chain broken at height ${i}`);
        return false;
      }
      
      // Verify proof of work
      if (!this.validateProofOfWork(this.chain[i])) {
        logger.error(`Invalid proof of work at height ${i}`);
        return false;
      }
    }
    
    return true;
  }
}

export default ShareChain;