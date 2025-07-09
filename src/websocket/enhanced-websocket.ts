/**
 * Enhanced WebSocket System - リアルタイム通信システム
 * 設計思想: Carmack (効率性), Martin (クリーン), Pike (シンプル)
 * 
 * 機能:
 * - 高性能WebSocket通信
 * - リアルタイムデータストリーミング
 * - 自動再接続機能
 * - メッセージキューイング
 * - 認証・認可
 * - 負荷分散対応
 * - バイナリメッセージサポート
 */

import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createServer, Server, IncomingMessage } from 'http';
import { createServer as createHttpsServer } from 'https';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

// === 型定義 ===
interface WebSocketMessage {
  id: string;
  type: string;
  channel: string;
  data: any;
  timestamp: number;
  compressed?: boolean;
  binary?: boolean;
}

interface WebSocketClient {
  id: string;
  socket: WebSocket;
  subscriptions: Set<string>;
  authenticated: boolean;
  userId?: string;
  metadata: Record<string, any>;
  lastActivity: number;
  messagesSent: number;
  messagesReceived: number;
  bytesTransferred: number;
  rateLimitCount: number;
  rateLimitWindowStart: number;
}

interface WebSocketChannel {
  name: string;
  type: 'public' | 'private' | 'presence';
  subscribers: Set<string>;
  messageHistory: WebSocketMessage[];
  maxHistory: number;
  rateLimiting: {
    enabled: boolean;
    maxMessages: number;
    windowMs: number;
  };
  authentication: {
    required: boolean;
    roles?: string[];
  };
}

interface WebSocketConfig {
  port: number;
  host: string;
  ssl: {
    enabled: boolean;
    keyPath?: string;
    certPath?: string;
  };
  compression: {
    enabled: boolean;
    threshold: number;
    level: number;
  };
  rateLimiting: {
    enabled: boolean;
    maxMessages: number;
    windowMs: number;
    banDuration: number;
  };
  authentication: {
    enabled: boolean;
    tokenExpiry: number;
    secretKey: string;
  };
  channels: {
    maxHistory: number;
    cleanupInterval: number;
  };
  heartbeat: {
    enabled: boolean;
    interval: number;
    timeout: number;
  };
}

interface WebSocketStats {
  connections: {
    total: number;
    authenticated: number;
    active: number;
  };
  channels: {
    total: number;
    public: number;
    private: number;
    presence: number;
  };
  messages: {
    sent: number;
    received: number;
    queued: number;
    failed: number;
  };
  data: {
    bytesTransferred: number;
    averageMessageSize: number;
    compressionRatio: number;
  };
  uptime: number;
}

// === メッセージキューマネージャー ===
class MessageQueueManager {
  private queues = new Map<string, WebSocketMessage[]>();
  private maxQueueSize = 1000;
  private logger: any;

  constructor(logger: any) {
    this.logger = logger;
  }

  enqueue(clientId: string, message: WebSocketMessage): void {
    let queue = this.queues.get(clientId);
    if (!queue) {
      queue = [];
      this.queues.set(clientId, queue);
    }

    queue.push(message);

    // キューサイズ制限
    if (queue.length > this.maxQueueSize) {
      queue.shift(); // 古いメッセージを削除
    }
  }

  dequeue(clientId: string): WebSocketMessage | null {
    const queue = this.queues.get(clientId);
    return queue?.shift() || null;
  }

  getQueueSize(clientId: string): number {
    return this.queues.get(clientId)?.length || 0;
  }

  clearQueue(clientId: string): void {
    this.queues.delete(clientId);
  }

  getTotalQueuedMessages(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }
}

// === 認証マネージャー ===
class WebSocketAuthManager {
  private config: WebSocketConfig['authentication'];
  private activeSessions = new Map<string, { userId: string; roles: string[]; expiry: number }>();
  private logger: any;

