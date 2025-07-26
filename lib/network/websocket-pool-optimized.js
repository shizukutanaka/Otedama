/**
 * Optimized WebSocket Connection Pool
 * High-performance WebSocket management for mining operations
 * 
 * Design: Zero-copy message passing (Carmack principle)
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { createStructuredLogger } from '../core/structured-logger.js';

const logger = createStructuredLogger('WebSocketPool');

/**
 * WebSocket state
 */
const WS_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
};

/**
 * Optimized WebSocket Pool
 */
export class OptimizedWebSocketPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxConnections: options.maxConnections || 10000,
      maxConnectionsPerIP: options.maxConnectionsPerIP || 10,
      connectionTimeout: options.connectionTimeout || 30000,
      pingInterval: options.pingInterval || 30000,
      reconnectDelay: options.reconnectDelay || 5000,
      messageQueueSize: options.messageQueueSize || 1000,
      binaryType: options.binaryType || 'nodebuffer',
      perMessageDeflate: options.perMessageDeflate || false, // Disable for performance
      ...options
    };
    
    // Connection storage
    this.connections = new Map();
    this.connectionsByIP = new Map();
    
    // Message queue for buffering
    this.messageQueue = new Map();
    
    // Statistics
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0
    };
    
    // Ping timer
    this.pingTimer = null;
  }
  
  /**
   * Start the pool
   */
  start() {
    // Start ping timer
    this.pingTimer = setInterval(() => {
      this.pingAll();
    }, this.options.pingInterval);
    
    logger.info('WebSocket pool started');
  }
  
  /**
   * Add connection to pool
   */
  addConnection(ws, clientInfo = {}) {
    const connectionId = this.generateConnectionId();
    const { ip = 'unknown', minerName = 'anonymous' } = clientInfo;
    
    // Check per-IP limit
    const ipConnections = this.connectionsByIP.get(ip) || [];
    if (ipConnections.length >= this.options.maxConnectionsPerIP) {
      ws.close(1008, 'Too many connections from IP');
      return null;
    }
    
    // Check total limit
    if (this.connections.size >= this.options.maxConnections) {
      ws.close(1008, 'Server at capacity');
      return null;
    }
    
    // Create connection object
    const connection = {
      id: connectionId,
      ws,
      ip,
      minerName,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      lastPing: Date.now(),
      authenticated: false,
      subscriptions: new Set(),
      messageCount: 0,
      bytesSent: 0,
      bytesReceived: 0
    };
    
    // Store connection
    this.connections.set(connectionId, connection);
    ipConnections.push(connectionId);
    this.connectionsByIP.set(ip, ipConnections);
    
    // Set up event handlers
    this.setupConnectionHandlers(connection);
    
    // Update stats
    this.stats.totalConnections++;
    this.stats.activeConnections++;
    
    // Initialize message queue
    this.messageQueue.set(connectionId, []);
    
    logger.info(`New connection: ${connectionId} from ${ip}`);
    this.emit('connection', connection);
    
    return connectionId;
  }
  
  /**
   * Set up WebSocket event handlers
   */
  setupConnectionHandlers(connection) {
    const { ws, id } = connection;
    
    // Message handler
    ws.on('message', (data, isBinary) => {
      connection.lastActivity = Date.now();
      connection.messageCount++;
      connection.bytesReceived += data.length;
      
      this.stats.messagesReceived++;
      this.stats.bytesReceived += data.length;
      
      // Fast path for binary messages
      if (isBinary) {
        this.emit('binary-message', id, data);
      } else {
        try {
          const message = JSON.parse(data);
          this.emit('message', id, message);
        } catch (error) {
          logger.warn(`Invalid JSON from ${id}: ${error.message}`);
          this.sendError(id, 'Invalid message format');
        }
      }
    });
    
    // Close handler
    ws.on('close', (code, reason) => {
      logger.info(`Connection closed: ${id} (${code}: ${reason})`);
      this.removeConnection(id);
      this.emit('close', id, code, reason);
    });
    
    // Error handler
    ws.on('error', (error) => {
      logger.error(`WebSocket error for ${id}:`, error);
      this.emit('error', id, error);
    });
    
    // Pong handler
    ws.on('pong', () => {
      connection.lastPing = Date.now();
    });
  }
  
  /**
   * Send message to connection (optimized)
   */
  send(connectionId, message) {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;
    
    const { ws } = connection;
    if (ws.readyState !== WS_STATE.OPEN) {
      // Queue message if not ready
      const queue = this.messageQueue.get(connectionId);
      if (queue && queue.length < this.options.messageQueueSize) {
        queue.push(message);
      }
      return false;
    }
    
    try {
      // Optimize for different message types
      let data;
      if (Buffer.isBuffer(message)) {
        data = message;
      } else if (typeof message === 'string') {
        data = message;
      } else {
        data = JSON.stringify(message);
      }
      
      ws.send(data, (error) => {
        if (error) {
          logger.error(`Send error for ${connectionId}:`, error);
          this.emit('send-error', connectionId, error);
        }
      });
      
      connection.bytesSent += data.length;
      this.stats.messagesSent++;
      this.stats.bytesSent += data.length;
      
      return true;
      
    } catch (error) {
      logger.error(`Failed to send to ${connectionId}:`, error);
      return false;
    }
  }
  
  /**
   * Broadcast to all connections (optimized)
   */
  broadcast(message, filter = null) {
    // Pre-serialize message once
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    let sent = 0;
    
    for (const [id, connection] of this.connections) {
      if (filter && !filter(connection)) continue;
      
      if (connection.ws.readyState === WS_STATE.OPEN) {
        connection.ws.send(data);
        sent++;
      }
    }
    
    return sent;
  }
  
  /**
   * Send to subscribed connections
   */
  publish(channel, message) {
    const data = JSON.stringify({ channel, data: message });
    let sent = 0;
    
    for (const [id, connection] of this.connections) {
      if (connection.subscriptions.has(channel) && 
          connection.ws.readyState === WS_STATE.OPEN) {
        connection.ws.send(data);
        sent++;
      }
    }
    
    return sent;
  }
  
  /**
   * Subscribe connection to channel
   */
  subscribe(connectionId, channel) {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;
    
    connection.subscriptions.add(channel);
    return true;
  }
  
  /**
   * Unsubscribe from channel
   */
  unsubscribe(connectionId, channel) {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;
    
    connection.subscriptions.delete(channel);
    return true;
  }
  
  /**
   * Send error message
   */
  sendError(connectionId, error, code = null) {
    this.send(connectionId, {
      id: null,
      error: {
        message: error,
        code
      }
    });
  }
  
  /**
   * Ping all connections
   */
  pingAll() {
    const now = Date.now();
    const timeout = this.options.connectionTimeout;
    
    for (const [id, connection] of this.connections) {
      const { ws, lastPing } = connection;
      
      // Check for timeout
      if (now - lastPing > timeout) {
        logger.warn(`Connection ${id} timed out`);
        ws.terminate();
        continue;
      }
      
      // Send ping
      if (ws.readyState === WS_STATE.OPEN) {
        ws.ping();
      }
    }
  }
  
  /**
   * Remove connection from pool
   */
  removeConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    
    // Remove from maps
    this.connections.delete(connectionId);
    this.messageQueue.delete(connectionId);
    
    // Remove from IP map
    const ipConnections = this.connectionsByIP.get(connection.ip) || [];
    const index = ipConnections.indexOf(connectionId);
    if (index > -1) {
      ipConnections.splice(index, 1);
      if (ipConnections.length === 0) {
        this.connectionsByIP.delete(connection.ip);
      } else {
        this.connectionsByIP.set(connection.ip, ipConnections);
      }
    }
    
    // Update stats
    this.stats.activeConnections--;
    
    // Close WebSocket if still open
    if (connection.ws.readyState !== WS_STATE.CLOSED) {
      connection.ws.close();
    }
  }
  
  /**
   * Flush queued messages
   */
  flushMessageQueue(connectionId) {
    const connection = this.connections.get(connectionId);
    const queue = this.messageQueue.get(connectionId);
    
    if (!connection || !queue || queue.length === 0) return;
    
    const { ws } = connection;
    if (ws.readyState !== WS_STATE.OPEN) return;
    
    // Send all queued messages
    while (queue.length > 0) {
      const message = queue.shift();
      this.send(connectionId, message);
    }
  }
  
  /**
   * Get connection by ID
   */
  getConnection(connectionId) {
    return this.connections.get(connectionId);
  }
  
  /**
   * Get all connections for an IP
   */
  getConnectionsByIP(ip) {
    const ids = this.connectionsByIP.get(ip) || [];
    return ids.map(id => this.connections.get(id)).filter(Boolean);
  }
  
  /**
   * Get pool statistics
   */
  getStats() {
    return {
      ...this.stats,
      connectionsByIP: this.connectionsByIP.size,
      avgMessagesPerConnection: this.stats.totalConnections > 0 ? 
        this.stats.messagesReceived / this.stats.totalConnections : 0,
      avgBytesPerMessage: this.stats.messagesReceived > 0 ?
        this.stats.bytesReceived / this.stats.messagesReceived : 0
    };
  }
  
  /**
   * Generate unique connection ID
   */
  generateConnectionId() {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Shutdown pool
   */
  shutdown() {
    // Stop ping timer
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    
    // Close all connections
    for (const [id, connection] of this.connections) {
      connection.ws.close(1001, 'Server shutting down');
    }
    
    // Clear maps
    this.connections.clear();
    this.connectionsByIP.clear();
    this.messageQueue.clear();
    
    logger.info('WebSocket pool shut down');
  }
}

export default OptimizedWebSocketPool;