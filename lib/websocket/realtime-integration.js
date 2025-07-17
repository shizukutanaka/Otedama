/**
 * Real-time WebSocket Integration
 * Connects WebSocket servers with application components
 */

import { MiningStatsServer, DexDataServer } from './realtime-server.js';
import { EventEmitter } from 'events';

export class RealtimeIntegration extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            miningPort: config.miningPort || 8081,
            dexPort: config.dexPort || 8082,
            updateIntervals: {
                poolStats: config.poolStatsInterval || 5000,
                minerStats: config.minerStatsInterval || 10000,
                orderBook: config.orderBookInterval || 1000,
                ticker: config.tickerInterval || 2000,
                defiPools: config.defiPoolsInterval || 30000
            },
            ...config
        };
        
        this.miningServer = null;
        this.dexServer = null;
        this.updateTimers = new Map();
        this.dataProviders = new Map();
    }

    /**
     * Initialize WebSocket servers
     */
    async initialize() {
        // Initialize mining stats server
        this.miningServer = new MiningStatsServer({
            port: this.config.miningPort
        });
        
        // Initialize DEX data server
        this.dexServer = new DexDataServer({
            port: this.config.dexPort
        });
        
        // Start servers
        this.miningServer.start();
        this.dexServer.start();
        
        // Setup update loops
        this.setupUpdateLoops();
        
        this.emit('initialized');
    }

    /**
     * Shutdown servers
     */
    async shutdown() {
        // Clear update timers
        this.updateTimers.forEach(timer => clearInterval(timer));
        this.updateTimers.clear();
        
        // Stop servers
        if (this.miningServer) {
            this.miningServer.stop();
        }
        
        if (this.dexServer) {
            this.dexServer.stop();
        }
        
        this.emit('shutdown');
    }

    /**
     * Register data provider
     */
    registerDataProvider(name, provider) {
        this.dataProviders.set(name, provider);
    }

    /**
     * Setup automatic update loops
     */
    setupUpdateLoops() {
        // Pool statistics updates
        this.setupUpdateTimer('poolStats', async () => {
            const poolProvider = this.dataProviders.get('pool');
            if (!poolProvider) return;
            
            try {
                const stats = await poolProvider.getPoolStats();
                this.miningServer.broadcastPoolStats(stats);
            } catch (error) {
                console.error('Pool stats update error:', error);
            }
        });
        
        // Miner statistics updates
        this.setupUpdateTimer('minerStats', async () => {
            const poolProvider = this.dataProviders.get('pool');
            if (!poolProvider) return;
            
            try {
                const activeMiners = await poolProvider.getActiveMiners();
                
                for (const minerId of activeMiners) {
                    const stats = await poolProvider.getMinerStats(minerId);
                    this.miningServer.broadcastMinerStats(minerId, stats);
                }
            } catch (error) {
                console.error('Miner stats update error:', error);
            }
        });
        
        // Order book updates
        this.setupUpdateTimer('orderBook', async () => {
            const dexProvider = this.dataProviders.get('dex');
            if (!dexProvider) return;
            
            try {
                const pairs = await dexProvider.getActivePairs();
                
                for (const pair of pairs) {
                    const orderbook = await dexProvider.getOrderBook(pair);
                    this.dexServer.broadcastOrderBook(pair, orderbook);
                }
            } catch (error) {
                console.error('Order book update error:', error);
            }
        });
        
        // Ticker updates
        this.setupUpdateTimer('ticker', async () => {
            const dexProvider = this.dataProviders.get('dex');
            if (!dexProvider) return;
            
            try {
                const pairs = await dexProvider.getActivePairs();
                
                for (const pair of pairs) {
                    const ticker = await dexProvider.getTicker(pair);
                    this.dexServer.broadcastTicker(pair, ticker);
                }
            } catch (error) {
                console.error('Ticker update error:', error);
            }
        });
        
        // DeFi pool updates
        this.setupUpdateTimer('defiPools', async () => {
            const defiProvider = this.dataProviders.get('defi');
            if (!defiProvider) return;
            
            try {
                const pools = await defiProvider.getActivePools();
                
                for (const pool of pools) {
                    const data = await defiProvider.getPoolData(pool.id);
                    this.dexServer.broadcastPoolUpdate(pool.id, data);
                }
            } catch (error) {
                console.error('DeFi pool update error:', error);
            }
        });
    }

    /**
     * Setup update timer
     */
    setupUpdateTimer(name, handler) {
        const interval = this.config.updateIntervals[name];
        if (!interval) return;
        
        const timer = setInterval(handler, interval);
        this.updateTimers.set(name, timer);
        
        // Run immediately
        handler();
    }

    /**
     * Manual broadcasts
     */
    
    // Mining events
    broadcastBlockFound(block) {
        if (this.miningServer) {
            this.miningServer.broadcastBlockFound(block);
        }
    }
    
    broadcastShareSubmitted(minerId, share) {
        if (this.miningServer) {
            this.miningServer.broadcast(`miner:shares:${minerId}`, share);
        }
    }
    
    broadcastPayment(payment) {
        if (this.miningServer) {
            this.miningServer.broadcast('pool:payments', payment);
        }
    }
    
    // DEX events
    broadcastTrade(trade) {
        if (this.dexServer) {
            this.dexServer.broadcastTrade(trade);
        }
    }
    
    broadcastOrderUpdate(pair, order) {
        if (this.dexServer) {
            this.dexServer.broadcast(`dex:orders:${pair}`, order);
        }
    }
    
    // DeFi events
    broadcastStakeUpdate(poolId, stake) {
        if (this.dexServer) {
            this.dexServer.broadcast(`defi:stake:${poolId}`, stake);
        }
    }
    
    broadcastYieldUpdate(poolId, yield_) {
        if (this.dexServer) {
            this.dexServer.broadcast(`defi:yield:${poolId}`, yield_);
        }
    }

    /**
     * Get server statistics
     */
    getStats() {
        return {
            mining: this.miningServer ? this.miningServer.getStats() : null,
            dex: this.dexServer ? this.dexServer.getStats() : null,
            updateTimers: this.updateTimers.size,
            dataProviders: this.dataProviders.size
        };
    }
}

