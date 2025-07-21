/**
 * Consolidated Mining Pool System for Otedama
 * 
 * This module provides a unified interface to all mining pool functionality,
 * consolidating multiple implementations into one coherent solution.
 * 
 * Design principles:
 * - Carmack: High-performance operations with zero-copy buffers
 * - Martin: Clean separation of concerns and modular architecture
 * - Pike: Simple and powerful API
 */

import { EventEmitter } from 'events';
import { UnifiedMiningPool } from './unified-mining-pool.js';
import { getLogger } from '../core/logger.js';
import { inc, observe, set } from '../monitoring/index.js';

// Re-export algorithm definitions for backward compatibility
export { MINING_ALGORITHMS } from './algorithms/index.js';

// Mining pool performance modes
export const PerformanceMode = {
  STANDARD: 'standard',          // Balanced performance
  HIGH_THROUGHPUT: 'high_throughput', // Maximum share processing
  LOW_LATENCY: 'low_latency',    // Minimum response time
  MEMORY_OPTIMIZED: 'memory_optimized' // Reduced memory usage
};

// Pool types
export const PoolType = {
  SOLO: 'solo',
  PPLNS: 'pplns',
  PPS: 'pps',
  FPPS: 'fpps',
  PROP: 'prop'
};

/**
 * Consolidated Mining Pool
 * The main entry point for all mining pool operations
 */
export class ConsolidatedMiningPool extends UnifiedMiningPool {
  constructor(options = {}) {
    // Map performance mode to configuration
    const performanceConfig = getPerformanceConfig(options.performanceMode);
    
    super({
      ...performanceConfig,
      ...options,
      // Ensure features are properly merged
      features: {
        ...performanceConfig.features,
        ...options.features
      },
      difficulty: {
        ...performanceConfig.difficulty,
        ...options.difficulty
      }
    });
    
    this.logger = getLogger('ConsolidatedMiningPool');
    this.performanceMode = options.performanceMode || PerformanceMode.STANDARD;
    
    // Initialize metrics
    this.setupMetrics();
  }

