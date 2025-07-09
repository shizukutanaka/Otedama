// src/incident/incident-manager.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import crypto from 'crypto';

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'investigating' | 'resolved' | 'closed';
  source: string;
  affectedServices: string[];
  assignee?: string;
  team?: string;
  tags: string[];
  metadata: Record<string, any>;
  timestamps: {
    created: Date;
    acknowledged?: Date;
    resolved?: Date;
    closed?: Date;
    lastUpdated: Date;
  };
  escalations: Escalation[];
  updates: IncidentUpdate[];
  metrics: {
    timeToAcknowledge?: number; // minutes
    timeToResolve?: number; // minutes
    impactedUsers?: number;
    estimatedLoss?: number;
  };
}

export interface IncidentUpdate {
  id: string;
  incidentId: string;
  message: string;
  author: string;
  timestamp: Date;
  type: 'comment' | 'status_change' | 'assignment' | 'escalation';
  visibility: 'internal' | 'public';
}

export interface Escalation {
  id: string;
  incidentId: string;
  level: number;
  targetTeam: string;
  targetPerson?: string;
  triggeredAt: Date;
  acknowledgedAt?: Date;
  reason: string;
  automated: boolean;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: AlertCondition[];
  severity: Incident['severity'];
  autoAssign?: {
    team: string;
    person?: string;
  };
  escalationPolicy: EscalationPolicy;
  suppressions: AlertSuppression[];
  tags: string[];
}

export interface AlertCondition {
  metric: string;
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  value: number | string;
  duration: number; // seconds
}

export interface EscalationPolicy {
  id: string;
  name: string;
  steps: EscalationStep[];
}

export interface EscalationStep {
  level: number;
  delayMinutes: number;
  targets: NotificationTarget[];
  autoResolve?: boolean;
}

export interface NotificationTarget {
  type: 'email' | 'sms' | 'slack' | 'pagerduty' | 'webhook';
  address: string;
  priority: 'high' | 'medium' | 'low';
}

export interface AlertSuppression {
  id: string;
  reason: string;
  enabled: boolean;
  startTime: Date;
  endTime: Date;
  conditions: AlertCondition[];
}

export interface NotificationChannel {
  type: string;
  send(target: NotificationTarget, incident: Incident, message: string): Promise<boolean>;
}

export class IncidentManager {
  private logger: Logger;
  private cache: RedisCache;
  private incidents: Map<string, Incident> = new Map();
  private alertRules: Map<string, AlertRule> = new Map();
  private escalationPolicies: Map<string, EscalationPolicy> = new Map();
  private notificationChannels: Map<string, NotificationChannel> = new Map();
  private escalationTimers: Map<string, NodeJS.Timeout> = new Map();
  private suppressions: Map<string, AlertSuppression> = new Map();

  constructor(logger: Logger, cache: RedisCache) {
    this.logger = logger;
    this.cache = cache;
    
    this.setupDefaultNotificationChannels();
    this.startBackgroundTasks();
  }

  // Incident lifecycle management
  public async createIncident(
    title: string,
    description: string,
    severity: Incident['severity'],
    source: string,
    affectedServices: string[] = [],
    metadata: Record<string, any> = {}
  ): Promise<Incident> {
    const incident: Incident = {
      id: crypto.randomUUID(),
      title,
      description,
      severity,
      status: 'open',
      source,
      affectedServices,
      tags: [],
      metadata,
      timestamps: {
        created: new Date(),
        lastUpdated: new Date()
      },
      escalations: [],
      updates: [],
      metrics: {}
    };

    // Auto-assign based on rules
    await this.autoAssignIncident(incident);

    // Start escalation if needed
    await this.startEscalation(incident);

    // Store incident
    this.incidents.set(incident.id, incident);
    await this.persistIncident(incident);

    // Send initial notifications
    await this.sendIncidentNotifications(incident, 'created');

    this.logger.info(`Incident created: ${incident.id}`, {
      incidentId: incident.id,
      title: incident.title,
      severity: incident.severity,
      source: incident.source
    });

    return incident;
  }

