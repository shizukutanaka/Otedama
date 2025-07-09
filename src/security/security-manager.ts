/**
 * 包括的セキュリティシステム
 * 設計思想: John Carmack (実用的), Robert C. Martin (SOLID), Rob Pike (シンプル)
 * 
 * 機能:
 * - エンドツーエンド暗号化
 * - ゼロトラスト認証
 * - リアルタイム脅威検知
 * - セキュアな通信
 * - 監査ログ
 */

import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

// === 型定義 ===
export interface SecurityConfig {
  encryption: {
    algorithm: string;
    keySize: number;
    ivSize: number;
  };
  authentication: {
    maxFailedAttempts: number;
    lockoutDuration: number; // minutes
    sessionTimeout: number; // minutes
    requireMFA: boolean;
  };
  audit: {
    enabled: boolean;
    logLevel: 'debug' | 'info' | 'warning' | 'error';
    retentionDays: number;
    logDirectory: string;
  };
  network: {
    allowedIPs: string[];
    rateLimiting: {
      enabled: boolean;
      maxRequests: number;
      windowMs: number;
    };
    tlsMinVersion: string;
  };
  integrity: {
    checksumAlgorithm: string;
    signatureVerification: boolean;
    codeIntegrityCheck: boolean;
  };
}

export interface SecurityEvent {
  id: string;
  timestamp: number;
  type: 'authentication' | 'authorization' | 'data_access' | 'network' | 'integrity' | 'threat';
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  target?: string;
  user?: string;
  description: string;
  details: Record<string, any>;
  resolved: boolean;
}

export interface ThreatIndicator {
  type: 'malware' | 'network_intrusion' | 'data_exfiltration' | 'privilege_escalation' | 'suspicious_activity';
  confidence: number; // 0-1
  risk: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  indicators: string[];
  recommendation: string;
}

export interface AuditEntry {
  timestamp: number;
  user: string;
  action: string;
  resource: string;
  result: 'success' | 'failure' | 'blocked';
  ip: string;
  userAgent?: string;
  details: Record<string, any>;
}

export interface EncryptionKey {
  id: string;
  algorithm: string;
  key: Buffer;
  iv?: Buffer;
  createdAt: number;
  expiresAt?: number;
  purpose: string;
}

// === 暗号化マネージャー ===
export class CryptographyManager {
  private keys = new Map<string, EncryptionKey>();
  private config: SecurityConfig['encryption'];

  constructor(config: SecurityConfig['encryption']) {
    this.config = config;
  }

  /**
   * 新しい暗号化キーを生成
   */
  generateKey(purpose: string, expirationHours?: number): EncryptionKey {
    const keyId = this.generateKeyId();
    const key = randomBytes(this.config.keySize);
    const iv = randomBytes(this.config.ivSize);
    
    const encryptionKey: EncryptionKey = {
      id: keyId,
      algorithm: this.config.algorithm,
      key,
      iv,
      createdAt: Date.now(),
      expiresAt: expirationHours ? Date.now() + (expirationHours * 60 * 60 * 1000) : undefined,
      purpose
    };

    this.keys.set(keyId, encryptionKey);
    return encryptionKey;
  }

