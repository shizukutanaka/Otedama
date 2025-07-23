const EventEmitter = require('events');
const crypto = require('crypto');
const { BigNumber } = require('bignumber.js');

class PaymentProcessor extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    
    this.pool = pool;
    this.config = {
      // Payment settings
      paymentInterval: options.paymentInterval || 3600000, // 1 hour
      minPayment: options.minPayment || 0.001,
      txFeeReserve: options.txFeeReserve || 0.0001,
      maxTxSize: options.maxTxSize || 100000, // bytes
      maxOutputsPerTx: options.maxOutputsPerTx || 100,
      
      // Payment schemes
      paymentScheme: options.paymentScheme || 'PPLNS', // PPLNS, PPS, PROP
      pplnsWindow: options.pplnsWindow || 3600000, // 1 hour
      ppsFee: options.ppsFee || 0.04, // 4% PPS fee
      
      // Database/Storage
      persistence: options.persistence !== false,
      dbPath: options.dbPath || './payments.db',
      
      // Security
      confirmations: options.confirmations || 10,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 300000 // 5 minutes
    };
    
    // Payment state
    this.pendingPayments = new Map();
    this.processedPayments = new Map();
    this.balances = new Map();
    this.shareLog = [];
    this.blockRewards = new Map();
    
    // Statistics
    this.stats = {
      totalPaid: new BigNumber(0),
      totalBlocks: 0,
      totalTxFees: new BigNumber(0),
      paymentsProcessed: 0,
      paymentsFailed: 0
    };
    
    this.isProcessing = false;
  }
  
  async initialize() {
    try {
      // Load persistent data
      if (this.config.persistence) {
        await this.loadPaymentData();
      }
      
      // Start payment processor
      this.startPaymentProcessor();
      
      // Set up pool event listeners
      this.setupPoolListeners();
      
      this.emit('initialized', {
        paymentScheme: this.config.paymentScheme,
        minPayment: this.config.minPayment
      });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  setupPoolListeners() {
    // Listen for valid shares
    this.pool.on('validShare', (share) => {
      this.recordShare(share);
    });
    
    // Listen for found blocks
    this.pool.on('blockFound', (block) => {
      this.addBlockReward(block);
    });
    
    // Listen for block confirmations
    this.pool.on('blockConfirmed', (block) => {
      this.processBlockReward(block);
    });
  }
  
  recordShare(shareData) {
    const share = {
      minerId: shareData.minerId,
      difficulty: shareData.difficulty,
      timestamp: Date.now(),
      blockHeight: shareData.blockHeight
    };
    
    // Add to share log
    this.shareLog.push(share);
    
    // Trim old shares based on payment scheme
    this.trimShareLog();
    
    // Update miner statistics
    this.updateMinerStats(share);
  }
  
  trimShareLog() {
    const cutoff = Date.now() - this.config.pplnsWindow;
    
    if (this.config.paymentScheme === 'PPLNS') {
      this.shareLog = this.shareLog.filter(share => 
        share.timestamp > cutoff
      );
    } else if (this.config.paymentScheme === 'PROP') {
      // Keep shares since last block
      const lastBlockTime = this.getLastBlockTime();
      this.shareLog = this.shareLog.filter(share => 
        share.timestamp > lastBlockTime
      );
    }
    // PPS doesn't need share log
  }
  
  updateMinerStats(share) {
    const miner = this.pool.miners.get(share.minerId);
    if (!miner) return;
    
    // Update hashrate estimation
    const window = 300000; // 5 minutes
    const recentShares = this.shareLog.filter(s => 
      s.minerId === share.minerId && 
      s.timestamp > Date.now() - window
    );
    
    const totalDifficulty = recentShares.reduce((sum, s) => 
      sum + s.difficulty, 0
    );
    
    const hashrate = (totalDifficulty * Math.pow(2, 32)) / (window / 1000);
    miner.hashrate = hashrate;
  }
  
  addBlockReward(block) {
    this.blockRewards.set(block.hash, {
      ...block,
      status: 'pending',
      confirmations: 0,
      addedAt: Date.now()
    });
    
    this.stats.totalBlocks++;
    
    this.emit('blockRewardAdded', {
      blockHash: block.hash,
      height: block.height,
      reward: block.reward
    });
  }
  
  async processBlockReward(block) {
    const blockReward = this.blockRewards.get(block.hash);
    if (!blockReward || blockReward.status !== 'pending') return;
    
    // Update confirmations
    blockReward.confirmations = block.confirmations;
    
    // Check if enough confirmations
    if (blockReward.confirmations < this.config.confirmations) {
      return;
    }
    
    // Mark as confirmed
    blockReward.status = 'confirmed';
    
    // Calculate payments based on scheme
    let payments;
    switch (this.config.paymentScheme) {
      case 'PPLNS':
        payments = await this.calculatePPLNSPayments(blockReward);
        break;
        
      case 'PPS':
        payments = await this.calculatePPSPayments(blockReward);
        break;
        
      case 'PROP':
        payments = await this.calculatePROPPayments(blockReward);
        break;
        
      default:
        throw new Error(`Unknown payment scheme: ${this.config.paymentScheme}`);
    }
    
    // Add to pending payments
    this.addPendingPayments(payments, blockReward);
    
    this.emit('blockRewardProcessed', {
      blockHash: block.hash,
      totalPayments: payments.length,
      totalAmount: payments.reduce((sum, p) => sum.plus(p.amount), new BigNumber(0)).toString()
    });
  }
  
  async calculatePPLNSPayments(block) {
    const payments = [];
    const window = Date.now() - this.config.pplnsWindow;
    
    // Get shares in PPLNS window
    const validShares = this.shareLog.filter(share => 
      share.timestamp > window
    );
    
    if (validShares.length === 0) return payments;
    
    // Calculate total difficulty
    const totalDifficulty = validShares.reduce((sum, share) => 
      sum.plus(share.difficulty), new BigNumber(0)
    );
    
    // Group shares by miner
    const minerShares = new Map();
    for (const share of validShares) {
      const current = minerShares.get(share.minerId) || new BigNumber(0);
      minerShares.set(share.minerId, current.plus(share.difficulty));
    }
    
    // Calculate payments
    const netReward = this.calculateNetReward(block);
    
    for (const [minerId, difficulty] of minerShares) {
      const miner = this.pool.miners.get(minerId);
      if (!miner) continue;
      
      const share = difficulty.dividedBy(totalDifficulty);
      const amount = netReward.multipliedBy(share);
      
      if (amount.isGreaterThan(0)) {
        payments.push({
          minerId,
          address: miner.address,
          amount,
          share: share.toNumber()
        });
      }
    }
    
    return payments;
  }
  
  async calculatePPSPayments(block) {
    const payments = [];
    
    // PPS pays immediately per share, not per block
    // This would typically be handled differently
    
    // Get recent shares
    const recentShares = this.shareLog.filter(share => 
      share.timestamp > Date.now() - 3600000 // Last hour
    );
    
    // Group by miner
    const minerShares = new Map();
    for (const share of recentShares) {
      const current = minerShares.get(share.minerId) || { count: 0, difficulty: new BigNumber(0) };
      current.count++;
      current.difficulty = current.difficulty.plus(share.difficulty);
      minerShares.set(share.minerId, current);
    }
    
    // Calculate expected value per share
    const blockValue = new BigNumber(block.reward);
    const networkDifficulty = new BigNumber(block.networkDifficulty);
    const expectedValue = blockValue.dividedBy(networkDifficulty);
    
    // Apply PPS fee
    const ppsRate = expectedValue.multipliedBy(1 - this.config.ppsFee);
    
    for (const [minerId, stats] of minerShares) {
      const miner = this.pool.miners.get(minerId);
      if (!miner) continue;
      
      const amount = ppsRate.multipliedBy(stats.difficulty);
      
      if (amount.isGreaterThan(0)) {
        payments.push({
          minerId,
          address: miner.address,
          amount,
          shares: stats.count
        });
      }
    }
    
    return payments;
  }
  
  async calculatePROPPayments(block) {
    const payments = [];
    
    // Get shares since last block
    const lastBlockTime = this.getLastBlockTime();
    const roundShares = this.shareLog.filter(share => 
      share.timestamp > lastBlockTime
    );
    
    if (roundShares.length === 0) return payments;
    
    // Calculate proportional payments
    const totalShares = roundShares.length;
    const shareValue = this.calculateNetReward(block).dividedBy(totalShares);
    
    // Group by miner
    const minerShareCounts = new Map();
    for (const share of roundShares) {
      const current = minerShareCounts.get(share.minerId) || 0;
      minerShareCounts.set(share.minerId, current + 1);
    }
    
    for (const [minerId, shareCount] of minerShareCounts) {
      const miner = this.pool.miners.get(minerId);
      if (!miner) continue;
      
      const amount = shareValue.multipliedBy(shareCount);
      
      if (amount.isGreaterThan(0)) {
        payments.push({
          minerId,
          address: miner.address,
          amount,
          shares: shareCount
        });
      }
    }
    
    return payments;
  }
  
  calculateNetReward(block) {
    const totalReward = new BigNumber(block.reward);
    const poolFee = totalReward.multipliedBy(this.pool.config.pool.fee);
    return totalReward.minus(poolFee);
  }
  
  addPendingPayments(payments, block) {
    for (const payment of payments) {
      // Add to miner balance
      const currentBalance = this.balances.get(payment.address) || new BigNumber(0);
      this.balances.set(payment.address, currentBalance.plus(payment.amount));
      
      // Record payment details
      const paymentId = this.generatePaymentId();
      this.pendingPayments.set(paymentId, {
        id: paymentId,
        ...payment,
        blockHash: block.hash,
        blockHeight: block.height,
        status: 'pending',
        createdAt: Date.now()
      });
    }
  }
  
  startPaymentProcessor() {
    // Process payments periodically
    setInterval(async () => {
      if (!this.isProcessing) {
        await this.processPayments();
      }
    }, this.config.paymentInterval);
    
    // Also process when balance threshold reached
    this.on('balanceThresholdReached', async () => {
      if (!this.isProcessing) {
        await this.processPayments();
      }
    });
  }
  
  async processPayments() {
    this.isProcessing = true;
    
    try {
      // Get miners with sufficient balance
      const payableMinerss = this.getPayableMiners();
      
      if (payableMiners.length === 0) {
        this.isProcessing = false;
        return;
      }
      
      // Group into transactions
      const transactions = this.groupIntoTransactions(payableMiners);
      
      // Process each transaction
      for (const tx of transactions) {
        await this.processTransaction(tx);
      }
      
      this.emit('paymentsProcessed', {
        transactions: transactions.length,
        totalMiners: payableMiners.length
      });
      
    } catch (error) {
      this.emit('error', { type: 'payment', error });
    } finally {
      this.isProcessing = false;
    }
  }
  
  getPayableMiners() {
    const payable = [];
    
    for (const [address, balance] of this.balances) {
      if (balance.isGreaterThanOrEqualTo(this.config.minPayment)) {
        payable.push({
          address,
          amount: balance
        });
      }
    }
    
    return payable;
  }
  
  groupIntoTransactions(miners) {
    const transactions = [];
    let currentTx = {
      outputs: [],
      totalAmount: new BigNumber(0),
      estimatedSize: 0
    };
    
    for (const miner of miners) {
      // Estimate size with this output
      const outputSize = 34 + miner.address.length; // Simplified
      const newSize = currentTx.estimatedSize + outputSize;
      
      // Check limits
      if (currentTx.outputs.length >= this.config.maxOutputsPerTx ||
          newSize > this.config.maxTxSize) {
        // Start new transaction
        transactions.push(currentTx);
        currentTx = {
          outputs: [],
          totalAmount: new BigNumber(0),
          estimatedSize: 200 // Base tx size
        };
      }
      
      currentTx.outputs.push({
        address: miner.address,
        amount: miner.amount
      });
      currentTx.totalAmount = currentTx.totalAmount.plus(miner.amount);
      currentTx.estimatedSize = newSize;
    }
    
    if (currentTx.outputs.length > 0) {
      transactions.push(currentTx);
    }
    
    return transactions;
  }
  
  async processTransaction(tx) {
    const txId = this.generateTransactionId();
    
    try {
      // Reserve fee
      const fee = this.calculateTransactionFee(tx);
      tx.fee = fee;
      
      // Create and sign transaction
      const rawTx = await this.createTransaction(tx);
      
      // Broadcast transaction
      const result = await this.broadcastTransaction(rawTx);
      
      if (result.success) {
        // Update balances
        for (const output of tx.outputs) {
          const currentBalance = this.balances.get(output.address);
          this.balances.set(output.address, currentBalance.minus(output.amount));
          
          // Record processed payment
          this.recordProcessedPayment({
            txId: result.txId,
            address: output.address,
            amount: output.amount,
            timestamp: Date.now()
          });
        }
        
        // Update stats
        this.stats.totalPaid = this.stats.totalPaid.plus(tx.totalAmount);
        this.stats.totalTxFees = this.stats.totalTxFees.plus(fee);
        this.stats.paymentsProcessed += tx.outputs.length;
        
        this.emit('transactionBroadcast', {
          txId: result.txId,
          outputs: tx.outputs.length,
          totalAmount: tx.totalAmount.toString()
        });
      } else {
        throw new Error(result.error || 'Transaction broadcast failed');
      }
      
    } catch (error) {
      this.stats.paymentsFailed += tx.outputs.length;
      
      this.emit('transactionFailed', {
        txId,
        error: error.message,
        outputs: tx.outputs.length
      });
      
      // Retry logic
      await this.scheduleRetry(tx);
    }
  }
  
  calculateTransactionFee(tx) {
    // Simplified fee calculation
    const feePerByte = new BigNumber(0.00000001); // 1 satoshi per byte
    return feePerByte.multipliedBy(tx.estimatedSize);
  }
  
  async createTransaction(tx) {
    // This would interface with actual blockchain
    // Simplified transaction creation
    return {
      version: 2,
      inputs: [], // Would be filled with pool's UTXOs
      outputs: tx.outputs.map(out => ({
        value: out.amount.toString(),
        script: this.addressToScript(out.address)
      })),
      lockTime: 0
    };
  }
  
  async broadcastTransaction(rawTx) {
    // This would broadcast to actual blockchain
    // Simplified for demonstration
    return {
      success: true,
      txId: crypto.randomBytes(32).toString('hex')
    };
  }
  
  addressToScript(address) {
    // Convert address to output script
    // Simplified
    return Buffer.from(address, 'utf8');
  }
  
  recordProcessedPayment(payment) {
    const record = {
      ...payment,
      id: this.generatePaymentId()
    };
    
    this.processedPayments.set(record.id, record);
    
    // Persist if enabled
    if (this.config.persistence) {
      this.savePaymentRecord(record);
    }
  }
  
  async scheduleRetry(tx) {
    // Implement retry logic
    setTimeout(() => {
      this.processTransaction(tx);
    }, this.config.retryDelay);
  }
  
  getLastBlockTime() {
    let lastTime = 0;
    
    for (const block of this.blockRewards.values()) {
      if (block.timestamp > lastTime) {
        lastTime = block.timestamp;
      }
    }
    
    return lastTime;
  }
  
  generatePaymentId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  generateTransactionId() {
    return crypto.randomBytes(32).toString('hex');
  }
  
  // Persistence methods
  
  async loadPaymentData() {
    // Load from database
    // Simplified - would use actual database
  }
  
  async savePaymentRecord(record) {
    // Save to database
    // Simplified - would use actual database
  }
  
  // Public API
  
  getMinerBalance(address) {
    return this.balances.get(address) || new BigNumber(0);
  }
  
  getMinerPayments(address, limit = 100) {
    const payments = [];
    
    for (const payment of this.processedPayments.values()) {
      if (payment.address === address) {
        payments.push(payment);
      }
    }
    
    return payments
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
  
  getPaymentStats() {
    return {
      ...this.stats,
      pendingPayments: this.pendingPayments.size,
      totalBalances: Array.from(this.balances.values())
        .reduce((sum, bal) => sum.plus(bal), new BigNumber(0)).toString(),
      minPayment: this.config.minPayment,
      paymentScheme: this.config.paymentScheme
    };
  }
  
  async forcePayment(address) {
    const balance = this.balances.get(address);
    if (!balance || balance.isZero()) {
      return { success: false, error: 'No balance' };
    }
    
    // Process single payment
    const tx = {
      outputs: [{ address, amount: balance }],
      totalAmount: balance,
      estimatedSize: 250
    };
    
    await this.processTransaction(tx);
    
    return { success: true, amount: balance.toString() };
  }
}

module.exports = PaymentProcessor;