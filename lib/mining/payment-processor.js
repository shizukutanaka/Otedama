/**
 * Payment Processor
 * Simple PPLNS/PPS payment system for mining pool
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');
const CreatorFeeManager = require('../fees/creator-fee-manager');
const AddressValidator = require('../security/address-validator');

const logger = createLogger('payment-processor');

// Payment schemes
const PaymentScheme = {
  PPLNS: 'pplns', // Pay Per Last N Shares
  PPS: 'pps',     // Pay Per Share
  PROP: 'prop'    // Proportional
};

class PaymentProcessor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      scheme: options.scheme || PaymentScheme.PPLNS,
      interval: options.interval || 3600000, // 1 hour
      minPayout: options.minPayout || 0.001,
      fee: options.fee || 0.01, // 1%
      pplnsWindow: options.pplnsWindow || 10000, // Last 10000 shares
      ppsRate: options.ppsRate || 0.00000001, // BTC per share
      confirmations: options.confirmations || 6,
      ...options
    };
    
    // Payment queue
    this.pendingPayments = new Map();
    this.completedPayments = new Map();
    
    // Share tracking for PPLNS
    this.shareWindow = [];
    this.totalShares = 0;
    
    // Block rewards
    this.pendingBlocks = new Map();
    this.confirmedBlocks = new Map();
    
    // Miner balances
    this.balances = new Map();
    
    // Payment timer
    this.paymentTimer = null;
    
    // Validate creator address
    const creatorAddress = options.creatorAddress || process.env.CREATOR_WALLET_ADDRESS || '1GzHriuokSrZYAZEEWoL7eeCCXsX3WyLHa';
    AddressValidator.enforce(creatorAddress);
    
    // Creator fee manager
    this.creatorFeeManager = new CreatorFeeManager({
      creatorAddress: creatorAddress,
      dynamicFees: options.dynamicFees !== false
    });
    
    logger.info('Payment processor initialized', {
      scheme: this.options.scheme,
      minPayout: this.options.minPayout,
      fee: this.options.fee,
      creatorFeeEnabled: this.creatorFeeManager.options.creatorAddress ? true : false
    });
  }
  
  /**
   * Start payment processing
   */
  start() {
    // Start creator fee manager
    this.creatorFeeManager.start();
    
    // Set up periodic payments
    this.paymentTimer = setInterval(() => {
      this.processPayments().catch(err => {
        logger.error('Payment processing failed:', err);
      });
    }, this.options.interval);
    
    logger.info('Payment processor started');
  }
  
  /**
   * Stop payment processing
   */
  stop() {
    if (this.paymentTimer) {
      clearInterval(this.paymentTimer);
      this.paymentTimer = null;
    }
    
    // Stop creator fee manager
    this.creatorFeeManager.stop();
    
    logger.info('Payment processor stopped');
  }
  
  /**
   * Record a share
   */
  recordShare(minerAddress, difficulty, isValid) {
    if (!isValid) return;
    
    const share = {
      address: minerAddress,
      difficulty,
      timestamp: Date.now()
    };
    
    // Update miner count for fee calculation
    const uniqueMiners = new Set(this.shareWindow.map(s => s.address));
    uniqueMiners.add(minerAddress);
    this.creatorFeeManager.updateMinerCount(uniqueMiners.size);
    
    // Add to share window for PPLNS
    if (this.options.scheme === PaymentScheme.PPLNS) {
      this.shareWindow.push(share);
      
      // Maintain window size
      while (this.shareWindow.length > this.options.pplnsWindow) {
        this.shareWindow.shift();
      }
    }
    
    // Update total shares
    this.totalShares++;
    
    // Update miner balance for PPS
    if (this.options.scheme === PaymentScheme.PPS) {
      const reward = this.options.ppsRate * difficulty;
      this.addBalance(minerAddress, reward);
    }
  }
  
  /**
   * Record a found block
   */
  recordBlock(block) {
    const blockData = {
      height: block.height,
      hash: block.hash,
      reward: block.reward,
      foundBy: block.minerAddress,
      timestamp: Date.now(),
      confirmations: 0
    };
    
    this.pendingBlocks.set(block.hash, blockData);
    
    logger.info('Block found', {
      height: block.height,
      hash: block.hash,
      reward: block.reward,
      foundBy: block.minerAddress
    });
    
    this.emit('block-found', blockData);
  }
  
  /**
   * Update block confirmations
   */
  updateBlockConfirmations(blockHash, confirmations) {
    const block = this.pendingBlocks.get(blockHash);
    if (!block) return;
    
    block.confirmations = confirmations;
    
    // Move to confirmed if enough confirmations
    if (confirmations >= this.options.confirmations) {
      this.pendingBlocks.delete(blockHash);
      this.confirmedBlocks.set(blockHash, block);
      
      // Distribute block reward
      this.distributeBlockReward(block);
      
      logger.info('Block confirmed', {
        hash: blockHash,
        confirmations
      });
    }
  }
  
  /**
   * Distribute block reward
   */
  distributeBlockReward(block) {
    // Process block reward with creator fee
    const feeBreakdown = this.creatorFeeManager.processBlockReward(
      block.reward,
      this.options.fee
    );
    
    const netReward = feeBreakdown.minerReward;
    
    switch (this.options.scheme) {
      case PaymentScheme.PPLNS:
        this.distributePPLNS(netReward);
        break;
        
      case PaymentScheme.PROP:
        this.distributeProp(netReward, block);
        break;
        
      case PaymentScheme.PPS:
        // PPS doesn't distribute block rewards
        // Miners are already paid per share
        this.addBalance(this.options.poolAddress, netReward);
        break;
    }
    
    // Add operational fee to pool address
    if (this.options.poolAddress && feeBreakdown.operationalFeeAmount > 0) {
      this.addBalance(this.options.poolAddress, feeBreakdown.operationalFeeAmount);
    }
    
    // Add creator fee to creator address
    if (feeBreakdown.creatorAddress && feeBreakdown.creatorFeeAmount > 0) {
      this.addBalance(feeBreakdown.creatorAddress, feeBreakdown.creatorFeeAmount);
    }
    
    logger.info('Block reward distributed', {
      blockReward: block.reward,
      minerReward: netReward,
      creatorFee: feeBreakdown.creatorFeeAmount,
      operationalFee: feeBreakdown.operationalFeeAmount
    });
  }
  
  /**
   * PPLNS distribution
   */
  distributePPLNS(reward) {
    if (this.shareWindow.length === 0) return;
    
    // Calculate total difficulty in window
    const totalDifficulty = this.shareWindow.reduce((sum, share) => {
      return sum + share.difficulty;
    }, 0);
    
    // Group shares by address
    const minerShares = new Map();
    for (const share of this.shareWindow) {
      const current = minerShares.get(share.address) || 0;
      minerShares.set(share.address, current + share.difficulty);
    }
    
    // Distribute reward proportionally
    for (const [address, difficulty] of minerShares) {
      const proportion = difficulty / totalDifficulty;
      const minerReward = reward * proportion;
      this.addBalance(address, minerReward);
    }
  }
  
  /**
   * Proportional distribution
   */
  distributeProp(reward, block) {
    // In a real implementation, track shares since last block
    // For now, use current share window
    this.distributePPLNS(reward);
  }
  
  /**
   * Add to miner balance
   */
  addBalance(address, amount) {
    const current = this.balances.get(address) || 0;
    this.balances.set(address, current + amount);
  }
  
  /**
   * Process pending payments
   */
  async processPayments(addressManager = null) {
    const payments = [];
    const paymentsByAddress = new Map();
    
    // If we have an address manager, group balances by payment address
    if (addressManager) {
      // First, aggregate balances by payment address
      for (const [minerId, balance] of this.balances) {
        if (balance > 0) {
          const paymentAddress = addressManager.getPaymentAddress(minerId);
          if (paymentAddress) {
            const current = paymentsByAddress.get(paymentAddress) || 0;
            paymentsByAddress.set(paymentAddress, current + balance);
          }
        }
      }
      
      // Create payments for aggregated balances
      for (const [address, totalBalance] of paymentsByAddress) {
        if (totalBalance >= this.options.minPayout) {
          payments.push({
            address,
            amount: totalBalance,
            timestamp: Date.now(),
            miners: addressManager.getMinersByPaymentAddress(address).map(m => m.id)
          });
          
          // Reset balances for all miners using this payment address
          for (const miner of addressManager.getMinersByPaymentAddress(address)) {
            this.balances.set(miner.id, 0);
          }
        }
      }
    } else {
      // Fallback: treat keys as addresses (backward compatibility)
      for (const [address, balance] of this.balances) {
        if (balance >= this.options.minPayout) {
          payments.push({
            address,
            amount: balance,
            timestamp: Date.now()
          });
          
          // Reset balance
          this.balances.set(address, 0);
        }
      }
    }
    
    if (payments.length === 0) return;
    
    logger.info(`Processing ${payments.length} payments to ${payments.length} addresses`);
    
    // Emit payment batch for processing
    this.emit('payment-batch', payments, (results) => {
      // Handle payment results
      for (const result of results) {
        if (result.success) {
          this.completedPayments.set(result.txid, {
            address: result.address,
            amount: result.amount,
            txid: result.txid,
            timestamp: Date.now(),
            miners: result.miners
          });
        } else {
          // Return balance on failure
          if (result.miners && addressManager) {
            // Return balance to individual miners
            const amountPerMiner = result.amount / result.miners.length;
            for (const minerId of result.miners) {
              this.addBalance(minerId, amountPerMiner);
            }
          } else {
            // Fallback
            this.addBalance(result.address, result.amount);
          }
          
          logger.error('Payment failed', {
            address: result.address,
            error: result.error
          });
        }
      }
    });
  }
  
  /**
   * Get miner statistics
   */
  getMinerStats(address) {
    const balance = this.balances.get(address) || 0;
    
    // Count shares in window
    let sharesInWindow = 0;
    let difficultyInWindow = 0;
    
    if (this.options.scheme === PaymentScheme.PPLNS) {
      for (const share of this.shareWindow) {
        if (share.address === address) {
          sharesInWindow++;
          difficultyInWindow += share.difficulty;
        }
      }
    }
    
    // Get payment history
    const payments = [];
    for (const payment of this.completedPayments.values()) {
      if (payment.address === address) {
        payments.push(payment);
      }
    }
    
    return {
      address,
      balance,
      sharesInWindow,
      difficultyInWindow,
      payments: payments.slice(-10), // Last 10 payments
      scheme: this.options.scheme
    };
  }
  
  /**
   * Get payment statistics
   */
  getStats() {
    let totalPending = 0;
    let minerCount = 0;
    
    for (const balance of this.balances.values()) {
      if (balance > 0) {
        totalPending += balance;
        minerCount++;
      }
    }
    
    return {
      scheme: this.options.scheme,
      totalShares: this.totalShares,
      shareWindowSize: this.shareWindow.length,
      pendingBlocks: this.pendingBlocks.size,
      confirmedBlocks: this.confirmedBlocks.size,
      totalPending,
      minerCount,
      completedPayments: this.completedPayments.size,
      minPayout: this.options.minPayout,
      fee: this.options.fee,
      creatorFeeStats: this.creatorFeeManager.getStats()
    };
  }
  
  /**
   * Manual payout trigger
   */
  async triggerPayout(address) {
    const balance = this.balances.get(address);
    if (!balance || balance === 0) {
      throw new Error('No balance for address');
    }
    
    const payment = {
      address,
      amount: balance,
      timestamp: Date.now(),
      manual: true
    };
    
    // Reset balance
    this.balances.set(address, 0);
    
    // Process single payment
    this.emit('payment-batch', [payment], (results) => {
      const result = results[0];
      if (result.success) {
        this.completedPayments.set(result.txid, {
          address: result.address,
          amount: result.amount,
          txid: result.txid,
          timestamp: Date.now()
        });
      } else {
        // Return balance on failure
        this.addBalance(result.address, result.amount);
        throw new Error(result.error);
      }
    });
  }
}

module.exports = PaymentProcessor;