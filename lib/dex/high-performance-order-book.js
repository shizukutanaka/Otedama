/**
 * High-Performance Order Book with O(log n) operations
 * Uses Red-Black tree for optimal price-time priority matching
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('HighPerformanceOrderBook');

/**
 * Red-Black Tree Node for price levels
 */
class RBNode {
  constructor(price, order = null) {
    this.price = price;
    this.orders = order ? [order] : [];
    this.totalQuantity = order ? order.remainingQuantity : 0;
    this.color = 'RED';
    this.left = null;
    this.right = null;
    this.parent = null;
  }

  addOrder(order) {
    this.orders.push(order);
    this.totalQuantity += order.remainingQuantity;
  }

  removeOrder(orderId) {
    const index = this.orders.findIndex(o => o.id === orderId);
    if (index !== -1) {
      const order = this.orders[index];
      this.orders.splice(index, 1);
      this.totalQuantity -= order.remainingQuantity;
      return order;
    }
    return null;
  }

  updateQuantity(orderId, oldQty, newQty) {
    const order = this.orders.find(o => o.id === orderId);
    if (order) {
      this.totalQuantity = this.totalQuantity - oldQty + newQty;
      return true;
    }
    return false;
  }

  isEmpty() {
    return this.orders.length === 0;
  }
}

/**
 * Red-Black Tree implementation for O(log n) operations
 */
class RedBlackTree {
  constructor(compareFn) {
    this.root = null;
    this.size = 0;
    this.compare = compareFn;
    this.NIL = { color: 'BLACK' }; // Sentinel node
  }

  insert(price, order) {
    let node = this.findNode(price);
    if (node) {
      // Price level exists, add order
      node.addOrder(order);
      return node;
    }

    // Create new price level
    node = new RBNode(price, order);
    node.left = this.NIL;
    node.right = this.NIL;
    
    this._insertNode(node);
    this._fixInsertion(node);
    this.size++;
    return node;
  }

  delete(price) {
    const node = this.findNode(price);
    if (node) {
      this._deleteNode(node);
      this.size--;
      return true;
    }
    return false;
  }

  findNode(price) {
    let current = this.root;
    while (current && current !== this.NIL) {
      const cmp = this.compare(price, current.price);
      if (cmp === 0) return current;
      current = cmp < 0 ? current.left : current.right;
    }
    return null;
  }

  getBest() {
    if (!this.root || this.root === this.NIL) return null;
    
    let node = this.root;
    // For bids: rightmost (highest price)
    // For asks: leftmost (lowest price)  
    if (this.compare === this._bidCompare) {
      while (node.right !== this.NIL) node = node.right;
    } else {
      while (node.left !== this.NIL) node = node.left;
    }
    return node;
  }

  *inorderTraversal() {
    yield* this._inorder(this.root);
  }

  *_inorder(node) {
    if (node && node !== this.NIL) {
      yield* this._inorder(node.left);
      yield node;
      yield* this._inorder(node.right);
    }
  }

  _insertNode(node) {
    let parent = null;
    let current = this.root;

    // Find position for new node
    while (current && current !== this.NIL) {
      parent = current;
      const cmp = this.compare(node.price, current.price);
      current = cmp < 0 ? current.left : current.right;
    }

    node.parent = parent;
    if (!parent) {
      this.root = node;
    } else {
      const cmp = this.compare(node.price, parent.price);
      if (cmp < 0) {
        parent.left = node;
      } else {
        parent.right = node;
      }
    }
  }

  _fixInsertion(node) {
    while (node.parent && node.parent.color === 'RED') {
      if (node.parent === node.parent.parent?.left) {
        const uncle = node.parent.parent.right;
        
        if (uncle && uncle.color === 'RED') {
          // Case 1: Uncle is red
          node.parent.color = 'BLACK';
          uncle.color = 'BLACK';
          node.parent.parent.color = 'RED';
          node = node.parent.parent;
        } else {
          if (node === node.parent.right) {
            // Case 2: Node is right child
            node = node.parent;
            this._rotateLeft(node);
          }
          // Case 3: Node is left child
          node.parent.color = 'BLACK';
          node.parent.parent.color = 'RED';
          this._rotateRight(node.parent.parent);
        }
      } else {
        // Mirror cases
        const uncle = node.parent.parent?.left;
        
        if (uncle && uncle.color === 'RED') {
          node.parent.color = 'BLACK';
          uncle.color = 'BLACK';
          node.parent.parent.color = 'RED';
          node = node.parent.parent;
        } else {
          if (node === node.parent.left) {
            node = node.parent;
            this._rotateRight(node);
          }
          node.parent.color = 'BLACK';
          node.parent.parent.color = 'RED';
          this._rotateLeft(node.parent.parent);
        }
      }
    }
    
    this.root.color = 'BLACK';
  }

