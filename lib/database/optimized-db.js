const Database = require('better-sqlite3');
const { EventEmitter } = require('events');
const path = require('path');

/**
 * 最適化されたデータベースマネージャー
 */
class OptimizedDatabase extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            filename: config.filename || './data/otedama.db',
            readonly: config.readonly || false,
            memory: config.memory || false,
            verbose: config.verbose || null,
            timeout: config.timeout || 5000,
            maxConnections: config.maxConnections || 10,
            walMode: config.walMode !== false,
            cacheSize: config.cacheSize || 10000,
            pageSize: config.pageSize || 4096,
            ...config
        };
        
        this.db = null;
        this.statements = new Map();
        this.transactionQueue = [];
        this.connectionPool = [];
        
        this.initialize();
    }
    
    /**
     * データベースを初期化
     */
    initialize() {
        try {
            // メインコネクションを作成
            this.db = new Database(this.config.filename, {
                readonly: this.config.readonly,
                fileMustExist: false,
                timeout: this.config.timeout,
                verbose: this.config.verbose
            });
            
            // パフォーマンス最適化
            this.optimizeDatabase();
            
            // インデックスを作成
            this.createIndexes();
            
            // プリペアドステートメントを準備
            this.prepareStatements();
            
            // コネクションプールを初期化
            if (!this.config.readonly) {
                this.initializeConnectionPool();
            }
            
            this.emit('initialized');
            
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    
    /**
     * データベースを最適化
     */
    optimizeDatabase() {
        // WALモードを有効化（書き込みパフォーマンス向上）
        if (this.config.walMode && !this.config.readonly) {
            this.db.pragma('journal_mode = WAL');
        }
        
        // キャッシュサイズを設定
        this.db.pragma(`cache_size = ${this.config.cacheSize}`);
        
        // ページサイズを設定（新規DBのみ）
        this.db.pragma(`page_size = ${this.config.pageSize}`);
        
        // 同期モードを設定（パフォーマンス vs 安全性）
        this.db.pragma('synchronous = NORMAL');
        
        // 外部キー制約を有効化
        this.db.pragma('foreign_keys = ON');
        
        // 自動VACUUMを設定
        this.db.pragma('auto_vacuum = INCREMENTAL');
        
        // テンポラリストアをメモリに
        this.db.pragma('temp_store = MEMORY');
        
        // ロックタイムアウト
        this.db.pragma(`busy_timeout = ${this.config.timeout}`);
    }
    
    /**
     * インデックスを作成
     */
    createIndexes() {
        const indexes = [
            // shares テーブル
            'CREATE INDEX IF NOT EXISTS idx_shares_miner ON shares(miner_address)',
            'CREATE INDEX IF NOT EXISTS idx_shares_timestamp ON shares(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_shares_valid ON shares(is_valid)',
            'CREATE INDEX IF NOT EXISTS idx_shares_block_height ON shares(block_height)',
            
            // miners テーブル
            'CREATE INDEX IF NOT EXISTS idx_miners_address ON miners(address)',
            'CREATE INDEX IF NOT EXISTS idx_miners_last_share ON miners(last_share_time)',
            
            // blocks テーブル
            'CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)',
            'CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash)',
            'CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status)',
            'CREATE INDEX IF NOT EXISTS idx_blocks_found_time ON blocks(found_time)',
            
            // payments テーブル
            'CREATE INDEX IF NOT EXISTS idx_payments_address ON payments(address)',
            'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)',
            'CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at)',
            
            // 複合インデックス
            'CREATE INDEX IF NOT EXISTS idx_shares_miner_time ON shares(miner_address, timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_payments_address_status ON payments(address, status)'
        ];
        
        const createIndexes = this.db.transaction(() => {
            indexes.forEach(sql => {
                this.db.exec(sql);
            });
        });
        
        createIndexes();
    }
    
    /**
     * プリペアドステートメントを準備
     */
    prepareStatements() {
        // よく使うクエリをプリペア
        const statements = {
            // Share関連
            insertShare: `
                INSERT INTO shares (miner_address, worker_name, job_id, nonce, hash, difficulty, is_valid, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            
            getShareCount: `
                SELECT COUNT(*) as count
                FROM shares
                WHERE miner_address = ? AND timestamp > ?
            `,
            
            getValidShares: `
                SELECT COUNT(*) as count
                FROM shares
                WHERE miner_address = ? AND is_valid = 1 AND timestamp > ?
            `,
            
            // Miner関連
            getMiner: `
                SELECT * FROM miners WHERE address = ?
            `,
            
            updateMiner: `
                UPDATE miners
                SET hashrate = ?, last_share_time = ?, total_shares = total_shares + 1
                WHERE address = ?
            `,
            
            insertMiner: `
                INSERT INTO miners (address, hashrate, last_share_time, total_shares)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(address) DO UPDATE SET
                    hashrate = excluded.hashrate,
                    last_share_time = excluded.last_share_time,
                    total_shares = total_shares + 1
            `,
            
            // Block関連
            insertBlock: `
                INSERT INTO blocks (height, hash, finder, reward, status, found_time)
                VALUES (?, ?, ?, ?, ?, ?)
            `,
            
            updateBlockStatus: `
                UPDATE blocks SET status = ?, confirmed_time = ? WHERE hash = ?
            `,
            
            // Payment関連
            getPendingPayments: `
                SELECT address, SUM(amount) as total
                FROM payments
                WHERE status = 'pending'
                GROUP BY address
                HAVING total >= ?
            `,
            
            insertPayment: `
                INSERT INTO payments (address, amount, txid, status, created_at)
                VALUES (?, ?, ?, ?, ?)
            `,
            
            // 統計
            getPoolStats: `
                SELECT 
                    COUNT(DISTINCT miner_address) as active_miners,
                    COUNT(*) as total_shares,
                    SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) as valid_shares,
                    AVG(difficulty) as avg_difficulty
                FROM shares
                WHERE timestamp > ?
            `
        };
        
        // ステートメントを準備
        Object.entries(statements).forEach(([name, sql]) => {
            try {
                this.statements.set(name, this.db.prepare(sql));
            } catch (error) {
                console.error(`Failed to prepare statement ${name}:`, error);
            }
        });
    }
    
    /**
     * コネクションプールを初期化
     */
    initializeConnectionPool() {
        // 読み取り専用の追加接続を作成
        for (let i = 0; i < Math.min(this.config.maxConnections - 1, 3); i++) {
            try {
                const conn = new Database(this.config.filename, {
                    readonly: true,
                    fileMustExist: true,
                    timeout: this.config.timeout
                });
                
                this.connectionPool.push(conn);
            } catch (error) {
                console.error('Failed to create pool connection:', error);
            }
        }
    }
    
    /**
     * トランザクションを実行
     */
    transaction(callback) {
        return this.db.transaction(callback)();
    }
    
    /**
     * バッチ挿入を実行
     */
    batchInsert(tableName, columns, data) {
        if (data.length === 0) return;
        
        const placeholders = columns.map(() => '?').join(', ');
        const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
        
        const stmt = this.db.prepare(sql);
        
        const insertMany = this.db.transaction((items) => {
            for (const item of items) {
                stmt.run(...columns.map(col => item[col]));
            }
        });
        
        insertMany(data);
    }
    
    /**
     * クエリを実行（読み取り）
     */
    query(sql, params = []) {
        // 読み取りクエリの場合、プールから接続を使用
        if (sql.trim().toUpperCase().startsWith('SELECT') && this.connectionPool.length > 0) {
            const conn = this.connectionPool[Math.floor(Math.random() * this.connectionPool.length)];
            return conn.prepare(sql).all(...params);
        }
        
        return this.db.prepare(sql).all(...params);
    }
    
    /**
     * 単一行を取得
     */
    get(sql, params = []) {
        if (sql.trim().toUpperCase().startsWith('SELECT') && this.connectionPool.length > 0) {
            const conn = this.connectionPool[Math.floor(Math.random() * this.connectionPool.length)];
            return conn.prepare(sql).get(...params);
        }
        
        return this.db.prepare(sql).get(...params);
    }
    
    /**
     * クエリを実行（書き込み）
     */
    run(sql, params = []) {
        return this.db.prepare(sql).run(...params);
    }
    
    /**
     * プリペアドステートメントを実行
     */
    execute(statementName, params = []) {
        const stmt = this.statements.get(statementName);
        if (!stmt) {
            throw new Error(`Statement not found: ${statementName}`);
        }
        
        const method = stmt.reader ? 'all' : 'run';
        return stmt[method](...params);
    }
    
    /**
     * データベースを最適化（VACUUM）
     */
    async optimize() {
        return new Promise((resolve, reject) => {
            try {
                // 増分VACUUM
                this.db.pragma('incremental_vacuum');
                
                // 統計情報を更新
                this.db.exec('ANALYZE');
                
                // インデックスを再構築
                this.db.exec('REINDEX');
                
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    }
    
    /**
     * クエリのパフォーマンスを分析
     */
    explainQuery(sql, params = []) {
        const explainSql = `EXPLAIN QUERY PLAN ${sql}`;
        return this.db.prepare(explainSql).all(...params);
    }
    
    /**
     * 統計情報を取得
     */
    getStats() {
        const stats = {
            pageCount: this.db.pragma('page_count')[0].page_count,
            pageSize: this.db.pragma('page_size')[0].page_size,
            cacheSize: this.db.pragma('cache_size')[0].cache_size,
            journalMode: this.db.pragma('journal_mode')[0].journal_mode,
            walCheckpoint: this.config.walMode ? this.db.pragma('wal_checkpoint(PASSIVE)')[0] : null,
            preparedStatements: this.statements.size,
            connectionPool: this.connectionPool.length
        };
        
        stats.sizeBytes = stats.pageCount * stats.pageSize;
        stats.sizeMB = (stats.sizeBytes / 1024 / 1024).toFixed(2);
        
        return stats;
    }
    
    /**
     * バックアップを作成
     */
    async backup(destinationPath) {
        return new Promise((resolve, reject) => {
            try {
                // オンラインバックアップ
                const backup = this.db.backup(destinationPath);
                
                backup.step(-1); // すべてのページをコピー
                
                resolve({
                    pagesCopied: backup.pageCount,
                    destination: destinationPath
                });
            } catch (error) {
                reject(error);
            }
        });
    }
    
    /**
     * クローズ
     */
    close() {
        // プリペアドステートメントをクローズ
        this.statements.forEach(stmt => {
            stmt.finalize();
        });
        this.statements.clear();
        
        // コネクションプールをクローズ
        this.connectionPool.forEach(conn => {
            conn.close();
        });
        this.connectionPool = [];
        
        // メインコネクションをクローズ
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        
        this.emit('closed');
    }
    
    /**
     * ヘルパーメソッド
     */
    
    // シェアを記録
    async recordShare(share) {
        const params = [
            share.minerAddress,
            share.workerName,
            share.jobId,
            share.nonce,
            share.hash,
            share.difficulty,
            share.isValid ? 1 : 0,
            Date.now()
        ];
        
        return this.execute('insertShare', params);
    }
    
    // マイナー情報を更新
    async updateMinerStats(address, hashrate) {
        return this.execute('insertMiner', [address, hashrate, Date.now()]);
    }
    
    // プール統計を取得
    async getPoolStatistics(since) {
        return this.execute('getPoolStats', [since]);
    }
}

module.exports = OptimizedDatabase;