/**
 * Common validation utilities
 */

/**
 * Validate email address
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate phone number
 */
function isValidPhone(phone) {
  const phoneRegex = /^\+?[\d\s-()]+$/;
  return phone && phone.length >= 10 && phoneRegex.test(phone);
}

/**
 * Validate URL
 */
function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate IP address (v4 or v6)
 */
function isValidIP(ip) {
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([\da-f]{1,4}:){7}[\da-f]{1,4}$/i;
  
  if (ipv4Regex.test(ip)) {
    return ip.split('.').every(part => parseInt(part) <= 255);
  }
  
  return ipv6Regex.test(ip);
}

/**
 * Validate port number
 */
function isValidPort(port) {
  const portNum = parseInt(port);
  return !isNaN(portNum) && portNum > 0 && portNum <= 65535;
}

/**
 * Validate date
 */
function isValidDate(date) {
  const d = new Date(date);
  return d instanceof Date && !isNaN(d);
}

/**
 * Validate UUID
 */
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Validate cryptocurrency address
 */
function isValidCryptoAddress(address, type = 'bitcoin') {
  const patterns = {
    bitcoin: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/,
    ethereum: /^0x[a-fA-F0-9]{40}$/,
    litecoin: /^[LM3][a-km-zA-HJ-NP-Z1-9]{26,33}$/,
    dogecoin: /^D{1}[5-9A-HJ-NP-U]{1}[1-9A-HJ-NP-Za-km-z]{32}$/
  };
  
  const pattern = patterns[type.toLowerCase()];
  return pattern ? pattern.test(address) : false;
}

/**
 * Validate number range
 */
function isInRange(value, min, max) {
  const num = parseFloat(value);
  return !isNaN(num) && num >= min && num <= max;
}

/**
 * Validate string length
 */
function isValidLength(str, minLength, maxLength) {
  return str && str.length >= minLength && str.length <= maxLength;
}

/**
 * Validate alphanumeric
 */
function isAlphanumeric(str) {
  return /^[a-zA-Z0-9]+$/.test(str);
}

/**
 * Validate username
 */
function isValidUsername(username) {
  const usernameRegex = /^[a-zA-Z0-9_-]{3,20}$/;
  return usernameRegex.test(username);
}

/**
 * Validate password strength
 */
function isStrongPassword(password) {
  // At least 8 characters, one uppercase, one lowercase, one number, one special char
  const strongRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
  return strongRegex.test(password);
}

/**
 * Sanitize string input
 */
function sanitizeString(str, options = {}) {
  const {
    trim = true,
    lowercase = false,
    uppercase = false,
    removeSpaces = false,
    alphanumericOnly = false,
    maxLength = null
  } = options;
  
  let result = String(str || '');
  
  if (trim) result = result.trim();
  if (lowercase) result = result.toLowerCase();
  if (uppercase) result = result.toUpperCase();
  if (removeSpaces) result = result.replace(/\s+/g, '');
  if (alphanumericOnly) result = result.replace(/[^a-zA-Z0-9]/g, '');
  if (maxLength) result = result.substring(0, maxLength);
  
  return result;
}

/**
 * Sanitize number input
 */
function sanitizeNumber(value, options = {}) {
  const {
    min = -Infinity,
    max = Infinity,
    decimals = null,
    defaultValue = 0
  } = options;
  
  const num = parseFloat(value);
  
  if (isNaN(num)) return defaultValue;
  
  let result = Math.max(min, Math.min(max, num));
  
  if (decimals !== null) {
    result = parseFloat(result.toFixed(decimals));
  }
  
  return result;
}

/**
 * Validate object against schema
 */
function validateObject(obj, schema) {
  const errors = [];
  
  for (const [field, rules] of Object.entries(schema)) {
    const value = obj[field];
    
    // Required check
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push({
        field,
        rule: 'required',
        message: `${field} is required`
      });
      continue;
    }
    
    if (value === undefined || value === null) continue;
    
    // Type check
    if (rules.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== rules.type) {
        errors.push({
          field,
          rule: 'type',
          message: `${field} must be of type ${rules.type}`
        });
        continue;
      }
    }
    
    // Custom validators
    if (rules.validate) {
      const validators = Array.isArray(rules.validate) ? rules.validate : [rules.validate];
      
      for (const validator of validators) {
        const result = validator(value, obj);
        if (result !== true) {
          errors.push({
            field,
            rule: 'custom',
            message: result || `${field} validation failed`
          });
        }
      }
    }
    
    // Built-in validators
    if (rules.email && !isValidEmail(value)) {
      errors.push({
        field,
        rule: 'email',
        message: `${field} must be a valid email`
      });
    }
    
    if (rules.url && !isValidUrl(value)) {
      errors.push({
        field,
        rule: 'url',
        message: `${field} must be a valid URL`
      });
    }
    
    if (rules.minLength && value.length < rules.minLength) {
      errors.push({
        field,
        rule: 'minLength',
        message: `${field} must be at least ${rules.minLength} characters`
      });
    }
    
    if (rules.maxLength && value.length > rules.maxLength) {
      errors.push({
        field,
        rule: 'maxLength',
        message: `${field} must be at most ${rules.maxLength} characters`
      });
    }
    
    if (rules.min !== undefined && value < rules.min) {
      errors.push({
        field,
        rule: 'min',
        message: `${field} must be at least ${rules.min}`
      });
    }
    
    if (rules.max !== undefined && value > rules.max) {
      errors.push({
        field,
        rule: 'max',
        message: `${field} must be at most ${rules.max}`
      });
    }
    
    if (rules.pattern && !rules.pattern.test(value)) {
      errors.push({
        field,
        rule: 'pattern',
        message: `${field} has invalid format`
      });
    }
    
    if (rules.enum && !rules.enum.includes(value)) {
      errors.push({
        field,
        rule: 'enum',
        message: `${field} must be one of: ${rules.enum.join(', ')}`
      });
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Create validation middleware
 */
function createValidator(schema) {
  return (data) => {
    return validateObject(data, schema);
  };
}

/**
 * Validation builders
 */
const validators = {
  string: (options = {}) => ({
    type: 'string',
    ...options
  }),
  
  number: (options = {}) => ({
    type: 'number',
    ...options
  }),
  
  boolean: () => ({
    type: 'boolean'
  }),
  
  array: (options = {}) => ({
    type: 'array',
    ...options
  }),
  
  object: (options = {}) => ({
    type: 'object',
    ...options
  }),
  
  email: (options = {}) => ({
    type: 'string',
    email: true,
    ...options
  }),
  
  url: (options = {}) => ({
    type: 'string',
    url: true,
    ...options
  }),
  
  date: (options = {}) => ({
    type: 'string',
    validate: isValidDate,
    ...options
  }),
  
  uuid: (options = {}) => ({
    type: 'string',
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ...options
  }),
  
  cryptoAddress: (type = 'bitcoin', options = {}) => ({
    type: 'string',
    validate: (value) => isValidCryptoAddress(value, type) || `Invalid ${type} address`,
    ...options
  })
};

module.exports = {
  // Validators
  isValidEmail,
  isValidPhone,
  isValidUrl,
  isValidIP,
  isValidPort,
  isValidDate,
  isValidUUID,
  isValidCryptoAddress,
  isInRange,
  isValidLength,
  isAlphanumeric,
  isValidUsername,
  isStrongPassword,
  
  // Sanitizers
  sanitizeString,
  sanitizeNumber,
  
  // Object validation
  validateObject,
  createValidator,
  validators
};