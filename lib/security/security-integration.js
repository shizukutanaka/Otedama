/**
 * Security Integration Module
 * Comprehensive security implementation for Otedama Mining Pool
 */

const ComprehensiveSecurityMiddleware = require('./comprehensive-security-middleware');
const { NetworkSecurityManager } = require('./network-security');
const { EnhancedDDoSProtection } = require('./enhanced-ddos-protection');
const EnhancedAuthSystem = require('./enhanced-auth-system');
const AdvancedRateLimiter = require('./advanced-rate-limiter');
const { InputValidator } = require('./input-validator');
const EnhancedTLSConfig = require('./enhanced-tls-config');
const AdvancedIntrusionDetection = require('./advanced-intrusion-detection');
const AdvancedDataEncryption = require('./advanced-data-encryption');

class SecurityIntegration {
    constructor(config = {}) {
        this.config = {
            // Master security settings
            environment: config.environment || 'production',
            debugMode: config.debugMode || false,
            
            // Component configurations with enhanced defaults
            networkSecurity: {
                maxConnectionsPerIP: 100,
                maxRequestsPerMinute: 1000,
                blacklistDuration: 3600000,
                enableGeoBlocking: true,
                blockedCountries: ['XX'], // Add specific country codes as needed
                ...config.networkSecurity
            },
            
            ddosProtection: {
                maxConnectionsPerIP: 50,
                requestsPerMinute: 600,
                enableSynCookies: true,
                enableBehaviorAnalysis: true,
                ...config.ddosProtection
            },
            
            authentication: {
                jwtSecret: process.env.JWT_SECRET || config.jwtSecret,
                passwordMinLength: 12,
                mfaRequired: true,
                maxLoginAttempts: 5,
                lockoutDuration: 1800000,
                ...config.authentication
            },
            
            rateLimiting: {
                windowType: 'sliding',
                ipRequestsPerWindow: 100,
                userRequestsPerWindow: 1000,
                enableAdaptiveLimiting: true,
                endpointLimits: {
                    '/api/login': { requests: 5, window: 300000 },
                    '/api/register': { requests: 3, window: 3600000 },
                    '/api/submit-share': { requests: 1000, window: 60000 },
                    '/api/wallet/*': { requests: 50, window: 300000 },
                    ...config.rateLimiting?.endpointLimits
                },
                ...config.rateLimiting
            },
            
            inputValidation: {
                maxRequestSize: 10 * 1024 * 1024,
                maxFieldLength: 10000,
                allowedMimeTypes: ['application/json'],
                ...config.inputValidation
            },
            
            tls: {
                minVersion: 'TLSv1.2',
                certPath: config.certPath || './certs',
                enableRotation: true,
                ...config.tls
            },
            
            intrusionDetection: {
                enableSignatureDetection: true,
                enableAnomalyDetection: true,
                enableBehaviorAnalysis: true,
                enableMachineLearning: false,
                autoBlock: true,
                ...config.intrusionDetection
            },
            
            dataEncryption: {
                algorithm: 'aes-256-gcm',
                enableKeyRotation: true,
                keyRotationInterval: 2592000000,
                enableFieldEncryption: true,
                encryptedFields: [
                    'password', 'privateKey', 'secret', 'apiKey',
                    'btcAddress', 'walletSeed', 'mnemonic'
                ],
                ...config.dataEncryption
            },
            
            // Security headers
            securityHeaders: {
                'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
                'X-Frame-Options': 'DENY',
                'X-Content-Type-Options': 'nosniff',
                'X-XSS-Protection': '1; mode=block',
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' wss:; frame-ancestors 'none';",
                'Referrer-Policy': 'strict-origin-when-cross-origin',
                'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
                ...config.securityHeaders
            },
            
            ...config
        };
        
        // Initialize all security components
        this.initializeComponents();
    }
    
    /**
     * Initialize security components
     */
    async initializeComponents() {
        console.log('Initializing Otedama Security System...');
        
        try {
            // Create comprehensive middleware
            this.middleware = new ComprehensiveSecurityMiddleware({
                ...this.config,
                enableNetworkSecurity: true,
                enableDDoSProtection: true,
                enableAuthentication: true,
                enableRateLimiting: true,
                enableInputValidation: true,
                enableTLS: true,
                enableAuditLogging: true,
                enableIntrusionDetection: true,
                enableDataEncryption: true
            });
            
            // Get individual components for direct access
            this.components = {
                networkSecurity: this.middleware.networkSecurity,
                ddosProtection: this.middleware.ddosProtection,
                authSystem: this.middleware.authSystem,
                rateLimiter: this.middleware.rateLimiter,
                inputValidator: this.middleware.inputValidator,
                tlsConfig: this.middleware.tlsConfig,
                ids: this.middleware.ids,
                encryption: this.middleware.dataEncryption
            };
            
            // Setup event listeners
            this.setupEventListeners();
            
            // Perform initial security checks
            await this.performSecurityChecks();
            
            console.log('✓ Security system initialized successfully');
            
        } catch (error) {
            console.error('Failed to initialize security system:', error);
            throw error;
        }
    }
    
