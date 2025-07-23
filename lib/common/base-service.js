const { EventEmitter } = require('events');
const { createLogger } = require('../utils/logger');
const { UnifiedErrorHandler } = require('./error-handler');

/**
 * Base service class that provides common functionality for all services
 */
class BaseService extends EventEmitter {
  constructor(serviceName, config = {}) {
    super();
    
    this.serviceName = serviceName;
    this.logger = createLogger(serviceName);
    
    // Common configuration
    this.config = {
      // Monitoring
      enableMetrics: config.enableMetrics !== false,
      metricsInterval: config.metricsInterval || 60000,
      
      // Error handling
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      maxRetryDelay: config.maxRetryDelay || 60000,
      
      // Timeouts
      defaultTimeout: config.defaultTimeout || 30000,
      shutdownTimeout: config.shutdownTimeout || 10000,
      
      // Custom config
      ...config
    };
    
    // Common state
    this.initialized = false;
    this.shutdownInProgress = false;
    
    // Error handler
    this.errorHandler = new UnifiedErrorHandler({
      onError: config.onError,
      onCriticalError: config.onCriticalError || ((error) => {
        this.logger.error('Critical error in service:', error);
        this.emit('critical-error', error);
      }),
      logErrors: config.logErrors !== false,
      retryableErrors: config.retryableErrors,
      ...config.errorHandlerConfig
    });
    
    // Common metrics
    this.metrics = {
      startTime: Date.now(),
      operations: {
        total: 0,
        success: 0,
        failure: 0
      },
      errors: new Map(),
      lastError: null,
      uptime: 0
    };
    
    // Setup error handler listeners
    this.setupErrorHandling();
    
    // Timers
    this.timers = new Map();
    
    // Setup shutdown handlers
    this.setupShutdownHandlers();
  }
  
  /**
   * Setup error handling integration
   */
  setupErrorHandling() {
    // Forward error handler events
    this.errorHandler.on('error', (errorInfo) => {
      this.emit('error:handled', errorInfo);
    });
    
    this.errorHandler.on('threshold_reached', (data) => {
      this.logger.warn('Error threshold reached:', data);
      this.emit('error:threshold', data);
    });
    
    this.errorHandler.on('rate_limited', (errorInfo) => {
      this.logger.warn('Error rate limited:', errorInfo);
      this.emit('error:rate_limited', errorInfo);
    });
  }
  
  /**
   * Initialize the service - to be overridden by subclasses
   */
  async initialize() {
    if (this.initialized) {
      this.logger.warn(`${this.serviceName} already initialized`);
      return;
    }
    
    try {
      this.logger.info(`Initializing ${this.serviceName}...`);
      
      // Call subclass initialization
      await this.onInitialize();
      
      // Start metrics collection if enabled
      if (this.config.enableMetrics) {
        this.startMetricsCollection();
      }
      
      this.initialized = true;
      this.emit('initialized');
      this.logger.info(`${this.serviceName} initialized successfully`);
      
    } catch (error) {
      this.logger.error(`Failed to initialize ${this.serviceName}:`, error);
      this.recordFailure(error, { operation: 'initialize' });
      throw error;
    }
  }
  
  /**
   * Override this method in subclasses for custom initialization
   */
  async onInitialize() {
    // To be implemented by subclasses
  }
  
  /**
   * Shutdown the service gracefully
   */
  async shutdown() {
    if (this.shutdownInProgress) {
      this.logger.warn(`${this.serviceName} shutdown already in progress`);
      return;
    }
    
    this.shutdownInProgress = true;
    this.logger.info(`Shutting down ${this.serviceName}...`);
    
    try {
      // Stop all timers
      this.stopAllTimers();
      
      // Call subclass shutdown
      await this.onShutdown();
      
      this.initialized = false;
      this.emit('shutdown');
      this.logger.info(`${this.serviceName} shut down successfully`);
      
    } catch (error) {
      this.logger.error(`Error during ${this.serviceName} shutdown:`, error);
      throw error;
    }
  }
  
  /**
   * Override this method in subclasses for custom shutdown logic
   */
  async onShutdown() {
    // To be implemented by subclasses
  }
  
