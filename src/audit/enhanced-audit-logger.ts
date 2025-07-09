/**
 * Enhanced Audit Logger
 * Following Carmack/Martin/Pike principles:
 * - Comprehensive logging without performance impact
 * - Structured and searchable logs
 * - Privacy-conscious implementation
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { Database } from 'sqlite3';
import * as crypto from 'crypto';
import { promisify } from 'util';

interface AuditEvent {
  id?: string;
  timestamp: Date;
  eventType: AuditEventType;
  userId?: string;
  username?: string;
  ipAddress?: string;
  userAgent?: string;
  resource: string;
  action: AuditAction;
  result: 'success' | 'failure';
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, any>;
  dataHash?: string; // Hash of sensitive data for integrity
  duration?: number; // Operation duration in ms
}

enum AuditEventType {
  // Authentication
  LOGIN = 'LOGIN',
  LOGOUT = 'LOGOUT',
  LOGIN_FAILED = 'LOGIN_FAILED',
  PASSWORD_CHANGE = 'PASSWORD_CHANGE',
  
  // Authorization
  ACCESS_GRANTED = 'ACCESS_GRANTED',
  ACCESS_DENIED = 'ACCESS_DENIED',
  PERMISSION_CHANGE = 'PERMISSION_CHANGE',
  
  // Data operations
  DATA_CREATE = 'DATA_CREATE',
  DATA_READ = 'DATA_READ',
  DATA_UPDATE = 'DATA_UPDATE',
  DATA_DELETE = 'DATA_DELETE',
  
  // Mining operations
  SHARE_SUBMITTED = 'SHARE_SUBMITTED',
  SHARE_ACCEPTED = 'SHARE_ACCEPTED',
  SHARE_REJECTED = 'SHARE_REJECTED',
  BLOCK_FOUND = 'BLOCK_FOUND',
  
  // Payment operations
  PAYMENT_INITIATED = 'PAYMENT_INITIATED',
  PAYMENT_COMPLETED = 'PAYMENT_COMPLETED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  
  // System events
  CONFIG_CHANGE = 'CONFIG_CHANGE',
  SYSTEM_START = 'SYSTEM_START',
  SYSTEM_STOP = 'SYSTEM_STOP',
  ERROR_OCCURRED = 'ERROR_OCCURRED',
  
  // Security events
  SECURITY_ALERT = 'SECURITY_ALERT',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY'
}

enum AuditAction {
  CREATE = 'CREATE',
  READ = 'READ',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  EXECUTE = 'EXECUTE',
  AUTHENTICATE = 'AUTHENTICATE',
  AUTHORIZE = 'AUTHORIZE'
}

interface AuditLoggerOptions {
  dbPath: string;
  logPath?: string;
  maxFileSize?: number;
  maxFiles?: number;
  compressionEnabled?: boolean;
  encryptionKey?: string;
  retentionDays?: number;
  realtime?: boolean;
  bufferSize?: number;
  flushInterval?: number;
}

export class EnhancedAuditLogger extends EventEmitter {
  private db: Database;
  private options: Required<AuditLoggerOptions>;
  private buffer: AuditEvent[] = [];
  private flushTimer?: NodeJS.Timer;
  private currentLogFile?: fs.WriteStream;
  private currentLogSize = 0;
  private encryptionKey?: Buffer;

  constructor(options: AuditLoggerOptions) {
    super();
    
    this.options = {
      logPath: path.join(process.cwd(), 'logs', 'audit'),
      maxFileSize: 100 * 1024 * 1024, // 100MB
      maxFiles: 30,
      compressionEnabled: true,
      retentionDays: 90,
      realtime: false,
      bufferSize: 1000,
      flushInterval: 5000,
      ...options
    };
    
    this.db = new Database(this.options.dbPath);
    
    if (this.options.encryptionKey) {
      this.encryptionKey = crypto.createHash('sha256')
        .update(this.options.encryptionKey)
        .digest();
    }
    
    this.initialize();
  }

  /**
   * Initialize the audit logger
   */
  private async initialize(): Promise<void> {
    // Create database schema
    await this.createSchema();
    
    // Create log directory
    if (!fs.existsSync(this.options.logPath)) {
      fs.mkdirSync(this.options.logPath, { recursive: true });
    }
    
    // Open log file
    this.rotateLogFile();
    
    // Start flush timer
    if (!this.options.realtime) {
      this.flushTimer = setInterval(() => this.flush(), this.options.flushInterval);
    }
    
    // Cleanup old logs
    this.scheduleCleanup();
  }

  /**
   * Create database schema
   */
  private async createSchema(): Promise<void> {
    const schema = `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        user_id TEXT,
        username TEXT,
        ip_address TEXT,
        user_agent TEXT,
        resource TEXT NOT NULL,
        action TEXT NOT NULL,
        result TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        metadata TEXT,
        data_hash TEXT,
        duration INTEGER,
        INDEX idx_timestamp (timestamp),
        INDEX idx_event_type (event_type),
        INDEX idx_user_id (user_id),
        INDEX idx_resource (resource),
        INDEX idx_result (result)
      );
      
      CREATE INDEX IF NOT EXISTS idx_audit_search 
      ON audit_logs(timestamp, event_type, user_id, resource);
      
      CREATE INDEX IF NOT EXISTS idx_audit_analysis
      ON audit_logs(event_type, result, timestamp);
    `;
    
    await this.runAsync(schema);
  }

  /**
   * Log an audit event
   */
  async log(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void> {
    const auditEvent: AuditEvent = {
      id: this.generateEventId(),
      timestamp: new Date(),
      ...event
    };
    
    // Add to buffer
    this.buffer.push(auditEvent);
    
    // Emit event for real-time monitoring
    this.emit('audit', auditEvent);
    
    // Flush if buffer is full or realtime is enabled
    if (this.options.realtime || this.buffer.length >= this.options.bufferSize) {
      await this.flush();
    }
  }

  /**
   * Flush buffer to storage
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    const events = [...this.buffer];
    this.buffer = [];
    
    // Write to database
    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (
        id, timestamp, event_type, user_id, username,
        ip_address, user_agent, resource, action, result,
        error_code, error_message, metadata, data_hash, duration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const event of events) {
      stmt.run(
        event.id,
        event.timestamp.getTime(),
        event.eventType,
        event.userId || null,
        event.username || null,
        event.ipAddress || null,
        event.userAgent || null,
        event.resource,
        event.action,
        event.result,
        event.errorCode || null,
        event.errorMessage || null,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.dataHash || null,
        event.duration || null
      );
      
      // Write to file
      await this.writeToFile(event);
    }
    
    stmt.finalize();
  }

  /**
   * Write event to log file
   */
  private async writeToFile(event: AuditEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    const lineBuffer = Buffer.from(line);
    
    // Encrypt if enabled
    const data = this.encryptionKey 
      ? this.encrypt(lineBuffer)
      : lineBuffer;
    
    // Check if rotation is needed
    if (this.currentLogSize + data.length > this.options.maxFileSize) {
      await this.rotateLogFile();
    }
    
    // Write to file
    await new Promise<void>((resolve, reject) => {
      this.currentLogFile!.write(data, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    this.currentLogSize += data.length;
  }

  /**
   * Rotate log files
   */
  private async rotateLogFile(): Promise<void> {
    // Close current file
    if (this.currentLogFile) {
      await new Promise<void>((resolve) => {
        this.currentLogFile!.end(() => resolve());
      });
      
      // Compress if enabled
      if (this.options.compressionEnabled) {
        await this.compressLogFile(this.currentLogFile.path as string);
      }
    }
    
    // Create new file
    const filename = `audit-${Date.now()}.log`;
    const filepath = path.join(this.options.logPath, filename);
    
    this.currentLogFile = fs.createWriteStream(filepath, { flags: 'a' });
    this.currentLogSize = 0;
    
    // Clean up old files
    await this.cleanupOldFiles();
  }

  /**
   * Compress log file
   */
  private async compressLogFile(filepath: string): Promise<void> {
    const zlib = require('zlib');
    const gzip = zlib.createGzip();
    
    const source = fs.createReadStream(filepath);
    const destination = fs.createWriteStream(`${filepath}.gz`);
    
    await new Promise<void>((resolve, reject) => {
      source
        .pipe(gzip)
        .pipe(destination)
        .on('finish', () => {
          fs.unlinkSync(filepath);
          resolve();
        })
        .on('error', reject);
    });
  }

  /**
   * Clean up old log files
   */
  private async cleanupOldFiles(): Promise<void> {
    const files = fs.readdirSync(this.options.logPath)
      .filter(f => f.startsWith('audit-'))
      .map(f => ({
        name: f,
        path: path.join(this.options.logPath, f),
        mtime: fs.statSync(path.join(this.options.logPath, f)).mtime
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    
    // Remove files beyond retention
    const cutoffDate = Date.now() - (this.options.retentionDays * 24 * 60 * 60 * 1000);
    
    for (const file of files) {
      if (file.mtime.getTime() < cutoffDate || files.indexOf(file) >= this.options.maxFiles) {
        fs.unlinkSync(file.path);
      }
    }
  }

  /**
   * Schedule periodic cleanup
   */
  private scheduleCleanup(): void {
    // Run cleanup daily
    setInterval(() => {
      this.cleanupOldRecords();
    }, 24 * 60 * 60 * 1000);
    
    // Run initial cleanup
    this.cleanupOldRecords();
  }

  /**
   * Clean up old database records
   */
  private async cleanupOldRecords(): Promise<void> {
    const cutoffDate = Date.now() - (this.options.retentionDays * 24 * 60 * 60 * 1000);
    
    await this.runAsync(
      'DELETE FROM audit_logs WHERE timestamp < ?',
      [cutoffDate]
    );
  }

  /**
   * Search audit logs
   */
  async search(criteria: {
    startDate?: Date;
    endDate?: Date;
    eventTypes?: AuditEventType[];
    userId?: string;
    resource?: string;
    result?: 'success' | 'failure';
    limit?: number;
    offset?: number;
  }): Promise<AuditEvent[]> {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: any[] = [];
    
    if (criteria.startDate) {
      query += ' AND timestamp >= ?';
      params.push(criteria.startDate.getTime());
    }
    
    if (criteria.endDate) {
      query += ' AND timestamp <= ?';
      params.push(criteria.endDate.getTime());
    }
    
    if (criteria.eventTypes && criteria.eventTypes.length > 0) {
      query += ` AND event_type IN (${criteria.eventTypes.map(() => '?').join(',')})`;
      params.push(...criteria.eventTypes);
    }
    
    if (criteria.userId) {
      query += ' AND user_id = ?';
      params.push(criteria.userId);
    }
    
    if (criteria.resource) {
      query += ' AND resource LIKE ?';
      params.push(`%${criteria.resource}%`);
    }
    
    if (criteria.result) {
      query += ' AND result = ?';
      params.push(criteria.result);
    }
    
    query += ' ORDER BY timestamp DESC';
    
    if (criteria.limit) {
      query += ' LIMIT ?';
      params.push(criteria.limit);
      
      if (criteria.offset) {
        query += ' OFFSET ?';
        params.push(criteria.offset);
      }
    }
    
    const rows = await this.allAsync(query, params);
    
    return rows.map(row => ({
      ...row,
      timestamp: new Date(row.timestamp),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    }));
  }

  /**
   * Generate analytics report
   */
  async generateAnalytics(period: 'day' | 'week' | 'month'): Promise<{
    summary: Record<string, number>;
    topUsers: Array<{ userId: string; count: number }>;
    topResources: Array<{ resource: string; count: number }>;
    errorRate: number;
    suspiciousActivities: number;
  }> {
    const periodMs = {
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000
    };
    
    const startDate = Date.now() - periodMs[period];
    
    // Event type summary
    const summary = await this.allAsync(`
      SELECT event_type, COUNT(*) as count
      FROM audit_logs
      WHERE timestamp >= ?
      GROUP BY event_type
    `, [startDate]);
    
    // Top users
    const topUsers = await this.allAsync(`
      SELECT user_id, COUNT(*) as count
      FROM audit_logs
      WHERE timestamp >= ? AND user_id IS NOT NULL
      GROUP BY user_id
      ORDER BY count DESC
      LIMIT 10
    `, [startDate]);
    
    // Top resources
    const topResources = await this.allAsync(`
      SELECT resource, COUNT(*) as count
      FROM audit_logs
      WHERE timestamp >= ?
      GROUP BY resource
      ORDER BY count DESC
      LIMIT 10
    `, [startDate]);
    
    // Error rate
    const errorStats = await this.getAsync(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN result = 'failure' THEN 1 ELSE 0 END) as failures
      FROM audit_logs
      WHERE timestamp >= ?
    `, [startDate]);
    
    const errorRate = errorStats.total > 0 
      ? (errorStats.failures / errorStats.total) * 100 
      : 0;
    
    // Suspicious activities
    const suspicious = await this.getAsync(`
      SELECT COUNT(*) as count
      FROM audit_logs
      WHERE timestamp >= ? 
      AND event_type IN (?, ?, ?)
    `, [
      startDate,
      AuditEventType.SECURITY_ALERT,
      AuditEventType.RATE_LIMIT_EXCEEDED,
      AuditEventType.SUSPICIOUS_ACTIVITY
    ]);
    
    return {
      summary: summary.reduce((acc, row) => {
        acc[row.event_type] = row.count;
        return acc;
      }, {} as Record<string, number>),
      topUsers,
      topResources,
      errorRate,
      suspiciousActivities: suspicious.count
    };
  }

  /**
   * Generate event ID
   */
  private generateEventId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Encrypt data
   */
  private encrypt(data: Buffer): Buffer {
    if (!this.encryptionKey) return data;
    
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey, iv);
    
    return Buffer.concat([iv, cipher.update(data), cipher.final()]);
  }

  /**
   * Decrypt data
   */
  private decrypt(data: Buffer): Buffer {
    if (!this.encryptionKey) return data;
    
    const iv = data.slice(0, 16);
    const encrypted = data.slice(16);
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, iv);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Database helper methods
   */
  private runAsync(sql: string, params: any[] = []): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private getAsync(sql: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  private allAsync(sql: string, params: any[] = []): Promise<any[]> {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Express middleware
   */
  middleware() {
    return (req: any, res: any, next: any) => {
      const startTime = Date.now();
      
      // Capture original end function
      const originalEnd = res.end;
      
      res.end = async (...args: any[]) => {
        // Calculate duration
        const duration = Date.now() - startTime;
        
        // Log the request
        await this.log({
          eventType: this.mapStatusToEventType(res.statusCode),
          userId: req.user?.id,
          username: req.user?.username,
          ipAddress: req.ip || req.connection.remoteAddress,
          userAgent: req.headers['user-agent'],
          resource: req.originalUrl || req.url,
          action: this.mapMethodToAction(req.method),
          result: res.statusCode < 400 ? 'success' : 'failure',
          errorCode: res.statusCode >= 400 ? String(res.statusCode) : undefined,
          metadata: {
            method: req.method,
            statusCode: res.statusCode,
            contentLength: res.get('content-length'),
            referer: req.headers.referer
          },
          duration
        });
        
        // Call original end
        originalEnd.apply(res, args);
      };
      
      next();
    };
  }

  /**
   * Map HTTP status to event type
   */
  private mapStatusToEventType(status: number): AuditEventType {
    if (status === 401) return AuditEventType.ACCESS_DENIED;
    if (status === 403) return AuditEventType.ACCESS_DENIED;
    if (status === 429) return AuditEventType.RATE_LIMIT_EXCEEDED;
    if (status >= 500) return AuditEventType.ERROR_OCCURRED;
    return AuditEventType.DATA_READ;
  }

  /**
   * Map HTTP method to action
   */
  private mapMethodToAction(method: string): AuditAction {
    const mapping: Record<string, AuditAction> = {
      GET: AuditAction.READ,
      POST: AuditAction.CREATE,
      PUT: AuditAction.UPDATE,
      PATCH: AuditAction.UPDATE,
      DELETE: AuditAction.DELETE
    };
    
    return mapping[method] || AuditAction.EXECUTE;
  }

  /**
   * Destroy logger
   */
  async destroy(): Promise<void> {
    // Flush remaining events
    await this.flush();
    
    // Clear timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    
    // Close files
    if (this.currentLogFile) {
      await new Promise<void>((resolve) => {
        this.currentLogFile!.end(() => resolve());
      });
    }
    
    // Close database
    await new Promise<void>((resolve) => {
      this.db.close(() => resolve());
    });
  }
}

// Export types
export { AuditEvent, AuditEventType, AuditAction };
