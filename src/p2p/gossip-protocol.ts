/**
 * ゴシッププロトコル実装
 * 効率的な情報伝播メカニズム
 * 
 * 設計思想：
 * - Carmack: 低レイテンシーで効率的な情報拡散
 * - Martin: スケーラブルで耐障害性のあるプロトコル
 * - Pike: シンプルで理解しやすい実装
 */

import { EventEmitter } from 'events';
import { createHash, randomBytes } from 'crypto';

// === 型定義 ===
export interface GossipConfig {
  // ノード設定
  nodeId: string;                   // ノードID
  
  // 伝播パラメータ
  fanout: number;                  // 各ラウンドで送信する相手数
  gossipInterval: number;          // ゴシップ間隔（ms）
  maxRounds: number;              // 最大伝播ラウンド数
  
  // メッセージ設定
  maxMessageSize: number;          // 最大メッセージサイズ
  messageTTL: number;             // メッセージTTL（秒）
  maxMessagesPerRound: number;    // ラウンドあたりの最大メッセージ数
  
  // 履歴管理
  historySize: number;            // メッセージ履歴のサイズ
  historyTimeout: number;         // 履歴のタイムアウト（秒）
  
  // 信頼性設定
  redundancy: number;             // 冗長性（同じメッセージを送る回数）
  confirmationRequired: boolean;   // 確認応答の要求
  
  // 優先度設定
  enablePriority: boolean;        // 優先度機能の有効化
  priorityLevels: number;         // 優先度レベル数
}

export interface GossipMessage {
  id: string;                     // メッセージID
  type: string;                   // メッセージタイプ
  payload: any;                   // ペイロード
  origin: string;                 // 発信元ノードID
  timestamp: number;              // タイムスタンプ
  ttl: number;                    // Time To Live
  round: number;                  // 現在のラウンド数
  priority?: number;              // 優先度（0が最高）
  signature?: string;             // デジタル署名
  
  // ルーティング情報
  path: string[];                 // 経由したノードのリスト
  receivedFrom?: string;          // 直前の送信元
}

export interface GossipPeer {
  nodeId: string;
  address?: string;
  port?: number;
  
  // 統計情報
  messagesSent: number;
  messagesReceived: number;
  lastSeen: number;
  reputation: number;             // 信頼度スコア
  
  // 状態
  isActive: boolean;
  isPending: boolean;
}

export interface GossipStats {
  totalMessages: number;
  uniqueMessages: number;
  messagesRelayed: number;
  messagesDuplicate: number;
  messagesExpired: number;
  
  // 効率性メトリクス
  averageHops: number;
  averageLatency: number;
  coverageRate: number;           // ネットワークカバレッジ率
  redundancyRate: number;         // 冗長メッセージ率
}

export interface MessageMetadata {
  firstSeen: number;
  lastSeen: number;
  receivedCount: number;
  relayedCount: number;
  sources: Set<string>;
  confirmations: Set<string>;
}

export interface PropagationStrategy {
  selectPeers(peers: GossipPeer[], message: GossipMessage): GossipPeer[];
  shouldRelay(message: GossipMessage, metadata: MessageMetadata): boolean;
  calculateDelay(message: GossipMessage): number;
}

// === ゴシップマネージャー ===
export class GossipProtocolManager extends EventEmitter {
  private config: GossipConfig;
  private peers: Map<string, GossipPeer> = new Map();
  private messageHistory: Map<string, MessageMetadata> = new Map();
  private messageQueue: GossipMessage[] = [];
  private gossipTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  
  // 戦略
  private propagationStrategy: PropagationStrategy;
  
  // 統計情報
  private stats: GossipStats = {
    totalMessages: 0,
    uniqueMessages: 0,
    messagesRelayed: 0,
    messagesDuplicate: 0,
    messagesExpired: 0,
    averageHops: 0,
    averageLatency: 0,
    coverageRate: 0,
    redundancyRate: 0
  };
  
  constructor(config: GossipConfig, strategy?: PropagationStrategy) {
    super();
    this.config = config;
    this.propagationStrategy = strategy || new DefaultPropagationStrategy(config);
  }
  
