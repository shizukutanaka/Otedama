const { EventEmitter } = require('events');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

class OptimizedDatabaseEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            type: options.type || 'sqlite',
            connectionLimit: options.connectionLimit || 20,
            cacheSize: options.cacheSize || 10000,
            queryTimeout: options.queryTimeout || 30000,
            enableQueryCache: options.enableQueryCache !== false,
            enableAutoVacuum: options.enableAutoVacuum !== false,
            enablePartitioning: options.enablePartitioning !== false,
            ...options
        };
        
        this.connections = [];
        this.queryCache = new Map();
        this.preparedStatements = new Map();
        
        // Performance tracking
        this.metrics = {
            queries: 0,
            hits: 0,
            misses: 0,
            avgQueryTime: 0,
            slowQueries: []
        };
        
        // Index optimization
        this.indexes = new Map();
        this.indexStats = new Map();
    }

    async initialize() {
        if (this.config.type === 'sqlite') {
            await this.initializeSQLite();
        } else if (this.config.type === 'postgresql') {
            await this.initializePostgreSQL();
        }
        
        // Create optimized schema
        await this.createOptimizedSchema();
        
        // Start maintenance tasks
        this.startMaintenanceTasks();
        
        this.emit('initialized');
    }

    async initializeSQLite() {
        this.db = new sqlite3.Database(
            this.config.path || ':memory:',
            sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE
        );
        
        // Configure for performance
        await this.runQuery('PRAGMA journal_mode = WAL');
        await this.runQuery('PRAGMA synchronous = NORMAL');
        await this.runQuery('PRAGMA cache_size = ' + this.config.cacheSize);
        await this.runQuery('PRAGMA temp_store = MEMORY');
        await this.runQuery('PRAGMA mmap_size = 268435456'); // 256MB
        
        if (this.config.enableAutoVacuum) {
            await this.runQuery('PRAGMA auto_vacuum = INCREMENTAL');
        }
    }

    async initializePostgreSQL() {
        this.pool = new Pool({
            host: this.config.host,
            port: this.config.port || 5432,
            database: this.config.database,
            user: this.config.user,
            password: this.config.password,
            max: this.config.connectionLimit,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000
        });
        
        // Configure connection
        this.pool.on('connect', async (client) => {
            await client.query('SET statement_timeout = $1', [this.config.queryTimeout]);
            await client.query('SET lock_timeout = $1', ['5s']);
        });
    }

    async createOptimizedSchema() {
        // Shares table with partitioning
        await this.createTable('shares', `
            id BIGSERIAL PRIMARY KEY,
            miner_id VARCHAR(64) NOT NULL,
            pool_id VARCHAR(64) NOT NULL,
            difficulty DOUBLE PRECISION NOT NULL,
            hash VARCHAR(64) NOT NULL,
            status VARCHAR(20) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            block_height BIGINT,
            reward DECIMAL(20, 8)
        `, {
            partition: this.config.enablePartitioning ? 'created_at' : null,
            partitionInterval: 'daily'
        });
        
        // Miners table
        await this.createTable('miners', `
            id VARCHAR(64) PRIMARY KEY,
            wallet_address VARCHAR(128) NOT NULL,
            worker_name VARCHAR(64),
            hashrate BIGINT DEFAULT 0,
            shares_accepted BIGINT DEFAULT 0,
            shares_rejected BIGINT DEFAULT 0,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            total_earned DECIMAL(20, 8) DEFAULT 0,
            metadata JSONB
        `);
        
        // Blocks table
        await this.createTable('blocks', `
            id BIGSERIAL PRIMARY KEY,
            height BIGINT UNIQUE NOT NULL,
            hash VARCHAR(64) UNIQUE NOT NULL,
            finder_id VARCHAR(64),
            difficulty DOUBLE PRECISION NOT NULL,
            reward DECIMAL(20, 8) NOT NULL,
            found_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            confirmed BOOLEAN DEFAULT FALSE,
            orphaned BOOLEAN DEFAULT FALSE
        `);
        
        // Performance metrics table
        await this.createTable('metrics', `
            id BIGSERIAL PRIMARY KEY,
            metric_type VARCHAR(50) NOT NULL,
            metric_name VARCHAR(100) NOT NULL,
            value DOUBLE PRECISION NOT NULL,
            tags JSONB,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `, {
            partition: 'timestamp',
            partitionInterval: 'hourly'
        });
        
        // Create optimized indexes
        await this.createOptimizedIndexes();
    }

    async createTable(name, schema, options = {}) {
        if (this.config.type === 'sqlite') {
            await this.runQuery(`CREATE TABLE IF NOT EXISTS ${name} (${schema})`);
        } else if (this.config.type === 'postgresql') {
            if (options.partition && this.config.enablePartitioning) {
                // Create partitioned table
                await this.runQuery(`
                    CREATE TABLE IF NOT EXISTS ${name} (${schema})
                    PARTITION BY RANGE (${options.partition})
                `);
                
                // Create initial partitions
                await this.createPartitions(name, options);
            } else {
                await this.runQuery(`CREATE TABLE IF NOT EXISTS ${name} (${schema})`);
            }
        }
    }

    async createPartitions(tableName, options) {
        const now = new Date();
        const partitions = [];
        
        // Create partitions for next 7 days
        for (let i = 0; i < 7; i++) {
            const date = new Date(now);
            date.setDate(date.getDate() + i);
            
            const partitionName = `${tableName}_${date.toISOString().split('T')[0]}`;
            const startDate = date.toISOString().split('T')[0];
            const endDate = new Date(date);
            endDate.setDate(endDate.getDate() + 1);
            
            partitions.push(this.runQuery(`
                CREATE TABLE IF NOT EXISTS ${partitionName}
                PARTITION OF ${tableName}
                FOR VALUES FROM ('${startDate}') TO ('${endDate.toISOString().split('T')[0]}')
            `));
        }
        
        await Promise.all(partitions);
    }

    async createOptimizedIndexes() {
        const indexes = [
            // Shares indexes
            { table: 'shares', columns: ['miner_id', 'created_at'], type: 'btree' },
            { table: 'shares', columns: ['pool_id', 'status'], type: 'btree' },
            { table: 'shares', columns: ['created_at'], type: 'brin' },
            
            // Miners indexes
            { table: 'miners', columns: ['wallet_address'], type: 'hash' },
            { table: 'miners', columns: ['last_seen'], type: 'btree' },
            { table: 'miners', columns: ['hashrate'], type: 'btree', where: 'hashrate > 0' },
            
            // Blocks indexes
            { table: 'blocks', columns: ['height'], type: 'btree' },
            { table: 'blocks', columns: ['finder_id', 'confirmed'], type: 'btree' },
            { table: 'blocks', columns: ['found_at'], type: 'brin' },
            
            // Metrics indexes
            { table: 'metrics', columns: ['metric_type', 'timestamp'], type: 'btree' },
            { table: 'metrics', columns: ['timestamp'], type: 'brin' }
        ];
        
        for (const index of indexes) {
            await this.createIndex(index);
        }
    }

    async createIndex(config) {
        const indexName = `idx_${config.table}_${config.columns.join('_')}`;
        let query = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${config.table}`;
        
        if (config.type === 'brin' && this.config.type === 'postgresql') {
            query += ` USING BRIN (${config.columns.join(', ')})`;
        } else if (config.type === 'hash' && this.config.type === 'postgresql') {
            query += ` USING HASH (${config.columns.join(', ')})`;
        } else {
            query += ` (${config.columns.join(', ')})`;
        }
        
        if (config.where) {
            query += ` WHERE ${config.where}`;
        }
        
        await this.runQuery(query);
        
        // Track index
        this.indexes.set(indexName, config);
        this.indexStats.set(indexName, {
            created: Date.now(),
            usage: 0,
            lastUsed: null
        });
    }

    async query(sql, params = [], options = {}) {
        const startTime = Date.now();
        this.metrics.queries++;
        
        // Check cache
        if (this.config.enableQueryCache && options.cache !== false) {
            const cacheKey = this.getCacheKey(sql, params);
            const cached = this.queryCache.get(cacheKey);
            
            if (cached && Date.now() - cached.timestamp < (options.cacheTTL || 60000)) {
                this.metrics.hits++;
                return cached.result;
            }
        }
        
        try {
            // Use prepared statement if available
            const result = await this.executePrepared(sql, params);
            
            const queryTime = Date.now() - startTime;
            this.updateQueryMetrics(sql, queryTime);
            
            // Cache result
            if (this.config.enableQueryCache && options.cache !== false) {
                const cacheKey = this.getCacheKey(sql, params);
                this.queryCache.set(cacheKey, {
                    result,
                    timestamp: Date.now()
                });
                
                // Limit cache size
                if (this.queryCache.size > this.config.cacheSize) {
                    const firstKey = this.queryCache.keys().next().value;
                    this.queryCache.delete(firstKey);
                }
            }
            
            return result;
            
        } catch (error) {
            this.emit('query:error', { sql, error });
            throw error;
        }
    }

    async executePrepared(sql, params) {
        if (this.config.type === 'sqlite') {
            return new Promise((resolve, reject) => {
                const method = sql.toLowerCase().startsWith('select') ? 'all' : 'run';
                
                this.db[method](sql, params, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        } else if (this.config.type === 'postgresql') {
            const client = await this.pool.connect();
            try {
                const result = await client.query(sql, params);
                return result.rows;
            } finally {
                client.release();
            }
        }
    }

    async bulkInsert(table, records, options = {}) {
        if (records.length === 0) return;
        
        const columns = Object.keys(records[0]);
        const chunkSize = options.chunkSize || 1000;
        
        for (let i = 0; i < records.length; i += chunkSize) {
            const chunk = records.slice(i, i + chunkSize);
            
            if (this.config.type === 'sqlite') {
                // SQLite bulk insert
                const placeholders = chunk.map(() => 
                    `(${columns.map(() => '?').join(', ')})`
                ).join(', ');
                
                const values = chunk.flatMap(record => 
                    columns.map(col => record[col])
                );
                
                await this.runQuery(`
                    INSERT INTO ${table} (${columns.join(', ')})
                    VALUES ${placeholders}
                `, values);
                
            } else if (this.config.type === 'postgresql') {
                // PostgreSQL COPY for best performance
                const values = chunk.map(record => 
                    columns.map(col => record[col])
                );
                
                const placeholders = values.map((_, idx) => 
                    `(${columns.map((_, colIdx) => 
                        `$${idx * columns.length + colIdx + 1}`
                    ).join(', ')})`
                ).join(', ');
                
                await this.runQuery(`
                    INSERT INTO ${table} (${columns.join(', ')})
                    VALUES ${placeholders}
                    ON CONFLICT DO NOTHING
                `, values.flat());
            }
        }
    }

    async analyzeQueryPlan(sql, params = []) {
        let plan;
        
        if (this.config.type === 'sqlite') {
            plan = await this.runQuery(`EXPLAIN QUERY PLAN ${sql}`, params);
        } else if (this.config.type === 'postgresql') {
            plan = await this.runQuery(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
        }
        
        return this.parseQueryPlan(plan);
    }

    parseQueryPlan(plan) {
        const analysis = {
            usesIndex: false,
            scanType: 'unknown',
            estimatedCost: 0,
            suggestions: []
        };
        
        // Parse plan based on database type
        if (this.config.type === 'sqlite') {
            for (const row of plan) {
                if (row.detail.includes('USING INDEX')) {
                    analysis.usesIndex = true;
                } else if (row.detail.includes('SCAN TABLE')) {
                    analysis.scanType = 'full';
                    analysis.suggestions.push('Consider adding an index');
                }
            }
        }
        
        return analysis;
    }

    updateQueryMetrics(sql, queryTime) {
        // Update average query time
        const totalTime = this.metrics.avgQueryTime * (this.metrics.queries - 1);
        this.metrics.avgQueryTime = (totalTime + queryTime) / this.metrics.queries;
        
        // Track slow queries
        if (queryTime > 1000) { // 1 second
            this.metrics.slowQueries.push({
                sql,
                time: queryTime,
                timestamp: Date.now()
            });
            
            // Keep only recent slow queries
            if (this.metrics.slowQueries.length > 100) {
                this.metrics.slowQueries.shift();
            }
            
            this.emit('slow:query', { sql, time: queryTime });
        }
    }

    startMaintenanceTasks() {
        // Vacuum task
        if (this.config.enableAutoVacuum) {
            setInterval(() => this.vacuum(), 3600000); // Every hour
        }
        
        // Analyze statistics
        setInterval(() => this.analyzeStatistics(), 1800000); // Every 30 minutes
        
        // Clean old partitions
        if (this.config.enablePartitioning) {
            setInterval(() => this.cleanOldPartitions(), 86400000); // Daily
        }
        
        // Optimize indexes
        setInterval(() => this.optimizeIndexes(), 3600000); // Every hour
    }

    async vacuum() {
        try {
            if (this.config.type === 'sqlite') {
                await this.runQuery('VACUUM');
            } else if (this.config.type === 'postgresql') {
                await this.runQuery('VACUUM ANALYZE');
            }
            
            this.emit('maintenance:vacuum', { timestamp: Date.now() });
        } catch (error) {
            this.emit('maintenance:error', { type: 'vacuum', error });
        }
    }

    async analyzeStatistics() {
        try {
            if (this.config.type === 'sqlite') {
                await this.runQuery('ANALYZE');
            } else if (this.config.type === 'postgresql') {
                await this.runQuery('ANALYZE');
            }
            
            // Update index statistics
            await this.updateIndexStatistics();
            
            this.emit('maintenance:analyze', { timestamp: Date.now() });
        } catch (error) {
            this.emit('maintenance:error', { type: 'analyze', error });
        }
    }

    async updateIndexStatistics() {
        if (this.config.type === 'postgresql') {
            const stats = await this.runQuery(`
                SELECT 
                    schemaname,
                    tablename,
                    indexname,
                    idx_scan,
                    idx_tup_read,
                    idx_tup_fetch
                FROM pg_stat_user_indexes
            `);
            
            for (const stat of stats) {
                const indexStat = this.indexStats.get(stat.indexname);
                if (indexStat) {
                    indexStat.usage = stat.idx_scan;
                    indexStat.lastUsed = Date.now();
                }
            }
        }
    }

    async cleanOldPartitions() {
        const retentionDays = this.config.retentionDays || 30;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        
        // Find and drop old partitions
        const tables = await this.runQuery(`
            SELECT tablename 
            FROM pg_tables 
            WHERE tablename LIKE '%_20%'
            AND tablename < $1
        `, [`${cutoffDate.toISOString().split('T')[0]}`]);
        
        for (const table of tables) {
            await this.runQuery(`DROP TABLE IF EXISTS ${table.tablename}`);
            this.emit('partition:dropped', { table: table.tablename });
        }
    }

    async optimizeIndexes() {
        // Find unused indexes
        const unusedIndexes = [];
        
        for (const [name, stats] of this.indexStats) {
            if (stats.usage === 0 && Date.now() - stats.created > 86400000) {
                unusedIndexes.push(name);
            }
        }
        
        // Suggest dropping unused indexes
        if (unusedIndexes.length > 0) {
            this.emit('indexes:unused', { indexes: unusedIndexes });
        }
        
        // Rebuild fragmented indexes
        if (this.config.type === 'postgresql') {
            await this.runQuery('REINDEX DATABASE CONCURRENTLY');
        }
    }

    getCacheKey(sql, params) {
        return `${sql}:${JSON.stringify(params)}`;
    }

    async runQuery(sql, params = []) {
        return this.query(sql, params, { cache: false });
    }

    getMetrics() {
        return {
            ...this.metrics,
            cacheSize: this.queryCache.size,
            cacheHitRate: this.metrics.hits / (this.metrics.queries || 1),
            indexes: Array.from(this.indexes.keys()),
            indexStats: Object.fromEntries(this.indexStats)
        };
    }

    async close() {
        if (this.config.type === 'sqlite') {
            return new Promise((resolve) => {
                this.db.close(resolve);
            });
        } else if (this.config.type === 'postgresql') {
            await this.pool.end();
        }
    }
}

module.exports = OptimizedDatabaseEngine;