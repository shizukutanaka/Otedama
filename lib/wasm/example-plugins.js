/**
 * Example WebAssembly Plugins for Otedama
 * Demonstrating plugin capabilities
 * 
 * Design principles:
 * - Carmack: Example performance optimizations
 * - Martin: Clean example implementations
 * - Pike: Simple example plugins
 */

import { WasmPluginSystem, PluginCapability } from './plugin-system.js';
import { WasmPluginLoader } from './plugin-loader.js';
import { WasmPluginSDK, PluginTemplates } from './plugin-sdk.js';
import { logger } from '../core/logger.js';

/**
 * Example: Hash rate optimizer plugin
 */
export const HASHRATE_OPTIMIZER_MANIFEST = {
  id: 'hashrate_optimizer',
  name: 'Hashrate Optimizer',
  version: '1.0.0',
  author: 'Otedama Team',
  description: 'Optimizes mining hashrate using ML predictions',
  capabilities: [PluginCapability.OPTIMIZATION, PluginCapability.CUSTOM_MINING],
  exports: ['optimize_hashrate', 'predict_difficulty', 'tune_parameters'],
  imports: {
    host: ['log_info', 'get_timestamp', 'get_random'],
    env: ['memory']
  },
  config: {
    learningRate: 0.01,
    windowSize: 100,
    updateInterval: 60000
  }
};

/**
 * Example: Data transformer plugin
 */
export const DATA_TRANSFORMER_MANIFEST = {
  id: 'data_transformer',
  name: 'Data Transformer',
  version: '1.0.0',
  author: 'Otedama Team',
  description: 'Transforms and normalizes mining data',
  capabilities: [PluginCapability.TRANSFORMATION, PluginCapability.VALIDATION],
  exports: ['transform', 'normalize', 'validate', 'aggregate'],
  imports: {
    host: ['log_info', 'log_error', 'allocate', 'deallocate'],
    env: ['memory']
  },
  config: {
    normalizationMethod: 'zscore',
    validationRules: ['range', 'type', 'format']
  }
};

/**
 * Example: Performance analyzer plugin
 */
export const PERFORMANCE_ANALYZER_MANIFEST = {
  id: 'performance_analyzer',
  name: 'Performance Analyzer',
  version: '1.0.0',
  author: 'Otedama Team',
  description: 'Analyzes system performance and provides insights',
  capabilities: [PluginCapability.ANALYSIS, PluginCapability.COMPUTATION],
  exports: ['analyze', 'benchmark', 'profile', 'report'],
  imports: {
    host: ['log_info', 'perf_start', 'perf_end', 'hash_sha256'],
    env: ['memory']
  },
  config: {
    sampleRate: 1000,
    metricsEnabled: true,
    reportFormat: 'json'
  }
};

/**
 * Example plugin usage
 */
export class PluginExamples {
  constructor() {
    this.pluginSystem = null;
    this.pluginLoader = null;
    this.sdk = null;
  }
  
  /**
   * Initialize plugin system with examples
   */
  async initialize() {
    // Create plugin system
    this.pluginSystem = new WasmPluginSystem({
      pluginDirs: ['./plugins', './examples/plugins'],
      sandbox: {
        memory: {
          initial: 256,
          maximum: 1024
        },
        cpu: {
          instructionLimit: 1000000000,
          timeout: 30000
        }
      },
      cache: {
        enabled: true,
        maxSize: 50 * 1024 * 1024 // 50MB
      }
    });
    
    // Create plugin loader
    this.pluginLoader = new WasmPluginLoader(this.pluginSystem, {
      watchDirectories: true,
      hotReload: true,
      autoRecover: true
    });
    
    // Create SDK
    this.sdk = new WasmPluginSDK({
      debug: false,
      wasmOpt: true
    });
    
    // Start systems
    await this.pluginLoader.start();
    
    logger.info('Plugin examples initialized');
  }
  
