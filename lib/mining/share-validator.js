/**
 * Share Validator Module
 * Provides optimized share validation with caching and batching
 */

import OptimizedShareValidator from './share-validator-optimized.js';

export class ShareValidator extends OptimizedShareValidator {
    constructor(config = {}) {
        // Use optimized version with sensible defaults
        super({
            workerCount: config.workerCount || 4,
            batchSize: config.batchSize || 100,
            cacheSize: config.cacheSize || 10000,
            enableCache: config.enableCache !== false,
            enableBatching: config.enableBatching !== false,
            ...config
        });
    }
    
    /**
     * Legacy compatibility method
     */
    async isValid(share, job, difficulty) {
        const result = await this.validateShare(
            share,
            job,
            difficulty,
            job.networkDifficulty || difficulty * 1000
        );
        
        return result.valid;
    }
}

export default ShareValidator;