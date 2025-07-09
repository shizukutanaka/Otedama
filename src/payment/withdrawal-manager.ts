/**
 * 引き出しシステム
 * 手動および自動引き出し機能の実装
 * 
 * 設計思想：
 * - Carmack: 安全で効率的な引き出し処理
 * - Martin: 柔軟な引き出しポリシーと戦略
 * - Pike: シンプルで信頼性の高い引き出しフロー
 */

import { EventEmitter } from 'events';
import { PoolDatabase, MinerRecord } from '../database/pool-database';
import { BlockchainClient } from '../blockchain/blockchain-client';
import { PaymentManager } from './payment-system';
import { DynamicFeeCalculator } from './dynamic-fee-calculator';
import { createHash } from 'crypto';

// === 型定義 ===
export interface WithdrawalRequest {
  requestId: string;
  minerId: string;
  address: string;
  amount: number;
  requestTime: number;
  
  // 引き出しタイプ
  type: 'manual' | 'auto' | 'emergency';
  priority: 'high' | 'normal' | 'low';
  
  // 検証情報
  signature?: string;      // 署名（手動引き出し用）
  twoFactorCode?: string;  // 2FA認証コード
  ipAddress?: string;      // リクエスト元IP
  userAgent?: string;      // ユーザーエージェント
  
  // 処理状態
  status: 'pending' | 'processing' | 'approved' | 'completed' | 'failed' | 'cancelled';
  approvalTime?: number;
  processTime?: number;
  completionTime?: number;
  
  // トランザクション情報
  txHash?: string;
  txFee?: number;
  netAmount?: number;
  confirmations?: number;
  
  // エラー情報
  errorMessage?: string;
  retryCount?: number;
  lastRetry?: number;
}

export interface WithdrawalPolicy {
  // 基本設定
  minWithdrawal: number;        // 最小引き出し額
  maxWithdrawal: number;        // 最大引き出し額
  dailyLimit: number;           // 1日の引き出し限度額
  monthlyLimit: number;         // 月間引き出し限度額
  
  // 自動引き出し設定
  autoWithdrawalEnabled: boolean;
  autoWithdrawalThreshold: number;  // 自動引き出し閾値
  autoWithdrawalSchedule?: string;  // Cronスケジュール
  
  // セキュリティ設定
  require2FA: boolean;          // 2FA必須
  requireEmailConfirmation: boolean;
  confirmationTimeout: number;  // 確認タイムアウト（秒）
  cooldownPeriod: number;       // 連続引き出し制限（秒）
  
  // 手数料設定
  withdrawalFeeType: 'fixed' | 'percentage' | 'dynamic';
  withdrawalFeeAmount?: number;
  withdrawalFeePercent?: number;
  feeDeductionMethod: 'from_amount' | 'additional';
  
  // リスク管理
  maxPendingRequests: number;   // 最大保留リクエスト数
  suspiciousActivityThreshold: number;
  whitelistedAddresses?: string[];
  blacklistedAddresses?: string[];
}

export interface WithdrawalStats {
  totalWithdrawals: number;
  totalAmount: number;
  pendingCount: number;
  pendingAmount: number;
  averageProcessTime: number;
  successRate: number;
  last24h: {
    count: number;
    amount: number;
  };
  byStatus: { [status: string]: number };
  byType: { [type: string]: number };
}

export interface MinerWithdrawalSettings {
  minerId: string;
  autoWithdrawalEnabled: boolean;
  autoWithdrawalThreshold?: number;
  autoWithdrawalAddress?: string;
  preferredWithdrawalTime?: string; // 優先引き出し時刻
  notificationPreferences: {
    email?: boolean;
    sms?: boolean;
    webhook?: string;
  };
}

// === 引き出しマネージャー ===
export class WithdrawalManager extends EventEmitter {
  private database: PoolDatabase;
  private blockchainClient: BlockchainClient;
  private paymentManager: PaymentManager;
  private feeCalculator: DynamicFeeCalculator;
  private policy: WithdrawalPolicy;
  
  private pendingRequests: Map<string, WithdrawalRequest> = new Map();
  private processingQueue: WithdrawalRequest[] = [];
  private isProcessing = false;
  private autoWithdrawalTimer?: NodeJS.Timeout;
  
