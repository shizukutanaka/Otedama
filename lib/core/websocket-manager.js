/**
 * Otedama Unified WebSocket Manager
 * 
 * High-performance, enterprise-grade WebSocket management system
 * following John Carmack (performance), Robert C. Martin (clean code), 
 * and Rob Pike (simplicity) principles.
 * 
 * Replaces:
 * - enhanced-connection-stability.js
 * - enhanced-realtime-server.js
 * - realtime-server.js
 * - websocket-connection-manager.js
 * - index.js
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { createHash, randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import cluster from 'cluster';
import os from 'os';

// Constants for optimal performance (Carmack principle)
const WS_CONSTANTS = Object.freeze({
  // Performance optimized values
  MAX_CONNECTIONS: 10000,
  MAX_CONNECTIONS_PER_IP: 100,
  CONNECTION_TIMEOUT: 30000,
  HEARTBEAT_INTERVAL: 30000,
  HEARTBEAT_TIMEOUT: 60000,
  MAX_MISSED_HEARTBEATS: 3,
  
  // Message settings
  MAX_MESSAGE_SIZE: 1024 * 1024, // 1MB
  MAX_SUBSCRIPTIONS: 100,
  
  // Rate limiting
  RATE_LIMIT_WINDOW: 60000,      // 1 minute
  RATE_LIMIT_MAX_REQUESTS: 100,
  RATE_LIMIT_BURST_SIZE: 20,
  
  // Reconnection
  BASE_RECONNECT_DELAY: 1000,
  MAX_RECONNECT_DELAY: 30000,
  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DECAY: 1.5,
  
  // Queue settings
  MAX_QUEUE_SIZE: 1000,
  QUEUE_TTL: 60000,             // 1 minute
  
  // Cleanup intervals
  CLEANUP_INTERVAL: 300000,      // 5 minutes
  METRICS_INTERVAL: 60000,       // 1 minute
});

// Connection states
const ConnectionState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting', 
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed'
});

// Connection quality levels
const ConnectionQuality = Object.freeze({
  EXCELLENT: 'excellent',
  GOOD: 'good',
  FAIR: 'fair',
  POOR: 'poor',
  CRITICAL: 'critical'
});

// Circuit breaker states
const CircuitState = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open'
});

/**
 * Connection wrapper with health monitoring
 */
class ManagedConnection {
  constructor(id, ws, ip, userAgent) {
    this.id = id;
    this.ws = ws;
    this.ip = ip;
    this.userAgent = userAgent;
    
    // Connection state
    this.authenticated = false;
    this.subscriptions = new Set();
    this.metadata = {};
    
    // Health metrics
    this.isAlive = true;
    this.lastActivity = Date.now();
    this.missedHeartbeats = 0;
    this.latency = 0;
    this.quality = ConnectionQuality.EXCELLENT;
    
    // Rate limiting
    this.requestCount = 0;
    this.requestWindow = Date.now();
    this.tokenBucket = {
      tokens: WS_CONSTANTS.RATE_LIMIT_BURST_SIZE,
      lastRefill: Date.now()
    };
    
    // Statistics
    this.connectedAt = Date.now();
    this.messagesReceived = 0;
    this.messagesSent = 0;
    this.errors = 0;
  }

  updateActivity() {
    this.lastActivity = Date.now();
    this.messagesReceived++;
  }

  updateLatency(latency) {
    this.latency = latency;
    
    // Update connection quality based on latency
    if (latency < 50) {
      this.quality = ConnectionQuality.EXCELLENT;
    } else if (latency < 100) {
      this.quality = ConnectionQuality.GOOD;
    } else if (latency < 200) {
      this.quality = ConnectionQuality.FAIR;
    } else if (latency < 500) {
      this.quality = ConnectionQuality.POOR;
    } else {
      this.quality = ConnectionQuality.CRITICAL;
    }
  }

