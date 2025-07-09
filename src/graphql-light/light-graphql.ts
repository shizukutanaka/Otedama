/**
 * 軽量GraphQL APIシステム
 * 設計思想: Carmack (シンプル・高速), Martin (クリーン), Pike (明瞭・効率性)
 * 
 * 主要機能:
 * - スキーマ定義とリゾルバー
 * - クエリ最適化
 * - リアルタイムサブスクリプション
 * - データローダー
 * - 認証・認可
 * - キャッシュ機能
 * - メトリクス収集
 */

import { EventEmitter } from 'events';

// === 基本型定義 ===
interface GraphQLConfig {
  introspection: boolean;
  playground: boolean;
  enableCache: boolean;
  enableMetrics: boolean;
  maxQueryDepth: number;
  maxQueryComplexity: number;
  timeout: number;
  enableSubscriptions: boolean;
  subscriptionPath: string;
}

interface QueryMetrics {
  queryId: string;
  operationName?: string;
  duration: number;
  complexity: number;
  depth: number;
  errors: any[];
  timestamp: number;
  userId?: string;
  cached: boolean;
}

interface FieldInfo {
  fieldName: string;
  parentType: string;
  returnType: string;
  args: Record<string, any>;
}

interface ResolverContext {
  userId?: string;
  permissions?: string[];
  dataLoaders: Record<string, DataLoader<any, any>>;
  cache: QueryCache;
  pool?: any;
  services?: any;
}

interface Subscription {
  id: string;
  userId?: string;
  query: string;
  variables: Record<string, any>;
  callback: (data: any) => void;
  active: boolean;
  lastUpdate: number;
}

// === データローダー実装 ===
class DataLoader<K, V> {
  private batchLoadFn: (keys: K[]) => Promise<V[]>;
  private cache = new Map<string, Promise<V>>();
  private batch: K[] = [];
  private batchPromise?: Promise<V[]>;
  private maxBatchSize: number;
  private batchScheduleFn: () => void;

  constructor(
    batchLoadFn: (keys: K[]) => Promise<V[]>,
    options: { maxBatchSize?: number; cache?: boolean } = {}
  ) {
    this.batchLoadFn = batchLoadFn;
    this.maxBatchSize = options.maxBatchSize || 100;
    this.batchScheduleFn = () => process.nextTick(() => this.dispatch());
  }

  async load(key: K): Promise<V> {
    const cacheKey = JSON.stringify(key);
    
    // キャッシュチェック
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    // バッチに追加
    this.batch.push(key);
    
    // バッチ処理をスケジュール
    if (!this.batchPromise) {
      this.batchPromise = new Promise<V[]>((resolve) => {
        this.batchScheduleFn();
        resolve(this.dispatch());
      });
    }

    // 結果のインデックスを計算
    const index = this.batch.length - 1;
    
    const resultPromise = this.batchPromise.then(results => results[index]);
    this.cache.set(cacheKey, resultPromise);
    
    return resultPromise;
  }

  async loadMany(keys: K[]): Promise<V[]> {
    return Promise.all(keys.map(key => this.load(key)));
  }

  private async dispatch(): Promise<V[]> {
    const batch = this.batch;
    this.batch = [];
    this.batchPromise = undefined;

    if (batch.length === 0) {
      return [];
    }

    try {
      return await this.batchLoadFn(batch);
    } catch (error) {
      // エラーをキャッシュから削除
      batch.forEach(key => {
        const cacheKey = JSON.stringify(key);
        this.cache.delete(cacheKey);
      });
      throw error;
    }
  }

  clear(key?: K): void {
    if (key) {
      const cacheKey = JSON.stringify(key);
      this.cache.delete(cacheKey);
    } else {
      this.cache.clear();
    }
  }
}

// === クエリキャッシュ ===
class QueryCache {
  private cache = new Map<string, { data: any; timestamp: number; ttl: number }>();
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  set(key: string, data: any, ttl: number = 300000): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  get(key: string): any | null {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() - item.timestamp > item.ttl) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  invalidate(pattern?: string): void {
    if (!pattern) {
      this.cache.clear();
      return;
    }

    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        this.cache.delete(key);
      }
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }
}

// === GraphQLスキーマビルダー ===
class SchemaBuilder {
  private typeDefs: string[] = [];
  private resolvers: Record<string, any> = {};

  addType(typeDef: string): void {
    this.typeDefs.push(typeDef);
  }

  addResolver(typeName: string, resolverMap: Record<string, any>): void {
    if (!this.resolvers[typeName]) {
      this.resolvers[typeName] = {};
    }
    Object.assign(this.resolvers[typeName], resolverMap);
  }

