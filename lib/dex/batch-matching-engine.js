/**
 * Batch Order Matching Engine for Otedama DEX
 * Process multiple orders in single pass for high throughput
 * 
 * Design principles:
 * - Batch processing for performance (Carmack)
 * - Clean matching logic (Martin)
 * - Simple batch operations (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { OrderMemoryPool, OrderFlags, OrderFlagHelpers } from './order-pool.js';

const logger = getLogger('BatchMatchingEngine');

export class BatchMatchingEngine extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            batchSize: config.batchSize || 1000,
            batchInterval: config.batchInterval || 100, // ms
            priceTickSize: config.priceTickSize || 0.01,
            minOrderValue: config.minOrderValue || 10, // USDT
            maxPriceDeviation: config.maxPriceDeviation || 0.1, // 10%
            feeRate: config.feeRate || 0.001, // 0.1%
            ...config
        };
        
        // Order books by pair
        this.orderBooks = new Map();
        
        // Batch queues
        this.pendingOrders = [];
        this.pendingCancellations = [];
        
        // Order pool for memory efficiency
        this.orderPool = new OrderMemoryPool({
            initialSize: 10000,
            maxSize: 100000
        });
        
        // Matching statistics
        this.stats = {
            totalOrders: 0,
            totalMatches: 0,
            totalVolume: 0,
            batchesProcessed: 0,
            averageMatchTime: 0,
            lastBatchSize: 0,
            lastBatchTime: 0
        };
        
        // Start batch processor
        this.startBatchProcessor();
    }
    
    /**
     * Submit order to batch queue
     */
    submitOrder(orderData) {
        // Validate order
        const validation = this.validateOrder(orderData);
        if (!validation.valid) {
            throw new Error(validation.error);
        }
        
        // Get order from pool
        const order = this.orderPool.acquire(orderData);
        
        // Add to pending queue
        this.pendingOrders.push(order);
        
        // Process immediately if batch is full
        if (this.pendingOrders.length >= this.config.batchSize) {
            this.processBatch();
        }
        
        return order;
    }
    
    /**
     * Cancel order
     */
    cancelOrder(orderId, userId) {
        this.pendingCancellations.push({ orderId, userId });
        
        // Process immediately if many cancellations
        if (this.pendingCancellations.length >= 100) {
            this.processCancellations();
        }
    }
    
    /**
     * Process batch of orders
     */
    async processBatch() {
        if (this.pendingOrders.length === 0) return;
        
        const startTime = Date.now();
        const orders = this.pendingOrders.splice(0, this.config.batchSize);
        
        // Process cancellations first
        this.processCancellations();
        
        // Group orders by pair
        const ordersByPair = this.groupOrdersByPair(orders);
        
        // Match orders for each pair
        const allMatches = [];
        
        for (const [pair, pairOrders] of ordersByPair) {
            const matches = this.matchOrdersForPair(pair, pairOrders);
            allMatches.push(...matches);
        }
        
        // Execute matches
        await this.executeMatches(allMatches);
        
        // Update statistics
        const processingTime = Date.now() - startTime;
        this.updateStats(orders.length, allMatches.length, processingTime);
        
        // Emit batch complete event
        this.emit('batch:processed', {
            ordersCount: orders.length,
            matchesCount: allMatches.length,
            processingTime,
            timestamp: Date.now()
        });
        
        logger.debug(`Batch processed: ${orders.length} orders, ${allMatches.length} matches in ${processingTime}ms`);
    }
    
    /**
     * Process cancellations
     */
    processCancellations() {
        if (this.pendingCancellations.length === 0) return;
        
        const cancellations = this.pendingCancellations.splice(0);
        
        for (const { orderId, userId } of cancellations) {
            // Find order in all order books
            for (const [pair, orderBook] of this.orderBooks) {
                const order = orderBook.orders.get(orderId);
                
                if (order && order.userId === userId) {
                    this.removeOrderFromBook(orderBook, order);
                    order.status = 'cancelled';
                    
                    this.emit('order:cancelled', {
                        order,
                        timestamp: Date.now()
                    });
                    
                    // Return to pool
                    this.orderPool.release(order);
                    break;
                }
            }
        }
    }
    
    /**
     * Group orders by trading pair
     */
    groupOrdersByPair(orders) {
        const grouped = new Map();
        
        for (const order of orders) {
            if (!grouped.has(order.pair)) {
                grouped.set(order.pair, []);
            }
            grouped.get(order.pair).push(order);
        }
        
        return grouped;
    }
    
    /**
     * Match orders for a specific pair
     */
    matchOrdersForPair(pair, newOrders) {
        // Get or create order book
        let orderBook = this.orderBooks.get(pair);
        if (!orderBook) {
            orderBook = this.createOrderBook(pair);
            this.orderBooks.set(pair, orderBook);
        }
        
        const matches = [];
        
        // Sort new orders by price-time priority
        const sortedOrders = this.sortOrdersForMatching(newOrders);
        
        // Process each order
        for (const order of sortedOrders) {
            if (order.type === 'market') {
                // Market orders match immediately
                const orderMatches = this.matchMarketOrder(orderBook, order);
                matches.push(...orderMatches);
            } else if (order.type === 'limit') {
                // Limit orders may match or rest in book
                const orderMatches = this.matchLimitOrder(orderBook, order);
                matches.push(...orderMatches);
                
                // Add to book if not fully filled
                if (order.remaining > 0 && !OrderFlagHelpers.isIOC(order)) {
                    this.addOrderToBook(orderBook, order);
                }
            }
        }
        
        return matches;
    }
    
    /**
     * Match market order
     */
    matchMarketOrder(orderBook, takerOrder) {
        const matches = [];
        const oppositeSide = takerOrder.side === 'buy' ? 'sell' : 'buy';
        const levels = orderBook[oppositeSide];
        
        // Match against opposite side
        for (const [price, orders] of levels) {
            if (takerOrder.remaining <= 0) break;
            
            // Check price deviation for market orders
            if (this.exceedsMaxDeviation(takerOrder, price)) {
                break;
            }
            
            for (let i = 0; i < orders.length && takerOrder.remaining > 0; i++) {
                const makerOrder = orders[i];
                
                if (makerOrder.remaining <= 0) continue;
                
                // Calculate match quantity
                const matchQty = Math.min(takerOrder.remaining, makerOrder.remaining);
                
                // Create match
                const match = {
                    id: this.generateMatchId(),
                    pair: takerOrder.pair,
                    price: price,
                    quantity: matchQty,
                    takerOrder: takerOrder,
                    makerOrder: makerOrder,
                    takerFee: matchQty * price * this.config.feeRate,
                    makerFee: matchQty * price * this.config.feeRate * 0.5, // Maker rebate
                    timestamp: Date.now()
                };
                
                // Update orders
                this.updateOrderAfterMatch(takerOrder, match);
                this.updateOrderAfterMatch(makerOrder, match);
                
                matches.push(match);
                
                // Remove filled maker order
                if (makerOrder.remaining <= 0) {
                    orders.splice(i, 1);
                    i--;
                }
            }
            
            // Remove empty price level
            if (orders.length === 0) {
                levels.delete(price);
            }
        }
        
        return matches;
    }
    
    /**
     * Match limit order
     */
    matchLimitOrder(orderBook, takerOrder) {
        const matches = [];
        const oppositeSide = takerOrder.side === 'buy' ? 'sell' : 'buy';
        const levels = orderBook[oppositeSide];
        
        // Determine if order can match
        const canMatch = takerOrder.side === 'buy' 
            ? (price) => price <= takerOrder.price
            : (price) => price >= takerOrder.price;
        
        // Get sorted price levels
        const sortedLevels = Array.from(levels.entries()).sort((a, b) => 
            takerOrder.side === 'buy' ? a[0] - b[0] : b[0] - a[0]
        );
        
        // Match against opposite side
        for (const [price, orders] of sortedLevels) {
            if (takerOrder.remaining <= 0) break;
            if (!canMatch(price)) break;
            
            for (let i = 0; i < orders.length && takerOrder.remaining > 0; i++) {
                const makerOrder = orders[i];
                
                if (makerOrder.remaining <= 0) continue;
                
                // Skip self-match
                if (makerOrder.userId === takerOrder.userId) continue;
                
                // Check post-only
                if (OrderFlagHelpers.isPostOnly(takerOrder) && canMatch(price)) {
                    takerOrder.status = 'rejected';
                    return matches;
                }
                
                // Calculate match quantity
                const matchQty = Math.min(takerOrder.remaining, makerOrder.remaining);
                
                // Create match
                const match = {
                    id: this.generateMatchId(),
                    pair: takerOrder.pair,
                    price: price,
                    quantity: matchQty,
                    takerOrder: takerOrder,
                    makerOrder: makerOrder,
                    takerFee: matchQty * price * this.config.feeRate,
                    makerFee: -matchQty * price * this.config.feeRate * 0.5, // Negative for rebate
                    timestamp: Date.now()
                };
                
                // Update orders
                this.updateOrderAfterMatch(takerOrder, match);
                this.updateOrderAfterMatch(makerOrder, match);
                
                matches.push(match);
                
                // Remove filled maker order
                if (makerOrder.remaining <= 0) {
                    orders.splice(i, 1);
                    i--;
                }
            }
            
            // Remove empty price level
            if (orders.length === 0) {
                levels.delete(price);
            }
        }
        
        return matches;
    }
    
    /**
     * Execute matches
     */
    async executeMatches(matches) {
        // Group matches by user for batch notification
        const matchesByUser = new Map();
        
        for (const match of matches) {
            // Record match
            this.recordMatch(match);
            
            // Group by taker
            if (!matchesByUser.has(match.takerOrder.userId)) {
                matchesByUser.set(match.takerOrder.userId, []);
            }
            matchesByUser.get(match.takerOrder.userId).push({
                ...match,
                side: match.takerOrder.side,
                role: 'taker'
            });
            
            // Group by maker
            if (!matchesByUser.has(match.makerOrder.userId)) {
                matchesByUser.set(match.makerOrder.userId, []);
            }
            matchesByUser.get(match.makerOrder.userId).push({
                ...match,
                side: match.makerOrder.side,
                role: 'maker'
            });
        }
        
        // Emit batch notifications
        for (const [userId, userMatches] of matchesByUser) {
            this.emit('user:matches', {
                userId,
                matches: userMatches,
                timestamp: Date.now()
            });
        }
        
        // Emit market data update
        if (matches.length > 0) {
            const pairs = new Set(matches.map(m => m.pair));
            for (const pair of pairs) {
                this.emit('market:update', {
                    pair,
                    orderBook: this.getOrderBookSnapshot(pair),
                    timestamp: Date.now()
                });
            }
        }
    }
    
    /**
     * Helper methods
     */
    
    createOrderBook(pair) {
        return {
            pair,
            buy: new Map(), // price -> orders[]
            sell: new Map(), // price -> orders[]
            orders: new Map(), // orderId -> order
            lastPrice: 0,
            lastUpdate: Date.now()
        };
    }
    
    sortOrdersForMatching(orders) {
        // Price-time priority
        return orders.sort((a, b) => {
            // Market orders first
            if (a.type === 'market' && b.type !== 'market') return -1;
            if (b.type === 'market' && a.type !== 'market') return 1;
            
            // Then by price (aggressive orders first)
            if (a.side === 'buy') {
                if (a.price !== b.price) return b.price - a.price;
            } else {
                if (a.price !== b.price) return a.price - b.price;
            }
            
            // Then by time
            return a.createdAt - b.createdAt;
        });
    }
    
    addOrderToBook(orderBook, order) {
        const side = orderBook[order.side];
        
        if (!side.has(order.price)) {
            side.set(order.price, []);
        }
        
        side.get(order.price).push(order);
        orderBook.orders.set(order.id, order);
    }
    
    removeOrderFromBook(orderBook, order) {
        const side = orderBook[order.side];
        const orders = side.get(order.price);
        
        if (orders) {
            const index = orders.indexOf(order);
            if (index > -1) {
                orders.splice(index, 1);
            }
            
            if (orders.length === 0) {
                side.delete(order.price);
            }
        }
        
        orderBook.orders.delete(order.id);
    }
    
    updateOrderAfterMatch(order, match) {
        order.filled += match.quantity;
        order.remaining -= match.quantity;
        order.updatedAt = Date.now();
        
        if (order.remaining <= 0) {
            order.status = 'filled';
        } else {
            order.status = 'partial';
        }
        
        // Update average price
        if (order.averagePrice === 0) {
            order.averagePrice = match.price;
        } else {
            const totalValue = (order.filled - match.quantity) * order.averagePrice + match.quantity * match.price;
            order.averagePrice = totalValue / order.filled;
        }
        
        // Add to fills
        order.fills.push({
            matchId: match.id,
            price: match.price,
            quantity: match.quantity,
            fee: order === match.takerOrder ? match.takerFee : match.makerFee,
            timestamp: match.timestamp
        });
    }
    
    recordMatch(match) {
        // Update last price
        const orderBook = this.orderBooks.get(match.pair);
        if (orderBook) {
            orderBook.lastPrice = match.price;
            orderBook.lastUpdate = match.timestamp;
        }
        
        // Update stats
        this.stats.totalMatches++;
        this.stats.totalVolume += match.quantity * match.price;
    }
    
    exceedsMaxDeviation(order, price) {
        if (order.referencePrice) {
            const deviation = Math.abs(price - order.referencePrice) / order.referencePrice;
            return deviation > this.config.maxPriceDeviation;
        }
        return false;
    }
    
    validateOrder(order) {
        if (!order.pair || !order.side || !order.type) {
            return { valid: false, error: 'Missing required fields' };
        }
        
        if (order.quantity <= 0) {
            return { valid: false, error: 'Invalid quantity' };
        }
        
        if (order.type === 'limit' && order.price <= 0) {
            return { valid: false, error: 'Invalid price' };
        }
        
        const orderValue = order.quantity * (order.price || order.referencePrice || 1);
        if (orderValue < this.config.minOrderValue) {
            return { valid: false, error: `Minimum order value is ${this.config.minOrderValue}` };
        }
        
        return { valid: true };
    }
    
    generateMatchId() {
        return `MATCH${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    getOrderBookSnapshot(pair) {
        const orderBook = this.orderBooks.get(pair);
        if (!orderBook) return null;
        
        // Get top levels
        const snapshot = {
            pair,
            bids: [],
            asks: [],
            lastPrice: orderBook.lastPrice,
            timestamp: Date.now()
        };
        
        // Get sorted bids
        const bids = Array.from(orderBook.buy.entries())
            .sort((a, b) => b[0] - a[0])
            .slice(0, 20);
        
        for (const [price, orders] of bids) {
            const quantity = orders.reduce((sum, o) => sum + o.remaining, 0);
            snapshot.bids.push([price, quantity]);
        }
        
        // Get sorted asks
        const asks = Array.from(orderBook.sell.entries())
            .sort((a, b) => a[0] - b[0])
            .slice(0, 20);
        
        for (const [price, orders] of asks) {
            const quantity = orders.reduce((sum, o) => sum + o.remaining, 0);
            snapshot.asks.push([price, quantity]);
        }
        
        return snapshot;
    }
    
    updateStats(orderCount, matchCount, processingTime) {
        this.stats.batchesProcessed++;
        this.stats.totalOrders += orderCount;
        this.stats.lastBatchSize = orderCount;
        this.stats.lastBatchTime = processingTime;
        
        // Update average match time
        const totalTime = this.stats.averageMatchTime * (this.stats.batchesProcessed - 1) + processingTime;
        this.stats.averageMatchTime = totalTime / this.stats.batchesProcessed;
    }
    
    /**
     * Start batch processor
     */
    startBatchProcessor() {
        this.batchInterval = setInterval(() => {
            this.processBatch();
        }, this.config.batchInterval);
        
        logger.info(`Batch matching engine started with ${this.config.batchInterval}ms interval`);
    }
    
    /**
     * Stop batch processor
     */
    stop() {
        if (this.batchInterval) {
            clearInterval(this.batchInterval);
            this.batchInterval = null;
        }
        
        // Process remaining orders
        this.processBatch();
        this.processCancellations();
        
        logger.info('Batch matching engine stopped');
    }
    
    /**
     * Get engine statistics
     */
    getStats() {
        return {
            ...this.stats,
            poolStats: this.orderPool.getStats(),
            orderBookCount: this.orderBooks.size,
            pendingOrders: this.pendingOrders.length,
            pendingCancellations: this.pendingCancellations.length
        };
    }
}

export default BatchMatchingEngine;