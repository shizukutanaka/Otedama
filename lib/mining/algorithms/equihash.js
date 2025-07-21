/**
 * Equihash Mining Algorithm
 * Memory-oriented proof-of-work used by Zcash
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

export class Equihash extends MiningAlgorithm {
    constructor(config = {}) {
        super('equihash', config);
        
        // Equihash parameters (n, k)
        this.n = config.n || 200;
        this.k = config.k || 9;
        this.memoryUsage = Math.pow(2, this.n / (this.k + 1) + this.k);
    }

    async initialize(blockHeight) {
        this.initialized = true;
    }

    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        // Simplified Equihash
        const nonceBuffer = Buffer.alloc(4);
        nonceBuffer.writeUInt32LE(nonce, 0);
        
        const hash = createHash('blake2b256')
            .update(headerBuffer)
            .update(nonceBuffer)
            .digest();
        
        const valid = Buffer.compare(hash, target) <= 0;
        
        return {
            valid,
            hash: hash.toString('hex'),
            nonce
        };
    }

    async validateShare(share) {
        const result = await this.hash(share.blockHeader, share.nonce, share.target);
        
        return {
            valid: result.hash === share.hash && result.valid,
            difficulty: this.calculateDifficulty(result.hash)
        };
    }

    calculateDifficulty(hash) {
        const hashBuffer = Buffer.from(hash, 'hex');
        let difficulty = 0;
        
        for (let i = 0; i < hashBuffer.length; i++) {
            if (hashBuffer[i] === 0) {
                difficulty += 8;
            } else {
                difficulty += Math.floor(Math.log2(256 / hashBuffer[i]));
                break;
            }
        }
        
        return difficulty;
    }

    getInfo() {
        return {
            name: 'Equihash',
            version: '1.0.0',
            description: 'Memory-oriented algorithm used by Zcash',
            coins: ['ZEC', 'ZEN', 'BTG'],
            hardware: ['GPU', 'ASIC'],
            parameters: { n: this.n, k: this.k },
            features: {
                asicResistant: false,
                memoryHard: true
            }
        };
    }
}

export default Equihash;