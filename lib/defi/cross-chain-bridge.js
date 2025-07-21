/**
 * Cross-Chain Bridge Integration
 * Secure cross-chain asset transfers with multi-blockchain support
 */

import { EventEmitter } from 'events';
import { BigNumber, ethers } from 'ethers';
import { Logger } from '../logger.js';

// Supported blockchain networks
export const SupportedChains = {
  ETHEREUM: {
    id: 1,
    name: 'Ethereum',
    symbol: 'ETH',
    rpc: 'https://mainnet.infura.io/v3/',
    blockTime: 15000,
    confirmations: 12
  },
  BSC: {
    id: 56,
    name: 'Binance Smart Chain',
    symbol: 'BNB',
    rpc: 'https://bsc-dataseed.binance.org/',
    blockTime: 3000,
    confirmations: 15
  },
  POLYGON: {
    id: 137,
    name: 'Polygon',
    symbol: 'MATIC',
    rpc: 'https://polygon-rpc.com/',
    blockTime: 2000,
    confirmations: 20
  },
  AVALANCHE: {
    id: 43114,
    name: 'Avalanche',
    symbol: 'AVAX',
    rpc: 'https://api.avax.network/ext/bc/C/rpc',
    blockTime: 2000,
    confirmations: 15
  },
  FANTOM: {
    id: 250,
    name: 'Fantom',
    symbol: 'FTM',
    rpc: 'https://rpc.ftm.tools/',
    blockTime: 1000,
    confirmations: 10
  }
};

