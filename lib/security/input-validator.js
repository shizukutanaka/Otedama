/**
 * Input Validation and Sanitization for Otedama
 * Comprehensive security validation
 * 
 * Design:
 * - Carmack: Fast validation without overhead
 * - Martin: Clean validation architecture
 * - Pike: Simple but thorough validation
 */

import { body, param, query, validationResult } from 'express-validator';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('InputValidator');

/**
 * Common validation patterns
 */
const patterns = {
  // Cryptocurrency addresses
  bitcoin: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  bitcoinBech32: /^bc1[a-z0-9]{39,59}$/,
  ethereum: /^0x[a-fA-F0-9]{40}$/,
  litecoin: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/,
  
  // Hashes
  sha256: /^[a-fA-F0-9]{64}$/,
  
  // General
  alphanumeric: /^[a-zA-Z0-9]+$/,
  hex: /^[a-fA-F0-9]+$/,
  base64: /^[A-Za-z0-9+/]+=*$/,
  
  // Security patterns (to reject)
  sqlInjection: /(\b(union|select|insert|update|delete|drop|create)\b.*\b(from|where|table)\b)|(--)|(;)|(\/\*)|(\*\/)/i,
  scriptTag: /<script[^>]*>[\s\S]*?<\/script>/gi,
  eventHandler: /on\w+\s*=/gi
};

/**
 * Validation rules for different endpoints
 */
export const validators = {
  // Wallet address validation
  walletAddress: param('address')
    .custom((value) => {
      // Check multiple address formats
      if (patterns.bitcoin.test(value) || 
          patterns.bitcoinBech32.test(value) ||
          patterns.ethereum.test(value) ||
          patterns.litecoin.test(value)) {
        return true;
      }
      throw new Error('Invalid wallet address');
    })
    .withMessage('Invalid wallet address format'),
  
  // Mining submission validation
  shareSubmission: [
    body('jobId')
      .isString()
      .isLength({ min: 8, max: 64 })
      .matches(patterns.hex)
      .withMessage('Invalid job ID'),
    
    body('nonce')
      .isString()
      .isLength({ min: 8, max: 16 })
      .matches(patterns.hex)
      .withMessage('Invalid nonce'),
    
    body('hash')
      .optional()
      .isString()
      .isLength({ min: 64, max: 64 })
      .matches(patterns.sha256)
      .withMessage('Invalid hash'),
    
    body('worker')
      .isString()
      .isLength({ min: 1, max: 64 })
      .matches(/^[a-zA-Z0-9._-]+$/)
      .withMessage('Invalid worker name'),
    
    body('address')
      .custom((value) => {
        if (patterns.bitcoin.test(value) || 
            patterns.bitcoinBech32.test(value) ||
            patterns.ethereum.test(value) ||
            patterns.litecoin.test(value)) {
          return true;
        }
        throw new Error('Invalid wallet address');
      })
      .withMessage('Invalid wallet address')
  ],
  
  // Payment amount validation
  amount: body('amount')
    .isFloat({ min: 0.00000001, max: 21000000 })
    .withMessage('Invalid amount'),
  
  // Fee validation
  fee: body('fee')
    .isFloat({ min: 0, max: 0.1 })
    .withMessage('Invalid fee (must be between 0 and 10%)'),
  
  // API key validation
  apiKey: body('apiKey')
    .isString()
    .isLength({ min: 32, max: 64 })
    .matches(patterns.hex)
    .withMessage('Invalid API key format'),
  
  // Pagination validation
  pagination: [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    
    query('limit')
      .optional()
      .isInt({ min: 1, max: 1000 })
      .withMessage('Limit must be between 1 and 1000')
  ],
  
  // Date range validation
  dateRange: [
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Invalid start date format'),
    
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('Invalid end date format')
      .custom((endDate, { req }) => {
        if (req.query.startDate && endDate) {
          return new Date(endDate) > new Date(req.query.startDate);
        }
        return true;
      })
      .withMessage('End date must be after start date')
  ],
  
  // Algorithm validation
  algorithm: body('algorithm')
    .isIn(['sha256', 'scrypt', 'ethash', 'randomx', 'kawpow'])
    .withMessage('Invalid mining algorithm'),
  
  // Payment scheme validation
  paymentScheme: body('scheme')
    .isIn(['PPLNS', 'PPS', 'PROP', 'SOLO', 'FPPS', 'PPLNT'])
    .withMessage('Invalid payment scheme')
};

/**
 * Sanitization middleware
 */
