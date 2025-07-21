/**
 * Immutable Audit Logs with Cryptographic Proof Chains
 * Tamper-proof audit logging system for enterprise security
 * Uses hash chains and merkle trees for verifiability
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getLogger } from '../core/logger.js';
import { HSMManager } from './hsm-integration.js';

// Log entry types
export const LogEntryType = {
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  TRANSACTION: 'transaction',
  DATA_ACCESS: 'data_access',
  DATA_MODIFICATION: 'data_modification',
  CONFIGURATION_CHANGE: 'configuration_change',
  SECURITY_EVENT: 'security_event',
  ERROR: 'error',
  SYSTEM_EVENT: 'system_event'
};

// Log severity levels
export const LogSeverity = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4,
  SECURITY: 5
};

/**
 * Immutable Audit Log Manager
 */
export class ImmutableAuditLog extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = getLogger('ImmutableAuditLog');
    this.options = {
      storageBackend: options.storageBackend || 'memory', // memory, file, database, blockchain
      hashAlgorithm: options.hashAlgorithm || 'sha256',
      signLogs: options.signLogs !== false,
      hsmEnabled: options.hsmEnabled || false,
      merkleTreeInterval: options.merkleTreeInterval || 1000, // Create merkle tree every N entries
      timestampingAuthority: options.timestampingAuthority || null,
      replicationTargets: options.replicationTargets || [],
      compressionEnabled: options.compressionEnabled || true,
      encryptionEnabled: options.encryptionEnabled || true,
      retentionDays: options.retentionDays || 2555, // 7 years default
      ...options
    };
    
    // Initialize HSM if enabled
    if (this.options.hsmEnabled) {
      this.hsm = new HSMManager({
        provider: options.hsmProvider || 'software_hsm'
      });
    }
    
    // Log chain state
    this.chain = {
      entries: [],
      currentHash: this.genesisHash(),
      blockHeight: 0,
      merkleRoots: [],
      checkpoints: []
    };
    
    // Pending entries buffer
    this.pendingEntries = [];
    
    // Verification cache
    this.verificationCache = new Map();
    
    // Statistics
    this.stats = {
      totalEntries: 0,
      totalBlocks: 0,
      totalMerkleRoots: 0,
      verificationsPerformed: 0,
      storageSize: 0,
      compressionRatio: 1.0
    };
    
    // Initialize storage
    this.initializeStorage();
    
    // Start periodic tasks
    this.startPeriodicTasks();
  }
  
  /**
   * Initialize audit log system
   */
  async initialize() {
    this.logger.info('Initializing immutable audit log system...');
    
    if (this.hsm) {
      await this.hsm.initialize();
      await this.hsm.unlock(this.options.hsmCredentials);
      
      // Generate signing key if not exists
      this.signingKeyId = await this.hsm.generateKey(
        'signing',
        'ecdsa-p256',
        { persistent: true }
      );
    }
    
    // Load existing chain if available
    await this.loadChain();
    
    this.emit('initialized');
  }
  
  /**
   * Log an entry
   */
  async log(type, severity, message, metadata = {}) {
    const entry = {
      id: crypto.randomBytes(16).toString('hex'),
      timestamp: Date.now(),
      nanoTime: process.hrtime.bigint().toString(),
      type,
      severity,
      message,
      metadata,
      source: this.getSource(),
      sessionId: metadata.sessionId || null,
      userId: metadata.userId || null,
      ipAddress: metadata.ipAddress || null
    };
    
    // Add to pending entries
    this.pendingEntries.push(entry);
    
    // Process immediately if critical
    if (severity >= LogSeverity.ERROR) {
      await this.processEntries();
    }
    
    return entry.id;
  }
  
  /**
   * Process pending entries
   */
  async processEntries() {
    if (this.pendingEntries.length === 0) return;
    
    const entriesToProcess = [...this.pendingEntries];
    this.pendingEntries = [];
    
    for (const entry of entriesToProcess) {
      await this.addEntry(entry);
    }
    
    // Create merkle tree if threshold reached
    if (this.chain.entries.length % this.options.merkleTreeInterval === 0) {
      await this.createMerkleRoot();
    }
  }
  
  /**
   * Add entry to chain
   */
  async addEntry(entry) {
    // Calculate entry hash
    entry.previousHash = this.chain.currentHash;
    entry.index = this.chain.entries.length;
    entry.hash = this.calculateEntryHash(entry);
    
    // Sign entry if enabled
    if (this.options.signLogs && this.hsm) {
      entry.signature = await this.signEntry(entry);
    }
    
    // Add timestamp proof if authority configured
    if (this.options.timestampingAuthority) {
      entry.timestampProof = await this.getTimestampProof(entry);
    }
    
    // Encrypt sensitive data if enabled
    if (this.options.encryptionEnabled) {
      entry.encryptedMetadata = await this.encryptMetadata(entry.metadata);
      entry.metadata = { encrypted: true };
    }
    
    // Add to chain
    this.chain.entries.push(entry);
    this.chain.currentHash = entry.hash;
    this.stats.totalEntries++;
    
    // Persist to storage
    await this.persistEntry(entry);
    
    // Replicate to targets
    await this.replicateEntry(entry);
    
    this.emit('entry:added', {
      id: entry.id,
      type: entry.type,
      severity: entry.severity,
      hash: entry.hash
    });
  }
  
  /**
   * Create merkle root for entries
   */
  async createMerkleRoot() {
    const startIndex = this.chain.merkleRoots.length * this.options.merkleTreeInterval;
    const endIndex = startIndex + this.options.merkleTreeInterval;
    const entries = this.chain.entries.slice(startIndex, endIndex);
    
    if (entries.length === 0) return;
    
    // Build merkle tree
    const leaves = entries.map(entry => entry.hash);
    const tree = this.buildMerkleTree(leaves);
    const root = tree[tree.length - 1][0];
    
    const merkleRoot = {
      index: this.chain.merkleRoots.length,
      root,
      startIndex,
      endIndex,
      timestamp: Date.now(),
      tree,
      previousRoot: this.chain.merkleRoots.length > 0 
        ? this.chain.merkleRoots[this.chain.merkleRoots.length - 1].root 
        : null
    };
    
    // Sign merkle root
    if (this.options.signLogs && this.hsm) {
      merkleRoot.signature = await this.signMerkleRoot(merkleRoot);
    }
    
    this.chain.merkleRoots.push(merkleRoot);
    this.stats.totalMerkleRoots++;
    
    // Create checkpoint
    await this.createCheckpoint(merkleRoot);
    
    this.emit('merkle:created', {
      index: merkleRoot.index,
      root: merkleRoot.root,
      entries: entries.length
    });
  }
  
  /**
   * Build merkle tree
   */
  buildMerkleTree(leaves) {
    if (leaves.length === 0) return [];
    
    const tree = [leaves];
    
    while (tree[tree.length - 1].length > 1) {
      const currentLevel = tree[tree.length - 1];
      const nextLevel = [];
      
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1] || left;
        const combined = this.hash(left + right);
        nextLevel.push(combined);
      }
      
      tree.push(nextLevel);
    }
    
    return tree;
  }
  
  /**
   * Verify entry integrity
   */
  async verifyEntry(entryId) {
    const entry = this.chain.entries.find(e => e.id === entryId);
    if (!entry) {
      throw new Error('Entry not found');
    }
    
    // Check hash
    const calculatedHash = this.calculateEntryHash(entry);
    if (calculatedHash !== entry.hash) {
      return {
        valid: false,
        reason: 'Hash mismatch'
      };
    }
    
    // Check signature if present
    if (entry.signature) {
      const signatureValid = await this.verifyEntrySignature(entry);
      if (!signatureValid) {
        return {
          valid: false,
          reason: 'Invalid signature'
        };
      }
    }
    
    // Check chain integrity
    if (entry.index > 0) {
      const previousEntry = this.chain.entries[entry.index - 1];
      if (entry.previousHash !== previousEntry.hash) {
        return {
          valid: false,
          reason: 'Chain broken'
        };
      }
    }
    
    this.stats.verificationsPerformed++;
    
    return {
      valid: true,
      hash: entry.hash,
      index: entry.index
    };
  }
  
  /**
   * Verify entire chain integrity
   */
  async verifyChain(startIndex = 0, endIndex = null) {
    const end = endIndex || this.chain.entries.length;
    
    for (let i = startIndex; i < end; i++) {
      const entry = this.chain.entries[i];
      const result = await this.verifyEntry(entry.id);
      
      if (!result.valid) {
        return {
          valid: false,
          failedAt: i,
          entry: entry.id,
          reason: result.reason
        };
      }
    }
    
    // Verify merkle roots
    for (const merkleRoot of this.chain.merkleRoots) {
      const verified = await this.verifyMerkleRoot(merkleRoot);
      if (!verified) {
        return {
          valid: false,
          reason: 'Invalid merkle root',
          merkleIndex: merkleRoot.index
        };
      }
    }
    
    return {
      valid: true,
      entriesVerified: end - startIndex,
      merkleRootsVerified: this.chain.merkleRoots.length
    };
  }
  
  /**
   * Verify merkle root
   */
  async verifyMerkleRoot(merkleRoot) {
    const entries = this.chain.entries.slice(
      merkleRoot.startIndex,
      merkleRoot.endIndex
    );
    
    const leaves = entries.map(entry => entry.hash);
    const tree = this.buildMerkleTree(leaves);
    const calculatedRoot = tree[tree.length - 1][0];
    
    return calculatedRoot === merkleRoot.root;
  }
  
  /**
   * Generate merkle proof for entry
   */
  generateMerkleProof(entryId) {
    const entry = this.chain.entries.find(e => e.id === entryId);
    if (!entry) {
      throw new Error('Entry not found');
    }
    
    // Find merkle root containing this entry
    const merkleRootIndex = Math.floor(entry.index / this.options.merkleTreeInterval);
    const merkleRoot = this.chain.merkleRoots[merkleRootIndex];
    
    if (!merkleRoot) {
      throw new Error('Merkle root not found');
    }
    
    // Generate proof path
    const proof = {
      entryId,
      entryHash: entry.hash,
      merkleRoot: merkleRoot.root,
      path: []
    };
    
    // Build proof path
    const leafIndex = entry.index % this.options.merkleTreeInterval;
    let currentIndex = leafIndex;
    
    for (let level = 0; level < merkleRoot.tree.length - 1; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      
      if (siblingIndex < merkleRoot.tree[level].length) {
        proof.path.push({
          hash: merkleRoot.tree[level][siblingIndex],
          position: isLeft ? 'right' : 'left'
        });
      }
      
      currentIndex = Math.floor(currentIndex / 2);
    }
    
    return proof;
  }
  
  /**
   * Verify merkle proof
   */
  verifyMerkleProof(proof) {
    let currentHash = proof.entryHash;
    
    for (const node of proof.path) {
      if (node.position === 'left') {
        currentHash = this.hash(node.hash + currentHash);
      } else {
        currentHash = this.hash(currentHash + node.hash);
      }
    }
    
    return currentHash === proof.merkleRoot;
  }
  
  /**
   * Query logs
   */
  async query(filter = {}) {
    let results = [...this.chain.entries];
    
    // Apply filters
    if (filter.type) {
      results = results.filter(e => e.type === filter.type);
    }
    
    if (filter.severity !== undefined) {
      results = results.filter(e => e.severity >= filter.severity);
    }
    
    if (filter.startTime) {
      results = results.filter(e => e.timestamp >= filter.startTime);
    }
    
    if (filter.endTime) {
      results = results.filter(e => e.timestamp <= filter.endTime);
    }
    
    if (filter.userId) {
      results = results.filter(e => e.userId === filter.userId);
    }
    
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      results = results.filter(e => 
        e.message.toLowerCase().includes(searchLower) ||
        JSON.stringify(e.metadata).toLowerCase().includes(searchLower)
      );
    }
    
    // Decrypt metadata if needed
    if (this.options.encryptionEnabled) {
      results = await Promise.all(
        results.map(async (entry) => {
          if (entry.encryptedMetadata) {
            const decrypted = await this.decryptMetadata(entry.encryptedMetadata);
            return { ...entry, metadata: decrypted };
          }
          return entry;
        })
      );
    }
    
    // Apply pagination
    const page = filter.page || 1;
    const limit = filter.limit || 100;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    
    return {
      entries: results.slice(startIndex, endIndex),
      total: results.length,
      page,
      pages: Math.ceil(results.length / limit)
    };
  }
  
  /**
   * Export logs for compliance
   */
  async exportLogs(format = 'json', filter = {}) {
    const results = await this.query(filter);
    
    switch (format) {
      case 'json':
        return JSON.stringify(results, null, 2);
        
      case 'csv':
        return this.exportToCSV(results.entries);
        
      case 'xml':
        return this.exportToXML(results.entries);
        
      case 'syslog':
        return this.exportToSyslog(results.entries);
        
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }
  
  /**
   * Create checkpoint
   */
  async createCheckpoint(merkleRoot) {
    const checkpoint = {
      index: this.chain.checkpoints.length,
      timestamp: Date.now(),
      blockHeight: this.chain.entries.length,
      merkleRoot: merkleRoot.root,
      chainHash: this.chain.currentHash,
      stats: { ...this.stats }
    };
    
    // Sign checkpoint
    if (this.options.signLogs && this.hsm) {
      checkpoint.signature = await this.signCheckpoint(checkpoint);
    }
    
    this.chain.checkpoints.push(checkpoint);
    
    // Persist checkpoint
    await this.persistCheckpoint(checkpoint);
    
    this.emit('checkpoint:created', checkpoint);
  }
  
  /**
   * Calculate entry hash
   */
  calculateEntryHash(entry) {
    const data = {
      timestamp: entry.timestamp,
      nanoTime: entry.nanoTime,
      type: entry.type,
      severity: entry.severity,
      message: entry.message,
      previousHash: entry.previousHash,
      index: entry.index
    };
    
    return this.hash(JSON.stringify(data));
  }
  
  /**
   * Hash function
   */
  hash(data) {
    return crypto.createHash(this.options.hashAlgorithm)
      .update(data)
      .digest('hex');
  }
  
  /**
   * Genesis hash
   */
  genesisHash() {
    return this.hash('OTEDAMA_AUDIT_LOG_GENESIS_BLOCK_' + Date.now());
  }
  
  /**
   * Sign entry
   */
  async signEntry(entry) {
    const dataToSign = {
      hash: entry.hash,
      timestamp: entry.timestamp,
      type: entry.type
    };
    
    return await this.hsm.sign(
      this.signingKeyId,
      Buffer.from(JSON.stringify(dataToSign))
    );
  }
  
  /**
   * Verify entry signature
   */
  async verifyEntrySignature(entry) {
    const dataToVerify = {
      hash: entry.hash,
      timestamp: entry.timestamp,
      type: entry.type
    };
    
    return await this.hsm.verify(
      this.signingKeyId,
      Buffer.from(JSON.stringify(dataToVerify)),
      entry.signature
    );
  }
  
  /**
   * Get entry source
   */
  getSource() {
    return {
      hostname: process.env.HOSTNAME || 'localhost',
      pid: process.pid,
      component: 'otedama'
    };
  }
  
  /**
   * Initialize storage backend
   */
  async initializeStorage() {
    // Implementation depends on storage backend
    // This is a placeholder
    this.storage = new Map();
  }
  
  /**
   * Persist entry to storage
   */
  async persistEntry(entry) {
    // Implementation depends on storage backend
    this.storage.set(entry.id, entry);
  }
  
  /**
   * Persist checkpoint
   */
  async persistCheckpoint(checkpoint) {
    // Implementation depends on storage backend
    this.storage.set(`checkpoint_${checkpoint.index}`, checkpoint);
  }
  
  /**
   * Load existing chain
   */
  async loadChain() {
    // Implementation depends on storage backend
    // This would load existing entries and rebuild the chain
  }
  
  /**
   * Replicate entry to targets
   */
  async replicateEntry(entry) {
    if (this.options.replicationTargets.length === 0) return;
    
    const promises = this.options.replicationTargets.map(target =>
      this.replicateToTarget(entry, target).catch(error => {
        this.logger.error(`Replication to ${target.name} failed:`, error);
      })
    );
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Replicate to specific target
   */
  async replicateToTarget(entry, target) {
    // Implementation depends on target type
    // Could be another audit log instance, syslog server, etc.
  }
  
  /**
   * Start periodic tasks
   */
  startPeriodicTasks() {
    // Process pending entries periodically
    setInterval(() => {
      this.processEntries().catch(error => {
        this.logger.error('Failed to process entries:', error);
      });
    }, 1000);
    
    // Clean up old entries based on retention
    setInterval(() => {
      this.cleanupOldEntries().catch(error => {
        this.logger.error('Failed to cleanup entries:', error);
      });
    }, 24 * 60 * 60 * 1000); // Daily
  }
  
  /**
   * Cleanup old entries
   */
  async cleanupOldEntries() {
    const cutoffTime = Date.now() - (this.options.retentionDays * 24 * 60 * 60 * 1000);
    
    // Archive old entries before deletion
    const entriesToArchive = this.chain.entries.filter(e => e.timestamp < cutoffTime);
    
    if (entriesToArchive.length > 0) {
      await this.archiveEntries(entriesToArchive);
      
      // Remove from active chain
      this.chain.entries = this.chain.entries.filter(e => e.timestamp >= cutoffTime);
      
      this.logger.info(`Archived ${entriesToArchive.length} old entries`);
    }
  }
  
  /**
   * Archive entries
   */
  async archiveEntries(entries) {
    // Implementation would archive to long-term storage
    // with maintained cryptographic proofs
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      chainLength: this.chain.entries.length,
      pendingEntries: this.pendingEntries.length,
      oldestEntry: this.chain.entries[0]?.timestamp || null,
      newestEntry: this.chain.entries[this.chain.entries.length - 1]?.timestamp || null
    };
  }
  
  /**
   * Export to CSV
   */
  exportToCSV(entries) {
    const headers = ['ID', 'Timestamp', 'Type', 'Severity', 'Message', 'User', 'IP', 'Hash'];
    const rows = entries.map(e => [
      e.id,
      new Date(e.timestamp).toISOString(),
      e.type,
      e.severity,
      e.message,
      e.userId || '',
      e.ipAddress || '',
      e.hash
    ]);
    
    return [headers, ...rows].map(row => row.join(',')).join('\n');
  }
  
  /**
   * Encrypt metadata
   */
  async encryptMetadata(metadata) {
    // Implementation would use HSM or encryption key
    return Buffer.from(JSON.stringify(metadata)).toString('base64');
  }
  
  /**
   * Decrypt metadata
   */
  async decryptMetadata(encrypted) {
    // Implementation would use HSM or encryption key
    return JSON.parse(Buffer.from(encrypted, 'base64').toString());
  }
}

// Singleton instance
let auditLogInstance = null;

/**
 * Get audit log instance
 */
export function getAuditLog(options) {
  if (!auditLogInstance) {
    auditLogInstance = new ImmutableAuditLog(options);
  }
  return auditLogInstance;
}

export default ImmutableAuditLog;