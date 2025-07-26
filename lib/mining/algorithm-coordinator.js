/**
 * Algorithm Coordinator for Otedama
 * Dynamically selects optimal mining algorithm implementation
 * 
 * Design principles:
 * - Carmack: Real-time performance optimization
 * - Martin: Clean separation of concerns
 * - Pike: Simple, effective coordination
 */

import { EventEmitter } from 'events';
import { createStructuredLogger } from '../core/structured-logger.js';
import { SHA256Optimized } from './algorithms/sha256.js';
import { wasmAlgorithmManager } from './algorithms/wasm-algorithms.js';
import { NativeAlgorithmFactory } from './algorithms/native-bindings.js';
import { performance } from 'perf_hooks';

const logger = createStructuredLogger('AlgorithmCoordinator');

/**
 * Performance tracking window
 */
const PERFORMANCE_WINDOW = {
  SIZE: 100,        // Sample size
  INTERVAL: 10000,  // Check interval (10 seconds)
  THRESHOLD: 1.1    // 10% improvement threshold
};

/**
 * Algorithm implementation types
 */
export const ImplementationType = {
  JAVASCRIPT: 'javascript',
  WASM: 'wasm',
  NATIVE: 'native',
  GPU: 'gpu'
};

/**
 * Performance metrics
 */
class PerformanceMetrics {
  constructor(windowSize = PERFORMANCE_WINDOW.SIZE) {
    this.windowSize = windowSize;
    this.samples = [];
    this.totalHashes = 0;
    this.totalTime = 0;
    this.errors = 0;
  }

  addSample(hashCount, duration, error = false) {
    this.samples.push({
      hashCount,
      duration,
      timestamp: Date.now(),
      error
    });

    if (!error) {
      this.totalHashes += hashCount;
      this.totalTime += duration;
    } else {
      this.errors++;
    }

    // Maintain window size
    if (this.samples.length > this.windowSize) {
      const removed = this.samples.shift();
      if (!removed.error) {
        this.totalHashes -= removed.hashCount;
        this.totalTime -= removed.duration;
      }
    }
  }

  getHashRate() {
    if (this.totalTime === 0) return 0;
    return (this.totalHashes / this.totalTime) * 1000; // H/s
  }

  getErrorRate() {
    if (this.samples.length === 0) return 0;
    return this.errors / this.samples.length;
  }

  getLatency() {
    const validSamples = this.samples.filter(s => !s.error);
    if (validSamples.length === 0) return { avg: 0, p95: 0, p99: 0 };

    const latencies = validSamples.map(s => s.duration / s.hashCount);
    latencies.sort((a, b) => a - b);

    return {
      avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95: latencies[Math.floor(latencies.length * 0.95)],
      p99: latencies[Math.floor(latencies.length * 0.99)]
    };
  }

  reset() {
    this.samples = [];
    this.totalHashes = 0;
    this.totalTime = 0;
    this.errors = 0;
  }
}

/**
 * Algorithm implementation wrapper
 */
class AlgorithmImplementation {
  constructor(name, type, instance) {
    this.name = name;
    this.type = type;
    this.instance = instance;
    this.metrics = new PerformanceMetrics();
    this.available = true;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    try {
      if (this.instance.initialize) {
        await this.instance.initialize();
      }
      this.initialized = true;
      this.available = true;
    } catch (error) {
      logger.error(`Failed to initialize ${this.name}:`, error);
      this.available = false;
      throw error;
    }
  }

  async hash(blockHeader, nonce, target) {
    if (!this.initialized) {
      await this.initialize();
    }

    const start = performance.now();
    
    try {
      const result = await this.instance.hash(blockHeader, nonce, target);
      const duration = performance.now() - start;
      
      this.metrics.addSample(1, duration, false);
      
      return result;
    } catch (error) {
      const duration = performance.now() - start;
      this.metrics.addSample(1, duration, true);
      throw error;
    }
  }

  async batchHash(blockHeader, startNonce, count, target) {
    if (!this.initialized) {
      await this.initialize();
    }

    const start = performance.now();
    
    try {
      const results = [];
      
      // Use batch method if available
      if (this.instance.batchHash) {
        const batchResults = await this.instance.batchHash(
          blockHeader, 
          startNonce, 
          startNonce + count, 
          target
        );
        results.push(...batchResults);
      } else {
        // Fall back to individual hashing
        for (let i = 0; i < count; i++) {
          const result = await this.instance.hash(
            blockHeader, 
            startNonce + i, 
            target
          );
          if (result.valid) {
            results.push(result);
          }
        }
      }
      
      const duration = performance.now() - start;
      this.metrics.addSample(count, duration, false);
      
      return results;
    } catch (error) {
      const duration = performance.now() - start;
      this.metrics.addSample(count, duration, true);
      throw error;
    }
  }

