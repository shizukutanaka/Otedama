/**
 * Smart Work Distribution System for P2P Mining Pool
 * Optimizes work assignment based on miner capabilities and network conditions
 */

import { EventEmitter } from 'events';
import { allocateRange } from '../mining/nonce-allocator.js';
import { encodeShare } from '../utils/share-encoder.js';
import { encodeGpuJob } from '../utils/gpu-job-encoder.js';
import { createHash } from 'crypto';
import { Logger } from '../logger.js';

// Miner hardware types
export const MinerType = {
  CPU: 'cpu',
  GPU: 'gpu',
  ASIC: 'asic',
  FPGA: 'fpga'
};

// Algorithm preferences by hardware type
const HARDWARE_ALGORITHM_PREFERENCE = {
  [MinerType.CPU]: ['randomx', 'cryptonight', 'lyra2rev3'],
  [MinerType.GPU]: ['ethash', 'kawpow', 'x16r', 'equihash'],
  [MinerType.ASIC]: ['sha256', 'scrypt', 'x11'],
  [MinerType.FPGA]: ['sha256', 'scrypt', 'ethash']
};

// Difficulty adjustment parameters
const DIFFICULTY_ADJUSTMENT = {
  TARGET_SHARE_TIME: 30000, // 30 seconds
  VARIANCE_THRESHOLD: 0.3,
  MIN_DIFFICULTY: 1,
  MAX_DIFFICULTY: 1000000,
  ADJUSTMENT_FACTOR: 1.5
};

