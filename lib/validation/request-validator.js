/**
 * Request Validation System for Otedama
 * 
 * Design principles:
 * - Carmack: Fast validation with minimal overhead
 * - Martin: Clean validation rules and error messages
 * - Pike: Simple but comprehensive
 */

import { createHash } from 'crypto';

// Validation error class
export class ValidationError extends Error {
  constructor(message, field, value) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
    this.errors = [];
  }

  addError(field, message, value) {
    this.errors.push({ field, message, value });
  }

  toJSON() {
    return {
      error: 'Validation Error',
      message: this.message,
      field: this.field,
      errors: this.errors
    };
  }
}

// Validation types
export const ValidationType = {
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  EMAIL: 'email',
  URL: 'url',
  UUID: 'uuid',
  DATE: 'date',
  DATETIME: 'datetime',
  TIME: 'time',
  BITCOIN_ADDRESS: 'bitcoin_address',
  ETH_ADDRESS: 'eth_address',
  HEX: 'hex',
  BASE64: 'base64',
  JSON: 'json',
  REGEX: 'regex'
};

/**
 * Validation rules
 */
export class ValidationRule {
  constructor(type, options = {}) {
    this.type = type;
    this.required = options.required || false;
    this.nullable = options.nullable || false;
    this.default = options.default;
    this.transform = options.transform;
    this.custom = options.custom;
    
    // Type-specific options
    this.options = options;
  }

  validate(value, field) {
    // Check required
    if (value === undefined || value === null) {
      if (this.required && !this.nullable) {
        throw new ValidationError(`${field} is required`, field, value);
      }
      if (value === null && this.nullable) {
        return null;
      }
      if (this.default !== undefined) {
        return typeof this.default === 'function' ? this.default() : this.default;
      }
      return value;
    }

    // Apply transform
    if (this.transform) {
      value = this.transform(value);
    }

    // Type validation
    let validated = this.validateType(value, field);

    // Custom validation
    if (this.custom) {
      const customResult = this.custom(validated, field);
      if (customResult !== true) {
        throw new ValidationError(customResult || `${field} failed custom validation`, field, value);
      }
    }

    return validated;
  }

  validateType(value, field) {
    switch (this.type) {
      case ValidationType.STRING:
        return this.validateString(value, field);
      case ValidationType.NUMBER:
        return this.validateNumber(value, field);
      case ValidationType.INTEGER:
        return this.validateInteger(value, field);
      case ValidationType.BOOLEAN:
        return this.validateBoolean(value, field);
      case ValidationType.ARRAY:
        return this.validateArray(value, field);
      case ValidationType.OBJECT:
        return this.validateObject(value, field);
      case ValidationType.EMAIL:
        return this.validateEmail(value, field);
      case ValidationType.URL:
        return this.validateURL(value, field);
      case ValidationType.UUID:
        return this.validateUUID(value, field);
      case ValidationType.DATE:
        return this.validateDate(value, field);
      case ValidationType.DATETIME:
        return this.validateDateTime(value, field);
      case ValidationType.TIME:
        return this.validateTime(value, field);
      case ValidationType.BITCOIN_ADDRESS:
        return this.validateBitcoinAddress(value, field);
      case ValidationType.ETH_ADDRESS:
        return this.validateEthAddress(value, field);
      case ValidationType.HEX:
        return this.validateHex(value, field);
      case ValidationType.BASE64:
        return this.validateBase64(value, field);
      case ValidationType.JSON:
        return this.validateJSON(value, field);
      case ValidationType.REGEX:
        return this.validateRegex(value, field);
      default:
        return value;
    }
  }

  validateString(value, field) {
    if (typeof value !== 'string') {
      throw new ValidationError(`${field} must be a string`, field, value);
    }

    const { minLength, maxLength, enum: enumValues, pattern, trim } = this.options;

    let str = trim ? value.trim() : value;

    if (minLength !== undefined && str.length < minLength) {
      throw new ValidationError(`${field} must be at least ${minLength} characters`, field, value);
    }

    if (maxLength !== undefined && str.length > maxLength) {
      throw new ValidationError(`${field} must be at most ${maxLength} characters`, field, value);
    }

    if (enumValues && !enumValues.includes(str)) {
      throw new ValidationError(`${field} must be one of: ${enumValues.join(', ')}`, field, value);
    }

    if (pattern && !pattern.test(str)) {
      throw new ValidationError(`${field} has invalid format`, field, value);
    }

    return str;
  }

