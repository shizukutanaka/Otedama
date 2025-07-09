/**
 * マルチプール管理システム
 * 設計思想: John Carmack (効率的), Robert C. Martin (拡張可能), Rob Pike (シンプル)
 * 
 * 機能:
 * - 複数プール同時接続
 * - 自動プール切り替え
 * - 収益性ベース最適化
 * - フェイルオーバー
 * - プール統計監視
 */

import { EventEmitter } from 'events';
import { createConnection, Socket } from 'net';
import { StratumV2Server } from '../stratum-v2/stratum-v2-protocol';

// === 型定義 ===
export interface PoolConfig {
  id: string;
  name: string;
  url: string;
  port: number;
  algorithm: string;
  coin: string;
  username: string;
  password: string;
  worker: string;
  protocol: 'stratum' | 'stratum-v2' | 'getwork';
  fee: number; // %
  minPayout: number;
  payoutMethod: 'PPS' | 'PPLNS' | 'PROP' | 'SOLO';
  priority: number; // 1-10 (10が最高)
  backup: boolean;
  enabled: boolean;
  region: string;
  ssl: boolean;
  keepAlive: number; // seconds
}

export interface PoolConnection {
  id: string;
  config: PoolConfig;
  socket?: Socket;
  status: 'disconnected' | 'connecting' | 'connected' | 'authenticated' | 'mining' | 'error';
  lastConnect: number;
  lastActivity: number;
  reconnectAttempts: number;
  latency: number;
  difficulty: number;
  sharesAccepted: number;
  sharesRejected: number;
  sharesStale: number;
  hashrate: number;
  earnings: number;
  uptime: number;
  errorCount: number;
  lastError?: string;
}

export interface PoolStats {
  poolId: string;
  efficiency: number; // accepted / (accepted + rejected + stale)
  profitability: number; // USD/day
  latency: number; // ms
  uptime: number; // %
  hashrate: number; // H/s
  shareRate: number; // shares/min
  rejectRate: number; // %
  staleRate: number; // %
  lastPayment?: {
    amount: number;
    timestamp: number;
    txid?: string;
  };
}

export interface SwitchingStrategy {
  name: string;
  enabled: boolean;
  criteria: {
    profitability: { weight: number; threshold: number };
    latency: { weight: number; threshold: number };
    efficiency: { weight: number; threshold: number };
    uptime: { weight: number; threshold: number };
  };
  switchCooldown: number; // seconds
  minDuration: number; // seconds
  hysteresis: number; // % to prevent flapping
}

export interface MultiPoolConfig {
  autoSwitch: boolean;
  strategy: SwitchingStrategy;
  maxConnections: number;
  healthCheckInterval: number; // ms
  statsInterval: number; // ms
  reconnectDelay: number; // ms
  maxReconnectAttempts: number;
  backup: {
    enabled: boolean;
    activateOnFailure: boolean;
    preferredPools: string[];
  };
}

// === プール接続マネージャー ===
export class PoolConnectionManager extends EventEmitter {
  private connection: PoolConnection;
  private messageQueue: any[] = [];
  private subscriptionId?: string;

  constructor(config: PoolConfig) {
    super();
    
    this.connection = {
      id: config.id,
      config,
      status: 'disconnected',
      lastConnect: 0,
      lastActivity: 0,
      reconnectAttempts: 0,
      latency: 0,
      difficulty: 1,
      sharesAccepted: 0,
      sharesRejected: 0,
      sharesStale: 0,
      hashrate: 0,
      earnings: 0,
      uptime: 0,
      errorCount: 0
    };
  }

  /**
   * プールに接続
   */
  async connect(): Promise<boolean> {
    if (this.connection.status === 'connected' || this.connection.status === 'connecting') {
      return true;
    }

    this.connection.status = 'connecting';
    this.connection.lastConnect = Date.now();

    try {
      await this.establishConnection();
      await this.authenticate();
      await this.subscribe();
      
      this.connection.status = 'mining';
      this.connection.reconnectAttempts = 0;
      this.connection.errorCount = 0;
      
      this.emit('connected', this.connection.id);
      console.log(`✅ プール接続成功: ${this.connection.config.name}`);
      
      return true;
    } catch (error) {
      this.connection.status = 'error';
      this.connection.errorCount++;
      this.connection.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.connection.reconnectAttempts++;
      
      this.emit('connectionError', { poolId: this.connection.id, error });
      console.error(`❌ プール接続失敗: ${this.connection.config.name}`, error);
      
      return false;
    }
  }

