/**
 * Performance Optimization Tests - Otedama
 * Test performance improvements and object pooling
 */

import { jest } from '@jest/globals';
import { OptimizedObjectPool, miningPools } from '../lib/core/optimized-object-pool.js';
import { EnhancedErrorRecovery, errorRecovery } from '../lib/core/enhanced-error-recovery.js';
import { OtedamaError, ErrorCategory, ErrorSeverity } from '../lib/core/error-handler-unified.js';

describe('Performance Optimization', () => {
  
  describe('OptimizedObjectPool', () => {
    let pool;
    
    beforeEach(() => {
      pool = new OptimizedObjectPool(
        () => ({ id: 0, data: null }),
        (obj) => { obj.id = 0; obj.data = null; },
        10, // initial size
        100 // max size
      );
    });
    
    afterEach(() => {
      pool.clear();
    });
    
    test('should pre-populate pool with initial objects', () => {
      const stats = pool.getStats();
      expect(stats.poolSize).toBe(10);
      expect(stats.created).toBe(10);
    });
    
    test('should reuse objects from pool for better performance', () => {
      const obj1 = pool.acquire();
      const obj2 = pool.acquire();
      
      expect(obj1).toBeDefined();
      expect(obj2).toBeDefined();
      
      const stats = pool.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.reused).toBe(2);
    });
    
    test('should reset objects when released back to pool', () => {
      const obj = pool.acquire();
      obj.id = 123;
      obj.data = 'test';
      
      pool.release(obj);
      
      const reusedObj = pool.acquire();
      expect(reusedObj.id).toBe(0);
      expect(reusedObj.data).toBeNull();
    });
    
    test('should handle pool exhaustion gracefully', () => {
      // Exhaust pool
      const objects = [];
      for (let i = 0; i < 15; i++) {
        objects.push(pool.acquire());
      }
      
      const stats = pool.getStats();
      expect(stats.misses).toBe(5); // 5 objects created beyond pool size
      expect(stats.created).toBe(15);
    });
    
    test('should maintain maximum pool size', () => {
      // Fill pool beyond max size
      const objects = [];
      for (let i = 0; i < 150; i++) {
        objects.push(pool.acquire());
      }
      
      // Release all objects
      objects.forEach(obj => pool.release(obj));
      
      const stats = pool.getStats();
      expect(stats.poolSize).toBeLessThanOrEqual(100); // Max size
    });
    
    test('should provide accurate hit rate statistics', () => {
      // Mix of hits and misses
      for (let i = 0; i < 15; i++) {
        pool.acquire();
      }
      
      const stats = pool.getStats();
      const expectedHitRate = (stats.hits / (stats.hits + stats.misses)) * 100;
      expect(stats.hitRate).toBeCloseTo(expectedHitRate, 2);
    });
  });
  
  describe('MiningObjectPools', () => {
    
    test('should provide all required mining object pools', () => {
      expect(miningPools.sharePool).toBeDefined();
      expect(miningPools.jobPool).toBeDefined();
      expect(miningPools.messagePool).toBeDefined();
      expect(miningPools.bufferPool).toBeDefined();
      expect(miningPools.statsPool).toBeDefined();
    });
    
    test('should provide working share objects', () => {
      const share = miningPools.sharePool.acquire();
      
      expect(share).toHaveProperty('minerId');
      expect(share).toHaveProperty('nonce');
      expect(share).toHaveProperty('hash');
      expect(share).toHaveProperty('difficulty');
      expect(share).toHaveProperty('timestamp');
      expect(share).toHaveProperty('valid');
      expect(share).toHaveProperty('target');
      
      miningPools.sharePool.release(share);
    });
    
    test('should provide working job objects', () => {
      const job = miningPools.jobPool.acquire();
      
      expect(job).toHaveProperty('id');
      expect(job).toHaveProperty('prevHash');
      expect(job).toHaveProperty('coinbase1');
      expect(job).toHaveProperty('coinbase2');
      expect(job).toHaveProperty('merkleRoot');
      expect(job).toHaveProperty('blockVersion');
      expect(job).toHaveProperty('nBits');
      expect(job).toHaveProperty('nTime');
      expect(job).toHaveProperty('cleanJobs');
      expect(job).toHaveProperty('transactions');
      
      miningPools.jobPool.release(job);
    });
    
    test('should provide working buffer objects', () => {
      const buffer = miningPools.bufferPool.acquire();
      
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.length).toBe(1024);
      
      miningPools.bufferPool.release(buffer);
    });
    
    test('should provide comprehensive pool statistics', () => {
      const stats = miningPools.getAllStats();
      
      expect(stats).toHaveProperty('sharePool');
      expect(stats).toHaveProperty('jobPool');
      expect(stats).toHaveProperty('messagePool');
      expect(stats).toHaveProperty('bufferPool');
      expect(stats).toHaveProperty('statsPool');
      
      expect(stats.sharePool).toHaveProperty('hitRate');
      expect(stats.sharePool).toHaveProperty('poolSize');
    });
    
    test('should clear all pools', () => {
      // Use some objects first
      const share = miningPools.sharePool.acquire();
      const job = miningPools.jobPool.acquire();
      
      miningPools.clearAll();
      
      const stats = miningPools.getAllStats();
      expect(stats.sharePool.poolSize).toBe(0);
      expect(stats.jobPool.poolSize).toBe(0);
    });
  });
  
  describe('Performance Benchmarks', () => {
    
    test('object pool should be faster than new object creation', async () => {
      const iterations = 10000;
      
      // Benchmark object pool
      const poolStartTime = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        const obj = miningPools.sharePool.acquire();
        obj.nonce = i;
        miningPools.sharePool.release(obj);
      }
      const poolEndTime = process.hrtime.bigint();
      const poolTime = Number(poolEndTime - poolStartTime) / 1000000; // Convert to milliseconds
      
      // Benchmark new object creation
      const newStartTime = process.hrtime.bigint();
      for (let i = 0; i < iterations; i++) {
        const obj = { 
          minerId: '', 
          nonce: i, 
          hash: '', 
          difficulty: 0, 
          timestamp: 0,
          valid: false,
          target: ''
        };
        // Simulated usage
        obj.nonce = i;
      }
      const newEndTime = process.hrtime.bigint();
      const newTime = Number(newEndTime - newStartTime) / 1000000; // Convert to milliseconds
      
      console.log(`Object Pool Time: ${poolTime}ms`);
      console.log(`New Object Time: ${newTime}ms`);
      console.log(`Performance Improvement: ${((newTime - poolTime) / newTime * 100).toFixed(2)}%`);
      
      // Object pool should be faster or at least not significantly slower
      expect(poolTime).toBeLessThanOrEqual(newTime * 1.2); // Allow 20% tolerance
    });
    
    test('memory usage should be more stable with object pools', () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Create and destroy many objects using pool
      for (let i = 0; i < 1000; i++) {
        const objects = [];
        for (let j = 0; j < 100; j++) {
          objects.push(miningPools.sharePool.acquire());
        }
        objects.forEach(obj => miningPools.sharePool.release(obj));
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      
      console.log(`Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`);
      
      // Memory increase should be minimal (less than 10MB)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
    });
  });
});

