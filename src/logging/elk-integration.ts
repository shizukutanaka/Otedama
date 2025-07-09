/**
 * ELK Stack Integration
 * Elasticsearch, Logstash, Kibana統合によるログ分析
 * 
 * 設計思想：
 * - Carmack: 高速なログ検索とインデックス
 * - Martin: 構造化されたログ設計
 * - Pike: シンプルで使いやすいログAPI
 */

import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import winston from 'winston';
import { LogstashTransport } from 'winston-logstash-transport';
import { EventEmitter } from 'events';
import { logger } from '../logging/logger';

// === 型定義 ===
export interface ELKConfig {
  elasticsearch: {
    nodes: string[];
    auth?: {
      username: string;
      password: string;
    };
    apiKey?: string;
    cloudId?: string;
    maxRetries?: number;
    requestTimeout?: number;
    sniffOnStart?: boolean;
    sniffInterval?: number;
    ssl?: {
      rejectUnauthorized?: boolean;
      ca?: string;
      cert?: string;
      key?: string;
    };
  };
  
  logstash?: {
    host: string;
    port: number;
    ssl?: boolean;
    maxConnectRetries?: number;
  };
  
  indices: {
    logs: string;
    metrics: string;
    traces: string;
    audit: string;
  };
  
  retention: {
    logs: number;      // days
    metrics: number;   // days
    traces: number;    // days
    audit: number;     // days
  };
  
  kibana?: {
    url: string;
    dashboards?: KibanaDashboard[];
  };
}

export interface LogEntry {
  timestamp: Date;
  level: string;
  component: string;
  message: string;
  metadata?: any;
  traceId?: string;
  spanId?: string;
  userId?: string;
  sessionId?: string;
  minerAddress?: string;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

export interface SearchQuery {
  index?: string;
  query: string;
  size?: number;
  from?: number;
  sort?: Array<Record<string, 'asc' | 'desc'>>;
  dateRange?: {
    field: string;
    gte?: Date;
    lte?: Date;
  };
  aggregations?: Record<string, any>;
}

export interface KibanaDashboard {
  id: string;
  name: string;
  description: string;
  panels: any[];
}

// === ELK Manager ===
export class ELKManager extends EventEmitter {
  private esClient: ElasticsearchClient;
  private logstashTransport?: any;
  private indexTemplates: Map<string, any> = new Map();
  private bulkQueue: any[] = [];
  private bulkTimer?: NodeJS.Timeout;
  
  constructor(private config: ELKConfig) {
    super();
    
    // Elasticsearch クライアントの初期化
    this.esClient = new ElasticsearchClient({
      nodes: config.elasticsearch.nodes,
      auth: config.elasticsearch.auth,
      apiKey: config.elasticsearch.apiKey,
      cloud: config.elasticsearch.cloudId ? { id: config.elasticsearch.cloudId } : undefined,
      maxRetries: config.elasticsearch.maxRetries || 3,
      requestTimeout: config.elasticsearch.requestTimeout || 30000,
      sniffOnStart: config.elasticsearch.sniffOnStart,
      sniffInterval: config.elasticsearch.sniffInterval,
      ssl: config.elasticsearch.ssl
    });
    
    // インデックステンプレートの設定
    this.setupIndexTemplates();
  }
  
  // 初期化
  async initialize(): Promise<void> {
    try {
      // Elasticsearch接続確認
      const info = await this.esClient.info();
      logger.info('Connected to Elasticsearch:', info.body);
      
      // インデックステンプレートの作成
      await this.createIndexTemplates();
      
      // インデックスの作成（存在しない場合）
      await this.createIndices();
      
      // ILMポリシーの設定
      await this.setupILMPolicies();
      
      // Logstash設定（オプション）
      if (this.config.logstash) {
        this.setupLogstash();
      }
      
      // バルク処理の開始
      this.startBulkProcessor();
      
      this.emit('initialized');
    } catch (error) {
      logger.error('Failed to initialize ELK Manager:', error);
      throw error;
    }
  }
  
