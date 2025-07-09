/**
 * PagerDuty統合システム
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 * 
 * 機能:
 * - PagerDutyイベント送信
 * - インシデント自動作成
 * - エスカレーション管理
 * - 解決通知
 * - メトリクス収集
 */

import axios from 'axios';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';

// === 型定義 ===
export interface PagerDutyConfig {
  integrationKey: string;
  apiKey?: string;
  baseUrl?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface PagerDutyEvent {
  event_action: 'trigger' | 'acknowledge' | 'resolve';
  routing_key: string;
  dedup_key?: string;
  images?: PagerDutyImage[];
  links?: PagerDutyLink[];
  payload: {
    summary: string;
    timestamp?: string;
    severity: 'critical' | 'error' | 'warning' | 'info';
    source: string;
    component?: string;
    group?: string;
    class?: string;
    custom_details?: Record<string, any>;
  };
  client?: string;
  client_url?: string;
}

export interface PagerDutyImage {
  src: string;
  href?: string;
  alt?: string;
}

export interface PagerDutyLink {
  href: string;
  text: string;
}

export interface PagerDutyResponse {
  status: string;
  message: string;
  dedup_key?: string;
  errors?: string[];
}

export interface PagerDutyIncident {
  id: string;
  incident_number: number;
  title: string;
  description: string;
  status: 'triggered' | 'acknowledged' | 'resolved';
  urgency: 'high' | 'low';
  created_at: string;
  updated_at: string;
  service: {
    id: string;
    name: string;
  };
  assignments: Array<{
    assignee: {
      id: string;
      name: string;
      email: string;
    };
  }>;
}

export interface PagerDutyMetrics {
  eventsTriggered: number;
  eventsAcknowledged: number;
  eventsResolved: number;
  failedEvents: number;
  averageResponseTime: number;
  openIncidents: number;
  totalIncidents: number;
}

export interface EscalationRule {
  id: string;
  name: string;
  condition: (incident: any) => boolean;
  severity: 'critical' | 'error' | 'warning' | 'info';
  escalateAfter: number; // milliseconds
  enabled: boolean;
}

// === PagerDuty統合クラス ===
export class PagerDutyIntegration extends EventEmitter {
  private config: Required<PagerDutyConfig>;
  private metrics: PagerDutyMetrics;
  private pendingEvents = new Map<string, PagerDutyEvent>();
  private escalationRules = new Map<string, EscalationRule>();
  private escalationTimers = new Map<string, NodeJS.Timeout>();
  private retryQueue = new Map<string, { event: PagerDutyEvent; attempts: number }>();

  constructor(config: PagerDutyConfig) {
    super();
    
    this.config = {
      integrationKey: config.integrationKey,
      apiKey: config.apiKey || '',
      baseUrl: config.baseUrl || 'https://events.pagerduty.com',
      timeout: config.timeout || 10000,
      retryAttempts: config.retryAttempts || 3,
      retryDelay: config.retryDelay || 1000
    };

    this.metrics = {
      eventsTriggered: 0,
      eventsAcknowledged: 0,
      eventsResolved: 0,
      failedEvents: 0,
      averageResponseTime: 0,
      openIncidents: 0,
      totalIncidents: 0
    };

    this.setupDefaultEscalationRules();
  }

  // === イベント送信 ===
  async triggerIncident(
    summary: string,
    severity: 'critical' | 'error' | 'warning' | 'info',
    source: string,
    customDetails?: Record<string, any>,
    dedupKey?: string
  ): Promise<PagerDutyResponse> {
    const event: PagerDutyEvent = {
      event_action: 'trigger',
      routing_key: this.config.integrationKey,
      dedup_key: dedupKey || this.generateDedupKey(summary, source),
      payload: {
        summary: summary.substring(0, 1024), // PagerDutyの制限
        timestamp: new Date().toISOString(),
        severity,
        source,
        component: 'mining-pool',
        group: 'otedama',
        class: 'system',
        custom_details: customDetails
      },
      client: 'Otedama Mining Pool',
      client_url: process.env.POOL_UI_URL || 'http://localhost:3000'
    };

    try {
      const response = await this.sendEvent(event);
      
      this.metrics.eventsTriggered++;
      this.pendingEvents.set(event.dedup_key!, event);
      
      // エスカレーション管理
      this.scheduleEscalation(event);
      
      this.emit('incidentTriggered', { event, response });
      
      console.log(`🚨 PagerDuty incident triggered: ${summary} [${severity}]`);
      return response;
      
    } catch (error) {
      this.metrics.failedEvents++;
      this.emit('eventFailed', { event, error });
      
      // リトライキューに追加
      this.addToRetryQueue(event);
      
      throw error;
    }
  }