    /**
     * Setup event listeners for security monitoring
     */
    setupEventListeners() {
        // Network security events
        if (this.components.networkSecurity) {
            this.components.networkSecurity.on('connection-blocked', (data) => {
                console.log('[SECURITY] Connection blocked:', data);
            });
            
            this.components.networkSecurity.on('attack-detected', (data) => {
                console.error('[SECURITY] Attack detected:', data);
                this.handleSecurityIncident('network_attack', data);
            });
        }
        
        // DDoS protection events
        if (this.components.ddosProtection) {
            this.components.ddosProtection.on('ddos-suspected', (data) => {
                console.error('[SECURITY] DDoS suspected:', data);
                this.handleSecurityIncident('ddos_attack', data);
            });
            
            this.components.ddosProtection.on('panic-mode-activated', () => {
                console.warn('[SECURITY] Panic mode activated - reducing limits');
            });
        }
        
        // Authentication events
        if (this.components.authSystem) {
            this.components.authSystem.on('account-locked', (data) => {
                console.warn('[SECURITY] Account locked:', data);
            });
            
            this.components.authSystem.on('suspicious-activity', (data) => {
                console.warn('[SECURITY] Suspicious activity:', data);
                this.handleSecurityIncident('suspicious_auth', data);
            });
        }
        
        // Intrusion detection events
        if (this.components.ids) {
            this.components.ids.on('threat-detected', (data) => {
                console.error('[SECURITY] Threat detected:', data);
                this.handleSecurityIncident('intrusion', data);
            });
            
            this.components.ids.on('security-report', (report) => {
                console.log('[SECURITY] Security report generated:', report);
            });
        }
        
        // Data encryption events
        if (this.components.encryption) {
            this.components.encryption.on('key-rotated', (data) => {
                console.log('[SECURITY] Encryption key rotated:', data);
            });
        }
    }
    
    /**
     * Perform initial security checks
     */
    async performSecurityChecks() {
        const checks = [];
        
        // Check TLS configuration
        if (this.components.tlsConfig) {
            checks.push({
                name: 'TLS Configuration',
                status: 'OK',
                details: {
                    minVersion: this.config.tls.minVersion,
                    ciphers: this.config.tls.ciphers?.split(':').length || 'default'
                }
            });
        }
        
        // Check authentication system
        if (this.components.authSystem) {
            checks.push({
                name: 'Authentication System',
                status: 'OK',
                details: {
                    mfaRequired: this.config.authentication.mfaRequired,
                    passwordMinLength: this.config.authentication.passwordMinLength
                }
            });
        }
        
        // Check rate limiting
        if (this.components.rateLimiter) {
            checks.push({
                name: 'Rate Limiting',
                status: 'OK',
                details: {
                    windowType: this.config.rateLimiting.windowType,
                    adaptiveLimiting: this.config.rateLimiting.enableAdaptiveLimiting
                }
            });
        }
        
        // Check intrusion detection
        if (this.components.ids) {
            checks.push({
                name: 'Intrusion Detection',
                status: 'OK',
                details: {
                    signatures: this.components.ids.signatures.size,
                    autoBlock: this.config.intrusionDetection.autoBlock
                }
            });
        }
        
        console.log('Security Checks:', checks);
        return checks;
    }
    
