// src/performance/database-profiler.ts
import { Logger } from '../logging/logger';
import { RedisCache } from '../cache/redis-cache';
import { performance } from 'perf_hooks';
import { EventEmitter } from 'events';
import crypto from 'crypto';

export interface DatabaseQuery {
  id: string;
  sql: string;
  normalizedSql: string;
  hash: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  database: string;
  table?: string;
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'DROP' | 'ALTER' | 'UNKNOWN';
  rowsAffected: number;
  rowsExamined: number;
  parameters?: any[];
  executionPlan?: QueryExecutionPlan;
  error?: string;
  cache: {
    hit: boolean;
    key?: string;
  };
  connection: {
    pool: string;
    id: string;
  };
  caller?: string;
}

export interface QueryExecutionPlan {
  type: string;
  cost: number;
  rows: number;
  time: number;
  table: string;
  key?: string;
  keyLength?: number;
  ref?: string;
  extra?: string;
  children?: QueryExecutionPlan[];
}

export interface DatabaseProfilerConfig {
  enabled: boolean;
  captureQueries: boolean;
  captureExecutionPlans: boolean;
  maxQueries: number;
  slowQueryThreshold: number; // milliseconds
  sampleRate: number; // 0.0 to 1.0
  normalizeQueries: boolean;
  thresholds: {
    duration: number; // milliseconds
    rowsExamined: number;
    errorRate: number; // percentage
  };
  analysis: {
    enabled: boolean;
    patternDetection: boolean;
    indexSuggestions: boolean;
  };
}

export interface QueryPattern {
  normalizedSql: string;
  hash: string;
  count: number;
  avgDuration: number;
  maxDuration: number;
  minDuration: number;
  totalDuration: number;
  errorCount: number;
  lastSeen: number;
  tables: string[];
  operation: string;
  improvement: {
    potential: 'high' | 'medium' | 'low';
    suggestions: string[];
    impact: number; // estimated time savings in ms
  };
}

export interface DatabaseMetrics {
  timestamp: number;
  connections: {
    active: number;
    idle: number;
    total: number;
    waitingForConnection: number;
  };
  queries: {
    total: number;
    successful: number;
    failed: number;
    cached: number;
    qps: number; // queries per second
  };
  performance: {
    avgDuration: number;
    p50Duration: number;
    p95Duration: number;
    p99Duration: number;
    slowQueries: number;
  };
  tables: Record<string, {
    reads: number;
    writes: number;
    avgReadTime: number;
    avgWriteTime: number;
  }>;
}

export interface IndexSuggestion {
  table: string;
  columns: string[];
  type: 'single' | 'composite' | 'covering';
  reason: string;
  impact: 'high' | 'medium' | 'low';
  estimatedImprovement: number; // percentage
  queries: string[]; // query hashes that would benefit
  createStatement: string;
}

export interface DatabaseAnalysis {
  timeWindow: number;
  totalQueries: number;
  uniqueQueries: number;
  avgDuration: number;
  slowQueries: DatabaseQuery[];
  topQueries: QueryPattern[];
  errorRate: number;
  cacheHitRate: number;
  indexSuggestions: IndexSuggestion[];
  bottlenecks: string[];
  recommendations: string[];
}

export interface QueryAlert {
  type: 'slow_query' | 'high_error_rate' | 'connection_exhaustion' | 'deadlock';
  timestamp: number;
  query?: DatabaseQuery;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: any;
}

