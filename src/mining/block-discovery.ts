/**
 * Block Discovery and Reward Distribution System
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Handles block discovery, validation, and reward distribution
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { createComponentLogger } from '../logging/simple-logger';
import { BlockchainClientFactory, BaseRPCClient, BlockInfo } from '../blockchain/blockchain-rpc-client';
import { PaymentProcessor, Block } from '../payment/payment-system';

// ===== INTERFACES =====
export interface BlockDiscoveryConfig {
  blockchain: 'bitcoin' | 'ethereum';
  rpcUrl: string;
  rpcUser?: string;
  rpcPassword?: string;
  confirmations: number;
  rewardMaturity?: number; // Blocks until reward is spendable (Bitcoin: 100)
  blockPollingInterval?: number; // seconds
  orphanCheckDepth?: number; // How many blocks back to check for orphans
}

export interface DiscoveredBlock {
  height: number;
  hash: string;
  previousHash: string;
  timestamp: number;
  nonce: number;
  difficulty: number;
  reward: number;
  fees: number;
  minerAddress: string;
  minerId: string;
  workerName?: string;
  shareId?: number;
  status: 'pending' | 'confirmed' | 'orphaned' | 'mature';
  confirmations: number;
  foundAt: number;
}

export interface BlockStats {
  totalBlocksFound: number;
  confirmedBlocks: number;
  orphanedBlocks: number;
  pendingBlocks: number;
  totalRewards: number;
  totalFees: number;
  averageBlockTime: number;
  lastBlockTime?: number;
  efficiency: number; // Actual vs expected blocks
}

export interface ShareSubmission {
  shareId: number;
  minerId: string;
  workerName?: string;
  jobId: string;
  nonce: string;
  extraNonce1: string;
  extraNonce2: string;
  timestamp: number;
  difficulty: number;
  hash: string;
}

// ===== BLOCK VALIDATOR =====
export class BlockValidator {
  private logger = createComponentLogger('BlockValidator');

  validateBlockHash(hash: string, target: string): boolean {
    // Convert to buffers for comparison
    const hashBuffer = Buffer.from(hash, 'hex');
    const targetBuffer = Buffer.from(target, 'hex');

    // Hash must be less than target
    for (let i = 0; i < 32; i++) {
      if (hashBuffer[i] < targetBuffer[i]) return true;
      if (hashBuffer[i] > targetBuffer[i]) return false;
    }
    return true;
  }

  calculateBlockHash(header: Buffer): string {
    // Double SHA256 for Bitcoin
    const firstHash = createHash('sha256').update(header).digest();
    const secondHash = createHash('sha256').update(firstHash).digest();
    return secondHash.reverse().toString('hex');
  }

  verifyShare(share: ShareSubmission, target: string): boolean {
    try {
      // Verify the share meets the target difficulty
      return this.validateBlockHash(share.hash, target);
    } catch (error) {
      this.logger.error('Share verification failed', error as Error);
      return false;
    }
  }

  calculateBlockReward(height: number, blockchain: string): number {
    if (blockchain === 'bitcoin') {
      // Bitcoin halving schedule
      const halvings = Math.floor(height / 210000);
      const reward = 50 / Math.pow(2, halvings);
      return reward;
    } else if (blockchain === 'ethereum') {
      // Ethereum block rewards (simplified)
      if (height < 4370000) return 5;
      else if (height < 7280000) return 3;
      else return 2;
    }
    return 0;
  }
}

// ===== BLOCK DISCOVERY MANAGER =====
export class BlockDiscoveryManager extends EventEmitter {
  private config: Required<BlockDiscoveryConfig>;
  private rpcClient: BaseRPCClient;
  private validator = new BlockValidator();
  private logger = createComponentLogger('BlockDiscovery');
  private blocks = new Map<number, DiscoveredBlock>();
  private pollingInterval?: NodeJS.Timeout;
  private stats: BlockStats = {
    totalBlocksFound: 0,
    confirmedBlocks: 0,
    orphanedBlocks: 0,
    pendingBlocks: 0,
    totalRewards: 0,
    totalFees: 0,
    averageBlockTime: 0,
    efficiency: 0
  };
  private lastCheckedHeight = 0;
  private paymentProcessor?: PaymentProcessor;

  constructor(config: BlockDiscoveryConfig) {
    super();

    this.config = {
      blockchain: config.blockchain,
      rpcUrl: config.rpcUrl,
      rpcUser: config.rpcUser || '',
      rpcPassword: config.rpcPassword || '',
      confirmations: config.confirmations,
      rewardMaturity: config.rewardMaturity || 100,
      blockPollingInterval: config.blockPollingInterval || 10,
      orphanCheckDepth: config.orphanCheckDepth || 10
    };

    // Create RPC client
    this.rpcClient = BlockchainClientFactory.create(this.config.blockchain, {
      url: this.config.rpcUrl,
      user: this.config.rpcUser,
      password: this.config.rpcPassword
    });
  }

  async start(): Promise<void> {
    try {
      // Connect to blockchain
      if (this.config.blockchain === 'bitcoin') {
        await (this.rpcClient as any).connect();
      } else if (this.config.blockchain === 'ethereum') {
        await (this.rpcClient as any).connect();
      }

      // Get current blockchain height
      const networkInfo = await this.rpcClient.getNetworkInfo();
      this.lastCheckedHeight = networkInfo.blocks;

      this.logger.info('Block discovery manager started', {
        blockchain: this.config.blockchain,
        currentHeight: this.lastCheckedHeight
      });

      // Start polling for new blocks
      this.startPolling();

      this.emit('started');
    } catch (error) {
      this.logger.error('Failed to start block discovery', error as Error);
      throw error;
    }
  }

  setPaymentProcessor(processor: PaymentProcessor): void {
    this.paymentProcessor = processor;
  }

  async submitBlock(share: ShareSubmission, blockHex: string): Promise<DiscoveredBlock | null> {
    try {
      this.logger.info('Submitting block to network', {
        shareId: share.shareId,
        minerId: share.minerId,
        hash: share.hash
      });

      // Submit block to network
      const result = await this.rpcClient.submitBlock(blockHex);

      if (result === 'accepted') {
        // Get block info from network
        const blockInfo = await this.rpcClient.getBlockByHash(share.hash);

        // Calculate reward
        const baseReward = this.validator.calculateBlockReward(
          blockInfo.height, 
          this.config.blockchain
        );

        // Create discovered block record
        const block: DiscoveredBlock = {
          height: blockInfo.height,
          hash: blockInfo.hash,
          previousHash: blockInfo.previousHash,
          timestamp: blockInfo.timestamp,
          nonce: share.nonce as any,
          difficulty: blockInfo.difficulty,
          reward: baseReward,
          fees: 0, // Will be updated when we get transaction details
          minerAddress: '', // Will be extracted from coinbase
          minerId: share.minerId,
          workerName: share.workerName,
          shareId: share.shareId,
          status: 'pending',
          confirmations: 0,
          foundAt: Date.now()
        };

        // Store block
        this.blocks.set(block.height, block);
        this.stats.totalBlocksFound++;
        this.stats.pendingBlocks++;
        this.updateAverageBlockTime();

        this.logger.info('Block found and submitted!', {
          height: block.height,
          hash: block.hash,
          reward: block.reward,
          minerId: block.minerId
        });

        this.emit('block:found', block);

        // Process payment immediately (will be unconfirmed)
        if (this.paymentProcessor) {
          await this.processBlockPayment(block);
        }

        return block;
      } else {
        this.logger.warn('Block rejected by network', {
          result,
          hash: share.hash
        });
        return null;
      }
    } catch (error) {
      this.logger.error('Failed to submit block', error as Error);
      this.emit('block:error', { share, error });
      return null;
    }
  }

  private async processBlockPayment(block: DiscoveredBlock): Promise<void> {
    if (!this.paymentProcessor) return;

    const paymentBlock: Block = {
      height: block.height,
      hash: block.hash,
      reward: block.reward,
      fees: block.fees,
      timestamp: block.timestamp,
      foundBy: block.minerId,
      confirmed: false,
      confirmations: block.confirmations
    };

    await this.paymentProcessor.processBlock(paymentBlock);
  }

  private startPolling(): void {
    this.pollingInterval = setInterval(async () => {
      await this.checkNewBlocks();
      await this.updateBlockConfirmations();
      await this.checkForOrphans();
    }, this.config.blockPollingInterval * 1000);
  }

  private async checkNewBlocks(): Promise<void> {
    try {
      const networkInfo = await this.rpcClient.getNetworkInfo();
      const currentHeight = networkInfo.blocks;

      if (currentHeight > this.lastCheckedHeight) {
        this.logger.debug('New blocks detected', {
          oldHeight: this.lastCheckedHeight,
          newHeight: currentHeight
        });

        // Check if any of our pending blocks got confirmed
        for (let height = this.lastCheckedHeight + 1; height <= currentHeight; height++) {
          const block = await this.rpcClient.getBlockByHeight(height);
          
          // Check if this is one of our blocks
          const ourBlock = this.blocks.get(height);
          if (ourBlock && ourBlock.hash === block.hash) {
            this.logger.info('Our block got included in the chain!', {
              height,
              hash: block.hash
            });
          }
        }

        this.lastCheckedHeight = currentHeight;
      }
    } catch (error) {
      this.logger.error('Error checking new blocks', error as Error);
    }
  }

  private async updateBlockConfirmations(): Promise<void> {
    try {
      const currentHeight = this.lastCheckedHeight;

      for (const [height, block] of this.blocks) {
        if (block.status === 'pending' || 
            (block.status === 'confirmed' && block.confirmations < this.config.rewardMaturity)) {
          
          const confirmations = currentHeight - height + 1;
          
          if (confirmations !== block.confirmations) {
            block.confirmations = confirmations;

            if (confirmations >= this.config.confirmations && block.status === 'pending') {
              block.status = 'confirmed';
              this.stats.pendingBlocks--;
              this.stats.confirmedBlocks++;
              
              this.logger.info('Block confirmed', {
                height: block.height,
                hash: block.hash,
                confirmations
              });

              this.emit('block:confirmed', block);

              // Update payment processor
              if (this.paymentProcessor) {
                await this.paymentProcessor.updateBlockConfirmations(
                  block.height, 
                  confirmations
                );
              }
            }

            if (confirmations >= this.config.rewardMaturity && block.status === 'confirmed') {
              block.status = 'mature';
              
              this.logger.info('Block matured', {
                height: block.height,
                hash: block.hash
              });

              this.emit('block:mature', block);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error('Error updating confirmations', error as Error);
    }
  }

  private async checkForOrphans(): Promise<void> {
    try {
      const currentHeight = this.lastCheckedHeight;
      const checkFrom = Math.max(0, currentHeight - this.config.orphanCheckDepth);

      for (const [height, block] of this.blocks) {
        if (height >= checkFrom && block.status !== 'orphaned') {
          try {
            const chainBlock = await this.rpcClient.getBlockByHeight(height);
            
            if (chainBlock.hash !== block.hash) {
              // Our block was orphaned
              block.status = 'orphaned';
              
              if (this.stats.confirmedBlocks > 0) {
                this.stats.confirmedBlocks--;
              } else if (this.stats.pendingBlocks > 0) {
                this.stats.pendingBlocks--;
              }
              
              this.stats.orphanedBlocks++;

              this.logger.warn('Block orphaned!', {
                height: block.height,
                ourHash: block.hash,
                chainHash: chainBlock.hash
              });

              this.emit('block:orphaned', block);
            }
          } catch (error) {
            // Block might not exist yet
          }
        }
      }
    } catch (error) {
      this.logger.error('Error checking for orphans', error as Error);
    }
  }

  private updateAverageBlockTime(): void {
    const blocks = Array.from(this.blocks.values())
      .filter(b => b.status === 'confirmed' || b.status === 'mature')
      .sort((a, b) => a.foundAt - b.foundAt);

    if (blocks.length < 2) return;

    let totalTime = 0;
    for (let i = 1; i < blocks.length; i++) {
      totalTime += blocks[i].foundAt - blocks[i - 1].foundAt;
    }

    this.stats.averageBlockTime = totalTime / (blocks.length - 1);
    this.stats.lastBlockTime = blocks[blocks.length - 1].foundAt;
  }

  async getBlock(height: number): Promise<DiscoveredBlock | null> {
    return this.blocks.get(height) || null;
  }

  async getRecentBlocks(limit: number = 10): Promise<DiscoveredBlock[]> {
    const blocks = Array.from(this.blocks.values())
      .sort((a, b) => b.height - a.height)
      .slice(0, limit);
    
    return blocks;
  }

  getStats(): BlockStats {
    // Calculate efficiency
    if (this.stats.averageBlockTime > 0) {
      const expectedBlockTime = this.config.blockchain === 'bitcoin' ? 600000 : 13000; // ms
      this.stats.efficiency = expectedBlockTime / this.stats.averageBlockTime;
    }

    // Update totals
    this.stats.totalRewards = Array.from(this.blocks.values())
      .filter(b => b.status === 'confirmed' || b.status === 'mature')
      .reduce((sum, b) => sum + b.reward, 0);

    this.stats.totalFees = Array.from(this.blocks.values())
      .filter(b => b.status === 'confirmed' || b.status === 'mature')
      .reduce((sum, b) => sum + b.fees, 0);

    return { ...this.stats };
  }

  async stop(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }

    this.logger.info('Block discovery manager stopped');
    this.emit('stopped');
  }

  // ===== UTILITIES =====
  async estimateNextBlockReward(): Promise<number> {
    const networkInfo = await this.rpcClient.getNetworkInfo();
    return this.validator.calculateBlockReward(
      networkInfo.blocks + 1,
      this.config.blockchain
    );
  }

  async getNetworkDifficulty(): Promise<number> {
    const networkInfo = await this.rpcClient.getNetworkInfo();
    return networkInfo.difficulty;
  }

  async getExpectedBlockTime(): Promise<number> {
    // Returns expected block time in seconds
    if (this.config.blockchain === 'bitcoin') {
      return 600; // 10 minutes
    } else if (this.config.blockchain === 'ethereum') {
      return 13; // 13 seconds average
    }
    return 600;
  }

  calculateLuck(actualBlocks: number, expectedBlocks: number): number {
    if (expectedBlocks === 0) return 0;
    return (actualBlocks / expectedBlocks) * 100;
  }
}

// ===== BLOCK NOTIFICATION SERVICE =====
export class BlockNotificationService extends EventEmitter {
  private logger = createComponentLogger('BlockNotification');
  private subscribers = new Map<string, Set<(block: DiscoveredBlock) => void>>();

  subscribe(event: string, callback: (block: DiscoveredBlock) => void): void {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Set());
    }
    this.subscribers.get(event)!.add(callback);
  }

  unsubscribe(event: string, callback: (block: DiscoveredBlock) => void): void {
    const callbacks = this.subscribers.get(event);
    if (callbacks) {
      callbacks.delete(callback);
    }
  }

  notify(event: string, block: DiscoveredBlock): void {
    const callbacks = this.subscribers.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(block);
        } catch (error) {
          this.logger.error('Notification callback error', error as Error);
        }
      }
    }

    // Also emit as event
    this.emit(event, block);
  }

  // Convenience methods for common notifications
  notifyBlockFound(block: DiscoveredBlock): void {
    this.notify('block:found', block);
    
    // Log for monitoring
    this.logger.info('🎉 BLOCK FOUND!', {
      height: block.height,
      hash: block.hash,
      reward: block.reward,
      miner: block.minerId
    });
  }

  notifyBlockConfirmed(block: DiscoveredBlock): void {
    this.notify('block:confirmed', block);
    
    this.logger.info('✅ Block confirmed', {
      height: block.height,
      confirmations: block.confirmations
    });
  }

  notifyBlockOrphaned(block: DiscoveredBlock): void {
    this.notify('block:orphaned', block);
    
    this.logger.warn('❌ Block orphaned', {
      height: block.height,
      hash: block.hash
    });
  }

  notifyBlockMature(block: DiscoveredBlock): void {
    this.notify('block:mature', block);
    
    this.logger.info('💰 Block matured and spendable', {
      height: block.height,
      reward: block.reward
    });
  }
}