  _deleteNode(node) {
    let y = node;
    let yOriginalColor = y.color;
    let x;

    if (node.left === this.NIL) {
      x = node.right;
      this._transplant(node, node.right);
    } else if (node.right === this.NIL) {
      x = node.left;
      this._transplant(node, node.left);
    } else {
      y = this._minimum(node.right);
      yOriginalColor = y.color;
      x = y.right;
      
      if (y.parent === node) {
        x.parent = y;
      } else {
        this._transplant(y, y.right);
        y.right = node.right;
        y.right.parent = y;
      }
      
      this._transplant(node, y);
      y.left = node.left;
      y.left.parent = y;
      y.color = node.color;
    }
    
    if (yOriginalColor === 'BLACK') {
      this._fixDeletion(x);
    }
  }

  _fixDeletion(node) {
    while (node !== this.root && node.color === 'BLACK') {
      if (node === node.parent.left) {
        let sibling = node.parent.right;
        
        if (sibling.color === 'RED') {
          sibling.color = 'BLACK';
          node.parent.color = 'RED';
          this._rotateLeft(node.parent);
          sibling = node.parent.right;
        }
        
        if (sibling.left.color === 'BLACK' && sibling.right.color === 'BLACK') {
          sibling.color = 'RED';
          node = node.parent;
        } else {
          if (sibling.right.color === 'BLACK') {
            sibling.left.color = 'BLACK';
            sibling.color = 'RED';
            this._rotateRight(sibling);
            sibling = node.parent.right;
          }
          
          sibling.color = node.parent.color;
          node.parent.color = 'BLACK';
          sibling.right.color = 'BLACK';
          this._rotateLeft(node.parent);
          node = this.root;
        }
      } else {
        // Mirror cases
        let sibling = node.parent.left;
        
        if (sibling.color === 'RED') {
          sibling.color = 'BLACK';
          node.parent.color = 'RED';
          this._rotateRight(node.parent);
          sibling = node.parent.left;
        }
        
        if (sibling.right.color === 'BLACK' && sibling.left.color === 'BLACK') {
          sibling.color = 'RED';
          node = node.parent;
        } else {
          if (sibling.left.color === 'BLACK') {
            sibling.right.color = 'BLACK';
            sibling.color = 'RED';
            this._rotateLeft(sibling);
            sibling = node.parent.left;
          }
          
          sibling.color = node.parent.color;
          node.parent.color = 'BLACK';
          sibling.left.color = 'BLACK';
          this._rotateRight(node.parent);
          node = this.root;
        }
      }
    }
    
    node.color = 'BLACK';
  }

  _transplant(u, v) {
    if (!u.parent) {
      this.root = v;
    } else if (u === u.parent.left) {
      u.parent.left = v;
    } else {
      u.parent.right = v;
    }
    v.parent = u.parent;
  }

  _minimum(node) {
    while (node.left !== this.NIL) {
      node = node.left;
    }
    return node;
  }

  _rotateLeft(node) {
    const y = node.right;
    node.right = y.left;
    
    if (y.left !== this.NIL) {
      y.left.parent = node;
    }
    
    y.parent = node.parent;
    
    if (!node.parent) {
      this.root = y;
    } else if (node === node.parent.left) {
      node.parent.left = y;
    } else {
      node.parent.right = y;
    }
    
    y.left = node;
    node.parent = y;
  }

  _rotateRight(node) {
    const y = node.left;
    node.left = y.right;
    
    if (y.right !== this.NIL) {
      y.right.parent = node;
    }
    
    y.parent = node.parent;
    
    if (!node.parent) {
      this.root = y;
    } else if (node === node.parent.right) {
      node.parent.right = y;
    } else {
      node.parent.left = y;
    }
    
    y.right = node;
    node.parent = y;
  }

  _bidCompare(a, b) {
    return b - a; // Higher prices first for bids
  }

  _askCompare(a, b) {
    return a - b; // Lower prices first for asks
  }
}

/**
 * High-Performance Order Book
 */
