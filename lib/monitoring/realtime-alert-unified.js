/**
 * Unified Real-Time Alert System - Otedama
 * Comprehensive alerting with multiple notification channels
 * 
 * Design principles:
 * - Carmack: Instant alert delivery with minimal latency
 * - Martin: Clean alert architecture with plugin support
 * - Pike: Simple configuration with powerful rules
 */

import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';
import { createTransport } from 'nodemailer';
import { createStructuredLogger } from '../core/structured-logger.js';
import { MetricsCollector } from './metrics-collector.js';

const logger = createStructuredLogger('RealtimeAlertUnified');

/**
 * Alert severity levels
 */
export const AlertSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

/**
 * Alert categories
 */
export const AlertCategory = {
  // Mining
  MINING_HASHRATE: 'mining_hashrate',
  MINING_BLOCK_FOUND: 'mining_block_found',
  MINING_WORKER_DOWN: 'mining_worker_down',
  MINING_EFFICIENCY: 'mining_efficiency',
  
  // Pool
  POOL_PERFORMANCE: 'pool_performance',
  POOL_DISCONNECTION: 'pool_disconnection',
  POOL_SHARE_REJECTION: 'pool_share_rejection',
  
  // System
  SYSTEM_CPU: 'system_cpu',
  SYSTEM_MEMORY: 'system_memory',
  SYSTEM_DISK: 'system_disk',
  SYSTEM_TEMPERATURE: 'system_temperature',
  
  // Security
  SECURITY_ATTACK: 'security_attack',
  SECURITY_AUTH_FAILURE: 'security_auth_failure',
  SECURITY_ANOMALY: 'security_anomaly',
  
  // Network
  NETWORK_LATENCY: 'network_latency',
  NETWORK_DISCONNECTION: 'network_disconnection',
  NETWORK_BANDWIDTH: 'network_bandwidth',
  
  // Business
  REVENUE_THRESHOLD: 'revenue_threshold',
  COST_OVERRUN: 'cost_overrun',
  PROFITABILITY: 'profitability'
};

/**
 * Notification channels
 */
export const NotificationChannel = {
  WEBSOCKET: 'websocket',
  EMAIL: 'email',
  SMS: 'sms',
  WEBHOOK: 'webhook',
  SLACK: 'slack',
  TELEGRAM: 'telegram',
  PUSHOVER: 'pushover'
};

/**
 * Unified Real-Time Alert System
 */
