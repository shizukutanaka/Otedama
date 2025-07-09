// Enhanced authentication system with proper security
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { Database } from '../database/database';

export interface AuthCredentials {
  username: string;
  password: string;
  workerName?: string;
  twoFactorCode?: string;
}

export interface AuthResult {
  success: boolean;
  minerId?: string;
  token?: string;
  message?: string;
  requiresTwoFactor?: boolean;
}

export interface MinerAuth {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  address: string;
  apiKeys: string[];
  twoFactorSecret?: string;
  loginAttempts: number;
  lockedUntil?: number;
  lastLogin?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionInfo {
  minerId: string;
  username: string;
  workerName?: string;
  ipAddress: string;
  userAgent: string;
  createdAt: number;
  lastActivity: number;
  permissions: string[];
}

export class EnhancedAuthSystem extends EventEmitter {
  private db: Database;
  private sessions = new Map<string, SessionInfo>();
  private loginAttempts = new Map<string, number[]>(); // IP -> timestamps
  private minerAuthCache = new Map<string, MinerAuth>();
  
  // Security configuration
  private readonly config = {
    saltRounds: 16,
    tokenLength: 32,
    sessionTimeout: 24 * 60 * 60 * 1000, // 24 hours
    maxLoginAttempts: 5,
    lockoutDuration: 30 * 60 * 1000, // 30 minutes
    passwordMinLength: 8,
    requireStrongPassword: true,
    maxSessionsPerMiner: 10,
    rateLimitWindow: 60 * 1000, // 1 minute
    maxAttemptsPerIP: 10
  };
  
  constructor(db: Database) {
    super();
    this.db = db;
    this.initialize();
  }
  
  private async initialize(): Promise<void> {
    // Load existing auth data
    await this.loadAuthData();
    
    // Start session cleanup
    setInterval(() => this.cleanupSessions(), 60 * 1000); // Every minute
    
    // Start login attempt cleanup
    setInterval(() => this.cleanupLoginAttempts(), 5 * 60 * 1000); // Every 5 minutes
  }
  
  // Secure password hashing using PBKDF2
  private hashPassword(password: string, salt: string): string {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  }
  
  // Generate cryptographically secure salt
  private generateSalt(): string {
    return crypto.randomBytes(this.config.saltRounds).toString('hex');
  }
  
  // Generate secure session token
  private generateToken(): string {
    return crypto.randomBytes(this.config.tokenLength).toString('hex');
  }
  
