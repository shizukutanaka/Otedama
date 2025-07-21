/**
 * Zero-Copy Order Book for Otedama DEX
 * 
 * High-performance order book with minimal memory allocation
 * Following John Carmack's performance principles
 */

import { EventEmitter } from 'events';
import { globalBufferPool } from '../performance/buffer-pool.js';
import { zeroCopyProtocol } from '../performance/zero-copy-protocol.js';

/**
 * Fixed-size order structure for zero-copy operations
 */
const ORDER_SIZE = 64; // bytes per order
const ORDER_FIELDS = {
    ID: 0,        // 16 bytes - UUID
    TIMESTAMP: 16, // 8 bytes
    PRICE: 24,     // 8 bytes (fixed point)
    QUANTITY: 32,  // 8 bytes (fixed point)
    FILLED: 40,    // 8 bytes (fixed point)
    TYPE: 48,      // 1 byte
    SIDE: 49,      // 1 byte
    STATUS: 50,    // 1 byte
    FLAGS: 51,     // 1 byte
    USER_ID: 52    // 12 bytes
};

/**
 * Zero-copy order book implementation
 */
export class ZeroCopyOrderBook extends EventEmitter {
    constructor(pair, config = {}) {
        super();
        
        this.pair = pair;
        this.config = {
            maxOrders: config.maxOrders || 100000,
            priceTickSize: config.priceTickSize || 0.01,
            quantityTickSize: config.quantityTickSize || 0.0001,
            preallocateDepth: config.preallocateDepth || 1000,
            ...config
        };
        
        // Pre-allocated order storage
        this.orderBuffer = Buffer.allocUnsafe(this.config.maxOrders * ORDER_SIZE);
        this.nextOrderSlot = 0;
        this.orderCount = 0;
        
        // Order index maps (ID -> slot)
        this.orderIndex = new Map();
        this.freeSlots = [];
        
        // Price level indices using typed arrays for performance
        this.buyLevels = new Map();  // price -> Set of order slots
        this.sellLevels = new Map(); // price -> Set of order slots
        
        // Pre-allocated arrays for order matching
        this.matchBuffer = new Uint32Array(1000);
        this.tempOrderBuffer = Buffer.allocUnsafe(ORDER_SIZE);
        
        // Statistics
        this.stats = {
            totalOrders: 0,
            activeOrders: 0,
            totalVolume: 0,
            allocations: 0,
            zerocopySaves: 0
        };
        
        // Price/quantity conversion multipliers
        this.priceMult = Math.pow(10, 8); // 8 decimal places
        this.quantityMult = Math.pow(10, 8);
    }
    
    /**
     * Add order with zero-copy
     */
    addOrder(order) {
        // Get free slot
        const slot = this.getFreeSlot();
        if (slot === -1) {
            throw new Error('Order book full');
        }
        
        // Write order data directly to buffer
        const offset = slot * ORDER_SIZE;
        
        // Write order ID (16 bytes)
        const idBuffer = Buffer.from(order.id.replace(/-/g, ''), 'hex');
        idBuffer.copy(this.orderBuffer, offset + ORDER_FIELDS.ID);
        
        // Write timestamp
        this.orderBuffer.writeBigInt64BE(BigInt(order.timestamp || Date.now()), 
            offset + ORDER_FIELDS.TIMESTAMP);
        
        // Write price (fixed point)
        const priceFixed = Math.floor(order.price * this.priceMult);
        this.orderBuffer.writeBigInt64BE(BigInt(priceFixed), 
            offset + ORDER_FIELDS.PRICE);
        
        // Write quantity
        const quantityFixed = Math.floor(order.quantity * this.quantityMult);
        this.orderBuffer.writeBigInt64BE(BigInt(quantityFixed), 
            offset + ORDER_FIELDS.QUANTITY);
        
        // Write filled amount (initially 0)
        this.orderBuffer.writeBigInt64BE(0n, offset + ORDER_FIELDS.FILLED);
        
        // Write type (0=limit, 1=market)
        this.orderBuffer[offset + ORDER_FIELDS.TYPE] = 
            order.type === 'market' ? 1 : 0;
        
        // Write side (0=buy, 1=sell)
        this.orderBuffer[offset + ORDER_FIELDS.SIDE] = 
            order.side === 'buy' ? 0 : 1;
        
        // Write status (0=active)
        this.orderBuffer[offset + ORDER_FIELDS.STATUS] = 0;
        
        // Write flags
        this.orderBuffer[offset + ORDER_FIELDS.FLAGS] = 0;
        
        // Write user ID (truncated to 12 bytes)
        const userIdBuffer = Buffer.from(order.userId || '');
        userIdBuffer.copy(this.orderBuffer, offset + ORDER_FIELDS.USER_ID, 0, 12);
        
        // Update indices
        this.orderIndex.set(order.id, slot);
        
        // Add to price level
        if (order.type === 'limit') {
            const priceKey = this.normalizePrice(order.price);
            const levels = order.side === 'buy' ? this.buyLevels : this.sellLevels;
            
            if (!levels.has(priceKey)) {
                levels.set(priceKey, new Set());
            }
            levels.get(priceKey).add(slot);
        }
        
        // Update stats
        this.stats.totalOrders++;
        this.stats.activeOrders++;
        this.orderCount++;
        
        // Emit event
        this.emit('order:added', this.readOrder(slot));
        
        return slot;
    }
    
