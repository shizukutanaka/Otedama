/**
 * Comprehensive Audit Logger - Otedama
 * National-grade logging and audit trail system
 * 
 * Design: Robert C. Martin - Clean architecture with separation of concerns
 * Security: Complete audit trail for compliance and forensics
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { createStructuredLogger } from './structured-logger.js';
import { DatabaseManager } from '../storage/database.js';
import { CryptoUtils } from '../security/crypto-utils.js';

const logger = createStructuredLogger('AuditLogger');

/**
 * Audit event types
 */
export const AuditEventType = {
  // Authentication
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_FAILED: 'auth.failed',
  AUTH_TOKEN_CREATED: 'auth.token.created',
  AUTH_TOKEN_REVOKED: 'auth.token.revoked',
  
  // Mining operations
  MINING_SHARE_SUBMITTED: 'mining.share.submitted',
  MINING_SHARE_ACCEPTED: 'mining.share.accepted',
  MINING_SHARE_REJECTED: 'mining.share.rejected',
  MINING_BLOCK_FOUND: 'mining.block.found',
  MINING_HARDWARE_CHANGED: 'mining.hardware.changed',
  MINING_POOL_SWITCHED: 'mining.pool.switched',
  
  // Financial operations
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  WALLET_CREATED: 'wallet.created',
  WALLET_UPDATED: 'wallet.updated',
  
  // Configuration changes
  CONFIG_CHANGED: 'config.changed',
  CONFIG_IMPORTED: 'config.imported',
  CONFIG_EXPORTED: 'config.exported',
  
  // Security events
  SECURITY_THREAT_DETECTED: 'security.threat.detected',
  SECURITY_SCAN_COMPLETED: 'security.scan.completed',
  SECURITY_KEY_ROTATED: 'security.key.rotated',
  SECURITY_PERMISSION_CHANGED: 'security.permission.changed',
  
  // System events
  SYSTEM_STARTED: 'system.started',
  SYSTEM_STOPPED: 'system.stopped',
  SYSTEM_ERROR: 'system.error',
  SYSTEM_BACKUP_CREATED: 'system.backup.created',
  SYSTEM_BACKUP_RESTORED: 'system.backup.restored',
  
  // Data operations
  DATA_CREATED: 'data.created',
  DATA_UPDATED: 'data.updated',
  DATA_DELETED: 'data.deleted',
  DATA_EXPORTED: 'data.exported',
  DATA_IMPORTED: 'data.imported'
};

/**
 * Audit severity levels
 */
export const AuditSeverity = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

/**
 * Comprehensive Audit Logger
 */