  // インデックステンプレートの設定
  private setupIndexTemplates(): void {
    // ログ用テンプレート
    this.indexTemplates.set('logs', {
      index_patterns: [`${this.config.indices.logs}-*`],
      template: {
        settings: {
          number_of_shards: 3,
          number_of_replicas: 1,
          'index.lifecycle.name': 'logs-policy',
          'index.lifecycle.rollover_alias': this.config.indices.logs
        },
        mappings: {
          properties: {
            '@timestamp': { type: 'date' },
            level: { type: 'keyword' },
            component: { type: 'keyword' },
            message: { type: 'text' },
            'metadata': { type: 'object' },
            'traceId': { type: 'keyword' },
            'spanId': { type: 'keyword' },
            'userId': { type: 'keyword' },
            'sessionId': { type: 'keyword' },
            'minerAddress': { type: 'keyword' },
            'error.message': { type: 'text' },
            'error.stack': { type: 'text' },
            'error.code': { type: 'keyword' }
          }
        }
      }
    });
    
    // メトリクス用テンプレート
    this.indexTemplates.set('metrics', {
      index_patterns: [`${this.config.indices.metrics}-*`],
      template: {
        settings: {
          number_of_shards: 2,
          number_of_replicas: 1,
          'index.lifecycle.name': 'metrics-policy',
          'index.lifecycle.rollover_alias': this.config.indices.metrics
        },
        mappings: {
          properties: {
            '@timestamp': { type: 'date' },
            'metric.name': { type: 'keyword' },
            'metric.value': { type: 'double' },
            'metric.unit': { type: 'keyword' },
            'labels': { type: 'object' },
            'pool.hashrate': { type: 'double' },
            'pool.miners': { type: 'integer' },
            'pool.shares': { type: 'long' },
            'miner.address': { type: 'keyword' },
            'miner.hashrate': { type: 'double' },
            'miner.shares': { type: 'long' }
          }
        }
      }
    });
    
    // トレース用テンプレート
    this.indexTemplates.set('traces', {
      index_patterns: [`${this.config.indices.traces}-*`],
      template: {
        settings: {
          number_of_shards: 2,
          number_of_replicas: 1,
          'index.lifecycle.name': 'traces-policy',
          'index.lifecycle.rollover_alias': this.config.indices.traces
        },
        mappings: {
          properties: {
            '@timestamp': { type: 'date' },
            'traceId': { type: 'keyword' },
            'spanId': { type: 'keyword' },
            'parentSpanId': { type: 'keyword' },
            'operationName': { type: 'keyword' },
            'serviceName': { type: 'keyword' },
            'duration': { type: 'long' },
            'tags': { type: 'object' },
            'logs': { type: 'nested' },
            'process': { type: 'object' },
            'references': { type: 'nested' }
          }
        }
      }
    });
    
    // 監査ログ用テンプレート
    this.indexTemplates.set('audit', {
      index_patterns: [`${this.config.indices.audit}-*`],
      template: {
        settings: {
          number_of_shards: 1,
          number_of_replicas: 2,
          'index.lifecycle.name': 'audit-policy',
          'index.lifecycle.rollover_alias': this.config.indices.audit
        },
        mappings: {
          properties: {
            '@timestamp': { type: 'date' },
            'event.type': { type: 'keyword' },
            'event.action': { type: 'keyword' },
            'event.outcome': { type: 'keyword' },
            'user.id': { type: 'keyword' },
            'user.address': { type: 'keyword' },
            'user.ip': { type: 'ip' },
            'user.agent': { type: 'text' },
            'resource.type': { type: 'keyword' },
            'resource.id': { type: 'keyword' },
            'changes': { type: 'object' }
          }
        }
      }
    });
  }
  
  // インデックステンプレートの作成
  private async createIndexTemplates(): Promise<void> {
    for (const [name, template] of this.indexTemplates) {
      try {
        await this.esClient.indices.putIndexTemplate({
          name: `otedama-${name}`,
          body: template
        });
        logger.info(`Created index template: otedama-${name}`);
      } catch (error) {
        if (error.meta?.statusCode !== 400) { // 既に存在する場合は無視
          throw error;
        }
      }
    }
  }
  
  // インデックスの作成
  private async createIndices(): Promise<void> {
    const indices = Object.values(this.config.indices);
    
    for (const index of indices) {
      try {
        const exists = await this.esClient.indices.exists({ index });
        
        if (!exists.body) {
          await this.esClient.indices.create({
            index: `${index}-000001`,
            body: {
              aliases: {
                [index]: {
                  is_write_index: true
                }
              }
            }
          });
          logger.info(`Created index: ${index}-000001`);
        }
      } catch (error) {
        logger.error(`Failed to create index ${index}:`, error);
      }
    }
  }
  