/**
 * Mock data providers for testing
 */
export class MockPoolDataProvider {
    async getPoolStats() {
        return {
            hashrate: Math.floor(Math.random() * 1000000000),
            miners: Math.floor(Math.random() * 1000),
            workers: Math.floor(Math.random() * 2000),
            shares: {
                valid: Math.floor(Math.random() * 10000),
                invalid: Math.floor(Math.random() * 100)
            },
            blocks: {
                found: Math.floor(Math.random() * 10),
                pending: Math.floor(Math.random() * 5)
            },
            efficiency: 95 + Math.random() * 5,
            uptime: Date.now() - 86400000
        };
    }
    
    async getActiveMiners() {
        return ['miner1', 'miner2', 'miner3'];
    }
    
    async getMinerStats(minerId) {
        return {
            hashrate: Math.floor(Math.random() * 1000000),
            shares: {
                valid: Math.floor(Math.random() * 1000),
                invalid: Math.floor(Math.random() * 10)
            },
            lastShare: Date.now() - Math.floor(Math.random() * 60000),
            balance: Math.random() * 0.1,
            workers: Math.floor(Math.random() * 10) + 1
        };
    }
}

export class MockDexDataProvider {
    async getActivePairs() {
        return ['BTC-USDT', 'ETH-USDT', 'BTC-ETH'];
    }
    
    async getOrderBook(pair) {
        const generateOrders = (count, basePrice, increment) => {
            return Array.from({ length: count }, (_, i) => ({
                price: basePrice + (i * increment),
                amount: Math.random() * 10,
                total: 0
            }));
        };
        
        const midPrice = 50000;
        
        return {
            bids: generateOrders(10, midPrice - 100, -10),
            asks: generateOrders(10, midPrice + 10, 10),
            spread: {
                bid: midPrice - 10,
                ask: midPrice + 10,
                spread: 20,
                spreadPercent: 0.04
            }
        };
    }
    
    async getTicker(pair) {
        const base = 50000;
        const change = (Math.random() - 0.5) * 0.1;
        
        return {
            last: base * (1 + change),
            bid: base * (1 + change - 0.001),
            ask: base * (1 + change + 0.001),
            high24h: base * 1.05,
            low24h: base * 0.95,
            volume24h: Math.random() * 1000,
            change24h: change
        };
    }
}

export class MockDefiDataProvider {
    async getActivePools() {
        return [
            { id: 'pool1', name: 'BTC-USDT LP' },
            { id: 'pool2', name: 'ETH-USDT LP' },
            { id: 'pool3', name: 'MULTI-ASSET' }
        ];
    }
    
    async getPoolData(poolId) {
        return {
            liquidity: Math.floor(Math.random() * 10000000),
            volume24h: Math.floor(Math.random() * 1000000),
            fees24h: Math.floor(Math.random() * 10000),
            apy: Math.random() * 100,
            reserves: {
                token0: Math.random() * 1000,
                token1: Math.random() * 1000000
            }
        };
    }
}

/**
 * Utility functions
 */
export function createRealtimeIntegration(app, config = {}) {
    const integration = new RealtimeIntegration(config);
    
    // Register with application
    app.realtime = integration;
    
    // Setup event forwarding
    app.on('block:found', (block) => {
        integration.broadcastBlockFound(block);
    });
    
    app.on('share:submitted', (minerId, share) => {
        integration.broadcastShareSubmitted(minerId, share);
    });
    
    app.on('trade:executed', (trade) => {
        integration.broadcastTrade(trade);
    });
    
    return integration;
}

export default RealtimeIntegration;