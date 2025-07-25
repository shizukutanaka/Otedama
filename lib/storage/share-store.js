/**
 * Share Store - Otedama
 * Specialized storage for mining shares
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('ShareStore');

export class ShareStore extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxShares = options.maxShares || 100000;
    this.windowSize = options.windowSize || 3600000; // 1 hour
    
    this.shares = [];
    this.sharesByWorker = new Map();
    this.stats = {
      totalShares: 0,
      validShares: 0,
      invalidShares: 0,
      blocksFound: 0
    };
  }
  
  add(share) {
    const now = Date.now();
    
    // Add timestamp if not present
    share.timestamp = share.timestamp || now;
    
    // Add to main array
    this.shares.push(share);
    
    // Add to worker map
    if (!this.sharesByWorker.has(share.workerId)) {
      this.sharesByWorker.set(share.workerId, []);
    }
    this.sharesByWorker.get(share.workerId).push(share);
    
    // Update stats
    this.stats.totalShares++;
    if (share.isValid) {
      this.stats.validShares++;
    } else {
      this.stats.invalidShares++;
    }
    
    if (share.isBlock) {
      this.stats.blocksFound++;
      this.emit('block:found', share);
    }
    
    // Cleanup old shares if needed
    if (this.shares.length > this.maxShares) {
      this.cleanup();
    }
    
    this.emit('share:added', share);
  }
  
  getShares(workerId, since) {
    const workerShares = this.sharesByWorker.get(workerId) || [];
    
    if (!since) {
      return workerShares;
    }
    
    return workerShares.filter(share => share.timestamp >= since);
  }
  
  getRecentShares(duration = this.windowSize) {
    const since = Date.now() - duration;
    return this.shares.filter(share => share.timestamp >= since);
  }
  
  getWorkerStats(workerId) {
    const shares = this.sharesByWorker.get(workerId) || [];
    const recentShares = shares.filter(share => 
      share.timestamp >= Date.now() - this.windowSize
    );
    
    const stats = {
      totalShares: shares.length,
      recentShares: recentShares.length,
      validShares: shares.filter(s => s.isValid).length,
      invalidShares: shares.filter(s => !s.isValid).length,
      blocks: shares.filter(s => s.isBlock).length,
      hashrate: this.calculateHashrate(recentShares),
      lastShare: shares.length > 0 ? shares[shares.length - 1].timestamp : null
    };
    
    return stats;
  }
  
  getPoolStats() {
    const recentShares = this.getRecentShares();
    
    return {
      ...this.stats,
      recentShares: recentShares.length,
      hashrate: this.calculateHashrate(recentShares),
      workers: this.sharesByWorker.size,
      shareRate: recentShares.length / (this.windowSize / 1000) // shares per second
    };
  }
  
  calculateHashrate(shares) {
    if (shares.length === 0) return 0;
    
    // Sort by timestamp
    shares.sort((a, b) => a.timestamp - b.timestamp);
    
    const timeSpan = shares[shares.length - 1].timestamp - shares[0].timestamp;
    if (timeSpan === 0) return 0;
    
    // Sum difficulties
    const totalDifficulty = shares.reduce((sum, share) => sum + share.difficulty, 0);
    
    // Hashrate = (difficulty * 2^32) / time_seconds
    return (totalDifficulty * Math.pow(2, 32)) / (timeSpan / 1000);
  }
  
  cleanup() {
    const cutoff = Date.now() - this.windowSize * 2; // Keep 2 windows
    
    // Remove old shares from main array
    this.shares = this.shares.filter(share => share.timestamp >= cutoff);
    
    // Remove old shares from worker maps
    for (const [workerId, shares] of this.sharesByWorker) {
      const filtered = shares.filter(share => share.timestamp >= cutoff);
      
      if (filtered.length === 0) {
        this.sharesByWorker.delete(workerId);
      } else {
        this.sharesByWorker.set(workerId, filtered);
      }
    }
    
    logger.debug(`Cleaned up shares older than ${new Date(cutoff).toISOString()}`);
  }
  
  clear() {
    this.shares = [];
    this.sharesByWorker.clear();
    this.stats = {
      totalShares: 0,
      validShares: 0,
      invalidShares: 0,
      blocksFound: 0
    };
    
    this.emit('cleared');
  }
  
  // PPLNS (Pay Per Last N Shares) calculation
  
  calculatePPLNS(blockReward, n = null) {
    const shares = n ? this.shares.slice(-n) : this.getRecentShares();
    
    if (shares.length === 0) {
      return new Map();
    }
    
    // Calculate total score
    const scores = new Map();
    let totalScore = 0;
    
    for (const share of shares) {
      if (!share.isValid) continue;
      
      const score = share.difficulty;
      const current = scores.get(share.workerId) || 0;
      scores.set(share.workerId, current + score);
      totalScore += score;
    }
    
    // Calculate rewards
    const rewards = new Map();
    
    for (const [workerId, score] of scores) {
      const reward = (score / totalScore) * blockReward;
      rewards.set(workerId, reward);
    }
    
    return rewards;
  }
}

export default ShareStore;
