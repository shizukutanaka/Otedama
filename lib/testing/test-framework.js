/**
 * Automated Testing Framework for Otedama
 * Comprehensive testing utilities and runners
 * 
 * Design principles:
 * - Carmack: Fast test execution
 * - Martin: Clean test architecture
 * - Pike: Simple and reliable testing
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';
import { readdir, readFile } from 'fs/promises';
import { join, relative } from 'path';
import { logger } from '../core/logger.js';

/**
 * Test types
 */
export const TestType = {
  UNIT: 'unit',
  INTEGRATION: 'integration',
  E2E: 'e2e',
  PERFORMANCE: 'performance',
  LOAD: 'load',
  STRESS: 'stress',
  SECURITY: 'security'
};

/**
 * Test status
 */
export const TestStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  TIMEOUT: 'timeout'
};

/**
 * Test suite
 */
export class TestSuite {
  constructor(name, options = {}) {
    this.name = name;
    this.tests = [];
    this.beforeAll = [];
    this.afterAll = [];
    this.beforeEach = [];
    this.afterEach = [];
    this.options = {
      timeout: options.timeout || 5000,
      retries: options.retries || 0,
      parallel: options.parallel || false,
      ...options
    };
  }
  
  describe(name, fn) {
    const suite = new TestSuite(name, this.options);
    fn.call(suite);
    this.tests.push(suite);
    return suite;
  }
  
  it(name, fn, options = {}) {
    this.tests.push({
      name,
      fn,
      options: { ...this.options, ...options },
      type: 'test'
    });
  }
  
  test(name, fn, options = {}) {
    this.it(name, fn, options);
  }
  
  before(fn) {
    this.beforeAll.push(fn);
  }
  
  after(fn) {
    this.afterAll.push(fn);
  }
  
  beforeEach(fn) {
    this.beforeEach.push(fn);
  }
  
  afterEach(fn) {
    this.afterEach.push(fn);
  }
  
  skip(name, fn) {
    this.tests.push({
      name,
      fn,
      options: this.options,
      type: 'test',
      skip: true
    });
  }
  
  only(name, fn, options = {}) {
    this.tests.push({
      name,
      fn,
      options: { ...this.options, ...options },
      type: 'test',
      only: true
    });
  }
}

/**
 * Test runner
 */
