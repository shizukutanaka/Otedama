/**
 * 支払いシステム基盤
 * PPLNS (Pay Per Last N Shares) / PPS (Pay Per Share) / FPPS (Full Pay Per Share) 実装
 * 
 * 設計思想：
 * - Carmack: 効率的でシンプルな計算
 * - Martin: 支払い方式の抽象化と拡張性
 * - Pike: 明確で理解しやすい支払いロジック
 */

import { EventEmitter } from 'events';
import { PoolDatabase, ShareRecord, MinerRecord, PaymentRecord } from '../database/pool-database';
import { BlockchainClient } from '../blockchain/blockchain-client';

// === 型定義 ===
export interface PaymentConfig {
  // 基本設定
  paymentScheme: 'PPLNS' | 'PPS' | 'FPPS' | 'PROP';
  poolFeePercent: number;  // プール手数料（％）
  minimumPayment: number;  // 最小支払い額
  paymentInterval: number; // 支払い間隔（秒）
  
  // PPLNS設定
  pplnsWindow?: number;    // Nシェアのウィンドウサイズ
  pplnsBlockCount?: number; // ブロック数ベースのウィンドウ
  
  // PPS設定
  ppsDifficulty?: number;  // PPS計算用の固定難易度
  ppsRate?: number;        // PPSレート（BTC/difficulty）
  
  // トランザクション設定
  maxTxFee: number;        // 最大トランザクション手数料
  txFeeReserve: number;    // 手数料予備費
  batchPayments: boolean;  // バッチ支払いの有効化
  maxRecipientsPerTx: number; // 1トランザクションあたりの最大受取人数
}

export interface MinerBalance {
  minerId: string;
  address: string;
  balance: number;
  pending: number;
  paid: number;
  lastPayment?: number;
}

export interface PaymentRound {
  roundId: string;
  scheme: string;
  blockHeight: number;
  blockReward: number;
  poolFee: number;
  totalShares: number;
  totalPaid: number;
  minerPayments: Map<string, number>;
  timestamp: number;
  txHash?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

export interface ShareWindow {
  shares: ShareRecord[];
  totalDifficulty: number;
  startTime: number;
  endTime: number;
  blockHeight: number;
}

// === 基底支払いスキーム ===
export abstract class PaymentScheme {
  protected config: PaymentConfig;
  protected database: PoolDatabase;
  
  constructor(config: PaymentConfig, database: PoolDatabase) {
    this.config = config;
    this.database = database;
  }
  
  abstract calculateRewards(
    blockReward: number,
    blockHeight: number,
    shares: ShareRecord[]
  ): Map<string, number>;
  
  abstract getShareWindow(blockHeight: number): Promise<ShareWindow>;
  
  // 共通ユーティリティ
  protected applyPoolFee(amount: number): { minerAmount: number; poolFee: number } {
    const poolFee = amount * (this.config.poolFeePercent / 100);
    const minerAmount = amount - poolFee;
    return { minerAmount, poolFee };
  }
  
  protected groupSharesByMiner(shares: ShareRecord[]): Map<string, ShareRecord[]> {
    const grouped = new Map<string, ShareRecord[]>();
    
    for (const share of shares) {
      const minerShares = grouped.get(share.minerId) || [];
      minerShares.push(share);
      grouped.set(share.minerId, minerShares);
    }
    
    return grouped;
  }
  
  protected calculateTotalDifficulty(shares: ShareRecord[]): number {
    return shares.reduce((sum, share) => sum + share.difficulty, 0);
  }
}

// === PPLNS (Pay Per Last N Shares) ===
export class PPLNSScheme extends PaymentScheme {
  async getShareWindow(blockHeight: number): Promise<ShareWindow> {
    const window = this.config.pplnsWindow || 100000;
    const shares = await this.database.getRecentShares(undefined, window);
    
    // 有効なシェアのみをフィルタ
    const validShares = shares.filter(share => share.valid && !share.rewarded);
    
    return {
      shares: validShares,
      totalDifficulty: this.calculateTotalDifficulty(validShares),
      startTime: validShares.length > 0 ? validShares[validShares.length - 1].timestamp : Date.now(),
      endTime: validShares.length > 0 ? validShares[0].timestamp : Date.now(),
      blockHeight
    };
  }
  
