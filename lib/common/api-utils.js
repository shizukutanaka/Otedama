/**
 * Common API utilities for consistent error handling and responses
 */

/**
 * Standard API response wrapper
 */
function apiResponse(res, statusCode, data = null, error = null) {
  const response = {
    success: statusCode < 400,
    timestamp: new Date().toISOString()
  };
  
  if (error) {
    response.error = {
      message: error.message || error,
      code: error.code || 'UNKNOWN_ERROR'
    };
    
    // Add details in development
    if (process.env.NODE_ENV === 'development' && error.stack) {
      response.error.stack = error.stack;
    }
  }
  
  if (data !== null) {
    response.data = data;
  }
  
  res.status(statusCode).json(response);
}

/**
 * Success response helper
 */
function successResponse(res, data = null, statusCode = 200) {
  apiResponse(res, statusCode, data);
}

/**
 * Error response helper
 */
function errorResponse(res, error, statusCode = 500) {
  // Log error
  if (res.app?.locals?.logger) {
    res.app.locals.logger.error('API Error:', error);
  } else {
    console.error('API Error:', error);
  }
  
  apiResponse(res, statusCode, null, error);
}

/**
 * Validation error response
 */
function validationError(res, errors) {
  const error = {
    message: 'Validation failed',
    code: 'VALIDATION_ERROR',
    errors: Array.isArray(errors) ? errors : [errors]
  };
  
  apiResponse(res, 400, null, error);
}

/**
 * Not found error response
 */
function notFoundError(res, resource = 'Resource') {
  const error = {
    message: `${resource} not found`,
    code: 'NOT_FOUND'
  };
  
  apiResponse(res, 404, null, error);
}

/**
 * Unauthorized error response
 */
function unauthorizedError(res, message = 'Unauthorized') {
  const error = {
    message,
    code: 'UNAUTHORIZED'
  };
  
  apiResponse(res, 401, null, error);
}

/**
 * Forbidden error response
 */
function forbiddenError(res, message = 'Forbidden') {
  const error = {
    message,
    code: 'FORBIDDEN'
  };
  
  apiResponse(res, 403, null, error);
}

/**
 * Service unavailable error
 */
function serviceUnavailableError(res, service = 'Service') {
  const error = {
    message: `${service} is temporarily unavailable`,
    code: 'SERVICE_UNAVAILABLE'
  };
  
  apiResponse(res, 503, null, error);
}

/**
 * Rate limit error
 */
function rateLimitError(res, retryAfter = 60) {
  const error = {
    message: 'Too many requests',
    code: 'RATE_LIMIT_EXCEEDED'
  };
  
  res.set('Retry-After', retryAfter);
  apiResponse(res, 429, null, error);
}

/**
 * Async route handler wrapper
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Check if service is available
 */
function checkService(req, res, serviceName = 'service') {
  const service = req.app?.locals?.[serviceName];
  
  if (!service) {
    serviceUnavailableError(res, serviceName);
    return null;
  }
  
  return service;
}

/**
 * Pagination helper
 */
function paginate(query) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const offset = (page - 1) * limit;
  
  return { page, limit, offset };
}

/**
 * Sort helper
 */
function parseSort(sortString, allowedFields = []) {
  if (!sortString) return {};
  
  const parts = sortString.split(':');
  const field = parts[0];
  const order = parts[1] === 'desc' ? 'DESC' : 'ASC';
  
  if (allowedFields.length > 0 && !allowedFields.includes(field)) {
    return {};
  }
  
  return { field, order };
}

/**
 * Filter helper
 */
function parseFilters(query, allowedFilters = {}) {
  const filters = {};
  
  for (const [key, type] of Object.entries(allowedFilters)) {
    if (query[key] !== undefined) {
      switch (type) {
        case 'string':
          filters[key] = String(query[key]);
          break;
        case 'number':
          filters[key] = Number(query[key]);
          break;
        case 'boolean':
          filters[key] = query[key] === 'true';
          break;
        case 'date':
          filters[key] = new Date(query[key]);
          break;
        case 'array':
          filters[key] = Array.isArray(query[key]) ? query[key] : [query[key]];
          break;
        default:
          filters[key] = query[key];
      }
    }
  }
  
  return filters;
}

