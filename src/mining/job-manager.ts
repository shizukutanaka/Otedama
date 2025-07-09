/**
 * Work Job Management System
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Manages mining jobs, work distribution, and task queuing
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { createComponentLogger } from '../logging/simple-logger';

// ===== INTERFACES =====
export interface JobTemplate {
  jobId: string;
  prevHash: string;
  coinbase1: string;
  coinbase2: string;
  merkleBranches: string[];
  version: number;
  bits: string;
  target: string;
  height: number;
  timestamp: number;
  cleanJobs?: boolean;
}

export interface MiningJob {
  id: string;
  template: JobTemplate;
  difficulty: number;
  extraNonce1: string;
  extraNonce2Size: number;
  submittedShares: Set<string>;
  createdAt: number;
  expiresAt: number;
  minerId?: string;
  status: 'pending' | 'active' | 'completed' | 'expired';
}

export interface WorkAssignment {
  jobId: string;
  minerId: string;
  difficulty: number;
  extraNonce1: string;
  extraNonce2Size: number;
  assignedAt: number;
}

export interface JobStats {
  totalJobs: number;
  activeJobs: number;
  completedJobs: number;
  expiredJobs: number;
  sharesSubmitted: number;
  duplicateShares: number;
  averageJobLifetime: number;
}

export interface JobManagerConfig {
  maxJobs?: number;
  jobTimeout?: number; // in seconds
  cleanJobsInterval?: number; // in seconds
  extraNonce1Size?: number;
  extraNonce2Size?: number;
  maxSharesPerJob?: number;
}

// ===== JOB QUEUE =====
export class JobQueue<T> {
  private queue: T[] = [];
  private processing = new Set<T>();
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  push(item: T): boolean {
    if (this.queue.length >= this.maxSize) {
      return false;
    }
    this.queue.push(item);
    return true;
  }

  pop(): T | undefined {
    const item = this.queue.shift();
    if (item) {
      this.processing.add(item);
    }
    return item;
  }

  peek(): T | undefined {
    return this.queue[0];
  }

  complete(item: T): void {
    this.processing.delete(item);
  }

  size(): number {
    return this.queue.length;
  }

  processingSize(): number {
    return this.processing.size;
  }

  clear(): void {
    this.queue = [];
    this.processing.clear();
  }

  getAll(): T[] {
    return [...this.queue];
  }
}

// ===== WORK DISTRIBUTOR =====
export class WorkDistributor extends EventEmitter {
  private assignments = new Map<string, WorkAssignment[]>(); // minerId -> assignments
  private jobAssignments = new Map<string, Set<string>>(); // jobId -> minerIds
  private logger = createComponentLogger('WorkDistributor');

  assignWork(minerId: string, job: MiningJob): WorkAssignment {
    const assignment: WorkAssignment = {
      jobId: job.id,
      minerId,
      difficulty: job.difficulty,
      extraNonce1: job.extraNonce1,
      extraNonce2Size: job.extraNonce2Size,
      assignedAt: Date.now()
    };

    // Store assignment by miner
    if (!this.assignments.has(minerId)) {
      this.assignments.set(minerId, []);
    }
    this.assignments.get(minerId)!.push(assignment);

    // Store assignment by job
    if (!this.jobAssignments.has(job.id)) {
      this.jobAssignments.set(job.id, new Set());
    }
    this.jobAssignments.get(job.id)!.add(minerId);

    this.logger.debug('Assigned work to miner', {
      minerId,
      jobId: job.id,
      difficulty: job.difficulty
    });

    this.emit('work:assigned', assignment);
    return assignment;
  }

  getAssignments(minerId: string): WorkAssignment[] {
    return this.assignments.get(minerId) || [];
  }

  getActiveAssignment(minerId: string): WorkAssignment | null {
    const assignments = this.getAssignments(minerId);
    return assignments.length > 0 ? assignments[assignments.length - 1] : null;
  }

  getMinersForJob(jobId: string): string[] {
    const minerSet = this.jobAssignments.get(jobId);
    return minerSet ? Array.from(minerSet) : [];
  }

  removeAssignmentsForJob(jobId: string): void {
    // Remove from job assignments
    const miners = this.jobAssignments.get(jobId);
    if (miners) {
      // Remove from miner assignments
      for (const minerId of miners) {
        const minerAssignments = this.assignments.get(minerId);
        if (minerAssignments) {
          const filtered = minerAssignments.filter(a => a.jobId !== jobId);
          if (filtered.length > 0) {
            this.assignments.set(minerId, filtered);
          } else {
            this.assignments.delete(minerId);
          }
        }
      }
      this.jobAssignments.delete(jobId);
    }
  }

  clearMinerAssignments(minerId: string): void {
    const assignments = this.assignments.get(minerId);
    if (assignments) {
      // Remove miner from all job assignments
      for (const assignment of assignments) {
        const jobMiners = this.jobAssignments.get(assignment.jobId);
        if (jobMiners) {
          jobMiners.delete(minerId);
          if (jobMiners.size === 0) {
            this.jobAssignments.delete(assignment.jobId);
          }
        }
      }
      this.assignments.delete(minerId);
    }
  }

  getStats(): any {
    let totalAssignments = 0;
    for (const assignments of this.assignments.values()) {
      totalAssignments += assignments.length;
    }

    return {
      totalMiners: this.assignments.size,
      totalJobs: this.jobAssignments.size,
      totalAssignments,
      avgAssignmentsPerMiner: this.assignments.size > 0 ? 
        totalAssignments / this.assignments.size : 0
    };
  }
}

// ===== JOB MANAGER =====
export class JobManager extends EventEmitter {
  private jobs = new Map<string, MiningJob>();
  private jobQueue = new JobQueue<string>();
  private distributor = new WorkDistributor();
  private config: Required<JobManagerConfig>;
  private logger = createComponentLogger('JobManager');
  private stats: JobStats = {
    totalJobs: 0,
    activeJobs: 0,
    completedJobs: 0,
    expiredJobs: 0,
    sharesSubmitted: 0,
    duplicateShares: 0,
    averageJobLifetime: 0
  };
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: JobManagerConfig = {}) {
    super();
    
    this.config = {
      maxJobs: config.maxJobs || 1000,
      jobTimeout: config.jobTimeout || 600, // 10 minutes
      cleanJobsInterval: config.cleanJobsInterval || 60, // 1 minute
      extraNonce1Size: config.extraNonce1Size || 4,
      extraNonce2Size: config.extraNonce2Size || 4,
      maxSharesPerJob: config.maxSharesPerJob || 10000
    };

    // Forward distributor events
    this.distributor.on('work:assigned', (assignment) => {
      this.emit('work:assigned', assignment);
    });

    // Start cleanup interval
    this.startCleanupInterval();
  }

  createJob(template: JobTemplate, difficulty: number, minerId?: string): MiningJob {
    const jobId = this.generateJobId();
    const extraNonce1 = this.generateExtraNonce1();

    const job: MiningJob = {
      id: jobId,
      template,
      difficulty,
      extraNonce1,
      extraNonce2Size: this.config.extraNonce2Size,
      submittedShares: new Set(),
      createdAt: Date.now(),
      expiresAt: Date.now() + (this.config.jobTimeout * 1000),
      minerId,
      status: 'pending'
    };

    // Check if we've reached max jobs
    if (this.jobs.size >= this.config.maxJobs) {
      this.cleanupExpiredJobs();
      
      if (this.jobs.size >= this.config.maxJobs) {
        // Remove oldest job
        const oldestJob = this.getOldestJob();
        if (oldestJob) {
          this.removeJob(oldestJob.id);
        }
      }
    }

    this.jobs.set(jobId, job);
    this.jobQueue.push(jobId);
    this.stats.totalJobs++;

    this.logger.info('Created new job', {
      jobId,
      height: template.height,
      difficulty,
      minerId
    });

    this.emit('job:created', job);
    return job;
  }

  getJob(jobId: string): MiningJob | null {
    return this.jobs.get(jobId) || null;
  }

  getActiveJobs(): MiningJob[] {
    return Array.from(this.jobs.values())
      .filter(job => job.status === 'active' && job.expiresAt > Date.now());
  }

  assignWork(minerId: string, preferredDifficulty?: number): MiningJob | null {
    // Try to find an existing job for this miner
    let job = this.findJobForMiner(minerId, preferredDifficulty);

    if (!job) {
      // Get next job from queue
      const jobId = this.jobQueue.pop();
      if (jobId) {
        job = this.jobs.get(jobId);
        if (job && job.expiresAt > Date.now()) {
          job.status = 'active';
          job.minerId = minerId;
          
          if (preferredDifficulty !== undefined) {
            job.difficulty = preferredDifficulty;
          }
        } else {
          // Job expired, try again
          if (job) {
            this.removeJob(job.id);
          }
          return this.assignWork(minerId, preferredDifficulty);
        }
      }
    }

    if (job) {
      const assignment = this.distributor.assignWork(minerId, job);
      this.stats.activeJobs = this.getActiveJobs().length;
      return job;
    }

    return null;
  }

  private findJobForMiner(minerId: string, difficulty?: number): MiningJob | null {
    // Find active job assigned to this miner
    for (const job of this.jobs.values()) {
      if (job.status === 'active' && 
          job.minerId === minerId && 
          job.expiresAt > Date.now() &&
          (difficulty === undefined || Math.abs(job.difficulty - difficulty) < difficulty * 0.1)) {
        return job;
      }
    }
    return null;
  }

  submitShare(jobId: string, minerId: string, nonce: string, extraNonce2: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) {
      this.logger.warn('Share submitted for unknown job', { jobId, minerId });
      return false;
    }

    if (job.expiresAt < Date.now()) {
      this.logger.warn('Share submitted for expired job', { jobId, minerId });
      return false;
    }

    // Check for duplicate share
    const shareId = `${nonce}:${extraNonce2}`;
    if (job.submittedShares.has(shareId)) {
      this.stats.duplicateShares++;
      this.logger.warn('Duplicate share submitted', { jobId, minerId, shareId });
      return false;
    }

    // Check max shares per job
    if (job.submittedShares.size >= this.config.maxSharesPerJob) {
      this.logger.warn('Max shares reached for job', { 
        jobId, 
        shares: job.submittedShares.size 
      });
      return false;
    }

    job.submittedShares.add(shareId);
    this.stats.sharesSubmitted++;

    this.emit('share:submitted', {
      jobId,
      minerId,
      nonce,
      extraNonce2,
      timestamp: Date.now()
    });

    return true;
  }

  markJobCompleted(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'completed';
      this.stats.completedJobs++;
      this.stats.activeJobs = this.getActiveJobs().length;
      
      // Update average job lifetime
      const lifetime = Date.now() - job.createdAt;
      this.stats.averageJobLifetime = 
        (this.stats.averageJobLifetime * (this.stats.completedJobs - 1) + lifetime) / 
        this.stats.completedJobs;

      this.distributor.removeAssignmentsForJob(jobId);
      
      this.logger.info('Job completed', {
        jobId,
        shares: job.submittedShares.size,
        lifetime: lifetime / 1000
      });

      this.emit('job:completed', job);
    }
  }

  removeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      if (job.status === 'active' || job.status === 'pending') {
        job.status = 'expired';
        this.stats.expiredJobs++;
      }
      
      this.jobs.delete(jobId);
      this.distributor.removeAssignmentsForJob(jobId);
      this.stats.activeJobs = this.getActiveJobs().length;

      this.emit('job:removed', job);
    }
  }

  cleanJobs(force: boolean = false): void {
    if (force) {
      // Clean all jobs for this template
      const jobs = Array.from(this.jobs.values());
      for (const job of jobs) {
        if (job.template.cleanJobs) {
          this.removeJob(job.id);
        }
      }
    }

    // Clean expired jobs
    this.cleanupExpiredJobs();
  }

  private cleanupExpiredJobs(): void {
    const now = Date.now();
    const expiredJobs = Array.from(this.jobs.values())
      .filter(job => job.expiresAt < now);

    for (const job of expiredJobs) {
      this.removeJob(job.id);
    }

    this.logger.debug('Cleaned up expired jobs', { count: expiredJobs.length });
  }

  private getOldestJob(): MiningJob | null {
    let oldest: MiningJob | null = null;
    let oldestTime = Infinity;

    for (const job of this.jobs.values()) {
      if (job.createdAt < oldestTime) {
        oldest = job;
        oldestTime = job.createdAt;
      }
    }

    return oldest;
  }

  private generateJobId(): string {
    return randomBytes(16).toString('hex');
  }

  private generateExtraNonce1(): string {
    return randomBytes(this.config.extraNonce1Size).toString('hex');
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredJobs();
    }, this.config.cleanJobsInterval * 1000);
  }

  disconnectMiner(minerId: string): void {
    this.distributor.clearMinerAssignments(minerId);
    
    // Mark jobs assigned to this miner as pending
    for (const job of this.jobs.values()) {
      if (job.minerId === minerId && job.status === 'active') {
        job.status = 'pending';
        job.minerId = undefined;
        this.jobQueue.push(job.id);
      }
    }

    this.logger.info('Disconnected miner', { minerId });
  }

  getStats(): JobStats {
    return { ...this.stats };
  }

  getDistributorStats(): any {
    return this.distributor.getStats();
  }

  getMinerJobs(minerId: string): MiningJob[] {
    const assignments = this.distributor.getAssignments(minerId);
    const jobs: MiningJob[] = [];

    for (const assignment of assignments) {
      const job = this.jobs.get(assignment.jobId);
      if (job) {
        jobs.push(job);
      }
    }

    return jobs;
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    this.jobQueue.clear();
    this.jobs.clear();
    
    this.logger.info('Job manager stopped');
  }
}

// ===== JOB VALIDATOR =====
export class JobValidator {
  static validateJobTemplate(template: JobTemplate): boolean {
    // Validate required fields
    if (!template.jobId || !template.prevHash || !template.coinbase1 || 
        !template.coinbase2 || !template.merkleBranches || !template.version ||
        !template.bits || !template.target || template.height === undefined) {
      return false;
    }

    // Validate hex strings
    const hexFields = ['prevHash', 'coinbase1', 'coinbase2', 'bits', 'target'];
    for (const field of hexFields) {
      if (!/^[0-9a-fA-F]+$/.test(template[field as keyof JobTemplate] as string)) {
        return false;
      }
    }

    // Validate merkle branches
    for (const branch of template.merkleBranches) {
      if (!/^[0-9a-fA-F]{64}$/.test(branch)) {
        return false;
      }
    }

    return true;
  }

  static calculateMerkleRoot(
    coinbase: string, 
    merkleBranches: string[]
  ): string {
    let root = coinbase;

    for (const branch of merkleBranches) {
      const combined = Buffer.concat([
        Buffer.from(root, 'hex'),
        Buffer.from(branch, 'hex')
      ]);

      root = createHash('sha256')
        .update(createHash('sha256').update(combined).digest())
        .digest('hex');
    }

    return root;
  }

  static constructCoinbase(
    template: JobTemplate,
    extraNonce1: string,
    extraNonce2: string
  ): string {
    return template.coinbase1 + extraNonce1 + extraNonce2 + template.coinbase2;
  }
}
