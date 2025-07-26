/**
 * Multi-Signature Wallet Support - Otedama
 * Secure multi-party authorization for pool operations
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const logger = createLogger('MultiSigWallet');

/**
 * Multi-signature wallet manager
 */
export class MultiSigWalletManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      defaultThreshold: options.defaultThreshold || 2,
      maxSigners: options.maxSigners || 10,
      transactionTimeout: options.transactionTimeout || 86400000, // 24 hours
      storePath: options.storePath || './data/multisig',
      enableNotifications: options.enableNotifications !== false,
      ...options
    };
    
    this.wallets = new Map();
    this.pendingTransactions = new Map();
    this.signerKeys = new Map();
    
    this.stats = {
      walletsCreated: 0,
      transactionsCreated: 0,
      transactionsExecuted: 0,
      transactionsFailed: 0,
      signaturesCollected: 0
    };
  }
  
  /**
   * Initialize multi-sig manager
   */
  async initialize() {
    logger.info('Initializing multi-signature wallet manager...');
    
    // Create storage directory
    await fs.mkdir(this.config.storePath, { recursive: true });
    
    // Load existing wallets
    await this.loadWallets();
    
    // Start cleanup timer
    this.startCleanupTimer();
    
    logger.info('Multi-signature wallet manager initialized');
    this.emit('initialized');
  }
  
  /**
   * Create new multi-sig wallet
   */
  async createWallet(params) {
    const {
      walletId = this.generateWalletId(),
      name,
      signers,
      threshold,
      type = 'standard'
    } = params;
    
    // Validate parameters
    if (!signers || signers.length < 2) {
      throw new Error('At least 2 signers required');
    }
    
    if (!threshold || threshold < 1 || threshold > signers.length) {
      throw new Error('Invalid threshold');
    }
    
    if (signers.length > this.config.maxSigners) {
      throw new Error(`Maximum ${this.config.maxSigners} signers allowed`);
    }
    
    // Create wallet
    const wallet = {
      id: walletId,
      name,
      type,
      signers: signers.map(signer => ({
        id: signer.id,
        publicKey: signer.publicKey,
        name: signer.name,
        weight: signer.weight || 1
      })),
      threshold,
      createdAt: Date.now(),
      transactions: [],
      balance: 0,
      status: 'active'
    };
    
    // Store wallet
    this.wallets.set(walletId, wallet);
    await this.saveWallet(wallet);
    
    this.stats.walletsCreated++;
    
    logger.info(`Created multi-sig wallet: ${walletId}`);
    this.emit('wallet:created', wallet);
    
    return wallet;
  }
  
  /**
   * Create transaction
   */
  async createTransaction(walletId, params) {
    const wallet = this.wallets.get(walletId);
    if (!wallet) {
      throw new Error('Wallet not found');
    }
    
    const {
      type,
      amount,
      recipient,
      data,
      memo,
      requiredSigners,
      expiresAt = Date.now() + this.config.transactionTimeout
    } = params;
    
    // Validate transaction
    if (type === 'transfer' && !recipient) {
      throw new Error('Recipient required for transfer');
    }
    
    if (amount && amount <= 0) {
      throw new Error('Invalid amount');
    }
    
    // Create transaction
    const transaction = {
      id: this.generateTransactionId(),
      walletId,
      type,
      amount,
      recipient,
      data,
      memo,
      requiredSigners: requiredSigners || wallet.signers.map(s => s.id),
      signatures: new Map(),
      status: 'pending',
      createdAt: Date.now(),
      expiresAt,
      executedAt: null,
      txHash: null
    };
    
    // Store transaction
    this.pendingTransactions.set(transaction.id, transaction);
    wallet.transactions.push(transaction.id);
    
    this.stats.transactionsCreated++;
    
    logger.info(`Created transaction: ${transaction.id} for wallet: ${walletId}`);
    this.emit('transaction:created', transaction);
    
    // Notify signers if enabled
    if (this.config.enableNotifications) {
      this.notifySigners(wallet, transaction);
    }
    
    return transaction;
  }
  
  /**
   * Sign transaction
   */
  async signTransaction(transactionId, signerId, signature) {
    const transaction = this.pendingTransactions.get(transactionId);
    if (!transaction) {
      throw new Error('Transaction not found');
    }
    
    if (transaction.status !== 'pending') {
      throw new Error('Transaction not pending');
    }
    
    if (Date.now() > transaction.expiresAt) {
      transaction.status = 'expired';
      throw new Error('Transaction expired');
    }
    
    const wallet = this.wallets.get(transaction.walletId);
    const signer = wallet.signers.find(s => s.id === signerId);
    
    if (!signer) {
      throw new Error('Signer not authorized');
    }
    
    if (!transaction.requiredSigners.includes(signerId)) {
      throw new Error('Signer not required for this transaction');
    }
    
    // Verify signature
    const verified = await this.verifySignature(
      transaction,
      signer.publicKey,
      signature
    );
    
    if (!verified) {
      throw new Error('Invalid signature');
    }
    
    // Store signature
    transaction.signatures.set(signerId, {
      signature,
      timestamp: Date.now(),
      weight: signer.weight
    });
    
    this.stats.signaturesCollected++;
    
    logger.info(`Transaction ${transactionId} signed by ${signerId}`);
    this.emit('transaction:signed', {
      transactionId,
      signerId,
      signaturesCollected: transaction.signatures.size,
      threshold: wallet.threshold
    });
    
    // Check if threshold reached
    if (this.isThresholdReached(wallet, transaction)) {
      await this.executeTransaction(transaction);
    }
    
    return {
      transactionId,
      signaturesCollected: transaction.signatures.size,
      threshold: wallet.threshold,
      ready: this.isThresholdReached(wallet, transaction)
    };
  }
  
  /**
   * Check if threshold reached
   */
  isThresholdReached(wallet, transaction) {
    let totalWeight = 0;
    
    for (const [signerId, sig] of transaction.signatures) {
      totalWeight += sig.weight;
    }
    
    return totalWeight >= wallet.threshold;
  }
  
  /**
   * Execute transaction
   */
  async executeTransaction(transaction) {
    if (transaction.status !== 'pending') {
      throw new Error('Transaction not pending');
    }
    
    const wallet = this.wallets.get(transaction.walletId);
    
    try {
      logger.info(`Executing transaction: ${transaction.id}`);
      
      // Execute based on type
      let result;
      switch (transaction.type) {
        case 'transfer':
          result = await this.executeTransfer(wallet, transaction);
          break;
          
        case 'addSigner':
          result = await this.executeAddSigner(wallet, transaction);
          break;
          
        case 'removeSigner':
          result = await this.executeRemoveSigner(wallet, transaction);
          break;
          
        case 'changeThreshold':
          result = await this.executeChangeThreshold(wallet, transaction);
          break;
          
        case 'custom':
          result = await this.executeCustom(wallet, transaction);
          break;
          
        default:
          throw new Error(`Unknown transaction type: ${transaction.type}`);
      }
      
      // Update transaction
      transaction.status = 'executed';
      transaction.executedAt = Date.now();
      transaction.result = result;
      
      // Remove from pending
      this.pendingTransactions.delete(transaction.id);
      
      this.stats.transactionsExecuted++;
      
      logger.info(`Transaction executed: ${transaction.id}`);
      this.emit('transaction:executed', transaction);
      
      return result;
      
    } catch (error) {
      logger.error(`Transaction execution failed: ${error.message}`);
      
      transaction.status = 'failed';
      transaction.error = error.message;
      
      this.stats.transactionsFailed++;
      this.emit('transaction:failed', transaction);
      
      throw error;
    }
  }
  
  /**
   * Execute transfer
   */
  async executeTransfer(wallet, transaction) {
    // In production, this would interact with blockchain
    const transfer = {
      from: wallet.id,
      to: transaction.recipient,
      amount: transaction.amount,
      memo: transaction.memo,
      timestamp: Date.now()
    };
    
    // Update balance
    wallet.balance -= transaction.amount;
    
    // Emit transfer event
    this.emit('transfer:executed', transfer);
    
    return {
      txHash: this.generateTxHash(),
      transfer
    };
  }
  
  /**
   * Execute add signer
   */
  async executeAddSigner(wallet, transaction) {
    const { signer } = transaction.data;
    
    if (wallet.signers.find(s => s.id === signer.id)) {
      throw new Error('Signer already exists');
    }
    
    wallet.signers.push({
      id: signer.id,
      publicKey: signer.publicKey,
      name: signer.name,
      weight: signer.weight || 1
    });
    
    await this.saveWallet(wallet);
    
    return { added: signer.id };
  }
  
  /**
   * Execute remove signer
   */
  async executeRemoveSigner(wallet, transaction) {
    const { signerId } = transaction.data;
    
    const index = wallet.signers.findIndex(s => s.id === signerId);
    if (index === -1) {
      throw new Error('Signer not found');
    }
    
    // Check if removal would make wallet unusable
    const newSignerCount = wallet.signers.length - 1;
    if (newSignerCount < wallet.threshold) {
      throw new Error('Cannot remove signer: would make wallet unusable');
    }
    
    wallet.signers.splice(index, 1);
    
    await this.saveWallet(wallet);
    
    return { removed: signerId };
  }
  
  /**
   * Execute change threshold
   */
  async executeChangeThreshold(wallet, transaction) {
    const { threshold } = transaction.data;
    
    if (threshold < 1 || threshold > wallet.signers.length) {
      throw new Error('Invalid threshold');
    }
    
    const oldThreshold = wallet.threshold;
    wallet.threshold = threshold;
    
    await this.saveWallet(wallet);
    
    return { 
      oldThreshold, 
      newThreshold: threshold 
    };
  }
  
  /**
   * Execute custom transaction
   */
  async executeCustom(wallet, transaction) {
    // Emit event for external handlers
    const result = await new Promise((resolve, reject) => {
      this.emit('transaction:custom', {
        wallet,
        transaction,
        resolve,
        reject
      });
      
      // Timeout if no handler
      setTimeout(() => {
        reject(new Error('No handler for custom transaction'));
      }, 5000);
    });
    
    return result;
  }
  
  /**
   * Verify signature
   */
  async verifySignature(transaction, publicKey, signature) {
    const message = this.getTransactionMessage(transaction);
    
    try {
      const verify = crypto.createVerify('SHA256');
      verify.update(message);
      verify.end();
      
      return verify.verify(publicKey, Buffer.from(signature, 'base64'));
    } catch (error) {
      logger.error('Signature verification failed:', error);
      return false;
    }
  }
  
  /**
   * Get transaction message for signing
   */
  getTransactionMessage(transaction) {
    return JSON.stringify({
      id: transaction.id,
      walletId: transaction.walletId,
      type: transaction.type,
      amount: transaction.amount,
      recipient: transaction.recipient,
      data: transaction.data,
      memo: transaction.memo,
      createdAt: transaction.createdAt,
      expiresAt: transaction.expiresAt
    });
  }
  
  /**
   * Generate wallet ID
   */
  generateWalletId() {
    return `wallet_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }
  
  /**
   * Generate transaction ID
   */
  generateTransactionId() {
    return `tx_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }
  
  /**
   * Generate transaction hash
   */
  generateTxHash() {
    return '0x' + crypto.randomBytes(32).toString('hex');
  }
  
  /**
   * Save wallet to storage
   */
  async saveWallet(wallet) {
    const filePath = path.join(this.config.storePath, `${wallet.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(wallet, null, 2));
  }
  
  /**
   * Load wallets from storage
   */
  async loadWallets() {
    try {
      const files = await fs.readdir(this.config.storePath);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.config.storePath, file);
          const data = await fs.readFile(filePath, 'utf8');
          const wallet = JSON.parse(data);
          
          this.wallets.set(wallet.id, wallet);
        }
      }
      
      logger.info(`Loaded ${this.wallets.size} wallets`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error('Failed to load wallets:', error);
      }
    }
  }
  
  /**
   * Notify signers of new transaction
   */
  notifySigners(wallet, transaction) {
    this.emit('notification:signers', {
      wallet,
      transaction,
      signers: wallet.signers.filter(s => 
        transaction.requiredSigners.includes(s.id)
      )
    });
  }
  
  /**
   * Start cleanup timer
   */
  startCleanupTimer() {
    setInterval(() => {
      const now = Date.now();
      
      for (const [id, transaction] of this.pendingTransactions) {
        if (transaction.status === 'pending' && now > transaction.expiresAt) {
          transaction.status = 'expired';
          this.pendingTransactions.delete(id);
          
          logger.info(`Transaction expired: ${id}`);
          this.emit('transaction:expired', transaction);
        }
      }
    }, 60000); // Check every minute
  }
  
  /**
   * Get wallet
   */
  getWallet(walletId) {
    return this.wallets.get(walletId);
  }
  
  /**
   * Get transaction
   */
  getTransaction(transactionId) {
    return this.pendingTransactions.get(transactionId);
  }
  
  /**
   * Get pending transactions for wallet
   */
  getPendingTransactions(walletId) {
    const transactions = [];
    
    for (const transaction of this.pendingTransactions.values()) {
      if (transaction.walletId === walletId && transaction.status === 'pending') {
        transactions.push(transaction);
      }
    }
    
    return transactions;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeWallets: this.wallets.size,
      pendingTransactions: this.pendingTransactions.size
    };
  }
  
  /**
   * Shutdown
   */
  async shutdown() {
    logger.info('Shutting down multi-signature wallet manager...');
    
    // Save all wallets
    for (const wallet of this.wallets.values()) {
      await this.saveWallet(wallet);
    }
    
    this.removeAllListeners();
    logger.info('Multi-signature wallet manager shutdown complete');
  }
}

/**
 * Create multi-sig wallet manager
 */
export function createMultiSigWalletManager(options) {
  return new MultiSigWalletManager(options);
}

export default {
  MultiSigWalletManager,
  createMultiSigWalletManager
};