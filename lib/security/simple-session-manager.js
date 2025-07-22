/**
 * Simple Session Manager - In-memory fallback
 * Provides basic session management without Redis dependency
 */

import { EventEmitter } from 'events';
import { randomBytes, createHash } from 'crypto';

export class SessionManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            sessionTimeout: options.sessionTimeout || 3600000, // 1 hour
            slidingExpiration: options.slidingExpiration !== false,
            maxSessions: options.maxSessions || 5,
            sessionPrefix: options.sessionPrefix || 'session:',
            secure: options.secure !== false,
            httpOnly: options.httpOnly !== false,
            sameSite: options.sameSite || 'lax',
            domain: options.domain,
            path: options.path || '/',
            ...options
        };
        
        // In-memory session storage
        this.sessions = new Map();
        this.userSessions = new Map();
        
        // Cleanup timer
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredSessions();
        }, 60000); // Every minute
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
        this.sessions.set(sessionId, session);
        
        // Track user sessions
        if (!this.userSessions.has(userId)) {
            this.userSessions.set(userId, new Set());
        }
        this.userSessions.get(userId).add(sessionId);
        
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
        const session = this.sessions.get(sessionId);
        
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
        
        this.emit('session:updated', { sessionId });
        
        return true;
    }

    /**
     * Destroy session
     */
    async destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        
        if (session) {
            this.sessions.delete(sessionId);
            
            // Remove from user sessions
            const userSessions = this.userSessions.get(session.userId);
            if (userSessions) {
                userSessions.delete(sessionId);
                if (userSessions.size === 0) {
                    this.userSessions.delete(session.userId);
                }
            }
            
            this.emit('session:destroyed', { sessionId, userId: session.userId });
        }
        
        return true;
    }

    /**
     * Destroy all sessions for a user
     */
    async destroyUserSessions(userId) {
        const userSessions = this.userSessions.get(userId);
        
        if (userSessions) {
            for (const sessionId of userSessions) {
                await this.destroySession(sessionId);
            }
        }
        
        return true;
    }

    /**
     * List active sessions for a user
     */
    async getUserSessions(userId) {
        const userSessions = this.userSessions.get(userId);
        const sessions = [];
        
        if (userSessions) {
            for (const sessionId of userSessions) {
                const session = await this.getSession(sessionId);
                if (session) {
                    sessions.push({
                        id: sessionId,
                        createdAt: session.data.createdAt,
                        lastActivity: session.data.lastActivity,
                        expiresAt: session.expiresAt,
                        data: session.data
                    });
                }
            }
        }
        
        return sessions;
    }

    /**
     * Count active sessions
     */
    async countActiveSessions(userId = null) {
        if (userId) {
            const userSessions = this.userSessions.get(userId);
            return userSessions ? userSessions.size : 0;
        }
        
        return this.sessions.size;
    }

    /**
     * Validate session token
     */
    validateSessionToken(token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 3) return null;
            
            const [sessionId, userId, signature] = parts;
            const expectedSignature = this.generateSignature(sessionId, userId);
            
            if (signature === expectedSignature) {
                return { sessionId, userId };
            }
            
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Generate session cookie
     */
    generateSessionCookie(sessionId, expiresAt) {
        const cookieOptions = [
            `${this.options.cookieName || 'otedama_session'}=${sessionId}`,
            `Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
            `Path=${this.options.path}`,
            `SameSite=${this.options.sameSite}`
        ];
        
        if (this.options.secure) {
            cookieOptions.push('Secure');
        }
        
        if (this.options.httpOnly) {
            cookieOptions.push('HttpOnly');
        }
        
        if (this.options.domain) {
            cookieOptions.push(`Domain=${this.options.domain}`);
        }
        
        return cookieOptions.join('; ');
    }

    /**
     * Parse session from request
     */
    async parseSessionFromRequest(req) {
        // Check cookie
        const cookies = this.parseCookies(req.headers.cookie || '');
        const cookieName = this.options.cookieName || 'otedama_session';
        const sessionId = cookies[cookieName];
        
        if (sessionId) {
            return await this.getSession(sessionId);
        }
        
        // Check authorization header
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const tokenData = this.validateSessionToken(token);
            
            if (tokenData) {
                return await this.getSession(tokenData.sessionId);
            }
        }
        
        return null;
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

    parseCookies(cookieHeader) {
        const cookies = {};
        cookieHeader.split(';').forEach(cookie => {
            const parts = cookie.trim().split('=');
            if (parts.length === 2) {
                cookies[parts[0]] = decodeURIComponent(parts[1]);
            }
        });
        return cookies;
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

    cleanupExpiredSessions() {
        const now = Date.now();
        const expired = [];
        
        for (const [sessionId, session] of this.sessions) {
            if (now > session.expiresAt) {
                expired.push(sessionId);
            }
        }
        
        for (const sessionId of expired) {
            this.destroySession(sessionId);
        }
        
        if (expired.length > 0) {
            this.emit('cleanup:completed', { removed: expired.length });
        }
    }

    /**
     * Cleanup
     */
    async cleanup() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.sessions.clear();
        this.userSessions.clear();
    }
}

export default SessionManager;