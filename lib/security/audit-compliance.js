/**
 * Audit and Compliance System for Otedama
 * National-grade audit logging and regulatory compliance
 * 
 * Design:
 * - Carmack: High-performance audit logging without impact
 * - Martin: Clean separation between audit domains
 * - Pike: Simple but comprehensive compliance tracking
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { createStructuredLogger } from '../core/structured-logger.js';
import { StorageManager } from '../storage/index.js';
import { SecuritySystem } from './national-security.js';

// Compliance constants
const AUDIT_RETENTION_DAYS = 2555; // 7 years
const TRANSACTION_MONITORING_THRESHOLD = 10000; // Flag large transactions
const KYC_VERIFICATION_LEVELS = ['NONE', 'BASIC', 'ENHANCED', 'FULL'];
const JURISDICTIONS = {
  US: { requiresKYC: true, transactionReporting: 10000 },
  EU: { requiresKYC: true, transactionReporting: 15000 },
  JP: { requiresKYC: true, transactionReporting: 1000000 }, // JPY
  CN: { restricted: true }
};

/**
 * Immutable audit log entry
 */
class AuditLogEntry {
  constructor(data) {
    this.id = crypto.randomUUID();
    this.timestamp = new Date().toISOString();
    this.version = '1.0';
    
    // Core fields
    this.eventType = data.eventType;
    this.severity = data.severity || 'INFO';
    this.actor = data.actor || 'SYSTEM';
    this.resource = data.resource;
    this.action = data.action;
    this.result = data.result;
    
    // Additional metadata
    this.metadata = data.metadata || {};
    this.tags = data.tags || [];
    
    // Compliance fields
    this.jurisdiction = data.jurisdiction;
    this.regulatoryFlags = data.regulatoryFlags || [];
    
    // Security
    this.ipAddress = data.ipAddress;
    this.userAgent = data.userAgent;
    this.sessionId = data.sessionId;
    
    // Generate hash for integrity
    this.hash = this.generateHash();
    
    // Make immutable
    Object.freeze(this);
  }
  
  generateHash() {
    const content = JSON.stringify({
      id: this.id,
      timestamp: this.timestamp,
      eventType: this.eventType,
      actor: this.actor,
      resource: this.resource,
      action: this.action,
      result: this.result
    });
    
    return crypto
      .createHash('sha256')
      .update(content)
      .digest('hex');
  }
  
  toJSON() {
    return {
      id: this.id,
      timestamp: this.timestamp,
      version: this.version,
      eventType: this.eventType,
      severity: this.severity,
      actor: this.actor,
      resource: this.resource,
      action: this.action,
      result: this.result,
      metadata: this.metadata,
      tags: this.tags,
      jurisdiction: this.jurisdiction,
      regulatoryFlags: this.regulatoryFlags,
      ipAddress: this.ipAddress,
      userAgent: this.userAgent,
      sessionId: this.sessionId,
      hash: this.hash
    };
  }
}

/**
 * Transaction monitoring for AML compliance
 */
class TransactionMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.thresholds = {
      single: options.singleTransactionThreshold || TRANSACTION_MONITORING_THRESHOLD,
      daily: options.dailyThreshold || TRANSACTION_MONITORING_THRESHOLD * 10,
      pattern: options.patternThreshold || 0.8
    };
    
    // User transaction history
    this.userTransactions = new Map();
    
    // Suspicious patterns
    this.patterns = {
      structuring: this.detectStructuring.bind(this),
      velocitySpike: this.detectVelocitySpike.bind(this),
      unusualHours: this.detectUnusualHours.bind(this),
      crossBorder: this.detectCrossBorder.bind(this)
    };
    
    this.logger = createStructuredLogger('TransactionMonitor');
  }
  
  /**
   * Monitor transaction
   */
  async monitorTransaction(transaction) {
    const flags = [];
    
    // Check single transaction threshold
    if (transaction.amount >= this.thresholds.single) {
      flags.push({
        type: 'LARGE_TRANSACTION',
        severity: 'HIGH',
        details: { amount: transaction.amount }
      });
    }
    
    // Update user history
    this.updateUserHistory(transaction);
    
    // Check patterns
    for (const [name, detector] of Object.entries(this.patterns)) {
      const result = await detector(transaction);
      if (result) {
        flags.push({
          type: `PATTERN_${name.toUpperCase()}`,
          severity: result.severity,
          confidence: result.confidence,
          details: result.details
        });
      }
    }
    
    // Check daily volume
    const dailyVolume = this.getDailyVolume(transaction.userId);
    if (dailyVolume >= this.thresholds.daily) {
      flags.push({
        type: 'DAILY_LIMIT_EXCEEDED',
        severity: 'HIGH',
        details: { dailyVolume }
      });
    }
    
    // Emit if suspicious
    if (flags.length > 0) {
      this.emit('suspicious_transaction', {
        transaction,
        flags,
        riskScore: this.calculateRiskScore(flags)
      });
    }
    
    return flags;
  }
  
  /**
   * Update user transaction history
   */
  updateUserHistory(transaction) {
    let history = this.userTransactions.get(transaction.userId);
    
    if (!history) {
      history = {
        transactions: [],
        totalVolume: 0,
        countries: new Set(),
        patterns: {
          avgAmount: 0,
          avgTime: 0,
          commonHours: new Map()
        }
      };
      this.userTransactions.set(transaction.userId, history);
    }
    
    // Add transaction
    history.transactions.push({
      amount: transaction.amount,
      timestamp: transaction.timestamp,
      country: transaction.country,
      type: transaction.type
    });
    
    history.totalVolume += transaction.amount;
    if (transaction.country) {
      history.countries.add(transaction.country);
    }
    
    // Update patterns
    const hour = new Date(transaction.timestamp).getHours();
    history.patterns.commonHours.set(
      hour,
      (history.patterns.commonHours.get(hour) || 0) + 1
    );
    
    // Keep only recent transactions (30 days)
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    history.transactions = history.transactions.filter(
      t => t.timestamp > cutoff
    );
  }
  
  /**
   * Detect structuring (smurfing)
   */
  detectStructuring(transaction) {
    const history = this.userTransactions.get(transaction.userId);
    if (!history || history.transactions.length < 3) return null;
    
    // Look for multiple transactions just below threshold
    const recentTx = history.transactions.slice(-10);
    const threshold = this.thresholds.single;
    const suspiciousTx = recentTx.filter(
      tx => tx.amount > threshold * 0.8 && tx.amount < threshold
    );
    
    if (suspiciousTx.length >= 3) {
      return {
        severity: 'HIGH',
        confidence: 0.85,
        details: {
          count: suspiciousTx.length,
          pattern: 'multiple_near_threshold'
        }
      };
    }
    
    return null;
  }
  
  /**
   * Detect velocity spike
   */
  detectVelocitySpike(transaction) {
    const history = this.userTransactions.get(transaction.userId);
    if (!history || history.transactions.length < 10) return null;
    
    // Calculate recent velocity
    const recentTx = history.transactions.slice(-5);
    const olderTx = history.transactions.slice(-20, -5);
    
    if (olderTx.length === 0) return null;
    
    const recentAvg = recentTx.reduce((sum, tx) => sum + tx.amount, 0) / recentTx.length;
    const olderAvg = olderTx.reduce((sum, tx) => sum + tx.amount, 0) / olderTx.length;
    
    const spike = recentAvg / olderAvg;
    
    if (spike > 5) {
      return {
        severity: 'MEDIUM',
        confidence: 0.7,
        details: {
          spikeRatio: spike,
          recentAverage: recentAvg,
          historicalAverage: olderAvg
        }
      };
    }
    
    return null;
  }
  
  /**
   * Detect unusual hours
   */
  detectUnusualHours(transaction) {
    const hour = new Date(transaction.timestamp).getHours();
    
    // Flag transactions between 2 AM and 5 AM
    if (hour >= 2 && hour <= 5) {
      const history = this.userTransactions.get(transaction.userId);
      if (!history) return null;
      
      // Check if this is unusual for the user
      const totalTx = history.transactions.length;
      const nightTx = Array.from(history.patterns.commonHours.entries())
        .filter(([h]) => h >= 2 && h <= 5)
        .reduce((sum, [, count]) => sum + count, 0);
      
      const nightRatio = nightTx / totalTx;
      
      if (nightRatio < 0.1 && transaction.amount > this.thresholds.single * 0.5) {
        return {
          severity: 'LOW',
          confidence: 0.6,
          details: {
            hour,
            historicalNightRatio: nightRatio
          }
        };
      }
    }
    
    return null;
  }
  
  /**
   * Detect cross-border patterns
   */
  detectCrossBorder(transaction) {
    const history = this.userTransactions.get(transaction.userId);
    if (!history || !transaction.country) return null;
    
    // New country
    if (!history.countries.has(transaction.country)) {
      return {
        severity: 'MEDIUM',
        confidence: 0.75,
        details: {
          newCountry: transaction.country,
          previousCountries: Array.from(history.countries)
        }
      };
    }
    
    // Multiple countries in short time
    const recentCountries = new Set(
      history.transactions
        .slice(-10)
        .map(tx => tx.country)
        .filter(Boolean)
    );
    
    if (recentCountries.size >= 3) {
      return {
        severity: 'HIGH',
        confidence: 0.8,
        details: {
          recentCountries: Array.from(recentCountries),
          transactionCount: 10
        }
      };
    }
    
    return null;
  }
  
  /**
   * Calculate risk score
   */
  calculateRiskScore(flags) {
    const weights = {
      HIGH: 10,
      MEDIUM: 5,
      LOW: 2
    };
    
    let score = 0;
    for (const flag of flags) {
      score += weights[flag.severity] || 1;
      if (flag.confidence) {
        score *= flag.confidence;
      }
    }
    
    return Math.min(100, score);
  }
  
  /**
   * Get daily volume
   */
  getDailyVolume(userId) {
    const history = this.userTransactions.get(userId);
    if (!history) return 0;
    
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return history.transactions
      .filter(tx => tx.timestamp > dayAgo)
      .reduce((sum, tx) => sum + tx.amount, 0);
  }
}

