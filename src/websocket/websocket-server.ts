/**
 * WebSocket server implementation for real-time communication
 * Following principles: efficient, scalable, minimal overhead
 */

import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { Logger } from '../logging/logger';
import { AuthManager } from '../auth/auth-manager';
import { RateLimiter } from '../security/rate-limiter';
import * as jwt from 'jsonwebtoken';

export interface WebSocketConfig {
  port: number;
  path?: string;
  perMessageDeflate?: boolean;
  maxPayload?: number;
  heartbeatInterval?: number;
  jwtSecret?: string;
}

export interface WSClient {
  id: string;
  ws: WebSocket;
  address?: string;
  authenticated: boolean;
  subscriptions: Set<string>;
  lastActivity: number;
  ip: string;
}

export interface WSMessage {
  type: string;
  data?: any;
  id?: string;
  error?: string;
}

export class PoolWebSocketServer extends EventEmitter {
  private wss: WebSocketServer;
  private clients = new Map<string, WSClient>();
  private logger: Logger;
  private heartbeatTimer?: NodeJS.Timeout;
  private subscriptions = new Map<string, Set<string>>(); // topic -> client ids

  constructor(
    private config: WebSocketConfig,
    private authManager?: AuthManager,
    private rateLimiter?: RateLimiter
  ) {
    super();
    this.logger = Logger.getInstance('WebSocketServer');
    
    this.wss = new WebSocketServer({
      port: config.port,
      path: config.path || '/ws',
      perMessageDeflate: config.perMessageDeflate !== false,
      maxPayload: config.maxPayload || 1024 * 1024, // 1MB
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress || '';
      
      // Rate limiting
      if (this.rateLimiter) {
        try {
          this.rateLimiter.checkConnection(ip);
        } catch (error) {
          ws.close(1008, 'Rate limit exceeded');
          return;
        }
      }

      const clientId = this.generateClientId();
      const client: WSClient = {
        id: clientId,
        ws,
        authenticated: false,
        subscriptions: new Set(),
        lastActivity: Date.now(),
        ip
      };

      this.clients.set(clientId, client);
      this.logger.info('WebSocket client connected', { clientId, ip });

      // Set up client handlers
      ws.on('message', (data) => {
        this.handleMessage(clientId, data);
      });

      ws.on('close', (code, reason) => {
        this.handleDisconnect(clientId, code, reason.toString());
      });

      ws.on('error', (error) => {
        this.logger.error('WebSocket error', error, { clientId });
      });

      ws.on('pong', () => {
        client.lastActivity = Date.now();
      });

      // Send welcome message
      this.sendToClient(clientId, {
        type: 'welcome',
        data: {
          clientId,
          serverTime: Date.now(),
          version: '1.0.0'
        }
      });
    });

    this.wss.on('error', (error) => {
      this.logger.error('WebSocket server error', error);
    });

    // Start heartbeat
    this.startHeartbeat();
  }

  private handleMessage(clientId: string, data: any): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.lastActivity = Date.now();

