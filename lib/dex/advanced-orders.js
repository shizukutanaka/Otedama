/**
 * Advanced Order Types for Otedama DEX
 * OCO (One-Cancels-Other), Iceberg, and other advanced orders
 * 
 * Design principles:
 * - Efficient order management (Carmack)
 * - Clean order abstractions (Martin)
 * - Simple advanced features (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import crypto from 'crypto';

export class AdvancedOrderManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Iceberg settings
            minIcebergSize: config.minIcebergSize || 1000, // Min total size
            defaultChunkSize: config.defaultChunkSize || 100, // Default visible size
            maxChunkRatio: config.maxChunkRatio || 0.1, // Max 10% visible
            
            // OCO settings
            ocoExpiryTime: config.ocoExpiryTime || 86400000, // 24 hours
            maxOcoOrders: config.maxOcoOrders || 1000, // Max active OCOs
            
            // Bracket settings
            defaultTakeProfitRatio: config.defaultTakeProfitRatio || 0.02, // 2%
            defaultStopLossRatio: config.defaultStopLossRatio || 0.01, // 1%
            
            // Stop order settings
            stopOrderBuffer: config.stopOrderBuffer || 0.001, // 0.1% buffer
            maxStopOrders: config.maxStopOrders || 10000,
            
            // TWAP/VWAP settings
            twapInterval: config.twapInterval || 60000, // 1 minute
            maxTwapDuration: config.maxTwapDuration || 86400000, // 24 hours
            
            ...config
        };
        
        // Order storage
        this.icebergOrders = new Map(); // orderId -> iceberg data
        this.ocoOrders = new Map(); // groupId -> OCO group
        this.bracketOrders = new Map(); // orderId -> bracket data
        this.stopOrders = new Map(); // orderId -> stop order
        this.twapOrders = new Map(); // orderId -> TWAP data
        
        // Price triggers
        this.priceWatchers = new Map(); // pair -> price watchers
        
        // Statistics
        this.stats = {
            icebergOrders: 0,
            ocoOrders: 0,
            bracketOrders: 0,
            stopOrders: 0,
            twapOrders: 0,
            triggeredOrders: 0,
            cancelledOrders: 0
        };
        
        // Start monitoring
        this.startOrderMonitoring();
    }
    
    /**
     * Create Iceberg Order
     * Shows only a portion of the total order size
     */
    async createIcebergOrder(params) {
        const {
            pair,
            side,
            totalQuantity,
            price,
            visibleQuantity,
            userId,
            minQuantity
        } = params;
        
        // Validate
        if (totalQuantity < this.config.minIcebergSize) {
            throw new Error(`Minimum iceberg size is ${this.config.minIcebergSize}`);
        }
        
        const chunkSize = visibleQuantity || 
            Math.min(totalQuantity * this.config.maxChunkRatio, this.config.defaultChunkSize);
        
        if (chunkSize > totalQuantity * this.config.maxChunkRatio) {
            throw new Error('Visible quantity too large for iceberg order');
        }
        
        // Create iceberg order
        const icebergId = this.generateOrderId('ICE');
        const iceberg = {
            id: icebergId,
            pair,
            side,
            price,
            userId,
            totalQuantity,
            remainingQuantity: totalQuantity,
            chunkSize,
            minQuantity: minQuantity || chunkSize,
            activeOrderId: null,
            executedQuantity: 0,
            averagePrice: 0,
            status: 'active',
            createdAt: Date.now(),
            chunks: []
        };
        
        // Store iceberg
        this.icebergOrders.set(icebergId, iceberg);
        this.stats.icebergOrders++;
        
        // Create first chunk
        await this.createIcebergChunk(iceberg);
        
        logger.info(`Iceberg order created: ${icebergId}, total: ${totalQuantity}, visible: ${chunkSize}`);
        
        this.emit('iceberg:created', {
            iceberg,
            timestamp: Date.now()
        });
        
        return iceberg;
    }
    
    /**
     * Create chunk for iceberg order
     */
    async createIcebergChunk(iceberg) {
        if (iceberg.remainingQuantity <= 0) {
            iceberg.status = 'completed';
            return null;
        }
        
        // Calculate chunk size
        const chunkQuantity = Math.min(iceberg.chunkSize, iceberg.remainingQuantity);
        
        // Create regular order for chunk
        const chunkOrder = {
            id: this.generateOrderId('CHK'),
            pair: iceberg.pair,
            side: iceberg.side,
            type: 'limit',
            price: iceberg.price,
            quantity: chunkQuantity,
            userId: iceberg.userId,
            metadata: {
                icebergId: iceberg.id,
                isIcebergChunk: true
            }
        };
        
        iceberg.activeOrderId = chunkOrder.id;
        iceberg.chunks.push({
            orderId: chunkOrder.id,
            quantity: chunkQuantity,
            status: 'active',
            createdAt: Date.now()
        });
        
        // Emit for execution
        this.emit('order:submit', chunkOrder);
        
        return chunkOrder;
    }
    
    /**
     * Create OCO (One-Cancels-Other) Order
     */
    async createOCOOrder(params) {
        const { orders, userId } = params;
        
        if (!orders || orders.length !== 2) {
            throw new Error('OCO requires exactly 2 orders');
        }
        
        // Validate orders
        const [order1, order2] = orders;
        if (order1.pair !== order2.pair) {
            throw new Error('OCO orders must be for the same pair');
        }
        
        // Create OCO group
        const ocoId = this.generateOrderId('OCO');
        const ocoGroup = {
            id: ocoId,
            userId,
            pair: order1.pair,
            orders: [],
            status: 'active',
            triggeredOrderId: null,
            cancelledOrderId: null,
            createdAt: Date.now(),
            expiresAt: Date.now() + this.config.ocoExpiryTime
        };
        
        // Create individual orders
        for (const orderData of orders) {
            const order = {
                ...orderData,
                id: this.generateOrderId('ORD'),
                metadata: {
                    ...orderData.metadata,
                    ocoGroupId: ocoId,
                    isOCO: true
                }
            };
            
            ocoGroup.orders.push(order);
            
            // Submit order
            this.emit('order:submit', order);
        }
        
        // Store OCO group
        this.ocoOrders.set(ocoId, ocoGroup);
        this.stats.ocoOrders++;
        
        logger.info(`OCO order created: ${ocoId}`);
        
        this.emit('oco:created', {
            ocoGroup,
            timestamp: Date.now()
        });
        
        return ocoGroup;
    }
    
    /**
     * Create Bracket Order
     * Main order with automatic take-profit and stop-loss
     */
    async createBracketOrder(params) {
        const {
            pair,
            side,
            quantity,
            price,
            takeProfitPrice,
            stopLossPrice,
            takeProfitRatio,
            stopLossRatio,
            userId
        } = params;
        
        // Calculate TP/SL prices if not provided
        let tpPrice = takeProfitPrice;
        let slPrice = stopLossPrice;
        
        if (!tpPrice && takeProfitRatio) {
            tpPrice = side === 'buy' 
                ? price * (1 + takeProfitRatio)
                : price * (1 - takeProfitRatio);
        }
        
        if (!slPrice && stopLossRatio) {
            slPrice = side === 'buy'
                ? price * (1 - stopLossRatio)
                : price * (1 + stopLossRatio);
        }
        
        // Use defaults if still not set
        if (!tpPrice) {
            tpPrice = side === 'buy'
                ? price * (1 + this.config.defaultTakeProfitRatio)
                : price * (1 - this.config.defaultTakeProfitRatio);
        }
        
        if (!slPrice) {
            slPrice = side === 'buy'
                ? price * (1 - this.config.defaultStopLossRatio)
                : price * (1 + this.config.defaultStopLossRatio);
        }
        
        // Create bracket order
        const bracketId = this.generateOrderId('BRK');
        const bracket = {
            id: bracketId,
            pair,
            userId,
            mainOrder: null,
            takeProfitOrder: null,
            stopLossOrder: null,
            status: 'pending',
            createdAt: Date.now()
        };
        
        // Create main order
        const mainOrder = {
            id: this.generateOrderId('MAIN'),
            pair,
            side,
            type: 'limit',
            price,
            quantity,
            userId,
            metadata: {
                bracketId,
                isBracketMain: true
            }
        };
        
        bracket.mainOrder = mainOrder;
        
        // Prepare TP/SL orders (will be created after main fills)
        bracket.takeProfitPrice = tpPrice;
        bracket.stopLossPrice = slPrice;
        bracket.quantity = quantity;
        bracket.side = side;
        
        // Store bracket
        this.bracketOrders.set(bracketId, bracket);
        this.stats.bracketOrders++;
        
        // Submit main order
        this.emit('order:submit', mainOrder);
        
        logger.info(`Bracket order created: ${bracketId}, TP: ${tpPrice}, SL: ${slPrice}`);
        
        this.emit('bracket:created', {
            bracket,
            timestamp: Date.now()
        });
        
        return bracket;
    }
    
    /**
     * Create Stop Order
     * Triggers market/limit order when price reaches stop price
     */
    async createStopOrder(params) {
        const {
            pair,
            side,
            quantity,
            stopPrice,
            limitPrice, // Optional, for stop-limit
            triggerType = 'last', // last, mark, index
            userId
        } = params;
        
        const stopId = this.generateOrderId('STP');
        const stopOrder = {
            id: stopId,
            pair,
            side,
            quantity,
            stopPrice,
            limitPrice,
            triggerType,
            userId,
            status: 'pending',
            triggered: false,
            triggeredAt: null,
            resultOrderId: null,
            createdAt: Date.now()
        };
        
        // Add to stop orders
        this.stopOrders.set(stopId, stopOrder);
        
        // Add price watcher
        this.addPriceWatcher(pair, stopPrice, stopId, 'stop');
        
        this.stats.stopOrders++;
        
        logger.info(`Stop order created: ${stopId}, stop: ${stopPrice}`);
        
        this.emit('stop:created', {
            stopOrder,
            timestamp: Date.now()
        });
        
        return stopOrder;
    }
    
    /**
     * Create TWAP Order
     * Time-Weighted Average Price execution
     */
    async createTWAPOrder(params) {
        const {
            pair,
            side,
            totalQuantity,
            duration,
            minChunkSize,
            maxChunkSize,
            randomizeSize = true,
            randomizeTime = true,
            userId
        } = params;
        
        if (duration > this.config.maxTwapDuration) {
            throw new Error(`Maximum TWAP duration is ${this.config.maxTwapDuration}ms`);
        }
        
        const twapId = this.generateOrderId('TWAP');
        const numChunks = Math.ceil(duration / this.config.twapInterval);
        const baseChunkSize = totalQuantity / numChunks;
        
        const twap = {
            id: twapId,
            pair,
            side,
            totalQuantity,
            remainingQuantity: totalQuantity,
            executedQuantity: 0,
            duration,
            numChunks,
            baseChunkSize,
            minChunkSize: minChunkSize || baseChunkSize * 0.5,
            maxChunkSize: maxChunkSize || baseChunkSize * 1.5,
            randomizeSize,
            randomizeTime,
            userId,
            status: 'active',
            chunks: [],
            averagePrice: 0,
            startTime: Date.now(),
            endTime: Date.now() + duration,
            nextExecutionTime: Date.now()
        };
        
        // Store TWAP order
        this.twapOrders.set(twapId, twap);
        this.stats.twapOrders++;
        
        // Start execution
        this.scheduleTWAPExecution(twap);
        
        logger.info(`TWAP order created: ${twapId}, duration: ${duration}ms, chunks: ${numChunks}`);
        
        this.emit('twap:created', {
            twap,
            timestamp: Date.now()
        });
        
        return twap;
    }
    
    /**
     * Handle order fill event
     */
    async handleOrderFill(orderFill) {
        const { orderId, fillQuantity, fillPrice, metadata } = orderFill;
        
        // Check if iceberg chunk
        if (metadata?.isIcebergChunk) {
            await this.handleIcebergFill(metadata.icebergId, fillQuantity, fillPrice);
        }
        
        // Check if OCO order
        if (metadata?.isOCO) {
            await this.handleOCOFill(metadata.ocoGroupId, orderId);
        }
        
        // Check if bracket main order
        if (metadata?.isBracketMain) {
            await this.handleBracketMainFill(metadata.bracketId, fillQuantity);
        }
        
        // Check if bracket TP/SL
        if (metadata?.isBracketTP || metadata?.isBracketSL) {
            await this.handleBracketExitFill(metadata.bracketId, metadata.isBracketTP);
        }
    }
    
    /**
     * Handle iceberg chunk fill
     */
    async handleIcebergFill(icebergId, fillQuantity, fillPrice) {
        const iceberg = this.icebergOrders.get(icebergId);
        if (!iceberg) return;
        
        // Update iceberg stats
        iceberg.executedQuantity += fillQuantity;
        iceberg.remainingQuantity -= fillQuantity;
        
        // Update average price
        if (iceberg.averagePrice === 0) {
            iceberg.averagePrice = fillPrice;
        } else {
            const totalValue = (iceberg.executedQuantity - fillQuantity) * iceberg.averagePrice + fillQuantity * fillPrice;
            iceberg.averagePrice = totalValue / iceberg.executedQuantity;
        }
        
        // Update chunk status
        const currentChunk = iceberg.chunks[iceberg.chunks.length - 1];
        if (currentChunk) {
            currentChunk.executedQuantity = (currentChunk.executedQuantity || 0) + fillQuantity;
        }
        
        // Check if chunk is fully filled
        const chunkRemaining = iceberg.chunkSize - (currentChunk?.executedQuantity || 0);
        if (chunkRemaining <= 0 && iceberg.remainingQuantity > 0) {
            // Create next chunk
            await this.createIcebergChunk(iceberg);
        }
        
        // Check if iceberg is complete
        if (iceberg.remainingQuantity <= 0) {
            iceberg.status = 'completed';
            this.emit('iceberg:completed', {
                iceberg,
                timestamp: Date.now()
            });
        }
    }
    
    /**
     * Handle OCO order fill
     */
    async handleOCOFill(ocoGroupId, filledOrderId) {
        const ocoGroup = this.ocoOrders.get(ocoGroupId);
        if (!ocoGroup || ocoGroup.status !== 'active') return;
        
        // Mark as triggered
        ocoGroup.status = 'triggered';
        ocoGroup.triggeredOrderId = filledOrderId;
        
        // Cancel the other order
        for (const order of ocoGroup.orders) {
            if (order.id !== filledOrderId) {
                ocoGroup.cancelledOrderId = order.id;
                
                // Emit cancellation
                this.emit('order:cancel', {
                    orderId: order.id,
                    reason: 'oco_triggered'
                });
                
                this.stats.cancelledOrders++;
            }
        }
        
        logger.info(`OCO triggered: ${ocoGroupId}, filled: ${filledOrderId}`);
        
        this.emit('oco:triggered', {
            ocoGroup,
            triggeredOrderId: filledOrderId,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle bracket main order fill
     */
    async handleBracketMainFill(bracketId, fillQuantity) {
        const bracket = this.bracketOrders.get(bracketId);
        if (!bracket) return;
        
        bracket.status = 'active';
        
        // Create take profit order
        const tpOrder = {
            id: this.generateOrderId('TP'),
            pair: bracket.pair,
            side: bracket.side === 'buy' ? 'sell' : 'buy',
            type: 'limit',
            price: bracket.takeProfitPrice,
            quantity: fillQuantity,
            userId: bracket.userId,
            metadata: {
                bracketId,
                isBracketTP: true
            }
        };
        
        // Create stop loss order
        const slOrder = {
            id: this.generateOrderId('SL'),
            pair: bracket.pair,
            side: bracket.side === 'buy' ? 'sell' : 'buy',
            stopPrice: bracket.stopLossPrice,
            quantity: fillQuantity,
            userId: bracket.userId,
            metadata: {
                bracketId,
                isBracketSL: true
            }
        };
        
        bracket.takeProfitOrder = tpOrder;
        bracket.stopLossOrder = slOrder;
        
        // Submit orders
        this.emit('order:submit', tpOrder);
        
        // Create stop order for SL
        await this.createStopOrder({
            ...slOrder,
            side: slOrder.side,
            stopPrice: slOrder.stopPrice
        });
        
        logger.info(`Bracket TP/SL created: ${bracketId}`);
        
        this.emit('bracket:active', {
            bracket,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle bracket TP/SL fill
     */
    async handleBracketExitFill(bracketId, isTakeProfit) {
        const bracket = this.bracketOrders.get(bracketId);
        if (!bracket || bracket.status !== 'active') return;
        
        bracket.status = 'completed';
        
        // Cancel the other exit order
        if (isTakeProfit && bracket.stopLossOrder) {
            this.emit('order:cancel', {
                orderId: bracket.stopLossOrder.id,
                reason: 'bracket_tp_filled'
            });
        } else if (!isTakeProfit && bracket.takeProfitOrder) {
            this.emit('order:cancel', {
                orderId: bracket.takeProfitOrder.id,
                reason: 'bracket_sl_filled'
            });
        }
        
        logger.info(`Bracket completed: ${bracketId}, exit: ${isTakeProfit ? 'TP' : 'SL'}`);
        
        this.emit('bracket:completed', {
            bracket,
            exitType: isTakeProfit ? 'take_profit' : 'stop_loss',
            timestamp: Date.now()
        });
    }
    
    /**
     * Price update handler
     */
    async handlePriceUpdate(pair, price, priceType = 'last') {
        const watchers = this.priceWatchers.get(pair);
        if (!watchers) return;
        
        const triggered = [];
        
        for (const watcher of watchers) {
            if (watcher.triggered) continue;
            
            const shouldTrigger = this.checkPriceTrigger(watcher, price);
            if (shouldTrigger) {
                watcher.triggered = true;
                triggered.push(watcher);
            }
        }
        
        // Process triggered orders
        for (const watcher of triggered) {
            if (watcher.type === 'stop') {
                await this.triggerStopOrder(watcher.orderId, price);
            }
        }
        
        // Clean up triggered watchers
        if (triggered.length > 0) {
            const remaining = watchers.filter(w => !w.triggered);
            this.priceWatchers.set(pair, remaining);
        }
    }
    
    /**
     * Trigger stop order
     */
    async triggerStopOrder(stopOrderId, triggerPrice) {
        const stopOrder = this.stopOrders.get(stopOrderId);
        if (!stopOrder || stopOrder.triggered) return;
        
        stopOrder.triggered = true;
        stopOrder.triggeredAt = Date.now();
        stopOrder.status = 'triggered';
        
        // Create market or limit order
        const executionOrder = {
            id: this.generateOrderId('EXEC'),
            pair: stopOrder.pair,
            side: stopOrder.side,
            type: stopOrder.limitPrice ? 'limit' : 'market',
            price: stopOrder.limitPrice,
            quantity: stopOrder.quantity,
            userId: stopOrder.userId,
            metadata: {
                stopOrderId,
                triggerPrice
            }
        };
        
        stopOrder.resultOrderId = executionOrder.id;
        
        // Submit execution order
        this.emit('order:submit', executionOrder);
        
        this.stats.triggeredOrders++;
        
        logger.info(`Stop order triggered: ${stopOrderId} at ${triggerPrice}`);
        
        this.emit('stop:triggered', {
            stopOrder,
            executionOrder,
            triggerPrice,
            timestamp: Date.now()
        });
    }
    
    /**
     * Schedule TWAP execution
     */
    scheduleTWAPExecution(twap) {
        if (twap.status !== 'active' || twap.remainingQuantity <= 0) {
            return;
        }
        
        // Calculate next execution time
        let delay = this.config.twapInterval;
        if (twap.randomizeTime) {
            delay = delay * (0.5 + Math.random());
        }
        
        setTimeout(async () => {
            await this.executeTWAPChunk(twap);
            this.scheduleTWAPExecution(twap);
        }, delay);
    }
    
    /**
     * Execute TWAP chunk
     */
    async executeTWAPChunk(twap) {
        if (twap.status !== 'active' || twap.remainingQuantity <= 0) {
            return;
        }
        
        // Calculate chunk size
        let chunkSize = twap.baseChunkSize;
        if (twap.randomizeSize) {
            const variation = (Math.random() - 0.5) * 2;
            chunkSize = chunkSize * (1 + variation * 0.5);
        }
        
        // Apply limits
        chunkSize = Math.max(twap.minChunkSize, Math.min(twap.maxChunkSize, chunkSize));
        chunkSize = Math.min(chunkSize, twap.remainingQuantity);
        
        // Create order
        const chunkOrder = {
            id: this.generateOrderId('TWAP'),
            pair: twap.pair,
            side: twap.side,
            type: 'market',
            quantity: chunkSize,
            userId: twap.userId,
            metadata: {
                twapId: twap.id,
                chunkIndex: twap.chunks.length
            }
        };
        
        // Record chunk
        twap.chunks.push({
            orderId: chunkOrder.id,
            quantity: chunkSize,
            status: 'pending',
            createdAt: Date.now()
        });
        
        // Update remaining
        twap.remainingQuantity -= chunkSize;
        
        // Submit order
        this.emit('order:submit', chunkOrder);
        
        // Check completion
        if (twap.remainingQuantity <= 0 || Date.now() >= twap.endTime) {
            twap.status = 'completed';
            this.emit('twap:completed', {
                twap,
                timestamp: Date.now()
            });
        }
    }
    
    /**
     * Helper methods
     */
    
    addPriceWatcher(pair, targetPrice, orderId, type) {
        if (!this.priceWatchers.has(pair)) {
            this.priceWatchers.set(pair, []);
        }
        
        this.priceWatchers.get(pair).push({
            targetPrice,
            orderId,
            type,
            triggered: false,
            createdAt: Date.now()
        });
    }
    
    checkPriceTrigger(watcher, currentPrice) {
        // For stop orders, trigger when price crosses threshold
        if (watcher.type === 'stop') {
            const stopOrder = this.stopOrders.get(watcher.orderId);
            if (!stopOrder) return false;
            
            if (stopOrder.side === 'sell') {
                // Stop loss for long position
                return currentPrice <= watcher.targetPrice;
            } else {
                // Stop loss for short position
                return currentPrice >= watcher.targetPrice;
            }
        }
        
        return false;
    }
    
    generateOrderId(prefix) {
        return `${prefix}${Date.now()}${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Start order monitoring
     */
    startOrderMonitoring() {
        // Clean up expired OCO orders
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            
            // Clean OCO orders
            for (const [ocoId, ocoGroup] of this.ocoOrders) {
                if (ocoGroup.status === 'active' && now > ocoGroup.expiresAt) {
                    // Cancel all orders in group
                    for (const order of ocoGroup.orders) {
                        this.emit('order:cancel', {
                            orderId: order.id,
                            reason: 'oco_expired'
                        });
                    }
                    
                    ocoGroup.status = 'expired';
                    this.ocoOrders.delete(ocoId);
                }
            }
            
            // Clean completed orders
            this.cleanupCompletedOrders();
            
        }, 60000); // Every minute
        
        logger.info('Advanced order monitoring started');
    }
    
    cleanupCompletedOrders() {
        // Clean completed icebergs
        for (const [id, iceberg] of this.icebergOrders) {
            if (iceberg.status === 'completed' && Date.now() - iceberg.createdAt > 3600000) {
                this.icebergOrders.delete(id);
            }
        }
        
        // Clean completed brackets
        for (const [id, bracket] of this.bracketOrders) {
            if (bracket.status === 'completed' && Date.now() - bracket.createdAt > 3600000) {
                this.bracketOrders.delete(id);
            }
        }
    }
    
    /**
     * Stop monitoring
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        logger.info('Advanced order monitoring stopped');
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeIcebergs: Array.from(this.icebergOrders.values()).filter(i => i.status === 'active').length,
            activeOCOs: Array.from(this.ocoOrders.values()).filter(o => o.status === 'active').length,
            activeBrackets: Array.from(this.bracketOrders.values()).filter(b => b.status === 'active').length,
            pendingStops: Array.from(this.stopOrders.values()).filter(s => !s.triggered).length,
            activeTWAPs: Array.from(this.twapOrders.values()).filter(t => t.status === 'active').length,
            priceWatchers: Array.from(this.priceWatchers.values()).reduce((sum, w) => sum + w.length, 0)
        };
    }
}

export default AdvancedOrderManager;