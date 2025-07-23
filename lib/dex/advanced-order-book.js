/**
 * Advanced Order Book with Matching Engine
 * High-performance order matching and execution system
 * 
 * Features:
 * - Low-latency order matching
 * - Multiple order types (Market, Limit, Stop, Iceberg, etc.)
 * - Price-time priority matching
 * - Partial fill support
 * - Order book depth analysis
 * - Market making incentives
 * - Cross-market arbitrage detection
 * - Fair ordering and anti-frontrunning
 */

const { EventEmitter } = require('events');
const { RBTree } = require('bintrees');
const crypto = require('crypto');
const { ethers } = require('ethers');
const { createLogger } = require('../core/logger');

const logger = createLogger('order-book');

// Order types
const OrderType = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP: 'stop',
  STOP_LIMIT: 'stop_limit',
  ICEBERG: 'iceberg',
  FILL_OR_KILL: 'fill_or_kill',
  IMMEDIATE_OR_CANCEL: 'immediate_or_cancel',
  POST_ONLY: 'post_only',
  REDUCE_ONLY: 'reduce_only'
};

// Order side
const OrderSide = {
  BUY: 'buy',
  SELL: 'sell'
};

// Order status
const OrderStatus = {
  PENDING: 'pending',
  OPEN: 'open',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
};

// Time in force
const TimeInForce = {
  GTC: 'good_till_cancel',
  IOC: 'immediate_or_cancel',
  FOK: 'fill_or_kill',
  GTT: 'good_till_time',
  GTD: 'good_till_date'
};

class Order {
  constructor(params) {
    this.id = params.id || crypto.randomBytes(16).toString('hex');
    this.userId = params.userId;
    this.type = params.type || OrderType.LIMIT;
    this.side = params.side;
    this.price = params.price ? ethers.BigNumber.from(params.price) : null;
    this.quantity = ethers.BigNumber.from(params.quantity);
    this.filledQuantity = ethers.BigNumber.from(0);
    this.remainingQuantity = this.quantity;
    this.status = OrderStatus.PENDING;
    this.timeInForce = params.timeInForce || TimeInForce.GTC;
    this.timestamp = params.timestamp || Date.now();
    this.expiresAt = params.expiresAt || null;
    
    // Advanced order features
    this.stopPrice = params.stopPrice ? ethers.BigNumber.from(params.stopPrice) : null;
    this.icebergQuantity = params.icebergQuantity ? ethers.BigNumber.from(params.icebergQuantity) : null;
    this.visibleQuantity = this.icebergQuantity || this.quantity;
    this.postOnly = params.postOnly || false;
    this.reduceOnly = params.reduceOnly || false;
    this.clientOrderId = params.clientOrderId || null;
    
    // Execution details
    this.fills = [];
    this.fees = ethers.BigNumber.from(0);
    this.averagePrice = null;
  }

  get isFilled() {
    return this.filledQuantity.eq(this.quantity);
  }

  get isActive() {
    return this.status === OrderStatus.OPEN || 
           this.status === OrderStatus.PARTIALLY_FILLED;
  }

  addFill(price, quantity, fee) {
    const fill = {
      price: ethers.BigNumber.from(price),
      quantity: ethers.BigNumber.from(quantity),
      fee: ethers.BigNumber.from(fee),
      timestamp: Date.now()
    };
    
    this.fills.push(fill);
    this.filledQuantity = this.filledQuantity.add(quantity);
    this.remainingQuantity = this.quantity.sub(this.filledQuantity);
    this.fees = this.fees.add(fee);
    
    // Update average price
    this.updateAveragePrice();
    
    // Update status
    if (this.isFilled) {
      this.status = OrderStatus.FILLED;
    } else {
      this.status = OrderStatus.PARTIALLY_FILLED;
    }
    
    // Update visible quantity for iceberg orders
    if (this.icebergQuantity && this.remainingQuantity.gt(this.icebergQuantity)) {
      this.visibleQuantity = this.icebergQuantity;
    } else {
      this.visibleQuantity = this.remainingQuantity;
    }
  }

  updateAveragePrice() {
    if (this.fills.length === 0) {
      this.averagePrice = null;
      return;
    }
    
    let totalValue = ethers.BigNumber.from(0);
    let totalQuantity = ethers.BigNumber.from(0);
    
    for (const fill of this.fills) {
      totalValue = totalValue.add(fill.price.mul(fill.quantity));
      totalQuantity = totalQuantity.add(fill.quantity);
    }
    
    this.averagePrice = totalValue.div(totalQuantity);
  }

  toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      type: this.type,
      side: this.side,
      price: this.price?.toString(),
      quantity: this.quantity.toString(),
      filledQuantity: this.filledQuantity.toString(),
      remainingQuantity: this.remainingQuantity.toString(),
      status: this.status,
      timeInForce: this.timeInForce,
      timestamp: this.timestamp,
      expiresAt: this.expiresAt,
      stopPrice: this.stopPrice?.toString(),
      icebergQuantity: this.icebergQuantity?.toString(),
      postOnly: this.postOnly,
      reduceOnly: this.reduceOnly,
      fills: this.fills.map(f => ({
        price: f.price.toString(),
        quantity: f.quantity.toString(),
        fee: f.fee.toString(),
        timestamp: f.timestamp
      })),
      fees: this.fees.toString(),
      averagePrice: this.averagePrice?.toString()
    };
  }
}

class PriceLevel {
  constructor(price) {
    this.price = ethers.BigNumber.from(price);
    this.orders = [];
    this.totalQuantity = ethers.BigNumber.from(0);
    this.totalVisibleQuantity = ethers.BigNumber.from(0);
  }

  addOrder(order) {
    this.orders.push(order);
    this.totalQuantity = this.totalQuantity.add(order.remainingQuantity);
    this.totalVisibleQuantity = this.totalVisibleQuantity.add(order.visibleQuantity);
  }

  removeOrder(orderId) {
    const index = this.orders.findIndex(o => o.id === orderId);
    if (index === -1) return null;
    
    const order = this.orders[index];
    this.orders.splice(index, 1);
    this.totalQuantity = this.totalQuantity.sub(order.remainingQuantity);
    this.totalVisibleQuantity = this.totalVisibleQuantity.sub(order.visibleQuantity);
    
    return order;
  }

  updateOrder(order) {
    const index = this.orders.findIndex(o => o.id === order.id);
    if (index === -1) return;
    
    const oldOrder = this.orders[index];
    this.totalQuantity = this.totalQuantity
      .sub(oldOrder.remainingQuantity)
      .add(order.remainingQuantity);
    this.totalVisibleQuantity = this.totalVisibleQuantity
      .sub(oldOrder.visibleQuantity)
      .add(order.visibleQuantity);
    
    this.orders[index] = order;
  }

  isEmpty() {
    return this.orders.length === 0;
  }

  getTopOrder() {
    return this.orders[0];
  }
}

class OrderBook {
  constructor(baseAsset, quoteAsset) {
    this.baseAsset = baseAsset;
    this.quoteAsset = quoteAsset;
    this.symbol = `${baseAsset}/${quoteAsset}`;
    
    // Buy orders sorted by price descending (highest first)
    this.buyOrders = new RBTree((a, b) => {
      const comp = b.price.sub(a.price);
      if (comp.gt(0)) return 1;
      if (comp.lt(0)) return -1;
      return 0;
    });
    
    // Sell orders sorted by price ascending (lowest first)
    this.sellOrders = new RBTree((a, b) => {
      const comp = a.price.sub(b.price);
      if (comp.gt(0)) return 1;
      if (comp.lt(0)) return -1;
      return 0;
    });
    
    // Order index for quick lookup
    this.orderIndex = new Map();
    
    // Stop orders waiting to be triggered
    this.stopOrders = new Map();
    
    // Market data
    this.lastPrice = null;
    this.lastQuantity = null;
    this.volume24h = ethers.BigNumber.from(0);
    this.high24h = null;
    this.low24h = null;
    this.trades = [];
  }

  addOrder(order) {
    // Validate order
    if (!this.validateOrder(order)) {
      order.status = OrderStatus.REJECTED;
      return { success: false, order };
    }
    
    // Check if it's a stop order
    if (order.type === OrderType.STOP || order.type === OrderType.STOP_LIMIT) {
      this.addStopOrder(order);
      return { success: true, order };
    }
    
    // Add to order book
    order.status = OrderStatus.OPEN;
    this.orderIndex.set(order.id, order);
    
    if (order.side === OrderSide.BUY) {
      this.addToPriceLevel(this.buyOrders, order);
    } else {
      this.addToPriceLevel(this.sellOrders, order);
    }
    
    return { success: true, order };
  }

