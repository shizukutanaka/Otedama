const { createLogger } = require('../core/logger');
const { ValidationError } = require('../common/enhanced-error-handler');

/**
 * Input Validation Middleware
 * Provides comprehensive input validation for API routes
 */
class InputValidator {
  constructor(config = {}) {
    this.logger = createLogger('input-validator');
    
    this.config = {
      // Maximum sizes
      maxRequestSize: config.maxRequestSize || '10mb',
      maxFieldSize: config.maxFieldSize || '1mb',
      maxFieldCount: config.maxFieldCount || 1000,
      
      // Validation options
      stripUnknown: config.stripUnknown !== false,
      coerceTypes: config.coerceTypes !== false,
      sanitizeHtml: config.sanitizeHtml !== false,
      
      // Security options
      rejectOnValidationError: config.rejectOnValidationError !== false,
      logValidationErrors: config.logValidationErrors !== false,
      
      // Custom validators
      customValidators: config.customValidators || {},
      
      ...config
    };
    
    // Common validation patterns
    this.patterns = {
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      url: /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/,
      alphanumeric: /^[a-zA-Z0-9]+$/,
      numeric: /^\d+$/,
      decimal: /^\d+(\.\d+)?$/,
      uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      base64: /^[A-Za-z0-9+/]+=*$/,
      hex: /^[0-9a-fA-F]+$/,
      
      // Blockchain specific
      bitcoinAddress: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
      ethereumAddress: /^0x[a-fA-F0-9]{40}$/,
      transactionHash: /^0x[a-fA-F0-9]{64}$/,
      
      // Security patterns
      sqlInjection: /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE)\b)/i,
      scriptTag: /<script[^>]*>.*?<\/script>/gi,
      htmlTag: /<[^>]+>/g,
      
      // Path traversal
      pathTraversal: /\.\./,
      absolutePath: /^[\/\\]/,
      
