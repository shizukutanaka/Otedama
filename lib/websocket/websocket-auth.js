/**
 * WebSocket Authentication Module
 * 
 * Provides JWT-based authentication for WebSocket connections
 * Following security best practices
 */

import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { promisify } from 'util';

const jwtVerify = promisify(jwt.verify);

export class WebSocketAuth {
    constructor(options = {}) {
        this.jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
        this.sessionTimeout = options.sessionTimeout || 3600000; // 1 hour
        this.maxConnectionsPerUser = options.maxConnectionsPerUser || 5;
        
        // In-memory session store (use Redis in production)
        this.sessions = new Map();
        this.userConnections = new Map();
        
        // Security settings
        this.requireAuth = options.requireAuth !== false;
        this.allowedOrigins = options.allowedOrigins || [];
        this.apiKeyHeader = options.apiKeyHeader || 'x-api-key';
        
        if (!this.jwtSecret) {
            throw new Error('JWT_SECRET is required for WebSocket authentication');
        }
    }
    
    /**
     * Authenticate WebSocket connection
     */
    async authenticate(request, ws) {
        try {
            // Check origin if configured
            if (this.allowedOrigins.length > 0) {
                const origin = request.headers.origin;
                if (!this.allowedOrigins.includes(origin)) {
                    throw new Error('Origin not allowed');
                }
            }
            
            // Extract authentication token
            const token = this.extractToken(request);
            
            if (!token && this.requireAuth) {
                throw new Error('Authentication required');
            }
            
            if (token) {
                // Verify token
                const decoded = await this.verifyToken(token);
                
                // Check user connection limit
                if (!this.checkConnectionLimit(decoded.userId)) {
                    throw new Error('Connection limit exceeded');
                }
                
                // Create session
                const session = this.createSession(decoded, request);
                
                // Track user connection
                this.trackUserConnection(decoded.userId, session.id);
                
                return {
                    authenticated: true,
                    session,
                    user: decoded
                };
            }
            
            // Allow anonymous connections if auth not required
            return {
                authenticated: false,
                session: this.createAnonymousSession(request)
            };
            
        } catch (error) {
            console.error('WebSocket authentication error:', error);
            throw error;
        }
    }
    
    /**
     * Extract token from request
     */
    extractToken(request) {
        // 1. Check query parameters
        const url = new URL(request.url, `http://${request.headers.host}`);
        const queryToken = url.searchParams.get('token');
        if (queryToken) return queryToken;
        
        // 2. Check Authorization header
        const authHeader = request.headers.authorization;
        if (authHeader) {
            const match = authHeader.match(/^Bearer (.+)$/i);
            if (match) return match[1];
        }
        
        // 3. Check cookie
        const cookies = this.parseCookies(request.headers.cookie);
        if (cookies.token) return cookies.token;
        
        // 4. Check API key header
        const apiKey = request.headers[this.apiKeyHeader];
        if (apiKey) return apiKey;
        
        return null;
    }
    
    /**
     * Parse cookies from header
     */
    parseCookies(cookieHeader) {
        const cookies = {};
        if (!cookieHeader) return cookies;
        
        cookieHeader.split(';').forEach(cookie => {
            const [name, value] = cookie.trim().split('=');
            if (name && value) {
                cookies[name] = decodeURIComponent(value);
            }
        });
        
        return cookies;
    }
    
    /**
     * Verify JWT token
     */
    async verifyToken(token) {
        try {
            // Check if it's an API key
            if (token.startsWith('sk_')) {
                return await this.verifyApiKey(token);
            }
            
            // Verify JWT
            const decoded = await jwtVerify(token, this.jwtSecret, {
                algorithms: ['HS256'],
                maxAge: '24h'
            });
            
            // Additional validation
            if (!decoded.userId) {
                throw new Error('Invalid token payload');
            }
            
            return decoded;
            
        } catch (error) {
            if (error.name === 'TokenExpiredError') {
                throw new Error('Token expired');
            } else if (error.name === 'JsonWebTokenError') {
                throw new Error('Invalid token');
            }
            throw error;
        }
    }
    
    /**
     * Verify API key
     */
    async verifyApiKey(apiKey) {
        // In production, check against database
        // For now, use simple validation
        const hash = createHash('sha256').update(apiKey).digest('hex');
        
        // Mock API key validation
        const validKeys = new Map([
            ['sk_test_123', { userId: 'test_user', permissions: ['read', 'write'] }],
            ['sk_prod_456', { userId: 'prod_user', permissions: ['read', 'write', 'admin'] }]
        ]);
        
        const keyData = validKeys.get(apiKey);
        if (!keyData) {
            throw new Error('Invalid API key');
        }
        
        return {
            userId: keyData.userId,
            type: 'api_key',
            permissions: keyData.permissions,
            keyHash: hash
        };
    }
    
    /**
     * Check user connection limit
     */
    checkConnectionLimit(userId) {
        const connections = this.userConnections.get(userId) || [];
        return connections.length < this.maxConnectionsPerUser;
    }
    
