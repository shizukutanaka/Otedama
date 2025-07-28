/**
 * Unit Tests for Materialized Views
 */

import { MaterializedViewManager } from '../../lib/database/materialized-views.js';
import { Database } from '../../lib/storage/database.js';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';

describe('MaterializedViewManager', () => {
  let viewManager;
  let testDb;
  const testDbPath = path.join(process.cwd(), 'test-views.db');
  
  beforeEach(async () => {
    // Create test database
    testDb = new Database({ filename: testDbPath });
    await testDb.initialize();
    
    // Create test table with data
    await testDb.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker_id TEXT NOT NULL,
        share_diff REAL NOT NULL,
        is_valid BOOLEAN DEFAULT 1,
        timestamp INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    
    // Insert test data
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 100; i++) {
      await testDb.run(`
        INSERT INTO shares (worker_id, share_diff, is_valid, timestamp)
        VALUES (?, ?, ?, ?)
      `, [`worker_${i % 10}`, Math.random() * 1000, i % 20 !== 0 ? 1 : 0, now - i * 60]);
    }
    
    viewManager = new MaterializedViewManager({ database: testDb });
  });
  
  afterEach(async () => {
    viewManager.shutdown();
    await testDb.close();
    await fs.unlink(testDbPath).catch(() => {});
  });
  
  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      await viewManager.initialize();
      expect(viewManager.isInitialized).toBe(true);
    });
    
    it('should create metadata table', async () => {
      await viewManager.initialize();
      
      const tables = await testDb.all(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='materialized_views'
      `);
      
      expect(tables).toHaveLength(1);
    });
    
    it('should not reinitialize if already initialized', async () => {
      await viewManager.initialize();
      const spy = jest.spyOn(viewManager, 'createMetadataTable');
      
      await viewManager.initialize();
      expect(spy).not.toHaveBeenCalled();
    });
  });
  
  describe('View Creation', () => {
    beforeEach(async () => {
      await viewManager.initialize();
    });
    
    it('should create a materialized view', async () => {
      const viewName = 'test_stats';
      const query = `
        SELECT 
          COUNT(*) as total_shares,
          AVG(share_diff) as avg_difficulty
        FROM shares
      `;
      
      await viewManager.createView(viewName, query);
      
      expect(viewManager.views.has(viewName)).toBe(true);
      
      // Check table exists
      const tables = await testDb.all(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='mv_test_stats'
      `);
      expect(tables).toHaveLength(1);
    });
    
    it('should populate view with query results', async () => {
      await viewManager.createView('worker_stats', `
        SELECT 
          worker_id,
          COUNT(*) as share_count,
          AVG(share_diff) as avg_diff
        FROM shares
        GROUP BY worker_id
      `);
      
      const results = await testDb.all('SELECT * FROM mv_worker_stats');
      expect(results).toHaveLength(10); // 10 unique workers
      expect(results[0]).toHaveProperty('worker_id');
      expect(results[0]).toHaveProperty('share_count');
      expect(results[0]).toHaveProperty('avg_diff');
    });
    
    it('should schedule automatic refresh', async () => {
      const refreshInterval = 100; // 100ms for testing
      
      await viewManager.createView('refresh_test', 
        'SELECT COUNT(*) as count FROM shares',
        refreshInterval
      );
      
      const initialResult = await testDb.get('SELECT count FROM mv_refresh_test');
      const initialCount = initialResult.count;
      
      // Add more data
      await testDb.run(`
        INSERT INTO shares (worker_id, share_diff) VALUES ('new_worker', 500)
      `);
      
      // Wait for refresh
      await new Promise(resolve => setTimeout(resolve, 150));
      
      const refreshedResult = await testDb.get('SELECT count FROM mv_refresh_test');
      expect(refreshedResult.count).toBe(initialCount + 1);
    });
  });
  
  describe('View Querying', () => {
    beforeEach(async () => {
      await viewManager.initialize();
      await viewManager.createView('queryable_view', `
        SELECT 
          worker_id,
          COUNT(*) as shares,
          AVG(share_diff) as avg_diff
        FROM shares
        GROUP BY worker_id
      `);
    });
    
    it('should query materialized view', async () => {
      const results = await viewManager.query('queryable_view');
      expect(results).toHaveLength(10);
    });
    
    it('should support WHERE conditions', async () => {
      const results = await viewManager.query('queryable_view', {
        where: { worker_id: 'worker_1' }
      });
      
      expect(results).toHaveLength(1);
      expect(results[0].worker_id).toBe('worker_1');
    });
    
    it('should support ORDER BY', async () => {
      const results = await viewManager.query('queryable_view', {
        orderBy: 'shares DESC'
      });
      
      expect(results[0].shares).toBeGreaterThanOrEqual(results[1].shares);
    });
    
    it('should support LIMIT', async () => {
      const results = await viewManager.query('queryable_view', {
        limit: 5
      });
      
      expect(results).toHaveLength(5);
    });
    
    it('should throw error for non-existent view', async () => {
      await expect(viewManager.query('non_existent')).rejects.toThrow('not found');
    });
  });
  
  describe('View Management', () => {
    beforeEach(async () => {
      await viewManager.initialize();
    });
    
    it('should drop a view', async () => {
      await viewManager.createView('to_drop', 'SELECT 1 as test');
      expect(viewManager.views.has('to_drop')).toBe(true);
      
      await viewManager.dropView('to_drop');
      expect(viewManager.views.has('to_drop')).toBe(false);
      
      // Check table is dropped
      const tables = await testDb.all(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='mv_to_drop'
      `);
      expect(tables).toHaveLength(0);
    });
    
    it('should get view statistics', async () => {
      await viewManager.createView('stats_view', `
        SELECT worker_id, COUNT(*) as cnt FROM shares GROUP BY worker_id
      `, 60000);
      
      const stats = await viewManager.getViewStats();
      
      expect(stats).toHaveLength(1);
      expect(stats[0]).toMatchObject({
        name: 'stats_view',
        tableName: 'mv_stats_view',
        rowCount: 10,
        refreshInterval: 60000
      });
      expect(stats[0].lastRefresh).toBeGreaterThan(0);
      expect(stats[0].nextRefresh).toBeGreaterThan(stats[0].lastRefresh);
    });
    
    it('should handle refresh errors gracefully', async () => {
      await viewManager.createView('error_view', 'SELECT 1 as test');
      
      // Make query invalid
      viewManager.views.get('error_view').query = 'INVALID SQL';
      
      // Should not throw
      await expect(viewManager.refreshView('error_view', 'INVALID SQL'))
        .resolves.not.toThrow();
    });
  });
  
  describe('Default Views', () => {
    it('should create default views on initialization', async () => {
      await viewManager.initialize();
      
      const expectedViews = [
        'hourly_hashrate_stats',
        'worker_performance_summary',
        'pool_revenue_analysis',
        'real_time_pool_stats'
      ];
      
      for (const viewName of expectedViews) {
        expect(viewManager.views.has(viewName)).toBe(true);
      }
    });
  });
  
  describe('Performance', () => {
    it('should handle large datasets efficiently', async () => {
      // Insert 10,000 records
      await testDb.transaction(async (db) => {
        for (let i = 0; i < 10000; i++) {
          await db.run(`
            INSERT INTO shares (worker_id, share_diff)
            VALUES (?, ?)
          `, [`worker_${i % 100}`, Math.random() * 1000]);
        }
      });
      
      const start = Date.now();
      await viewManager.createView('large_view', `
        SELECT 
          worker_id,
          COUNT(*) as shares,
          AVG(share_diff) as avg_diff,
          MIN(share_diff) as min_diff,
          MAX(share_diff) as max_diff
        FROM shares
        GROUP BY worker_id
      `);
      const duration = Date.now() - start;
      
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
      
      const results = await viewManager.query('large_view');
      expect(results).toHaveLength(100);
    });
  });
});