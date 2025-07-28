const { EventEmitter } = require('events');
const crypto = require('crypto');

class AntiHFTMarketMaker extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            // Anti-HFT settings
            minOrderInterval: options.minOrderInterval || 1000, // Minimum time between orders (ms)
            rateLimit: options.rateLimit || 10, // Max orders per minute
            patternDetection: options.patternDetection !== false,
            layeringDetection: options.layeringDetection !== false,
            
            // Market making settings
            spreadPercentage: options.spreadPercentage || 0.002, // 0.2%
            depthLevels: options.depthLevels || 5,
            orderSize: options.orderSize || 0.1,
            maxInventory: options.maxInventory || 100,
            inventorySkew: options.inventorySkew || 0.1,
            
            // Risk management
            maxDrawdown: options.maxDrawdown || 0.05,
            stopLossPercentage: options.stopLossPercentage || 0.02,
            positionLimit: options.positionLimit || 1000,
            
            ...options
        };
        
        // Order tracking
        this.orderBook = new Map();
        this.activeOrders = new Map();
        this.orderHistory = [];
        
        // HFT detection
        this.activityPatterns = new Map();
        this.suspiciousAddresses = new Set();
        this.rateLimiters = new Map();
        
        // Market making state
        this.marketState = {
            bestBid: 0,
            bestAsk: 0,
            midPrice: 0,
            spread: 0,
            volume24h: 0,
            volatility: 0
        };
        
        // Inventory management
        this.inventory = {
            base: 0,
            quote: 0,
            targetRatio: 0.5
        };
        
        // Performance metrics
        this.metrics = {
            ordersCreated: 0,
            ordersExecuted: 0,
            ordersBlocked: 0,
            profitLoss: 0,
            volume: 0,
            fees: 0
        };
        
        this.isRunning = false;
    }

    async start() {
        this.isRunning = true;
        
        // Start market data feed
        this.startMarketDataFeed();
        
        // Start anti-HFT monitoring
        this.startHFTDetection();
        
        // Start market making
        this.startMarketMaking();
        
        // Start risk monitoring
        this.startRiskMonitoring();
        
        this.emit('started');
    }

    async submitOrder(order) {
        // Validate order
        if (!this.validateOrder(order)) {
            this.metrics.ordersBlocked++;
            return { success: false, reason: 'Invalid order' };
        }
        
        // Check rate limits
        const rateLimitResult = this.checkRateLimit(order.address);
        if (!rateLimitResult.allowed) {
            this.metrics.ordersBlocked++;
            this.emit('order:rate-limited', { order, reason: rateLimitResult.reason });
            return { success: false, reason: rateLimitResult.reason };
        }
        
        // Check for HFT patterns
        const hftCheck = this.detectHFTPattern(order);
        if (hftCheck.isHFT) {
            this.handleHFTDetection(order, hftCheck);
            return { success: false, reason: 'HFT pattern detected' };
        }
        
        // Check for market manipulation
        const manipulationCheck = this.detectManipulation(order);
        if (manipulationCheck.detected) {
            this.handleManipulationDetection(order, manipulationCheck);
            return { success: false, reason: 'Market manipulation detected' };
        }
        
        // Process order
        const result = await this.processOrder(order);
        
        // Update metrics
        this.updateMetrics(order, result);
        
        return result;
    }

    checkRateLimit(address) {
        if (!this.rateLimiters.has(address)) {
            this.rateLimiters.set(address, {
                orders: [],
                warnings: 0,
                blocked: false
            });
        }
        
        const limiter = this.rateLimiters.get(address);
        const now = Date.now();
        
        // Remove old orders
        limiter.orders = limiter.orders.filter(timestamp => 
            now - timestamp < 60000 // Keep last minute
        );
        
        // Check minimum interval
        if (limiter.orders.length > 0) {
            const lastOrder = limiter.orders[limiter.orders.length - 1];
            if (now - lastOrder < this.config.minOrderInterval) {
                return { 
                    allowed: false, 
                    reason: 'Minimum order interval not met' 
                };
            }
        }
        
        // Check rate limit
        if (limiter.orders.length >= this.config.rateLimit) {
            limiter.warnings++;
            
            if (limiter.warnings > 3) {
                limiter.blocked = true;
                this.suspiciousAddresses.add(address);
            }
            
            return { 
                allowed: false, 
                reason: 'Rate limit exceeded' 
            };
        }
        
        // Check if blocked
        if (limiter.blocked) {
            return { 
                allowed: false, 
                reason: 'Address blocked for suspicious activity' 
            };
        }
        
        // Add order timestamp
        limiter.orders.push(now);
        
        return { allowed: true };
    }

    detectHFTPattern(order) {
        const patterns = this.getAddressPatterns(order.address);
        
        // Pattern 1: Rapid order submission
        const rapidSubmission = this.detectRapidSubmission(patterns);
        
        // Pattern 2: Quote stuffing
        const quoteStuffing = this.detectQuoteStuffing(patterns);
        
        // Pattern 3: Layering/Spoofing
        const layering = this.detectLayering(order, patterns);
        
        // Pattern 4: Momentum ignition
        const momentumIgnition = this.detectMomentumIgnition(patterns);
        
        // Pattern 5: Wash trading
        const washTrading = this.detectWashTrading(order, patterns);
        
        const isHFT = rapidSubmission || quoteStuffing || layering || 
                      momentumIgnition || washTrading;
        
        return {
            isHFT,
            patterns: {
                rapidSubmission,
                quoteStuffing,
                layering,
                momentumIgnition,
                washTrading
            }
        };
    }

    detectRapidSubmission(patterns) {
        const recentOrders = patterns.orders.filter(o => 
            Date.now() - o.timestamp < 1000 // Last second
        );
        
        return recentOrders.length > 5;
    }

    detectQuoteStuffing(patterns) {
        const recentCancellations = patterns.cancellations.filter(c => 
            Date.now() - c.timestamp < 5000 // Last 5 seconds
        );
        
        const cancellationRatio = patterns.cancellations.length / 
                                 (patterns.orders.length || 1);
        
        return recentCancellations.length > 10 || cancellationRatio > 0.9;
    }

    detectLayering(order, patterns) {
        if (!this.config.layeringDetection) return false;
        
        // Check for multiple orders at different price levels
        const sameSideOrders = patterns.activeOrders.filter(o => 
            o.side === order.side
        );
        
        if (sameSideOrders.length < 3) return false;
        
        // Check price distribution
        const prices = sameSideOrders.map(o => o.price).sort((a, b) => a - b);
        const priceRange = prices[prices.length - 1] - prices[0];
        const avgSpacing = priceRange / (prices.length - 1);
        
        // Detect regular spacing (characteristic of layering)
        let regularSpacing = true;
        for (let i = 1; i < prices.length; i++) {
            const spacing = prices[i] - prices[i - 1];
            if (Math.abs(spacing - avgSpacing) / avgSpacing > 0.1) {
                regularSpacing = false;
                break;
            }
        }
        
        return regularSpacing && sameSideOrders.length > 5;
    }

    detectMomentumIgnition(patterns) {
        // Check for aggressive orders followed by opposite orders
        const recentOrders = patterns.orders.slice(-10);
        
        if (recentOrders.length < 6) return false;
        
        // Look for pattern: buy, buy, buy, sell, sell, sell
        let switches = 0;
        let lastSide = recentOrders[0]?.side;
        
        for (const order of recentOrders) {
            if (order.side !== lastSide) {
                switches++;
                lastSide = order.side;
            }
        }
        
        return switches >= 2 && recentOrders.length > 6;
    }

    detectWashTrading(order, patterns) {
        // Check if same address has recent opposite order
        const oppositeOrders = patterns.orders.filter(o => 
            o.side !== order.side &&
            Date.now() - o.timestamp < 30000 && // Last 30 seconds
            Math.abs(o.price - order.price) / order.price < 0.001 // Similar price
        );
        
        return oppositeOrders.length > 0;
    }

    detectManipulation(order) {
        const manipulationTypes = [];
        
        // Check for price manipulation
        if (this.isPriceManipulation(order)) {
            manipulationTypes.push('price_manipulation');
        }
        
        // Check for volume manipulation
        if (this.isVolumeManipulation(order)) {
            manipulationTypes.push('volume_manipulation');
        }
        
        // Check for front-running
        if (this.isFrontRunning(order)) {
            manipulationTypes.push('front_running');
        }
        
        return {
            detected: manipulationTypes.length > 0,
            types: manipulationTypes
        };
    }

    isPriceManipulation(order) {
        const priceDeviation = Math.abs(order.price - this.marketState.midPrice) / 
                              this.marketState.midPrice;
        
        // Large order far from market price
        return order.amount > this.config.orderSize * 10 && 
               priceDeviation > 0.05;
    }

    isVolumeManipulation(order) {
        const patterns = this.getAddressPatterns(order.address);
        const recentVolume = patterns.orders
            .filter(o => Date.now() - o.timestamp < 300000) // Last 5 minutes
            .reduce((sum, o) => sum + o.amount, 0);
        
        return recentVolume > this.marketState.volume24h * 0.1; // >10% of daily volume
    }

    isFrontRunning(order) {
        // Check if order appears to front-run pending large orders
        const pendingLargeOrders = Array.from(this.orderBook.values())
            .filter(o => o.amount > this.config.orderSize * 20);
        
        for (const largeOrder of pendingLargeOrders) {
            const timeDiff = order.timestamp - largeOrder.timestamp;
            const priceDiff = Math.abs(order.price - largeOrder.price) / largeOrder.price;
            
            if (timeDiff > 0 && timeDiff < 100 && priceDiff < 0.001) {
                return true;
            }
        }
        
        return false;
    }

    async processOrder(order) {
        const orderId = this.generateOrderId();
        
        const processedOrder = {
            ...order,
            id: orderId,
            timestamp: Date.now(),
            status: 'pending'
        };
        
        // Add to order book
        this.orderBook.set(orderId, processedOrder);
        this.activeOrders.set(order.address, [
            ...(this.activeOrders.get(order.address) || []),
            orderId
        ]);
        
        // Update patterns
        this.updateAddressPatterns(order.address, processedOrder);
        
        // Execute order matching
        const matches = await this.matchOrder(processedOrder);
        
        if (matches.length > 0) {
            processedOrder.status = 'executed';
            processedOrder.executedPrice = this.calculateExecutionPrice(matches);
            processedOrder.executedAmount = matches.reduce((sum, m) => sum + m.amount, 0);
            
            // Update inventory
            this.updateInventory(processedOrder);
            
            this.emit('order:executed', processedOrder);
        } else {
            processedOrder.status = 'open';
            this.emit('order:placed', processedOrder);
        }
        
        this.metrics.ordersCreated++;
        
        return {
            success: true,
            orderId,
            status: processedOrder.status
        };
    }

    async matchOrder(order) {
        const matches = [];
        const oppositeOrders = Array.from(this.orderBook.values())
            .filter(o => 
                o.side !== order.side &&
                o.status === 'open' &&
                this.isPriceMatch(order, o)
            )
            .sort((a, b) => order.side === 'buy' ? 
                a.price - b.price : b.price - a.price
            );
        
        let remainingAmount = order.amount;
        
        for (const oppositeOrder of oppositeOrders) {
            if (remainingAmount <= 0) break;
            
            const matchAmount = Math.min(remainingAmount, oppositeOrder.amount);
            
            matches.push({
                orderId: oppositeOrder.id,
                amount: matchAmount,
                price: oppositeOrder.price
            });
            
            remainingAmount -= matchAmount;
            oppositeOrder.amount -= matchAmount;
            
            if (oppositeOrder.amount <= 0) {
                oppositeOrder.status = 'executed';
                this.orderBook.delete(oppositeOrder.id);
            }
        }
        
        return matches;
    }

    isPriceMatch(order1, order2) {
        if (order1.side === 'buy') {
            return order1.price >= order2.price;
        } else {
            return order1.price <= order2.price;
        }
    }

    calculateExecutionPrice(matches) {
        const totalValue = matches.reduce((sum, m) => sum + m.amount * m.price, 0);
        const totalAmount = matches.reduce((sum, m) => sum + m.amount, 0);
        
        return totalValue / totalAmount;
    }

    startMarketMaking() {
        this.marketMakingInterval = setInterval(() => {
            if (!this.isRunning) return;
            
            this.updateMarketState();
            this.adjustQuotes();
            this.manageInventory();
            
        }, 1000); // Every second
    }

    updateMarketState() {
        const bids = Array.from(this.orderBook.values())
            .filter(o => o.side === 'buy' && o.status === 'open')
            .sort((a, b) => b.price - a.price);
        
        const asks = Array.from(this.orderBook.values())
            .filter(o => o.side === 'sell' && o.status === 'open')
            .sort((a, b) => a.price - b.price);
        
        if (bids.length > 0 && asks.length > 0) {
            this.marketState.bestBid = bids[0].price;
            this.marketState.bestAsk = asks[0].price;
            this.marketState.midPrice = (this.marketState.bestBid + this.marketState.bestAsk) / 2;
            this.marketState.spread = this.marketState.bestAsk - this.marketState.bestBid;
        }
        
        // Calculate volatility
        this.calculateVolatility();
    }

    calculateVolatility() {
        const recentTrades = this.orderHistory
            .filter(o => o.status === 'executed' && Date.now() - o.timestamp < 3600000)
            .map(o => o.executedPrice);
        
        if (recentTrades.length < 2) return;
        
        const returns = [];
        for (let i = 1; i < recentTrades.length; i++) {
            returns.push(Math.log(recentTrades[i] / recentTrades[i - 1]));
        }
        
        const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        
        this.marketState.volatility = Math.sqrt(variance);
    }

    adjustQuotes() {
        // Cancel existing market making orders
        this.cancelMarketMakingOrders();
        
        // Calculate new quotes based on inventory skew
        const inventorySkew = this.calculateInventorySkew();
        const adjustedSpread = this.config.spreadPercentage * (1 + this.marketState.volatility);
        
        const bidPrice = this.marketState.midPrice * (1 - adjustedSpread / 2 - inventorySkew);
        const askPrice = this.marketState.midPrice * (1 + adjustedSpread / 2 - inventorySkew);
        
        // Place new market making orders
        for (let i = 0; i < this.config.depthLevels; i++) {
            const levelSpread = adjustedSpread * (i + 1);
            
            // Place bid
            this.placeMarketMakingOrder({
                side: 'buy',
                price: bidPrice * (1 - levelSpread * 0.1),
                amount: this.config.orderSize * (1 + i * 0.5),
                type: 'market_making'
            });
            
            // Place ask
            this.placeMarketMakingOrder({
                side: 'sell',
                price: askPrice * (1 + levelSpread * 0.1),
                amount: this.config.orderSize * (1 + i * 0.5),
                type: 'market_making'
            });
        }
    }

    calculateInventorySkew() {
        const totalInventory = this.inventory.base + 
                              this.inventory.quote / this.marketState.midPrice;
        
        if (totalInventory === 0) return 0;
        
        const baseRatio = this.inventory.base / totalInventory;
        const skew = (baseRatio - this.inventory.targetRatio) * this.config.inventorySkew;
        
        return Math.max(-0.01, Math.min(0.01, skew)); // Cap at ±1%
    }

    placeMarketMakingOrder(order) {
        const mmOrder = {
            ...order,
            address: 'market_maker',
            timestamp: Date.now()
        };
        
        this.processOrder(mmOrder);
    }

    cancelMarketMakingOrders() {
        const mmOrders = Array.from(this.orderBook.values())
            .filter(o => o.address === 'market_maker' && o.status === 'open');
        
        for (const order of mmOrders) {
            order.status = 'cancelled';
            this.orderBook.delete(order.id);
        }
    }

    manageInventory() {
        const totalValue = this.inventory.base * this.marketState.midPrice + 
                          this.inventory.quote;
        
        const baseValue = this.inventory.base * this.marketState.midPrice;
        const currentRatio = baseValue / totalValue;
        
        // Rebalance if too far from target
        if (Math.abs(currentRatio - this.inventory.targetRatio) > 0.1) {
            this.rebalanceInventory();
        }
    }

    rebalanceInventory() {
        const totalValue = this.inventory.base * this.marketState.midPrice + 
                          this.inventory.quote;
        
        const targetBaseValue = totalValue * this.inventory.targetRatio;
        const targetBase = targetBaseValue / this.marketState.midPrice;
        
        const baseDiff = targetBase - this.inventory.base;
        
        if (baseDiff > 0) {
            // Need to buy base
            this.placeMarketMakingOrder({
                side: 'buy',
                price: this.marketState.bestAsk * 1.001,
                amount: Math.min(baseDiff, this.config.orderSize * 5),
                type: 'rebalance'
            });
        } else if (baseDiff < 0) {
            // Need to sell base
            this.placeMarketMakingOrder({
                side: 'sell',
                price: this.marketState.bestBid * 0.999,
                amount: Math.min(-baseDiff, this.config.orderSize * 5),
                type: 'rebalance'
            });
        }
    }

    updateInventory(order) {
        if (order.side === 'buy') {
            this.inventory.base += order.executedAmount;
            this.inventory.quote -= order.executedAmount * order.executedPrice;
        } else {
            this.inventory.base -= order.executedAmount;
            this.inventory.quote += order.executedAmount * order.executedPrice;
        }
    }

    startHFTDetection() {
        this.hftDetectionInterval = setInterval(() => {
            this.analyzeGlobalPatterns();
            this.updateSuspiciousList();
            this.cleanupOldData();
        }, 5000); // Every 5 seconds
    }

    analyzeGlobalPatterns() {
        // Analyze market-wide patterns
        const allOrders = Array.from(this.orderBook.values());
        
        // Check for coordinated activity
        const coordinatedActivity = this.detectCoordinatedActivity(allOrders);
        if (coordinatedActivity.detected) {
            this.emit('manipulation:coordinated', coordinatedActivity);
        }
        
        // Check for market corners
        const marketCorner = this.detectMarketCorner(allOrders);
        if (marketCorner.detected) {
            this.emit('manipulation:corner', marketCorner);
        }
    }

    detectCoordinatedActivity(orders) {
        const timeWindows = new Map();
        
        // Group orders by time windows
        orders.forEach(order => {
            const window = Math.floor(order.timestamp / 1000);
            if (!timeWindows.has(window)) {
                timeWindows.set(window, []);
            }
            timeWindows.get(window).push(order);
        });
        
        // Look for suspicious patterns
        for (const [window, windowOrders] of timeWindows) {
            if (windowOrders.length > 20) {
                // Check if orders have similar characteristics
                const priceVariance = this.calculatePriceVariance(windowOrders);
                const sizeVariance = this.calculateSizeVariance(windowOrders);
                
                if (priceVariance < 0.001 && sizeVariance < 0.1) {
                    return {
                        detected: true,
                        window,
                        orderCount: windowOrders.length,
                        addresses: [...new Set(windowOrders.map(o => o.address))]
                    };
                }
            }
        }
        
        return { detected: false };
    }

    detectMarketCorner(orders) {
        const addressPositions = new Map();
        
        // Calculate net positions by address
        orders.forEach(order => {
            if (!addressPositions.has(order.address)) {
                addressPositions.set(order.address, 0);
            }
            
            const position = addressPositions.get(order.address);
            addressPositions.set(order.address, 
                position + (order.side === 'buy' ? order.amount : -order.amount)
            );
        });
        
        // Check for dominant positions
        for (const [address, position] of addressPositions) {
            const positionRatio = Math.abs(position) / this.marketState.volume24h;
            
            if (positionRatio > 0.3) { // >30% of daily volume
                return {
                    detected: true,
                    address,
                    position,
                    ratio: positionRatio
                };
            }
        }
        
        return { detected: false };
    }

    startRiskMonitoring() {
        this.riskInterval = setInterval(() => {
            this.checkDrawdown();
            this.checkPositionLimits();
            this.checkInventoryRisk();
        }, 10000); // Every 10 seconds
    }

    checkDrawdown() {
        const currentValue = this.inventory.base * this.marketState.midPrice + 
                            this.inventory.quote;
        
        if (!this.peakValue) {
            this.peakValue = currentValue;
        }
        
        this.peakValue = Math.max(this.peakValue, currentValue);
        const drawdown = (this.peakValue - currentValue) / this.peakValue;
        
        if (drawdown > this.config.maxDrawdown) {
            this.emit('risk:max-drawdown', { drawdown, currentValue });
            this.enterProtectionMode();
        }
    }

    checkPositionLimits() {
        const baseValue = this.inventory.base * this.marketState.midPrice;
        
        if (baseValue > this.config.positionLimit) {
            this.emit('risk:position-limit', { baseValue, limit: this.config.positionLimit });
            this.reducePosition();
        }
    }

    checkInventoryRisk() {
        const inventoryValue = this.inventory.base * this.marketState.midPrice;
        const totalValue = inventoryValue + this.inventory.quote;
        
        const inventoryRatio = inventoryValue / totalValue;
        
        if (inventoryRatio > 0.8 || inventoryRatio < 0.2) {
            this.emit('risk:inventory-imbalance', { ratio: inventoryRatio });
            this.rebalanceInventory();
        }
    }

    enterProtectionMode() {
        // Cancel all market making orders
        this.cancelMarketMakingOrders();
        
        // Reduce position sizes
        this.config.orderSize *= 0.5;
        
        // Widen spreads
        this.config.spreadPercentage *= 2;
        
        this.emit('protection-mode:activated');
    }

    reducePosition() {
        const excessBase = this.inventory.base - 
                          (this.config.positionLimit / this.marketState.midPrice);
        
        if (excessBase > 0) {
            this.placeMarketMakingOrder({
                side: 'sell',
                price: this.marketState.bestBid * 0.999,
                amount: excessBase,
                type: 'risk_reduction'
            });
        }
    }

    handleHFTDetection(order, detection) {
        // Add to suspicious list
        this.suspiciousAddresses.add(order.address);
        
        // Update patterns
        const patterns = this.getAddressPatterns(order.address);
        patterns.hftDetections++;
        patterns.lastDetection = Date.now();
        
        // Emit event
        this.emit('hft:detected', {
            order,
            detection,
            address: order.address
        });
        
        // Increase monitoring
        this.increaseMonitoring(order.address);
    }

    handleManipulationDetection(order, detection) {
        // Log manipulation attempt
        this.emit('manipulation:detected', {
            order,
            detection,
            address: order.address
        });
        
        // Take protective action
        if (detection.types.includes('price_manipulation')) {
            this.protectAgainstPriceManipulation();
        }
    }

    protectAgainstPriceManipulation() {
        // Tighten price bands
        this.config.spreadPercentage *= 0.8;
        
        // Increase order book depth
        this.config.depthLevels = Math.min(10, this.config.depthLevels + 2);
    }

    increaseMonitoring(address) {
        const patterns = this.getAddressPatterns(address);
        patterns.monitoringLevel = (patterns.monitoringLevel || 0) + 1;
    }

    getAddressPatterns(address) {
        if (!this.activityPatterns.has(address)) {
            this.activityPatterns.set(address, {
                orders: [],
                cancellations: [],
                activeOrders: [],
                hftDetections: 0,
                monitoringLevel: 0
            });
        }
        
        return this.activityPatterns.get(address);
    }

    updateAddressPatterns(address, order) {
        const patterns = this.getAddressPatterns(address);
        
        patterns.orders.push({
            timestamp: order.timestamp,
            side: order.side,
            price: order.price,
            amount: order.amount
        });
        
        patterns.activeOrders = Array.from(this.orderBook.values())
            .filter(o => o.address === address && o.status === 'open');
        
        // Keep only recent history
        const cutoff = Date.now() - 3600000; // 1 hour
        patterns.orders = patterns.orders.filter(o => o.timestamp > cutoff);
    }

    updateSuspiciousList() {
        // Review suspicious addresses
        for (const address of this.suspiciousAddresses) {
            const patterns = this.getAddressPatterns(address);
            const timeSinceLastDetection = Date.now() - (patterns.lastDetection || 0);
            
            // Remove from list if behavior improved
            if (timeSinceLastDetection > 3600000 && patterns.hftDetections < 5) {
                this.suspiciousAddresses.delete(address);
                patterns.monitoringLevel = Math.max(0, patterns.monitoringLevel - 1);
            }
        }
    }

    cleanupOldData() {
        const cutoff = Date.now() - 3600000; // 1 hour
        
        // Clean order history
        this.orderHistory = this.orderHistory.filter(o => o.timestamp > cutoff);
        
        // Clean pattern data
        for (const [address, patterns] of this.activityPatterns) {
            patterns.orders = patterns.orders.filter(o => o.timestamp > cutoff);
            patterns.cancellations = patterns.cancellations.filter(c => c.timestamp > cutoff);
            
            // Remove if no recent activity
            if (patterns.orders.length === 0 && patterns.activeOrders.length === 0) {
                this.activityPatterns.delete(address);
            }
        }
    }

    calculatePriceVariance(orders) {
        const prices = orders.map(o => o.price);
        const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        
        return Math.sqrt(variance) / mean;
    }

    calculateSizeVariance(orders) {
        const sizes = orders.map(o => o.amount);
        const mean = sizes.reduce((sum, s) => sum + s, 0) / sizes.length;
        const variance = sizes.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / sizes.length;
        
        return Math.sqrt(variance) / mean;
    }

    updateMetrics(order, result) {
        if (result.success) {
            if (result.status === 'executed') {
                this.metrics.ordersExecuted++;
                this.metrics.volume += order.amount;
                
                // Calculate P&L
                const executionCost = order.amount * order.executedPrice;
                const fairValue = order.amount * this.marketState.midPrice;
                const pnl = order.side === 'buy' ? 
                    fairValue - executionCost : 
                    executionCost - fairValue;
                
                this.metrics.profitLoss += pnl;
            }
        }
    }

    validateOrder(order) {
        return order.address && 
               order.side && 
               order.price > 0 && 
               order.amount > 0;
    }

    generateOrderId() {
        return `order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    getStatistics() {
        return {
            metrics: this.metrics,
            marketState: this.marketState,
            inventory: this.inventory,
            suspiciousAddresses: this.suspiciousAddresses.size,
            activeOrders: this.orderBook.size,
            riskStatus: {
                drawdown: this.peakValue ? 
                    (this.peakValue - this.getCurrentValue()) / this.peakValue : 0,
                inventoryRatio: this.inventory.base * this.marketState.midPrice / 
                               this.getCurrentValue()
            }
        };
    }

    getCurrentValue() {
        return this.inventory.base * this.marketState.midPrice + this.inventory.quote;
    }

    async stop() {
        this.isRunning = false;
        
        // Clear intervals
        if (this.marketMakingInterval) clearInterval(this.marketMakingInterval);
        if (this.hftDetectionInterval) clearInterval(this.hftDetectionInterval);
        if (this.riskInterval) clearInterval(this.riskInterval);
        
        // Cancel all orders
        this.cancelMarketMakingOrders();
        
        this.emit('stopped');
    }

    startMarketDataFeed() {
        // Placeholder for market data feed integration
        // In production, this would connect to exchange APIs
    }
}

module.exports = AntiHFTMarketMaker;