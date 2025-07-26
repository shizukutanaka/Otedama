/**
 * Connection Manager - Otedama
 * Manages connection lifecycle and prevents memory leaks
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from './structured-logger.js';

const logger = createStructuredLogger('ConnectionManager');

export class ConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxConnections: options.maxConnections || 1000000,
      connectionTimeout: options.connectionTimeout || 600000, // 10 minutes
      cleanupInterval: options.cleanupInterval || 60000, // 1 minute
      maxConnectionsPerIP: options.maxConnectionsPerIP || 100,
      ...options
    };
    
    // Connection tracking
    this.connections = new Map();
    this.connectionsByIP = new Map();
    this.connectionCount = 0;
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanup(), this.options.cleanupInterval);
    
    // Statistics
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      rejectedConnections: 0,
      timedOutConnections: 0,
      peakConnections: 0
    };
  }
  
  /**
   * Add a new connection
   */
  addConnection(id, connection, remoteAddress) {
    // Check connection limit
    if (this.connections.size >= this.options.maxConnections) {
      this.stats.rejectedConnections++;
      logger.warn('Connection limit reached', {
        limit: this.options.maxConnections,
        current: this.connections.size
      });
      return false;
    }
    
    // Check per-IP limit
    const ipConnections = this.connectionsByIP.get(remoteAddress) || new Set();
    if (ipConnections.size >= this.options.maxConnectionsPerIP) {
      this.stats.rejectedConnections++;
      logger.warn('Per-IP connection limit reached', {
        ip: remoteAddress,
        limit: this.options.maxConnectionsPerIP
      });
      return false;
    }
    
    // Add connection
    const connectionInfo = {
      id,
      connection,
      remoteAddress,
      connectedAt: Date.now(),
      lastActivity: Date.now()
    };
    
    this.connections.set(id, connectionInfo);
    ipConnections.add(id);
    this.connectionsByIP.set(remoteAddress, ipConnections);
    
    // Update stats
    this.connectionCount++;
    this.stats.totalConnections++;
    this.stats.activeConnections = this.connections.size;
    
    if (this.connections.size > this.stats.peakConnections) {
      this.stats.peakConnections = this.connections.size;
    }
    
    // Set timeout
    this.resetTimeout(id);
    
    this.emit('connection:added', { id, remoteAddress });
    
    return true;
  }
  
  /**
   * Remove a connection
   */
  removeConnection(id) {
    const connectionInfo = this.connections.get(id);
    if (!connectionInfo) {
      return false;
    }
    
    // Remove from maps
    this.connections.delete(id);
    
    const ipConnections = this.connectionsByIP.get(connectionInfo.remoteAddress);
    if (ipConnections) {
      ipConnections.delete(id);
      if (ipConnections.size === 0) {
        this.connectionsByIP.delete(connectionInfo.remoteAddress);
      }
    }
    
    // Clear timeout
    if (connectionInfo.timeoutId) {
      clearTimeout(connectionInfo.timeoutId);
    }
    
    // Update stats
    this.stats.activeConnections = this.connections.size;
    
    this.emit('connection:removed', { 
      id, 
      remoteAddress: connectionInfo.remoteAddress,
      duration: Date.now() - connectionInfo.connectedAt 
    });
    
    return true;
  }
  
  /**
   * Update connection activity
   */
  updateActivity(id) {
    const connectionInfo = this.connections.get(id);
    if (connectionInfo) {
      connectionInfo.lastActivity = Date.now();
      this.resetTimeout(id);
    }
  }
  
  /**
   * Reset connection timeout
   */
  resetTimeout(id) {
    const connectionInfo = this.connections.get(id);
    if (!connectionInfo) return;
    
    // Clear existing timeout
    if (connectionInfo.timeoutId) {
      clearTimeout(connectionInfo.timeoutId);
    }
    
    // Set new timeout
    connectionInfo.timeoutId = setTimeout(() => {
      this.handleTimeout(id);
    }, this.options.connectionTimeout);
  }
  
  /**
   * Handle connection timeout
   */
  handleTimeout(id) {
    const connectionInfo = this.connections.get(id);
    if (!connectionInfo) return;
    
    logger.debug('Connection timeout', {
      id,
      remoteAddress: connectionInfo.remoteAddress,
      lastActivity: Date.now() - connectionInfo.lastActivity
    });
    
    this.stats.timedOutConnections++;
    
    // Close the connection
    if (connectionInfo.connection && connectionInfo.connection.destroy) {
      connectionInfo.connection.destroy();
    }
    
    this.removeConnection(id);
    this.emit('connection:timeout', { id });
  }
  
  /**
   * Clean up stale connections
   */
  cleanup() {
    const now = Date.now();
    const staleConnections = [];
    
    for (const [id, connectionInfo] of this.connections) {
      // Check for stale connections
      if (now - connectionInfo.lastActivity > this.options.connectionTimeout) {
        staleConnections.push(id);
      }
    }
    
    // Remove stale connections
    for (const id of staleConnections) {
      logger.debug('Removing stale connection', { id });
      this.handleTimeout(id);
    }
    
    if (staleConnections.length > 0) {
      logger.info('Cleaned up stale connections', {
        count: staleConnections.length,
        remaining: this.connections.size
      });
    }
  }
  
  /**
   * Get connection by ID
   */
  getConnection(id) {
    const connectionInfo = this.connections.get(id);
    return connectionInfo ? connectionInfo.connection : null;
  }
  
  /**
   * Get all connections
   */
  getAllConnections() {
    return Array.from(this.connections.values());
  }
  
  /**
   * Get connections by IP
   */
  getConnectionsByIP(ip) {
    const connectionIds = this.connectionsByIP.get(ip);
    if (!connectionIds) return [];
    
    return Array.from(connectionIds).map(id => this.connections.get(id)).filter(Boolean);
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      connectionsByIP: Array.from(this.connectionsByIP.entries()).map(([ip, connections]) => ({
        ip,
        count: connections.size
      })).sort((a, b) => b.count - a.count).slice(0, 10) // Top 10 IPs
    };
  }
  
  /**
   * Shutdown manager
   */
  shutdown() {
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // Clear all timeouts
    for (const connectionInfo of this.connections.values()) {
      if (connectionInfo.timeoutId) {
        clearTimeout(connectionInfo.timeoutId);
      }
    }
    
    // Close all connections
    for (const connectionInfo of this.connections.values()) {
      if (connectionInfo.connection && connectionInfo.connection.destroy) {
        connectionInfo.connection.destroy();
      }
    }
    
    // Clear maps
    this.connections.clear();
    this.connectionsByIP.clear();
    
    logger.info('Connection manager shutdown', this.stats);
  }
}

export default ConnectionManager;