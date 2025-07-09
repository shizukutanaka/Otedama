// Block template generation (Direct implementation)
import * as crypto from 'crypto';
import { BlockchainClient } from './blockchain';

export interface BlockTemplate {
  previousBlockHash: string;
  height: number;
  version: number;
  bits: string; // Difficulty target
  curtime: number;
  transactions: Transaction[];
  coinbaseValue: number;
  coinbasePayload: string;
  merkleRoot?: string;
}

export interface Transaction {
  data: string;
  txid: string;
  hash: string;
  fee: number;
}

export interface Job {
  id: string;
  prevHash: string;
  coinbase1: string;
  coinbase2: string;
  merkleBranch: string[];
  version: string;
  nBits: string;
  nTime: string;
  cleanJobs: boolean;
  height: number;
}

export class BlockTemplateManager {
  private currentTemplate: BlockTemplate | null = null;
  private currentJob: Job | null = null;
  private extraNonce1Counter = 0;
  
  constructor(
    private blockchain: BlockchainClient,
    private poolAddress: string,
    private poolFee: number
  ) {}
  
  // Get new block template from blockchain
  async updateTemplate(): Promise<BlockTemplate> {
    const template = await this.blockchain.getBlockTemplate();
    
    this.currentTemplate = {
      previousBlockHash: template.previousblockhash,
      height: template.height,
      version: template.version,
      bits: template.bits,
      curtime: template.curtime || Math.floor(Date.now() / 1000),
      transactions: template.transactions || [],
      coinbaseValue: template.coinbasevalue,
      coinbasePayload: template.coinbasetxn?.data || ''
    };
    
    // Generate new job from template
    this.currentJob = this.createJob(this.currentTemplate);
    
    return this.currentTemplate;
  }
  
  // Create mining job from block template
  private createJob(template: BlockTemplate): Job {
    const jobId = crypto.randomBytes(4).toString('hex');
    
    // Build coinbase transaction
    const coinbase = this.buildCoinbase(template);
    
    // Calculate merkle root
    const merkleRoot = this.calculateMerkleRoot(
      [coinbase.hash, ...template.transactions.map(tx => tx.hash)]
    );
    
    // Build merkle branch for miners
    const merkleBranch = this.getMerkleBranch(
      template.transactions.map(tx => tx.hash)
    );
    
    return {
      id: jobId,
      prevHash: this.reverseHex(template.previousBlockHash),
      coinbase1: coinbase.part1,
      coinbase2: coinbase.part2,
      merkleBranch: merkleBranch,
      version: this.packInt32LE(template.version),
      nBits: this.reverseHex(template.bits),
      nTime: this.packInt32LE(template.curtime),
      cleanJobs: true,
      height: template.height
    };
  }
  
  // Build coinbase transaction
  private buildCoinbase(template: BlockTemplate): {
    hash: string,
    part1: string,
    part2: string
  } {
    // Calculate pool fee
    const poolReward = Math.floor(template.coinbaseValue * this.poolFee / 100);
    const minerReward = template.coinbaseValue - poolReward;
    
    // Coinbase input
    const coinbaseInput = Buffer.concat([
      Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'), // Prev tx hash (null)
      Buffer.from('ffffffff', 'hex'), // Prev tx index
      this.serializeVarInt(template.height), // Block height
      Buffer.from('0000000000000000', 'hex'), // Extra nonce placeholder
      Buffer.from('ffffffff', 'hex') // Sequence
    ]);
    
    // Coinbase outputs
    const outputs: Buffer[] = [];
    
    // Miner payout
    outputs.push(this.createOutput(minerReward, this.poolAddress));
    
    // Pool fee (if any)
    if (poolReward > 0) {
      outputs.push(this.createOutput(poolReward, this.poolAddress));
    }
    
    // Build transaction
    const part1 = Buffer.concat([
      Buffer.from('01000000', 'hex'), // Version
      Buffer.from('01', 'hex'), // Input count
      coinbaseInput.slice(0, -8) // Up to extra nonce
    ]).toString('hex');
    
    const part2 = Buffer.concat([
      coinbaseInput.slice(-8), // After extra nonce
      this.serializeVarInt(outputs.length),
      ...outputs,
      Buffer.from('00000000', 'hex') // Lock time
    ]).toString('hex');
    
    // Calculate hash
    const fullTx = Buffer.from(part1 + '0000000000000000' + part2, 'hex');
    const hash = this.doubleSha256(fullTx).toString('hex');
    
    return { hash, part1, part2 };
  }
  