    /**
     * Match orders with zero-copy
     */
    matchOrders(incomingOrder) {
        const trades = [];
        const incomingSide = incomingOrder.side;
        const oppositeSide = incomingSide === 'buy' ? 'sell' : 'buy';
        const levels = incomingSide === 'buy' ? this.sellLevels : this.buyLevels;
        
        let remainingQuantity = incomingOrder.quantity;
        
        // Get sorted price levels
        const sortedLevels = Array.from(levels.keys()).sort((a, b) => 
            incomingSide === 'buy' ? a - b : b - a
        );
        
        for (const priceLevel of sortedLevels) {
            // Check price compatibility
            if (incomingOrder.type === 'limit') {
                if (incomingSide === 'buy' && priceLevel > incomingOrder.price) break;
                if (incomingSide === 'sell' && priceLevel < incomingOrder.price) break;
            }
            
            const orderSlots = levels.get(priceLevel);
            const slotsToRemove = [];
            
            for (const slot of orderSlots) {
                const offset = slot * ORDER_SIZE;
                
                // Read order data directly from buffer
                const orderQuantity = this.readQuantity(slot);
                const orderFilled = this.readFilled(slot);
                const availableQuantity = orderQuantity - orderFilled;
                
                if (availableQuantity <= 0) {
                    slotsToRemove.push(slot);
                    continue;
                }
                
                // Calculate trade quantity
                const tradeQuantity = Math.min(remainingQuantity, availableQuantity);
                
                // Update filled amount in-place
                const newFilled = orderFilled + tradeQuantity;
                this.orderBuffer.writeBigInt64BE(
                    BigInt(Math.floor(newFilled * this.quantityMult)),
                    offset + ORDER_FIELDS.FILLED
                );
                
                // Create trade record
                const trade = {
                    id: this.generateTradeId(),
                    timestamp: Date.now(),
                    pair: this.pair,
                    price: priceLevel / this.priceMult,
                    quantity: tradeQuantity,
                    makerOrderId: this.readOrderId(slot),
                    takerOrderId: incomingOrder.id,
                    makerSide: oppositeSide,
                    takerSide: incomingSide
                };
                
                trades.push(trade);
                
                // Update remaining quantity
                remainingQuantity -= tradeQuantity;
                
                // Check if order is filled
                if (newFilled >= orderQuantity) {
                    this.orderBuffer[offset + ORDER_FIELDS.STATUS] = 2; // filled
                    slotsToRemove.push(slot);
                }
                
                // Update stats
                this.stats.totalVolume += tradeQuantity;
                this.stats.zerocopySaves++;
                
                if (remainingQuantity <= 0) break;
            }
            
            // Remove filled orders from level
            for (const slot of slotsToRemove) {
                orderSlots.delete(slot);
                this.removeOrderFromIndex(slot);
            }
            
            // Remove empty level
            if (orderSlots.size === 0) {
                levels.delete(priceLevel);
            }
            
            if (remainingQuantity <= 0) break;
        }
        
        return {
            trades,
            remainingQuantity,
            filledQuantity: incomingOrder.quantity - remainingQuantity
        };
    }
    
    /**
     * Cancel order with zero-copy
     */
    cancelOrder(orderId) {
        const slot = this.orderIndex.get(orderId);
        if (slot === undefined) {
            return false;
        }
        
        const offset = slot * ORDER_SIZE;
        
        // Mark as cancelled
        this.orderBuffer[offset + ORDER_FIELDS.STATUS] = 3; // cancelled
        
        // Remove from price level
        const price = this.readPrice(slot);
        const side = this.orderBuffer[offset + ORDER_FIELDS.SIDE];
        const levels = side === 0 ? this.buyLevels : this.sellLevels;
        const priceKey = this.normalizePrice(price);
        
        if (levels.has(priceKey)) {
            levels.get(priceKey).delete(slot);
            if (levels.get(priceKey).size === 0) {
                levels.delete(priceKey);
            }
        }
        
        // Remove from index
        this.removeOrderFromIndex(slot);
        
        // Update stats
        this.stats.activeOrders--;
        
        this.emit('order:cancelled', orderId);
        
        return true;
    }
    
