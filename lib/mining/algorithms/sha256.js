/**
 * SHA256 Mining Algorithm
 * Bitcoin's proof-of-work algorithm
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

export class SHA256 extends MiningAlgorithm {
    constructor(config = {}) {
        super('sha256', config);
        this.doubleHash = config.doubleHash !== false; // SHA256d by default
    }

    async initialize(blockHeight) {
        // SHA256 doesn't require special initialization
        this.initialized = true;
    }

    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        // Bitcoin block header is 80 bytes
        if (headerBuffer.length !== 80) {
            throw new Error('Invalid block header length for SHA256');
        }
        
        // Add nonce at position 76-79
        const fullHeader = Buffer.from(headerBuffer);
        fullHeader.writeUInt32LE(nonce, 76);
        
        // Calculate hash
        let hash = createHash('sha256').update(fullHeader).digest();
        
        // Double SHA256 for Bitcoin
        if (this.doubleHash) {
            hash = createHash('sha256').update(hash).digest();
        }
        
        // Reverse for little-endian comparison
        const hashReversed = Buffer.from(hash).reverse();
        
        // Check if hash meets target
        const valid = Buffer.compare(hashReversed, target) <= 0;
        
        return {
            valid,
            hash: hashReversed.toString('hex'),
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
            name: 'SHA256',
            version: '1.0.0',
            description: 'Bitcoin proof-of-work algorithm',
            coins: ['BTC', 'BCH', 'BSV'],
            hardware: ['ASIC'],
            features: {
                asicResistant: false,
                memoryHard: false,
                doubleHash: this.doubleHash
            }
        };
    }
}

export default SHA256;