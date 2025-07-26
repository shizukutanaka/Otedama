/**
 * WebSocket Real-time Updates - Otedama
 * Provides real-time pool statistics and events via WebSocket
 * 
 * Design Principles:
 * - Carmack: Minimal latency, efficient binary protocols
 * - Martin: Clean event-driven architecture
 * - Pike: Simple subscription model
 */

import { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { RateLimiter } from '../core/rate-limiter.js';
import crypto from 'crypto';

const logger = createStructuredLogger('WebSocketRealtime');

/**
 * Message types
 */
const MESSAGE_TYPES = {
  // Client -> Server
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  PING: 'ping',
  AUTH: 'auth',
  
  // Server -> Client
  UPDATE: 'update',
  EVENT: 'event',
  ERROR: 'error',
  PONG: 'pong',
  AUTH_RESULT: 'auth_result'
};

/**
 * Subscription channels
 */
const CHANNELS = {
  STATS: 'stats',          // Pool statistics
  SHARES: 'shares',        // Share submissions
  BLOCKS: 'blocks',        // Block discoveries
  MINERS: 'miners',        // Miner updates
  PAYMENTS: 'payments',    // Payment events
  NETWORK: 'network',      // Network status
  ALERTS: 'alerts'         // System alerts
};

/**
 * WebSocket client connection
 */
class WSClient {
  constructor(ws, id) {
    this.ws = ws;
    this.id = id;
    this.subscriptions = new Set();
    this.authenticated = false;
    this.address = null;
    this.lastActivity = Date.now();
    this.messageCount = 0;
  }
  
  send(type, data) {
    if (this.ws.readyState === this.ws.OPEN) {
      try {
        this.ws.send(JSON.stringify({
          type,
          data,
          timestamp: Date.now()
        }));
        this.messageCount++;
        return true;
      } catch (error) {
        logger.error('Failed to send message to client', {
          clientId: this.id,
          error: error.message
        });
        return false;
      }
    }
    return false;
  }
  
  subscribe(channel) {
    this.subscriptions.add(channel);
  }
  
  unsubscribe(channel) {
    this.subscriptions.delete(channel);
  }
  
  isSubscribed(channel) {
    return this.subscriptions.has(channel);
  }
  
  close() {
    this.ws.close();
  }
}

/**
 * WebSocket Real-time Server
 */
export class WebSocketRealtime extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      port: config.port || 8082,
      host: config.host || '0.0.0.0',
      path: config.path || '/ws',
      maxClients: config.maxClients || 1000,
      pingInterval: config.pingInterval || 30000,
      authRequired: config.authRequired || false,
      rateLimitPerMinute: config.rateLimitPerMinute || 60,
      compressionThreshold: config.compressionThreshold || 1024,
      ...config
    };
    
    // State
    this.clients = new Map();
    this.channels = new Map();
    this.wss = null;
    this.running = false;
    
    // Rate limiting
    this.rateLimiter = new RateLimiter({
      windowMs: 60000,
      max: this.config.rateLimitPerMinute
    });
    
    // Statistics
    this.stats = {
      totalConnections: 0,
      messagesOut: 0,
      messagesIn: 0,
      bytesSent: 0,
      bytesReceived: 0
    };
    
    // Update intervals
    this.updateIntervals = new Map();
    
    // Initialize channels
    this.initializeChannels();
    
    this.logger = logger;
  }
  
  /**
   * Initialize channels
   */
  initializeChannels() {
    Object.values(CHANNELS).forEach(channel => {
      this.channels.set(channel, new Set());
    });
  }
  
  /**
   * Start WebSocket server
   */
  async start(server = null) {
    if (this.running) return;
    
    const wsOptions = {
      perMessageDeflate: {
        zlibDeflateOptions: {
          chunkSize: 1024,
          memLevel: 7,
          level: 3
        },
        zlibInflateOptions: {
          chunkSize: 10 * 1024
        },
        threshold: this.config.compressionThreshold
      }
    };
    
    if (server) {
      // Attach to existing HTTP server
      this.wss = new WebSocketServer({
        server,
        path: this.config.path,
        ...wsOptions
      });
    } else {
      // Create standalone server
      this.wss = new WebSocketServer({
        port: this.config.port,
        host: this.config.host,
        ...wsOptions
      });
    }
    
    this.setupEventHandlers();
    this.startUpdateIntervals();
    this.startPingInterval();
    
    this.running = true;
    
    this.logger.info('WebSocket server started', {
      port: this.config.port,
      host: this.config.host,
      path: this.config.path
    });
  }
  
  /**
   * Stop WebSocket server
   */
  async stop() {
    if (!this.running) return;
    
    // Stop intervals
    this.stopUpdateIntervals();
    
    // Close all client connections
    for (const client of this.clients.values()) {
      client.close();
    }
    
    // Close server
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.running = false;
        this.logger.info('WebSocket server stopped');
        resolve();
      });
    });
  }
  
  /**
   * Setup WebSocket event handlers
   */
  setupEventHandlers() {
    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });
    
    this.wss.on('error', (error) => {
      this.logger.error('WebSocket server error:', error);
    });
  }
  
  /**
   * Handle new connection
   */
  handleConnection(ws, req) {
    const clientId = crypto.randomUUID();
    const client = new WSClient(ws, clientId);
    
    // Check connection limit
    if (this.clients.size >= this.config.maxClients) {
      client.send(MESSAGE_TYPES.ERROR, {
        code: 'MAX_CLIENTS',
        message: 'Maximum client limit reached'
      });
      ws.close();
      return;
    }
    
    // Add client
    this.clients.set(clientId, client);
    this.stats.totalConnections++;
    
    // Setup client handlers
    ws.on('message', (data) => {
      this.handleMessage(client, data);
    });
    
    ws.on('close', () => {
      this.handleDisconnect(client);
    });
    
    ws.on('error', (error) => {
      this.logger.error('Client error:', {
        clientId,
        error: error.message
      });
    });
    
    // Send welcome message
    client.send(MESSAGE_TYPES.UPDATE, {
      type: 'welcome',
      clientId,
      channels: Object.values(CHANNELS),
      authRequired: this.config.authRequired
    });
    
    this.logger.info('Client connected', {
      clientId,
      ip: req.socket.remoteAddress
    });
    
    this.emit('client:connected', { clientId });
  }
  
  /**
   * Handle client message
   */
  handleMessage(client, data) {
    try {
      // Rate limiting
      if (!this.rateLimiter.try(client.id)) {
        client.send(MESSAGE_TYPES.ERROR, {
          code: 'RATE_LIMIT',
          message: 'Rate limit exceeded'
        });
        return;
      }
      
      // Parse message
      const message = JSON.parse(data);
      this.stats.messagesIn++;
      this.stats.bytesReceived += data.length;
      
      // Update activity
      client.lastActivity = Date.now();
      
      // Handle message types
      switch (message.type) {
        case MESSAGE_TYPES.SUBSCRIBE:
          this.handleSubscribe(client, message.data);
          break;
          
        case MESSAGE_TYPES.UNSUBSCRIBE:
          this.handleUnsubscribe(client, message.data);
          break;
          
        case MESSAGE_TYPES.PING:
          this.handlePing(client);
          break;
          
        case MESSAGE_TYPES.AUTH:
          this.handleAuth(client, message.data);
          break;
          
        default:
          client.send(MESSAGE_TYPES.ERROR, {
            code: 'UNKNOWN_MESSAGE',
            message: `Unknown message type: ${message.type}`
          });
      }
      
    } catch (error) {
      this.logger.error('Failed to handle message:', {
        clientId: client.id,
        error: error.message
      });
      
      client.send(MESSAGE_TYPES.ERROR, {
        code: 'INVALID_MESSAGE',
        message: 'Invalid message format'
      });
    }
  }
  
  /**
   * Handle subscribe request
   */
  handleSubscribe(client, data) {
    const { channels } = data;
    
    if (!Array.isArray(channels)) {
      client.send(MESSAGE_TYPES.ERROR, {
        code: 'INVALID_CHANNELS',
        message: 'Channels must be an array'
      });
      return;
    }
    
    // Check auth for protected channels
    const protectedChannels = [CHANNELS.PAYMENTS, CHANNELS.ALERTS];
    const needsAuth = channels.some(ch => protectedChannels.includes(ch));
    
    if (needsAuth && this.config.authRequired && !client.authenticated) {
      client.send(MESSAGE_TYPES.ERROR, {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required for protected channels'
      });
      return;
    }
    
    // Subscribe to channels
    const subscribed = [];
    
    for (const channel of channels) {
      if (Object.values(CHANNELS).includes(channel)) {
        client.subscribe(channel);
        this.channels.get(channel)?.add(client.id);
        subscribed.push(channel);
      }
    }
    
    client.send(MESSAGE_TYPES.UPDATE, {
      type: 'subscribed',
      channels: subscribed
    });
    
    // Send initial data for subscribed channels
    this.sendInitialData(client, subscribed);
  }
  
  /**
   * Handle unsubscribe request
   */
  handleUnsubscribe(client, data) {
    const { channels } = data;
    
    if (!Array.isArray(channels)) {
      client.send(MESSAGE_TYPES.ERROR, {
        code: 'INVALID_CHANNELS',
        message: 'Channels must be an array'
      });
      return;
    }
    
    // Unsubscribe from channels
    const unsubscribed = [];
    
    for (const channel of channels) {
      if (client.isSubscribed(channel)) {
        client.unsubscribe(channel);
        this.channels.get(channel)?.delete(client.id);
        unsubscribed.push(channel);
      }
    }
    
    client.send(MESSAGE_TYPES.UPDATE, {
      type: 'unsubscribed',
      channels: unsubscribed
    });
  }
  
  /**
   * Handle ping
   */
  handlePing(client) {
    client.send(MESSAGE_TYPES.PONG, {
      timestamp: Date.now()
    });
  }
  
  /**
   * Handle authentication
   */
  async handleAuth(client, data) {
    const { address, signature } = data;
    
    if (!address || !signature) {
      client.send(MESSAGE_TYPES.AUTH_RESULT, {
        success: false,
        error: 'Missing address or signature'
      });
      return;
    }
    
    // Verify signature (simplified - in production use proper auth)
    const message = `Authenticate WebSocket: ${client.id}`;
    const verified = await this.verifySignature(address, message, signature);
    
    if (verified) {
      client.authenticated = true;
      client.address = address;
      
      client.send(MESSAGE_TYPES.AUTH_RESULT, {
        success: true,
        address
      });
      
      this.logger.info('Client authenticated', {
        clientId: client.id,
        address
      });
    } else {
      client.send(MESSAGE_TYPES.AUTH_RESULT, {
        success: false,
        error: 'Invalid signature'
      });
    }
  }
  
  /**
   * Handle client disconnect
   */
  handleDisconnect(client) {
    // Remove from all channels
    for (const channel of client.subscriptions) {
      this.channels.get(channel)?.delete(client.id);
    }
    
    // Remove client
    this.clients.delete(client.id);
    
    this.logger.info('Client disconnected', {
      clientId: client.id,
      duration: Date.now() - client.lastActivity
    });
    
    this.emit('client:disconnected', { clientId: client.id });
  }
  
  /**
   * Send initial data for channels
   */
  sendInitialData(client, channels) {
    const pool = this.components?.get('pool');
    
    for (const channel of channels) {
      switch (channel) {
        case CHANNELS.STATS:
          if (pool) {
            client.send(MESSAGE_TYPES.UPDATE, {
              channel: CHANNELS.STATS,
              data: pool.getStats()
            });
          }
          break;
          
        case CHANNELS.MINERS:
          if (pool && client.authenticated) {
            const minerData = this.getMinerData(client.address);
            if (minerData) {
              client.send(MESSAGE_TYPES.UPDATE, {
                channel: CHANNELS.MINERS,
                data: minerData
              });
            }
          }
          break;
      }
    }
  }
  
  /**
   * Broadcast to channel
   */
  broadcast(channel, data) {
    const channelClients = this.channels.get(channel);
    if (!channelClients) return;
    
    let sent = 0;
    const message = JSON.stringify({
      type: MESSAGE_TYPES.UPDATE,
      channel,
      data,
      timestamp: Date.now()
    });
    
    for (const clientId of channelClients) {
      const client = this.clients.get(clientId);
      if (client && client.ws.readyState === client.ws.OPEN) {
        try {
          client.ws.send(message);
          sent++;
          this.stats.messagesOut++;
          this.stats.bytesSent += message.length;
        } catch (error) {
          this.logger.error('Broadcast failed:', {
            clientId,
            channel,
            error: error.message
          });
        }
      }
    }
    
    return sent;
  }
  
  /**
   * Send event to specific clients
   */
  sendEvent(event, data, filter = null) {
    let sent = 0;
    
    for (const [clientId, client] of this.clients) {
      // Apply filter if provided
      if (filter && !filter(client)) continue;
      
      if (client.send(MESSAGE_TYPES.EVENT, { event, data })) {
        sent++;
      }
    }
    
    return sent;
  }
  
  /**
   * Start update intervals
   */
  startUpdateIntervals() {
    // Pool statistics update
    this.updateIntervals.set('stats', setInterval(() => {
      const pool = this.components?.get('pool');
      if (pool) {
        this.broadcast(CHANNELS.STATS, pool.getStats());
      }
    }, 5000)); // Every 5 seconds
    
    // Network status update
    this.updateIntervals.set('network', setInterval(() => {
      const networkStatus = this.getNetworkStatus();
      this.broadcast(CHANNELS.NETWORK, networkStatus);
    }, 10000)); // Every 10 seconds
  }
  
  /**
   * Stop update intervals
   */
  stopUpdateIntervals() {
    for (const [name, interval] of this.updateIntervals) {
      clearInterval(interval);
    }
    this.updateIntervals.clear();
  }
  
  /**
   * Start ping interval
   */
  startPingInterval() {
    this.updateIntervals.set('ping', setInterval(() => {
      const now = Date.now();
      const timeout = this.config.pingInterval * 3; // 3 missed pings
      
      for (const [clientId, client] of this.clients) {
        if (now - client.lastActivity > timeout) {
          this.logger.info('Client timeout', { clientId });
          client.close();
        }
      }
    }, this.config.pingInterval));
  }
  
  /**
   * Register component
   */
  registerComponent(name, component) {
    if (!this.components) {
      this.components = new Map();
    }
    
    this.components.set(name, component);
    
    // Setup component listeners
    switch (name) {
      case 'pool':
        this.setupPoolListeners(component);
        break;
        
      case 'paymentProcessor':
        this.setupPaymentListeners(component);
        break;
    }
  }
  
  /**
   * Setup pool listeners
   */
  setupPoolListeners(pool) {
    // Share events
    pool.on('share:accepted', (share) => {
      this.broadcast(CHANNELS.SHARES, {
        type: 'accepted',
        minerId: share.minerId,
        difficulty: share.difficulty,
        timestamp: share.timestamp
      });
    });
    
    pool.on('share:rejected', (share) => {
      this.broadcast(CHANNELS.SHARES, {
        type: 'rejected',
        minerId: share.minerId,
        reason: share.reason,
        timestamp: Date.now()
      });
    });
    
    // Block events
    pool.on('block:found', (block) => {
      this.broadcast(CHANNELS.BLOCKS, {
        type: 'found',
        height: block.height,
        hash: block.hash,
        minerId: block.minerId,
        reward: block.reward,
        timestamp: block.timestamp
      });
    });
    
    // Miner events
    pool.on('miner:connected', ({ id, address }) => {
      // Send to miner's address subscribers
      this.sendEvent('miner:connected', { id }, 
        client => client.authenticated && client.address === address
      );
    });
    
    pool.on('miner:disconnected', ({ id, address }) => {
      // Send to miner's address subscribers
      this.sendEvent('miner:disconnected', { id },
        client => client.authenticated && client.address === address
      );
    });
  }
  
  /**
   * Setup payment listeners
   */
  setupPaymentListeners(paymentProcessor) {
    paymentProcessor.on('payment:sent', ({ address, amount, txid }) => {
      // Send to specific miner
      this.sendEvent('payment:sent', { amount, txid },
        client => client.authenticated && client.address === address
      );
      
      // Broadcast summary to payments channel
      this.broadcast(CHANNELS.PAYMENTS, {
        type: 'sent',
        count: 1,
        total: amount,
        timestamp: Date.now()
      });
    });
  }
  
  /**
   * Helper methods
   */
  
  async verifySignature(address, message, signature) {
    // Simplified verification - implement proper crypto in production
    return true;
  }
  
  getMinerData(address) {
    const pool = this.components?.get('pool');
    if (!pool) return null;
    
    // Find miner by address
    for (const [id, miner] of pool.miners) {
      if (miner.address === address) {
        return {
          id,
          hashrate: miner.hashrate,
          shares: miner.shares,
          difficulty: miner.difficulty,
          connected: miner.connected
        };
      }
    }
    
    return null;
  }
  
  getNetworkStatus() {
    const pool = this.components?.get('pool');
    
    return {
      connected: this.clients.size,
      subscriptions: {
        stats: this.channels.get(CHANNELS.STATS)?.size || 0,
        shares: this.channels.get(CHANNELS.SHARES)?.size || 0,
        blocks: this.channels.get(CHANNELS.BLOCKS)?.size || 0,
        miners: this.channels.get(CHANNELS.MINERS)?.size || 0,
        payments: this.channels.get(CHANNELS.PAYMENTS)?.size || 0,
        network: this.channels.get(CHANNELS.NETWORK)?.size || 0,
        alerts: this.channels.get(CHANNELS.ALERTS)?.size || 0
      },
      pool: {
        miners: pool?.miners.size || 0,
        hashrate: pool?.metrics.hashrate || 0,
        difficulty: pool?.config.difficulty || 0
      }
    };
  }
  
  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeClients: this.clients.size,
      channels: Object.fromEntries(
        Array.from(this.channels.entries()).map(([name, clients]) => 
          [name, clients.size]
        )
      )
    };
  }
}

// Export components
export {
  MESSAGE_TYPES,
  CHANNELS
};

export default WebSocketRealtime;