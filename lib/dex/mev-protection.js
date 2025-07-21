/**
 * MEV Protection for Otedama DEX
 * Protects traders from sandwich attacks and front-running
 * 
 * Design principles:
 * - Fast MEV detection (Carmack)
 * - Clean protection mechanisms (Martin)
 * - Simple anti-MEV strategies (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import crypto from 'crypto';

export class MEVProtection extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Commit-reveal settings
            commitRevealDelay: config.commitRevealDelay || 2000, // 2 blocks
            maxCommitAge: config.maxCommitAge || 30000, // 30 seconds
            
            // Batch auction settings
            batchAuctionPeriod: config.batchAuctionPeriod || 1000, // 1 second
            minBatchSize: config.minBatchSize || 10,
            
            // Fair ordering settings
            fairOrderingWindow: config.fairOrderingWindow || 100, // 100ms
            
            // Anti-sandwich settings
            maxSlippageTolerance: config.maxSlippageTolerance || 0.01, // 1%
            priceImpactThreshold: config.priceImpactThreshold || 0.005, // 0.5%
            
            // Detection thresholds
            suspiciousBehaviorThreshold: config.suspiciousBehaviorThreshold || 5,
            blacklistDuration: config.blacklistDuration || 3600000, // 1 hour
            
            ...config
        };
        
        // Protection mechanisms
        this.commits = new Map(); // hash -> commit data
        this.batchQueue = [];
        this.fairOrderingQueue = new Map(); // timestamp -> orders
        
        // MEV detection
        this.suspiciousActivity = new Map(); // address -> score
        this.blacklist = new Map(); // address -> expiry
        this.recentTrades = new Map(); // pair -> recent trades
        
        // Statistics
        this.stats = {
            commitsProcessed: 0,
            batchAuctionsRun: 0,
            mevAttemptsDetected: 0,
            sandwichesBlocked: 0,
            frontRunsBlocked: 0,
            totalProtectedVolume: 0
        };
        
        // Start protection services
        this.startProtectionServices();
    }
    
    /**
     * Commit-Reveal: Submit encrypted order
     */
    async commitOrder(orderData, userAddress) {
        // Check blacklist
        if (this.isBlacklisted(userAddress)) {
            throw new Error('Address is blacklisted for suspicious activity');
        }
        
        // Create commitment
        const nonce = crypto.randomBytes(32).toString('hex');
        const commitment = this.createCommitment(orderData, nonce);
        const commitHash = crypto.createHash('sha256')
            .update(commitment)
            .digest('hex');
        
        // Store commit
        const commitData = {
            hash: commitHash,
            userAddress,
            timestamp: Date.now(),
            revealed: false,
            nonce
        };
        
        this.commits.set(commitHash, commitData);
        this.stats.commitsProcessed++;
        
        // Schedule auto-cleanup
        setTimeout(() => {
            if (this.commits.has(commitHash) && !this.commits.get(commitHash).revealed) {
                this.commits.delete(commitHash);
            }
        }, this.config.maxCommitAge);
        
        logger.debug(`Order committed: ${commitHash}`);
        
        return {
            commitHash,
            nonce,
            revealAfter: Date.now() + this.config.commitRevealDelay
        };
    }
    
    /**
     * Reveal committed order
     */
    async revealOrder(commitHash, orderData, nonce) {
        const commit = this.commits.get(commitHash);
        
        if (!commit) {
            throw new Error('Invalid or expired commitment');
        }
        
        if (commit.revealed) {
            throw new Error('Order already revealed');
        }
        
        // Check reveal timing
        if (Date.now() < commit.timestamp + this.config.commitRevealDelay) {
            throw new Error('Cannot reveal yet, please wait');
        }
        
        // Verify commitment
        const commitment = this.createCommitment(orderData, nonce);
        const verifyHash = crypto.createHash('sha256')
            .update(commitment)
            .digest('hex');
        
        if (verifyHash !== commitHash) {
            throw new Error('Invalid reveal data');
        }
        
        // Mark as revealed
        commit.revealed = true;
        commit.orderData = orderData;
        
        // Add MEV protection metadata
        orderData.mevProtection = {
            type: 'commit-reveal',
            commitTime: commit.timestamp,
            revealTime: Date.now()
        };
        
        // Process order with protection
        const protectedOrder = await this.applyProtection(orderData, commit.userAddress);
        
        this.emit('order:revealed', {
            commitHash,
            order: protectedOrder,
            timestamp: Date.now()
        });
        
        return protectedOrder;
    }
    
    /**
     * Batch Auction: Add order to batch
     */
    async submitToBatchAuction(orderData, userAddress) {
        // Check blacklist
        if (this.isBlacklisted(userAddress)) {
            throw new Error('Address is blacklisted for suspicious activity');
        }
        
        // Add protection metadata
        orderData.mevProtection = {
            type: 'batch-auction',
            submitTime: Date.now()
        };
        
        // Add to batch queue
        this.batchQueue.push({
            order: orderData,
            userAddress,
            timestamp: Date.now()
        });
        
        // Process batch if ready
        if (this.batchQueue.length >= this.config.minBatchSize) {
            await this.processBatchAuction();
        }
        
        return {
            batchId: this.getCurrentBatchId(),
            position: this.batchQueue.length,
            estimatedExecution: this.getNextBatchTime()
        };
    }
    
    /**
     * Process batch auction
     */
    async processBatchAuction() {
        if (this.batchQueue.length === 0) return;
        
        const batch = this.batchQueue.splice(0);
        const batchId = this.getCurrentBatchId();
        
        logger.info(`Processing batch auction ${batchId} with ${batch.length} orders`);
        
        // Randomize order to prevent gaming
        const shuffledBatch = this.fairShuffle(batch);
        
        // Calculate uniform clearing price for each pair
        const clearingPrices = this.calculateClearingPrices(shuffledBatch);
        
        // Execute orders at clearing prices
        const results = [];
        for (const item of shuffledBatch) {
            const pair = item.order.pair;
            const clearingPrice = clearingPrices.get(pair);
            
            if (clearingPrice) {
                // Execute at uniform price
                item.order.executionPrice = clearingPrice;
                item.order.mevProtection.clearingPrice = clearingPrice;
                
                const result = await this.executeProtectedOrder(item.order, item.userAddress);
                results.push(result);
            }
        }
        
        this.stats.batchAuctionsRun++;
        
        this.emit('batch:executed', {
            batchId,
            orderCount: batch.length,
            results,
            clearingPrices: Object.fromEntries(clearingPrices),
            timestamp: Date.now()
        });
        
        return results;
    }
    
    /**
     * Fair Ordering: Time-based ordering within window
     */
    async submitWithFairOrdering(orderData, userAddress) {
        // Check blacklist
        if (this.isBlacklisted(userAddress)) {
            throw new Error('Address is blacklisted for suspicious activity');
        }
        
        const timestamp = Date.now();
        const window = Math.floor(timestamp / this.config.fairOrderingWindow);
        
        // Add to fair ordering queue
        if (!this.fairOrderingQueue.has(window)) {
            this.fairOrderingQueue.set(window, []);
        }
        
        this.fairOrderingQueue.get(window).push({
            order: orderData,
            userAddress,
            timestamp
        });
        
        // Add protection metadata
        orderData.mevProtection = {
            type: 'fair-ordering',
            window,
            submitTime: timestamp
        };
        
        return {
            window,
            position: this.fairOrderingQueue.get(window).length,
            processingTime: (window + 1) * this.config.fairOrderingWindow
        };
    }
    
    /**
     * Process fair ordering queue
     */
    async processFairOrderingQueue() {
        const currentWindow = Math.floor(Date.now() / this.config.fairOrderingWindow);
        
        // Process windows that are complete
        for (const [window, orders] of this.fairOrderingQueue) {
            if (window < currentWindow - 1) {
                // Randomize orders within window
                const shuffled = this.fairShuffle(orders);
                
                // Process orders
                for (const item of shuffled) {
                    await this.executeProtectedOrder(item.order, item.userAddress);
                }
                
                // Remove processed window
                this.fairOrderingQueue.delete(window);
            }
        }
    }
    
    /**
     * Detect sandwich attack
     */
    detectSandwichAttack(order, recentTrades) {
        const { pair, side, quantity, price } = order;
        
        // Look for suspicious pattern
        const suspiciousTrades = recentTrades.filter(trade => {
            const timeDiff = Math.abs(trade.timestamp - Date.now());
            return timeDiff < 5000 && trade.pair === pair;
        });
        
        // Check for sandwich pattern: buy -> victim -> sell
        if (suspiciousTrades.length >= 2) {
            const firstTrade = suspiciousTrades[0];
            const lastTrade = suspiciousTrades[suspiciousTrades.length - 1];
            
            if (firstTrade.userAddress === lastTrade.userAddress &&
                firstTrade.side !== lastTrade.side) {
                
                // Calculate price impact
                const priceImpact = Math.abs(lastTrade.price - firstTrade.price) / firstTrade.price;
                
                if (priceImpact > this.config.priceImpactThreshold) {
                    this.recordSuspiciousActivity(firstTrade.userAddress, 'sandwich');
                    return true;
                }
            }
        }
        
        return false;
    }
    
    /**
     * Detect front-running
     */
    detectFrontRunning(order, pendingOrders) {
        const { pair, side, price } = order;
        
        // Look for orders placed right before with similar characteristics
        const suspiciousOrders = pendingOrders.filter(pending => {
            const timeDiff = order.timestamp - pending.timestamp;
            return timeDiff > 0 && timeDiff < 100 && // Within 100ms
                   pending.pair === pair &&
                   pending.side === side &&
                   Math.abs(pending.price - price) / price < 0.001; // Very close price
        });
        
        if (suspiciousOrders.length > 0) {
            // Check if same address has opposite order ready
            for (const suspicious of suspiciousOrders) {
                const hasOpposite = pendingOrders.some(p => 
                    p.userAddress === suspicious.userAddress &&
                    p.pair === pair &&
                    p.side !== side &&
                    p.timestamp > order.timestamp
                );
                
                if (hasOpposite) {
                    this.recordSuspiciousActivity(suspicious.userAddress, 'frontrun');
                    return true;
                }
            }
        }
        
        return false;
    }
    
    /**
     * Apply MEV protection to order
     */
    async applyProtection(orderData, userAddress) {
        // Add slippage protection
        if (!orderData.maxSlippage) {
            orderData.maxSlippage = this.config.maxSlippageTolerance;
        }
        
        // Add execution deadline
        if (!orderData.deadline) {
            orderData.deadline = Date.now() + 300000; // 5 minutes
        }
        
        // Check for sandwich attacks
        const recentTrades = this.getRecentTrades(orderData.pair);
        if (this.detectSandwichAttack(orderData, recentTrades)) {
            this.stats.sandwichesBlocked++;
            orderData.mevProtection.sandwichDetected = true;
            
            // Apply additional protection
            orderData.maxSlippage = Math.min(orderData.maxSlippage, 0.005); // Tighter slippage
        }
        
        // Record protected volume
        this.stats.totalProtectedVolume += orderData.quantity * (orderData.price || 0);
        
        return orderData;
    }
    
    /**
     * Execute order with protection
     */
    async executeProtectedOrder(order, userAddress) {
        try {
            // Final protection checks
            if (this.isBlacklisted(userAddress)) {
                throw new Error('Address blacklisted during execution');
            }
            
            // Check deadline
            if (order.deadline && Date.now() > order.deadline) {
                throw new Error('Order deadline exceeded');
            }
            
            // Emit for execution
            this.emit('order:protected', {
                order,
                userAddress,
                protection: order.mevProtection,
                timestamp: Date.now()
            });
            
            return {
                success: true,
                order,
                protection: order.mevProtection
            };
            
        } catch (error) {
            logger.error('Protected order execution failed:', error);
            return {
                success: false,
                order,
                error: error.message
            };
        }
    }
    
    /**
     * Helper methods
     */
    
    createCommitment(orderData, nonce) {
        return JSON.stringify({
            ...orderData,
            nonce
        });
    }
    
    fairShuffle(array) {
        // Fisher-Yates shuffle with cryptographic randomness
        const shuffled = [...array];
        
        for (let i = shuffled.length - 1; i > 0; i--) {
            const randomBytes = crypto.randomBytes(4);
            const j = randomBytes.readUInt32BE(0) % (i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        
        return shuffled;
    }
    
    calculateClearingPrices(batch) {
        const clearingPrices = new Map();
        
        // Group by pair
        const ordersByPair = new Map();
        for (const item of batch) {
            const pair = item.order.pair;
            if (!ordersByPair.has(pair)) {
                ordersByPair.set(pair, []);
            }
            ordersByPair.get(pair).push(item.order);
        }
        
        // Calculate clearing price for each pair
        for (const [pair, orders] of ordersByPair) {
            const buyOrders = orders.filter(o => o.side === 'buy').sort((a, b) => b.price - a.price);
            const sellOrders = orders.filter(o => o.side === 'sell').sort((a, b) => a.price - b.price);
            
            // Find crossing point
            let buyIndex = 0, sellIndex = 0;
            let buyVolume = 0, sellVolume = 0;
            let clearingPrice = 0;
            
            while (buyIndex < buyOrders.length && sellIndex < sellOrders.length) {
                const buyPrice = buyOrders[buyIndex].price;
                const sellPrice = sellOrders[sellIndex].price;
                
                if (buyPrice >= sellPrice) {
                    // Orders cross, accumulate volume
                    buyVolume += buyOrders[buyIndex].quantity;
                    sellVolume += sellOrders[sellIndex].quantity;
                    
                    // Clearing price is midpoint
                    clearingPrice = (buyPrice + sellPrice) / 2;
                    
                    if (buyVolume < sellVolume) {
                        buyIndex++;
                    } else {
                        sellIndex++;
                    }
                } else {
                    break;
                }
            }
            
            if (clearingPrice > 0) {
                clearingPrices.set(pair, clearingPrice);
            }
        }
        
        return clearingPrices;
    }
    
    recordSuspiciousActivity(address, type) {
        const current = this.suspiciousActivity.get(address) || 0;
        const newScore = current + 1;
        
        this.suspiciousActivity.set(address, newScore);
        this.stats.mevAttemptsDetected++;
        
        logger.warn(`Suspicious activity detected: ${address} (${type}), score: ${newScore}`);
        
        // Auto-blacklist if threshold exceeded
        if (newScore >= this.config.suspiciousBehaviorThreshold) {
            this.blacklist.set(address, Date.now() + this.config.blacklistDuration);
            logger.warn(`Address blacklisted: ${address}`);
            
            this.emit('address:blacklisted', {
                address,
                reason: 'suspicious_activity',
                score: newScore,
                duration: this.config.blacklistDuration,
                timestamp: Date.now()
            });
        }
    }
    
    isBlacklisted(address) {
        const expiry = this.blacklist.get(address);
        if (expiry && Date.now() < expiry) {
            return true;
        }
        
        // Clean up expired entry
        if (expiry) {
            this.blacklist.delete(address);
        }
        
        return false;
    }
    
    getRecentTrades(pair) {
        return this.recentTrades.get(pair) || [];
    }
    
    recordTrade(trade) {
        const { pair } = trade;
        
        if (!this.recentTrades.has(pair)) {
            this.recentTrades.set(pair, []);
        }
        
        const trades = this.recentTrades.get(pair);
        trades.push(trade);
        
        // Keep only recent trades
        const cutoff = Date.now() - 60000; // 1 minute
        const recentOnly = trades.filter(t => t.timestamp > cutoff);
        this.recentTrades.set(pair, recentOnly);
    }
    
    getCurrentBatchId() {
        return `BATCH${Math.floor(Date.now() / this.config.batchAuctionPeriod)}`;
    }
    
    getNextBatchTime() {
        const current = Date.now();
        const period = this.config.batchAuctionPeriod;
        return Math.ceil(current / period) * period;
    }
    
    /**
     * Start protection services
     */
    startProtectionServices() {
        // Process batch auctions
        this.batchInterval = setInterval(() => {
            this.processBatchAuction();
        }, this.config.batchAuctionPeriod);
        
        // Process fair ordering queue
        this.fairOrderingInterval = setInterval(() => {
            this.processFairOrderingQueue();
        }, this.config.fairOrderingWindow);
        
        // Clean up old data
        this.cleanupInterval = setInterval(() => {
            // Clean old commits
            for (const [hash, commit] of this.commits) {
                if (Date.now() - commit.timestamp > this.config.maxCommitAge) {
                    this.commits.delete(hash);
                }
            }
            
            // Clean suspicious activity scores
            for (const [address, score] of this.suspiciousActivity) {
                if (score > 0) {
                    // Decay score over time
                    this.suspiciousActivity.set(address, Math.max(0, score - 1));
                }
            }
        }, 60000); // Every minute
        
        logger.info('MEV protection services started');
    }
    
    /**
     * Stop protection services
     */
    stop() {
        if (this.batchInterval) {
            clearInterval(this.batchInterval);
        }
        
        if (this.fairOrderingInterval) {
            clearInterval(this.fairOrderingInterval);
        }
        
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        logger.info('MEV protection services stopped');
    }
    
    /**
     * Get protection statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeCommits: this.commits.size,
            batchQueueSize: this.batchQueue.length,
            fairOrderingWindows: this.fairOrderingQueue.size,
            suspiciousAddresses: this.suspiciousActivity.size,
            blacklistedAddresses: this.blacklist.size,
            protectionMethods: {
                commitReveal: this.config.commitRevealDelay > 0,
                batchAuction: this.config.batchAuctionPeriod > 0,
                fairOrdering: this.config.fairOrderingWindow > 0
            }
        };
    }
}

export default MEVProtection;