  /**
   * Example: Using hashrate optimizer
   */
  async exampleHashrateOptimization() {
    console.log('\n=== Hashrate Optimizer Example ===');
    
    try {
      // Execute optimization
      const result = await this.pluginSystem.execute(
        'hashrate_optimizer',
        'optimize_hashrate',
        {
          currentHashrate: 1000000, // 1 MH/s
          temperature: 65,
          powerUsage: 150,
          algorithm: 'sha256'
        }
      );
      
      console.log('Optimization result:', result);
      
      // Predict difficulty
      const prediction = await this.pluginSystem.execute(
        'hashrate_optimizer',
        'predict_difficulty',
        {
          historicalData: [
            { timestamp: Date.now() - 3600000, difficulty: 1000 },
            { timestamp: Date.now() - 1800000, difficulty: 1050 },
            { timestamp: Date.now(), difficulty: 1100 }
          ]
        }
      );
      
      console.log('Difficulty prediction:', prediction);
      
      // Tune parameters
      const tuning = await this.pluginSystem.execute(
        'hashrate_optimizer',
        'tune_parameters',
        {
          targetHashrate: 1200000,
          constraints: {
            maxTemperature: 75,
            maxPower: 200
          }
        }
      );
      
      console.log('Tuning result:', tuning);
      
    } catch (error) {
      console.error('Hashrate optimization failed:', error);
    }
  }
  
  /**
   * Example: Using data transformer
   */
  async exampleDataTransformation() {
    console.log('\n=== Data Transformer Example ===');
    
    try {
      // Transform data
      const transformed = await this.pluginSystem.execute(
        'data_transformer',
        'transform',
        {
          operation: 'map',
          data: [
            { value: 100, timestamp: Date.now() },
            { value: 150, timestamp: Date.now() + 1000 },
            { value: 120, timestamp: Date.now() + 2000 }
          ],
          mapping: {
            value: 'hashrate',
            timestamp: 'time'
          }
        }
      );
      
      console.log('Transformed data:', transformed);
      
      // Normalize data
      const normalized = await this.pluginSystem.execute(
        'data_transformer',
        'normalize',
        {
          data: [100, 200, 150, 300, 250],
          method: 'minmax'
        }
      );
      
      console.log('Normalized data:', normalized);
      
      // Validate data
      const validation = await this.pluginSystem.execute(
        'data_transformer',
        'validate',
        {
          data: { hashrate: 1000000, temperature: 65 },
          schema: {
            hashrate: { type: 'number', min: 0, max: 10000000 },
            temperature: { type: 'number', min: 0, max: 100 }
          }
        }
      );
      
      console.log('Validation result:', validation);
      
    } catch (error) {
      console.error('Data transformation failed:', error);
    }
  }
  
  /**
   * Example: Using performance analyzer
   */
  async examplePerformanceAnalysis() {
    console.log('\n=== Performance Analyzer Example ===');
    
    try {
      // Analyze performance
      const analysis = await this.pluginSystem.execute(
        'performance_analyzer',
        'analyze',
        {
          metrics: {
            cpu: [45, 50, 48, 52, 55],
            memory: [1024, 1100, 1050, 1200, 1150],
            network: [100, 120, 110, 130, 125]
          },
          period: 'last_hour'
        }
      );
      
      console.log('Performance analysis:', analysis);
      
      // Benchmark operation
      const benchmark = await this.pluginSystem.execute(
        'performance_analyzer',
        'benchmark',
        {
          operation: 'hash_calculation',
          iterations: 10000,
          data: new Array(100).fill(0).map(() => Math.random())
        }
      );
      
      console.log('Benchmark result:', benchmark);
      
      // Generate report
      const report = await this.pluginSystem.execute(
        'performance_analyzer',
        'report',
        {
          includeMetrics: ['cpu', 'memory', 'hashrate'],
          format: 'summary',
          period: { start: Date.now() - 3600000, end: Date.now() }
        }
      );
      
      console.log('Performance report:', report);
      
    } catch (error) {
      console.error('Performance analysis failed:', error);
    }
  }
  
  /**
   * Example: Plugin pipeline
   */
  async examplePluginPipeline() {
    console.log('\n=== Plugin Pipeline Example ===');
    
    try {
      const pipeline = [
        {
          pluginId: 'data_transformer',
          functionName: 'normalize',
          transform: (result) => ({ data: result.normalized })
        },
        {
          pluginId: 'performance_analyzer',
          functionName: 'analyze',
          transform: (result) => ({ ...result.data, analysis: result })
        },
        {
          pluginId: 'hashrate_optimizer',
          functionName: 'optimize_hashrate',
          transform: (result) => result
        }
      ];
      
      const initialData = {
        data: [1000000, 1100000, 950000, 1050000],
        method: 'zscore'
      };
      
      const result = await this.pluginSystem.executePipeline(pipeline, initialData);
      
      console.log('Pipeline result:', result);
      
    } catch (error) {
      console.error('Pipeline execution failed:', error);
    }
  }
  
