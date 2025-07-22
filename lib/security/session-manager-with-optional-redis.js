/**
 * Enhanced Session Manager with Optional Redis Support
 * Falls back to in-memory storage if Redis is not available
 */

import { EventEmitter } from 'events';
import { randomBytes, createHash } from 'crypto';

export class SessionManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            // Session configuration
            sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
            slidingExpiration: options.slidingExpiration !== false,
            maxSessions: options.maxSessions || 5, // Max sessions per user
            sessionPrefix: options.sessionPrefix || 'session:',
            
            // Security options
            secure: options.secure !== false,
            httpOnly: options.httpOnly !== false,
            sameSite: options.sameSite || 'lax',
            domain: options.domain,
            path: options.path || '/',
            
            // Fingerprinting
            enableFingerprint: options.enableFingerprint !== false,
            fingerprintComponents: options.fingerprintComponents || [
                'userAgent',
                'acceptLanguage',
                'acceptEncoding'
            ],
            
            // Redis configuration (optional)
            redis: options.redis || {
                enabled: false,
                host: '127.0.0.1',
                port: 6379,
                password: null,
                db: 0,
                keyPrefix: 'otedama:'
            },
            
            ...options
        };
        
        // Session storage (in-memory by default)
        this.sessions = new Map();
        this.userSessions = new Map();
        this.redis = null;
        
        // Statistics
        this.stats = {
            created: 0,
            destroyed: 0,
            active: 0
        };
        
        // Initialize Redis if enabled
        if (this.options.redis.enabled) {
            this.initializeRedis().catch(err => {
                console.error('Failed to initialize Redis, using in-memory storage:', err.message);
            });
        }
        
        // Cleanup timer
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredSessions();
        }, 60000); // Every minute
    }

    /**
     * Initialize Redis connection
     */
    async initializeRedis() {
        try {
            // Dynamic import for optional Redis support
            const ioredis = await import('ioredis');
            const Redis = ioredis.default;
            
            this.redis = new Redis({
                host: this.options.redis.host,
                port: this.options.redis.port,
                password: this.options.redis.password,
                db: this.options.redis.db,
                keyPrefix: this.options.redis.keyPrefix,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                },
                reconnectOnError: (err) => {
                    const targetError = 'READONLY';
                    if (err.message.includes(targetError)) {
                        return true;
                    }
                    return false;
                }
            });
            
            this.redis.on('error', (error) => {
                this.emit('redis:error', error);
                console.error('Redis error:', error.message);
            });
            
            this.redis.on('connect', () => {
                this.emit('redis:connected');
                console.log('Redis connected for session storage');
            });
            
            this.redis.on('disconnect', () => {
                this.emit('redis:disconnected');
                console.log('Redis disconnected');
            });
            
        } catch (error) {
            console.error('Failed to initialize Redis:', error);
            this.redis = null;
        }
    }

    /**
     * Store session data
     */
    async store(sessionId, data, ttl = null) {
        const key = this.options.sessionPrefix + sessionId;
        const expiry = ttl || this.options.sessionTimeout / 1000;
        
        if (this.redis) {
            await this.redis.setex(key, expiry, JSON.stringify(data));
        } else {
            // In-memory storage
            this.sessions.set(key, {
                data: data,
                expiresAt: Date.now() + (expiry * 1000)
            });
        }
    }

    /**
     * Retrieve session data
     */
    async retrieve(sessionId) {
        const key = this.options.sessionPrefix + sessionId;
        
        if (this.redis) {
            const data = await this.redis.get(key);
            return data ? JSON.parse(data) : null;
        } else {
            // In-memory storage
            const session = this.sessions.get(key);
            if (!session) return null;
            
            if (Date.now() > session.expiresAt) {
                this.sessions.delete(key);
                return null;
            }
            
            return session.data;
        }
    }

    /**
     * Delete session
     */
    async delete(sessionId) {
        const key = this.options.sessionPrefix + sessionId;
        
        if (this.redis) {
            await this.redis.del(key);
        } else {
            this.sessions.delete(key);
        }
    }

    /**
     * Create a new session
     */
    async createSession(userId, data = {}, fingerprint = null) {
        const sessionId = this.generateSessionId();
        const expiresAt = Date.now() + this.options.sessionTimeout;
        
        const session = {
            id: sessionId,
            userId,
            data: {
                ...data,
                createdAt: Date.now(),
                lastActivity: Date.now()
            },
            expiresAt,
            fingerprint
        };
        
        // Store session
        await this.store(sessionId, session);
        
        // Track user sessions
        if (!this.userSessions.has(userId)) {
            this.userSessions.set(userId, new Set());
        }
        this.userSessions.get(userId).add(sessionId);
        
        // Update stats
        this.stats.created++;
        this.stats.active++;
        
        // Enforce max sessions per user
        await this.enforceMaxSessions(userId);
        
        this.emit('session:created', { sessionId, userId });
        
        return {
            sessionId,
            expiresAt,
            token: this.generateToken(sessionId, userId)
        };
    }

    /**
     * Get session
     */
    async getSession(sessionId) {
        const session = await this.retrieve(sessionId);
        
        if (!session) {
            return null;
        }
        
        if (Date.now() > session.expiresAt) {
            await this.destroySession(sessionId);
            return null;
        }
        
        // Update last activity if sliding expiration
        if (this.options.slidingExpiration) {
            session.data.lastActivity = Date.now();
            session.expiresAt = Date.now() + this.options.sessionTimeout;
            await this.store(sessionId, session);
        }
        
        return session;
    }

    /**
     * Update session
     */
    async updateSession(sessionId, data) {
        const session = await this.getSession(sessionId);
        
        if (!session) {
            throw new Error('Session not found');
        }
        
        session.data = {
            ...session.data,
            ...data,
            lastActivity: Date.now()
        };
        
        await this.store(sessionId, session);
        
        this.emit('session:updated', { sessionId });
        
        return true;
    }

    /**
     * Destroy session
     */
    async destroySession(sessionId) {
        const session = await this.retrieve(sessionId);
        
        if (session) {
            await this.delete(sessionId);
            
            // Remove from user sessions
            const userSessions = this.userSessions.get(session.userId);
            if (userSessions) {
                userSessions.delete(sessionId);
                if (userSessions.size === 0) {
                    this.userSessions.delete(session.userId);
                }
            }
            
            // Update stats
            this.stats.destroyed++;
            this.stats.active--;
            
            this.emit('session:destroyed', { sessionId, userId: session.userId });
        }
        
        return true;
    }

    /**
     * Utility methods
     */
    generateSessionId() {
        return randomBytes(32).toString('hex');
    }

    generateToken(sessionId, userId) {
        const signature = this.generateSignature(sessionId, userId);
        return `${sessionId}.${userId}.${signature}`;
    }

    generateSignature(sessionId, userId) {
        const secret = this.options.secret || 'otedama-session-secret';
        return createHash('sha256')
            .update(`${sessionId}.${userId}.${secret}`)
            .digest('hex');
    }

    async enforceMaxSessions(userId) {
        const userSessions = this.userSessions.get(userId);
        
        if (userSessions && userSessions.size > this.options.maxSessions) {
            // Get all sessions sorted by last activity
            const sessions = [];
            for (const sessionId of userSessions) {
                const session = await this.getSession(sessionId);
                if (session) {
                    sessions.push({ sessionId, lastActivity: session.data.lastActivity });
                }
            }
            
            // Sort by last activity (oldest first)
            sessions.sort((a, b) => a.lastActivity - b.lastActivity);
            
            // Remove oldest sessions
            const toRemove = sessions.length - this.options.maxSessions;
            for (let i = 0; i < toRemove; i++) {
                await this.destroySession(sessions[i].sessionId);
            }
        }
    }

    async cleanupExpiredSessions() {
        if (!this.redis) {
            // In-memory cleanup
            const now = Date.now();
            const expired = [];
            
            for (const [key, session] of this.sessions) {
                if (now > session.expiresAt) {
                    expired.push(key);
                }
            }
            
            for (const key of expired) {
                const sessionId = key.replace(this.options.sessionPrefix, '');
                await this.destroySession(sessionId);
            }
            
            if (expired.length > 0) {
                this.emit('cleanup:completed', { removed: expired.length });
            }
        }
        // Redis handles TTL automatically
    }

    /**
     * Cleanup
     */
    async cleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        if (this.redis) {
            await this.redis.quit();
        }
        
        this.sessions.clear();
        this.userSessions.clear();
    }
}

export default SessionManager;