export class HighPerformanceOrderBook extends EventEmitter {
  constructor(symbol, options = {}) {
    super();
    
    this.symbol = symbol;
    this.options = {
      maxPriceLevels: options.maxPriceLevels || 1000,
      tickSize: options.tickSize || 0.01,
      enableMetrics: options.enableMetrics !== false,
      ...options
    };
    
    // Red-Black trees for O(log n) operations
    this.bids = new RedBlackTree((a, b) => b - a); // Higher prices first
    this.asks = new RedBlackTree((a, b) => a - b); // Lower prices first
    
    // Order tracking
    this.orders = new Map();
    this.ordersByUser = new Map();
    
    // Performance metrics
    this.metrics = {
      totalOrders: 0,
      totalTrades: 0,
      orderInsertions: 0,
      orderDeletions: 0,
      averageInsertTime: 0,
      averageMatchTime: 0,
      peakOrdersPerSecond: 0
    };
    
    // Statistics
    this.stats = {
      bestBid: null,
      bestAsk: null,
      spread: null,
      lastPrice: null,
      lastTradeTime: null,
      volume24h: 0,
      high24h: 0,
      low24h: 0
    };

    this.logger = logger;
  }

  /**
   * Add order - O(log n) complexity
   */
  addOrder(order) {
    const startTime = this.options.enableMetrics ? process.hrtime.bigint() : null;
    
    try {
      const price = this._normalizePrice(order.price);
      const tree = order.side === 'buy' ? this.bids : this.asks;
      
      // Store order with normalized price
      const normalizedOrder = { ...order, price };
      this.orders.set(order.id, normalizedOrder);
      
      // Track user orders
      if (!this.ordersByUser.has(order.userId)) {
        this.ordersByUser.set(order.userId, new Set());
      }
      this.ordersByUser.get(order.userId).add(order.id);
      
      // Insert into Red-Black tree - O(log n)
      tree.insert(price, normalizedOrder);
      
      // Update metrics
      this.metrics.totalOrders++;
      this.metrics.orderInsertions++;
      
      if (startTime) {
        const duration = Number(process.hrtime.bigint() - startTime) / 1000000;
        this._updateAverage('averageInsertTime', duration);
      }
      
      this._updateBestPrices();
      this.emit('order:added', normalizedOrder);
      
      return true;
    } catch (error) {
      this.logger.error('Order insertion failed:', error);
      return false;
    }
  }

