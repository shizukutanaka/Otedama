/**
 * Advanced Error Handler
 * Comprehensive error handling, logging, and recovery system
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Error severity levels
const ErrorSeverity = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4
};

// Error categories
const ErrorCategory = {
  VALIDATION: 'validation',
  AUTHENTICATION: 'authentication',
  AUTHORIZATION: 'authorization',
  DATABASE: 'database',
  NETWORK: 'network',
  MINING: 'mining',
  PAYMENT: 'payment',
  SECURITY: 'security',
  SYSTEM: 'system',
  CONFIGURATION: 'configuration'
};

// Custom error classes
class OperationalError extends Error {
  constructor(message, code, severity = ErrorSeverity.MEDIUM, category = ErrorCategory.SYSTEM) {
    super(message);
    this.name = 'OperationalError';
    this.code = code;
    this.severity = severity;
    this.category = category;
    this.timestamp = Date.now();
    this.isOperational = true;
  }
}

class ValidationError extends OperationalError {
  constructor(message, field = null, value = null) {
    super(message, 'VALIDATION_ERROR', ErrorSeverity.LOW, ErrorCategory.VALIDATION);
    this.name = 'ValidationError';
    this.field = field;
    this.value = value;
  }
}

class SecurityError extends OperationalError {
  constructor(message, attackType = null, sourceIP = null) {
    super(message, 'SECURITY_ERROR', ErrorSeverity.HIGH, ErrorCategory.SECURITY);
    this.name = 'SecurityError';
    this.attackType = attackType;
    this.sourceIP = sourceIP;
  }
}

class DatabaseError extends OperationalError {
  constructor(message, query = null, params = null) {
    super(message, 'DATABASE_ERROR', ErrorSeverity.HIGH, ErrorCategory.DATABASE);
    this.name = 'DatabaseError';
    this.query = query;
    this.params = params;
  }
}

class PaymentError extends OperationalError {
  constructor(message, transactionId = null, amount = null) {
    super(message, 'PAYMENT_ERROR', ErrorSeverity.CRITICAL, ErrorCategory.PAYMENT);
    this.name = 'PaymentError';
    this.transactionId = transactionId;
    this.amount = amount;
  }
}

class AdvancedErrorHandler extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // Logging configuration
      logLevel: options.logLevel || 'info',
      logFile: options.logFile || 'logs/error.log',
      maxLogSize: options.maxLogSize || 100 * 1024 * 1024, // 100MB
      maxLogFiles: options.maxLogFiles || 10,
      
      // Error reporting
      enableReporting: options.enableReporting !== false,
      reportingUrl: options.reportingUrl,
      reportingApiKey: options.reportingApiKey,
      
      // Recovery options
      enableAutoRecovery: options.enableAutoRecovery !== false,
      maxRecoveryAttempts: options.maxRecoveryAttempts || 3,
      recoveryDelay: options.recoveryDelay || 1000,
      
      // Monitoring
      enableMetrics: options.enableMetrics !== false,
      metricsInterval: options.metricsInterval || 60000,
      
      // Circuit breaker
      circuitBreakerThreshold: options.circuitBreakerThreshold || 10,
      circuitBreakerTimeout: options.circuitBreakerTimeout || 30000,
      
      ...options
    };
    
    // Error tracking
    this.errorHistory = [];
    this.errorCounts = new Map();
    this.recoveryAttempts = new Map();
    
    // Circuit breaker state
    this.circuitBreakers = new Map();
    
    // Metrics
    this.metrics = {
      totalErrors: 0,
      errorsBySeverity: {
        [ErrorSeverity.LOW]: 0,
        [ErrorSeverity.MEDIUM]: 0,
        [ErrorSeverity.HIGH]: 0,
        [ErrorSeverity.CRITICAL]: 0
      },
      errorsByCategory: {},
      recoveredErrors: 0,
      unrecoverableErrors: 0,
      avgResolutionTime: 0
    };
    
    // Initialize error categories in metrics
    Object.values(ErrorCategory).forEach(category => {
      this.metrics.errorsByCategory[category] = 0;
    });
    
    // Recovery strategies
    this.recoveryStrategies = new Map([
      [ErrorCategory.DATABASE, this.recoverDatabase.bind(this)],
      [ErrorCategory.NETWORK, this.recoverNetwork.bind(this)],
      [ErrorCategory.MINING, this.recoverMining.bind(this)],
      [ErrorCategory.PAYMENT, this.recoverPayment.bind(this)]
    ]);
    
    this.initialized = false;
  }
  
  /**
   * Initialize error handler
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Setup log directory
      await this.setupLogDirectory();
      
      // Setup global error handlers
      this.setupGlobalHandlers();
      
      // Start metrics collection
      if (this.config.enableMetrics) {
        this.startMetricsCollection();
      }
      
      this.initialized = true;
      this.emit('initialized');
      
      console.log('Advanced error handler initialized');
      
    } catch (error) {
      console.error('Failed to initialize error handler:', error);
      throw error;
    }
  }
  
  /**
   * Setup log directory
   */
  async setupLogDirectory() {
    const logDir = path.dirname(this.config.logFile);
    
    try {
      await fs.access(logDir);
    } catch (error) {
      await fs.mkdir(logDir, { recursive: true });
    }
  }
  
  /**
   * Setup global error handlers
   */
  setupGlobalHandlers() {
    // Unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      const error = new OperationalError(
        `Unhandled promise rejection: ${reason}`,\n        'UNHANDLED_REJECTION',\n        ErrorSeverity.HIGH\n      );\n      \n      error.originalReason = reason;\n      error.promise = promise;\n      \n      this.handleError(error);\n    });\n    \n    // Uncaught exceptions\n    process.on('uncaughtException', (error) => {\n      const wrappedError = new OperationalError(\n        `Uncaught exception: ${error.message}`,\n        'UNCAUGHT_EXCEPTION',\n        ErrorSeverity.CRITICAL\n      );\n      \n      wrappedError.originalError = error;\n      \n      this.handleError(wrappedError).then(() => {\n        // Give time for logging before exit\n        setTimeout(() => {\n          process.exit(1);\n        }, 1000);\n      });\n    });\n    \n    // Warning events\n    process.on('warning', (warning) => {\n      const error = new OperationalError(\n        `Node.js warning: ${warning.message}`,\n        'NODE_WARNING',\n        ErrorSeverity.LOW\n      );\n      \n      error.warningName = warning.name;\n      error.warningCode = warning.code;\n      \n      this.handleError(error, { skipRecovery: true });\n    });\n  }\n  \n  /**\n   * Main error handling method\n   */\n  async handleError(error, options = {}) {\n    const startTime = Date.now();\n    \n    try {\n      // Normalize error object\n      const normalizedError = this.normalizeError(error);\n      \n      // Generate error ID\n      normalizedError.id = this.generateErrorId(normalizedError);\n      \n      // Add to history\n      this.addToHistory(normalizedError);\n      \n      // Update metrics\n      this.updateMetrics(normalizedError);\n      \n      // Log error\n      await this.logError(normalizedError);\n      \n      // Check circuit breaker\n      if (this.shouldTriggerCircuitBreaker(normalizedError)) {\n        this.triggerCircuitBreaker(normalizedError.category);\n      }\n      \n      // Emit error event\n      this.emit('error', normalizedError);\n      \n      // Attempt recovery if enabled\n      if (this.config.enableAutoRecovery && !options.skipRecovery) {\n        await this.attemptRecovery(normalizedError);\n      }\n      \n      // Report error if critical\n      if (normalizedError.severity >= ErrorSeverity.HIGH && this.config.enableReporting) {\n        await this.reportError(normalizedError);\n      }\n      \n      // Calculate resolution time\n      const resolutionTime = Date.now() - startTime;\n      this.updateResolutionTime(resolutionTime);\n      \n      return normalizedError;\n      \n    } catch (handlingError) {\n      // Error in error handling - log to console as fallback\n      console.error('Error in error handler:', handlingError);\n      console.error('Original error:', error);\n    }\n  }\n  \n  /**\n   * Normalize error object\n   */\n  normalizeError(error) {\n    if (error instanceof OperationalError) {\n      return error;\n    }\n    \n    // Convert regular errors to operational errors\n    const normalizedError = new OperationalError(\n      error.message || 'Unknown error',\n      error.code || 'UNKNOWN_ERROR',\n      this.determineSeverity(error),\n      this.determineCategory(error)\n    );\n    \n    // Copy relevant properties\n    normalizedError.stack = error.stack;\n    normalizedError.originalError = error;\n    \n    return normalizedError;\n  }\n  \n  /**\n   * Determine error severity\n   */\n  determineSeverity(error) {\n    // Security-related errors\n    if (error.message?.toLowerCase().includes('security') ||\n        error.message?.toLowerCase().includes('unauthorized') ||\n        error.message?.toLowerCase().includes('forbidden')) {\n      return ErrorSeverity.HIGH;\n    }\n    \n    // Payment-related errors\n    if (error.message?.toLowerCase().includes('payment') ||\n        error.message?.toLowerCase().includes('transaction')) {\n      return ErrorSeverity.CRITICAL;\n    }\n    \n    // Database errors\n    if (error.code === 'ECONNREFUSED' || \n        error.message?.toLowerCase().includes('database') ||\n        error.message?.toLowerCase().includes('connection')) {\n      return ErrorSeverity.HIGH;\n    }\n    \n    // Validation errors\n    if (error.name === 'ValidationError' ||\n        error.message?.toLowerCase().includes('validation') ||\n        error.message?.toLowerCase().includes('invalid')) {\n      return ErrorSeverity.LOW;\n    }\n    \n    return ErrorSeverity.MEDIUM;\n  }\n  \n  /**\n   * Determine error category\n   */\n  determineCategory(error) {\n    const message = error.message?.toLowerCase() || '';\n    const stack = error.stack?.toLowerCase() || '';\n    \n    if (message.includes('validation') || message.includes('invalid')) {\n      return ErrorCategory.VALIDATION;\n    }\n    \n    if (message.includes('unauthorized') || message.includes('authentication')) {\n      return ErrorCategory.AUTHENTICATION;\n    }\n    \n    if (message.includes('forbidden') || message.includes('permission')) {\n      return ErrorCategory.AUTHORIZATION;\n    }\n    \n    if (message.includes('database') || message.includes('sql') || \n        stack.includes('database') || error.code === 'ECONNREFUSED') {\n      return ErrorCategory.DATABASE;\n    }\n    \n    if (message.includes('network') || message.includes('connection') ||\n        message.includes('timeout') || error.code === 'ETIMEDOUT') {\n      return ErrorCategory.NETWORK;\n    }\n    \n    if (message.includes('mining') || message.includes('share') ||\n        message.includes('hash') || stack.includes('mining')) {\n      return ErrorCategory.MINING;\n    }\n    \n    if (message.includes('payment') || message.includes('transaction') ||\n        message.includes('wallet') || stack.includes('payment')) {\n      return ErrorCategory.PAYMENT;\n    }\n    \n    if (message.includes('security') || message.includes('attack') ||\n        message.includes('suspicious')) {\n      return ErrorCategory.SECURITY;\n    }\n    \n    if (message.includes('config') || message.includes('settings')) {\n      return ErrorCategory.CONFIGURATION;\n    }\n    \n    return ErrorCategory.SYSTEM;\n  }\n  \n  /**\n   * Generate unique error ID\n   */\n  generateErrorId(error) {\n    const data = `${error.message}${error.code}${error.category}${error.timestamp}`;\n    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16);\n  }\n  \n  /**\n   * Add error to history\n   */\n  addToHistory(error) {\n    this.errorHistory.push(error);\n    \n    // Keep only recent errors\n    if (this.errorHistory.length > 1000) {\n      this.errorHistory = this.errorHistory.slice(-1000);\n    }\n    \n    // Update error counts\n    const key = `${error.category}:${error.code}`;\n    const count = this.errorCounts.get(key) || 0;\n    this.errorCounts.set(key, count + 1);\n  }\n  \n  /**\n   * Update metrics\n   */\n  updateMetrics(error) {\n    this.metrics.totalErrors++;\n    this.metrics.errorsBySeverity[error.severity]++;\n    this.metrics.errorsByCategory[error.category]++;\n  }\n  \n  /**\n   * Log error to file\n   */\n  async logError(error) {\n    const logEntry = {\n      timestamp: new Date(error.timestamp).toISOString(),\n      id: error.id,\n      level: this.severityToLogLevel(error.severity),\n      category: error.category,\n      code: error.code,\n      message: error.message,\n      stack: error.stack,\n      metadata: {\n        severity: error.severity,\n        isOperational: error.isOperational,\n        ...this.extractErrorMetadata(error)\n      }\n    };\n    \n    const logLine = JSON.stringify(logEntry) + '\\n';\n    \n    try {\n      await fs.appendFile(this.config.logFile, logLine);\n      \n      // Check log rotation\n      await this.checkLogRotation();\n      \n    } catch (logError) {\n      console.error('Failed to write error log:', logError);\n      console.error('Original error:', error);\n    }\n  }\n  \n  /**\n   * Extract error metadata\n   */\n  extractErrorMetadata(error) {\n    const metadata = {};\n    \n    // Add specific error properties\n    if (error instanceof ValidationError) {\n      metadata.field = error.field;\n      metadata.value = error.value;\n    } else if (error instanceof SecurityError) {\n      metadata.attackType = error.attackType;\n      metadata.sourceIP = error.sourceIP;\n    } else if (error instanceof DatabaseError) {\n      metadata.query = error.query;\n      metadata.params = error.params;\n    } else if (error instanceof PaymentError) {\n      metadata.transactionId = error.transactionId;\n      metadata.amount = error.amount;\n    }\n    \n    return metadata;\n  }\n  \n  /**\n   * Convert severity to log level\n   */\n  severityToLogLevel(severity) {\n    switch (severity) {\n      case ErrorSeverity.LOW: return 'warn';\n      case ErrorSeverity.MEDIUM: return 'error';\n      case ErrorSeverity.HIGH: return 'error';\n      case ErrorSeverity.CRITICAL: return 'fatal';\n      default: return 'error';\n    }\n  }\n  \n  /**\n   * Check and perform log rotation\n   */\n  async checkLogRotation() {\n    try {\n      const stats = await fs.stat(this.config.logFile);\n      \n      if (stats.size > this.config.maxLogSize) {\n        await this.rotateLog();\n      }\n    } catch (error) {\n      // File doesn't exist or other error - ignore\n    }\n  }\n  \n  /**\n   * Rotate log file\n   */\n  async rotateLog() {\n    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');\n    const rotatedFile = `${this.config.logFile}.${timestamp}`;\n    \n    try {\n      await fs.rename(this.config.logFile, rotatedFile);\n      \n      // Clean up old log files\n      await this.cleanupOldLogs();\n      \n    } catch (error) {\n      console.error('Failed to rotate log file:', error);\n    }\n  }\n  \n  /**\n   * Clean up old log files\n   */\n  async cleanupOldLogs() {\n    try {\n      const logDir = path.dirname(this.config.logFile);\n      const logFileName = path.basename(this.config.logFile);\n      const files = await fs.readdir(logDir);\n      \n      const logFiles = files\n        .filter(file => file.startsWith(logFileName))\n        .map(file => ({\n          name: file,\n          path: path.join(logDir, file),\n          stat: null\n        }));\n      \n      // Get file stats\n      for (const file of logFiles) {\n        try {\n          file.stat = await fs.stat(file.path);\n        } catch (error) {\n          // Ignore errors\n        }\n      }\n      \n      // Sort by modification time (newest first)\n      logFiles.sort((a, b) => {\n        if (!a.stat || !b.stat) return 0;\n        return b.stat.mtime.getTime() - a.stat.mtime.getTime();\n      });\n      \n      // Remove old files\n      const filesToRemove = logFiles.slice(this.config.maxLogFiles);\n      for (const file of filesToRemove) {\n        try {\n          await fs.unlink(file.path);\n        } catch (error) {\n          console.error(`Failed to remove old log file ${file.name}:`, error);\n        }\n      }\n      \n    } catch (error) {\n      console.error('Failed to clean up old logs:', error);\n    }\n  }\n  \n  /**\n   * Attempt error recovery\n   */\n  async attemptRecovery(error) {\n    const recoveryKey = `${error.category}:${error.code}`;\n    const attempts = this.recoveryAttempts.get(recoveryKey) || 0;\n    \n    if (attempts >= this.config.maxRecoveryAttempts) {\n      this.metrics.unrecoverableErrors++;\n      this.emit('recovery:failed', { error, attempts });\n      return false;\n    }\n    \n    const strategy = this.recoveryStrategies.get(error.category);\n    if (!strategy) {\n      return false; // No recovery strategy available\n    }\n    \n    try {\n      this.recoveryAttempts.set(recoveryKey, attempts + 1);\n      \n      // Wait before retry\n      if (attempts > 0) {\n        await this.delay(this.config.recoveryDelay * Math.pow(2, attempts));\n      }\n      \n      const recovered = await strategy(error);\n      \n      if (recovered) {\n        this.recoveryAttempts.delete(recoveryKey);\n        this.metrics.recoveredErrors++;\n        this.emit('recovery:success', { error, attempts: attempts + 1 });\n        return true;\n      }\n      \n      return false;\n      \n    } catch (recoveryError) {\n      console.error('Recovery attempt failed:', recoveryError);\n      this.emit('recovery:error', { error, recoveryError, attempts: attempts + 1 });\n      return false;\n    }\n  }\n  \n  /**\n   * Recovery strategies\n   */\n  async recoverDatabase(error) {\n    // Implement database recovery logic\n    console.log('Attempting database recovery...');\n    return false; // Placeholder\n  }\n  \n  async recoverNetwork(error) {\n    // Implement network recovery logic\n    console.log('Attempting network recovery...');\n    return false; // Placeholder\n  }\n  \n  async recoverMining(error) {\n    // Implement mining recovery logic\n    console.log('Attempting mining recovery...');\n    return false; // Placeholder\n  }\n  \n  async recoverPayment(error) {\n    // Implement payment recovery logic\n    console.log('Attempting payment recovery...');\n    return false; // Placeholder\n  }\n  \n  /**\n   * Circuit breaker functionality\n   */\n  shouldTriggerCircuitBreaker(error) {\n    const key = error.category;\n    const recentErrors = this.errorHistory\n      .filter(e => e.category === key && \n                   Date.now() - e.timestamp < 60000) // Last minute\n      .length;\n    \n    return recentErrors >= this.config.circuitBreakerThreshold;\n  }\n  \n  triggerCircuitBreaker(category) {\n    const existing = this.circuitBreakers.get(category);\n    if (existing && existing.isOpen) {\n      return; // Already open\n    }\n    \n    const circuitBreaker = {\n      category,\n      isOpen: true,\n      openedAt: Date.now(),\n      timeout: this.config.circuitBreakerTimeout\n    };\n    \n    this.circuitBreakers.set(category, circuitBreaker);\n    \n    this.emit('circuit-breaker:opened', { category });\n    \n    // Auto-close after timeout\n    setTimeout(() => {\n      this.closeCircuitBreaker(category);\n    }, this.config.circuitBreakerTimeout);\n  }\n  \n  closeCircuitBreaker(category) {\n    this.circuitBreakers.delete(category);\n    this.emit('circuit-breaker:closed', { category });\n  }\n  \n  isCircuitOpen(category) {\n    const breaker = this.circuitBreakers.get(category);\n    return breaker && breaker.isOpen;\n  }\n  \n  /**\n   * Report error to external service\n   */\n  async reportError(error) {\n    if (!this.config.reportingUrl || !this.config.reportingApiKey) {\n      return;\n    }\n    \n    try {\n      const report = {\n        id: error.id,\n        timestamp: error.timestamp,\n        severity: error.severity,\n        category: error.category,\n        code: error.code,\n        message: error.message,\n        stack: error.stack,\n        metadata: this.extractErrorMetadata(error)\n      };\n      \n      // Send to external reporting service\n      // Implementation depends on specific service (e.g., Sentry, Bugsnag)\n      \n    } catch (reportError) {\n      console.error('Failed to report error:', reportError);\n    }\n  }\n  \n  /**\n   * Start metrics collection\n   */\n  startMetricsCollection() {\n    setInterval(() => {\n      this.emit('metrics', this.getMetrics());\n    }, this.config.metricsInterval);\n  }\n  \n  /**\n   * Update resolution time\n   */\n  updateResolutionTime(time) {\n    const currentAvg = this.metrics.avgResolutionTime;\n    const totalErrors = this.metrics.totalErrors;\n    \n    this.metrics.avgResolutionTime = \n      ((currentAvg * (totalErrors - 1)) + time) / totalErrors;\n  }\n  \n  /**\n   * Utility methods\n   */\n  delay(ms) {\n    return new Promise(resolve => setTimeout(resolve, ms));\n  }\n  \n  /**\n   * Get error metrics\n   */\n  getMetrics() {\n    return {\n      ...this.metrics,\n      circuitBreakers: Array.from(this.circuitBreakers.values()),\n      errorHistory: this.errorHistory.slice(-100), // Last 100 errors\n      topErrors: this.getTopErrors()\n    };\n  }\n  \n  /**\n   * Get top errors by frequency\n   */\n  getTopErrors(limit = 10) {\n    return Array.from(this.errorCounts.entries())\n      .sort((a, b) => b[1] - a[1])\n      .slice(0, limit)\n      .map(([key, count]) => {\n        const [category, code] = key.split(':');\n        return { category, code, count };\n      });\n  }\n  \n  /**\n   * Get error handler status\n   */\n  getStatus() {\n    return {\n      initialized: this.initialized,\n      totalErrors: this.metrics.totalErrors,\n      criticalErrors: this.metrics.errorsBySeverity[ErrorSeverity.CRITICAL],\n      recoveredErrors: this.metrics.recoveredErrors,\n      openCircuitBreakers: this.circuitBreakers.size,\n      errorRate: this.calculateErrorRate(),\n      healthScore: this.calculateHealthScore()\n    };\n  }\n  \n  /**\n   * Calculate error rate (errors per minute)\n   */\n  calculateErrorRate() {\n    const oneMinuteAgo = Date.now() - 60000;\n    const recentErrors = this.errorHistory.filter(e => e.timestamp > oneMinuteAgo);\n    return recentErrors.length;\n  }\n  \n  /**\n   * Calculate system health score (0-100)\n   */\n  calculateHealthScore() {\n    const criticalErrors = this.metrics.errorsBySeverity[ErrorSeverity.CRITICAL];\n    const highErrors = this.metrics.errorsBySeverity[ErrorSeverity.HIGH];\n    const totalErrors = this.metrics.totalErrors;\n    const openBreakers = this.circuitBreakers.size;\n    \n    let score = 100;\n    \n    // Deduct for critical errors\n    score -= criticalErrors * 10;\n    \n    // Deduct for high severity errors\n    score -= highErrors * 5;\n    \n    // Deduct for error rate\n    const errorRate = this.calculateErrorRate();\n    score -= errorRate * 2;\n    \n    // Deduct for open circuit breakers\n    score -= openBreakers * 15;\n    \n    return Math.max(0, Math.min(100, score));\n  }\n  \n  /**\n   * Create error instances\n   */\n  static createValidationError(message, field, value) {\n    return new ValidationError(message, field, value);\n  }\n  \n  static createSecurityError(message, attackType, sourceIP) {\n    return new SecurityError(message, attackType, sourceIP);\n  }\n  \n  static createDatabaseError(message, query, params) {\n    return new DatabaseError(message, query, params);\n  }\n  \n  static createPaymentError(message, transactionId, amount) {\n    return new PaymentError(message, transactionId, amount);\n  }\n  \n  /**\n   * Shutdown error handler\n   */\n  async shutdown() {\n    console.log('Shutting down error handler...');\n    \n    // Clear intervals and timeouts\n    // (Implementation would depend on stored references)\n    \n    this.initialized = false;\n    this.emit('shutdown');\n  }\n}\n\n// Export classes and constants\nmodule.exports = {\n  AdvancedErrorHandler,\n  OperationalError,\n  ValidationError,\n  SecurityError,\n  DatabaseError,\n  PaymentError,\n  ErrorSeverity,\n  ErrorCategory\n};"