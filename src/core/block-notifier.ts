// Block notification system (Carmack-style efficiency)
import { EventEmitter } from 'events';
import { createComponentLogger, PerfTimer } from '../logging/logger';
import { BlockchainClient } from './blockchain';

export interface Block {
  height: number;
  hash: string;
  previousHash: string;
  timestamp: number;
  difficulty: number;
  nonce: number;
  transactions: number;
  size: number;
  weight: number;
  merkleRoot: string;
  bits: string;
  version: number;
}

export interface BlockTemplate {
  version: number;
  previousblockhash: string;
  transactions: any[];
  coinbasevalue: number;
  target: string;
  mintime: number;
  mutable: string[];
  noncerange: string;
  sigoplimit: number;
  sizelimit: number;
  weightlimit: number;
  curtime: number;
  bits: string;
  height: number;
  default_witness_commitment?: string;
}

export class BlockNotifier extends EventEmitter {
  private logger = createComponentLogger('BlockNotifier');
  private blockchain: BlockchainClient;
  private currentBlock: Block | null = null;
  private currentTemplate: BlockTemplate | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private longPollTimeout: NodeJS.Timeout | null = null;
  private isPolling = false;
  
  constructor(
    blockchain: BlockchainClient,
    private pollIntervalMs: number = 5000  // 5 seconds default
  ) {
    super();
    this.blockchain = blockchain;
  }
  
  // Start monitoring for new blocks
  async start(): Promise<void> {
    if (this.isPolling) {
      throw new Error('Block notifier already running');
    }
    
    this.isPolling = true;
    this.logger.info('Starting block notifier', { pollInterval: this.pollIntervalMs });
    
    // Initial check
    await this.checkForNewBlock();
    
    // Start polling
    this.pollInterval = setInterval(async () => {
      try {
        await this.checkForNewBlock();
      } catch (error) {
        this.logger.error('Block check failed', error as Error);
      }
    }, this.pollIntervalMs);
  }
  
  // Stop monitoring
  stop(): void {
    this.isPolling = false;
    
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    
    if (this.longPollTimeout) {
      clearTimeout(this.longPollTimeout);
      this.longPollTimeout = null;
    }
    
    this.logger.info('Stopped block notifier');
  }
  
  // Check for new block
  private async checkForNewBlock(): Promise<void> {
    const timer = new PerfTimer();
    
    try {
      // Get current block info
      const blockchainInfo = await this.blockchain.getBlockchainInfo();
      const bestBlockHash = blockchainInfo.bestblockhash;
      
      // Check if block changed
      if (this.currentBlock && this.currentBlock.hash === bestBlockHash) {
        // No new block
        return;
      }
      
      // Get full block data
      const block = await this.blockchain.getBlock(bestBlockHash);
      
      const newBlock: Block = {
        height: block.height,
        hash: block.hash,
        previousHash: block.previousblockhash,
        timestamp: block.time,
        difficulty: block.difficulty,
        nonce: block.nonce,
        transactions: block.tx.length,
        size: block.size,
        weight: block.weight,
        merkleRoot: block.merkleroot,
        bits: block.bits,
        version: block.version
      };
      
      // Emit new block event
      const isFirstBlock = this.currentBlock === null;
      const previousBlock = this.currentBlock;
      this.currentBlock = newBlock;
      
      if (!isFirstBlock) {
        this.logger.info('New block detected', {
          height: newBlock.height,
          hash: newBlock.hash.substring(0, 16) + '...',
          previousHeight: previousBlock?.height,
          transactions: newBlock.transactions,
          timeElapsed: timer.end()
        });
        
        this.emit('block', newBlock, previousBlock);
        
        // Get new block template
        await this.updateBlockTemplate();
      } else {
        this.logger.info('Initial block loaded', {
          height: newBlock.height,
          hash: newBlock.hash.substring(0, 16) + '...'
        });
      }
      
      timer.log(this.logger, 'check_new_block');
    } catch (error) {
      this.logger.error('Failed to check for new block', error as Error);
      throw error;
    }
  }
  
  // Update block template for mining
  private async updateBlockTemplate(): Promise<void> {
    const timer = new PerfTimer();
    
    try {
      // Get new block template from Bitcoin node
      const template = await this.blockchain.getBlockTemplate();
      
      this.currentTemplate = template;
      
      this.logger.debug('Block template updated', {
        height: template.height,
        transactions: template.transactions.length,
        coinbaseValue: template.coinbasevalue,
        target: template.target.substring(0, 16) + '...'
      });
      
      // Emit template update event
      this.emit('template', template);
      
      timer.log(this.logger, 'update_block_template');
    } catch (error) {
      this.logger.error('Failed to update block template', error as Error);
      throw error;
    }
  }
  
  // Get current block
  getCurrentBlock(): Block | null {
    return this.currentBlock;
  }
  
  // Get current block template
  getCurrentTemplate(): BlockTemplate | null {
    return this.currentTemplate;
  }
  
  // Force update (useful for manual refresh)
  async forceUpdate(): Promise<void> {
    this.logger.info('Forcing block update');
    await this.checkForNewBlock();
  }
  