  /**
   * プールから切断
   */
  async disconnect(): Promise<void> {
    if (this.connection.socket) {
      this.connection.socket.destroy();
      this.connection.socket = undefined;
    }
    
    this.connection.status = 'disconnected';
    this.emit('disconnected', this.connection.id);
    console.log(`🔌 プール切断: ${this.connection.config.name}`);
  }

  /**
   * シェア送信
   */
  async submitShare(share: {
    jobId: string;
    nonce: string;
    result: string;
    difficulty: number;
  }): Promise<boolean> {
    if (this.connection.status !== 'mining') {
      return false;
    }

    try {
      const startTime = Date.now();
      
      const message = this.buildShareMessage(share);
      await this.sendMessage(message);
      
      // レスポンス待機（簡略化）
      const response = await this.waitForResponse(message.id, 5000);
      const latency = Date.now() - startTime;
      
      this.connection.latency = latency;
      this.connection.lastActivity = Date.now();
      
      if (response && response.result === true) {
        this.connection.sharesAccepted++;
        this.emit('shareAccepted', { poolId: this.connection.id, share, latency });
        return true;
      } else {
        this.connection.sharesRejected++;
        this.emit('shareRejected', { poolId: this.connection.id, share, reason: response?.error });
        return false;
      }
    } catch (error) {
      this.connection.sharesRejected++;
      this.emit('shareError', { poolId: this.connection.id, share, error });
      return false;
    }
  }

  /**
   * 統計情報の取得
   */
  getStats(): PoolStats {
    const totalShares = this.connection.sharesAccepted + this.connection.sharesRejected + this.connection.sharesStale;
    const efficiency = totalShares > 0 ? this.connection.sharesAccepted / totalShares : 0;
    const rejectRate = totalShares > 0 ? (this.connection.sharesRejected / totalShares) * 100 : 0;
    const staleRate = totalShares > 0 ? (this.connection.sharesStale / totalShares) * 100 : 0;
    
    const now = Date.now();
    const connectionTime = this.connection.lastConnect > 0 ? now - this.connection.lastConnect : 0;
    const uptime = connectionTime > 0 ? ((connectionTime - this.connection.errorCount * 30000) / connectionTime) * 100 : 0;
    
    return {
      poolId: this.connection.id,
      efficiency: efficiency * 100,
      profitability: this.calculateProfitability(),
      latency: this.connection.latency,
      uptime: Math.max(0, uptime),
      hashrate: this.connection.hashrate,
      shareRate: this.calculateShareRate(),
      rejectRate,
      staleRate
    };
  }

  private async establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({
        host: this.connection.config.url,
        port: this.connection.config.port,
        timeout: 10000
      });

      socket.on('connect', () => {
        this.connection.socket = socket;
        this.setupSocketHandlers();
        resolve();
      });

      socket.on('error', (error) => {
        reject(error);
      });

