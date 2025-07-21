/**
 * Fault Tolerance and Resilience System
 * Circuit breakers, retry mechanisms, bulkheads, and chaos engineering
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { logger } from '../core/logger.js';

/**
 * Advanced Circuit Breaker
 */
export class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      name: 'default',
      timeout: 3000,
      errorThreshold: 50, // percentage
      volumeThreshold: 10, // minimum requests before opening
      resetTimeout: 30000,
      halfOpenMaxAttempts: 3,
      monitoringPeriod: 60000, // 1 minute
      fallback: null,
      healthCheck: null,
      ...options
    };
    
    // States: CLOSED, OPEN, HALF_OPEN
    this.state = 'CLOSED';
    this.stats = {
      requests: 0,
      failures: 0,
      successes: 0,
      timeouts: 0,
      lastFailure: null,
      lastSuccess: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0
    };
    
    this.buckets = new Map(); // Time-based buckets for statistics
    this.nextAttempt = null;
    this.halfOpenAttempts = 0;
    
    this.startMonitoring();
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute(fn, ...args) {
    // Check if circuit is open
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        return this.handleOpen();
      }
      
      // Transition to half-open
      this.transitionTo('HALF_OPEN');
    }
    
    const start = performance.now();
    const bucket = this.getCurrentBucket();
    
    try {
      // Set timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Circuit breaker timeout')), this.options.timeout);
      });
      
      // Execute function
      const result = await Promise.race([
        fn(...args),
        timeoutPromise
      ]);
      
      // Record success
      this.recordSuccess(bucket, performance.now() - start);
      
      return result;
      
    } catch (error) {
      // Record failure
      this.recordFailure(bucket, performance.now() - start, error);
      
      // Check if we should open the circuit
      this.evaluateState();
      
      throw error;
    }
  }

  /**
   * Record success
   */
  recordSuccess(bucket, duration) {
    this.stats.requests++;
    this.stats.successes++;
    this.stats.lastSuccess = Date.now();
    this.stats.consecutiveSuccesses++;
    this.stats.consecutiveFailures = 0;
    
    bucket.requests++;
    bucket.successes++;
    bucket.totalDuration += duration;
    
    // Handle half-open state
    if (this.state === 'HALF_OPEN') {
      if (this.stats.consecutiveSuccesses >= this.options.halfOpenMaxAttempts) {
        this.transitionTo('CLOSED');
      }
    }
    
    this.emit('success', { duration, state: this.state });
  }

  /**
   * Record failure
   */
  recordFailure(bucket, duration, error) {
    this.stats.requests++;
    this.stats.failures++;
    this.stats.lastFailure = Date.now();
    this.stats.consecutiveFailures++;
    this.stats.consecutiveSuccesses = 0;
    
    if (error.message === 'Circuit breaker timeout') {
      this.stats.timeouts++;
      bucket.timeouts++;
    }
    
    bucket.requests++;
    bucket.failures++;
    bucket.totalDuration += duration;
    
    this.emit('failure', { error, duration, state: this.state });
  }

  /**
   * Evaluate state based on metrics
   */
  evaluateState() {
    if (this.state === 'OPEN') return;
    
    const metrics = this.getMetrics();
    
    // Check volume threshold
    if (metrics.totalRequests < this.options.volumeThreshold) {
      return;
    }
    
    // Check error rate
    const errorRate = (metrics.failures / metrics.totalRequests) * 100;
    
    if (errorRate >= this.options.errorThreshold) {
      this.transitionTo('OPEN');
    }
  }

  /**
   * Transition to new state
   */
  transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;
    
    switch (newState) {
      case 'OPEN':
        this.nextAttempt = Date.now() + this.options.resetTimeout;
        this.halfOpenAttempts = 0;
        logger.warn(`Circuit breaker ${this.options.name} opened`);
        break;
        
      case 'HALF_OPEN':
        this.halfOpenAttempts = 0;
        this.stats.consecutiveSuccesses = 0;
        this.stats.consecutiveFailures = 0;
        logger.info(`Circuit breaker ${this.options.name} half-open`);
        break;
        
      case 'CLOSED':
        this.nextAttempt = null;
        this.halfOpenAttempts = 0;
        logger.info(`Circuit breaker ${this.options.name} closed`);
        break;
    }
    
    this.emit('state-change', { from: oldState, to: newState });
  }

  /**
   * Handle open circuit
   */
  async handleOpen() {
    this.emit('open', { nextAttempt: this.nextAttempt });
    
    if (this.options.fallback) {
      return await this.options.fallback();
    }
    
    throw new Error(`Circuit breaker ${this.options.name} is OPEN`);
  }

  /**
   * Get current time bucket
   */
  getCurrentBucket() {
    const now = Date.now();
    const bucketKey = Math.floor(now / 1000) * 1000; // 1-second buckets
    
    if (!this.buckets.has(bucketKey)) {
      this.buckets.set(bucketKey, {
        timestamp: bucketKey,
        requests: 0,
        successes: 0,
        failures: 0,
        timeouts: 0,
        totalDuration: 0
      });
    }
    
    return this.buckets.get(bucketKey);
  }

  /**
   * Get metrics over monitoring period
   */
  getMetrics() {
    const now = Date.now();
    const cutoff = now - this.options.monitoringPeriod;
    
    let totalRequests = 0;
    let successes = 0;
    let failures = 0;
    let timeouts = 0;
    let totalDuration = 0;
    
    // Clean old buckets and aggregate metrics
    for (const [timestamp, bucket] of this.buckets) {
      if (timestamp < cutoff) {
        this.buckets.delete(timestamp);
      } else {
        totalRequests += bucket.requests;
        successes += bucket.successes;
        failures += bucket.failures;
        timeouts += bucket.timeouts;
        totalDuration += bucket.totalDuration;
      }
    }
    
    return {
      totalRequests,
      successes,
      failures,
      timeouts,
      errorRate: totalRequests > 0 ? (failures / totalRequests) * 100 : 0,
      avgDuration: totalRequests > 0 ? totalDuration / totalRequests : 0
    };
  }

  /**
   * Start monitoring
   */
  startMonitoring() {
    // Periodic health check
    if (this.options.healthCheck) {
      setInterval(async () => {
        if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) {
          try {
            await this.options.healthCheck();
            this.transitionTo('HALF_OPEN');
          } catch (error) {
            this.nextAttempt = Date.now() + this.options.resetTimeout;
            logger.debug(`Health check failed for ${this.options.name}:`, error);
          }
        }
      }, 5000); // Check every 5 seconds
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      name: this.options.name,
      state: this.state,
      stats: this.stats,
      metrics: this.getMetrics(),
      nextAttempt: this.nextAttempt
    };
  }

  /**
   * Force reset
   */
  reset() {
    this.transitionTo('CLOSED');
    this.stats = {
      requests: 0,
      failures: 0,
      successes: 0,
      timeouts: 0,
      lastFailure: null,
      lastSuccess: null,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0
    };
    this.buckets.clear();
  }
}

