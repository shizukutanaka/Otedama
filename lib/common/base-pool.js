/**
 * Base Connection Pool for Otedama
 * Common interface for all connection pools
 * 
 * Design principles:
 * - Carmack: Minimal overhead, performance-first
 * - Martin: Clean abstraction for different pool types
 * - Pike: Simple, composable interface
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';

/**
 * Base connection pool class
 * All connection pools should extend this class
 */
export class BasePool extends EventEmitter {
  constructor(name, options = {}) {
    super();
    
    this.name = name;
    this.logger = createStructuredLogger(`Pool:${name}`);
    
    // Common configuration
    this.config = {
      min: options.min || 1,
      max: options.max || 10,
      acquireTimeout: options.acquireTimeout || 30000,
      idleTimeout: options.idleTimeout || 60000,
      validateOnBorrow: options.validateOnBorrow !== false,
      ...options
    };
    
    // Common state
    this.isRunning = false;
    this.connections = new Map();
    this.stats = {
      created: 0,
      destroyed: 0,
      acquired: 0,
      released: 0,
      timeouts: 0,
      errors: 0
    };
  }
  
  /**
   * Start the pool
   */
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.logger.info('Connection pool starting', { config: this.config });
    
    // Create minimum connections
    const promises = [];
    for (let i = 0; i < this.config.min; i++) {
      promises.push(this._createConnection());
    }
    
    await Promise.all(promises);
    this.emit('started');
  }
  
  /**
   * Stop the pool
   */
  async stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    this.logger.info('Connection pool stopping');
    
    // Close all connections
    const promises = [];
    for (const conn of this.connections.values()) {
      promises.push(this._destroyConnection(conn));
    }
    
    await Promise.all(promises);
    this.connections.clear();
    
    this.emit('stopped');
  }
  
  /**
   * Acquire a connection from the pool
   */
  async acquire() {
    if (!this.isRunning) {
      throw new Error('Pool is not running');
    }
    
    const timeout = setTimeout(() => {
      this.stats.timeouts++;
      throw new Error('Connection acquire timeout');
    }, this.config.acquireTimeout);
    
    try {
      const connection = await this._doAcquire();
      
      if (this.config.validateOnBorrow) {
        const isValid = await this._validateConnection(connection);
        if (!isValid) {
          await this._destroyConnection(connection);
          return this.acquire(); // Retry with new connection
        }
      }
      
      this.stats.acquired++;
      clearTimeout(timeout);
      return connection;
      
    } catch (error) {
      clearTimeout(timeout);
      this.stats.errors++;
      throw error;
    }
  }
  
  /**
   * Release a connection back to the pool
   */
  async release(connection) {
    if (!connection) return;
    
    try {
      await this._doRelease(connection);
      this.stats.released++;
    } catch (error) {
      this.logger.error('Error releasing connection', { error: error.message });
      await this._destroyConnection(connection);
    }
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      name: this.name,
      size: this.connections.size,
      available: this._getAvailableCount(),
      inUse: this._getInUseCount(),
      ...this.stats
    };
  }
  
  // Abstract methods to be implemented by subclasses
  
  /**
   * Create a new connection
   * @abstract
   */
  async _createConnection() {
    throw new Error('_createConnection must be implemented by subclass');
  }
  
  /**
   * Destroy a connection
   * @abstract
   */
  async _destroyConnection(connection) {
    throw new Error('_destroyConnection must be implemented by subclass');
  }
  
  /**
   * Validate a connection
   * @abstract
   */
  async _validateConnection(connection) {
    throw new Error('_validateConnection must be implemented by subclass');
  }
  
  /**
   * Acquire implementation
   * @abstract
   */
  async _doAcquire() {
    throw new Error('_doAcquire must be implemented by subclass');
  }
  
  /**
   * Release implementation
   * @abstract
   */
  async _doRelease(connection) {
    throw new Error('_doRelease must be implemented by subclass');
  }
  
  /**
   * Get available connection count
   * @abstract
   */
  _getAvailableCount() {
    return 0;
  }
  
  /**
   * Get in-use connection count
   * @abstract
   */
  _getInUseCount() {
    return this.connections.size - this._getAvailableCount();
  }
}

export default BasePool;