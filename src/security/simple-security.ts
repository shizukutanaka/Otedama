/**
 * Simple Security - Essential Protection
 * Design: Practical security without over-engineering (Carmack + Pike)
 */

import * as crypto from 'crypto';
import { createComponentLogger } from '../logging/simple-logger';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface SecurityEvent {
  type: 'rate_limit' | 'invalid_auth' | 'suspicious_activity';
  ip: string;
  timestamp: number;
  details?: any;
}

class SimpleRateLimit {
  private limits: Map<string, RateLimitEntry> = new Map();
  private logger = createComponentLogger('RateLimit');
  
  constructor(
    private maxRequests: number = 100,
    private windowMs: number = 60000 // 1 minute
  ) {}
  
  check(ip: string): boolean {
    const now = Date.now();
    const key = ip;
    
    // Clean expired entries
    this.cleanup();
    
    const entry = this.limits.get(key);
    
    if (!entry) {
      // First request from this IP
      this.limits.set(key, {
        count: 1,
        resetTime: now + this.windowMs
      });
      return true;
    }
    
    if (now > entry.resetTime) {
      // Reset window
      entry.count = 1;
      entry.resetTime = now + this.windowMs;
      return true;
    }
    
    if (entry.count >= this.maxRequests) {
      this.logger.warn('Rate limit exceeded', { ip, count: entry.count });
      return false;
    }
    
    entry.count++;
    return true;
  }
  
  private cleanup(): void {
    const now = Date.now();
    
    for (const [key, entry] of this.limits.entries()) {
      if (now > entry.resetTime) {
        this.limits.delete(key);
      }
    }
  }
  
  getStatus(ip: string): { allowed: boolean; remaining: number; resetTime: number } {
    const entry = this.limits.get(ip);
    
    if (!entry || Date.now() > entry.resetTime) {
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: Date.now() + this.windowMs
      };
    }
    
    return {
      allowed: entry.count < this.maxRequests,
      remaining: Math.max(0, this.maxRequests - entry.count),
      resetTime: entry.resetTime
    };
  }
}

class SimpleAuth {
  private validTokens: Set<string> = new Set();
  private logger = createComponentLogger('Auth');
  
  constructor() {
    // Generate initial admin token if not exists
    if (!process.env.ADMIN_TOKEN) {
      const adminToken = this.generateToken();
      console.log(`Generated admin token: ${adminToken}`);
      console.log('Set ADMIN_TOKEN environment variable for production');
    }
  }
  
  generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }
  
  validateToken(token: string): boolean {
    // Check admin token
    if (process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) {
      return true;
    }
    
    // Check valid tokens
    return this.validTokens.has(token);
  }
  
  createToken(): string {
    const token = this.generateToken();
    this.validTokens.add(token);
    this.logger.info('New token created');
    return token;
  }
  
  revokeToken(token: string): boolean {
    const revoked = this.validTokens.delete(token);
    if (revoked) {
      this.logger.info('Token revoked');
    }
    return revoked;
  }
  
  validateMinerAuth(minerId: string, password?: string): boolean {
    // Simple validation - in production, implement proper auth
    if (!minerId || minerId.length < 3) {
      return false;
    }
    
    // Basic format validation
    const minerIdRegex = /^[a-zA-Z0-9._-]+$/;
    return minerIdRegex.test(minerId);
  }
}

class SimpleInputValidator {
  private logger = createComponentLogger('InputValidator');
  
  // Validate miner ID
  validateMinerId(minerId: string): boolean {
    if (!minerId || typeof minerId !== 'string') {
      return false;
    }
    
    // Length check
    if (minerId.length < 3 || minerId.length > 64) {
      return false;
    }
    
    // Character check
    const validPattern = /^[a-zA-Z0-9._-]+$/;
    return validPattern.test(minerId);
  }
  
  // Validate nonce
  validateNonce(nonce: string): boolean {
    if (!nonce || typeof nonce !== 'string') {
      return false;
    }
    
    // Should be 8 hex characters
    const noncePattern = /^[a-fA-F0-9]{8}$/;
    return noncePattern.test(nonce);
  }
  