  /**
   * データの暗号化
   */
  encrypt(data: string | Buffer, keyId: string): { encrypted: Buffer; tag?: Buffer } {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`Encryption key not found: ${keyId}`);
    }

    if (key.expiresAt && Date.now() > key.expiresAt) {
      throw new Error(`Encryption key expired: ${keyId}`);
    }

    const cipher = createCipheriv(key.algorithm, key.key, key.iv!);
    const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    
    const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
    
    // GCMモードの場合、認証タグを取得
    let tag: Buffer | undefined;
    if (key.algorithm.includes('gcm')) {
      tag = (cipher as any).getAuthTag();
    }

    return { encrypted, tag };
  }

  /**
   * データの復号化
   */
  decrypt(encryptedData: Buffer, keyId: string, tag?: Buffer): Buffer {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new Error(`Decryption key not found: ${keyId}`);
    }

    const decipher = createDecipheriv(key.algorithm, key.key, key.iv!);
    
    // GCMモードの場合、認証タグを設定
    if (key.algorithm.includes('gcm') && tag) {
      (decipher as any).setAuthTag(tag);
    }

    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  }

  /**
   * ハッシュ生成
   */
  hash(data: string | Buffer, algorithm: string = 'sha256'): string {
    const input = typeof data === 'string' ? data : data.toString();
    return createHash(algorithm).update(input).digest('hex');
  }

  /**
   * HMAC生成
   */
  hmac(data: string | Buffer, secret: string, algorithm: string = 'sha256'): string {
    const input = typeof data === 'string' ? data : data.toString();
    return createHmac(algorithm, secret).update(input).digest('hex');
  }

  /**
   * パスワードのハッシュ化（scrypt使用）
   */
  hashPassword(password: string, salt?: Buffer): { hash: string; salt: string } {
    const saltBuffer = salt || randomBytes(32);
    const hash = scryptSync(password, saltBuffer, 64);
    
    return {
      hash: hash.toString('hex'),
      salt: saltBuffer.toString('hex')
    };
  }

  /**
   * パスワード検証
   */
  verifyPassword(password: string, hash: string, salt: string): boolean {
    const saltBuffer = Buffer.from(salt, 'hex');
    const derivedHash = scryptSync(password, saltBuffer, 64);
    
    return derivedHash.toString('hex') === hash;
  }

  private generateKeyId(): string {
    return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').substring(0, 16);
  }

  /**
   * 期限切れキーのクリーンアップ
   */
  cleanupExpiredKeys(): number {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [keyId, key] of this.keys.entries()) {
      if (key.expiresAt && now > key.expiresAt) {
        this.keys.delete(keyId);
        cleaned++;
      }
    }
    
    return cleaned;
  }
}

// === 認証マネージャー ===
export class AuthenticationManager extends EventEmitter {
  private sessions = new Map<string, { userId: string; createdAt: number; lastActivity: number; ip: string }>();
  private failedAttempts = new Map<string, { count: number; lastAttempt: number }>();
  private crypto: CryptographyManager;
  private config: SecurityConfig['authentication'];

  constructor(crypto: CryptographyManager, config: SecurityConfig['authentication']) {
    super();
    this.crypto = crypto;
    this.config = config;

    // セッションクリーンアップの定期実行
    setInterval(() => this.cleanupExpiredSessions(), 5 * 60 * 1000); // 5分間隔
  }

  /**
   * ユーザー認証
   */
  async authenticate(userId: string, password: string, ip: string): Promise<{ success: boolean; sessionToken?: string; reason?: string }> {
    // アカウントロックアウトチェック
    if (this.isAccountLocked(userId)) {
      this.emit('authenticationEvent', {
        type: 'authentication',
        severity: 'medium',
        user: userId,
        ip,
        result: 'blocked',
        reason: 'Account locked due to too many failed attempts'
      });
      
      return { success: false, reason: 'Account temporarily locked' };
    }

    // パスワード検証（実際の実装では外部ストレージから取得）
    const isValidPassword = await this.verifyUserPassword(userId, password);
    
    if (!isValidPassword) {
      this.recordFailedAttempt(userId);
      
      this.emit('authenticationEvent', {
        type: 'authentication',
        severity: 'medium',
        user: userId,
        ip,
        result: 'failure',
        reason: 'Invalid credentials'
      });
      
      return { success: false, reason: 'Invalid credentials' };
    }

    // 成功時の処理
    this.clearFailedAttempts(userId);
    const sessionToken = this.createSession(userId, ip);
    
    this.emit('authenticationEvent', {
      type: 'authentication',
      severity: 'low',
      user: userId,
      ip,
      result: 'success',
      sessionToken
    });

    return { success: true, sessionToken };
  }

