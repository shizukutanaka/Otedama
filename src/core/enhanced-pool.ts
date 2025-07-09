// Enhanced Mining Pool Core with integrated security features
import { Share } from '../domain/share';
import { ShareValidator } from './validator';
import { BlockchainClient } from './blockchain';
import { Channel } from '../network/channels';
import { Database } from '../database/database';
import { CircuitBreaker, RecoveryManager, ProcessMonitor } from '../recovery/recovery';
import { ParallelShareValidator } from '../performance/parallel-validation';
import { EnhancedShareValidator } from '../security/share-validation';
import { getLogger, createComponentLogger } from '../logging/logger';
import { EventEmitter } from 'events';

const BLOCK_REWARD = 6.25; // BTC

export interface PoolStatistics {
  validShares: number;
  invalidShares: number;
  duplicateShares: number;
  blocksFound: number;
  totalHashrate: number;
  activeMiners: number;
  uptime: number;
  lastBlockTime?: number;
}

export class EnhancedMiningPoolCore extends EventEmitter {
  private shareChannel: Channel<Share>;
  private jobChannel: Channel<any>;
  private sharePool: SharePool;
  private running = false;
  private db: Database | null = null;
  private blockSubmitBreaker: CircuitBreaker;
  private parallelValidator?: ParallelShareValidator;
  private useParallelValidation: boolean;
  private enhancedValidator: EnhancedShareValidator;
  private recoveryManager: RecoveryManager;
  private processMonitor: ProcessMonitor;
  private logger = createComponentLogger('EnhancedPoolCore');
  
  // Statistics
  private stats: PoolStatistics = {
    validShares: 0,
    invalidShares: 0,
    duplicateShares: 0,
    blocksFound: 0,
    totalHashrate: 0,
    activeMiners: 0,
    uptime: Date.now(),
    lastBlockTime: undefined
  };
  
  constructor(
    private validator: ShareValidator,
    private blockchain: BlockchainClient,
    config?: {
      enableParallelValidation?: boolean;
      parallelWorkers?: number;
      dataDir?: string;
    }
  ) {
    super();
    
    this.shareChannel = new Channel<Share>(10000);
    this.jobChannel = new Channel<any>(1000);
    this.sharePool = new SharePool();
    this.blockSubmitBreaker = new CircuitBreaker(3, 30000);
    
    // Initialize enhanced share validator with duplicate detection
    this.enhancedValidator = new EnhancedShareValidator();
    
    // Initialize recovery manager
    this.recoveryManager = new RecoveryManager(config?.dataDir || './data');
    
    // Initialize process monitor
    this.processMonitor = new ProcessMonitor(() => {
      this.logger.error('Process stalled, attempting recovery');
      this.emit('stall');
      // Attempt to recover
      this.recoverFromStall();
    });
    
    // Initialize parallel validation if enabled
    this.useParallelValidation = config?.enableParallelValidation ?? false;
    if (this.useParallelValidation) {
      this.parallelValidator = new ParallelShareValidator(validator, {
        workerCount: config?.parallelWorkers
      });
    }
  }

  private async getDb(): Promise<Database> {
    if (!this.db) {
      this.db = await Database.getInstance();
    }
    return this.db;
  }

  // Initialize and recover state
  async initialize(): Promise<void> {
    await this.recoveryManager.initialize();
    
    // Load previous state if exists
    const savedState = await this.recoveryManager.loadState();
    if (savedState) {
      this.logger.info('Recovering from saved state', {
        lastBlockHeight: savedState.lastBlockHeight,
        totalShares: savedState.totalShares
      });
      
      // Restore statistics
      this.stats.validShares = savedState.totalShares;
      
      // Emit recovery event
      this.emit('recovered', savedState);
    }
  }

  // Main processing loop with enhanced error handling
  async run(): Promise<void> {
    await this.initialize();
    
    const db = await this.getDb();
    this.running = true;
    this.processMonitor.start();
    
    this.logger.info('Enhanced mining pool core started');
    
    while (this.running) {
      try {
        // Process share with timeout
        const share = await Promise.race([
          this.shareChannel.receive(),
          this.timeout(5000) // 5 second timeout
        ]) as Share;
        
        if (!share) continue;
        
        // Update heartbeat
        this.processMonitor.heartbeat();
        
        // Process the share
        await this.processShare(share, db);
        
        // Save recovery state periodically
        await this.saveRecoveryState(db);
        
        // Immediate next iteration
        setImmediate(() => {});
      } catch (error) {
        this.logger.error('Share processing error', error as Error);
        this.emit('error', error);
        
        // Don't crash on errors, continue processing
        await this.delay(100); // Brief delay on error
      }
    }
  }

