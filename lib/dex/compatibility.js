/**
 * DEX Backward Compatibility Layer
 * 
 * Provides compatibility wrappers for legacy DEX implementations
 * to ensure existing code continues to work during migration.
 */

import { getDEX, ConsolidatedDEXEngine, OrderType, OrderSide, OrderStatus } from './index.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('DEXCompatibility');

// Warn about deprecated usage
const deprecationWarning = (className) => {
  logger.warn(`${className} is deprecated. Please migrate to ConsolidatedDEXEngine from lib/dex/index.js`);
};

/**
 * Legacy DEXEngine wrapper
 */
export class DEXEngine {
  constructor(db, options = {}) {
    deprecationWarning('DEXEngine');
    this.dex = getDEX({
      ...options,
      db,
      autoInitialize: false
    });
    this.db = db;
    this.initialized = false;
  }

  async init() {
    await this.dex.initialize();
    this.initialized = true;
  }

  async createOrder(params) {
    return this.dex.placeOrder(params);
  }

  async cancelOrder(orderId, userId) {
    return this.dex.cancelOrder(orderId, userId);
  }

  async getOrderBook(pair, depth) {
    const [base, quote] = pair.split('/');
    const symbol = `${base}/${quote}`;
    return this.dex.getOrderBook(symbol, depth);
  }

  async getTicker(pair) {
    const [base, quote] = pair.split('/');
    const symbol = `${base}/${quote}`;
    const bidAsk = this.dex.getBestBidAsk(symbol);
    const tradingPair = this.dex.tradingPairs.get(symbol);
    
    return {
      pair,
      bid: bidAsk.bid?.price || 0,
      ask: bidAsk.ask?.price || 0,
      last: tradingPair?.lastPrice || 0,
      volume24h: tradingPair?.volume24h || 0,
      high24h: tradingPair?.high24h || 0,
      low24h: tradingPair?.low24h || 0
    };
  }

  async getUserOrders(userId) {
    return this.dex.getUserActiveOrders(userId);
  }

  getStats() {
    return this.dex.getStats();
  }
}

/**
 * Legacy DEXEngineV2 wrapper
 */
export class DEXEngineV2 extends DEXEngine {
  constructor(config = {}) {
    super(null, config);
    deprecationWarning('DEXEngineV2');
  }

  async initialize() {
    return this.init();
  }

  async placeOrder(params) {
    return this.createOrder(params);
  }

  async getMarketDepth(symbol, levels) {
    return this.getOrderBook(symbol, levels);
  }

  async getBestBidAsk(symbol) {
    return this.dex.getBestBidAsk(symbol);
  }

  async getOrdersByUser(userId) {
    return this.getUserOrders(userId);
  }
}

/**
 * Legacy order type exports
 */
export const ORDER_TYPE = OrderType;
export const ORDER_SIDE = OrderSide;
export const ORDER_STATUS = OrderStatus;

/**
 * Legacy AdvancedOrderType export
 */
export const AdvancedOrderType = {
  ICEBERG: OrderType.ICEBERG,
  TWAP: OrderType.TWAP,
  VWAP: OrderType.VWAP,
  TRAILING_STOP: OrderType.TRAILING_STOP,
  OCO: OrderType.ONE_CANCELS_OTHER,
  BRACKET: OrderType.BRACKET
};

/**
 * Legacy AMMEngine wrapper
 */
export class AMMEngine {
  constructor(options = {}) {
    deprecationWarning('AMMEngine');
    this.dex = getDEX(options);
  }

  async initialize() {
    await this.dex.initialize();
  }

  async createPool(params) {
    // Delegate to DEX's AMM functionality
    logger.warn('createPool: Legacy AMM functionality - please use ConsolidatedDEXEngine');
    return { success: false, error: 'Legacy AMM not supported' };
  }

  async addLiquidity(params) {
    logger.warn('addLiquidity: Legacy AMM functionality - please use ConsolidatedDEXEngine');
    return { success: false, error: 'Legacy AMM not supported' };
  }

  async removeLiquidity(params) {
    logger.warn('removeLiquidity: Legacy AMM functionality - please use ConsolidatedDEXEngine');
    return { success: false, error: 'Legacy AMM not supported' };
  }

  async swap(params) {
    // Convert to order
    const order = {
      userId: params.userId,
      symbol: `${params.tokenIn}/${params.tokenOut}`,
      type: OrderType.MARKET,
      side: OrderSide.SELL,
      quantity: params.amountIn
    };
    
    return this.dex.placeOrder(order);
  }
}

/**
 * Legacy BatchMatchingEngine wrapper
 */
export class BatchMatchingEngine {
  constructor(options = {}) {
    deprecationWarning('BatchMatchingEngine');
    this.dex = getDEX({
      ...options,
      performanceMode: 'batch'
    });
  }

  async initialize() {
    await this.dex.initialize();
  }

  async addOrder(order) {
    return this.dex.placeOrder(order);
  }

  async processBatch() {
    // Batch processing is automatic in consolidated engine
    return { processed: 0, matches: [] };
  }
}

/**
 * Legacy CrossChainBridge wrapper
 */
export class CrossChainBridge {
  constructor(options = {}) {
    deprecationWarning('CrossChainBridge');
    this.dex = getDEX({
      ...options,
      enableCrossChain: true
    });
  }

  async initialize() {
    await this.dex.initialize();
  }

  async bridgeTokens(params) {
    if (!this.dex.crossChainBridge) {
      throw new Error('Cross-chain functionality not enabled');
    }
    return this.dex.crossChainBridge.bridgeTokens(params);
  }
}

/**
 * Legacy MEVProtection wrapper
 */
export class MEVProtection {
  constructor(options = {}) {
    deprecationWarning('MEVProtection');
    this.dex = getDEX({
      ...options,
      enableMEVProtection: true
    });
  }

  async protectOrder(order) {
    // MEV protection is automatic in consolidated engine
    return order;
  }
}

/**
 * Legacy FlashLoanManager wrapper
 */
export class FlashLoanManager {
  constructor(options = {}) {
    deprecationWarning('FlashLoanManager');
    this.dex = getDEX({
      ...options,
      enableFlashLoans: true
    });
  }

  async executeLoan(params) {
    return this.dex.executeFlashLoan(params);
  }
}

// Default export for backward compatibility
export default DEXEngine;