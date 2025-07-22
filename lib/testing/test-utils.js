/**
 * Testing Utilities for Otedama
 * Helper functions and mocks for testing
 * 
 * Design principles:
 * - Carmack: Efficient test helpers
 * - Martin: Clean test utilities
 * - Pike: Simple mocking and stubbing
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { getLogger } from '../core/logger.js';

const logger = getLogger('TestUtils');

/**
 * Mock builder for creating test doubles
 */
export class MockBuilder {
  constructor(name = 'Mock') {
    this.name = name;
    this.calls = [];
    this.implementations = new Map();
    this.returnValues = new Map();
    this.errors = new Map();
    this.delays = new Map();
  }
  
  /**
   * Create a mock function
   */
  fn(implementation = null) {
    const mock = this;
    const mockFn = function(...args) {
      const call = {
        args,
        timestamp: Date.now(),
        context: this,
        result: undefined,
        error: undefined
      };
      
      mock.calls.push(call);
      
      // Check for configured error
      const errorConfig = mock._findConfig(mock.errors, args);
      if (errorConfig) {
        call.error = errorConfig.value;
        throw errorConfig.value;
      }
      
      // Check for configured delay
      const delayConfig = mock._findConfig(mock.delays, args);
      if (delayConfig) {
        return new Promise(resolve => {
          setTimeout(() => {
            const result = mock._getResult(args, implementation);
            call.result = result;
            resolve(result);
          }, delayConfig.value);
        });
      }
      
      // Get result
      const result = mock._getResult(args, implementation);
      call.result = result;
      return result;
    };
    
    // Add mock properties
    mockFn.mock = mock;
    mockFn.mockClear = () => mock.clear();
    mockFn.mockReset = () => mock.reset();
    mockFn.mockRestore = () => mock.restore();
    mockFn.mockReturnValue = (value) => mock.returnValue(value);
    mockFn.mockReturnValueOnce = (value) => mock.returnValueOnce(value);
    mockFn.mockImplementation = (impl) => mock.implementation(impl);
    mockFn.mockImplementationOnce = (impl) => mock.implementationOnce(impl);
    mockFn.mockResolvedValue = (value) => mock.resolvedValue(value);
    mockFn.mockRejectedValue = (error) => mock.rejectedValue(error);
    
    return mockFn;
  }
  
  /**
   * Get result for mock call
   */
  _getResult(args, defaultImpl) {
    // Check for specific return value
    const returnConfig = this._findConfig(this.returnValues, args);
    if (returnConfig) {
      if (returnConfig.once) {
        this.returnValues.delete(returnConfig.key);
      }
      return returnConfig.value;
    }
    
    // Check for specific implementation
    const implConfig = this._findConfig(this.implementations, args);
    if (implConfig) {
      if (implConfig.once) {
        this.implementations.delete(implConfig.key);
      }
      return implConfig.value(...args);
    }
    
    // Use default implementation
    if (defaultImpl) {
      return defaultImpl(...args);
    }
    
    return undefined;
  }
  
  /**
   * Find configuration for arguments
   */
  _findConfig(map, args) {
    // Check for exact match
    const exactKey = JSON.stringify(args);
    if (map.has(exactKey)) {
      return { key: exactKey, ...map.get(exactKey) };
    }
    
    // Check for 'any' match
    if (map.has('any')) {
      return { key: 'any', ...map.get('any') };
    }
    
    return null;
  }
  
  /**
   * Configure return value
   */
  returnValue(value) {
    this.returnValues.set('any', { value, once: false });
    return this;
  }
  
  returnValueOnce(value) {
    this.returnValues.set('any', { value, once: true });
    return this;
  }
  
  /**
   * Configure implementation
   */
  implementation(impl) {
    this.implementations.set('any', { value: impl, once: false });
    return this;
  }
  
  implementationOnce(impl) {
    this.implementations.set('any', { value: impl, once: true });
    return this;
  }
  
