# Error Handling Best Practices Guide

This guide outlines the standardized error handling patterns for the Otedama codebase.

## Overview

The Otedama project uses a comprehensive, standardized error handling system that provides:

- **Consistent error formats** across all components
- **Contextual error information** for debugging
- **Recovery strategies** for different error types  
- **Circuit breaker patterns** for external service failures
- **Comprehensive metrics** and monitoring

## Core Components

### 1. Standardized Error Classes

```javascript
import { OtedamaError, ErrorUtils, ErrorCategory } from '../core/standardized-error-handler.js';

// Use predefined error utilities
throw ErrorUtils.validation('Invalid email format', { email: userInput });
throw ErrorUtils.authentication('Invalid credentials');
throw ErrorUtils.database('Connection failed', { host, port });

// Or create custom errors
throw new OtedamaError('Custom error message', {
  category: ErrorCategory.BUSINESS_LOGIC,
  severity: ErrorSeverity.HIGH,
  details: { userId, operation },
  retryable: false
});
```

### 2. Error Categories

All errors should use appropriate categories:

- `DATABASE` - Database connection/query errors
- `VALIDATION` - Input validation errors
- `AUTHENTICATION` - Auth/login errors
- `AUTHORIZATION` - Permission errors
- `RATE_LIMIT` - Rate limiting violations
- `EXTERNAL_API` - Third-party service errors
- `MINING`, `DEX`, `DEFI` - Domain-specific errors

### 3. Circuit Breaker Pattern

For external service calls:

```javascript
import { getErrorHandler } from '../core/standardized-error-handler.js';

const errorHandler = getErrorHandler();
const circuitBreaker = errorHandler.getCircuitBreaker('external-api', {
  failureThreshold: 5,
  timeout: 60000
});

const result = await circuitBreaker.execute(
  () => externalApiCall(),
  (error) => fallbackResponse(error) // Optional fallback
);
```

### 4. Retry Logic

For retryable operations:

```javascript
const result = await errorHandler.executeWithHandling(
  () => unreliableOperation(),
  {
    retry: {
      maxRetries: 3,
      initialDelay: 1000,
      backoffFactor: 2
    },
    retryCondition: (error, attempt) => {
      return error.retryable && attempt < 3;
    }
  }
);
```

## Usage Patterns

### 1. API Endpoints

```javascript
export async function apiHandler(req, res) {
  try {
    // Validation
    if (!req.body.email) {
      throw ErrorUtils.validation('Email is required', { field: 'email' });
    }
    
    // Business logic
    const result = await businessLogic(req.body);
    
    res.json({ success: true, data: result });
    
  } catch (error) {
    // Error handler middleware will catch and format this
    throw error;
  }
}
```

### 2. Database Operations

```javascript
async function getUserById(userId) {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    
    if (!user) {
      throw ErrorUtils.validation('User not found', { userId });
    }
    
    return user;
    
  } catch (error) {
    if (error.code === 'SQLITE_BUSY') {
      throw ErrorUtils.database('Database is busy', { 
        operation: 'getUserById',
        userId,
        retryable: true 
      });
    }
    throw error;
  }
}
```

### 3. External API Calls

```javascript
async function fetchExternalData(endpoint) {
  const errorHandler = getErrorHandler();
  
  return await errorHandler.executeWithHandling(
    async () => {
      const response = await fetch(endpoint);
      
      if (!response.ok) {
        throw ErrorUtils.externalApi(`API returned ${response.status}`, {
          endpoint,
          status: response.status,
          retryable: response.status >= 500
        });
      }
      
      return await response.json();
    },
    {
      circuitBreaker: {
        name: 'external-api',
        failureThreshold: 3
      },
      retry: {
        maxRetries: 2,
        initialDelay: 1000
      }
    }
  );
}
```

## Express.js Integration

The standardized error handler provides Express middleware:

```javascript
import { getErrorHandler } from '../core/standardized-error-handler.js';

const app = express();
const errorHandler = getErrorHandler();

// Add error handling middleware (must be last)
app.use(errorHandler.expressMiddleware());
```

## Error Response Format

All API errors follow this consistent format:

```json
{
  "error": {
    "code": "ERR_1642857123456_A1B2",
    "message": "User-friendly error message",
    "category": "VALIDATION_ERROR",
    "severity": "medium",
    "details": {
      "field": "email",
      "value": "invalid-email"
    },
    "context": {
      "operation": "user-registration",
      "userId": "user123"
    },
    "timestamp": "2024-01-22T10:30:00.000Z",
    "requestId": "req-uuid-123",
    "retryable": false,
    "userMessage": "Please check your email format"
  }
}
```

## Best Practices

### 1. Always Use Structured Errors

❌ **Bad:**
```javascript
throw new Error('Something went wrong');
```

✅ **Good:**
```javascript
throw ErrorUtils.validation('Email format is invalid', {
  email: userInput,
  pattern: EMAIL_REGEX
});
```

### 2. Include Context Information

❌ **Bad:**
```javascript
throw ErrorUtils.database('Query failed');
```

✅ **Good:**
```javascript
throw ErrorUtils.database('Query failed', {
  query: 'SELECT * FROM users',
  parameters: [userId],
  operation: 'getUserById'
});
```

### 3. Handle Errors at Appropriate Levels

- **Catch and re-throw** with additional context
- **Log at service boundaries** 
- **Transform for user consumption** at API level

### 4. Use Recovery Strategies

```javascript
// Good: Graceful degradation
const result = await errorHandler.executeWithHandling(
  () => primaryService.getData(),
  {
    strategy: RecoveryStrategy.FALLBACK,
    fallback: () => cachedData.getLastKnown()
  }
);
```

### 5. Don't Swallow Errors Silently

❌ **Bad:**
```javascript
try {
  await riskyOperation();
} catch (error) {
  // Silent failure - don't do this!
}
```

✅ **Good:**
```javascript
try {
  await riskyOperation();
} catch (error) {
  logger.warn('Risk operation failed, using fallback', error);
  return fallbackValue();
}
```

## Monitoring and Metrics

The error handler automatically tracks:

- Total errors by category and severity
- Circuit breaker states
- Recovery attempt success rates
- Response times for error handling

Access metrics via:

```javascript
const errorHandler = getErrorHandler();
const stats = errorHandler.getStats();
console.log('Error metrics:', stats);
```

## Testing Error Conditions

```javascript
import { OtedamaError, ErrorCategory } from '../core/standardized-error-handler.js';

// Test error handling
describe('Error Handling', () => {
  it('should handle validation errors correctly', async () => {
    const error = ErrorUtils.validation('Test error');
    
    expect(error).toBeInstanceOf(OtedamaError);
    expect(error.category).toBe(ErrorCategory.VALIDATION);
    expect(error.toHttpResponse().statusCode).toBe(400);
  });
});
```

## Migration Guide

### From Generic Errors

**Before:**
```javascript
throw new Error('User not found');
```

**After:**
```javascript
throw ErrorUtils.validation('User not found', { userId });
```

### From Custom Error Classes

**Before:**
```javascript
class CustomError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CustomError';
  }
}
```

**After:**
```javascript
// Use OtedamaError with appropriate category
throw new OtedamaError(message, {
  category: ErrorCategory.BUSINESS_LOGIC,
  details: contextData
});
```

## Common Patterns

### 1. Validation Chain

```javascript
function validateUserInput(input) {
  if (!input.email) {
    throw ErrorUtils.validation('Email is required');
  }
  
  if (!EMAIL_REGEX.test(input.email)) {
    throw ErrorUtils.validation('Invalid email format', { email: input.email });
  }
  
  if (!input.password || input.password.length < 8) {
    throw ErrorUtils.validation('Password must be at least 8 characters');
  }
}
```

### 2. Database Transaction Error Handling

```javascript
async function transferFunds(fromId, toId, amount) {
  const transaction = db.transaction(() => {
    try {
      const from = getAccount(fromId);
      const to = getAccount(toId);
      
      if (from.balance < amount) {
        throw ErrorUtils.validation('Insufficient funds', {
          required: amount,
          available: from.balance
        });
      }
      
      updateBalance(fromId, from.balance - amount);
      updateBalance(toId, to.balance + amount);
      
    } catch (error) {
      // Transaction will rollback automatically
      throw error;
    }
  });
  
  try {
    return transaction();
  } catch (error) {
    if (error.code === 'SQLITE_BUSY') {
      throw ErrorUtils.database('Database busy, please retry', {
        operation: 'transferFunds',
        retryable: true
      });
    }
    throw error;
  }
}
```

This standardized approach ensures consistent error handling across the entire Otedama platform, improving maintainability, debugging, and user experience.