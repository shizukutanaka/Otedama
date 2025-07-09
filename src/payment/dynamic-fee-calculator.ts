/**
 * 動的手数料計算システム
 * ネットワーク状況に応じて最適な手数料を自動計算
 * 
 * 設計思想：
 * - Carmack: リアルタイムで効率的な計算
 * - Martin: 柔軟な手数料戦略の実装
 * - Pike: シンプルで予測可能な手数料モデル
 */

import { EventEmitter } from 'events';
import { BlockchainClient } from '../blockchain/blockchain-client';

// === 型定義 ===
export interface FeeMarket {
  fastestFee: number;      // 1ブロック確認
  halfHourFee: number;     // 3ブロック確認
  hourFee: number;         // 6ブロック確認
  economyFee: number;      // 12ブロック以上
  minimumFee: number;      // ネットワーク最小手数料
}

export interface DynamicFeeConfig {
  updateInterval: number;   // 手数料更新間隔（秒）
  priorityLevel: 'fastest' | 'fast' | 'normal' | 'economy';
  minFeeRate: number;      // 最小手数料率（sat/byte）
  maxFeeRate: number;      // 最大手数料率（sat/byte）
  bufferPercent: number;   // 安全マージン（％）
  
  // 動的調整パラメータ
  enableDynamicAdjustment: boolean;
  targetConfirmationBlocks: number;
  adjustmentFactor: number; // 0.1 = 10%の調整
  
  // バッチ支払い最適化
  batchSizeOptimization: boolean;
  optimalBatchSize: number;
}

export interface FeeEstimate {
  feeRate: number;         // sat/byte
  totalFee: number;        // 総手数料
  priority: string;        // 優先度
  estimatedBlocks: number; // 予想確認ブロック数
  confidence: number;      // 信頼度（0-1）
}

export interface TransactionSize {
  inputs: number;
  outputs: number;
  estimatedBytes: number;
  isSegwit: boolean;
}

// === 動的手数料計算機 ===
export class DynamicFeeCalculator extends EventEmitter {
  private config: DynamicFeeConfig;
  private blockchainClient: BlockchainClient;
  private currentFeeMarket: FeeMarket;
  private updateTimer?: NodeJS.Timeout;
  private historicalFees: FeeMarket[] = [];
  private maxHistorySize = 100;
  
  constructor(config: DynamicFeeConfig, blockchainClient: BlockchainClient) {
    super();
    this.config = config;
    this.blockchainClient = blockchainClient;
    
    // デフォルトの手数料市場
    this.currentFeeMarket = {
      fastestFee: 50,
      halfHourFee: 30,
      hourFee: 20,
      economyFee: 10,
      minimumFee: 1
    };
  }
  
  // 手数料計算の開始
  async start(): Promise<void> {
    // 初回の手数料取得
    await this.updateFeeMarket();
    
    // 定期更新の開始
    this.updateTimer = setInterval(
      () => this.updateFeeMarket(),
      this.config.updateInterval * 1000
    );
    
    this.emit('started');
  }
  
