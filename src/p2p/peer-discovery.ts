/**
 * P2Pディスカバリー実装
 * 分散ネットワークでのピア発見メカニズム
 * 
 * 設計思想：
 * - Carmack: 効率的なピア発見アルゴリズム
 * - Martin: 拡張可能なディスカバリー戦略
 * - Pike: シンプルで信頼性の高い実装
 */

import { EventEmitter } from 'events';
import { DHTManager } from './dht-implementation';
import { createHash } from 'crypto';
import * as dgram from 'dgram';
import * as dns from 'dns/promises';

// === 型定義 ===
export interface DiscoveryConfig {
  // 基本設定
  nodeId: string;                   // 自ノードID
  bootstrapNodes: string[];         // ブートストラップノード
  dnsSeeds?: string[];             // DNSシードサーバー
  
  // ディスカバリー戦略
  strategies: Array<'dht' | 'mdns' | 'dns' | 'tracker' | 'pex'>;
  maxPeers: number;                // 最大ピア数
  minPeers: number;                // 最小ピア数
  targetPeers: number;             // 目標ピア数
  
  // タイミング設定
  discoveryInterval: number;        // 探索間隔（秒）
  refreshInterval: number;         // リフレッシュ間隔（秒）
  peerTimeout: number;             // ピアタイムアウト（秒）
  
  // mDNS設定
  mdnsEnabled: boolean;
  mdnsServiceName: string;
  mdnsPort: number;
  
  // Tracker設定
  trackers?: string[];             // トラッカーURL
  announceInterval: number;        // アナウンス間隔（秒）
  
  // PEX（Peer Exchange）設定
  pexEnabled: boolean;
  pexMaxPeers: number;             // PEXで交換する最大ピア数
}

export interface Peer {
  id: string;
  address: string;
  port: number;
  
  // ピア情報
  version?: string;
  services: string[];              // 提供サービス
  lastSeen: number;
  discoveredVia: DiscoveryMethod;
  
  // 接続情報
  connected: boolean;
  connectionAttempts: number;
  lastConnectionAttempt?: number;
  
  // メタデータ
  metadata: {
    country?: string;
    asn?: string;
    latency?: number;
    bandwidth?: number;
    [key: string]: any;
  };
}

export type DiscoveryMethod = 
  | 'dht' 
  | 'mdns' 
  | 'dns' 
  | 'tracker' 
  | 'pex' 
  | 'manual' 
  | 'incoming';

export interface DiscoveryResult {
  method: DiscoveryMethod;
  peers: Peer[];
  timestamp: number;
  duration: number;
}

export interface PeerExchangeMessage {
  type: 'pex_request' | 'pex_response';
  peers: Array<{
    id: string;
    address: string;
    port: number;
    services: string[];
  }>;
  timestamp: number;
}

// === P2Pディスカバリーマネージャー ===
export class P2PDiscoveryManager extends EventEmitter {
  private config: DiscoveryConfig;
  private peers: Map<string, Peer> = new Map();
  private discoveryTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  
  // 戦略別のハンドラー
  private dhtManager?: DHTManager;
  private mdnsSocket?: dgram.Socket;
  
  // 統計情報
  private statistics = {
    totalPeersDiscovered: 0,
    peersPerMethod: new Map<DiscoveryMethod, number>(),
    discoveryAttempts: 0,
    successfulDiscoveries: 0,
    averageDiscoveryTime: 0
  };
  
  constructor(config: DiscoveryConfig) {
    super();
    this.config = config;
  }
  
  // ディスカバリーの開始
  async start(): Promise<void> {
    try {
      // 各戦略の初期化
      for (const strategy of this.config.strategies) {
        await this.initializeStrategy(strategy);
      }
      
      // ブートストラップノードの追加
      await this.addBootstrapNodes();
      
      // 定期的なディスカバリー
      this.discoveryTimer = setInterval(
        () => this.performDiscovery(),
        this.config.discoveryInterval * 1000
      );
      
      // 定期的なリフレッシュ
      this.refreshTimer = setInterval(
        () => this.refreshPeers(),
        this.config.refreshInterval * 1000
      );
      
      // 初回ディスカバリー
      await this.performDiscovery();
      
      this.emit('started');
      
    } catch (error) {
      this.emit('error', { error, context: 'start' });
      throw error;
    }
  }
  
