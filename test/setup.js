/**
 * Test Setup and Configuration
 * Sets up global test environment and utilities
 */

import { before, after } from 'mocha';
import { promises as fs } from 'fs';
import { join } from 'path';

// Global test configuration
global.TEST_CONFIG = {
  timeout: 5000,
  slowThreshold: 75,
  retries: 0
};

// Test utilities
global.testUtils = {
  /**
   * Wait for a specified amount of time
   */
  wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

  /**
   * Create a test database in memory
   */
  createTestDB: async () => {
    // This would create an in-memory SQLite database for testing
    // Implementation would depend on your database setup
    return null;
  },

  /**
   * Clean up test data
   */
  cleanup: async () => {
    // Cleanup any test files, connections, etc.
    try {
      // Remove any test files created
      const testDir = join(process.cwd(), 'test', 'tmp');
      try {
        await fs.rmdir(testDir, { recursive: true });
      } catch (error) {
        // Directory might not exist, ignore
      }
    } catch (error) {
      console.warn('Cleanup warning:', error.message);
    }
  },

  /**
   * Generate test data
   */
  generateTestData: {
    /**
     * Generate a random string
     */
    randomString: (length = 10) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    },

    /**
     * Generate a random number in range
     */
    randomNumber: (min = 0, max = 100) => {
      return Math.random() * (max - min) + min;
    },

    /**
     * Generate a random integer in range
     */
    randomInt: (min = 0, max = 100) => {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },

    /**
     * Generate a test user object
     */
    user: () => ({
      id: testUtils.generateTestData.randomString(8),
      username: `testuser_${testUtils.generateTestData.randomString(6)}`,
      email: `test_${testUtils.generateTestData.randomString(6)}@example.com`,
      password: 'TestPassword123!',
      role: 'user',
      createdAt: new Date().toISOString()
    }),

    /**
     * Generate a test order object
     */
    order: () => ({
      id: `order_${testUtils.generateTestData.randomString(8)}`,
      userId: `user_${testUtils.generateTestData.randomString(6)}`,
      symbol: 'BTC/USDT',
      side: Math.random() > 0.5 ? 'buy' : 'sell',
      type: 'limit',
      price: testUtils.generateTestData.randomNumber(45000, 55000),
      quantity: testUtils.generateTestData.randomNumber(0.1, 2.0),
      remainingQuantity: testUtils.generateTestData.randomNumber(0.1, 2.0),
      status: 'open',
      timestamp: Date.now()
    })
  },

  /**
   * Performance measurement utilities
   */
  performance: {
    /**
     * Measure execution time of a function
     */
    measure: async (name, fn) => {
      const start = process.hrtime.bigint();
      const result = await fn();
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1000000; // Convert to milliseconds
      
      console.log(`⏱️  ${name}: ${duration.toFixed(2)}ms`);
      return { result, duration };
    },

    /**
     * Benchmark a function multiple times
     */
    benchmark: async (name, fn, iterations = 100) => {
      const times = [];
      
      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        await fn();
        const end = process.hrtime.bigint();
        times.push(Number(end - start) / 1000000);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const min = Math.min(...times);
      const max = Math.max(...times);
      
      console.log(`📊 ${name} (${iterations} iterations):`);
      console.log(`   Average: ${avg.toFixed(2)}ms`);
      console.log(`   Min: ${min.toFixed(2)}ms`);
      console.log(`   Max: ${max.toFixed(2)}ms`);
      
      return { avg, min, max, times };
    }
  }
};

// Global test hooks
before(async function() {
  // Set longer timeout for setup
  this.timeout(10000);
  
  console.log('🔧 Setting up test environment...');
  
  // Create test directories
  const testTmpDir = join(process.cwd(), 'test', 'tmp');
  try {
    await fs.mkdir(testTmpDir, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }

  // Set up test database if needed
  global.testDB = await testUtils.createTestDB();
  
  // Set test environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests
  
  console.log('✅ Test environment ready');
});

after(async function() {
  console.log('🧹 Cleaning up test environment...');
  
  // Clean up test data
  await testUtils.cleanup();
  
  // Close database connections
  if (global.testDB) {
    await global.testDB.close();
  }
  
  console.log('✅ Test cleanup complete');
});

// Unhandled promise rejection handler for tests
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection in tests:', reason);
  // Don't exit in test environment, just log
});

// Unhandled exception handler for tests
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception in tests:', error);
  // Don't exit in test environment, just log
});

export default global.testUtils;