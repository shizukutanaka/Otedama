const express = require('express');
const router = express.Router();

/**
 * ダッシュボードAPI
 */
class DashboardAPI {
    constructor(poolManager, realtimeStats, profitSwitcher) {
        this.poolManager = poolManager;
        this.realtimeStats = realtimeStats;
        this.profitSwitcher = profitSwitcher;
        
        this.setupRoutes();
    }
    
    /**
     * ルートを設定
     */
    setupRoutes() {
        // ダッシュボード概要
        router.get('/overview', (req, res) => {
            res.json(this.getOverview());
        });
        
        // リアルタイム統計
        router.get('/realtime', (req, res) => {
            res.json(this.getRealtimeStats());
        });
        
        // 履歴データ
        router.get('/history/:metric', (req, res) => {
            const { metric } = req.params;
            const { period = 3600 } = req.query;
            
            res.json(this.getHistory(metric, parseInt(period)));
        });
        
        // マイナーランキング
        router.get('/miners/top', (req, res) => {
            const { limit = 10 } = req.query;
            
            res.json(this.getTopMiners(parseInt(limit)));
        });
        
        // 収益予測
        router.get('/revenue/forecast', (req, res) => {
            const { period = 'day' } = req.query;
            
            res.json(this.getRevenueForecast(period));
        });
        
        // ハードウェア効率
        router.get('/efficiency', (req, res) => {
            res.json(this.getEfficiencyMetrics());
        });
        
        // プール比較
        router.get('/comparison', (req, res) => {
            res.json(this.getPoolComparison());
        });
        
        // アラート設定
        router.get('/alerts', (req, res) => {
            res.json(this.getAlerts());
        });
        
        router.post('/alerts', (req, res) => {
            const alert = this.createAlert(req.body);
            res.json(alert);
        });
        
        // エクスポート
        router.get('/export/:format', (req, res) => {
            const { format } = req.params;
            const { period = 'day' } = req.query;
            
            const data = this.exportData(format, period);
            
            if (format === 'csv') {
                res.header('Content-Type', 'text/csv');
                res.attachment(`otedama-stats-${period}.csv`);
            } else {
                res.header('Content-Type', 'application/json');
            }
            
            res.send(data);
        });
    }
    
    /**
     * ダッシュボード概要を取得
     */
    getOverview() {
        const poolStats = this.poolManager.getStats();
        const profitStats = this.profitSwitcher.getStats();
        
        return {
            pool: {
                hashrate: {
                    current: poolStats.hashrate,
                    unit: 'H/s',
                    formatted: this.formatHashrate(poolStats.hashrate),
                    trend: this.calculateTrend('hashrate.total')
                },
                miners: {
                    active: poolStats.activeMinerCount,
                    total: poolStats.totalMinerCount,
                    trend: this.calculateTrend('miners.active')
                },
                efficiency: {
                    current: poolStats.efficiency,
                    target: 98,
                    status: poolStats.efficiency > 95 ? 'good' : 'warning'
                }
            },
            blockchain: {
                height: poolStats.blockchainHeight,
                difficulty: poolStats.networkDifficulty,
                nextRetarget: poolStats.nextDifficultyRetarget
            },
            earnings: {
                today: this.calculateEarnings('today'),
                yesterday: this.calculateEarnings('yesterday'),
                week: this.calculateEarnings('week'),
                month: this.calculateEarnings('month')
            },
            profitSwitching: {
                enabled: profitStats.enabled,
                currentCoin: profitStats.currentAlgorithm,
                nextSwitch: profitStats.pendingSwitch
            }
        };
    }
    
