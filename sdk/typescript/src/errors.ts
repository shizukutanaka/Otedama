/**
 * Custom error classes for Otedama SDK
 */

export class OtedamaError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'OtedamaError';
    Object.setPrototypeOf(this, OtedamaError.prototype);
  }
}

export class OtedamaValidationError extends OtedamaError {
  constructor(message: string, public field?: string, public value?: any) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'OtedamaValidationError';
    Object.setPrototypeOf(this, OtedamaValidationError.prototype);
  }
}

export class OtedamaAuthError extends OtedamaError {
  constructor(message: string) {
    super(message, 'AUTH_ERROR', 401);
    this.name = 'OtedamaAuthError';
    Object.setPrototypeOf(this, OtedamaAuthError.prototype);
  }
}

export class OtedamaNetworkError extends OtedamaError {
  constructor(message: string) {
    super(message, 'NETWORK_ERROR');
    this.name = 'OtedamaNetworkError';
    Object.setPrototypeOf(this, OtedamaNetworkError.prototype);
  }
}

export class OtedamaRateLimitError extends OtedamaError {
  constructor(message: string, public retryAfter?: number) {
    super(message, 'RATE_LIMIT', 429);
    this.name = 'OtedamaRateLimitError';
    Object.setPrototypeOf(this, OtedamaRateLimitError.prototype);
  }
}