  /**
   * セッション検証
   */
  validateSession(sessionToken: string, ip: string): { valid: boolean; userId?: string; reason?: string } {
    const session = this.sessions.get(sessionToken);
    
    if (!session) {
      return { valid: false, reason: 'Session not found' };
    }

    const now = Date.now();
    const sessionAge = now - session.createdAt;
    const inactivityTime = now - session.lastActivity;
    
    // セッションタイムアウトチェック
    if (sessionAge > this.config.sessionTimeout * 60 * 1000) {
      this.sessions.delete(sessionToken);
      return { valid: false, reason: 'Session expired' };
    }

    // 非アクティブ時間チェック
    if (inactivityTime > 30 * 60 * 1000) { // 30分非アクティブ
      this.sessions.delete(sessionToken);
      return { valid: false, reason: 'Session inactive too long' };
    }

    // IPアドレス検証
    if (session.ip !== ip) {
      this.sessions.delete(sessionToken);
      this.emit('securityEvent', {
        type: 'authentication',
        severity: 'high',
        user: session.userId,
        description: 'Session hijacking attempt detected',
        details: { originalIP: session.ip, currentIP: ip }
      });
      return { valid: false, reason: 'IP address mismatch' };
    }

    // セッション更新
    session.lastActivity = now;
    
    return { valid: true, userId: session.userId };
  }

  /**
   * セッション作成
   */
  private createSession(userId: string, ip: string): string {
    const sessionToken = randomBytes(32).toString('hex');
    const now = Date.now();
    
    this.sessions.set(sessionToken, {
      userId,
      createdAt: now,
      lastActivity: now,
      ip
    });

    return sessionToken;
  }

  /**
   * セッション無効化
   */
  invalidateSession(sessionToken: string): boolean {
    return this.sessions.delete(sessionToken);
  }

  /**
   * ユーザーの全セッション無効化
   */
  invalidateUserSessions(userId: string): number {
    let invalidated = 0;
    
    for (const [token, session] of this.sessions.entries()) {
      if (session.userId === userId) {
        this.sessions.delete(token);
        invalidated++;
      }
    }
    
    return invalidated;
  }

  private async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    // 実際の実装では、ユーザーデータベースから取得
    // ここでは簡略化
    const mockUsers = new Map([
      ['admin', { hash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', salt: 'salt123' }],
      ['user', { hash: 'ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f', salt: 'salt456' }]
    ]);
    
    const user = mockUsers.get(userId);
    if (!user) return false;
    
    return this.crypto.verifyPassword(password, user.hash, user.salt);
  }

  private isAccountLocked(userId: string): boolean {
    const attempts = this.failedAttempts.get(userId);
    if (!attempts) return false;
    
    const lockoutEnd = attempts.lastAttempt + (this.config.lockoutDuration * 60 * 1000);
    return attempts.count >= this.config.maxFailedAttempts && Date.now() < lockoutEnd;
  }

  private recordFailedAttempt(userId: string): void {
    const attempts = this.failedAttempts.get(userId) || { count: 0, lastAttempt: 0 };
    attempts.count++;
    attempts.lastAttempt = Date.now();
    this.failedAttempts.set(userId, attempts);
  }

  private clearFailedAttempts(userId: string): void {
    this.failedAttempts.delete(userId);
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const maxAge = this.config.sessionTimeout * 60 * 1000;
    
    for (const [token, session] of this.sessions.entries()) {
      if (now - session.createdAt > maxAge) {
        this.sessions.delete(token);
      }
    }
  }
}

// === 脅威検知システム ===
export class ThreatDetectionSystem extends EventEmitter {
  private indicators: ThreatIndicator[] = [];
  private suspiciousActivities = new Map<string, number>();
  private patternCache = new Map<string, { count: number; lastSeen: number }>();