  // 戦略の初期化
  private async initializeStrategy(strategy: string): Promise<void> {
    switch (strategy) {
      case 'dht':
        await this.initializeDHT();
        break;
        
      case 'mdns':
        if (this.config.mdnsEnabled) {
          await this.initializeMDNS();
        }
        break;
        
      case 'dns':
        // DNS戦略は必要時に実行
        break;
        
      case 'tracker':
        // Tracker戦略は必要時に実行
        break;
        
      case 'pex':
        // PEXは接続後に実行
        break;
    }
  }
  
  // DHTの初期化
  private async initializeDHT(): Promise<void> {
    this.dhtManager = new DHTManager({
      nodeId: this.config.nodeId,
      bootstrapNodes: this.config.bootstrapNodes,
      port: 0 // ランダムポート
    });
    
    this.dhtManager.on('peerDiscovered', (peer: any) => {
      this.handleDiscoveredPeer(peer, 'dht');
    });
    
    await this.dhtManager.start();
  }
  
  // mDNSの初期化
  private async initializeMDNS(): Promise<void> {
    this.mdnsSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    
    // mDNSマルチキャストアドレス
    const MDNS_ADDRESS = '224.0.0.251';
    const MDNS_PORT = 5353;
    
    this.mdnsSocket.on('message', (msg, rinfo) => {
      this.handleMDNSMessage(msg, rinfo);
    });
    
    await new Promise<void>((resolve, reject) => {
      this.mdnsSocket!.bind(this.config.mdnsPort, () => {
        this.mdnsSocket!.addMembership(MDNS_ADDRESS);
        resolve();
      });
      
      this.mdnsSocket!.on('error', reject);
    });
    
    // 定期的なアナウンス
    setInterval(() => {
      this.announceMDNS();
    }, 30000);
    
    // 初回アナウンス
    this.announceMDNS();
  }
  
  // ブートストラップノードの追加
  private async addBootstrapNodes(): Promise<void> {
    for (const node of this.config.bootstrapNodes) {
      const [address, port] = node.split(':');
      
      const peer: Peer = {
        id: this.generatePeerId(address, parseInt(port)),
        address,
        port: parseInt(port),
        services: [],
        lastSeen: Date.now(),
        discoveredVia: 'manual',
        connected: false,
        connectionAttempts: 0,
        metadata: {}
      };
      
      this.addPeer(peer);
    }
  }
  
