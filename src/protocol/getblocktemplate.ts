/**
 * GetBlockTemplate (GBT) Protocol Implementation
 * Following Carmack/Martin/Pike principles:
 * - Direct block template construction
 * - Decentralized mining support
 * - Efficient template updates
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

interface BlockTemplate {
  // Basic template fields
  version: number;
  previousblockhash: string;
  target: string;
  bits: string;
  height: number;
  transactions: Transaction[];
  coinbasevalue: number;
  mintime: number;
  curtime: number;
  
  // GBT specific fields
  capabilities: string[];
  mutable: string[];
  rules: string[];
  vbavailable: { [key: string]: number };
  vbrequired: number;
  
  // Mining specific
  workid?: string;
  coinbasetxn?: Transaction;
  coinbaseaux?: {
    flags: string;
  };
  
  // Long polling
  longpollid?: string;
  longpolltimeout?: number;
  expires?: number;
  
  // Additional info
  submitold?: boolean;
  sigoplimit?: number;
  sizelimit?: number;
  weightlimit?: number;
}

interface Transaction {
  data: string;
  txid?: string;
  hash?: string;
  fee?: number;
  sigops?: number;
  weight?: number;
  required?: boolean;
  depends?: number[];
}

interface GetBlockTemplateRequest {
  mode?: 'template' | 'proposal';
  capabilities: string[];
  rules?: string[];
  
  // Long polling
  longpollid?: string;
  
  // Template request options
  maxversion?: number;
  target?: string;
  
  // Data for mode='proposal'
  data?: string;
  workid?: string;
}

interface BlockProposal {
  data: string;
  workid?: string;
}

interface MiningJob {
  id: string;
  template: BlockTemplate;
  extraNonce1: Buffer;
  extraNonce2Size: number;
  cleanJobs: boolean;
  submitCount: number;
  difficulty: number;
  timestamp: number;
}

export class GetBlockTemplateProtocol extends EventEmitter {
  private rpcClient: any; // Would be actual RPC client
  private currentTemplate?: BlockTemplate;
  private miningJobs: Map<string, MiningJob> = new Map();
  private updateInterval?: NodeJS.Timer;
  private longPollTimeout?: NodeJS.Timeout;
  private capabilities: string[];
  private mutables: Set<string>;

  constructor() {
    super();
    
    // Supported capabilities
    this.capabilities = [
      'longpoll',
      'coinbasetxn',
      'coinbasevalue',
      'proposal',
      'serverlist',
      'workid',
      'segwit'
    ];
    
    // Supported mutations
    this.mutables = new Set([
      'time',
      'transactions',
      'prevblock',
      'coinbase/append',
      'version/force',
      'version/reduce'
    ]);
  }

  /**
   * Initialize GBT protocol
   */
  async initialize(rpcUrl: string, rpcUser: string, rpcPassword: string): Promise<void> {
    // Initialize RPC client
    // this.rpcClient = new RPCClient({ url: rpcUrl, user: rpcUser, pass: rpcPassword });
    
    // Get initial template
    await this.updateTemplate();
    
    // Start update loop
    this.startUpdateLoop();
    
    logger.info('GetBlockTemplate protocol initialized');
  }

  /**
   * Get block template from node
   */
  async getBlockTemplate(request?: GetBlockTemplateRequest): Promise<BlockTemplate> {
    const params = request || {
      capabilities: this.capabilities,
      rules: ['segwit']
    };

    try {
      // In real implementation, would call RPC
      // const template = await this.rpcClient.call('getblocktemplate', [params]);
      
      // For now, return mock template
      const template: BlockTemplate = {
        version: 0x20000000,
        previousblockhash: '00000000000000000001234567890abcdef1234567890abcdef1234567890ab',
        target: '00000000000000000013ce9000000000000000000000000000000000000000000',
        bits: '1703255b',
        height: 700000,
        transactions: [],
        coinbasevalue: 625000000, // 6.25 BTC
        mintime: Math.floor(Date.now() / 1000) - 600,
        curtime: Math.floor(Date.now() / 1000),
        capabilities: ['proposal'],
        mutable: ['time', 'transactions', 'prevblock'],
        rules: ['segwit'],
        vbavailable: {},
        vbrequired: 0
      };

      return template;
    } catch (err) {
      logger.error('Failed to get block template', { error: err });
      throw err;
    }
  }

  /**
   * Update current template
   */
  private async updateTemplate(): Promise<void> {
    try {
      const template = await this.getBlockTemplate();
      const previousHash = this.currentTemplate?.previousblockhash;
      
      this.currentTemplate = template;
      
      // Check if new block
      if (previousHash !== template.previousblockhash) {
        logger.info('New block detected', {
          height: template.height,
          previousHash: template.previousblockhash
        });
        
        this.emit('block:new', template);
        this.generateNewJob(true);
      } else {
        // Update existing job with new transactions
        this.generateNewJob(false);
      }
      
      // Setup long polling if supported
      if (template.longpollid) {
        this.setupLongPolling(template.longpollid, template.longpolltimeout);
      }
      
    } catch (err) {
      logger.error('Failed to update template', { error: err });
      this.emit('error', err);
    }
  }

  /**
   * Generate new mining job from template
   */
  private generateNewJob(cleanJobs: boolean): void {
    if (!this.currentTemplate) return;

    const jobId = this.generateJobId();
    const extraNonce1 = crypto.randomBytes(4);
    const extraNonce2Size = 4;
    
    const job: MiningJob = {
      id: jobId,
      template: this.currentTemplate,
      extraNonce1,
      extraNonce2Size,
      cleanJobs,
      submitCount: 0,
      difficulty: this.calculateDifficulty(this.currentTemplate.target),
      timestamp: Date.now()
    };

    this.miningJobs.set(jobId, job);
    
    // Clean old jobs if needed
    if (cleanJobs) {
      for (const [id, oldJob] of this.miningJobs) {
        if (id !== jobId) {
          this.miningJobs.delete(id);
        }
      }
    }

    this.emit('job:new', {
      jobId,
      prevHash: this.currentTemplate.previousblockhash,
      coinb1: this.buildCoinbaseTransaction(job).slice(0, -8), // Before extraNonce
      coinb2: this.buildCoinbaseTransaction(job).slice(-4), // After extraNonce
      merkleBranch: this.calculateMerkleBranch(this.currentTemplate.transactions),
      version: this.currentTemplate.version,
      nbits: this.currentTemplate.bits,
      ntime: this.currentTemplate.curtime,
      cleanJobs
    });
  }

  /**
   * Build coinbase transaction
   */
  private buildCoinbaseTransaction(job: MiningJob): Buffer {
    const template = job.template;
    
    // Build coinbase input
    const coinbaseInput = Buffer.concat([
      Buffer.alloc(32, 0), // Previous output hash (null)
      Buffer.from('ffffffff', 'hex'), // Previous output index
      this.createCoinbaseScript(template.height, job.extraNonce1),
      Buffer.from('ffffffff', 'hex') // Sequence
    ]);

    // Build coinbase outputs
    const outputs: Buffer[] = [];
    
    // Add main output (to pool address)
    outputs.push(this.createOutput(template.coinbasevalue, Buffer.from('pool_address_script', 'hex')));
    
    // Add witness commitment if segwit
    if (template.rules?.includes('segwit')) {
      const witnessCommitment = this.calculateWitnessCommitment(template.transactions);
      outputs.push(this.createOutput(0, Buffer.concat([
        Buffer.from('6a24aa21a9ed', 'hex'), // OP_RETURN + push 36 bytes + witness header
        witnessCommitment
      ])));
    }

    // Build complete transaction
    return Buffer.concat([
      Buffer.from('02000000', 'hex'), // Version
      Buffer.from([1]), // Input count
      coinbaseInput,
      Buffer.from([outputs.length]), // Output count
      ...outputs,
      Buffer.from('00000000', 'hex') // Lock time
    ]);
  }

  /**
   * Create coinbase script
   */
  private createCoinbaseScript(height: number, extraNonce1: Buffer): Buffer {
    const heightBuf = Buffer.allocUnsafe(4);
    heightBuf.writeUInt32LE(height, 0);
    
    // BIP34 height in coinbase
    const bip34Height = Buffer.concat([
      Buffer.from([3]), // Push 3 bytes
      heightBuf.slice(0, 3)
    ]);

    return Buffer.concat([
      bip34Height,
      extraNonce1,
      Buffer.from('Otedama Mining Pool', 'utf8')
    ]);
  }

  /**
   * Create transaction output
   */
  private createOutput(value: number, script: Buffer): Buffer {
    const valueBuf = Buffer.allocUnsafe(8);
    valueBuf.writeBigInt64LE(BigInt(value), 0);
    
    return Buffer.concat([
      valueBuf,
      Buffer.from([script.length]),
      script
    ]);
  }

  /**
   * Calculate merkle branch
   */
  private calculateMerkleBranch(transactions: Transaction[]): string[] {
    if (transactions.length === 0) return [];

    const hashes = transactions.map(tx => {
      const data = Buffer.from(tx.data, 'hex');
      return crypto.createHash('sha256').update(
        crypto.createHash('sha256').update(data).digest()
      ).digest();
    });

    const branch: Buffer[] = [];
    let level = hashes;

    while (level.length > 1) {
      const nextLevel: Buffer[] = [];
      
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left;
        
        if (i === 0) {
          branch.push(right);
        }
        
        const combined = Buffer.concat([left, right]);
        const hash = crypto.createHash('sha256').update(
          crypto.createHash('sha256').update(combined).digest()
        ).digest();
        
        nextLevel.push(hash);
      }
      
      level = nextLevel;
    }

    return branch.map(b => b.toString('hex'));
  }

  /**
   * Calculate witness commitment
   */
  private calculateWitnessCommitment(transactions: Transaction[]): Buffer {
    // Simplified - in reality would calculate witness root
    const witnessNonce = Buffer.alloc(32, 0);
    const witnessRoot = Buffer.alloc(32, 0);
    
    return crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(
        Buffer.concat([witnessRoot, witnessNonce])
      ).digest()
    ).digest();
  }

  /**
   * Submit block
   */
  async submitBlock(blockData: string, workId?: string): Promise<boolean> {
    try {
      // Validate block
      const block = Buffer.from(blockData, 'hex');
      const header = block.slice(0, 80);
      
      // Check proof of work
      const hash = this.reverseBuffer(
        crypto.createHash('sha256').update(
          crypto.createHash('sha256').update(header).digest()
        ).digest()
      );

      const hashBigInt = BigInt('0x' + hash.toString('hex'));
      const targetBigInt = BigInt('0x' + this.currentTemplate!.target);

      if (hashBigInt > targetBigInt) {
        logger.warn('Block does not meet target', {
          hash: hash.toString('hex'),
          target: this.currentTemplate!.target
        });
        return false;
      }

      // Submit via GBT proposal
      if (this.currentTemplate?.capabilities.includes('proposal')) {
        const proposal: BlockProposal = {
          data: blockData,
          workid: workId
        };

        const result = await this.submitProposal(proposal);
        if (result === null) {
          logger.info('Block accepted!', { hash: hash.toString('hex') });
          this.emit('block:accepted', { hash: hash.toString('hex') });
          return true;
        } else {
          logger.warn('Block rejected', { reason: result });
          return false;
        }
      } else {
        // Fallback to submitblock
        // await this.rpcClient.call('submitblock', [blockData]);
        return true;
      }
    } catch (err) {
      logger.error('Failed to submit block', { error: err });
      return false;
    }
  }

  /**
   * Submit block proposal
   */
  private async submitProposal(proposal: BlockProposal): Promise<string | null> {
    const request: GetBlockTemplateRequest = {
      mode: 'proposal',
      capabilities: this.capabilities,
      data: proposal.data,
      workid: proposal.workid
    };

    try {
      // const result = await this.rpcClient.call('getblocktemplate', [request]);
      // return result;
      return null; // Mock success
    } catch (err) {
      logger.error('Failed to submit proposal', { error: err });
      throw err;
    }
  }

  /**
   * Setup long polling
   */
  private setupLongPolling(longPollId: string, timeout?: number): void {
    // Clear existing timeout
    if (this.longPollTimeout) {
      clearTimeout(this.longPollTimeout);
    }

    const pollTimeout = timeout || 60;

    this.longPollTimeout = setTimeout(async () => {
      try {
        const template = await this.getBlockTemplate({
          capabilities: this.capabilities,
          longpollid: longPollId
        });

        if (template.previousblockhash !== this.currentTemplate?.previousblockhash) {
          this.currentTemplate = template;
          this.emit('block:new', template);
          this.generateNewJob(true);
        }

        // Setup next poll
        if (template.longpollid) {
          this.setupLongPolling(template.longpollid, template.longpolltimeout);
        }
      } catch (err) {
        logger.error('Long poll failed', { error: err });
      }
    }, pollTimeout * 1000);
  }

  /**
   * Validate share
   */
  validateShare(
    jobId: string,
    extraNonce2: string,
    nTime: string,
    nonce: string
  ): { valid: boolean; hash?: string; difficulty?: number } {
    const job = this.miningJobs.get(jobId);
    if (!job) {
      return { valid: false };
    }

    try {
      // Build block header
      const coinbase = this.buildCoinbaseWithExtraNonce(job, Buffer.from(extraNonce2, 'hex'));
      const coinbaseHash = this.sha256d(coinbase);
      const merkleRoot = this.calculateMerkleRoot(coinbaseHash, job.template.transactions);

      const header = Buffer.concat([
        this.reverseBuffer(Buffer.from(job.template.version.toString(16).padStart(8, '0'), 'hex')),
        this.reverseBuffer(Buffer.from(job.template.previousblockhash, 'hex')),
        merkleRoot,
        this.reverseBuffer(Buffer.from(nTime, 'hex')),
        this.reverseBuffer(Buffer.from(job.template.bits, 'hex')),
        this.reverseBuffer(Buffer.from(nonce, 'hex'))
      ]);

      // Calculate hash
      const hash = this.reverseBuffer(this.sha256d(header));
      const hashBigInt = BigInt('0x' + hash.toString('hex'));
      
      // Calculate share difficulty
      const difficulty = this.calculateDifficulty(hash.toString('hex'));

      // Check if valid
      const targetBigInt = BigInt('0x' + job.template.target);
      const valid = hashBigInt <= targetBigInt;

      return {
        valid,
        hash: hash.toString('hex'),
        difficulty
      };
    } catch (err) {
      logger.error('Share validation error', { error: err });
      return { valid: false };
    }
  }

  /**
   * Build coinbase with extra nonce
   */
  private buildCoinbaseWithExtraNonce(job: MiningJob, extraNonce2: Buffer): Buffer {
    const baseCoinbase = this.buildCoinbaseTransaction(job);
    // Insert extraNonce2 at the correct position
    // This is simplified - actual implementation would be more complex
    return baseCoinbase;
  }

  /**
   * Calculate merkle root
   */
  private calculateMerkleRoot(coinbaseHash: Buffer, transactions: Transaction[]): Buffer {
    const hashes = [coinbaseHash];
    
    for (const tx of transactions) {
      hashes.push(this.reverseBuffer(Buffer.from(tx.hash || tx.txid || '', 'hex')));
    }

    let level = hashes;
    while (level.length > 1) {
      const nextLevel: Buffer[] = [];
      
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left;
        const hash = this.sha256d(Buffer.concat([left, right]));
        nextLevel.push(hash);
      }
      
      level = nextLevel;
    }

    return level[0];
  }

  /**
   * Calculate difficulty from target
   */
  private calculateDifficulty(target: string): number {
    const maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
    const targetBigInt = BigInt('0x' + target);
    
    if (targetBigInt === 0n) return 0;
    
    return Number(maxTarget / targetBigInt);
  }

  /**
   * Double SHA256
   */
  private sha256d(data: Buffer): Buffer {
    return crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(data).digest()
    ).digest();
  }

  /**
   * Reverse buffer
   */
  private reverseBuffer(buffer: Buffer): Buffer {
    const reversed = Buffer.allocUnsafe(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      reversed[i] = buffer[buffer.length - 1 - i];
    }
    return reversed;
  }

  /**
   * Generate job ID
   */
  private generateJobId(): string {
    return Date.now().toString(16) + crypto.randomBytes(4).toString('hex');
  }

  /**
   * Start template update loop
   */
  private startUpdateLoop(): void {
    this.updateInterval = setInterval(() => {
      this.updateTemplate();
    }, 30000); // Update every 30 seconds
  }

  /**
   * Stop protocol
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    if (this.longPollTimeout) {
      clearTimeout(this.longPollTimeout);
    }
    
    this.miningJobs.clear();
  }

  /**
   * Get current mining jobs
   */
  getMiningJobs(): MiningJob[] {
    return Array.from(this.miningJobs.values());
  }

  /**
   * Get current template
   */
  getCurrentTemplate(): BlockTemplate | undefined {
    return this.currentTemplate;
  }
}

// Export types
export { BlockTemplate, Transaction, GetBlockTemplateRequest, MiningJob };
