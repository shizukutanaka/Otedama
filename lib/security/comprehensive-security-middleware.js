/**
 * Comprehensive Security Middleware
 * Integrates all security features into a unified middleware stack
 */

const helmet = require('helmet');
const { NetworkSecurityManager } = require('./network-security');
const { EnhancedDDoSProtection, DDoSProtectionMiddleware } = require('./enhanced-ddos-protection');
const EnhancedAuthSystem = require('./enhanced-auth-system');
const AdvancedRateLimiter = require('./advanced-rate-limiter');
const { InputValidator } = require('./input-validator');
const EnhancedTLSConfig = require('./enhanced-tls-config');
const SecurityAuditLogger = require('./security-audit-logger');
const IntrusionDetectionSystem = require('./intrusion-detection-system');
const DataEncryption = require('./data-encryption');

class ComprehensiveSecurityMiddleware {
    constructor(config = {}) {
        this.config = {
            // Enable/disable specific features
            enableNetworkSecurity: config.enableNetworkSecurity !== false,
            enableDDoSProtection: config.enableDDoSProtection !== false,
            enableAuthentication: config.enableAuthentication !== false,
            enableRateLimiting: config.enableRateLimiting !== false,
            enableInputValidation: config.enableInputValidation !== false,
            enableTLS: config.enableTLS !== false,
            enableAuditLogging: config.enableAuditLogging !== false,
            enableIntrusionDetection: config.enableIntrusionDetection !== false,
            enableDataEncryption: config.enableDataEncryption !== false,
            
            // Component configurations
            networkSecurity: config.networkSecurity || {},
            ddosProtection: config.ddosProtection || {},
            authentication: config.authentication || {},
            rateLimiting: config.rateLimiting || {},
            inputValidation: config.inputValidation || {},
            tls: config.tls || {},
            auditLogging: config.auditLogging || {},
            intrusionDetection: config.intrusionDetection || {},
            dataEncryption: config.dataEncryption || {},
            
            // Security headers
            securityHeaders: {
                'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
                'X-Frame-Options': 'DENY',
                'X-Content-Type-Options': 'nosniff',
                'X-XSS-Protection': '1; mode=block',
                'X-DNS-Prefetch-Control': 'off',
                'X-Download-Options': 'noopen',
                'X-Permitted-Cross-Domain-Policies': 'none',
                'Referrer-Policy': 'strict-origin-when-cross-origin',
                'Content-Security-Policy': config.csp || "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';",
                'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=()',
                ...config.customHeaders
            },
            
            // CORS settings
            cors: {
                origin: config.corsOrigin || false,
                credentials: config.corsCredentials || true,
                methods: config.corsMethods || ['GET', 'POST', 'PUT', 'DELETE'],
                allowedHeaders: config.corsAllowedHeaders || ['Content-Type', 'Authorization'],
                exposedHeaders: config.corsExposedHeaders || [],
                maxAge: config.corsMaxAge || 86400
            },
            
            // Global settings
            trustProxy: config.trustProxy || false,
            
            ...config
        };
        
        // Initialize components
        this.initializeComponents();
    }
    
    /**
     * Initialize security components
     */
    initializeComponents() {
        // Network Security
        if (this.config.enableNetworkSecurity) {
            this.networkSecurity = new NetworkSecurityManager(this.config.networkSecurity);
        }
        
        // DDoS Protection
        if (this.config.enableDDoSProtection) {
            this.ddosProtection = new EnhancedDDoSProtection(this.config.ddosProtection);
            this.ddosMiddleware = new DDoSProtectionMiddleware(this.ddosProtection);
        }
        
        // Authentication
        if (this.config.enableAuthentication) {
            this.authSystem = new EnhancedAuthSystem(this.config.authentication);
        }
        
        // Rate Limiting
        if (this.config.enableRateLimiting) {
            this.rateLimiter = new AdvancedRateLimiter(this.config.rateLimiting);
        }
        
        // Input Validation
        if (this.config.enableInputValidation) {
            this.inputValidator = new InputValidator(this.config.inputValidation);
        }
        
        // TLS Configuration
        if (this.config.enableTLS) {
            this.tlsConfig = new EnhancedTLSConfig(this.config.tls);
        }
        
        // Audit Logging
        if (this.config.enableAuditLogging) {
            this.auditLogger = new SecurityAuditLogger(this.config.auditLogging);
        }
        
        // Intrusion Detection
        if (this.config.enableIntrusionDetection) {
            this.ids = new IntrusionDetectionSystem(this.config.intrusionDetection);
        }
        
        // Data Encryption
        if (this.config.enableDataEncryption) {
            this.dataEncryption = new DataEncryption(this.config.dataEncryption);
        }
    }
    