  async acknowledgeIncident(dedupKey: string): Promise<PagerDutyResponse> {
    const pendingEvent = this.pendingEvents.get(dedupKey);
    if (!pendingEvent) {
      throw new Error(`No pending incident found with dedup key: ${dedupKey}`);
    }

    const event: PagerDutyEvent = {
      ...pendingEvent,
      event_action: 'acknowledge'
    };

    try {
      const response = await this.sendEvent(event);
      
      this.metrics.eventsAcknowledged++;
      this.clearEscalation(dedupKey);
      
      this.emit('incidentAcknowledged', { event, response });
      
      console.log(`✅ PagerDuty incident acknowledged: ${dedupKey}`);
      return response;
      
    } catch (error) {
      this.metrics.failedEvents++;
      this.emit('eventFailed', { event, error });
      throw error;
    }
  }

  async resolveIncident(dedupKey: string): Promise<PagerDutyResponse> {
    const pendingEvent = this.pendingEvents.get(dedupKey);
    if (!pendingEvent) {
      throw new Error(`No pending incident found with dedup key: ${dedupKey}`);
    }

    const event: PagerDutyEvent = {
      ...pendingEvent,
      event_action: 'resolve'
    };

    try {
      const response = await this.sendEvent(event);
      
      this.metrics.eventsResolved++;
      this.pendingEvents.delete(dedupKey);
      this.clearEscalation(dedupKey);
      
      this.emit('incidentResolved', { event, response });
      
      console.log(`🔧 PagerDuty incident resolved: ${dedupKey}`);
      return response;
      
    } catch (error) {
      this.metrics.failedEvents++;
      this.emit('eventFailed', { event, error });
      throw error;
    }
  }