      socket.on('timeout', () => {
        reject(new Error('Connection timeout'));
      });
    });
  }

  private setupSocketHandlers(): void {
    if (!this.connection.socket) return;

    this.connection.socket.on('data', (data) => {
      this.handleIncomingData(data);
    });

    this.connection.socket.on('close', () => {
      this.emit('disconnected', this.connection.id);
      this.attemptReconnect();
    });

    this.connection.socket.on('error', (error) => {
      this.connection.errorCount++;
      this.connection.lastError = error.message;
      this.emit('connectionError', { poolId: this.connection.id, error });
    });

    // Keep-alive
    if (this.connection.config.keepAlive > 0) {
      setInterval(() => {
        if (this.connection.socket && this.connection.status === 'mining') {
          this.sendPing();
        }
      }, this.connection.config.keepAlive * 1000);
    }
  }

  private async authenticate(): Promise<void> {
    const authMessage = {
      id: this.generateMessageId(),
      method: 'mining.authorize',
      params: [
        this.connection.config.username,
        this.connection.config.password
      ]
    };

    await this.sendMessage(authMessage);
    const response = await this.waitForResponse(authMessage.id, 5000);
    
    if (!response || !response.result) {
      throw new Error('Authentication failed');
    }

    this.connection.status = 'authenticated';
  }

  private async subscribe(): Promise<void> {
    const subscribeMessage = {
      id: this.generateMessageId(),
      method: 'mining.subscribe',
      params: [
        `Otedama/${this.connection.config.worker}`,
        null,
        this.connection.config.url,
        this.connection.config.port.toString()
      ]
    };

    await this.sendMessage(subscribeMessage);
    const response = await this.waitForResponse(subscribeMessage.id, 5000);
    
    if (!response || !response.result) {
      throw new Error('Subscription failed');
    }

    this.subscriptionId = response.result[0][0][1];
  }

  private buildShareMessage(share: any): any {
    return {
      id: this.generateMessageId(),
      method: 'mining.submit',
      params: [
        this.connection.config.username,
        share.jobId,
        '00000000', // extranonce2
        Math.floor(Date.now() / 1000).toString(16), // ntime
        share.nonce
      ]
    };
  }

  private async sendMessage(message: any): Promise<void> {
    if (!this.connection.socket) {
      throw new Error('Socket not connected');
    }

    const data = JSON.stringify(message) + '\n';
    this.connection.socket.write(data);
  }

  private async waitForResponse(messageId: string, timeout: number): Promise<any> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeout);
      
      const handler = (response: any) => {
        if (response.id === messageId) {
          clearTimeout(timer);
          this.removeListener('message', handler);
          resolve(response);
        }
      };
      
      this.on('message', handler);
    });
  }

  private handleIncomingData(data: Buffer): void {
    const lines = data.toString().trim().split('\n');
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const message = JSON.parse(line);
        this.connection.lastActivity = Date.now();
        
        if (message.method) {
          this.handleNotification(message);
        } else {
          this.emit('message', message);
        }
      } catch (error) {
        console.warn('Invalid JSON received:', line);
      }
    }
  }

  private handleNotification(message: any): void {
    switch (message.method) {
      case 'mining.notify':
        this.emit('newJob', {
          poolId: this.connection.id,
          job: message.params
        });
        break;
        
      case 'mining.set_difficulty':
        this.connection.difficulty = message.params[0];
        this.emit('difficultyChanged', {
          poolId: this.connection.id,
          difficulty: this.connection.difficulty
        });
        break;
        
      case 'client.show_message':
        this.emit('poolMessage', {
          poolId: this.connection.id,
          message: message.params[0]
        });
        break;
    }
  }

  private sendPing(): void {
    const pingMessage = {
      id: this.generateMessageId(),
      method: 'mining.ping',
      params: []
    };
    
    this.sendMessage(pingMessage).catch(() => {
      // Ping失敗は無視
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.connection.reconnectAttempts >= 5) {
      this.emit('reconnectFailed', this.connection.id);
      return;
    }

    setTimeout(async () => {
      console.log(`🔄 プール再接続試行: ${this.connection.config.name} (試行 ${this.connection.reconnectAttempts + 1})`);
      await this.connect();
    }, Math.min(this.connection.reconnectAttempts * 2000, 30000)); // 指数バックオフ
  }

  private calculateProfitability(): number {
    // 簡略化された収益性計算
    const baseRate = 10; // USD/day base
    const efficiencyFactor = this.getStats().efficiency / 100;
    const latencyPenalty = Math.max(0, 1 - this.connection.latency / 1000);
    
    return baseRate * efficiencyFactor * latencyPenalty;
  }

  private calculateShareRate(): number {
    // 分あたりのシェア数を計算
    const totalShares = this.connection.sharesAccepted + this.connection.sharesRejected;
    const connectionTime = Date.now() - this.connection.lastConnect;
    const minutes = connectionTime / (1000 * 60);
    
    return minutes > 0 ? totalShares / minutes : 0;
  }

  private generateMessageId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  // Getters
  get status() { return this.connection.status; }
  get config() { return this.connection.config; }
  get connection() { return this.connection; }
}

// === マルチプールマネージャー ===
export class MultiPoolManager extends EventEmitter {
  private pools = new Map<string, PoolConnectionManager>();
  private config: MultiPoolConfig;
  private currentPool?: string;
  private lastSwitch = 0;
  private healthCheckInterval?: NodeJS.Timeout;
  private statsInterval?: NodeJS.Timeout;
  private switching = false;

