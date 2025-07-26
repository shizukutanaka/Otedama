/**
 * Hardware Health Monitor - Otedama
 * Real-time monitoring of mining hardware health and performance
 * 
 * Design Principles:
 * - Carmack: Low-overhead monitoring with predictive analytics
 * - Martin: Clean separation of hardware interfaces
 * - Pike: Simple alerts for complex hardware states
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('HardwareHealthMonitor');

/**
 * Hardware types
 */
const HARDWARE_TYPES = {
  GPU: 'gpu',
  ASIC: 'asic',
  FPGA: 'fpga',
  CPU: 'cpu'
};

/**
 * Health metrics
 */
const HEALTH_METRICS = {
  TEMPERATURE: 'temperature',
  FAN_SPEED: 'fan_speed',
  POWER_USAGE: 'power_usage',
  MEMORY_USAGE: 'memory_usage',
  HASHRATE: 'hashrate',
  ERROR_RATE: 'error_rate',
  VOLTAGE: 'voltage',
  FREQUENCY: 'frequency'
};

/**
 * Alert levels
 */
const ALERT_LEVELS = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
  EMERGENCY: 'emergency'
};

/**
 * Health status
 */
const HEALTH_STATUS = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  CRITICAL: 'critical',
  FAILED: 'failed',
  OFFLINE: 'offline'
};

/**
 * Hardware thresholds
 */
const DEFAULT_THRESHOLDS = {
  gpu: {
    temperature: { warning: 75, critical: 85, emergency: 95 },
    fanSpeed: { warning: 80, critical: 90, emergency: 95 },
    powerUsage: { warning: 90, critical: 100, emergency: 110 }, // percentage
    memoryUsage: { warning: 85, critical: 95, emergency: 98 },
    errorRate: { warning: 0.01, critical: 0.05, emergency: 0.1 }
  },
  asic: {
    temperature: { warning: 80, critical: 90, emergency: 100 },
    fanSpeed: { warning: 85, critical: 95, emergency: 100 },
    powerUsage: { warning: 95, critical: 105, emergency: 110 },
    errorRate: { warning: 0.001, critical: 0.01, emergency: 0.05 }
  }
};

/**
 * Hardware device representation
 */
class HardwareDevice {
  constructor(id, type, config = {}) {
    this.id = id;
    this.type = type;
    this.name = config.name || `${type}-${id}`;
    this.model = config.model || 'Unknown';
    
    this.thresholds = {
      ...DEFAULT_THRESHOLDS[type] || DEFAULT_THRESHOLDS.gpu,
      ...config.thresholds
    };
    
    this.metrics = {
      temperature: 0,
      fanSpeed: 0,
      powerUsage: 0,
      memoryUsage: 0,
      hashrate: 0,
      errorRate: 0,
      voltage: 0,
      frequency: 0
    };
    
    this.history = new Map();
    this.status = HEALTH_STATUS.HEALTHY;
    this.lastUpdate = Date.now();
    this.alerts = new Map();
    
    // Initialize history buffers
    for (const metric of Object.values(HEALTH_METRICS)) {
      this.history.set(metric, []);
    }
  }
  
  updateMetric(metric, value) {
    this.metrics[metric] = value;
    this.lastUpdate = Date.now();
    
    // Add to history
    const history = this.history.get(metric);
    if (history) {
      history.push({
        value,
        timestamp: Date.now()
      });
      
      // Keep last 1000 entries
      if (history.length > 1000) {
        history.shift();
      }
    }
    
    // Check thresholds
    this.checkThreshold(metric, value);
  }
  
  checkThreshold(metric, value) {
    const threshold = this.thresholds[metric];
    if (!threshold) return;
    
    let level = null;
    let message = '';
    
    if (value >= threshold.emergency) {
      level = ALERT_LEVELS.EMERGENCY;
      message = `${metric} at emergency level: ${value}`;
    } else if (value >= threshold.critical) {
      level = ALERT_LEVELS.CRITICAL;
      message = `${metric} at critical level: ${value}`;
    } else if (value >= threshold.warning) {
      level = ALERT_LEVELS.WARNING;
      message = `${metric} at warning level: ${value}`;
    }
    
    if (level) {
      this.alerts.set(metric, {
        level,
        message,
        value,
        threshold: threshold[level],
        timestamp: Date.now()
      });
    } else {
      this.alerts.delete(metric);
    }
  }
  