  // === イベント送信（内部） ===
  private async sendEvent(event: PagerDutyEvent): Promise<PagerDutyResponse> {
    const startTime = Date.now();
    
    try {
      const response = await axios.post(
        `${this.config.baseUrl}/v2/enqueue`,
        event,
        {
          timeout: this.config.timeout,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Otedama-PagerDuty/1.0'
          }
        }
      );

      const responseTime = Date.now() - startTime;
      this.updateAverageResponseTime(responseTime);

      return response.data;
      
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`PagerDuty API error: ${error.response?.status} - ${error.response?.data?.message || error.message}`);
      }
      throw error;
    }
  }

  // === エスカレーション管理 ===
  private scheduleEscalation(event: PagerDutyEvent): void {
    if (!event.dedup_key) return;

    // 適用可能なエスカレーションルールを検索
    for (const [ruleId, rule] of this.escalationRules) {
      if (!rule.enabled) continue;

      try {
        if (rule.condition(event)) {
          const timer = setTimeout(async () => {
            await this.escalateIncident(event, rule);
          }, rule.escalateAfter);

          this.escalationTimers.set(`${event.dedup_key}-${ruleId}`, timer);
        }
      } catch (error) {
        console.error(`Error evaluating escalation rule ${ruleId}:`, error);
      }
    }
  }

  private async escalateIncident(event: PagerDutyEvent, rule: EscalationRule): Promise<void> {
    console.log(`📈 Escalating incident: ${event.payload.summary} [Rule: ${rule.name}]`);

    // 新しい高優先度インシデントとして送信
    const escalatedEvent: PagerDutyEvent = {
      ...event,
      dedup_key: `${event.dedup_key}-escalated-${rule.id}`,
      payload: {
        ...event.payload,
        summary: `[ESCALATED] ${event.payload.summary}`,
        severity: rule.severity,
        custom_details: {
          ...event.payload.custom_details,
          escalation_rule: rule.name,
          original_dedup_key: event.dedup_key,
          escalated_at: new Date().toISOString()
        }
      }
    };

    try {
      await this.sendEvent(escalatedEvent);
      this.emit('incidentEscalated', { originalEvent: event, escalatedEvent, rule });
    } catch (error) {
      console.error('Failed to escalate incident:', error);
    }
  }

  private clearEscalation(dedupKey: string): void {
    // 該当のエスカレーションタイマーをクリア
    for (const [key, timer] of this.escalationTimers) {
      if (key.startsWith(dedupKey)) {
        clearTimeout(timer);
        this.escalationTimers.delete(key);
      }
    }
  }

  // === リトライ管理 ===
  private addToRetryQueue(event: PagerDutyEvent): void {
    if (!event.dedup_key) return;

    const existing = this.retryQueue.get(event.dedup_key);
    const attempts = existing ? existing.attempts + 1 : 1;

    if (attempts <= this.config.retryAttempts) {
      this.retryQueue.set(event.dedup_key, { event, attempts });
      
      setTimeout(async () => {
        await this.retryEvent(event.dedup_key!);
      }, this.config.retryDelay * attempts);
    }
  }

  private async retryEvent(dedupKey: string): Promise<void> {
    const retryItem = this.retryQueue.get(dedupKey);
    if (!retryItem) return;

    try {
      await this.sendEvent(retryItem.event);
      this.retryQueue.delete(dedupKey);
      
      console.log(`🔄 Successfully retried PagerDuty event: ${dedupKey}`);
      
    } catch (error) {
      console.error(`Failed to retry PagerDuty event: ${dedupKey}`, error);
      this.addToRetryQueue(retryItem.event);
    }
  }

  // === デフォルトエスカレーションルール ===
  private setupDefaultEscalationRules(): void {
    this.addEscalationRule({
      id: 'critical-auto-escalate',
      name: 'Critical Incidents Auto Escalation',
      condition: (event) => event.payload.severity === 'critical',
      severity: 'critical',
      escalateAfter: 300000, // 5分
      enabled: true
    });

    this.addEscalationRule({
      id: 'blockchain-disconnect-escalate',
      name: 'Blockchain Disconnect Escalation',
      condition: (event) => event.payload.custom_details?.type === 'blockchain_disconnect',
      severity: 'critical',
      escalateAfter: 120000, // 2分
      enabled: true
    });

    this.addEscalationRule({
      id: 'high-error-escalate',
      name: 'High Error Rate Escalation',
      condition: (event) => 
        event.payload.severity === 'error' && 
        event.payload.custom_details?.errorRate > 0.2, // 20%以上
      severity: 'critical',
      escalateAfter: 600000, // 10分
      enabled: true
    });
  }

  // === エスカレーションルール管理 ===
  addEscalationRule(rule: EscalationRule): void {
    this.escalationRules.set(rule.id, rule);
  }

  removeEscalationRule(id: string): boolean {
    return this.escalationRules.delete(id);
  }

  enableEscalationRule(id: string): boolean {
    const rule = this.escalationRules.get(id);
    if (rule) {
      rule.enabled = true;
      return true;
    }
    return false;
  }

  disableEscalationRule(id: string): boolean {
    const rule = this.escalationRules.get(id);
    if (rule) {
      rule.enabled = false;
      return true;
    }
    return false;
  }

  // === 高レベルヘルパーメソッド ===
  async triggerCriticalAlert(title: string, description: string, details?: Record<string, any>): Promise<PagerDutyResponse> {
    return this.triggerIncident(
      title,
      'critical',
      'mining-pool',
      {
        description,
        alert_type: 'critical',
        ...details
      }
    );
  }

  async triggerBlockchainAlert(message: string, details?: Record<string, any>): Promise<PagerDutyResponse> {
    return this.triggerIncident(
      `Blockchain Alert: ${message}`,
      'error',
      'blockchain',
      {
        type: 'blockchain_disconnect',
        ...details
      }
    );
  }

  async triggerPerformanceAlert(metric: string, value: number, threshold: number): Promise<PagerDutyResponse> {
    return this.triggerIncident(
      `Performance Alert: ${metric} ${value} exceeds threshold ${threshold}`,
      'warning',
      'performance',
      {
        metric,
        value,
        threshold,
        type: 'performance'
      }
    );
  }

  async triggerSecurityAlert(event: string, source: string, details?: Record<string, any>): Promise<PagerDutyResponse> {
    return this.triggerIncident(
      `Security Alert: ${event}`,
      'critical',
      source,
      {
        type: 'security',
        event,
        ...details
      }
    );
  }

  // === 統計・インシデント取得 ===
  async getIncidents(status?: string, limit = 25): Promise<PagerDutyIncident[]> {
    if (!this.config.apiKey) {
      throw new Error('API key required for incident retrieval');
    }

    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        ...(status && { statuses: status })
      });

      const response = await axios.get(
        `https://api.pagerduty.com/incidents?${params}`,
        {
          headers: {
            'Authorization': `Token token=${this.config.apiKey}`,
            'Accept': 'application/vnd.pagerduty+json;version=2'
          }
        }
      );

      return response.data.incidents;
      
    } catch (error) {
      console.error('Failed to fetch PagerDuty incidents:', error);
      throw error;
    }
  }

  async getIncident(incidentId: string): Promise<PagerDutyIncident> {
    if (!this.config.apiKey) {
      throw new Error('API key required for incident retrieval');
    }

    try {
      const response = await axios.get(
        `https://api.pagerduty.com/incidents/${incidentId}`,
        {
          headers: {
            'Authorization': `Token token=${this.config.apiKey}`,
            'Accept': 'application/vnd.pagerduty+json;version=2'
          }
        }
      );

      return response.data.incident;
      
    } catch (error) {
      console.error(`Failed to fetch PagerDuty incident ${incidentId}:`, error);
      throw error;
    }
  }

  // === ユーティリティ ===
  private generateDedupKey(summary: string, source: string): string {
    const content = `${summary}-${source}-${Date.now()}`;
    return createHash('md5').update(content).digest('hex').substring(0, 16);
  }

  private updateAverageResponseTime(responseTime: number): void {
    const totalEvents = this.metrics.eventsTriggered + this.metrics.eventsAcknowledged + this.metrics.eventsResolved;
    this.metrics.averageResponseTime = 
      (this.metrics.averageResponseTime * (totalEvents - 1) + responseTime) / totalEvents;
  }

  // === 設定・状態取得 ===
  getMetrics(): PagerDutyMetrics {
    return { ...this.metrics };
  }

  getEscalationRules(): EscalationRule[] {
    return Array.from(this.escalationRules.values());
  }

  getPendingEvents(): PagerDutyEvent[] {
    return Array.from(this.pendingEvents.values());
  }

  getRetryQueue(): Array<{ dedupKey: string; event: PagerDutyEvent; attempts: number }> {
    return Array.from(this.retryQueue.entries()).map(([dedupKey, item]) => ({
      dedupKey,
      ...item
    }));
  }

  isHealthy(): boolean {
    const failureRate = this.metrics.failedEvents / 
      (this.metrics.eventsTriggered + this.metrics.eventsAcknowledged + this.metrics.eventsResolved + this.metrics.failedEvents);
    
    return failureRate < 0.1 && this.retryQueue.size < 10;
  }

  // === 設定の永続化 ===
  exportConfig(): object {
    return {
      escalationRules: Array.from(this.escalationRules.values()),
      metrics: this.metrics
    };
  }

  importConfig(config: any): void {
    if (config.escalationRules) {
      config.escalationRules.forEach((rule: EscalationRule) => this.addEscalationRule(rule));
    }
    if (config.metrics) {
      this.metrics = { ...this.metrics, ...config.metrics };
    }
  }

  // === 停止処理 ===
  stop(): void {
    // 全エスカレーションタイマーをクリア
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();
    
    console.log('🛑 PagerDuty integration stopped');
  }
}

