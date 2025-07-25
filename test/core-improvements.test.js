/**
 * Core Improvements Test - Otedama
 * Tests for all implemented improvements
 */

import {
  // Error handling
  OtedamaError,
  MiningError,
  ErrorHandler,
  
  // Memory management
  memoryManager,
  ObjectPool,
  BufferPool,
  
  // Validation
  validator,
  Rules,
  Sanitizers,
  Schema,
  
  // Configuration
  configManager,
  
  // Health checks
  healthCheckManager,
  HealthStatus,
  
  // Profiling
  profiler,
  
  // Async utilities
  retry,
  withTimeout,
  BatchProcessor,
  AsyncQueue,
  
  // Authentication
  JWT,
  PasswordHasher,
  SessionManager,
  
  // Rate limiting
  rateLimiter,
  
  // Logging
  createStructuredLogger,
  
  // Migration
  MigrationManager,
  
  // Backup
  BackupManager
} from '../lib/core/index.js';

const logger = createStructuredLogger('CoreTest');

// Test suite
export async function runCoreTests() {
  logger.info('Starting core improvements tests...');
  
  const results = {
    passed: 0,
    failed: 0,
    tests: []
  };
  
  // Test error handling
  await test('Error Handling', async () => {
    const error = new MiningError('Test error', 'TEST_ERROR');
    
    assert(error instanceof OtedamaError, 'Error inheritance');
    assert(error.code === 'TEST_ERROR', 'Error code');
    assert(error.statusCode === 400, 'Status code');
    
    const handled = ErrorHandler.handle(error);
    assert(handled.error.code === 'TEST_ERROR', 'Error handler');
    
    assert(ErrorHandler.isRetryable(error) === false, 'Not retryable');
  }, results);
  
  // Test memory management
  await test('Memory Management', async () => {
    // Object pool
    const pool = new ObjectPool(
      () => ({ value: 0 }),
      (obj) => { obj.value = 0; },
      10
    );
    
    const obj1 = pool.acquire();
    obj1.value = 42;
    pool.release(obj1);
    
    const obj2 = pool.acquire();
    assert(obj2.value === 0, 'Object reset');
    assert(pool.getStats().hits === 1, 'Pool hit');
    
    // Buffer pool
    const buffer = memoryManager.getBuffer(1024);
    assert(buffer.length === 4096, 'Buffer size');
    memoryManager.releaseBuffer(buffer);
    
    const stats = memoryManager.getStats();
    assert(stats.pools.buffer, 'Buffer pool stats');
  }, results);
  
  // Test validation
  await test('Input Validation', async () => {
    // Rules
    assert(Rules.isEmail('test@example.com'), 'Email validation');
    assert(!Rules.isEmail('invalid'), 'Invalid email');
    
    assert(Rules.isBitcoinAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), 'Bitcoin address');
    assert(Rules.isHex('deadbeef'), 'Hex validation');
    
    // Sanitizers
    assert(Sanitizers.trim('  test  ') === 'test', 'Trim');
    assert(Sanitizers.escape('<script>') === '&lt;script&gt;', 'Escape HTML');
    
    // Schema
    const schema = new Schema({
      email: {
        type: 'string',
        required: true,
        validate: [Rules.isEmail],
        sanitize: [Sanitizers.trim, Sanitizers.toLowerCase]
      }
    });
    
    const validated = schema.validate({ email: '  TEST@EXAMPLE.COM  ' });
    assert(validated.email === 'test@example.com', 'Schema validation');
    
    try {
      schema.validate({ email: 'invalid' });
      assert(false, 'Should throw');
    } catch (error) {
      assert(error.message === 'Validation failed', 'Validation error');
    }
  }, results);
  
  // Test async utilities
  await test('Async Utilities', async () => {
    // Retry
    let attempts = 0;
    const result = await retry(async () => {
      attempts++;
      if (attempts < 3) throw new Error('Retry test');
      return 'success';
    }, { maxAttempts: 5 });
    
    assert(result === 'success', 'Retry success');
    assert(attempts === 3, 'Retry attempts');
    
    // Timeout
    try {
      await withTimeout(
        new Promise(resolve => setTimeout(resolve, 1000)),
        100,
        'Test timeout'
      );
      assert(false, 'Should timeout');
    } catch (error) {
      assert(error.message === 'Test timeout', 'Timeout error');
    }
    
    // Batch processor
    const processed = [];
    const processor = new BatchProcessor(
      async (items) => processed.push(...items),
      { batchSize: 2, flushInterval: 100 }
    );
    
    processor.add(1);
    processor.add(2);
    processor.add(3);
    
    await new Promise(resolve => setTimeout(resolve, 150));
    assert(processed.length === 3, 'Batch processing');
    
    await processor.stop();
  }, results);
  
  // Test authentication
  await test('Authentication', async () => {
    // JWT
    const jwt = new JWT('secret-key');
    const token = jwt.sign({ userId: 123 });
    const payload = jwt.verify(token);
    
    assert(payload.userId === 123, 'JWT payload');
    assert(payload.iss === 'otedama', 'JWT issuer');
    
    // Password hashing
    const hasher = new PasswordHasher();
    const hash = await hasher.hash('password123');
    const valid = await hasher.verify('password123', hash);
    
    assert(valid, 'Password verification');
    assert(!await hasher.verify('wrong', hash), 'Wrong password');
    
    // Session manager
    const sessions = new SessionManager();
    const sessionId = await sessions.create('user123', { role: 'admin' });
    const session = await sessions.get(sessionId);
    
    assert(session.userId === 'user123', 'Session user');
    assert(session.data.role === 'admin', 'Session data');
    
    await sessions.destroy(sessionId);
    assert(await sessions.get(sessionId) === null, 'Session destroyed');
  }, results);
  
  // Test rate limiting
  await test('Rate Limiting', async () => {
    const limiter = rateLimiter;
    
    // Reset
    limiter.reset('test-key');
    
    // Allow initial requests
    const result1 = await limiter.check('test-key');
    assert(result1.allowed, 'First request allowed');
    
    // Exhaust limit
    for (let i = 0; i < 20; i++) {
      try {
        await limiter.check('test-key');
      } catch {}
    }
    
    // Should be rate limited
    try {
      await limiter.check('test-key');
      assert(false, 'Should be rate limited');
    } catch (error) {
      assert(error.code === 'RATE_LIMIT_EXCEEDED', 'Rate limit error');
    }
    
    // Cleanup
    limiter.reset('test-key');
  }, results);
  
  // Test health checks
  await test('Health Checks', async () => {
    // Register check
    healthCheckManager.register('test-check', async () => {
      return { healthy: true, message: 'Test OK' };
    });
    
    // Run check
    const health = await healthCheckManager.getHealth();
    assert(health.status === HealthStatus.HEALTHY || health.status === HealthStatus.UNKNOWN, 'Health status');
    
    // Unregister
    healthCheckManager.unregister('test-check');
  }, results);
  
  // Test profiling
  await test('Performance Profiling', async () => {
    // Timer
    const timer = profiler.createTimer('test-operation');
    await new Promise(resolve => setTimeout(resolve, 10));
    const duration = timer.end();
    
    assert(duration >= 10, 'Timer duration');
    
    // Metrics
    profiler.recordMetric('test-metric', 100);
    profiler.recordMetric('test-metric', 200);
    profiler.recordMetric('test-metric', 300);
    
    const stats = profiler.getStats();
    assert(stats.metrics['test-metric'], 'Metric exists');
    assert(stats.metrics['test-metric'].mean === 200, 'Metric average');
    
    // Reset
    profiler.reset();
  }, results);
  
  // Summary
  logger.info('Test Results:', {
    passed: results.passed,
    failed: results.failed,
    total: results.tests.length
  });
  
  return results;
}

// Test helper
async function test(name, fn, results) {
  try {
    await fn();
    results.passed++;
    results.tests.push({ name, status: 'passed' });
    logger.info(`✓ ${name}`);
  } catch (error) {
    results.failed++;
    results.tests.push({ name, status: 'failed', error: error.message });
    logger.error(`✗ ${name}: ${error.message}`);
  }
}

// Assert helper
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runCoreTests()
    .then(results => {
      process.exit(results.failed > 0 ? 1 : 0);
    })
    .catch(error => {
      logger.error('Test execution failed:', error);
      process.exit(1);
    });
}

export default runCoreTests;
