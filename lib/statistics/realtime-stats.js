const { EventEmitter } = require('events');
const WebSocket = require('ws');

/**
 * リアルタイム統計データの管理とWebSocket配信
 */
class RealtimeStats extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            port: config.port || 8081,
            updateInterval: config.updateInterval || 1000, // 1秒
            historySize: config.historySize || 3600, // 1時間分
            metricsRetention: config.metricsRetention || 86400, // 24時間
            ...config
        };
        
        this.wss = null;
        this.clients = new Set();
        this.metrics = new Map();
        this.history = new Map();
        this.updateTimer = null;
        
        this.initializeMetrics();
    }
    
    /**
     * メトリクスの初期化
     */
    initializeMetrics() {
        const defaultMetrics = [
            'hashrate.total',
            'hashrate.average',
            'miners.active',
            'miners.total',
            'shares.valid',
            'shares.invalid',
            'shares.stale',
            'shares.difficulty',
            'blocks.found',
            'blocks.pending',
            'blocks.confirmed',
            'blocks.orphaned',
            'payments.pending',
            'payments.completed',
            'revenue.total',
            'revenue.per_hash',
            'network.difficulty',
            'network.hashrate',
            'pool.efficiency',
            'pool.luck'
        ];
        
        defaultMetrics.forEach(metric => {
            this.metrics.set(metric, {
                current: 0,
                min: Infinity,
                max: -Infinity,
                avg: 0,
                count: 0
            });
            
            this.history.set(metric, []);
        });
    }
    
    /**
     * WebSocketサーバーを起動
     */
    start() {
        this.wss = new WebSocket.Server({ 
            port: this.config.port,
            perMessageDeflate: true
        });
        
        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });
        
        // 定期更新を開始
        this.updateTimer = setInterval(() => {
            this.broadcastUpdate();
        }, this.config.updateInterval);
        
        this.emit('started', { port: this.config.port });
    }
    
    /**
     * 停止
     */
    stop() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
        
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        
        this.emit('stopped');
    }
    
    /**
     * WebSocket接続を処理
     */
    handleConnection(ws, req) {
        const clientId = this.generateClientId();
        const client = {
            id: clientId,
            ws,
            ip: req.socket.remoteAddress,
            subscriptions: new Set(['all']),
            authenticated: false
        };
        
        this.clients.add(client);
        
        ws.on('message', (message) => {
            this.handleMessage(client, message);
        });
        
        ws.on('close', () => {
            this.clients.delete(client);
        });
        
        ws.on('error', (error) => {
            console.error(`WebSocket error for client ${clientId}:`, error);
        });
        
        // 初期データを送信
        this.sendInitialData(client);
    }
    
    /**
     * クライアントメッセージを処理
     */
    handleMessage(client, message) {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'subscribe':
                    this.handleSubscribe(client, data.channels);
                    break;
                    
                case 'unsubscribe':
                    this.handleUnsubscribe(client, data.channels);
                    break;
                    
                case 'auth':
                    this.handleAuth(client, data.token);
                    break;
                    
                case 'request':
                    this.handleRequest(client, data);
                    break;
                    
                default:
                    this.sendError(client, 'Unknown message type');
            }
            
        } catch (error) {
            this.sendError(client, 'Invalid message format');
        }
    }
    
    /**
     * チャンネル購読
     */
    handleSubscribe(client, channels) {
        if (!Array.isArray(channels)) {
            channels = [channels];
        }
        
        channels.forEach(channel => {
            client.subscriptions.add(channel);
        });
        
        this.sendMessage(client, {
            type: 'subscribed',
            channels: Array.from(client.subscriptions)
        });
    }
    
    /**
     * 購読解除
     */
    handleUnsubscribe(client, channels) {
        if (!Array.isArray(channels)) {
            channels = [channels];
        }
        
        channels.forEach(channel => {
            client.subscriptions.delete(channel);
        });
        
        this.sendMessage(client, {
            type: 'unsubscribed',
            channels: Array.from(client.subscriptions)
        });
    }
    
    /**
     * 認証処理
     */
    handleAuth(client, token) {
        // 簡易認証（本番環境では適切な認証を実装）
        if (token === this.config.apiKey) {
            client.authenticated = true;
            this.sendMessage(client, {
                type: 'authenticated'
            });
        } else {
            this.sendError(client, 'Invalid authentication token');
        }
    }
    
    /**
     * データリクエストを処理
     */
    handleRequest(client, request) {
        switch (request.query) {
            case 'history':
                this.sendHistory(client, request.metric, request.period);
                break;
                
            case 'snapshot':
                this.sendSnapshot(client);
                break;
                
            case 'miners':
                this.sendMinerStats(client, request.limit);
                break;
                
            default:
                this.sendError(client, 'Unknown query type');
        }
    }
    
    /**
     * 初期データを送信
     */
    sendInitialData(client) {
        const snapshot = this.getSnapshot();
        
        this.sendMessage(client, {
            type: 'initial',
            data: snapshot
        });
    }
    
    /**
     * 更新をブロードキャスト
     */
    broadcastUpdate() {
        const update = this.getLatestUpdate();
        
        this.clients.forEach(client => {
            if (client.ws.readyState === WebSocket.OPEN) {
                if (this.shouldSendToClient(client, update)) {
                    this.sendMessage(client, {
                        type: 'update',
                        data: update
                    });
                }
            }
        });
    }
    
    /**
     * クライアントに送信すべきか判定
     */
    shouldSendToClient(client, update) {
        if (client.subscriptions.has('all')) {
            return true;
        }
        
        // チャンネル別のフィルタリング
        return Object.keys(update).some(key => 
            client.subscriptions.has(key)
        );
    }
    
    /**
     * メトリクスを更新
     */
    updateMetric(name, value) {
        const metric = this.metrics.get(name);
        if (!metric) {
            return;
        }
        
        metric.current = value;
        metric.min = Math.min(metric.min, value);
        metric.max = Math.max(metric.max, value);
        metric.count++;
        metric.avg = ((metric.avg * (metric.count - 1)) + value) / metric.count;
        
        // 履歴に追加
        const history = this.history.get(name);
        const timestamp = Date.now();
        
        history.push({ timestamp, value });
        
        // 古いデータを削除
        const cutoff = timestamp - (this.config.metricsRetention * 1000);
        while (history.length > 0 && history[0].timestamp < cutoff) {
            history.shift();
        }
        
        this.emit('metric-updated', { name, value, metric });
    }
    
    /**
     * 複数のメトリクスを一括更新
     */
    updateMetrics(updates) {
        Object.entries(updates).forEach(([name, value]) => {
            this.updateMetric(name, value);
        });
    }
    
    /**
     * 最新の更新データを取得
     */
    getLatestUpdate() {
        const update = {
            timestamp: Date.now(),
            metrics: {}
        };
        
        this.metrics.forEach((metric, name) => {
            update.metrics[name] = metric.current;
        });
        
        return update;
    }
    
    /**
     * スナップショットを取得
     */
    getSnapshot() {
        const snapshot = {
            timestamp: Date.now(),
            metrics: {},
            summary: {}
        };
        
        this.metrics.forEach((metric, name) => {
            snapshot.metrics[name] = { ...metric };
        });
        
        // サマリー情報を追加
        snapshot.summary = {
            uptimePercent: this.calculateUptime(),
            efficiency: this.calculateEfficiency(),
            profitability: this.calculateProfitability()
        };
        
        return snapshot;
    }
    
    /**
     * 履歴データを送信
     */
    sendHistory(client, metric, period) {
        const history = this.history.get(metric);
        if (!history) {
            this.sendError(client, 'Unknown metric');
            return;
        }
        
        const now = Date.now();
        const startTime = now - (period * 1000);
        
        const filteredHistory = history.filter(entry => 
            entry.timestamp >= startTime
        );
        
        this.sendMessage(client, {
            type: 'history',
            metric,
            period,
            data: filteredHistory
        });
    }
    
    /**
     * マイナー統計を送信
     */
    sendMinerStats(client, limit = 100) {
        // マイナー統計の取得（実装は別モジュールから）
        const minerStats = this.getMinerStats(limit);
        
        this.sendMessage(client, {
            type: 'miners',
            data: minerStats
        });
    }
    
    /**
     * メッセージを送信
     */
    sendMessage(client, message) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }
    
    /**
     * エラーメッセージを送信
     */
    sendError(client, error) {
        this.sendMessage(client, {
            type: 'error',
            message: error
        });
    }
    
    /**
     * クライアントIDを生成
     */
    generateClientId() {
        return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * アップタイムを計算
     */
    calculateUptime() {
        // 実装は別途
        return 99.9;
    }
    
    /**
     * 効率を計算
     */
    calculateEfficiency() {
        const valid = this.metrics.get('shares.valid').current;
        const invalid = this.metrics.get('shares.invalid').current;
        const total = valid + invalid;
        
        return total > 0 ? (valid / total) * 100 : 100;
    }
    
    /**
     * 収益性を計算
     */
    calculateProfitability() {
        // 実装は別途
        return this.metrics.get('revenue.per_hash').current;
    }
    
    /**
     * マイナー統計を取得（モック）
     */
    getMinerStats(limit) {
        // 実際の実装では別モジュールから取得
        return [];
    }
}

module.exports = RealtimeStats;