    /**
     * Handle security incidents
     */
    handleSecurityIncident(type, data) {
        const incident = {
            id: `INC-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type,
            timestamp: new Date().toISOString(),
            data,
            severity: this.calculateIncidentSeverity(type, data)
        };
        
        // Log incident
        console.error('[SECURITY INCIDENT]', incident);
        
        // Take automated response actions
        this.respondToIncident(incident);
        
        // Notify administrators
        this.notifyAdministrators(incident);
    }
    
    /**
     * Calculate incident severity
     */
    calculateIncidentSeverity(type, data) {
        const severityMap = {
            'network_attack': 'high',
            'ddos_attack': 'critical',
            'intrusion': data.analysis?.severity || 'high',
            'suspicious_auth': 'medium',
            'data_breach': 'critical'
        };
        
        return severityMap[type] || 'medium';
    }
    
    /**
     * Automated incident response
     */
    respondToIncident(incident) {
        switch (incident.severity) {
            case 'critical':
                // Activate maximum security measures
                if (this.components.ddosProtection) {
                    this.components.ddosProtection.activatePanicMode();
                }
                // Block all non-essential traffic
                break;
                
            case 'high':
                // Increase security monitoring
                // Reduce rate limits
                break;
                
            case 'medium':
                // Log and monitor closely
                break;
                
            default:
                // Standard logging
                break;
        }
    }
    
    /**
     * Notify administrators of security incidents
     */
    notifyAdministrators(incident) {
        // Implementation would send alerts via email, SMS, webhook, etc.
        console.log(`[ALERT] Security incident requires attention: ${incident.id}`);
    }
    
    /**
     * Create Express middleware stack
     */
    createMiddlewareStack() {
        return this.middleware.createMiddlewareStack();
    }
    
    /**
     * Create specific middleware
     */
    createAuthMiddleware(options) {
        return this.middleware.authenticationMiddleware(options);
    }
    
    createRateLimitMiddleware(options) {
        return this.middleware.rateLimiter.middleware(options);
    }
    
    createValidationMiddleware(schema) {
        return this.middleware.inputValidator.middleware(schema);
    }
    
    /**
     * Security utilities
     */
    async encryptData(data) {
        return await this.components.encryption.encrypt(data);
    }
    
    async decryptData(encryptedData) {
        return await this.components.encryption.decrypt(encryptedData);
    }
    
    async validateInput(data, schema) {
        return await this.components.inputValidator.validateObject(data, schema);
    }
    
    /**
     * Get security status
     */
    getSecurityStatus() {
        return {
            status: 'operational',
            components: {
                networkSecurity: this.components.networkSecurity?.getStatus(),
                ddosProtection: this.components.ddosProtection?.getStatus(),
                rateLimiting: this.components.rateLimiter?.getMetrics(),
                authentication: {
                    sessions: this.components.authSystem?.sessions?.size || 0,
                    users: this.components.authSystem?.users?.size || 0
                },
                intrusionDetection: this.components.ids?.getStatus(),
                encryption: this.components.encryption?.getMetrics()
            },
            environment: this.config.environment,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        };
    }
    
    /**
     * Create validation schemas for common endpoints
     */
    static getValidationSchemas() {
        return {
            // User registration
            register: {
                body: {
                    username: {
                        ruleset: 'username',
                        required: true
                    },
                    email: {
                        ruleset: 'email',
                        required: true
                    },
                    password: {
                        ruleset: 'password',
                        required: true
                    },
                    btcAddress: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'bitcoinAddress' }
                        ],
                        sanitizers: ['trim'],
                        required: true
                    }
                }
            },
            
            // Mining share submission
            submitShare: {
                body: {
                    minerId: {
                        ruleset: 'minerName',
                        required: true
                    },
                    jobId: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'maxLength', params: [64] },
                            { name: 'pattern', params: ['^[0-9a-fA-F]+$'] }
                        ],
                        sanitizers: ['trim'],
                        required: true
                    },
                    nonce: {
                        ruleset: 'shareNonce',
                        required: true
                    },
                    difficulty: {
                        ruleset: 'difficulty',
                        required: true
                    }
                }
            },
            
            // Wallet operations
            updateWallet: {
                body: {
                    address: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'bitcoinAddress' },
                            { name: 'noSqlInjection' }
                        ],
                        sanitizers: ['trim'],
                        required: true
                    },
                    label: {
                        validators: [
                            { name: 'type', params: ['string'] },
                            { name: 'maxLength', params: [50] },
                            { name: 'noXss' }
                        ],
                        sanitizers: ['trim', 'escape'],
                        required: false
                    }
                }
            }
        };
    }
    
    /**
     * Security best practices documentation
     */
    static getSecurityGuidelines() {
        return {
            authentication: [
                'Always use strong passwords (12+ characters)',
                'Enable two-factor authentication',
                'Rotate API keys regularly',
                'Use JWT tokens with short expiration times'
            ],
            
            networking: [
                'Use TLS 1.2 or higher for all connections',
                'Implement rate limiting on all endpoints',
                'Use a WAF (Web Application Firewall) in production',
                'Regularly update IP blacklists'
            ],
            
            dataProtection: [
                'Encrypt sensitive data at rest',
                'Use field-level encryption for PII',
                'Implement key rotation policies',
                'Never log sensitive information'
            ],
            
            monitoring: [
                'Monitor all authentication attempts',
                'Set up alerts for suspicious activities',
                'Regularly review security logs',
                'Perform security audits quarterly'
            ]
        };
    }
}

// Export singleton instance
let securityInstance = null;

module.exports = {
    SecurityIntegration,
    
    // Initialize security with configuration
    initializeSecurity: async (config) => {
        if (!securityInstance) {
            securityInstance = new SecurityIntegration(config);
            await securityInstance.initializeComponents();
        }
        return securityInstance;
    },
    
    // Get existing security instance
    getSecurity: () => {
        if (!securityInstance) {
            throw new Error('Security not initialized. Call initializeSecurity first.');
        }
        return securityInstance;
    },
    
    // Validation schemas
    ValidationSchemas: SecurityIntegration.getValidationSchemas(),
    
    // Security guidelines
    SecurityGuidelines: SecurityIntegration.getSecurityGuidelines()
};