  /**
   * Configure promise resolution
   */
  resolvedValue(value) {
    return this.returnValue(Promise.resolve(value));
  }
  
  rejectedValue(error) {
    return this.returnValue(Promise.reject(error));
  }
  
  /**
   * Configure errors
   */
  throwError(error) {
    this.errors.set('any', { value: error, once: false });
    return this;
  }
  
  /**
   * Configure delays
   */
  withDelay(ms) {
    this.delays.set('any', { value: ms, once: false });
    return this;
  }
  
  /**
   * Clear mock calls
   */
  clear() {
    this.calls = [];
    return this;
  }
  
  /**
   * Reset mock
   */
  reset() {
    this.clear();
    this.implementations.clear();
    this.returnValues.clear();
    this.errors.clear();
    this.delays.clear();
    return this;
  }
  
  /**
   * Restore original implementation
   */
  restore() {
    // Override in spy implementation
    return this;
  }
  
  /**
   * Get call information
   */
  get callCount() {
    return this.calls.length;
  }
  
  get called() {
    return this.calls.length > 0;
  }
  
  get notCalled() {
    return this.calls.length === 0;
  }
  
  calledWith(...args) {
    return this.calls.some(call => 
      JSON.stringify(call.args) === JSON.stringify(args)
    );
  }
  
  calledWithMatch(matcher) {
    return this.calls.some(call => 
      this._matchArgs(call.args, matcher)
    );
  }
  
  nthCall(n) {
    return this.calls[n];
  }
  
  lastCall() {
    return this.calls[this.calls.length - 1];
  }
  
  /**
   * Match arguments with matcher
   */
  _matchArgs(args, matcher) {
    if (typeof matcher === 'function') {
      return matcher(args);
    }
    
    if (Array.isArray(matcher)) {
      return args.every((arg, i) => {
        if (i >= matcher.length) return true;
        return this._matchValue(arg, matcher[i]);
      });
    }
    
    return false;
  }
  
  _matchValue(value, matcher) {
    if (matcher === any) return true;
    if (typeof matcher === 'function') return matcher(value);
    return value === matcher;
  }
}

/**
 * Spy on existing functions
 */
export class Spy extends MockBuilder {
  constructor(object, method) {
    super(`Spy(${method})`);
    this.object = object;
    this.method = method;
    this.original = object[method];
    
    // Replace with spy
    const spy = this.fn(this.original.bind(object));
    object[method] = spy;
    
    this.spy = spy;
  }
  
  restore() {
    this.object[this.method] = this.original;
    return this;
  }
}

/**
 * Test data generators
 */
export class TestDataGenerator {
  constructor(seed = Date.now()) {
    this.seed = seed;
    this.index = 0;
  }
  
  /**
   * Generate random number
   */
  number(min = 0, max = 100) {
    return Math.floor(this._random() * (max - min + 1)) + min;
  }
  
  /**
   * Generate random string
   */
  string(length = 10) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(this._random() * chars.length)];
    }
    
    return result;
  }
  
  /**
   * Generate UUID
   */
  uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (this._random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  
  /**
   * Generate email
   */
  email() {
    return `${this.string(8)}@${this.string(5)}.com`;
  }
  
  /**
   * Generate IP address
   */
  ip() {
    return `${this.number(1, 255)}.${this.number(0, 255)}.${this.number(0, 255)}.${this.number(0, 255)}`;
  }
  
  /**
   * Generate date
   */
  date(start = new Date(2020, 0, 1), end = new Date()) {
    const timestamp = this.number(start.getTime(), end.getTime());
    return new Date(timestamp);
  }
  
  /**
   * Generate array
   */
  array(generator, count = 10) {
    const result = [];
    for (let i = 0; i < count; i++) {
      result.push(generator(i));
    }
    return result;
  }
  
  /**
   * Generate object
   */
  object(schema) {
    const result = {};
    
    for (const [key, generator] of Object.entries(schema)) {
      if (typeof generator === 'function') {
        result[key] = generator();
      } else {
        result[key] = generator;
      }
    }
    
    return result;
  }
  
  /**
   * Pick random element
   */
  pick(array) {
    return array[Math.floor(this._random() * array.length)];
  }
  
  /**
   * Shuffle array
   */
  shuffle(array) {
    const result = [...array];
    
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this._random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    
    return result;
  }
  
  /**
   * Simple pseudo-random number generator
   */
  _random() {
    this.index++;
    const x = Math.sin(this.seed + this.index) * 10000;
    return x - Math.floor(x);
  }
}

