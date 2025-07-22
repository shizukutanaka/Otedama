const EventEmitter = require('events');
const https = require('https');
const http = require('http');

class ProfitSwitcher extends EventEmitter {
    constructor(config) {
        super();
        this.config = {
            checkInterval: config.checkInterval || 300000, // 5 minutes
            switchThreshold: config.switchThreshold || 1.05, // 5% improvement required
            electricityCost: config.electricityCost || 0.10, // $/kWh
            apis: {
                whattomine: 'https://whattomine.com/coins.json',
                minerstat: 'https://api.minerstat.com/v2/coins',
                ...config.apis
            },
            coins: config.coins || [
                { symbol: 'BTC', algorithm: 'sha256', pool: 'stratum+tcp://btc.pool.com:3333' },
                { symbol: 'ETH', algorithm: 'ethash', pool: 'stratum+tcp://eth.pool.com:4444' },
                { symbol: 'RVN', algorithm: 'kawpow', pool: 'stratum+tcp://rvn.pool.com:3333' }
            ],
            hardware: config.hardware || {
                type: 'GPU',
                model: 'RTX 3080',
                hashrates: {
                    sha256: 0,
                    ethash: 100000000, // 100 MH/s
                    kawpow: 40000000,  // 40 MH/s
                    scrypt: 0
                },
                power: {
                    sha256: 0,
                    ethash: 320,
                    kawpow: 350,
                    scrypt: 0
                }
            },
            ...config
        };
        
        this.currentCoin = null;
        this.profitHistory = [];
        this.priceCache = new Map();
        this.switchCount = 0;
        this.isChecking = false;
    }
    
    async start() {
        // Initial profitability check
        await this.checkProfitability();
        
        // Start periodic checks
        this.checkInterval = setInterval(async () => {
            await this.checkProfitability();
        }, this.config.checkInterval);
        
        this.emit('started');
    }
    
    async checkProfitability() {
        if (this.isChecking) return;
        this.isChecking = true;
        
        try {
            // Get current coin prices and difficulties
            const marketData = await this.fetchMarketData();
            
            // Calculate profitability for each coin
            const profitabilities = [];
            
            for (const coin of this.config.coins) {
                const profitability = await this.calculateProfitability(coin, marketData);
                if (profitability) {
                    profitabilities.push(profitability);
                }
            }
            
            // Sort by profitability
            profitabilities.sort((a, b) => b.dailyProfit - a.dailyProfit);
            
            // Check if we should switch
            if (profitabilities.length > 0) {
                const best = profitabilities[0];
                
                if (this.shouldSwitch(best)) {
                    await this.switchToCoin(best);
                }
                
                // Store history
                this.profitHistory.push({
                    timestamp: Date.now(),
                    profitabilities: profitabilities,
                    currentCoin: this.currentCoin
                });
                
                // Limit history size
                if (this.profitHistory.length > 288) { // 24 hours at 5 min intervals
                    this.profitHistory.shift();
                }
                
                this.emit('profitability-update', {
                    current: this.currentCoin,
                    profitabilities: profitabilities
                });
            }
            
        } catch (err) {
            this.emit('error', err);
        } finally {
            this.isChecking = false;
        }
    }
    
    async fetchMarketData() {
        const marketData = {};
        
        try {
            // Fetch from multiple sources for reliability
            const [whattomine, minerstat] = await Promise.allSettled([
                this.fetchWhatToMine(),
                this.fetchMinerstat()
            ]);
            
            // Merge data from successful sources
            if (whattomine.status === 'fulfilled') {
                Object.assign(marketData, whattomine.value);
            }
            
            if (minerstat.status === 'fulfilled') {
                Object.assign(marketData, minerstat.value);
            }
            
            // Add exchange rates
            const exchangeRates = await this.fetchExchangeRates();
            marketData.exchangeRates = exchangeRates;
            
        } catch (err) {
            // Use cached data if fetch fails
            for (const [coin, data] of this.priceCache) {
                if (Date.now() - data.timestamp < 3600000) { // 1 hour cache
                    marketData[coin] = data;
                }
            }
        }
        
        return marketData;
    }
    
