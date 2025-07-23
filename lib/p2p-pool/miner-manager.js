const EventEmitter = require('events');
const crypto = require('crypto');
const { BigNumber } = require('bignumber.js');

class MinerManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Miner settings
      maxMinersPerIP: options.maxMinersPerIP || 10,
      maxWorkersPerMiner: options.maxWorkersPerMiner || 100,
      workerTimeout: options.workerTimeout || 600000, // 10 minutes
      
      // Difficulty adjustment
      startDifficulty: options.startDifficulty || 1000,
      minDifficulty: options.minDifficulty || 100,
      maxDifficulty: options.maxDifficulty || 1000000,
      retargetInterval: options.retargetInterval || 60000, // 1 minute
      targetShareTime: options.targetShareTime || 10, // seconds
      
      // Performance tracking
      hashrateWindow: options.hashrateWindow || 600000, // 10 minutes
      performanceCheckInterval: options.performanceCheckInterval || 30000, // 30 seconds
      
      // Security
      banDuration: options.banDuration || 3600000, // 1 hour
      maxInvalidShareRatio: options.maxInvalidShareRatio || 0.5,
      suspiciousBehaviorThreshold: options.suspiciousBehaviorThreshold || 10
    };
    
    // Miner tracking
    this.miners = new Map();
    this.minersByIP = new Map();
    this.bannedIPs = new Map();
    this.bannedAddresses = new Map();
    
    // Performance metrics
    this.performanceHistory = new Map();
    this.difficultyAdjustments = new Map();
    
    // Start monitoring
    this.startMonitoring();
  }
  
  registerMiner(minerData) {
    const { id, address, ip, worker = 'default', userAgent } = minerData;
    
    // Security checks
    if (this.isBanned(ip, address)) {
      throw new Error('Banned miner');
    }
    
    if (!this.checkIPLimit(ip)) {
      throw new Error('Too many miners from this IP');
    }
    
    // Create miner object
    const miner = {
      id,
      address,
      ip,
      workers: new Map(),
      stats: {
        connected: Date.now(),
        lastSeen: Date.now(),
        shares: {
          valid: 0,
          invalid: 0,
          stale: 0
        },
        blocks: 0,
        hashrate: 0,
        averageHashrate: 0,
        difficulty: this.config.startDifficulty
      },
      performance: {
        sharesPerMinute: 0,
        efficiency: 100,
        uptime: 0,
        variance: 0
      },
      security: {
        suspiciousActions: 0,
        lastWarning: null
      }
    };
    
    // Register worker
    this.registerWorker(miner, worker, { userAgent });
    
    // Add to tracking
    this.miners.set(id, miner);
    this.addToIPTracking(ip, id);
    
    // Initialize performance tracking
    this.performanceHistory.set(id, []);
    this.difficultyAdjustments.set(id, {
      lastAdjustment: Date.now(),
      history: []
    });
    
    this.emit('minerRegistered', {
      id,
      address,
      worker,
      ip: this.hashIP(ip)
    });
    
    return miner;
  }
  
  unregisterMiner(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    // Update stats
    miner.stats.lastSeen = Date.now();
    const uptime = miner.stats.lastSeen - miner.stats.connected;
    
    // Remove from tracking
    this.miners.delete(minerId);
    this.removeFromIPTracking(miner.ip, minerId);
    this.performanceHistory.delete(minerId);
    this.difficultyAdjustments.delete(minerId);
    
    this.emit('minerUnregistered', {
      id: minerId,
      address: miner.address,
      uptime,
      totalShares: miner.stats.shares.valid + miner.stats.shares.invalid
    });
  }
  
  registerWorker(miner, workerName, workerData = {}) {
    if (miner.workers.size >= this.config.maxWorkersPerMiner) {
      throw new Error('Too many workers');
    }
    
    const worker = {
      name: workerName,
      connected: Date.now(),
      lastShare: null,
      shares: { valid: 0, invalid: 0 },
      hashrate: 0,
      difficulty: miner.stats.difficulty,
      ...workerData
    };
    
    miner.workers.set(workerName, worker);
    
    this.emit('workerConnected', {
      minerId: miner.id,
      workerName
    });
  }
  
  unregisterWorker(minerId, workerName) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    const worker = miner.workers.get(workerName);
    if (!worker) return;
    
    miner.workers.delete(workerName);
    
    this.emit('workerDisconnected', {
      minerId,
      workerName,
      uptime: Date.now() - worker.connected
    });
  }
  
  // Share processing
  
  recordShare(minerId, shareData) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    const { workerName = 'default', difficulty, isValid, reason } = shareData;
    const worker = miner.workers.get(workerName);
    if (!worker) return;
    
    // Update timestamps
    miner.stats.lastSeen = Date.now();
    worker.lastShare = Date.now();
    
    // Record share
    if (isValid) {
      miner.stats.shares.valid++;
      worker.shares.valid++;
      
      // Add to performance history
      this.addPerformancePoint(minerId, {
        timestamp: Date.now(),
        difficulty,
        valid: true
      });
    } else {
      if (reason === 'stale') {
        miner.stats.shares.stale++;
      } else {
        miner.stats.shares.invalid++;
        worker.shares.invalid++;
        
        // Check for suspicious behavior
        this.checkSuspiciousBehavior(miner);
      }
    }
    
    // Update hashrate
    this.updateHashrate(miner, worker);
    
    // Check if difficulty adjustment needed
    this.checkDifficultyAdjustment(miner);
  }
  
  recordBlock(minerId, blockData) {
    const miner = this.miners.get(minerId);
    if (!miner) return;
    
    miner.stats.blocks++;
    
    this.emit('blockFound', {
      minerId,
      address: miner.address,
      blockHeight: blockData.height,
      reward: blockData.reward
    });
  }
  
  // Hashrate calculation
  
  updateHashrate(miner, worker) {
    const window = this.config.hashrateWindow;
    const now = Date.now();
    
    // Get recent shares
    const minerHistory = this.performanceHistory.get(miner.id) || [];
    const recentShares = minerHistory.filter(point => 
      point.timestamp > now - window && point.valid
    );
    
    if (recentShares.length === 0) {
      miner.stats.hashrate = 0;
      worker.hashrate = 0;
      return;
    }
    
    // Calculate hashrate
    const totalDifficulty = recentShares.reduce((sum, share) => 
      sum + share.difficulty, 0
    );
    const timeSpan = (now - recentShares[0].timestamp) / 1000;
    const hashrate = (totalDifficulty * Math.pow(2, 32)) / timeSpan;
    
    // Update miner hashrate
    miner.stats.hashrate = hashrate;
    
    // Calculate worker contribution
    const workerShares = recentShares.filter(share => 
      share.worker === worker.name
    ).length;
    const workerRatio = workerShares / recentShares.length;
    worker.hashrate = hashrate * workerRatio;
    
    // Update average hashrate
    const allHistory = this.performanceHistory.get(miner.id);
    if (allHistory.length > 10) {
      const avgWindow = Math.min(3600000, now - miner.stats.connected); // 1 hour or since connected
      const avgShares = allHistory.filter(point => 
        point.timestamp > now - avgWindow && point.valid
      );
      
      if (avgShares.length > 0) {
        const avgDifficulty = avgShares.reduce((sum, share) => 
          sum + share.difficulty, 0
        );
        const avgTimeSpan = avgWindow / 1000;
        miner.stats.averageHashrate = (avgDifficulty * Math.pow(2, 32)) / avgTimeSpan;
      }
    }
  }
  
  // Difficulty adjustment
  
  checkDifficultyAdjustment(miner) {
    const adjData = this.difficultyAdjustments.get(miner.id);
    if (!adjData) return;
    
    const now = Date.now();
    const timeSinceLastAdj = now - adjData.lastAdjustment;
    
    if (timeSinceLastAdj < this.config.retargetInterval) return;
    
    // Get shares since last adjustment
    const recentShares = this.performanceHistory.get(miner.id)
      .filter(point => point.timestamp > adjData.lastAdjustment);
    
    if (recentShares.length < 5) return; // Need minimum shares
    
    // Calculate actual share rate
    const validShares = recentShares.filter(s => s.valid).length;
    const shareRate = validShares / (timeSinceLastAdj / 1000); // shares per second
    const targetRate = 1 / this.config.targetShareTime;
    
    // Calculate adjustment factor
    let adjustmentFactor = targetRate / shareRate;
    
    // Limit adjustment range
    adjustmentFactor = Math.max(0.5, Math.min(2.0, adjustmentFactor));
    
    // Calculate new difficulty
    let newDifficulty = Math.floor(miner.stats.difficulty * adjustmentFactor);
    newDifficulty = Math.max(this.config.minDifficulty, 
      Math.min(this.config.maxDifficulty, newDifficulty));
    
    // Apply adjustment if significant
    if (Math.abs(newDifficulty - miner.stats.difficulty) > miner.stats.difficulty * 0.1) {
      this.adjustDifficulty(miner, newDifficulty);
      
      adjData.lastAdjustment = now;
      adjData.history.push({
        timestamp: now,
        oldDifficulty: miner.stats.difficulty,
        newDifficulty,
        shareRate,
        factor: adjustmentFactor
      });
    }
  }
  
  adjustDifficulty(miner, newDifficulty) {
    const oldDifficulty = miner.stats.difficulty;
    miner.stats.difficulty = newDifficulty;
    
    // Update all workers
    for (const worker of miner.workers.values()) {
      worker.difficulty = newDifficulty;
    }
    
    this.emit('difficultyAdjusted', {
      minerId: miner.id,
      oldDifficulty,
      newDifficulty,
      factor: newDifficulty / oldDifficulty
    });
  }
  
  // Performance tracking
  
  addPerformancePoint(minerId, point) {
    const history = this.performanceHistory.get(minerId);
    if (!history) return;
    
    history.push(point);
    
    // Trim old entries
    const cutoff = Date.now() - this.config.hashrateWindow * 2;
    const trimmedHistory = history.filter(p => p.timestamp > cutoff);
    this.performanceHistory.set(minerId, trimmedHistory);
  }
  
  calculatePerformanceMetrics(miner) {
    const history = this.performanceHistory.get(miner.id) || [];
    const now = Date.now();
    const window = 300000; // 5 minutes
    
    const recentPoints = history.filter(p => p.timestamp > now - window);
    if (recentPoints.length === 0) return;
    
    // Shares per minute
    const validShares = recentPoints.filter(p => p.valid).length;
    miner.performance.sharesPerMinute = (validShares / window) * 60000;
    
    // Efficiency
    const totalShares = recentPoints.length;
    miner.performance.efficiency = totalShares > 0 ? 
      (validShares / totalShares) * 100 : 100;
    
    // Uptime
    miner.performance.uptime = ((now - miner.stats.connected) / 3600000).toFixed(2); // hours
    
    // Variance (consistency of share submission)
    if (validShares > 1) {
      const intervals = [];
      for (let i = 1; i < recentPoints.length; i++) {
        if (recentPoints[i].valid && recentPoints[i-1].valid) {
          intervals.push(recentPoints[i].timestamp - recentPoints[i-1].timestamp);
        }
      }
      
      if (intervals.length > 0) {
        const avgInterval = intervals.reduce((a, b) => a + b) / intervals.length;
        const variance = intervals.reduce((sum, interval) => 
          sum + Math.pow(interval - avgInterval, 2), 0) / intervals.length;
        miner.performance.variance = Math.sqrt(variance) / avgInterval;
      }
    }
  }
  
  // Security and ban management
  
  checkSuspiciousBehavior(miner) {
    const totalShares = miner.stats.shares.valid + miner.stats.shares.invalid;
    const invalidRatio = totalShares > 0 ? 
      miner.stats.shares.invalid / totalShares : 0;
    
    if (invalidRatio > this.config.maxInvalidShareRatio) {
      miner.security.suspiciousActions++;
      
      if (miner.security.suspiciousActions >= this.config.suspiciousBehaviorThreshold) {
        this.banMiner(miner, 'Too many invalid shares');
      } else {
        miner.security.lastWarning = Date.now();
        this.emit('suspiciousBehavior', {
          minerId: miner.id,
          reason: 'High invalid share ratio',
          ratio: invalidRatio
        });
      }
    }
  }
  
  banMiner(miner, reason) {
    const banExpiry = Date.now() + this.config.banDuration;
    
    // Ban IP
    this.bannedIPs.set(miner.ip, {
      reason,
      expiry: banExpiry
    });
    
    // Ban address
    this.bannedAddresses.set(miner.address, {
      reason,
      expiry: banExpiry
    });
    
    // Remove miner
    this.unregisterMiner(miner.id);
    
    this.emit('minerBanned', {
      minerId: miner.id,
      address: miner.address,
      ip: this.hashIP(miner.ip),
      reason,
      duration: this.config.banDuration
    });
  }
  
  isBanned(ip, address) {
    // Check IP ban
    const ipBan = this.bannedIPs.get(ip);
    if (ipBan && ipBan.expiry > Date.now()) {
      return true;
    } else if (ipBan) {
      this.bannedIPs.delete(ip);
    }
    
    // Check address ban
    const addressBan = this.bannedAddresses.get(address);
    if (addressBan && addressBan.expiry > Date.now()) {
      return true;
    } else if (addressBan) {
      this.bannedAddresses.delete(address);
    }
    
    return false;
  }
  
  // IP management
  
  checkIPLimit(ip) {
    const minersFromIP = this.minersByIP.get(ip) || [];
    return minersFromIP.length < this.config.maxMinersPerIP;
  }
  
  addToIPTracking(ip, minerId) {
    const miners = this.minersByIP.get(ip) || [];
    miners.push(minerId);
    this.minersByIP.set(ip, miners);
  }
  
  removeFromIPTracking(ip, minerId) {
    const miners = this.minersByIP.get(ip);
    if (!miners) return;
    
    const index = miners.indexOf(minerId);
    if (index !== -1) {
      miners.splice(index, 1);
    }
    
    if (miners.length === 0) {
      this.minersByIP.delete(ip);
    }
  }
  
  hashIP(ip) {
    // Hash IP for privacy in logs
    return crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
  }
  
  // Monitoring
  
  startMonitoring() {
    // Performance check
    setInterval(() => {
      for (const miner of this.miners.values()) {
        this.calculatePerformanceMetrics(miner);
        this.checkWorkerTimeout(miner);
      }
    }, this.config.performanceCheckInterval);
    
    // Cleanup old data
    setInterval(() => {
      this.cleanupOldData();
    }, 3600000); // Every hour
  }
  
  checkWorkerTimeout(miner) {
    const now = Date.now();
    const timeout = this.config.workerTimeout;
    
    for (const [workerName, worker] of miner.workers) {
      if (worker.lastShare && now - worker.lastShare > timeout) {
        this.unregisterWorker(miner.id, workerName);
      }
    }
  }
  
  cleanupOldData() {
    const now = Date.now();
    
    // Clean expired bans
    for (const [ip, ban] of this.bannedIPs) {
      if (ban.expiry < now) {
        this.bannedIPs.delete(ip);
      }
    }
    
    for (const [address, ban] of this.bannedAddresses) {
      if (ban.expiry < now) {
        this.bannedAddresses.delete(address);
      }
    }
  }
  
  // Public API
  
  getMiner(minerId) {
    return this.miners.get(minerId);
  }
  
  getMinerByAddress(address) {
    for (const miner of this.miners.values()) {
      if (miner.address === address) {
        return miner;
      }
    }
    return null;
  }
  
  getAllMiners() {
    return Array.from(this.miners.values());
  }
  
  getMinerStats(minerId) {
    const miner = this.miners.get(minerId);
    if (!miner) return null;
    
    return {
      ...miner.stats,
      ...miner.performance,
      workers: Array.from(miner.workers.entries()).map(([name, worker]) => ({
        name,
        hashrate: worker.hashrate,
        shares: worker.shares,
        lastShare: worker.lastShare,
        difficulty: worker.difficulty
      }))
    };
  }
  
  getPoolStats() {
    const miners = Array.from(this.miners.values());
    
    return {
      connectedMiners: miners.length,
      totalWorkers: miners.reduce((sum, m) => sum + m.workers.size, 0),
      totalHashrate: miners.reduce((sum, m) => sum + m.stats.hashrate, 0),
      totalShares: miners.reduce((sum, m) => 
        sum + m.stats.shares.valid + m.stats.shares.invalid, 0),
      totalBlocks: miners.reduce((sum, m) => sum + m.stats.blocks, 0),
      averageEfficiency: miners.length > 0 ?
        miners.reduce((sum, m) => sum + m.performance.efficiency, 0) / miners.length : 0,
      bannedIPs: this.bannedIPs.size,
      bannedAddresses: this.bannedAddresses.size
    };
  }
  
  setMinerDifficulty(minerId, difficulty) {
    const miner = this.miners.get(minerId);
    if (!miner) return false;
    
    this.adjustDifficulty(miner, difficulty);
    return true;
  }
}

module.exports = MinerManager;