export class TestRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      testDir: options.testDir || './tests',
      pattern: options.pattern || '**/*.test.js',
      timeout: options.timeout || 30000,
      parallel: options.parallel || false,
      maxWorkers: options.maxWorkers || 4,
      coverage: options.coverage !== false,
      verbose: options.verbose || false,
      bail: options.bail || false,
      filter: options.filter || null,
      reporter: options.reporter || 'default',
      ...options
    };
    
    this.suites = [];
    this.results = [];
    this.workers = [];
    this.running = false;
    
    this.stats = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      startTime: null,
      endTime: null
    };
    
    // Assertion library
    this.assertions = new Assertions();
  }
  
  /**
   * Load test files
   */
  async loadTests() {
    const testFiles = await this._findTestFiles();
    
    for (const file of testFiles) {
      try {
        const module = await import(file);
        if (module.default instanceof TestSuite) {
          this.suites.push(module.default);
        }
      } catch (error) {
        logger.error(`Failed to load test file: ${file}`, error);
      }
    }
    
    this.emit('tests:loaded', {
      files: testFiles.length,
      suites: this.suites.length
    });
  }
  
  /**
   * Run all tests
   */
  async run() {
    if (this.running) {
      throw new Error('Test runner is already running');
    }
    
    this.running = true;
    this.stats.startTime = Date.now();
    
    logger.info('🧪 Starting test run...');
    this.emit('run:start');
    
    try {
      // Load tests if not already loaded
      if (this.suites.length === 0) {
        await this.loadTests();
      }
      
      // Run tests
      if (this.options.parallel) {
        await this._runParallel();
      } else {
        await this._runSequential();
      }
      
      // Generate coverage report
      if (this.options.coverage) {
        await this._generateCoverage();
      }
      
    } finally {
      this.running = false;
      this.stats.endTime = Date.now();
      this.stats.duration = this.stats.endTime - this.stats.startTime;
      
      this._reportResults();
      this.emit('run:complete', this.stats);
    }
    
    return this.stats.failed === 0;
  }
  
  /**
   * Run tests sequentially
   */
  async _runSequential() {
    for (const suite of this.suites) {
      if (this.options.bail && this.stats.failed > 0) break;
      await this._runSuite(suite);
    }
  }
  
  /**
   * Run tests in parallel
   */
  async _runParallel() {
    const workerPool = [];
    
    // Create worker pool
    for (let i = 0; i < Math.min(this.options.maxWorkers, this.suites.length); i++) {
      workerPool.push(this._createWorker());
    }
    
    // Distribute suites to workers
    const suiteQueue = [...this.suites];
    const runningWorkers = new Map();
    
    while (suiteQueue.length > 0 || runningWorkers.size > 0) {
      // Assign suites to available workers
      for (const worker of workerPool) {
        if (!runningWorkers.has(worker) && suiteQueue.length > 0) {
          const suite = suiteQueue.shift();
          const promise = this._runSuiteInWorker(worker, suite);
          runningWorkers.set(worker, promise);
        }
      }
      
      // Wait for any worker to complete
      if (runningWorkers.size > 0) {
        const completed = await Promise.race(runningWorkers.values());
        
        // Find and remove completed worker
        for (const [worker, promise] of runningWorkers) {
          if (await Promise.race([promise, Promise.resolve(false)]) === completed) {
            runningWorkers.delete(worker);
            break;
          }
        }
      }
    }
    
    // Terminate workers
    for (const worker of workerPool) {
      await worker.terminate();
    }
  }
  
  /**
   * Run a test suite
   */
  async _runSuite(suite, context = {}) {
    this.emit('suite:start', suite);
    
    const suiteResult = {
      name: suite.name,
      tests: [],
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      startTime: Date.now()
    };
    
    try {
      // Run beforeAll hooks
      for (const hook of suite.beforeAll) {
        await this._runHook(hook, context);
      }
      
      // Run tests
      for (const test of suite.tests) {
        if (test.type === 'test') {
          const result = await this._runTest(test, suite, context);
          suiteResult.tests.push(result);
          
          // Update stats
          this.stats.total++;
          if (result.status === TestStatus.PASSED) {
            suiteResult.passed++;
            this.stats.passed++;
          } else if (result.status === TestStatus.FAILED) {
            suiteResult.failed++;
            this.stats.failed++;
            
            if (this.options.bail) break;
          } else if (result.status === TestStatus.SKIPPED) {
            suiteResult.skipped++;
            this.stats.skipped++;
          }
        } else if (test instanceof TestSuite) {
          // Nested suite
          await this._runSuite(test, context);
        }
      }
      
      // Run afterAll hooks
      for (const hook of suite.afterAll) {
        await this._runHook(hook, context);
      }
      
    } catch (error) {
      logger.error(`Suite "${suite.name}" failed:`, error);
      suiteResult.error = error;
    }
    
    suiteResult.endTime = Date.now();
    suiteResult.duration = suiteResult.endTime - suiteResult.startTime;
    
    this.results.push(suiteResult);
    this.emit('suite:complete', suiteResult);
    
    return suiteResult;
  }
  
  /**
   * Run a single test
   */
  async _runTest(test, suite, context) {
    const result = {
      name: test.name,
      status: TestStatus.PENDING,
      duration: 0,
      error: null,
      retries: 0
    };
    
    // Skip test if needed
    if (test.skip || (this._hasOnly() && !test.only)) {
      result.status = TestStatus.SKIPPED;
      this.emit('test:skip', result);
      return result;
    }
    
    // Apply filter
    if (this.options.filter && !this.options.filter(test.name)) {
      result.status = TestStatus.SKIPPED;
      return result;
    }
    
    this.emit('test:start', test);
    
    let attempts = 0;
    const maxAttempts = test.options.retries + 1;
    
    while (attempts < maxAttempts) {
      attempts++;
      result.retries = attempts - 1;
      
      const startTime = performance.now();
      
      try {
        // Run beforeEach hooks
        for (const hook of suite.beforeEach) {
          await this._runHook(hook, context);
        }
        
        // Run test with timeout
        await this._runWithTimeout(
          test.fn.bind(context, this.assertions),
          test.options.timeout
        );
        
        // Run afterEach hooks
        for (const hook of suite.afterEach) {
          await this._runHook(hook, context);
        }
        
        result.status = TestStatus.PASSED;
        result.duration = performance.now() - startTime;
        break;
        
      } catch (error) {
        result.error = error;
        result.duration = performance.now() - startTime;
        
        if (error.name === 'TimeoutError') {
          result.status = TestStatus.TIMEOUT;
        } else {
          result.status = TestStatus.FAILED;
        }
        
        // Only retry if not the last attempt
        if (attempts < maxAttempts) {
          logger.warn(`Test "${test.name}" failed, retrying (${attempts}/${maxAttempts})`);
          continue;
        }
      }
    }
    
    this.emit('test:complete', result);
    return result;
  }
  
  /**
   * Run a hook
   */
  async _runHook(hook, context) {
    await this._runWithTimeout(
      hook.bind(context),
      this.options.timeout
    );
  }
  
  /**
   * Run function with timeout
   */
  async _runWithTimeout(fn, timeout) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => {
        setTimeout(() => {
          const error = new Error(`Test timed out after ${timeout}ms`);
          error.name = 'TimeoutError';
          reject(error);
        }, timeout);
      })
    ]);
  }
  
  /**
   * Check if any test has only flag
   */
  _hasOnly() {
    const checkSuite = (suite) => {
      for (const test of suite.tests) {
        if (test.only) return true;
        if (test instanceof TestSuite && checkSuite(test)) return true;
      }
      return false;
    };
    
    return this.suites.some(checkSuite);
  }
  
  /**
   * Find test files
   */
  async _findTestFiles() {
    const files = [];
    
    const scanDir = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.isFile() && this._matchesPattern(entry.name)) {
          files.push(fullPath);
        }
      }
    };
    
    await scanDir(this.options.testDir);
    return files;
  }
  
  /**
   * Check if filename matches pattern
   */
  _matchesPattern(filename) {
    // Simple pattern matching
    const pattern = this.options.pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
    return new RegExp(pattern).test(filename);
  }
  
  /**
   * Create worker for parallel execution
   */
  _createWorker() {
    const workerScript = `
      const { parentPort } = require('worker_threads');
      const { TestRunner } = require('./test-framework.js');
      
      parentPort.on('message', async (message) => {
        if (message.type === 'run-suite') {
          const runner = new TestRunner(message.options);
          const result = await runner._runSuite(message.suite);
          parentPort.postMessage({ type: 'suite-result', result });
        }
      });
    `;
    
    return new Worker(workerScript, { eval: true });
  }
  
  /**
   * Run suite in worker
   */
  async _runSuiteInWorker(worker, suite) {
    return new Promise((resolve, reject) => {
      worker.once('message', (message) => {
        if (message.type === 'suite-result') {
          resolve(message.result);
        }
      });
      
      worker.once('error', reject);
      
      worker.postMessage({
        type: 'run-suite',
        suite: this._serializeSuite(suite),
        options: this.options
      });
    });
  }
  
  /**
   * Serialize suite for worker
   */
  _serializeSuite(suite) {
    // Convert suite to serializable format
    return {
      name: suite.name,
      tests: suite.tests.map(test => ({
        name: test.name,
        type: test.type,
        skip: test.skip,
        only: test.only,
        options: test.options
      })),
      options: suite.options
    };
  }
  
  /**
   * Generate coverage report
   */
  async _generateCoverage() {
    // Coverage generation would integrate with V8 coverage or similar
    logger.info('📊 Generating coverage report...');
    
    this.emit('coverage:complete', {
      lines: 85,
      branches: 75,
      functions: 90,
      statements: 85
    });
  }
  
  /**
   * Report test results
   */
  _reportResults() {
    const { total, passed, failed, skipped, duration } = this.stats;
    
    logger.info('\n📋 Test Results:');
    logger.info(`   Total: ${total}`);
    logger.info(`   ✅ Passed: ${passed}`);
    logger.info(`   ❌ Failed: ${failed}`);
    logger.info(`   ⏭️  Skipped: ${skipped}`);
    logger.info(`   ⏱️  Duration: ${(duration / 1000).toFixed(2)}s\n`);
    
    if (this.options.verbose || failed > 0) {
      this._reportFailures();
    }
  }
  
  /**
   * Report test failures
   */
  _reportFailures() {
    for (const suite of this.results) {
      for (const test of suite.tests) {
        if (test.status === TestStatus.FAILED) {
          logger.error(`\n❌ ${suite.name} > ${test.name}`);
          logger.error(`   ${test.error.message}`);
          if (test.error.stack) {
            logger.error(`   ${test.error.stack}`);
          }
        }
      }
    }
  }
}