/**
 * KYC (Know Your Customer) manager
 */
class KYCManager {
  constructor(storage) {
    this.storage = storage;
    this.verificationCache = new Map();
    this.logger = createStructuredLogger('KYCManager');
  }
  
  /**
   * Verify user KYC status
   */
  async verifyUser(userId, jurisdiction) {
    // Check cache
    const cached = this.verificationCache.get(userId);
    if (cached && cached.expiry > Date.now()) {
      return cached;
    }
    
    // Check jurisdiction requirements
    const requirements = JURISDICTIONS[jurisdiction];
    if (!requirements || !requirements.requiresKYC) {
      return {
        verified: true,
        level: 'NONE',
        reason: 'jurisdiction_no_kyc'
      };
    }
    
    // Restricted jurisdiction
    if (requirements.restricted) {
      return {
        verified: false,
        level: 'NONE',
        reason: 'jurisdiction_restricted'
      };
    }
    
    // Load user KYC data
    const kycData = await this.storage.getKYCData(userId);
    
    if (!kycData) {
      return {
        verified: false,
        level: 'NONE',
        reason: 'no_kyc_data'
      };
    }
    
    // Verify based on level
    const verification = await this.performVerification(kycData, requirements);
    
    // Cache result
    this.verificationCache.set(userId, {
      ...verification,
      expiry: Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    });
    
    return verification;
  }
  
  /**
   * Perform KYC verification
   */
  async performVerification(kycData, requirements) {
    const checks = {
      identity: this.checkIdentity(kycData),
      address: this.checkAddress(kycData),
      sanctions: await this.checkSanctions(kycData),
      pep: await this.checkPEP(kycData)
    };
    
    // Calculate verification level
    let level = 'BASIC';
    let verified = true;
    const failedChecks = [];
    
    for (const [check, result] of Object.entries(checks)) {
      if (!result.passed) {
        failedChecks.push(check);
        if (result.critical) {
          verified = false;
        }
      }
    }
    
    if (checks.identity.passed && checks.address.passed) {
      level = 'ENHANCED';
    }
    
    if (Object.values(checks).every(c => c.passed)) {
      level = 'FULL';
    }
    
    return {
      verified,
      level,
      checks,
      failedChecks,
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * Check identity documents
   */
  checkIdentity(kycData) {
    if (!kycData.identity || !kycData.identity.verified) {
      return { passed: false, critical: true };
    }
    
    // Check document expiry
    if (kycData.identity.expiryDate) {
      const expiry = new Date(kycData.identity.expiryDate);
      if (expiry < new Date()) {
        return { passed: false, reason: 'document_expired' };
      }
    }
    
    return { passed: true };
  }
  
  /**
   * Check address verification
   */
  checkAddress(kycData) {
    if (!kycData.address || !kycData.address.verified) {
      return { passed: false };
    }
    
    // Check document age (must be within 3 months)
    if (kycData.address.documentDate) {
      const docDate = new Date(kycData.address.documentDate);
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      
      if (docDate < threeMonthsAgo) {
        return { passed: false, reason: 'document_too_old' };
      }
    }
    
    return { passed: true };
  }
  
  /**
   * Check sanctions lists
   */
  async checkSanctions(kycData) {
    // In production, this would call external sanctions APIs
    // For now, simulate with a basic check
    
    const sanctionedCountries = ['KP', 'IR', 'SY'];
    
    if (sanctionedCountries.includes(kycData.nationality)) {
      return { 
        passed: false, 
        critical: true,
        reason: 'sanctioned_country' 
      };
    }
    
    // Simulate name matching against sanctions list
    // In production: Call OFAC, UN, EU sanctions APIs
    
    return { passed: true };
  }
  
  /**
   * Check PEP (Politically Exposed Person) status
   */
  async checkPEP(kycData) {
    // In production, this would call PEP screening services
    // For now, return passed
    
    return { 
      passed: true,
      pep: false 
    };
  }
}

/**
 * Comprehensive Audit and Compliance System
 */
export class AuditComplianceSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      retentionDays: options.retentionDays || AUDIT_RETENTION_DAYS,
      transactionMonitoring: options.transactionMonitoring !== false,
      kycRequired: options.kycRequired !== false,
      jurisdiction: options.jurisdiction || 'US',
      ...options
    };
    