  // 手数料計算の停止
  stop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = undefined;
    }
    
    this.emit('stopped');
  }
  
  // 手数料市場の更新
  private async updateFeeMarket(): Promise<void> {
    try {
      // ブロックチェーンから手数料推定を取得
      const estimates = await this.blockchainClient.estimateFees();
      
      if (estimates) {
        // 履歴に追加
        this.historicalFees.push(this.currentFeeMarket);
        if (this.historicalFees.length > this.maxHistorySize) {
          this.historicalFees.shift();
        }
        
        // 新しい手数料市場を設定
        this.currentFeeMarket = {
          fastestFee: Math.min(estimates.fastest || 50, this.config.maxFeeRate),
          halfHourFee: Math.min(estimates.halfHour || 30, this.config.maxFeeRate),
          hourFee: Math.min(estimates.hour || 20, this.config.maxFeeRate),
          economyFee: Math.max(estimates.economy || 10, this.config.minFeeRate),
          minimumFee: Math.max(estimates.minimum || 1, this.config.minFeeRate)
        };
        
        // 動的調整が有効な場合
        if (this.config.enableDynamicAdjustment) {
          this.applyDynamicAdjustment();
        }
        
        this.emit('feeMarketUpdated', this.currentFeeMarket);
      }
    } catch (error) {
      this.emit('error', { error, context: 'updateFeeMarket' });
    }
  }
  
  // 動的調整の適用
  private applyDynamicAdjustment(): void {
    // メモリプールの状況を考慮
    const mempoolSize = this.blockchainClient.getMempoolSize?.() || 0;
    const avgBlockSize = 1000000; // 1MB
    const blocksToConfirm = mempoolSize / avgBlockSize;
    
    // 目標確認時間との差に基づいて調整
    const targetBlocks = this.config.targetConfirmationBlocks;
    const difference = blocksToConfirm - targetBlocks;
    const adjustmentPercent = difference * this.config.adjustmentFactor;
    
    // 各手数料レベルを調整
    const adjust = (fee: number): number => {
      const adjusted = fee * (1 + adjustmentPercent / 100);
      return Math.max(this.config.minFeeRate, Math.min(this.config.maxFeeRate, adjusted));
    };
    
    this.currentFeeMarket = {
      fastestFee: adjust(this.currentFeeMarket.fastestFee),
      halfHourFee: adjust(this.currentFeeMarket.halfHourFee),
      hourFee: adjust(this.currentFeeMarket.hourFee),
      economyFee: adjust(this.currentFeeMarket.economyFee),
      minimumFee: this.currentFeeMarket.minimumFee
    };
  }
  
  // トランザクション手数料の推定
  estimateTransactionFee(txSize: TransactionSize): FeeEstimate {
    // 優先度に基づく手数料率を取得
    const feeRate = this.getFeeRateByPriority(this.config.priorityLevel);
    
    // トランザクションサイズの計算
    const estimatedBytes = txSize.estimatedBytes || this.calculateTransactionSize(txSize);
    
    // 手数料の計算
    const baseFee = feeRate * estimatedBytes;
    const bufferFee = baseFee * (this.config.bufferPercent / 100);
    const totalFee = Math.ceil(baseFee + bufferFee);
    
    return {
      feeRate,
      totalFee,
      priority: this.config.priorityLevel,
      estimatedBlocks: this.getEstimatedBlocks(this.config.priorityLevel),
      confidence: this.calculateConfidence()
    };
  }
  
  // バッチ支払いの最適化
  optimizeBatchPayment(recipients: number, averageAmount: number): {
    optimalBatchSize: number;
    estimatedFeePerRecipient: number;
    totalFee: number;
  } {
    if (!this.config.batchSizeOptimization) {
      return {
        optimalBatchSize: recipients,
        estimatedFeePerRecipient: 0,
        totalFee: 0
      };
    }
    
    // バッチサイズごとの手数料を計算
    const batchSizes = [1, 10, 25, 50, 100, 200];
    const feeEstimates = batchSizes.map(size => {
      const txSize: TransactionSize = {
        inputs: Math.ceil(size * averageAmount / 0.01), // 推定入力数
        outputs: size,
        estimatedBytes: 0,
        isSegwit: true
      };
      
      const estimate = this.estimateTransactionFee(txSize);
      return {
        batchSize: size,
        feePerRecipient: estimate.totalFee / size,
        totalFee: estimate.totalFee
      };
    });
    
    // 最適なバッチサイズを選択
    const optimal = feeEstimates.reduce((best, current) => {
      if (current.batchSize <= recipients && 
          current.feePerRecipient < best.feePerRecipient) {
        return current;
      }
      return best;
    });
    
    return {
      optimalBatchSize: Math.min(optimal.batchSize, this.config.optimalBatchSize),
      estimatedFeePerRecipient: optimal.feePerRecipient,
      totalFee: optimal.totalFee
    };
  }
  
  // トランザクションサイズの計算
  private calculateTransactionSize(txSize: TransactionSize): number {
    // 基本的なトランザクションサイズの推定
    const baseSize = 10; // バージョン + ロックタイム
    const inputSize = txSize.isSegwit ? 68 : 148; // P2WPKH vs P2PKH
    const outputSize = txSize.isSegwit ? 31 : 34;
    
    return baseSize + (txSize.inputs * inputSize) + (txSize.outputs * outputSize);
  }
  
  // 優先度に基づく手数料率の取得
  private getFeeRateByPriority(priority: string): number {
    switch (priority) {
      case 'fastest':
        return this.currentFeeMarket.fastestFee;
      case 'fast':
        return this.currentFeeMarket.halfHourFee;
      case 'normal':
        return this.currentFeeMarket.hourFee;
      case 'economy':
        return this.currentFeeMarket.economyFee;
      default:
        return this.currentFeeMarket.hourFee;
    }
  }
  
  // 予想確認ブロック数の取得
  private getEstimatedBlocks(priority: string): number {
    switch (priority) {
      case 'fastest':
        return 1;
      case 'fast':
        return 3;
      case 'normal':
        return 6;
      case 'economy':
        return 12;
      default:
        return 6;
    }
  }
  
  // 信頼度の計算
  private calculateConfidence(): number {
    // 履歴データが少ない場合は信頼度を下げる
    if (this.historicalFees.length < 10) {
      return 0.5;
    }
    
    // 手数料の変動率を計算
    const recentFees = this.historicalFees.slice(-10);
    const avgFee = recentFees.reduce((sum, fee) => sum + fee.hourFee, 0) / recentFees.length;
    const variance = recentFees.reduce((sum, fee) => sum + Math.pow(fee.hourFee - avgFee, 2), 0) / recentFees.length;
    const stdDev = Math.sqrt(variance);
    
    // 変動が小さいほど信頼度が高い
    const volatility = stdDev / avgFee;
    return Math.max(0.1, Math.min(1, 1 - volatility));
  }
  
  // 現在の手数料市場を取得
  getCurrentFeeMarket(): FeeMarket {
    return { ...this.currentFeeMarket };
  }
  
  // 手数料履歴の取得
  getFeeHistory(limit = 24): FeeMarket[] {
    return this.historicalFees.slice(-limit);
  }
  
  // 手数料予測
  predictFees(hoursAhead: number): FeeMarket {
    if (this.historicalFees.length < 2) {
      return this.currentFeeMarket;
    }
    
    // 簡単な線形予測
    const recent = this.historicalFees.slice(-24);
    const trend = this.calculateTrend(recent);
    
    const predictedFee = (current: number, trendValue: number): number => {
      const predicted = current + (trendValue * hoursAhead);
      return Math.max(this.config.minFeeRate, Math.min(this.config.maxFeeRate, predicted));
    };
    
    return {
      fastestFee: predictedFee(this.currentFeeMarket.fastestFee, trend.fastest),
      halfHourFee: predictedFee(this.currentFeeMarket.halfHourFee, trend.halfHour),
      hourFee: predictedFee(this.currentFeeMarket.hourFee, trend.hour),
      economyFee: predictedFee(this.currentFeeMarket.economyFee, trend.economy),
      minimumFee: this.currentFeeMarket.minimumFee
    };
  }
  
  // トレンドの計算
  private calculateTrend(fees: FeeMarket[]): any {
    if (fees.length < 2) {
      return { fastest: 0, halfHour: 0, hour: 0, economy: 0 };
    }
    
    const calculateLinearTrend = (values: number[]): number => {
      const n = values.length;
      const sumX = (n * (n - 1)) / 2;
      const sumY = values.reduce((sum, val) => sum + val, 0);
      const sumXY = values.reduce((sum, val, i) => sum + (i * val), 0);
      const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
      
      return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    };
    
    return {
      fastest: calculateLinearTrend(fees.map(f => f.fastestFee)),
      halfHour: calculateLinearTrend(fees.map(f => f.halfHourFee)),
      hour: calculateLinearTrend(fees.map(f => f.hourFee)),
      economy: calculateLinearTrend(fees.map(f => f.economyFee))
    };
  }
  
  // 統計情報の取得
  getStats(): any {
    const avgFee = this.historicalFees.length > 0
      ? this.historicalFees.reduce((sum, fee) => sum + fee.hourFee, 0) / this.historicalFees.length
      : this.currentFeeMarket.hourFee;
    
    return {
      current: this.currentFeeMarket,
      average24h: avgFee,
      confidence: this.calculateConfidence(),
      historySize: this.historicalFees.length,
      lastUpdate: new Date(),
      config: {
        priority: this.config.priorityLevel,
        minFee: this.config.minFeeRate,
        maxFee: this.config.maxFeeRate
      }
    };
  }
}

export default DynamicFeeCalculator;