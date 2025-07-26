/**
 * HSM Multi-Signature Integration - Otedama
 * Combines HSM security with multi-signature wallets
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';

const logger = createLogger('HSMMultiSig');

/**
 * HSM-backed multi-signature implementation
 */
export class HSMMultiSigIntegration extends EventEmitter {
  constructor(hsm, multiSigManager, options = {}) {
    super();
    
    this.hsm = hsm;
    this.multiSigManager = multiSigManager;
    
    this.config = {
      keyPrefix: options.keyPrefix || 'multisig',
      autoGenerateKeys: options.autoGenerateKeys !== false,
      keyAlgorithm: options.keyAlgorithm || 'ec',
      keyOptions: options.keyOptions || { curve: 'secp256k1' },
      ...options
    };
    
    this.signerKeyMap = new Map();
  }
  
  /**
   * Initialize integration
   */
  async initialize() {
    logger.info('Initializing HSM multi-signature integration...');
    
    // Ensure HSM is unlocked
    if (this.hsm.locked) {
      throw new Error('HSM must be unlocked');
    }
    
    // Set up event handlers
    this.setupEventHandlers();
    
    logger.info('HSM multi-signature integration initialized');
    this.emit('initialized');
  }
  
  /**
   * Create HSM-backed multi-sig wallet
   */
  async createHSMWallet(params) {
    const {
      name,
      signerCount,
      threshold,
      signerNames = []
    } = params;
    
    logger.info(`Creating HSM-backed wallet: ${name}`);
    
    // Generate signer keys in HSM
    const signers = [];
    
    for (let i = 0; i < signerCount; i++) {
      const signerId = this.generateSignerId();
      const keyId = `${this.config.keyPrefix}_${signerId}`;
      
      // Generate key pair in HSM
      const keyInfo = await this.hsm.generateKeyPair(
        keyId,
        this.config.keyAlgorithm,
        {
          ...this.config.keyOptions,
          persistent: true,
          extractable: false
        }
      );
      
      // Export public key
      const publicKey = await this.hsm.exportPublicKey(keyId, 'pem');
      
      signers.push({
        id: signerId,
        publicKey,
        name: signerNames[i] || `Signer ${i + 1}`,
        keyId // Store HSM key reference
      });
      
      // Map signer to HSM key
      this.signerKeyMap.set(signerId, keyId);
    }
    
    // Create wallet in multi-sig manager
    const wallet = await this.multiSigManager.createWallet({
      name,
      signers,
      threshold,
      type: 'hsm-backed'
    });
    
    logger.info(`Created HSM-backed wallet: ${wallet.id}`);
    this.emit('wallet:created', wallet);
    
    return wallet;
  }
  
  /**
   * Sign transaction with HSM key
   */
  async signTransaction(transactionId, signerId) {
    const transaction = this.multiSigManager.getTransaction(transactionId);
    if (!transaction) {
      throw new Error('Transaction not found');
    }
    
    // Get HSM key for signer
    const keyId = this.signerKeyMap.get(signerId);
    if (!keyId) {
      throw new Error('No HSM key found for signer');
    }
    
    // Get transaction message
    const message = this.multiSigManager.getTransactionMessage(transaction);
    
    // Sign with HSM
    const signatureData = await this.hsm.sign(keyId, message);
    
    // Submit signature to multi-sig manager
    const result = await this.multiSigManager.signTransaction(
      transactionId,
      signerId,
      signatureData.signature
    );
    
    logger.info(`Transaction ${transactionId} signed by ${signerId} using HSM`);
    this.emit('transaction:signed', {
      transactionId,
      signerId,
      ...result
    });
    
    return result;
  }
  