  addToPriceLevel(tree, order) {
    let level = tree.find({ price: order.price });
    
    if (!level) {
      level = new PriceLevel(order.price);
      tree.insert(level);
    }
    
    level.addOrder(order);
  }

  removeOrder(orderId) {
    const order = this.orderIndex.get(orderId);
    if (!order) return null;
    
    this.orderIndex.delete(orderId);
    
    const tree = order.side === OrderSide.BUY ? this.buyOrders : this.sellOrders;
    const level = tree.find({ price: order.price });
    
    if (level) {
      level.removeOrder(orderId);
      if (level.isEmpty()) {
        tree.remove(level);
      }
    }
    
    return order;
  }

  addStopOrder(order) {
    const key = order.stopPrice.toString();
    if (!this.stopOrders.has(key)) {
      this.stopOrders.set(key, []);
    }
    this.stopOrders.get(key).push(order);
    this.orderIndex.set(order.id, order);
  }

  checkStopOrders(currentPrice) {
    const triggered = [];
    
    for (const [priceStr, orders] of this.stopOrders) {
      const stopPrice = ethers.BigNumber.from(priceStr);
      
      for (const order of orders) {
        let shouldTrigger = false;
        
        if (order.side === OrderSide.BUY && currentPrice.gte(stopPrice)) {
          shouldTrigger = true;
        } else if (order.side === OrderSide.SELL && currentPrice.lte(stopPrice)) {
          shouldTrigger = true;
        }
        
        if (shouldTrigger) {
          triggered.push(order);
          
          // Convert to market or limit order
          if (order.type === OrderType.STOP) {
            order.type = OrderType.MARKET;
            order.price = null;
          } else if (order.type === OrderType.STOP_LIMIT) {
            order.type = OrderType.LIMIT;
          }
        }
      }
    }
    
    // Remove triggered orders from stop orders
    for (const order of triggered) {
      const key = order.stopPrice.toString();
      const orders = this.stopOrders.get(key);
      const index = orders.findIndex(o => o.id === order.id);
      if (index !== -1) {
        orders.splice(index, 1);
        if (orders.length === 0) {
          this.stopOrders.delete(key);
        }
      }
    }
    
    return triggered;
  }

  validateOrder(order) {
    // Basic validation
    if (!order.userId || !order.side || !order.quantity) {
      return false;
    }
    
    // Price validation for limit orders
    if (order.type === OrderType.LIMIT && (!order.price || order.price.lte(0))) {
      return false;
    }
    
    // Quantity validation
    if (order.quantity.lte(0)) {
      return false;
    }
    
    // Post-only validation
    if (order.postOnly && order.type !== OrderType.LIMIT) {
      return false;
    }
    
    return true;
  }

  getBestBid() {
    const level = this.buyOrders.max();
    return level ? level.price : null;
  }

  getBestAsk() {
    const level = this.sellOrders.min();
    return level ? level.price : null;
  }

  getSpread() {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    
    if (!bestBid || !bestAsk) return null;
    
    return {
      absolute: bestAsk.sub(bestBid),
      percentage: bestAsk.sub(bestBid).mul(10000).div(bestAsk).toNumber() / 100
    };
  }

  getDepth(levels = 10) {
    const depth = {
      bids: [],
      asks: []
    };
    
    // Get bid depth
    let count = 0;
    this.buyOrders.each(level => {
      if (count >= levels) return false;
      
      depth.bids.push({
        price: level.price.toString(),
        quantity: level.totalVisibleQuantity.toString(),
        orders: level.orders.length
      });
      
      count++;
    });
    
    // Get ask depth
    count = 0;
    this.sellOrders.each(level => {
      if (count >= levels) return false;
      
      depth.asks.push({
        price: level.price.toString(),
        quantity: level.totalVisibleQuantity.toString(),
        orders: level.orders.length
      });
      
      count++;
    });
    
    return depth;
  }

  getTrades(limit = 100) {
    return this.trades.slice(-limit);
  }

