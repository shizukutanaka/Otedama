import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { createHash } from 'crypto';
import * as os from 'os';
import { Logger } from './logger.js';
import { ALGO_CONFIG, TIME_CONSTANTS } from './constants.js';

/**
 * High-Performance Mining Engine
 * 高性能マイニングエンジン
 * 
 * Features:
 * - Multi-algorithm support (SHA-256, KawPow, RandomX, Ethash, Scrypt)
 * - Multi-threaded mining with worker processes
 * - Dynamic difficulty adjustment
 * - Hardware detection and optimization
 * - Thermal throttling and safety controls
 * - Performance monitoring and statistics
 * - Automatic share submission
 * - Error recovery and fault tolerance
 */
export class MiningEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this.logger = new Logger('Mining');
    this.config = {
      algorithm: config.algorithm || 'kawpow',
      currency: config.currency || 'RVN',
      walletAddress: config.walletAddress || '',
      threads: config.threads || 0, // 0 = auto-detect
      intensity: config.intensity || 100,
      difficulty: config.difficulty || 1000000,
      maxTemperature: config.maxTemperature || 85, // Celsius
      enableThermalThrottling: config.enableThermalThrottling !== false,
      enableOptimizations: config.enableOptimizations !== false,
      shareSubmissionInterval: config.shareSubmissionInterval || 1000,
      statUpdateInterval: config.statUpdateInterval || 5000,
      ...config
    };

    // Mining state
    this.workers = new Map();
    this.isRunning = false;
    this.currentJob = null;
    this.stats = {
      hashrate: 0,
      sharesSubmitted: 0,
      sharesAccepted: 0,
      sharesRejected: 0,
      efficiency: 100,
      temperature: 0,
      powerUsage: 0,
      uptime: 0,
      startTime: 0,
      lastShare: 0,
      threads: 0,
      difficulty: this.config.difficulty
    };

    // Performance monitoring
    this.performanceMetrics = {
      hashCounts: [],
      shareSubmissions: [],
      rejectionReasons: new Map(),
      thermalEvents: [],
      optimizationEvents: []
    };

    // Hardware information
    this.hardware = this.detectHardware();
    
    // Timers
    this.timers = new Map();

    this.initialize();
  }

  /**
   * Initialize mining engine
   */
  initialize() {
    try {
      // Validate configuration
      this.validateConfig();

      // Setup algorithm-specific parameters
      this.setupAlgorithmConfig();

      // Auto-detect optimal thread count if not specified
      if (this.config.threads === 0) {
        this.config.threads = this.detectOptimalThreads();
      }

      this.logger.info(`Mining engine initialized: ${this.config.algorithm.toUpperCase()} algorithm, ${this.config.threads} threads`);

    } catch (error) {
      this.logger.error('Failed to initialize mining engine:', error);
      throw error;
    }
  }

  /**
   * Detect hardware capabilities
   */
  detectHardware() {
    try {
      const cpus = os.cpus();
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();

      const hardware = {
        cpu: {
          model: cpus[0]?.model || 'Unknown',
          cores: cpus.length,
          speed: cpus[0]?.speed || 0,
          features: this.detectCPUFeatures()
        },
        memory: {
          total: totalMemory,
          free: freeMemory,
          used: totalMemory - freeMemory
        },
        platform: os.platform(),
        arch: os.arch(),
        loadAvg: os.loadavg(),
        capabilities: this.detectMiningCapabilities()
      };

      this.logger.info(`Hardware detected: ${hardware.cpu.cores} cores, ${Math.round(totalMemory / 1024 / 1024 / 1024)}GB RAM`);
      return hardware;

    } catch (error) {
      this.logger.error('Failed to detect hardware:', error);
      return {
        cpu: { cores: 1, model: 'Unknown' },
        memory: { total: 0, free: 0 },
        capabilities: []
      };
    }
  }

  /**
   * Detect CPU features for optimization
   */
  detectCPUFeatures() {
    const features = [];
    
    try {
      // In a real implementation, this would check for:
      // - AES-NI support
      // - AVX/AVX2 support
      // - SSE instructions
      // - Hardware RNG
      
      // Simplified detection based on common patterns
      const cpuModel = os.cpus()[0]?.model?.toLowerCase() || '';
      
      if (cpuModel.includes('intel')) {
        features.push('intel');
        if (cpuModel.includes('i3') || cpuModel.includes('i5') || cpuModel.includes('i7') || cpuModel.includes('i9')) {
          features.push('aes-ni', 'avx', 'sse4');
        }
      } else if (cpuModel.includes('amd')) {
        features.push('amd');
        if (cpuModel.includes('ryzen') || cpuModel.includes('epyc')) {
          features.push('aes-ni', 'avx2', 'sse4');
        }
      }

      // Check architecture
      if (os.arch() === 'x64') {
        features.push('x64');
      }

      return features;
    } catch (error) {
      this.logger.warn('Failed to detect CPU features:', error);
      return [];
    }
  }

  /**
   * Detect mining capabilities
   */
  detectMiningCapabilities() {
    const capabilities = ['cpu'];
    
    // In a real implementation, this would detect:
    // - GPU presence and capabilities
    // - ASIC miners
    // - FPGA devices
    
    return capabilities;
  }

  /**
   * Validate mining configuration
   */
  validateConfig() {
    if (!this.config.algorithm || !ALGO_CONFIG[this.config.algorithm]) {
      throw new Error(`Unsupported algorithm: ${this.config.algorithm}`);
    }

    if (!this.config.walletAddress) {
      this.logger.warn('No wallet address configured - mining rewards will not be credited');
    }

    if (this.config.threads < 0 || this.config.threads > os.cpus().length * 2) {
      throw new Error(`Invalid thread count: ${this.config.threads}`);
    }

    if (this.config.intensity < 1 || this.config.intensity > 100) {
      throw new Error(`Invalid intensity: ${this.config.intensity}`);
    }
  }

  /**
   * Setup algorithm-specific configuration
   */
  setupAlgorithmConfig() {
    const algoConfig = ALGO_CONFIG[this.config.algorithm];
    
    this.algorithmConfig = {
      ...algoConfig,
      memorySize: this.calculateMemoryRequirement(),
      optimization: this.getOptimizationSettings()
    };

    this.logger.debug(`Algorithm config: ${JSON.stringify(this.algorithmConfig)}`);
  }

  /**
   * Calculate memory requirement for algorithm
   */
  calculateMemoryRequirement() {
    const baseMemory = {
      sha256: 1024 * 1024,      // 1MB
      kawpow: 1024 * 1024 * 64, // 64MB
      randomx: 1024 * 1024 * 256, // 256MB
      ethash: 1024 * 1024 * 128,  // 128MB
      scrypt: 1024 * 1024 * 32    // 32MB
    };

    return baseMemory[this.config.algorithm] || 1024 * 1024;
  }

  /**
   * Get optimization settings for current hardware
   */
  getOptimizationSettings() {
    const optimizations = {
      simd: this.hardware.cpu.features.includes('avx2'),
      aesni: this.hardware.cpu.features.includes('aes-ni'),
      prefetch: true,
      hugePages: this.hardware.memory.total > 8 * 1024 * 1024 * 1024, // 8GB+
      affinityMask: this.calculateAffinityMask()
    };

    return optimizations;
  }

  /**
   * Calculate CPU affinity mask for optimal performance
   */
  calculateAffinityMask() {
    const coreCount = this.hardware.cpu.cores;
    const threadCount = this.config.threads;
    
    // Distribute threads across cores, avoiding hyperthreads if possible
    const mask = [];
    const step = Math.max(1, Math.floor(coreCount / threadCount));
    
    for (let i = 0; i < threadCount; i++) {
      mask.push((i * step) % coreCount);
    }
    
    return mask;
  }

  /**
   * Detect optimal thread count
   */
  detectOptimalThreads() {
    const coreCount = this.hardware.cpu.cores;
    const memoryGB = this.hardware.memory.total / (1024 * 1024 * 1024);
    
    // Algorithm-specific thread calculation
    let optimalThreads;
    
    switch (this.config.algorithm) {
      case 'randomx':
        // RandomX is memory-intensive, limit by available memory
        optimalThreads = Math.min(coreCount, Math.floor(memoryGB / 2));
        break;
      case 'kawpow':
        // KawPow benefits from more threads
        optimalThreads = Math.min(coreCount * 2, 16);
        break;
      default:
        // Conservative approach for other algorithms
        optimalThreads = Math.max(1, coreCount - 1);
    }

    // Ensure we have at least 1 thread and don't exceed hardware limits
    optimalThreads = Math.max(1, Math.min(optimalThreads, coreCount * 2));
    
    this.logger.info(`Auto-detected optimal thread count: ${optimalThreads}`);
    return optimalThreads;
  }

  /**
   * Start mining
   */
  async start(jobData = {}) {
    try {
      if (this.isRunning) {
        this.logger.warn('Mining already running');
        return true;
      }

      this.logger.info(`Starting mining: ${this.config.algorithm.toUpperCase()} with ${this.config.threads} threads`);

      // Update job data
      this.currentJob = {
        difficulty: jobData.difficulty || this.config.difficulty,
        target: this.calculateTarget(jobData.difficulty || this.config.difficulty),
        jobId: Date.now().toString(),
        ...jobData
      };

      // Create mining workers
      await this.createWorkers();

      // Start periodic tasks
      this.startPeriodicTasks();

      // Update state
      this.isRunning = true;
      this.stats.startTime = Date.now();
      this.stats.threads = this.config.threads;
      this.stats.difficulty = this.currentJob.difficulty;

      this.logger.info('Mining started successfully');
      this.emit('mining:started', { 
        algorithm: this.config.algorithm,
        threads: this.config.threads,
        difficulty: this.currentJob.difficulty
      });

      return true;

    } catch (error) {
      this.logger.error('Failed to start mining:', error);
      await this.stop();
      throw error;
    }
  }

  /**
   * Create mining workers
   */
  async createWorkers() {
    try {
      const workerPromises = [];

      for (let i = 0; i < this.config.threads; i++) {
        const workerPromise = this.createWorker(i);
        workerPromises.push(workerPromise);
      }

      await Promise.all(workerPromises);
      this.logger.info(`Created ${this.workers.size} mining workers`);

    } catch (error) {
      this.logger.error('Failed to create workers:', error);
      throw error;
    }
  }

  /**
   * Create individual mining worker
   */
  async createWorker(workerId) {
    try {
      const workerData = {
        workerId,
        algorithm: this.config.algorithm,
        intensity: this.config.intensity,
        job: this.currentJob,
        optimization: this.algorithmConfig.optimization,
        affinityCPU: this.algorithmConfig.optimization.affinityMask[workerId % this.algorithmConfig.optimization.affinityMask.length]
      };

      const worker = new Worker(this.getWorkerCode(), {
        eval: true,
        workerData,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32
        }
      });

      // Setup worker event handlers
      worker.on('message', (message) => {
        this.handleWorkerMessage(workerId, message);
      });

      worker.on('error', (error) => {
        this.logger.error(`Worker ${workerId} error:`, error);
        this.restartWorker(workerId);
      });

      worker.on('exit', (code) => {
        if (code !== 0 && this.isRunning) {
          this.logger.warn(`Worker ${workerId} exited with code ${code}, restarting...`);
          this.restartWorker(workerId);
        }
      });

      this.workers.set(workerId, {
        worker,
        hashCount: 0,
        lastHashCount: 0,
        startTime: Date.now(),
        shares: 0,
        status: 'running'
      });

      return worker;

    } catch (error) {
      this.logger.error(`Failed to create worker ${workerId}:`, error);
      throw error;
    }
  }

  /**
   * Get worker thread code
   */
  getWorkerCode() {
    return `
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');

class MiningWorker {
  constructor(data) {
    this.workerId = data.workerId;
    this.algorithm = data.algorithm;
    this.intensity = data.intensity;
    this.job = data.job;
    this.optimization = data.optimization;
    this.isRunning = true;
    
    this.hashCount = 0;
    this.startTime = Date.now();
    this.lastReport = Date.now();
    
    // Set CPU affinity if specified
    if (data.affinityCPU !== undefined) {
      try {
        process.binding('uv').setaffinity(process.pid, [data.affinityCPU]);
      } catch (e) {
        // CPU affinity not available on this platform
      }
    }
  }

  start() {
    this.mine();
    
    // Report hashrate every 5 seconds
    setInterval(() => {
      this.reportHashrate();
    }, 5000);
  }

  mine() {
    while (this.isRunning) {
      const nonce = Math.floor(Math.random() * 0xFFFFFFFF);
      const hash = this.calculateHash(nonce);
      this.hashCount++;
      
      if (this.checkHash(hash)) {
        this.submitShare(nonce, hash);
      }
      
      // Throttle based on intensity
      if (this.hashCount % (101 - this.intensity) === 0) {
        setImmediate(() => this.mine());
        return;
      }
    }
  }

  calculateHash(nonce) {
    // Simplified hash calculation - in production would use actual algorithm
    const data = Buffer.concat([
      Buffer.from(this.job.jobId),
      Buffer.from(nonce.toString()),
      Buffer.from(Date.now().toString())
    ]);
    
    switch (this.algorithm) {
      case 'sha256':
        return crypto.createHash('sha256').update(data).digest();
      case 'kawpow':
        // Simplified KawPow - would use actual implementation
        let hash = crypto.createHash('sha256').update(data).digest();
        for (let i = 0; i < 2; i++) {
          hash = crypto.createHash('sha256').update(hash).digest();
        }
        return hash;
      case 'randomx':
        // Simplified RandomX - would use actual implementation
        let rxHash = crypto.createHash('sha512').update(data).digest();
        return rxHash.slice(0, 32);
      case 'ethash':
        // Simplified Ethash - would use actual implementation
        return crypto.createHash('keccak256').update(data).digest();
      case 'scrypt':
        // Simplified Scrypt - would use actual implementation
        return crypto.scryptSync(data, 'salt', 32);
      default:
        return crypto.createHash('sha256').update(data).digest();
    }
  }

  checkHash(hash) {
    // Check if hash meets difficulty target
    const target = this.job.target;
    if (!target) return false;
    
    // Convert hash to number and compare with target
    const hashNum = BigInt('0x' + hash.toString('hex'));
    const targetNum = BigInt('0x' + target);
    
    return hashNum <= targetNum;
  }

  submitShare(nonce, hash) {
    parentPort.postMessage({
      type: 'share',
      data: {
        workerId: this.workerId,
        nonce,
        hash: hash.toString('hex'),
        difficulty: this.job.difficulty,
        timestamp: Date.now()
      }
    });
  }

  reportHashrate() {
    const now = Date.now();
    const duration = (now - this.lastReport) / 1000;
    const hashrate = (this.hashCount - (this.lastHashCount || 0)) / duration;
    
    parentPort.postMessage({
      type: 'hashrate',
      data: {
        workerId: this.workerId,
        hashrate,
        hashCount: this.hashCount,
        uptime: now - this.startTime
      }
    });
    
    this.lastHashCount = this.hashCount;
    this.lastReport = now;
  }

  updateJob(job) {
    this.job = job;
  }

  stop() {
    this.isRunning = false;
  }
}

// Start worker
const worker = new MiningWorker(workerData);
worker.start();

// Handle messages from parent
parentPort.on('message', (message) => {
  switch (message.type) {
    case 'update_job':
      worker.updateJob(message.data);
      break;
    case 'stop':
      worker.stop();
      break;
  }
});
`;
  }

  /**
   * Handle worker message
   */
  handleWorkerMessage(workerId, message) {
    try {
      const worker = this.workers.get(workerId);
      if (!worker) return;

      switch (message.type) {
        case 'share':
          this.handleShare(workerId, message.data);
          break;

        case 'hashrate':
          this.updateWorkerHashrate(workerId, message.data);
          break;

        case 'error':
          this.logger.error(`Worker ${workerId} reported error:`, message.data);
          break;

        default:
          this.logger.debug(`Unknown message from worker ${workerId}:`, message);
      }

    } catch (error) {
      this.logger.error(`Error handling worker message from ${workerId}:`, error);
    }
  }

  /**
   * Handle share submission
   */
  handleShare(workerId, shareData) {
    try {
      const isValid = this.validateShare(shareData);
      
      if (isValid) {
        this.stats.sharesAccepted++;
        this.stats.lastShare = Date.now();
        
        const worker = this.workers.get(workerId);
        if (worker) {
          worker.shares++;
        }

        this.logger.info(`Valid share found by worker ${workerId}: difficulty ${shareData.difficulty}`);
        
        this.emit('share', {
          workerId: shareData.workerId,
          difficulty: shareData.difficulty,
          hash: shareData.hash,
          valid: true,
          timestamp: shareData.timestamp
        });

        // Check if this could be a block
        if (this.isBlockHash(shareData.hash, shareData.difficulty)) {
          this.handleBlockFound(shareData);
        }

      } else {
        this.stats.sharesRejected++;
        this.logger.debug(`Invalid share from worker ${workerId}`);
        
        this.emit('share', {
          workerId: shareData.workerId,
          difficulty: shareData.difficulty,
          hash: shareData.hash,
          valid: false,
          timestamp: shareData.timestamp
        });
      }

      this.stats.sharesSubmitted++;

    } catch (error) {
      this.logger.error('Error handling share:', error);
    }
  }

  /**
   * Validate share
   */
  validateShare(shareData) {
    try {
      // Basic validation
      if (!shareData.hash || !shareData.difficulty || !shareData.nonce) {
        return false;
      }

      // Check if hash meets minimum difficulty
      const hashBuffer = Buffer.from(shareData.hash, 'hex');
      const target = this.calculateTarget(shareData.difficulty);
      
      return this.compareHashes(hashBuffer, Buffer.from(target, 'hex'));

    } catch (error) {
      this.logger.error('Share validation error:', error);
      return false;
    }
  }

  /**
   * Check if hash could be a block
   */
  isBlockHash(hash, difficulty) {
    // In a real implementation, this would check against network difficulty
    return difficulty >= this.currentJob.difficulty * 10; // Simplified check
  }

  /**
   * Handle block found
   */
  handleBlockFound(shareData) {
    try {
      this.logger.info(`🎉 BLOCK FOUND! Hash: ${shareData.hash}`);

      this.emit('block', {
        hash: shareData.hash,
        difficulty: shareData.difficulty,
        height: this.currentJob.height || 0,
        miner: this.config.walletAddress,
        algorithm: this.config.algorithm,
        timestamp: Date.now()
      });

    } catch (error) {
      this.logger.error('Error handling block found:', error);
    }
  }

  /**
   * Update worker hashrate
   */
  updateWorkerHashrate(workerId, data) {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.hashCount = data.hashCount;
      worker.hashrate = data.hashrate;
      worker.uptime = data.uptime;
    }
  }

  /**
   * Start periodic tasks
   */
  startPeriodicTasks() {
    // Statistics update timer
    this.timers.set('stats', setInterval(() => {
      this.updateStatistics();
    }, this.config.statUpdateInterval));

    // Temperature monitoring timer
    if (this.config.enableThermalThrottling) {
      this.timers.set('thermal', setInterval(() => {
        this.monitorTemperature();
      }, 10000)); // Every 10 seconds
    }

    // Difficulty adjustment timer
    this.timers.set('difficulty', setInterval(() => {
      this.adjustDifficulty();
    }, 60000)); // Every minute

    // Performance optimization timer
    if (this.config.enableOptimizations) {
      this.timers.set('optimization', setInterval(() => {
        this.optimizePerformance();
      }, 300000)); // Every 5 minutes
    }
  }

  /**
   * Update mining statistics
   */
  updateStatistics() {
    try {
      // Calculate total hashrate
      let totalHashrate = 0;
      let activeWorkers = 0;
      
      for (const worker of this.workers.values()) {
        if (worker.hashrate > 0) {
          totalHashrate += worker.hashrate;
          activeWorkers++;
        }
      }

      // Update stats
      this.stats.hashrate = totalHashrate;
      this.stats.uptime = Date.now() - this.stats.startTime;
      this.stats.efficiency = this.stats.sharesSubmitted > 0 ? 
        (this.stats.sharesAccepted / this.stats.sharesSubmitted * 100) : 100;

      // Emit stats update
      this.emit('stats:update', this.stats);

    } catch (error) {
      this.logger.error('Error updating statistics:', error);
    }
  }

  /**
   * Monitor temperature and throttle if necessary
   */
  monitorTemperature() {
    try {
      // In a real implementation, this would read actual CPU temperature
      // For now, simulate based on load and time
      const loadAvg = os.loadavg()[0];
      const uptime = (Date.now() - this.stats.startTime) / 1000 / 60; // minutes
      
      // Simplified temperature calculation
      this.stats.temperature = Math.min(85, 40 + (loadAvg * 10) + (uptime * 0.1));

      if (this.stats.temperature > this.config.maxTemperature) {
        this.logger.warn(`High temperature detected: ${this.stats.temperature}°C, throttling...`);
        this.throttleForTemperature();
      }

    } catch (error) {
      this.logger.error('Error monitoring temperature:', error);
    }
  }

  /**
   * Throttle mining for temperature control
   */
  throttleForTemperature() {
    // Reduce intensity temporarily
    const originalIntensity = this.config.intensity;
    this.config.intensity = Math.max(50, this.config.intensity - 20);
    
    this.logger.info(`Thermal throttling: reduced intensity from ${originalIntensity} to ${this.config.intensity}`);
    
    // Update workers with new intensity
    this.updateWorkersIntensity();
    
    // Restore intensity after cooling period
    setTimeout(() => {
      this.config.intensity = originalIntensity;
      this.updateWorkersIntensity();
      this.logger.info(`Thermal throttling ended: restored intensity to ${originalIntensity}`);
    }, 60000); // 1 minute cooling period
  }

  /**
   * Update workers with new intensity
   */
  updateWorkersIntensity() {
    for (const [workerId, worker] of this.workers) {
      worker.worker.postMessage({
        type: 'update_intensity',
        data: { intensity: this.config.intensity }
      });
    }
  }

  /**
   * Adjust mining difficulty
   */
  adjustDifficulty() {
    try {
      const timeSinceLastShare = Date.now() - this.stats.lastShare;
      const targetTime = 30000; // 30 seconds target

      let newDifficulty = this.currentJob.difficulty;

      if (timeSinceLastShare > targetTime * 2) {
        // Too slow, reduce difficulty
        newDifficulty = Math.max(1000, this.currentJob.difficulty * 0.8);
      } else if (timeSinceLastShare < targetTime / 2 && this.stats.lastShare > 0) {
        // Too fast, increase difficulty
        newDifficulty = this.currentJob.difficulty * 1.2;
      }

      if (newDifficulty !== this.currentJob.difficulty) {
        this.updateJobDifficulty(newDifficulty);
      }

    } catch (error) {
      this.logger.error('Error adjusting difficulty:', error);
    }
  }

  /**
   * Update job difficulty
   */
  updateJobDifficulty(newDifficulty) {
    try {
      const oldDifficulty = this.currentJob.difficulty;
      this.currentJob.difficulty = newDifficulty;
      this.currentJob.target = this.calculateTarget(newDifficulty);
      this.stats.difficulty = newDifficulty;

      // Update workers
      for (const worker of this.workers.values()) {
        worker.worker.postMessage({
          type: 'update_job',
          data: this.currentJob
        });
      }

      this.logger.info(`Difficulty adjusted: ${oldDifficulty} → ${newDifficulty}`);
      this.emit('difficulty:adjusted', { oldDifficulty, newDifficulty });

    } catch (error) {
      this.logger.error('Error updating job difficulty:', error);
    }
  }

  /**
   * Optimize performance based on current metrics
   */
  optimizePerformance() {
    try {
      // Analyze performance metrics
      const avgHashrate = this.calculateAverageHashrate();
      const efficiency = this.stats.efficiency;

      // Auto-tune thread count if performance is poor
      if (efficiency < 80 && this.config.threads > 1) {
        this.logger.info('Poor efficiency detected, reducing thread count');
        this.adjustThreadCount(this.config.threads - 1);
      } else if (efficiency > 95 && avgHashrate > 0 && this.config.threads < this.hardware.cpu.cores) {
        this.logger.info('Excellent efficiency, trying to increase thread count');
        this.adjustThreadCount(this.config.threads + 1);
      }

    } catch (error) {
      this.logger.error('Error optimizing performance:', error);
    }
  }

  /**
   * Calculate average hashrate over time
   */
  calculateAverageHashrate() {
    if (this.performanceMetrics.hashCounts.length === 0) return 0;
    
    const recent = this.performanceMetrics.hashCounts.slice(-10);
    return recent.reduce((sum, rate) => sum + rate, 0) / recent.length;
  }

  /**
   * Adjust thread count dynamically
   */
  async adjustThreadCount(newThreadCount) {
    try {
      if (newThreadCount < 1 || newThreadCount > os.cpus().length * 2) {
        return;
      }

      const oldThreadCount = this.config.threads;
      this.config.threads = newThreadCount;

      // Stop current workers
      await this.stopWorkers();

      // Create new workers
      await this.createWorkers();

      this.stats.threads = newThreadCount;
      this.logger.info(`Thread count adjusted: ${oldThreadCount} → ${newThreadCount}`);

    } catch (error) {
      this.logger.error('Error adjusting thread count:', error);
    }
  }

  /**
   * Restart a worker
   */
  async restartWorker(workerId) {
    try {
      // Remove old worker
      const oldWorker = this.workers.get(workerId);
      if (oldWorker) {
        oldWorker.worker.terminate();
        this.workers.delete(workerId);
      }

      // Create new worker
      await this.createWorker(workerId);
      this.logger.info(`Worker ${workerId} restarted`);

    } catch (error) {
      this.logger.error(`Failed to restart worker ${workerId}:`, error);
    }
  }

  /**
   * Calculate target from difficulty
   */
  calculateTarget(difficulty) {
    // Simplified target calculation
    const maxTarget = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
    const targetNum = BigInt('0x' + maxTarget) / BigInt(difficulty);
    return targetNum.toString(16).padStart(64, '0');
  }

  /**
   * Compare hash values
   */
  compareHashes(hash1, hash2) {
    return hash1.compare(hash2) <= 0;
  }

  /**
   * Stop workers
   */
  async stopWorkers() {
    try {
      const stopPromises = [];

      for (const [workerId, worker] of this.workers) {
        worker.worker.postMessage({ type: 'stop' });
        stopPromises.push(
          worker.worker.terminate().catch(err => 
            this.logger.warn(`Error terminating worker ${workerId}:`, err)
          )
        );
      }

      await Promise.allSettled(stopPromises);
      this.workers.clear();

    } catch (error) {
      this.logger.error('Error stopping workers:', error);
    }
  }

  /**
   * Get mining statistics
   */
  getStats() {
    return {
      ...this.stats,
      workers: Array.from(this.workers.entries()).map(([id, worker]) => ({
        id,
        hashrate: worker.hashrate || 0,
        shares: worker.shares || 0,
        uptime: Date.now() - worker.startTime,
        status: worker.status
      })),
      algorithm: this.config.algorithm,
      currency: this.config.currency,
      intensity: this.config.intensity,
      isRunning: this.isRunning
    };
  }

  /**
   * Stop mining
   */
  async stop() {
    try {
      if (!this.isRunning) {
        return true;
      }

      this.logger.info('Stopping mining...');
      this.isRunning = false;

      // Stop all timers
      for (const [name, timer] of this.timers) {
        clearInterval(timer);
      }
      this.timers.clear();

      // Stop workers
      await this.stopWorkers();

      this.logger.info('Mining stopped');
      this.emit('mining:stopped');

      return true;

    } catch (error) {
      this.logger.error('Error stopping mining:', error);
      return false;
    }
  }
}

export default MiningEngine;
