/**
 * Advanced DEX Features for Otedama
 * Implements cutting-edge DeFi functionality
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';

/**
 * Cross-DEX Aggregator
 * Finds best prices across multiple liquidity sources
 */
export class DEXAggregator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.liquiditySources = new Map();
    this.routeCache = new Map();
    this.options = {
      maxHops: options.maxHops || 3,
      minSavings: options.minSavings || 0.001, // 0.1%
      cacheExpiry: options.cacheExpiry || 60000, // 1 minute
      ...options
    };
  }
  
  /**
   * Find optimal trading route
   */
  async findBestRoute(tokenIn, tokenOut, amountIn) {
    const cacheKey = `${tokenIn}-${tokenOut}-${amountIn}`;
    const cached = this.routeCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.options.cacheExpiry) {
      return cached.route;
    }
    
    const routes = await this.calculateAllRoutes(tokenIn, tokenOut, amountIn);
    const bestRoute = this.selectBestRoute(routes);
    
    this.routeCache.set(cacheKey, {
      route: bestRoute,
      timestamp: Date.now()
    });
    
    return bestRoute;
  }
  
  /**
   * Calculate all possible routes
   */
  async calculateAllRoutes(tokenIn, tokenOut, amountIn, currentPath = [], depth = 0) {
    if (depth > this.options.maxHops) return [];
    
    const routes = [];
    
    // Direct route
    const directQuote = await this.getQuote(tokenIn, tokenOut, amountIn);
    if (directQuote) {
      routes.push({
        path: [tokenIn, tokenOut],
        amountOut: directQuote.amountOut,
        priceImpact: directQuote.priceImpact,
        fees: directQuote.fees
      });
    }
    
    // Multi-hop routes
    const intermediateTokens = this.getIntermediateTokens(tokenIn, tokenOut);
    
    for (const intermediate of intermediateTokens) {
      if (currentPath.includes(intermediate)) continue;
      
      const firstQuote = await this.getQuote(tokenIn, intermediate, amountIn);
      if (!firstQuote) continue;
      
      const secondRoutes = await this.calculateAllRoutes(
        intermediate,
        tokenOut,
        firstQuote.amountOut,
        [...currentPath, tokenIn],
        depth + 1
      );
      
      for (const route of secondRoutes) {
        routes.push({
          path: [tokenIn, ...route.path],
          amountOut: route.amountOut,
          priceImpact: firstQuote.priceImpact + route.priceImpact,
          fees: firstQuote.fees + route.fees
        });
      }
    }
    
    return routes;
  }
  
  /**
   * Select best route based on output amount and fees
   */
  selectBestRoute(routes) {
    if (routes.length === 0) return null;
    
    return routes.reduce((best, route) => {
      const routeValue = route.amountOut - route.fees;
      const bestValue = best.amountOut - best.fees;
      
      if (routeValue > bestValue) {
        return route;
      }
      
      // If values are close, prefer simpler route
      if (Math.abs(routeValue - bestValue) / bestValue < this.options.minSavings) {
        return route.path.length < best.path.length ? route : best;
      }
      
      return best;
    });
  }
  
  /**
   * Get intermediate tokens for routing
   */
  getIntermediateTokens(tokenIn, tokenOut) {
    // Common routing tokens
    const routingTokens = ['BTC', 'ETH', 'USDT', 'USDC'];
    
    return routingTokens.filter(token => 
      token !== tokenIn && token !== tokenOut
    );
  }
  
  /**
   * Get quote from liquidity source
   */
  async getQuote(tokenIn, tokenOut, amountIn) {
    const sources = Array.from(this.liquiditySources.values());
    const quotes = await Promise.all(
      sources.map(source => source.getQuote(tokenIn, tokenOut, amountIn))
    );
    
    return quotes
      .filter(quote => quote !== null)
      .reduce((best, quote) => 
        !best || quote.amountOut > best.amountOut ? quote : best
      , null);
  }
}

/**
 * Limit Order Book with advanced features
 */
