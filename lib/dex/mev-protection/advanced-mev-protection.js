/**
 * Advanced MEV Protection System
 * Protects against sandwich attacks, front-running, and other MEV exploits
 * 
 * Design principles:
 * - Commit-reveal scheme for order privacy (Martin)
 * - Time-based ordering to prevent front-running (Pike)
 * - High-performance batch processing (Carmack)
 */

const { EventEmitter } = require('events');
const { randomBytes, createHash, createCipheriv, createDecipheriv } = require('crypto');
const { createLogger } = require('../../core/logger');

const logger = createLogger('MEVProtection');

// Protection modes
const PROTECTION_MODES = {
  NONE: 'none',
  BASIC: 'basic',
  COMMIT_REVEAL: 'commit_reveal',
  TIME_LOCK: 'time_lock',
  PRIVATE_POOL: 'private_pool',
  BATCH_AUCTION: 'batch_auction'
};

// Attack types
const ATTACK_TYPES = {
  SANDWICH: 'sandwich',
  FRONT_RUNNING: 'front_running',
  BACK_RUNNING: 'back_running',
  ARBITRAGE: 'arbitrage',
  LIQUIDATION: 'liquidation'
};

class AdvancedMEVProtection extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Protection settings
      defaultMode: options.defaultMode || PROTECTION_MODES.COMMIT_REVEAL,
      revealDelay: options.revealDelay || 1000, // 1 second
      batchInterval: options.batchInterval || 500, // 500ms
      
      // Detection thresholds
      sandwichThreshold: options.sandwichThreshold || 0.01, // 1% price impact
      frontRunThreshold: options.frontRunThreshold || 100, // 100ms time difference
      
      // Private pool settings
      privatePoolEnabled: options.privatePoolEnabled !== false,
      privatePoolDelay: options.privatePoolDelay || 2000, // 2 seconds
      
      // Batch auction settings
      auctionDuration: options.auctionDuration || 1000, // 1 second
      minBatchSize: options.minBatchSize || 10,
      
      // Security
      encryptionKey: options.encryptionKey || randomBytes(32),
      
      ...options
    };
    
    // State
    this.commitments = new Map(); // commitHash -> commitment
    this.privatePools = new Map(); // poolId -> orders
    this.batches = new Map(); // batchId -> batch
    this.attackLog = [];
    
    // Metrics
    this.metrics = {
      ordersProtected: 0,
      attacksDetected: 0,
      attacksPrevented: 0,
      sandwichesBlocked: 0,
      frontRunsBlocked: 0,
      totalValueProtected: 0
    };
    
    // Start batch processor
    this.startBatchProcessor();
  }
  
  /**
   * Protect an order from MEV
   */
  async protectOrder(order, mode = null) {
    const protectionMode = mode || this.options.defaultMode;
    
    switch (protectionMode) {
      case PROTECTION_MODES.COMMIT_REVEAL:
        return this.commitRevealProtection(order);
        
      case PROTECTION_MODES.TIME_LOCK:
        return this.timeLockProtection(order);
        
      case PROTECTION_MODES.PRIVATE_POOL:
        return this.privatePoolProtection(order);
        
      case PROTECTION_MODES.BATCH_AUCTION:
        return this.batchAuctionProtection(order);
        
      case PROTECTION_MODES.BASIC:
        return this.basicProtection(order);
        
      default:
        return order; // No protection
    }
  }
  
  /**
   * Commit-reveal protection
   */
  async commitRevealProtection(order) {
    // Generate commitment
    const nonce = randomBytes(32);
    const orderData = this.serializeOrder(order);
    const commitment = createHash('sha256')
      .update(orderData)
      .update(nonce)
      .digest();
    
    const commitHash = commitment.toString('hex');
    
    // Encrypt order details
    const encryptedOrder = this.encryptOrder(order, nonce);
    
    // Store commitment
    this.commitments.set(commitHash, {
      encryptedOrder,
      nonce,
      timestamp: Date.now(),
      revealTime: Date.now() + this.options.revealDelay,
      status: 'committed'
    });
    
    // Schedule reveal
    setTimeout(() => {
      this.revealCommitment(commitHash);
    }, this.options.revealDelay);
    
    this.metrics.ordersProtected++;
    
    return {
      type: 'commitment',
      commitHash,
      revealTime: Date.now() + this.options.revealDelay
    };
  }
  
  /**
   * Reveal a committed order
   */
  async revealCommitment(commitHash) {
    const commitment = this.commitments.get(commitHash);
    if (!commitment || commitment.status !== 'committed') {
      return null;
    }
    
    try {
      // Decrypt order
      const order = this.decryptOrder(commitment.encryptedOrder, commitment.nonce);
      
      // Mark as revealed
      commitment.status = 'revealed';
      commitment.revealedAt = Date.now();
      
      // Check for potential attacks
      const attacks = await this.detectAttacks(order, commitment);
      if (attacks.length > 0) {
        this.handleDetectedAttacks(order, attacks);
      }
      
      // Emit for processing
      this.emit('order:revealed', {
        order,
        commitHash,
        protectionTime: commitment.revealedAt - commitment.timestamp
      });
      
      return order;
      
    } catch (error) {
      logger.error('Failed to reveal commitment:', error);
      commitment.status = 'failed';
      return null;
    }
  }
  
  /**
   * Time-lock protection
   */
  async timeLockProtection(order) {
    const lockTime = Date.now() + this.calculateLockTime(order);
    
    return {
      ...order,
      protection: {
        type: 'time_lock',
        unlockTime: lockTime,
        priority: this.calculatePriority(order)
      }
    };
  }
  
  /**
   * Private pool protection
   */
  async privatePoolProtection(order) {
    const poolId = this.selectPrivatePool(order);
    
    if (!this.privatePools.has(poolId)) {
      this.privatePools.set(poolId, {
        orders: [],
        createdAt: Date.now()
      });
    }
    
    const pool = this.privatePools.get(poolId);
    pool.orders.push(order);
    
    // Process pool after delay
    setTimeout(() => {
      this.processPrivatePool(poolId);
    }, this.options.privatePoolDelay);
    
    return {
      type: 'private_pool',
      poolId,
      processTime: Date.now() + this.options.privatePoolDelay
    };
  }
  
  /**
   * Batch auction protection
   */
  async batchAuctionProtection(order) {
    const batchId = this.getCurrentBatchId();
    
    if (!this.batches.has(batchId)) {
      this.batches.set(batchId, {
        orders: [],
        startTime: Date.now(),
        endTime: Date.now() + this.options.auctionDuration
      });
    }
    
    const batch = this.batches.get(batchId);
    batch.orders.push(order);
    
    return {
      type: 'batch_auction',
      batchId,
      auctionEndTime: batch.endTime
    };
  }
  
  /**
   * Basic protection checks
   */
  async basicProtection(order) {
    // Check for suspicious patterns
    const isSuspicious = await this.checkSuspiciousPatterns(order);
    
    if (isSuspicious) {
      // Add random delay
      const delay = Math.floor(Math.random() * 1000) + 500; // 0.5-1.5 seconds
      
      return {
        ...order,
        protection: {
          type: 'basic',
          delay,
          reason: 'suspicious_pattern'
        }
      };
    }
    
    return order;
  }
  
  /**
   * Detect potential attacks
   */
  async detectAttacks(order, context = {}) {
    const attacks = [];
    
    // Check for sandwich attack
    if (this.detectSandwichAttack(order, context)) {
      attacks.push({
        type: ATTACK_TYPES.SANDWICH,
        severity: 'high',
        details: 'Potential sandwich attack detected'
      });
    }
    
    // Check for front-running
    if (this.detectFrontRunning(order, context)) {
      attacks.push({
        type: ATTACK_TYPES.FRONT_RUNNING,
        severity: 'medium',
        details: 'Potential front-running detected'
      });
    }
    
    // Check for arbitrage
    if (this.detectArbitrage(order, context)) {
      attacks.push({
        type: ATTACK_TYPES.ARBITRAGE,
        severity: 'low',
        details: 'Arbitrage opportunity detected'
      });
    }
    
    return attacks;
  }
  
  /**
   * Detect sandwich attack pattern
   */
  detectSandwichAttack(order, context) {
    // Check recent orders for sandwich pattern
    const recentOrders = this.getRecentOrders(order.symbol, 1000); // Last second
    
    // Look for buy-target-sell pattern
    const buysBeforeTarget = recentOrders.filter(o => 
      o.side === 'buy' && 
      o.timestamp > order.timestamp - 100 && // Within 100ms
      o.timestamp < order.timestamp
    );
    
    const sellsAfterTarget = recentOrders.filter(o =>
      o.side === 'sell' &&
      o.timestamp > order.timestamp &&
      o.timestamp < order.timestamp + 100 // Within 100ms
    );
    
    // Check if same address or similar amounts
    for (const buy of buysBeforeTarget) {
      for (const sell of sellsAfterTarget) {
        if (this.isSandwichPattern(buy, order, sell)) {
          this.metrics.sandwichesBlocked++;
          return true;
        }
      }
    }
    
    return false;
  }
  
  /**
   * Check if orders form sandwich pattern
   */
  isSandwichPattern(buy, target, sell) {
    // Same trader check
    if (buy.userId === sell.userId) {
      return true;
    }
    
    // Similar amounts check
    const amountDiff = Math.abs(buy.quantity - sell.quantity) / buy.quantity;
    if (amountDiff < 0.05) { // Within 5%
      return true;
    }
    
    // Price impact check
    const priceImpact = Math.abs(sell.price - buy.price) / buy.price;
    if (priceImpact > this.options.sandwichThreshold) {
      return true;
    }
    
    return false;
  }
  
  /**
   * Detect front-running
   */
  detectFrontRunning(order, context) {
    const recentOrders = this.getRecentOrders(order.symbol, 500);
    
    // Look for orders that arrived just before with similar characteristics
    const suspiciousOrders = recentOrders.filter(o => {
      const timeDiff = order.timestamp - o.timestamp;
      return (
        timeDiff > 0 &&
        timeDiff < this.options.frontRunThreshold &&
        o.side === order.side &&
        Math.abs(o.price - order.price) / order.price < 0.001 // Within 0.1%
      );
    });
    
    if (suspiciousOrders.length > 0) {
      this.metrics.frontRunsBlocked++;
      return true;
    }
    
    return false;
  }
  
  /**
   * Detect arbitrage opportunities
   */
  detectArbitrage(order, context) {
    // Check cross-market prices
    // This would integrate with other exchanges
    return false; // Placeholder
  }
  
  /**
   * Handle detected attacks
   */
  handleDetectedAttacks(order, attacks) {
    this.metrics.attacksDetected += attacks.length;
    
    // Log attacks
    this.attackLog.push({
      timestamp: Date.now(),
      orderId: order.id,
      attacks,
      action: 'prevented'
    });
    
    // Emit alert
    this.emit('attack:detected', {
      order,
      attacks
    });
    
    // Take protective action based on severity
    const highSeverity = attacks.some(a => a.severity === 'high');
    if (highSeverity) {
      this.metrics.attacksPrevented++;
      
      // Delay order execution
      order.protection = {
        ...order.protection,
        attackDelay: 5000, // 5 second delay
        reason: 'attack_detected'
      };
    }
  }
  
  /**
   * Process private pool
   */
  async processPrivatePool(poolId) {
    const pool = this.privatePools.get(poolId);
    if (!pool || pool.orders.length === 0) {
      return;
    }
    
    // Randomize order execution
    const shuffledOrders = this.shuffleArray([...pool.orders]);
    
    // Process orders
    for (const order of shuffledOrders) {
      this.emit('order:ready', {
        order,
        protection: 'private_pool'
      });
    }
    
    // Clear pool
    this.privatePools.delete(poolId);
  }
  
  /**
   * Start batch processor
   */
  startBatchProcessor() {
    setInterval(() => {
      this.processBatches();
    }, this.options.batchInterval);
  }
  
  /**
   * Process batches
   */
  async processBatches() {
    const now = Date.now();
    
    for (const [batchId, batch] of this.batches) {
      if (now >= batch.endTime) {
        // Process batch
        const optimalOrder = this.optimizeBatchExecution(batch.orders);
        
        for (const order of optimalOrder) {
          this.emit('order:ready', {
            order,
            protection: 'batch_auction'
          });
        }
        
        // Remove processed batch
        this.batches.delete(batchId);
      }
    }
  }
  
  /**
   * Optimize batch execution order
   */
  optimizeBatchExecution(orders) {
    // Sort by various criteria to minimize MEV
    return orders.sort((a, b) => {
      // Prioritize smaller orders (less MEV value)
      const sizeScore = a.quantity - b.quantity;
      
      // Randomize similar orders
      const randomScore = Math.random() - 0.5;
      
      return sizeScore * 0.7 + randomScore * 0.3;
    });
  }
  
  /**
   * Calculate dynamic lock time
   */
  calculateLockTime(order) {
    const baseTime = 500; // 500ms base
    
    // Larger orders get longer lock times
    const sizeFactor = Math.log10(order.quantity * order.price) * 100;
    
    // Market orders get shorter lock times
    const typeFactor = order.type === 'market' ? 0.5 : 1;
    
    return Math.floor(baseTime * typeFactor + sizeFactor);
  }
  
  /**
   * Calculate order priority
   */
  calculatePriority(order) {
    let priority = 100;
    
    // Adjust for order type
    if (order.type === 'market') priority += 20;
    if (order.type === 'limit') priority += 10;
    
    // Adjust for size (smaller orders get higher priority)
    const sizeScore = 1 / Math.log10(order.quantity * order.price + 10);
    priority += sizeScore * 50;
    
    return Math.floor(priority);
  }
  
  /**
   * Select appropriate private pool
   */
  selectPrivatePool(order) {
    // Pool selection based on order characteristics
    const poolType = order.quantity * order.price > 10000 ? 'large' : 'small';
    return `${poolType}_${Math.floor(Date.now() / this.options.privatePoolDelay)}`;
  }
  
  /**
   * Check for suspicious patterns
   */
  async checkSuspiciousPatterns(order) {
    // Check order frequency
    const userOrders = this.getUserRecentOrders(order.userId, 60000); // Last minute
    if (userOrders.length > 50) {
      return true; // Too many orders
    }
    
    // Check for rapid price changes
    const priceChanges = userOrders.filter(o => 
      Math.abs(o.price - order.price) / order.price > 0.05 // 5% difference
    );
    if (priceChanges.length > 5) {
      return true; // Suspicious price movements
    }
    
    return false;
  }
  
  /**
   * Encrypt order data
   */
  encryptOrder(order, nonce) {
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.options.encryptionKey,
      nonce.slice(0, 16)
    );
    
    const orderData = JSON.stringify(order);
    const encrypted = Buffer.concat([
      cipher.update(orderData, 'utf8'),
      cipher.final()
    ]);
    
    const tag = cipher.getAuthTag();
    
    return Buffer.concat([encrypted, tag]);
  }
  
  /**
   * Decrypt order data
   */
  decryptOrder(encryptedData, nonce) {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.options.encryptionKey,
      nonce.slice(0, 16)
    );
    
    const tag = encryptedData.slice(-16);
    const encrypted = encryptedData.slice(0, -16);
    
    decipher.setAuthTag(tag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]).toString('utf8');
    
    return JSON.parse(decrypted);
  }
  
  /**
   * Serialize order for hashing
   */
  serializeOrder(order) {
    return Buffer.from(JSON.stringify({
      userId: order.userId,
      symbol: order.symbol,
      type: order.type,
      side: order.side,
      price: order.price,
      quantity: order.quantity,
      timestamp: order.timestamp
    }));
  }
  
  /**
   * Get recent orders for analysis
   */
  getRecentOrders(symbol, timeWindow) {
    // This would query order history
    return []; // Placeholder
  }
  
  /**
   * Get user's recent orders
   */
  getUserRecentOrders(userId, timeWindow) {
    // This would query user order history
    return []; // Placeholder
  }
  
  /**
   * Shuffle array (Fisher-Yates)
   */
  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  
  /**
   * Get current batch ID
   */
  getCurrentBatchId() {
    return Math.floor(Date.now() / this.options.auctionDuration);
  }
  
  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeCommitments: this.commitments.size,
      activePrivatePools: this.privatePools.size,
      activeBatches: this.batches.size,
      recentAttacks: this.attackLog.filter(a => 
        a.timestamp > Date.now() - 3600000 // Last hour
      ).length
    };
  }
  
  /**
   * Get attack log
   */
  getAttackLog(limit = 100) {
    return this.attackLog.slice(-limit);
  }
}

module.exports = AdvancedMEVProtection;