  constructor(config: WebSocketConfig['authentication'], logger: any) {
    this.config = config;
    this.logger = logger;
  }

  generateToken(userId: string, roles: string[] = []): string {
    if (!this.config.enabled) {
      return 'no-auth';
    }

    const payload = {
      userId,
      roles,
      iat: Date.now(),
      exp: Date.now() + this.config.tokenExpiry
    };

    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    
    const signature = crypto
      .createHmac('sha256', this.config.secretKey)
      .update(`${header}.${payloadEncoded}`)
      .digest('base64url');

    return `${header}.${payloadEncoded}.${signature}`;
  }

  verifyToken(token: string): { userId: string; roles: string[] } | null {
    if (!this.config.enabled) {
      return { userId: 'anonymous', roles: [] };
    }

    try {
      const [header, payload, signature] = token.split('.');
      
      // 署名検証
      const expectedSignature = crypto
        .createHmac('sha256', this.config.secretKey)
        .update(`${header}.${payload}`)
        .digest('base64url');

      if (signature !== expectedSignature) {
        return null;
      }

      // ペイロード解析
      const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString());
      
      // 有効期限チェック
      if (Date.now() > decodedPayload.exp) {
        return null;
      }

      return {
        userId: decodedPayload.userId,
        roles: decodedPayload.roles || []
      };

    } catch (error) {
      this.logger.warn('Token verification failed:', error.message);
      return null;
    }
  }

  hasPermission(userRoles: string[], requiredRoles: string[]): boolean {
    if (requiredRoles.length === 0) {
      return true;
    }

    return requiredRoles.some(role => userRoles.includes(role));
  }
}

// === チャンネルマネージャー ===
class ChannelManager {
  private channels = new Map<string, WebSocketChannel>();
  private config: WebSocketConfig['channels'];
  private logger: any;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: WebSocketConfig['channels'], logger: any) {
    this.config = config;
    this.logger = logger;
    
    this.startCleanup();
    this.createDefaultChannels();
  }

  private createDefaultChannels(): void {
    // パブリックチャンネル
    this.createChannel('pool.stats', 'public', { maxHistory: 100 });
    this.createChannel('pool.shares', 'public', { maxHistory: 50 });
    this.createChannel('pool.blocks', 'public', { maxHistory: 20 });
    this.createChannel('system.alerts', 'public', { maxHistory: 30 });
    
    // プライベートチャンネル
    this.createChannel('admin.stats', 'private', { 
      maxHistory: 100,
      authentication: { required: true, roles: ['admin'] }
    });
    this.createChannel('miner.personal', 'private', { 
      maxHistory: 50,
      authentication: { required: true }
    });
  }

  createChannel(name: string, type: 'public' | 'private' | 'presence', options: any = {}): void {
    const channel: WebSocketChannel = {
      name,
      type,
      subscribers: new Set(),
      messageHistory: [],
      maxHistory: options.maxHistory || this.config.maxHistory,
      rateLimiting: {
        enabled: options.rateLimiting?.enabled || false,
        maxMessages: options.rateLimiting?.maxMessages || 100,
        windowMs: options.rateLimiting?.windowMs || 60000
      },
      authentication: {
        required: options.authentication?.required || false,
        roles: options.authentication?.roles || []
      }
    };

    this.channels.set(name, channel);
    this.logger.info(`Created ${type} channel: ${name}`);
  }

  getChannel(name: string): WebSocketChannel | undefined {
    return this.channels.get(name);
  }

  subscribeToChannel(channelName: string, clientId: string, userRoles: string[] = []): boolean {
    const channel = this.channels.get(channelName);
    if (!channel) {
      return false;
    }

    // 認証チェック
    if (channel.authentication.required) {
      if (!this.hasChannelPermission(channel, userRoles)) {
        return false;
      }
    }

    channel.subscribers.add(clientId);
    this.logger.debug(`Client ${clientId} subscribed to channel ${channelName}`);
    return true;
  }

  unsubscribeFromChannel(channelName: string, clientId: string): void {
    const channel = this.channels.get(channelName);
    if (channel) {
      channel.subscribers.delete(clientId);
      this.logger.debug(`Client ${clientId} unsubscribed from channel ${channelName}`);
    }
  }

  private hasChannelPermission(channel: WebSocketChannel, userRoles: string[]): boolean {
    if (!channel.authentication.required) {
      return true;
    }

    if (!channel.authentication.roles || channel.authentication.roles.length === 0) {
      return true;
    }

    return channel.authentication.roles.some(role => userRoles.includes(role));
  }

  addMessageToChannel(channelName: string, message: WebSocketMessage): void {
    const channel = this.channels.get(channelName);
    if (!channel) {
      return;
    }

    channel.messageHistory.push(message);

    // 履歴サイズ制限
    if (channel.messageHistory.length > channel.maxHistory) {
      channel.messageHistory.shift();
    }
  }

  getChannelSubscribers(channelName: string): Set<string> {
    const channel = this.channels.get(channelName);
    return channel ? new Set(channel.subscribers) : new Set();
  }

  getChannelHistory(channelName: string, limit?: number): WebSocketMessage[] {
    const channel = this.channels.get(channelName);
    if (!channel) {
      return [];
    }

    const history = channel.messageHistory;
    return limit ? history.slice(-limit) : history.slice();
  }

  getAllChannels(): WebSocketChannel[] {
    return Array.from(this.channels.values());
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      for (const channel of this.channels.values()) {
        // 古いメッセージを削除
        const cutoff = Date.now() - (24 * 60 * 60 * 1000); // 24時間
        channel.messageHistory = channel.messageHistory.filter(msg => msg.timestamp > cutoff);
      }
    }, this.config.cleanupInterval);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// === 圧縮ユーティリティ ===
