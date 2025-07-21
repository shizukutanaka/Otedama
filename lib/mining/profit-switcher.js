/**
 * Profit Switching Engine for Otedama
 * Automatically switches to most profitable coin based on real-time data
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';

export class ProfitSwitcher extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            updateInterval: config.updateInterval || 300000, // 5 minutes
            minimumDifference: config.minimumDifference || 0.05, // 5% minimum difference to switch
            switchDelay: config.switchDelay || 30000, // 30 seconds delay before switching
            includeFees: config.includeFees !== false,
            includeConversionFees: config.includeConversionFees !== false,
            ...config
        };
        
        this.isRunning = false;
        this.updateTimer = null;
        this.currentCoin = null;
        this.currentAlgorithm = null;
        this.profitabilityData = new Map();
        this.historicalData = [];
        this.switchHistory = [];
        this.priceFeed = null;
        this.difficultyTracker = null;
        this.hashrates = new Map(); // Algorithm -> hashrate mapping
    }

    /**
     * Initialize profit switcher
     */
    async initialize(priceFeed, difficultyTracker) {
        this.priceFeed = priceFeed;
        this.difficultyTracker = difficultyTracker;
        
        // Load user's hashrates for different algorithms
        await this.loadHashrates();
        
        // Initial profitability calculation
        await this.updateProfitability();
        
        logger.info('Profit switcher initialized');
    }

    /**
     * Start automatic profit switching
     */
    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        
        // Start update timer
        this.updateTimer = setInterval(async () => {
            await this.updateProfitability();
            await this.checkAndSwitch();
        }, this.config.updateInterval);
        
        this.emit('started');
        logger.info('Profit switching started');
    }

    /**
     * Stop profit switching
     */
    stop() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
        
        this.emit('stopped');
        logger.info('Profit switching stopped');
    }

    /**
     * Load user's hashrates for different algorithms
     */
    async loadHashrates() {
        // Default hashrates (H/s) - would be loaded from user profile/benchmarks
        this.hashrates.set('sha256', 100 * 1e12); // 100 TH/s (ASIC)
        this.hashrates.set('scrypt', 1 * 1e9); // 1 GH/s (ASIC)
        this.hashrates.set('ethash', 100 * 1e6); // 100 MH/s (GPU)
        this.hashrates.set('randomx', 10 * 1e3); // 10 KH/s (CPU)
        this.hashrates.set('kawpow', 30 * 1e6); // 30 MH/s (GPU)
        this.hashrates.set('x11', 20 * 1e9); // 20 GH/s (ASIC)
        this.hashrates.set('equihash', 500); // 500 Sol/s (GPU)
        this.hashrates.set('autolykos', 150 * 1e6); // 150 MH/s (GPU)
        this.hashrates.set('kheavyhash', 1 * 1e9); // 1 GH/s (ASIC)
        this.hashrates.set('blake3', 2 * 1e9); // 2 GH/s
    }

    /**
     * Update profitability data for all coins
     */
    async updateProfitability() {
        const coins = await this.getAvailableCoins();
        const prices = await this.priceFeed.getBulkPrices(coins.map(c => c.symbol));
        
        this.profitabilityData.clear();
        
        for (const coin of coins) {
            try {
                const profitability = await this.calculateProfitability(coin, prices[coin.symbol]);
                this.profitabilityData.set(coin.symbol, profitability);
            } catch (error) {
                logger.error(`Failed to calculate profitability for ${coin.symbol}:`, error);
            }
        }
        
        // Sort by profitability
        const sorted = Array.from(this.profitabilityData.entries())
            .sort((a, b) => b[1].netProfitBTC - a[1].netProfitBTC);
        
        // Store historical data
        this.historicalData.push({
            timestamp: Date.now(),
            data: new Map(sorted)
        });
        
        // Keep only last 24 hours of data
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        this.historicalData = this.historicalData.filter(h => h.timestamp > cutoff);
        
        this.emit('profitability:updated', sorted);
        
        return sorted;
    }

    /**
     * Calculate profitability for a specific coin
     */
    async calculateProfitability(coin, price) {
        const { algorithm, symbol, blockReward, blockTime } = coin;
        
        // Get hashrate for this algorithm
        const hashrate = this.hashrates.get(algorithm) || 0;
        if (hashrate === 0) {
            return {
                coin: symbol,
                algorithm,
                profitBTC: 0,
                netProfitBTC: 0,
                revenue24h: 0,
                viable: false
            };
        }
        
        // Get network difficulty
        const difficulty = await this.difficultyTracker.getDifficulty(symbol);
        const networkHashrate = await this.difficultyTracker.getNetworkHashrate(symbol);
        
        // Calculate expected blocks per day
        const blocksPerDay = (24 * 60 * 60) / blockTime;
        const myShareOfNetwork = hashrate / networkHashrate;
        const expectedBlocksPerDay = blocksPerDay * myShareOfNetwork;
        
        // Calculate daily revenue
        const dailyCoins = expectedBlocksPerDay * blockReward;
        const dailyRevenueBTC = dailyCoins * price;
        
        // Calculate fees
        let totalFees = 0;
        
        if (this.config.includeFees) {
            // Pool fee (1.8%)
            totalFees += dailyRevenueBTC * 0.018;
            
            // Conversion fee if not mining BTC directly
            if (this.config.includeConversionFees && symbol !== 'BTC') {
                totalFees += dailyRevenueBTC * 0.002; // 0.2% conversion fee
            }
        }
        
        // Net profit
        const netProfitBTC = dailyRevenueBTC - totalFees;
        
        return {
            coin: symbol,
            algorithm,
            price,
            difficulty,
            networkHashrate,
            hashrate,
            expectedBlocksPerDay,
            dailyCoins,
            revenue24h: dailyRevenueBTC,
            fees24h: totalFees,
            netProfit24h: netProfitBTC,
            profitBTC: dailyRevenueBTC,
            netProfitBTC,
            viable: netProfitBTC > 0
        };
    }

    /**
     * Check if should switch and execute switch if needed
     */
    async checkAndSwitch() {
        if (!this.isRunning) return;
        
        const sorted = Array.from(this.profitabilityData.entries())
            .sort((a, b) => b[1].netProfitBTC - a[1].netProfitBTC);
        
        if (sorted.length === 0) return;
        
        const [topCoin, topData] = sorted[0];
        
        // Check if should switch
        if (this.currentCoin === topCoin) {
            return; // Already mining most profitable
        }
        
        // Check minimum difference threshold
        if (this.currentCoin) {
            const currentData = this.profitabilityData.get(this.currentCoin);
            if (currentData) {
                const difference = (topData.netProfitBTC - currentData.netProfitBTC) / currentData.netProfitBTC;
                
                if (difference < this.config.minimumDifference) {
                    logger.debug(`Profit difference ${(difference * 100).toFixed(2)}% below threshold, not switching`);
                    return;
                }
            }
        }
        
        // Execute switch with delay
        logger.info(`Switching from ${this.currentCoin || 'none'} to ${topCoin} (${(topData.netProfitBTC * 1000).toFixed(4)} mBTC/day)`);
        
        setTimeout(() => {
            this.executeSwitch(topCoin, topData);
        }, this.config.switchDelay);
    }

    /**
     * Execute the actual switch
     */
    async executeSwitch(coin, profitData) {
        const previousCoin = this.currentCoin;
        const previousAlgorithm = this.currentAlgorithm;
        
        this.currentCoin = coin;
        this.currentAlgorithm = profitData.algorithm;
        
        // Record switch
        this.switchHistory.push({
            timestamp: Date.now(),
            from: previousCoin,
            to: coin,
            fromAlgorithm: previousAlgorithm,
            toAlgorithm: profitData.algorithm,
            profitability: profitData.netProfitBTC,
            reason: 'profit'
        });
        
        // Keep only last 100 switches
        if (this.switchHistory.length > 100) {
            this.switchHistory = this.switchHistory.slice(-100);
        }
        
        this.emit('switched', {
            from: previousCoin,
            to: coin,
            algorithm: profitData.algorithm,
            profitability: profitData
        });
    }

    /**
     * Get available coins for mining
     */
    async getAvailableCoins() {
        // Would be loaded from configuration/database
        return [
            { symbol: 'BTC', algorithm: 'sha256', blockReward: 6.25, blockTime: 600 },
            { symbol: 'LTC', algorithm: 'scrypt', blockReward: 12.5, blockTime: 150 },
            { symbol: 'ETH', algorithm: 'ethash', blockReward: 2, blockTime: 13 },
            { symbol: 'XMR', algorithm: 'randomx', blockReward: 0.6, blockTime: 120 },
            { symbol: 'RVN', algorithm: 'kawpow', blockReward: 5000, blockTime: 60 },
            { symbol: 'DASH', algorithm: 'x11', blockReward: 1.55, blockTime: 150 },
            { symbol: 'ZEC', algorithm: 'equihash', blockReward: 3.125, blockTime: 75 },
            { symbol: 'ERGO', algorithm: 'autolykos', blockReward: 48, blockTime: 120 },
            { symbol: 'KAS', algorithm: 'kheavyhash', blockReward: 100, blockTime: 1 },
            { symbol: 'ALPH', algorithm: 'blake3', blockReward: 0.5, blockTime: 64 }
        ];
    }

    /**
     * Get current profitability ranking
     */
    getCurrentRanking() {
        return Array.from(this.profitabilityData.entries())
            .sort((a, b) => b[1].netProfitBTC - a[1].netProfitBTC)
            .map(([coin, data]) => ({
                rank: 0, // Will be set below
                coin,
                algorithm: data.algorithm,
                profitability: data.netProfitBTC,
                revenue24h: data.revenue24h,
                isCurrent: coin === this.currentCoin
            }))
            .map((item, index) => ({ ...item, rank: index + 1 }));
    }

    /**
     * Get switch history
     */
    getSwitchHistory(limit = 50) {
        return this.switchHistory.slice(-limit);
    }

    /**
     * Get profitability trends
     */
    getProfitabilityTrends(coin, hours = 24) {
        const cutoff = Date.now() - hours * 60 * 60 * 1000;
        
        return this.historicalData
            .filter(h => h.timestamp > cutoff)
            .map(h => ({
                timestamp: h.timestamp,
                profitability: h.data.get(coin)?.netProfitBTC || 0
            }));
    }

    /**
     * Manual switch to specific coin
     */
    async manualSwitch(coin) {
        const coinData = this.profitabilityData.get(coin);
        
        if (!coinData) {
            throw new Error(`No profitability data for ${coin}`);
        }
        
        await this.executeSwitch(coin, coinData);
        
        // Record as manual switch
        this.switchHistory[this.switchHistory.length - 1].reason = 'manual';
    }

    /**
     * Update hashrate for algorithm
     */
    updateHashrate(algorithm, hashrate) {
        this.hashrates.set(algorithm, hashrate);
        this.emit('hashrate:updated', { algorithm, hashrate });
        
        // Trigger profitability recalculation
        this.updateProfitability();
    }

    /**
     * Get statistics
     */
    getStats() {
        const switchCount24h = this.switchHistory
            .filter(s => s.timestamp > Date.now() - 24 * 60 * 60 * 1000)
            .length;
        
        return {
            currentCoin: this.currentCoin,
            currentAlgorithm: this.currentAlgorithm,
            isRunning: this.isRunning,
            totalCoins: this.profitabilityData.size,
            lastUpdate: this.historicalData[this.historicalData.length - 1]?.timestamp || 0,
            switchCount24h,
            totalSwitches: this.switchHistory.length,
            topCoin: this.getCurrentRanking()[0] || null
        };
    }
}

export default ProfitSwitcher;