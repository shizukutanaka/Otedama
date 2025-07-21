/**
 * Multi-Signature Implementation
 * M-of-N signature requirements for critical operations
 * Supports threshold signatures and distributed key generation
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getLogger } from '../core/logger.js';
import { HSMManager } from './hsm-integration.js';

// Multi-signature schemes
export const MultiSigScheme = {
  THRESHOLD: 'threshold',           // Threshold signatures (t-of-n)
  SCHNORR: 'schnorr',              // Schnorr multi-signatures
  ECDSA_MULTI: 'ecdsa_multi',      // ECDSA multi-party
  BLS: 'bls',                      // BLS aggregate signatures
  FROST: 'frost'                   // FROST threshold signatures
};

// Operation types requiring multi-sig
export const OperationType = {
  TRANSACTION: 'transaction',
  KEY_ROTATION: 'key_rotation',
  ADMIN_ACTION: 'admin_action',
  SMART_CONTRACT: 'smart_contract',
  EMERGENCY_SHUTDOWN: 'emergency_shutdown',
  FUND_TRANSFER: 'fund_transfer'
};

/**
 * Multi-Signature Manager
 */
export class MultiSignatureManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = getLogger('MultiSignature');
    this.options = {
      scheme: options.scheme || MultiSigScheme.THRESHOLD,
      threshold: options.threshold || 2,    // M (required signatures)
      participants: options.participants || 3, // N (total signers)
      timeout: options.timeout || 3600000, // 1 hour timeout for signatures
      hsmEnabled: options.hsmEnabled !== false,
      ...options
    };
    
    // Initialize HSM if enabled
    if (this.options.hsmEnabled) {
      this.hsm = new HSMManager({
        provider: options.hsmProvider || 'software_hsm'
      });
    }
    
    // Signer registry
    this.signers = new Map();
    this.signerGroups = new Map();
    
    // Pending operations
    this.pendingOperations = new Map();
    
    // Completed signatures
    this.completedSignatures = new Map();
    
    // Statistics
    this.stats = {
      operationsCreated: 0,
      operationsCompleted: 0,
      operationsExpired: 0,
      signaturesCollected: 0,
      signaturesVerified: 0
    };
    
    // Start cleanup timer
    this.startCleanupTimer();
  }
  
  /**
   * Initialize multi-signature system
   */
  async initialize() {
    this.logger.info('Initializing multi-signature system...');
    
    if (this.hsm) {
      await this.hsm.initialize();
    }
    
    // Generate distributed keys if using threshold scheme
    if (this.options.scheme === MultiSigScheme.THRESHOLD) {
      await this.initializeThresholdScheme();
    }
    
    this.emit('initialized');
  }
  
  /**
   * Register a signer
   */
  async registerSigner(signerId, publicKey, metadata = {}) {
    if (this.signers.has(signerId)) {
      throw new Error(`Signer ${signerId} already registered`);
    }
    
    const signer = {
      id: signerId,
      publicKey,
      metadata,
      registered: Date.now(),
      active: true,
      signatureCount: 0,
      groups: new Set()
    };
    
    this.signers.set(signerId, signer);
    
    this.logger.info(`Registered signer: ${signerId}`);
    this.emit('signer:registered', { signerId });
    
    return signer;
  }
  
  /**
   * Create signer group
   */
  createSignerGroup(groupId, signerIds, threshold, metadata = {}) {
    if (this.signerGroups.has(groupId)) {
      throw new Error(`Group ${groupId} already exists`);
    }
    
    // Validate signers exist
    for (const signerId of signerIds) {
      if (!this.signers.has(signerId)) {
        throw new Error(`Signer ${signerId} not found`);
      }
    }
    
    // Validate threshold
    if (threshold > signerIds.length) {
      throw new Error('Threshold cannot exceed number of signers');
    }
    
    const group = {
      id: groupId,
      signers: new Set(signerIds),
      threshold,
      metadata,
      created: Date.now(),
      active: true
    };
    
    this.signerGroups.set(groupId, group);
    
    // Update signer groups
    for (const signerId of signerIds) {
      const signer = this.signers.get(signerId);
      signer.groups.add(groupId);
    }
    
    this.logger.info(`Created signer group: ${groupId} (${threshold}-of-${signerIds.length})`);
    this.emit('group:created', { groupId, threshold, signers: signerIds.length });
    
    return group;
  }
  
  /**
   * Create multi-signature operation
   */
  async createOperation(operationType, data, options = {}) {
    const operationId = crypto.randomBytes(16).toString('hex');
    
    // Determine required signers
    const requiredSigners = options.signers || this.getDefaultSigners(operationType);
    const threshold = options.threshold || this.getThreshold(operationType);
    
    // Validate signers
    for (const signerId of requiredSigners) {
      if (!this.signers.has(signerId) && !this.signerGroups.has(signerId)) {
        throw new Error(`Signer/group ${signerId} not found`);
      }
    }
    
    // Create operation
    const operation = {
      id: operationId,
      type: operationType,
      data,
      dataHash: this.hashData(data),
      requiredSigners: new Set(requiredSigners),
      threshold,
      signatures: new Map(),
      created: Date.now(),
      expires: Date.now() + (options.timeout || this.options.timeout),
      status: 'pending',
      metadata: options.metadata || {}
    };
    
    this.pendingOperations.set(operationId, operation);
    this.stats.operationsCreated++;
    
    this.logger.info(`Created multi-sig operation: ${operationId} (${threshold} signatures required)`);
    this.emit('operation:created', {
      operationId,
      type: operationType,
      threshold,
      expires: operation.expires
    });
    
    // Notify required signers
    this.notifySigners(operation);
    
    return {
      operationId,
      dataHash: operation.dataHash,
      threshold,
      requiredSigners: Array.from(requiredSigners),
      expires: operation.expires
    };
  }
  
  /**
   * Add signature to operation
   */
  async addSignature(operationId, signerId, signature) {
    const operation = this.pendingOperations.get(operationId);
    if (!operation) {
      throw new Error('Operation not found');
    }
    
    // Check if operation expired
    if (Date.now() > operation.expires) {
      operation.status = 'expired';
      this.stats.operationsExpired++;
      throw new Error('Operation expired');
    }
    
    // Verify signer is authorized
    if (!operation.requiredSigners.has(signerId) && !this.isSignerInGroup(signerId, operation.requiredSigners)) {
      throw new Error('Signer not authorized for this operation');
    }
    
    // Verify signature
    const signer = this.signers.get(signerId);
    if (!signer) {
      throw new Error('Signer not found');
    }
    
    const verified = await this.verifySignature(
      operation.dataHash,
      signature,
      signer.publicKey
    );
    
    if (!verified) {
      throw new Error('Invalid signature');
    }
    
    // Add signature
    operation.signatures.set(signerId, {
      signature,
      timestamp: Date.now(),
      verified: true
    });
    
    signer.signatureCount++;
    this.stats.signaturesCollected++;
    
    this.logger.info(`Added signature from ${signerId} to operation ${operationId}`);
    this.emit('signature:added', {
      operationId,
      signerId,
      signaturesCollected: operation.signatures.size,
      threshold: operation.threshold
    });
    
    // Check if threshold reached
    if (operation.signatures.size >= operation.threshold) {
      await this.completeOperation(operationId);
    }
    
    return {
      operationId,
      signaturesCollected: operation.signatures.size,
      threshold: operation.threshold,
      complete: operation.status === 'completed'
    };
  }
  
  /**
   * Complete operation when threshold reached
   */
  async completeOperation(operationId) {
    const operation = this.pendingOperations.get(operationId);
    if (!operation) {
      throw new Error('Operation not found');
    }
    
    // Create aggregated signature based on scheme
    let aggregatedSignature;
    
    switch (this.options.scheme) {
      case MultiSigScheme.THRESHOLD:
        aggregatedSignature = await this.createThresholdSignature(operation);
        break;
        
      case MultiSigScheme.SCHNORR:
        aggregatedSignature = await this.createSchnorrSignature(operation);
        break;
        
      case MultiSigScheme.BLS:
        aggregatedSignature = await this.createBLSSignature(operation);
        break;
        
      default:
        // Simple concatenation for basic multi-sig
        aggregatedSignature = this.concatenateSignatures(operation);
    }
    
    operation.status = 'completed';
    operation.completedAt = Date.now();
    operation.aggregatedSignature = aggregatedSignature;
    
    // Move to completed
    this.pendingOperations.delete(operationId);
    this.completedSignatures.set(operationId, operation);
    
    this.stats.operationsCompleted++;
    
    this.logger.info(`Completed multi-sig operation: ${operationId}`);
    this.emit('operation:completed', {
      operationId,
      type: operation.type,
      signatures: operation.signatures.size,
      aggregatedSignature
    });
    
    // Execute the operation
    await this.executeOperation(operation);
    
    return {
      operationId,
      status: 'completed',
      aggregatedSignature,
      completedAt: operation.completedAt
    };
  }
  
  /**
   * Verify multi-signature
   */
  async verifyMultiSignature(operationId, aggregatedSignature) {
    const operation = this.completedSignatures.get(operationId) || 
                      this.pendingOperations.get(operationId);
    
    if (!operation) {
      throw new Error('Operation not found');
    }
    
    // Verify based on scheme
    let verified = false;
    
    switch (this.options.scheme) {
      case MultiSigScheme.THRESHOLD:
        verified = await this.verifyThresholdSignature(
          operation.dataHash,
          aggregatedSignature,
          operation
        );
        break;
        
      case MultiSigScheme.SCHNORR:
        verified = await this.verifySchnorrSignature(
          operation.dataHash,
          aggregatedSignature,
          operation
        );
        break;
        
      default:
        // Verify individual signatures
        verified = await this.verifyIndividualSignatures(operation);
    }
    
    this.stats.signaturesVerified++;
    
    return {
      operationId,
      verified,
      scheme: this.options.scheme,
      signers: Array.from(operation.signatures.keys())
    };
  }
  
  /**
   * Initialize threshold signature scheme
   */
  async initializeThresholdScheme() {
    // Distributed key generation for threshold signatures
    // This is a simplified version - production would use proper DKG
    
    const shares = [];
    const commitments = [];
    
    // Generate polynomial coefficients
    const coefficients = [];
    for (let i = 0; i < this.options.threshold; i++) {
      coefficients.push(crypto.randomBytes(32));
    }
    
    // Generate shares for each participant
    for (let i = 1; i <= this.options.participants; i++) {
      const share = this.evaluatePolynomial(coefficients, i);
      shares.push({
        index: i,
        share,
        participant: `participant_${i}`
      });
    }
    
    // Store shares securely
    this.thresholdShares = shares;
    this.thresholdCommitments = commitments;
    
    this.logger.info('Initialized threshold signature scheme');
  }
  
  /**
   * Create threshold signature
   */
  async createThresholdSignature(operation) {
    const signatures = Array.from(operation.signatures.values());
    
    // Combine signature shares
    // This is simplified - production would use proper threshold signature combination
    const combined = Buffer.concat(
      signatures.map(sig => Buffer.from(sig.signature, 'hex'))
    );
    
    return crypto.createHash('sha256').update(combined).digest('hex');
  }
  
  /**
   * Hash operation data
   */
  hashData(data) {
    const normalized = typeof data === 'string' ? data : JSON.stringify(data);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }
  
  /**
   * Verify signature
   */
  async verifySignature(dataHash, signature, publicKey) {
    try {
      if (this.hsm) {
        // Use HSM for verification
        return await this.hsm.verify(publicKey, Buffer.from(dataHash, 'hex'), signature);
      } else {
        // Software verification
        const verify = crypto.createVerify('SHA256');
        verify.update(dataHash);
        return verify.verify(publicKey, signature, 'hex');
      }
    } catch (error) {
      this.logger.error('Signature verification failed:', error);
      return false;
    }
  }
  
  /**
   * Get default signers for operation type
   */
  getDefaultSigners(operationType) {
    // In production, this would be configured per operation type
    const defaultGroups = {
      [OperationType.TRANSACTION]: ['transaction_signers'],
      [OperationType.KEY_ROTATION]: ['key_managers'],
      [OperationType.ADMIN_ACTION]: ['administrators'],
      [OperationType.EMERGENCY_SHUTDOWN]: ['emergency_committee']
    };
    
    return defaultGroups[operationType] || Array.from(this.signers.keys()).slice(0, this.options.participants);
  }
  
  /**
   * Get threshold for operation type
   */
  getThreshold(operationType) {
    // Critical operations might require higher threshold
    const thresholds = {
      [OperationType.EMERGENCY_SHUTDOWN]: Math.ceil(this.options.participants * 0.8),
      [OperationType.KEY_ROTATION]: Math.ceil(this.options.participants * 0.7),
      [OperationType.ADMIN_ACTION]: Math.ceil(this.options.participants * 0.6)
    };
    
    return thresholds[operationType] || this.options.threshold;
  }
  
  /**
   * Check if signer is in any required group
   */
  isSignerInGroup(signerId, requiredSigners) {
    for (const groupId of requiredSigners) {
      const group = this.signerGroups.get(groupId);
      if (group && group.signers.has(signerId)) {
        return true;
      }
    }
    return false;
  }
  
  /**
   * Notify signers about pending operation
   */
  notifySigners(operation) {
    for (const signerId of operation.requiredSigners) {
      this.emit('signature:requested', {
        signerId,
        operationId: operation.id,
        type: operation.type,
        dataHash: operation.dataHash,
        expires: operation.expires
      });
    }
  }
  
  /**
   * Execute completed operation
   */
  async executeOperation(operation) {
    // This would execute the actual operation
    // For now, just emit an event
    this.emit('operation:executed', {
      operationId: operation.id,
      type: operation.type,
      data: operation.data
    });
  }
  
  /**
   * Concatenate signatures for basic multi-sig
   */
  concatenateSignatures(operation) {
    const signatures = Array.from(operation.signatures.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([signerId, sig]) => sig.signature);
    
    return signatures.join(':');
  }
  
  /**
   * Verify individual signatures
   */
  async verifyIndividualSignatures(operation) {
    for (const [signerId, sigData] of operation.signatures) {
      const signer = this.signers.get(signerId);
      if (!signer) continue;
      
      const verified = await this.verifySignature(
        operation.dataHash,
        sigData.signature,
        signer.publicKey
      );
      
      if (!verified) return false;
    }
    
    return operation.signatures.size >= operation.threshold;
  }
  
  /**
   * Evaluate polynomial for threshold scheme
   */
  evaluatePolynomial(coefficients, x) {
    let result = Buffer.alloc(32);
    let xPower = 1;
    
    for (const coeff of coefficients) {
      for (let i = 0; i < 32; i++) {
        result[i] = (result[i] + coeff[i] * xPower) % 256;
      }
      xPower = (xPower * x) % 256;
    }
    
    return result;
  }
  
  /**
   * Start cleanup timer
   */
  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      
      // Clean up expired operations
      for (const [operationId, operation] of this.pendingOperations) {
        if (now > operation.expires) {
          operation.status = 'expired';
          this.pendingOperations.delete(operationId);
          this.stats.operationsExpired++;
          
          this.emit('operation:expired', { operationId });
        }
      }
      
      // Clean up old completed signatures
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
      for (const [operationId, operation] of this.completedSignatures) {
        if (now - operation.completedAt > maxAge) {
          this.completedSignatures.delete(operationId);
        }
      }
    }, 60000); // Every minute
  }
  
  /**
   * Get operation status
   */
  getOperationStatus(operationId) {
    const operation = this.pendingOperations.get(operationId) || 
                      this.completedSignatures.get(operationId);
    
    if (!operation) {
      return null;
    }
    
    return {
      operationId,
      type: operation.type,
      status: operation.status,
      signatures: operation.signatures.size,
      threshold: operation.threshold,
      created: operation.created,
      expires: operation.expires,
      completedAt: operation.completedAt
    };
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeSIgners: this.signers.size,
      signerGroups: this.signerGroups.size,
      pendingOperations: this.pendingOperations.size,
      completedOperations: this.completedSignatures.size
    };
  }
  
  /**
   * Export signer configuration
   */
  exportConfiguration() {
    const signers = Array.from(this.signers.entries()).map(([id, signer]) => ({
      id,
      publicKey: signer.publicKey,
      groups: Array.from(signer.groups),
      active: signer.active
    }));
    
    const groups = Array.from(this.signerGroups.entries()).map(([id, group]) => ({
      id,
      signers: Array.from(group.signers),
      threshold: group.threshold,
      active: group.active
    }));
    
    return {
      scheme: this.options.scheme,
      threshold: this.options.threshold,
      participants: this.options.participants,
      signers,
      groups
    };
  }
}

export default MultiSignatureManager;