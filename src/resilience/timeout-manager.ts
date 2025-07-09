/**
 * Timeout Manager Implementation
 * Philosophy: Prevent operations from hanging indefinitely (Martin)
 * Performance: Efficient timeout tracking with minimal overhead (Carmack)
 * Simplicity: Clear timeout policies and cancellation (Pike)
 */

interface TimeoutConfig {
  defaultTimeout: number; // Default timeout in milliseconds
  operationTimeouts: Map<string, number>; // Specific timeouts for operations
  warningThreshold: number; // Warn when operation takes this % of timeout
  enableMetrics: boolean; // Track timeout metrics
}

interface TimeoutOperation {
  id: string;
  name: string;
  startTime: number;
  timeout: number;
  promise: Promise<any>;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeoutHandle: NodeJS.Timeout;
  warningHandle?: NodeJS.Timeout;
  abortController?: AbortController;
}

interface TimeoutMetrics {
  totalOperations: number;
  timedOutOperations: number;
  completedOperations: number;
  averageDuration: number;
  timeoutRate: number;
  operationsByType: Map<string, {
    count: number;
    timeouts: number;
    averageDuration: number;
  }>;
}

export class TimeoutManager {
  private activeOperations = new Map<string, TimeoutOperation>();
  private metrics: TimeoutMetrics;
  private operationCounter = 0;

  constructor(private config: TimeoutConfig) {
    this.metrics = {
      totalOperations: 0,
      timedOutOperations: 0,
      completedOperations: 0,
      averageDuration: 0,
      timeoutRate: 0,
      operationsByType: new Map()
    };
  }

  /**
   * Execute an operation with timeout
   */
  public async execute<T>(
    operationName: string,
    operation: () => Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    const operationId = `${operationName}_${++this.operationCounter}`;
    const timeout = timeoutMs || this.getTimeoutForOperation(operationName);
    
    return new Promise<T>((resolve, reject) => {
      const startTime = Date.now();
      
      // Create timeout operation record
      const timeoutOp: TimeoutOperation = {
        id: operationId,
        name: operationName,
        startTime,
        timeout,
        promise: Promise.resolve(), // Will be updated
        resolve,
        reject,
        timeoutHandle: setTimeout(() => {
          this.handleTimeout(operationId);
        }, timeout),
        abortController: new AbortController()
      };

      // Set warning timer
      if (this.config.warningThreshold > 0) {
        const warningTime = timeout * (this.config.warningThreshold / 100);
        timeoutOp.warningHandle = setTimeout(() => {
          this.handleWarning(operationId);
        }, warningTime);
      }

      this.activeOperations.set(operationId, timeoutOp);
      this.updateMetrics(operationName, 'started');

      // Execute the operation
      operation()
        .then((result) => {
          this.handleSuccess(operationId, result);
        })
        .catch((error) => {
          this.handleError(operationId, error);
        });
    });
  }

  /**
   * Execute with AbortController support
   */
  public async executeWithAbort<T>(
    operationName: string,
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    const operationId = `${operationName}_${++this.operationCounter}`;
    const timeout = timeoutMs || this.getTimeoutForOperation(operationName);
    
    return new Promise<T>((resolve, reject) => {
      const startTime = Date.now();
      const abortController = new AbortController();
      
      const timeoutOp: TimeoutOperation = {
        id: operationId,
        name: operationName,
        startTime,
        timeout,
        promise: Promise.resolve(),
        resolve,
        reject,
        timeoutHandle: setTimeout(() => {
          abortController.abort();
          this.handleTimeout(operationId);
        }, timeout),
        abortController
      };

      // Set warning timer
      if (this.config.warningThreshold > 0) {
        const warningTime = timeout * (this.config.warningThreshold / 100);
        timeoutOp.warningHandle = setTimeout(() => {
          this.handleWarning(operationId);
        }, warningTime);
      }

      this.activeOperations.set(operationId, timeoutOp);
      this.updateMetrics(operationName, 'started');

      // Execute the operation with abort signal
      operation(abortController.signal)
        .then((result) => {
          this.handleSuccess(operationId, result);
        })
        .catch((error) => {
          if (abortController.signal.aborted) {
            this.handleTimeout(operationId);
          } else {
            this.handleError(operationId, error);
          }
        });
    });
  }