export class SmartWorkDistributor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger('WorkDistributor');
    this.options = {
      profilingEnabled: options.profilingEnabled !== false,
      adaptiveDifficulty: options.adaptiveDifficulty !== false,
      loadBalancing: options.loadBalancing !== false,
      predictionWindow: options.predictionWindow || 300000, // 5 minutes
      ...options
    };
    
    // Miner profiles and statistics
    this.minerProfiles = new Map();
    this.workQueue = [];
    this.activeJobs = new Map();
    
    // Algorithm-specific job queues
    this.algorithmQueues = new Map();
    
    // Performance tracking
    this.performanceHistory = new Map();
    this.networkStats = {
      totalHashrate: 0,
      activeMiners: 0,
      sharesPerSecond: 0,
      averageLatency: 0
    };
    
    // Start background processes
    this.startPerformanceMonitoring();
    this.startDifficultyAdjustment();
    this.startLoadBalancing();
  }
  
  /**
   * Register miner with capabilities
   */
  registerMiner(minerId, minerInfo) {
    const profile = {
      id: minerId,
      type: minerInfo.type || MinerType.CPU,
      hashrates: minerInfo.hashrates || {}, // Algorithm -> hashrate mapping
      capabilities: minerInfo.capabilities || [],
      location: minerInfo.location,
      bandwidth: minerInfo.bandwidth || 1000,
      latency: minerInfo.latency || 100,
      powerConsumption: minerInfo.powerConsumption || 0,
      reliability: 1.0,
      efficiency: 1.0,
      workerIndex: this.minerProfiles.size,
      
      // Dynamic stats
      currentDifficulty: DIFFICULTY_ADJUSTMENT.MIN_DIFFICULTY,
      lastShareTime: Date.now(),
      avgShareTime: DIFFICULTY_ADJUSTMENT.TARGET_SHARE_TIME,
      shareHistory: [],
      currentAlgorithm: null,
      
      // Performance metrics
      totalShares: 0,
      acceptedShares: 0,
      rejectedShares: 0,
      staleShares: 0,
      
      // Resource utilization
      cpuUsage: 0,
      memoryUsage: 0,
      temperature: 0,
      
      registeredAt: Date.now(),
      lastSeen: Date.now()
    };
    
    this.minerProfiles.set(minerId, profile);
    this.performanceHistory.set(minerId, []);
    
    this.logger.info(`Registered miner: ${minerId} (${profile.type})`);
    this.emit('miner:registered', { minerId, profile });
    
    return profile;
  }
  
  /**
   * Assign optimal work to miner
   */
  async assignWork(minerId, preferences = {}) {
    const profile = this.minerProfiles.get(minerId);
    if (!profile) {
      throw new Error(`Miner profile not found: ${minerId}`);
    }
    
    profile.lastSeen = Date.now();
    
    // Find optimal algorithm for this miner
    const algorithm = this.selectOptimalAlgorithm(profile, preferences);
    
    // Calculate optimal difficulty
    const difficulty = this.calculateOptimalDifficulty(profile, algorithm);
    
    // Create job
    const job = this.createJob(algorithm, difficulty, profile);
    
    // Emit GPU job (binary)
    this.emit('job:assigned', minerId, encodeGpuJob(job));

    // Update miner profile
    profile.currentAlgorithm = algorithm;
    profile.currentDifficulty = difficulty;
    
    // Track active job
    this.activeJobs.set(job.id, {
      ...job,
      minerId,
      assignedAt: Date.now()
    });
    
    this.emit('work:assigned', {
      minerId,
      jobId: job.id,
      algorithm,
      difficulty
    });
    
    return job;
  }
  
  /**
   * Select optimal algorithm for miner
   */
  selectOptimalAlgorithm(profile, preferences) {
    // Get hardware-preferred algorithms
    const hardwarePreferred = HARDWARE_ALGORITHM_PREFERENCE[profile.type] || [];
    
    // Get algorithms with known hashrates
    const knownAlgorithms = Object.keys(profile.hashrates);
    
    // Get explicitly supported algorithms
    const supportedAlgorithms = profile.capabilities.length > 0 
      ? profile.capabilities 
      : hardwarePreferred;
    
    // Filter by preference
    let candidates = supportedAlgorithms;
    
    if (preferences.algorithm) {
      candidates = candidates.filter(algo => algo === preferences.algorithm);
    }
    
    if (preferences.profitability) {
      candidates = this.filterByProfitability(candidates, profile);
    }
    
    // Score algorithms
    const scoredAlgorithms = candidates.map(algorithm => ({
      algorithm,
      score: this.calculateAlgorithmScore(algorithm, profile)
    }));
    
    // Sort by score
    scoredAlgorithms.sort((a, b) => b.score - a.score);
    
    // Return best algorithm or default
    return scoredAlgorithms.length > 0 
      ? scoredAlgorithms[0].algorithm
      : hardwarePreferred[0] || 'sha256';
  }
  
  /**
   * Calculate algorithm score for miner
   */
  calculateAlgorithmScore(algorithm, profile) {
    let score = 0;
    
    // Hashrate factor (40% weight)
    const hashrate = profile.hashrates[algorithm] || 0;
    const normalizedHashrate = hashrate / (profile.hashrates.max || 1);
    score += normalizedHashrate * 0.4;
    
    // Hardware preference (20% weight)
    const hardwarePreferred = HARDWARE_ALGORITHM_PREFERENCE[profile.type] || [];
    const preferenceIndex = hardwarePreferred.indexOf(algorithm);
    if (preferenceIndex !== -1) {
      score += (1 - preferenceIndex / hardwarePreferred.length) * 0.2;
    }
    
    // Efficiency factor (20% weight)
    const efficiency = this.calculateAlgorithmEfficiency(algorithm, profile);
    score += efficiency * 0.2;
    
    // Network demand (10% weight)
    const networkDemand = this.getNetworkDemand(algorithm);
    score += networkDemand * 0.1;
    
    // Profitability (10% weight)
    const profitability = this.calculateProfitability(algorithm, profile);
    score += profitability * 0.1;
    
    return score;
  }
  
  /**
   * Calculate optimal difficulty for miner
   */
  calculateOptimalDifficulty(profile, algorithm) {
    const targetTime = DIFFICULTY_ADJUSTMENT.TARGET_SHARE_TIME;
    const variance = DIFFICULTY_ADJUSTMENT.VARIANCE_THRESHOLD;
    
    // Use historical data if available
    if (profile.shareHistory.length >= 5) {
      const recentShares = profile.shareHistory.slice(-10);
      const avgShareTime = recentShares.reduce((sum, share) => 
        sum + share.duration, 0) / recentShares.length;
      
      let newDifficulty = profile.currentDifficulty;
      
      if (avgShareTime < targetTime * (1 - variance)) {
        // Too fast - increase difficulty
        newDifficulty = Math.min(
          profile.currentDifficulty * DIFFICULTY_ADJUSTMENT.ADJUSTMENT_FACTOR,
          DIFFICULTY_ADJUSTMENT.MAX_DIFFICULTY
        );
      } else if (avgShareTime > targetTime * (1 + variance)) {
        // Too slow - decrease difficulty
        newDifficulty = Math.max(
          profile.currentDifficulty / DIFFICULTY_ADJUSTMENT.ADJUSTMENT_FACTOR,
          DIFFICULTY_ADJUSTMENT.MIN_DIFFICULTY
        );
      }
      
      return newDifficulty;
    }
    
    // Calculate initial difficulty based on hashrate
    const hashrate = profile.hashrates[algorithm] || 
                     this.estimateHashrate(profile, algorithm);
    
    if (hashrate > 0) {
      const sharesPerSecond = 1 / (targetTime / 1000);
      const hashesPerShare = hashrate / sharesPerSecond;
      const difficulty = hashesPerShare / Math.pow(2, 32);
      
      return Math.max(
        DIFFICULTY_ADJUSTMENT.MIN_DIFFICULTY,
        Math.min(DIFFICULTY_ADJUSTMENT.MAX_DIFFICULTY, difficulty)
      );
    }
    
    return DIFFICULTY_ADJUSTMENT.MIN_DIFFICULTY;
  }
  
  /**
   * Create mining job
   */
  createJob(algorithm, difficulty, profile) {
    const jobId = this.generateJobId();
    
    const workerCount = this.minerProfiles.size;
    const { start: nonceStart, end: nonceEnd } = allocateRange(profile.workerIndex, workerCount);

    const job = {
      id: jobId,
      algorithm,
      difficulty,
      target: this.difficultyToTarget(difficulty),
      prevHash: this.getCurrentBlockHash(algorithm),
      height: this.getCurrentBlockHeight(algorithm),
      timestamp: Date.now(),
      
      // Job-specific data
      merkleRoot: this.calculateMerkleRoot(algorithm),
      bits: this.calculateBits(difficulty),
      nonceStart,
       nonceEnd,
      
      // Optimization hints
      workSize: this.calculateWorkSize(algorithm, profile),
      batchSize: this.calculateBatchSize(algorithm, profile),
      
      // Metadata
      currency: this.getCurrencyForAlgorithm(algorithm),
      reward: this.calculateBlockReward(algorithm),
      fee: this.calculateFee(algorithm)
    };
    
    return job;
  }
  
  /**
   * Handle share submission
   */
  async handleShareSubmission(minerId, share) {
    const profile = this.minerProfiles.get(minerId);
    const job = this.activeJobs.get(share.jobId);
    
    if (!profile || !job) {
      return { valid: false, reason: 'Invalid submission' };
    }
    
    // Validate share
    const isValid = await this.validateShare(share, job);
    const submitTime = Date.now();
    const duration = submitTime - job.assignedAt;
    
    // Update statistics
    profile.totalShares++;
    profile.lastShareTime = submitTime;
    
    if (isValid) {
      profile.acceptedShares++;
      
      // Update share history
      profile.shareHistory.push({
        timestamp: submitTime,
        duration,
        difficulty: job.difficulty,
        algorithm: job.algorithm
      });
      
      // Keep only recent history
      if (profile.shareHistory.length > 100) {
        profile.shareHistory.shift();
      }
      
      // Update performance metrics
      this.updatePerformanceMetrics(profile, duration, job.difficulty);
      
    } else {
      profile.rejectedShares++;
      
      // Reduce reliability for invalid shares
      profile.reliability = Math.max(0.1, profile.reliability - 0.01);
    }
    
    // Calculate efficiency
    profile.efficiency = profile.totalShares > 0 
      ? profile.acceptedShares / profile.totalShares
      : 1.0;
    
    this.emit('share:submitted', minerId, encodeShare({
      minerId,
      jobId: share.jobId,
      valid: isValid,
      duration
    }));
    
    return {
      valid: isValid,
      difficulty: job.difficulty,
      target: job.target,
      algorithm: job.algorithm
    };
  }
  
  /**
   * Update performance metrics
   */
  updatePerformanceMetrics(profile, duration, difficulty) {
    const history = this.performanceHistory.get(profile.id);
    
    // Calculate actual hashrate
    const hashrate = difficulty * Math.pow(2, 32) / (duration / 1000);
    
    history.push({
      timestamp: Date.now(),
      hashrate,
      difficulty,
      duration,
      algorithm: profile.currentAlgorithm
    });
    
    // Keep only recent history
    if (history.length > 1000) {
      history.shift();
    }
    
    // Update average share time
    const recentHistory = history.slice(-10);
    profile.avgShareTime = recentHistory.reduce((sum, entry) => 
      sum + entry.duration, 0) / recentHistory.length;
    
    // Update algorithm-specific hashrate
    if (profile.currentAlgorithm) {
      const algoHistory = history.filter(h => h.algorithm === profile.currentAlgorithm);
      if (algoHistory.length > 0) {
        const avgHashrate = algoHistory.slice(-5).reduce((sum, h) => 
          sum + h.hashrate, 0) / Math.min(5, algoHistory.length);
        
        profile.hashrates[profile.currentAlgorithm] = avgHashrate;
      }
    }
  }
  
  /**
   * Get work distribution statistics
   */
  getDistributionStats() {
    const stats = {
      totalMiners: this.minerProfiles.size,
      activeMiners: 0,
      algorithmDistribution: {},
      hardwareDistribution: {},
      difficultyDistribution: {},
      avgEfficiency: 0,
      avgReliability: 0
    };
    
    let totalEfficiency = 0;
    let totalReliability = 0;
    
    for (const [minerId, profile] of this.minerProfiles) {
      // Check if miner is active
      const isActive = Date.now() - profile.lastSeen < 300000; // 5 minutes
      
      if (isActive) {
        stats.activeMiners++;
        
        // Algorithm distribution
        if (profile.currentAlgorithm) {
          stats.algorithmDistribution[profile.currentAlgorithm] = 
            (stats.algorithmDistribution[profile.currentAlgorithm] || 0) + 1;
        }
        
        // Hardware distribution
        stats.hardwareDistribution[profile.type] = 
          (stats.hardwareDistribution[profile.type] || 0) + 1;
        
        // Difficulty distribution
        const diffRange = this.getDifficultyRange(profile.currentDifficulty);
        stats.difficultyDistribution[diffRange] = 
          (stats.difficultyDistribution[diffRange] || 0) + 1;
        
        totalEfficiency += profile.efficiency;
        totalReliability += profile.reliability;
      }
    }
    
    if (stats.activeMiners > 0) {
      stats.avgEfficiency = totalEfficiency / stats.activeMiners;
      stats.avgReliability = totalReliability / stats.activeMiners;
    }
    
    return stats;
  }
  
  /**
   * Start performance monitoring
   */
  startPerformanceMonitoring() {
    setInterval(() => {
      // Update network statistics
      this.updateNetworkStats();
      
      // Check for underperforming miners
      this.checkMinerPerformance();
      
      // Rebalance work distribution
      if (this.options.loadBalancing) {
        this.rebalanceWorkDistribution();
      }
      
    }, 60000); // Every minute
  }
  
  /**
   * Start difficulty adjustment
   */
  startDifficultyAdjustment() {
    setInterval(() => {
      for (const [minerId, profile] of this.minerProfiles) {
        const isActive = Date.now() - profile.lastSeen < 300000;
        
        if (isActive && profile.shareHistory.length >= 5) {
          const timeSinceLastShare = Date.now() - profile.lastShareTime;
          const targetTime = DIFFICULTY_ADJUSTMENT.TARGET_SHARE_TIME;
          
          // Adjust difficulty if needed
          if (timeSinceLastShare > targetTime * 2) {
            // No shares for too long - decrease difficulty
            profile.currentDifficulty = Math.max(
              profile.currentDifficulty * 0.8,
              DIFFICULTY_ADJUSTMENT.MIN_DIFFICULTY
            );
            
            this.emit('difficulty:adjusted', {
              minerId,
              newDifficulty: profile.currentDifficulty,
              reason: 'timeout'
            });
          }
        }
      }
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Start load balancing
   */
  startLoadBalancing() {
    setInterval(() => {
      if (!this.options.loadBalancing) return;
      
      // Analyze algorithm distribution
      const algoStats = this.getAlgorithmStats();
      
      // Identify overloaded algorithms
      const overloaded = Object.entries(algoStats)
        .filter(([algo, stats]) => stats.utilization > 0.9)
        .map(([algo]) => algo);
      
      // Identify underloaded algorithms
      const underloaded = Object.entries(algoStats)
        .filter(([algo, stats]) => stats.utilization < 0.5)
        .map(([algo]) => algo);
      
      // Rebalance if needed
      if (overloaded.length > 0 && underloaded.length > 0) {
        this.rebalanceAlgorithms(overloaded, underloaded);
      }
      
    }, 120000); // Every 2 minutes
  }
  
  /**
   * Helper methods
   */
  
  estimateHashrate(profile, algorithm) {
    // Rough estimation based on hardware type
    const baseHashrates = {
      [MinerType.CPU]: { randomx: 1000, cryptonight: 500 },
      [MinerType.GPU]: { ethash: 30000000, kawpow: 20000000 },
      [MinerType.ASIC]: { sha256: 50000000000000, scrypt: 500000000 }
    };
    
    return baseHashrates[profile.type]?.[algorithm] || 1000;
  }
  
  generateJobId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
  
  difficultyToTarget(difficulty) {
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    return target.toString(16).padStart(64, '0');
  }
  
  getDifficultyRange(difficulty) {
    if (difficulty < 10) return '1-10';
    if (difficulty < 100) return '10-100';
    if (difficulty < 1000) return '100-1K';
    if (difficulty < 10000) return '1K-10K';
    return '10K+';
  }
  
  // Implementation of profitability and efficiency calculations
  filterByProfitability(algorithms, profile) {
    const profitableAlgos = algorithms.filter(algo => {
      const profitability = this.calculateProfitability(algo, profile);
      return profitability > 0.5; // Filter algorithms with >50% profitability
    });
    return profitableAlgos.length > 0 ? profitableAlgos : algorithms;
  }
  
  calculateAlgorithmEfficiency(algorithm, profile) {
    // Base efficiency on historical performance
    const history = this.performanceHistory.get(profile.id) || [];
    const algoHistory = history.filter(h => h.algorithm === algorithm);
    
    if (algoHistory.length === 0) return 0.8; // Default efficiency
    
    // Calculate based on recent performance
    const recentHistory = algoHistory.slice(-20);
    const avgDuration = recentHistory.reduce((sum, h) => sum + h.duration, 0) / recentHistory.length;
    const targetDuration = DIFFICULTY_ADJUSTMENT.TARGET_SHARE_TIME;
    
    // Efficiency is how close to target duration
    const efficiency = Math.min(1.0, targetDuration / avgDuration);
    return Math.max(0.1, efficiency);
  }
  
  getNetworkDemand(algorithm) {
    // Calculate based on active jobs for this algorithm
    let demand = 0;
    const algoJobs = Array.from(this.activeJobs.values())
      .filter(job => job.algorithm === algorithm);
    
    // More jobs = higher demand
    demand = Math.min(1.0, algoJobs.length / 100);
    
    // Adjust based on queue length
    const queue = this.algorithmQueues.get(algorithm);
    if (queue && queue.length > 0) {
      demand = Math.min(1.0, demand + queue.length / 50);
    }
    
    return demand;
  }
  
  calculateProfitability(algorithm, profile) {
    // Simplified profitability calculation
    const currencyPrices = {
      'BTC': 60000, 'ETH': 3000, 'XMR': 150, 'LTC': 100,
      'RVN': 0.05, 'DOGE': 0.15, 'DASH': 50, 'ZEC': 40
    };
    
    const currency = this.getCurrencyForAlgorithm(algorithm);
    const price = currencyPrices[currency] || 1;
    const reward = this.calculateBlockReward(algorithm);
    const hashrate = profile.hashrates[algorithm] || this.estimateHashrate(profile, algorithm);
    const power = profile.powerConsumption || 100; // Watts
    const electricityCost = 0.10; // $/kWh
    
    // Revenue per hour
    const blocksPerHour = (hashrate / 1e9) * 0.001; // Simplified
    const revenuePerHour = blocksPerHour * reward * price;
    
    // Cost per hour
    const costPerHour = (power / 1000) * electricityCost;
    
    // Profitability ratio
    const profitability = revenuePerHour > 0 ? (revenuePerHour - costPerHour) / revenuePerHour : 0;
    
    return Math.max(0, Math.min(1, profitability));
  }
  
  async validateShare(share, job) {
    try {
      const { hash, nonce, timestamp } = share;
      
      // Basic validation
      if (!hash || !nonce || !timestamp) return false;
      
      // Check if hash meets difficulty target
      const hashBigInt = BigInt('0x' + hash);
      const targetBigInt = BigInt('0x' + job.target);
      
      if (hashBigInt > targetBigInt) return false;
      
      // Verify timestamp is reasonable (within 5 minutes)
      const now = Date.now();
      if (Math.abs(timestamp - now) > 300000) return false;
      
      // Additional algorithm-specific validation could go here
      
      return true;
    } catch (error) {
      this.logger.error('Share validation error:', error);
      return false;
    }
  }
  
  getCurrentBlockHash(algorithm) {
    // In production, this would fetch from blockchain
    const mockHashes = {
      'sha256': '00000000000000000007316856900e76b4f7a9139cfbfba89842c8d196cd5f91',
      'ethash': '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
      'scrypt': '871b5f50a5d74e1909e2f4d7f2e5f1d3c4e8f1b1c1d1e1f1e2d3c4b5a6978685',
      'randomx': 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456'
    };
    return mockHashes[algorithm] || '0'.repeat(64);
  }
  
  getCurrentBlockHeight(algorithm) {
    // In production, fetch from blockchain
    const heights = {
      'sha256': 820000,
      'ethash': 18900000,
      'scrypt': 2600000,
      'randomx': 3050000
    };
    return heights[algorithm] || 1000000;
  }
  
  calculateMerkleRoot(algorithm) {
    // Simplified merkle root calculation
    const transactions = ['coinbase', 'tx1', 'tx2', 'tx3'];
    let hash = createHash('sha256').update(transactions.join('')).digest('hex');
    return hash;
  }
  
  calculateBits(difficulty) {
    // Convert difficulty to compact bits representation
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    const target = maxTarget / BigInt(Math.floor(difficulty));
    
    // Convert to compact format (simplified)
    let hex = target.toString(16);
    let size = Math.ceil(hex.length / 2);
    let compact = parseInt(hex.substr(0, 6), 16);
    
    return (size << 24) | compact;
  }
  
  calculateWorkSize(algorithm, profile) {
    // Adjust work size based on miner capability
    const baseWorkSize = {
      [MinerType.CPU]: 100,
      [MinerType.GPU]: 1000,
      [MinerType.ASIC]: 10000,
      [MinerType.FPGA]: 5000
    };
    
    return baseWorkSize[profile.type] || 1000;
  }
  
  calculateBatchSize(algorithm, profile) {
    // Optimize batch size for network latency
    const latency = profile.latency || 100;
    const hashrate = profile.hashrates[algorithm] || 1000;
    
    // Higher latency = larger batches
    const batchMultiplier = Math.max(1, latency / 50);
    const baseBatch = Math.ceil(hashrate / 10000);
    
    return Math.min(1000, baseBatch * batchMultiplier);
  }
  
  getCurrencyForAlgorithm(algorithm) {
    const currencyMap = {
      'sha256': 'BTC',
      'scrypt': 'LTC',
      'ethash': 'ETH',
      'randomx': 'XMR',
      'kawpow': 'RVN',
      'x11': 'DASH',
      'equihash': 'ZEC'
    };
    return currencyMap[algorithm] || 'BTC';
  }
  
  calculateBlockReward(algorithm) {
    const rewards = {
      'sha256': 6.25,   // BTC
      'ethash': 2.0,    // ETH
      'scrypt': 12.5,   // LTC
      'randomx': 0.6,   // XMR
      'kawpow': 5000,   // RVN
      'x11': 1.67,      // DASH
      'equihash': 3.125 // ZEC
    };
    return rewards[algorithm] || 1;
  }
  
  calculateFee(algorithm) {
    // Pool fee structure
    return 0.018; // 1.8% for direct payout
  }
  
  updateNetworkStats() {
    let totalHashrate = 0;
    let activeMiners = 0;
    let totalShares = 0;
    
    for (const [minerId, profile] of this.minerProfiles) {
      const isActive = Date.now() - profile.lastSeen < 300000;
      
      if (isActive) {
        activeMiners++;
        
        // Sum hashrates
        Object.values(profile.hashrates).forEach(hashrate => {
          totalHashrate += hashrate;
        });
        
        totalShares += profile.acceptedShares;
      }
    }
    
    // Calculate shares per second
    const sharesPerSecond = this.performanceHistory.size > 0
      ? Array.from(this.performanceHistory.values())
          .flat()
          .filter(h => Date.now() - h.timestamp < 60000)
          .length / 60
      : 0;
    
    this.networkStats = {
      totalHashrate,
      activeMiners,
      sharesPerSecond,
      averageLatency: this.calculateAverageLatency()
    };
    
    this.emit('stats:updated', this.networkStats);
  }
  
  calculateAverageLatency() {
    let totalLatency = 0;
    let count = 0;
    
    for (const [minerId, profile] of this.minerProfiles) {
      if (profile.latency) {
        totalLatency += profile.latency;
        count++;
      }
    }
    
    return count > 0 ? totalLatency / count : 0;
  }
  
  checkMinerPerformance() {
    const now = Date.now();
    
    for (const [minerId, profile] of this.minerProfiles) {
      const timeSinceLastShare = now - profile.lastShareTime;
      const isActive = now - profile.lastSeen < 300000;
      
      if (isActive) {
        // Check for poor performance
        if (timeSinceLastShare > 600000) { // 10 minutes without shares
          this.emit('miner:underperforming', {
            minerId,
            lastShareTime: profile.lastShareTime,
            efficiency: profile.efficiency
          });
        }
        
        // Check for suspicious activity
        if (profile.rejectedShares > profile.acceptedShares * 0.1) {
          this.emit('miner:suspicious', {
            minerId,
            rejectedRatio: profile.rejectedShares / profile.totalShares
          });
        }
      }
    }
  }
  
  rebalanceWorkDistribution() {
    const stats = this.getDistributionStats();
    
    // Check if rebalancing is needed
    const algorithms = Object.keys(stats.algorithmDistribution);
    if (algorithms.length <= 1) return;
    
    const avgMinersPerAlgo = stats.activeMiners / algorithms.length;
    const threshold = avgMinersPerAlgo * 0.5;
    
    for (const [algo, count] of Object.entries(stats.algorithmDistribution)) {
      if (count < threshold) {
        // This algorithm is underutilized
        this.emit('algorithm:underutilized', { algorithm: algo, minerCount: count });
      } else if (count > avgMinersPerAlgo * 1.5) {
        // This algorithm is overutilized
        this.emit('algorithm:overutilized', { algorithm: algo, minerCount: count });
      }
    }
  }
  
  getAlgorithmStats() {
    const stats = {};
    
    for (const [minerId, profile] of this.minerProfiles) {
      if (!profile.currentAlgorithm) continue;
      
      const algo = profile.currentAlgorithm;
      if (!stats[algo]) {
        stats[algo] = {
          minerCount: 0,
          totalHashrate: 0,
          avgEfficiency: 0,
          utilization: 0
        };
      }
      
      stats[algo].minerCount++;
      stats[algo].totalHashrate += profile.hashrates[algo] || 0;
      stats[algo].avgEfficiency += profile.efficiency;
    }
    
    // Calculate averages and utilization
    for (const [algo, data] of Object.entries(stats)) {
      if (data.minerCount > 0) {
        data.avgEfficiency /= data.minerCount;
        data.utilization = Math.min(1.0, data.minerCount / 100); // Assume 100 miners is full utilization
      }
    }
    
    return stats;
  }
  
  rebalanceAlgorithms(overloaded, underloaded) {
    // Find miners on overloaded algorithms that can switch
    const candidates = [];
    
    for (const [minerId, profile] of this.minerProfiles) {
      if (overloaded.includes(profile.currentAlgorithm)) {
        // Check if miner supports any underloaded algorithm
        const supportedUnderloaded = underloaded.filter(algo => 
          profile.capabilities.includes(algo) || 
          profile.hashrates[algo] > 0
        );
        
        if (supportedUnderloaded.length > 0) {
          candidates.push({ minerId, profile, targetAlgorithms: supportedUnderloaded });
        }
      }
    }
    
    // Rebalance top candidates
    const rebalanceCount = Math.min(5, candidates.length);
    for (let i = 0; i < rebalanceCount; i++) {
      const { minerId, profile, targetAlgorithms } = candidates[i];
      const newAlgorithm = targetAlgorithms[0];
      
      this.emit('miner:rebalance', {
        minerId,
        fromAlgorithm: profile.currentAlgorithm,
        toAlgorithm: newAlgorithm
      });
      
      // Update profile
      profile.currentAlgorithm = newAlgorithm;
    }
  }
}