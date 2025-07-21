/**
 * Database Query Optimizer for Otedama
 * Advanced query optimization and analysis
 * 
 * Design principles:
 * - Carmack: Minimize query execution time
 * - Martin: Clean query building and caching
 * - Pike: Simple but effective optimization
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

// Query types
export const QueryType = {
  SELECT: 'SELECT',
  INSERT: 'INSERT',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  AGGREGATE: 'AGGREGATE'
};

// Optimization strategies
export const OptimizationStrategy = {
  INDEX_SCAN: 'index_scan',
  FULL_SCAN: 'full_scan',
  COVERING_INDEX: 'covering_index',
  QUERY_REWRITE: 'query_rewrite',
  BATCH_OPERATION: 'batch_operation',
  PREPARED_STATEMENT: 'prepared_statement'
};

/**
 * Query plan cache entry
 */
class QueryPlan {
  constructor(query, plan, stats = {}) {
    this.query = query;
    this.plan = plan;
    this.stats = {
      executionTime: stats.executionTime || 0,
      rowsExamined: stats.rowsExamined || 0,
      rowsReturned: stats.rowsReturned || 0,
      usedIndexes: stats.usedIndexes || [],
      cost: stats.cost || 0
    };
    this.createdAt = Date.now();
    this.lastUsed = Date.now();
    this.useCount = 0;
  }
  
  update(stats) {
    // Update statistics with moving average
    const alpha = 0.7; // Weight for new value
    this.stats.executionTime = alpha * stats.executionTime + (1 - alpha) * this.stats.executionTime;
    this.stats.rowsExamined = Math.round(alpha * stats.rowsExamined + (1 - alpha) * this.stats.rowsExamined);
    this.stats.rowsReturned = Math.round(alpha * stats.rowsReturned + (1 - alpha) * this.stats.rowsReturned);
    this.stats.cost = alpha * stats.cost + (1 - alpha) * this.stats.cost;
    
    this.lastUsed = Date.now();
    this.useCount++;
  }
  
  getScore() {
    // Lower score is better
    const timeFactor = this.stats.executionTime;
    const examineRatio = this.stats.rowsExamined / Math.max(1, this.stats.rowsReturned);
    const ageFactor = (Date.now() - this.createdAt) / (1000 * 60 * 60); // Hours
    
    return timeFactor * examineRatio * (1 + ageFactor * 0.1);
  }
}

/**
 * Query optimizer
 */
export class QueryOptimizer extends EventEmitter {
  constructor(db, options = {}) {
    super();
    
    this.db = db;
    this.config = {
      // Plan cache
      planCacheSize: options.planCacheSize || 1000,
      planCacheTTL: options.planCacheTTL || 3600000, // 1 hour
      
      // Query analysis
      analyzeThreshold: options.analyzeThreshold || 100, // ms
      slowQueryLog: options.slowQueryLog !== false,
      explainSlowQueries: options.explainSlowQueries !== false,
      
      // Optimization
      rewriteQueries: options.rewriteQueries !== false,
      usePreparedStatements: options.usePreparedStatements !== false,
      batchSize: options.batchSize || 1000,
      
      // Index recommendations
      suggestIndexes: options.suggestIndexes !== false,
      indexAnalysisInterval: options.indexAnalysisInterval || 3600000, // 1 hour
      
      // Statistics
      collectStats: options.collectStats !== false,
      statsRetention: options.statsRetention || 86400000 // 24 hours
    };
    
    // Query plan cache
    this.planCache = new Map();
    
    // Prepared statements cache
    this.preparedStatements = new Map();
    
    // Query statistics
    this.queryStats = new Map();
    
    // Slow query log
    this.slowQueries = [];
    
    // Index usage statistics
    this.indexStats = new Map();
    
    // Start periodic tasks
    this.startPeriodicTasks();
  }
  