    /**
     * リアルタイム統計を取得
     */
    getRealtimeStats() {
        const snapshot = this.realtimeStats.getSnapshot();
        
        return {
            timestamp: snapshot.timestamp,
            hashrate: {
                total: snapshot.metrics['hashrate.total'].current,
                perMiner: snapshot.metrics['hashrate.average'].current,
                distribution: this.getHashrateDistribution()
            },
            shares: {
                rate: this.calculateShareRate(),
                valid: snapshot.metrics['shares.valid'].current,
                invalid: snapshot.metrics['shares.invalid'].current,
                stale: snapshot.metrics['shares.stale'].current,
                efficiency: this.calculateShareEfficiency()
            },
            blocks: {
                found: snapshot.metrics['blocks.found'].current,
                expected: this.calculateExpectedBlocks(),
                luck: this.calculateLuck(),
                lastFound: this.getLastBlockTime()
            },
            network: {
                difficulty: snapshot.metrics['network.difficulty'].current,
                hashrate: snapshot.metrics['network.hashrate'].current,
                poolShare: this.calculatePoolShare()
            }
        };
    }
    
    /**
     * 履歴データを取得
     */
    getHistory(metric, period) {
        const history = this.realtimeStats.history.get(metric);
        if (!history) {
            return { error: 'Unknown metric' };
        }
        
        const now = Date.now();
        const startTime = now - (period * 1000);
        
        const data = history
            .filter(entry => entry.timestamp >= startTime)
            .map(entry => ({
                time: entry.timestamp,
                value: entry.value
            }));
        
        // データを集約（大きな期間の場合）
        const aggregated = this.aggregateData(data, period);
        
        return {
            metric,
            period,
            data: aggregated,
            summary: {
                min: Math.min(...aggregated.map(d => d.value)),
                max: Math.max(...aggregated.map(d => d.value)),
                avg: aggregated.reduce((sum, d) => sum + d.value, 0) / aggregated.length
            }
        };
    }
    
    /**
     * トップマイナーを取得
     */
    getTopMiners(limit) {
        const miners = this.poolManager.getAllMiners();
        
        const sorted = miners
            .map(miner => ({
                address: miner.address,
                hashrate: miner.hashrate,
                shares: {
                    valid: miner.validShares,
                    invalid: miner.invalidShares
                },
                efficiency: (miner.validShares / (miner.validShares + miner.invalidShares)) * 100,
                earnings: {
                    pending: miner.pendingBalance,
                    paid: miner.totalPaid
                },
                workers: miner.workers.length,
                uptime: this.calculateMinerUptime(miner)
            }))
            .sort((a, b) => b.hashrate - a.hashrate)
            .slice(0, limit);
        
        return {
            miners: sorted,
            total: miners.length,
            poolHashrate: sorted.reduce((sum, m) => sum + m.hashrate, 0)
        };
    }
    
    /**
     * 収益予測を計算
     */
    getRevenueForecast(period) {
        const currentHashrate = this.poolManager.getTotalHashrate();
        const difficulty = this.realtimeStats.metrics.get('network.difficulty').current;
        const blockReward = 6.25; // BTC
        const price = 43000; // USD
        
        const periods = {
            hour: 1,
            day: 24,
            week: 168,
            month: 720
        };
        
        const hours = periods[period] || 24;
        
        // 期待ブロック数を計算
        const expectedBlocks = this.calculateExpectedBlocks(currentHashrate, difficulty, hours);
        
        // 収益を計算
        const btcRevenue = expectedBlocks * blockReward * (1 - this.poolManager.config.fee);
        const usdRevenue = btcRevenue * price;
        
        // 変動シナリオ
        const scenarios = {
            pessimistic: {
                blocks: expectedBlocks * 0.7,
                btc: btcRevenue * 0.7,
                usd: usdRevenue * 0.7
            },
            expected: {
                blocks: expectedBlocks,
                btc: btcRevenue,
                usd: usdRevenue
            },
            optimistic: {
                blocks: expectedBlocks * 1.3,
                btc: btcRevenue * 1.3,
                usd: usdRevenue * 1.3
            }
        };
        
        return {
            period,
            hashrate: currentHashrate,
            scenarios,
            factors: {
                difficulty: difficulty,
                blockReward: blockReward,
                btcPrice: price,
                poolFee: this.poolManager.config.fee
            }
        };
    }
    