  // ILMポリシーの設定
  private async setupILMPolicies(): Promise<void> {
    const policies = [
      {
        name: 'logs-policy',
        retention: this.config.retention.logs,
        maxSize: '50GB',
        maxAge: '7d'
      },
      {
        name: 'metrics-policy',
        retention: this.config.retention.metrics,
        maxSize: '30GB',
        maxAge: '1d'
      },
      {
        name: 'traces-policy',
        retention: this.config.retention.traces,
        maxSize: '20GB',
        maxAge: '3d'
      },
      {
        name: 'audit-policy',
        retention: this.config.retention.audit,
        maxSize: '10GB',
        maxAge: '30d'
      }
    ];
    
    for (const policy of policies) {
      try {
        await this.esClient.ilm.putLifecycle({
          policy: policy.name,
          body: {
            policy: {
              phases: {
                hot: {
                  actions: {
                    rollover: {
                      max_size: policy.maxSize,
                      max_age: policy.maxAge
                    },
                    set_priority: {
                      priority: 100
                    }
                  }
                },
                warm: {
                  min_age: '7d',
                  actions: {
                    shrink: {
                      number_of_shards: 1
                    },
                    forcemerge: {
                      max_num_segments: 1
                    },
                    set_priority: {
                      priority: 50
                    }
                  }
                },
                delete: {
                  min_age: `${policy.retention}d`,
                  actions: {
                    delete: {}
                  }
                }
              }
            }
          }
        });
        logger.info(`Created ILM policy: ${policy.name}`);
      } catch (error) {
        if (error.meta?.statusCode !== 400) { // 既に存在する場合は無視
          throw error;
        }
      }
    }
  }
  
  // Logstash設定
  private setupLogstash(): void {
    this.logstashTransport = new LogstashTransport({
      host: this.config.logstash!.host,
      port: this.config.logstash!.port,
      ssl_enable: this.config.logstash!.ssl,
      max_connect_retries: this.config.logstash!.maxConnectRetries || 3
    });
    
    // Winstonに追加
    if (winston.loggers.has('default')) {
      winston.loggers.get('default').add(this.logstashTransport);
    }
  }
  
  // バルク処理の開始
  private startBulkProcessor(): void {
    this.bulkTimer = setInterval(() => {
      if (this.bulkQueue.length > 0) {
        this.flushBulk();
      }
    }, 5000); // 5秒ごと
  }
  
  // ログの記録
  async log(entry: LogEntry): Promise<void> {
    const document = {
      '@timestamp': entry.timestamp,
      ...entry
    };
    
    this.bulkQueue.push({
      index: {
        _index: this.config.indices.logs,
        _id: this.generateId()
      }
    });
    this.bulkQueue.push(document);
    
    // バルクサイズが大きくなったら即座にフラッシュ
    if (this.bulkQueue.length >= 1000) {
      await this.flushBulk();
    }
  }
  
  // メトリクスの記録
  async logMetric(metric: {
    name: string;
    value: number;
    unit?: string;
    labels?: Record<string, any>;
    timestamp?: Date;
  }): Promise<void> {
    const document = {
      '@timestamp': metric.timestamp || new Date(),
      metric: {
        name: metric.name,
        value: metric.value,
        unit: metric.unit || 'count'
      },
      labels: metric.labels || {}
    };
    
    this.bulkQueue.push({
      index: {
        _index: this.config.indices.metrics,
        _id: this.generateId()
      }
    });
    this.bulkQueue.push(document);
    
    if (this.bulkQueue.length >= 1000) {
      await this.flushBulk();
    }
  }
  
  // トレースの記録
  async logTrace(trace: any): Promise<void> {
    const document = {
      '@timestamp': new Date(trace.startTime),
      ...trace
    };
    
    await this.esClient.index({
      index: this.config.indices.traces,
      body: document
    });
  }
  
