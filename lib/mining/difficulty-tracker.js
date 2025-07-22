/**
 * Difficulty Tracker for Otedama
 * Tracks network difficulty and hashrate for various cryptocurrencies
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';

const logger = getLogger('DifficultyTracker');

export class DifficultyTracker extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            updateInterval: config.updateInterval || 300000, // 5 minutes
            cacheExpiry: config.cacheExpiry || 600000, // 10 minutes
            retryAttempts: config.retryAttempts || 3,
            ...config
        };
        
        this.difficultyCache = new Map();
        this.hashRateCache = new Map();
        this.blockTimeCache = new Map();
        this.updateTimers = new Map();
        this.isRunning = false;
    }

    /**
     * Start tracking difficulties
     */
    start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        
        // Start update timers for tracked coins
        this.startUpdateTimers();
        
        this.emit('started');
        logger.info('Difficulty tracker started');
    }

    /**
     * Stop tracking
     */
    stop() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        
        // Clear all timers
        for (const timer of this.updateTimers.values()) {
            clearInterval(timer);
        }
        this.updateTimers.clear();
        
        this.emit('stopped');
        logger.info('Difficulty tracker stopped');
    }

    /**
     * Track a new coin
     */
    async trackCoin(coin, config = {}) {
        const coinConfig = {
            symbol: coin,
            updateInterval: config.updateInterval || this.config.updateInterval,
            ...config
        };
        
        // Initial update
        await this.updateDifficulty(coin);
        
        // Set up periodic updates
        if (this.isRunning) {
            const timer = setInterval(() => {
                this.updateDifficulty(coin);
            }, coinConfig.updateInterval);
            
            this.updateTimers.set(coin, timer);
        }
        
        this.emit('coin:tracked', coin);
    }

    /**
     * Stop tracking a coin
     */
    untrackCoin(coin) {
        const timer = this.updateTimers.get(coin);
        if (timer) {
            clearInterval(timer);
            this.updateTimers.delete(coin);
        }
        
        this.difficultyCache.delete(coin);
        this.hashRateCache.delete(coin);
        this.blockTimeCache.delete(coin);
        
        this.emit('coin:untracked', coin);
    }

    /**
     * Get current difficulty for a coin
     */
    async getDifficulty(coin) {
        const cached = this.difficultyCache.get(coin);
        
        if (cached && cached.timestamp > Date.now() - this.config.cacheExpiry) {
            return cached.value;
        }
        
        // Update if cache expired
        await this.updateDifficulty(coin);
        
        const updated = this.difficultyCache.get(coin);
        return updated ? updated.value : 0;
    }

    /**
     * Get network hashrate for a coin
     */
    async getNetworkHashrate(coin) {
        const cached = this.hashRateCache.get(coin);
        
        if (cached && cached.timestamp > Date.now() - this.config.cacheExpiry) {
            return cached.value;
        }
        
        // Calculate from difficulty and block time
        const difficulty = await this.getDifficulty(coin);
        const blockTime = this.getBlockTime(coin);
        
        // Network hashrate = difficulty * 2^32 / block_time
        const hashrate = (difficulty * Math.pow(2, 32)) / blockTime;
        
        this.hashRateCache.set(coin, {
            value: hashrate,
            timestamp: Date.now()
        });
        
        return hashrate;
    }

    /**
     * Update difficulty data for a coin
     */
    async updateDifficulty(coin) {
        try {
            // In production, would fetch from blockchain APIs or nodes
            // Using simulated data for now
            const difficulty = await this.fetchDifficulty(coin);
            
            this.difficultyCache.set(coin, {
                value: difficulty,
                timestamp: Date.now()
            });
            
            // Calculate and cache network hashrate
            const blockTime = this.getBlockTime(coin);
            const hashrate = (difficulty * Math.pow(2, 32)) / blockTime;
            
            this.hashRateCache.set(coin, {
                value: hashrate,
                timestamp: Date.now()
            });
            
            this.emit('difficulty:updated', {
                coin,
                difficulty,
                hashrate,
                timestamp: Date.now()
            });
            
        } catch (error) {
            logger.error(`Failed to update difficulty for ${coin}:`, error);
            this.emit('difficulty:error', { coin, error });
        }
    }

    /**
     * Fetch difficulty from network (simulated)
     */
    async fetchDifficulty(coin) {
        // Simulated difficulty values
        const difficulties = {
            BTC: 35.36e12,
            LTC: 13.73e6,
            ETH: 11.55e15,
            XMR: 333.49e9,
            RVN: 71.12e3,
            DASH: 147.38e6,
            ZEC: 59.96e6,
            ERGO: 1.65e15,
            KAS: 1.23e12,
            ALPH: 95.73e9
        };
        
        return difficulties[coin] || 1e9;
    }

    /**
     * Get block time for a coin
     */
    getBlockTime(coin) {
        const blockTimes = {
            BTC: 600,
            LTC: 150,
            ETH: 13,
            XMR: 120,
            RVN: 60,
            DASH: 150,
            ZEC: 75,
            ERGO: 120,
            KAS: 1,
            ALPH: 64
        };
        
        return blockTimes[coin] || 60;
    }

    /**
     * Start update timers for all tracked coins
     */
    startUpdateTimers() {
        const defaultCoins = ['BTC', 'LTC', 'ETH', 'XMR', 'RVN', 'DASH', 'ZEC', 'ERGO', 'KAS', 'ALPH'];
        
        for (const coin of defaultCoins) {
            this.trackCoin(coin);
        }
    }

    /**
     * Get difficulty history for a coin
     */
    getDifficultyHistory(coin, hours = 24) {
        // In production, would return historical data
        // For now, return simulated trend
        const current = this.difficultyCache.get(coin)?.value || 1e9;
        const history = [];
        
        for (let i = hours; i >= 0; i--) {
            const timestamp = Date.now() - i * 60 * 60 * 1000;
            const variation = 1 + (Math.random() - 0.5) * 0.1; // ±5% variation
            
            history.push({
                timestamp,
                difficulty: current * variation,
                hashrate: (current * variation * Math.pow(2, 32)) / this.getBlockTime(coin)
            });
        }
        
        return history;
    }

    /**
     * Get difficulty adjustment prediction
     */
    getDifficultyPrediction(coin) {
        const current = this.difficultyCache.get(coin)?.value || 0;
        const blockTime = this.getBlockTime(coin);
        const targetBlockTime = blockTime;
        
        // Simulate average block time (90-110% of target)
        const avgBlockTime = targetBlockTime * (0.9 + Math.random() * 0.2);
        
        // Calculate expected adjustment
        const adjustment = targetBlockTime / avgBlockTime;
        const nextDifficulty = current * adjustment;
        
        // Adjustment periods
        const adjustmentBlocks = {
            BTC: 2016,
            LTC: 2016,
            ETH: 1,
            XMR: 1,
            RVN: 2016,
            DASH: 1,
            ZEC: 1,
            ERGO: 1,
            KAS: 1,
            ALPH: 1
        };
        
        const blocksUntilAdjustment = Math.floor(Math.random() * (adjustmentBlocks[coin] || 1));
        const timeUntilAdjustment = blocksUntilAdjustment * blockTime;
        
        return {
            current,
            predicted: nextDifficulty,
            change: (adjustment - 1) * 100,
            blocksUntilAdjustment,
            timeUntilAdjustment,
            confidence: 0.7 + Math.random() * 0.3
        };
    }

    /**
     * Get statistics
     */
    getStats() {
        const trackedCoins = Array.from(this.difficultyCache.keys());
        
        return {
            isRunning: this.isRunning,
            trackedCoins: trackedCoins.length,
            coins: trackedCoins,
            cacheSize: this.difficultyCache.size,
            lastUpdate: Math.max(
                ...Array.from(this.difficultyCache.values()).map(c => c.timestamp || 0)
            )
        };
    }
}

export default DifficultyTracker;