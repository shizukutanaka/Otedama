/**
 * Storage Utilities - Otedama
 * Helper functions for storage operations
 */

import crypto from 'crypto';

export class StorageUtils {
  /**
   * Generate a unique ID
   */
  static generateId(prefix = '') {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return prefix ? `${prefix}_${timestamp}_${random}` : `${timestamp}_${random}`;
  }
  
  /**
   * Calculate hash of data
   */
  static hash(data, algorithm = 'sha256') {
    const hash = crypto.createHash(algorithm);
    
    if (typeof data === 'object') {
      hash.update(JSON.stringify(data));
    } else {
      hash.update(String(data));
    }
    
    return hash.digest('hex');
  }
  
  /**
   * Format bytes for display
   */
  static formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }
  
  /**
   * Parse duration string to milliseconds
   */
  static parseDuration(duration) {
    if (typeof duration === 'number') return duration;
    
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) throw new Error(`Invalid duration: ${duration}`);
    
    const [, value, unit] = match;
    const multipliers = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };
    
    return parseInt(value) * multipliers[unit];
  }
  
  /**
   * Create TTL timestamp
   */
  static createTTL(duration) {
    if (!duration || duration <= 0) return null;
    return Date.now() + duration;
  }
  
  /**
   * Check if TTL has expired
   */
  static isExpired(ttl) {
    if (!ttl) return false;
    return Date.now() > ttl;
  }
  
  /**
   * Safe JSON parse
   */
  static safeJsonParse(data, defaultValue = null) {
    try {
      return JSON.parse(data);
    } catch {
      return defaultValue;
    }
  }
  
  /**
   * Safe JSON stringify
   */
  static safeJsonStringify(data, pretty = false) {
    try {
      return JSON.stringify(data, null, pretty ? 2 : 0);
    } catch {
      return '{}';
    }
  }
  
  /**
   * Batch operations helper
   */
  static async batchProcess(items, processor, batchSize = 100) {
    const results = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(item => processor(item))
      );
      results.push(...batchResults);
    }
    
    return results;
  }
  
  /**
   * Retry operation with exponential backoff
   */
  static async retry(operation, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const baseDelay = options.baseDelay || 1000;
    const maxDelay = options.maxDelay || 10000;
    
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        
        if (i < maxRetries - 1) {
          const delay = Math.min(baseDelay * Math.pow(2, i), maxDelay);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }
  
  /**
   * Debounce function
   */
  static debounce(func, wait) {
    let timeout;
    
    return function(...args) {
      const context = this;
      
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        func.apply(context, args);
      }, wait);
    };
  }
  
  /**
   * Throttle function
   */
  static throttle(func, limit) {
    let inThrottle;
    
    return function(...args) {
      const context = this;
      
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        
        setTimeout(() => {
          inThrottle = false;
        }, limit);
      }
    };
  }
}

export default StorageUtils;