  // Create transaction output
  private createOutput(value: number, address: string): Buffer {
    // Simplified - real implementation would decode address properly
    const scriptPubKey = this.addressToScript(address);
    
    return Buffer.concat([
      this.packInt64LE(value),
      this.serializeVarInt(scriptPubKey.length),
      scriptPubKey
    ]);
  }
  
  // Convert address to script
  private addressToScript(address: string): Buffer {
    // Simplified P2PKH script
    // Real implementation would handle different address types
    return Buffer.concat([
      Buffer.from('76a914', 'hex'), // OP_DUP OP_HASH160
      Buffer.alloc(20), // Address hash placeholder
      Buffer.from('88ac', 'hex') // OP_EQUALVERIFY OP_CHECKSIG
    ]);
  }
  
  // Calculate merkle root
  private calculateMerkleRoot(hashes: string[]): string {
    if (hashes.length === 0) return '';
    if (hashes.length === 1) return hashes[0];
    
    const tree = hashes.map(h => Buffer.from(h, 'hex'));
    
    while (tree.length > 1) {
      const newLevel: Buffer[] = [];
      
      for (let i = 0; i < tree.length; i += 2) {
        const left = tree[i];
        const right = tree[i + 1] || left;
        
        newLevel.push(this.doubleSha256(Buffer.concat([left, right])));
      }
      
      tree.splice(0, tree.length, ...newLevel);
    }
    
    return tree[0].toString('hex');
  }
  
  // Get merkle branch for stratum
  private getMerkleBranch(txHashes: string[]): string[] {
    const branch: string[] = [];
    const hashes = ['', ...txHashes]; // Coinbase placeholder
    
    let level = hashes.length;
    while (level > 1) {
      for (let i = 1; i < level; i += 2) {
        branch.push(hashes[i]);
      }
      level = Math.ceil(level / 2);
    }
    
    return branch;
  }
  
  // Get current job
  getCurrentJob(): Job | null {
    return this.currentJob;
  }
  
  // Generate unique extra nonce1 for miner
  getExtraNonce1(): string {
    this.extraNonce1Counter = (this.extraNonce1Counter + 1) % 0xFFFFFFFF;
    return this.packInt32BE(this.extraNonce1Counter);
  }
  
  // Utility functions
  private doubleSha256(data: Buffer): Buffer {
    return crypto.createHash('sha256')
      .update(crypto.createHash('sha256').update(data).digest())
      .digest();
  }
  
  private reverseHex(hex: string): string {
    return hex.match(/.{2}/g)!.reverse().join('');
  }
  
  private packInt32LE(num: number): string {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(num, 0);
    return buf.toString('hex');
  }
  
  private packInt32BE(num: number): string {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(num, 0);
    return buf.toString('hex');
  }
  
  private packInt64LE(num: number): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(num), 0);
    return buf;
  }
  
  private serializeVarInt(num: number): Buffer {
    if (num < 0xFD) {
      return Buffer.from([num]);
    } else if (num <= 0xFFFF) {
      const buf = Buffer.alloc(3);
      buf[0] = 0xFD;
      buf.writeUInt16LE(num, 1);
      return buf;
    } else {
      const buf = Buffer.alloc(5);
      buf[0] = 0xFE;
      buf.writeUInt32LE(num, 1);
      return buf;
    }
  }
}