    /**
     * Create middleware stack
     */
    createMiddlewareStack() {
        const middlewares = [];
        
        // Trust proxy if configured
        if (this.config.trustProxy) {
            middlewares.push((req, res, next) => {
                req.app.set('trust proxy', this.config.trustProxy);
                next();
            });
        }
        
        // Basic security headers with Helmet
        middlewares.push(helmet({
            contentSecurityPolicy: {
                directives: this.parseCSP(this.config.securityHeaders['Content-Security-Policy'])
            },
            hsts: {
                maxAge: 31536000,
                includeSubDomains: true,
                preload: true
            }
        }));
        
        // Custom security headers
        middlewares.push(this.securityHeaders());
        
        // CORS
        middlewares.push(this.cors());
        
        // Network security check
        if (this.config.enableNetworkSecurity) {
            middlewares.push(this.networkSecurityMiddleware());
        }
        
        // DDoS protection
        if (this.config.enableDDoSProtection) {
            middlewares.push(this.ddosMiddleware.middleware());
        }
        
        // Rate limiting
        if (this.config.enableRateLimiting) {
            middlewares.push(this.rateLimitingMiddleware());
        }
        
        // Intrusion detection
        if (this.config.enableIntrusionDetection) {
            middlewares.push(this.intrusionDetectionMiddleware());
        }
        
        // Input validation setup
        if (this.config.enableInputValidation) {
            middlewares.push(this.inputValidationSetup());
        }
        
        // Audit logging
        if (this.config.enableAuditLogging) {
            middlewares.push(this.auditLoggingMiddleware());
        }
        
        return middlewares;
    }
    
    /**
     * Security headers middleware
     */
    securityHeaders() {
        return (req, res, next) => {
            // Set custom security headers
            Object.entries(this.config.securityHeaders).forEach(([header, value]) => {
                if (header !== 'Content-Security-Policy') { // CSP handled by Helmet
                    res.setHeader(header, value);
                }
            });
            
            // Remove dangerous headers
            res.removeHeader('X-Powered-By');
            res.removeHeader('Server');
            
            // Add request ID for tracking
            req.id = req.headers['x-request-id'] || this.generateRequestId();
            res.setHeader('X-Request-ID', req.id);
            
            next();
        };
    }
    
