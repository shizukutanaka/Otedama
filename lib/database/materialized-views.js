/**
 * Materialized Views for Database Query Optimization
 * Improves query performance by pre-computing complex aggregations
 */

import { createStructuredLogger } from '../core/structured-logger.js';
import { database } from '../storage/database.js';

const logger = createStructuredLogger('MaterializedViews');

export class MaterializedViewManager {
  constructor(options = {}) {
    this.views = new Map();
    this.refreshIntervals = new Map();
    this.database = options.database || database;
    this.isInitialized = false;
  }

  async initialize() {
    if (this.isInitialized) return;
    
    logger.info('Initializing materialized views...');
    
    try {
      // Create materialized views table
      await this.createMetadataTable();
      
      // Define default views
      await this.defineDefaultViews();
      
      // Load existing views
      await this.loadExistingViews();
      
      this.isInitialized = true;
      logger.info('Materialized views initialized');
      
    } catch (error) {
      logger.error('Failed to initialize materialized views:', error);
      throw error;
    }
  }

  async createMetadataTable() {
    await this.database.exec(`
      CREATE TABLE IF NOT EXISTS materialized_views (
        name TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        refresh_interval INTEGER DEFAULT 300000,
        last_refresh INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT 1,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
  }

  async defineDefaultViews() {
    const defaultViews = [
      {
        name: 'hourly_hashrate_stats',
        query: `
          SELECT 
            strftime('%Y-%m-%d %H:00:00', datetime(timestamp, 'unixepoch')) as hour,
            AVG(share_diff) as avg_difficulty,
            COUNT(*) as share_count,
            COUNT(DISTINCT worker_id) as unique_workers,
            SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) as valid_shares,
            SUM(CASE WHEN is_valid = 0 THEN 1 ELSE 0 END) as invalid_shares
          FROM shares
          WHERE timestamp >= strftime('%s', 'now') - 86400
          GROUP BY hour
          ORDER BY hour DESC
        `,
        refreshInterval: 300000 // 5 minutes
      },
      {
        name: 'worker_performance_summary',
        query: `
          SELECT 
            s.worker_id,
            m.address,
            COUNT(*) as total_shares,
            SUM(CASE WHEN s.is_valid = 1 THEN 1 ELSE 0 END) as valid_shares,
            AVG(s.share_diff) as avg_difficulty,
            MAX(s.timestamp) as last_share_time,
            (CAST(SUM(CASE WHEN s.is_valid = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) as efficiency
          FROM shares s
          JOIN miners m ON s.worker_id = m.id
          WHERE s.timestamp >= strftime('%s', 'now') - 3600
          GROUP BY s.worker_id, m.address
          HAVING COUNT(*) > 10
          ORDER BY efficiency DESC, total_shares DESC
        `,
        refreshInterval: 60000 // 1 minute
      },
      {
        name: 'pool_revenue_analysis',
        query: `
          SELECT 
            DATE(datetime(timestamp, 'unixepoch')) as date,
            COUNT(DISTINCT worker_id) as active_workers,
            SUM(reward) as total_rewards,
            AVG(block_diff) as avg_block_difficulty,
            COUNT(CASE WHEN block_height IS NOT NULL THEN 1 END) as blocks_found
          FROM shares
          WHERE timestamp >= strftime('%s', 'now') - 604800 -- 7 days
          GROUP BY date
          ORDER BY date DESC
        `,
        refreshInterval: 1800000 // 30 minutes
      },
      {
        name: 'real_time_pool_stats',
        query: `
          SELECT 
            COUNT(DISTINCT worker_id) as active_workers,
            COUNT(*) as shares_last_minute,
            AVG(share_diff) as current_difficulty,
            SUM(CASE WHEN is_valid = 1 THEN share_diff ELSE 0 END) as total_hashrate,
            CAST(SUM(CASE WHEN is_valid = 1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as pool_efficiency
          FROM shares
          WHERE timestamp >= strftime('%s', 'now') - 60
        `,
        refreshInterval: 10000 // 10 seconds
      }
    ];

    for (const view of defaultViews) {
      await this.createView(view.name, view.query, view.refreshInterval);
    }
  }

  async createView(name, query, refreshInterval = 300000) {
    try {
      // Create the materialized table
      const tableName = `mv_${name}`;
      
      // Drop existing table if exists
      await this.database.exec(`DROP TABLE IF EXISTS ${tableName}`);
      
      // Create new table with query results
      await this.database.exec(`
        CREATE TABLE ${tableName} AS ${query}
      `);
      
      // Create indexes for common query patterns
      await this.createViewIndexes(tableName);
      
      // Store metadata
      await this.database.run(`
        INSERT OR REPLACE INTO materialized_views 
        (name, query, refresh_interval, last_refresh)
        VALUES (?, ?, ?, ?)
      `, [name, query, refreshInterval, Date.now()]);
      
      // Setup refresh schedule
      this.scheduleRefresh(name, query, refreshInterval);
      
      this.views.set(name, { tableName, query, refreshInterval });
      
      logger.info(`Created materialized view: ${name}`);
      
    } catch (error) {
      logger.error(`Failed to create view ${name}:`, error);
      throw error;
    }
  }

  async createViewIndexes(tableName) {
    // Create indexes based on table name patterns
    if (tableName.includes('hourly')) {
      await this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_${tableName}_hour 
        ON ${tableName}(hour)
      `).catch(() => {}); // Ignore if column doesn't exist
    }
    
    if (tableName.includes('worker')) {
      await this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_${tableName}_worker 
        ON ${tableName}(worker_id)
      `).catch(() => {});
    }
    
    if (tableName.includes('date')) {
      await this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_${tableName}_date 
        ON ${tableName}(date)
      `).catch(() => {});
    }
  }

  scheduleRefresh(name, query, interval) {
    // Clear existing interval if any
    const existingInterval = this.refreshIntervals.get(name);
    if (existingInterval) {
      clearInterval(existingInterval);
    }
    
    // Schedule periodic refresh
    const intervalId = setInterval(async () => {
      await this.refreshView(name, query);
    }, interval);
    
    this.refreshIntervals.set(name, intervalId);
  }

  async refreshView(name, query) {
    try {
      const tableName = `mv_${name}`;
      
      logger.debug(`Refreshing materialized view: ${name}`);
      
      // Use transaction for atomic refresh
      await this.database.transaction(async (db) => {
        // Create temporary table
        await db.exec(`DROP TABLE IF EXISTS ${tableName}_temp`);
        await db.exec(`CREATE TABLE ${tableName}_temp AS ${query}`);
        
        // Swap tables
        await db.exec(`DROP TABLE IF EXISTS ${tableName}_old`);
        await db.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_old`);
        await db.exec(`ALTER TABLE ${tableName}_temp RENAME TO ${tableName}`);
        await db.exec(`DROP TABLE ${tableName}_old`);
        
        // Update metadata
        await db.run(`
          UPDATE materialized_views 
          SET last_refresh = ? 
          WHERE name = ?
        `, [Date.now(), name]);
      });
      
      // Recreate indexes
      await this.createViewIndexes(tableName);
      
      logger.debug(`Refreshed materialized view: ${name}`);
      
    } catch (error) {
      logger.error(`Failed to refresh view ${name}:`, error);
    }
  }

  async query(viewName, params = {}) {
    const view = this.views.get(viewName);
    if (!view) {
      throw new Error(`Materialized view not found: ${viewName}`);
    }
    
    const tableName = view.tableName;
    
    // Build query with optional WHERE clause
    let query = `SELECT * FROM ${tableName}`;
    const conditions = [];
    const values = [];
    
    if (params.where) {
      for (const [key, value] of Object.entries(params.where)) {
        conditions.push(`${key} = ?`);
        values.push(value);
      }
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    
    if (params.orderBy) {
      query += ` ORDER BY ${params.orderBy}`;
    }
    
    if (params.limit) {
      query += ` LIMIT ${params.limit}`;
    }
    
    return this.database.all(query, values);
  }

  async loadExistingViews() {
    const views = await this.database.all(`
      SELECT * FROM materialized_views WHERE is_active = 1
    `);
    
    for (const view of views) {
      this.views.set(view.name, {
        tableName: `mv_${view.name}`,
        query: view.query,
        refreshInterval: view.refresh_interval
      });
      
      // Restart refresh schedules
      this.scheduleRefresh(view.name, view.query, view.refresh_interval);
    }
    
    logger.info(`Loaded ${views.length} existing materialized views`);
  }

  async dropView(name) {
    try {
      const view = this.views.get(name);
      if (!view) return;
      
      // Clear refresh interval
      const intervalId = this.refreshIntervals.get(name);
      if (intervalId) {
        clearInterval(intervalId);
        this.refreshIntervals.delete(name);
      }
      
      // Drop table
      await this.database.exec(`DROP TABLE IF EXISTS ${view.tableName}`);
      
      // Update metadata
      await this.database.run(`
        UPDATE materialized_views 
        SET is_active = 0 
        WHERE name = ?
      `, [name]);
      
      this.views.delete(name);
      
      logger.info(`Dropped materialized view: ${name}`);
      
    } catch (error) {
      logger.error(`Failed to drop view ${name}:`, error);
      throw error;
    }
  }

  async getViewStats() {
    const stats = [];
    
    for (const [name, view] of this.views) {
      const metadata = await this.database.get(`
        SELECT * FROM materialized_views WHERE name = ?
      `, [name]);
      
      const tableInfo = await this.database.get(`
        SELECT COUNT(*) as row_count 
        FROM ${view.tableName}
      `).catch(() => ({ row_count: 0 }));
      
      stats.push({
        name,
        tableName: view.tableName,
        rowCount: tableInfo.row_count,
        lastRefresh: metadata?.last_refresh || 0,
        refreshInterval: view.refreshInterval,
        nextRefresh: (metadata?.last_refresh || 0) + view.refreshInterval
      });
    }
    
    return stats;
  }

  shutdown() {
    // Clear all refresh intervals
    for (const intervalId of this.refreshIntervals.values()) {
      clearInterval(intervalId);
    }
    
    this.refreshIntervals.clear();
    this.views.clear();
    
    logger.info('Materialized views manager shutdown');
  }
}

// Export singleton instance
export const materializedViews = new MaterializedViewManager();