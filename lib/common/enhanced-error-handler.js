const { EventEmitter } = require('events');
const { createLogger } = require('../core/logger');
const crypto = require('crypto');

/**
 * Enhanced error handler with improved error recovery and monitoring
 */
class EnhancedErrorHandler extends EventEmitter {
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
        BLOCKCHAIN: 'blockchain',
        MINING: 'mining',
        PAYMENT: 'payment',
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
      
      // Recovery strategies
      recoveryStrategies: {
        RETRY: 'retry',
        FALLBACK: 'fallback',
        CIRCUIT_BREAK: 'circuit_break',
        DEGRADE: 'degrade',
        FAIL_FAST: 'fail_fast'
      },
      
      // Retry configuration
      retryableErrors: config.retryableErrors || [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNRESET',
        'EPIPE',
        'EHOSTUNREACH',
        'EAI_AGAIN'
      ],
      
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      retryBackoff: config.retryBackoff || 2,
      
      // Circuit breaker configuration
      circuitBreaker: {
        enabled: config.circuitBreaker?.enabled !== false,
        threshold: config.circuitBreaker?.threshold || 5,
        timeout: config.circuitBreaker?.timeout || 60000,
        resetTimeout: config.circuitBreaker?.resetTimeout || 30000
      },
      
      // Notification thresholds
      notificationThresholds: config.notificationThresholds || {
        critical: 1,
        high: 5,
        medium: 10,
        low: 50
      },
      
      // Rate limiting
      rateLimitWindow: config.rateLimitWindow || 60000,
      maxErrorsPerWindow: config.maxErrorsPerWindow || 100,
      
      // Logging
      logErrors: config.logErrors !== false,
      logStackTrace: config.logStackTrace !== false,
      sensitivePatterns: config.sensitivePatterns || [
        /password["\s]*[:=]["\s]*["']?([^"',\s]+)/gi,
        /api[_-]?key["\s]*[:=]["\s]*["']?([^"',\s]+)/gi,
        /private[_-]?key["\s]*[:=]["\s]*["']?([^"',\s]+)/gi,
        /secret["\s]*[:=]["\s]*["']?([^"',\s]+)/gi,
        /token["\s]*[:=]["\s]*["']?([^"',\s]+)/gi
      ],
      
      // Monitoring
      enableMetrics: config.enableMetrics !== false,
      metricsInterval: config.metricsInterval || 60000,
      
      // Callbacks
      onError: config.onError || null,
      onCriticalError: config.onCriticalError || null,
      onRecovery: config.onRecovery || null,
      
      ...config
    };
    
    this.logger = createLogger('error-handler');
    this.errorCounts = new Map();
    this.errorHistory = [];
    this.circuitBreakers = new Map();
    this.recoveryAttempts = new Map();
    
    this.metrics = {
      totalErrors: 0,
      errorsByCategory: new Map(),
      errorsBySeverity: new Map(),
      errorsByService: new Map(),
      recoveryAttempts: 0,
      successfulRecoveries: 0,
      failedRecoveries: 0
    };
    
    // Initialize counters
    Object.values(this.config.categories).forEach(cat => 
      this.metrics.errorsByCategory.set(cat, 0)
    );
    Object.values(this.config.severities).forEach(sev => 
      this.metrics.errorsBySeverity.set(sev, 0)
    );
    
    // Setup global handlers
    this.setupGlobalHandlers();
    
    // Start metrics collection
    if (this.config.enableMetrics) {
      this.startMetricsCollection();
    }
  }
  
  /**
   * Setup global error handlers
   */
  setupGlobalHandlers() {
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught Exception:', error);
      this.handleError(error, {
        type: 'uncaughtException',
        severity: 'critical',
        service: 'global'
      }).then(() => {
        // Give time for logging before exit
        setTimeout(() => process.exit(1), 1000);
      });
    });
    
    // Handle unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
      this.handleError(reason, {
        type: 'unhandledRejection',
        severity: 'high',
        service: 'global'
      });
    });
    
