/**
 * セキュリティ強化モジュール
 * 設計思想: Robert C. Martin (セキュア設計), John Carmack (効率性), Rob Pike (シンプル)
 * 
 * 機能:
 * - TLS 1.3強化
 * - メモリ暗号化
 * - タイミング攻撃対策
 * - 証明書ピニング
 * - 入力値検証
 * - セキュアな乱数生成
 */

import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto';
import { promisify } from 'util';
import { EventEmitter } from 'events';

// === 型定義 ===
export interface SecurityConfig {
  encryption: {
    algorithm: string;
    keySize: number;
    ivSize: number;
    saltSize: number;
    iterations: number;
  };
  tls: {
    minVersion: string;
    cipherSuites: string[];
    certificatePinning: boolean;
    hsts: boolean;
  };
  validation: {
    maxInputSize: number;
    allowedChars: RegExp;
    rateLimiting: boolean;
    sanitization: boolean;
  };
  timing: {
    constantTimeOps: boolean;
    jitterProtection: boolean;
    maxOperationTime: number;
  };
  audit: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    retentionDays: number;
    encryptLogs: boolean;
  };
}

export interface SecurityAlert {
  type: 'intrusion' | 'timing_attack' | 'invalid_input' | 'cert_mismatch' | 'encryption_failure';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  source: string;
  timestamp: number;
  metadata: Record<string, any>;
}

export interface EncryptedData {
  data: string;           // base64 encoded encrypted data
  iv: string;            // base64 encoded IV
  salt: string;          // base64 encoded salt
  tag?: string;          // base64 encoded auth tag (for AEAD)
  algorithm: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitized?: string;
  risk: 'low' | 'medium' | 'high';
}

// === セキュリティ強化モジュール ===
export class SecurityModule extends EventEmitter {
  private config: SecurityConfig;
  private masterKey: Buffer | null = null;
  private pinnedCertificates = new Map<string, string[]>();
  private rateLimiters = new Map<string, { count: number; resetTime: number }>();
  private timingBaseline = new Map<string, number>();

