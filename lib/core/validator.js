/**
 * Input Validator - Otedama
 * Comprehensive input validation and sanitization
 * 
 * Design: Fail fast, clear errors (Martin)
 */

import { ValidationError } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('Validator');

/**
 * Validation rules
 */
export const Rules = {
  // Type validators
  isString: (value) => typeof value === 'string',
  isNumber: (value) => typeof value === 'number' && !isNaN(value),
  isInteger: (value) => Number.isInteger(value),
  isBoolean: (value) => typeof value === 'boolean',
  isArray: (value) => Array.isArray(value),
  isObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  isFunction: (value) => typeof value === 'function',
  isNull: (value) => value === null,
  isUndefined: (value) => value === undefined,
  isNullOrUndefined: (value) => value === null || value === undefined,
  
  // String validators
  isEmpty: (value) => value === '',
  isNotEmpty: (value) => value !== '',
  isLength: (value, min, max) => value.length >= min && value.length <= max,
  isMinLength: (value, min) => value.length >= min,
  isMaxLength: (value, max) => value.length <= max,
  isAlpha: (value) => /^[a-zA-Z]+$/.test(value),
  isAlphanumeric: (value) => /^[a-zA-Z0-9]+$/.test(value),
  isNumeric: (value) => /^[0-9]+$/.test(value),
  isEmail: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  isURL: (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
  isHex: (value) => /^[0-9a-fA-F]+$/.test(value),
  isBase64: (value) => /^[A-Za-z0-9+/]+=*$/.test(value),
  isJSON: (value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  },
  
  // Number validators
  isPositive: (value) => value > 0,
  isNegative: (value) => value < 0,
  isZero: (value) => value === 0,
  isInRange: (value, min, max) => value >= min && value <= max,
  isMin: (value, min) => value >= min,
  isMax: (value, max) => value <= max,
  
  // Crypto validators
  isBitcoinAddress: (value) => /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(value),
  isEthereumAddress: (value) => /^0x[a-fA-F0-9]{40}$/.test(value),
  isHash: (value, length = 64) => new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value),
  
  // Network validators
  isIP: (value) => /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(value),
  isPort: (value) => Rules.isInteger(value) && value >= 1 && value <= 65535,
  isHostname: (value) => /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(value),
  
  // Mining validators
  isDifficulty: (value) => Rules.isNumber(value) && value > 0,
  isJobId: (value) => Rules.isHex(value) && value.length <= 64,
  isNonce: (value) => Rules.isHex(value) && value.length === 8,
  isExtraNonce: (value) => Rules.isHex(value) && value.length <= 16,
  isWorkerName: (value) => /^[a-zA-Z0-9_.-]+$/.test(value) && value.length <= 50
};

/**
 * Sanitizers
 */
export const Sanitizers = {
  // String sanitizers
  trim: (value) => value.trim(),
  toLowerCase: (value) => value.toLowerCase(),
  toUpperCase: (value) => value.toUpperCase(),
  escape: (value) => value.replace(/[<>&'"]/g, (char) => {
    const escapeMap = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      "'": '&#39;',
      '"': '&quot;'
    };
    return escapeMap[char];
  }),
  unescape: (value) => value.replace(/&(lt|gt|amp|#39|quot);/g, (match, entity) => {
    const unescapeMap = {
      'lt': '<',
      'gt': '>',
      'amp': '&',
      '#39': "'",
      'quot': '"'
    };
    return unescapeMap[entity];
  }),
  stripTags: (value) => value.replace(/<[^>]*>/g, ''),
  normalizeWhitespace: (value) => value.replace(/\s+/g, ' ').trim(),
  
  // Number sanitizers
  toInt: (value) => parseInt(value, 10),
  toFloat: (value) => parseFloat(value),
  abs: (value) => Math.abs(value),
  round: (value, decimals = 0) => Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals),
  clamp: (value, min, max) => Math.min(Math.max(value, min), max),
  
  // Crypto sanitizers
  normalizeAddress: (value) => value.trim().toLowerCase(),
  normalizeHex: (value) => value.toLowerCase().replace(/^0x/, ''),
  
  // Path sanitizers
  sanitizePath: (value) => value.replace(/[^a-zA-Z0-9/_.-]/g, ''),
  sanitizeFilename: (value) => value.replace(/[^a-zA-Z0-9_.-]/g, '')
};

/**
 * Validation schema
 */
export class Schema {
  constructor(definition) {
    this.definition = definition;
  }
  
