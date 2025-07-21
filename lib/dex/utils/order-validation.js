/**
 * Shared Order Validation Utilities for DEX Systems
 * Consolidates duplicated order validation logic across all DEX components
 * 
 * Design principles:
 * - Carmack: Fast validation with early returns
 * - Martin: Clean validation rules separation
 * - Pike: Simple, reliable validation logic
 */

import { BigNumber } from 'ethers';

/**
 * Order types enumeration
 */
export const OrderType = {
  MARKET: 'market',
  LIMIT: 'limit',
  STOP: 'stop',
  STOP_LIMIT: 'stop_limit',
  IOC: 'ioc', // Immediate or Cancel
  FOK: 'fok', // Fill or Kill
  POST_ONLY: 'post_only'
};

/**
 * Order sides enumeration
 */
export const OrderSide = {
  BUY: 'buy',
  SELL: 'sell'
};

/**
 * Order status enumeration
 */
export const OrderStatus = {
  PENDING: 'pending',
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
};

/**
 * Validation error types
 */
export const ValidationError = {
  INVALID_ORDER_TYPE: 'INVALID_ORDER_TYPE',
  INVALID_SIDE: 'INVALID_SIDE',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_PRICE: 'INVALID_PRICE',
  INVALID_USER_ID: 'INVALID_USER_ID',
  INVALID_SYMBOL: 'INVALID_SYMBOL',
  AMOUNT_TOO_SMALL: 'AMOUNT_TOO_SMALL',
  AMOUNT_TOO_LARGE: 'AMOUNT_TOO_LARGE',
  PRICE_TOO_LOW: 'PRICE_TOO_LOW',
  PRICE_TOO_HIGH: 'PRICE_TOO_HIGH',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MARKET_CLOSED: 'MARKET_CLOSED',
  INVALID_TIME_IN_FORCE: 'INVALID_TIME_IN_FORCE',
  PRICE_PRECISION_ERROR: 'PRICE_PRECISION_ERROR',
  AMOUNT_PRECISION_ERROR: 'AMOUNT_PRECISION_ERROR'
};

/**
 * Order validation configuration
 */
const DEFAULT_VALIDATION_CONFIG = {
  minOrderAmount: BigNumber.from('1000000000000000'), // 0.001 tokens (18 decimals)
  maxOrderAmount: BigNumber.from('1000000000000000000000000'), // 1M tokens
  minPrice: BigNumber.from('1'), // 0.000000000000000001 price units
  maxPrice: BigNumber.from('1000000000000000000000000'), // 1M price units
  maxPriceDecimals: 18,
  maxAmountDecimals: 18,
  maxOrdersPerUser: 100,
  maxOrderAge: 24 * 60 * 60 * 1000 // 24 hours
};

/**
 * Core order validation class
 */
export class OrderValidator {
  constructor(config = {}) {
    this.config = { ...DEFAULT_VALIDATION_CONFIG, ...config };
    this.marketStatus = new Map(); // Track market status per trading pair
  }
  