export class LimitOrderBook {
  constructor(options = {}) {
    this.options = {
      tickSize: options.tickSize || 0.00001,
      maxOrdersPerLevel: options.maxOrdersPerLevel || 1000,
      enableIceberg: options.enableIceberg !== false,
      enableStop: options.enableStop !== false,
      ...options
    };
    
    this.bids = new Map(); // Price -> Orders
    this.asks = new Map(); // Price -> Orders
    this.orders = new Map(); // OrderId -> Order
    this.stopOrders = new Map(); // Price -> Stop Orders
  }
  
  /**
   * Add limit order
   */
  addOrder(order) {
    const { id, side, price, amount, type = 'limit' } = order;
    
    // Validate order
    if (!this.validateOrder(order)) {
      throw new Error('Invalid order');
    }
    
    // Round price to tick size
    const roundedPrice = Math.round(price / this.options.tickSize) * this.options.tickSize;
    
    const orderData = {
      id,
      side,
      price: roundedPrice,
      amount,
      remainingAmount: amount,
      type,
      timestamp: Date.now(),
      ...order
    };
    
    this.orders.set(id, orderData);
    
    // Add to appropriate book
    if (type === 'stop' || type === 'stop_limit') {
      this.addStopOrder(orderData);
    } else {
      this.addToBook(orderData);
    }
    
    return orderData;
  }
  
  /**
   * Add order to book
   */
  addToBook(order) {
    const book = order.side === 'buy' ? this.bids : this.asks;
    
    if (!book.has(order.price)) {
      book.set(order.price, []);
    }
    
    const level = book.get(order.price);
    
    if (level.length >= this.options.maxOrdersPerLevel) {
      throw new Error('Price level full');
    }
    
    level.push(order);
    
    // Sort bids descending, asks ascending
    if (order.side === 'buy') {
      this.sortBids();
    } else {
      this.sortAsks();
    }
  }
  
  /**
   * Match orders
   */
  matchOrders(incomingOrder) {
    const matches = [];
    const book = incomingOrder.side === 'buy' ? this.asks : this.bids;
    
    for (const [price, orders] of book) {
      // Check if price is acceptable
      if (incomingOrder.side === 'buy' && price > incomingOrder.price) break;
      if (incomingOrder.side === 'sell' && price < incomingOrder.price) break;
      
      for (let i = 0; i < orders.length && incomingOrder.remainingAmount > 0; i++) {
        const bookOrder = orders[i];
        
        if (bookOrder.remainingAmount === 0) continue;
        
        const matchAmount = Math.min(
          incomingOrder.remainingAmount,
          bookOrder.remainingAmount
        );
        
        matches.push({
          takerOrder: incomingOrder,
          makerOrder: bookOrder,
          amount: matchAmount,
          price: bookOrder.price
        });
        
        incomingOrder.remainingAmount -= matchAmount;
        bookOrder.remainingAmount -= matchAmount;
        
        if (bookOrder.remainingAmount === 0) {
          orders.splice(i, 1);
          i--;
        }
      }
      
      // Remove empty price levels
      if (orders.length === 0) {
        book.delete(price);
      }
    }
    
    return matches;
  }
  
  /**
   * Get order book depth
   */
  getDepth(levels = 10) {
    const depth = {
      bids: [],
      asks: []
    };
    
    let count = 0;
    for (const [price, orders] of this.bids) {
      if (count >= levels) break;
      
      const totalAmount = orders.reduce((sum, order) => sum + order.remainingAmount, 0);
      depth.bids.push({ price, amount: totalAmount });
      count++;
    }
    
    count = 0;
    for (const [price, orders] of this.asks) {
      if (count >= levels) break;
      
      const totalAmount = orders.reduce((sum, order) => sum + order.remainingAmount, 0);
      depth.asks.push({ price, amount: totalAmount });
      count++;
    }
    
    return depth;
  }
  
  /**
   * Sort bid prices descending
   */
  sortBids() {
    const sorted = new Map([...this.bids.entries()].sort((a, b) => b[0] - a[0]));
    this.bids = sorted;
  }
  
  /**
   * Sort ask prices ascending
   */
  sortAsks() {
    const sorted = new Map([...this.asks.entries()].sort((a, b) => a[0] - b[0]));
    this.asks = sorted;
  }
  