  constructor(config: Partial<SecurityConfig> = {}) {
    super();
    
    this.config = {
      encryption: {
        algorithm: 'aes-256-gcm',
        keySize: 32,
        ivSize: 16,
        saltSize: 32,
        iterations: 100000,
        ...config.encryption
      },
      tls: {
        minVersion: 'TLSv1.3',
        cipherSuites: [
          'TLS_AES_256_GCM_SHA384',
          'TLS_CHACHA20_POLY1305_SHA256',
          'TLS_AES_128_GCM_SHA256'
        ],
        certificatePinning: true,
        hsts: true,
        ...config.tls
      },
      validation: {
        maxInputSize: 1024 * 1024, // 1MB
        allowedChars: /^[a-zA-Z0-9\s\-_.@#$%^&*()+={}[\]:";'<>?,./\\|`~]*$/,
        rateLimiting: true,
        sanitization: true,
        ...config.validation
      },
      timing: {
        constantTimeOps: true,
        jitterProtection: true,
        maxOperationTime: 5000, // 5秒
        ...config.timing
      },
      audit: {
        logLevel: 'info',
        retentionDays: 30,
        encryptLogs: true,
        ...config.audit
      }
    };

    this.initializeSecurity();
  }

  // === 初期化 ===
  private async initializeSecurity(): Promise<void> {
    console.log('🔐 Initializing security module...');
    
    // マスターキー生成
    await this.generateMasterKey();
    
    // セキュリティベースライン設定
    this.establishTimingBaseline();
    
    console.log('✅ Security module initialized');
    this.emit('initialized');
  }

  // === 暗号化機能 ===
  async encrypt(data: string | Buffer, password?: string): Promise<EncryptedData> {
    const startTime = process.hrtime.bigint();
    
    try {
      const plaintext = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      const salt = this.generateSecureRandom(this.config.encryption.saltSize);
      const iv = this.generateSecureRandom(this.config.encryption.ivSize);
      
      // キー導出
      const key = password 
        ? this.deriveKey(password, salt)
        : this.masterKey;
      
      if (!key) {
        throw new Error('No encryption key available');
      }
      
      // 暗号化
      const cipher = createCipheriv(this.config.encryption.algorithm, key, iv);
      let encrypted = cipher.update(plaintext);
      encrypted = Buffer.concat([encrypted, cipher.final()]);
      
      // 認証タグ取得（AEAD使用時）
      const authTag = (cipher as any).getAuthTag ? (cipher as any).getAuthTag() : undefined;
      
      const result: EncryptedData = {
        data: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        salt: salt.toString('base64'),
        algorithm: this.config.encryption.algorithm
      };
      
      if (authTag) {
        result.tag = authTag.toString('base64');
      }
      
      // タイミング攻撃対策
      await this.addConstantTimeDelay('encrypt', startTime);
      
      this.auditLog('encrypt', 'info', `Data encrypted (${plaintext.length} bytes)`);
      return result;
      
    } catch (error) {
      this.emitSecurityAlert('encryption_failure', 'high', 
        `Encryption failed: ${error.message}`, 'encryption');
      throw error;
    }
  }

  async decrypt(encryptedData: EncryptedData, password?: string): Promise<Buffer> {
    const startTime = process.hrtime.bigint();
    
    try {
      const data = Buffer.from(encryptedData.data, 'base64');
      const iv = Buffer.from(encryptedData.iv, 'base64');
      const salt = Buffer.from(encryptedData.salt, 'base64');
      
      // キー導出
      const key = password 
        ? this.deriveKey(password, salt)
        : this.masterKey;
      
      if (!key) {
        throw new Error('No decryption key available');
      }
      
      // 復号化
      const decipher = createDecipheriv(encryptedData.algorithm, key, iv);
      
      // 認証タグ設定（AEAD使用時）
      if (encryptedData.tag && (decipher as any).setAuthTag) {
        const authTag = Buffer.from(encryptedData.tag, 'base64');
        (decipher as any).setAuthTag(authTag);
      }
      
      let decrypted = decipher.update(data);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      
      // タイミング攻撃対策
      await this.addConstantTimeDelay('decrypt', startTime);
      
      this.auditLog('decrypt', 'info', `Data decrypted (${decrypted.length} bytes)`);
      return decrypted;
      
    } catch (error) {
      // 定数時間でエラーを返す
      await this.addConstantTimeDelay('decrypt', startTime);
      
      this.emitSecurityAlert('encryption_failure', 'medium', 
        `Decryption failed: ${error.message}`, 'decryption');
      throw new Error('Decryption failed');
    }
  }

  // === セキュアハッシュ ===
  secureHash(data: string | Buffer, algorithm: string = 'sha256'): string {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    return createHash(algorithm).update(input).digest('hex');
  }

  secureHMAC(data: string | Buffer, key: string | Buffer, algorithm: string = 'sha256'): string {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const keyBuffer = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
    return createHmac(algorithm, keyBuffer).update(input).digest('hex');
  }

  // === 入力値検証 ===
  validateInput(input: string, options: {
    maxLength?: number;
    allowedChars?: RegExp;
    required?: boolean;
    sanitize?: boolean;
  } = {}): ValidationResult {
    const errors: string[] = [];
    let risk: 'low' | 'medium' | 'high' = 'low';
    let sanitized = input;

    // 必須チェック
    if (options.required && !input) {
      errors.push('Input is required');
      risk = 'medium';
    }

    // 長さチェック
    const maxLength = options.maxLength || this.config.validation.maxInputSize;
    if (input.length > maxLength) {
      errors.push(`Input too long (max: ${maxLength})`);
      risk = 'high';
    }

    // 文字種チェック
    const allowedChars = options.allowedChars || this.config.validation.allowedChars;
    if (!allowedChars.test(input)) {
      errors.push('Input contains invalid characters');
      risk = 'high';
    }

    // サニタイゼーション
    if (options.sanitize !== false && this.config.validation.sanitization) {
      sanitized = this.sanitizeInput(input);
      if (sanitized !== input) {
        risk = Math.max(risk === 'low' ? 0 : risk === 'medium' ? 1 : 2, 1) === 0 ? 'low' : 
              Math.max(risk === 'low' ? 0 : risk === 'medium' ? 1 : 2, 1) === 1 ? 'medium' : 'high';
      }
    }

    // XSS/SQLインジェクション検出
    if (this.detectMaliciousPatterns(input)) {
      errors.push('Potentially malicious input detected');
      risk = 'high';
    }

    if (errors.length > 0) {
      this.auditLog('validation', 'warn', `Input validation failed: ${errors.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      sanitized: options.sanitize !== false ? sanitized : undefined,
      risk
    };
  }

  // === レート制限 ===
  checkRateLimit(identifier: string, maxRequests: number = 100, windowMs: number = 60000): boolean {
    if (!this.config.validation.rateLimiting) {
      return true;
    }

    const now = Date.now();
    const limiter = this.rateLimiters.get(identifier);

    if (!limiter || now > limiter.resetTime) {
      // 新しいウィンドウ
      this.rateLimiters.set(identifier, {
        count: 1,
        resetTime: now + windowMs
      });
      return true;
    }

    if (limiter.count >= maxRequests) {
      this.emitSecurityAlert('intrusion', 'medium', 
        `Rate limit exceeded for ${identifier}`, 'rate_limiting');
      return false;
    }

    limiter.count++;
    return true;
  }

  // === 証明書ピニング ===
  pinCertificate(hostname: string, certificates: string[]): void {
    this.pinnedCertificates.set(hostname, certificates);
    this.auditLog('cert_pinning', 'info', `Certificate pinned for ${hostname}`);
  }

  verifyCertificate(hostname: string, certificate: string): boolean {
    if (!this.config.tls.certificatePinning) {
      return true;
    }

    const pinnedCerts = this.pinnedCertificates.get(hostname);
    if (!pinnedCerts) {
      return true; // 未ピニングの場合は通す
    }

    const isValid = pinnedCerts.includes(certificate);
    if (!isValid) {
      this.emitSecurityAlert('cert_mismatch', 'critical', 
        `Certificate mismatch for ${hostname}`, 'tls');
    }

    return isValid;
  }

  // === セキュア乱数生成 ===
  generateSecureRandom(size: number): Buffer {
    return randomBytes(size);
  }

  generateSecureToken(length: number = 32): string {
    return randomBytes(length).toString('hex');
  }

  generateNonce(): string {
    return randomBytes(16).toString('base64');
  }

  // === メモリ保護 ===
  secureMemoryAlloc(size: number): Buffer {
    // セキュアなメモリ割り当て（実際の実装では専用ライブラリを使用）
    const buffer = Buffer.allocUnsafeSlow(size);
    buffer.fill(0); // ゼロクリア
    return buffer;
  }

  secureMemoryFree(buffer: Buffer): void {
    // メモリをゼロクリアしてから解放
    buffer.fill(0);
  }

  // === プライベートメソッド ===
  private async generateMasterKey(): Promise<void> {
    const entropy = randomBytes(this.config.encryption.keySize);
    const salt = randomBytes(this.config.encryption.saltSize);
    
    // PBKDF2でキー強化
    this.masterKey = pbkdf2Sync(entropy, salt, this.config.encryption.iterations, 
      this.config.encryption.keySize, 'sha512');
    
    // エントロピーをクリア
    entropy.fill(0);
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    return pbkdf2Sync(password, salt, this.config.encryption.iterations, 
      this.config.encryption.keySize, 'sha512');
  }

  private sanitizeInput(input: string): string {
    // XSS対策
    let sanitized = input
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');

    // SQL injection対策
    sanitized = sanitized
      .replace(/[';\\]/g, '')
      .replace(/\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/gi, '');

    return sanitized;
  }

  private detectMaliciousPatterns(input: string): boolean {
    const maliciousPatterns = [
      /<script[^>]*>.*?<\/script>/gi,                    // XSS
      /javascript:/gi,                                   // JavaScript URLs
      /on\w+\s*=/gi,                                    // Event handlers
      /\b(SELECT|INSERT|UPDATE|DELETE|DROP)\b.*\b(FROM|INTO|SET|WHERE)\b/gi, // SQL
      /\.\.\//g,                                        // Path traversal
      /[\\]{2,}/g,                                      // Multiple backslashes
      /eval\s*\(/gi,                                    // Code injection
      /exec\s*\(/gi,                                    // Command injection
    ];

    return maliciousPatterns.some(pattern => pattern.test(input));
  }

  private establishTimingBaseline(): void {
    // タイミング攻撃対策のベースライン設定
    this.timingBaseline.set('encrypt', 100); // 100ms
    this.timingBaseline.set('decrypt', 100);
    this.timingBaseline.set('hash', 50);
    this.timingBaseline.set('validation', 10);
  }

  private async addConstantTimeDelay(operation: string, startTime: bigint): Promise<void> {
    if (!this.config.timing.constantTimeOps) {
      return;
    }

    const elapsedNs = process.hrtime.bigint() - startTime;
    const elapsedMs = Number(elapsedNs) / 1000000;
    
    const baseline = this.timingBaseline.get(operation) || 100;
    const targetTime = baseline + (this.config.timing.jitterProtection ? Math.random() * 10 : 0);
    
    if (elapsedMs < targetTime) {
      const delayMs = targetTime - elapsedMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  private emitSecurityAlert(
    type: SecurityAlert['type'], 
    severity: SecurityAlert['severity'], 
    message: string, 
    source: string,
    metadata: Record<string, any> = {}
  ): void {
    const alert: SecurityAlert = {
      type,
      severity,
      message,
      source,
      timestamp: Date.now(),
      metadata
    };

    console.log(`🚨 SECURITY ${severity.toUpperCase()}: ${message} (${source})`);
    this.auditLog('security_alert', severity === 'critical' ? 'error' : 'warn', message, metadata);
    this.emit('securityAlert', alert);
  }

  private auditLog(
    operation: string, 
    level: SecurityConfig['audit']['logLevel'], 
    message: string, 
    metadata: any = {}
  ): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      operation,
      level,
      message,
      metadata
    };

    // 実際の実装では専用のログシステムに送信
    if (level === 'error' || level === 'warn') {
      console[level](`[SECURITY] ${message}`, metadata);
    } else if (this.config.audit.logLevel === 'debug' || 
               (this.config.audit.logLevel === 'info' && level === 'info')) {
      console.info(`[SECURITY] ${message}`, metadata);
    }
  }

  // === パブリックユーティリティ ===
  constantTimeStringCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
  }

  getTLSConfig(): any {
    return {
      secureProtocol: 'TLSv1_3_method',
      ciphers: this.config.tls.cipherSuites.join(':'),
      honorCipherOrder: true,
      secureOptions: require('constants').SSL_OP_NO_TLSv1 | 
                    require('constants').SSL_OP_NO_TLSv1_1 |
                    require('constants').SSL_OP_NO_TLSv1_2
    };
  }

  getSecurityHeaders(): Record<string, string> {
    return {
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Content-Security-Policy': "default-src 'self'",
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    };
  }

  // === 破棄 ===
  destroy(): void {
    // マスターキーをゼロクリア
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }

    // レートリミッターをクリア
    this.rateLimiters.clear();
    this.pinnedCertificates.clear();
    this.timingBaseline.clear();

    console.log('🔐 Security module destroyed');
  }
}

// === 使用例 ===
export async function createSecurityModule(config?: Partial<SecurityConfig>): Promise<SecurityModule> {
  const security = new SecurityModule(config);
  
  // セキュリティアラートハンドラー
  security.on('securityAlert', (alert) => {
    if (alert.severity === 'critical') {
      console.error(`🚨 CRITICAL SECURITY ALERT: ${alert.message}`);
      // 実際の実装では管理者通知、自動対応等
    }
  });

  return security;
}

export default SecurityModule;