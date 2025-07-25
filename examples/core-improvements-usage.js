/**
 * Core Improvements Usage Examples - Otedama
 * Examples of how to use all implemented improvements
 */

import {
  // Core utilities
  createStructuredLogger,
  memoryManager,
  validator,
  configManager,
  healthCheckManager,
  profiler,
  rateLimiter,
  
  // Error handling
  MiningError,
  ErrorHandler,
  
  // Async utilities
  retry,
  withTimeout,
  BatchProcessor,
  AsyncQueue,
  
  // Authentication
  JWT,
  PasswordHasher,
  SessionManager,
  APIKeyManager,
  AuthMiddleware,
  
  // Database
  MigrationManager,
  BackupManager,
  
  // Types
  Schema,
  Rules,
  Sanitizers
} from '../lib/core/index.js';

// Setup logger
const logger = createStructuredLogger('Examples');

/**
 * Example 1: Error Handling
 */
export async function errorHandlingExample() {
  logger.info('=== Error Handling Example ===');
  
  try {
    // Simulate an error
    throw new MiningError('Invalid share difficulty');
  } catch (error) {
    // Handle error with context
    const errorResponse = ErrorHandler.handle(error, logger);
    logger.error('Handled error:', errorResponse);
    
    // Check if retryable
    if (ErrorHandler.isRetryable(error)) {
      const delay = ErrorHandler.getRetryDelay(error, 1);
      logger.info(`Retrying after ${delay}ms`);
    }
  }
}

/**
 * Example 2: Memory Management
 */
export async function memoryManagementExample() {
  logger.info('=== Memory Management Example ===');
  
  // Create custom object pool
  const sharePool = memoryManager.createPool('shares',
    () => ({
      jobId: null,
      nonce: null,
      difficulty: 0,
      timestamp: 0
    }),
    (share) => {
      share.jobId = null;
      share.nonce = null;
      share.difficulty = 0;
      share.timestamp = 0;
    },
    1000
  );
  
  // Use pooled objects
  const share = sharePool.acquire();
  share.jobId = 'job123';
  share.difficulty = 16;
  
  // Always release back to pool
  sharePool.release(share);
  
  // Use buffer pool
  const buffer = memoryManager.getBuffer(4096);
  // Use buffer...
  memoryManager.releaseBuffer(buffer);
  
  // Get memory stats
  const stats = memoryManager.getStats();
  logger.info('Memory stats:', stats);
}

/**
 * Example 3: Input Validation
 */
export async function validationExample() {
  logger.info('=== Validation Example ===');
  
  // Define schema
  const userSchema = new Schema({
    email: {
      type: 'string',
      required: true,
      validate: [Rules.isEmail],
      sanitize: [Sanitizers.trim, Sanitizers.toLowerCase]
    },
    password: {
      type: 'string',
      required: true,
      validate: [
        (v) => v.length >= 8 || 'Password must be at least 8 characters'
      ]
    },
    age: {
      type: 'number',
      required: false,
      default: 18,
      validate: [
        (v) => v >= 18 || 'Must be 18 or older'
      ],
      sanitize: Sanitizers.toInt
    }
  });
  
  // Validate input
  try {
    const validated = userSchema.validate({
      email: '  USER@EXAMPLE.COM  ',
      password: 'securepass123',
      age: '25'
    });
    
    logger.info('Validated:', validated);
    // Output: { email: 'user@example.com', password: 'securepass123', age: 25 }
  } catch (error) {
    logger.error('Validation failed:', error.message);
  }
}

/**
 * Example 4: Async Utilities
 */
