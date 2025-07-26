/**
 * Pool Stability Enhancements for Otedama
 * Adds robust error handling and recovery mechanisms
 * 
 * Design: Fault-tolerant operations (Carmack/Pike principles)
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('PoolStability');

/**
 * Circuit Breaker for pool operations
 */
export class PoolCircuitBreaker {
  constructor(options = {}) {
    this.threshold = options.threshold || 5;          // Failures before opening
    this.timeout = options.timeout || 60000;          // 60 seconds
    this.resetTimeout = options.resetTimeout || 120000; // 2 minutes
    
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
  }
  
  async execute(operation, fallback) {
    // Check if circuit should be reset
    if (this.state === 'OPEN' && Date.now() - this.lastFailureTime > this.resetTimeout) {
      this.state = 'HALF_OPEN';
      this.failures = 0;
      logger.info('Circuit breaker entering HALF_OPEN state');
    }
    
    // If circuit is open, use fallback
    if (this.state === 'OPEN') {
      logger.warn('Circuit breaker is OPEN, using fallback');
      return fallback ? await fallback() : null;
    }
    
    try {
      const result = await operation();
      
      // Success in HALF_OPEN state closes the circuit
      if (this.state === 'HALF_OPEN') {
        this.successCount++;
        if (this.successCount >= 3) {
          this.state = 'CLOSED';
          this.failures = 0;
          this.successCount = 0;
          logger.info('Circuit breaker CLOSED after successful recovery');
        }
      }
      
      return result;
      
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();
      
      if (this.failures >= this.threshold) {
        this.state = 'OPEN';
        logger.error(`Circuit breaker OPEN after ${this.failures} failures`);
      }
      
      if (this.state === 'HALF_OPEN') {
        this.state = 'OPEN';
        this.successCount = 0;
        logger.warn('Circuit breaker reopened after failure in HALF_OPEN state');
      }
      
      throw error;
    }
  }
  
  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime
    };
  }
}

/**
 * Connection pool with health monitoring
 */
