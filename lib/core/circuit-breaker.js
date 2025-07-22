/**
 * Circuit Breaker Pattern Implementation for Otedama
 * Provides fault tolerance and prevents cascading failures
 * 
 * Design principles:
 * - Carmack: Fast state transitions, minimal overhead
 * - Martin: Clear state machine, single responsibility
 * - Pike: Simple and predictable behavior
 */

import { EventEmitter } from 'events';
import { logger } from './logger.js';

export const CircuitState = {
  CLOSED: 'closed',      // Normal operation
  OPEN: 'open',          // Failing, reject all calls
  HALF_OPEN: 'half_open' // Testing if service recovered
};

export class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Failure detection
      failureThreshold: options.failureThreshold || 5,
      failureRateThreshold: options.failureRateThreshold || 0.5,
      sampleSize: options.sampleSize || 20,
      
      // Timing
      timeout: options.timeout || 10000,
      resetTimeout: options.resetTimeout || 60000,
      
      // Half-open behavior
      halfOpenRequests: options.halfOpenRequests || 3,
      
      // Function to wrap
      fn: options.fn,
      name: options.name || 'CircuitBreaker',
      
      ...options
    };
    
    // State
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
    
    // Metrics
    this.metrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
      timeouts: 0,
      stateChanges: 0,
      lastStateChange: Date.now()
    };
    
    // Request tracking for failure rate
    this.requestWindow = [];
    
    // Half-open state tracking
    this.halfOpenAttempts = 0;
    this.halfOpenSuccesses = 0;
    
    // Validate options
    if (!this.options.fn || typeof this.options.fn !== 'function') {
      throw new Error('Circuit breaker requires a function to wrap');
    }
  }
  
  async call(...args) {
    this.metrics.totalCalls++;
    
    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      if (this._shouldAttemptReset()) {
        this._transitionToHalfOpen();
      } else {
        this.metrics.rejectedCalls++;
        const error = new Error(`Circuit breaker is OPEN for ${this.options.name}`);
        error.code = 'CIRCUIT_OPEN';
        throw error;
      }
    }
    
    // Check if we're in half-open state and have too many attempts
    if (this.state === CircuitState.HALF_OPEN && 
        this.halfOpenAttempts >= this.options.halfOpenRequests) {
      this.metrics.rejectedCalls++;
      const error = new Error(`Circuit breaker is testing recovery for ${this.options.name}`);
      error.code = 'CIRCUIT_HALF_OPEN';
      throw error;
    }
    
    // Track request start
    const startTime = Date.now();
    let timeoutHandle;
    
    try {
      // Create timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new Error(`Request timeout in ${this.options.name}`);
          error.code = 'TIMEOUT';
          reject(error);
        }, this.options.timeout);
      });
      
      // Execute function with timeout
      const result = await Promise.race([
        this.options.fn(...args),
        timeoutPromise
      ]);
      
      clearTimeout(timeoutHandle);
      
      // Record success
      this._recordSuccess(Date.now() - startTime);
      
      return result;
    } catch (error) {
      clearTimeout(timeoutHandle);
      
      // Record failure
      this._recordFailure(error, Date.now() - startTime);
      
      throw error;
    }
  }
  
  _recordSuccess(duration) {
    this.successes++;
    this.metrics.successfulCalls++;
    
    // Track in request window
    this.requestWindow.push({
      timestamp: Date.now(),
      success: true,
      duration
    });
    this._pruneRequestWindow();
    
    // Handle state-specific logic
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses++;
      
      // Check if we should close the circuit
      if (this.halfOpenSuccesses >= this.options.halfOpenRequests) {
        this._transitionToClosed();
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset consecutive failures
      this.failures = 0;
    }
    
    this.emit('success', { duration });
  }
  
  _recordFailure(error, duration) {
    this.failures++;
    this.metrics.failedCalls++;
    this.lastFailureTime = Date.now();
    
    if (error.code === 'TIMEOUT') {
      this.metrics.timeouts++;
    }
    
    // Track in request window
    this.requestWindow.push({
      timestamp: Date.now(),
      success: false,
      duration,
      error: error.message
    });
    this._pruneRequestWindow();
    
    // Handle state-specific logic
    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state opens the circuit
      this._transitionToOpen();
    } else if (this.state === CircuitState.CLOSED) {
      // Check if we should open the circuit
      if (this._shouldOpen()) {
        this._transitionToOpen();
      }
    }
    
    this.emit('failure', { error, duration });
  }
  
  _shouldOpen() {
    // Check absolute failure threshold
    if (this.failures >= this.options.failureThreshold) {
      return true;
    }
    
    // Check failure rate
    const recentRequests = this.requestWindow.filter(
      r => r.timestamp > Date.now() - 60000 // Last minute
    );
    
    if (recentRequests.length >= this.options.sampleSize) {
      const failureRate = recentRequests.filter(r => !r.success).length / recentRequests.length;
      return failureRate >= this.options.failureRateThreshold;
    }
    
    return false;
  }
  
  _shouldAttemptReset() {
    return Date.now() >= this.nextAttempt;
  }
  
  _transitionToOpen() {
    this.state = CircuitState.OPEN;
    this.nextAttempt = Date.now() + this.options.resetTimeout;
    this.metrics.stateChanges++;
    this.metrics.lastStateChange = Date.now();
    
    logger.warn(`Circuit breaker ${this.options.name} is now OPEN`);
    this.emit('stateChange', {
      from: this.state,
      to: CircuitState.OPEN,
      failures: this.failures
    });
  }
  
  _transitionToHalfOpen() {
    const previousState = this.state;
    this.state = CircuitState.HALF_OPEN;
    this.halfOpenAttempts = 0;
    this.halfOpenSuccesses = 0;
    this.metrics.stateChanges++;
    this.metrics.lastStateChange = Date.now();
    
    logger.info(`Circuit breaker ${this.options.name} is now HALF_OPEN`);
    this.emit('stateChange', {
      from: previousState,
      to: CircuitState.HALF_OPEN
    });
  }
  
  _transitionToClosed() {
    const previousState = this.state;
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.halfOpenAttempts = 0;
    this.halfOpenSuccesses = 0;
    this.metrics.stateChanges++;
    this.metrics.lastStateChange = Date.now();
    
    logger.info(`Circuit breaker ${this.options.name} is now CLOSED`);
    this.emit('stateChange', {
      from: previousState,
      to: CircuitState.CLOSED
    });
  }
  
  _pruneRequestWindow() {
    // Keep only recent requests
    const cutoff = Date.now() - 300000; // 5 minutes
    this.requestWindow = this.requestWindow.filter(r => r.timestamp > cutoff);
  }
  
  // Manual controls
  open() {
    this._transitionToOpen();
  }
  
  close() {
    this._transitionToClosed();
  }
  
  reset() {
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
    this.requestWindow = [];
    this.halfOpenAttempts = 0;
    this.halfOpenSuccesses = 0;
  }
  
  getState() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
      metrics: this.getMetrics()
    };
  }
  
  getMetrics() {
    const recentRequests = this.requestWindow.filter(
      r => r.timestamp > Date.now() - 60000
    );
    
    const failureRate = recentRequests.length > 0
      ? recentRequests.filter(r => !r.success).length / recentRequests.length
      : 0;
    
    const avgDuration = recentRequests.length > 0
      ? recentRequests.reduce((sum, r) => sum + r.duration, 0) / recentRequests.length
      : 0;
    
    return {
      ...this.metrics,
      currentFailureRate: failureRate,
      avgResponseTime: avgDuration,
      recentRequests: recentRequests.length
    };
  }
}

// Factory function for creating circuit breakers
export function createCircuitBreaker(fn, options = {}) {
  return new CircuitBreaker({ ...options, fn });
}

// Decorator for class methods
export function circuitBreaker(options = {}) {
  return function(target, propertyKey, descriptor) {
    const originalMethod = descriptor.value;
    
    const breaker = new CircuitBreaker({
      ...options,
      fn: originalMethod,
      name: `${target.constructor.name}.${propertyKey}`
    });
    
    descriptor.value = async function(...args) {
      return breaker.call.apply(breaker, args);
    };
    
    return descriptor;
  };
}

export default CircuitBreaker;