export function sanitizeInput(req, res, next) {
  // Function to recursively sanitize an object
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      // Remove null bytes
      let cleaned = obj.replace(/\0/g, '');
      
      // Remove potential script tags
      cleaned = cleaned.replace(patterns.scriptTag, '');
      
      // Remove event handlers
      cleaned = cleaned.replace(patterns.eventHandler, '');
      
      // Trim whitespace
      cleaned = cleaned.trim();
      
      return cleaned;
    } else if (Array.isArray(obj)) {
      return obj.map(sanitize);
    } else if (obj !== null && typeof obj === 'object') {
      const sanitized = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          // Sanitize the key
          const sanitizedKey = sanitize(key);
          // Sanitize the value
          sanitized[sanitizedKey] = sanitize(obj[key]);
        }
      }
      return sanitized;
    }
    
    return obj;
  };
  
  // Sanitize all input sources
  req.body = sanitize(req.body);
  req.query = sanitize(req.query);
  req.params = sanitize(req.params);
  
  next();
}

/**
 * SQL injection prevention middleware
 */
export function preventSQLInjection(req, res, next) {
  const checkValue = (value) => {
    if (typeof value === 'string' && patterns.sqlInjection.test(value)) {
      return true;
    }
    return false;
  };
  
  const check = (obj) => {
    if (typeof obj === 'string') {
      return checkValue(obj);
    } else if (Array.isArray(obj)) {
      return obj.some(check);
    } else if (obj !== null && typeof obj === 'object') {
      return Object.values(obj).some(check);
    }
    return false;
  };
  
  // Check all input sources
  if (check(req.body) || check(req.query) || check(req.params)) {
    logger.warn('SQL injection attempt detected', {
      ip: req.ip,
      path: req.path,
      method: req.method
    });
    
    return res.status(400).json({
      error: 'Invalid input detected'
    });
  }
  
  next();
}

/**
 * Validation error handler
 */
export function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const extractedErrors = errors.array().map(err => ({
      field: err.param,
      message: err.msg,
      value: err.value
    }));
    
    return res.status(422).json({
      error: 'Validation failed',
      errors: extractedErrors
    });
  }
  
  next();
}

/**
 * Custom validators
 */
export const customValidators = {
  /**
   * Validate cryptocurrency address
   */
  isCryptoAddress: (value, { req }) => {
    const type = req.body.type || 'bitcoin';
    
    switch (type) {
      case 'bitcoin':
        return patterns.bitcoin.test(value) || patterns.bitcoinBech32.test(value);
      case 'ethereum':
        return patterns.ethereum.test(value);
      case 'litecoin':
        return patterns.litecoin.test(value);
      default:
        return false;
    }
  },
  
  /**
   * Validate positive integer
   */
  isPositiveInteger: (value) => {
    const num = parseInt(value);
    return !isNaN(num) && num > 0 && num === parseFloat(value);
  },
  
  /**
   * Validate hash format
   */
  isValidHash: (value, { req }) => {
    const length = req.body.hashLength || 64;
    const pattern = new RegExp(`^[a-fA-F0-9]{${length}}$`);
    return pattern.test(value);
  },
  
  /**
   * Validate JSON
   */
  isValidJSON: (value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  },
  
  /**
   * Validate base64
   */
  isBase64: (value) => {
    return patterns.base64.test(value);
  },
  
  /**
   * Validate URL
   */
  isValidURL: (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  
  /**
   * Validate IP address
   */
  isIPAddress: (value) => {
    const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6 = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
    
    return ipv4.test(value) || ipv6.test(value);
  }
};

/**
 * Sanitization functions
 */
export const sanitizers = {
  /**
   * Escape HTML
   */
  escapeHTML: (str) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;'
    };
    
    return str.replace(/[&<>"'/]/g, (char) => map[char]);
  },
  
  /**
   * Remove non-alphanumeric
   */
  alphanumericOnly: (str) => {
    return str.replace(/[^a-zA-Z0-9]/g, '');
  },
  
  /**
   * Normalize whitespace
   */
  normalizeWhitespace: (str) => {
    return str.replace(/\s+/g, ' ').trim();
  },
  
  /**
   * Remove control characters
   */
  removeControlChars: (str) => {
    return str.replace(/[\x00-\x1F\x7F]/g, '');
  },
  
  /**
   * Sanitize filename
   */
  sanitizeFilename: (filename) => {
    return filename
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/^\.+/, '_')
      .substring(0, 255);
  }
};

// Export all components
export default {
  validators,
  sanitizeInput,
  preventSQLInjection,
  handleValidationErrors,
  customValidators,
  sanitizers,
  patterns
};