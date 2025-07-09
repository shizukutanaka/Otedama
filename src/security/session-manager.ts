/**
 * Secure Session Manager
 * Following Carmack/Martin/Pike principles:
 * - Security without complexity
 * - Clear session lifecycle
 * - Efficient storage and retrieval
 */

import * as crypto from 'crypto';
import { promisify } from 'util';
import Redis from 'ioredis';

interface SessionData {
  userId: string;
  username: string;
  roles: string[];
  ipAddress: string;
  userAgent: string;
  createdAt: number;
  lastAccess: number;
  expiresAt: number;
  metadata?: Record<string, any>;
}

interface SessionOptions {
  ttl?: number; // Time to live in seconds
  rolling?: boolean; // Extend session on activity
  secure?: boolean; // Require HTTPS
  httpOnly?: boolean; // HTTP only cookies
  sameSite?: 'strict' | 'lax' | 'none';
}

export class SecureSessionManager {
  private redis: Redis;
  private sessionPrefix = 'session:';
  private userSessionPrefix = 'user_sessions:';
  private defaultTTL = 3600; // 1 hour
  private maxSessionsPerUser = 5;
  private secret: string;

  constructor(redis: Redis, secret: string) {
    this.redis = redis;
    this.secret = secret;
  }

  /**
   * Create a new session
   */
  async create(
    userId: string,
    username: string,
    roles: string[],
    ipAddress: string,
    userAgent: string,
    options: SessionOptions = {}
  ): Promise<string> {
    // Generate secure session ID
    const sessionId = this.generateSessionId();
    const ttl = options.ttl || this.defaultTTL;
    
    const sessionData: SessionData = {
      userId,
      username,
      roles,
      ipAddress,
      userAgent,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      expiresAt: Date.now() + (ttl * 1000)
    };
    
    // Store session
    await this.redis.setex(
      this.sessionPrefix + sessionId,
      ttl,
      JSON.stringify(sessionData)
    );
    
    // Track user sessions
    await this.trackUserSession(userId, sessionId, ttl);
    
    // Enforce session limit
    await this.enforceSessionLimit(userId);
    
    return sessionId;
  }

  /**
   * Get session data
   */
  async get(sessionId: string): Promise<SessionData | null> {
    const data = await this.redis.get(this.sessionPrefix + sessionId);
    
    if (!data) {
      return null;
    }
    
    const session: SessionData = JSON.parse(data);
    
    // Check if expired
    if (session.expiresAt < Date.now()) {
      await this.destroy(sessionId);
      return null;
    }
    
    return session;
  }

  /**
   * Update session activity
   */
  async touch(sessionId: string, options: SessionOptions = {}): Promise<boolean> {
    const session = await this.get(sessionId);
    
    if (!session) {
      return false;
    }
    
    session.lastAccess = Date.now();
    
    // Rolling session
    if (options.rolling) {
      const ttl = options.ttl || this.defaultTTL;
      session.expiresAt = Date.now() + (ttl * 1000);
      
      await this.redis.setex(
        this.sessionPrefix + sessionId,
        ttl,
        JSON.stringify(session)
      );
    } else {
      // Just update last access
      const ttl = Math.ceil((session.expiresAt - Date.now()) / 1000);
      if (ttl > 0) {
        await this.redis.setex(
          this.sessionPrefix + sessionId,
          ttl,
          JSON.stringify(session)
        );
      }
    }
    
    return true;
  }

  /**
   * Update session data
   */
  async update(sessionId: string, updates: Partial<SessionData>): Promise<boolean> {
    const session = await this.get(sessionId);
    
    if (!session) {
      return false;
    }
    
    // Merge updates
    Object.assign(session, updates, {
      lastAccess: Date.now()
    });
    
    // Recalculate TTL
    const ttl = Math.ceil((session.expiresAt - Date.now()) / 1000);
    if (ttl > 0) {
      await this.redis.setex(
        this.sessionPrefix + sessionId,
        ttl,
        JSON.stringify(session)
      );
      return true;
    }
    
    return false;
  }

  /**
   * Destroy a session
   */
  async destroy(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    
    if (session) {
      // Remove from user sessions
      await this.redis.srem(
        this.userSessionPrefix + session.userId,
        sessionId
      );
    }
    
    // Delete session
    await this.redis.del(this.sessionPrefix + sessionId);
  }

  /**
   * Destroy all sessions for a user
   */
  async destroyAllUserSessions(userId: string): Promise<void> {
    const sessionIds = await this.redis.smembers(this.userSessionPrefix + userId);
    
    if (sessionIds.length > 0) {
      // Delete all sessions
      const keys = sessionIds.map(id => this.sessionPrefix + id);
      await this.redis.del(...keys);
    }
    
    // Clear user session set
    await this.redis.del(this.userSessionPrefix + userId);
  }

