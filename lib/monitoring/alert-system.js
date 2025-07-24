/**
 * Advanced Alert System
 * Comprehensive monitoring and alerting for mining pool operations
 */

const EventEmitter = require('events');
const crypto = require('crypto');

// Alert severity levels
const AlertSeverity = {
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  CRITICAL: 4
};

// Alert categories
const AlertCategory = {
  PERFORMANCE: 'performance',
  SECURITY: 'security',
  SYSTEM: 'system',
  MINING: 'mining',
  PAYMENT: 'payment',
  NETWORK: 'network',
  DATABASE: 'database'
};

class AdvancedAlertSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Alert thresholds
      thresholds: {
        cpuUsage: options.thresholds?.cpuUsage || 85,
        memoryUsage: options.thresholds?.memoryUsage || 85,
        diskUsage: options.thresholds?.diskUsage || 90,
        hashrateDropPercent: options.thresholds?.hashrateDropPercent || 20,
        shareRejectionRate: options.thresholds?.shareRejectionRate || 5,
        ...options.thresholds
      },
      
      // Alert channels
      channels: {
        console: options.channels?.console !== false,
        webhook: options.channels?.webhook || false,
        ...options.channels
      },
      
      cooldownPeriod: options.cooldownPeriod || 300000, // 5 minutes
      monitoringInterval: options.monitoringInterval || 30000, // 30 seconds
      
      ...options
    };
    
    this.alerts = new Map();
    this.alertHistory = [];
    this.cooldowns = new Map();
    this.rules = new Map();
    this.initialized = false;
  }
  
  async initialize() {
    if (this.initialized) return;
    
    this.initializeDefaultRules();
    this.initialized = true;
    this.emit('initialized');
    
    console.log('Advanced alert system initialized');
  }
  
  initializeDefaultRules() {
    this.addRule('high_cpu_usage', {
      category: AlertCategory.PERFORMANCE,
      severity: AlertSeverity.WARNING,
      condition: (metrics) => metrics.cpu?.usage > this.config.thresholds.cpuUsage,
      message: (metrics) => `High CPU usage: ${metrics.cpu.usage.toFixed(1)}%`,
      cooldown: 300000
    });
  }
  
  addRule(id, rule) {
    this.rules.set(id, {
      id,
      category: rule.category,
      severity: rule.severity,
      condition: rule.condition,
      message: rule.message,
      cooldown: rule.cooldown || this.config.cooldownPeriod,
      enabled: rule.enabled !== false
    });
  }
  
  async triggerAlert(ruleId, rule, metrics) {
    const alert = {
      id: this.generateAlertId(ruleId, rule.category),
      ruleId,
      timestamp: Date.now(),
      severity: rule.severity,
      category: rule.category,
      title: `${rule.category.toUpperCase()}: ${ruleId.replace('_', ' ')}`,
      message: typeof rule.message === 'function' ? rule.message(metrics) : rule.message,
      source: 'monitoring'
    };
    
    await this.sendAlert(alert);
    this.emit('alert', alert);
  }
  
  async sendAlert(alert) {
    if (this.config.channels.console) {
      this.sendConsoleAlert(alert);
    }
  }
  
  sendConsoleAlert(alert) {
    const severity = Object.keys(AlertSeverity)[alert.severity - 1];
    const timestamp = new Date(alert.timestamp).toISOString();
    
    console.log(`\n🚨 ALERT [${severity}] - ${alert.category.toUpperCase()}`);
    console.log(`Time: ${timestamp}`);
    console.log(`Title: ${alert.title}`);
    console.log(`Message: ${alert.message}`);
    console.log(`ID: ${alert.id}\n`);
  }
  
  generateAlertId(ruleId, category) {
    const data = `${ruleId}:${category}:${Date.now()}:${Math.random()}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);
  }
  
  getStatus() {
    return {
      initialized: this.initialized,
      activeRules: this.rules.size
    };
  }
  
  async shutdown() {
    console.log('Shutting down alert system...');
    this.initialized = false;
    this.emit('shutdown');
  }
}

module.exports = {
  AdvancedAlertSystem,
  AlertSeverity,
  AlertCategory
};