  public async updateIncidentStatus(
    incidentId: string,
    status: Incident['status'],
    author: string,
    message?: string
  ): Promise<Incident> {
    const incident = await this.getIncident(incidentId);
    if (!incident) {
      throw new Error(`Incident ${incidentId} not found`);
    }

    const oldStatus = incident.status;
    incident.status = status;
    incident.timestamps.lastUpdated = new Date();

    // Set specific timestamps
    switch (status) {
      case 'investigating':
        if (!incident.timestamps.acknowledged) {
          incident.timestamps.acknowledged = new Date();
          incident.metrics.timeToAcknowledge = 
            (incident.timestamps.acknowledged.getTime() - incident.timestamps.created.getTime()) / (1000 * 60);
        }
        break;
      case 'resolved':
        incident.timestamps.resolved = new Date();
        incident.metrics.timeToResolve = 
          (incident.timestamps.resolved.getTime() - incident.timestamps.created.getTime()) / (1000 * 60);
        break;
      case 'closed':
        incident.timestamps.closed = new Date();
        this.stopEscalation(incidentId);
        break;
    }

    // Add status update
    await this.addIncidentUpdate(incidentId, {
      message: message || `Status changed from ${oldStatus} to ${status}`,
      author,
      type: 'status_change',
      visibility: 'internal'
    });

    await this.persistIncident(incident);
    await this.sendIncidentNotifications(incident, 'updated');

    this.logger.info(`Incident ${incidentId} status updated to ${status}`, {
      incidentId,
      oldStatus,
      newStatus: status,
      author
    });

    return incident;
  }

  public async assignIncident(
    incidentId: string,
    assignee: string,
    team?: string,
    author?: string
  ): Promise<Incident> {
    const incident = await this.getIncident(incidentId);
    if (!incident) {
      throw new Error(`Incident ${incidentId} not found`);
    }

    incident.assignee = assignee;
    incident.team = team;
    incident.timestamps.lastUpdated = new Date();

    await this.addIncidentUpdate(incidentId, {
      message: `Assigned to ${assignee}${team ? ` (${team})` : ''}`,
      author: author || 'system',
      type: 'assignment',
      visibility: 'internal'
    });

    await this.persistIncident(incident);
    await this.sendIncidentNotifications(incident, 'assigned');

    return incident;
  }

  public async addIncidentUpdate(
    incidentId: string,
    update: Omit<IncidentUpdate, 'id' | 'incidentId' | 'timestamp'>
  ): Promise<IncidentUpdate> {
    const incident = await this.getIncident(incidentId);
    if (!incident) {
      throw new Error(`Incident ${incidentId} not found`);
    }

    const incidentUpdate: IncidentUpdate = {
      id: crypto.randomUUID(),
      incidentId,
      timestamp: new Date(),
      ...update
    };

    incident.updates.push(incidentUpdate);
    incident.timestamps.lastUpdated = new Date();

    await this.persistIncident(incident);

    if (update.visibility === 'public') {
      await this.sendIncidentNotifications(incident, 'updated');
    }

    return incidentUpdate;
  }

  // Alert rule management
  public addAlertRule(rule: AlertRule): void {
    this.alertRules.set(rule.id, rule);
    this.logger.info(`Alert rule added: ${rule.name}`, { ruleId: rule.id });
  }

  public async evaluateAlertRules(metrics: Record<string, number>): Promise<void> {
    for (const [ruleId, rule] of this.alertRules.entries()) {
      if (!rule.enabled) continue;

      try {
        const triggered = await this.evaluateRule(rule, metrics);
        if (triggered) {
          await this.triggerAlert(rule, metrics);
        }
      } catch (error) {
        this.logger.error(`Error evaluating alert rule ${ruleId}:`, error);
      }
    }
  }

  private async evaluateRule(rule: AlertRule, metrics: Record<string, number>): Promise<boolean> {
    // Check if alert is suppressed
    if (await this.isAlertSuppressed(rule)) {
      return false;
    }

    // Evaluate all conditions
    for (const condition of rule.conditions) {
      const metricValue = metrics[condition.metric];
      if (metricValue === undefined) continue;

      const conditionMet = this.evaluateCondition(condition, metricValue);
      if (!conditionMet) {
        return false;
      }
    }

    return rule.conditions.length > 0;
  }

  private evaluateCondition(condition: AlertCondition, value: number): boolean {
    const threshold = typeof condition.value === 'number' ? condition.value : parseFloat(condition.value as string);
    
    switch (condition.operator) {
      case '>': return value > threshold;
      case '<': return value < threshold;
      case '>=': return value >= threshold;
      case '<=': return value <= threshold;
      case '==': return value === threshold;
      case '!=': return value !== threshold;
      default: return false;
    }
  }

