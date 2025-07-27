/**
 * Exchange Rate Monitor
 * Monitors cryptocurrency exchange rates and alerts on significant changes
 * 
 * Features:
 * - Real-time rate monitoring
 * - Anomaly detection
 * - Service health checks
 * - Alert notifications
 */

import { createLogger } from '../core/logger.js';
import { EventEmitter } from 'events';

const logger = createLogger('RateMonitor');

/**
 * Alert types
 */
export const AlertType = {
  RATE_SPIKE: 'rate_spike',
  RATE_DROP: 'rate_drop',
  SERVICE_DOWN: 'service_down',
  SERVICE_DEGRADED: 'service_degraded',
  HIGH_SPREAD: 'high_spread',
  CONVERSION_FAILED: 'conversion_failed'
};

/**
 * Rate Monitor
 */
export class RateMonitor extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Monitoring intervals
      checkInterval: config.checkInterval || 60000, // 1 minute
      alertThreshold: config.alertThreshold || 0.05, // 5% change triggers alert
      
      // Service health
      maxResponseTime: config.maxResponseTime || 5000, // 5 seconds
      maxFailures: config.maxFailures || 3,
      
      // Rate tracking
      historySize: config.historySize || 100,
      anomalyDetection: config.anomalyDetection !== false,
      
      // Alert settings
      alertCooldown: config.alertCooldown || 300000, // 5 minutes
      notificationWebhook: config.notificationWebhook || process.env.WEBHOOK_URL,
      telegramEnabled: config.telegramEnabled || !!process.env.TELEGRAM_BOT_TOKEN
    };
    
    // State
    this.rateHistory = new Map();
    this.serviceHealth = new Map();
    this.lastAlerts = new Map();
    this.isMonitoring = false;
    
    // Timers
    this.monitorTimer = null;
    
    // Statistics
    this.stats = {
      checksPerformed: 0,
      alertsSent: 0,
      anomaliesDetected: 0,
      serviceFailures: 0
    };
  }
  
  /**
   * Start monitoring
   */
  start(externalConverter) {
    if (this.isMonitoring) {
      logger.warn('Rate monitor already running');
      return;
    }
    
    this.externalConverter = externalConverter;
    this.isMonitoring = true;
    
    logger.info('Starting rate monitor...');
    
    // Initial check
    this.performCheck();
    
    // Start periodic monitoring
    this.monitorTimer = setInterval(() => {
      this.performCheck();
    }, this.config.checkInterval);
    
    this.emit('started');
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    if (!this.isMonitoring) return;
    
    logger.info('Stopping rate monitor...');
    
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    
    this.isMonitoring = false;
    this.emit('stopped');
  }
  
  /**
   * Perform monitoring check
   */
  async performCheck() {
    this.stats.checksPerformed++;
    
    const checkResults = {
      timestamp: Date.now(),
      rates: new Map(),
      serviceStatus: new Map(),
      alerts: []
    };
    
    // Check each service
    for (const [serviceId, service] of this.externalConverter.services) {
      try {
        const startTime = Date.now();
        
        // Get sample rates for major pairs
        const pairs = [
          { from: 'ETH', to: 'BTC' },
          { from: 'LTC', to: 'BTC' },
          { from: 'BCH', to: 'BTC' }
        ];
        
        for (const pair of pairs) {
          try {
            const rate = await this.externalConverter.getServiceRate(
              serviceId,
              pair.from,
              pair.to,
              1
            );
            
            if (rate) {
              const rateKey = `${serviceId}:${pair.from}:${pair.to}`;
              checkResults.rates.set(rateKey, rate);
              
              // Check for anomalies
              this.checkRateAnomaly(rateKey, rate);
            }
          } catch (error) {
            logger.error(`Rate check failed for ${serviceId}:`, error);
          }
        }
        
        const responseTime = Date.now() - startTime;
        
        // Update service health
        this.updateServiceHealth(serviceId, true, responseTime);
        checkResults.serviceStatus.set(serviceId, {
          healthy: true,
          responseTime
        });
        
      } catch (error) {
        logger.error(`Service check failed for ${serviceId}:`, error);
        
        // Update service health
        this.updateServiceHealth(serviceId, false);
        checkResults.serviceStatus.set(serviceId, {
          healthy: false,
          error: error.message
        });
        
        // Create alert
        const alert = {
          type: AlertType.SERVICE_DOWN,
          service: serviceId,
          message: `Service ${serviceId} is not responding`,
          timestamp: Date.now()
        };
        
        if (this.shouldSendAlert(alert)) {
          checkResults.alerts.push(alert);
          await this.sendAlert(alert);
        }
      }
    }
    
    // Check for high spreads
    this.checkSpreads(checkResults.rates);
    
    // Emit check results
    this.emit('check:completed', checkResults);
    
    // Log summary
    const healthyServices = Array.from(checkResults.serviceStatus.values())
      .filter(s => s.healthy).length;
    
    logger.debug(`Rate check completed: ${healthyServices}/${checkResults.serviceStatus.size} services healthy`);
  }
  
  /**
   * Check for rate anomalies
   */
  checkRateAnomaly(rateKey, currentRate) {
    if (!this.config.anomalyDetection) return;
    
    // Get rate history
    let history = this.rateHistory.get(rateKey);
    if (!history) {
      history = [];
      this.rateHistory.set(rateKey, history);
    }
    
    // Add current rate to history
    history.push({
      rate: currentRate.rate,
      timestamp: Date.now()
    });
    
    // Limit history size
    if (history.length > this.config.historySize) {
      history.shift();
    }
    
    // Need at least 10 data points for analysis
    if (history.length < 10) return;
    
    // Calculate average rate
    const avgRate = history.reduce((sum, h) => sum + h.rate, 0) / history.length;
    
    // Check for significant deviation
    const deviation = Math.abs(currentRate.rate - avgRate) / avgRate;
    
    if (deviation > this.config.alertThreshold) {
      this.stats.anomaliesDetected++;
      
      const alert = {
        type: currentRate.rate > avgRate ? AlertType.RATE_SPIKE : AlertType.RATE_DROP,
        pair: rateKey,
        currentRate: currentRate.rate,
        averageRate: avgRate,
        deviation: deviation * 100,
        message: `Rate ${currentRate.rate > avgRate ? 'spike' : 'drop'} detected: ${(deviation * 100).toFixed(2)}% change`,
        timestamp: Date.now()
      };
      
      if (this.shouldSendAlert(alert)) {
        this.sendAlert(alert);
      }
    }
  }
  
  /**
   * Check for high spreads between services
   */
  checkSpreads(rates) {
    // Group rates by pair
    const pairRates = new Map();
    
    for (const [key, rate] of rates) {
      const [service, from, to] = key.split(':');
      const pairKey = `${from}:${to}`;
      
      if (!pairRates.has(pairKey)) {
        pairRates.set(pairKey, []);
      }
      
      pairRates.get(pairKey).push({
        service,
        rate: rate.effectiveRate || rate.rate
      });
    }
    
    // Check spread for each pair
    for (const [pair, serviceRates] of pairRates) {
      if (serviceRates.length < 2) continue;
      
      const rates = serviceRates.map(s => s.rate);
      const minRate = Math.min(...rates);
      const maxRate = Math.max(...rates);
      const spread = (maxRate - minRate) / minRate;
      
      // Alert if spread > 2%
      if (spread > 0.02) {
        const alert = {
          type: AlertType.HIGH_SPREAD,
          pair,
          spread: spread * 100,
          services: serviceRates,
          message: `High spread detected for ${pair}: ${(spread * 100).toFixed(2)}%`,
          timestamp: Date.now()
        };
        
        if (this.shouldSendAlert(alert)) {
          this.sendAlert(alert);
        }
      }
    }
  }
  
  /**
   * Update service health
   */
  updateServiceHealth(serviceId, isHealthy, responseTime = null) {
    let health = this.serviceHealth.get(serviceId);
    
    if (!health) {
      health = {
        healthy: true,
        failures: 0,
        lastCheck: Date.now(),
        avgResponseTime: 0,
        checks: 0
      };
      this.serviceHealth.set(serviceId, health);
    }
    
    health.lastCheck = Date.now();
    health.checks++;
    
    if (isHealthy) {
      health.healthy = true;
      health.failures = 0;
      
      if (responseTime) {
        health.avgResponseTime = (health.avgResponseTime * (health.checks - 1) + responseTime) / health.checks;
      }
    } else {
      health.failures++;
      
      if (health.failures >= this.config.maxFailures) {
        health.healthy = false;
        this.stats.serviceFailures++;
      }
    }
    
    // Check for degraded performance
    if (health.avgResponseTime > this.config.maxResponseTime) {
      const alert = {
        type: AlertType.SERVICE_DEGRADED,
        service: serviceId,
        avgResponseTime: health.avgResponseTime,
        message: `Service ${serviceId} is responding slowly: ${health.avgResponseTime}ms average`,
        timestamp: Date.now()
      };
      
      if (this.shouldSendAlert(alert)) {
        this.sendAlert(alert);
      }
    }
  }
  
  /**
   * Check if alert should be sent
   */
  shouldSendAlert(alert) {
    const alertKey = `${alert.type}:${alert.service || alert.pair || 'global'}`;
    const lastAlert = this.lastAlerts.get(alertKey);
    
    if (!lastAlert || Date.now() - lastAlert > this.config.alertCooldown) {
      this.lastAlerts.set(alertKey, Date.now());
      return true;
    }
    
    return false;
  }
  
  /**
   * Send alert
   */
  async sendAlert(alert) {
    this.stats.alertsSent++;
    
    logger.warn('Alert triggered:', alert);
    
    // Emit alert event
    this.emit('alert', alert);
    
    // Send webhook notification
    if (this.config.notificationWebhook) {
      try {
        await fetch(this.config.notificationWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'rate_monitor_alert',
            alert,
            pool: 'Otedama',
            timestamp: Date.now()
          })
        });
      } catch (error) {
        logger.error('Failed to send webhook notification:', error);
      }
    }
    
    // Send Telegram notification
    if (this.config.telegramEnabled) {
      await this.sendTelegramAlert(alert);
    }
  }
  
  /**
   * Send Telegram alert
   */
  async sendTelegramAlert(alert) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    
    if (!botToken || !chatId) return;
    
    const message = `🚨 *Otedama Pool Alert*\n\n` +
      `*Type:* ${alert.type}\n` +
      `*Message:* ${alert.message}\n` +
      `*Time:* ${new Date(alert.timestamp).toISOString()}`;
    
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'Markdown'
        })
      });
    } catch (error) {
      logger.error('Failed to send Telegram alert:', error);
    }
  }
  
  /**
   * Get monitoring statistics
   */
  getStats() {
    const serviceStatuses = {};
    
    for (const [serviceId, health] of this.serviceHealth) {
      serviceStatuses[serviceId] = {
        healthy: health.healthy,
        uptime: health.checks > 0 ? ((health.checks - health.failures) / health.checks * 100) : 0,
        avgResponseTime: health.avgResponseTime,
        lastCheck: health.lastCheck
      };
    }
    
    return {
      ...this.stats,
      isMonitoring: this.isMonitoring,
      serviceStatuses,
      rateHistorySize: this.rateHistory.size,
      recentAlerts: Array.from(this.lastAlerts.entries()).map(([key, time]) => ({
        alert: key,
        lastSent: time
      }))
    };
  }
  
  /**
   * Get current rates
   */
  getCurrentRates() {
    const rates = {};
    
    for (const [key, history] of this.rateHistory) {
      if (history.length > 0) {
        const latest = history[history.length - 1];
        rates[key] = latest.rate;
      }
    }
    
    return rates;
  }
}

export default RateMonitor;