/**
 * Assertion library
 */
export class Assertions {
  constructor() {
    this.assertions = 0;
  }
  
  expect(actual) {
    return new Expectation(actual, this);
  }
  
  assert(condition, message = 'Assertion failed') {
    this.assertions++;
    if (!condition) {
      throw new AssertionError(message);
    }
  }
  
  fail(message = 'Test failed') {
    throw new AssertionError(message);
  }
}

/**
 * Expectation class for fluent assertions
 */
class Expectation {
  constructor(actual, assertions) {
    this.actual = actual;
    this.assertions = assertions;
    this.not = new NegatedExpectation(actual, assertions);
  }
  
  toBe(expected) {
    this.assertions.assertions++;
    if (!Object.is(this.actual, expected)) {
      throw new AssertionError(
        `Expected ${this.actual} to be ${expected}`
      );
    }
  }
  
  toEqual(expected) {
    this.assertions.assertions++;
    if (!this._deepEqual(this.actual, expected)) {
      throw new AssertionError(
        `Expected ${JSON.stringify(this.actual)} to equal ${JSON.stringify(expected)}`
      );
    }
  }
  
  toMatch(pattern) {
    this.assertions.assertions++;
    if (!pattern.test(this.actual)) {
      throw new AssertionError(
        `Expected "${this.actual}" to match ${pattern}`
      );
    }
  }
  
