/**
 * Database Query Optimizer
 * データベースクエリ最適化システム
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

class DatabaseQueryOptimizer extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Query optimization
            enableQueryCache: config.enableQueryCache !== false,
            queryCacheTTL: config.queryCacheTTL || 300000, // 5 minutes
            maxQueryCacheSize: config.maxQueryCacheSize || 1000,
            
            // Batch processing
            enableBatching: config.enableBatching !== false,
            batchSize: config.batchSize || 100,
            batchDelay: config.batchDelay || 10, // ms
            
            // Connection management
            enableConnectionPooling: config.enableConnectionPooling !== false,
            minConnections: config.minConnections || 5,
            maxConnections: config.maxConnections || 20,
            
            // Query analysis
            enableQueryAnalysis: config.enableQueryAnalysis !== false,
            slowQueryThreshold: config.slowQueryThreshold || 1000, // ms
            
            // Index optimization
            enableAutoIndexing: config.enableAutoIndexing || false,
            indexAnalysisInterval: config.indexAnalysisInterval || 3600000, // 1 hour
            
            // Read/Write splitting
            enableReadWriteSplitting: config.enableReadWriteSplitting || false,
            readReplicas: config.readReplicas || [],
            
            ...config
        };
        
        // Query cache
        this.queryCache = new Map();
        this.queryCacheStats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
        
        // Batch queues
        this.batchQueues = {
            insert: [],
            update: [],
            delete: []
        };
        this.batchTimers = {};
        
        // Query patterns
        this.queryPatterns = new Map();
        this.slowQueries = [];
        
        // Prepared statements
        this.preparedStatements = new Map();
        
        // Statistics
        this.stats = {
            totalQueries: 0,
            cachedQueries: 0,
            batchedQueries: 0,
            slowQueries: 0,
            errors: 0,
            avgQueryTime: 0
        };
        
        // Initialize
        this.initialize();
    }
    
    initialize() {
        console.log('データベースクエリオプティマイザーを初期化中...');
        
        // Start query cache cleanup
        if (this.config.enableQueryCache) {
            this.startQueryCacheCleanup();
        }
        
        // Start index analysis
        if (this.config.enableAutoIndexing) {
            this.startIndexAnalysis();
        }
        
        // Setup query interceptors
        this.setupQueryInterceptors();
        
        console.log('✓ クエリオプティマイザーの初期化完了');
    }
    
    /**
     * Optimize and execute query
     */
    async executeQuery(query, params = [], options = {}) {
        const startTime = Date.now();
        this.stats.totalQueries++;
        
        try {
            // Check if query can be cached
            if (this.canCacheQuery(query, options)) {
                const cachedResult = this.getCachedQuery(query, params);
                if (cachedResult) {
                    this.stats.cachedQueries++;
                    this.queryCacheStats.hits++;
                    
                    this.emit('query-cache-hit', {
                        query,
                        latency: Date.now() - startTime
                    });
                    
                    return cachedResult;
                }
                this.queryCacheStats.misses++;
            }
            
            // Optimize query
            const optimizedQuery = await this.optimizeQuery(query, params);
            
            // Check if query can be batched
            if (this.canBatchQuery(optimizedQuery, options)) {
                return await this.addToBatch(optimizedQuery, params, options);
            }
            
            // Execute query
            const result = await this.executeOptimizedQuery(optimizedQuery, params, options);
            
            // Cache result if applicable
            if (this.canCacheQuery(query, options)) {
                this.cacheQuery(query, params, result);
            }
            
            // Track query performance
            const queryTime = Date.now() - startTime;
            this.trackQueryPerformance(query, queryTime);
            
            return result;
            
        } catch (error) {
            this.stats.errors++;
            this.emit('query-error', { query, error });
            throw error;
        }
    }
    
    /**
     * Optimize query
     */
    async optimizeQuery(query, params) {
        let optimized = query;
        
        // Remove unnecessary whitespace
        optimized = optimized.replace(/\s+/g, ' ').trim();
        
        // Convert to prepared statement if not already
        if (!optimized.includes('?') && params.length > 0) {
            optimized = this.convertToPreparedStatement(optimized, params);
        }
        
        // Apply query rewrites
        optimized = this.applyQueryRewrites(optimized);
        
        // Add query hints
        optimized = this.addQueryHints(optimized);
        
        return optimized;
    }
    
    /**
     * Execute optimized query
     */
    async executeOptimizedQuery(query, params, options) {
        const connection = await this.getConnection(options);
        
        try {
            // Use prepared statement if available
            const statement = await this.getPreparedStatement(query, connection);
            
            if (statement) {
                return await statement.execute(params);
            }
            
            // Execute directly
            return await connection.query(query, params);
            
        } finally {
            this.releaseConnection(connection);
        }
    }
    
    /**
     * Check if query can be cached
     */
    canCacheQuery(query, options) {
        if (!this.config.enableQueryCache) return false;
        if (options.noCache) return false;
        
        // Only cache SELECT queries
        const normalizedQuery = query.trim().toUpperCase();
        return normalizedQuery.startsWith('SELECT');
    }
    
    /**
     * Get cached query result
     */
    getCachedQuery(query, params) {
        const cacheKey = this.generateCacheKey(query, params);
        const cached = this.queryCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.config.queryCacheTTL) {
            return cached.result;
        }
        
        // Remove expired entry
        if (cached) {
            this.queryCache.delete(cacheKey);
            this.queryCacheStats.evictions++;
        }
        
        return null;
    }
    
    /**
     * Cache query result
     */
    cacheQuery(query, params, result) {
        const cacheKey = this.generateCacheKey(query, params);
        
        this.queryCache.set(cacheKey, {
            result,
            timestamp: Date.now()
        });
        
        // Maintain cache size
        if (this.queryCache.size > this.config.maxQueryCacheSize) {
            const oldestKey = this.queryCache.keys().next().value;
            this.queryCache.delete(oldestKey);
            this.queryCacheStats.evictions++;
        }
    }
    
    /**
     * Generate cache key
     */
    generateCacheKey(query, params) {
        const data = { query, params };
        return crypto
            .createHash('md5')
            .update(JSON.stringify(data))
            .digest('hex');
    }
    
    /**
     * Check if query can be batched
     */
    canBatchQuery(query, options) {
        if (!this.config.enableBatching) return false;
        if (options.immediate) return false;
        
        const normalizedQuery = query.trim().toUpperCase();
        
        // Only batch INSERT, UPDATE, DELETE
        return normalizedQuery.startsWith('INSERT') ||
               normalizedQuery.startsWith('UPDATE') ||
               normalizedQuery.startsWith('DELETE');
    }
    
    /**
     * Add query to batch
     */
    async addToBatch(query, params, options) {
        const type = this.getQueryType(query);
        const batch = this.batchQueues[type];
        
        if (!batch) {
            return await this.executeOptimizedQuery(query, params, options);
        }
        
        return new Promise((resolve, reject) => {
            batch.push({ query, params, resolve, reject });
            
            // Start batch timer if not already running
            if (!this.batchTimers[type]) {
                this.batchTimers[type] = setTimeout(() => {
                    this.executeBatch(type);
                }, this.config.batchDelay);
            }
            
            // Execute immediately if batch is full
            if (batch.length >= this.config.batchSize) {
                clearTimeout(this.batchTimers[type]);
                this.executeBatch(type);
            }
        });
    }
    
    /**
     * Execute batch queries
     */
    async executeBatch(type) {
        const batch = this.batchQueues[type];
        if (batch.length === 0) return;
        
        // Clear batch
        this.batchQueues[type] = [];
        delete this.batchTimers[type];
        
        const connection = await this.getConnection({ write: true });
        
        try {
            await connection.beginTransaction();
            
            for (const { query, params, resolve, reject } of batch) {
                try {
                    const result = await connection.query(query, params);
                    this.stats.batchedQueries++;
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            }
            
            await connection.commit();
            
            this.emit('batch-executed', {
                type,
                count: batch.length
            });
            
        } catch (error) {
            await connection.rollback();
            
            // Reject all queries in batch
            for (const { reject } of batch) {
                reject(error);
            }
            
        } finally {
            this.releaseConnection(connection);
        }
    }
    
    /**
     * Get query type
     */
    getQueryType(query) {
        const normalized = query.trim().toUpperCase();
        
        if (normalized.startsWith('INSERT')) return 'insert';
        if (normalized.startsWith('UPDATE')) return 'update';
        if (normalized.startsWith('DELETE')) return 'delete';
        
        return 'other';
    }
    
    /**
     * Apply query rewrites
     */
    applyQueryRewrites(query) {
        let rewritten = query;
        
        // Convert SELECT * to specific columns
        rewritten = this.expandSelectStar(rewritten);
        
        // Add LIMIT to unbounded queries
        rewritten = this.addDefaultLimit(rewritten);
        
        // Optimize JOIN order
        rewritten = this.optimizeJoinOrder(rewritten);
        
        // Convert subqueries to JOINs where possible
        rewritten = this.convertSubqueriesToJoins(rewritten);
        
        return rewritten;
    }
    
    /**
     * Add query hints
     */
    addQueryHints(query) {
        const pattern = this.analyzeQueryPattern(query);
        
        // Add index hints for known patterns
        if (pattern.suggestedIndexes.length > 0) {
            // MySQL example: USE INDEX (index_name)
            // PostgreSQL example: /*+ IndexScan(table_name index_name) */
        }
        
        return query;
    }
    
    /**
     * Analyze query pattern
     */
    analyzeQueryPattern(query) {
        const pattern = {
            tables: [],
            joins: [],
            whereConditions: [],
            orderBy: [],
            groupBy: [],
            suggestedIndexes: []
        };
        
        // Simple pattern extraction (would be more sophisticated in production)
        const tableMatches = query.match(/FROM\s+(\w+)/gi);
        if (tableMatches) {
            pattern.tables = tableMatches.map(m => m.replace(/FROM\s+/i, ''));
        }
        
        const whereMatch = query.match(/WHERE\s+(.+?)(?:GROUP|ORDER|LIMIT|$)/i);
        if (whereMatch) {
            pattern.whereConditions = whereMatch[1].split(/\s+AND\s+/i);
        }
        
        // Track pattern for analysis
        const patternKey = JSON.stringify(pattern);
        if (!this.queryPatterns.has(patternKey)) {
            this.queryPatterns.set(patternKey, {
                count: 0,
                totalTime: 0,
                avgTime: 0
            });
        }
        
        const stats = this.queryPatterns.get(patternKey);
        stats.count++;
        
        return pattern;
    }
    
    /**
     * Track query performance
     */
    trackQueryPerformance(query, queryTime) {
        // Update average query time
        this.stats.avgQueryTime = 
            (this.stats.avgQueryTime * (this.stats.totalQueries - 1) + queryTime) / 
            this.stats.totalQueries;
        
        // Track slow queries
        if (queryTime > this.config.slowQueryThreshold) {
            this.stats.slowQueries++;
            
            this.slowQueries.push({
                query,
                time: queryTime,
                timestamp: Date.now()
            });
            
            // Keep only recent slow queries
            if (this.slowQueries.length > 100) {
                this.slowQueries.shift();
            }
            
            this.emit('slow-query', {
                query,
                time: queryTime
            });
        }
    }
    
    /**
     * Get or create prepared statement
     */
    async getPreparedStatement(query, connection) {
        const key = query;
        
        if (this.preparedStatements.has(key)) {
            return this.preparedStatements.get(key);
        }
        
        try {
            const statement = await connection.prepare(query);
            this.preparedStatements.set(key, statement);
            return statement;
        } catch (error) {
            // Some queries can't be prepared
            return null;
        }
    }
    
    /**
     * Get database connection
     */
    async getConnection(options = {}) {
        // This would integrate with connection pool
        // For now, return mock connection
        return {
            query: async (query, params) => {
                // Simulate query execution
                await new Promise(resolve => setTimeout(resolve, 10));
                return { rows: [], affectedRows: 0 };
            },
            prepare: async (query) => {
                return {
                    execute: async (params) => {
                        return { rows: [], affectedRows: 0 };
                    }
                };
            },
            beginTransaction: async () => {},
            commit: async () => {},
            rollback: async () => {}
        };
    }
    
    /**
     * Release database connection
     */
    releaseConnection(connection) {
        // Return connection to pool
    }
    
    /**
     * Expand SELECT * queries
     */
    expandSelectStar(query) {
        if (!query.includes('SELECT *')) return query;
        
        // In production, this would look up actual table columns
        // For now, just return as-is
        return query;
    }
    
    /**
     * Add default LIMIT to unbounded queries
     */
    addDefaultLimit(query) {
        const normalized = query.toUpperCase();
        
        if (normalized.includes('SELECT') && 
            !normalized.includes('LIMIT') &&
            !normalized.includes('COUNT(')) {
            return query + ' LIMIT 1000';
        }
        
        return query;
    }
    
    /**
     * Optimize JOIN order
     */
    optimizeJoinOrder(query) {
        // In production, this would analyze table statistics
        // and reorder JOINs for optimal performance
        return query;
    }
    
    /**
     * Convert subqueries to JOINs
     */
    convertSubqueriesToJoins(query) {
        // Complex optimization that would analyze subqueries
        // and convert them to more efficient JOINs where possible
        return query;
    }
    
    /**
     * Start query cache cleanup
     */
    startQueryCacheCleanup() {
        setInterval(() => {
            const now = Date.now();
            let evicted = 0;
            
            for (const [key, cached] of this.queryCache) {
                if (now - cached.timestamp > this.config.queryCacheTTL) {
                    this.queryCache.delete(key);
                    evicted++;
                }
            }
            
            if (evicted > 0) {
                this.queryCacheStats.evictions += evicted;
                this.emit('cache-cleanup', { evicted });
            }
        }, 60000); // Every minute
    }
    
    /**
     * Start index analysis
     */
    startIndexAnalysis() {
        setInterval(() => {
            this.analyzeIndexUsage();
        }, this.config.indexAnalysisInterval);
    }
    
    /**
     * Analyze index usage and suggest optimizations
     */
    async analyzeIndexUsage() {
        const suggestions = [];
        
        // Analyze query patterns
        for (const [pattern, stats] of this.queryPatterns) {
            const parsed = JSON.parse(pattern);
            
            // Suggest indexes for frequently used WHERE conditions
            if (stats.count > 100 && parsed.whereConditions.length > 0) {
                for (const condition of parsed.whereConditions) {
                    const column = this.extractColumnFromCondition(condition);
                    if (column) {
                        suggestions.push({
                            type: 'index',
                            table: parsed.tables[0],
                            column,
                            reason: `Frequently used in WHERE clause (${stats.count} times)`
                        });
                    }
                }
            }
        }
        
        // Analyze slow queries
        for (const slowQuery of this.slowQueries) {
            const pattern = this.analyzeQueryPattern(slowQuery.query);
            
            // Suggest composite indexes for multi-column conditions
            if (pattern.whereConditions.length > 1) {
                const columns = pattern.whereConditions
                    .map(c => this.extractColumnFromCondition(c))
                    .filter(c => c);
                
                if (columns.length > 1) {
                    suggestions.push({
                        type: 'composite-index',
                        table: pattern.tables[0],
                        columns,
                        reason: `Slow query (${slowQuery.time}ms)`
                    });
                }
            }
        }
        
        if (suggestions.length > 0) {
            this.emit('index-suggestions', suggestions);
        }
    }
    
    /**
     * Extract column name from WHERE condition
     */
    extractColumnFromCondition(condition) {
        const match = condition.match(/(\w+)\s*[=<>]/);
        return match ? match[1] : null;
    }
    
    /**
     * Setup query interceptors
     */
    setupQueryInterceptors() {
        // Would set up hooks to intercept database queries
        // from various ORMs and database drivers
    }
    
    /**
     * Convert query to prepared statement format
     */
    convertToPreparedStatement(query, params) {
        let prepared = query;
        let paramIndex = 0;
        
        // Replace values with placeholders
        prepared = prepared.replace(/=\s*'[^']*'/g, () => {
            paramIndex++;
            return '= ?';
        });
        
        return prepared;
    }
    
    /**
     * Get optimizer statistics
     */
    getStatistics() {
        return {
            ...this.stats,
            queryCache: {
                size: this.queryCache.size,
                ...this.queryCacheStats
            },
            batching: {
                insert: this.batchQueues.insert.length,
                update: this.batchQueues.update.length,
                delete: this.batchQueues.delete.length
            },
            patterns: this.queryPatterns.size,
            slowQueries: this.slowQueries.length,
            preparedStatements: this.preparedStatements.size
        };
    }
    
    /**
     * Clear all caches
     */
    clearCaches() {
        this.queryCache.clear();
        this.preparedStatements.clear();
        this.queryCacheStats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
    }
    
    /**
     * Cleanup
     */
    cleanup() {
        // Clear batch timers
        for (const timer of Object.values(this.batchTimers)) {
            clearTimeout(timer);
        }
        
        // Execute remaining batches
        for (const type of ['insert', 'update', 'delete']) {
            if (this.batchQueues[type].length > 0) {
                this.executeBatch(type);
            }
        }
        
        // Clear caches
        this.clearCaches();
    }
}

module.exports = DatabaseQueryOptimizer;