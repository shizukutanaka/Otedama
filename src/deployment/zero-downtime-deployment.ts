/**
 * ゼロダウンタイムデプロイシステム
 * 設計思想: John Carmack (堅牢性), Rob Pike (シンプル), Robert C. Martin (保守性)
 * 
 * デプロイ戦略:
 * - Blue/Green Deployment
 * - Rolling Deployment  
 * - Canary Deployment
 * - A/B Testing Deployment
 * - Feature Flag Integration
 * 
 * 機能:
 * - 自動ヘルスチェック
 * - 即座のロールバック
 * - トラフィック段階的移行
 * - 状態監視とアラート
 * - データベース移行管理
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// === 型定義 ===
export interface DeploymentConfig {
  strategy: 'blue_green' | 'rolling' | 'canary' | 'ab_test';
  applicationName: string;
  version: string;
  buildPath: string;
  healthCheckUrl: string;
  healthCheckTimeout: number;
  healthCheckRetries: number;
  trafficSwitchDelay: number; // seconds
  rollbackOnFailure: boolean;
  notifications: NotificationConfig[];
  databases?: DatabaseMigrationConfig[];
  featureFlags?: FeatureFlag[];
}

export interface Environment {
  name: string;
  color: 'blue' | 'green' | 'canary' | 'production';
  port: number;
  status: 'stopped' | 'starting' | 'healthy' | 'unhealthy' | 'stopping';
  version?: string;
  startTime?: number;
  processId?: number;
  healthScore: number;
  trafficWeight: number; // 0-100
  lastHealthCheck?: number;
  metrics: EnvironmentMetrics;
}

export interface EnvironmentMetrics {
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  cpuUsage: number;
  memoryUsage: number;
  connections: number;
}

export interface DeploymentPlan {
  id: string;
  strategy: DeploymentConfig['strategy'];
  version: string;
  targetEnvironment: string;
  steps: DeploymentStep[];
  estimatedDuration: number;
  riskLevel: 'low' | 'medium' | 'high';
  rollbackPlan: RollbackPlan;
}

export interface DeploymentStep {
  id: string;
  name: string;
  type: 'build' | 'health_check' | 'traffic_switch' | 'database' | 'validation' | 'cleanup';
  description: string;
  timeout: number;
  retries: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startTime?: number;
  endTime?: number;
  output?: string;
  error?: string;
}

export interface RollbackPlan {
  trigger: 'manual' | 'automatic' | 'health_failure' | 'error_threshold';
  steps: DeploymentStep[];
  maxRollbackTime: number;
  preserveData: boolean;
}

export interface NotificationConfig {
  type: 'email' | 'slack' | 'webhook' | 'sms';
  target: string;
  events: string[]; // 'deployment_start', 'deployment_success', 'deployment_failure', 'rollback'
}

export interface DatabaseMigrationConfig {
  name: string;
  type: 'sql' | 'nosql' | 'schema';
  migrations: string[];
  rollbackMigrations: string[];
  backupBeforeMigration: boolean;
  validateAfterMigration: boolean;
}

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  rolloutPercentage: number;
  conditions: Record<string, any>;
}

export interface TrafficSplitConfig {
  blue: number;    // percentage
  green: number;   // percentage
  canary?: number; // percentage
}

export interface HealthCheckResult {
  environment: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  responseTime: number;
  checks: {
    database: boolean;
    external_services: boolean;
    memory: boolean;
    cpu: boolean;
    disk: boolean;
  };
  details: Record<string, any>;
}

// === ロードバランサー管理 ===
class LoadBalancerManager {
  private trafficSplit: TrafficSplitConfig = { blue: 50, green: 50 };
  private environments = new Map<string, Environment>();

  setTrafficSplit(split: TrafficSplitConfig): void {
    const total = split.blue + split.green + (split.canary || 0);
    if (Math.abs(total - 100) > 0.1) {
      throw new Error(`Traffic split must total 100%, got ${total}%`);
    }
    
    this.trafficSplit = split;
    console.log(`🔄 Traffic split updated: Blue=${split.blue}%, Green=${split.green}%${split.canary ? `, Canary=${split.canary}%` : ''}`);
  }

  getTrafficSplit(): TrafficSplitConfig {
    return { ...this.trafficSplit };
  }

  updateEnvironmentWeight(environmentName: string, weight: number): void {
    const env = this.environments.get(environmentName);
    if (env) {
      env.trafficWeight = weight;
    }
  }

  async switchTrafficGradually(
    fromEnv: string,
    toEnv: string,
    durationSeconds: number,
    steps: number = 10
  ): Promise<void> {
    const stepDuration = (durationSeconds / steps) * 1000;
    const stepSize = 100 / steps;

    for (let i = 1; i <= steps; i++) {
      const toWeight = stepSize * i;
      const fromWeight = 100 - toWeight;

      this.setTrafficSplit({
        blue: fromEnv === 'blue' ? fromWeight : toWeight,
        green: fromEnv === 'green' ? fromWeight : toWeight
      });

      console.log(`📊 Traffic migration step ${i}/${steps}: ${fromEnv}=${fromWeight}%, ${toEnv}=${toWeight}%`);
      
      if (i < steps) {
        await new Promise(resolve => setTimeout(resolve, stepDuration));
      }
    }
  }

  // Simulate nginx/haproxy configuration update
  async updateLoadBalancerConfig(): Promise<void> {
    const config = this.generateNginxConfig();
    console.log('🔧 Updating load balancer configuration...');
    
    // In real implementation, this would:
    // 1. Write new nginx.conf
    // 2. Test configuration: nginx -t
    // 3. Reload nginx: nginx -s reload
    // 4. Verify configuration is active
    
    await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate reload time
    console.log('✅ Load balancer configuration updated');
  }

  private generateNginxConfig(): string {
    const split = this.trafficSplit;
    
    return `
upstream blue_backend {
    server 127.0.0.1:3001 weight=${split.blue} max_fails=3 fail_timeout=30s;
}

upstream green_backend {
    server 127.0.0.1:3002 weight=${split.green} max_fails=3 fail_timeout=30s;
}

${split.canary ? `
upstream canary_backend {
    server 127.0.0.1:3003 weight=${split.canary} max_fails=3 fail_timeout=30s;
}
` : ''}

server {
    listen 80;
    server_name mining-pool.local;

    location / {
        # Traffic splitting logic
        if ($request_uri ~ "^/canary" ) {
            proxy_pass http://canary_backend;
        }
        
        # Weighted distribution
        proxy_pass http://blue_backend;
        proxy_next_upstream error timeout http_500 http_502 http_503;
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # Health check headers
        proxy_set_header X-Health-Check "true";
    }

    location /health {
        access_log off;
        proxy_pass http://blue_backend/health;
        proxy_connect_timeout 1s;
        proxy_read_timeout 1s;
    }
}`;
  }
}

// === ヘルスチェックマネージャー ===
class HealthCheckManager {
  private checkInterval: NodeJS.Timeout | null = null;
  private environments = new Map<string, Environment>();

  startContinuousHealthChecks(intervalMs: number = 30000): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    this.checkInterval = setInterval(() => {
      this.checkAllEnvironments();
    }, intervalMs);

    console.log(`🏥 Started continuous health checks (interval: ${intervalMs}ms)`);
  }

  stopHealthChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  async checkEnvironmentHealth(environment: Environment): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    try {
      // Simulate health check HTTP request
      const response = await this.performHealthCheck(environment);
      const responseTime = Date.now() - startTime;

      const result: HealthCheckResult = {
        environment: environment.name,
        status: this.determineHealthStatus(response, responseTime),
        responseTime,
        checks: {
          database: response.database === 'ok',
          external_services: response.services === 'ok',
          memory: response.memory_usage < 90,
          cpu: response.cpu_usage < 80,
          disk: response.disk_usage < 85
        },
        details: response
      };

      // Update environment health score
      environment.healthScore = this.calculateHealthScore(result);
      environment.lastHealthCheck = Date.now();
      environment.status = result.status === 'healthy' ? 'healthy' : 'unhealthy';

      return result;

    } catch (error) {
      return {
        environment: environment.name,
        status: 'unhealthy',
        responseTime: Date.now() - startTime,
        checks: {
          database: false,
          external_services: false,
          memory: false,
          cpu: false,
          disk: false
        },
        details: { error: error instanceof Error ? error.message : String(error) }
      };
    }
  }

  private async performHealthCheck(environment: Environment): Promise<any> {
    // Simulate HTTP health check
    await new Promise(resolve => setTimeout(resolve, Math.random() * 200 + 50));
    
    // Mock response
    return {
      status: 'ok',
      database: Math.random() > 0.05 ? 'ok' : 'error',
      services: Math.random() > 0.1 ? 'ok' : 'degraded',
      memory_usage: Math.random() * 30 + 60, // 60-90%
      cpu_usage: Math.random() * 40 + 40,    // 40-80%
      disk_usage: Math.random() * 20 + 60,   // 60-80%
      uptime: Date.now() - (environment.startTime || Date.now()),
      version: environment.version || 'unknown'
    };
  }

  private determineHealthStatus(response: any, responseTime: number): HealthCheckResult['status'] {
    if (responseTime > 5000) return 'unhealthy';
    if (response.database !== 'ok') return 'unhealthy';
    if (response.memory_usage > 95 || response.cpu_usage > 90) return 'unhealthy';
    if (response.services === 'degraded' || response.memory_usage > 85) return 'degraded';
    return 'healthy';
  }

  private calculateHealthScore(result: HealthCheckResult): number {
    let score = 100;
    
    // Response time penalty
    if (result.responseTime > 1000) score -= 10;
    else if (result.responseTime > 500) score -= 5;
    
    // Check failures
    Object.values(result.checks).forEach(check => {
      if (!check) score -= 15;
    });

    // Status penalty
    if (result.status === 'degraded') score -= 20;
    else if (result.status === 'unhealthy') score -= 50;

    return Math.max(0, score);
  }

  private async checkAllEnvironments(): Promise<void> {
    for (const environment of this.environments.values()) {
      if (environment.status !== 'stopped') {
        await this.checkEnvironmentHealth(environment);
      }
    }
  }

  addEnvironment(environment: Environment): void {
    this.environments.set(environment.name, environment);
  }

  removeEnvironment(name: string): void {
    this.environments.delete(name);
  }
}

// === メインゼロダウンタイムデプロイシステム ===
export class ZeroDowntimeDeployment extends EventEmitter {
  private environments = new Map<string, Environment>();
  private activeDeployment: DeploymentPlan | null = null;
  private loadBalancer = new LoadBalancerManager();
  private healthChecker = new HealthCheckManager();
  private deploymentHistory: DeploymentPlan[] = [];

  constructor() {
    super();
    this.initializeEnvironments();
    this.healthChecker.startContinuousHealthChecks();
  }

  private initializeEnvironments(): void {
    // Blue environment (currently active)
    const blueEnv: Environment = {
      name: 'blue',
      color: 'blue',
      port: 3001,
      status: 'healthy',
      version: '1.0.0',
      startTime: Date.now() - 3600000, // 1 hour ago
      healthScore: 95,
      trafficWeight: 100,
      metrics: this.getInitialMetrics()
    };

    // Green environment (standby)
    const greenEnv: Environment = {
      name: 'green',
      color: 'green',
      port: 3002,
      status: 'stopped',
      healthScore: 0,
      trafficWeight: 0,
      metrics: this.getInitialMetrics()
    };

    this.environments.set('blue', blueEnv);
    this.environments.set('green', greenEnv);
    
    this.healthChecker.addEnvironment(blueEnv);
    this.healthChecker.addEnvironment(greenEnv);

    console.log('🌍 Initialized environments: Blue (active), Green (standby)');
  }

  // === Blue/Green デプロイメント ===
  async deployBlueGreen(config: DeploymentConfig): Promise<boolean> {
    const plan = this.createBlueGreenPlan(config);
    return this.executeDeploymentPlan(plan);
  }

  private createBlueGreenPlan(config: DeploymentConfig): DeploymentPlan {
    const currentActive = this.getCurrentActiveEnvironment();
    const targetEnv = currentActive?.color === 'blue' ? 'green' : 'blue';

    const steps: DeploymentStep[] = [
      {
        id: 'build',
        name: 'Build Application',
        type: 'build',
        description: `Build version ${config.version} for ${targetEnv} environment`,
        timeout: 600000, // 10 minutes
        retries: 2,
        status: 'pending'
      },
      {
        id: 'database_migration',
        name: 'Database Migration',
        type: 'database',
        description: 'Run database migrations if needed',
        timeout: 300000, // 5 minutes
        retries: 1,
        status: 'pending'
      },
      {
        id: 'start_new_env',
        name: 'Start New Environment',
        type: 'build',
        description: `Start ${targetEnv} environment with new version`,
        timeout: 120000, // 2 minutes
        retries: 3,
        status: 'pending'
      },
      {
        id: 'health_check_new',
        name: 'Health Check New Environment',
        type: 'health_check',
        description: `Verify ${targetEnv} environment is healthy`,
        timeout: 60000, // 1 minute
        retries: 5,
        status: 'pending'
      },
      {
        id: 'traffic_switch',
        name: 'Switch Traffic',
        type: 'traffic_switch',
        description: `Gradually switch traffic to ${targetEnv} environment`,
        timeout: config.trafficSwitchDelay * 1000,
        retries: 1,
        status: 'pending'
      },
      {
        id: 'validation',
        name: 'Post-Deployment Validation',
        type: 'validation',
        description: 'Validate deployment success and monitor metrics',
        timeout: 180000, // 3 minutes
        retries: 1,
        status: 'pending'
      },
      {
        id: 'cleanup',
        name: 'Cleanup Old Environment',
        type: 'cleanup',
        description: `Stop old environment and cleanup resources`,
        timeout: 60000, // 1 minute
        retries: 1,
        status: 'pending'
      }
    ];

    const rollbackPlan: RollbackPlan = {
      trigger: config.rollbackOnFailure ? 'automatic' : 'manual',
      steps: [
        {
          id: 'rollback_traffic',
          name: 'Rollback Traffic',
          type: 'traffic_switch',
          description: 'Switch traffic back to previous environment',
          timeout: 30000,
          retries: 3,
          status: 'pending'
        },
        {
          id: 'rollback_database',
          name: 'Rollback Database',
          type: 'database',
          description: 'Rollback database migrations if necessary',
          timeout: 300000,
          retries: 1,
          status: 'pending'
        }
      ],
      maxRollbackTime: 120000, // 2 minutes
      preserveData: true
    };

    return {
      id: this.generateDeploymentId(),
      strategy: 'blue_green',
      version: config.version,
      targetEnvironment: targetEnv,
      steps,
      estimatedDuration: steps.reduce((sum, step) => sum + step.timeout, 0),
      riskLevel: this.assessRiskLevel(config),
      rollbackPlan
    };
  }

  // === ローリングデプロイメント ===
  async deployRolling(config: DeploymentConfig): Promise<boolean> {
    const plan = this.createRollingPlan(config);
    return this.executeDeploymentPlan(plan);
  }

  private createRollingPlan(config: DeploymentConfig): DeploymentPlan {
    const steps: DeploymentStep[] = [
      {
        id: 'build',
        name: 'Build Application',
        type: 'build',
        description: `Build version ${config.version}`,
        timeout: 600000,
        retries: 2,
        status: 'pending'
      },
      {
        id: 'rolling_update',
        name: 'Rolling Update',
        type: 'build',
        description: 'Update instances one by one',
        timeout: 900000, // 15 minutes
        retries: 1,
        status: 'pending'
      },
      {
        id: 'health_check_all',
        name: 'Health Check All Instances',
        type: 'health_check',
        description: 'Verify all instances are healthy',
        timeout: 120000,
        retries: 3,
        status: 'pending'
      }
    ];

    return {
      id: this.generateDeploymentId(),
      strategy: 'rolling',
      version: config.version,
      targetEnvironment: 'production',
      steps,
      estimatedDuration: steps.reduce((sum, step) => sum + step.timeout, 0),
      riskLevel: 'medium',
      rollbackPlan: this.createDefaultRollbackPlan()
    };
  }

  // === カナリアデプロイメント ===
  async deployCanary(config: DeploymentConfig, canaryPercentage: number = 5): Promise<boolean> {
    const plan = this.createCanaryPlan(config, canaryPercentage);
    return this.executeDeploymentPlan(plan);
  }

  private createCanaryPlan(config: DeploymentConfig, canaryPercentage: number): DeploymentPlan {
    const steps: DeploymentStep[] = [
      {
        id: 'build',
        name: 'Build Application',
        type: 'build',
        description: `Build version ${config.version}`,
        timeout: 600000,
        retries: 2,
        status: 'pending'
      },
      {
        id: 'start_canary',
        name: 'Start Canary Environment',
        type: 'build',
        description: 'Start canary environment with new version',
        timeout: 120000,
        retries: 3,
        status: 'pending'
      },
      {
        id: 'canary_traffic',
        name: 'Route Canary Traffic',
        type: 'traffic_switch',
        description: `Route ${canaryPercentage}% traffic to canary`,
        timeout: 60000,
        retries: 2,
        status: 'pending'
      },
      {
        id: 'canary_monitoring',
        name: 'Monitor Canary',
        type: 'validation',
        description: 'Monitor canary metrics and errors',
        timeout: 600000, // 10 minutes
        retries: 1,
        status: 'pending'
      },
      {
        id: 'full_deployment',
        name: 'Full Deployment',
        type: 'traffic_switch',
        description: 'Deploy to all instances if canary successful',
        timeout: 300000,
        retries: 1,
        status: 'pending'
      }
    ];

    return {
      id: this.generateDeploymentId(),
      strategy: 'canary',
      version: config.version,
      targetEnvironment: 'canary',
      steps,
      estimatedDuration: steps.reduce((sum, step) => sum + step.timeout, 0),
      riskLevel: 'low',
      rollbackPlan: this.createDefaultRollbackPlan()
    };
  }

  // === デプロイメント実行 ===
  private async executeDeploymentPlan(plan: DeploymentPlan): Promise<boolean> {
    console.log(`🚀 Starting ${plan.strategy} deployment: ${plan.version}`);
    console.log(`📋 Plan ID: ${plan.id}`);
    console.log(`⏱️  Estimated duration: ${Math.round(plan.estimatedDuration / 60000)} minutes`);
    console.log(`⚠️  Risk level: ${plan.riskLevel}`);

    this.activeDeployment = plan;
    this.emit('deploymentStarted', plan);

    try {
      for (const step of plan.steps) {
        const success = await this.executeDeploymentStep(step);
        
        if (!success) {
          console.error(`❌ Step failed: ${step.name}`);
          
          if (plan.rollbackPlan.trigger === 'automatic') {
            console.log('🔄 Starting automatic rollback...');
            await this.executeRollback(plan.rollbackPlan);
          }
          
          this.emit('deploymentFailed', { plan, failedStep: step });
          return false;
        }
      }

      console.log('✅ Deployment completed successfully');
      this.deploymentHistory.push(plan);
      this.activeDeployment = null;
      this.emit('deploymentCompleted', plan);
      
      return true;

    } catch (error) {
      console.error('💥 Deployment error:', error);
      
      if (plan.rollbackPlan.trigger === 'automatic') {
        await this.executeRollback(plan.rollbackPlan);
      }
      
      this.emit('deploymentError', { plan, error });
      return false;
    }
  }

  private async executeDeploymentStep(step: DeploymentStep): Promise<boolean> {
    console.log(`📝 Executing step: ${step.name}`);
    step.status = 'running';
    step.startTime = Date.now();

    this.emit('stepStarted', step);

    let attempt = 0;
    while (attempt <= step.retries) {
      try {
        const success = await this.performStepAction(step);
        
        if (success) {
          step.status = 'completed';
          step.endTime = Date.now();
          console.log(`✅ Step completed: ${step.name} (${step.endTime - step.startTime!}ms)`);
          this.emit('stepCompleted', step);
          return true;
        }
        
        attempt++;
        if (attempt <= step.retries) {
          console.log(`🔄 Retrying step: ${step.name} (attempt ${attempt}/${step.retries})`);
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
        }

      } catch (error) {
        step.error = error instanceof Error ? error.message : String(error);
        attempt++;
        
        if (attempt <= step.retries) {
          console.log(`🔄 Retrying step after error: ${step.name} (attempt ${attempt}/${step.retries})`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    step.status = 'failed';
    step.endTime = Date.now();
    this.emit('stepFailed', step);
    return false;
  }

  private async performStepAction(step: DeploymentStep): Promise<boolean> {
    switch (step.type) {
      case 'build':
        return this.performBuildStep(step);
      case 'health_check':
        return this.performHealthCheckStep(step);
      case 'traffic_switch':
        return this.performTrafficSwitchStep(step);
      case 'database':
        return this.performDatabaseStep(step);
      case 'validation':
        return this.performValidationStep(step);
      case 'cleanup':
        return this.performCleanupStep(step);
      default:
        console.warn(`Unknown step type: ${step.type}`);
        return true;
    }
  }

  private async performBuildStep(step: DeploymentStep): Promise<boolean> {
    // Simulate build process
    console.log(`🔨 Building application...`);
    
    const buildProcess = spawn('npm', ['run', 'build'], {
      cwd: process.cwd(),
      stdio: 'pipe'
    });

    return new Promise((resolve) => {
      let output = '';
      
      buildProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });

      buildProcess.stderr?.on('data', (data) => {
        output += data.toString();
      });

      buildProcess.on('close', (code) => {
        step.output = output;
        resolve(code === 0);
      });

      // Timeout
      setTimeout(() => {
        buildProcess.kill();
        resolve(false);
      }, step.timeout);
    });
  }

  private async performHealthCheckStep(step: DeploymentStep): Promise<boolean> {
    const targetEnv = this.activeDeployment?.targetEnvironment;
    if (!targetEnv) return false;

    const environment = this.environments.get(targetEnv);
    if (!environment) return false;

    const healthResult = await this.healthChecker.checkEnvironmentHealth(environment);
    step.output = JSON.stringify(healthResult, null, 2);
    
    return healthResult.status === 'healthy';
  }

  private async performTrafficSwitchStep(step: DeploymentStep): Promise<boolean> {
    const targetEnv = this.activeDeployment?.targetEnvironment;
    if (!targetEnv) return false;

    if (step.name.includes('Gradually')) {
      // Gradual traffic switch
      const currentActive = this.getCurrentActiveEnvironment();
      if (currentActive) {
        await this.loadBalancer.switchTrafficGradually(
          currentActive.name,
          targetEnv,
          30, // 30 seconds
          6   // 6 steps
        );
      }
    } else {
      // Immediate traffic switch
      this.loadBalancer.setTrafficSplit({
        blue: targetEnv === 'blue' ? 100 : 0,
        green: targetEnv === 'green' ? 100 : 0
      });
    }

    await this.loadBalancer.updateLoadBalancerConfig();
    return true;
  }

  private async performDatabaseStep(step: DeploymentStep): Promise<boolean> {
    console.log('🗄️ Running database migrations...');
    
    // Simulate database migration
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    step.output = 'Database migrations completed successfully';
    return true;
  }

  private async performValidationStep(step: DeploymentStep): Promise<boolean> {
    console.log('🔍 Validating deployment...');
    
    // Check error rates, response times, etc.
    const targetEnv = this.environments.get(this.activeDeployment?.targetEnvironment || '');
    if (!targetEnv) return false;

    // Simulate validation checks
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const errorRate = Math.random() * 5; // 0-5% error rate
    const avgResponseTime = Math.random() * 500 + 100; // 100-600ms
    
    step.output = `Validation results: Error rate: ${errorRate.toFixed(2)}%, Avg response time: ${avgResponseTime.toFixed(0)}ms`;
    
    return errorRate < 2 && avgResponseTime < 500;
  }

  private async performCleanupStep(step: DeploymentStep): Promise<boolean> {
    console.log('🧹 Cleaning up old environment...');
    
    const oldEnv = this.getCurrentActiveEnvironment();
    if (oldEnv && oldEnv.name !== this.activeDeployment?.targetEnvironment) {
      oldEnv.status = 'stopped';
      oldEnv.trafficWeight = 0;
      oldEnv.processId = undefined;
    }
    
    step.output = 'Cleanup completed';
    return true;
  }

  // === ロールバック ===
  async executeRollback(rollbackPlan: RollbackPlan): Promise<boolean> {
    console.log('🔄 Executing rollback plan...');
    
    for (const step of rollbackPlan.steps) {
      const success = await this.executeDeploymentStep(step);
      if (!success) {
        console.error(`❌ Rollback step failed: ${step.name}`);
        return false;
      }
    }
    
    console.log('✅ Rollback completed successfully');
    this.emit('rollbackCompleted', rollbackPlan);
    return true;
  }

  async rollbackToPreviousVersion(): Promise<boolean> {
    if (this.deploymentHistory.length === 0) {
      console.error('No previous deployments to rollback to');
      return false;
    }

    const previousDeployment = this.deploymentHistory[this.deploymentHistory.length - 1];
    console.log(`🔄 Rolling back to version: ${previousDeployment.version}`);

    // Switch traffic back to previous environment
    const targetEnv = previousDeployment.targetEnvironment === 'blue' ? 'green' : 'blue';
    
    this.loadBalancer.setTrafficSplit({
      blue: targetEnv === 'blue' ? 100 : 0,
      green: targetEnv === 'green' ? 100 : 0
    });

    await this.loadBalancer.updateLoadBalancerConfig();
    return true;
  }

  // === ユーティリティ ===
  private getCurrentActiveEnvironment(): Environment | null {
    for (const env of this.environments.values()) {
      if (env.trafficWeight > 50) {
        return env;
      }
    }
    return null;
  }

  private generateDeploymentId(): string {
    return `deploy-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private assessRiskLevel(config: DeploymentConfig): DeploymentPlan['riskLevel'] {
    let score = 0;
    
    if (config.databases && config.databases.length > 0) score += 2;
    if (config.strategy === 'blue_green') score += 1;
    if (config.strategy === 'rolling') score += 3;
    if (!config.rollbackOnFailure) score += 2;
    
    if (score <= 2) return 'low';
    if (score <= 4) return 'medium';
    return 'high';
  }

  private createDefaultRollbackPlan(): RollbackPlan {
    return {
      trigger: 'manual',
      steps: [],
      maxRollbackTime: 120000,
      preserveData: true
    };
  }

  private getInitialMetrics(): EnvironmentMetrics {
    return {
      requestCount: 0,
      errorCount: 0,
      avgResponseTime: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      connections: 0
    };
  }

  // === パブリック情報取得 ===
  getEnvironments(): Environment[] {
    return Array.from(this.environments.values());
  }

  getActiveDeployment(): DeploymentPlan | null {
    return this.activeDeployment;
  }

  getDeploymentHistory(): DeploymentPlan[] {
    return [...this.deploymentHistory];
  }

  getTrafficSplit(): TrafficSplitConfig {
    return this.loadBalancer.getTrafficSplit();
  }

  // === ダッシュボードデータ ===
  getDeploymentDashboard(): any {
    const activeEnv = this.getCurrentActiveEnvironment();
    const environments = this.getEnvironments();
    
    return {
      currentVersion: activeEnv?.version || 'unknown',
      activeEnvironment: activeEnv?.name || 'none',
      trafficSplit: this.getTrafficSplit(),
      environments: environments.map(env => ({
        name: env.name,
        status: env.status,
        version: env.version,
        healthScore: env.healthScore,
        trafficWeight: env.trafficWeight,
        uptime: env.startTime ? Date.now() - env.startTime : 0
      })),
      activeDeployment: this.activeDeployment,
      recentDeployments: this.deploymentHistory.slice(-5)
    };
  }

  // === 停止処理 ===
  async shutdown(): Promise<void> {
    this.healthChecker.stopHealthChecks();
    
    if (this.activeDeployment) {
      console.log('🛑 Stopping active deployment...');
      // In a real implementation, this would gracefully stop the deployment
    }
    
    console.log('🛑 Zero downtime deployment system shutdown');
  }
}

// === ヘルパークラス ===
export class DeploymentConfigHelper {
  static createBlueGreenConfig(
    appName: string,
    version: string,
    buildPath: string
  ): DeploymentConfig {
    return {
      strategy: 'blue_green',
      applicationName: appName,
      version,
      buildPath,
      healthCheckUrl: '/health',
      healthCheckTimeout: 30000,
      healthCheckRetries: 5,
      trafficSwitchDelay: 60,
      rollbackOnFailure: true,
      notifications: [
        {
          type: 'slack',
          target: '#deployments',
          events: ['deployment_start', 'deployment_success', 'deployment_failure', 'rollback']
        }
      ]
    };
  }

  static createCanaryConfig(
    appName: string,
    version: string,
    buildPath: string
  ): DeploymentConfig {
    return {
      strategy: 'canary',
      applicationName: appName,
      version,
      buildPath,
      healthCheckUrl: '/health',
      healthCheckTimeout: 15000,
      healthCheckRetries: 3,
      trafficSwitchDelay: 300, // 5 minutes for canary analysis
      rollbackOnFailure: true,
      notifications: [
        {
          type: 'email',
          target: 'ops@company.com',
          events: ['deployment_start', 'deployment_failure']
        }
      ]
    };
  }

  static formatDeploymentReport(plan: DeploymentPlan): string {
    const duration = plan.steps.reduce((sum, step) => {
      if (step.startTime && step.endTime) {
        return sum + (step.endTime - step.startTime);
      }
      return sum;
    }, 0);

    const completedSteps = plan.steps.filter(s => s.status === 'completed').length;
    const failedSteps = plan.steps.filter(s => s.status === 'failed').length;

    return [
      `=== Deployment Report ===`,
      `ID: ${plan.id}`,
      `Strategy: ${plan.strategy}`,
      `Version: ${plan.version}`,
      `Target: ${plan.targetEnvironment}`,
      `Duration: ${Math.round(duration / 1000)} seconds`,
      `Steps: ${completedSteps}/${plan.steps.length} completed`,
      `Failed Steps: ${failedSteps}`,
      `Risk Level: ${plan.riskLevel}`,
      ``,
      `Step Details:`,
      ...plan.steps.map(step => 
        `- ${step.name}: ${step.status} ${step.startTime && step.endTime ? 
          `(${step.endTime - step.startTime}ms)` : ''}`
      )
    ].join('\n');
  }
}

export default ZeroDowntimeDeployment;