export class UnifiedRealtimeAlert extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Alert settings
      defaultSeverity: config.defaultSeverity || AlertSeverity.WARNING,
      throttleWindow: config.throttleWindow || 300000, // 5 minutes
      maxAlertsPerWindow: config.maxAlertsPerWindow || 10,
      
      // Channels
      enabledChannels: config.enabledChannels || [NotificationChannel.WEBSOCKET],
      
      // WebSocket
      wsPort: config.wsPort || 8081,
      
      // Email
      emailConfig: config.emailConfig || {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      },
      
      // Webhooks
      webhookUrls: config.webhookUrls || [],
      
      // Slack
      slackWebhook: config.slackWebhook || process.env.SLACK_WEBHOOK,
      
      // Telegram
      telegramToken: config.telegramToken || process.env.TELEGRAM_TOKEN,
      telegramChatId: config.telegramChatId || process.env.TELEGRAM_CHAT_ID,
      
      ...config
    };
    
    this.alerts = [];
    this.rules = new Map();
    this.throttleMap = new Map();
    this.channels = new Map();
    this.wsClients = new Set();
    
    this.initialize();
  }
  
  async initialize() {
    // Initialize notification channels
    for (const channel of this.config.enabledChannels) {
      await this.initializeChannel(channel);
    }
    
    // Start cleanup interval
    this.startCleanup();
    
    // Initialize metrics collector
    this.metricsCollector = new MetricsCollector();
    
    logger.info('Unified realtime alert system initialized', {
      channels: this.config.enabledChannels
    });
  }
  
  /**
   * Initialize notification channel
   */
  async initializeChannel(channel) {
    switch (channel) {
      case NotificationChannel.WEBSOCKET:
        await this.initializeWebSocket();
        break;
        
      case NotificationChannel.EMAIL:
        this.initializeEmail();
        break;
        
      case NotificationChannel.SLACK:
        this.initializeSlack();
        break;
        
      case NotificationChannel.TELEGRAM:
        await this.initializeTelegram();
        break;
        
      // Other channels...
    }
    
    this.channels.set(channel, true);
  }
  
  /**
   * Initialize WebSocket server
   */
  async initializeWebSocket() {
    this.wss = new WebSocketServer({ port: this.config.wsPort });
    
    this.wss.on('connection', (ws) => {
      this.wsClients.add(ws);
      
      ws.on('close', () => {
        this.wsClients.delete(ws);
      });
      
      // Send recent alerts
      const recentAlerts = this.alerts.slice(-10);
      ws.send(JSON.stringify({
        type: 'initial',
        alerts: recentAlerts
      }));
    });
    
    logger.info('WebSocket alert server started', { port: this.config.wsPort });
  }
  
  /**
   * Initialize email transport
   */
  initializeEmail() {
    if (this.config.emailConfig.host) {
      this.emailTransport = createTransport(this.config.emailConfig);
      logger.info('Email alert channel initialized');
    }
  }
  
  /**
   * Initialize Slack integration
   */
  initializeSlack() {
    if (this.config.slackWebhook) {
      logger.info('Slack alert channel initialized');
    }
  }
  
  /**
   * Initialize Telegram bot
   */
  async initializeTelegram() {
    if (this.config.telegramToken) {
      // In production, use actual Telegram Bot API
      logger.info('Telegram alert channel initialized');
    }
  }
  
  /**
   * Register alert rule
   */
  registerRule(name, config) {
    const rule = {
      name,
      category: config.category,
      condition: config.condition,
      severity: config.severity || this.config.defaultSeverity,
      channels: config.channels || this.config.enabledChannels,
      message: config.message,
      metadata: config.metadata || {},
      enabled: config.enabled !== false
    };
    
    this.rules.set(name, rule);
    
    logger.info('Alert rule registered', { name, category: rule.category });
  }
  
  /**
   * Check rules and trigger alerts
   */
  async checkRules(metrics) {
    for (const [name, rule] of this.rules) {
      if (!rule.enabled) continue;
      
      try {
        const triggered = await this.evaluateRule(rule, metrics);
        
        if (triggered) {
          await this.triggerAlert({
            rule: name,
            category: rule.category,
            severity: rule.severity,
            message: this.formatMessage(rule.message, metrics),
            metadata: { ...rule.metadata, metrics }
          });
        }
      } catch (error) {
        logger.error('Rule evaluation failed', { rule: name, error });
      }
    }
  }
  
  /**
   * Evaluate rule condition
   */
  async evaluateRule(rule, metrics) {
    if (typeof rule.condition === 'function') {
      return rule.condition(metrics);
    }
    
    // Simple threshold conditions
    if (rule.condition.metric && rule.condition.operator && rule.condition.threshold) {
      const value = this.getMetricValue(metrics, rule.condition.metric);
      
      switch (rule.condition.operator) {
        case '>':
          return value > rule.condition.threshold;
        case '<':
          return value < rule.condition.threshold;
        case '>=':
          return value >= rule.condition.threshold;
        case '<=':
          return value <= rule.condition.threshold;
        case '==':
          return value === rule.condition.threshold;
        case '!=':
          return value !== rule.condition.threshold;
        default:
          return false;
      }
    }
    
    return false;
  }
  
  /**
   * Trigger alert
   */
  async triggerAlert(alertData) {
    const alert = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2),
      timestamp: new Date(),
      ...alertData
    };
    
    // Check throttling
    if (this.isThrottled(alert)) {
      logger.debug('Alert throttled', { rule: alert.rule });
      return;
    }
    
    // Store alert
    this.alerts.push(alert);
    if (this.alerts.length > 1000) {
      this.alerts.shift();
    }
    
    // Send to channels
    await this.sendAlert(alert);
    
    // Emit event
    this.emit('alert', alert);
    
    logger.warn('Alert triggered', {
      id: alert.id,
      rule: alert.rule,
      severity: alert.severity
    });
  }
  
  /**
   * Send alert to all configured channels
   */
  async sendAlert(alert) {
    const promises = [];
    
    for (const channel of alert.channels || this.config.enabledChannels) {
      if (!this.channels.has(channel)) continue;
      
      switch (channel) {
        case NotificationChannel.WEBSOCKET:
          promises.push(this.sendWebSocketAlert(alert));
          break;
          
        case NotificationChannel.EMAIL:
          promises.push(this.sendEmailAlert(alert));
          break;
          
        case NotificationChannel.SLACK:
          promises.push(this.sendSlackAlert(alert));
          break;
          
        case NotificationChannel.TELEGRAM:
          promises.push(this.sendTelegramAlert(alert));
          break;
          
        case NotificationChannel.WEBHOOK:
          promises.push(this.sendWebhookAlert(alert));
          break;
      }
    }
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Send WebSocket alert
   */
  async sendWebSocketAlert(alert) {
    const message = JSON.stringify({
      type: 'alert',
      data: alert
    });
    
    for (const client of this.wsClients) {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    }
  }
  
  /**
   * Send email alert
   */
  async sendEmailAlert(alert) {
    if (!this.emailTransport) return;
    
    const mailOptions = {
      from: this.config.emailConfig.from || 'alerts@otedama.com',
      to: this.config.emailConfig.to,
      subject: `[${alert.severity.toUpperCase()}] ${alert.rule}`,
      html: this.formatEmailBody(alert)
    };
    
    try {
      await this.emailTransport.sendMail(mailOptions);
    } catch (error) {
      logger.error('Failed to send email alert', { error });
    }
  }
  
  /**
   * Send Slack alert
   */
  async sendSlackAlert(alert) {
    if (!this.config.slackWebhook) return;
    
    const color = {
      info: '#36a64f',
      warning: '#ff9900',
      error: '#ff0000',
      critical: '#990000'
    }[alert.severity];
    
    const payload = {
      attachments: [{
        color,
        title: alert.rule,
        text: alert.message,
        fields: [
          {
            title: 'Severity',
            value: alert.severity.toUpperCase(),
            short: true
          },
          {
            title: 'Category',
            value: alert.category,
            short: true
          }
        ],
        ts: Math.floor(alert.timestamp.getTime() / 1000)
      }]
    };
    
    try {
      const response = await fetch(this.config.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        throw new Error(`Slack API error: ${response.statusText}`);
      }
    } catch (error) {
      logger.error('Failed to send Slack alert', { error });
    }
  }
  
  /**
   * Send Telegram alert
   */
  async sendTelegramAlert(alert) {
    if (!this.config.telegramToken || !this.config.telegramChatId) return;
    
    const emoji = {
      info: 'ℹ️',
      warning: '⚠️',
      error: '❌',
      critical: '🚨'
    }[alert.severity];
    
    const text = `${emoji} *${alert.rule}*\n\n${alert.message}\n\nSeverity: ${alert.severity}\nCategory: ${alert.category}`;
    
    try {
      const url = `https://api.telegram.org/bot${this.config.telegramToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.telegramChatId,
          text,
          parse_mode: 'Markdown'
        })
      });
      
      if (!response.ok) {
        throw new Error(`Telegram API error: ${response.statusText}`);
      }
    } catch (error) {
      logger.error('Failed to send Telegram alert', { error });
    }
  }
  
  /**
   * Send webhook alert
   */
  async sendWebhookAlert(alert) {
    const promises = this.config.webhookUrls.map(async (url) => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(alert)
        });
        
        if (!response.ok) {
          throw new Error(`Webhook error: ${response.statusText}`);
        }
      } catch (error) {
        logger.error('Failed to send webhook alert', { url, error });
      }
    });
    
    await Promise.allSettled(promises);
  }
  
  /**
   * Check if alert is throttled
   */
  isThrottled(alert) {
    const key = `${alert.rule}:${alert.severity}`;
    const now = Date.now();
    
    const throttleData = this.throttleMap.get(key) || {
      count: 0,
      windowStart: now
    };
    
    // Reset window if expired
    if (now - throttleData.windowStart > this.config.throttleWindow) {
      throttleData.count = 0;
      throttleData.windowStart = now;
    }
    
    // Check limit
    if (throttleData.count >= this.config.maxAlertsPerWindow) {
      return true;
    }
    
    // Update count
    throttleData.count++;
    this.throttleMap.set(key, throttleData);
    
    return false;
  }
  
  /**
   * Format message with metrics
   */
  formatMessage(template, metrics) {
    return template.replace(/\{(\w+)\}/g, (match, key) => {
      return this.getMetricValue(metrics, key) || match;
    });
  }
  
  /**
   * Get metric value by path
   */
  getMetricValue(metrics, path) {
    const keys = path.split('.');
    let value = metrics;
    
    for (const key of keys) {
      if (value && typeof value === 'object') {
        value = value[key];
      } else {
        return undefined;
      }
    }
    
    return value;
  }
  
  /**
   * Format email body
   */
  formatEmailBody(alert) {
    return `
      <h2>${alert.rule}</h2>
      <p><strong>Severity:</strong> ${alert.severity.toUpperCase()}</p>
      <p><strong>Category:</strong> ${alert.category}</p>
      <p><strong>Time:</strong> ${alert.timestamp.toISOString()}</p>
      <p><strong>Message:</strong> ${alert.message}</p>
      ${alert.metadata ? `<pre>${JSON.stringify(alert.metadata, null, 2)}</pre>` : ''}
    `;
  }
  
  /**
   * Register default rules
   */
  registerDefaultRules() {
    // Mining alerts
    this.registerRule('low_hashrate', {
      category: AlertCategory.MINING_HASHRATE,
      condition: { metric: 'mining.hashrate', operator: '<', threshold: 1000000 }, // 1 MH/s
      severity: AlertSeverity.WARNING,
      message: 'Mining hashrate dropped below {mining.hashrate} H/s'
    });
    
    this.registerRule('block_found', {
      category: AlertCategory.MINING_BLOCK_FOUND,
      condition: (metrics) => metrics.mining?.blockFound === true,
      severity: AlertSeverity.INFO,
      message: 'New block found! Block #{mining.blockNumber}'
    });
    
    // System alerts
    this.registerRule('high_cpu', {
      category: AlertCategory.SYSTEM_CPU,
      condition: { metric: 'system.cpu', operator: '>', threshold: 90 },
      severity: AlertSeverity.WARNING,
      message: 'CPU usage is high: {system.cpu}%'
    });
    
    this.registerRule('high_memory', {
      category: AlertCategory.SYSTEM_MEMORY,
      condition: { metric: 'system.memory', operator: '>', threshold: 85 },
      severity: AlertSeverity.WARNING,
      message: 'Memory usage is high: {system.memory}%'
    });
    
    // Security alerts
    this.registerRule('auth_failures', {
      category: AlertCategory.SECURITY_AUTH_FAILURE,
      condition: { metric: 'security.authFailures', operator: '>', threshold: 5 },
      severity: AlertSeverity.ERROR,
      message: 'Multiple authentication failures detected: {security.authFailures}'
    });
    
    // Network alerts
    this.registerRule('high_latency', {
      category: AlertCategory.NETWORK_LATENCY,
      condition: { metric: 'network.latency', operator: '>', threshold: 1000 },
      severity: AlertSeverity.WARNING,
      message: 'Network latency is high: {network.latency}ms'
    });
  }
  
  /**
   * Start cleanup interval
   */
  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      // Clean old alerts
      const cutoff = Date.now() - 86400000; // 24 hours
      this.alerts = this.alerts.filter(alert => 
        alert.timestamp.getTime() > cutoff
      );
      
      // Clean throttle map
      const now = Date.now();
      for (const [key, data] of this.throttleMap) {
        if (now - data.windowStart > this.config.throttleWindow * 2) {
          this.throttleMap.delete(key);
        }
      }
    }, 3600000); // Every hour
  }
  
  /**
   * Get alert history
   */
  getAlertHistory(filter = {}) {
    let alerts = [...this.alerts];
    
    if (filter.severity) {
      alerts = alerts.filter(a => a.severity === filter.severity);
    }
    
    if (filter.category) {
      alerts = alerts.filter(a => a.category === filter.category);
    }
    
    if (filter.since) {
      alerts = alerts.filter(a => a.timestamp >= filter.since);
    }
    
    return alerts;
  }
  
  /**
   * Get alert statistics
   */
  getStatistics() {
    const stats = {
      total: this.alerts.length,
      bySeverity: {},
      byCategory: {},
      last24h: 0
    };
    
    const dayAgo = Date.now() - 86400000;
    
    for (const alert of this.alerts) {
      // By severity
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
      
      // By category
      stats.byCategory[alert.category] = (stats.byCategory[alert.category] || 0) + 1;
      
      // Last 24h
      if (alert.timestamp.getTime() > dayAgo) {
        stats.last24h++;
      }
    }
    
    return stats;
  }
  
  /**
   * Shutdown alert system
   */
  async shutdown() {
    clearInterval(this.cleanupInterval);
    
    if (this.wss) {
      this.wss.close();
    }
    
    if (this.emailTransport) {
      this.emailTransport.close();
    }
    
    logger.info('Alert system shutdown');
  }
}

/**
 * Factory function
 */
export function createRealtimeAlert(config) {
  return new UnifiedRealtimeAlert(config);
}

export default UnifiedRealtimeAlert;