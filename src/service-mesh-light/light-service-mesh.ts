/**
 * 軽量サービスメッシュ
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - サービス発見
 * - ロードバランシング
 * - サーキットブレーカー
 * - リトライメカニズム
 * - ヘルスチェック
 * - メトリクス収集
 */

import { EventEmitter } from 'events';

// === 型定義 ===
interface ServiceInstance {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'tcp';
  weight: number;
  metadata: Record<string, any>;
  status: 'healthy' | 'unhealthy' | 'draining';
  lastHealthCheck: number;
  version?: string;
}

interface ServiceConfig {
  name: string;
  loadBalancer: 'round_robin' | 'least_connections' | 'weighted_round_robin' | 'random';
  healthCheck: HealthCheckConfig;
  circuitBreaker: CircuitBreakerConfig;
  retry: RetryConfig;
  timeout: number;
}

interface HealthCheckConfig {
  enabled: boolean;
  interval: number; // milliseconds
  timeout: number;
  path?: string; // for HTTP health checks
  expectedStatus?: number;
  unhealthyThreshold: number;
  healthyThreshold: number;
}

interface CircuitBreakerConfig {
  enabled: boolean;
  failureThreshold: number; // number of failures
  timeWindow: number; // milliseconds
  openTimeout: number; // milliseconds before attempting to close
  halfOpenMaxCalls: number; // max calls in half-open state
}

interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;
  baseDelay: number; // milliseconds
  maxDelay: number;
  exponentialBackoff: boolean;
  retryableErrors: string[];
}

interface ServiceMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  p95Latency: number;
  p99Latency: number;
  circuitBreakerState: 'closed' | 'open' | 'half-open';
  lastUpdated: number;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
  retries?: number;
}

interface LoadBalancerContext {
  instances: ServiceInstance[];
  request: any;
}

// === サーキットブレーカー実装 ===
class CircuitBreaker extends EventEmitter {
  private config: CircuitBreakerConfig;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private halfOpenCalls: number = 0;

  constructor(config: CircuitBreakerConfig) {
    super();
    this.config = config;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return await fn();
    }

    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime < this.config.openTimeout) {
        throw new Error('Circuit breaker is open');
      }
      this.state = 'half-open';
      this.halfOpenCalls = 0;
      this.emit('stateChanged', 'half-open');
    }

    if (this.state === 'half-open' && this.halfOpenCalls >= this.config.halfOpenMaxCalls) {
      throw new Error('Circuit breaker is half-open with max calls reached');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = 0;
      this.emit('stateChanged', 'closed');
    }
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      this.halfOpenCalls++;
    }

    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      this.emit('stateChanged', 'open');
    }
  }

  getState(): string {
    return this.state;
  }

  getMetrics() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
      halfOpenCalls: this.halfOpenCalls
    };
  }
}

// === ロードバランサー実装 ===
abstract class LoadBalancer {
  protected instances: ServiceInstance[] = [];
  protected connectionCounts = new Map<string, number>();

  abstract selectInstance(context: LoadBalancerContext): ServiceInstance | null;

  updateInstances(instances: ServiceInstance[]): void {
    this.instances = instances.filter(i => i.status === 'healthy');
  }

  protected getHealthyInstances(): ServiceInstance[] {
    return this.instances.filter(i => i.status === 'healthy');
  }
}

class RoundRobinBalancer extends LoadBalancer {
  private currentIndex = 0;

  selectInstance(): ServiceInstance | null {
    const healthy = this.getHealthyInstances();
    if (healthy.length === 0) return null;

    const instance = healthy[this.currentIndex % healthy.length];
    this.currentIndex = (this.currentIndex + 1) % healthy.length;
    return instance;
  }
}

class WeightedRoundRobinBalancer extends LoadBalancer {
  private weightedList: ServiceInstance[] = [];
  private currentIndex = 0;

