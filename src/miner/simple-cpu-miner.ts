/**
 * Simple CPU Miner - Lightweight Mining Software
 * Design: John Carmack (Performance) + Rob Pike (Simple)
 * 
 * CPU mining implementation for distributed pool
 */

import * as crypto from 'crypto';
import * as os from 'os';
import { EventEmitter } from 'events';
import { createComponentLogger } from '../logging/simple-logger';

// ===== MINING TYPES =====
interface MiningJob {
  id: string;
  target: string;
  header: string;
  nonce_start: number;
  nonce_end: number;
  timestamp: number;
}

interface MiningResult {
  jobId: string;
  nonce: number;
  hash: string;
  valid: boolean;
  attempts: number;
  duration: number;
}

interface MinerStats {
  hashrate: number;
  shares: number;
  blocks: number;
  uptime: number;
  threads: number;
  efficiency: number;
}

interface MiningConfig {
  threads: number;
  intensity: number; // 1-10 scale
  algorithm: 'sha256' | 'scrypt';
  targetTime: number; // seconds per share
}

// ===== WORKER THREAD SIMULATOR =====
class MiningWorker extends EventEmitter {
  private active: boolean = false;
  private currentJob: MiningJob | null = null;
  private stats = {
    hashes: 0,
    shares: 0,
    startTime: Date.now()
  };
  private logger = createComponentLogger('MiningWorker');
  
  constructor(
    private workerId: number,
    private config: MiningConfig
  ) {
    super();
  }
  
  start(): void {
    if (this.active) return;
    
    this.active = true;
    this.stats.startTime = Date.now();
    
    this.logger.debug('Mining worker started', { workerId: this.workerId });
    
    // Start mining loop
    this.miningLoop();
  }
  
  stop(): void {
    this.active = false;
    this.logger.debug('Mining worker stopped', { workerId: this.workerId });
  }
  
  setJob(job: MiningJob): void {
    this.currentJob = job;
    this.logger.debug('New job assigned', { 
      workerId: this.workerId,
      jobId: job.id 
    });
  }
  
  private async miningLoop(): Promise<void> {
    while (this.active) {
      if (this.currentJob) {
        await this.mineJob(this.currentJob);
      } else {
        // No job, wait briefly
        await this.sleep(100);
      }
    }
  }
  
  private async mineJob(job: MiningJob): Promise<void> {
    const startTime = Date.now();
    const maxAttempts = 100000; // Batch size
    let attempts = 0;
    
    for (let nonce = job.nonce_start; nonce <= job.nonce_end && this.active; nonce++) {
      const hash = this.calculateHash(job.header, nonce);
      attempts++;
      this.stats.hashes++;
      
      // Check if hash meets target
      if (this.meetsTarget(hash, job.target)) {
        const result: MiningResult = {
          jobId: job.id,
          nonce,
          hash,
          valid: true,
          attempts,
          duration: Date.now() - startTime
        };
        
        this.stats.shares++;
        this.emit('share_found', result);
        
        this.logger.info('Share found!', { 
          workerId: this.workerId,
          nonce,
          attempts 
        });
        
        return; // Job completed
      }
      
      // Batch processing for performance
      if (attempts >= maxAttempts) {
        // Yield control and allow other operations
        await this.sleep(1);
        attempts = 0;
      }
    }
    
    // Job completed without finding share
    const result: MiningResult = {
      jobId: job.id,
      nonce: 0,
      hash: '',
      valid: false,
      attempts,
      duration: Date.now() - startTime
    };
    
    this.emit('job_completed', result);
  }
  
  private calculateHash(header: string, nonce: number): string {
    // Simple SHA-256 double hash (Bitcoin-style)
    const data = header + nonce.toString(16).padStart(8, '0');
    
    if (this.config.algorithm === 'sha256') {
      const hash1 = crypto.createHash('sha256').update(data, 'hex').digest();
      const hash2 = crypto.createHash('sha256').update(hash1).digest('hex');
      return hash2;
    } else {
      // Simplified scrypt (just SHA-256 for now)
      return crypto.createHash('sha256').update(data, 'hex').digest('hex');
    }
  }
  
  private meetsTarget(hash: string, target: string): boolean {
    // Simple target comparison (big-endian)
    return hash < target;
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  getStats(): any {
    const uptime = Date.now() - this.stats.startTime;
    const hashrate = uptime > 0 ? (this.stats.hashes * 1000) / uptime : 0;
    
    return {
      workerId: this.workerId,
      hashrate: Math.round(hashrate),
      shares: this.stats.shares,
      uptime,
      active: this.active
    };
  }
}

// ===== CPU MINER =====
class SimpleCPUMiner extends EventEmitter {
  private workers: MiningWorker[] = [];
  private active: boolean = false;
  private startTime: number = 0;
  private totalShares: number = 0;
  private totalBlocks: number = 0;
  private logger = createComponentLogger('SimpleCPUMiner');
  
  constructor(private config: MiningConfig) {
    super();
    
    // Auto-detect threads if not specified
    if (config.threads <= 0) {
      config.threads = Math.max(1, os.cpus().length - 1);
    }
    
    this.initializeWorkers();
  }
  
