/**
 * Unified Monitoring and Alerting System
 * Real-time monitoring with intelligent alert routing
 * 
 * Design principles:
 * - Event-driven architecture for scalability (Carmack)
 * - Modular alert rules engine (Martin)
 * - Simple configuration with powerful features (Pike)
 */

const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const { createLogger } = require('../core/logger');

const logger = createLogger('MonitoringSystem');

// Alert severities
const SEVERITY = {
  INFO: 0,
  WARNING: 1,
  ERROR: 2,
  CRITICAL: 3
};

// Monitoring targets
const TARGETS = {
  SYSTEM: 'system',
  DEX: 'dex',
  MINING: 'mining',
  SECURITY: 'security',
  COMPLIANCE: 'compliance',
  PERFORMANCE: 'performance',
  USER: 'user'
};

// Alert channels
const CHANNELS = {
  LOG: 'log',
  EMAIL: 'email',
  SMS: 'sms',
  SLACK: 'slack',
  WEBHOOK: 'webhook',
  PAGERDUTY: 'pagerduty'
};

class UnifiedMonitoringSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Collection settings
      metricsInterval: options.metricsInterval || 10000, // 10 seconds
      aggregationWindow: options.aggregationWindow || 60000, // 1 minute
      retentionPeriod: options.retentionPeriod || 7 * 86400000, // 7 days
      
      // Alert settings
      alertThrottleWindow: options.alertThrottleWindow || 300000, // 5 minutes
      alertBatchingEnabled: options.alertBatchingEnabled !== false,
      alertBatchSize: options.alertBatchSize || 10,
      
      // Channel settings
      enabledChannels: options.enabledChannels || [CHANNELS.LOG, CHANNELS.EMAIL],
      channelConfigs: options.channelConfigs || {},
      
      // Performance
      maxMetricsPerTarget: options.maxMetricsPerTarget || 1000,
      compressionEnabled: options.compressionEnabled !== false,
      
      ...options
    };
    
    // State
    this.metrics = new Map(); // target -> metric -> timeseries
    this.alerts = new Map(); // alertId -> alert
    this.rules = new Map(); // ruleId -> rule
    this.thresholds = new Map(); // metric -> threshold
    
    // Alert management
    this.alertHistory = [];
    this.alertThrottle = new Map(); // ruleId -> lastAlerted
    this.pendingAlerts = [];
    
    // System metrics
    this.systemMetrics = {
      metricsCollected: 0,
      alertsGenerated: 0,
      alertsSent: 0,
      rulesEvaluated: 0,
      avgProcessingTime: 0
    };
    
    // Initialize
    this.initialize();
  }
  
  async initialize() {
    logger.info('Initializing monitoring system...');
    
    // Setup default rules
    this.setupDefaultRules();
    
    // Setup metric collectors
    this.setupCollectors();
    
    // Start monitoring loops
    this.startMonitoring();
    
    // Setup alert channels
    await this.setupAlertChannels();
    
    logger.info('Monitoring system initialized');
  }
  
  /**
   * Setup default monitoring rules
   */
  setupDefaultRules() {
    // System health rules
    this.addRule({
      id: 'high_cpu',
      name: 'High CPU Usage',
      target: TARGETS.SYSTEM,
      metric: 'cpu_usage',
      condition: 'greater_than',
      threshold: 80,
      duration: 300000, // 5 minutes
      severity: SEVERITY.WARNING,
      channels: [CHANNELS.LOG, CHANNELS.SLACK]
    });
    
    this.addRule({
      id: 'high_memory',
      name: 'High Memory Usage',
      target: TARGETS.SYSTEM,
      metric: 'memory_usage',
      condition: 'greater_than',
      threshold: 90,
      duration: 300000,
      severity: SEVERITY.ERROR,
      channels: [CHANNELS.LOG, CHANNELS.EMAIL]
    });
    
    // DEX monitoring rules
    this.addRule({
      id: 'low_liquidity',
      name: 'Low Liquidity Warning',
      target: TARGETS.DEX,
      metric: 'liquidity_depth',
      condition: 'less_than',
      threshold: 10000,
      severity: SEVERITY.WARNING,
      channels: [CHANNELS.LOG]
    });
    
    this.addRule({
      id: 'high_slippage',
      name: 'High Slippage Detected',
      target: TARGETS.DEX,
      metric: 'average_slippage',
      condition: 'greater_than',
      threshold: 2, // 2%
      severity: SEVERITY.WARNING,
      channels: [CHANNELS.LOG, CHANNELS.SLACK]
    });
    
    this.addRule({
      id: 'order_processing_delay',
      name: 'Order Processing Delay',
      target: TARGETS.DEX,
      metric: 'order_latency_p99',
      condition: 'greater_than',
      threshold: 1000, // 1 second
      severity: SEVERITY.ERROR,
      channels: [CHANNELS.LOG, CHANNELS.PAGERDUTY]
    });
    
    // Mining monitoring rules
    this.addRule({
      id: 'low_hashrate',
      name: 'Low Hashrate',
      target: TARGETS.MINING,
      metric: 'pool_hashrate',
      condition: 'less_than',
      threshold: 1000000000000, // 1 TH/s
      severity: SEVERITY.WARNING,
      channels: [CHANNELS.LOG]
    });
    
    this.addRule({
      id: 'high_stale_shares',
      name: 'High Stale Share Rate',
      target: TARGETS.MINING,
      metric: 'stale_share_rate',
      condition: 'greater_than',
      threshold: 5, // 5%
      severity: SEVERITY.WARNING,
      channels: [CHANNELS.LOG, CHANNELS.EMAIL]
    });
    
    // Security monitoring rules
    this.addRule({
      id: 'brute_force_detected',
      name: 'Brute Force Attack',
      target: TARGETS.SECURITY,
      metric: 'failed_login_rate',
      condition: 'greater_than',
      threshold: 10,
      duration: 60000, // 1 minute
      severity: SEVERITY.CRITICAL,
      channels: [CHANNELS.LOG, CHANNELS.EMAIL, CHANNELS.PAGERDUTY]
    });
    
    this.addRule({
      id: 'ddos_detected',
      name: 'DDoS Attack',
      target: TARGETS.SECURITY,
      metric: 'request_rate',
      condition: 'greater_than',
      threshold: 10000,
      duration: 10000, // 10 seconds
      severity: SEVERITY.CRITICAL,
      channels: [CHANNELS.LOG, CHANNELS.PAGERDUTY]
    });
    
    // Compliance monitoring rules
    this.addRule({
      id: 'large_transaction',
      name: 'Large Transaction Alert',
      target: TARGETS.COMPLIANCE,
      metric: 'max_transaction_size',
      condition: 'greater_than',
      threshold: 100000,
      severity: SEVERITY.INFO,
      channels: [CHANNELS.LOG, CHANNELS.EMAIL]
    });
    
    this.addRule({
      id: 'suspicious_activity',
      name: 'Suspicious Activity Score',
      target: TARGETS.COMPLIANCE,
      metric: 'risk_score',
      condition: 'greater_than',
      threshold: 0.8,
      severity: SEVERITY.ERROR,
      channels: [CHANNELS.LOG, CHANNELS.EMAIL, CHANNELS.SLACK]
    });
  }
  
  /**
   * Add monitoring rule
   */
  addRule(rule) {
    const validatedRule = this.validateRule(rule);
    if (!validatedRule) {
      logger.error('Invalid rule:', rule);
      return;
    }
    
    this.rules.set(rule.id, {
      ...validatedRule,
      enabled: true,
      createdAt: Date.now(),
      lastTriggered: null,
      triggerCount: 0
    });
    
    logger.info(`Added monitoring rule: ${rule.name}`);
  }
  
  /**
   * Validate rule configuration
   */
  validateRule(rule) {
    if (!rule.id || !rule.name || !rule.target || !rule.metric) {
      return null;
    }
    
    if (!['greater_than', 'less_than', 'equals', 'not_equals'].includes(rule.condition)) {
      return null;
    }
    
    return {
      ...rule,
      severity: rule.severity || SEVERITY.INFO,
      channels: rule.channels || [CHANNELS.LOG],
      duration: rule.duration || 0
    };
  }
  
  /**
   * Setup metric collectors
   */
  setupCollectors() {
    // System metrics collector
    this.collectors = new Map();
    
    this.collectors.set(TARGETS.SYSTEM, {
      interval: setInterval(() => this.collectSystemMetrics(), 5000),
      handler: this.collectSystemMetrics.bind(this)
    });
    
    this.collectors.set(TARGETS.PERFORMANCE, {
      interval: setInterval(() => this.collectPerformanceMetrics(), 10000),
      handler: this.collectPerformanceMetrics.bind(this)
    });
  }
  
  /**
   * Collect system metrics
   */
  collectSystemMetrics() {
    const usage = process.cpuUsage();
    const memory = process.memoryUsage();
    
    // CPU usage percentage (simplified)
    const cpuPercent = (usage.user + usage.system) / 1000000 * 100;
    
    // Memory usage percentage
    const totalMemory = require('os').totalmem();
    const memoryPercent = (memory.heapUsed / totalMemory) * 100;
    
    this.recordMetric(TARGETS.SYSTEM, 'cpu_usage', cpuPercent);
    this.recordMetric(TARGETS.SYSTEM, 'memory_usage', memoryPercent);
    this.recordMetric(TARGETS.SYSTEM, 'heap_used', memory.heapUsed);
    this.recordMetric(TARGETS.SYSTEM, 'rss', memory.rss);
    this.recordMetric(TARGETS.SYSTEM, 'uptime', process.uptime());
  }
  
  /**
   * Collect performance metrics
   */
  collectPerformanceMetrics() {
    // Event loop lag
    const start = performance.now();
    setImmediate(() => {
      const lag = performance.now() - start;
      this.recordMetric(TARGETS.PERFORMANCE, 'event_loop_lag', lag);
    });
    
    // GC metrics
    if (global.gc) {
      const before = process.memoryUsage();
      global.gc();
      const after = process.memoryUsage();
      const gcImpact = before.heapUsed - after.heapUsed;
      this.recordMetric(TARGETS.PERFORMANCE, 'gc_impact', gcImpact);
    }
  }
  
  /**
   * Record metric value
   */
  recordMetric(target, metric, value, tags = {}) {
    const key = `${target}.${metric}`;
    
    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        target,
        metric,
        values: [],
        tags
      });
    }
    
    const metricData = this.metrics.get(key);
    const dataPoint = {
      timestamp: Date.now(),
      value,
      tags
    };
    
    metricData.values.push(dataPoint);
    
    // Maintain window size
    const cutoff = Date.now() - this.options.aggregationWindow;
    metricData.values = metricData.values.filter(v => v.timestamp > cutoff);
    
    // Check if compression needed
    if (this.options.compressionEnabled && metricData.values.length > this.options.maxMetricsPerTarget) {
      this.compressMetrics(metricData);
    }
    
    this.systemMetrics.metricsCollected++;
    
    // Emit metric event
    this.emit('metric:recorded', {
      target,
      metric,
      value,
      timestamp: dataPoint.timestamp
    });
  }
  
  /**
   * Compress metrics using downsampling
   */
  compressMetrics(metricData) {
    const compressed = [];
    const bucketSize = Math.ceil(metricData.values.length / (this.options.maxMetricsPerTarget / 2));
    
    for (let i = 0; i < metricData.values.length; i += bucketSize) {
      const bucket = metricData.values.slice(i, i + bucketSize);
      
      compressed.push({
        timestamp: bucket[Math.floor(bucket.length / 2)].timestamp,
        value: bucket.reduce((sum, p) => sum + p.value, 0) / bucket.length,
        min: Math.min(...bucket.map(p => p.value)),
        max: Math.max(...bucket.map(p => p.value)),
        count: bucket.length
      });
    }
    
    metricData.values = compressed;
    metricData.compressed = true;
  }
  
  /**
   * Start monitoring loops
   */
  startMonitoring() {
    // Rule evaluation loop
    this.evaluationInterval = setInterval(() => {
      this.evaluateRules();
    }, this.options.metricsInterval);
    
    // Alert processing loop
    if (this.options.alertBatchingEnabled) {
      this.alertInterval = setInterval(() => {
        this.processPendingAlerts();
      }, 5000); // 5 seconds
    }
    
    // Metrics aggregation loop
    this.aggregationInterval = setInterval(() => {
      this.aggregateMetrics();
    }, this.options.aggregationWindow);
    
    logger.info('Monitoring loops started');
  }
  
  /**
   * Evaluate all active rules
   */
  evaluateRules() {
    const startTime = performance.now();
    
    for (const [ruleId, rule] of this.rules) {
      if (!rule.enabled) continue;
      
      try {
        this.evaluateRule(rule);
        this.systemMetrics.rulesEvaluated++;
      } catch (error) {
        logger.error(`Error evaluating rule ${ruleId}:`, error);
      }
    }
    
    // Update processing time
    const processingTime = performance.now() - startTime;
    this.systemMetrics.avgProcessingTime = 
      (this.systemMetrics.avgProcessingTime * 0.9) + (processingTime * 0.1);
  }
  
  /**
   * Evaluate single rule
   */
  evaluateRule(rule) {
    const key = `${rule.target}.${rule.metric}`;
    const metricData = this.metrics.get(key);
    
    if (!metricData || metricData.values.length === 0) {
      return;
    }
    
    // Get relevant values based on duration
    const cutoff = rule.duration ? Date.now() - rule.duration : 0;
    const relevantValues = metricData.values.filter(v => v.timestamp > cutoff);
    
    if (relevantValues.length === 0) return;
    
    // Calculate aggregate value
    const aggregateValue = this.calculateAggregate(relevantValues, rule.aggregation || 'avg');
    
    // Check condition
    const triggered = this.checkCondition(aggregateValue, rule.condition, rule.threshold);
    
    if (triggered) {
      this.handleTriggeredRule(rule, aggregateValue, metricData);
    } else if (rule.lastTriggered) {
      // Rule recovered
      this.handleRecoveredRule(rule);
    }
  }
  
  /**
   * Calculate aggregate value
   */
  calculateAggregate(values, method) {
    const nums = values.map(v => v.value);
    
    switch (method) {
      case 'avg':
        return nums.reduce((a, b) => a + b, 0) / nums.length;
      
      case 'sum':
        return nums.reduce((a, b) => a + b, 0);
      
      case 'min':
        return Math.min(...nums);
      
      case 'max':
        return Math.max(...nums);
      
      case 'p50':
        return this.percentile(nums, 0.5);
      
      case 'p95':
        return this.percentile(nums, 0.95);
      
      case 'p99':
        return this.percentile(nums, 0.99);
      
      default:
        return nums[nums.length - 1]; // Latest value
    }
  }
  
  /**
   * Check rule condition
   */
  checkCondition(value, condition, threshold) {
    switch (condition) {
      case 'greater_than':
        return value > threshold;
      
      case 'less_than':
        return value < threshold;
      
      case 'equals':
        return Math.abs(value - threshold) < 0.0001;
      
      case 'not_equals':
        return Math.abs(value - threshold) >= 0.0001;
      
      default:
        return false;
    }
  }
  
  /**
   * Handle triggered rule
   */
  handleTriggeredRule(rule, value, metricData) {
    // Check throttling
    if (this.isThrottled(rule.id)) {
      return;
    }
    
    // Update rule state
    rule.lastTriggered = Date.now();
    rule.triggerCount++;
    
    // Create alert
    const alert = {
      id: this.generateAlertId(),
      ruleId: rule.id,
      ruleName: rule.name,
      target: rule.target,
      metric: rule.metric,
      value,
      threshold: rule.threshold,
      severity: rule.severity,
      channels: rule.channels,
      timestamp: Date.now(),
      status: 'active',
      metadata: {
        condition: rule.condition,
        duration: rule.duration,
        samples: metricData.values.length
      }
    };
    
    // Store alert
    this.alerts.set(alert.id, alert);
    this.alertHistory.push(alert);
    
    // Update throttle
    this.alertThrottle.set(rule.id, Date.now());
    
    // Process alert
    if (this.options.alertBatchingEnabled) {
      this.pendingAlerts.push(alert);
    } else {
      this.sendAlert(alert);
    }
    
    this.systemMetrics.alertsGenerated++;
    
    // Emit alert event
    this.emit('alert:triggered', alert);
  }
  
  /**
   * Handle recovered rule
   */
  handleRecoveredRule(rule) {
    // Find active alerts for this rule
    const activeAlerts = Array.from(this.alerts.values()).filter(
      alert => alert.ruleId === rule.id && alert.status === 'active'
    );
    
    activeAlerts.forEach(alert => {
      alert.status = 'resolved';
      alert.resolvedAt = Date.now();
      
      // Send recovery notification
      const recoveryAlert = {
        ...alert,
        id: this.generateAlertId(),
        type: 'recovery',
        message: `${rule.name} has recovered`
      };
      
      if (this.options.alertBatchingEnabled) {
        this.pendingAlerts.push(recoveryAlert);
      } else {
        this.sendAlert(recoveryAlert);
      }
    });
    
    rule.lastTriggered = null;
  }
  
  /**
   * Check if rule is throttled
   */
  isThrottled(ruleId) {
    const lastAlert = this.alertThrottle.get(ruleId);
    if (!lastAlert) return false;
    
    return Date.now() - lastAlert < this.options.alertThrottleWindow;
  }
  
  /**
   * Process pending alerts
   */
  processPendingAlerts() {
    if (this.pendingAlerts.length === 0) return;
    
    // Group by severity and channel
    const groups = new Map();
    
    this.pendingAlerts.forEach(alert => {
      const key = `${alert.severity}_${alert.channels.join(',')}`;
      
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      
      groups.get(key).push(alert);
    });
    
    // Send batched alerts
    groups.forEach((alerts, key) => {
      if (alerts.length === 1) {
        this.sendAlert(alerts[0]);
      } else {
        this.sendBatchedAlerts(alerts);
      }
    });
    
    // Clear pending
    this.pendingAlerts = [];
  }
  
  /**
   * Send single alert
   */
  async sendAlert(alert) {
    for (const channel of alert.channels) {
      try {
        await this.sendToChannel(channel, alert);
        this.systemMetrics.alertsSent++;
      } catch (error) {
        logger.error(`Failed to send alert to ${channel}:`, error);
      }
    }
  }
  
  /**
   * Send batched alerts
   */
  async sendBatchedAlerts(alerts) {
    const summary = {
      count: alerts.length,
      severity: alerts[0].severity,
      channels: alerts[0].channels,
      alerts: alerts.map(a => ({
        rule: a.ruleName,
        value: a.value,
        threshold: a.threshold
      }))
    };
    
    for (const channel of alerts[0].channels) {
      try {
        await this.sendBatchToChannel(channel, summary);
        this.systemMetrics.alertsSent += alerts.length;
      } catch (error) {
        logger.error(`Failed to send batch to ${channel}:`, error);
      }
    }
  }
  
  /**
   * Send alert to specific channel
   */
  async sendToChannel(channel, alert) {
    const config = this.options.channelConfigs[channel] || {};
    
    switch (channel) {
      case CHANNELS.LOG:
        logger.warn(`ALERT: ${alert.ruleName} - ${alert.value} ${alert.condition} ${alert.threshold}`);
        break;
        
      case CHANNELS.EMAIL:
        await this.sendEmail(config, alert);
        break;
        
      case CHANNELS.SMS:
        await this.sendSMS(config, alert);
        break;
        
      case CHANNELS.SLACK:
        await this.sendSlack(config, alert);
        break;
        
      case CHANNELS.WEBHOOK:
        await this.sendWebhook(config, alert);
        break;
        
      case CHANNELS.PAGERDUTY:
        await this.sendPagerDuty(config, alert);
        break;
    }
  }
  
  /**
   * Setup alert channels
   */
  async setupAlertChannels() {
    // Validate channel configurations
    for (const channel of this.options.enabledChannels) {
      const config = this.options.channelConfigs[channel];
      
      if (!config && channel !== CHANNELS.LOG) {
        logger.warn(`No configuration for channel: ${channel}`);
      }
    }
  }
  
  /**
   * Channel implementations (simplified)
   */
  
  async sendEmail(config, alert) {
    logger.info(`[EMAIL] Would send to ${config.to}: ${alert.ruleName}`);
    // Implementation would use nodemailer or similar
  }
  
  async sendSMS(config, alert) {
    logger.info(`[SMS] Would send to ${config.to}: ${alert.ruleName}`);
    // Implementation would use Twilio or similar
  }
  
  async sendSlack(config, alert) {
    logger.info(`[SLACK] Would send to ${config.webhook}: ${alert.ruleName}`);
    // Implementation would use Slack webhook
  }
  
  async sendWebhook(config, alert) {
    logger.info(`[WEBHOOK] Would POST to ${config.url}`);
    // Implementation would use fetch/axios
  }
  
  async sendPagerDuty(config, alert) {
    logger.info(`[PAGERDUTY] Would create incident: ${alert.ruleName}`);
    // Implementation would use PagerDuty API
  }
  
  /**
   * Aggregate metrics
   */
  aggregateMetrics() {
    for (const [key, metricData] of this.metrics) {
      if (metricData.values.length < 2) continue;
      
      // Calculate aggregates
      const values = metricData.values.map(v => v.value);
      
      const aggregates = {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((a, b) => a + b, 0) / values.length,
        p50: this.percentile(values, 0.5),
        p95: this.percentile(values, 0.95),
        p99: this.percentile(values, 0.99)
      };
      
      // Store aggregates
      this.recordMetric(
        metricData.target,
        `${metricData.metric}_aggregates`,
        aggregates,
        { period: this.options.aggregationWindow }
      );
    }
  }
  
  /**
   * Calculate percentile
   */
  percentile(values, p) {
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[index];
  }
  
  /**
   * Public API methods
   */
  
  /**
   * Record custom metric
   */
  metric(target, name, value, tags) {
    this.recordMetric(target, name, value, tags);
  }
  
  /**
   * Create custom alert
   */
  alert(options) {
    const alert = {
      id: this.generateAlertId(),
      ...options,
      timestamp: Date.now(),
      status: 'active'
    };
    
    this.alerts.set(alert.id, alert);
    
    if (this.options.alertBatchingEnabled) {
      this.pendingAlerts.push(alert);
    } else {
      this.sendAlert(alert);
    }
    
    return alert.id;
  }
  
  /**
   * Get current metrics
   */
  getMetrics(target, metric) {
    if (target && metric) {
      const key = `${target}.${metric}`;
      return this.metrics.get(key);
    }
    
    if (target) {
      const targetMetrics = {};
      
      for (const [key, data] of this.metrics) {
        if (data.target === target) {
          targetMetrics[data.metric] = data;
        }
      }
      
      return targetMetrics;
    }
    
    return Object.fromEntries(this.metrics);
  }
  
  /**
   * Get active alerts
   */
  getActiveAlerts() {
    return Array.from(this.alerts.values()).filter(
      alert => alert.status === 'active'
    );
  }
  
  /**
   * Get alert history
   */
  getAlertHistory(limit = 100) {
    return this.alertHistory.slice(-limit);
  }
  
  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      healthy: true,
      metrics: {
        total: this.metrics.size,
        collected: this.systemMetrics.metricsCollected
      },
      alerts: {
        active: this.getActiveAlerts().length,
        total: this.systemMetrics.alertsGenerated,
        sent: this.systemMetrics.alertsSent
      },
      rules: {
        total: this.rules.size,
        enabled: Array.from(this.rules.values()).filter(r => r.enabled).length,
        evaluated: this.systemMetrics.rulesEvaluated
      },
      performance: {
        avgProcessingTime: `${this.systemMetrics.avgProcessingTime.toFixed(2)}ms`
      }
    };
  }
  
  /**
   * Update rule
   */
  updateRule(ruleId, updates) {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    
    Object.assign(rule, updates);
    
    logger.info(`Updated rule: ${ruleId}`);
  }
  
  /**
   * Enable/disable rule
   */
  toggleRule(ruleId, enabled) {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new Error(`Rule not found: ${ruleId}`);
    }
    
    rule.enabled = enabled;
    
    logger.info(`Rule ${ruleId} ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Generate alert ID
   */
  generateAlertId() {
    return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Cleanup old data
   */
  cleanup() {
    const cutoff = Date.now() - this.options.retentionPeriod;
    
    // Clean metrics
    for (const [key, metricData] of this.metrics) {
      metricData.values = metricData.values.filter(v => v.timestamp > cutoff);
      
      if (metricData.values.length === 0) {
        this.metrics.delete(key);
      }
    }
    
    // Clean alerts
    this.alertHistory = this.alertHistory.filter(a => a.timestamp > cutoff);
    
    logger.debug('Cleaned up old monitoring data');
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    // Clear intervals
    if (this.evaluationInterval) clearInterval(this.evaluationInterval);
    if (this.alertInterval) clearInterval(this.alertInterval);
    if (this.aggregationInterval) clearInterval(this.aggregationInterval);
    
    // Stop collectors
    for (const collector of this.collectors.values()) {
      if (collector.interval) clearInterval(collector.interval);
    }
    
    logger.info('Monitoring system stopped');
  }
}

module.exports = UnifiedMonitoringSystem;