  checkRateLimit() {
    const now = Date.now();
    
    // Refill token bucket
    const timePassed = now - this.tokenBucket.lastRefill;
    const tokensToAdd = Math.floor(timePassed / 1000) * (WS_CONSTANTS.RATE_LIMIT_MAX_REQUESTS / 60);
    
    this.tokenBucket.tokens = Math.min(
      this.tokenBucket.tokens + tokensToAdd,
      WS_CONSTANTS.RATE_LIMIT_BURST_SIZE
    );
    this.tokenBucket.lastRefill = now;
    
    // Check if tokens available
    if (this.tokenBucket.tokens >= 1) {
      this.tokenBucket.tokens--;
      return true;
    }
    return false;
  }

  isHealthy() {
    return this.isAlive && 
           this.errors < 10 && 
           this.missedHeartbeats < WS_CONSTANTS.MAX_MISSED_HEARTBEATS;
  }

  getStats() {
    return {
      id: this.id,
      ip: this.ip,
      authenticated: this.authenticated,
      subscriptions: this.subscriptions.size,
      connectedAt: this.connectedAt,
      lastActivity: this.lastActivity,
      latency: this.latency,
      quality: this.quality,
      messagesReceived: this.messagesReceived,
      messagesSent: this.messagesSent,
      errors: this.errors,
      uptime: Date.now() - this.connectedAt
    };
  }
}

/**
 * Channel manager for pub/sub functionality
 */
class ChannelManager {
  constructor() {
    this.channels = new Map();
    this.connectionChannels = new Map(); // connectionId -> Set of channels
  }

  subscribe(connectionId, channel) {
    // Add to channel
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel).add(connectionId);

    // Track connection channels
    if (!this.connectionChannels.has(connectionId)) {
      this.connectionChannels.set(connectionId, new Set());
    }
    this.connectionChannels.get(connectionId).add(channel);
  }

  unsubscribe(connectionId, channel) {
    // Remove from channel
    const channelSubs = this.channels.get(channel);
    if (channelSubs) {
      channelSubs.delete(connectionId);
      if (channelSubs.size === 0) {
        this.channels.delete(channel);
      }
    }

    // Remove from connection channels
    const connChannels = this.connectionChannels.get(connectionId);
    if (connChannels) {
      connChannels.delete(channel);
    }
  }

  unsubscribeAll(connectionId) {
    const connChannels = this.connectionChannels.get(connectionId);
    if (connChannels) {
      for (const channel of connChannels) {
        this.unsubscribe(connectionId, channel);
      }
      this.connectionChannels.delete(connectionId);
    }
  }

  getSubscribers(channel) {
    return this.channels.get(channel) || new Set();
  }

  getChannels() {
    return Array.from(this.channels.keys());
  }

  getStats() {
    return {
      totalChannels: this.channels.size,
      totalSubscriptions: Array.from(this.channels.values())
        .reduce((sum, subs) => sum + subs.size, 0),
      channels: Object.fromEntries(
        Array.from(this.channels.entries()).map(([channel, subs]) => 
          [channel, subs.size]
        )
      )
    };
  }
}

/**
 * High-performance WebSocket Server (Carmack principle)
 */
