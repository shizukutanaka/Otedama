/**
 * Optimized Order Book with O(log n) operations
 * Uses balanced binary search trees for efficient price-time priority matching
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('OptimizedOrderBook');

/**
 * Red-Black Tree Node for efficient price-time priority
 */
class RBTreeNode {
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
 * Red-Black Tree implementation for price levels
 */
class RBTree {
  constructor(compareFn) {
    this.root = null;
    this.size = 0;
    this.compare = compareFn;
  }

  insert(price, order) {
    const node = this._insertNode(price, order);
    this._fixInsert(node);
    this.size++;
    return node;
  }

  delete(price) {
    const node = this._findNode(price);
    if (node) {
      this._deleteNode(node);
      this.size--;
      return true;
    }
    return false;
  }

  find(price) {
    return this._findNode(price);
  }

  getBest() {
    if (!this.root) return null;
    
    // For bids (buy orders): find maximum price (rightmost node)
    // For asks (sell orders): find minimum price (leftmost node)
    let node = this.root;
    if (this.compare === this._buyCompare) {
      // Find maximum (rightmost)
      while (node.right) {
        node = node.right;
      }
    } else {
      // Find minimum (leftmost)
      while (node.left) {
        node = node.left;
      }
    }
    return node;
  }

  getWorst() {
    if (!this.root) return null;
    
    let node = this.root;
    if (this.compare === this._buyCompare) {
      // Find minimum (leftmost)
      while (node.left) {
        node = node.left;
      }
    } else {
      // Find maximum (rightmost)
      while (node.right) {
        node = node.right;
      }
    }
    return node;
  }

  *inOrderTraversal() {
    yield* this._inOrder(this.root);
  }

  *_inOrder(node) {
    if (node) {
      yield* this._inOrder(node.left);
      yield node;
      yield* this._inOrder(node.right);
    }
  }

  _insertNode(price, order) {
    const newNode = new RBTreeNode(price);
    
    if (order) {
      newNode.addOrder(order);
    }

    if (!this.root) {
      this.root = newNode;
      newNode.color = 'BLACK';
      return newNode;
    }

    let current = this.root;
    let parent = null;

    while (current) {
      parent = current;
      const cmp = this.compare(price, current.price);
      
      if (cmp === 0) {
        // Price level exists, add order
        if (order) {
          current.addOrder(order);
        }
        return current;
      } else if (cmp < 0) {
        current = current.left;
      } else {
        current = current.right;
      }
    }

    newNode.parent = parent;
    const cmp = this.compare(price, parent.price);
    if (cmp < 0) {
      parent.left = newNode;
    } else {
      parent.right = newNode;
    }

    return newNode;
  }

  _findNode(price) {
    let current = this.root;
    
    while (current) {
      const cmp = this.compare(price, current.price);
      if (cmp === 0) {
        return current;
      } else if (cmp < 0) {
        current = current.left;
      } else {
        current = current.right;
      }
    }
    
    return null;
  }

  _deleteNode(node) {
    // Red-Black tree deletion with color fixing
    let nodeToDelete = node;
    let originalColor = nodeToDelete.color;
    let replacementNode;

    if (!node.left) {
      replacementNode = node.right;
      this._transplant(node, node.right);
    } else if (!node.right) {
      replacementNode = node.left;
      this._transplant(node, node.left);
    } else {
      nodeToDelete = this._minimum(node.right);
      originalColor = nodeToDelete.color;
      replacementNode = nodeToDelete.right;

      if (nodeToDelete.parent === node) {
        if (replacementNode) replacementNode.parent = nodeToDelete;
      } else {
        this._transplant(nodeToDelete, nodeToDelete.right);
        nodeToDelete.right = node.right;
        nodeToDelete.right.parent = nodeToDelete;
      }

      this._transplant(node, nodeToDelete);
      nodeToDelete.left = node.left;
      nodeToDelete.left.parent = nodeToDelete;
      nodeToDelete.color = node.color;
    }

    if (originalColor === 'BLACK' && replacementNode) {
      this._fixDelete(replacementNode);
    }
  }