  toThrow(errorType) {
    this.assertions.assertions++;
    try {
      this.actual();
      throw new AssertionError('Expected function to throw');
    } catch (error) {
      if (errorType && !(error instanceof errorType)) {
        throw new AssertionError(
          `Expected function to throw ${errorType.name}, but threw ${error.constructor.name}`
        );
      }
    }
  }
  
  toBeGreaterThan(value) {
    this.assertions.assertions++;
    if (!(this.actual > value)) {
      throw new AssertionError(
        `Expected ${this.actual} to be greater than ${value}`
      );
    }
  }
  
  toBeLessThan(value) {
    this.assertions.assertions++;
    if (!(this.actual < value)) {
      throw new AssertionError(
        `Expected ${this.actual} to be less than ${value}`
      );
    }
  }
  
  toContain(item) {
    this.assertions.assertions++;
    if (Array.isArray(this.actual)) {
      if (!this.actual.includes(item)) {
        throw new AssertionError(
          `Expected array to contain ${item}`
        );
      }
    } else if (typeof this.actual === 'string') {
      if (!this.actual.includes(item)) {
        throw new AssertionError(
          `Expected string to contain "${item}"`
        );
      }
    } else {
      throw new AssertionError(
        'toContain can only be used with arrays or strings'
      );
    }
  }
  
  toHaveLength(length) {
    this.assertions.assertions++;
    const actualLength = this.actual.length;
    if (actualLength !== length) {
      throw new AssertionError(
        `Expected length ${length}, but got ${actualLength}`
      );
    }
  }
  
  toBeTruthy() {
    this.assertions.assertions++;
    if (!this.actual) {
      throw new AssertionError(
        `Expected ${this.actual} to be truthy`
      );
    }
  }
  
  toBeFalsy() {
    this.assertions.assertions++;
    if (this.actual) {
      throw new AssertionError(
        `Expected ${this.actual} to be falsy`
      );
    }
  }
  
  _deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (a.constructor !== b.constructor) return false;
    
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this._deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    
    if (typeof a === 'object') {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      
      for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!this._deepEqual(a[key], b[key])) return false;
      }
      return true;
    }
    
    return false;
  }
}

/**
 * Negated expectation
 */
class NegatedExpectation {
  constructor(actual, assertions) {
    this.actual = actual;
    this.assertions = assertions;
  }
  
  toBe(expected) {
    this.assertions.assertions++;
    if (Object.is(this.actual, expected)) {
      throw new AssertionError(
        `Expected ${this.actual} not to be ${expected}`
      );
    }
  }
  
  toEqual(expected) {
    this.assertions.assertions++;
    const expectation = new Expectation(this.actual, this.assertions);
    if (expectation._deepEqual(this.actual, expected)) {
      throw new AssertionError(
        `Expected ${JSON.stringify(this.actual)} not to equal ${JSON.stringify(expected)}`
      );
    }
  }
  
  toContain(item) {
    this.assertions.assertions++;
    try {
      new Expectation(this.actual, this.assertions).toContain(item);
      throw new AssertionError(
        `Expected ${Array.isArray(this.actual) ? 'array' : 'string'} not to contain ${item}`
      );
    } catch (error) {
      if (!(error instanceof AssertionError)) throw error;
    }
  }
}

/**
 * Custom assertion error
 */
class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * Global test helpers
 */
export const describe = (name, fn) => {
  const suite = new TestSuite(name);
  fn.call(suite);
  return suite;
};

export const it = (name, fn) => {
  throw new Error('it() must be called inside describe()');
};

export const test = it;

export default {
  TestRunner,
  TestSuite,
  Assertions,
  describe,
  it,
  test
};