/**
 * Order Memory Pool for Otedama DEX
 * Pre-allocated order objects to reduce GC pressure
 * 
 * Design principles:
 * - Zero allocation in hot path (Carmack)
 * - Clean pool management (Martin)
 * - Simple object recycling (Pike)
 */

import { logger } from '../core/logger.js';

export class OrderMemoryPool {
    constructor(config = {}) {
        this.config = {
            initialSize: config.initialSize || 10000,
            maxSize: config.maxSize || 100000,
            growthFactor: config.growthFactor || 2,
            shrinkThreshold: config.shrinkThreshold || 0.25,
            ...config
        };
        
        // Pre-allocated order pool
        this.pool = [];
        this.available = [];
        this.inUse = new Set();
        
        // Statistics
        this.stats = {
            allocated: 0,
            poolHits: 0,
            poolMisses: 0,
            expansions: 0,
            shrinks: 0,
            currentSize: 0,
            peakUsage: 0
        };
        
        // Initialize pool
        this.initialize();
    }
    
    /**
     * Initialize the order pool
     */
    initialize() {
        const startTime = Date.now();
        
        // Pre-allocate orders
        for (let i = 0; i < this.config.initialSize; i++) {
            const order = this.createOrder();
            this.pool.push(order);
            this.available.push(order);
        }
        
        this.stats.allocated = this.config.initialSize;
        this.stats.currentSize = this.config.initialSize;
        
        const duration = Date.now() - startTime;
        logger.info(`Order pool initialized: ${this.config.initialSize} orders in ${duration}ms`);
    }
    
    /**
     * Get an order from the pool
     */
    acquire(data) {
        let order;
        
        if (this.available.length > 0) {
            // Reuse from pool
            order = this.available.pop();
            this.stats.poolHits++;
        } else {
            // Pool exhausted, expand if possible
            if (this.stats.currentSize < this.config.maxSize) {
                this.expand();
                order = this.available.pop();
            } else {
                // Max size reached, create new (will cause GC)
                order = this.createOrder();
                this.stats.poolMisses++;
                logger.warn('Order pool exhausted, creating new order');
            }
        }
        
        // Reset and populate order
        this.resetOrder(order, data);
        this.inUse.add(order);
        
        // Track peak usage
        if (this.inUse.size > this.stats.peakUsage) {
            this.stats.peakUsage = this.inUse.size;
        }
        
        return order;
    }
    
    /**
     * Return an order to the pool
     */
    release(order) {
        if (!this.inUse.has(order)) {
            logger.warn('Attempting to release order not in use');
            return;
        }
        
        this.inUse.delete(order);
        
        // Only return to pool if under max size
        if (this.available.length + this.inUse.size < this.config.maxSize) {
            this.clearOrder(order);
            this.available.push(order);
        }
        
        // Check if we should shrink the pool
        this.checkShrink();
    }
    
    /**
     * Batch acquire multiple orders
     */
    acquireBatch(dataArray) {
        const orders = new Array(dataArray.length);
        
        for (let i = 0; i < dataArray.length; i++) {
            orders[i] = this.acquire(dataArray[i]);
        }
        
        return orders;
    }
    
    /**
     * Batch release multiple orders
     */
    releaseBatch(orders) {
        for (const order of orders) {
            this.release(order);
        }
    }
    
    /**
     * Create a new order object
     */
    createOrder() {
        return {
            // Core fields
            id: '',
            userId: '',
            pair: '',
            side: '', // buy/sell
            type: '', // market/limit/stop
            status: '', // pending/filled/cancelled
            
            // Numeric fields (pre-allocated)
            price: 0,
            quantity: 0,
            filled: 0,
            remaining: 0,
            
            // Timestamps
            createdAt: 0,
            updatedAt: 0,
            expiresAt: 0,
            
            // Execution details
            fee: 0,
            slippage: 0,
            averagePrice: 0,
            
            // Flags (bit field for memory efficiency)
            flags: 0, // postOnly, reduceOnly, hidden, etc.
            
            // References (reused arrays)
            fills: [], // Reusable array
            updates: [], // Reusable array
            
            // Pool metadata
            _pooled: true,
            _version: 0
        };
    }
    
    /**
     * Reset order with new data
     */
    resetOrder(order, data) {
        // Core fields
        order.id = data.id || this.generateOrderId();
        order.userId = data.userId || '';
        order.pair = data.pair || '';
        order.side = data.side || '';
        order.type = data.type || 'limit';
        order.status = 'pending';
        
        // Numeric fields
        order.price = data.price || 0;
        order.quantity = data.quantity || 0;
        order.filled = 0;
        order.remaining = data.quantity || 0;
        
        // Timestamps
        order.createdAt = Date.now();
        order.updatedAt = order.createdAt;
        order.expiresAt = data.expiresAt || 0;
        
        // Execution details
        order.fee = 0;
        order.slippage = 0;
        order.averagePrice = 0;
        
        // Flags
        order.flags = 0;
        if (data.postOnly) order.flags |= OrderFlags.POST_ONLY;
        if (data.reduceOnly) order.flags |= OrderFlags.REDUCE_ONLY;
        if (data.hidden) order.flags |= OrderFlags.HIDDEN;
        if (data.immediateOrCancel) order.flags |= OrderFlags.IOC;
        if (data.fillOrKill) order.flags |= OrderFlags.FOK;
        
        // Clear arrays but keep references
        order.fills.length = 0;
        order.updates.length = 0;
        
        // Increment version
        order._version++;
        
        return order;
    }
    
