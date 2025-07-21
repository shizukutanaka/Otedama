/**
 * Blockchain-based Audit Logging for Otedama
 * Immutable audit trail using blockchain technology
 * 
 * Design principles:
 * - Carmack: Efficient blockchain operations
 * - Martin: Clean blockchain architecture
 * - Pike: Simple audit logging API
 */

import { EventEmitter } from 'events';
import { createHash, createSign, createVerify, generateKeyPairSync } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { logger } from '../core/logger.js';

/**
 * Block structure for audit chain
 */
export class AuditBlock {
  constructor(data) {
    this.index = data.index || 0;
    this.timestamp = data.timestamp || Date.now();
    this.previousHash = data.previousHash || '0';
    this.data = data.data || {};
    this.nonce = data.nonce || 0;
    this.hash = data.hash || this.calculateHash();
    this.signature = data.signature || null;
  }
  
  /**
   * Calculate block hash
   */
  calculateHash() {
    const data = this.index + 
                 this.timestamp + 
                 this.previousHash + 
                 JSON.stringify(this.data) + 
                 this.nonce;
    
    return createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Mine block with proof of work
   */
  mineBlock(difficulty) {
    const target = '0'.repeat(difficulty);
    
    while (this.hash.substring(0, difficulty) !== target) {
      this.nonce++;
      this.hash = this.calculateHash();
    }
  }
  
  /**
   * Sign block
   */
  sign(privateKey) {
    const sign = createSign('SHA256');
    sign.update(this.hash);
    this.signature = sign.sign(privateKey, 'hex');
  }
  
  /**
   * Verify block signature
   */
  verifySignature(publicKey) {
    if (!this.signature) return false;
    
    const verify = createVerify('SHA256');
    verify.update(this.hash);
    
    return verify.verify(publicKey, this.signature, 'hex');
  }
  
  /**
   * Validate block integrity
   */
  isValid() {
    return this.hash === this.calculateHash();
  }
  
  /**
   * Convert to JSON
   */
  toJSON() {
    return {
      index: this.index,
      timestamp: this.timestamp,
      previousHash: this.previousHash,
      data: this.data,
      nonce: this.nonce,
      hash: this.hash,
      signature: this.signature
    };
  }
}

/**
 * Merkle tree for efficient verification
 */
export class MerkleTree {
  constructor(leaves) {
    this.leaves = leaves.map(leaf => 
      createHash('sha256').update(JSON.stringify(leaf)).digest('hex')
    );
    this.tree = this.buildTree();
  }
  
  buildTree() {
    if (this.leaves.length === 0) return [];
    
    let tree = [this.leaves];
    let currentLevel = this.leaves;
    
    while (currentLevel.length > 1) {
      const nextLevel = [];
      
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || left;
        const combined = createHash('sha256')
          .update(left + right)
          .digest('hex');
        
        nextLevel.push(combined);
      }
      
      tree.push(nextLevel);
      currentLevel = nextLevel;
    }
    
    return tree;
  }
  
  getRoot() {
    if (this.tree.length === 0) return null;
    return this.tree[this.tree.length - 1][0];
  }
  
  getProof(index) {
    if (index < 0 || index >= this.leaves.length) return null;
    
    const proof = [];
    let currentIndex = index;
    
    for (let level = 0; level < this.tree.length - 1; level++) {
      const levelSize = this.tree[level].length;
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      
      if (siblingIndex < levelSize) {
        proof.push({
          hash: this.tree[level][siblingIndex],
          position: isLeft ? 'right' : 'left'
        });
      }
      
      currentIndex = Math.floor(currentIndex / 2);
    }
    
    return proof;
  }
  
  verifyProof(leaf, proof, root) {
    let hash = createHash('sha256').update(JSON.stringify(leaf)).digest('hex');
    
    for (const node of proof) {
      const combinedHash = node.position === 'right' ?
        hash + node.hash : node.hash + hash;
      
      hash = createHash('sha256').update(combinedHash).digest('hex');
    }
    
    return hash === root;
  }
}

/**
 * Blockchain-based audit logger
 */