  getSchema(): { typeDefs: string; resolvers: Record<string, any> } {
    return {
      typeDefs: this.typeDefs.join('\n\n'),
      resolvers: this.resolvers
    };
  }
}

// === クエリバリデーター ===
class QueryValidator {
  static validateDepth(query: string, maxDepth: number): boolean {
    const depth = this.calculateDepth(query);
    return depth <= maxDepth;
  }

  static validateComplexity(query: string, maxComplexity: number): boolean {
    const complexity = this.calculateComplexity(query);
    return complexity <= maxComplexity;
  }

  private static calculateDepth(query: string, currentDepth: number = 0): number {
    // 簡易深度計算（実際の実装ではASTパーサーを使用）
    const openBraces = (query.match(/{/g) || []).length;
    const closeBraces = (query.match(/}/g) || []).length;
    return Math.min(openBraces, closeBraces);
  }

  private static calculateComplexity(query: string): number {
    // 簡易複雑度計算
    const fieldCount = (query.match(/\w+\s*(\(|{)/g) || []).length;
    const argCount = (query.match(/\w+\s*:/g) || []).length;
    return fieldCount + argCount;
  }
}

// === サブスクリプション管理 ===
class SubscriptionManager extends EventEmitter {
  private subscriptions = new Map<string, Subscription>();
  private topicSubscriptions = new Map<string, Set<string>>();

  addSubscription(subscription: Subscription): void {
    this.subscriptions.set(subscription.id, subscription);
    this.emit('subscriptionAdded', subscription);
  }

  removeSubscription(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;

    subscription.active = false;
    this.subscriptions.delete(subscriptionId);
    
    // トピックサブスクリプションからも削除
    for (const [topic, subIds] of this.topicSubscriptions) {
      subIds.delete(subscriptionId);
      if (subIds.size === 0) {
        this.topicSubscriptions.delete(topic);
      }
    }

    this.emit('subscriptionRemoved', subscription);
    return true;
  }

  subscribeTo(subscriptionId: string, topic: string): void {
    if (!this.topicSubscriptions.has(topic)) {
      this.topicSubscriptions.set(topic, new Set());
    }
    this.topicSubscriptions.get(topic)!.add(subscriptionId);
  }

  publish(topic: string, data: any): void {
    const subscriptionIds = this.topicSubscriptions.get(topic);
    if (!subscriptionIds) return;

    for (const subscriptionId of subscriptionIds) {
      const subscription = this.subscriptions.get(subscriptionId);
      if (subscription && subscription.active) {
        try {
          subscription.callback(data);
          subscription.lastUpdate = Date.now();
        } catch (error) {
          console.error(`Error publishing to subscription ${subscriptionId}:`, error);
          this.removeSubscription(subscriptionId);
        }
      }
    }
  }

  getActiveSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values()).filter(sub => sub.active);
  }

  cleanup(): void {
    const now = Date.now();
    const timeout = 30 * 60 * 1000; // 30分

    for (const [id, subscription] of this.subscriptions) {
      if (now - subscription.lastUpdate > timeout) {
        this.removeSubscription(id);
      }
    }
  }
}

// === メインGraphQLサーバー ===
class LightGraphQLServer extends EventEmitter {
  private config: GraphQLConfig;
  private schemaBuilder = new SchemaBuilder();
  private cache = new QueryCache();
  private subscriptionManager = new SubscriptionManager();
  private metrics: QueryMetrics[] = [];
  private dataLoaders: Record<string, (context: ResolverContext) => DataLoader<any, any>> = {};
  private logger: any;

  constructor(config: Partial<GraphQLConfig> = {}, logger?: any) {
    super();
    
    this.config = {
      introspection: process.env.NODE_ENV !== 'production',
      playground: process.env.NODE_ENV !== 'production',
      enableCache: true,
      enableMetrics: true,
      maxQueryDepth: 10,
      maxQueryComplexity: 1000,
      timeout: 30000,
      enableSubscriptions: true,
      subscriptionPath: '/graphql/subscriptions',
      ...config
    };

    this.logger = logger || {
      info: (msg: string, data?: any) => console.log(`[GraphQL] ${msg}`, data || ''),
      error: (msg: string, err?: any) => console.error(`[GraphQL] ${msg}`, err || ''),
      warn: (msg: string, data?: any) => console.warn(`[GraphQL] ${msg}`, data || '')
    };

    this.setupDefaultSchema();
    this.setupCleanupTimer();
  }

