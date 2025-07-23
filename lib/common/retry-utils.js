/**
 * Unified retry utilities
 */

/**
 * Execute function with exponential backoff retry
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    jitter = true,
    onRetry = null,
    shouldRetry = () => true,
    timeout = null
  } = options;
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Execute with optional timeout
      if (timeout) {
        return await withTimeout(fn(), timeout);
      }
      return await fn();
      
    } catch (error) {
      lastError = error;
      
      // Check if we should retry
      if (!shouldRetry(error, attempt)) {
        throw error;
      }
      
      // Don't retry on last attempt
      if (attempt === maxAttempts) {
        throw error;
      }
      
      // Calculate delay
      const baseDelay = Math.min(initialDelay * Math.pow(factor, attempt - 1), maxDelay);
      const delay = jitter ? baseDelay + Math.random() * 1000 : baseDelay;
      
      // Call retry callback
      if (onRetry) {
        onRetry(error, attempt, delay);
      }
      
      // Wait before retry
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Execute function with linear retry
 */
async function retryWithLinearDelay(fn, options = {}) {
  const {
    maxAttempts = 3,
    delay = 1000,
    onRetry = null,
    shouldRetry = () => true
  } = options;
  
  let lastError;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (!shouldRetry(error, attempt) || attempt === maxAttempts) {
        throw error;
      }
      
      if (onRetry) {
        onRetry(error, attempt, delay);
      }
      
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Execute function with custom retry strategy
 */
async function retryWithStrategy(fn, strategy) {
  const { getDelay, maxAttempts = Infinity, shouldRetry = () => true } = strategy;
  
  let attempt = 0;
  let lastError;
  
  while (attempt < maxAttempts) {
    attempt++;
    
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (!shouldRetry(error, attempt)) {
        throw error;
      }
      
      const delay = getDelay(attempt, error);
      if (delay === null || delay === undefined) {
        throw error;
      }
      
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Circuit breaker pattern
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.options = {
      failureThreshold: options.failureThreshold || 5,
      resetTimeout: options.resetTimeout || 60000,
      monitoringPeriod: options.monitoringPeriod || 10000,
      onOpen: options.onOpen || (() => {}),
      onClose: options.onClose || (() => {}),
      onHalfOpen: options.onHalfOpen || (() => {})
    };
    
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
  }
  
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
      this.options.onHalfOpen();
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  onSuccess() {
    this.failures = 0;
    
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
      this.options.onClose();
    }
  }
  
  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.options.resetTimeout;
      this.options.onOpen();
    }
  }
  
  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt
    };
  }
  
  reset() {
    this.state = 'CLOSED';
    this.failures = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
  }
}

/**
 * Retry with circuit breaker
 */
async function retryWithCircuitBreaker(fn, circuitBreaker, retryOptions = {}) {
  return circuitBreaker.execute(() => retryWithBackoff(fn, retryOptions));
}

/**
 * Bulk retry with concurrency control
 */
async function bulkRetry(items, fn, options = {}) {
  const {
    concurrency = 5,
    retryOptions = {},
    onItemComplete = null,
    onItemError = null
  } = options;
  
  const results = [];
  const errors = [];
  
  // Process in batches
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    
    const batchPromises = batch.map(async (item, index) => {
      const itemIndex = i + index;
      
      try {
        const result = await retryWithBackoff(() => fn(item, itemIndex), retryOptions);
        results[itemIndex] = { success: true, result };
        
        if (onItemComplete) {
          onItemComplete(item, result, itemIndex);
        }
      } catch (error) {
        results[itemIndex] = { success: false, error };
        errors.push({ item, error, index: itemIndex });
        
        if (onItemError) {
          onItemError(item, error, itemIndex);
        }
      }
    });
    
    await Promise.all(batchPromises);
  }
  
  return {
    results,
    errors,
    successCount: results.filter(r => r.success).length,
    errorCount: errors.length
  };
}

/**
 * Retry with timeout
 */
async function withTimeout(promise, timeout) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Operation timeout')), timeout)
    )
  ]);
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a retry policy
 */
function createRetryPolicy(config = {}) {
  const {
    maxAttempts = 3,
    delays = null,
    exponential = true,
    initialDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    jitter = true,
    retryableErrors = null,
    nonRetryableErrors = null
  } = config;
  
  return {
    getDelay: (attempt) => {
      if (delays && delays[attempt - 1] !== undefined) {
        return delays[attempt - 1];
      }
      
      if (exponential) {
        const baseDelay = Math.min(initialDelay * Math.pow(factor, attempt - 1), maxDelay);
        return jitter ? baseDelay + Math.random() * 1000 : baseDelay;
      }
      
      return initialDelay;
    },
    
    shouldRetry: (error, attempt) => {
      if (attempt >= maxAttempts) return false;
      
      if (nonRetryableErrors) {
        for (const ErrorType of nonRetryableErrors) {
          if (error instanceof ErrorType) return false;
        }
      }
      
      if (retryableErrors) {
        for (const ErrorType of retryableErrors) {
          if (error instanceof ErrorType) return true;
        }
        return false;
      }
      
      return true;
    },
    
    maxAttempts
  };
}

/**
 * Retry decorator for class methods
 */
function retry(options = {}) {
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;
    
    descriptor.value = async function(...args) {
      return retryWithBackoff(
        () => originalMethod.apply(this, args),
        options
      );
    };
    
    return descriptor;
  };
}

module.exports = {
  retryWithBackoff,
  retryWithLinearDelay,
  retryWithStrategy,
  CircuitBreaker,
  retryWithCircuitBreaker,
  bulkRetry,
  withTimeout,
  sleep,
  createRetryPolicy,
  retry
};