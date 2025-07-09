/**
 * Merge Mining Implementation
 * Following Carmack/Martin/Pike principles:
 * - Mine multiple chains simultaneously
 * - Efficient resource utilization
 * - Clean abstraction of chain-specific logic
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';

interface AuxiliaryChain {
  id: string;
  name: string;
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
  chainId: number;
  enabled: boolean;
  
  // Chain specific info
  targetBits?: string;
  height?: number;
  previousHash?: string;
  
  // Merge mining info
  merkleIndex?: number;
  merkleSize?: number;
  auxWork?: AuxiliaryWork;
}

interface AuxiliaryWork {
  hash: Buffer;
  target: Buffer;
  chainId: number;
  merkleRoot?: Buffer;
  merkleSize: number;
  merkleNonce: number;
}

interface MergedMiningJob {
  parentJobId: string;
  parentTarget: string;
  parentPrevHash: string;
  
  auxiliaryChains: Map<string, AuxiliaryWork>;
  merkleTree: MerkleNode[];
  coinbaseValue: number;
  timestamp: number;
}

interface MerkleNode {
  hash: Buffer;
  chainId?: number;
  left?: MerkleNode;
  right?: MerkleNode;
}

interface SubmitResult {
  chainId: string;
  accepted: boolean;
  hash?: string;
  error?: string;
}

export class MergeMining extends EventEmitter {
  private chains: Map<string, AuxiliaryChain> = new Map();
  private currentJob?: MergedMiningJob;
  private updateInterval?: NodeJS.Timer;
  private rpcClients: Map<string, any> = new Map();

  constructor() {
    super();
  }

  /**
   * Add auxiliary chain
   */
  addChain(chain: AuxiliaryChain): void {
    if (this.chains.has(chain.id)) {
      logger.warn('Chain already exists', { chainId: chain.id });
      return;
    }

    this.chains.set(chain.id, chain);
    
    // Initialize RPC client for chain
    // this.rpcClients.set(chain.id, new RPCClient({
    //   url: chain.rpcUrl,
    //   user: chain.rpcUser,
    //   pass: chain.rpcPassword
    // }));

    logger.info('Added auxiliary chain', { 
      chainId: chain.id, 
      name: chain.name,
      chainNumber: chain.chainId
    });
  }

  /**
   * Remove auxiliary chain
   */
  removeChain(chainId: string): void {
    if (!this.chains.has(chainId)) {
      return;
    }

    this.chains.delete(chainId);
    this.rpcClients.delete(chainId);
    
    logger.info('Removed auxiliary chain', { chainId });
  }

  /**
   * Enable/disable chain
   */
  setChainEnabled(chainId: string, enabled: boolean): void {
    const chain = this.chains.get(chainId);
    if (chain) {
      chain.enabled = enabled;
      logger.info(`Chain ${enabled ? 'enabled' : 'disabled'}`, { chainId });
    }
  }

  /**
   * Start merge mining
   */
  async start(updateInterval: number = 30000): Promise<void> {
    logger.info('Starting merge mining');
    
    // Get initial work from all chains
    await this.updateAllChains();
    
    // Start update loop
    this.updateInterval = setInterval(() => {
      this.updateAllChains();
    }, updateInterval);
    
    this.emit('started');
  }

  /**
   * Stop merge mining
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
    
    this.emit('stopped');
  }

  /**
   * Update all auxiliary chains
   */
  private async updateAllChains(): Promise<void> {
    const updates = Array.from(this.chains.values())
      .filter(chain => chain.enabled)
      .map(chain => this.updateChain(chain));

    try {
      await Promise.all(updates);
      this.generateMergedJob();
    } catch (err) {
      logger.error('Failed to update chains', { error: err });
    }
  }

  /**
   * Update single chain
   */
  private async updateChain(chain: AuxiliaryChain): Promise<void> {
    try {
      // Get aux work from chain
      // const auxWork = await this.rpcClients.get(chain.id).call('getauxblock');
      
      // Mock aux work for now
      const auxWork: AuxiliaryWork = {
        hash: crypto.randomBytes(32),
        target: Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex'),
        chainId: chain.chainId,
        merkleSize: 1,
        merkleNonce: 0
      };

      chain.auxWork = auxWork;
      chain.height = (chain.height || 0) + 1;
      
      logger.debug('Updated auxiliary chain', {
        chainId: chain.id,
        height: chain.height
      });
      
    } catch (err) {
      logger.error('Failed to update chain', { 
        chainId: chain.id, 
        error: err 
      });
      
      // Disable chain on repeated failures
      chain.enabled = false;
    }
  }

  /**
   * Generate merged mining job
   */
  private generateMergedJob(): void {
    const enabledChains = Array.from(this.chains.values())
      .filter(chain => chain.enabled && chain.auxWork);

    if (enabledChains.length === 0) {
      logger.warn('No enabled chains with work');
      return;
    }

    // Build auxiliary merkle tree
    const merkleTree = this.buildAuxiliaryMerkleTree(enabledChains);
    
    // Create job
    const job: MergedMiningJob = {
      parentJobId: crypto.randomBytes(4).toString('hex'),
      parentTarget: '00000000000000000013ce9000000000000000000000000000000000000000000',
      parentPrevHash: crypto.randomBytes(32).toString('hex'),
      auxiliaryChains: new Map(enabledChains.map(chain => [
        chain.id,
        chain.auxWork!
      ])),
      merkleTree,
      coinbaseValue: 625000000, // 6.25 BTC
      timestamp: Date.now()
    };

    this.currentJob = job;
    
    logger.info('Generated merged mining job', {
      jobId: job.parentJobId,
      chains: enabledChains.length
    });
    
    this.emit('job:new', this.formatJob(job));
  }

  /**
   * Build auxiliary merkle tree
   */
  private buildAuxiliaryMerkleTree(chains: AuxiliaryChain[]): MerkleNode[] {
    // Sort chains by ID for consistent tree building
    const sortedChains = chains.sort((a, b) => a.chainId - b.chainId);
    
    // Create leaf nodes
    const leaves: MerkleNode[] = sortedChains.map(chain => ({
      hash: chain.auxWork!.hash,
      chainId: chain.chainId
    }));

    // Pad to power of 2
    const treeSize = Math.pow(2, Math.ceil(Math.log2(leaves.length)));
    while (leaves.length < treeSize) {
      leaves.push({
        hash: Buffer.alloc(32, 0)
      });
    }

    // Build tree
    const tree = [...leaves];
    let level = leaves;
    
    while (level.length > 1) {
      const newLevel: MerkleNode[] = [];
      
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1];
        
        const parent: MerkleNode = {
          hash: this.hashNodes(left.hash, right.hash),
          left,
          right
        };
        
        newLevel.push(parent);
        tree.push(parent);
      }
      
      level = newLevel;
    }

    // Set merkle indices
    sortedChains.forEach((chain, index) => {
      chain.merkleIndex = index;
      chain.merkleSize = treeSize;
    });

    return tree;
  }

  /**
   * Hash two merkle nodes
   */
  private hashNodes(left: Buffer, right: Buffer): Buffer {
    return crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(
        Buffer.concat([left, right])
      ).digest()
    ).digest();
  }

  /**
   * Get merkle branch for chain
   */
  private getMerkleBranch(chainId: string): Buffer[] {
    if (!this.currentJob) return [];

    const chain = this.chains.get(chainId);
    if (!chain || chain.merkleIndex === undefined) return [];

    const branch: Buffer[] = [];
    const tree = this.currentJob.merkleTree;
    const leafIndex = chain.merkleIndex;
    
    // Find path from leaf to root
    let index = leafIndex;
    let levelSize = chain.merkleSize;
    
    while (levelSize > 1) {
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      
      if (siblingIndex < tree.length) {
        branch.push(tree[siblingIndex].hash);
      }
      
      index = Math.floor(index / 2);
      levelSize = Math.floor(levelSize / 2);
    }

    return branch;
  }

  /**
   * Build merged mining coinbase
   */
  buildMergedCoinbase(
    parentCoinbase: Buffer,
    parentExtraNonce: Buffer
  ): Buffer {
    if (!this.currentJob) {
      return parentCoinbase;
    }

    // Get merkle root of auxiliary chains
    const auxMerkleRoot = this.currentJob.merkleTree.length > 0
      ? this.currentJob.merkleTree[this.currentJob.merkleTree.length - 1].hash
      : Buffer.alloc(32, 0);

    // Magic bytes for merged mining
    const magicBytes = Buffer.from('fabe6d6d', 'hex');
    
    // Build merged mining data
    const mergedData = Buffer.concat([
      magicBytes,
      auxMerkleRoot,
      Buffer.alloc(4, 0), // Merkle size (filled later)
      Buffer.alloc(4, 0)  // Merkle nonce
    ]);

    // Find position to insert merged mining data
    // Usually goes in coinbase scriptSig
    const insertPosition = this.findCoinbaseInsertPosition(parentCoinbase);
    
    // Insert merged mining data
    return Buffer.concat([
      parentCoinbase.slice(0, insertPosition),
      mergedData,
      parentCoinbase.slice(insertPosition)
    ]);
  }

  /**
   * Find position to insert merged mining data in coinbase
   */
  private findCoinbaseInsertPosition(coinbase: Buffer): number {
    // Simplified - would need proper parsing
    // Usually inserted after height in scriptSig
    return 42; // Mock position
  }

  /**
   * Validate and submit share
   */
  async submitShare(
    jobId: string,
    extraNonce2: string,
    nTime: string,
    nonce: string,
    parentHash: string
  ): Promise<SubmitResult[]> {
    if (!this.currentJob || this.currentJob.parentJobId !== jobId) {
      return [{
        chainId: 'parent',
        accepted: false,
        error: 'Job not found'
      }];
    }

    const results: SubmitResult[] = [];
    
    // Check parent chain
    const parentHashBuf = Buffer.from(parentHash, 'hex');
    const parentTargetBuf = Buffer.from(this.currentJob.parentTarget, 'hex');
    
    if (this.meetsTarget(parentHashBuf, parentTargetBuf)) {
      logger.info('Parent chain block found!', { hash: parentHash });
      results.push({
        chainId: 'parent',
        accepted: true,
        hash: parentHash
      });
    }

    // Check auxiliary chains
    for (const [chainId, auxWork] of this.currentJob.auxiliaryChains) {
      const chain = this.chains.get(chainId);
      if (!chain || !chain.enabled) continue;

      // Calculate auxiliary proof of work
      const auxHash = this.calculateAuxiliaryHash(
        parentHashBuf,
        chain.merkleIndex!,
        this.getMerkleBranch(chainId),
        chain.chainId
      );

      if (this.meetsTarget(auxHash, auxWork.target)) {
        // Submit to auxiliary chain
        const submitted = await this.submitAuxiliaryBlock(
          chain,
          parentHash,
          this.getMerkleBranch(chainId)
        );

        results.push({
          chainId,
          accepted: submitted,
          hash: auxHash.toString('hex')
        });

        if (submitted) {
          logger.info('Auxiliary chain block found!', { 
            chainId: chain.name,
            hash: auxHash.toString('hex')
          });
        }
      }
    }

    return results;
  }

  /**
   * Calculate auxiliary chain hash
   */
  private calculateAuxiliaryHash(
    parentHash: Buffer,
    merkleIndex: number,
    merkleBranch: Buffer[],
    chainId: number
  ): Buffer {
    // Start with parent hash
    let hash = parentHash;
    
    // Apply merkle branch
    let index = merkleIndex;
    for (const branch of merkleBranch) {
      if (index % 2 === 0) {
        hash = this.hashNodes(hash, branch);
      } else {
        hash = this.hashNodes(branch, hash);
      }
      index = Math.floor(index / 2);
    }

    // Hash with chain ID
    const chainIdBuf = Buffer.allocUnsafe(4);
    chainIdBuf.writeUInt32LE(chainId, 0);
    
    return crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(
        Buffer.concat([hash, chainIdBuf])
      ).digest()
    ).digest();
  }

  /**
   * Check if hash meets target
   */
  private meetsTarget(hash: Buffer, target: Buffer): boolean {
    for (let i = 0; i < 32; i++) {
      if (hash[i] < target[i]) return true;
      if (hash[i] > target[i]) return false;
    }
    return true;
  }

  /**
   * Submit auxiliary block
   */
  private async submitAuxiliaryBlock(
    chain: AuxiliaryChain,
    parentHash: string,
    merkleBranch: Buffer[]
  ): Promise<boolean> {
    try {
      // const client = this.rpcClients.get(chain.id);
      // const result = await client.call('submitauxblock', [
      //   chain.auxWork!.hash.toString('hex'),
      //   parentHash,
      //   merkleBranch.map(b => b.toString('hex'))
      // ]);
      
      // Mock success
      return true;
    } catch (err) {
      logger.error('Failed to submit auxiliary block', {
        chainId: chain.id,
        error: err
      });
      return false;
    }
  }

  /**
   * Format job for miners
   */
  private formatJob(job: MergedMiningJob): any {
    return {
      jobId: job.parentJobId,
      prevHash: job.parentPrevHash,
      target: job.parentTarget,
      chains: Array.from(job.auxiliaryChains.entries()).map(([id, work]) => {
        const chain = this.chains.get(id)!;
        return {
          id,
          name: chain.name,
          chainId: chain.chainId,
          target: work.target.toString('hex')
        };
      }),
      timestamp: job.timestamp
    };
  }

  /**
   * Get current chains status
   */
  getChainsStatus(): any[] {
    return Array.from(this.chains.values()).map(chain => ({
      id: chain.id,
      name: chain.name,
      chainId: chain.chainId,
      enabled: chain.enabled,
      height: chain.height,
      hasWork: !!chain.auxWork
    }));
  }

  /**
   * Get merge mining statistics
   */
  getStatistics(): any {
    const enabledChains = Array.from(this.chains.values())
      .filter(chain => chain.enabled);

    return {
      totalChains: this.chains.size,
      enabledChains: enabledChains.length,
      currentJob: this.currentJob ? {
        jobId: this.currentJob.parentJobId,
        chains: this.currentJob.auxiliaryChains.size,
        age: Date.now() - this.currentJob.timestamp
      } : null
    };
  }
}

// Export types
export { AuxiliaryChain, AuxiliaryWork, MergedMiningJob, SubmitResult };
