/**
 * Performance Module Tests
 */

import { test, describe, assert, assertEqual } from './test-runner.js';
import {
  ConnectionPool,
  QueryCache,
  RequestBatcher,
  MemoryPool,
  LazyLoader,
  compress,
  decompress
} from '../lib/performance.js';

// Mock database class
class MockDatabase {
  constructor(path, options) {
    this.path = path;
    this.options = options;
    this.closed = false;
  }
  
  close() {
    this.closed = true;
  }
  
  prepare(query) {
    return {
      get: () => ({ result: 'mock data' }),
      all: () => [{ result: 'mock data' }],
      run: () => ({ changes: 1 })
    };
  }
}

export async function run(results) {
  describe('Performance Module Tests', () => {
    
    describe('Connection Pool', () => {
      test('should create minimum connections', async () => {
        const pool = new ConnectionPool(MockDatabase, 'test.db', { min: 2, max: 5 });
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for initialization
        
        const stats = pool.getStats();
        assertEqual(stats.total, 2, 'Should create minimum connections');
        assertEqual(stats.idle, 2, 'All connections should be idle initially');
      });
      
      test('should acquire and release connections', async () => {
        const pool = new ConnectionPool(MockDatabase, 'test.db', { min: 1, max: 3 });
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const conn = await pool.acquire();
        assert(conn instanceof MockDatabase, 'Should return database instance');
        
        let stats = pool.getStats();
        assertEqual(stats.active, 1, 'Should have one active connection');
        
        pool.release(conn);
        stats = pool.getStats();
        assertEqual(stats.active, 0, 'Should release connection');
      });
      
      test('should create new connections when needed', async () => {
        const pool = new ConnectionPool(MockDatabase, 'test.db', { min: 1, max: 3 });
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const conn1 = await pool.acquire();
        const conn2 = await pool.acquire();
        
        const stats = pool.getStats();
        assert(stats.total >= 2, 'Should create additional connections');
        assertEqual(stats.active, 2, 'Should have two active connections');
        
        pool.release(conn1);
        pool.release(conn2);
      });
    });
    
    describe('Query Cache', () => {
      test('should cache query results', async () => {
        const cache = new QueryCache({ ttl: 1000 });
        
        const query = 'SELECT * FROM users WHERE id = ?';
        const params = [123];
        const data = { id: 123, name: 'Test User' };
        
        cache.set(query, params, data);
        const cached = cache.get(query, params);
        
        assertEqual(cached.id, data.id, 'Should return cached data');
        assertEqual(cache.getStats().hits, 1, 'Should increment hit count');
      });
      
      test('should return null for cache miss', async () => {
        const cache = new QueryCache();
        
        const result = cache.get('SELECT * FROM missing', []);
        assertEqual(result, null, 'Should return null for cache miss');
        assertEqual(cache.getStats().misses, 1, 'Should increment miss count');
      });
      
      test('should expire cached entries', async () => {
        const cache = new QueryCache({ ttl: 100 }); // 100ms TTL
        
        cache.set('SELECT 1', [], { value: 1 });
        assert(cache.get('SELECT 1', []) !== null, 'Should have cached value');
        
        await new Promise(resolve => setTimeout(resolve, 150));
        assertEqual(cache.get('SELECT 1', []), null, 'Should expire after TTL');
      });
      
      test('should evict LRU entries when full', async () => {
        const cache = new QueryCache({ maxSize: 2 });
        
        cache.set('query1', [], { data: 1 });
        cache.set('query2', [], { data: 2 });
        cache.get('query1', []); // Access query1 to make it more recent
        cache.set('query3', [], { data: 3 }); // Should evict query2
        
        assert(cache.get('query1', []) !== null, 'Should keep recently accessed');
        assertEqual(cache.get('query2', []), null, 'Should evict LRU entry');
        assert(cache.get('query3', []) !== null, 'Should keep new entry');
      });
    });
    
    describe('Request Batcher', () => {
      test('should batch multiple requests', async () => {
        let batchCount = 0;
        const batcher = new RequestBatcher({
          maxBatchSize: 3,
          maxWaitTime: 50,
          processor: async (batch) => {
            batchCount++;
            return batch.map(item => ({ 
              data: `processed-${item.request}`,
              error: null 
            }));
          }
        });
        
        const results = await Promise.all([
          batcher.add('req1'),
          batcher.add('req2'),
          batcher.add('req3')
        ]);
        
        assertEqual(batchCount, 1, 'Should process in single batch');
        assertEqual(results[0], 'processed-req1', 'Should return processed result');
      });
      
      test('should process batch after timeout', async () => {
        const batcher = new RequestBatcher({
          maxBatchSize: 10,
          maxWaitTime: 100,
          processor: async (batch) => {
            return batch.map(item => ({ data: item.request, error: null }));
          }
        });
        
        const start = Date.now();
        const result = await batcher.add('single-request');
        const duration = Date.now() - start;
        
        assertEqual(result, 'single-request', 'Should process single request');
        assert(duration >= 90 && duration < 150, 'Should wait for timeout');
      });
    });
    
    describe('Memory Pool', () => {
      test('should allocate and free buffers', async () => {
        const pool = new MemoryPool({ blockSize: 1024, maxBlocks: 10 });
        
        const allocation = pool.allocate(512);
        assert(allocation.buffer instanceof Buffer, 'Should return Buffer');
        assertEqual(allocation.buffer.length, 512, 'Should have requested size');
        
        const stats1 = pool.getStats();
        assertEqual(stats1.used, 1, 'Should track used blocks');
        
        pool.free(allocation.id);
        const stats2 = pool.getStats();
        assertEqual(stats2.used, 0, 'Should free blocks');
        assertEqual(stats2.free, 10, 'Should return to free pool');
      });
      
      test('should handle large allocations', async () => {
        const pool = new MemoryPool({ blockSize: 1024, maxBlocks: 5 });
        
        const allocation = pool.allocate(2048); // Larger than block size
        assertEqual(allocation.id, null, 'Should not use pool for large allocations');
        assert(allocation.buffer.length === 2048, 'Should allocate requested size');
      });
    });
    
    describe('Lazy Loader', () => {
      test('should load data on first access', async () => {
        let loadCount = 0;
        const loader = new LazyLoader(async () => {
          loadCount++;
          return { data: 'loaded' };
        });
        
        const result1 = await loader.get();
        assertEqual(result1.data, 'loaded', 'Should return loaded data');
        assertEqual(loadCount, 1, 'Should load once');
        
        const result2 = await loader.get();
        assertEqual(result2.data, 'loaded', 'Should return cached data');
        assertEqual(loadCount, 1, 'Should not reload');
      });
      
      test('should reload after TTL expires', async () => {
        let loadCount = 0;
        const loader = new LazyLoader(
          async () => {
            loadCount++;
            return { count: loadCount };
          },
          { ttl: 100 }
        );
        
        const result1 = await loader.get();
        assertEqual(result1.count, 1, 'First load');
        
        await new Promise(resolve => setTimeout(resolve, 150));
        
        const result2 = await loader.get();
        assertEqual(result2.count, 2, 'Should reload after TTL');
      });
      
      test('should handle concurrent loads', async () => {
        let loadCount = 0;
        const loader = new LazyLoader(async () => {
          loadCount++;
          await new Promise(resolve => setTimeout(resolve, 100));
          return { count: loadCount };
        });
        
        const [result1, result2, result3] = await Promise.all([
          loader.get(),
          loader.get(),
          loader.get()
        ]);
        
        assertEqual(loadCount, 1, 'Should only load once');
        assertEqual(result1.count, 1, 'All results should be same');
        assertEqual(result2.count, 1, 'All results should be same');
        assertEqual(result3.count, 1, 'All results should be same');
      });
    });
    
    describe('Compression', () => {
      test('should compress and decompress data', async () => {
        const originalData = Buffer.from('This is test data that should be compressed');
        
        const compressed = await compress(originalData);
        assert(compressed.length < originalData.length, 'Should reduce size');
        
        const decompressed = await decompress(compressed);
        assertEqual(
          decompressed.toString(),
          originalData.toString(),
          'Should restore original data'
        );
      });
      
      test('should handle empty data', async () => {
        const empty = Buffer.from('');
        const compressed = await compress(empty);
        const decompressed = await decompress(compressed);
        
        assertEqual(decompressed.length, 0, 'Should handle empty data');
      });
    });
  });
}