/**
 * Request validation middleware
 */
function validateRequest(schema) {
  return (req, res, next) => {
    const errors = [];
    
    // Validate body
    if (schema.body) {
      const bodyErrors = validateSchema(req.body, schema.body);
      errors.push(...bodyErrors.map(e => ({ location: 'body', ...e })));
    }
    
    // Validate query
    if (schema.query) {
      const queryErrors = validateSchema(req.query, schema.query);
      errors.push(...queryErrors.map(e => ({ location: 'query', ...e })));
    }
    
    // Validate params
    if (schema.params) {
      const paramsErrors = validateSchema(req.params, schema.params);
      errors.push(...paramsErrors.map(e => ({ location: 'params', ...e })));
    }
    
    if (errors.length > 0) {
      validationError(res, errors);
      return;
    }
    
    next();
  };
}

/**
 * Simple schema validation
 */
function validateSchema(data, schema) {
  const errors = [];
  
  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];
    
    // Required check
    if (rules.required && (value === undefined || value === null || value === '')) {
      errors.push({
        field,
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
          message: `${field} must be of type ${rules.type}`
        });
        continue;
      }
    }
    
    // Min/Max for numbers
    if (rules.type === 'number') {
      if (rules.min !== undefined && value < rules.min) {
        errors.push({
          field,
          message: `${field} must be at least ${rules.min}`
        });
      }
      if (rules.max !== undefined && value > rules.max) {
        errors.push({
          field,
          message: `${field} must be at most ${rules.max}`
        });
      }
    }
    
    // Length for strings
    if (rules.type === 'string') {
      if (rules.minLength !== undefined && value.length < rules.minLength) {
        errors.push({
          field,
          message: `${field} must be at least ${rules.minLength} characters`
        });
      }
      if (rules.maxLength !== undefined && value.length > rules.maxLength) {
        errors.push({
          field,
          message: `${field} must be at most ${rules.maxLength} characters`
        });
      }
      if (rules.pattern && !rules.pattern.test(value)) {
        errors.push({
          field,
          message: `${field} has invalid format`
        });
      }
    }
    
    // Custom validation
    if (rules.validate) {
      const error = rules.validate(value);
      if (error) {
        errors.push({
          field,
          message: error
        });
      }
    }
  }
  
  return errors;
}

/**
 * CORS headers middleware
 */
function corsHeaders(allowedOrigins = '*') {
  return (req, res, next) => {
    const origin = req.headers.origin;
    
    if (allowedOrigins === '*') {
      res.header('Access-Control-Allow-Origin', '*');
    } else if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    }
    
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Max-Age', '86400');
    
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
    } else {
      next();
    }
  };
}

/**
 * Request ID middleware
 */
function requestId() {
  return (req, res, next) => {
    req.id = req.headers['x-request-id'] || generateRequestId();
    res.setHeader('X-Request-ID', req.id);
    next();
  };
}

/**
 * Generate request ID
 */
function generateRequestId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * API versioning middleware
 */
function apiVersion(supportedVersions = ['v1']) {
  return (req, res, next) => {
    const version = req.headers['api-version'] || req.query.v || 'v1';
    
    if (!supportedVersions.includes(version)) {
      errorResponse(res, {
        message: 'Unsupported API version',
        code: 'UNSUPPORTED_VERSION',
        supportedVersions
      }, 400);
      return;
    }
    
    req.apiVersion = version;
    next();
  };
}

module.exports = {
  apiResponse,
  successResponse,
  errorResponse,
  validationError,
  notFoundError,
  unauthorizedError,
  forbiddenError,
  serviceUnavailableError,
  rateLimitError,
  asyncHandler,
  checkService,
  paginate,
  parseSort,
  parseFilters,
  validateRequest,
  corsHeaders,
  requestId,
  apiVersion
};