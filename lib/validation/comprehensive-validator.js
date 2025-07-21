/**
 * Comprehensive Input Validation System
 * Provides secure, fast, and thorough validation for all user inputs
 */

import { timingSafeEqual } from 'crypto';
import { getLogger } from '../core/logger.js';

const logger = getLogger('ComprehensiveValidator');

// Validation error types
export const ValidationErrorType = {
  REQUIRED: 'required',
  TYPE: 'type',
  FORMAT: 'format',
  RANGE: 'range',
  LENGTH: 'length',
  SECURITY: 'security',
  BUSINESS_RULE: 'business_rule'
};

// Common regex patterns (compiled once for performance)
const PATTERNS = {
  email: /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
  username: /^[a-zA-Z0-9_-]{3,32}$/,
  password: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
  hexColor: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
  ipv6: /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/,
  
  // Cryptocurrency addresses
  btc: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
  eth: /^0x[a-fA-F0-9]{40}$/,
  ltc: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$|^ltc1[a-z0-9]{39,59}$/,
  
  // SQL Injection patterns (for security validation)
  sqlInjection: /('|(\\)|;|--|\/\*|\*\/|xp_|sp_|union|select|insert|update|delete|drop|create|alter|exec|execute)/gi,
  
  // XSS patterns
  xss: /(<script|<iframe|<object|<embed|<form|javascript:|data:|vbscript:|about:|onload=|onerror=|onmouseover=)/gi,
  
  // Path traversal
  pathTraversal: /(\.\.\/|\.\.\\|\.\.\%2f|\.\.\%5c)/gi
};

// Cryptocurrency address validators
const CRYPTO_VALIDATORS = {
  BTC: {
    pattern: PATTERNS.btc,
    minLength: 26,
    maxLength: 62
  },
  ETH: {
    pattern: PATTERNS.eth,
    minLength: 42,
    maxLength: 42
  },
  LTC: {
    pattern: PATTERNS.ltc,
    minLength: 26,
    maxLength: 62
  },
  XMR: {
    pattern: /^4[0-9AB][0-9a-zA-Z]{93}$/,
    minLength: 95,
    maxLength: 95
  },
  DOGE: {
    pattern: /^D{1}[5-9A-HJ-NP-U]{1}[1-9A-HJ-NP-Za-km-z]{32}$/,
    minLength: 34,
    maxLength: 34
  }
};

/**
 * Validation Error class
 */
export class ValidationError extends Error {
  constructor(field, type, message, value = null) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.type = type;
    this.value = value;
    this.timestamp = Date.now();
  }
}

/**
 * Validation Result class
 */
export class ValidationResult {
  constructor() {
    this.valid = true;
    this.errors = [];
    this.warnings = [];
  }

  addError(field, type, message, value = null) {
    this.valid = false;
    this.errors.push(new ValidationError(field, type, message, value));
  }

  addWarning(field, message) {
    this.warnings.push({ field, message });
  }

  hasErrors() {
    return this.errors.length > 0;
  }

  getFirstError() {
    return this.errors[0] || null;
  }

  getFieldErrors(field) {
    return this.errors.filter(error => error.field === field);
  }
}

/**
 * Comprehensive Validator class
 */
export class ComprehensiveValidator {
  constructor(options = {}) {
    this.options = {
      enableSecurityValidation: options.enableSecurityValidation !== false,
      enableTimingSafeComparison: options.enableTimingSafeComparison !== false,
      maxStringLength: options.maxStringLength || 10000,
      maxArrayLength: options.maxArrayLength || 1000,
      maxObjectDepth: options.maxObjectDepth || 10,
      ...options
    };

    // Performance tracking
    this.stats = {
      validations: 0,
      errors: 0,
      securityIssues: 0,
      averageTime: 0
    };
  }

  /**
   * Validate a single value with comprehensive checks
   */
  validateValue(value, rules, fieldName = 'field') {
    const startTime = process.hrtime.bigint();
    const result = new ValidationResult();

    try {
      // Required check
      if (rules.required && (value === null || value === undefined || value === '')) {
        result.addError(fieldName, ValidationErrorType.REQUIRED, `${fieldName} is required`);
        return result;
      }

      // Skip other validations if not required and empty
      if (!rules.required && (value === null || value === undefined || value === '')) {
        return result;
      }

      // Type validation
      if (rules.type) {
        this.validateType(value, rules.type, fieldName, result);
      }

      // String validations
      if (typeof value === 'string') {
        this.validateString(value, rules, fieldName, result);
      }

      // Numeric validations
      if (typeof value === 'number') {
        this.validateNumber(value, rules, fieldName, result);
      }

      // Array validations
      if (Array.isArray(value)) {
        this.validateArray(value, rules, fieldName, result);
      }

      // Object validations
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        this.validateObject(value, rules, fieldName, result);
      }

      // Custom validation function
      if (rules.custom && typeof rules.custom === 'function') {
        const customResult = rules.custom(value, fieldName);
        if (customResult !== true) {
          result.addError(fieldName, ValidationErrorType.BUSINESS_RULE, 
            customResult || `${fieldName} failed custom validation`);
        }
      }

      // Security validation
      if (this.options.enableSecurityValidation) {
        this.validateSecurity(value, fieldName, result);
      }

    } catch (error) {
      logger.error('Validation error:', error);
      result.addError(fieldName, ValidationErrorType.TYPE, 'Validation processing error');
    } finally {
      // Update performance stats
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
      this.updateStats(duration, result.hasErrors());
    }