  private async triggerAlert(rule: AlertRule, metrics: Record<string, number>): Promise<void> {
    // Check for duplicate alerts
    const recentIncidents = await this.getRecentIncidentsByRule(rule.id, 300); // 5 minutes
    if (recentIncidents.length > 0) {
      this.logger.debug(`Skipping duplicate alert for rule ${rule.id}`);
      return;
    }

    // Create incident from alert
    const title = `Alert: ${rule.name}`;
    const description = this.generateAlertDescription(rule, metrics);
    
    const incident = await this.createIncident(
      title,
      description,
      rule.severity,
      `alert-rule:${rule.id}`,
      [], // affected services would be determined by rule
      { alertRule: rule.id, triggerMetrics: metrics, tags: rule.tags }
    );

    // Auto-assign if specified
    if (rule.autoAssign) {
      await this.assignIncident(
        incident.id,
        rule.autoAssign.person || 'unassigned',
        rule.autoAssign.team,
        'alert-system'
      );
    }

    this.logger.warn(`Alert triggered: ${rule.name}`, {
      ruleId: rule.id,
      incidentId: incident.id,
      severity: rule.severity
    });
  }

  // Escalation management
  private async startEscalation(incident: Incident): Promise<void> {
    // Find escalation policy based on incident attributes
    const escalationPolicy = this.findEscalationPolicy(incident);
    if (!escalationPolicy) return;

    this.scheduleEscalationStep(incident.id, escalationPolicy, 0);
  }

  private scheduleEscalationStep(
    incidentId: string,
    policy: EscalationPolicy,
    stepIndex: number
  ): void {
    if (stepIndex >= policy.steps.length) return;

    const step = policy.steps[stepIndex];
    const delay = step.delayMinutes * 60 * 1000; // Convert to milliseconds

    const timer = setTimeout(async () => {
      try {
        const incident = await this.getIncident(incidentId);
        if (!incident || incident.status === 'resolved' || incident.status === 'closed') {
          return;
        }

        await this.executeEscalationStep(incident, step, stepIndex);
        
        // Schedule next step
        this.scheduleEscalationStep(incidentId, policy, stepIndex + 1);
      } catch (error) {
        this.logger.error(`Escalation step failed for incident ${incidentId}:`, error);
      }
    }, delay);

    this.escalationTimers.set(`${incidentId}:${stepIndex}`, timer);
  }

  private async executeEscalationStep(
    incident: Incident,
    step: EscalationStep,
    level: number
  ): Promise<void> {
    const escalation: Escalation = {
      id: crypto.randomUUID(),
      incidentId: incident.id,
      level,
      targetTeam: step.targets[0]?.address || 'unknown',
      triggeredAt: new Date(),
      reason: `Automatic escalation after ${step.delayMinutes} minutes`,
      automated: true
    };

    incident.escalations.push(escalation);

    // Send escalation notifications
    for (const target of step.targets) {
      await this.sendNotification(target, incident, 
        `🚨 ESCALATION LEVEL ${level + 1}: ${incident.title}`);
    }

    await this.addIncidentUpdate(incident.id, {
      message: `Escalated to level ${level + 1}`,
      author: 'escalation-system',
      type: 'escalation',
      visibility: 'internal'
    });

    await this.persistIncident(incident);

    this.logger.warn(`Incident ${incident.id} escalated to level ${level + 1}`);
  }

  private stopEscalation(incidentId: string): void {
    // Clear all escalation timers for this incident
    for (const [key, timer] of this.escalationTimers.entries()) {
      if (key.startsWith(`${incidentId}:`)) {
        clearTimeout(timer);
        this.escalationTimers.delete(key);
      }
    }
  }

  // Notification system
  private async sendIncidentNotifications(
    incident: Incident,
    event: 'created' | 'updated' | 'assigned' | 'resolved'
  ): Promise<void> {
    const message = this.formatIncidentMessage(incident, event);
    
    // Determine notification targets based on incident properties
    const targets = await this.getNotificationTargets(incident);
    
    for (const target of targets) {
      await this.sendNotification(target, incident, message);
    }
  }

  private async sendNotification(
    target: NotificationTarget,
    incident: Incident,
    message: string
  ): Promise<void> {
    try {
      const channel = this.notificationChannels.get(target.type);
      if (!channel) {
        this.logger.warn(`No notification channel for type: ${target.type}`);
        return;
      }

      const success = await channel.send(target, incident, message);
      if (success) {
        this.logger.debug(`Notification sent via ${target.type} to ${target.address}`);
      } else {
        this.logger.warn(`Failed to send notification via ${target.type} to ${target.address}`);
      }
    } catch (error) {
      this.logger.error(`Notification error for ${target.type}:`, error);
    }
  }

