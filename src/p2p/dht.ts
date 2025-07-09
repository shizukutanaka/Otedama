/**
 * DHT（分散ハッシュテーブル）実装
 * Kademlia風の分散ストレージとルーティング
 * 
 * 設計思想：
 * - Carmack: 高速なルックアップと効率的なストレージ
 * - Martin: 耐障害性のある分散アーキテクチャ
 * - Pike: シンプルで理解しやすいDHT実装
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import * as dgram from 'dgram';

// === 型定義 ===
export interface DHTConfig {
  // ノード設定
  nodeId: Buffer;                   // 160ビットのノードID
  listenPort: number;              // リスニングポート
  
  // Kademliaパラメータ
  k: number;                       // バケットサイズ（デフォルト: 20）
  alpha: number;                   // 並行度（デフォルト: 3）
  bucketRefreshInterval: number;   // バケット更新間隔（秒）
  
  // ストレージ設定
  maxStorageSize: number;          // 最大ストレージサイズ（bytes）
  itemTTL: number;                 // アイテムのTTL（秒）
  replicationFactor: number;       // レプリケーション係数
  
  // ネットワーク設定
  requestTimeout: number;          // リクエストタイムアウト（ms）
  maxConcurrentRequests: number;   // 最大並行リクエスト数
  
  // セキュリティ設定
  requireSignature: boolean;       // 署名の必須化
  maxItemSize: number;            // 最大アイテムサイズ
}

export interface DHTNode {
  id: Buffer;
  address: string;
  port: number;
  lastSeen: number;
  rtt?: number;                    // Round Trip Time
  failedRequests: number;
  successfulRequests: number;
}

export interface DHTItem {
  key: Buffer;
  value: Buffer;
  publisher: Buffer;               // パブリッシャーのノードID
  timestamp: number;
  expiry: number;
  signature?: Buffer;
  version?: number;
}

export interface DHTMessage {
  type: DHTMessageType;
  id: string;                      // リクエストID
  nodeId: Buffer;
  data?: any;
}

export enum DHTMessageType {
  PING = 'ping',
  PONG = 'pong',
  FIND_NODE = 'find_node',
  FIND_VALUE = 'find_value',
  STORE = 'store',
  NODE_RESPONSE = 'node_response',
  VALUE_RESPONSE = 'value_response',
  STORE_RESPONSE = 'store_response'
}

export interface RoutingTable {
  buckets: KBucket[];
  localId: Buffer;
}

export interface KBucket {
  nodes: DHTNode[];
  lastUpdated: number;
  depth: number;                   // バケットの深さ（共通プレフィックスの長さ）
}

export interface LookupResult {
  found: boolean;
  value?: Buffer;
  closestNodes: DHTNode[];
  hops: number;
  duration: number;
}

// === DHTマネージャー ===
export class DHTManager extends EventEmitter {
  private config: DHTConfig;
  private routingTable: RoutingTable;
  private storage: Map<string, DHTItem> = new Map();
  private socket?: dgram.Socket;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private refreshTimer?: NodeJS.Timeout;
  
  // 統計情報
  private statistics = {
    lookups: 0,
    successfulLookups: 0,
    stores: 0,
    items: 0,
    totalStorage: 0,
    averageHops: 0
  };
  
  constructor(config: DHTConfig) {
    super();
    this.config = config;
    
    // ルーティングテーブルの初期化
    this.routingTable = {
      buckets: this.initializeBuckets(),
      localId: config.nodeId
    };
  }
  
  // DHTの開始
  async start(): Promise<void> {
    try {
      // UDPソケットの作成
      await this.setupSocket();
      
      // 定期的なバケット更新
      this.startBucketRefresh();
      
      // ストレージのクリーンアップ
      this.startStorageCleanup();
      
      this.emit('started', { nodeId: this.config.nodeId.toString('hex') });
      
    } catch (error) {
      this.emit('error', { error, context: 'start' });
      throw error;
    }
  }
  
  // ソケットのセットアップ
  private async setupSocket(): Promise<void> {
    this.socket = dgram.createSocket('udp4');
    
    this.socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo);
    });
    
    this.socket.on('error', (error) => {
      this.emit('socketError', error);
    });
    
    await new Promise<void>((resolve, reject) => {
      this.socket!.bind(this.config.listenPort, () => {
        resolve();
      });
      
      this.socket!.on('error', reject);
    });
  }
  
  // メッセージ処理
  private async handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    try {
      const message: DHTMessage = JSON.parse(msg.toString());
      message.nodeId = Buffer.from(message.nodeId);
      
      // ノード情報の更新
      const node: DHTNode = {
        id: message.nodeId,
        address: rinfo.address,
        port: rinfo.port,
        lastSeen: Date.now(),
        failedRequests: 0,
        successfulRequests: 0
      };
      
      this.updateNode(node);
      
      // メッセージタイプごとの処理
      switch (message.type) {
        case DHTMessageType.PING:
          await this.handlePing(message, rinfo);
          break;
          
        case DHTMessageType.PONG:
          await this.handlePong(message, rinfo);
          break;
          
        case DHTMessageType.FIND_NODE:
          await this.handleFindNode(message, rinfo);
          break;
          
        case DHTMessageType.FIND_VALUE:
          await this.handleFindValue(message, rinfo);
          break;
          
        case DHTMessageType.STORE:
          await this.handleStore(message, rinfo);
          break;
          
        case DHTMessageType.NODE_RESPONSE:
          await this.handleNodeResponse(message, rinfo);
          break;
          
        case DHTMessageType.VALUE_RESPONSE:
          await this.handleValueResponse(message, rinfo);
          break;
          
        case DHTMessageType.STORE_RESPONSE:
          await this.handleStoreResponse(message, rinfo);
          break;
      }
      
    } catch (error) {
      this.emit('messageError', { error, rinfo });
    }
  }
  
  // Pingの処理
  private async handlePing(message: DHTMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const pong: DHTMessage = {
      type: DHTMessageType.PONG,
      id: message.id,
      nodeId: this.config.nodeId
    };
    
    await this.sendMessage(pong, rinfo.address, rinfo.port);
  }
  
  // Pongの処理
  private async handlePong(message: DHTMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const request = this.pendingRequests.get(message.id);
    if (request) {
      request.resolve(message);
      this.pendingRequests.delete(message.id);
    }
  }
  
  // FindNodeの処理
  private async handleFindNode(message: DHTMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const targetId = Buffer.from(message.data.target);
    const closestNodes = this.findClosestNodes(targetId, this.config.k);
    
    const response: DHTMessage = {
      type: DHTMessageType.NODE_RESPONSE,
      id: message.id,
      nodeId: this.config.nodeId,
      data: {
        nodes: closestNodes.map(n => ({
          id: n.id.toString('hex'),
          address: n.address,
          port: n.port
        }))
      }
    };
    
    await this.sendMessage(response, rinfo.address, rinfo.port);
  }
  
  // FindValueの処理
  private async handleFindValue(message: DHTMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const key = Buffer.from(message.data.key);
    const keyStr = key.toString('hex');
    
    // ローカルストレージを確認
    const item = this.storage.get(keyStr);
    
    if (item && item.expiry > Date.now()) {
      // 値が見つかった
      const response: DHTMessage = {
        type: DHTMessageType.VALUE_RESPONSE,
        id: message.id,
        nodeId: this.config.nodeId,
        data: {
          value: item.value.toString('base64'),
          timestamp: item.timestamp,
          version: item.version
        }
      };
      
      await this.sendMessage(response, rinfo.address, rinfo.port);
    } else {
      // 値が見つからない場合は最も近いノードを返す
      await this.handleFindNode(message, rinfo);
    }
  }
  
  // Storeの処理
  private async handleStore(message: DHTMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const item: DHTItem = {
      key: Buffer.from(message.data.key),
      value: Buffer.from(message.data.value, 'base64'),
      publisher: message.nodeId,
      timestamp: message.data.timestamp || Date.now(),
      expiry: Date.now() + this.config.itemTTL * 1000,
      signature: message.data.signature ? Buffer.from(message.data.signature) : undefined,
      version: message.data.version
    };
    
    // 検証
    if (!this.validateItem(item)) {
      return;
    }
    
    // ストレージに保存
    this.storeItem(item);
    
    // 応答
    const response: DHTMessage = {
      type: DHTMessageType.STORE_RESPONSE,
      id: message.id,
      nodeId: this.config.nodeId,
      data: { success: true }
    };
    
    await this.sendMessage(response, rinfo.address, rinfo.port);
  }
  
  // NodeResponseの処理
  private async handleNodeResponse(message: DHTMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const request = this.pendingRequests.get(message.id);
    if (!request) return;
    
    // 新しいノードをルーティングテーブルに追加
    for (const nodeData of message.data.nodes) {
      const node: DHTNode = {
        id: Buffer.from(nodeData.id, 'hex'),
        address: nodeData.address,
        port: nodeData.port,
        lastSeen: Date.now(),
        failedRequests: 0,
        successfulRequests: 0
      };
      
      this.updateNode(node);
    }
    
    request.resolve(message);
    this.pendingRequests.delete(message.id);
  }
  
  // ValueResponseの処理
  private async handleValueResponse(message: DHTMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const request = this.pendingRequests.get(message.id);
    if (request) {
      request.resolve(message);
      this.pendingRequests.delete(message.id);
    }
  }
  
  // StoreResponseの処理
  private async handleStoreResponse(message: DHTMessage, rinfo: dgram.RemoteInfo): Promise<void> {
    const request = this.pendingRequests.get(message.id);
    if (request) {
      request.resolve(message);
      this.pendingRequests.delete(message.id);
    }
  }
  
  // 値のルックアップ
  async lookup(key: Buffer): Promise<LookupResult> {
    const startTime = Date.now();
    this.statistics.lookups++;
    
    // ローカルチェック
    const keyStr = key.toString('hex');
    const localItem = this.storage.get(keyStr);
    if (localItem && localItem.expiry > Date.now()) {
      this.statistics.successfulLookups++;
      return {
        found: true,
        value: localItem.value,
        closestNodes: [],
        hops: 0,
        duration: Date.now() - startTime
      };
    }
    
    // 再帰的ルックアップ
    const result = await this.recursiveLookup(key, true);
    
    if (result.found) {
      this.statistics.successfulLookups++;
    }
    
    result.duration = Date.now() - startTime;
    this.updateAverageHops(result.hops);
    
    return result;
  }
  
  // 再帰的ルックアップ
  private async recursiveLookup(
    target: Buffer,
    findValue: boolean
  ): Promise<LookupResult> {
    const queried = new Set<string>();
    const active = new Map<string, Promise<DHTMessage>>();
    let closestNodes = this.findClosestNodes(target, this.config.k);
    let hops = 0;
    
    while (true) {
      hops++;
      
      // 並行リクエスト
      const candidates = closestNodes
        .filter(n => !queried.has(n.id.toString('hex')))
        .slice(0, this.config.alpha);
      
      if (candidates.length === 0) {
        // これ以上クエリするノードがない
        break;
      }
      
      // リクエストの送信
      const promises = candidates.map(node => {
        const nodeIdStr = node.id.toString('hex');
        queried.add(nodeIdStr);
        
        const promise = findValue ?
          this.sendFindValue(node, target) :
          this.sendFindNode(node, target);
        
        active.set(nodeIdStr, promise);
        return promise;
      });
      
      // 応答の待機
      const responses = await Promise.allSettled(promises);
      
      for (const response of responses) {
        if (response.status === 'fulfilled') {
          const msg = response.value;
          
          // 値が見つかった場合
          if (msg.type === DHTMessageType.VALUE_RESPONSE) {
            return {
              found: true,
              value: Buffer.from(msg.data.value, 'base64'),
              closestNodes,
              hops,
              duration: 0
            };
          }
          
          // 新しいノードの追加
          if (msg.data.nodes) {
            for (const nodeData of msg.data.nodes) {
              const node: DHTNode = {
                id: Buffer.from(nodeData.id, 'hex'),
                address: nodeData.address,
                port: nodeData.port,
                lastSeen: Date.now(),
                failedRequests: 0,
                successfulRequests: 0
              };
              
              this.updateNode(node);
            }
          }
        }
      }
      
      // 最も近いノードの更新
      closestNodes = this.findClosestNodes(target, this.config.k);
    }
    
    return {
      found: false,
      closestNodes,
      hops,
      duration: 0
    };
  }
  
  // 値の保存
  async store(key: Buffer, value: Buffer): Promise<boolean> {
    this.statistics.stores++;
    
    // ローカルに保存
    const item: DHTItem = {
      key,
      value,
      publisher: this.config.nodeId,
      timestamp: Date.now(),
      expiry: Date.now() + this.config.itemTTL * 1000,
      version: 1
    };
    
    this.storeItem(item);
    
    // レプリケーション
    const keyId = this.hash(key);
    const closestNodes = this.findClosestNodes(keyId, this.config.replicationFactor);
    
    const promises = closestNodes.map(node => this.sendStore(node, item));
    const results = await Promise.allSettled(promises);
    
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    
    return successCount >= Math.floor(this.config.replicationFactor / 2);
  }
  
  // ノードの追加/更新
  addNode(nodeInfo: { id: string; address: string; port: number }): void {
    const node: DHTNode = {
      id: Buffer.from(nodeInfo.id, 'hex'),
      address: nodeInfo.address,
      port: nodeInfo.port,
      lastSeen: Date.now(),
      failedRequests: 0,
      successfulRequests: 0
    };
    
    this.updateNode(node);
  }
  
  // ノードの更新
  private updateNode(node: DHTNode): void {
    const distance = this.xorDistance(this.config.nodeId, node.id);
    const bucketIndex = this.getBucketIndex(distance);
    const bucket = this.routingTable.buckets[bucketIndex];
    
    // 既存のノードを探す
    const existingIndex = bucket.nodes.findIndex(n =>
      n.id.equals(node.id)
    );
    
    if (existingIndex >= 0) {
      // 既存ノードの更新
      bucket.nodes[existingIndex] = node;
      // 最近使用したノードを末尾に移動
      bucket.nodes.push(bucket.nodes.splice(existingIndex, 1)[0]);
    } else {
      // 新規ノードの追加
      if (bucket.nodes.length < this.config.k) {
        bucket.nodes.push(node);
      } else {
        // バケットが満杯の場合、最も古いノードをPing
        this.pingOldestNode(bucket, node);
      }
    }
    
    bucket.lastUpdated = Date.now();
  }
  
  // 最も近いノードの検索
  private findClosestNodes(target: Buffer, count: number): DHTNode[] {
    const allNodes: Array<{ node: DHTNode; distance: Buffer }> = [];
    
    for (const bucket of this.routingTable.buckets) {
      for (const node of bucket.nodes) {
        const distance = this.xorDistance(target, node.id);
        allNodes.push({ node, distance });
      }
    }
    
    // 距離でソート
    allNodes.sort((a, b) => {
      for (let i = 0; i < a.distance.length; i++) {
        if (a.distance[i] !== b.distance[i]) {
          return a.distance[i] - b.distance[i];
        }
      }
      return 0;
    });
    
    return allNodes.slice(0, count).map(item => item.node);
  }
  
  // メッセージ送信
  private async sendMessage(
    message: DHTMessage,
    address: string,
    port: number
  ): Promise<void> {
    if (!this.socket) return;
    
    const data = Buffer.from(JSON.stringify({
      ...message,
      nodeId: message.nodeId.toString('hex')
    }));
    
    this.socket.send(data, port, address, (error) => {
      if (error) {
        this.emit('sendError', { error, address, port });
      }
    });
  }
  
  // FindNode送信
  private async sendFindNode(node: DHTNode, target: Buffer): Promise<DHTMessage> {
    const message: DHTMessage = {
      type: DHTMessageType.FIND_NODE,
      id: this.generateRequestId(),
      nodeId: this.config.nodeId,
      data: { target: target.toString('hex') }
    };
    
    return this.sendRequest(message, node);
  }
  
  // FindValue送信
  private async sendFindValue(node: DHTNode, key: Buffer): Promise<DHTMessage> {
    const message: DHTMessage = {
      type: DHTMessageType.FIND_VALUE,
      id: this.generateRequestId(),
      nodeId: this.config.nodeId,
      data: { key: key.toString('hex') }
    };
    
    return this.sendRequest(message, node);
  }
  
  // Store送信
  private async sendStore(node: DHTNode, item: DHTItem): Promise<DHTMessage> {
    const message: DHTMessage = {
      type: DHTMessageType.STORE,
      id: this.generateRequestId(),
      nodeId: this.config.nodeId,
      data: {
        key: item.key.toString('hex'),
        value: item.value.toString('base64'),
        timestamp: item.timestamp,
        version: item.version,
        signature: item.signature?.toString('base64')
      }
    };
    
    return this.sendRequest(message, node);
  }
  
  // リクエスト送信（応答待機付き）
  private async sendRequest(message: DHTMessage, node: DHTNode): Promise<DHTMessage> {
    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        message,
        node,
        timestamp: Date.now(),
        resolve,
        reject
      };
      
      this.pendingRequests.set(message.id, request);
      
      // タイムアウト設定
      setTimeout(() => {
        if (this.pendingRequests.has(message.id)) {
          this.pendingRequests.delete(message.id);
          node.failedRequests++;
          reject(new Error('Request timeout'));
        }
      }, this.config.requestTimeout);
      
      // メッセージ送信
      this.sendMessage(message, node.address, node.port);
    });
  }
  
  // バケットの初期化
  private initializeBuckets(): KBucket[] {
    const buckets: KBucket[] = [];
    
    for (let i = 0; i < 160; i++) { // 160ビットID
      buckets.push({
        nodes: [],
        lastUpdated: Date.now(),
        depth: i
      });
    }
    
    return buckets;
  }
  
  // バケットインデックスの計算
  private getBucketIndex(distance: Buffer): number {
    // 最上位ビットの位置を見つける
    for (let i = 0; i < distance.length; i++) {
      if (distance[i] !== 0) {
        for (let j = 7; j >= 0; j--) {
          if (distance[i] & (1 << j)) {
            return i * 8 + (7 - j);
          }
        }
      }
    }
    return 159; // すべてのビットが0の場合
  }
  
  // XOR距離の計算
  private xorDistance(a: Buffer, b: Buffer): Buffer {
    const result = Buffer.alloc(20); // 160ビット
    
    for (let i = 0; i < 20; i++) {
      result[i] = (a[i] || 0) ^ (b[i] || 0);
    }
    
    return result;
  }
  
  // ハッシュ計算
  private hash(data: Buffer): Buffer {
    return createHash('sha1').update(data).digest();
  }
  
  // 最も古いノードのPing
  private async pingOldestNode(bucket: KBucket, newNode: DHTNode): Promise<void> {
    if (bucket.nodes.length === 0) return;
    
    const oldestNode = bucket.nodes[0];
    
    try {
      const message: DHTMessage = {
        type: DHTMessageType.PING,
        id: this.generateRequestId(),
        nodeId: this.config.nodeId
      };
      
      await this.sendRequest(message, oldestNode);
      oldestNode.successfulRequests++;
      
    } catch (error) {
      // Pingに失敗した場合、古いノードを新しいノードで置き換え
      bucket.nodes[0] = newNode;
      this.emit('nodeReplaced', { old: oldestNode, new: newNode });
    }
  }
  
  // アイテムの検証
  private validateItem(item: DHTItem): boolean {
    // サイズチェック
    if (item.value.length > this.config.maxItemSize) {
      return false;
    }
    
    // 署名チェック（実装依存）
    if (this.config.requireSignature && !item.signature) {
      return false;
    }
    
    return true;
  }
  
  // アイテムの保存
  private storeItem(item: DHTItem): void {
    const keyStr = item.key.toString('hex');
    
    // 既存のアイテムをチェック
    const existing = this.storage.get(keyStr);
    if (existing && existing.version && item.version) {
      if (existing.version >= item.version) {
        return; // 古いバージョンは無視
      }
    }
    
    // ストレージサイズのチェック
    if (this.statistics.totalStorage + item.value.length > this.config.maxStorageSize) {
      this.evictOldItems();
    }
    
    this.storage.set(keyStr, item);
    this.statistics.items = this.storage.size;
    this.statistics.totalStorage += item.value.length;
    
    this.emit('itemStored', { key: keyStr, size: item.value.length });
  }
  
  // 古いアイテムの削除
  private evictOldItems(): void {
    const now = Date.now();
    const items = Array.from(this.storage.entries());
    
    // 期限切れまたは古い順にソート
    items.sort((a, b) => {
      if (a[1].expiry < now && b[1].expiry >= now) return -1;
      if (a[1].expiry >= now && b[1].expiry < now) return 1;
      return a[1].timestamp - b[1].timestamp;
    });
    
    // 容量の20%を削除
    const targetSize = this.config.maxStorageSize * 0.8;
    let currentSize = this.statistics.totalStorage;
    
    for (const [key, item] of items) {
      if (currentSize <= targetSize) break;
      
      this.storage.delete(key);
      currentSize -= item.value.length;
      this.statistics.items--;
    }
    
    this.statistics.totalStorage = currentSize;
  }
  
  // 定期的なバケット更新
  private startBucketRefresh(): void {
    this.refreshTimer = setInterval(async () => {
      // ランダムなバケットを選択して更新
      const bucketIndex = Math.floor(Math.random() * this.routingTable.buckets.length);
      const bucket = this.routingTable.buckets[bucketIndex];
      
      if (Date.now() - bucket.lastUpdated > this.config.bucketRefreshInterval * 1000) {
        // ランダムなIDを生成してルックアップ
        const randomId = randomBytes(20);
        await this.recursiveLookup(randomId, false);
      }
    }, this.config.bucketRefreshInterval * 1000 / 10);
  }
  
  // ストレージのクリーンアップ
  private startStorageCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      
      for (const [key, item] of this.storage) {
        if (item.expiry < now) {
          this.storage.delete(key);
          this.statistics.items--;
          this.statistics.totalStorage -= item.value.length;
        }
      }
    }, 60000); // 1分ごと
  }
  
  // リクエストIDの生成
  private generateRequestId(): string {
    return randomBytes(20).toString('hex');
  }
  
  // 平均ホップ数の更新
  private updateAverageHops(hops: number): void {
    const total = this.statistics.lookups;
    const oldAvg = this.statistics.averageHops;
    
    this.statistics.averageHops = (oldAvg * (total - 1) + hops) / total;
  }
  
  // 公開API
  getNodeId(): string {
    return this.config.nodeId.toString('hex');
  }
  
  getRoutingTable(): RoutingTable {
    return {
      buckets: this.routingTable.buckets.map(b => ({
        nodes: [...b.nodes],
        lastUpdated: b.lastUpdated,
        depth: b.depth
      })),
      localId: this.config.nodeId
    };
  }
  
  getStatistics(): typeof this.statistics {
    return { ...this.statistics };
  }
  
  getStorageInfo(): { items: number; totalSize: number; maxSize: number } {
    return {
      items: this.statistics.items,
      totalSize: this.statistics.totalStorage,
      maxSize: this.config.maxStorageSize
    };
  }
  
  async stop(): Promise<void> {
    // タイマーの停止
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    
    // ペンディングリクエストのクリア
    for (const request of this.pendingRequests.values()) {
      request.reject(new Error('DHT stopping'));
    }
    this.pendingRequests.clear();
    
    // ソケットのクローズ
    if (this.socket) {
      this.socket.close();
    }
    
    this.emit('stopped');
  }
}

// ペンディングリクエスト
interface PendingRequest {
  message: DHTMessage;
  node: DHTNode;
  timestamp: number;
  resolve: (value: DHTMessage) => void;
  reject: (error: Error) => void;
}

export default DHTManager;