    return result;
  }

  /**
   * Validate an object with multiple fields
   */
  validateObject(obj, schema, result = new ValidationResult()) {
    if (typeof obj !== 'object' || obj === null) {
      result.addError('root', ValidationErrorType.TYPE, 'Expected object');
      return result;
    }

    // Check object depth to prevent DoS
    if (this.getObjectDepth(obj) > this.options.maxObjectDepth) {
      result.addError('root', ValidationErrorType.SECURITY, 'Object nesting too deep');
      return result;
    }

    // Validate each field in schema
    for (const [fieldName, rules] of Object.entries(schema)) {
      const value = obj[fieldName];
      const fieldResult = this.validateValue(value, rules, fieldName);
      
      // Merge results
      result.errors.push(...fieldResult.errors);
      result.warnings.push(...fieldResult.warnings);
      if (fieldResult.hasErrors()) {
        result.valid = false;
      }
    }

    // Check for unexpected fields if strictMode is enabled
    if (schema._strictMode) {
      const allowedFields = Object.keys(schema).filter(key => !key.startsWith('_'));
      const actualFields = Object.keys(obj);
      const unexpectedFields = actualFields.filter(field => !allowedFields.includes(field));
      
      if (unexpectedFields.length > 0) {
        result.addError('root', ValidationErrorType.BUSINESS_RULE, 
          `Unexpected fields: ${unexpectedFields.join(', ')}`);
      }
    }

    return result;
  }

  /**
   * Type validation
   */
  validateType(value, expectedType, fieldName, result) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    
    if (expectedType === 'number' && typeof value === 'string' && !isNaN(Number(value))) {
      // Allow string numbers that can be converted
      return;
    }

    if (actualType !== expectedType) {
      result.addError(fieldName, ValidationErrorType.TYPE, 
        `Expected ${expectedType}, got ${actualType}`);
    }
  }

  /**
   * String validation
   */
  validateString(value, rules, fieldName, result) {
    // Length validation
    if (rules.minLength && value.length < rules.minLength) {
      result.addError(fieldName, ValidationErrorType.LENGTH, 
        `${fieldName} must be at least ${rules.minLength} characters`);
    }

    if (rules.maxLength && value.length > rules.maxLength) {
      result.addError(fieldName, ValidationErrorType.LENGTH, 
        `${fieldName} must be at most ${rules.maxLength} characters`);
    }

    // Global max length check
    if (value.length > this.options.maxStringLength) {
      result.addError(fieldName, ValidationErrorType.SECURITY, 
        'String too long - potential DoS attack');
    }

    // Pattern validation
    if (rules.pattern) {
      const pattern = typeof rules.pattern === 'string' ? new RegExp(rules.pattern) : rules.pattern;
      if (!pattern.test(value)) {
        result.addError(fieldName, ValidationErrorType.FORMAT, 
          rules.patternMessage || `${fieldName} format is invalid`);
      }
    }

    // Predefined format validation
    if (rules.format) {
      this.validateFormat(value, rules.format, fieldName, result);
    }

    // Enum validation
    if (rules.enum && !rules.enum.includes(value)) {
      result.addError(fieldName, ValidationErrorType.RANGE, 
        `${fieldName} must be one of: ${rules.enum.join(', ')}`);
    }

    // Cryptocurrency address validation
    if (rules.cryptoAddress) {
      this.validateCryptoAddress(value, rules.cryptoAddress, fieldName, result);
    }
  }

  /**
   * Number validation
   */
  validateNumber(value, rules, fieldName, result) {
    // Range validation
    if (rules.min !== undefined && value < rules.min) {
      result.addError(fieldName, ValidationErrorType.RANGE, 
        `${fieldName} must be at least ${rules.min}`);
    }

    if (rules.max !== undefined && value > rules.max) {
      result.addError(fieldName, ValidationErrorType.RANGE, 
        `${fieldName} must be at most ${rules.max}`);
    }

    // Integer validation
    if (rules.integer && !Number.isInteger(value)) {
      result.addError(fieldName, ValidationErrorType.TYPE, 
        `${fieldName} must be an integer`);
    }

    // Positive validation
    if (rules.positive && value <= 0) {
      result.addError(fieldName, ValidationErrorType.RANGE, 
        `${fieldName} must be positive`);
    }

    // Non-negative validation
    if (rules.nonNegative && value < 0) {
      result.addError(fieldName, ValidationErrorType.RANGE, 
        `${fieldName} must be non-negative`);
    }

    // Precision validation (for financial amounts)
    if (rules.precision !== undefined) {
      const decimalPlaces = (value.toString().split('.')[1] || '').length;
      if (decimalPlaces > rules.precision) {
        result.addError(fieldName, ValidationErrorType.FORMAT, 
          `${fieldName} can have at most ${rules.precision} decimal places`);
      }
    }
  }

  /**
   * Array validation
   */
  validateArray(value, rules, fieldName, result) {
    // Length validation
    if (rules.minItems && value.length < rules.minItems) {
      result.addError(fieldName, ValidationErrorType.LENGTH, 
        `${fieldName} must have at least ${rules.minItems} items`);
    }

    if (rules.maxItems && value.length > rules.maxItems) {
      result.addError(fieldName, ValidationErrorType.LENGTH, 
        `${fieldName} must have at most ${rules.maxItems} items`);
    }

    // Global max length check
    if (value.length > this.options.maxArrayLength) {
      result.addError(fieldName, ValidationErrorType.SECURITY, 
        'Array too long - potential DoS attack');
    }

    // Item validation
    if (rules.items) {
      value.forEach((item, index) => {
        const itemResult = this.validateValue(item, rules.items, `${fieldName}[${index}]`);
        result.errors.push(...itemResult.errors);
        result.warnings.push(...itemResult.warnings);
        if (itemResult.hasErrors()) {
          result.valid = false;
        }
      });
    }

    // Unique items validation
    if (rules.uniqueItems) {
      const seen = new Set();
      const duplicates = [];
      
      for (let i = 0; i < value.length; i++) {
        const item = JSON.stringify(value[i]);
        if (seen.has(item)) {
          duplicates.push(i);
        } else {
          seen.add(item);
        }
      }

      if (duplicates.length > 0) {
        result.addError(fieldName, ValidationErrorType.BUSINESS_RULE, 
          `${fieldName} must contain unique items`);
      }
    }
  }

  /**
   * Format validation
   */
  validateFormat(value, format, fieldName, result) {
    const formatPattern = PATTERNS[format];
    if (formatPattern && !formatPattern.test(value)) {
      result.addError(fieldName, ValidationErrorType.FORMAT, 
        `${fieldName} must be a valid ${format}`);
    }
  }

  /**
   * Cryptocurrency address validation
   */
  validateCryptoAddress(address, currency, fieldName, result) {
    const validator = CRYPTO_VALIDATORS[currency.toUpperCase()];
    if (!validator) {
      result.addError(fieldName, ValidationErrorType.FORMAT, 
        `Unsupported cryptocurrency: ${currency}`);
      return;
    }

    if (address.length < validator.minLength || address.length > validator.maxLength) {
      result.addError(fieldName, ValidationErrorType.LENGTH, 
        `${currency} address length invalid`);
      return;
    }

    if (!validator.pattern.test(address)) {
      result.addError(fieldName, ValidationErrorType.FORMAT, 
        `Invalid ${currency} address format`);
    }
  }

  /**
   * Security validation to prevent common attacks
   */
  validateSecurity(value, fieldName, result) {
    if (typeof value !== 'string') return;

    // Check for SQL injection patterns
    if (PATTERNS.sqlInjection.test(value)) {
      result.addError(fieldName, ValidationErrorType.SECURITY, 
        'Potential SQL injection detected');
      this.stats.securityIssues++;
      logger.warn(`SQL injection attempt detected in field: ${fieldName}`);
    }

    // Check for XSS patterns
    if (PATTERNS.xss.test(value)) {
      result.addError(fieldName, ValidationErrorType.SECURITY, 
        'Potential XSS attack detected');
      this.stats.securityIssues++;
      logger.warn(`XSS attempt detected in field: ${fieldName}`);
    }

    // Check for path traversal
    if (PATTERNS.pathTraversal.test(value)) {
      result.addError(fieldName, ValidationErrorType.SECURITY, 
        'Potential path traversal detected');
      this.stats.securityIssues++;
      logger.warn(`Path traversal attempt detected in field: ${fieldName}`);
    }

    // Check for excessive control characters
    const controlCharCount = (value.match(/[\x00-\x1f\x7f-\x9f]/g) || []).length;
    if (controlCharCount > value.length * 0.1) {
      result.addError(fieldName, ValidationErrorType.SECURITY, 
        'Excessive control characters detected');
    }
  }

  /**
   * Timing-safe string comparison
   */
  timingSafeStringEqual(a, b) {
    if (!this.options.enableTimingSafeComparison) {
      return a === b;
    }

    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }

    // Pad strings to equal length to prevent timing attacks
    const maxLength = Math.max(a.length, b.length);
    const paddedA = a.padEnd(maxLength, '\0');
    const paddedB = b.padEnd(maxLength, '\0');

    try {
      const bufferA = Buffer.from(paddedA, 'utf8');
      const bufferB = Buffer.from(paddedB, 'utf8');
      return timingSafeEqual(bufferA, bufferB);
    } catch {
      return false;
    }
  }

  /**
   * Sanitize user input (defensive)
   */
  sanitize(value, options = {}) {
    if (typeof value !== 'string') return value;

    let sanitized = value;

    if (options.stripHtml !== false) {
      sanitized = sanitized.replace(/<[^>]*>/g, '');
    }

    if (options.escapeHtml !== false) {
      sanitized = sanitized
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
    }

    if (options.removeControlChars !== false) {
      sanitized = sanitized.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    }

    if (options.normalizeWhitespace !== false) {
      sanitized = sanitized.replace(/\s+/g, ' ').trim();
    }

    return sanitized;
  }

  /**
   * Get object nesting depth
   */
  getObjectDepth(obj, depth = 0) {
    if (depth > this.options.maxObjectDepth) return depth;
    
    if (typeof obj !== 'object' || obj === null) return depth;
    
    let maxDepth = depth;
    for (const value of Object.values(obj)) {
      if (typeof value === 'object' && value !== null) {
        const valueDepth = this.getObjectDepth(value, depth + 1);
        maxDepth = Math.max(maxDepth, valueDepth);
      }
    }
    
    return maxDepth;
  }

  /**
   * Update performance statistics
   */
  updateStats(duration, hasErrors) {
    this.stats.validations++;
    if (hasErrors) {
      this.stats.errors++;
    }
    
    // Update average time using exponential moving average
    const alpha = 0.1;
    this.stats.averageTime = alpha * duration + (1 - alpha) * this.stats.averageTime;
  }

  /**
   * Get validation statistics
   */
  getStats() {
    return {
      ...this.stats,
      errorRate: this.stats.validations > 0 ? this.stats.errors / this.stats.validations : 0,
      securityIssueRate: this.stats.validations > 0 ? this.stats.securityIssues / this.stats.validations : 0
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      validations: 0,
      errors: 0,
      securityIssues: 0,
      averageTime: 0
    };
  }
}