  // Long polling support (for future enhancement)
  async enableLongPolling(timeoutMs: number = 60000): Promise<void> {
    if (!this.blockchain.supportsLongPolling) {
      this.logger.warn('Long polling not supported by blockchain client');
      return;
    }
    
    const longPoll = async () => {
      try {
        // This would be implemented with a long-polling endpoint
        // For now, we'll simulate with a timeout
        this.longPollTimeout = setTimeout(() => {
          this.checkForNewBlock().then(() => {
            if (this.isPolling) {
              longPoll(); // Continue long polling
            }
          });
        }, timeoutMs);
      } catch (error) {
        this.logger.error('Long polling error', error as Error);
        // Fall back to regular polling
      }
    };
    
    longPoll();
  }
  
  // Statistics
  getStats(): {
    currentHeight: number | null;
    lastBlockTime: number | null;
    blocksProcessed: number;
    averageBlockTime: number | null;
  } {
    return {
      currentHeight: this.currentBlock?.height || null,
      lastBlockTime: this.currentBlock?.timestamp || null,
      blocksProcessed: this.listenerCount('block'),
      averageBlockTime: null // Would need to track history for this
    };
  }
}

// Block event aggregator for multiple sources
export class BlockEventAggregator extends EventEmitter {
  private logger = createComponentLogger('BlockEventAggregator');
  private sources = new Map<string, BlockNotifier>();
  private lastEmittedBlock: Block | null = null;
  
  // Add a block source
  addSource(name: string, notifier: BlockNotifier): void {
    if (this.sources.has(name)) {
      throw new Error(`Source ${name} already exists`);
    }
    
    this.sources.set(name, notifier);
    
    // Listen for blocks from this source
    notifier.on('block', (block: Block, previousBlock: Block | null) => {
      this.handleNewBlock(name, block, previousBlock);
    });
    
    notifier.on('template', (template: BlockTemplate) => {
      this.emit('template', template, name);
    });
    
    this.logger.info(`Added block source: ${name}`);
  }
  
  // Remove a block source
  removeSource(name: string): void {
    const notifier = this.sources.get(name);
    if (notifier) {
      notifier.removeAllListeners();
      this.sources.delete(name);
      this.logger.info(`Removed block source: ${name}`);
    }
  }
  
  // Handle new block from a source
  private handleNewBlock(source: string, block: Block, previousBlock: Block | null): void {
    // Avoid duplicate emissions
    if (this.lastEmittedBlock && this.lastEmittedBlock.hash === block.hash) {
      this.logger.debug(`Duplicate block from ${source}, ignoring`);
      return;
    }
    
    this.lastEmittedBlock = block;
    
    this.logger.info(`New block from ${source}`, {
      height: block.height,
      hash: block.hash.substring(0, 16) + '...',
      source
    });
    
    // Emit aggregated block event
    this.emit('block', block, previousBlock, source);
  }
  
  // Start all sources
  async startAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    
    for (const [name, notifier] of this.sources) {
      this.logger.info(`Starting source: ${name}`);
      promises.push(notifier.start());
    }
    
    await Promise.all(promises);
  }
  
  // Stop all sources
  stopAll(): void {
    for (const [name, notifier] of this.sources) {
      this.logger.info(`Stopping source: ${name}`);
      notifier.stop();
    }
  }
}

// Block reorganization detector
export class ReorgDetector extends EventEmitter {
  private logger = createComponentLogger('ReorgDetector');
  private blockHistory: Block[] = [];
  private maxHistory: number;
  
  constructor(maxHistory: number = 100) {
    super();
    this.maxHistory = maxHistory;
  }
  
  // Process new block
  processBlock(block: Block): void {
    // Check if this block connects to our chain
    if (this.blockHistory.length > 0) {
      const lastBlock = this.blockHistory[this.blockHistory.length - 1];
      
      if (block.previousHash !== lastBlock.hash) {
        // Potential reorganization
        this.detectReorg(block);
      }
    }
    
    // Add to history
    this.blockHistory.push(block);
    
    // Trim history
    if (this.blockHistory.length > this.maxHistory) {
      this.blockHistory.shift();
    }
  }
  
  // Detect and handle reorganization
  private detectReorg(newBlock: Block): void {
    // Find where the new block connects
    let reorgDepth = 0;
    let commonAncestor: Block | null = null;
    
    for (let i = this.blockHistory.length - 1; i >= 0; i--) {
      if (this.blockHistory[i].hash === newBlock.previousHash) {
        commonAncestor = this.blockHistory[i];
        reorgDepth = this.blockHistory.length - i - 1;
        break;
      }
    }
    
    if (reorgDepth > 0) {
      this.logger.warn('Blockchain reorganization detected', {
        depth: reorgDepth,
        newBlockHeight: newBlock.height,
        commonAncestor: commonAncestor?.height
      });
      
      // Emit reorg event
      this.emit('reorganization', {
        depth: reorgDepth,
        newTip: newBlock,
        commonAncestor,
        orphanedBlocks: this.blockHistory.slice(-reorgDepth)
      });
      
      // Update history
      this.blockHistory = this.blockHistory.slice(0, -reorgDepth);
    }
  }
  
  // Get block history
  getHistory(): Block[] {
    return [...this.blockHistory];
  }
  
  // Clear history
  clear(): void {
    this.blockHistory = [];
  }
}
