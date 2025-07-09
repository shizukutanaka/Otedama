// Database index optimization for query performance (Carmack style - measure first)
import { Database } from '../database/database';
import { createComponentLogger } from '../logging/logger';

const logger = createComponentLogger('db-optimizer');

// Index definition
export interface IndexDefinition {
  table: string;
  name: string;
  columns: string[];
  unique?: boolean;
  where?: string; // Partial index condition
}

// Query performance metrics
export interface QueryMetrics {
  query: string;
  executionTime: number;
  rowsScanned: number;
  rowsReturned: number;
  indexUsed: string | null;
}

export class DatabaseOptimizer {
  // Core indexes for mining pool
  private static readonly CORE_INDEXES: IndexDefinition[] = [
    // Shares table indexes
    {
      table: 'shares',
      name: 'idx_shares_miner_timestamp',
      columns: ['miner_id', 'timestamp'],
      unique: false
    },
    {
      table: 'shares',
      name: 'idx_shares_timestamp',
      columns: ['timestamp'],
      unique: false
    },
    {
      table: 'shares',
      name: 'idx_shares_job_nonce',
      columns: ['job_id', 'nonce'],
      unique: true // Prevent duplicate shares
    },
    {
      table: 'shares',
      name: 'idx_shares_valid_timestamp',
      columns: ['is_valid', 'timestamp'],
      unique: false,
      where: 'is_valid = 1' // Partial index for valid shares only
    },
    
    // Miners table indexes
    {
      table: 'miners',
      name: 'idx_miners_username',
      columns: ['username'],
      unique: true
    },
    {
      table: 'miners',
      name: 'idx_miners_last_share',
      columns: ['last_share_time'],
      unique: false
    },
    {
      table: 'miners',
      name: 'idx_miners_active',
      columns: ['is_active', 'last_share_time'],
      unique: false,
      where: 'is_active = 1'
    },
    
    // Blocks table indexes
    {
      table: 'blocks',
      name: 'idx_blocks_height',
      columns: ['height'],
      unique: true
    },
    {
      table: 'blocks',
      name: 'idx_blocks_finder_timestamp',
      columns: ['finder_id', 'timestamp'],
      unique: false
    },
    {
      table: 'blocks',
      name: 'idx_blocks_status',
      columns: ['status', 'timestamp'],
      unique: false
    },
    
    // Payouts table indexes
    {
      table: 'payouts',
      name: 'idx_payouts_miner_status',
      columns: ['miner_id', 'status'],
      unique: false
    },
    {
      table: 'payouts',
      name: 'idx_payouts_status_timestamp',
      columns: ['status', 'timestamp'],
      unique: false
    },
    {
      table: 'payouts',
      name: 'idx_payouts_txid',
      columns: ['txid'],
      unique: false,
      where: 'txid IS NOT NULL'
    }
  ];
  
  constructor(private db: Database) {}
  
  // Create all core indexes
  async createIndexes(): Promise<void> {
    logger.info('Creating database indexes...');
    
    for (const index of DatabaseOptimizer.CORE_INDEXES) {
      try {
        await this.createIndex(index);
        logger.info(`Created index: ${index.name}`);
      } catch (error) {
        logger.error(`Failed to create index ${index.name}:`, error as Error);
      }
    }
    
    // Analyze tables after creating indexes
    await this.analyzeTables();
  }
  
  // Create a single index
  private async createIndex(index: IndexDefinition): Promise<void> {
    let sql = `CREATE ${index.unique ? 'UNIQUE' : ''} INDEX IF NOT EXISTS ${index.name} 
               ON ${index.table} (${index.columns.join(', ')})`;
    
    if (index.where) {
      sql += ` WHERE ${index.where}`;
    }
    
    await this.db.run(sql);
  }
  
  // Drop an index
  async dropIndex(indexName: string): Promise<void> {
    await this.db.run(`DROP INDEX IF EXISTS ${indexName}`);
    logger.info(`Dropped index: ${indexName}`);
  }
  