  // Validate extra nonce
  validateExtraNonce(extraNonce: string): boolean {
    if (!extraNonce || typeof extraNonce !== 'string') {
      return false;
    }
    
    // Should be hex string, reasonable length
    const extraNoncePattern = /^[a-fA-F0-9]{1,16}$/;
    return extraNoncePattern.test(extraNonce);
  }
  
  // Validate timestamp
  validateTimestamp(timestamp: string): boolean {
    if (!timestamp || typeof timestamp !== 'string') {
      return false;
    }
    
    const timePattern = /^[a-fA-F0-9]{8}$/;
    if (!timePattern.test(timestamp)) {
      return false;
    }
    
    // Convert to number and check range
    const time = parseInt(timestamp, 16);
    const now = Math.floor(Date.now() / 1000);
    const diff = Math.abs(now - time);
    
    // Allow 2 hours difference
    return diff < 7200;
  }
  
  // Sanitize JSON input
  sanitizeJson(input: string): any {
    try {
      const parsed = JSON.parse(input);
      
      // Limit depth to prevent attacks
      if (this.getObjectDepth(parsed) > 10) {
        throw new Error('Object depth too high');
      }
      
      // Limit size
      if (JSON.stringify(parsed).length > 10000) {
        throw new Error('Object size too large');
      }
      
      return parsed;
    } catch (error) {
      this.logger.warn('JSON sanitization failed', { error: (error as Error).message });
      throw new Error('Invalid JSON');
    }
  }
  
  private getObjectDepth(obj: any, depth: number = 0): number {
    if (depth > 20) return depth; // Prevent infinite recursion
    
    if (obj === null || typeof obj !== 'object') {
      return depth;
    }
    
    if (Array.isArray(obj)) {
      return Math.max(depth, ...obj.map(item => this.getObjectDepth(item, depth + 1)));
    }
    
    return Math.max(depth, ...Object.values(obj).map(value => this.getObjectDepth(value, depth + 1)));
  }
}

class SimpleSecurityMonitor {
  private events: SecurityEvent[] = [];
  private suspiciousIPs: Set<string> = new Set();
  private logger = createComponentLogger('SecurityMonitor');
  
  constructor(private maxEvents: number = 1000) {}
  
  recordEvent(event: SecurityEvent): void {
    this.events.push(event);
    
    // Keep only recent events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
    
    this.analyzeEvent(event);
  }
  
  private analyzeEvent(event: SecurityEvent): void {
    // Simple heuristics for suspicious activity
    const recentEvents = this.getRecentEvents(event.ip, 300000); // 5 minutes
    
    if (recentEvents.length > 50) {
      this.markSuspicious(event.ip, 'High event frequency');
    }
    
    if (event.type === 'rate_limit') {
      const rateLimitEvents = recentEvents.filter(e => e.type === 'rate_limit');
      if (rateLimitEvents.length > 5) {
        this.markSuspicious(event.ip, 'Repeated rate limiting');
      }
    }
    
    if (event.type === 'invalid_auth') {
      const authEvents = recentEvents.filter(e => e.type === 'invalid_auth');
      if (authEvents.length > 10) {
        this.markSuspicious(event.ip, 'Repeated auth failures');
      }
    }
  }
  
  private getRecentEvents(ip: string, timeWindow: number): SecurityEvent[] {
    const cutoff = Date.now() - timeWindow;
    return this.events.filter(event => 
      event.ip === ip && event.timestamp > cutoff
    );
  }
  
  private markSuspicious(ip: string, reason: string): void {
    if (!this.suspiciousIPs.has(ip)) {
      this.suspiciousIPs.add(ip);
      this.logger.warn('IP marked as suspicious', { ip, reason });
      
      // Auto-remove after 1 hour
      setTimeout(() => {
        this.suspiciousIPs.delete(ip);
        this.logger.info('IP removed from suspicious list', { ip });
      }, 3600000);
    }
  }
  
  isSuspicious(ip: string): boolean {
    return this.suspiciousIPs.has(ip);
  }
  
