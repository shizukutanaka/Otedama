/**
 * Retry Policy Implementation
 * Philosophy: Resilient operations with intelligent backoff (Martin)
 * Performance: Efficient retry logic with minimal overhead (Carmack)
 * Simplicity: Clear retry strategies and error handling (Pike)
 */

import { CircuitBreaker } from './circuit-breaker';

interface RetryConfig {
  maxAttempts: number;
  initialDelay: number; // milliseconds
  maxDelay: number; // milliseconds
  backoffMultiplier: number;
  jitter: boolean; // Add randomness to prevent thundering herd
  retryableErrors?: (error: Error) => boolean;
  onRetry?: (error: Error, attempt: number) => void;
}

interface RetryAttempt {
  attempt: number;
  delay: number;
  error: Error;
  timestamp: Date;
}

interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: RetryAttempt[];
  totalDuration: number;
  finalAttempt: number;
}

export class RetryPolicy {
  constructor(private config: RetryConfig) {}

  /**
   * Execute a function with retry policy
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    const attempts: RetryAttempt[] = [];
    let lastError: Error;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const result = await fn();
        return result;
      } catch (error) {
        lastError = error as Error;
        
        const attemptRecord: RetryAttempt = {
          attempt,
          delay: 0,
          error: lastError,
          timestamp: new Date()
        };

        // Check if this error is retryable
        if (this.config.retryableErrors && !this.config.retryableErrors(lastError)) {
          attempts.push(attemptRecord);
          throw this.createAggregateError(lastError, attempts, startTime, attempt);
        }

        // If this was the last attempt, throw the error
        if (attempt === this.config.maxAttempts) {
          attempts.push(attemptRecord);
          throw this.createAggregateError(lastError, attempts, startTime, attempt);
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt);
        attemptRecord.delay = delay;
        attempts.push(attemptRecord);

        // Call retry callback if provided
        if (this.config.onRetry) {
          this.config.onRetry(lastError, attempt);
        }

        // Wait before next attempt
        await this.delay(delay);
      }
    }

    // This should never be reached, but TypeScript needs it
    throw this.createAggregateError(lastError!, attempts, startTime, this.config.maxAttempts);
  }

  /**
   * Execute with circuit breaker and retry
   */
  public async executeWithCircuitBreaker<T>(
    circuitBreaker: CircuitBreaker,
    fn: () => Promise<T>
  ): Promise<T> {
    return this.execute(() => circuitBreaker.execute(fn));
  }

  /**
   * Execute with result wrapper (doesn't throw, returns result object)
   */
  public async tryExecute<T>(fn: () => Promise<T>): Promise<RetryResult<T>> {
    const startTime = Date.now();
    
    try {
      const result = await this.execute(fn);
      return {
        success: true,
        result,
        attempts: [],
        totalDuration: Date.now() - startTime,
        finalAttempt: 1
      };
    } catch (error) {
      const aggregateError = error as any;
      return {
        success: false,
        error: aggregateError,
        attempts: aggregateError.attempts || [],
        totalDuration: Date.now() - startTime,
        finalAttempt: aggregateError.finalAttempt || this.config.maxAttempts
      };
    }
  }

  private calculateDelay(attempt: number): number {
    // Exponential backoff: delay = initialDelay * (backoffMultiplier ^ (attempt - 1))
    let delay = this.config.initialDelay * Math.pow(this.config.backoffMultiplier, attempt - 1);
    
    // Cap at maximum delay
    delay = Math.min(delay, this.config.maxDelay);
    
    // Add jitter to prevent thundering herd
    if (this.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5); // Random between 50% and 100% of calculated delay
    }
    
