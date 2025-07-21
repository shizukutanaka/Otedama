/**
 * Order Book Factory
 * Provides centralized creation of different order book implementations
 * Eliminates duplicate instantiation logic across the codebase
 * 
 * Design principles:
 * - Carmack: Efficient object creation with minimal overhead
 * - Martin: Factory pattern with clean configuration
 * - Pike: Simple interface for complex creation logic
 */

/**
 * Available order book implementation types
 */
export const OrderBookType = {
  STANDARD: 'standard',
  OPTIMIZED: 'optimized', 
  HIGH_PERFORMANCE: 'high_performance',
  ZERO_COPY: 'zero_copy',
  LOCK_FREE: 'lock_free'
};

/**
 * Default configuration for each order book type
 */
const DEFAULT_CONFIGS = {
  [OrderBookType.STANDARD]: {
    maxOrders: 10000,
    maxPriceLevels: 1000,
    enableStatistics: true,
    enableEvents: true
  },
  
  [OrderBookType.OPTIMIZED]: {
    maxOrders: 50000,
    maxPriceLevels: 2000,
    enableStatistics: true,
    enableEvents: true,
    useObjectPools: true,
    batchSize: 1000
  },
  
  [OrderBookType.HIGH_PERFORMANCE]: {
    maxOrders: 100000,
    maxPriceLevels: 5000,
    enableStatistics: true,
    enableEvents: false, // Disabled for max performance
    useRedBlackTree: true,
    useObjectPools: true,
    batchSize: 5000
  },
  
  [OrderBookType.ZERO_COPY]: {
    maxOrders: 200000,
    maxPriceLevels: 10000,
    enableStatistics: false, // Disabled for zero-copy
    enableEvents: false,
    bufferSize: 1024 * 1024, // 1MB buffer
    useSharedArrayBuffer: true
  },
  
  [OrderBookType.LOCK_FREE]: {
    maxOrders: 500000,
    maxPriceLevels: 20000,
    enableStatistics: false,
    enableEvents: false,
    concurrencyLevel: 16,
    useAtomicOperations: true,
    spinWaitTime: 100
  }
};

/**
 * Performance characteristics for each implementation type
 */
export const PerformanceProfiles = {
  [OrderBookType.STANDARD]: {
    throughput: 'Low (1K ops/sec)',
    latency: 'High (>1ms)',
    memoryUsage: 'Low',
    complexity: 'Simple',
    useCase: 'Development, Testing'
  },
  
  [OrderBookType.OPTIMIZED]: {
    throughput: 'Medium (10K ops/sec)',
    latency: 'Medium (~500μs)',
    memoryUsage: 'Medium',
    complexity: 'Moderate',
    useCase: 'Production, Medium Volume'
  },
  
  [OrderBookType.HIGH_PERFORMANCE]: {
    throughput: 'High (50K ops/sec)',
    latency: 'Low (~100μs)',
    memoryUsage: 'High',
    complexity: 'Advanced',
    useCase: 'High Frequency Trading'
  },
  
  [OrderBookType.ZERO_COPY]: {
    throughput: 'Very High (100K ops/sec)',
    latency: 'Very Low (~50μs)',
    memoryUsage: 'Fixed',
    complexity: 'Expert',
    useCase: 'Ultra-Low Latency'
  },
  
  [OrderBookType.LOCK_FREE]: {
    throughput: 'Ultra High (500K+ ops/sec)',
    latency: 'Ultra Low (~10μs)',
    memoryUsage: 'Variable',
    complexity: 'Expert',
    useCase: 'Extreme Performance'
  }
};

/**
 * Order Book Factory class
 */
export class OrderBookFactory {
  constructor() {
    this.implementations = new Map();
    this.loadedTypes = new Set();
  }
  
  /**
   * Register an order book implementation
   */
  registerImplementation(type, implementationClass) {
    this.implementations.set(type, implementationClass);
  }
  