    /**
     * 効率メトリクスを取得
     */
    getEfficiencyMetrics() {
        const miners = this.poolManager.getAllMiners();
        
        // ワーカー別の効率を計算
        const workerEfficiency = [];
        
        miners.forEach(miner => {
            miner.workers.forEach(worker => {
                const efficiency = (worker.validShares / (worker.validShares + worker.invalidShares)) * 100;
                const powerEfficiency = worker.hashrate / (worker.power || 1);
                
                workerEfficiency.push({
                    miner: miner.address,
                    worker: worker.name,
                    hashrate: worker.hashrate,
                    efficiency: efficiency,
                    powerEfficiency: powerEfficiency,
                    algorithm: worker.algorithm
                });
            });
        });
        
        // アルゴリズム別の集計
        const byAlgorithm = this.groupByAlgorithm(workerEfficiency);
        
        return {
            overall: {
                shareEfficiency: this.calculateShareEfficiency(),
                powerEfficiency: this.calculatePowerEfficiency(),
                uptimePercent: this.calculateUptime()
            },
            byAlgorithm,
            topPerformers: workerEfficiency
                .sort((a, b) => b.efficiency - a.efficiency)
                .slice(0, 10),
            recommendations: this.generateEfficiencyRecommendations(workerEfficiency)
        };
    }
    
    /**
     * 他プールとの比較
     */
    getPoolComparison() {
        // 実際のデータは外部APIから取得
        const competitors = [
            { name: 'F2Pool', hashrate: 20000000000000, fee: 0.025, pps: false },
            { name: 'Slush Pool', hashrate: 15000000000000, fee: 0.02, pps: false },
            { name: 'ViaBTC', hashrate: 18000000000000, fee: 0.04, pps: true }
        ];
        
        const ourPool = {
            name: 'Otedama',
            hashrate: this.poolManager.getTotalHashrate(),
            fee: this.poolManager.config.fee,
            pps: false,
            features: ['Auto-switch', 'P2P', 'Low latency', 'No registration']
        };
        
        return {
            ourPool,
            competitors,
            comparison: {
                hashrate: {
                    rank: this.calculateRank(ourPool.hashrate, competitors.map(c => c.hashrate)),
                    percentage: (ourPool.hashrate / competitors[0].hashrate) * 100
                },
                fee: {
                    rank: this.calculateRank(-ourPool.fee, competitors.map(c => -c.fee)),
                    difference: ourPool.fee - (competitors.reduce((sum, c) => sum + c.fee, 0) / competitors.length)
                }
            }
        };
    }
    
    /**
     * ヘルパー関数
     */
    
    formatHashrate(hashrate) {
        const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s'];
        let unitIndex = 0;
        let value = hashrate;
        
        while (value >= 1000 && unitIndex < units.length - 1) {
            value /= 1000;
            unitIndex++;
        }
        
        return `${value.toFixed(2)} ${units[unitIndex]}`;
    }
    
    calculateTrend(metric) {
        const history = this.realtimeStats.history.get(metric);
        if (!history || history.length < 2) {
            return 0;
        }
        
        const recent = history.slice(-10);
        const older = history.slice(-20, -10);
        
        const recentAvg = recent.reduce((sum, h) => sum + h.value, 0) / recent.length;
        const olderAvg = older.reduce((sum, h) => sum + h.value, 0) / older.length;
        
        return ((recentAvg - olderAvg) / olderAvg) * 100;
    }
    
    calculateEarnings(period) {
        // 実装は別途
        const mockEarnings = {
            today: 0.0123,
            yesterday: 0.0115,
            week: 0.0834,
            month: 0.3421
        };
        
        return mockEarnings[period] || 0;
    }
    
    aggregateData(data, period) {
        if (period <= 3600) {
            // 1時間以内は生データ
            return data;
        }
        
        // 集約間隔を決定
        const interval = period <= 86400 ? 60 : 300; // 1日以内は1分、それ以上は5分
        
        const aggregated = [];
        for (let i = 0; i < data.length; i += interval) {
            const slice = data.slice(i, i + interval);
            if (slice.length > 0) {
                aggregated.push({
                    time: slice[0].time,
                    value: slice.reduce((sum, d) => sum + d.value, 0) / slice.length
                });
            }
        }
        
        return aggregated;
    }
    
    /**
     * Expressルーターを取得
     */
    getRouter() {
        return router;
    }
}

module.exports = DashboardAPI;