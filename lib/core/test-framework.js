/**
 * Test Framework - Otedama
 * Enhanced testing utilities and framework
 * 
 * Design: Test everything that matters (Carmack)
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { createStructuredLogger } from './structured-logger.js';
import { profiler } from './profiler.js';

const logger = createStructuredLogger('TestFramework');

/**
 * Test result types
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
 * Test case
 */
export class TestCase {
  constructor(name, fn, options = {}) {
    this.name = name;
    this.fn = fn;
    this.options = {
      timeout: options.timeout || 5000,
      retries: options.retries || 0,
      skip: options.skip || false,
      only: options.only || false,
      ...options
    };
    
    this.status = TestStatus.PENDING;
    this.duration = 0;
    this.error = null;
    this.attempts = 0;
  }
  
  async run(context) {
    if (this.options.skip) {
      this.status = TestStatus.SKIPPED;
      return this;
    }
    
    this.status = TestStatus.RUNNING;
    const startTime = performance.now();
    
    try {
      // Run with timeout
      await this.runWithTimeout(context);
      
      this.status = TestStatus.PASSED;
      this.duration = performance.now() - startTime;
      
    } catch (error) {
      this.error = error;
      this.duration = performance.now() - startTime;
      
      // Retry if configured
      if (this.attempts < this.options.retries) {
        this.attempts++;
        logger.debug(`Retrying test "${this.name}" (attempt ${this.attempts + 1})`);
        return this.run(context);
      }
      
      this.status = error.message === 'Test timeout' 
        ? TestStatus.TIMEOUT 
        : TestStatus.FAILED;
    }
    
    return this;
  }
  
  async runWithTimeout(context) {
    return new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Test timeout'));
      }, this.options.timeout);
      
      try {
        await this.fn(context);
        clearTimeout(timer);
        resolve();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }
}

/**
 * Test suite
 */
export class TestSuite {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.tests = [];
    this.suites = [];
    this.hooks = {
      beforeAll: [],
      afterAll: [],
      beforeEach: [],
      afterEach: []
    };
  }
  
  test(name, fn, options = {}) {
    const test = new TestCase(name, fn, options);
    this.tests.push(test);
    return test;
  }
  
  suite(name, fn, options = {}) {
    const suite = new TestSuite(name, options);
    this.suites.push(suite);
    
    if (fn) {
      fn(suite);
    }
    
    return suite;
  }
  
  beforeAll(fn) {
    this.hooks.beforeAll.push(fn);
  }
  
  afterAll(fn) {
    this.hooks.afterAll.push(fn);
  }
  
  beforeEach(fn) {
    this.hooks.beforeEach.push(fn);
  }
  
  afterEach(fn) {
    this.hooks.afterEach.push(fn);
  }
  
  skip(name, fn, options = {}) {
    return this.test(name, fn, { ...options, skip: true });
  }
  
  only(name, fn, options = {}) {
    return this.test(name, fn, { ...options, only: true });
  }
  
  async run(context = {}) {
    const results = {
      name: this.name,
      tests: [],
      suites: [],
      stats: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        timeout: 0,
        duration: 0
      }
    };
    
    const startTime = performance.now();
    
    // Run beforeAll hooks
    for (const hook of this.hooks.beforeAll) {
      await hook(context);
    }
    
    // Check if any tests are marked as only
    const hasOnly = this.tests.some(t => t.options.only) ||
                   this.suites.some(s => s.hasOnly());
    
    // Run tests
    for (const test of this.tests) {
      if (hasOnly && !test.options.only) {
        test.status = TestStatus.SKIPPED;
        results.tests.push(test);
        results.stats.skipped++;
        continue;
      }
      
      // Run beforeEach hooks
      for (const hook of this.hooks.beforeEach) {
        await hook(context);
      }
      
      // Run test
      await test.run(context);
      results.tests.push(test);
      
      // Update stats
      results.stats.total++;
      results.stats[test.status]++;
      
      // Run afterEach hooks
      for (const hook of this.hooks.afterEach) {
        await hook(context);
      }
    }
    
    // Run nested suites
    for (const suite of this.suites) {
      const suiteResults = await suite.run(context);
      results.suites.push(suiteResults);
      
      // Aggregate stats
      results.stats.total += suiteResults.stats.total;
      results.stats.passed += suiteResults.stats.passed;
      results.stats.failed += suiteResults.stats.failed;
      results.stats.skipped += suiteResults.stats.skipped;
      results.stats.timeout += suiteResults.stats.timeout;
    }
    
    // Run afterAll hooks
    for (const hook of this.hooks.afterAll) {
      await hook(context);
    }
    
    results.stats.duration = performance.now() - startTime;
    
    return results;
  }
  
  hasOnly() {
    return this.tests.some(t => t.options.only) ||
           this.suites.some(s => s.hasOnly());
  }
}

/**
 * Assertion library
 */
export class Assert {
  static equal(actual, expected, message) {
    if (actual !== expected) {
      throw new AssertionError(
        message || `Expected ${expected} but got ${actual}`
      );
    }
  }
  
