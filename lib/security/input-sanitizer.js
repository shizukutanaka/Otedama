/**
 * Input Sanitizer for Enhanced Security
 * Validates and sanitizes all user inputs
 * 
 * Design: Secure by default (Martin principle)
 */

import { ValidationError } from '../core/error-handler-unified.js';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('InputSanitizer');

/**
 * Input validation rules
 */
const ValidationRules = {
  // Wallet address patterns
  walletAddress: {
    BTC: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
    ETH: /^0x[a-fA-F0-9]{40}$/,
    XMR: /^[48][0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/
  },
  
  // Mining related
  workerName: /^[a-zA-Z0-9_-]{1,64}$/,
  minerAgent: /^[a-zA-Z0-9\s\/\._-]{1,128}$/,
  
  // Network related
  ipAddress: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
  port: /^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/,
  
  // General
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  alphanumeric: /^[a-zA-Z0-9]+$/,
  hex: /^[0-9a-fA-F]+$/
};

/**
 * Input Sanitizer Class
 */
export class InputSanitizer {
  constructor(options = {}) {
    this.strict = options.strict !== false;
    this.maxStringLength = options.maxStringLength || 1024;
    this.allowedTags = options.allowedTags || [];
    
    // SQL injection patterns
    this.sqlPatterns = [
      /(\b(ALTER|CREATE|DELETE|DROP|EXEC(UTE)?|INSERT|SELECT|UNION|UPDATE)\b)/gi,
      /(--[^\r\n]*|\/\*[\w\W]*?\*\/)/g,
      /(\b(OR|AND)\b\s*\d+\s*=\s*\d+)/gi
    ];
    
    // XSS patterns
    this.xssPatterns = [
      /<script[^>]*>[\s\S]*?<\/script>/gi,
      /javascript:/gi,
      /on\w+\s*=/gi,
      /<iframe[^>]*>/gi
    ];
    
    // Path traversal patterns
    this.pathPatterns = [
      /\.\.\//g,
      /\.\.%2F/gi,
      /%2e%2e/gi
    ];
  }
  
  /**
   * Validate wallet address
   */
  validateWalletAddress(address, currency = 'BTC') {
    if (!address || typeof address !== 'string') {
      throw new ValidationError('Invalid wallet address format');
    }
    
    // Remove whitespace
    address = address.trim();
    
    // Check length
    if (address.length > 128) {
      throw new ValidationError('Wallet address too long');
    }
    
    // Validate format
    const pattern = ValidationRules.walletAddress[currency];
    if (!pattern) {
      throw new ValidationError(`Unsupported currency: ${currency}`);
    }
    
    if (!pattern.test(address)) {
      throw new ValidationError(`Invalid ${currency} wallet address`);
    }
    
    return address;
  }
  
  /**
   * Validate worker name
   */
  validateWorkerName(name) {
    if (!name || typeof name !== 'string') {
      return 'default';
    }
    
    name = name.trim();
    
    if (!ValidationRules.workerName.test(name)) {
      throw new ValidationError('Invalid worker name. Use only letters, numbers, underscore and hyphen');
    }
    
    return name;
  }
  
  /**
   * Validate and sanitize string input
   */
  sanitizeString(input, options = {}) {
    if (!input || typeof input !== 'string') {
      return '';
    }
    
    // Trim and limit length
    input = input.trim().substring(0, options.maxLength || this.maxStringLength);
    
    // Remove null bytes
    input = input.replace(/\0/g, '');
    
    // Check for SQL injection
    if (this.strict) {
      for (const pattern of this.sqlPatterns) {
        if (pattern.test(input)) {
          logger.warn('SQL injection pattern detected', { input });
          throw new ValidationError('Invalid input detected');
        }
      }
    }
    
    // Check for XSS
    for (const pattern of this.xssPatterns) {
      if (pattern.test(input)) {
        logger.warn('XSS pattern detected', { input });
        throw new ValidationError('Invalid input detected');
      }
    }
    
    // Escape HTML if needed
    if (options.escapeHtml !== false) {
      input = this.escapeHtml(input);
    }
    
    return input;
  }
  
  /**
   * Validate numeric input
   */
  validateNumber(input, options = {}) {
    const {
      min = Number.MIN_SAFE_INTEGER,
      max = Number.MAX_SAFE_INTEGER,
      integer = false
    } = options;
    
    const num = Number(input);
    
    if (isNaN(num)) {
      throw new ValidationError('Invalid number');
    }
    
    if (num < min || num > max) {
      throw new ValidationError(`Number must be between ${min} and ${max}`);
    }
    
    if (integer && !Number.isInteger(num)) {
      throw new ValidationError('Number must be an integer');
    }
    
    return num;
  }
  
  /**
   * Validate hex string
   */
  validateHex(input, expectedLength = null) {
    if (!input || typeof input !== 'string') {
      throw new ValidationError('Invalid hex string');
    }
    
    input = input.toLowerCase().replace(/^0x/, '');
    
    if (!ValidationRules.hex.test(input)) {
      throw new ValidationError('Invalid hex characters');
    }
    
    if (expectedLength && input.length !== expectedLength) {
      throw new ValidationError(`Hex string must be ${expectedLength} characters`);
    }
    
    return input;
  }
  
  /**
   * Validate IP address
   */
  validateIPAddress(ip) {
    if (!ip || typeof ip !== 'string') {
      throw new ValidationError('Invalid IP address');
    }
    
    // Support IPv4 for now
    if (!ValidationRules.ipAddress.test(ip)) {
      throw new ValidationError('Invalid IPv4 address format');
    }
    
    return ip;
  }
  
  /**
   * Validate file path (prevent directory traversal)
   */
  validateFilePath(path) {
    if (!path || typeof path !== 'string') {
      throw new ValidationError('Invalid file path');
    }
    
    // Check for path traversal attempts
    for (const pattern of this.pathPatterns) {
      if (pattern.test(path)) {
        logger.warn('Path traversal attempt detected', { path });
        throw new ValidationError('Invalid file path');
      }
    }
    
    // Remove any potentially dangerous characters
    path = path.replace(/[<>:"|?*]/g, '');
    
    return path;
  }
  
  /**
   * Sanitize JSON input
   */
  sanitizeJSON(input) {
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch (error) {
        throw new ValidationError('Invalid JSON');
      }
    }
    
    // Recursively sanitize object
    return this.sanitizeObject(input);
  }
  
  /**
   * Recursively sanitize object
   */
  sanitizeObject(obj, depth = 0) {
    if (depth > 10) {
      throw new ValidationError('Object too deeply nested');
    }
    
    if (obj === null || obj === undefined) {
      return obj;
    }
    
    if (typeof obj === 'string') {
      return this.sanitizeString(obj);
    }
    
    if (typeof obj === 'number') {
      return this.validateNumber(obj);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item, depth + 1));
    }
    
    if (typeof obj === 'object') {
      const sanitized = {};
      for (const [key, value] of Object.entries(obj)) {
        const sanitizedKey = this.sanitizeString(key, { maxLength: 256 });
        sanitized[sanitizedKey] = this.sanitizeObject(value, depth + 1);
      }
      return sanitized;
    }
    
    return obj;
  }
  
  /**
   * Escape HTML characters
   */
  escapeHtml(str) {
    const htmlEscapes = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    
    return str.replace(/[&<>"']/g, char => htmlEscapes[char]);
  }
  
  /**
   * Validate mining share submission
   */
  validateShareSubmission(share) {
    const validated = {};
    
    // Validate nonce
    validated.nonce = this.validateNumber(share.nonce, {
      min: 0,
      max: 0xFFFFFFFF,
      integer: true
    });
    
    // Validate nTime
    validated.nTime = this.validateNumber(share.nTime, {
      min: Date.now() / 1000 - 7200, // 2 hours past
      max: Date.now() / 1000 + 7200, // 2 hours future
      integer: true
    });
    
    // Validate extraNonce2
    if (share.extraNonce2) {
      validated.extraNonce2 = this.validateHex(share.extraNonce2);
    }
    
    // Validate job ID
    if (share.jobId) {
      validated.jobId = this.sanitizeString(share.jobId, {
        maxLength: 64
      });
    }
    
    return validated;
  }
  
  /**
   * Create middleware for Express
   */
  middleware() {
    return (req, res, next) => {
      try {
        // Sanitize query parameters
        if (req.query) {
          req.query = this.sanitizeObject(req.query);
        }
        
        // Sanitize body
        if (req.body) {
          req.body = this.sanitizeObject(req.body);
        }
        
        // Sanitize params
        if (req.params) {
          req.params = this.sanitizeObject(req.params);
        }
        
        next();
      } catch (error) {
        logger.error('Input validation failed', { error: error.message });
        res.status(400).json({
          error: 'Invalid input',
          message: error.message
        });
      }
    };
  }
}

// Singleton instance
export const inputSanitizer = new InputSanitizer();

export default InputSanitizer;