/**
 * Retry mechanism with various strategies
 */
export class RetryPolicy {
  constructor(options = {}) {
    this.options = {
      maxAttempts: 3,
      initialDelay: 1000,
      maxDelay: 30000,
      strategy: 'exponential', // fixed, linear, exponential, fibonacci
      jitter: true,
      jitterFactor: 0.1,
      retryableErrors: null, // Function to determine if error is retryable
      onRetry: null, // Callback for each retry
      ...options
    };
  }

  /**
   * Execute function with retry
   */
  async execute(fn, context = {}) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        const result = await fn();
        return result;
      } catch (error) {
        lastError = error;
        
        // Check if error is retryable
        if (this.options.retryableErrors && !this.options.retryableErrors(error)) {
          throw error;
        }
        
        // Check if we have more attempts
        if (attempt === this.options.maxAttempts) {
          throw new RetryError('Max retry attempts reached', {
            attempts: attempt,
            lastError: error
          });
        }
        
        // Calculate delay
        const delay = this.calculateDelay(attempt);
        
        // Call retry callback
        if (this.options.onRetry) {
          this.options.onRetry({
            attempt,
            error,
            delay,
            context
          });
        }
        
        // Wait before retry
        await this.sleep(delay);
      }
    }
    
    throw lastError;
  }

  /**
   * Calculate delay based on strategy
   */
  calculateDelay(attempt) {
    let delay;
    
    switch (this.options.strategy) {
      case 'fixed':
        delay = this.options.initialDelay;
        break;
        
      case 'linear':
        delay = this.options.initialDelay * attempt;
        break;
        
      case 'exponential':
        delay = this.options.initialDelay * Math.pow(2, attempt - 1);
        break;
        
      case 'fibonacci':
        delay = this.fibonacci(attempt) * this.options.initialDelay;
        break;
        
      default:
        delay = this.options.initialDelay;
    }
    
    // Apply max delay cap
    delay = Math.min(delay, this.options.maxDelay);
    
    // Apply jitter
    if (this.options.jitter) {
      const jitter = delay * this.options.jitterFactor * (Math.random() * 2 - 1);
      delay += jitter;
    }
    
    return Math.max(0, Math.floor(delay));
  }

  /**
   * Fibonacci calculation
   */
  fibonacci(n) {
    if (n <= 1) return n;
    return this.fibonacci(n - 1) + this.fibonacci(n - 2);
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Retry error class
 */
class RetryError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RetryError';
    this.details = details;
  }
}

