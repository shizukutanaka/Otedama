/**
 * Unified Security Middleware
 * Integrates all security features into a single middleware
 */

import { EventEmitter } from 'events';
import helmet from 'helmet';
import { SessionManager } from './simple-session-manager.js';
import { APIKeyManager } from './api-key-manager.js';
import { CSRFProtection } from './csrf-protection.js';
import { AdvancedRateLimiter } from './rate-limiter.js';
import { DDoSProtection } from './ddos-protection.js';
import { EnhancedSecurityHeaders } from './headers/enhanced-security-headers.js';
import { getLogger } from '../core/logger.js';

export class UnifiedSecurityMiddleware extends EventEmitter {
    constructor(db, options = {}) {
        super();
        
        this.db = db;
        this.logger = getLogger('Security');
        
        this.options = {
            // Enable/disable features
            enableSessions: options.enableSessions !== false,
            enableAPIKeys: options.enableAPIKeys !== false,
            enableCSRF: options.enableCSRF !== false,
            enableRateLimiting: options.enableRateLimiting !== false,
            enableDDoSProtection: options.enableDDoSProtection !== false,
            enableSecurityHeaders: options.enableSecurityHeaders !== false,
            useEnhancedHeaders: options.useEnhancedHeaders !== false,
            
            // Session configuration
            session: {
                sessionTimeout: 3600000, // 1 hour
                maxSessions: 5,
                redis: {
                    enabled: options.redis?.enabled || false,
                    host: options.redis?.host || 'localhost',
                    port: options.redis?.port || 6379,
                    password: options.redis?.password
                },
                ...options.session
            },
            
            // API Key configuration
            apiKey: {
                rotationEnabled: true,
                maxKeyAge: 7776000000, // 90 days
                ...options.apiKey
            },
            
            // CSRF configuration
            csrf: {
                strategy: 'double-submit',
                excludePaths: ['/api/webhook', '/api/public'],
                ...options.csrf
            },
            
            // Rate limiting configuration
            rateLimit: {
                strategy: 'token_bucket',
                global: {
                    requests: 10000,
                    window: 60000,
                    burst: 200
                },
                perIP: {
                    requests: 100,
                    window: 60000,
                    burst: 20
                },
                ...options.rateLimit
            },
            
            // DDoS protection configuration
            ddos: {
                maxRequestsPerIP: 1000,
                banDuration: 3600000, // 1 hour
                ...options.ddos
            },
            
            // Enhanced security headers configuration
            enhancedHeaders: {
                environment: options.environment || process.env.NODE_ENV || 'development',
                apiVersion: options.apiVersion || '1.0',
                allowedOrigins: options.allowedOrigins || ['https://otedama.io'],
                reportUri: options.reportUri || '/api/security/csp-report',
                domainName: options.domainName || 'otedama.io',
                features: {
                    cspNonce: options.features?.cspNonce !== false,
                    crossOriginIsolation: options.features?.crossOriginIsolation !== false,
                    permissionsPolicy: options.features?.permissionsPolicy !== false,
                    apiHeaders: options.features?.apiHeaders !== false,
                    strictCsp: options.features?.strictCsp !== false
                },
                ...options.enhancedHeaders
            },
            
            // Fallback Helmet configuration for basic headers
            helmet: {
                contentSecurityPolicy: {
                    directives: {
                        defaultSrc: ["'self'"],
                        scriptSrc: ["'self'", "'unsafe-inline'"],
                        styleSrc: ["'self'", "'unsafe-inline'"],
                        imgSrc: ["'self'", "data:", "https:"],
                        connectSrc: ["'self'", "wss:", "https:"],
                        fontSrc: ["'self'"],
                        objectSrc: ["'none'"],
                        mediaSrc: ["'self'"],
                        frameSrc: ["'none'"]
                    }
                },
                hsts: {
                    maxAge: 31536000,
                    includeSubDomains: true,
                    preload: true
                },
                ...options.helmet
            },
            
            // IP filtering
            ipWhitelist: options.ipWhitelist || [],
            ipBlacklist: options.ipBlacklist || [],
            
            // Request validation
            maxBodySize: options.maxBodySize || '10mb',
            maxUrlLength: options.maxUrlLength || 2048,
            
            // Logging
            logSecurityEvents: options.logSecurityEvents !== false,
            
            ...options
        };
        
        // Initialize components
        this.initializeComponents();
        
        // Initialize enhanced security headers if enabled
        if (this.options.useEnhancedHeaders && this.options.enableSecurityHeaders) {
            this.enhancedHeaders = new EnhancedSecurityHeaders(this.options.enhancedHeaders);
        }
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Statistics
        this.stats = {
            requests: 0,
            blocked: 0,
            authenticated: 0,
            rateLimited: 0,
            csrfBlocked: 0,
            ddosBlocked: 0
        };
    }