      // Common exploits
      xxe: /<!ENTITY/i,
      ldapInjection: /[()&|*]/
    };
    
    // Field type definitions
    this.types = {
      string: this.validateString.bind(this),
      number: this.validateNumber.bind(this),
      integer: this.validateInteger.bind(this),
      boolean: this.validateBoolean.bind(this),
      array: this.validateArray.bind(this),
      object: this.validateObject.bind(this),
      date: this.validateDate.bind(this),
      email: this.validateEmail.bind(this),
      url: this.validateUrl.bind(this),
      uuid: this.validateUuid.bind(this),
      
      // Blockchain types
      address: this.validateBlockchainAddress.bind(this),
      hash: this.validateHash.bind(this),
      amount: this.validateAmount.bind(this)
    };
  }
  
  /**
   * Create validation middleware for a schema
   */
  validate(schema) {
    return async (req, res, next) => {
      try {
        // Validate different parts of the request
        const errors = [];
        
        if (schema.params) {
          const paramErrors = await this.validateData(req.params, schema.params, 'params');
          errors.push(...paramErrors);
        }
        
        if (schema.query) {
          const queryErrors = await this.validateData(req.query, schema.query, 'query');
          errors.push(...queryErrors);
        }
        
        if (schema.body) {
          const bodyErrors = await this.validateData(req.body, schema.body, 'body');
          errors.push(...bodyErrors);
        }
        
        if (schema.headers) {
          const headerErrors = await this.validateData(req.headers, schema.headers, 'headers');
          errors.push(...headerErrors);
        }
        
        // Check for validation errors
        if (errors.length > 0) {
          if (this.config.logValidationErrors) {
            this.logger.warn('Validation errors:', {
              path: req.path,
              method: req.method,
              errors
            });
          }
          
          if (this.config.rejectOnValidationError) {
            return res.status(400).json({
              error: 'Validation failed',
              errors: errors.map(e => ({
                field: e.field,
                message: e.message,
                value: this.config.includeValuesInErrors ? e.value : undefined
              }))
            });
          }
        }
        
        // Add validated data to request
        req.validated = {
          params: req.params,
          query: req.query,
          body: req.body
        };
        
        next();
        
      } catch (error) {
        this.logger.error('Validation middleware error:', error);
        res.status(500).json({
          error: 'Internal validation error'
        });
      }
    };
  }
  
  /**
   * Validate data against schema
   */
  async validateData(data, schema, location) {
    const errors = [];
    
    // Check for unknown fields
    if (this.config.stripUnknown) {
      const allowedFields = new Set(Object.keys(schema));
      const dataFields = Object.keys(data);
      
      for (const field of dataFields) {
        if (!allowedFields.has(field)) {
          if (this.config.stripUnknown === 'error') {
            errors.push({
              field: `${location}.${field}`,
              message: 'Unknown field',
              value: data[field]
            });
          } else {
            delete data[field];
          }
        }
      }
    }
    
    // Validate each field
    for (const [field, rules] of Object.entries(schema)) {
      const value = data[field];
      const fieldPath = `${location}.${field}`;
      
      // Check required
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push({
          field: fieldPath,
          message: 'Field is required',
          value
        });
        continue;
      }
      
      // Skip optional empty fields
      if (!rules.required && (value === undefined || value === null || value === '')) {
        continue;
      }
      
      // Validate type
      if (rules.type) {
        const validator = this.types[rules.type] || this.config.customValidators[rules.type];
        
        if (!validator) {
          errors.push({
            field: fieldPath,
            message: `Unknown type: ${rules.type}`,
            value
          });
          continue;
        }
        
        const typeErrors = await validator(value, rules, fieldPath);
        if (typeErrors.length > 0) {
          errors.push(...typeErrors);
          continue;
        }
      }
      
      // Additional validations
      const additionalErrors = await this.validateRules(value, rules, fieldPath);
      errors.push(...additionalErrors);
      
      // Custom validation function
      if (rules.validate && typeof rules.validate === 'function') {
        try {
          const isValid = await rules.validate(value, data);
          if (!isValid) {
            errors.push({
              field: fieldPath,
              message: rules.message || 'Custom validation failed',
              value
            });
          }
        } catch (error) {
          errors.push({
            field: fieldPath,
            message: error.message || 'Custom validation error',
            value
          });
        }
      }
    }
    
    return errors;
  }
  
  /**
   * Validate string type
   */
  async validateString(value, rules, field) {
    const errors = [];
    
    if (typeof value !== 'string') {
      // Try to coerce if enabled
      if (this.config.coerceTypes) {
        value = String(value);
      } else {
        errors.push({
          field,
          message: 'Must be a string',
          value
        });
        return errors;
      }
    }
    
    // Sanitize HTML if enabled
    if (this.config.sanitizeHtml && !rules.allowHtml) {
      value = value.replace(this.patterns.htmlTag, '');
    }
    
    // Check for dangerous patterns
    if (!rules.allowUnsafe) {
      if (this.patterns.sqlInjection.test(value)) {
        errors.push({
          field,
          message: 'Contains potentially dangerous SQL keywords',
          value
        });
      }
      
      if (this.patterns.scriptTag.test(value)) {
        errors.push({
          field,
          message: 'Contains script tags',
          value
        });
      }
      
      if (rules.noPathTraversal && this.patterns.pathTraversal.test(value)) {
        errors.push({
          field,
          message: 'Contains path traversal patterns',
          value
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Validate number type
   */
  async validateNumber(value, rules, field) {
    const errors = [];
    
    if (typeof value !== 'number') {
      // Try to coerce if enabled
      if (this.config.coerceTypes) {
        const num = Number(value);
        if (isNaN(num)) {
          errors.push({
            field,
            message: 'Must be a number',
            value
          });
          return errors;
        }
        value = num;
      } else {
        errors.push({
          field,
          message: 'Must be a number',
          value
        });
        return errors;
      }
    }
    
    // Check for Infinity and NaN
    if (!isFinite(value)) {
      errors.push({
        field,
        message: 'Must be a finite number',
        value
      });
    }
    
    return errors;
  }
  
  /**
   * Validate integer type
   */
  async validateInteger(value, rules, field) {
    const errors = await this.validateNumber(value, rules, field);
    
    if (errors.length === 0 && !Number.isInteger(Number(value))) {
      errors.push({
        field,
        message: 'Must be an integer',
        value
      });
    }
    
    return errors;
  }
  
  /**
   * Validate boolean type
   */
  async validateBoolean(value, rules, field) {
    const errors = [];
    
    if (typeof value !== 'boolean') {
      // Try to coerce if enabled
      if (this.config.coerceTypes) {
        if (value === 'true' || value === '1' || value === 1) {
          value = true;
        } else if (value === 'false' || value === '0' || value === 0) {
          value = false;
        } else {
          errors.push({
            field,
            message: 'Must be a boolean',
            value
          });
        }
      } else {
        errors.push({
          field,
          message: 'Must be a boolean',
          value
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Validate array type
   */
  async validateArray(value, rules, field) {
    const errors = [];
    
    if (!Array.isArray(value)) {
      errors.push({
        field,
        message: 'Must be an array',
        value
      });
      return errors;
    }
    
    // Validate array items if schema provided
    if (rules.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = await this.validateData(
          { item: value[i] },
          { item: rules.items },
          `${field}[${i}]`
        );
        errors.push(...itemErrors.map(e => ({
          ...e,
          field: e.field.replace(`${field}[${i}].item`, `${field}[${i}]`)
        })));
      }
    }
    
    return errors;
  }
  
  /**
   * Validate object type
   */
  async validateObject(value, rules, field) {
    const errors = [];
    
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push({
        field,
        message: 'Must be an object',
        value
      });
      return errors;
    }
    
    // Validate nested properties if schema provided
    if (rules.properties) {
      const nestedErrors = await this.validateData(value, rules.properties, field);
      errors.push(...nestedErrors);
    }
    
    return errors;
  }
  
  /**
   * Validate date type
   */
  async validateDate(value, rules, field) {
    const errors = [];
    
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      errors.push({
        field,
        message: 'Must be a valid date',
        value
      });
    }
    
    return errors;
  }
  
  /**
   * Validate email
   */
  async validateEmail(value, rules, field) {
    const errors = await this.validateString(value, rules, field);
    
    if (errors.length === 0 && !this.patterns.email.test(value)) {
      errors.push({
        field,
        message: 'Must be a valid email address',
        value
      });
    }
    
    return errors;
  }
  
  /**
   * Validate URL
   */
  async validateUrl(value, rules, field) {
    const errors = await this.validateString(value, rules, field);
    
    if (errors.length === 0) {
      try {
        new URL(value);
      } catch (e) {
        errors.push({
          field,
          message: 'Must be a valid URL',
          value
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Validate UUID
   */
  async validateUuid(value, rules, field) {
    const errors = await this.validateString(value, rules, field);
    
    if (errors.length === 0 && !this.patterns.uuid.test(value)) {
      errors.push({
        field,
        message: 'Must be a valid UUID',
        value
      });
    }
    
    return errors;
  }
  
  /**
   * Validate blockchain address
   */
  async validateBlockchainAddress(value, rules, field) {
    const errors = await this.validateString(value, rules, field);
    
    if (errors.length === 0) {
      const blockchain = rules.blockchain || 'bitcoin';
      
      let isValid = false;
      switch (blockchain) {
        case 'bitcoin':
          isValid = this.patterns.bitcoinAddress.test(value);
          break;
        case 'ethereum':
          isValid = this.patterns.ethereumAddress.test(value);
          break;
        default:
          // Generic validation for unknown blockchains
          isValid = /^[a-zA-Z0-9]{20,100}$/.test(value);
      }
      
      if (!isValid) {
        errors.push({
          field,
          message: `Must be a valid ${blockchain} address`,
          value
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Validate transaction hash
   */
  async validateHash(value, rules, field) {
    const errors = await this.validateString(value, rules, field);
    
    if (errors.length === 0) {
      const length = rules.length || 64;
      const pattern = new RegExp(`^(0x)?[a-fA-F0-9]{${length}}$`);
      
      if (!pattern.test(value)) {
        errors.push({
          field,
          message: `Must be a valid hash (${length} characters)`,
          value
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Validate cryptocurrency amount
   */
  async validateAmount(value, rules, field) {
    const errors = await this.validateNumber(value, rules, field);
    
    if (errors.length === 0) {
      const num = Number(value);
      
      // Check for negative amounts
      if (num < 0) {
        errors.push({
          field,
          message: 'Amount cannot be negative',
          value
        });
      }
      
      // Check decimal places
      const decimals = rules.decimals || 8;
      const decimalPart = String(value).split('.')[1];
      if (decimalPart && decimalPart.length > decimals) {
        errors.push({
          field,
          message: `Too many decimal places (max ${decimals})`,
          value
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Validate additional rules
   */
  async validateRules(value, rules, field) {
    const errors = [];
    
    // Length validations
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      errors.push({
        field,
        message: `Minimum length is ${rules.minLength}`,
        value
      });
    }
    
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      errors.push({
        field,
        message: `Maximum length is ${rules.maxLength}`,
        value
      });
    }
    
    // Numeric validations
    if (rules.min !== undefined && Number(value) < rules.min) {
      errors.push({
        field,
        message: `Minimum value is ${rules.min}`,
        value
      });
    }
    
    if (rules.max !== undefined && Number(value) > rules.max) {
      errors.push({
        field,
        message: `Maximum value is ${rules.max}`,
        value
      });
    }
    
    // Pattern validation
    if (rules.pattern) {
      const pattern = new RegExp(rules.pattern);
      if (!pattern.test(value)) {
        errors.push({
          field,
          message: rules.patternMessage || `Does not match pattern: ${rules.pattern}`,
          value
        });
      }
    }
    
    // Enum validation
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push({
        field,
        message: `Must be one of: ${rules.enum.join(', ')}`,
        value
      });
    }
    
    // Array validations
    if (Array.isArray(value)) {
      if (rules.minItems !== undefined && value.length < rules.minItems) {
        errors.push({
          field,
          message: `Minimum items is ${rules.minItems}`,
          value
        });
      }
      
      if (rules.maxItems !== undefined && value.length > rules.maxItems) {
        errors.push({
          field,
          message: `Maximum items is ${rules.maxItems}`,
          value
        });
      }
      
      if (rules.unique && new Set(value).size !== value.length) {
        errors.push({
          field,
          message: 'Items must be unique',
          value
        });
      }
    }
    
    return errors;
  }
  
  /**
   * Common validation schemas
   */
  static schemas = {
    // User authentication
    login: {
      body: {
        username: {
          type: 'string',
          required: true,
          minLength: 3,
          maxLength: 50,
          pattern: '^[a-zA-Z0-9_-]+$'
        },
        password: {
          type: 'string',
          required: true,
          minLength: 8,
          maxLength: 100
        },
        twoFactorCode: {
          type: 'string',
          pattern: '^[0-9]{6}$'
        }
      }
    },
    
    // Wallet operations
    withdrawal: {
      body: {
        address: {
          type: 'address',
          required: true
        },
        amount: {
          type: 'amount',
          required: true,
          min: 0.00000001,
          decimals: 8
        },
        twoFactorCode: {
          type: 'string',
          required: true,
          pattern: '^[0-9]{6}$'
        }
      }
    },
    
    // Mining operations
    submitShare: {
      body: {
        minerId: {
          type: 'string',
          required: true
        },
        jobId: {
          type: 'string',
          required: true
        },
        nonce: {
          type: 'string',
          required: true,
          pattern: '^[0-9a-fA-F]+$'
        },
        hash: {
          type: 'hash',
          required: true
        }
      }
    },
    
    // API key creation
    createApiKey: {
      body: {
        name: {
          type: 'string',
          required: true,
          minLength: 3,
          maxLength: 50
        },
        permissions: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['read', 'write', 'admin']
          }
        },
        expiresIn: {
          type: 'integer',
          min: 3600,
          max: 31536000
        }
      }
    }
  };
}

// Export singleton instance
const inputValidator = new InputValidator();

module.exports = {
  InputValidator,
  inputValidator,
  validate: (schema) => inputValidator.validate(schema),
  schemas: InputValidator.schemas
};