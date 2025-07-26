/**
 * Error Definitions for Otedama
 * Custom error classes for better error handling
 * 
 * Design: Clean error handling (Martin principle)
 */

/**
 * Base error class
 */
export class OtedamaError extends Error {
  constructor(message, code = 'OTEDAMA_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = Date.now();
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation error
 */
export class ValidationError extends OtedamaError {
  constructor(message, field = null) {
    super(message, 'VALIDATION_ERROR');
    this.field = field;
  }
}

/**
 * Authentication error
 */
export class AuthenticationError extends OtedamaError {
  constructor(message) {
    super(message, 'AUTH_ERROR');
  }
}

/**
 * Authorization error
 */
export class AuthorizationError extends OtedamaError {
  constructor(message) {
    super(message, 'AUTHZ_ERROR');
  }
}

/**
 * Rate limit error
 */
export class RateLimitError extends OtedamaError {
  constructor(message, retryAfter = null) {
    super(message, 'RATE_LIMIT_ERROR');
    this.retryAfter = retryAfter;
  }
}

/**
 * Configuration error
 */
export class ConfigurationError extends OtedamaError {
  constructor(message, configKey = null) {
    super(message, 'CONFIG_ERROR');
    this.configKey = configKey;
  }
}

/**
 * Network error
 */
export class NetworkError extends OtedamaError {
  constructor(message, statusCode = null) {
    super(message, 'NETWORK_ERROR');
    this.statusCode = statusCode;
  }
}

/**
 * Mining error
 */
export class MiningError extends OtedamaError {
  constructor(message, algorithm = null) {
    super(message, 'MINING_ERROR');
    this.algorithm = algorithm;
  }
}

/**
 * Pool error
 */
export class PoolError extends OtedamaError {
  constructor(message, pool = null) {
    super(message, 'POOL_ERROR');
    this.pool = pool;
  }
}

/**
 * Worker error
 */
export class WorkerError extends OtedamaError {
  constructor(message, workerId = null) {
    super(message, 'WORKER_ERROR');
    this.workerId = workerId;
  }
}

/**
 * Database error
 */
export class DatabaseError extends OtedamaError {
  constructor(message, query = null) {
    super(message, 'DATABASE_ERROR');
    this.query = query;
  }
}

/**
 * Timeout error
 */
export class TimeoutError extends OtedamaError {
  constructor(message, timeout = null) {
    super(message, 'TIMEOUT_ERROR');
    this.timeout = timeout;
  }
}

/**
 * Not found error
 */
export class NotFoundError extends OtedamaError {
  constructor(message, resource = null) {
    super(message, 'NOT_FOUND_ERROR');
    this.resource = resource;
  }
}

/**
 * Conflict error
 */
export class ConflictError extends OtedamaError {
  constructor(message, conflicts = null) {
    super(message, 'CONFLICT_ERROR');
    this.conflicts = conflicts;
  }
}

/**
 * Internal server error
 */
export class InternalError extends OtedamaError {
  constructor(message, details = null) {
    super(message, 'INTERNAL_ERROR');
    this.details = details;
  }
}

/**
 * Error utilities
 */
export const ErrorUtils = {
  /**
   * Check if error is retryable
   */
  isRetryable(error) {
    return error instanceof NetworkError ||
           error instanceof TimeoutError ||
           (error instanceof RateLimitError && error.retryAfter);
  },

  /**
   * Get HTTP status code for error
   */
  getStatusCode(error) {
    if (error instanceof ValidationError) return 400;
    if (error instanceof AuthenticationError) return 401;
    if (error instanceof AuthorizationError) return 403;
    if (error instanceof NotFoundError) return 404;
    if (error instanceof ConflictError) return 409;
    if (error instanceof RateLimitError) return 429;
    if (error instanceof InternalError) return 500;
    if (error instanceof NetworkError && error.statusCode) return error.statusCode;
    return 500;
  },

  /**
   * Format error for response
   */
  formatError(error) {
    return {
      error: {
        code: error.code || 'UNKNOWN_ERROR',
        message: error.message,
        field: error.field,
        timestamp: error.timestamp || Date.now()
      }
    };
  }
};

export default {
  OtedamaError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  ConfigurationError,
  NetworkError,
  MiningError,
  PoolError,
  WorkerError,
  DatabaseError,
  TimeoutError,
  NotFoundError,
  ConflictError,
  InternalError,
  ErrorUtils
};