  static deepEqual(actual, expected, message) {
    if (!this.deepCompare(actual, expected)) {
      throw new AssertionError(
        message || `Expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`
      );
    }
  }
  
  static notEqual(actual, expected, message) {
    if (actual === expected) {
      throw new AssertionError(
        message || `Expected ${actual} to not equal ${expected}`
      );
    }
  }
  
  static true(value, message) {
    if (value !== true) {
      throw new AssertionError(
        message || `Expected true but got ${value}`
      );
    }
  }
  
  static false(value, message) {
    if (value !== false) {
      throw new AssertionError(
        message || `Expected false but got ${value}`
      );
    }
  }
  
  static null(value, message) {
    if (value !== null) {
      throw new AssertionError(
        message || `Expected null but got ${value}`
      );
    }
  }
  
  static notNull(value, message) {
    if (value === null) {
      throw new AssertionError(
        message || `Expected not null but got null`
      );
    }
  }
  
  static undefined(value, message) {
    if (value !== undefined) {
      throw new AssertionError(
        message || `Expected undefined but got ${value}`
      );
    }
  }
  
  static defined(value, message) {
    if (value === undefined) {
      throw new AssertionError(
        message || `Expected defined value but got undefined`
      );
    }
  }
  
  static instanceOf(value, constructor, message) {
    if (!(value instanceof constructor)) {
      throw new AssertionError(
        message || `Expected instance of ${constructor.name}`
      );
    }
  }
  
  static throws(fn, expected, message) {
    let thrown = false;
    let error;
    
    try {
      fn();
    } catch (e) {
      thrown = true;
      error = e;
    }
    
    if (!thrown) {
      throw new AssertionError(
        message || 'Expected function to throw'
      );
    }
    
    if (expected) {
      if (typeof expected === 'string' && error.message !== expected) {
        throw new AssertionError(
          `Expected error message "${expected}" but got "${error.message}"`
        );
      } else if (expected instanceof RegExp && !expected.test(error.message)) {
        throw new AssertionError(
          `Expected error message to match ${expected} but got "${error.message}"`
        );
      } else if (typeof expected === 'function' && !(error instanceof expected)) {
        throw new AssertionError(
          `Expected error to be instance of ${expected.name}`
        );
      }
    }
  }
  
  static async rejects(promise, expected, message) {
    let rejected = false;
    let error;
    
    try {
      await promise;
    } catch (e) {
      rejected = true;
      error = e;
    }
    
    if (!rejected) {
      throw new AssertionError(
        message || 'Expected promise to reject'
      );
    }
    
    if (expected) {
      if (typeof expected === 'string' && error.message !== expected) {
        throw new AssertionError(
          `Expected rejection message "${expected}" but got "${error.message}"`
        );
      } else if (expected instanceof RegExp && !expected.test(error.message)) {
        throw new AssertionError(
          `Expected rejection message to match ${expected} but got "${error.message}"`
        );
      } else if (typeof expected === 'function' && !(error instanceof expected)) {
        throw new AssertionError(
          `Expected rejection to be instance of ${expected.name}`
        );
      }
    }
  }
  
  static includes(collection, item, message) {
    let includes = false;
    
    if (Array.isArray(collection)) {
      includes = collection.includes(item);
    } else if (typeof collection === 'string') {
      includes = collection.includes(item);
    } else if (collection instanceof Set) {
      includes = collection.has(item);
    } else if (collection instanceof Map) {
      includes = collection.has(item);
    }
    
    if (!includes) {
      throw new AssertionError(
        message || `Expected collection to include ${item}`
      );
    }
  }
  
  static deepCompare(a, b) {
    if (a === b) return true;
    
    if (a === null || b === null) return false;
    if (a === undefined || b === undefined) return false;
    
    if (typeof a !== typeof b) return false;
    
    if (typeof a === 'object') {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      
      if (keysA.length !== keysB.length) return false;
      
      for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!this.deepCompare(a[key], b[key])) return false;
      }
      
      return true;
    }
    
    return false;
  }
}

/**
 * Assertion error
 */
export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

/**
 * Test runner
 */