  /**
   * Validate complete order object
   */
  validateOrder(order, userBalance = null) {
    const errors = [];
    
    // Basic structure validation
    const structureErrors = this.validateOrderStructure(order);
    errors.push(...structureErrors);
    
    // Parameter validation
    const paramErrors = this.validateOrderParameters(order);
    errors.push(...paramErrors);
    
    // Business logic validation
    const businessErrors = this.validateBusinessRules(order, userBalance);
    errors.push(...businessErrors);
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Validate order structure and required fields
   */
  validateOrderStructure(order) {
    const errors = [];
    
    if (!order) {
      errors.push({ type: 'MISSING_ORDER', message: 'Order object is required' });
      return errors;
    }
    
    // Required fields
    const requiredFields = ['type', 'side', 'amount', 'userId', 'symbol'];
    for (const field of requiredFields) {
      if (order[field] === undefined || order[field] === null) {
        errors.push({
          type: 'MISSING_FIELD',
          field,
          message: `Order ${field} is required`
        });
      }
    }
    
    // Type-specific required fields
    if (order.type === OrderType.LIMIT || order.type === OrderType.STOP_LIMIT) {
      if (!order.price) {
        errors.push({
          type: ValidationError.INVALID_PRICE,
          message: 'Price is required for limit orders'
        });
      }
    }
    
    if (order.type === OrderType.STOP || order.type === OrderType.STOP_LIMIT) {
      if (!order.stopPrice) {
        errors.push({
          type: 'MISSING_STOP_PRICE',
          message: 'Stop price is required for stop orders'
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Validate order parameters
   */
  validateOrderParameters(order) {
    const errors = [];
    
    // Validate order type
    if (!Object.values(OrderType).includes(order.type)) {
      errors.push({
        type: ValidationError.INVALID_ORDER_TYPE,
        message: `Invalid order type: ${order.type}`
      });
    }
    
    // Validate side
    if (!Object.values(OrderSide).includes(order.side)) {
      errors.push({
        type: ValidationError.INVALID_SIDE,
        message: `Invalid order side: ${order.side}`
      });
    }
    
    // Validate amount
    const amountErrors = this.validateAmount(order.amount);
    errors.push(...amountErrors);
    
    // Validate price (if provided)
    if (order.price) {
      const priceErrors = this.validatePrice(order.price);
      errors.push(...priceErrors);
    }
    
    // Validate stop price (if provided)
    if (order.stopPrice) {
      const stopPriceErrors = this.validatePrice(order.stopPrice, 'stop price');
      errors.push(...stopPriceErrors);
    }
    
    // Validate user ID
    if (!order.userId || typeof order.userId !== 'string') {
      errors.push({
        type: ValidationError.INVALID_USER_ID,
        message: 'Valid user ID is required'
      });
    }
    
    // Validate symbol
    if (!order.symbol || typeof order.symbol !== 'string') {
      errors.push({
        type: ValidationError.INVALID_SYMBOL,
        message: 'Valid trading symbol is required'
      });
    }
    
    return errors;
  }
  
  /**
   * Validate amount parameter
   */
  validateAmount(amount) {
    const errors = [];
    
    try {
      const amountBN = BigNumber.from(amount);
      
      if (amountBN.lte(0)) {
        errors.push({
          type: ValidationError.INVALID_AMOUNT,
          message: 'Amount must be greater than zero'
        });
      }
      
      if (amountBN.lt(this.config.minOrderAmount)) {
        errors.push({
          type: ValidationError.AMOUNT_TOO_SMALL,
          message: `Amount below minimum: ${this.config.minOrderAmount.toString()}`
        });
      }
      
      if (amountBN.gt(this.config.maxOrderAmount)) {
        errors.push({
          type: ValidationError.AMOUNT_TOO_LARGE,
          message: `Amount exceeds maximum: ${this.config.maxOrderAmount.toString()}`
        });
      }
      
    } catch (error) {
      errors.push({
        type: ValidationError.INVALID_AMOUNT,
        message: 'Invalid amount format'
      });
    }
    
    return errors;
  }
  
  /**
   * Validate price parameter
   */
  validatePrice(price, priceType = 'price') {
    const errors = [];
    
    try {
      const priceBN = BigNumber.from(price);
      
      if (priceBN.lte(0)) {
        errors.push({
          type: ValidationError.INVALID_PRICE,
          message: `${priceType} must be greater than zero`
        });
      }
      
      if (priceBN.lt(this.config.minPrice)) {
        errors.push({
          type: ValidationError.PRICE_TOO_LOW,
          message: `${priceType} below minimum: ${this.config.minPrice.toString()}`
        });
      }
      
      if (priceBN.gt(this.config.maxPrice)) {
        errors.push({
          type: ValidationError.PRICE_TOO_HIGH,
          message: `${priceType} exceeds maximum: ${this.config.maxPrice.toString()}`
        });
      }
      
    } catch (error) {
      errors.push({
        type: ValidationError.INVALID_PRICE,
        message: `Invalid ${priceType} format`
      });
    }
    
    return errors;
  }
  
  /**
   * Validate business rules
   */
  validateBusinessRules(order, userBalance = null) {
    const errors = [];
    
    // Check market status
    const marketOpen = this.isMarketOpen(order.symbol);
    if (!marketOpen) {
      errors.push({
        type: ValidationError.MARKET_CLOSED,
        message: `Market is closed for ${order.symbol}`
      });
    }
    
    // Check user balance (if provided)
    if (userBalance !== null) {
      const balanceErrors = this.validateUserBalance(order, userBalance);
      errors.push(...balanceErrors);
    }
    
    // Validate order age (if createdAt is provided)
    if (order.createdAt) {
      const age = Date.now() - order.createdAt;
      if (age > this.config.maxOrderAge) {
        errors.push({
          type: 'ORDER_EXPIRED',
          message: 'Order has expired'
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Validate user has sufficient balance
   */
  validateUserBalance(order, userBalance) {
    const errors = [];
    
    try {
      const amountBN = BigNumber.from(order.amount);
      const balanceBN = BigNumber.from(userBalance);
      
      if (order.side === OrderSide.SELL) {
        if (balanceBN.lt(amountBN)) {
          errors.push({
            type: ValidationError.INSUFFICIENT_BALANCE,
            message: 'Insufficient balance for sell order'
          });
        }
      } else if (order.side === OrderSide.BUY && order.price) {
        const totalCost = amountBN.mul(BigNumber.from(order.price));
        if (balanceBN.lt(totalCost)) {
          errors.push({
            type: ValidationError.INSUFFICIENT_BALANCE,
            message: 'Insufficient balance for buy order'
          });
        }
      }
      
    } catch (error) {
      errors.push({
        type: 'BALANCE_VALIDATION_ERROR',
        message: 'Error validating user balance'
      });
    }
    
    return errors;
  }
  
  /**
   * Quick validation for high-frequency operations
   */
  quickValidate(order) {
    // Fast validation for critical path operations
    if (!order || !order.type || !order.side || !order.amount || !order.userId) {
      return false;
    }
    
    if (!Object.values(OrderType).includes(order.type)) return false;
    if (!Object.values(OrderSide).includes(order.side)) return false;
    
    try {
      const amountBN = BigNumber.from(order.amount);
      if (amountBN.lte(0)) return false;
    } catch {
      return false;
    }
    
    return true;
  }
  
  /**
   * Set market status
   */
  setMarketStatus(symbol, isOpen) {
    this.marketStatus.set(symbol, isOpen);
  }
  
  /**
   * Check if market is open
   */
  isMarketOpen(symbol) {
    return this.marketStatus.get(symbol) !== false; // Default to open
  }
  
  /**
   * Update validation configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

/**
 * Create singleton validator instance with default config
 */
const defaultValidator = new OrderValidator();

/**
 * Convenience functions using default validator
 */
export const validateOrder = (order, userBalance) => defaultValidator.validateOrder(order, userBalance);
export const quickValidateOrder = (order) => defaultValidator.quickValidate(order);
export const validateOrderStructure = (order) => defaultValidator.validateOrderStructure(order);
export const validateOrderParameters = (order) => defaultValidator.validateOrderParameters(order);

/**
 * Utility functions for order manipulation
 */
export const OrderUtils = {
  /**
   * Create order ID
   */
  generateOrderId() {
    return `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  },
  
  /**
   * Check if order is filled
   */
  isFilled(order) {
    return order.status === OrderStatus.FILLED || 
           (order.filledAmount && BigNumber.from(order.filledAmount).gte(BigNumber.from(order.amount)));
  },
  
  /**
   * Check if order is partially filled
   */
  isPartiallyFilled(order) {
    return order.filledAmount && 
           BigNumber.from(order.filledAmount).gt(0) && 
           BigNumber.from(order.filledAmount).lt(BigNumber.from(order.amount));
  },
  
  /**
   * Get remaining amount to fill
   */
  getRemainingAmount(order) {
    if (!order.filledAmount) return BigNumber.from(order.amount);
    return BigNumber.from(order.amount).sub(BigNumber.from(order.filledAmount));
  },
  
  /**
   * Calculate order value
   */
  calculateOrderValue(order) {
    const amount = BigNumber.from(order.amount);
    const price = BigNumber.from(order.price || 0);
    return amount.mul(price);
  }
};

export default {
  OrderType,
  OrderSide,
  OrderStatus,
  ValidationError,
  OrderValidator,
  validateOrder,
  quickValidateOrder,
  validateOrderStructure,
  validateOrderParameters,
  OrderUtils
};