/**
 * 軽量WebSocket APIシステム
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - リアルタイム双方向通信
 * - ルームベースのブロードキャスト
 * - 認証・認可
 * - メッセージルーティング
 * - 接続管理
 * - レート制限
 * - メトリクス収集
 */

import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';

// === 型定義 ===
interface WebSocketConfig {
  port?: number;
  path: string;
  enableAuth: boolean;
  enableRateLimiting: boolean;
  rateLimitPerSecond: number;
  maxConnections: number;
  pingInterval: number;
  pingTimeout: number;
  enableMetrics: boolean;
  enableRooms: boolean;
  messageValidation: boolean;
}

interface WebSocketMessage {
  type: string;
  id?: string;
  data?: any;
  room?: string;
  timestamp: number;
}

interface WebSocketConnection {
  id: string;
  ws: WebSocket;
  userId?: string;
  permissions?: string[];
  rooms: Set<string>;
  metadata: Record<string, any>;
  connectedAt: number;
  lastActivity: number;
  messageCount: number;
  isAlive: boolean;
  rateLimitTokens: number;
  lastRateLimitReset: number;
}

interface MessageHandler {
  type: string;
  handler: (connection: WebSocketConnection, message: WebSocketMessage) => Promise<void> | void;
  requireAuth?: boolean;
  requiredPermissions?: string[];
  rateLimit?: number;
}

interface RoomInfo {
  name: string;
  connections: Set<string>;
  metadata: Record<string, any>;
  createdAt: number;
  lastActivity: number;
}

interface WebSocketMetrics {
  totalConnections: number;
  activeConnections: number;
  totalMessages: number;
  messagesPerSecond: number;
  averageLatency: number;
  errors: number;
  lastReset: number;
}

// === レート制限器 ===
class WebSocketRateLimiter {
  private connections = new Map<string, { tokens: number; lastReset: number }>();
  private tokensPerSecond: number;

  constructor(tokensPerSecond: number) {
    this.tokensPerSecond = tokensPerSecond;
  }

  checkLimit(connectionId: string): boolean {
    const now = Date.now();
    let connectionData = this.connections.get(connectionId);

    if (!connectionData) {
      connectionData = { tokens: this.tokensPerSecond, lastReset: now };
      this.connections.set(connectionId, connectionData);
    }

    // 1秒経過したらトークンを補充
    if (now - connectionData.lastReset >= 1000) {
      connectionData.tokens = this.tokensPerSecond;
      connectionData.lastReset = now;
    }

    if (connectionData.tokens > 0) {
      connectionData.tokens--;
      return true;
    }

    return false;
  }

  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  getStats() {
    return {
      trackedConnections: this.connections.size,
      tokensPerSecond: this.tokensPerSecond
    };
  }
}

// === ルーム管理 ===
class RoomManager {
  private rooms = new Map<string, RoomInfo>();

  createRoom(name: string, metadata: Record<string, any> = {}): RoomInfo {
    if (this.rooms.has(name)) {
      throw new Error(`Room '${name}' already exists`);
    }

    const room: RoomInfo = {
      name,
      connections: new Set(),
      metadata,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    this.rooms.set(name, room);
    return room;
  }

  joinRoom(roomName: string, connectionId: string): boolean {
    const room = this.rooms.get(roomName);
    if (!room) return false;

    room.connections.add(connectionId);
    room.lastActivity = Date.now();
    return true;
  }

  leaveRoom(roomName: string, connectionId: string): boolean {
    const room = this.rooms.get(roomName);
    if (!room) return false;

    const removed = room.connections.delete(connectionId);
    if (removed) {
      room.lastActivity = Date.now();
    }

    // 空のルームを削除
    if (room.connections.size === 0) {
      this.rooms.delete(roomName);
    }

    return removed;
  }

  leaveAllRooms(connectionId: string): void {
    for (const [roomName, room] of this.rooms) {
      if (room.connections.has(connectionId)) {
        this.leaveRoom(roomName, connectionId);
      }
    }
  }

  getRoomConnections(roomName: string): string[] {
    const room = this.rooms.get(roomName);
    return room ? Array.from(room.connections) : [];
  }

  getRooms(): RoomInfo[] {
    return Array.from(this.rooms.values());
  }

  getRoomInfo(roomName: string): RoomInfo | null {
    return this.rooms.get(roomName) || null;
  }

  cleanup(): void {
    const now = Date.now();
    const timeout = 24 * 60 * 60 * 1000; // 24時間

    for (const [name, room] of this.rooms) {
      if (room.connections.size === 0 && now - room.lastActivity > timeout) {
        this.rooms.delete(name);
      }
    }
  }
}

// === メッセージバリデーター ===
class MessageValidator {
  private schemas = new Map<string, any>();