    // Initialize components
    this.storage = new StorageManager({
      dbFile: options.auditDbFile || 'audit-compliance.db'
    });
    
    this.transactionMonitor = new TransactionMonitor({
      singleTransactionThreshold: options.transactionThreshold
    });
    
    this.kycManager = new KYCManager(this.storage);
    
    // Audit log buffer for performance
    this.auditBuffer = [];
    this.bufferSize = options.bufferSize || 1000;
    
    // Statistics
    this.stats = {
      totalAuditLogs: 0,
      suspiciousTransactions: 0,
      kycVerifications: 0,
      complianceAlerts: 0
    };
    
    this.logger = createStructuredLogger('AuditCompliance');
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Start maintenance
    this.startMaintenance();
  }
  
  /**
   * Initialize system
   */
  async initialize() {
    await this.storage.initialize();
    
    // Create audit tables
    await this.storage.createTable('audit_logs', {
      id: 'TEXT PRIMARY KEY',
      timestamp: 'TEXT NOT NULL',
      eventType: 'TEXT NOT NULL',
      severity: 'TEXT',
      actor: 'TEXT',
      resource: 'TEXT',
      action: 'TEXT',
      result: 'TEXT',
      metadata: 'TEXT',
      hash: 'TEXT NOT NULL',
      INDEX: ['timestamp', 'eventType', 'actor']
    });
    
    await this.storage.createTable('compliance_alerts', {
      id: 'TEXT PRIMARY KEY',
      timestamp: 'TEXT NOT NULL',
      type: 'TEXT NOT NULL',
      severity: 'TEXT',
      userId: 'TEXT',
      details: 'TEXT',
      status: 'TEXT DEFAULT "OPEN"',
      resolution: 'TEXT',
      INDEX: ['timestamp', 'type', 'userId', 'status']
    });
    
    this.logger.info('Audit compliance system initialized');
  }
  
  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // Transaction monitoring alerts
    this.transactionMonitor.on('suspicious_transaction', async (data) => {
      this.stats.suspiciousTransactions++;
      
      await this.createComplianceAlert({
        type: 'SUSPICIOUS_TRANSACTION',
        severity: 'HIGH',
        userId: data.transaction.userId,
        details: data
      });
      
      // Log audit event
      await this.audit({
        eventType: 'COMPLIANCE_ALERT',
        severity: 'WARNING',
        resource: `transaction:${data.transaction.id}`,
        action: 'flag_suspicious',
        result: 'flagged',
        metadata: data
      });
    });
  }
  
  /**
   * Start maintenance tasks
   */
  startMaintenance() {
    // Flush audit buffer periodically
    this.flushInterval = setInterval(() => {
      this.flushAuditBuffer();
    }, 60000); // 1 minute
    
    // Clean old audit logs
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldLogs();
    }, 24 * 60 * 60 * 1000); // Daily
    
    // Generate compliance reports
    this.reportInterval = setInterval(() => {
      this.generateComplianceReport();
    }, 7 * 24 * 60 * 60 * 1000); // Weekly
  }
  
  /**
   * Log audit event
   */
  async audit(data) {
    const entry = new AuditLogEntry({
      ...data,
      jurisdiction: this.options.jurisdiction
    });
    
    this.stats.totalAuditLogs++;
    
    // Add to buffer
    this.auditBuffer.push(entry);
    
    // Flush if buffer full
    if (this.auditBuffer.length >= this.bufferSize) {
      await this.flushAuditBuffer();
    }
    
    // Emit for real-time monitoring
    this.emit('audit', entry);
    
    return entry;
  }
  
  /**
   * Flush audit buffer to storage
   */
  async flushAuditBuffer() {
    if (this.auditBuffer.length === 0) return;
    
    const entries = [...this.auditBuffer];
    this.auditBuffer = [];
    
    try {
      // Batch insert
      const values = entries.map(entry => [
        entry.id,
        entry.timestamp,
        entry.eventType,
        entry.severity,
        entry.actor,
        entry.resource,
        entry.action,
        entry.result,
        JSON.stringify(entry.metadata),
        entry.hash
      ]);
      
      await this.storage.batchInsert('audit_logs', values);
      
    } catch (error) {
      this.logger.error('Failed to flush audit buffer', error);
      // Re-add to buffer
      this.auditBuffer.unshift(...entries);
    }
  }
  
  /**
   * Monitor transaction for compliance
   */
  async monitorTransaction(transaction) {
    // KYC check
    if (this.options.kycRequired) {
      const kyc = await this.kycManager.verifyUser(
        transaction.userId,
        transaction.jurisdiction || this.options.jurisdiction
      );
      
      if (!kyc.verified) {
        await this.createComplianceAlert({
          type: 'KYC_FAILED',
          severity: 'HIGH',
          userId: transaction.userId,
          details: kyc
        });
        
        return {
          allowed: false,
          reason: 'kyc_verification_failed',
          details: kyc
        };
      }
      
      this.stats.kycVerifications++;
    }
    
    // Transaction monitoring
    if (this.options.transactionMonitoring) {
      const flags = await this.transactionMonitor.monitorTransaction(transaction);
      
      if (flags.length > 0) {
        return {
          allowed: true,
          warning: true,
          flags
        };
      }
    }
    
    // Audit the transaction
    await this.audit({
      eventType: 'TRANSACTION',
      actor: transaction.userId,
      resource: `wallet:${transaction.fromAddress}`,
      action: 'transfer',
      result: 'success',
      metadata: {
        amount: transaction.amount,
        toAddress: transaction.toAddress,
        currency: transaction.currency
      }
    });
    
    return { allowed: true };
  }
  
  /**
   * Create compliance alert
   */
  async createComplianceAlert(alert) {
    const id = crypto.randomUUID();
    
    await this.storage.insert('compliance_alerts', {
      id,
      timestamp: new Date().toISOString(),
      type: alert.type,
      severity: alert.severity,
      userId: alert.userId,
      details: JSON.stringify(alert.details),
      status: 'OPEN'
    });
    
    this.stats.complianceAlerts++;
    
    this.emit('compliance_alert', {
      id,
      ...alert
    });
    
    return id;
  }
  
  /**
   * Generate compliance report
   */
  async generateComplianceReport() {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    
    const report = {
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString()
      },
      statistics: { ...this.stats },
      alerts: await this.storage.query(
        'SELECT type, severity, COUNT(*) as count FROM compliance_alerts WHERE timestamp >= ? GROUP BY type, severity',
        [startDate.toISOString()]
      ),
      topUsers: await this.storage.query(
        'SELECT actor, COUNT(*) as actions FROM audit_logs WHERE timestamp >= ? GROUP BY actor ORDER BY actions DESC LIMIT 10',
        [startDate.toISOString()]
      ),
      suspiciousPatterns: await this.analyzeSuspiciousPatterns(startDate, endDate)
    };
    
    // Save report
    await this.storage.insert('compliance_reports', {
      id: crypto.randomUUID(),
      timestamp: endDate.toISOString(),
      report: JSON.stringify(report)
    });
    
    this.emit('compliance_report', report);
    
    return report;
  }
  
  /**
   * Analyze suspicious patterns
   */
  async analyzeSuspiciousPatterns(startDate, endDate) {
    // This would include ML-based pattern detection in production
    const patterns = [];
    
    // High-frequency traders
    const highFreq = await this.storage.query(
      `SELECT actor, COUNT(*) as count FROM audit_logs 
       WHERE eventType = 'TRANSACTION' 
       AND timestamp BETWEEN ? AND ?
       GROUP BY actor 
       HAVING count > 1000`,
      [startDate.toISOString(), endDate.toISOString()]
    );
    
    if (highFreq.length > 0) {
      patterns.push({
        type: 'HIGH_FREQUENCY_TRADING',
        severity: 'MEDIUM',
        instances: highFreq
      });
    }
    
    // Failed authentication spikes
    const authFailures = await this.storage.query(
      `SELECT DATE(timestamp) as date, COUNT(*) as count 
       FROM audit_logs 
       WHERE eventType = 'AUTH_FAILURE'
       AND timestamp BETWEEN ? AND ?
       GROUP BY date
       HAVING count > 100`,
      [startDate.toISOString(), endDate.toISOString()]
    );
    
    if (authFailures.length > 0) {
      patterns.push({
        type: 'AUTH_FAILURE_SPIKE',
        severity: 'HIGH',
        instances: authFailures
      });
    }
    
    return patterns;
  }
  
  /**
   * Clean up old logs
   */
  async cleanupOldLogs() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.options.retentionDays);
    
    const deleted = await this.storage.delete(
      'audit_logs',
      'timestamp < ?',
      [cutoffDate.toISOString()]
    );
    
    this.logger.info('Cleaned up old audit logs', { deleted });
  }
  
  /**
   * Query audit logs
   */
  async queryAuditLogs(filters = {}) {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    
    if (filters.startDate) {
      query += ' AND timestamp >= ?';
      params.push(filters.startDate);
    }
    
    if (filters.endDate) {
      query += ' AND timestamp <= ?';
      params.push(filters.endDate);
    }
    
    if (filters.eventType) {
      query += ' AND eventType = ?';
      params.push(filters.eventType);
    }
    
    if (filters.actor) {
      query += ' AND actor = ?';
      params.push(filters.actor);
    }
    
    if (filters.severity) {
      query += ' AND severity = ?';
      params.push(filters.severity);
    }
    
    query += ' ORDER BY timestamp DESC';
    
    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }
    
    return await this.storage.query(query, params);
  }
  
  /**
   * Export audit logs for regulatory submission
   */
  async exportAuditLogs(startDate, endDate, format = 'json') {
    const logs = await this.queryAuditLogs({ startDate, endDate });
    
    // Verify integrity
    const verified = logs.every(log => {
      const entry = new AuditLogEntry(log);
      return entry.hash === log.hash;
    });
    
    if (!verified) {
      throw new Error('Audit log integrity check failed');
    }
    
    const exportData = {
      exportDate: new Date().toISOString(),
      period: { start: startDate, end: endDate },
      jurisdiction: this.options.jurisdiction,
      totalRecords: logs.length,
      verified: true,
      logs
    };
    
    // Sign export
    const signature = crypto
      .createHash('sha256')
      .update(JSON.stringify(exportData))
      .digest('hex');
    
    exportData.signature = signature;
    
    if (format === 'json') {
      return JSON.stringify(exportData, null, 2);
    }
    
    // Add other formats as needed (CSV, XML, etc.)
    throw new Error(`Unsupported export format: ${format}`);
  }
  
  /**
   * Get compliance statistics
   */
  getStats() {
    return {
      ...this.stats,
      bufferSize: this.auditBuffer.length,
      transactionMonitor: {
        users: this.transactionMonitor.userTransactions.size
      },
      kyc: {
        cached: this.kycManager.verificationCache.size
      }
    };
  }
  
  /**
   * Shutdown system
   */
  async shutdown() {
    // Flush remaining audit logs
    await this.flushAuditBuffer();
    
    // Clear intervals
    clearInterval(this.flushInterval);
    clearInterval(this.cleanupInterval);
    clearInterval(this.reportInterval);
    
    // Close storage
    await this.storage.close();
    
    this.removeAllListeners();
    
    this.logger.info('Audit compliance system shut down');
  }
}

// Export components
export {
  AuditLogEntry,
  TransactionMonitor,
  KYCManager,
  JURISDICTIONS,
  KYC_VERIFICATION_LEVELS
};

export default AuditComplianceSystem;