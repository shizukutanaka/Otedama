const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

class ShardManager {
    constructor(config) {
        this.config = {
            shardCount: config.shardCount || 16,
            dataDir: config.dataDir || './data/shards',
            maxShardSize: config.maxShardSize || 1024 * 1024 * 1024, // 1GB
            replicationFactor: config.replicationFactor || 2,
            ...config
        };
        
        this.shards = new Map();
        this.shardStats = new Map();
        this.initialized = false;
    }
    
    async initialize() {
        // Create shard directory
        await fs.mkdir(this.config.dataDir, { recursive: true });
        
        // Initialize shards
        for (let i = 0; i < this.config.shardCount; i++) {
            await this.initializeShard(i);
        }
        
        this.initialized = true;
        console.log(`Initialized ${this.config.shardCount} database shards`);
    }
    
    async initializeShard(shardId) {
        const shardPath = path.join(this.config.dataDir, `shard_${shardId}.db`);
        const db = new sqlite3.Database(shardPath);
        
        await new Promise((resolve, reject) => {
            db.serialize(() => {
                // Shares table
                db.run(`CREATE TABLE IF NOT EXISTS shares (
                    id TEXT PRIMARY KEY,
                    miner TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    difficulty REAL NOT NULL,
                    hash TEXT NOT NULL,
                    block_height INTEGER,
                    valid INTEGER DEFAULT 1,
                    INDEX idx_miner (miner),
                    INDEX idx_timestamp (timestamp)
                )`);
                
                // Payouts table
                db.run(`CREATE TABLE IF NOT EXISTS payouts (
                    id TEXT PRIMARY KEY,
                    miner TEXT NOT NULL,
                    amount REAL NOT NULL,
                    timestamp INTEGER NOT NULL,
                    tx_hash TEXT,
                    status TEXT DEFAULT 'pending',
                    INDEX idx_miner_status (miner, status)
                )`);
                
                // Stats table
                db.run(`CREATE TABLE IF NOT EXISTS stats (
                    miner TEXT PRIMARY KEY,
                    total_shares INTEGER DEFAULT 0,
                    total_difficulty REAL DEFAULT 0,
                    last_share INTEGER,
                    total_payout REAL DEFAULT 0
                )`, resolve);
            });
        });
        
        this.shards.set(shardId, db);
        this.shardStats.set(shardId, {
            size: 0,
            shares: 0,
            lastWrite: Date.now()
        });
    }
    
    getShardId(key) {
        // Consistent hashing for shard selection
        const hash = crypto.createHash('sha256').update(key).digest();
        return hash.readUInt32BE(0) % this.config.shardCount;
    }
    
    async insertShare(share) {
        if (!this.initialized) await this.initialize();
        
        const shardId = this.getShardId(share.miner);
        const db = this.shards.get(shardId);
        
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO shares (id, miner, timestamp, difficulty, hash, block_height) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [share.id, share.miner, share.timestamp, share.difficulty, share.hash, share.blockHeight],
                err => {
                    if (err) reject(err);
                    else {
                        this.updateShardStats(shardId, 'share');
                        resolve();
                    }
                }
            );
            
