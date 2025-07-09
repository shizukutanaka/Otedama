/**
 * Miner Authentication System
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Secure authentication and authorization for mining pool
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes, pbkdf2, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import jwt from 'jsonwebtoken';
import { createComponentLogger } from '../logging/simple-logger';

const pbkdf2Async = promisify(pbkdf2);

// ===== INTERFACES =====
export interface AuthConfig {
  jwtSecret: string;
  jwtExpiry?: string;
  saltRounds?: number;
  maxLoginAttempts?: number;
  lockoutDuration?: number; // in minutes
  sessionTimeout?: number; // in minutes
  requireEmailVerification?: boolean;
  enable2FA?: boolean;
}

export interface MinerCredentials {
  username: string;
  password: string;
  email?: string;
  workerName?: string;
}

export interface MinerAccount {
  id: string;
  username: string;
  email?: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  lastLogin?: number;
  loginAttempts: number;
  lockedUntil?: number;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  apiKeys: ApiKey[];
  workers: Worker[];
  permissions: string[];
  metadata?: any;
}

export interface Worker {
  id: string;
  name: string;
  createdAt: number;
  lastSeen?: number;
  isActive: boolean;
  difficulty?: number;
}

export interface ApiKey {
  id: string;
  key: string;
  name: string;
  permissions: string[];
  createdAt: number;
  lastUsed?: number;
  expiresAt?: number;
}

export interface Session {
  id: string;
  minerId: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthResult {
  success: boolean;
  minerId?: string;
  token?: string;
  message?: string;
  requiresTwoFactor?: boolean;
}

// ===== AUTH STORAGE INTERFACE =====
interface AuthStorage {
  createMiner(account: MinerAccount): Promise<void>;
  getMinerByUsername(username: string): Promise<MinerAccount | null>;
  getMinerById(id: string): Promise<MinerAccount | null>;
  updateMiner(id: string, updates: Partial<MinerAccount>): Promise<void>;
  deleteMiner(id: string): Promise<void>;
  createSession(session: Session): Promise<void>;
  getSession(token: string): Promise<Session | null>;
  deleteSession(token: string): Promise<void>;
  deleteExpiredSessions(): Promise<number>;
}

// ===== IN-MEMORY STORAGE (for development) =====
class InMemoryAuthStorage implements AuthStorage {
  private miners = new Map<string, MinerAccount>();
  private minersByUsername = new Map<string, string>(); // username -> id
  private sessions = new Map<string, Session>();

  async createMiner(account: MinerAccount): Promise<void> {
    this.miners.set(account.id, account);
    this.minersByUsername.set(account.username.toLowerCase(), account.id);
  }

  async getMinerByUsername(username: string): Promise<MinerAccount | null> {
    const id = this.minersByUsername.get(username.toLowerCase());
    return id ? this.miners.get(id) || null : null;
  }

  async getMinerById(id: string): Promise<MinerAccount | null> {
    return this.miners.get(id) || null;
  }

  async updateMiner(id: string, updates: Partial<MinerAccount>): Promise<void> {
    const miner = this.miners.get(id);
    if (miner) {
      Object.assign(miner, updates);
    }
  }

  async deleteMiner(id: string): Promise<void> {
    const miner = this.miners.get(id);
    if (miner) {
      this.minersByUsername.delete(miner.username.toLowerCase());
      this.miners.delete(id);
    }
  }

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.token, session);
  }

  async getSession(token: string): Promise<Session | null> {
    return this.sessions.get(token) || null;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async deleteExpiredSessions(): Promise<number> {
    const now = Date.now();
    let deleted = 0;

    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt < now) {
        this.sessions.delete(token);
        deleted++;
      }
    }

    return deleted;
  }
}

// ===== MAIN AUTH MANAGER =====
export class MinerAuthManager extends EventEmitter {
  private config: Required<AuthConfig>;
  private storage: AuthStorage;
  private logger = createComponentLogger('MinerAuth');
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: AuthConfig, storage?: AuthStorage) {
    super();

    this.config = {
      jwtSecret: config.jwtSecret,
      jwtExpiry: config.jwtExpiry || '24h',
      saltRounds: config.saltRounds || 10,
      maxLoginAttempts: config.maxLoginAttempts || 5,
      lockoutDuration: config.lockoutDuration || 30,
      sessionTimeout: config.sessionTimeout || 1440, // 24 hours
      requireEmailVerification: config.requireEmailVerification || false,
      enable2FA: config.enable2FA || false
    };

    this.storage = storage || new InMemoryAuthStorage();

    // Start cleanup interval
    this.startCleanupInterval();
  }

  // ===== REGISTRATION =====
  async register(credentials: MinerCredentials): Promise<AuthResult> {
    try {
      // Validate input
      if (!this.validateUsername(credentials.username)) {
        return {
          success: false,
          message: 'Invalid username format'
        };
      }

      if (!this.validatePassword(credentials.password)) {
        return {
          success: false,
          message: 'Password must be at least 8 characters'
        };
      }

      // Check if username already exists
      const existing = await this.storage.getMinerByUsername(credentials.username);
      if (existing) {
        return {
          success: false,
          message: 'Username already exists'
        };
      }

      // Hash password
      const salt = randomBytes(16).toString('hex');
      const passwordHash = await this.hashPassword(credentials.password, salt);

      // Create account
      const account: MinerAccount = {
        id: this.generateId(),
        username: credentials.username,
        email: credentials.email,
        passwordHash,
        salt,
        createdAt: Date.now(),
        loginAttempts: 0,
        emailVerified: !this.config.requireEmailVerification,
        twoFactorEnabled: false,
        apiKeys: [],
        workers: [],
        permissions: ['mine']
      };

      // Add default worker if specified
      if (credentials.workerName) {
        account.workers.push({
          id: this.generateId(),
          name: credentials.workerName,
          createdAt: Date.now(),
          isActive: true
        });
      }

      await this.storage.createMiner(account);

      this.logger.info('Miner registered', {
        minerId: account.id,
        username: account.username
      });

      this.emit('miner:registered', {
        minerId: account.id,
        username: account.username
      });

      // Auto-login after registration
      const token = await this.createSession(account.id);

      return {
        success: true,
        minerId: account.id,
        token
      };
    } catch (error) {
      this.logger.error('Registration failed', error as Error);
      return {
        success: false,
        message: 'Registration failed'
      };
    }
  }

  // ===== LOGIN =====
  async login(
    username: string, 
    password: string, 
    ipAddress?: string, 
    userAgent?: string
  ): Promise<AuthResult> {
    try {
      const account = await this.storage.getMinerByUsername(username);
      
      if (!account) {
        return {
          success: false,
          message: 'Invalid credentials'
        };
      }

      // Check lockout
      if (account.lockedUntil && account.lockedUntil > Date.now()) {
        const minutesLeft = Math.ceil((account.lockedUntil - Date.now()) / 60000);
        return {
          success: false,
          message: `Account locked. Try again in ${minutesLeft} minutes`
        };
      }

      // Verify password
      const isValid = await this.verifyPassword(
        password, 
        account.passwordHash, 
        account.salt
      );

      if (!isValid) {
        // Increment login attempts
        account.loginAttempts++;
        
        if (account.loginAttempts >= this.config.maxLoginAttempts) {
          account.lockedUntil = Date.now() + (this.config.lockoutDuration * 60000);
          account.loginAttempts = 0;
        }

        await this.storage.updateMiner(account.id, {
          loginAttempts: account.loginAttempts,
          lockedUntil: account.lockedUntil
        });

        return {
          success: false,
          message: 'Invalid credentials'
        };
      }

      // Check email verification
      if (this.config.requireEmailVerification && !account.emailVerified) {
        return {
          success: false,
          message: 'Email verification required'
        };
      }

      // Check 2FA
      if (account.twoFactorEnabled) {
        return {
          success: false,
          requiresTwoFactor: true,
          message: 'Two-factor authentication required'
        };
      }

      // Reset login attempts
      account.loginAttempts = 0;
      account.lastLogin = Date.now();
      await this.storage.updateMiner(account.id, {
        loginAttempts: 0,
        lastLogin: account.lastLogin
      });

      // Create session
      const token = await this.createSession(account.id, ipAddress, userAgent);

      this.logger.info('Miner logged in', {
        minerId: account.id,
        username: account.username,
        ipAddress
      });

      this.emit('miner:login', {
        minerId: account.id,
        username: account.username,
        ipAddress
      });

      return {
        success: true,
        minerId: account.id,
        token
      };
    } catch (error) {
      this.logger.error('Login failed', error as Error);
      return {
        success: false,
        message: 'Login failed'
      };
    }
  }

  // ===== SESSION MANAGEMENT =====
  async createSession(
    minerId: string, 
    ipAddress?: string, 
    userAgent?: string
  ): Promise<string> {
    const sessionId = this.generateId();
    const token = jwt.sign(
      { 
        sessionId,
        minerId,
        iat: Math.floor(Date.now() / 1000)
      },
      this.config.jwtSecret,
      { expiresIn: this.config.jwtExpiry }
    );

    const session: Session = {
      id: sessionId,
      minerId,
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + (this.config.sessionTimeout * 60000),
      ipAddress,
      userAgent
    };

    await this.storage.createSession(session);

    return token;
  }

  async validateSession(token: string): Promise<{ valid: boolean; minerId?: string }> {
    try {
      // Verify JWT
      const decoded = jwt.verify(token, this.config.jwtSecret) as any;
      
      // Check session in storage
      const session = await this.storage.getSession(token);
      
      if (!session || session.expiresAt < Date.now()) {
        return { valid: false };
      }

      return {
        valid: true,
        minerId: session.minerId
      };
    } catch (error) {
      return { valid: false };
    }
  }

  async logout(token: string): Promise<void> {
    await this.storage.deleteSession(token);
    
    this.emit('miner:logout', { token });
  }

  // ===== WORKER MANAGEMENT =====
  async addWorker(minerId: string, workerName: string): Promise<Worker | null> {
    const account = await this.storage.getMinerById(minerId);
    if (!account) return null;

    // Check if worker already exists
    const existing = account.workers.find(w => w.name === workerName);
    if (existing) return existing;

    const worker: Worker = {
      id: this.generateId(),
      name: workerName,
      createdAt: Date.now(),
      isActive: true
    };

    account.workers.push(worker);
    await this.storage.updateMiner(minerId, { workers: account.workers });

    this.emit('worker:added', { minerId, worker });

    return worker;
  }

  async getWorkers(minerId: string): Promise<Worker[]> {
    const account = await this.storage.getMinerById(minerId);
    return account?.workers || [];
  }

  async updateWorkerActivity(minerId: string, workerName: string): Promise<void> {
    const account = await this.storage.getMinerById(minerId);
    if (!account) return;

    const worker = account.workers.find(w => w.name === workerName);
    if (worker) {
      worker.lastSeen = Date.now();
      worker.isActive = true;
      await this.storage.updateMiner(minerId, { workers: account.workers });
    }
  }

  // ===== API KEY MANAGEMENT =====
  async createApiKey(
    minerId: string, 
    name: string, 
    permissions: string[] = ['mine']
  ): Promise<ApiKey | null> {
    const account = await this.storage.getMinerById(minerId);
    if (!account) return null;

    const apiKey: ApiKey = {
      id: this.generateId(),
      key: this.generateApiKey(),
      name,
      permissions,
      createdAt: Date.now()
    };

    account.apiKeys.push(apiKey);
    await this.storage.updateMiner(minerId, { apiKeys: account.apiKeys });

    this.emit('apikey:created', { minerId, apiKey: apiKey.id });

    return apiKey;
  }

  async validateApiKey(key: string): Promise<{ valid: boolean; minerId?: string; permissions?: string[] }> {
    // This is inefficient for large scale - should use indexed storage
    for (const [, account] of await this.getAllMiners()) {
      const apiKey = account.apiKeys.find(k => k.key === key);
      if (apiKey) {
        if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) {
          return { valid: false };
        }

        // Update last used
        apiKey.lastUsed = Date.now();
        await this.storage.updateMiner(account.id, { apiKeys: account.apiKeys });

        return {
          valid: true,
          minerId: account.id,
          permissions: apiKey.permissions
        };
      }
    }

    return { valid: false };
  }

  // ===== UTILITY METHODS =====
  private async hashPassword(password: string, salt: string): Promise<string> {
    const hash = await pbkdf2Async(password, salt, 100000, 64, 'sha512');
    return hash.toString('hex');
  }

  private async verifyPassword(
    password: string, 
    hash: string, 
    salt: string
  ): Promise<boolean> {
    const passwordHash = await this.hashPassword(password, salt);
    return timingSafeEqual(
      Buffer.from(passwordHash, 'hex'),
      Buffer.from(hash, 'hex')
    );
  }

  private validateUsername(username: string): boolean {
    return /^[a-zA-Z0-9_-]{3,32}$/.test(username);
  }

  private validatePassword(password: string): boolean {
    return password.length >= 8;
  }

  private generateId(): string {
    return randomBytes(16).toString('hex');
  }

  private generateApiKey(): string {
    return randomBytes(32).toString('base64url');
  }

  private async getAllMiners(): Promise<Map<string, MinerAccount>> {
    // This is a hack for in-memory storage
    // Real implementation would have proper query methods
    const miners = new Map<string, MinerAccount>();
    
    // For now, we'll just return empty map
    // In production, this would query the database
    return miners;
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      const deleted = await this.storage.deleteExpiredSessions();
      if (deleted > 0) {
        this.logger.debug('Cleaned up expired sessions', { count: deleted });
      }
    }, 3600000); // Every hour
  }

  async stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  // ===== PERMISSION CHECKING =====
  async hasPermission(
    minerId: string, 
    permission: string
  ): Promise<boolean> {
    const account = await this.storage.getMinerById(minerId);
    return account ? account.permissions.includes(permission) : false;
  }

  async grantPermission(
    minerId: string, 
    permission: string
  ): Promise<boolean> {
    const account = await this.storage.getMinerById(minerId);
    if (!account) return false;

    if (!account.permissions.includes(permission)) {
      account.permissions.push(permission);
      await this.storage.updateMiner(minerId, { 
        permissions: account.permissions 
      });
    }

    return true;
  }

  async revokePermission(
    minerId: string, 
    permission: string
  ): Promise<boolean> {
    const account = await this.storage.getMinerById(minerId);
    if (!account) return false;

    account.permissions = account.permissions.filter(p => p !== permission);
    await this.storage.updateMiner(minerId, { 
      permissions: account.permissions 
    });

    return true;
  }
}

// ===== MIDDLEWARE FACTORY =====
export function createAuthMiddleware(authManager: MinerAuthManager) {
  return async (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const { valid, minerId } = await authManager.validateSession(token);
    
    if (!valid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.minerId = minerId;
    next();
  };
}

export function createApiKeyMiddleware(authManager: MinerAuthManager) {
  return async (req: any, res: any, next: any) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
      return res.status(401).json({ error: 'No API key provided' });
    }

    const { valid, minerId, permissions } = await authManager.validateApiKey(apiKey);
    
    if (!valid) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.minerId = minerId;
    req.permissions = permissions;
    next();
  };
}
