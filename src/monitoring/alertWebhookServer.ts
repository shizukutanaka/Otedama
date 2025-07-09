import express from 'express';
import { createLogger } from '../utils/logger';
import { EventEmitter } from 'events';

/**
 * AlertWebhookServer - Alertmanagerからのwebhookを受信し、
 * 段階的エスカレーションを処理するサーバー
 * 
 * 設計原則（Rob Pike風）:
 * - シンプルで明確なインターフェース
 * - 並行性を活用
 * - エラーは値として扱う
 */
export class AlertWebhookServer extends EventEmitter {
    private app: express.Application;
    private logger = createLogger('AlertWebhookServer');
    private port: number;
    private alertHistory: Map<string, Alert[]> = new Map();
    private escalationTimers: Map<string, NodeJS.Timeout> = new Map();

    constructor(port: number = 9093) {
        super();
        this.port = port;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    private setupMiddleware(): void {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        
        // リクエストロギング
        this.app.use((req, res, next) => {
            this.logger.debug(`${req.method} ${req.path}`, {
                body: req.body,
                headers: req.headers,
            });
            next();
        });
    }

    private setupRoutes(): void {
        // ヘルスチェック
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', uptime: process.uptime() });
        });

        // 警告レベルアラート
        this.app.post('/webhook/warning', this.handleWarningAlert.bind(this));

        // 重大レベルアラート
        this.app.post('/webhook/critical', this.handleCriticalAlert.bind(this));

        // SMS通知エンドポイント（開発用モック）
        this.app.post('/sms/emergency', this.handleEmergencySMS.bind(this));

        // アラート履歴
        this.app.get('/alerts/history', this.getAlertHistory.bind(this));

