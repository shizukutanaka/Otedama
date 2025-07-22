/**
 * Self-Healing System for Complete Automation
 * 自己修復と自動回復を実現する包括的なシステム
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { getErrorHandler, OtedamaError, ErrorCategory } from '../error-handler.js';
import { getCryptoUtils } from '../crypto/crypto-utils.js';
import { performance } from 'perf_hooks';

const logger = getLogger('SelfHealingSystem');

// 修復戦略タイプ
export const HealingStrategy = {
  RESTART: 'restart',
  RECONNECT: 'reconnect',
  FAILOVER: 'failover',
  ROLLBACK: 'rollback',
  SCALE_UP: 'scale_up',
  SCALE_DOWN: 'scale_down',
  CIRCUIT_BREAK: 'circuit_break',
  RATE_LIMIT: 'rate_limit',
  CACHE_CLEAR: 'cache_clear',
  DATABASE_REPAIR: 'database_repair',
  MEMORY_CLEANUP: 'memory_cleanup',
  PROCESS_RESTART: 'process_restart'
};

// 問題タイプ
export const ProblemType = {
  CONNECTION_FAILURE: 'connection_failure',
  HIGH_MEMORY: 'high_memory',
  HIGH_CPU: 'high_cpu',
  SLOW_RESPONSE: 'slow_response',
  ERROR_RATE: 'error_rate',
  DEADLOCK: 'deadlock',
  DATA_CORRUPTION: 'data_corruption',
  SECURITY_BREACH: 'security_breach',
  RESOURCE_EXHAUSTION: 'resource_exhaustion'
};

export class SelfHealingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    this.options = {
      enableAutoHealing: options.enableAutoHealing !== false,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      healingTimeout: options.healingTimeout || 30000,
      monitoringInterval: options.monitoringInterval || 5000,
      
      // しきい値
      memoryThreshold: options.memoryThreshold || 0.85, // 85%
      cpuThreshold: options.cpuThreshold || 0.90, // 90%
      errorRateThreshold: options.errorRateThreshold || 0.05, // 5%
      responseTimeThreshold: options.responseTimeThreshold || 5000, // 5秒
      
      // 自動修復ポリシー
      autoRestartOnCrash: options.autoRestartOnCrash !== false,
      autoScaleOnLoad: options.autoScaleOnLoad !== false,
      autoFailoverOnError: options.autoFailoverOnError !== false,
      autoRollbackOnFailure: options.autoRollbackOnFailure !== false,
      
      ...options
    };
    
    // 修復履歴
    this.healingHistory = [];
    this.activeHealings = new Map();
    
    // 問題パターン認識
    this.problemPatterns = new Map();
    this.healingStrategies = new Map();
    
    // パフォーマンスメトリクス
    this.metrics = {
      totalProblems: 0,
      healedProblems: 0,
      failedHealings: 0,
      averageHealingTime: 0,
      problemTypes: {}
    };
    
    // サブシステム
    this.errorAnalyzer = new ErrorAnalyzer(this);
    this.healingEngine = new HealingEngine(this);
    this.preventionSystem = new PreventionSystem(this);
    
    this.initialize();
  }
  
  async initialize() {
    // デフォルトの修復戦略を登録
    this.registerDefaultStrategies();
    
    // 監視を開始
    if (this.options.enableAutoHealing) {
      this.startMonitoring();
    }
    
    this.logger.info('Self-healing system initialized');
  }
  
  /**
   * デフォルトの修復戦略を登録
   */
  registerDefaultStrategies() {
    // 接続エラーの修復戦略
    this.registerHealingStrategy(ProblemType.CONNECTION_FAILURE, [
      {
        strategy: HealingStrategy.RECONNECT,
        priority: 1,
        maxRetries: 3,
        retryDelay: 1000
      },
      {
        strategy: HealingStrategy.FAILOVER,
        priority: 2,
        condition: (context) => context.retries >= 3
      }
    ]);
    
    // メモリ問題の修復戦略
    this.registerHealingStrategy(ProblemType.HIGH_MEMORY, [
      {
        strategy: HealingStrategy.MEMORY_CLEANUP,
        priority: 1
      },
      {
        strategy: HealingStrategy.SCALE_UP,
        priority: 2,
        condition: (context) => context.memoryUsage > 0.95
      },
      {
        strategy: HealingStrategy.PROCESS_RESTART,
        priority: 3,
        condition: (context) => context.memoryUsage > 0.98
      }
    ]);
    
    // 高CPU使用率の修復戦略
    this.registerHealingStrategy(ProblemType.HIGH_CPU, [
      {
        strategy: HealingStrategy.RATE_LIMIT,
        priority: 1
      },
      {
        strategy: HealingStrategy.SCALE_UP,
        priority: 2,
        condition: (context) => context.cpuUsage > 0.95
      }
    ]);
    
    // エラー率の修復戦略
    this.registerHealingStrategy(ProblemType.ERROR_RATE, [
      {
        strategy: HealingStrategy.CIRCUIT_BREAK,
        priority: 1
      },
      {
        strategy: HealingStrategy.ROLLBACK,
        priority: 2,
        condition: (context) => context.errorRate > 0.10
      }
    ]);
  }
  
  /**
   * 問題を検出して修復
   */
  async detectAndHeal(component, error, context = {}) {
    const problemId = this.generateProblemId();
    
    try {
      // 問題を分析
      const problem = await this.errorAnalyzer.analyze(component, error, context);
      
      // 修復履歴に記録
      this.recordProblem(problemId, problem);
      
      // 自動修復が無効な場合は記録のみ
      if (!this.options.enableAutoHealing) {
        this.emit('problem:detected', { problemId, problem });
        return null;
      }
      
      // 修復戦略を選択
      const strategies = this.selectHealingStrategies(problem);
      
      if (strategies.length === 0) {
        this.logger.warn('No healing strategy found for problem', { problem });
        return null;
      }
      
      // 修復を実行
      const healing = await this.healingEngine.heal(problemId, problem, strategies);
      
      // 結果を記録
      this.recordHealing(problemId, healing);
      
      // 予防措置を実行
      await this.preventionSystem.applyPreventiveMeasures(problem, healing);
      
      return healing;
      
    } catch (error) {
      this.logger.error('Failed to heal problem', { problemId, error });
      this.metrics.failedHealings++;
      throw error;
    }
  }
  
  /**
   * 修復戦略を選択
   */
  selectHealingStrategies(problem) {
    const strategies = this.healingStrategies.get(problem.type) || [];
    
    // 条件に基づいてフィルタリング
    const applicableStrategies = strategies.filter(strategy => {
      if (!strategy.condition) return true;
      return strategy.condition(problem.context);
    });
    
    // 優先度でソート
    return applicableStrategies.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * 修復戦略を登録
   */
  registerHealingStrategy(problemType, strategies) {
    this.healingStrategies.set(problemType, strategies);
  }
  
  /**
   * システム監視を開始
   */
  startMonitoring() {
    this.monitoringInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.options.monitoringInterval);
  }
  
  /**
   * ヘルスチェックを実行
   */
  async performHealthCheck() {
    try {
      // システムメトリクスを収集
      const metrics = await this.collectSystemMetrics();
      
      // 問題を検出
      const problems = this.detectProblems(metrics);
      
      // 各問題に対して修復を試行
      for (const problem of problems) {
        await this.detectAndHeal('system', null, {
          ...problem,
          metrics
        });
      }
      
    } catch (error) {
      this.logger.error('Health check failed', error);
    }
  }
  
  /**
   * システムメトリクスを収集
   */
  async collectSystemMetrics() {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    
    return {
      memory: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        usage: memoryUsage.heapUsed / memoryUsage.heapTotal
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system,
        usage: await this.calculateCPUUsage()
      },
      timestamp: Date.now()
    };
  }
  
  /**
   * 問題を検出
   */
  detectProblems(metrics) {
    const problems = [];
    
    // メモリ使用率チェック
    if (metrics.memory.usage > this.options.memoryThreshold) {
      problems.push({
        type: ProblemType.HIGH_MEMORY,
        severity: metrics.memory.usage > 0.95 ? 'critical' : 'warning',
        memoryUsage: metrics.memory.usage
      });
    }
    
    // CPU使用率チェック
    if (metrics.cpu.usage > this.options.cpuThreshold) {
      problems.push({
        type: ProblemType.HIGH_CPU,
        severity: metrics.cpu.usage > 0.95 ? 'critical' : 'warning',
        cpuUsage: metrics.cpu.usage
      });
    }
    
    return problems;
  }
  
  /**
   * CPU使用率を計算
   */
  async calculateCPUUsage() {
    const startUsage = process.cpuUsage();
    const startTime = process.hrtime.bigint();
    
    // 100ms待機
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const endUsage = process.cpuUsage(startUsage);
    const endTime = process.hrtime.bigint();
    
    const elapsedTime = Number(endTime - startTime) / 1e6; // ミリ秒
    const totalCPUTime = (endUsage.user + endUsage.system) / 1000; // ミリ秒
    
    return totalCPUTime / elapsedTime;
  }
  
  /**
   * 問題を記録
   */
  recordProblem(problemId, problem) {
    this.metrics.totalProblems++;
    this.metrics.problemTypes[problem.type] = 
      (this.metrics.problemTypes[problem.type] || 0) + 1;
    
    this.healingHistory.push({
      id: problemId,
      problem,
      timestamp: Date.now(),
      status: 'detected'
    });
    
    // 履歴を制限
    if (this.healingHistory.length > 1000) {
      this.healingHistory = this.healingHistory.slice(-500);
    }
  }
  
  /**
   * 修復結果を記録
   */
  recordHealing(problemId, healing) {
    if (healing.success) {
      this.metrics.healedProblems++;
    } else {
      this.metrics.failedHealings++;
    }
    
    // 平均修復時間を更新
    const totalTime = this.metrics.averageHealingTime * 
                     (this.metrics.healedProblems - 1) + healing.duration;
    this.metrics.averageHealingTime = totalTime / this.metrics.healedProblems;
    
    // 履歴を更新
    const historyEntry = this.healingHistory.find(h => h.id === problemId);
    if (historyEntry) {
      historyEntry.healing = healing;
      historyEntry.status = healing.success ? 'healed' : 'failed';
    }
  }
  
  /**
   * 問題IDを生成
   */
  generateProblemId() {
    return `problem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      ...this.metrics,
      activeHealings: this.activeHealings.size,
      recentHistory: this.healingHistory.slice(-10)
    };
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    this.healingHistory = [];
    this.activeHealings.clear();
  }
}

/**
 * エラー分析エンジン
 */
class ErrorAnalyzer {
  constructor(healingSystem) {
    this.healingSystem = healingSystem;
    this.logger = logger;
  }
  
  async analyze(component, error, context) {
    const problem = {
      component,
      error: error ? {
        message: error.message,
        stack: error.stack,
        code: error.code
      } : null,
      context,
      timestamp: Date.now()
    };
    
    // エラータイプを判定
    problem.type = this.detectProblemType(error, context);
    
    // 重要度を判定
    problem.severity = this.calculateSeverity(problem);
    
    // 根本原因を分析
    problem.rootCause = await this.analyzeRootCause(problem);
    
    return problem;
  }
  
  detectProblemType(error, context) {
    // コンテキストベースの判定
    if (context.connectionError) return ProblemType.CONNECTION_FAILURE;
    if (context.memoryUsage > 0.85) return ProblemType.HIGH_MEMORY;
    if (context.cpuUsage > 0.90) return ProblemType.HIGH_CPU;
    if (context.errorRate > 0.05) return ProblemType.ERROR_RATE;
    if (context.responseTime > 5000) return ProblemType.SLOW_RESPONSE;
    
    // エラーベースの判定
    if (!error) return ProblemType.RESOURCE_EXHAUSTION;
    
    const errorMessage = error.message.toLowerCase();
    if (errorMessage.includes('connect') || errorMessage.includes('econnrefused')) {
      return ProblemType.CONNECTION_FAILURE;
    }
    if (errorMessage.includes('memory') || errorMessage.includes('heap')) {
      return ProblemType.HIGH_MEMORY;
    }
    if (errorMessage.includes('deadlock')) {
      return ProblemType.DEADLOCK;
    }
    if (errorMessage.includes('corrupt') || errorMessage.includes('integrity')) {
      return ProblemType.DATA_CORRUPTION;
    }
    
    return ProblemType.ERROR_RATE;
  }
  
  calculateSeverity(problem) {
    // 重要度の判定ロジック
    if (problem.type === ProblemType.SECURITY_BREACH) return 'critical';
    if (problem.type === ProblemType.DATA_CORRUPTION) return 'critical';
    if (problem.context?.memoryUsage > 0.95) return 'critical';
    if (problem.context?.cpuUsage > 0.95) return 'critical';
    if (problem.context?.errorRate > 0.10) return 'high';
    
    return 'medium';
  }
  
  async analyzeRootCause(problem) {
    // 根本原因分析のロジック
    const patterns = {
      [ProblemType.CONNECTION_FAILURE]: [
        'network_issue',
        'service_down',
        'firewall_block',
        'dns_failure'
      ],
      [ProblemType.HIGH_MEMORY]: [
        'memory_leak',
        'large_dataset',
        'cache_overflow',
        'infinite_loop'
      ],
      [ProblemType.HIGH_CPU]: [
        'infinite_loop',
        'inefficient_algorithm',
        'resource_contention',
        'mining_overload'
      ]
    };
    
    const possibleCauses = patterns[problem.type] || ['unknown'];
    
    // ヒューリスティックな原因推定
    return {
      primaryCause: possibleCauses[0],
      possibleCauses,
      confidence: 0.7
    };
  }
}

/**
 * 修復実行エンジン
 */
class HealingEngine {
  constructor(healingSystem) {
    this.healingSystem = healingSystem;
    this.logger = logger;
  }
  
  async heal(problemId, problem, strategies) {
    const startTime = Date.now();
    const results = [];
    
    for (const strategy of strategies) {
      try {
        this.logger.info(`Applying healing strategy: ${strategy.strategy}`, {
          problemId,
          problem: problem.type
        });
        
        const result = await this.applyStrategy(strategy, problem);
        results.push(result);
        
        if (result.success) {
          return {
            problemId,
            strategy: strategy.strategy,
            success: true,
            duration: Date.now() - startTime,
            results
          };
        }
        
      } catch (error) {
        this.logger.error(`Healing strategy failed: ${strategy.strategy}`, error);
        results.push({
          strategy: strategy.strategy,
          success: false,
          error: error.message
        });
      }
    }
    
    return {
      problemId,
      success: false,
      duration: Date.now() - startTime,
      results
    };
  }
  
  async applyStrategy(strategy, problem) {
    switch (strategy.strategy) {
      case HealingStrategy.RESTART:
        return await this.restartComponent(problem.component);
        
      case HealingStrategy.RECONNECT:
        return await this.reconnect(problem.component, strategy);
        
      case HealingStrategy.FAILOVER:
        return await this.failover(problem.component);
        
      case HealingStrategy.ROLLBACK:
        return await this.rollback(problem.component);
        
      case HealingStrategy.SCALE_UP:
        return await this.scaleUp(problem.component);
        
      case HealingStrategy.SCALE_DOWN:
        return await this.scaleDown(problem.component);
        
      case HealingStrategy.CIRCUIT_BREAK:
        return await this.applyCircuitBreaker(problem.component);
        
      case HealingStrategy.RATE_LIMIT:
        return await this.applyRateLimit(problem.component);
        
      case HealingStrategy.CACHE_CLEAR:
        return await this.clearCache(problem.component);
        
      case HealingStrategy.DATABASE_REPAIR:
        return await this.repairDatabase(problem.component);
        
      case HealingStrategy.MEMORY_CLEANUP:
        return await this.cleanupMemory();
        
      case HealingStrategy.PROCESS_RESTART:
        return await this.restartProcess();
        
      default:
        throw new Error(`Unknown healing strategy: ${strategy.strategy}`);
    }
  }
  
  async restartComponent(component) {
    // コンポーネント再起動のロジック
    this.logger.info(`Restarting component: ${component}`);
    
    // 実際の再起動処理をここに実装
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return { strategy: HealingStrategy.RESTART, success: true };
  }
  
  async reconnect(component, strategy) {
    // 再接続ロジック
    const maxRetries = strategy.maxRetries || 3;
    const retryDelay = strategy.retryDelay || 1000;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        this.logger.info(`Reconnection attempt ${i + 1}/${maxRetries}`);
        
        // 実際の再接続処理をここに実装
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        
        return { strategy: HealingStrategy.RECONNECT, success: true };
      } catch (error) {
        if (i === maxRetries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    
    return { strategy: HealingStrategy.RECONNECT, success: false };
  }
  
  async failover(component) {
    // フェイルオーバーロジック
    this.logger.info(`Initiating failover for: ${component}`);
    
    // 実際のフェイルオーバー処理をここに実装
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return { strategy: HealingStrategy.FAILOVER, success: true };
  }
  
  async rollback(component) {
    // ロールバックロジック
    this.logger.info(`Rolling back: ${component}`);
    
    // 実際のロールバック処理をここに実装
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    return { strategy: HealingStrategy.ROLLBACK, success: true };
  }
  
  async scaleUp(component) {
    // スケールアップロジック
    this.logger.info(`Scaling up: ${component}`);
    
    // 実際のスケールアップ処理をここに実装
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return { strategy: HealingStrategy.SCALE_UP, success: true };
  }
  
  async scaleDown(component) {
    // スケールダウンロジック
    this.logger.info(`Scaling down: ${component}`);
    
    // 実際のスケールダウン処理をここに実装
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return { strategy: HealingStrategy.SCALE_DOWN, success: true };
  }
  
  async applyCircuitBreaker(component) {
    // サーキットブレーカーロジック
    this.logger.info(`Applying circuit breaker to: ${component}`);
    
    // 実際のサーキットブレーカー処理をここに実装
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return { strategy: HealingStrategy.CIRCUIT_BREAK, success: true };
  }
  
  async applyRateLimit(component) {
    // レート制限ロジック
    this.logger.info(`Applying rate limit to: ${component}`);
    
    // 実際のレート制限処理をここに実装
    await new Promise(resolve => setTimeout(resolve, 500));
    
    return { strategy: HealingStrategy.RATE_LIMIT, success: true };
  }
  
  async clearCache(component) {
    // キャッシュクリアロジック
    this.logger.info(`Clearing cache for: ${component}`);
    
    // 実際のキャッシュクリア処理をここに実装
    if (global.gc) {
      global.gc();
    }
    
    return { strategy: HealingStrategy.CACHE_CLEAR, success: true };
  }
  
  async repairDatabase(component) {
    // データベース修復ロジック
    this.logger.info(`Repairing database: ${component}`);
    
    // 実際のデータベース修復処理をここに実装
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    return { strategy: HealingStrategy.DATABASE_REPAIR, success: true };
  }
  
  async cleanupMemory() {
    // メモリクリーンアップロジック
    this.logger.info('Performing memory cleanup');
    
    // ガベージコレクションを強制実行
    if (global.gc) {
      global.gc();
    }
    
    // 大きなオブジェクトをクリア
    // 実際のメモリクリーンアップ処理をここに実装
    
    return { strategy: HealingStrategy.MEMORY_CLEANUP, success: true };
  }
  
  async restartProcess() {
    // プロセス再起動ロジック
    this.logger.warn('Process restart requested');
    
    // グレースフルシャットダウン
    process.emit('SIGTERM');
    
    // PM2や他のプロセスマネージャーが再起動を処理
    
    return { strategy: HealingStrategy.PROCESS_RESTART, success: true };
  }
}

/**
 * 予防システム
 */
class PreventionSystem {
  constructor(healingSystem) {
    this.healingSystem = healingSystem;
    this.logger = logger;
    this.preventiveMeasures = new Map();
  }
  
  async applyPreventiveMeasures(problem, healing) {
    // 問題タイプに基づいて予防措置を適用
    switch (problem.type) {
      case ProblemType.HIGH_MEMORY:
        await this.preventMemoryIssues();
        break;
        
      case ProblemType.CONNECTION_FAILURE:
        await this.improveConnectionResilience();
        break;
        
      case ProblemType.ERROR_RATE:
        await this.reduceErrorRate();
        break;
        
      default:
        // 汎用的な予防措置
        await this.applyGeneralPrevention();
    }
  }
  
  async preventMemoryIssues() {
    // メモリリーク防止
    this.logger.info('Applying memory leak prevention measures');
    
    // 定期的なガベージコレクション
    setInterval(() => {
      if (global.gc) global.gc();
    }, 300000); // 5分ごと
    
    // メモリ使用量の監視強化
    // 実装をここに追加
  }
  
  async improveConnectionResilience() {
    // 接続の回復力向上
    this.logger.info('Improving connection resilience');
    
    // 接続プールの最適化
    // リトライロジックの強化
    // 実装をここに追加
  }
  
  async reduceErrorRate() {
    // エラー率の削減
    this.logger.info('Implementing error rate reduction measures');
    
    // エラーハンドリングの強化
    // バリデーションの追加
    // 実装をここに追加
  }
  
  async applyGeneralPrevention() {
    // 汎用的な予防措置
    this.logger.info('Applying general prevention measures');
    
    // ログ監視の強化
    // アラートしきい値の調整
    // 実装をここに追加
  }
}

export default SelfHealingSystem;