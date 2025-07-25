/**
 * Security Module - Otedama
 * Consolidated security functionality
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('Security');

export class SecurityManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      enableDDoSProtection: options.enableDDoSProtection !== false,
      enableEncryption: options.enableEncryption !== false,
      banDuration: options.banDuration || 3600000,
      maxRequestsPerMinute: options.maxRequestsPerMinute || 100
    };
    
    this.threats = new Map();
    this.bans = new Map();
  }
  
  async initialize() {
    logger.info('Security manager initialized');
    this.emit('initialized');
  }
  
  async shutdown() {
    this.threats.clear();
    this.bans.clear();
    logger.info('Security manager shutdown');
  }
  
  checkThreat(request) {
    // Simple threat detection
    const ip = request.ip || request.address;
    
    if (this.bans.has(ip)) {
      return { blocked: true, reason: 'banned' };
    }
    
    // Rate limiting
    const key = `rate:${ip}`;
    const count = this.threats.get(key) || 0;
    
    if (count > this.config.maxRequestsPerMinute) {
      this.ban(ip, 'Rate limit exceeded');
      return { blocked: true, reason: 'rate_limit' };
    }
    
    this.threats.set(key, count + 1);
    
    // Reset counter after 1 minute
    setTimeout(() => {
      this.threats.delete(key);
    }, 60000);
    
    return { blocked: false };
  }
  
  ban(ip, reason) {
    this.bans.set(ip, {
      reason,
      timestamp: Date.now(),
      expires: Date.now() + this.config.banDuration
    });
    
    this.emit('threat:detected', {
      type: 'ban',
      source: ip,
      reason
    });
    
    // Auto-unban after duration
    setTimeout(() => {
      this.bans.delete(ip);
    }, this.config.banDuration);
  }
  
  getStats() {
    return {
      threats: this.threats.size,
      bans: this.bans.size,
      config: this.config
    };
  }
}

export default SecurityManager;
