/**
 * Advanced Alert System for Otedama
 * National-grade monitoring and alerting with intelligent notifications
 * 
 * Design:
 * - Carmack: Fast alert evaluation with minimal overhead
 * - Martin: Clean alert rule architecture
 * - Pike: Simple but powerful alerting
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import crypto from 'crypto';
import { WebClient } from '@slack/web-api';
import nodemailer from 'nodemailer';
import { Telegraf } from 'telegraf';

const logger = createStructuredLogger('AdvancedAlertSystem');

// Alert severity levels
export const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

// Alert categories
export const AlertCategory = {
  PERFORMANCE: 'performance',
  SECURITY: 'security',
  SYSTEM: 'system',
  MINING: 'mining',
  PAYMENT: 'payment',
  NETWORK: 'network',
  DATABASE: 'database',
  HARDWARE: 'hardware'
};

// Alert notification channels
export const NotificationChannel = {
  CONSOLE: 'console',
  EMAIL: 'email',
  SLACK: 'slack',
  TELEGRAM: 'telegram',
  WEBHOOK: 'webhook',
  SMS: 'sms',
  PUSHOVER: 'pushover'
};

export class AdvancedAlertSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Core configuration
    this.config = {
      // Alert thresholds
      thresholds: {
        cpuUsage: 85,
        memoryUsage: 85,
        diskUsage: 90,
        networkLatency: 100, // ms
        hashrateDropPercent: 20,
        shareRejectionRate: 5,
        blockOrphanRate: 10,
        minerOfflineMinutes: 30,
        dbQueryTime: 1000, // ms
        apiResponseTime: 500, // ms
        ...options.thresholds
      },
      
      // Notification channels configuration
      channels: {
        console: { enabled: true },
        email: {
          enabled: false,
          smtp: {
            host: options.email?.smtp?.host,
            port: options.email?.smtp?.port || 587,
            secure: options.email?.smtp?.secure || false,
            auth: options.email?.smtp?.auth
          },
          recipients: options.email?.recipients || []
        },
        slack: {
          enabled: false,
          token: options.slack?.token,
          channel: options.slack?.channel || '#alerts'
        },
        telegram: {
          enabled: false,
          token: options.telegram?.token,
          chatId: options.telegram?.chatId
        },
        webhook: {
          enabled: false,
          urls: options.webhook?.urls || []
        },
        ...options.channels
      },
      
      // Alert management
      cooldownPeriod: options.cooldownPeriod || 300000, // 5 minutes
      aggregationWindow: options.aggregationWindow || 60000, // 1 minute
      maxAlertHistory: options.maxAlertHistory || 10000,
      enableSmartGrouping: options.enableSmartGrouping !== false,
      enablePredictiveAlerts: options.enablePredictiveAlerts || false,
      
      ...options
    };
    
    // Alert storage
    this.activeAlerts = new Map();
    this.alertHistory = [];
    this.cooldowns = new Map();
    this.rules = new Map();
    this.alertGroups = new Map();
    
    // Notification clients
    this.notificationClients = {};
    
    // Statistics
    this.stats = {
      totalAlerts: 0,
      alertsBySeverity: {},
      alertsByCategory: {},
      suppressedAlerts: 0,
      notificationsSent: 0,
      notificationsFailed: 0
    };
    
    // Initialize severity and category stats
    Object.values(AlertSeverity).forEach(severity => {
      this.stats.alertsBySeverity[severity] = 0;
    });
    Object.values(AlertCategory).forEach(category => {
      this.stats.alertsByCategory[category] = 0;
    });
  }
  
  /**
   * Initialize alert system
   */
  async initialize() {
    logger.info('Initializing advanced alert system');
    
    // Initialize notification clients
    await this.initializeNotificationClients();
    
    // Initialize default rules
    this.initializeDefaultRules();
    
    // Start alert aggregation
    this.startAlertAggregation();
    
    logger.info('Alert system initialized', {
      rulesCount: this.rules.size,
      enabledChannels: Object.entries(this.config.channels)
        .filter(([_, config]) => config.enabled)
        .map(([channel]) => channel)
    });
    
    this.emit('initialized');
  }
  
  /**
   * Initialize notification clients
   */
  async initializeNotificationClients() {
    // Email client
    if (this.config.channels.email.enabled) {
      this.notificationClients.email = nodemailer.createTransport({
        host: this.config.channels.email.smtp.host,
        port: this.config.channels.email.smtp.port,
        secure: this.config.channels.email.smtp.secure,
        auth: this.config.channels.email.smtp.auth
      });
      
      // Verify email configuration
      try {
        await this.notificationClients.email.verify();
        logger.info('Email notification client initialized');
      } catch (error) {
        logger.error('Email client initialization failed:', error);
        this.config.channels.email.enabled = false;
      }
    }
    
    // Slack client
    if (this.config.channels.slack.enabled && this.config.channels.slack.token) {
      this.notificationClients.slack = new WebClient(this.config.channels.slack.token);
      logger.info('Slack notification client initialized');
    }
    
    // Telegram client
    if (this.config.channels.telegram.enabled && this.config.channels.telegram.token) {
      this.notificationClients.telegram = new Telegraf(this.config.channels.telegram.token);
      logger.info('Telegram notification client initialized');
    }
  }
  
  /**
   * Initialize default alert rules
   */
  initializeDefaultRules() {
    // System performance alerts
    this.addRule('high_cpu_usage', {
      category: AlertCategory.PERFORMANCE,
      severity: AlertSeverity.WARNING,
      condition: (metrics) => metrics.system?.cpu?.usage > this.config.thresholds.cpuUsage,
      message: (metrics) => `High CPU usage: ${metrics.system.cpu.usage.toFixed(1)}%`,
      actions: ['log', 'notify'],
      cooldown: 300000
    });
    
    this.addRule('high_memory_usage', {
      category: AlertCategory.PERFORMANCE,
      severity: AlertSeverity.WARNING,
      condition: (metrics) => metrics.system?.memory?.usagePercent > this.config.thresholds.memoryUsage,
      message: (metrics) => `High memory usage: ${metrics.system.memory.usagePercent.toFixed(1)}%`,
      actions: ['log', 'notify'],
      cooldown: 300000
    });
    
    this.addRule('high_disk_usage', {
      category: AlertCategory.SYSTEM,
      severity: AlertSeverity.ERROR,
      condition: (metrics) => metrics.system?.disk?.usagePercent > this.config.thresholds.diskUsage,
      message: (metrics) => `High disk usage: ${metrics.system.disk.usagePercent.toFixed(1)}%`,
      actions: ['log', 'notify', 'escalate'],
      cooldown: 600000
    });
    
    // Mining alerts
    this.addRule('hashrate_drop', {
      category: AlertCategory.MINING,
      severity: AlertSeverity.WARNING,
      condition: (metrics) => {
        if (!metrics.mining?.hashrate?.current || !metrics.mining?.hashrate?.average) return false;
        const dropPercent = ((metrics.mining.hashrate.average - metrics.mining.hashrate.current) / metrics.mining.hashrate.average) * 100;
        return dropPercent > this.config.thresholds.hashrateDropPercent;
      },
      message: (metrics) => {
        const dropPercent = ((metrics.mining.hashrate.average - metrics.mining.hashrate.current) / metrics.mining.hashrate.average) * 100;
        return `Hashrate dropped by ${dropPercent.toFixed(1)}% (Current: ${(metrics.mining.hashrate.current / 1e9).toFixed(2)} GH/s)`;
      },
      actions: ['log', 'notify'],
      cooldown: 600000
    });
    
    this.addRule('high_share_rejection', {
      category: AlertCategory.MINING,
      severity: AlertSeverity.ERROR,
      condition: (metrics) => metrics.mining?.shares?.rejectionRate > this.config.thresholds.shareRejectionRate,
      message: (metrics) => `High share rejection rate: ${metrics.mining.shares.rejectionRate.toFixed(1)}%`,
      actions: ['log', 'notify', 'investigate'],
      cooldown: 300000
    });
    
    this.addRule('block_orphaned', {
      category: AlertCategory.MINING,
      severity: AlertSeverity.WARNING,
      condition: (metrics) => metrics.mining?.blocks?.orphaned > 0,
      message: (metrics) => `Block orphaned at height ${metrics.mining.blocks.lastOrphanedHeight}`,
      actions: ['log', 'notify'],
      cooldown: 0 // No cooldown for block events
    });
    
    // Security alerts
    this.addRule('ddos_attack', {
      category: AlertCategory.SECURITY,
      severity: AlertSeverity.CRITICAL,
      condition: (metrics) => metrics.security?.ddos?.detected === true,
      message: (metrics) => `DDoS attack detected from ${metrics.security.ddos.sourceIPs.length} IPs`,
      actions: ['log', 'notify', 'escalate', 'mitigate'],
      cooldown: 60000
    });
    
    this.addRule('suspicious_activity', {
      category: AlertCategory.SECURITY,
      severity: AlertSeverity.ERROR,
      condition: (metrics) => metrics.security?.suspiciousActivity?.count > 0,
      message: (metrics) => `Suspicious activity detected: ${metrics.security.suspiciousActivity.description}`,
      actions: ['log', 'notify', 'investigate'],
      cooldown: 300000
    });
    
    // Network alerts
    this.addRule('high_network_latency', {
      category: AlertCategory.NETWORK,
      severity: AlertSeverity.WARNING,
      condition: (metrics) => metrics.network?.latency?.average > this.config.thresholds.networkLatency,
      message: (metrics) => `High network latency: ${metrics.network.latency.average.toFixed(0)}ms`,
      actions: ['log', 'notify'],
      cooldown: 300000
    });
    
    this.addRule('peer_disconnections', {
      category: AlertCategory.NETWORK,
      severity: AlertSeverity.WARNING,
      condition: (metrics) => metrics.network?.peers?.disconnections > 5,
      message: (metrics) => `Multiple peer disconnections: ${metrics.network.peers.disconnections} in last 5 minutes`,
      actions: ['log', 'notify'],
      cooldown: 300000
    });
    
    // Database alerts
    this.addRule('slow_db_queries', {
      category: AlertCategory.DATABASE,
      severity: AlertSeverity.WARNING,
      condition: (metrics) => metrics.database?.queryTime?.max > this.config.thresholds.dbQueryTime,
      message: (metrics) => `Slow database queries detected: Max ${metrics.database.queryTime.max}ms`,
      actions: ['log', 'notify', 'optimize'],
      cooldown: 600000
    });
    
    // Payment alerts
    this.addRule('payment_failure', {
      category: AlertCategory.PAYMENT,
      severity: AlertSeverity.ERROR,
      condition: (metrics) => metrics.payments?.failures > 0,
      message: (metrics) => `Payment failures: ${metrics.payments.failures} transactions failed`,
      actions: ['log', 'notify', 'escalate'],
      cooldown: 0 // No cooldown for payment issues
    });
    
    logger.info(`Initialized ${this.rules.size} default alert rules`);
  }
  
  /**
   * Add custom alert rule
   */
  addRule(id, rule) {
    this.rules.set(id, {
      id,
      category: rule.category || AlertCategory.SYSTEM,
      severity: rule.severity || AlertSeverity.INFO,
      condition: rule.condition,
      message: rule.message,
      actions: rule.actions || ['log'],
      cooldown: rule.cooldown || this.config.cooldownPeriod,
      enabled: rule.enabled !== false,
      metadata: rule.metadata || {}
    });
    
    logger.debug('Alert rule added', { id, category: rule.category, severity: rule.severity });
  }
  
  /**
   * Evaluate metrics against all rules
   */
  async evaluateMetrics(metrics) {
    const triggeredAlerts = [];
    
    for (const [ruleId, rule] of this.rules) {
      if (!rule.enabled) continue;
      
      try {
        // Check if rule condition is met
        if (rule.condition(metrics)) {
          // Check cooldown
          if (!this.isInCooldown(ruleId)) {
            const alert = await this.triggerAlert(ruleId, rule, metrics);
            triggeredAlerts.push(alert);
          } else {
            this.stats.suppressedAlerts++;
          }
        } else {
          // Condition not met, clear active alert if exists
          this.clearAlert(ruleId);
        }
      } catch (error) {
        logger.error('Error evaluating rule', { ruleId, error: error.message });
      }
    }
    
    return triggeredAlerts;
  }
  
  /**
   * Trigger an alert
   */
  async triggerAlert(ruleId, rule, metrics) {
    const alertId = this.generateAlertId(ruleId);
    
    const alert = {
      id: alertId,
      ruleId,
      timestamp: Date.now(),
      severity: rule.severity,
      category: rule.category,
      message: typeof rule.message === 'function' ? rule.message(metrics) : rule.message,
      metrics: this.extractRelevantMetrics(metrics, rule),
      actions: rule.actions,
      metadata: rule.metadata
    };
    
    // Store active alert
    this.activeAlerts.set(ruleId, alert);
    
    // Add to history
    this.addToHistory(alert);
    
    // Update statistics
    this.updateStats(alert);
    
    // Set cooldown
    this.setCooldown(ruleId, rule.cooldown);
    
    // Execute actions
    await this.executeActions(alert);
    
    // Emit event
    this.emit('alert:triggered', alert);
    
    logger.info('Alert triggered', {
      ruleId,
      severity: alert.severity,
      category: alert.category,
      message: alert.message
    });
    
    return alert;
  }
  
  /**
   * Clear an alert
   */
  clearAlert(ruleId) {
    const alert = this.activeAlerts.get(ruleId);
    if (!alert) return;
    
    this.activeAlerts.delete(ruleId);
    
    const clearedAlert = {
      ...alert,
      clearedAt: Date.now(),
      duration: Date.now() - alert.timestamp
    };
    
    this.emit('alert:cleared', clearedAlert);
    
    logger.info('Alert cleared', {
      ruleId,
      duration: clearedAlert.duration
    });
  }
  
  /**
   * Execute alert actions
   */
  async executeActions(alert) {
    for (const action of alert.actions) {
      try {
        switch (action) {
          case 'log':
            this.logAlert(alert);
            break;
            
          case 'notify':
            await this.sendNotifications(alert);
            break;
            
          case 'escalate':
            await this.escalateAlert(alert);
            break;
            
          case 'mitigate':
            await this.mitigateIssue(alert);
            break;
            
          case 'investigate':
            await this.investigateIssue(alert);
            break;
            
          case 'optimize':
            await this.optimizeSystem(alert);
            break;
            
          default:
            // Custom action
            this.emit(`action:${action}`, alert);
        }
      } catch (error) {
        logger.error('Error executing alert action', {
          action,
          alertId: alert.id,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Send notifications through configured channels
   */
  async sendNotifications(alert) {
    const notifications = [];
    
    // Console notification
    if (this.config.channels.console.enabled) {
      console.log(`\n[ALERT] ${alert.severity.toUpperCase()}: ${alert.message}\n`);
    }
    
    // Email notification
    if (this.config.channels.email.enabled && this.notificationClients.email) {
      notifications.push(this.sendEmailNotification(alert));
    }
    
    // Slack notification
    if (this.config.channels.slack.enabled && this.notificationClients.slack) {
      notifications.push(this.sendSlackNotification(alert));
    }
    
    // Telegram notification
    if (this.config.channels.telegram.enabled && this.notificationClients.telegram) {
      notifications.push(this.sendTelegramNotification(alert));
    }
    
    // Webhook notification
    if (this.config.channels.webhook.enabled) {
      notifications.push(this.sendWebhookNotification(alert));
    }
    
    // Wait for all notifications
    const results = await Promise.allSettled(notifications);
    
    // Update statistics
    results.forEach(result => {
      if (result.status === 'fulfilled') {
        this.stats.notificationsSent++;
      } else {
        this.stats.notificationsFailed++;
        logger.error('Notification failed', { error: result.reason });
      }
    });
  }
  
  /**
   * Send email notification
   */
  async sendEmailNotification(alert) {
    const mailOptions = {
      from: this.config.channels.email.from || 'Otedama Alert System <alerts@otedama.local>',
      to: this.config.channels.email.recipients.join(','),
      subject: `[${alert.severity.toUpperCase()}] ${alert.category}: ${alert.message.substring(0, 50)}...`,
      html: this.formatEmailAlert(alert)
    };
    
    await this.notificationClients.email.sendMail(mailOptions);
  }
  
  /**
   * Send Slack notification
   */
  async sendSlackNotification(alert) {
    const color = {
      [AlertSeverity.INFO]: '#36a64f',
      [AlertSeverity.WARNING]: '#ff9800',
      [AlertSeverity.ERROR]: '#f44336',
      [AlertSeverity.CRITICAL]: '#d32f2f'
    }[alert.severity];
    
    await this.notificationClients.slack.chat.postMessage({
      channel: this.config.channels.slack.channel,
      attachments: [{
        color,
        title: `${alert.severity.toUpperCase()}: ${alert.category}`,
        text: alert.message,
        fields: [
          {
            title: 'Alert ID',
            value: alert.id,
            short: true
          },
          {
            title: 'Time',
            value: new Date(alert.timestamp).toLocaleString(),
            short: true
          }
        ],
        footer: 'Otedama Alert System',
        ts: Math.floor(alert.timestamp / 1000)
      }]
    });
  }
  
  /**
   * Send Telegram notification
   */
  async sendTelegramNotification(alert) {
    const emoji = {
      [AlertSeverity.INFO]: 'ℹ️',
      [AlertSeverity.WARNING]: '⚠️',
      [AlertSeverity.ERROR]: '❌',
      [AlertSeverity.CRITICAL]: '🚨'
    }[alert.severity];
    
    const message = `
${emoji} *${alert.severity.toUpperCase()}*: ${alert.category}

${alert.message}

_Alert ID: ${alert.id}_
_Time: ${new Date(alert.timestamp).toLocaleString()}_
`;
    
    await this.notificationClients.telegram.telegram.sendMessage(
      this.config.channels.telegram.chatId,
      message,
      { parse_mode: 'Markdown' }
    );
  }
  
  /**
   * Send webhook notification
   */
  async sendWebhookNotification(alert) {
    const payload = {
      id: alert.id,
      ruleId: alert.ruleId,
      timestamp: alert.timestamp,
      severity: alert.severity,
      category: alert.category,
      message: alert.message,
      metrics: alert.metrics,
      metadata: alert.metadata
    };
    
    const requests = this.config.channels.webhook.urls.map(url =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Alert-Severity': alert.severity,
          'X-Alert-Category': alert.category
        },
        body: JSON.stringify(payload)
      })
    );
    
    await Promise.allSettled(requests);
  }
  
  /**
   * Format email alert
   */
  formatEmailAlert(alert) {
    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; }
    .alert-header { 
      padding: 20px;
      color: white;
      background-color: ${
        alert.severity === AlertSeverity.CRITICAL ? '#d32f2f' :
        alert.severity === AlertSeverity.ERROR ? '#f44336' :
        alert.severity === AlertSeverity.WARNING ? '#ff9800' : '#4caf50'
      };
    }
    .alert-body { padding: 20px; }
    .metric { margin: 10px 0; }
    .footer { padding: 10px; background-color: #f5f5f5; font-size: 12px; }
  </style>
</head>
<body>
  <div class="alert-header">
    <h2>${alert.severity.toUpperCase()}: ${alert.category}</h2>
  </div>
  <div class="alert-body">
    <p><strong>${alert.message}</strong></p>
    <hr>
    <p><strong>Alert ID:</strong> ${alert.id}</p>
    <p><strong>Time:</strong> ${new Date(alert.timestamp).toLocaleString()}</p>
    <p><strong>Rule:</strong> ${alert.ruleId}</p>
    ${alert.metrics ? `
    <h3>Metrics:</h3>
    <pre>${JSON.stringify(alert.metrics, null, 2)}</pre>
    ` : ''}
  </div>
  <div class="footer">
    <p>Otedama Mining Pool Alert System</p>
  </div>
</body>
</html>
`;
  }
  
  /**
   * Escalate alert
   */
  async escalateAlert(alert) {
    logger.warn('Alert escalated', { alertId: alert.id });
    
    // Create escalation alert
    const escalationAlert = {
      ...alert,
      id: this.generateAlertId(`escalation_${alert.ruleId}`),
      severity: AlertSeverity.CRITICAL,
      message: `ESCALATED: ${alert.message}`,
      escalatedFrom: alert.id
    };
    
    // Send high-priority notifications
    await this.sendNotifications(escalationAlert);
    
    this.emit('alert:escalated', escalationAlert);
  }
  
  /**
   * Mitigate issue
   */
  async mitigateIssue(alert) {
    logger.info('Mitigating issue', { alertId: alert.id });
    
    // Emit mitigation event for specific handlers
    this.emit('mitigation:required', alert);
    
    // Log mitigation attempt
    const mitigationLog = {
      alertId: alert.id,
      timestamp: Date.now(),
      action: 'mitigation_initiated'
    };
    
    this.emit('mitigation:started', mitigationLog);
  }
  
  /**
   * Investigate issue
   */
  async investigateIssue(alert) {
    logger.info('Investigating issue', { alertId: alert.id });
    
    // Collect diagnostic information
    const diagnostics = {
      alertId: alert.id,
      timestamp: Date.now(),
      category: alert.category,
      metrics: alert.metrics,
      systemState: await this.collectSystemState()
    };
    
    this.emit('investigation:started', diagnostics);
  }
  
  /**
   * Optimize system based on alert
   */
  async optimizeSystem(alert) {
    logger.info('Optimizing system', { alertId: alert.id });
    
    this.emit('optimization:required', alert);
  }
  
  /**
   * Collect system state for diagnostics
   */
  async collectSystemState() {
    // This would be implemented to collect relevant system information
    return {
      timestamp: Date.now(),
      activeAlerts: this.activeAlerts.size,
      // Add more system state as needed
    };
  }
  
  /**
   * Check if rule is in cooldown
   */
  isInCooldown(ruleId) {
    const cooldownUntil = this.cooldowns.get(ruleId);
    return cooldownUntil && Date.now() < cooldownUntil;
  }
  
  /**
   * Set cooldown for rule
   */
  setCooldown(ruleId, duration) {
    if (duration > 0) {
      this.cooldowns.set(ruleId, Date.now() + duration);
    }
  }
  
  /**
   * Generate unique alert ID
   */
  generateAlertId(ruleId) {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `${ruleId}_${timestamp}_${random}`;
  }
  
  /**
   * Extract relevant metrics for alert
   */
  extractRelevantMetrics(metrics, rule) {
    // Extract only metrics relevant to the alert category
    const relevantMetrics = {};
    
    switch (rule.category) {
      case AlertCategory.PERFORMANCE:
        relevantMetrics.system = metrics.system;
        break;
      case AlertCategory.MINING:
        relevantMetrics.mining = metrics.mining;
        break;
      case AlertCategory.SECURITY:
        relevantMetrics.security = metrics.security;
        break;
      case AlertCategory.NETWORK:
        relevantMetrics.network = metrics.network;
        break;
      case AlertCategory.DATABASE:
        relevantMetrics.database = metrics.database;
        break;
      case AlertCategory.PAYMENT:
        relevantMetrics.payments = metrics.payments;
        break;
      default:
        return metrics;
    }
    
    return relevantMetrics;
  }
  
  /**
   * Add alert to history
   */
  addToHistory(alert) {
    this.alertHistory.push(alert);
    
    // Maintain history size limit
    if (this.alertHistory.length > this.config.maxAlertHistory) {
      this.alertHistory.shift();
    }
  }
  
  /**
   * Update statistics
   */
  updateStats(alert) {
    this.stats.totalAlerts++;
    this.stats.alertsBySeverity[alert.severity]++;
    this.stats.alertsByCategory[alert.category]++;
  }
  
  /**
   * Log alert
   */
  logAlert(alert) {
    const logMethod = {
      [AlertSeverity.INFO]: 'info',
      [AlertSeverity.WARNING]: 'warn',
      [AlertSeverity.ERROR]: 'error',
      [AlertSeverity.CRITICAL]: 'error'
    }[alert.severity];
    
    logger[logMethod](`Alert: ${alert.message}`, {
      alertId: alert.id,
      severity: alert.severity,
      category: alert.category,
      ruleId: alert.ruleId
    });
  }
  
  /**
   * Start alert aggregation
   */
  startAlertAggregation() {
    if (!this.config.enableSmartGrouping) return;
    
    setInterval(() => {
      this.aggregateAlerts();
    }, this.config.aggregationWindow);
  }
  
  /**
   * Aggregate similar alerts
   */
  aggregateAlerts() {
    const groups = new Map();
    
    // Group active alerts by category and severity
    for (const [ruleId, alert] of this.activeAlerts) {
      const groupKey = `${alert.category}_${alert.severity}`;
      
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      
      groups.get(groupKey).push(alert);
    }
    
    // Process groups
    for (const [groupKey, alerts] of groups) {
      if (alerts.length > 3) {
        // Create aggregated alert
        const aggregatedAlert = {
          id: this.generateAlertId(`aggregated_${groupKey}`),
          ruleId: 'aggregated',
          timestamp: Date.now(),
          severity: alerts[0].severity,
          category: alerts[0].category,
          message: `Multiple alerts (${alerts.length}) in ${alerts[0].category}`,
          alerts: alerts.map(a => ({ id: a.id, message: a.message })),
          actions: ['log', 'notify']
        };
        
        this.emit('alert:aggregated', aggregatedAlert);
      }
    }
    
    this.alertGroups = groups;
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
  getAlertHistory(options = {}) {
    let history = [...this.alertHistory];
    
    // Filter by time range
    if (options.since) {
      history = history.filter(alert => alert.timestamp >= options.since);
    }
    
    // Filter by severity
    if (options.severity) {
      history = history.filter(alert => alert.severity === options.severity);
    }
    
    // Filter by category
    if (options.category) {
      history = history.filter(alert => alert.category === options.category);
    }
    
    // Sort and limit
    history.sort((a, b) => b.timestamp - a.timestamp);
    
    if (options.limit) {
      history = history.slice(0, options.limit);
    }
    
    return history;
  }
  
  /**
   * Get alert statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeAlerts: this.activeAlerts.size,
      cooldowns: this.cooldowns.size,
      rules: {
        total: this.rules.size,
        enabled: Array.from(this.rules.values()).filter(r => r.enabled).length
      }
    };
  }
  
  /**
   * Enable/disable rule
   */
  setRuleEnabled(ruleId, enabled) {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = enabled;
      logger.info('Rule status changed', { ruleId, enabled });
    }
  }
  
  /**
   * Update rule configuration
   */
  updateRule(ruleId, updates) {
    const rule = this.rules.get(ruleId);
    if (rule) {
      Object.assign(rule, updates);
      logger.info('Rule updated', { ruleId, updates });
    }
  }
  
  /**
   * Clear all alerts
   */
  clearAllAlerts() {
    const clearedCount = this.activeAlerts.size;
    
    for (const ruleId of this.activeAlerts.keys()) {
      this.clearAlert(ruleId);
    }
    
    logger.info('All alerts cleared', { count: clearedCount });
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this.stats.totalAlerts = 0;
    this.stats.suppressedAlerts = 0;
    this.stats.notificationsSent = 0;
    this.stats.notificationsFailed = 0;
    
    Object.keys(this.stats.alertsBySeverity).forEach(severity => {
      this.stats.alertsBySeverity[severity] = 0;
    });
    
    Object.keys(this.stats.alertsByCategory).forEach(category => {
      this.stats.alertsByCategory[category] = 0;
    });
    
    logger.info('Alert statistics reset');
  }
  
  /**
   * Shutdown alert system
   */
  async shutdown() {
    logger.info('Shutting down alert system');
    
    // Clear all alerts
    this.clearAllAlerts();
    
    // Clear intervals
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
    }
    
    // Close notification clients
    if (this.notificationClients.email) {
      this.notificationClients.email.close();
    }
    
    this.emit('shutdown');
  }
}

export default AdvancedAlertSystem;