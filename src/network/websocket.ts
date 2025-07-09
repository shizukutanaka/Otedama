// WebSocket support for real-time communication (Pike simplicity)
import * as WebSocket from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../logging/logger';
import { AuthSystem } from '../security/auth';

export interface WebSocketMessage {
  type: string;
  data: any;
  id?: string;
}

export interface WebSocketClient {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  minerId?: string;
  subscriptions: Set<string>;
  lastPing: number;
}

export class WebSocketManager extends EventEmitter {
  private wss: WebSocket.Server;
  private clients = new Map<string, WebSocketClient>();
  private topics = new Map<string, Set<string>>(); // topic -> client IDs
  private pingInterval: NodeJS.Timeout | null = null;
  
  constructor(
    private port: number,
    private authSystem?: AuthSystem
  ) {
    super();
    this.wss = new WebSocket.Server({ port });
    this.setupServer();
  }
  
  private setupServer(): void {
    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      const client: WebSocketClient = {
        id: clientId,
        ws,
        authenticated: false,
        subscriptions: new Set(),
        lastPing: Date.now()
      };
      
      this.clients.set(clientId, client);
      logger.info('websocket', `Client connected: ${clientId}`);
      
      // Send welcome message
      this.sendToClient(client, {
        type: 'welcome',
        data: { clientId, timestamp: new Date().toISOString() }
      });
      
      // Setup event handlers
      ws.on('message', (data) => this.handleMessage(client, data));
      ws.on('close', () => this.handleDisconnect(client));
      ws.on('error', (error) => this.handleError(client, error));
      ws.on('pong', () => { client.lastPing = Date.now(); });
    });
    
    // Start ping interval
    this.startPingInterval();
    
    logger.info('websocket', `WebSocket server listening on port ${this.port}`);
  }
  
  private generateClientId(): string {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private async handleMessage(client: WebSocketClient, data: WebSocket.Data): Promise<void> {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());
      
      // Handle authentication first
      if (message.type === 'auth' && this.authSystem) {
        await this.handleAuth(client, message);
        return;
      }
      
      // Check if authentication required
      if (this.authSystem && !client.authenticated) {
        this.sendToClient(client, {
          type: 'error',
          data: { message: 'Authentication required' }
        });
        return;
      }
      
      // Route message
      switch (message.type) {
        case 'subscribe':
          this.handleSubscribe(client, message.data.topics);
          break;
          
        case 'unsubscribe':
          this.handleUnsubscribe(client, message.data.topics);
          break;
          
        case 'ping':
          this.sendToClient(client, { type: 'pong', data: message.data });
          break;
          
        default:
          // Emit custom message for handling
          this.emit('message', { client, message });
      }
    } catch (error) {
      logger.error('websocket', 'Failed to handle message', error as Error);
      this.sendToClient(client, {
        type: 'error',
        data: { message: 'Invalid message format' }
      });
    }
  }
  
  private async handleAuth(client: WebSocketClient, message: WebSocketMessage): Promise<void> {
    if (!this.authSystem) return;
    
    const { token, minerId } = message.data;
    
    // Validate token
    const validation = this.authSystem.validateApiKey(token);
    
    if (validation.valid && validation.minerId) {
      client.authenticated = true;
      client.minerId = validation.minerId;
      
      this.sendToClient(client, {
        type: 'auth_success',
        data: { minerId: validation.minerId }
      });
      
      logger.info('websocket', `Client ${client.id} authenticated as ${validation.minerId}`);
    } else {
      this.sendToClient(client, {
        type: 'auth_failed',
        data: { message: 'Invalid authentication token' }
      });
    }
  }
  
  private handleSubscribe(client: WebSocketClient, topics: string[]): void {
    for (const topic of topics) {
      client.subscriptions.add(topic);
      
      if (!this.topics.has(topic)) {
        this.topics.set(topic, new Set());
      }
      this.topics.get(topic)!.add(client.id);
    }
    
    this.sendToClient(client, {
      type: 'subscribed',
      data: { topics }
    });
  }
  
  private handleUnsubscribe(client: WebSocketClient, topics: string[]): void {
    for (const topic of topics) {
      client.subscriptions.delete(topic);
      
      const topicClients = this.topics.get(topic);
      if (topicClients) {
        topicClients.delete(client.id);
        if (topicClients.size === 0) {
          this.topics.delete(topic);
        }
      }
    }
    
    this.sendToClient(client, {
      type: 'unsubscribed',
      data: { topics }
    });
  }
  
  private handleDisconnect(client: WebSocketClient): void {
    logger.info('websocket', `Client disconnected: ${client.id}`);
    
    // Remove from all topics
    for (const topic of client.subscriptions) {
      const topicClients = this.topics.get(topic);
      if (topicClients) {
        topicClients.delete(client.id);
        if (topicClients.size === 0) {
          this.topics.delete(topic);
        }
      }
    }
    
    // Remove client
    this.clients.delete(client.id);
    
    // Emit disconnect event
    this.emit('disconnect', client);
  }
  
  private handleError(client: WebSocketClient, error: Error): void {
    logger.error('websocket', `Client ${client.id} error:`, error);
  }
  
  // Send message to specific client
  private sendToClient(client: WebSocketClient, message: WebSocketMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
  
  // Public methods
  
  // Broadcast to all connected clients
  broadcast(message: WebSocketMessage): void {
    const data = JSON.stringify(message);
    
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }
  
  // Publish to specific topic
  publish(topic: string, message: WebSocketMessage): void {
    const subscribers = this.topics.get(topic);
    if (!subscribers) return;
    
    const data = JSON.stringify(message);
    
    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }
  
  // Send to specific miner
  sendToMiner(minerId: string, message: WebSocketMessage): void {
    for (const client of this.clients.values()) {
      if (client.minerId === minerId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    }
  }
  
  // Get client statistics
  getStats(): {
    totalClients: number;
    authenticatedClients: number;
    topics: { [topic: string]: number };
  } {
    const topicStats: { [topic: string]: number } = {};
    
    for (const [topic, clients] of this.topics) {
      topicStats[topic] = clients.size;
    }
    
    return {
      totalClients: this.clients.size,
      authenticatedClients: Array.from(this.clients.values()).filter(c => c.authenticated).length,
      topics: topicStats
    };
  }
  
  // Ping all clients periodically
  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 30000; // 30 seconds
      
      for (const [clientId, client] of this.clients) {
        if (now - client.lastPing > timeout) {
          logger.warn('websocket', `Client ${clientId} timed out`);
          client.ws.terminate();
          this.clients.delete(clientId);
        } else {
          client.ws.ping();
        }
      }
    }, 10000); // Every 10 seconds
  }
  
  // Shutdown
  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    
    // Close all connections
    for (const client of this.clients.values()) {
      client.ws.close();
    }
    
    this.wss.close();
  }
}