export class WebSocketManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      // Server settings
      port: options.port || 8081,
      host: options.host || '0.0.0.0',
      path: options.path || '/ws',
      
      // Connection limits
      maxConnections: options.maxConnections || WS_CONSTANTS.MAX_CONNECTIONS,
      maxConnectionsPerIP: options.maxConnectionsPerIP || WS_CONSTANTS.MAX_CONNECTIONS_PER_IP,
      connectionTimeout: options.connectionTimeout || WS_CONSTANTS.CONNECTION_TIMEOUT,
      
      // Heartbeat settings
      heartbeatInterval: options.heartbeatInterval || WS_CONSTANTS.HEARTBEAT_INTERVAL,
      heartbeatTimeout: options.heartbeatTimeout || WS_CONSTANTS.HEARTBEAT_TIMEOUT,
      
      // Rate limiting
      enableRateLimiting: options.enableRateLimiting !== false,
      
      // Security
      enableAuth: options.enableAuth || false,
      authTimeout: options.authTimeout || 10000,
      
      // Clustering
      enableClustering: options.enableClustering || false,
      workers: options.workers || Math.min(os.cpus().length, 4),
      
      ...options
    };

    // Core state
    this.wss = null;
    this.connections = new Map();
    this.ipConnections = new Map();
    this.channelManager = new ChannelManager();
    
    // Message handlers
    this.messageHandlers = new Map();
    this.middleware = [];
    
    // Circuit breaker
    this.circuitState = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    
    // Statistics (Pike principle - simple tracking)
    this.stats = {
      connections: 0,
      disconnections: 0,
      messages: 0,
      broadcasts: 0,
      errors: 0,
      blocked: 0,
      startTime: Date.now()
    };

    // Intervals
    this.intervals = {
      heartbeat: null,
      cleanup: null,
      metrics: null
    };

    this.setupDefaultHandlers();
  }

  /**
   * Start WebSocket server
   */
  async start() {
    if (this.options.enableClustering && cluster.isPrimary) {
      return this.startCluster();
    }

    try {
      this.wss = new WebSocketServer({
        port: this.options.port,
        host: this.options.host,
        path: this.options.path,
        maxPayload: WS_CONSTANTS.MAX_MESSAGE_SIZE,
        perMessageDeflate: true,
        clientTracking: false,
        verifyClient: this.verifyClient.bind(this)
      });

      this.setupServerEvents();
      this.startMonitoring();

      console.log(`WebSocket server listening on ${this.options.host}:${this.options.port}`);
      this.emit('started', {
        host: this.options.host,
        port: this.options.port,
        clustering: this.options.enableClustering
      });

    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Start clustered server
   */
  startCluster() {
    console.log(`Starting ${this.options.workers} WebSocket workers...`);

    // Fork workers
    for (let i = 0; i < this.options.workers; i++) {
      const worker = cluster.fork();
      
      worker.on('error', (error) => {
        console.error(`Worker ${worker.id} error:`, error);
      });
    }

    // Handle worker deaths
    cluster.on('exit', (worker, code, signal) => {
      console.log(`Worker ${worker.id} died (${signal || code}). Restarting...`);
      cluster.fork();
    });

    // Cluster communication for broadcasts
    if (cluster.isWorker) {
      process.on('message', (message) => {
        if (message.type === 'broadcast') {
          this.localBroadcast(message.channel, message.data);
        }
      });
    }
  }

  /**
   * Setup server event handlers
   */
  setupServerEvents() {
    this.wss.on('connection', this.handleConnection.bind(this));
    this.wss.on('error', this.handleServerError.bind(this));
    
    this.wss.on('listening', () => {
      this.emit('listening');
    });
  }

  /**
   * Verify client connection
   */
  verifyClient(info, callback) {
    const ip = this.getClientIP(info.req);

    // Check global connection limit
    if (this.connections.size >= this.options.maxConnections) {
      this.stats.blocked++;
      callback(false, 503, 'Service Unavailable');
      return;
    }

    // Check per-IP connection limit
    const ipCount = this.ipConnections.get(ip) || 0;
    if (ipCount >= this.options.maxConnectionsPerIP) {
      this.stats.blocked++;
      callback(false, 429, 'Too Many Requests');
      return;
    }

    // Circuit breaker check
    if (this.circuitState === CircuitState.OPEN) {
      callback(false, 503, 'Service Temporarily Unavailable');
      return;
    }

    callback(true);
  }

  /**
   * Handle new connection
   */
  async handleConnection(ws, request) {
    const connectionId = this.generateConnectionId();
    const ip = this.getClientIP(request);
    const userAgent = request.headers['user-agent'] || 'Unknown';

    const connection = new ManagedConnection(connectionId, ws, ip, userAgent);

    // Track connection
    this.connections.set(connectionId, connection);
    this.ipConnections.set(ip, (this.ipConnections.get(ip) || 0) + 1);
    this.stats.connections++;

    // Setup connection events
    this.setupConnectionEvents(connection);

    // Authentication timeout
    let authTimeout;
    if (this.options.enableAuth) {
      authTimeout = setTimeout(() => {
        if (!connection.authenticated) {
          this.disconnectConnection(connection, 1002, 'Authentication timeout');
        }
      }, this.options.authTimeout);
    }

    try {
      // Send welcome message
      await this.sendToConnection(connection, {
        type: 'welcome',
        connectionId,
        serverTime: Date.now(),
        requiresAuth: this.options.enableAuth
      });

      this.emit('connection', {
        connectionId,
        ip,
        userAgent
      });

    } catch (error) {
      this.disconnectConnection(connection, 1011, 'Server error');
    }

    // Clear auth timeout on successful setup
    if (authTimeout) {
      clearTimeout(authTimeout);
    }
  }

  /**
   * Setup connection event handlers
   */
  setupConnectionEvents(connection) {
    const { ws } = connection;

    ws.on('message', async (data) => {
      try {
        await this.handleMessage(connection, data);
      } catch (error) {
        connection.errors++;
        this.handleConnectionError(connection, error);
      }
    });

    ws.on('close', (code, reason) => {
      this.handleDisconnection(connection, code, reason?.toString());
    });

    ws.on('error', (error) => {
      connection.errors++;
      this.handleConnectionError(connection, error);
    });

    ws.on('pong', () => {
      this.handlePong(connection);
    });
  }

  /**
   * Handle incoming message
   */
  async handleMessage(connection, data) {
    connection.updateActivity();

    // Rate limiting
    if (this.options.enableRateLimiting && !connection.checkRateLimit()) {
      throw new Error('Rate limit exceeded');
    }

    // Parse message
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      throw new Error('Invalid JSON format');
    }

    if (!message.type) {
      throw new Error('Missing message type');
    }

    // Run middleware
    for (const middleware of this.middleware) {
      const result = await middleware(connection, message);
      if (result === false) return; // Rejected
      if (typeof result === 'object') message = result; // Modified
    }

    // Check authentication
    if (this.options.enableAuth && !connection.authenticated && message.type !== 'auth') {
      throw new Error('Not authenticated');
    }

    // Get handler
    const handler = this.messageHandlers.get(message.type);
    if (!handler) {
      throw new Error(`Unknown message type: ${message.type}`);
    }

    // Execute handler with timeout
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Handler timeout')), 5000);
    });

    await Promise.race([
      handler.call(this, connection, message),
      timeout
    ]);

    this.stats.messages++;
  }

  /**
   * Send message to connection
   */
  async sendToConnection(connection, message) {
    if (!connection.ws || connection.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Connection not available');
    }

    const isBuffer = Buffer.isBuffer(message);
    const payload = isBuffer ? message : Buffer.from(JSON.stringify(message));

    if (payload.length > WS_CONSTANTS.MAX_MESSAGE_SIZE) {
      throw new Error('Message too large');
    }

    // Back-pressure handling
    if (connection.ws.bufferedAmount > 8 * 1024 * 1024) { // 8MB
      await this.waitForDrain(connection.ws);
    }

    connection.ws.send(payload, { binary: isBuffer });
    connection.messagesSent++;
  }

  /**
   * Wait for WebSocket buffer to drain
   */
  async waitForDrain(ws) {
    return new Promise((resolve) => {
      const check = () => {
        if (ws.bufferedAmount < 4 * 1024 * 1024) { // 4MB
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });
  }

  /**
   * Broadcast message to channel
   */
  broadcast(channel, message, excludeConnection = null) {
    const isBuffer = Buffer.isBuffer(message);
    const payload = isBuffer ? message : JSON.stringify(message);
    const subscribers = this.channelManager.getSubscribers(channel);

    let sent = 0;
    let errors = 0;

    for (const connectionId of subscribers) {
      if (excludeConnection && connectionId === excludeConnection.id) {
        continue;
      }

      const connection = this.connections.get(connectionId);
      if (connection && connection.ws.readyState === WebSocket.OPEN) {
        try {
          connection.ws.send(payload, { binary: isBuffer });
          sent++;
        } catch (error) {
          errors++;
          this.handleConnectionError(connection, error);
        }
      }
    }

    // Cluster broadcast
    if (this.options.enableClustering && cluster.isWorker) {
      process.send({
        type: 'broadcast',
        channel,
        data: message
      });
    }

    this.stats.broadcasts++;
    return { sent, errors };
  }

  /**
   * Local broadcast (for cluster workers)
   */
  localBroadcast(channel, message) {
    return this.broadcast(channel, message);
  }

  /**
   * Handle connection disconnection
   */
  handleDisconnection(connection, code, reason) {
    // Cleanup subscriptions
    this.channelManager.unsubscribeAll(connection.id);

    // Update IP connections
    const ipCount = this.ipConnections.get(connection.ip) || 0;
    if (ipCount > 1) {
      this.ipConnections.set(connection.ip, ipCount - 1);
    } else {
      this.ipConnections.delete(connection.ip);
    }

    // Remove connection
    this.connections.delete(connection.id);
    this.stats.disconnections++;

    this.emit('disconnection', {
      connectionId: connection.id,
      code,
      reason,
      duration: Date.now() - connection.connectedAt,
      stats: connection.getStats()
    });
  }

  /**
   * Disconnect connection
   */
  disconnectConnection(connection, code = 1000, reason = 'Normal closure') {
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close(code, reason);
    } else {
      connection.ws.terminate();
    }
  }

  /**
   * Handle connection error
   */
  handleConnectionError(connection, error) {
    this.stats.errors++;
    this.failureCount++;
    this.lastFailureTime = Date.now();

    this.emit('connectionError', {
      connectionId: connection.id,
      error: error.message
    });

    // Update circuit breaker
    this.updateCircuitBreaker();

    // Send error to connection
    try {
      this.sendToConnection(connection, {
        type: 'error',
        error: error.message
      });
    } catch (sendError) {
      // Ignore send errors
    }

    // Disconnect if too many errors
    if (connection.errors > 10) {
      this.disconnectConnection(connection, 1002, 'Too many errors');
    }
  }

  /**
   * Handle server error
   */
  handleServerError(error) {
    this.emit('error', error);
    console.error('WebSocket server error:', error);
  }

  /**
   * Update circuit breaker state
   */
  updateCircuitBreaker() {
    const now = Date.now();

    switch (this.circuitState) {
      case CircuitState.CLOSED:
        if (this.failureCount >= 10) {
          this.circuitState = CircuitState.OPEN;
          this.emit('circuitOpen');
        }
        break;

      case CircuitState.OPEN:
        if (now - this.lastFailureTime >= 60000) { // 1 minute
          this.circuitState = CircuitState.HALF_OPEN;
          this.failureCount = 0;
          this.emit('circuitHalfOpen');
        }
        break;

      case CircuitState.HALF_OPEN:
        if (this.failureCount === 0) {
          this.circuitState = CircuitState.CLOSED;
          this.emit('circuitClosed');
        } else if (this.failureCount >= 3) {
          this.circuitState = CircuitState.OPEN;
          this.emit('circuitOpen');
        }
        break;
    }
  }

  /**
   * Start monitoring
   */
  startMonitoring() {
    // Heartbeat check
    this.intervals.heartbeat = setInterval(() => {
      this.performHeartbeat();
    }, this.options.heartbeatInterval);

    // Cleanup inactive connections
    this.intervals.cleanup = setInterval(() => {
      this.cleanupConnections();
    }, WS_CONSTANTS.CLEANUP_INTERVAL);

    // Metrics collection
    this.intervals.metrics = setInterval(() => {
      this.collectMetrics();
    }, WS_CONSTANTS.METRICS_INTERVAL);
  }

  /**
   * Perform heartbeat check
   */
  performHeartbeat() {
    const now = Date.now();
    const deadConnections = [];

    for (const connection of this.connections.values()) {
      if (!connection.isAlive) {
        connection.missedHeartbeats++;
        
        if (connection.missedHeartbeats >= WS_CONSTANTS.MAX_MISSED_HEARTBEATS) {
          deadConnections.push(connection);
        }
      } else {
        connection.isAlive = false;
        
        if (connection.ws.readyState === WebSocket.OPEN) {
          connection.ws.ping();
        }
      }
    }

    // Remove dead connections
    for (const connection of deadConnections) {
      this.disconnectConnection(connection, 1001, 'Heartbeat timeout');
    }
  }

  /**
   * Handle pong response
   */
  handlePong(connection) {
    connection.isAlive = true;
    connection.missedHeartbeats = 0;
    
    const latency = Date.now() - connection.lastActivity;
    connection.updateLatency(latency);
  }

  /**
   * Cleanup inactive connections
   */
  cleanupConnections() {
    const now = Date.now();
    const staleConnections = [];

    for (const connection of this.connections.values()) {
      // Mark stale connections
      if (now - connection.lastActivity > 300000) { // 5 minutes
        staleConnections.push(connection);
      }
    }

    for (const connection of staleConnections) {
      this.disconnectConnection(connection, 1001, 'Connection inactive');
    }
  }

  /**
   * Collect metrics
   */
  collectMetrics() {
    const metrics = {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
      activeConnections: this.connections.size,
      channels: this.channelManager.getStats(),
      circuitState: this.circuitState,
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    };

    this.emit('metrics', metrics);
  }

  /**
   * Setup default message handlers
   */
  setupDefaultHandlers() {
    // Authentication
    this.addMessageHandler('auth', async (connection, message) => {
      if (connection.authenticated) {
        throw new Error('Already authenticated');
      }

      // Simple token validation (implement your logic)
      const isValid = await this.validateAuth(message.token);
      if (!isValid) {
        throw new Error('Invalid authentication');
      }

      connection.authenticated = true;
      connection.metadata = message.metadata || {};

      await this.sendToConnection(connection, {
        type: 'authenticated',
        connectionId: connection.id
      });
    });

    // Subscribe to channel
    this.addMessageHandler('subscribe', async (connection, message) => {
      const { channel } = message;
      if (!channel) {
        throw new Error('Channel required');
      }

      if (connection.subscriptions.size >= WS_CONSTANTS.MAX_SUBSCRIPTIONS) {
        throw new Error('Max subscriptions reached');
      }

      this.channelManager.subscribe(connection.id, channel);
      connection.subscriptions.add(channel);

      await this.sendToConnection(connection, {
        type: 'subscribed',
        channel
      });
    });

    // Unsubscribe from channel
    this.addMessageHandler('unsubscribe', async (connection, message) => {
      const { channel } = message;
      if (!channel) {
        throw new Error('Channel required');
      }

      this.channelManager.unsubscribe(connection.id, channel);
      connection.subscriptions.delete(channel);

      await this.sendToConnection(connection, {
        type: 'unsubscribed',
        channel
      });
    });

    // Ping/pong
    this.addMessageHandler('ping', async (connection, message) => {
      await this.sendToConnection(connection, {
        type: 'pong',
        timestamp: Date.now()
      });
    });
    
    // Dashboard subscription
    this.addMessageHandler('dashboard:subscribe', async (connection, message) => {
      const { channels = ['all'] } = message;
      
      // Subscribe to dashboard channels
      for (const channel of channels) {
        const dashboardChannel = `dashboard:${channel}`;
        this.channelManager.subscribe(connection.id, dashboardChannel);
        connection.subscriptions.add(dashboardChannel);
      }
      
      await this.sendToConnection(connection, {
        type: 'dashboard:subscribed',
        channels
      });
      
      // Send initial metrics if dashboard is available
      if (this.options.dashboard) {
        const metrics = this.options.dashboard.getCurrentMetrics(channels);
        await this.sendToConnection(connection, {
          type: 'dashboard:metrics',
          data: metrics
        });
      }
    });
    
    // Dashboard unsubscribe
    this.addMessageHandler('dashboard:unsubscribe', async (connection, message) => {
      const { channels = ['all'] } = message;
      
      for (const channel of channels) {
        const dashboardChannel = `dashboard:${channel}`;
        this.channelManager.unsubscribe(connection.id, dashboardChannel);
        connection.subscriptions.delete(dashboardChannel);
      }
      
      await this.sendToConnection(connection, {
        type: 'dashboard:unsubscribed',
        channels
      });
    });
  }

  /**
   * Add message handler
   */
  addMessageHandler(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  /**
   * Add middleware
   */
  use(middleware) {
    this.middleware.push(middleware);
  }

  /**
   * Validate authentication token
   */
  async validateAuth(token) {
    // Use the WebSocket auth module
    if (!this.wsAuth) {
      // Lazy load auth module
      const { WebSocketAuth } = await import('../websocket/websocket-auth.js');
      this.wsAuth = new WebSocketAuth({
        jwtSecret: this.options.jwtSecret || process.env.JWT_SECRET,
        requireAuth: this.options.enableAuth,
        allowedOrigins: this.options.allowedOrigins
      });
    }
    
    try {
      const decoded = await this.wsAuth.verifyToken(token);
      return decoded;
    } catch (error) {
      console.error('Token validation failed:', error);
      return false;
    }
  }

  /**
   * Get client IP address
   */
  getClientIP(request) {
    return request.headers['x-forwarded-for'] ||
           request.headers['x-real-ip'] ||
           request.connection.remoteAddress ||
           request.socket.remoteAddress ||
           '0.0.0.0';
  }

  /**
   * Generate connection ID
   */
  generateConnectionId() {
    return createHash('sha256')
      .update(Date.now().toString())
      .update(Math.random().toString())
      .update(process.pid.toString())
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Get server statistics
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime,
      activeConnections: this.connections.size,
      channels: this.channelManager.getStats(),
      circuitState: this.circuitState,
      ipConnections: this.ipConnections.size
    };
  }

  /**
   * Get connection info
   */
  getConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    return connection ? connection.getStats() : null;
  }

  /**
   * Health check
   */
  async healthCheck() {
    return {
      status: 'healthy',
      connections: this.connections.size,
      channels: this.channelManager.channels.size,
      uptime: Date.now() - this.stats.startTime,
      circuit: this.circuitState
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    // Stop monitoring
    Object.values(this.intervals).forEach(interval => {
      if (interval) clearInterval(interval);
    });

    // Close all connections
    const closePromises = [];
    for (const connection of this.connections.values()) {
      closePromises.push(new Promise(resolve => {
        connection.ws.close(1001, 'Server shutting down');
        connection.ws.once('close', resolve);
        setTimeout(resolve, 5000); // Force timeout
      }));
    }

    await Promise.all(closePromises);

    // Close server
    if (this.wss) {
      await new Promise(resolve => {
        this.wss.close(resolve);
      });
    }

    this.emit('shutdown');
    console.log('WebSocket server shutdown complete');
  }
}

