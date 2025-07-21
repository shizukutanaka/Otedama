/**
 * Security Hardening Module for Otedama
 * Implements automated security hardening measures
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { getErrorHandler } from '../error-handler.js';

// Hardening categories
export const HardeningCategory = {
  HEADERS: 'headers',
  ENCRYPTION: 'encryption',
  ACCESS_CONTROL: 'access_control',
  INPUT_VALIDATION: 'input_validation',
  AUTHENTICATION: 'authentication',
  LOGGING: 'logging',
  NETWORK: 'network',
  DEPENDENCIES: 'dependencies'
};

export class SecurityHardening extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Express app instance
      app: config.app,
      
      // Security headers
      headers: {
        enableHSTS: config.headers?.enableHSTS !== false,
        enableCSP: config.headers?.enableCSP !== false,
        enableXFrameOptions: config.headers?.enableXFrameOptions !== false,
        enableXContentTypeOptions: config.headers?.enableXContentTypeOptions !== false,
        enableReferrerPolicy: config.headers?.enableReferrerPolicy !== false,
        ...config.headers
      },
      
      // Rate limiting
      rateLimiting: {
        windowMs: config.rateLimiting?.windowMs || 15 * 60 * 1000, // 15 minutes
        max: config.rateLimiting?.max || 100,
        standardHeaders: true,
        legacyHeaders: false,
        ...config.rateLimiting
      },
      
      // Session security
      session: {
        secret: config.session?.secret || crypto.randomBytes(64).toString('hex'),
        secure: config.session?.secure !== false,
        httpOnly: config.session?.httpOnly !== false,
        sameSite: config.session?.sameSite || 'strict',
        maxAge: config.session?.maxAge || 3600000, // 1 hour
        ...config.session
      },
      
      // CORS configuration
      cors: {
        origin: config.cors?.origin || false,
        credentials: config.cors?.credentials !== false,
        optionsSuccessStatus: config.cors?.optionsSuccessStatus || 200,
        ...config.cors
      },
      
      // Auto-apply hardening
      autoApply: config.autoApply !== false
    };
    
    this.errorHandler = getErrorHandler();
    
    // Applied hardening measures
    this.applied = new Set();
    
    // Initialize if auto-apply is enabled
    if (this.config.autoApply && this.config.app) {
      this.applyAll();
    }
  }

  /**
   * Apply all hardening measures
   */
  async applyAll() {
    console.log('Applying security hardening measures...');
    
    try {
      // Apply in order of importance
      await this.applySecurityHeaders();
      await this.applyRateLimiting();
      await this.applySessionSecurity();
      await this.applyCORS();
      await this.applyInputValidation();
      await this.applyEncryption();
      await this.applyAccessControl();
      await this.applyLoggingSecurity();
      
      this.emit('hardening:completed', {
        applied: Array.from(this.applied),
        timestamp: new Date().toISOString()
      });
      
      console.log(`✅ Applied ${this.applied.size} hardening measures`);
      
      return {
        success: true,
        applied: Array.from(this.applied)
      };
      
    } catch (error) {
      this.emit('hardening:error', error);
      throw error;
    }
  }

  /**
   * Apply security headers
   */
  async applySecurityHeaders() {
    if (!this.config.app) return;
    
    console.log('Applying security headers...');
    
    const app = this.config.app;
    
    // Helmet middleware for security headers
    try {
      const helmet = await import('helmet');
      
      const helmetConfig = {
        contentSecurityPolicy: this.config.headers.enableCSP ? {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"]
          }
        } : false,
        hsts: this.config.headers.enableHSTS ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true
        } : false,
        frameguard: this.config.headers.enableXFrameOptions ? {
          action: 'deny'
        } : false,
        noSniff: this.config.headers.enableXContentTypeOptions,
        referrerPolicy: this.config.headers.enableReferrerPolicy ? {
          policy: 'same-origin'
        } : false
      };
      
      app.use(helmet.default(helmetConfig));
      
      this.applied.add('security-headers');
      this.emit('hardening:applied', {
        category: HardeningCategory.HEADERS,
        measures: ['helmet', 'csp', 'hsts', 'x-frame-options']
      });
      
    } catch (error) {
      console.warn('Helmet not available, applying manual headers');
      
      // Manual security headers
      app.use((req, res, next) => {
        if (this.config.headers.enableHSTS) {
          res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
        }
        
        if (this.config.headers.enableXFrameOptions) {
          res.setHeader('X-Frame-Options', 'DENY');
        }
        
        if (this.config.headers.enableXContentTypeOptions) {
          res.setHeader('X-Content-Type-Options', 'nosniff');
        }
        
        if (this.config.headers.enableReferrerPolicy) {
          res.setHeader('Referrer-Policy', 'same-origin');
        }
        
        // Remove sensitive headers
        res.removeHeader('X-Powered-By');
        res.removeHeader('Server');
        
        next();
      });
      
      this.applied.add('manual-security-headers');
    }
  }

  /**
   * Apply rate limiting
   */
  async applyRateLimiting() {
    if (!this.config.app) return;
    
    console.log('Applying rate limiting...');
    
    try {
      const rateLimit = await import('express-rate-limit');
      
      // General rate limiter
      const limiter = rateLimit.default(this.config.rateLimiting);
      
      // Apply to all routes
      this.config.app.use(limiter);
      
      // Stricter limits for auth routes
      const authLimiter = rateLimit.default({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 5, // 5 requests per window
        message: 'Too many authentication attempts, please try again later'
      });
      
      this.config.app.use('/api/auth', authLimiter);
      this.config.app.use('/api/login', authLimiter);
      this.config.app.use('/api/register', authLimiter);
      
      this.applied.add('rate-limiting');
      this.emit('hardening:applied', {
        category: HardeningCategory.NETWORK,
        measures: ['rate-limiting', 'auth-rate-limiting']
      });
      
    } catch (error) {
      console.warn('Rate limiting package not available');
    }
  }

  /**
   * Apply session security
   */
  async applySessionSecurity() {
    if (!this.config.app) return;
    
    console.log('Applying session security...');
    
    try {
      const session = await import('express-session');
      
      const sessionConfig = {
        secret: this.config.session.secret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          secure: this.config.session.secure,
          httpOnly: this.config.session.httpOnly,
          sameSite: this.config.session.sameSite,
          maxAge: this.config.session.maxAge
        },
        name: 'otedama.sid' // Custom session name
      };
      
      this.config.app.use(session.default(sessionConfig));
      
      this.applied.add('session-security');
      this.emit('hardening:applied', {
        category: HardeningCategory.AUTHENTICATION,
        measures: ['secure-sessions', 'httponly-cookies', 'samesite-cookies']
      });
      
    } catch (error) {
      console.warn('Session package not available');
    }
  }

  /**
   * Apply CORS configuration
   */
  async applyCORS() {
    if (!this.config.app) return;
    
    console.log('Applying CORS configuration...');
    
    try {
      const cors = await import('cors');
      
      const corsOptions = {
        origin: (origin, callback) => {
          // Check if origin is allowed
          if (!origin || this.isOriginAllowed(origin)) {
            callback(null, true);
          } else {
            callback(new Error('Not allowed by CORS'));
          }
        },
        credentials: this.config.cors.credentials,
        optionsSuccessStatus: this.config.cors.optionsSuccessStatus
      };
      
      this.config.app.use(cors.default(corsOptions));
      
      this.applied.add('cors');
      this.emit('hardening:applied', {
        category: HardeningCategory.NETWORK,
        measures: ['cors-policy']
      });
      
    } catch (error) {
      console.warn('CORS package not available');
      
      // Manual CORS implementation
      this.config.app.use((req, res, next) => {
        const origin = req.headers.origin;
        
        if (!origin || this.isOriginAllowed(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin || '*');
          res.setHeader('Access-Control-Allow-Credentials', 'true');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        }
        
        if (req.method === 'OPTIONS') {
          res.sendStatus(200);
        } else {
          next();
        }
      });
      
      this.applied.add('manual-cors');
    }
  }

  /**
   * Apply input validation
   */
  async applyInputValidation() {
    if (!this.config.app) return;
    
    console.log('Applying input validation...');
    
    // Size limits
    try {
      const express = await import('express');
      
      this.config.app.use(express.json({ limit: '10mb' }));
      this.config.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
      
    } catch (error) {
      // Express should be available
    }
    
    // SQL injection protection
    this.config.app.use((req, res, next) => {
      // Check all input for SQL injection patterns
      const sqlPatterns = [
        /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|CREATE|ALTER)\b)/gi,
        /(-{2}|\/\*|\*\/)/g, // SQL comments
        /(;|\||&&)/g // Command chaining
      ];
      
      const checkValue = (value) => {
        if (typeof value === 'string') {
          for (const pattern of sqlPatterns) {
            if (pattern.test(value)) {
              return true;
            }
          }
        }
        return false;
      };
      
      const checkObject = (obj) => {
        for (const key in obj) {
          const value = obj[key];
          if (checkValue(value)) {
            return true;
          }
          if (typeof value === 'object' && value !== null) {
            if (checkObject(value)) {
              return true;
            }
          }
        }
        return false;
      };
      
      if (checkObject(req.query) || checkObject(req.body) || checkObject(req.params)) {
        return res.status(400).json({
          error: 'Invalid input detected'
        });
      }
      
      next();
    });
    
    // XSS protection
    this.config.app.use((req, res, next) => {
      const sanitize = (obj) => {
        for (const key in obj) {
          if (typeof obj[key] === 'string') {
            // Basic HTML encoding
            obj[key] = obj[key]
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#x27;')
              .replace(/\//g, '&#x2F;');
          } else if (typeof obj[key] === 'object' && obj[key] !== null) {
            sanitize(obj[key]);
          }
        }
      };
      
      if (req.body) sanitize(req.body);
      if (req.query) sanitize(req.query);
      
      next();
    });
    
    this.applied.add('input-validation');
    this.emit('hardening:applied', {
      category: HardeningCategory.INPUT_VALIDATION,
      measures: ['sql-injection-protection', 'xss-protection', 'size-limits']
    });
  }

  /**
   * Apply encryption measures
   */
  async applyEncryption() {
    console.log('Applying encryption measures...');
    
    // Force HTTPS redirect
    if (this.config.app) {
      this.config.app.use((req, res, next) => {
        if (!req.secure && req.get('X-Forwarded-Proto') !== 'https' && process.env.NODE_ENV === 'production') {
          return res.redirect('https://' + req.get('Host') + req.url);
        }
        next();
      });
    }
    
    // Generate encryption keys if not present
    await this.generateEncryptionKeys();
    
    this.applied.add('encryption');
    this.emit('hardening:applied', {
      category: HardeningCategory.ENCRYPTION,
      measures: ['https-redirect', 'encryption-keys']
    });
  }

  /**
   * Apply access control
   */
  async applyAccessControl() {
    if (!this.config.app) return;
    
    console.log('Applying access control...');
    
    // Basic authentication for admin routes
    this.config.app.use('/admin', (req, res, next) => {
      // Check for admin authentication
      if (!req.session || !req.session.user || req.session.user.role !== 'admin') {
        return res.status(403).json({
          error: 'Access denied'
        });
      }
      next();
    });
    
    // API key validation for API routes
    this.config.app.use('/api', (req, res, next) => {
      const apiKey = req.headers['x-api-key'];
      
      // Skip auth check for public endpoints
      const publicEndpoints = ['/api/status', '/api/health'];
      if (publicEndpoints.includes(req.path)) {
        return next();
      }
      
      // Validate API key
      if (!apiKey || !this.validateAPIKey(apiKey)) {
        return res.status(401).json({
          error: 'Invalid API key'
        });
      }
      
      next();
    });
    
    this.applied.add('access-control');
    this.emit('hardening:applied', {
      category: HardeningCategory.ACCESS_CONTROL,
      measures: ['admin-protection', 'api-key-validation']
    });
  }

  /**
   * Apply logging security
   */
  async applyLoggingSecurity() {
    console.log('Applying logging security...');
    
    // Security event logging
    const securityLogger = {
      log: (event) => {
        const logEntry = {
          timestamp: new Date().toISOString(),
          type: 'SECURITY',
          ...event
        };
        
        // Log to file
        this.logSecurityEvent(logEntry);
        
        // Emit for monitoring
        this.emit('security:event', logEntry);
      }
    };
    
    // Log authentication attempts
    if (this.config.app) {
      this.config.app.use('/api/auth', (req, res, next) => {
        const originalSend = res.send;
        res.send = function(data) {
          const response = JSON.parse(data);
          securityLogger.log({
            event: 'authentication',
            success: res.statusCode === 200,
            ip: req.ip,
            userAgent: req.headers['user-agent']
          });
          originalSend.call(res, data);
        };
        next();
      });
    }
    
    this.applied.add('security-logging');
    this.emit('hardening:applied', {
      category: HardeningCategory.LOGGING,
      measures: ['security-event-logging', 'auth-logging']
    });
  }

  /**
   * Check if origin is allowed
   */
  isOriginAllowed(origin) {
    const allowed = this.config.cors.origin;
    
    if (!allowed || allowed === '*') {
      return true;
    }
    
    if (typeof allowed === 'string') {
      return origin === allowed;
    }
    
    if (Array.isArray(allowed)) {
      return allowed.includes(origin);
    }
    
    if (allowed instanceof RegExp) {
      return allowed.test(origin);
    }
    
    return false;
  }

  /**
   * Validate API key
   */
  validateAPIKey(apiKey) {
    // This would check against stored API keys
    // For now, simple validation
    return apiKey && apiKey.length >= 32;
  }

  /**
   * Generate encryption keys
   */
  async generateEncryptionKeys() {
    const keysDir = path.join(process.cwd(), '.keys');
    
    try {
      await fs.mkdir(keysDir, { recursive: true });
      
      // Check if keys exist
      const keyFiles = ['encryption.key', 'signing.key'];
      
      for (const keyFile of keyFiles) {
        const keyPath = path.join(keysDir, keyFile);
        
        try {
          await fs.access(keyPath);
        } catch {
          // Generate new key
          const key = crypto.randomBytes(32);
          await fs.writeFile(keyPath, key);
          await fs.chmod(keyPath, 0o600); // Read/write for owner only
        }
      }
      
    } catch (error) {
      console.warn('Could not generate encryption keys:', error.message);
    }
  }

  /**
   * Log security event
   */
  async logSecurityEvent(event) {
    const logsDir = path.join(process.cwd(), 'logs', 'security');
    
    try {
      await fs.mkdir(logsDir, { recursive: true });
      
      const logFile = path.join(logsDir, `security-${new Date().toISOString().split('T')[0]}.log`);
      const logEntry = JSON.stringify(event) + '\n';
      
      await fs.appendFile(logFile, logEntry);
      
    } catch (error) {
      console.warn('Could not write security log:', error.message);
    }
  }

  /**
   * Get hardening status
   */
  getStatus() {
    return {
      applied: Array.from(this.applied),
      total: this.applied.size,
      categories: {
        headers: this.applied.has('security-headers') || this.applied.has('manual-security-headers'),
        rateLimiting: this.applied.has('rate-limiting'),
        session: this.applied.has('session-security'),
        cors: this.applied.has('cors') || this.applied.has('manual-cors'),
        inputValidation: this.applied.has('input-validation'),
        encryption: this.applied.has('encryption'),
        accessControl: this.applied.has('access-control'),
        logging: this.applied.has('security-logging')
      }
    };
  }

  /**
   * Export hardening report
   */
  async exportReport(format = 'json', outputPath = './hardening-report.json') {
    const report = {
      timestamp: new Date().toISOString(),
      status: this.getStatus(),
      configuration: {
        headers: this.config.headers,
        rateLimiting: this.config.rateLimiting,
        session: {
          ...this.config.session,
          secret: '[REDACTED]'
        },
        cors: this.config.cors
      },
      recommendations: this.generateRecommendations()
    };
    
    if (format === 'json') {
      await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    } else if (format === 'markdown') {
      const markdown = this.generateMarkdownReport(report);
      await fs.writeFile(outputPath, markdown);
    }
    
    return outputPath;
  }

  /**
   * Generate recommendations
   */
  generateRecommendations() {
    const recommendations = [];
    const status = this.getStatus();
    
    if (!status.categories.headers) {
      recommendations.push('Enable security headers for protection against common attacks');
    }
    
    if (!status.categories.rateLimiting) {
      recommendations.push('Implement rate limiting to prevent abuse');
    }
    
    if (!status.categories.session) {
      recommendations.push('Configure secure session management');
    }
    
    if (!status.categories.inputValidation) {
      recommendations.push('Add comprehensive input validation');
    }
    
    // Additional recommendations
    recommendations.push(
      'Regularly update dependencies',
      'Implement security monitoring',
      'Conduct regular security audits',
      'Train developers on secure coding practices'
    );
    
    return recommendations;
  }

  /**
   * Generate markdown report
   */
  generateMarkdownReport(report) {
    return `# Security Hardening Report

Generated: ${report.timestamp}

## Status

Total hardening measures applied: ${report.status.total}

### Categories
- Security Headers: ${report.status.categories.headers ? '✅' : '❌'}
- Rate Limiting: ${report.status.categories.rateLimiting ? '✅' : '❌'}
- Session Security: ${report.status.categories.session ? '✅' : '❌'}
- CORS: ${report.status.categories.cors ? '✅' : '❌'}
- Input Validation: ${report.status.categories.inputValidation ? '✅' : '❌'}
- Encryption: ${report.status.categories.encryption ? '✅' : '❌'}
- Access Control: ${report.status.categories.accessControl ? '✅' : '❌'}
- Security Logging: ${report.status.categories.logging ? '✅' : '❌'}

## Applied Measures
${report.status.applied.map(m => `- ${m}`).join('\n')}

## Recommendations
${report.recommendations.map(r => `- ${r}`).join('\n')}
`;
  }
}

// Export factory function
export function createSecurityHardening(config) {
  return new SecurityHardening(config);
}

export default SecurityHardening;