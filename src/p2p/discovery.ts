/**
 * P2Pディスカバリー実装
 * 効率的なピア発見メカニズム
 * 
 * 設計思想：
 * - Carmack: 高速で効率的なピア発見
 * - Martin: 拡張可能なディスカバリープロトコル
 * - Pike: シンプルで信頼性の高い実装
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import * as dgram from 'dgram';
import * as dns from 'dns/promises';

// === 型定義 ===
export interface DiscoveryConfig {
  // 基本設定
  nodeId: string;                   // 自ノードのID
  listenPort: number;              // リスニングポート
  
  // ディスカバリー方法
  methods: {
    dht: boolean;                  // DHT使用
    mdns: boolean;                 // mDNS（ローカル）
    bootstrap: boolean;            // ブートストラップノード
    dns: boolean;                  // DNSシード
    tracker: boolean;              // トラッカーサーバー
  };
  
  // ブートストラップ設定
  bootstrapNodes: PeerInfo[];      // 初期接続ノード
  dnsSeeds?: string[];            // DNSシードサーバー
  trackerUrls?: string[];         // トラッカーURL
  
  // タイミング設定
  discoveryInterval: number;       // ディスカバリー間隔（秒）
  refreshInterval: number;         // ピアリスト更新間隔
  announceInterval: number;        // アナウンス間隔
  
  // 制限設定
  maxPeers: number;               // 最大ピア数
  maxPeersPerSource: number;      // ソースごとの最大ピア数
  minPeers: number;               // 最小ピア数（これ以下で積極的に探索）
  
  // フィルター設定
  peerFilter?: (peer: PeerInfo) => boolean;
  preferredCountries?: string[];   // 優先国コード
  avoidCountries?: string[];      // 回避国コード
}

export interface PeerInfo {
  nodeId: string;
  address: string;
  port: number;
  
  // メタデータ
  version?: string;
  protocol?: string;
  capabilities?: string[];
  
  // ネットワーク情報
  publicKey?: string;
  country?: string;
  asn?: number;
  latency?: number;
  
  // ディスカバリー情報
  source: DiscoverySource;
  discoveredAt: number;
  lastSeen: number;
  failedAttempts: number;
  
  // 統計情報
  reputation?: number;
  sharedPeers?: number;
}

export enum DiscoverySource {
  DHT = 'dht',
  MDNS = 'mdns',
  BOOTSTRAP = 'bootstrap',
  DNS = 'dns',
  TRACKER = 'tracker',
  PEER_EXCHANGE = 'peer_exchange',
  MANUAL = 'manual'
}

export interface DiscoveryMessage {
  type: 'announce' | 'query' | 'response' | 'ping' | 'pong';
  nodeId: string;
  timestamp: number;
  data?: any;
  signature?: string;
}

export interface AnnounceData {
  address: string;
  port: number;
  version: string;
  capabilities: string[];
  maxPeers: number;
}

export interface QueryData {
  target?: string;              // 探しているノードID
  count?: number;              // 要求するピア数
  filters?: {
    version?: string;
    capabilities?: string[];
    country?: string;
  };
}

export interface ResponseData {
  peers: PeerInfo[];
  more: boolean;               // さらにピアがあるか
}

// === P2Pディスカバリーマネージャー ===
export class P2PDiscoveryManager extends EventEmitter {
  private config: DiscoveryConfig;
  private peers: Map<string, PeerInfo> = new Map();
  private pendingQueries: Map<string, QueryContext> = new Map();
  private discoverySocket?: dgram.Socket;
  private discoveryTimer?: NodeJS.Timeout;
  private announceTimer?: NodeJS.Timeout;
  
  // ソースごとのピア管理
  private peersBySource: Map<DiscoverySource, Set<string>> = new Map();
  
  // 統計情報
  private statistics = {
    peersDiscovered: 0,
    peersConnected: 0,
    queriesSent: 0,
    queriesReceived: 0,
    announcesSent: 0,
    announcesReceived: 0
  };
  
  constructor(config: DiscoveryConfig) {
    super();
    this.config = config;
    
    // ソースの初期化
    for (const source of Object.values(DiscoverySource)) {
      this.peersBySource.set(source as DiscoverySource, new Set());
    }
  }
  
  // ディスカバリーの開始
  async start(): Promise<void> {
    try {
      // UDPソケットの作成
      if (this.config.methods.dht || this.config.methods.mdns) {
        await this.setupDiscoverySocket();
      }
      
      // ブートストラップノードの追加
      if (this.config.methods.bootstrap) {
        this.addBootstrapNodes();
      }
      
      // DNSシードからのピア取得
      if (this.config.methods.dns && this.config.dnsSeeds) {
        await this.queryDNSSeeds();
      }
      
      // 定期的なディスカバリー
      this.startPeriodicDiscovery();
      
      // 定期的なアナウンス
      this.startPeriodicAnnounce();
      
      // mDNSの開始
      if (this.config.methods.mdns) {
        await this.startMDNS();
      }
      
      this.emit('started');
      
    } catch (error) {
      this.emit('error', { error, context: 'start' });
      throw error;
    }
  }
  
  // UDPディスカバリーソケットのセットアップ
  private async setupDiscoverySocket(): Promise<void> {
    this.discoverySocket = dgram.createSocket('udp4');
    
    this.discoverySocket.on('message', (msg, rinfo) => {
      this.handleDiscoveryMessage(msg, rinfo);
    });
    
    this.discoverySocket.on('error', (error) => {
      this.emit('socketError', error);
    });
    
    await new Promise<void>((resolve, reject) => {
      this.discoverySocket!.bind(this.config.listenPort, () => {
        resolve();
      });
      
      this.discoverySocket!.on('error', reject);
    });
  }
  
  // ディスカバリーメッセージの処理
  private async handleDiscoveryMessage(
    msg: Buffer,
    rinfo: dgram.RemoteInfo
  ): Promise<void> {
    try {
      const message: DiscoveryMessage = JSON.parse(msg.toString());
      
      // 署名検証（実装依存）
      if (!this.verifyMessage(message)) {
        return;
      }
      
      // 自分からのメッセージは無視
      if (message.nodeId === this.config.nodeId) {
        return;
      }
      
      switch (message.type) {
        case 'announce':
          await this.handleAnnounce(message, rinfo);
          break;
          
        case 'query':
          await this.handleQuery(message, rinfo);
          break;
          
        case 'response':
          await this.handleResponse(message, rinfo);
          break;
          
        case 'ping':
          await this.handlePing(message, rinfo);
          break;
          
        case 'pong':
          await this.handlePong(message, rinfo);
          break;
      }
      
    } catch (error) {
      this.emit('messageError', { error, rinfo });
    }
  }
  
  // アナウンスの処理
  private async handleAnnounce(
    message: DiscoveryMessage,
    rinfo: dgram.RemoteInfo
  ): Promise<void> {
    this.statistics.announcesReceived++;
    
    const announceData = message.data as AnnounceData;
    
    const peerInfo: PeerInfo = {
      nodeId: message.nodeId,
      address: announceData.address || rinfo.address,
      port: announceData.port,
      version: announceData.version,
      capabilities: announceData.capabilities,
      source: DiscoverySource.DHT,
      discoveredAt: Date.now(),
      lastSeen: Date.now(),
      failedAttempts: 0
    };
    
    // フィルター適用
    if (this.config.peerFilter && !this.config.peerFilter(peerInfo)) {
      return;
    }
    
    // ピアの追加
    this.addPeer(peerInfo);
    
    // 相手にもピアを共有（ピア交換）
    if (this.shouldSharePeers()) {
      await this.sharePeers(message.nodeId, rinfo);
    }
  }
  
  // クエリの処理
  private async handleQuery(
    message: DiscoveryMessage,
    rinfo: dgram.RemoteInfo
  ): Promise<void> {
    this.statistics.queriesReceived++;
    
    const queryData = message.data as QueryData;
    
    // 適合するピアを検索
    const matchingPeers = this.findMatchingPeers(queryData);
    
    // レスポンスの送信
    const response: DiscoveryMessage = {
      type: 'response',
      nodeId: this.config.nodeId,
      timestamp: Date.now(),
      data: {
        peers: matchingPeers.slice(0, queryData.count || 10),
        more: matchingPeers.length > (queryData.count || 10)
      }
    };
    
    await this.sendMessage(response, rinfo.address, rinfo.port);
  }
  
  // レスポンスの処理
  private async handleResponse(
    message: DiscoveryMessage,
    rinfo: dgram.RemoteInfo
  ): Promise<void> {
    const responseData = message.data as ResponseData;
    
    // ペンディングクエリの確認
    const queryContext = this.findPendingQuery(message.nodeId);
    if (queryContext) {
      queryContext.responses.push(responseData);
    }
    
    // ピアの追加
    for (const peer of responseData.peers) {
      peer.source = DiscoverySource.PEER_EXCHANGE;
      this.addPeer(peer);
    }
    
    // さらにピアがある場合は追加クエリ
    if (responseData.more && this.peers.size < this.config.maxPeers) {
      await this.queryPeer(message.nodeId, rinfo);
    }
  }
  
  // Pingの処理
  private async handlePing(
    message: DiscoveryMessage,
    rinfo: dgram.RemoteInfo
  ): Promise<void> {
    // Pongを返す
    const pong: DiscoveryMessage = {
      type: 'pong',
      nodeId: this.config.nodeId,
      timestamp: Date.now()
    };
    
    await this.sendMessage(pong, rinfo.address, rinfo.port);
    
    // ピア情報の更新
    const peer = this.peers.get(message.nodeId);
    if (peer) {
      peer.lastSeen = Date.now();
    }
  }
  
  // Pongの処理
  private async handlePong(
    message: DiscoveryMessage,
    rinfo: dgram.RemoteInfo
  ): Promise<void> {
    const peer = this.peers.get(message.nodeId);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.failedAttempts = 0;
      
      // レイテンシーの計算
      const pingTime = this.getPingTime(message.nodeId);
      if (pingTime) {
        peer.latency = Date.now() - pingTime;
      }
    }
  }
  
  // ピアの追加
  private addPeer(peerInfo: PeerInfo): boolean {
    // 自分自身は追加しない
    if (peerInfo.nodeId === this.config.nodeId) {
      return false;
    }
    
    // 最大ピア数チェック
    if (this.peers.size >= this.config.maxPeers) {
      // 最も価値の低いピアと交換
      const worstPeer = this.findWorstPeer();
      if (worstPeer && this.comparePeers(peerInfo, worstPeer) > 0) {
        this.removePeer(worstPeer.nodeId);
      } else {
        return false;
      }
    }
    
    // ソースごとの制限チェック
    const sourceSet = this.peersBySource.get(peerInfo.source)!;
    if (sourceSet.size >= this.config.maxPeersPerSource) {
      return false;
    }
    
    // 既存のピアの更新または新規追加
    const existingPeer = this.peers.get(peerInfo.nodeId);
    if (existingPeer) {
      // 情報の更新
      Object.assign(existingPeer, {
        ...peerInfo,
        discoveredAt: existingPeer.discoveredAt,
        reputation: existingPeer.reputation
      });
    } else {
      // 新規追加
      this.peers.set(peerInfo.nodeId, peerInfo);
      sourceSet.add(peerInfo.nodeId);
      this.statistics.peersDiscovered++;
      
      this.emit('peerDiscovered', peerInfo);
    }
    
    return true;
  }
  
  // ピアの削除
  private removePeer(nodeId: string): void {
    const peer = this.peers.get(nodeId);
    if (!peer) return;
    
    this.peers.delete(nodeId);
    
    const sourceSet = this.peersBySource.get(peer.source);
    if (sourceSet) {
      sourceSet.delete(nodeId);
    }
    
    this.emit('peerRemoved', peer);
  }
  
  // 定期的なディスカバリー
  private startPeriodicDiscovery(): void {
    this.discoveryTimer = setInterval(async () => {
      try {
        // ピア数が少ない場合は積極的に探索
        if (this.peers.size < this.config.minPeers) {
          await this.aggressiveDiscovery();
        } else {
          await this.normalDiscovery();
        }
        
        // 古いピアのクリーンアップ
        this.cleanupOldPeers();
        
      } catch (error) {
        this.emit('discoveryError', error);
      }
    }, this.config.discoveryInterval * 1000);
  }
  
  // 積極的なディスカバリー
  private async aggressiveDiscovery(): Promise<void> {
    const promises: Promise<void>[] = [];
    
    // すべての方法を使用
    if (this.config.methods.dht) {
      promises.push(this.queryRandomPeers(10));
    }
    
    if (this.config.methods.dns && this.config.dnsSeeds) {
      promises.push(this.queryDNSSeeds());
    }
    
    if (this.config.methods.tracker && this.config.trackerUrls) {
      promises.push(this.queryTrackers());
    }
    
    await Promise.allSettled(promises);
  }
  
  // 通常のディスカバリー
  private async normalDiscovery(): Promise<void> {
    // ランダムに数個のピアにクエリ
    await this.queryRandomPeers(3);
  }
  
  // ランダムなピアへのクエリ
  private async queryRandomPeers(count: number): Promise<void> {
    const activePeers = Array.from(this.peers.values())
      .filter(p => Date.now() - p.lastSeen < 3600000); // 1時間以内
    
    // ランダムに選択
    const selectedPeers = this.shuffleArray(activePeers).slice(0, count);
    
    for (const peer of selectedPeers) {
      await this.queryPeer(peer.nodeId, {
        address: peer.address,
        port: peer.port,
        family: 'IPv4',
        size: 0
      });
    }
  }
  
  // 特定のピアへのクエリ
  private async queryPeer(
    nodeId: string,
    rinfo: { address: string; port: number }
  ): Promise<void> {
    const query: DiscoveryMessage = {
      type: 'query',
      nodeId: this.config.nodeId,
      timestamp: Date.now(),
      data: {
        count: 20,
        filters: {
          version: this.config.nodeId // 互換性のあるバージョン
        }
      }
    };
    
    // クエリコンテキストの保存
    this.pendingQueries.set(nodeId, {
      query,
      timestamp: Date.now(),
      responses: []
    });
    
    await this.sendMessage(query, rinfo.address, rinfo.port);
    this.statistics.queriesSent++;
    
    // タイムアウト設定
    setTimeout(() => {
      this.pendingQueries.delete(nodeId);
    }, 30000);
  }
  
  // 定期的なアナウンス
  private startPeriodicAnnounce(): void {
    this.announceTimer = setInterval(async () => {
      await this.announceToNetwork();
    }, this.config.announceInterval * 1000);
    
    // 初回アナウンス
    this.announceToNetwork();
  }
  
  // ネットワークへのアナウンス
  private async announceToNetwork(): Promise<void> {
    const announce: DiscoveryMessage = {
      type: 'announce',
      nodeId: this.config.nodeId,
      timestamp: Date.now(),
      data: {
        address: this.getPublicAddress(),
        port: this.config.listenPort,
        version: '1.0.0',
        capabilities: ['mining', 'p2p'],
        maxPeers: this.config.maxPeers
      }
    };
    
    // アクティブなピアにアナウンス
    const activePeers = Array.from(this.peers.values())
      .filter(p => Date.now() - p.lastSeen < 3600000)
      .slice(0, 20); // 最大20ピア
    
    for (const peer of activePeers) {
      await this.sendMessage(announce, peer.address, peer.port);
    }
    
    this.statistics.announcesSent++;
  }
  
  // ブートストラップノードの追加
  private addBootstrapNodes(): void {
    for (const node of this.config.bootstrapNodes) {
      node.source = DiscoverySource.BOOTSTRAP;
      this.addPeer(node);
    }
  }
  
  // DNSシードからのピア取得
  private async queryDNSSeeds(): Promise<void> {
    if (!this.config.dnsSeeds) return;
    
    const promises = this.config.dnsSeeds.map(async (seed) => {
      try {
        const addresses = await dns.resolve4(seed);
        
        for (const address of addresses) {
          const peerInfo: PeerInfo = {
            nodeId: this.generateNodeId(address),
            address,
            port: this.config.listenPort, // デフォルトポート
            source: DiscoverySource.DNS,
            discoveredAt: Date.now(),
            lastSeen: Date.now(),
            failedAttempts: 0
          };
          
          this.addPeer(peerInfo);
        }
      } catch (error) {
        this.emit('dnsSeedError', { seed, error });
      }
    });
    
    await Promise.allSettled(promises);
  }
  
  // トラッカーからのピア取得
  private async queryTrackers(): Promise<void> {
    // トラッカー実装（HTTP/WebSocket）
    // 実装依存
  }
  
  // mDNSの開始
  private async startMDNS(): Promise<void> {
    // mDNS実装（ローカルネットワークディスカバリー）
    // 実装依存
  }
  
  // メッセージの送信
  private async sendMessage(
    message: DiscoveryMessage,
    address: string,
    port: number
  ): Promise<void> {
    if (!this.discoverySocket) return;
    
    // 署名の追加（実装依存）
    message.signature = this.signMessage(message);
    
    const data = Buffer.from(JSON.stringify(message));
    
    this.discoverySocket.send(data, port, address, (error) => {
      if (error) {
        this.emit('sendError', { error, address, port });
      }
    });
  }
  
  // ピアとの共有
  private async sharePeers(
    targetNodeId: string,
    rinfo: dgram.RemoteInfo
  ): Promise<void> {
    // 共有するピアを選択
    const peersToShare = this.selectPeersToShare(targetNodeId);
    
    if (peersToShare.length === 0) return;
    
    const response: DiscoveryMessage = {
      type: 'response',
      nodeId: this.config.nodeId,
      timestamp: Date.now(),
      data: {
        peers: peersToShare,
        more: false
      }
    };
    
    await this.sendMessage(response, rinfo.address, rinfo.port);
  }
  
  // 共有するピアの選択
  private selectPeersToShare(excludeNodeId: string): PeerInfo[] {
    return Array.from(this.peers.values())
      .filter(p => 
        p.nodeId !== excludeNodeId &&
        Date.now() - p.lastSeen < 3600000 && // 1時間以内
        p.reputation !== undefined && p.reputation > 0
      )
      .sort((a, b) => (b.reputation || 0) - (a.reputation || 0))
      .slice(0, 10)
      .map(p => ({
        ...p,
        // プライバシー保護のため一部情報を削除
        publicKey: undefined,
        reputation: undefined
      }));
  }
  
  // マッチするピアの検索
  private findMatchingPeers(query: QueryData): PeerInfo[] {
    return Array.from(this.peers.values()).filter(peer => {
      // ターゲット指定の場合
      if (query.target) {
        const distance = this.calculateDistance(peer.nodeId, query.target);
        return distance < 10; // 近いピアのみ
      }
      
      // フィルター適用
      if (query.filters) {
        if (query.filters.version && peer.version !== query.filters.version) {
          return false;
        }
        
        if (query.filters.capabilities) {
          const hasAll = query.filters.capabilities.every(cap =>
            peer.capabilities?.includes(cap)
          );
          if (!hasAll) return false;
        }
        
        if (query.filters.country && peer.country !== query.filters.country) {
          return false;
        }
      }
      
      return true;
    });
  }
  
  // 古いピアのクリーンアップ
  private cleanupOldPeers(): void {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24時間
    
    for (const [nodeId, peer] of this.peers) {
      if (now - peer.lastSeen > maxAge) {
        this.removePeer(nodeId);
      }
    }
  }
  
  // ユーティリティメソッド
  private verifyMessage(message: DiscoveryMessage): boolean {
    // 署名検証（実装依存）
    return true;
  }
  
  private signMessage(message: DiscoveryMessage): string {
    // メッセージ署名（実装依存）
    return 'mock_signature';
  }
  
  private shouldSharePeers(): boolean {
    // ピア共有の判断
    return this.peers.size > 5 && Math.random() > 0.5;
  }
  
  private findPendingQuery(nodeId: string): QueryContext | undefined {
    return this.pendingQueries.get(nodeId);
  }
  
  private getPingTime(nodeId: string): number | undefined {
    // Ping時刻の取得（実装依存）
    return undefined;
  }
  
  private findWorstPeer(): PeerInfo | undefined {
    let worst: PeerInfo | undefined;
    let worstScore = Infinity;
    
    for (const peer of this.peers.values()) {
      const score = this.calculatePeerScore(peer);
      if (score < worstScore) {
        worst = peer;
        worstScore = score;
      }
    }
    
    return worst;
  }
  
  private comparePeers(a: PeerInfo, b: PeerInfo): number {
    return this.calculatePeerScore(a) - this.calculatePeerScore(b);
  }
  
  private calculatePeerScore(peer: PeerInfo): number {
    let score = 0;
    
    // レイテンシー（低いほど良い）
    if (peer.latency) {
      score -= peer.latency / 1000;
    }
    
    // 最近の活動
    const age = Date.now() - peer.lastSeen;
    score -= age / (60 * 60 * 1000); // 時間単位
    
    // 失敗回数
    score -= peer.failedAttempts * 10;
    
    // レピュテーション
    score += (peer.reputation || 50);
    
    // 国の優先度
    if (this.config.preferredCountries?.includes(peer.country || '')) {
      score += 20;
    }
    if (this.config.avoidCountries?.includes(peer.country || '')) {
      score -= 30;
    }
    
    return score;
  }
  
  private generateNodeId(input: string): string {
    return createHash('sha256').update(input).digest('hex').substring(0, 40);
  }
  
  private getPublicAddress(): string {
    // パブリックIPアドレスの取得（実装依存）
    return '0.0.0.0';
  }
  
  private calculateDistance(nodeId1: string, nodeId2: string): number {
    // XOR距離の計算（簡略化）
    let distance = 0;
    for (let i = 0; i < Math.min(nodeId1.length, nodeId2.length); i++) {
      if (nodeId1[i] !== nodeId2[i]) {
        distance++;
      }
    }
    return distance;
  }
  
  private shuffleArray<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
  
  // 公開API
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }
  
  getPeer(nodeId: string): PeerInfo | null {
    return this.peers.get(nodeId) || null;
  }
  
  getPeerCount(): number {
    return this.peers.size;
  }
  
  getActivePeerCount(): number {
    const now = Date.now();
    return Array.from(this.peers.values())
      .filter(p => now - p.lastSeen < 3600000).length;
  }
  
  getStatistics(): typeof this.statistics {
    return { ...this.statistics };
  }
  
  async addManualPeer(address: string, port: number): Promise<void> {
    const peerInfo: PeerInfo = {
      nodeId: this.generateNodeId(`${address}:${port}`),
      address,
      port,
      source: DiscoverySource.MANUAL,
      discoveredAt: Date.now(),
      lastSeen: Date.now(),
      failedAttempts: 0
    };
    
    this.addPeer(peerInfo);
    
    // 即座にPingを送信
    await this.pingPeer(peerInfo);
  }
  
  async pingPeer(peer: PeerInfo): Promise<void> {
    const ping: DiscoveryMessage = {
      type: 'ping',
      nodeId: this.config.nodeId,
      timestamp: Date.now()
    };
    
    await this.sendMessage(ping, peer.address, peer.port);
  }
  
  async stop(): Promise<void> {
    // タイマーの停止
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
    }
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
    }
    
    // ソケットのクローズ
    if (this.discoverySocket) {
      this.discoverySocket.close();
    }
    
    this.emit('stopped');
  }
}

// クエリコンテキスト
interface QueryContext {
  query: DiscoveryMessage;
  timestamp: number;
  responses: ResponseData[];
}

export default P2PDiscoveryManager;