    /**
     * Initialize security components
     */
    initializeComponents() {
        // Session Manager
        if (this.options.enableSessions) {
            this.sessionManager = new SessionManager(this.options.session);
        }
        
        // API Key Manager
        if (this.options.enableAPIKeys) {
            this.apiKeyManager = new APIKeyManager(this.db, this.options.apiKey);
        }
        
        // CSRF Protection
        if (this.options.enableCSRF) {
            this.csrfProtection = new CSRFProtection(this.options.csrf);
        }
        
        // Rate Limiter
        if (this.options.enableRateLimiting) {
            this.rateLimiter = new AdvancedRateLimiter(this.options.rateLimit);
        }
        
        // DDoS Protection
        if (this.options.enableDDoSProtection) {
            this.ddosProtection = new DDoSProtection(this.options.ddos);
        }
    }

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Session events
        if (this.sessionManager) {
            this.sessionManager.on('session:created', (data) => {
                this.logSecurityEvent('session_created', data);
            });
            
            this.sessionManager.on('security:fingerprint_mismatch', (data) => {
                this.logSecurityEvent('fingerprint_mismatch', data, 'warning');
            });
        }
        
        // API Key events
        if (this.apiKeyManager) {
            this.apiKeyManager.on('key:created', (data) => {
                this.logSecurityEvent('api_key_created', data);
            });
            
            this.apiKeyManager.on('key:rotated', (data) => {
                this.logSecurityEvent('api_key_rotated', data);
            });
        }
        
        // CSRF events
        if (this.csrfProtection) {
            this.csrfProtection.on('validation:failed', (data) => {
                this.stats.csrfBlocked++;
                this.logSecurityEvent('csrf_blocked', data, 'warning');
            });
        }
        
        // Rate limiter events
        if (this.rateLimiter) {
            this.rateLimiter.on('limited', (data) => {
                this.stats.rateLimited++;
                this.logSecurityEvent('rate_limited', data, 'warning');
            });
            
            this.rateLimiter.on('violation', (data) => {
                this.logSecurityEvent('rate_limit_violation', data, 'error');
            });
        }
        