export class DatabaseProfiler extends EventEmitter {
  private logger: Logger;
  private cache: RedisCache;
  private config: DatabaseProfilerConfig;
  private isActive: boolean = false;
  private queries: DatabaseQuery[] = [];
  private queryPatterns: Map<string, QueryPattern> = new Map();
  private metrics: DatabaseMetrics[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private activeQueries: Map<string, DatabaseQuery> = new Map();
  private connectionPools: Map<string, any> = new Map();

  constructor(config: DatabaseProfilerConfig, logger: Logger, cache: RedisCache) {
    super();
    this.config = config;
    this.logger = logger;
    this.cache = cache;

    if (config.enabled) {
      this.initialize();
    }
  }

  private initialize(): void {
    this.startMetricsCollection();
    
    if (this.config.analysis.enabled) {
      this.startPatternAnalysis();
    }

    this.logger.info('Database profiler initialized', {
      captureQueries: this.config.captureQueries,
      sampleRate: this.config.sampleRate,
      slowQueryThreshold: this.config.slowQueryThreshold
    });
  }

  private startMetricsCollection(): void {
    const timer = setInterval(() => {
      if (!this.isActive) return;

      const metrics = this.collectDatabaseMetrics();
      this.metrics.push(metrics);

      // Limit metrics
      if (this.metrics.length > 1000) {
        this.metrics = this.metrics.slice(-1000);
      }

      this.emit('database-metrics', metrics);
    }, 10000); // Every 10 seconds

    this.timers.set('metrics-collection', timer);
  }

  private startPatternAnalysis(): void {
    const timer = setInterval(() => {
      if (!this.isActive) return;

      this.analyzeQueryPatterns();
      
      if (this.config.analysis.indexSuggestions) {
        this.generateIndexSuggestions();
      }
    }, 60000); // Every minute

    this.timers.set('pattern-analysis', timer);
  }

  private collectDatabaseMetrics(): DatabaseMetrics {
    const recentQueries = this.queries.filter(
      q => q.endTime && (Date.now() - q.endTime) < 60000 // Last minute
    );

    const durations = recentQueries
      .filter(q => q.duration !== undefined)
      .map(q => q.duration!);

    const tableStats: Record<string, any> = {};
    recentQueries.forEach(query => {
      if (!query.table) return;
      
      if (!tableStats[query.table]) {
        tableStats[query.table] = {
          reads: 0,
          writes: 0,
          readTimes: [],
          writeTimes: []
        };
      }

      if (query.operation === 'SELECT') {
        tableStats[query.table].reads++;
        if (query.duration) {
          tableStats[query.table].readTimes.push(query.duration);
        }
      } else if (['INSERT', 'UPDATE', 'DELETE'].includes(query.operation)) {
        tableStats[query.table].writes++;
        if (query.duration) {
          tableStats[query.table].writeTimes.push(query.duration);
        }
      }
    });

    // Calculate table averages
    const tables: Record<string, any> = {};
    for (const [table, stats] of Object.entries(tableStats)) {
      const s = stats as any;
      tables[table] = {
        reads: s.reads,
        writes: s.writes,
        avgReadTime: s.readTimes.length > 0 
          ? s.readTimes.reduce((sum: number, t: number) => sum + t, 0) / s.readTimes.length 
          : 0,
        avgWriteTime: s.writeTimes.length > 0 
          ? s.writeTimes.reduce((sum: number, t: number) => sum + t, 0) / s.writeTimes.length 
          : 0
      };
    }

    return {
      timestamp: Date.now(),
      connections: {
        active: this.activeQueries.size,
        idle: 0, // Would track from connection pools
        total: 0, // Would track from connection pools
        waitingForConnection: 0 // Would track from connection pools
      },
      queries: {
        total: recentQueries.length,
        successful: recentQueries.filter(q => !q.error).length,
        failed: recentQueries.filter(q => q.error).length,
        cached: recentQueries.filter(q => q.cache.hit).length,
        qps: recentQueries.length / 60
      },
      performance: {
        avgDuration: durations.length > 0 
          ? durations.reduce((sum, d) => sum + d, 0) / durations.length 
          : 0,
        p50Duration: this.percentile(durations, 50),
        p95Duration: this.percentile(durations, 95),
        p99Duration: this.percentile(durations, 99),
        slowQueries: recentQueries.filter(q => 
          q.duration && q.duration > this.config.slowQueryThreshold
        ).length
      },
      tables
    };
  }

  private analyzeQueryPatterns(): void {
    // Group queries by normalized SQL
    const patterns = new Map<string, DatabaseQuery[]>();
    
    this.queries.forEach(query => {
      const hash = query.hash;
      if (!patterns.has(hash)) {
        patterns.set(hash, []);
      }
      patterns.get(hash)!.push(query);
    });

    // Update query patterns
    for (const [hash, queries] of patterns.entries()) {
      if (queries.length === 0) continue;

      const durations = queries
        .filter(q => q.duration !== undefined)
        .map(q => q.duration!);

      const tables = [...new Set(queries.map(q => q.table).filter(Boolean))];
      const errorCount = queries.filter(q => q.error).length;

      const pattern: QueryPattern = {
        normalizedSql: queries[0].normalizedSql,
        hash,
        count: queries.length,
        avgDuration: durations.length > 0 
          ? durations.reduce((sum, d) => sum + d, 0) / durations.length 
          : 0,
        maxDuration: Math.max(...durations, 0),
        minDuration: Math.min(...durations, Infinity) === Infinity ? 0 : Math.min(...durations),
        totalDuration: durations.reduce((sum, d) => sum + d, 0),
        errorCount,
        lastSeen: Math.max(...queries.map(q => q.endTime || q.startTime)),
        tables,
        operation: queries[0].operation,
        improvement: {
          potential: this.assessImprovementPotential(queries),
          suggestions: this.generateQuerySuggestions(queries[0]),
          impact: this.calculateImprovementImpact(queries)
        }
      };

      this.queryPatterns.set(hash, pattern);
    }

    // Emit alerts for problematic patterns
    this.checkQueryPatternAlerts();
  }

  private assessImprovementPotential(queries: DatabaseQuery[]): 'high' | 'medium' | 'low' {
    const avgDuration = queries
      .filter(q => q.duration)
      .reduce((sum, q) => sum + q.duration!, 0) / queries.length;

    const avgRowsExamined = queries.reduce((sum, q) => sum + q.rowsExamined, 0) / queries.length;

    if (avgDuration > this.config.slowQueryThreshold && avgRowsExamined > 1000) {
      return 'high';
    } else if (avgDuration > this.config.slowQueryThreshold * 0.5 || avgRowsExamined > 500) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  private generateQuerySuggestions(query: DatabaseQuery): string[] {
    const suggestions: string[] = [];

    // Check for SELECT *
    if (query.sql.includes('SELECT *')) {
      suggestions.push('Avoid SELECT * - specify only needed columns');
    }

    // Check for missing WHERE clause in SELECT
    if (query.operation === 'SELECT' && !query.sql.toUpperCase().includes('WHERE')) {
      suggestions.push('Consider adding WHERE clause to limit results');
    }

    // Check for missing LIMIT
    if (query.operation === 'SELECT' && !query.sql.toUpperCase().includes('LIMIT')) {
      suggestions.push('Consider adding LIMIT to prevent large result sets');
    }

    // Check for subqueries
    if (query.sql.includes('(SELECT')) {
      suggestions.push('Consider optimizing subqueries with JOINs');
    }

    // Check for high rows examined ratio
    if (query.rowsExamined > query.rowsAffected * 10) {
      suggestions.push('High rows examined ratio - consider adding indexes');
    }

    return suggestions;
  }

  private calculateImprovementImpact(queries: DatabaseQuery[]): number {
    const totalTime = queries
      .filter(q => q.duration)
      .reduce((sum, q) => sum + q.duration!, 0);

    // Estimate potential improvement based on query characteristics
    const avgRowsExamined = queries.reduce((sum, q) => sum + q.rowsExamined, 0) / queries.length;
    
    if (avgRowsExamined > 10000) {
      return totalTime * 0.7; // 70% improvement potential
    } else if (avgRowsExamined > 1000) {
      return totalTime * 0.5; // 50% improvement potential
    } else {
      return totalTime * 0.2; // 20% improvement potential
    }
  }

  private checkQueryPatternAlerts(): void {
    for (const pattern of this.queryPatterns.values()) {
      // Check for slow query patterns
      if (pattern.avgDuration > this.config.thresholds.duration && pattern.count > 5) {
        this.emit('query-alert', {
          type: 'slow_query',
          timestamp: Date.now(),
          message: `Slow query pattern detected: ${pattern.normalizedSql.substring(0, 100)}... (avg: ${pattern.avgDuration.toFixed(2)}ms, count: ${pattern.count})`,
          severity: pattern.avgDuration > this.config.thresholds.duration * 2 ? 'high' : 'medium',
          details: { pattern }
        } as QueryAlert);
      }

      // Check for high error rate
      if (pattern.count > 0) {
        const errorRate = (pattern.errorCount / pattern.count) * 100;
        if (errorRate > this.config.thresholds.errorRate) {
          this.emit('query-alert', {
            type: 'high_error_rate',
            timestamp: Date.now(),
            message: `High error rate for query pattern: ${errorRate.toFixed(1)}% (${pattern.errorCount}/${pattern.count})`,
            severity: errorRate > 50 ? 'critical' : 'high',
            details: { pattern, errorRate }
          } as QueryAlert);
        }
      }
    }
  }

  private generateIndexSuggestions(): void {
    const suggestions: IndexSuggestion[] = [];
    
    // Analyze slow queries for indexing opportunities
    const slowQueries = this.queries.filter(q => 
      q.duration && q.duration > this.config.slowQueryThreshold &&
      q.operation === 'SELECT'
    );

    const tableQueries = new Map<string, DatabaseQuery[]>();
    slowQueries.forEach(query => {
      if (!query.table) return;
      
      if (!tableQueries.has(query.table)) {
        tableQueries.set(query.table, []);
      }
      tableQueries.get(query.table)!.push(query);
    });

    for (const [table, queries] of tableQueries.entries()) {
      const columns = this.extractWhereColumns(queries);
      
      if (columns.length > 0) {
        suggestions.push({
          table,
          columns,
          type: columns.length === 1 ? 'single' : 'composite',
          reason: `Frequently used in WHERE clauses (${queries.length} slow queries)`,
          impact: this.calculateIndexImpact(queries),
          estimatedImprovement: this.estimateIndexImprovement(queries),
          queries: queries.map(q => q.hash),
          createStatement: `CREATE INDEX idx_${table}_${columns.join('_')} ON ${table} (${columns.join(', ')})`
        });
      }
    }

    if (suggestions.length > 0) {
      this.emit('index-suggestions', suggestions);
    }
  }

  private extractWhereColumns(queries: DatabaseQuery[]): string[] {
    const columnCounts = new Map<string, number>();
    
    queries.forEach(query => {
      // Simplified column extraction from WHERE clauses
      const whereMatch = query.sql.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+GROUP|\s+LIMIT|$)/i);
      if (whereMatch) {
        const whereClause = whereMatch[1];
        // Extract column names (simplified regex)
        const columns = whereClause.match(/\b\w+\s*[=<>]/g);
        if (columns) {
          columns.forEach(col => {
            const colName = col.replace(/\s*[=<>].*/, '').trim();
            columnCounts.set(colName, (columnCounts.get(colName) || 0) + 1);
          });
        }
      }
    });

    // Return columns used in at least 20% of queries
    const threshold = Math.max(1, Math.floor(queries.length * 0.2));
    return Array.from(columnCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3) // Max 3 columns for composite index
      .map(([col, _]) => col);
  }