  // 監査ログの記録
  async logAudit(event: {
    type: string;
    action: string;
    outcome: 'success' | 'failure';
    user: {
      id?: string;
      address?: string;
      ip?: string;
      agent?: string;
    };
    resource?: {
      type: string;
      id: string;
    };
    changes?: any;
    timestamp?: Date;
  }): Promise<void> {
    const document = {
      '@timestamp': event.timestamp || new Date(),
      event: {
        type: event.type,
        action: event.action,
        outcome: event.outcome
      },
      user: event.user,
      resource: event.resource,
      changes: event.changes
    };
    
    await this.esClient.index({
      index: this.config.indices.audit,
      body: document,
      refresh: true // 監査ログは即座に検索可能にする
    });
  }
  
  // バルクフラッシュ
  private async flushBulk(): Promise<void> {
    if (this.bulkQueue.length === 0) return;
    
    const operations = [...this.bulkQueue];
    this.bulkQueue = [];
    
    try {
      const response = await this.esClient.bulk({
        body: operations,
        refresh: false
      });
      
      if (response.body.errors) {
        const errors = response.body.items
          .filter((item: any) => item.index?.error)
          .map((item: any) => item.index.error);
        
        logger.error('Bulk indexing errors:', errors);
        this.emit('bulkError', errors);
      }
    } catch (error) {
      logger.error('Bulk indexing failed:', error);
      this.emit('error', error);
      
      // 失敗したアイテムをキューに戻す
      this.bulkQueue.unshift(...operations);
    }
  }
  
  // 検索
  async search(query: SearchQuery): Promise<any> {
    const body: any = {
      query: {
        query_string: {
          query: query.query,
          default_field: '*'
        }
      },
      size: query.size || 100,
      from: query.from || 0
    };
    
    // 日付範囲フィルター
    if (query.dateRange) {
      body.query = {
        bool: {
          must: body.query,
          filter: {
            range: {
              [query.dateRange.field]: {
                gte: query.dateRange.gte,
                lte: query.dateRange.lte
              }
            }
          }
        }
      };
    }
    
    // ソート
    if (query.sort) {
      body.sort = query.sort;
    }
    
    // 集計
    if (query.aggregations) {
      body.aggs = query.aggregations;
    }
    
    const response = await this.esClient.search({
      index: query.index || `${this.config.indices.logs},${this.config.indices.metrics}`,
      body
    });
    
    return {
      total: response.body.hits.total.value,
      hits: response.body.hits.hits.map((hit: any) => ({
        _id: hit._id,
        _index: hit._index,
        _score: hit._score,
        ...hit._source
      })),
      aggregations: response.body.aggregations
    };
  }
  
  // 特定のマイナーのログ検索
  async searchMinerLogs(
    minerAddress: string,
    options: {
      from?: Date;
      to?: Date;
      level?: string;
      size?: number;
    } = {}
  ): Promise<any> {
    const query: SearchQuery = {
      index: this.config.indices.logs,
      query: `minerAddress:"${minerAddress}"${options.level ? ` AND level:${options.level}` : ''}`,
      size: options.size || 100,
      sort: [{ '@timestamp': 'desc' }],
      dateRange: {
        field: '@timestamp',
        gte: options.from || new Date(Date.now() - 24 * 60 * 60 * 1000), // 24時間前
        lte: options.to || new Date()
      }
    };
    
    return this.search(query);
  }
  
  // エラーログの統計
  async getErrorStats(
    options: {
      from?: Date;
      to?: Date;
      groupBy?: string;
    } = {}
  ): Promise<any> {
    const query: SearchQuery = {
      index: this.config.indices.logs,
      query: 'level:error',
      size: 0,
      dateRange: {
        field: '@timestamp',
        gte: options.from || new Date(Date.now() - 24 * 60 * 60 * 1000),
        lte: options.to || new Date()
      },
      aggregations: {
        errors_over_time: {
          date_histogram: {
            field: '@timestamp',
            fixed_interval: '1h'
          }
        },
        by_component: {
          terms: {
            field: 'component',
            size: 20
          }
        },
        by_error_code: {
          terms: {
            field: 'error.code',
            size: 20
          }
        }
      }
    };
    
    if (options.groupBy) {
      query.aggregations[`by_${options.groupBy}`] = {
        terms: {
          field: options.groupBy,
          size: 50
        }
      };
    }
    
    return this.search(query);
  }
  