/**
 * WebSocket Client Manager (simplified client-side)
 */
export class WebSocketClient extends EventEmitter {
  constructor(url, options = {}) {
    super();
    
    this.url = url;
    this.options = {
      enableReconnection: options.enableReconnection !== false,
      maxReconnectAttempts: options.maxReconnectAttempts || WS_CONSTANTS.MAX_RECONNECT_ATTEMPTS,
      reconnectInterval: options.reconnectInterval || WS_CONSTANTS.BASE_RECONNECT_DELAY,
      maxReconnectInterval: options.maxReconnectInterval || WS_CONSTANTS.MAX_RECONNECT_DELAY,
      ...options
    };
    
    this.state = ConnectionState.DISCONNECTED;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.subscriptions = new Set();
    this.messageQueue = [];
  }

  async connect() {
    if (this.state === ConnectionState.CONNECTED || 
        this.state === ConnectionState.CONNECTING) {
      return;
    }

    this.state = ConnectionState.CONNECTING;
    this.emit('connecting');

    try {
      this.ws = new WebSocket(this.url);
      
      this.ws.on('open', () => {
        this.state = ConnectionState.CONNECTED;
        this.reconnectAttempts = 0;
        this.emit('connected');
        this.processMessageQueue();
      });

      this.ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        this.emit('message', message);
        if (message.type) {
          this.emit(`message:${message.type}`, message);
        }
      });

