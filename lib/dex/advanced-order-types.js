/**
 * Advanced Order Types for Otedama DEX
 * Implements stop-limit, iceberg, TWAP, and other advanced order types
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('AdvancedOrderTypes');

// Order types enum
export const AdvancedOrderType = {
    STOP_LIMIT: 'stop_limit',
    STOP_MARKET: 'stop_market',
    ICEBERG: 'iceberg',
    TWAP: 'twap',           // Time-Weighted Average Price
    TRAILING_STOP: 'trailing_stop',
    ONE_CANCELS_OTHER: 'oco',
    FILL_OR_KILL: 'fok',
    IMMEDIATE_OR_CANCEL: 'ioc',
    GOOD_TILL_TIME: 'gtt',
    BRACKET: 'bracket'      // Entry with stop-loss and take-profit
};

export class AdvancedOrderManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            maxOrdersPerUser: config.maxOrdersPerUser || 100,
            maxIcebergRatio: config.maxIcebergRatio || 0.1, // 10% max visible
            minTwapDuration: config.minTwapDuration || 300000, // 5 minutes
            maxTwapSlices: config.maxTwapSlices || 100,
            trailingStopMaxDistance: config.trailingStopMaxDistance || 0.1, // 10%
            ...config
        };
        
        // Order storage
        this.advancedOrders = new Map(); // orderId -> advancedOrder
        this.triggerOrders = new Map(); // price -> Set of orders
        this.userOrders = new Map(); // userId -> Set of orderIds
        
        // Price tracking for triggers
        this.lastPrices = new Map(); // pair -> price
        this.priceWatchers = new Map(); // pair -> Set of orderIds
        
        // Statistics
        this.stats = {
            totalAdvancedOrders: 0,
            triggeredOrders: 0,
            activeOrders: 0,
            ordersByType: new Map()
        };
    }
    
    /**
     * Create advanced order
     */
    async createAdvancedOrder(order) {
        // Validate order
        const validation = this.validateAdvancedOrder(order);
        if (!validation.valid) {
            throw new Error(validation.reason);
        }
        
        // Check user limits
        if (!this.checkUserLimits(order.userId)) {
            throw new Error('User order limit exceeded');
        }
        
        // Create order ID
        order.id = this.generateOrderId();
        order.createdAt = Date.now();
        order.status = 'pending';
        
        // Store order
        this.advancedOrders.set(order.id, order);
        
        // Track by user
        if (!this.userOrders.has(order.userId)) {
            this.userOrders.set(order.userId, new Set());
        }
        this.userOrders.get(order.userId).add(order.id);
        
        // Setup triggers based on order type
        await this.setupOrderTriggers(order);
        
        // Update stats
        this.updateStats('create', order);
        
        // Emit event
        this.emit('order:created', order);
        
        logger.info(`Advanced order created: ${order.id} (${order.type})`);
        
        return order;
    }
    
    /**
     * Validate advanced order
     */
    validateAdvancedOrder(order) {
        // Basic validation
        if (!order.userId || !order.pair || !order.type) {
            return { valid: false, reason: 'Missing required fields' };
        }
        
        // Type-specific validation
        switch (order.type) {
            case AdvancedOrderType.STOP_LIMIT:
            case AdvancedOrderType.STOP_MARKET:
                if (!order.stopPrice || order.stopPrice <= 0) {
                    return { valid: false, reason: 'Invalid stop price' };
                }
                break;
                
            case AdvancedOrderType.ICEBERG:
                if (!order.visibleAmount || order.visibleAmount <= 0) {
                    return { valid: false, reason: 'Invalid visible amount' };
                }
                if (order.visibleAmount > order.amount * this.config.maxIcebergRatio) {
                    return { valid: false, reason: 'Visible amount too large' };
                }
                break;
                
            case AdvancedOrderType.TWAP:
                if (!order.duration || order.duration < this.config.minTwapDuration) {
                    return { valid: false, reason: 'Invalid TWAP duration' };
                }
                if (!order.slices || order.slices > this.config.maxTwapSlices) {
                    return { valid: false, reason: 'Invalid TWAP slices' };
                }
                break;
                
            case AdvancedOrderType.TRAILING_STOP:
                if (!order.trailingDistance || order.trailingDistance <= 0) {
                    return { valid: false, reason: 'Invalid trailing distance' };
                }
                if (order.trailingDistance > this.config.trailingStopMaxDistance) {
                    return { valid: false, reason: 'Trailing distance too large' };
                }
                break;
                
            case AdvancedOrderType.BRACKET:
                if (!order.stopLoss || !order.takeProfit) {
                    return { valid: false, reason: 'Missing stop loss or take profit' };
                }
                if (order.side === 'buy') {
                    if (order.stopLoss >= order.price || order.takeProfit <= order.price) {
                        return { valid: false, reason: 'Invalid bracket prices' };
                    }
                } else {
                    if (order.stopLoss <= order.price || order.takeProfit >= order.price) {
                        return { valid: false, reason: 'Invalid bracket prices' };
                    }
                }
                break;
        }
        
        return { valid: true };
    }
    
    /**
     * Setup order triggers
     */
    async setupOrderTriggers(order) {
        switch (order.type) {
            case AdvancedOrderType.STOP_LIMIT:
            case AdvancedOrderType.STOP_MARKET:
                this.addPriceTrigger(order.pair, order.stopPrice, order.id, order.side);
                break;
                
            case AdvancedOrderType.TRAILING_STOP:
                // Initialize trailing stop with current price
                const currentPrice = this.lastPrices.get(order.pair) || order.initialPrice;
                order.trailingStopPrice = this.calculateTrailingStopPrice(
                    currentPrice,
                    order.trailingDistance,
                    order.side
                );
                this.addPriceTrigger(order.pair, order.trailingStopPrice, order.id, order.side);
                break;
                
            case AdvancedOrderType.TWAP:
                // Schedule TWAP slices
                await this.scheduleTwapSlices(order);
                break;
                
            case AdvancedOrderType.GOOD_TILL_TIME:
                // Schedule expiration
                setTimeout(() => {
                    this.cancelAdvancedOrder(order.id, 'expired');
                }, order.expireTime - Date.now());
                break;
                
            case AdvancedOrderType.BRACKET:
                // Create child orders for stop loss and take profit
                await this.createBracketOrders(order);
                break;
        }
        
        // Add to price watchers
        if (!this.priceWatchers.has(order.pair)) {
            this.priceWatchers.set(order.pair, new Set());
        }
        this.priceWatchers.get(order.pair).add(order.id);
    }
    
    /**
     * Update price and check triggers
     */
    async updatePrice(pair, price) {
        const oldPrice = this.lastPrices.get(pair);
        this.lastPrices.set(pair, price);
        
        // Get orders watching this pair
        const watchingOrders = this.priceWatchers.get(pair);
        if (!watchingOrders || watchingOrders.size === 0) return;
        
        const triggeredOrders = [];
        
        for (const orderId of watchingOrders) {
            const order = this.advancedOrders.get(orderId);
            if (!order || order.status !== 'pending') continue;
            
            const triggered = await this.checkOrderTrigger(order, price, oldPrice);
            if (triggered) {
                triggeredOrders.push(order);
            }
        }
        
        // Process triggered orders
        for (const order of triggeredOrders) {
            await this.triggerOrder(order);
        }
    }
    
    /**
     * Check if order should be triggered
     */
    async checkOrderTrigger(order, currentPrice, oldPrice) {
        switch (order.type) {
            case AdvancedOrderType.STOP_LIMIT:
            case AdvancedOrderType.STOP_MARKET:
                if (order.side === 'buy') {
                    return currentPrice >= order.stopPrice && oldPrice < order.stopPrice;
                } else {
                    return currentPrice <= order.stopPrice && oldPrice > order.stopPrice;
                }
                
            case AdvancedOrderType.TRAILING_STOP:
                // Update trailing stop if price moved favorably
                if (order.side === 'sell') {
                    const newStopPrice = this.calculateTrailingStopPrice(
                        currentPrice,
                        order.trailingDistance,
                        'sell'
                    );
                    if (newStopPrice > order.trailingStopPrice) {
                        order.trailingStopPrice = newStopPrice;
                        order.highestPrice = currentPrice;
                    }
                    return currentPrice <= order.trailingStopPrice;
                } else {
                    const newStopPrice = this.calculateTrailingStopPrice(
                        currentPrice,
                        order.trailingDistance,
                        'buy'
                    );
                    if (newStopPrice < order.trailingStopPrice) {
                        order.trailingStopPrice = newStopPrice;
                        order.lowestPrice = currentPrice;
                    }
                    return currentPrice >= order.trailingStopPrice;
                }
                
            default:
                return false;
        }
    }
    
    /**
     * Trigger order execution
     */
    async triggerOrder(order) {
        logger.info(`Triggering order ${order.id} (${order.type})`);
        
        order.status = 'triggered';
        order.triggeredAt = Date.now();
        
        // Convert to regular order based on type
        let regularOrder;
        
        switch (order.type) {
            case AdvancedOrderType.STOP_LIMIT:
                regularOrder = {
                    userId: order.userId,
                    pair: order.pair,
                    side: order.side,
                    type: 'limit',
                    price: order.limitPrice || order.price,
                    amount: order.amount,
                    originalOrderId: order.id
                };
                break;
                
            case AdvancedOrderType.STOP_MARKET:
            case AdvancedOrderType.TRAILING_STOP:
                regularOrder = {
                    userId: order.userId,
                    pair: order.pair,
                    side: order.side,
                    type: 'market',
                    amount: order.amount,
                    originalOrderId: order.id
                };
                break;
                
            case AdvancedOrderType.ICEBERG:
                regularOrder = {
                    userId: order.userId,
                    pair: order.pair,
                    side: order.side,
                    type: order.orderType || 'limit',
                    price: order.price,
                    amount: order.visibleAmount,
                    originalOrderId: order.id,
                    isIceberg: true,
                    totalAmount: order.amount,
                    remainingAmount: order.amount - order.visibleAmount
                };
                break;
        }
        
        // Update stats
        this.stats.triggeredOrders++;
        
        // Emit event for order book to process
        this.emit('order:triggered', {
            advancedOrder: order,
            regularOrder
        });
        
        // Handle special cases
        if (order.type === AdvancedOrderType.BRACKET && order.isEntry) {
            // Activate stop loss and take profit orders
            await this.activateBracketOrders(order);
        }
    }
    
    /**
     * Calculate trailing stop price
     */
    calculateTrailingStopPrice(currentPrice, distance, side) {
        if (side === 'sell') {
            return currentPrice * (1 - distance);
        } else {
            return currentPrice * (1 + distance);
        }
    }
    
    /**
     * Schedule TWAP slices
     */
    async scheduleTwapSlices(order) {
        const sliceAmount = order.amount / order.slices;
        const sliceInterval = order.duration / order.slices;
        
        order.twapSlices = [];
        
        for (let i = 0; i < order.slices; i++) {
            const sliceTime = Date.now() + (i * sliceInterval);
            
            const slice = {
                index: i,
                amount: sliceAmount,
                scheduledTime: sliceTime,
                executed: false
            };
            
            order.twapSlices.push(slice);
            
            // Schedule slice execution
            setTimeout(() => {
                this.executeTwapSlice(order, slice);
            }, i * sliceInterval);
        }
    }
    
    /**
     * Execute TWAP slice
     */
    async executeTwapSlice(order, slice) {
        if (order.status !== 'pending' || slice.executed) return;
        
        slice.executed = true;
        slice.executedAt = Date.now();
        
        const regularOrder = {
            userId: order.userId,
            pair: order.pair,
            side: order.side,
            type: order.priceLimit ? 'limit' : 'market',
            price: order.priceLimit,
            amount: slice.amount,
            originalOrderId: order.id,
            twapSlice: slice.index
        };
        
        this.emit('order:triggered', {
            advancedOrder: order,
            regularOrder
        });
        
        // Check if all slices executed
        const allExecuted = order.twapSlices.every(s => s.executed);
        if (allExecuted) {
            order.status = 'completed';
            this.emit('order:completed', order);
        }
    }
    
    /**
     * Create bracket orders
     */
    async createBracketOrders(entryOrder) {
        entryOrder.isEntry = true;
        
        // Create stop loss order
        const stopLossOrder = {
            userId: entryOrder.userId,
            pair: entryOrder.pair,
            side: entryOrder.side === 'buy' ? 'sell' : 'buy',
            type: AdvancedOrderType.STOP_MARKET,
            amount: entryOrder.amount,
            stopPrice: entryOrder.stopLoss,
            parentOrderId: entryOrder.id,
            status: 'inactive'
        };
        
        // Create take profit order
        const takeProfitOrder = {
            userId: entryOrder.userId,
            pair: entryOrder.pair,
            side: entryOrder.side === 'buy' ? 'sell' : 'buy',
            type: AdvancedOrderType.STOP_LIMIT,
            amount: entryOrder.amount,
            stopPrice: entryOrder.takeProfit,
            limitPrice: entryOrder.takeProfit,
            parentOrderId: entryOrder.id,
            status: 'inactive'
        };
        
        // Create OCO relationship
        stopLossOrder.ocoOrderId = takeProfitOrder.id;
        takeProfitOrder.ocoOrderId = stopLossOrder.id;
        
        // Store orders
        entryOrder.stopLossOrderId = await this.createAdvancedOrder(stopLossOrder);
        entryOrder.takeProfitOrderId = await this.createAdvancedOrder(takeProfitOrder);
    }
    
    /**
     * Cancel advanced order
     */
    async cancelAdvancedOrder(orderId, reason = 'user_cancelled') {
        const order = this.advancedOrders.get(orderId);
        if (!order) {
            throw new Error('Order not found');
        }
        
        if (order.status !== 'pending') {
            throw new Error('Order already ' + order.status);
        }
        
        // Update status
        order.status = 'cancelled';
        order.cancelledAt = Date.now();
        order.cancelReason = reason;
        
        // Remove from triggers
        this.removePriceTrigger(order.pair, order.id);
        
        // Remove from user orders
        const userOrderSet = this.userOrders.get(order.userId);
        if (userOrderSet) {
            userOrderSet.delete(orderId);
        }
        
        // Handle OCO cancellation
        if (order.ocoOrderId) {
            await this.cancelAdvancedOrder(order.ocoOrderId, 'oco_cancelled');
        }
        
        // Update stats
        this.updateStats('cancel', order);
        
        // Emit event
        this.emit('order:cancelled', order);
        
        logger.info(`Advanced order cancelled: ${orderId} (${reason})`);
        
        return order;
    }
    
    /**
     * Helper methods
     */
    
    checkUserLimits(userId) {
        const userOrderSet = this.userOrders.get(userId);
        if (!userOrderSet) return true;
        
        const activeOrders = Array.from(userOrderSet)
            .map(id => this.advancedOrders.get(id))
            .filter(order => order && order.status === 'pending')
            .length;
        
        return activeOrders < this.config.maxOrdersPerUser;
    }
    
    addPriceTrigger(pair, price, orderId, side) {
        const key = `${pair}:${price}:${side}`;
        
        if (!this.triggerOrders.has(key)) {
            this.triggerOrders.set(key, new Set());
        }
        
        this.triggerOrders.get(key).add(orderId);
    }
    
    removePriceTrigger(pair, orderId) {
        // Remove from all trigger sets
        for (const [key, orderSet] of this.triggerOrders) {
            if (key.startsWith(pair)) {
                orderSet.delete(orderId);
                if (orderSet.size === 0) {
                    this.triggerOrders.delete(key);
                }
            }
        }
        
        // Remove from price watchers
        const watchers = this.priceWatchers.get(pair);
        if (watchers) {
            watchers.delete(orderId);
        }
    }
    
    generateOrderId() {
        return `ADV-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
    
    updateStats(action, order) {
        if (action === 'create') {
            this.stats.totalAdvancedOrders++;
            this.stats.activeOrders++;
            
            const typeCount = this.stats.ordersByType.get(order.type) || 0;
            this.stats.ordersByType.set(order.type, typeCount + 1);
        } else if (action === 'cancel' || action === 'complete') {
            this.stats.activeOrders--;
        }
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            ordersByType: Object.fromEntries(this.stats.ordersByType),
            activeOrdersByPair: this.getActiveOrdersByPair()
        };
    }
    
    getActiveOrdersByPair() {
        const byPair = {};
        
        for (const [orderId, order] of this.advancedOrders) {
            if (order.status === 'pending') {
                byPair[order.pair] = (byPair[order.pair] || 0) + 1;
            }
        }
        
        return byPair;
    }
}

export default AdvancedOrderManager;