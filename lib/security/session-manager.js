/**
 * Enhanced Session Manager with Redis Support
 * Provides distributed session management for horizontal scaling
 */

import { EventEmitter } from 'events';
import { randomBytes, createHash } from 'crypto';
import Redis from 'ioredis';

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
            
            // Redis configuration
            redis: options.redis || {
                enabled: false,
                host: 'localhost',
                port: 6379,
                password: undefined,
                db: 0,
                keyPrefix: 'otedama:'
            },
            
            // Cleanup
            cleanupInterval: options.cleanupInterval || 300000, // 5 minutes
            
            ...options
        };
        
        // Session storage
        this.sessions = new Map();
        this.userSessions = new Map(); // Track sessions per user
        
        // Redis client
        this.redis = null;
        if (this.options.redis.enabled) {
            this.initializeRedis();
        }
        
        // Statistics
        this.stats = {
            created: 0,
            destroyed: 0,
            expired: 0,
            active: 0
        };
        
        // Start cleanup interval
        this.startCleanup();
    }

    /**
     * Initialize Redis connection
     */
    initializeRedis() {
        try {
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
     * Create a new session
     */
    async createSession(userId, data = {}, req = null) {
        try {
            // Check max sessions per user
            await this.enforceMaxSessions(userId);
            
            // Generate session ID
            const sessionId = this.generateSessionId();
            
            // Create fingerprint
            const fingerprint = req ? this.generateFingerprint(req) : null;
            
            // Session data
            const session = {
                id: sessionId,
                userId,
                data: { ...data },
                fingerprint,
                createdAt: Date.now(),
                lastAccessedAt: Date.now(),
                expiresAt: Date.now() + this.options.sessionTimeout,
                ipAddress: req?.ip || req?.socket?.remoteAddress,
                userAgent: req?.headers?.['user-agent']
            };
            
            // Store session
            await this.storeSession(sessionId, session);
            
            // Track user session
            this.trackUserSession(userId, sessionId);
            
            // Update stats
            this.stats.created++;
            this.stats.active++;
            
            // Emit event
            this.emit('session:created', {
                sessionId,
                userId,
                ipAddress: session.ipAddress
            });
            
            return {
                sessionId,
                token: this.generateToken(sessionId),
                expiresAt: session.expiresAt
            };
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Get session by ID
     */
    async getSession(sessionId, req = null) {
        try {
            const session = await this.loadSession(sessionId);
            
            if (!session) {
                return null;
            }
            
            // Check expiration
            if (Date.now() > session.expiresAt) {
                await this.destroySession(sessionId);
                this.stats.expired++;
                return null;
            }
            
            // Verify fingerprint
            if (this.options.enableFingerprint && req && session.fingerprint) {
                const currentFingerprint = this.generateFingerprint(req);
                if (currentFingerprint !== session.fingerprint) {
                    this.emit('security:fingerprint_mismatch', {
                        sessionId,
                        userId: session.userId,
                        expectedFingerprint: session.fingerprint,
                        actualFingerprint: currentFingerprint
                    });
                    
                    // Optionally destroy session on mismatch
                    if (this.options.destroyOnFingerprintMismatch) {
                        await this.destroySession(sessionId);
                        return null;
                    }
                }
            }
            
            // Update last accessed time
            session.lastAccessedAt = Date.now();
            
            // Sliding expiration
            if (this.options.slidingExpiration) {
                session.expiresAt = Date.now() + this.options.sessionTimeout;
            }
            
            // Update session
            await this.storeSession(sessionId, session);
            
            return session;
            
        } catch (error) {
            this.emit('error', error);
            return null;
        }
    }

    /**
     * Update session data
     */
    async updateSession(sessionId, data) {
        try {
            const session = await this.getSession(sessionId);
            
            if (!session) {
                throw new Error('Session not found');
            }
            
            // Merge data
            session.data = { ...session.data, ...data };
            session.lastAccessedAt = Date.now();
            
            // Store updated session
            await this.storeSession(sessionId, session);
            
            this.emit('session:updated', { sessionId, userId: session.userId });
            
            return session;
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Destroy session
     */
    async destroySession(sessionId) {
        try {
            const session = await this.loadSession(sessionId);
            
            if (!session) {
                return false;
            }
            
            // Remove from storage
            if (this.redis) {
                await this.redis.del(this.options.sessionPrefix + sessionId);
            } else {
                this.sessions.delete(sessionId);
            }
            
            // Remove from user sessions
            this.untrackUserSession(session.userId, sessionId);
            
            // Update stats
            this.stats.destroyed++;
            this.stats.active = Math.max(0, this.stats.active - 1);
            
            // Emit event
            this.emit('session:destroyed', {
                sessionId,
                userId: session.userId
            });
            
            return true;
            
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    /**
     * Destroy all sessions for a user
     */
    async destroyUserSessions(userId) {
        try {
            const sessionIds = this.userSessions.get(userId) || new Set();
            
            for (const sessionId of sessionIds) {
                await this.destroySession(sessionId);
            }
            
            this.userSessions.delete(userId);
            
            this.emit('session:user_sessions_destroyed', { userId });
            
            return true;
            
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    /**
     * Generate session ID
     */
    generateSessionId() {
        return randomBytes(32).toString('hex');
    }

    /**
     * Generate session token
     */
    generateToken(sessionId) {
        const timestamp = Date.now();
        const random = randomBytes(16).toString('hex');
        const hash = createHash('sha256')
            .update(`${sessionId}:${timestamp}:${random}`)
            .digest('hex');
        
        return Buffer.from(`${sessionId}:${timestamp}:${hash}`)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    /**
     * Parse session token
     */
    parseToken(token) {
        try {
            const decoded = Buffer.from(
                token.replace(/-/g, '+').replace(/_/g, '/'),
                'base64'
            ).toString('utf-8');
            
            const [sessionId] = decoded.split(':');
            return sessionId;
            
        } catch (error) {
            return null;
        }
    }

    /**
     * Generate fingerprint from request
     */
    generateFingerprint(req) {
        if (!this.options.enableFingerprint) {
            return null;
        }
        
        const components = [];
        
        for (const component of this.options.fingerprintComponents) {
            switch (component) {
                case 'userAgent':
                    components.push(req.headers['user-agent'] || '');
                    break;
                case 'acceptLanguage':
                    components.push(req.headers['accept-language'] || '');
                    break;
                case 'acceptEncoding':
                    components.push(req.headers['accept-encoding'] || '');
                    break;
                case 'ipAddress':
                    components.push(req.ip || req.socket?.remoteAddress || '');
                    break;
            }
        }
        
        return createHash('sha256')
            .update(components.join('|'))
            .digest('hex');
    }

    /**
     * Store session
     */
    async storeSession(sessionId, session) {
        const key = this.options.sessionPrefix + sessionId;
        const ttl = Math.floor((session.expiresAt - Date.now()) / 1000);
        
        if (this.redis && ttl > 0) {
            await this.redis.setex(
                key,
                ttl,
                JSON.stringify(session)
            );
        } else {
            this.sessions.set(sessionId, session);
        }
    }

    /**
     * Load session
     */
    async loadSession(sessionId) {
        const key = this.options.sessionPrefix + sessionId;
        
        if (this.redis) {
            const data = await this.redis.get(key);
            return data ? JSON.parse(data) : null;
        } else {
            return this.sessions.get(sessionId) || null;
        }
    }

    /**
     * Track user session
     */
    trackUserSession(userId, sessionId) {
        if (!this.userSessions.has(userId)) {
            this.userSessions.set(userId, new Set());
        }
        this.userSessions.get(userId).add(sessionId);
    }

    /**
     * Untrack user session
     */
    untrackUserSession(userId, sessionId) {
        const sessions = this.userSessions.get(userId);
        if (sessions) {
            sessions.delete(sessionId);
            if (sessions.size === 0) {
                this.userSessions.delete(userId);
            }
        }
    }

    /**
     * Enforce max sessions per user
     */
    async enforceMaxSessions(userId) {
        const sessionIds = this.userSessions.get(userId) || new Set();
        
        if (sessionIds.size >= this.options.maxSessions) {
            // Get all sessions and sort by last accessed
            const sessions = [];
            for (const sessionId of sessionIds) {
                const session = await this.loadSession(sessionId);
                if (session) {
                    sessions.push(session);
                }
            }
            
            // Sort by last accessed time
            sessions.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
            
            // Remove oldest sessions
            const toRemove = sessions.slice(0, sessions.length - this.options.maxSessions + 1);
            
            for (const session of toRemove) {
                await this.destroySession(session.id);
            }
        }
    }

    /**
     * Start cleanup interval
     */
    startCleanup() {
        this.cleanupInterval = setInterval(() => {
            this.cleanup();
        }, this.options.cleanupInterval);
    }

    /**
     * Cleanup expired sessions
     */
    async cleanup() {
        try {
            const now = Date.now();
            let cleaned = 0;
            
            if (this.redis) {
                // Redis handles expiration automatically
                // Just clean up local tracking
                for (const [userId, sessionIds] of this.userSessions.entries()) {
                    for (const sessionId of sessionIds) {
                        const session = await this.loadSession(sessionId);
                        if (!session) {
                            sessionIds.delete(sessionId);
                            cleaned++;
                        }
                    }
                    
                    if (sessionIds.size === 0) {
                        this.userSessions.delete(userId);
                    }
                }
            } else {
                // Manual cleanup for in-memory storage
                for (const [sessionId, session] of this.sessions.entries()) {
                    if (now > session.expiresAt) {
                        await this.destroySession(sessionId);
                        cleaned++;
                    }
                }
            }
            
            if (cleaned > 0) {
                this.emit('session:cleanup', { cleaned });
            }
            
        } catch (error) {
            this.emit('error', error);
        }
    }

    /**
     * Get session statistics
     */
    getStats() {
        return {
            ...this.stats,
            active: this.redis ? this.userSessions.size : this.sessions.size,
            userCount: this.userSessions.size
        };
    }

    /**
     * Create session cookie options
     */
    getCookieOptions() {
        return {
            httpOnly: this.options.httpOnly,
            secure: this.options.secure,
            sameSite: this.options.sameSite,
            domain: this.options.domain,
            path: this.options.path,
            maxAge: this.options.sessionTimeout
        };
    }

    /**
     * Middleware for Express
     */
    middleware() {
        return async (req, res, next) => {
            // Get session from cookie or header
            const token = req.cookies?.sessionToken || 
                         req.headers['x-session-token'] ||
                         req.headers['authorization']?.replace('Bearer ', '');
            
            if (token) {
                const sessionId = this.parseToken(token);
                if (sessionId) {
                    const session = await this.getSession(sessionId, req);
                    if (session) {
                        req.session = session;
                        req.sessionId = sessionId;
                        req.userId = session.userId;
                        
                        // Add session methods
                        req.session.save = async (data) => {
                            await this.updateSession(sessionId, data);
                        };
                        
                        req.session.destroy = async () => {
                            await this.destroySession(sessionId);
                        };
                    }
                }
            }
            
            // Add session creation method
            req.createSession = async (userId, data) => {
                const result = await this.createSession(userId, data, req);
                
                // Set cookie
                res.cookie('sessionToken', result.token, this.getCookieOptions());
                
                return result;
            };
            
            next();
        };
    }

    /**
     * Shutdown
     */
    async shutdown() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        if (this.redis) {
            await this.redis.quit();
        }
        
        this.removeAllListeners();
    }
}

export default SessionManager;