      this.ws.on('close', () => {
        this.state = ConnectionState.DISCONNECTED;
        this.emit('disconnected');
        
        if (this.options.enableReconnection && 
            this.reconnectAttempts < this.options.maxReconnectAttempts) {
          this.scheduleReconnection();
        }
      });

      this.ws.on('error', (error) => {
        this.emit('error', error);
      });

    } catch (error) {
      this.state = ConnectionState.FAILED;
      this.emit('error', error);
      throw error;
    }
  }

  async send(message) {
    if (this.state === ConnectionState.CONNECTED && 
        this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }
  }

  async subscribe(channel) {
    this.subscriptions.add(channel);
    await this.send({ type: 'subscribe', channel });
  }

  async unsubscribe(channel) {
    this.subscriptions.delete(channel);
    await this.send({ type: 'unsubscribe', channel });
  }

  scheduleReconnection() {
    this.state = ConnectionState.RECONNECTING;
    this.reconnectAttempts++;
    
    const delay = Math.min(
      this.options.reconnectInterval * Math.pow(1.5, this.reconnectAttempts - 1),
      this.options.maxReconnectInterval
    );

    setTimeout(() => {
      this.connect().catch(() => {
        // Reconnection will be handled by close event
      });
    }, delay);
  }

  processMessageQueue() {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.send(message);
    }
  }

  disconnect() {
    this.state = ConnectionState.DISCONNECTED;
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
    }
  }
}