    /**
     * Track user connection
     */
    trackUserConnection(userId, sessionId) {
        const connections = this.userConnections.get(userId) || [];
        connections.push(sessionId);
        this.userConnections.set(userId, connections);
    }
    
    /**
     * Remove user connection
     */
    removeUserConnection(userId, sessionId) {
        const connections = this.userConnections.get(userId) || [];
        const filtered = connections.filter(id => id !== sessionId);
        
        if (filtered.length > 0) {
            this.userConnections.set(userId, filtered);
        } else {
            this.userConnections.delete(userId);
        }
    }
    
    /**
     * Create authenticated session
     */
    createSession(user, request) {
        const sessionId = this.generateSessionId();
        const session = {
            id: sessionId,
            userId: user.userId,
            type: user.type || 'jwt',
            permissions: user.permissions || [],
            ip: this.getClientIP(request),
            userAgent: request.headers['user-agent'],
            createdAt: Date.now(),
            lastActivity: Date.now(),
            authenticated: true
        };
        
        this.sessions.set(sessionId, session);
        
        // Set session timeout
        setTimeout(() => {
            this.destroySession(sessionId);
        }, this.sessionTimeout);
        
        return session;
    }
    
    /**
     * Create anonymous session
     */
    createAnonymousSession(request) {
        const sessionId = this.generateSessionId();
        const session = {
            id: sessionId,
            userId: null,
            type: 'anonymous',
            permissions: ['read'],
            ip: this.getClientIP(request),
            userAgent: request.headers['user-agent'],
            createdAt: Date.now(),
            lastActivity: Date.now(),
            authenticated: false
        };
        
        this.sessions.set(sessionId, session);
        
        // Shorter timeout for anonymous sessions
        setTimeout(() => {
            this.destroySession(sessionId);
        }, this.sessionTimeout / 2);
        
        return session;
    }
    
    /**
     * Generate session ID
     */
    generateSessionId() {
        return createHash('sha256')
            .update(Date.now().toString())
            .update(Math.random().toString())
            .update(process.pid.toString())
            .digest('hex')
            .substring(0, 32);
    }
    
    /**
     * Get client IP
     */
    getClientIP(request) {
        return request.headers['x-forwarded-for']?.split(',')[0] ||
               request.headers['x-real-ip'] ||
               request.connection?.remoteAddress ||
               request.socket?.remoteAddress ||
               '0.0.0.0';
    }
    
    /**
     * Update session activity
     */
    updateSessionActivity(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.lastActivity = Date.now();
        }
    }
    
    /**
     * Validate session
     */
    validateSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return { valid: false, reason: 'Session not found' };
        }
        
        const now = Date.now();
        const elapsed = now - session.lastActivity;
        
        if (elapsed > this.sessionTimeout) {
            this.destroySession(sessionId);
            return { valid: false, reason: 'Session expired' };
        }
        
        return { valid: true, session };
    }
    
    /**
     * Check permission
     */
    hasPermission(sessionId, permission) {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        
        return session.permissions.includes(permission) || 
               session.permissions.includes('admin');
    }
    
    /**
     * Destroy session
     */
    destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && session.userId) {
            this.removeUserConnection(session.userId, sessionId);
        }
        this.sessions.delete(sessionId);
    }
    
    /**
     * Get active sessions for user
     */
    getUserSessions(userId) {
        const sessions = [];
        for (const [id, session] of this.sessions) {
            if (session.userId === userId) {
                sessions.push({ id, ...session });
            }
        }
        return sessions;
    }
    
    /**
     * Revoke all user sessions
     */
    revokeUserSessions(userId) {
        const sessions = this.getUserSessions(userId);
        for (const session of sessions) {
            this.destroySession(session.id);
        }
    }
    
    /**
     * Clean up expired sessions
     */
    cleanupSessions() {
        const now = Date.now();
        for (const [id, session] of this.sessions) {
            if (now - session.lastActivity > this.sessionTimeout) {
                this.destroySession(id);
            }
        }
    }
    
    /**
     * Get authentication statistics
     */
    getStats() {
        return {
            totalSessions: this.sessions.size,
            authenticatedSessions: Array.from(this.sessions.values())
                .filter(s => s.authenticated).length,
            anonymousSessions: Array.from(this.sessions.values())
                .filter(s => !s.authenticated).length,
            uniqueUsers: this.userConnections.size,
            userConnections: Array.from(this.userConnections.entries())
                .map(([userId, connections]) => ({
                    userId,
                    connectionCount: connections.length
                }))
        };
    }
}

// Middleware factory
export function createWebSocketAuthMiddleware(options = {}) {
    const auth = new WebSocketAuth(options);
    
    return async (request, ws, next) => {
        try {
            const authResult = await auth.authenticate(request, ws);
            
            // Attach auth info to WebSocket
            ws.auth = authResult;
            ws.sessionId = authResult.session.id;
            
            // Update activity on message
            ws.on('message', () => {
                auth.updateSessionActivity(ws.sessionId);
            });
            
            // Cleanup on close
            ws.on('close', () => {
                auth.destroySession(ws.sessionId);
            });
            
            next();
        } catch (error) {
            ws.close(1008, error.message);
        }
    };
}

export default WebSocketAuth;