/**
 * Test server utilities
 */
export class TestServer {
  constructor(options = {}) {
    this.options = {
      port: options.port || 0, // 0 = random port
      host: options.host || 'localhost',
      ...options
    };
    
    this.server = null;
    this.address = null;
  }
  
  /**
   * Start HTTP server
   */
  async startHTTP(handler) {
    this.server = createServer(handler || ((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Test Server');
    }));
    
    await new Promise((resolve, reject) => {
      this.server.listen(this.options.port, this.options.host, (error) => {
        if (error) reject(error);
        else {
          this.address = this.server.address();
          resolve();
        }
      });
    });
    
    return this.getURL();
  }
  
  /**
   * Start WebSocket server
   */
  async startWebSocket(handler) {
    await this.startHTTP();
    
    this.wss = new WebSocketServer({ server: this.server });
    
    if (handler) {
      this.wss.on('connection', handler);
    }
    
    return this.getWebSocketURL();
  }
  
  /**
   * Stop server
   */
  async stop() {
    if (this.wss) {
      await new Promise(resolve => {
        this.wss.close(resolve);
      });
    }
    
    if (this.server) {
      await new Promise(resolve => {
        this.server.close(resolve);
      });
    }
    
    this.server = null;
    this.wss = null;
    this.address = null;
  }
  
  /**
   * Get server URL
   */
  getURL(path = '/') {
    if (!this.address) return null;
    return `http://${this.address.address}:${this.address.port}${path}`;
  }
  
  /**
   * Get WebSocket URL
   */
  getWebSocketURL(path = '/') {
    if (!this.address) return null;
    return `ws://${this.address.address}:${this.address.port}${path}`;
  }
}

/**
 * Performance testing utilities
 */
export class PerformanceTester {
  constructor(options = {}) {
    this.options = {
      warmupRuns: options.warmupRuns || 10,
      testRuns: options.testRuns || 100,
      timeout: options.timeout || 30000,
      ...options
    };
    
    this.results = [];
  }
  
  /**
   * Benchmark a function
   */
  async benchmark(name, fn, options = {}) {
    const config = { ...this.options, ...options };
    
    logger.info(`Benchmarking: ${name}`);
    
    // Warmup
    for (let i = 0; i < config.warmupRuns; i++) {
      await fn();
    }
    
    // Test runs
    const times = [];
    const startTime = Date.now();
    
    for (let i = 0; i < config.testRuns; i++) {
      if (Date.now() - startTime > config.timeout) {
        logger.warn('Benchmark timeout reached');
        break;
      }
      
      const start = performance.now();
      await fn();
      const duration = performance.now() - start;
      times.push(duration);
    }
    
    // Calculate statistics
    const sorted = times.sort((a, b) => a - b);
    const result = {
      name,
      runs: times.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: times.reduce((a, b) => a + b, 0) / times.length,
      median: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      stdDev: this._calculateStdDev(times),
      ops: 1000 / (times.reduce((a, b) => a + b, 0) / times.length)
    };
    
    this.results.push(result);
    return result;
  }
  