    return Math.floor(delay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createAggregateError(
    lastError: Error, 
    attempts: RetryAttempt[], 
    startTime: number, 
    finalAttempt: number
  ): Error {
    const totalDuration = Date.now() - startTime;
    const error = new Error(
      `All ${this.config.maxAttempts} retry attempts failed after ${totalDuration}ms. Last error: ${lastError.message}`
    );

    (error as any).originalError = lastError;
    (error as any).attempts = attempts;
    (error as any).totalDuration = totalDuration;
    (error as any).finalAttempt = finalAttempt;
    (error as any).retryPolicy = {
      maxAttempts: this.config.maxAttempts,
      backoffMultiplier: this.config.backoffMultiplier
    };

    return error;
  }

  /**
   * Create common retry policies
   */
  public static createExponentialBackoff(
    maxAttempts: number = 3, 
    initialDelay: number = 1000
  ): RetryPolicy {
    return new RetryPolicy({
      maxAttempts,
      initialDelay,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitter: true
    });
  }

  public static createLinearBackoff(
    maxAttempts: number = 3, 
    delay: number = 1000
  ): RetryPolicy {
    return new RetryPolicy({
      maxAttempts,
      initialDelay: delay,
      maxDelay: delay * maxAttempts,
      backoffMultiplier: 1,
      jitter: false
    });
  }

  public static createFixedDelay(
    maxAttempts: number = 3, 
    delay: number = 1000
  ): RetryPolicy {
    return new RetryPolicy({
      maxAttempts,
      initialDelay: delay,
      maxDelay: delay,
      backoffMultiplier: 1,
      jitter: false
    });
  }

  public static createNetworkRetryPolicy(): RetryPolicy {
    return new RetryPolicy({
      maxAttempts: 3,
      initialDelay: 1000,
      maxDelay: 10000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: (error: Error) => {
        // Retry on network errors, timeouts, and 5xx status codes
        const message = error.message.toLowerCase();
        return message.includes('timeout') ||
               message.includes('network') ||
               message.includes('econnreset') ||
               message.includes('enotfound') ||
               message.includes('econnrefused') ||
               (message.includes('5') && message.includes('status'));
      }
    });
  }

  public static createDatabaseRetryPolicy(): RetryPolicy {
    return new RetryPolicy({
      maxAttempts: 5,
      initialDelay: 500,
      maxDelay: 5000,
      backoffMultiplier: 1.5,
      jitter: true,
      retryableErrors: (error: Error) => {
        const message = error.message.toLowerCase();
        return message.includes('connection') ||
               message.includes('timeout') ||
               message.includes('deadlock') ||
               message.includes('lock wait timeout') ||
               message.includes('too many connections');
      }
    });
  }

  public static createAPIRetryPolicy(): RetryPolicy {
    return new RetryPolicy({
      maxAttempts: 3,
      initialDelay: 2000,
      maxDelay: 8000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: (error: Error) => {
        const message = error.message.toLowerCase();
        // Retry on 5xx errors, timeouts, and network issues
        return message.includes('5') ||
               message.includes('timeout') ||
               message.includes('network') ||
               message.includes('service unavailable') ||
               message.includes('bad gateway') ||
               message.includes('gateway timeout');
      }
    });
  }

  public static createP2PRetryPolicy(): RetryPolicy {
    return new RetryPolicy({
      maxAttempts: 4,
      initialDelay: 1500,
      maxDelay: 12000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: (error: Error) => {
        const message = error.message.toLowerCase();
        return message.includes('peer') ||
               message.includes('connection') ||
               message.includes('timeout') ||
               message.includes('dial') ||
               message.includes('protocol');
      }
    });
  }

  public static createMiningRetryPolicy(): RetryPolicy {
    return new RetryPolicy({
      maxAttempts: 2, // Mining operations should fail fast
      initialDelay: 100,
      maxDelay: 500,
      backoffMultiplier: 2,
      jitter: false, // Consistent timing for mining
      retryableErrors: (error: Error) => {
        const message = error.message.toLowerCase();
        // Only retry on specific transient errors
        return message.includes('share validation') ||
               message.includes('temporary') ||
               message.includes('rate limit');
      }
    });
  }

  /**
   * Decorator for automatic retry
   */
  public static withRetry<T extends any[], R>(
    retryPolicy: RetryPolicy,
    target: (...args: T) => Promise<R>
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      return retryPolicy.execute(() => target(...args));
    };
  }

  /**
   * Get configuration
   */
  public getConfig(): RetryConfig {
    return { ...this.config };
  }
}