  validate(data) {
    const errors = [];
    const validated = {};
    
    for (const [field, rules] of Object.entries(this.definition)) {
      const value = data[field];
      
      // Check required
      if (rules.required && Rules.isNullOrUndefined(value)) {
        errors.push({
          field,
          message: `${field} is required`,
          code: 'REQUIRED'
        });
        continue;
      }
      
      // Skip optional undefined fields
      if (!rules.required && Rules.isNullOrUndefined(value)) {
        if (rules.default !== undefined) {
          validated[field] = rules.default;
        }
        continue;
      }
      
      // Type validation
      if (rules.type) {
        const typeValidator = Rules[`is${rules.type.charAt(0).toUpperCase() + rules.type.slice(1)}`];
        if (typeValidator && !typeValidator(value)) {
          errors.push({
            field,
            message: `${field} must be of type ${rules.type}`,
            code: 'INVALID_TYPE'
          });
          continue;
        }
      }
      
      // Custom validators
      if (rules.validate) {
        for (const validator of (Array.isArray(rules.validate) ? rules.validate : [rules.validate])) {
          const result = validator(value);
          if (result !== true) {
            errors.push({
              field,
              message: result || `${field} is invalid`,
              code: 'CUSTOM_VALIDATION'
            });
          }
        }
      }
      
      // Sanitizers
      let sanitized = value;
      if (rules.sanitize) {
        for (const sanitizer of (Array.isArray(rules.sanitize) ? rules.sanitize : [rules.sanitize])) {
          sanitized = sanitizer(sanitized);
        }
      }
      
      validated[field] = sanitized;
    }
    
    if (errors.length > 0) {
      throw new ValidationError('Validation failed', errors);
    }
    
    return validated;
  }
}

/**
 * Common validation schemas
 */
export const Schemas = {
  // Mining schemas
  minerConnection: new Schema({
    address: {
      type: 'string',
      required: true,
      validate: [
        (v) => Rules.isBitcoinAddress(v) || Rules.isEthereumAddress(v) || 'Invalid wallet address'
      ],
      sanitize: Sanitizers.normalizeAddress
    },
    worker: {
      type: 'string',
      required: false,
      default: 'default',
      validate: [
        (v) => Rules.isWorkerName(v) || 'Invalid worker name'
      ],
      sanitize: Sanitizers.trim
    },
    password: {
      type: 'string',
      required: false,
      default: 'x'
    }
  }),
  
  shareSubmission: new Schema({
    jobId: {
      type: 'string',
      required: true,
      validate: [
        (v) => Rules.isJobId(v) || 'Invalid job ID'
      ],
      sanitize: Sanitizers.normalizeHex
    },
    nonce: {
      type: 'string',
      required: true,
      validate: [
        (v) => Rules.isNonce(v) || 'Invalid nonce'
      ],
      sanitize: Sanitizers.normalizeHex
    },
    extraNonce2: {
      type: 'string',
      required: true,
      validate: [
        (v) => Rules.isExtraNonce(v) || 'Invalid extra nonce'
      ],
      sanitize: Sanitizers.normalizeHex
    },
    time: {
      type: 'string',
      required: true,
      validate: [
        (v) => Rules.isHex(v) && v.length === 8 || 'Invalid time'
      ],
      sanitize: Sanitizers.normalizeHex
    }
  }),
  
  // Network schemas
  peerConnection: new Schema({
    host: {
      type: 'string',
      required: true,
      validate: [
        (v) => Rules.isIP(v) || Rules.isHostname(v) || 'Invalid host'
      ],
      sanitize: Sanitizers.trim
    },
    port: {
      type: 'number',
      required: true,
      validate: [
        (v) => Rules.isPort(v) || 'Invalid port'
      ],
      sanitize: Sanitizers.toInt
    }
  }),
  
  // API schemas
  apiRequest: new Schema({
    method: {
      type: 'string',
      required: true,
      validate: [
        (v) => ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(v) || 'Invalid method'
      ],
      sanitize: Sanitizers.toUpperCase
    },
    path: {
      type: 'string',
      required: true,
      validate: [
        (v) => v.startsWith('/') || 'Path must start with /'
      ],
      sanitize: [Sanitizers.trim, Sanitizers.sanitizePath]
    },
    body: {
      type: 'object',
      required: false,
      default: {}
    }
  })
};

/**
 * Validator class
 */
export class Validator {
  constructor() {
    this.schemas = new Map();
    
    // Register default schemas
    for (const [name, schema] of Object.entries(Schemas)) {
      this.schemas.set(name, schema);
    }
  }
  
  registerSchema(name, schema) {
    this.schemas.set(name, schema);
  }
  
  validate(schemaName, data) {
    const schema = this.schemas.get(schemaName);
    if (!schema) {
      throw new ValidationError(`Unknown schema: ${schemaName}`);
    }
    
    return schema.validate(data);
  }
  
  // Quick validation methods
  
  isValidBitcoinAddress(address) {
    return Rules.isBitcoinAddress(address);
  }
  
  isValidEthereumAddress(address) {
    return Rules.isEthereumAddress(address);
  }
  
  isValidShare(share) {
    try {
      Schemas.shareSubmission.validate(share);
      return true;
    } catch {
      return false;
    }
  }
  
  sanitizeHTML(html) {
    return Sanitizers.escape(Sanitizers.stripTags(html));
  }
  
  sanitizeSQL(value) {
    if (typeof value !== 'string') return value;
    
    // Basic SQL injection prevention
    return value.replace(/['";\\]/g, '\\$&');
  }
}

// Singleton instance
export const validator = new Validator();

export default {
  Rules,
  Sanitizers,
  Schema,
  Schemas,
  Validator,
  validator
};
