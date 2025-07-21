/**
 * Retry Manager for Otedama
 * Intelligent retry logic for external services
 */

import { EventEmitter } from 'events';

export class RetryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      maxRetries: options.maxRetries || 3,
      initialDelay: options.initialDelay || 1000,
      maxDelay: options.maxDelay || 30000,
      factor: options.factor || 2,
      jitter: options.jitter || true,
      timeout: options.timeout || 30000,
      ...options
    };
    
    // Service-specific configurations
    this.serviceConfigs = new Map();
    
    // Circuit breaker state
    this.circuitBreakers = new Map();
    
    // Metrics
    this.metrics = new Map();
  }

  /**
   * Configure retry policy for specific service
   */
  configureService(serviceName, config) {
    this.serviceConfigs.set(serviceName, {
      maxRetries: config.maxRetries || this.options.maxRetries,
      initialDelay: config.initialDelay || this.options.initialDelay,
      maxDelay: config.maxDelay || this.options.maxDelay,
      factor: config.factor || this.options.factor,
      jitter: config.jitter !== undefined ? config.jitter : this.options.jitter,
      timeout: config.timeout || this.options.timeout,
      retryableErrors: config.retryableErrors || [],
      fallbackUrl: config.fallbackUrl,
      healthCheckUrl: config.healthCheckUrl,
      healthCheckInterval: config.healthCheckInterval || 60000
    });
    
    // Initialize circuit breaker
    this.circuitBreakers.set(serviceName, {
      state: 'closed',
      failures: 0,
      successCount: 0,
      lastFailure: null,
      nextAttempt: null
    });
    
    // Initialize metrics
    this.metrics.set(serviceName, {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      retries: 0,
      averageResponseTime: 0
    });
    
    // Start health check if configured
    if (config.healthCheckUrl) {
      this.startHealthCheck(serviceName);
    }
  }

  /**
   * Execute function with retry logic
   */
  async executeWithRetry(serviceName, fn, options = {}) {
    const config = this.serviceConfigs.get(serviceName) || this.options;
    const breaker = this.circuitBreakers.get(serviceName);
    const metrics = this.metrics.get(serviceName) || this.createMetrics(serviceName);
    
    // Check circuit breaker
    if (breaker && breaker.state === 'open') {
      if (Date.now() < breaker.nextAttempt) {
        const error = new Error(`Circuit breaker open for ${serviceName}`);
        error.code = 'CIRCUIT_BREAKER_OPEN';
        throw error;
      }
      // Try half-open
      breaker.state = 'half-open';
    }
    
    const startTime = Date.now();
    let lastError;
    let attempt = 0;
    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : config.maxRetries;
    
    while (attempt <= maxRetries) {
      try {
        // Execute with timeout
        const result = await this.executeWithTimeout(fn, config.timeout);
        
        // Update metrics
        this.updateMetrics(serviceName, true, Date.now() - startTime);
        
        // Update circuit breaker
        if (breaker) {
          breaker.failures = 0;
          breaker.successCount++;
          if (breaker.state === 'half-open' && breaker.successCount >= 3) {
            breaker.state = 'closed';
            this.emit('circuit-breaker-closed', serviceName);
          }
        }
        
        return result;
        
      } catch (error) {
        lastError = error;
        metrics.retries++;
        
        // Check if error is retryable
        if (!this.isRetryableError(error, config)) {
          this.updateMetrics(serviceName, false, Date.now() - startTime);
          throw error;
        }
        
        // Update circuit breaker
        if (breaker) {
          breaker.failures++;
          breaker.lastFailure = Date.now();
          breaker.successCount = 0;
          
          if (breaker.failures >= 5) {
            breaker.state = 'open';
            breaker.nextAttempt = Date.now() + 60000; // 1 minute
            this.emit('circuit-breaker-open', serviceName);
          }
        }
        
        // If we've exhausted retries, throw
        if (attempt >= maxRetries) {
          this.updateMetrics(serviceName, false, Date.now() - startTime);
          
          // Try fallback if available
          if (config.fallbackUrl && options.useFallback !== false) {
            return this.executeFallback(serviceName, config.fallbackUrl, options);
          }
          
          throw lastError;
        }
        
        // Calculate delay with exponential backoff
        const delay = this.calculateDelay(attempt, config);
        
        // Emit retry event
        this.emit('retry', {
          service: serviceName,
          attempt: attempt + 1,
          delay,
          error: lastError
        });
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
      }
    }
  }

  /**
   * Execute function with timeout
   */
  async executeWithTimeout(fn, timeout) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => {
        setTimeout(() => {
          const error = new Error('Request timeout');
          error.code = 'TIMEOUT';
          reject(error);
        }, timeout);
      })
    ]);
  }

  /**
   * Check if error is retryable
   */
  isRetryableError(error, config) {
    // Network errors are generally retryable
    const networkErrors = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'];
    if (error.code && networkErrors.includes(error.code)) {
      return true;
    }
    
    // HTTP status codes that are retryable
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
    if (error.statusCode && retryableStatusCodes.includes(error.statusCode)) {
      return true;
    }
    
    // Check service-specific retryable errors
    if (config.retryableErrors && config.retryableErrors.length > 0) {
      return config.retryableErrors.some(retryable => {
        if (typeof retryable === 'string') {
          return error.code === retryable || error.message?.includes(retryable);
        }
        if (typeof retryable === 'number') {
          return error.statusCode === retryable;
        }
        return false;
      });
    }
    
    return false;
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  calculateDelay(attempt, config) {
    let delay = config.initialDelay * Math.pow(config.factor, attempt);
    
    // Cap at max delay
    delay = Math.min(delay, config.maxDelay);
    
    // Add jitter if enabled
    if (config.jitter) {
      const jitterRange = delay * 0.2; // 20% jitter
      delay += (Math.random() - 0.5) * 2 * jitterRange;
    }
    
    return Math.max(0, Math.floor(delay));
  }

  /**
   * Execute fallback
   */
  async executeFallback(serviceName, fallbackUrl, options) {
    this.emit('fallback', { service: serviceName, fallbackUrl });
    
    // Execute the fallback with its own retry logic (limited)
    return this.executeWithRetry(`${serviceName}_fallback`, async () => {
      // The actual fallback implementation would go here
      return options.fallbackFn ? options.fallbackFn(fallbackUrl) : null;
    }, { maxRetries: 1 });
  }

  /**
   * Start health check for service
   */
  startHealthCheck(serviceName) {
    const config = this.serviceConfigs.get(serviceName);
    if (!config || !config.healthCheckUrl) return;
    
    const checkHealth = async () => {
      try {
        await this.executeWithTimeout(async () => {
          // Health check implementation
          const response = await fetch(config.healthCheckUrl);
          if (!response.ok) throw new Error('Health check failed');
        }, 5000);
        
        const breaker = this.circuitBreakers.get(serviceName);
        if (breaker && breaker.state === 'open') {
          breaker.state = 'half-open';
          breaker.failures = 0;
          this.emit('service-recovered', serviceName);
        }
      } catch (error) {
        // Health check failed, but don't throw
        this.emit('health-check-failed', { service: serviceName, error });
      }
    };
    
    // Run immediately and then on interval
    checkHealth();
    setInterval(checkHealth, config.healthCheckInterval);
  }

  /**
   * Update metrics
   */
  updateMetrics(serviceName, success, responseTime) {
    const metrics = this.metrics.get(serviceName) || this.createMetrics(serviceName);
    
    metrics.totalCalls++;
    if (success) {
      metrics.successfulCalls++;
    } else {
      metrics.failedCalls++;
    }
    
    // Update average response time
    metrics.averageResponseTime = 
      (metrics.averageResponseTime * (metrics.totalCalls - 1) + responseTime) / metrics.totalCalls;
    
    this.metrics.set(serviceName, metrics);
  }

  /**
   * Create metrics for service
   */
  createMetrics(serviceName) {
    const metrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      retries: 0,
      averageResponseTime: 0
    };
    this.metrics.set(serviceName, metrics);
    return metrics;
  }

  /**
   * Get metrics for service
   */
  getMetrics(serviceName) {
    return serviceName ? this.metrics.get(serviceName) : Object.fromEntries(this.metrics);
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(serviceName) {
    return serviceName ? this.circuitBreakers.get(serviceName) : Object.fromEntries(this.circuitBreakers);
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(serviceName) {
    const breaker = this.circuitBreakers.get(serviceName);
    if (breaker) {
      breaker.state = 'closed';
      breaker.failures = 0;
      breaker.successCount = 0;
      breaker.lastFailure = null;
      breaker.nextAttempt = null;
      this.emit('circuit-breaker-reset', serviceName);
    }
  }
}

// Default retry manager instance
export const defaultRetryManager = new RetryManager();

/**
 * Convenience function for retrying
 */
export async function withRetry(serviceName, fn, options) {
  return defaultRetryManager.executeWithRetry(serviceName, fn, options);
}