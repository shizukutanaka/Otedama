/**
 * Database Query Optimizer for Storage Operations
 * Optimizes queries for better performance
 * 
 * Design principles:
 * - Martin: Clean query building and optimization
 * - Pike: Simple but effective optimizations
 * - Carmack: Fast query execution
 */

import { createStructuredLogger } from '../core/structured-logger.js';
import { sqlValidator } from '../security/sql-validator.js';

const logger = createStructuredLogger('DBQueryOptimizer');

export class DBQueryOptimizer {
  constructor(db) {
    this.db = db;
    this.queryCache = new Map();
    this.stats = {
      optimized: 0,
      cacheHits: 0,
      slowQueries: 0
    };
    
    // Slow query threshold in milliseconds
    this.slowQueryThreshold = 100;
    
    // Prepared statements cache
    this.statements = new Map();
  }
  
  /**
   * Prepare and cache a statement
   */
  prepareStatement(key, sql) {
    if (!this.statements.has(key)) {
      const stmt = this.db.prepare(sql);
      this.statements.set(key, stmt);
      logger.debug(`Prepared statement: ${key}`);
    }
    return this.statements.get(key);
  }
  
  /**
   * Get miner with optimized query
   */
  getMinerOptimized(minerId) {
    // Use prepared statement for better performance
    const stmt = this.prepareStatement(
      'getMiner',
      'SELECT * FROM miners WHERE id = ?'
    );
    
    return this.executeWithTiming('getMiner', () => {
      return stmt.get(minerId);
    });
  }
  
  /**
   * Get active miners with pagination
   */
  getActiveMiners(options = {}) {
    const {
      limit = 100,
      offset = 0,
      since = Date.now() - 24 * 60 * 60 * 1000 // 24 hours
    } = options;
    
    const stmt = this.prepareStatement(
      'getActiveMiners',
      `
        SELECT 
          m.*,
          COUNT(s.id) as share_count,
          SUM(s.difficulty) as total_difficulty,
          MAX(s.timestamp) as last_share_time
        FROM miners m
        INNER JOIN shares s ON m.id = s.miner_id
        WHERE s.timestamp > ?
        GROUP BY m.id
        HAVING share_count > 0
        ORDER BY total_difficulty DESC
        LIMIT ? OFFSET ?
      `
    );
    
    return this.executeWithTiming('getActiveMiners', () => {
      return stmt.all(Math.floor(since / 1000), limit, offset);
    });
  }
  
  /**
   * Get miner statistics efficiently
   */
  getMinerStats(minerId, period = '24h') {
    const periods = {
      '1h': 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000
    };
    
    const since = Date.now() - (periods[period] || periods['24h']);
    
    const stmt = this.prepareStatement(
      `getMinerStats_${period}`,
      `
        SELECT 
          COUNT(*) as total_shares,
          COUNT(CASE WHEN is_valid = 1 THEN 1 END) as valid_shares,
          COUNT(CASE WHEN is_block = 1 THEN 1 END) as blocks_found,
          SUM(difficulty) as total_difficulty,
          AVG(difficulty) as avg_difficulty,
          MIN(timestamp) as first_share,
          MAX(timestamp) as last_share,
          AVG(actual_difficulty / difficulty) as avg_efficiency
        FROM shares
        WHERE miner_id = ? AND timestamp > ?
      `
    );
    
    return this.executeWithTiming(`getMinerStats_${period}`, () => {
      return stmt.get(minerId, Math.floor(since / 1000));
    });
  }
  
  /**
   * Get top miners by performance
   */
  getTopMiners(options = {}) {
    const {
      limit = 10,
      metric = 'difficulty', // difficulty, shares, blocks
      period = '24h'
    } = options;
    
    const periods = {
      '1h': 60 * 60,
      '24h': 24 * 60 * 60,
      '7d': 7 * 24 * 60 * 60
    };
    
    const secondsAgo = periods[period] || periods['24h'];
    
    let orderBy;
    switch (metric) {
      case 'shares':
        orderBy = 'share_count DESC';
        break;
      case 'blocks':
        orderBy = 'blocks_found DESC';
        break;
      default:
        orderBy = 'total_difficulty DESC';
    }
    
    const sql = `
      SELECT 
        m.id,
        m.address,
        m.worker,
        COUNT(s.id) as share_count,
        SUM(s.difficulty) as total_difficulty,
        COUNT(CASE WHEN s.is_block = 1 THEN 1 END) as blocks_found,
        MAX(s.timestamp) as last_share_time
      FROM miners m
      INNER JOIN shares s ON m.id = s.miner_id
      WHERE s.timestamp > strftime('%s', 'now', '-${secondsAgo} seconds')
      GROUP BY m.id
      ORDER BY ${orderBy}
      LIMIT ?
    `;
    
    const stmt = this.prepareStatement(`getTopMiners_${metric}_${period}`, sql);
    
    return this.executeWithTiming('getTopMiners', () => {
      return stmt.all(limit);
    });
  }
  