export class AuditLogger extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      retention: config.retention || 2592000000, // 30 days default
      maxFileSize: config.maxFileSize || 104857600, // 100MB
      rotationInterval: config.rotationInterval || 86400000, // 24 hours
      compressionEnabled: config.compressionEnabled !== false,
      encryptionEnabled: config.encryptionEnabled !== false,
      integrityCheckEnabled: config.integrityCheckEnabled !== false,
      realtimeAnalysis: config.realtimeAnalysis !== false,
      complianceMode: config.complianceMode || 'standard', // standard, strict, forensic
      storageBackends: config.storageBackends || ['file', 'database'],
      ...config
    };
    
    // Storage
    this.logPath = config.logPath || './logs/audit';
    this.currentFile = null;
    this.fileStream = null;
    this.database = null;
    
    // State
    this.sessionId = this.generateSessionId();
    this.sequenceNumber = 0;
    this.hashChain = null;
    this.integrityMap = new Map();
    
    // Buffers
    this.writeBuffer = [];
    this.writeTimer = null;
    
    // Analysis
    this.patterns = new Map();
    this.anomalies = [];
    
    // Statistics
    this.stats = {
      eventsLogged: 0,
      eventsByType: new Map(),
      eventsBySeverity: new Map(),
      anomaliesDetected: 0,
      integrityChecks: 0,
      rotations: 0
    };
    
    this.initialize();
  }
  
  /**
   * Initialize audit logger
   */
  async initialize() {
    try {
      // Create log directory
      await fs.mkdir(this.logPath, { recursive: true });
      
      // Initialize database if enabled
      if (this.config.storageBackends.includes('database')) {
        await this.initializeDatabase();
      }
      
      // Start new log file
      await this.rotateLogFile();
      
      // Initialize hash chain
      this.hashChain = this.generateInitialHash();
      
      // Start rotation timer
      this.startRotationTimer();
      
      // Log system start
      await this.logEvent({
        type: AuditEventType.SYSTEM_STARTED,
        severity: AuditSeverity.INFO,
        data: {
          sessionId: this.sessionId,
          config: this.sanitizeConfig(this.config)
        }
      });
      
      logger.info('Audit logger initialized', {
        sessionId: this.sessionId,
        backends: this.config.storageBackends
      });
      
    } catch (error) {
      logger.error('Failed to initialize audit logger:', error);
      throw error;
    }
  }
  
  /**
   * Log audit event
   */
  async logEvent(event) {
    const auditEntry = {
      id: this.generateEventId(),
      timestamp: Date.now(),
      sessionId: this.sessionId,
      sequenceNumber: this.sequenceNumber++,
      type: event.type,
      severity: event.severity || AuditSeverity.INFO,
      userId: event.userId || null,
      ipAddress: event.ipAddress || null,
      userAgent: event.userAgent || null,
      resource: event.resource || null,
      action: event.action || null,
      result: event.result || 'success',
      data: event.data || {},
      tags: event.tags || [],
      previousHash: this.hashChain,
      hash: null
    };
    
    // Generate hash for integrity
    auditEntry.hash = this.generateEntryHash(auditEntry);
    this.hashChain = auditEntry.hash;
    
    // Add to integrity map
    this.integrityMap.set(auditEntry.id, auditEntry.hash);
    
    // Perform real-time analysis
    if (this.config.realtimeAnalysis) {
      this.analyzeEvent(auditEntry);
    }
    
    // Update statistics
    this.updateStatistics(auditEntry);
    
    // Write to storage backends
    const writePromises = [];
    
    if (this.config.storageBackends.includes('file')) {
      writePromises.push(this.writeToFile(auditEntry));
    }
    
    if (this.config.storageBackends.includes('database')) {
      writePromises.push(this.writeToDatabase(auditEntry));
    }
    
    await Promise.all(writePromises);
    
    // Emit event
    this.emit('event:logged', auditEntry);
    
    return auditEntry.id;
  }
  
  /**
   * Write to file
   */
  async writeToFile(entry) {
    // Prepare log line
    let logLine = JSON.stringify(entry);
    
    // Encrypt if enabled
    if (this.config.encryptionEnabled) {
      logLine = await this.encryptLogLine(logLine);
    }
    
    // Add to buffer
    this.writeBuffer.push(logLine + '\n');
    
    // Flush if needed
    if (this.writeBuffer.length >= 100) {
      await this.flushBuffer();
    } else if (!this.writeTimer) {
      // Set flush timer
      this.writeTimer = setTimeout(() => this.flushBuffer(), 1000);
    }
  }
  
  /**
   * Flush write buffer
   */
  async flushBuffer() {
    if (this.writeBuffer.length === 0) return;
    
    try {
      const data = this.writeBuffer.join('');
      await fs.appendFile(this.currentFile, data);
      this.writeBuffer = [];
      
      if (this.writeTimer) {
        clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      
      // Check file size
      const stats = await fs.stat(this.currentFile);
      if (stats.size >= this.config.maxFileSize) {
        await this.rotateLogFile();
      }
      
    } catch (error) {
      logger.error('Failed to flush audit buffer:', error);
    }
  }
  
  /**
   * Write to database
   */
  async writeToDatabase(entry) {
    if (!this.database) return;
    
    try {
      const stmt = this.database.prepare(`
        INSERT INTO audit_logs (
          id, timestamp, session_id, sequence_number,
          type, severity, user_id, ip_address,
          resource, action, result, data, hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        entry.id,
        entry.timestamp,
        entry.sessionId,
        entry.sequenceNumber,
        entry.type,
        entry.severity,
        entry.userId,
        entry.ipAddress,
        entry.resource,
        entry.action,
        entry.result,
        JSON.stringify(entry.data),
        entry.hash
      );
      
    } catch (error) {
      logger.error('Failed to write audit to database:', error);
    }
  }
  
  /**
   * Initialize database
   */
  async initializeDatabase() {
    try {
      this.database = await DatabaseManager.getInstance();
      
      // Create audit table
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          sequence_number INTEGER NOT NULL,
          type TEXT NOT NULL,
          severity TEXT NOT NULL,
          user_id TEXT,
          ip_address TEXT,
          resource TEXT,
          action TEXT,
          result TEXT,
          data TEXT,
          hash TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_logs(type);
        CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
        CREATE INDEX IF NOT EXISTS idx_audit_severity ON audit_logs(severity);
      `);
      
    } catch (error) {
      logger.error('Failed to initialize audit database:', error);
    }
  }
  
  /**
   * Query audit logs
   */
  async queryLogs(criteria = {}) {
    const {
      startTime,
      endTime,
      type,
      severity,
      userId,
      limit = 1000,
      offset = 0
    } = criteria;
    
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    
    if (startTime) {
      query += ' AND timestamp >= ?';
      params.push(startTime);
    }
    
    if (endTime) {
      query += ' AND timestamp <= ?';
      params.push(endTime);
    }
    
    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }
    
    if (severity) {
      query += ' AND severity = ?';
      params.push(severity);
    }
    
    if (userId) {
      query += ' AND user_id = ?';
      params.push(userId);
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    
    try {
      const stmt = this.database.prepare(query);
      const results = stmt.all(...params);
      
      // Parse JSON data
      return results.map(row => ({
        ...row,
        data: JSON.parse(row.data || '{}')
      }));
      
    } catch (error) {
      logger.error('Failed to query audit logs:', error);
      return [];
    }
  }
  
  /**
   * Verify log integrity
   */
  async verifyIntegrity(startTime, endTime) {
    const logs = await this.queryLogs({ startTime, endTime });
    const results = {
      total: logs.length,
      valid: 0,
      invalid: 0,
      missing: 0,
      errors: []
    };
    
    let previousHash = null;
    
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      
      try {
        // Verify hash chain
        if (previousHash && log.previousHash !== previousHash) {
          results.errors.push({
            id: log.id,
            error: 'Hash chain broken'
          });
          results.invalid++;
          continue;
        }
        
        // Verify entry hash
        const calculatedHash = this.generateEntryHash({
          ...log,
          hash: null
        });
        
        if (calculatedHash !== log.hash) {
          results.errors.push({
            id: log.id,
            error: 'Hash mismatch'
          });
          results.invalid++;
        } else {
          results.valid++;
        }
        
        previousHash = log.hash;
        
      } catch (error) {
        results.errors.push({
          id: log.id,
          error: error.message
        });
        results.invalid++;
      }
    }
    
    this.stats.integrityChecks++;
    
    return results;
  }
  
  /**
   * Analyze event for anomalies
   */
  analyzeEvent(entry) {
    // Check for rapid repeated events
    const recentEvents = this.getRecentEvents(entry.type, 60000); // Last minute
    if (recentEvents.length > 100) {
      this.reportAnomaly({
        type: 'rapid_events',
        severity: AuditSeverity.WARNING,
        event: entry,
        details: {
          count: recentEvents.length,
          timeframe: 60000
        }
      });
    }
    
    // Check for failed authentication attempts
    if (entry.type === AuditEventType.AUTH_FAILED) {
      const failedAttempts = this.getRecentEvents(
        AuditEventType.AUTH_FAILED,
        300000, // 5 minutes
        { userId: entry.userId, ipAddress: entry.ipAddress }
      );
      
      if (failedAttempts.length >= 5) {
        this.reportAnomaly({
          type: 'brute_force_attempt',
          severity: AuditSeverity.CRITICAL,
          event: entry,
          details: {
            attempts: failedAttempts.length,
            timeframe: 300000
          }
        });
      }
    }
    
    // Check for configuration changes
    if (entry.type === AuditEventType.CONFIG_CHANGED) {
      if (entry.severity === AuditSeverity.CRITICAL) {
        this.reportAnomaly({
          type: 'critical_config_change',
          severity: AuditSeverity.WARNING,
          event: entry
        });
      }
    }
    
    // Check for unusual patterns
    this.detectPatterns(entry);
  }
  
  /**
   * Detect patterns
   */
  detectPatterns(entry) {
    const key = `${entry.type}_${entry.userId || 'anonymous'}`;
    const pattern = this.patterns.get(key) || {
      count: 0,
      lastSeen: 0,
      avgInterval: 0
    };
    
    if (pattern.lastSeen > 0) {
      const interval = entry.timestamp - pattern.lastSeen;
      pattern.avgInterval = (pattern.avgInterval * pattern.count + interval) / (pattern.count + 1);
      
      // Check for significant deviation
      if (pattern.count > 10 && interval < pattern.avgInterval * 0.1) {
        this.reportAnomaly({
          type: 'unusual_frequency',
          severity: AuditSeverity.INFO,
          event: entry,
          details: {
            expectedInterval: pattern.avgInterval,
            actualInterval: interval
          }
        });
      }
    }
    
    pattern.count++;
    pattern.lastSeen = entry.timestamp;
    this.patterns.set(key, pattern);
  }
  
  /**
   * Report anomaly
   */
  reportAnomaly(anomaly) {
    anomaly.id = this.generateEventId();
    anomaly.timestamp = Date.now();
    
    this.anomalies.push(anomaly);
    this.stats.anomaliesDetected++;
    
    // Keep only recent anomalies
    const cutoff = Date.now() - 3600000; // 1 hour
    this.anomalies = this.anomalies.filter(a => a.timestamp > cutoff);
    
    // Log the anomaly
    this.logEvent({
      type: AuditEventType.SECURITY_THREAT_DETECTED,
      severity: anomaly.severity,
      data: anomaly
    });
    
    // Emit alert
    this.emit('anomaly:detected', anomaly);
  }
  
  /**
   * Get recent events
   */
  getRecentEvents(type, timeframe, filters = {}) {
    // In production, query from database
    // For now, return empty array
    return [];
  }
  
  /**
   * Generate compliance report
   */
  async generateComplianceReport(startTime, endTime) {
    const logs = await this.queryLogs({ startTime, endTime });
    
    const report = {
      period: {
        start: new Date(startTime),
        end: new Date(endTime)
      },
      summary: {
        totalEvents: logs.length,
        byType: {},
        bySeverity: {},
        byUser: {}
      },
      security: {
        authenticationAttempts: 0,
        failedAuthentications: 0,
        configurationChanges: 0,
        threatsDetected: 0
      },
      integrity: await this.verifyIntegrity(startTime, endTime),
      anomalies: this.anomalies.filter(a => 
        a.timestamp >= startTime && a.timestamp <= endTime
      )
    };
    
    // Process logs
    for (const log of logs) {
      // By type
      report.summary.byType[log.type] = (report.summary.byType[log.type] || 0) + 1;
      
      // By severity
      report.summary.bySeverity[log.severity] = (report.summary.bySeverity[log.severity] || 0) + 1;
      
      // By user
      if (log.userId) {
        report.summary.byUser[log.userId] = (report.summary.byUser[log.userId] || 0) + 1;
      }
      
      // Security metrics
      if (log.type === AuditEventType.AUTH_LOGIN || log.type === AuditEventType.AUTH_FAILED) {
        report.security.authenticationAttempts++;
        if (log.type === AuditEventType.AUTH_FAILED) {
          report.security.failedAuthentications++;
        }
      }
      
      if (log.type === AuditEventType.CONFIG_CHANGED) {
        report.security.configurationChanges++;
      }
      
      if (log.type === AuditEventType.SECURITY_THREAT_DETECTED) {
        report.security.threatsDetected++;
      }
    }
    
    return report;
  }
  
  /**
   * Export audit logs
   */
  async exportLogs(criteria, format = 'json') {
    const logs = await this.queryLogs(criteria);
    
    if (format === 'json') {
      return JSON.stringify(logs, null, 2);
    } else if (format === 'csv') {
      return this.convertToCSV(logs);
    } else {
      throw new Error(`Unsupported export format: ${format}`);
    }
  }
  
  /**
   * Convert to CSV
   */
  convertToCSV(logs) {
    if (logs.length === 0) return '';
    
    const headers = Object.keys(logs[0]).filter(k => k !== 'data');
    let csv = headers.join(',') + '\n';
    
    for (const log of logs) {
      const values = headers.map(h => {
        const value = log[h];
        if (typeof value === 'string' && value.includes(',')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      });
      csv += values.join(',') + '\n';
    }
    
    return csv;
  }
  
  /**
   * Rotate log file
   */
  async rotateLogFile() {
    try {
      // Flush any pending writes
      await this.flushBuffer();
      
      // Generate new filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `audit_${timestamp}.log`;
      this.currentFile = path.join(this.logPath, filename);
      
      // Compress old file if exists
      if (this.config.compressionEnabled) {
        await this.compressOldLogs();
      }
      
      // Clean up old logs
      await this.cleanupOldLogs();
      
      this.stats.rotations++;
      
      logger.info('Audit log rotated', { file: filename });
      
    } catch (error) {
      logger.error('Failed to rotate audit log:', error);
    }
  }
  
  /**
   * Compress old logs
   */
  async compressOldLogs() {
    // In production, use zlib or similar
    // Implementation omitted for brevity
  }
  
  /**
   * Clean up old logs
   */
  async cleanupOldLogs() {
    try {
      const files = await fs.readdir(this.logPath);
      const now = Date.now();
      
      for (const file of files) {
        const filePath = path.join(this.logPath, file);
        const stats = await fs.stat(filePath);
        
        if (now - stats.mtime.getTime() > this.config.retention) {
          await fs.unlink(filePath);
          logger.info('Deleted old audit log', { file });
        }
      }
      
    } catch (error) {
      logger.error('Failed to cleanup old logs:', error);
    }
  }
  
  /**
   * Generate event ID
   */
  generateEventId() {
    return `evt_${Date.now()}_${randomBytes(8).toString('hex')}`;
  }
  
  /**
   * Generate session ID
   */
  generateSessionId() {
    return `ses_${Date.now()}_${randomBytes(16).toString('hex')}`;
  }
  
  /**
   * Generate entry hash
   */
  generateEntryHash(entry) {
    const data = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
      sequenceNumber: entry.sequenceNumber,
      type: entry.type,
      severity: entry.severity,
      userId: entry.userId,
      data: entry.data,
      previousHash: entry.previousHash
    });
    
    return createHash('sha256').update(data).digest('hex');
  }
  
  /**
   * Generate initial hash
   */
  generateInitialHash() {
    return createHash('sha256')
      .update(this.sessionId + this.config.complianceMode)
      .digest('hex');
  }
  
  /**
   * Encrypt log line
   */
  async encryptLogLine(line) {
    // Use configured encryption
    return CryptoUtils.encrypt(line, this.config.encryptionKey);
  }
  
  /**
   * Sanitize config for logging
   */
  sanitizeConfig(config) {
    const sanitized = { ...config };
    
    // Remove sensitive fields
    delete sanitized.encryptionKey;
    delete sanitized.databasePassword;
    
    return sanitized;
  }
  
  /**
   * Update statistics
   */
  updateStatistics(entry) {
    this.stats.eventsLogged++;
    
    // By type
    const typeCount = this.stats.eventsByType.get(entry.type) || 0;
    this.stats.eventsByType.set(entry.type, typeCount + 1);
    
    // By severity
    const severityCount = this.stats.eventsBySeverity.get(entry.severity) || 0;
    this.stats.eventsBySeverity.set(entry.severity, severityCount + 1);
  }
  
  /**
   * Start rotation timer
   */
  startRotationTimer() {
    this.rotationTimer = setInterval(() => {
      this.rotateLogFile();
    }, this.config.rotationInterval);
  }
  
  /**
   * Get statistics
   */
  getStatistics() {
    return {
      ...this.stats,
      eventsByType: Object.fromEntries(this.stats.eventsByType),
      eventsBySeverity: Object.fromEntries(this.stats.eventsBySeverity),
      anomaliesCurrent: this.anomalies.length,
      bufferSize: this.writeBuffer.length
    };
  }
  
  /**
   * Shutdown audit logger
   */
  async shutdown() {
    // Log shutdown event
    await this.logEvent({
      type: AuditEventType.SYSTEM_STOPPED,
      severity: AuditSeverity.INFO
    });
    
    // Flush buffer
    await this.flushBuffer();
    
    // Clear timers
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
    }
    
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    
    // Close database
    if (this.database) {
      this.database.close();
    }
    
    this.removeAllListeners();
    logger.info('Audit logger shutdown');
  }
}

/**
 * Singleton instance
 */
let auditLoggerInstance = null;

/**
 * Get audit logger instance
 */
export function getAuditLogger(config) {
  if (!auditLoggerInstance) {
    auditLoggerInstance = new AuditLogger(config);
  }
  return auditLoggerInstance;
}

/**
 * Create audit logger
 */
export function createAuditLogger(config) {
  return new AuditLogger(config);
}

export default AuditLogger;