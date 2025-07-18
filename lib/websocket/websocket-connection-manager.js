/**
 * WebSocket Connection Manager
 * Enhanced connection stability and reconnection logic
 */

import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { getErrorHandler, OtedamaError, ErrorCategory, safeExecute } from '../error-handler.js';

// Connection states
export const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed'
};

// Reconnection strategies
export const ReconnectionStrategy = {
  EXPONENTIAL_BACKOFF: 'exponential_backoff',
  FIXED_INTERVAL: 'fixed_interval',
  LINEAR_BACKOFF: 'linear_backoff',
  FIBONACCI: 'fibonacci'
};

export class WebSocketConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Connection settings
      url: options.url,
      protocols: options.protocols,
      headers: options.headers || {},
      
      // Reconnection settings
      enableReconnection: options.enableReconnection !== false,
      reconnectionStrategy: options.reconnectionStrategy || ReconnectionStrategy.EXPONENTIAL_BACKOFF,
      maxReconnectAttempts: options.maxReconnectAttempts || 10,
      reconnectInterval: options.reconnectInterval || 1000,
      maxReconnectInterval: options.maxReconnectInterval || 30000,
      reconnectDecay: options.reconnectDecay || 1.5,
      
      // Heartbeat settings
      enableHeartbeat: options.enableHeartbeat !== false,
      heartbeatInterval: options.heartbeatInterval || 30000,
      heartbeatTimeout: options.heartbeatTimeout || 60000,
      
      // Queue settings
      enableMessageQueue: options.enableMessageQueue !== false,
      maxQueueSize: options.maxQueueSize || 1000,
      queueTTL: options.queueTTL || 60000, // 1 minute
      
      // Connection health
      connectionTimeout: options.connectionTimeout || 10000,
      maxConsecutiveFailures: options.maxConsecutiveFailures || 5,
      
      ...options
    };
    
    this.errorHandler = getErrorHandler();
    
    // Connection state
    this.state = ConnectionState.DISCONNECTED;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.consecutiveFailures = 0;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    
    // Message queue
    this.messageQueue = [];
    this.subscriptions = new Set();
    
    // Heartbeat
    this.heartbeatTimer = null;
    this.heartbeatResponseTimer = null;
    this.lastHeartbeatAt = null;
    this.missedHeartbeats = 0;
    
    // Metrics
    this.metrics = {
      connectAttempts: 0,
      successfulConnects: 0,
      failedConnects: 0,
      reconnects: 0,
      messagesSent: 0,
      messagesReceived: 0,
      messagesQueued: 0,
      heartbeatsSent: 0,
      heartbeatsMissed: 0,
      totalUptime: 0,
      lastError: null
    };
    
    // Fibonacci sequence for reconnection
    this.fibonacciSequence = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55];
  }

  /**
   * Connect to WebSocket server
   */
  async connect() {
    if (this.state === ConnectionState.CONNECTED || 
        this.state === ConnectionState.CONNECTING) {
      return;
    }
    
    this.state = ConnectionState.CONNECTING;
    this.metrics.connectAttempts++;
    
    this.emit('connecting', { attempt: this.metrics.connectAttempts });
    
    try {
      await this.establishConnection();
      
      this.state = ConnectionState.CONNECTED;
      this.reconnectAttempts = 0;
      this.consecutiveFailures = 0;
      this.lastConnectedAt = Date.now();
      this.metrics.successfulConnects++;
      
      // Process queued messages
      this.processMessageQueue();
      
      // Start heartbeat
      if (this.options.enableHeartbeat) {
        this.startHeartbeat();
      }
      
      this.emit('connected', {
        reconnectAttempts: this.reconnectAttempts,
        uptime: this.getUptime()
      });
      
    } catch (error) {
      this.state = ConnectionState.FAILED;
      this.consecutiveFailures++;
      this.metrics.failedConnects++;
      this.metrics.lastError = error.message;
      
      this.emit('connectFailed', {
        error: error.message,
        consecutiveFailures: this.consecutiveFailures
      });
      
      // Attempt reconnection
      if (this.options.enableReconnection && 
          this.consecutiveFailures < this.options.maxConsecutiveFailures) {
        this.scheduleReconnection();
      } else {
        this.emit('connectionAbandoned', {
          reason: 'Max consecutive failures reached',
          failures: this.consecutiveFailures
        });
      }
      
      throw error;
    }
  }

  /**
   * Establish WebSocket connection
   */
  async establishConnection() {
    return new Promise((resolve, reject) => {
      const connectionTimeout = setTimeout(() => {
        reject(new OtedamaError(
          'Connection timeout',
          ErrorCategory.WEBSOCKET,
          { timeout: this.options.connectionTimeout }
        ));
      }, this.options.connectionTimeout);
      
      try {
        this.ws = new WebSocket(this.options.url, {
          protocols: this.options.protocols,
          headers: this.options.headers,
          handshakeTimeout: this.options.connectionTimeout
        });
        
        // Connection opened
        this.ws.on('open', () => {
          clearTimeout(connectionTimeout);
          this.setupEventHandlers();
          // Begin heartbeat keep-alive if enabled
          if (this.options.enableHeartbeat) {
            this.startHeartbeat();
          }
          resolve();
        });
        
        // Connection error
        this.ws.on('error', (error) => {
          clearTimeout(connectionTimeout);
          reject(error);
        });
        
      } catch (error) {
        clearTimeout(connectionTimeout);
        reject(error);
      }
    });
  }

  /**
   * Setup WebSocket event handlers
   */
  setupEventHandlers() {
    if (!this.ws) return;
    
    // Message handler
    this.ws.on('message', async (data) => {
      await safeExecute(async () => {
        this.metrics.messagesReceived++;
        this.lastMessageAt = Date.now();
        
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch (error) {
          throw new OtedamaError(
            'Invalid message format',
            ErrorCategory.VALIDATION,
            { data: data.toString().substring(0, 100) }
          );
        }
        
        // Handle heartbeat response
        if (message.type === 'pong') {
          this.handleHeartbeatResponse();
          return;
        }
        
        this.emit('message', message);
        
        // Emit typed events
        if (message.type) {
          this.emit(`message:${message.type}`, message);
        }
        
      }, {
        service: 'websocket-message',
        category: ErrorCategory.WEBSOCKET
      });
    });
    
    // Close handler
    this.ws.on('close', (code, reason) => {
      this.handleDisconnection(code, reason?.toString());
    });
    
    // Error handler
    this.ws.on('error', async (error) => {
      await this.errorHandler.handleError(error, {
        service: 'websocket-connection',
        category: ErrorCategory.WEBSOCKET,
        context: {
          state: this.state,
          url: this.options.url
        }
      });
      
      this.metrics.lastError = error.message;
      this.emit('error', error);
    });
    
    // Ping handler
    this.ws.on('ping', () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong();
      }
    });
  }

  /**
   * Handle disconnection
   */
  handleDisconnection(code, reason) {
    const wasConnected = this.state === ConnectionState.CONNECTED;
    this.state = ConnectionState.DISCONNECTED;
    this.lastDisconnectedAt = Date.now();
    
    // Update uptime
    if (this.lastConnectedAt) {
      this.metrics.totalUptime += Date.now() - this.lastConnectedAt;
    }
    
    // Stop heartbeat
    this.stopHeartbeat();
    
    // Clean up WebSocket
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
    
    this.emit('disconnected', {
      code,
      reason,
      wasConnected,
      uptime: this.getUptime()
    });
    
    // Attempt reconnection
    if (wasConnected && this.options.enableReconnection) {
      this.scheduleReconnection();
    }
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnection() {
    if (this.state === ConnectionState.RECONNECTING ||
        this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      return;
    }
    
    this.state = ConnectionState.RECONNECTING;
    this.reconnectAttempts++;
    this.metrics.reconnects++;
    
    const delay = this.calculateReconnectDelay();
    
    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      delay,
      maxAttempts: this.options.maxReconnectAttempts
    });
    
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        // Connection will handle its own retry logic
      }
    }, delay);
  }

  /**
   * Calculate reconnection delay based on strategy
   */
  calculateReconnectDelay() {
    const attempt = this.reconnectAttempts;
    let delay = this.options.reconnectInterval;
    
    switch (this.options.reconnectionStrategy) {
      case ReconnectionStrategy.EXPONENTIAL_BACKOFF:
        delay = Math.min(
          this.options.reconnectInterval * Math.pow(this.options.reconnectDecay, attempt - 1),
          this.options.maxReconnectInterval
        );
        break;
        
      case ReconnectionStrategy.LINEAR_BACKOFF:
        delay = Math.min(
          this.options.reconnectInterval * attempt,
          this.options.maxReconnectInterval
        );
        break;
        
      case ReconnectionStrategy.FIBONACCI:
        const fibIndex = Math.min(attempt - 1, this.fibonacciSequence.length - 1);
        delay = Math.min(
          this.options.reconnectInterval * this.fibonacciSequence[fibIndex],
          this.options.maxReconnectInterval
        );
        break;
        
      case ReconnectionStrategy.FIXED_INTERVAL:
      default:
        // Use fixed interval
        break;
    }
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.3 * delay; // ±15% jitter
    return Math.floor(delay + jitter - (delay * 0.15));
  }

  /**
   * Send message
   */
  async send(message) {
    if (typeof message !== 'object') {
      throw new OtedamaError(
        'Message must be an object',
        ErrorCategory.VALIDATION
      );
    }
    
    const data = JSON.stringify(message);
    
    // Check message size
    if (data.length > 1024 * 1024) { // 1MB limit
      throw new OtedamaError(
        'Message too large',
        ErrorCategory.VALIDATION,
        { size: data.length }
      );
    }
    
    if (this.state === ConnectionState.CONNECTED && 
        this.ws?.readyState === WebSocket.OPEN) {
      
      return await safeExecute(async () => {
        this.ws.send(data);
        this.metrics.messagesSent++;
      }, {
        service: 'websocket-send',
        category: ErrorCategory.WEBSOCKET
      });
      
    } else if (this.options.enableMessageQueue) {
      // Queue message
      this.queueMessage(message);
      
    } else {
      throw new OtedamaError(
        'WebSocket not connected',
        ErrorCategory.WEBSOCKET,
        { state: this.state }
      );
    }
  }

  /**
   * Queue message for later delivery
   */
  queueMessage(message) {
    if (this.messageQueue.length >= this.options.maxQueueSize) {
      // Remove oldest message
      const removed = this.messageQueue.shift();
      this.emit('messageDropped', removed);
    }
    
    this.messageQueue.push({
      message,
      timestamp: Date.now(),
      attempts: 0
    });
    
    this.metrics.messagesQueued++;
    
    this.emit('messageQueued', {
      queueSize: this.messageQueue.length,
      message
    });
  }

  /**
   * Process queued messages
   */
  async processMessageQueue() {
    if (!this.messageQueue.length) return;
    
    const now = Date.now();
    const processedMessages = [];
    
    for (const item of this.messageQueue) {
      // Check TTL
      if (now - item.timestamp > this.options.queueTTL) {
        this.emit('messageExpired', item.message);
        continue;
      }
      
      try {
        await this.send(item.message);
        processedMessages.push(item);
      } catch (error) {
        item.attempts++;
        
        if (item.attempts >= 3) {
          this.emit('messageFailed', {
            message: item.message,
            error: error.message
          });
          processedMessages.push(item);
        }
        
        // Stop processing on error
        break;
      }
    }
    
    // Remove processed messages
    this.messageQueue = this.messageQueue.filter(
      item => !processedMessages.includes(item)
    );
    
    this.emit('queueProcessed', {
      processed: processedMessages.length,
      remaining: this.messageQueue.length
    });
  }

  /**
   * Start heartbeat mechanism
   */
  startHeartbeat() {
    this.stopHeartbeat();
    
    this.heartbeatTimer = setInterval(() => {
      if (this.state === ConnectionState.CONNECTED && 
          this.ws?.readyState === WebSocket.OPEN) {
        
        this.sendHeartbeat();
        
        // Set response timeout
        this.heartbeatResponseTimer = setTimeout(() => {
          this.handleMissedHeartbeat();
        }, this.options.heartbeatTimeout);
        
      }
    }, this.options.heartbeatInterval);
  }

  /**
   * Stop heartbeat mechanism
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    
    if (this.heartbeatResponseTimer) {
      clearTimeout(this.heartbeatResponseTimer);
      this.heartbeatResponseTimer = null;
    }
    
    this.missedHeartbeats = 0;
  }

  /**
   * Send heartbeat
   */
  sendHeartbeat() {
    this.lastHeartbeatAt = Date.now();
    this.metrics.heartbeatsSent++;
    
    this.send({
      type: 'ping',
      timestamp: Date.now()
    }).catch(error => {
      this.errorHandler.handleError(error, {
        service: 'websocket-heartbeat',
        severity: 'low'
      });
    });
  }

  /**
   * Handle heartbeat response
   */
  handleHeartbeatResponse() {
    if (this.heartbeatResponseTimer) {
      clearTimeout(this.heartbeatResponseTimer);
      this.heartbeatResponseTimer = null;
    }
    
    this.missedHeartbeats = 0;
    
    const latency = Date.now() - this.lastHeartbeatAt;
    
    this.emit('heartbeat', { latency });
  }

  /**
   * Handle missed heartbeat
   */
  handleMissedHeartbeat() {
    this.missedHeartbeats++;
    this.metrics.heartbeatsMissed++;
    
    this.emit('heartbeatMissed', {
      count: this.missedHeartbeats
    });
    
    // Force reconnection after 3 missed heartbeats
    if (this.missedHeartbeats >= 3) {
      this.emit('heartbeatTimeout');
      this.disconnect();
      this.scheduleReconnection();
    }
  }

  /**
   * Subscribe to channel
   */
  async subscribe(channel) {
    this.subscriptions.add(channel);
    
    await this.send({
      type: 'subscribe',
      channel
    });
    
    this.emit('subscribed', { channel });
  }

  /**
   * Unsubscribe from channel
   */
  async unsubscribe(channel) {
    this.subscriptions.delete(channel);
    
    await this.send({
      type: 'unsubscribe',
      channel
    });
    
    this.emit('unsubscribed', { channel });
  }

  /**
   * Resubscribe to all channels
   */
  async resubscribeAll() {
    for (const channel of this.subscriptions) {
      try {
        await this.send({
          type: 'subscribe',
          channel
        });
      } catch (error) {
        this.errorHandler.handleError(error, {
          service: 'websocket-resubscribe',
          context: { channel }
        });
      }
    }
  }

  /**
   * Disconnect
   */
  disconnect() {
    this.state = ConnectionState.DISCONNECTED;
    
    // Clear timers
    this.stopHeartbeat();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Close WebSocket
    if (this.ws) {
      this.ws.removeAllListeners();
      
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, 'Client disconnect');
      }
      
      this.ws = null;
    }
    
    // Clear message queue
    this.messageQueue = [];
    this.subscriptions.clear();
    
    this.emit('disconnected', {
      reason: 'Client initiated',
      uptime: this.getUptime()
    });
  }

  /**
   * Get connection uptime
   */
  getUptime() {
    if (this.state === ConnectionState.CONNECTED && this.lastConnectedAt) {
      return Date.now() - this.lastConnectedAt;
    }
    return 0;
  }

  /**
   * Get connection statistics
   */
  getStats() {
    return {
      state: this.state,
      uptime: this.getUptime(),
      totalUptime: this.metrics.totalUptime,
      reconnectAttempts: this.reconnectAttempts,
      consecutiveFailures: this.consecutiveFailures,
      metrics: { ...this.metrics },
      queueSize: this.messageQueue.length,
      subscriptions: this.subscriptions.size,
      lastConnected: this.lastConnectedAt,
      lastDisconnected: this.lastDisconnectedAt
    };
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.state === ConnectionState.CONNECTED && 
           this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Wait for connection
   */
  async waitForConnection(timeout = 30000) {
    if (this.isConnected()) return;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new OtedamaError(
          'Connection timeout',
          ErrorCategory.WEBSOCKET,
          { timeout }
        ));
      }, timeout);
      
      const connectedHandler = () => {
        clearTimeout(timer);
        resolve();
      };
      
      const abandonedHandler = () => {
        clearTimeout(timer);
        reject(new OtedamaError(
          'Connection abandoned',
          ErrorCategory.WEBSOCKET
        ));
      };
      
      this.once('connected', connectedHandler);
      this.once('connectionAbandoned', abandonedHandler);
    });
  }
}

export default WebSocketConnectionManager;