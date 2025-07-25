/**
 * Connection Pool - Otedama
 * Efficient connection pooling and reuse
 */

import { EventEmitter } from 'events';
import { createLogger } from '../core/logger.js';

const logger = createLogger('ConnectionPool');

export class ConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      maxConnections: options.maxConnections || 10000,
      maxIdleTime: options.maxIdleTime || 300000, // 5 minutes
      cleanupInterval: options.cleanupInterval || 60000 // 1 minute
    };
    
    this.connections = new Map();
    this.idleConnections = new Set();
    this.activeConnections = new Set();
    this.isRunning = false;
  }
  
  async start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
    
    logger.info('Connection pool started');
  }
  
  async stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    // Close all connections
    for (const conn of this.connections.values()) {
      await this.destroyConnection(conn);
    }
    
    this.connections.clear();
    this.idleConnections.clear();
    this.activeConnections.clear();
    
    logger.info('Connection pool stopped');
  }
  
  async acquire(key, factory) {
    // Check if we have an idle connection
    const existing = this.connections.get(key);
    if (existing && this.idleConnections.has(key)) {
      this.idleConnections.delete(key);
      this.activeConnections.add(key);
      existing.lastUsed = Date.now();
      
      logger.debug(`Reusing connection for ${key}`);
      return existing.connection;
    }
    
    // Check connection limit
    if (this.connections.size >= this.config.maxConnections) {
      // Try to evict idle connections
      this.evictIdleConnections(1);
      
      if (this.connections.size >= this.config.maxConnections) {
        throw new Error('Connection pool limit reached');
      }
    }
    
    // Create new connection
    logger.debug(`Creating new connection for ${key}`);
    
    try {
      const connection = await factory();
      
      const connInfo = {
        key,
        connection,
        created: Date.now(),
        lastUsed: Date.now(),
        useCount: 1
      };
      
      this.connections.set(key, connInfo);
      this.activeConnections.add(key);
      
      this.emit('connection:created', { key });
      
      return connection;
      
    } catch (error) {
      logger.error(`Failed to create connection for ${key}:`, error);
      throw error;
    }
  }
  
  release(key) {
    const connInfo = this.connections.get(key);
    if (!connInfo) return;
    
    if (this.activeConnections.has(key)) {
      this.activeConnections.delete(key);
      this.idleConnections.add(key);
      connInfo.lastUsed = Date.now();
      
      logger.debug(`Released connection for ${key}`);
      this.emit('connection:released', { key });
    }
  }
  
  async destroy(key) {
    const connInfo = this.connections.get(key);
    if (!connInfo) return;
    
    await this.destroyConnection(connInfo);
    
    this.connections.delete(key);
    this.idleConnections.delete(key);
    this.activeConnections.delete(key);
    
    logger.debug(`Destroyed connection for ${key}`);
    this.emit('connection:destroyed', { key });
  }
  
  async destroyConnection(connInfo) {
    try {
      if (connInfo.connection && typeof connInfo.connection.close === 'function') {
        await connInfo.connection.close();
      } else if (connInfo.connection && typeof connInfo.connection.destroy === 'function') {
        connInfo.connection.destroy();
      } else if (connInfo.connection && typeof connInfo.connection.end === 'function') {
        connInfo.connection.end();
      }
    } catch (error) {
      logger.error(`Error destroying connection:`, error);
    }
  }
  
  cleanup() {
    const now = Date.now();
    const maxIdleTime = this.config.maxIdleTime;
    
    for (const [key, connInfo] of this.connections) {
      if (this.idleConnections.has(key) && 
          now - connInfo.lastUsed > maxIdleTime) {
        this.destroy(key);
      }
    }
  }
  
  evictIdleConnections(count) {
    const idleArray = Array.from(this.idleConnections);
    
    // Sort by last used time (oldest first)
    idleArray.sort((a, b) => {
      const connA = this.connections.get(a);
      const connB = this.connections.get(b);
      return connA.lastUsed - connB.lastUsed;
    });
    
    // Evict oldest connections
    for (let i = 0; i < Math.min(count, idleArray.length); i++) {
      this.destroy(idleArray[i]);
    }
  }
  
  getStats() {
    return {
      total: this.connections.size,
      active: this.activeConnections.size,
      idle: this.idleConnections.size,
      limit: this.config.maxConnections,
      utilization: this.connections.size / this.config.maxConnections
    };
  }
  
  getConnectionInfo() {
    const connections = [];
    
    for (const [key, connInfo] of this.connections) {
      connections.push({
        key,
        created: connInfo.created,
        lastUsed: connInfo.lastUsed,
        useCount: connInfo.useCount,
        isActive: this.activeConnections.has(key),
        idleTime: Date.now() - connInfo.lastUsed
      });
    }
    
    return connections;
  }
}

export default ConnectionPool;