  /**
   * Get pool statistics with single optimized query
   */
  getPoolStats() {
    const stmt = this.prepareStatement(
      'getPoolStats',
      `
        WITH time_periods AS (
          SELECT 
            strftime('%s', 'now', '-1 hour') as hour_ago,
            strftime('%s', 'now', '-24 hours') as day_ago,
            strftime('%s', 'now', '-7 days') as week_ago
        ),
        share_stats AS (
          SELECT 
            COUNT(CASE WHEN timestamp > (SELECT hour_ago FROM time_periods) THEN 1 END) as shares_1h,
            COUNT(CASE WHEN timestamp > (SELECT day_ago FROM time_periods) THEN 1 END) as shares_24h,
            COUNT(CASE WHEN timestamp > (SELECT week_ago FROM time_periods) THEN 1 END) as shares_7d,
            SUM(CASE WHEN timestamp > (SELECT hour_ago FROM time_periods) THEN difficulty ELSE 0 END) as difficulty_1h,
            SUM(CASE WHEN timestamp > (SELECT day_ago FROM time_periods) THEN difficulty ELSE 0 END) as difficulty_24h,
            COUNT(CASE WHEN is_block = 1 AND timestamp > (SELECT day_ago FROM time_periods) THEN 1 END) as blocks_24h
          FROM shares
        ),
        miner_stats AS (
          SELECT 
            COUNT(DISTINCT CASE WHEN s.timestamp > (SELECT hour_ago FROM time_periods) THEN m.id END) as miners_1h,
            COUNT(DISTINCT CASE WHEN s.timestamp > (SELECT day_ago FROM time_periods) THEN m.id END) as miners_24h
          FROM miners m
          INNER JOIN shares s ON m.id = s.miner_id
        )
        SELECT 
          ss.*,
          ms.*,
          (SELECT COUNT(*) FROM blocks WHERE is_orphan = 0) as total_blocks,
          (SELECT COUNT(*) FROM blocks WHERE confirmations < 100) as pending_blocks,
          (SELECT SUM(amount) FROM payments WHERE status = 'pending') as pending_payments
        FROM share_stats ss, miner_stats ms
      `
    );
    
    return this.executeWithTiming('getPoolStats', () => {
      return stmt.get();
    });
  }
  
  /**
   * Batch insert shares efficiently
   */
  insertSharesBatch(shares) {
    const stmt = this.prepareStatement(
      'insertShare',
      `
        INSERT INTO shares (
          miner_id, job_id, nonce, difficulty, 
          actual_difficulty, is_valid, is_block, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    
    return this.executeWithTiming('insertSharesBatch', () => {
      const insertMany = this.db.transaction((shares) => {
        for (const share of shares) {
          stmt.run(
            share.minerId,
            share.jobId,
            share.nonce,
            share.difficulty,
            share.actualDifficulty,
            share.isValid ? 1 : 0,
            share.isBlock ? 1 : 0,
            share.timestamp || Math.floor(Date.now() / 1000)
          );
        }
      });
      
      return insertMany(shares);
    });
  }
  
  /**
   * Update hourly statistics (for materialized view)
   */
  updateHourlyStats() {
    const stmt = this.prepareStatement(
      'updateHourlyStats',
      `
        INSERT OR REPLACE INTO hourly_stats (
          hour_timestamp, total_shares, valid_shares, 
          total_difficulty, unique_miners, blocks_found
        )
        SELECT 
          strftime('%s', datetime(timestamp, 'unixepoch', 'start of hour')) as hour,
          COUNT(*) as total_shares,
          COUNT(CASE WHEN is_valid = 1 THEN 1 END) as valid_shares,
          SUM(difficulty) as total_difficulty,
          COUNT(DISTINCT miner_id) as unique_miners,
          COUNT(CASE WHEN is_block = 1 THEN 1 END) as blocks_found
        FROM shares
        WHERE timestamp > strftime('%s', 'now', '-2 hours')
        GROUP BY hour
      `
    );
    
    return this.executeWithTiming('updateHourlyStats', () => {
      return stmt.run();
    });
  }
  
  /**
   * Clean old data with efficient deletion
   */
  cleanOldData(options = {}) {
    const {
      shareRetentionDays = 7,
      batchSize = 1000
    } = options;
    
    const cutoff = Math.floor(Date.now() / 1000) - (shareRetentionDays * 24 * 60 * 60);
    
    // Delete in batches to avoid locking
    const deleteStmt = this.prepareStatement(
      'deleteOldShares',
      `
        DELETE FROM shares 
        WHERE id IN (
          SELECT id FROM shares 
          WHERE timestamp < ? 
          ORDER BY id 
          LIMIT ?
        )
      `
    );
    
    return this.executeWithTiming('cleanOldData', () => {
      let totalDeleted = 0;
      let deleted;
      
      do {
        const result = deleteStmt.run(cutoff, batchSize);
        deleted = result.changes;
        totalDeleted += deleted;
        
        // Small delay between batches
        if (deleted > 0) {
          // In real implementation, would use setImmediate or similar
        }
      } while (deleted === batchSize);
      
      logger.info(`Cleaned ${totalDeleted} old shares`);
      return totalDeleted;
    });
  }
  
  /**
   * Execute query with timing and logging
   */
  executeWithTiming(name, fn) {
    const start = Date.now();
    
    try {
      const result = fn();
      const duration = Date.now() - start;
      
      if (duration > this.slowQueryThreshold) {
        this.stats.slowQueries++;
        logger.warn(`Slow query detected: ${name}`, { duration });
      }
      
      this.stats.optimized++;
      
      return result;
    } catch (error) {
      logger.error(`Query error: ${name}`, error);
      throw error;
    }
  }
  
  /**
   * Get query statistics
   */
  getStats() {
    return {
      ...this.stats,
      cachedStatements: this.statements.size,
      queryCache: this.queryCache.size
    };
  }
  
  /**
   * Clear caches and prepared statements
   */
  clear() {
    for (const [key, stmt] of this.statements) {
      try {
        stmt.finalize();
      } catch (error) {
        logger.error(`Failed to finalize statement: ${key}`, error);
      }
    }
    
    this.statements.clear();
    this.queryCache.clear();
    
    logger.info('Query optimizer cleared');
  }
}

export default DBQueryOptimizer;