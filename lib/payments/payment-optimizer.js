const { EventEmitter } = require('events');

/**
 * 支払い最適化システム
 * トランザクション手数料を最小化し、バッチ処理で効率化
 */
class PaymentOptimizer extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            minPayout: config.minPayout || 0.001,
            maxBatchSize: config.maxBatchSize || 100,
            feeTarget: config.feeTarget || 6, // ブロック数
            maxFeeRate: config.maxFeeRate || 50, // sat/vByte
            batchInterval: config.batchInterval || 3600000, // 1時間
            dynamicFees: config.dynamicFees !== false,
            priorityMultiplier: {
                low: 0.5,
                medium: 1.0,
                high: 1.5,
                urgent: 2.0
            },
            ...config
        };
        
        this.pendingPayments = new Map();
        this.paymentQueue = [];
        this.feeEstimates = new Map();
        this.batchTimer = null;
        
        this.initializeFeeEstimates();
    }
    
    /**
     * 手数料推定を初期化
     */
    initializeFeeEstimates() {
        // デフォルトの手数料推定値
        this.feeEstimates.set(1, 50);   // 1ブロック
        this.feeEstimates.set(3, 30);   // 3ブロック
        this.feeEstimates.set(6, 20);   // 6ブロック
        this.feeEstimates.set(144, 10); // 1日
    }
    
    /**
     * バッチ処理を開始
     */
    start() {
        this.updateFeeEstimates();
        
        // 定期的なバッチ処理
        this.batchTimer = setInterval(() => {
            this.processBatch();
        }, this.config.batchInterval);
        
        // 手数料更新
        setInterval(() => {
            this.updateFeeEstimates();
        }, 300000); // 5分ごと
        
        this.emit('started');
    }
    
    /**
     * 停止
     */
    stop() {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        
        this.emit('stopped');
    }
    
    /**
     * 支払いを追加
     */
    addPayment(payment) {
        const { address, amount, priority = 'medium', metadata = {} } = payment;
        
        // 最小支払額チェック
        if (amount < this.config.minPayout) {
            this.emit('payment-below-minimum', { address, amount });
            return false;
        }
        
        // 既存の保留支払いと結合
        if (this.pendingPayments.has(address)) {
            const existing = this.pendingPayments.get(address);
            existing.amount += amount;
            existing.updated = Date.now();
            
            this.emit('payment-merged', {
                address,
                previousAmount: existing.amount - amount,
                newAmount: existing.amount
            });
        } else {
            this.pendingPayments.set(address, {
                address,
                amount,
                priority,
                metadata,
                created: Date.now(),
                updated: Date.now()
            });
        }
        
        // 緊急の場合は即座に処理
        if (priority === 'urgent') {
            this.processUrgentPayment(address);
        }
        
        return true;
    }
    
    /**
     * バッチ処理を実行
     */
    async processBatch() {
        const eligiblePayments = this.getEligiblePayments();
        
        if (eligiblePayments.length === 0) {
            return;
        }
        
        // 最適なバッチを作成
        const batches = this.createOptimalBatches(eligiblePayments);
        
        for (const batch of batches) {
            try {
                await this.executeBatch(batch);
            } catch (error) {
                this.emit('batch-failed', { batch, error });
            }
        }
    }
    
    /**
     * 支払い対象を取得
     */
    getEligiblePayments() {
        const eligible = [];
        const now = Date.now();
        
        this.pendingPayments.forEach((payment, address) => {
            // 最小支払額を満たしているか
            if (payment.amount >= this.config.minPayout) {
                // 優先度による待機時間
                const waitTime = this.getWaitTime(payment.priority);
                
                if (now - payment.created >= waitTime) {
                    eligible.push(payment);
                }
            }
        });
        
        return eligible;
    }
    
    /**
     * 最適なバッチを作成
     */
    createOptimalBatches(payments) {
        const batches = [];
        
        // 手数料率でソート
        const currentFeeRate = this.getCurrentFeeRate();
        
        // 優先度別にグループ化
        const grouped = this.groupByPriority(payments);
        
        Object.entries(grouped).forEach(([priority, group]) => {
            // 優先度に応じた手数料率を計算
            const priorityFeeRate = currentFeeRate * this.config.priorityMultiplier[priority];
            
            // 手数料率が上限を超えない場合のみ処理
            if (priorityFeeRate <= this.config.maxFeeRate) {
                // バッチサイズで分割
                for (let i = 0; i < group.length; i += this.config.maxBatchSize) {
                    const batch = group.slice(i, i + this.config.maxBatchSize);
                    
                    batches.push({
                        payments: batch,
                        feeRate: priorityFeeRate,
                        priority,
                        estimatedFee: this.estimateBatchFee(batch, priorityFeeRate)
                    });
                }
            }
        });
        
        return batches;
    }
    
    /**
     * バッチを実行
     */
    async executeBatch(batch) {
        this.emit('batch-starting', {
            count: batch.payments.length,
            totalAmount: batch.payments.reduce((sum, p) => sum + p.amount, 0),
            feeRate: batch.feeRate,
            estimatedFee: batch.estimatedFee
        });
        
        try {
            // トランザクションを構築
            const tx = await this.buildBatchTransaction(batch);
            
            // ブロードキャスト
            const txid = await this.broadcastTransaction(tx);
            
            // 支払い済みとしてマーク
            batch.payments.forEach(payment => {
                this.pendingPayments.delete(payment.address);
            });
            
            this.emit('batch-completed', {
                txid,
                count: batch.payments.length,
                totalAmount: batch.payments.reduce((sum, p) => sum + p.amount, 0),
                actualFee: tx.fee
            });
            
            return txid;
            
        } catch (error) {
            this.emit('batch-error', { batch, error });
            throw error;
        }
    }
    
    /**
     * 緊急支払いを処理
     */
    async processUrgentPayment(address) {
        const payment = this.pendingPayments.get(address);
        if (!payment) {
            return;
        }
        
        const batch = {
            payments: [payment],
            feeRate: this.config.maxFeeRate,
            priority: 'urgent',
            estimatedFee: this.estimateBatchFee([payment], this.config.maxFeeRate)
        };
        
        try {
            await this.executeBatch(batch);
        } catch (error) {
            this.emit('urgent-payment-failed', { payment, error });
        }
    }
    
    /**
     * 手数料推定を更新
     */
    async updateFeeEstimates() {
        try {
            // 実際のAPIコールまたはブロックチェーンからの取得
            // ここではモックデータ
            const estimates = {
                1: 45,
                3: 25,
                6: 15,
                144: 5
            };
            
            Object.entries(estimates).forEach(([blocks, rate]) => {
                this.feeEstimates.set(parseInt(blocks), rate);
            });
            
            this.emit('fee-estimates-updated', estimates);
            
        } catch (error) {
            this.emit('fee-estimate-error', error);
        }
    }
    
    /**
     * 現在の手数料率を取得
     */
    getCurrentFeeRate() {
        if (!this.config.dynamicFees) {
            return 20; // 固定手数料
        }
        
        return this.feeEstimates.get(this.config.feeTarget) || 20;
    }
    
    /**
     * バッチの手数料を推定
     */
    estimateBatchFee(payments, feeRate) {
        // トランザクションサイズを推定
        // 基本: 10 bytes
        // 入力: ~148 bytes each
        // 出力: ~34 bytes each
        const baseSize = 10;
        const inputSize = 148; // 1入力と仮定
        const outputSize = 34;
        
        const txSize = baseSize + inputSize + (outputSize * payments.length);
        const fee = Math.ceil(txSize * feeRate / 1000) * 1000; // satoshi
        
        return fee / 100000000; // BTC
    }
    
    /**
     * 優先度別にグループ化
     */
    groupByPriority(payments) {
        const grouped = {};
        
        payments.forEach(payment => {
            const priority = payment.priority || 'medium';
            if (!grouped[priority]) {
                grouped[priority] = [];
            }
            grouped[priority].push(payment);
        });
        
        return grouped;
    }
    
    /**
     * 待機時間を取得
     */
    getWaitTime(priority) {
        const waitTimes = {
            urgent: 0,
            high: 900000,    // 15分
            medium: 3600000, // 1時間
            low: 86400000    // 24時間
        };
        
        return waitTimes[priority] || waitTimes.medium;
    }
    
    /**
     * バッチトランザクションを構築
     */
    async buildBatchTransaction(batch) {
        // 実際の実装はビットコインライブラリを使用
        return {
            inputs: [],
            outputs: batch.payments.map(p => ({
                address: p.address,
                value: Math.floor(p.amount * 100000000) // satoshi
            })),
            fee: batch.estimatedFee
        };
    }
    
    /**
     * トランザクションをブロードキャスト
     */
    async broadcastTransaction(tx) {
        // 実際の実装はブロックチェーンノードへの送信
        return 'mock_txid_' + Date.now().toString(16);
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        const pendingArray = Array.from(this.pendingPayments.values());
        
        return {
            pending: {
                count: pendingArray.length,
                totalAmount: pendingArray.reduce((sum, p) => sum + p.amount, 0),
                byPriority: this.groupByPriority(pendingArray)
            },
            feeEstimates: Object.fromEntries(this.feeEstimates),
            currentFeeRate: this.getCurrentFeeRate(),
            config: {
                minPayout: this.config.minPayout,
                maxBatchSize: this.config.maxBatchSize,
                dynamicFees: this.config.dynamicFees
            }
        };
    }
    
    /**
     * 保留中の支払いを取得
     */
    getPendingPayments(address = null) {
        if (address) {
            return this.pendingPayments.get(address);
        }
        
        return Array.from(this.pendingPayments.values());
    }
    
    /**
     * 手動でバッチを実行
     */
    async manualBatch(addresses = null) {
        let payments;
        
        if (addresses) {
            payments = addresses
                .map(addr => this.pendingPayments.get(addr))
                .filter(p => p);
        } else {
            payments = this.getEligiblePayments();
        }
        
        if (payments.length === 0) {
            return { success: false, message: 'No eligible payments' };
        }
        
        const batches = this.createOptimalBatches(payments);
        const results = [];
        
        for (const batch of batches) {
            try {
                const txid = await this.executeBatch(batch);
                results.push({ success: true, txid, count: batch.payments.length });
            } catch (error) {
                results.push({ success: false, error: error.message });
            }
        }
        
        return results;
    }
}

module.exports = PaymentOptimizer;