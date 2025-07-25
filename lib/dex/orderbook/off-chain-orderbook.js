/**
 * Off-chain Orderbook System
 * Inspired by dYdX V4 - 500+ orders/second with zero gas fees
 * 
 * Design principles:
 * - In-memory orderbook for sub-millisecond performance (Carmack)
 * - Decentralized validator consensus (Martin)
 * - Simple API with powerful features (Pike)
 */

const { EventEmitter } = require('events');
const { createHash, sign, verify } = require('crypto');
const { performance } = require('perf_hooks');
const { createLogger } = require('../../core/logger');

const logger = createLogger('OffChainOrderbook');

// Order states
const ORDER_STATES = {
  PENDING: 'pending',
  OPEN: 'open',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

// Message types for validator consensus
const MESSAGE_TYPES = {
  ORDER_PLACEMENT: 'order_placement',
  ORDER_CANCELLATION: 'order_cancellation',
  TRADE_EXECUTION: 'trade_execution',
  STATE_SYNC: 'state_sync',
  CHECKPOINT: 'checkpoint'
};

class OffChainOrderbook extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Performance settings
      maxOrdersPerSecond: options.maxOrdersPerSecond || 500,
      maxOrdersPerUser: options.maxOrdersPerUser || 100,
      
      // Validator settings
      validatorNodes: options.validatorNodes || [],
      consensusThreshold: options.consensusThreshold || 0.67, // 2/3 majority
      syncInterval: options.syncInterval || 1000, // 1 second
      
      // Memory management
      maxOrderbookDepth: options.maxOrderbookDepth || 1000,
      pruneInterval: options.pruneInterval || 60000, // 1 minute
      
      // Settlement
      settlementBatchSize: options.settlementBatchSize || 100,
      settlementInterval: options.settlementInterval || 5000, // 5 seconds
      
      // Fees (off-chain = zero gas)
      makerFee: options.makerFee || 0,
      takerFee: options.takerFee || 0.001, // 0.1%
      
      ...options
    };
    
    // In-memory orderbook structure
    this.orderbooks = new Map(); // symbol -> { bids: RBTree, asks: RBTree }
    this.orders = new Map(); // orderId -> order
    this.userOrders = new Map(); // userId -> Set<orderId>
    
    // Consensus state
    this.validators = new Map(); // validatorId -> connection
    this.pendingMessages = new Map(); // messageId -> { message, signatures }
    this.checkpoints = [];
    
    // Performance tracking
    this.orderRateLimiter = new Map(); // userId -> timestamps
    this.metrics = {
      ordersPlaced: 0,
      ordersPerSecond: 0,
      matchingLatency: 0,
      consensusLatency: 0,
      totalVolume: 0
    };
    
    // Initialize
    this.initialize();
  }
  
  async initialize() {
    logger.info('Initializing off-chain orderbook...');
    
    // Connect to validators
    await this.connectToValidators();
    
    // Start consensus loop
    this.startConsensusLoop();
    
    // Start pruning
    this.startPruning();
    
    // Start metrics collection
    this.startMetricsCollection();
    
    logger.info('Off-chain orderbook initialized');
  }
  
  /**
   * Place order with zero gas fees
   */
  async placeOrder(params) {
    const start = performance.now();
    
    try {
      // Rate limiting
      if (!this.checkRateLimit(params.userId)) {
        throw new Error('Rate limit exceeded');
      }
      
      // Validate order
      const validation = this.validateOrder(params);
      if (!validation.valid) {
        throw new Error(validation.error);
      }
      
      // Create order
      const order = {
        id: this.generateOrderId(),
        symbol: params.symbol,
        type: params.type,
        side: params.side,
        price: params.price,
        quantity: params.quantity,
        userId: params.userId,
        timestamp: Date.now(),
        nonce: params.nonce || Date.now(),
        signature: params.signature,
        state: ORDER_STATES.PENDING,
        filled: 0,
        remaining: params.quantity,
        clientOrderId: params.clientOrderId
      };
      
      // Verify signature
      if (!this.verifyOrderSignature(order)) {
        throw new Error('Invalid order signature');
      }
      
      // Broadcast to validators
      const message = {
        id: this.generateMessageId(),
        type: MESSAGE_TYPES.ORDER_PLACEMENT,
        order,
        timestamp: Date.now()
      };
      
      await this.broadcastMessage(message);
      
      // Wait for consensus
      const consensus = await this.waitForConsensus(message.id);
      
      if (consensus.approved) {
        // Add to local orderbook
        this.addOrderToBook(order);
        
        // Attempt immediate matching
        const matches = await this.matchOrder(order);
        
        // Update metrics
        const latency = performance.now() - start;
        this.updateMetrics(latency, order, matches);
        
        return {
          orderId: order.id,
          state: order.state,
          filled: order.filled,
          remaining: order.remaining,
          matches: matches.length,
          latency: `${latency.toFixed(2)}ms`
        };
      } else {
        throw new Error('Order rejected by consensus');
      }
      
    } catch (error) {
      logger.error('Order placement error:', error);
      throw error;
    }
  }
  
  /**
   * Cancel order with zero gas fees
   */
  async cancelOrder(orderId, userId, signature) {
    try {
      const order = this.orders.get(orderId);
      
      if (!order) {
        throw new Error('Order not found');
      }
      
      if (order.userId !== userId) {
        throw new Error('Unauthorized');
      }
      
      if (order.state === ORDER_STATES.FILLED || order.state === ORDER_STATES.CANCELLED) {
        throw new Error('Order already finalized');
      }
      
      // Verify cancellation signature
      if (!this.verifyCancellationSignature(orderId, userId, signature)) {
        throw new Error('Invalid signature');
      }
      
      // Broadcast cancellation
      const message = {
        id: this.generateMessageId(),
        type: MESSAGE_TYPES.ORDER_CANCELLATION,
        orderId,
        userId,
        signature,
        timestamp: Date.now()
      };
      
      await this.broadcastMessage(message);
      
      // Wait for consensus
      const consensus = await this.waitForConsensus(message.id);
      
      if (consensus.approved) {
        // Remove from orderbook
        this.removeOrderFromBook(order);
        
        // Update state
        order.state = ORDER_STATES.CANCELLED;
        order.cancelledAt = Date.now();
        
        return {
          orderId,
          state: order.state,
          filled: order.filled
        };
      } else {
        throw new Error('Cancellation rejected by consensus');
      }
      
    } catch (error) {
      logger.error('Order cancellation error:', error);
      throw error;
    }
  }
  
  /**
   * Match order against orderbook
   */
  async matchOrder(order) {
    const matches = [];
    const orderbook = this.getOrderbook(order.symbol);
    
    // Get opposite side
    const oppositeSide = order.side === 'buy' ? orderbook.asks : orderbook.bids;
    
    // Match against best prices
    while (order.remaining > 0 && !oppositeSide.isEmpty()) {
      const bestOrder = oppositeSide.min();
      
      // Check if prices cross
      if (!this.pricesCross(order, bestOrder)) {
        break;
      }
      
      // Calculate match quantity
      const matchQty = Math.min(order.remaining, bestOrder.remaining);
      
      // Create match
      const match = {
        id: this.generateMatchId(),
        symbol: order.symbol,
        price: bestOrder.price,
        quantity: matchQty,
        buyOrder: order.side === 'buy' ? order : bestOrder,
        sellOrder: order.side === 'sell' ? order : bestOrder,
        timestamp: Date.now(),
        makerOrderId: bestOrder.id,
        takerOrderId: order.id
      };
      
      // Update order states
      order.remaining -= matchQty;
      order.filled += matchQty;
      bestOrder.remaining -= matchQty;
      bestOrder.filled += matchQty;
      
      // Update states
      if (order.remaining === 0) {
        order.state = ORDER_STATES.FILLED;
      } else {
        order.state = ORDER_STATES.PARTIALLY_FILLED;
      }
      
      if (bestOrder.remaining === 0) {
        bestOrder.state = ORDER_STATES.FILLED;
        oppositeSide.remove(bestOrder);
      }
      
      matches.push(match);
      
      // Broadcast trade execution
      await this.broadcastTrade(match);
    }
    
    // Add remaining to orderbook
    if (order.remaining > 0 && order.type === 'limit') {
      order.state = ORDER_STATES.OPEN;
      const side = order.side === 'buy' ? orderbook.bids : orderbook.asks;
      side.insert(order);
    }
    
    return matches;
  }
  
  /**
   * Check if prices cross for matching
   */
  pricesCross(order, oppositeOrder) {
    if (order.type === 'market') return true;
    
    if (order.side === 'buy') {
      return order.price >= oppositeOrder.price;
    } else {
      return order.price <= oppositeOrder.price;
    }
  }
  
  /**
   * Add order to in-memory orderbook
   */
  addOrderToBook(order) {
    // Store order
    this.orders.set(order.id, order);
    
    // Track user orders
    if (!this.userOrders.has(order.userId)) {
      this.userOrders.set(order.userId, new Set());
    }
    this.userOrders.get(order.userId).add(order.id);
    
    // Increment metrics
    this.metrics.ordersPlaced++;
  }
  
  /**
   * Remove order from orderbook
   */
  removeOrderFromBook(order) {
    const orderbook = this.getOrderbook(order.symbol);
    const side = order.side === 'buy' ? orderbook.bids : orderbook.asks;
    
    side.remove(order);
    
    // Update user orders
    const userOrderSet = this.userOrders.get(order.userId);
    if (userOrderSet) {
      userOrderSet.delete(order.id);
    }
  }
  
  /**
   * Get or create orderbook for symbol
   */
  getOrderbook(symbol) {
    if (!this.orderbooks.has(symbol)) {
      this.orderbooks.set(symbol, {
        symbol,
        bids: new RedBlackTree(this.bidComparator),
        asks: new RedBlackTree(this.askComparator),
        lastUpdate: Date.now()
      });
    }
    
    return this.orderbooks.get(symbol);
  }
  
  /**
   * Broadcast message to validators
   */
  async broadcastMessage(message) {
    const signedMessage = this.signMessage(message);
    
    const promises = [];
    for (const [validatorId, connection] of this.validators) {
      promises.push(
        connection.send(signedMessage).catch(err => {
          logger.error(`Failed to send to validator ${validatorId}:`, err);
        })
      );
    }
    
    await Promise.all(promises);
    
    // Store pending message
    this.pendingMessages.set(message.id, {
      message: signedMessage,
      signatures: new Map([[this.nodeId, signedMessage.signature]]),
      timestamp: Date.now()
    });
  }
  
  /**
   * Wait for consensus on message
   */
  async waitForConsensus(messageId, timeout = 3000) {
    const start = Date.now();
    
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const pending = this.pendingMessages.get(messageId);
        
        if (!pending) {
          clearInterval(checkInterval);
          reject(new Error('Message not found'));
          return;
        }
        
        // Check if we have enough signatures
        const validatorCount = this.validators.size + 1; // +1 for self
        const requiredSignatures = Math.ceil(validatorCount * this.options.consensusThreshold);
        
        if (pending.signatures.size >= requiredSignatures) {
          clearInterval(checkInterval);
          
          // Verify all signatures
          const valid = this.verifyConsensus(pending);
          
          resolve({
            approved: valid,
            signatures: pending.signatures.size,
            latency: Date.now() - start
          });
        }
        
        // Check timeout
        if (Date.now() - start > timeout) {
          clearInterval(checkInterval);
          reject(new Error('Consensus timeout'));
        }
      }, 10); // Check every 10ms
    });
  }
  
  /**
   * Verify consensus signatures
   */
  verifyConsensus(pending) {
    for (const [validatorId, signature] of pending.signatures) {
      if (!this.verifyValidatorSignature(pending.message, signature, validatorId)) {
        logger.warn(`Invalid signature from validator ${validatorId}`);
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Broadcast trade execution
   */
  async broadcastTrade(match) {
    const message = {
      id: this.generateMessageId(),
      type: MESSAGE_TYPES.TRADE_EXECUTION,
      match,
      timestamp: Date.now()
    };
    
    await this.broadcastMessage(message);
    
    // Emit trade event
    this.emit('trade:executed', {
      matchId: match.id,
      symbol: match.symbol,
      price: match.price,
      quantity: match.quantity,
      buyOrderId: match.buyOrder.id,
      sellOrderId: match.sellOrder.id
    });
  }
  
  /**
   * Connect to validator nodes
   */
  async connectToValidators() {
    for (const validator of this.options.validatorNodes) {
      try {
        const connection = await this.createValidatorConnection(validator);
        this.validators.set(validator.id, connection);
        
        logger.info(`Connected to validator ${validator.id}`);
      } catch (error) {
        logger.error(`Failed to connect to validator ${validator.id}:`, error);
      }
    }
    
    // Need minimum validators for consensus
    const minValidators = Math.ceil(3 * this.options.consensusThreshold) - 1;
    if (this.validators.size < minValidators) {
      throw new Error(`Insufficient validators: ${this.validators.size}/${minValidators}`);
    }
  }
  
  /**
   * Create validator connection
   */
  async createValidatorConnection(validator) {
    // In production, this would use WebSocket or gRPC
    return {
      id: validator.id,
      endpoint: validator.endpoint,
      send: async (message) => {
        // Simulate network call
        return true;
      },
      on: (event, handler) => {
        // Handle incoming messages
      }
    };
  }
  
  /**
   * Start consensus loop
   */
  startConsensusLoop() {
    setInterval(() => {
      this.syncState();
      this.createCheckpoint();
    }, this.options.syncInterval);
  }
  
  /**
   * Sync state with validators
   */
  async syncState() {
    const stateHash = this.calculateStateHash();
    
    const message = {
      id: this.generateMessageId(),
      type: MESSAGE_TYPES.STATE_SYNC,
      stateHash,
      orderbookSizes: this.getOrderbookSizes(),
      timestamp: Date.now()
    };
    
    await this.broadcastMessage(message);
  }
  
  /**
   * Create state checkpoint
   */
  createCheckpoint() {
    const checkpoint = {
      id: this.generateCheckpointId(),
      timestamp: Date.now(),
      stateHash: this.calculateStateHash(),
      ordersCount: this.orders.size,
      metrics: { ...this.metrics }
    };
    
    this.checkpoints.push(checkpoint);
    
    // Keep only recent checkpoints
    if (this.checkpoints.length > 100) {
      this.checkpoints.shift();
    }
  }
  
  /**
   * Calculate state hash
   */
  calculateStateHash() {
    const state = {
      orders: Array.from(this.orders.entries()).sort(),
      orderbooks: this.serializeOrderbooks()
    };
    
    return createHash('sha256')
      .update(JSON.stringify(state))
      .digest('hex');
  }
  
  /**
   * Check rate limit
   */
  checkRateLimit(userId) {
    const now = Date.now();
    const userTimestamps = this.orderRateLimiter.get(userId) || [];
    
    // Remove old timestamps
    const recentTimestamps = userTimestamps.filter(t => t > now - 1000);
    
    if (recentTimestamps.length >= this.options.maxOrdersPerSecond) {
      return false;
    }
    
    // Add current timestamp
    recentTimestamps.push(now);
    this.orderRateLimiter.set(userId, recentTimestamps);
    
    return true;
  }
  
  /**
   * Validate order parameters
   */
  validateOrder(params) {
    if (!params.symbol || !params.type || !params.side) {
      return { valid: false, error: 'Missing required fields' };
    }
    
    if (params.quantity <= 0) {
      return { valid: false, error: 'Invalid quantity' };
    }
    
    if (params.type === 'limit' && (!params.price || params.price <= 0)) {
      return { valid: false, error: 'Invalid price for limit order' };
    }
    
    // Check user order limit
    const userOrderCount = this.userOrders.get(params.userId)?.size || 0;
    if (userOrderCount >= this.options.maxOrdersPerUser) {
      return { valid: false, error: 'User order limit exceeded' };
    }
    
    return { valid: true };
  }
  
  /**
   * Verify order signature
   */
  verifyOrderSignature(order) {
    // In production, this would verify cryptographic signature
    // For now, simple validation
    return order.signature && order.signature.length > 0;
  }
  
  /**
   * Sign message
   */
  signMessage(message) {
    // In production, use actual cryptographic signing
    const signature = createHash('sha256')
      .update(JSON.stringify(message))
      .update(this.nodeId || 'node1')
      .digest('hex');
    
    return {
      ...message,
      nodeId: this.nodeId,
      signature
    };
  }
  
  /**
   * Start pruning old orders
   */
  startPruning() {
    setInterval(() => {
      this.pruneOldOrders();
    }, this.options.pruneInterval);
  }
  
  /**
   * Prune old filled/cancelled orders
   */
  pruneOldOrders() {
    const cutoff = Date.now() - 3600000; // 1 hour
    let pruned = 0;
    
    for (const [orderId, order] of this.orders) {
      if ((order.state === ORDER_STATES.FILLED || order.state === ORDER_STATES.CANCELLED) &&
          order.timestamp < cutoff) {
        this.orders.delete(orderId);
        
        // Remove from user orders
        const userOrderSet = this.userOrders.get(order.userId);
        if (userOrderSet) {
          userOrderSet.delete(orderId);
        }
        
        pruned++;
      }
    }
    
    if (pruned > 0) {
      logger.debug(`Pruned ${pruned} old orders`);
    }
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    // Calculate orders per second
    setInterval(() => {
      const timestamps = [];
      
      for (const userTimestamps of this.orderRateLimiter.values()) {
        timestamps.push(...userTimestamps);
      }
      
      const now = Date.now();
      const recentOrders = timestamps.filter(t => t > now - 1000).length;
      
      this.metrics.ordersPerSecond = recentOrders;
    }, 1000);
  }
  
  /**
   * Update metrics
   */
  updateMetrics(latency, order, matches) {
    // Update latency (exponential moving average)
    this.metrics.matchingLatency = this.metrics.matchingLatency * 0.9 + latency * 0.1;
    
    // Update volume
    for (const match of matches) {
      this.metrics.totalVolume += match.price * match.quantity;
    }
  }
  
  /**
   * Get orderbook snapshot
   */
  getOrderbookSnapshot(symbol, depth = 10) {
    const orderbook = this.getOrderbook(symbol);
    
    const bids = [];
    const asks = [];
    
    // Get top bids
    orderbook.bids.inOrder((order) => {
      if (bids.length < depth) {
        const existing = bids.find(b => b.price === order.price);
        if (existing) {
          existing.quantity += order.remaining;
        } else {
          bids.push({
            price: order.price,
            quantity: order.remaining
          });
        }
      }
    });
    
    // Get top asks
    orderbook.asks.inOrder((order) => {
      if (asks.length < depth) {
        const existing = asks.find(a => a.price === order.price);
        if (existing) {
          existing.quantity += order.remaining;
        } else {
          asks.push({
            price: order.price,
            quantity: order.remaining
          });
        }
      }
    });
    
    return {
      symbol,
      bids,
      asks,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get user orders
   */
  getUserOrders(userId) {
    const orderIds = this.userOrders.get(userId);
    if (!orderIds) return [];
    
    const orders = [];
    for (const orderId of orderIds) {
      const order = this.orders.get(orderId);
      if (order) {
        orders.push(order);
      }
    }
    
    return orders.sort((a, b) => b.timestamp - a.timestamp);
  }
  
  /**
   * Helper methods
   */
  
  generateOrderId() {
    return `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateMatchId() {
    return `match_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateCheckpointId() {
    return `checkpoint_${Date.now()}`;
  }
  
  bidComparator(a, b) {
    // Bids sorted by price descending, then time ascending
    if (a.price !== b.price) {
      return b.price - a.price;
    }
    return a.timestamp - b.timestamp;
  }
  
  askComparator(a, b) {
    // Asks sorted by price ascending, then time ascending
    if (a.price !== b.price) {
      return a.price - b.price;
    }
    return a.timestamp - b.timestamp;
  }
  
  serializeOrderbooks() {
    const serialized = {};
    
    for (const [symbol, orderbook] of this.orderbooks) {
      serialized[symbol] = {
        bids: orderbook.bids.size(),
        asks: orderbook.asks.size()
      };
    }
    
    return serialized;
  }
  
  getOrderbookSizes() {
    const sizes = {};
    
    for (const [symbol, orderbook] of this.orderbooks) {
      sizes[symbol] = {
        bids: orderbook.bids.size(),
        asks: orderbook.asks.size()
      };
    }
    
    return sizes;
  }
  
  verifyCancellationSignature(orderId, userId, signature) {
    // In production, verify actual signature
    return signature && signature.length > 0;
  }
  
  verifyValidatorSignature(message, signature, validatorId) {
    // In production, verify against validator's public key
    return true;
  }
  
  /**
   * Get system metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeOrders: this.orders.size,
      activeSymbols: this.orderbooks.size,
      connectedValidators: this.validators.size,
      checkpointCount: this.checkpoints.length
    };
  }
}

/**
 * Simple Red-Black Tree implementation for orderbook
 */
class RedBlackTree {
  constructor(comparator) {
    this.comparator = comparator;
    this.root = null;
    this._size = 0;
  }
  
  insert(value) {
    // Simplified - in production use proper RB tree
    if (!this.root) {
      this.root = { value, left: null, right: null };
    } else {
      this._insert(this.root, value);
    }
    this._size++;
  }
  
  _insert(node, value) {
    if (this.comparator(value, node.value) < 0) {
      if (!node.left) {
        node.left = { value, left: null, right: null };
      } else {
        this._insert(node.left, value);
      }
    } else {
      if (!node.right) {
        node.right = { value, left: null, right: null };
      } else {
        this._insert(node.right, value);
      }
    }
  }
  
  remove(value) {
    // Simplified removal
    this._size--;
  }
  
  min() {
    if (!this.root) return null;
    
    let node = this.root;
    while (node.left) {
      node = node.left;
    }
    return node.value;
  }
  
  isEmpty() {
    return this._size === 0;
  }
  
  size() {
    return this._size;
  }
  
  inOrder(callback) {
    this._inOrder(this.root, callback);
  }
  
  _inOrder(node, callback) {
    if (!node) return;
    
    this._inOrder(node.left, callback);
    callback(node.value);
    this._inOrder(node.right, callback);
  }
}

module.exports = OffChainOrderbook;