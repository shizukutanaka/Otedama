/**
 * P2P通信実装 - libp2p統合
 * 分散型マイニングプールのための効率的なP2Pネットワーク
 * 
 * 設計思想：
 * - Carmack: 低レイテンシ、高効率な通信
 * - Martin: 明確なプロトコル定義と抽象化
 * - Pike: シンプルで拡張可能なネットワーク設計
 */

import { createLibp2p, Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { mplex } from '@libp2p/mplex';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { mdns } from '@libp2p/mdns';
import { PeerId } from '@libp2p/interface-peer-id';
import { createFromJSON } from '@libp2p/peer-id-factory';
import { Multiaddr, multiaddr } from '@multiformats/multiaddr';
import { EventEmitter } from 'events';
import { pipe } from 'it-pipe';
import { encode, decode } from 'it-length-prefixed';
import { fromString, toString } from 'uint8arrays';

// === 型定義 ===
export interface P2PConfig {
  port: number;
  bootstrapNodes?: string[];
  maxPeers?: number;
  enableMDNS?: boolean;
  enableDHT?: boolean;
  gossipTopics?: string[];
  peerId?: any; // PeerIdのJSON表現
}

export interface ShareMessage {
  type: 'share';
  minerId: string;
  hash: string;
  difficulty: number;
  height: number;
  timestamp: number;
  nonce: string;
  signature?: string;
}

export interface BlockMessage {
  type: 'block';
  hash: string;
  height: number;
  finder: string;
  timestamp: number;
  reward?: number;
  signature?: string;
}

export interface PeerInfo {
  id: string;
  addresses: string[];
  protocols: string[];
  metadata?: {
    version?: string;
    hashrate?: number;
    shares?: number;
  };
}

export interface NetworkStats {
  peers: number;
  connections: number;
  bandwidth: {
    in: number;
    out: number;
  };
  messages: {
    sent: number;
    received: number;
  };
}

// プロトコル定義
const PROTOCOLS = {
  SHARE_PROPAGATION: '/otedama/share/1.0.0',
  BLOCK_ANNOUNCEMENT: '/otedama/block/1.0.0',
  PEER_EXCHANGE: '/otedama/peers/1.0.0',
  STATS_EXCHANGE: '/otedama/stats/1.0.0',
  SHARE_CHAIN: '/otedama/sharechain/1.0.0'
};

// === P2Pネットワーククラス ===
export class P2PNetwork extends EventEmitter {
  private node?: Libp2p;
  private config: P2PConfig;
  private stats: NetworkStats = {
    peers: 0,
    connections: 0,
    bandwidth: { in: 0, out: 0 },
    messages: { sent: 0, received: 0 }
  };
  
  private shareValidators = new Set<(share: ShareMessage) => Promise<boolean>>();
  private blockValidators = new Set<(block: BlockMessage) => Promise<boolean>>();
  
  constructor(config: P2PConfig) {
    super();
    this.config = config;
  }
  
  // ネットワークの開始
  async start(): Promise<void> {
    try {
      // PeerIdの作成または読み込み
      const peerId = this.config.peerId 
        ? await createFromJSON(this.config.peerId)
        : await this.createPeerId();
      
      // libp2pノードの作成
      this.node = await createLibp2p({
        peerId,
        addresses: {
          listen: [`/ip4/0.0.0.0/tcp/${this.config.port}`]
        },
        transports: [tcp()],
        connectionEncryption: [noise()],
        streamMuxers: [mplex()],
        connectionManager: {
          maxConnections: this.config.maxPeers || 50,
          minConnections: 5
        },
        peerDiscovery: this.createPeerDiscovery(),
        services: this.createServices()
      });
      
      // イベントハンドラーの設定
      this.setupEventHandlers();
      
      // プロトコルハンドラーの設定
      this.setupProtocolHandlers();
      
      // ノードを開始
      await this.node.start();
      
      // ブートストラップノードに接続
      await this.connectToBootstrapNodes();
      
      this.emit('started', {
        peerId: this.node.peerId.toString(),
        addresses: this.node.getMultiaddrs().map(ma => ma.toString())
      });
      
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  // ネットワークの停止
  async stop(): Promise<void> {
    if (this.node) {
      await this.node.stop();
      this.emit('stopped');
    }
  }
  
  // PeerIdの作成
  private async createPeerId(): Promise<PeerId> {
    // 実装は簡略化（実際は永続化が必要）
    return createFromJSON({
      id: '',
      privKey: '',
      pubKey: ''
    });
  }
  
  // ピア検出の設定
  private createPeerDiscovery(): any[] {
    const discovery = [];
    
    // mDNS（ローカルネットワーク検出）
    if (this.config.enableMDNS !== false) {
      discovery.push(mdns());
    }
    
    // Bootstrap（既知のノード）
    if (this.config.bootstrapNodes && this.config.bootstrapNodes.length > 0) {
      discovery.push(bootstrap({
        list: this.config.bootstrapNodes
      }));
    }
    
    return discovery;
  }
  
  // サービスの作成
  private createServices(): any {
    const services: any = {};
    
    // DHT（分散ハッシュテーブル）
    if (this.config.enableDHT !== false) {
      services.dht = kadDHT();
    }
    
    // Gossipsub（パブサブ）
    services.pubsub = gossipsub({
      emitSelf: false,
      gossipIncoming: true,
      fallbackToFloodsub: true,
      floodPublish: true,
      doPX: true,
      msgIdFn: (msg) => {
        // メッセージIDの生成（重複排除用）
        const data = msg.data ? toString(msg.data) : '';
        return fromString(data + msg.from);
      }
    });
    
    return services;
  }
  
  // イベントハンドラーの設定
  private setupEventHandlers(): void {
    if (!this.node) return;
    
    // ピア接続
    this.node.addEventListener('peer:connect', (evt) => {
      this.stats.peers++;
      this.stats.connections++;
      this.emit('peer:connected', {
        peerId: evt.detail.toString()
      });
    });
    
    // ピア切断
    this.node.addEventListener('peer:disconnect', (evt) => {
      this.stats.peers--;
      this.stats.connections--;
      this.emit('peer:disconnected', {
        peerId: evt.detail.toString()
      });
    });
    
    // ピア発見
    this.node.addEventListener('peer:discovery', (evt) => {
      this.emit('peer:discovered', {
        peerId: evt.detail.id.toString(),
        multiaddrs: evt.detail.multiaddrs.map((ma: Multiaddr) => ma.toString())
      });
    });
  }
  
  // プロトコルハンドラーの設定
  private setupProtocolHandlers(): void {
    if (!this.node) return;
    
    // シェア伝播プロトコル
    this.node.handle(PROTOCOLS.SHARE_PROPAGATION, async ({ stream }) => {
      try {
        const messages = await pipe(
          stream.source,
          decode(),
          async function* (source) {
            for await (const msg of source) {
              yield msg;
            }
          }
        );
        
        for await (const msg of messages) {
          const share: ShareMessage = JSON.parse(toString(msg));
          await this.handleShare(share);
        }
      } catch (error) {
        this.emit('error', { error, protocol: 'share' });
      }
    });
    
    // ブロック通知プロトコル
    this.node.handle(PROTOCOLS.BLOCK_ANNOUNCEMENT, async ({ stream }) => {
      try {
        const messages = await pipe(
          stream.source,
          decode(),
          async function* (source) {
            for await (const msg of source) {
              yield msg;
            }
          }
        );
        
        for await (const msg of messages) {
          const block: BlockMessage = JSON.parse(toString(msg));
          await this.handleBlock(block);
        }
      } catch (error) {
        this.emit('error', { error, protocol: 'block' });
      }
    });
    
    // Gossipsubのメッセージハンドリング
    if (this.node.services.pubsub) {
      // シェアトピック
      this.node.services.pubsub.addEventListener('message', (evt: any) => {
        if (evt.detail.topic === 'otedama/shares') {
          const share: ShareMessage = JSON.parse(toString(evt.detail.data));
          this.handleShare(share);
        } else if (evt.detail.topic === 'otedama/blocks') {
          const block: BlockMessage = JSON.parse(toString(evt.detail.data));
          this.handleBlock(block);
        }
      });
      
      // トピックをサブスクライブ
      this.node.services.pubsub.subscribe('otedama/shares');
      this.node.services.pubsub.subscribe('otedama/blocks');
    }
  }
  
  // ブートストラップノードへの接続
  private async connectToBootstrapNodes(): Promise<void> {
    if (!this.node || !this.config.bootstrapNodes) return;
    
    for (const addr of this.config.bootstrapNodes) {
      try {
        const ma = multiaddr(addr);
        await this.node.dial(ma);
      } catch (error) {
        this.emit('error', { error, bootstrap: addr });
      }
    }
  }
  
  // シェアのブロードキャスト
  async broadcastShare(share: ShareMessage): Promise<void> {
    if (!this.node) return;
    
    // 署名を追加（オプション）
    share.signature = await this.signMessage(share);
    
    const data = fromString(JSON.stringify(share));
    
    // Gossipsubでブロードキャスト
    if (this.node.services.pubsub) {
      await this.node.services.pubsub.publish('otedama/shares', data);
    }
    
    // 直接接続しているピアにも送信
    const peers = this.node.getPeers();
    for (const peerId of peers) {
      try {
        const stream = await this.node.dialProtocol(peerId, PROTOCOLS.SHARE_PROPAGATION);
        await pipe(
          [data],
          encode(),
          stream.sink
        );
        stream.close();
      } catch (error) {
        // エラーは無視（ピアが対応していない可能性）
      }
    }
    
    this.stats.messages.sent++;
  }
  
  // ブロックのブロードキャスト
  async broadcastBlock(block: BlockMessage): Promise<void> {
    if (!this.node) return;
    
    // 署名を追加（オプション）
    block.signature = await this.signMessage(block);
    
    const data = fromString(JSON.stringify(block));
    
    // Gossipsubでブロードキャスト
    if (this.node.services.pubsub) {
      await this.node.services.pubsub.publish('otedama/blocks', data);
    }
    
    // 直接接続しているピアにも送信（高優先度）
    const peers = this.node.getPeers();
    await Promise.all(peers.map(async (peerId) => {
      try {
        const stream = await this.node!.dialProtocol(peerId, PROTOCOLS.BLOCK_ANNOUNCEMENT);
        await pipe(
          [data],
          encode(),
          stream.sink
        );
        stream.close();
      } catch (error) {
        // エラーは無視
      }
    }));
    
    this.stats.messages.sent++;
  }
  
  // シェアの処理
  private async handleShare(share: ShareMessage): Promise<void> {
    this.stats.messages.received++;
    
    // バリデーション
    const isValid = await this.validateShare(share);
    if (!isValid) {
      return;
    }
    
    // イベント発行
    this.emit('share', share);
  }
  
  // ブロックの処理
  private async handleBlock(block: BlockMessage): Promise<void> {
    this.stats.messages.received++;
    
    // バリデーション
    const isValid = await this.validateBlock(block);
    if (!isValid) {
      return;
    }
    
    // イベント発行
    this.emit('block', block);
  }
  
  // シェアのバリデーション
  private async validateShare(share: ShareMessage): Promise<boolean> {
    // カスタムバリデーターを実行
    for (const validator of this.shareValidators) {
      if (!await validator(share)) {
        return false;
      }
    }
    
    // 基本的なバリデーション
    if (!share.hash || !share.minerId || share.difficulty <= 0) {
      return false;
    }
    
    // 署名検証（実装が必要）
    if (share.signature) {
      // TODO: 署名検証
    }
    
    return true;
  }
  
  // ブロックのバリデーション
  private async validateBlock(block: BlockMessage): Promise<boolean> {
    // カスタムバリデーターを実行
    for (const validator of this.blockValidators) {
      if (!await validator(block)) {
        return false;
      }
    }
    
    // 基本的なバリデーション
    if (!block.hash || !block.finder || block.height <= 0) {
      return false;
    }
    
    // 署名検証（実装が必要）
    if (block.signature) {
      // TODO: 署名検証
    }
    
    return true;
  }
  
  // メッセージの署名
  private async signMessage(message: any): Promise<string> {
    // TODO: 実装
    return '';
  }
  
  // バリデーターの追加
  addShareValidator(validator: (share: ShareMessage) => Promise<boolean>): void {
    this.shareValidators.add(validator);
  }
  
  addBlockValidator(validator: (block: BlockMessage) => Promise<boolean>): void {
    this.blockValidators.add(validator);
  }
  
  // ピア情報の取得
  async getPeerInfo(peerId: string): Promise<PeerInfo | null> {
    if (!this.node) return null;
    
    try {
      const peer = await this.node.peerStore.get(PeerId.parse(peerId));
      
      return {
        id: peerId,
        addresses: peer.addresses.map(a => a.multiaddr.toString()),
        protocols: peer.protocols,
        metadata: peer.metadata as any
      };
    } catch {
      return null;
    }
  }
  
  // 接続中のピア一覧
  getConnectedPeers(): PeerId[] {
    return this.node ? this.node.getPeers() : [];
  }
  
  // ピア数の取得
  getPeerCount(): number {
    return this.stats.peers;
  }
  
  // 統計情報の取得
  getStats(): NetworkStats {
    return { ...this.stats };
  }
  
  // 統計のブロードキャスト
  async broadcastStats(stats: any): Promise<void> {
    if (!this.node) return;
    
    const data = fromString(JSON.stringify({
      type: 'stats',
      stats,
      timestamp: Date.now()
    }));
    
    // 統計情報専用トピック
    if (this.node.services.pubsub) {
      await this.node.services.pubsub.publish('otedama/stats', data);
    }
  }
  
  // ピアへの直接メッセージ送信
  async sendToPeer(peerId: string, protocol: string, data: any): Promise<void> {
    if (!this.node) return;
    
    try {
      const stream = await this.node.dialProtocol(PeerId.parse(peerId), protocol);
      await pipe(
        [fromString(JSON.stringify(data))],
        encode(),
        stream.sink
      );
      stream.close();
    } catch (error) {
      this.emit('error', { error, peerId, protocol });
    }
  }
}

// === シェアチェーン（P2Pool方式）===
export class ShareChain {
  private chain: ShareMessage[] = [];
  private readonly maxLength: number = 8640; // 24時間分（10秒/シェア）
  
  // シェアの追加
  addShare(share: ShareMessage): boolean {
    // 重複チェック
    if (this.chain.find(s => s.hash === share.hash)) {
      return false;
    }
    
    // チェーンに追加
    this.chain.push(share);
    
    // 古いシェアを削除
    if (this.chain.length > this.maxLength) {
      this.chain.shift();
    }
    
    return true;
  }
  
  // チェーンの取得
  getChain(): ShareMessage[] {
    return [...this.chain];
  }
  
  // 特定の高さ以降のシェアを取得
  getSharesSince(height: number): ShareMessage[] {
    return this.chain.filter(s => s.height >= height);
  }
  
  // チェーンの検証
  validateChain(): boolean {
    // TODO: チェーンの整合性検証
    return true;
  }
  
  // チェーンの長さ
  getChainLength(): number {
    return this.chain.length;
  }
}

// === P2Pディスカバリーサービス ===
export class P2PDiscovery {
  private network: P2PNetwork;
  private knownPeers = new Map<string, {
    addresses: string[];
    lastSeen: number;
    reputation: number;
  }>();
  
  constructor(network: P2PNetwork) {
    this.network = network;
    
    // ピア交換プロトコルの実装
    this.setupPeerExchange();
  }
  
  // ピア交換プロトコルのセットアップ
  private setupPeerExchange(): void {
    // 定期的にピア情報を交換
    setInterval(() => {
      this.exchangePeers();
    }, 60000); // 1分ごと
  }
  
  // ピア情報の交換
  private async exchangePeers(): Promise<void> {
    const peers = this.network.getConnectedPeers();
    const myPeerList = Array.from(this.knownPeers.entries()).map(([id, info]) => ({
      id,
      addresses: info.addresses,
      reputation: info.reputation
    }));
    
    for (const peer of peers) {
      await this.network.sendToPeer(
        peer.toString(),
        PROTOCOLS.PEER_EXCHANGE,
        { peers: myPeerList }
      );
    }
  }
  
  // ピアの追加
  addPeer(peerId: string, addresses: string[]): void {
    this.knownPeers.set(peerId, {
      addresses,
      lastSeen: Date.now(),
      reputation: 0
    });
  }
  
  // ピアの評価更新
  updatePeerReputation(peerId: string, delta: number): void {
    const peer = this.knownPeers.get(peerId);
    if (peer) {
      peer.reputation += delta;
      peer.lastSeen = Date.now();
    }
  }
  
  // 優良ピアの取得
  getGoodPeers(count: number = 10): string[] {
    return Array.from(this.knownPeers.entries())
      .sort(([, a], [, b]) => b.reputation - a.reputation)
      .slice(0, count)
      .map(([id]) => id);
  }
}

// エクスポート
export default P2PNetwork;