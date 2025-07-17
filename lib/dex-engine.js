/**
 * DEX Engine for Otedama
 * High-performance decentralized exchange with atomic swaps and advanced features
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { AMMOptimizer } from './dex/amm/optimizer.js';
import { Logger } from './logger.js';

// Supported token pairs
export const TRADING_PAIRS = [
  { base: 'BTC', quote: 'USDT' },
  { base: 'ETH', quote: 'USDT' },
  { base: 'ETH', quote: 'BTC' },
  { base: 'XMR', quote: 'BTC' },
  { base: 'RVN', quote: 'BTC' },
  { base: 'LTC', quote: 'BTC' },
  { base: 'DOGE', quote: 'USDT' },
  { base: 'DASH', quote: 'BTC' },
  { base: 'ZEC', quote: 'BTC' },
  { base: 'BCH', quote: 'BTC' },
  { base: 'ETC', quote: 'ETH' },
  { base: 'XRP', quote: 'USDT' },
  { base: 'ADA', quote: 'USDT' },
  { base: 'DOT', quote: 'USDT' },
  { base: 'SOL', quote: 'USDT' }
];

// Order types
export const OrderType = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP: 'stop',
  STOP_LIMIT: 'stop_limit'
};

// Order status
export const OrderStatus = {
  PENDING: 'pending',
  OPEN: 'open',
  PARTIAL: 'partial',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

export class DEXEngine extends EventEmitter {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.logger = options.logger || new Logger('DEXEngine');
    this.options = {
      minOrderSize: options.minOrderSize || 0.00001,
      makerFee: options.makerFee || 0.001, // 0.1%
      takerFee: options.takerFee || 0.002, // 0.2%
      maxSlippage: options.maxSlippage || 0.03, // 3%
      orderExpiry: options.orderExpiry || 86400000, // 24 hours
      enableAMM: options.enableAMM !== false,
      enableAtomicSwaps: options.enableAtomicSwaps !== false,
      ...options
    };
    
    // Order books for each pair
    this.orderBooks = new Map();
    this.orders = new Map();
    this.trades = new Map();
    
    // AMM integration
    if (this.options.enableAMM) {
      this.ammOptimizer = new AMMOptimizer({
        enableConcentratedLiquidity: true,
        enableDynamicFees: true,
        enableMEVProtection: true,
        logger: this.logger
      });
    }
    
    // Market data
    this.marketData = new Map();
    this.priceHistory = new Map();
    
    // Performance tracking
    this.metrics = {
      totalOrders: 0,
      totalTrades: 0,
      totalVolume: 0,
      avgExecutionTime: 0,
      orderBookDepth: 0,
      activeOrders: 0
    };
    
    this.initialize();
  }
  
  initialize() {
    // Initialize order books for all trading pairs
    for (const pair of TRADING_PAIRS) {
      const pairId = this.getPairId(pair.base, pair.quote);
      this.orderBooks.set(pairId, {
        bids: [], // Buy orders (sorted high to low)
        asks: [], // Sell orders (sorted low to high)
        lastPrice: 0,
        lastUpdate: Date.now()
      });
      
      this.marketData.set(pairId, {
        price: 0,
        volume24h: 0,
        high24h: 0,
        low24h: 0,
        change24h: 0,
        trades24h: 0
      });
      
      this.priceHistory.set(pairId, []);
    }
    
    // Initialize database tables
    this.initializeDatabase();
    
    // Start background processes
    this.startOrderMatching();
    this.startMarketDataUpdate();
    this.startOrderCleanup();
    
    // Setup AMM pools if enabled
    if (this.options.enableAMM) {
      this.initializeAMMPools();
    }
    
    this.logger.info('DEX Engine initialized');
    this.emit('initialized');
  }
  
  initializeDatabase() {
    // Orders table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dex_orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        pair TEXT NOT NULL,
        type TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL,
        amount REAL NOT NULL,
        filled REAL DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        expires_at INTEGER
      )
    `);
    
    // Trades table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dex_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pair TEXT NOT NULL,
        maker_order_id TEXT,
        taker_order_id TEXT,
        price REAL NOT NULL,
        amount REAL NOT NULL,
        maker_fee REAL,
        taker_fee REAL,
        timestamp INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON dex_orders(pair, status);
      CREATE INDEX IF NOT EXISTS idx_orders_user ON dex_orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_trades_pair ON dex_trades(pair);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON dex_trades(timestamp);
    `);
  }
  
  async initializeAMMPools() {
    // Create AMM pools for major pairs
    const majorPairs = [
      { token0: 'BTC', token1: 'USDT', fee: 30 },
      { token0: 'ETH', token1: 'USDT', fee: 30 },
      { token0: 'ETH', token1: 'BTC', fee: 50 }
    ];
    
    for (const pair of majorPairs) {
      try {
        await this.ammOptimizer.createPool(pair.token0, pair.token1, {
          baseFee: pair.fee,
          sqrtPriceX96: this.calculateInitialSqrtPrice(pair.token0, pair.token1)
        });
        
        this.logger.info(`Created AMM pool: ${pair.token0}/${pair.token1}`);
      } catch (error) {
        this.logger.error(`Failed to create AMM pool: ${error.message}`);
      }
    }
  }
  
  // Order management
  async createOrder(order) {
    // Validate order
    this.validateOrder(order);
    
    // Generate order ID
    const orderId = this.generateOrderId();
    
    // Create order object
    const fullOrder = {
      id: orderId,
      ...order,
      filled: 0,
      status: OrderStatus.PENDING,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.options.orderExpiry
    };
    
    // Store order
    this.orders.set(orderId, fullOrder);
    
    // Save to database
    const stmt = this.db.prepare(`
      INSERT INTO dex_orders (id, user_id, pair, type, side, price, amount, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      orderId,
      order.userId,
      order.pair,
      order.type,
      order.side,
      order.price || null,
      order.amount,
      fullOrder.expiresAt
    );
    
    this.metrics.totalOrders++;
    this.metrics.activeOrders++;
    
    // Add to order book if limit order
    if (order.type === OrderType.LIMIT) {
      this.addToOrderBook(fullOrder);
    }
    
    // Attempt immediate execution
    await this.matchOrder(fullOrder);
    
    this.emit('order:created', fullOrder);
    
    return fullOrder;
  }
  
  async cancelOrder(orderId, userId) {
    const order = this.orders.get(orderId);
    
    if (!order) {
      throw new Error('Order not found');
    }
    
    if (order.userId !== userId) {
      throw new Error('Unauthorized');
    }
    
    if (order.status === OrderStatus.FILLED) {
      throw new Error('Cannot cancel filled order');
    }
    
    // Update order status
    order.status = OrderStatus.CANCELLED;
    order.updatedAt = Date.now();
    
    // Remove from order book
    this.removeFromOrderBook(order);
    
    // Update database
    const stmt = this.db.prepare(`
      UPDATE dex_orders 
      SET status = ?, updated_at = ?
      WHERE id = ?
    `);
    
    stmt.run(OrderStatus.CANCELLED, order.updatedAt, orderId);
    
    this.metrics.activeOrders--;
    
    this.emit('order:cancelled', order);
    
    return order;
  }
  
  // Order matching engine
  async matchOrder(order) {
    if (order.type === OrderType.MARKET) {
      await this.executeMarketOrder(order);
    } else if (order.type === OrderType.LIMIT) {
      await this.executeLimitOrder(order);
    }
  }
  
  async executeMarketOrder(order) {
    const orderBook = this.orderBooks.get(order.pair);
    if (!orderBook) return;
    
    const orders = order.side === 'buy' ? orderBook.asks : orderBook.bids;
    let remainingAmount = order.amount;
    const trades = [];
    
    for (const matchOrder of orders) {
      if (remainingAmount <= 0) break;
      
      const tradeAmount = Math.min(remainingAmount, matchOrder.amount - matchOrder.filled);
      const tradePrice = matchOrder.price;
      
      // Check slippage
      if (orderBook.lastPrice > 0) {
        const slippage = Math.abs(tradePrice - orderBook.lastPrice) / orderBook.lastPrice;
        if (slippage > this.options.maxSlippage) {
          break;
        }
      }
      
      // Execute trade
      const trade = await this.executeTrade(order, matchOrder, tradePrice, tradeAmount);
      trades.push(trade);
      
      remainingAmount -= tradeAmount;
    }
    
    // Update order status
    if (remainingAmount === 0) {
      order.status = OrderStatus.FILLED;
    } else if (remainingAmount < order.amount) {
      order.status = OrderStatus.PARTIAL;
    }
    
    return trades;
  }
  
  async executeLimitOrder(order) {
    const orderBook = this.orderBooks.get(order.pair);
    if (!orderBook) return;
    
    const orders = order.side === 'buy' ? orderBook.asks : orderBook.bids;
    const trades = [];
    let remainingAmount = order.amount;
    
    for (const matchOrder of orders) {
      if (remainingAmount <= 0) break;
      
      // Check price compatibility
      const canMatch = order.side === 'buy' 
        ? order.price >= matchOrder.price
        : order.price <= matchOrder.price;
      
      if (!canMatch) break;
      
      const tradeAmount = Math.min(remainingAmount, matchOrder.amount - matchOrder.filled);
      const tradePrice = matchOrder.price;
      
      // Execute trade
      const trade = await this.executeTrade(order, matchOrder, tradePrice, tradeAmount);
      trades.push(trade);
      
      remainingAmount -= tradeAmount;
    }
    
    // Update order
    order.filled = order.amount - remainingAmount;
    
    if (remainingAmount === 0) {
      order.status = OrderStatus.FILLED;
    } else if (remainingAmount < order.amount) {
      order.status = OrderStatus.PARTIAL;
    } else {
      order.status = OrderStatus.OPEN;
    }
    
    return trades;
  }
  
  async executeTrade(takerOrder, makerOrder, price, amount) {
    const trade = {
      id: this.generateTradeId(),
      pair: takerOrder.pair,
      price,
      amount,
      makerOrderId: makerOrder.id,
      takerOrderId: takerOrder.id,
      makerFee: amount * price * this.options.makerFee,
      takerFee: amount * price * this.options.takerFee,
      timestamp: Date.now()
    };
    
    // Update orders
    makerOrder.filled += amount;
    takerOrder.filled += amount;
    
    if (makerOrder.filled >= makerOrder.amount) {
      makerOrder.status = OrderStatus.FILLED;
      this.removeFromOrderBook(makerOrder);
    }
    
    // Save trade
    const stmt = this.db.prepare(`
      INSERT INTO dex_trades (pair, maker_order_id, taker_order_id, price, amount, maker_fee, taker_fee)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      trade.pair,
      trade.makerOrderId,
      trade.takerOrderId,
      trade.price,
      trade.amount,
      trade.makerFee,
      trade.takerFee
    );
    
    // Update market data
    this.updateMarketData(trade);
    
    // Update metrics
    this.metrics.totalTrades++;
    this.metrics.totalVolume += amount * price;
    
    this.emit('trade:executed', trade);
    
    return trade;
  }
  
  // Order book management
  addToOrderBook(order) {
    const orderBook = this.orderBooks.get(order.pair);
    if (!orderBook) return;
    
    const list = order.side === 'buy' ? orderBook.bids : orderBook.asks;
    
    // Insert in sorted position
    const index = this.findInsertIndex(list, order);
    list.splice(index, 0, order);
    
    orderBook.lastUpdate = Date.now();
    this.metrics.orderBookDepth = this.calculateOrderBookDepth();
    
    this.emit('orderbook:updated', { pair: order.pair, orderBook });
  }
  
  removeFromOrderBook(order) {
    const orderBook = this.orderBooks.get(order.pair);
    if (!orderBook) return;
    
    const list = order.side === 'buy' ? orderBook.bids : orderBook.asks;
    const index = list.findIndex(o => o.id === order.id);
    
    if (index !== -1) {
      list.splice(index, 1);
      orderBook.lastUpdate = Date.now();
      this.metrics.orderBookDepth = this.calculateOrderBookDepth();
      
      this.emit('orderbook:updated', { pair: order.pair, orderBook });
    }
  }
  
  findInsertIndex(orders, newOrder) {
    if (newOrder.side === 'buy') {
      // Bids sorted high to low
      return orders.findIndex(o => o.price < newOrder.price);
    } else {
      // Asks sorted low to high
      return orders.findIndex(o => o.price > newOrder.price);
    }
  }
  
  // Market data
  updateMarketData(trade) {
    const marketData = this.marketData.get(trade.pair);
    if (!marketData) return;
    
    const orderBook = this.orderBooks.get(trade.pair);
    
    // Update last price
    orderBook.lastPrice = trade.price;
    marketData.price = trade.price;
    
    // Update 24h volume
    marketData.volume24h += trade.amount * trade.price;
    marketData.trades24h++;
    
    // Update price history
    const history = this.priceHistory.get(trade.pair);
    history.push({
      price: trade.price,
      volume: trade.amount,
      timestamp: trade.timestamp
    });
    
    // Keep only last 24h
    const cutoff = Date.now() - 86400000;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }
    
    // Calculate 24h high/low
    if (history.length > 0) {
      marketData.high24h = Math.max(...history.map(h => h.price));
      marketData.low24h = Math.min(...history.map(h => h.price));
      marketData.change24h = history.length > 1 
        ? ((trade.price - history[0].price) / history[0].price) * 100
        : 0;
    }
    
    this.emit('market:updated', { pair: trade.pair, data: marketData });
  }
  
  // AMM integration
  async swapWithAMM(params) {
    if (!this.options.enableAMM) {
      throw new Error('AMM not enabled');
    }
    
    try {
      const result = await this.ammOptimizer.swap({
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        amountOut: params.amountOut,
        recipient: params.recipient,
        deadline: params.deadline || Date.now() + 300000, // 5 minutes
        userSecret: params.userSecret
      });
      
      // Record trade in DEX
      if (result.success) {
        const trade = {
          pair: this.getPairId(params.tokenIn, params.tokenOut),
          price: Number(result.amountOut) / Number(result.amountIn),
          amount: Number(result.amountIn),
          timestamp: Date.now()
        };
        
        this.updateMarketData(trade);
      }
      
      return result;
    } catch (error) {
      this.logger.error('AMM swap failed:', error);
      throw error;
    }
  }
  
  // Background processes
  startOrderMatching() {
    setInterval(() => {
      // Process pending orders
      for (const [orderId, order] of this.orders) {
        if (order.status === OrderStatus.OPEN || order.status === OrderStatus.PARTIAL) {
          this.matchOrder(order).catch(error => {
            this.logger.error(`Order matching error: ${error.message}`);
          });
        }
      }
    }, 1000); // Every second
  }
  
  startMarketDataUpdate() {
    setInterval(() => {
      // Update market statistics
      const now = Date.now();
      const cutoff = now - 86400000;
      
      for (const [pair, data] of this.marketData) {
        // Recalculate 24h volume from trades
        const trades = this.db.prepare(`
          SELECT SUM(amount * price) as volume, COUNT(*) as count
          FROM dex_trades
          WHERE pair = ? AND timestamp > ?
        `).get(pair, cutoff / 1000);
        
        if (trades) {
          data.volume24h = trades.volume || 0;
          data.trades24h = trades.count || 0;
        }
      }
    }, 60000); // Every minute
  }
  
  startOrderCleanup() {
    setInterval(() => {
      const now = Date.now();
      
      // Clean expired orders
      for (const [orderId, order] of this.orders) {
        if (order.expiresAt < now && order.status === OrderStatus.OPEN) {
          order.status = OrderStatus.EXPIRED;
          this.removeFromOrderBook(order);
          
          // Update database
          const stmt = this.db.prepare(`
            UPDATE dex_orders SET status = ? WHERE id = ?
          `);
          stmt.run(OrderStatus.EXPIRED, orderId);
          
          this.orders.delete(orderId);
          this.metrics.activeOrders--;
        }
      }
    }, 300000); // Every 5 minutes
  }
  
  // Utility methods
  validateOrder(order) {
    if (!order.userId || !order.pair || !order.type || !order.side || !order.amount) {
      throw new Error('Missing required order fields');
    }
    
    if (order.amount < this.options.minOrderSize) {
      throw new Error(`Minimum order size is ${this.options.minOrderSize}`);
    }
    
    if (order.type === OrderType.LIMIT && !order.price) {
      throw new Error('Limit orders require a price');
    }
    
    if (!['buy', 'sell'].includes(order.side)) {
      throw new Error('Invalid order side');
    }
    
    const validPair = TRADING_PAIRS.some(p => 
      this.getPairId(p.base, p.quote) === order.pair
    );
    
    if (!validPair) {
      throw new Error('Invalid trading pair');
    }
  }
  
  getPairId(base, quote) {
    return `${base}/${quote}`;
  }
  
  generateOrderId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }
  
  generateTradeId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  }
  
  calculateInitialSqrtPrice(token0, token1) {
    // Mock initial prices
    const prices = {
      'BTC/USDT': 60000,
      'ETH/USDT': 3000,
      'ETH/BTC': 0.05
    };
    
    const pair = `${token0}/${token1}`;
    const price = prices[pair] || 1;
    
    // Convert to sqrtPriceX96 format
    return BigInt(Math.floor(Math.sqrt(price) * Math.pow(2, 96)));
  }
  
  calculateOrderBookDepth() {
    let totalDepth = 0;
    
    for (const [pair, orderBook] of this.orderBooks) {
      totalDepth += orderBook.bids.length + orderBook.asks.length;
    }
    
    return totalDepth;
  }
  
  // Public API
  async getOrderBook(pair, depth = 20) {
    const orderBook = this.orderBooks.get(pair);
    if (!orderBook) {
      throw new Error('Invalid trading pair');
    }
    
    return {
      bids: orderBook.bids.slice(0, depth).map(o => ({
        price: o.price,
        amount: o.amount - o.filled
      })),
      asks: orderBook.asks.slice(0, depth).map(o => ({
        price: o.price,
        amount: o.amount - o.filled
      })),
      lastPrice: orderBook.lastPrice,
      lastUpdate: orderBook.lastUpdate
    };
  }
  
  async getMarketData(pair) {
    const data = this.marketData.get(pair);
    if (!data) {
      throw new Error('Invalid trading pair');
    }
    
    return { ...data };
  }
  
  async getUserOrders(userId, status = null) {
    let query = 'SELECT * FROM dex_orders WHERE user_id = ?';
    const params = [userId];
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC LIMIT 100';
    
    return this.db.prepare(query).all(...params);
  }
  
  async getTradeHistory(pair, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM dex_trades
      WHERE pair = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(pair, limit);
  }
  
  getMetrics() {
    return {
      ...this.metrics,
      ammMetrics: this.ammOptimizer?.getMetrics()
    };
  }
}