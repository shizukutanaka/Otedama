const { EventEmitter } = require('events');

/**
 * リグ管理システム
 */
class RigManager extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            heartbeatInterval: config.heartbeatInterval || 30000, // 30秒
            offlineThreshold: config.offlineThreshold || 120000, // 2分
            autoRestartDelay: config.autoRestartDelay || 60000, // 1分
            maxRestartAttempts: config.maxRestartAttempts || 3,
            alertThresholds: {
                temperature: config.temperatureThreshold || 85,
                fanSpeed: config.fanSpeedThreshold || 90,
                powerUsage: config.powerThreshold || 1500
            },
            ...config
        };
        
        this.rigs = new Map();
        this.groups = new Map();
        this.alerts = new Map();
        this.heartbeatTimer = null;
        
        this.initializeGroups();
    }
    
    /**
     * デフォルトグループを初期化
     */
    initializeGroups() {
        this.groups.set('default', {
            name: 'Default',
            rigs: new Set(),
            config: {},
            created: Date.now()
        });
    }
    
    /**
     * ハートビート監視を開始
     */
    start() {
        this.heartbeatTimer = setInterval(() => {
            this.checkRigHealth();
        }, this.config.heartbeatInterval);
        
        this.emit('started');
    }
    
    /**
     * 停止
     */
    stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        this.emit('stopped');
    }
    
    /**
     * リグを登録
     */
    registerRig(rigData) {
        const rigId = rigData.id || this.generateRigId();
        
        const rig = {
            id: rigId,
            name: rigData.name || `Rig-${rigId}`,
            address: rigData.address,
            group: rigData.group || 'default',
            hardware: {
                gpus: rigData.gpus || [],
                cpu: rigData.cpu || {},
                memory: rigData.memory || 0
            },
            software: {
                os: rigData.os || 'unknown',
                miner: rigData.miner || 'unknown',
                version: rigData.version || 'unknown'
            },
            status: 'online',
            lastSeen: Date.now(),
            metrics: {
                hashrate: 0,
                temperature: {},
                fanSpeed: {},
                powerUsage: 0
            },
            config: rigData.config || {},
            restartAttempts: 0,
            alerts: []
        };
        
        this.rigs.set(rigId, rig);
        
        // グループに追加
        const group = this.groups.get(rig.group);
        if (group) {
            group.rigs.add(rigId);
        }
        
        this.emit('rig-registered', rig);
        
        return rig;
    }
    
    /**
     * リグの状態を更新
     */
    updateRigStatus(rigId, status) {
        const rig = this.rigs.get(rigId);
        if (!rig) {
            return;
        }
        
        rig.lastSeen = Date.now();
        rig.status = 'online';
        
        // メトリクスを更新
        if (status.hashrate !== undefined) {
            rig.metrics.hashrate = status.hashrate;
        }
        
        if (status.gpus) {
            status.gpus.forEach((gpu, index) => {
                rig.metrics.temperature[`gpu${index}`] = gpu.temperature;
                rig.metrics.fanSpeed[`gpu${index}`] = gpu.fanSpeed;
            });
        }
        
        if (status.powerUsage !== undefined) {
            rig.metrics.powerUsage = status.powerUsage;
        }
        
        // アラートをチェック
        this.checkRigAlerts(rig);
        
        this.emit('rig-updated', rig);
    }
    
    /**
     * リグの健全性をチェック
     */
    checkRigHealth() {
        const now = Date.now();
        
        this.rigs.forEach((rig, rigId) => {
            // オフライン検出
            if (rig.status === 'online' && now - rig.lastSeen > this.config.offlineThreshold) {
                this.handleRigOffline(rig);
            }
            
            // 自動再起動のチェック
            if (rig.status === 'offline' && rig.restartAttempts < this.config.maxRestartAttempts) {
                if (now - rig.lastRestartAttempt > this.config.autoRestartDelay) {
                    this.attemptRestart(rig);
                }
            }
        });
    }
    
    /**
     * リグのオフラインを処理
     */
    handleRigOffline(rig) {
        rig.status = 'offline';
        rig.offlineSince = Date.now();
        
        this.emit('rig-offline', rig);
        
        // アラートを生成
        this.createAlert(rig.id, 'offline', {
            message: `Rig ${rig.name} is offline`,
            severity: 'high'
        });
    }
    
    /**
     * リグの再起動を試行
     */
    async attemptRestart(rig) {
        rig.restartAttempts++;
        rig.lastRestartAttempt = Date.now();
        
        this.emit('rig-restart-attempt', rig);
        
        try {
            // リモート再起動コマンドを実行
            await this.sendCommand(rig.id, 'restart');
            
            // 再起動後の確認をスケジュール
            setTimeout(() => {
                if (rig.status === 'offline') {
                    this.emit('rig-restart-failed', rig);
                } else {
                    rig.restartAttempts = 0;
                    this.emit('rig-restart-success', rig);
                }
            }, 60000);
            
        } catch (error) {
            this.emit('rig-restart-error', { rig, error });
        }
    }
    
    /**
     * リグのアラートをチェック
     */
    checkRigAlerts(rig) {
        const alerts = [];
        
        // 温度チェック
        Object.entries(rig.metrics.temperature).forEach(([device, temp]) => {
            if (temp > this.config.alertThresholds.temperature) {
                alerts.push({
                    type: 'temperature',
                    device,
                    value: temp,
                    threshold: this.config.alertThresholds.temperature,
                    severity: temp > 90 ? 'critical' : 'warning'
                });
            }
        });
        
        // ファン速度チェック
        Object.entries(rig.metrics.fanSpeed).forEach(([device, speed]) => {
            if (speed > this.config.alertThresholds.fanSpeed) {
                alerts.push({
                    type: 'fanSpeed',
                    device,
                    value: speed,
                    threshold: this.config.alertThresholds.fanSpeed,
                    severity: 'warning'
                });
            }
        });
        
        // 電力使用量チェック
        if (rig.metrics.powerUsage > this.config.alertThresholds.powerUsage) {
            alerts.push({
                type: 'powerUsage',
                value: rig.metrics.powerUsage,
                threshold: this.config.alertThresholds.powerUsage,
                severity: 'warning'
            });
        }
        
        // ハッシュレート低下チェック
        if (rig.expectedHashrate && rig.metrics.hashrate < rig.expectedHashrate * 0.9) {
            alerts.push({
                type: 'lowHashrate',
                value: rig.metrics.hashrate,
                expected: rig.expectedHashrate,
                severity: 'info'
            });
        }
        
        rig.alerts = alerts;
        
        // 新しいアラートを通知
        alerts.forEach(alert => {
            const alertKey = `${rig.id}-${alert.type}-${alert.device || ''}`;
            if (!this.alerts.has(alertKey)) {
                this.alerts.set(alertKey, alert);
                this.emit('rig-alert', { rig, alert });
            }
        });
    }
    
    /**
     * リグにコマンドを送信
     */
    async sendCommand(rigId, command, params = {}) {
        const rig = this.rigs.get(rigId);
        if (!rig) {
            throw new Error(`Rig not found: ${rigId}`);
        }
        
        this.emit('command-sending', { rigId, command, params });
        
        try {
            // 実際のコマンド送信（実装は通信方法による）
            const result = await this.executeRemoteCommand(rig, command, params);
            
            this.emit('command-success', { rigId, command, result });
            
            return result;
            
        } catch (error) {
            this.emit('command-failed', { rigId, command, error });
            throw error;
        }
    }
    
    /**
     * グループにコマンドを送信
     */
    async sendGroupCommand(groupName, command, params = {}) {
        const group = this.groups.get(groupName);
        if (!group) {
            throw new Error(`Group not found: ${groupName}`);
        }
        
        const results = new Map();
        const promises = [];
        
        group.rigs.forEach(rigId => {
            promises.push(
                this.sendCommand(rigId, command, params)
                    .then(result => results.set(rigId, { success: true, result }))
                    .catch(error => results.set(rigId, { success: false, error }))
            );
        });
        
        await Promise.all(promises);
        
        return results;
    }
    
    /**
     * バッチ設定変更
     */
    async updateBatchConfig(rigIds, config) {
        const results = new Map();
        
        for (const rigId of rigIds) {
            try {
                await this.updateRigConfig(rigId, config);
                results.set(rigId, { success: true });
            } catch (error) {
                results.set(rigId, { success: false, error });
            }
        }
        
        return results;
    }
    
    /**
     * リグの設定を更新
     */
    async updateRigConfig(rigId, config) {
        const rig = this.rigs.get(rigId);
        if (!rig) {
            throw new Error(`Rig not found: ${rigId}`);
        }
        
        // 設定をマージ
        Object.assign(rig.config, config);
        
        // リグに設定を送信
        await this.sendCommand(rigId, 'update-config', config);
        
        this.emit('rig-config-updated', { rig, config });
    }
    
    /**
     * グループを作成
     */
    createGroup(name, config = {}) {
        if (this.groups.has(name)) {
            throw new Error(`Group already exists: ${name}`);
        }
        
        const group = {
            name,
            rigs: new Set(),
            config,
            created: Date.now()
        };
        
        this.groups.set(name, group);
        
        this.emit('group-created', group);
        
        return group;
    }
    
    /**
     * リグをグループに移動
     */
    moveRigToGroup(rigId, groupName) {
        const rig = this.rigs.get(rigId);
        if (!rig) {
            throw new Error(`Rig not found: ${rigId}`);
        }
        
        const newGroup = this.groups.get(groupName);
        if (!newGroup) {
            throw new Error(`Group not found: ${groupName}`);
        }
        
        // 現在のグループから削除
        const oldGroup = this.groups.get(rig.group);
        if (oldGroup) {
            oldGroup.rigs.delete(rigId);
        }
        
        // 新しいグループに追加
        rig.group = groupName;
        newGroup.rigs.add(rigId);
        
        this.emit('rig-moved', { rig, from: oldGroup?.name, to: groupName });
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        const stats = {
            total: this.rigs.size,
            online: 0,
            offline: 0,
            warning: 0,
            byGroup: {},
            totalHashrate: 0,
            totalPower: 0
        };
        
        this.rigs.forEach(rig => {
            if (rig.status === 'online') {
                stats.online++;
            } else {
                stats.offline++;
            }
            
            if (rig.alerts.length > 0) {
                stats.warning++;
            }
            
            stats.totalHashrate += rig.metrics.hashrate || 0;
            stats.totalPower += rig.metrics.powerUsage || 0;
            
            // グループ別統計
            if (!stats.byGroup[rig.group]) {
                stats.byGroup[rig.group] = {
                    count: 0,
                    online: 0,
                    hashrate: 0
                };
            }
            
            stats.byGroup[rig.group].count++;
            if (rig.status === 'online') {
                stats.byGroup[rig.group].online++;
            }
            stats.byGroup[rig.group].hashrate += rig.metrics.hashrate || 0;
        });
        
        return stats;
    }
    
    /**
     * リグIDを生成
     */
    generateRigId() {
        return `rig_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * アラートを作成
     */
    createAlert(rigId, type, data) {
        const alert = {
            id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            rigId,
            type,
            data,
            created: Date.now(),
            acknowledged: false
        };
        
        this.emit('alert-created', alert);
        
        return alert;
    }
    
    /**
     * リモートコマンドを実行（実装は環境依存）
     */
    async executeRemoteCommand(rig, command, params) {
        // SSH、API、またはエージェント経由でコマンドを実行
        // この実装は使用する通信方法に依存
        
        return { success: true, message: 'Command executed' };
    }
}

module.exports = RigManager;