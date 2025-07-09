import { EventEmitter } from 'events';

/**
 * Circuit Breaker Implementation
 * Philosophy: Fail fast to prevent cascade failures (Martin)
 * Performance: Minimal overhead, intelligent state management (Carmack)
 * Simplicity: Clear state transitions and thresholds (Pike)
 */

interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening
  timeout: number; // Time in ms to wait before trying again
  monitoringPeriod: number; // Time window for monitoring failures
  expectedFailureRate: number; // Expected failure rate (0-1)
  minimumThroughput: number; // Minimum requests before circuit can open
}

interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  totalRequests: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  stateChangedAt: number;
  failureRate: number;
}

enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Failing, rejecting requests
  HALF_OPEN = 'HALF_OPEN' // Testing if service recovered
}

interface CircuitBreakerError extends Error {
  circuitState: CircuitState;
  stats: CircuitBreakerStats;
}

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private totalRequests = 0;
  private lastFailureTime: number | null = null;
  private lastSuccessTime: number | null = null;
  private stateChangedAt = Date.now();
  private nextAttemptTime = 0;
  private recentResults: Array<{ success: boolean; timestamp: number }> = [];

  constructor(
    private name: string,
    private config: CircuitBreakerConfig
  ) {
    super();
  }

  /**
   * Execute a function with circuit breaker protection
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalRequests++;
    this.cleanupOldResults();

    // Check if circuit should reject the request
    if (this.shouldRejectRequest()) {
      const error = new Error(`Circuit breaker '${this.name}' is ${this.state}`) as CircuitBreakerError;
      error.circuitState = this.state;
      error.stats = this.getStats();
      throw error;
    }

    const startTime = Date.now();
    
    try {
      const result = await fn();
      this.onSuccess(startTime);
      return result;
    } catch (error) {
      this.onFailure(startTime);
      throw error;
    }
  }

  /**
   * Execute with timeout wrapper
   */
  public async executeWithTimeout<T>(
    fn: () => Promise<T>, 
    timeoutMs: number
  ): Promise<T> {
    return this.execute(() => {
      return Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Operation timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
    });
  }

  private shouldRejectRequest(): boolean {
    const now = Date.now();

    switch (this.state) {
      case CircuitState.OPEN:
        if (now >= this.nextAttemptTime) {
          this.transitionToHalfOpen();
          return false;
        }
        return true;

      case CircuitState.HALF_OPEN:
        // Allow one request to test if service recovered
        return false;

      case CircuitState.CLOSED:
        return false;

      default:
        return false;
    }
  }

  private onSuccess(startTime: number): void {
    this.successCount++;
    this.lastSuccessTime = startTime;
    this.recordResult(true);

    if (this.state === CircuitState.HALF_OPEN) {
      // Success in half-open state means we can close the circuit
      this.transitionToClosed();
    }

    this.emit('success', {
      duration: Date.now() - startTime,
      state: this.state
    });
  }

  private onFailure(startTime: number): void {
    this.failureCount++;
    this.lastFailureTime = startTime;
    this.recordResult(false);

    if (this.state === CircuitState.HALF_OPEN) {
      // Failure in half-open state means service is still down
      this.transitionToOpen();
    } else if (this.state === CircuitState.CLOSED && this.shouldOpenCircuit()) {
      this.transitionToOpen();
    }

    this.emit('failure', {
      duration: Date.now() - startTime,
      state: this.state,
      failureCount: this.failureCount
    });
  }

  private shouldOpenCircuit(): boolean {
    // Need minimum throughput before we can make decisions
    if (this.totalRequests < this.config.minimumThroughput) {
      return false;
    }

    // Check failure threshold
    if (this.failureCount >= this.config.failureThreshold) {
      return true;
    }

    // Check failure rate
    const failureRate = this.calculateFailureRate();
    return failureRate > this.config.expectedFailureRate;
  }

  private calculateFailureRate(): number {
    if (this.recentResults.length === 0) return 0;
    
    const failures = this.recentResults.filter(r => !r.success).length;
    return failures / this.recentResults.length;
  }

  private recordResult(success: boolean): void {
    this.recentResults.push({
      success,
      timestamp: Date.now()
    });

    // Keep only recent results
    if (this.recentResults.length > 100) {
      this.recentResults = this.recentResults.slice(-50);
    }
  }

  private cleanupOldResults(): void {
    const cutoff = Date.now() - this.config.monitoringPeriod;
    this.recentResults = this.recentResults.filter(r => r.timestamp > cutoff);
  }

  private transitionToOpen(): void {
    this.state = CircuitState.OPEN;
    this.stateChangedAt = Date.now();
    this.nextAttemptTime = Date.now() + this.config.timeout;
    
    this.emit('stateChange', {
      from: this.state,
      to: CircuitState.OPEN,
      reason: 'failure_threshold_exceeded'
    });
  }

  private transitionToHalfOpen(): void {
    this.state = CircuitState.HALF_OPEN;
    this.stateChangedAt = Date.now();
    
    this.emit('stateChange', {
      from: CircuitState.OPEN,
      to: CircuitState.HALF_OPEN,
      reason: 'timeout_expired'
    });
  }

  private transitionToClosed(): void {
    this.state = CircuitState.CLOSED;
    this.stateChangedAt = Date.now();
    this.failureCount = 0;
    this.successCount = 0;
    
    this.emit('stateChange', {
      from: CircuitState.HALF_OPEN,
      to: CircuitState.CLOSED,
      reason: 'success_in_half_open'
    });
  }

  public getStats(): CircuitBreakerStats {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalRequests: this.totalRequests,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      stateChangedAt: this.stateChangedAt,
      failureRate: this.calculateFailureRate()
    };
  }

  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.totalRequests = 0;
    this.lastFailureTime = null;
    this.lastSuccessTime = null;
    this.stateChangedAt = Date.now();
    this.recentResults = [];
    
    this.emit('reset');
  }

  public getName(): string {
    return this.name;
  }

  public getState(): CircuitState {
    return this.state;
  }

  public isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  public isClosed(): boolean {
    return this.state === CircuitState.CLOSED;
  }

  public isHalfOpen(): boolean {
    return this.state === CircuitState.HALF_OPEN;
  }
}