  // ゴシッププロトコルの開始
  start(): void {
    // 定期的なゴシップ
    this.gossipTimer = setInterval(() => {
      this.performGossipRound();
    }, this.config.gossipInterval);
    
    // 定期的なクリーンアップ
    this.cleanupTimer = setInterval(() => {
      this.cleanupHistory();
    }, this.config.historyTimeout * 1000);
    
    this.emit('started');
  }
  
  // ゴシッププロトコルの停止
  stop(): void {
    if (this.gossipTimer) {
      clearInterval(this.gossipTimer);
      this.gossipTimer = undefined;
    }
    
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    
    this.emit('stopped');
  }
  
  // ピアの追加
  addPeer(peer: GossipPeer): void {
    this.peers.set(peer.nodeId, peer);
    this.emit('peerAdded', peer);
  }
  
  // ピアの削除
  removePeer(nodeId: string): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      this.peers.delete(nodeId);
      this.emit('peerRemoved', peer);
    }
  }
  
  // メッセージのブロードキャスト
  broadcast(type: string, payload: any, priority = 5): string {
    const message: GossipMessage = {
      id: this.generateMessageId(),
      type,
      payload,
      origin: this.config.nodeId,
      timestamp: Date.now(),
      ttl: this.config.messageTTL,
      round: 0,
      priority,
      path: [this.config.nodeId]
    };
    
    // 署名の追加（実装依存）
    message.signature = this.signMessage(message);
    
    // キューに追加
    this.enqueueMessage(message);
    
    // 統計更新
    this.stats.totalMessages++;
    this.stats.uniqueMessages++;
    
    this.emit('messageBroadcast', message);
    
    return message.id;
  }
  
  // メッセージの受信
  async receiveMessage(message: GossipMessage, fromPeer: string): Promise<void> {
    try {
      // 検証
      if (!this.validateMessage(message)) {
        this.emit('invalidMessage', { message, fromPeer });
        return;
      }
      
      // ピア情報の更新
      this.updatePeerStats(fromPeer, 'received');
      
      // メッセージ履歴の確認
      const metadata = this.messageHistory.get(message.id);
      
      if (metadata) {
        // 重複メッセージ
        metadata.receivedCount++;
        metadata.lastSeen = Date.now();
        metadata.sources.add(fromPeer);
        
        this.stats.messagesDuplicate++;
        
        // 確認応答の処理
        if (this.config.confirmationRequired) {
          metadata.confirmations.add(fromPeer);
          this.checkConfirmationThreshold(message, metadata);
        }
        
        return;
      }
      
      // 新規メッセージ
      const newMetadata: MessageMetadata = {
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        receivedCount: 1,
        relayedCount: 0,
        sources: new Set([fromPeer]),
        confirmations: new Set([fromPeer])
      };
      
      this.messageHistory.set(message.id, newMetadata);
      this.stats.uniqueMessages++;
      
      // パスの更新
      message.path.push(this.config.nodeId);
      message.receivedFrom = fromPeer;
      
      // レイテンシーの計算
      const latency = Date.now() - message.timestamp;
      this.updateAverageLatency(latency);
      
      // イベント発火
      this.emit('messageReceived', message);
      
      // 転送判定
      if (this.propagationStrategy.shouldRelay(message, newMetadata)) {
        this.enqueueMessage(message);
      }
      
    } catch (error) {
      this.emit('error', { error, context: 'receiveMessage' });
    }
  }
  
  // ゴシップラウンドの実行
  private performGossipRound(): void {
    if (this.messageQueue.length === 0) return;
    
    // 優先度でソート
    if (this.config.enablePriority) {
      this.messageQueue.sort((a, b) => (a.priority || 5) - (b.priority || 5));
    }
    
    // 送信するメッセージを選択
    const messagesToSend = this.messageQueue.splice(0, this.config.maxMessagesPerRound);
    
    for (const message of messagesToSend) {
      this.gossipMessage(message);
    }
  }
  
  // 個別メッセージのゴシップ
  private gossipMessage(message: GossipMessage): void {
    const metadata = this.messageHistory.get(message.id);
    if (!metadata) return;
    
    // TTLチェック
    if (message.round >= message.ttl || message.round >= this.config.maxRounds) {
      this.stats.messagesExpired++;
      return;
    }
    
    // ラウンドを増加
    message.round++;
    
    // ピアの選択
    const activePeers = Array.from(this.peers.values()).filter(p => p.isActive);
    const selectedPeers = this.propagationStrategy.selectPeers(activePeers, message);
    
    // 各ピアに送信
    for (const peer of selectedPeers) {
      // 送信元には送らない
      if (message.path.includes(peer.nodeId)) continue;
      
      // 遅延の計算
      const delay = this.propagationStrategy.calculateDelay(message);
      
      setTimeout(() => {
        this.sendToPeer(peer, message);
        metadata.relayedCount++;
        this.updatePeerStats(peer.nodeId, 'sent');
      }, delay);
    }
    
    // 統計更新
    this.stats.messagesRelayed++;
    this.updateAverageHops(message.path.length);
    
    // 冗長性のための再送信
    if (this.config.redundancy > 1 && metadata.relayedCount < this.config.redundancy) {
      setTimeout(() => {
        this.enqueueMessage(message);
      }, this.config.gossipInterval * 2);
    }
  }
  
  // ピアへの送信
  private sendToPeer(peer: GossipPeer, message: GossipMessage): void {
    // 実際の送信処理（実装依存）
    this.emit('sendMessage', { peer, message });
    
    // 送信の記録
    peer.messagesSent++;
    peer.lastSeen = Date.now();
  }
  
  // メッセージの検証
  private validateMessage(message: GossipMessage): boolean {
    // 基本検証
    if (!message.id || !message.type || !message.origin) {
      return false;
    }
    
    // サイズチェック
    const messageSize = JSON.stringify(message).length;
    if (messageSize > this.config.maxMessageSize) {
      return false;
    }
    
    // TTLチェック
    if (message.round > message.ttl || message.round > this.config.maxRounds) {
      return false;
    }
    
    // タイムスタンプチェック（未来のメッセージを拒否）
    if (message.timestamp > Date.now() + 60000) { // 1分の余裕
      return false;
    }
    
    // 署名検証（実装依存）
    if (message.signature && !this.verifySignature(message)) {
      return false;
    }
    
    // パスの妥当性チェック
    if (message.path.length !== new Set(message.path).size) {
      return false; // ループ検出
    }
    
    return true;
  }
  
  // メッセージのキューイング
  private enqueueMessage(message: GossipMessage): void {
    // 重複チェック
    const exists = this.messageQueue.some(m => m.id === message.id);
    if (exists) return;
    
    // キューサイズの制限
    if (this.messageQueue.length >= this.config.maxMessagesPerRound * 3) {
      // 最も優先度の低いメッセージを削除
      if (this.config.enablePriority) {
        this.messageQueue.sort((a, b) => (b.priority || 5) - (a.priority || 5));
        this.messageQueue.pop();
      } else {
        this.messageQueue.shift(); // FIFO
      }
    }
    
    this.messageQueue.push(message);
  }
  
  // ピア統計の更新
  private updatePeerStats(peerId: string, action: 'sent' | 'received'): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    
    if (action === 'sent') {
      peer.messagesSent++;
    } else {
      peer.messagesReceived++;
    }
    
    peer.lastSeen = Date.now();
    
    // レピュテーションの更新
    this.updatePeerReputation(peer);
  }
  
  // ピアレピュテーションの更新
  private updatePeerReputation(peer: GossipPeer): void {
    // シンプルなレピュテーション計算
    const messageRatio = peer.messagesSent > 0 ? 
      peer.messagesReceived / peer.messagesSent : 1;
    
    const activityScore = Math.min(
      (peer.messagesSent + peer.messagesReceived) / 100,
      1
    );
    
    peer.reputation = (messageRatio * 0.5 + activityScore * 0.5) * 100;
  }
  
  // 確認閾値のチェック
  private checkConfirmationThreshold(
    message: GossipMessage,
    metadata: MessageMetadata
  ): void {
    const confirmationRate = metadata.confirmations.size / this.peers.size;
    
    if (confirmationRate >= 0.51) { // 過半数
      this.emit('messageConfirmed', {
        message,
        confirmations: metadata.confirmations.size,
        totalPeers: this.peers.size
      });
    }
  }
  
  // 履歴のクリーンアップ
  private cleanupHistory(): void {
    const now = Date.now();
    const timeout = this.config.historyTimeout * 1000;
    
    for (const [messageId, metadata] of this.messageHistory) {
      if (now - metadata.lastSeen > timeout) {
        this.messageHistory.delete(messageId);
      }
    }
    
    // 履歴サイズの制限
    if (this.messageHistory.size > this.config.historySize) {
      const entries = Array.from(this.messageHistory.entries());
      entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      
      const toRemove = entries.slice(0, entries.length - this.config.historySize);
      for (const [id] of toRemove) {
        this.messageHistory.delete(id);
      }
    }
  }
  
  // 統計の更新
  private updateAverageHops(hops: number): void {
    const total = this.stats.messagesRelayed;
    const oldAvg = this.stats.averageHops;
    
    this.stats.averageHops = (oldAvg * (total - 1) + hops) / total;
  }
  
  private updateAverageLatency(latency: number): void {
    const total = this.stats.uniqueMessages;
    const oldAvg = this.stats.averageLatency;
    
    this.stats.averageLatency = (oldAvg * (total - 1) + latency) / total;
  }
  
  // ユーティリティメソッド
  private generateMessageId(): string {
    return createHash('sha256')
      .update(this.config.nodeId)
      .update(Date.now().toString())
      .update(randomBytes(16))
      .digest('hex');
  }
  
  private signMessage(message: GossipMessage): string {
    // デジタル署名の実装（簡略化）
    return 'mock_signature';
  }
  
  private verifySignature(message: GossipMessage): boolean {
    // 署名検証の実装（簡略化）
    return true;
  }
  
  // 公開API
  getPeers(): GossipPeer[] {
    return Array.from(this.peers.values());
  }
  
  getActivePeers(): GossipPeer[] {
    return Array.from(this.peers.values()).filter(p => p.isActive);
  }
  
  getMessageHistory(messageId: string): MessageMetadata | null {
    return this.messageHistory.get(messageId) || null;
  }
  
  getStatistics(): GossipStats {
    // 追加の統計計算
    const activePeers = this.getActivePeers().length;
    const totalPeers = this.peers.size;
    
    this.stats.coverageRate = totalPeers > 0 ? activePeers / totalPeers : 0;
    
    const totalReceived = Array.from(this.messageHistory.values())
      .reduce((sum, m) => sum + m.receivedCount, 0);
    
    this.stats.redundancyRate = this.stats.uniqueMessages > 0 ?
      (totalReceived - this.stats.uniqueMessages) / this.stats.uniqueMessages : 0;
    
    return { ...this.stats };
  }
  
  // メッセージの再ブロードキャスト
  rebroadcast(messageId: string): boolean {
    const metadata = this.messageHistory.get(messageId);
    if (!metadata) return false;
    
    // メッセージの再構築（実装依存）
    // this.enqueueMessage(message);
    
    return true;
  }
  
  // 特定のピアへの直接送信
  sendDirect(peerId: string, type: string, payload: any): boolean {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.isActive) return false;
    
    const message: GossipMessage = {
      id: this.generateMessageId(),
      type,
      payload,
      origin: this.config.nodeId,
      timestamp: Date.now(),
      ttl: 1, // 直接送信は転送しない
      round: 0,
      path: [this.config.nodeId],
      priority: 0 // 最高優先度
    };
    
    this.sendToPeer(peer, message);
    return true;
  }
  
  // ネットワーク全体の健全性チェック
  getNetworkHealth(): {
    healthy: boolean;
    activePeerRatio: number;
    messageDeliveryRate: number;
    averageReputation: number;
  } {
    const activePeerRatio = this.peers.size > 0 ?
      this.getActivePeers().length / this.peers.size : 0;
    
    const messageDeliveryRate = this.stats.uniqueMessages > 0 ?
      1 - (this.stats.messagesExpired / this.stats.uniqueMessages) : 1;
    
    const reputations = Array.from(this.peers.values()).map(p => p.reputation);
    const averageReputation = reputations.length > 0 ?
      reputations.reduce((sum, r) => sum + r, 0) / reputations.length : 0;
    
    return {
      healthy: activePeerRatio > 0.5 && messageDeliveryRate > 0.8,
      activePeerRatio,
      messageDeliveryRate,
      averageReputation
    };
  }
}