    async fetchWhatToMine() {
        return new Promise((resolve, reject) => {
            https.get(this.config.apis.whattomine, res => {
                let data = '';
                
                res.on('data', chunk => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const marketData = {};
                        
                        if (json.coins) {
                            for (const [name, coin] of Object.entries(json.coins)) {
                                marketData[coin.tag] = {
                                    price: parseFloat(coin.exchange_rate),
                                    difficulty: parseFloat(coin.difficulty),
                                    blockReward: parseFloat(coin.block_reward),
                                    blockTime: parseFloat(coin.block_time),
                                    nethash: parseFloat(coin.nethash),
                                    timestamp: Date.now()
                                };
                            }
                        }
                        
                        resolve(marketData);
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', reject);
        });
    }
    
    async fetchMinerstat() {
        return new Promise((resolve, reject) => {
            https.get(this.config.apis.minerstat, res => {
                let data = '';
                
                res.on('data', chunk => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const marketData = {};
                        
                        for (const coin of json) {
                            marketData[coin.coin] = {
                                price: coin.price,
                                difficulty: coin.difficulty,
                                blockReward: coin.reward,
                                blockTime: coin.blockTime,
                                nethash: coin.networkHashrate,
                                timestamp: Date.now()
                            };
                        }
                        
                        resolve(marketData);
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', reject);
        });
    }
    
    async fetchExchangeRates() {
        // Simplified - fetch USD exchange rates
        return {
            BTC: 45000,
            ETH: 3000,
            RVN: 0.05
        };
    }
    
    calculateProfitability(coin, marketData) {
        const coinData = marketData[coin.symbol];
        if (!coinData) return null;
        
        const hashrate = this.config.hardware.hashrates[coin.algorithm];
        const power = this.config.hardware.power[coin.algorithm];
        
        if (!hashrate || hashrate === 0) return null;
        
        // Calculate expected coins per day
        const networkHashrate = coinData.nethash;
        const blockReward = coinData.blockReward;
        const blocksPerDay = 86400 / coinData.blockTime;
        
        const myShareOfNetwork = hashrate / networkHashrate;
        const expectedCoinsPerDay = myShareOfNetwork * blockReward * blocksPerDay;
        
        // Calculate revenue
        const coinPrice = coinData.price || marketData.exchangeRates[coin.symbol] || 0;
        const dailyRevenue = expectedCoinsPerDay * coinPrice;
        
        // Calculate costs
        const dailyPowerKwh = (power * 24) / 1000;
        const dailyCost = dailyPowerKwh * this.config.electricityCost;
        
        // Calculate profit
        const dailyProfit = dailyRevenue - dailyCost;
        const profitPercentage = (dailyProfit / dailyCost) * 100;
        
        // Update cache
        this.priceCache.set(coin.symbol, {
            ...coinData,
            timestamp: Date.now()
        });
        
        return {
            coin: coin.symbol,
            algorithm: coin.algorithm,
            pool: coin.pool,
            hashrate: hashrate,
            power: power,
            expectedCoinsPerDay: expectedCoinsPerDay,
            coinPrice: coinPrice,
            dailyRevenue: dailyRevenue,
            dailyCost: dailyCost,
            dailyProfit: dailyProfit,
            profitPercentage: profitPercentage,
            difficulty: coinData.difficulty,
            networkHashrate: networkHashrate
        };
    }
    
    shouldSwitch(bestCoin) {
        // Don't switch if no current coin
        if (!this.currentCoin) return true;
        
        // Don't switch to the same coin
        if (this.currentCoin.coin === bestCoin.coin) return false;
        
        // Check if improvement is above threshold
        const currentProfit = this.currentCoin.dailyProfit;
        const improvement = bestCoin.dailyProfit / currentProfit;
        
        if (improvement < this.config.switchThreshold) {
            return false;
        }
        
        // Check switch frequency (avoid switching too often)
        const recentSwitches = this.profitHistory
            .slice(-12) // Last hour
            .filter(h => h.switched)
            .length;
        
        if (recentSwitches >= 3) {
            return false; // Max 3 switches per hour
        }
        
        return true;
    }
    
    async switchToCoin(coin) {
        const previousCoin = this.currentCoin;
        this.currentCoin = coin;
        this.switchCount++;
        
        this.emit('switching', {
            from: previousCoin,
            to: coin,
            reason: `Higher profitability: $${coin.dailyProfit.toFixed(2)}/day`,
            improvement: previousCoin ? 
                ((coin.dailyProfit / previousCoin.dailyProfit - 1) * 100).toFixed(2) + '%' : 
                'Initial selection'
        });
        
        // Mark switch in history
        if (this.profitHistory.length > 0) {
            this.profitHistory[this.profitHistory.length - 1].switched = true;
        }
    }
    
    getStats() {
        const stats = {
            currentCoin: this.currentCoin,
            switchCount: this.switchCount,
            uptime: this.checkInterval ? Date.now() - this.profitHistory[0]?.timestamp : 0,
            averageDailyProfit: 0,
            bestCoin: null,
            worstCoin: null
        };
        
        // Calculate average profit from history
        if (this.profitHistory.length > 0) {
            let totalProfit = 0;
            let bestProfit = -Infinity;
            let worstProfit = Infinity;
            
            for (const entry of this.profitHistory) {
                if (entry.currentCoin) {
                    totalProfit += entry.currentCoin.dailyProfit;
                    
                    if (entry.currentCoin.dailyProfit > bestProfit) {
                        bestProfit = entry.currentCoin.dailyProfit;
                        stats.bestCoin = entry.currentCoin;
                    }
                    
                    if (entry.currentCoin.dailyProfit < worstProfit) {
                        worstProfit = entry.currentCoin.dailyProfit;
                        stats.worstCoin = entry.currentCoin;
                    }
                }
            }
            
            stats.averageDailyProfit = totalProfit / this.profitHistory.length;
        }
        
        return stats;
    }
    
    getProfitHistory(hours = 24) {
        const cutoff = Date.now() - (hours * 3600000);
        return this.profitHistory.filter(entry => entry.timestamp > cutoff);
    }
    
    async manualSwitch(coinSymbol) {
        const coin = this.config.coins.find(c => c.symbol === coinSymbol);
        if (!coin) {
            throw new Error(`Coin ${coinSymbol} not configured`);
        }
        
        const marketData = await this.fetchMarketData();
        const profitability = await this.calculateProfitability(coin, marketData);
        
        if (profitability) {
            await this.switchToCoin(profitability);
        }
    }
    
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        
        this.emit('stopped');
    }
}

// Profit optimizer for specific algorithms
class AlgorithmOptimizer {
    constructor(algorithm) {
        this.algorithm = algorithm;
        this.optimizations = new Map();
    }
    
    async optimizeForHardware(hardware) {
        switch (this.algorithm) {
            case 'ethash':
                return this.optimizeEthash(hardware);
            case 'kawpow':
                return this.optimizeKawpow(hardware);
            case 'sha256':
                return this.optimizeSha256(hardware);
            default:
                return {};
        }
    }
    
    optimizeEthash(hardware) {
        const optimizations = {
            intensity: 0,
            memoryTiming: 'auto',
            coreOffset: 0,
            memoryOffset: 0,
            powerLimit: 100
        };
        
        if (hardware.model.includes('3080')) {
            optimizations.memoryOffset = 1000;
            optimizations.powerLimit = 70;
            optimizations.coreOffset = -200;
        } else if (hardware.model.includes('3070')) {
            optimizations.memoryOffset = 1200;
            optimizations.powerLimit = 60;
            optimizations.coreOffset = -500;
        }
        
        return optimizations;
    }
    
    optimizeKawpow(hardware) {
        const optimizations = {
            intensity: 0,
            coreOffset: 100,
            memoryOffset: 500,
            powerLimit: 80
        };
        
        return optimizations;
    }
    
    optimizeSha256(hardware) {
        // SHA256 is mainly for ASICs
        return {
            frequency: 'auto',
            voltage: 'auto'
        };
    }
}

module.exports = {
    ProfitSwitcher,
    AlgorithmOptimizer
};