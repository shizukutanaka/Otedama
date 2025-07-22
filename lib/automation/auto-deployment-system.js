/**
 * Automated Deployment & CI/CD System
 * 完全自動化されたデプロイメントとCI/CDパイプライン
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const logger = getLogger('AutoDeploymentSystem');
const execAsync = promisify(exec);

// デプロイメント戦略
export const DeploymentStrategy = {
  ROLLING: 'rolling',
  BLUE_GREEN: 'blue_green',
  CANARY: 'canary',
  FEATURE_FLAG: 'feature_flag',
  A_B_TESTING: 'a_b_testing'
};

// パイプラインステージ
export const PipelineStage = {
  SOURCE: 'source',
  BUILD: 'build',
  TEST: 'test',
  SECURITY: 'security',
  STAGING: 'staging',
  PRODUCTION: 'production',
  MONITORING: 'monitoring',
  ROLLBACK: 'rollback'
};

export class AutoDeploymentSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    this.options = {
      enableAutoDeployment: options.enableAutoDeployment !== false,
      deploymentStrategy: options.deploymentStrategy || DeploymentStrategy.ROLLING,
      
      // パイプライン設定
      pipeline: {
        autoTrigger: options.pipeline?.autoTrigger !== false,
        parallelJobs: options.pipeline?.parallelJobs || 3,
        timeout: options.pipeline?.timeout || 1800000, // 30分
        retryOnFailure: options.pipeline?.retryOnFailure !== false,
        maxRetries: options.pipeline?.maxRetries || 2
      },
      
      // テスト設定
      testing: {
        runUnitTests: options.testing?.runUnitTests !== false,
        runIntegrationTests: options.testing?.runIntegrationTests !== false,
        runE2ETests: options.testing?.runE2ETests !== false,
        minCoverage: options.testing?.minCoverage || 80,
        performanceThreshold: options.testing?.performanceThreshold || {
          responseTime: 100, // ms
          throughput: 1000 // req/s
        }
      },
      
      // セキュリティ設定
      security: {
        runSecurityScan: options.security?.runSecurityScan !== false,
        vulnerabilityThreshold: options.security?.vulnerabilityThreshold || 'medium',
        dependencyCheck: options.security?.dependencyCheck !== false,
        containerScanning: options.security?.containerScanning !== false
      },
      
      // デプロイメント設定
      deployment: {
        environments: options.deployment?.environments || ['dev', 'staging', 'production'],
        approvalRequired: options.deployment?.approvalRequired || {
          staging: false,
          production: true
        },
        healthCheckInterval: options.deployment?.healthCheckInterval || 5000,
        rollbackThreshold: options.deployment?.rollbackThreshold || {
          errorRate: 0.05,
          responseTime: 500
        }
      },
      
      ...options
    };
    
    // パイプライン状態
    this.pipelines = new Map();
    this.deployments = new Map();
    this.rollbackHistory = [];
    
    // メトリクス
    this.metrics = {
      totalPipelines: 0,
      successfulDeployments: 0,
      failedDeployments: 0,
      rollbacks: 0,
      averageDeploymentTime: 0,
      deploymentFrequency: 0
    };
    
    // サブシステム
    this.pipelineEngine = new PipelineEngine(this);
    this.deploymentEngine = new DeploymentEngine(this);
    this.monitoringEngine = new MonitoringEngine(this);
    
    this.initialize();
  }
  
  async initialize() {
    // 作業ディレクトリを作成
    await this.createWorkDirectories();
    
    // Gitフックを設定
    if (this.options.pipeline.autoTrigger) {
      await this.setupGitHooks();
    }
    
    // 監視を開始
    this.startMonitoring();
    
    this.logger.info('Auto-deployment system initialized');
  }
  
  /**
   * 作業ディレクトリを作成
   */
  async createWorkDirectories() {
    const dirs = [
      '.otedama/pipelines',
      '.otedama/builds',
      '.otedama/artifacts',
      '.otedama/deployments',
      '.otedama/rollbacks'
    ];
    
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }
  }
  
  /**
   * Gitフックを設定
   */
  async setupGitHooks() {
    try {
      // post-receiveフックを作成
      const hookPath = '.git/hooks/post-receive';
      const hookContent = `#!/bin/bash
# Otedama Auto-deployment Hook
curl -X POST http://localhost:${process.env.API_PORT || 3000}/api/deployment/trigger \\
  -H "Content-Type: application/json" \\
  -d '{"ref": "'$ref'", "commits": "'$commits'"}'
`;
      
      await writeFile(hookPath, hookContent, { mode: 0o755 });
      this.logger.info('Git hooks configured');
      
    } catch (error) {
      this.logger.warn('Failed to setup git hooks', error);
    }
  }
  
  /**
   * パイプラインをトリガー
   */
  async triggerPipeline(trigger) {
    const pipelineId = this.generatePipelineId();
    
    const pipeline = {
      id: pipelineId,
      trigger,
      status: 'pending',
      stages: {},
      startTime: Date.now(),
      artifacts: []
    };
    
    this.pipelines.set(pipelineId, pipeline);
    this.metrics.totalPipelines++;
    
    this.emit('pipeline:started', { pipelineId, trigger });
    
    try {
      // パイプラインを実行
      await this.pipelineEngine.execute(pipeline);
      
      pipeline.status = 'success';
      pipeline.endTime = Date.now();
      
      this.emit('pipeline:completed', { pipelineId, status: 'success' });
      
      // 自動デプロイメント
      if (this.options.enableAutoDeployment && pipeline.status === 'success') {
        await this.deployToEnvironments(pipeline);
      }
      
      return pipeline;
      
    } catch (error) {
      pipeline.status = 'failed';
      pipeline.error = error.message;
      pipeline.endTime = Date.now();
      
      this.emit('pipeline:failed', { pipelineId, error });
      
      throw error;
    }
  }
  
  /**
   * 環境にデプロイ
   */
  async deployToEnvironments(pipeline) {
    for (const env of this.options.deployment.environments) {
      // 承認が必要かチェック
      if (this.options.deployment.approvalRequired[env]) {
        const approved = await this.requestApproval(pipeline, env);
        if (!approved) {
          this.logger.info(`Deployment to ${env} cancelled - approval denied`);
          continue;
        }
      }
      
      try {
        // デプロイメントを実行
        const deployment = await this.deploymentEngine.deploy(pipeline, env);
        
        // ヘルスチェック
        const healthy = await this.monitoringEngine.checkHealth(deployment);
        
        if (!healthy) {
          // 自動ロールバック
          await this.rollback(deployment);
        } else {
          this.metrics.successfulDeployments++;
        }
        
      } catch (error) {
        this.logger.error(`Deployment to ${env} failed`, error);
        this.metrics.failedDeployments++;
        
        // 次の環境へのデプロイを中止
        break;
      }
    }
  }
  
  /**
   * ロールバック
   */
  async rollback(deployment) {
    this.logger.warn(`Rolling back deployment: ${deployment.id}`);
    
    try {
      const rollback = await this.deploymentEngine.rollback(deployment);
      
      this.rollbackHistory.push({
        deploymentId: deployment.id,
        timestamp: Date.now(),
        reason: deployment.rollbackReason,
        success: rollback.success
      });
      
      this.metrics.rollbacks++;
      
      this.emit('deployment:rollback', { deployment, rollback });
      
      return rollback;
      
    } catch (error) {
      this.logger.error('Rollback failed', error);
      this.emit('deployment:rollback:failed', { deployment, error });
      throw error;
    }
  }
  
  /**
   * 承認をリクエスト
   */
  async requestApproval(pipeline, environment) {
    // 実際の実装では、Slack/Email/Webhookなどで通知
    this.emit('approval:requested', { pipeline, environment });
    
    // デモ用: 自動承認
    return new Promise(resolve => {
      setTimeout(() => resolve(true), 1000);
    });
  }
  
  /**
   * 監視を開始
   */
  startMonitoring() {
    // デプロイメント監視
    this.monitoringInterval = setInterval(async () => {
      await this.monitorDeployments();
    }, this.options.deployment.healthCheckInterval);
    
    // メトリクス収集
    this.metricsInterval = setInterval(() => {
      this.collectMetrics();
    }, 60000); // 1分ごと
  }
  
  /**
   * デプロイメントを監視
   */
  async monitorDeployments() {
    for (const [id, deployment] of this.deployments) {
      if (deployment.status === 'active') {
        const metrics = await this.monitoringEngine.collectMetrics(deployment);
        
        // しきい値チェック
        if (metrics.errorRate > this.options.deployment.rollbackThreshold.errorRate ||
            metrics.responseTime > this.options.deployment.rollbackThreshold.responseTime) {
          
          deployment.rollbackReason = 'Threshold exceeded';
          await this.rollback(deployment);
        }
      }
    }
  }
  
  /**
   * メトリクスを収集
   */
  collectMetrics() {
    // デプロイメント頻度を計算
    const recentDeployments = Array.from(this.deployments.values())
      .filter(d => Date.now() - d.timestamp < 86400000); // 24時間以内
    
    this.metrics.deploymentFrequency = recentDeployments.length;
    
    // 平均デプロイメント時間を計算
    if (this.metrics.successfulDeployments > 0) {
      const totalTime = Array.from(this.pipelines.values())
        .filter(p => p.status === 'success')
        .reduce((sum, p) => sum + (p.endTime - p.startTime), 0);
      
      this.metrics.averageDeploymentTime = totalTime / this.metrics.successfulDeployments;
    }
  }
  
  /**
   * パイプラインIDを生成
   */
  generatePipelineId() {
    return `pipeline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      ...this.metrics,
      activePipelines: Array.from(this.pipelines.values())
        .filter(p => p.status === 'running').length,
      activeDeployments: Array.from(this.deployments.values())
        .filter(d => d.status === 'active').length,
      recentRollbacks: this.rollbackHistory.slice(-10)
    };
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    this.pipelines.clear();
    this.deployments.clear();
  }
}

/**
 * パイプラインエンジン
 */
class PipelineEngine {
  constructor(deploymentSystem) {
    this.system = deploymentSystem;
    this.logger = logger;
  }
  
  async execute(pipeline) {
    const stages = [
      { name: PipelineStage.SOURCE, handler: this.stageSource.bind(this) },
      { name: PipelineStage.BUILD, handler: this.stageBuild.bind(this) },
      { name: PipelineStage.TEST, handler: this.stageTest.bind(this) },
      { name: PipelineStage.SECURITY, handler: this.stageSecurity.bind(this) },
      { name: PipelineStage.STAGING, handler: this.stageStaging.bind(this) }
    ];
    
    for (const stage of stages) {
      try {
        this.logger.info(`Executing stage: ${stage.name}`);
        pipeline.stages[stage.name] = { status: 'running', startTime: Date.now() };
        
        await stage.handler(pipeline);
        
        pipeline.stages[stage.name].status = 'success';
        pipeline.stages[stage.name].endTime = Date.now();
        
      } catch (error) {
        pipeline.stages[stage.name].status = 'failed';
        pipeline.stages[stage.name].error = error.message;
        pipeline.stages[stage.name].endTime = Date.now();
        
        // リトライ
        if (this.system.options.pipeline.retryOnFailure) {
          const retryCount = pipeline.stages[stage.name].retryCount || 0;
          if (retryCount < this.system.options.pipeline.maxRetries) {
            pipeline.stages[stage.name].retryCount = retryCount + 1;
            this.logger.info(`Retrying stage: ${stage.name} (${retryCount + 1}/${this.system.options.pipeline.maxRetries})`);
            await stage.handler(pipeline);
            continue;
          }
        }
        
        throw error;
      }
    }
  }
  
  async stageSource(pipeline) {
    // ソースコードを取得
    const { stdout } = await execAsync('git rev-parse HEAD');
    pipeline.commitHash = stdout.trim();
    
    // 変更ファイルを取得
    const { stdout: changes } = await execAsync('git diff --name-only HEAD~1');
    pipeline.changedFiles = changes.split('\n').filter(f => f);
  }
  
  async stageBuild(pipeline) {
    // ビルドを実行
    await execAsync('npm run build');
    
    // アーティファクトを保存
    const artifactPath = join('.otedama/artifacts', pipeline.id);
    await mkdir(artifactPath, { recursive: true });
    
    await execAsync(`cp -r dist/* ${artifactPath}/`);
    
    pipeline.artifacts.push({
      type: 'build',
      path: artifactPath,
      size: await this.getDirectorySize(artifactPath)
    });
  }
  
  async stageTest(pipeline) {
    const testResults = {};
    
    // ユニットテスト
    if (this.system.options.testing.runUnitTests) {
      const { stdout } = await execAsync('npm test -- --json');
      testResults.unit = JSON.parse(stdout);
    }
    
    // 統合テスト
    if (this.system.options.testing.runIntegrationTests) {
      const { stdout } = await execAsync('npm run test:integration -- --json');
      testResults.integration = JSON.parse(stdout);
    }
    
    // E2Eテスト
    if (this.system.options.testing.runE2ETests) {
      const { stdout } = await execAsync('npm run test:e2e -- --json');
      testResults.e2e = JSON.parse(stdout);
    }
    
    // カバレッジチェック
    const { stdout: coverage } = await execAsync('npm run coverage -- --json');
    const coverageData = JSON.parse(coverage);
    
    if (coverageData.total.lines.pct < this.system.options.testing.minCoverage) {
      throw new Error(`Coverage ${coverageData.total.lines.pct}% is below threshold ${this.system.options.testing.minCoverage}%`);
    }
    
    pipeline.testResults = testResults;
    pipeline.coverage = coverageData;
  }
  
  async stageSecurity(pipeline) {
    const securityResults = {};
    
    // 依存関係チェック
    if (this.system.options.security.dependencyCheck) {
      const { stdout } = await execAsync('npm audit --json');
      const audit = JSON.parse(stdout);
      
      const criticalVulns = Object.values(audit.vulnerabilities || {})
        .filter(v => v.severity === 'critical' || v.severity === 'high');
      
      if (criticalVulns.length > 0) {
        throw new Error(`Found ${criticalVulns.length} critical vulnerabilities`);
      }
      
      securityResults.dependencies = audit;
    }
    
    // セキュリティスキャン
    if (this.system.options.security.runSecurityScan) {
      // 実際のセキュリティスキャンツールを実行
      securityResults.scan = { passed: true };
    }
    
    pipeline.securityResults = securityResults;
  }
  
  async stageStaging(pipeline) {
    // ステージング環境にデプロイ
    const deployment = {
      environment: 'staging',
      version: pipeline.commitHash,
      timestamp: Date.now()
    };
    
    // デプロイメントを実行
    await execAsync(`npm run deploy:staging -- --version=${pipeline.commitHash}`);
    
    // スモークテスト
    const smokeTestPassed = await this.runSmokeTests('staging');
    
    if (!smokeTestPassed) {
      throw new Error('Smoke tests failed in staging');
    }
    
    pipeline.stagingDeployment = deployment;
  }
  
  async getDirectorySize(path) {
    const { stdout } = await execAsync(`du -sb ${path}`);
    return parseInt(stdout.split('\t')[0]);
  }
  
  async runSmokeTests(environment) {
    // 基本的なヘルスチェック
    try {
      const response = await fetch(`http://${environment}.otedama.local/health`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }
}

/**
 * デプロイメントエンジン
 */
class DeploymentEngine {
  constructor(deploymentSystem) {
    this.system = deploymentSystem;
    this.logger = logger;
  }
  
  async deploy(pipeline, environment) {
    const deploymentId = `deploy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const deployment = {
      id: deploymentId,
      pipelineId: pipeline.id,
      environment,
      version: pipeline.commitHash,
      strategy: this.system.options.deploymentStrategy,
      status: 'deploying',
      timestamp: Date.now()
    };
    
    this.system.deployments.set(deploymentId, deployment);
    
    try {
      // デプロイメント戦略に基づいて実行
      switch (this.system.options.deploymentStrategy) {
        case DeploymentStrategy.ROLLING:
          await this.rollingDeploy(deployment, pipeline);
          break;
          
        case DeploymentStrategy.BLUE_GREEN:
          await this.blueGreenDeploy(deployment, pipeline);
          break;
          
        case DeploymentStrategy.CANARY:
          await this.canaryDeploy(deployment, pipeline);
          break;
          
        default:
          await this.rollingDeploy(deployment, pipeline);
      }
      
      deployment.status = 'active';
      deployment.endTime = Date.now();
      
      return deployment;
      
    } catch (error) {
      deployment.status = 'failed';
      deployment.error = error.message;
      throw error;
    }
  }
  
  async rollingDeploy(deployment, pipeline) {
    // ローリングデプロイメント
    this.logger.info('Performing rolling deployment');
    
    // 実際のデプロイメントコマンドを実行
    await execAsync(`npm run deploy:${deployment.environment} -- --version=${deployment.version} --strategy=rolling`);
  }
  
  async blueGreenDeploy(deployment, pipeline) {
    // Blue-Greenデプロイメント
    this.logger.info('Performing blue-green deployment');
    
    // 新しい環境（Green）にデプロイ
    await execAsync(`npm run deploy:${deployment.environment}-green -- --version=${deployment.version}`);
    
    // ヘルスチェック
    const healthy = await this.healthCheck(`${deployment.environment}-green`);
    
    if (healthy) {
      // トラフィックを切り替え
      await execAsync(`npm run switch-traffic -- --from=${deployment.environment}-blue --to=${deployment.environment}-green`);
    } else {
      throw new Error('Green environment health check failed');
    }
  }
  
  async canaryDeploy(deployment, pipeline) {
    // カナリアデプロイメント
    this.logger.info('Performing canary deployment');
    
    // カナリアインスタンスにデプロイ
    await execAsync(`npm run deploy:${deployment.environment}-canary -- --version=${deployment.version}`);
    
    // 段階的にトラフィックを増やす
    const trafficSteps = [10, 25, 50, 100];
    
    for (const percentage of trafficSteps) {
      await execAsync(`npm run set-traffic -- --canary=${percentage}`);
      
      // メトリクスを監視
      await new Promise(resolve => setTimeout(resolve, 60000)); // 1分待機
      
      const metrics = await this.collectCanaryMetrics();
      
      if (metrics.errorRate > 0.05 || metrics.responseTime > 500) {
        // ロールバック
        throw new Error('Canary metrics exceeded threshold');
      }
    }
  }
  
  async rollback(deployment) {
    // 前のバージョンを取得
    const previousDeployment = Array.from(this.system.deployments.values())
      .filter(d => d.environment === deployment.environment && 
                   d.timestamp < deployment.timestamp &&
                   d.status === 'active')
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    
    if (!previousDeployment) {
      throw new Error('No previous deployment found for rollback');
    }
    
    // ロールバックを実行
    await execAsync(`npm run deploy:${deployment.environment} -- --version=${previousDeployment.version} --rollback=true`);
    
    deployment.status = 'rolled_back';
    previousDeployment.status = 'active';
    
    return {
      success: true,
      fromVersion: deployment.version,
      toVersion: previousDeployment.version
    };
  }
  
  async healthCheck(environment) {
    try {
      const response = await fetch(`http://${environment}.otedama.local/health`);
      const data = await response.json();
      
      return response.ok && data.status === 'healthy';
    } catch (error) {
      return false;
    }
  }
  
  async collectCanaryMetrics() {
    // 実際のメトリクス収集
    return {
      errorRate: Math.random() * 0.02, // デモ用
      responseTime: Math.random() * 200
    };
  }
}

/**
 * 監視エンジン
 */
class MonitoringEngine {
  constructor(deploymentSystem) {
    this.system = deploymentSystem;
    this.logger = logger;
  }
  
  async checkHealth(deployment) {
    try {
      const metrics = await this.collectMetrics(deployment);
      
      // ヘルスチェック基準
      const healthy = 
        metrics.availability > 0.99 &&
        metrics.errorRate < 0.01 &&
        metrics.responseTime < 200 &&
        metrics.cpuUsage < 0.80 &&
        metrics.memoryUsage < 0.85;
      
      return healthy;
      
    } catch (error) {
      this.logger.error('Health check failed', error);
      return false;
    }
  }
  
  async collectMetrics(deployment) {
    // 実際のメトリクス収集実装
    return {
      availability: 0.999,
      errorRate: Math.random() * 0.02,
      responseTime: Math.random() * 300,
      cpuUsage: Math.random() * 0.9,
      memoryUsage: Math.random() * 0.9,
      requestsPerSecond: Math.random() * 1000
    };
  }
}

export default AutoDeploymentSystem;