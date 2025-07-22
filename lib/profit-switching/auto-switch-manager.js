const { EventEmitter } = require('events');
const ProfitCalculator = require('./profit-calculator');

/**
 * 自動切替機能を管理
 */
class AutoSwitchManager extends EventEmitter {
    constructor(poolManager, config = {}) {
        super();
        
        this.poolManager = poolManager;
        this.config = {
            enabled: config.enabled !== false,
            minMiners: config.minMiners || 5, // 最小マイナー数
            switchDelay: config.switchDelay || 60000, // 切替前の待機時間
            notificationTime: config.notificationTime || 300000, // 5分前に通知
            ...config
        };
        
        this.profitCalculator = new ProfitCalculator(config.calculator);
        this.switchTimer = null;
        this.currentAlgorithm = 'sha256';
        this.pendingSwitch = null;
        
        this.setupEventHandlers();
    }
    
    /**
     * イベントハンドラーの設定
     */
    setupEventHandlers() {
        this.profitCalculator.on('switching', (data) => {
            this.handleSwitchRequest(data);
        });
        
        this.profitCalculator.on('updated', (data) => {
            this.emit('profitability-updated', data);
        });
        
        this.profitCalculator.on('error', (error) => {
            this.emit('error', error);
        });
    }
    
    /**
     * 自動切替を開始
     */
    start() {
        if (!this.config.enabled) {
            this.emit('disabled');
            return;
        }
        
        this.profitCalculator.start();
        this.emit('started');
    }
    
    /**
     * 停止
     */
    stop() {
        this.profitCalculator.stop();
        
        if (this.switchTimer) {
            clearTimeout(this.switchTimer);
            this.switchTimer = null;
        }
        
        this.emit('stopped');
    }
    
    /**
     * 切替リクエストを処理
     */
    handleSwitchRequest(data) {
        // マイナー数が少ない場合は切替しない
        const minerCount = this.poolManager.getActiveMinerCount();
        if (minerCount < this.config.minMiners) {
            this.emit('switch-skipped', {
                reason: 'insufficient-miners',
                required: this.config.minMiners,
                current: minerCount
            });
            return;
        }
        
        // 既に切替中の場合はスキップ
        if (this.pendingSwitch) {
            return;
        }
        
        this.pendingSwitch = data;
        
        // マイナーに通知
        this.notifyMiners(data);
        
        // 切替をスケジュール
        this.scheduleSwich(data);
    }
    
    /**
     * マイナーに切替を通知
     */
    notifyMiners(switchData) {
        const message = {
            type: 'switch-notification',
            from: switchData.from,
            to: switchData.to,
            switchTime: Date.now() + this.config.notificationTime,
            reason: switchData.reason
        };
        
        // 全マイナーに通知
        this.poolManager.broadcast(message);
        
        this.emit('miners-notified', {
            minerCount: this.poolManager.getActiveMinerCount(),
            switchData
        });
    }
    
    /**
     * 切替をスケジュール
     */
    scheduleSwich(switchData) {
        // 既存のタイマーをクリア
        if (this.switchTimer) {
            clearTimeout(this.switchTimer);
        }
        
        // 通知時間後に切替を実行
        this.switchTimer = setTimeout(() => {
            this.executeSwitch(switchData);
        }, this.config.notificationTime);
        
        this.emit('switch-scheduled', {
            executeTime: Date.now() + this.config.notificationTime,
            switchData
        });
    }
    
    /**
     * 実際の切替を実行
     */
    async executeSwitch(switchData) {
        this.emit('switch-starting', switchData);
        
        try {
            // アルゴリズムが異なる場合
            if (switchData.from.algorithm !== switchData.to.algorithm) {
                await this.switchAlgorithm(switchData);
            } else {
                // 同じアルゴリズムの場合は設定のみ変更
                await this.switchCoinOnly(switchData);
            }
            
            this.currentAlgorithm = switchData.to.algorithm;
            this.pendingSwitch = null;
            
            this.emit('switch-completed', switchData);
            
        } catch (error) {
            this.emit('switch-failed', {
                switchData,
                error
            });
            
            this.pendingSwitch = null;
        }
    }
    
    /**
     * アルゴリズムを切替
     */
    async switchAlgorithm(switchData) {
        // 新しいジョブの受付を停止
        this.poolManager.pauseNewJobs();
        
        // 現在のジョブが完了するまで待機
        await this.waitForCurrentJobs();
        
        // Stratumサーバーの設定を変更
        await this.poolManager.reconfigureStratum({
            algorithm: switchData.to.algorithm,
            coin: switchData.to.symbol,
            endpoint: switchData.to.endpoint
        });
        
        // ブロックチェーン接続を切替
        await this.poolManager.switchBlockchain(switchData.to);
        
        // ジョブの受付を再開
        this.poolManager.resumeNewJobs();
    }
    
    /**
     * 通貨のみ切替（同一アルゴリズム）
     */
    async switchCoinOnly(switchData) {
        // ブロックチェーン接続を切替
        await this.poolManager.switchBlockchain(switchData.to);
        
        // 新しいジョブを配信
        await this.poolManager.distributeNewJob();
    }
    
    /**
     * 現在のジョブが完了するまで待機
     */
    async waitForCurrentJobs() {
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const activeJobs = this.poolManager.getActiveJobCount();
                if (activeJobs === 0) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 1000);
            
            // タイムアウト（最大30秒）
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve();
            }, 30000);
        });
    }
    
    /**
     * 手動切替
     */
    async manualSwitch(coinSymbol) {
        // 自動切替を一時的に無効化
        const wasEnabled = this.config.enabled;
        this.config.enabled = false;
        
        try {
            // 収益性計算機に通貨を設定
            this.profitCalculator.setCoin(coinSymbol);
            
            // 切替を実行
            const coin = this.profitCalculator.coins.get(coinSymbol);
            await this.executeSwitch({
                from: this.profitCalculator.currentCoin,
                to: coin,
                reason: 'manual'
            });
            
        } finally {
            // 自動切替を元に戻す
            this.config.enabled = wasEnabled;
        }
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        return {
            enabled: this.config.enabled,
            currentAlgorithm: this.currentAlgorithm,
            pendingSwitch: this.pendingSwitch,
            profitability: this.profitCalculator.getStats(),
            config: {
                minMiners: this.config.minMiners,
                notificationTime: this.config.notificationTime,
                switchDelay: this.config.switchDelay
            }
        };
    }
    
    /**
     * 設定を更新
     */
    updateConfig(newConfig) {
        Object.assign(this.config, newConfig);
        
        if ('enabled' in newConfig) {
            if (newConfig.enabled) {
                this.start();
            } else {
                this.stop();
            }
        }
        
        this.emit('config-updated', this.config);
    }
    
    /**
     * ハッシュレートを更新
     */
    updateHashrate(algorithm, hashrate) {
        // 現在のアルゴリズムに対応する通貨を特定
        for (const coin of this.profitCalculator.coins.values()) {
            if (coin.algorithm === algorithm) {
                this.profitCalculator.updateHashrate(coin.symbol, hashrate);
            }
        }
    }
}

module.exports = AutoSwitchManager;