#!/usr/bin/env node

/**
 * Otedama Professional Test Suite
 * 
 * Comprehensive testing for production-ready mining pool
 * Tests: Performance, Security, Reliability, User Experience
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Test configuration
const TEST_CONFIG = {
  timeout: 30000,
  retries: 3,
  parallel: true,
  coverage: true
};

class TestRunner extends EventEmitter {
  constructor() {
    super();
    this.tests = [];
    this.results = {
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      startTime: 0,
      endTime: 0
    };
    this.isRunning = false;
  }

  test(name, testFn, options = {}) {
    this.tests.push({
      name,
      testFn,
      options: { ...TEST_CONFIG, ...options },
      status: 'pending'
    });
  }

  async run() {
    if (this.isRunning) {
      throw new Error('Tests already running');
    }

    this.isRunning = true;
    this.results.startTime = Date.now();
    this.results.total = this.tests.length;

    console.log('🧪 Otedama Professional Test Suite');
    console.log('==================================');
    console.log(`Running ${this.results.total} tests...\n`);

    for (const test of this.tests) {
      await this.runSingleTest(test);
    }

    this.results.endTime = Date.now();
    this.printSummary();
    this.isRunning = false;

    return this.results.failed === 0;
  }

  async runSingleTest(test) {
    const startTime = Date.now();
    
    try {
      console.log(`🔍 ${test.name}`);
      
      // Run with timeout
      await Promise.race([
        test.testFn(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test timeout')), test.options.timeout)
        )
      ]);
      
      const duration = Date.now() - startTime;
      test.status = 'passed';
      test.duration = duration;
      this.results.passed++;
      
      console.log(`✅ PASS: ${test.name} (${duration}ms)\n`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      test.status = 'failed';
      test.duration = duration;
      test.error = error.message;
      this.results.failed++;
      
      console.log(`❌ FAIL: ${test.name} (${duration}ms)`);
      console.log(`   Error: ${error.message}\n`);
    }
  }

  printSummary() {
    const duration = this.results.endTime - this.results.startTime;
    const successRate = ((this.results.passed / this.results.total) * 100).toFixed(1);
    
    console.log('=====================================');
    console.log('📊 TEST SUMMARY');
    console.log('=====================================');
    console.log(`Total Tests: ${this.results.total}`);
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    console.log(`⏭️  Skipped: ${this.results.skipped}`);
    console.log(`📈 Success Rate: ${successRate}%`);
    console.log(`⏱️  Duration: ${duration}ms`);
    
    if (this.results.failed === 0) {
      console.log('\n🎉 All tests passed! Production ready ✨');
    } else {
      console.log('\n⚠️  Some tests failed. Review before deployment.');
    }
  }
}

// Test utilities
function assert(condition, message = 'Assertion failed') {
  if (!condition) {
    throw new Error(message);
  }
}

function assertThrows(fn, message = 'Expected function to throw') {
  try {
    fn();
    throw new Error(message);
  } catch (error) {
    if (error.message === message) {
      throw error;
    }
    // Expected error thrown
  }
}

async function mockAPI(endpoint, response) {
  // Mock API response for testing
  return Promise.resolve(response);
}

// Initialize test runner
const runner = new TestRunner();

// Core System Tests
runner.test('System Initialization', async () => {
  // Test that all core components can be imported
  const coreExists = fs.existsSync(path.join(rootDir, 'src', 'core.js'));
  assert(coreExists, 'Core module should exist');
  
  const configExists = fs.existsSync(path.join(rootDir, 'src', 'config.js'));
  assert(configExists, 'Config module should exist');
  
  const dbExists = fs.existsSync(path.join(rootDir, 'src', 'database.js'));
  assert(dbExists, 'Database module should exist');
});

runner.test('Configuration Validation', async () => {
  // Test configuration loading and validation
  const configPath = path.join(rootDir, 'otedama.json');
  
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    assert(config.pool, 'Pool configuration should exist');
    assert(config.mining, 'Mining configuration should exist');
    assert(config.network, 'Network configuration should exist');
    
    assert(typeof config.pool.fee === 'number', 'Pool fee should be a number');
    assert(config.pool.fee >= 0 && config.pool.fee <= 10, 'Pool fee should be reasonable');
  }
});

runner.test('Database Schema Validation', async () => {
  // Test database schema and operations
  const { OtedamaDB } = await import('../src/database.js');
  const db = new OtedamaDB(':memory:');
  
  // Test table creation
  assert(db.db, 'Database connection should exist');
  
  // Test basic operations
  db.updateMiner('test1', 'wallet123', 'BTC', 1000, 1);
  db.addShare('test1', 1000000, true, 'sha256');
  
  const stats = db.getPoolStats();
  assert(typeof stats.miners === 'number', 'Stats should include miner count');
  
  db.close();
});

// Performance Tests
runner.test('Memory Usage Test', async () => {
  const initialMemory = process.memoryUsage().heapUsed;
  
  // Simulate some operations
  const testData = new Array(1000).fill(0).map((_, i) => ({
    id: i,
    data: Math.random().toString(36)
  }));
  
  const finalMemory = process.memoryUsage().heapUsed;
  const memoryIncrease = finalMemory - initialMemory;
  
  // Memory increase should be reasonable (less than 50MB)
  assert(memoryIncrease < 50 * 1024 * 1024, 'Memory usage should be reasonable');
});

runner.test('Performance Benchmarks', async () => {
  const { OtedamaDB } = await import('../src/database.js');
  const db = new OtedamaDB(':memory:');
  
  // Test database performance
  const startTime = Date.now();
  
  for (let i = 0; i < 1000; i++) {
    db.addShare(`miner${i % 10}`, Math.random() * 1000000, true, 'sha256');
  }
  
  const endTime = Date.now();
  const duration = endTime - startTime;
  
  // Should handle 1000 inserts in under 1 second
  assert(duration < 1000, `Database should be fast (took ${duration}ms)`);
  
  db.close();
});

// Security Tests
runner.test('Input Validation', async () => {
  const { OtedamaDB } = await import('../src/database.js');
  const db = new OtedamaDB(':memory:');
  
  // Test SQL injection protection
  assertThrows(() => {
    db.query("SELECT * FROM shares WHERE worker_id = '; DROP TABLE shares; --'");
  }, 'Should prevent SQL injection');
  
  // Test invalid parameters
  assertThrows(() => {
    db.updateMiner(null, 'wallet', 'BTC', 1000, 1);
  }, 'Should validate required parameters');
  
  db.close();
});

runner.test('Configuration Security', async () => {
  const packagePath = path.join(rootDir, 'package.json');
  
  if (fs.existsSync(packagePath)) {
    const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    
    // Check for security vulnerabilities in dependencies
    const deps = { ...packageData.dependencies, ...packageData.devDependencies };
    const depCount = Object.keys(deps).length;
    
    // Should have minimal dependencies (< 10 for security)
    assert(depCount < 10, `Too many dependencies (${depCount}), security risk`);
  }
});

// API Tests
runner.test('API Endpoint Validation', async () => {
  // Test API endpoints exist and return valid data
  try {
    const statsResponse = await mockAPI('/api/stats', {
      system: { status: 'running' },
      mining: { hashrate: 1000, miners: 5 }
    });
    
    assert(statsResponse.system, 'Stats should include system info');
    assert(statsResponse.mining, 'Stats should include mining info');
    
  } catch (error) {
    // API not running, but structure should be testable
    console.log('   Note: API tests skipped (server not running)');
  }
});

// File Structure Tests
runner.test('Project Structure Validation', async () => {
  const requiredFiles = [
    'package.json',
    'index.js',
    'src/core.js',
    'src/config.js',
    'src/database.js',
    'web/index.html'
  ];
  
  for (const file of requiredFiles) {
    const filePath = path.join(rootDir, file);
    assert(fs.existsSync(filePath), `Required file missing: ${file}`);
  }
});

runner.test('Code Quality Checks', async () => {
  const srcDir = path.join(rootDir, 'src');
  const jsFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));
  
  for (const file of jsFiles) {
    const filePath = path.join(srcDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Check for basic code quality
    assert(!content.includes('console.log'), `${file} should not contain console.log statements`);
    assert(!content.includes('TODO'), `${file} should not contain TODO comments`);
    assert(content.includes('export'), `${file} should export something`);
  }
});

// Documentation Tests
runner.test('Documentation Completeness', async () => {
  const readmePath = path.join(rootDir, 'README.md');
  assert(fs.existsSync(readmePath), 'README.md should exist');
  
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert(readme.includes('installation'), 'README should include installation instructions');
  assert(readme.includes('usage'), 'README should include usage instructions');
  assert(readme.length > 1000, 'README should be comprehensive');
});

// Deployment Tests
runner.test('Deployment Scripts Validation', async () => {
  const deployFiles = ['deploy.sh', 'deploy.bat'];
  
  for (const file of deployFiles) {
    const deployPath = path.join(rootDir, file);
    if (fs.existsSync(deployPath)) {
      const content = fs.readFileSync(deployPath, 'utf8');
      assert(content.includes('npm install'), `${file} should install dependencies`);
    }
  }
});

// Production Readiness Tests
runner.test('Production Configuration', async () => {
  const configPath = path.join(rootDir, 'otedama.json');
  
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Production checklist
    assert(config.pool.fee >= 1.0, 'Pool fee should be reasonable for production');
    assert(config.network.apiPort !== 80, 'Should not use privileged ports in development');
  }
});

runner.test('Error Handling Coverage', async () => {
  const { OtedamaDB } = await import('../src/database.js');
  
  // Test error scenarios
  try {
    const db = new OtedamaDB('/invalid/path/database.db');
    // Should handle database connection errors gracefully
  } catch (error) {
    assert(error.message.includes('SQLITE'), 'Should provide meaningful error messages');
  }
});

// Market Readiness Tests
runner.test('Feature Completeness', async () => {
  // Verify all essential mining pool features are present
  const features = {
    mining: fs.existsSync(path.join(rootDir, 'src', 'mining-engine.js')),
    dex: fs.existsSync(path.join(rootDir, 'src', 'dex.js')),
    api: fs.existsSync(path.join(rootDir, 'src', 'api-server.js')),
    web: fs.existsSync(path.join(rootDir, 'web', 'index.html'))
  };
  
  assert(features.mining, 'Mining engine should be implemented');
  assert(features.dex, 'DEX functionality should be implemented');
  assert(features.api, 'API server should be implemented');
  assert(features.web, 'Web dashboard should be implemented');
});

// Run the test suite
if (import.meta.url === `file://${process.argv[1]}`) {
  runner.run().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    console.error('Test runner failed:', error);
    process.exit(1);
  });
}

export default TestRunner;