  /**
   * Get all active sessions for a user
   */
  async getUserSessions(userId: string): Promise<SessionData[]> {
    const sessionIds = await this.redis.smembers(this.userSessionPrefix + userId);
    const sessions: SessionData[] = [];
    
    for (const sessionId of sessionIds) {
      const session = await this.get(sessionId);
      if (session) {
        sessions.push(session);
      }
    }
    
    return sessions;
  }

  /**
   * Validate session token
   */
  async validate(token: string): Promise<SessionData | null> {
    try {
      const sessionId = this.verifyToken(token);
      return await this.get(sessionId);
    } catch {
      return null;
    }
  }

  /**
   * Generate session token
   */
  generateToken(sessionId: string): string {
    const payload = {
      sid: sessionId,
      iat: Date.now()
    };
    
    const data = JSON.stringify(payload);
    const signature = this.sign(data);
    
    return Buffer.from(data).toString('base64url') + '.' + signature;
  }

  /**
   * Verify and extract session ID from token
   */
  private verifyToken(token: string): string {
    const parts = token.split('.');
    if (parts.length !== 2) {
      throw new Error('Invalid token format');
    }
    
    const [dataB64, signature] = parts;
    const data = Buffer.from(dataB64, 'base64url').toString();
    
    // Verify signature
    if (this.sign(data) !== signature) {
      throw new Error('Invalid token signature');
    }
    
    const payload = JSON.parse(data);
    return payload.sid;
  }

  /**
   * Generate secure session ID
   */
  private generateSessionId(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /**
   * Sign data with HMAC
   */
  private sign(data: string): string {
    return crypto
      .createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');
  }

  /**
   * Track user session
   */
  private async trackUserSession(userId: string, sessionId: string, ttl: number): Promise<void> {
    await this.redis.sadd(this.userSessionPrefix + userId, sessionId);
    await this.redis.expire(this.userSessionPrefix + userId, ttl);
  }

  /**
   * Enforce session limit per user
   */
  private async enforceSessionLimit(userId: string): Promise<void> {
    const sessions = await this.getUserSessions(userId);
    
    if (sessions.length > this.maxSessionsPerUser) {
      // Sort by last access time
      sessions.sort((a, b) => a.lastAccess - b.lastAccess);
      
      // Remove oldest sessions
      const toRemove = sessions.slice(0, sessions.length - this.maxSessionsPerUser);
      for (const session of toRemove) {
        const sessionId = await this.findSessionId(session);
        if (sessionId) {
          await this.destroy(sessionId);
        }
      }
    }
  }

  /**
   * Find session ID by session data
   */
  private async findSessionId(session: SessionData): Promise<string | null> {
    const sessionIds = await this.redis.smembers(this.userSessionPrefix + session.userId);
    
    for (const sessionId of sessionIds) {
      const data = await this.get(sessionId);
      if (data && data.createdAt === session.createdAt) {
        return sessionId;
      }
    }
    
    return null;
  }

  /**
   * Clean up expired sessions
   */
  async cleanup(): Promise<number> {
    let cleaned = 0;
    const cursor = '0';
    
    // Scan for all session keys
    const reply = await this.redis.scan(
      cursor,
      'MATCH',
      this.sessionPrefix + '*',
      'COUNT',
      100
    );
    
    const keys = reply[1];
    
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const session: SessionData = JSON.parse(data);
        if (session.expiresAt < Date.now()) {
          const sessionId = key.replace(this.sessionPrefix, '');
          await this.destroy(sessionId);
          cleaned++;
        }
      }
    }
    
    return cleaned;
  }

  /**
   * Get session statistics
   */
  async getStats(): Promise<{
    totalSessions: number;
    activeSessions: number;
    userCount: number;
  }> {
    const keys = await this.redis.keys(this.sessionPrefix + '*');
    const userKeys = await this.redis.keys(this.userSessionPrefix + '*');
    
    let activeSessions = 0;
    
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const session: SessionData = JSON.parse(data);
        if (session.expiresAt > Date.now()) {
          activeSessions++;
        }
      }
    }
    
    return {
      totalSessions: keys.length,
      activeSessions,
      userCount: userKeys.length
    };
  }
}

// Session middleware factory
export function createSessionMiddleware(
  sessionManager: SecureSessionManager,
  options: SessionOptions = {}
) {
  return async (req: any, res: any, next: any) => {
    // Extract session token from cookie or header
    const token = req.cookies?.sessionToken || req.headers['x-session-token'];
    
    if (!token) {
      req.session = null;
      return next();
    }
    
    // Validate session
    const session = await sessionManager.validate(token);
    
    if (!session) {
      req.session = null;
      return next();
    }
    
    // Update activity
    const sessionId = sessionManager['verifyToken'](token);
    await sessionManager.touch(sessionId, options);
    
    // Attach to request
    req.session = session;
    req.sessionId = sessionId;
    
    next();
  };
}

// Export types
export { SessionData, SessionOptions };
