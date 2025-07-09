/**
 * 支払い履歴詳細記録システム
 * 完全な支払い履歴の追跡と分析機能
 * 
 * 設計思想：
 * - Carmack: 高速な履歴検索とクエリ
 * - Martin: 拡張可能な履歴データモデル
 * - Pike: シンプルで直感的な履歴API
 */

import { EventEmitter } from 'events';
import { PoolDatabase, PaymentRecord } from '../database/pool-database';

// === 型定義 ===
export interface DetailedPaymentRecord extends PaymentRecord {
  // 追加の詳細情報
  feeAmount: number;           // トランザクション手数料
  feeRate: number;            // 手数料率（sat/byte）
  confirmations: number;       // 確認数
  blockHeight?: number;        // 含まれたブロック高
  blockHash?: string;          // ブロックハッシュ
  
  // バッチ情報
  batchId?: string;           // バッチID
  batchSize?: number;         // バッチ内の支払い数
  positionInBatch?: number;   // バッチ内の位置
  
  // 計算詳細
  shareCount: number;         // 対象シェア数
  totalDifficulty: number;    // 総難易度
  poolFeeAmount: number;      // プール手数料額
  netAmount: number;          // 手数料後の正味額
  
  // メタデータ
  paymentMethod: string;      // 支払い方法（auto/manual/batch）
  priority: string;           // トランザクション優先度
  notes?: string;            // 備考
  tags?: string[];           // タグ（分類用）
}

export interface PaymentSummary {
  minerId: string;
  address: string;
  totalPaid: number;
  paymentCount: number;
  firstPayment: number;
  lastPayment: number;
  averageAmount: number;
  largestPayment: number;
  smallestPayment: number;
  totalFees: number;
  schemes: { [key: string]: number }; // スキーム別支払い回数
}

export interface PaymentStatistics {
  period: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  startTime: number;
  endTime: number;
  totalAmount: number;
  paymentCount: number;
  uniqueMiners: number;
  averagePayment: number;
  medianPayment: number;
  totalFees: number;
  averageFeeRate: number;
  schemeBreakdown: { [key: string]: { count: number; amount: number } };
  topMiners: Array<{ minerId: string; amount: number; count: number }>;
}

export interface PaymentFilter {
  minerId?: string;
  address?: string;
  minAmount?: number;
  maxAmount?: number;
  startTime?: number;
  endTime?: number;
  status?: string;
  scheme?: string;
  txHash?: string;
  batchId?: string;
  tags?: string[];
}

export interface PaymentAnalytics {
  trends: Array<{ time: number; amount: number; count: number }>;
  distribution: Array<{ range: string; count: number; amount: number }>;
  feeAnalysis: {
    averageFee: number;
    totalFees: number;
    feePercentage: number;
    feeTrend: Array<{ time: number; avgFee: number }>;
  };
  performanceMetrics: {
    averageConfirmationTime: number;
    successRate: number;
    failureReasons: { [key: string]: number };
  };
}

// === 支払い履歴マネージャー ===
export class PaymentHistoryManager extends EventEmitter {
  private database: PoolDatabase;
  private cache: Map<string, DetailedPaymentRecord[]> = new Map();
  private summaryCache: Map<string, PaymentSummary> = new Map();
  private cacheExpiry = 300000; // 5分
  
  constructor(database: PoolDatabase) {
    super();
    this.database = database;
  }
  
  // 詳細な支払い記録の追加
  async recordDetailedPayment(payment: DetailedPaymentRecord): Promise<void> {
    try {
      // データベースに保存
      await this.database.addPayment(payment);
      
      // キャッシュを更新
      this.invalidateCache(payment.minerId);
      
      // インデックスの更新
      await this.updateIndices(payment);
      
      this.emit('paymentRecorded', payment);
    } catch (error) {
      this.emit('error', { error, context: 'recordDetailedPayment' });
      throw error;
    }
  }
  
  // 支払い履歴の取得（詳細フィルタリング）
  async getPaymentHistory(filter: PaymentFilter): Promise<DetailedPaymentRecord[]> {
    try {
      // キャッシュチェック
      const cacheKey = this.generateCacheKey(filter);
      if (this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        if (cached && this.isCacheValid(cacheKey)) {
          return cached;
        }
      }
      
      // データベースから取得
      let payments = await this.database.getPaymentsByFilter(filter);
      
      // 詳細情報を付加
      payments = await this.enrichPaymentRecords(payments);
      
      // ソート（最新順）
      payments.sort((a, b) => b.timestamp - a.timestamp);
      
      // キャッシュに保存
      this.cache.set(cacheKey, payments);
      setTimeout(() => this.cache.delete(cacheKey), this.cacheExpiry);
      
      return payments;
    } catch (error) {
      this.emit('error', { error, context: 'getPaymentHistory' });
      throw error;
    }
  }
  