  /**
   * Validate order
   */
  validateOrder(order) {
    if (!order.id || !order.side || !order.price || !order.amount) {
      return false;
    }
    
    if (order.side !== 'buy' && order.side !== 'sell') {
      return false;
    }
    
    if (order.price <= 0 || order.amount <= 0) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Add stop order
   */
  addStopOrder(order) {
    if (!this.stopOrders.has(order.stopPrice)) {
      this.stopOrders.set(order.stopPrice, []);
    }
    
    this.stopOrders.get(order.stopPrice).push(order);
  }
  
  /**
   * Check and trigger stop orders
   */
  checkStopOrders(currentPrice) {
    const triggered = [];
    
    for (const [stopPrice, orders] of this.stopOrders) {
      if (currentPrice <= stopPrice) {
        triggered.push(...orders);
        this.stopOrders.delete(stopPrice);
      }
    }
    
    // Convert stop orders to limit orders
    for (const order of triggered) {
      order.type = order.type === 'stop' ? 'market' : 'limit';
      this.addToBook(order);
    }
    
    return triggered;
  }
}

/**
 * Smart Order Router
 */
export class SmartOrderRouter {
  constructor(orderBook, ammPools, options = {}) {
    this.orderBook = orderBook;
    this.ammPools = ammPools;
    this.options = {
      splitThreshold: options.splitThreshold || 0.1, // 10% of liquidity
      maxSplits: options.maxSplits || 5,
      ...options
    };
  }
  
  /**
   * Route order optimally between order book and AMM
   */
  async routeOrder(order) {
    const { side, amount } = order;
    
    // Get available liquidity from both sources
    const bookLiquidity = this.getBookLiquidity(side, order.price);
    const ammQuote = await this.getAMMQuote(order);
    
    // Determine optimal split
    const splits = this.calculateOptimalSplit(
      amount,
      bookLiquidity,
      ammQuote
    );
    
    // Execute splits
    const executions = [];
    
    for (const split of splits) {
      if (split.venue === 'book') {
        const matches = this.orderBook.matchOrders({
          ...order,
          amount: split.amount,
          remainingAmount: split.amount
        });
        executions.push({ venue: 'book', matches });
      } else {
        const swap = await this.ammPools.swap({
          ...order,
          amount: split.amount
        });
        executions.push({ venue: 'amm', swap });
      }
    }
    
    return executions;
  }
  
  /**
   * Get available liquidity from order book
   */
  getBookLiquidity(side, maxPrice) {
    const book = side === 'buy' ? this.orderBook.asks : this.orderBook.bids;
    let totalLiquidity = 0;
    
    for (const [price, orders] of book) {
      if (side === 'buy' && price > maxPrice) break;
      if (side === 'sell' && price < maxPrice) break;
      
      totalLiquidity += orders.reduce((sum, order) => sum + order.remainingAmount, 0);
    }
    
    return totalLiquidity;
  }
  
  /**
   * Get AMM quote
   */
  async getAMMQuote(order) {
    try {
      return await this.ammPools.getQuote(
        order.baseToken,
        order.quoteToken,
        order.amount
      );
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Calculate optimal split between venues
   */
  calculateOptimalSplit(amount, bookLiquidity, ammQuote) {
    const splits = [];
    
    // If order is small relative to liquidity, use single venue
    if (amount < bookLiquidity * this.options.splitThreshold) {
      // Compare prices and use better venue
      if (ammQuote && ammQuote.effectivePrice < bookLiquidity.bestPrice) {
        splits.push({ venue: 'amm', amount });
      } else {
        splits.push({ venue: 'book', amount });
      }
      return splits;
    }
    
    // Split order
    let remainingAmount = amount;
    let bookAmount = Math.min(bookLiquidity, amount * 0.7); // Use up to 70% from book
    let ammAmount = remainingAmount - bookAmount;
    
    if (bookAmount > 0) {
      splits.push({ venue: 'book', amount: bookAmount });
    }
    
    if (ammAmount > 0 && ammQuote) {
      splits.push({ venue: 'amm', amount: ammAmount });
    }
    
    return splits;
  }
}