/**
 * Mining Module - Otedama
 * Enterprise-grade mining pool implementation
 * 
 * Design:
 * - Carmack: High-performance share validation
 * - Martin: Clean mining architecture
 * - Pike: Simple but effective mining protocols
 */

// Enhanced P2P Mining Pool - National scale
export {
  EnhancedP2PMiningPool,
  PaymentScheme
} from './enhanced-p2p-mining-pool.js';

// Core mining components
export { P2PMiningPool } from './p2p-mining-pool.js';
export { ShareValidator } from './share-validator.js';
export { MinerManager } from './miner-manager.js';
export { PaymentProcessor } from './payment-processor.js';
export { MiningClient } from './mining-client.js';

// Mining algorithms
export * from './algorithms/index.js';

// Re-export mining error
export { MiningError } from '../core/error-handler-unified.js';

// Default export
export default {
  EnhancedP2PMiningPool,
  P2PMiningPool,
  ShareValidator,
  MinerManager,
  PaymentProcessor,
  MiningClient,
  PaymentScheme
};
