/**
 * Mining Pool Backward Compatibility Layer
 * 
 * Provides compatibility wrappers for legacy mining pool implementations
 * to ensure existing code continues to work during migration.
 */

import { getMiningPool, ConsolidatedMiningPool, PoolType } from './index.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('MiningCompatibility');

// Warn about deprecated usage
const deprecationWarning = (className) => {
  logger.warn(`${className} is deprecated. Please migrate to ConsolidatedMiningPool from lib/mining/index.js`);
};

/**
 * Legacy MiningPoolOptimized wrapper
 */
export class MiningPoolOptimized extends ConsolidatedMiningPool {
  constructor(options = {}) {
    deprecationWarning('MiningPoolOptimized');
    
    // Map old options to new format
    const mappedOptions = {
      ...options,
      coinType: options.currency || options.coinType,
      algorithm: options.algorithm || 'sha256',
      payout: {
        scheme: options.payoutScheme || PoolType.PPLNS,
        interval: options.payoutInterval,
        minPayout: options.minPayout
      },
      features: {
        stratumV2: options.enableStratumV2,
        mergeMining: options.enableMergeMining,
        vardiff: options.enableVardiff !== false,
        loadBalancing: options.enableLoadBalancing !== false
      }
    };
    
    super(mappedOptions);
  }

  // Legacy method mappings
  async init() {
    return this.initialize();
  }

  addWorker(worker) {
    return this.addMiner(worker);
  }

  removeWorker(workerId) {
    return this.removeMiner(workerId);
  }

  processShare(workerId, share) {
    return this.submitShare(workerId, share);
  }

  getCurrentDifficulty() {
    return this.stats.networkDifficulty;
  }

  getWorkers() {
    return Array.from(this.miners.values());
  }

  getWorkerCount() {
    return this.miners.size;
  }

  getTotalHashrate() {
    return this.stats.totalHashrate;
  }
}

/**
 * Legacy SmartMiningPool wrapper
 */
export class SmartMiningPool extends ConsolidatedMiningPool {
  constructor(options = {}) {
    deprecationWarning('SmartMiningPool');
    
    super({
      ...options,
      features: {
        ...options.features,
        profitSwitching: true,
        hashratePrediction: true,
        hardwareValidation: true
      }
    });
  }

  async switchAlgorithm(algorithm) {
    logger.warn('switchAlgorithm: Please use profit switcher module directly');
    if (this.profitSwitcher) {
      return this.profitSwitcher.switchToAlgorithm(algorithm);
    }
  }

  predictHashrate(minerId) {
    logger.warn('predictHashrate: Please use hashrate prediction module directly');
    if (this.hashratePrediction) {
      return this.hashratePrediction.predict(minerId);
    }
    return 0;
  }
}

/**
 * Legacy PoolOptimizer wrapper
 */
export class PoolOptimizer {
  constructor(pool, options = {}) {
    deprecationWarning('PoolOptimizer');
    this.pool = pool;
    this.logger = getLogger('PoolOptimizer');
  }

  async optimize() {
    this.logger.warn('optimize: Optimization is now automatic in ConsolidatedMiningPool');
    // No-op - optimization is built into the consolidated pool
    return {
      optimized: true,
      message: 'Pool optimization is automatic in the new system'
    };
  }

  getRecommendations() {
    return {
      workerThreads: this.pool.config.workerThreads,
      shareProcessBatchSize: this.pool.config.shareProcessBatchSize,
      difficulty: this.pool.config.difficulty
    };
  }
}

/**
 * Legacy UnifiedMiningPool wrapper
 * (UnifiedMiningPool is the base class, so just re-export with deprecation)
 */
export { UnifiedMiningPool } from './unified-mining-pool.js';

/**
 * Legacy MiningPool wrapper (from lib/mining-pool.js)
 */
export class MiningPool extends ConsolidatedMiningPool {
  constructor(options = {}) {
    deprecationWarning('MiningPool');
    super(options);
  }

  // Map old static methods
  static getSupportedAlgorithms() {
    const pool = getMiningPool();
    return pool.getSupportedAlgorithms();
  }

  static async createPool(options) {
    const pool = new ConsolidatedMiningPool(options);
    await pool.initialize();
    return pool;
  }
}

// Export algorithm constants for backward compatibility
export const ALGORITHMS = {
  SHA256: 'sha256',
  SCRYPT: 'scrypt',
  ETHASH: 'ethash',
  RANDOMX: 'randomx',
  KAWPOW: 'kawpow',
  X11: 'x11',
  EQUIHASH: 'equihash',
  AUTOLYKOS2: 'autolykos2',
  KHEAVYHASH: 'kheavyhash',
  BLAKE3: 'blake3'
};

// Export pool schemes for backward compatibility
export const POOL_SCHEMES = {
  SOLO: 'solo',
  PPLNS: 'pplns',
  PPS: 'pps',
  FPPS: 'fpps',
  PROP: 'prop'
};

// Default export for backward compatibility
export default MiningPoolOptimized;