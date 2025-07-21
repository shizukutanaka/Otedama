/**
 * Safe JSON Parser for Otedama
 * Prevents prototype pollution and other JSON-based attacks
 * 
 * Design principles:
 * - Pike: Simple, secure by default
 * - Martin: Clean validation interface
 * - Carmack: Fast validation with minimal overhead
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { getLogger } from '../core/logger.js';

const logger = getLogger('SafeJSON');

/**
 * Dangerous keys that could lead to prototype pollution
 */
const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__lookupGetter__',
  '__lookupSetter__',
  '__defineGetter__',
  '__defineSetter__',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf'
]);

/**
 * Safe JSON parser with validation
 */
export class SafeJSONParser {
  constructor(options = {}) {
    this.options = {
      // Security options
      maxDepth: options.maxDepth || 32,
      maxKeys: options.maxKeys || 1000,
      maxArrayLength: options.maxArrayLength || 10000,
      maxStringLength: options.maxStringLength || 1000000, // 1MB
      allowedTypes: options.allowedTypes || ['object', 'array', 'string', 'number', 'boolean', 'null'],
      
      // Validation options
      validateSchema: options.validateSchema !== false,
      strictMode: options.strictMode !== false,
      coerceTypes: options.coerceTypes || false,
      removeAdditional: options.removeAdditional || true,
      
      // Performance options
      cacheSchemas: options.cacheSchemas !== false,
      maxCacheSize: options.maxCacheSize || 100,
      
      ...options
    };
    
    // Initialize AJV for schema validation
    this.ajv = new Ajv({
      strict: this.options.strictMode,
      coerceTypes: this.options.coerceTypes,
      removeAdditional: this.options.removeAdditional,
      useDefaults: true,
      allErrors: true,
      cache: this.options.cacheSchemas
    });
    
    // Add format validators
    addFormats(this.ajv);
    
    // Schema cache
    this.schemaCache = new Map();
    this.compiledSchemas = new Map();
    
    // Statistics
    this.stats = {
      parsed: 0,
      blocked: 0,
      validationFailed: 0,
      errors: 0
    };
  }
  