export class StableConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxConnections = options.maxConnections || 1000;
    this.healthCheckInterval = options.healthCheckInterval || 30000;
    this.connectionTimeout = options.connectionTimeout || 5000;
    
    this.connections = new Map();
    this.healthyConnections = new Set();
    this.unhealthyConnections = new Set();
    
    this.circuitBreaker = new PoolCircuitBreaker();
    this.healthCheckTimer = null;
  }
  
  start() {
    // Start health monitoring
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckInterval);
    
    logger.info('Connection pool health monitoring started');
  }
  
  async addConnection(id, connection) {
    if (this.connections.size >= this.maxConnections) {
      throw new Error('Connection pool at capacity');
    }
    
    // Test connection health before adding
    const isHealthy = await this.testConnection(connection);
    
    this.connections.set(id, {
      connection,
      lastActivity: Date.now(),
      errorCount: 0,
      healthy: isHealthy
    });
    
    if (isHealthy) {
      this.healthyConnections.add(id);
    } else {
      this.unhealthyConnections.add(id);
    }
    
    this.emit('connection:added', { id, healthy: isHealthy });
  }
  
  async getHealthyConnection() {
    return await this.circuitBreaker.execute(
      async () => {
        if (this.healthyConnections.size === 0) {
          throw new Error('No healthy connections available');
        }
        
        // Get least recently used healthy connection
        let oldestId = null;
        let oldestTime = Infinity;
        
        for (const id of this.healthyConnections) {
          const conn = this.connections.get(id);
          if (conn && conn.lastActivity < oldestTime) {
            oldestTime = conn.lastActivity;
            oldestId = id;
          }
        }
        
        if (oldestId) {
          const conn = this.connections.get(oldestId);
          conn.lastActivity = Date.now();
          return conn.connection;
        }
        
        throw new Error('Failed to find healthy connection');
      },
      async () => {
        // Fallback: try to recover unhealthy connections
        await this.recoverUnhealthyConnections();
        return null;
      }
    );
  }
  
  async performHealthCheck() {
    const checkPromises = [];
    
    for (const [id, connData] of this.connections) {
      checkPromises.push(
        this.testConnection(connData.connection)
          .then(healthy => ({ id, healthy }))
          .catch(() => ({ id, healthy: false }))
      );
    }
    
    const results = await Promise.all(checkPromises);
    
    for (const { id, healthy } of results) {
      const connData = this.connections.get(id);
      if (!connData) continue;
      
      const wasHealthy = connData.healthy;
      connData.healthy = healthy;
      
      if (healthy && !wasHealthy) {
        // Connection recovered
        this.unhealthyConnections.delete(id);
        this.healthyConnections.add(id);
        connData.errorCount = 0;
        logger.info(`Connection ${id} recovered`);
        this.emit('connection:recovered', id);
        
      } else if (!healthy && wasHealthy) {
        // Connection failed
        this.healthyConnections.delete(id);
        this.unhealthyConnections.add(id);
        connData.errorCount++;
        logger.warn(`Connection ${id} failed health check`);
        this.emit('connection:unhealthy', id);
      }
      
      // Remove connections with too many errors
      if (connData.errorCount > 10) {
        this.removeConnection(id);
      }
    }
    
    this.emit('health:check', {
      total: this.connections.size,
      healthy: this.healthyConnections.size,
      unhealthy: this.unhealthyConnections.size
    });
  }
  
  async testConnection(connection) {
    try {
      // Implement connection-specific health check
      if (connection.ping) {
        await connection.ping();
      } else if (connection.isAlive) {
        return connection.isAlive();
      }
      return true;
    } catch (error) {
      return false;
    }
  }
  
  removeConnection(id) {
    const connData = this.connections.get(id);
    if (!connData) return;
    
    this.connections.delete(id);
    this.healthyConnections.delete(id);
    this.unhealthyConnections.delete(id);
    
    if (connData.connection.close) {
      connData.connection.close();
    }
    
    this.emit('connection:removed', id);
  }
  
  async recoverUnhealthyConnections() {
    const recoveryPromises = [];
    
    for (const id of this.unhealthyConnections) {
      const connData = this.connections.get(id);
      if (!connData) continue;
      
      recoveryPromises.push(
        this.attemptRecovery(id, connData)
      );
    }
    
    await Promise.allSettled(recoveryPromises);
  }
  
  async attemptRecovery(id, connData) {
    try {
      // Try to reconnect or reset connection
      if (connData.connection.reconnect) {
        await connData.connection.reconnect();
      }
      
      const isHealthy = await this.testConnection(connData.connection);
      if (isHealthy) {
        connData.healthy = true;
        connData.errorCount = 0;
        this.unhealthyConnections.delete(id);
        this.healthyConnections.add(id);
        logger.info(`Connection ${id} recovered through manual recovery`);
      }
    } catch (error) {
      logger.error(`Failed to recover connection ${id}:`, error);
    }
  }
  
  getStats() {
    return {
      total: this.connections.size,
      healthy: this.healthyConnections.size,
      unhealthy: this.unhealthyConnections.size,
      circuitBreaker: this.circuitBreaker.getState()
    };
  }
  
  stop() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    // Close all connections
    for (const [id] of this.connections) {
      this.removeConnection(id);
    }
    
    logger.info('Connection pool stopped');
  }
}

/**
 * Share validation with retry and fallback
 */
export class ResilientShareValidator {
  constructor(validator, options = {}) {
    this.validator = validator;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 100;
    this.fallbackValidator = options.fallbackValidator;
    
    this.validationErrors = new Map(); // Track error patterns
  }
  
  async validateShare(share, job, minerDifficulty, networkDifficulty) {
    let lastError;
    
    // Try validation with retries
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await this.validator.validateShare(
          share, job, minerDifficulty, networkDifficulty
        );
        
        // Clear error count on success
        this.validationErrors.delete(share.minerId);
        
        return result;
        
      } catch (error) {
        lastError = error;
        logger.warn(`Share validation attempt ${attempt + 1} failed:`, error.message);
        
        // Track errors per miner
        const errorCount = (this.validationErrors.get(share.minerId) || 0) + 1;
        this.validationErrors.set(share.minerId, errorCount);
        
        // Don't retry for certain errors
        if (error.message.includes('Invalid nonce') || 
            error.message.includes('Duplicate share')) {
          throw error;
        }
        
        // Wait before retry
        if (attempt < this.maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        }
      }
    }
    
    // Use fallback validator if available
    if (this.fallbackValidator) {
      logger.warn('Using fallback validator');
      try {
        return await this.fallbackValidator.validateShare(
          share, job, minerDifficulty, networkDifficulty
        );
      } catch (fallbackError) {
        logger.error('Fallback validator also failed:', fallbackError);
      }
    }
    
    throw lastError;
  }
  
  getMinerErrorRate(minerId) {
    return this.validationErrors.get(minerId) || 0;
  }
  
  clearMinerErrors(minerId) {
    this.validationErrors.delete(minerId);
  }
}

/**
 * Export stability enhancements
 */
export const PoolStability = {
  CircuitBreaker: PoolCircuitBreaker,
  ConnectionPool: StableConnectionPool,
  ShareValidator: ResilientShareValidator
};

export default PoolStability;