/**
 * Bulkhead pattern for resource isolation
 */
export class Bulkhead extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      name: 'default',
      maxConcurrent: 10,
      maxQueue: 100,
      timeout: 30000,
      ...options
    };
    
    this.running = 0;
    this.queue = [];
    this.stats = {
      executed: 0,
      rejected: 0,
      queued: 0,
      timedOut: 0,
      completed: 0,
      failed: 0
    };
  }

  /**
   * Execute function with bulkhead protection
   */
  async execute(fn, priority = 0) {
    // Check if we can execute immediately
    if (this.running < this.options.maxConcurrent) {
      return this.executeTask(fn);
    }
    
    // Check queue limit
    if (this.queue.length >= this.options.maxQueue) {
      this.stats.rejected++;
      this.emit('rejected', { queueSize: this.queue.length });
      throw new Error(`Bulkhead ${this.options.name} queue is full`);
    }
    
    // Queue the task
    return this.queueTask(fn, priority);
  }

  /**
   * Execute task
   */
  async executeTask(fn) {
    this.running++;
    this.stats.executed++;
    
    const startTime = Date.now();
    
    try {
      // Set timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Bulkhead timeout')), this.options.timeout);
      });
      
      const result = await Promise.race([fn(), timeoutPromise]);
      
      this.stats.completed++;
      this.emit('completed', {
        duration: Date.now() - startTime,
        running: this.running
      });
      
      return result;
      
    } catch (error) {
      if (error.message === 'Bulkhead timeout') {
        this.stats.timedOut++;
      } else {
        this.stats.failed++;
      }
      
      this.emit('failed', {
        error,
        duration: Date.now() - startTime,
        running: this.running
      });
      
      throw error;
      
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  /**
   * Queue task
   */
  queueTask(fn, priority) {
    return new Promise((resolve, reject) => {
      const task = {
        fn,
        priority,
        resolve,
        reject,
        queuedAt: Date.now()
      };
      
      // Insert based on priority
      const insertIndex = this.queue.findIndex(t => t.priority < priority);
      if (insertIndex === -1) {
        this.queue.push(task);
      } else {
        this.queue.splice(insertIndex, 0, task);
      }
      
      this.stats.queued++;
      this.emit('queued', {
        queueSize: this.queue.length,
        priority
      });
    });
  }

  /**
   * Process queue
   */
  processQueue() {
    if (this.queue.length === 0 || this.running >= this.options.maxConcurrent) {
      return;
    }
    
    const task = this.queue.shift();
    const waitTime = Date.now() - task.queuedAt;
    
    this.emit('dequeued', {
      queueSize: this.queue.length,
      waitTime
    });
    
    this.executeTask(task.fn)
      .then(task.resolve)
      .catch(task.reject);
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      name: this.options.name,
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.options.maxConcurrent,
      maxQueue: this.options.maxQueue,
      stats: this.stats,
      utilization: (this.running / this.options.maxConcurrent) * 100
    };
  }
}

/**
 * Timeout wrapper
 */