  /**
   * Example: Parallel plugin execution
   */
  async exampleParallelExecution() {
    console.log('\n=== Parallel Execution Example ===');
    
    try {
      const executions = [
        {
          pluginId: 'hashrate_optimizer',
          functionName: 'predict_difficulty',
          args: { historicalData: [] }
        },
        {
          pluginId: 'data_transformer',
          functionName: 'validate',
          args: { data: { test: 123 }, schema: {} }
        },
        {
          pluginId: 'performance_analyzer',
          functionName: 'benchmark',
          args: { operation: 'test', iterations: 100 }
        }
      ];
      
      const results = await this.pluginSystem.executeParallel(executions);
      
      console.log('Parallel execution results:', results);
      
    } catch (error) {
      console.error('Parallel execution failed:', error);
    }
  }
  
  /**
   * Example: Creating custom plugin
   */
  async exampleCreateCustomPlugin() {
    console.log('\n=== Custom Plugin Creation Example ===');
    
    try {
      // Create custom mining plugin
      const pluginInfo = await this.sdk.createPlugin(
        'custom_miner',
        PluginTemplates.MINING,
        './examples/plugins'
      );
      
      console.log('Plugin created:', pluginInfo);
      
      // Build plugin
      const packagePath = await this.sdk.buildPlugin(pluginInfo.path, {
        optimize: true,
        debug: false
      });
      
      console.log('Plugin built:', packagePath);
      
      // Load plugin
      await this.pluginLoader.loadPlugin(pluginInfo.path);
      
      console.log('Plugin loaded successfully');
      
      // Use custom plugin
      const miningResult = await this.pluginSystem.execute(
        'custom_miner',
        'mine',
        {
          algorithm: 'custom',
          difficulty: 4,
          data: Buffer.from('test data').toJSON().data,
          previous_hash: '0000000000000000'
        }
      );
      
      console.log('Mining result:', miningResult);
      
    } catch (error) {
      console.error('Custom plugin creation failed:', error);
    }
  }
  
  /**
   * Example: Plugin error handling
   */
  async exampleErrorHandling() {
    console.log('\n=== Error Handling Example ===');
    
    // Listen for plugin errors
    this.pluginSystem.on('plugin:error', (event) => {
      console.error('Plugin error:', event);
    });
    
    this.pluginLoader.on('plugin:failed', (event) => {
      console.error('Plugin load failed:', event);
    });
    
    try {
      // Try to execute non-existent function
      await this.pluginSystem.execute(
        'hashrate_optimizer',
        'non_existent_function',
        {}
      );
    } catch (error) {
      console.log('Expected error caught:', error.message);
    }
    
    try {
      // Try to load invalid plugin
      await this.pluginLoader.loadPlugin('./invalid/path/plugin.wasm');
    } catch (error) {
      console.log('Expected load error caught:', error.message);
    }
  }
  
  /**
   * Run all examples
   */
  async runAllExamples() {
    await this.initialize();
    
    // Note: These are examples - actual WASM plugins would need to be compiled
    console.log('\n=== WebAssembly Plugin System Examples ===');
    console.log('Note: These examples demonstrate the API usage.');
    console.log('Actual WASM plugins need to be compiled from Rust/C++ source.');
    
    await this.exampleHashrateOptimization();
    await this.exampleDataTransformation();
    await this.examplePerformanceAnalysis();
    await this.examplePluginPipeline();
    await this.exampleParallelExecution();
    await this.exampleErrorHandling();
    
    // Get system status
    const status = this.pluginSystem.getStatus();
    console.log('\n=== Plugin System Status ===');
    console.log('Loaded plugins:', status.plugins.length);
    console.log('Total executions:', status.metrics.totalExecutions);
    console.log('Cache hits:', status.metrics.cacheHits);
    console.log('Cache misses:', status.metrics.cacheMisses);
    
    // Cleanup
    await this.pluginSystem.destroy();
    await this.pluginLoader.stop();
  }
}

// Export for use in other modules
export default PluginExamples;