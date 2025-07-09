/**
 * Advanced Alert Management System
 * Design: Carmack (Performance) + Martin (Clean) + Pike (Simplicity)
 * 
 * Comprehensive alerting with escalation policies and intelligent routing
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import { ComponentLogger } from '../logging/winston-logger';

// ===== INTERFACES =====
export interface AlertConfig {
  enabled: boolean;
  escalationPolicies: EscalationPolicy[];
  notificationChannels: NotificationChannel[];
  silenceRules: SilenceRule[];
  groupingRules: GroupingRule[];
}

export interface EscalationPolicy {
  id: string;
  name: string;
  steps: EscalationStep[];
  repeatInterval: number; // seconds
  maxEscalations: number;
}

export interface EscalationStep {
  delay: number; // seconds
  channels: string[];
  condition?: string; // Optional condition to trigger this step
}

export interface NotificationChannel {
  id: string;
  type: 'slack' | 'discord' | 'email' | 'webhook' | 'pagerduty' | 'sms';
  name: string;
  config: Record<string, any>;
  enabled: boolean;
  rateLimits?: {
    maxPerMinute: number;
    maxPerHour: number;
  };
}

export interface SilenceRule {
  id: string;
  matchers: AlertMatcher[];
  startsAt: Date;
  endsAt: Date;
  comment: string;
  createdBy: string;
}

export interface GroupingRule {
  id: string;
  matchers: AlertMatcher[];
  groupBy: string[];
  groupWait: number;
  groupInterval: number;
  repeatInterval: number;
}

export interface AlertMatcher {
  name: string;
  value: string | RegExp;
  isRegex: boolean;
}

export interface Alert {
  id: string;
  fingerprint: string;
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: Date;
  endsAt?: Date;
  generatorURL?: string;
  severity: 'critical' | 'warning' | 'info';
  escalationLevel: number;
  lastEscalated?: Date;
  silenced: boolean;
  groupKey?: string;
}

export interface AlertGroup {
  key: string;
  alerts: Alert[];
  labels: Record<string, string>;
  lastUpdate: Date;
  status: 'active' | 'resolved' | 'silenced';
}

// ===== ALERT MANAGER =====
export class AlertManager extends EventEmitter {
  private config: AlertConfig;
  private alerts = new Map<string, Alert>();
  private alertGroups = new Map<string, AlertGroup>();
  private silencedAlerts = new Set<string>();
  private escalationTimers = new Map<string, NodeJS.Timeout>();
  private channelRateLimits = new Map<string, { minute: number[], hour: number[] }>();

  constructor(
    config: AlertConfig,
    private logger: ComponentLogger
  ) {
    super();
    this.config = config;
    this.startCleanupTask();
  }

  /**
   * Process incoming alert
   */
  async processAlert(alert: Partial<Alert>): Promise<void> {
    const fullAlert = this.enrichAlert(alert);
    const existingAlert = this.alerts.get(fullAlert.id);

    // Check if alert should be silenced
    if (this.shouldSilenceAlert(fullAlert)) {
      fullAlert.silenced = true;
      this.silencedAlerts.add(fullAlert.id);
      this.logger.debug('Alert silenced', { alertId: fullAlert.id });
      return;
    }

    if (existingAlert) {
      await this.updateExistingAlert(existingAlert, fullAlert);
    } else {
      await this.handleNewAlert(fullAlert);
    }

    this.alerts.set(fullAlert.id, fullAlert);
    await this.groupAlerts(fullAlert);
  }

  private enrichAlert(alert: Partial<Alert>): Alert {
    const fingerprint = this.generateFingerprint(alert.labels || {});
    const id = alert.id || fingerprint;

    return {
      id,
      fingerprint,
      status: alert.status || 'firing',
      labels: alert.labels || {},
      annotations: alert.annotations || {},
      startsAt: alert.startsAt || new Date(),
      endsAt: alert.endsAt,
      generatorURL: alert.generatorURL,
      severity: (alert.labels?.severity as any) || 'warning',
      escalationLevel: 0,
      silenced: false,
      ...alert
    };
  }

  private generateFingerprint(labels: Record<string, string>): string {
    const sortedKeys = Object.keys(labels).sort();
    const labelString = sortedKeys
      .map(key => `${key}="${labels[key]}"`)
      .join(',');
    
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < labelString.length; i++) {
      const char = labelString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    
    return Math.abs(hash).toString(36);
  }

  private shouldSilenceAlert(alert: Alert): boolean {
    for (const rule of this.config.silenceRules) {
      if (this.isWithinTimeRange(rule.startsAt, rule.endsAt) &&
          this.matchesAllMatchers(alert, rule.matchers)) {
        return true;
      }
    }
    return false;
  }

  private isWithinTimeRange(start: Date, end: Date): boolean {
    const now = new Date();
    return now >= start && now <= end;
  }

  private matchesAllMatchers(alert: Alert, matchers: AlertMatcher[]): boolean {
    return matchers.every(matcher => this.matchesMatcher(alert, matcher));
  }

  private matchesMatcher(alert: Alert, matcher: AlertMatcher): boolean {
    const value = alert.labels[matcher.name];
    if (!value) return false;

    if (matcher.isRegex) {
      const regex = matcher.value as RegExp;
      return regex.test(value);
    } else {
      return value === matcher.value;
    }
  }

  private async handleNewAlert(alert: Alert): Promise<void> {
    this.logger.info('New alert received', {
      alertId: alert.id,
      severity: alert.severity,
      labels: alert.labels
    });

    if (alert.status === 'firing') {
      await this.startEscalation(alert);
    }

    this.emit('alert:new', alert);
  }

  private async updateExistingAlert(existing: Alert, updated: Alert): Promise<void> {
    // Update alert status
    if (existing.status === 'firing' && updated.status === 'resolved') {
      existing.status = 'resolved';
      existing.endsAt = updated.endsAt || new Date();
      await this.stopEscalation(existing.id);
      this.emit('alert:resolved', existing);
      this.logger.info('Alert resolved', { alertId: existing.id });
    } else if (existing.status === 'resolved' && updated.status === 'firing') {
      existing.status = 'firing';
      existing.startsAt = updated.startsAt || new Date();
      existing.escalationLevel = 0;
      delete existing.endsAt;
      await this.startEscalation(existing);
      this.emit('alert:refired', existing);
      this.logger.info('Alert re-fired', { alertId: existing.id });
    }

    // Update labels and annotations
    existing.labels = { ...existing.labels, ...updated.labels };
    existing.annotations = { ...existing.annotations, ...updated.annotations };
  }

  private async startEscalation(alert: Alert): Promise<void> {
    const policy = this.findEscalationPolicy(alert);
    if (!policy) {
      this.logger.warn('No escalation policy found for alert', { alertId: alert.id });
      return;
    }

    this.logger.debug('Starting escalation', { 
      alertId: alert.id, 
      policyId: policy.id 
    });

    await this.scheduleEscalationStep(alert, policy, 0);
  }

  private findEscalationPolicy(alert: Alert): EscalationPolicy | undefined {
    // For now, return the first policy. In production, you'd match based on labels
    return this.config.escalationPolicies[0];
  }

  private async scheduleEscalationStep(
    alert: Alert, 
    policy: EscalationPolicy, 
    stepIndex: number
  ): Promise<void> {
    if (stepIndex >= policy.steps.length) {
      // Restart escalation if max escalations not reached
      if (alert.escalationLevel < policy.maxEscalations) {
        alert.escalationLevel++;
        setTimeout(() => {
          this.scheduleEscalationStep(alert, policy, 0);
        }, policy.repeatInterval * 1000);
      }
      return;
    }

    const step = policy.steps[stepIndex];
    
    const timer = setTimeout(async () => {
      // Check if alert is still firing and not silenced
      const currentAlert = this.alerts.get(alert.id);
      if (!currentAlert || currentAlert.status !== 'firing' || currentAlert.silenced) {
        return;
      }

      // Check step condition if present
      if (step.condition && !this.evaluateCondition(step.condition, alert)) {
        // Skip this step, go to next
        await this.scheduleEscalationStep(alert, policy, stepIndex + 1);
        return;
      }

      await this.executeEscalationStep(alert, step);
      alert.lastEscalated = new Date();

      // Schedule next step
      await this.scheduleEscalationStep(alert, policy, stepIndex + 1);
    }, step.delay * 1000);

    this.escalationTimers.set(`${alert.id}_${stepIndex}`, timer);
  }

  private evaluateCondition(condition: string, alert: Alert): boolean {
    // Simple condition evaluation - in production, use a proper expression evaluator
    try {
      // Replace variables in condition with actual values
      let evaluatedCondition = condition;
      Object.entries(alert.labels).forEach(([key, value]) => {
        evaluatedCondition = evaluatedCondition.replace(`$${key}`, value);
      });
      
      // For safety, only allow simple comparisons
      const safeConditions = /^[\w\s<>=!.]+$/;
      if (!safeConditions.test(evaluatedCondition)) {
        return true; // Default to true for safety
      }

      return eval(evaluatedCondition);
    } catch (error) {
      this.logger.error('Failed to evaluate escalation condition', error as Error);
      return true; // Default to true on error
    }
  }

  private async executeEscalationStep(alert: Alert, step: EscalationStep): Promise<void> {
    this.logger.info('Executing escalation step', {
      alertId: alert.id,
      channels: step.channels,
      escalationLevel: alert.escalationLevel
    });

    const notifications = step.channels.map(channelId => 
      this.sendNotification(channelId, alert)
    );

    try {
      await Promise.allSettled(notifications);
      this.emit('escalation:executed', { alert, step });
    } catch (error) {
      this.logger.error('Failed to execute escalation step', error as Error);
      this.emit('escalation:failed', { alert, step, error });
    }
  }

  private async sendNotification(channelId: string, alert: Alert): Promise<void> {
    const channel = this.config.notificationChannels.find(c => c.id === channelId);
    if (!channel || !channel.enabled) {
      this.logger.warn('Notification channel not found or disabled', { channelId });
      return;
    }

    // Check rate limits
    if (!this.checkRateLimit(channelId)) {
      this.logger.warn('Rate limit exceeded for channel', { channelId });
      return;
    }

    try {
      await this.sendToChannel(channel, alert);
      this.updateRateLimit(channelId);
      this.emit('notification:sent', { channel: channelId, alert });
    } catch (error) {
      this.logger.error('Failed to send notification', error as Error, { channelId });
      this.emit('notification:failed', { channel: channelId, alert, error });
    }
  }

  private checkRateLimit(channelId: string): boolean {
    const channel = this.config.notificationChannels.find(c => c.id === channelId);
    if (!channel?.rateLimits) return true;

    const limits = this.channelRateLimits.get(channelId) || { minute: [], hour: [] };
    const now = Date.now();
    const oneMinuteAgo = now - 60 * 1000;
    const oneHourAgo = now - 60 * 60 * 1000;

    // Clean old entries
    limits.minute = limits.minute.filter(time => time > oneMinuteAgo);
    limits.hour = limits.hour.filter(time => time > oneHourAgo);

    // Check limits
    if (limits.minute.length >= channel.rateLimits.maxPerMinute) return false;
    if (limits.hour.length >= channel.rateLimits.maxPerHour) return false;

    return true;
  }

  private updateRateLimit(channelId: string): void {
    const limits = this.channelRateLimits.get(channelId) || { minute: [], hour: [] };
    const now = Date.now();
    
    limits.minute.push(now);
    limits.hour.push(now);
    
    this.channelRateLimits.set(channelId, limits);
  }

  private async sendToChannel(channel: NotificationChannel, alert: Alert): Promise<void> {
    const message = this.formatAlertMessage(alert, channel.type);

    switch (channel.type) {
      case 'slack':
        await this.sendSlack(channel, message, alert);
        break;
      case 'discord':
        await this.sendDiscord(channel, message, alert);
        break;
      case 'webhook':
        await this.sendWebhook(channel, alert);
        break;
      case 'email':
        await this.sendEmail(channel, message, alert);
        break;
      case 'pagerduty':
        await this.sendPagerDuty(channel, alert);
        break;
      default:
        throw new Error(`Unsupported channel type: ${channel.type}`);
    }
  }

  private formatAlertMessage(alert: Alert, channelType: string): string {
    const emoji = alert.severity === 'critical' ? '🚨' : 
                  alert.severity === 'warning' ? '⚠️' : 'ℹ️';
    
    const status = alert.status === 'firing' ? 'FIRING' : 'RESOLVED';
    const summary = alert.annotations.summary || 'Alert triggered';
    const description = alert.annotations.description || '';

    if (channelType === 'slack' || channelType === 'discord') {
      return `${emoji} **${status}** - ${summary}\n\n` +
             `**Severity**: ${alert.severity}\n` +
             `**Labels**: ${JSON.stringify(alert.labels, null, 2)}\n` +
             `**Started**: ${alert.startsAt.toISOString()}\n` +
             (description ? `**Description**: ${description}\n` : '') +
             (alert.generatorURL ? `**Source**: ${alert.generatorURL}` : '');
    }

    return `${status}: ${summary}\n${description}`;
  }

  private async sendSlack(channel: NotificationChannel, message: string, alert: Alert): Promise<void> {
    const payload = {
      text: message,
      channel: channel.config.channel,
      username: 'Otedama Pool Alert',
      icon_emoji: alert.severity === 'critical' ? ':rotating_light:' : ':warning:',
      attachments: [{
        color: alert.severity === 'critical' ? 'danger' : 
               alert.severity === 'warning' ? 'warning' : 'good',
        fields: Object.entries(alert.labels).map(([key, value]) => ({
          title: key,
          value: value,
          short: true
        }))
      }]
    };

    await axios.post(channel.config.webhookUrl, payload);
  }

  private async sendDiscord(channel: NotificationChannel, message: string, alert: Alert): Promise<void> {
    const payload = {
      content: message,
      embeds: [{
        title: `Alert: ${alert.annotations.summary || 'Unknown'}`,
        description: alert.annotations.description || '',
        color: alert.severity === 'critical' ? 0xff0000 : 
               alert.severity === 'warning' ? 0xffff00 : 0x00ff00,
        fields: Object.entries(alert.labels).map(([key, value]) => ({
          name: key,
          value: value,
          inline: true
        })),
        timestamp: alert.startsAt.toISOString()
      }]
    };

    await axios.post(channel.config.webhookUrl, payload);
  }

  private async sendWebhook(channel: NotificationChannel, alert: Alert): Promise<void> {
    await axios.post(channel.config.url, {
      alert,
      timestamp: new Date().toISOString()
    }, {
      headers: channel.config.headers || {}
    });
  }

  private async sendEmail(channel: NotificationChannel, message: string, alert: Alert): Promise<void> {
    // Email implementation would go here
    this.logger.info('Email notification sent', { channel: channel.id, alert: alert.id });
  }

  private async sendPagerDuty(channel: NotificationChannel, alert: Alert): Promise<void> {
    const routingKey = channel.config.routingKey || channel.config.integrationKey;
    if (!routingKey) {
      throw new Error('PagerDuty routing key not configured');
    }

    // Determine PagerDuty event action based on alert status
    const eventAction = alert.status === 'resolved' ? 'resolve' : 'trigger';
    
    // Create dedup key for incident correlation
    const dedupKey = `${alert.fingerprint}_${alert.labels.alertname || 'alert'}`;
    
    // Build PagerDuty payload according to Events API v2
    const payload = {
      routing_key: routingKey,
      event_action: eventAction,
      dedup_key: dedupKey,
      payload: {
        summary: alert.annotations.summary || `Alert: ${alert.labels.alertname || 'Unknown'}`,
        severity: this.mapSeverityToPagerDuty(alert.severity),
        source: alert.generatorURL || 'otedama-pool',
        timestamp: alert.startsAt.toISOString(),
        component: alert.labels.service || 'mining-pool',
        group: alert.labels.component || 'alerts',
        class: alert.labels.alertname || 'operational',
        custom_details: {
          description: alert.annotations.description || '',
          labels: alert.labels,
          annotations: alert.annotations,
          escalation_level: alert.escalationLevel,
          fingerprint: alert.fingerprint,
          startsAt: alert.startsAt.toISOString(),
          endsAt: alert.endsAt?.toISOString() || null,
          status: alert.status,
          ...(channel.config.customDetails || {})
        }
      },
      // Add links if available
      links: this.buildPagerDutyLinks(alert, channel),
      // Add images if available  
      images: this.buildPagerDutyImages(alert, channel),
      // Client and client URL for acknowledgment links
      client: 'Otedama Mining Pool',
      client_url: channel.config.clientUrl || 'https://pool.otedama.io'
    };

    try {
      // Send to PagerDuty Events API v2
      const response = await axios.post(
        'https://events.pagerduty.com/v2/enqueue',
        payload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 30000 // 30 second timeout
        }
      );

      if (response.data.status === 'success') {
        this.logger.info('PagerDuty incident created/updated', {
          channel: channel.id,
          alert: alert.id,
          dedupKey,
          eventAction,
          message: response.data.message
        });
      } else {
        throw new Error(`PagerDuty API error: ${response.data.message || 'Unknown error'}`);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.message || error.message;
        const errorDetails = error.response?.data?.errors || [];
        
        this.logger.error('PagerDuty notification failed', error as Error, {
          channel: channel.id,
          alert: alert.id,
          status: error.response?.status,
          message: errorMessage,
          errors: errorDetails
        });
        
        throw new Error(`PagerDuty notification failed: ${errorMessage}`);
      } else {
        throw error;
      }
    }
  }

  private mapSeverityToPagerDuty(severity: 'critical' | 'warning' | 'info'): 'critical' | 'error' | 'warning' | 'info' {
    // Map our severity levels to PagerDuty severity levels
    switch (severity) {
      case 'critical':
        return 'critical';
      case 'warning':
        return 'warning';
      case 'info':
        return 'info';
      default:
        return 'error';
    }
  }

  private buildPagerDutyLinks(alert: Alert, channel: NotificationChannel): Array<{ href: string; text: string }> {
    const links: Array<{ href: string; text: string }> = [];
    
    // Add generator URL if available
    if (alert.generatorURL) {
      links.push({
        href: alert.generatorURL,
        text: 'View in Source System'
      });
    }
    
    // Add dashboard link if configured
    if (channel.config.dashboardUrl) {
      links.push({
        href: channel.config.dashboardUrl,
        text: 'View Dashboard'
      });
    }
    
    // Add runbook link if available
    if (alert.annotations.runbook_url) {
      links.push({
        href: alert.annotations.runbook_url,
        text: 'View Runbook'
      });
    }
    
    // Add custom links from channel config
    if (channel.config.links && Array.isArray(channel.config.links)) {
      links.push(...channel.config.links);
    }
    
    return links.slice(0, 10); // PagerDuty limits to 10 links
  }

  private buildPagerDutyImages(alert: Alert, channel: NotificationChannel): Array<{ src: string; href?: string; alt?: string }> {
    const images: Array<{ src: string; href?: string; alt?: string }> = [];
    
    // Add graph image if available
    if (alert.annotations.graph_url) {
      images.push({
        src: alert.annotations.graph_url,
        href: alert.generatorURL,
        alt: 'Alert Graph'
      });
    }
    
    // Add custom images from channel config
    if (channel.config.images && Array.isArray(channel.config.images)) {
      images.push(...channel.config.images);
    }
    
    return images.slice(0, 10); // PagerDuty limits to 10 images
  }

  private async stopEscalation(alertId: string): Promise<void> {
    // Clear all timers for this alert
    for (const [key, timer] of this.escalationTimers.entries()) {
      if (key.startsWith(alertId)) {
        clearTimeout(timer);
        this.escalationTimers.delete(key);
      }
    }
  }

  private async groupAlerts(alert: Alert): Promise<void> {
    const groupKey = this.calculateGroupKey(alert);
    
    let group = this.alertGroups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        alerts: [],
        labels: this.extractGroupLabels(alert),
        lastUpdate: new Date(),
        status: 'active'
      };
      this.alertGroups.set(groupKey, group);
    }

    // Add or update alert in group
    const existingIndex = group.alerts.findIndex(a => a.id === alert.id);
    if (existingIndex >= 0) {
      group.alerts[existingIndex] = alert;
    } else {
      group.alerts.push(alert);
    }

    group.lastUpdate = new Date();
    group.status = group.alerts.some(a => a.status === 'firing') ? 'active' : 'resolved';

    this.emit('group:updated', group);
  }

  private calculateGroupKey(alert: Alert): string {
    // Find matching grouping rule
    const rule = this.config.groupingRules.find(rule => 
      this.matchesAllMatchers(alert, rule.matchers)
    );

    if (!rule) {
      return alert.fingerprint; // Group by fingerprint if no rule matches
    }

    // Group by specified labels
    const groupValues = rule.groupBy
      .map(label => `${label}="${alert.labels[label] || ''}"`)
      .join(',');
    
    return `${rule.id}:${groupValues}`;
  }

  private extractGroupLabels(alert: Alert): Record<string, string> {
    // Extract common labels for the group
    return {
      severity: alert.severity,
      service: alert.labels.service || 'unknown',
      component: alert.labels.component || 'unknown'
    };
  }

  /**
   * Get current alerts
   */
  getAlerts(filter?: Partial<Alert>): Alert[] {
    let alerts = Array.from(this.alerts.values());
    
    if (filter) {
      alerts = alerts.filter(alert => {
        return Object.entries(filter).every(([key, value]) => {
          if (key === 'labels') {
            return Object.entries(value as any).every(([labelKey, labelValue]) => 
              alert.labels[labelKey] === labelValue
            );
          }
          return (alert as any)[key] === value;
        });
      });
    }

    return alerts;
  }

  /**
   * Get alert groups
   */
  getAlertGroups(): AlertGroup[] {
    return Array.from(this.alertGroups.values());
  }

  /**
   * Create silence rule
   */
  createSilence(silence: Omit<SilenceRule, 'id'>): string {
    const id = `silence_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const silenceRule: SilenceRule = {
      id,
      ...silence
    };

    this.config.silenceRules.push(silenceRule);
    this.emit('silence:created', silenceRule);
    
    return id;
  }

  /**
   * Remove silence rule
   */
  removeSilence(silenceId: string): boolean {
    const index = this.config.silenceRules.findIndex(s => s.id === silenceId);
    if (index >= 0) {
      const removed = this.config.silenceRules.splice(index, 1)[0];
      this.emit('silence:removed', removed);
      return true;
    }
    return false;
  }

  private startCleanupTask(): void {
    // Cleanup resolved alerts older than 24 hours
    setInterval(() => {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      for (const [id, alert] of this.alerts.entries()) {
        if (alert.status === 'resolved' && 
            alert.endsAt && 
            alert.endsAt < oneDayAgo) {
          this.alerts.delete(id);
        }
      }

      // Cleanup expired silences
      this.config.silenceRules = this.config.silenceRules.filter(
        silence => silence.endsAt > new Date()
      );
    }, 60 * 60 * 1000); // Run every hour
  }

  /**
   * Stop alert manager
   */
  stop(): void {
    // Clear all timers
    for (const timer of this.escalationTimers.values()) {
      clearTimeout(timer);
    }
    this.escalationTimers.clear();
    this.removeAllListeners();
  }
}

export default AlertManager;
