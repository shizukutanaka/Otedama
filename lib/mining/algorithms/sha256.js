/**
 * SHA256 Mining Algorithm
 * Uses optimized implementation for better performance
 */

import { SHA256Optimized } from './sha256-optimized.js';

// Export the optimized version as SHA256
export class SHA256 extends SHA256Optimized {
    constructor(config = {}) {
        super(config);
    }
}

export default SHA256;