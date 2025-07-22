const { EventEmitter } = require('events');
const axios = require('axios');

/**
 * 収益性計算と自動切替を管理
 */
class ProfitCalculator extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            updateInterval: config.updateInterval || 300000, // 5分
            switchThreshold: config.switchThreshold || 0.05, // 5%以上の差で切替
            cooldownPeriod: config.cooldownPeriod || 1800000, // 30分
            apis: {
                whattomine: 'https://whattomine.com/coins.json',
                coinmarketcap: 'https://api.coinmarketcap.com/v1/ticker/',
                difficulty: {}
            },
            ...config
        };
        
        this.coins = new Map();
        this.currentCoin = null;
        this.lastSwitch = 0;
        this.updateTimer = null;
        
        this.initializeCoins();
    }
    
    /**
     * 対応通貨の初期化
     */
    initializeCoins() {
        const defaultCoins = [
            {
                symbol: 'BTC',
                name: 'Bitcoin',
                algorithm: 'sha256',
                blockTime: 600,
                blockReward: 6.25,
                endpoint: 'http://localhost:8332'
            },
            {
                symbol: 'LTC',
                name: 'Litecoin',
                algorithm: 'scrypt',
                blockTime: 150,
                blockReward: 12.5,
                endpoint: 'http://localhost:9332'
            },
            {
                symbol: 'ETH',
                name: 'Ethereum',
                algorithm: 'ethash',
                blockTime: 13,
                blockReward: 2,
                endpoint: 'http://localhost:8545'
            },
            {
                symbol: 'RVN',
                name: 'Ravencoin',
                algorithm: 'kawpow',
                blockTime: 60,
                blockReward: 5000,
                endpoint: 'http://localhost:8766'
            },
            {
                symbol: 'XMR',
                name: 'Monero',
                algorithm: 'randomx',
                blockTime: 120,
                blockReward: 0.6,
                endpoint: 'http://localhost:18081'
            }
        ];
        
        defaultCoins.forEach(coin => {
            this.coins.set(coin.symbol, {
                ...coin,
                difficulty: 0,
                price: 0,
                profitability: 0,
                hashrate: 0
            });
        });
    }
    
    /**
     * 収益性の自動更新を開始
     */
    start() {
        this.updateProfitability();
        this.updateTimer = setInterval(() => {
            this.updateProfitability();
        }, this.config.updateInterval);
        
        this.emit('started');
    }
    
    /**
     * 停止
     */
    stop() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
        
        this.emit('stopped');
    }
    
    /**
     * 収益性データを更新
     */
    async updateProfitability() {
        try {
            // 価格データの取得
            await this.updatePrices();
            
            // 難易度データの取得
            await this.updateDifficulties();
            
            // 各通貨の収益性を計算
            for (const [symbol, coin] of this.coins) {
                coin.profitability = this.calculateProfitability(coin);
            }
            
            // 最適な通貨を選択
            const bestCoin = this.selectBestCoin();
            
            // 切替判定
            if (this.shouldSwitch(bestCoin)) {
                await this.switchCoin(bestCoin);
            }
            
            this.emit('updated', {
                coins: Array.from(this.coins.values()),
                current: this.currentCoin,
                best: bestCoin
            });
            
        } catch (error) {
            this.emit('error', error);
        }
    }
    
    /**
     * 価格データを更新
     */
    async updatePrices() {
        // 実際のAPIコールは本番環境で実装
        // ここではモックデータを使用
        const mockPrices = {
            BTC: 43000,
            LTC: 105,
            ETH: 2500,
            RVN: 0.02,
            XMR: 150
        };
        
        for (const [symbol, price] of Object.entries(mockPrices)) {
            const coin = this.coins.get(symbol);
            if (coin) {
                coin.price = price;
            }
        }
    }
    
    /**
     * 難易度データを更新
     */
    async updateDifficulties() {
        // 実際のブロックチェーンからの取得は本番環境で実装
        const mockDifficulties = {
            BTC: 25000000000000,
            LTC: 13000000,
            ETH: 8000000000000000,
            RVN: 75000,
            XMR: 300000000000
        };
        
        for (const [symbol, difficulty] of Object.entries(mockDifficulties)) {
            const coin = this.coins.get(symbol);
            if (coin) {
                coin.difficulty = difficulty;
            }
        }
    }
    
    /**
     * 収益性を計算（USD/日/単位ハッシュレート）
     */
    calculateProfitability(coin) {
        if (!coin.difficulty || !coin.price || !coin.hashrate) {
            return 0;
        }
        
        // 1日あたりのブロック数
        const blocksPerDay = 86400 / coin.blockTime;
        
        // プールのシェア（仮定）
        const poolShare = coin.hashrate / this.getNetworkHashrate(coin);
        
        // 期待ブロック数
        const expectedBlocks = blocksPerDay * poolShare;
        
        // 収益（USD/日）
        const revenue = expectedBlocks * coin.blockReward * coin.price;
        
        // 単位ハッシュレートあたりの収益
        return revenue / coin.hashrate;
    }
    
    /**
     * ネットワーク全体のハッシュレートを推定
     */
    getNetworkHashrate(coin) {
        // 簡易計算（実際はもっと複雑）
        return coin.difficulty * Math.pow(2, 32) / coin.blockTime;
    }
    
    /**
     * 最も収益性の高い通貨を選択
     */
    selectBestCoin() {
        let bestCoin = null;
        let bestProfitability = 0;
        
        for (const coin of this.coins.values()) {
            if (coin.profitability > bestProfitability) {
                bestProfitability = coin.profitability;
                bestCoin = coin;
            }
        }
        
        return bestCoin;
    }
    
    /**
     * 通貨切替の判定
     */
    shouldSwitch(newCoin) {
        if (!newCoin || !this.currentCoin) {
            return true;
        }
        
        // クールダウン期間中は切替しない
        if (Date.now() - this.lastSwitch < this.config.cooldownPeriod) {
            return false;
        }
        
        // 現在の通貨と同じ場合は切替不要
        if (newCoin.symbol === this.currentCoin.symbol) {
            return false;
        }
        
        // 閾値以上の改善がある場合のみ切替
        const improvement = (newCoin.profitability - this.currentCoin.profitability) / this.currentCoin.profitability;
        return improvement > this.config.switchThreshold;
    }
    
    /**
     * 通貨を切替
     */
    async switchCoin(newCoin) {
        const oldCoin = this.currentCoin;
        
        this.emit('switching', {
            from: oldCoin,
            to: newCoin,
            reason: 'profitability'
        });
        
        try {
            // 実際の切替処理はプールマネージャーが実行
            this.currentCoin = newCoin;
            this.lastSwitch = Date.now();
            
            this.emit('switched', {
                from: oldCoin,
                to: newCoin,
                profitability: newCoin.profitability
            });
            
        } catch (error) {
            this.emit('switch-failed', {
                from: oldCoin,
                to: newCoin,
                error
            });
        }
    }
    
    /**
     * 手動で通貨を設定
     */
    setCoin(symbol) {
        const coin = this.coins.get(symbol);
        if (!coin) {
            throw new Error(`Unknown coin: ${symbol}`);
        }
        
        this.currentCoin = coin;
        this.lastSwitch = Date.now();
        
        this.emit('switched', {
            from: null,
            to: coin,
            manual: true
        });
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        const coins = Array.from(this.coins.values())
            .sort((a, b) => b.profitability - a.profitability);
        
        return {
            current: this.currentCoin,
            coins,
            lastSwitch: this.lastSwitch,
            nextUpdate: this.updateTimer ? Date.now() + this.config.updateInterval : null
        };
    }
    
    /**
     * 特定の通貨のハッシュレートを更新
     */
    updateHashrate(symbol, hashrate) {
        const coin = this.coins.get(symbol);
        if (coin) {
            coin.hashrate = hashrate;
            coin.profitability = this.calculateProfitability(coin);
        }
    }
}

module.exports = ProfitCalculator;