  getStats(): any {
    const now = Date.now();
    const hour = 3600000;
    
    const recentEvents = this.events.filter(e => now - e.timestamp < hour);
    const eventsByType = recentEvents.reduce((acc, event) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    return {
      totalEvents: this.events.length,
      recentEvents: recentEvents.length,
      eventsByType,
      suspiciousIPs: this.suspiciousIPs.size
    };
  }
}

class SimpleSecurity {
  private rateLimit: SimpleRateLimit;
  private auth: SimpleAuth;
  private validator: SimpleInputValidator;
  private monitor: SimpleSecurityMonitor;
  private logger = createComponentLogger('Security');
  
  constructor(
    rateLimitRequests: number = 100,
    rateLimitWindow: number = 60000
  ) {
    this.rateLimit = new SimpleRateLimit(rateLimitRequests, rateLimitWindow);
    this.auth = new SimpleAuth();
    this.validator = new SimpleInputValidator();
    this.monitor = new SimpleSecurityMonitor();
  }
  
  // Check if request is allowed
  checkRequest(ip: string): boolean {
    // Check if IP is suspicious
    if (this.monitor.isSuspicious(ip)) {
      this.monitor.recordEvent({
        type: 'suspicious_activity',
        ip,
        timestamp: Date.now(),
        details: { action: 'blocked_suspicious_ip' }
      });
      return false;
    }
    
    // Check rate limit
    if (!this.rateLimit.check(ip)) {
      this.monitor.recordEvent({
        type: 'rate_limit',
        ip,
        timestamp: Date.now()
      });
      return false;
    }
    
    return true;
  }
  
  // Validate miner authorization
  validateMiner(minerId: string, password?: string, ip?: string): boolean {
    const valid = this.auth.validateMinerAuth(minerId, password);
    
    if (!valid && ip) {
      this.monitor.recordEvent({
        type: 'invalid_auth',
        ip,
        timestamp: Date.now(),
        details: { minerId }
      });
    }
    
    return valid;
  }
  
  // Validate share submission
  validateShare(params: any, ip: string): boolean {
    try {
      const { worker, jobId, extraNonce2, time, nonce } = params;
      
      if (!this.validator.validateMinerId(worker)) {
        this.logger.warn('Invalid worker ID', { worker, ip });
        return false;
      }
      
      if (!this.validator.validateNonce(nonce)) {
        this.logger.warn('Invalid nonce', { nonce, ip });
        return false;
      }
      
      if (!this.validator.validateExtraNonce(extraNonce2)) {
        this.logger.warn('Invalid extra nonce', { extraNonce2, ip });
        return false;
      }
      
      if (!this.validator.validateTimestamp(time)) {
        this.logger.warn('Invalid timestamp', { time, ip });
        return false;
      }
      
      return true;
    } catch (error) {
      this.logger.warn('Share validation error', { error: (error as Error).message, ip });
      return false;
    }
  }
  
  // Sanitize input data
  sanitizeInput(input: string): any {
    return this.validator.sanitizeJson(input);
  }
  
  // Get rate limit status
  getRateLimitStatus(ip: string): any {
    return this.rateLimit.getStatus(ip);
  }
  
  // Token management
  createToken(): string {
    return this.auth.createToken();
  }
  
  validateToken(token: string): boolean {
    return this.auth.validateToken(token);
  }
  
  revokeToken(token: string): boolean {
    return this.auth.revokeToken(token);
  }
  
  // Get security statistics
  getStats(): any {
    return {
      rateLimit: {
        maxRequests: this.rateLimit['maxRequests'],
        windowMs: this.rateLimit['windowMs'],
        activeEntries: this.rateLimit['limits'].size
      },
      monitor: this.monitor.getStats()
    };
  }
}

// Singleton instance
let instance: SimpleSecurity | null = null;

export function getSecurity(rateLimitRequests?: number, rateLimitWindow?: number): SimpleSecurity {
  if (!instance) {
    instance = new SimpleSecurity(rateLimitRequests, rateLimitWindow);
  }
  return instance;
}

export { SimpleSecurity, SimpleRateLimit, SimpleAuth, SimpleInputValidator, SimpleSecurityMonitor };