    /**
     * Get order book depth with zero-copy
     */
    getDepth(levels = 10) {
        const depth = {
            bids: [],
            asks: []
        };
        
        // Process buy levels
        const sortedBuyLevels = Array.from(this.buyLevels.keys())
            .sort((a, b) => b - a)
            .slice(0, levels);
        
        for (const priceLevel of sortedBuyLevels) {
            const slots = this.buyLevels.get(priceLevel);
            let totalQuantity = 0;
            let orderCount = 0;
            
            for (const slot of slots) {
                const quantity = this.readQuantity(slot);
                const filled = this.readFilled(slot);
                totalQuantity += quantity - filled;
                orderCount++;
            }
            
            depth.bids.push({
                price: priceLevel / this.priceMult,
                quantity: totalQuantity,
                orders: orderCount
            });
        }
        
        // Process sell levels
        const sortedSellLevels = Array.from(this.sellLevels.keys())
            .sort((a, b) => a - b)
            .slice(0, levels);
        
        for (const priceLevel of sortedSellLevels) {
            const slots = this.sellLevels.get(priceLevel);
            let totalQuantity = 0;
            let orderCount = 0;
            
            for (const slot of slots) {
                const quantity = this.readQuantity(slot);
                const filled = this.readFilled(slot);
                totalQuantity += quantity - filled;
                orderCount++;
            }
            
            depth.asks.push({
                price: priceLevel / this.priceMult,
                quantity: totalQuantity,
                orders: orderCount
            });
        }
        
        return depth;
    }
    
    /**
     * Serialize order book state (zero-copy)
     */
    serialize() {
        const buffer = globalBufferPool.allocate(
            4 + 4 + this.orderCount * ORDER_SIZE
        );
        
        let offset = 0;
        
        // Write header
        buffer.writeUInt32BE(this.orderCount, offset);
        offset += 4;
        
        buffer.writeUInt32BE(ORDER_SIZE, offset);
        offset += 4;
        
        // Copy active orders
        for (const [orderId, slot] of this.orderIndex) {
            const srcOffset = slot * ORDER_SIZE;
            this.orderBuffer.copy(
                buffer,
                offset,
                srcOffset,
                srcOffset + ORDER_SIZE
            );
            offset += ORDER_SIZE;
        }
        
        return buffer.slice(0, offset);
    }
    
    /**
     * Helper methods for reading order fields
     */
    readOrderId(slot) {
        const offset = slot * ORDER_SIZE + ORDER_FIELDS.ID;
        const idBuffer = this.orderBuffer.slice(offset, offset + 16);
        
        // Convert to UUID string
        const hex = idBuffer.toString('hex');
        return `${hex.substr(0,8)}-${hex.substr(8,4)}-${hex.substr(12,4)}-${hex.substr(16,4)}-${hex.substr(20,12)}`;
    }
    
    readPrice(slot) {
        const offset = slot * ORDER_SIZE + ORDER_FIELDS.PRICE;
        const priceFixed = this.orderBuffer.readBigInt64BE(offset);
        return Number(priceFixed) / this.priceMult;
    }
    
    readQuantity(slot) {
        const offset = slot * ORDER_SIZE + ORDER_FIELDS.QUANTITY;
        const quantityFixed = this.orderBuffer.readBigInt64BE(offset);
        return Number(quantityFixed) / this.quantityMult;
    }
    
    readFilled(slot) {
        const offset = slot * ORDER_SIZE + ORDER_FIELDS.FILLED;
        const filledFixed = this.orderBuffer.readBigInt64BE(offset);
        return Number(filledFixed) / this.quantityMult;
    }
    
    readOrder(slot) {
        const offset = slot * ORDER_SIZE;
        
        return {
            id: this.readOrderId(slot),
            timestamp: Number(this.orderBuffer.readBigInt64BE(offset + ORDER_FIELDS.TIMESTAMP)),
            price: this.readPrice(slot),
            quantity: this.readQuantity(slot),
            filled: this.readFilled(slot),
            type: this.orderBuffer[offset + ORDER_FIELDS.TYPE] === 1 ? 'market' : 'limit',
            side: this.orderBuffer[offset + ORDER_FIELDS.SIDE] === 0 ? 'buy' : 'sell',
            status: ['active', 'partial', 'filled', 'cancelled'][this.orderBuffer[offset + ORDER_FIELDS.STATUS]],
            pair: this.pair
        };
    }
    
    /**
     * Get free slot for new order
     */
    getFreeSlot() {
        if (this.freeSlots.length > 0) {
            return this.freeSlots.pop();
        }
        
        if (this.nextOrderSlot < this.config.maxOrders) {
            return this.nextOrderSlot++;
        }
        
        return -1; // No free slots
    }
    
    /**
     * Remove order from index
     */
    removeOrderFromIndex(slot) {
        const orderId = this.readOrderId(slot);
        this.orderIndex.delete(orderId);
        this.freeSlots.push(slot);
        this.orderCount--;
    }
    
    /**
     * Normalize price to tick size
     */
    normalizePrice(price) {
        return Math.round(price / this.config.priceTickSize) * 
               this.config.priceTickSize * this.priceMult;
    }
    
    /**
     * Generate trade ID
     */
    generateTradeId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            memoryUsage: this.orderBuffer.length,
            slotUtilization: this.orderCount / this.config.maxOrders,
            buyLevels: this.buyLevels.size,
            sellLevels: this.sellLevels.size
        };
    }
}

export default ZeroCopyOrderBook;