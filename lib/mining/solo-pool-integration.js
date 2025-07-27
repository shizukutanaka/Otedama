/**
 * Solo Mining Pool Integration
 * Enables miners to choose between pool and solo mining
 * 
 * Features:
 * - Seamless switching between pool and solo mode
 * - Ultra-low 0.5% fee for solo mining (industry's lowest)
 * - Direct block rewards to miners
 * - Concurrent pool/solo operation
 * - Real-time mode switching
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';

const logger = createLogger('SoloPoolIntegration');

/**
 * Mining modes
 */
export const MiningMode = {
  POOL: 'pool',         // Traditional pool mining with shares
  SOLO: 'solo',         // Solo mining with full block rewards
  HYBRID: 'hybrid'      // Split resources between pool and solo
};

/**
 * Solo Mining Integration
 */
export class SoloPoolIntegration extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      soloFee: config.soloFee || 0.005, // 0.5% - industry's lowest!
      poolFee: config.poolFee || 0.01,   // 1% for pool mode
      minPayout: config.minPayout || 0,  // No minimum for solo
      separatePort: config.separatePort || false,
      soloPort: config.soloPort || 3334,
      allowModeSwitching: config.allowModeSwitching !== false
    };
    
    // Miner tracking
    this.miners = new Map();
    this.soloMiners = new Map();
    this.poolMiners = new Map();
    
    // Statistics
    this.stats = {
      totalMiners: 0,
      soloMiners: 0,
      poolMiners: 0,
      soloBlocks: 0,
      poolBlocks: 0,
      soloHashrate: 0,
      poolHashrate: 0
    };
  }
  
  /**
   * Register miner with mode selection
   */
  registerMiner(miner, mode = MiningMode.POOL) {
    const minerId = miner.id || crypto.randomBytes(16).toString('hex');
    
    const minerInfo = {
      id: minerId,
      address: miner.address,
      mode: mode,
      difficulty: miner.difficulty || 1,
      hashrate: 0,
      shares: 0,
      blocksFound: 0,
      earnings: 0,
      lastSeen: Date.now(),
      soloAccount: null // For solo mining payouts
    };
    
    // Set up solo account if in solo mode
    if (mode === MiningMode.SOLO) {
      minerInfo.soloAccount = {
        address: miner.address,
        pendingReward: 0,
        blocksFound: 0,
        totalEarnings: 0
      };
    }
    
    this.miners.set(minerId, minerInfo);
    this.updateMinerLists();
    
    logger.info(`Miner ${minerId} registered in ${mode} mode`);
    this.emit('miner:registered', { minerId, mode });
    
    return minerId;
  }
  
  /**
   * Switch mining mode for a miner
   */
  switchMode(minerId, newMode) {
    const miner = this.miners.get(minerId);
    if (!miner) {
      throw new Error('Miner not found');
    }
    
    if (!this.config.allowModeSwitching) {
      throw new Error('Mode switching is disabled');
    }
    
    const oldMode = miner.mode;
    miner.mode = newMode;
    
    // Set up solo account if switching to solo
    if (newMode === MiningMode.SOLO && !miner.soloAccount) {
      miner.soloAccount = {
        address: miner.address,
        pendingReward: 0,
        blocksFound: 0,
        totalEarnings: 0
      };
    }
    
    this.updateMinerLists();
    
    logger.info(`Miner ${minerId} switched from ${oldMode} to ${newMode}`);
    this.emit('mode:switched', { minerId, oldMode, newMode });
  }
  
  /**
   * Update miner lists based on mode
   */
  updateMinerLists() {
    this.soloMiners.clear();
    this.poolMiners.clear();
    
    let soloCount = 0;
    let poolCount = 0;
    
    for (const [id, miner] of this.miners) {
      if (miner.mode === MiningMode.SOLO) {
        this.soloMiners.set(id, miner);
        soloCount++;
      } else if (miner.mode === MiningMode.POOL) {
        this.poolMiners.set(id, miner);
        poolCount++;
      }
    }
    
    this.stats.soloMiners = soloCount;
    this.stats.poolMiners = poolCount;
    this.stats.totalMiners = soloCount + poolCount;
  }
  
  /**
   * Handle share submission
   */
  async handleShare(minerId, share) {
    const miner = this.miners.get(minerId);
    if (!miner) {
      throw new Error('Miner not found');
    }
    
    miner.shares++;
    miner.lastSeen = Date.now();
    
    // Route based on mining mode
    if (miner.mode === MiningMode.SOLO) {
      return this.handleSoloShare(miner, share);
    } else {
      return this.handlePoolShare(miner, share);
    }
  }
  
  /**
   * Handle solo mining share
   */
  async handleSoloShare(miner, share) {
    // Check if share meets block difficulty
    if (share.meetsDifficulty) {
      // Calculate reward with solo fee
      const blockReward = share.blockValue;
      const fee = blockReward * this.config.soloFee;
      const minerReward = blockReward - fee;
      
      // Update miner account
      miner.soloAccount.pendingReward += minerReward;
      miner.soloAccount.blocksFound++;
      miner.soloAccount.totalEarnings += minerReward;
      miner.blocksFound++;
      
      this.stats.soloBlocks++;
      
      logger.info(`Solo block found by ${miner.id}! Reward: ${minerReward} (fee: ${fee})`);
      
      this.emit('solo:block:found', {
        minerId: miner.id,
        blockHash: share.hash,
        reward: minerReward,
        fee: fee,
        height: share.height
      });
      
      // Immediate payout for solo blocks
      await this.processSoloPayout(miner);
    }
    
    return {
      accepted: true,
      mode: 'solo',
      reward: miner.soloAccount.pendingReward
    };
  }
  
  /**
   * Handle pool mining share
   */
  async handlePoolShare(miner, share) {
    // Standard pool share handling
    miner.earnings += share.value;
    
    return {
      accepted: true,
      mode: 'pool',
      shares: miner.shares,
      earnings: miner.earnings
    };
  }
  
  /**
   * Process solo payout
   */
  async processSoloPayout(miner) {
    if (miner.soloAccount.pendingReward <= 0) {
      return;
    }
    
    const payout = {
      address: miner.soloAccount.address,
      amount: miner.soloAccount.pendingReward,
      type: 'solo',
      timestamp: Date.now()
    };
    
    // Reset pending reward
    miner.soloAccount.pendingReward = 0;
    
    this.emit('payout:processed', payout);
    
    logger.info(`Solo payout processed: ${payout.amount} to ${payout.address}`);
    
    return payout;
  }
  
  /**
   * Get miner statistics
   */
  getMinerStats(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) {
      return null;
    }
    
    return {
      id: miner.id,
      address: miner.address,
      mode: miner.mode,
      hashrate: miner.hashrate,
      shares: miner.shares,
      blocksFound: miner.blocksFound,
      earnings: miner.earnings,
      lastSeen: miner.lastSeen,
      soloStats: miner.soloAccount ? {
        blocksFound: miner.soloAccount.blocksFound,
        totalEarnings: miner.soloAccount.totalEarnings,
        pendingReward: miner.soloAccount.pendingReward
      } : null
    };
  }
  
  /**
   * Get pool statistics
   */
  getPoolStats() {
    return {
      ...this.stats,
      fees: {
        solo: `${this.config.soloFee * 100}%`,
        pool: `${this.config.poolFee * 100}%`
      },
      modeSwitching: this.config.allowModeSwitching ? 'enabled' : 'disabled'
    };
  }
  
  /**
   * Update hashrate statistics
   */
  updateHashrates() {
    let soloHashrate = 0;
    let poolHashrate = 0;
    
    for (const miner of this.soloMiners.values()) {
      soloHashrate += miner.hashrate;
    }
    
    for (const miner of this.poolMiners.values()) {
      poolHashrate += miner.hashrate;
    }
    
    this.stats.soloHashrate = soloHashrate;
    this.stats.poolHashrate = poolHashrate;
  }
  
  /**
   * Clean up inactive miners
   */
  cleanupInactiveMiners(timeout = 600000) { // 10 minutes
    const now = Date.now();
    const toRemove = [];
    
    for (const [id, miner] of this.miners) {
      if (now - miner.lastSeen > timeout) {
        toRemove.push(id);
      }
    }
    
    for (const id of toRemove) {
      this.miners.delete(id);
      logger.info(`Removed inactive miner: ${id}`);
    }
    
    if (toRemove.length > 0) {
      this.updateMinerLists();
    }
  }
}

export default SoloPoolIntegration;