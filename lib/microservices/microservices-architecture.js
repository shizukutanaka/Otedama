/**
 * Microservices Architecture
 * マイクロサービスアーキテクチャ
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { createServer } from 'grpc';
import { loadPackageDefinition } from '@grpc/grpc-js';
import { load } from '@grpc/proto-loader';

const logger = getLogger('MicroservicesArchitecture');

// サービスタイプ
export const ServiceType = {
  API_GATEWAY: 'api_gateway',
  AUTH_SERVICE: 'auth_service',
  USER_SERVICE: 'user_service',
  PAYMENT_SERVICE: 'payment_service',
  NOTIFICATION_SERVICE: 'notification_service',
  ANALYTICS_SERVICE: 'analytics_service',
  STORAGE_SERVICE: 'storage_service',
  SEARCH_SERVICE: 'search_service'
};

// 通信プロトコル
export const CommunicationProtocol = {
  REST: 'rest',
  GRPC: 'grpc',
  GRAPHQL: 'graphql',
  MESSAGE_QUEUE: 'message_queue',
  EVENT_STREAMING: 'event_streaming'
};

// サービスステータス
export const ServiceStatus = {
  STARTING: 'starting',
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
  STOPPING: 'stopping',
  STOPPED: 'stopped'
};

export class MicroservicesArchitecture extends EventEmitter {
  constructor(options = {}) {
    super();
    this.logger = logger;
    
    this.options = {
      // 基本設定
      enableServiceDiscovery: options.enableServiceDiscovery !== false,
      enableLoadBalancing: options.enableLoadBalancing !== false,
      enableCircuitBreaker: options.enableCircuitBreaker !== false,
      
      // サービスメッシュ設定
      enableSidecar: options.enableSidecar !== false,
      enableServiceMesh: options.enableServiceMesh !== false,
      meshProvider: options.meshProvider || 'istio',
      
      // 通信設定
      defaultProtocol: options.defaultProtocol || CommunicationProtocol.GRPC,
      enableEncryption: options.enableEncryption !== false,
      enableTracing: options.enableTracing !== false,
      
      // レジリエンス設定
      retryPolicy: options.retryPolicy || {
        maxRetries: 3,
        initialDelay: 100,
        maxDelay: 5000,
        backoffMultiplier: 2
      },
      
      // セキュリティ設定
      enableMTLS: options.enableMTLS !== false,
      enableRBAC: options.enableRBAC !== false,
      enableAPIKey: options.enableAPIKey !== false,
      
      // モニタリング設定
      healthCheckInterval: options.healthCheckInterval || 10000,
      metricsInterval: options.metricsInterval || 30000,
      
      ...options
    };
    
    // サービスレジストリ
    this.services = new Map();
    this.serviceInstances = new Map();
    
    // サービスディスカバリ
    this.serviceRegistry = new Map();
    this.healthChecks = new Map();
    
    // ロードバランサー
    this.loadBalancers = new Map();
    this.circuitBreakers = new Map();
    
    // メッセージング
    this.messageQueues = new Map();
    this.eventStreams = new Map();
    
    // APIゲートウェイ
    this.apiGateway = null;
    this.routes = new Map();
    
    // メトリクス
    this.metrics = {
      totalServices: 0,
      healthyServices: 0,
      totalRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0,
      throughput: 0
    };
    
    this.initialize();
  }
  
  async initialize() {
    // サービスディスカバリを初期化
    if (this.options.enableServiceDiscovery) {
      await this.initializeServiceDiscovery();
    }
    
    // APIゲートウェイを初期化
    await this.initializeAPIGateway();
    
    // サービスメッシュを初期化
    if (this.options.enableServiceMesh) {
      await this.initializeServiceMesh();
    }
    
    // メッセージングシステムを初期化
    await this.initializeMessaging();
    
    // ヘルスチェックを開始
    this.startHealthChecks();
    
    this.logger.info('Microservices architecture initialized');
  }
  
  /**
   * サービスを作成
   */
  async createService(config) {
    const service = {
      id: this.generateServiceId(),
      name: config.name,
      type: config.type,
      version: config.version || '1.0.0',
      protocol: config.protocol || this.options.defaultProtocol,
      endpoints: config.endpoints || [],
      dependencies: config.dependencies || [],
      instances: [],
      status: ServiceStatus.STARTING,
      metadata: config.metadata || {},
      created: Date.now()
    };
    
    // サービスを登録
    this.services.set(service.id, service);
    
    // エンドポイントを設定
    await this.setupServiceEndpoints(service);
    
    // 依存関係を解決
    await this.resolveDependencies(service);
    
    // サービスを起動
    await this.startService(service);
    
    // サービスディスカバリに登録
    if (this.options.enableServiceDiscovery) {
      await this.registerService(service);
    }
    
    this.metrics.totalServices++;
    
    this.emit('service:created', service);
    
    return service;
  }
  
  /**
   * サービスエンドポイントを設定
   */
  async setupServiceEndpoints(service) {
    switch (service.protocol) {
      case CommunicationProtocol.GRPC:
        await this.setupGRPCEndpoints(service);
        break;
        
      case CommunicationProtocol.REST:
        await this.setupRESTEndpoints(service);
        break;
        
      case CommunicationProtocol.GRAPHQL:
        await this.setupGraphQLEndpoints(service);
        break;
        
      case CommunicationProtocol.MESSAGE_QUEUE:
        await this.setupMessageQueueEndpoints(service);
        break;
        
      case CommunicationProtocol.EVENT_STREAMING:
        await this.setupEventStreamingEndpoints(service);
        break;
    }
  }
  
  /**
   * gRPCエンドポイントを設定
   */
  async setupGRPCEndpoints(service) {
    const protoPath = service.protoPath || `./protos/${service.name}.proto`;
    
    // Protoファイルをロード
    const packageDefinition = await load(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    
    const proto = loadPackageDefinition(packageDefinition);
    
    // gRPCサーバーを作成
    const server = new grpc.Server();
    
    // サービス実装を追加
    for (const endpoint of service.endpoints) {
      const implementation = await this.loadServiceImplementation(service, endpoint);
      server.addService(proto[service.name][endpoint.service].service, implementation);
    }
    
    // インターセプターを追加
    if (this.options.enableTracing) {
      this.addTracingInterceptor(server);
    }
    
    if (this.options.enableMTLS) {
      this.addMTLSInterceptor(server);
    }
    
    service.server = server;
  }
  
  /**
   * RESTエンドポイントを設定
   */
  async setupRESTEndpoints(service) {
    const express = require('express');
    const app = express();
    
    // ミドルウェアを設定
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    
    // CORSを設定
    if (service.cors) {
      const cors = require('cors');
      app.use(cors(service.cors));
    }
    
    // エンドポイントを登録
    for (const endpoint of service.endpoints) {
      const handler = await this.loadServiceImplementation(service, endpoint);
      
      switch (endpoint.method) {
        case 'GET':
          app.get(endpoint.path, handler);
          break;
        case 'POST':
          app.post(endpoint.path, handler);
          break;
        case 'PUT':
          app.put(endpoint.path, handler);
          break;
        case 'DELETE':
          app.delete(endpoint.path, handler);
          break;
        case 'PATCH':
          app.patch(endpoint.path, handler);
          break;
      }
    }
    
    // エラーハンドリング
    app.use(this.createErrorHandler(service));
    
    service.app = app;
  }
  
  /**
   * GraphQLエンドポイントを設定
   */
  async setupGraphQLEndpoints(service) {
    const { ApolloServer } = require('apollo-server');
    
    // スキーマとリゾルバーをロード
    const typeDefs = await this.loadGraphQLSchema(service);
    const resolvers = await this.loadGraphQLResolvers(service);
    
    // Apollo Serverを作成
    const server = new ApolloServer({
      typeDefs,
      resolvers,
      context: async ({ req }) => {
        // 認証情報を取得
        const auth = await this.authenticateRequest(req);
        
        return {
          auth,
          dataSources: await this.getDataSources(service)
        };
      },
      plugins: [
        // プラグインを追加
        this.createTracingPlugin(),
        this.createCachingPlugin()
      ]
    });
    
    service.graphqlServer = server;
  }
  
  /**
   * メッセージキューエンドポイントを設定
   */
  async setupMessageQueueEndpoints(service) {
    const amqp = require('amqplib');
    
    // RabbitMQ接続
    const connection = await amqp.connect(this.options.messageQueueUrl || 'amqp://localhost');
    const channel = await connection.createChannel();
    
    // キューを設定
    for (const endpoint of service.endpoints) {
      const queueName = `${service.name}.${endpoint.name}`;
      
      await channel.assertQueue(queueName, {
        durable: true,
        autoDelete: false
      });
      
      // コンシューマーを設定
      if (endpoint.consumer) {
        const handler = await this.loadServiceImplementation(service, endpoint);
        
        channel.consume(queueName, async (msg) => {
          try {
            const content = JSON.parse(msg.content.toString());
            await handler(content);
            channel.ack(msg);
          } catch (error) {
            this.logger.error(`Message processing failed: ${error.message}`);
            channel.nack(msg, false, false);
          }
        });
      }
    }
    
    service.messageQueue = { connection, channel };
  }
  
  /**
   * イベントストリーミングエンドポイントを設定
   */
  async setupEventStreamingEndpoints(service) {
    const { Kafka } = require('kafkajs');
    
    // Kafkaクライアントを作成
    const kafka = new Kafka({
      clientId: service.name,
      brokers: this.options.kafkaBrokers || ['localhost:9092']
    });
    
    // プロデューサーとコンシューマーを設定
    const producer = kafka.producer();
    await producer.connect();
    
    const consumer = kafka.consumer({ groupId: `${service.name}-group` });
    await consumer.connect();
    
    // トピックを購読
    for (const endpoint of service.endpoints) {
      if (endpoint.subscribe) {
        await consumer.subscribe({ 
          topic: endpoint.topic,
          fromBeginning: endpoint.fromBeginning || false
        });
      }
    }
    
    // メッセージハンドラーを設定
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const endpoint = service.endpoints.find(e => e.topic === topic);
        if (endpoint) {
          const handler = await this.loadServiceImplementation(service, endpoint);
          await handler({
            key: message.key?.toString(),
            value: JSON.parse(message.value.toString()),
            headers: message.headers,
            timestamp: message.timestamp
          });
        }
      }
    });
    
    service.eventStreaming = { kafka, producer, consumer };
  }
  
  /**
   * サービスを起動
   */
  async startService(service) {
    const port = await this.allocatePort(service);
    
    switch (service.protocol) {
      case CommunicationProtocol.GRPC:
        service.server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure());
        service.server.start();
        break;
        
      case CommunicationProtocol.REST:
        service.server = service.app.listen(port);
        break;
        
      case CommunicationProtocol.GRAPHQL:
        const { url } = await service.graphqlServer.listen({ port });
        service.url = url;
        break;
    }
    
    service.port = port;
    service.status = ServiceStatus.HEALTHY;
    
    this.logger.info(`Service ${service.name} started on port ${port}`);
    
    // インスタンスを作成
    const instance = {
      id: this.generateInstanceId(),
      serviceId: service.id,
      host: 'localhost',
      port,
      status: ServiceStatus.HEALTHY,
      startTime: Date.now(),
      metadata: {}
    };
    
    if (!this.serviceInstances.has(service.id)) {
      this.serviceInstances.set(service.id, []);
    }
    
    this.serviceInstances.get(service.id).push(instance);
  }
  
  /**
   * サービスディスカバリを初期化
   */
  async initializeServiceDiscovery() {
    // Consulクライアントを初期化
    const consul = require('consul')();
    
    this.serviceDiscovery = {
      consul,
      
      register: async (service, instance) => {
        await consul.agent.service.register({
          id: instance.id,
          name: service.name,
          address: instance.host,
          port: instance.port,
          tags: [
            `version:${service.version}`,
            `protocol:${service.protocol}`,
            ...Object.entries(service.metadata).map(([k, v]) => `${k}:${v}`)
          ],
          check: {
            http: `http://${instance.host}:${instance.port}/health`,
            interval: '10s',
            timeout: '5s'
          }
        });
      },
      
      deregister: async (instanceId) => {
        await consul.agent.service.deregister(instanceId);
      },
      
      discover: async (serviceName) => {
        const services = await consul.health.service(serviceName);
        return services
          .filter(s => s.Checks.every(c => c.Status === 'passing'))
          .map(s => ({
            id: s.Service.ID,
            address: s.Service.Address,
            port: s.Service.Port,
            tags: s.Service.Tags
          }));
      }
    };
  }
  
  /**
   * APIゲートウェイを初期化
   */
  async initializeAPIGateway() {
    const express = require('express');
    const httpProxy = require('http-proxy-middleware');
    
    const app = express();
    
    // ミドルウェア
    app.use(express.json());
    
    // 認証ミドルウェア
    app.use(this.createAuthenticationMiddleware());
    
    // レート制限
    app.use(this.createRateLimitMiddleware());
    
    // ルーティングルールを設定
    this.setupRoutingRules();
    
    // プロキシミドルウェアを設定
    for (const [path, route] of this.routes) {
      const proxyOptions = {
        target: route.target,
        changeOrigin: true,
        pathRewrite: route.pathRewrite,
        onProxyReq: this.createProxyRequestHandler(route),
        onProxyRes: this.createProxyResponseHandler(route),
        onError: this.createProxyErrorHandler(route)
      };
      
      app.use(path, httpProxy.createProxyMiddleware(proxyOptions));
    }
    
    // エラーハンドリング
    app.use(this.createGatewayErrorHandler());
    
    this.apiGateway = app;
  }
  
  /**
   * ルーティングルールを設定
   */
  setupRoutingRules() {
    // デフォルトルート
    this.routes.set('/api/auth/*', {
      target: 'http://auth-service',
      serviceType: ServiceType.AUTH_SERVICE,
      loadBalancer: 'round-robin',
      retry: true,
      circuitBreaker: true
    });
    
    this.routes.set('/api/users/*', {
      target: 'http://user-service',
      serviceType: ServiceType.USER_SERVICE,
      loadBalancer: 'least-connections',
      retry: true,
      cache: true
    });
    
    this.routes.set('/api/payments/*', {
      target: 'http://payment-service',
      serviceType: ServiceType.PAYMENT_SERVICE,
      loadBalancer: 'weighted',
      retry: false,
      timeout: 30000
    });
    
    // GraphQLエンドポイント
    this.routes.set('/graphql', {
      target: 'http://graphql-gateway',
      serviceType: 'graphql-gateway',
      loadBalancer: 'sticky-session'
    });
  }
  
  /**
   * サービスメッシュを初期化
   */
  async initializeServiceMesh() {
    switch (this.options.meshProvider) {
      case 'istio':
        await this.initializeIstio();
        break;
        
      case 'linkerd':
        await this.initializeLinkerd();
        break;
        
      case 'consul-connect':
        await this.initializeConsulConnect();
        break;
    }
  }
  
  /**
   * Istioを初期化
   */
  async initializeIstio() {
    // Envoyサイドカー設定
    this.sidecar = {
      inboundPort: 15001,
      outboundPort: 15006,
      adminPort: 15000,
      
      // トラフィック管理
      trafficPolicy: {
        connectionPool: {
          tcp: { maxConnections: 100 },
          http: { 
            http1MaxPendingRequests: 10,
            http2MaxRequests: 100
          }
        },
        loadBalancer: {
          simple: 'ROUND_ROBIN'
        },
        outlierDetection: {
          consecutiveErrors: 5,
          interval: '30s',
          baseEjectionTime: '30s'
        }
      },
      
      // セキュリティポリシー
      securityPolicy: {
        mtls: {
          mode: 'STRICT'
        },
        authorizationPolicy: {
          rules: [
            {
              from: [{ source: { principals: ['cluster.local/ns/default/sa/*'] } }],
              to: [{ operation: { methods: ['GET', 'POST'] } }]
            }
          ]
        }
      }
    };
  }
  
  /**
   * メッセージングシステムを初期化
   */
  async initializeMessaging() {
    // メッセージブローカーを設定
    this.messageBroker = {
      publish: async (topic, message, options = {}) => {
        const messageId = this.generateMessageId();
        
        const envelope = {
          id: messageId,
          topic,
          payload: message,
          metadata: {
            timestamp: Date.now(),
            source: options.source,
            correlationId: options.correlationId,
            headers: options.headers || {}
          }
        };
        
        // メッセージを配信
        await this.distributeMessage(envelope);
        
        return messageId;
      },
      
      subscribe: async (topic, handler, options = {}) => {
        const subscriptionId = this.generateSubscriptionId();
        
        const subscription = {
          id: subscriptionId,
          topic,
          handler,
          options,
          active: true
        };
        
        if (!this.messageQueues.has(topic)) {
          this.messageQueues.set(topic, []);
        }
        
        this.messageQueues.get(topic).push(subscription);
        
        return subscriptionId;
      },
      
      unsubscribe: async (subscriptionId) => {
        for (const [topic, subscriptions] of this.messageQueues) {
          const index = subscriptions.findIndex(s => s.id === subscriptionId);
          if (index !== -1) {
            subscriptions.splice(index, 1);
            return true;
          }
        }
        return false;
      }
    };
  }
  
  /**
   * サービス間通信を実行
   */
  async callService(targetService, method, params, options = {}) {
    // サービスインスタンスを取得
    const instances = await this.discoverService(targetService);
    
    if (instances.length === 0) {
      throw new Error(`No instances available for service: ${targetService}`);
    }
    
    // ロードバランシング
    const instance = this.selectInstance(instances, options.loadBalancer);
    
    // サーキットブレーカーを確認
    if (options.circuitBreaker !== false) {
      const breaker = this.getCircuitBreaker(targetService);
      if (breaker.state === 'open') {
        throw new Error(`Circuit breaker is open for service: ${targetService}`);
      }
    }
    
    try {
      // リクエストを実行
      const result = await this.executeRequest(instance, method, params, options);
      
      // 成功を記録
      this.recordSuccess(targetService, instance);
      
      return result;
      
    } catch (error) {
      // 失敗を記録
      this.recordFailure(targetService, instance, error);
      
      // リトライ
      if (options.retry !== false && this.shouldRetry(error)) {
        return await this.retryRequest(targetService, method, params, options);
      }
      
      throw error;
    }
  }
  
  /**
   * リクエストを実行
   */
  async executeRequest(instance, method, params, options) {
    const service = this.services.get(instance.serviceId);
    
    switch (service.protocol) {
      case CommunicationProtocol.GRPC:
        return await this.executeGRPCRequest(instance, method, params, options);
        
      case CommunicationProtocol.REST:
        return await this.executeRESTRequest(instance, method, params, options);
        
      case CommunicationProtocol.GRAPHQL:
        return await this.executeGraphQLRequest(instance, method, params, options);
        
      default:
        throw new Error(`Unsupported protocol: ${service.protocol}`);
    }
  }
  
  /**
   * gRPCリクエストを実行
   */
  async executeGRPCRequest(instance, method, params, options) {
    const grpc = require('@grpc/grpc-js');
    const protoLoader = require('@grpc/proto-loader');
    
    // クライアントを作成
    const packageDefinition = protoLoader.loadSync(
      options.protoPath || './protos/service.proto',
      {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true
      }
    );
    
    const proto = grpc.loadPackageDefinition(packageDefinition);
    const ServiceClient = proto[options.package || 'service'][options.service || 'Service'];
    
    const client = new ServiceClient(
      `${instance.host}:${instance.port}`,
      grpc.credentials.createInsecure()
    );
    
    // メタデータを設定
    const metadata = new grpc.Metadata();
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        metadata.add(key, value);
      }
    }
    
    // トレーシング情報を追加
    if (this.options.enableTracing) {
      metadata.add('x-trace-id', this.generateTraceId());
      metadata.add('x-span-id', this.generateSpanId());
    }
    
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + (options.timeout || 30000);
      
      client[method](params, metadata, { deadline }, (error, response) => {
        if (error) {
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }
  
  /**
   * ヘルスチェックを開始
   */
  startHealthChecks() {
    setInterval(async () => {
      for (const [serviceId, instances] of this.serviceInstances) {
        for (const instance of instances) {
          try {
            const healthy = await this.checkInstanceHealth(instance);
            instance.status = healthy ? ServiceStatus.HEALTHY : ServiceStatus.UNHEALTHY;
            
            if (!healthy) {
              this.emit('instance:unhealthy', instance);
            }
          } catch (error) {
            instance.status = ServiceStatus.UNHEALTHY;
            this.logger.error(`Health check failed for instance ${instance.id}`, error);
          }
        }
      }
      
      this.updateMetrics();
    }, this.options.healthCheckInterval);
  }
  
  /**
   * インスタンスのヘルスチェック
   */
  async checkInstanceHealth(instance) {
    const service = this.services.get(instance.serviceId);
    
    try {
      switch (service.protocol) {
        case CommunicationProtocol.REST:
          const response = await fetch(`http://${instance.host}:${instance.port}/health`);
          return response.ok;
          
        case CommunicationProtocol.GRPC:
          // gRPCヘルスチェック
          return await this.checkGRPCHealth(instance);
          
        default:
          return true;
      }
    } catch (error) {
      return false;
    }
  }
  
  /**
   * サーキットブレーカーを取得
   */
  getCircuitBreaker(serviceName) {
    if (!this.circuitBreakers.has(serviceName)) {
      this.circuitBreakers.set(serviceName, {
        state: 'closed',
        failures: 0,
        lastFailureTime: null,
        successCount: 0,
        requestCount: 0,
        errorThreshold: 0.5,
        volumeThreshold: 20,
        sleepWindow: 60000
      });
    }
    
    return this.circuitBreakers.get(serviceName);
  }
  
  /**
   * メトリクスを更新
   */
  updateMetrics() {
    let totalHealthy = 0;
    
    for (const instances of this.serviceInstances.values()) {
      totalHealthy += instances.filter(i => i.status === ServiceStatus.HEALTHY).length;
    }
    
    this.metrics.healthyServices = totalHealthy;
  }
  
  /**
   * 統計情報を取得
   */
  getStats() {
    const serviceStats = {};
    
    for (const [id, service] of this.services) {
      const instances = this.serviceInstances.get(id) || [];
      
      serviceStats[service.name] = {
        type: service.type,
        protocol: service.protocol,
        status: service.status,
        instances: {
          total: instances.length,
          healthy: instances.filter(i => i.status === ServiceStatus.HEALTHY).length,
          unhealthy: instances.filter(i => i.status === ServiceStatus.UNHEALTHY).length
        }
      };
    }
    
    return {
      metrics: this.metrics,
      services: serviceStats,
      circuitBreakers: Object.fromEntries(
        Array.from(this.circuitBreakers.entries()).map(([name, breaker]) => [
          name,
          {
            state: breaker.state,
            failures: breaker.failures,
            errorRate: breaker.requestCount > 0 ? breaker.failures / breaker.requestCount : 0
          }
        ])
      ),
      messaging: {
        topics: this.messageQueues.size,
        subscriptions: Array.from(this.messageQueues.values())
          .reduce((sum, subs) => sum + subs.length, 0)
      }
    };
  }
  
  // ヘルパーメソッド
  generateServiceId() {
    return `svc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateInstanceId() {
    return `inst_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateMessageId() {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateSubscriptionId() {
    return `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateTraceId() {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateSpanId() {
    return `span_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  async loadServiceImplementation(service, endpoint) {
    // サービス実装をロード
    const implPath = endpoint.implementation || `./services/${service.name}/${endpoint.name}`;
    return require(implPath);
  }
  
  async allocatePort(service) {
    // ポートを割り当て
    const basePort = 5000;
    const serviceIndex = this.services.size;
    return basePort + serviceIndex;
  }
  
  async resolveDependencies(service) {
    // 依存関係を解決
    for (const dep of service.dependencies) {
      const depService = Array.from(this.services.values())
        .find(s => s.name === dep.name);
      
      if (!depService) {
        throw new Error(`Dependency not found: ${dep.name}`);
      }
      
      if (depService.status !== ServiceStatus.HEALTHY) {
        throw new Error(`Dependency not healthy: ${dep.name}`);
      }
    }
  }
  
  async registerService(service) {
    const instances = this.serviceInstances.get(service.id) || [];
    
    for (const instance of instances) {
      await this.serviceDiscovery.register(service, instance);
    }
  }
  
  async discoverService(serviceName) {
    if (this.options.enableServiceDiscovery) {
      return await this.serviceDiscovery.discover(serviceName);
    }
    
    // ローカルディスカバリ
    const service = Array.from(this.services.values())
      .find(s => s.name === serviceName);
    
    if (!service) {
      return [];
    }
    
    return this.serviceInstances.get(service.id) || [];
  }
  
  selectInstance(instances, loadBalancer = 'round-robin') {
    const healthyInstances = instances.filter(i => i.status === ServiceStatus.HEALTHY);
    
    if (healthyInstances.length === 0) {
      throw new Error('No healthy instances available');
    }
    
    switch (loadBalancer) {
      case 'round-robin':
        return this.roundRobinSelect(healthyInstances);
        
      case 'least-connections':
        return this.leastConnectionsSelect(healthyInstances);
        
      case 'random':
        return healthyInstances[Math.floor(Math.random() * healthyInstances.length)];
        
      default:
        return healthyInstances[0];
    }
  }
  
  roundRobinSelect(instances) {
    // ラウンドロビン選択の実装
    const key = instances.map(i => i.id).join(',');
    if (!this.roundRobinCounters) {
      this.roundRobinCounters = new Map();
    }
    
    const counter = this.roundRobinCounters.get(key) || 0;
    const selected = instances[counter % instances.length];
    this.roundRobinCounters.set(key, counter + 1);
    
    return selected;
  }
  
  leastConnectionsSelect(instances) {
    // 最小接続数選択の実装
    return instances.reduce((min, instance) => {
      const minConnections = min.metadata.activeConnections || 0;
      const instanceConnections = instance.metadata.activeConnections || 0;
      return instanceConnections < minConnections ? instance : min;
    });
  }
  
  recordSuccess(serviceName, instance) {
    const breaker = this.getCircuitBreaker(serviceName);
    breaker.successCount++;
    breaker.requestCount++;
    
    // サーキットを閉じる
    if (breaker.state === 'half-open' && breaker.successCount > 5) {
      breaker.state = 'closed';
      breaker.failures = 0;
    }
  }
  
  recordFailure(serviceName, instance, error) {
    const breaker = this.getCircuitBreaker(serviceName);
    breaker.failures++;
    breaker.requestCount++;
    breaker.lastFailureTime = Date.now();
    
    // エラー率を計算
    const errorRate = breaker.failures / breaker.requestCount;
    
    // サーキットを開く
    if (breaker.state === 'closed' &&
        breaker.requestCount >= breaker.volumeThreshold &&
        errorRate > breaker.errorThreshold) {
      breaker.state = 'open';
      this.emit('circuit:opened', { service: serviceName, breaker });
    }
  }
  
  shouldRetry(error) {
    // リトライ可能なエラーか判定
    const retryableCodes = ['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED'];
    return retryableCodes.includes(error.code);
  }
  
  async retryRequest(targetService, method, params, options) {
    const retryPolicy = options.retryPolicy || this.options.retryPolicy;
    let lastError;
    
    for (let attempt = 1; attempt <= retryPolicy.maxRetries; attempt++) {
      try {
        // バックオフ
        const delay = Math.min(
          retryPolicy.initialDelay * Math.pow(retryPolicy.backoffMultiplier, attempt - 1),
          retryPolicy.maxDelay
        );
        
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // リトライ
        return await this.callService(targetService, method, params, {
          ...options,
          retry: false // 再帰的リトライを防ぐ
        });
        
      } catch (error) {
        lastError = error;
        this.logger.warn(`Retry attempt ${attempt} failed for ${targetService}.${method}`);
      }
    }
    
    throw lastError;
  }
  
  createAuthenticationMiddleware() {
    return async (req, res, next) => {
      try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token && this.requiresAuth(req.path)) {
          return res.status(401).json({ error: 'Authentication required' });
        }
        
        if (token) {
          // 認証サービスを呼び出し
          const auth = await this.callService(
            ServiceType.AUTH_SERVICE,
            'verifyToken',
            { token }
          );
          
          req.auth = auth;
        }
        
        next();
      } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
      }
    };
  }
  
  createRateLimitMiddleware() {
    const rateLimiter = require('express-rate-limit');
    
    return rateLimiter({
      windowMs: 60 * 1000, // 1分
      max: 100, // 最大100リクエスト
      message: 'Too many requests',
      standardHeaders: true,
      legacyHeaders: false
    });
  }
  
  createErrorHandler(service) {
    return (err, req, res, next) => {
      this.logger.error(`Service error in ${service.name}:`, err);
      
      res.status(err.status || 500).json({
        error: {
          message: err.message,
          service: service.name,
          timestamp: Date.now()
        }
      });
    };
  }
  
  createGatewayErrorHandler() {
    return (err, req, res, next) => {
      this.logger.error('Gateway error:', err);
      
      res.status(err.status || 502).json({
        error: {
          message: 'Gateway error',
          details: err.message,
          timestamp: Date.now()
        }
      });
    };
  }
  
  createProxyRequestHandler(route) {
    return (proxyReq, req, res) => {
      // トレーシングヘッダーを追加
      if (this.options.enableTracing) {
        proxyReq.setHeader('X-Trace-Id', req.headers['x-trace-id'] || this.generateTraceId());
        proxyReq.setHeader('X-Span-Id', this.generateSpanId());
      }
      
      // 認証情報を転送
      if (req.auth) {
        proxyReq.setHeader('X-User-Id', req.auth.userId);
        proxyReq.setHeader('X-User-Roles', req.auth.roles.join(','));
      }
    };
  }
  
  createProxyResponseHandler(route) {
    return (proxyRes, req, res) => {
      // レスポンスメトリクスを記録
      this.metrics.totalRequests++;
      
      // キャッシュヘッダーを追加
      if (route.cache) {
        proxyRes.headers['cache-control'] = 'public, max-age=300';
      }
    };
  }
  
  createProxyErrorHandler(route) {
    return (err, req, res) => {
      this.logger.error(`Proxy error for ${route.target}:`, err);
      this.metrics.failedRequests++;
      
      // サーキットブレーカーを記録
      if (route.circuitBreaker) {
        this.recordFailure(route.serviceType, null, err);
      }
      
      res.status(502).json({
        error: {
          message: 'Service unavailable',
          service: route.serviceType,
          timestamp: Date.now()
        }
      });
    };
  }
  
  requiresAuth(path) {
    // 認証が必要なパスを判定
    const publicPaths = ['/health', '/metrics', '/api/auth/login', '/api/auth/register'];
    return !publicPaths.includes(path);
  }
  
  async loadGraphQLSchema(service) {
    // GraphQLスキーマをロード
    const { gql } = require('apollo-server');
    const fs = require('fs').promises;
    
    const schemaPath = service.schemaPath || `./schemas/${service.name}.graphql`;
    const schema = await fs.readFile(schemaPath, 'utf-8');
    
    return gql(schema);
  }
  
  async loadGraphQLResolvers(service) {
    // GraphQLリゾルバーをロード
    const resolverPath = service.resolverPath || `./resolvers/${service.name}`;
    return require(resolverPath);
  }
  
  async authenticateRequest(req) {
    // リクエストを認証
    const token = req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return null;
    }
    
    try {
      return await this.callService(
        ServiceType.AUTH_SERVICE,
        'verifyToken',
        { token }
      );
    } catch (error) {
      return null;
    }
  }
  
  async getDataSources(service) {
    // データソースを取得
    const sources = {};
    
    for (const dep of service.dependencies) {
      sources[dep.name] = {
        api: async (method, params) => {
          return await this.callService(dep.name, method, params);
        }
      };
    }
    
    return sources;
  }
  
  createTracingPlugin() {
    // Apollo Serverトレーシングプラグイン
    return {
      requestDidStart() {
        return {
          willSendResponse(requestContext) {
            // トレーシング情報を記録
          }
        };
      }
    };
  }
  
  createCachingPlugin() {
    // Apollo Serverキャッシングプラグイン
    return {
      requestDidStart() {
        return {
          willSendResponse(requestContext) {
            // キャッシュ制御を設定
            const { response } = requestContext;
            response.http.headers.set(
              'Cache-Control',
              'public, max-age=300'
            );
          }
        };
      }
    };
  }
  
  addTracingInterceptor(server) {
    // gRPCトレーシングインターセプター
  }
  
  addMTLSInterceptor(server) {
    // gRPC mTLSインターセプター
  }
  
  async distributeMessage(envelope) {
    const subscriptions = this.messageQueues.get(envelope.topic) || [];
    
    for (const subscription of subscriptions) {
      if (subscription.active) {
        try {
          await subscription.handler(envelope.payload, envelope.metadata);
        } catch (error) {
          this.logger.error(`Message handler error for topic ${envelope.topic}:`, error);
        }
      }
    }
  }
  
  async executeRESTRequest(instance, method, params, options) {
    const url = `http://${instance.host}:${instance.port}${options.path || ''}`;
    
    const fetchOptions = {
      method: options.httpMethod || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      body: JSON.stringify(params)
    };
    
    if (options.timeout) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeout);
      fetchOptions.signal = controller.signal;
      
      try {
        const response = await fetch(url, fetchOptions);
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
    
    const response = await fetch(url, fetchOptions);
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.json();
  }
  
  async executeGraphQLRequest(instance, query, variables, options) {
    const url = `http://${instance.host}:${instance.port}/graphql`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      body: JSON.stringify({ query, variables })
    });
    
    const result = await response.json();
    
    if (result.errors) {
      throw new Error(result.errors[0].message);
    }
    
    return result.data;
  }
  
  async checkGRPCHealth(instance) {
    // gRPCヘルスチェックの実装
    return true;
  }
  
  async initializeLinkerd() {
    // Linkerd初期化
  }
  
  async initializeConsulConnect() {
    // Consul Connect初期化
  }
  
  /**
   * クリーンアップ
   */
  async cleanup() {
    // サービスを停止
    for (const service of this.services.values()) {
      service.status = ServiceStatus.STOPPING;
      
      if (service.server) {
        await new Promise(resolve => {
          service.server.close(resolve);
        });
      }
      
      service.status = ServiceStatus.STOPPED;
    }
    
    // メッセージキューをクリーンアップ
    for (const service of this.services.values()) {
      if (service.messageQueue) {
        await service.messageQueue.connection.close();
      }
      
      if (service.eventStreaming) {
        await service.eventStreaming.producer.disconnect();
        await service.eventStreaming.consumer.disconnect();
      }
    }
  }
}

export default MicroservicesArchitecture;