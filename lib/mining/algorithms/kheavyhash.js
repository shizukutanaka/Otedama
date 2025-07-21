/**
 * KHeavyHash Mining Algorithm
 * Matrix-based algorithm used by Kaspa
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

export class KHeavyHash extends MiningAlgorithm {
    constructor(config = {}) {
        super('kheavyhash', config);
        
        // KHeavyHash parameters
        this.matrixSize = 64; // 64x64 matrix
        this.rounds = 3;
        this.matrix = null;
    }

    async initialize(blockHeight) {
        // Initialize matrix for heavy computations
        this.matrix = this.generateMatrix(blockHeight);
        this.initialized = true;
    }

    generateMatrix(seed) {
        // Generate pseudo-random matrix based on seed
        const matrix = [];
        const seedHash = createHash('sha3-256')
            .update(Buffer.from(seed.toString()))
            .digest();
        
        for (let i = 0; i < this.matrixSize; i++) {
            matrix[i] = [];
            for (let j = 0; j < this.matrixSize; j++) {
                const index = (i * this.matrixSize + j) % 32;
                matrix[i][j] = seedHash[index];
            }
        }
        
        return matrix;
    }

    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        // Prepare input with nonce
        const nonceBuffer = Buffer.alloc(8);
        nonceBuffer.writeBigUInt64LE(BigInt(nonce), 0);
        const input = Buffer.concat([headerBuffer, nonceBuffer]);
        
        // Initial hash
        let hash = createHash('sha3-256').update(input).digest();
        
        // Heavy computation rounds
        for (let round = 0; round < this.rounds; round++) {
            hash = this.heavyRound(hash, round);
        }
        
        // Final hash
        const finalHash = createHash('sha3-256')
            .update(hash)
            .update(input)
            .digest();
        
        // Check if hash meets target
        const valid = Buffer.compare(finalHash, target) <= 0;
        
        return {
            valid,
            hash: finalHash.toString('hex'),
            nonce
        };
    }

    heavyRound(input, round) {
        // Matrix multiplication and transformation
        const vector = Array.from(input);
        const result = new Uint8Array(32);
        
        // Simplified matrix operation
        for (let i = 0; i < 32; i++) {
            let sum = 0;
            for (let j = 0; j < 32; j++) {
                const matrixRow = (i + round * 32) % this.matrixSize;
                const matrixCol = j % this.matrixSize;
                sum += vector[j] * this.matrix[matrixRow][matrixCol];
            }
            result[i] = sum & 0xFF;
        }
        
        // Additional mixing
        return createHash('sha3-256')
            .update(Buffer.from(result))
            .update(Buffer.from([round]))
            .digest();
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
            difficulty: this.calculateDifficulty(result.hash),
            blockTime: 1 // Kaspa has 1 second block time
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
            name: 'KHeavyHash',
            version: '1.0.0',
            description: 'Matrix-based algorithm used by Kaspa',
            coins: ['KAS'],
            hardware: ['ASIC', 'GPU'],
            features: {
                asicResistant: false,
                memoryHard: false,
                matrixBased: true,
                fastBlockTime: true,
                blockTime: 1 // 1 second
            },
            performance: {
                matrixSize: this.matrixSize,
                rounds: this.rounds
            }
        };
    }

    async cleanup() {
        // Free matrix memory
        this.matrix = null;
        await super.cleanup();
    }
}

export default KHeavyHash;