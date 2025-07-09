/**
 * Enhanced Security System - 包括的セキュリティ強化システム
 * 設計思想: Carmack (効率性), Martin (クリーン), Pike (シンプル)
 * 
 * 機能:
 * - SSL/TLS暗号化
 * - 高度なレート制限
 * - IPブロッキング・ホワイトリスト
 * - 入力検証・サニタイズ
 * - セキュリティ監査ログ
 * - 攻撃検知・防御
 * - CSRF/XSS対策
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Request, Response, NextFunction } from 'express';

// === 型定義 ===
interface SecurityConfig {
  rateLimiting: {
    enabled: boolean;
    windowMs: number;
    maxRequests: number;
    skipSuccessfulRequests: boolean;
    skipFailedRequests: boolean;
  };
  ipBlocking: {
    enabled: boolean;
    maxFailedAttempts: number;
    blockDuration: number;
    whitelist: string[];
    blacklist: string[];
  };
  ssl: {
    enabled: boolean;
    keyPath?: string;
    certPath?: string;
    caPath?: string;
    forceHttps: boolean;
  };
  csrf: {
    enabled: boolean;
    tokenExpiry: number;
    cookieOptions: any;
  };
  audit: {
    enabled: boolean;
    logPath: string;
    rotateDaily: boolean;
    retentionDays: number;
  };
  validation: {
    enabled: boolean;
    maxBodySize: number;
    maxHeaderSize: number;
    allowedMethods: string[];
  };
}

interface SecurityIncident {
  id: string;
  type: 'rate_limit' | 'ip_block' | 'invalid_input' | 'csrf_attack' | 'xss_attempt' | 'sql_injection' | 'suspicious_activity';
  severity: 'low' | 'medium' | 'high' | 'critical';
  sourceIp: string;
  userAgent?: string;
  timestamp: number;
  details: any;
  blocked: boolean;
}

interface RateLimitEntry {
  ip: string;
  requests: number;
  windowStart: number;
  blocked: boolean;
}

interface IPBlockEntry {
  ip: string;
  failedAttempts: number;
  firstAttempt: number;
  lastAttempt: number;
  blocked: boolean;
  blockExpiry?: number;
}

// === SSL/TLS管理 ===
class SSLManager {
  private logger: any;
  private config: SecurityConfig['ssl'];

  constructor(config: SecurityConfig['ssl'], logger: any) {
    this.config = config;
    this.logger = logger;
  }

  async loadCertificates(): Promise<{ key: string; cert: string; ca?: string } | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      if (!this.config.keyPath || !this.config.certPath) {
        throw new Error('SSL key and cert paths are required');
      }

      const key = fs.readFileSync(this.config.keyPath, 'utf8');
      const cert = fs.readFileSync(this.config.certPath, 'utf8');
      let ca: string | undefined;

      if (this.config.caPath) {
        ca = fs.readFileSync(this.config.caPath, 'utf8');
      }

      this.logger.success('SSL certificates loaded successfully');
      return { key, cert, ca };

    } catch (error) {
      this.logger.error('Failed to load SSL certificates:', error);
      
      // 自己署名証明書を生成
      return this.generateSelfSignedCertificate();
    }
  }

  private generateSelfSignedCertificate(): { key: string; cert: string } {
    this.logger.warn('Generating self-signed certificate for development');

    // 実際の実装では、opensslやnode-forge等を使用
    // ここでは簡易実装
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    // 簡易証明書（実際の実装では適切な証明書生成が必要）
    const cert = `-----BEGIN CERTIFICATE-----
MIICsDCCAZgCCQDmX7LPF8E8xTANBgkqhkiG9w0BAQsFADAaMRgwFgYDVQQDDA9P
dGVkYW1hIE1pbmluZyBQb29sIDAeFw0yNDA3MDgxMjAwMDBaFw0yNTA3MDgxMjAw
MDBaMBoxGDAWBgNVBAMMD090ZWRhbWEgTWluaW5nIFBvb2wwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQDGxIVYNhZ8u9cOUJZWRPJVeFcKk1T1y/YJhFOy
bwYKOx5+sUcOo5WxJ7CqB2BQ0GHr8qGgm4VkBaOKu9zxNlBn1zMNxfoPJ+YzF4z8
-----END CERTIFICATE-----`;

    return {
      key: keyPair.privateKey,
      cert: cert
    };
  }

  createHTTPSRedirectMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.config.forceHttps && req.headers['x-forwarded-proto'] !== 'https' && !req.secure) {
        const httpsUrl = `https://${req.get('host')}${req.originalUrl}`;
        return res.redirect(301, httpsUrl);
      }
      next();
    };
  }
}

// === レート制限システム ===
class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private config: SecurityConfig['rateLimiting'];
  private logger: any;

  constructor(config: SecurityConfig['rateLimiting'], logger: any) {
    this.config = config;
    this.logger = logger;
    
    this.startCleanupTimer();
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      const clientIp = this.getClientIP(req);
      const now = Date.now();
      
      let entry = this.entries.get(clientIp);
      
      if (!entry) {
        entry = {
          ip: clientIp,
          requests: 0,
          windowStart: now,
          blocked: false
        };
        this.entries.set(clientIp, entry);
      }

      // ウィンドウリセット
      if (now - entry.windowStart > this.config.windowMs) {
        entry.requests = 0;
        entry.windowStart = now;
        entry.blocked = false;
      }

      entry.requests++;

      // レート制限チェック
      if (entry.requests > this.config.maxRequests) {
        entry.blocked = true;
        
        res.status(429).json({
          error: 'Too Many Requests',
          retryAfter: Math.ceil((entry.windowStart + this.config.windowMs - now) / 1000)
        });

        this.logger.warn(`Rate limit exceeded for IP: ${clientIp} (${entry.requests} requests)`);
        return;
      }

      // ヘッダー設定
      res.set({
        'X-RateLimit-Limit': this.config.maxRequests.toString(),
        'X-RateLimit-Remaining': Math.max(0, this.config.maxRequests - entry.requests).toString(),
        'X-RateLimit-Reset': new Date(entry.windowStart + this.config.windowMs).toISOString()
      });

      next();
    };
  }

  private getClientIP(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           '127.0.0.1';
  }

  private startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of this.entries) {
        if (now - entry.windowStart > this.config.windowMs * 2) {
          this.entries.delete(ip);
        }
      }
    }, this.config.windowMs);
  }

  getStats(): any {
    return {
      totalIPs: this.entries.size,
      blockedIPs: Array.from(this.entries.values()).filter(e => e.blocked).length,
      activeRequests: Array.from(this.entries.values()).reduce((sum, e) => sum + e.requests, 0)
    };
  }
}

// === IPブロッキングシステム ===
class IPBlockingSystem extends EventEmitter {
  private blockedIPs = new Map<string, IPBlockEntry>();
  private config: SecurityConfig['ipBlocking'];
  private logger: any;

  constructor(config: SecurityConfig['ipBlocking'], logger: any) {
    super();
    this.config = config;
    this.logger = logger;
    
    this.startCleanupTimer();
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      const clientIp = this.getClientIP(req);
      
      // ホワイトリストチェック
      if (this.config.whitelist.includes(clientIp)) {
        return next();
      }

      // ブラックリストチェック
      if (this.config.blacklist.includes(clientIp)) {
        return this.blockRequest(res, clientIp, 'Blacklisted IP');
      }

      // ブロック状態チェック
      const blockedEntry = this.blockedIPs.get(clientIp);
      if (blockedEntry && blockedEntry.blocked) {
        if (blockedEntry.blockExpiry && Date.now() > blockedEntry.blockExpiry) {
          // ブロック期限切れ
          this.unblockIP(clientIp);
        } else {
          return this.blockRequest(res, clientIp, 'IP temporarily blocked');
        }
      }

      next();
    };
  }

  recordFailedAttempt(ip: string, reason: string): void {
    if (!this.config.enabled) return;

    let entry = this.blockedIPs.get(ip);
    if (!entry) {
      entry = {
        ip,
        failedAttempts: 0,
        firstAttempt: Date.now(),
        lastAttempt: Date.now(),
        blocked: false
      };
      this.blockedIPs.set(ip, entry);
    }

    entry.failedAttempts++;
    entry.lastAttempt = Date.now();

    this.logger.warn(`Failed attempt from ${ip}: ${reason} (${entry.failedAttempts}/${this.config.maxFailedAttempts})`);

    // ブロック判定
    if (entry.failedAttempts >= this.config.maxFailedAttempts) {
      this.blockIP(ip, reason);
    }
  }

  private blockIP(ip: string, reason: string): void {
    const entry = this.blockedIPs.get(ip)!;
    entry.blocked = true;
    entry.blockExpiry = Date.now() + this.config.blockDuration;

    this.logger.error(`IP blocked: ${ip} - ${reason}`);
    
    this.emit('ipBlocked', {
      ip,
      reason,
      attempts: entry.failedAttempts,
      blockExpiry: entry.blockExpiry
    });
  }

  private unblockIP(ip: string): void {
    const entry = this.blockedIPs.get(ip);
    if (entry) {
      entry.blocked = false;
      entry.blockExpiry = undefined;
      entry.failedAttempts = 0;
      
      this.logger.info(`IP unblocked: ${ip}`);
      this.emit('ipUnblocked', { ip });
    }
  }

  private blockRequest(res: Response, ip: string, reason: string): void {
    res.status(403).json({
      error: 'Access Denied',
      message: 'Your IP address has been blocked',
      timestamp: new Date().toISOString()
    });

    this.logger.warn(`Blocked request from ${ip}: ${reason}`);
  }

  private getClientIP(req: Request): string {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           '127.0.0.1';
  }

  private startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [ip, entry] of this.blockedIPs) {
        if (entry.blockExpiry && now > entry.blockExpiry) {
          this.unblockIP(ip);
        }
      }
    }, 60000); // 1分間隔
  }

  addToWhitelist(ip: string): void {
    if (!this.config.whitelist.includes(ip)) {
      this.config.whitelist.push(ip);
      this.logger.info(`Added ${ip} to whitelist`);
    }
  }

  addToBlacklist(ip: string): void {
    if (!this.config.blacklist.includes(ip)) {
      this.config.blacklist.push(ip);
      this.logger.info(`Added ${ip} to blacklist`);
    }
  }

  getBlockedIPs(): IPBlockEntry[] {
    return Array.from(this.blockedIPs.values()).filter(entry => entry.blocked);
  }

  getStats(): any {
    const entries = Array.from(this.blockedIPs.values());
    return {
      totalTracked: entries.length,
      currentlyBlocked: entries.filter(e => e.blocked).length,
      whitelistSize: this.config.whitelist.length,
      blacklistSize: this.config.blacklist.length,
      totalFailedAttempts: entries.reduce((sum, e) => sum + e.failedAttempts, 0)
    };
  }
}

// === 入力検証・サニタイズシステム ===
class InputValidator {
  private config: SecurityConfig['validation'];
  private logger: any;

  constructor(config: SecurityConfig['validation'], logger: any) {
    this.config = config;
    this.logger = logger;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      try {
        // メソッド検証
        if (!this.config.allowedMethods.includes(req.method)) {
          return res.status(405).json({ error: 'Method Not Allowed' });
        }

        // ボディサイズ検証
        const contentLength = parseInt(req.headers['content-length'] || '0');
        if (contentLength > this.config.maxBodySize) {
          return res.status(413).json({ error: 'Payload Too Large' });
        }

        // ヘッダーサイズ検証
        const headerSize = JSON.stringify(req.headers).length;
        if (headerSize > this.config.maxHeaderSize) {
          return res.status(431).json({ error: 'Request Header Fields Too Large' });
        }

        // パス検証
        if (this.containsSuspiciousPatterns(req.path)) {
          this.logger.warn(`Suspicious path detected: ${req.path} from ${req.ip}`);
          return res.status(400).json({ error: 'Invalid Request Path' });
        }

        // クエリパラメータ検証
        for (const [key, value] of Object.entries(req.query)) {
          if (this.containsSuspiciousPatterns(String(value))) {
            this.logger.warn(`Suspicious query parameter: ${key}=${value} from ${req.ip}`);
            return res.status(400).json({ error: 'Invalid Query Parameter' });
          }
        }

        // ボディ検証（POST/PUT等）
        if (req.body && typeof req.body === 'object') {
          if (this.validateRequestBody(req.body)) {
            // サニタイズ
            req.body = this.sanitizeObject(req.body);
          } else {
            return res.status(400).json({ error: 'Invalid Request Body' });
          }
        }

        next();

      } catch (error) {
        this.logger.error('Input validation error:', error);
        res.status(400).json({ error: 'Invalid Request' });
      }
    };
  }

  private containsSuspiciousPatterns(input: string): boolean {
    const suspiciousPatterns = [
      // SQL Injection
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION)\b)/i,
      /(--|\/\*|\*\/|;|'|"|`)/,
      
      // XSS
      /(<script|<\/script|javascript:|onload=|onerror=|onclick=)/i,
      
      // Path Traversal
      /(\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e%5c)/i,
      
      // Command Injection
      /(\||&|;|`|\$\(|\${)/,
      
      // LDAP Injection
      /(\*|\(|\)|\\|\/)/,
      
      // XXE
      /(<!ENTITY|<!DOCTYPE|SYSTEM|PUBLIC)/i
    ];

    return suspiciousPatterns.some(pattern => pattern.test(input));
  }

  private validateRequestBody(body: any): boolean {
    if (typeof body !== 'object' || body === null) {
      return true;
    }

    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') {
        if (this.containsSuspiciousPatterns(value)) {
          return false;
        }
      } else if (typeof value === 'object' && value !== null) {
        if (!this.validateRequestBody(value)) {
          return false;
        }
      }
    }

    return true;
  }

  private sanitizeObject(obj: any): any {
    if (typeof obj !== 'object' || obj === null) {
      return typeof obj === 'string' ? this.sanitizeString(obj) : obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item));
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      sanitized[this.sanitizeString(key)] = this.sanitizeObject(value);
    }

    return sanitized;
  }

  private sanitizeString(str: string): string {
    return str
      .replace(/[<>'"]/g, '') // HTMLタグ除去
      .replace(/javascript:/gi, '') // JavaScript URL除去
      .replace(/on\w+\s*=/gi, '') // イベントハンドラ除去
      .trim();
  }

  validateMinerAddress(address: string, currency: string): boolean {
    const patterns: Record<string, RegExp> = {
      'BTC': /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
      'LTC': /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$|^ltc1[a-z0-9]{39,59}$/,
      'ETH': /^0x[a-fA-F0-9]{40}$/,
      'DOGE': /^D{1}[5-9A-HJ-NP-U]{1}[1-9A-HJ-NP-Za-km-z]{32}$/
    };

    const pattern = patterns[currency.toUpperCase()];
    return pattern ? pattern.test(address) : false;
  }
}

// === CSRF対策システム ===
class CSRFProtection {
  private tokens = new Map<string, { token: string; expiry: number; ip: string }>();
  private config: SecurityConfig['csrf'];
  private logger: any;

  constructor(config: SecurityConfig['csrf'], logger: any) {
    this.config = config;
    this.logger = logger;
    
    this.startCleanupTimer();
  }

  generateToken(ip: string): string {
    const token = crypto.randomBytes(32).toString('hex');
    const expiry = Date.now() + this.config.tokenExpiry;
    
    this.tokens.set(token, { token, expiry, ip });
    
    return token;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      // GET, HEAD, OPTIONS は除外
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
      }

      const token = req.headers['x-csrf-token'] as string || req.body._csrf;
      
      if (!token) {
        return res.status(403).json({ error: 'CSRF token missing' });
      }

      const tokenData = this.tokens.get(token);
      if (!tokenData) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
      }

      if (Date.now() > tokenData.expiry) {
        this.tokens.delete(token);
        return res.status(403).json({ error: 'CSRF token expired' });
      }

      const clientIp = req.ip || req.connection.remoteAddress;
      if (tokenData.ip !== clientIp) {
        return res.status(403).json({ error: 'CSRF token IP mismatch' });
      }

      // 使用済みトークンを削除（ワンタイム）
      this.tokens.delete(token);

      next();
    };
  }

  private startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [token, data] of this.tokens) {
        if (now > data.expiry) {
          this.tokens.delete(token);
        }
      }
    }, 60000); // 1分間隔
  }
}

// === セキュリティ監査ログ ===
class SecurityAuditLogger {
  private config: SecurityConfig['audit'];
  private logger: any;
  private logStream?: fs.WriteStream;

  constructor(config: SecurityConfig['audit'], logger: any) {
    this.config = config;
    this.logger = logger;
    
    if (config.enabled) {
      this.initializeLogStream();
    }
  }

  private initializeLogStream(): void {
    try {
      const logDir = path.dirname(this.config.logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const logPath = this.config.rotateDaily 
        ? this.getRotatedLogPath() 
        : this.config.logPath;

      this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
      
      this.logger.info(`Security audit logging to: ${logPath}`);
    } catch (error) {
      this.logger.error('Failed to initialize audit log stream:', error);
    }
  }

  private getRotatedLogPath(): string {
    const date = new Date().toISOString().split('T')[0];
    const ext = path.extname(this.config.logPath);
    const base = path.basename(this.config.logPath, ext);
    const dir = path.dirname(this.config.logPath);
    
    return path.join(dir, `${base}-${date}${ext}`);
  }

  logIncident(incident: SecurityIncident): void {
    if (!this.config.enabled || !this.logStream) {
      return;
    }

    const logEntry = {
      timestamp: new Date(incident.timestamp).toISOString(),
      id: incident.id,
      type: incident.type,
      severity: incident.severity,
      sourceIp: incident.sourceIp,
      userAgent: incident.userAgent,
      details: incident.details,
      blocked: incident.blocked
    };

    this.logStream.write(JSON.stringify(logEntry) + '\n');
  }

  logAuthentication(ip: string, success: boolean, userId?: string): void {
    this.logIncident({
      id: crypto.randomUUID(),
      type: 'suspicious_activity',
      severity: success ? 'low' : 'medium',
      sourceIp: ip,
      timestamp: Date.now(),
      details: {
        event: 'authentication',
        success,
        userId
      },
      blocked: false
    });
  }

  logAPIAccess(ip: string, endpoint: string, method: string, statusCode: number): void {
    if (statusCode >= 400) {
      this.logIncident({
        id: crypto.randomUUID(),
        type: 'suspicious_activity',
        severity: statusCode >= 500 ? 'high' : 'medium',
        sourceIp: ip,
        timestamp: Date.now(),
        details: {
          event: 'api_access',
          endpoint,
          method,
          statusCode
        },
        blocked: false
      });
    }
  }

  async getAuditLogs(startDate?: Date, endDate?: Date): Promise<any[]> {
    if (!this.config.enabled) {
      return [];
    }

    try {
      const logPath = this.config.logPath;
      if (!fs.existsSync(logPath)) {
        return [];
      }

      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      
      let logs = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(log => log !== null);

      // 日付フィルタリング
      if (startDate || endDate) {
        logs = logs.filter(log => {
          const logDate = new Date(log.timestamp);
          if (startDate && logDate < startDate) return false;
          if (endDate && logDate > endDate) return false;
          return true;
        });
      }

      return logs;
    } catch (error) {
      this.logger.error('Failed to read audit logs:', error);
      return [];
    }
  }

  async cleanup(): Promise<void> {
    if (!this.config.enabled || this.config.retentionDays <= 0) {
      return;
    }

    try {
      const logDir = path.dirname(this.config.logPath);
      const files = fs.readdirSync(logDir);
      const cutoffDate = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);

      for (const file of files) {
        const filePath = path.join(logDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < cutoffDate) {
          fs.unlinkSync(filePath);
          this.logger.info(`Deleted old audit log: ${file}`);
        }
      }
    } catch (error) {
      this.logger.error('Failed to cleanup audit logs:', error);
    }
  }
}

// === メインセキュリティシステム ===
export class EnhancedSecuritySystem extends EventEmitter {
  private config: SecurityConfig;
  private logger: any;
  
  private sslManager: SSLManager;
  private rateLimiter: RateLimiter;
  private ipBlocking: IPBlockingSystem;
  private inputValidator: InputValidator;
  private csrfProtection: CSRFProtection;
  private auditLogger: SecurityAuditLogger;

  constructor(config: SecurityConfig, logger: any) {
    super();
    this.config = config;
    this.logger = logger;

    // コンポーネント初期化
    this.sslManager = new SSLManager(config.ssl, logger);
    this.rateLimiter = new RateLimiter(config.rateLimiting, logger);
    this.ipBlocking = new IPBlockingSystem(config.ipBlocking, logger);
    this.inputValidator = new InputValidator(config.validation, logger);
    this.csrfProtection = new CSRFProtection(config.csrf, logger);
    this.auditLogger = new SecurityAuditLogger(config.audit, logger);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.ipBlocking.on('ipBlocked', (data) => {
      this.auditLogger.logIncident({
        id: crypto.randomUUID(),
        type: 'ip_block',
        severity: 'high',
        sourceIp: data.ip,
        timestamp: Date.now(),
        details: data,
        blocked: true
      });
    });
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Enhanced Security System...');

    // SSL証明書読み込み
    if (this.config.ssl.enabled) {
      await this.sslManager.loadCertificates();
    }

    // 定期クリーンアップ開始
    this.startPeriodicCleanup();

    this.logger.success('Security system initialized');
  }

  // Express middleware の取得
  getMiddlewares() {
    return {
      httpsRedirect: this.sslManager.createHTTPSRedirectMiddleware(),
      rateLimit: this.rateLimiter.middleware(),
      ipBlocking: this.ipBlocking.middleware(),
      inputValidation: this.inputValidator.middleware(),
      csrfProtection: this.csrfProtection.middleware()
    };
  }

  // CSRF トークン生成
  generateCSRFToken(ip: string): string {
    return this.csrfProtection.generateToken(ip);
  }

  // マイナーアドレス検証
  validateMinerAddress(address: string, currency: string): boolean {
    return this.inputValidator.validateMinerAddress(address, currency);
  }

  // 攻撃記録
  recordAttack(type: SecurityIncident['type'], ip: string, details: any): void {
    const incident: SecurityIncident = {
      id: crypto.randomUUID(),
      type,
      severity: this.getSeverityForType(type),
      sourceIp: ip,
      timestamp: Date.now(),
      details,
      blocked: false
    };

    this.auditLogger.logIncident(incident);
    this.emit('securityIncident', incident);

    // 失敗試行として記録
    if (['invalid_input', 'csrf_attack', 'xss_attempt', 'sql_injection'].includes(type)) {
      this.ipBlocking.recordFailedAttempt(ip, type);
    }
  }

  private getSeverityForType(type: SecurityIncident['type']): SecurityIncident['severity'] {
    const severityMap: Record<SecurityIncident['type'], SecurityIncident['severity']> = {
      'rate_limit': 'medium',
      'ip_block': 'high',
      'invalid_input': 'medium',
      'csrf_attack': 'high',
      'xss_attempt': 'high',
      'sql_injection': 'critical',
      'suspicious_activity': 'low'
    };

    return severityMap[type] || 'medium';
  }

  // ホワイトリスト管理
  addToWhitelist(ip: string): void {
    this.ipBlocking.addToWhitelist(ip);
  }

  addToBlacklist(ip: string): void {
    this.ipBlocking.addToBlacklist(ip);
  }

  // SSL証明書取得
  async getSSLCertificates() {
    return this.sslManager.loadCertificates();
  }

  // 統計情報取得
  getSecurityStats(): any {
    return {
      rateLimiting: this.rateLimiter.getStats(),
      ipBlocking: this.ipBlocking.getStats(),
      ssl: {
        enabled: this.config.ssl.enabled,
        forceHttps: this.config.ssl.forceHttps
      },
      csrf: {
        enabled: this.config.csrf.enabled
      },
      validation: {
        enabled: this.config.validation.enabled
      },
      audit: {
        enabled: this.config.audit.enabled
      }
    };
  }

  // 監査ログ取得
  async getAuditLogs(startDate?: Date, endDate?: Date): Promise<any[]> {
    return this.auditLogger.getAuditLogs(startDate, endDate);
  }

  // ブロック済みIP取得
  getBlockedIPs(): IPBlockEntry[] {
    return this.ipBlocking.getBlockedIPs();
  }

  private startPeriodicCleanup(): void {
    // 1時間ごとにクリーンアップ
    setInterval(async () => {
      await this.auditLogger.cleanup();
    }, 60 * 60 * 1000);
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down security system...');
    // 必要に応じてクリーンアップ処理
    this.logger.success('Security system shutdown complete');
  }
}

// === デフォルト設定 ===
export const DefaultSecurityConfig: SecurityConfig = {
  rateLimiting: {
    enabled: true,
    windowMs: 15 * 60 * 1000, // 15分
    maxRequests: 100,
    skipSuccessfulRequests: false,
    skipFailedRequests: false
  },
  ipBlocking: {
    enabled: true,
    maxFailedAttempts: 5,
    blockDuration: 60 * 60 * 1000, // 1時間
    whitelist: ['127.0.0.1', '::1'],
    blacklist: []
  },
  ssl: {
    enabled: true,
    forceHttps: false
  },
  csrf: {
    enabled: true,
    tokenExpiry: 60 * 60 * 1000, // 1時間
    cookieOptions: {
      httpOnly: true,
      secure: false,
      sameSite: 'strict'
    }
  },
  audit: {
    enabled: true,
    logPath: './logs/security-audit.log',
    rotateDaily: true,
    retentionDays: 30
  },
  validation: {
    enabled: true,
    maxBodySize: 1024 * 1024, // 1MB
    maxHeaderSize: 8192, // 8KB
    allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD']
  }
};

export { SecurityConfig, SecurityIncident, IPBlockEntry };
