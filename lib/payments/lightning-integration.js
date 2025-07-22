const { EventEmitter } = require('events');

/**
 * Lightning Network統合
 * 低額・高頻度の支払いを効率化
 */
class LightningIntegration extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            nodeUrl: config.nodeUrl || 'http://localhost:8080',
            macaroonPath: config.macaroonPath || './lightning/admin.macaroon',
            tlsCertPath: config.tlsCertPath || './lightning/tls.cert',
            maxChannelSize: config.maxChannelSize || 0.1, // BTC
            minChannelSize: config.minChannelSize || 0.001, // BTC
            autopilotEnabled: config.autopilotEnabled !== false,
            lightningThreshold: config.lightningThreshold || 0.01, // BTC以下はLN優先
            ...config
        };
        
        this.channels = new Map();
        this.invoices = new Map();
        this.payments = new Map();
        this.nodeInfo = null;
        this.connected = false;
    }
    
    /**
     * Lightning Nodeに接続
     */
    async connect() {
        try {
            // 実際の実装ではLNDやCore Lightning APIを使用
            this.nodeInfo = await this.getNodeInfo();
            this.connected = true;
            
            // チャネル情報を取得
            await this.updateChannels();
            
            // 定期的な更新を開始
            this.startMonitoring();
            
            this.emit('connected', this.nodeInfo);
            
        } catch (error) {
            this.emit('connection-error', error);
            throw error;
        }
    }
    
    /**
     * 切断
     */
    disconnect() {
        this.connected = false;
        this.stopMonitoring();
        this.emit('disconnected');
    }
    
    /**
     * 支払いを処理
     */
    async processPayment(payment) {
        const { address, amount, metadata = {} } = payment;
        
        // Lightning支払いが適切か判定
        if (!this.shouldUseLightning(amount)) {
            return { method: 'onchain', processed: false };
        }
        
        try {
            // Lightning Addressかチェック
            if (this.isLightningAddress(address)) {
                return await this.payLightningAddress(address, amount, metadata);
            }
            
            // 既存のチャネルがあるかチェック
            const channel = this.findChannelForPayment(address, amount);
            if (channel) {
                return await this.payViaChannel(channel, address, amount, metadata);
            }
            
            // 新しいチャネルを開く価値があるか
            if (this.shouldOpenChannel(address, amount)) {
                return await this.openChannelAndPay(address, amount, metadata);
            }
            
            // Lightning不適
            return { method: 'onchain', processed: false };
            
        } catch (error) {
            this.emit('payment-error', { payment, error });
            throw error;
        }
    }
    
    /**
     * インボイスを作成
     */
    async createInvoice(amount, description = '', expiry = 3600) {
        try {
            const invoice = {
                id: this.generateInvoiceId(),
                amount: Math.floor(amount * 100000000), // satoshi
                description,
                expiry,
                created: Date.now(),
                paymentRequest: '', // 実際のLN invoice
                paymentHash: '',
                settled: false
            };
            
            // 実際の実装ではLightning Nodeでインボイスを作成
            const lnInvoice = await this.generateLightningInvoice(invoice);
            
            invoice.paymentRequest = lnInvoice.paymentRequest;
            invoice.paymentHash = lnInvoice.paymentHash;
            
            this.invoices.set(invoice.id, invoice);
            
            this.emit('invoice-created', invoice);
            
            return invoice;
            
        } catch (error) {
            this.emit('invoice-error', error);
            throw error;
        }
    }
    
    /**
     * チャネルを開く
     */
    async openChannel(nodeId, amount, pushAmount = 0) {
        try {
            // チャネルサイズの検証
            if (amount < this.config.minChannelSize || amount > this.config.maxChannelSize) {
                throw new Error('Invalid channel size');
            }
            
            const channel = {
                id: this.generateChannelId(),
                nodeId,
                capacity: Math.floor(amount * 100000000),
                localBalance: Math.floor((amount - pushAmount) * 100000000),
                remoteBalance: Math.floor(pushAmount * 100000000),
                state: 'pending',
                opened: Date.now()
            };
            
            // 実際の実装ではLightning Nodeでチャネルを開く
            const fundingTx = await this.fundChannel(channel);
            
            channel.fundingTxid = fundingTx;
            this.channels.set(channel.id, channel);
            
            this.emit('channel-opening', channel);
            
            return channel;
            
        } catch (error) {
            this.emit('channel-error', error);
            throw error;
        }
    }
    
    /**
     * 自動チャネル管理（Autopilot）
     */
    async runAutopilot() {
        if (!this.config.autopilotEnabled) {
            return;
        }
        
        try {
            // 現在のチャネル状態を分析
            const analysis = this.analyzeChannels();
            
            // 推奨アクションを生成
            const recommendations = this.generateRecommendations(analysis);
            
            // アクションを実行
            for (const action of recommendations) {
                await this.executeAutopilotAction(action);
            }
            
            this.emit('autopilot-completed', recommendations);
            
        } catch (error) {
            this.emit('autopilot-error', error);
        }
    }
    
    /**
     * チャネル状態を分析
     */
    analyzeChannels() {
        const analysis = {
            totalCapacity: 0,
            totalLocalBalance: 0,
            totalRemoteBalance: 0,
            activeChannels: 0,
            inactiveChannels: 0,
            unbalancedChannels: [],
            lowCapacityChannels: []
        };
        
        this.channels.forEach(channel => {
            if (channel.state === 'active') {
                analysis.activeChannels++;
                analysis.totalCapacity += channel.capacity;
                analysis.totalLocalBalance += channel.localBalance;
                analysis.totalRemoteBalance += channel.remoteBalance;
                
                // バランスチェック
                const balanceRatio = channel.localBalance / channel.capacity;
                if (balanceRatio < 0.2 || balanceRatio > 0.8) {
                    analysis.unbalancedChannels.push(channel);
                }
                
                // 容量チェック
                if (channel.capacity < this.config.minChannelSize * 100000000) {
                    analysis.lowCapacityChannels.push(channel);
                }
            } else {
                analysis.inactiveChannels++;
            }
        });
        
        return analysis;
    }
    
    /**
     * 推奨アクションを生成
     */
    generateRecommendations(analysis) {
        const recommendations = [];
        
        // チャネル数が少ない場合
        if (analysis.activeChannels < 3) {
            recommendations.push({
                action: 'open-channel',
                reason: 'insufficient-channels',
                params: {
                    count: 3 - analysis.activeChannels,
                    size: this.config.minChannelSize * 2
                }
            });
        }
        
        // アンバランスなチャネルのリバランス
        analysis.unbalancedChannels.forEach(channel => {
            recommendations.push({
                action: 'rebalance-channel',
                reason: 'unbalanced',
                params: {
                    channelId: channel.id,
                    targetBalance: channel.capacity / 2
                }
            });
        });
        
        // 低容量チャネルのクローズ
        analysis.lowCapacityChannels.forEach(channel => {
            recommendations.push({
                action: 'close-channel',
                reason: 'low-capacity',
                params: {
                    channelId: channel.id
                }
            });
        });
        
        return recommendations;
    }
    
    /**
     * Lightning支払いを実行
     */
    async payLightningAddress(address, amount, metadata) {
        // LNURL-payプロトコルの実装
        const invoice = await this.fetchInvoiceFromAddress(address, amount);
        
        const payment = {
            id: this.generatePaymentId(),
            invoice: invoice.paymentRequest,
            amount: Math.floor(amount * 100000000),
            status: 'pending',
            created: Date.now()
        };
        
        this.payments.set(payment.id, payment);
        
        try {
            // 支払いを実行
            const result = await this.sendPayment(payment);
            
            payment.status = 'completed';
            payment.preimage = result.preimage;
            payment.fee = result.fee;
            
            this.emit('payment-completed', payment);
            
            return {
                method: 'lightning',
                processed: true,
                paymentId: payment.id,
                fee: result.fee / 100000000
            };
            
        } catch (error) {
            payment.status = 'failed';
            payment.error = error.message;
            
            throw error;
        }
    }
    
    /**
     * チャネルバランスのリバランス
     */
    async rebalanceChannel(channelId, targetBalance) {
        const channel = this.channels.get(channelId);
        if (!channel) {
            throw new Error('Channel not found');
        }
        
        const currentBalance = channel.localBalance;
        const difference = targetBalance - currentBalance;
        
        if (Math.abs(difference) < 10000) { // 10k satoshi以下は無視
            return { success: true, message: 'Already balanced' };
        }
        
        try {
            // 循環支払いでリバランス
            const route = await this.findRebalanceRoute(channel, difference);
            const payment = await this.executeRebalance(route);
            
            // チャネルバランスを更新
            channel.localBalance = targetBalance;
            channel.remoteBalance = channel.capacity - targetBalance;
            
            this.emit('channel-rebalanced', {
                channelId,
                previousBalance: currentBalance,
                newBalance: targetBalance,
                cost: payment.fee
            });
            
            return {
                success: true,
                cost: payment.fee / 100000000
            };
            
        } catch (error) {
            this.emit('rebalance-failed', { channelId, error });
            throw error;
        }
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        const stats = {
            connected: this.connected,
            nodeInfo: this.nodeInfo,
            channels: {
                total: this.channels.size,
                active: 0,
                pending: 0,
                capacity: 0,
                localBalance: 0,
                remoteBalance: 0
            },
            payments: {
                total: this.payments.size,
                completed: 0,
                pending: 0,
                failed: 0,
                totalAmount: 0,
                totalFees: 0
            },
            invoices: {
                total: this.invoices.size,
                settled: 0,
                pending: 0,
                expired: 0
            }
        };
        
        // チャネル統計
        this.channels.forEach(channel => {
            if (channel.state === 'active') {
                stats.channels.active++;
                stats.channels.capacity += channel.capacity;
                stats.channels.localBalance += channel.localBalance;
                stats.channels.remoteBalance += channel.remoteBalance;
            } else {
                stats.channels.pending++;
            }
        });
        
        // 支払い統計
        this.payments.forEach(payment => {
            stats.payments[payment.status]++;
            if (payment.status === 'completed') {
                stats.payments.totalAmount += payment.amount;
                stats.payments.totalFees += payment.fee || 0;
            }
        });
        
        // インボイス統計
        const now = Date.now();
        this.invoices.forEach(invoice => {
            if (invoice.settled) {
                stats.invoices.settled++;
            } else if (now > invoice.created + invoice.expiry * 1000) {
                stats.invoices.expired++;
            } else {
                stats.invoices.pending++;
            }
        });
        
        return stats;
    }
    
    /**
     * ヘルパー関数
     */
    
    shouldUseLightning(amount) {
        return amount <= this.config.lightningThreshold && this.connected;
    }
    
    isLightningAddress(address) {
        // Lightning Address形式: user@domain.com
        return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(address);
    }
    
    generateInvoiceId() {
        return `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    generateChannelId() {
        return `ch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    generatePaymentId() {
        return `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * モニタリング
     */
    startMonitoring() {
        // 定期的な更新
        this.monitoringInterval = setInterval(() => {
            this.updateChannels();
            this.checkInvoices();
            this.checkPayments();
        }, 30000); // 30秒
        
        // Autopilot
        if (this.config.autopilotEnabled) {
            this.autopilotInterval = setInterval(() => {
                this.runAutopilot();
            }, 3600000); // 1時間
        }
    }
    
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
        }
        if (this.autopilotInterval) {
            clearInterval(this.autopilotInterval);
        }
    }
    
    /**
     * 実装スタブ（実際のLightning Node APIとの統合が必要）
     */
    
    async getNodeInfo() {
        return {
            pubkey: 'mock_pubkey',
            alias: 'Otedama Lightning',
            version: '0.1.0'
        };
    }
    
    async updateChannels() {
        // Lightning Nodeからチャネル情報を取得
    }
    
    async generateLightningInvoice(invoice) {
        return {
            paymentRequest: 'lnbc' + Math.random().toString(36).substr(2),
            paymentHash: Math.random().toString(36).substr(2)
        };
    }
    
    async fundChannel(channel) {
        return 'mock_funding_txid_' + Date.now();
    }
    
    async sendPayment(payment) {
        return {
            preimage: Math.random().toString(36).substr(2),
            fee: Math.floor(payment.amount * 0.001)
        };
    }
}

module.exports = LightningIntegration;