  validateNumber(value, field) {
    const num = Number(value);
    
    if (isNaN(num)) {
      throw new ValidationError(`${field} must be a number`, field, value);
    }

    const { min, max, positive, negative } = this.options;

    if (min !== undefined && num < min) {
      throw new ValidationError(`${field} must be at least ${min}`, field, value);
    }

    if (max !== undefined && num > max) {
      throw new ValidationError(`${field} must be at most ${max}`, field, value);
    }

    if (positive && num <= 0) {
      throw new ValidationError(`${field} must be positive`, field, value);
    }

    if (negative && num >= 0) {
      throw new ValidationError(`${field} must be negative`, field, value);
    }

    return num;
  }

  validateInteger(value, field) {
    const num = this.validateNumber(value, field);
    
    if (!Number.isInteger(num)) {
      throw new ValidationError(`${field} must be an integer`, field, value);
    }

    return num;
  }

  validateBoolean(value, field) {
    if (typeof value === 'boolean') {
      return value;
    }

    if (this.options.strict) {
      throw new ValidationError(`${field} must be a boolean`, field, value);
    }

    // Coerce common values
    if (value === 'true' || value === '1' || value === 1) {
      return true;
    }

    if (value === 'false' || value === '0' || value === 0) {
      return false;
    }

    throw new ValidationError(`${field} must be a boolean`, field, value);
  }

  validateArray(value, field) {
    if (!Array.isArray(value)) {
      throw new ValidationError(`${field} must be an array`, field, value);
    }

    const { minItems, maxItems, unique, items } = this.options;

    if (minItems !== undefined && value.length < minItems) {
      throw new ValidationError(`${field} must have at least ${minItems} items`, field, value);
    }

    if (maxItems !== undefined && value.length > maxItems) {
      throw new ValidationError(`${field} must have at most ${maxItems} items`, field, value);
    }

    if (unique) {
      const uniqueValues = new Set(value.map(v => JSON.stringify(v)));
      if (uniqueValues.size !== value.length) {
        throw new ValidationError(`${field} must have unique items`, field, value);
      }
    }

    // Validate each item
    if (items) {
      return value.map((item, index) => {
        try {
          return items.validate(item, `${field}[${index}]`);
        } catch (error) {
          throw new ValidationError(`${field}[${index}]: ${error.message}`, field, value);
        }
      });
    }

    return value;
  }