// === デフォルト伝播戦略 ===
class DefaultPropagationStrategy implements PropagationStrategy {
  constructor(private config: GossipConfig) {}
  
  selectPeers(peers: GossipPeer[], message: GossipMessage): GossipPeer[] {
    // アクティブなピアをフィルタ
    const activePeers = peers.filter(p => 
      p.isActive && 
      !message.path.includes(p.nodeId)
    );
    
    if (activePeers.length <= this.config.fanout) {
      return activePeers;
    }
    
    // レピュテーションでソート
    activePeers.sort((a, b) => b.reputation - a.reputation);
    
    // 上位ピアと一部ランダムピアを選択
    const topPeers = activePeers.slice(0, Math.floor(this.config.fanout * 0.7));
    const remainingPeers = activePeers.slice(Math.floor(this.config.fanout * 0.7));
    
    // ランダムに選択
    const randomPeers: GossipPeer[] = [];
    const randomCount = this.config.fanout - topPeers.length;
    
    for (let i = 0; i < randomCount && remainingPeers.length > 0; i++) {
      const index = Math.floor(Math.random() * remainingPeers.length);
      randomPeers.push(remainingPeers.splice(index, 1)[0]);
    }
    
    return [...topPeers, ...randomPeers];
  }
  
  shouldRelay(message: GossipMessage, metadata: MessageMetadata): boolean {
    // TTLチェック
    if (message.round >= message.ttl) {
      return false;
    }
    
    // 最大ラウンド数チェック
    if (message.round >= this.config.maxRounds) {
      return false;
    }
    
    // 既に十分に伝播している場合は転送しない
    if (metadata.receivedCount > this.config.fanout * 2) {
      return false;
    }
    
    return true;
  }
  