  addTrade(trade) {
    this.trades.push(trade);
    
    // Update market data
    this.lastPrice = trade.price;
    this.lastQuantity = trade.quantity;
    this.volume24h = this.volume24h.add(trade.quantity);
    
    if (!this.high24h || trade.price.gt(this.high24h)) {
      this.high24h = trade.price;
    }
    
    if (!this.low24h || trade.price.lt(this.low24h)) {
      this.low24h = trade.price;
    }
    
    // Keep only last 10000 trades
    if (this.trades.length > 10000) {
      this.trades.shift();
    }
    
    // Clean up 24h volume
    const cutoff = Date.now() - 86400000;
    const recentTrades = this.trades.filter(t => t.timestamp > cutoff);
    
    if (recentTrades.length < this.trades.length) {
      this.volume24h = recentTrades.reduce(
        (sum, t) => sum.add(t.quantity),
        ethers.BigNumber.from(0)
      );
      
      // Recalculate 24h high/low
      this.high24h = recentTrades.reduce((high, t) => 
        !high || t.price.gt(high) ? t.price : high, null
      );
      
      this.low24h = recentTrades.reduce((low, t) => 
        !low || t.price.lt(low) ? t.price : low, null
      );
    }
  }

  getMarketData() {
    return {
      symbol: this.symbol,
      lastPrice: this.lastPrice?.toString(),
      lastQuantity: this.lastQuantity?.toString(),
      bestBid: this.getBestBid()?.toString(),
      bestAsk: this.getBestAsk()?.toString(),
      spread: this.getSpread(),
      volume24h: this.volume24h.toString(),
      high24h: this.high24h?.toString(),
      low24h: this.low24h?.toString(),
      openOrders: this.orderIndex.size,
      trades24h: this.trades.filter(t => 
        t.timestamp > Date.now() - 86400000
      ).length
    };
  }
}

class MatchingEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      feeRate: options.feeRate || '0.001', // 0.1%
      makerFeeRate: options.makerFeeRate || '0.0008', // 0.08%
      takerFeeRate: options.takerFeeRate || '0.0012', // 0.12%
      minOrderSize: options.minOrderSize || '0.00001',
      maxOrderSize: options.maxOrderSize || '1000000',
      tickSize: options.tickSize || '0.01',
      enableMarketMaking: options.enableMarketMaking || false,
      fairOrderingWindow: options.fairOrderingWindow || 100, // ms
      ...options
    };
    
    this.orderBooks = new Map();
    this.pendingOrders = [];
    this.executionQueue = [];
    this.lastExecutionTime = Date.now();
    
    this.stats = {
      totalOrders: 0,
      matchedOrders: 0,
      totalVolume: '0',
      totalFees: '0',
      averageExecutionTime: 0
    };
    
    this.startMatchingLoop();
  }

  createOrderBook(baseAsset, quoteAsset) {
    const symbol = `${baseAsset}/${quoteAsset}`;
    
    if (this.orderBooks.has(symbol)) {
      throw new Error(`Order book already exists for ${symbol}`);
    }
    
    const orderBook = new OrderBook(baseAsset, quoteAsset);
    this.orderBooks.set(symbol, orderBook);
    
    logger.info(`Created order book for ${symbol}`);
    
    return orderBook;
  }

  submitOrder(orderParams) {
    const order = new Order(orderParams);
    
    // Apply fair ordering
    const submissionTime = Date.now();
    const fairOrderingSlot = Math.floor(submissionTime / this.config.fairOrderingWindow);
    
    this.pendingOrders.push({
      order,
      submissionTime,
      fairOrderingSlot
    });
    
    this.stats.totalOrders++;
    
    return order.id;
  }

  startMatchingLoop() {
    this.matchingInterval = setInterval(() => {
      this.processPendingOrders();
      this.executeMatches();
    }, 10); // 10ms interval for low latency
  }

  processPendingOrders() {
    const now = Date.now();
    const currentSlot = Math.floor(now / this.config.fairOrderingWindow);
    
    // Group orders by fair ordering slot
    const ordersToProcess = this.pendingOrders.filter(
      p => p.fairOrderingSlot < currentSlot
    );
    
    if (ordersToProcess.length === 0) return;
    
    // Randomize order within same slot for fairness
    const shuffled = this.shuffleArray(ordersToProcess);
    
    for (const { order } of shuffled) {
      const symbol = `${order.baseAsset}/${order.quoteAsset}`;
      const orderBook = this.orderBooks.get(symbol);
      
      if (!orderBook) {
        order.status = OrderStatus.REJECTED;
        this.emit('order:rejected', order);
        continue;
      }
      
      // Add to execution queue
      this.executionQueue.push({ order, orderBook });
    }
    
    // Remove processed orders from pending
    this.pendingOrders = this.pendingOrders.filter(
      p => p.fairOrderingSlot >= currentSlot
    );
  }

  executeMatches() {
    const startTime = Date.now();
    
    while (this.executionQueue.length > 0) {
      const { order, orderBook } = this.executionQueue.shift();
      
      try {
        this.matchOrder(order, orderBook);
      } catch (error) {
        logger.error('Order matching error:', error);
        order.status = OrderStatus.REJECTED;
        this.emit('order:rejected', order);
      }
    }
    
    const executionTime = Date.now() - startTime;
    if (executionTime > 0) {
      this.updateExecutionStats(executionTime);
    }
  }

  matchOrder(order, orderBook) {
    // Check triggered stop orders
    if (orderBook.lastPrice) {
      const triggeredStops = orderBook.checkStopOrders(orderBook.lastPrice);
      for (const stopOrder of triggeredStops) {
        this.executionQueue.push({ order: stopOrder, orderBook });
      }
    }
    
    // Handle different order types
    switch (order.type) {
      case OrderType.MARKET:
        this.matchMarketOrder(order, orderBook);
        break;
        
      case OrderType.LIMIT:
        this.matchLimitOrder(order, orderBook);
        break;
        
      case OrderType.FILL_OR_KILL:
        this.matchFillOrKill(order, orderBook);
        break;
        
      case OrderType.IMMEDIATE_OR_CANCEL:
        this.matchImmediateOrCancel(order, orderBook);
        break;
        
      default:
        orderBook.addOrder(order);
    }
    
    this.emit('order:processed', order);
  }

  matchMarketOrder(order, orderBook) {
    const oppositeTree = order.side === OrderSide.BUY ? 
      orderBook.sellOrders : orderBook.buyOrders;
    
    while (!order.isFilled && oppositeTree.size > 0) {
      const bestLevel = order.side === OrderSide.BUY ? 
        oppositeTree.min() : oppositeTree.max();
      
      if (!bestLevel) break;
      
      const matchedQuantity = this.matchAtPriceLevel(
        order,
        bestLevel,
        orderBook,
        true // isTaker
      );
      
      if (matchedQuantity.eq(0)) break;
    }
    
    // Cancel remaining quantity for market orders
    if (!order.isFilled) {
      order.status = OrderStatus.CANCELLED;
      this.emit('order:cancelled', order);
    }
  }

  matchLimitOrder(order, orderBook) {
    const oppositeTree = order.side === OrderSide.BUY ? 
      orderBook.sellOrders : orderBook.buyOrders;
    
    // Try to match with existing orders
    while (!order.isFilled && oppositeTree.size > 0) {
      const bestLevel = order.side === OrderSide.BUY ? 
        oppositeTree.min() : oppositeTree.max();
      
      if (!bestLevel) break;
      
      // Check if price crosses
      const crosses = order.side === OrderSide.BUY ?
        order.price.gte(bestLevel.price) :
        order.price.lte(bestLevel.price);
      
      if (!crosses) break;
      
      // Post-only check
      if (order.postOnly) {
        order.status = OrderStatus.CANCELLED;
        this.emit('order:cancelled', order);
        return;
      }
      
      const matchedQuantity = this.matchAtPriceLevel(
        order,
        bestLevel,
        orderBook,
        true // isTaker
      );
      
      if (matchedQuantity.eq(0)) break;
    }
    
    // Add remaining quantity to order book
    if (!order.isFilled && order.status !== OrderStatus.CANCELLED) {
      orderBook.addOrder(order);
      this.emit('order:placed', order);
    }
  }

  matchFillOrKill(order, orderBook) {
    // Check if entire order can be filled
    const fillableQuantity = this.calculateFillableQuantity(order, orderBook);
    
    if (fillableQuantity.lt(order.quantity)) {
      order.status = OrderStatus.CANCELLED;
      this.emit('order:cancelled', order);
      return;
    }
    
    // Execute as market order
    this.matchMarketOrder(order, orderBook);
  }

  matchImmediateOrCancel(order, orderBook) {
    // Try to fill as much as possible immediately
    this.matchMarketOrder(order, orderBook);
    
    // Cancel any remaining quantity
    if (!order.isFilled) {
      order.status = OrderStatus.CANCELLED;
    }
  }

  matchAtPriceLevel(takerOrder, makerLevel, orderBook, isTaker) {
    let matchedQuantity = ethers.BigNumber.from(0);
    const executedTrades = [];
    
    while (!takerOrder.isFilled && makerLevel.orders.length > 0) {
      const makerOrder = makerLevel.getTopOrder();
      
      // Calculate match quantity
      const matchQty = takerOrder.remainingQuantity.lt(makerOrder.visibleQuantity) ?
        takerOrder.remainingQuantity : makerOrder.visibleQuantity;
      
      // Calculate fees
      const takerFee = this.calculateFee(matchQty, makerLevel.price, true);
      const makerFee = this.calculateFee(matchQty, makerLevel.price, false);
      
      // Update orders
      takerOrder.addFill(makerLevel.price, matchQty, takerFee);
      makerOrder.addFill(makerLevel.price, matchQty, makerFee);
      
      // Create trade record
      const trade = {
        id: crypto.randomBytes(16).toString('hex'),
        price: makerLevel.price,
        quantity: matchQty,
        takerOrderId: takerOrder.id,
        makerOrderId: makerOrder.id,
        takerSide: takerOrder.side,
        timestamp: Date.now()
      };
      
      executedTrades.push(trade);
      orderBook.addTrade(trade);
      
      // Update statistics
      matchedQuantity = matchedQuantity.add(matchQty);
      this.stats.matchedOrders++;
      this.stats.totalVolume = ethers.BigNumber.from(this.stats.totalVolume)
        .add(matchQty.mul(makerLevel.price))
        .toString();
      this.stats.totalFees = ethers.BigNumber.from(this.stats.totalFees)
        .add(takerFee)
        .add(makerFee)
        .toString();
      
      // Update maker order in level
      if (makerOrder.isFilled) {
        makerLevel.removeOrder(makerOrder.id);
        orderBook.orderIndex.delete(makerOrder.id);
        this.emit('order:filled', makerOrder);
      } else {
        makerLevel.updateOrder(makerOrder);
      }
      
      // Remove empty level
      if (makerLevel.isEmpty()) {
        const tree = makerOrder.side === OrderSide.BUY ? 
          orderBook.buyOrders : orderBook.sellOrders;
        tree.remove(makerLevel);
      }
    }
    
    // Emit trade events
    for (const trade of executedTrades) {
      this.emit('trade:executed', trade);
    }
    
    // Emit order filled event
    if (takerOrder.isFilled) {
      this.emit('order:filled', takerOrder);
    }
    
    return matchedQuantity;
  }

  calculateFillableQuantity(order, orderBook) {
    const oppositeTree = order.side === OrderSide.BUY ? 
      orderBook.sellOrders : orderBook.buyOrders;
    
    let totalQuantity = ethers.BigNumber.from(0);
    
    oppositeTree.each(level => {
      const crosses = order.side === OrderSide.BUY ?
        order.price.gte(level.price) :
        order.price.lte(level.price);
      
      if (!crosses) return false; // Stop iterating
      
      totalQuantity = totalQuantity.add(level.totalVisibleQuantity);
      
      if (totalQuantity.gte(order.quantity)) {
        return false; // Stop iterating
      }
    });
    
    return totalQuantity;
  }

  calculateFee(quantity, price, isTaker) {
    const notional = quantity.mul(price);
    const feeRate = isTaker ? 
      this.config.takerFeeRate : this.config.makerFeeRate;
    
    return notional.mul(Math.floor(parseFloat(feeRate) * 10000)).div(10000);
  }

  shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  updateExecutionStats(executionTime) {
    const count = this.stats.matchedOrders;
    const currentAvg = this.stats.averageExecutionTime;
    
    this.stats.averageExecutionTime = 
      (currentAvg * (count - 1) + executionTime) / count;
  }

  // Market making functions
  async enableMarketMaking(symbol, params) {
    if (!this.config.enableMarketMaking) {
      throw new Error('Market making not enabled');
    }
    
    const orderBook = this.orderBooks.get(symbol);
    if (!orderBook) {
      throw new Error(`Order book not found for ${symbol}`);
    }
    
    const marketMaker = new MarketMaker(this, orderBook, params);
    await marketMaker.start();
    
    return marketMaker;
  }

  getOrderBook(symbol) {
    return this.orderBooks.get(symbol);
  }

  getOrder(orderId) {
    for (const orderBook of this.orderBooks.values()) {
      const order = orderBook.orderIndex.get(orderId);
      if (order) return order;
    }
    return null;
  }

  cancelOrder(orderId) {
    for (const orderBook of this.orderBooks.values()) {
      const order = orderBook.removeOrder(orderId);
      if (order) {
        order.status = OrderStatus.CANCELLED;
        this.emit('order:cancelled', order);
        return order;
      }
    }
    return null;
  }

  getStatistics() {
    const orderBookStats = {};
    
    for (const [symbol, orderBook] of this.orderBooks) {
      orderBookStats[symbol] = orderBook.getMarketData();
    }
    
    return {
      engine: this.stats,
      orderBooks: orderBookStats,
      pendingOrders: this.pendingOrders.length,
      executionQueueSize: this.executionQueue.length
    };
  }

  stop() {
    if (this.matchingInterval) {
      clearInterval(this.matchingInterval);
    }
    this.removeAllListeners();
    logger.info('Matching engine stopped');
  }
}