/**
 * Retry Policy Implementation
 * Intelligent retry with exponential backoff and jitter
 */

interface RetryConfig {
  maxAttempts: number;
  initialDelay: number; // milliseconds
  maxDelay: number; // milliseconds
  backoffMultiplier: number;
  jitter: boolean; // Add randomness to prevent thundering herd
  retryableErrors?: (error: Error) => boolean;
}

interface RetryStats {
  attempt: number;
  totalAttempts: number;
  totalDelay: number;
  errors: Error[];
}

export class RetryPolicy {
  constructor(private config: RetryConfig) {}

  /**
   * Execute a function with retry policy
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    const stats: RetryStats = {
      attempt: 0,
      totalAttempts: this.config.maxAttempts,
      totalDelay: 0,
      errors: []
    };

    let lastError: Error;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      stats.attempt = attempt;

      try {
        const result = await fn();
        return result;
      } catch (error) {
        lastError = error as Error;
        stats.errors.push(lastError);

        // Check if this error is retryable
        if (this.config.retryableErrors && !this.config.retryableErrors(lastError)) {
          throw lastError;
        }

        // If this was the last attempt, throw the error
        if (attempt === this.config.maxAttempts) {
          const aggregateError = new Error(
            `All ${this.config.maxAttempts} retry attempts failed. Last error: ${lastError.message}`
          );
          (aggregateError as any).stats = stats;
          (aggregateError as any).errors = stats.errors;
          throw aggregateError;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt);
        stats.totalDelay += delay;

        // Wait before next attempt
        await this.delay(delay);
      }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError!;
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

  /**
   * Create common retry policies
   */
  public static createExponentialBackoff(maxAttempts: number = 3): RetryPolicy {
    return new RetryPolicy({
      maxAttempts,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitter: true
    });
  }

  public static createLinearBackoff(maxAttempts: number = 3, delay: number = 1000): RetryPolicy {
    return new RetryPolicy({
      maxAttempts,
      initialDelay: delay,
      maxDelay: delay * maxAttempts,
      backoffMultiplier: 1,
      jitter: false
    });
  }

  public static createFixedDelay(maxAttempts: number = 3, delay: number = 1000): RetryPolicy {
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
               message.includes('5') && message.includes('status');
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
               message.includes('lock wait timeout');
      }
    });
  }
}

/**
 * Circuit Breaker Manager
 * Manages multiple circuit breakers for different services
 */
export class CircuitBreakerManager {
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private defaultConfig: CircuitBreakerConfig = {
    failureThreshold: 5,
    timeout: 60000, // 1 minute
    monitoringPeriod: 300000, // 5 minutes
    expectedFailureRate: 0.5, // 50%
    minimumThroughput: 10
  };

  public getOrCreate(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    if (this.circuitBreakers.has(name)) {
      return this.circuitBreakers.get(name)!;
    }

    const finalConfig = { ...this.defaultConfig, ...config };
    const circuitBreaker = new CircuitBreaker(name, finalConfig);
    
    this.circuitBreakers.set(name, circuitBreaker);
    return circuitBreaker;
  }

  public get(name: string): CircuitBreaker | undefined {
    return this.circuitBreakers.get(name);
  }

  public getAllStats(): Map<string, CircuitBreakerStats> {
    const stats = new Map<string, CircuitBreakerStats>();
    this.circuitBreakers.forEach((cb, name) => {
      stats.set(name, cb.getStats());
    });
    return stats;
  }

  public resetAll(): void {
    this.circuitBreakers.forEach(cb => cb.reset());
  }

  public getHealthySummary(): {
    total: number;
    closed: number;
    open: number;
    halfOpen: number;
  } {
    let closed = 0, open = 0, halfOpen = 0;
    
    this.circuitBreakers.forEach(cb => {
      switch (cb.getState()) {
        case CircuitState.CLOSED: closed++; break;
        case CircuitState.OPEN: open++; break;
        case CircuitState.HALF_OPEN: halfOpen++; break;
      }
    });

    return {
      total: this.circuitBreakers.size,
      closed,
      open,
      halfOpen
    };
  }
}