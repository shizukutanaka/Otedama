/**
 * WebSocket API - Real-time API System
 * 
 * Design Philosophy:
 * - Carmack: Efficient real-time communication, minimal latency
 * - Martin: Clear message types, clean protocol design
 * - Pike: Simple subscription model, intuitive API
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server } from 'http';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import * as jwt from 'jsonwebtoken';
import { UnifiedLogger } from '../logging/unified-logger';
import { UnifiedMetrics } from '../metrics/unified-metrics';
import { UnifiedSecurity } from '../security/unified-security';
import { APIRateLimiter } from '../api/rate-limiter';

export interface WebSocketMessage {
  id: string;
  type: MessageType;
  timestamp: Date;
  data?: any;
  error?: string;
}

export interface WebSocketClient {
  id: string;
  socket: WebSocket;
  isAuthenticated: boolean;
  userId?: string;
  subscriptions: Set<string>;
  lastPing: Date;
  connectionTime: Date;
  messageCount: number;
  metadata: Record<string, any>;
}

export interface Subscription {
  id: string;
  clientId: string;
  channel: string;
  filters?: SubscriptionFilter[];
  createdAt: Date;
}

export interface SubscriptionFilter {
  field: string;
  operator: 'equals' | 'contains' | 'greater_than' | 'less_than';
  value: any;
}

export type MessageType = 
  | 'ping'
  | 'pong'
  | 'auth'
  | 'auth_success'
  | 'auth_error'
  | 'subscribe'
  | 'unsubscribe'
  | 'subscription_success'
  | 'subscription_error'
  | 'event'
  | 'error'
  | 'rate_limit';

export type EventChannel = 
  | 'pool.stats'
  | 'pool.blocks'
  | 'pool.shares'
  | 'pool.payouts'
  | 'miner.stats'
  | 'miner.workers'
  | 'system.alerts'
  | 'system.status';

export interface WebSocketConfig {
  port: number;
  jwtSecret: string;
  pingInterval: number;
  authTimeout: number;
  maxConnections: number;
  enableRateLimit: boolean;
  rateLimitRules?: any[];
}

export class WebSocketAPI extends EventEmitter {
  private server: Server;
  private wss: WebSocketServer;
  private clients: Map<string, WebSocketClient> = new Map();
  private subscriptions: Map<string, Subscription> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;
  private rateLimiter: APIRateLimiter;

  constructor(
    private logger: UnifiedLogger,
    private metrics: UnifiedMetrics,
    private security: UnifiedSecurity,
    private config: WebSocketConfig
  ) {
    super();
    
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server });
    this.rateLimiter = new APIRateLimiter(logger, metrics);
    
    this.setupWebSocketServer();
    this.setupPingInterval();
  }

  public async start(): Promise<void> {
    this.logger.info('Starting WebSocket API...');

    await this.rateLimiter.start();

    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          this.logger.info(`WebSocket server started on port ${this.config.port}`);
          resolve();
        }
      });
    });
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping WebSocket API...');

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.socket.close(1000, 'Server shutdown');
    }

    // Stop rate limiter
    await this.rateLimiter.stop();

    // Close WebSocket server
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.server.close(() => {
          this.logger.info('WebSocket API stopped');
          resolve();
        });
      });
    });
  }

  // Broadcasting methods
  public broadcast(channel: EventChannel, data: any, filters?: SubscriptionFilter[]): void {
    const message: WebSocketMessage = {
      id: uuidv4(),
      type: 'event',
      timestamp: new Date(),
      data: {
        channel,
        payload: data
      }
    };

    const subscribedClients = Array.from(this.subscriptions.values())
      .filter(sub => 
        sub.channel === channel && 
        this.passesFilters(data, filters || sub.filters || [])
      )
      .map(sub => this.clients.get(sub.clientId))
      .filter(Boolean) as WebSocketClient[];

    for (const client of subscribedClients) {
      this.sendMessage(client, message);
    }

    this.emit('broadcast', { channel, data, clientCount: subscribedClients.length });
  }

  public broadcastToUser(userId: string, data: any): void {
    const userClients = Array.from(this.clients.values())
      .filter(client => client.userId === userId);

    const message: WebSocketMessage = {
      id: uuidv4(),
      type: 'event',
      timestamp: new Date(),
      data
    };

    for (const client of userClients) {
      this.sendMessage(client, message);
    }
  }

  public broadcastPoolStats(stats: any): void {
    this.broadcast('pool.stats', stats);
  }

  public broadcastNewBlock(block: any): void {
    this.broadcast('pool.blocks', block);
  }

  public broadcastNewShare(share: any): void {
    this.broadcast('pool.shares', share);
  }

  public broadcastPayout(payout: any): void {
    this.broadcast('pool.payouts', payout);
  }

  public broadcastMinerStats(minerId: string, stats: any): void {
    this.broadcast('miner.stats', { minerId, ...stats });
  }

  public broadcastSystemAlert(alert: any): void {
    this.broadcast('system.alerts', alert);
  }

  // Client management
  public getConnectedClients(): WebSocketClient[] {
    return Array.from(this.clients.values());
  }

  public getClientCount(): number {
    return this.clients.size;
  }

  public getAuthenticatedClientCount(): number {
    return Array.from(this.clients.values()).filter(c => c.isAuthenticated).length;
  }

  public getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  public getClientsByChannel(channel: string): WebSocketClient[] {
    const subscribedClientIds = Array.from(this.subscriptions.values())
      .filter(sub => sub.channel === channel)
      .map(sub => sub.clientId);

    return subscribedClientIds
      .map(id => this.clients.get(id))
      .filter(Boolean) as WebSocketClient[];
  }

  public disconnectClient(clientId: string, reason?: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.socket.close(1000, reason || 'Disconnected by server');
    }
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (socket, request) => {
      this.handleNewConnection(socket, request);
    });

    this.wss.on('error', (error) => {
      this.logger.error('WebSocket server error:', error);
    });
  }

  private handleNewConnection(socket: WebSocket, request: any): void {
    // Check connection limit
    if (this.clients.size >= this.config.maxConnections) {
      socket.close(1008, 'Maximum connections exceeded');
      return;
    }

    // Check rate limit
    if (this.config.enableRateLimit) {
      const rateLimitResult = this.rateLimiter.checkRateLimit(request);
      if (!rateLimitResult.allowed) {
        socket.close(1008, 'Rate limit exceeded');
        return;
      }
    }

    const clientId = uuidv4();
    const client: WebSocketClient = {
      id: clientId,
      socket,
      isAuthenticated: false,
      subscriptions: new Set(),
      lastPing: new Date(),
      connectionTime: new Date(),
      messageCount: 0,
      metadata: {
        ip: this.getClientIP(request),
        userAgent: request.headers['user-agent']
      }
    };

    this.clients.set(clientId, client);
    this.logger.info(`New WebSocket connection: ${clientId}`, {
      ip: client.metadata.ip,
      totalConnections: this.clients.size
    });

    // Set up socket event handlers
    socket.on('message', (data) => {
      this.handleMessage(client, data);
    });

    socket.on('close', (code, reason) => {
      this.handleDisconnection(client, code, reason);
    });

    socket.on('error', (error) => {
      this.logger.error(`WebSocket error for client ${clientId}:`, error);
    });

    socket.on('pong', () => {
      client.lastPing = new Date();
    });

    // Send welcome message
    this.sendMessage(client, {
      id: uuidv4(),
      type: 'ping',
      timestamp: new Date(),
      data: { message: 'Connected to Otedama Pool WebSocket API' }
    });

    // Set authentication timeout
    setTimeout(() => {
      if (!client.isAuthenticated && this.clients.has(clientId)) {
        socket.close(1002, 'Authentication timeout');
      }
    }, this.config.authTimeout);

    this.emit('clientConnected', client);
    this.updateMetrics();
  }

  private handleMessage(client: WebSocketClient, data: any): void {
    try {
      client.messageCount++;
      const message = JSON.parse(data.toString());

      this.logger.debug(`Received message from ${client.id}:`, message.type);

      switch (message.type) {
        case 'ping':
          this.handlePing(client, message);
          break;
        case 'auth':
          this.handleAuthentication(client, message);
          break;
        case 'subscribe':
          this.handleSubscription(client, message);
          break;
        case 'unsubscribe':
          this.handleUnsubscription(client, message);
          break;
        default:
          this.sendError(client, `Unknown message type: ${message.type}`);
      }
    } catch (error) {
      this.logger.error(`Error handling message from ${client.id}:`, error);
      this.sendError(client, 'Invalid message format');
    }
  }

  private handlePing(client: WebSocketClient, message: any): void {
    this.sendMessage(client, {
      id: uuidv4(),
      type: 'pong',
      timestamp: new Date(),
      data: { messageId: message.id }
    });
  }

  private async handleAuthentication(client: WebSocketClient, message: any): Promise<void> {
    try {
      const { token } = message.data;
      if (!token) {
        throw new Error('Token required');
      }

      const decoded = jwt.verify(token, this.config.jwtSecret) as any;
      client.isAuthenticated = true;
      client.userId = decoded.address || decoded.userId;

      this.sendMessage(client, {
        id: uuidv4(),
        type: 'auth_success',
        timestamp: new Date(),
        data: { userId: client.userId }
      });

      this.logger.info(`Client ${client.id} authenticated as ${client.userId}`);
      this.emit('clientAuthenticated', client);

    } catch (error) {
      this.sendMessage(client, {
        id: uuidv4(),
        type: 'auth_error',
        timestamp: new Date(),
        error: 'Authentication failed'
      });

      this.logger.warn(`Authentication failed for client ${client.id}:`, error);
    }
  }

  private handleSubscription(client: WebSocketClient, message: any): void {
    try {
      const { channel, filters } = message.data;
      
      if (!this.isValidChannel(channel)) {
        throw new Error(`Invalid channel: ${channel}`);
      }

      const subscriptionId = uuidv4();
      const subscription: Subscription = {
        id: subscriptionId,
        clientId: client.id,
        channel,
        filters: filters || [],
        createdAt: new Date()
      };

      this.subscriptions.set(subscriptionId, subscription);
      client.subscriptions.add(subscriptionId);

      this.sendMessage(client, {
        id: uuidv4(),
        type: 'subscription_success',
        timestamp: new Date(),
        data: { subscriptionId, channel }
      });

      this.logger.debug(`Client ${client.id} subscribed to ${channel}`);
      this.emit('clientSubscribed', { client, subscription });

    } catch (error) {
      this.sendMessage(client, {
        id: uuidv4(),
        type: 'subscription_error',
        timestamp: new Date(),
        error: error instanceof Error ? error.message : 'Subscription failed'
      });
    }
  }

  private handleUnsubscription(client: WebSocketClient, message: any): void {
    const { subscriptionId, channel } = message.data;

    if (subscriptionId) {
      const subscription = this.subscriptions.get(subscriptionId);
      if (subscription && subscription.clientId === client.id) {
        this.subscriptions.delete(subscriptionId);
        client.subscriptions.delete(subscriptionId);
        this.logger.debug(`Client ${client.id} unsubscribed from ${subscription.channel}`);
      }
    } else if (channel) {
      // Unsubscribe from all subscriptions for the channel
      const toRemove = Array.from(this.subscriptions.entries())
        .filter(([, sub]) => sub.clientId === client.id && sub.channel === channel);

      for (const [id] of toRemove) {
        this.subscriptions.delete(id);
        client.subscriptions.delete(id);
      }
      this.logger.debug(`Client ${client.id} unsubscribed from all ${channel} subscriptions`);
    }
  }

  private handleDisconnection(client: WebSocketClient, code: number, reason: Buffer): void {
    // Clean up client subscriptions
    for (const subscriptionId of client.subscriptions) {
      this.subscriptions.delete(subscriptionId);
    }

    this.clients.delete(client.id);

    this.logger.info(`Client ${client.id} disconnected`, {
      code,
      reason: reason.toString(),
      duration: Date.now() - client.connectionTime.getTime(),
      messageCount: client.messageCount
    });

    this.emit('clientDisconnected', { client, code, reason });
    this.updateMetrics();
  }

  private sendMessage(client: WebSocketClient, message: WebSocketMessage): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      try {
        client.socket.send(JSON.stringify(message));
      } catch (error) {
        this.logger.error(`Error sending message to ${client.id}:`, error);
      }
    }
  }

  private sendError(client: WebSocketClient, errorMessage: string): void {
    this.sendMessage(client, {
      id: uuidv4(),
      type: 'error',
      timestamp: new Date(),
      error: errorMessage
    });
  }

  private setupPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - this.config.pingInterval * 2);

      for (const [clientId, client] of this.clients.entries()) {
        if (client.lastPing < staleThreshold) {
          this.logger.warn(`Client ${clientId} appears stale, disconnecting`);
          client.socket.close(1000, 'Ping timeout');
        } else if (client.socket.readyState === WebSocket.OPEN) {
          client.socket.ping();
        }
      }
    }, this.config.pingInterval);
  }

  private passesFilters(data: any, filters: SubscriptionFilter[]): boolean {
    if (filters.length === 0) {
      return true;
    }

    return filters.every(filter => {
      const value = this.getNestedValue(data, filter.field);
      
      switch (filter.operator) {
        case 'equals':
          return value === filter.value;
        case 'contains':
          return typeof value === 'string' && value.includes(filter.value);
        case 'greater_than':
          return typeof value === 'number' && value > filter.value;
        case 'less_than':
          return typeof value === 'number' && value < filter.value;
        default:
          return false;
      }
    });
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  private isValidChannel(channel: string): boolean {
    const validChannels: EventChannel[] = [
      'pool.stats',
      'pool.blocks',
      'pool.shares',
      'pool.payouts',
      'miner.stats',
      'miner.workers',
      'system.alerts',
      'system.status'
    ];
    
    return validChannels.includes(channel as EventChannel);
  }

  private getClientIP(request: any): string {
    return request.socket?.remoteAddress ||
           request.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
           '0.0.0.0';
  }

  private updateMetrics(): void {
    if (this.metrics) {
      this.metrics.updateGauge('websocket_connections_total', this.clients.size);
      this.metrics.updateGauge('websocket_authenticated_connections', this.getAuthenticatedClientCount());
      this.metrics.updateGauge('websocket_subscriptions_total', this.subscriptions.size);
    }
  }

  // Statistics and monitoring
  public getStats(): {
    connections: {
      total: number;
      authenticated: number;
      byChannel: Record<string, number>;
    };
    subscriptions: {
      total: number;
      byChannel: Record<string, number>;
    };
    messages: {
      totalSent: number;
      totalReceived: number;
    };
  } {
    const subscriptionsByChannel = {} as Record<string, number>;
    for (const subscription of this.subscriptions.values()) {
      subscriptionsByChannel[subscription.channel] = (subscriptionsByChannel[subscription.channel] || 0) + 1;
    }

    const connectionsByChannel = {} as Record<string, number>;
    for (const channel of Object.keys(subscriptionsByChannel)) {
      connectionsByChannel[channel] = this.getClientsByChannel(channel).length;
    }

    const totalReceived = Array.from(this.clients.values())
      .reduce((sum, client) => sum + client.messageCount, 0);

    return {
      connections: {
        total: this.clients.size,
        authenticated: this.getAuthenticatedClientCount(),
        byChannel: connectionsByChannel
      },
      subscriptions: {
        total: this.subscriptions.size,
        byChannel: subscriptionsByChannel
      },
      messages: {
        totalSent: 0, // Would need to track this separately
        totalReceived
      }
    };
  }
}