// === ヘルパークラス ===
export class PagerDutyHelper {
  static createConfig(integrationKey: string, apiKey?: string): PagerDutyConfig {
    return {
      integrationKey,
      apiKey,
      timeout: 10000,
      retryAttempts: 3,
      retryDelay: 2000
    };
  }

  static createMiningPoolIntegration(integrationKey: string, apiKey?: string): PagerDutyIntegration {
    const config = this.createConfig(integrationKey, apiKey);
    return new PagerDutyIntegration(config);
  }

  static validateIntegrationKey(key: string): boolean {
    // PagerDutyの統合キー形式の簡易検証
    return /^[a-f0-9]{32}$/.test(key);
  }

  static validateApiKey(key: string): boolean {
    // PagerDutyのAPIキー形式の簡易検証
    return key.length >= 20 && /^[a-zA-Z0-9+/=]+$/.test(key);
  }

  static formatSeverity(severity: string): 'critical' | 'error' | 'warning' | 'info' {
    switch (severity.toLowerCase()) {
      case 'critical':
      case 'high':
        return 'critical';
      case 'error':
        return 'error';
      case 'warning':
      case 'medium':
        return 'warning';
      default:
        return 'info';
    }
  }

  static createTestEvent(): Omit<PagerDutyEvent, 'routing_key'> {
    return {
      event_action: 'trigger',
      payload: {
        summary: 'Test incident from Otedama Mining Pool',
        severity: 'info',
        source: 'test',
        custom_details: {
          test: true,
          timestamp: new Date().toISOString()
        }
      }
    };
  }
}

export default PagerDutyIntegration;