    /**
     * CORS middleware
     */
    cors() {
        return (req, res, next) => {
            const origin = req.headers.origin;
            
            // Check origin
            if (this.config.cors.origin) {
                const allowed = typeof this.config.cors.origin === 'function'
                    ? this.config.cors.origin(origin)
                    : this.config.cors.origin;
                    
                if (allowed) {
                    res.setHeader('Access-Control-Allow-Origin', origin || '*');
                }
            }
            
            // Credentials
            if (this.config.cors.credentials) {
                res.setHeader('Access-Control-Allow-Credentials', 'true');
            }
            
            // Preflight requests
            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Methods', this.config.cors.methods.join(', '));
                res.setHeader('Access-Control-Allow-Headers', this.config.cors.allowedHeaders.join(', '));
                res.setHeader('Access-Control-Max-Age', this.config.cors.maxAge);
                
                if (this.config.cors.exposedHeaders.length > 0) {
                    res.setHeader('Access-Control-Expose-Headers', this.config.cors.exposedHeaders.join(', '));
                }
                
                return res.sendStatus(204);
            }
            
            next();
        };
    }
    
    /**
     * Network security middleware
     */
    networkSecurityMiddleware() {
        return async (req, res, next) => {
            const ip = this.getClientIP(req);
            const metadata = {
                method: req.method,
                path: req.path,
                userAgent: req.headers['user-agent'],
                headers: req.headers
            };
            
            const check = await this.networkSecurity.checkConnection(ip, metadata);
            
            if (!check.allowed) {
                if (this.auditLogger) {
                    this.auditLogger.log('security', 'connection_blocked', {
                        ip,
                        reason: check.reason,
                        metadata
                    });
                }
                
                return res.status(403).json({
                    error: 'Access denied',
                    reason: check.reason
                });
            }
            
            // Track connection
            const connectionId = this.networkSecurity.trackConnection(ip, req.id, metadata);
            
            // Clean up on response
            res.on('finish', () => {
                this.networkSecurity.updateConnection(connectionId, {
                    bytesIn: req.socket.bytesRead,
                    bytesOut: req.socket.bytesWritten
                });
                this.networkSecurity.removeConnection(connectionId);
            });
            
            next();
        };
    }
    
    /**
     * Rate limiting middleware
     */
    rateLimitingMiddleware() {
        return this.rateLimiter.middleware({
            keyGenerator: async (req) => {
                // Use authenticated user ID if available
                if (req.user && req.user.id) {
                    return `user:${req.user.id}`;
                }
                // Otherwise use IP
                return `ip:${this.getClientIP(req)}`;
            },
            message: 'Too many requests, please try again later'
        });
    }
    
    /**
     * Intrusion detection middleware
     */
    intrusionDetectionMiddleware() {
        return async (req, res, next) => {
            const threat = await this.ids.analyze({
                ip: this.getClientIP(req),
                method: req.method,
                path: req.path,
                headers: req.headers,
                body: req.body,
                query: req.query
            });
            
            if (threat.detected) {
                if (this.auditLogger) {
                    this.auditLogger.log('security', 'intrusion_detected', {
                        threat,
                        request: {
                            id: req.id,
                            ip: this.getClientIP(req),
                            path: req.path
                        }
                    });
                }
                
                // Block high-severity threats
                if (threat.severity === 'high' || threat.severity === 'critical') {
                    return res.status(403).json({
                        error: 'Security threat detected',
                        message: 'Your request has been blocked'
                    });
                }
            }
            
            next();
        };
    }
    
    /**
     * Input validation setup
     */
    inputValidationSetup() {
        return (req, res, next) => {
            // Add validation method to request
            req.validate = async (schema) => {
                return await this.inputValidator.validateObject(req.body, schema);
            };
            
            // Add sanitization method
            req.sanitize = (value, sanitizers) => {
                let sanitized = value;
                for (const sanitizer of sanitizers) {
                    const fn = this.inputValidator.sanitizers.get(sanitizer);
                    if (fn) {
                        sanitized = fn(sanitized);
                    }
                }
                return sanitized;
            };
            
            next();
        };
    }
    
    /**
     * Audit logging middleware
     */
    auditLoggingMiddleware() {
        return async (req, res, next) => {
            const startTime = Date.now();
            
            // Log request
            const requestLog = {
                id: req.id,
                timestamp: new Date().toISOString(),
                ip: this.getClientIP(req),
                method: req.method,
                path: req.path,
                query: req.query,
                headers: this.sanitizeHeaders(req.headers),
                user: req.user ? { id: req.user.id, username: req.user.username } : null
            };
            
            // Log response
            const originalSend = res.send;
            res.send = function(data) {
                res.send = originalSend;
                
                const responseLog = {
                    ...requestLog,
                    duration: Date.now() - startTime,
                    statusCode: res.statusCode,
                    contentLength: res.get('content-length')
                };
                
                // Log based on status code
                if (res.statusCode >= 500) {
                    this.auditLogger.log('error', 'server_error', responseLog);
                } else if (res.statusCode >= 400) {
                    this.auditLogger.log('warning', 'client_error', responseLog);
                } else {
                    this.auditLogger.log('info', 'request', responseLog);
                }
                
                return res.send(data);
            }.bind(this);
            
            next();
        };
    }
    
    /**
     * Authentication middleware
     */
    authenticationMiddleware(options = {}) {
        return async (req, res, next) => {
            const { required = true, roles = [] } = options;
            
            // Extract token
            const token = this.extractToken(req);
            
            if (!token) {
                if (required) {
                    return res.status(401).json({
                        error: 'Authentication required',
                        message: 'No authentication token provided'
                    });
                }
                return next();
            }
            
            try {
                // Verify token
                const user = await this.authSystem.verifyAccessToken(token);
                req.user = user;
                
                // Check roles
                if (roles.length > 0) {
                    const hasRole = roles.some(role => user.role === role || user.roles?.includes(role));
                    if (!hasRole) {
                        return res.status(403).json({
                            error: 'Insufficient permissions',
                            message: 'You do not have permission to access this resource'
                        });
                    }
                }
                
                next();
            } catch (error) {
                if (this.auditLogger) {
                    this.auditLogger.log('warning', 'auth_failure', {
                        ip: this.getClientIP(req),
                        token: token.substring(0, 10) + '...',
                        error: error.message
                    });
                }
                
                return res.status(401).json({
                    error: 'Authentication failed',
                    message: error.message
                });
            }
        };
    }
    
    /**
     * Data encryption middleware
     */
    encryptionMiddleware() {
        return (req, res, next) => {
            // Decrypt request body if encrypted
            if (req.headers['x-encrypted'] === 'true' && req.body.encrypted) {
                try {
                    req.body = this.dataEncryption.decrypt(req.body.encrypted);
                } catch (error) {
                    return res.status(400).json({
                        error: 'Decryption failed',
                        message: 'Unable to decrypt request body'
                    });
                }
            }
            
            // Add encryption method to response
            res.encrypt = (data) => {
                const encrypted = this.dataEncryption.encrypt(data);
                res.setHeader('X-Encrypted', 'true');
                return { encrypted };
            };
            
            next();
        };
    }
    
    /**
     * Error handling middleware
     */
    errorHandler() {
        return (err, req, res, next) => {
            // Log error
            if (this.auditLogger) {
                this.auditLogger.log('error', 'unhandled_error', {
                    id: req.id,
                    ip: this.getClientIP(req),
                    path: req.path,
                    error: {
                        message: err.message,
                        stack: err.stack,
                        code: err.code
                    }
                });
            }
            
            // Send appropriate response
            const statusCode = err.statusCode || err.status || 500;
            const message = statusCode === 500 ? 'Internal server error' : err.message;
            
            res.status(statusCode).json({
                error: err.name || 'Error',
                message,
                ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
            });
        };
    }
    
    /**
     * Helper methods
     */
    
    getClientIP(req) {
        if (this.config.trustProxy) {
            return req.ip || 
                   req.headers['x-forwarded-for']?.split(',')[0] ||
                   req.headers['x-real-ip'] ||
                   req.connection.remoteAddress;
        }
        return req.connection.remoteAddress;
    }
    
    extractToken(req) {
        // Authorization header
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return authHeader.substring(7);
        }
        
        // Query parameter
        if (req.query.token) {
            return req.query.token;
        }
        
        // Cookie
        if (req.cookies && req.cookies.token) {
            return req.cookies.token;
        }
        
        return null;
    }
    
    sanitizeHeaders(headers) {
        const sensitive = ['authorization', 'cookie', 'x-api-key'];
        const sanitized = { ...headers };
        
        sensitive.forEach(header => {
            if (sanitized[header]) {
                sanitized[header] = '[REDACTED]';
            }
        });
        
        return sanitized;
    }
    
    generateRequestId() {
        return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    }
    
    parseCSP(cspString) {
        const directives = {};
        const parts = cspString.split(';').map(p => p.trim()).filter(p => p);
        
        parts.forEach(part => {
            const [directive, ...values] = part.split(' ');
            directives[directive] = values;
        });
        
        return directives;
    }
    
    /**
     * Get security status
     */
    getStatus() {
        const status = {
            components: {
                networkSecurity: this.networkSecurity?.getStatus(),
                ddosProtection: this.ddosProtection?.getStatus(),
                rateLimiting: this.rateLimiter?.getMetrics(),
                authentication: {
                    sessions: this.authSystem?.sessions.size,
                    users: this.authSystem?.users.size
                },
                intrusionDetection: this.ids?.getStatus()
            },
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        };
        
        return status;
    }
}

/**
 * Security Audit Logger (placeholder)
 */
class SecurityAuditLogger {
    constructor(config) {
        this.config = config;
    }
    
    log(level, event, data) {
        console.log(`[${level.toUpperCase()}] ${event}:`, data);
    }
}

/**
 * Intrusion Detection System (placeholder)
 */
class IntrusionDetectionSystem {
    constructor(config) {
        this.config = config;
    }
    
    async analyze(request) {
        // Simplified analysis
        return {
            detected: false,
            severity: 'low',
            threats: []
        };
    }
    
    getStatus() {
        return { active: true };
    }
}

/**
 * Data Encryption (placeholder)
 */
class DataEncryption {
    constructor(config) {
        this.config = config;
    }
    
    encrypt(data) {
        // Simplified encryption
        return Buffer.from(JSON.stringify(data)).toString('base64');
    }
    
    decrypt(encrypted) {
        // Simplified decryption
        return JSON.parse(Buffer.from(encrypted, 'base64').toString());
    }
}

module.exports = ComprehensiveSecurityMiddleware;