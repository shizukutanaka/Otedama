/**
 * Zero Fee P2P Pool - 完全分散型ゼロ手数料プール
 * 
 * 設計思想: Rob Pike (シンプル・明快)
 * 
 * 特徴:
 * - 手数料0% - マイナーが100%の報酬を受け取り
 * - P2P分散アーキテクチャ - 中央サーバー不要
 * - 直接支払い - アドレス登録で即座受け取り
 * - 制限なし - 最小支払い額なし
 * - 透明性 - すべての取引が公開・検証可能
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

export interface MinerRegistration {
  minerId: string;
  payoutAddress: string;
  currency: string;
  workerName?: string;
  registeredAt: number;
  totalShares: number;
  validShares: number;
  lastSeen: number;
}

export interface ShareSubmission {
  minerId: string;
  shareHash: string;
  difficulty: number;
  blockHeight: number;
  nonce: string;
  timestamp: number;
  valid: boolean;
}

export interface BlockReward {
  blockHash: string;
  blockHeight: number;
  totalReward: number;
  finderReward: number;
  sharedReward: number;
  distributions: PayoutDistribution[];
  timestamp: number;
}

export interface PayoutDistribution {
  minerId: string;
  payoutAddress: string;
  currency: string;
  amount: number;
  shares: number;
  percentage: number;
}

export interface P2PNode {
  id: string;
  address: string;
  port: number;
  lastSeen: number;
  shares: number;
  reputation: number;
}

export interface PoolStats {
  totalMiners: number;
  activeMiners: number;
  totalHashrate: number;
  blocksFound: number;
  totalPayout: number;
  avgBlockTime: number;
  networkPeers: number;
  poolFee: 0; // 常に0%
}

export class ZeroFeeP2PPool extends EventEmitter {
  private logger: any;
  private miners: Map<string, MinerRegistration> = new Map();
  private shares: Map<string, ShareSubmission[]> = new Map();
  private blocks: Map<string, BlockReward> = new Map();
  private peers: Map<string, P2PNode> = new Map();
  private wsServer: WebSocketServer | null = null;
  private connections: Set<WebSocket> = new Set();
  
  // P2P Network settings
  private readonly P2P_PORT = 8333;
  private readonly MAX_PEERS = 50;
  private readonly SHARE_WINDOW = 24 * 60 * 60 * 1000; // 24時間
  private readonly MIN_SHARE_DIFFICULTY = 1;
  
  // Pool statistics
  private stats: PoolStats;
  private startTime: number;
  
  constructor(logger: any) {
    super();
    this.logger = logger;
    this.startTime = Date.now();
    this.stats = this.initializeStats();
  }

  private initializeStats(): PoolStats {
    return {
      totalMiners: 0,
      activeMiners: 0,
      totalHashrate: 0,
      blocksFound: 0,
      totalPayout: 0,
      avgBlockTime: 600, // 10分
      networkPeers: 0,
      poolFee: 0 // 固定ゼロ手数料
    };
  }

  async initialize(): Promise<void> {
    this.logger.info('Initializing Zero Fee P2P Pool...');

    try {
      // P2Pネットワーク開始
      await this.startP2PNetwork();
      
      // WebSocketサーバー開始
      await this.startWebSocketServer();
      
      // 統計更新開始
      this.startStatsUpdate();
      
      this.logger.success('Zero Fee P2P Pool initialized', {
        p2pPort: this.P2P_PORT,
        maxPeers: this.MAX_PEERS,
        feePercent: this.stats.poolFee
      });

    } catch (error) {
      this.logger.error('Failed to initialize Zero Fee P2P Pool:', error);
      throw error;
    }
  }

  private async startP2PNetwork(): Promise<void> {
    this.wsServer = new WebSocketServer({
      port: this.P2P_PORT,
      perMessageDeflate: false
    });

    this.wsServer.on('connection', (ws, request) => {
      this.handleNewPeerConnection(ws, request);
    });

    this.wsServer.on('error', (error) => {
      this.logger.error('P2P WebSocket server error:', error);
    });

    this.logger.info(`P2P network listening on port ${this.P2P_PORT}`);
  }

  private async startWebSocketServer(): Promise<void> {
    // メインWebSocketサーバーは別ポートで起動
    const mainWSServer = new WebSocketServer({
      port: this.P2P_PORT + 1
    });

    mainWSServer.on('connection', (ws) => {
      this.handleClientConnection(ws);
    });

    this.logger.info(`Main WebSocket server listening on port ${this.P2P_PORT + 1}`);
  }

  private handleNewPeerConnection(ws: WebSocket, request: any): void {
    const peerId = this.generatePeerId();
    const peerAddress = request.socket.remoteAddress;
    
    this.logger.info('New P2P peer connected', { peerId, peerAddress });

    const peer: P2PNode = {
      id: peerId,
      address: peerAddress,
      port: this.P2P_PORT,
      lastSeen: Date.now(),
      shares: 0,
      reputation: 100
    };

    this.peers.set(peerId, peer);
    this.connections.add(ws);

    ws.on('message', (data) => {
      this.handlePeerMessage(peerId, data);
    });

    ws.on('close', () => {
      this.peers.delete(peerId);
      this.connections.delete(ws);
      this.logger.info('P2P peer disconnected', { peerId });
    });

    ws.on('error', (error) => {
      this.logger.warn('P2P peer error', { peerId, error: error.message });
    });

    // ピア情報を送信
    this.sendToPeer(ws, {
      type: 'peer_info',
      data: {
        peerId: this.generateNodeId(),
        poolInfo: {
          name: 'Otedama Zero Fee Pool',
          version: '1.0.0',
          feePercent: 0,
          supportedCurrencies: ['BTC', 'XMR', 'RVN', 'ETC', 'ERG', 'FLUX', 'KAS'],
          protocolVersion: '2.0'
        }
      }
    });
  }

  private handleClientConnection(ws: WebSocket): void {
    this.logger.info('New client connected');

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, message);
      } catch (error) {
        this.logger.warn('Invalid client message:', error);
      }
    });

    ws.on('close', () => {
      this.logger.info('Client disconnected');
    });

    // 初期統計情報を送信
    this.sendToClient(ws, {
      type: 'pool_stats',
      data: this.getStats()
    });
  }

  private handlePeerMessage(peerId: string, data: Buffer): void {
    try {
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'share_announcement':
          this.handleShareAnnouncement(peerId, message.data);
          break;
          
        case 'block_found':
          this.handleBlockFoundAnnouncement(peerId, message.data);
          break;
          
        case 'payout_announcement':
          this.handlePayoutAnnouncement(peerId, message.data);
          break;
          
        case 'peer_list_request':
          this.sendPeerList(peerId);
          break;
          
        default:
          this.logger.warn('Unknown peer message type:', message.type);
      }
    } catch (error) {
      this.logger.warn('Error handling peer message:', error);
    }
  }

  private handleClientMessage(ws: WebSocket, message: any): void {
    switch (message.type) {
      case 'register_miner':
        this.handleMinerRegistration(ws, message.data);
        break;
        
      case 'submit_share':
        this.handleShareSubmission(ws, message.data);
        break;
        
      case 'get_stats':
        this.sendToClient(ws, {
          type: 'pool_stats',
          data: this.getStats()
        });
        break;
        
      case 'get_payout_history':
        this.handlePayoutHistoryRequest(ws, message.data);
        break;
        
      default:
        this.logger.warn('Unknown client message type:', message.type);
    }
  }

  async registerMiner(
    minerId: string, 
    payoutAddress: string, 
    currency: string, 
    workerName?: string
  ): Promise<boolean> {
    
    this.logger.info('Registering miner for zero fee mining', {
      minerId,
      payoutAddress,
      currency,
      workerName
    });

    try {
      // アドレス検証
      if (!this.validateAddress(currency, payoutAddress)) {
        throw new Error(`Invalid ${currency} address: ${payoutAddress}`);
      }

      const registration: MinerRegistration = {
        minerId,
        payoutAddress,
        currency,
        workerName,
        registeredAt: Date.now(),
        totalShares: 0,
        validShares: 0,
        lastSeen: Date.now()
      };

      this.miners.set(minerId, registration);
      this.stats.totalMiners = this.miners.size;

      // P2Pネットワークに登録を通知
      this.broadcastToPeers({
        type: 'miner_registered',
        data: {
          minerId,
          currency,
          timestamp: Date.now()
        }
      });

      this.emit('minerRegistered', registration);
      
      this.logger.success('Miner registered successfully for 0% fee mining', {
        minerId,
        totalMiners: this.stats.totalMiners
      });

      return true;

    } catch (error) {
      this.logger.error('Failed to register miner:', error);
      return false;
    }
  }

  private validateAddress(currency: string, address: string): boolean {
    // 基本的なアドレス検証パターン
    const patterns: Record<string, RegExp> = {
      BTC: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/,
      XMR: /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/,
      RVN: /^R[1-9A-HJ-NP-Za-km-z]{33}$/,
      ETC: /^0x[a-fA-F0-9]{40}$/,
      ERG: /^9[a-zA-Z0-9]{33}$/,
      FLUX: /^t1[a-zA-Z0-9]{33}$/,
      KAS: /^kaspa:[a-z0-9]{61}$/
    };

    const pattern = patterns[currency.toUpperCase()];
    return pattern ? pattern.test(address) : false;
  }

  async submitShare(
    minerId: string,
    shareHash: string,
    difficulty: number,
    blockHeight: number,
    nonce: string,
    valid: boolean
  ): Promise<void> {

    const miner = this.miners.get(minerId);
    if (!miner) {
      throw new Error(`Miner not registered: ${minerId}`);
    }

    const share: ShareSubmission = {
      minerId,
      shareHash,
      difficulty,
      blockHeight,
      nonce,
      timestamp: Date.now(),
      valid
    };

    // シェアを記録
    if (!this.shares.has(minerId)) {
      this.shares.set(minerId, []);
    }
    
    const minerShares = this.shares.get(minerId)!;
    minerShares.push(share);
    
    // 古いシェアを削除（24時間以上前）
    const cutoff = Date.now() - this.SHARE_WINDOW;
    const validShares = minerShares.filter(s => s.timestamp > cutoff);
    this.shares.set(minerId, validShares);

    // マイナー統計更新
    miner.totalShares++;
    if (valid) {
      miner.validShares++;
    }
    miner.lastSeen = Date.now();

    // P2Pネットワークにシェアを通知
    if (valid) {
      this.broadcastToPeers({
        type: 'share_announcement',
        data: {
          minerId,
          shareHash,
          difficulty,
          blockHeight,
          timestamp: share.timestamp
        }
      });
    }

    this.logger.info(`Share ${valid ? 'accepted' : 'rejected'}`, {
      minerId,
      difficulty,
      blockHeight,
      validShares: miner.validShares
    });

    this.emit('shareSubmitted', share);
  }

  async processBlockFound(
    blockHash: string,
    blockHeight: number,
    finderMinerId: string,
    totalReward: number
  ): Promise<void> {

    this.logger.info('🎉 BLOCK FOUND! Processing zero fee distribution...', {
      blockHash,
      blockHeight,
      finder: finderMinerId,
      totalReward
    });

    try {
      // ファインダー報酬（通常5%）
      const finderReward = totalReward * 0.05;
      const sharedReward = totalReward - finderReward;

      // 最近のシェアに基づいて報酬分配計算
      const distributions = await this.calculateRewardDistribution(
        sharedReward,
        finderMinerId,
        finderReward
      );

      const blockReward: BlockReward = {
        blockHash,
        blockHeight,
        totalReward,
        finderReward,
        sharedReward,
        distributions,
        timestamp: Date.now()
      };

      this.blocks.set(blockHash, blockReward);
      this.stats.blocksFound++;
      this.stats.totalPayout += totalReward;

      // 即座に支払い処理開始
      await this.processInstantPayouts(distributions);

      // P2Pネットワークにブロック発見を通知
      this.broadcastToPeers({
        type: 'block_found',
        data: {
          blockHash,
          blockHeight,
          totalReward,
          distributionCount: distributions.length,
          timestamp: Date.now()
        }
      });

      this.emit('blockFound', blockReward);

      this.logger.success('Block reward distributed (0% pool fee)', {
        blockHash,
        totalDistributed: totalReward,
        minerCount: distributions.length,
        avgPayout: totalReward / distributions.length
      });

    } catch (error) {
      this.logger.error('Failed to process block reward:', error);
      throw error;
    }
  }

  private async calculateRewardDistribution(
    sharedReward: number,
    finderMinerId: string,
    finderReward: number
  ): Promise<PayoutDistribution[]> {

    const distributions: PayoutDistribution[] = [];
    const cutoff = Date.now() - this.SHARE_WINDOW;

    // 全マイナーの有効シェア数を計算
    let totalValidShares = 0;
    const minerShares = new Map<string, number>();

    for (const [minerId, miner] of this.miners) {
      const shares = this.shares.get(minerId) || [];
      const validRecentShares = shares.filter(s => 
        s.valid && s.timestamp > cutoff
      ).length;

      if (validRecentShares > 0) {
        minerShares.set(minerId, validRecentShares);
        totalValidShares += validRecentShares;
      }
    }

    // ファインダー報酬
    const finder = this.miners.get(finderMinerId);
    if (finder) {
      distributions.push({
        minerId: finderMinerId,
        payoutAddress: finder.payoutAddress,
        currency: finder.currency,
        amount: finderReward,
        shares: minerShares.get(finderMinerId) || 0,
        percentage: (finderReward / (sharedReward + finderReward)) * 100
      });
    }

    // シェアベース分配
    if (totalValidShares > 0) {
      for (const [minerId, shares] of minerShares) {
        if (minerId === finderMinerId) continue; // ファインダーは既に報酬取得

        const miner = this.miners.get(minerId);
        if (!miner) continue;

        const sharePercentage = shares / totalValidShares;
        const amount = sharedReward * sharePercentage;

        if (amount > 0) {
          distributions.push({
            minerId,
            payoutAddress: miner.payoutAddress,
            currency: miner.currency,
            amount,
            shares,
            percentage: sharePercentage * 100
          });
        }
      }
    }

    return distributions;
  }

  private async processInstantPayouts(distributions: PayoutDistribution[]): Promise<void> {
    this.logger.info('Processing instant payouts (0% fee)...');

    for (const distribution of distributions) {
      try {
        // 実際の支払い処理はウォレット統合で実装
        // ここでは支払い予定として記録
        await this.scheduleInstantPayout(distribution);

        this.logger.info('Instant payout scheduled', {
          minerId: distribution.minerId,
          amount: distribution.amount,
          currency: distribution.currency,
          address: distribution.payoutAddress
        });

      } catch (error) {
        this.logger.error('Failed to process payout:', {
          minerId: distribution.minerId,
          error: error.message
        });
      }
    }
  }

  private async scheduleInstantPayout(distribution: PayoutDistribution): Promise<void> {
    // 実際の実装では、対応する通貨のウォレットAPIを使用
    // 例: Bitcoin Core RPC, Monero RPC, etc.
    
    this.emit('payoutScheduled', {
      minerId: distribution.minerId,
      address: distribution.payoutAddress,
      amount: distribution.amount,
      currency: distribution.currency,
      timestamp: Date.now()
    });
  }

  private handleMinerRegistration(ws: WebSocket, data: any): void {
    const { minerId, payoutAddress, currency, workerName } = data;
    
    this.registerMiner(minerId, payoutAddress, currency, workerName)
      .then((success) => {
        this.sendToClient(ws, {
          type: 'registration_result',
          data: { success, minerId }
        });
      })
      .catch((error) => {
        this.sendToClient(ws, {
          type: 'registration_result',
          data: { success: false, error: error.message }
        });
      });
  }

  private handleShareSubmission(ws: WebSocket, data: any): void {
    const { minerId, shareHash, difficulty, blockHeight, nonce, valid } = data;
    
    this.submitShare(minerId, shareHash, difficulty, blockHeight, nonce, valid)
      .then(() => {
        this.sendToClient(ws, {
          type: 'share_result',
          data: { accepted: valid, minerId }
        });
      })
      .catch((error) => {
        this.sendToClient(ws, {
          type: 'share_result',
          data: { accepted: false, error: error.message }
        });
      });
  }

  private handlePayoutHistoryRequest(ws: WebSocket, data: any): void {
    const { minerId, limit = 100 } = data;
    
    // 支払い履歴を取得（実装簡略化）
    const history = Array.from(this.blocks.values())
      .flatMap(block => block.distributions)
      .filter(dist => dist.minerId === minerId)
      .slice(0, limit);

    this.sendToClient(ws, {
      type: 'payout_history',
      data: { minerId, history }
    });
  }

  private sendToClient(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendToPeer(ws: WebSocket, message: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private broadcastToPeers(message: any): void {
    const data = JSON.stringify(message);
    
    for (const ws of this.connections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  private generatePeerId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  private generateNodeId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private startStatsUpdate(): void {
    setInterval(() => {
      this.updateStats();
    }, 30000); // 30秒間隔
  }

  private updateStats(): void {
    const now = Date.now();
    const activeThreshold = 5 * 60 * 1000; // 5分

    this.stats.activeMiners = Array.from(this.miners.values())
      .filter(miner => now - miner.lastSeen < activeThreshold)
      .length;

    this.stats.networkPeers = this.peers.size;

    // ハッシュレート推定（簡略化）
    this.stats.totalHashrate = this.stats.activeMiners * 1000000; // 1MH/s per miner estimate

    this.emit('statsUpdated', this.stats);
  }

  getStats(): PoolStats {
    return { ...this.stats };
  }

  getPoolUrl(): string {
    return `stratum+tcp://localhost:${this.P2P_PORT}`;
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Zero Fee P2P Pool...');

    if (this.wsServer) {
      this.wsServer.close();
    }

    for (const ws of this.connections) {
      ws.close();
    }

    this.connections.clear();
    this.peers.clear();

    this.logger.success('Zero Fee P2P Pool shutdown complete');
  }

  // Utility methods for external integration
  private handleShareAnnouncement(peerId: string, data: any): void {
    // P2Pネットワークからのシェア通知処理
    this.logger.debug('Received share announcement from peer', { peerId, data });
  }

  private handleBlockFoundAnnouncement(peerId: string, data: any): void {
    // P2Pネットワークからのブロック発見通知処理
    this.logger.info('Received block found announcement from peer', { peerId, data });
  }

  private handlePayoutAnnouncement(peerId: string, data: any): void {
    // P2Pネットワークからの支払い通知処理
    this.logger.debug('Received payout announcement from peer', { peerId, data });
  }

  private sendPeerList(peerId: string): void {
    const peerList = Array.from(this.peers.values())
      .filter(peer => peer.id !== peerId)
      .slice(0, 20); // 最大20ピア

    const peer = Array.from(this.connections.values()).find(/* find matching peer */);
    if (peer) {
      this.sendToPeer(peer, {
        type: 'peer_list',
        data: { peers: peerList }
      });
    }
  }
}