  // Load auth data from database
  private async loadAuthData(): Promise<void> {
    // In production, this would load from a dedicated auth table
    const miners = await this.db.getAllMiners();
    
    for (const miner of miners) {
      // Create auth entries for existing miners
      const authEntry: MinerAuth = {
        id: miner.id,
        username: miner.address, // Use address as username initially
        passwordHash: '', // Will be set on first login
        salt: this.generateSalt(),
        address: miner.address,
        apiKeys: [],
        loginAttempts: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      
      this.minerAuthCache.set(miner.id, authEntry);
    }
  }
  
  // Authenticate miner
  async authenticate(credentials: AuthCredentials, ipAddress: string, userAgent: string): Promise<AuthResult> {
    const { username, password, workerName, twoFactorCode } = credentials;
    
    // Rate limiting by IP
    if (!this.checkRateLimit(ipAddress)) {
      return { 
        success: false, 
        message: 'Too many login attempts. Please try again later.' 
      };
    }
    
    // Validate input
    if (!username || !password) {
      return { success: false, message: 'Username and password are required' };
    }
    
    // Find auth entry
    const authEntry = await this.findAuthEntry(username);
    
    if (!authEntry) {
      // Check if this is a new registration
      if (this.isValidBitcoinAddress(username)) {
        return await this.registerNewMiner(username, password, ipAddress);
      }
      
      this.recordFailedAttempt(ipAddress);
      return { success: false, message: 'Invalid credentials' };
    }
    
    // Check if account is locked
    if (authEntry.lockedUntil && authEntry.lockedUntil > Date.now()) {
      const remainingTime = Math.ceil((authEntry.lockedUntil - Date.now()) / 60000);
      return { 
        success: false, 
        message: `Account locked. Try again in ${remainingTime} minutes.` 
      };
    }
    
    // Verify password
    const passwordHash = this.hashPassword(password, authEntry.salt);
    if (passwordHash !== authEntry.passwordHash) {
      await this.handleFailedLogin(authEntry);
      this.recordFailedAttempt(ipAddress);
      return { success: false, message: 'Invalid credentials' };
    }
    
    // Check 2FA if enabled
    if (authEntry.twoFactorSecret) {
      if (!twoFactorCode) {
        return { 
          success: false, 
          requiresTwoFactor: true,
          message: 'Two-factor authentication code required' 
        };
      }
      
      if (!this.verify2FA(authEntry.twoFactorSecret, twoFactorCode)) {
        await this.handleFailedLogin(authEntry);
        return { success: false, message: 'Invalid two-factor code' };
      }
    }
    
    // Successful authentication
    await this.handleSuccessfulLogin(authEntry);
    
    // Create session
    const minerId = workerName ? `${authEntry.username}.${workerName}` : authEntry.username;
    const token = this.createSession(minerId, authEntry.username, ipAddress, userAgent, workerName);
    
    this.emit('login', { minerId, ipAddress, userAgent });
    
    return { 
      success: true, 
      minerId,
      token
    };
  }
  
  // Find auth entry by username or miner ID
  private async findAuthEntry(username: string): Promise<MinerAuth | null> {
    // Check cache first
    for (const [id, entry] of this.minerAuthCache) {
      if (entry.username === username || entry.address === username) {
        return entry;
      }
    }
    
    // Check database
    const miner = await this.db.getMiner(username);
    if (miner) {
      return this.minerAuthCache.get(miner.id) || null;
    }
    
    return null;
  }
  
  // Register new miner
  private async registerNewMiner(address: string, password: string, ipAddress: string): Promise<AuthResult> {
    // Validate Bitcoin address
    if (!this.isValidBitcoinAddress(address)) {
      return { success: false, message: 'Invalid Bitcoin address' };
    }
    
    // Validate password strength
    const passwordValidation = this.validatePassword(password);
    if (!passwordValidation.valid) {
      return { success: false, message: passwordValidation.message };
    }
    
    // Create new miner
    const salt = this.generateSalt();
    const passwordHash = this.hashPassword(password, salt);
    
    const authEntry: MinerAuth = {
      id: address,
      username: address,
      passwordHash,
      salt,
      address,
      apiKeys: [],
      loginAttempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    // Save to cache and database
    this.minerAuthCache.set(address, authEntry);
    await this.saveAuthEntry(authEntry);
    
    // Create session
    const token = this.createSession(address, address, ipAddress, '', undefined);
    
    this.emit('registration', { minerId: address, ipAddress });
    
    return { 
      success: true, 
      minerId: address,
      token,
      message: 'Registration successful' 
    };
  }
  
  // Validate password strength
  private validatePassword(password: string): { valid: boolean; message?: string } {
    if (password.length < this.config.passwordMinLength) {
      return { 
        valid: false, 
        message: `Password must be at least ${this.config.passwordMinLength} characters long` 
      };
    }
    
    if (this.config.requireStrongPassword) {
      // Check for at least one uppercase, one lowercase, one number, and one special character
      const hasUpper = /[A-Z]/.test(password);
      const hasLower = /[a-z]/.test(password);
      const hasNumber = /[0-9]/.test(password);
      const hasSpecial = /[^A-Za-z0-9]/.test(password);
      
      if (!hasUpper || !hasLower || !hasNumber || !hasSpecial) {
        return { 
          valid: false, 
          message: 'Password must contain uppercase, lowercase, number, and special character' 
        };
      }
    }
    
    return { valid: true };
  }
  
  // Bitcoin address validation
  private isValidBitcoinAddress(address: string): boolean {
    // P2PKH addresses (start with 1)
    if (/^1[a-zA-Z0-9]{25,34}$/.test(address)) return true;
    
    // P2SH addresses (start with 3)
    if (/^3[a-zA-Z0-9]{25,34}$/.test(address)) return true;
    
    // Bech32 addresses (start with bc1)
    if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;
    
    // Taproot addresses (start with bc1p)
    if (/^bc1p[a-z0-9]{58}$/.test(address)) return true;
    
    return false;
  }
  
  // Handle failed login
  private async handleFailedLogin(authEntry: MinerAuth): Promise<void> {
    authEntry.loginAttempts++;
    authEntry.updatedAt = Date.now();
    
    if (authEntry.loginAttempts >= this.config.maxLoginAttempts) {
      authEntry.lockedUntil = Date.now() + this.config.lockoutDuration;
      this.emit('accountLocked', { minerId: authEntry.id });
    }
    
    await this.saveAuthEntry(authEntry);
  }
  
  // Handle successful login
  private async handleSuccessfulLogin(authEntry: MinerAuth): Promise<void> {
    authEntry.loginAttempts = 0;
    authEntry.lockedUntil = undefined;
    authEntry.lastLogin = Date.now();
    authEntry.updatedAt = Date.now();
    
    await this.saveAuthEntry(authEntry);
  }
  
  // Save auth entry to database
  private async saveAuthEntry(authEntry: MinerAuth): Promise<void> {
    // In production, save to dedicated auth table
    // For now, update miner record
    const miner = await this.db.getMiner(authEntry.id);
    if (miner) {
      await this.db.saveMiner(miner);
    }
  }
  
  // Create session
  private createSession(
    minerId: string, 
    username: string,
    ipAddress: string, 
    userAgent: string,
    workerName?: string
  ): string {
    // Check max sessions per miner
    const minerSessions = Array.from(this.sessions.values())
      .filter(s => s.username === username);
    
    if (minerSessions.length >= this.config.maxSessionsPerMiner) {
      // Remove oldest session
      const oldest = minerSessions.sort((a, b) => a.createdAt - b.createdAt)[0];
      const oldestToken = Array.from(this.sessions.entries())
        .find(([_, session]) => session === oldest)?.[0];
      
      if (oldestToken) {
        this.sessions.delete(oldestToken);
      }
    }
    
    const token = this.generateToken();
    const session: SessionInfo = {
      minerId,
      username,
      workerName,
      ipAddress,
      userAgent,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      permissions: ['mine', 'stats'] // Default permissions
    };
    
    this.sessions.set(token, session);
    
    // Set session timeout
    setTimeout(() => {
      this.sessions.delete(token);
    }, this.config.sessionTimeout);
    
    return token;
  }
  
  // Validate session
  validateSession(token: string): SessionInfo | null {
    const session = this.sessions.get(token);
    
    if (!session) {
      return null;
    }
    
    // Check if session expired
    if (Date.now() - session.lastActivity > this.config.sessionTimeout) {
      this.sessions.delete(token);
      return null;
    }
    
    // Update last activity
    session.lastActivity = Date.now();
    
    return session;
  }
  
  // Revoke session
  revokeSession(token: string): void {
    const session = this.sessions.get(token);
    if (session) {
      this.emit('logout', { minerId: session.minerId });
      this.sessions.delete(token);
    }
  }
  
  // Rate limiting
  private checkRateLimit(ipAddress: string): boolean {
    const attempts = this.loginAttempts.get(ipAddress) || [];
    const recentAttempts = attempts.filter(t => Date.now() - t < this.config.rateLimitWindow);
    
    if (recentAttempts.length >= this.config.maxAttemptsPerIP) {
      return false;
    }
    
    return true;
  }
  
  // Record failed attempt
  private recordFailedAttempt(ipAddress: string): void {
    const attempts = this.loginAttempts.get(ipAddress) || [];
    attempts.push(Date.now());
    this.loginAttempts.set(ipAddress, attempts);
  }
  
  // Cleanup old sessions
  private cleanupSessions(): void {
    const now = Date.now();
    
    for (const [token, session] of this.sessions) {
      if (now - session.lastActivity > this.config.sessionTimeout) {
        this.sessions.delete(token);
      }
    }
  }
  
  // Cleanup old login attempts
  private cleanupLoginAttempts(): void {
    const now = Date.now();
    
    for (const [ip, attempts] of this.loginAttempts) {
      const recentAttempts = attempts.filter(t => now - t < this.config.rateLimitWindow * 10);
      
      if (recentAttempts.length === 0) {
        this.loginAttempts.delete(ip);
      } else {
        this.loginAttempts.set(ip, recentAttempts);
      }
    }
  }
  
  // 2FA verification (simplified - use speakeasy in production)
  private verify2FA(secret: string, code: string): boolean {
    // Placeholder - implement TOTP verification
    return true;
  }
  
  // Change password
  async changePassword(minerId: string, oldPassword: string, newPassword: string): Promise<{ success: boolean; message?: string }> {
    const authEntry = this.minerAuthCache.get(minerId);
    
    if (!authEntry) {
      return { success: false, message: 'Miner not found' };
    }
    
    // Verify old password
    const oldHash = this.hashPassword(oldPassword, authEntry.salt);
    if (oldHash !== authEntry.passwordHash) {
      return { success: false, message: 'Current password is incorrect' };
    }
    
    // Validate new password
    const validation = this.validatePassword(newPassword);
    if (!validation.valid) {
      return { success: false, message: validation.message };
    }
    
    // Update password
    authEntry.salt = this.generateSalt();
    authEntry.passwordHash = this.hashPassword(newPassword, authEntry.salt);
    authEntry.updatedAt = Date.now();
    
    await this.saveAuthEntry(authEntry);
    
    // Revoke all sessions for this miner
    for (const [token, session] of this.sessions) {
      if (session.minerId === minerId) {
        this.sessions.delete(token);
      }
    }
    
    this.emit('passwordChanged', { minerId });
    
    return { success: true, message: 'Password changed successfully' };
  }
  
  // Get authentication statistics
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    lockedAccounts: number;
    recentLogins: number;
    recentFailures: number;
  } {
    const now = Date.now();
    const recentWindow = 60 * 60 * 1000; // 1 hour
    
    let lockedAccounts = 0;
    let recentLogins = 0;
    
    for (const authEntry of this.minerAuthCache.values()) {
      if (authEntry.lockedUntil && authEntry.lockedUntil > now) {
        lockedAccounts++;
      }
      
      if (authEntry.lastLogin && now - authEntry.lastLogin < recentWindow) {
        recentLogins++;
      }
    }
    
    let recentFailures = 0;
    for (const attempts of this.loginAttempts.values()) {
      recentFailures += attempts.filter(t => now - t < recentWindow).length;
    }
    
    return {
      totalSessions: this.sessions.size,
      activeSessions: Array.from(this.sessions.values())
        .filter(s => now - s.lastActivity < 5 * 60 * 1000).length,
      lockedAccounts,
      recentLogins,
      recentFailures
    };
  }
}

// API key management
export class EnhancedApiKeyManager {
  private apiKeys = new Map<string, {
    minerId: string;
    name: string;
    permissions: string[];
    rateLimit: number;
    usageCount: number;
    lastUsed?: number;
    expiresAt?: number;
    created: number;
  }>();
  