  updateInstances(instances: ServiceInstance[]): void {
    super.updateInstances(instances);
    this.rebuildWeightedList();
  }

  private rebuildWeightedList(): void {
    this.weightedList = [];
    for (const instance of this.getHealthyInstances()) {
      for (let i = 0; i < instance.weight; i++) {
        this.weightedList.push(instance);
      }
    }
    this.currentIndex = 0;
  }

  selectInstance(): ServiceInstance | null {
    if (this.weightedList.length === 0) return null;

    const instance = this.weightedList[this.currentIndex % this.weightedList.length];
    this.currentIndex = (this.currentIndex + 1) % this.weightedList.length;
    return instance;
  }
}

class LeastConnectionsBalancer extends LoadBalancer {
  selectInstance(): ServiceInstance | null {
    const healthy = this.getHealthyInstances();
    if (healthy.length === 0) return null;

    return healthy.reduce((least, current) => {
      const leastConnections = this.connectionCounts.get(least.id) || 0;
      const currentConnections = this.connectionCounts.get(current.id) || 0;
      return currentConnections < leastConnections ? current : least;
    });
  }

  recordConnection(instanceId: string): void {
    const current = this.connectionCounts.get(instanceId) || 0;
    this.connectionCounts.set(instanceId, current + 1);
  }

  recordDisconnection(instanceId: string): void {
    const current = this.connectionCounts.get(instanceId) || 0;
    this.connectionCounts.set(instanceId, Math.max(0, current - 1));
  }
}

class RandomBalancer extends LoadBalancer {
  selectInstance(): ServiceInstance | null {
    const healthy = this.getHealthyInstances();
    if (healthy.length === 0) return null;

    const randomIndex = Math.floor(Math.random() * healthy.length);
    return healthy[randomIndex];
  }
}

// === ロードバランサーファクトリー ===
class LoadBalancerFactory {
  static create(type: string): LoadBalancer {
    switch (type) {
      case 'round_robin':
        return new RoundRobinBalancer();
      case 'weighted_round_robin':
        return new WeightedRoundRobinBalancer();
      case 'least_connections':
        return new LeastConnectionsBalancer();
      case 'random':
        return new RandomBalancer();
      default:
        throw new Error(`Unknown load balancer type: ${type}`);
    }
  }
}

// === リトライ機能 ===
class RetryManager {
  private config: RetryConfig;

  constructor(config: RetryConfig) {
    this.config = config;
  }

  async execute<T>(fn: () => Promise<T>, context?: any): Promise<T> {
    if (!this.config.enabled) {
      return await fn();
    }

    let lastError: Error;
    
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        
        // 最後の試行の場合はエラーを投げる
        if (attempt === this.config.maxAttempts) {
          break;
        }

        // リトライ可能なエラーかチェック
        if (!this.isRetryableError(error as Error)) {
          break;
        }

        // 待機時間計算
        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    throw lastError!;
  }

  private isRetryableError(error: Error): boolean {
    if (this.config.retryableErrors.length === 0) {
      return true; // デフォルトで全エラーをリトライ可能とする
    }

    return this.config.retryableErrors.some(pattern => 
      error.message.includes(pattern)
    );
  }