  /**
   * Compare multiple implementations
   */
  async compare(implementations) {
    const results = [];
    
    for (const [name, fn] of Object.entries(implementations)) {
      const result = await this.benchmark(name, fn);
      results.push(result);
    }
    
    // Sort by performance
    results.sort((a, b) => a.mean - b.mean);
    
    // Calculate relative performance
    const fastest = results[0];
    for (const result of results) {
      result.relative = result.mean / fastest.mean;
      result.percentSlower = ((result.relative - 1) * 100).toFixed(2) + '%';
    }
    
    this._printComparison(results);
    return results;
  }
  
  /**
   * Memory usage test
   */
  async measureMemory(name, fn, iterations = 1000) {
    const gc = global.gc;
    if (!gc) {
      logger.warn('Run with --expose-gc for accurate memory measurements');
    }
    
    // Initial GC
    if (gc) gc();
    
    const startMemory = process.memoryUsage();
    const startTime = performance.now();
    
    // Run iterations
    for (let i = 0; i < iterations; i++) {
      await fn();
    }
    
    const endTime = performance.now();
    const endMemory = process.memoryUsage();
    
    // Final GC
    if (gc) gc();
    const finalMemory = process.memoryUsage();
    
    return {
      name,
      iterations,
      duration: endTime - startTime,
      memoryDelta: {
        heapUsed: endMemory.heapUsed - startMemory.heapUsed,
        heapTotal: endMemory.heapTotal - startMemory.heapTotal,
        external: endMemory.external - startMemory.external,
        rss: endMemory.rss - startMemory.rss
      },
      memoryLeaked: {
        heapUsed: finalMemory.heapUsed - startMemory.heapUsed,
        heapTotal: finalMemory.heapTotal - startMemory.heapTotal
      }
    };
  }
  
  /**
   * Calculate standard deviation
   */
  _calculateStdDev(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquaredDiff);
  }
  
  /**
   * Print comparison results
   */
  _printComparison(results) {
    logger.info('\nPerformance Comparison:');
    logger.info('-'.repeat(60));
    
    for (const result of results) {
      const status = result === results[0] ? '🏆' : '';
      logger.info(
        `${status} ${result.name.padEnd(20)} ` +
        `${result.mean.toFixed(3)}ms ` +
        `(±${result.stdDev.toFixed(3)}) ` +
        `${result.ops.toFixed(2)} ops/s ` +
        `${result === results[0] ? '' : result.percentSlower + ' slower'}`
      );
    }
    
    logger.info('-'.repeat(60));
  }
}

/**
 * Wait utilities
 */
export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export const waitFor = async (condition, options = {}) => {
  const {
    timeout = 5000,
    interval = 100,
    message = 'Condition not met'
  } = options;
  
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return true;
    }
    await wait(interval);
  }
  
  throw new Error(`Timeout waiting for condition: ${message}`);
};

/**
 * Matcher helpers
 */
export const any = Symbol('any');
export const anyString = (value) => typeof value === 'string';
export const anyNumber = (value) => typeof value === 'number';
export const anyObject = (value) => typeof value === 'object' && value !== null;
export const anyArray = (value) => Array.isArray(value);
export const anyFunction = (value) => typeof value === 'function';

/**
 * Create mock function
 */
export const mock = (implementation) => new MockBuilder().fn(implementation);

/**
 * Create spy
 */
export const spy = (object, method) => new Spy(object, method);

/**
 * Create test data generator
 */
export const createTestData = (seed) => new TestDataGenerator(seed);

/**
 * Create test server
 */
export const createTestServer = (options) => new TestServer(options);

/**
 * Create performance tester
 */
export const createPerformanceTester = (options) => new PerformanceTester(options);

export default {
  MockBuilder,
  Spy,
  TestDataGenerator,
  TestServer,
  PerformanceTester,
  wait,
  waitFor,
  any,
  anyString,
  anyNumber,
  anyObject,
  anyArray,
  anyFunction,
  mock,
  spy,
  createTestData,
  createTestServer,
  createPerformanceTester
};