  private async processShare(share: Share, db: Database): Promise<boolean> {
    try {
      // Enhanced validation with duplicate and time checks
      const validationResult = this.enhancedValidator.validate(share);
      
      if (!validationResult.valid) {
        this.stats.invalidShares++;
        
        if (validationResult.reason === 'Duplicate share') {
          this.stats.duplicateShares++;
          this.logger.warn('Duplicate share detected', {
            minerId: share.minerId,
            hash: share.getHash().substring(0, 16) + '...'
          });
        }
        
        this.sharePool.release(share);
        return false;
      }
      
      // Validate share difficulty
      let isValid: boolean;
      if (this.useParallelValidation && this.parallelValidator && share.difficulty > 10000) {
        isValid = await this.parallelValidator.validateShare(share);
      } else {
        isValid = this.validator.validateDirect(share);
      }
      
      if (!isValid) {
        this.stats.invalidShares++;
        this.sharePool.release(share);
        return false;
      }
      
      // Save to database (double-check for duplicates)
      const saved = await db.saveShare(share);
      if (!saved) {
        this.stats.duplicateShares++;
        this.logger.warn('Database rejected duplicate share');
        this.sharePool.release(share);
        return false;
      }
      
      // Update statistics
      this.stats.validShares++;
      
      // Update miner stats
      const miner = await db.getMiner(share.minerId);
      if (miner) {
        miner.submitShare();
        await db.saveMiner(miner);
      }
      
      // Check if block found
      if (share.meetsNetworkDifficulty()) {
        await this.handleBlockFound(share, db);
      }
      
      // Return share to pool
      this.sharePool.release(share);
      
      // Emit share accepted event
      this.emit('share:accepted', share);
      
      return true;
    } catch (error) {
      this.logger.error('Error processing share', error as Error, {
        minerId: share.minerId
      });
      this.sharePool.release(share);
      return false;
    }
  }

  private async handleBlockFound(share: Share, db: Database): Promise<void> {
    this.logger.info('Block candidate found!', {
      minerId: share.minerId,
      hash: share.getHash().substring(0, 16) + '...'
    });
    
    try {
      await this.blockSubmitBreaker.execute(async () => {
        const success = await this.blockchain.submitBlock(share);
        
        if (success) {
          const blockHeight = await this.blockchain.getBlockCount();
          
          await db.saveBlock({
            hash: share.getHash(),
            height: blockHeight,
            minerId: share.minerId,
            reward: BLOCK_REWARD,
            timestamp: Date.now()
          });
          
          this.stats.blocksFound++;
          this.stats.lastBlockTime = Date.now();
          
          this.logger.info('Block accepted by network!', {
            height: blockHeight,
            reward: BLOCK_REWARD
          });
          
          // Emit block found event
          this.emit('block:found', {
            share,
            height: blockHeight,
            reward: BLOCK_REWARD
          });
        } else {
          this.logger.warn('Block rejected by network');
          this.emit('block:rejected', share);
        }
      });
    } catch (error) {
      this.logger.error('Block submission failed', error as Error);
      this.emit('block:error', error);
    }
  }

  private async saveRecoveryState(db: Database): Promise<void> {
    try {
      const poolStats = await db.getPoolStats();
      const lastBlockHeight = await db.getLatestBlockHeight();
      
      await this.recoveryManager.saveState({
        lastProcessedShare: '', // Could store last share hash if needed
        lastBlockHeight,
        timestamp: Date.now(),
        minerCount: poolStats.activeMiners,
        totalShares: poolStats.totalShares
      });
    } catch (error) {
      this.logger.error('Failed to save recovery state', error as Error);
    }
  }

  private async recoverFromStall(): Promise<void> {
    try {
      // Clear share channel
      while (this.shareChannel.pending() > 0) {
        const share = await this.shareChannel.tryReceive();
        if (share) {
          this.sharePool.release(share);
        }
      }
      
      // Reset validators
      this.enhancedValidator = new EnhancedShareValidator();
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      this.logger.info('Recovery from stall completed');
    } catch (error) {
      this.logger.error('Failed to recover from stall', error as Error);
    }
  }

  async submitShare(share: Share): Promise<boolean> {
    try {
      await this.shareChannel.send(share);
      return true;
    } catch (error) {
      this.logger.error('Failed to submit share', error as Error);
      return false;
    }
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping enhanced mining pool core');
    
    this.running = false;
    this.processMonitor.stop();
    
    // Save final state
    const db = await this.getDb();
    await this.saveRecoveryState(db);
    
    // Close channels
    this.shareChannel.close();
    this.jobChannel.close();
    
    // Shutdown validators
    if (this.parallelValidator) {
      await this.parallelValidator.shutdown();
    }
    
    // Close database
    await db.close();
    
    this.logger.info('Enhanced mining pool core stopped');
  }

  // Get comprehensive statistics
  async getStats(): Promise<any> {
    const db = await this.getDb();
    const dbStats = await db.getPoolStats();
    
    return {
      pool: {
        ...this.stats,
        uptime: Date.now() - this.stats.uptime,
        hashrate: dbStats.poolHashrate || 0
      },
      database: dbStats,
      validation: {
        enhanced: this.enhancedValidator.getStats(),
        parallel: this.parallelValidator?.getStats()
      },
      recovery: {
        circuitBreaker: this.blockSubmitBreaker.getState()
      }
    };
  }
  
  private timeout(ms: number): Promise<null> {
    return new Promise(resolve => setTimeout(() => resolve(null), ms));
  }
  
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Pre-allocated object pool for performance
class SharePool {
  private pool: Share[] = [];
  private index = 0;
  
  constructor(size = 10000) {
    for (let i = 0; i < size; i++) {
      this.pool.push(new Share());
    }
  }
  
  get(): Share {
    const share = this.pool[this.index++ % this.pool.length];
    share.reset();
    return share;
  }
  
  release(_share: Share): void {
    // Automatic via circular buffer
  }
}
