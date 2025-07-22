/**
 * Intelligent Routing System
 * AIを活用した自動ルーティングと負荷分散
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { performance } from 'perf_hooks';

const logger = getLogger('IntelligentRoutingSystem');

// ルーティング戦略
export const RoutingStrategy = {
  ROUND_ROBIN: 'round_robin',
  LEAST_CONNECTIONS: 'least_connections',
  WEIGHTED_ROUND_ROBIN: 'weighted_round_robin',
  IP_HASH: 'ip_hash',
  LEAST_RESPONSE_TIME: 'least_response_time',
  ADAPTIVE: 'adaptive',
  GEOGRAPHIC: 'geographic',
  COST_OPTIMIZED: 'cost_optimized',
  PERFORMANCE_OPTIMIZED: 'performance_optimized'
};

// エンドポイントタイプ
export const EndpointType = {
  API: 'api',
  WEBSOCKET: 'websocket',
  GRPC: 'grpc',
  DATABASE: 'database',
  CACHE: 'cache',
  MINING_POOL: 'mining_pool',
  DEX: 'dex'
};

export class IntelligentRoutingSystem extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    this.options = {
      strategy: options.strategy || RoutingStrategy.ADAPTIVE,
      enableHealthChecks: options.enableHealthChecks !== false,
      healthCheckInterval: options.healthCheckInterval || 5000,
      enableLoadBalancing: options.enableLoadBalancing !== false,
      enableAutoScaling: options.enableAutoScaling !== false,
      
      // AI設定
      enableAI: options.enableAI !== false,
      learningRate: options.learningRate || 0.01,
      predictionWindow: options.predictionWindow || 300000, // 5分
      
      // パフォーマンス設定
      maxLatency: options.maxLatency || 100, // ms
      maxErrorRate: options.maxErrorRate || 0.01,
      
      // 地理的ルーティング
      enableGeographicRouting: options.enableGeographicRouting !== false,
      preferredRegions: options.preferredRegions || [],
      
      ...options
    };
    
    // エンドポイント管理
    this.endpoints = new Map();
    this.endpointStats = new Map();
    this.routingTable = new Map();
    
    // AI関連
    this.routingModel = null;
    this.trainingData = [];
    
    // メトリクス
    this.metrics = {
      totalRequests: 0,
      routedRequests: 0,
      failedRequests: 0,
      averageLatency: 0,
      routingDecisions: {}
    };
    
    this.initialize();
  }
  
  async initialize() {
    // ヘルスチェックを開始
    if (this.options.enableHealthChecks) {
      this.startHealthChecks();
    }
    
    // AIモデルを初期化
    if (this.options.enableAI) {
      await this.initializeAIModel();
    }
    
    // ルーティングテーブルを初期化
    this.initializeRoutingTable();
    
    this.logger.info('Intelligent routing system initialized');
  }
  
  /**
   * エンドポイントを登録
   */
  registerEndpoint(id, config) {
    const endpoint = {
      id,
      type: config.type || EndpointType.API,
      url: config.url,
      region: config.region,
      capacity: config.capacity || 100,
      priority: config.priority || 1,
      weight: config.weight || 1,
      metadata: config.metadata || {},
      status: 'active',
      health: {
        healthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0
      },
      stats: {
        requests: 0,
        errors: 0,
        totalLatency: 0,
        averageLatency: 0
      }
    };
    
    this.endpoints.set(id, endpoint);
    this.updateRoutingTable();
    
    this.logger.info(`Registered endpoint: ${id}`, endpoint);
    this.emit('endpoint:registered', { id, endpoint });
  }
  
  /**
   * ルートリクエスト
   */
  async route(request) {
    this.metrics.totalRequests++;
    
    try {
      // 最適なエンドポイントを選択
      const endpoint = await this.selectEndpoint(request);
      
      if (!endpoint) {
        throw new Error('No available endpoints');
      }
      
      // リクエストを記録
      this.recordRequest(endpoint, request);
      
      // ルーティング結果を返す
      const result = {
        endpoint: endpoint.id,
        url: endpoint.url,
        metadata: endpoint.metadata
      };
      
      this.metrics.routedRequests++;
      this.emit('request:routed', { request, endpoint: endpoint.id });
      
      return result;
      
    } catch (error) {
      this.metrics.failedRequests++;
      this.logger.error('Routing failed', error);
      throw error;
    }
  }
  
  /**
   * 最適なエンドポイントを選択
   */
  async selectEndpoint(request) {
    const availableEndpoints = this.getAvailableEndpoints(request.type);
    
    if (availableEndpoints.length === 0) {
      return null;
    }
    
    // AI予測を使用
    if (this.options.enableAI && this.routingModel) {
      return await this.selectEndpointWithAI(request, availableEndpoints);
    }
    
    // 戦略に基づいて選択
    switch (this.options.strategy) {
      case RoutingStrategy.ROUND_ROBIN:
        return this.roundRobinSelection(availableEndpoints);
        
      case RoutingStrategy.LEAST_CONNECTIONS:
        return this.leastConnectionsSelection(availableEndpoints);
        
      case RoutingStrategy.WEIGHTED_ROUND_ROBIN:
        return this.weightedRoundRobinSelection(availableEndpoints);
        
      case RoutingStrategy.LEAST_RESPONSE_TIME:
        return this.leastResponseTimeSelection(availableEndpoints);
        
      case RoutingStrategy.GEOGRAPHIC:
        return this.geographicSelection(request, availableEndpoints);
        
      case RoutingStrategy.ADAPTIVE:
      default:
        return this.adaptiveSelection(request, availableEndpoints);
    }
  }
  
  /**
   * 利用可能なエンドポイントを取得
   */
  getAvailableEndpoints(type) {
    return Array.from(this.endpoints.values()).filter(endpoint => 
      endpoint.status === 'active' &&
      endpoint.health.healthy &&
      (!type || endpoint.type === type)
    );
  }
  
  /**
   * ラウンドロビン選択
   */
  roundRobinSelection(endpoints) {
    if (!this.roundRobinIndex) {
      this.roundRobinIndex = 0;
    }
    
    const endpoint = endpoints[this.roundRobinIndex % endpoints.length];
    this.roundRobinIndex++;
    
    return endpoint;
  }
  
  /**
   * 最小接続数選択
   */
  leastConnectionsSelection(endpoints) {
    return endpoints.reduce((min, endpoint) => 
      endpoint.stats.requests < min.stats.requests ? endpoint : min
    );
  }
  
  /**
   * 重み付きラウンドロビン選択
   */
  weightedRoundRobinSelection(endpoints) {
    const totalWeight = endpoints.reduce((sum, e) => sum + e.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const endpoint of endpoints) {
      random -= endpoint.weight;
      if (random <= 0) {
        return endpoint;
      }
    }
    
    return endpoints[0];
  }
  
  /**
   * 最小レスポンスタイム選択
   */
  leastResponseTimeSelection(endpoints) {
    return endpoints.reduce((min, endpoint) => 
      endpoint.stats.averageLatency < min.stats.averageLatency ? endpoint : min
    );
  }
  
  /**
   * 地理的選択
   */
  geographicSelection(request, endpoints) {
    const userRegion = request.region || this.detectRegion(request);
    
    // 同じリージョンのエンドポイントを優先
    const regionalEndpoints = endpoints.filter(e => e.region === userRegion);
    
    if (regionalEndpoints.length > 0) {
      return this.leastResponseTimeSelection(regionalEndpoints);
    }
    
    // 最も近いリージョンを選択
    return this.findNearestEndpoint(userRegion, endpoints);
  }
  
  /**
   * 適応的選択
   */
  adaptiveSelection(request, endpoints) {
    // スコアリングベースの選択
    const scores = endpoints.map(endpoint => ({
      endpoint,
      score: this.calculateEndpointScore(endpoint, request)
    }));
    
    // 最高スコアのエンドポイントを選択
    scores.sort((a, b) => b.score - a.score);
    
    return scores[0].endpoint;
  }
  
  /**
   * エンドポイントスコアを計算
   */
  calculateEndpointScore(endpoint, request) {
    let score = 100;
    
    // レイテンシーペナルティ
    score -= Math.min(50, endpoint.stats.averageLatency / 10);
    
    // エラー率ペナルティ
    const errorRate = endpoint.stats.errors / Math.max(1, endpoint.stats.requests);
    score -= errorRate * 100;
    
    // 容量ボーナス
    const utilizationRate = endpoint.stats.requests / endpoint.capacity;
    score += (1 - utilizationRate) * 20;
    
    // 優先度ボーナス
    score += endpoint.priority * 10;
    
    // リージョンマッチボーナス
    if (request.region && endpoint.region === request.region) {
      score += 30;
    }
    
    return Math.max(0, score);
  }
  
  /**
   * AIを使用してエンドポイントを選択
   */
  async selectEndpointWithAI(request, endpoints) {
    // 特徴量を準備
    const features = this.prepareFeatures(request, endpoints);
    
    // 予測を実行
    const predictions = await this.routingModel.predict(features);
    
    // 最適なエンドポイントを選択
    const bestIndex = predictions.indexOf(Math.max(...predictions));
    
    return endpoints[bestIndex];
  }
  
  /**
   * ヘルスチェックを開始
   */
  startHealthChecks() {
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.options.healthCheckInterval);
  }
  
  /**
   * ヘルスチェックを実行
   */
  async performHealthChecks() {
    const checks = Array.from(this.endpoints.values()).map(async endpoint => {
      try {
        const startTime = performance.now();
        
        // 実際のヘルスチェック実装
        const healthy = await this.checkEndpointHealth(endpoint);
        
        const latency = performance.now() - startTime;
        
        // ヘルス状態を更新
        endpoint.health.healthy = healthy;
        endpoint.health.lastCheck = Date.now();
        
        if (!healthy) {
          endpoint.health.consecutiveFailures++;
          
          // 連続失敗しきい値を超えたら無効化
          if (endpoint.health.consecutiveFailures >= 3) {
            endpoint.status = 'inactive';
            this.emit('endpoint:unhealthy', { id: endpoint.id });
          }
        } else {
          endpoint.health.consecutiveFailures = 0;
          
          // 無効化されていたエンドポイントを復活
          if (endpoint.status === 'inactive') {
            endpoint.status = 'active';
            this.emit('endpoint:recovered', { id: endpoint.id });
          }
        }
        
        // レイテンシーを記録
        this.updateEndpointLatency(endpoint, latency);
        
      } catch (error) {
        this.logger.error(`Health check failed for ${endpoint.id}`, error);
        endpoint.health.healthy = false;
      }
    });
    
    await Promise.all(checks);
    this.updateRoutingTable();
  }
  
  /**
   * エンドポイントのヘルスをチェック
   */
  async checkEndpointHealth(endpoint) {
    // 実際のヘルスチェック実装（HTTPリクエストなど）
    // デモ用の簡単な実装
    return Math.random() > 0.05; // 95%の確率で健康
  }
  
  /**
   * リクエストを記録
   */
  recordRequest(endpoint, request) {
    endpoint.stats.requests++;
    
    // リクエスト情報を学習データに追加
    if (this.options.enableAI) {
      this.trainingData.push({
        timestamp: Date.now(),
        request,
        endpoint: endpoint.id,
        features: this.extractRequestFeatures(request)
      });
      
      // 学習データを制限
      if (this.trainingData.length > 10000) {
        this.trainingData = this.trainingData.slice(-5000);
      }
    }
  }
  
  /**
   * エンドポイントのレイテンシーを更新
   */
  updateEndpointLatency(endpoint, latency) {
    endpoint.stats.totalLatency += latency;
    endpoint.stats.averageLatency = 
      endpoint.stats.totalLatency / Math.max(1, endpoint.stats.requests);
  }
  
  /**
   * ルーティングテーブルを更新
   */
  updateRoutingTable() {
    // ルーティングテーブルを再構築
    this.routingTable.clear();
    
    for (const [id, endpoint] of this.endpoints) {
      if (endpoint.status === 'active' && endpoint.health.healthy) {
        const key = `${endpoint.type}:${endpoint.region || 'global'}`;
        
        if (!this.routingTable.has(key)) {
          this.routingTable.set(key, []);
        }
        
        this.routingTable.get(key).push(endpoint);
      }
    }
  }
  
  /**
   * AIモデルを初期化
   */
  async initializeAIModel() {
    // 実際のAIモデル実装
    this.routingModel = {
      predict: async (features) => {
        // デモ用の簡単な予測
        return features.map(() => Math.random());
      }
    };
  }
  
  /**
   * リージョンを検出
   */
  detectRegion(request) {
    // IPアドレスやヘッダーからリージョンを検出
    return request.headers?.['cf-ipcountry'] || 'us-east-1';
  }
  
  /**
   * 最も近いエンドポイントを見つける
   */
  findNearestEndpoint(userRegion, endpoints) {
    // 地理的距離に基づいて最も近いエンドポイントを選択
    // 簡略化された実装
    return endpoints[0];
  }
  
  /**
   * リクエスト特徴量を抽出
   */
  extractRequestFeatures(request) {
    return {
      type: request.type,
      region: request.region,
      priority: request.priority || 0,
      size: request.size || 0,
      timestamp: Date.now()
    };
  }
  
  /**
   * 特徴量を準備
   */
  prepareFeatures(request, endpoints) {
    // AI予測用の特徴量を準備
    return endpoints.map(endpoint => [
      endpoint.stats.averageLatency,
      endpoint.stats.requests,
      endpoint.stats.errors,
      endpoint.weight,
      endpoint.priority,
      request.region === endpoint.region ? 1 : 0
    ]);
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    return {
      ...this.metrics,
      endpoints: Array.from(this.endpoints.values()).map(e => ({
        id: e.id,
        status: e.status,
        health: e.health.healthy,
        stats: e.stats
      })),
      routingTable: Object.fromEntries(this.routingTable)
    };
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    this.endpoints.clear();
    this.routingTable.clear();
    this.trainingData = [];
  }
}

export default IntelligentRoutingSystem;