  // マイナーの支払いサマリー取得
  async getMinerPaymentSummary(minerId: string): Promise<PaymentSummary> {
    try {
      // キャッシュチェック
      if (this.summaryCache.has(minerId)) {
        return this.summaryCache.get(minerId)!;
      }
      
      // 全支払い履歴を取得
      const payments = await this.getPaymentHistory({ minerId });
      
      if (payments.length === 0) {
        const miner = await this.database.getMiner(minerId);
        return {
          minerId,
          address: miner?.address || '',
          totalPaid: 0,
          paymentCount: 0,
          firstPayment: 0,
          lastPayment: 0,
          averageAmount: 0,
          largestPayment: 0,
          smallestPayment: 0,
          totalFees: 0,
          schemes: {}
        };
      }
      
      // サマリーの計算
      const summary: PaymentSummary = {
        minerId,
        address: payments[0].address,
        totalPaid: payments.reduce((sum, p) => sum + p.amount, 0),
        paymentCount: payments.length,
        firstPayment: payments[payments.length - 1].timestamp,
        lastPayment: payments[0].timestamp,
        averageAmount: 0,
        largestPayment: Math.max(...payments.map(p => p.amount)),
        smallestPayment: Math.min(...payments.map(p => p.amount)),
        totalFees: payments.reduce((sum, p) => sum + (p.feeAmount || 0), 0),
        schemes: {}
      };
      
      summary.averageAmount = summary.totalPaid / summary.paymentCount;
      
      // スキーム別集計
      for (const payment of payments) {
        summary.schemes[payment.scheme] = (summary.schemes[payment.scheme] || 0) + 1;
      }
      
      // キャッシュに保存
      this.summaryCache.set(minerId, summary);
      setTimeout(() => this.summaryCache.delete(minerId), this.cacheExpiry);
      
      return summary;
    } catch (error) {
      this.emit('error', { error, context: 'getMinerPaymentSummary' });
      throw error;
    }
  }
  
