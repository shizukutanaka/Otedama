/**
 * Custom error classes for the pool
 * Following Clean Code principles: meaningful names, single responsibility
 */

export abstract class PoolError extends Error {
  public readonly timestamp: Date;
  public readonly context?: any;

  constructor(message: string, context?: any) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = new Date();
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      timestamp: this.timestamp,
      context: this.context,
      stack: this.stack
    };
  }
}

// Network errors
export class NetworkError extends PoolError {
  constructor(message: string, public readonly code?: string, context?: any) {
    super(message, context);
  }
}

export class ConnectionError extends NetworkError {
  constructor(message: string, public readonly address?: string, context?: any) {
    super(message, 'CONNECTION_ERROR', context);
  }
}

export class RpcError extends NetworkError {
  constructor(message: string, public readonly method?: string, context?: any) {
    super(message, 'RPC_ERROR', context);
  }
}

// Mining errors
export class MiningError extends PoolError {
  constructor(message: string, public readonly minerId?: string, context?: any) {
    super(message, context);
  }
}

export class InvalidShareError extends MiningError {
  constructor(
    message: string, 
    minerId?: string, 
    public readonly reason?: string,
    context?: any
  ) {
    super(message, minerId, context);
  }
}

export class InvalidBlockError extends MiningError {
  constructor(
    message: string,
    public readonly blockHash?: string,
    public readonly height?: number,
    context?: any
  ) {
    super(message, undefined, context);
  }
}

// Database errors
export class DatabaseError extends PoolError {
  constructor(message: string, public readonly operation?: string, context?: any) {
    super(message, context);
  }
}

export class DatabaseConnectionError extends DatabaseError {
  constructor(message: string, context?: any) {
    super(message, 'CONNECTION', context);
  }
}

export class DatabaseQueryError extends DatabaseError {
  constructor(message: string, public readonly query?: string, context?: any) {
    super(message, 'QUERY', context);
  }
}

// Configuration errors
export class ConfigurationError extends PoolError {
  constructor(message: string, public readonly field?: string, context?: any) {
    super(message, context);
  }
}

export class ValidationError extends ConfigurationError {
  constructor(
    message: string,
    field?: string,
    public readonly value?: any,
    context?: any
  ) {
    super(message, field, context);
  }
}

// Authentication errors
export class AuthenticationError extends PoolError {
  constructor(message: string, public readonly username?: string, context?: any) {
    super(message, context);
  }
}

export class AuthorizationError extends AuthenticationError {
  constructor(
    message: string,
    username?: string,
    public readonly resource?: string,
    context?: any
  ) {
    super(message, username, context);
  }
}

// P2P errors
export class P2PError extends PoolError {
  constructor(message: string, public readonly peerId?: string, context?: any) {
    super(message, context);
  }
}

export class PeerConnectionError extends P2PError {
  constructor(message: string, peerId?: string, context?: any) {
    super(message, peerId, context);
  }
}

export class ConsensusError extends P2PError {
  constructor(
    message: string,
    public readonly expectedValue?: any,
    public readonly actualValue?: any,
    context?: any
  ) {
    super(message, undefined, context);
  }
}

// Rate limiting errors
export class RateLimitError extends PoolError {
  constructor(
    message: string,
    public readonly limit: number,
    public readonly window: number,
    public readonly retryAfter?: number,
    context?: any
  ) {
    super(message, context);
  }
}

// Error handler utility
export class ErrorHandler {
  private static readonly logger = console; // Replace with actual logger

  static handle(error: Error): void {
    if (error instanceof PoolError) {
      this.handlePoolError(error);
    } else {
      this.handleGenericError(error);
    }
  }

  private static handlePoolError(error: PoolError): void {
    const errorInfo = error.toJSON();
    
    switch (true) {
      case error instanceof RateLimitError:
        this.logger.warn('Rate limit exceeded', errorInfo);
        break;
      
      case error instanceof InvalidShareError:
        this.logger.debug('Invalid share', errorInfo);
        break;
      
      case error instanceof DatabaseError:
        this.logger.error('Database error', errorInfo);
        break;
      
      case error instanceof NetworkError:
        this.logger.error('Network error', errorInfo);
        break;
      
      default:
        this.logger.error('Pool error', errorInfo);
    }
  }

  private static handleGenericError(error: Error): void {
    this.logger.error('Unexpected error', {
      name: error.name,
      message: error.message,
      stack: error.stack
    });
  }

  static isRetryable(error: Error): boolean {
    if (error instanceof NetworkError) {
      return true;
    }
    
    if (error instanceof DatabaseConnectionError) {
      return true;
    }
    
    if (error instanceof P2PError && !(error instanceof ConsensusError)) {
      return true;
    }
    
    return false;
  }

  static getRetryDelay(error: Error, attempt: number): number {
    if (error instanceof RateLimitError && error.retryAfter) {
      return error.retryAfter;
    }
    
    // Exponential backoff with jitter
    const baseDelay = 1000; // 1 second
    const maxDelay = 60000; // 60 seconds
    const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    const jitter = Math.random() * 0.3 * delay; // 30% jitter
    
    return Math.floor(delay + jitter);
  }
}

// Type guards
export function isPoolError(error: any): error is PoolError {
  return error instanceof PoolError;
}

export function isNetworkError(error: any): error is NetworkError {
  return error instanceof NetworkError;
}

export function isMiningError(error: any): error is MiningError {
  return error instanceof MiningError;
}

export function isDatabaseError(error: any): error is DatabaseError {
  return error instanceof DatabaseError;
}

export function isRetryableError(error: any): boolean {
  return ErrorHandler.isRetryable(error);
}