describe('EnhancedErrorRecovery', () => {
  let recovery;
  
  beforeEach(() => {
    recovery = new EnhancedErrorRecovery({
      maxRecoveryAttempts: 2,
      recoveryTimeout: 5000
    });
  });
  
  afterEach(() => {
    recovery.shutdown();
  });
  
  test('should handle network errors with retry strategy', async () => {
    const networkError = new OtedamaError('Connection failed', {
      category: ErrorCategory.NETWORK,
      retryable: true
    });
    
    const result = await recovery.handleError(networkError, 'test-component');
    
    expect(result.recovered).toBe(true);
    expect(result.strategy).toBe('retry_with_backoff');
    
    const stats = recovery.getStats();
    expect(stats.totalErrors).toBe(1);
    expect(stats.recoveredErrors).toBe(1);
  });
  
  test('should activate circuit breaker for database errors', async () => {
    const dbError = new OtedamaError('Database connection lost', {
      category: ErrorCategory.DATABASE,
      retryable: true
    });
    
    const result = await recovery.handleError(dbError, 'database-component');
    
    expect(result.recovered).toBe(true);
    expect(result.strategy).toBe('circuit_breaker');
    
    const stats = recovery.getStats();
    expect(stats.circuitBreakerTrips).toBe(1);
    expect(recovery.isComponentHealthy('database-component')).toBe(false);
  });
  
  test('should fail fast for payment errors', async () => {
    const paymentError = new OtedamaError('Payment processing failed', {
      category: ErrorCategory.PAYMENT,
      retryable: false
    });
    
    const result = await recovery.handleError(paymentError, 'payment-component');
    
    expect(result.recovered).toBe(false);
    expect(result.strategy).toBe('fail_fast');
  });
  
  test('should restart components for system errors', async () => {
    const systemError = new OtedamaError('System component crashed', {
      category: ErrorCategory.SYSTEM,
      retryable: true
    });
    
    const restartEmitted = new Promise(resolve => {
      recovery.on('component:restart', (data) => {
        expect(data.component).toBe('system-component');
        resolve(true);
      });
    });
    
    const result = await recovery.handleError(systemError, 'system-component');
    
    expect(result.recovered).toBe(true);
    expect(result.strategy).toBe('restart_component');
    
    await restartEmitted;
    
    const stats = recovery.getStats();
    expect(stats.componentRestarts).toBe(1);
  });
  
  test('should maintain recovery history', async () => {
    const error1 = new OtedamaError('Error 1', { category: ErrorCategory.NETWORK });
    const error2 = new OtedamaError('Error 2', { category: ErrorCategory.MINING });
    
    await recovery.handleError(error1, 'component-1');
    await recovery.handleError(error2, 'component-2');
    
    const history = recovery.getRecoveryHistory();
    
    expect(history).toHaveLength(2);
    expect(history[0].component).toBe('component-2'); // Most recent first
    expect(history[1].component).toBe('component-1');
  });
  
  test('should provide comprehensive statistics', async () => {
    const error = new OtedamaError('Test error', { category: ErrorCategory.NETWORK });
    
    await recovery.handleError(error, 'test-component');
    
    const stats = recovery.getStats();
    
    expect(stats).toHaveProperty('totalErrors');
    expect(stats).toHaveProperty('recoveredErrors');
    expect(stats).toHaveProperty('failedRecoveries');
    expect(stats).toHaveProperty('componentRestarts');
    expect(stats).toHaveProperty('circuitBreakerTrips');
    expect(stats).toHaveProperty('recoveryRate');
    expect(stats).toHaveProperty('activeRecoveries');
    expect(stats).toHaveProperty('componentStates');
    
    expect(stats.recoveryRate).toBeGreaterThan(0);
  });
  
  test('should handle concurrent recovery attempts', async () => {
    const errors = [
      new OtedamaError('Error 1', { category: ErrorCategory.NETWORK }),
      new OtedamaError('Error 2', { category: ErrorCategory.NETWORK }),
      new OtedamaError('Error 3', { category: ErrorCategory.NETWORK })
    ];
    
    const recoveryPromises = errors.map((error, index) => 
      recovery.handleError(error, `component-${index}`)
    );
    
    const results = await Promise.all(recoveryPromises);
    
    expect(results).toHaveLength(3);
    results.forEach(result => {
      expect(result.recovered).toBe(true);
    });
    
    const stats = recovery.getStats();
    expect(stats.totalErrors).toBe(3);
    expect(stats.recoveredErrors).toBe(3);
  });
});

describe('Integration Tests', () => {
  
  test('should integrate object pools with error recovery', async () => {
    const error = new OtedamaError('Pool exhaustion', { 
      category: ErrorCategory.SYSTEM 
    });
    
    // Use some pooled objects
    const objects = [];
    for (let i = 0; i < 10; i++) {
      objects.push(miningPools.sharePool.acquire());
    }
    
    // Simulate error during pool operation
    const result = await errorRecovery.handleError(error, 'object-pool');
    
    // Cleanup
    objects.forEach(obj => miningPools.sharePool.release(obj));
    
    expect(result.recovered).toBe(true);
    
    const poolStats = miningPools.getAllStats();
    const recoveryStats = errorRecovery.getStats();
    
    expect(poolStats.sharePool.poolSize).toBeGreaterThan(0);
    expect(recoveryStats.totalErrors).toBeGreaterThan(0);
  });