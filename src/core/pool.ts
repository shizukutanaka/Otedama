// John Carmack style: Performance-first, direct code paths
import { Share } from '../domain/share';
import { ShareValidator } from './validator';
import { BlockchainClient } from './blockchain';
import { Channel } from '../network/channels';
import { Database } from '../database/database';
import { CircuitBreaker } from '../recovery/recovery';
import { ParallelShareValidator } from '../performance/parallel-validation';

const BLOCK_REWARD = 6.25; // BTC example

export class MiningPoolCore {
  private shareChannel: Channel<Share>;
  private jobChannel: Channel<any>;
  private sharePool: SharePool;
  private running = false;
  private db: Database | null = null;
  private blockSubmitBreaker: CircuitBreaker;
  private parallelValidator?: ParallelShareValidator;
  private useParallelValidation: boolean;

  constructor(
    private validator: ShareValidator,
    private blockchain: BlockchainClient,
    config?: {
      enableParallelValidation?: boolean;
      parallelWorkers?: number;
    }
  ) {
    this.shareChannel = new Channel<Share>(10000); // Pre-sized buffer
    this.jobChannel = new Channel<any>(1000);
    this.sharePool = new SharePool();
    this.blockSubmitBreaker = new CircuitBreaker(3, 30000); // 3 failures, 30s timeout
    
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

  // Main loop - everything critical in one place
  async run(): Promise<void> {
    const db = await this.getDb();
    this.running = true;
    
    while (this.running) {
      try {
        // Handle shares directly - no abstraction
        const share = await this.shareChannel.receive();
        

        
        // Use parallel validation for high-difficulty shares if enabled
        let isValid: boolean;
        if (this.useParallelValidation && this.parallelValidator && share.difficulty > 10000) {
          isValid = await this.parallelValidator.validateShare(share);
        } else {
          // Direct validation for low-difficulty shares
          isValid = this.validator.validateDirect(share);
        }
        
        if (isValid) {
          // Save to database
          const isNew = await db.saveShare(share);
          if (!isNew) {
            console.warn(`Duplicate share rejected: ${share.getHash()}`);
            this.sharePool.release(share);
            continue;
          }
          
          // Update miner stats
          const miner = await db.getMiner(share.minerId);
          if (miner) {
            miner.submitShare();
            await db.saveMiner(miner);
          }
          
          // Check if block found
          if (share.meetsNetworkDifficulty()) {
            // Use circuit breaker for block submission
            try {
              await this.blockSubmitBreaker.execute(async () => {
                const success = await this.blockchain.submitBlock(share);
                if (success) {
                  await db.saveBlock({
                    share,
                    height: await this.blockchain.getBlockCount(),
                    reward: BLOCK_REWARD
                  });
                }
              });
            } catch (error) {
              console.error('Block submission failed:', error);
            }
          }
        }
        
        // Return share to pool for reuse
        this.sharePool.release(share);
        
        // Immediate next iteration
        setImmediate(() => {});
      } catch (error) {
        // Direct error handling - no complex error hierarchies
        console.error('Share processing error:', error);
      }
    }
  }

  async submitShare(share: Share): Promise<void> {
    await this.shareChannel.send(share);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.shareChannel.close();
    this.jobChannel.close();
    
    // Shutdown parallel validator if used
    if (this.parallelValidator) {
      await this.parallelValidator.shutdown();
    }
    
    const db = await this.getDb();
    await db.close();
  }

  // Get pool statistics
  async getStats() {
    const db = await this.getDb();
    const stats: any = {
      poolStats: await db.getPoolStats(),
      circuitBreakerState: this.blockSubmitBreaker.getState()
    };
    
    // Add parallel validation stats if enabled
    if (this.parallelValidator) {
      stats.parallelValidation = this.parallelValidator.getStats();
    }
    
    return stats;
  }
}

// Pre-allocated object pool (Carmack style)
class SharePool {
  private pool: Share[] = [];
  private index = 0;
  
  constructor(size = 10000) {
    // Pre-allocate shares
    for (let i = 0; i < size; i++) {
      this.pool.push(new Share());
    }
  }
  
  get(): Share {
    const share = this.pool[this.index++ % this.pool.length];
    share.reset(); // Clear previous data
    return share;
  }
  
  release(_share: Share): void {
    // Share automatically returns to pool via circular buffer
  }
}