  constructor(config: Partial<MultiPoolConfig> = {}) {
    super();
    
    this.config = {
      autoSwitch: true,
      strategy: {
        name: 'balanced',
        enabled: true,
        criteria: {
          profitability: { weight: 0.4, threshold: 5 }, // 5% improvement needed
          latency: { weight: 0.2, threshold: 100 },      // 100ms threshold
          efficiency: { weight: 0.3, threshold: 2 },     // 2% efficiency diff
          uptime: { weight: 0.1, threshold: 95 }         // 95% uptime required
        },
        switchCooldown: 300, // 5 minutes
        minDuration: 180,    // 3 minutes minimum
        hysteresis: 10       // 10% hysteresis
      },
      maxConnections: 5,
      healthCheckInterval: 30000, // 30 seconds
      statsInterval: 60000,       // 1 minute
      reconnectDelay: 5000,       // 5 seconds
      maxReconnectAttempts: 5,
      backup: {
        enabled: true,
        activateOnFailure: true,
        preferredPools: []
      },
      ...config
    };
  }

  /**
   * プール追加
   */
  addPool(poolConfig: PoolConfig): void {
    if (this.pools.has(poolConfig.id)) {
      throw new Error(`Pool already exists: ${poolConfig.id}`);
    }

    const poolManager = new PoolConnectionManager(poolConfig);
    this.setupPoolHandlers(poolManager);
    this.pools.set(poolConfig.id, poolManager);

    console.log(`➕ プール追加: ${poolConfig.name}`);
    this.emit('poolAdded', poolConfig.id);
  }

  /**
   * プール削除
   */
  async removePool(poolId: string): Promise<void> {
    const pool = this.pools.get(poolId);
    if (!pool) return;

    await pool.disconnect();
    this.pools.delete(poolId);

    if (this.currentPool === poolId) {
      this.currentPool = undefined;
      await this.selectBestPool();
    }

    console.log(`➖ プール削除: ${poolId}`);
    this.emit('poolRemoved', poolId);
  }

  /**
   * マルチプール開始
   */
  async start(): Promise<void> {
    console.log('🔗 マルチプール開始...');

    // 有効なプールに接続
    const connectionPromises = Array.from(this.pools.values())
      .filter(pool => pool.config.enabled)
      .map(pool => pool.connect());

    await Promise.allSettled(connectionPromises);

    // 最適プールを選択
    await this.selectBestPool();

    // 定期チェック開始
    this.startPeriodicTasks();

    console.log('✅ マルチプール開始完了');
    this.emit('started');
  }

  /**
   * マルチプール停止
   */
  async stop(): Promise<void> {
    console.log('🛑 マルチプール停止...');

    // 定期タスク停止
    this.stopPeriodicTasks();

    // 全プール切断
    const disconnectPromises = Array.from(this.pools.values())
      .map(pool => pool.disconnect());

    await Promise.allSettled(disconnectPromises);

    this.currentPool = undefined;
    console.log('✅ マルチプール停止完了');
    this.emit('stopped');
  }

  /**
   * シェア送信
   */
  async submitShare(share: any): Promise<boolean> {
    if (!this.currentPool) {
      console.warn('アクティブなプールがありません');
      return false;
    }

    const pool = this.pools.get(this.currentPool);
    if (!pool) return false;

    return await pool.submitShare(share);
  }

  /**
   * 手動プール切り替え
   */
  async switchToPool(poolId: string): Promise<boolean> {
    const pool = this.pools.get(poolId);
    if (!pool) {
      console.error(`プールが見つかりません: ${poolId}`);
      return false;
    }

    if (pool.status !== 'mining') {
      const connected = await pool.connect();
      if (!connected) return false;
    }

    this.currentPool = poolId;
    this.lastSwitch = Date.now();

    console.log(`🔄 プール切り替え: ${pool.config.name}`);
    this.emit('poolSwitched', { from: this.currentPool, to: poolId });

    return true;
  }

  /**
   * 最適プール自動選択
   */
  private async selectBestPool(): Promise<void> {
    if (this.switching) return;
    this.switching = true;

    try {
      const candidates = Array.from(this.pools.values())
        .filter(pool => pool.config.enabled && pool.status === 'mining')
        .map(pool => ({
          id: pool.config.id,
          pool,
          stats: pool.getStats(),
          score: this.calculatePoolScore(pool.getStats())
        }))
        .sort((a, b) => b.score - a.score);

      if (candidates.length === 0) {
        console.warn('利用可能なプールがありません');
        return;
      }

      const bestPool = candidates[0];
      const currentScore = this.currentPool ? 
        this.calculatePoolScore(this.pools.get(this.currentPool)?.getStats() || {} as PoolStats) : 0;

      // 切り替え判定
      const shouldSwitch = this.shouldSwitchPool(bestPool.score, currentScore);
      
      if (shouldSwitch && bestPool.id !== this.currentPool) {
        await this.switchToPool(bestPool.id);
      }

    } finally {
      this.switching = false;
    }
  }