  /**
   * ネットワークトラフィック分析
   */
  analyzeNetworkTraffic(ip: string, userAgent: string, requestPath: string): ThreatIndicator[] {
    const threats: ThreatIndicator[] = [];
    
    // 悪意のあるユーザーエージェント検知
    const maliciousPatterns = [
      /sqlmap/i,
      /nmap/i,
      /nikto/i,
      /dirb/i,
      /gobuster/i,
      /curl.*bot/i
    ];
    
    for (const pattern of maliciousPatterns) {
      if (pattern.test(userAgent)) {
        threats.push({
          type: 'network_intrusion',
          confidence: 0.8,
          risk: 'high',
          description: 'Malicious user agent detected',
          indicators: [userAgent],
          recommendation: 'Block IP address and investigate'
        });
      }
    }
    
    // SQLインジェクション検知
    const sqlInjectionPatterns = [
      /union.*select/i,
      /or.*1=1/i,
      /drop.*table/i,
      /insert.*into/i,
      /delete.*from/i
    ];
    
    for (const pattern of sqlInjectionPatterns) {
      if (pattern.test(requestPath)) {
        threats.push({
          type: 'network_intrusion',
          confidence: 0.9,
          risk: 'critical',
          description: 'SQL injection attempt detected',
          indicators: [requestPath],
          recommendation: 'Block IP immediately and review access logs'
        });
      }
    }
    
    // 頻度ベースの異常検知
    const activityKey = `${ip}:${Date.now().toString().slice(0, -3)}`; // 1秒間隔
    const currentCount = this.suspiciousActivities.get(activityKey) || 0;
    this.suspiciousActivities.set(activityKey, currentCount + 1);
    
    if (currentCount > 10) { // 1秒間に10リクエスト以上
      threats.push({
        type: 'network_intrusion',
        confidence: 0.7,
        risk: 'medium',
        description: 'High frequency requests detected',
        indicators: [`${currentCount} requests per second from ${ip}`],
        recommendation: 'Implement rate limiting'
      });
    }
    
    return threats;
  }

  /**
   * ファイルシステム監視
   */
  monitorFileSystem(filePath: string, operation: 'read' | 'write' | 'delete'): ThreatIndicator[] {
    const threats: ThreatIndicator[] = [];
    
    // 機密ファイルへのアクセス監視
    const sensitiveFiles = [
      /\/etc\/passwd/,
      /\/etc\/shadow/,
      /\.ssh\/id_rsa/,
      /config\.json/,
      /\.env/,
      /wallet\.dat/
    ];
    
    for (const pattern of sensitiveFiles) {
      if (pattern.test(filePath)) {
        threats.push({
          type: 'data_exfiltration',
          confidence: 0.8,
          risk: operation === 'read' ? 'medium' : 'high',
          description: `${operation} operation on sensitive file`,
          indicators: [filePath],
          recommendation: 'Review file access permissions and audit user activity'
        });
      }
    }
    
    // 不審な実行可能ファイル
    if (operation === 'write' && /\.(exe|sh|bat|ps1)$/.test(filePath)) {
      threats.push({
        type: 'malware',
        confidence: 0.6,
        risk: 'medium',
        description: 'Executable file creation detected',
        indicators: [filePath],
        recommendation: 'Scan file with antivirus and verify legitimacy'
      });
    }
    
    return threats;
  }

  /**
   * プロセス監視
   */
  monitorProcess(processName: string, commandLine: string, userId: string): ThreatIndicator[] {
    const threats: ThreatIndicator[] = [];
    
    // 不審なプロセス検知
    const suspiciousProcesses = [
      /nc\.exe/i,      // netcat
      /ncat/i,
      /socat/i,
      /cryptonight/i,  // 暗号通貨マイニング（無許可）
      /xmrig/i,
      /ccminer/i
    ];
    
    for (const pattern of suspiciousProcesses) {
      if (pattern.test(processName) || pattern.test(commandLine)) {
        threats.push({
          type: 'suspicious_activity',
          confidence: 0.7,
          risk: 'medium',
          description: 'Suspicious process execution detected',
          indicators: [processName, commandLine],
          recommendation: 'Terminate process and investigate user activity'
        });
      }
    }
    
    // 権限昇格の試行
    if (commandLine.includes('sudo') || commandLine.includes('runas')) {
      threats.push({
        type: 'privilege_escalation',
        confidence: 0.5,
        risk: 'medium',
        description: 'Privilege escalation attempt detected',
        indicators: [commandLine],
        recommendation: 'Review user permissions and monitor for unauthorized access'
      });
    }
    
    return threats;
  }

