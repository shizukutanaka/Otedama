/**
 * リアルタイム残高管理システム
 * WebSocketによるリアルタイム残高更新と通知
 * 
 * 設計思想：
 * - Carmack: 低レイテンシーなリアルタイム更新
 * - Martin: イベント駆動型の残高管理
 * - Pike: シンプルで信頼性の高い残高追跡
 */

import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import { PoolDatabase, MinerRecord, ShareRecord } from '../database/pool-database';
import { Redis } from 'ioredis';

// === 型定義 ===
export interface BalanceUpdate {
  minerId: string;
  address: string;
  previousBalance: number;
  currentBalance: number;
  change: number;
  changeType: 'share_reward' | 'block_reward' | 'payment' | 'fee' | 'adjustment';
  timestamp: number;
  details?: any;
}

export interface RealTimeBalance {
  minerId: string;
  address: string;
  confirmedBalance: number;    // 確定残高
  pendingBalance: number;      // 未確定残高
  lockedBalance: number;       // ロック中残高
  totalPaid: number;          // 総支払い額
  estimatedEarnings: number;   // 推定収益
  lastUpdate: number;         // 最終更新時刻
  
  // リアルタイム統計
  shareRate: number;          // シェア/分
  hashRate: number;           // ハッシュレート
  efficiency: number;         // 効率性（有効シェア率）
  activeWorkers: number;      // アクティブワーカー数
  
  // 24時間統計
  earnings24h: number;        // 24時間収益
  shares24h: number;          // 24時間シェア数
  avgHashRate24h: number;     // 24時間平均ハッシュレート
}

export interface BalanceSubscription {
  minerId: string;
  ws: WebSocket;
  lastPing: number;
  filters?: {
    minChange?: number;      // 最小変更額
    events?: string[];       // 購読イベント
  };
}

export interface BalanceSnapshot {
  timestamp: number;
  balances: Map<string, RealTimeBalance>;
  totalPoolBalance: number;
  activeMiners: number;
  pendingPayments: number;
}

export interface BalanceHistory {
  minerId: string;
  history: Array<{
    timestamp: number;
    balance: number;
    type: string;
  }>;
}

// === リアルタイム残高マネージャー ===
export class RealTimeBalanceManager extends EventEmitter {
  private database: PoolDatabase;
  private redis?: Redis;
  private wss: WebSocketServer;
  private subscriptions: Map<string, BalanceSubscription[]> = new Map();
  private balanceCache: Map<string, RealTimeBalance> = new Map();
  private updateQueue: BalanceUpdate[] = [];
  private isProcessing = false;
  
  // 設定
  private updateInterval = 1000;      // 更新間隔（ミリ秒）
  private snapshotInterval = 60000;   // スナップショット間隔
  private historyRetention = 86400000; // 履歴保持期間（24時間）
  
  constructor(
    database: PoolDatabase,
    port: number,
    redis?: Redis
  ) {
    super();
    this.database = database;
    this.redis = redis;
    
    // WebSocketサーバーの初期化
    this.wss = new WebSocketServer({ port });
    this.setupWebSocketServer();
  }
  
  // システムの開始
  async start(): Promise<void> {
    // 初期残高の読み込み
    await this.loadInitialBalances();
    
    // 更新処理の開始
    setInterval(() => this.processUpdateQueue(), this.updateInterval);
    
    // スナップショット処理の開始
    setInterval(() => this.createSnapshot(), this.snapshotInterval);
    
    // 期限切れ履歴のクリーンアップ
    setInterval(() => this.cleanupHistory(), 3600000); // 1時間ごと
    
    this.emit('started');
  }
  
  // WebSocketサーバーのセットアップ
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const minerId = this.extractMinerId(req.url || '');
      
      if (!minerId) {
        ws.close(1008, 'Miner ID required');
        return;
      }
      
      // 認証チェック（実装依存）
      if (!this.authenticateConnection(minerId, req)) {
        ws.close(1008, 'Authentication failed');
        return;
      }
      
      // サブスクリプションの追加
      const subscription: BalanceSubscription = {
        minerId,
        ws,
        lastPing: Date.now()
      };
      
      this.addSubscription(minerId, subscription);
      
      // 初期残高の送信
      this.sendInitialBalance(minerId, ws);
      
      // メッセージハンドラー
      ws.on('message', (message) => {
        this.handleWebSocketMessage(minerId, ws, message);
      });
      