class MarketMaker {
  constructor(engine, orderBook, params) {
    this.engine = engine;
    this.orderBook = orderBook;
    this.params = {
      spread: params.spread || '0.002', // 0.2%
      depth: params.depth || 5,
      orderSize: params.orderSize || '1',
      updateInterval: params.updateInterval || 1000,
      inventoryLimit: params.inventoryLimit || '100',
      ...params
    };
    
    this.activeOrders = new Map();
    this.inventory = ethers.BigNumber.from(0);
    this.running = false;
  }

  async start() {
    this.running = true;
    this.updateInterval = setInterval(() => {
      this.updateQuotes();
    }, this.params.updateInterval);
    
    // Initial quote
    await this.updateQuotes();
  }

  async updateQuotes() {
    if (!this.running) return;
    
    // Cancel existing orders
    for (const orderId of this.activeOrders.keys()) {
      this.engine.cancelOrder(orderId);
    }
    this.activeOrders.clear();
    
    // Calculate mid price
    const bestBid = this.orderBook.getBestBid();
    const bestAsk = this.orderBook.getBestAsk();
    
    let midPrice;
    if (bestBid && bestAsk) {
      midPrice = bestBid.add(bestAsk).div(2);
    } else if (this.orderBook.lastPrice) {
      midPrice = this.orderBook.lastPrice;
    } else {
      return; // No reference price
    }
    
    // Place orders on both sides
    const spreadBps = Math.floor(parseFloat(this.params.spread) * 10000);
    
    for (let i = 0; i < this.params.depth; i++) {
      const level = i + 1;
      
      // Buy order
      const buyPrice = midPrice.mul(10000 - spreadBps * level).div(10000);
      const buyOrderId = this.engine.submitOrder({
        userId: 'market-maker',
        baseAsset: this.orderBook.baseAsset,
        quoteAsset: this.orderBook.quoteAsset,
        type: OrderType.LIMIT,
        side: OrderSide.BUY,
        price: buyPrice.toString(),
        quantity: this.params.orderSize,
        postOnly: true
      });
      
      this.activeOrders.set(buyOrderId, { side: OrderSide.BUY, level });
      
      // Sell order
      const sellPrice = midPrice.mul(10000 + spreadBps * level).div(10000);
      const sellOrderId = this.engine.submitOrder({
        userId: 'market-maker',
        baseAsset: this.orderBook.baseAsset,
        quoteAsset: this.orderBook.quoteAsset,
        type: OrderType.LIMIT,
        side: OrderSide.SELL,
        price: sellPrice.toString(),
        quantity: this.params.orderSize,
        postOnly: true
      });
      
      this.activeOrders.set(sellOrderId, { side: OrderSide.SELL, level });
    }
  }

  stop() {
    this.running = false;
    
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    // Cancel all orders
    for (const orderId of this.activeOrders.keys()) {
      this.engine.cancelOrder(orderId);
    }
    
    this.activeOrders.clear();
  }
}

module.exports = {
  AdvancedOrderBook: MatchingEngine,
  Order,
  OrderBook,
  OrderType,
  OrderSide,
  OrderStatus,
  TimeInForce,
  MarketMaker
};