/**
 * Mining Pool Core for Otedama
 * 
 * DEPRECATED: This file is maintained for backward compatibility only.
 * Please use lib/mining/index.js for the consolidated mining pool implementation.
 */

import { getLogger } from './core/logger.js';

const logger = getLogger('MiningPool');
logger.warn('lib/mining-pool.js is deprecated. Please use lib/mining/index.js');

// Re-export from consolidated mining system
export { getMiningPool, ConsolidatedMiningPool as MiningPool, MINING_ALGORITHMS as ALGORITHMS } from './mining/index.js';
export { ALGO_CURRENCY_MAP } from './mining/constants.js';

// Re-export for backward compatibility
export { MiningPool as LegacyMiningPool } from './mining/compatibility.js';

// Keep the old class definition for reference
/*
export class MiningPool extends UnifiedMiningPool {
    constructor(config = {}) {
        // Transform config to unified format
        const unifiedConfig = {
            ...config,
            features: {
                stratumV2: config.stratumV2 || false,
                mergeMining: config.mergeMining || false,
                proxy: config.proxy || false,
                vardiff: config.vardiff !== false,
                antihop: config.antihop || false,
                loadBalancing: config.loadBalancing !== false,
                hashratePrediction: config.hashratePrediction || false,
                hardwareValidation: config.hardwareValidation !== false,
                ...config.features
            }
        };
        
        super(unifiedConfig);
        
        // Maintain backward compatibility
        this.logger = console; // Simple logger
        this.payoutMode = config.payoutMode || 'DIRECT';
    }
    
    // Backward compatibility methods
    async initialize() {
        return this.start();
    }
    
    getPoolStats() {
        return this.getStats();
    }
    
    // Legacy method names
    connectMiner(socket) {
        return this.handleNewConnection(socket);
    }
    
    disconnectMiner(minerId) {
        const miner = this.miners.get(minerId);
        if (miner) {
            miner.socket.destroy();
        }
    }
}

// Default export for backward compatibility
export default MiningPool;
*/

// Export getMiningPool as default
export { getMiningPool as default } from './mining/index.js';