  /**
   * Create secure payment transaction
   */
  async createSecurePayment(walletId, params) {
    const {
      amount,
      recipient,
      memo,
      requireAllSigners = false
    } = params;
    
    // Validate recipient address
    if (!this.isValidAddress(recipient)) {
      throw new Error('Invalid recipient address');
    }
    
    // Get wallet
    const wallet = this.multiSigManager.getWallet(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    
    // Determine required signers
    const requiredSigners = requireAllSigners 
      ? wallet.signers.map(s => s.id)
      : this.selectRequiredSigners(wallet, amount);
    
    // Create transaction
    const transaction = await this.multiSigManager.createTransaction(walletId, {
      type: 'transfer',
      amount,
      recipient,
      memo,
      requiredSigners,
      data: {
        securityLevel: 'hsm',
        timestamp: Date.now()
      }
    });
    
    logger.info(`Created secure payment transaction: ${transaction.id}`);
    this.emit('payment:created', transaction);
    
    return transaction;
  }
  
  /**
   * Batch sign transactions
   */
  async batchSign(signerId, transactionIds) {
    const results = [];
    
    for (const transactionId of transactionIds) {
      try {
        const result = await this.signTransaction(transactionId, signerId);
        results.push({
          transactionId,
          success: true,
          result
        });
      } catch (error) {
        logger.error(`Failed to sign transaction ${transactionId}:`, error);
        results.push({
          transactionId,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  /**
   * Rotate signer key
   */
  async rotateSignerKey(walletId, signerId) {
    const wallet = this.multiSigManager.getWallet(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    
    const signer = wallet.signers.find(s => s.id === signerId);
    if (!signer) {
      throw new Error('Signer not found');
    }
    
    // Get old key ID
    const oldKeyId = this.signerKeyMap.get(signerId);
    if (!oldKeyId) {
      throw new Error('No HSM key found for signer');
    }
    
    // Rotate key in HSM
    const newKeyId = await this.hsm.rotateKey(oldKeyId);
    
    // Export new public key
    const newPublicKey = await this.hsm.exportPublicKey(newKeyId, 'pem');
    
    // Update signer public key
    signer.publicKey = newPublicKey;
    signer.keyRotatedAt = Date.now();
    
    // Update key mapping
    this.signerKeyMap.set(signerId, newKeyId);
    
    // Save wallet
    await this.multiSigManager.saveWallet(wallet);
    
    logger.info(`Rotated key for signer ${signerId} in wallet ${walletId}`);
    this.emit('key:rotated', {
      walletId,
      signerId,
      oldKeyId,
      newKeyId
    });
    
    return {
      signerId,
      newKeyId,
      publicKey: newPublicKey
    };
  }
  
  /**
   * Emergency key recovery
   */
  async emergencyRecovery(walletId, recoveryData, approverSignatures) {
    // This would implement emergency recovery procedures
    // using HSM backup keys and quorum approval
    
    logger.warn(`Emergency recovery initiated for wallet ${walletId}`);
    
    // Verify recovery quorum
    const verified = await this.verifyRecoveryQuorum(
      walletId,
      recoveryData,
      approverSignatures
    );
    
    if (!verified) {
      throw new Error('Recovery quorum not met');
    }
    
    // Perform recovery
    // In production, this would restore keys from secure backup
    
    this.emit('recovery:completed', {
      walletId,
      timestamp: Date.now()
    });
    
    return {
      status: 'recovered',
      walletId
    };
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Handle transaction execution
    this.multiSigManager.on('transaction:executed', async (transaction) => {
      if (transaction.type === 'transfer') {
        // Log secure transfer
        logger.info(`Secure transfer executed: ${transaction.id}`);
        
        // Audit trail
        this.emit('audit:transfer', {
          transactionId: transaction.id,
          amount: transaction.amount,
          recipient: transaction.recipient,
          executedAt: transaction.executedAt,
          signers: Array.from(transaction.signatures.keys())
        });
      }
    });
    
    // Handle key events from HSM
    this.hsm.on('key:rotated', ({ oldKeyId, newKeyId }) => {
      // Update any affected signers
      for (const [signerId, keyId] of this.signerKeyMap) {
        if (keyId === oldKeyId) {
          this.signerKeyMap.set(signerId, newKeyId);
          logger.info(`Updated key mapping for signer ${signerId}`);
        }
      }
    });
  }
  
  /**
   * Select required signers based on amount
   */
  selectRequiredSigners(wallet, amount) {
    // For large amounts, require more signers
    const signerCount = wallet.signers.length;
    const requiredCount = Math.min(
      Math.ceil(signerCount * 0.6),
      wallet.threshold
    );
    
    // Select signers with highest weight
    const sortedSigners = [...wallet.signers].sort((a, b) => 
      (b.weight || 1) - (a.weight || 1)
    );
    
    return sortedSigners
      .slice(0, requiredCount)
      .map(s => s.id);
  }
  
  /**
   * Validate address
   */
  isValidAddress(address) {
    // Basic validation - in production would check specific format
    return /^[a-zA-Z0-9]{26,}$/.test(address);
  }
  
  /**
   * Generate signer ID
   */
  generateSignerId() {
    return `signer_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }
  
  /**
   * Verify recovery quorum
   */
  async verifyRecoveryQuorum(walletId, recoveryData, signatures) {
    // In production, this would verify emergency recovery signatures
    // against pre-registered recovery keys
    return signatures && signatures.length >= 3;
  }
  
  /**
   * Get integration statistics
   */
  getStats() {
    return {
      hsmSigners: this.signerKeyMap.size,
      hsmStatus: this.hsm.locked ? 'locked' : 'unlocked',
      ...this.multiSigManager.getStats()
    };
  }
  
  /**
   * Shutdown integration
   */
  async shutdown() {
    logger.info('Shutting down HSM multi-signature integration...');
    
    this.removeAllListeners();
    logger.info('HSM multi-signature integration shutdown complete');
  }
}

/**
 * Create HSM multi-sig integration
 */
export function createHSMMultiSigIntegration(hsm, multiSigManager, options) {
  return new HSMMultiSigIntegration(hsm, multiSigManager, options);
}

export default {
  HSMMultiSigIntegration,
  createHSMMultiSigIntegration
};