  validateObject(value, field) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ValidationError(`${field} must be an object`, field, value);
    }

    const { properties, additionalProperties, required } = this.options;

    const validated = {};

    // Validate required properties
    if (required) {
      for (const prop of required) {
        if (!(prop in value)) {
          throw new ValidationError(`${field}.${prop} is required`, field, value);
        }
      }
    }

    // Validate properties
    if (properties) {
      for (const [key, rule] of Object.entries(properties)) {
        if (key in value) {
          validated[key] = rule.validate(value[key], `${field}.${key}`);
        } else if (rule.required) {
          throw new ValidationError(`${field}.${key} is required`, field, value);
        } else if (rule.default !== undefined) {
          validated[key] = typeof rule.default === 'function' ? rule.default() : rule.default;
        }
      }
    }

    // Handle additional properties
    if (additionalProperties === false) {
      const allowedKeys = Object.keys(properties || {});
      const extraKeys = Object.keys(value).filter(k => !allowedKeys.includes(k));
      
      if (extraKeys.length > 0) {
        throw new ValidationError(`${field} has unexpected properties: ${extraKeys.join(', ')}`, field, value);
      }
    } else if (additionalProperties instanceof ValidationRule) {
      // Validate additional properties with rule
      for (const [key, val] of Object.entries(value)) {
        if (!properties || !(key in properties)) {
          validated[key] = additionalProperties.validate(val, `${field}.${key}`);
        }
      }
    } else {
      // Allow any additional properties
      Object.assign(validated, value);
    }

    return validated;
  }

  validateEmail(value, field) {
    const str = this.validateString(value, field);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    
    if (!emailRegex.test(str)) {
      throw new ValidationError(`${field} must be a valid email address`, field, value);
    }

    return str.toLowerCase();
  }

  validateURL(value, field) {
    const str = this.validateString(value, field);
    
    try {
      const url = new URL(str);
      
      if (this.options.protocols) {
        if (!this.options.protocols.includes(url.protocol.slice(0, -1))) {
          throw new ValidationError(`${field} must use protocol: ${this.options.protocols.join(', ')}`, field, value);
        }
      }
      
      return str;
    } catch (error) {
      throw new ValidationError(`${field} must be a valid URL`, field, value);
    }
  }

  validateUUID(value, field) {
    const str = this.validateString(value, field);
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!uuidRegex.test(str)) {
      throw new ValidationError(`${field} must be a valid UUID`, field, value);
    }

    return str.toLowerCase();
  }

  validateDate(value, field) {
    const date = new Date(value);
    
    if (isNaN(date.getTime())) {
      throw new ValidationError(`${field} must be a valid date`, field, value);
    }

    const { min, max } = this.options;

    if (min && date < new Date(min)) {
      throw new ValidationError(`${field} must be after ${min}`, field, value);
    }

    if (max && date > new Date(max)) {
      throw new ValidationError(`${field} must be before ${max}`, field, value);
    }

    return date.toISOString().split('T')[0];
  }

  validateDateTime(value, field) {
    const date = new Date(value);
    
    if (isNaN(date.getTime())) {
      throw new ValidationError(`${field} must be a valid datetime`, field, value);
    }

    const { min, max } = this.options;

    if (min && date < new Date(min)) {
      throw new ValidationError(`${field} must be after ${min}`, field, value);
    }

    if (max && date > new Date(max)) {
      throw new ValidationError(`${field} must be before ${max}`, field, value);
    }

    return date.toISOString();
  }

  validateTime(value, field) {
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
    
    if (!timeRegex.test(value)) {
      throw new ValidationError(`${field} must be a valid time (HH:MM or HH:MM:SS)`, field, value);
    }

    return value;
  }

  validateBitcoinAddress(value, field) {
    const str = this.validateString(value, field);
    
    // P2PKH (Legacy)
    const p2pkhRegex = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
    
    // P2SH
    const p2shRegex = /^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/;
    
    // Bech32 (SegWit)
    const bech32Regex = /^bc1[a-z0-9]{39,59}$/;
    
    // Bech32m (Taproot)
    const bech32mRegex = /^bc1p[a-z0-9]{57}$/;
    
    if (!p2pkhRegex.test(str) && !p2shRegex.test(str) && 
        !bech32Regex.test(str) && !bech32mRegex.test(str)) {
      throw new ValidationError(`${field} must be a valid Bitcoin address`, field, value);
    }

    return str;
  }

  validateEthAddress(value, field) {
    const str = this.validateString(value, field);
    const ethRegex = /^0x[a-fA-F0-9]{40}$/;
    
    if (!ethRegex.test(str)) {
      throw new ValidationError(`${field} must be a valid Ethereum address`, field, value);
    }

    // Validate checksum if mixed case
    if (str !== str.toLowerCase() && str !== str.toUpperCase()) {
      const address = str.substring(2);
      const hash = createHash('sha3-256').update(address.toLowerCase()).digest('hex');
      
      for (let i = 0; i < 40; i++) {
        const char = address[i];
        const shouldBeUppercase = parseInt(hash[i], 16) >= 8;
        
        if ((char === char.toUpperCase() && !shouldBeUppercase) ||
            (char === char.toLowerCase() && shouldBeUppercase)) {
          throw new ValidationError(`${field} has invalid checksum`, field, value);
        }
      }
    }

    return str.toLowerCase();
  }

  validateHex(value, field) {
    const str = this.validateString(value, field);
    const { prefix, length } = this.options;
    
    let hex = str;
    
    if (prefix) {
      if (!hex.startsWith(prefix)) {
        throw new ValidationError(`${field} must start with ${prefix}`, field, value);
      }
      hex = hex.substring(prefix.length);
    }
    
    if (!/^[0-9a-fA-F]*$/.test(hex)) {
      throw new ValidationError(`${field} must be a valid hex string`, field, value);
    }
    
    if (length !== undefined && hex.length !== length) {
      throw new ValidationError(`${field} must be ${length} characters`, field, value);
    }

    return str.toLowerCase();
  }

  validateBase64(value, field) {
    const str = this.validateString(value, field);
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    
    if (!base64Regex.test(str) || str.length % 4 !== 0) {
      throw new ValidationError(`${field} must be valid base64`, field, value);
    }

    return str;
  }

  validateJSON(value, field) {
    const str = this.validateString(value, field);
    
    try {
      return JSON.parse(str);
    } catch (error) {
      throw new ValidationError(`${field} must be valid JSON`, field, value);
    }
  }

  validateRegex(value, field) {
    const str = this.validateString(value, field);
    const { pattern, flags } = this.options;
    
    if (!pattern) {
      throw new ValidationError(`${field} validation requires pattern option`, field, value);
    }
    
    const regex = new RegExp(pattern, flags);
    
    if (!regex.test(str)) {
      throw new ValidationError(`${field} does not match required pattern`, field, value);
    }

    return str;
  }
}

