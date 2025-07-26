/**
 * WebSocket Server - Otedama
 * Real-time updates for dashboard and monitoring
 */

import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { ConnectionManager } from '../core/connection-manager.js';

const logger = createStructuredLogger('WebSocketServer');

export class OtedamaWebSocketServer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 8083,
      path: options.path || '/ws',
      maxPayloadSize: options.maxPayloadSize || 1048576, // 1MB
      heartbeatInterval: options.heartbeatInterval || 30000,
      compression: options.compression !== false,
      perMessageDeflate: options.perMessageDeflate !== false,
      ...options
    };
    
    // Connection management
    this.connectionManager = new ConnectionManager({
      maxConnections: options.maxConnections || 10000,
      connectionTimeout: options.connectionTimeout || 300000 // 5 minutes
    });
    
    // Subscription management
    this.subscriptions = new Map(); // topic -> Set of connection IDs
    this.connectionSubscriptions = new Map(); // connection ID -> Set of topics
    
    // Message queue for batching
    this.messageQueue = new Map();
    this.batchTimer = null;
    
    // Statistics
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      subscriptions: 0,
      broadcasts: 0,
      errors: 0
    };
  }
  
  /**
   * Start WebSocket server
   */
  async start(server) {
    return new Promise((resolve, reject) => {
      try {
        // Create WebSocket server
        this.wss = new WebSocketServer({
          server,
          port: server ? undefined : this.options.port,
          path: this.options.path,
          maxPayload: this.options.maxPayloadSize,
          perMessageDeflate: this.options.perMessageDeflate
        });
        
        // Setup event handlers
        this.wss.on('connection', this.handleConnection.bind(this));
        this.wss.on('error', (error) => {
          logger.error('WebSocket server error', { error: error.message });
          this.stats.errors++;
          this.emit('error', error);
        });
        
        // Start heartbeat
        this.startHeartbeat();
        
        // Start batch timer
        this.startBatchTimer();
        
        logger.info('WebSocket server started', {
          port: this.options.port,
          path: this.options.path
        });
        
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }
  
  /**
   * Handle new WebSocket connection
   */
  handleConnection(ws, request) {
    const connectionId = this.generateConnectionId();
    const remoteAddress = request.socket.remoteAddress;
    
    // Add to connection manager
    if (!this.connectionManager.addConnection(connectionId, ws, remoteAddress)) {
      ws.close(1008, 'Connection limit reached');
      return;
    }
    
    // Set up connection state
    ws.connectionId = connectionId;
    ws.isAlive = true;
    ws.authenticated = false;
    
    // Event handlers
    ws.on('message', (message) => this.handleMessage(ws, message));
    ws.on('pong', () => this.handlePong(ws));
    ws.on('close', () => this.handleClose(ws));
    ws.on('error', (error) => this.handleError(ws, error));
    
    // Send welcome message
    this.sendMessage(ws, {
      type: 'welcome',
      connectionId,
      timestamp: Date.now(),
      version: '1.1.2'
    });
    
    this.emit('connection', { connectionId, remoteAddress });
    
    logger.debug('WebSocket connection established', { connectionId, remoteAddress });
  }
  
  /**
   * Handle incoming message
   */
  async handleMessage(ws, message) {
    try {
      this.stats.messagesReceived++;
      this.connectionManager.updateActivity(ws.connectionId);
      
      // Parse message
      let data;
      try {
        data = JSON.parse(message.toString());
      } catch (error) {
        this.sendError(ws, 'Invalid JSON');
        return;
      }
      
      // Validate message
      if (!data.type) {
        this.sendError(ws, 'Missing message type');
        return;
      }
      
      // Handle message based on type
      switch (data.type) {
        case 'auth':
          await this.handleAuth(ws, data);
          break;
          
        case 'subscribe':
          this.handleSubscribe(ws, data);
          break;
          
        case 'unsubscribe':
          this.handleUnsubscribe(ws, data);
          break;
          
        case 'ping':
          this.sendMessage(ws, { type: 'pong', timestamp: Date.now() });
          break;
          
        default:
          this.emit('message', { connectionId: ws.connectionId, data });
      }
      
    } catch (error) {
      logger.error('Message handling error', {
        connectionId: ws.connectionId,
        error: error.message
      });
      this.sendError(ws, 'Internal error');
    }
  }
  
  /**
   * Handle authentication
   */
  async handleAuth(ws, data) {
    // Simple token-based auth for now
    // In production, integrate with your auth system
    if (data.token) {
      ws.authenticated = true;
      this.sendMessage(ws, {
        type: 'auth:success',
        connectionId: ws.connectionId
      });
      
      logger.info('WebSocket authenticated', { connectionId: ws.connectionId });
    } else {
      this.sendMessage(ws, {
        type: 'auth:failed',
        reason: 'Invalid token'
      });
    }
  }
  
  /**
   * Handle subscription
   */
  handleSubscribe(ws, data) {
    if (!data.topics || !Array.isArray(data.topics)) {
      this.sendError(ws, 'Invalid subscription topics');
      return;
    }
    
    const connectionId = ws.connectionId;
    const connectionTopics = this.connectionSubscriptions.get(connectionId) || new Set();
    
    for (const topic of data.topics) {
      // Add to topic subscribers
      const subscribers = this.subscriptions.get(topic) || new Set();
      subscribers.add(connectionId);
      this.subscriptions.set(topic, subscribers);
      
      // Add to connection topics
      connectionTopics.add(topic);
      
      this.stats.subscriptions++;
    }
    
    this.connectionSubscriptions.set(connectionId, connectionTopics);
    
    this.sendMessage(ws, {
      type: 'subscribe:success',
      topics: data.topics
    });
    
    logger.debug('WebSocket subscribed', {
      connectionId,
      topics: data.topics
    });
  }
  
  /**
   * Handle unsubscription
   */
  handleUnsubscribe(ws, data) {
    if (!data.topics || !Array.isArray(data.topics)) {
      this.sendError(ws, 'Invalid unsubscription topics');
      return;
    }
    
    const connectionId = ws.connectionId;
    const connectionTopics = this.connectionSubscriptions.get(connectionId);
    
    if (!connectionTopics) return;
    
    for (const topic of data.topics) {
      // Remove from topic subscribers
      const subscribers = this.subscriptions.get(topic);
      if (subscribers) {
        subscribers.delete(connectionId);
        if (subscribers.size === 0) {
          this.subscriptions.delete(topic);
        }
        
        this.stats.subscriptions--;
      }
      
      // Remove from connection topics
      connectionTopics.delete(topic);
    }
    
    this.sendMessage(ws, {
      type: 'unsubscribe:success',
      topics: data.topics
    });
  }
  
  /**
   * Handle pong
   */
  handlePong(ws) {
    ws.isAlive = true;
    this.connectionManager.updateActivity(ws.connectionId);
  }
  
  /**
   * Handle connection close
   */
  handleClose(ws) {
    const connectionId = ws.connectionId;
    
    // Remove subscriptions
    const connectionTopics = this.connectionSubscriptions.get(connectionId);
    if (connectionTopics) {
      for (const topic of connectionTopics) {
        const subscribers = this.subscriptions.get(topic);
        if (subscribers) {
          subscribers.delete(connectionId);
          if (subscribers.size === 0) {
            this.subscriptions.delete(topic);
          }
        }
      }
      this.connectionSubscriptions.delete(connectionId);
    }
    
    // Remove from connection manager
    this.connectionManager.removeConnection(connectionId);
    
    this.emit('disconnection', { connectionId });
    
    logger.debug('WebSocket connection closed', { connectionId });
  }
  
  /**
   * Handle connection error
   */
  handleError(ws, error) {
    logger.error('WebSocket connection error', {
      connectionId: ws.connectionId,
      error: error.message
    });
    this.stats.errors++;
  }
  
  /**
   * Send message to client
   */
  sendMessage(ws, data) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(data));
        this.stats.messagesSent++;
      } catch (error) {
        logger.error('Failed to send message', {
          connectionId: ws.connectionId,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Send error message
   */
  sendError(ws, message) {
    this.sendMessage(ws, {
      type: 'error',
      message,
      timestamp: Date.now()
    });
  }
  
  /**
   * Broadcast to topic
   */
  broadcast(topic, data) {
    const subscribers = this.subscriptions.get(topic);
    if (!subscribers || subscribers.size === 0) return;
    
    // Queue message for batching
    if (!this.messageQueue.has(topic)) {
      this.messageQueue.set(topic, []);
    }
    this.messageQueue.get(topic).push({
      ...data,
      topic,
      timestamp: Date.now()
    });
    
    this.stats.broadcasts++;
  }
  
  /**
   * Process message queue
   */
  processBatchQueue() {
    for (const [topic, messages] of this.messageQueue) {
      const subscribers = this.subscriptions.get(topic);
      if (!subscribers) continue;
      
      const batchMessage = {
        type: 'batch',
        topic,
        messages,
        timestamp: Date.now()
      };
      
      for (const connectionId of subscribers) {
        const connection = this.connectionManager.getConnection(connectionId);
        if (connection) {
          this.sendMessage(connection, batchMessage);
        }
      }
    }
    
    this.messageQueue.clear();
  }
  
  /**
   * Start batch timer
   */
  startBatchTimer() {
    this.batchTimer = setInterval(() => {
      this.processBatchQueue();
    }, 100); // 100ms batching
  }
  
  /**
   * Start heartbeat
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      for (const connectionInfo of this.connectionManager.getAllConnections()) {
        const ws = connectionInfo.connection;
        
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        
        ws.isAlive = false;
        ws.ping();
      }
    }, this.options.heartbeatInterval);
  }
  
  /**
   * Generate connection ID
   */
  generateConnectionId() {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      connections: this.connectionManager.getStats(),
      subscriptions: {
        total: this.subscriptions.size,
        topics: Array.from(this.subscriptions.entries()).map(([topic, subscribers]) => ({
          topic,
          subscribers: subscribers.size
        }))
      }
    };
  }
  
  /**
   * Shutdown server
   */
  async shutdown() {
    // Stop timers
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }
    
    // Process remaining messages
    this.processBatchQueue();
    
    // Close all connections
    if (this.wss) {
      this.wss.close();
    }
    
    // Shutdown connection manager
    this.connectionManager.shutdown();
    
    logger.info('WebSocket server shutdown', this.getStats());
  }
}

export default OtedamaWebSocketServer;