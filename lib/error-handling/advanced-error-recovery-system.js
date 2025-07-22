/**
 * Advanced Error Recovery System
 * 高度なエラーリカバリーシステム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { performance } from 'perf_hooks';

const logger = getLogger('AdvancedErrorRecoverySystem');

// エラータイプ
export const ErrorType = {
  NETWORK: 'network',
  DATABASE: 'database',
  AUTHENTICATION: 'authentication',
  VALIDATION: 'validation',
  BUSINESS_LOGIC: 'business_logic',
  SYSTEM: 'system',
  EXTERNAL_SERVICE: 'external_service',
  RESOURCE_EXHAUSTION: 'resource_exhaustion',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown'
};

// リカバリー戦略
export const RecoveryStrategy = {
  RETRY: 'retry',
  EXPONENTIAL_BACKOFF: 'exponential_backoff',
  CIRCUIT_BREAKER: 'circuit_breaker',
  FALLBACK: 'fallback',
  GRACEFUL_DEGRADATION: 'graceful_degradation',
  ROLLBACK: 'rollback',
  COMPENSATION: 'compensation',
  BULKHEAD: 'bulkhead',
  TIMEOUT_ISOLATION: 'timeout_isolation',
  ADAPTIVE: 'adaptive'
};

// エラー重要度
export const ErrorSeverity = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
  FATAL: 5
};

export class AdvancedErrorRecoverySystem extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    
    this.options = {
      // 基本設定
      enableAutoRecovery: options.enableAutoRecovery !== false,
      enableErrorAnalysis: options.enableErrorAnalysis !== false,
      enablePreemptiveRecovery: options.enablePreemptiveRecovery !== false,
      
      // リトライ設定
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      backoffMultiplier: options.backoffMultiplier || 2,
      maxBackoffDelay: options.maxBackoffDelay || 30000,
      
      // サーキットブレーカー設定
      circuitBreakerThreshold: options.circuitBreakerThreshold || 5,
      circuitBreakerTimeout: options.circuitBreakerTimeout || 60000,
      circuitBreakerResetTimeout: options.circuitBreakerResetTimeout || 300000,
      
      // バルクヘッド設定
      bulkheadConcurrency: options.bulkheadConcurrency || 10,
      bulkheadQueueSize: options.bulkheadQueueSize || 50,
      
      // タイムアウト設定
      defaultTimeout: options.defaultTimeout || 30000,
      operationTimeouts: options.operationTimeouts || {},
      
      // エラー分析
      errorPatternDetection: options.errorPatternDetection !== false,
      errorCorrelation: options.errorCorrelation !== false,
      rootCauseAnalysis: options.rootCauseAnalysis !== false,
      
      ...options
    };
    
    // エラー追跡
    this.errorHistory = [];
    this.errorPatterns = new Map();
    this.errorCorrelations = new Map();
    
    // リカバリー戦略
    this.recoveryStrategies = new Map();
    this.fallbackHandlers = new Map();
    
    // サーキットブレーカー
    this.circuitBreakers = new Map();
    
    // バルクヘッド
    this.bulkheads = new Map();
    
    // メトリクス
    this.metrics = {
      totalErrors: 0,
      recoveredErrors: 0,
      failedRecoveries: 0,
      circuitBreakerTrips: 0,
      fallbacksUsed: 0,
      averageRecoveryTime: 0
    };
    
    // エラーキャッシュ
    this.errorCache = new Map();
    this.solutionCache = new Map();
    
    this.initialize();
  }
  
  async initialize() {
    // デフォルトリカバリー戦略を設定
    this.setupDefaultStrategies();
    
    // エラーパターン検出を開始
    if (this.options.errorPatternDetection) {
      this.startPatternDetection();
    }
    
    // プリエンプティブリカバリーを開始
    if (this.options.enablePreemptiveRecovery) {
      this.startPreemptiveRecovery();
    }
    
    this.logger.info('Advanced error recovery system initialized');
  }
  
  /**
   * エラーを処理
   */
  async handleError(error, context = {}) {
    const errorId = this.generateErrorId();
    const startTime = performance.now();
    
    // エラーを分類
    const errorInfo = this.classifyError(error, context);
    
    // エラーを記録
    this.recordError(errorId, errorInfo);
    
    // リカバリー戦略を選択
    const strategy = await this.selectRecoveryStrategy(errorInfo);
    
    // リカバリーを実行
    const recoveryResult = await this.executeRecovery(errorInfo, strategy);
    
    // メトリクスを更新
    this.updateMetrics(errorInfo, recoveryResult, performance.now() - startTime);
    
    // イベントを発行
    this.emit('error:handled', {
      errorId,
      errorInfo,
      strategy,
      result: recoveryResult
    });
    
    return recoveryResult;
  }
  
  /**
   * エラーを分類
   */
  classifyError(error, context) {
    const errorInfo = {
      id: this.generateErrorId(),
      timestamp: Date.now(),
      error,
      context,
      type: this.detectErrorType(error),
      severity: this.assessSeverity(error, context),
      isRecoverable: this.isRecoverable(error),
      correlatedErrors: [],
      rootCause: null
    };
    
    // エラー相関を検出
    if (this.options.errorCorrelation) {
      errorInfo.correlatedErrors = this.findCorrelatedErrors(errorInfo);
    }
    
    // ルート原因分析
    if (this.options.rootCauseAnalysis) {
      errorInfo.rootCause = this.analyzeRootCause(errorInfo);
    }
    
    return errorInfo;
  }
  
  /**
   * エラータイプを検出
   */
  detectErrorType(error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return ErrorType.NETWORK;
    }
    
    if (error.message?.includes('database') || error.code?.startsWith('ER_')) {
      return ErrorType.DATABASE;
    }
    
    if (error.name === 'ValidationError') {
      return ErrorType.VALIDATION;
    }
    
    if (error.name === 'AuthenticationError' || error.code === 401) {
      return ErrorType.AUTHENTICATION;
    }
    
    if (error.name === 'TimeoutError') {
      return ErrorType.TIMEOUT;
    }
    
    if (error.message?.includes('out of memory') || error.code === 'ENOMEM') {
      return ErrorType.RESOURCE_EXHAUSTION;
    }
    
    return ErrorType.UNKNOWN;
  }
  
  /**
   * リカバリー戦略を選択
   */
  async selectRecoveryStrategy(errorInfo) {
    // カスタム戦略をチェック
    const customStrategy = this.recoveryStrategies.get(errorInfo.type);
    if (customStrategy) {
      return customStrategy;
    }
    
    // 重要度に基づいて選択
    if (errorInfo.severity >= ErrorSeverity.CRITICAL) {
      return this.createAdaptiveStrategy(errorInfo);
    }
    
    // エラータイプに基づいて選択
    switch (errorInfo.type) {
      case ErrorType.NETWORK:
      case ErrorType.EXTERNAL_SERVICE:
        return {
          type: RecoveryStrategy.EXPONENTIAL_BACKOFF,
          withCircuitBreaker: true,
          fallback: true
        };
        
      case ErrorType.DATABASE:
        return {
          type: RecoveryStrategy.RETRY,
          maxRetries: 2,
          withBulkhead: true
        };
        
      case ErrorType.TIMEOUT:
        return {
          type: RecoveryStrategy.TIMEOUT_ISOLATION,
          fallback: true
        };
        
      case ErrorType.RESOURCE_EXHAUSTION:
        return {
          type: RecoveryStrategy.BULKHEAD,
          gracefulDegradation: true
        };
        
      default:
        return {
          type: RecoveryStrategy.RETRY,
          maxRetries: this.options.maxRetries
        };
    }
  }
  
  /**
   * リカバリーを実行
   */
  async executeRecovery(errorInfo, strategy) {
    this.logger.info(`Executing recovery strategy: ${strategy.type}`);
    
    try {
      switch (strategy.type) {
        case RecoveryStrategy.RETRY:
          return await this.executeRetry(errorInfo, strategy);
          
        case RecoveryStrategy.EXPONENTIAL_BACKOFF:
          return await this.executeExponentialBackoff(errorInfo, strategy);
          
        case RecoveryStrategy.CIRCUIT_BREAKER:
          return await this.executeCircuitBreaker(errorInfo, strategy);
          
        case RecoveryStrategy.FALLBACK:
          return await this.executeFallback(errorInfo, strategy);
          
        case RecoveryStrategy.GRACEFUL_DEGRADATION:
          return await this.executeGracefulDegradation(errorInfo, strategy);
          
        case RecoveryStrategy.ROLLBACK:
          return await this.executeRollback(errorInfo, strategy);
          
        case RecoveryStrategy.COMPENSATION:
          return await this.executeCompensation(errorInfo, strategy);
          
        case RecoveryStrategy.BULKHEAD:
          return await this.executeBulkhead(errorInfo, strategy);
          
        case RecoveryStrategy.TIMEOUT_ISOLATION:
          return await this.executeTimeoutIsolation(errorInfo, strategy);
          
        case RecoveryStrategy.ADAPTIVE:
          return await this.executeAdaptiveRecovery(errorInfo, strategy);
          
        default:
          throw new Error(`Unknown recovery strategy: ${strategy.type}`);
      }
    } catch (recoveryError) {
      this.logger.error('Recovery failed', recoveryError);
      this.metrics.failedRecoveries++;
      
      // フォールバックを試行
      if (strategy.fallback) {
        return await this.executeFallback(errorInfo, strategy);
      }
      
      throw recoveryError;
    }
  }
  
  /**
   * リトライ戦略を実行
   */
  async executeRetry(errorInfo, strategy) {
    const maxRetries = strategy.maxRetries || this.options.maxRetries;
    const operation = errorInfo.context.operation;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.info(`Retry attempt ${attempt}/${maxRetries}`);
        
        if (typeof operation === 'function') {
          const result = await operation();
          this.metrics.recoveredErrors++;
          return { success: true, result, attempts: attempt };
        }
        
        throw new Error('No operation provided for retry');
        
      } catch (error) {
        if (attempt === maxRetries) {
          throw error;
        }
        
        // リトライ間隔を待機
        await this.delay(this.options.retryDelay * attempt);
      }
    }
  }
  
  /**
   * 指数バックオフ戦略を実行
   */
  async executeExponentialBackoff(errorInfo, strategy) {
    const maxRetries = strategy.maxRetries || this.options.maxRetries;
    const operation = errorInfo.context.operation;
    let delay = this.options.retryDelay;
    
    // サーキットブレーカーをチェック
    if (strategy.withCircuitBreaker) {
      const circuitBreaker = this.getOrCreateCircuitBreaker(errorInfo.context.resource);
      if (circuitBreaker.state === 'open') {
        throw new Error('Circuit breaker is open');
      }
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        
        // 成功時はサーキットブレーカーをリセット
        if (strategy.withCircuitBreaker) {
          this.resetCircuitBreaker(errorInfo.context.resource);
        }
        
        this.metrics.recoveredErrors++;
        return { success: true, result, attempts: attempt };
        
      } catch (error) {
        if (strategy.withCircuitBreaker) {
          this.recordCircuitBreakerFailure(errorInfo.context.resource);
        }
        
        if (attempt === maxRetries) {
          throw error;
        }
        
        // 指数バックオフ
        await this.delay(delay);
        delay = Math.min(delay * this.options.backoffMultiplier, this.options.maxBackoffDelay);
      }
    }
  }
  
  /**
   * サーキットブレーカー戦略を実行
   */
  async executeCircuitBreaker(errorInfo, strategy) {
    const resource = errorInfo.context.resource || 'default';
    const circuitBreaker = this.getOrCreateCircuitBreaker(resource);
    
    // サーキットブレーカーの状態を確認
    if (circuitBreaker.state === 'open') {
      // タイムアウトを確認
      if (Date.now() - circuitBreaker.lastFailureTime > this.options.circuitBreakerTimeout) {
        circuitBreaker.state = 'half-open';
      } else {
        throw new Error(`Circuit breaker is open for ${resource}`);
      }
    }
    
    try {
      const result = await errorInfo.context.operation();
      
      // 成功時
      if (circuitBreaker.state === 'half-open') {
        circuitBreaker.state = 'closed';
        circuitBreaker.failureCount = 0;
      }
      
      return { success: true, result };
      
    } catch (error) {
      circuitBreaker.failureCount++;
      circuitBreaker.lastFailureTime = Date.now();
      
      // しきい値を超えたらオープン
      if (circuitBreaker.failureCount >= this.options.circuitBreakerThreshold) {
        circuitBreaker.state = 'open';
        this.metrics.circuitBreakerTrips++;
        
        this.emit('circuit:opened', { resource, circuitBreaker });
      }
      
      throw error;
    }
  }
  
  /**
   * フォールバック戦略を実行
   */
  async executeFallback(errorInfo, strategy) {
    const fallbackKey = errorInfo.context.fallbackKey || errorInfo.type;
    const fallbackHandler = this.fallbackHandlers.get(fallbackKey);
    
    if (!fallbackHandler) {
      // デフォルトフォールバック
      return this.executeDefaultFallback(errorInfo);
    }
    
    try {
      const result = await fallbackHandler(errorInfo);
      this.metrics.fallbacksUsed++;
      
      return {
        success: true,
        result,
        fallback: true
      };
      
    } catch (fallbackError) {
      this.logger.error('Fallback failed', fallbackError);
      throw fallbackError;
    }
  }
  
  /**
   * グレースフルデグラデーション戦略を実行
   */
  async executeGracefulDegradation(errorInfo, strategy) {
    const degradationLevels = strategy.levels || [
      { name: 'full', features: ['all'] },
      { name: 'reduced', features: ['essential', 'core'] },
      { name: 'minimal', features: ['core'] },
      { name: 'maintenance', features: [] }
    ];
    
    for (const level of degradationLevels) {
      try {
        const result = await this.executeWithDegradation(errorInfo, level);
        
        return {
          success: true,
          result,
          degradationLevel: level.name
        };
        
      } catch (error) {
        this.logger.warn(`Degradation level ${level.name} failed`, error);
      }
    }
    
    throw new Error('All degradation levels failed');
  }
  
  /**
   * ロールバック戦略を実行
   */
  async executeRollback(errorInfo, strategy) {
    const transaction = errorInfo.context.transaction;
    
    if (!transaction || !transaction.rollback) {
      throw new Error('No rollback available');
    }
    
    try {
      await transaction.rollback();
      
      return {
        success: true,
        rolledBack: true
      };
      
    } catch (rollbackError) {
      this.logger.error('Rollback failed', rollbackError);
      throw rollbackError;
    }
  }
  
  /**
   * 補償トランザクション戦略を実行
   */
  async executeCompensation(errorInfo, strategy) {
    const compensations = errorInfo.context.compensations || [];
    const executedCompensations = [];
    
    for (const compensation of compensations) {
      try {
        await compensation.execute();
        executedCompensations.push(compensation.name);
      } catch (compensationError) {
        this.logger.error(`Compensation ${compensation.name} failed`, compensationError);
        
        // 部分的な補償を記録
        return {
          success: false,
          compensated: executedCompensations,
          failed: compensation.name
        };
      }
    }
    
    return {
      success: true,
      compensated: executedCompensations
    };
  }
  
  /**
   * バルクヘッド戦略を実行
   */
  async executeBulkhead(errorInfo, strategy) {
    const resource = errorInfo.context.resource || 'default';
    const bulkhead = this.getOrCreateBulkhead(resource);
    
    // 同時実行数をチェック
    if (bulkhead.active >= this.options.bulkheadConcurrency) {
      // キューに追加
      if (bulkhead.queue.length >= this.options.bulkheadQueueSize) {
        throw new Error('Bulkhead queue is full');
      }
      
      return await this.queueInBulkhead(bulkhead, errorInfo);
    }
    
    // 実行
    bulkhead.active++;
    
    try {
      const result = await errorInfo.context.operation();
      return { success: true, result };
      
    } finally {
      bulkhead.active--;
      
      // キューから次のタスクを実行
      if (bulkhead.queue.length > 0) {
        const next = bulkhead.queue.shift();
        next.resolve(this.executeBulkhead(next.errorInfo, strategy));
      }
    }
  }
  
  /**
   * タイムアウト分離戦略を実行
   */
  async executeTimeoutIsolation(errorInfo, strategy) {
    const timeout = strategy.timeout || this.options.defaultTimeout;
    const operation = errorInfo.context.operation;
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Operation timed out')), timeout);
    });
    
    try {
      const result = await Promise.race([
        operation(),
        timeoutPromise
      ]);
      
      return { success: true, result };
      
    } catch (error) {
      if (error.message === 'Operation timed out' && strategy.fallback) {
        return await this.executeFallback(errorInfo, strategy);
      }
      throw error;
    }
  }
  
  /**
   * アダプティブリカバリー戦略を実行
   */
  async executeAdaptiveRecovery(errorInfo, strategy) {
    // エラー履歴から最適な戦略を学習
    const historicalSuccess = this.analyzeHistoricalSuccess(errorInfo);
    
    // 成功率の高い戦略を選択
    const strategies = [
      { type: RecoveryStrategy.RETRY, successRate: historicalSuccess.retry || 0.5 },
      { type: RecoveryStrategy.EXPONENTIAL_BACKOFF, successRate: historicalSuccess.backoff || 0.6 },
      { type: RecoveryStrategy.CIRCUIT_BREAKER, successRate: historicalSuccess.circuit || 0.7 },
      { type: RecoveryStrategy.FALLBACK, successRate: historicalSuccess.fallback || 0.8 }
    ].sort((a, b) => b.successRate - a.successRate);
    
    // 最も成功率の高い戦略から試行
    for (const adaptiveStrategy of strategies) {
      try {
        const result = await this.executeRecovery(errorInfo, {
          type: adaptiveStrategy.type,
          ...strategy
        });
        
        // 成功を記録
        this.recordStrategySuccess(errorInfo, adaptiveStrategy.type);
        
        return result;
        
      } catch (error) {
        // 失敗を記録
        this.recordStrategyFailure(errorInfo, adaptiveStrategy.type);
        
        if (adaptiveStrategy === strategies[strategies.length - 1]) {
          throw error;
        }
      }
    }
  }
  
  /**
   * エラーパターンを検出
   */
  detectErrorPatterns() {
    const recentErrors = this.errorHistory.slice(-100);
    const patterns = new Map();
    
    // 時系列パターン
    for (let i = 0; i < recentErrors.length - 1; i++) {
      const current = recentErrors[i];
      const next = recentErrors[i + 1];
      
      if (next.timestamp - current.timestamp < 60000) { // 1分以内
        const patternKey = `${current.type}->${next.type}`;
        patterns.set(patternKey, (patterns.get(patternKey) || 0) + 1);
      }
    }
    
    // 頻出パターンを特定
    const significantPatterns = [];
    for (const [pattern, count] of patterns) {
      if (count > 3) {
        significantPatterns.push({ pattern, count, probability: count / recentErrors.length });
      }
    }
    
    return significantPatterns;
  }
  
  /**
   * プリエンプティブリカバリーを実行
   */
  async executePreemptiveRecovery() {
    const patterns = this.detectErrorPatterns();
    
    for (const pattern of patterns) {
      if (pattern.probability > 0.7) {
        // 高確率パターンに対して予防措置
        const [source, target] = pattern.pattern.split('->');
        
        this.emit('preemptive:action', {
          pattern: pattern.pattern,
          action: 'prepare_resources',
          reason: `High probability of ${target} error after ${source}`
        });
        
        // リソースを事前に準備
        await this.prepareResourcesFor(target);
      }
    }
  }
  
  /**
   * デフォルト戦略を設定
   */
  setupDefaultStrategies() {
    // ネットワークエラー用戦略
    this.recoveryStrategies.set(ErrorType.NETWORK, {
      type: RecoveryStrategy.EXPONENTIAL_BACKOFF,
      maxRetries: 5,
      withCircuitBreaker: true,
      fallback: true
    });
    
    // データベースエラー用戦略
    this.recoveryStrategies.set(ErrorType.DATABASE, {
      type: RecoveryStrategy.RETRY,
      maxRetries: 3,
      withBulkhead: true,
      rollback: true
    });
    
    // リソース枯渇エラー用戦略
    this.recoveryStrategies.set(ErrorType.RESOURCE_EXHAUSTION, {
      type: RecoveryStrategy.GRACEFUL_DEGRADATION,
      levels: [
        { name: 'normal', resourceLimit: 100 },
        { name: 'reduced', resourceLimit: 50 },
        { name: 'minimal', resourceLimit: 10 }
      ]
    });
  }
  
  /**
   * フォールバックハンドラーを登録
   */
  registerFallback(key, handler) {
    this.fallbackHandlers.set(key, handler);
  }
  
  /**
   * エラー相関を検出
   */
  findCorrelatedErrors(errorInfo) {
    const correlations = [];
    const timeWindow = 60000; // 1分
    
    for (const historicalError of this.errorHistory.slice(-50)) {
      if (Math.abs(errorInfo.timestamp - historicalError.timestamp) < timeWindow) {
        if (this.areErrorsCorrelated(errorInfo, historicalError)) {
          correlations.push(historicalError.id);
        }
      }
    }
    
    return correlations;
  }
  
  /**
   * エラーが相関しているか判定
   */
  areErrorsCorrelated(error1, error2) {
    // 同じリソース
    if (error1.context.resource === error2.context.resource) {
      return true;
    }
    
    // 同じユーザー
    if (error1.context.userId === error2.context.userId) {
      return true;
    }
    
    // 類似のエラータイプ
    if (error1.type === error2.type) {
      return true;
    }
    
    return false;
  }
  
  /**
   * ルート原因を分析
   */
  analyzeRootCause(errorInfo) {
    // エラーチェーンを追跡
    const errorChain = this.buildErrorChain(errorInfo);
    
    // 共通要因を特定
    const commonFactors = this.identifyCommonFactors(errorChain);
    
    // スコアリング
    const rootCauses = commonFactors.map(factor => ({
      factor,
      confidence: this.calculateRootCauseConfidence(factor, errorChain),
      evidence: this.gatherEvidence(factor, errorChain)
    })).sort((a, b) => b.confidence - a.confidence);
    
    return rootCauses[0] || null;
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    const recentErrors = this.errorHistory.slice(-1000);
    const errorsByType = {};
    const recoverySuccessRate = {};
    
    // エラータイプ別集計
    for (const error of recentErrors) {
      errorsByType[error.type] = (errorsByType[error.type] || 0) + 1;
    }
    
    // リカバリー成功率
    for (const [type, strategy] of this.recoveryStrategies) {
      const attempts = this.getRecoveryAttempts(type);
      const successes = this.getRecoverySuccesses(type);
      recoverySuccessRate[type] = attempts > 0 ? successes / attempts : 0;
    }
    
    return {
      metrics: this.metrics,
      errorDistribution: errorsByType,
      recoverySuccessRate,
      circuitBreakers: {
        total: this.circuitBreakers.size,
        open: Array.from(this.circuitBreakers.values()).filter(cb => cb.state === 'open').length
      },
      patterns: this.detectErrorPatterns()
    };
  }
  
  // ヘルパーメソッド
  generateErrorId() {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  recordError(errorId, errorInfo) {
    this.errorHistory.push(errorInfo);
    this.metrics.totalErrors++;
    
    // 履歴を制限
    if (this.errorHistory.length > 10000) {
      this.errorHistory = this.errorHistory.slice(-5000);
    }
  }
  
  assessSeverity(error, context) {
    // クリティカルなキーワード
    if (error.message?.includes('data loss') || error.message?.includes('security breach')) {
      return ErrorSeverity.CRITICAL;
    }
    
    // コンテキストベース
    if (context.critical || context.production) {
      return ErrorSeverity.HIGH;
    }
    
    // エラータイプベース
    switch (this.detectErrorType(error)) {
      case ErrorType.AUTHENTICATION:
      case ErrorType.DATABASE:
        return ErrorSeverity.HIGH;
      case ErrorType.NETWORK:
        return ErrorSeverity.MEDIUM;
      default:
        return ErrorSeverity.LOW;
    }
  }
  
  isRecoverable(error) {
    // 致命的エラーは回復不可能
    if (error.fatal || error.code === 'FATAL') {
      return false;
    }
    
    // 一時的エラーは回復可能
    const recoverableCodes = ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAGAIN'];
    if (recoverableCodes.includes(error.code)) {
      return true;
    }
    
    return true; // デフォルトは回復可能
  }
  
  createAdaptiveStrategy(errorInfo) {
    return {
      type: RecoveryStrategy.ADAPTIVE,
      learning: true,
      fallback: true
    };
  }
  
  getOrCreateCircuitBreaker(resource) {
    if (!this.circuitBreakers.has(resource)) {
      this.circuitBreakers.set(resource, {
        state: 'closed',
        failureCount: 0,
        lastFailureTime: 0,
        successCount: 0
      });
    }
    
    return this.circuitBreakers.get(resource);
  }
  
  getOrCreateBulkhead(resource) {
    if (!this.bulkheads.has(resource)) {
      this.bulkheads.set(resource, {
        active: 0,
        queue: []
      });
    }
    
    return this.bulkheads.get(resource);
  }
  
  async queueInBulkhead(bulkhead, errorInfo) {
    return new Promise((resolve, reject) => {
      bulkhead.queue.push({ errorInfo, resolve, reject });
    });
  }
  
  async executeDefaultFallback(errorInfo) {
    // キャッシュから結果を返す
    const cacheKey = `${errorInfo.type}_${errorInfo.context.resource}`;
    const cachedResult = this.solutionCache.get(cacheKey);
    
    if (cachedResult) {
      return {
        success: true,
        result: cachedResult,
        fromCache: true
      };
    }
    
    // デフォルト値を返す
    return {
      success: true,
      result: errorInfo.context.defaultValue || null,
      defaultFallback: true
    };
  }
  
  async executeWithDegradation(errorInfo, level) {
    const degradedOperation = errorInfo.context.degradedOperations?.[level.name];
    
    if (!degradedOperation) {
      throw new Error(`No degraded operation for level ${level.name}`);
    }
    
    return await degradedOperation();
  }
  
  updateMetrics(errorInfo, result, duration) {
    if (result.success) {
      this.metrics.recoveredErrors++;
      
      // 平均リカバリー時間を更新
      const totalTime = this.metrics.averageRecoveryTime * (this.metrics.recoveredErrors - 1) + duration;
      this.metrics.averageRecoveryTime = totalTime / this.metrics.recoveredErrors;
    } else {
      this.metrics.failedRecoveries++;
    }
  }
  
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  resetCircuitBreaker(resource) {
    const circuitBreaker = this.circuitBreakers.get(resource);
    if (circuitBreaker) {
      circuitBreaker.state = 'closed';
      circuitBreaker.failureCount = 0;
      circuitBreaker.successCount++;
    }
  }
  
  recordCircuitBreakerFailure(resource) {
    const circuitBreaker = this.getOrCreateCircuitBreaker(resource);
    circuitBreaker.failureCount++;
    circuitBreaker.lastFailureTime = Date.now();
  }
  
  startPatternDetection() {
    setInterval(() => {
      const patterns = this.detectErrorPatterns();
      
      if (patterns.length > 0) {
        this.emit('patterns:detected', patterns);
      }
    }, 60000); // 1分ごと
  }
  
  startPreemptiveRecovery() {
    setInterval(async () => {
      await this.executePreemptiveRecovery();
    }, 300000); // 5分ごと
  }
  
  async prepareResourcesFor(errorType) {
    // エラータイプに応じたリソース準備
    switch (errorType) {
      case ErrorType.DATABASE:
        // 接続プールを拡張
        this.emit('prepare:database', { action: 'expand_pool' });
        break;
        
      case ErrorType.NETWORK:
        // キャッシュを準備
        this.emit('prepare:cache', { action: 'warm_cache' });
        break;
    }
  }
  
  analyzeHistoricalSuccess(errorInfo) {
    const relevantHistory = this.errorHistory.filter(e => 
      e.type === errorInfo.type && e.recovered
    );
    
    const successByStrategy = {};
    
    for (const historical of relevantHistory) {
      const strategy = historical.recoveryStrategy;
      if (!successByStrategy[strategy]) {
        successByStrategy[strategy] = { success: 0, total: 0 };
      }
      
      successByStrategy[strategy].total++;
      if (historical.recovered) {
        successByStrategy[strategy].success++;
      }
    }
    
    const successRates = {};
    for (const [strategy, stats] of Object.entries(successByStrategy)) {
      successRates[strategy] = stats.total > 0 ? stats.success / stats.total : 0;
    }
    
    return successRates;
  }
  
  recordStrategySuccess(errorInfo, strategy) {
    errorInfo.recoveryStrategy = strategy;
    errorInfo.recovered = true;
  }
  
  recordStrategyFailure(errorInfo, strategy) {
    errorInfo.failedStrategies = errorInfo.failedStrategies || [];
    errorInfo.failedStrategies.push(strategy);
  }
  
  buildErrorChain(errorInfo) {
    const chain = [errorInfo];
    
    // 相関エラーを追加
    for (const correlatedId of errorInfo.correlatedErrors) {
      const correlated = this.errorHistory.find(e => e.id === correlatedId);
      if (correlated) {
        chain.push(correlated);
      }
    }
    
    return chain;
  }
  
  identifyCommonFactors(errorChain) {
    const factors = new Set();
    
    for (const error of errorChain) {
      if (error.context.resource) factors.add(`resource:${error.context.resource}`);
      if (error.context.userId) factors.add(`user:${error.context.userId}`);
      if (error.type) factors.add(`type:${error.type}`);
    }
    
    return Array.from(factors);
  }
  
  calculateRootCauseConfidence(factor, errorChain) {
    const occurrences = errorChain.filter(e => {
      if (factor.startsWith('resource:')) {
        return e.context.resource === factor.split(':')[1];
      }
      if (factor.startsWith('user:')) {
        return e.context.userId === factor.split(':')[1];
      }
      if (factor.startsWith('type:')) {
        return e.type === factor.split(':')[1];
      }
      return false;
    }).length;
    
    return occurrences / errorChain.length;
  }
  
  gatherEvidence(factor, errorChain) {
    return errorChain.filter(e => {
      if (factor.startsWith('resource:')) {
        return e.context.resource === factor.split(':')[1];
      }
      return false;
    }).map(e => ({
      timestamp: e.timestamp,
      type: e.type,
      message: e.error.message
    }));
  }
  
  getRecoveryAttempts(type) {
    return this.errorHistory.filter(e => e.type === type).length;
  }
  
  getRecoverySuccesses(type) {
    return this.errorHistory.filter(e => e.type === type && e.recovered).length;
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    // 定期的なタスクを停止
    // (実装は省略)
  }
}

export default AdvancedErrorRecoverySystem;