  /**
   * Setup performance metrics
   */
  setupMetrics() {
    // Track key metrics
    this.on('share:accepted', (share) => {
      inc('mining_shares_accepted_total', { 
        algorithm: this.config.algorithm,
        miner: share.minerId 
      });
      observe('mining_share_difficulty', { algorithm: this.config.algorithm }, share.difficulty);
    });

    this.on('share:rejected', (share, reason) => {
      inc('mining_shares_rejected_total', { 
        algorithm: this.config.algorithm,
        reason 
      });
    });

    this.on('block:found', (block) => {
      inc('mining_blocks_found_total', { algorithm: this.config.algorithm });
      observe('mining_block_value', { algorithm: this.config.algorithm }, block.value);
    });

    this.on('miner:connected', () => {
      set('mining_miners_connected', {}, this.miners.size);
    });

    this.on('miner:disconnected', () => {
      set('mining_miners_connected', {}, this.miners.size);
    });

    // Update hashrate metrics periodically
    setInterval(() => {
      set('mining_pool_hashrate', { algorithm: this.config.algorithm }, this.stats.totalHashrate);
      
      // Per-miner hashrate
      for (const [minerId, miner] of this.miners) {
        if (miner.stats?.hashrate) {
          set('mining_miner_hashrate', { 
            miner: minerId,
            algorithm: this.config.algorithm 
          }, miner.stats.hashrate);
        }
      }
    }, 10000);
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const baseStats = super.getStats();
    
    return {
      ...baseStats,
      performanceMode: this.performanceMode,
      algorithm: this.config.algorithm,
      poolType: this.config.payout.scheme,
      features: Object.entries(this.config.features)
        .filter(([_, enabled]) => enabled)
        .map(([feature]) => feature),
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
  }

  /**
   * Switch performance mode
   */
  async switchPerformanceMode(mode) {
    if (!Object.values(PerformanceMode).includes(mode)) {
      throw new Error(`Invalid performance mode: ${mode}`);
    }

    this.logger.info(`Switching performance mode from ${this.performanceMode} to ${mode}`);
    
    const newConfig = getPerformanceConfig(mode);
    
    // Update configuration
    this.config = {
      ...this.config,
      ...newConfig,
      features: {
        ...this.config.features,
        ...newConfig.features
      }
    };
    
    this.performanceMode = mode;
    
    // Restart affected components
    await this.restartComponents();
    
    this.emit('performance:mode:changed', mode);
  }

  /**
   * Restart components after config change
   */
  async restartComponents() {
    // Restart worker threads with new config
    if (this.workerPool) {
      await this.workerPool.restart(this.config.workerThreads);
    }

    // Reconfigure modules
    if (this.vardiffManager) {
      this.vardiffManager.configure(this.config.difficulty);
    }

    if (this.loadBalancer) {
      this.loadBalancer.configure({
        maxConnectionsPerNode: this.config.maxConnections / this.config.workerThreads
      });
    }
  }
}

/**
 * Get performance configuration based on mode
 */
function getPerformanceConfig(mode) {
  switch (mode) {
    case PerformanceMode.HIGH_THROUGHPUT:
      return {
        workerThreads: 8,
        shareProcessBatchSize: 5000,
        gcInterval: 600000, // 10 minutes
        features: {
          vardiff: true,
          loadBalancing: true,
          antihop: false, // Disable to reduce overhead
          hashratePrediction: false
        },
        difficulty: {
          retargetTime: 120, // Slower retargeting
          variancePercent: 50 // Allow more variance
        }
      };

    case PerformanceMode.LOW_LATENCY:
      return {
        workerThreads: 4,
        shareProcessBatchSize: 100,
        gcInterval: 60000, // 1 minute
        features: {
          vardiff: true,
          loadBalancing: true,
          antihop: true,
          hashratePrediction: true
        },
        difficulty: {
          retargetTime: 30, // Fast retargeting
          variancePercent: 20 // Tight variance
        }
      };

    case PerformanceMode.MEMORY_OPTIMIZED:
      return {
        workerThreads: 2,
        shareProcessBatchSize: 500,
        gcInterval: 30000, // 30 seconds
        maxConnections: 10000, // Limit connections
        features: {
          vardiff: true,
          loadBalancing: false,
          antihop: false,
          hashratePrediction: false,
          hardwareValidation: false
        },
        difficulty: {
          retargetTime: 60,
          variancePercent: 30
        }
      };

    default: // STANDARD
      return {
        workerThreads: 4,
        shareProcessBatchSize: 1000,
        gcInterval: 300000, // 5 minutes
        features: {
          vardiff: true,
          loadBalancing: true,
          antihop: false,
          hashratePrediction: false,
          hardwareValidation: true
        },
        difficulty: {
          retargetTime: 90,
          variancePercent: 30
        }
      };
  }
}

// Create singleton instance
let poolInstance = null;

/**
 * Get or create mining pool instance
 */
export function getMiningPool(options = {}) {
  if (!poolInstance) {
    poolInstance = new ConsolidatedMiningPool(options);
    
    // Auto-initialize if not disabled
    if (options.autoInitialize !== false) {
      poolInstance.initialize().catch(error => {
        console.error('Failed to initialize mining pool:', error);
      });
    }
  }
  
  return poolInstance;
}

// Convenience exports
export const pool = getMiningPool();

// Direct method exports for compatibility
export const startPool = () => pool.start();
export const stopPool = () => pool.stop();
export const addMiner = (miner) => pool.addMiner(miner);
export const removeMiner = (minerId) => pool.removeMiner(minerId);
export const submitShare = (minerId, share) => pool.submitShare(minerId, share);

// Re-export commonly used classes
export { 
  ShareValidator,
  DifficultyTracker,
  ProfitSwitcher,
  MergeMiningHandler
} from './unified-mining-pool.js';

// Default export
export default ConsolidatedMiningPool;