/**
 * Schema validator
 */
export class Schema {
  constructor(definition) {
    this.rules = {};
    
    for (const [field, rule] of Object.entries(definition)) {
      if (rule instanceof ValidationRule) {
        this.rules[field] = rule;
      } else if (typeof rule === 'string') {
        // Shorthand: 'string:required'
        const [type, ...modifiers] = rule.split(':');
        this.rules[field] = new ValidationRule(type, {
          required: modifiers.includes('required'),
          nullable: modifiers.includes('nullable')
        });
      } else if (typeof rule === 'object') {
        // Object definition
        const { type, ...options } = rule;
        this.rules[field] = new ValidationRule(type, options);
      }
    }
  }

  validate(data) {
    const errors = new ValidationError('Validation failed');
    const validated = {};
    let hasErrors = false;

    // Validate each field
    for (const [field, rule] of Object.entries(this.rules)) {
      try {
        validated[field] = rule.validate(data[field], field);
      } catch (error) {
        hasErrors = true;
        if (error instanceof ValidationError) {
          errors.addError(field, error.message, error.value);
        } else {
          errors.addError(field, error.message, data[field]);
        }
      }
    }

    // Check for unexpected fields
    const allowedFields = Object.keys(this.rules);
    const unexpectedFields = Object.keys(data).filter(f => !allowedFields.includes(f));
    
    if (unexpectedFields.length > 0) {
      hasErrors = true;
      errors.addError('_schema', `Unexpected fields: ${unexpectedFields.join(', ')}`, unexpectedFields);
    }

    if (hasErrors) {
      throw errors;
    }

    return validated;
  }

  partial() {
    const partialRules = {};
    
    for (const [field, rule] of Object.entries(this.rules)) {
      partialRules[field] = new ValidationRule(rule.type, {
        ...rule.options,
        required: false
      });
    }
    
    return new Schema(partialRules);
  }
}

/**
 * Common validation schemas
 */