export class Timeout {
  constructor(ms) {
    this.ms = ms;
  }

  /**
   * Execute function with timeout
   */
  async execute(fn) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Operation timed out')), this.ms);
      })
    ]);
  }
}

/**
 * Fallback mechanism
 */
export class Fallback {
  constructor(options = {}) {
    this.options = {
      primary: null,
      fallbacks: [],
      timeout: 3000,
      ...options
    };
  }

  /**
   * Execute with fallback
   */
  async execute(...args) {
    const errors = [];
    
    // Try primary
    if (this.options.primary) {
      try {
        const timeout = new Timeout(this.options.timeout);
        return await timeout.execute(() => this.options.primary(...args));
      } catch (error) {
        errors.push({ source: 'primary', error });
      }
    }
    
    // Try fallbacks
    for (let i = 0; i < this.options.fallbacks.length; i++) {
      const fallback = this.options.fallbacks[i];
      
      try {
        const timeout = new Timeout(this.options.timeout);
        return await timeout.execute(() => fallback(...args));
      } catch (error) {
        errors.push({ source: `fallback-${i}`, error });
      }
    }
    
    // All failed
    throw new FallbackError('All fallbacks failed', errors);
  }
}

/**
 * Fallback error class
 */
class FallbackError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'FallbackError';
    this.errors = errors;
  }
}

/**
 * Resilience manager
 */
export class ResilienceManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      enableMetrics: true,
      metricsInterval: 60000, // 1 minute
      ...options
    };
    
    this.circuitBreakers = new Map();
    this.bulkheads = new Map();
    this.retryPolicies = new Map();
    
    if (this.options.enableMetrics) {
      this.startMetricsCollection();
    }
  }

  /**
   * Create or get circuit breaker
   */
  circuitBreaker(name, options = {}) {
    if (!this.circuitBreakers.has(name)) {
      const breaker = new CircuitBreaker({ name, ...options });
      
      // Forward events
      breaker.on('state-change', data => {
        this.emit('circuit-breaker-state-change', { name, ...data });
      });
      
      this.circuitBreakers.set(name, breaker);
    }
    
    return this.circuitBreakers.get(name);
  }

  /**
   * Create or get bulkhead
   */
  bulkhead(name, options = {}) {
    if (!this.bulkheads.has(name)) {
      const bulkhead = new Bulkhead({ name, ...options });
      
      // Forward events
      bulkhead.on('rejected', data => {
        this.emit('bulkhead-rejected', { name, ...data });
      });
      
      this.bulkheads.set(name, bulkhead);
    }
    
    return this.bulkheads.get(name);
  }

  /**
   * Create or get retry policy
   */
  retryPolicy(name, options = {}) {
    if (!this.retryPolicies.has(name)) {
      this.retryPolicies.set(name, new RetryPolicy(options));
    }
    
    return this.retryPolicies.get(name);
  }

  /**
   * Wrap function with resilience patterns
   */
  wrap(fn, options = {}) {
    const {
      circuitBreaker: cbOptions,
      bulkhead: bhOptions,
      retry: retryOptions,
      timeout: timeoutMs,
      fallback: fallbackFn
    } = options;
    
    return async (...args) => {
      let wrappedFn = fn;
      
      // Apply timeout
      if (timeoutMs) {
        const timeout = new Timeout(timeoutMs);
        const originalFn = wrappedFn;
        wrappedFn = () => timeout.execute(() => originalFn(...args));
      }
      
      // Apply retry
      if (retryOptions) {
        const retry = new RetryPolicy(retryOptions);
        const originalFn = wrappedFn;
        wrappedFn = () => retry.execute(() => originalFn(...args));
      }
      
      // Apply bulkhead
      if (bhOptions) {
        const bulkhead = this.bulkhead(bhOptions.name || 'default', bhOptions);
        const originalFn = wrappedFn;
        wrappedFn = () => bulkhead.execute(() => originalFn(...args));
      }
      
      // Apply circuit breaker
      if (cbOptions) {
        const circuitBreaker = this.circuitBreaker(cbOptions.name || 'default', cbOptions);
        const originalFn = wrappedFn;
        wrappedFn = () => circuitBreaker.execute(() => originalFn(...args));
      }
      
      // Apply fallback
      if (fallbackFn) {
        try {
          return await wrappedFn(...args);
        } catch (error) {
          return await fallbackFn(error, ...args);
        }
      }
      
      return await wrappedFn(...args);
    };
  }

  /**
   * Start metrics collection
   */
  startMetricsCollection() {
    setInterval(() => {
      const metrics = this.collectMetrics();
      this.emit('metrics', metrics);
    }, this.options.metricsInterval);
  }

  /**
   * Collect metrics from all components
   */
  collectMetrics() {
    const metrics = {
      timestamp: Date.now(),
      circuitBreakers: {},
      bulkheads: {}
    };
    
    // Circuit breaker metrics
    for (const [name, breaker] of this.circuitBreakers) {
      metrics.circuitBreakers[name] = breaker.getStatus();
    }
    
    // Bulkhead metrics
    for (const [name, bulkhead] of this.bulkheads) {
      metrics.bulkheads[name] = bulkhead.getStatus();
    }
    
    return metrics;
  }

  /**
   * Get overall health
   */
  getHealth() {
    const health = {
      healthy: true,
      circuitBreakers: {
        total: this.circuitBreakers.size,
        open: 0,
        halfOpen: 0,
        closed: 0
      },
      bulkheads: {
        total: this.bulkheads.size,
        saturated: 0,
        avgUtilization: 0
      }
    };
    
    // Check circuit breakers
    for (const breaker of this.circuitBreakers.values()) {
      const status = breaker.getStatus();
      if (status.state === 'OPEN') {
        health.circuitBreakers.open++;
        health.healthy = false;
      } else if (status.state === 'HALF_OPEN') {
        health.circuitBreakers.halfOpen++;
      } else {
        health.circuitBreakers.closed++;
      }
    }
    
    // Check bulkheads
    let totalUtilization = 0;
    for (const bulkhead of this.bulkheads.values()) {
      const status = bulkhead.getStatus();
      totalUtilization += status.utilization;
      
      if (status.utilization >= 90) {
        health.bulkheads.saturated++;
      }
    }
    
    if (health.bulkheads.total > 0) {
      health.bulkheads.avgUtilization = totalUtilization / health.bulkheads.total;
    }
    
    return health;
  }
}