// Export specialized servers for backward compatibility
export class MiningStatsServer extends WebSocketManager {
  constructor(options = {}) {
    super({ ...options, port: options.port || 8081 });
    this.setupMiningHandlers();
  }

  setupMiningHandlers() {
    // Pool stats broadcasting
    this.broadcastPoolStats = (stats) => {
      this.broadcast('pool:stats', {
        hashrate: stats.hashrate,
        miners: stats.miners,
        workers: stats.workers,
        blocks: stats.blocks,
        timestamp: Date.now()
      });
    };

    // Block found broadcasting  
    this.broadcastBlockFound = (block) => {
      this.broadcast('pool:blocks', {
        height: block.height,
        hash: block.hash,
        reward: block.reward,
        finder: block.finder,
        timestamp: Date.now()
      });
    };
  }
}

// Data Sync Server for persistence
export class DataSyncServer extends WebSocketManager {
  constructor(options = {}) {
    super({ ...options, port: options.port || 8083 });
    this.persistenceManager = options.persistenceManager;
    this.syncHandler = null;
    this.setupSyncHandlers();
  }

  async setupSyncHandlers() {
    if (this.persistenceManager) {
      // Lazy load the sync handler
      const { SyncWebSocketHandler } = await import('../websocket/sync-websocket-handler.js');
      this.syncHandler = new SyncWebSocketHandler(this.persistenceManager);
      
      // Override the default connection handler
      this.removeAllListeners('connection');
      this.on('connection', ({ connectionId, ip, userAgent }) => {
        const ws = this.connections.get(connectionId)?.ws;
        if (ws) {
          const request = { 
            socket: { remoteAddress: ip }, 
            headers: { 'user-agent': userAgent } 
          };
          this.syncHandler.handleConnection(ws, request);
        }
      });
      
      // Forward messages to sync handler
      const originalHandleMessage = this.handleMessage.bind(this);
      this.handleMessage = async (connection, data) => {
        // Let sync handler process the message
        await this.syncHandler.handleMessage(connection.ws, data);
      };
    }
  }
}