        // アラート統計
        this.app.get('/alerts/stats', this.getAlertStats.bind(this));
    }

    private async handleWarningAlert(req: express.Request, res: express.Response): Promise<void> {
        try {
            const alert: AlertmanagerWebhook = req.body;
            this.logger.warn('Warning alert received', alert);

            // アラート履歴に追加
            this.addToHistory('warning', alert);

            // エスカレーションタイマー設定（1時間後に自動エスカレーション）
            this.setEscalationTimer(alert, 3600000); // 1 hour

            // イベント発行
            this.emit('alert:warning', alert);

            res.json({ status: 'received', level: 'warning' });
        } catch (error) {
            this.logger.error('Error handling warning alert', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    private async handleCriticalAlert(req: express.Request, res: express.Response): Promise<void> {
        try {
            const alert: AlertmanagerWebhook = req.body;
            this.logger.error('Critical alert received', alert);

            // アラート履歴に追加
            this.addToHistory('critical', alert);

            // 既存のエスカレーションタイマーをクリア
            this.clearEscalationTimer(alert);

            // 即座にエスカレーション処理
            await this.escalateAlert(alert);

            // イベント発行
            this.emit('alert:critical', alert);

            res.json({ status: 'received', level: 'critical' });
        } catch (error) {
            this.logger.error('Error handling critical alert', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    private async handleEmergencySMS(req: express.Request, res: express.Response): Promise<void> {
        try {
            const alert: AlertmanagerWebhook = req.body;
            this.logger.error('EMERGENCY SMS request', alert);

            // 本番環境では実際のSMS送信処理をここに実装
            // 開発環境ではログ出力のみ
            this.logger.error('📱 SMS NOTIFICATION:', {
                to: process.env.EMERGENCY_PHONE_NUMBERS?.split(',') || ['Not configured'],
                message: this.formatSMSMessage(alert),
            });

            // イベント発行
            this.emit('alert:emergency', alert);

            res.json({ status: 'sms_queued' });
        } catch (error) {
            this.logger.error('Error sending emergency SMS', error);
            res.status(500).json({ error: 'SMS sending failed' });
        }
    }

    private addToHistory(level: string, alert: AlertmanagerWebhook): void {
        const key = `${level}:${new Date().toISOString().split('T')[0]}`;
        const history = this.alertHistory.get(key) || [];
        
        const alertData: Alert = {
            level,
            timestamp: new Date(),
            data: alert,
            resolved: alert.status === 'resolved',
        };
        
        history.push(alertData);
        this.alertHistory.set(key, history);

        // 古い履歴を削除（7日以上前）
        this.cleanupOldHistory();
    }

    private cleanupOldHistory(): void {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        for (const [key, alerts] of this.alertHistory.entries()) {
            const date = new Date(key.split(':')[1]);
            if (date < sevenDaysAgo) {
                this.alertHistory.delete(key);
            }
        }
    }

    private setEscalationTimer(alert: AlertmanagerWebhook, delay: number): void {
        const key = this.getAlertKey(alert);
        
        // 既存のタイマーをクリア
        this.clearEscalationTimer(alert);
        
        // 新しいタイマーを設定
        const timer = setTimeout(() => {
            this.logger.warn('Alert escalation triggered', { alertKey: key });
            this.escalateAlert(alert);
        }, delay);
        
        this.escalationTimers.set(key, timer);
    }

    private clearEscalationTimer(alert: AlertmanagerWebhook): void {
        const key = this.getAlertKey(alert);
        const timer = this.escalationTimers.get(key);
        
        if (timer) {
            clearTimeout(timer);
            this.escalationTimers.delete(key);
        }
    }

    private async escalateAlert(alert: AlertmanagerWebhook): Promise<void> {
        this.logger.error('ESCALATING ALERT', alert);
        
        // エスカレーション処理
        // 1. 追加の通知送信
        // 2. 自動修復試行
        // 3. インシデント作成
        
        this.emit('alert:escalated', alert);
    }

    private getAlertKey(alert: AlertmanagerWebhook): string {
        const labels = alert.groupLabels || {};
        return `${labels.alertname}:${labels.instance}:${labels.job}`;
    }

    private formatSMSMessage(alert: AlertmanagerWebhook): string {
        const alerts = alert.alerts || [];
        const firstAlert = alerts[0];
        
        if (!firstAlert) return 'Emergency alert received';
        
        return `🚨 ${firstAlert.labels.alertname}: ${firstAlert.annotations.summary}`;
    }

    private getAlertHistory(req: express.Request, res: express.Response): void {
        const { level, date } = req.query;
        let history: Alert[] = [];
        
        if (level && date) {
            const key = `${level}:${date}`;
            history = this.alertHistory.get(key) || [];
        } else {
            // すべての履歴を返す
            for (const alerts of this.alertHistory.values()) {
                history.push(...alerts);
            }
        }
        
        res.json({
            total: history.length,
            alerts: history.slice(-100), // 最新100件
        });
    }

    private getAlertStats(req: express.Request, res: express.Response): void {
        const stats = {
            warning: 0,
            critical: 0,
            resolved: 0,
            active_escalations: this.escalationTimers.size,
        };
        
        for (const [key, alerts] of this.alertHistory.entries()) {
            const level = key.split(':')[0];
            stats[level as keyof typeof stats] += alerts.length;
            stats.resolved += alerts.filter(a => a.resolved).length;
        }
        
        res.json(stats);
    }

    public start(): void {
        this.app.listen(this.port, () => {
            this.logger.info(`Alert webhook server listening on port ${this.port}`);
        });
    }

    public stop(): void {
        // すべてのエスカレーションタイマーをクリア
        for (const timer of this.escalationTimers.values()) {
            clearTimeout(timer);
        }
        this.escalationTimers.clear();
        
        this.logger.info('Alert webhook server stopped');
    }
}

// 型定義
interface AlertmanagerWebhook {
    version: string;
    groupKey: string;
    status: 'firing' | 'resolved';
    receiver: string;
    groupLabels: Record<string, string>;
    commonLabels: Record<string, string>;
    commonAnnotations: Record<string, string>;
    externalURL: string;
    alerts: AlertmanagerAlert[];
}

interface AlertmanagerAlert {
    status: 'firing' | 'resolved';
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    endsAt: string;
    generatorURL: string;
}

interface Alert {
    level: string;
    timestamp: Date;
    data: AlertmanagerWebhook;
    resolved: boolean;
}

// 使用例
if (require.main === module) {
    const server = new AlertWebhookServer();
    
    // アラートイベントリスナー
    server.on('alert:warning', (alert) => {
        console.log('⚠️  Warning alert:', alert);
    });
    
    server.on('alert:critical', (alert) => {
        console.log('🚨 Critical alert:', alert);
    });
    
    server.on('alert:emergency', (alert) => {
        console.log('🆘 Emergency alert:', alert);
    });
    
    server.on('alert:escalated', (alert) => {
        console.log('📈 Alert escalated:', alert);
    });
    
    server.start();
    
    // グレースフルシャットダウン
    process.on('SIGTERM', () => server.stop());
    process.on('SIGINT', () => server.stop());
}
