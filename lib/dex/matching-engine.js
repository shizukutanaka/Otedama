/**
 * Matching Engine for Otedama DEX
 * Uses optimized implementation for better performance
 */

import { OptimizedMatchingEngine } from './matching-engine-optimized.js';

// Re-export types and enums
export { MatchingAlgorithm } from './matching-engine-optimized.js';
export { Trade } from './order-book.js';

// Export the optimized version as MatchingEngine
export class MatchingEngine extends OptimizedMatchingEngine {
    constructor(orderBook, options = {}) {
        super(orderBook, options);
    }
}

export default MatchingEngine;