class CompressionManager {
  private config: WebSocketConfig['compression'];
  private stats = {
    originalBytes: 0,
    compressedBytes: 0,
    compressionCount: 0
  };

  constructor(config: WebSocketConfig['compression']) {
    this.config = config;
  }

  shouldCompress(data: string | Buffer): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
    return size >= this.config.threshold;
  }

  async compress(data: string | Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      
      zlib.deflate(input, { level: this.config.level }, (err, compressed) => {
        if (err) {
          reject(err);
        } else {
          this.stats.originalBytes += input.length;
          this.stats.compressedBytes += compressed.length;
          this.stats.compressionCount++;
          resolve(compressed);
        }
      });
    });
  }

  async decompress(data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      zlib.inflate(data, (err, decompressed) => {
        if (err) {
          reject(err);
        } else {
          resolve(decompressed);
        }
      });
    });
  }

  getCompressionRatio(): number {
    if (this.stats.originalBytes === 0) {
      return 0;
    }
    return 1 - (this.stats.compressedBytes / this.stats.originalBytes);
  }

  getStats() {
    return {
      ...this.stats,
      compressionRatio: this.getCompressionRatio()
    };
  }
}

// === メインWebSocketサーバー ===
export class EnhancedWebSocketServer extends EventEmitter {
  private config: WebSocketConfig;
  private logger: any;
  
  private wss?: WebSocketServer;
  private server?: Server;
  private clients = new Map<string, WebSocketClient>();
  
  private authManager: WebSocketAuthManager;
  private channelManager: ChannelManager;
  private messageQueue: MessageQueueManager;
  private compressionManager: CompressionManager;
  