  calculateDelay(message: GossipMessage): number {
    // 優先度に基づく遅延
    const priority = message.priority || 5;
    const baseDelay = 10; // 10ms
    
    return baseDelay * (priority + 1);
  }
}

// === 高度な伝播戦略の例 ===
export class AdaptivePropagationStrategy implements PropagationStrategy {
  private performanceHistory: Map<string, number> = new Map();
  
  constructor(private config: GossipConfig) {}
  
  selectPeers(peers: GossipPeer[], message: GossipMessage): GossipPeer[] {
    // メッセージタイプに基づいて戦略を変更
    if (message.priority === 0) {
      // 高優先度メッセージは信頼性の高いピアに送信
      return peers
        .filter(p => p.isActive && p.reputation > 80)
        .slice(0, this.config.fanout * 2); // より多くのピアに送信
    }
    
    // 通常のメッセージは負荷分散
    const peerLoads = new Map<string, number>();
    
    for (const peer of peers) {
      const recentMessages = this.performanceHistory.get(peer.nodeId) || 0;
      peerLoads.set(peer.nodeId, recentMessages);
    }
    
    // 負荷の低いピアを優先
    return peers
      .filter(p => p.isActive)
      .sort((a, b) => {
        const loadA = peerLoads.get(a.nodeId) || 0;
        const loadB = peerLoads.get(b.nodeId) || 0;
        return loadA - loadB;
      })
      .slice(0, this.config.fanout);
  }
  
  shouldRelay(message: GossipMessage, metadata: MessageMetadata): boolean {
    // ネットワークの状態に基づいて動的に判断
    const redundancyTarget = message.priority === 0 ? 0.9 : 0.7;
    const currentRedundancy = metadata.receivedCount / this.config.fanout;
    
    return currentRedundancy < redundancyTarget;
  }
  
  calculateDelay(message: GossipMessage): number {
    // ネットワークの混雑度に基づいて遅延を調整
    const congestionLevel = this.estimateCongestion();
    const baseDelay = 10;
    
    return baseDelay * (1 + congestionLevel);
  }
  
  private estimateCongestion(): number {
    // ネットワーク混雑度の推定（簡略化）
    return Math.random() * 0.5; // 0-0.5の値
  }
}

export default GossipProtocolManager;