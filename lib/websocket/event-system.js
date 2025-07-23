/**
 * WebSocket Real-time Event System
 * High-performance event broadcasting with rooms and namespaces
 * 
 * Features:
 * - Scalable WebSocket server with clustering
 * - Event rooms and namespaces
 * - Binary data support
 * - Message compression
 * - Automatic reconnection
 * - Event history and replay
 * - Rate limiting per connection
 * - Authentication and authorization
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createLogger } = require('../core/logger');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const logger = createLogger('websocket-events');

// Event types
const EventType = {
  // System events
  CONNECTION: 'connection',
  DISCONNECT: 'disconnect',
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',
  
  // Mining events
  SHARE_SUBMITTED: 'share.submitted',
  SHARE_ACCEPTED: 'share.accepted',
  SHARE_REJECTED: 'share.rejected',
  BLOCK_FOUND: 'block.found',
  DIFFICULTY_ADJUSTED: 'difficulty.adjusted',
  HASHRATE_UPDATE: 'hashrate.update',
  
  // Pool events
  MINER_CONNECTED: 'miner.connected',
  MINER_DISCONNECTED: 'miner.disconnected',
  PAYMENT_SENT: 'payment.sent',
  STATS_UPDATE: 'stats.update',
  
  // DEX events
  TRADE_EXECUTED: 'trade.executed',
  ORDER_PLACED: 'order.placed',
  ORDER_CANCELLED: 'order.cancelled',
  LIQUIDITY_ADDED: 'liquidity.added',
  LIQUIDITY_REMOVED: 'liquidity.removed',
  
  // Custom events
  CUSTOM: 'custom'
};

// Message types
const MessageType = {
  EVENT: 'event',
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  AUTH: 'auth',
  ACK: 'ack',
  ERROR: 'error',
  HEARTBEAT: 'heartbeat'
};

class EventMessage {
  constructor(type, event, data, options = {}) {
    this.id = crypto.randomBytes(16).toString('hex');
    this.type = type;
    this.event = event;
    this.data = data;
    this.timestamp = Date.now();
    this.room = options.room || null;
    this.namespace = options.namespace || '/';
    this.ack = options.ack || false;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      event: this.event,
      data: this.data,
      timestamp: this.timestamp,
      room: this.room,
      namespace: this.namespace,
      ack: this.ack
    };
  }

  toBinary() {
    return Buffer.from(JSON.stringify(this));
  }

  static fromJSON(json) {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    const message = new EventMessage(
      obj.type,
      obj.event,
      obj.data,
      {
        room: obj.room,
        namespace: obj.namespace,
        ack: obj.ack
      }
    );
    message.id = obj.id;
    message.timestamp = obj.timestamp;
    return message;
  }
}

class EventRoom {
  constructor(name) {
    this.name = name;
    this.clients = new Set();
    this.metadata = {};
    this.createdAt = Date.now();
  }

  join(client) {
    this.clients.add(client);
    client.rooms.add(this.name);
  }

  leave(client) {
    this.clients.delete(client);
    client.rooms.delete(this.name);
  }

  broadcast(message, sender = null) {
    for (const client of this.clients) {
      if (client !== sender && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  getInfo() {
    return {
      name: this.name,
      clients: this.clients.size,
      metadata: this.metadata,
      createdAt: this.createdAt
    };
  }
}

class EventHistory {
  constructor(maxSize = 1000, ttl = 3600000) { // 1 hour TTL
    this.events = [];
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.index = new Map(); // Event type to event indices
  }

  add(event) {
    // Remove old events
    this.cleanup();
    
    // Add new event
    this.events.push({
      event,
      timestamp: Date.now()
    });
    
    // Update index
    if (!this.index.has(event.event)) {
      this.index.set(event.event, []);
    }
    this.index.get(event.event).push(this.events.length - 1);
    
    // Trim if needed
    if (this.events.length > this.maxSize) {
      this.events.shift();
      this.rebuildIndex();
    }
  }

  getByType(eventType, limit = 100) {
    const indices = this.index.get(eventType) || [];
    return indices
      .slice(-limit)
      .map(i => this.events[i]?.event)
      .filter(Boolean);
  }

  getRecent(limit = 100) {
    return this.events
      .slice(-limit)
      .map(e => e.event);
  }

  cleanup() {
    const now = Date.now();
    const cutoff = now - this.ttl;
    
    this.events = this.events.filter(e => e.timestamp > cutoff);
    this.rebuildIndex();
  }

  rebuildIndex() {
    this.index.clear();
    this.events.forEach((e, i) => {
      if (!this.index.has(e.event.event)) {
        this.index.set(e.event.event, []);
      }
      this.index.get(e.event.event).push(i);
    });
  }
}

class WebSocketClient {
  constructor(ws, id) {
    this.ws = ws;
    this.id = id;
    this.authenticated = false;
    this.user = null;
    this.rooms = new Set();
    this.subscriptions = new Set();
    this.connectedAt = Date.now();
    this.lastActivity = Date.now();
    this.messageCount = 0;
    this.metadata = {};
  }

  send(data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      this.ws.send(message);
      this.lastActivity = Date.now();
      this.messageCount++;
    }
  }

  close(code = 1000, reason = '') {
    this.ws.close(code, reason);
  }

  getInfo() {
    return {
      id: this.id,
      authenticated: this.authenticated,
      user: this.user,
      rooms: Array.from(this.rooms),
      subscriptions: Array.from(this.subscriptions),
      connectedAt: this.connectedAt,
      lastActivity: this.lastActivity,
      messageCount: this.messageCount,
      metadata: this.metadata
    };
  }
}

class WebSocketEventSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      port: options.port || 3334,
      host: options.host || '0.0.0.0',
      ssl: options.ssl || false,
      sslKey: options.sslKey,
      sslCert: options.sslCert,
      maxClients: options.maxClients || 10000,
      heartbeatInterval: options.heartbeatInterval || 30000,
      clientTimeout: options.clientTimeout || 60000,
      compression: options.compression !== false,
      perMessageDeflate: options.perMessageDeflate || {
        zlibDeflateOptions: {
          level: 1,
          memLevel: 4
        },
        threshold: 1024
      },
      authentication: options.authentication !== false,
      jwtSecret: options.jwtSecret || 'change-me',
      rateLimiting: options.rateLimiting !== false,
      rateLimit: options.rateLimit || {
        points: 100,
        duration: 60
      },
      historyEnabled: options.historyEnabled !== false,
      historySize: options.historySize || 1000,
      ...options
    };
    
    this.server = null;
    this.wss = null;
    this.clients = new Map();
    this.rooms = new Map();
    this.namespaces = new Map();
    this.history = new EventHistory(this.config.historySize);
    
    // Rate limiter
    this.rateLimiter = new RateLimiterMemory({
      points: this.config.rateLimit.points,
      duration: this.config.rateLimit.duration
    });
    
    // Statistics
    this.stats = {
      connections: 0,
      disconnections: 0,
      messages: 0,
      errors: 0,
      broadcasts: 0,
      currentClients: 0,
      peakClients: 0
    };
    
    this.initialize();
  }

  initialize() {
    // Create HTTP(S) server
    if (this.config.ssl) {
      this.server = https.createServer({
        key: this.config.sslKey,
        cert: this.config.sslCert
      });
    } else {
      this.server = http.createServer();
    }
    
    // Create WebSocket server
    this.wss = new WebSocket.Server({
      server: this.server,
      maxPayload: 10 * 1024 * 1024, // 10MB
      perMessageDeflate: this.config.compression ? this.config.perMessageDeflate : false
    });
    
    // Set up event handlers
    this.setupEventHandlers();
    
    // Start heartbeat
    this.startHeartbeat();
    
    // Default namespace
    this.createNamespace('/');
  }

  setupEventHandlers() {
    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });
    
    this.wss.on('error', (error) => {
      logger.error('WebSocket server error:', error);
      this.stats.errors++;
    });
  }

  handleConnection(ws, req) {
    // Check max clients
    if (this.clients.size >= this.config.maxClients) {
      ws.close(1008, 'Max clients reached');
      return;
    }
    
    // Create client
    const clientId = crypto.randomBytes(16).toString('hex');
    const client = new WebSocketClient(ws, clientId);
    
    // Extract metadata
    client.metadata.ip = req.socket.remoteAddress;
    client.metadata.headers = req.headers;
    
    // Store client
    this.clients.set(clientId, client);
    
    // Update stats
    this.stats.connections++;
    this.stats.currentClients = this.clients.size;
    this.stats.peakClients = Math.max(this.stats.peakClients, this.clients.size);
    
    logger.info(`Client connected: ${clientId}`, {
      ip: client.metadata.ip,
      totalClients: this.clients.size
    });
    
    // Set up client event handlers
    ws.on('message', async (data) => {
      await this.handleMessage(client, data);
    });
    
    ws.on('close', (code, reason) => {
      this.handleDisconnect(client, code, reason);
    });
    
    ws.on('error', (error) => {
      logger.error(`Client error ${clientId}:`, error);
      this.stats.errors++;
    });
    
    ws.on('pong', () => {
      client.lastActivity = Date.now();
    });
    
    // Send welcome message
    const welcomeMessage = new EventMessage(
      MessageType.EVENT,
      EventType.CONNECTION,
      {
        clientId,
        timestamp: Date.now(),
        server: 'Otedama WebSocket Server'
      }
    );
    
    client.send(welcomeMessage.toJSON());
    
    // Emit connection event
    this.emit('client:connected', client);
  }

  async handleMessage(client, data) {
    try {
      // Rate limiting
      if (this.config.rateLimiting) {
        try {
          await this.rateLimiter.consume(client.id);
        } catch (rateLimitError) {
          const errorMessage = new EventMessage(
            MessageType.ERROR,
            'RATE_LIMIT',
            { message: 'Rate limit exceeded' }
          );
          client.send(errorMessage.toJSON());
          return;
        }
      }
      
      // Parse message
      const message = EventMessage.fromJSON(data);
      
      // Update activity
      client.lastActivity = Date.now();
      this.stats.messages++;
      
      // Handle message based on type
      switch (message.type) {
        case MessageType.AUTH:
          await this.handleAuth(client, message);
          break;
          
        case MessageType.SUBSCRIBE:
          await this.handleSubscribe(client, message);
          break;
          
        case MessageType.UNSUBSCRIBE:
          await this.handleUnsubscribe(client, message);
          break;
          
        case MessageType.EVENT:
          await this.handleEvent(client, message);
          break;
          
        case MessageType.HEARTBEAT:
          // Echo back heartbeat
          client.send(message.toJSON());
          break;
          
        default:
          logger.warn(`Unknown message type: ${message.type}`);
      }
      
      // Send acknowledgment if requested
      if (message.ack) {
        const ackMessage = new EventMessage(
          MessageType.ACK,
          message.event,
          { messageId: message.id }
        );
        client.send(ackMessage.toJSON());
      }
      
    } catch (error) {
      logger.error('Message handling error:', error);
      
      const errorMessage = new EventMessage(
        MessageType.ERROR,
        'MESSAGE_ERROR',
        { message: error.message }
      );
      client.send(errorMessage.toJSON());
    }
  }

  async handleAuth(client, message) {
    if (!this.config.authentication) {
      client.authenticated = true;
      return;
    }
    
    try {
      const { token } = message.data;
      const decoded = jwt.verify(token, this.config.jwtSecret);
      
      client.authenticated = true;
      client.user = decoded;
      
      const authMessage = new EventMessage(
        MessageType.EVENT,
        'AUTH_SUCCESS',
        { user: decoded }
      );
      client.send(authMessage.toJSON());
      
      logger.info(`Client authenticated: ${client.id}`, { user: decoded.id });
      
    } catch (error) {
      const errorMessage = new EventMessage(
        MessageType.ERROR,
        'AUTH_FAILED',
        { message: 'Invalid token' }
      );
      client.send(errorMessage.toJSON());
    }
  }

  async handleSubscribe(client, message) {
    const { room, event, namespace = '/' } = message.data;
    
    if (room) {
      this.joinRoom(client, room, namespace);
    }
    
    if (event) {
      client.subscriptions.add(event);
    }
    
    logger.debug(`Client ${client.id} subscribed`, { room, event, namespace });
  }

  async handleUnsubscribe(client, message) {
    const { room, event, namespace = '/' } = message.data;
    
    if (room) {
      this.leaveRoom(client, room, namespace);
    }
    
    if (event) {
      client.subscriptions.delete(event);
    }
    
    logger.debug(`Client ${client.id} unsubscribed`, { room, event, namespace });
  }

  async handleEvent(client, message) {
    // Check authentication for certain events
    if (this.requiresAuth(message.event) && !client.authenticated) {
      const errorMessage = new EventMessage(
        MessageType.ERROR,
        'AUTH_REQUIRED',
        { message: 'Authentication required' }
      );
      client.send(errorMessage.toJSON());
      return;
    }
    
    // Store in history
    if (this.config.historyEnabled) {
      this.history.add(message);
    }
    
    // Emit local event
    this.emit(`event:${message.event}`, {
      client,
      message
    });
    
    // Broadcast based on scope
    if (message.room) {
      this.broadcastToRoom(message.room, message, message.namespace, client);
    } else if (message.namespace && message.namespace !== '/') {
      this.broadcastToNamespace(message.namespace, message, client);
    } else {
      this.broadcast(message, client);
    }
  }

  handleDisconnect(client, code, reason) {
    // Leave all rooms
    for (const roomName of client.rooms) {
      const room = this.rooms.get(roomName);
      if (room) {
        room.leave(client);
        if (room.clients.size === 0) {
          this.rooms.delete(roomName);
        }
      }
    }
    
    // Remove client
    this.clients.delete(client.id);
    
    // Update stats
    this.stats.disconnections++;
    this.stats.currentClients = this.clients.size;
    
    logger.info(`Client disconnected: ${client.id}`, {
      code,
      reason,
      totalClients: this.clients.size
    });
    
    // Emit disconnection event
    this.emit('client:disconnected', client);
  }

  joinRoom(client, roomName, namespace = '/') {
    const fullRoomName = `${namespace}:${roomName}`;
    
    if (!this.rooms.has(fullRoomName)) {
      this.rooms.set(fullRoomName, new EventRoom(fullRoomName));
    }
    
    const room = this.rooms.get(fullRoomName);
    room.join(client);
    
    // Notify room members
    const joinMessage = new EventMessage(
      MessageType.EVENT,
      'ROOM_JOIN',
      {
        clientId: client.id,
        room: roomName,
        namespace
      }
    );
    
    room.broadcast(joinMessage.toJSON(), client);
  }

  leaveRoom(client, roomName, namespace = '/') {
    const fullRoomName = `${namespace}:${roomName}`;
    const room = this.rooms.get(fullRoomName);
    
    if (room) {
      room.leave(client);
      
      // Notify room members
      const leaveMessage = new EventMessage(
        MessageType.EVENT,
        'ROOM_LEAVE',
        {
          clientId: client.id,
          room: roomName,
          namespace
        }
      );
      
      room.broadcast(leaveMessage.toJSON(), client);
      
      // Delete empty rooms
      if (room.clients.size === 0) {
        this.rooms.delete(fullRoomName);
      }
    }
  }

  broadcast(message, sender = null) {
    this.stats.broadcasts++;
    
    for (const client of this.clients.values()) {
      if (client !== sender && client.ws.readyState === WebSocket.OPEN) {
        // Check if client is subscribed to this event
        if (message.event && client.subscriptions.size > 0) {
          if (!client.subscriptions.has(message.event) && !client.subscriptions.has('*')) {
            continue;
          }
        }
        
        client.send(message.toJSON());
      }
    }
  }

  broadcastToRoom(roomName, message, namespace = '/', sender = null) {
    const fullRoomName = `${namespace}:${roomName}`;
    const room = this.rooms.get(fullRoomName);
    
    if (room) {
      room.broadcast(message.toJSON(), sender);
    }
  }

  broadcastToNamespace(namespace, message, sender = null) {
    for (const client of this.clients.values()) {
      if (client !== sender && client.ws.readyState === WebSocket.OPEN) {
        // Check if client is in this namespace
        const inNamespace = Array.from(client.rooms).some(room => 
          room.startsWith(`${namespace}:`)
        );
        
        if (inNamespace) {
          client.send(message.toJSON());
        }
      }
    }
  }

  createNamespace(name) {
    if (!this.namespaces.has(name)) {
      this.namespaces.set(name, {
        name,
        rooms: new Set(),
        clients: new Set()
      });
    }
    return this.namespaces.get(name);
  }

  requiresAuth(eventType) {
    // Define which events require authentication
    const authRequired = [
      'ORDER_PLACE',
      'ORDER_CANCEL',
      'TRADE_EXECUTE',
      'PAYMENT_REQUEST'
    ];
    
    return authRequired.includes(eventType);
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [clientId, client] of this.clients) {
        // Check for timeout
        if (now - client.lastActivity > this.config.clientTimeout) {
          logger.info(`Client timeout: ${clientId}`);
          client.close(1001, 'Timeout');
          continue;
        }
        
        // Send ping
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, this.config.heartbeatInterval);
  }

  // Public API methods
  async start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, (error) => {
        if (error) {
          reject(error);
        } else {
          logger.info(`WebSocket server started on ${this.config.host}:${this.config.port}`);
          resolve();
        }
      });
    });
  }

  stop() {
    clearInterval(this.heartbeatInterval);
    
    // Close all client connections
    for (const client of this.clients.values()) {
      client.close(1001, 'Server shutting down');
    }
    
    // Close WebSocket server
    this.wss.close(() => {
      logger.info('WebSocket server closed');
    });
    
    // Close HTTP server
    this.server.close();
  }

  // Emit event to all clients
  emit(eventType, data) {
    const message = new EventMessage(
      MessageType.EVENT,
      eventType,
      data
    );
    
    this.broadcast(message);
    
    // Store in history
    if (this.config.historyEnabled) {
      this.history.add(message);
    }
    
    // Call parent emit for local events
    super.emit(eventType, data);
  }

  // Emit to specific room
  emitToRoom(room, eventType, data, namespace = '/') {
    const message = new EventMessage(
      MessageType.EVENT,
      eventType,
      data,
      { room, namespace }
    );
    
    this.broadcastToRoom(room, message, namespace);
  }

  // Get statistics
  getStatistics() {
    const roomStats = {};
    for (const [name, room] of this.rooms) {
      roomStats[name] = room.getInfo();
    }
    
    return {
      ...this.stats,
      rooms: roomStats,
      namespaces: Array.from(this.namespaces.keys()),
      uptime: Date.now() - this.startTime
    };
  }

  // Get connected clients
  getClients() {
    return Array.from(this.clients.values()).map(client => client.getInfo());
  }

  // Get event history
  getHistory(eventType = null, limit = 100) {
    if (eventType) {
      return this.history.getByType(eventType, limit);
    }
    return this.history.getRecent(limit);
  }
}

// Client library for browser/Node.js
class WebSocketEventClient extends EventEmitter {
  constructor(url, options = {}) {
    super();
    
    this.url = url;
    this.options = {
      reconnect: options.reconnect !== false,
      reconnectDelay: options.reconnectDelay || 1000,
      reconnectMaxDelay: options.reconnectMaxDelay || 30000,
      reconnectAttempts: options.reconnectAttempts || Infinity,
      heartbeatInterval: options.heartbeatInterval || 30000,
      ...options
    };
    
    this.ws = null;
    this.connected = false;
    this.authenticated = false;
    this.reconnectCount = 0;
    this.messageQueue = [];
    this.subscriptions = new Set();
    this.rooms = new Set();
  }

  connect() {
    try {
      this.ws = new WebSocket(this.url);
      
      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectCount = 0;
        
        // Authenticate if token provided
        if (this.options.token) {
          this.authenticate(this.options.token);
        }
        
        // Process queued messages
        while (this.messageQueue.length > 0) {
          const message = this.messageQueue.shift();
          this.send(message);
        }
        
        // Re-subscribe to previous subscriptions
        for (const subscription of this.subscriptions) {
          this.subscribe(subscription);
        }
        
        // Re-join rooms
        for (const room of this.rooms) {
          this.joinRoom(room);
        }
        
        this.emit('connected');
      });
      
      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          this.handleMessage(message);
        } catch (error) {
          logger.error('Failed to parse message:', error);
        }
      });
      
      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this.emit('disconnected', { code, reason });
        
        if (this.options.reconnect && this.reconnectCount < this.options.reconnectAttempts) {
          this.scheduleReconnect();
        }
      });
      
      this.ws.on('error', (error) => {
        this.emit('error', error);
      });
      
      // Start heartbeat
      this.startHeartbeat();
      
    } catch (error) {
      this.emit('error', error);
      
      if (this.options.reconnect) {
        this.scheduleReconnect();
      }
    }
  }

  authenticate(token) {
    const message = new EventMessage(
      MessageType.AUTH,
      null,
      { token }
    );
    
    this.send(message);
  }

  subscribe(event) {
    this.subscriptions.add(event);
    
    const message = new EventMessage(
      MessageType.SUBSCRIBE,
      null,
      { event }
    );
    
    this.send(message);
  }

  unsubscribe(event) {
    this.subscriptions.delete(event);
    
    const message = new EventMessage(
      MessageType.UNSUBSCRIBE,
      null,
      { event }
    );
    
    this.send(message);
  }

  joinRoom(room, namespace = '/') {
    this.rooms.add(`${namespace}:${room}`);
    
    const message = new EventMessage(
      MessageType.SUBSCRIBE,
      null,
      { room, namespace }
    );
    
    this.send(message);
  }

  leaveRoom(room, namespace = '/') {
    this.rooms.delete(`${namespace}:${room}`);
    
    const message = new EventMessage(
      MessageType.UNSUBSCRIBE,
      null,
      { room, namespace }
    );
    
    this.send(message);
  }

  emit(event, data) {
    if (event === 'error' || event === 'connected' || event === 'disconnected') {
      // Local events
      super.emit(event, data);
    } else {
      // Remote events
      const message = new EventMessage(
        MessageType.EVENT,
        event,
        data
      );
      
      this.send(message);
    }
  }

  send(message) {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }
  }

  handleMessage(message) {
    switch (message.type) {
      case MessageType.EVENT:
        super.emit(message.event, message.data);
        break;
        
      case MessageType.ERROR:
        super.emit('error', new Error(message.data.message));
        break;
        
      case MessageType.ACK:
        super.emit('ack', message.data);
        break;
    }
  }

  scheduleReconnect() {
    const delay = Math.min(
      this.options.reconnectDelay * Math.pow(2, this.reconnectCount),
      this.options.reconnectMaxDelay
    );
    
    this.reconnectCount++;
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.connected) {
        const message = new EventMessage(
          MessageType.HEARTBEAT,
          null,
          { timestamp: Date.now() }
        );
        
        this.send(message);
      }
    }, this.options.heartbeatInterval);
  }

  disconnect() {
    clearInterval(this.heartbeatInterval);
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.connected = false;
    this.messageQueue = [];
  }
}

module.exports = {
  WebSocketEventSystem,
  WebSocketEventClient,
  EventMessage,
  EventType,
  MessageType
};