/**
 * 軽量分散キャッシュシステム
 * 設計思想: Rob Pike (シンプル), John Carmack (高性能), Robert C. Martin (クリーン)
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { createServer, createConnection, Socket } from 'net';

// === 型定義 ===
export interface CacheEntry {
  key: string;
  value: any;
  ttl: number; // Time to live in milliseconds
  timestamp: number;
  version: number;
  hash: string;
}

export interface CacheNode {
  id: string;
  host: string;
  port: number;
  healthy: boolean;
  lastSeen: number;
  load: number;
}

export interface CacheMessage {
  type: 'set' | 'get' | 'delete' | 'sync' | 'ping' | 'pong' | 'replicate';
  key?: string;
  value?: any;
  ttl?: number;
  version?: number;
  data?: any;
  nodeId?: string;
  timestamp: number;
}

export interface CacheConfig {
  port: number;
  maxMemory: number; // bytes
  defaultTtl: number; // milliseconds
  syncInterval: number; // milliseconds
  replicationFactor: number;
  evictionPolicy: 'lru' | 'lfu' | 'ttl';
  nodes?: CacheNode[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  memoryUsed: number;
  memoryMax: number;
  entries: number;
  nodes: number;
  uptime: number;
}

// === 軽量分散キャッシュ ===
export class LightDistributedCache extends EventEmitter {
  private cache = new Map<string, CacheEntry>();
  private nodes = new Map<string, CacheNode>();
  private connections = new Map<string, Socket>();
  private server?: any;
  private config: CacheConfig;
  private nodeId: string;
  private stats: CacheStats;
  private startTime: number;
  private lruOrder: string[] = [];
  private lfuCount = new Map<string, number>();
  private syncTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: CacheConfig) {
    super();
    this.config = config;
    this.nodeId = this.generateNodeId();
    this.startTime = Date.now();
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      memoryUsed: 0,
      memoryMax: config.maxMemory,
      entries: 0,
      nodes: 0,
      uptime: 0
    };

    if (config.nodes) {
      config.nodes.forEach(node => this.addNode(node));
    }
  }

  // === 初期化と起動 ===
  async start(): Promise<void> {
    await this.startServer();
    this.connectToNodes();
    this.startTimers();
    this.emit('started');
  }

  async stop(): Promise<void> {
    this.stopTimers();
    this.disconnectFromNodes();
    if (this.server) {
      this.server.close();
    }
    this.emit('stopped');
  }

  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', reject);
      this.server.listen(this.config.port, () => {
        console.log(`Cache node ${this.nodeId} listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  // === 基本キャッシュ操作 ===
  async set(key: string, value: any, ttl: number = this.config.defaultTtl): Promise<boolean> {
    try {
      const entry: CacheEntry = {
        key,
        value,
        ttl,
        timestamp: Date.now(),
        version: this.getNextVersion(key),
        hash: this.calculateHash({ key, value, ttl })
      };

      // メモリ制限チェック
      if (!this.hasMemorySpace(entry)) {
        this.evictEntries();
        if (!this.hasMemorySpace(entry)) {
          return false;
        }
      }

      // ローカルキャッシュに設定
      this.cache.set(key, entry);
      this.updateAccessPattern(key);
      this.updateStats('set');

      // 他のノードに複製
      await this.replicateToNodes(entry);

      this.emit('set', { key, value, ttl });
      return true;
    } catch (error) {
      console.error('Error setting cache entry:', error);
      return false;
    }
  }

  async get(key: string): Promise<any> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      // 他のノードから取得を試行
      const remoteValue = await this.getFromNodes(key);
      if (remoteValue !== null) {
        this.stats.hits++;
        this.updateAccessPattern(key);
        return remoteValue;
      }
      return null;
    }

    // TTL チェック
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.stats.misses++;
      this.updateStats('eviction');
      return null;
    }

    this.stats.hits++;
    this.updateAccessPattern(key);
    this.emit('get', { key, value: entry.value });
    return entry.value;
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.cache.has(key);
    this.cache.delete(key);
    this.removeFromAccessPattern(key);
    
    if (existed) {
      this.updateStats('delete');
      await this.replicateDelete(key);
      this.emit('delete', { key });
    }

    return existed;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.lruOrder = [];
    this.lfuCount.clear();
    this.updateMemoryStats();
    await this.replicateClear();
    this.emit('clear');
  }

  // === 分散キャッシュ操作 ===
  private async replicateToNodes(entry: CacheEntry): Promise<void> {
    const message: CacheMessage = {
      type: 'replicate',
      key: entry.key,
      value: entry.value,
      ttl: entry.ttl,
      version: entry.version,
      nodeId: this.nodeId,
      timestamp: Date.now()
    };

    await this.broadcastMessage(message);
  }

  private async replicateDelete(key: string): Promise<void> {
    const message: CacheMessage = {
      type: 'delete',
      key,
      nodeId: this.nodeId,
      timestamp: Date.now()
    };

    await this.broadcastMessage(message);
  }

  private async replicateClear(): Promise<void> {
    const message: CacheMessage = {
      type: 'sync',
      data: { action: 'clear' },
      nodeId: this.nodeId,
      timestamp: Date.now()
    };

    await this.broadcastMessage(message);
  }

  private async getFromNodes(key: string): Promise<any> {
    const message: CacheMessage = {
      type: 'get',
      key,
      nodeId: this.nodeId,
      timestamp: Date.now()
    };

    // 最初に応答したノードの値を返す
    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 1000);

      this.once('remoteValue', (data) => {
        if (!resolved && data.key === key) {
          resolved = true;
          clearTimeout(timeout);
          resolve(data.value);
        }
      });

      this.broadcastMessage(message);
    });
  }

  // === ノード管理 ===
  addNode(node: CacheNode): void {
    this.nodes.set(node.id, node);
    this.stats.nodes = this.nodes.size;
    this.emit('nodeAdded', node);
  }

  removeNode(nodeId: string): boolean {
    const removed = this.nodes.delete(nodeId);
    const connection = this.connections.get(nodeId);
    if (connection) {
      connection.destroy();
      this.connections.delete(nodeId);
    }
    this.stats.nodes = this.nodes.size;
    if (removed) {
      this.emit('nodeRemoved', { nodeId });
    }
    return removed;
  }

  private connectToNodes(): void {
    for (const [nodeId, node] of this.nodes) {
      if (nodeId !== this.nodeId) {
        this.connectToNode(node);
      }
    }
  }

  private connectToNode(node: CacheNode): void {
    if (this.connections.has(node.id)) {
      return;
    }

    try {
      const socket = createConnection({ host: node.host, port: node.port });
      
      socket.on('connect', () => {
        this.connections.set(node.id, socket);
        node.healthy = true;
        node.lastSeen = Date.now();
        this.emit('nodeConnected', node);
      });

      socket.on('data', (data) => {
        this.handleMessage(data.toString(), node.id);
      });

      socket.on('error', (error) => {
        console.error(`Connection error to node ${node.id}:`, error);
        node.healthy = false;
        this.connections.delete(node.id);
      });

      socket.on('close', () => {
        node.healthy = false;
        this.connections.delete(node.id);
        this.emit('nodeDisconnected', node);
      });

    } catch (error) {
      console.error(`Failed to connect to node ${node.id}:`, error);
      node.healthy = false;
    }
  }

  private disconnectFromNodes(): void {
    for (const [nodeId, connection] of this.connections) {
      connection.destroy();
    }
    this.connections.clear();
  }

  // === メッセージ処理 ===
  private handleConnection(socket: Socket): void {
    socket.on('data', (data) => {
      this.handleMessage(data.toString());
    });

    socket.on('error', (error) => {
      console.error('Socket error:', error);
    });
  }

  private async handleMessage(data: string, fromNodeId?: string): Promise<void> {
    try {
      const message: CacheMessage = JSON.parse(data);

      if (message.nodeId === this.nodeId) {
        return; // 自分自身からのメッセージは無視
      }

      switch (message.type) {
        case 'get':
          await this.handleGetMessage(message, fromNodeId);
          break;
        case 'set':
        case 'replicate':
          await this.handleSetMessage(message);
          break;
        case 'delete':
          await this.handleDeleteMessage(message);
          break;
        case 'sync':
          await this.handleSyncMessage(message);
          break;
        case 'ping':
          await this.handlePingMessage(message, fromNodeId);
          break;
        case 'pong':
          this.handlePongMessage(message);
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  private async handleGetMessage(message: CacheMessage, fromNodeId?: string): Promise<void> {
    if (!message.key) return;

    const entry = this.cache.get(message.key);
    if (entry && !this.isExpired(entry)) {
      const response: CacheMessage = {
        type: 'get',
        key: message.key,
        value: entry.value,
        nodeId: this.nodeId,
        timestamp: Date.now()
      };

      if (fromNodeId) {
        const connection = this.connections.get(fromNodeId);
        if (connection) {
          connection.write(JSON.stringify(response));
        }
      }
    }
  }

  private async handleSetMessage(message: CacheMessage): Promise<void> {
    if (!message.key || message.value === undefined) return;

    const entry: CacheEntry = {
      key: message.key,
      value: message.value,
      ttl: message.ttl || this.config.defaultTtl,
      timestamp: message.timestamp || Date.now(),
      version: message.version || 1,
      hash: this.calculateHash({ key: message.key, value: message.value, ttl: message.ttl })
    };

    // バージョンチェック（既存エントリより新しい場合のみ更新）
    const existing = this.cache.get(message.key);
    if (!existing || entry.version > existing.version) {
      this.cache.set(message.key, entry);
      this.updateAccessPattern(message.key);
      this.updateStats('set');
    }
  }

  private async handleDeleteMessage(message: CacheMessage): Promise<void> {
    if (!message.key) return;

    if (this.cache.has(message.key)) {
      this.cache.delete(message.key);
      this.removeFromAccessPattern(message.key);
      this.updateStats('delete');
    }
  }

  private async handleSyncMessage(message: CacheMessage): Promise<void> {
    if (message.data?.action === 'clear') {
      this.cache.clear();
      this.lruOrder = [];
      this.lfuCount.clear();
      this.updateMemoryStats();
    }
  }

  private async handlePingMessage(message: CacheMessage, fromNodeId?: string): Promise<void> {
    const response: CacheMessage = {
      type: 'pong',
      nodeId: this.nodeId,
      timestamp: Date.now()
    };

    if (fromNodeId) {
      const connection = this.connections.get(fromNodeId);
      if (connection) {
        connection.write(JSON.stringify(response));
      }
    }
  }

  private handlePongMessage(message: CacheMessage): void {
    if (message.nodeId) {
      const node = this.nodes.get(message.nodeId);
      if (node) {
        node.healthy = true;
        node.lastSeen = Date.now();
      }
    }
  }

  private async broadcastMessage(message: CacheMessage): Promise<void> {
    const messageStr = JSON.stringify(message);
    
    for (const [nodeId, connection] of this.connections) {
      try {
        connection.write(messageStr);
      } catch (error) {
        console.error(`Failed to send message to node ${nodeId}:`, error);
      }
    }
  }

  // === エビクション ===
  private evictEntries(): void {
    const targetSize = Math.floor(this.config.maxMemory * 0.8); // 80%まで削減
    
    while (this.getMemoryUsage() > targetSize && this.cache.size > 0) {
      const keyToEvict = this.selectEvictionKey();
      if (keyToEvict) {
        this.cache.delete(keyToEvict);
        this.removeFromAccessPattern(keyToEvict);
        this.stats.evictions++;
      } else {
        break;
      }
    }

    this.updateMemoryStats();
  }

  private selectEvictionKey(): string | null {
    switch (this.config.evictionPolicy) {
      case 'lru':
        return this.lruOrder[0] || null;
      case 'lfu':
        return this.getLfuKey();
      case 'ttl':
        return this.getTtlKey();
      default:
        return this.lruOrder[0] || null;
    }
  }

  private getLfuKey(): string | null {
    let minCount = Infinity;
    let lfuKey = null;

    for (const [key, count] of this.lfuCount) {
      if (count < minCount) {
        minCount = count;
        lfuKey = key;
      }
    }

    return lfuKey;
  }

  private getTtlKey(): string | null {
    let earliestExpiry = Infinity;
    let ttlKey = null;

    for (const [key, entry] of this.cache) {
      const expiry = entry.timestamp + entry.ttl;
      if (expiry < earliestExpiry) {
        earliestExpiry = expiry;
        ttlKey = key;
      }
    }

    return ttlKey;
  }

  // === アクセスパターン管理 ===
  private updateAccessPattern(key: string): void {
    // LRU更新
    const index = this.lruOrder.indexOf(key);
    if (index !== -1) {
      this.lruOrder.splice(index, 1);
    }
    this.lruOrder.push(key);

    // LFU更新
    const count = this.lfuCount.get(key) || 0;
    this.lfuCount.set(key, count + 1);
  }

  private removeFromAccessPattern(key: string): void {
    const index = this.lruOrder.indexOf(key);
    if (index !== -1) {
      this.lruOrder.splice(index, 1);
    }
    this.lfuCount.delete(key);
  }

  // === ユーティリティ ===
  private generateNodeId(): string {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substring(2);
    return createHash('sha256').update(timestamp + random).digest('hex').substring(0, 12);
  }

  private calculateHash(data: any): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  private getNextVersion(key: string): number {
    const existing = this.cache.get(key);
    return existing ? existing.version + 1 : 1;
  }

  private isExpired(entry: CacheEntry): boolean {
    return Date.now() > entry.timestamp + entry.ttl;
  }

  private hasMemorySpace(entry: CacheEntry): boolean {
    const entrySize = this.calculateEntrySize(entry);
    return this.getMemoryUsage() + entrySize <= this.config.maxMemory;
  }

  private calculateEntrySize(entry: CacheEntry): number {
    // 簡易的なサイズ計算
    const jsonSize = JSON.stringify(entry).length * 2; // UTF-16
    return jsonSize;
  }

  private getMemoryUsage(): number {
    let total = 0;
    for (const entry of this.cache.values()) {
      total += this.calculateEntrySize(entry);
    }
    return total;
  }

  private updateStats(operation: 'set' | 'delete' | 'eviction'): void {
    switch (operation) {
      case 'set':
        this.stats.sets++;
        break;
      case 'delete':
        this.stats.deletes++;
        break;
      case 'eviction':
        this.stats.evictions++;
        break;
    }
    this.updateMemoryStats();
  }

  private updateMemoryStats(): void {
    this.stats.memoryUsed = this.getMemoryUsage();
    this.stats.entries = this.cache.size;
    this.stats.uptime = Date.now() - this.startTime;
  }

  // === タイマー ===
  private startTimers(): void {
    // 同期タイマー
    this.syncTimer = setInterval(() => {
      this.syncWithNodes();
    }, this.config.syncInterval);

    // クリーンアップタイマー
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
    }, 60000); // 1分間隔
  }

  private stopTimers(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  private async syncWithNodes(): Promise<void> {
    const pingMessage: CacheMessage = {
      type: 'ping',
      nodeId: this.nodeId,
      timestamp: Date.now()
    };

    await this.broadcastMessage(pingMessage);
  }

  private cleanupExpiredEntries(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache) {
      if (now > entry.timestamp + entry.ttl) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
      this.removeFromAccessPattern(key);
      this.stats.evictions++;
    }

    if (keysToDelete.length > 0) {
      this.updateMemoryStats();
    }
  }

  // === 統計・情報取得 ===
  getStats(): CacheStats {
    this.updateMemoryStats();
    return { ...this.stats };
  }

  getNodes(): CacheNode[] {
    return Array.from(this.nodes.values());
  }

  getKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  getSize(): number {
    return this.cache.size;
  }

  getMemoryUsage(): number {
    return this.getMemoryUsage();
  }

  getNodeId(): string {
    return this.nodeId;
  }

  // === ヘルスチェック ===
  isHealthy(): boolean {
    const memoryUsage = this.getMemoryUsage();
    const memoryOk = memoryUsage < this.config.maxMemory * 0.9;
    const connectionsOk = this.connections.size > 0 || this.nodes.size <= 1;
    
    return memoryOk && connectionsOk;
  }
}

// === ヘルパークラス ===
export class CacheHelper {
  static createConfig(port: number, maxMemoryMB: number = 256): CacheConfig {
    return {
      port,
      maxMemory: maxMemoryMB * 1024 * 1024, // MB to bytes
      defaultTtl: 3600000, // 1時間
      syncInterval: 30000, // 30秒
      replicationFactor: 2,
      evictionPolicy: 'lru'
    };
  }

  static createNode(id: string, host: string, port: number): CacheNode {
    return {
      id,
      host,
      port,
      healthy: false,
      lastSeen: 0,
      load: 0
    };
  }

  static createCluster(basePort: number, nodeCount: number): CacheConfig[] {
    const configs: CacheConfig[] = [];
    const nodes: CacheNode[] = [];

    // ノード一覧を作成
    for (let i = 0; i < nodeCount; i++) {
      nodes.push(CacheHelper.createNode(
        `node-${i}`,
        'localhost',
        basePort + i
      ));
    }

    // 各ノードの設定を作成
    for (let i = 0; i < nodeCount; i++) {
      const config = CacheHelper.createConfig(basePort + i);
      config.nodes = nodes.filter((_, index) => index !== i); // 自分以外のノード
      configs.push(config);
    }

    return configs;
  }
}

export default LightDistributedCache;