  /**
   * Create order book instance
   */
  async create(type, symbol, options = {}) {
    if (!Object.values(OrderBookType).includes(type)) {
      throw new Error(`Unknown order book type: ${type}`);
    }
    
    // Lazy load implementation
    const Implementation = await this.loadImplementation(type);
    
    // Merge default configuration with custom options
    const config = {
      ...DEFAULT_CONFIGS[type],
      ...options
    };
    
    // Create instance
    const instance = new Implementation(symbol, config);
    
    // Add metadata
    instance._type = type;
    instance._createdAt = Date.now();
    instance._performanceProfile = PerformanceProfiles[type];
    
    return instance;
  }
  
  /**
   * Create multiple order books for different symbols
   */
  async createMultiple(type, symbols, options = {}) {
    const orderBooks = new Map();
    
    for (const symbol of symbols) {
      const orderBook = await this.create(type, symbol, options);
      orderBooks.set(symbol, orderBook);
    }
    
    return orderBooks;
  }
  
  /**
   * Create order book with automatic type selection based on requirements
   */
  async createOptimal(symbol, requirements = {}) {
    const {
      expectedThroughput = 1000,    // ops/sec
      maxLatency = 1000,           // microseconds
      maxMemoryMB = 100,           // MB
      needsStatistics = true,
      needsEvents = true,
      concurrency = 1              // concurrent threads
    } = requirements;
    
    let selectedType = OrderBookType.STANDARD;
    
    // Select based on throughput requirements
    if (expectedThroughput > 100000) {
      selectedType = concurrency > 1 ? OrderBookType.LOCK_FREE : OrderBookType.ZERO_COPY;
    } else if (expectedThroughput > 10000) {
      selectedType = OrderBookType.HIGH_PERFORMANCE;
    } else if (expectedThroughput > 1000) {
      selectedType = OrderBookType.OPTIMIZED;
    }
    
    // Adjust for latency constraints
    if (maxLatency < 50 && selectedType !== OrderBookType.LOCK_FREE) {
      selectedType = OrderBookType.ZERO_COPY;
    }
    
    // Adjust for feature requirements
    if ((needsStatistics || needsEvents) && 
        (selectedType === OrderBookType.ZERO_COPY || selectedType === OrderBookType.LOCK_FREE)) {
      selectedType = OrderBookType.HIGH_PERFORMANCE;
    }
    
    return await this.create(selectedType, symbol, requirements);
  }
  
  /**
   * Lazy load implementation class
   */
  async loadImplementation(type) {
    if (this.implementations.has(type)) {
      return this.implementations.get(type);
    }
    
    let Implementation;
    
    try {
      switch (type) {
        case OrderBookType.STANDARD:
          const { OrderBook } = await import('../order-book.js');
          Implementation = OrderBook;
          break;
          
        case OrderBookType.OPTIMIZED:
          const { OptimizedOrderBook } = await import('../optimized-order-book.js');
          Implementation = OptimizedOrderBook;
          break;
          
        case OrderBookType.HIGH_PERFORMANCE:
          const { HighPerformanceOrderBook } = await import('../high-performance-order-book.js');
          Implementation = HighPerformanceOrderBook;
          break;
          
        case OrderBookType.ZERO_COPY:
          const { ZeroCopyOrderBook } = await import('../zero-copy-order-book.js');
          Implementation = ZeroCopyOrderBook;
          break;
          
        case OrderBookType.LOCK_FREE:
          const { LockFreeOrderBook } = await import('../lock-free-order-book.js');
          Implementation = LockFreeOrderBook;
          break;
          
        default:
          throw new Error(`Unknown order book type: ${type}`);
      }
      
      this.implementations.set(type, Implementation);
      this.loadedTypes.add(type);
      
      return Implementation;
      
    } catch (error) {
      throw new Error(`Failed to load order book implementation '${type}': ${error.message}`);
    }
  }
  
  /**
   * Get available types
   */
  getAvailableTypes() {
    return Object.values(OrderBookType);
  }
  
  /**
   * Get performance profile for a type
   */
  getPerformanceProfile(type) {
    return PerformanceProfiles[type];
  }
  