  /**
   * プールスコア計算
   */
  private calculatePoolScore(stats: PoolStats): number {
    const criteria = this.config.strategy.criteria;
    let score = 0;

    // 収益性 (0-40点)
    const profitabilityScore = Math.min(stats.profitability / 20 * 40, 40);
    score += profitabilityScore * criteria.profitability.weight;

    // レイテンシ (0-20点、低いほど良い)
    const latencyScore = Math.max(20 - (stats.latency / 50), 0);
    score += latencyScore * criteria.latency.weight;

    // 効率性 (0-30点)
    const efficiencyScore = (stats.efficiency / 100) * 30;
    score += efficiencyScore * criteria.efficiency.weight;

    // アップタイム (0-10点)
    const uptimeScore = (stats.uptime / 100) * 10;
    score += uptimeScore * criteria.uptime.weight;

    return score;
  }

  /**
   * プール切り替え判定
   */
  private shouldSwitchPool(newScore: number, currentScore: number): boolean {
    if (!this.config.autoSwitch || !this.config.strategy.enabled) {
      return false;
    }

    // クールダウンチェック
    const timeSinceLastSwitch = Date.now() - this.lastSwitch;
    if (timeSinceLastSwitch < this.config.strategy.switchCooldown * 1000) {
      return false;
    }

    // 最小稼働時間チェック
    if (timeSinceLastSwitch < this.config.strategy.minDuration * 1000) {
      return false;
    }

    // ヒステリシス適用
    const improvementThreshold = currentScore * (this.config.strategy.hysteresis / 100);
    return newScore > currentScore + improvementThreshold;
  }

  /**
   * プールイベントハンドラー設定
   */
  private setupPoolHandlers(pool: PoolConnectionManager): void {
    pool.on('connected', (poolId) => {
      this.emit('poolConnected', poolId);
    });

    pool.on('disconnected', (poolId) => {
      this.emit('poolDisconnected', poolId);
      
      if (poolId === this.currentPool) {
        this.handleCurrentPoolDisconnection();
      }
    });

    pool.on('shareAccepted', (data) => {
      this.emit('shareAccepted', data);
    });

    pool.on('shareRejected', (data) => {
      this.emit('shareRejected', data);
    });

    pool.on('newJob', (data) => {
      if (data.poolId === this.currentPool) {
        this.emit('newJob', data);
      }
    });

    pool.on('connectionError', (data) => {
      this.emit('poolError', data);
    });
  }

  /**
   * 現在のプール切断時の処理
   */
  private async handleCurrentPoolDisconnection(): Promise<void> {
    console.warn(`⚠️ 現在のプールが切断されました: ${this.currentPool}`);

    if (this.config.backup.enabled && this.config.backup.activateOnFailure) {
      // バックアッププールに切り替え
      const backupPools = this.config.backup.preferredPools.length > 0 ?
        this.config.backup.preferredPools :
        Array.from(this.pools.keys()).filter(id => id !== this.currentPool);

      for (const poolId of backupPools) {
        const pool = this.pools.get(poolId);
        if (pool && pool.config.enabled) {
          const connected = await pool.connect();
          if (connected) {
            this.currentPool = poolId;
            console.log(`🔄 バックアッププールに切り替え: ${pool.config.name}`);
            this.emit('failoverActivated', poolId);
            return;
          }
        }
      }
    }

    this.currentPool = undefined;
    console.error('❌ 利用可能なバックアッププールがありません');
  }

  /**
   * 定期タスク開始
   */
  private startPeriodicTasks(): void {
    // ヘルスチェック
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.healthCheckInterval);