// Create singleton instance
let validatorInstance = null;

/**
 * Get or create validator instance
 */
export function getValidator(options = {}) {
  if (!validatorInstance) {
    validatorInstance = new ComprehensiveValidator(options);
  }
  return validatorInstance;
}

// Common validation schemas
export const CommonSchemas = {
  user: {
    username: { 
      type: 'string', 
      required: true, 
      format: 'username',
      minLength: 3,
      maxLength: 32
    },
    email: { 
      type: 'string', 
      required: true, 
      format: 'email',
      maxLength: 254
    },
    password: { 
      type: 'string', 
      required: true, 
      minLength: 8,
      maxLength: 128,
      pattern: PATTERNS.password,
      patternMessage: 'Password must contain uppercase, lowercase, number and special character'
    }
  },

  order: {
    symbol: { 
      type: 'string', 
      required: true, 
      pattern: /^[A-Z]{3,6}\/[A-Z]{3,6}$/,
      patternMessage: 'Symbol must be in format BASE/QUOTE'
    },
    side: { 
      type: 'string', 
      required: true, 
      enum: ['buy', 'sell']
    },
    type: { 
      type: 'string', 
      required: true, 
      enum: ['market', 'limit', 'stop', 'stop_limit']
    },
    quantity: { 
      type: 'number', 
      required: true, 
      positive: true,
      precision: 8
    },
    price: { 
      type: 'number', 
      positive: true,
      precision: 8
    }
  },

  walletAddress: {
    address: { 
      type: 'string', 
      required: true,
      minLength: 26,
      maxLength: 95
    },
    currency: { 
      type: 'string', 
      required: true, 
      enum: ['BTC', 'ETH', 'LTC', 'XMR', 'DOGE']
    }
  }
};

export default ComprehensiveValidator;