  /**
   * Get default configuration for a type
   */
  getDefaultConfig(type) {
    return { ...DEFAULT_CONFIGS[type] };
  }
  
  /**
   * Recommend order book type based on use case
   */
  recommendType(useCase) {
    const recommendations = {
      'development': OrderBookType.STANDARD,
      'testing': OrderBookType.STANDARD,
      'production': OrderBookType.OPTIMIZED,
      'high-volume': OrderBookType.HIGH_PERFORMANCE,
      'hft': OrderBookType.HIGH_PERFORMANCE,
      'ultra-low-latency': OrderBookType.ZERO_COPY,
      'extreme-performance': OrderBookType.LOCK_FREE,
      'multi-threaded': OrderBookType.LOCK_FREE
    };
    
    return recommendations[useCase.toLowerCase()] || OrderBookType.STANDARD;
  }
  
  /**
   * Benchmark different implementations
   */
  async benchmark(symbol, testConfig = {}) {
    const {
      orderCount = 10000,
      iterations = 5,
      types = Object.values(OrderBookType)
    } = testConfig;
    
    const results = {};
    
    for (const type of types) {
      try {
        const orderBook = await this.create(type, symbol);
        const result = await this.benchmarkImplementation(orderBook, orderCount, iterations);
        results[type] = result;
      } catch (error) {
        results[type] = { error: error.message };
      }
    }
    
    return results;
  }
  
  /**
   * Benchmark single implementation
   */
  async benchmarkImplementation(orderBook, orderCount, iterations) {
    const results = [];
    
    for (let i = 0; i < iterations; i++) {
      const startTime = process.hrtime.bigint();
      
      // Add orders
      for (let j = 0; j < orderCount; j++) {
        try {
          orderBook.addOrder({
            id: `bench_${i}_${j}`,
            userId: `user_${j % 100}`,
            symbol: orderBook.symbol,
            side: j % 2 === 0 ? 'buy' : 'sell',
            type: 'limit',
            amount: '1000000000000000000', // 1 token
            price: (10000 + (j % 1000)).toString() // Varying prices
          });
        } catch (error) {
          // Continue on individual order failures
        }
      }
      
      const endTime = process.hrtime.bigint();
      const durationNs = Number(endTime - startTime);
      
      results.push({
        iteration: i + 1,
        orderCount: orderBook.getStats().activeOrders,
        durationMs: durationNs / 1_000_000,
        throughputOps: (orderCount * 1_000_000_000) / durationNs
      });
      
      // Clean up for next iteration
      orderBook.clear();
    }
    
    // Calculate averages
    const avgDuration = results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;
    const avgThroughput = results.reduce((sum, r) => sum + r.throughputOps, 0) / results.length;
    
    return {
      results,
      averages: {
        durationMs: avgDuration,
        throughputOps: Math.round(avgThroughput),
        latencyMicros: (avgDuration * 1000) / orderCount
      }
    };
  }
}

/**
 * Global factory instance
 */
const globalFactory = new OrderBookFactory();

/**
 * Convenience functions using global factory
 */
export const createOrderBook = (type, symbol, options) => globalFactory.create(type, symbol, options);
export const createOptimalOrderBook = (symbol, requirements) => globalFactory.createOptimal(symbol, requirements);
export const createMultipleOrderBooks = (type, symbols, options) => globalFactory.createMultiple(type, symbols, options);
export const recommendOrderBookType = (useCase) => globalFactory.recommendType(useCase);
export const getPerformanceProfile = (type) => globalFactory.getPerformanceProfile(type);
export const benchmarkOrderBooks = (symbol, testConfig) => globalFactory.benchmark(symbol, testConfig);

export default {
  OrderBookFactory,
  OrderBookType,
  PerformanceProfiles,
  createOrderBook,
  createOptimalOrderBook,
  createMultipleOrderBooks,
  recommendOrderBookType,
  getPerformanceProfile,
  benchmarkOrderBooks
};