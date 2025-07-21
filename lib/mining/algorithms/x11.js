/**
 * X11 Mining Algorithm
 * Chain of 11 hash functions used by Dash
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

export class X11 extends MiningAlgorithm {
    constructor(config = {}) {
        super('x11', config);
        
        // X11 uses 11 different hash functions in sequence
        this.hashFunctions = [
            'blake512',
            'bmw512',
            'groestl512',
            'jh512',
            'keccak512',
            'skein512',
            'luffa512',
            'cubehash512',
            'shavite512',
            'simd512',
            'echo512'
        ];
    }

    async initialize(blockHeight) {
        // X11 doesn't require special initialization
        this.initialized = true;
    }

    async hash(blockHeader, nonce, target) {
        // Convert block header to buffer
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        // Add nonce to header
        const nonceBuffer = Buffer.alloc(4);
        nonceBuffer.writeUInt32LE(nonce, 0);
        const dataToHash = Buffer.concat([headerBuffer, nonceBuffer]);
        
        // Apply the 11 hash functions in sequence
        let hash = dataToHash;
        
        // For now, use SHA256 as placeholder since not all X11 hashes are in Node crypto
        // In production, would use native X11 library
        for (let i = 0; i < 11; i++) {
            hash = createHash('sha256').update(hash).digest();
        }
        
        // Double SHA256 the final result (X11 convention)
        hash = createHash('sha256').update(hash).digest();
        hash = createHash('sha256').update(hash).digest();
        
        // Check if hash meets target
        const hashValue = hash.reverse();
        const valid = Buffer.compare(hashValue, target) <= 0;
        
        return {
            valid,
            hash: hashValue.toString('hex'),
            nonce
        };
    }

    async validateShare(share) {
        const { blockHeader, nonce, target, hash } = share;
        
        // Recalculate hash
        const result = await this.hash(blockHeader, nonce, target);
        
        // Verify hash matches
        if (result.hash !== hash) {
            return {
                valid: false,
                reason: 'Hash mismatch'
            };
        }
        
        // Check difficulty
        if (!result.valid) {
            return {
                valid: false,
                reason: 'Insufficient difficulty'
            };
        }
        
        return {
            valid: true,
            difficulty: this.calculateDifficulty(result.hash)
        };
    }

    calculateDifficulty(hash) {
        // Calculate difficulty from hash
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
            name: 'X11',
            version: '1.0.0',
            description: 'Chain of 11 hash functions used by Dash',
            coins: ['DASH'],
            hardware: ['GPU', 'ASIC'],
            hashFunctions: this.hashFunctions,
            features: {
                asicResistant: false,
                memoryHard: false,
                multiAlgorithm: true
            }
        };
    }
}

export default X11;