  private initializeWorkers(): void {
    for (let i = 0; i < this.config.threads; i++) {
      const worker = new MiningWorker(i, this.config);
      
      worker.on('share_found', (result: MiningResult) => {
        this.totalShares++;
        this.emit('share_found', result);
        
        this.logger.info('Share found by worker', { 
          workerId: i,
          shareCount: this.totalShares 
        });
      });
      
      worker.on('job_completed', (result: MiningResult) => {
        this.emit('job_completed', result);
      });
      
      this.workers.push(worker);
    }
    
    this.logger.info('Mining workers initialized', { 
      threads: this.config.threads 
    });
  }
  
  start(): void {
    if (this.active) return;
    
    this.active = true;
    this.startTime = Date.now();
    
    // Start all workers
    for (const worker of this.workers) {
      worker.start();
    }
    
    this.logger.info('CPU miner started', { 
      threads: this.config.threads,
      algorithm: this.config.algorithm 
    });
    
    this.emit('started');
  }
  
  stop(): void {
    if (!this.active) return;
    
    this.active = false;
    
    // Stop all workers
    for (const worker of this.workers) {
      worker.stop();
    }
    
    this.logger.info('CPU miner stopped');
    this.emit('stopped');
  }
  
  setJob(job: MiningJob): void {
    if (!this.active) return;
    
    // Distribute nonce ranges across workers
    const nonceRange = (job.nonce_end - job.nonce_start) / this.workers.length;
    
    for (let i = 0; i < this.workers.length; i++) {
      const workerJob: MiningJob = {
        ...job,
        nonce_start: Math.floor(job.nonce_start + (i * nonceRange)),
        nonce_end: Math.floor(job.nonce_start + ((i + 1) * nonceRange) - 1)
      };
      
      this.workers[i].setJob(workerJob);
    }
    
    this.logger.debug('Job distributed to workers', { 
      jobId: job.id,
      workers: this.workers.length 
    });
  }
  
  getStats(): MinerStats {
    const uptime = this.active ? Date.now() - this.startTime : 0;
    
    // Aggregate stats from all workers
    let totalHashrate = 0;
    let totalHashes = 0;
    
    for (const worker of this.workers) {
      const workerStats = worker.getStats();
      totalHashrate += workerStats.hashrate;
    }
    
    const efficiency = totalHashes > 0 ? (this.totalShares / totalHashes) * 100 : 0;
    
    return {
      hashrate: totalHashrate,
      shares: this.totalShares,
      blocks: this.totalBlocks,
      uptime,
      threads: this.config.threads,
      efficiency
    };
  }
  
  // Get detailed worker stats
  getWorkerStats(): any[] {
    return this.workers.map(worker => worker.getStats());
  }
  
  // Update mining configuration
  updateConfig(newConfig: Partial<MiningConfig>): void {
    Object.assign(this.config, newConfig);
    
    this.logger.info('Mining config updated', this.config);
    
    // Restart with new config if needed
    if (this.active && newConfig.threads && newConfig.threads !== this.workers.length) {
      this.stop();
      this.workers = [];
      this.initializeWorkers();
      this.start();
    }
  }
  
  isActive(): boolean {
    return this.active;
  }
}

// ===== MINING JOB GENERATOR =====
class MiningJobGenerator {
  private jobCounter: number = 0;
  private logger = createComponentLogger('MiningJobGenerator');
  
  generateJob(
    blockHeader: string = '',
    difficulty: number = 1
  ): MiningJob {
    this.jobCounter++;
    
    // Calculate target from difficulty
    const target = this.difficultyToTarget(difficulty);
    
    // Generate test block header if not provided
    if (!blockHeader) {
      blockHeader = this.generateTestHeader();
    }
    
    const job: MiningJob = {
      id: this.jobCounter.toString(16).padStart(8, '0'),
      target,
      header: blockHeader,
      nonce_start: 0,
      nonce_end: 0xFFFFFFFF, // 32-bit nonce space
      timestamp: Date.now()
    };
    
    this.logger.debug('Mining job generated', { 
      jobId: job.id,
      difficulty,
      target: target.substring(0, 16) + '...' 
    });
    
    return job;
  }
  
  private difficultyToTarget(difficulty: number): string {
    // Simplified target calculation
    const maxTarget = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
    const targetBN = BigInt('0x' + maxTarget) / BigInt(difficulty);
    return targetBN.toString(16).padStart(64, '0').toUpperCase();
  }
  
  private generateTestHeader(): string {
    // Generate a test block header (simplified)
    const version = '20000000';
    const prevHash = crypto.randomBytes(32).toString('hex');
    const merkleRoot = crypto.randomBytes(32).toString('hex');
    const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    const bits = '207fffff';
    
    return version + prevHash + merkleRoot + timestamp + bits;
  }
}

// Factory functions
export function createCPUMiner(config?: Partial<MiningConfig>): SimpleCPUMiner {
  const defaultConfig: MiningConfig = {
    threads: 0, // Auto-detect
    intensity: 5,
    algorithm: 'sha256',
    targetTime: 10
  };
  
  const finalConfig = { ...defaultConfig, ...config };
  return new SimpleCPUMiner(finalConfig);
}

export function createJobGenerator(): MiningJobGenerator {
  return new MiningJobGenerator();
}

export { 
  SimpleCPUMiner, 
  MiningWorker, 
  MiningJobGenerator,
  MiningJob, 
  MiningResult, 
  MinerStats, 
  MiningConfig 
};