  private calculateIndexImpact(queries: DatabaseQuery[]): 'high' | 'medium' | 'low' {
    const totalTime = queries.reduce((sum, q) => sum + (q.duration || 0), 0);
    const avgRowsExamined = queries.reduce((sum, q) => sum + q.rowsExamined, 0) / queries.length;

    if (totalTime > 10000 && avgRowsExamined > 10000) {
      return 'high';
    } else if (totalTime > 5000 || avgRowsExamined > 1000) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  private estimateIndexImprovement(queries: DatabaseQuery[]): number {
    const avgRowsExamined = queries.reduce((sum, q) => sum + q.rowsExamined, 0) / queries.length;
    
    // Estimate improvement based on rows examined reduction
    if (avgRowsExamined > 100000) {
      return 80; // 80% improvement
    } else if (avgRowsExamined > 10000) {
      return 60; // 60% improvement
    } else if (avgRowsExamined > 1000) {
      return 40; // 40% improvement
    } else {
      return 20; // 20% improvement
    }
  }

  // Public API for query tracking
  public startQuery(
    sql: string,
    database: string,
    parameters?: any[],
    caller?: string
  ): string {
    if (!this.config.captureQueries || Math.random() > this.config.sampleRate) {
      return '';
    }

    const queryId = this.generateQueryId();
    const normalizedSql = this.config.normalizeQueries ? this.normalizeSql(sql) : sql;
    const hash = crypto.createHash('sha256').update(normalizedSql).digest('hex').substring(0, 16);

    const query: DatabaseQuery = {
      id: queryId,
      sql,
      normalizedSql,
      hash,
      startTime: performance.now(),
      database,
      table: this.extractTableName(sql),
      operation: this.extractOperation(sql),
      rowsAffected: 0,
      rowsExamined: 0,
      parameters,
      cache: { hit: false },
      connection: {
        pool: 'default',
        id: 'unknown'
      },
      caller
    };

    this.activeQueries.set(queryId, query);
    return queryId;
  }

  public endQuery(
    queryId: string,
    rowsAffected: number = 0,
    rowsExamined: number = 0,
    error?: string,
    executionPlan?: QueryExecutionPlan
  ): void {
    const query = this.activeQueries.get(queryId);
    if (!query) return;

    query.endTime = performance.now();
    query.duration = query.endTime - query.startTime;
    query.rowsAffected = rowsAffected;
    query.rowsExamined = rowsExamined;
    query.error = error;
    query.executionPlan = executionPlan;

    this.activeQueries.delete(queryId);
    this.queries.push(query);

    // Limit stored queries
    if (this.queries.length > this.config.maxQueries) {
      this.queries = this.queries.slice(-this.config.maxQueries);
    }

    // Check thresholds
    this.checkQueryThresholds(query);

    this.emit('query-completed', query);
  }

  public profileQuery<T>(
    sql: string,
    database: string,
    queryFn: () => Promise<T>,
    parameters?: any[]
  ): Promise<T> {
    const queryId = this.startQuery(sql, database, parameters);
    
    return queryFn()
      .then(result => {
        this.endQuery(queryId);
        return result;
      })
      .catch(error => {
        this.endQuery(queryId, 0, 0, error.message);
        throw error;
      });
  }

  private checkQueryThresholds(query: DatabaseQuery): void {
    // Check slow query threshold
    if (query.duration && query.duration > this.config.thresholds.duration) {
      this.emit('query-alert', {
        type: 'slow_query',
        timestamp: Date.now(),
        query,
        message: `Slow query detected: ${query.duration.toFixed(2)}ms - ${query.sql.substring(0, 100)}...`,
        severity: query.duration > this.config.thresholds.duration * 2 ? 'high' : 'medium',
        details: { duration: query.duration, threshold: this.config.thresholds.duration }
      } as QueryAlert);
    }

    // Check rows examined threshold
    if (query.rowsExamined > this.config.thresholds.rowsExamined) {
      this.emit('query-alert', {
        type: 'slow_query',
        timestamp: Date.now(),
        query,
        message: `Query examined too many rows: ${query.rowsExamined} - ${query.sql.substring(0, 100)}...`,
        severity: 'medium',
        details: { rowsExamined: query.rowsExamined, threshold: this.config.thresholds.rowsExamined }
      } as QueryAlert);
    }
  }

  // Utility methods
  private generateQueryId(): string {
    return `query_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private normalizeSql(sql: string): string {
    return sql
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/\b\d+\b/g, '?') // Replace numbers with placeholders
      .replace(/'[^']*'/g, '?') // Replace string literals with placeholders
      .replace(/\?\s*,\s*\?/g, '?') // Collapse multiple placeholders
      .trim()
      .toUpperCase();
  }

  private extractTableName(sql: string): string | undefined {
    // Simplified table name extraction
    const fromMatch = sql.match(/\bFROM\s+`?(\w+)`?/i);
    if (fromMatch) return fromMatch[1];

    const intoMatch = sql.match(/\bINTO\s+`?(\w+)`?/i);
    if (intoMatch) return intoMatch[1];

    const updateMatch = sql.match(/\bUPDATE\s+`?(\w+)`?/i);
    if (updateMatch) return updateMatch[1];

    const deleteMatch = sql.match(/\bDELETE\s+FROM\s+`?(\w+)`?/i);
    if (deleteMatch) return deleteMatch[1];

    return undefined;
  }

  private extractOperation(sql: string): DatabaseQuery['operation'] {
    const trimmed = sql.trim().toUpperCase();
    
    if (trimmed.startsWith('SELECT')) return 'SELECT';
    if (trimmed.startsWith('INSERT')) return 'INSERT';
    if (trimmed.startsWith('UPDATE')) return 'UPDATE';
    if (trimmed.startsWith('DELETE')) return 'DELETE';
    if (trimmed.startsWith('CREATE')) return 'CREATE';
    if (trimmed.startsWith('DROP')) return 'DROP';
    if (trimmed.startsWith('ALTER')) return 'ALTER';
    
    return 'UNKNOWN';
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  // Public API
  public start(): void {
    this.isActive = true;
    this.logger.info('Database profiler started');
  }

  public stop(): void {
    this.isActive = false;
    this.logger.info('Database profiler stopped');
  }

  public getQueries(count?: number): DatabaseQuery[] {
    if (count) {
      return this.queries.slice(-count);
    }
    return [...this.queries];
  }

  public getSlowQueries(threshold?: number): DatabaseQuery[] {
    const thresholdMs = threshold || this.config.slowQueryThreshold;
    return this.queries.filter(q => q.duration && q.duration > thresholdMs);
  }

  public getQueryPatterns(): QueryPattern[] {
    return Array.from(this.queryPatterns.values())
      .sort((a, b) => b.totalDuration - a.totalDuration);
  }

  public getMetrics(count?: number): DatabaseMetrics[] {
    if (count) {
      return this.metrics.slice(-count);
    }
    return [...this.metrics];
  }

  public analyzeDatabase(timeWindowMinutes: number = 30): DatabaseAnalysis {
    const windowMs = timeWindowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    const relevantQueries = this.queries.filter(q => 
      q.endTime && q.endTime >= cutoff
    );

    if (relevantQueries.length === 0) {
      return this.createEmptyAnalysis(timeWindowMinutes);
    }

    const uniqueQueries = new Set(relevantQueries.map(q => q.hash)).size;
    const durations = relevantQueries.filter(q => q.duration).map(q => q.duration!);
    const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;

    const slowQueries = relevantQueries
      .filter(q => q.duration && q.duration > this.config.slowQueryThreshold)
      .sort((a, b) => (b.duration || 0) - (a.duration || 0))
      .slice(0, 20);

    const topPatterns = Array.from(this.queryPatterns.values())
      .filter(p => p.lastSeen >= cutoff)
      .sort((a, b) => b.totalDuration - a.totalDuration)
      .slice(0, 10);

    const errorQueries = relevantQueries.filter(q => q.error);
    const errorRate = (errorQueries.length / relevantQueries.length) * 100;

    const cachedQueries = relevantQueries.filter(q => q.cache.hit);
    const cacheHitRate = (cachedQueries.length / relevantQueries.length) * 100;

    const bottlenecks = this.identifyBottlenecks(relevantQueries);
    const recommendations = this.generateRecommendations(relevantQueries, topPatterns);

    return {
      timeWindow: timeWindowMinutes,
      totalQueries: relevantQueries.length,
      uniqueQueries,
      avgDuration,
      slowQueries,
      topQueries: topPatterns,
      errorRate,
      cacheHitRate,
      indexSuggestions: [], // Would be populated from generateIndexSuggestions
      bottlenecks,
      recommendations
    };
  }

  private identifyBottlenecks(queries: DatabaseQuery[]): string[] {
    const bottlenecks: string[] = [];

    // High average duration
    const durations = queries.filter(q => q.duration).map(q => q.duration!);
    const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    
    if (avgDuration > this.config.thresholds.duration) {
      bottlenecks.push('High average query duration');
    }

    // High rows examined
    const avgRowsExamined = queries.reduce((sum, q) => sum + q.rowsExamined, 0) / queries.length;
    if (avgRowsExamined > this.config.thresholds.rowsExamined) {
      bottlenecks.push('High average rows examined');
    }

    // Slow query frequency
    const slowQueries = queries.filter(q => 
      q.duration && q.duration > this.config.slowQueryThreshold
    );
    if (slowQueries.length > queries.length * 0.1) {
      bottlenecks.push('High slow query frequency');
    }

    return bottlenecks;
  }

  private generateRecommendations(queries: DatabaseQuery[], patterns: QueryPattern[]): string[] {
    const recommendations: string[] = [];

    // Slow query recommendations
    const slowQueries = queries.filter(q => 
      q.duration && q.duration > this.config.slowQueryThreshold
    );
    if (slowQueries.length > 0) {
      recommendations.push(`Optimize ${slowQueries.length} slow queries detected`);
    }

    // High-impact pattern recommendations
    const highImpactPatterns = patterns.filter(p => p.improvement.potential === 'high');
    if (highImpactPatterns.length > 0) {
      recommendations.push(`Address ${highImpactPatterns.length} high-impact query patterns`);
    }

    // Error rate recommendations
    const errorQueries = queries.filter(q => q.error);
    if (errorQueries.length > 0) {
      recommendations.push(`Investigate ${errorQueries.length} failed queries`);
    }

    // Cache recommendations
    const cacheableQueries = queries.filter(q => 
      q.operation === 'SELECT' && !q.cache.hit
    );
    if (cacheableQueries.length > queries.length * 0.8) {
      recommendations.push('Consider implementing query result caching');
    }

    return recommendations;
  }

  private createEmptyAnalysis(timeWindow: number): DatabaseAnalysis {
    return {
      timeWindow,
      totalQueries: 0,
      uniqueQueries: 0,
      avgDuration: 0,
      slowQueries: [],
      topQueries: [],
      errorRate: 0,
      cacheHitRate: 0,
      indexSuggestions: [],
      bottlenecks: [],
      recommendations: ['Insufficient data for analysis']
    };
  }

  public getDatabaseReport(): string {
    const analysis = this.analyzeDatabase(30);
    const latest = this.metrics[this.metrics.length - 1];

    return `Database Report:
- Total Queries (30m): ${analysis.totalQueries}
- Unique Queries: ${analysis.uniqueQueries}
- Average Duration: ${analysis.avgDuration.toFixed(2)}ms
- Slow Queries: ${analysis.slowQueries.length}
- Error Rate: ${analysis.errorRate.toFixed(1)}%
- Cache Hit Rate: ${analysis.cacheHitRate.toFixed(1)}%
- Active Connections: ${latest?.connections.active || 0}
- QPS: ${latest?.queries.qps?.toFixed(2) || 0}
- Query Patterns: ${this.queryPatterns.size}`;
  }

  public clearOldData(maxAge: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAge;
    const originalLength = this.queries.length;
    
    this.queries = this.queries.filter(query => 
      query.endTime && query.endTime >= cutoff
    );

    this.metrics = this.metrics.filter(metric => 
      metric.timestamp >= cutoff
    );

    // Clear old patterns
    for (const [hash, pattern] of this.queryPatterns.entries()) {
      if (pattern.lastSeen < cutoff) {
        this.queryPatterns.delete(hash);
      }
    }

    const removed = originalLength - this.queries.length;
    if (removed > 0) {
      this.logger.info(`Cleared ${removed} old database queries`);
    }
    
    return removed;
  }

  public destroy(): void {
    this.isActive = false;
    
    // Clear timers
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();

    // Clear data
    this.queries = [];
    this.queryPatterns.clear();
    this.metrics = [];
    this.activeQueries.clear();

    this.logger.info('Database profiler destroyed');
  }
}