export const CommonSchemas = {
  // User registration
  userRegistration: new Schema({
    username: new ValidationRule('string', {
      required: true,
      minLength: 3,
      maxLength: 30,
      pattern: /^[a-zA-Z0-9_-]+$/,
      transform: (v) => v.toLowerCase()
    }),
    email: new ValidationRule('email', { required: true }),
    password: new ValidationRule('string', {
      required: true,
      minLength: 8,
      maxLength: 128,
      custom: (value) => {
        if (!/[A-Z]/.test(value)) return 'Password must contain uppercase letter';
        if (!/[a-z]/.test(value)) return 'Password must contain lowercase letter';
        if (!/[0-9]/.test(value)) return 'Password must contain number';
        if (!/[!@#$%^&*]/.test(value)) return 'Password must contain special character';
        return true;
      }
    }),
    btcAddress: new ValidationRule('bitcoin_address', { required: false })
  }),

  // Login
  login: new Schema({
    username: new ValidationRule('string', { required: true }),
    password: new ValidationRule('string', { required: true }),
    twoFactorToken: new ValidationRule('string', {
      required: false,
      pattern: /^\d{6}$/
    })
  }),

  // Create order
  createOrder: new Schema({
    pair: new ValidationRule('string', {
      required: true,
      pattern: /^[A-Z]{3,5}_[A-Z]{3,5}$/
    }),
    side: new ValidationRule('string', {
      required: true,
      enum: ['buy', 'sell']
    }),
    type: new ValidationRule('string', {
      required: true,
      enum: ['market', 'limit', 'stop', 'stop_limit']
    }),
    amount: new ValidationRule('number', {
      required: true,
      positive: true
    }),
    price: new ValidationRule('number', {
      required: false,
      positive: true,
      custom: (value, field, data) => {
        if (data.type === 'limit' && !value) {
          return 'Price is required for limit orders';
        }
        return true;
      }
    })
  }),

  // Mining submission
  miningSubmission: new Schema({
    jobId: new ValidationRule('string', { required: true }),
    nonce: new ValidationRule('hex', { required: true }),
    result: new ValidationRule('hex', {
      required: true,
      length: 64
    }),
    workerId: new ValidationRule('string', { required: true })
  }),

  // Pagination
  pagination: new Schema({
    page: new ValidationRule('integer', {
      required: false,
      min: 1,
      default: 1
    }),
    limit: new ValidationRule('integer', {
      required: false,
      min: 1,
      max: 100,
      default: 20
    }),
    sort: new ValidationRule('string', {
      required: false,
      pattern: /^-?[a-zA-Z_]+$/
    })
  })
};

/**
 * Validation middleware
 */
export function validateBody(schema) {
  return async (req, res, next) => {
    try {
      // Parse body if needed
      if (req.headers['content-type']?.includes('application/json') && typeof req.body === 'string') {
        try {
          req.body = JSON.parse(req.body);
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({
            error: 'Invalid JSON',
            message: error.message
          }));
          return;
        }
      }

      // Validate
      req.validatedBody = schema.validate(req.body || {});
      next();
    } catch (error) {
      if (error instanceof ValidationError) {
        res.statusCode = 400;
        res.end(JSON.stringify(error.toJSON()));
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({
          error: 'Validation error',
          message: error.message
        }));
      }
    }
  };
}

export function validateQuery(schema) {
  return async (req, res, next) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const query = Object.fromEntries(url.searchParams);
      
      req.validatedQuery = schema.validate(query);
      next();
    } catch (error) {
      if (error instanceof ValidationError) {
        res.statusCode = 400;
        res.end(JSON.stringify(error.toJSON()));
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({
          error: 'Validation error',
          message: error.message
        }));
      }
    }
  };
}

export function validateParams(schema) {
  return async (req, res, next) => {
    try {
      req.validatedParams = schema.validate(req.params || {});
      next();
    } catch (error) {
      if (error instanceof ValidationError) {
        res.statusCode = 400;
        res.end(JSON.stringify(error.toJSON()));
      } else {
        res.statusCode = 500;
        res.end(JSON.stringify({
          error: 'Validation error',
          message: error.message
        }));
      }
    }
  };
}

// Convenience functions
export function string(options) {
  return new ValidationRule('string', options);
}

export function number(options) {
  return new ValidationRule('number', options);
}

export function integer(options) {
  return new ValidationRule('integer', options);
}

export function boolean(options) {
  return new ValidationRule('boolean', options);
}

export function array(items, options) {
  return new ValidationRule('array', { ...options, items });
}

export function object(properties, options) {
  return new ValidationRule('object', { ...options, properties });
}

export function email(options) {
  return new ValidationRule('email', options);
}

export function uuid(options) {
  return new ValidationRule('uuid', options);
}

// Default export
export default {
  Schema,
  ValidationRule,
  ValidationError,
  ValidationType,
  CommonSchemas,
  validateBody,
  validateQuery,
  validateParams,
  string,
  number,
  integer,
  boolean,
  array,
  object,
  email,
  uuid
};
