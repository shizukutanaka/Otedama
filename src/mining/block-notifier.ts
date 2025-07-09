// Block detection and notification system (Pike simplicity)
import { EventEmitter } from 'events';
import { BlockchainClient } from '../core/blockchain';
import { logger } from '../logging/logger';
import { Channel } from '../network/channels';

export interface Block {
  height: number;
  hash: string;
  previousHash: string;
  timestamp: number;
  difficulty: number;
  nonce: number;
  transactions: number;
}

export interface BlockTemplate {
  height: number;
  previousblockhash: string;
  transactions: any[];
  coinbasevalue: number;
  bits: string;
  target: string;
  mintime: number;
  curtime: number;
  mutable: string[];
  noncerange: string;
}

export class BlockNotifier extends EventEmitter {
  private currentTemplate: BlockTemplate | null = null;
  private lastBlockHeight = 0;
  private checkInterval: NodeJS.Timeout | null = null;
  private blockChannel: Channel<Block>;
  
  constructor(
    private blockchain: BlockchainClient,
    private pollIntervalMs: number = 5000 // 5 seconds
  ) {
    super();
    this.blockChannel = new Channel<Block>(100);
  }
  
  // Start monitoring for new blocks
  async start(): Promise<void> {
    // Get initial block height
    try {
      this.lastBlockHeight = await this.blockchain.getBlockCount();
      logger.info('block-notifier', `Starting block monitoring at height ${this.lastBlockHeight}`);
    } catch (error) {
      logger.error('block-notifier', 'Failed to get initial block height', error as Error);
      throw error;
    }
    
    // Start polling
    this.checkInterval = setInterval(() => {
      this.checkForNewBlock();
    }, this.pollIntervalMs);
    
    // Initial template fetch
    await this.updateBlockTemplate();
  }
  
  // Stop monitoring
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.blockChannel.close();
  }
  
  // Check for new blocks
  private async checkForNewBlock(): Promise<void> {
    try {
      const currentHeight = await this.blockchain.getBlockCount();
      
      if (currentHeight > this.lastBlockHeight) {
        // New block detected!
        const blockDiff = currentHeight - this.lastBlockHeight;
        
        logger.info('block-notifier', `New block detected! Height: ${currentHeight} (+${blockDiff})`);
        
        // Emit new block event
        this.emit('newBlock', {
          height: currentHeight,
          previousHeight: this.lastBlockHeight,
          timestamp: Date.now()
        });
        
        // Update last height
        this.lastBlockHeight = currentHeight;
        
        // Update block template
        await this.updateBlockTemplate();
      }
    } catch (error) {
      logger.error('block-notifier', 'Failed to check for new block', error as Error);
    }
  }
  
  // Update block template
  private async updateBlockTemplate(): Promise<void> {
    try {
      const template = await this.blockchain.getBlockTemplate();
      
      if (!this.currentTemplate || 
          template.previousblockhash !== this.currentTemplate.previousblockhash) {
        
        this.currentTemplate = template;
        
        // Emit template update
        this.emit('templateUpdate', template);
        
        logger.info('block-notifier', 'Block template updated', {
          height: template.height,
          previousHash: template.previousblockhash.substring(0, 16) + '...',
          transactions: template.transactions.length,
          coinbaseValue: template.coinbasevalue
        });
      }
    } catch (error) {
      logger.error('block-notifier', 'Failed to update block template', error as Error);
    }
  }
  
  // Get current block template
  getBlockTemplate(): BlockTemplate | null {
    return this.currentTemplate;
  }
  
  // Force template refresh
  async refreshTemplate(): Promise<BlockTemplate | null> {
    await this.updateBlockTemplate();
    return this.currentTemplate;
  }
  
  // Subscribe to block updates via channel
  getBlockChannel(): Channel<Block> {
    return this.blockChannel;
  }
}

// Job manager for distributing work
export class JobManager {
  private currentJobId: string;
  private jobs = new Map<string, {
    template: BlockTemplate;
    timestamp: number;
    submissions: number;
  }>();
  
  constructor(
    private blockNotifier: BlockNotifier,
    private jobTimeout: number = 600000 // 10 minutes
  ) {
    this.currentJobId = this.generateJobId();
    
    // Listen for new blocks
    blockNotifier.on('newBlock', () => {
      this.createNewJob();
    });
    
    blockNotifier.on('templateUpdate', (template: BlockTemplate) => {
      this.createNewJob(template);
    });
    
    // Cleanup old jobs periodically
    setInterval(() => this.cleanupOldJobs(), 60000);
  }
  
