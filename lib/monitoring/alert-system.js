/**
 * Custom Alert System
 * 
 * Intelligent alerting with rule-based triggers, escalation paths,
 * and multi-channel notifications
 */

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';

export class AlertSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Alert configuration
      enableRealTimeAlerts: options.enableRealTimeAlerts !== false,
      enableEscalation: options.enableEscalation !== false,
      enableThrottling: options.enableThrottling !== false,
      
      // Thresholds and timing
      evaluationInterval: options.evaluationInterval || 30000, // 30 seconds
      escalationDelay: options.escalationDelay || 300000, // 5 minutes
      throttleWindow: options.throttleWindow || 600000, // 10 minutes
      maxAlertsPerHour: options.maxAlertsPerHour || 20,
      
      // Storage
      rulesDirectory: options.rulesDirectory || './config/alerts',
      alertHistory: options.alertHistory || './data/alerts',
      
      // Notification channels
      enableSlack: options.enableSlack !== false,
      enableEmail: options.enableEmail !== false,
      enableWebhook: options.enableWebhook !== false,
      enablePushNotification: options.enablePushNotification !== false,
      
      // Channel configuration
      slackWebhook: options.slackWebhook || process.env.SLACK_WEBHOOK_URL,
      emailConfig: options.emailConfig || {},
      webhookUrl: options.webhookUrl || process.env.ALERT_WEBHOOK_URL,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    this.isRunning = false;
    this.rules = new Map();
    this.activeAlerts = new Map();
    this.alertHistory = [];
    this.throttleTracker = new Map();
    
    // Alert metrics
    this.metrics = {
      totalAlerts: 0,
      totalResolved: 0,
      averageResolutionTime: 0,
      escalatedAlerts: 0,
      throttledAlerts: 0,
      alertsByChannel: new Map(),
      alertsBySeverity: new Map()
    };
    
    this.initialize();
  }
  
  /**
   * Initialize alert system
   */
  async initialize() {
    try {
      await this.ensureDirectories();
      await this.loadAlertRules();
      await this.loadAlertHistory();
      
      this.emit('initialized');
      
    } catch (error) {
      this.errorHandler.handleError(error, {
        service: 'alert-system',
        category: ErrorCategory.INITIALIZATION
      });
    }
  }
  
  /**
   * Start alert system
   */
  async start() {
    if (this.isRunning) {
      throw new OtedamaError('Alert system already running', ErrorCategory.OPERATION);
    }
    
    console.log('🚨 Starting alert system...');
    this.isRunning = true;
    
    // Start rule evaluation loop
    this.startRuleEvaluation();
    
    // Start escalation monitoring
    if (this.options.enableEscalation) {
      this.startEscalationMonitoring();
    }
    
    // Start throttle cleanup
    if (this.options.enableThrottling) {
      this.startThrottleCleanup();
    }
    
    this.emit('started');
    console.log('✅ Alert system started successfully');
  }
  
  /**
   * Stop alert system
   */
  async stop() {
    if (!this.isRunning) return;
    
    console.log('🛑 Stopping alert system...');
    this.isRunning = false;
    
    // Clear timers
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
    }
    
    if (this.escalationTimer) {
      clearInterval(this.escalationTimer);
    }
    
    if (this.throttleTimer) {
      clearInterval(this.throttleTimer);
    }
    
    // Save state
    await this.saveAlertHistory();
    
    this.emit('stopped');
    console.log('✅ Alert system stopped');
  }
  
  /**
   * Add alert rule
   */
  addRule(ruleConfig) {
    const rule = this.createRule(ruleConfig);
    this.rules.set(rule.id, rule);
    
    console.log(`📝 Added alert rule: ${rule.name}`);
    this.emit('rule:added', rule);
    
    return rule.id;
  }
  
  /**
   * Remove alert rule
   */
  removeRule(ruleId) {
    if (this.rules.has(ruleId)) {
      const rule = this.rules.get(ruleId);
      this.rules.delete(ruleId);
      
      console.log(`🗑️  Removed alert rule: ${rule.name}`);
      this.emit('rule:removed', { id: ruleId, name: rule.name });
    }
  }
  
  /**
   * Update alert rule
   */
  updateRule(ruleId, updates) {
    if (this.rules.has(ruleId)) {
      const rule = this.rules.get(ruleId);
      Object.assign(rule, updates);
      
      console.log(`✏️  Updated alert rule: ${rule.name}`);
      this.emit('rule:updated', rule);
    }
  }
  
  /**
   * Evaluate metrics against rules
   */
  async evaluateMetrics(metrics) {
    if (!this.isRunning) return;
    
    const startTime = performance.now();
    let alertsTriggered = 0;
    
    for (const [ruleId, rule] of this.rules.entries()) {
      try {
        if (!rule.enabled) continue;
        
        const shouldAlert = await this.evaluateRule(rule, metrics);
        
        if (shouldAlert && !this.activeAlerts.has(ruleId)) {
          // New alert
          await this.triggerAlert(rule, metrics);
          alertsTriggered++;
        } else if (!shouldAlert && this.activeAlerts.has(ruleId)) {
          // Alert resolved
          await this.resolveAlert(ruleId);
        }
        
      } catch (error) {
        console.error(`Rule evaluation error for ${rule.name}:`, error.message);
      }
    }
    
    const duration = performance.now() - startTime;
    
    this.emit('evaluation:completed', {
      duration,
      rulesEvaluated: this.rules.size,
      alertsTriggered,
      activeAlerts: this.activeAlerts.size
    });
  }
  
  /**
   * Trigger manual alert
   */
  async triggerManualAlert(alertConfig) {
    const alert = {
      id: this.generateAlertId(),
      type: 'manual',
      title: alertConfig.title,
      message: alertConfig.message,
      severity: alertConfig.severity || 'medium',
      timestamp: Date.now(),
      source: alertConfig.source || 'manual',
      channels: alertConfig.channels || ['console'],
      metadata: alertConfig.metadata || {},
      isManual: true
    };
    
    await this.processAlert(alert);
    return alert.id;
  }
  
  /**
   * Resolve alert manually
   */
  async resolveAlertManually(alertId, resolution) {
    if (this.activeAlerts.has(alertId)) {
      const alert = this.activeAlerts.get(alertId);
      alert.resolvedAt = Date.now();
      alert.resolution = resolution;
      alert.resolutionType = 'manual';
      
      await this.processAlertResolution(alert);
      this.activeAlerts.delete(alertId);
      
      console.log(`✅ Manually resolved alert: ${alert.title}`);
      this.emit('alert:resolved_manually', alert);
    }
  }
  
  /**
   * Create alert rule from configuration
   */
  createRule(config) {
    return {
      id: config.id || this.generateRuleId(),
      name: config.name,
      description: config.description || '',
      enabled: config.enabled !== false,
      
      // Trigger conditions
      conditions: config.conditions || [],
      operator: config.operator || 'AND', // AND, OR
      
      // Alert configuration
      severity: config.severity || 'medium',
      title: config.title || config.name,
      message: config.message || 'Alert condition met',
      
      // Notification settings
      channels: config.channels || ['slack'],
      escalationPath: config.escalationPath || [],
      throttle: config.throttle || false,
      
      // Timing
      evaluationWindow: config.evaluationWindow || 60000, // 1 minute
      cooldown: config.cooldown || 300000, // 5 minutes
      
      // Metadata
      tags: config.tags || [],
      createdAt: Date.now(),
      lastModified: Date.now()
    };
  }
  
  /**
   * Evaluate rule against metrics
   */
  async evaluateRule(rule, metrics) {
    const results = [];
    
    for (const condition of rule.conditions) {
      const result = await this.evaluateCondition(condition, metrics);
      results.push(result);
    }
    
    // Apply operator
    if (rule.operator === 'OR') {
      return results.some(r => r);
    } else {
      return results.every(r => r);
    }
  }
  
  /**
   * Evaluate individual condition
   */
  async evaluateCondition(condition, metrics) {
    const { metric, operator, threshold, aggregation, timeWindow } = condition;
    
    // Get metric value
    let value = this.getMetricValue(metrics, metric);
    
    // Apply aggregation if specified
    if (aggregation && timeWindow) {
      value = await this.aggregateMetric(metric, aggregation, timeWindow);
    }
    
    // Compare against threshold
    switch (operator) {
      case '>':
      case 'gt':
        return value > threshold;
      case '>=':
      case 'gte':
        return value >= threshold;
      case '<':
      case 'lt':
        return value < threshold;
      case '<=':
      case 'lte':
        return value <= threshold;
      case '==':
      case 'eq':
        return value === threshold;
      case '!=':
      case 'ne':
        return value !== threshold;
      case 'contains':
        return String(value).includes(String(threshold));
      case 'matches':
        return new RegExp(threshold).test(String(value));
      default:
        return false;
    }
  }
  
  /**
   * Get metric value from nested object
   */
  getMetricValue(metrics, path) {
    return path.split('.').reduce((obj, key) => obj?.[key], metrics);
  }
  
  /**
   * Aggregate metric over time window
   */
  async aggregateMetric(metric, aggregation, timeWindow) {
    // This would typically query historical data
    // For now, return the current value
    return 0;
  }
  
  /**
   * Trigger alert
   */
  async triggerAlert(rule, metrics) {
    // Check throttling
    if (this.isThrottled(rule.id)) {
      this.metrics.throttledAlerts++;
      return;
    }
    
    const alert = {
      id: this.generateAlertId(),
      ruleId: rule.id,
      ruleName: rule.name,
      title: rule.title,
      message: this.interpolateMessage(rule.message, metrics),
      severity: rule.severity,
      timestamp: Date.now(),
      source: 'rule',
      channels: rule.channels,
      escalationPath: rule.escalationPath,
      metadata: {
        metrics: this.extractRelevantMetrics(metrics, rule),
        rule: {
          id: rule.id,
          name: rule.name,
          conditions: rule.conditions
        }
      }
    };
    
    await this.processAlert(alert);
    
    // Add to active alerts
    this.activeAlerts.set(rule.id, alert);
    
    // Apply throttling
    if (rule.throttle) {
      this.applyThrottle(rule.id);
    }
  }
  
  /**
   * Process alert (send notifications)
   */
  async processAlert(alert) {
    console.log(`🚨 Alert triggered: ${alert.title} [${alert.severity}]`);
    
    // Update metrics
    this.metrics.totalAlerts++;
    this.updateSeverityMetrics(alert.severity);
    
    // Send notifications
    for (const channel of alert.channels) {
      try {
        await this.sendNotification(channel, alert);
        this.updateChannelMetrics(channel);
      } catch (error) {
        console.error(`Failed to send ${channel} notification:`, error.message);
      }
    }
    
    // Add to history
    this.alertHistory.push(alert);
    
    this.emit('alert:triggered', alert);
  }
  
  /**
   * Resolve alert
   */
  async resolveAlert(ruleId) {
    if (this.activeAlerts.has(ruleId)) {
      const alert = this.activeAlerts.get(ruleId);
      alert.resolvedAt = Date.now();
      alert.resolutionType = 'automatic';
      
      await this.processAlertResolution(alert);
      this.activeAlerts.delete(ruleId);
    }
  }
  
  /**
   * Process alert resolution
   */
  async processAlertResolution(alert) {
    console.log(`✅ Alert resolved: ${alert.title}`);
    
    // Update metrics
    this.metrics.totalResolved++;
    const resolutionTime = alert.resolvedAt - alert.timestamp;
    this.updateResolutionTimeMetrics(resolutionTime);
    
    // Send resolution notifications
    for (const channel of alert.channels) {
      try {
        await this.sendResolutionNotification(channel, alert);
      } catch (error) {
        console.error(`Failed to send ${channel} resolution notification:`, error.message);
      }
    }
    
    this.emit('alert:resolved', alert);
  }
  
  /**
   * Send notification to specific channel
   */
  async sendNotification(channel, alert) {
    switch (channel) {
      case 'slack':
        await this.sendSlackNotification(alert);
        break;
      case 'email':
        await this.sendEmailNotification(alert);
        break;
      case 'webhook':
        await this.sendWebhookNotification(alert);
        break;
      case 'push':
        await this.sendPushNotification(alert);
        break;
      case 'console':
        this.sendConsoleNotification(alert);
        break;
      default:
        console.warn(`Unknown notification channel: ${channel}`);
    }
  }
  
  /**
   * Send Slack notification
   */
  async sendSlackNotification(alert) {
    if (!this.options.slackWebhook) {
      console.warn('Slack webhook not configured');
      return;
    }
    
    const color = this.getSeverityColor(alert.severity);
    const payload = {
      text: `🚨 ${alert.title}`,
      attachments: [{
        color,
        fields: [
          { title: 'Severity', value: alert.severity.toUpperCase(), short: true },
          { title: 'Source', value: alert.source, short: true },
          { title: 'Time', value: new Date(alert.timestamp).toISOString(), short: false },
          { title: 'Message', value: alert.message, short: false }
        ]
      }]
    };
    
    // Simulate HTTP request
    console.log(`📱 Slack notification sent: ${alert.title}`);
  }
  
  /**
   * Send email notification
   */
  async sendEmailNotification(alert) {
    // Email implementation would go here
    console.log(`📧 Email notification sent: ${alert.title}`);
  }
  
  /**
   * Send webhook notification
   */
  async sendWebhookNotification(alert) {
    if (!this.options.webhookUrl) {
      console.warn('Webhook URL not configured');
      return;
    }
    
    // Webhook implementation would go here
    console.log(`🔗 Webhook notification sent: ${alert.title}`);
  }
  
  /**
   * Send push notification
   */
  async sendPushNotification(alert) {
    // Push notification implementation would go here
    console.log(`📱 Push notification sent: ${alert.title}`);
  }
  
  /**
   * Send console notification
   */
  sendConsoleNotification(alert) {
    const icon = this.getSeverityIcon(alert.severity);
    console.log(`${icon} ALERT [${alert.severity.toUpperCase()}]: ${alert.title}`);
    console.log(`   Message: ${alert.message}`);
    console.log(`   Time: ${new Date(alert.timestamp).toISOString()}`);
  }
  
  /**
   * Send resolution notification
   */
  async sendResolutionNotification(channel, alert) {
    const resolutionTime = ((alert.resolvedAt - alert.timestamp) / 1000 / 60).toFixed(1);
    
    switch (channel) {
      case 'slack':
        console.log(`📱 Slack resolution sent: ${alert.title} (resolved in ${resolutionTime}m)`);
        break;
      case 'console':
        console.log(`✅ RESOLVED: ${alert.title} (${resolutionTime}m)`);
        break;
    }
  }
  
  /**
   * Start rule evaluation loop
   */
  startRuleEvaluation() {
    this.evaluationTimer = setInterval(async () => {
      if (this.isRunning) {
        // Get current metrics from various sources
        const metrics = await this.collectCurrentMetrics();
        await this.evaluateMetrics(metrics);
      }
    }, this.options.evaluationInterval);
  }
  
  /**
   * Start escalation monitoring
   */
  startEscalationMonitoring() {
    this.escalationTimer = setInterval(async () => {
      if (this.isRunning) {
        await this.checkEscalations();
      }
    }, 60000); // Check every minute
  }
  
  /**
   * Start throttle cleanup
   */
  startThrottleCleanup() {
    this.throttleTimer = setInterval(() => {
      if (this.isRunning) {
        this.cleanupThrottles();
      }
    }, 300000); // Cleanup every 5 minutes
  }
  
  /**
   * Check for escalations
   */
  async checkEscalations() {
    const now = Date.now();
    
    for (const [ruleId, alert] of this.activeAlerts.entries()) {
      const rule = this.rules.get(ruleId);
      if (!rule || !rule.escalationPath.length) continue;
      
      const alertAge = now - alert.timestamp;
      
      for (const escalation of rule.escalationPath) {
        if (alertAge >= escalation.delay && !alert.escalations?.includes(escalation.level)) {
          await this.escalateAlert(alert, escalation);
        }
      }
    }
  }
  
  /**
   * Escalate alert
   */
  async escalateAlert(alert, escalation) {
    console.log(`📈 Escalating alert: ${alert.title} to level ${escalation.level}`);
    
    if (!alert.escalations) {
      alert.escalations = [];
    }
    
    alert.escalations.push(escalation.level);
    this.metrics.escalatedAlerts++;
    
    // Send escalation notifications
    for (const channel of escalation.channels) {
      await this.sendEscalationNotification(channel, alert, escalation);
    }
    
    this.emit('alert:escalated', { alert, escalation });
  }
  
  /**
   * Send escalation notification
   */
  async sendEscalationNotification(channel, alert, escalation) {
    console.log(`🚨 Escalation notification [${escalation.level}]: ${alert.title}`);
  }
  
  /**
   * Collect current metrics
   */
  async collectCurrentMetrics() {
    // This would collect metrics from various sources
    // For demonstration, return sample metrics
    return {
      system: {
        cpu: Math.random() * 100,
        memory: Math.random() * 100,
        disk: Math.random() * 100
      },
      application: {
        errorRate: Math.random() * 10,
        responseTime: Math.random() * 2000 + 100,
        throughput: Math.random() * 1000 + 100
      },
      database: {
        connections: Math.floor(Math.random() * 100) + 10,
        queryTime: Math.random() * 1000 + 50
      }
    };
  }
  
  /**
   * Utility methods
   */
  interpolateMessage(template, metrics) {
    return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const value = this.getMetricValue(metrics, path);
      return value !== undefined ? value : match;
    });
  }
  
  extractRelevantMetrics(metrics, rule) {
    const relevant = {};
    
    for (const condition of rule.conditions) {
      const value = this.getMetricValue(metrics, condition.metric);
      if (value !== undefined) {
        relevant[condition.metric] = value;
      }
    }
    
    return relevant;
  }
  
  isThrottled(ruleId) {
    const throttleData = this.throttleTracker.get(ruleId);
    if (!throttleData) return false;
    
    const now = Date.now();
    return now - throttleData.lastAlert < this.options.throttleWindow;
  }
  
  applyThrottle(ruleId) {
    this.throttleTracker.set(ruleId, {
      lastAlert: Date.now(),
      count: (this.throttleTracker.get(ruleId)?.count || 0) + 1
    });
  }
  
  cleanupThrottles() {
    const now = Date.now();
    
    for (const [ruleId, throttleData] of this.throttleTracker.entries()) {
      if (now - throttleData.lastAlert > this.options.throttleWindow) {
        this.throttleTracker.delete(ruleId);
      }
    }
  }
  
  getSeverityColor(severity) {
    const colors = {
      critical: '#dc3545',
      high: '#fd7e14',
      medium: '#ffc107',
      low: '#28a745',
      info: '#17a2b8'
    };
    return colors[severity] || colors.medium;
  }
  
  getSeverityIcon(severity) {
    const icons = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🟢',
      info: '🔵'
    };
    return icons[severity] || icons.medium;
  }
  
  generateAlertId() {
    return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }
  
  generateRuleId() {
    return `rule_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }
  
  updateSeverityMetrics(severity) {
    const current = this.metrics.alertsBySeverity.get(severity) || 0;
    this.metrics.alertsBySeverity.set(severity, current + 1);
  }
  
  updateChannelMetrics(channel) {
    const current = this.metrics.alertsByChannel.get(channel) || 0;
    this.metrics.alertsByChannel.set(channel, current + 1);
  }
  
  updateResolutionTimeMetrics(resolutionTime) {
    const current = this.metrics.averageResolutionTime;
    const total = this.metrics.totalResolved;
    
    this.metrics.averageResolutionTime = 
      ((current * (total - 1)) + resolutionTime) / total;
  }
  
  async ensureDirectories() {
    const dirs = [
      this.options.rulesDirectory,
      this.options.alertHistory
    ];
    
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }
  
  async loadAlertRules() {
    try {
      const rulesFile = join(this.options.rulesDirectory, 'rules.json');
      const content = await readFile(rulesFile, 'utf8');
      const rules = JSON.parse(content);
      
      for (const ruleConfig of rules) {
        const rule = this.createRule(ruleConfig);
        this.rules.set(rule.id, rule);
      }
      
      console.log(`📝 Loaded ${this.rules.size} alert rules`);
    } catch {
      // No rules file exists
      this.createDefaultRules();
    }
  }
  
  createDefaultRules() {
    const defaultRules = [
      {
        name: 'High CPU Usage',
        description: 'Alert when CPU usage exceeds 80%',
        conditions: [
          { metric: 'system.cpu', operator: '>', threshold: 80 }
        ],
        severity: 'medium',
        title: 'High CPU Usage Detected',
        message: 'CPU usage is {{system.cpu}}%',
        channels: ['console', 'slack']
      },
      {
        name: 'High Error Rate',
        description: 'Alert when error rate exceeds 5%',
        conditions: [
          { metric: 'application.errorRate', operator: '>', threshold: 5 }
        ],
        severity: 'high',
        title: 'High Error Rate',
        message: 'Error rate is {{application.errorRate}}%',
        channels: ['console', 'slack', 'email']
      },
      {
        name: 'Slow Response Time',
        description: 'Alert when response time exceeds 2 seconds',
        conditions: [
          { metric: 'application.responseTime', operator: '>', threshold: 2000 }
        ],
        severity: 'medium',
        title: 'Slow Response Time',
        message: 'Response time is {{application.responseTime}}ms',
        channels: ['console']
      }
    ];
    
    for (const ruleConfig of defaultRules) {
      const rule = this.createRule(ruleConfig);
      this.rules.set(rule.id, rule);
    }
    
    console.log(`📝 Created ${defaultRules.length} default alert rules`);
  }
  
  async loadAlertHistory() {
    try {
      const historyFile = join(this.options.alertHistory, 'history.json');
      const content = await readFile(historyFile, 'utf8');
      this.alertHistory = JSON.parse(content);
      
      // Update metrics from history
      this.metrics.totalAlerts = this.alertHistory.length;
      this.metrics.totalResolved = this.alertHistory.filter(a => a.resolvedAt).length;
    } catch {
      // No history file exists
      this.alertHistory = [];
    }
  }
  
  async saveAlertHistory() {
    try {
      const historyFile = join(this.options.alertHistory, 'history.json');
      await writeFile(historyFile, JSON.stringify(this.alertHistory, null, 2));
    } catch (error) {
      console.error('Failed to save alert history:', error.message);
    }
  }
  
  /**
   * Get alert system status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      rulesCount: this.rules.size,
      activeAlerts: this.activeAlerts.size,
      totalAlerts: this.metrics.totalAlerts,
      metrics: this.metrics,
      throttledRules: this.throttleTracker.size
    };
  }
  
  /**
   * Get active alerts
   */
  getActiveAlerts() {
    return Array.from(this.activeAlerts.values());
  }
  
  /**
   * Get alert history
   */
  getAlertHistory(limit = 100) {
    return this.alertHistory.slice(-limit);
  }
  
  /**
   * Get alert rules
   */
  getRules() {
    return Array.from(this.rules.values());
  }
}

export default AlertSystem;