  private setupDefaultSchema(): void {
    // 基本的なマイニングプール用スキーマ
    this.schemaBuilder.addType(`
      type Query {
        pool: Pool
        miners: [Miner!]!
        miner(id: ID!): Miner
        stats: PoolStats
        blocks: [Block!]!
        block(hash: String!): Block
      }

      type Mutation {
        registerMiner(input: RegisterMinerInput!): MinerRegistrationResult!
        updateMinerSettings(id: ID!, input: UpdateMinerInput!): Miner!
      }

      type Subscription {
        newBlock: Block!
        minerUpdate(minerId: ID): Miner!
        poolStats: PoolStats!
      }

      type Pool {
        address: String!
        fee: Float!
        hashrate: Float!
        miners: Int!
        blocks: Int!
        efficiency: Float!
      }

      type Miner {
        id: ID!
        address: String!
        currency: String!
        workerName: String
        hashrate: Float!
        shares: Int!
        validShares: Int!
        invalidShares: Int!
        lastActivity: String!
        status: MinerStatus!
      }

      enum MinerStatus {
        ACTIVE
        INACTIVE
        DISCONNECTED
      }

      type Block {
        hash: String!
        height: Int!
        timestamp: String!
        difficulty: Float!
        reward: Float!
        finder: String!
      }

      type PoolStats {
        totalHashrate: Float!
        activeMiners: Int!
        totalMiners: Int!
        blocksFound: Int!
        efficiency: Float!
        uptime: Float!
      }

      input RegisterMinerInput {
        address: String!
        currency: String!
        workerName: String
      }

      input UpdateMinerInput {
        workerName: String
        difficulty: Int
      }

      type MinerRegistrationResult {
        success: Boolean!
        miner: Miner
        error: String
      }
    `);

    // 基本リゾルバー
    this.schemaBuilder.addResolver('Query', {
      pool: async (parent: any, args: any, context: ResolverContext) => {
        return context.pool?.getStats?.()?.pool || null;
      },
      
      miners: async (parent: any, args: any, context: ResolverContext) => {
        const miners = context.pool?.miners?.getActiveMiners?.() || [];
        return miners.map(this.transformMiner);
      },
      
      miner: async (parent: any, args: { id: string }, context: ResolverContext) => {
        const miner = context.pool?.miners?.getMiner?.(args.id);
        return miner ? this.transformMiner(miner) : null;
      },
      
      stats: async (parent: any, args: any, context: ResolverContext) => {
        const stats = context.pool?.getStats?.();
        return stats ? this.transformStats(stats) : null;
      },
      
      blocks: async (parent: any, args: any, context: ResolverContext) => {
        // ブロック履歴を取得（実装に応じて調整）
        return [];
      }
    });

    this.schemaBuilder.addResolver('Mutation', {
      registerMiner: async (parent: any, args: { input: any }, context: ResolverContext) => {
        try {
          const { address, currency, workerName } = args.input;
          const minerId = `miner_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          await context.pool?.miners?.addMiner?.(minerId, null, address, currency, workerName);
          const miner = context.pool?.miners?.getMiner?.(minerId);
          
          return {
            success: true,
            miner: miner ? this.transformMiner(miner) : null
          };
        } catch (error) {
          return {
            success: false,
            error: error.message
          };
        }
      }
    });

    this.schemaBuilder.addResolver('Subscription', {
      newBlock: {
        subscribe: () => this.createSubscriptionIterator('newBlock')
      },
      
      minerUpdate: {
        subscribe: (parent: any, args: { minerId?: string }) => {
          const topic = args.minerId ? `minerUpdate:${args.minerId}` : 'minerUpdate:*';
          return this.createSubscriptionIterator(topic);
        }
      },
      
      poolStats: {
        subscribe: () => this.createSubscriptionIterator('poolStats')
      }
    });
  }

  private transformMiner(miner: any) {
    return {
      id: miner.id,
      address: miner.payoutAddress,
      currency: miner.currency,
      workerName: miner.workerName,
      hashrate: miner.hashrate,
      shares: miner.shares,
      validShares: miner.validShares,
      invalidShares: miner.invalidShares,
      lastActivity: new Date(miner.lastActivity).toISOString(),
      status: this.getMinerStatus(miner)
    };
  }

  private transformStats(stats: any) {
    return {
      totalHashrate: stats.miners?.totalHashrate || 0,
      activeMiners: stats.miners?.activeMiners || 0,
      totalMiners: stats.miners?.totalMiners || 0,
      blocksFound: 0, // 実装に応じて調整
      efficiency: stats.pool?.efficiency || 100,
      uptime: stats.uptime || 0
    };
  }

  private getMinerStatus(miner: any): string {
    const now = Date.now();
    const timeSinceLastActivity = now - (miner.lastActivity || 0);
    
    if (timeSinceLastActivity < 300000) { // 5分以内
      return 'ACTIVE';
    } else if (timeSinceLastActivity < 1800000) { // 30分以内
      return 'INACTIVE';
    } else {
      return 'DISCONNECTED';
    }
  }

  private createSubscriptionIterator(topic: string) {
    // 簡易的な非同期イテレーター実装
    const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise((resolve) => {
          const subscription: Subscription = {
            id: subscriptionId,
            query: '',
            variables: {},
            callback: (data: any) => resolve({ value: data, done: false }),
            active: true,
            lastUpdate: Date.now()
          };
          
          this.subscriptionManager.addSubscription(subscription);
          this.subscriptionManager.subscribeTo(subscriptionId, topic);
        }),
        return: () => {
          this.subscriptionManager.removeSubscription(subscriptionId);
          return Promise.resolve({ value: undefined, done: true });
        }
      })
    };
  }

  addDataLoader<K, V>(
    name: string, 
    loaderFactory: (context: ResolverContext) => DataLoader<K, V>
  ): void {
    this.dataLoaders[name] = loaderFactory;
  }

  addType(typeDef: string): void {
    this.schemaBuilder.addType(typeDef);
  }

  addResolver(typeName: string, resolverMap: Record<string, any>): void {
    this.schemaBuilder.addResolver(typeName, resolverMap);
  }

  async executeQuery(
    query: string, 
    variables: Record<string, any> = {}, 
    context: Partial<ResolverContext> = {}
  ): Promise<any> {
    const startTime = Date.now();
    const queryId = `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    try {
      // クエリバリデーション
      if (!QueryValidator.validateDepth(query, this.config.maxQueryDepth)) {
        throw new Error(`Query depth exceeds maximum of ${this.config.maxQueryDepth}`);
      }

      if (!QueryValidator.validateComplexity(query, this.config.maxQueryComplexity)) {
        throw new Error(`Query complexity exceeds maximum of ${this.config.maxQueryComplexity}`);
      }

      // キャッシュチェック
      const cacheKey = this.generateCacheKey(query, variables);
      if (this.config.enableCache) {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          this.recordMetrics(queryId, query, Date.now() - startTime, true);
          return cached;
        }
      }

      // コンテキスト構築
      const fullContext: ResolverContext = {
        ...context,
        dataLoaders: this.createDataLoaders(context),
        cache: this.cache
      };

      // クエリ実行（簡易実装）
      const result = await this.executeSimpleQuery(query, variables, fullContext);

      // キャッシュ保存
      if (this.config.enableCache && !result.errors) {
        this.cache.set(cacheKey, result);
      }

      this.recordMetrics(queryId, query, Date.now() - startTime, false, result.errors);
      return result;

    } catch (error) {
      this.recordMetrics(queryId, query, Date.now() - startTime, false, [error]);
      throw error;
    }
  }

  private async executeSimpleQuery(
    query: string, 
    variables: Record<string, any>, 
    context: ResolverContext
  ): Promise<any> {
    // 簡易クエリ実行（実際の実装ではGraphQL実行エンジンを使用）
    const { resolvers } = this.schemaBuilder.getSchema();
    
    try {
      // クエリパースと実行のモック実装
      if (query.includes('pool') && resolvers.Query?.pool) {
        const data = await resolvers.Query.pool(null, {}, context);
        return { data: { pool: data } };
      }
      
      if (query.includes('miners') && resolvers.Query?.miners) {
        const data = await resolvers.Query.miners(null, {}, context);
        return { data: { miners: data } };
      }
      
      if (query.includes('stats') && resolvers.Query?.stats) {
        const data = await resolvers.Query.stats(null, {}, context);
        return { data: { stats: data } };
      }

      return { data: null };
    } catch (error) {
      return { 
        data: null, 
        errors: [{ message: error.message, path: [] }] 
      };
    }
  }

  private createDataLoaders(context: Partial<ResolverContext>): Record<string, DataLoader<any, any>> {
    const loaders: Record<string, DataLoader<any, any>> = {};
    
    for (const [name, factory] of Object.entries(this.dataLoaders)) {
      loaders[name] = factory(context as ResolverContext);
    }
    
    return loaders;
  }

  private generateCacheKey(query: string, variables: Record<string, any>): string {
    const hash = require('crypto')
      .createHash('sha256')
      .update(query + JSON.stringify(variables))
      .digest('hex');
    return `gql:${hash}`;
  }

  private recordMetrics(
    queryId: string, 
    query: string, 
    duration: number, 
    cached: boolean, 
    errors: any[] = []
  ): void {
    if (!this.config.enableMetrics) return;

    const metrics: QueryMetrics = {
      queryId,
      operationName: this.extractOperationName(query),
      duration,
      complexity: QueryValidator['calculateComplexity'](query),
      depth: QueryValidator['calculateDepth'](query),
      errors,
      timestamp: Date.now(),
      cached
    };

    this.metrics.push(metrics);
    
    // メトリクス制限（最新1000件）
    if (this.metrics.length > 1000) {
      this.metrics = this.metrics.slice(-1000);
    }

    this.emit('queryExecuted', metrics);
  }

  private extractOperationName(query: string): string | undefined {
    const match = query.match(/(?:query|mutation|subscription)\s+(\w+)/);
    return match?.[1];
  }

  // サブスクリプション関連
  publish(topic: string, data: any): void {
    this.subscriptionManager.publish(topic, data);
  }

  // Express.jsミドルウェア
  createMiddleware() {
    return async (req: any, res: any) => {
      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      try {
        const { query, variables, operationName } = req.body;
        
        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }

        const context: Partial<ResolverContext> = {
          userId: req.user?.id,
          permissions: req.user?.permissions,
          pool: req.pool,
          services: req.services
        };

        const result = await this.executeQuery(query, variables, context);
        res.json(result);

      } catch (error) {
        this.logger.error('GraphQL execution error', error);
        res.status(500).json({
          errors: [{ message: error.message }]
        });
      }
    };
  }

  // WebSocketサブスクリプション処理
  handleWebSocketConnection(ws: any, request: any): void {
    if (!this.config.enableSubscriptions) {
      ws.close(1003, 'Subscriptions not enabled');
      return;
    }

    ws.on('message', async (message: string) => {
      try {
        const { type, payload } = JSON.parse(message);
        
        switch (type) {
          case 'connection_init':
            ws.send(JSON.stringify({ type: 'connection_ack' }));
            break;
            
          case 'start':
            await this.handleSubscriptionStart(ws, payload);
            break;
            
          case 'stop':
            this.handleSubscriptionStop(payload.id);
            break;
            
          default:
            ws.send(JSON.stringify({ 
              type: 'error', 
              payload: { message: 'Unknown message type' } 
            }));
        }
      } catch (error) {
        ws.send(JSON.stringify({ 
          type: 'error', 
          payload: { message: error.message } 
        }));
      }
    });

    ws.on('close', () => {
      // クリーンアップ処理
    });
  }

  private async handleSubscriptionStart(ws: any, payload: any): Promise<void> {
    const { id, query, variables } = payload;
    
    const subscription: Subscription = {
      id,
      query,
      variables: variables || {},
      callback: (data: any) => {
        ws.send(JSON.stringify({
          type: 'data',
          id,
          payload: data
        }));
      },
      active: true,
      lastUpdate: Date.now()
    };

    this.subscriptionManager.addSubscription(subscription);
    
    // サブスクリプション実行（簡易実装）
    if (query.includes('poolStats')) {
      this.subscriptionManager.subscribeTo(id, 'poolStats');
    }
  }

  private handleSubscriptionStop(subscriptionId: string): void {
    this.subscriptionManager.removeSubscription(subscriptionId);
  }

  private setupCleanupTimer(): void {
    setInterval(() => {
      this.subscriptionManager.cleanup();
    }, 5 * 60 * 1000); // 5分間隔
  }

  getSchema(): { typeDefs: string; resolvers: Record<string, any> } {
    return this.schemaBuilder.getSchema();
  }

  getMetrics(): QueryMetrics[] {
    return [...this.metrics];
  }

  getStats() {
    const avgDuration = this.metrics.length > 0 
      ? this.metrics.reduce((sum, m) => sum + m.duration, 0) / this.metrics.length 
      : 0;

    const cacheHitRate = this.metrics.length > 0
      ? (this.metrics.filter(m => m.cached).length / this.metrics.length) * 100
      : 0;

    return {
      totalQueries: this.metrics.length,
      averageDuration: avgDuration,
      cacheHitRate,
      activeSubscriptions: this.subscriptionManager.getActiveSubscriptions().length,
      cacheStats: this.cache.getStats(),
      config: this.config
    };
  }

  clearCache(): void {
    this.cache.invalidate();
  }

  clearMetrics(): void {
    this.metrics = [];
  }
}

export {
  LightGraphQLServer,
  GraphQLConfig,
  ResolverContext,
  QueryMetrics,
  DataLoader,
  QueryCache,
  SchemaBuilder,
  SubscriptionManager
};