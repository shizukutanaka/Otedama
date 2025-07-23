const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');

/**
 * Unified error handler for all services
 */
class UnifiedErrorHandler extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // Error categorization
      categories: {
        NETWORK: 'network',
        DATABASE: 'database',
        VALIDATION: 'validation',
        AUTHENTICATION: 'authentication',
        AUTHORIZATION: 'authorization',
        RATE_LIMIT: 'rate_limit',
        RESOURCE: 'resource',
        EXTERNAL_SERVICE: 'external_service',
        INTERNAL: 'internal',
        UNKNOWN: 'unknown'
      },
      
      // Severity levels
      severities: {
        LOW: 'low',
        MEDIUM: 'medium',
        HIGH: 'high',
        CRITICAL: 'critical'
      },
      
      // Retry configuration
      retryableErrors: config.retryableErrors || [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNRESET',
        'EPIPE'
      ],
      
      // Notification thresholds
      notificationThresholds: config.notificationThresholds || {
        critical: 1,
        high: 5,
        medium: 10,
        low: 50
      },
      
      // Rate limiting
      rateLimitWindow: config.rateLimitWindow || 60000, // 1 minute
      maxErrorsPerWindow: config.maxErrorsPerWindow || 100,
      
      // Logging
      logErrors: config.logErrors !== false,
      logStackTrace: config.logStackTrace !== false,
      
      // Callbacks
      onError: config.onError || null,
      onCriticalError: config.onCriticalError || null,
      
      ...config
    };
    
    this.logger = createLogger('error-handler');
    this.errorCounts = new Map();
    this.errorHistory = [];
    this.metrics = {
      totalErrors: 0,
      errorsByCategory: new Map(),
      errorsBySeverity: new Map(),
      errorsByService: new Map()
    };
    
    // Initialize counters
    Object.values(this.config.categories).forEach(cat => 
      this.metrics.errorsByCategory.set(cat, 0)
    );
    Object.values(this.config.severities).forEach(sev => 
      this.metrics.errorsBySeverity.set(sev, 0)
    );
  }
  
  /**
   * Handle an error
   */
  async handleError(error, context = {}) {
    const errorInfo = this.parseError(error, context);
    
    // Log error
    if (this.config.logErrors) {
      this.logError(errorInfo);
    }
    
    // Update metrics
    this.updateMetrics(errorInfo);
    
    // Check rate limits
    if (this.isRateLimited(errorInfo)) {
      this.emit('rate_limited', errorInfo);
      return errorInfo;
    }
    
    // Store in history
    this.addToHistory(errorInfo);
    
    // Check notification thresholds
    this.checkNotificationThresholds(errorInfo);
    
    // Call handlers
    if (this.config.onError) {
      await this.config.onError(errorInfo);
    }
    
    if (errorInfo.severity === this.config.severities.CRITICAL && this.config.onCriticalError) {
      await this.config.onCriticalError(errorInfo);
    }
    
    // Emit events
    this.emit('error', errorInfo);
    this.emit(`error:${errorInfo.category}`, errorInfo);
    this.emit(`error:${errorInfo.severity}`, errorInfo);
    
    return errorInfo;
  }
  
  /**
   * Parse error into structured format
   */
  parseError(error, context) {
    const errorInfo = {
      id: this.generateErrorId(),
      timestamp: new Date(),
      message: error.message || String(error),
      code: error.code || 'UNKNOWN',
      name: error.name || 'Error',
      stack: this.config.logStackTrace ? error.stack : undefined,
      category: this.categorizeError(error),
      severity: this.determineSeverity(error, context),
      service: context.service || 'unknown',
      context: {
        ...context,
        userId: context.userId,
        requestId: context.requestId,
        operation: context.operation,
        metadata: context.metadata || {}
      },
      isRetryable: this.isRetryable(error),
      handled: false
    };
    
    return errorInfo;
  }
  
  /**
   * Categorize error
   */
  categorizeError(error) {
    const code = error.code || '';
    const message = error.message || '';
    
    // Network errors
    if (code.includes('ECONNREFUSED') || code.includes('ETIMEDOUT') || 
        code.includes('ENOTFOUND') || code.includes('ECONNRESET')) {
      return this.config.categories.NETWORK;
    }
    
    // Database errors
    if (code.includes('ER_') || message.includes('database') || 
        message.includes('connection pool')) {
      return this.config.categories.DATABASE;
    }
    
    // Validation errors
    if (error.name === 'ValidationError' || code === 'VALIDATION_ERROR') {
      return this.config.categories.VALIDATION;
    }
    
    // Auth errors
    if (code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED') {
      return this.config.categories.AUTHENTICATION;
    }
    
    if (code === 'FORBIDDEN' || code === 'INSUFFICIENT_PERMISSIONS') {
      return this.config.categories.AUTHORIZATION;
    }
    
    // Rate limit errors
    if (code === 'RATE_LIMIT_EXCEEDED' || message.includes('rate limit')) {
      return this.config.categories.RATE_LIMIT;
    }
    
    // Resource errors
    if (code === 'ENOSPC' || code === 'EMFILE' || code === 'ENOMEM') {
      return this.config.categories.RESOURCE;
    }
    
    // External service errors
    if (message.includes('external') || message.includes('third-party') ||
        message.includes('API')) {
      return this.config.categories.EXTERNAL_SERVICE;
    }
    
    // Default
    return this.config.categories.UNKNOWN;
  }
  
  /**
   * Determine error severity
   */
  determineSeverity(error, context) {
    // Critical errors
    if (error.code === 'ENOSPC' || error.code === 'ENOMEM' ||
        error.name === 'FatalError' || context.severity === 'critical') {
      return this.config.severities.CRITICAL;
    }
    
    // High severity
    if (error.code === 'DATABASE_CONNECTION_LOST' ||
        error.code === 'AUTHENTICATION_SERVICE_DOWN' ||
        context.severity === 'high') {
      return this.config.severities.HIGH;
    }
    
    // Medium severity
    if (error.code === 'VALIDATION_ERROR' || error.code === 'RATE_LIMIT_EXCEEDED' ||
        context.severity === 'medium') {
      return this.config.severities.MEDIUM;
    }
    
    // Low severity
    return this.config.severities.LOW;
  }
  
  /**
   * Check if error is retryable
   */
  isRetryable(error) {
    const code = error.code || '';
    return this.config.retryableErrors.some(retryableCode => 
      code.includes(retryableCode)
    );
  }
  
  /**
   * Log error based on severity
   */
  logError(errorInfo) {
    const logData = {
      id: errorInfo.id,
      category: errorInfo.category,
      service: errorInfo.service,
      code: errorInfo.code,
      message: errorInfo.message,
      context: errorInfo.context
    };
    
    switch (errorInfo.severity) {
      case this.config.severities.CRITICAL:
        this.logger.error('CRITICAL ERROR:', logData, errorInfo.stack);
        break;
      case this.config.severities.HIGH:
        this.logger.error('High severity error:', logData);
        break;
      case this.config.severities.MEDIUM:
        this.logger.warn('Medium severity error:', logData);
        break;
      case this.config.severities.LOW:
        this.logger.info('Low severity error:', logData);
        break;
    }
  }
  
  /**
   * Update metrics
   */
  updateMetrics(errorInfo) {
    this.metrics.totalErrors++;
    
    const categoryCount = this.metrics.errorsByCategory.get(errorInfo.category) || 0;
    this.metrics.errorsByCategory.set(errorInfo.category, categoryCount + 1);
    
    const severityCount = this.metrics.errorsBySeverity.get(errorInfo.severity) || 0;
    this.metrics.errorsBySeverity.set(errorInfo.severity, severityCount + 1);
    
    const serviceCount = this.metrics.errorsByService.get(errorInfo.service) || 0;
    this.metrics.errorsByService.set(errorInfo.service, serviceCount + 1);
  }
  
  /**
   * Check if rate limited
   */
  isRateLimited(errorInfo) {
    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindow;
    
    // Clean old entries
    this.errorHistory = this.errorHistory.filter(e => 
      e.timestamp.getTime() > windowStart
    );
    
    return this.errorHistory.length >= this.config.maxErrorsPerWindow;
  }
  
  /**
   * Add error to history
   */
  addToHistory(errorInfo) {
    this.errorHistory.push(errorInfo);
    
    // Keep history size reasonable
    if (this.errorHistory.length > this.config.maxErrorsPerWindow * 2) {
      this.errorHistory = this.errorHistory.slice(-this.config.maxErrorsPerWindow);
    }
  }
  
  /**
   * Check notification thresholds
   */
  checkNotificationThresholds(errorInfo) {
    const key = `${errorInfo.category}:${errorInfo.severity}`;
    const count = (this.errorCounts.get(key) || 0) + 1;
    this.errorCounts.set(key, count);
    
    const threshold = this.config.notificationThresholds[errorInfo.severity];
    
    if (threshold && count === threshold) {
      this.emit('threshold_reached', {
        category: errorInfo.category,
        severity: errorInfo.severity,
        count,
        threshold
      });
      
      // Reset count
      this.errorCounts.set(key, 0);
    }
  }
  
  /**
   * Generate error ID
   */
  generateErrorId() {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get error statistics
   */
  getStatistics() {
    const recentErrors = this.errorHistory.slice(-100);
    
    return {
      total: this.metrics.totalErrors,
      byCategory: Object.fromEntries(this.metrics.errorsByCategory),
      bySeverity: Object.fromEntries(this.metrics.errorsBySeverity),
      byService: Object.fromEntries(this.metrics.errorsByService),
      recent: recentErrors.map(e => ({
        id: e.id,
        timestamp: e.timestamp,
        category: e.category,
        severity: e.severity,
        service: e.service,
        message: e.message
      })),
      rateLimit: {
        current: this.errorHistory.length,
        max: this.config.maxErrorsPerWindow,
        window: this.config.rateLimitWindow
      }
    };
  }
  
  /**
   * Clear error history
   */
  clearHistory() {
    this.errorHistory = [];
    this.errorCounts.clear();
  }
  
  /**
   * Create error classes
   */
  static createErrorClass(name, code, defaultMessage) {
    return class extends Error {
      constructor(message = defaultMessage, details = {}) {
        super(message);
        this.name = name;
        this.code = code;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
      }
    };
  }
}

// Common error classes
const NetworkError = UnifiedErrorHandler.createErrorClass('NetworkError', 'NETWORK_ERROR', 'Network error occurred');
const DatabaseError = UnifiedErrorHandler.createErrorClass('DatabaseError', 'DATABASE_ERROR', 'Database error occurred');
const ValidationError = UnifiedErrorHandler.createErrorClass('ValidationError', 'VALIDATION_ERROR', 'Validation failed');
const AuthenticationError = UnifiedErrorHandler.createErrorClass('AuthenticationError', 'AUTHENTICATION_ERROR', 'Authentication failed');
const AuthorizationError = UnifiedErrorHandler.createErrorClass('AuthorizationError', 'AUTHORIZATION_ERROR', 'Access denied');
const RateLimitError = UnifiedErrorHandler.createErrorClass('RateLimitError', 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded');
const ResourceError = UnifiedErrorHandler.createErrorClass('ResourceError', 'RESOURCE_ERROR', 'Resource error occurred');

module.exports = {
  UnifiedErrorHandler,
  NetworkError,
  DatabaseError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  ResourceError
};