  /**
   * Optimize and execute query
   */
  async query(sql, params = [], options = {}) {
    const startTime = Date.now();
    const queryHash = this.hashQuery(sql, params);
    
    try {
      // Check if query should be rewritten
      if (this.config.rewriteQueries) {
        sql = this.rewriteQuery(sql, params);
      }
      
      // Get or create execution plan
      const plan = await this.getExecutionPlan(sql, queryHash);
      
      // Execute query
      let result;
      if (this.config.usePreparedStatements && this.isPreparedStatementCandidate(sql)) {
        result = await this.executePrepared(sql, params);
      } else {
        result = await this.executeQuery(sql, params);
      }
      
      // Collect statistics
      const executionTime = Date.now() - startTime;
      this.collectQueryStats(sql, queryHash, executionTime, result);
      
      // Log slow queries
      if (executionTime > this.config.analyzeThreshold) {
        await this.analyzeSlowQuery(sql, params, executionTime, plan);
      }
      
      return result;
      
    } catch (error) {
      this.emit('error', { sql, params, error });
      throw error;
    }
  }
  
  /**
   * Execute multiple queries in batch
   */
  async batchQuery(queries, options = {}) {
    const batchSize = options.batchSize || this.config.batchSize;
    const results = [];
    
    // Group queries by type
    const grouped = this.groupQueriesByType(queries);
    
    for (const [type, group] of grouped) {
      if (this.canBatchType(type)) {
        // Execute in batches
        for (let i = 0; i < group.length; i += batchSize) {
          const batch = group.slice(i, i + batchSize);
          const batchResult = await this.executeBatch(type, batch);
          results.push(...batchResult);
        }
      } else {
        // Execute individually
        for (const query of group) {
          const result = await this.query(query.sql, query.params);
          results.push(result);
        }
      }
    }
    
    return results;
  }
  
  /**
   * Get execution plan for query
   */
  async getExecutionPlan(sql, queryHash) {
    // Check cache
    let plan = this.planCache.get(queryHash);
    
    if (plan && Date.now() - plan.createdAt < this.config.planCacheTTL) {
      plan.lastUsed = Date.now();
      plan.useCount++;
      return plan;
    }
    
    // Generate new plan
    const explainResult = await this.explainQuery(sql);
    const analyzedPlan = this.analyzePlan(explainResult);
    
    plan = new QueryPlan(sql, analyzedPlan);
    this.planCache.set(queryHash, plan);
    
    // Limit cache size
    if (this.planCache.size > this.config.planCacheSize) {
      this.evictOldestPlan();
    }
    
    return plan;
  }
  
  /**
   * Explain query execution plan
   */
  async explainQuery(sql) {
    try {
      const explainSql = `EXPLAIN QUERY PLAN ${sql}`;
      return await this.executeQuery(explainSql);
    } catch (error) {
      // Fallback if EXPLAIN not supported
      return [];
    }
  }
  
  /**
   * Analyze execution plan
   */
  analyzePlan(explainResult) {
    const plan = {
      steps: [],
      usedIndexes: [],
      scanType: OptimizationStrategy.FULL_SCAN,
      estimatedCost: 0
    };
    
    for (const row of explainResult) {
      const detail = row.detail || '';
      
      // Parse plan details
      if (detail.includes('USING INDEX')) {
        const indexMatch = detail.match(/USING INDEX (\w+)/);
        if (indexMatch) {
          plan.usedIndexes.push(indexMatch[1]);
          plan.scanType = OptimizationStrategy.INDEX_SCAN;
        }
      }
      
      if (detail.includes('USING COVERING INDEX')) {
        plan.scanType = OptimizationStrategy.COVERING_INDEX;
      }
      
      if (detail.includes('SCAN')) {
        plan.estimatedCost += 1000;
      } else if (detail.includes('SEARCH')) {
        plan.estimatedCost += 10;
      }
      
      plan.steps.push({
        id: row.id,
        parent: row.parent,
        detail: detail
      });
    }
    
    return plan;
  }
  
  /**
   * Rewrite query for optimization
   */
  rewriteQuery(sql, params) {
    let rewritten = sql;
    
    // Convert IN clauses with many values to temp table joins
    rewritten = this.optimizeInClauses(rewritten, params);
    
    // Add index hints where beneficial
    rewritten = this.addIndexHints(rewritten);
    
    // Optimize subqueries to joins
    rewritten = this.optimizeSubqueries(rewritten);
    
    // Add LIMIT to EXISTS queries
    rewritten = this.optimizeExists(rewritten);
    
    return rewritten;
  }
  
