/**
 * Scrypt Mining Algorithm
 * Memory-hard algorithm used by Litecoin
 */

import { scrypt as cryptoScrypt } from 'crypto';
import { promisify } from 'util';
import { MiningAlgorithm } from './base-algorithm.js';

const scryptAsync = promisify(cryptoScrypt);

export class Scrypt extends MiningAlgorithm {
    constructor(config = {}) {
        super('scrypt', config);
        
        // Scrypt parameters
        this.N = config.N || 1024; // CPU/memory cost parameter
        this.r = config.r || 1;    // Block size parameter
        this.p = config.p || 1;    // Parallelization parameter
        this.keyLen = config.keyLen || 32; // Output length
    }

    async initialize(blockHeight) {
        // Calculate memory requirement
        this.memoryRequired = 128 * this.r * this.N;
        this.initialized = true;
    }

    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        // Litecoin block header is 80 bytes
        if (headerBuffer.length !== 80) {
            throw new Error('Invalid block header length for Scrypt');
        }
        
        // Add nonce at position 76-79
        const fullHeader = Buffer.from(headerBuffer);
        fullHeader.writeUInt32LE(nonce, 76);
        
        // Calculate scrypt hash
        const hash = await scryptAsync(fullHeader, fullHeader, this.keyLen, {
            N: this.N,
            r: this.r,
            p: this.p,
            maxmem: this.memoryRequired + 1024
        });
        
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
            name: 'Scrypt',
            version: '1.0.0',
            description: 'Memory-hard algorithm used by Litecoin',
            coins: ['LTC', 'DOGE'],
            hardware: ['ASIC'],
            parameters: {
                N: this.N,
                r: this.r,
                p: this.p,
                memoryMB: Math.round(this.memoryRequired / 1024 / 1024)
            },
            features: {
                asicResistant: false, // Was true initially, but ASICs exist now
                memoryHard: true
            }
        };
    }
}

export default Scrypt;