  _transplant(u, v) {
    if (!u.parent) {
      this.root = v;
    } else if (u === u.parent.left) {
      u.parent.left = v;
    } else {
      u.parent.right = v;
    }
    
    if (v) {
      v.parent = u.parent;
    }
  }

  _minimum(node) {
    while (node.left) {
      node = node.left;
    }
    return node;
  }

  _fixInsert(node) {
    while (node.parent && node.parent.color === 'RED') {
      if (node.parent === node.parent.parent.left) {
        const uncle = node.parent.parent.right;
        
        if (uncle && uncle.color === 'RED') {
          node.parent.color = 'BLACK';
          uncle.color = 'BLACK';
          node.parent.parent.color = 'RED';
          node = node.parent.parent;
        } else {
          if (node === node.parent.right) {
            node = node.parent;
            this._rotateLeft(node);
          }
          
          node.parent.color = 'BLACK';
          node.parent.parent.color = 'RED';
          this._rotateRight(node.parent.parent);
        }
      } else {
        const uncle = node.parent.parent.left;
        
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

  _fixDelete(node) {
    while (node !== this.root && node.color === 'BLACK') {
      if (node === node.parent.left) {
        let sibling = node.parent.right;
        
        if (sibling.color === 'RED') {
          sibling.color = 'BLACK';
          node.parent.color = 'RED';
          this._rotateLeft(node.parent);
          sibling = node.parent.right;
        }
        
        if ((!sibling.left || sibling.left.color === 'BLACK') &&
            (!sibling.right || sibling.right.color === 'BLACK')) {
          sibling.color = 'RED';
          node = node.parent;
        } else {
          if (!sibling.right || sibling.right.color === 'BLACK') {
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
        let sibling = node.parent.left;
        
        if (sibling.color === 'RED') {
          sibling.color = 'BLACK';
          node.parent.color = 'RED';
          this._rotateRight(node.parent);
          sibling = node.parent.left;
        }
        
        if ((!sibling.right || sibling.right.color === 'BLACK') &&
            (!sibling.left || sibling.left.color === 'BLACK')) {
          sibling.color = 'RED';
          node = node.parent;
        } else {
          if (!sibling.left || sibling.left.color === 'BLACK') {
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

  _rotateLeft(node) {
    const rightChild = node.right;
    node.right = rightChild.left;
    
    if (rightChild.left) {
      rightChild.left.parent = node;
    }
    
    rightChild.parent = node.parent;
    
    if (!node.parent) {
      this.root = rightChild;
    } else if (node === node.parent.left) {
      node.parent.left = rightChild;
    } else {
      node.parent.right = rightChild;
    }
    
    rightChild.left = node;
    node.parent = rightChild;
  }

  _rotateRight(node) {
    const leftChild = node.left;
    node.left = leftChild.right;
    
    if (leftChild.right) {
      leftChild.right.parent = node;
    }
    
    leftChild.parent = node.parent;
    
    if (!node.parent) {
      this.root = leftChild;
    } else if (node === node.parent.right) {
      node.parent.right = leftChild;
    } else {
      node.parent.left = leftChild;
    }
    
    leftChild.right = node;
    node.parent = leftChild;
  }

  _buyCompare(a, b) {
    // For buy orders (bids): higher prices first
    return b - a;
  }

  _sellCompare(a, b) {
    // For sell orders (asks): lower prices first
    return a - b;
  }
}

/**
 * Optimized Order Book with O(log n) operations
 */
export class OptimizedOrderBook extends EventEmitter {
  constructor(symbol, options = {}) {
    super();
    
    this.symbol = symbol;
    this.options = {
      maxPriceLevels: options.maxPriceLevels || 1000,
      tickSize: options.tickSize || 0.01,
      ...options
    };
    
    // Separate trees for bids and asks with appropriate comparison functions
    this.bids = new RBTree((a, b) => b - a); // Higher prices first
    this.asks = new RBTree((a, b) => a - b); // Lower prices first
    
    // Order tracking
    this.orders = new Map();
    this.ordersByUser = new Map();
    
    // Statistics
    this.stats = {
      totalOrders: 0,
      totalVolume: 0,
      bestBid: null,
      bestAsk: null,
      spread: null,
      lastPrice: null,
      lastTradeTime: null
    };

    this.logger = logger;
  }

  /**
   * Add order to book - O(log n) complexity
   */
  addOrder(order) {
    const price = this._normalizePrice(order.price);
    const tree = order.side === 'buy' ? this.bids : this.asks;
    
    // Store order
    this.orders.set(order.id, { ...order, price });
    
    // Track user orders
    if (!this.ordersByUser.has(order.userId)) {
      this.ordersByUser.set(order.userId, new Set());
    }
    this.ordersByUser.get(order.userId).add(order.id);
    
    // Add to appropriate tree
    tree.insert(price, { ...order, price });
    
    // Update statistics
    this.stats.totalOrders++;
    this.stats.totalVolume += order.remainingQuantity;
    this._updateBestPrices();
    
    this.emit('order:added', order);
    
    return true;
  }

  /**
   * Remove order from book - O(log n) complexity
   */
  removeOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) return false;
    
    const tree = order.side === 'buy' ? this.bids : this.asks;
    const priceNode = tree.find(order.price);
    
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
        
        // Update statistics
        this.stats.totalOrders--;
        this.stats.totalVolume -= removedOrder.remainingQuantity;
        this._updateBestPrices();
        
        this.emit('order:removed', removedOrder);
        
        return removedOrder;
      }
    }
    
    return false;
  }

  /**
   * Update order quantity - O(log n) complexity
   */
  updateOrder(orderId, updates) {
    const order = this.orders.get(orderId);
    if (!order) return false;
    
    const tree = order.side === 'buy' ? this.bids : this.asks;
    const priceNode = tree.find(order.price);
    
    if (priceNode && updates.remainingQuantity !== undefined) {
      const oldQty = order.remainingQuantity;
      const newQty = updates.remainingQuantity;
      
      // Update in tree
      priceNode.updateQuantity(orderId, oldQty, newQty);
      
      // Update order
      Object.assign(order, updates);
      this.orders.set(orderId, order);
      
      // Update statistics
      this.stats.totalVolume = this.stats.totalVolume - oldQty + newQty;
      
      // Remove if filled
      if (newQty === 0) {
        this.removeOrder(orderId);
      }
      
      this.emit('order:updated', order, updates);
      
      return true;
    }
    
    return false;
  }

  /**
   * Get best bid price - O(1) complexity
   */
  getBestBid() {
    const bestNode = this.bids.getBest();
    return bestNode ? bestNode.price : null;
  }

  /**
   * Get best ask price - O(1) complexity  
   */
  getBestAsk() {
    const bestNode = this.asks.getBest();
    return bestNode ? bestNode.price : null;
  }

  /**
   * Get order book depth - O(k) where k is depth levels
   */
  getDepth(maxLevels = 10) {
    const bids = [];
    const asks = [];
    
    let count = 0;
    for (const node of this.bids.inOrderTraversal()) {
      if (count >= maxLevels) break;
      bids.push({
        price: node.price,
        quantity: node.totalQuantity,
        orderCount: node.orders.length
      });
      count++;
    }
    
    count = 0;
    for (const node of this.asks.inOrderTraversal()) {
      if (count >= maxLevels) break;
      asks.push({
        price: node.price,
        quantity: node.totalQuantity,
        orderCount: node.orders.length
      });
      count++;
    }
    
    return { bids, asks };
  }

  /**
   * Match order against book - optimized for performance
   */
  matchOrder(order) {
    const matches = [];
    let remainingQty = order.remainingQuantity || order.quantity;
    
    const oppositeTree = order.side === 'buy' ? this.asks : this.bids;
    
    // Get price nodes in order of priority
    const priceNodes = Array.from(oppositeTree.inOrderTraversal());
    
    for (const priceNode of priceNodes) {
      if (remainingQty <= 0) break;
      
      // Check price compatibility
      if (!this._canMatch(order, priceNode.price)) break;
      
      // Match against orders at this price level (FIFO)
      for (let i = 0; i < priceNode.orders.length && remainingQty > 0; i++) {
        const oppositeOrder = priceNode.orders[i];
        const matchQty = Math.min(remainingQty, oppositeOrder.remainingQuantity);
        
        if (matchQty > 0) {
          const match = {
            matchId: this._generateId(),
            symbol: this.symbol,
            price: priceNode.price,
            quantity: matchQty,
            takerOrder: order,
            makerOrder: oppositeOrder,
            timestamp: Date.now()
          };
          
          matches.push(match);
          
          // Update quantities
          remainingQty -= matchQty;
          oppositeOrder.remainingQuantity -= matchQty;
          oppositeOrder.filledQuantity = (oppositeOrder.filledQuantity || 0) + matchQty;
          
          // Update order tracking
          this.updateOrder(oppositeOrder.id, {
            remainingQuantity: oppositeOrder.remainingQuantity,
            filledQuantity: oppositeOrder.filledQuantity,
            status: oppositeOrder.remainingQuantity === 0 ? 'filled' : 'partial'
          });
        }
      }
      
      // Clean up empty price level
      priceNode.orders = priceNode.orders.filter(o => o.remainingQuantity > 0);
      priceNode.totalQuantity = priceNode.orders.reduce((sum, o) => sum + o.remainingQuantity, 0);
      
      if (priceNode.isEmpty()) {
        oppositeTree.delete(priceNode.price);
      }
    }
    
    // Update statistics
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      this.stats.lastPrice = lastMatch.price;
      this.stats.lastTradeTime = lastMatch.timestamp;
    }
    
    this._updateBestPrices();
    
    return {
      matches,
      remainingQuantity: remainingQty,
      fullyMatched: remainingQty === 0
    };
  }

  /**
   * Get orders by user
   */
  getUserOrders(userId) {
    const userOrderIds = this.ordersByUser.get(userId);
    if (!userOrderIds) return [];
    
    return Array.from(userOrderIds)
      .map(id => this.orders.get(id))
      .filter(Boolean);
  }

  /**
   * Get order by ID
   */
  getOrder(orderId) {
    return this.orders.get(orderId);
  }

  /**
   * Get current spread
   */
  getSpread() {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    
    if (bestBid && bestAsk) {
      return {
        absolute: bestAsk - bestBid,
        percentage: ((bestAsk - bestBid) / bestAsk) * 100
      };
    }
    
    return null;
  }

  /**
   * Get order book statistics
   */
  getStats() {
    return {
      ...this.stats,
      bestBid: this.getBestBid(),
      bestAsk: this.getBestAsk(),
      spread: this.getSpread(),
      bidLevels: this.bids.size,
      askLevels: this.asks.size
    };
  }

  /**
   * Clear all orders
   */
  clear() {
    this.bids = new RBTree((a, b) => b - a);
    this.asks = new RBTree((a, b) => a - b);
    this.orders.clear();
    this.ordersByUser.clear();
    
    this.stats = {
      totalOrders: 0,
      totalVolume: 0,
      bestBid: null,
      bestAsk: null,
      spread: null,
      lastPrice: null,
      lastTradeTime: null
    };
    
    this.emit('book:cleared');
  }

  // Private methods
  
  _normalizePrice(price) {
    return Math.round(price / this.options.tickSize) * this.options.tickSize;
  }

  _canMatch(order, price) {
    if (order.type === 'market') return true;
    
    if (order.side === 'buy') {
      return order.price >= price;
    } else {
      return order.price <= price;
    }
  }

  _updateBestPrices() {
    this.stats.bestBid = this.getBestBid();
    this.stats.bestAsk = this.getBestAsk();
    this.stats.spread = this.getSpread();
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

export default OptimizedOrderBook;