  // Analyze tables for query optimization
  async analyzeTables(): Promise<void> {
    const tables = ['shares', 'miners', 'blocks', 'payouts'];
    
    for (const table of tables) {
      try {
        await this.db.run(`ANALYZE ${table}`);
        logger.info(`Analyzed table: ${table}`);
      } catch (error) {
        logger.error(`Failed to analyze table ${table}:`, error as Error);
      }
    }
  }
  
  // Get query execution plan
  async explainQuery(query: string, params?: any[]): Promise<any[]> {
    const explainQuery = `EXPLAIN QUERY PLAN ${query}`;
    return await this.db.all(explainQuery, params);
  }
  
  // Measure query performance
  async measureQuery(query: string, params?: any[]): Promise<QueryMetrics> {
    const startTime = process.hrtime.bigint();
    
    // Get execution plan
    const plan = await this.explainQuery(query, params);
    
    // Execute query
    const results = await this.db.all(query, params);
    
    const endTime = process.hrtime.bigint();
    const executionTime = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    
    // Parse execution plan to find index usage
    let indexUsed: string | null = null;
    let rowsScanned = 0;
    
    for (const step of plan) {
      if (step.detail && step.detail.includes('USING INDEX')) {
        const match = step.detail.match(/USING INDEX (\w+)/);
        if (match) {
          indexUsed = match[1];
        }
      }
      
      // Estimate rows scanned (simplified)
      if (step.detail && step.detail.includes('SCAN')) {
        rowsScanned = 1000000; // Assume full table scan
      } else if (step.detail && step.detail.includes('SEARCH')) {
        rowsScanned = 100; // Assume index search
      }
    }
    
    return {
      query,
      executionTime,
      rowsScanned,
      rowsReturned: results.length,
      indexUsed
    };
  }
  
  // Optimize slow queries
  async optimizeSlowQueries(threshold: number = 100): Promise<void> {
    // Common queries to check
    const queries = [
      // Recent shares for miner
      `SELECT * FROM shares WHERE miner_id = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT 100`,
      
      // Active miners
      `SELECT * FROM miners WHERE is_active = 1 AND last_share_time > ?`,
      
      // PPLNS calculation
      `SELECT miner_id, SUM(difficulty) as total_difficulty 
       FROM shares 
       WHERE timestamp > ? AND is_valid = 1 
       GROUP BY miner_id`,
      
      // Pending payouts
      `SELECT * FROM payouts WHERE status = 'pending' ORDER BY timestamp`,
      
      // Block statistics
      `SELECT COUNT(*) as blocks, SUM(reward) as total_reward 
       FROM blocks 
       WHERE timestamp > ? AND status = 'confirmed'`
    ];
    
    logger.info('Analyzing query performance...');
    
    for (const query of queries) {
      // Use sample parameters
      const params = this.getSampleParams(query);
      const metrics = await this.measureQuery(query, params);
      
      if (metrics.executionTime > threshold) {
        logger.warn(`Slow query detected:`, {
          query: query.substring(0, 100) + '...',
          executionTime: `${metrics.executionTime.toFixed(2)}ms`,
          rowsScanned: metrics.rowsScanned,
          indexUsed: metrics.indexUsed || 'none'
        });
        
        // Suggest optimizations
        const suggestions = this.getSuggestions(query, metrics);
        for (const suggestion of suggestions) {
          logger.info(`Suggestion: ${suggestion}`);
        }
      }
    }
  }
  
  // Get sample parameters for testing
  private getSampleParams(query: string): any[] {
    const paramCount = (query.match(/\?/g) || []).length;
    const params: any[] = [];
    
    for (let i = 0; i < paramCount; i++) {
      // Provide reasonable test values
      if (query.includes('miner_id')) {
        params.push('miner_123');
      } else if (query.includes('timestamp')) {
        params.push(Date.now() - 3600000); // 1 hour ago
      } else if (query.includes('status')) {
        params.push('pending');
      } else {
        params.push(1);
      }
    }
    
    return params;
  }
  