  calculateRewards(
    blockReward: number,
    blockHeight: number,
    shares: ShareRecord[]
  ): Map<string, number> {
    const rewards = new Map<string, number>();
    
    if (shares.length === 0) {
      return rewards;
    }
    
    // プール手数料を適用
    const { minerAmount: totalReward, poolFee } = this.applyPoolFee(blockReward);
    
    // 総難易度を計算
    const totalDifficulty = this.calculateTotalDifficulty(shares);
    
    // マイナーごとにシェアをグループ化
    const minerShares = this.groupSharesByMiner(shares);
    
    // 各マイナーの報酬を計算
    for (const [minerId, minerShareList] of minerShares) {
      const minerDifficulty = this.calculateTotalDifficulty(minerShareList);
      const minerShare = minerDifficulty / totalDifficulty;
      const minerReward = totalReward * minerShare;
      
      if (minerReward > 0) {
        rewards.set(minerId, minerReward);
      }
    }
    
    return rewards;
  }
}

// === PPS (Pay Per Share) ===
export class PPSScheme extends PaymentScheme {
  async getShareWindow(blockHeight: number): Promise<ShareWindow> {
    // PPSでは未払いのシェアすべてが対象
    const shares = await this.database.getUnpaidShares();
    
    return {
      shares,
      totalDifficulty: this.calculateTotalDifficulty(shares),
      startTime: shares.length > 0 ? shares[shares.length - 1].timestamp : Date.now(),
      endTime: shares.length > 0 ? shares[0].timestamp : Date.now(),
      blockHeight
    };
  }
  
  calculateRewards(
    blockReward: number,
    blockHeight: number,
    shares: ShareRecord[]
  ): Map<string, number> {
    const rewards = new Map<string, number>();
    
    // PPSレートを計算（またはconfigから取得）
    const expectedBlocksPerDay = (24 * 60 * 60) / 600; // Bitcoin: 10分/ブロック
    const networkDifficulty = this.config.ppsDifficulty || 1000000;
    const ppsRate = this.config.ppsRate || (blockReward / networkDifficulty);
    
    // プール手数料を考慮したレート
    const { minerAmount: adjustedRate } = this.applyPoolFee(ppsRate);
    
    // 各シェアに対して固定額を支払い
    for (const share of shares) {
      if (!share.valid) continue;
      
      const shareValue = adjustedRate * share.difficulty;
      const currentReward = rewards.get(share.minerId) || 0;
      rewards.set(share.minerId, currentReward + shareValue);
    }
    
    return rewards;
  }
}

// === FPPS (Full Pay Per Share) ===
export class FPPSScheme extends PPSScheme {
  calculateRewards(
    blockReward: number,
    blockHeight: number,
    shares: ShareRecord[]
  ): Map<string, number> {
    // 基本的なPPS報酬を計算
    const baseRewards = super.calculateRewards(blockReward, blockHeight, shares);
    
    // トランザクション手数料も含めて分配（簡略化）
    // 実際の実装では、ブロックのトランザクション手数料を取得する必要がある
    const txFeeBonus = blockReward * 0.1; // 仮に10%をトランザクション手数料とする
    
    // ボーナスを比率に応じて分配
    const totalBaseReward = Array.from(baseRewards.values()).reduce((sum, r) => sum + r, 0);
    
    for (const [minerId, baseReward] of baseRewards) {
      const bonusShare = (baseReward / totalBaseReward) * txFeeBonus;
      baseRewards.set(minerId, baseReward + bonusShare);
    }
    
    return baseRewards;
  }
}

// === PROP (Proportional) ===
export class PROPScheme extends PaymentScheme {
  async getShareWindow(blockHeight: number): Promise<ShareWindow> {
    // 現在のラウンドのシェアのみ
    const shares = await this.database.getSharesForRound(blockHeight);
    
    return {
      shares,
      totalDifficulty: this.calculateTotalDifficulty(shares),
      startTime: shares.length > 0 ? shares[shares.length - 1].timestamp : Date.now(),
      endTime: shares.length > 0 ? shares[0].timestamp : Date.now(),
      blockHeight
    };
  }
  
  calculateRewards(
    blockReward: number,
    blockHeight: number,
    shares: ShareRecord[]
  ): Map<string, number> {
    // PPLNSと同様の計算だが、現在のラウンドのシェアのみを使用
    return new PPLNSScheme(this.config, this.database).calculateRewards(
      blockReward,
      blockHeight,
      shares
    );
  }
}

// === 支払いマネージャー ===
export class PaymentManager extends EventEmitter {
  private scheme: PaymentScheme;
  private config: PaymentConfig;
  private database: PoolDatabase;
  private blockchainClient: BlockchainClient;
  private paymentTimer?: NodeJS.Timeout;
  private isProcessing: boolean = false;
  