/**
 * Chaos engineering tools
 */
export class ChaosMonkey {
  constructor(options = {}) {
    this.options = {
      enabled: false,
      probability: 0.01, // 1% chance
      strategies: ['latency', 'error', 'timeout'],
      latencyRange: [100, 1000],
      errorTypes: ['network', 'server', 'random'],
      ...options
    };
  }

  /**
   * Inject chaos into function
   */
  async inject(fn) {
    if (!this.options.enabled || Math.random() > this.options.probability) {
      return fn();
    }
    
    const strategy = this.options.strategies[
      Math.floor(Math.random() * this.options.strategies.length)
    ];
    
    switch (strategy) {
      case 'latency':
        await this.injectLatency();
        return fn();
        
      case 'error':
        this.injectError();
        return fn(); // Won't reach here
        
      case 'timeout':
        await this.injectTimeout();
        return fn(); // Won't reach here
        
      default:
        return fn();
    }
  }

  /**
   * Inject latency
   */
  async injectLatency() {
    const [min, max] = this.options.latencyRange;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    
    logger.debug(`Chaos: Injecting ${delay}ms latency`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Inject error
   */
  injectError() {
    const errorType = this.options.errorTypes[
      Math.floor(Math.random() * this.options.errorTypes.length)
    ];
    
    logger.debug(`Chaos: Injecting ${errorType} error`);
    
    switch (errorType) {
      case 'network':
        throw new Error('ECONNREFUSED: Connection refused');
        
      case 'server':
        throw new Error('Internal Server Error');
        
      case 'random':
      default:
        throw new Error('Chaos monkey error');
    }
  }

  /**
   * Inject timeout
   */
  async injectTimeout() {
    logger.debug('Chaos: Injecting timeout');
    await new Promise(() => {}); // Never resolves
  }
}

export default {
  CircuitBreaker,
  RetryPolicy,
  Bulkhead,
  Timeout,
  Fallback,
  ResilienceManager,
  ChaosMonkey
};