export class TestRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      bail: options.bail || false,
      parallel: options.parallel || false,
      reporter: options.reporter || 'default',
      profile: options.profile !== false,
      ...options
    };
    
    this.suites = [];
    this.globalContext = {};
  }
  
  addSuite(suite) {
    this.suites.push(suite);
  }
  
  async run() {
    logger.info('Starting test run...');
    
    const results = {
      suites: [],
      stats: {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        timeout: 0,
        duration: 0
      }
    };
    
    const startTime = performance.now();
    
    // Enable profiling if requested
    if (this.options.profile) {
      profiler.start();
    }
    
    try {
      // Run suites
      if (this.options.parallel) {
        // Run in parallel
        const promises = this.suites.map(suite => suite.run(this.globalContext));
        const suiteResults = await Promise.all(promises);
        results.suites.push(...suiteResults);
      } else {
        // Run sequentially
        for (const suite of this.suites) {
          const suiteResult = await suite.run(this.globalContext);
          results.suites.push(suiteResult);
          
          // Bail on first failure if configured
          if (this.options.bail && suiteResult.stats.failed > 0) {
            break;
          }
        }
      }
      
      // Aggregate stats
      for (const suite of results.suites) {
        results.stats.total += suite.stats.total;
        results.stats.passed += suite.stats.passed;
        results.stats.failed += suite.stats.failed;
        results.stats.skipped += suite.stats.skipped;
        results.stats.timeout += suite.stats.timeout;
      }
      
    } finally {
      results.stats.duration = performance.now() - startTime;
      
      // Stop profiling
      if (this.options.profile) {
        profiler.stop();
        results.profile = profiler.getStats();
      }
    }
    
    // Report results
    this.report(results);
    
    return results;
  }
  
  report(results) {
    const reporter = this.getReporter();
    reporter.report(results);
  }
  
  getReporter() {
    if (typeof this.options.reporter === 'object') {
      return this.options.reporter;
    }
    
    switch (this.options.reporter) {
      case 'json':
        return new JSONReporter();
      case 'tap':
        return new TAPReporter();
      default:
        return new DefaultReporter();
    }
  }
}

/**
 * Default reporter
 */
export class DefaultReporter {
  report(results) {
    console.log('\nTest Results:');
    console.log('=============\n');
    
    // Report each suite
    for (const suite of results.suites) {
      this.reportSuite(suite);
    }
    
    // Summary
    console.log('\nSummary:');
    console.log(`Total:   ${results.stats.total}`);
    console.log(`Passed:  ${results.stats.passed} ✓`);
    console.log(`Failed:  ${results.stats.failed} ✗`);
    console.log(`Skipped: ${results.stats.skipped} -`);
    console.log(`Timeout: ${results.stats.timeout} ⏱`);
    console.log(`Duration: ${results.stats.duration.toFixed(2)}ms`);
    
    // Exit code
    process.exitCode = results.stats.failed > 0 ? 1 : 0;
  }
  
  reportSuite(suite, indent = '') {
    console.log(`${indent}${suite.name}`);
    
    // Report tests
    for (const test of suite.tests) {
      const symbol = this.getSymbol(test.status);
      console.log(`${indent}  ${symbol} ${test.name} (${test.duration.toFixed(2)}ms)`);
      
      if (test.error) {
        console.log(`${indent}    ${test.error.message}`);
        if (test.error.stack) {
          console.log(`${indent}    ${test.error.stack.split('\n').slice(1).join(`\n${indent}    `)}`);
        }
      }
    }
    
    // Report nested suites
    for (const nestedSuite of suite.suites) {
      this.reportSuite(nestedSuite, indent + '  ');
    }
  }
  
  getSymbol(status) {
    switch (status) {
      case TestStatus.PASSED: return '✓';
      case TestStatus.FAILED: return '✗';
      case TestStatus.SKIPPED: return '-';
      case TestStatus.TIMEOUT: return '⏱';
      default: return '?';
    }
  }
}

/**
 * JSON reporter
 */
export class JSONReporter {
  report(results) {
    console.log(JSON.stringify(results, null, 2));
  }
}

/**
 * TAP reporter
 */
export class TAPReporter {
  report(results) {
    console.log('TAP version 13');
    console.log(`1..${results.stats.total}`);
    
    let testNumber = 0;
    
    for (const suite of results.suites) {
      this.reportSuite(suite, testNumber);
      testNumber += suite.stats.total;
    }
  }
  
  reportSuite(suite, startNumber) {
    let testNumber = startNumber;
    
    for (const test of suite.tests) {
      testNumber++;
      
      if (test.status === TestStatus.PASSED) {
        console.log(`ok ${testNumber} - ${suite.name} > ${test.name}`);
      } else if (test.status === TestStatus.SKIPPED) {
        console.log(`ok ${testNumber} - ${suite.name} > ${test.name} # SKIP`);
      } else {
        console.log(`not ok ${testNumber} - ${suite.name} > ${test.name}`);
        
        if (test.error) {
          console.log(`  ---`);
          console.log(`  message: ${test.error.message}`);
          console.log(`  stack: |`);
          console.log(`    ${test.error.stack.split('\n').join('\n    ')}`);
          console.log(`  ...`);
        }
      }
    }
    
    for (const nestedSuite of suite.suites) {
      this.reportSuite(nestedSuite, testNumber);
      testNumber += nestedSuite.stats.total;
    }
  }
}

/**
 * Test utilities
 */
export const test = {
  suite: (name, fn, options) => {
    const suite = new TestSuite(name, options);
    if (fn) fn(suite);
    return suite;
  },
  
  runner: (options) => new TestRunner(options),
  
  assert: Assert
};

export default {
  TestCase,
  TestSuite,
  TestRunner,
  Assert,
  AssertionError,
  TestStatus,
  DefaultReporter,
  JSONReporter,
  TAPReporter,
  test
};