  getStatus() {
    // Determine overall status based on alerts
    let maxSeverity = 0;
    
    for (const alert of this.alerts.values()) {
      switch (alert.level) {
        case ALERT_LEVELS.EMERGENCY:
          maxSeverity = Math.max(maxSeverity, 4);
          break;
        case ALERT_LEVELS.CRITICAL:
          maxSeverity = Math.max(maxSeverity, 3);
          break;
        case ALERT_LEVELS.WARNING:
          maxSeverity = Math.max(maxSeverity, 2);
          break;
        case ALERT_LEVELS.INFO:
          maxSeverity = Math.max(maxSeverity, 1);
          break;
      }
    }
    
    // Check if offline
    if (Date.now() - this.lastUpdate > 60000) {
      this.status = HEALTH_STATUS.OFFLINE;
    } else if (maxSeverity >= 4) {
      this.status = HEALTH_STATUS.FAILED;
    } else if (maxSeverity >= 3) {
      this.status = HEALTH_STATUS.CRITICAL;
    } else if (maxSeverity >= 2) {
      this.status = HEALTH_STATUS.DEGRADED;
    } else {
      this.status = HEALTH_STATUS.HEALTHY;
    }
    
    return this.status;
  }
  
  getMetricAverage(metric, duration = 300000) { // 5 minutes default
    const history = this.history.get(metric);
    if (!history || history.length === 0) return 0;
    
    const cutoff = Date.now() - duration;
    const recent = history.filter(h => h.timestamp > cutoff);
    
    if (recent.length === 0) return 0;
    
    return recent.reduce((sum, h) => sum + h.value, 0) / recent.length;
  }
  
  getMetricTrend(metric, duration = 300000) {
    const history = this.history.get(metric);
    if (!history || history.length < 2) return 0;
    
    const cutoff = Date.now() - duration;
    const recent = history.filter(h => h.timestamp > cutoff);
    
    if (recent.length < 2) return 0;
    
    // Simple linear regression
    const n = recent.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    recent.forEach((h, i) => {
      sumX += i;
      sumY += h.value;
      sumXY += i * h.value;
      sumX2 += i * i;
    });
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }
}

/**
 * Predictive analytics engine
 */
class PredictiveAnalytics {
  constructor(config = {}) {
    this.config = {
      predictionWindow: config.predictionWindow || 3600000, // 1 hour
      failureProbabilityThreshold: config.failureProbabilityThreshold || 0.7,
      ...config
    };
    
    this.models = new Map();
    this.predictions = new Map();
  }
  
  trainModel(deviceId, historicalData) {
    // Simplified failure prediction model
    const model = {
      deviceId,
      trained: Date.now(),
      patterns: this.extractPatterns(historicalData)
    };
    
    this.models.set(deviceId, model);
  }
  
  extractPatterns(data) {
    const patterns = {
      temperatureSpikes: 0,
      fanFailures: 0,
      powerAnomalies: 0,
      correlations: {}
    };
    
    // Analyze temperature spikes
    const tempHistory = data.temperature || [];
    for (let i = 1; i < tempHistory.length; i++) {
      const delta = tempHistory[i].value - tempHistory[i-1].value;
      if (delta > 10) { // 10 degree spike
        patterns.temperatureSpikes++;
      }
    }
    
    // Analyze fan behavior
    const fanHistory = data.fanSpeed || [];
    const avgFanSpeed = fanHistory.reduce((sum, h) => sum + h.value, 0) / fanHistory.length;
    patterns.fanFailures = fanHistory.filter(h => h.value < avgFanSpeed * 0.5).length;
    
    return patterns;
  }
  
