/**
 * Timeout Management System
 * Design: Carmack (Performance) + Martin (Clean Architecture) + Pike (Simplicity)
 * 
 * Comprehensive timeout handling for connections and operations
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { createComponentLogger } from '../logging/simple-logger';

// ===== INTERFACES =====
export interface TimeoutConfig {
  connectionTimeout?: number;
  readTimeout?: number;
  writeTimeout?: number;
  idleTimeout?: number;
  operationTimeout?: number;
  keepAliveTimeout?: number;
}

export interface TimeoutContext {
  id: string;
  type: TimeoutType;
  startTime: number;
  timeout: number;
  description?: string;
  metadata?: any;
}

export enum TimeoutType {
  CONNECTION = 'CONNECTION',
  READ = 'READ',
  WRITE = 'WRITE',
  IDLE = 'IDLE',
  OPERATION = 'OPERATION',
  KEEP_ALIVE = 'KEEP_ALIVE',
  CUSTOM = 'CUSTOM'
}

export interface TimeoutStats {
  totalTimeouts: number;
  timeoutsByType: Record<TimeoutType, number>;
  averageTimeToTimeout: number;
  activeTimeouts: number;
}

// ===== TIMEOUT ERROR =====
export class TimeoutError extends Error {
  public readonly type: TimeoutType;
  public readonly duration: number;
  public readonly context?: any;

  constructor(message: string, type: TimeoutType, duration: number, context?: any) {
    super(message);
    this.name = 'TimeoutError';
    this.type = type;
    this.duration = duration;
    this.context = context;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TimeoutError);
    }
  }
}

// ===== TIMEOUT MANAGER =====
export class TimeoutManager extends EventEmitter {
  private config: Required<TimeoutConfig>;
  private timeouts = new Map<string, {
    context: TimeoutContext;
    timer: NodeJS.Timeout;
    callback?: (error: TimeoutError) => void;
  }>();
  private stats: TimeoutStats = {
    totalTimeouts: 0,
    timeoutsByType: {
      [TimeoutType.CONNECTION]: 0,
      [TimeoutType.READ]: 0,
      [TimeoutType.WRITE]: 0,
      [TimeoutType.IDLE]: 0,
      [TimeoutType.OPERATION]: 0,
      [TimeoutType.KEEP_ALIVE]: 0,
      [TimeoutType.CUSTOM]: 0
    },
    averageTimeToTimeout: 0,
    activeTimeouts: 0
  };
  private logger = createComponentLogger('TimeoutManager');

  constructor(config: TimeoutConfig = {}) {
    super();
    
    this.config = {
      connectionTimeout: config.connectionTimeout || 30000, // 30 seconds
      readTimeout: config.readTimeout || 60000, // 60 seconds
      writeTimeout: config.writeTimeout || 60000, // 60 seconds
      idleTimeout: config.idleTimeout || 300000, // 5 minutes
      operationTimeout: config.operationTimeout || 120000, // 2 minutes
      keepAliveTimeout: config.keepAliveTimeout || 60000 // 60 seconds
    };
  }

  // ===== TIMEOUT CREATION =====
  
  createTimeout(
    id: string,
    type: TimeoutType,
    timeout?: number,
    description?: string,
    metadata?: any
  ): string {
    // Clear existing timeout if any
    this.clearTimeout(id);

    const actualTimeout = timeout || this.getDefaultTimeout(type);
    const context: TimeoutContext = {
      id,
      type,
      startTime: Date.now(),
      timeout: actualTimeout,
      description,
      metadata
    };

    const timer = setTimeout(() => {
      this.handleTimeout(context);
    }, actualTimeout);

    this.timeouts.set(id, { context, timer });
    this.stats.activeTimeouts++;

    this.logger.debug('Timeout created', {
      id,
      type,
      timeout: actualTimeout,
      description
    });

    return id;
  }

  createConnectionTimeout(id: string, metadata?: any): string {
    return this.createTimeout(
      id,
      TimeoutType.CONNECTION,
      this.config.connectionTimeout,
      'Connection timeout',
      metadata
    );
  }

  createReadTimeout(id: string, metadata?: any): string {
    return this.createTimeout(
      id,
      TimeoutType.READ,
      this.config.readTimeout,
      'Read timeout',
      metadata
    );
  }

  createWriteTimeout(id: string, metadata?: any): string {
    return this.createTimeout(
      id,
      TimeoutType.WRITE,
      this.config.writeTimeout,
      'Write timeout',
      metadata
    );
  }

  createIdleTimeout(id: string, metadata?: any): string {
    return this.createTimeout(
      id,
      TimeoutType.IDLE,
      this.config.idleTimeout,
      'Idle timeout',
      metadata
    );
  }

  createOperationTimeout(
    id: string,
    operation: string,
    timeout?: number,
    metadata?: any
  ): string {
    return this.createTimeout(
      id,
      TimeoutType.OPERATION,
      timeout || this.config.operationTimeout,
      `Operation timeout: ${operation}`,
      metadata
    );
  }

  // ===== TIMEOUT WITH CALLBACK =====
  
  withTimeout<T>(
    fn: () => Promise<T>,
    timeout: number,
    type: TimeoutType = TimeoutType.OPERATION,
    description?: string
  ): Promise<T> {
    const id = `promise_${Date.now()}_${Math.random()}`;
    
    return new Promise<T>(async (resolve, reject) => {
      const timeoutId = this.createTimeout(id, type, timeout, description);
      
      // Set callback for timeout
      const timeoutData = this.timeouts.get(id);
      if (timeoutData) {
        timeoutData.callback = (error) => reject(error);
      }

      try {
        const result = await fn();
        this.clearTimeout(id);
        resolve(result);
      } catch (error) {
        this.clearTimeout(id);
        reject(error);
      }
    });
  }

  // ===== TIMEOUT MANAGEMENT =====
  
  clearTimeout(id: string): boolean {
    const timeoutData = this.timeouts.get(id);
    if (!timeoutData) {
      return false;
    }

    clearTimeout(timeoutData.timer);
    this.timeouts.delete(id);
    this.stats.activeTimeouts--;

    this.logger.debug('Timeout cleared', {
      id,
      type: timeoutData.context.type
    });

    return true;
  }

  refreshTimeout(id: string, newTimeout?: number): boolean {
    const timeoutData = this.timeouts.get(id);
    if (!timeoutData) {
      return false;
    }

    clearTimeout(timeoutData.timer);
    
    const actualTimeout = newTimeout || timeoutData.context.timeout;
    timeoutData.context.timeout = actualTimeout;
    
    timeoutData.timer = setTimeout(() => {
      this.handleTimeout(timeoutData.context);
    }, actualTimeout);

    this.logger.debug('Timeout refreshed', {
      id,
      type: timeoutData.context.type,
      newTimeout: actualTimeout
    });

    return true;
  }

  clearAll(): void {
    for (const [id] of this.timeouts) {
      this.clearTimeout(id);
    }
  }

  // ===== TIMEOUT HANDLING =====
  
  private handleTimeout(context: TimeoutContext): void {
    const duration = Date.now() - context.startTime;
    const error = new TimeoutError(
      context.description || `${context.type} timeout after ${duration}ms`,
      context.type,
      duration,
      context.metadata
    );

    // Update stats
    this.stats.totalTimeouts++;
    this.stats.timeoutsByType[context.type]++;
    this.updateAverageTimeout(duration);

    // Get and remove timeout data
    const timeoutData = this.timeouts.get(context.id);
    this.timeouts.delete(context.id);
    this.stats.activeTimeouts--;

    // Log timeout
    this.logger.warn('Timeout occurred', {
      id: context.id,
      type: context.type,
      duration,
      description: context.description
    });

    // Emit event
    this.emit('timeout', { context, error });
    this.emit(`timeout:${context.type.toLowerCase()}`, { context, error });

    // Call callback if provided
    if (timeoutData?.callback) {
      timeoutData.callback(error);
    }
  }

  private getDefaultTimeout(type: TimeoutType): number {
    switch (type) {
      case TimeoutType.CONNECTION:
        return this.config.connectionTimeout;
      case TimeoutType.READ:
        return this.config.readTimeout;
      case TimeoutType.WRITE:
        return this.config.writeTimeout;
      case TimeoutType.IDLE:
        return this.config.idleTimeout;
      case TimeoutType.OPERATION:
        return this.config.operationTimeout;
      case TimeoutType.KEEP_ALIVE:
        return this.config.keepAliveTimeout;
      default:
        return this.config.operationTimeout;
    }
  }

  private updateAverageTimeout(duration: number): void {
    const total = this.stats.totalTimeouts;
    const currentAvg = this.stats.averageTimeToTimeout;
    this.stats.averageTimeToTimeout = (currentAvg * (total - 1) + duration) / total;
  }

  // ===== UTILITIES =====
  
  getStats(): TimeoutStats {
    return { ...this.stats };
  }

  getActiveTimeouts(): TimeoutContext[] {
    return Array.from(this.timeouts.values()).map(t => ({ ...t.context }));
  }

  hasTimeout(id: string): boolean {
    return this.timeouts.has(id);
  }

  getRemainingTime(id: string): number | null {
    const timeoutData = this.timeouts.get(id);
    if (!timeoutData) {
      return null;
    }

    const elapsed = Date.now() - timeoutData.context.startTime;
    const remaining = timeoutData.context.timeout - elapsed;
    
    return Math.max(0, remaining);
  }
}

// ===== CONNECTION TIMEOUT WRAPPER =====
export class TimeoutConnection extends EventEmitter {
  private connection: any;
  private timeoutManager: TimeoutManager;
  private timeoutIds = {
    connection: '',
    read: '',
    write: '',
    idle: ''
  };
  private logger = createComponentLogger('TimeoutConnection');
  private lastActivity = Date.now();

  constructor(
    connection: any,
    timeoutManager: TimeoutManager,
    private connectionId: string
  ) {
    super();
    
    this.connection = connection;
    this.timeoutManager = timeoutManager;
    
    this.setupTimeouts();
    this.wrapMethods();
  }

  private setupTimeouts(): void {
    // Set initial connection timeout
    this.timeoutIds.connection = this.timeoutManager.createConnectionTimeout(
      `conn_${this.connectionId}`,
      { connectionId: this.connectionId }
    );

    // Set idle timeout
    this.resetIdleTimeout();

    // Handle connection events
    this.connection.on('connect', () => {
      this.timeoutManager.clearTimeout(this.timeoutIds.connection);
      this.resetIdleTimeout();
    });

    this.connection.on('data', () => {
      this.handleActivity();
    });

    this.connection.on('close', () => {
      this.clearAllTimeouts();
    });

    this.connection.on('error', () => {
      this.clearAllTimeouts();
    });
  }

  private wrapMethods(): void {
    // Wrap write method
    const originalWrite = this.connection.write.bind(this.connection);
    this.connection.write = (data: any, ...args: any[]) => {
      this.handleActivity();
      
      // Set write timeout
      const writeTimeoutId = this.timeoutManager.createWriteTimeout(
        `write_${this.connectionId}_${Date.now()}`,
        { connectionId: this.connectionId }
      );

      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        args[args.length - 1] = (error?: Error) => {
          this.timeoutManager.clearTimeout(writeTimeoutId);
          callback(error);
        };
      } else {
        // No callback provided, clear timeout on next tick
        process.nextTick(() => {
          this.timeoutManager.clearTimeout(writeTimeoutId);
        });
      }

      return originalWrite(data, ...args);
    };

    // Wrap read method if exists
    if (this.connection.read) {
      const originalRead = this.connection.read.bind(this.connection);
      this.connection.read = (...args: any[]) => {
        this.handleActivity();
        
        // Set read timeout
        const readTimeoutId = this.timeoutManager.createReadTimeout(
          `read_${this.connectionId}_${Date.now()}`,
          { connectionId: this.connectionId }
        );

        const result = originalRead(...args);
        
        // Clear timeout after read
        process.nextTick(() => {
          this.timeoutManager.clearTimeout(readTimeoutId);
        });

        return result;
      };
    }
  }

  private handleActivity(): void {
    this.lastActivity = Date.now();
    this.resetIdleTimeout();
  }

  private resetIdleTimeout(): void {
    if (this.timeoutIds.idle) {
      this.timeoutManager.clearTimeout(this.timeoutIds.idle);
    }

    this.timeoutIds.idle = this.timeoutManager.createIdleTimeout(
      `idle_${this.connectionId}`,
      { connectionId: this.connectionId }
    );

    // Listen for idle timeout
    this.timeoutManager.once(`timeout:${TimeoutType.IDLE.toLowerCase()}`, (data) => {
      if (data.context.id === this.timeoutIds.idle) {
        this.logger.warn('Connection idle timeout', {
          connectionId: this.connectionId,
          lastActivity: Date.now() - this.lastActivity
        });
        
        this.connection.destroy();
        this.emit('timeout', { type: TimeoutType.IDLE });
      }
    });
  }

  private clearAllTimeouts(): void {
    Object.values(this.timeoutIds).forEach(id => {
      if (id) {
        this.timeoutManager.clearTimeout(id);
      }
    });
  }

  getConnection(): any {
    return this.connection;
  }

  getLastActivity(): number {
    return this.lastActivity;
  }

  destroy(): void {
    this.clearAllTimeouts();
    this.connection.destroy();
  }
}

// ===== OPERATION TIMEOUT WRAPPER =====
export class TimeoutOperation<T> {
  private timeoutManager: TimeoutManager;
  private operationId: string;
  private startTime: number;
  private completed = false;

  constructor(
    timeoutManager: TimeoutManager,
    private operation: string,
    private timeout: number
  ) {
    this.timeoutManager = timeoutManager;
    this.operationId = `op_${Date.now()}_${Math.random()}`;
    this.startTime = Date.now();
  }

  async execute(fn: () => Promise<T>): Promise<T> {
    if (this.completed) {
      throw new Error('Operation already completed');
    }

    try {
      const result = await this.timeoutManager.withTimeout(
        fn,
        this.timeout,
        TimeoutType.OPERATION,
        this.operation
      );

      this.completed = true;
      const duration = Date.now() - this.startTime;

      // Log successful completion
      const logger = createComponentLogger('TimeoutOperation');
      logger.debug('Operation completed', {
        operation: this.operation,
        duration
      });

      return result;
    } catch (error) {
      this.completed = true;
      
      if (error instanceof TimeoutError) {
        // Add operation context
        error.context = {
          ...error.context,
          operation: this.operation
        };
      }
      
      throw error;
    }
  }

  isCompleted(): boolean {
    return this.completed;
  }

  getDuration(): number {
    return Date.now() - this.startTime;
  }
}

// ===== RETRY WITH TIMEOUT =====
export class RetryWithTimeout {
  constructor(
    private timeoutManager: TimeoutManager,
    private maxRetries: number = 3,
    private retryDelay: number = 1000,
    private backoffFactor: number = 2
  ) {}

  async execute<T>(
    fn: () => Promise<T>,
    timeout: number,
    operation: string
  ): Promise<T> {
    let lastError: Error | null = null;
    let delay = this.retryDelay;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const op = new TimeoutOperation<T>(
          this.timeoutManager,
          `${operation} (attempt ${attempt + 1})`,
          timeout
        );

        return await op.execute(fn);
      } catch (error) {
        lastError = error as Error;
        
        if (attempt < this.maxRetries) {
          // Check if error is retryable
          if (error instanceof TimeoutError || this.isRetryableError(error as Error)) {
            await this.sleep(delay);
            delay *= this.backoffFactor;
          } else {
            // Non-retryable error
            break;
          }
        }
      }
    }

    throw lastError;
  }

  private isRetryableError(error: Error): boolean {
    // Check for network errors, connection errors, etc.
    const retryableMessages = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENETUNREACH'
    ];

    return retryableMessages.some(msg => error.message.includes(msg));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ===== ADAPTIVE TIMEOUT =====
export class AdaptiveTimeout {
  private history: number[] = [];
  private maxHistory = 100;
  private baseTimeout: number;
  private minTimeout: number;
  private maxTimeout: number;

  constructor(
    baseTimeout: number,
    minTimeout?: number,
    maxTimeout?: number
  ) {
    this.baseTimeout = baseTimeout;
    this.minTimeout = minTimeout || baseTimeout * 0.5;
    this.maxTimeout = maxTimeout || baseTimeout * 3;
  }

  recordSuccess(duration: number): void {
    this.history.push(duration);
    
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  getTimeout(): number {
    if (this.history.length < 10) {
      return this.baseTimeout;
    }

    // Calculate P95 of recent durations
    const sorted = [...this.history].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p95Duration = sorted[p95Index];

    // Add 50% buffer
    const adaptiveTimeout = p95Duration * 1.5;

    // Clamp to min/max
    return Math.max(
      this.minTimeout,
      Math.min(this.maxTimeout, adaptiveTimeout)
    );
  }

  reset(): void {
    this.history = [];
  }

  getStats() {
    if (this.history.length === 0) {
      return {
        samples: 0,
        average: 0,
        min: 0,
        max: 0,
        p50: 0,
        p95: 0,
        p99: 0
      };
    }

    const sorted = [...this.history].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      samples: sorted.length,
      average: sum / sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)]
    };
  }
}