  /**
   * Execute an operation with retry logic
   */
  async executeWithRetry(operation, operationName = 'operation', context = {}) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await operation();
        this.recordSuccess();
        return result;
        
      } catch (error) {
        lastError = error;
        
        // Handle error and check if retryable
        const errorInfo = await this.errorHandler.handleError(error, {
          service: this.serviceName,
          operation: operationName,
          attempt,
          ...context
        });
        
        if (!errorInfo.isRetryable || attempt >= this.config.maxRetries) {
          this.logger.error(
            `${operationName} failed after ${attempt} attempts:`,
            error.message
          );
          break;
        }
        
        const delay = this.calculateRetryDelay(attempt);
        this.logger.warn(
          `${operationName} failed (attempt ${attempt}/${this.config.maxRetries}), retrying in ${delay}ms:`,
          error.message
        );
        await this.delay(delay);
      }
    }
    
    this.recordFailure(lastError, { operation: operationName, _handled: true });
    throw lastError;
  }
  
  /**
   * Calculate exponential backoff delay
   */
  calculateRetryDelay(attempt) {
    const delay = Math.min(
      this.config.retryDelay * Math.pow(2, attempt - 1),
      this.config.maxRetryDelay
    );
    return delay + Math.random() * 1000; // Add jitter
  }
  
  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Record successful operation
   */
  recordSuccess() {
    this.metrics.operations.total++;
    this.metrics.operations.success++;
  }
  
  /**
   * Record failed operation
   */
  recordFailure(error, context = {}) {
    this.metrics.operations.total++;
    this.metrics.operations.failure++;
    this.recordError(error);
    
    // Send to error handler
    this.errorHandler.handleError(error, {
      service: this.serviceName,
      ...context
    });
  }
  
  /**
   * Record error details
   */
  recordError(error) {
    const errorType = error.constructor.name;
    const errorCount = this.metrics.errors.get(errorType) || 0;
    this.metrics.errors.set(errorType, errorCount + 1);
    this.metrics.lastError = {
      type: errorType,
      message: error.message,
      timestamp: Date.now()
    };
    
    this.emit('error', {
      service: this.serviceName,
      error
    });
  }
  
  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    const timerId = setInterval(() => {
      this.updateMetrics();
      this.emit('metrics', this.getMetrics());
    }, this.config.metricsInterval);
    
    this.timers.set('metrics', timerId);
  }
  
  /**
   * Update metrics
   */
  updateMetrics() {
    this.metrics.uptime = Date.now() - this.metrics.startTime;
  }
  
  /**
   * Get current metrics
   */
  getMetrics() {
    const errorStats = this.errorHandler.getStatistics();
    
    return {
      service: this.serviceName,
      ...this.metrics,
      errors: Array.from(this.metrics.errors.entries()).map(([type, count]) => ({
        type,
        count
      })),
      errorHandling: errorStats,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get service statistics - to be overridden by subclasses
   */
  async getStats() {
    return this.getMetrics();
  }
  
  /**
   * Get custom statistics - to be overridden by subclasses
   */
  async getCustomStats() {
    return {};
  }
  
  /**
   * Start a timer
   */
  startTimer(name, callback, interval) {
    if (this.timers.has(name)) {
      this.logger.warn(`Timer ${name} already exists`);
      return;
    }
    
    const timerId = setInterval(callback, interval);
    this.timers.set(name, timerId);
  }
  
  /**
   * Stop a timer
   */
  stopTimer(name) {
    const timerId = this.timers.get(name);
    if (timerId) {
      clearInterval(timerId);
      this.timers.delete(name);
    }
  }
  
  /**
   * Stop all timers
   */
  stopAllTimers() {
    for (const [name, timerId] of this.timers) {
      clearInterval(timerId);
    }
    this.timers.clear();
  }
  
  /**
   * Setup shutdown handlers
   */
  setupShutdownHandlers() {
    const shutdownHandler = async (signal) => {
      this.logger.info(`Received ${signal}, starting graceful shutdown`);
      try {
        await this.shutdown();
        process.exit(0);
      } catch (error) {
        this.logger.error('Shutdown error:', error);
        process.exit(1);
      }
    };
    
    process.once('SIGINT', () => shutdownHandler('SIGINT'));
    process.once('SIGTERM', () => shutdownHandler('SIGTERM'));
  }
  
  /**
   * Check if service is ready
   */
  isReady() {
    return this.initialized && !this.shutdownInProgress;
  }
  
  /**
   * Health check
   */
  async healthCheck() {
    if (!this.isReady()) {
      return {
        status: 'unhealthy',
        reason: 'Service not ready'
      };
    }
    
    try {
      // Call subclass health check
      const customHealth = await this.onHealthCheck();
      
      return {
        status: 'healthy',
        service: this.serviceName,
        uptime: this.metrics.uptime,
        metrics: this.getMetrics(),
        ...customHealth
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        reason: error.message,
        service: this.serviceName
      };
    }
  }
  
  /**
   * Override for custom health checks
   */
  async onHealthCheck() {
    return {};
  }
}

module.exports = BaseService;