  /**
   * Optimize IN clauses
   */
  optimizeInClauses(sql, params) {
    const inClauseRegex = /\bIN\s*\([^)]+\)/gi;
    const matches = sql.match(inClauseRegex);
    
    if (!matches) return sql;
    
    for (const match of matches) {
      const valueCount = (match.match(/\?/g) || []).length;
      
      // Convert to temp table if too many values
      if (valueCount > 100) {
        // This would create a temp table in real implementation
        this.emit('optimization', {
          type: 'in_clause',
          original: match,
          valueCount
        });
      }
    }
    
    return sql;
  }
  
  /**
   * Add index hints
   */
  addIndexHints(sql) {
    // Analyze query structure and add hints
    const tableRegex = /FROM\s+(\w+)/gi;
    const tables = [...sql.matchAll(tableRegex)].map(m => m[1]);
    
    for (const table of tables) {
      const indexes = this.getTableIndexes(table);
      const bestIndex = this.selectBestIndex(sql, table, indexes);
      
      if (bestIndex) {
        // SQLite doesn't support index hints directly
        // This is for demonstration
        this.emit('optimization', {
          type: 'index_hint',
          table,
          index: bestIndex
        });
      }
    }
    
    return sql;
  }
  
  /**
   * Optimize subqueries
   */
  optimizeSubqueries(sql) {
    // Simple pattern matching for correlated subqueries
    const correlatedPattern = /SELECT.*WHERE.*\(SELECT.*WHERE.*=.*\.\w+\)/i;
    
    if (correlatedPattern.test(sql)) {
      this.emit('optimization', {
        type: 'correlated_subquery',
        recommendation: 'Consider rewriting as JOIN'
      });
    }
    
    return sql;
  }
  
  /**
   * Optimize EXISTS queries
   */
  optimizeExists(sql) {
    return sql.replace(
      /EXISTS\s*\(\s*SELECT\s+\*/gi,
      'EXISTS (SELECT 1'
    );
  }
  
  /**
   * Execute query with prepared statement
   */
  async executePrepared(sql, params) {
    const key = this.normalizeSQL(sql);
    
    let stmt = this.preparedStatements.get(key);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.preparedStatements.set(key, stmt);
      
      // Limit cache size
      if (this.preparedStatements.size > 100) {
        const firstKey = this.preparedStatements.keys().next().value;
        this.preparedStatements.delete(firstKey);
      }
    }
    
    return params.length > 0 ? stmt.all(...params) : stmt.all();
  }
  
  /**
   * Execute regular query
   */
  async executeQuery(sql, params = []) {
    if (params.length > 0) {
      const stmt = this.db.prepare(sql);
      return stmt.all(...params);
    } else {
      return this.db.prepare(sql).all();
    }
  }
  
  /**
   * Execute batch operation
   */
  async executeBatch(type, queries) {
    const results = [];
    
    // Use transaction for batch operations
    const transaction = this.db.transaction((queries) => {
      for (const query of queries) {
        const stmt = this.db.prepare(query.sql);
        const result = stmt.run(...(query.params || []));
        results.push(result);
      }
    });
    
    transaction(queries);
    return results;
  }
  
  /**
   * Collect query statistics
   */
  collectQueryStats(sql, queryHash, executionTime, result) {
    if (!this.config.collectStats) return;
    
    let stats = this.queryStats.get(queryHash);
    if (!stats) {
      stats = {
        sql: this.normalizeSQL(sql),
        count: 0,
        totalTime: 0,
        avgTime: 0,
        minTime: Infinity,
        maxTime: 0,
        lastExecuted: Date.now()
      };
      this.queryStats.set(queryHash, stats);
    }
    
    stats.count++;
    stats.totalTime += executionTime;
    stats.avgTime = stats.totalTime / stats.count;
    stats.minTime = Math.min(stats.minTime, executionTime);
    stats.maxTime = Math.max(stats.maxTime, executionTime);
    stats.lastExecuted = Date.now();
    
    // Update plan statistics
    const plan = this.planCache.get(queryHash);
    if (plan) {
      plan.update({
        executionTime,
        rowsReturned: Array.isArray(result) ? result.length : 1
      });
    }
  }
  
  /**
   * Analyze slow query
   */
  async analyzeSlowQuery(sql, params, executionTime, plan) {
    const analysis = {
      sql: this.normalizeSQL(sql),
      params: params.length > 0 ? params : undefined,
      executionTime,
      timestamp: Date.now(),
      plan: plan ? {
        scanType: plan.plan.scanType,
        usedIndexes: plan.plan.usedIndexes,
        estimatedCost: plan.plan.estimatedCost
      } : null,
      recommendations: []
    };
    
    // Generate recommendations
    if (!plan || plan.plan.scanType === OptimizationStrategy.FULL_SCAN) {
      analysis.recommendations.push('Consider adding an index');
    }
    
    if (executionTime > 1000) {
      analysis.recommendations.push('Query is extremely slow, consider restructuring');
    }
    
    if (sql.toLowerCase().includes('like \'%')) {
      analysis.recommendations.push('Leading wildcard in LIKE prevents index usage');
    }
    
    // Log slow query
    this.slowQueries.push(analysis);
    if (this.slowQueries.length > 1000) {
      this.slowQueries.shift();
    }
    
    this.emit('slow_query', analysis);
  }
  
  /**
   * Get index recommendations
   */
  async getIndexRecommendations() {
    const recommendations = [];
    
    // Analyze query patterns
    for (const [hash, stats] of this.queryStats) {
      if (stats.avgTime > 50 && stats.count > 10) {
        const sql = stats.sql;
        
        // Extract WHERE clause columns
        const whereColumns = this.extractWhereColumns(sql);
        
        // Extract JOIN columns
        const joinColumns = this.extractJoinColumns(sql);
        
        // Check if indexes exist
        for (const column of [...whereColumns, ...joinColumns]) {
          if (!this.hasIndex(column.table, column.column)) {
            recommendations.push({
              table: column.table,
              column: column.column,
              reason: `Used in ${stats.count} queries with avg time ${stats.avgTime.toFixed(2)}ms`,
              impact: stats.count * stats.avgTime
            });
          }
        }
      }
    }
    
    // Sort by impact
    recommendations.sort((a, b) => b.impact - a.impact);
    
    return recommendations;
  }
  
  /**
   * Utility methods
   */
  
  hashQuery(sql, params) {
    const normalized = this.normalizeSQL(sql);
    const data = normalized + JSON.stringify(params);
    return createHash('md5').update(data).digest('hex');
  }
  
  normalizeSQL(sql) {
    return sql
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),])\s*/g, '$1')
      .trim()
      .toLowerCase();
  }
  
  isPreparedStatementCandidate(sql) {
    const normalized = this.normalizeSQL(sql);
    return normalized.includes('?') && 
           !normalized.includes('explain') &&
           !normalized.includes('pragma');
  }
  
  groupQueriesByType(queries) {
    const grouped = new Map();
    
    for (const query of queries) {
      const type = this.getQueryType(query.sql);
      if (!grouped.has(type)) {
        grouped.set(type, []);
      }
      grouped.get(type).push(query);
    }
    
    return grouped;
  }
  
  getQueryType(sql) {
    const normalized = this.normalizeSQL(sql);
    
    if (normalized.startsWith('select')) return QueryType.SELECT;
    if (normalized.startsWith('insert')) return QueryType.INSERT;
    if (normalized.startsWith('update')) return QueryType.UPDATE;
    if (normalized.startsWith('delete')) return QueryType.DELETE;
    
    return 'OTHER';
  }
  
  canBatchType(type) {
    return type === QueryType.INSERT || 
           type === QueryType.UPDATE || 
           type === QueryType.DELETE;
  }
  
  extractWhereColumns(sql) {
    const columns = [];
    const whereMatch = sql.match(/WHERE\s+(.+?)(?:GROUP|ORDER|LIMIT|$)/i);
    
    if (whereMatch) {
      const whereClause = whereMatch[1];
      const columnPattern = /(\w+)\.(\w+)\s*[=<>]/g;
      let match;
      
      while ((match = columnPattern.exec(whereClause)) !== null) {
        columns.push({
          table: match[1],
          column: match[2]
        });
      }
    }
    
    return columns;
  }
  
  extractJoinColumns(sql) {
    const columns = [];
    const joinPattern = /JOIN\s+\w+\s+ON\s+(.+?)(?:JOIN|WHERE|GROUP|ORDER|LIMIT|$)/gi;
    let match;
    
    while ((match = joinPattern.exec(sql)) !== null) {
      const joinClause = match[1];
      const columnPattern = /(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/g;
      let colMatch;
      
      while ((colMatch = columnPattern.exec(joinClause)) !== null) {
        columns.push(
          { table: colMatch[1], column: colMatch[2] },
          { table: colMatch[3], column: colMatch[4] }
        );
      }
    }
    
    return columns;
  }
  
  getTableIndexes(table) {
    try {
      const indexes = this.db.prepare(
        `PRAGMA index_list('${table}')`
      ).all();
      
      return indexes.map(idx => ({
        name: idx.name,
        unique: idx.unique === 1,
        columns: this.db.prepare(
          `PRAGMA index_info('${idx.name}')`
        ).all().map(col => col.name)
      }));
    } catch (error) {
      return [];
    }
  }
  
  hasIndex(table, column) {
    const indexes = this.getTableIndexes(table);
    
    return indexes.some(idx => 
      idx.columns.includes(column) || 
      idx.columns[0] === column // Primary column in composite index
    );
  }
  
  selectBestIndex(sql, table, indexes) {
    // Simple heuristic: prefer unique indexes, then single-column indexes
    const whereColumns = this.extractWhereColumns(sql)
      .filter(col => col.table === table)
      .map(col => col.column);
    
    // Find index covering most WHERE columns
    let bestIndex = null;
    let bestScore = 0;
    
    for (const index of indexes) {
      let score = 0;
      
      for (const column of whereColumns) {
        if (index.columns.includes(column)) {
          score += index.columns.indexOf(column) === 0 ? 2 : 1;
        }
      }
      
      if (index.unique) score *= 2;
      
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index.name;
      }
    }
    
    return bestIndex;
  }
  
  evictOldestPlan() {
    let oldest = null;
    let oldestTime = Infinity;
    
    for (const [hash, plan] of this.planCache) {
      if (plan.lastUsed < oldestTime) {
        oldestTime = plan.lastUsed;
        oldest = hash;
      }
    }
    
    if (oldest) {
      this.planCache.delete(oldest);
    }
  }
  
  /**
   * Periodic tasks
   */
  startPeriodicTasks() {
    // Clean old statistics
    setInterval(() => {
      const cutoff = Date.now() - this.config.statsRetention;
      
      for (const [hash, stats] of this.queryStats) {
        if (stats.lastExecuted < cutoff) {
          this.queryStats.delete(hash);
        }
      }
      
      // Clean old slow queries
      this.slowQueries = this.slowQueries.filter(
        q => q.timestamp > cutoff
      );
    }, 3600000); // Every hour
    
    // Generate index recommendations
    if (this.config.suggestIndexes) {
      setInterval(async () => {
        const recommendations = await this.getIndexRecommendations();
        if (recommendations.length > 0) {
          this.emit('index_recommendations', recommendations);
        }
      }, this.config.indexAnalysisInterval);
    }
  }
  
  /**
   * Get optimizer statistics
   */
  getStats() {
    const stats = {
      planCache: {
        size: this.planCache.size,
        maxSize: this.config.planCacheSize
      },
      preparedStatements: {
        size: this.preparedStatements.size
      },
      queryStats: {
        total: this.queryStats.size,
        slowQueries: this.slowQueries.length
      }
    };
    
    // Top slow queries
    stats.topSlowQueries = [...this.queryStats.values()]
      .sort((a, b) => b.avgTime - a.avgTime)
      .slice(0, 10)
      .map(q => ({
        sql: q.sql.substring(0, 100) + '...',
        avgTime: q.avgTime.toFixed(2),
        count: q.count,
        lastExecuted: new Date(q.lastExecuted).toISOString()
      }));
    
    return stats;
  }
  
  /**
   * Clear all caches
   */
  clearCaches() {
    this.planCache.clear();
    this.preparedStatements.clear();
    this.queryStats.clear();
    this.slowQueries = [];
    this.indexStats.clear();
  }
  
  /**
   * Shutdown optimizer
   */
  shutdown() {
    this.clearCaches();
    this.emit('shutdown');
  }
}

// Factory function
export function createQueryOptimizer(db, options) {
  return new QueryOptimizer(db, options);
}

// Default export
export default QueryOptimizer;
