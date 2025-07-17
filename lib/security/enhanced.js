/**
 * Enhanced Security Module for Otedama
 * Provides advanced security features
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { EventEmitter } from 'events';

export class SecurityEnhanced extends EventEmitter {
  constructor(options = {}) {
    super();
    this.encryptionKey = options.encryptionKey || this.generateKey();
    this.ddosProtection = new Map();
    this.honeypots = new Set(options.honeypots || [
      '/admin.php',
      '/wp-admin',
      '/.env',
      '/config.json',
      '/backup.sql'
    ]);
    this.securityMetrics = {
      blockedRequests: 0,
      encryptedData: 0,
      decryptedData: 0,
      honeypotHits: 0,
      sqlInjectionAttempts: 0,
      xssAttempts: 0
    };
    this.auditLog = [];
  }

  /**
   * Generate encryption key
   */
  generateKey() {
    return randomBytes(32);
  }

  /**
   * Encrypt sensitive data
   */
  encrypt(data) {
    try {
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(data), 'utf8'),
        cipher.final()
      ]);
      
      const authTag = cipher.getAuthTag();
      
      this.securityMetrics.encryptedData++;
      
      return {
        encrypted: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64')
      };
    } catch (error) {
      this.emit('error', { type: 'encryption', error });
      throw error;
    }
  }

  /**
   * Decrypt sensitive data
   */
  decrypt(encryptedData) {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(encryptedData.iv, 'base64')
      );
      
      decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'base64'));
      
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedData.encrypted, 'base64')),
        decipher.final()
      ]);
      
      this.securityMetrics.decryptedData++;
      
      return JSON.parse(decrypted.toString('utf8'));
    } catch (error) {
      this.emit('error', { type: 'decryption', error });
      throw error;
    }
  }

  /**
   * Advanced DDoS protection
   */
  checkDDoS(ip, options = {}) {
    const now = Date.now();
    const windowMs = options.windowMs || 60000; // 1 minute
    const maxRequests = options.maxRequests || 100;
    const blockDuration = options.blockDuration || 300000; // 5 minutes
    
    if (!this.ddosProtection.has(ip)) {
      this.ddosProtection.set(ip, {
        requests: [],
        blocked: false,
        blockUntil: 0
      });
    }
    
    const ipData = this.ddosProtection.get(ip);
    
    // Check if IP is currently blocked
    if (ipData.blocked && now < ipData.blockUntil) {
      this.securityMetrics.blockedRequests++;
      return {
        allowed: false,
        reason: 'DDoS protection',
        blockUntil: ipData.blockUntil
      };
    }
    
    // Remove old requests outside the window
    ipData.requests = ipData.requests.filter(timestamp => 
      now - timestamp < windowMs
    );
    
    // Add current request
    ipData.requests.push(now);
    
    // Check if limit exceeded
    if (ipData.requests.length > maxRequests) {
      ipData.blocked = true;
      ipData.blockUntil = now + blockDuration;
      this.securityMetrics.blockedRequests++;
      
      this.emit('ddos-detected', {
        ip,
        requests: ipData.requests.length,
        blockUntil: ipData.blockUntil
      });
      
      return {
        allowed: false,
        reason: 'Rate limit exceeded',
        blockUntil: ipData.blockUntil
      };
    }
    
    return { allowed: true };
  }

  /**
   * Enhanced SQL injection prevention
   */
  preventSQLInjection(input) {
    if (typeof input !== 'string') return input;
    
    const dangerousPatterns = [
      /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b)/gi,
      /(--|\||;|\/\*|\*\/|xp_|sp_)/g,
      /(\b(and|or)\b\s*\d+\s*=\s*\d+)/gi,
      /(\b(having|group by|order by)\b)/gi,
      /(concat|char|ascii|substring|length|hex)/gi
    ];
    
    let cleaned = input;
    let injectionDetected = false;
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(cleaned)) {
        injectionDetected = true;
        cleaned = cleaned.replace(pattern, '');
      }
    }
    
    if (injectionDetected) {
      this.securityMetrics.sqlInjectionAttempts++;
      this.emit('sql-injection-attempt', { original: input, cleaned });
    }
    
    return cleaned;
  }

  /**
   * Enhanced XSS prevention
   */
  preventXSS(input, context = 'html') {
    if (typeof input !== 'string') return input;
    
    let cleaned = input;
    
    switch (context) {
      case 'html':
        cleaned = input
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#x27;')
          .replace(/\//g, '&#x2F;');
        break;
        
      case 'attribute':
        cleaned = input
          .replace(/[^a-zA-Z0-9-_]/g, '');
        break;
        
      case 'javascript':
        cleaned = JSON.stringify(input).slice(1, -1);
        break;
        
      case 'url':
        cleaned = encodeURIComponent(input);
        break;
    }
    
    if (cleaned !== input) {
      this.securityMetrics.xssAttempts++;
      this.emit('xss-attempt', { original: input, cleaned, context });
    }
    
    return cleaned;
  }

  /**
   * Honeypot detection
   */
  checkHoneypot(path) {
    if (this.honeypots.has(path)) {
      this.securityMetrics.honeypotHits++;
      this.emit('honeypot-accessed', { path, timestamp: Date.now() });
      return true;
    }
    return false;
  }

  /**
   * Request integrity check
   */
  verifyRequestIntegrity(request, signature, secret) {
    const payload = JSON.stringify({
      method: request.method,
      path: request.path,
      body: request.body,
      timestamp: request.timestamp
    });
    
    const expectedSignature = createHash('sha256')
      .update(payload + secret)
      .digest('hex');
    
    return signature === expectedSignature;
  }

  /**
   * Generate secure token
   */
  generateSecureToken(length = 32) {
    return randomBytes(length).toString('base64url');
  }

  /**
   * Hash sensitive data
   */
  hashData(data, salt = '') {
    return createHash('sha256')
      .update(data + salt)
      .digest('hex');
  }

  /**
   * Verify hashed data
   */
  verifyHash(data, hash, salt = '') {
    const expectedHash = this.hashData(data, salt);
    return hash === expectedHash;
  }

  /**
   * Get security metrics
   */
  getMetrics() {
    return {
      ...this.securityMetrics,
      timestamp: Date.now()
    };
  }

  /**
   * Reset security metrics
   */
  resetMetrics() {
    this.securityMetrics = {
      blockedRequests: 0,
      encryptedData: 0,
      decryptedData: 0,
      honeypotHits: 0,
      sqlInjectionAttempts: 0,
      xssAttempts: 0
    };
  }

  /**
   * Add audit log entry
   */
  addAuditEntry(entry) {
    this.auditLog.push({
      timestamp: Date.now(),
      ...entry
    });
    
    // Keep only last 10000 entries
    if (this.auditLog.length > 10000) {
      this.auditLog = this.auditLog.slice(-10000);
    }
    
    this.emit('audit-entry', entry);
  }

  /**
   * Get audit log
   */
  getAuditLog(filters = {}) {
    let logs = [...this.auditLog];
    
    if (filters.startTime) {
      logs = logs.filter(entry => entry.timestamp >= filters.startTime);
    }
    
    if (filters.endTime) {
      logs = logs.filter(entry => entry.timestamp <= filters.endTime);
    }
    
    if (filters.type) {
      logs = logs.filter(entry => entry.type === filters.type);
    }
    
    if (filters.userId) {
      logs = logs.filter(entry => entry.userId === filters.userId);
    }
    
    return logs;
  }
}