# Connection Pool Refactoring Guide

## Overview

This guide demonstrates how to refactor connection pool implementations to extend from the `BasePool` class, reducing code duplication and leveraging inherited functionality for retry logic, metrics collection, and resource management.

## Key Benefits of Using BasePool

1. **Inherited Retry Logic**: Automatic retry with exponential backoff via `executeWithRetry()`
2. **Built-in Metrics**: Standardized metrics collection and reporting
3. **Resource Management**: Automatic resource creation, validation, eviction, and cleanup
4. **Health Checks**: Built-in health check infrastructure
5. **Graceful Shutdown**: Proper draining and cleanup on shutdown
6. **Timer Management**: Centralized timer management for background tasks

## Refactoring Steps

### 1. Change the Base Class

Replace `EventEmitter` with `BasePool`:

```javascript
// Before
const EventEmitter = require('events');
class WebSocketConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    // ...
  }
}

// After
const BasePool = require('../common/base-pool');
class WebSocketConnectionPool extends BasePool {
  constructor(options = {}) {
    super('WebSocketConnectionPool', {
      // Map your options to BasePool configuration
      minSize: options.minConnections || 2,
      maxSize: options.maxConnections || 100,
      acquireTimeout: options.connectionTimeout || 10000,
      // ... other mappings
    });
    // Pool-specific state only
  }
}
```

### 2. Implement Required Methods

BasePool requires these methods to be implemented:

```javascript
// Create a resource
async onCreateResource() {
  // Return the actual resource (socket, connection, etc.)
}

// Destroy a resource
async onDestroyResource(resource) {
  // Clean up the resource
}

// Validate a resource
async onValidateResource(resource) {
  // Return true if resource is healthy, false otherwise
}
```

### 3. Remove Duplicate Code

Remove code that BasePool already handles:

- ❌ Remove manual retry logic - use `executeWithRetry()`
- ❌ Remove basic metrics tracking - use inherited metrics
- ❌ Remove timer management - use `startTimer()` and `stopTimer()`
- ❌ Remove basic initialization logic - override `onInitialize()`
- ❌ Remove shutdown logic - override `onShutdown()`

### 4. Use BasePool Features

Leverage BasePool's built-in features:

```javascript
// Use retry logic
await this.executeWithRetry(
  async () => await this.connectToServer(),
  'connect'
);

// Use timer management
this.startTimer('heartbeat', () => this.sendHeartbeats(), 30000);

// Use metrics
this.recordSuccess(); // For successful operations
this.recordFailure(error); // For failed operations

// Access pool statistics
const stats = await this.getPoolStats();
```

## Example: WebSocketConnectionPool Refactoring

### Key Changes Made:

1. **Extends BasePool**: Changed from `EventEmitter` to `BasePool`
2. **Simplified Constructor**: Removed duplicate state management
3. **Resource Management**: 
   - `onCreateResource()` returns the WebSocket instance
   - `onDestroyResource()` cleans up the WebSocket
   - `onValidateResource()` checks WebSocket health
4. **Used Inherited Features**:
   - Timer management for heartbeats
   - Retry logic for reconnections
   - Built-in metrics collection
5. **Kept Pool-Specific Logic**:
   - WebSocket message handling
   - Response callbacks
   - Custom load balancing strategies

## Refactoring Other Pool Types

### Database Connection Pool
- Map database connections to resources
- Use BasePool's acquire/release for connection management
- Leverage health checks for connection validation

### Redis Connection Pool
- Treat Redis clients as resources
- Use validation to check Redis connection health
- Leverage retry logic for connection failures

### HTTP Connection Pool
- HTTP agents or sockets as resources
- Built-in timeout handling
- Automatic reconnection with retry logic

## Migration Checklist

- [ ] Change base class from EventEmitter to BasePool
- [ ] Map existing options to BasePool configuration
- [ ] Implement `onCreateResource()`, `onDestroyResource()`, `onValidateResource()`
- [ ] Remove duplicate retry logic
- [ ] Remove basic metrics code
- [ ] Replace custom timers with `startTimer()`
- [ ] Override `onInitialize()` for pool-specific setup
- [ ] Override `onShutdown()` for cleanup
- [ ] Update `getStats()` to include pool-specific metrics
- [ ] Test acquire/release behavior
- [ ] Verify health checks work correctly
- [ ] Test graceful shutdown

## Best Practices

1. **Keep It Simple**: Let BasePool handle common pool operations
2. **Focus on Specifics**: Only implement pool-specific logic
3. **Use Composition**: Store additional data in Maps/WeakMaps keyed by resource
4. **Leverage Events**: BasePool extends EventEmitter, so events still work
5. **Test Thoroughly**: Ensure resources are properly created, validated, and destroyed