  // Kibanaダッシュボードの作成
  async createKibanaDashboards(): Promise<void> {
    if (!this.config.kibana || !this.config.kibana.dashboards) return;
    
    // Kibana API を使用してダッシュボードを作成
    // 実装は Kibana のバージョンと設定に依存
    logger.info('Kibana dashboard creation not implemented');
  }
  
  // IDの生成
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
  
  // クリーンアップ
  async cleanup(): Promise<void> {
    if (this.bulkTimer) {
      clearInterval(this.bulkTimer);
    }
    
    // 残りのバルクアイテムをフラッシュ
    await this.flushBulk();
    
    // Elasticsearch接続を閉じる
    await this.esClient.close();
    
    logger.info('ELK Manager cleaned up');
  }
}

// === カスタムログフォーマッター ===
export class ELKLogFormatter {
  static format(info: any): any {
    const { timestamp, level, message, ...metadata } = info;
    
    return {
      '@timestamp': timestamp || new Date(),
      level,
      component: metadata.component || 'unknown',
      message,
      metadata: {
        ...metadata,
        hostname: require('os').hostname(),
        pid: process.pid,
        version: process.env.APP_VERSION || '1.0.0'
      }
    };
  }
}

// === プリセット検索クエリ ===
export const SearchPresets = {
  // 最近のエラー
  recentErrors: (hours = 24): SearchQuery => ({
    query: 'level:error',
    size: 100,
    sort: [{ '@timestamp': 'desc' }],
    dateRange: {
      field: '@timestamp',
      gte: new Date(Date.now() - hours * 60 * 60 * 1000)
    }
  }),
  
  // マイナーアクティビティ
  minerActivity: (minerAddress: string, days = 7): SearchQuery => ({
    query: `minerAddress:"${minerAddress}"`,
    size: 500,
    sort: [{ '@timestamp': 'desc' }],
    dateRange: {
      field: '@timestamp',
      gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    }
  }),
  
  // ブロック発見
  blockFinds: (days = 30): SearchQuery => ({
    query: 'event.type:block AND event.action:found',
    index: 'otedama-audit',
    size: 100,
    sort: [{ '@timestamp': 'desc' }],
    dateRange: {
      field: '@timestamp',
      gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    }
  }),
  
  // パフォーマンスメトリクス
  performanceMetrics: (metricName: string, hours = 24): SearchQuery => ({
    query: `metric.name:"${metricName}"`,
    index: 'otedama-metrics',
    size: 0,
    dateRange: {
      field: '@timestamp',
      gte: new Date(Date.now() - hours * 60 * 60 * 1000)
    },
    aggregations: {
      stats: {
        stats: {
          field: 'metric.value'
        }
      },
      over_time: {
        date_histogram: {
          field: '@timestamp',
          fixed_interval: '5m'
        },
        aggs: {
          avg_value: {
            avg: {
              field: 'metric.value'
            }
          }
        }
      }
    }
  })
};

// === 使用例 ===
/*
// ELK Manager の初期化
const elkManager = new ELKManager({
  elasticsearch: {
    nodes: ['http://localhost:9200'],
    auth: {
      username: 'elastic',
      password: 'changeme'
    }
  },
  logstash: {
    host: 'localhost',
    port: 5000
  },
  indices: {
    logs: 'otedama-logs',
    metrics: 'otedama-metrics',
    traces: 'otedama-traces',
    audit: 'otedama-audit'
  },
  retention: {
    logs: 30,      // 30日
    metrics: 7,    // 7日
    traces: 3,     // 3日
    audit: 365     // 1年
  }
});

// 初期化
await elkManager.initialize();

// ログの記録
await elkManager.log({
  timestamp: new Date(),
  level: 'info',
  component: 'stratum-server',
  message: 'New miner connected',
  metadata: {
    minerAddress: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    workerName: 'worker1',
    version: '1.0.0'
  }
});

// メトリクスの記録
await elkManager.logMetric({
  name: 'pool.hashrate',
  value: 1234567890,
  unit: 'hashes/s',
  labels: {
    pool: 'main',
    algorithm: 'sha256'
  }
});

// エラーログの検索
const errors = await elkManager.searchMinerLogs('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', {
  level: 'error',
  from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 過去7日
});

// エラー統計の取得
const errorStats = await elkManager.getErrorStats({
  groupBy: 'component'
});
*/

export default ELKManager;