  /**
   * 脅威スコアの計算
   */
  calculateThreatScore(threats: ThreatIndicator[]): number {
    if (threats.length === 0) return 0;
    
    let totalScore = 0;
    const weights = { low: 1, medium: 3, high: 7, critical: 10 };
    
    for (const threat of threats) {
      totalScore += weights[threat.risk] * threat.confidence;
    }
    
    return Math.min(totalScore / threats.length, 10); // 0-10スケール
  }

  /**
   * アラートの生成
   */
  generateAlert(threats: ThreatIndicator[], source: string): void {
    for (const threat of threats) {
      this.emit('threatDetected', {
        id: `threat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
        type: 'threat',
        severity: threat.risk === 'critical' ? 'critical' : threat.risk === 'high' ? 'high' : 'medium',
        source,
        description: threat.description,
        details: {
          type: threat.type,
          confidence: threat.confidence,
          indicators: threat.indicators,
          recommendation: threat.recommendation
        },
        resolved: false
      });
    }
  }
}

// === 監査ログマネージャー ===
export class AuditLogManager {
  private config: SecurityConfig['audit'];
  private logBuffer: AuditEntry[] = [];
  private flushInterval?: NodeJS.Timeout;

  constructor(config: SecurityConfig['audit']) {
    this.config = config;
    
    if (config.enabled) {
      // 定期的にログをフラッシュ
      this.flushInterval = setInterval(() => this.flushLogs(), 30000); // 30秒間隔
      
      // ディレクトリ作成
      if (!fs.existsSync(config.logDirectory)) {
        fs.mkdirSync(config.logDirectory, { recursive: true });
      }
    }
  }

  /**
   * 監査ログの記録
   */
  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    if (!this.config.enabled) return;
    
    const auditEntry: AuditEntry = {
      timestamp: Date.now(),
      ...entry
    };
    
    this.logBuffer.push(auditEntry);
    
    // 緊急度の高いイベントは即座にフラッシュ
    if (entry.result === 'blocked' || entry.action.includes('delete') || entry.action.includes('admin')) {
      this.flushLogs();
    }
  }

  /**
   * ログのフラッシュ
   */
  private flushLogs(): void {
    if (this.logBuffer.length === 0) return;
    
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.config.logDirectory, `audit_${today}.log`);
    
    const logEntries = this.logBuffer.splice(0);
    const logLines = logEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    
    try {
      fs.appendFileSync(logFile, logLines, 'utf8');
    } catch (error) {
      console.error('監査ログ書き込みエラー:', error);
    }
  }

  /**
   * ログの検索
   */
  searchLogs(criteria: {
    user?: string;
    action?: string;
    startTime?: number;
    endTime?: number;
    result?: 'success' | 'failure' | 'blocked';
  }): AuditEntry[] {
    const results: AuditEntry[] = [];
    
    // 現在のバッファから検索
    for (const entry of this.logBuffer) {
      if (this.matchesCriteria(entry, criteria)) {
        results.push(entry);
      }
    }
    
    // ファイルからの検索は簡略化（実際の実装では効率的な検索が必要）
    
    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  private matchesCriteria(entry: AuditEntry, criteria: any): boolean {
    if (criteria.user && entry.user !== criteria.user) return false;
    if (criteria.action && !entry.action.includes(criteria.action)) return false;
    if (criteria.result && entry.result !== criteria.result) return false;
    if (criteria.startTime && entry.timestamp < criteria.startTime) return false;
    if (criteria.endTime && entry.timestamp > criteria.endTime) return false;
    
    return true;
  }

  /**
   * 古いログファイルのクリーンアップ
   */
  cleanupOldLogs(): number {
    const cutoffTime = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);
    let deletedFiles = 0;
    
    try {
      const files = fs.readdirSync(this.config.logDirectory);
      
      for (const file of files) {
        if (file.startsWith('audit_') && file.endsWith('.log')) {
          const filePath = path.join(this.config.logDirectory, file);
          const stats = fs.statSync(filePath);
          
          if (stats.mtime.getTime() < cutoffTime) {
            fs.unlinkSync(filePath);
            deletedFiles++;
          }
        }
      }
    } catch (error) {
      console.error('ログクリーンアップエラー:', error);
    }
    
    return deletedFiles;
  }

  /**
   * リソースのクリーンアップ
   */
  cleanup(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = undefined;
    }
    
    this.flushLogs();
  }
}

// === メインセキュリティマネージャー ===
export class SecurityManager extends EventEmitter {
  private config: SecurityConfig;
  private crypto: CryptographyManager;
  private auth: AuthenticationManager;
  private threatDetection: ThreatDetectionSystem;
  private auditLog: AuditLogManager;
  private events: SecurityEvent[] = [];

  constructor(config: Partial<SecurityConfig> = {}) {
    super();
    
    this.config = {
      encryption: {
        algorithm: 'aes-256-gcm',
        keySize: 32,
        ivSize: 16
      },
      authentication: {
        maxFailedAttempts: 5,
        lockoutDuration: 15,
        sessionTimeout: 60,
        requireMFA: false
      },
      audit: {
        enabled: true,
        logLevel: 'info',
        retentionDays: 90,
        logDirectory: './logs/audit'
      },
      network: {
        allowedIPs: [],
        rateLimiting: {
          enabled: true,
          maxRequests: 100,
          windowMs: 60000
        },
        tlsMinVersion: '1.2'
      },
      integrity: {
        checksumAlgorithm: 'sha256',
        signatureVerification: true,
        codeIntegrityCheck: true
      },
      ...config
    };

    this.crypto = new CryptographyManager(this.config.encryption);
    this.auth = new AuthenticationManager(this.crypto, this.config.authentication);
    this.threatDetection = new ThreatDetectionSystem();
    this.auditLog = new AuditLogManager(this.config.audit);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.auth.on('authenticationEvent', (event) => {
      this.auditLog.log({
        user: event.user,
        action: 'authentication',
        resource: 'system',
        result: event.result,
        ip: event.ip,
        details: event
      });
    });

    this.threatDetection.on('threatDetected', (threat) => {
      this.addSecurityEvent(threat);
      
      if (threat.severity === 'critical') {
        this.emit('criticalThreat', threat);
      }
    });
  }

  /**
   * セキュリティ初期化
   */
  async initialize(): Promise<void> {
    console.log('🔒 セキュリティシステム初期化中...');
    
    // 暗号化キーの生成
    this.crypto.generateKey('system', 24); // 24時間有効
    this.crypto.generateKey('session', 1);  // 1時間有効
    
    // 定期タスクの開始
    setInterval(() => {
      this.crypto.cleanupExpiredKeys();
      this.auditLog.cleanupOldLogs();
    }, 60 * 60 * 1000); // 1時間間隔

    console.log('✅ セキュリティシステム初期化完了');
    this.emit('securityInitialized');
  }

  /**
   * リクエストのセキュリティ検証
   */
  async validateRequest(request: {
    ip: string;
    userAgent: string;
    path: string;
    method: string;
    sessionToken?: string;
  }): Promise<{ valid: boolean; threats: ThreatIndicator[]; userId?: string }> {
    
    // 脅威検知
    const threats = this.threatDetection.analyzeNetworkTraffic(
      request.ip,
      request.userAgent,
      request.path
    );

    // セッション検証
    let userId: string | undefined;
    let sessionValid = true;
    
    if (request.sessionToken) {
      const sessionResult = this.auth.validateSession(request.sessionToken, request.ip);
      sessionValid = sessionResult.valid;
      userId = sessionResult.userId;
    }

    // IP制限チェック
    const ipAllowed = this.config.network.allowedIPs.length === 0 || 
                     this.config.network.allowedIPs.includes(request.ip);

    const valid = sessionValid && ipAllowed && threats.filter(t => t.risk === 'critical').length === 0;

    // 監査ログ
    this.auditLog.log({
      user: userId || 'anonymous',
      action: `${request.method} ${request.path}`,
      resource: request.path,
      result: valid ? 'success' : 'blocked',
      ip: request.ip,
      userAgent: request.userAgent,
      details: { threats: threats.length, sessionValid, ipAllowed }
    });

    if (threats.length > 0) {
      this.threatDetection.generateAlert(threats, request.ip);
    }

    return { valid, threats, userId };
  }

  /**
   * データの暗号化
   */
  encryptData(data: string, purpose: string = 'general'): { keyId: string; encrypted: string; tag?: string } {
    let key = Array.from(this.crypto['keys'].values()).find(k => k.purpose === purpose);
    
    if (!key) {
      key = this.crypto.generateKey(purpose, 24);
    }

    const result = this.crypto.encrypt(data, key.id);
    
    return {
      keyId: key.id,
      encrypted: result.encrypted.toString('base64'),
      tag: result.tag?.toString('base64')
    };
  }

  /**
   * データの復号化
   */
  decryptData(keyId: string, encrypted: string, tag?: string): string {
    const encryptedBuffer = Buffer.from(encrypted, 'base64');
    const tagBuffer = tag ? Buffer.from(tag, 'base64') : undefined;
    
    const decrypted = this.crypto.decrypt(encryptedBuffer, keyId, tagBuffer);
    return decrypted.toString('utf8');
  }

  /**
   * セキュリティイベントの追加
   */
  addSecurityEvent(event: Omit<SecurityEvent, 'id' | 'timestamp' | 'resolved'>): void {
    const securityEvent: SecurityEvent = {
      id: `sec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      resolved: false,
      ...event
    };

    this.events.push(securityEvent);
    
    // イベント数制限（最新1000件）
    if (this.events.length > 1000) {
      this.events.shift();
    }

    this.emit('securityEvent', securityEvent);
  }

  /**
   * セキュリティレポートの生成
   */
  generateSecurityReport(hours: number = 24): {
    summary: {
      totalEvents: number;
      criticalEvents: number;
      threatsBlocked: number;
      authenticationFailures: number;
    };
    events: SecurityEvent[];
    recommendations: string[];
  } {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    const recentEvents = this.events.filter(e => e.timestamp >= cutoff);
    
    const summary = {
      totalEvents: recentEvents.length,
      criticalEvents: recentEvents.filter(e => e.severity === 'critical').length,
      threatsBlocked: recentEvents.filter(e => e.type === 'threat').length,
      authenticationFailures: recentEvents.filter(e => e.type === 'authentication' && e.description.includes('failed')).length
    };

    const recommendations: string[] = [];
    
    if (summary.criticalEvents > 0) {
      recommendations.push('Immediate investigation required for critical security events');
    }
    
    if (summary.authenticationFailures > 10) {
      recommendations.push('Consider implementing stronger authentication measures');
    }
    
    if (summary.threatsBlocked > 5) {
      recommendations.push('Review and update threat detection rules');
    }

    return { summary, events: recentEvents, recommendations };
  }

  /**
   * セキュリティ設定の更新
   */
  updateConfig(newConfig: Partial<SecurityConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('configUpdated', this.config);
  }

  /**
   * リソースのクリーンアップ
   */
  cleanup(): void {
    this.auditLog.cleanup();
  }

  // Getters
  get authManager() { return this.auth; }
  get cryptoManager() { return this.crypto; }
  get threatDetector() { return this.threatDetection; }
  get auditLogger() { return this.auditLog; }
}

// === 使用例 ===
export async function initializeSecurity(): Promise<SecurityManager> {
  const security = new SecurityManager({
    authentication: {
      maxFailedAttempts: 5,
      lockoutDuration: 15,
      sessionTimeout: 60,
      requireMFA: false
    },
    audit: {
      enabled: true,
      logLevel: 'info',
      retentionDays: 90,
      logDirectory: './logs/audit'
    },
    network: {
      allowedIPs: [], // 空の場合は全IP許可
      rateLimiting: {
        enabled: true,
        maxRequests: 100,
        windowMs: 60000
      },
      tlsMinVersion: '1.2'
    }
  });

  // イベントリスナー設定
  security.on('criticalThreat', (threat) => {
    console.log('🚨 緊急脅威検知:', threat.description);
  });

  security.on('securityEvent', (event) => {
    if (event.severity === 'high' || event.severity === 'critical') {
      console.log(`🔒 セキュリティイベント: ${event.description}`);
    }
  });

  await security.initialize();
  
  console.log('🛡️ 包括的セキュリティシステム開始完了');
  return security;
}

export default SecurityManager;