/**
 * Distributed Session Manager
 * Redis-backed session management for horizontal scaling
 */

import { EventEmitter } from 'events';
import Redis from 'ioredis';
import { randomBytes, createHash } from 'crypto';

const SESSION_CONSTANTS = Object.freeze({
  DEFAULT_TTL: 3600, // 1 hour in seconds
  SESSION_ID_LENGTH: 64,
  CLEANUP_INTERVAL: 300000, // 5 minutes
  MAX_SESSIONS_PER_USER: 5,
  REDIS_KEY_PREFIX: 'otedama:session:',
  USER_SESSIONS_PREFIX: 'otedama:user_sessions:',
  BLACKLIST_PREFIX: 'otedama:blacklist:'
});

export class DistributedSessionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      ttl: options.ttl || SESSION_CONSTANTS.DEFAULT_TTL,
      maxSessionsPerUser: options.maxSessionsPerUser || SESSION_CONSTANTS.MAX_SESSIONS_PER_USER,
      cleanupInterval: options.cleanupInterval || SESSION_CONSTANTS.CLEANUP_INTERVAL,
      redis: options.redis || {},
      fallbackToMemory: options.fallbackToMemory !== false,
      ...options
    };
    
    // Initialize Redis clients
    this.initializeRedis();
    
    // Fallback in-memory storage if Redis is unavailable
    this.memoryStore = new Map();
    this.userSessions = new Map();
    
    // Metrics
    this.metrics = {
      totalSessions: 0,
      activeUsers: 0,
      createdSessions: 0,
      destroyedSessions: 0,
      redisErrors: 0
    };
    
    // Start cleanup process
    this.startCleanup();
  }
  
  initializeRedis() {
    try {
      // Create Redis cluster or single instance
      if (this.config.redis.cluster) {
        this.redis = new Redis.Cluster(this.config.redis.cluster, {
          redisOptions: this.config.redis.options || {},
          ...this.config.redis.clusterOptions || {}
        });
      } else {
        this.redis = new Redis({
          host: this.config.redis.host || 'localhost',
          port: this.config.redis.port || 6379,
          password: this.config.redis.password,
          db: this.config.redis.db || 0,
          retryDelayOnFailover: 100,
          maxRetriesPerRequest: 3,
          lazyConnect: true,
          ...this.config.redis.options || {}
        });
      }
      
      // Redis event handlers
      this.redis.on('connect', () => {
        console.log('Redis connected for session management');
        this.emit('redis:connected');
      });
      
      this.redis.on('error', (error) => {
        console.error('Redis error in session manager:', error);
        this.metrics.redisErrors++;
        this.emit('redis:error', error);
      });
      
      this.redis.on('close', () => {
        console.warn('Redis connection closed in session manager');
        this.emit('redis:disconnected');
      });
      
      // Test connection
      this.testRedisConnection();
      
    } catch (error) {
      console.error('Failed to initialize Redis for sessions:', error);
      if (!this.config.fallbackToMemory) {
        throw error;
      }
    }
  }
  
  async testRedisConnection() {
    try {
      await this.redis.ping();
      this.redisAvailable = true;
    } catch (error) {
      console.warn('Redis not available, falling back to memory storage');
      this.redisAvailable = false;
    }
  }
  
  // Generate secure session ID
  generateSessionId() {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(SESSION_CONSTANTS.SESSION_ID_LENGTH / 2).toString('hex');
    const hash = createHash('sha256').update(timestamp + random).digest('hex');
    return hash.substring(0, SESSION_CONSTANTS.SESSION_ID_LENGTH);
  }
  
  // Create new session
  async createSession(userId, metadata = {}) {
    try {
      const sessionId = this.generateSessionId();
      const now = Date.now();
      
      const sessionData = {
        id: sessionId,
        userId,
        createdAt: now,
        lastAccess: now,
        expiresAt: now + (this.config.ttl * 1000),
        metadata: {
          ...metadata,
          version: '1.0',
          createdBy: 'distributed-session-manager'
        },
        active: true
      };
      
      // Check session limit per user
      await this.enforceSessionLimit(userId);
      
      // Store session
      await this.storeSession(sessionId, sessionData);
      
      // Add to user sessions
      await this.addUserSession(userId, sessionId);
      
      // Update metrics
      this.metrics.createdSessions++;
      this.updateMetrics();
      
      this.emit('session:created', { sessionId, userId });
      
      return sessionId;
      
    } catch (error) {
      console.error('Failed to create session:', error);
      throw new Error('Session creation failed');
    }
  }
  
  // Store session data
  async storeSession(sessionId, sessionData) {
    const key = SESSION_CONSTANTS.REDIS_KEY_PREFIX + sessionId;
    const serializedData = JSON.stringify(sessionData);
    
    if (this.redisAvailable) {
      try {
        await this.redis.setex(key, this.config.ttl, serializedData);
        return true;
      } catch (error) {
        console.error('Redis store error:', error);
        this.metrics.redisErrors++;
        
        if (this.config.fallbackToMemory) {
          this.memoryStore.set(sessionId, sessionData);
          return true;
        }
        throw error;
      }
    } else if (this.config.fallbackToMemory) {
      this.memoryStore.set(sessionId, sessionData);
      return true;
    }
    
    throw new Error('No storage backend available');
  }
  
  // Retrieve session data
  async getSession(sessionId) {
    const key = SESSION_CONSTANTS.REDIS_KEY_PREFIX + sessionId;
    
    if (this.redisAvailable) {
      try {
        const data = await this.redis.get(key);
        return data ? JSON.parse(data) : null;
      } catch (error) {
        console.error('Redis get error:', error);
        this.metrics.redisErrors++;
        
        if (this.config.fallbackToMemory) {
          return this.memoryStore.get(sessionId) || null;
        }
        throw error;
      }
    } else if (this.config.fallbackToMemory) {
      return this.memoryStore.get(sessionId) || null;
    }
    
    return null;
  }
  
  // Validate session
  async validateSession(sessionId, options = {}) {
    try {
      if (!sessionId) {
        return { valid: false, reason: 'No session ID provided' };
      }
      
      // Check blacklist first
      if (await this.isSessionBlacklisted(sessionId)) {
        return { valid: false, reason: 'Session blacklisted' };
      }
      
      const session = await this.getSession(sessionId);
      
      if (!session) {
        return { valid: false, reason: 'Session not found' };
      }
      
      if (!session.active) {
        return { valid: false, reason: 'Session inactive' };
      }
      
      if (Date.now() > session.expiresAt) {
        await this.destroySession(sessionId);
        return { valid: false, reason: 'Session expired' };
      }
      
      // Optional IP validation
      if (options.ipAddress && session.metadata.ipAddress) {
        if (session.metadata.ipAddress !== options.ipAddress) {
          await this.blacklistSession(sessionId, 'IP address mismatch');
          return { valid: false, reason: 'IP address mismatch' };
        }
      }
      
      // Update last access time
      await this.touchSession(sessionId);
      
      return { valid: true, session };
      
    } catch (error) {
      console.error('Session validation error:', error);
      return { valid: false, reason: 'Validation error' };
    }
  }
  
  // Update session last access time
  async touchSession(sessionId) {
    try {
      const session = await this.getSession(sessionId);
      if (!session) return false;
      
      session.lastAccess = Date.now();
      session.expiresAt = Date.now() + (this.config.ttl * 1000);
      
      await this.storeSession(sessionId, session);
      
      // Extend TTL in Redis
      if (this.redisAvailable) {
        const key = SESSION_CONSTANTS.REDIS_KEY_PREFIX + sessionId;
        await this.redis.expire(key, this.config.ttl);
      }
      
      return true;
      
    } catch (error) {
      console.error('Failed to touch session:', error);
      return false;
    }
  }
  
  // Update session metadata
  async updateSession(sessionId, metadata) {
    try {
      const session = await this.getSession(sessionId);
      if (!session) return false;
      
      Object.assign(session.metadata, metadata);
      session.lastAccess = Date.now();
      
      await this.storeSession(sessionId, session);
      
      this.emit('session:updated', { sessionId, metadata });
      
      return true;
      
    } catch (error) {
      console.error('Failed to update session:', error);
      return false;
    }
  }
  
  // Destroy session
  async destroySession(sessionId) {
    try {
      const session = await this.getSession(sessionId);
      if (!session) return false;
      
      // Remove from storage
      const key = SESSION_CONSTANTS.REDIS_KEY_PREFIX + sessionId;
      
      if (this.redisAvailable) {
        await this.redis.del(key);
      }
      
      if (this.config.fallbackToMemory) {
        this.memoryStore.delete(sessionId);
      }
      
      // Remove from user sessions
      await this.removeUserSession(session.userId, sessionId);
      
      // Update metrics
      this.metrics.destroyedSessions++;
      this.updateMetrics();
      
      this.emit('session:destroyed', { sessionId, userId: session.userId });
      
      return true;
      
    } catch (error) {
      console.error('Failed to destroy session:', error);
      return false;
    }
  }
  
  // Manage user sessions
  async addUserSession(userId, sessionId) {
    const key = SESSION_CONSTANTS.USER_SESSIONS_PREFIX + userId;
    
    if (this.redisAvailable) {
      try {
        await this.redis.sadd(key, sessionId);
        await this.redis.expire(key, this.config.ttl * 2); // Longer TTL for user session tracking
        return;
      } catch (error) {
        console.error('Failed to add user session in Redis:', error);
      }
    }
    
    // Fallback to memory
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, new Set());
    }
    this.userSessions.get(userId).add(sessionId);
  }
  
  async removeUserSession(userId, sessionId) {
    const key = SESSION_CONSTANTS.USER_SESSIONS_PREFIX + userId;
    
    if (this.redisAvailable) {
      try {
        await this.redis.srem(key, sessionId);
        return;
      } catch (error) {
        console.error('Failed to remove user session in Redis:', error);
      }
    }
    
    // Fallback to memory
    const userSessions = this.userSessions.get(userId);
    if (userSessions) {
      userSessions.delete(sessionId);
      if (userSessions.size === 0) {
        this.userSessions.delete(userId);
      }
    }
  }
  
  // Enforce session limit per user
  async enforceSessionLimit(userId) {
    const userSessions = await this.getUserSessions(userId);
    
    if (userSessions.length >= this.config.maxSessionsPerUser) {
      // Destroy oldest sessions
      const sortedSessions = userSessions
        .sort((a, b) => a.lastAccess - b.lastAccess)
        .slice(0, userSessions.length - this.config.maxSessionsPerUser + 1);
      
      for (const session of sortedSessions) {
        await this.destroySession(session.id);
      }
    }
  }
  
  // Get all user sessions
  async getUserSessions(userId) {
    const key = SESSION_CONSTANTS.USER_SESSIONS_PREFIX + userId;
    let sessionIds = [];
    
    if (this.redisAvailable) {
      try {
        sessionIds = await this.redis.smembers(key);
      } catch (error) {
        console.error('Failed to get user sessions from Redis:', error);
      }
    }
    
    // Fallback to memory
    if (sessionIds.length === 0) {
      const userSessions = this.userSessions.get(userId);
      if (userSessions) {
        sessionIds = Array.from(userSessions);
      }
    }
    
    // Get session data
    const sessions = [];
    for (const sessionId of sessionIds) {
      const session = await this.getSession(sessionId);
      if (session && session.active) {
        sessions.push(session);
      }
    }
    
    return sessions;
  }
  
  // Destroy all user sessions
  async destroyUserSessions(userId) {
    const sessions = await this.getUserSessions(userId);
    let destroyed = 0;
    
    for (const session of sessions) {
      if (await this.destroySession(session.id)) {
        destroyed++;
      }
    }
    
    // Clean up user session tracking
    const key = SESSION_CONSTANTS.USER_SESSIONS_PREFIX + userId;
    if (this.redisAvailable) {
      await this.redis.del(key);
    }
    this.userSessions.delete(userId);
    
    return destroyed;
  }
  
  // Session blacklisting for security
  async blacklistSession(sessionId, reason = 'Security violation') {
    const key = SESSION_CONSTANTS.BLACKLIST_PREFIX + sessionId;
    const blacklistData = {
      sessionId,
      reason,
      blacklistedAt: Date.now()
    };
    
    if (this.redisAvailable) {
      await this.redis.setex(key, this.config.ttl * 2, JSON.stringify(blacklistData));
    }
    
    // Also destroy the session
    await this.destroySession(sessionId);
    
    this.emit('session:blacklisted', { sessionId, reason });
  }
  
  async isSessionBlacklisted(sessionId) {
    const key = SESSION_CONSTANTS.BLACKLIST_PREFIX + sessionId;
    
    if (this.redisAvailable) {
      try {
        const data = await this.redis.get(key);
        return data !== null;
      } catch (error) {
        console.error('Failed to check blacklist:', error);
      }
    }
    
    return false;
  }
  
  // Cleanup expired sessions
  startCleanup() {
    setInterval(async () => {
      await this.cleanup();
    }, this.config.cleanupInterval);
  }
  
  async cleanup() {
    let cleaned = 0;
    
    try {
      if (this.redisAvailable) {
        // Redis handles TTL automatically, but we can do additional cleanup
        // For now, just clean up memory fallback
        for (const [sessionId, session] of this.memoryStore) {
          if (Date.now() > session.expiresAt) {
            this.memoryStore.delete(sessionId);
            cleaned++;
          }
        }
      } else {
        // Clean memory storage
        for (const [sessionId, session] of this.memoryStore) {
          if (Date.now() > session.expiresAt) {
            await this.destroySession(sessionId);
            cleaned++;
          }
        }
      }
      
      if (cleaned > 0) {
        console.log(`Cleaned up ${cleaned} expired sessions`);
      }
      
    } catch (error) {
      console.error('Session cleanup error:', error);
    }
    
    return cleaned;
  }
  
  // Update metrics
  updateMetrics() {
    if (this.redisAvailable) {
      // Get stats from Redis (async)
      this.getRedisStats().then(stats => {
        this.metrics.totalSessions = stats.totalSessions;
        this.metrics.activeUsers = stats.activeUsers;
        this.emit('metrics:updated', this.metrics);
      });
    } else {
      this.metrics.totalSessions = this.memoryStore.size;
      this.metrics.activeUsers = this.userSessions.size;
      this.emit('metrics:updated', this.metrics);
    }
  }
  
  async getRedisStats() {
    if (!this.redisAvailable) return { totalSessions: 0, activeUsers: 0 };
    
    try {
      const pipeline = this.redis.pipeline();
      
      // Count sessions
      pipeline.eval(`
        local sessions = 0
        local cursor = "0"
        repeat
          local result = redis.call("SCAN", cursor, "MATCH", "${SESSION_CONSTANTS.REDIS_KEY_PREFIX}*", "COUNT", 100)
          cursor = result[1]
          sessions = sessions + #result[2]
        until cursor == "0"
        return sessions
      `, 0);
      
      // Count active users
      pipeline.eval(`
        local users = 0
        local cursor = "0"
        repeat
          local result = redis.call("SCAN", cursor, "MATCH", "${SESSION_CONSTANTS.USER_SESSIONS_PREFIX}*", "COUNT", 100)
          cursor = result[1]
          users = users + #result[2]
        until cursor == "0"
        return users
      `, 0);
      
      const results = await pipeline.exec();
      
      return {
        totalSessions: results[0][1] || 0,
        activeUsers: results[1][1] || 0
      };
      
    } catch (error) {
      console.error('Failed to get Redis stats:', error);
      return { totalSessions: 0, activeUsers: 0 };
    }
  }
  
  // Get session statistics
  getStats() {
    return {
      ...this.metrics,
      redisAvailable: this.redisAvailable,
      memoryStorageSize: this.memoryStore.size,
      config: {
        ttl: this.config.ttl,
        maxSessionsPerUser: this.config.maxSessionsPerUser,
        fallbackToMemory: this.config.fallbackToMemory
      }
    };
  }
  
  // Graceful shutdown
  async shutdown() {
    console.log('Shutting down distributed session manager...');
    
    if (this.redis) {
      await this.redis.quit();
    }
    
    this.memoryStore.clear();
    this.userSessions.clear();
    
    this.emit('shutdown');
  }
}

export default DistributedSessionManager;