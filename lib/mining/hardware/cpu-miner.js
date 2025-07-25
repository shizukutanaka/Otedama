/**
 * CPU Miner - Otedama
 * CPU mining implementation with multi-threading support
 * 
 * Design principles:
 * - Efficient thread management (Carmack)
 * - Clean worker abstraction (Martin)
 * - Simple, performant implementation (Pike)
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { cpus } from 'os';
import { createLogger } from '../../core/logger.js';

const logger = createLogger('CPUMiner');

export class CPUMiner extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      threads: config.threads || cpus().length,
      algorithm: config.algorithm || 'sha256',
      priority: config.priority || 0,
      affinity: config.affinity || null,
      ...config
    };
    
    this.id = `cpu-${Date.now()}`;
    this.name = 'CPU Miner';
    this.workers = [];
    this.currentJob = null;
    this.difficulty = 1;
    this.isRunning = false;
    
    // Statistics
    this.stats = {
      hashes: 0,
      shares: 0,
      hashrate: 0,
      temperature: 0,
      lastUpdate: Date.now()
    };
  }
  
  /**
   * Initialize CPU miner
   */
  async initialize() {
    logger.info(`Initializing CPU miner with ${this.config.threads} threads`);
    
    // Create worker threads
    for (let i = 0; i < this.config.threads; i++) {
      const worker = new Worker(new URL('../workers/cpu-mining-worker.js', import.meta.url), {
        workerData: {
          threadId: i,
          algorithm: this.config.algorithm,
          affinity: this.config.affinity
        }
      });
      
      // Setup worker event handlers
      this.setupWorkerHandlers(worker, i);
      
      this.workers.push({
        id: i,
        worker,
        hashes: 0,
        hashrate: 0
      });
    }
    
    logger.info('CPU miner initialized');
  }
  
  /**
   * Setup worker event handlers
   */
  setupWorkerHandlers(worker, threadId) {
    worker.on('message', (message) => {
      switch (message.type) {
        case 'hashrate':
          this.updateWorkerHashrate(threadId, message.data);
          break;
          
        case 'share':
          this.handleShare(message.data);
          break;
          
        case 'error':
          logger.error(`Worker ${threadId} error:`, message.error);
          this.emit('error', new Error(`Worker ${threadId}: ${message.error}`));
          break;
          
        case 'ready':
          logger.debug(`Worker ${threadId} ready`);
          break;
      }
    });
    
    worker.on('error', (error) => {
      logger.error(`Worker ${threadId} crashed:`, error);
      this.emit('error', error);
    });
    
    worker.on('exit', (code) => {
      if (code !== 0 && this.isRunning) {
        logger.warn(`Worker ${threadId} exited with code ${code}, restarting...`);
        this.restartWorker(threadId);
      }
    });
  }
  
  /**
   * Start mining
   */
  async start() {
    if (this.isRunning) {
      return;
    }
    
    logger.info('Starting CPU mining');
    
    this.isRunning = true;
    
    // Start all workers
    for (const workerInfo of this.workers) {
      workerInfo.worker.postMessage({
        type: 'start',
        job: this.currentJob,
        difficulty: this.difficulty
      });
    }
    
    // Start monitoring
    this.startMonitoring();
    
    this.emit('started');
  }
  
  /**
   * Stop mining
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    logger.info('Stopping CPU mining');
    
    this.isRunning = false;
    
    // Stop monitoring
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    // Stop all workers
    for (const workerInfo of this.workers) {
      workerInfo.worker.postMessage({ type: 'stop' });
    }
    
    // Wait for workers to stop
    await new Promise(resolve => setTimeout(resolve, 100));
    
    this.emit('stopped');
  }
  
  /**
   * Set new job
   */
  setJob(job) {
    this.currentJob = job;
    
    if (this.isRunning) {
      // Distribute job to all workers
      for (let i = 0; i < this.workers.length; i++) {
        const workerInfo = this.workers[i];
        
        // Assign different nonce ranges to each worker
        const nonceRange = {
          start: i * 0x100000000,
          end: (i + 1) * 0x100000000
        };
        
        workerInfo.worker.postMessage({
          type: 'job',
          job: {
            ...job,
            nonceRange
          }
        });
      }
    }
  }
  
  /**
   * Set difficulty
   */
  setDifficulty(difficulty) {
    this.difficulty = difficulty;
    
    if (this.isRunning) {
      for (const workerInfo of this.workers) {
        workerInfo.worker.postMessage({
          type: 'difficulty',
          difficulty
        });
      }
    }
  }
  
  /**
   * Update worker hashrate
   */
  updateWorkerHashrate(threadId, data) {
    const workerInfo = this.workers[threadId];
    if (!workerInfo) return;
    
    workerInfo.hashes = data.hashes;
    workerInfo.hashrate = data.hashrate;
    
    this.updateTotalHashrate();
  }
  
  /**
   * Update total hashrate
   */
  updateTotalHashrate() {
    let totalHashes = 0;
    let totalHashrate = 0;
    
    for (const workerInfo of this.workers) {
      totalHashes += workerInfo.hashes;
      totalHashrate += workerInfo.hashrate;
    }
    
    this.stats.hashes = totalHashes;
    this.stats.hashrate = totalHashrate;
    this.stats.lastUpdate = Date.now();
    
    this.emit('hashrate', totalHashrate);
  }
  
  /**
   * Handle found share
   */
  handleShare(share) {
    this.stats.shares++;
    
    logger.info(`CPU found share with difficulty ${share.difficulty}`);
    
    this.emit('share', {
      ...share,
      miner: this.name,
      device: 'CPU'
    });
  }
  
  /**
   * Start monitoring
   */
  startMonitoring() {
    // Monitor CPU temperature
    this.monitoringInterval = setInterval(() => {
      this.updateTemperature();
    }, 5000);
  }
  
  /**
   * Update CPU temperature
   */
  async updateTemperature() {
    // This would read actual CPU temperature
    // For now, simulate
    this.stats.temperature = 45 + Math.random() * 20; // 45-65°C
    
    this.emit('temperature', this.stats.temperature);
  }
  
  /**
   * Restart failed worker
   */
  async restartWorker(threadId) {
    const workerInfo = this.workers[threadId];
    if (!workerInfo) return;
    
    // Create new worker
    const worker = new Worker(new URL('../workers/cpu-mining-worker.js', import.meta.url), {
      workerData: {
        threadId,
        algorithm: this.config.algorithm,
        affinity: this.config.affinity
      }
    });
    
    this.setupWorkerHandlers(worker, threadId);
    
    // Replace old worker
    workerInfo.worker = worker;
    workerInfo.hashes = 0;
    workerInfo.hashrate = 0;
    
    // Start if running
    if (this.isRunning) {
      worker.postMessage({
        type: 'start',
        job: this.currentJob,
        difficulty: this.difficulty
      });
    }
  }
  
  /**
   * Apply settings
   */
  async applySettings(settings) {
    // Update thread count if changed
    if (settings.threads && settings.threads !== this.config.threads) {
      await this.setThreadCount(settings.threads);
    }
    
    // Update priority
    if (settings.priority !== undefined) {
      this.setPriority(settings.priority);
    }
  }
  
  /**
   * Set thread count
   */
  async setThreadCount(threads) {
    logger.info(`Changing thread count from ${this.config.threads} to ${threads}`);
    
    const wasRunning = this.isRunning;
    
    if (wasRunning) {
      await this.stop();
    }
    
    // Terminate extra workers
    while (this.workers.length > threads) {
      const workerInfo = this.workers.pop();
      await workerInfo.worker.terminate();
    }
    
    // Add new workers
    while (this.workers.length < threads) {
      const threadId = this.workers.length;
      const worker = new Worker(new URL('../workers/cpu-mining-worker.js', import.meta.url), {
        workerData: {
          threadId,
          algorithm: this.config.algorithm,
          affinity: this.config.affinity
        }
      });
      
      this.setupWorkerHandlers(worker, threadId);
      
      this.workers.push({
        id: threadId,
        worker,
        hashes: 0,
        hashrate: 0
      });
    }
    
    this.config.threads = threads;
    
    if (wasRunning) {
      await this.start();
    }
  }
  
  /**
   * Set process priority
   */
  setPriority(priority) {
    this.config.priority = priority;
    
    for (const workerInfo of this.workers) {
      workerInfo.worker.postMessage({
        type: 'priority',
        priority
      });
    }
  }
  
  /**
   * Throttle CPU usage
   */
  throttle() {
    logger.warn('Throttling CPU miner due to high temperature');
    
    // Reduce thread count temporarily
    if (this.config.threads > 1) {
      this.setThreadCount(Math.floor(this.config.threads / 2));
    }
  }
  
  /**
   * Get hashrate
   */
  getHashrate() {
    return this.stats.hashrate;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      id: this.id,
      name: this.name,
      type: 'CPU',
      algorithm: this.config.algorithm,
      threads: this.config.threads,
      ...this.stats,
      efficiency: this.stats.shares > 0 ? this.stats.hashes / this.stats.shares : 0
    };
  }
  
  /**
   * Cleanup
   */
  async cleanup() {
    await this.stop();
    
    // Terminate all workers
    for (const workerInfo of this.workers) {
      await workerInfo.worker.terminate();
    }
    
    this.workers = [];
  }
}

export default CPUMiner;