  /**
   * Create a timeout promise that can be used with Promise.race
   */
  public createTimeoutPromise<T>(
    operationName: string,
    timeoutMs?: number
  ): Promise<T> {
    const timeout = timeoutMs || this.getTimeoutForOperation(operationName);
    
    return new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(operationName, timeout));
      }, timeout);
    });
  }

  /**
   * Wrap a promise with timeout
   */
  public async wrapWithTimeout<T>(
    operationName: string,
    promise: Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    const timeout = timeoutMs || this.getTimeoutForOperation(operationName);
    
    return Promise.race([
      promise,
      this.createTimeoutPromise<T>(operationName, timeout)
    ]);
  }

  /**
   * Set timeout for specific operation type
   */
  public setOperationTimeout(operationName: string, timeoutMs: number): void {
    this.config.operationTimeouts.set(operationName, timeoutMs);
  }

  /**
   * Get active operations
   */
  public getActiveOperations(): TimeoutOperation[] {
    return Array.from(this.activeOperations.values());
  }

  /**
   * Cancel a specific operation
   */
  public cancelOperation(operationId: string): boolean {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return false;

    this.cleanup(operationId);
    operation.reject(new Error(`Operation ${operationId} was cancelled`));
    return true;
  }

  /**
   * Cancel all operations of a specific type
   */
  public cancelOperationsOfType(operationName: string): number {
    let cancelledCount = 0;
    
    this.activeOperations.forEach((operation, id) => {
      if (operation.name === operationName) {
        this.cancelOperation(id);
        cancelledCount++;
      }
    });

    return cancelledCount;
  }

  /**
   * Cancel all active operations
   */
  public cancelAllOperations(): number {
    const activeCount = this.activeOperations.size;
    
    this.activeOperations.forEach((operation, id) => {
      this.cancelOperation(id);
    });

    return activeCount;
  }

  private getTimeoutForOperation(operationName: string): number {
    return this.config.operationTimeouts.get(operationName) || this.config.defaultTimeout;
  }

  private handleSuccess(operationId: string, result: any): void {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    const duration = Date.now() - operation.startTime;
    this.cleanup(operationId);
    this.updateMetrics(operation.name, 'completed', duration);
    operation.resolve(result);
  }

  private handleError(operationId: string, error: Error): void {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    const duration = Date.now() - operation.startTime;
    this.cleanup(operationId);
    this.updateMetrics(operation.name, 'error', duration);
    operation.reject(error);
  }

  private handleTimeout(operationId: string): void {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    this.cleanup(operationId);
    this.updateMetrics(operation.name, 'timeout');
    
    const error = new TimeoutError(operation.name, operation.timeout);
    operation.reject(error);
  }

  private handleWarning(operationId: string): void {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    const elapsed = Date.now() - operation.startTime;
    console.warn(`Operation ${operation.name} (${operationId}) is taking longer than expected: ${elapsed}ms / ${operation.timeout}ms`);
  }

  private cleanup(operationId: string): void {
    const operation = this.activeOperations.get(operationId);
    if (!operation) return;

    clearTimeout(operation.timeoutHandle);
    if (operation.warningHandle) {
      clearTimeout(operation.warningHandle);
    }
    if (operation.abortController) {
      operation.abortController.abort();
    }

    this.activeOperations.delete(operationId);
  }

  private updateMetrics(operationName: string, event: 'started' | 'completed' | 'timeout' | 'error', duration?: number): void {
    if (!this.config.enableMetrics) return;

    switch (event) {
      case 'started':
        this.metrics.totalOperations++;
        break;
      
      case 'completed':
        this.metrics.completedOperations++;
        if (duration !== undefined) {
          this.updateAverageDuration(duration);
          this.updateOperationTypeMetrics(operationName, 'completed', duration);
        }
        break;
      
      case 'timeout':
        this.metrics.timedOutOperations++;
        this.updateOperationTypeMetrics(operationName, 'timeout');
        break;
      
      case 'error':
        if (duration !== undefined) {
          this.updateAverageDuration(duration);
          this.updateOperationTypeMetrics(operationName, 'error', duration);
        }
        break;
    }

    // Update timeout rate
    this.metrics.timeoutRate = this.metrics.totalOperations > 0 ? 
      (this.metrics.timedOutOperations / this.metrics.totalOperations) * 100 : 0;
  }

  private updateAverageDuration(duration: number): void {
    const totalCompleted = this.metrics.completedOperations;
    if (totalCompleted === 1) {
      this.metrics.averageDuration = duration;
    } else {
      this.metrics.averageDuration = 
        (this.metrics.averageDuration * (totalCompleted - 1) + duration) / totalCompleted;
    }
  }

  private updateOperationTypeMetrics(operationName: string, event: 'completed' | 'timeout' | 'error', duration?: number): void {
    let typeMetrics = this.metrics.operationsByType.get(operationName);
    if (!typeMetrics) {
      typeMetrics = { count: 0, timeouts: 0, averageDuration: 0 };
      this.metrics.operationsByType.set(operationName, typeMetrics);
    }

    typeMetrics.count++;
    
    if (event === 'timeout') {
      typeMetrics.timeouts++;
    } else if (duration !== undefined) {
      if (typeMetrics.count === 1) {
        typeMetrics.averageDuration = duration;
      } else {
        typeMetrics.averageDuration = 
          (typeMetrics.averageDuration * (typeMetrics.count - 1) + duration) / typeMetrics.count;
      }
    }
  }

  /**
   * Get timeout metrics
   */
  public getMetrics(): TimeoutMetrics {
    return {
      ...this.metrics,
      operationsByType: new Map(this.metrics.operationsByType)
    };
  }

  /**
   * Reset metrics
   */
  public resetMetrics(): void {
    this.metrics = {
      totalOperations: 0,
      timedOutOperations: 0,
      completedOperations: 0,
      averageDuration: 0,
      timeoutRate: 0,
      operationsByType: new Map()
    };
  }

  /**
   * Get configuration
   */
  public getConfig(): TimeoutConfig {
    return {
      ...this.config,
      operationTimeouts: new Map(this.config.operationTimeouts)
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: Partial<TimeoutConfig>): void {
    Object.assign(this.config, newConfig);
  }

  /**
   * Create common timeout configurations
   */
  public static createDatabaseTimeouts(): Map<string, number> {
    return new Map([
      ['db_query', 5000],
      ['db_transaction', 10000],
      ['db_migration', 60000],
      ['db_backup', 300000]
    ]);
  }

  public static createNetworkTimeouts(): Map<string, number> {
    return new Map([
      ['http_request', 10000],
      ['p2p_dial', 15000],
      ['p2p_handshake', 5000],
      ['blockchain_rpc', 30000]
    ]);
  }

  public static createMiningTimeouts(): Map<string, number> {
    return new Map([
      ['share_validation', 1000],
      ['block_creation', 5000],
      ['job_distribution', 2000],
      ['payout_processing', 30000]
    ]);
  }

  public static createDefaultConfig(): TimeoutConfig {
    const timeouts = new Map([
      ...TimeoutManager.createDatabaseTimeouts(),
      ...TimeoutManager.createNetworkTimeouts(),
      ...TimeoutManager.createMiningTimeouts()
    ]);

    return {
      defaultTimeout: 30000, // 30 seconds
      operationTimeouts: timeouts,
      warningThreshold: 80, // Warn at 80% of timeout
      enableMetrics: true
    };
  }
}

