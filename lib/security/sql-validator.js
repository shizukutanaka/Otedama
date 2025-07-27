/**
 * SQL Injection Prevention Validator
 * Validates and sanitizes inputs to prevent SQL injection attacks
 * 
 * Design principles:
 * - Martin: Single responsibility - only handles SQL safety validation
 * - Pike: Simple and secure by default
 * - Carmack: Fast validation with minimal overhead
 */

import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('SQLValidator');

/**
 * SQL injection patterns to detect
 */
const SQL_INJECTION_PATTERNS = [
  // Basic SQL injection patterns
  /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|UNION|EXEC|EXECUTE)\b)/i,
  
  // Comment-based attacks
  /(--|\/\*|\*\/|#)/,
  
  // String delimiter attacks
  /('|"|`|;|\||\\)/,
  
  // Encoded attacks
  /(%27|%22|%3B|%2D%2D|%2F%2A|%2A%2F)/i,
  
  // Special characters that might be used in attacks
  /[<>]/,
  
  // Null byte injection
  /\x00/
];

/**
 * Allowed characters for different input types
 */
const ALLOWED_PATTERNS = {
  // Alphanumeric with underscores and dashes
  identifier: /^[a-zA-Z0-9_-]+$/,
  
  // Numbers only
  numeric: /^[0-9]+$/,
  
  // Decimal numbers
  decimal: /^[0-9]+\.?[0-9]*$/,
  
  // Bitcoin address pattern
  btcAddress: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
  
  // Ethereum address pattern
  ethAddress: /^0x[a-fA-F0-9]{40}$/,
  
  // Email pattern
  email: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  
  // Safe text (letters, numbers, spaces, basic punctuation)
  safeText: /^[a-zA-Z0-9\s.,!?()-]+$/,
  
  // Hash pattern (SHA256, etc)
  hash: /^[a-fA-F0-9]+$/
};

export class SQLValidator {
  constructor(options = {}) {
    this.options = {
      maxLength: 255,
      allowNull: false,
      logAttempts: true,
      ...options
    };
    
    this.stats = {
      validated: 0,
      rejected: 0,
      sanitized: 0
    };
  }
  
  /**
   * Validate input against SQL injection patterns
   * @param {string} input - Input to validate
   * @param {string} type - Type of input (identifier, numeric, etc)
   * @returns {Object} Validation result
   */
  validate(input, type = 'safeText') {
    this.stats.validated++;
    
    // Null/undefined check
    if (input === null || input === undefined) {
      if (this.options.allowNull) {
        return { valid: true, value: null };
      }
      return { valid: false, error: 'Input cannot be null' };
    }
    
    // Convert to string and trim
    const inputStr = String(input).trim();
    
    // Length check
    if (inputStr.length > this.options.maxLength) {
      this.stats.rejected++;
      return { 
        valid: false, 
        error: `Input exceeds maximum length of ${this.options.maxLength}` 
      };
    }
    
    // Empty string check
    if (inputStr.length === 0) {
      this.stats.rejected++;
      return { valid: false, error: 'Input cannot be empty' };
    }
    
    // Check for SQL injection patterns
    for (const pattern of SQL_INJECTION_PATTERNS) {
      if (pattern.test(inputStr)) {
        this.stats.rejected++;
        
        if (this.options.logAttempts) {
          logger.warn('SQL injection attempt detected', {
            type,
            pattern: pattern.toString(),
            input: inputStr.substring(0, 50) // Log only first 50 chars
          });
        }
        
        return { 
          valid: false, 
          error: 'Input contains potentially dangerous patterns' 
        };
      }
    }
    
    // Validate against allowed pattern for type
    if (ALLOWED_PATTERNS[type]) {
      if (!ALLOWED_PATTERNS[type].test(inputStr)) {
        this.stats.rejected++;
        return { 
          valid: false, 
          error: `Input does not match expected format for ${type}` 
        };
      }
    }
    
    return { valid: true, value: inputStr };
  }
  
  /**
   * Sanitize input by escaping dangerous characters
   * @param {string} input - Input to sanitize
   * @returns {string} Sanitized input
   */
  sanitize(input) {
    if (input === null || input === undefined) {
      return '';
    }
    
    this.stats.sanitized++;
    
    return String(input)
      .replace(/\\/g, '\\\\')  // Escape backslashes
      .replace(/'/g, "''")     // Escape single quotes
      .replace(/"/g, '""')     // Escape double quotes
      .replace(/\x00/g, '')    // Remove null bytes
      .replace(/\n/g, '\\n')   // Escape newlines
      .replace(/\r/g, '\\r')   // Escape carriage returns
      .replace(/\t/g, '\\t');  // Escape tabs
  }
  
  /**
   * Validate multiple inputs
   * @param {Object} inputs - Key-value pairs of inputs to validate
   * @param {Object} types - Key-value pairs of input types
   * @returns {Object} Validation results
   */
  validateMultiple(inputs, types = {}) {
    const results = {};
    const errors = [];
    
    for (const [key, value] of Object.entries(inputs)) {
      const type = types[key] || 'safeText';
      const result = this.validate(value, type);
      
      if (result.valid) {
        results[key] = result.value;
      } else {
        errors.push({ field: key, error: result.error });
      }
    }
    
    return {
      valid: errors.length === 0,
      values: results,
      errors
    };
  }
  
  /**
   * Create parameterized query placeholder
   * @param {number} count - Number of parameters
   * @returns {string} Placeholder string
   */
  createPlaceholders(count) {
    return Array(count).fill('?').join(', ');
  }
  
  /**
   * Validate table/column name
   * @param {string} name - Name to validate
   * @returns {Object} Validation result
   */
  validateIdentifier(name) {
    return this.validate(name, 'identifier');
  }
  
  /**
   * Validate numeric value
   * @param {*} value - Value to validate
   * @param {Object} options - Min/max constraints
   * @returns {Object} Validation result
   */
  validateNumeric(value, options = {}) {
    const result = this.validate(value, 'numeric');
    
    if (result.valid && options.min !== undefined) {
      const num = parseInt(result.value);
      if (num < options.min) {
        return { valid: false, error: `Value must be at least ${options.min}` };
      }
    }
    
    if (result.valid && options.max !== undefined) {
      const num = parseInt(result.value);
      if (num > options.max) {
        return { valid: false, error: `Value must be at most ${options.max}` };
      }
    }
    
    return result;
  }
  
  /**
   * Get validation statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return { ...this.stats };
  }
  
  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      validated: 0,
      rejected: 0,
      sanitized: 0
    };
  }
}

// Singleton instance
export const sqlValidator = new SQLValidator();

// Export validation functions for convenience
export const validateSQL = (input, type) => sqlValidator.validate(input, type);
export const sanitizeSQL = (input) => sqlValidator.sanitize(input);
export const validateMultipleSQL = (inputs, types) => sqlValidator.validateMultiple(inputs, types);

export default SQLValidator;