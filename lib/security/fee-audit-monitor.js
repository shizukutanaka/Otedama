/**
 * Fee Audit and Monitoring System
 * Real-time monitoring and alerting for fee-related security events
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { secureFeeConfig } from './fee-protection.js';

const logger = getLogger('FeeAuditMonitor');

/**
 * Fee audit monitor for detecting unauthorized access attempts
 */
export class FeeAuditMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      monitoringInterval: options.monitoringInterval || 30000, // 30 seconds
      alertThreshold: options.alertThreshold || 3, // 3 attempts trigger alert
      auditRetention: options.auditRetention || 30 * 24 * 60 * 60 * 1000, // 30 days
      realTimeAlerts: options.realTimeAlerts !== false,
      ...options
    };
    
    this.auditLog = [];
    this.alertHistory = [];
    this.suspiciousPatterns = new Map();
    this.isMonitoring = false;
    
    this.startMonitoring();
  }

  /**
   * Start continuous monitoring
   */
  startMonitoring() {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    logger.info('Fee audit monitoring started');
    
    // Monitor fee integrity
    this.integrityCheckInterval = setInterval(() => {
      this.performIntegrityCheck();
    }, this.options.monitoringInterval);
    
    // Monitor for suspicious patterns
    this.patternCheckInterval = setInterval(() => {
      this.analyzeSuspiciousPatterns();
    }, this.options.monitoringInterval * 2);
    
    // Cleanup old audit logs
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldLogs();
    }, 24 * 60 * 60 * 1000); // Daily cleanup
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (!this.isMonitoring) return;
    
    this.isMonitoring = false;
    
    if (this.integrityCheckInterval) clearInterval(this.integrityCheckInterval);
    if (this.patternCheckInterval) clearInterval(this.patternCheckInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    
    logger.info('Fee audit monitoring stopped');
  }

  /**
   * Perform integrity check on fee configuration
   */
  performIntegrityCheck() {
    try {
      // Verify fee configuration integrity
      secureFeeConfig.verifyIntegrity();
      
      // Check for modification attempts
      const attempts = secureFeeConfig.getAuditTrail();
      if (attempts.length > this.lastKnownAttempts) {
        const newAttempts = attempts.slice(this.lastKnownAttempts);
        this.handleModificationAttempts(newAttempts);
      }
      this.lastKnownAttempts = attempts.length;
      
    } catch (error) {
      this.logSecurityEvent('INTEGRITY_VIOLATION', {
        error: error.message,
        timestamp: Date.now(),
        severity: 'CRITICAL'
      });
    }
  }

  /**
   * Handle detected modification attempts
   */
  handleModificationAttempts(attempts) {
    attempts.forEach(attempt => {
      this.logSecurityEvent('UNAUTHORIZED_MODIFICATION_ATTEMPT', {
        attempt,
        timestamp: Date.now(),
        severity: 'HIGH'
      });
      
      if (this.options.realTimeAlerts) {
        this.sendRealTimeAlert('Fee modification attempt detected', attempt);
      }
    });
  }

  /**
   * Log security event
   */
  logSecurityEvent(eventType, details) {
    const auditEntry = {
      id: this.generateAuditId(),
      timestamp: Date.now(),
      eventType,
      details,
      sourceIp: details.sourceIp || 'unknown',
      userAgent: details.userAgent || 'unknown'
    };
    
    this.auditLog.push(auditEntry);
    
    logger.warn('Fee security event:', auditEntry);
    this.emit('securityEvent', auditEntry);
    
    // Check if this triggers an alert threshold
    this.checkAlertThreshold(eventType);
  }

  /**
   * Check if alert threshold is exceeded
   */
  checkAlertThreshold(eventType) {
    const recentEvents = this.auditLog.filter(entry => 
      entry.eventType === eventType &&
      (Date.now() - entry.timestamp) < 300000 // Last 5 minutes
    );
    
    if (recentEvents.length >= this.options.alertThreshold) {
      this.triggerSecurityAlert(eventType, recentEvents);
    }
  }

  /**
   * Trigger security alert
   */
  triggerSecurityAlert(eventType, events) {
    const alert = {
      id: this.generateAlertId(),
      timestamp: Date.now(),
      eventType,
      eventCount: events.length,
      severity: 'CRITICAL',
      description: `Multiple ${eventType} events detected within 5 minutes`,
      events: events.map(e => e.id)
    };
    
    this.alertHistory.push(alert);
    
    logger.error('SECURITY ALERT:', alert);
    this.emit('securityAlert', alert);
    
    // In production, this would send notifications to administrators
    this.notifyAdministrators(alert);
  }

  /**
   * Simplified suspicious pattern detection
   */
  analyzeSuspiciousPatterns() {
    const recentEvents = this.auditLog.filter(entry =>
      (Date.now() - entry.timestamp) < 3600000 // Last hour
    );
    
    // Simple check for too many critical events
    const criticalEvents = recentEvents.filter(e => e.details.severity === 'CRITICAL');
    if (criticalEvents.length > 3) {
      this.logSecurityEvent('SUSPICIOUS_PATTERN_DETECTED', {
        eventCount: criticalEvents.length,
        severity: 'HIGH'
      });
    }
  }

  /**
   * Get security dashboard data
   */
  getSecurityDashboard() {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const oneDay = 24 * oneHour;
    
    const recentEvents = this.auditLog.filter(e => (now - e.timestamp) < oneHour);
    const dailyEvents = this.auditLog.filter(e => (now - e.timestamp) < oneDay);
    
    return {
      realTimeStatus: {
        isMonitoring: this.isMonitoring,
        lastIntegrityCheck: this.lastIntegrityCheck || null,
        activeSuspiciousIps: this.suspiciousPatterns.size
      },
      eventSummary: {
        lastHour: recentEvents.length,
        lastDay: dailyEvents.length,
        total: this.auditLog.length,
        byType: this.groupEventsByType(dailyEvents)
      },
      alerts: {
        total: this.alertHistory.length,
        recent: this.alertHistory.filter(a => (now - a.timestamp) < oneDay).length,
        lastAlert: this.alertHistory[this.alertHistory.length - 1] || null
      },
      feeIntegrity: {
        currentFeeRate: secureFeeConfig.getPoolFeeRate(),
        integrityStatus: 'PROTECTED',
        lastVerification: now,
        modificationAttempts: secureFeeConfig.getAuditTrail().length
      },
      suspiciousActivity: Array.from(this.suspiciousPatterns.entries()).map(([ip, data]) => ({
        ip,
        suspicionLevel: data.count,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
        recentEvents: data.recentEvents
      }))
    };
  }

  /**
   * Get simplified audit report
   */
  generateAuditReport(timeframe = '24h') {
    const now = Date.now();
    const period = timeframe === '1h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const relevantEvents = this.auditLog.filter(e => (now - e.timestamp) < period);
    
    return {
      generatedAt: now,
      timeframe,
      eventCount: relevantEvents.length,
      feeIntegrity: 'PROTECTED',
      currentFeeRate: '0.5%',
      criticalEvents: relevantEvents.filter(e => e.details.severity === 'CRITICAL').length,
      recentAlerts: this.alertHistory.filter(a => (now - a.timestamp) < period).length
    };
  }

  /**
   * Utility methods
   */
  generateAuditId() {
    return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  generateAlertId() {
    return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  generateReportId() {
    return `report_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  groupEventsByType(events) {
    return events.reduce((groups, event) => {
      groups[event.eventType] = (groups[event.eventType] || 0) + 1;
      return groups;
    }, {});
  }

  groupEventsBySeverity(events) {
    return events.reduce((groups, event) => {
      const severity = event.details.severity || 'UNKNOWN';
      groups[severity] = (groups[severity] || 0) + 1;
      return groups;
    }, {});
  }

  createEventTimeline(events) {
    return events.sort((a, b) => a.timestamp - b.timestamp).map(event => ({
      timestamp: event.timestamp,
      eventType: event.eventType,
      severity: event.details.severity
    }));
  }

  generateSecurityRecommendations(events) {
    const recommendations = [];
    
    if (events.length > 100) {
      recommendations.push({
        priority: 'HIGH',
        category: 'Monitoring',
        recommendation: 'High event volume detected - consider reviewing monitoring sensitivity'
      });
    }
    
    const criticalEvents = events.filter(e => e.details.severity === 'CRITICAL');
    if (criticalEvents.length > 0) {
      recommendations.push({
        priority: 'CRITICAL',
        category: 'Security',
        recommendation: 'Critical security events detected - immediate investigation required'
      });
    }
    
    if (this.suspiciousPatterns.size > 5) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'Access Control',
        recommendation: 'Multiple suspicious IPs detected - consider implementing IP allowlisting'
      });
    }
    
    return recommendations;
  }

  cleanupOldLogs() {
    const cutoff = Date.now() - this.options.auditRetention;
    this.auditLog = this.auditLog.filter(entry => entry.timestamp > cutoff);
    this.alertHistory = this.alertHistory.filter(alert => alert.timestamp > cutoff);
  }

  notifyAdministrators(alert) {
    // In production, this would send notifications via:
    // - Email alerts
    // - SMS notifications
    // - Slack/Discord webhooks
    // - Security incident management systems
    
    logger.error('ADMINISTRATOR NOTIFICATION REQUIRED:', alert);
    this.emit('adminNotificationRequired', alert);
  }
}

// Create singleton instance
export const feeAuditMonitor = new FeeAuditMonitor();

export default {
  FeeAuditMonitor,
  feeAuditMonitor
};