// Bridge transaction status
export const BridgeStatus = {
  PENDING: 'pending',
  LOCKED: 'locked',
  VALIDATED: 'validated',
  MINTED: 'minted',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

export class CrossChainBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = options.logger || new Logger('CrossChainBridge');
    this.options = {
      validatorThreshold: options.validatorThreshold || 0.67, // 67% consensus
      minValidators: options.minValidators || 3,
      maxValidators: options.maxValidators || 21,
      bridgeFee: options.bridgeFee || 0.001, // 0.1%
      minBridgeAmount: options.minBridgeAmount || BigNumber.from('1000000000000000000'), // 1 ETH
      maxBridgeAmount: options.maxBridgeAmount || BigNumber.from('100000000000000000000'), // 100 ETH
      confirmationTimeout: options.confirmationTimeout || 1800000, // 30 minutes
      ...options
    };
    
    // Network management
    this.providers = new Map();
    this.validators = new Map();
    this.bridgeContracts = new Map();
    
    // Bridge state
    this.bridgeTransactions = new Map();
    this.pendingTransactions = new Map();
    this.validatorSets = new Map();
    this.chainStates = new Map();
    
    // Atomic swap management
    this.swapContracts = new Map();
    this.activeSwaps = new Map();
    
    // Security
    this.rateLimiter = new RateLimiter();
    this.fraudDetector = new FraudDetector();
    
    // Statistics
    this.stats = {
      totalBridged: new Map(),
      totalFees: BigNumber.from(0),
      successfulTransfers: 0,
      failedTransfers: 0,
      averageProcessingTime: 0
    };
    
    // Initialize supported chains
    this.initializeChains();
    
    // Start background processes
    this.startValidatorMonitoring();
    this.startTransactionProcessing();
    this.startHealthChecks();
  }
  
  /**
   * Initialize blockchain connections
   */
  async initializeChains() {
    for (const [chainName, chainConfig] of Object.entries(SupportedChains)) {
      try {
        const provider = new ethers.providers.JsonRpcProvider(chainConfig.rpc);
        this.providers.set(chainConfig.id, provider);
        
        // Initialize chain state
        this.chainStates.set(chainConfig.id, {
          latestBlock: 0,
          isHealthy: false,
          lastUpdate: Date.now(),
          transactionCount: 0
        });
        
        // Test connection
        await provider.getBlockNumber();
        this.chainStates.get(chainConfig.id).isHealthy = true;
        
        this.logger.info(`Connected to ${chainName} (Chain ID: ${chainConfig.id})`);
        
      } catch (error) {
        this.logger.error(`Failed to connect to ${chainName}: ${error.message}`);
      }
    }
  }
  
  /**
   * Initiate cross-chain transfer
   */
  async initiateTransfer(fromChain, toChain, token, amount, recipient, options = {}) {
    const transferId = this.generateTransferId();
    const amountBN = BigNumber.from(amount);
    
    // Validate transfer parameters
    this.validateTransfer(fromChain, toChain, token, amountBN, recipient);
    
    // Check rate limits
    await this.rateLimiter.checkLimit(recipient, amountBN);
    
    // Calculate bridge fee
    const bridgeFee = amountBN.mul(Math.floor(this.options.bridgeFee * 10000)).div(10000);
    const amountAfterFee = amountBN.sub(bridgeFee);
    
    // Create bridge transaction
    const transaction = {
      id: transferId,
      fromChain,
      toChain,
      token,
      amount: amountBN,
      amountAfterFee,
      bridgeFee,
      recipient,
      sender: options.sender,
      status: BridgeStatus.PENDING,
      
      // Transaction hashes
      lockTxHash: null,
      mintTxHash: null,
      
      // Validation
      validatorSignatures: new Map(),
      validatorCount: 0,
      validationThreshold: Math.ceil(this.getValidatorCount(fromChain) * this.options.validatorThreshold),
      
      // Timestamps
      createdAt: Date.now(),
      lockedAt: null,
      validatedAt: null,
      completedAt: null,
      
      // Retry logic
      retryCount: 0,
      maxRetries: 3,
      
      // Metadata
      metadata: options.metadata || {}
    };
    
    this.bridgeTransactions.set(transferId, transaction);
    this.pendingTransactions.set(transferId, transaction);
    
    // Lock tokens on source chain
    await this.lockTokens(transaction);
    
    this.emit('transfer:initiated', {
      transferId,
      fromChain,
      toChain,
      token,
      amount: amountBN,
      recipient
    });
    
    return {
      transferId,
      estimatedTime: this.estimateTransferTime(fromChain, toChain),
      bridgeFee,
      amountAfterFee
    };
  }
  
  /**
   * Lock tokens on source chain
   */
  async lockTokens(transaction) {
    const { fromChain, token, amount, sender } = transaction;
    
    try {
      const provider = this.providers.get(fromChain);
      const bridgeContract = this.bridgeContracts.get(fromChain);
      
      if (!provider || !bridgeContract) {
        throw new Error(`Bridge contract not found for chain ${fromChain}`);
      }
      
      // Execute lock transaction
      const lockTx = await bridgeContract.lockTokens(
        token,
        amount,
        transaction.toChain,
        transaction.recipient,
        transaction.id
      );
      
      transaction.lockTxHash = lockTx.hash;
      transaction.status = BridgeStatus.LOCKED;
      transaction.lockedAt = Date.now();
      
      this.logger.info(`Tokens locked: ${transaction.id} - Hash: ${lockTx.hash}`);
      
      // Wait for confirmations
      await lockTx.wait(SupportedChains[fromChain]?.confirmations || 12);
      
      // Request validator signatures
      await this.requestValidatorSignatures(transaction);
      
      this.emit('tokens:locked', {
        transferId: transaction.id,
        txHash: lockTx.hash,
        fromChain,
        amount
      });
      
    } catch (error) {
      transaction.status = BridgeStatus.FAILED;
      this.logger.error(`Failed to lock tokens: ${error.message}`);
      this.emit('transfer:failed', { transferId: transaction.id, error: error.message });
    }
  }
  
  /**
   * Request validator signatures
   */
  async requestValidatorSignatures(transaction) {
    const validators = this.getValidators(transaction.fromChain);
    
    const validationPromises = validators.map(async (validator) => {
      try {
        const signature = await this.requestValidatorSignature(validator, transaction);
        
        if (signature) {
          transaction.validatorSignatures.set(validator.address, signature);
          transaction.validatorCount++;
          
          this.logger.debug(`Validator signature received: ${validator.address}`);
          
          // Check if we have enough signatures
          if (transaction.validatorCount >= transaction.validationThreshold) {
            await this.processValidatedTransaction(transaction);
          }
        }
        
      } catch (error) {
        this.logger.warn(`Validator signature failed: ${validator.address} - ${error.message}`);
      }
    });
    
    await Promise.allSettled(validationPromises);
  }
  
  /**
   * Request signature from individual validator
   */
  async requestValidatorSignature(validator, transaction) {
    // Construct validation message
    const message = this.constructValidationMessage(transaction);
    
    // Simulate validator signature (in production, use actual validator network)
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // Simulate validator reliability
        if (Math.random() < validator.reliability) {
          const signature = this.simulateValidatorSignature(validator, message);
          resolve(signature);
        } else {
          reject(new Error('Validator offline'));
        }
      }, 100 + Math.random() * 500);
    });
  }
  
  /**
   * Process validated transaction
   */
  async processValidatedTransaction(transaction) {
    if (transaction.status !== BridgeStatus.LOCKED) {
      return;
    }
    
    transaction.status = BridgeStatus.VALIDATED;
    transaction.validatedAt = Date.now();
    
    this.logger.info(`Transaction validated: ${transaction.id}`);
    
    // Mint tokens on destination chain
    await this.mintTokens(transaction);
    
    this.emit('transfer:validated', {
      transferId: transaction.id,
      validatorCount: transaction.validatorCount,
      threshold: transaction.validationThreshold
    });
  }
  
  /**
   * Mint tokens on destination chain
   */
  async mintTokens(transaction) {
    const { toChain, token, amountAfterFee, recipient } = transaction;
    
    try {
      const provider = this.providers.get(toChain);
      const bridgeContract = this.bridgeContracts.get(toChain);
      
      if (!provider || !bridgeContract) {
        throw new Error(`Bridge contract not found for chain ${toChain}`);
      }
      
      // Construct validator signatures for verification
      const signatures = Array.from(transaction.validatorSignatures.values());
      
      // Execute mint transaction
      const mintTx = await bridgeContract.mintTokens(
        token,
        amountAfterFee,
        recipient,
        transaction.id,
        signatures
      );
      
      transaction.mintTxHash = mintTx.hash;
      transaction.status = BridgeStatus.MINTED;
      
      this.logger.info(`Tokens minted: ${transaction.id} - Hash: ${mintTx.hash}`);
      
      // Wait for confirmations
      await mintTx.wait(SupportedChains[toChain]?.confirmations || 12);
      
      // Complete transaction
      await this.completeTransfer(transaction);
      
      this.emit('tokens:minted', {
        transferId: transaction.id,
        txHash: mintTx.hash,
        toChain,
        amount: amountAfterFee,
        recipient
      });
      
    } catch (error) {
      transaction.status = BridgeStatus.FAILED;
      this.logger.error(`Failed to mint tokens: ${error.message}`);
      
      // Attempt to refund on source chain
      await this.attemptRefund(transaction);
      
      this.emit('transfer:failed', { transferId: transaction.id, error: error.message });
    }
  }
  
  /**
   * Complete bridge transfer
   */
  async completeTransfer(transaction) {
    transaction.status = BridgeStatus.COMPLETED;
    transaction.completedAt = Date.now();
    
    // Remove from pending transactions
    this.pendingTransactions.delete(transaction.id);
    
    // Update statistics
    this.stats.successfulTransfers++;
    this.stats.totalFees = this.stats.totalFees.add(transaction.bridgeFee);
    
    const processingTime = transaction.completedAt - transaction.createdAt;
    this.stats.averageProcessingTime = 
      (this.stats.averageProcessingTime * (this.stats.successfulTransfers - 1) + processingTime) / 
      this.stats.successfulTransfers;
    
    // Update chain-specific stats
    const chainKey = `${transaction.fromChain}-${transaction.toChain}`;
    if (!this.stats.totalBridged.has(chainKey)) {
      this.stats.totalBridged.set(chainKey, BigNumber.from(0));
    }
    this.stats.totalBridged.set(chainKey, 
      this.stats.totalBridged.get(chainKey).add(transaction.amount)
    );
    
    this.logger.info(`Transfer completed: ${transaction.id} - Time: ${processingTime}ms`);
    
    this.emit('transfer:completed', {
      transferId: transaction.id,
      fromChain: transaction.fromChain,
      toChain: transaction.toChain,
      amount: transaction.amount,
      processingTime
    });
  }
  
  /**
   * Attempt refund on source chain
   */
  async attemptRefund(transaction) {
    try {
      const provider = this.providers.get(transaction.fromChain);
      const bridgeContract = this.bridgeContracts.get(transaction.fromChain);
      
      if (!provider || !bridgeContract) {
        throw new Error('Refund contract not found');
      }
      
      const refundTx = await bridgeContract.refundTokens(
        transaction.id,
        transaction.sender,
        transaction.amount
      );
      
      await refundTx.wait();
      
      this.logger.info(`Refund processed: ${transaction.id}`);
      this.emit('transfer:refunded', { transferId: transaction.id, txHash: refundTx.hash });
      
    } catch (error) {
      this.logger.error(`Refund failed: ${error.message}`);
    }
  }
  
  /**
   * Initiate atomic swap
   */
  async initiateAtomicSwap(chainA, chainB, tokenA, tokenB, amountA, amountB, counterparty, options = {}) {
    const swapId = this.generateSwapId();
    const timelock = Date.now() + (options.timeout || 3600000); // 1 hour default
    
    const atomicSwap = {
      id: swapId,
      chainA,
      chainB,
      tokenA,
      tokenB,
      amountA: BigNumber.from(amountA),
      amountB: BigNumber.from(amountB),
      counterparty,
      timelock,
      
      // Swap state
      status: 'initiated',
      hashlock: this.generateHashlock(),
      secret: null,
      
      // Transaction hashes
      lockTxA: null,
      lockTxB: null,
      claimTxA: null,
      claimTxB: null,
      
      // Timestamps
      createdAt: Date.now(),
      expiresAt: timelock
    };
    
    this.activeSwaps.set(swapId, atomicSwap);
    
    // Deploy swap contracts
    await this.deploySwapContracts(atomicSwap);
    
    this.emit('swap:initiated', {
      swapId,
      chainA,
      chainB,
      tokenA,
      tokenB,
      amountA,
      amountB,
      timelock
    });
    
    return {
      swapId,
      hashlock: atomicSwap.hashlock,
      timelock
    };
  }
  
  /**
   * Deploy atomic swap contracts
   */
  async deploySwapContracts(atomicSwap) {
    // Deploy contract on chain A
    const contractA = await this.deploySwapContract(
      atomicSwap.chainA,
      atomicSwap.tokenA,
      atomicSwap.amountA,
      atomicSwap.counterparty,
      atomicSwap.hashlock,
      atomicSwap.timelock
    );
    
    // Deploy contract on chain B
    const contractB = await this.deploySwapContract(
      atomicSwap.chainB,
      atomicSwap.tokenB,
      atomicSwap.amountB,
      atomicSwap.counterparty,
      atomicSwap.hashlock,
      atomicSwap.timelock
    );
    
    this.swapContracts.set(`${atomicSwap.id}-A`, contractA);
    this.swapContracts.set(`${atomicSwap.id}-B`, contractB);
    
    atomicSwap.status = 'contracts_deployed';
  }
  
  /**
   * Complete atomic swap
   */
  async completeAtomicSwap(swapId, secret) {
    const atomicSwap = this.activeSwaps.get(swapId);
    if (!atomicSwap) {
      throw new Error('Atomic swap not found');
    }
    
    // Verify secret matches hashlock
    if (!this.verifySecret(secret, atomicSwap.hashlock)) {
      throw new Error('Invalid secret');
    }
    
    atomicSwap.secret = secret;
    atomicSwap.status = 'completing';
    
    // Claim tokens on both chains
    await this.claimSwapTokens(atomicSwap);
    
    atomicSwap.status = 'completed';
    this.activeSwaps.delete(swapId);
    
    this.emit('swap:completed', {
      swapId,
      secret,
      completedAt: Date.now()
    });
  }
  
  /**
   * Validate transfer parameters
   */
  validateTransfer(fromChain, toChain, token, amount, recipient) {
    if (!SupportedChains[fromChain]) {
      throw new Error(`Unsupported source chain: ${fromChain}`);
    }
    
    if (!SupportedChains[toChain]) {
      throw new Error(`Unsupported destination chain: ${toChain}`);
    }
    
    if (fromChain === toChain) {
      throw new Error('Source and destination chains cannot be the same');
    }
    
    if (amount.lt(this.options.minBridgeAmount)) {
      throw new Error(`Amount below minimum: ${this.options.minBridgeAmount}`);
    }
    
    if (amount.gt(this.options.maxBridgeAmount)) {
      throw new Error(`Amount above maximum: ${this.options.maxBridgeAmount}`);
    }
    
    if (!ethers.utils.isAddress(recipient)) {
      throw new Error('Invalid recipient address');
    }
  }
  
  /**
   * Get validators for chain
   */
  getValidators(chainId) {
    if (!this.validatorSets.has(chainId)) {
      // Initialize default validator set
      this.validatorSets.set(chainId, this.generateDefaultValidators(chainId));
    }
    
    return this.validatorSets.get(chainId);
  }
  
  /**
   * Generate default validators
   */
  generateDefaultValidators(chainId) {
    const validators = [];
    
    for (let i = 0; i < this.options.minValidators; i++) {
      validators.push({
        address: ethers.Wallet.createRandom().address,
        publicKey: ethers.Wallet.createRandom().publicKey,
        reliability: 0.9 + Math.random() * 0.1,
        stake: BigNumber.from('1000000000000000000000'), // 1000 tokens
        isActive: true
      });
    }
    
    return validators;
  }
  
  /**
   * Get validator count for chain
   */
  getValidatorCount(chainId) {
    const validators = this.getValidators(chainId);
    return validators.filter(v => v.isActive).length;
  }
  
  /**
   * Start validator monitoring
   */
  startValidatorMonitoring() {
    setInterval(() => {
      for (const [chainId, validators] of this.validatorSets) {
        this.monitorValidators(chainId, validators);
      }
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Monitor validator health
   */
  monitorValidators(chainId, validators) {
    for (const validator of validators) {
      // Simulate validator health check
      const isHealthy = Math.random() > 0.05; // 95% uptime
      
      if (!isHealthy && validator.isActive) {
        validator.isActive = false;
        this.logger.warn(`Validator offline: ${validator.address}`);
        this.emit('validator:offline', { chainId, validator: validator.address });
      } else if (isHealthy && !validator.isActive) {
        validator.isActive = true;
        this.logger.info(`Validator online: ${validator.address}`);
        this.emit('validator:online', { chainId, validator: validator.address });
      }
    }
  }
  
  /**
   * Start transaction processing
   */
  startTransactionProcessing() {
    setInterval(() => {
      this.processTimeouts();
      this.retryFailedTransactions();
    }, 60000); // Every minute
  }
  
  /**
   * Process transaction timeouts
   */
  processTimeouts() {
    const now = Date.now();
    const timeout = this.options.confirmationTimeout;
    
    for (const [transferId, transaction] of this.pendingTransactions) {
      if (now - transaction.createdAt > timeout) {
        transaction.status = BridgeStatus.FAILED;
        this.pendingTransactions.delete(transferId);
        this.stats.failedTransfers++;
        
        this.logger.warn(`Transaction timeout: ${transferId}`);
        this.emit('transfer:timeout', { transferId });
        
        // Attempt refund
        this.attemptRefund(transaction);
      }
    }
  }
  
  /**
   * Retry failed transactions
   */
  retryFailedTransactions() {
    for (const [transferId, transaction] of this.pendingTransactions) {
      if (transaction.status === BridgeStatus.FAILED && 
          transaction.retryCount < transaction.maxRetries) {
        
        transaction.retryCount++;
        transaction.status = BridgeStatus.PENDING;
        
        this.logger.info(`Retrying transaction: ${transferId} (attempt ${transaction.retryCount})`);
        
        // Retry based on last successful step
        if (transaction.lockedAt) {
          this.requestValidatorSignatures(transaction);
        } else {
          this.lockTokens(transaction);
        }
      }
    }
  }
  
  /**
   * Start health checks
   */
  startHealthChecks() {
    setInterval(() => {
      this.checkChainHealth();
      this.updateNetworkStats();
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Check blockchain health
   */
  async checkChainHealth() {
    for (const [chainId, provider] of this.providers) {
      try {
        const blockNumber = await provider.getBlockNumber();
        const chainState = this.chainStates.get(chainId);
        
        chainState.latestBlock = blockNumber;
        chainState.isHealthy = true;
        chainState.lastUpdate = Date.now();
        
      } catch (error) {
        const chainState = this.chainStates.get(chainId);
        chainState.isHealthy = false;
        
        this.logger.error(`Chain ${chainId} health check failed: ${error.message}`);
        this.emit('chain:unhealthy', { chainId, error: error.message });
      }
    }
  }
  
  /**
   * Helper methods
   */
  
  generateTransferId() {
    return `bridge_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateSwapId() {
    return `swap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateHashlock() {
    return ethers.utils.keccak256(ethers.utils.randomBytes(32));
  }
  
  constructValidationMessage(transaction) {
    return ethers.utils.solidityKeccak256(
      ['string', 'uint256', 'uint256', 'address', 'address', 'uint256'],
      [
        transaction.id,
        transaction.fromChain,
        transaction.toChain,
        transaction.token,
        transaction.recipient,
        transaction.amount
      ]
    );
  }
  
  simulateValidatorSignature(validator, message) {
    // Simulate signature - in production use actual cryptographic signatures
    return {
      r: ethers.utils.randomBytes(32),
      s: ethers.utils.randomBytes(32),
      v: 27 + Math.floor(Math.random() * 2),
      validator: validator.address,
      timestamp: Date.now()
    };
  }
  
  estimateTransferTime(fromChain, toChain) {
    const fromChainConfig = Object.values(SupportedChains).find(c => c.id === fromChain);
    const toChainConfig = Object.values(SupportedChains).find(c => c.id === toChain);
    
    const fromConfirmationTime = fromChainConfig.blockTime * fromChainConfig.confirmations;
    const toConfirmationTime = toChainConfig.blockTime * toChainConfig.confirmations;
    const validationTime = 60000; // 1 minute for validator consensus
    
    return fromConfirmationTime + validationTime + toConfirmationTime;
  }
  
  verifySecret(secret, hashlock) {
    return ethers.utils.keccak256(secret) === hashlock;
  }
  
  updateNetworkStats() {
    // Update bridge statistics
    this.emit('stats:updated', this.getStats());
  }
  
  /**
   * Get bridge statistics
   */
  getStats() {
    return {
      ...this.stats,
      pendingTransactions: this.pendingTransactions.size,
      activeSwaps: this.activeSwaps.size,
      supportedChains: Object.keys(SupportedChains).length,
      healthyChains: Array.from(this.chainStates.values()).filter(s => s.isHealthy).length,
      successRate: this.stats.successfulTransfers / (this.stats.successfulTransfers + this.stats.failedTransfers) || 0
    };
  }
  
  /**
   * Get transaction status
   */
  getTransactionStatus(transferId) {
    const transaction = this.bridgeTransactions.get(transferId);
    if (!transaction) {
      return null;
    }
    
    return {
      id: transaction.id,
      status: transaction.status,
      fromChain: transaction.fromChain,
      toChain: transaction.toChain,
      amount: transaction.amount,
      recipient: transaction.recipient,
      lockTxHash: transaction.lockTxHash,
      mintTxHash: transaction.mintTxHash,
      validatorCount: transaction.validatorCount,
      validationThreshold: transaction.validationThreshold,
      createdAt: transaction.createdAt,
      estimatedCompletion: transaction.createdAt + this.estimateTransferTime(transaction.fromChain, transaction.toChain)
    };
  }
  
  // Placeholder methods for complex implementations
  deploySwapContract(chainId, token, amount, counterparty, hashlock, timelock) {
    return Promise.resolve({ address: ethers.Wallet.createRandom().address });
  }
  
  claimSwapTokens(atomicSwap) {
    return Promise.resolve();
  }
}

/**
 * Rate Limiter for bridge security
 */
class RateLimiter {
  constructor() {
    this.userLimits = new Map();
    this.globalLimit = {
      hourly: BigNumber.from('1000000000000000000000'), // 1000 ETH per hour
      daily: BigNumber.from('10000000000000000000000'), // 10000 ETH per day
      hourlyUsed: BigNumber.from(0),
      dailyUsed: BigNumber.from(0),
      hourlyReset: Date.now() + 3600000,
      dailyReset: Date.now() + 86400000
    };
  }
  
  async checkLimit(user, amount) {
    // Check global limits
    this.updateGlobalLimits();
    
    if (this.globalLimit.hourlyUsed.add(amount).gt(this.globalLimit.hourly)) {
      throw new Error('Global hourly limit exceeded');
    }
    
    if (this.globalLimit.dailyUsed.add(amount).gt(this.globalLimit.daily)) {
      throw new Error('Global daily limit exceeded');
    }
    
    // Check user limits
    const userLimit = this.getUserLimit(user);
    
    if (userLimit.hourlyUsed.add(amount).gt(userLimit.hourly)) {
      throw new Error('User hourly limit exceeded');
    }
    
    if (userLimit.dailyUsed.add(amount).gt(userLimit.daily)) {
      throw new Error('User daily limit exceeded');
    }
    
    // Update usage
    this.globalLimit.hourlyUsed = this.globalLimit.hourlyUsed.add(amount);
    this.globalLimit.dailyUsed = this.globalLimit.dailyUsed.add(amount);
    userLimit.hourlyUsed = userLimit.hourlyUsed.add(amount);
    userLimit.dailyUsed = userLimit.dailyUsed.add(amount);
  }
  
  getUserLimit(user) {
    if (!this.userLimits.has(user)) {
      this.userLimits.set(user, {
        hourly: BigNumber.from('10000000000000000000'), // 10 ETH per hour
        daily: BigNumber.from('100000000000000000000'), // 100 ETH per day
        hourlyUsed: BigNumber.from(0),
        dailyUsed: BigNumber.from(0),
        hourlyReset: Date.now() + 3600000,
        dailyReset: Date.now() + 86400000
      });
    }
    
    return this.userLimits.get(user);
  }
  
  updateGlobalLimits() {
    const now = Date.now();
    
    if (now > this.globalLimit.hourlyReset) {
      this.globalLimit.hourlyUsed = BigNumber.from(0);
      this.globalLimit.hourlyReset = now + 3600000;
    }
    
    if (now > this.globalLimit.dailyReset) {
      this.globalLimit.dailyUsed = BigNumber.from(0);
      this.globalLimit.dailyReset = now + 86400000;
    }
  }
}

/**
 * Fraud Detection System
 */
class FraudDetector {
  constructor() {
    this.suspiciousTransactions = new Map();
    this.userProfiles = new Map();
  }
  
  analyzeTransaction(transaction) {
    // Implement fraud detection logic
    const riskScore = this.calculateRiskScore(transaction);
    
    if (riskScore > 0.8) {
      this.flagTransaction(transaction, 'High risk score');
      return false;
    }
    
    return true;
  }
  
  calculateRiskScore(transaction) {
    let score = 0;
    
    // Check transaction size
    if (transaction.amount.gt(BigNumber.from('100000000000000000000'))) {
      score += 0.3;
    }
    
    // Check frequency
    const userProfile = this.getUserProfile(transaction.sender);
    if (userProfile.transactionCount > 10) {
      score += 0.2;
    }
    
    // Check time patterns
    if (this.isOffHours(transaction.createdAt)) {
      score += 0.1;
    }
    
    return score;
  }
  
  flagTransaction(transaction, reason) {
    this.suspiciousTransactions.set(transaction.id, {
      transaction,
      reason,
      timestamp: Date.now()
    });
  }
  
  getUserProfile(user) {
    if (!this.userProfiles.has(user)) {
      this.userProfiles.set(user, {
        transactionCount: 0,
        totalVolume: BigNumber.from(0),
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        riskScore: 0
      });
    }
    
    return this.userProfiles.get(user);
  }
  
  isOffHours(timestamp) {
    const hour = new Date(timestamp).getHours();
    return hour < 6 || hour > 22; // 6 AM to 10 PM
  }
}