      // 切断ハンドラー
      ws.on('close', () => {
        this.removeSubscription(minerId, ws);
      });
      
      // エラーハンドラー
      ws.on('error', (error) => {
        this.emit('wsError', { minerId, error });
        this.removeSubscription(minerId, ws);
      });
      
      // Pingハンドラー
      ws.on('ping', () => {
        subscription.lastPing = Date.now();
      });
    });
  }
  
  // シェア送信時の残高更新
  async updateBalanceForShare(share: ShareRecord): Promise<void> {
    if (!share.valid) return;
    
    try {
      const miner = await this.database.getMiner(share.minerId);
      if (!miner) return;
      
      // リアルタイム残高の取得/作成
      const balance = await this.getOrCreateBalance(share.minerId, miner.address);
      
      // シェア報酬の計算（PPS方式の場合）
      const shareValue = this.calculateShareValue(share);
      
      // 残高更新
      const update: BalanceUpdate = {
        minerId: share.minerId,
        address: miner.address,
        previousBalance: balance.pendingBalance,
        currentBalance: balance.pendingBalance + shareValue,
        change: shareValue,
        changeType: 'share_reward',
        timestamp: Date.now(),
        details: {
          shareId: share.shareId,
          difficulty: share.difficulty,
          worker: share.worker
        }
      };
      
      // 更新キューに追加
      this.updateQueue.push(update);
      
      // 統計の更新
      this.updateMinerStats(share.minerId, share);
      
    } catch (error) {
      this.emit('error', { error, context: 'updateBalanceForShare' });
    }
  }
  
  // ブロック発見時の残高更新
  async updateBalanceForBlock(
    blockHeight: number,
    minerRewards: Map<string, number>
  ): Promise<void> {
    try {
      const updates: BalanceUpdate[] = [];
      
      for (const [minerId, reward] of minerRewards) {
        const miner = await this.database.getMiner(minerId);
        if (!miner) continue;
        
        const balance = await this.getOrCreateBalance(minerId, miner.address);
        
        updates.push({
          minerId,
          address: miner.address,
          previousBalance: balance.confirmedBalance,
          currentBalance: balance.confirmedBalance + reward,
          change: reward,
          changeType: 'block_reward',
          timestamp: Date.now(),
          details: {
            blockHeight,
            reward
          }
        });
      }
      
      // バッチ更新
      this.updateQueue.push(...updates);
      
    } catch (error) {
      this.emit('error', { error, context: 'updateBalanceForBlock' });
    }
  }
  
  // 支払い処理時の残高更新
  async updateBalanceForPayment(
    minerId: string,
    amount: number,
    txHash: string
  ): Promise<void> {
    try {
      const miner = await this.database.getMiner(minerId);
      if (!miner) return;
      
      const balance = await this.getOrCreateBalance(minerId, miner.address);
      
      const update: BalanceUpdate = {
        minerId,
        address: miner.address,
        previousBalance: balance.confirmedBalance,
        currentBalance: Math.max(0, balance.confirmedBalance - amount),
        change: -amount,
        changeType: 'payment',
        timestamp: Date.now(),
        details: {
          txHash,
          amount
        }
      };
      
      this.updateQueue.push(update);
      
    } catch (error) {
      this.emit('error', { error, context: 'updateBalanceForPayment' });
    }
  }
  
  // 更新キューの処理
  private async processUpdateQueue(): Promise<void> {
    if (this.isProcessing || this.updateQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    const updates = [...this.updateQueue];
    this.updateQueue = [];
    
    try {
      // バッチ更新
      const updatesByMiner = new Map<string, BalanceUpdate[]>();
      
      for (const update of updates) {
        const minerUpdates = updatesByMiner.get(update.minerId) || [];
        minerUpdates.push(update);
        updatesByMiner.set(update.minerId, minerUpdates);
      }
      
      // マイナーごとに処理
      for (const [minerId, minerUpdates] of updatesByMiner) {
        await this.processMinerUpdates(minerId, minerUpdates);
      }
      
    } catch (error) {
      this.emit('error', { error, context: 'processUpdateQueue' });
    } finally {
      this.isProcessing = false;
    }
  }
  
  // マイナーの更新処理
  private async processMinerUpdates(
    minerId: string,
    updates: BalanceUpdate[]
  ): Promise<void> {
    const balance = this.balanceCache.get(minerId);
    if (!balance) return;
    
    // 残高の集計
    let confirmedChange = 0;
    let pendingChange = 0;
    
    for (const update of updates) {
      switch (update.changeType) {
        case 'share_reward':
          pendingChange += update.change;
          break;
        case 'block_reward':
          confirmedChange += update.change;
          pendingChange -= update.change; // 未確定から確定へ
          break;
        case 'payment':
          confirmedChange += update.change;
          break;
      }
    }
    
    // 残高の更新
    balance.confirmedBalance += confirmedChange;
    balance.pendingBalance += pendingChange;
    balance.lastUpdate = Date.now();
    
    // データベースの更新
    await this.updateDatabaseBalance(minerId, balance);
    
    // Redisキャッシュの更新
    if (this.redis) {
      await this.updateRedisBalance(minerId, balance);
    }
    
    // WebSocket通知
    this.notifyBalanceUpdate(minerId, updates);
    
    // 履歴の記録
    await this.recordBalanceHistory(minerId, updates);
  }
  
  // WebSocket通知の送信
  private notifyBalanceUpdate(minerId: string, updates: BalanceUpdate[]): void {
    const subscriptions = this.subscriptions.get(minerId) || [];
    const balance = this.balanceCache.get(minerId);
    
    if (!balance) return;
    
    const message = JSON.stringify({
      type: 'balance_update',
      data: {
        balance: this.formatBalance(balance),
        updates: updates.map(u => ({
          change: u.change,
          type: u.changeType,
          timestamp: u.timestamp,
          details: u.details
        }))
      }
    });
    
    // 各サブスクライバーに送信
    for (const sub of subscriptions) {
      if (sub.ws.readyState === WebSocket.OPEN) {
        // フィルターチェック
        if (sub.filters?.minChange && 
            Math.abs(updates.reduce((sum, u) => sum + u.change, 0)) < sub.filters.minChange) {
          continue;
        }
        
        sub.ws.send(message);
      }
    }
  }
  
  // WebSocketメッセージの処理
  private handleWebSocketMessage(
    minerId: string,
    ws: WebSocket,
    message: any
  ): void {
    try {
      const data = JSON.parse(message.toString());
      
      switch (data.type) {
        case 'subscribe':
          this.handleSubscribe(minerId, ws, data);
          break;
          
        case 'get_balance':
          this.sendCurrentBalance(minerId, ws);
          break;
          
        case 'get_history':
          this.sendBalanceHistory(minerId, ws, data);
          break;
          
        case 'get_stats':
          this.sendMinerStats(minerId, ws);
          break;
          
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
          
        default:
          ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Unknown message type' 
          }));
      }
    } catch (error) {
      ws.send(JSON.stringify({ 
        type: 'error', 
        message: 'Invalid message format' 
      }));
    }
  }
  
  // 購読設定の処理
  private handleSubscribe(minerId: string, ws: WebSocket, data: any): void {
    const subscription = this.findSubscription(minerId, ws);
    
    if (subscription && data.filters) {
      subscription.filters = {
        minChange: data.filters.minChange,
        events: data.filters.events || []
      };
      
      ws.send(JSON.stringify({
        type: 'subscribed',
        filters: subscription.filters
      }));
    }
  }
  
  // 現在の残高送信
  private async sendCurrentBalance(minerId: string, ws: WebSocket): Promise<void> {
    const balance = this.balanceCache.get(minerId);
    
    if (balance) {
      ws.send(JSON.stringify({
        type: 'balance',
        data: this.formatBalance(balance)
      }));
    } else {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Balance not found'
      }));
    }
  }
  
  // 残高履歴の送信
  private async sendBalanceHistory(
    minerId: string,
    ws: WebSocket,
    data: any
  ): Promise<void> {
    const limit = data.limit || 100;
    const history = await this.getBalanceHistory(minerId, limit);
    
    ws.send(JSON.stringify({
      type: 'history',
      data: history
    }));
  }
  
  // マイナー統計の送信
  private async sendMinerStats(minerId: string, ws: WebSocket): Promise<void> {
    const balance = this.balanceCache.get(minerId);
    
    if (balance) {
      const stats = {
        shareRate: balance.shareRate,
        hashRate: balance.hashRate,
        efficiency: balance.efficiency,
        activeWorkers: balance.activeWorkers,
        earnings24h: balance.earnings24h,
        shares24h: balance.shares24h,
        avgHashRate24h: balance.avgHashRate24h
      };
      
      ws.send(JSON.stringify({
        type: 'stats',
        data: stats
      }));
    }
  }
  
  // 残高のフォーマット
  private formatBalance(balance: RealTimeBalance): any {
    return {
      minerId: balance.minerId,
      address: balance.address,
      confirmed: balance.confirmedBalance,
      pending: balance.pendingBalance,
      locked: balance.lockedBalance,
      total: balance.confirmedBalance + balance.pendingBalance,
      totalPaid: balance.totalPaid,
      estimated: balance.estimatedEarnings,
      lastUpdate: balance.lastUpdate
    };
  }
  
  // マイナー統計の更新
  private async updateMinerStats(minerId: string, share: ShareRecord): Promise<void> {
    const balance = this.balanceCache.get(minerId);
    if (!balance) return;
    
    // シェアレートの更新（移動平均）
    const now = Date.now();
    const timeDiff = (now - balance.lastUpdate) / 60000; // 分単位
    
    if (timeDiff > 0) {
      const instantRate = 1 / timeDiff;
      balance.shareRate = balance.shareRate * 0.9 + instantRate * 0.1;
    }
    
    // ハッシュレートの推定
    balance.hashRate = share.difficulty * 4294967296 / 600; // 簡略化
    
    // 24時間統計の更新（Redisを使用）
    if (this.redis) {
      const key24h = `stats:24h:${minerId}`;
      await this.redis.hincrby(key24h, 'shares', 1);
      await this.redis.expire(key24h, 86400);
    }
  }
  
  // シェア価値の計算
  private calculateShareValue(share: ShareRecord): number {
    // PPS方式の簡単な計算例
    const blockReward = 6.25; // BTC
    const networkDifficulty = 25000000000000; // 仮の値
    const ppsRate = blockReward / networkDifficulty;
    
    return share.difficulty * ppsRate * 0.99; // 1%プール手数料
  }
  
  // 初期残高の読み込み
  private async loadInitialBalances(): Promise<void> {
    const miners = await this.database.getAllMiners();
    
    for (const miner of miners) {
      const balance: RealTimeBalance = {
        minerId: miner.minerId,
        address: miner.address,
        confirmedBalance: miner.balance || 0,
        pendingBalance: 0,
        lockedBalance: 0,
        totalPaid: miner.paidAmount || 0,
        estimatedEarnings: 0,
        lastUpdate: Date.now(),
        shareRate: 0,
        hashRate: 0,
        efficiency: 1,
        activeWorkers: 0,
        earnings24h: 0,
        shares24h: 0,
        avgHashRate24h: 0
      };
      
      this.balanceCache.set(miner.minerId, balance);
    }
  }
  
  // ユーティリティメソッド
  private extractMinerId(url: string): string | null {
    const match = url.match(/\/balance\/([^\/\?]+)/);
    return match ? match[1] : null;
  }
  
  private authenticateConnection(minerId: string, req: any): boolean {
    // 実装に応じた認証ロジック
    return true;
  }
  
  private findSubscription(minerId: string, ws: WebSocket): BalanceSubscription | undefined {
    const subs = this.subscriptions.get(minerId) || [];
    return subs.find(s => s.ws === ws);
  }
  
  private addSubscription(minerId: string, subscription: BalanceSubscription): void {
    const subs = this.subscriptions.get(minerId) || [];
    subs.push(subscription);
    this.subscriptions.set(minerId, subs);
    
    this.emit('subscriptionAdded', { minerId });
  }
  
  private removeSubscription(minerId: string, ws: WebSocket): void {
    const subs = this.subscriptions.get(minerId) || [];
    const filtered = subs.filter(s => s.ws !== ws);
    
    if (filtered.length > 0) {
      this.subscriptions.set(minerId, filtered);
    } else {
      this.subscriptions.delete(minerId);
    }
    
    this.emit('subscriptionRemoved', { minerId });
  }
  
  private async getOrCreateBalance(
    minerId: string,
    address: string
  ): Promise<RealTimeBalance> {
    let balance = this.balanceCache.get(minerId);
    
    if (!balance) {
      balance = {
        minerId,
        address,
        confirmedBalance: 0,
        pendingBalance: 0,
        lockedBalance: 0,
        totalPaid: 0,
        estimatedEarnings: 0,
        lastUpdate: Date.now(),
        shareRate: 0,
        hashRate: 0,
        efficiency: 1,
        activeWorkers: 0,
        earnings24h: 0,
        shares24h: 0,
        avgHashRate24h: 0
      };
      
      this.balanceCache.set(minerId, balance);
    }
    
    return balance;
  }
  
  private async sendInitialBalance(minerId: string, ws: WebSocket): Promise<void> {
    const balance = this.balanceCache.get(minerId);
    
    if (balance) {
      ws.send(JSON.stringify({
        type: 'initial_balance',
        data: this.formatBalance(balance)
      }));
    }
  }
  
  // データベース更新
  private async updateDatabaseBalance(
    minerId: string,
    balance: RealTimeBalance
  ): Promise<void> {
    const miner = await this.database.getMiner(minerId);
    if (miner) {
      miner.balance = balance.confirmedBalance;
      await this.database.upsertMiner(miner);
    }
  }
  
  // Redis更新
  private async updateRedisBalance(
    minerId: string,
    balance: RealTimeBalance
  ): Promise<void> {
    if (!this.redis) return;
    
    const key = `balance:${minerId}`;
    await this.redis.hmset(key, {
      confirmed: balance.confirmedBalance.toString(),
      pending: balance.pendingBalance.toString(),
      locked: balance.lockedBalance.toString(),
      lastUpdate: balance.lastUpdate.toString()
    });
    
    await this.redis.expire(key, 3600); // 1時間TTL
  }
  
  // 履歴記録
  private async recordBalanceHistory(
    minerId: string,
    updates: BalanceUpdate[]
  ): Promise<void> {
    if (!this.redis) return;
    
    const key = `balance:history:${minerId}`;
    const records = updates.map(u => JSON.stringify({
      timestamp: u.timestamp,
      balance: u.currentBalance,
      change: u.change,
      type: u.changeType
    }));
    
    await this.redis.lpush(key, ...records);
    await this.redis.ltrim(key, 0, 999); // 最新1000件を保持
    await this.redis.expire(key, 86400); // 24時間
  }
  
  // 履歴取得
  private async getBalanceHistory(
    minerId: string,
    limit: number
  ): Promise<BalanceHistory> {
    if (!this.redis) {
      return { minerId, history: [] };
    }
    
    const key = `balance:history:${minerId}`;
    const records = await this.redis.lrange(key, 0, limit - 1);
    
    const history = records.map(r => JSON.parse(r));
    
    return { minerId, history };
  }
  
  // スナップショット作成
  private async createSnapshot(): Promise<void> {
    const snapshot: BalanceSnapshot = {
      timestamp: Date.now(),
      balances: new Map(this.balanceCache),
      totalPoolBalance: 0,
      activeMiners: 0,
      pendingPayments: 0
    };
    
    // 統計の計算
    for (const balance of snapshot.balances.values()) {
      snapshot.totalPoolBalance += balance.confirmedBalance + balance.pendingBalance;
      if (balance.shareRate > 0) {
        snapshot.activeMiners++;
      }
      if (balance.confirmedBalance > 0.001) { // 最小支払い額
        snapshot.pendingPayments++;
      }
    }
    
    // スナップショットの保存
    if (this.redis) {
      const key = `snapshot:${snapshot.timestamp}`;
      await this.redis.set(key, JSON.stringify(snapshot), 'EX', 86400);
    }
    
    this.emit('snapshotCreated', snapshot);
  }
  
  // 履歴のクリーンアップ
  private async cleanupHistory(): Promise<void> {
    if (!this.redis) return;
    
    const cutoff = Date.now() - this.historyRetention;
    
    // 古いスナップショットの削除
    const keys = await this.redis.keys('snapshot:*');
    for (const key of keys) {
      const timestamp = parseInt(key.split(':')[1]);
      if (timestamp < cutoff) {
        await this.redis.del(key);
      }
    }
  }
  
  // 公開API
  async getBalance(minerId: string): Promise<RealTimeBalance | null> {
    return this.balanceCache.get(minerId) || null;
  }
  
  async getAllBalances(): Promise<RealTimeBalance[]> {
    return Array.from(this.balanceCache.values());
  }
  
  async getPoolStats(): Promise<any> {
    let totalBalance = 0;
    let activeMiners = 0;
    let totalHashRate = 0;
    
    for (const balance of this.balanceCache.values()) {
      totalBalance += balance.confirmedBalance + balance.pendingBalance;
      if (balance.shareRate > 0) {
        activeMiners++;
        totalHashRate += balance.hashRate;
      }
    }
    
    return {
      totalBalance,
      activeMiners,
      totalHashRate,
      minerCount: this.balanceCache.size,
      subscriptionCount: this.subscriptions.size
    };
  }
}

export default RealTimeBalanceManager;