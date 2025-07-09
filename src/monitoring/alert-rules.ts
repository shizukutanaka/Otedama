/**
 * Alert Rule Engine - Staged Escalation System
 * 
 * Design Philosophy:
 * - Carmack: High performance, direct metric evaluation
 * - Martin: Clean separation of concerns, clear rules
 * - Pike: Simple rule syntax, minimal complexity
 */

import { EventEmitter } from 'events';
import { UnifiedLogger } from '../logging/unified-logger';
import { UnifiedMetrics } from '../metrics/unified-metrics';

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  condition: string; // Simple metric condition like "cpu_usage > 80"
  severity: 'info' | 'warning' | 'critical';
  escalationStages: EscalationStage[];
  enabled: boolean;
  tags: Record<string, string>;
  suppressionDuration?: number; // Minutes to suppress repeat alerts
}

export interface EscalationStage {
  delayMinutes: number;
  actions: AlertAction[];
}

export interface AlertAction {
  type: 'log' | 'webhook' | 'email' | 'slack';
  config: Record<string, any>;
}

export interface Alert {
  id: string;
  ruleId: string;
  timestamp: Date;
  severity: string;
  message: string;
  value: number;
  tags: Record<string, string>;
  resolved?: boolean;
  resolvedAt?: Date;
}

export class AlertRuleEngine extends EventEmitter {
  private rules: Map<string, AlertRule> = new Map();
  private activeAlerts: Map<string, Alert> = new Map();
  private suppressedAlerts: Set<string> = new Set();
  private escalationTimers: Map<string, NodeJS.Timeout[]> = new Map();
  private evaluationInterval: NodeJS.Timeout | null = null;

  constructor(
    private metrics: UnifiedMetrics,
    private logger: UnifiedLogger,
    private config = {
      evaluationIntervalMs: 30000, // 30 seconds
      defaultSuppressionMinutes: 15
    }
  ) {
    super();
    this.initializeDefaultRules();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Alert Rule Engine...');
    
    // Start periodic rule evaluation
    this.evaluationInterval = setInterval(() => {
      this.evaluateAllRules();
    }, this.config.evaluationIntervalMs);

    this.logger.info('Alert Rule Engine started');
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Alert Rule Engine...');
    
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }

    // Clear all escalation timers
    for (const timers of this.escalationTimers.values()) {
      timers.forEach(timer => clearTimeout(timer));
    }
    this.escalationTimers.clear();