// Real-time event publisher
export class RealtimePublisher {
  constructor(private wsManager: WebSocketManager) {}
  
  // Publish share event
  publishShare(minerId: string, valid: boolean, difficulty: number): void {
    this.wsManager.publish('shares', {
      type: 'share',
      data: {
        minerId,
        valid,
        difficulty,
        timestamp: Date.now()
      }
    });
    
    // Also send to specific miner
    this.wsManager.sendToMiner(minerId, {
      type: 'share_result',
      data: { valid, difficulty }
    });
  }
  
  // Publish block found event
  publishBlockFound(height: number, reward: number, finder: string): void {
    this.wsManager.broadcast({
      type: 'block_found',
      data: {
        height,
        reward,
        finder,
        timestamp: Date.now()
      }
    });
  }
  
  // Publish hashrate update
  publishHashrate(minerId: string, hashrate: number): void {
    this.wsManager.sendToMiner(minerId, {
      type: 'hashrate_update',
      data: { hashrate }
    });
    
    this.wsManager.publish('hashrates', {
      type: 'miner_hashrate',
      data: { minerId, hashrate }
    });
  }
  
  // Publish pool stats
  publishPoolStats(stats: any): void {
    this.wsManager.publish('pool_stats', {
      type: 'stats_update',
      data: stats
    });
  }
  
  // Publish payment notification
  publishPayment(minerId: string, amount: number, txid: string): void {
    this.wsManager.sendToMiner(minerId, {
      type: 'payment',
      data: {
        amount,
        txid,
        timestamp: Date.now()
      }
    });
  }
}

// WebSocket client for testing/monitoring
export class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private eventHandlers = new Map<string, (data: any) => void>();
  
  constructor(
    private url: string,
    private options?: {
      reconnect?: boolean;
      reconnectInterval?: number;
      auth?: { token: string };
    }
  ) {}
  
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      
      this.ws.on('open', () => {
        logger.info('websocket-client', 'Connected to server');
        
        // Send auth if provided
        if (this.options?.auth) {
          this.send({
            type: 'auth',
            data: this.options.auth
          });
        }
        
        resolve();
      });
      
      this.ws.on('message', (data) => {
        try {
          const message: WebSocketMessage = JSON.parse(data.toString());
          const handler = this.eventHandlers.get(message.type);
          if (handler) {
            handler(message.data);
          }
        } catch (error) {
          logger.error('websocket-client', 'Failed to parse message', error as Error);
        }
      });
      
      this.ws.on('close', () => {
        logger.info('websocket-client', 'Disconnected from server');
        if (this.options?.reconnect) {
          this.scheduleReconnect();
        }
      });
      
      this.ws.on('error', (error) => {
        logger.error('websocket-client', 'WebSocket error', error);
        reject(error);
      });
    });
  }
  
  private scheduleReconnect(): void {
    if (this.reconnectInterval) return;
    
    this.reconnectInterval = setTimeout(() => {
      this.reconnectInterval = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, this.options?.reconnectInterval || 5000);
  }
  
  on(event: string, handler: (data: any) => void): void {
    this.eventHandlers.set(event, handler);
  }
  
  send(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
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
  
  close(): void {
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
    }
    if (this.ws) {
      this.ws.close();
    }
  }
}
