/**
 * Trading Halt System for Otedama DEX
 * Automatic trading halts and risk controls
 * 
 * Design principles:
 * - Fast anomaly detection (Carmack)
 * - Clean halt logic (Martin)
 * - Simple halt mechanisms (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('TradingHalt');

export class TradingHaltManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Price movement thresholds
            priceChangeThreshold: config.priceChangeThreshold || 0.1, // 10%
            priceChangeWindow: config.priceChangeWindow || 300000, // 5 minutes
            
            // Volume thresholds
            volumeSpikeThreshold: config.volumeSpikeThreshold || 10, // 10x normal
            volumeWindow: config.volumeWindow || 60000, // 1 minute
            
            // Volatility thresholds
            volatilityThreshold: config.volatilityThreshold || 0.05, // 5% std dev
            volatilityWindow: config.volatilityWindow || 3600000, // 1 hour
            
            // Liquidity thresholds
            liquidityDropThreshold: config.liquidityDropThreshold || 0.5, // 50% drop
            minLiquidityDepth: config.minLiquidityDepth || 10000, // $10k
            
            // Order flow thresholds
            orderRateLimit: config.orderRateLimit || 1000, // orders per second
            largeOrderThreshold: config.largeOrderThreshold || 100000, // $100k
            
            // Halt durations
            minHaltDuration: config.minHaltDuration || 60000, // 1 minute
            maxHaltDuration: config.maxHaltDuration || 3600000, // 1 hour
            cooldownPeriod: config.cooldownPeriod || 300000, // 5 minutes
            
            // System thresholds
            maxMemoryUsage: config.maxMemoryUsage || 0.9, // 90%
            maxCpuUsage: config.maxCpuUsage || 0.95, // 95%
            maxLatency: config.maxLatency || 1000, // 1 second
            
            ...config
        };
        
        // Circuit states
        this.circuits = new Map(); // pair -> circuit state
        this.globalCircuit = {
            status: 'normal',
            triggered: false,
            reason: null,
            haltedAt: null,
            resumeAt: null
        };
        
        // Market data tracking
        this.priceHistory = new Map(); // pair -> price history
        this.volumeHistory = new Map(); // pair -> volume history
        this.orderRates = new Map(); // pair -> order rates
        this.liquidityDepth = new Map(); // pair -> liquidity
        
        // System metrics
        this.systemMetrics = {
            memoryUsage: 0,
            cpuUsage: 0,
            latency: 0,
            lastCheck: Date.now()
        };
        
        // Statistics
        this.stats = {
            totalHalts: 0,
            haltsByReason: {},
            averageHaltDuration: 0,
            falsePositives: 0,
            currentHalts: 0
        };
        
        // Start monitoring
        this.startMonitoring();
    }
    
    /**
     * Check if trading should be halted for a pair
     */
    checkPairCircuit(pair, currentPrice, volume, orderBook) {
        let circuit = this.circuits.get(pair);
        if (!circuit) {
            circuit = this.createCircuit(pair);
            this.circuits.set(pair, circuit);
        }
        
        // Skip if already halted
        if (circuit.status === 'halted' && Date.now() < circuit.resumeAt) {
            return { halted: true, circuit };
        }
        
        // Check various conditions
        const checks = [
            this.checkPriceMovement(pair, currentPrice),
            this.checkVolumeSpike(pair, volume),
            this.checkVolatility(pair, currentPrice),
            this.checkLiquidity(pair, orderBook),
            this.checkOrderRate(pair)
        ];
        
        // Find triggered conditions
        const triggered = checks.filter(check => check.triggered);
        
        if (triggered.length > 0) {
            // Determine halt duration based on severity
            const severity = this.calculateSeverity(triggered);
            const haltDuration = this.calculateHaltDuration(severity);
            
            // Trigger circuit breaker
            this.triggerCircuit(circuit, triggered[0].reason, haltDuration);
            
            return { halted: true, circuit, reasons: triggered };
        }
        
        // Check if cooldown period has passed
        if (circuit.status === 'cooldown' && Date.now() > circuit.cooldownUntil) {
            circuit.status = 'normal';
            circuit.cooldownUntil = null;
        }
        
        return { halted: false, circuit };
    }
    
    /**
     * Check global system circuit
     */
    checkGlobalCircuit() {
        // Skip if already halted
        if (this.globalCircuit.triggered && Date.now() < this.globalCircuit.resumeAt) {
            return { halted: true, circuit: this.globalCircuit };
        }
        
        // Check system conditions
        const checks = [
            this.checkMemoryUsage(),
            this.checkCpuUsage(),
            this.checkSystemLatency(),
            this.checkCascadingHalts()
        ];
        
        const triggered = checks.filter(check => check.triggered);
        
        if (triggered.length > 0) {
            const severity = Math.max(...triggered.map(t => t.severity || 1));
            const haltDuration = this.calculateHaltDuration(severity);
            
            this.triggerGlobalCircuit(triggered[0].reason, haltDuration);
            
            return { halted: true, circuit: this.globalCircuit, reasons: triggered };
        }
        
        // Resume if halt period ended
        if (this.globalCircuit.triggered && Date.now() >= this.globalCircuit.resumeAt) {
            this.resumeGlobalTrading();
        }
        
        return { halted: false, circuit: this.globalCircuit };
    }
    
    /**
     * Price movement check
     */
    checkPriceMovement(pair, currentPrice) {
        const history = this.getPriceHistory(pair);
        history.push({ price: currentPrice, timestamp: Date.now() });
        
        // Keep only recent history
        const cutoff = Date.now() - this.config.priceChangeWindow;
        const recentHistory = history.filter(h => h.timestamp > cutoff);
        this.priceHistory.set(pair, recentHistory);
        
        if (recentHistory.length < 2) {
            return { triggered: false };
        }
        
        // Calculate price change
        const oldestPrice = recentHistory[0].price;
        const priceChange = Math.abs((currentPrice - oldestPrice) / oldestPrice);
        
        if (priceChange > this.config.priceChangeThreshold) {
            return {
                triggered: true,
                reason: 'price_movement',
                severity: priceChange / this.config.priceChangeThreshold,
                details: {
                    pair,
                    oldPrice: oldestPrice,
                    newPrice: currentPrice,
                    change: priceChange * 100 + '%'
                }
            };
        }
        
        return { triggered: false };
    }
    
    /**
     * Volume spike check
     */
    checkVolumeSpike(pair, currentVolume) {
        const history = this.getVolumeHistory(pair);
        history.push({ volume: currentVolume, timestamp: Date.now() });
        
        // Keep only recent history
        const cutoff = Date.now() - this.config.volumeWindow;
        const recentHistory = history.filter(h => h.timestamp > cutoff);
        this.volumeHistory.set(pair, recentHistory);
        
        if (recentHistory.length < 10) {
            return { triggered: false };
        }
        
        // Calculate average volume
        const avgVolume = recentHistory.slice(0, -1)
            .reduce((sum, h) => sum + h.volume, 0) / (recentHistory.length - 1);
        
        if (avgVolume === 0) return { triggered: false };
        
        const volumeRatio = currentVolume / avgVolume;
        
        if (volumeRatio > this.config.volumeSpikeThreshold) {
            return {
                triggered: true,
                reason: 'volume_spike',
                severity: volumeRatio / this.config.volumeSpikeThreshold,
                details: {
                    pair,
                    currentVolume,
                    averageVolume: avgVolume,
                    ratio: volumeRatio
                }
            };
        }
        
        return { triggered: false };
    }
    
    /**
     * Volatility check
     */
    checkVolatility(pair, currentPrice) {
        const history = this.getPriceHistory(pair);
        
        // Need sufficient history
        if (history.length < 20) {
            return { triggered: false };
        }
        
        // Calculate returns
        const returns = [];
        for (let i = 1; i < history.length; i++) {
            const ret = (history[i].price - history[i-1].price) / history[i-1].price;
            returns.push(ret);
        }
        
        // Calculate standard deviation
        const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev > this.config.volatilityThreshold) {
            return {
                triggered: true,
                reason: 'high_volatility',
                severity: stdDev / this.config.volatilityThreshold,
                details: {
                    pair,
                    volatility: stdDev * 100 + '%',
                    threshold: this.config.volatilityThreshold * 100 + '%'
                }
            };
        }
        
        return { triggered: false };
    }
    
    /**
     * Liquidity check
     */
    checkLiquidity(pair, orderBook) {
        const currentDepth = this.calculateLiquidityDepth(orderBook);
        const previousDepth = this.liquidityDepth.get(pair) || currentDepth;
        
        // Update depth
        this.liquidityDepth.set(pair, currentDepth);
        
        // Check minimum depth
        if (currentDepth < this.config.minLiquidityDepth) {
            return {
                triggered: true,
                reason: 'low_liquidity',
                severity: 2,
                details: {
                    pair,
                    currentDepth,
                    minRequired: this.config.minLiquidityDepth
                }
            };
        }
        
        // Check liquidity drop
        if (previousDepth > 0) {
            const dropRatio = (previousDepth - currentDepth) / previousDepth;
            
            if (dropRatio > this.config.liquidityDropThreshold) {
                return {
                    triggered: true,
                    reason: 'liquidity_drop',
                    severity: 1.5,
                    details: {
                        pair,
                        previousDepth,
                        currentDepth,
                        dropPercentage: dropRatio * 100 + '%'
                    }
                };
            }
        }
        
        return { triggered: false };
    }
    
    /**
     * Order rate check
     */
    checkOrderRate(pair) {
        const rates = this.orderRates.get(pair) || [];
        const currentSecond = Math.floor(Date.now() / 1000);
        
        // Count orders in current second
        const currentRate = rates.filter(r => r.second === currentSecond).length;
        
        if (currentRate > this.config.orderRateLimit) {
            return {
                triggered: true,
                reason: 'order_flood',
                severity: currentRate / this.config.orderRateLimit,
                details: {
                    pair,
                    orderRate: currentRate,
                    limit: this.config.orderRateLimit
                }
            };
        }
        
        return { triggered: false };
    }
    
    /**
     * System checks
     */
    checkMemoryUsage() {
        const usage = this.systemMetrics.memoryUsage;
        
        if (usage > this.config.maxMemoryUsage) {
            return {
                triggered: true,
                reason: 'high_memory',
                severity: 2,
                details: {
                    usage: usage * 100 + '%',
                    threshold: this.config.maxMemoryUsage * 100 + '%'
                }
            };
        }
        
        return { triggered: false };
    }
    
    checkCpuUsage() {
        const usage = this.systemMetrics.cpuUsage;
        
        if (usage > this.config.maxCpuUsage) {
            return {
                triggered: true,
                reason: 'high_cpu',
                severity: 2,
                details: {
                    usage: usage * 100 + '%',
                    threshold: this.config.maxCpuUsage * 100 + '%'
                }
            };
        }
        
        return { triggered: false };
    }
    
    checkSystemLatency() {
        const latency = this.systemMetrics.latency;
        
        if (latency > this.config.maxLatency) {
            return {
                triggered: true,
                reason: 'high_latency',
                severity: latency / this.config.maxLatency,
                details: {
                    latency: latency + 'ms',
                    threshold: this.config.maxLatency + 'ms'
                }
            };
        }
        
        return { triggered: false };
    }
    
    checkCascadingHalts() {
        const haltedCount = Array.from(this.circuits.values())
            .filter(c => c.status === 'halted').length;
        
        const totalPairs = this.circuits.size;
        const haltedRatio = totalPairs > 0 ? haltedCount / totalPairs : 0;
        
        if (haltedRatio > 0.3) { // 30% of pairs halted
            return {
                triggered: true,
                reason: 'cascading_halts',
                severity: 3,
                details: {
                    haltedPairs: haltedCount,
                    totalPairs,
                    percentage: haltedRatio * 100 + '%'
                }
            };
        }
        
        return { triggered: false };
    }
    
    /**
     * Trigger circuit breaker
     */
    triggerCircuit(circuit, reason, duration) {
        circuit.status = 'halted';
        circuit.triggered = true;
        circuit.reason = reason;
        circuit.haltedAt = Date.now();
        circuit.resumeAt = Date.now() + duration;
        circuit.haltCount++;
        
        // Update stats
        this.stats.totalHalts++;
        this.stats.currentHalts++;
        this.stats.haltsByReason[reason] = (this.stats.haltsByReason[reason] || 0) + 1;
        
        logger.warn(`Circuit breaker triggered for ${circuit.pair}: ${reason}, duration: ${duration}ms`);
        
        this.emit('circuit:triggered', {
            pair: circuit.pair,
            reason,
            duration,
            circuit,
            timestamp: Date.now()
        });
    }
    
    /**
     * Trigger global circuit
     */
    triggerGlobalCircuit(reason, duration) {
        this.globalCircuit.status = 'halted';
        this.globalCircuit.triggered = true;
        this.globalCircuit.reason = reason;
        this.globalCircuit.haltedAt = Date.now();
        this.globalCircuit.resumeAt = Date.now() + duration;
        
        logger.error(`GLOBAL circuit breaker triggered: ${reason}, duration: ${duration}ms`);
        
        this.emit('global:halt', {
            reason,
            duration,
            timestamp: Date.now()
        });
    }
    
    /**
     * Resume trading
     */
    resumeTrading(pair) {
        const circuit = this.circuits.get(pair);
        if (!circuit) return;
        
        circuit.status = 'cooldown';
        circuit.triggered = false;
        circuit.cooldownUntil = Date.now() + this.config.cooldownPeriod;
        
        const haltDuration = Date.now() - circuit.haltedAt;
        this.updateAverageHaltDuration(haltDuration);
        this.stats.currentHalts--;
        
        logger.info(`Trading resumed for ${pair} after ${haltDuration}ms`);
        
        this.emit('circuit:resumed', {
            pair,
            haltDuration,
            timestamp: Date.now()
        });
    }
    
    resumeGlobalTrading() {
        this.globalCircuit.status = 'normal';
        this.globalCircuit.triggered = false;
        
        const haltDuration = Date.now() - this.globalCircuit.haltedAt;
        
        logger.info(`GLOBAL trading resumed after ${haltDuration}ms`);
        
        this.emit('global:resumed', {
            haltDuration,
            timestamp: Date.now()
        });
    }
    
    /**
     * Manual override
     */
    manualHalt(pair, duration, reason = 'manual') {
        if (pair) {
            const circuit = this.circuits.get(pair) || this.createCircuit(pair);
            this.triggerCircuit(circuit, reason, duration);
            this.circuits.set(pair, circuit);
        } else {
            this.triggerGlobalCircuit(reason, duration);
        }
    }
    
    manualResume(pair) {
        if (pair) {
            this.resumeTrading(pair);
        } else {
            this.resumeGlobalTrading();
        }
    }
    
    /**
     * Record order for rate limiting
     */
    recordOrder(pair) {
        const rates = this.orderRates.get(pair) || [];
        const currentSecond = Math.floor(Date.now() / 1000);
        
        rates.push({ second: currentSecond });
        
        // Keep only recent data
        const cutoff = currentSecond - 60;
        const recent = rates.filter(r => r.second > cutoff);
        
        this.orderRates.set(pair, recent);
    }
    
    /**
     * Update system metrics
     */
    updateSystemMetrics(metrics) {
        this.systemMetrics = {
            ...this.systemMetrics,
            ...metrics,
            lastCheck: Date.now()
        };
    }
    
    /**
     * Helper methods
     */
    
    createCircuit(pair) {
        return {
            pair,
            status: 'normal', // normal, halted, cooldown
            triggered: false,
            reason: null,
            haltedAt: null,
            resumeAt: null,
            cooldownUntil: null,
            haltCount: 0
        };
    }
    
    getPriceHistory(pair) {
        if (!this.priceHistory.has(pair)) {
            this.priceHistory.set(pair, []);
        }
        return this.priceHistory.get(pair);
    }
    
    getVolumeHistory(pair) {
        if (!this.volumeHistory.has(pair)) {
            this.volumeHistory.set(pair, []);
        }
        return this.volumeHistory.get(pair);
    }
    
    calculateLiquidityDepth(orderBook) {
        if (!orderBook) return 0;
        
        let totalDepth = 0;
        
        // Sum bid liquidity
        if (orderBook.bids) {
            for (const [price, quantity] of orderBook.bids.slice(0, 10)) {
                totalDepth += price * quantity;
            }
        }
        
        // Sum ask liquidity
        if (orderBook.asks) {
            for (const [price, quantity] of orderBook.asks.slice(0, 10)) {
                totalDepth += price * quantity;
            }
        }
        
        return totalDepth;
    }
    
    calculateSeverity(triggers) {
        return Math.max(...triggers.map(t => t.severity || 1));
    }
    
    calculateHaltDuration(severity) {
        const base = this.config.minHaltDuration;
        const max = this.config.maxHaltDuration;
        
        // Exponential scaling based on severity
        const duration = Math.min(base * Math.pow(2, severity - 1), max);
        
        return Math.round(duration);
    }
    
    updateAverageHaltDuration(duration) {
        const total = this.stats.averageHaltDuration * (this.stats.totalHalts - 1) + duration;
        this.stats.averageHaltDuration = total / this.stats.totalHalts;
    }
    
    /**
     * Start monitoring
     */
    startMonitoring() {
        // Check halted circuits for resume
        this.monitoringInterval = setInterval(() => {
            // Check pair circuits
            for (const [pair, circuit] of this.circuits) {
                if (circuit.status === 'halted' && Date.now() >= circuit.resumeAt) {
                    this.resumeTrading(pair);
                }
            }
            
            // Check global circuit
            this.checkGlobalCircuit();
            
        }, 1000); // Every second
        
        logger.info('Circuit breaker monitoring started');
    }
    
    /**
     * Stop monitoring
     */
    stop() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }
        
        logger.info('Circuit breaker monitoring stopped');
    }
    
    /**
     * Get circuit breaker status
     */
    getStatus() {
        const haltedPairs = [];
        
        for (const [pair, circuit] of this.circuits) {
            if (circuit.status === 'halted') {
                haltedPairs.push({
                    pair,
                    reason: circuit.reason,
                    haltedAt: circuit.haltedAt,
                    resumeAt: circuit.resumeAt,
                    remainingTime: Math.max(0, circuit.resumeAt - Date.now())
                });
            }
        }
        
        return {
            global: this.globalCircuit,
            haltedPairs,
            stats: this.stats,
            systemMetrics: this.systemMetrics
        };
    }
}

export default TradingHaltManager;