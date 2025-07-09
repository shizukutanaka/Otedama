// 監視とアラート関連のエクスポート
export { AlertWebhookServer } from './alertWebhookServer';

// アラートマネージャー設定のヘルパー関数
export function getAlertmanagerConfig(): Record<string, any> {
    return {
        global: {
            resolve_timeout: process.env.ALERT_RESOLVE_TIMEOUT || '5m',
            smtp_smarthost: process.env.SMTP_HOST || 'localhost:25',
            smtp_from: process.env.SMTP_FROM || 'alertmanager@otedama-pool.local',
        },
        route: {
            receiver: 'warning-notifications',
            group_by: ['alertname', 'cluster', 'service'],
            group_wait: '10s',
            group_interval: '10s',
            repeat_interval: '1h',
        },
        receivers: getReceivers(),
    };
}

// 受信者設定の生成
function getReceivers(): any[] {
    const receivers = [];
    
    // 環境変数から設定を読み込み
    if (process.env.SLACK_WEBHOOK_URL) {
        receivers.push({
            name: 'slack-notifications',
            slack_configs: [{
                api_url: process.env.SLACK_WEBHOOK_URL,
                channel: process.env.SLACK_CHANNEL || '#alerts',
            }],
        });
    }
    
    if (process.env.PAGERDUTY_SERVICE_KEY) {
        receivers.push({
            name: 'pagerduty',
            pagerduty_configs: [{
                service_key: process.env.PAGERDUTY_SERVICE_KEY,
            }],
        });
    }
    
    // デフォルト受信者
    receivers.push({
        name: 'warning-notifications',
        webhook_configs: [{
            url: 'http://localhost:9093/webhook/warning',
            send_resolved: true,
        }],
    });
    
    receivers.push({
        name: 'critical-notifications',
        webhook_configs: [{
            url: 'http://localhost:9093/webhook/critical',
            send_resolved: true,
        }],
    });
    
    return receivers;
}

// Prometheusルールの検証
export function validatePrometheusRules(rules: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (!rules.groups || !Array.isArray(rules.groups)) {
        errors.push('Rules must contain a "groups" array');
        return { valid: false, errors };
    }
    
    for (const group of rules.groups) {
        if (!group.name) {
            errors.push('Each group must have a name');
        }
        
        if (!group.rules || !Array.isArray(group.rules)) {
            errors.push(`Group ${group.name} must contain a "rules" array`);
            continue;
        }
        
        for (const rule of group.rules) {
            if (!rule.alert) {
                errors.push('Each rule must have an "alert" name');
            }
            
            if (!rule.expr) {
                errors.push(`Rule ${rule.alert} must have an "expr" expression`);
            }
            
            if (!rule.labels || !rule.labels.severity) {
                errors.push(`Rule ${rule.alert} must have a severity label`);
            }
            
            if (!rule.annotations || !rule.annotations.summary) {
                errors.push(`Rule ${rule.alert} must have a summary annotation`);
            }
        }
    }
    
    return { valid: errors.length === 0, errors };
}

// アラート統計の集計
export interface AlertStats {
    total: number;
    byLevel: Record<string, number>;
    bySeverity: Record<string, number>;
    byComponent: Record<string, number>;
    recentAlerts: any[];
}

export function aggregateAlertStats(alerts: any[]): AlertStats {
    const stats: AlertStats = {
        total: alerts.length,
        byLevel: {},
        bySeverity: {},
        byComponent: {},
        recentAlerts: alerts.slice(-10),
    };
    
    for (const alert of alerts) {
        // レベル別集計
        const level = alert.level || 'unknown';
        stats.byLevel[level] = (stats.byLevel[level] || 0) + 1;
        
        // severity別集計
        const severity = alert.data?.commonLabels?.severity || 'unknown';
        stats.bySeverity[severity] = (stats.bySeverity[severity] || 0) + 1;
        
        // コンポーネント別集計
        const component = alert.data?.commonLabels?.component || 'unknown';
        stats.byComponent[component] = (stats.byComponent[component] || 0) + 1;
    }
    
    return stats;
}