    this.logger.info('Alert Rule Engine stopped');
  }

  public addRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
    this.logger.info(`Added alert rule: ${rule.name}`);
  }

  public removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
    this.clearEscalationTimers(ruleId);
    this.logger.info(`Removed alert rule: ${ruleId}`);
  }

  public updateRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
    this.clearEscalationTimers(rule.id);
    this.logger.info(`Updated alert rule: ${rule.name}`);
  }

  public getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values());
  }

  public resolveAlert(alertId: string): void {
    const alert = this.activeAlerts.get(alertId);
    if (alert && !alert.resolved) {
      alert.resolved = true;
      alert.resolvedAt = new Date();
      this.clearEscalationTimers(alertId);
      this.emit('alertResolved', alert);
      this.logger.info(`Resolved alert: ${alertId}`);
    }
  }

  private async evaluateAllRules(): Promise<void> {
    for (const rule of this.rules.values()) {
      if (rule.enabled) {
        await this.evaluateRule(rule);
      }
    }
  }

  private async evaluateRule(rule: AlertRule): Promise<void> {
    try {
      const shouldAlert = await this.evaluateCondition(rule.condition);
      const alertKey = `${rule.id}_condition`;

      if (shouldAlert) {
        if (!this.activeAlerts.has(alertKey) && !this.suppressedAlerts.has(alertKey)) {
          await this.triggerAlert(rule, alertKey);
        }
      } else {
        // Condition no longer met, resolve if active
        if (this.activeAlerts.has(alertKey)) {
          this.resolveAlert(alertKey);
        }
      }
    } catch (error) {
      this.logger.error(`Error evaluating rule ${rule.id}:`, error);
    }
  }

  private async evaluateCondition(condition: string): Promise<boolean> {
    // Simple condition parser - in production, use a proper expression parser
    const match = condition.match(/(\w+)\s*([><=!]+)\s*(\d+(?:\.\d+)?)/);
    if (!match) {
      throw new Error(`Invalid condition format: ${condition}`);
    }

    const [, metric, operator, thresholdStr] = match;
    const threshold = parseFloat(thresholdStr);
    const value = await this.getMetricValue(metric);

    switch (operator) {
      case '>': return value > threshold;
      case '>=': return value >= threshold;
      case '<': return value < threshold;
      case '<=': return value <= threshold;
      case '==': return value === threshold;
      case '!=': return value !== threshold;
      default:
        throw new Error(`Unknown operator: ${operator}`);
    }
  }

  private async getMetricValue(metricName: string): Promise<number> {
    // Map common metric names to actual metric values
    const metricMap: Record<string, () => Promise<number>> = {
      'cpu_usage': () => this.metrics.getCPUUsage(),
      'memory_usage': () => this.metrics.getMemoryUsage(),
      'pool_hashrate': () => this.metrics.getPoolHashrate(),
      'active_miners': () => this.metrics.getActiveMinerCount(),
      'pending_shares': () => this.metrics.getPendingShareCount(),
      'error_rate': () => this.metrics.getErrorRate()
    };

    const getter = metricMap[metricName];
    if (!getter) {
      throw new Error(`Unknown metric: ${metricName}`);
    }

    return await getter();
  }

  private async triggerAlert(rule: AlertRule, alertKey: string): Promise<void> {
    const alert: Alert = {
      id: alertKey,
      ruleId: rule.id,
      timestamp: new Date(),
      severity: rule.severity,
      message: `Alert: ${rule.name} - ${rule.description}`,
      value: await this.getMetricValue(rule.condition.split(' ')[0]),
      tags: rule.tags
    };

    this.activeAlerts.set(alertKey, alert);
    this.emit('alertTriggered', alert);
    
    this.logger.warn(`Alert triggered: ${alert.message}`, {
      ruleId: rule.id,
      severity: rule.severity,
      value: alert.value
    });

    // Start escalation process
    this.startEscalation(rule, alert);

    // Apply suppression
    if (rule.suppressionDuration) {
      this.suppressedAlerts.add(alertKey);
      setTimeout(() => {
        this.suppressedAlerts.delete(alertKey);
      }, rule.suppressionDuration * 60 * 1000);
    }
  }

  private startEscalation(rule: AlertRule, alert: Alert): void {
    const timers: NodeJS.Timeout[] = [];
    
    rule.escalationStages.forEach((stage, index) => {
      const timer = setTimeout(async () => {
        if (this.activeAlerts.has(alert.id) && !this.activeAlerts.get(alert.id)?.resolved) {
          await this.executeEscalationStage(stage, alert, index + 1);
        }
      }, stage.delayMinutes * 60 * 1000);
      
      timers.push(timer);
    });

    this.escalationTimers.set(alert.id, timers);
  }

  private async executeEscalationStage(stage: EscalationStage, alert: Alert, stageNumber: number): Promise<void> {
    this.logger.warn(`Executing escalation stage ${stageNumber} for alert ${alert.id}`);
    
    for (const action of stage.actions) {
      try {
        await this.executeAction(action, alert, stageNumber);
      } catch (error) {
        this.logger.error(`Failed to execute action ${action.type}:`, error);
      }
    }
  }

  private async executeAction(action: AlertAction, alert: Alert, stageNumber: number): Promise<void> {
    switch (action.type) {
      case 'log':
        this.logger.error(`[ESCALATION ${stageNumber}] ${alert.message}`, {
          alertId: alert.id,
          severity: alert.severity,
          value: alert.value
        });
        break;

      case 'webhook':
        if (action.config.url) {
          // In a real implementation, make HTTP request to webhook
          this.logger.info(`Would send webhook to ${action.config.url}`, { alert, stageNumber });
        }
        break;

      case 'email':
        if (action.config.recipients) {
          // In a real implementation, send email
          this.logger.info(`Would send email to ${action.config.recipients}`, { alert, stageNumber });
        }
        break;

      case 'slack':
        if (action.config.channel) {
          // In a real implementation, send to Slack
          this.logger.info(`Would send to Slack channel ${action.config.channel}`, { alert, stageNumber });
        }
        break;

      default:
        this.logger.warn(`Unknown action type: ${action.type}`);
    }
  }

  private clearEscalationTimers(alertId: string): void {
    const timers = this.escalationTimers.get(alertId);
    if (timers) {
      timers.forEach(timer => clearTimeout(timer));
      this.escalationTimers.delete(alertId);
    }
  }

  private initializeDefaultRules(): void {
    // Default alert rules for common scenarios
    const defaultRules: AlertRule[] = [
      {
        id: 'high_cpu_usage',
        name: 'High CPU Usage',
        description: 'CPU usage is above 85%',
        condition: 'cpu_usage > 85',
        severity: 'warning',
        enabled: true,
        tags: { category: 'performance' },
        suppressionDuration: 15,
        escalationStages: [
          {
            delayMinutes: 0,
            actions: [{ type: 'log', config: {} }]
          },
          {
            delayMinutes: 5,
            actions: [
              { type: 'log', config: {} },
              { type: 'webhook', config: { url: process.env.ALERT_WEBHOOK_URL } }
            ]
          }
        ]
      },
      {
        id: 'critical_cpu_usage',
        name: 'Critical CPU Usage',
        description: 'CPU usage is above 95%',
        condition: 'cpu_usage > 95',
        severity: 'critical',
        enabled: true,
        tags: { category: 'performance' },
        suppressionDuration: 10,
        escalationStages: [
          {
            delayMinutes: 0,
            actions: [
              { type: 'log', config: {} },
              { type: 'webhook', config: { url: process.env.ALERT_WEBHOOK_URL } }
            ]
          },
          {
            delayMinutes: 2,
            actions: [
              { type: 'log', config: {} },
              { type: 'email', config: { recipients: process.env.ALERT_EMAIL_RECIPIENTS } }
            ]
          }
        ]
      },
      {
        id: 'low_pool_hashrate',
        name: 'Low Pool Hashrate',
        description: 'Pool hashrate dropped significantly',
        condition: 'pool_hashrate < 1000000', // 1 MH/s
        severity: 'warning',
        enabled: true,
        tags: { category: 'mining' },
        suppressionDuration: 30,
        escalationStages: [
          {
            delayMinutes: 1,
            actions: [{ type: 'log', config: {} }]
          },
          {
            delayMinutes: 10,
            actions: [
              { type: 'log', config: {} },
              { type: 'webhook', config: { url: process.env.ALERT_WEBHOOK_URL } }
            ]
          }
        ]
      }
    ];

    defaultRules.forEach(rule => this.addRule(rule));
  }
}