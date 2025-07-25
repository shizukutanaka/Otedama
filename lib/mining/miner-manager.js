/**
 * Miner Manager - Otedama
 * Manages connected miners and their statistics
 * 
 * Features:
 * - Miner registration and tracking
 * - Real-time hashrate calculation
 * - Share statistics
 * - Ban management
 * - Performance monitoring
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import { LRUCache } from '../core/performance.js';

const logger = createLogger('MinerManager');

/**
 * Miner Manager
 */
export class MinerManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxConnections = options.maxConnections || 10000;
    this.enableBanManagement = options.enableBanManagement !== false;
    this.shareWindow = options.shareWindow || 600000; // 10 minutes for hashrate calculation
    this.inactiveTimeout = options.inactiveTimeout || 900000; // 15 minutes
    
    // Miner tracking
    this.miners = new Map(); // minerId -> miner data
    this.minersByAddress = new Map(); // address -> Set of minerIds
    this.connections = new Map(); // connectionId -> miner reference
    
    // Statistics
    this.recentShares = new LRUCache(100000); // For hashrate calculation
    this.bannedAddresses = new Set();
    
    // Storage reference
    this.storage = null;
    
    // Cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000); // Every minute
  }
  
  /**
   * Initialize miner manager
   */
  async initialize(storage) {
    this.storage = storage;
    
    // Load existing miners from storage
    await this.loadMinersFromStorage();
    
    logger.info('Miner manager initialized');
  }
  
  /**
   * Load miners from storage
   */
  async loadMinersFromStorage() {
    try {
      const miners = await this.storage.db.prepare(
        'SELECT * FROM miners WHERE last_share_time > ?'
      ).all(Math.floor((Date.now() - this.inactiveTimeout) / 1000));
      
      for (const minerData of miners) {
        const miner = {
          id: minerData.id,
          address: minerData.address,
          worker: minerData.worker,
          ip: minerData.ip,
          connectedAt: Date.now(),
          lastShareTime: minerData.last_share_time * 1000,
          shares: {
            submitted: minerData.shares_submitted,
            valid: minerData.shares_valid,
            invalid: minerData.shares_invalid
          },
          totalDifficulty: minerData.total_difficulty,
          hashrate: 0
        };
        
        this.miners.set(miner.id, miner);
        
        // Update address mapping
        if (!this.minersByAddress.has(miner.address)) {
          this.minersByAddress.set(miner.address, new Set());
        }
        this.minersByAddress.get(miner.address).add(miner.id);
      }
      
      logger.info(`Loaded ${miners.length} miners from storage`);
      
    } catch (error) {
      logger.error('Failed to load miners from storage:', error);
    }
  }
  
  /**
   * Register new miner
   */
  async registerMiner(minerInfo) {
    const { id, address, worker, ip } = minerInfo;
    
    // Check if banned
    if (this.enableBanManagement && this.bannedAddresses.has(address)) {
      throw new Error('Address is banned');
    }
    
    // Check connection limit
    if (this.miners.size >= this.maxConnections) {
      throw new Error('Connection limit reached');
    }
    
    // Create miner object
    const miner = {
      id,
      address,
      worker: worker || 'default',
      ip,
      connectedAt: Date.now(),
      lastShareTime: Date.now(),
      shares: {
        submitted: 0,
        valid: 0,
        invalid: 0
      },
      totalDifficulty: 0,
      hashrate: 0
    };
    
    // Add to storage
    await this.storage.execute(() => {
      this.storage.statements.insertMiner.run(id, address, worker, ip);
    });
    
    // Add to memory
    this.miners.set(id, miner);
    this.connections.set(id, miner);
    
    // Update address mapping
    if (!this.minersByAddress.has(address)) {
      this.minersByAddress.set(address, new Set());
    }
    this.minersByAddress.get(address).add(id);
    
    logger.info(`Registered miner: ${address}.${worker} (${id})`);
    this.emit('miner:registered', miner);
    
    return miner;
  }
  
  /**
   * Disconnect miner
   */
  disconnectMiner(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    // Remove from connections
    this.connections.delete(minerId);
    
    // Keep in miners map for statistics
    miner.disconnectedAt = Date.now();
    
    logger.info(`Miner disconnected: ${miner.address}.${miner.worker} (${minerId})`);
    this.emit('miner:disconnected', miner);
  }
  
  /**
   * Record share submission
   */
  async recordShare(minerId, shareInfo) {
    const miner = this.miners.get(minerId);
    if (!miner) {
      throw new Error('Miner not found');
    }
    
    const { difficulty, actualDifficulty, isValid, isBlock, reason } = shareInfo;
    
    // Update miner statistics
    miner.shares.submitted++;
    miner.lastShareTime = Date.now();
    
    if (isValid) {
      miner.shares.valid++;
      miner.totalDifficulty += difficulty;
    } else {
      miner.shares.invalid++;
      
      // Check for ban conditions
      if (this.enableBanManagement) {
        const invalidRate = miner.shares.invalid / miner.shares.submitted;
        if (miner.shares.submitted > 100 && invalidRate > 0.5) {
          this.banAddress(miner.address, 'High invalid share rate');
        }
      }
    }
    
    // Update storage
    await this.storage.execute(() => {
      this.storage.statements.updateMinerStats.run(
        1, // shares_submitted increment
        isValid ? 1 : 0, // shares_valid increment
        isValid ? 0 : 1, // shares_invalid increment
        isValid ? difficulty : 0, // total_difficulty increment
        Math.floor(Date.now() / 1000), // last_share_time
        minerId
      );
    });
    
    // Record share for hashrate calculation
    const shareKey = `${minerId}:${Date.now()}`;
    this.recentShares.set(shareKey, {
      minerId,
      difficulty,
      timestamp: Date.now()
    });
    
    // Update hashrate
    this.updateMinerHashrate(minerId);
    
    this.emit('share:recorded', {
      minerId,
      isValid,
      difficulty,
      actualDifficulty
    });
  }
  
  /**
   * Update miner hashrate
   */
  updateMinerHashrate(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    const now = Date.now();
    const windowStart = now - this.shareWindow;
    let totalDifficulty = 0;
    let shareCount = 0;
    
    // Calculate hashrate from recent shares
    for (const [key, share] of this.recentShares.cache) {
      if (share.minerId === minerId && share.timestamp > windowStart) {
        totalDifficulty += share.difficulty;
        shareCount++;
      }
    }
    
    // Calculate hashrate (difficulty * 2^32 / time)
    const timeSeconds = this.shareWindow / 1000;
    miner.hashrate = (totalDifficulty * Math.pow(2, 32)) / timeSeconds;
    
    // Calculate shares per minute
    miner.sharesPerMinute = (shareCount / this.shareWindow) * 60000;
  }
  
  /**
   * Get miner by ID
   */
  getMiner(minerId) {
    return this.miners.get(minerId);
  }
  
  /**
   * Get connected miners
   */
  getConnectedMiners() {
    return Array.from(this.connections.values());
  }
  
  /**
   * Get miners by address
   */
  getMinersByAddress(address) {
    const minerIds = this.minersByAddress.get(address) || new Set();
    return Array.from(minerIds).map(id => this.miners.get(id)).filter(Boolean);
  }
  
  /**
   * Get miner statistics
   */
  getMinerStats(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return null;
    
    const uptime = Date.now() - miner.connectedAt;
    const validShareRate = miner.shares.valid / miner.shares.submitted * 100 || 0;
    
    return {
      ...miner,
      uptime,
      validShareRate,
      sharesPerMinute: miner.sharesPerMinute || 0,
      estimatedDailyEarnings: this.calculateEstimatedEarnings(miner)
    };
  }
  
  /**
   * Get pool statistics
   */
  getPoolStats() {
    let connectedMiners = 0;
    let totalWorkers = 0;
    let totalHashrate = 0;
    let totalShares = 0;
    let totalBlocks = 0;
    let activeMiners = 0;
    
    const activeThreshold = Date.now() - 300000; // 5 minutes
    
    for (const miner of this.miners.values()) {
      if (this.connections.has(miner.id)) {
        connectedMiners++;
      }
      
      totalWorkers++;
      totalHashrate += miner.hashrate || 0;
      totalShares += miner.shares.valid;
      
      if (miner.lastShareTime > activeThreshold) {
        activeMiners++;
      }
    }
    
    // Get blocks from storage
    const blockCount = this.storage?.db.prepare(
      'SELECT COUNT(*) as count FROM blocks WHERE is_orphan = 0'
    ).get()?.count || 0;
    
    return {
      connectedMiners,
      totalWorkers,
      activeMiners,
      totalHashrate,
      averageHashrate: connectedMiners > 0 ? totalHashrate / connectedMiners : 0,
      totalShares,
      totalBlocks: blockCount
    };
  }
  
  /**
   * Calculate estimated earnings
   */
  calculateEstimatedEarnings(miner) {
    // This is a simplified calculation
    // Real implementation would consider:
    // - Network difficulty
    // - Block reward
    // - Pool fee
    // - Payment scheme
    
    const poolHashrate = this.getPoolStats().totalHashrate;
    if (poolHashrate === 0) return 0;
    
    const minerShare = miner.hashrate / poolHashrate;
    const blocksPerDay = 144; // For Bitcoin
    const blockReward = 6.25; // Current Bitcoin reward
    const poolFee = 0.01; // 1% pool fee
    
    const dailyEarnings = minerShare * blocksPerDay * blockReward * (1 - poolFee);
    
    return dailyEarnings;
  }
  
  /**
   * Ban address
   */
  banAddress(address, reason) {
    this.bannedAddresses.add(address);
    
    // Disconnect all miners with this address
    const miners = this.getMinersByAddress(address);
    for (const miner of miners) {
      if (this.connections.has(miner.id)) {
        this.disconnectMiner(miner.id);
      }
    }
    
    logger.warn(`Banned address ${address}: ${reason}`);
    this.emit('address:banned', { address, reason });
  }
  
  /**
   * Unban address
   */
  unbanAddress(address) {
    this.bannedAddresses.delete(address);
    logger.info(`Unbanned address ${address}`);
    this.emit('address:unbanned', { address });
  }
  
  /**
   * Is address banned
   */
  isAddressBanned(address) {
    return this.bannedAddresses.has(address);
  }
  
  /**
   * Cleanup inactive miners
   */
  cleanup() {
    const now = Date.now();
    const inactiveThreshold = now - this.inactiveTimeout;
    let cleanedCount = 0;
    
    for (const [minerId, miner] of this.miners) {
      // Skip connected miners
      if (this.connections.has(minerId)) continue;
      
      // Remove inactive miners
      if (miner.lastShareTime < inactiveThreshold) {
        this.miners.delete(minerId);
        
        // Update address mapping
        const minerSet = this.minersByAddress.get(miner.address);
        if (minerSet) {
          minerSet.delete(minerId);
          if (minerSet.size === 0) {
            this.minersByAddress.delete(miner.address);
          }
        }
        
        cleanedCount++;
      }
    }
    
    // Clean old shares from cache
    const shareWindowStart = now - this.shareWindow * 2;
    for (const [key, share] of this.recentShares.cache) {
      if (share.timestamp < shareWindowStart) {
        this.recentShares.delete(key);
      }
    }
    
    if (cleanedCount > 0) {
      logger.debug(`Cleaned up ${cleanedCount} inactive miners`);
    }
  }
  
  /**
   * Get top miners
   */
  getTopMiners(limit = 10) {
    const miners = Array.from(this.miners.values())
      .filter(miner => this.connections.has(miner.id))
      .sort((a, b) => b.hashrate - a.hashrate)
      .slice(0, limit);
    
    return miners.map(miner => ({
      address: miner.address,
      worker: miner.worker,
      hashrate: miner.hashrate,
      shares: miner.shares,
      validShareRate: miner.shares.valid / miner.shares.submitted * 100 || 0
    }));
  }
  
  /**
   * Shutdown miner manager
   */
  async shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    logger.info('Miner manager shutdown');
  }
}

export default MinerManager;
