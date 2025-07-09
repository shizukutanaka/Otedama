/**
 * 軽量2要素認証（2FA）システム
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - TOTP（時間ベースOTP）
 * - バックアップコード
 * - SMS認証（オプション）
 * - QRコード生成
 * - セキュアなシークレット管理
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';

// === 型定義 ===
interface TwoFactorConfig {
  issuer: string;
  serviceName: string;
  secretLength: number;
  totpWindow: number; // 許容する時間窓（30秒単位）
  backupCodeCount: number;
  backupCodeLength: number;
  smsProvider?: SMSProvider;
  rateLimiting: {
    maxAttempts: number;
    windowMs: number;
  };
}

interface UserSecrets {
  userId: string;
  totpSecret?: string;
  backupCodes?: string[];
  phoneNumber?: string;
  enabled: boolean;
  lastUsed?: number;
  methods: TwoFactorMethod[];
}

interface TwoFactorMethod {
  type: 'totp' | 'sms' | 'backup';
  enabled: boolean;
  verified: boolean;
  createdAt: number;
  lastUsed?: number;
}

interface VerificationAttempt {
  userId: string;
  timestamp: number;
  method: string;
  success: boolean;
  ip?: string;
}

interface SMSProvider {
  sendCode(phoneNumber: string, code: string): Promise<boolean>;
}

interface QRCodeData {
  secret: string;
  qrCodeUrl: string;
  manualEntryKey: string;
}

// === TOTP実装 ===
class TOTPGenerator {
  private static readonly DIGITS = 6;
  private static readonly PERIOD = 30; // 30秒

  static generateSecret(length: number = 32): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // Base32
    let secret = '';
    
    for (let i = 0; i < length; i++) {
      secret += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    
    return secret;
  }

  static generateTOTP(secret: string, timestamp?: number): string {
    const time = Math.floor((timestamp || Date.now()) / 1000 / this.PERIOD);
    return this.generateHOTP(secret, time);
  }

  private static generateHOTP(secret: string, counter: number): string {
    const key = this.base32Decode(secret);
    const timeBuffer = Buffer.allocUnsafe(8);
    
    // ビッグエンディアンで64ビット整数を書き込み
    timeBuffer.writeUInt32BE(0, 0);
    timeBuffer.writeUInt32BE(counter, 4);
    
    const hmac = crypto.createHmac('sha1', key);
    hmac.update(timeBuffer);
    const hash = hmac.digest();
    
    // 動的トランケーション
    const offset = hash[hash.length - 1] & 0x0f;
    const code = ((hash[offset] & 0x7f) << 24) |
                 ((hash[offset + 1] & 0xff) << 16) |
                 ((hash[offset + 2] & 0xff) << 8) |
                 (hash[offset + 3] & 0xff);
    
    return (code % Math.pow(10, this.DIGITS)).toString().padStart(this.DIGITS, '0');
  }

  static verifyTOTP(secret: string, token: string, window: number = 1): boolean {
    const currentTime = Math.floor(Date.now() / 1000 / this.PERIOD);
    
    // 指定された時間窓内でトークンを検証
    for (let i = -window; i <= window; i++) {
      const timeStep = currentTime + i;
      const expectedToken = this.generateHOTP(secret, timeStep);
      
      if (this.safeCompare(token, expectedToken)) {
        return true;
      }
    }
    
    return false;
  }

  private static safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    
    return result === 0;
  }

  private static base32Decode(encoded: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const output = [];

    for (let i = 0; i < encoded.length; i++) {
      const char = encoded[i].toUpperCase();
      const index = alphabet.indexOf(char);
      
      if (index === -1) continue;
      
      value = (value << 5) | index;
      bits += 5;
      
      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    
    return Buffer.from(output);
  }

  static generateQRCodeUrl(secret: string, accountName: string, issuer: string): string {
    const label = encodeURIComponent(`${issuer}:${accountName}`);
    const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: 'SHA1',
      digits: this.DIGITS.toString(),
      period: this.PERIOD.toString()
    });

    return `otpauth://totp/${label}?${params.toString()}`;
  }
}

// === バックアップコード生成器 ===
class BackupCodeGenerator {
  static generate(count: number = 10, length: number = 8): string[] {
    const codes: string[] = [];
    const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    
    for (let i = 0; i < count; i++) {
      let code = '';
      for (let j = 0; j < length; j++) {
        code += charset.charAt(Math.floor(Math.random() * charset.length));
      }
      codes.push(code);
    }
    
    return codes;
  }

  static hash(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  static verify(code: string, hashedCodes: string[]): boolean {
    const hashedInput = this.hash(code.toUpperCase());
    return hashedCodes.includes(hashedInput);
  }
}

// === レート制限 ===
class RateLimiter {
  private attempts = new Map<string, VerificationAttempt[]>();
  private config: TwoFactorConfig['rateLimiting'];

  constructor(config: TwoFactorConfig['rateLimiting']) {
    this.config = config;
  }

  isAllowed(userId: string, ip?: string): boolean {
    const key = `${userId}:${ip || 'unknown'}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    
    // 古い試行を削除
    const userAttempts = this.attempts.get(key) || [];
    const recentAttempts = userAttempts.filter(attempt => attempt.timestamp > windowStart);
    this.attempts.set(key, recentAttempts);
    
    return recentAttempts.length < this.config.maxAttempts;
  }

  recordAttempt(userId: string, method: string, success: boolean, ip?: string): void {
    const key = `${userId}:${ip || 'unknown'}`;
    const attempts = this.attempts.get(key) || [];
    
    attempts.push({
      userId,
      timestamp: Date.now(),
      method,
      success,
      ip
    });
    
    this.attempts.set(key, attempts);
  }

  getStats(userId: string): { remaining: number; resetTime: number } {
    const key = `${userId}:unknown`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const recentAttempts = (this.attempts.get(key) || [])
      .filter(attempt => attempt.timestamp > windowStart);
    
    return {
      remaining: Math.max(0, this.config.maxAttempts - recentAttempts.length),
      resetTime: windowStart + this.config.windowMs
    };
  }
}

// === SMS認証プロバイダー（モック実装） ===
class MockSMSProvider implements SMSProvider {
  private logger: any;

  constructor(logger?: any) {
    this.logger = logger || {
      info: (msg: string) => console.log(`[SMS] ${msg}`),
      error: (msg: string, err?: any) => console.error(`[SMS] ${msg}`, err)
    };
  }

  async sendCode(phoneNumber: string, code: string): Promise<boolean> {
    // 実際の実装では、TwilioやAWS SNSなどのサービスを使用
    this.logger.info(`SMS code ${code} sent to ${phoneNumber}`);
    return true;
  }
}

// === メイン2FAクラス ===
class LightTwoFactorAuth extends EventEmitter {
  private config: TwoFactorConfig;
  private userSecrets = new Map<string, UserSecrets>();
  private rateLimiter: RateLimiter;
  private logger: any;
  private smsCodes = new Map<string, { code: string; timestamp: number }>();

  constructor(config: Partial<TwoFactorConfig> = {}, logger?: any) {
    super();
    
    this.config = {
      issuer: 'Otedama Mining Pool',
      serviceName: 'Otedama',
      secretLength: 32,
      totpWindow: 1,
      backupCodeCount: 10,
      backupCodeLength: 8,
      smsProvider: new MockSMSProvider(logger),
      rateLimiting: {
        maxAttempts: 5,
        windowMs: 15 * 60 * 1000 // 15分
      },
      ...config
    };

    this.rateLimiter = new RateLimiter(this.config.rateLimiting);
    
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[2FA] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[2FA] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[2FA] ${msg}`, data || '')
    };
  }

  async setupTOTP(userId: string, accountName: string): Promise<QRCodeData> {
    // レート制限チェック
    if (!this.rateLimiter.isAllowed(userId)) {
      throw new Error('Too many attempts. Please try again later.');
    }

    const secret = TOTPGenerator.generateSecret(this.config.secretLength);
    const qrCodeUrl = TOTPGenerator.generateQRCodeUrl(secret, accountName, this.config.issuer);
    
    // ユーザーシークレットを初期化（まだ有効化されていない）
    const userSecrets: UserSecrets = {
      userId,
      totpSecret: secret,
      enabled: false,
      methods: [{
        type: 'totp',
        enabled: false,
        verified: false,
        createdAt: Date.now()
      }]
    };
    
    this.userSecrets.set(userId, userSecrets);
    
    this.logger.info(`TOTP setup initiated for user ${userId}`);
    
    return {
      secret,
      qrCodeUrl,
      manualEntryKey: secret.match(/.{1,4}/g)?.join(' ') || secret
    };
  }

  async verifyAndEnableTOTP(userId: string, token: string): Promise<{ success: boolean; backupCodes?: string[] }> {
    const userSecrets = this.userSecrets.get(userId);
    if (!userSecrets?.totpSecret) {
      throw new Error('TOTP not set up for this user');
    }

    if (!this.rateLimiter.isAllowed(userId)) {
      throw new Error('Too many attempts. Please try again later.');
    }

    const isValid = TOTPGenerator.verifyTOTP(userSecrets.totpSecret, token, this.config.totpWindow);
    
    this.rateLimiter.recordAttempt(userId, 'totp_setup', isValid);

    if (!isValid) {
      this.logger.warn(`Invalid TOTP token during setup for user ${userId}`);
      return { success: false };
    }

    // バックアップコード生成
    const backupCodes = BackupCodeGenerator.generate(
      this.config.backupCodeCount, 
      this.config.backupCodeLength
    );
    const hashedBackupCodes = backupCodes.map(code => BackupCodeGenerator.hash(code));

    // 2FAを有効化
    userSecrets.enabled = true;
    userSecrets.backupCodes = hashedBackupCodes;
    userSecrets.methods = [
      {
        type: 'totp',
        enabled: true,
        verified: true,
        createdAt: Date.now()
      },
      {
        type: 'backup',
        enabled: true,
        verified: true,
        createdAt: Date.now()
      }
    ];

    this.logger.info(`2FA enabled for user ${userId}`);
    this.emit('twoFactorEnabled', { userId, method: 'totp' });

    return { success: true, backupCodes };
  }

  async verifyTOTP(userId: string, token: string, ip?: string): Promise<boolean> {
    const userSecrets = this.userSecrets.get(userId);
    if (!userSecrets?.enabled || !userSecrets.totpSecret) {
      return false;
    }

    if (!this.rateLimiter.isAllowed(userId, ip)) {
      throw new Error('Too many attempts. Please try again later.');
    }

    const isValid = TOTPGenerator.verifyTOTP(userSecrets.totpSecret, token, this.config.totpWindow);
    
    this.rateLimiter.recordAttempt(userId, 'totp', isValid, ip);

    if (isValid) {
      userSecrets.lastUsed = Date.now();
      const totpMethod = userSecrets.methods.find(m => m.type === 'totp');
      if (totpMethod) {
        totpMethod.lastUsed = Date.now();
      }
      
      this.logger.info(`Successful TOTP verification for user ${userId}`);
      this.emit('verificationSuccess', { userId, method: 'totp', ip });
    } else {
      this.logger.warn(`Failed TOTP verification for user ${userId}`);
      this.emit('verificationFailure', { userId, method: 'totp', ip });
    }

    return isValid;
  }

  async verifyBackupCode(userId: string, code: string, ip?: string): Promise<boolean> {
    const userSecrets = this.userSecrets.get(userId);
    if (!userSecrets?.enabled || !userSecrets.backupCodes) {
      return false;
    }

    if (!this.rateLimiter.isAllowed(userId, ip)) {
      throw new Error('Too many attempts. Please try again later.');
    }

    const isValid = BackupCodeGenerator.verify(code, userSecrets.backupCodes);
    
    this.rateLimiter.recordAttempt(userId, 'backup', isValid, ip);

    if (isValid) {
      // 使用されたバックアップコードを削除
      const hashedCode = BackupCodeGenerator.hash(code.toUpperCase());
      userSecrets.backupCodes = userSecrets.backupCodes.filter(c => c !== hashedCode);
      
      userSecrets.lastUsed = Date.now();
      const backupMethod = userSecrets.methods.find(m => m.type === 'backup');
      if (backupMethod) {
        backupMethod.lastUsed = Date.now();
      }
      
      this.logger.info(`Successful backup code verification for user ${userId}`);
      this.emit('verificationSuccess', { userId, method: 'backup', ip });
      this.emit('backupCodeUsed', { userId, remainingCodes: userSecrets.backupCodes.length });
    } else {
      this.logger.warn(`Failed backup code verification for user ${userId}`);
      this.emit('verificationFailure', { userId, method: 'backup', ip });
    }

    return isValid;
  }

  async setupSMS(userId: string, phoneNumber: string): Promise<boolean> {
    if (!this.config.smsProvider) {
      throw new Error('SMS provider not configured');
    }

    const userSecrets = this.userSecrets.get(userId) || {
      userId,
      enabled: false,
      methods: []
    };

    userSecrets.phoneNumber = phoneNumber;
    
    // SMS方法を追加
    const existingSMS = userSecrets.methods.find(m => m.type === 'sms');
    if (existingSMS) {
      existingSMS.enabled = true;
    } else {
      userSecrets.methods.push({
        type: 'sms',
        enabled: true,
        verified: false,
        createdAt: Date.now()
      });
    }

    this.userSecrets.set(userId, userSecrets);
    
    this.logger.info(`SMS setup for user ${userId}`);
    return true;
  }

  async sendSMSCode(userId: string): Promise<boolean> {
    const userSecrets = this.userSecrets.get(userId);
    if (!userSecrets?.phoneNumber || !this.config.smsProvider) {
      return false;
    }

    if (!this.rateLimiter.isAllowed(userId)) {
      throw new Error('Too many attempts. Please try again later.');
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6桁コード
    
    try {
      const sent = await this.config.smsProvider.sendCode(userSecrets.phoneNumber, code);
      
      if (sent) {
        this.smsCodes.set(userId, {
          code,
          timestamp: Date.now()
        });
        
        // 5分後にコードを削除
        setTimeout(() => {
          this.smsCodes.delete(userId);
        }, 5 * 60 * 1000);
        
        this.logger.info(`SMS code sent to user ${userId}`);
        return true;
      }
    } catch (error) {
      this.logger.error(`Failed to send SMS code to user ${userId}`, error);
    }

    return false;
  }

  async verifySMSCode(userId: string, code: string, ip?: string): Promise<boolean> {
    const storedCodeData = this.smsCodes.get(userId);
    if (!storedCodeData) {
      return false;
    }

    if (!this.rateLimiter.isAllowed(userId, ip)) {
      throw new Error('Too many attempts. Please try again later.');
    }

    // コード有効期限チェック（5分）
    const isExpired = Date.now() - storedCodeData.timestamp > 5 * 60 * 1000;
    if (isExpired) {
      this.smsCodes.delete(userId);
      return false;
    }

    const isValid = code === storedCodeData.code;
    
    this.rateLimiter.recordAttempt(userId, 'sms', isValid, ip);

    if (isValid) {
      this.smsCodes.delete(userId);
      
      const userSecrets = this.userSecrets.get(userId);
      if (userSecrets) {
        userSecrets.lastUsed = Date.now();
        const smsMethod = userSecrets.methods.find(m => m.type === 'sms');
        if (smsMethod) {
          smsMethod.verified = true;
          smsMethod.lastUsed = Date.now();
        }
      }
      
      this.logger.info(`Successful SMS verification for user ${userId}`);
      this.emit('verificationSuccess', { userId, method: 'sms', ip });
    } else {
      this.logger.warn(`Failed SMS verification for user ${userId}`);
      this.emit('verificationFailure', { userId, method: 'sms', ip });
    }

    return isValid;
  }

  getUserSecrets(userId: string): UserSecrets | null {
    const secrets = this.userSecrets.get(userId);
    if (!secrets) return null;

    // センシティブ情報を除外したコピーを返す
    return {
      userId: secrets.userId,
      enabled: secrets.enabled,
      lastUsed: secrets.lastUsed,
      methods: secrets.methods.map(method => ({ ...method })),
      phoneNumber: secrets.phoneNumber ? '***-***-' + secrets.phoneNumber.slice(-4) : undefined
    };
  }

  disable2FA(userId: string): boolean {
    const userSecrets = this.userSecrets.get(userId);
    if (!userSecrets) return false;

    userSecrets.enabled = false;
    userSecrets.totpSecret = undefined;
    userSecrets.backupCodes = undefined;
    userSecrets.phoneNumber = undefined;
    userSecrets.methods = [];

    this.logger.info(`2FA disabled for user ${userId}`);
    this.emit('twoFactorDisabled', { userId });

    return true;
  }

  generateNewBackupCodes(userId: string): string[] | null {
    const userSecrets = this.userSecrets.get(userId);
    if (!userSecrets?.enabled) return null;

    const backupCodes = BackupCodeGenerator.generate(
      this.config.backupCodeCount,
      this.config.backupCodeLength
    );
    const hashedBackupCodes = backupCodes.map(code => BackupCodeGenerator.hash(code));

    userSecrets.backupCodes = hashedBackupCodes;

    this.logger.info(`New backup codes generated for user ${userId}`);
    this.emit('backupCodesRegenerated', { userId });

    return backupCodes;
  }

  getRateLimitStatus(userId: string): { remaining: number; resetTime: number } {
    return this.rateLimiter.getStats(userId);
  }

  getStats() {
    const totalUsers = this.userSecrets.size;
    const enabledUsers = Array.from(this.userSecrets.values()).filter(s => s.enabled).length;
    const methodStats = {
      totp: 0,
      sms: 0,
      backup: 0
    };

    for (const secrets of this.userSecrets.values()) {
      if (secrets.enabled) {
        for (const method of secrets.methods) {
          if (method.enabled) {
            methodStats[method.type]++;
          }
        }
      }
    }

    return {
      totalUsers,
      enabledUsers,
      disabledUsers: totalUsers - enabledUsers,
      methodStats,
      activeSMSCodes: this.smsCodes.size,
      config: {
        issuer: this.config.issuer,
        serviceName: this.config.serviceName,
        totpWindow: this.config.totpWindow,
        backupCodeCount: this.config.backupCodeCount
      }
    };
  }
}

export {
  LightTwoFactorAuth,
  TwoFactorConfig,
  UserSecrets,
  TwoFactorMethod,
  QRCodeData,
  SMSProvider,
  TOTPGenerator,
  BackupCodeGenerator,
  MockSMSProvider
};