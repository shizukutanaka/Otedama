/**
 * 軽量インシデント管理システム
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import axios from 'axios';

// === 型定義 ===
export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'investigating' | 'resolved' | 'closed';
  source: string;
  timestamp: number;
  resolvedAt?: number;
  assignee?: string;
  tags: string[];
  metadata: Record<string, any>;
}

export interface AlertChannel {
  type: 'webhook' | 'email' | 'slack' | 'discord';
  url: string;
  enabled: boolean;
  filter?: (incident: Incident) => boolean;
}

export interface IncidentRule {
  id: string;
  name: string;
  condition: (data: any) => boolean;
  severity: Incident['severity'];
  title: string;
  description: string;
  tags: string[];
  cooldown: number; // milliseconds
  enabled: boolean;
}

// === 軽量インシデント管理システム ===
export class LightweightIncidentManager extends EventEmitter {
  private incidents = new Map<string, Incident>();
  private rules = new Map<string, IncidentRule>();
  private channels: AlertChannel[] = [];
  private cooldowns = new Map<string, number>();
  private metrics = {
    totalIncidents: 0,
    openIncidents: 0,
    resolvedIncidents: 0,
    averageResolutionTime: 0
  };

  constructor() {
    super();
    this.setupDefaultRules();
  }

  // === 基本機能 ===
  async createIncident(incident: Omit<Incident, 'id' | 'timestamp' | 'status'>): Promise<Incident> {
    const newIncident: Incident = {
      ...incident,
      id: this.generateId(),
      timestamp: Date.now(),
      status: 'open'
    };

    this.incidents.set(newIncident.id, newIncident);
    this.metrics.totalIncidents++;
    this.metrics.openIncidents++;

    this.emit('incidentCreated', newIncident);
    await this.sendAlerts(newIncident);

    return newIncident;
  }

  async resolveIncident(id: string, assignee?: string): Promise<boolean> {
    const incident = this.incidents.get(id);
    if (!incident || incident.status === 'resolved' || incident.status === 'closed') {
      return false;
    }

    incident.status = 'resolved';
    incident.resolvedAt = Date.now();
    if (assignee) incident.assignee = assignee;

    this.metrics.openIncidents--;
    this.metrics.resolvedIncidents++;
    this.updateAverageResolutionTime();

    this.emit('incidentResolved', incident);
    await this.sendAlerts(incident);

    return true;
  }

  async closeIncident(id: string): Promise<boolean> {
    const incident = this.incidents.get(id);
    if (!incident) return false;

    if (incident.status === 'open') {
      this.metrics.openIncidents--;
    }

    incident.status = 'closed';
    this.emit('incidentClosed', incident);

    return true;
  }

  // === ルール管理 ===
  addRule(rule: IncidentRule): void {
    this.rules.set(rule.id, rule);
  }

  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  enableRule(id: string): boolean {
    const rule = this.rules.get(id);
    if (rule) {
      rule.enabled = true;
      return true;
    }
    return false;
  }

  disableRule(id: string): boolean {
    const rule = this.rules.get(id);
    if (rule) {
      rule.enabled = false;
      return true;
    }
    return false;
  }

  // === チャンネル管理 ===
  addAlertChannel(channel: AlertChannel): void {
    this.channels.push(channel);
  }

  removeAlertChannel(url: string): boolean {
    const index = this.channels.findIndex(c => c.url === url);
    if (index !== -1) {
      this.channels.splice(index, 1);
      return true;
    }
    return false;
  }

  // === イベント処理 ===
  async checkRules(data: any, source: string): Promise<Incident[]> {
    const triggeredIncidents: Incident[] = [];

    for (const [id, rule] of this.rules) {
      if (!rule.enabled) continue;

      // クールダウンチェック
      const lastTriggered = this.cooldowns.get(id);
      if (lastTriggered && Date.now() - lastTriggered < rule.cooldown) {
        continue;
      }

      try {
        if (rule.condition(data)) {
          const incident = await this.createIncident({
            title: rule.title,
            description: rule.description,
            severity: rule.severity,
            source,
            tags: rule.tags,
            metadata: { ruleId: id, triggerData: data }
          });

          triggeredIncidents.push(incident);
          this.cooldowns.set(id, Date.now());
        }
      } catch (error) {
        console.error(`Error evaluating rule ${id}:`, error);
      }
    }

    return triggeredIncidents;
  }

  // === アラート送信 ===
  private async sendAlerts(incident: Incident): Promise<void> {
    const promises = this.channels
      .filter(channel => channel.enabled)
      .filter(channel => !channel.filter || channel.filter(incident))
      .map(channel => this.sendAlert(channel, incident));

    await Promise.allSettled(promises);
  }

  private async sendAlert(channel: AlertChannel, incident: Incident): Promise<void> {
    try {
      switch (channel.type) {
        case 'webhook':
          await this.sendWebhookAlert(channel.url, incident);
          break;
        case 'slack':
          await this.sendSlackAlert(channel.url, incident);
          break;
        case 'discord':
          await this.sendDiscordAlert(channel.url, incident);
          break;
        default:
          console.warn(`Unknown channel type: ${channel.type}`);
      }
    } catch (error) {
      console.error(`Failed to send alert to ${channel.url}:`, error);
    }
  }

  private async sendWebhookAlert(url: string, incident: Incident): Promise<void> {
    await axios.post(url, {
      type: 'incident',
      incident,
      timestamp: Date.now()
    }, {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Otedama-IncidentManager/1.0'
      }
    });
  }

  private async sendSlackAlert(webhookUrl: string, incident: Incident): Promise<void> {
    const color = this.getSeverityColor(incident.severity);
    const statusIcon = incident.status === 'resolved' ? '✅' : '🚨';
    
    await axios.post(webhookUrl, {
      attachments: [{
        color,
        title: `${statusIcon} ${incident.title}`,
        text: incident.description,
        fields: [
          { title: 'Severity', value: incident.severity.toUpperCase(), short: true },
          { title: 'Status', value: incident.status.toUpperCase(), short: true },
          { title: 'Source', value: incident.source, short: true },
          { title: 'Time', value: new Date(incident.timestamp).toISOString(), short: true }
        ],
        footer: 'Otedama Incident Manager',
        ts: Math.floor(incident.timestamp / 1000)
      }]
    });
  }

  private async sendDiscordAlert(webhookUrl: string, incident: Incident): Promise<void> {
    const color = this.getSeverityColorCode(incident.severity);
    const statusIcon = incident.status === 'resolved' ? '✅' : '🚨';

    await axios.post(webhookUrl, {
      embeds: [{
        title: `${statusIcon} ${incident.title}`,
        description: incident.description,
        color,
        fields: [
          { name: 'Severity', value: incident.severity.toUpperCase(), inline: true },
          { name: 'Status', value: incident.status.toUpperCase(), inline: true },
          { name: 'Source', value: incident.source, inline: true }
        ],
        footer: { text: 'Otedama Incident Manager' },
        timestamp: new Date(incident.timestamp).toISOString()
      }]
    });
  }

  // === デフォルトルール ===
  private setupDefaultRules(): void {
    // マイニングプール関連のルール
    this.addRule({
      id: 'high-error-rate',
      name: 'High Error Rate',
      condition: (data) => data.errorRate > 0.1, // 10%以上のエラー率
      severity: 'high',
      title: 'High Error Rate Detected',
      description: 'Error rate exceeded 10% threshold',
      tags: ['pool', 'error'],
      cooldown: 300000, // 5分
      enabled: true
    });

    this.addRule({
      id: 'hashrate-drop',
      name: 'Significant Hashrate Drop',
      condition: (data) => data.hashrateDropPercent > 50,
      severity: 'medium',
      title: 'Significant Hashrate Drop',
      description: 'Pool hashrate dropped by more than 50%',
      tags: ['pool', 'hashrate'],
      cooldown: 600000, // 10分
      enabled: true
    });

    this.addRule({
      id: 'blockchain-disconnected',
      name: 'Blockchain Connection Lost',
      condition: (data) => data.blockchainConnected === false,
      severity: 'critical',
      title: 'Blockchain Connection Lost',
      description: 'Lost connection to blockchain network',
      tags: ['blockchain', 'connection'],
      cooldown: 60000, // 1分
      enabled: true
    });

    this.addRule({
      id: 'high-memory-usage',
      name: 'High Memory Usage',
      condition: (data) => data.memoryUsagePercent > 90,
      severity: 'medium',
      title: 'High Memory Usage',
      description: 'Memory usage exceeded 90%',
      tags: ['system', 'memory'],
      cooldown: 300000, // 5分
      enabled: true
    });

    this.addRule({
      id: 'no-miners',
      name: 'No Active Miners',
      condition: (data) => data.activeMiners === 0 && data.uptime > 300000, // 5分以上稼働
      severity: 'medium',
      title: 'No Active Miners',
      description: 'Pool has no active miners',
      tags: ['pool', 'miners'],
      cooldown: 1800000, // 30分
      enabled: true
    });
  }

  // === ユーティリティ ===
  private generateId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2);
    return createHash('sha256').update(timestamp + random).digest('hex').substring(0, 12);
  }

  private getSeverityColor(severity: string): string {
    switch (severity) {
      case 'critical': return 'danger';
      case 'high': return 'warning';
      case 'medium': return '#ff9500';
      case 'low': return 'good';
      default: return '#cccccc';
    }
  }

  private getSeverityColorCode(severity: string): number {
    switch (severity) {
      case 'critical': return 0xff0000; // 赤
      case 'high': return 0xff9500;     // オレンジ
      case 'medium': return 0xffff00;   // 黄
      case 'low': return 0x00ff00;      // 緑
      default: return 0xcccccc;         // グレー
    }
  }

  private updateAverageResolutionTime(): void {
    const resolvedIncidents = Array.from(this.incidents.values())
      .filter(i => i.status === 'resolved' && i.resolvedAt);

    if (resolvedIncidents.length === 0) {
      this.metrics.averageResolutionTime = 0;
      return;
    }

    const totalResolutionTime = resolvedIncidents.reduce((sum, incident) => {
      return sum + ((incident.resolvedAt || 0) - incident.timestamp);
    }, 0);

    this.metrics.averageResolutionTime = totalResolutionTime / resolvedIncidents.length;
  }

  // === 統計・情報取得 ===
  getIncidents(filter?: Partial<Incident>): Incident[] {
    let incidents = Array.from(this.incidents.values());

    if (filter) {
      incidents = incidents.filter(incident => {
        return Object.entries(filter).every(([key, value]) => {
          if (key === 'tags' && Array.isArray(value)) {
            return value.some(tag => incident.tags.includes(tag));
          }
          return incident[key as keyof Incident] === value;
        });
      });
    }

    return incidents.sort((a, b) => b.timestamp - a.timestamp);
  }

  getIncident(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  getMetrics() {
    return { ...this.metrics };
  }

  getRules(): IncidentRule[] {
    return Array.from(this.rules.values());
  }

  getChannels(): AlertChannel[] {
    return [...this.channels];
  }

  // === 設定の永続化（簡易版） ===
  exportConfig(): object {
    return {
      rules: Array.from(this.rules.values()),
      channels: this.channels,
      metrics: this.metrics
    };
  }

  importConfig(config: any): void {
    if (config.rules) {
      config.rules.forEach((rule: IncidentRule) => this.addRule(rule));
    }
    if (config.channels) {
      this.channels = config.channels;
    }
    if (config.metrics) {
      this.metrics = { ...this.metrics, ...config.metrics };
    }
  }
}

// === 使用例とテスト用ヘルパー ===
export class IncidentManagerHelper {
  static createTestIncident(): Omit<Incident, 'id' | 'timestamp' | 'status'> {
    return {
      title: 'Test Incident',
      description: 'This is a test incident for validation',
      severity: 'low',
      source: 'test',
      tags: ['test'],
      metadata: { test: true }
    };
  }

  static createSlackChannel(webhookUrl: string): AlertChannel {
    return {
      type: 'slack',
      url: webhookUrl,
      enabled: true,
      filter: (incident) => incident.severity !== 'low'
    };
  }

  static createDiscordChannel(webhookUrl: string): AlertChannel {
    return {
      type: 'discord',
      url: webhookUrl,
      enabled: true,
      filter: (incident) => ['critical', 'high'].includes(incident.severity)
    };
  }

  static createWebhookChannel(url: string): AlertChannel {
    return {
      type: 'webhook',
      url,
      enabled: true
    };
  }
}

export default LightweightIncidentManager;