  // Generate API key with metadata
  generateApiKey(
    minerId: string, 
    name: string,
    permissions: string[] = ['read:stats'],
    expiresInDays?: number
  ): string {
    const key = `otdm_${crypto.randomBytes(32).toString('hex')}`;
    
    this.apiKeys.set(key, {
      minerId,
      name,
      permissions,
      rateLimit: 1000, // requests per hour
      usageCount: 0,
      created: Date.now(),
      expiresAt: expiresInDays ? Date.now() + (expiresInDays * 24 * 60 * 60 * 1000) : undefined
    });
    
    return key;
  }
  
  // Validate and track API key usage
  validateApiKey(key: string): {
    valid: boolean;
    minerId?: string;
    permissions?: string[];
    remaining?: number;
  } {
    const data = this.apiKeys.get(key);
    
    if (!data) {
      return { valid: false };
    }
    
    // Check expiration
    if (data.expiresAt && data.expiresAt < Date.now()) {
      return { valid: false };
    }
    
    // Update usage
    data.usageCount++;
    data.lastUsed = Date.now();
    
    // Check rate limit (simplified - use Redis in production)
    const remaining = Math.max(0, data.rateLimit - data.usageCount);
    
    return {
      valid: true,
      minerId: data.minerId,
      permissions: data.permissions,
      remaining
    };
  }
  
  // List API keys for a miner
  listApiKeys(minerId: string): Array<{
    key: string;
    name: string;
    permissions: string[];
    created: number;
    lastUsed?: number;
    expiresAt?: number;
  }> {
    const keys = [];
    
    for (const [key, data] of this.apiKeys) {
      if (data.minerId === minerId) {
        keys.push({
          key: key.substring(0, 10) + '...',  // Partial key for security
          name: data.name,
          permissions: data.permissions,
          created: data.created,
          lastUsed: data.lastUsed,
          expiresAt: data.expiresAt
        });
      }
    }
    
    return keys;
  }
  
  // Revoke API key
  revokeApiKey(key: string): boolean {
    return this.apiKeys.delete(key);
  }
}