  // Helper methods
  private async getIncident(incidentId: string): Promise<Incident | null> {
    // Try memory first
    const cached = this.incidents.get(incidentId);
    if (cached) return cached;

    // Try persistent storage
    const stored = await this.cache.get(`incident:${incidentId}`);
    if (stored) {
      const incident = JSON.parse(stored) as Incident;
      this.incidents.set(incidentId, incident);
      return incident;
    }

    return null;
  }

  private async persistIncident(incident: Incident): Promise<void> {
    await this.cache.set(
      `incident:${incident.id}`,
      JSON.stringify(incident),
      86400 * 30 // 30 days
    );
  }

  private async autoAssignIncident(incident: Incident): Promise<void> {
    // Simple assignment logic based on severity and affected services
    if (incident.severity === 'critical') {
      incident.assignee = 'on-call-engineer';
      incident.team = 'infrastructure';
    } else if (incident.affectedServices.includes('mining')) {
      incident.assignee = 'mining-team-lead';
      incident.team = 'mining';
    }
  }

  private findEscalationPolicy(incident: Incident): EscalationPolicy | null {
    // Simplified: return default policy based on severity
    const policyId = incident.severity === 'critical' ? 'critical-escalation' : 'standard-escalation';
    return this.escalationPolicies.get(policyId) || null;
  }

  private async getNotificationTargets(incident: Incident): Promise<NotificationTarget[]> {
    const targets: NotificationTarget[] = [];

    // Add team notifications
    if (incident.team) {
      targets.push({
        type: 'slack',
        address: `#team-${incident.team}`,
        priority: 'medium'
      });
    }

    // Add assignee notifications
    if (incident.assignee) {
      targets.push({
        type: 'email',
        address: `${incident.assignee}@company.com`,
        priority: 'high'
      });
    }

    // Add severity-based notifications
    if (incident.severity === 'critical') {
      targets.push({
        type: 'pagerduty',
        address: 'critical-incidents',
        priority: 'high'
      });
    }

    return targets;
  }

  private formatIncidentMessage(incident: Incident, event: string): string {
    const emoji = {
      critical: '🔥',
      high: '⚠️',
      medium: '⚡',
      low: 'ℹ️'
    };

    return `${emoji[incident.severity]} **${event.toUpperCase()}**: ${incident.title}
Status: ${incident.status}
Severity: ${incident.severity}
Assignee: ${incident.assignee || 'Unassigned'}
Created: ${incident.timestamps.created.toISOString()}
Incident ID: ${incident.id}`;
  }

  private generateAlertDescription(rule: AlertRule, metrics: Record<string, number>): string {
    const conditions = rule.conditions.map(condition => 
      `${condition.metric} ${condition.operator} ${condition.value} (current: ${metrics[condition.metric]})`
    ).join(', ');

    return `Alert triggered by rule "${rule.name}". Conditions: ${conditions}`;
  }

  private async isAlertSuppressed(rule: AlertRule): Promise<boolean> {
    const now = new Date();
    
    for (const suppression of rule.suppressions) {
      if (!suppression.enabled) continue;
      
      if (now >= suppression.startTime && now <= suppression.endTime) {
        return true;
      }
    }
    
    return false;
  }

  private async getRecentIncidentsByRule(ruleId: string, windowSeconds: number): Promise<Incident[]> {
    const cutoff = Date.now() - (windowSeconds * 1000);
    const incidents: Incident[] = [];
    
    for (const incident of this.incidents.values()) {
      if (incident.metadata.alertRule === ruleId && 
          incident.timestamps.created.getTime() > cutoff) {
        incidents.push(incident);
      }
    }
    
    return incidents;
  }

  private setupDefaultNotificationChannels(): void {
    // Email channel
    this.notificationChannels.set('email', new EmailNotificationChannel(this.logger));
    
    // Slack channel
    this.notificationChannels.set('slack', new SlackNotificationChannel(this.logger));
    
    // Webhook channel
    this.notificationChannels.set('webhook', new WebhookNotificationChannel(this.logger));
  }

  private startBackgroundTasks(): void {
    // Cleanup old incidents
    setInterval(async () => {
      await this.cleanupOldIncidents();
    }, 3600000); // Every hour

    // Check for stale incidents
    setInterval(async () => {
      await this.checkStaleIncidents();
    }, 1800000); // Every 30 minutes
  }