  predictFailure(device) {
    const model = this.models.get(device.id);
    if (!model) {
      // Use simple heuristics if no model
      return this.heuristicPrediction(device);
    }
    
    // Model-based prediction
    const currentPatterns = this.extractPatterns(device.history);
    
    let riskScore = 0;
    
    // Temperature risk
    const tempTrend = device.getMetricTrend(HEALTH_METRICS.TEMPERATURE);
    if (tempTrend > 0.1) { // Rising temperature
      riskScore += 0.3;
    }
    
    // Fan speed risk
    const fanAvg = device.getMetricAverage(HEALTH_METRICS.FAN_SPEED);
    if (fanAvg > 85) {
      riskScore += 0.2;
    }
    
    // Error rate risk
    const errorRate = device.metrics.errorRate;
    if (errorRate > 0.01) {
      riskScore += 0.3;
    }
    
    // Pattern matching
    if (currentPatterns.temperatureSpikes > model.patterns.temperatureSpikes * 1.5) {
      riskScore += 0.2;
    }
    
    const prediction = {
      deviceId: device.id,
      failureProbability: Math.min(riskScore, 1.0),
      estimatedTimeToFailure: riskScore > 0.5 ? this.estimateTimeToFailure(device, riskScore) : null,
      recommendedActions: this.getRecommendedActions(device, riskScore),
      confidence: model ? 0.8 : 0.5
    };
    
    this.predictions.set(device.id, prediction);
    
    return prediction;
  }
  
  heuristicPrediction(device) {
    let riskScore = 0;
    
    // Temperature above critical
    if (device.metrics.temperature > device.thresholds.temperature.critical) {
      riskScore += 0.4;
    }
    
    // High error rate
    if (device.metrics.errorRate > 0.05) {
      riskScore += 0.3;
    }
    
    // Fan at max speed
    if (device.metrics.fanSpeed > 90) {
      riskScore += 0.2;
    }
    
    // Power anomaly
    if (device.metrics.powerUsage > device.thresholds.powerUsage.critical) {
      riskScore += 0.1;
    }
    
    return {
      deviceId: device.id,
      failureProbability: Math.min(riskScore, 1.0),
      estimatedTimeToFailure: riskScore > 0.5 ? 3600000 / riskScore : null, // Simple estimate
      recommendedActions: this.getRecommendedActions(device, riskScore),
      confidence: 0.5
    };
  }
  
  estimateTimeToFailure(device, riskScore) {
    // Estimate based on temperature trend and risk score
    const tempTrend = device.getMetricTrend(HEALTH_METRICS.TEMPERATURE);
    
    if (tempTrend <= 0) {
      return null; // Temperature not rising
    }
    
    const currentTemp = device.metrics.temperature;
    const criticalTemp = device.thresholds.temperature.emergency;
    const tempDelta = criticalTemp - currentTemp;
    
    if (tempDelta <= 0) {
      return 0; // Already at critical
    }
    
    // Time = delta / rate, adjusted by risk score
    const baseTime = (tempDelta / tempTrend) * 60000; // Convert to ms
    return baseTime / riskScore;
  }
  
  getRecommendedActions(device, riskScore) {
    const actions = [];
    
    if (device.metrics.temperature > device.thresholds.temperature.warning) {
      actions.push({
        action: 'reduce_power',
        urgency: riskScore > 0.7 ? 'immediate' : 'soon',
        description: 'Reduce power limit to lower temperature'
      });
    }
    
    if (device.metrics.fanSpeed > 85) {
      actions.push({
        action: 'clean_cooling',
        urgency: 'soon',
        description: 'Clean dust filters and heatsinks'
      });
    }
    
    if (device.metrics.errorRate > 0.01) {
      actions.push({
        action: 'reduce_overclock',
        urgency: 'immediate',
        description: 'Reduce memory/core overclock'
      });
    }
    
    if (riskScore > 0.8) {
      actions.push({
        action: 'shutdown',
        urgency: 'immediate',
        description: 'Shutdown device to prevent damage'
      });
    }
    
    return actions;
  }
}

/**
 * Hardware Health Monitor
 */