  constructor(
    config: PaymentConfig,
    database: PoolDatabase,
    blockchainClient: BlockchainClient
  ) {
    super();
    this.config = config;
    this.database = database;
    this.blockchainClient = blockchainClient;
    
    // 支払いスキームの初期化
    switch (config.paymentScheme) {
      case 'PPLNS':
        this.scheme = new PPLNSScheme(config, database);
        break;
      case 'PPS':
        this.scheme = new PPSScheme(config, database);
        break;
      case 'FPPS':
        this.scheme = new FPPSScheme(config, database);
        break;
      case 'PROP':
        this.scheme = new PROPScheme(config, database);
        break;
      default:
        this.scheme = new PPLNSScheme(config, database);
    }
  }
  
  // 支払い処理の開始
  start(): void {
    // 定期的な支払い処理
    this.paymentTimer = setInterval(
      () => this.processPayments(),
      this.config.paymentInterval * 1000
    );
    
    this.emit('started');
  }
  
  // 支払い処理の停止
  stop(): void {
    if (this.paymentTimer) {
      clearInterval(this.paymentTimer);
      this.paymentTimer = undefined;
    }
    
    this.emit('stopped');
  }
  
  // ブロック発見時の処理
  async onBlockFound(
    blockHeight: number,
    blockHash: string,
    blockReward: number
  ): Promise<void> {
    try {
      this.emit('blockFound', { blockHeight, blockHash, blockReward });
      
      // シェアウィンドウを取得
      const shareWindow = await this.scheme.getShareWindow(blockHeight);
      
      // 報酬を計算
      const rewards = this.scheme.calculateRewards(
        blockReward,
        blockHeight,
        shareWindow.shares
      );
      
      // 支払いラウンドを作成
      const round: PaymentRound = {
        roundId: `${blockHeight}_${Date.now()}`,
        scheme: this.config.paymentScheme,
        blockHeight,
        blockReward,
        poolFee: blockReward * (this.config.poolFeePercent / 100),
        totalShares: shareWindow.shares.length,
        totalPaid: 0,
        minerPayments: rewards,
        timestamp: Date.now(),
        status: 'pending'
      };
      
      // ラウンドを保存
      await this.savePaymentRound(round);
      
      // マイナーの残高を更新
      for (const [minerId, amount] of rewards) {
        await this.updateMinerBalance(minerId, amount);
      }
      
      // シェアを報酬済みとしてマーク
      await this.markSharesAsRewarded(shareWindow.shares);
      
      this.emit('roundCreated', round);
      
      // 即座に支払い処理を実行（PPSの場合）
      if (this.config.paymentScheme === 'PPS' || this.config.paymentScheme === 'FPPS') {
        await this.processPayments();
      }
      
    } catch (error) {
      this.emit('error', { error, context: 'onBlockFound' });
    }
  }
  
  // 定期的な支払い処理
  private async processPayments(): Promise<void> {
    if (this.isProcessing) {
      return; // 既に処理中
    }
    
    this.isProcessing = true;
    
    try {
      // 支払い対象のマイナーを取得
      const pendingPayments = await this.getPendingPayments();
      
      if (pendingPayments.length === 0) {
        return;
      }
      
      this.emit('paymentProcessingStarted', { count: pendingPayments.length });
      
      if (this.config.batchPayments) {
        // バッチ支払い
        await this.processBatchPayments(pendingPayments);
      } else {
        // 個別支払い
        for (const payment of pendingPayments) {
          await this.processSinglePayment(payment);
        }
      }
      
      this.emit('paymentProcessingCompleted');
      
    } catch (error) {
      this.emit('error', { error, context: 'processPayments' });
    } finally {
      this.isProcessing = false;
    }
  }
  
  // 支払い対象の取得
  private async getPendingPayments(): Promise<MinerBalance[]> {
    const allMiners = await this.database.getAllMiners();
    const pendingPayments: MinerBalance[] = [];
    
    for (const miner of allMiners) {
      const balance = miner.balance || 0;
      
      if (balance >= this.config.minimumPayment) {
        pendingPayments.push({
          minerId: miner.minerId,
          address: miner.address,
          balance: balance,
          pending: 0,
          paid: miner.paidAmount || 0
        });
      }
    }
    
    return pendingPayments;
  }
  