export async function asyncUtilitiesExample() {
  logger.info('=== Async Utilities Example ===');
  
  // Retry with exponential backoff
  const result = await retry(
    async (attempt) => {
      logger.info(`Attempt ${attempt}`);
      if (attempt < 3) {
        throw new Error('Temporary failure');
      }
      return 'Success!';
    },
    {
      maxAttempts: 5,
      initialDelay: 100,
      onRetry: (error, attempt, delay) => {
        logger.warn(`Retry ${attempt} after ${delay}ms: ${error.message}`);
      }
    }
  );
  
  logger.info('Retry result:', result);
  
  // Timeout wrapper
  try {
    const data = await withTimeout(
      fetch('https://api.example.com/data'),
      5000,
      'API request timed out'
    );
    logger.info('Data received');
  } catch (error) {
    logger.error('Timeout:', error.message);
  }
  
  // Batch processor
  const processor = new BatchProcessor(
    async (items) => {
      logger.info(`Processing batch of ${items.length} items`);
      // Process items...
    },
    {
      batchSize: 100,
      flushInterval: 1000
    }
  );
  
  // Add items
  for (let i = 0; i < 250; i++) {
    processor.add({ id: i, data: `Item ${i}` });
  }
  
  await processor.stop();
  
  // Async queue with concurrency
  const queue = new AsyncQueue(
    async (task) => {
      logger.info(`Processing task: ${task.id}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      return task.id * 2;
    },
    3 // Concurrency limit
  );
  
  // Queue tasks
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(queue.push({ id: i }));
  }
  
  const results = await Promise.all(promises);
  logger.info('Queue results:', results);
}

/**
 * Example 5: Authentication
 */
export async function authenticationExample() {
  logger.info('=== Authentication Example ===');
  
  // JWT
  const jwt = new JWT('your-secret-key', {
    expiresIn: '24h',
    issuer: 'otedama-pool'
  });
  
  // Create token
  const token = jwt.sign({
    userId: 'user123',
    role: 'miner',
    permissions: ['submit_shares', 'view_stats']
  });
  
  logger.info('JWT Token:', token);
  
  // Verify token
  try {
    const payload = jwt.verify(token);
    logger.info('Verified payload:', payload);
  } catch (error) {
    logger.error('JWT verification failed:', error.message);
  }
  
  // Password hashing
  const hasher = new PasswordHasher();
  const password = 'MySecurePassword123!';
  
  const hash = await hasher.hash(password);
  logger.info('Password hash:', hash);
  
  const isValid = await hasher.verify(password, hash);
  logger.info('Password valid:', isValid);
  
  // Session management
  const sessionManager = new SessionManager();
  
  const sessionId = await sessionManager.create('user123', {
    ip: '192.168.1.1',
    userAgent: 'Otedama-Miner/1.0'
  });
  
  logger.info('Session created:', sessionId);
  
  const session = await sessionManager.get(sessionId);
  logger.info('Session data:', session);
  
  // API key management
  const apiKeyManager = new APIKeyManager();
  
  const { key, id } = await apiKeyManager.generate('user123', 
    ['read', 'write'],
    { app: 'mobile' }
  );
  
  logger.info('API Key generated:', { key, id });
  
  // Verify API key
  const keyData = await apiKeyManager.verify(key);
  logger.info('API Key verified:', keyData);
}

/**
 * Example 6: Rate Limiting
 */
export async function rateLimitingExample() {
  logger.info('=== Rate Limiting Example ===');
  
  // Configure rate limiter
  const limiter = rateLimiter;
  
  // Simulate requests
  const clientIp = '192.168.1.100';
  
  for (let i = 0; i < 15; i++) {
    try {
      const result = await limiter.check(clientIp);
      logger.info(`Request ${i + 1}: Allowed, remaining: ${result.remaining}`);
    } catch (error) {
      logger.warn(`Request ${i + 1}: ${error.message}`);
    }
    
    // Small delay
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Reset for next example
  limiter.reset(clientIp);
}

/**
 * Example 7: Health Checks
 */
export async function healthCheckExample() {
  logger.info('=== Health Check Example ===');
  
  // Register health checks
  healthCheckManager.register('database', async () => {
    // Check database connection
    return {
      healthy: true,
      message: 'Database connection OK',
      details: {
        connections: 5,
        latency: 2
      }
    };
  }, {
    critical: true,
    timeout: 5000
  });
  
  healthCheckManager.register('cache', async () => {
    // Check cache
    return {
      healthy: true,
      message: 'Cache operational'
    };
  });
  
  healthCheckManager.register('external-api', async () => {
    // Check external service
    try {
      // await fetch('https://api.example.com/health');
      return { healthy: true };
    } catch {
      return {
        healthy: false,
        message: 'External API unreachable'
      };
    }
  }, {
    critical: false
  });
  
  // Get health status
  const health = await healthCheckManager.getHealth();
  logger.info('Health status:', health);
  
  // Detailed health report
  const detailed = await healthCheckManager.getDetailedHealth();
  logger.info('Detailed health:', detailed);
}

/**
 * Example 8: Performance Profiling
 */
export async function profilingExample() {
  logger.info('=== Performance Profiling Example ===');
  
  // Function profiling
  const processShare = profiler.profile('processShare', 
    async (share) => {
      // Simulate processing
      await new Promise(resolve => setTimeout(resolve, Math.random() * 50));
      return share.difficulty >= 16;
    }
  );
  
  // Call profiled function
  for (let i = 0; i < 10; i++) {
    await processShare({ difficulty: Math.random() * 32 });
  }
  
  // Manual timing
  const timer = profiler.createTimer('custom-operation');
  
  // Do some work
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const duration = timer.end();
  logger.info(`Operation took ${duration}ms`);
  
  // Record custom metrics
  for (let i = 0; i < 100; i++) {
    profiler.recordMetric('shares-per-second', Math.random() * 1000);
  }
  
  // Get statistics
  const stats = profiler.getStats();
  logger.info('Profiler stats:', JSON.stringify(stats, null, 2));
}

/**
 * Example 9: Database Migration
 */
export async function migrationExample(db) {
  logger.info('=== Database Migration Example ===');
  
  const migrationManager = new MigrationManager(db, {
    migrationsDir: './migrations'
  });
  
  // Initialize
  await migrationManager.initialize();
  
  // Create a new migration
  const { filepath } = await migrationManager.createMigration('add_user_stats');
  logger.info('Created migration:', filepath);
  
  // Get status
  const status = await migrationManager.getStatus();
  logger.info('Migration status:', status);
  
  // Run migrations
  const { executed } = await migrationManager.migrate();
  logger.info(`Executed ${executed} migrations`);
  
  // Rollback if needed
  // const { rolledback } = await migrationManager.rollback(1);
  // logger.info(`Rolled back ${rolledback} migrations`);
}

/**
 * Example 10: Backup & Restore
 */
export async function backupExample(db) {
  logger.info('=== Backup & Restore Example ===');
  
  const backupManager = new BackupManager({
    backupDir: './backups',
    compress: true,
    maxBackups: 5
  });
  
  // Initialize
  await backupManager.initialize();
  
  // Create backup
  const backup = await backupManager.createBackup({
    database: db,
    files: [
      './config/otedama.config.js',
      { path: './logs/app.log', name: 'app.log' }
    ]
  }, {
    metadata: {
      version: '1.0.0',
      environment: 'production'
    }
  });
  
  logger.info('Backup created:', backup);
  
  // List backups
  const backups = await backupManager.listBackups();
  logger.info('Available backups:', backups);
  
  // Restore backup (example - be careful!)
  // await backupManager.restoreBackup(backup.id, {
  //   database: db,
  //   databasePath: './data/otedama.db',
  //   targetDir: './restored-files'
  // });
}

/**
 * Example 11: Express Middleware Integration
 */
export function expressMiddlewareExample(app) {
  logger.info('=== Express Middleware Example ===');
  
  // Authentication middleware
  const auth = new AuthMiddleware({
    jwt: new JWT('secret'),
    sessionManager: new SessionManager(),
    apiKeyManager: new APIKeyManager()
  });
  
  // Rate limiting middleware
  app.use(rateLimiter.middleware());
  
  // Health check endpoint
  app.use(healthCheckManager.middleware({
    path: '/health',
    type: 'liveness'
  }));
  
  // Profiling middleware
  app.use(profiler.middleware({
    includePath: true
  }));
  
  // Protected routes
  app.get('/api/stats', 
    auth.jwt({ required: true }),
    async (req, res) => {
      res.json({
        user: req.user,
        stats: await getStats()
      });
    }
  );
  
  // API key protected
  app.post('/api/shares',
    auth.apiKey(),
    auth.requirePermission('submit_shares'),
    async (req, res) => {
      // Process share submission
      res.json({ accepted: true });
    }
  );
}

/**
 * Run all examples
 */
export async function runAllExamples() {
  logger.info('Running all core improvement examples...\n');
  
  await errorHandlingExample();
  await memoryManagementExample();
  await validationExample();
  await asyncUtilitiesExample();
  await authenticationExample();
  await rateLimitingExample();
  await healthCheckExample();
  await profilingExample();
  
  logger.info('\nAll examples completed!');
}

// Helper function
async function getStats() {
  return {
    miners: 150,
    hashrate: '1.5 TH/s',
    shares: 50000
  };
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples().catch(console.error);
}

export default {
  errorHandlingExample,
  memoryManagementExample,
  validationExample,
  asyncUtilitiesExample,
  authenticationExample,
  rateLimitingExample,
  healthCheckExample,
  profilingExample,
  migrationExample,
  backupExample,
  expressMiddlewareExample,
  runAllExamples
};
