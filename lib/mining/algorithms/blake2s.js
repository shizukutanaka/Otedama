/**
 * Blake2s Mining Algorithm
 * Used by Kadena
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

export class Blake2s extends MiningAlgorithm {
    constructor(config = {}) {
        super('blake2s', config);
    }

    async initialize(blockHeight) {
        this.initialized = true;
    }

    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        const nonceBuffer = Buffer.alloc(4);
        nonceBuffer.writeUInt32LE(nonce, 0);
        
        // Blake2s-256
        const hash = createHash('blake2s256')
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
            name: 'Blake2s',
            version: '1.0.0',
            description: 'Fast cryptographic hash used by Kadena',
            coins: ['KDA'],
            hardware: ['ASIC'],
            features: {
                asicResistant: false,
                memoryHard: false,
                fast: true
            }
        };
    }
}

export default Blake2s;