        // DDoS events
        if (this.ddosProtection) {
            this.ddosProtection.on('blocked', (data) => {
                this.stats.ddosBlocked++;
                this.logSecurityEvent('ddos_blocked', data, 'error');
            });
        }
    }

    /**
     * Main middleware function
     */
    middleware() {
        // Create middleware stack
        const middlewares = [];
        
        // Security headers
        if (this.options.enableSecurityHeaders) {
            if (this.options.useEnhancedHeaders && this.enhancedHeaders) {
                middlewares.push(this.enhancedHeaders.middleware());
            } else {
                middlewares.push(helmet(this.options.helmet));
            }
        }
        
        // Custom security checks
        middlewares.push(this.securityChecks.bind(this));
        
        // DDoS protection
        if (this.ddosProtection) {
            middlewares.push(this.ddosProtection.middleware());
        }
        
        // Rate limiting
        if (this.rateLimiter) {
            middlewares.push(this.rateLimitMiddleware.bind(this));
        }
        
        // Session management
        if (this.sessionManager) {
            middlewares.push(this.sessionManager.middleware());
        }
        
        // API key authentication
        if (this.apiKeyManager) {
            middlewares.push(this.apiKeyMiddleware.bind(this));
        }
        
        // CSRF protection
        if (this.csrfProtection) {
            middlewares.push(this.csrfProtection.middleware());
        }
        
        // Return combined middleware
        return (req, res, next) => {
            this.stats.requests++;
            
            // Add request ID and timestamp for enhanced headers context
            if (this.enhancedHeaders) {
                req.id = req.id || require('crypto').randomUUID();
                req.requestStartTime = Date.now();
            }
            
            // Execute middleware stack
            let index = 0;
            
            const runNext = (err) => {
                if (err) {
                    return next(err);
                }
                
                if (index >= middlewares.length) {
                    // Add response time for enhanced headers
                    if (this.enhancedHeaders && req.requestStartTime) {
                        res.setHeader('X-Response-Time', `${Date.now() - req.requestStartTime}ms`);
                    }
                    return next();
                }
                
                const middleware = middlewares[index++];
                try {
                    middleware(req, res, runNext);
                } catch (error) {
                    next(error);
                }
            };
            
            runNext();
        };
    }

    /**
     * Security checks middleware
     */
    securityChecks(req, res, next) {
        // Check IP blacklist
        const ip = this.getClientIP(req);
        
        if (this.options.ipBlacklist.includes(ip)) {
            this.stats.blocked++;
            this.logSecurityEvent('ip_blacklisted', { ip }, 'error');
            return res.status(403).json({ error: 'Access denied' });
        }
        
        // Check IP whitelist (if configured)
        if (this.options.ipWhitelist.length > 0 && !this.options.ipWhitelist.includes(ip)) {
            this.stats.blocked++;
            this.logSecurityEvent('ip_not_whitelisted', { ip }, 'warning');
            return res.status(403).json({ error: 'Access denied' });
        }
        
        // Check URL length
        if (req.url.length > this.options.maxUrlLength) {
            this.stats.blocked++;
            this.logSecurityEvent('url_too_long', { 
                url: req.url.substring(0, 100) + '...', 
                length: req.url.length 
            }, 'warning');
            return res.status(414).json({ error: 'URI too long' });
        }
        
        // Add security context
        req.security = {
            ip,
            timestamp: Date.now(),
            authenticated: false,
            authMethod: null
        };
        
        // Store rate limit info for enhanced headers
        req.rateLimit = {
            limit: this.options.rateLimit?.perIP?.requests || 100,
            remaining: null, // Will be set by rate limiter
            resetTime: null,
            retryAfter: null
        };
        
        next();
    }

    /**
     * Rate limit middleware
     */
    async rateLimitMiddleware(req, res, next) {
        const context = {
            req,
            ip: req.security.ip,
            endpoint: req.path,
            userId: req.userId,
            apiKey: req.headers['x-api-key']
        };
        
        const result = await this.rateLimiter.checkLimit(context);
        
        if (result.headers) {
            this.rateLimiter.applyHeaders(res, result.headers);
        }
        
        // Update rate limit info for enhanced headers
        if (req.rateLimit && result.remaining !== undefined) {
            req.rateLimit.remaining = result.remaining;
            req.rateLimit.resetTime = result.resetTime;
            req.rateLimit.retryAfter = result.retryAfter;
        }
        
        if (!result.allowed) {
            return res.status(429).json({
                error: 'Too Many Requests',
                message: result.reason,
                retryAfter: result.retryAfter
            });
        }
        
        next();
    }

    /**
     * API key middleware
     */
    async apiKeyMiddleware(req, res, next) {
        const apiKey = req.headers['x-api-key'] || 
                      req.headers['authorization']?.replace('Bearer ', '') ||
                      req.query.api_key;
        
        if (!apiKey) {
            return next();
        }
        
        const keyInfo = await this.apiKeyManager.validateKey(apiKey, {
            ipAddress: req.security.ip,
            userAgent: req.headers['user-agent'],
            endpoint: req.path
        });
        
        if (keyInfo) {
            req.apiKey = keyInfo;
            req.userId = keyInfo.userId;
            req.security.authenticated = true;
            req.security.authMethod = 'api_key';
            this.stats.authenticated++;
            
            // Apply API key rate limits
            if (this.rateLimiter && keyInfo.rateLimit) {
                req.rateLimitOverride = keyInfo.rateLimit;
            }
        }
        
        next();
    }

    /**
     * Get client IP address
     */
    getClientIP(req) {
        return req.ip || 
               req.headers['x-forwarded-for']?.split(',')[0] || 
               req.socket?.remoteAddress ||
               'unknown';
    }

    /**
     * Log security event
     */
    logSecurityEvent(event, data, level = 'info') {
        if (!this.options.logSecurityEvents) {
            return;
        }
        
        const logData = {
            event,
            timestamp: new Date().toISOString(),
            ...data
        };
        
        this.logger[level](`Security Event: ${event}`, logData);
        this.emit('security:event', { event, data, level });
        
        // Store in database for audit trail
        try {
            this.db.prepare(`
                INSERT INTO security_events (
                    event_type, level, ip_address, user_id, 
                    data, created_at
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(
                event,
                level,
                data.ip || null,
                data.userId || null,
                JSON.stringify(data)
            );
        } catch (error) {
            this.logger.error('Failed to log security event:', error);
        }
    }

    /**
     * Get security report
     */
    getSecurityReport() {
        const report = {
            stats: this.stats,
            timestamp: new Date().toISOString()
        };
        
        // Add component stats
        if (this.sessionManager) {
            report.sessions = this.sessionManager.getStats();
        }
        
        if (this.apiKeyManager) {
            report.apiKeys = this.apiKeyManager.getStats();
        }
        
        if (this.csrfProtection) {
            report.csrf = this.csrfProtection.getStats();
        }
        
        if (this.rateLimiter) {
            report.rateLimit = this.rateLimiter.getStats();
        }
        
        if (this.ddosProtection) {
            report.ddos = this.ddosProtection.getStats();
        }
        
        if (this.enhancedHeaders) {
            report.securityHeaders = {
                enabled: true,
                features: this.options.enhancedHeaders?.features || {},
                environment: this.options.enhancedHeaders?.environment || 'development'
            };
        }
        
        return report;
    }

    /**
     * Create auth routes
     */
    createAuthRoutes(authManager) {
        const router = require('express').Router();
        
        // Session-based auth routes
        router.post('/login', async (req, res) => {
            try {
                const { username, password, twoFactorCode } = req.body;
                
                const result = await authManager.authenticate(
                    username, 
                    password, 
                    twoFactorCode
                );
                
                if (result.success) {
                    // Create session
                    const session = await req.createSession(result.user.id, {
                        username: result.user.username,
                        role: result.user.role
                    });
                    
                    res.json({
                        success: true,
                        user: result.user,
                        session: {
                            token: session.token,
                            expiresAt: session.expiresAt
                        }
                    });
                } else {
                    res.status(401).json({
                        success: false,
                        error: result.error
                    });
                }
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: 'Authentication failed'
                });
            }
        });
        
        router.post('/logout', async (req, res) => {
            if (req.session) {
                await req.session.destroy();
            }
            
            res.json({ success: true });
        });
        
        // API key management routes
        router.post('/api-keys', this.requireAuth(), async (req, res) => {
            try {
                const { name, permissions, scopes, expiresIn } = req.body;
                
                const key = await this.apiKeyManager.generateKey(req.userId, {
                    name,
                    permissions,
                    scopes,
                    expiresIn
                });
                
                res.json({
                    success: true,
                    key: key.key, // Only time the full key is shown
                    id: key.id,
                    prefix: key.prefix
                });
            } catch (error) {
                res.status(400).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        router.get('/api-keys', this.requireAuth(), async (req, res) => {
            try {
                const keys = await this.apiKeyManager.listKeys(req.userId);
                res.json({ success: true, keys });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: 'Failed to list API keys'
                });
            }
        });
        
        router.post('/api-keys/:id/rotate', this.requireAuth(), async (req, res) => {
            try {
                const newKey = await this.apiKeyManager.rotateKey(
                    req.params.id,
                    req.userId
                );
                
                res.json({
                    success: true,
                    key: newKey.key,
                    rotationDeadline: newKey.rotationDeadline
                });
            } catch (error) {
                res.status(400).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        router.delete('/api-keys/:id', this.requireAuth(), async (req, res) => {
            try {
                await this.apiKeyManager.revokeKey(
                    req.params.id,
                    req.userId,
                    req.body.reason
                );
                
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({
                    success: false,
                    error: error.message
                });
            }
        });
        
        return router;
    }

    /**
     * Require authentication middleware
     */
    requireAuth(options = {}) {
        return (req, res, next) => {
            if (!req.security?.authenticated) {
                return res.status(401).json({
                    error: 'Authentication required'
                });
            }
            
            // Check specific auth method if required
            if (options.method && req.security.authMethod !== options.method) {
                return res.status(401).json({
                    error: `Authentication method ${options.method} required`
                });
            }
            
            // Check permissions if required
            if (options.permission) {
                const hasPermission = req.session?.data?.role === 'admin' ||
                                    req.apiKey?.permissions?.includes(options.permission) ||
                                    req.apiKey?.permissions?.includes('admin');
                
                if (!hasPermission) {
                    return res.status(403).json({
                        error: 'Insufficient permissions'
                    });
                }
            }
            
            next();
        };
    }

    /**
     * Shutdown
     */
    async shutdown() {
        if (this.sessionManager) {
            await this.sessionManager.shutdown();
        }
        
        if (this.apiKeyManager) {
            this.apiKeyManager.shutdown();
        }
        
        if (this.csrfProtection) {
            this.csrfProtection.shutdown();
        }
        
        if (this.rateLimiter) {
            this.rateLimiter.shutdown();
        }
        
        if (this.ddosProtection) {
            this.ddosProtection.shutdown();
        }
        
        this.removeAllListeners();
    }
}

export default UnifiedSecurityMiddleware;