  // ディスカバリーの実行
  private async performDiscovery(): Promise<void> {
    const startTime = Date.now();
    this.statistics.discoveryAttempts++;
    
    try {
      const results: DiscoveryResult[] = [];
      
      // 現在のピア数をチェック
      const currentPeerCount = this.getActivePeerCount();
      
      if (currentPeerCount >= this.config.maxPeers) {
        return; // 十分なピアがある
      }
      
      // 各戦略を並行実行
      const promises: Promise<DiscoveryResult>[] = [];
      
      for (const strategy of this.config.strategies) {
        promises.push(this.executeStrategy(strategy));
      }
      
      const strategyResults = await Promise.allSettled(promises);
      
      // 結果の処理
      for (const result of strategyResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        }
      }
      
      // 統計の更新
      const duration = Date.now() - startTime;
      this.updateStatistics(results, duration);
      
      this.emit('discoveryCompleted', { results, duration });
      
    } catch (error) {
      this.emit('error', { error, context: 'performDiscovery' });
    }
  }
  
  // 戦略の実行
  private async executeStrategy(strategy: string): Promise<DiscoveryResult> {
    const startTime = Date.now();
    let peers: Peer[] = [];
    
    switch (strategy) {
      case 'dht':
        peers = await this.discoverViaDHT();
        break;
        
      case 'mdns':
        peers = await this.discoverViaMDNS();
        break;
        
      case 'dns':
        peers = await this.discoverViaDNS();
        break;
        
      case 'tracker':
        peers = await this.discoverViaTracker();
        break;
        
      case 'pex':
        peers = await this.discoverViaPEX();
        break;
    }
    
    return {
      method: strategy as DiscoveryMethod,
      peers,
      timestamp: Date.now(),
      duration: Date.now() - startTime
    };
  }
  
  // DHT経由のディスカバリー
  private async discoverViaDHT(): Promise<Peer[]> {
    if (!this.dhtManager) return [];
    
    // インフォハッシュベースの検索
    const infoHash = this.generateInfoHash();
    const nodes = await this.dhtManager.findNodes(infoHash);
    
    return nodes.map(node => ({
      id: node.id,
      address: node.address,
      port: node.port,
      services: [],
      lastSeen: Date.now(),
      discoveredVia: 'dht' as DiscoveryMethod,
      connected: false,
      connectionAttempts: 0,
      metadata: {}
    }));
  }
  
  // mDNS経由のディスカバリー
  private async discoverViaMDNS(): Promise<Peer[]> {
    // mDNSクエリの送信
    const query = this.createMDNSQuery();
    
    const MDNS_ADDRESS = '224.0.0.251';
    const MDNS_PORT = 5353;
    
    this.mdnsSocket?.send(query, MDNS_PORT, MDNS_ADDRESS);
    
    // 応答を待つ（非同期で処理されるため、ここでは空配列を返す）
    return [];
  }
  
  // DNS経由のディスカバリー
  private async discoverViaDNS(): Promise<Peer[]> {
    if (!this.config.dnsSeeds || this.config.dnsSeeds.length === 0) {
      return [];
    }
    
    const peers: Peer[] = [];
    
    for (const seed of this.config.dnsSeeds) {
      try {
        // A/AAAAレコードの検索
        const [ipv4Records, ipv6Records] = await Promise.allSettled([
          dns.resolve4(seed),
          dns.resolve6(seed)
        ]);
        
        if (ipv4Records.status === 'fulfilled') {
          for (const address of ipv4Records.value) {
            peers.push({
              id: this.generatePeerId(address, this.config.mdnsPort),
              address,
              port: this.config.mdnsPort,
              services: [],
              lastSeen: Date.now(),
              discoveredVia: 'dns',
              connected: false,
              connectionAttempts: 0,
              metadata: {}
            });
          }
        }
        
        if (ipv6Records.status === 'fulfilled') {
          for (const address of ipv6Records.value) {
            peers.push({
              id: this.generatePeerId(address, this.config.mdnsPort),
              address,
              port: this.config.mdnsPort,
              services: [],
              lastSeen: Date.now(),
              discoveredVia: 'dns',
              connected: false,
              connectionAttempts: 0,
              metadata: {}
            });
          }
        }
        
      } catch (error) {
        this.emit('dnsError', { seed, error });
      }
    }
    
    return peers;
  }
  
  // Tracker経由のディスカバリー
  private async discoverViaTracker(): Promise<Peer[]> {
    if (!this.config.trackers || this.config.trackers.length === 0) {
      return [];
    }
    
    const peers: Peer[] = [];
    
    for (const tracker of this.config.trackers) {
      try {
        const response = await this.announceToTracker(tracker);
        
        for (const peerInfo of response.peers) {
          peers.push({
            id: peerInfo.peer_id || this.generatePeerId(peerInfo.ip, peerInfo.port),
            address: peerInfo.ip,
            port: peerInfo.port,
            services: [],
            lastSeen: Date.now(),
            discoveredVia: 'tracker',
            connected: false,
            connectionAttempts: 0,
            metadata: {}
          });
        }
        
      } catch (error) {
        this.emit('trackerError', { tracker, error });
      }
    }
    
    return peers;
  }
  
  // PEX経由のディスカバリー
  private async discoverViaPEX(): Promise<Peer[]> {
    if (!this.config.pexEnabled) return [];
    
    const peers: Peer[] = [];
    const connectedPeers = this.getConnectedPeers();
    
    // 接続済みピアにPEXリクエストを送信
    for (const peer of connectedPeers) {
      try {
        const pexPeers = await this.requestPEX(peer);
        
        for (const pexPeer of pexPeers) {
          peers.push({
            id: pexPeer.id,
            address: pexPeer.address,
            port: pexPeer.port,
            services: pexPeer.services,
            lastSeen: Date.now(),
            discoveredVia: 'pex',
            connected: false,
            connectionAttempts: 0,
            metadata: {}
          });
        }
        
      } catch (error) {
        // 個別のエラーは無視
      }
    }
    
    return peers;
  }
  
  // mDNSメッセージの処理
  private handleMDNSMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      // mDNSレスポンスの解析（簡略化）
      const serviceName = this.config.mdnsServiceName;
      
      if (msg.includes(Buffer.from(serviceName))) {
        const peer: Peer = {
          id: this.generatePeerId(rinfo.address, rinfo.port),
          address: rinfo.address,
          port: this.config.mdnsPort,
          services: [],
          lastSeen: Date.now(),
          discoveredVia: 'mdns',
          connected: false,
          connectionAttempts: 0,
          metadata: {}
        };
        
        this.handleDiscoveredPeer(peer, 'mdns');
      }
    } catch (error) {
      // 無視
    }
  }
  
  // mDNSアナウンス
  private announceMDNS(): void {
    const announcement = this.createMDNSAnnouncement();
    
    const MDNS_ADDRESS = '224.0.0.251';
    const MDNS_PORT = 5353;
    
    this.mdnsSocket?.send(announcement, MDNS_PORT, MDNS_ADDRESS);
  }
  
  // 発見されたピアの処理
  private handleDiscoveredPeer(peer: Peer, method: DiscoveryMethod): void {
    // 自分自身をスキップ
    if (peer.id === this.config.nodeId) return;
    
    // 既存のピアかチェック
    const existingPeer = this.peers.get(peer.id);
    
    if (existingPeer) {
      // 既存ピアの情報を更新
      existingPeer.lastSeen = Date.now();
      
      // より詳細な情報があれば更新
      if (peer.services.length > existingPeer.services.length) {
        existingPeer.services = peer.services;
      }
    } else {
      // 新規ピアの追加
      this.addPeer(peer);
      
      // 統計の更新
      this.statistics.totalPeersDiscovered++;
      const methodCount = this.statistics.peersPerMethod.get(method) || 0;
      this.statistics.peersPerMethod.set(method, methodCount + 1);
      
      this.emit('peerDiscovered', peer);
    }
  }
  
  // ピアの追加
  private addPeer(peer: Peer): void {
    // 最大ピア数のチェック
    if (this.peers.size >= this.config.maxPeers) {
      // 最も古いピアを削除
      const oldestPeer = this.getOldestPeer();
      if (oldestPeer) {
        this.removePeer(oldestPeer.id);
      }
    }
    
    this.peers.set(peer.id, peer);
  }
  
  // ピアの削除
  private removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      this.peers.delete(peerId);
      this.emit('peerRemoved', peer);
    }
  }
  
  // ピアのリフレッシュ
  private refreshPeers(): void {
    const now = Date.now();
    const timeout = this.config.peerTimeout * 1000;
    
    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen > timeout && !peer.connected) {
        this.removePeer(peerId);
      }
    }
    
    // 最小ピア数を下回ったら追加ディスカバリー
    if (this.getActivePeerCount() < this.config.minPeers) {
      this.performDiscovery();
    }
  }
  
  // Trackerへのアナウンス
  private async announceToTracker(trackerUrl: string): Promise<any> {
    // HTTPトラッカーの場合（簡略化）
    const params = new URLSearchParams({
      info_hash: this.generateInfoHash(),
      peer_id: this.config.nodeId,
      port: this.config.mdnsPort.toString(),
      uploaded: '0',
      downloaded: '0',
      left: '0',
      compact: '1',
      numwant: this.config.targetPeers.toString()
    });
    
    const response = await fetch(`${trackerUrl}?${params}`);
    
    // Bencode形式のレスポンスをデコード（実装依存）
    return { peers: [] };
  }
  
  // PEXリクエスト
  private async requestPEX(peer: Peer): Promise<any[]> {
    // ピアにPEXメッセージを送信（実装依存）
    const message: PeerExchangeMessage = {
      type: 'pex_request',
      peers: [],
      timestamp: Date.now()
    };
    
    // レスポンスを待つ（実装依存）
    return [];
  }
  
  // 統計の更新
  private updateStatistics(results: DiscoveryResult[], duration: number): void {
    let totalPeers = 0;
    
    for (const result of results) {
      totalPeers += result.peers.length;
    }
    
    if (totalPeers > 0) {
      this.statistics.successfulDiscoveries++;
    }
    
    // 平均ディスカバリー時間の更新
    const totalAttempts = this.statistics.discoveryAttempts;
    const oldAvg = this.statistics.averageDiscoveryTime;
    this.statistics.averageDiscoveryTime = 
      (oldAvg * (totalAttempts - 1) + duration) / totalAttempts;
  }
  
  // ヘルパーメソッド
  private generatePeerId(address: string, port: number): string {
    return createHash('sha256')
      .update(`${address}:${port}`)
      .digest('hex')
      .substring(0, 20);
  }
  
  private generateInfoHash(): string {
    return createHash('sha256')
      .update('otedama-pool')
      .digest('hex')
      .substring(0, 20);
  }
  
  private getActivePeerCount(): number {
    return Array.from(this.peers.values())
      .filter(p => p.connected || Date.now() - p.lastSeen < 300000)
      .length;
  }
  
  private getConnectedPeers(): Peer[] {
    return Array.from(this.peers.values())
      .filter(p => p.connected);
  }
  
  private getOldestPeer(): Peer | null {
    let oldest: Peer | null = null;
    
    for (const peer of this.peers.values()) {
      if (!peer.connected && (!oldest || peer.lastSeen < oldest.lastSeen)) {
        oldest = peer;
      }
    }
    
    return oldest;
  }
  
  private createMDNSQuery(): Buffer {
    // mDNSクエリの作成（簡略化）
    const serviceName = this.config.mdnsServiceName;
    return Buffer.from(serviceName);
  }
  
  private createMDNSAnnouncement(): Buffer {
    // mDNSアナウンスメントの作成（簡略化）
    const serviceName = this.config.mdnsServiceName;
    const port = this.config.mdnsPort;
    return Buffer.from(`${serviceName}:${port}`);
  }
  
  // 公開API
  getPeers(): Peer[] {
    return Array.from(this.peers.values());
  }
  
  getPeer(peerId: string): Peer | null {
    return this.peers.get(peerId) || null;
  }
  
  getStatistics(): typeof this.statistics {
    return {
      ...this.statistics,
      peersPerMethod: new Map(this.statistics.peersPerMethod)
    };
  }
  
  // 手動でピアを追加
  addManualPeer(address: string, port: number): void {
    const peer: Peer = {
      id: this.generatePeerId(address, port),
      address,
      port,
      services: [],
      lastSeen: Date.now(),
      discoveredVia: 'manual',
      connected: false,
      connectionAttempts: 0,
      metadata: {}
    };
    
    this.addPeer(peer);
  }
  
  // ピアへの接続通知
  notifyConnected(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.connected = true;
      peer.lastSeen = Date.now();
      this.emit('peerConnected', peer);
    }
  }
  
  // ピアからの切断通知
  notifyDisconnected(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.connected = false;
      peer.connectionAttempts++;
      peer.lastConnectionAttempt = Date.now();
      this.emit('peerDisconnected', peer);
    }
  }
  
  // PEXメッセージの処理
  handlePEXMessage(fromPeerId: string, message: PeerExchangeMessage): void {
    if (message.type === 'pex_request') {
      // PEXリクエストへの応答
      const peers = this.getConnectedPeers()
        .filter(p => p.id !== fromPeerId)
        .slice(0, this.config.pexMaxPeers)
        .map(p => ({
          id: p.id,
          address: p.address,
          port: p.port,
          services: p.services
        }));
      
      const response: PeerExchangeMessage = {
        type: 'pex_response',
        peers,
        timestamp: Date.now()
      };
      
      this.emit('pexResponse', { to: fromPeerId, message: response });
      
    } else if (message.type === 'pex_response') {
      // PEXレスポンスの処理
      for (const peerInfo of message.peers) {
        const peer: Peer = {
          id: peerInfo.id,
          address: peerInfo.address,
          port: peerInfo.port,
          services: peerInfo.services,
          lastSeen: Date.now(),
          discoveredVia: 'pex',
          connected: false,
          connectionAttempts: 0,
          metadata: {}
        };
        
        this.handleDiscoveredPeer(peer, 'pex');
      }
    }
  }
  
  // 停止
  async stop(): Promise<void> {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
    }
    
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    
    if (this.dhtManager) {
      await this.dhtManager.stop();
    }
    
    if (this.mdnsSocket) {
      this.mdnsSocket.close();
    }
    
    this.peers.clear();
    
    this.emit('stopped');
  }
}

export default P2PDiscoveryManager;