export class HardwareHealthMonitor extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Monitoring settings
      pollInterval: config.pollInterval || 5000, // 5 seconds
      historyRetention: config.historyRetention || 86400000, // 24 hours
      
      // Alert settings
      alertThrottleTime: config.alertThrottleTime || 300000, // 5 minutes
      enablePredictiveAnalytics: config.enablePredictiveAnalytics !== false,
      
      // Auto-protection
      enableAutoProtection: config.enableAutoProtection !== false,
      autoShutdownThreshold: config.autoShutdownThreshold || 0.9,
      autoPowerLimitReduction: config.autoPowerLimitReduction || 0.8,
      
      // Reporting
      reportInterval: config.reportInterval || 60000, // 1 minute
      
      ...config
    };
    
    // Hardware devices
    this.devices = new Map();
    
    // Components
    this.predictiveAnalytics = new PredictiveAnalytics(config);
    
    // Alert management
    this.alertHistory = [];
    this.alertThrottle = new Map();
    
    // Statistics
    this.stats = {
      totalDevices: 0,
      healthyDevices: 0,
      degradedDevices: 0,
      criticalDevices: 0,
      failedDevices: 0,
      totalAlerts: 0,
      predictionsGenerated: 0,
      autoProtectionEvents: 0
    };
    
    this.logger = logger;
  }
  
  /**
   * Initialize hardware monitoring
   */
  async initialize() {
    // Detect hardware devices
    await this.detectHardware();
    
    // Start monitoring
    this.startMonitoring();
    
    // Start predictive analytics if enabled
    if (this.config.enablePredictiveAnalytics) {
      this.startPredictiveAnalytics();
    }
    
    // Start reporting
    this.startReporting();
    
    this.logger.info('Hardware health monitor initialized', {
      devices: this.devices.size,
      predictiveAnalytics: this.config.enablePredictiveAnalytics
    });
  }
  
  /**
   * Detect available hardware
   */
  async detectHardware() {
    // Simulate hardware detection
    const detectedDevices = [
      { id: 'gpu0', type: HARDWARE_TYPES.GPU, model: 'RTX 3090' },
      { id: 'gpu1', type: HARDWARE_TYPES.GPU, model: 'RTX 3080' },
      { id: 'asic0', type: HARDWARE_TYPES.ASIC, model: 'Antminer S19' }
    ];
    
    for (const deviceInfo of detectedDevices) {
      const device = new HardwareDevice(
        deviceInfo.id,
        deviceInfo.type,
        { model: deviceInfo.model }
      );
      
      this.devices.set(deviceInfo.id, device);
    }
    
    this.stats.totalDevices = this.devices.size;
    
    this.emit('hardware:detected', {
      devices: detectedDevices
    });
  }
  
  /**
   * Add custom hardware device
   */
  addDevice(id, type, config = {}) {
    if (this.devices.has(id)) {
      throw new Error(`Device ${id} already exists`);
    }
    
    const device = new HardwareDevice(id, type, config);
    this.devices.set(id, device);
    this.stats.totalDevices++;
    
    this.emit('device:added', {
      id,
      type,
      name: device.name
    });
    
    return device;
  }
  
  /**
   * Remove hardware device
   */
  removeDevice(id) {
    const device = this.devices.get(id);
    if (!device) return;
    
    this.devices.delete(id);
    this.stats.totalDevices--;
    
    this.emit('device:removed', {
      id,
      name: device.name
    });
  }
  
  /**
   * Update device metrics
   */
  updateDeviceMetrics(deviceId, metrics) {
    const device = this.devices.get(deviceId);
    if (!device) {
      this.logger.warn('Unknown device', { deviceId });
      return;
    }
    
    // Update each metric
    for (const [metric, value] of Object.entries(metrics)) {
      device.updateMetric(metric, value);
    }
    
    // Check health status
    const previousStatus = device.status;
    const currentStatus = device.getStatus();
    
    if (currentStatus !== previousStatus) {
      this.handleStatusChange(device, previousStatus, currentStatus);
    }
    
    // Check for alerts
    this.checkDeviceAlerts(device);
    
    // Auto-protection if enabled
    if (this.config.enableAutoProtection) {
      this.checkAutoProtection(device);
    }
  }
  
  /**
   * Handle device status change
   */
  handleStatusChange(device, previousStatus, currentStatus) {
    this.logger.info('Device status changed', {
      deviceId: device.id,
      from: previousStatus,
      to: currentStatus
    });
    
    this.emit('device:status_changed', {
      deviceId: device.id,
      previousStatus,
      currentStatus,
      timestamp: Date.now()
    });
    
    // Update statistics
    this.updateHealthStats();
  }
  
  /**
   * Check device alerts
   */
  checkDeviceAlerts(device) {
    for (const [metric, alert] of device.alerts) {
      const throttleKey = `${device.id}:${metric}:${alert.level}`;
      const lastAlert = this.alertThrottle.get(throttleKey);
      
      // Check throttle
      if (lastAlert && Date.now() - lastAlert < this.config.alertThrottleTime) {
        continue;
      }
      
      // Send alert
      this.sendAlert(device, metric, alert);
      this.alertThrottle.set(throttleKey, Date.now());
    }
  }
  
  /**
   * Send alert
   */
  sendAlert(device, metric, alert) {
    const alertData = {
      deviceId: device.id,
      deviceName: device.name,
      metric,
      level: alert.level,
      message: alert.message,
      value: alert.value,
      threshold: alert.threshold,
      timestamp: Date.now()
    };
    
    this.alertHistory.push(alertData);
    this.stats.totalAlerts++;
    
    // Keep alert history limited
    if (this.alertHistory.length > 10000) {
      this.alertHistory.shift();
    }
    
    this.emit('alert:triggered', alertData);
    
    this.logger.warn('Hardware alert', alertData);
  }
  
  /**
   * Check auto-protection
   */
  checkAutoProtection(device) {
    // Get failure prediction
    const prediction = this.predictiveAnalytics.predictFailure(device);
    
    if (prediction.failureProbability > this.config.autoShutdownThreshold) {
      this.executeAutoProtection(device, 'shutdown', prediction);
    } else if (prediction.failureProbability > 0.7) {
      this.executeAutoProtection(device, 'power_limit', prediction);
    }
  }
  
  /**
   * Execute auto-protection action
   */
  executeAutoProtection(device, action, prediction) {
    this.stats.autoProtectionEvents++;
    
    const protectionData = {
      deviceId: device.id,
      action,
      reason: 'high_failure_probability',
      probability: prediction.failureProbability,
      timestamp: Date.now()
    };
    
    this.emit('protection:activated', protectionData);
    
    switch (action) {
      case 'shutdown':
        this.logger.error('Auto-shutdown triggered', protectionData);
        // In production, would trigger actual shutdown
        break;
        
      case 'power_limit':
        this.logger.warn('Power limit reduction triggered', protectionData);
        // In production, would reduce power limit
        break;
    }
  }
  
  /**
   * Start monitoring loop
   */
  startMonitoring() {
    this.monitoringInterval = setInterval(() => {
      this.pollDevices();
    }, this.config.pollInterval);
  }
  
  /**
   * Poll devices for metrics
   */
  async pollDevices() {
    for (const device of this.devices.values()) {
      try {
        // Simulate reading hardware metrics
        const metrics = await this.readHardwareMetrics(device);
        this.updateDeviceMetrics(device.id, metrics);
      } catch (error) {
        this.logger.error('Failed to poll device', {
          deviceId: device.id,
          error: error.message
        });
        
        // Mark as offline if polling fails
        device.status = HEALTH_STATUS.OFFLINE;
      }
    }
  }
  
  /**
   * Read hardware metrics (simulated)
   */
  async readHardwareMetrics(device) {
    // Simulate hardware readings
    const baseTemp = device.type === HARDWARE_TYPES.GPU ? 60 : 70;
    const baseFan = 50;
    const basePower = device.type === HARDWARE_TYPES.GPU ? 250 : 3000;
    
    return {
      temperature: baseTemp + Math.random() * 20,
      fanSpeed: baseFan + Math.random() * 40,
      powerUsage: basePower * (0.8 + Math.random() * 0.4),
      memoryUsage: Math.random() * 100,
      hashrate: device.type === HARDWARE_TYPES.GPU ? 100e6 : 100e12,
      errorRate: Math.random() * 0.02,
      voltage: 1.0 + Math.random() * 0.1,
      frequency: device.type === HARDWARE_TYPES.GPU ? 1800 : 500
    };
  }
  
  /**
   * Start predictive analytics
   */
  startPredictiveAnalytics() {
    this.predictionInterval = setInterval(() => {
      this.runPredictions();
    }, 60000); // Every minute
  }
  
  /**
   * Run predictions for all devices
   */
  runPredictions() {
    for (const device of this.devices.values()) {
      const prediction = this.predictiveAnalytics.predictFailure(device);
      
      if (prediction.failureProbability > this.config.failureProbabilityThreshold) {
        this.emit('prediction:failure_risk', {
          deviceId: device.id,
          prediction
        });
      }
      
      this.stats.predictionsGenerated++;
    }
  }
  
  /**
   * Start reporting
   */
  startReporting() {
    this.reportingInterval = setInterval(() => {
      this.generateReport();
    }, this.config.reportInterval);
  }
  
  /**
   * Generate health report
   */
  generateReport() {
    const report = {
      timestamp: Date.now(),
      summary: {
        totalDevices: this.stats.totalDevices,
        healthy: this.stats.healthyDevices,
        degraded: this.stats.degradedDevices,
        critical: this.stats.criticalDevices,
        failed: this.stats.failedDevices,
        offline: this.stats.totalDevices - 
          (this.stats.healthyDevices + this.stats.degradedDevices + 
           this.stats.criticalDevices + this.stats.failedDevices)
      },
      devices: [],
      alerts: this.getRecentAlerts(300000), // Last 5 minutes
      predictions: []
    };
    
    // Add device details
    for (const device of this.devices.values()) {
      report.devices.push({
        id: device.id,
        name: device.name,
        type: device.type,
        status: device.status,
        metrics: device.metrics,
        alerts: Array.from(device.alerts.values())
      });
      
      // Add predictions
      const prediction = this.predictiveAnalytics.predictions.get(device.id);
      if (prediction) {
        report.predictions.push(prediction);
      }
    }
    
    this.emit('report:generated', report);
    
    return report;
  }
  
  /**
   * Get recent alerts
   */
  getRecentAlerts(duration = 300000) {
    const cutoff = Date.now() - duration;
    return this.alertHistory.filter(alert => alert.timestamp > cutoff);
  }
  
  /**
   * Update health statistics
   */
  updateHealthStats() {
    let healthy = 0, degraded = 0, critical = 0, failed = 0;
    
    for (const device of this.devices.values()) {
      switch (device.status) {
        case HEALTH_STATUS.HEALTHY:
          healthy++;
          break;
        case HEALTH_STATUS.DEGRADED:
          degraded++;
          break;
        case HEALTH_STATUS.CRITICAL:
          critical++;
          break;
        case HEALTH_STATUS.FAILED:
          failed++;
          break;
      }
    }
    
    this.stats.healthyDevices = healthy;
    this.stats.degradedDevices = degraded;
    this.stats.criticalDevices = critical;
    this.stats.failedDevices = failed;
  }
  
  /**
   * Get device status
   */
  getDeviceStatus(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return null;
    
    return {
      id: device.id,
      name: device.name,
      type: device.type,
      status: device.status,
      metrics: device.metrics,
      alerts: Array.from(device.alerts.values()),
      trends: {
        temperature: device.getMetricTrend(HEALTH_METRICS.TEMPERATURE),
        fanSpeed: device.getMetricTrend(HEALTH_METRICS.FAN_SPEED),
        errorRate: device.getMetricTrend(HEALTH_METRICS.ERROR_RATE)
      },
      prediction: this.predictiveAnalytics.predictions.get(deviceId)
    };
  }
  
  /**
   * Get all devices status
   */
  getAllDevicesStatus() {
    const devices = [];
    
    for (const device of this.devices.values()) {
      devices.push(this.getDeviceStatus(device.id));
    }
    
    return devices;
  }
  
  /**
   * Set device thresholds
   */
  setDeviceThresholds(deviceId, thresholds) {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`Device ${deviceId} not found`);
    }
    
    device.thresholds = {
      ...device.thresholds,
      ...thresholds
    };
    
    this.emit('thresholds:updated', {
      deviceId,
      thresholds
    });
  }
  
  /**
   * Get monitoring statistics
   */
  getStats() {
    return {
      ...this.stats,
      devices: this.getAllDevicesStatus(),
      recentAlerts: this.getRecentAlerts(),
      uptimeHours: process.uptime() / 3600
    };
  }
  
  /**
   * Shutdown monitor
   */
  shutdown() {
    // Clear intervals
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    if (this.predictionInterval) {
      clearInterval(this.predictionInterval);
    }
    
    if (this.reportingInterval) {
      clearInterval(this.reportingInterval);
    }
    
    this.logger.info('Hardware health monitor shutdown');
  }
}

// Export constants
export {
  HARDWARE_TYPES,
  HEALTH_METRICS,
  ALERT_LEVELS,
  HEALTH_STATUS
};

export default HardwareHealthMonitor;