  // Get optimization suggestions
  private getSuggestions(query: string, metrics: QueryMetrics): string[] {
    const suggestions: string[] = [];
    
    if (!metrics.indexUsed && metrics.rowsScanned > 1000) {
      suggestions.push('Consider adding an index for this query');
      
      // Analyze query to suggest specific indexes
      if (query.includes('WHERE miner_id')) {
        suggestions.push('Add index on miner_id column');
      }
      if (query.includes('timestamp >') || query.includes('timestamp <')) {
        suggestions.push('Add index on timestamp column');
      }
      if (query.includes('GROUP BY')) {
        const match = query.match(/GROUP BY (\w+)/);
        if (match) {
          suggestions.push(`Add index on ${match[1]} column for GROUP BY`);
        }
      }
    }
    
    if (metrics.executionTime > 500) {
      suggestions.push('Consider query result caching for frequently accessed data');
    }
    
    if (query.includes('SELECT *')) {
      suggestions.push('Select only required columns instead of using SELECT *');
    }
    
    return suggestions;
  }
  
  // Get index statistics
  async getIndexStats(): Promise<any[]> {
    const stats = await this.db.all(`
      SELECT 
        name,
        tbl_name as table_name,
        sql
      FROM sqlite_master 
      WHERE type = 'index' 
      AND name NOT LIKE 'sqlite_%'
      ORDER BY tbl_name, name
    `);
    
    return stats;
  }
  
  // Vacuum database for performance
  async vacuum(): Promise<void> {
    logger.info('Vacuuming database...');
    await this.db.run('VACUUM');
    logger.info('Database vacuum complete');
  }
  
  // Enable query statistics
  async enableQueryStats(): Promise<void> {
    // Enable SQLite query statistics
    await this.db.run('PRAGMA stats = on');
  }
  
  // Get database statistics
  async getDatabaseStats(): Promise<any> {
    const pageCount = await this.db.get('PRAGMA page_count');
    const pageSize = await this.db.get('PRAGMA page_size');
    const cacheSize = await this.db.get('PRAGMA cache_size');
    const journalMode = await this.db.get('PRAGMA journal_mode');
    
    const stats = {
      sizeBytes: pageCount.page_count * pageSize.page_size,
      pageCount: pageCount.page_count,
      pageSize: pageSize.page_size,
      cacheSize: cacheSize.cache_size,
      journalMode: journalMode.journal_mode,
      indexes: await this.getIndexStats()
    };
    
    return stats;
  }
}

// Query cache for frequently accessed data
export class QueryCache {
  private cache = new Map<string, {
    result: any;
    timestamp: number;
    ttl: number;
  }>();
  
  private cleanupInterval: NodeJS.Timeout;
  
  constructor(
    private defaultTTL: number = 60000, // 1 minute default
    cleanupIntervalMs: number = 300000 // 5 minutes
  ) {
    // Periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);
  }
  
  // Get cached result
  get(key: string): any | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }
    
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.result;
  }
  
  // Set cached result
  set(key: string, result: any, ttl?: number): void {
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      ttl: ttl || this.defaultTTL
    });
  }
  
  // Clear specific cache entry
  invalidate(key: string): void {
    this.cache.delete(key);
  }
  
  // Clear all cache entries matching pattern
  invalidatePattern(pattern: RegExp): void {
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        this.cache.delete(key);
      }
    }
  }
  
  // Clear all cache
  clear(): void {
    this.cache.clear();
  }
  
  // Cleanup expired entries
  private cleanup(): void {
    const now = Date.now();
    
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }
  
  // Get cache statistics
  getStats(): {
    size: number;
    entries: Array<{ key: string; age: number; ttl: number }>;
  } {
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      age: Date.now() - entry.timestamp,
      ttl: entry.ttl
    }));
    
    return {
      size: this.cache.size,
      entries
    };
  }
  
  // Destroy cache
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.cache.clear();
  }
}

// Export singleton query cache
export const queryCache = new QueryCache();