  // バッチ支払い処理
  private async processBatchPayments(payments: MinerBalance[]): Promise<void> {
    // 支払いをバッチに分割
    const batches = this.createPaymentBatches(payments);
    
    for (const batch of batches) {
      try {
        // トランザクションを作成
        const recipients = batch.map(p => ({
          address: p.address,
          amount: p.balance
        }));
        
        // ブロックチェーンに送信
        const txHash = await this.blockchainClient.sendBatchPayment(recipients);
        
        // 支払い記録を保存
        for (const payment of batch) {
          await this.recordPayment(payment, txHash);
        }
        
        this.emit('batchPaymentSent', { txHash, count: batch.length });
        
      } catch (error) {
        this.emit('error', { error, context: 'processBatchPayments', batch });
      }
    }
  }
  
  // 個別支払い処理
  private async processSinglePayment(payment: MinerBalance): Promise<void> {
    try {
      // トランザクションを送信
      const txHash = await this.blockchainClient.sendPayment(
        payment.address,
        payment.balance
      );
      
      // 支払い記録を保存
      await this.recordPayment(payment, txHash);
      
      this.emit('paymentSent', { 
        minerId: payment.minerId,
        address: payment.address,
        amount: payment.balance,
        txHash 
      });
      
    } catch (error) {
      this.emit('error', { error, context: 'processSinglePayment', payment });
    }
  }
  
  // 支払いバッチの作成
  private createPaymentBatches(payments: MinerBalance[]): MinerBalance[][] {
    const batches: MinerBalance[][] = [];
    let currentBatch: MinerBalance[] = [];
    
    for (const payment of payments) {
      currentBatch.push(payment);
      
      if (currentBatch.length >= this.config.maxRecipientsPerTx) {
        batches.push(currentBatch);
        currentBatch = [];
      }
    }
    
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }
    
    return batches;
  }
  
  // マイナー残高の更新
  private async updateMinerBalance(minerId: string, amount: number): Promise<void> {
    const miner = await this.database.getMiner(minerId);
    if (!miner) return;
    
    miner.balance = (miner.balance || 0) + amount;
    await this.database.upsertMiner(miner);
  }
  
  // 支払い記録の保存
  private async recordPayment(payment: MinerBalance, txHash: string): Promise<void> {
    // 支払い記録を作成
    const paymentRecord: PaymentRecord = {
      paymentId: `payment_${Date.now()}_${payment.minerId}`,
      minerId: payment.minerId,
      address: payment.address,
      amount: payment.balance,
      txHash,
      timestamp: Date.now(),
      status: 'completed',
      scheme: this.config.paymentScheme
    };
    
    await this.database.addPayment(paymentRecord);
    
    // マイナーの残高をリセット
    const miner = await this.database.getMiner(payment.minerId);
    if (miner) {
      miner.balance = 0;
      miner.paidAmount = (miner.paidAmount || 0) + payment.balance;
      await this.database.upsertMiner(miner);
    }
  }
  
  // シェアを報酬済みとしてマーク
  private async markSharesAsRewarded(shares: ShareRecord[]): Promise<void> {
    for (const share of shares) {
      share.rewarded = true;
      await this.database.updateShare(share);
    }
  }
  
  // 支払いラウンドの保存
  private async savePaymentRound(round: PaymentRound): Promise<void> {
    // データベースに保存（実装はデータベース設計に依存）
    // ここでは簡略化
    this.emit('roundSaved', round);
  }
  
  // 統計情報の取得
  async getStats(): Promise<any> {
    const miners = await this.database.getAllMiners();
    const totalBalance = miners.reduce((sum, m) => sum + (m.balance || 0), 0);
    const totalPaid = miners.reduce((sum, m) => sum + (m.paidAmount || 0), 0);
    
    return {
      scheme: this.config.paymentScheme,
      poolFeePercent: this.config.poolFeePercent,
      minimumPayment: this.config.minimumPayment,
      paymentInterval: this.config.paymentInterval,
      totalMiners: miners.length,
      minersWithBalance: miners.filter(m => (m.balance || 0) > 0).length,
      totalBalance,
      totalPaid,
      pendingPayments: miners.filter(m => (m.balance || 0) >= this.config.minimumPayment).length
    };
  }
  
  // マイナーの支払い履歴取得
  async getMinerPaymentHistory(minerId: string, limit = 100): Promise<PaymentRecord[]> {
    return this.database.getMinerPayments(minerId, limit);
  }
  
  // 残高の確認
  async getMinerBalance(minerId: string): Promise<MinerBalance | null> {
    const miner = await this.database.getMiner(minerId);
    if (!miner) return null;
    
    return {
      minerId: miner.minerId,
      address: miner.address,
      balance: miner.balance || 0,
      pending: 0, // 計算が必要な場合は実装
      paid: miner.paidAmount || 0,
      lastPayment: undefined // 最後の支払い時刻を取得する場合は実装
    };
  }
}

// エクスポート
export default PaymentManager;