    /**
     * Clear order data
     */
    clearOrder(order) {
        // Reset strings to empty
        order.id = '';
        order.userId = '';
        order.pair = '';
        order.side = '';
        order.type = '';
        order.status = '';
        
        // Reset numbers to 0
        order.price = 0;
        order.quantity = 0;
        order.filled = 0;
        order.remaining = 0;
        order.createdAt = 0;
        order.updatedAt = 0;
        order.expiresAt = 0;
        order.fee = 0;
        order.slippage = 0;
        order.averagePrice = 0;
        order.flags = 0;
        
        // Clear arrays
        order.fills.length = 0;
        order.updates.length = 0;
    }
    
    /**
     * Expand the pool
     */
    expand() {
        const currentSize = this.stats.currentSize;
        const newSize = Math.min(
            currentSize * this.config.growthFactor,
            this.config.maxSize
        );
        const growthCount = Math.floor(newSize - currentSize);
        
        logger.info(`Expanding order pool: ${currentSize} -> ${newSize}`);
        
        for (let i = 0; i < growthCount; i++) {
            const order = this.createOrder();
            this.pool.push(order);
            this.available.push(order);
        }
        
        this.stats.currentSize = newSize;
        this.stats.allocated += growthCount;
        this.stats.expansions++;
    }
    
    /**
     * Check if pool should shrink
     */
    checkShrink() {
        const usage = this.inUse.size / this.stats.currentSize;
        
        if (usage < this.config.shrinkThreshold && 
            this.stats.currentSize > this.config.initialSize) {
            this.shrink();
        }
    }
    
    /**
     * Shrink the pool
     */
    shrink() {
        const targetSize = Math.max(
            this.config.initialSize,
            Math.floor(this.stats.currentSize / this.config.growthFactor)
        );
        
        const removeCount = this.stats.currentSize - targetSize;
        
        logger.info(`Shrinking order pool: ${this.stats.currentSize} -> ${targetSize}`);
        
        // Remove excess orders from available pool
        for (let i = 0; i < removeCount && this.available.length > 0; i++) {
            this.available.pop();
        }
        
        this.stats.currentSize = targetSize;
        this.stats.shrinks++;
    }
    
    /**
     * Generate order ID
     */
    generateOrderId() {
        return `ORD${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Get pool statistics
     */
    getStats() {
        return {
            ...this.stats,
            available: this.available.length,
            inUse: this.inUse.size,
            utilization: this.inUse.size / this.stats.currentSize,
            hitRate: this.stats.poolHits / (this.stats.poolHits + this.stats.poolMisses)
        };
    }
    
    /**
     * Warm up the pool
     */
    warmup(count) {
        const orders = [];
        
        // Acquire and release to warm up
        for (let i = 0; i < count; i++) {
            orders.push(this.acquire({ pair: 'BTC/USDT', side: 'buy', price: 50000, quantity: 1 }));
        }
        
        for (const order of orders) {
            this.release(order);
        }
        
        logger.info(`Pool warmed up with ${count} orders`);
    }
}

// Order flags bit field
export const OrderFlags = {
    POST_ONLY: 1 << 0,
    REDUCE_ONLY: 1 << 1,
    HIDDEN: 1 << 2,
    IOC: 1 << 3, // Immediate or Cancel
    FOK: 1 << 4, // Fill or Kill
    STOP_LOSS: 1 << 5,
    TAKE_PROFIT: 1 << 6,
    TRAILING: 1 << 7,
    ICEBERG: 1 << 8,
    TWAP: 1 << 9,
    TRIGGERED: 1 << 10
};

// Helper functions for order flags
export const OrderFlagHelpers = {
    hasFlag(order, flag) {
        return (order.flags & flag) !== 0;
    },
    
    setFlag(order, flag) {
        order.flags |= flag;
    },
    
    clearFlag(order, flag) {
        order.flags &= ~flag;
    },
    
    isPostOnly(order) {
        return this.hasFlag(order, OrderFlags.POST_ONLY);
    },
    
    isReduceOnly(order) {
        return this.hasFlag(order, OrderFlags.REDUCE_ONLY);
    },
    
    isHidden(order) {
        return this.hasFlag(order, OrderFlags.HIDDEN);
    },
    
    isIOC(order) {
        return this.hasFlag(order, OrderFlags.IOC);
    },
    
    isFOK(order) {
        return this.hasFlag(order, OrderFlags.FOK);
    }
};

export default OrderMemoryPool;