  private calculateDelay(attempt: number): number {
    if (!this.config.exponentialBackoff) {
      return this.config.baseDelay;
    }

    const exponentialDelay = this.config.baseDelay * Math.pow(2, attempt - 1);
    return Math.min(exponentialDelay, this.config.maxDelay);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// === ヘルスチェッカー ===
class HealthChecker extends EventEmitter {
  private config: HealthCheckConfig;
  private instances = new Map<string, ServiceInstance>();
  private healthStates = new Map<string, { failures: number; successes: number }>();
  private checkTimer?: NodeJS.Timeout;

  constructor(config: HealthCheckConfig) {
    super();
    this.config = config;
  }

  start(): void {
    if (this.config.enabled && !this.checkTimer) {
      this.checkTimer = setInterval(() => {
        this.performHealthChecks();
      }, this.config.interval);
    }
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  addInstance(instance: ServiceInstance): void {
    this.instances.set(instance.id, instance);
    this.healthStates.set(instance.id, { failures: 0, successes: 0 });
  }

  removeInstance(instanceId: string): void {
    this.instances.delete(instanceId);
    this.healthStates.delete(instanceId);
  }

  private async performHealthChecks(): Promise<void> {
    const checkPromises = Array.from(this.instances.values()).map(instance => 
      this.checkInstance(instance)
    );

    await Promise.allSettled(checkPromises);
  }

  private async checkInstance(instance: ServiceInstance): Promise<void> {
    try {
      const isHealthy = await this.performHealthCheck(instance);
      this.updateInstanceHealth(instance, isHealthy);
    } catch (error) {
      this.updateInstanceHealth(instance, false);
    }
  }

  private async performHealthCheck(instance: ServiceInstance): Promise<boolean> {
    if (instance.protocol === 'tcp') {
      return await this.tcpHealthCheck(instance);
    } else {
      return await this.httpHealthCheck(instance);
    }
  }

  private async tcpHealthCheck(instance: ServiceInstance): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, this.config.timeout);

      socket.connect(instance.port, instance.host, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  private async httpHealthCheck(instance: ServiceInstance): Promise<boolean> {
    try {
      const url = `${instance.protocol}://${instance.host}:${instance.port}${this.config.path || '/health'}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        method: 'GET'
      });

      clearTimeout(timeoutId);

      const expectedStatus = this.config.expectedStatus || 200;
      return response.status === expectedStatus;
    } catch (error) {
      return false;
    }
  }

  private updateInstanceHealth(instance: ServiceInstance, isHealthy: boolean): void {
    const state = this.healthStates.get(instance.id);
    if (!state) return;

    if (isHealthy) {
      state.successes++;
      state.failures = 0;

      if (instance.status !== 'healthy' && state.successes >= this.config.healthyThreshold) {
        instance.status = 'healthy';
        instance.lastHealthCheck = Date.now();
        this.emit('instanceHealthy', instance);
      }
    } else {
      state.failures++;
      state.successes = 0;

      if (instance.status === 'healthy' && state.failures >= this.config.unhealthyThreshold) {
        instance.status = 'unhealthy';
        instance.lastHealthCheck = Date.now();
        this.emit('instanceUnhealthy', instance);
      }
    }
  }
}

// === メトリクス収集 ===
class ServiceMetricsCollector {
  private metrics = new Map<string, ServiceMetrics>();
  private latencyHistogram = new Map<string, number[]>();

  recordRequest(serviceName: string, latency: number, success: boolean): void {
    let serviceMetrics = this.metrics.get(serviceName);
    
    if (!serviceMetrics) {
      serviceMetrics = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageLatency: 0,
        p95Latency: 0,
        p99Latency: 0,
        circuitBreakerState: 'closed',
        lastUpdated: Date.now()
      };
      this.metrics.set(serviceName, serviceMetrics);
    }

    // リクエスト統計更新
    serviceMetrics.totalRequests++;
    if (success) {
      serviceMetrics.successfulRequests++;
    } else {
      serviceMetrics.failedRequests++;
    }

    // レイテンシ統計更新
    this.updateLatencyMetrics(serviceName, latency);
    serviceMetrics.lastUpdated = Date.now();
  }

  private updateLatencyMetrics(serviceName: string, latency: number): void {
    if (!this.latencyHistogram.has(serviceName)) {
      this.latencyHistogram.set(serviceName, []);
    }

    const histogram = this.latencyHistogram.get(serviceName)!;
    histogram.push(latency);

    // ヒストグラムサイズ制限（最新1000件）
    if (histogram.length > 1000) {
      histogram.shift();
    }

    // 統計計算
    const metrics = this.metrics.get(serviceName)!;
    metrics.averageLatency = histogram.reduce((sum, l) => sum + l, 0) / histogram.length;
    
    const sorted = [...histogram].sort((a, b) => a - b);
    metrics.p95Latency = sorted[Math.floor(sorted.length * 0.95)] || 0;
    metrics.p99Latency = sorted[Math.floor(sorted.length * 0.99)] || 0;
  }

  updateCircuitBreakerState(serviceName: string, state: string): void {
    const metrics = this.metrics.get(serviceName);
    if (metrics) {
      metrics.circuitBreakerState = state as any;
    }
  }

  getMetrics(serviceName: string): ServiceMetrics | null {
    return this.metrics.get(serviceName) || null;
  }

  getAllMetrics(): Map<string, ServiceMetrics> {
    return new Map(this.metrics);
  }

  resetMetrics(serviceName?: string): void {
    if (serviceName) {
      this.metrics.delete(serviceName);
      this.latencyHistogram.delete(serviceName);
    } else {
      this.metrics.clear();
      this.latencyHistogram.clear();
    }
  }
}

// === メインサービスメッシュクラス ===
class LightServiceMesh extends EventEmitter {
  private services = new Map<string, ServiceConfig>();
  private instances = new Map<string, ServiceInstance[]>();
  private loadBalancers = new Map<string, LoadBalancer>();
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private retryManagers = new Map<string, RetryManager>();
  private healthChecker: HealthChecker;
  private metricsCollector = new ServiceMetricsCollector();
  private logger: any;

  constructor(logger?: any) {
    super();
    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[INFO] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[ERROR] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[WARN] ${msg}`, data || '')
    };

    // デフォルトヘルスチェッカー
    this.healthChecker = new HealthChecker({
      enabled: true,
      interval: 30000,
      timeout: 5000,
      unhealthyThreshold: 3,
      healthyThreshold: 2
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.healthChecker.on('instanceHealthy', (instance) => {
      this.logger.info(`Instance became healthy: ${instance.id}`);
      this.emit('instanceHealthy', instance);
    });

    this.healthChecker.on('instanceUnhealthy', (instance) => {
      this.logger.warn(`Instance became unhealthy: ${instance.id}`);
      this.emit('instanceUnhealthy', instance);
    });
  }

  registerService(config: ServiceConfig): void {
    this.services.set(config.name, config);
    this.instances.set(config.name, []);
    
    // ロードバランサー作成
    const loadBalancer = LoadBalancerFactory.create(config.loadBalancer);
    this.loadBalancers.set(config.name, loadBalancer);
    
    // サーキットブレーカー作成
    const circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    this.circuitBreakers.set(config.name, circuitBreaker);
    
    // リトライマネージャー作成
    const retryManager = new RetryManager(config.retry);
    this.retryManagers.set(config.name, retryManager);

    // サーキットブレーカーイベント
    circuitBreaker.on('stateChanged', (state) => {
      this.metricsCollector.updateCircuitBreakerState(config.name, state);
      this.emit('circuitBreakerStateChanged', { service: config.name, state });
    });

    this.logger.info(`Service registered: ${config.name}`);
  }

  addServiceInstance(serviceName: string, instance: ServiceInstance): void {
    const instances = this.instances.get(serviceName);
    if (!instances) {
      throw new Error(`Service not found: ${serviceName}`);
    }

    // 重複チェック
    const existing = instances.find(i => i.id === instance.id);
    if (existing) {
      throw new Error(`Instance already exists: ${instance.id}`);
    }

    instances.push(instance);
    
    // ロードバランサー更新
    const loadBalancer = this.loadBalancers.get(serviceName);
    if (loadBalancer) {
      loadBalancer.updateInstances(instances);
    }

    // ヘルスチェッカーに追加
    this.healthChecker.addInstance(instance);

    this.logger.info(`Instance added to ${serviceName}: ${instance.id}`);
    this.emit('instanceAdded', { serviceName, instance });
  }

  removeServiceInstance(serviceName: string, instanceId: string): boolean {
    const instances = this.instances.get(serviceName);
    if (!instances) return false;

    const index = instances.findIndex(i => i.id === instanceId);
    if (index === -1) return false;

    instances.splice(index, 1);
    
    // ロードバランサー更新
    const loadBalancer = this.loadBalancers.get(serviceName);
    if (loadBalancer) {
      loadBalancer.updateInstances(instances);
    }

    // ヘルスチェッカーから削除
    this.healthChecker.removeInstance(instanceId);

    this.logger.info(`Instance removed from ${serviceName}: ${instanceId}`);
    this.emit('instanceRemoved', { serviceName, instanceId });
    return true;
  }

  async callService<T>(serviceName: string, options: RequestOptions = {}): Promise<T> {
    const config = this.services.get(serviceName);
    if (!config) {
      throw new Error(`Service not found: ${serviceName}`);
    }

    const loadBalancer = this.loadBalancers.get(serviceName);
    const circuitBreaker = this.circuitBreakers.get(serviceName);
    const retryManager = this.retryManagers.get(serviceName);

    if (!loadBalancer || !circuitBreaker || !retryManager) {
      throw new Error(`Service components not initialized: ${serviceName}`);
    }

    const startTime = Date.now();

    try {
      return await retryManager.execute(async () => {
        return await circuitBreaker.execute(async () => {
          // インスタンス選択
          const instance = loadBalancer.selectInstance({
            instances: this.instances.get(serviceName) || [],
            request: options
          });

          if (!instance) {
            throw new Error(`No healthy instances available for service: ${serviceName}`);
          }

          // リクエスト実行
          const result = await this.executeRequest<T>(instance, options, config.timeout);
          
          // 成功メトリクス記録
          const latency = Date.now() - startTime;
          this.metricsCollector.recordRequest(serviceName, latency, true);
          
          return result;
        });
      });
    } catch (error) {
      // 失敗メトリクス記録
      const latency = Date.now() - startTime;
      this.metricsCollector.recordRequest(serviceName, latency, false);
      throw error;
    }
  }

  private async executeRequest<T>(
    instance: ServiceInstance, 
    options: RequestOptions, 
    defaultTimeout: number
  ): Promise<T> {
    const url = `${instance.protocol}://${instance.host}:${instance.port}`;
    const timeout = options.timeout || defaultTimeout;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  getServiceMetrics(serviceName: string): ServiceMetrics | null {
    return this.metricsCollector.getMetrics(serviceName);
  }

  getAllMetrics(): Map<string, ServiceMetrics> {
    return this.metricsCollector.getAllMetrics();
  }

  getServiceInstances(serviceName: string): ServiceInstance[] {
    return this.instances.get(serviceName) || [];
  }

  getServices(): string[] {
    return Array.from(this.services.keys());
  }

  start(): void {
    this.healthChecker.start();
    this.logger.info('Service mesh started');
  }

  stop(): void {
    this.healthChecker.stop();
    this.logger.info('Service mesh stopped');
  }

  getStats() {
    const services = Array.from(this.services.keys());
    const totalInstances = Array.from(this.instances.values())
      .reduce((sum, instances) => sum + instances.length, 0);
    const healthyInstances = Array.from(this.instances.values())
      .reduce((sum, instances) => sum + instances.filter(i => i.status === 'healthy').length, 0);

    return {
      services: services.length,
      totalInstances,
      healthyInstances,
      unhealthyInstances: totalInstances - healthyInstances,
      registeredServices: services
    };
  }
}

export {
  LightServiceMesh,
  ServiceInstance,
  ServiceConfig,
  HealthCheckConfig,
  CircuitBreakerConfig,
  RetryConfig,
  ServiceMetrics,
  RequestOptions
};