  private stats: WebSocketStats;
  private startTime: number;
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(config: WebSocketConfig, logger: any) {
    super();
    this.config = config;
    this.logger = logger;
    this.startTime = Date.now();

    // コンポーネント初期化
    this.authManager = new WebSocketAuthManager(config.authentication, logger);
    this.channelManager = new ChannelManager(config.channels, logger);
    this.messageQueue = new MessageQueueManager(logger);
    this.compressionManager = new CompressionManager(config.compression);

    // 統計初期化
    this.stats = {
      connections: { total: 0, authenticated: 0, active: 0 },
      channels: { total: 0, public: 0, private: 0, presence: 0 },
      messages: { sent: 0, received: 0, queued: 0, failed: 0 },
      data: { bytesTransferred: 0, averageMessageSize: 0, compressionRatio: 0 },
      uptime: 0
    };
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // HTTPサーバー作成
        if (this.config.ssl.enabled) {
          const fs = require('fs');
          const httpsOptions = {
            key: fs.readFileSync(this.config.ssl.keyPath!),
            cert: fs.readFileSync(this.config.ssl.certPath!)
          };
          this.server = createHttpsServer(httpsOptions);
        } else {
          this.server = createServer();
        }

        // WebSocketサーバー作成
        this.wss = new WebSocketServer({ 
          server: this.server,
          perMessageDeflate: this.config.compression.enabled
        });

        // イベントハンドラー設定
        this.setupEventHandlers();

        // サーバー開始
        this.server.listen(this.config.port, this.config.host, () => {
          this.logger.success(`WebSocket server listening on ${this.config.ssl.enabled ? 'wss' : 'ws'}://${this.config.host}:${this.config.port}`);
          
          if (this.config.heartbeat.enabled) {
            this.startHeartbeat();
          }
          
          this.startStatsCollection();
          resolve();
        });

        this.server.on('error', reject);

      } catch (error) {
        reject(error);
      }
    });
  }

  private setupEventHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      this.handleNewConnection(socket, request);
    });
  }

  private handleNewConnection(socket: WebSocket, request: IncomingMessage): void {
    const clientId = crypto.randomUUID();
    const clientIp = request.socket.remoteAddress || '127.0.0.1';

    const client: WebSocketClient = {
      id: clientId,
      socket,
      subscriptions: new Set(),
      authenticated: false,
      metadata: { ip: clientIp, userAgent: request.headers['user-agent'] },
      lastActivity: Date.now(),
      messagesSent: 0,
      messagesReceived: 0,
      bytesTransferred: 0,
      rateLimitCount: 0,
      rateLimitWindowStart: Date.now()
    };

    this.clients.set(clientId, client);
    this.stats.connections.total++;

    this.logger.info(`New WebSocket connection: ${clientId} from ${clientIp}`);

    // イベントハンドラー設定
    socket.on('message', (data: RawData) => {
      this.handleMessage(client, data);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.handleDisconnection(client, code, reason.toString());
    });

    socket.on('error', (error: Error) => {
      this.logger.error(`WebSocket error for client ${clientId}:`, error);
    });

    socket.on('pong', () => {
      client.lastActivity = Date.now();
    });

    // 接続確認メッセージ送信
    this.sendToClient(client, {
      type: 'connection',
      channel: 'system',
      data: {
        clientId,
        serverTime: Date.now(),
        compression: this.config.compression.enabled,
        heartbeat: this.config.heartbeat.enabled
      }
    });

    this.emit('clientConnected', { clientId, client });
  }

  private async handleMessage(client: WebSocketClient, data: RawData): Promise<void> {
    try {
      client.lastActivity = Date.now();
      client.messagesReceived++;

      // レート制限チェック
      if (!this.checkRateLimit(client)) {
        this.sendError(client, 'rate_limit_exceeded', 'Rate limit exceeded');
        return;
      }

      // メッセージ解析
      let messageData: Buffer;
      if (data instanceof Buffer) {
        messageData = data;
      } else if (Array.isArray(data)) {
        messageData = Buffer.concat(data);
      } else {
        messageData = Buffer.from(data);
      }

      client.bytesTransferred += messageData.length;
      this.stats.data.bytesTransferred += messageData.length;

      // 圧縮解除（必要に応じて）
      let messageString: string;
      try {
        // まず通常のテキストとして試行
        messageString = messageData.toString('utf8');
        JSON.parse(messageString); // JSON妥当性チェック
      } catch {
        // 圧縮されている可能性
        try {
          const decompressed = await this.compressionManager.decompress(messageData);
          messageString = decompressed.toString('utf8');
        } catch {
          this.sendError(client, 'invalid_message', 'Invalid message format');
          return;
        }
      }

      const message = JSON.parse(messageString);
      await this.processMessage(client, message);

    } catch (error) {
      this.logger.error(`Error handling message from client ${client.id}:`, error);
      this.sendError(client, 'message_error', 'Error processing message');
    }
  }

  private checkRateLimit(client: WebSocketClient): boolean {
    if (!this.config.rateLimiting.enabled) {
      return true;
    }

    const now = Date.now();
    
    // ウィンドウリセット
    if (now - client.rateLimitWindowStart > this.config.rateLimiting.windowMs) {
      client.rateLimitCount = 0;
      client.rateLimitWindowStart = now;
    }

    client.rateLimitCount++;
    
    if (client.rateLimitCount > this.config.rateLimiting.maxMessages) {
      // クライアントを一時的にブロック
      setTimeout(() => {
        client.rateLimitCount = 0;
        client.rateLimitWindowStart = Date.now();
      }, this.config.rateLimiting.banDuration);
      
      return false;
    }

    return true;
  }

  private async processMessage(client: WebSocketClient, message: any): Promise<void> {
    switch (message.type) {
      case 'auth':
        await this.handleAuthentication(client, message);
        break;
      
      case 'subscribe':
        await this.handleSubscription(client, message);
        break;
      
      case 'unsubscribe':
        await this.handleUnsubscription(client, message);
        break;
      
      case 'publish':
        await this.handlePublish(client, message);
        break;
      
      case 'ping':
        await this.handlePing(client, message);
        break;
      
      default:
        this.sendError(client, 'unknown_message_type', `Unknown message type: ${message.type}`);
        break;
    }
  }

  private async handleAuthentication(client: WebSocketClient, message: any): Promise<void> {
    const { token } = message.data || {};
    
    if (!token) {
      this.sendError(client, 'auth_required', 'Authentication token required');
      return;
    }

    const authResult = this.authManager.verifyToken(token);
    if (!authResult) {
      this.sendError(client, 'auth_failed', 'Invalid authentication token');
      return;
    }

    client.authenticated = true;
    client.userId = authResult.userId;
    client.metadata.roles = authResult.roles;
    this.stats.connections.authenticated++;

    this.sendToClient(client, {
      type: 'auth_success',
      channel: 'system',
      data: {
        userId: authResult.userId,
        roles: authResult.roles
      }
    });

    this.logger.info(`Client ${client.id} authenticated as ${authResult.userId}`);
  }

  private async handleSubscription(client: WebSocketClient, message: any): Promise<void> {
    const { channel } = message.data || {};
    
    if (!channel) {
      this.sendError(client, 'invalid_subscription', 'Channel name required');
      return;
    }

    const userRoles = client.metadata.roles || [];
    const success = this.channelManager.subscribeToChannel(channel, client.id, userRoles);
    
    if (success) {
      client.subscriptions.add(channel);
      
      this.sendToClient(client, {
        type: 'subscription_success',
        channel: 'system',
        data: { channel }
      });

      // チャンネル履歴送信
      const history = this.channelManager.getChannelHistory(channel, 10);
      for (const historicalMessage of history) {
        await this.sendToClient(client, historicalMessage);
      }

      this.logger.debug(`Client ${client.id} subscribed to channel ${channel}`);
    } else {
      this.sendError(client, 'subscription_failed', `Failed to subscribe to channel: ${channel}`);
    }
  }

  private async handleUnsubscription(client: WebSocketClient, message: any): Promise<void> {
    const { channel } = message.data || {};
    
    if (!channel) {
      this.sendError(client, 'invalid_unsubscription', 'Channel name required');
      return;
    }

    this.channelManager.unsubscribeFromChannel(channel, client.id);
    client.subscriptions.delete(channel);

    this.sendToClient(client, {
      type: 'unsubscription_success',
      channel: 'system',
      data: { channel }
    });

    this.logger.debug(`Client ${client.id} unsubscribed from channel ${channel}`);
  }

  private async handlePublish(client: WebSocketClient, message: any): Promise<void> {
    const { channel, data } = message.data || {};
    
    if (!channel || !data) {
      this.sendError(client, 'invalid_publish', 'Channel and data required');
      return;
    }

    // 認証チェック（必要に応じて）
    const channelObj = this.channelManager.getChannel(channel);
    if (channelObj && channelObj.type === 'private' && !client.authenticated) {
      this.sendError(client, 'publish_unauthorized', 'Authentication required for private channels');
      return;
    }

    const publishMessage: WebSocketMessage = {
      id: crypto.randomUUID(),
      type: 'message',
      channel,
      data,
      timestamp: Date.now()
    };

    await this.broadcastToChannel(channel, publishMessage);
    this.logger.debug(`Client ${client.id} published to channel ${channel}`);
  }

  private async handlePing(client: WebSocketClient, message: any): Promise<void> {
    this.sendToClient(client, {
      type: 'pong',
      channel: 'system',
      data: {
        timestamp: Date.now(),
        clientTime: message.data?.timestamp
      }
    });
  }

  private sendError(client: WebSocketClient, code: string, message: string): void {
    this.sendToClient(client, {
      type: 'error',
      channel: 'system',
      data: { code, message }
    });
  }

  private async sendToClient(client: WebSocketClient, message: Partial<WebSocketMessage>): Promise<void> {
    if (client.socket.readyState !== WebSocket.OPEN) {
      // キューに追加
      if (message.type !== 'error' && message.type !== 'pong') {
        this.messageQueue.enqueue(client.id, message as WebSocketMessage);
        this.stats.messages.queued++;
      }
      return;
    }

    try {
      const fullMessage: WebSocketMessage = {
        id: crypto.randomUUID(),
        type: message.type || 'message',
        channel: message.channel || 'default',
        data: message.data,
        timestamp: message.timestamp || Date.now()
      };

      let messageString = JSON.stringify(fullMessage);
      let messageData: string | Buffer = messageString;

      // 圧縮（必要に応じて）
      if (this.compressionManager.shouldCompress(messageString)) {
        messageData = await this.compressionManager.compress(messageString);
        fullMessage.compressed = true;
      }

      client.socket.send(messageData);
      client.messagesSent++;
      this.stats.messages.sent++;

      const size = typeof messageData === 'string' ? Buffer.byteLength(messageData, 'utf8') : messageData.length;
      client.bytesTransferred += size;
      this.stats.data.bytesTransferred += size;

    } catch (error) {
      this.logger.error(`Error sending message to client ${client.id}:`, error);
      this.stats.messages.failed++;
    }
  }

  private handleDisconnection(client: WebSocketClient, code: number, reason: string): void {
    // 全チャンネルから購読解除
    for (const channel of client.subscriptions) {
      this.channelManager.unsubscribeFromChannel(channel, client.id);
    }

    // キューをクリア
    this.messageQueue.clearQueue(client.id);

    // クライアント削除
    this.clients.delete(client.id);
    this.stats.connections.total = Math.max(0, this.stats.connections.total - 1);
    
    if (client.authenticated) {
      this.stats.connections.authenticated = Math.max(0, this.stats.connections.authenticated - 1);
    }

    this.logger.info(`Client disconnected: ${client.id} (code: ${code}, reason: ${reason})`);
    this.emit('clientDisconnected', { clientId: client.id, client, code, reason });
  }

  // パブリックメソッド
  async broadcastToChannel(channelName: string, message: WebSocketMessage): Promise<void> {
    const subscribers = this.channelManager.getChannelSubscribers(channelName);
    
    // チャンネルにメッセージを保存
    this.channelManager.addMessageToChannel(channelName, message);

    // 購読者に送信
    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client) {
        await this.sendToClient(client, message);
      }
    }

    this.emit('messageBroadcast', { channel: channelName, message, subscriberCount: subscribers.size });
  }

  generateAuthToken(userId: string, roles: string[] = []): string {
    return this.authManager.generateToken(userId, roles);
  }

  createChannel(name: string, type: 'public' | 'private' | 'presence', options: any = {}): void {
    this.channelManager.createChannel(name, type, options);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.heartbeat.timeout;

      for (const [clientId, client] of this.clients) {
        if (now - client.lastActivity > timeout) {
          this.logger.warn(`Client ${clientId} heartbeat timeout, disconnecting`);
          client.socket.terminate();
        } else {
          // Ping送信
          try {
            client.socket.ping();
          } catch (error) {
            this.logger.error(`Error sending ping to client ${clientId}:`, error);
          }
        }
      }
    }, this.config.heartbeat.interval);
  }

  private startStatsCollection(): void {
    setInterval(() => {
      this.updateStats();
    }, 10000); // 10秒間隔
  }

  private updateStats(): void {
    this.stats.connections.active = Array.from(this.clients.values())
      .filter(client => client.socket.readyState === WebSocket.OPEN).length;

    const channels = this.channelManager.getAllChannels();
    this.stats.channels = {
      total: channels.length,
      public: channels.filter(c => c.type === 'public').length,
      private: channels.filter(c => c.type === 'private').length,
      presence: channels.filter(c => c.type === 'presence').length
    };

    this.stats.messages.queued = this.messageQueue.getTotalQueuedMessages();
    this.stats.data.compressionRatio = this.compressionManager.getCompressionRatio();
    this.stats.uptime = Date.now() - this.startTime;

    // 平均メッセージサイズ計算
    if (this.stats.messages.sent > 0) {
      this.stats.data.averageMessageSize = this.stats.data.bytesTransferred / this.stats.messages.sent;
    }
  }

  getStats(): WebSocketStats {
    this.updateStats();
    return { ...this.stats };
  }

  getClients(): WebSocketClient[] {
    return Array.from(this.clients.values());
  }

  getChannels(): WebSocketChannel[] {
    return this.channelManager.getAllChannels();
  }

  async stop(): Promise<void> {
    this.logger.info('Stopping WebSocket server...');

    // ハートビート停止
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // 全クライアント切断
    for (const client of this.clients.values()) {
      client.socket.close(1001, 'Server shutdown');
    }

    // サーバー停止
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          if (this.server) {
            this.server.close(() => {
              this.channelManager.stop();
              this.logger.success('WebSocket server stopped');
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

// === デフォルト設定 ===
export const DefaultWebSocketConfig: WebSocketConfig = {
  port: 8081,
  host: '0.0.0.0',
  ssl: {
    enabled: false
  },
  compression: {
    enabled: true,
    threshold: 1024, // 1KB
    level: 6
  },
  rateLimiting: {
    enabled: true,
    maxMessages: 100,
    windowMs: 60000, // 1分
    banDuration: 300000 // 5分
  },
  authentication: {
    enabled: true,
    tokenExpiry: 24 * 60 * 60 * 1000, // 24時間
    secretKey: crypto.randomBytes(32).toString('hex')
  },
  channels: {
    maxHistory: 100,
    cleanupInterval: 60000 // 1分
  },
  heartbeat: {
    enabled: true,
    interval: 30000, // 30秒
    timeout: 60000   // 60秒
  }
};

export { WebSocketConfig, WebSocketClient, WebSocketChannel, WebSocketMessage, WebSocketStats };