    // 統計更新と最適化
    this.statsInterval = setInterval(async () => {
      await this.updateStats();
      await this.selectBestPool();
    }, this.config.statsInterval);
  }

  /**
   * 定期タスク停止
   */
  private stopPeriodicTasks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = undefined;
    }
  }

  /**
   * ヘルスチェック実行
   */
  private async performHealthCheck(): Promise<void> {
    for (const pool of this.pools.values()) {
      if (pool.config.enabled && pool.status === 'disconnected') {
        // 切断されたプールの再接続試行
        await pool.connect();
      }
    }
  }

  /**
   * 統計更新
   */
  private async updateStats(): Promise<void> {
    const stats = this.getAllPoolStats();
    this.emit('statsUpdated', stats);
  }

  // === パブリックメソッド ===

  /**
   * 全プール統計取得
   */
  getAllPoolStats(): { poolId: string; stats: PoolStats }[] {
    return Array.from(this.pools.values()).map(pool => ({
      poolId: pool.config.id,
      stats: pool.getStats()
    }));
  }

  /**
   * 現在のプール取得
   */
  getCurrentPool(): PoolConfig | null {
    if (!this.currentPool) return null;
    
    const pool = this.pools.get(this.currentPool);
    return pool ? pool.config : null;
  }

  /**
   * プール一覧取得
   */
  getPools(): PoolConfig[] {
    return Array.from(this.pools.values()).map(pool => pool.config);
  }

  /**
   * 設定更新
   */
  updateConfig(newConfig: Partial<MultiPoolConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.emit('configUpdated', this.config);
  }

  /**
   * ステータス取得
   */
  getStatus(): {
    currentPool: string | null;
    totalPools: number;
    connectedPools: number;
    switching: boolean;
    lastSwitch: number;
  } {
    const connectedPools = Array.from(this.pools.values())
      .filter(pool => pool.status === 'mining').length;

    return {
      currentPool: this.currentPool || null,
      totalPools: this.pools.size,
      connectedPools,
      switching: this.switching,
      lastSwitch: this.lastSwitch
    };
  }
}

// === 使用例 ===
export async function startMultiPoolMining(): Promise<MultiPoolManager> {
  const multiPool = new MultiPoolManager({
    autoSwitch: true,
    strategy: {
      name: 'profit_focused',
      enabled: true,
      criteria: {
        profitability: { weight: 0.5, threshold: 3 },
        latency: { weight: 0.2, threshold: 150 },
        efficiency: { weight: 0.2, threshold: 2 },
        uptime: { weight: 0.1, threshold: 90 }
      },
      switchCooldown: 300,
      minDuration: 180,
      hysteresis: 15
    },
    backup: {
      enabled: true,
      activateOnFailure: true,
      preferredPools: ['backup_pool_1', 'backup_pool_2']
    }
  });

  // プール設定例
  const pools: PoolConfig[] = [
    {
      id: 'pool_xmr_1',
      name: 'MoneroOcean',
      url: 'gulf.moneroocean.stream',
      port: 10032,
      algorithm: 'randomx',
      coin: 'XMR',
      username: 'YOUR_WALLET_ADDRESS',
      password: 'x',
      worker: 'otedama',
      protocol: 'stratum',
      fee: 0,
      minPayout: 0.1,
      payoutMethod: 'PPLNS',
      priority: 9,
      backup: false,
      enabled: true,
      region: 'asia',
      ssl: false,
      keepAlive: 60
    },
    {
      id: 'pool_rvn_1',
      name: 'Ravenminer',
      url: 'stratum-ravencoin.flypool.org',
      port: 4444,
      algorithm: 'kawpow',
      coin: 'RVN',
      username: 'YOUR_WALLET_ADDRESS',
      password: 'x',
      worker: 'otedama',
      protocol: 'stratum',
      fee: 1,
      minPayout: 10,
      payoutMethod: 'PPLNS',
      priority: 8,
      backup: false,
      enabled: true,
      region: 'europe',
      ssl: false,
      keepAlive: 60
    }
  ];

  // プール追加
  for (const pool of pools) {
    multiPool.addPool(pool);
  }

  // イベントリスナー設定
  multiPool.on('poolSwitched', (data) => {
    console.log(`🔄 プール自動切り替え: ${data.to}`);
  });

  multiPool.on('shareAccepted', (data) => {
    console.log(`💎 シェア受諾: ${data.poolId} (レイテンシ: ${data.latency}ms)`);
  });

  multiPool.on('failoverActivated', (poolId) => {
    console.log(`🆘 フェイルオーバー実行: ${poolId}`);
  });

  // マルチプール開始
  await multiPool.start();
  
  console.log('🚀 マルチプールマイニング開始完了');
  return multiPool;
}

export default MultiPoolManager;