  addSchema(messageType: string, schema: any): void {
    this.schemas.set(messageType, schema);
  }

  validate(message: WebSocketMessage): boolean {
    const schema = this.schemas.get(message.type);
    if (!schema) return true; // スキーマがない場合は通す

    try {
      return this.validateAgainstSchema(message, schema);
    } catch (error) {
      return false;
    }
  }

  private validateAgainstSchema(message: WebSocketMessage, schema: any): boolean {
    // 簡易バリデーション実装
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in message)) {
          return false;
        }
      }
    }

    if (schema.properties) {
      for (const [key, value] of Object.entries(message)) {
        const fieldSchema = schema.properties[key];
        if (fieldSchema && !this.validateField(value, fieldSchema)) {
          return false;
        }
      }
    }

    return true;
  }

  private validateField(value: any, schema: any): boolean {
    if (schema.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== schema.type) {
        return false;
      }
    }

    if (schema.minLength && typeof value === 'string' && value.length < schema.minLength) {
      return false;
    }

    if (schema.maxLength && typeof value === 'string' && value.length > schema.maxLength) {
      return false;
    }

    return true;
  }
}

// === メインWebSocketサーバー ===
class LightWebSocketServer extends EventEmitter {
  private config: WebSocketConfig;
  private wss?: WebSocketServer;
  private connections = new Map<string, WebSocketConnection>();
  private messageHandlers = new Map<string, MessageHandler>();
  private roomManager = new RoomManager();
  private rateLimiter: WebSocketRateLimiter;
  private messageValidator = new MessageValidator();
  private metrics: WebSocketMetrics;
  private logger: any;
  private pingInterval?: NodeJS.Timeout;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: Partial<WebSocketConfig> = {}, logger?: any) {
    super();
    
    this.config = {
      path: '/ws',
      enableAuth: false,
      enableRateLimiting: true,
      rateLimitPerSecond: 10,
      maxConnections: 1000,
      pingInterval: 30000,
      pingTimeout: 5000,
      enableMetrics: true,
      enableRooms: true,
      messageValidation: true,
      ...config
    };

    this.rateLimiter = new WebSocketRateLimiter(this.config.rateLimitPerSecond);
    this.metrics = this.initializeMetrics();
    
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[WS] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[WS] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[WS] ${msg}`, data || '')
    };

    this.setupDefaultHandlers();
    this.setupDefaultSchemas();
  }

  private initializeMetrics(): WebSocketMetrics {
    return {
      totalConnections: 0,
      activeConnections: 0,
      totalMessages: 0,
      messagesPerSecond: 0,
      averageLatency: 0,
      errors: 0,
      lastReset: Date.now()
    };
  }

  private setupDefaultHandlers(): void {
    // Ping/Pong処理
    this.addHandler({
      type: 'ping',
      handler: (connection) => {
        this.sendMessage(connection.id, { type: 'pong', timestamp: Date.now() });
      }
    });

    // ルーム参加
    this.addHandler({
      type: 'join_room',
      handler: (connection, message) => {
        if (!this.config.enableRooms) return;
        
        const { room } = message.data || {};
        if (!room) return;

        this.joinRoom(connection.id, room);
      }
    });

    // ルーム離脱
    this.addHandler({
      type: 'leave_room',
      handler: (connection, message) => {
        if (!this.config.enableRooms) return;
        
        const { room } = message.data || {};
        if (!room) return;

        this.leaveRoom(connection.id, room);
      }
    });

    // エラー処理
    this.addHandler({
      type: 'error',
      handler: (connection, message) => {
        this.logger.error('Client error', { connectionId: connection.id, error: message.data });
      }
    });
  }

  private setupDefaultSchemas(): void {
    this.messageValidator.addSchema('join_room', {
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: ['room'],
          properties: {
            room: { type: 'string', minLength: 1, maxLength: 100 }
          }
        }
      }
    });

    this.messageValidator.addSchema('leave_room', {
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: ['room'],
          properties: {
            room: { type: 'string', minLength: 1, maxLength: 100 }
          }
        }
      }
    });
  }

  start(server?: any): void {
    const options: any = {
      path: this.config.path
    };

    if (this.config.port) {
      options.port = this.config.port;
    } else if (server) {
      options.server = server;
    } else {
      throw new Error('Either port or server must be provided');
    }

    this.wss = new WebSocketServer(options);

    this.wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
      this.handleConnection(ws, request);
    });

    this.setupPeriodicTasks();

    this.logger.info('WebSocket server started', {
      path: this.config.path,
      port: this.config.port
    });

    this.emit('started');
  }

  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    // 接続数制限チェック
    if (this.connections.size >= this.config.maxConnections) {
      ws.close(1013, 'Max connections exceeded');
      return;
    }

    const connectionId = this.generateConnectionId();
    const connection: WebSocketConnection = {
      id: connectionId,
      ws,
      rooms: new Set(),
      metadata: {},
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      isAlive: true,
      rateLimitTokens: this.config.rateLimitPerSecond,
      lastRateLimitReset: Date.now()
    };

    // 認証処理（有効な場合）
    if (this.config.enableAuth) {
      const authResult = this.authenticateConnection(request);
      if (!authResult.success) {
        ws.close(1008, authResult.error || 'Authentication failed');
        return;
      }
      connection.userId = authResult.userId;
      connection.permissions = authResult.permissions;
    }

    this.connections.set(connectionId, connection);
    this.updateMetrics('connection', 1);

    // WebSocketイベントハンドラー設定
    ws.on('message', (data: Buffer) => {
      this.handleMessage(connection, data);
    });

    ws.on('close', () => {
      this.handleDisconnection(connection);
    });

    ws.on('error', (error) => {
      this.logger.error('WebSocket error', { connectionId, error });
      this.handleDisconnection(connection);
    });

    // Pong応答処理
    ws.on('pong', () => {
      connection.isAlive = true;
      connection.lastActivity = Date.now();
    });

    this.logger.info('New WebSocket connection', {
      connectionId,
      userId: connection.userId,
      totalConnections: this.connections.size
    });

    this.emit('connection', connection);

    // 接続成功メッセージ送信
    this.sendMessage(connectionId, {
      type: 'connected',
      data: {
        connectionId,
        features: {
          rooms: this.config.enableRooms,
          auth: this.config.enableAuth,
          rateLimiting: this.config.enableRateLimiting
        }
      }
    });
  }

  private authenticateConnection(request: IncomingMessage): {
    success: boolean;
    userId?: string;
    permissions?: string[];
    error?: string;
  } {
    try {
      // URLパラメータからトークンを取得
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      const token = url.searchParams.get('token') || request.headers.authorization;

      if (!token) {
        return { success: false, error: 'No authentication token provided' };
      }

      // トークン検証（実装に応じて調整）
      // ここでは簡易実装
      if (token === 'valid-token') {
        return {
          success: true,
          userId: 'user123',
          permissions: ['read', 'write']
        };
      }

      return { success: false, error: 'Invalid token' };
    } catch (error) {
      return { success: false, error: 'Authentication error' };
    }
  }

  private handleMessage(connection: WebSocketConnection, data: Buffer): void {
    try {
      // レート制限チェック
      if (this.config.enableRateLimiting && !this.rateLimiter.checkLimit(connection.id)) {
        this.sendMessage(connection.id, {
          type: 'error',
          data: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many messages' }
        });
        return;
      }

      const message: WebSocketMessage = JSON.parse(data.toString());
      message.timestamp = Date.now();

      // メッセージバリデーション
      if (this.config.messageValidation && !this.messageValidator.validate(message)) {
        this.sendMessage(connection.id, {
          type: 'error',
          data: { code: 'INVALID_MESSAGE', message: 'Message validation failed' }
        });
        return;
      }

      connection.lastActivity = Date.now();
      connection.messageCount++;
      this.updateMetrics('message', 1);

      // ハンドラー実行
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        // 認証チェック
        if (handler.requireAuth && !connection.userId) {
          this.sendMessage(connection.id, {
            type: 'error',
            data: { code: 'AUTH_REQUIRED', message: 'Authentication required' }
          });
          return;
        }

        // 権限チェック
        if (handler.requiredPermissions && connection.permissions) {
          const hasPermission = handler.requiredPermissions.some(perm => 
            connection.permissions!.includes(perm)
          );
          if (!hasPermission) {
            this.sendMessage(connection.id, {
              type: 'error',
              data: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Insufficient permissions' }
            });
            return;
          }
        }

        Promise.resolve(handler.handler(connection, message)).catch(error => {
          this.logger.error('Message handler error', { 
            connectionId: connection.id, 
            messageType: message.type,
            error 
          });
          this.sendMessage(connection.id, {
            type: 'error',
            data: { code: 'HANDLER_ERROR', message: 'Message processing failed' }
          });
        });
      } else {
        this.sendMessage(connection.id, {
          type: 'error',
          data: { code: 'UNKNOWN_MESSAGE_TYPE', message: `Unknown message type: ${message.type}` }
        });
      }

      this.emit('message', connection, message);

    } catch (error) {
      this.logger.error('Message parsing error', { connectionId: connection.id, error });
      this.updateMetrics('error', 1);
      
      this.sendMessage(connection.id, {
        type: 'error',
        data: { code: 'PARSE_ERROR', message: 'Failed to parse message' }
      });
    }
  }

  private handleDisconnection(connection: WebSocketConnection): void {
    // ルームから退出
    if (this.config.enableRooms) {
      this.roomManager.leaveAllRooms(connection.id);
    }

    // レート制限データ削除
    this.rateLimiter.removeConnection(connection.id);

    // 接続リストから削除
    this.connections.delete(connection.id);
    this.updateMetrics('disconnection', 1);

    this.logger.info('WebSocket disconnection', {
      connectionId: connection.id,
      userId: connection.userId,
      duration: Date.now() - connection.connectedAt,
      messageCount: connection.messageCount,
      totalConnections: this.connections.size
    });

    this.emit('disconnection', connection);
  }

  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private setupPeriodicTasks(): void {
    // Ping送信
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, this.config.pingInterval);

    // クリーンアップ
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // 1分間隔
  }

  private sendPing(): void {
    for (const [connectionId, connection] of this.connections) {
      if (!connection.isAlive) {
        // 応答がない接続を切断
        connection.ws.terminate();
        this.handleDisconnection(connection);
        continue;
      }

      connection.isAlive = false;
      connection.ws.ping();
    }
  }

  private cleanup(): void {
    this.roomManager.cleanup();
    
    // 非アクティブな接続をチェック
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5分

    for (const [connectionId, connection] of this.connections) {
      if (now - connection.lastActivity > timeout) {
        this.logger.warn('Closing inactive connection', { connectionId });
        connection.ws.close(1001, 'Connection timeout');
      }
    }
  }

  // パブリックメソッド
  addHandler(handler: MessageHandler): void {
    this.messageHandlers.set(handler.type, handler);
  }

  removeHandler(type: string): boolean {
    return this.messageHandlers.delete(type);
  }

  sendMessage(connectionId: string, message: Omit<WebSocketMessage, 'timestamp'>): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      const fullMessage: WebSocketMessage = {
        ...message,
        timestamp: Date.now()
      };

      connection.ws.send(JSON.stringify(fullMessage));
      return true;
    } catch (error) {
      this.logger.error('Failed to send message', { connectionId, error });
      return false;
    }
  }

  broadcast(message: Omit<WebSocketMessage, 'timestamp'>, filter?: (connection: WebSocketConnection) => boolean): number {
    let sentCount = 0;

    for (const [connectionId, connection] of this.connections) {
      if (filter && !filter(connection)) continue;
      
      if (this.sendMessage(connectionId, message)) {
        sentCount++;
      }
    }

    return sentCount;
  }

  broadcastToRoom(roomName: string, message: Omit<WebSocketMessage, 'timestamp'>): number {
    if (!this.config.enableRooms) return 0;

    const connectionIds = this.roomManager.getRoomConnections(roomName);
    let sentCount = 0;

    for (const connectionId of connectionIds) {
      if (this.sendMessage(connectionId, message)) {
        sentCount++;
      }
    }

    return sentCount;
  }

  joinRoom(connectionId: string, roomName: string): boolean {
    if (!this.config.enableRooms) return false;

    const connection = this.connections.get(connectionId);
    if (!connection) return false;

    // ルームが存在しない場合は作成
    if (!this.roomManager.getRoomInfo(roomName)) {
      this.roomManager.createRoom(roomName);
    }

    const joined = this.roomManager.joinRoom(roomName, connectionId);
    if (joined) {
      connection.rooms.add(roomName);
      this.logger.info('Connection joined room', { connectionId, roomName });
      this.emit('roomJoined', connectionId, roomName);
    }

    return joined;
  }

  leaveRoom(connectionId: string, roomName: string): boolean {
    if (!this.config.enableRooms) return false;

    const connection = this.connections.get(connectionId);
    if (!connection) return false;

    const left = this.roomManager.leaveRoom(roomName, connectionId);
    if (left) {
      connection.rooms.delete(roomName);
      this.logger.info('Connection left room', { connectionId, roomName });
      this.emit('roomLeft', connectionId, roomName);
    }

    return left;
  }

  getConnection(connectionId: string): WebSocketConnection | null {
    return this.connections.get(connectionId) || null;
  }

  getConnections(filter?: (connection: WebSocketConnection) => boolean): WebSocketConnection[] {
    const connections = Array.from(this.connections.values());
    return filter ? connections.filter(filter) : connections;
  }

  getRooms(): RoomInfo[] {
    return this.roomManager.getRooms();
  }

  private updateMetrics(type: string, count: number): void {
    if (!this.config.enableMetrics) return;

    switch (type) {
      case 'connection':
        this.metrics.totalConnections += count;
        break;
      case 'disconnection':
        // activeConnectionsは現在の接続数から計算
        break;
      case 'message':
        this.metrics.totalMessages += count;
        break;
      case 'error':
        this.metrics.errors += count;
        break;
    }

    this.metrics.activeConnections = this.connections.size;

    // メッセージ/秒の計算
    const now = Date.now();
    const timeDiff = now - this.metrics.lastReset;
    if (timeDiff >= 1000) {
      this.metrics.messagesPerSecond = this.metrics.totalMessages / (timeDiff / 1000);
      this.metrics.lastReset = now;
    }
  }

  getMetrics(): WebSocketMetrics {
    return { ...this.metrics };
  }

  getStats() {
    return {
      connections: {
        total: this.metrics.totalConnections,
        active: this.metrics.activeConnections,
        maxAllowed: this.config.maxConnections
      },
      messages: {
        total: this.metrics.totalMessages,
        perSecond: this.metrics.messagesPerSecond,
        errors: this.metrics.errors
      },
      rooms: {
        total: this.roomManager.getRooms().length,
        connections: this.roomManager.getRooms().reduce((sum, room) => sum + room.connections.size, 0)
      },
      rateLimiter: this.rateLimiter.getStats(),
      config: this.config
    };
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // 全接続を閉じる
    for (const connection of this.connections.values()) {
      connection.ws.close(1001, 'Server shutting down');
    }

    if (this.wss) {
      this.wss.close();
    }

    this.logger.info('WebSocket server stopped');
    this.emit('stopped');
  }
}

export {
  LightWebSocketServer,
  WebSocketConfig,
  WebSocketConnection,
  WebSocketMessage,
  MessageHandler,
  RoomInfo,
  WebSocketMetrics,
  RoomManager,
  MessageValidator
};