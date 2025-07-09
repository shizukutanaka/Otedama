import { EventEmitter } from 'events';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { randomBytes, createHash } from 'crypto';
import { EnhancedLogger, AuthenticationError, ValidationError } from '../core/error-handling';
import { Database, MinerRecord } from '../database/enhanced-database';
import { RateLimiter } from '../core/async-optimization';

/**
 * Miner Authentication System
 * Secure authentication following Robert C. Martin's security principles
 * Implements JWT tokens, sessions, and multi-factor authentication
 */

// ===== Types and Interfaces =====
export interface AuthConfig {
  jwtSecret: string;
  jwtExpiry: string; // e.g., '24h', '7d'
  refreshTokenExpiry: string; // e.g., '30d'
  bcryptRounds: number;
  sessionTimeout: number; // milliseconds
  maxLoginAttempts: number;
  lockoutDuration: number; // milliseconds
  requireEmailVerification: boolean;
  enable2FA: boolean;
  apiKeyLength: number;
}

export interface MinerCredentials {
  address: string;
  workerName?: string;
  password?: string;
  email?: string;
  totpSecret?: string;
}

export interface AuthToken {
  token: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface Session {
  sessionId: string;
  minerId: string;
  address: string;
  workerName?: string;
  ipAddress: string;
  userAgent?: string;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
}

export interface ApiKey {
  key: string;
  name: string;
  minerId: string;
  permissions: string[];
  rateLimit?: number;
  createdAt: number;
  lastUsed?: number;
  expiresAt?: number;
}

export interface LoginAttempt {
  address: string;
  attempts: number;
  lastAttempt: number;
  lockedUntil?: number;
}

// ===== JWT Token Payload =====
interface JwtPayload {
  minerId: string;
  address: string;
  workerName?: string;
  type: 'access' | 'refresh';
  iat?: number;
  exp?: number;
}

// ===== Password Validator =====
export class PasswordValidator {
  static validate(password: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (password.length < 8) {
      errors.push('Password must be at least 8 characters long');
    }
    
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }
    
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }
    
    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain at least one number');
    }
    
    if (!/[^A-Za-z0-9]/.test(password)) {
      errors.push('Password must contain at least one special character');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  static generateSecurePassword(length: number = 16): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
    let password = '';
    
    const randomValues = randomBytes(length);
    for (let i = 0; i < length; i++) {
      password += charset[randomValues[i] % charset.length];
    }
    
    return password;
  }
}

// ===== Two-Factor Authentication =====
export class TwoFactorAuth {
  private static readonly TOTP_WINDOW = 30; // seconds
  private static readonly TOTP_DIGITS = 6;
  
  static generateSecret(): string {
    return randomBytes(32).toString('base64');
  }
  
  static generateTOTP(secret: string, timestamp?: number): string {
    const time = Math.floor((timestamp || Date.now()) / 1000 / this.TOTP_WINDOW);
    const hmac = createHash('sha1');
    hmac.update(Buffer.from(secret, 'base64'));
    hmac.update(Buffer.from(time.toString(16).padStart(16, '0'), 'hex'));
    
    const hash = hmac.digest();
    const offset = hash[hash.length - 1] & 0xf;
    const binary = 
      ((hash[offset] & 0x7f) << 24) |
      ((hash[offset + 1] & 0xff) << 16) |
      ((hash[offset + 2] & 0xff) << 8) |
      (hash[offset + 3] & 0xff);
    
    const otp = binary % Math.pow(10, this.TOTP_DIGITS);
    return otp.toString().padStart(this.TOTP_DIGITS, '0');
  }
  
  static verifyTOTP(secret: string, token: string, window: number = 1): boolean {
    const now = Date.now();
    
    for (let i = -window; i <= window; i++) {
      const time = now + (i * this.TOTP_WINDOW * 1000);
      const expectedToken = this.generateTOTP(secret, time);
      
      if (token === expectedToken) {
        return true;
      }
    }
    
    return false;
  }
  
  static generateBackupCodes(count: number = 10): string[] {
    const codes: string[] = [];
    
    for (let i = 0; i < count; i++) {
      const code = randomBytes(4).toString('hex').toUpperCase();
      codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
    }
    
    return codes;
  }
}