  /**
   * Safely parse JSON string
   */
  parse(jsonString, schema = null) {
    this.stats.parsed++;
    
    try {
      // Validate input is string
      if (typeof jsonString !== 'string') {
        throw new TypeError('Input must be a string');
      }
      
      // Check string length
      if (jsonString.length > this.options.maxStringLength) {
        throw new RangeError(`JSON string exceeds maximum length of ${this.options.maxStringLength}`);
      }
      
      // Parse with reviver to catch dangerous keys
      const parsed = JSON.parse(jsonString, this._createReviver());
      
      // Deep validation
      this._validateObject(parsed);
      
      // Schema validation if provided
      if (schema && this.options.validateSchema) {
        this._validateSchema(parsed, schema);
      }
      
      return parsed;
      
    } catch (error) {
      this.stats.errors++;
      logger.error(`Safe JSON parse error: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Create safe reviver function for JSON.parse
   */
  _createReviver() {
    const self = this;
    let depth = 0;
    let keyCount = 0;
    
    return function reviver(key, value) {
      // Track depth
      if (value && typeof value === 'object') {
        depth++;
        if (depth > self.options.maxDepth) {
          throw new RangeError(`Object depth exceeds maximum of ${self.options.maxDepth}`);
        }
      }
      
      // Check for dangerous keys
      if (typeof key === 'string' && DANGEROUS_KEYS.has(key)) {
        self.stats.blocked++;
        logger.warn(`Blocked dangerous key: ${key}`);
        return undefined; // Remove the property
      }
      
      // Check key count
      if (typeof key === 'string' && key !== '') {
        keyCount++;
        if (keyCount > self.options.maxKeys) {
          throw new RangeError(`Object key count exceeds maximum of ${self.options.maxKeys}`);
        }
      }
      
      // Check array length
      if (Array.isArray(value) && value.length > self.options.maxArrayLength) {
        throw new RangeError(`Array length exceeds maximum of ${self.options.maxArrayLength}`);
      }
      
      // Check value type
      const valueType = value === null ? 'null' : typeof value;
      if (!self.options.allowedTypes.includes(valueType)) {
        throw new TypeError(`Type '${valueType}' is not allowed`);
      }
      
      // Additional checks for objects
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Check for circular references by ensuring it's a plain object
        if (value.constructor && value.constructor !== Object) {
          throw new TypeError('Only plain objects are allowed');
        }
      }
      
      return value;
    };
  }
  
  /**
   * Deep validation of parsed object
   */
  _validateObject(obj, currentDepth = 0) {
    if (currentDepth > this.options.maxDepth) {
      throw new RangeError(`Object depth exceeds maximum of ${this.options.maxDepth}`);
    }
    
    if (obj === null || obj === undefined) {
      return;
    }
    
    if (typeof obj === 'object') {
      // Prevent prototype pollution
      if (obj.__proto__ !== Object.prototype && obj.__proto__ !== Array.prototype) {
        throw new Error('Object prototype has been polluted');
      }
      
      if (Array.isArray(obj)) {
        if (obj.length > this.options.maxArrayLength) {
          throw new RangeError(`Array length exceeds maximum of ${this.options.maxArrayLength}`);
        }
        
        for (const item of obj) {
          this._validateObject(item, currentDepth + 1);
        }
      } else {
        const keys = Object.keys(obj);
        if (keys.length > this.options.maxKeys) {
          throw new RangeError(`Object key count exceeds maximum of ${this.options.maxKeys}`);
        }
        
        for (const key of keys) {
          // Double-check dangerous keys
          if (DANGEROUS_KEYS.has(key)) {
            throw new Error(`Dangerous key detected: ${key}`);
          }
          
          this._validateObject(obj[key], currentDepth + 1);
        }
      }
    }
  }
  
  /**
   * Validate against JSON schema
   */
  _validateSchema(data, schema) {
    let validate;
    
    // Check if schema is already compiled
    const schemaId = schema.$id || JSON.stringify(schema);
    if (this.compiledSchemas.has(schemaId)) {
      validate = this.compiledSchemas.get(schemaId);
    } else {
      // Compile schema
      validate = this.ajv.compile(schema);
      
      // Cache compiled schema
      if (this.options.cacheSchemas && this.compiledSchemas.size < this.options.maxCacheSize) {
        this.compiledSchemas.set(schemaId, validate);
      }
    }
    
    // Validate data
    const valid = validate(data);
    if (!valid) {
      this.stats.validationFailed++;
      const errors = validate.errors.map(err => ({
        path: err.instancePath,
        message: err.message,
        params: err.params
      }));
      
      const error = new Error('Schema validation failed');
      error.validationErrors = errors;
      throw error;
    }
  }
  
  /**
   * Parse with custom schema
   */
  parseWithSchema(jsonString, schema) {
    return this.parse(jsonString, schema);
  }
  
  /**
   * Create a restricted parser with specific schema
   */
  createRestrictedParser(schema) {
    const self = this;
    return {
      parse: (jsonString) => self.parseWithSchema(jsonString, schema)
    };
  }
  
  /**
   * Sanitize object by removing dangerous keys
   */
  sanitize(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitize(item));
    }
    
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!DANGEROUS_KEYS.has(key)) {
        sanitized[key] = this.sanitize(value);
      }
    }
    
    return sanitized;
  }
  
  /**
   * Get parser statistics
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.compiledSchemas.size,
      blockRate: this.stats.parsed > 0 ? 
        (this.stats.blocked / this.stats.parsed * 100).toFixed(2) + '%' : '0%'
    };
  }
}

/**
 * Pre-defined schemas for common use cases
 */
export const CommonSchemas = {
  // User input schema
  userInput: {
    type: 'object',
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_-]+$' },
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8, maxLength: 128 },
      profile: {
        type: 'object',
        properties: {
          firstName: { type: 'string', maxLength: 100 },
          lastName: { type: 'string', maxLength: 100 },
          bio: { type: 'string', maxLength: 500 }
        },
        additionalProperties: false
      }
    },
    required: ['username', 'email', 'password'],
    additionalProperties: false
  },
  
  // API request schema
  apiRequest: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
      endpoint: { type: 'string', pattern: '^/api/[a-zA-Z0-9/_-]+$' },
      params: { type: 'object' },
      body: { type: 'object' },
      headers: { type: 'object' }
    },
    required: ['method', 'endpoint'],
    additionalProperties: false
  },
  
  // Transaction schema
  transaction: {
    type: 'object',
    properties: {
      from: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      to: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      amount: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' },
      currency: { type: 'string', minLength: 3, maxLength: 10 },
      memo: { type: 'string', maxLength: 200 },
      timestamp: { type: 'number' }
    },
    required: ['from', 'to', 'amount', 'currency'],
    additionalProperties: false
  },
  
  // Configuration schema
  configuration: {
    type: 'object',
    properties: {
      server: {
        type: 'object',
        properties: {
          host: { type: 'string', format: 'hostname' },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          ssl: { type: 'boolean' }
        },
        required: ['host', 'port'],
        additionalProperties: false
      },
      database: {
        type: 'object',
        properties: {
          host: { type: 'string' },
          port: { type: 'integer' },
          name: { type: 'string' },
          user: { type: 'string' }
        },
        required: ['host', 'name'],
        additionalProperties: false
      },
      features: {
        type: 'object',
        patternProperties: {
          '^[a-zA-Z][a-zA-Z0-9_]*$': { type: 'boolean' }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
};

/**
 * Global safe parser instance
 */
export const safeJSON = new SafeJSONParser();

/**
 * Express middleware for safe JSON parsing
 */
export function safeJSONMiddleware(options = {}) {
  const parser = new SafeJSONParser(options);
  
  return function(req, res, next) {
    // Override the default JSON parser
    let data = '';
    
    req.setEncoding('utf8');
    req.on('data', chunk => {
      data += chunk;
      
      // Check size limit
      if (data.length > parser.options.maxStringLength) {
        const error = new Error('Request body too large');
        error.status = 413;
        return next(error);
      }
    });
    
    req.on('end', () => {
      if (data) {
        try {
          req.body = parser.parse(data, options.schema);
          next();
        } catch (error) {
          error.status = 400;
          next(error);
        }
      } else {
        req.body = {};
        next();
      }
    });
  };
}

/**
 * Replace unsafe JSON.parse globally (use with caution)
 */
export function replaceGlobalJSONParse(options = {}) {
  const parser = new SafeJSONParser(options);
  const originalParse = JSON.parse;
  
  JSON.parse = function(text, reviver) {
    // Use safe parser for string inputs
    if (typeof text === 'string') {
      try {
        return parser.parse(text);
      } catch (error) {
        // Fall back to original parse to maintain compatibility
        logger.warn(`Safe parse failed, falling back to original: ${error.message}`);
        return originalParse.call(JSON, text, reviver);
      }
    }
    
    // Use original parse for non-string inputs
    return originalParse.call(JSON, text, reviver);
  };
  
  // Return restore function
  return function restore() {
    JSON.parse = originalParse;
  };
}

export default SafeJSONParser;