export class DexDataServer extends WebSocketManager {
  constructor(options = {}) {
    super({ ...options, port: options.port || 8082 });
    this.setupDexHandlers();
  }

  setupDexHandlers() {
    // Order book updates
    this.broadcastOrderBook = (pair, orderbook) => {
      this.broadcast(`dex:orderbook:${pair}`, {
        pair,
        bids: orderbook.bids,
        asks: orderbook.asks,
        timestamp: Date.now()
      });
    };

    // Trade updates
    this.broadcastTrade = (trade) => {
      this.broadcast(`dex:trades:${trade.pair}`, {
        id: trade.id,
        pair: trade.pair,
        price: trade.price,
        amount: trade.amount,
        side: trade.side,
        timestamp: Date.now()
      });
    };
  }
}

// Simple setup function (Pike principle)
export function setupRealtimeServers(config = {}, workDistributor = null) {
  const miningServer = new MiningStatsServer({
    port: config.miningPort || 8081
  });

  const dexServer = new DexDataServer({
    port: config.dexPort || 8082
  });

  Promise.all([
    miningServer.start(),
    dexServer.start()
  ]).then(() => {
    console.log('Real-time servers started successfully');
  }).catch(error => {
    console.error('Failed to start real-time servers:', error);
  });

  return {
    mining: miningServer,
    dex: dexServer,
    shutdown: async () => {
      await Promise.all([
        miningServer.shutdown(),
        dexServer.shutdown()
      ]);
    }
  };
}

export default WebSocketManager;