export class BlockchainAuditLogger extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Blockchain parameters
      difficulty: options.difficulty || 2,
      blockSize: options.blockSize || 100,
      consensusAlgorithm: options.consensusAlgorithm || 'pow', // proof of work
      
      // Security
      enableSigning: options.enableSigning !== false,
      keyPair: options.keyPair || this._generateKeyPair(),
      
      // Storage
      dataDir: options.dataDir || './data/audit-chain',
      enablePersistence: options.enablePersistence !== false,
      compactionInterval: options.compactionInterval || 3600000, // 1 hour
      
      // Performance
      batchInterval: options.batchInterval || 1000, // 1 second
      maxBatchSize: options.maxBatchSize || 1000,
      
      // Verification
      enableMerkleTree: options.enableMerkleTree !== false,
      verificationInterval: options.verificationInterval || 300000, // 5 minutes
      
      ...options
    };
    
    // Blockchain state
    this.chain = [];
    this.pendingEntries = [];
    this.currentBlock = null;
    
    // Merkle trees for each block
    this.merkleTrees = new Map();
    
    // Batch processing
    this.batchTimer = null;
    
    // Metrics
    this.metrics = {
      totalBlocks: 0,
      totalEntries: 0,
      averageBlockTime: 0,
      verificationFailures: 0
    };
    
    // Initialize
    this._initialize();
  }
  
  /**
   * Initialize blockchain
   */
  async _initialize() {
    // Create data directory
    await mkdir(this.options.dataDir, { recursive: true });
    
    // Load existing chain
    if (this.options.enablePersistence) {
      await this._loadChain();
    }
    
    // Create genesis block if needed
    if (this.chain.length === 0) {
      this._createGenesisBlock();
    }
    
    // Start batch processing
    this._startBatchProcessing();
    
    // Start verification
    if (this.options.verificationInterval > 0) {
      this._startVerification();
    }
    
    this.emit('initialized', {
      chainLength: this.chain.length,
      difficulty: this.options.difficulty
    });
  }
  
  /**
   * Generate key pair for signing
   */
  _generateKeyPair() {
    return generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });
  }
  
  /**
   * Create genesis block
   */
  _createGenesisBlock() {
    const genesis = new AuditBlock({
      index: 0,
      timestamp: Date.now(),
      previousHash: '0',
      data: {
        type: 'genesis',
        message: 'Otedama Audit Chain Genesis Block',
        version: '1.0.0'
      }
    });
    
    genesis.mineBlock(this.options.difficulty);
    
    if (this.options.enableSigning) {
      genesis.sign(this.options.keyPair.privateKey);
    }
    
    this.chain.push(genesis);
    this.metrics.totalBlocks++;
    
    logger.info('Genesis block created', {
      hash: genesis.hash,
      index: genesis.index
    });
  }
  
  /**
   * Log audit entry
   */
  async log(entry) {
    const auditEntry = {
      id: this._generateId(),
      timestamp: Date.now(),
      ...entry,
      metadata: {
        ...entry.metadata,
        source: entry.source || 'unknown',
        version: entry.version || '1.0.0'
      }
    };
    
    // Add to pending entries
    this.pendingEntries.push(auditEntry);
    this.metrics.totalEntries++;
    
    // Check if we should create a new block
    if (this.pendingEntries.length >= this.options.blockSize) {
      await this._createBlock();
    }
    
    this.emit('entry:logged', auditEntry);
    
    return {
      entryId: auditEntry.id,
      blockIndex: this.chain.length,
      pending: true
    };
  }
  
  /**
   * Batch log entries
   */
  async logBatch(entries) {
    const results = [];
    
    for (const entry of entries) {
      const result = await this.log(entry);
      results.push(result);
    }
    
    return results;
  }
  
  /**
   * Create new block
   */
  async _createBlock() {
    if (this.pendingEntries.length === 0) return;
    
    const startTime = Date.now();
    const previousBlock = this.chain[this.chain.length - 1];
    
    // Create block
    const block = new AuditBlock({
      index: this.chain.length,
      previousHash: previousBlock.hash,
      data: {
        entries: [...this.pendingEntries],
        merkleRoot: null
      }
    });
    
    // Create Merkle tree
    if (this.options.enableMerkleTree) {
      const merkleTree = new MerkleTree(this.pendingEntries);
      block.data.merkleRoot = merkleTree.getRoot();
      this.merkleTrees.set(block.index, merkleTree);
    }
    
    // Mine block
    block.mineBlock(this.options.difficulty);
    
    // Sign block
    if (this.options.enableSigning) {
      block.sign(this.options.keyPair.privateKey);
    }
    
    // Add to chain
    this.chain.push(block);
    this.metrics.totalBlocks++;
    
    // Update average block time
    const blockTime = Date.now() - startTime;
    this.metrics.averageBlockTime = 
      (this.metrics.averageBlockTime * (this.chain.length - 1) + blockTime) / 
      this.chain.length;
    
    // Clear pending entries
    this.pendingEntries = [];
    
    // Persist if enabled
    if (this.options.enablePersistence) {
      await this._saveBlock(block);
    }
    
    this.emit('block:created', {
      block: block.toJSON(),
      miningTime: blockTime,
      entriesCount: block.data.entries.length
    });
    
    logger.info('New block created', {
      index: block.index,
      hash: block.hash,
      entries: block.data.entries.length,
      miningTime: `${blockTime}ms`
    });
  }
  
  /**
   * Query audit logs
   */
  async query(criteria = {}) {
    const results = [];
    
    // Search through blocks
    for (const block of this.chain) {
      if (block.data.entries) {
        for (const entry of block.data.entries) {
          if (this._matchesCriteria(entry, criteria)) {
            results.push({
              ...entry,
              blockIndex: block.index,
              blockHash: block.hash,
              blockTimestamp: block.timestamp
            });
          }
        }
      }
    }
    
    // Search pending entries
    for (const entry of this.pendingEntries) {
      if (this._matchesCriteria(entry, criteria)) {
        results.push({
          ...entry,
          blockIndex: null,
          blockHash: null,
          pending: true
        });
      }
    }
    
    return results;
  }
  
  /**
   * Verify entry existence
   */
  async verifyEntry(entryId, blockIndex = null) {
    // Search in specific block
    if (blockIndex !== null) {
      const block = this.chain[blockIndex];
      if (!block) return { exists: false };
      
      const entry = block.data.entries?.find(e => e.id === entryId);
      if (!entry) return { exists: false };
      
      // Verify with Merkle proof
      if (this.options.enableMerkleTree) {
        const merkleTree = this.merkleTrees.get(blockIndex);
        if (merkleTree) {
          const entryIndex = block.data.entries.indexOf(entry);
          const proof = merkleTree.getProof(entryIndex);
          const verified = merkleTree.verifyProof(
            entry,
            proof,
            block.data.merkleRoot
          );
          
          return {
            exists: true,
            verified,
            block: {
              index: block.index,
              hash: block.hash,
              timestamp: block.timestamp
            },
            merkleProof: proof
          };
        }
      }
      
      return {
        exists: true,
        block: {
          index: block.index,
          hash: block.hash,
          timestamp: block.timestamp
        }
      };
    }
    
    // Search all blocks
    for (const block of this.chain) {
      if (block.data.entries) {
        const exists = block.data.entries.some(e => e.id === entryId);
        if (exists) {
          return this.verifyEntry(entryId, block.index);
        }
      }
    }
    
    // Check pending
    const pending = this.pendingEntries.find(e => e.id === entryId);
    if (pending) {
      return {
        exists: true,
        pending: true,
        entry: pending
      };
    }
    
    return { exists: false };
  }
  
  /**
   * Verify blockchain integrity
   */
  async verifyChain() {
    const errors = [];
    
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];
      
      // Verify block hash
      if (!currentBlock.isValid()) {
        errors.push({
          blockIndex: i,
          error: 'Invalid block hash'
        });
      }
      
      // Verify chain linkage
      if (currentBlock.previousHash !== previousBlock.hash) {
        errors.push({
          blockIndex: i,
          error: 'Broken chain link'
        });
      }
      
      // Verify signature
      if (this.options.enableSigning && currentBlock.signature) {
        if (!currentBlock.verifySignature(this.options.keyPair.publicKey)) {
          errors.push({
            blockIndex: i,
            error: 'Invalid signature'
          });
        }
      }
      
      // Verify Merkle root
      if (this.options.enableMerkleTree && currentBlock.data.merkleRoot) {
        const merkleTree = new MerkleTree(currentBlock.data.entries || []);
        if (merkleTree.getRoot() !== currentBlock.data.merkleRoot) {
          errors.push({
            blockIndex: i,
            error: 'Invalid Merkle root'
          });
        }
      }
    }
    
    const isValid = errors.length === 0;
    
    if (!isValid) {
      this.metrics.verificationFailures++;
    }
    
    this.emit('chain:verified', {
      valid: isValid,
      errors,
      chainLength: this.chain.length
    });
    
    return {
      valid: isValid,
      errors,
      blocksVerified: this.chain.length,
      timestamp: Date.now()
    };
  }
  
  /**
   * Export chain data
   */
  async exportChain(format = 'json') {
    const data = {
      version: '1.0.0',
      exported: new Date().toISOString(),
      chainLength: this.chain.length,
      difficulty: this.options.difficulty,
      publicKey: this.options.keyPair.publicKey,
      blocks: this.chain.map(block => block.toJSON()),
      metrics: this.metrics
    };
    
    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    }
    
    // Add more export formats as needed
    throw new Error(`Unsupported export format: ${format}`);
  }
  
  /**
   * Import chain data
   */
  async importChain(data, verify = true) {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    
    // Create blocks from data
    const blocks = parsed.blocks.map(blockData => new AuditBlock(blockData));
    
    // Verify if requested
    if (verify) {
      // Store current chain
      const originalChain = this.chain;
      this.chain = blocks;
      
      const verification = await this.verifyChain();
      
      if (!verification.valid) {
        // Restore original chain
        this.chain = originalChain;
        throw new Error('Invalid chain data');
      }
    }
    
    // Replace chain
    this.chain = blocks;
    this.metrics = parsed.metrics || this.metrics;
    
    // Rebuild Merkle trees
    if (this.options.enableMerkleTree) {
      this.merkleTrees.clear();
      
      for (const block of this.chain) {
        if (block.data.entries && block.data.merkleRoot) {
          const merkleTree = new MerkleTree(block.data.entries);
          this.merkleTrees.set(block.index, merkleTree);
        }
      }
    }
    
    this.emit('chain:imported', {
      blocksImported: blocks.length,
      verified: verify
    });
    
    return {
      success: true,
      blocksImported: blocks.length
    };
  }
  
  /**
   * Get chain statistics
   */
  getStatistics() {
    const totalEntries = this.chain.reduce((sum, block) => 
      sum + (block.data.entries?.length || 0), 0
    ) + this.pendingEntries.length;
    
    return {
      chainLength: this.chain.length,
      totalEntries,
      pendingEntries: this.pendingEntries.length,
      averageBlockSize: this.chain.length > 0 ? 
        totalEntries / this.chain.length : 0,
      averageBlockTime: this.metrics.averageBlockTime,
      difficulty: this.options.difficulty,
      verificationFailures: this.metrics.verificationFailures,
      lastBlockHash: this.chain.length > 0 ? 
        this.chain[this.chain.length - 1].hash : null,
      lastBlockTime: this.chain.length > 0 ?
        this.chain[this.chain.length - 1].timestamp : null
    };
  }
  
  /**
   * Private helper methods
   */
  _generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  _matchesCriteria(entry, criteria) {
    for (const [key, value] of Object.entries(criteria)) {
      if (key === 'startTime' && entry.timestamp < value) return false;
      if (key === 'endTime' && entry.timestamp > value) return false;
      if (key === 'type' && entry.type !== value) return false;
      if (key === 'action' && entry.action !== value) return false;
      if (key === 'userId' && entry.userId !== value) return false;
      if (key === 'search' && !JSON.stringify(entry).includes(value)) return false;
    }
    
    return true;
  }
  
  async _loadChain() {
    try {
      const files = await readFile(
        join(this.options.dataDir, 'chain.json'),
        'utf8'
      );
      
      const data = JSON.parse(files);
      await this.importChain(data, true);
      
      logger.info('Blockchain loaded from disk', {
        blocks: this.chain.length
      });
    } catch (error) {
      // No existing chain
      logger.info('No existing blockchain found, starting fresh');
    }
  }
  
  async _saveBlock(block) {
    try {
      // Save entire chain (simple approach)
      const chainData = await this.exportChain();
      
      await writeFile(
        join(this.options.dataDir, 'chain.json'),
        chainData
      );
      
      // Save individual block
      await writeFile(
        join(this.options.dataDir, `block-${block.index}.json`),
        JSON.stringify(block.toJSON(), null, 2)
      );
    } catch (error) {
      logger.error('Failed to save block', error);
    }
  }
  
  _startBatchProcessing() {
    this.batchTimer = setInterval(async () => {
      if (this.pendingEntries.length > 0) {
        await this._createBlock();
      }
    }, this.options.batchInterval);
  }
  
  _startVerification() {
    setInterval(async () => {
      const result = await this.verifyChain();
      
      if (!result.valid) {
        logger.error('Blockchain verification failed', result.errors);
      }
    }, this.options.verificationInterval);
  }
  
  /**
   * Cleanup
   */
  async destroy() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }
    
    // Save final state
    if (this.options.enablePersistence && this.chain.length > 0) {
      await this._saveBlock(this.chain[this.chain.length - 1]);
    }
    
    this.emit('destroyed');
  }
}

export default BlockchainAuditLogger;