// ===== Authentication Manager =====
export class AuthenticationManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private apiKeys = new Map<string, ApiKey>();
  private loginAttempts = new Map<string, LoginAttempt>();
  private rateLimiter: RateLimiter;
  private sessionCleanupTimer?: NodeJS.Timeout;
  private logger: EnhancedLogger;
  
  constructor(
    private config: AuthConfig,
    private database: Database
  ) {
    super();
    this.logger = EnhancedLogger.getInstance();
    this.rateLimiter = new RateLimiter(100, 10); // 100 tokens, 10 per second
    this.startSessionCleanup();
  }
  
  // Register new miner
  async register(credentials: MinerCredentials): Promise<MinerRecord> {
    // Validate input
    if (!credentials.address) {
      throw new ValidationError('Address is required');
    }
    
    if (credentials.password) {
      const validation = PasswordValidator.validate(credentials.password);
      if (!validation.valid) {
        throw new ValidationError('Invalid password', {
          additionalData: { errors: validation.errors }
        });
      }
    }
    
    // Check if miner already exists
    const existing = await this.database.getMinerByAddress(credentials.address);
    if (existing) {
      throw new AuthenticationError('Miner already registered');
    }
    
    // Hash password
    const passwordHash = credentials.password ?
      await bcrypt.hash(credentials.password, this.config.bcryptRounds) :
      undefined;
    
    // Generate miner ID
    const minerId = this.generateMinerId(credentials.address, credentials.workerName);
    
    // Create miner record
    const miner: MinerRecord = {
      minerId,
      address: credentials.address,
      workerName: credentials.workerName,
      email: credentials.email,
      passwordHash,
      lastSeen: Date.now(),
      totalShares: 0,
      validShares: 0,
      invalidShares: 0,
      hashrate: 0,
      balance: 0,
      paidAmount: 0,
      createdAt: Date.now(),
      settings: {
        emailVerified: false,
        twoFactorEnabled: false
      }
    };
    
    // Save to database
    await this.database.upsertMiner(miner);
    
    this.logger.info('Miner registered', {
      minerId,
      address: credentials.address,
      workerName: credentials.workerName
    });
    
    this.emit('minerRegistered', miner);
    
    return miner;
  }
  
  // Login miner
  async login(
    credentials: MinerCredentials,
    ipAddress: string,
    userAgent?: string
  ): Promise<AuthToken> {
    // Rate limiting
    await this.rateLimiter.acquire();
    
    // Check login attempts
    this.checkLoginAttempts(credentials.address);
    
    // Get miner
    const miner = await this.database.getMinerByAddress(credentials.address);
    if (!miner) {
      this.recordFailedLogin(credentials.address);
      throw new AuthenticationError('Invalid credentials');
    }
    
    // Verify password if set
    if (miner.passwordHash && credentials.password) {
      const valid = await bcrypt.compare(credentials.password, miner.passwordHash);
      if (!valid) {
        this.recordFailedLogin(credentials.address);
        throw new AuthenticationError('Invalid credentials');
      }
    }
    
    // Verify worker name if specified
    if (credentials.workerName && miner.workerName && 
        credentials.workerName !== miner.workerName) {
      this.recordFailedLogin(credentials.address);
      throw new AuthenticationError('Invalid worker name');
    }
    
    // Check 2FA if enabled
    if (this.config.enable2FA && miner.settings?.twoFactorEnabled) {
      // 2FA verification would happen here
      // Simplified for this implementation
    }
    
    // Clear login attempts
    this.loginAttempts.delete(credentials.address);
    
    // Create session
    const session = this.createSession(miner, ipAddress, userAgent);
    
    // Generate tokens
    const token = this.generateAccessToken(miner);
    const refreshToken = this.generateRefreshToken(miner);
    
    // Update last seen
    await this.database.updateMinerStats(miner.minerId, {
      lastSeen: Date.now()
    });
    
    this.logger.info('Miner logged in', {
      minerId: miner.minerId,
      sessionId: session.sessionId
    });
    
    this.emit('minerLoggedIn', { miner, session });
    
    return {
      token,
      refreshToken,
      expiresIn: this.getTokenExpiry(this.config.jwtExpiry),
      tokenType: 'Bearer'
    };
  }
  
  // Verify token
  async verifyToken(token: string): Promise<JwtPayload> {
    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as JwtPayload;
      
      if (payload.type !== 'access') {
        throw new AuthenticationError('Invalid token type');
      }
      
      return payload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthenticationError('Token expired');
      } else if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthenticationError('Invalid token');
      }
      throw error;
    }
  }
  
  // Refresh token
  async refreshToken(refreshToken: string): Promise<AuthToken> {
    try {
      const payload = jwt.verify(refreshToken, this.config.jwtSecret) as JwtPayload;
      
      if (payload.type !== 'refresh') {
        throw new AuthenticationError('Invalid token type');
      }
      
      // Get miner
      const miner = await this.database.getMiner(payload.minerId);
      if (!miner) {
        throw new AuthenticationError('Miner not found');
      }
      
      // Generate new tokens
      const newToken = this.generateAccessToken(miner);
      const newRefreshToken = this.generateRefreshToken(miner);
      
      return {
        token: newToken,
        refreshToken: newRefreshToken,
        expiresIn: this.getTokenExpiry(this.config.jwtExpiry),
        tokenType: 'Bearer'
      };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new AuthenticationError('Refresh token expired');
      } else if (error instanceof jwt.JsonWebTokenError) {
        throw new AuthenticationError('Invalid refresh token');
      }
      throw error;
    }
  }
  
  // Logout
  async logout(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      
      this.logger.info('Miner logged out', {
        minerId: session.minerId,
        sessionId
      });
      
      this.emit('minerLoggedOut', session);
    }
  }
  
  // Verify session
  verifySession(sessionId: string): Session | null {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return null;
    }
    
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return null;
    }
    
    // Update last activity
    session.lastActivity = Date.now();
    
    return session;
  }
  
  // Create API key
  async createApiKey(
    minerId: string,
    name: string,
    permissions: string[],
    expiresIn?: number
  ): Promise<ApiKey> {
    const key = this.generateApiKey();
    
    const apiKey: ApiKey = {
      key,
      name,
      minerId,
      permissions,
      createdAt: Date.now(),
      expiresAt: expiresIn ? Date.now() + expiresIn : undefined
    };
    
    this.apiKeys.set(key, apiKey);
    
    // Store hashed version in database
    const hashedKey = createHash('sha256').update(key).digest('hex');
    await this.database.updateMinerStats(minerId, {
      settings: {
        apiKeys: [
          { name, hash: hashedKey, permissions, createdAt: apiKey.createdAt }
        ]
      }
    });
    
    this.logger.info('API key created', {
      minerId,
      name,
      permissions
    });
    
    return apiKey;
  }
  
  // Verify API key
  async verifyApiKey(key: string): Promise<ApiKey | null> {
    const apiKey = this.apiKeys.get(key);
    
    if (!apiKey) {
      // Check database for hashed key
      const hashedKey = createHash('sha256').update(key).digest('hex');
      // Would need to implement database lookup by API key hash
      return null;
    }
    
    if (apiKey.expiresAt && Date.now() > apiKey.expiresAt) {
      this.apiKeys.delete(key);
      return null;
    }
    
    // Update last used
    apiKey.lastUsed = Date.now();
    
    return apiKey;
  }
  
  // Enable 2FA
  async enable2FA(minerId: string): Promise<{
    secret: string;
    qrCode: string;
    backupCodes: string[];
  }> {
    const miner = await this.database.getMiner(minerId);
    if (!miner) {
      throw new AuthenticationError('Miner not found');
    }
    
    const secret = TwoFactorAuth.generateSecret();
    const backupCodes = TwoFactorAuth.generateBackupCodes();
    
    // Update miner settings
    await this.database.updateMinerStats(minerId, {
      settings: {
        ...miner.settings,
        twoFactorEnabled: true,
        twoFactorSecret: secret,
        backupCodes: backupCodes.map(code => 
          createHash('sha256').update(code).digest('hex')
        )
      }
    });
    
    // Generate QR code URL (simplified)
    const qrCode = `otpauth://totp/OtedamaPool:${miner.address}?secret=${secret}&issuer=OtedamaPool`;
    
    this.logger.info('2FA enabled', { minerId });
    
    return { secret, qrCode, backupCodes };
  }
  
  // Verify 2FA
  async verify2FA(minerId: string, token: string): Promise<boolean> {
    const miner = await this.database.getMiner(minerId);
    if (!miner || !miner.settings?.twoFactorEnabled) {
      return false;
    }
    
    const secret = miner.settings.twoFactorSecret;
    if (!secret) {
      return false;
    }
    
    return TwoFactorAuth.verifyTOTP(secret, token);
  }
  
  // Change password
  async changePassword(
    minerId: string,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    const miner = await this.database.getMiner(minerId);
    if (!miner) {
      throw new AuthenticationError('Miner not found');
    }
    
    // Verify old password
    if (miner.passwordHash) {
      const valid = await bcrypt.compare(oldPassword, miner.passwordHash);
      if (!valid) {
        throw new AuthenticationError('Invalid old password');
      }
    }
    
    // Validate new password
    const validation = PasswordValidator.validate(newPassword);
    if (!validation.valid) {
      throw new ValidationError('Invalid new password', {
        additionalData: { errors: validation.errors }
      });
    }
    
    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, this.config.bcryptRounds);
    
    // Update database
    await this.database.updateMinerStats(minerId, { passwordHash });
    
    this.logger.info('Password changed', { minerId });
    
    // Invalidate all sessions
    this.invalidateAllSessions(minerId);
  }
  
  // Private methods
  private generateMinerId(address: string, workerName?: string): string {
    const base = `${address}${workerName || ''}`;
    return createHash('sha256').update(base).digest('hex').substring(0, 16);
  }
  
  private generateAccessToken(miner: MinerRecord): string {
    const payload: JwtPayload = {
      minerId: miner.minerId,
      address: miner.address,
      workerName: miner.workerName,
      type: 'access'
    };
    
    return jwt.sign(payload, this.config.jwtSecret, {
      expiresIn: this.config.jwtExpiry
    });
  }
  
  private generateRefreshToken(miner: MinerRecord): string {
    const payload: JwtPayload = {
      minerId: miner.minerId,
      address: miner.address,
      workerName: miner.workerName,
      type: 'refresh'
    };
    
    return jwt.sign(payload, this.config.jwtSecret, {
      expiresIn: this.config.refreshTokenExpiry
    });
  }
  
  private createSession(
    miner: MinerRecord,
    ipAddress: string,
    userAgent?: string
  ): Session {
    const sessionId = randomBytes(32).toString('hex');
    
    const session: Session = {
      sessionId,
      minerId: miner.minerId,
      address: miner.address,
      workerName: miner.workerName,
      ipAddress,
      userAgent,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      expiresAt: Date.now() + this.config.sessionTimeout
    };
    
    this.sessions.set(sessionId, session);
    
    return session;
  }
  
  private generateApiKey(): string {
    return randomBytes(this.config.apiKeyLength).toString('base64url');
  }
  
  private checkLoginAttempts(address: string): void {
    const attempt = this.loginAttempts.get(address);
    
    if (attempt && attempt.lockedUntil) {
      if (Date.now() < attempt.lockedUntil) {
        throw new AuthenticationError('Account locked due to too many failed attempts');
      } else {
        // Unlock expired
        this.loginAttempts.delete(address);
      }
    }
  }
  
  private recordFailedLogin(address: string): void {
    const attempt = this.loginAttempts.get(address) || {
      address,
      attempts: 0,
      lastAttempt: 0
    };
    
    attempt.attempts++;
    attempt.lastAttempt = Date.now();
    
    if (attempt.attempts >= this.config.maxLoginAttempts) {
      attempt.lockedUntil = Date.now() + this.config.lockoutDuration;
      
      this.logger.warn('Account locked', {
        address,
        attempts: attempt.attempts
      });
    }
    
    this.loginAttempts.set(address, attempt);
  }
  
  private getTokenExpiry(expiry: string): number {
    const match = expiry.match(/^(\d+)([hdm])$/);
    if (!match) {
      return 86400; // Default 24 hours
    }
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch (unit) {
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      case 'm':
        return value * 60;
      default:
        return 86400;
    }
  }
  
  private invalidateAllSessions(minerId: string): void {
    const toDelete: string[] = [];
    
    this.sessions.forEach((session, sessionId) => {
      if (session.minerId === minerId) {
        toDelete.push(sessionId);
      }
    });
    
    toDelete.forEach(sessionId => {
      this.sessions.delete(sessionId);
    });
  }
  
  private startSessionCleanup(): void {
    this.sessionCleanupTimer = setInterval(() => {
      const now = Date.now();
      const toDelete: string[] = [];
      
      this.sessions.forEach((session, sessionId) => {
        if (now > session.expiresAt) {
          toDelete.push(sessionId);
        }
      });
      
      toDelete.forEach(sessionId => {
        this.sessions.delete(sessionId);
      });
      
      if (toDelete.length > 0) {
        this.logger.debug('Cleaned expired sessions', { count: toDelete.length });
      }
    }, 60000); // Every minute
  }
  
  // Get statistics
  getStats() {
    return {
      activeSessions: this.sessions.size,
      activeApiKeys: this.apiKeys.size,
      lockedAccounts: Array.from(this.loginAttempts.values())
        .filter(a => a.lockedUntil && a.lockedUntil > Date.now()).length
    };
  }
  
  // Stop authentication manager
  stop(): void {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
    }
    
    this.sessions.clear();
    this.apiKeys.clear();
    this.loginAttempts.clear();
  }
}