    try {
      const message: WSMessage = JSON.parse(data.toString());
      
      this.logger.debug('WebSocket message received', { 
        clientId, 
        type: message.type 
      });

      switch (message.type) {
        case 'auth':
          this.handleAuth(clientId, message);
          break;
        case 'subscribe':
          this.handleSubscribe(clientId, message);
          break;
        case 'unsubscribe':
          this.handleUnsubscribe(clientId, message);
          break;
        case 'ping':
          this.handlePing(clientId, message);
          break;
        default:
          this.emit('message', { clientId, message });
      }
    } catch (error) {
      this.sendError(clientId, 'Invalid message format', message.id);
    }
  }

  private async handleAuth(clientId: string, message: WSMessage): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { token } = message.data || {};
    
    if (!token || !this.config.jwtSecret) {
      this.sendError(clientId, 'Authentication required', message.id);
      return;
    }

    try {
      const decoded = jwt.verify(token, this.config.jwtSecret) as any;
      client.authenticated = true;
      client.address = decoded.address;

      this.sendToClient(clientId, {
        type: 'auth',
        data: { success: true, address: decoded.address },
        id: message.id
      });

      this.logger.info('WebSocket client authenticated', { 
        clientId, 
        address: decoded.address 
      });
    } catch (error) {
      this.sendError(clientId, 'Invalid authentication token', message.id);
    }
  }

  private handleSubscribe(clientId: string, message: WSMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { topics } = message.data || {};
    if (!topics || !Array.isArray(topics)) {
      this.sendError(clientId, 'Invalid subscription request', message.id);
      return;
    }

    const subscribedTopics: string[] = [];

    for (const topic of topics) {
      // Check if authentication required for topic
      if (this.requiresAuth(topic) && !client.authenticated) {
        continue;
      }

      // Add to client subscriptions
      client.subscriptions.add(topic);

      // Add to topic subscriptions
      if (!this.subscriptions.has(topic)) {
        this.subscriptions.set(topic, new Set());
      }
      this.subscriptions.get(topic)!.add(clientId);

      subscribedTopics.push(topic);
    }

    this.sendToClient(clientId, {
      type: 'subscribe',
      data: { topics: subscribedTopics },
      id: message.id
    });

    this.logger.debug('Client subscribed to topics', { 
      clientId, 
      topics: subscribedTopics 
    });
  }

  private handleUnsubscribe(clientId: string, message: WSMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const { topics } = message.data || {};
    if (!topics || !Array.isArray(topics)) {
      this.sendError(clientId, 'Invalid unsubscribe request', message.id);
      return;
    }

    const unsubscribedTopics: string[] = [];

    for (const topic of topics) {
      // Remove from client subscriptions
      if (client.subscriptions.has(topic)) {
        client.subscriptions.delete(topic);
        unsubscribedTopics.push(topic);

        // Remove from topic subscriptions
        const topicSubs = this.subscriptions.get(topic);
        if (topicSubs) {
          topicSubs.delete(clientId);
          if (topicSubs.size === 0) {
            this.subscriptions.delete(topic);
          }
        }
      }
    }

    this.sendToClient(clientId, {
      type: 'unsubscribe',
      data: { topics: unsubscribedTopics },
      id: message.id
    });
  }

  private handlePing(clientId: string, message: WSMessage): void {
    this.sendToClient(clientId, {
      type: 'pong',
      data: { timestamp: Date.now() },
      id: message.id
    });
  }

  private handleDisconnect(clientId: string, code: number, reason: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from all subscriptions
    for (const topic of client.subscriptions) {
      const topicSubs = this.subscriptions.get(topic);
      if (topicSubs) {
        topicSubs.delete(clientId);
        if (topicSubs.size === 0) {
          this.subscriptions.delete(topic);
        }
      }
    }

    this.clients.delete(clientId);
    this.logger.info('WebSocket client disconnected', { clientId, code, reason });
    this.emit('disconnect', { clientId, code, reason });
  }

  // Public methods for broadcasting
  broadcast(topic: string, data: any): void {
    const subscribers = this.subscriptions.get(topic);
    if (!subscribers || subscribers.size === 0) return;

    const message: WSMessage = {
      type: 'broadcast',
      data: {
        topic,
        payload: data,
        timestamp: Date.now()
      }
    };

    for (const clientId of subscribers) {
      this.sendToClient(clientId, message);
    }

    this.logger.debug('Broadcast message sent', { 
      topic, 
      subscribers: subscribers.size 
    });
  }

  broadcastToAll(data: any): void {
    const message: WSMessage = {
      type: 'broadcast',
      data: {
        topic: 'global',
        payload: data,
        timestamp: Date.now()
      }
    };

    for (const [clientId] of this.clients) {
      this.sendToClient(clientId, message);
    }
  }

  sendToAddress(address: string, data: any): void {
    for (const [clientId, client] of this.clients) {
      if (client.authenticated && client.address === address) {
        this.sendToClient(clientId, {
          type: 'direct',
          data
        });
      }
    }
  }

  private sendToClient(clientId: string, message: WSMessage): void {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return;

    try {
      client.ws.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error('Failed to send message to client', error, { clientId });
    }
  }

  private sendError(clientId: string, error: string, messageId?: string): void {
    this.sendToClient(clientId, {
      type: 'error',
      error,
      id: messageId
    });
  }

  private requiresAuth(topic: string): boolean {
    const authRequiredTopics = ['account', 'private', 'admin'];
    return authRequiredTopics.some(t => topic.startsWith(t));
  }

  private generateClientId(): string {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private startHeartbeat(): void {
    const interval = this.config.heartbeatInterval || 30000; // 30 seconds

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeout = interval * 2;

      for (const [clientId, client] of this.clients) {
        if (now - client.lastActivity > timeout) {
          client.ws.terminate();
          this.handleDisconnect(clientId, 1001, 'Heartbeat timeout');
        } else if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      }
    }, interval);
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.on('listening', () => {
        this.logger.info(`WebSocket server listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Close all client connections
    for (const [clientId, client] of this.clients) {
      client.ws.close(1001, 'Server shutting down');
    }

    return new Promise((resolve) => {
      this.wss.close(() => {
        this.logger.info('WebSocket server stopped');
        resolve();
      });
    });
  }

  getStats() {
    const stats = {
      totalClients: this.clients.size,
      authenticatedClients: 0,
      subscriptions: {} as Record<string, number>
    };

    for (const client of this.clients.values()) {
      if (client.authenticated) {
        stats.authenticatedClients++;
      }
    }

    for (const [topic, subscribers] of this.subscriptions) {
      stats.subscriptions[topic] = subscribers.size;
    }

    return stats;
  }
}

// WebSocket client for testing and monitoring
export class PoolWebSocketClient extends EventEmitter {
  private ws?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private messageQueue: WSMessage[] = [];
  private connected = false;

  constructor(
    private url: string,
    private options: {
      autoReconnect?: boolean;
      reconnectInterval?: number;
      maxReconnectAttempts?: number;
    } = {}
  ) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.connected = true;
        this.emit('connected');
        
        // Send queued messages
        while (this.messageQueue.length > 0) {
          const message = this.messageQueue.shift();
          if (message) this.send(message);
        }
        
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.emit('message', message);
        } catch (error) {
          this.emit('error', error);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.connected = false;
        this.emit('disconnected', { code, reason: reason.toString() });
        
        if (this.options.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });
    });
  }

  send(message: WSMessage): void {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }
  }

  subscribe(topics: string[]): void {
    this.send({
      type: 'subscribe',
      data: { topics }
    });
  }

  unsubscribe(topics: string[]): void {
    this.send({
      type: 'unsubscribe',
      data: { topics }
    });
  }

  authenticate(token: string): void {
    this.send({
      type: 'auth',
      data: { token }
    });
  }

  private scheduleReconnect(): void {
    const interval = this.options.reconnectInterval || 5000;
    
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Continue trying
      });
    }, interval);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }
}