  /**
   * Remove order - O(log n) complexity
   */
  removeOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) return null;
    
    try {
      const tree = order.side === 'buy' ? this.bids : this.asks;
      const priceNode = tree.findNode(order.price);
      
      if (priceNode) {
        const removedOrder = priceNode.removeOrder(orderId);
        
        if (removedOrder) {
          // Remove empty price level
          if (priceNode.isEmpty()) {
            tree.delete(order.price);
          }
          
          // Update tracking
          this.orders.delete(orderId);
          this.ordersByUser.get(order.userId)?.delete(orderId);
          
          this.metrics.orderDeletions++;
          this._updateBestPrices();
          this.emit('order:removed', removedOrder);
          
          return removedOrder;
        }
      }
      
      return null;
    } catch (error) {
      this.logger.error('Order removal failed:', error);
      return null;
    }
  }

  /**
   * Match orders - optimized for high-frequency trading
   */
  matchOrder(incomingOrder) {
    const startTime = this.options.enableMetrics ? process.hrtime.bigint() : null;
    
    try {
      const matches = [];
      let remainingQuantity = incomingOrder.remainingQuantity || incomingOrder.quantity;
      
      const oppositeTree = incomingOrder.side === 'buy' ? this.asks : this.bids;
      
      // Get price levels in order - O(log n) for each level
      for (const priceLevel of oppositeTree.inorderTraversal()) {
        if (remainingQuantity <= 0) break;
        
        // Check price compatibility
        if (!this._canMatch(incomingOrder, priceLevel.price)) break;
        
        // Process orders at this price level (FIFO)
        const ordersToProcess = [...priceLevel.orders]; // Copy to avoid modification during iteration
        
        for (const makerOrder of ordersToProcess) {
          if (remainingQuantity <= 0) break;
          
          const matchQuantity = Math.min(remainingQuantity, makerOrder.remainingQuantity);
          
          if (matchQuantity > 0) {
            // Create trade match
            const match = {
              matchId: this._generateMatchId(),
              symbol: this.symbol,
              price: priceLevel.price,
              quantity: matchQuantity,
              takerOrder: incomingOrder,
              makerOrder: makerOrder,
              timestamp: Date.now()
            };
            
            matches.push(match);
            
            // Update quantities
            remainingQuantity -= matchQuantity;
            makerOrder.remainingQuantity -= matchQuantity;
            makerOrder.filledQuantity = (makerOrder.filledQuantity || 0) + matchQuantity;
            
            // Remove if filled
            if (makerOrder.remainingQuantity === 0) {
              this.removeOrder(makerOrder.id);
            } else {
              // Update quantity in price level
              priceLevel.updateQuantity(
                makerOrder.id, 
                makerOrder.remainingQuantity + matchQuantity, 
                makerOrder.remainingQuantity
              );
            }
          }
        }
      }
      
      // Update statistics
      if (matches.length > 0) {
        this.metrics.totalTrades += matches.length;
        const lastMatch = matches[matches.length - 1];
        this.stats.lastPrice = lastMatch.price;
        this.stats.lastTradeTime = lastMatch.timestamp;
        
        // Update 24h statistics
        const totalVolume = matches.reduce((sum, match) => sum + match.quantity * match.price, 0);
        this.stats.volume24h += totalVolume;
        
        if (!this.stats.high24h || lastMatch.price > this.stats.high24h) {
          this.stats.high24h = lastMatch.price;
        }
        if (!this.stats.low24h || lastMatch.price < this.stats.low24h) {
          this.stats.low24h = lastMatch.price;
        }
      }
      
      if (startTime) {
        const duration = Number(process.hrtime.bigint() - startTime) / 1000000;
        this._updateAverage('averageMatchTime', duration);
      }
      
      return {
        matches,
        remainingQuantity,
        fullyMatched: remainingQuantity === 0
      };
    } catch (error) {
      this.logger.error('Order matching failed:', error);
      return {
        matches: [],
        remainingQuantity: incomingOrder.quantity,
        fullyMatched: false,
        error: error.message
      };
    }
  }

  /**
   * Get order book depth - O(k) where k is depth levels
   */
  getDepth(maxLevels = 20) {
    const bids = [];
    const asks = [];
    
    let count = 0;
    for (const level of this.bids.inorderTraversal()) {
      if (count >= maxLevels) break;
      bids.push({
        price: level.price,
        quantity: level.totalQuantity,
        orders: level.orders.length
      });
      count++;
    }
    
    count = 0;
    for (const level of this.asks.inorderTraversal()) {
      if (count >= maxLevels) break;
      asks.push({
        price: level.price,
        quantity: level.totalQuantity,
        orders: level.orders.length
      });
      count++;
    }
    
    return { symbol: this.symbol, bids, asks, timestamp: Date.now() };
  }

  /**
   * Get best bid/ask - O(1) complexity after tree maintenance
   */
  getBestBidAsk() {
    const bestBid = this.bids.getBest();
    const bestAsk = this.asks.getBest();
    
    return {
      bid: bestBid ? { price: bestBid.price, quantity: bestBid.totalQuantity } : null,
      ask: bestAsk ? { price: bestAsk.price, quantity: bestAsk.totalQuantity } : null,
      spread: bestBid && bestAsk ? bestAsk.price - bestBid.price : null
    };
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    return {
      ...this.stats,
      metrics: this.metrics,
      bidLevels: this.bids.size,
      askLevels: this.asks.size,
      totalOrders: this.orders.size
    };
  }

  /**
   * Clear order book
   */
  clear() {
    this.bids = new RedBlackTree((a, b) => b - a);
    this.asks = new RedBlackTree((a, b) => a - b);
    this.orders.clear();
    this.ordersByUser.clear();
    
    // Reset statistics
    this.stats = {
      bestBid: null,
      bestAsk: null,
      spread: null,
      lastPrice: null,
      lastTradeTime: null,
      volume24h: 0,
      high24h: 0,
      low24h: 0
    };
    
    this.emit('book:cleared');
  }

  // Private helper methods
  
  _normalizePrice(price) {
    return Math.round(price / this.options.tickSize) * this.options.tickSize;
  }

  _canMatch(incomingOrder, priceLevel) {
    if (incomingOrder.type === 'market') return true;
    
    if (incomingOrder.side === 'buy') {
      return incomingOrder.price >= priceLevel;
    } else {
      return incomingOrder.price <= priceLevel;
    }
  }

  _updateBestPrices() {
    const bestBid = this.bids.getBest();
    const bestAsk = this.asks.getBest();
    
    this.stats.bestBid = bestBid?.price || null;
    this.stats.bestAsk = bestAsk?.price || null;
    this.stats.spread = (bestBid && bestAsk) ? bestAsk.price - bestBid.price : null;
  }

  _updateAverage(metric, newValue) {
    const alpha = 0.1; // Exponential moving average factor
    this.metrics[metric] = alpha * newValue + (1 - alpha) * this.metrics[metric];
  }

  _generateMatchId() {
    return `match_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

export default HighPerformanceOrderBook;