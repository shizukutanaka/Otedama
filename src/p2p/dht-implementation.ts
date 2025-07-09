/**
 * DHT (Distributed Hash Table) 実装
 * Kademlia アルゴリズムに基づく分散ハッシュテーブル
 * 
 * 設計思想：
 * - Carmack: 高速なルーティングとルックアップ
 * - Martin: 拡張可能な分散データ構造
 * - Pike: シンプルで理解しやすいDHT実装
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';
import * as dgram from 'dgram';

// === 型定義 ===
export interface DHTConfig {
  nodeId: string;                  // 160ビットのノードID
  bootstrapNodes: string[];        // ブートストラップノードのリスト
  port: number;                    // リスニングポート
  
  // Kademlia パラメータ
  k: number;                       // k-bucket サイズ（デフォルト: 20）
  alpha: number;                   // 並行度（デフォルト: 3）
  
  // タイムアウト設定
  requestTimeout: number;          // RPCタイムアウト（ms）
  refreshInterval: number;         // バケットリフレッシュ間隔（秒）
  republishInterval: number;       // 値の再公開間隔（秒）
  expireInterval: number;          // 値の有効期限（秒）
  
  // ネットワーク設定
  maxConcurrentRequests: number;   // 最大同時リクエスト数
  rateLimitPerSecond: number;      // レート制限
}

export interface DHTNode {
  id: string;                      // ノードID
  address: string;                 // IPアドレス
  port: number;                    // ポート番号
  
  // 状態情報
  lastSeen: number;               // 最終接触時刻
  rtt: number;                    // Round Trip Time
  failedRequests: number;         // 失敗したリクエスト数
  
  // メタデータ
  version?: string;
  services?: string[];
}

export interface KBucket {
  nodes: DHTNode[];               // ノードリスト
  lastRefresh: number;            // 最終リフレッシュ時刻
  depth: number;                  // バケットの深さ（ビット位置）
}

export interface DHTMessage {
  type: 'ping' | 'pong' | 'find_node' | 'find_value' | 'store';
  transactionId: string;
  nodeId: string;
  
  // メッセージ固有のデータ
  target?: string;                // find_node/find_value用
  nodes?: DHTNode[];              // レスポンス用
  value?: Buffer;                 // store/find_value用
  key?: string;                   // store用
}

export interface StoredValue {
  key: string;
  value: Buffer;
  publisher: string;              // 公開者のノードID
  timestamp: number;              // 保存時刻
  expiry: number;                 // 有効期限
}

// === DHTマネージャー ===
export class DHTManager extends EventEmitter {
  private config: DHTConfig;
  private nodeId: Buffer;
  private routingTable: KBucket[] = [];
  private storage: Map<string, StoredValue> = new Map();
  private socket?: dgram.Socket;
  private pendingRequests: Map<string, {
    callback: (response: DHTMessage) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  
  // メトリクス
  private metrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    storedValues: 0,
    lookups: 0,
    averageRTT: 0
  };
  
  constructor(config: DHTConfig) {
    super();
    this.config = config;
    this.nodeId = Buffer.from(config.nodeId, 'hex');
    
    // ルーティングテーブルの初期化（160ビット）
    for (let i = 0; i < 160; i++) {
      this.routingTable[i] = {
        nodes: [],
        lastRefresh: Date.now(),
        depth: i
      };
    }
  }
  
  // DHTの起動
  async start(): Promise<void> {
    try {
      // UDPソケットの作成
      this.socket = dgram.createSocket('udp4');
      this.setupSocketHandlers();
      
      // ソケットのバインド
      await new Promise<void>((resolve, reject) => {
        this.socket!.bind(this.config.port, () => {
          resolve();
        });
        
        this.socket!.on('error', reject);
      });
      
      // ブートストラップ
      await this.bootstrap();
      
      // 定期的なメンテナンス
      this.startMaintenance();
      
      this.emit('started', {
        nodeId: this.config.nodeId,
        port: this.config.port
      });
      
    } catch (error) {
      this.emit('error', { error, context: 'start' });
      throw error;
    }
  }
  
  // ブートストラップ処理
  private async bootstrap(): Promise<void> {
    if (this.config.bootstrapNodes.length === 0) {
      return;
    }
    
    // ブートストラップノードにpingを送信
    for (const node of this.config.bootstrapNodes) {
      const [address, port] = node.split(':');
      
      try {
        await this.ping(address, parseInt(port));
        
        // 自分のIDに近いノードを探す
        await this.iterativeFindNode(this.config.nodeId);
        
      } catch (error) {
        this.emit('bootstrapError', { node, error });
      }
    }
  }
  
  // ソケットハンドラーの設定
  private setupSocketHandlers(): void {
    if (!this.socket) return;
    
    this.socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo);
    });
    
    this.socket.on('error', (error) => {
      this.emit('socketError', error);
    });
  }
  
  // メッセージ処理
  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const message: DHTMessage = JSON.parse(msg.toString());
      
      // ノードをルーティングテーブルに追加
      const node: DHTNode = {
        id: message.nodeId,
        address: rinfo.address,
        port: rinfo.port,
        lastSeen: Date.now(),
        rtt: 0,
        failedRequests: 0
      };
      
      this.updateRoutingTable(node);
      
      // メッセージタイプに応じた処理
      switch (message.type) {
        case 'ping':
          this.handlePing(message, rinfo);
          break;
          
        case 'pong':
          this.handlePong(message);
          break;
          
        case 'find_node':
          this.handleFindNode(message, rinfo);
          break;
          
        case 'find_value':
          this.handleFindValue(message, rinfo);
          break;
          
        case 'store':
          this.handleStore(message, rinfo);
          break;
      }
      
    } catch (error) {
      this.emit('messageError', { error, rinfo });
    }
  }
  
  // Pingハンドラー
  private handlePing(message: DHTMessage, rinfo: dgram.RemoteInfo): void {
    const response: DHTMessage = {
      type: 'pong',
      transactionId: message.transactionId,
      nodeId: this.config.nodeId
    };
    
    this.sendMessage(response, rinfo.address, rinfo.port);
  }
  
  // Pongハンドラー
  private handlePong(message: DHTMessage): void {
    const pending = this.pendingRequests.get(message.transactionId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.callback(message);
      this.pendingRequests.delete(message.transactionId);
      this.metrics.successfulRequests++;
    }
  }
  
  // Find Nodeハンドラー
  private handleFindNode(message: DHTMessage, rinfo: dgram.RemoteInfo): void {
    if (!message.target) return;
    
    // ターゲットに最も近いk個のノードを返す
    const closestNodes = this.findClosestNodes(message.target, this.config.k);
    
    const response: DHTMessage = {
      type: 'find_node',
      transactionId: message.transactionId,
      nodeId: this.config.nodeId,
      nodes: closestNodes
    };
    
    this.sendMessage(response, rinfo.address, rinfo.port);
  }
  
  // Find Valueハンドラー
  private handleFindValue(message: DHTMessage, rinfo: dgram.RemoteInfo): void {
    if (!message.target) return;
    
    // 値が保存されているかチェック
    const storedValue = this.storage.get(message.target);
    
    if (storedValue && storedValue.expiry > Date.now()) {
      // 値を返す
      const response: DHTMessage = {
        type: 'find_value',
        transactionId: message.transactionId,
        nodeId: this.config.nodeId,
        value: storedValue.value
      };
      
      this.sendMessage(response, rinfo.address, rinfo.port);
    } else {
      // 最も近いノードを返す
      this.handleFindNode(message, rinfo);
    }
  }
  
  // Storeハンドラー
  private handleStore(message: DHTMessage, rinfo: dgram.RemoteInfo): void {
    if (!message.key || !message.value) return;
    
    // 値を保存
    const storedValue: StoredValue = {
      key: message.key,
      value: message.value,
      publisher: message.nodeId,
      timestamp: Date.now(),
      expiry: Date.now() + this.config.expireInterval * 1000
    };
    
    this.storage.set(message.key, storedValue);
    this.metrics.storedValues++;
    
    // 確認応答
    const response: DHTMessage = {
      type: 'store',
      transactionId: message.transactionId,
      nodeId: this.config.nodeId
    };
    
    this.sendMessage(response, rinfo.address, rinfo.port);
    
    this.emit('valueStored', { key: message.key });
  }
  
  // ルーティングテーブルの更新
  private updateRoutingTable(node: DHTNode): void {
    const distance = this.calculateDistance(this.nodeId, Buffer.from(node.id, 'hex'));
    const bucketIndex = this.getBucketIndex(distance);
    const bucket = this.routingTable[bucketIndex];
    
    // 既存のノードかチェック
    const existingIndex = bucket.nodes.findIndex(n => n.id === node.id);
    
    if (existingIndex !== -1) {
      // 既存ノードを最後に移動（最近使用）
      bucket.nodes.splice(existingIndex, 1);
      bucket.nodes.push(node);
    } else if (bucket.nodes.length < this.config.k) {
      // バケットに空きがある
      bucket.nodes.push(node);
      this.emit('nodeAdded', node);
    } else {
      // バケットが満杯の場合、最も古いノードにpingを送る
      const oldestNode = bucket.nodes[0];
      
      this.ping(oldestNode.address, oldestNode.port).catch(() => {
        // pingが失敗したら、古いノードを新しいノードで置き換える
        bucket.nodes.shift();
        bucket.nodes.push(node);
        this.emit('nodeReplaced', { old: oldestNode, new: node });
      });
    }
  }
  
  // 最も近いノードを検索
  private findClosestNodes(targetId: string, count: number): DHTNode[] {
    const target = Buffer.from(targetId, 'hex');
    const allNodes: Array<{ node: DHTNode; distance: Buffer }> = [];
    
    // すべてのバケットからノードを収集
    for (const bucket of this.routingTable) {
      for (const node of bucket.nodes) {
        const distance = this.calculateDistance(target, Buffer.from(node.id, 'hex'));
        allNodes.push({ node, distance });
      }
    }
    
    // 距離でソート
    allNodes.sort((a, b) => {
      for (let i = 0; i < 20; i++) {
        if (a.distance[i] !== b.distance[i]) {
          return a.distance[i] - b.distance[i];
        }
      }
      return 0;
    });
    
    // 上位k個を返す
    return allNodes.slice(0, count).map(item => item.node);
  }
  
  // 距離計算（XOR）
  private calculateDistance(a: Buffer, b: Buffer): Buffer {
    const distance = Buffer.alloc(20);
    
    for (let i = 0; i < 20; i++) {
      distance[i] = a[i] ^ b[i];
    }
    
    return distance;
  }
  
  // バケットインデックスの取得
  private getBucketIndex(distance: Buffer): number {
    for (let i = 0; i < 160; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      
      if ((distance[byteIndex] >> bitIndex) & 1) {
        return 159 - i;
      }
    }
    
    return 0;
  }
  
  // 反復的なノード検索
  async iterativeFindNode(targetId: string): Promise<DHTNode[]> {
    const target = Buffer.from(targetId, 'hex');
    const shortlist = new Map<string, { node: DHTNode; distance: Buffer; queried: boolean }>();
    const k = this.config.k;
    const alpha = this.config.alpha;
    
    // 初期ノードリスト
    const initialNodes = this.findClosestNodes(targetId, k);
    for (const node of initialNodes) {
      const distance = this.calculateDistance(target, Buffer.from(node.id, 'hex'));
      shortlist.set(node.id, { node, distance, queried: false });
    }
    
    let closestNode: Buffer | null = null;
    let iteration = 0;
    
    while (iteration < 10) { // 最大10回の反復
      // 未クエリのノードを選択
      const nodesToQuery = Array.from(shortlist.values())
        .filter(item => !item.queried)
        .sort((a, b) => {
          for (let i = 0; i < 20; i++) {
            if (a.distance[i] !== b.distance[i]) {
              return a.distance[i] - b.distance[i];
            }
          }
          return 0;
        })
        .slice(0, alpha)
        .map(item => item.node);
      
      if (nodesToQuery.length === 0) {
        break;
      }
      
      // 並行クエリ
      const promises = nodesToQuery.map(node => 
        this.sendFindNode(node, targetId)
      );
      
      const results = await Promise.allSettled(promises);
      
      // 結果の処理
      let foundCloser = false;
      
      for (let i = 0; i < results.length; i++) {
        const node = nodesToQuery[i];
        shortlist.get(node.id)!.queried = true;
        
        if (results[i].status === 'fulfilled') {
          const response = (results[i] as any).value;
          
          if (response.nodes) {
            for (const newNode of response.nodes) {
              const distance = this.calculateDistance(target, Buffer.from(newNode.id, 'hex'));
              
              if (!shortlist.has(newNode.id)) {
                shortlist.set(newNode.id, { node: newNode, distance, queried: false });
                
                // より近いノードが見つかったかチェック
                if (!closestNode || this.isCloser(distance, closestNode)) {
                  closestNode = distance;
                  foundCloser = true;
                }
              }
            }
          }
        }
      }
      
      // より近いノードが見つからなければ終了
      if (!foundCloser) {
        break;
      }
      
      iteration++;
    }
    
    // 最も近いk個のノードを返す
    return Array.from(shortlist.values())
      .sort((a, b) => {
        for (let i = 0; i < 20; i++) {
          if (a.distance[i] !== b.distance[i]) {
            return a.distance[i] - b.distance[i];
          }
        }
        return 0;
      })
      .slice(0, k)
      .map(item => item.node);
  }
  
  // 値の保存
  async store(key: string, value: Buffer): Promise<void> {
    // キーのハッシュを計算
    const keyHash = createHash('sha1').update(key).digest('hex');
    
    // 最も近いノードを検索
    const closestNodes = await this.iterativeFindNode(keyHash);
    
    // 上位k個のノードに保存
    const promises = closestNodes.slice(0, this.config.k).map(node => 
      this.sendStore(node, keyHash, value)
    );
    
    await Promise.allSettled(promises);
    
    this.emit('valuePublished', { key, nodes: closestNodes.length });
  }
  
  // 値の取得
  async findValue(key: string): Promise<Buffer | null> {
    const keyHash = createHash('sha1').update(key).digest('hex');
    this.metrics.lookups++;
    
    // ローカルストレージをチェック
    const local = this.storage.get(keyHash);
    if (local && local.expiry > Date.now()) {
      return local.value;
    }
    
    // 反復的な検索
    const target = Buffer.from(keyHash, 'hex');
    const shortlist = new Map<string, { node: DHTNode; distance: Buffer; queried: boolean }>();
    
    // 初期ノードリスト
    const initialNodes = this.findClosestNodes(keyHash, this.config.k);
    for (const node of initialNodes) {
      const distance = this.calculateDistance(target, Buffer.from(node.id, 'hex'));
      shortlist.set(node.id, { node, distance, queried: false });
    }
    
    let iteration = 0;
    
    while (iteration < 10) {
      const nodesToQuery = Array.from(shortlist.values())
        .filter(item => !item.queried)
        .sort((a, b) => {
          for (let i = 0; i < 20; i++) {
            if (a.distance[i] !== b.distance[i]) {
              return a.distance[i] - b.distance[i];
            }
          }
          return 0;
        })
        .slice(0, this.config.alpha)
        .map(item => item.node);
      
      if (nodesToQuery.length === 0) {
        break;
      }
      
      // 並行クエリ
      const promises = nodesToQuery.map(node => 
        this.sendFindValue(node, keyHash)
      );
      
      const results = await Promise.allSettled(promises);
      
      // 結果の処理
      for (let i = 0; i < results.length; i++) {
        const node = nodesToQuery[i];
        shortlist.get(node.id)!.queried = true;
        
        if (results[i].status === 'fulfilled') {
          const response = (results[i] as any).value;
          
          if (response.value) {
            // 値が見つかった
            return response.value;
          } else if (response.nodes) {
            // より近いノードを追加
            for (const newNode of response.nodes) {
              const distance = this.calculateDistance(target, Buffer.from(newNode.id, 'hex'));
              
              if (!shortlist.has(newNode.id)) {
                shortlist.set(newNode.id, { node: newNode, distance, queried: false });
              }
            }
          }
        }
      }
      
      iteration++;
    }
    
    return null;
  }
  
  // RPC送信メソッド
  private async ping(address: string, port: number): Promise<void> {
    const message: DHTMessage = {
      type: 'ping',
      transactionId: this.generateTransactionId(),
      nodeId: this.config.nodeId
    };
    
    return this.sendRequest(message, address, port);
  }
  
  private async sendFindNode(node: DHTNode, targetId: string): Promise<DHTMessage> {
    const message: DHTMessage = {
      type: 'find_node',
      transactionId: this.generateTransactionId(),
      nodeId: this.config.nodeId,
      target: targetId
    };
    
    return this.sendRequest(message, node.address, node.port);
  }
  
  private async sendFindValue(node: DHTNode, key: string): Promise<DHTMessage> {
    const message: DHTMessage = {
      type: 'find_value',
      transactionId: this.generateTransactionId(),
      nodeId: this.config.nodeId,
      target: key
    };
    
    return this.sendRequest(message, node.address, node.port);
  }
  
  private async sendStore(node: DHTNode, key: string, value: Buffer): Promise<DHTMessage> {
    const message: DHTMessage = {
      type: 'store',
      transactionId: this.generateTransactionId(),
      nodeId: this.config.nodeId,
      key,
      value
    };
    
    return this.sendRequest(message, node.address, node.port);
  }
  
  // リクエスト送信の共通処理
  private sendRequest(message: DHTMessage, address: string, port: number): Promise<DHTMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(message.transactionId);
        this.metrics.failedRequests++;
        reject(new Error('Request timeout'));
      }, this.config.requestTimeout);
      
      this.pendingRequests.set(message.transactionId, {
        callback: resolve,
        timeout
      });
      
      this.sendMessage(message, address, port);
      this.metrics.totalRequests++;
    });
  }
  
  // メッセージ送信
  private sendMessage(message: DHTMessage, address: string, port: number): void {
    const data = Buffer.from(JSON.stringify(message));
    this.socket?.send(data, port, address);
  }
  
  // メンテナンスタスクの開始
  private startMaintenance(): void {
    // バケットリフレッシュ
    setInterval(() => {
      this.refreshBuckets();
    }, this.config.refreshInterval * 1000);
    
    // 期限切れ値の削除
    setInterval(() => {
      this.cleanupExpiredValues();
    }, 60000);
    
    // 値の再公開
    setInterval(() => {
      this.republishValues();
    }, this.config.republishInterval * 1000);
  }
  
  // バケットのリフレッシュ
  private async refreshBuckets(): Promise<void> {
    const now = Date.now();
    
    for (let i = 0; i < this.routingTable.length; i++) {
      const bucket = this.routingTable[i];
      
      if (now - bucket.lastRefresh > this.config.refreshInterval * 1000) {
        // ランダムなIDを生成してそのバケット内を検索
        const randomId = this.generateRandomIdInBucket(i);
        await this.iterativeFindNode(randomId);
        
        bucket.lastRefresh = now;
      }
    }
  }
  
  // 期限切れ値のクリーンアップ
  private cleanupExpiredValues(): void {
    const now = Date.now();
    
    for (const [key, value] of this.storage) {
      if (value.expiry < now) {
        this.storage.delete(key);
        this.metrics.storedValues--;
      }
    }
  }
  
  // 値の再公開
  private async republishValues(): Promise<void> {
    for (const [key, value] of this.storage) {
      if (value.publisher === this.config.nodeId) {
        // 自分が公開した値のみ再公開
        await this.store(key, value.value);
      }
    }
  }
  
  // ヘルパーメソッド
  private generateTransactionId(): string {
    return randomBytes(16).toString('hex');
  }
  
  private generateRandomIdInBucket(bucketIndex: number): string {
    const id = randomBytes(20);
    
    // 特定のバケットに属するようにビットを設定
    const bitIndex = 159 - bucketIndex;
    const byteIndex = Math.floor(bitIndex / 8);
    const bitPosition = 7 - (bitIndex % 8);
    
    // 該当ビットを1に設定
    id[byteIndex] |= (1 << bitPosition);
    
    // それより上位のビットを0に設定
    for (let i = 0; i < bitIndex; i++) {
      const bi = Math.floor(i / 8);
      const bp = 7 - (i % 8);
      id[bi] &= ~(1 << bp);
    }
    
    return id.toString('hex');
  }
  
  private isCloser(a: Buffer, b: Buffer): boolean {
    for (let i = 0; i < 20; i++) {
      if (a[i] !== b[i]) {
        return a[i] < b[i];
      }
    }
    return false;
  }
  
  // 公開API
  async findNodes(targetId: string): Promise<DHTNode[]> {
    return this.iterativeFindNode(targetId);
  }
  
  async put(key: string, value: Buffer): Promise<void> {
    return this.store(key, value);
  }
  
  async get(key: string): Promise<Buffer | null> {
    return this.findValue(key);
  }
  
  getRoutingTableSize(): number {
    return this.routingTable.reduce((sum, bucket) => sum + bucket.nodes.length, 0);
  }
  
  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }
  
  async stop(): Promise<void> {
    // すべてのペンディングリクエストをキャンセル
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
    }
    this.pendingRequests.clear();
    
    // ソケットをクローズ
    if (this.socket) {
      this.socket.close();
    }
    
    this.emit('stopped');
  }
}

export default DHTManager;