    // Handle warnings
    process.on('warning', (warning) => {
      this.logger.warn('Process Warning:', warning);
    });
  }
  
  /**
   * Handle an error with recovery strategies
   */
  async handleError(error, context = {}) {
    const errorInfo = this.parseError(error, context);
    
    // Sanitize error information
    errorInfo.message = this.sanitizeSensitiveData(errorInfo.message);
    if (errorInfo.stack) {
      errorInfo.stack = this.sanitizeSensitiveData(errorInfo.stack);
    }
    
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
    
    // Determine recovery strategy
    const strategy = this.determineRecoveryStrategy(errorInfo);
    errorInfo.recoveryStrategy = strategy;
    
    // Attempt recovery
    if (strategy !== this.config.recoveryStrategies.FAIL_FAST) {
      const recovered = await this.attemptRecovery(errorInfo, strategy);
      errorInfo.recovered = recovered;
      
      if (recovered && this.config.onRecovery) {
        await this.config.onRecovery(errorInfo);
      }
    }
    
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
      category: this.categorizeError(error, context),
      severity: this.determineSeverity(error, context),
      service: context.service || 'unknown',
      context: {
        ...context,
        userId: context.userId,
        requestId: context.requestId || this.generateRequestId(),
        operation: context.operation,
        metadata: context.metadata || {}
      },
      isRetryable: this.isRetryable(error),
      handled: false,
      attempts: 0,
      lastAttempt: null
    };
    
    // Add error-specific details
    if (error.response) {
      errorInfo.httpStatus = error.response.status;
      errorInfo.httpStatusText = error.response.statusText;
    }
    
    if (error.syscall) {
      errorInfo.syscall = error.syscall;
    }
    
    if (error.errno) {
      errorInfo.errno = error.errno;
    }
    
    return errorInfo;
  }
  
  /**
   * Enhanced error categorization
   */
  categorizeError(error, context) {
    const code = error.code || '';
    const message = error.message || '';
    
    // Check context first
    if (context.category) {
      return context.category;
    }
    
    // Network errors
    if (code.includes('ECONNREFUSED') || code.includes('ETIMEDOUT') || 
        code.includes('ENOTFOUND') || code.includes('ECONNRESET') ||
        code.includes('EHOSTUNREACH') || code.includes('ENETUNREACH')) {
      return this.config.categories.NETWORK;
    }
    
    // Database errors
    if (code.includes('ER_') || message.includes('database') || 
        message.includes('connection pool') || code.includes('SQLITE')) {
      return this.config.categories.DATABASE;
    }
    
    // Blockchain errors
    if (message.includes('blockchain') || message.includes('block') ||
        message.includes('transaction') || code.includes('RPC')) {
      return this.config.categories.BLOCKCHAIN;
    }
    
    // Mining errors
    if (message.includes('mining') || message.includes('hash') ||
        message.includes('difficulty') || message.includes('nonce')) {
      return this.config.categories.MINING;
    }
    
    // Payment errors
    if (message.includes('payment') || message.includes('payout') ||
        message.includes('wallet') || message.includes('balance')) {
      return this.config.categories.PAYMENT;
    }
    
    // Validation errors
    if (error.name === 'ValidationError' || code === 'VALIDATION_ERROR' ||
        message.includes('invalid') || message.includes('required')) {
      return this.config.categories.VALIDATION;
    }
    
    // Auth errors
    if (code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED' ||
        message.includes('unauthorized') || message.includes('authentication')) {
      return this.config.categories.AUTHENTICATION;
    }
    
    if (code === 'FORBIDDEN' || code === 'INSUFFICIENT_PERMISSIONS' ||
        message.includes('forbidden') || message.includes('permission')) {
      return this.config.categories.AUTHORIZATION;
    }
    
    // Rate limit errors
    if (code === 'RATE_LIMIT_EXCEEDED' || message.includes('rate limit') ||
        message.includes('too many requests')) {
      return this.config.categories.RATE_LIMIT;
    }
    
    // Resource errors
    if (code === 'ENOSPC' || code === 'EMFILE' || code === 'ENOMEM' ||
        message.includes('memory') || message.includes('disk space')) {
      return this.config.categories.RESOURCE;
    }
    
    // External service errors
    if (message.includes('external') || message.includes('third-party') ||
        message.includes('API') || error.isAxiosError) {
      return this.config.categories.EXTERNAL_SERVICE;
    }
    
    // Internal errors
    if (error.stack && error.stack.includes('at ')) {
      return this.config.categories.INTERNAL;
    }
    
    // Default
    return this.config.categories.UNKNOWN;
  }
  
  /**
   * Enhanced severity determination
   */
  determineSeverity(error, context) {
    // Context override
    if (context.severity) {
      return context.severity;
    }
    
    // Critical errors
    if (error.code === 'ENOSPC' || error.code === 'ENOMEM' ||
        error.name === 'FatalError' || error.fatal === true ||
        context.type === 'uncaughtException') {
      return this.config.severities.CRITICAL;
    }
    
    // High severity
    if (error.code === 'DATABASE_CONNECTION_LOST' ||
        error.code === 'AUTHENTICATION_SERVICE_DOWN' ||
        error.code === 'BLOCKCHAIN_UNREACHABLE' ||
        context.type === 'unhandledRejection' ||
        (error.httpStatus && error.httpStatus >= 500)) {
      return this.config.severities.HIGH;
    }
    
    // Medium severity
    if (error.code === 'VALIDATION_ERROR' || error.code === 'RATE_LIMIT_EXCEEDED' ||
        (error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500)) {
      return this.config.severities.MEDIUM;
    }
    
    // Low severity
    return this.config.severities.LOW;
  }
  
  /**
   * Determine recovery strategy
   */
  determineRecoveryStrategy(errorInfo) {
    // Check circuit breaker first
    if (this.isCircuitOpen(errorInfo.service)) {
      return this.config.recoveryStrategies.CIRCUIT_BREAK;
    }
    
    // Resource errors - degrade service
    if (errorInfo.category === this.config.categories.RESOURCE) {
      return this.config.recoveryStrategies.DEGRADE;
    }
    
    // Retryable errors
    if (errorInfo.isRetryable) {
      const attempts = this.getRecoveryAttempts(errorInfo);
      if (attempts < this.config.maxRetries) {
        return this.config.recoveryStrategies.RETRY;
      }
    }
    
    // External service errors - try fallback
    if (errorInfo.category === this.config.categories.EXTERNAL_SERVICE ||
        errorInfo.category === this.config.categories.BLOCKCHAIN) {
      return this.config.recoveryStrategies.FALLBACK;
    }
    
    // Critical errors - fail fast
    if (errorInfo.severity === this.config.severities.CRITICAL) {
      return this.config.recoveryStrategies.FAIL_FAST;
    }
    
    // Default to fallback
    return this.config.recoveryStrategies.FALLBACK;
  }
  
  /**
   * Attempt recovery based on strategy
   */
  async attemptRecovery(errorInfo, strategy) {
    this.metrics.recoveryAttempts++;
    
    try {
      switch (strategy) {
        case this.config.recoveryStrategies.RETRY:
          return await this.retryOperation(errorInfo);
          
        case this.config.recoveryStrategies.FALLBACK:
          return await this.fallbackOperation(errorInfo);
          
        case this.config.recoveryStrategies.CIRCUIT_BREAK:
          return await this.circuitBreakOperation(errorInfo);
          
        case this.config.recoveryStrategies.DEGRADE:
          return await this.degradeOperation(errorInfo);
          
        default:
          return false;
      }
    } catch (recoveryError) {
      this.logger.error('Recovery failed:', recoveryError);
      this.metrics.failedRecoveries++;
      return false;
    }
  }
  
  /**
   * Retry operation with exponential backoff
   */
  async retryOperation(errorInfo) {
    const attempts = this.incrementRecoveryAttempts(errorInfo);
    const delay = this.config.retryDelay * Math.pow(this.config.retryBackoff, attempts - 1);
    
    this.logger.info(`Retrying operation (attempt ${attempts}/${this.config.maxRetries}) after ${delay}ms`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    // Emit retry event for the application to handle
    this.emit('retry', {
      errorInfo,
      attempt: attempts,
      maxAttempts: this.config.maxRetries,
      delay
    });
    
    return true;
  }
  
  /**
   * Fallback to alternative operation
   */
  async fallbackOperation(errorInfo) {
    this.logger.info('Attempting fallback operation');
    
    // Emit fallback event for the application to handle
    this.emit('fallback', {
      errorInfo,
      originalService: errorInfo.service,
      category: errorInfo.category
    });
    
    return true;
  }
  
  /**
   * Circuit breaker operation
   */
  async circuitBreakOperation(errorInfo) {
    const breaker = this.getCircuitBreaker(errorInfo.service);
    
    if (breaker.state === 'open') {
      this.logger.warn(`Circuit breaker open for service: ${errorInfo.service}`);
      
      // Check if we should attempt half-open
      if (Date.now() - breaker.lastFailure > this.config.circuitBreaker.resetTimeout) {
        breaker.state = 'half-open';
        this.logger.info(`Circuit breaker half-open for service: ${errorInfo.service}`);
      } else {
        return false;
      }
    }
    
    return true;
  }
  
  /**
   * Degrade service operation
   */
  async degradeOperation(errorInfo) {
    this.logger.warn('Degrading service due to resource constraints');
    
    // Emit degrade event for the application to handle
    this.emit('degrade', {
      errorInfo,
      category: errorInfo.category,
      suggestions: this.getResourceOptimizationSuggestions(errorInfo)
    });
    
    return true;
  }
  
  /**
   * Get resource optimization suggestions
   */
  getResourceOptimizationSuggestions(errorInfo) {
    const suggestions = [];
    
    if (errorInfo.code === 'ENOSPC') {
      suggestions.push('Clear old logs and temporary files');
      suggestions.push('Increase disk space');
      suggestions.push('Enable log rotation');
    }
    
    if (errorInfo.code === 'ENOMEM') {
      suggestions.push('Increase system memory');
      suggestions.push('Optimize memory usage');
      suggestions.push('Enable memory limits for processes');
    }
    
    if (errorInfo.code === 'EMFILE') {
      suggestions.push('Increase file descriptor limits');
      suggestions.push('Close unused file handles');
      suggestions.push('Optimize file operations');
    }
    
    return suggestions;
  }
  
  /**
   * Circuit breaker management
   */
  getCircuitBreaker(service) {
    if (!this.circuitBreakers.has(service)) {
      this.circuitBreakers.set(service, {
        failures: 0,
        lastFailure: 0,
        state: 'closed' // closed, open, half-open
      });
    }
    return this.circuitBreakers.get(service);
  }
  
  isCircuitOpen(service) {
    if (!this.config.circuitBreaker.enabled) {
      return false;
    }
    
    const breaker = this.getCircuitBreaker(service);
    return breaker.state === 'open';
  }
  
  updateCircuitBreaker(service, success) {
    const breaker = this.getCircuitBreaker(service);
    
    if (success) {
      if (breaker.state === 'half-open') {
        breaker.state = 'closed';
        breaker.failures = 0;
        this.logger.info(`Circuit breaker closed for service: ${service}`);
      }
    } else {
      breaker.failures++;
      breaker.lastFailure = Date.now();
      
      if (breaker.failures >= this.config.circuitBreaker.threshold) {
        breaker.state = 'open';
        this.logger.error(`Circuit breaker opened for service: ${service}`);
        
        // Schedule automatic half-open attempt
        setTimeout(() => {
          if (breaker.state === 'open') {
            breaker.state = 'half-open';
            this.logger.info(`Circuit breaker half-open for service: ${service}`);
          }
        }, this.config.circuitBreaker.resetTimeout);
      }
    }
  }
  
  /**
   * Recovery attempts tracking
   */
  getRecoveryAttempts(errorInfo) {
    const key = `${errorInfo.service}:${errorInfo.operation || 'default'}`;
    return this.recoveryAttempts.get(key) || 0;
  }
  
  incrementRecoveryAttempts(errorInfo) {
    const key = `${errorInfo.service}:${errorInfo.operation || 'default'}`;
    const attempts = (this.recoveryAttempts.get(key) || 0) + 1;
    this.recoveryAttempts.set(key, attempts);
    
    // Clear attempts after success timeout
    setTimeout(() => {
      this.recoveryAttempts.delete(key);
    }, this.config.circuitBreaker.timeout);
    
    return attempts;
  }
  
  /**
   * Sanitize sensitive data from error messages
   */
  sanitizeSensitiveData(text) {
    if (!text) return text;
    
    let sanitized = text;
    
    // Apply all sensitive patterns
    this.config.sensitivePatterns.forEach(pattern => {
      sanitized = sanitized.replace(pattern, (match, p1) => {
        const key = match.split(/[:=]/)[0];
        return `${key}: [REDACTED]`;
      });
    });
    
    return sanitized;
  }
  
  /**
   * Generate unique error ID
   */
  generateErrorId() {
    return `err_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }
  
  /**
   * Generate request ID
   */
  generateRequestId() {
    return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }
  
  /**
   * Check if error is retryable
   */
  isRetryable(error) {
    const code = error.code || '';
    
    // Check predefined retryable errors
    if (this.config.retryableErrors.some(retryableCode => 
      code.includes(retryableCode)
    )) {
      return true;
    }
    
    // Check HTTP status codes
    if (error.httpStatus) {
      // Retry on 5xx errors (server errors) and specific 4xx errors
      return error.httpStatus >= 500 || 
             error.httpStatus === 429 || // Too Many Requests
             error.httpStatus === 408;    // Request Timeout
    }
    
    return false;
  }
  
  /**
   * Enhanced error logging
   */
  logError(errorInfo) {
    const logData = {
      id: errorInfo.id,
      category: errorInfo.category,
      service: errorInfo.service,
      code: errorInfo.code,
      message: errorInfo.message,
      context: {
        ...errorInfo.context,
        stack: undefined // Don't include stack in structured log
      },
      metrics: {
        attempts: errorInfo.attempts,
        isRetryable: errorInfo.isRetryable,
        recoveryStrategy: errorInfo.recoveryStrategy
      }
    };
    
    switch (errorInfo.severity) {
      case this.config.severities.CRITICAL:
        this.logger.error('🚨 CRITICAL ERROR:', logData, errorInfo.stack);
        break;
      case this.config.severities.HIGH:
        this.logger.error('⚠️  High severity error:', logData);
        break;
      case this.config.severities.MEDIUM:
        this.logger.warn('⚡ Medium severity error:', logData);
        break;
      case this.config.severities.LOW:
        this.logger.info('ℹ️  Low severity error:', logData);
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
    
    // Update circuit breaker
    this.updateCircuitBreaker(errorInfo.service, false);
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
   * Add error to history with size limit
   */
  addToHistory(errorInfo) {
    this.errorHistory.push(errorInfo);
    
    // Keep history size reasonable (last 1000 errors)
    if (this.errorHistory.length > 1000) {
      this.errorHistory = this.errorHistory.slice(-1000);
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
    
    if (threshold && count >= threshold) {
      this.emit('threshold_reached', {
        category: errorInfo.category,
        severity: errorInfo.severity,
        count,
        threshold,
        timeWindow: this.config.rateLimitWindow
      });
      
      // Reset count
      this.errorCounts.set(key, 0);
    }
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    this.metricsInterval = setInterval(() => {
      const metrics = this.getDetailedMetrics();
      this.emit('metrics', metrics);
      
      // Log metrics summary
      this.logger.info('Error metrics:', {
        total: metrics.summary.totalErrors,
        errorRate: metrics.summary.errorRate,
        recoveryRate: metrics.summary.recoverySuccessRate,
        topErrors: metrics.topErrors.slice(0, 3)
      });
    }, this.config.metricsInterval);
  }
  
  /**
   * Get detailed metrics
   */
  getDetailedMetrics() {
    const now = Date.now();
    const recentErrors = this.errorHistory.filter(e => 
      e.timestamp.getTime() > now - this.config.metricsInterval
    );
    
    const errorRate = recentErrors.length / (this.config.metricsInterval / 1000);
    const recoverySuccessRate = this.metrics.recoveryAttempts > 0 
      ? this.metrics.successfulRecoveries / this.metrics.recoveryAttempts 
      : 0;
    
    // Get top errors
    const errorCounts = new Map();
    recentErrors.forEach(error => {
      const key = `${error.category}:${error.code}`;
      errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    });
    
    const topErrors = Array.from(errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => {
        const [category, code] = key.split(':');
        return { category, code, count };
      });
    
    // Circuit breaker status
    const circuitBreakerStatus = {};
    this.circuitBreakers.forEach((breaker, service) => {
      circuitBreakerStatus[service] = {
        state: breaker.state,
        failures: breaker.failures,
        lastFailure: breaker.lastFailure ? new Date(breaker.lastFailure) : null
      };
    });
    
    return {
      timestamp: new Date(),
      summary: {
        totalErrors: this.metrics.totalErrors,
        recentErrors: recentErrors.length,
        errorRate,
        recoveryAttempts: this.metrics.recoveryAttempts,
        successfulRecoveries: this.metrics.successfulRecoveries,
        failedRecoveries: this.metrics.failedRecoveries,
        recoverySuccessRate
      },
      byCategory: Object.fromEntries(this.metrics.errorsByCategory),
      bySeverity: Object.fromEntries(this.metrics.errorsBySeverity),
      byService: Object.fromEntries(this.metrics.errorsByService),
      topErrors,
      circuitBreakers: circuitBreakerStatus,
      rateLimit: {
        current: this.errorHistory.length,
        max: this.config.maxErrorsPerWindow,
        window: this.config.rateLimitWindow
      }
    };
  }
  
  /**
   * Get error statistics
   */
  getStatistics() {
    return this.getDetailedMetrics();
  }
  
  /**
   * Clear error history
   */
  clearHistory() {
    this.errorHistory = [];
    this.errorCounts.clear();
    this.recoveryAttempts.clear();
  }
  
  /**
   * Stop metrics collection
   */
  stop() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
  }
  
  /**
   * Create error classes with enhanced functionality
   */
  static createErrorClass(name, code, defaultMessage) {
    return class extends Error {
      constructor(message = defaultMessage, details = {}) {
        super(message);
        this.name = name;
        this.code = code;
        this.details = details;
        this.timestamp = new Date();
        Error.captureStackTrace(this, this.constructor);
      }
      
      toJSON() {
        return {
          name: this.name,
          code: this.code,
          message: this.message,
          details: this.details,
          timestamp: this.timestamp,
          stack: this.stack
        };
      }
    };
  }
}

// Enhanced error classes
const NetworkError = EnhancedErrorHandler.createErrorClass('NetworkError', 'NETWORK_ERROR', 'Network error occurred');
const DatabaseError = EnhancedErrorHandler.createErrorClass('DatabaseError', 'DATABASE_ERROR', 'Database error occurred');
const ValidationError = EnhancedErrorHandler.createErrorClass('ValidationError', 'VALIDATION_ERROR', 'Validation failed');
const AuthenticationError = EnhancedErrorHandler.createErrorClass('AuthenticationError', 'AUTHENTICATION_ERROR', 'Authentication failed');
const AuthorizationError = EnhancedErrorHandler.createErrorClass('AuthorizationError', 'AUTHORIZATION_ERROR', 'Access denied');
const RateLimitError = EnhancedErrorHandler.createErrorClass('RateLimitError', 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded');
const ResourceError = EnhancedErrorHandler.createErrorClass('ResourceError', 'RESOURCE_ERROR', 'Resource error occurred');
const BlockchainError = EnhancedErrorHandler.createErrorClass('BlockchainError', 'BLOCKCHAIN_ERROR', 'Blockchain error occurred');
const MiningError = EnhancedErrorHandler.createErrorClass('MiningError', 'MINING_ERROR', 'Mining error occurred');
const PaymentError = EnhancedErrorHandler.createErrorClass('PaymentError', 'PAYMENT_ERROR', 'Payment error occurred');

module.exports = {
  EnhancedErrorHandler,
  NetworkError,
  DatabaseError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  ResourceError,
  BlockchainError,
  MiningError,
  PaymentError
};