  private async cleanupOldIncidents(): Promise<void> {
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000); // 30 days ago
    let cleanedCount = 0;

    for (const [id, incident] of this.incidents.entries()) {
      if (incident.status === 'closed' && 
          incident.timestamps.closed && 
          incident.timestamps.closed.getTime() < cutoff) {
        this.incidents.delete(id);
        await this.cache.del(`incident:${id}`);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.info(`Cleaned up ${cleanedCount} old incidents`);
    }
  }

  private async checkStaleIncidents(): Promise<void> {
    const staleThreshold = 24 * 60 * 60 * 1000; // 24 hours
    const now = Date.now();

    for (const incident of this.incidents.values()) {
      if (incident.status === 'open' || incident.status === 'investigating') {
        const lastUpdate = incident.timestamps.lastUpdated.getTime();
        
        if (now - lastUpdate > staleThreshold) {
          await this.addIncidentUpdate(incident.id, {
            message: 'This incident has been stale for more than 24 hours',
            author: 'stale-incident-detector',
            type: 'comment',
            visibility: 'internal'
          });

          this.logger.warn(`Stale incident detected: ${incident.id}`);
        }
      }
    }
  }

  // Public API methods
  public async getIncidents(filters?: {
    status?: Incident['status'];
    severity?: Incident['severity'];
    assignee?: string;
    team?: string;
    limit?: number;
  }): Promise<Incident[]> {
    let incidents = Array.from(this.incidents.values());

    if (filters) {
      if (filters.status) {
        incidents = incidents.filter(i => i.status === filters.status);
      }
      if (filters.severity) {
        incidents = incidents.filter(i => i.severity === filters.severity);
      }
      if (filters.assignee) {
        incidents = incidents.filter(i => i.assignee === filters.assignee);
      }
      if (filters.team) {
        incidents = incidents.filter(i => i.team === filters.team);
      }
    }

    // Sort by creation time (newest first)
    incidents.sort((a, b) => b.timestamps.created.getTime() - a.timestamps.created.getTime());

    if (filters?.limit) {
      incidents = incidents.slice(0, filters.limit);
    }

    return incidents;
  }

  public async getIncidentMetrics(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    averageTimeToResolve: number;
    averageTimeToAcknowledge: number;
  }> {
    const incidents = Array.from(this.incidents.values());
    
    const byStatus = incidents.reduce((acc, incident) => {
      acc[incident.status] = (acc[incident.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const bySeverity = incidents.reduce((acc, incident) => {
      acc[incident.severity] = (acc[incident.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const resolvedIncidents = incidents.filter(i => i.metrics.timeToResolve);
    const acknowledgedIncidents = incidents.filter(i => i.metrics.timeToAcknowledge);

    const averageTimeToResolve = resolvedIncidents.length > 0 
      ? resolvedIncidents.reduce((sum, i) => sum + (i.metrics.timeToResolve || 0), 0) / resolvedIncidents.length
      : 0;

    const averageTimeToAcknowledge = acknowledgedIncidents.length > 0
      ? acknowledgedIncidents.reduce((sum, i) => sum + (i.metrics.timeToAcknowledge || 0), 0) / acknowledgedIncidents.length
      : 0;

    return {
      total: incidents.length,
      byStatus,
      bySeverity,
      averageTimeToResolve,
      averageTimeToAcknowledge
    };
  }
}

// Notification channel implementations
class EmailNotificationChannel implements NotificationChannel {
  constructor(private logger: Logger) {}

  async send(target: NotificationTarget, incident: Incident, message: string): Promise<boolean> {
    // In production, integrate with email service (SendGrid, SES, etc.)
    this.logger.info(`[EMAIL] To: ${target.address}, Message: ${message}`);
    return true;
  }
}

class SlackNotificationChannel implements NotificationChannel {
  constructor(private logger: Logger) {}

  async send(target: NotificationTarget, incident: Incident, message: string): Promise<boolean> {
    // In production, integrate with Slack API
    this.logger.info(`[SLACK] Channel: ${target.address}, Message: ${message}`);
    return true;
  }
}

class WebhookNotificationChannel implements NotificationChannel {
  constructor(private logger: Logger) {}

  async send(target: NotificationTarget, incident: Incident, message: string): Promise<boolean> {
    try {
      // In production, make HTTP POST to webhook URL
      this.logger.info(`[WEBHOOK] URL: ${target.address}, Incident: ${incident.id}`);
      return true;
    } catch (error) {
      this.logger.error(`Webhook notification failed:`, error);
      return false;
    }
  }
}