            // Update miner stats
            db.run(
                `INSERT INTO stats (miner, total_shares, total_difficulty, last_share) 
                 VALUES (?, 1, ?, ?)
                 ON CONFLICT(miner) DO UPDATE SET
                    total_shares = total_shares + 1,
                    total_difficulty = total_difficulty + ?,
                    last_share = ?`,
                [share.miner, share.difficulty, share.timestamp, share.difficulty, share.timestamp]
            );
        });
    }
    
    async getSharesForMiner(miner, startTime, endTime) {
        if (!this.initialized) await this.initialize();
        
        const shardId = this.getShardId(miner);
        const db = this.shards.get(shardId);
        
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT * FROM shares 
                 WHERE miner = ? AND timestamp >= ? AND timestamp <= ? 
                 ORDER BY timestamp DESC`,
                [miner, startTime, endTime],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }
    
    async getMinerStats(miner) {
        if (!this.initialized) await this.initialize();
        
        const shardId = this.getShardId(miner);
        const db = this.shards.get(shardId);
        
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM stats WHERE miner = ?`,
                [miner],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row || {
                        miner: miner,
                        total_shares: 0,
                        total_difficulty: 0,
                        last_share: null,
                        total_payout: 0
                    });
                }
            );
        });
    }
    
    async insertPayout(payout) {
        if (!this.initialized) await this.initialize();
        
        const shardId = this.getShardId(payout.miner);
        const db = this.shards.get(shardId);
        
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO payouts (id, miner, amount, timestamp, tx_hash, status) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [payout.id, payout.miner, payout.amount, payout.timestamp, payout.txHash, payout.status],
                err => {
                    if (err) reject(err);
                    else {
                        // Update miner stats
                        db.run(
                            `UPDATE stats SET total_payout = total_payout + ? WHERE miner = ?`,
                            [payout.amount, payout.miner]
                        );
                        resolve();
                    }
                }
            );
        });
    }
    
    async getPendingPayouts() {
        if (!this.initialized) await this.initialize();
        
        const allPayouts = [];
        
        for (const [shardId, db] of this.shards) {
            const payouts = await new Promise((resolve, reject) => {
                db.all(
                    `SELECT * FROM payouts WHERE status = 'pending'`,
                    (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    }
                );
            });
            allPayouts.push(...payouts);
        }
        
        return allPayouts;
    }
    
    async updatePayoutStatus(payoutId, status, txHash) {
        // Need to check all shards since we don't know which one has the payout
        for (const [shardId, db] of this.shards) {
            await new Promise((resolve) => {
                db.run(
                    `UPDATE payouts SET status = ?, tx_hash = ? WHERE id = ?`,
                    [status, txHash, payoutId],
                    resolve
                );
            });
        }
    }
    
    async getGlobalStats() {
        if (!this.initialized) await this.initialize();
        
        const stats = {
            totalShares: 0,
            totalDifficulty: 0,
            totalMiners: 0,
            totalPayouts: 0
        };
        
        for (const [shardId, db] of this.shards) {
            const shardStats = await new Promise((resolve, reject) => {
                db.get(
                    `SELECT 
                        COUNT(DISTINCT miner) as miners,
                        SUM(total_shares) as shares,
                        SUM(total_difficulty) as difficulty,
                        SUM(total_payout) as payouts
                     FROM stats`,
                    (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    }
                );
            });
            
            stats.totalMiners += shardStats.miners || 0;
            stats.totalShares += shardStats.shares || 0;
            stats.totalDifficulty += shardStats.difficulty || 0;
            stats.totalPayouts += shardStats.payouts || 0;
        }
        
        return stats;
    }
    
    updateShardStats(shardId, operation) {
        const stats = this.shardStats.get(shardId);
        if (stats) {
            if (operation === 'share') {
                stats.shares++;
            }
            stats.lastWrite = Date.now();
        }
    }
    
    async rebalanceShards() {
        // Advanced: Implement shard rebalancing based on size and load
        // This would move data between shards to maintain balance
        console.log('Shard rebalancing not implemented yet');
    }
    
    async backup(backupDir) {
        await fs.mkdir(backupDir, { recursive: true });
        
        for (let i = 0; i < this.config.shardCount; i++) {
            const sourcePath = path.join(this.config.dataDir, `shard_${i}.db`);
            const destPath = path.join(backupDir, `shard_${i}_${Date.now()}.db`);
            
            await fs.copyFile(sourcePath, destPath);
        }
        
        console.log(`Backed up ${this.config.shardCount} shards to ${backupDir}`);
    }
    
    async close() {
        for (const [shardId, db] of this.shards) {
            await new Promise((resolve) => db.close(resolve));
        }
        this.shards.clear();
        this.initialized = false;
    }
}

module.exports = ShardManager;