  // 支払い統計の取得
  async getPaymentStatistics(
    period: PaymentStatistics['period'],
    customRange?: { start: number; end: number }
  ): Promise<PaymentStatistics> {
    try {
      // 期間の計算
      const { startTime, endTime } = customRange || this.calculatePeriodRange(period);
      
      // 対象の支払いを取得
      const payments = await this.getPaymentHistory({ startTime, endTime });
      
      if (payments.length === 0) {
        return {
          period,
          startTime,
          endTime,
          totalAmount: 0,
          paymentCount: 0,
          uniqueMiners: 0,
          averagePayment: 0,
          medianPayment: 0,
          totalFees: 0,
          averageFeeRate: 0,
          schemeBreakdown: {},
          topMiners: []
        };
      }
      
      // 統計の計算
      const uniqueMiners = new Set(payments.map(p => p.minerId));
      const amounts = payments.map(p => p.amount).sort((a, b) => a - b);
      const medianPayment = amounts[Math.floor(amounts.length / 2)];
      
      // スキーム別集計
      const schemeBreakdown: { [key: string]: { count: number; amount: number } } = {};
      for (const payment of payments) {
        if (!schemeBreakdown[payment.scheme]) {
          schemeBreakdown[payment.scheme] = { count: 0, amount: 0 };
        }
        schemeBreakdown[payment.scheme].count++;
        schemeBreakdown[payment.scheme].amount += payment.amount;
      }
      
      // トップマイナーの計算
      const minerTotals = new Map<string, { amount: number; count: number }>();
      for (const payment of payments) {
        const current = minerTotals.get(payment.minerId) || { amount: 0, count: 0 };
        current.amount += payment.amount;
        current.count++;
        minerTotals.set(payment.minerId, current);
      }
      
      const topMiners = Array.from(minerTotals.entries())
        .map(([minerId, data]) => ({ minerId, ...data }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);
      
      return {
        period,
        startTime,
        endTime,
        totalAmount: payments.reduce((sum, p) => sum + p.amount, 0),
        paymentCount: payments.length,
        uniqueMiners: uniqueMiners.size,
        averagePayment: payments.reduce((sum, p) => sum + p.amount, 0) / payments.length,
        medianPayment,
        totalFees: payments.reduce((sum, p) => sum + (p.feeAmount || 0), 0),
        averageFeeRate: payments.reduce((sum, p) => sum + (p.feeRate || 0), 0) / payments.length,
        schemeBreakdown,
        topMiners
      };
    } catch (error) {
      this.emit('error', { error, context: 'getPaymentStatistics' });
      throw error;
    }
  }
  
  // 支払い分析の取得
  async getPaymentAnalytics(
    startTime: number,
    endTime: number,
    granularity: 'hour' | 'day' | 'week' = 'day'
  ): Promise<PaymentAnalytics> {
    try {
      const payments = await this.getPaymentHistory({ startTime, endTime });
      
      // トレンド分析
      const trends = this.calculateTrends(payments, startTime, endTime, granularity);
      
      // 分布分析
      const distribution = this.calculateDistribution(payments);
      
      // 手数料分析
      const feeAnalysis = this.calculateFeeAnalysis(payments, startTime, endTime, granularity);
      
      // パフォーマンス分析
      const performanceMetrics = await this.calculatePerformanceMetrics(payments);
      
      return {
        trends,
        distribution,
        feeAnalysis,
        performanceMetrics
      };
    } catch (error) {
      this.emit('error', { error, context: 'getPaymentAnalytics' });
      throw error;
    }
  }
  
  // トレンドの計算
  private calculateTrends(
    payments: DetailedPaymentRecord[],
    startTime: number,
    endTime: number,
    granularity: string
  ): Array<{ time: number; amount: number; count: number }> {
    const intervalMs = this.getIntervalMs(granularity);
    const trends: Array<{ time: number; amount: number; count: number }> = [];
    
    for (let time = startTime; time < endTime; time += intervalMs) {
      const intervalPayments = payments.filter(
        p => p.timestamp >= time && p.timestamp < time + intervalMs
      );
      
      trends.push({
        time,
        amount: intervalPayments.reduce((sum, p) => sum + p.amount, 0),
        count: intervalPayments.length
      });
    }
    
    return trends;
  }
  
  // 分布の計算
  private calculateDistribution(
    payments: DetailedPaymentRecord[]
  ): Array<{ range: string; count: number; amount: number }> {
    const ranges = [
      { min: 0, max: 0.001, label: '< 0.001' },
      { min: 0.001, max: 0.01, label: '0.001-0.01' },
      { min: 0.01, max: 0.1, label: '0.01-0.1' },
      { min: 0.1, max: 1, label: '0.1-1' },
      { min: 1, max: 10, label: '1-10' },
      { min: 10, max: Infinity, label: '> 10' }
    ];
    
    return ranges.map(range => {
      const rangePayments = payments.filter(
        p => p.amount >= range.min && p.amount < range.max
      );
      
      return {
        range: range.label,
        count: rangePayments.length,
        amount: rangePayments.reduce((sum, p) => sum + p.amount, 0)
      };
    });
  }
  
  // 手数料分析の計算
  private calculateFeeAnalysis(
    payments: DetailedPaymentRecord[],
    startTime: number,
    endTime: number,
    granularity: string
  ): PaymentAnalytics['feeAnalysis'] {
    const totalAmount = payments.reduce((sum, p) => sum + p.amount, 0);
    const totalFees = payments.reduce((sum, p) => sum + (p.feeAmount || 0), 0);
    
    // 手数料トレンドの計算
    const intervalMs = this.getIntervalMs(granularity);
    const feeTrend: Array<{ time: number; avgFee: number }> = [];
    
    for (let time = startTime; time < endTime; time += intervalMs) {
      const intervalPayments = payments.filter(
        p => p.timestamp >= time && p.timestamp < time + intervalMs
      );
      
      if (intervalPayments.length > 0) {
        const avgFee = intervalPayments.reduce((sum, p) => sum + (p.feeRate || 0), 0) / intervalPayments.length;
        feeTrend.push({ time, avgFee });
      }
    }
    
    return {
      averageFee: payments.length > 0 ? totalFees / payments.length : 0,
      totalFees,
      feePercentage: totalAmount > 0 ? (totalFees / totalAmount) * 100 : 0,
      feeTrend
    };
  }
  
  // パフォーマンスメトリクスの計算
  private async calculatePerformanceMetrics(
    payments: DetailedPaymentRecord[]
  ): Promise<PaymentAnalytics['performanceMetrics']> {
    const completedPayments = payments.filter(p => p.status === 'completed');
    const failedPayments = payments.filter(p => p.status === 'failed');
    
    // 確認時間の計算（簡略化）
    const confirmationTimes = completedPayments
      .filter(p => p.confirmations > 0)
      .map(p => p.confirmations * 10 * 60); // 10分/ブロック
    
    const avgConfirmationTime = confirmationTimes.length > 0
      ? confirmationTimes.reduce((sum, t) => sum + t, 0) / confirmationTimes.length
      : 0;
    
    // 失敗理由の集計
    const failureReasons: { [key: string]: number } = {};
    for (const payment of failedPayments) {
      const reason = payment.notes || 'unknown';
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    }
    
    return {
      averageConfirmationTime: avgConfirmationTime,
      successRate: payments.length > 0 ? completedPayments.length / payments.length : 0,
      failureReasons
    };
  }
  
  // 支払い記録の拡充
  private async enrichPaymentRecords(
    payments: PaymentRecord[]
  ): Promise<DetailedPaymentRecord[]> {
    const enriched: DetailedPaymentRecord[] = [];
    
    for (const payment of payments) {
      // トランザクション情報の取得（実装依存）
      const txInfo = await this.getTransactionInfo(payment.txHash);
      
      enriched.push({
        ...payment,
        feeAmount: txInfo?.fee || 0,
        feeRate: txInfo?.feeRate || 0,
        confirmations: txInfo?.confirmations || 0,
        blockHeight: txInfo?.blockHeight,
        blockHash: txInfo?.blockHash,
        shareCount: 0, // 実装に応じて計算
        totalDifficulty: 0, // 実装に応じて計算
        poolFeeAmount: payment.amount * 0.01, // 1%と仮定
        netAmount: payment.amount * 0.99,
        paymentMethod: 'auto'
      } as DetailedPaymentRecord);
    }
    
    return enriched;
  }
  
  // トランザクション情報の取得（スタブ）
  private async getTransactionInfo(txHash: string): Promise<any> {
    // 実際の実装ではブロックチェーンAPIを使用
    return {
      fee: 0.0001,
      feeRate: 10,
      confirmations: 6,
      blockHeight: 700000,
      blockHash: 'mock_block_hash'
    };
  }
  
  // ユーティリティメソッド
  private generateCacheKey(filter: PaymentFilter): string {
    return JSON.stringify(filter);
  }
  
  private isCacheValid(key: string): boolean {
    // 実装に応じてキャッシュの有効性を判定
    return true;
  }
  
  private invalidateCache(minerId: string): void {
    // 関連するキャッシュをクリア
    this.summaryCache.delete(minerId);
    
    // フィルターキャッシュもクリア
    for (const [key, value] of this.cache) {
      const filter = JSON.parse(key) as PaymentFilter;
      if (filter.minerId === minerId) {
        this.cache.delete(key);
      }
    }
  }
  
  private async updateIndices(payment: DetailedPaymentRecord): Promise<void> {
    // インデックスの更新（実装依存）
    // タグ、バッチID、時系列インデックスなど
  }
  
  private calculatePeriodRange(period: string): { startTime: number; endTime: number } {
    const now = Date.now();
    let startTime: number;
    
    switch (period) {
      case 'hour':
        startTime = now - 60 * 60 * 1000;
        break;
      case 'day':
        startTime = now - 24 * 60 * 60 * 1000;
        break;
      case 'week':
        startTime = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case 'month':
        startTime = now - 30 * 24 * 60 * 60 * 1000;
        break;
      case 'year':
        startTime = now - 365 * 24 * 60 * 60 * 1000;
        break;
      default:
        startTime = 0;
    }
    
    return { startTime, endTime: now };
  }
  
  private getIntervalMs(granularity: string): number {
    switch (granularity) {
      case 'hour':
        return 60 * 60 * 1000;
      case 'day':
        return 24 * 60 * 60 * 1000;
      case 'week':
        return 7 * 24 * 60 * 60 * 1000;
      default:
        return 24 * 60 * 60 * 1000;
    }
  }
  
  // CSV/JSONエクスポート
  async exportPaymentHistory(
    filter: PaymentFilter,
    format: 'csv' | 'json'
  ): Promise<string> {
    const payments = await this.getPaymentHistory(filter);
    
    if (format === 'json') {
      return JSON.stringify(payments, null, 2);
    } else {
      // CSV形式
      const headers = [
        'Date', 'Miner ID', 'Address', 'Amount', 'Fee', 'TX Hash',
        'Status', 'Scheme', 'Confirmations'
      ].join(',');
      
      const rows = payments.map(p => [
        new Date(p.timestamp).toISOString(),
        p.minerId,
        p.address,
        p.amount,
        p.feeAmount || 0,
        p.txHash,
        p.status,
        p.scheme,
        p.confirmations || 0
      ].join(','));
      
      return [headers, ...rows].join('\n');
    }
  }
}

export default PaymentHistoryManager;