  getPerformance() {
    return {
      name: this.name,
      type: this.type,
      available: this.available,
      initialized: this.initialized,
      hashRate: this.metrics.getHashRate(),
      errorRate: this.metrics.getErrorRate(),
      latency: this.metrics.getLatency(),
      samples: this.metrics.samples.length
    };
  }
}

/**
 * Dynamic Algorithm Coordinator
 */
export class AlgorithmCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      algorithm: options.algorithm || 'sha256',
      autoOptimize: options.autoOptimize !== false,
      checkInterval: options.checkInterval || PERFORMANCE_WINDOW.INTERVAL,
      switchThreshold: options.switchThreshold || PERFORMANCE_WINDOW.THRESHOLD,
      preferredType: options.preferredType || ImplementationType.WASM,
      ...options
    };

    this.implementations = new Map();
    this.currentImplementation = null;
    this.checkTimer = null;
    this.isRunning = false;

    // Performance history
    this.performanceHistory = new Map();
  }

  /**
   * Initialize coordinator
   */
  async initialize() {
    logger.info(`Initializing algorithm coordinator for ${this.options.algorithm}`);

    // Load available implementations
    await this.loadImplementations();

    // Select initial implementation
    await this.selectBestImplementation();

    // Start optimization if enabled
    if (this.options.autoOptimize) {
      this.startOptimization();
    }

    this.emit('initialized', {
      algorithm: this.options.algorithm,
      implementations: Array.from(this.implementations.keys()),
      current: this.currentImplementation?.name
    });
  }

  /**
   * Load all available implementations
   */
  async loadImplementations() {
    const algorithm = this.options.algorithm;

    // JavaScript implementation
    try {
      let jsImpl;
      switch (algorithm) {
        case 'sha256':
          jsImpl = new SHA256Optimized();
          break;
        // Add other algorithms as needed
      }

      if (jsImpl) {
        const impl = new AlgorithmImplementation(
          `${algorithm}-js`,
          ImplementationType.JAVASCRIPT,
          jsImpl
        );
        this.implementations.set(impl.name, impl);
        logger.info(`Loaded JavaScript implementation for ${algorithm}`);
      }
    } catch (error) {
      logger.warn(`Failed to load JavaScript ${algorithm}:`, error.message);
    }

    // WASM implementation
    try {
      await wasmAlgorithmManager.initialize();
      const wasmImpl = await wasmAlgorithmManager.createAlgorithm(`${algorithm}-wasm`);
      
      const impl = new AlgorithmImplementation(
        `${algorithm}-wasm`,
        ImplementationType.WASM,
        wasmImpl
      );
      this.implementations.set(impl.name, impl);
      logger.info(`Loaded WASM implementation for ${algorithm}`);
    } catch (error) {
      logger.warn(`Failed to load WASM ${algorithm}:`, error.message);
    }

    // Native implementation
    try {
      if (NativeAlgorithmFactory.isNativeAvailable(algorithm)) {
        const nativeImpl = NativeAlgorithmFactory.create(algorithm);
        
        const impl = new AlgorithmImplementation(
          `${algorithm}-native`,
          ImplementationType.NATIVE,
          nativeImpl
        );
        this.implementations.set(impl.name, impl);
        logger.info(`Loaded native implementation for ${algorithm}`);
      }
    } catch (error) {
      logger.warn(`Failed to load native ${algorithm}:`, error.message);
    }

    if (this.implementations.size === 0) {
      throw new Error(`No implementations available for ${algorithm}`);
    }
  }

  /**
   * Select best implementation based on preference and availability
   */
  async selectBestImplementation() {
    let selected = null;

    // Try preferred type first
    for (const [name, impl] of this.implementations) {
      if (impl.type === this.options.preferredType && impl.available) {
        selected = impl;
        break;
      }
    }

    // Fall back to any available
    if (!selected) {
      for (const [name, impl] of this.implementations) {
        if (impl.available) {
          selected = impl;
          break;
        }
      }
    }

    if (!selected) {
      throw new Error('No available implementations');
    }

    // Initialize if needed
    if (!selected.initialized) {
      await selected.initialize();
    }

    this.currentImplementation = selected;
    logger.info(`Selected implementation: ${selected.name}`);

    this.emit('implementation:selected', {
      name: selected.name,
      type: selected.type
    });
  }

  /**
   * Start automatic optimization
   */
  startOptimization() {
    if (this.checkTimer) return;

    this.checkTimer = setInterval(() => {
      this.evaluatePerformance();
    }, this.options.checkInterval);

    logger.info('Started automatic algorithm optimization');
  }

  /**
   * Stop automatic optimization
   */
  stopOptimization() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * Evaluate performance and switch if beneficial
   */
  async evaluatePerformance() {
    if (!this.currentImplementation) return;

    const currentPerf = this.currentImplementation.getPerformance();
    
    // Store performance history
    this.performanceHistory.set(Date.now(), {
      implementation: this.currentImplementation.name,
      performance: currentPerf
    });

    // Find best performing implementation
    let bestImpl = this.currentImplementation;
    let bestHashRate = currentPerf.hashRate;

    for (const [name, impl] of this.implementations) {
      if (name === this.currentImplementation.name) continue;
      if (!impl.available || !impl.initialized) continue;

      const perf = impl.getPerformance();
      
      // Need sufficient samples for comparison
      if (perf.samples < 10) continue;

      // Check if significantly better
      if (perf.hashRate > bestHashRate * this.options.switchThreshold) {
        bestImpl = impl;
        bestHashRate = perf.hashRate;
      }
    }

    // Switch if better implementation found
    if (bestImpl !== this.currentImplementation) {
      logger.info(`Switching from ${this.currentImplementation.name} to ${bestImpl.name}`);
      logger.info(`Performance improvement: ${((bestHashRate / currentPerf.hashRate - 1) * 100).toFixed(2)}%`);

      const oldImpl = this.currentImplementation;
      this.currentImplementation = bestImpl;

      this.emit('implementation:switched', {
        from: oldImpl.name,
        to: bestImpl.name,
        improvement: bestHashRate / currentPerf.hashRate
      });
    }
  }

  /**
   * Hash single block
   */
  async hash(blockHeader, nonce, target) {
    if (!this.currentImplementation) {
      throw new Error('No implementation selected');
    }

    return this.currentImplementation.hash(blockHeader, nonce, target);
  }

  /**
   * Batch hash
   */
  async batchHash(blockHeader, startNonce, count, target) {
    if (!this.currentImplementation) {
      throw new Error('No implementation selected');
    }

    return this.currentImplementation.batchHash(blockHeader, startNonce, count, target);
  }

  /**
   * Get current statistics
   */
  getStats() {
    const stats = {
      algorithm: this.options.algorithm,
      current: this.currentImplementation?.name,
      autoOptimize: this.options.autoOptimize,
      implementations: {}
    };

    for (const [name, impl] of this.implementations) {
      stats.implementations[name] = impl.getPerformance();
    }

    return stats;
  }

  /**
   * Benchmark all implementations
   */
  async benchmark(iterations = 10000) {
    logger.info(`Benchmarking ${this.implementations.size} implementations...`);

    const testHeader = Buffer.alloc(80);
    const testTarget = Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex');
    const results = {};

    for (const [name, impl] of this.implementations) {
      if (!impl.available) continue;

      try {
        // Initialize
        await impl.initialize();

        // Reset metrics
        impl.metrics.reset();

        // Run benchmark
        const start = performance.now();
        await impl.batchHash(testHeader, 0, iterations, testTarget);
        const duration = performance.now() - start;

        results[name] = {
          iterations,
          duration,
          hashRate: (iterations / duration) * 1000,
          performance: impl.getPerformance()
        };

        logger.info(`${name}: ${results[name].hashRate.toFixed(2)} H/s`);

      } catch (error) {
        logger.error(`Benchmark failed for ${name}:`, error);
        results[name] = { error: error.message };
      }
    }

    this.emit('benchmark:complete', results);
    return results;
  }

  /**
   * Shutdown coordinator
   */
  async shutdown() {
    this.stopOptimization();
    
    // Cleanup implementations
    for (const [name, impl] of this.implementations) {
      if (impl.instance.destroy) {
        await impl.instance.destroy();
      }
    }

    this.implementations.clear();
    this.currentImplementation = null;

    logger.info('Algorithm coordinator shut down');
  }
}

// Export singleton coordinator
export const algorithmCoordinator = new AlgorithmCoordinator();

export default AlgorithmCoordinator;