/**
 * Custom timeout error
 */
export class TimeoutError extends Error {
  public readonly isTimeout = true;
  
  constructor(
    public readonly operationName: string,
    public readonly timeoutMs: number
  ) {
    super(`Operation '${operationName}' timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Timeout decorator for methods
 */
export function withTimeout(timeoutMs: number, operationName?: string) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const opName = operationName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      const timeoutManager = new TimeoutManager(TimeoutManager.createDefaultConfig());
      return timeoutManager.execute(opName, () => originalMethod.apply(this, args), timeoutMs);
    };

    return descriptor;
  };
}

/**
 * Utility functions for common timeout patterns
 */
export class TimeoutUtils {
  /**
   * Create a delay with timeout
   */
  public static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Race promises with timeout
   */
  public static async raceWithTimeout<T>(
    promises: Promise<T>[],
    timeoutMs: number,
    operationName: string = 'race_operation'
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError(operationName, timeoutMs));
      }, timeoutMs);
    });

    return Promise.race([...promises, timeoutPromise]);
  }

  /**
   * Timeout with custom error
   */
  public static async withCustomTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorFactory: () => Error
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(errorFactory());
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
  }

  /**
   * Batch operations with individual timeouts
   */
  public static async batchWithTimeout<T>(
    operations: (() => Promise<T>)[],
    timeoutMs: number,
    maxConcurrent: number = 5
  ): Promise<Array<T | Error>> {
    const results: Array<T | Error> = [];
    const timeoutManager = new TimeoutManager(TimeoutManager.createDefaultConfig());

    for (let i = 0; i < operations.length; i += maxConcurrent) {
      const batch = operations.slice(i, i + maxConcurrent);
      const batchPromises = batch.map((op, index) =>
        timeoutManager.execute(`batch_operation_${i + index}`, op, timeoutMs)
          .catch(error => error)
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    return results;
  }
}