/**
 * Blake3 Mining Algorithm
 * High-performance cryptographic hash used by Alephium
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

export class Blake3 extends MiningAlgorithm {
    constructor(config = {}) {
        super('blake3', config);
        
        // Blake3 parameters
        this.outputLength = 32; // 256 bits
        this.chunkSize = 1024; // 1KB chunks
    }

    async initialize(blockHeight) {
        // Blake3 doesn't require special initialization
        this.initialized = true;
    }

    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        // Add nonce to header
        const nonceBuffer = Buffer.alloc(8);
        nonceBuffer.writeBigUInt64LE(BigInt(nonce), 0);
        const dataToHash = Buffer.concat([headerBuffer, nonceBuffer]);
        
        // Blake3 hash (using Blake2b as placeholder since Blake3 not in Node crypto)
        // In production, would use native Blake3 library
        let hash = createHash('blake2b256').update(dataToHash).digest();
        
        // Alephium uses a chain structure for PoW
        const chainIndex = this.getChainIndex(headerBuffer);
        hash = createHash('blake2b256')
            .update(hash)
            .update(Buffer.from([chainIndex]))
            .digest();
        
        // Check if hash meets target
        const valid = this.checkPoW(hash, target);
        
        return {
            valid,
            hash: hash.toString('hex'),
            nonce,
            chainIndex
        };
    }

    getChainIndex(blockHeader) {
        // Extract chain index from block header
        // Alephium uses multiple chains for sharding
        if (blockHeader.length >= 4) {
            return blockHeader[0] & 0x0F; // 16 chains max
        }
        return 0;
    }

    checkPoW(hash, target) {
        // Alephium uses a different PoW check
        // Target is based on leading zeros and value comparison
        const leadingZeros = this.countLeadingZeros(hash);
        const targetZeros = this.countLeadingZeros(target);
        
        if (leadingZeros > targetZeros) {
            return true;
        } else if (leadingZeros === targetZeros) {
            return Buffer.compare(hash, target) <= 0;
        }
        return false;
    }

    countLeadingZeros(buffer) {
        let zeros = 0;
        for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] === 0) {
                zeros += 8;
            } else {
                zeros += Math.floor(Math.log2(256 / buffer[i]));
                break;
            }
        }
        return zeros;
    }

    async validateShare(share) {
        const { blockHeader, nonce, target, hash, chainIndex } = share;
        
        // Recalculate hash
        const result = await this.hash(blockHeader, nonce, target);
        
        // Verify hash matches
        if (result.hash !== hash) {
            return {
                valid: false,
                reason: 'Hash mismatch'
            };
        }
        
        // Verify chain index
        if (chainIndex !== undefined && result.chainIndex !== chainIndex) {
            return {
                valid: false,
                reason: 'Chain index mismatch'
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
            difficulty: this.calculateDifficulty(result.hash),
            chainIndex: result.chainIndex
        };
    }

    calculateDifficulty(hash) {
        return this.countLeadingZeros(Buffer.from(hash, 'hex'));
    }

    getInfo() {
        return {
            name: 'Blake3',
            version: '1.0.0',
            description: 'High-performance hash used by Alephium',
            coins: ['ALPH'],
            hardware: ['ASIC', 'GPU', 'CPU'],
            features: {
                asicResistant: false,
                memoryHard: false,
                parallelizable: true,
                sharded: true,
                chains: 16
            },
            performance: {
                outputLength: this.outputLength,
                chunkSize: this.chunkSize,
                highThroughput: true
            }
        };
    }
}

export default Blake3;