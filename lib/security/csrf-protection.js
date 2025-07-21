/**
 * Enhanced CSRF Protection
 * Implements multiple CSRF protection strategies
 */

import { EventEmitter } from 'events';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';

export class CSRFProtection extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            // Token configuration
            tokenLength: options.tokenLength || 32,
            tokenName: options.tokenName || 'csrf-token',
            headerName: options.headerName || 'x-csrf-token',
            
            // Strategy: 'synchronizer', 'double-submit', 'encrypted', 'signed'
            strategy: options.strategy || 'double-submit',
            
            // Secret for signing/encryption
            secret: options.secret || randomBytes(32).toString('hex'),
            
            // Cookie options
            cookieName: options.cookieName || '__Host-csrf',
            cookieOptions: {
                httpOnly: true,
                secure: true,
                sameSite: 'strict',
                path: '/',
                ...options.cookieOptions
            },
            
            // Session binding
            bindToSession: options.bindToSession !== false,
            
            // Token rotation
            rotateOnUse: options.rotateOnUse || false,
            tokenLifetime: options.tokenLifetime || 3600000, // 1 hour
            
            // Excluded paths
            excludePaths: options.excludePaths || [
                '/api/webhook',
                '/api/public'
            ],
            
            // Excluded methods
            safeMethods: options.safeMethods || ['GET', 'HEAD', 'OPTIONS'],
            
            // Origin validation
            validateOrigin: options.validateOrigin !== false,
            allowedOrigins: options.allowedOrigins || [],
            
            // Double submit cookie options
            doubleSubmit: {
                encryptCookie: options.doubleSubmit?.encryptCookie !== false,
                signCookie: options.doubleSubmit?.signCookie !== false,
                ...options.doubleSubmit
            },
            
            ...options
        };
        
        // Token storage for synchronizer pattern
        this.tokens = new Map();
        
        // Statistics
        this.stats = {
            generated: 0,
            validated: 0,
            failed: 0,
            rotated: 0
        };
        
        // Start cleanup
        this.startCleanup();
    }

    /**
     * Generate CSRF token
     */
    generateToken(req, res) {
        try {
            const token = randomBytes(this.options.tokenLength).toString('hex');
            const timestamp = Date.now();
            
            switch (this.options.strategy) {
                case 'synchronizer':
                    return this.generateSynchronizerToken(req, token, timestamp);
                    
                case 'double-submit':
                    return this.generateDoubleSubmitToken(req, res, token, timestamp);
                    
                case 'encrypted':
                    return this.generateEncryptedToken(req, res, token, timestamp);
                    
                case 'signed':
                    return this.generateSignedToken(req, res, token, timestamp);
                    
                default:
                    throw new Error(`Unknown CSRF strategy: ${this.options.strategy}`);
            }
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Validate CSRF token
     */
    validateToken(req) {
        try {
            // Skip safe methods
            if (this.options.safeMethods.includes(req.method)) {
                return { valid: true, reason: 'safe_method' };
            }
            
            // Skip excluded paths
            const path = req.path || req.url;
            if (this.options.excludePaths.some(p => path.startsWith(p))) {
                return { valid: true, reason: 'excluded_path' };
            }
            
            // Validate origin if enabled
            if (this.options.validateOrigin && !this.validateOrigin(req)) {
                this.stats.failed++;
                return { valid: false, reason: 'origin_mismatch' };
            }
            
            // Get token from request
            const token = this.getTokenFromRequest(req);
            if (!token) {
                this.stats.failed++;
                return { valid: false, reason: 'token_missing' };
            }
            
            // Validate based on strategy
            let result;
            switch (this.options.strategy) {
                case 'synchronizer':
                    result = this.validateSynchronizerToken(req, token);
                    break;
                    
                case 'double-submit':
                    result = this.validateDoubleSubmitToken(req, token);
                    break;
                    
                case 'encrypted':
                    result = this.validateEncryptedToken(req, token);
                    break;
                    
                case 'signed':
                    result = this.validateSignedToken(req, token);
                    break;
                    
                default:
                    result = { valid: false, reason: 'unknown_strategy' };
            }
            
            if (result.valid) {
                this.stats.validated++;
                
                // Rotate token if enabled
                if (this.options.rotateOnUse) {
                    this.rotateToken(req);
                    this.stats.rotated++;
                }
            } else {
                this.stats.failed++;
            }
            
            return result;
            
        } catch (error) {
            this.emit('error', error);
            this.stats.failed++;
            return { valid: false, reason: 'validation_error', error: error.message };
        }
    }

    /**
     * Generate synchronizer token (server-side storage)
     */
    generateSynchronizerToken(req, token, timestamp) {
        const sessionId = req.sessionId || req.session?.id;
        if (!sessionId && this.options.bindToSession) {
            throw new Error('Session required for synchronizer token');
        }
        
        const tokenData = {
            token,
            timestamp,
            sessionId,
            userId: req.userId
        };
        
        const key = sessionId || `anonymous_${req.ip}`;
        this.tokens.set(key, tokenData);
        
        this.stats.generated++;
        
        return token;
    }

    /**
     * Validate synchronizer token
     */
    validateSynchronizerToken(req, token) {
        const sessionId = req.sessionId || req.session?.id;
        const key = sessionId || `anonymous_${req.ip}`;
        
        const stored = this.tokens.get(key);
        if (!stored) {
            return { valid: false, reason: 'token_not_found' };
        }
        
        // Check token match
        if (stored.token !== token) {
            return { valid: false, reason: 'token_mismatch' };
        }
        
        // Check expiration
        if (Date.now() - stored.timestamp > this.options.tokenLifetime) {
            this.tokens.delete(key);
            return { valid: false, reason: 'token_expired' };
        }
        
        // Check session binding
        if (this.options.bindToSession && stored.sessionId !== sessionId) {
            return { valid: false, reason: 'session_mismatch' };
        }
        
        return { valid: true };
    }

    /**
     * Generate double-submit token
     */
    generateDoubleSubmitToken(req, res, token, timestamp) {
        const data = `${token}:${timestamp}`;
        let cookieValue;
        
        if (this.options.doubleSubmit.encryptCookie) {
            cookieValue = this.encrypt(data);
        } else if (this.options.doubleSubmit.signCookie) {
            const signature = this.sign(data);
            cookieValue = `${data}.${signature}`;
        } else {
            cookieValue = data;
        }
        
        // Set cookie
        res.cookie(this.options.cookieName, cookieValue, {
            ...this.options.cookieOptions,
            maxAge: this.options.tokenLifetime
        });
        
        this.stats.generated++;
        
        return token;
    }

    /**
     * Validate double-submit token
     */
    validateDoubleSubmitToken(req, token) {
        const cookie = req.cookies?.[this.options.cookieName];
        if (!cookie) {
            return { valid: false, reason: 'cookie_missing' };
        }
        
        let data;
        try {
            if (this.options.doubleSubmit.encryptCookie) {
                data = this.decrypt(cookie);
            } else if (this.options.doubleSubmit.signCookie) {
                const parts = cookie.split('.');
                if (parts.length !== 2) {
                    return { valid: false, reason: 'invalid_cookie_format' };
                }
                
                const [payload, signature] = parts;
                if (!this.verify(payload, signature)) {
                    return { valid: false, reason: 'invalid_signature' };
                }
                
                data = payload;
            } else {
                data = cookie;
            }
            
            const [cookieToken, timestamp] = data.split(':');
            
            // Check token match
            if (cookieToken !== token) {
                return { valid: false, reason: 'token_mismatch' };
            }
            
            // Check expiration
            if (Date.now() - parseInt(timestamp) > this.options.tokenLifetime) {
                return { valid: false, reason: 'token_expired' };
            }
            
            return { valid: true };
            
        } catch (error) {
            return { valid: false, reason: 'cookie_validation_error', error: error.message };
        }
    }

    /**
     * Generate encrypted token
     */
    generateEncryptedToken(req, res, token, timestamp) {
        const data = JSON.stringify({
            token,
            timestamp,
            sessionId: req.sessionId,
            userId: req.userId,
            ip: req.ip
        });
        
        const encrypted = this.encrypt(data);
        
        // Set as both cookie and return value
        res.cookie(this.options.cookieName, encrypted, {
            ...this.options.cookieOptions,
            maxAge: this.options.tokenLifetime
        });
        
        this.stats.generated++;
        
        return encrypted;
    }

    /**
     * Validate encrypted token
     */
    validateEncryptedToken(req, token) {
        try {
            const decrypted = this.decrypt(token);
            const data = JSON.parse(decrypted);
            
            // Check expiration
            if (Date.now() - data.timestamp > this.options.tokenLifetime) {
                return { valid: false, reason: 'token_expired' };
            }
            
            // Check session binding
            if (this.options.bindToSession && data.sessionId !== req.sessionId) {
                return { valid: false, reason: 'session_mismatch' };
            }
            
            // Check IP binding (optional)
            if (data.ip && data.ip !== req.ip) {
                this.emit('security:ip_mismatch', {
                    expected: data.ip,
                    actual: req.ip
                });
            }
            
            return { valid: true };
            
        } catch (error) {
            return { valid: false, reason: 'decryption_failed', error: error.message };
        }
    }

    /**
     * Generate signed token
     */
    generateSignedToken(req, res, token, timestamp) {
        const data = JSON.stringify({
            token,
            timestamp,
            sessionId: req.sessionId,
            userId: req.userId
        });
        
        const signature = this.sign(data);
        const signedToken = `${Buffer.from(data).toString('base64')}.${signature}`;
        
        this.stats.generated++;
        
        return signedToken;
    }

    /**
     * Validate signed token
     */
    validateSignedToken(req, token) {
        try {
            const parts = token.split('.');
            if (parts.length !== 2) {
                return { valid: false, reason: 'invalid_token_format' };
            }
            
            const [payload, signature] = parts;
            
            // Verify signature
            if (!this.verify(Buffer.from(payload, 'base64').toString(), signature)) {
                return { valid: false, reason: 'invalid_signature' };
            }
            
            // Parse payload
            const data = JSON.parse(Buffer.from(payload, 'base64').toString());
            
            // Check expiration
            if (Date.now() - data.timestamp > this.options.tokenLifetime) {
                return { valid: false, reason: 'token_expired' };
            }
            
            // Check session binding
            if (this.options.bindToSession && data.sessionId !== req.sessionId) {
                return { valid: false, reason: 'session_mismatch' };
            }
            
            return { valid: true };
            
        } catch (error) {
            return { valid: false, reason: 'validation_error', error: error.message };
        }
    }

    /**
     * Get token from request
     */
    getTokenFromRequest(req) {
        // Check header
        let token = req.headers[this.options.headerName.toLowerCase()];
        
        // Check body
        if (!token && req.body) {
            token = req.body[this.options.tokenName];
        }
        
        // Check query
        if (!token && req.query) {
            token = req.query[this.options.tokenName];
        }
        
        return token;
    }

    /**
     * Validate origin
     */
    validateOrigin(req) {
        const origin = req.headers.origin || req.headers.referer;
        if (!origin) {
            return true; // Allow requests without origin (e.g., same-origin)
        }
        
        try {
            const url = new URL(origin);
            const host = req.headers.host;
            
            // Check same origin
            if (url.host === host) {
                return true;
            }
            
            // Check allowed origins
            if (this.options.allowedOrigins.length > 0) {
                return this.options.allowedOrigins.some(allowed => {
                    if (allowed === '*') return true;
                    if (allowed === origin) return true;
                    
                    // Support wildcard subdomains
                    if (allowed.startsWith('*.')) {
                        const domain = allowed.slice(2);
                        return url.hostname.endsWith(domain);
                    }
                    
                    return false;
                });
            }
            
            return false;
            
        } catch (error) {
            return false;
        }
    }

    /**
     * Rotate token
     */
    rotateToken(req) {
        try {
            const newToken = this.generateToken(req);
            
            this.emit('token:rotated', {
                sessionId: req.sessionId,
                userId: req.userId
            });
            
            return newToken;
            
        } catch (error) {
            this.emit('error', error);
            return null;
        }
    }

    /**
     * Sign data
     */
    sign(data) {
        return createHash('sha256')
            .update(data + this.options.secret)
            .digest('hex');
    }

    /**
     * Verify signature
     */
    verify(data, signature) {
        const expected = this.sign(data);
        return timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expected)
        );
    }

    /**
     * Encrypt data (simple XOR for demonstration)
     */
    encrypt(data) {
        // In production, use proper encryption (AES-GCM)
        const cipher = Buffer.from(this.options.secret, 'hex');
        const buffer = Buffer.from(data);
        const encrypted = Buffer.alloc(buffer.length);
        
        for (let i = 0; i < buffer.length; i++) {
            encrypted[i] = buffer[i] ^ cipher[i % cipher.length];
        }
        
        return encrypted.toString('base64');
    }

    /**
     * Decrypt data
     */
    decrypt(encrypted) {
        // In production, use proper decryption
        const cipher = Buffer.from(this.options.secret, 'hex');
        const buffer = Buffer.from(encrypted, 'base64');
        const decrypted = Buffer.alloc(buffer.length);
        
        for (let i = 0; i < buffer.length; i++) {
            decrypted[i] = buffer[i] ^ cipher[i % cipher.length];
        }
        
        return decrypted.toString();
    }

    /**
     * Cleanup expired tokens
     */
    cleanup() {
        if (this.options.strategy !== 'synchronizer') {
            return;
        }
        
        const now = Date.now();
        let cleaned = 0;
        
        for (const [key, data] of this.tokens.entries()) {
            if (now - data.timestamp > this.options.tokenLifetime) {
                this.tokens.delete(key);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            this.emit('cleanup', { cleaned });
        }
    }

    /**
     * Start cleanup interval
     */
    startCleanup() {
        if (this.options.strategy === 'synchronizer') {
            this.cleanupInterval = setInterval(() => {
                this.cleanup();
            }, 300000); // 5 minutes
        }
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeTokens: this.tokens.size
        };
    }

    /**
     * Middleware for Express
     */
    middleware() {
        return async (req, res, next) => {
            // Add CSRF token generation method
            req.csrfToken = () => {
                if (!req._csrfToken) {
                    req._csrfToken = this.generateToken(req, res);
                }
                return req._csrfToken;
            };
            
            // Add to response locals for templates
            res.locals.csrfToken = req.csrfToken;
            
            // Validate on non-safe methods
            const validation = this.validateToken(req);
            
            if (!validation.valid) {
                // Log the failure
                this.emit('validation:failed', {
                    reason: validation.reason,
                    method: req.method,
                    path: req.path,
                    ip: req.ip,
                    userId: req.userId
                });
                
                // Return error
                return res.status(403).json({
                    error: 'CSRF validation failed',
                    reason: validation.reason
                });
            }
            
            next();
        };
    }

    /**
     * Shutdown
     */
    shutdown() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        this.tokens.clear();
        this.removeAllListeners();
    }
}

export default CSRFProtection;