  // Create new mining job
  private createNewJob(template?: BlockTemplate): void {
    if (!template) {
      template = this.blockNotifier.getBlockTemplate();
      if (!template) return;
    }
    
    const jobId = this.generateJobId();
    
    this.jobs.set(jobId, {
      template,
      timestamp: Date.now(),
      submissions: 0
    });
    
    this.currentJobId = jobId;
    
    logger.info('job-manager', `Created new job ${jobId} for block ${template.height}`);
  }
  
  // Generate unique job ID
  private generateJobId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }
  
  // Get job by ID
  getJob(jobId: string): BlockTemplate | null {
    const job = this.jobs.get(jobId);
    return job?.template || null;
  }
  
  // Get current job
  getCurrentJob(): { jobId: string; template: BlockTemplate } | null {
    const template = this.blockNotifier.getBlockTemplate();
    if (!template) return null;
    
    return {
      jobId: this.currentJobId,
      template
    };
  }
  
  // Validate job ID
  isValidJob(jobId: string): boolean {
    return this.jobs.has(jobId);
  }
  
  // Record job submission
  recordSubmission(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.submissions++;
    }
  }
  
  // Cleanup old jobs
  private cleanupOldJobs(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    
    for (const [jobId, job] of this.jobs) {
      if (now - job.timestamp > this.jobTimeout && jobId !== this.currentJobId) {
        toDelete.push(jobId);
      }
    }
    
    for (const jobId of toDelete) {
      this.jobs.delete(jobId);
    }
    
    if (toDelete.length > 0) {
      logger.debug('job-manager', `Cleaned up ${toDelete.length} old jobs`);
    }
  }
  
  // Get job statistics
  getStats(): {
    currentJob: string;
    totalJobs: number;
    oldestJob: number;
    totalSubmissions: number;
  } {
    let oldestTimestamp = Date.now();
    let totalSubmissions = 0;
    
    for (const job of this.jobs.values()) {
      if (job.timestamp < oldestTimestamp) {
        oldestTimestamp = job.timestamp;
      }
      totalSubmissions += job.submissions;
    }
    
    return {
      currentJob: this.currentJobId,
      totalJobs: this.jobs.size,
      oldestJob: Date.now() - oldestTimestamp,
      totalSubmissions
    };
  }
}

// Block submission handler
export class BlockSubmitter {
  private submissionChannel: Channel<any>;
  private recentSubmissions = new Map<string, number>();
  
  constructor(
    private blockchain: BlockchainClient,
    private maxSubmissionsPerBlock: number = 3
  ) {
    this.submissionChannel = new Channel<any>(10);
    this.startSubmissionWorker();
  }
  
  // Queue block for submission
  async submitBlock(blockData: any, share: any): Promise<void> {
    await this.submissionChannel.send({ blockData, share });
  }
  
  // Worker to handle block submissions
  private async startSubmissionWorker(): Promise<void> {
    while (true) {
      try {
        const { blockData, share } = await this.submissionChannel.receive();
        
        // Check if we've already submitted this block
        const blockHash = this.calculateBlockHash(blockData);
        const submissions = this.recentSubmissions.get(blockHash) || 0;
        
        if (submissions >= this.maxSubmissionsPerBlock) {
          logger.warn('block-submitter', `Block ${blockHash} already submitted ${submissions} times`);
          continue;
        }
        
        // Submit block
        const success = await this.blockchain.submitBlock(share);
        
        if (success) {
          logger.info('block-submitter', `BLOCK FOUND! Hash: ${blockHash}`);
          this.recentSubmissions.set(blockHash, submissions + 1);
          
          // Cleanup old submissions after 1 hour
          setTimeout(() => {
            this.recentSubmissions.delete(blockHash);
          }, 3600000);
        }
      } catch (error) {
        logger.error('block-submitter', 'Block submission failed', error as Error);
      }
    }
  }
  
  private calculateBlockHash(blockData: any): string {
    // Simplified - real implementation would calculate actual block hash
    return blockData.toString('hex').substring(0, 16);
  }
}
