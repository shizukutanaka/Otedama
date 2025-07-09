/**
 * 監査ログシステム
 * セキュリティイベントとアクセス記録
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

export enum AuditEventType {
  // 認証関連
  LOGIN_SUCCESS = 'login_success',
  LOGIN_FAILURE = 'login_failure',
  LOGOUT = 'logout',
  PASSWORD_CHANGE = 'password_change',
  
  // API アクセス
  API_ACCESS = 'api_access',
  API_ERROR = 'api_error',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  
  // 管理操作
  CONFIG_CHANGE = 'config_change',
  USER_CREATED = 'user_created',
  USER_DELETED = 'user_deleted',
  PERMISSION_CHANGE = 'permission_change',
  
  // セキュリティ
  SECURITY_VIOLATION = 'security_violation',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  IP_BLOCKED = 'ip_blocked',
  
  // マイニング関連
  SHARE_SUBMITTED = 'share_submitted',
  BLOCK_FOUND = 'block_found',
  PAYOUT_PROCESSED = 'payout_processed',
  
  // システム
  SYSTEM_START = 'system_start',
  SYSTEM_STOP = 'system_stop',
  ERROR_OCCURRED = 'error_occurred'
}

export enum AuditSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

export interface AuditEvent {
  id: string;
  timestamp: Date;
  type: AuditEventType;
  severity: AuditSeverity;
  userId?: string;
  sessionId?: string;
  ip: string;
  userAgent?: string;
  action: string;
  resource?: string;
  details: Record<string, any>;
  result: 'success' | 'failure' | 'error';
  message?: string;
  checksum: string;
}

export interface AuditLogConfig {
  logDir: string;
  maxFileSize: number;
  maxFiles: number;
  rotateDaily: boolean;
  enableEncryption: boolean;
  encryptionKey?: string;
  enableIntegrityCheck: boolean;
  bufferSize: number;
  flushInterval: number;
  enableRealTimeAlerts: boolean;
  alertThresholds: {
    [key in AuditEventType]?: {
      count: number;
      timeWindow: number; // ミリ秒
    };
  };
}

export class AuditLogger extends EventEmitter {
  private config: AuditLogConfig;
  private logBuffer: AuditEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private currentLogFile?: string;
  private eventCounts = new Map<string, { count: number; firstSeen: number }>();
  private stats = {
    totalEvents: 0,
    eventsPerType: new Map<AuditEventType, number>(),
    lastFlush: new Date()
  };

  constructor(config: Partial<AuditLogConfig> = {}) {
    super();
    
    this.config = {
      logDir: './logs/audit',
      maxFileSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 30,
      rotateDaily: true,
      enableEncryption: true,
      enableIntegrityCheck: true,
      bufferSize: 100,
      flushInterval: 5000, // 5秒
      enableRealTimeAlerts: true,
      alertThresholds: {
        [AuditEventType.LOGIN_FAILURE]: { count: 5, timeWindow: 300000 }, // 5分間で5回
        [AuditEventType.SECURITY_VIOLATION]: { count: 1, timeWindow: 60000 }, // 1分間で1回
        [AuditEventType.RATE_LIMIT_EXCEEDED]: { count: 10, timeWindow: 300000 }
      },
      ...config
    };

    this.ensureLogDirectory();
    this.setupFlushTimer();
    
    console.log('[Audit Log] Initialized with config:', {
      logDir: this.config.logDir,
      maxFileSize: this.config.maxFileSize,
      enableEncryption: this.config.enableEncryption
    });
  }

  /**
   * ログディレクトリの確保
   */
  private ensureLogDirectory(): void {
    if (!fs.existsSync(this.config.logDir)) {
      fs.mkdirSync(this.config.logDir, { recursive: true });
    }
  }

  /**
   * フラッシュタイマーの設定
   */
  private setupFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.config.flushInterval);
  }

  /**
   * 監査イベントをログ
   */
  public log(
    type: AuditEventType,
    action: string,
    context: {
      userId?: string;
      sessionId?: string;
      ip: string;
      userAgent?: string;
      resource?: string;
      details?: Record<string, any>;
      result?: 'success' | 'failure' | 'error';
      message?: string;
      severity?: AuditSeverity;
    }
  ): void {
    const event: AuditEvent = {
      id: this.generateEventId(),
      timestamp: new Date(),
      type,
      severity: context.severity || this.getDefaultSeverity(type),
      userId: context.userId,
      sessionId: context.sessionId,
      ip: context.ip,
      userAgent: context.userAgent,
      action,
      resource: context.resource,
      details: context.details || {},
      result: context.result || 'success',
      message: context.message,
      checksum: ''
    };

    // チェックサムを計算
    event.checksum = this.calculateChecksum(event);

    // バッファに追加
    this.logBuffer.push(event);
    this.stats.totalEvents++;
    
    // 統計更新
    const currentCount = this.stats.eventsPerType.get(type) || 0;
    this.stats.eventsPerType.set(type, currentCount + 1);

    // リアルタイムアラートチェック
    if (this.config.enableRealTimeAlerts) {
      this.checkAlertThresholds(type, context.ip);
    }

    // バッファサイズ上限チェック
    if (this.logBuffer.length >= this.config.bufferSize) {
      this.flush();
    }

    this.emit('eventLogged', event);
  }

  /**
   * デフォルト重要度を取得
   */
  private getDefaultSeverity(type: AuditEventType): AuditSeverity {
    const criticalEvents = [
      AuditEventType.SECURITY_VIOLATION,
      AuditEventType.SUSPICIOUS_ACTIVITY
    ];
    
    const highEvents = [
      AuditEventType.LOGIN_FAILURE,
      AuditEventType.IP_BLOCKED,
      AuditEventType.PERMISSION_CHANGE
    ];

    if (criticalEvents.includes(type)) return AuditSeverity.CRITICAL;
    if (highEvents.includes(type)) return AuditSeverity.HIGH;
    return AuditSeverity.LOW;
  }

  /**
   * イベントIDを生成
   */
  private generateEventId(): string {
    const timestamp = Date.now().toString();
    const random = crypto.randomBytes(4).toString('hex');
    return `${timestamp}-${random}`;
  }

  /**
   * チェックサムを計算
   */
  private calculateChecksum(event: Omit<AuditEvent, 'checksum'>): string {
    const data = JSON.stringify(event, Object.keys(event).sort());
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * アラート閾値チェック
   */
  private checkAlertThresholds(type: AuditEventType, ip: string): void {
    const threshold = this.config.alertThresholds[type];
    if (!threshold) return;

    const key = `${type}:${ip}`;
    const now = Date.now();
    const existing = this.eventCounts.get(key);

    if (!existing) {
      this.eventCounts.set(key, { count: 1, firstSeen: now });
      return;
    }

    // 時間窓を超えた場合はリセット
    if (now - existing.firstSeen > threshold.timeWindow) {
      this.eventCounts.set(key, { count: 1, firstSeen: now });
      return;
    }

    existing.count++;

    // 閾値を超えた場合はアラート
    if (existing.count >= threshold.count) {
      this.emitAlert(type, ip, existing.count, threshold.timeWindow);
      
      // カウンターをリセット
      this.eventCounts.delete(key);
    }
  }

  /**
   * アラートを発行
   */
  private emitAlert(type: AuditEventType, ip: string, count: number, timeWindow: number): void {
    const alert = {
      type: 'audit_alert',
      eventType: type,
      ip,
      count,
      timeWindow,
      timestamp: new Date()
    };

    console.warn(`[Audit Alert] ${type} from ${ip}: ${count} events in ${timeWindow}ms`);
    this.emit('alert', alert);

    // クリティカルアラートの場合は即座にログ
    if (this.getDefaultSeverity(type) === AuditSeverity.CRITICAL) {
      this.log(AuditEventType.SECURITY_VIOLATION, 'Alert triggered', {
        ip,
        details: alert,
        severity: AuditSeverity.CRITICAL
      });
    }
  }

  /**
   * バッファをフラッシュ
   */
  public flush(): void {
    if (this.logBuffer.length === 0) return;

    const events = [...this.logBuffer];
    this.logBuffer = [];

    try {
      this.writeToFile(events);
      this.stats.lastFlush = new Date();
      this.emit('flushed', events.length);
    } catch (error) {
      console.error('[Audit Log] Failed to flush events:', error);
      // エラー時はバッファに戻す
      this.logBuffer.unshift(...events);
      this.emit('flushError', error);
    }
  }

  /**
   * ファイルに書き込み
   */
  private writeToFile(events: AuditEvent[]): void {
    const logFile = this.getCurrentLogFile();
    
    for (const event of events) {
      let logLine = JSON.stringify(event) + '\n';
      
      // 暗号化が有効な場合
      if (this.config.enableEncryption && this.config.encryptionKey) {
        logLine = this.encryptLogLine(logLine);
      }
      
      fs.appendFileSync(logFile, logLine);
    }

    // ファイルサイズチェック
    this.checkFileRotation(logFile);
  }

  /**
   * ログラインを暗号化
   */
  private encryptLogLine(data: string): string {
    if (!this.config.encryptionKey) return data;
    
    const cipher = crypto.createCipher('aes-256-cbc', this.config.encryptionKey);
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted + '\n';
  }

  /**
   * 現在のログファイル名を取得
   */
  private getCurrentLogFile(): string {
    const now = new Date();
    let filename: string;

    if (this.config.rotateDaily) {
      const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
      filename = `audit-${dateStr}.log`;
    } else {
      filename = 'audit.log';
    }

    return path.join(this.config.logDir, filename);
  }

  /**
   * ファイルローテーションチェック
   */
  private checkFileRotation(logFile: string): void {
    try {
      const stats = fs.statSync(logFile);
      
      if (stats.size >= this.config.maxFileSize) {
        this.rotateLogFile(logFile);
      }
    } catch (error) {
      console.error('[Audit Log] Failed to check file size:', error);
    }
  }

  /**
   * ログファイルをローテート
   */
  private rotateLogFile(logFile: string): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedFile = logFile.replace('.log', `-${timestamp}.log`);
    
    try {
      fs.renameSync(logFile, rotatedFile);
      console.log(`[Audit Log] Rotated log file: ${rotatedFile}`);
      
      // 古いファイルのクリーンアップ
      this.cleanupOldFiles();
      
      this.emit('fileRotated', { old: logFile, new: rotatedFile });
    } catch (error) {
      console.error('[Audit Log] Failed to rotate log file:', error);
    }
  }

  /**
   * 古いファイルをクリーンアップ
   */
  private cleanupOldFiles(): void {
    try {
      const files = fs.readdirSync(this.config.logDir)
        .filter(file => file.startsWith('audit-') && file.endsWith('.log'))
        .map(file => ({
          name: file,
          path: path.join(this.config.logDir, file),
          mtime: fs.statSync(path.join(this.config.logDir, file)).mtime
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      // 上限を超えたファイルを削除
      if (files.length > this.config.maxFiles) {
        const filesToDelete = files.slice(this.config.maxFiles);
        
        for (const file of filesToDelete) {
          fs.unlinkSync(file.path);
          console.log(`[Audit Log] Deleted old log file: ${file.name}`);
        }
      }
    } catch (error) {
      console.error('[Audit Log] Failed to cleanup old files:', error);
    }
  }

  /**
   * 特定期間のイベントを検索
   */
  public async searchEvents(
    startDate: Date,
    endDate: Date,
    filters?: {
      type?: AuditEventType;
      userId?: string;
      ip?: string;
      severity?: AuditSeverity;
    }
  ): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [];
    
    try {
      const files = fs.readdirSync(this.config.logDir)
        .filter(file => file.endsWith('.log'))
        .map(file => path.join(this.config.logDir, file));

      for (const file of files) {
        const fileEvents = await this.readEventsFromFile(file, startDate, endDate, filters);
        events.push(...fileEvents);
      }
    } catch (error) {
      console.error('[Audit Log] Failed to search events:', error);
    }

    return events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * ファイルからイベントを読み取り
   */
  private async readEventsFromFile(
    filePath: string,
    startDate: Date,
    endDate: Date,
    filters?: any
  ): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [];
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          let eventData = line;
          
          // 暗号化されている場合は復号化
          if (this.config.enableEncryption && this.config.encryptionKey) {
            eventData = this.decryptLogLine(line);
          }
          
          const event: AuditEvent = JSON.parse(eventData);
          event.timestamp = new Date(event.timestamp);
          
          // 日付フィルター
          if (event.timestamp < startDate || event.timestamp > endDate) {
            continue;
          }
          
          // その他のフィルター
          if (filters) {
            if (filters.type && event.type !== filters.type) continue;
            if (filters.userId && event.userId !== filters.userId) continue;
            if (filters.ip && event.ip !== filters.ip) continue;
            if (filters.severity && event.severity !== filters.severity) continue;
          }
          
          events.push(event);
        } catch (parseError) {
          // 個別の解析エラーは無視（ログファイルが破損している可能性）
          continue;
        }
      }
    } catch (error) {
      console.error(`[Audit Log] Failed to read file ${filePath}:`, error);
    }

    return events;
  }

  /**
   * ログラインを復号化
   */
  private decryptLogLine(encryptedData: string): string {
    if (!this.config.encryptionKey) return encryptedData;
    
    try {
      const decipher = crypto.createDecipher('aes-256-cbc', this.config.encryptionKey);
      let decrypted = decipher.update(encryptedData.trim(), 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return encryptedData; // 復号化に失敗した場合は元の値を返す
    }
  }

  /**
   * 統計情報取得
   */
  public getStats() {
    return {
      ...this.stats,
      bufferSize: this.logBuffer.length,
      eventsPerType: Object.fromEntries(this.stats.eventsPerType),
      activeAlerts: this.eventCounts.size
    };
  }

  /**
   * 設定更新
   */
  public updateConfig(newConfig: Partial<AuditLogConfig>): void {
    this.config = { ...this.config, ...newConfig };
    console.log('[Audit Log] Configuration updated');
  }

  /**
   * 停止処理
   */
  public async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }

    // 残りのバッファをフラッシュ
    this.flush();

    console.log('[Audit Log] Audit logger stopped');
    this.emit('stopped');
  }
}

// ヘルパー関数
export function createAuditMiddleware(auditLogger: AuditLogger) {
  return (req: any, res: any, next: any) => {
    const startTime = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      
      auditLogger.log(
        AuditEventType.API_ACCESS,
        `${req.method} ${req.path}`,
        {
          ip: req.ip || req.connection.remoteAddress,
          userAgent: req.headers['user-agent'],
          userId: req.user?.id,
          sessionId: req.sessionID,
          details: {
            statusCode: res.statusCode,
            duration,
            query: req.query,
            params: req.params
          },
          result: res.statusCode < 400 ? 'success' : 'error'
        }
      );
    });
    
    next();
  };
}

export default AuditLogger;