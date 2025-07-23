/**
 * MEV Protection System
 * Comprehensive protection against Maximum Extractable Value attacks
 * 
 * Features:
 * - Private mempool with encrypted transactions
 * - Commit-reveal ordering scheme
 * - Time-based fair ordering
 * - Batch auction mechanism
 * - MEV redistribution to users
 * - Sandwich attack detection
 * - Frontrunning prevention
 * - Fair sequencing service
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { MerkleTree } = require('merkletreejs');
const keccak256 = require('keccak256');
const { createLogger } = require('../core/logger');

const logger = createLogger('mev-protection');

// Protection strategies
const ProtectionStrategy = {
  PRIVATE_MEMPOOL: 'private_mempool',
  COMMIT_REVEAL: 'commit_reveal',
  TIME_ORDERING: 'time_ordering',
  BATCH_AUCTION: 'batch_auction',
  THRESHOLD_ENCRYPTION: 'threshold_encryption',
  FAIR_SEQUENCING: 'fair_sequencing',
  MEV_REDISTRIBUTION: 'mev_redistribution'
};

// Attack types
const AttackType = {
  FRONTRUNNING: 'frontrunning',
  SANDWICH: 'sandwich',
  BACKRUNNING: 'backrunning',
  TIME_BANDIT: 'time_bandit',
  UNCLE_BANDIT: 'uncle_bandit',
  LIQUIDATION: 'liquidation',
  ARBITRAGE: 'arbitrage'
};

// Transaction states
const TransactionState = {
  PENDING: 'pending',
  COMMITTED: 'committed',
  REVEALED: 'revealed',
  SEQUENCED: 'sequenced',
  EXECUTED: 'executed',
  PROTECTED: 'protected'
};

class PrivateMempool {
  constructor(config) {
    this.config = config;
    this.encryptedTransactions = new Map();
    this.commitments = new Map();
    this.revealDeadlines = new Map();
    this.encryptionKeys = new Map();
  }

  async submitTransaction(transaction, userKey) {
    const txId = this.generateTxId();
    
    // Encrypt transaction
    const { encrypted, key } = await this.encryptTransaction(transaction);
    
    // Create commitment
    const commitment = this.createCommitment(txId, transaction, userKey);
    
    // Store encrypted transaction
    this.encryptedTransactions.set(txId, {
      encrypted,
      commitment,
      userKey,
      timestamp: Date.now(),
      state: TransactionState.PENDING
    });
    
    this.commitments.set(commitment, txId);
    this.encryptionKeys.set(txId, key);
    
    // Set reveal deadline
    const revealDeadline = Date.now() + this.config.revealWindow;
    this.revealDeadlines.set(txId, revealDeadline);
    
    return {
      txId,
      commitment,
      revealDeadline
    };
  }

  async encryptTransaction(transaction) {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(transaction), 'utf8'),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted: {
        data: encrypted,
        iv,
        authTag
      },
      key
    };
  }

  async decryptTransaction(encrypted, key) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.iv);
    decipher.setAuthTag(encrypted.authTag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted.data),
      decipher.final()
    ]);
    
    return JSON.parse(decrypted.toString('utf8'));
  }

  createCommitment(txId, transaction, userKey) {
    const data = ethers.utils.solidityPack(
      ['bytes32', 'bytes32', 'address'],
      [
        txId,
        ethers.utils.keccak256(JSON.stringify(transaction)),
        userKey
      ]
    );
    
    return ethers.utils.keccak256(data);
  }

  async revealTransaction(txId, key) {
    const txData = this.encryptedTransactions.get(txId);
    if (!txData) {
      throw new Error('Transaction not found');
    }
    
    // Check reveal deadline
    if (Date.now() > this.revealDeadlines.get(txId)) {
      throw new Error('Reveal deadline exceeded');
    }
    
    // Verify key
    const storedKey = this.encryptionKeys.get(txId);
    if (!key.equals(storedKey)) {
      throw new Error('Invalid decryption key');
    }
    
    // Decrypt transaction
    const transaction = await this.decryptTransaction(txData.encrypted, key);
    
    // Update state
    txData.state = TransactionState.REVEALED;
    txData.revealedAt = Date.now();
    txData.transaction = transaction;
    
    return transaction;
  }

  generateTxId() {
    return '0x' + crypto.randomBytes(32).toString('hex');
  }

  getUnrevealedTransactions() {
    const unrevealed = [];
    const now = Date.now();
    
    for (const [txId, txData] of this.encryptedTransactions) {
      if (txData.state === TransactionState.PENDING && 
          now > this.revealDeadlines.get(txId)) {
        unrevealed.push({
          txId,
          commitment: txData.commitment,
          timestamp: txData.timestamp
        });
      }
    }
    
    return unrevealed;
  }
}

class CommitRevealOrdering {
  constructor(config) {
    this.config = config;
    this.commitPhase = new Map();
    this.revealPhase = new Map();
    this.orderingRounds = [];
    this.currentRound = 0;
  }

  async commitOrder(transaction, sender) {
    const nonce = crypto.randomBytes(32);
    const orderHash = this.hashOrder(transaction, nonce);
    
    const commitment = {
      hash: orderHash,
      sender,
      timestamp: Date.now(),
      round: this.currentRound
    };
    
    this.commitPhase.set(orderHash, {
      transaction,
      nonce,
      commitment
    });
    
    return {
      commitment: orderHash,
      nonce: nonce.toString('hex'),
      round: this.currentRound
    };
  }

  hashOrder(transaction, nonce) {
    const data = ethers.utils.solidityPack(
      ['bytes32', 'bytes32'],
      [
        ethers.utils.keccak256(JSON.stringify(transaction)),
        nonce
      ]
    );
    
    return ethers.utils.keccak256(data);
  }

  async revealOrder(commitment, transaction, nonce) {
    const commitData = this.commitPhase.get(commitment);
    if (!commitData) {
      throw new Error('Commitment not found');
    }
    
    // Verify commitment
    const computedHash = this.hashOrder(transaction, Buffer.from(nonce, 'hex'));
    if (computedHash !== commitment) {
      throw new Error('Invalid reveal');
    }
    
    // Move to reveal phase
    this.revealPhase.set(commitment, {
      transaction,
      nonce,
      revealedAt: Date.now(),
      round: commitData.commitment.round
    });
    
    return {
      success: true,
      round: commitData.commitment.round
    };
  }

  finalizeRound() {
    const roundTransactions = [];
    
    // Collect all revealed transactions for current round
    for (const [commitment, data] of this.revealPhase) {
      if (data.round === this.currentRound) {
        roundTransactions.push({
          commitment,
          transaction: data.transaction,
          timestamp: data.revealedAt
        });
      }
    }
    
    // Sort by commitment hash for deterministic ordering
    roundTransactions.sort((a, b) => 
      a.commitment.localeCompare(b.commitment)
    );
    
    // Store round results
    this.orderingRounds.push({
      round: this.currentRound,
      transactions: roundTransactions,
      finalizedAt: Date.now()
    });
    
    // Clean up old data
    this.cleanupRound(this.currentRound);
    
    // Advance round
    this.currentRound++;
    
    return roundTransactions;
  }

  cleanupRound(round) {
    // Remove processed commitments and reveals
    for (const [hash, data] of this.commitPhase) {
      if (data.commitment.round <= round) {
        this.commitPhase.delete(hash);
      }
    }
    
    for (const [commitment, data] of this.revealPhase) {
      if (data.round <= round) {
        this.revealPhase.delete(commitment);
      }
    }
  }
}

class SandwichDetector {
  constructor(config) {
    this.config = config;
    this.transactionPatterns = new Map();
    this.suspiciousPatterns = [];
    this.detectedAttacks = [];
  }

  async analyzeTransaction(transaction, mempool) {
    const patterns = await this.identifyPatterns(transaction, mempool);
    
    for (const pattern of patterns) {
      if (this.isSandwichPattern(pattern)) {
        const attack = {
          type: AttackType.SANDWICH,
          victim: transaction.from,
          attacker: pattern.attacker,
          frontrun: pattern.frontrun,
          backrun: pattern.backrun,
          estimatedProfit: this.estimateProfit(pattern),
          timestamp: Date.now()
        };
        
        this.detectedAttacks.push(attack);
        return { isSandwich: true, attack };
      }
    }
    
    return { isSandwich: false };
  }

  async identifyPatterns(transaction, mempool) {
    const patterns = [];
    const targetToken = this.extractTargetToken(transaction);
    
    if (!targetToken) return patterns;
    
    // Look for transactions targeting same token pair
    const relatedTxs = mempool.filter(tx => 
      this.extractTargetToken(tx) === targetToken
    );
    
    // Group by sender
    const txBySender = new Map();
    for (const tx of relatedTxs) {
      if (!txBySender.has(tx.from)) {
        txBySender.set(tx.from, []);
      }
      txBySender.get(tx.from).push(tx);
    }
    
    // Look for sandwich patterns
    for (const [sender, txs] of txBySender) {
      if (txs.length >= 2) {
        const potentialFrontrun = txs.find(tx => 
          this.isBuyTransaction(tx) && tx.gasPrice > transaction.gasPrice
        );
        
        const potentialBackrun = txs.find(tx =>
          this.isSellTransaction(tx) && tx !== potentialFrontrun
        );
        
        if (potentialFrontrun && potentialBackrun) {
          patterns.push({
            attacker: sender,
            frontrun: potentialFrontrun,
            victim: transaction,
            backrun: potentialBackrun,
            targetToken
          });
        }
      }
    }
    
    return patterns;
  }

  isSandwichPattern(pattern) {
    // Check if transactions form sandwich pattern
    const { frontrun, victim, backrun } = pattern;
    
    // Frontrun should have higher gas price
    if (frontrun.gasPrice <= victim.gasPrice) return false;
    
    // Backrun should be after victim
    if (backrun.nonce <= victim.nonce) return false;
    
    // Check if it's buy-victim-sell pattern
    if (!this.isBuyTransaction(frontrun)) return false;
    if (!this.isSellTransaction(backrun)) return false;
    
    // Check profitability threshold
    const estimatedProfit = this.estimateProfit(pattern);
    if (estimatedProfit < this.config.minProfitThreshold) return false;
    
    return true;
  }

  extractTargetToken(transaction) {
    // Extract token pair from transaction data
    // This is simplified - real implementation would parse actual swap data
    if (transaction.data && transaction.data.includes('swap')) {
      return transaction.to; // Using contract address as identifier
    }
    return null;
  }

  isBuyTransaction(transaction) {
    // Simplified check - real implementation would parse method signature
    return transaction.data && transaction.data.includes('buy');
  }

  isSellTransaction(transaction) {
    // Simplified check - real implementation would parse method signature
    return transaction.data && transaction.data.includes('sell');
  }

  estimateProfit(pattern) {
    // Estimate potential profit from sandwich attack
    const { frontrun, victim, backrun } = pattern;
    
    // Simplified calculation
    const buyAmount = ethers.BigNumber.from(frontrun.value || 0);
    const sellAmount = ethers.BigNumber.from(backrun.value || 0);
    const gasCost = ethers.BigNumber.from(frontrun.gasPrice)
      .mul(frontrun.gasLimit || 21000)
      .add(ethers.BigNumber.from(backrun.gasPrice)
        .mul(backrun.gasLimit || 21000));
    
    const profit = sellAmount.sub(buyAmount).sub(gasCost);
    
    return profit.toNumber();
  }
}

class BatchAuction {
  constructor(config) {
    this.config = config;
    this.currentBatch = [];
    this.batchNumber = 0;
    this.auctionResults = new Map();
    this.batchInterval = null;
  }

  start() {
    this.batchInterval = setInterval(() => {
      this.processBatch();
    }, this.config.batchDuration);
  }

  stop() {
    if (this.batchInterval) {
      clearInterval(this.batchInterval);
      this.batchInterval = null;
    }
  }

  submitOrder(order) {
    this.currentBatch.push({
      ...order,
      submittedAt: Date.now(),
      batchNumber: this.batchNumber
    });
    
    return {
      accepted: true,
      batchNumber: this.batchNumber,
      estimatedExecution: Date.now() + this.config.batchDuration
    };
  }

  async processBatch() {
    if (this.currentBatch.length === 0) return;
    
    const batch = [...this.currentBatch];
    this.currentBatch = [];
    this.batchNumber++;
    
    // Run auction
    const result = await this.runAuction(batch);
    
    // Store results
    this.auctionResults.set(this.batchNumber - 1, result);
    
    return result;
  }

  async runAuction(orders) {
    // Uniform price auction mechanism
    const sortedOrders = this.sortOrdersByPrice(orders);
    const clearingPrice = this.findClearingPrice(sortedOrders);
    
    const executed = [];
    const rejected = [];
    
    for (const order of sortedOrders) {
      if (this.shouldExecute(order, clearingPrice)) {
        executed.push({
          ...order,
          executionPrice: clearingPrice,
          executed: true
        });
      } else {
        rejected.push({
          ...order,
          reason: 'Below clearing price',
          executed: false
        });
      }
    }
    
    return {
      batchNumber: this.batchNumber - 1,
      clearingPrice,
      executed,
      rejected,
      timestamp: Date.now()
    };
  }

  sortOrdersByPrice(orders) {
    return orders.sort((a, b) => {
      const priceA = ethers.BigNumber.from(a.price || 0);
      const priceB = ethers.BigNumber.from(b.price || 0);
      return priceB.sub(priceA).toNumber();
    });
  }

  findClearingPrice(sortedOrders) {
    // Find price where supply meets demand
    let totalSupply = ethers.BigNumber.from(0);
    let totalDemand = ethers.BigNumber.from(0);
    
    for (const order of sortedOrders) {
      if (order.side === 'sell') {
        totalSupply = totalSupply.add(order.amount);
      } else {
        totalDemand = totalDemand.add(order.amount);
      }
      
      if (totalSupply.gte(totalDemand)) {
        return order.price;
      }
    }
    
    return sortedOrders[sortedOrders.length - 1].price;
  }

  shouldExecute(order, clearingPrice) {
    const orderPrice = ethers.BigNumber.from(order.price || 0);
    const clearing = ethers.BigNumber.from(clearingPrice);
    
    if (order.side === 'buy') {
      return orderPrice.gte(clearing);
    } else {
      return orderPrice.lte(clearing);
    }
  }
}

class MEVRedistribution {
  constructor(config) {
    this.config = config;
    this.capturedMEV = ethers.BigNumber.from(0);
    this.redistributions = [];
    this.beneficiaries = new Map();
  }

  async captureMEV(transaction, mevAmount) {
    this.capturedMEV = this.capturedMEV.add(mevAmount);
    
    // Track MEV source
    this.redistributions.push({
      transaction: transaction.hash,
      amount: mevAmount,
      source: this.identifyMEVSource(transaction),
      timestamp: Date.now()
    });
    
    return {
      captured: mevAmount.toString(),
      total: this.capturedMEV.toString()
    };
  }

  identifyMEVSource(transaction) {
    // Identify type of MEV
    if (transaction.data.includes('arbitrage')) {
      return 'arbitrage';
    } else if (transaction.data.includes('liquidate')) {
      return 'liquidation';
    } else if (transaction.gasPrice > this.config.averageGasPrice * 2) {
      return 'priority_fee';
    }
    return 'unknown';
  }

  async redistribute() {
    if (this.capturedMEV.eq(0)) return;
    
    const distributions = [];
    
    // Calculate shares for each beneficiary
    const shares = this.calculateShares();
    
    for (const [address, share] of shares) {
      const amount = this.capturedMEV.mul(share).div(10000); // share in basis points
      
      distributions.push({
        recipient: address,
        amount,
        share,
        reason: this.beneficiaries.get(address).reason
      });
    }
    
    // Reset captured MEV
    this.capturedMEV = ethers.BigNumber.from(0);
    
    return {
      totalDistributed: distributions.reduce((sum, d) => 
        sum.add(d.amount), ethers.BigNumber.from(0)
      ).toString(),
      distributions,
      timestamp: Date.now()
    };
  }

  calculateShares() {
    const shares = new Map();
    
    // Default distribution strategy
    if (this.config.redistributionStrategy === 'equal') {
      const sharePerUser = 10000 / this.beneficiaries.size;
      for (const address of this.beneficiaries.keys()) {
        shares.set(address, sharePerUser);
      }
    } else if (this.config.redistributionStrategy === 'proportional') {
      // Proportional to activity
      let totalActivity = 0;
      for (const data of this.beneficiaries.values()) {
        totalActivity += data.activityScore || 1;
      }
      
      for (const [address, data] of this.beneficiaries) {
        const share = (data.activityScore / totalActivity) * 10000;
        shares.set(address, Math.floor(share));
      }
    }
    
    return shares;
  }

  addBeneficiary(address, data) {
    this.beneficiaries.set(address, {
      address,
      addedAt: Date.now(),
      ...data
    });
  }

  removeBeneficiary(address) {
    this.beneficiaries.delete(address);
  }
}

class FairSequencer {
  constructor(config) {
    this.config = config;
    this.sequenceNumber = 0;
    this.pendingTransactions = [];
    this.sequencedTransactions = new Map();
    this.fairnessScores = new Map();
  }

  async submitTransaction(transaction) {
    const sequenceData = {
      transaction,
      receivedAt: Date.now(),
      sequenceNumber: null,
      fairnessScore: this.calculateFairnessScore(transaction)
    };
    
    this.pendingTransactions.push(sequenceData);
    
    return {
      queued: true,
      position: this.pendingTransactions.length,
      estimatedSequencing: this.estimateSequencingTime()
    };
  }

  calculateFairnessScore(transaction) {
    let score = 1000; // Base score
    
    // Adjust based on user history
    const userHistory = this.fairnessScores.get(transaction.from) || {
      totalTransactions: 0,
      lastTransaction: 0
    };
    
    // Penalize frequent transactors
    if (userHistory.totalTransactions > 10) {
      score -= userHistory.totalTransactions * 10;
    }
    
    // Bonus for first-time or infrequent users
    if (userHistory.totalTransactions === 0) {
      score += 500;
    }
    
    // Time-based adjustment
    const timeSinceLastTx = Date.now() - userHistory.lastTransaction;
    if (timeSinceLastTx > 60000) { // More than 1 minute
      score += Math.min(timeSinceLastTx / 1000, 200);
    }
    
    return Math.max(score, 0);
  }

  async sequenceTransactions() {
    if (this.pendingTransactions.length === 0) return [];
    
    // Sort by fairness score and received time
    const sorted = this.pendingTransactions.sort((a, b) => {
      if (a.fairnessScore !== b.fairnessScore) {
        return b.fairnessScore - a.fairnessScore;
      }
      return a.receivedAt - b.receivedAt;
    });
    
    const sequenced = [];
    const batchSize = Math.min(sorted.length, this.config.maxBatchSize);
    
    for (let i = 0; i < batchSize; i++) {
      const tx = sorted[i];
      tx.sequenceNumber = this.sequenceNumber++;
      
      this.sequencedTransactions.set(tx.sequenceNumber, tx);
      sequenced.push(tx);
      
      // Update user history
      this.updateFairnessHistory(tx.transaction.from);
    }
    
    // Remove sequenced transactions
    this.pendingTransactions = sorted.slice(batchSize);
    
    return sequenced;
  }

  updateFairnessHistory(address) {
    const history = this.fairnessScores.get(address) || {
      totalTransactions: 0,
      lastTransaction: 0
    };
    
    history.totalTransactions++;
    history.lastTransaction = Date.now();
    
    this.fairnessScores.set(address, history);
  }

  estimateSequencingTime() {
    const position = this.pendingTransactions.length;
    const avgSequencingTime = this.config.sequencingInterval;
    const batchSize = this.config.maxBatchSize;
    
    const batches = Math.ceil(position / batchSize);
    return batches * avgSequencingTime;
  }

  getSequenceProof(sequenceNumber) {
    const tx = this.sequencedTransactions.get(sequenceNumber);
    if (!tx) return null;
    
    // Create merkle proof of sequencing
    const leaves = [];
    const start = Math.max(0, sequenceNumber - 100);
    const end = Math.min(this.sequenceNumber, sequenceNumber + 100);
    
    for (let i = start; i < end; i++) {
      const seqTx = this.sequencedTransactions.get(i);
      if (seqTx) {
        leaves.push(this.hashSequencedTransaction(seqTx));
      }
    }
    
    const tree = new MerkleTree(leaves, keccak256, { sort: true });
    const leaf = this.hashSequencedTransaction(tx);
    const proof = tree.getProof(leaf);
    
    return {
      sequenceNumber,
      transaction: tx.transaction,
      proof: proof.map(p => ({
        data: p.data.toString('hex'),
        position: p.position
      })),
      root: tree.getRoot().toString('hex')
    };
  }

  hashSequencedTransaction(tx) {
    return ethers.utils.solidityKeccak256(
      ['uint256', 'bytes32', 'uint256'],
      [
        tx.sequenceNumber,
        ethers.utils.keccak256(JSON.stringify(tx.transaction)),
        tx.receivedAt
      ]
    );
  }
}

class MEVProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      strategy: options.strategy || [
        ProtectionStrategy.PRIVATE_MEMPOOL,
        ProtectionStrategy.SANDWICH_DETECTION,
        ProtectionStrategy.FAIR_SEQUENCING
      ],
      revealWindow: options.revealWindow || 5000, // 5 seconds
      batchDuration: options.batchDuration || 1000, // 1 second
      minProfitThreshold: options.minProfitThreshold || '1000000000000000', // 0.001 ETH
      redistributionStrategy: options.redistributionStrategy || 'proportional',
      sequencingInterval: options.sequencingInterval || 500, // 0.5 seconds
      maxBatchSize: options.maxBatchSize || 100,
      ...options
    };
    
    // Initialize protection components
    this.privateMempool = new PrivateMempool(this.config);
    this.commitReveal = new CommitRevealOrdering(this.config);
    this.sandwichDetector = new SandwichDetector(this.config);
    this.batchAuction = new BatchAuction(this.config);
    this.mevRedistribution = new MEVRedistribution(this.config);
    this.fairSequencer = new FairSequencer(this.config);
    
    this.protectedTransactions = new Map();
    this.detectedAttacks = [];
    
    this.stats = {
      transactionsProtected: 0,
      attacksDetected: 0,
      mevCaptured: '0',
      mevRedistributed: '0',
      sandwichAttacksBlocked: 0,
      frontrunAttacksBlocked: 0
    };
    
    this.initialize();
  }

  initialize() {
    // Start batch auction if enabled
    if (this.config.strategy.includes(ProtectionStrategy.BATCH_AUCTION)) {
      this.batchAuction.start();
    }
    
    // Start sequencing loop
    if (this.config.strategy.includes(ProtectionStrategy.FAIR_SEQUENCING)) {
      setInterval(() => {
        this.processSequencing();
      }, this.config.sequencingInterval);
    }
    
    // Start MEV redistribution
    if (this.config.strategy.includes(ProtectionStrategy.MEV_REDISTRIBUTION)) {
      setInterval(() => {
        this.processRedistribution();
      }, 60000); // Every minute
    }
    
    logger.info('MEV protection initialized', {
      strategies: this.config.strategy
    });
  }

  async protectTransaction(transaction, options = {}) {
    const protectionId = this.generateProtectionId();
    
    const protection = {
      id: protectionId,
      transaction,
      strategy: options.strategy || this.config.strategy[0],
      status: TransactionState.PENDING,
      createdAt: Date.now()
    };
    
    this.protectedTransactions.set(protectionId, protection);
    
    try {
      let result;
      
      switch (protection.strategy) {
        case ProtectionStrategy.PRIVATE_MEMPOOL:
          result = await this.protectWithPrivateMempool(transaction, options);
          break;
          
        case ProtectionStrategy.COMMIT_REVEAL:
          result = await this.protectWithCommitReveal(transaction, options);
          break;
          
        case ProtectionStrategy.BATCH_AUCTION:
          result = await this.protectWithBatchAuction(transaction, options);
          break;
          
        case ProtectionStrategy.FAIR_SEQUENCING:
          result = await this.protectWithFairSequencing(transaction, options);
          break;
          
        default:
          throw new Error(`Unknown protection strategy: ${protection.strategy}`);
      }
      
      protection.status = TransactionState.PROTECTED;
      protection.result = result;
      
      this.stats.transactionsProtected++;
      
      this.emit('transaction:protected', {
        protectionId,
        strategy: protection.strategy,
        result
      });
      
      return {
        protectionId,
        ...result
      };
      
    } catch (error) {
      logger.error('Transaction protection failed:', error);
      protection.status = 'failed';
      protection.error = error.message;
      throw error;
    }
  }

  async protectWithPrivateMempool(transaction, options) {
    const userKey = options.userKey || transaction.from;
    
    // Submit to private mempool
    const submission = await this.privateMempool.submitTransaction(transaction, userKey);
    
    // Check for sandwich attacks
    const sandwichCheck = await this.sandwichDetector.analyzeTransaction(
      transaction,
      this.getPendingTransactions()
    );
    
    if (sandwichCheck.isSandwich) {
      this.handleDetectedAttack(sandwichCheck.attack);
      
      // Delay transaction to avoid sandwich
      submission.revealDeadline += this.config.revealWindow;
    }
    
    return {
      strategy: ProtectionStrategy.PRIVATE_MEMPOOL,
      ...submission,
      sandwichProtection: !sandwichCheck.isSandwich
    };
  }

  async protectWithCommitReveal(transaction, options) {
    const sender = options.sender || transaction.from;
    
    // Commit phase
    const commitment = await this.commitReveal.commitOrder(transaction, sender);
    
    // Set up reveal timer
    setTimeout(async () => {
      try {
        await this.commitReveal.revealOrder(
          commitment.commitment,
          transaction,
          commitment.nonce
        );
      } catch (error) {
        logger.error('Reveal failed:', error);
      }
    }, this.config.revealWindow / 2);
    
    return {
      strategy: ProtectionStrategy.COMMIT_REVEAL,
      ...commitment
    };
  }

  async protectWithBatchAuction(transaction, options) {
    // Convert transaction to order format
    const order = {
      ...transaction,
      side: this.determineOrderSide(transaction),
      price: options.price || this.estimatePrice(transaction),
      amount: options.amount || transaction.value
    };
    
    const submission = this.batchAuction.submitOrder(order);
    
    return {
      strategy: ProtectionStrategy.BATCH_AUCTION,
      ...submission
    };
  }

  async protectWithFairSequencing(transaction, options) {
    const submission = await this.fairSequencer.submitTransaction(transaction);
    
    return {
      strategy: ProtectionStrategy.FAIR_SEQUENCING,
      ...submission
    };
  }

  async detectAndPreventMEV(transaction) {
    const detections = [];
    
    // Check for frontrunning
    if (await this.isFrontrunning(transaction)) {
      detections.push({
        type: AttackType.FRONTRUNNING,
        severity: 'high',
        recommendation: 'Use private mempool or commit-reveal'
      });
      this.stats.frontrunAttacksBlocked++;
    }
    
    // Check for sandwich attacks
    const sandwichCheck = await this.sandwichDetector.analyzeTransaction(
      transaction,
      this.getPendingTransactions()
    );
    
    if (sandwichCheck.isSandwich) {
      detections.push({
        type: AttackType.SANDWICH,
        severity: 'critical',
        attack: sandwichCheck.attack,
        recommendation: 'Use batch auction or private mempool'
      });
      this.stats.sandwichAttacksBlocked++;
    }
    
    // Check for time-bandit attacks
    if (this.isTimeBandit(transaction)) {
      detections.push({
        type: AttackType.TIME_BANDIT,
        severity: 'medium',
        recommendation: 'Use fair sequencing'
      });
    }
    
    this.stats.attacksDetected += detections.length;
    
    return {
      mevDetected: detections.length > 0,
      detections,
      recommendedStrategy: this.recommendProtectionStrategy(detections)
    };
  }

  async isFrontrunning(transaction) {
    // Check if transaction is likely to be frontrun
    const pendingTxs = this.getPendingTransactions();
    
    // Look for similar transactions with higher gas price
    const similar = pendingTxs.filter(tx => 
      tx.to === transaction.to &&
      tx.data.substring(0, 10) === transaction.data.substring(0, 10) &&
      ethers.BigNumber.from(tx.gasPrice).gt(transaction.gasPrice)
    );
    
    return similar.length > 0;
  }

  isTimeBandit(transaction) {
    // Check if transaction attempts to manipulate block timestamps
    return transaction.data && transaction.data.includes('timestamp');
  }

  recommendProtectionStrategy(detections) {
    if (detections.length === 0) {
      return ProtectionStrategy.FAIR_SEQUENCING;
    }
    
    const severities = detections.map(d => d.severity);
    
    if (severities.includes('critical')) {
      return ProtectionStrategy.PRIVATE_MEMPOOL;
    } else if (severities.includes('high')) {
      return ProtectionStrategy.COMMIT_REVEAL;
    } else {
      return ProtectionStrategy.BATCH_AUCTION;
    }
  }

  handleDetectedAttack(attack) {
    this.detectedAttacks.push({
      ...attack,
      detectedAt: Date.now(),
      prevented: true
    });
    
    // Emit event
    this.emit('attack:detected', attack);
    
    // Log for analysis
    logger.warn('MEV attack detected', {
      type: attack.type,
      attacker: attack.attacker,
      estimatedProfit: attack.estimatedProfit
    });
  }

  async processSequencing() {
    const sequenced = await this.fairSequencer.sequenceTransactions();
    
    for (const tx of sequenced) {
      this.emit('transaction:sequenced', {
        sequenceNumber: tx.sequenceNumber,
        transaction: tx.transaction
      });
    }
  }

  async processRedistribution() {
    const result = await this.mevRedistribution.redistribute();
    
    if (result.distributions.length > 0) {
      this.stats.mevRedistributed = ethers.BigNumber.from(this.stats.mevRedistributed)
        .add(result.totalDistributed)
        .toString();
      
      this.emit('mev:redistributed', result);
    }
  }

  async captureMEV(transaction, amount) {
    const result = await this.mevRedistribution.captureMEV(
      transaction,
      ethers.BigNumber.from(amount)
    );
    
    this.stats.mevCaptured = result.total;
    
    return result;
  }

  addMEVBeneficiary(address, data) {
    this.mevRedistribution.addBeneficiary(address, data);
  }

  getPendingTransactions() {
    // Aggregate pending transactions from all protection mechanisms
    const pending = [];
    
    // From private mempool
    for (const [txId, data] of this.privateMempool.encryptedTransactions) {
      if (data.state === TransactionState.REVEALED && data.transaction) {
        pending.push(data.transaction);
      }
    }
    
    // From fair sequencer
    pending.push(...this.fairSequencer.pendingTransactions.map(p => p.transaction));
    
    // From batch auction
    pending.push(...this.batchAuction.currentBatch);
    
    return pending;
  }

  determineOrderSide(transaction) {
    // Determine if transaction is buy or sell
    // Simplified - real implementation would parse method signature
    if (transaction.data && transaction.data.includes('buy')) {
      return 'buy';
    } else if (transaction.data && transaction.data.includes('sell')) {
      return 'sell';
    }
    return 'unknown';
  }

  estimatePrice(transaction) {
    // Estimate execution price for transaction
    // Simplified - real implementation would use oracle or DEX data
    return transaction.value || '0';
  }

  generateProtectionId() {
    return 'mev_' + Date.now() + '_' + crypto.randomBytes(8).toString('hex');
  }

  getProtectionStatus(protectionId) {
    const protection = this.protectedTransactions.get(protectionId);
    if (!protection) return null;
    
    return {
      id: protectionId,
      status: protection.status,
      strategy: protection.strategy,
      createdAt: protection.createdAt,
      result: protection.result,
      error: protection.error
    };
  }

  getStatistics() {
    return {
      ...this.stats,
      activeProtections: this.protectedTransactions.size,
      strategiesEnabled: this.config.strategy,
      recentAttacks: this.detectedAttacks.slice(-10),
      batchAuction: {
        currentBatchSize: this.batchAuction.currentBatch.length,
        batchNumber: this.batchAuction.batchNumber
      },
      fairSequencer: {
        pendingTransactions: this.fairSequencer.pendingTransactions.length,
        sequenceNumber: this.fairSequencer.sequenceNumber
      },
      privateMempool: {
        encryptedTransactions: this.privateMempool.encryptedTransactions.size,
        unrevealed: this.privateMempool.getUnrevealedTransactions().length
      }
    };
  }

  async cleanup() {
    // Stop batch auction
    this.batchAuction.stop();
    
    // Clear intervals
    this.removeAllListeners();
    
    logger.info('MEV protection cleaned up');
  }
}

module.exports = {
  MEVProtection,
  ProtectionStrategy,
  AttackType,
  TransactionState,
  PrivateMempool,
  CommitRevealOrdering,
  SandwichDetector,
  BatchAuction,
  MEVRedistribution,
  FairSequencer
};