  // レート制限
  private withdrawalHistory: Map<string, number[]> = new Map();
  private suspiciousActivity: Map<string, number> = new Map();
  
  constructor(
    database: PoolDatabase,
    blockchainClient: BlockchainClient,
    paymentManager: PaymentManager,
    feeCalculator: DynamicFeeCalculator,
    policy: WithdrawalPolicy
  ) {
    super();
    this.database = database;
    this.blockchainClient = blockchainClient;
    this.paymentManager = paymentManager;
    this.feeCalculator = feeCalculator;
    this.policy = policy;
  }
  
  // システムの開始
  async start(): Promise<void> {
    // 保留中のリクエストを読み込み
    await this.loadPendingRequests();
    
    // 処理キューの開始
    setInterval(() => this.processQueue(), 5000);
    
    // 自動引き出しの設定
    if (this.policy.autoWithdrawalEnabled) {
      this.setupAutoWithdrawals();
    }
    
    // タイムアウトチェック
    setInterval(() => this.checkTimeouts(), 60000);
    
    this.emit('started');
  }
  
  // 手動引き出しリクエスト
  async requestManualWithdrawal(
    minerId: string,
    amount: number,
    address?: string,
    verification?: {
      signature?: string;
      twoFactorCode?: string;
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<WithdrawalRequest> {
    try {
      // 基本検証
      await this.validateWithdrawalRequest(minerId, amount, address);
      
      // 残高チェック
      const balance = await this.paymentManager.getMinerBalance(minerId);
      if (!balance || balance.balance < amount) {
        throw new Error('Insufficient balance');
      }
      
      // レート制限チェック
      this.checkRateLimit(minerId);
      
      // 2FA検証（必要な場合）
      if (this.policy.require2FA && !verification?.twoFactorCode) {
        throw new Error('2FA verification required');
      }
      
      // 引き出しリクエストの作成
      const request: WithdrawalRequest = {
        requestId: this.generateRequestId(),
        minerId,
        address: address || balance.address,
        amount,
        requestTime: Date.now(),
        type: 'manual',
        priority: amount > this.policy.minWithdrawal * 10 ? 'high' : 'normal',
        status: 'pending',
        ...verification
      };
      
      // セキュリティチェック
      await this.performSecurityChecks(request);
      
      // リクエストの保存
      await this.saveWithdrawalRequest(request);
      
      // 保留リクエストに追加
      this.pendingRequests.set(request.requestId, request);
      
      // 即座に処理キューに追加（高優先度の場合）
      if (request.priority === 'high') {
        this.processingQueue.unshift(request);
      }
      
      this.emit('withdrawalRequested', request);
      
      return request;
      
    } catch (error) {
      this.emit('error', { error, context: 'requestManualWithdrawal' });
      throw error;
    }
  }
  
  // 自動引き出しの設定
  async setAutoWithdrawal(
    minerId: string,
    settings: Partial<MinerWithdrawalSettings>
  ): Promise<void> {
    try {
      // 既存の設定を取得
      const currentSettings = await this.getMinerWithdrawalSettings(minerId);
      
      // 設定の更新
      const updatedSettings: MinerWithdrawalSettings = {
        ...currentSettings,
        ...settings,
        minerId
      };
      
      // 検証
      if (updatedSettings.autoWithdrawalEnabled) {
        if (!updatedSettings.autoWithdrawalThreshold || 
            updatedSettings.autoWithdrawalThreshold < this.policy.minWithdrawal) {
          throw new Error('Invalid auto withdrawal threshold');
        }
        
        if (updatedSettings.autoWithdrawalAddress) {
          await this.validateAddress(updatedSettings.autoWithdrawalAddress);
        }
      }
      
      // 設定の保存
      await this.saveMinerWithdrawalSettings(updatedSettings);
      
      this.emit('autoWithdrawalUpdated', updatedSettings);
      
    } catch (error) {
      this.emit('error', { error, context: 'setAutoWithdrawal' });
      throw error;
    }
  }
  
  // 引き出しのキャンセル
  async cancelWithdrawal(
    requestId: string,
    minerId: string,
    reason?: string
  ): Promise<void> {
    const request = this.pendingRequests.get(requestId);
    
    if (!request) {
      throw new Error('Withdrawal request not found');
    }
    
    if (request.minerId !== minerId) {
      throw new Error('Unauthorized');
    }
    
    if (request.status !== 'pending') {
      throw new Error('Cannot cancel non-pending request');
    }
    
    // ステータスの更新
    request.status = 'cancelled';
    request.errorMessage = reason || 'Cancelled by user';
    
    // データベースの更新
    await this.updateWithdrawalRequest(request);
    
    // 保留リクエストから削除
    this.pendingRequests.delete(requestId);
    
    this.emit('withdrawalCancelled', request);
  }
  
  // 処理キューの実行
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.processingQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    try {
      // 保留中のリクエストをキューに追加
      for (const request of this.pendingRequests.values()) {
        if (request.status === 'pending' && 
            !this.processingQueue.some(r => r.requestId === request.requestId)) {
          this.processingQueue.push(request);
        }
      }
      
      // 優先度でソート
      this.processingQueue.sort((a, b) => {
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
      
      // バッチ処理の準備
      const batch = this.prepareBatch();
      
      if (batch.length > 0) {
        await this.processBatch(batch);
      }
      
    } catch (error) {
      this.emit('error', { error, context: 'processQueue' });
    } finally {
      this.isProcessing = false;
    }
  }
  
  // バッチの準備
  private prepareBatch(): WithdrawalRequest[] {
    const batch: WithdrawalRequest[] = [];
    const maxBatchSize = 50;
    let totalAmount = 0;
    
    while (this.processingQueue.length > 0 && batch.length < maxBatchSize) {
      const request = this.processingQueue[0];
      
      // 手数料の推定
      const feeEstimate = this.feeCalculator.estimateTransactionFee({
        inputs: batch.length + 1,
        outputs: batch.length + 1,
        estimatedBytes: 0,
        isSegwit: true
      });
      
      // バッチに追加可能かチェック
      if (totalAmount + request.amount > this.policy.dailyLimit) {
        break;
      }
      
      // キューから削除してバッチに追加
      this.processingQueue.shift();
      batch.push(request);
      totalAmount += request.amount;
    }
    
    return batch;
  }
  
  // バッチの処理
  private async processBatch(batch: WithdrawalRequest[]): Promise<void> {
    try {
      // ステータスを処理中に更新
      for (const request of batch) {
        request.status = 'processing';
        request.processTime = Date.now();
        await this.updateWithdrawalRequest(request);
      }
      
      // 最終検証
      for (const request of batch) {
        try {
          await this.finalValidation(request);
          request.status = 'approved';
          request.approvalTime = Date.now();
        } catch (error: any) {
          request.status = 'failed';
          request.errorMessage = error.message;
          await this.updateWithdrawalRequest(request);
          
          // バッチから除外
          const index = batch.indexOf(request);
          if (index > -1) {
            batch.splice(index, 1);
          }
        }
      }
      
      if (batch.length === 0) {
        return;
      }
      
      // トランザクションの作成と送信
      if (batch.length === 1) {
        // 単一の引き出し
        await this.processSingleWithdrawal(batch[0]);
      } else {
        // バッチ引き出し
        await this.processBatchWithdrawals(batch);
      }
      
    } catch (error) {
      // エラー時の処理
      for (const request of batch) {
        if (request.status === 'processing') {
          request.status = 'failed';
          request.errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await this.updateWithdrawalRequest(request);
        }
      }
      
      throw error;
    }
  }
  
  // 単一引き出しの処理
  private async processSingleWithdrawal(request: WithdrawalRequest): Promise<void> {
    try {
      // 手数料の計算
      const txFee = await this.calculateWithdrawalFee(request);
      request.txFee = txFee;
      
      // 実際の送金額
      request.netAmount = this.policy.feeDeductionMethod === 'from_amount' 
        ? request.amount - txFee
        : request.amount;
      
      // トランザクションの送信
      const txHash = await this.blockchainClient.sendPayment(
        request.address,
        request.netAmount
      );
      
      request.txHash = txHash;
      request.status = 'completed';
      request.completionTime = Date.now();
      
      // データベースとキャッシュの更新
      await this.updateWithdrawalRequest(request);
      this.pendingRequests.delete(request.requestId);
      
      // 残高の更新
      await this.paymentManager.updateBalanceForPayment(
        request.minerId,
        request.amount,
        txHash
      );
      
      // 通知の送信
      await this.sendWithdrawalNotification(request);
      
      this.emit('withdrawalCompleted', request);
      
    } catch (error: any) {
      request.status = 'failed';
      request.errorMessage = error.message;
      request.retryCount = (request.retryCount || 0) + 1;
      request.lastRetry = Date.now();
      
      await this.updateWithdrawalRequest(request);
      
      // リトライ可能な場合は再度キューに追加
      if (request.retryCount < 3) {
        setTimeout(() => {
          this.processingQueue.push(request);
        }, 60000 * request.retryCount); // 指数的バックオフ
      }
      
      throw error;
    }
  }
  
  // バッチ引き出しの処理
  private async processBatchWithdrawals(batch: WithdrawalRequest[]): Promise<void> {
    try {
      // 受取人リストの作成
      const recipients = batch.map(request => ({
        address: request.address,
        amount: request.netAmount || request.amount
      }));
      
      // バッチトランザクションの送信
      const txHash = await this.blockchainClient.sendBatchPayment(recipients);
      
      // 各リクエストの更新
      for (const request of batch) {
        request.txHash = txHash;
        request.status = 'completed';
        request.completionTime = Date.now();
        request.batchId = `batch_${Date.now()}`;
        
        await this.updateWithdrawalRequest(request);
        this.pendingRequests.delete(request.requestId);
        
        // 残高の更新
        await this.paymentManager.updateBalanceForPayment(
          request.minerId,
          request.amount,
          txHash
        );
        
        // 通知の送信
        await this.sendWithdrawalNotification(request);
      }
      
      this.emit('batchWithdrawalCompleted', { batch, txHash });
      
    } catch (error: any) {
      // バッチ全体の失敗処理
      for (const request of batch) {
        request.status = 'failed';
        request.errorMessage = error.message;
        await this.updateWithdrawalRequest(request);
      }
      
      throw error;
    }
  }
  
  // 自動引き出しのセットアップ
  private setupAutoWithdrawals(): void {
    // 定期的なチェック（1時間ごと）
    this.autoWithdrawalTimer = setInterval(
      () => this.checkAutoWithdrawals(),
      3600000
    );
    
    // 初回チェック
    this.checkAutoWithdrawals();
  }
  
  // 自動引き出しのチェック
  private async checkAutoWithdrawals(): Promise<void> {
    try {
      // 自動引き出しが有効なマイナーを取得
      const miners = await this.getAutoWithdrawalMiners();
      
      for (const settings of miners) {
        try {
          // 残高チェック
          const balance = await this.paymentManager.getMinerBalance(settings.minerId);
          if (!balance) continue;
          
          const threshold = settings.autoWithdrawalThreshold || this.policy.autoWithdrawalThreshold;
          
          if (balance.balance >= threshold) {
            // 自動引き出しリクエストの作成
            const request: WithdrawalRequest = {
              requestId: this.generateRequestId(),
              minerId: settings.minerId,
              address: settings.autoWithdrawalAddress || balance.address,
              amount: balance.balance,
              requestTime: Date.now(),
              type: 'auto',
              priority: 'normal',
              status: 'pending'
            };
            
            // セキュリティチェック（簡略化）
            await this.performSecurityChecks(request);
            
            // リクエストの保存と処理
            await this.saveWithdrawalRequest(request);
            this.pendingRequests.set(request.requestId, request);
            
            this.emit('autoWithdrawalCreated', request);
          }
        } catch (error) {
          this.emit('error', { 
            error, 
            context: 'checkAutoWithdrawals',
            minerId: settings.minerId 
          });
        }
      }
    } catch (error) {
      this.emit('error', { error, context: 'checkAutoWithdrawals' });
    }
  }
  
  // 検証メソッド
  private async validateWithdrawalRequest(
    minerId: string,
    amount: number,
    address?: string
  ): Promise<void> {
    // 金額の検証
    if (amount < this.policy.minWithdrawal) {
      throw new Error(`Minimum withdrawal amount is ${this.policy.minWithdrawal}`);
    }
    
    if (amount > this.policy.maxWithdrawal) {
      throw new Error(`Maximum withdrawal amount is ${this.policy.maxWithdrawal}`);
    }
    
    // アドレスの検証
    if (address) {
      await this.validateAddress(address);
    }
    
    // 日次・月次限度額のチェック
    const dailyTotal = await this.getDailyWithdrawalTotal(minerId);
    if (dailyTotal + amount > this.policy.dailyLimit) {
      throw new Error('Daily withdrawal limit exceeded');
    }
    
    const monthlyTotal = await this.getMonthlyWithdrawalTotal(minerId);
    if (monthlyTotal + amount > this.policy.monthlyLimit) {
      throw new Error('Monthly withdrawal limit exceeded');
    }
    
    // 保留中のリクエスト数チェック
    const pendingCount = await this.getPendingRequestCount(minerId);
    if (pendingCount >= this.policy.maxPendingRequests) {
      throw new Error('Too many pending withdrawal requests');
    }
  }
  
  // セキュリティチェック
  private async performSecurityChecks(request: WithdrawalRequest): Promise<void> {
    // ブラックリストチェック
    if (this.policy.blacklistedAddresses?.includes(request.address)) {
      throw new Error('Address is blacklisted');
    }
    
    // ホワイトリストチェック（設定されている場合）
    if (this.policy.whitelistedAddresses && 
        this.policy.whitelistedAddresses.length > 0 &&
        !this.policy.whitelistedAddresses.includes(request.address)) {
      throw new Error('Address is not whitelisted');
    }
    
    // 疑わしい活動のチェック
    const suspiciousScore = this.suspiciousActivity.get(request.minerId) || 0;
    if (suspiciousScore > this.policy.suspiciousActivityThreshold) {
      throw new Error('Suspicious activity detected');
    }
    
    // IPアドレスチェック（実装依存）
    if (request.ipAddress) {
      await this.checkIPReputation(request.ipAddress);
    }
  }
  
  // 最終検証
  private async finalValidation(request: WithdrawalRequest): Promise<void> {
    // 残高の再確認
    const balance = await this.paymentManager.getMinerBalance(request.minerId);
    if (!balance || balance.balance < request.amount) {
      throw new Error('Insufficient balance at processing time');
    }
    
    // タイムアウトチェック
    if (Date.now() - request.requestTime > this.policy.confirmationTimeout * 1000) {
      throw new Error('Request timeout');
    }
  }
  
  // 手数料計算
  private async calculateWithdrawalFee(request: WithdrawalRequest): Promise<number> {
    switch (this.policy.withdrawalFeeType) {
      case 'fixed':
        return this.policy.withdrawalFeeAmount || 0;
        
      case 'percentage':
        return request.amount * (this.policy.withdrawalFeePercent || 0) / 100;
        
      case 'dynamic':
        const estimate = this.feeCalculator.estimateTransactionFee({
          inputs: 1,
          outputs: 1,
          estimatedBytes: 250,
          isSegwit: true
        });
        return estimate.totalFee;
        
      default:
        return 0;
    }
  }
  
  // レート制限チェック
  private checkRateLimit(minerId: string): void {
    const now = Date.now();
    const history = this.withdrawalHistory.get(minerId) || [];
    
    // 古いエントリを削除
    const recentHistory = history.filter(
      time => now - time < this.policy.cooldownPeriod * 1000
    );
    
    if (recentHistory.length > 0) {
      throw new Error(`Please wait ${this.policy.cooldownPeriod} seconds between withdrawals`);
    }
    
    // 履歴に追加
    recentHistory.push(now);
    this.withdrawalHistory.set(minerId, recentHistory);
  }
  
  // 通知送信
  private async sendWithdrawalNotification(request: WithdrawalRequest): Promise<void> {
    const settings = await this.getMinerWithdrawalSettings(request.minerId);
    
    const notification = {
      type: 'withdrawal_completed',
      requestId: request.requestId,
      amount: request.amount,
      netAmount: request.netAmount,
      txHash: request.txHash,
      address: request.address,
      timestamp: request.completionTime
    };
    
    // Email通知
    if (settings.notificationPreferences.email) {
      // Email送信の実装
    }
    
    // Webhook通知
    if (settings.notificationPreferences.webhook) {
      // Webhook送信の実装
    }
    
    this.emit('notificationSent', { request, notification });
  }
  
  // ユーティリティメソッド
  private generateRequestId(): string {
    return `wd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  private async validateAddress(address: string): Promise<void> {
    const isValid = await this.blockchainClient.validateAddress(address);
    if (!isValid) {
      throw new Error('Invalid withdrawal address');
    }
  }
  
  private async checkIPReputation(ipAddress: string): Promise<void> {
    // IP評価の実装（外部サービス連携など）
  }
  
  // データベース操作
  private async saveWithdrawalRequest(request: WithdrawalRequest): Promise<void> {
    await this.database.saveWithdrawalRequest(request);
  }
  
  private async updateWithdrawalRequest(request: WithdrawalRequest): Promise<void> {
    await this.database.updateWithdrawalRequest(request);
  }
  
  private async loadPendingRequests(): Promise<void> {
    const requests = await this.database.getPendingWithdrawalRequests();
    for (const request of requests) {
      this.pendingRequests.set(request.requestId, request);
    }
  }
  
  private async getMinerWithdrawalSettings(minerId: string): Promise<MinerWithdrawalSettings> {
    // データベースから設定を取得（実装依存）
    return {
      minerId,
      autoWithdrawalEnabled: false,
      notificationPreferences: {}
    };
  }
  
  private async saveMinerWithdrawalSettings(settings: MinerWithdrawalSettings): Promise<void> {
    await this.database.saveMinerWithdrawalSettings(settings);
  }
  
  private async getAutoWithdrawalMiners(): Promise<MinerWithdrawalSettings[]> {
    return this.database.getAutoWithdrawalMiners();
  }
  
  private async getDailyWithdrawalTotal(minerId: string): Promise<number> {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    
    return this.database.getWithdrawalTotal(minerId, dayStart.getTime(), Date.now());
  }
  
  private async getMonthlyWithdrawalTotal(minerId: string): Promise<number> {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    
    return this.database.getWithdrawalTotal(minerId, monthStart.getTime(), Date.now());
  }
  
  private async getPendingRequestCount(minerId: string): Promise<number> {
    let count = 0;
    for (const request of this.pendingRequests.values()) {
      if (request.minerId === minerId && request.status === 'pending') {
        count++;
      }
    }
    return count;
  }
  
  // タイムアウトチェック
  private async checkTimeouts(): Promise<void> {
    const now = Date.now();
    
    for (const request of this.pendingRequests.values()) {
      if (request.status === 'pending' && 
          now - request.requestTime > this.policy.confirmationTimeout * 1000) {
        request.status = 'failed';
        request.errorMessage = 'Request timeout';
        
        await this.updateWithdrawalRequest(request);
        this.pendingRequests.delete(request.requestId);
        
        this.emit('withdrawalTimeout', request);
      }
    }
  }
  
  // 公開API
  async getWithdrawalRequest(requestId: string): Promise<WithdrawalRequest | null> {
    return this.pendingRequests.get(requestId) || 
           await this.database.getWithdrawalRequest(requestId);
  }
  
  async getMinerWithdrawalHistory(
    minerId: string,
    limit = 100
  ): Promise<WithdrawalRequest[]> {
    return this.database.getMinerWithdrawalHistory(minerId, limit);
  }
  
  async getWithdrawalStats(): Promise<WithdrawalStats> {
    return this.database.getWithdrawalStats();
  }
  
  async getPolicy(): Promise<WithdrawalPolicy> {
    return { ...this.policy };
  }
  
  async updatePolicy(updates: Partial<WithdrawalPolicy>): Promise<void> {
    this.policy = { ...this.policy, ...updates };
    this.emit('policyUpdated', this.policy);
  }
}

export default WithdrawalManager;