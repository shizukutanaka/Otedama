/**
 * KawPow Mining Algorithm
 * ProgPoW variant used by Ravencoin
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

export class KawPow extends MiningAlgorithm {
    constructor(config = {}) {
        super('kawpow', config);
        
        // KawPow parameters
        this.progpowVersion = '0.9.4';
        this.periodLength = 3;
        this.dagSize = 1073741824; // 1GB initial
        this.cacheSize = 16777216; // 16MB
        this.cache = null;
        this.currentPeriod = -1;
    }

    async initialize(blockHeight) {
        const period = Math.floor(blockHeight / this.periodLength);
        
        if (period !== this.currentPeriod) {
            this.currentPeriod = period;
            await this.generateCache(period);
        }
        
        this.initialized = true;
    }

    async generateCache(period) {
        // Generate cache for period
        const seed = this.getPeriodSeed(period);
        this.cache = Buffer.alloc(this.cacheSize);
        
        // Fill cache with Keccak-based data
        let offset = 0;
        let hash = seed;
        
        while (offset < this.cacheSize) {
            hash = createHash('sha3-256').update(hash).digest();
            hash.copy(this.cache, offset, 0, Math.min(32, this.cacheSize - offset));
            offset += 32;
        }
    }

    getPeriodSeed(period) {
        // KawPow changes mix every period
        const periodData = Buffer.alloc(8);
        periodData.writeBigUInt64LE(BigInt(period), 0);
        
        return createHash('sha3-256')
            .update(Buffer.from('KawPow'))
            .update(periodData)
            .digest();
    }

    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        // Extract block number from header
        const blockNumber = headerBuffer.readUInt32LE(68);
        const period = Math.floor(blockNumber / this.periodLength);
        
        // Prepare header hash
        const headerHash = createHash('sha3-256')
            .update(headerBuffer.slice(0, 64))
            .digest();
        
        // Add nonce
        const nonceBuffer = Buffer.alloc(8);
        nonceBuffer.writeBigUInt64LE(BigInt(nonce), 0);
        
        // Calculate mix hash
        const mixHash = await this.progpowHash(headerHash, nonce, period);
        
        // Final hash
        const finalHash = createHash('sha3-256')
            .update(headerHash)
            .update(mixHash)
            .update(nonceBuffer)
            .digest();
        
        // Check if hash meets target
        const valid = Buffer.compare(finalHash, target) <= 0;
        
        return {
            valid,
            hash: finalHash.toString('hex'),
            mixHash: mixHash.toString('hex'),
            nonce,
            period
        };
    }

    async progpowHash(headerHash, nonce, period) {
        // Simplified ProgPoW implementation
        const mix = Buffer.alloc(256);
        
        // Initialize mix array
        const seed = createHash('sha3-512')
            .update(headerHash)
            .update(Buffer.from(nonce.toString()))
            .update(Buffer.from(period.toString()))
            .digest();
        
        for (let i = 0; i < 4; i++) {
            seed.copy(mix, i * 64);
        }
        
        // Random sequence based on period
        const kisses = this.generateKisses(period);
        
        // Mix rounds
        for (let round = 0; round < 64; round++) {
            const kiss = kisses[round % kisses.length];
            
            // Cache reads
            for (let i = 0; i < 4; i++) {
                const index = (mix.readUInt32LE(i * 4) ^ kiss) % (this.cacheSize / 64);
                const cacheData = this.getFromCache(index);
                
                // Mix with cache
                for (let j = 0; j < 64; j++) {
                    mix[i * 64 + j] ^= cacheData[j];
                }
            }
            
            // Random math
            this.randomMath(mix, kiss);
        }
        
        // Compress to 32 bytes
        return createHash('sha3-256').update(mix).digest();
    }

    generateKisses(period) {
        // Generate KISS99 random sequence for period
        const kisses = [];
        let kiss = period;
        
        for (let i = 0; i < 64; i++) {
            kiss = (kiss * 69069 + 1234567) >>> 0;
            kisses.push(kiss);
        }
        
        return kisses;
    }

    randomMath(mix, kiss) {
        // Random math operations
        const ops = kiss % 11;
        const offset1 = (kiss >> 8) % 32;
        const offset2 = (kiss >> 16) % 32;
        
        const a = mix.readUInt32LE(offset1 * 4);
        const b = mix.readUInt32LE(offset2 * 4);
        let result;
        
        switch (ops) {
            case 0: result = a + b; break;
            case 1: result = a * b; break;
            case 2: result = Math.imul(a, b) >>> 0; break;
            case 3: result = a & b; break;
            case 4: result = a | b; break;
            case 5: result = a ^ b; break;
            case 6: result = Math.min(a, b); break;
            case 7: result = (a << (b % 32)) >>> 0; break;
            case 8: result = (a >>> (b % 32)) >>> 0; break;
            case 9: result = a % (b || 1); break;
            case 10: result = ~a; break;
        }
        
        mix.writeUInt32LE(result >>> 0, offset1 * 4);
    }

    getFromCache(index) {
        const offset = index * 64;
        return this.cache.slice(offset, offset + 64);
    }

    async validateShare(share) {
        const { blockHeader, nonce, target, hash, mixHash } = share;
        
        // Recalculate hash
        const result = await this.hash(blockHeader, nonce, target);
        
        // Verify hash matches
        if (result.hash !== hash) {
            return {
                valid: false,
                reason: 'Hash mismatch'
            };
        }
        
        // Verify mix hash
        if (mixHash && result.mixHash !== mixHash) {
            return {
                valid: false,
                reason: 'Mix hash mismatch'
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
            period: result.period
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
            name: 'KawPow',
            version: this.progpowVersion,
            description: 'ProgPoW variant used by Ravencoin',
            coins: ['RVN'],
            hardware: ['GPU'],
            parameters: {
                periodLength: this.periodLength,
                cacheSizeMB: this.cacheSize / 1024 / 1024,
                dagSizeGB: this.dagSize / 1024 / 1024 / 1024,
                currentPeriod: this.currentPeriod
            },
            features: {
                asicResistant: true,
                gpuOptimized: true,
                periodBased: true,
                progpowBased: true
            }
        };
    }

    async cleanup() {
        // Free cache memory
        this.cache = null;
        await super.cleanup();
    }
}

export default KawPow;