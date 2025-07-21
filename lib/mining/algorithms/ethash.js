/**
 * Ethash Mining Algorithm
 * Memory-hard algorithm used by Ethereum
 * 
 * Uses native implementation when available for production mining,
 * falls back to optimized JavaScript implementation for development.
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';
import { NativeEthash, isNativeAvailable } from './native-bindings.js';

export class Ethash extends MiningAlgorithm {
    constructor(config = {}) {
        super('ethash', config);
        
        // Ethash parameters
        this.cacheSize = config.cacheSize || 16777216; // 16MB initial
        this.datasetSize = config.datasetSize || 1073741824; // 1GB initial
        this.epochLength = 30000; // blocks per epoch
        this.cache = null;
        this.currentEpoch = -1;
        
        // Use native implementation if available
        this.useNative = config.forceNative !== false && isNativeAvailable('ethash');
        this.native = null;
        
        if (this.useNative) {
            this.native = new NativeEthash();
            console.log('Ethash: Using optimized native implementation');
        } else {
            console.log('Ethash: Using JavaScript implementation');
        }
    }

    async initialize(blockHeight) {
        if (this.native) {
            // Initialize native implementation
            await this.native.initialize(blockHeight);
        } else {
            // JavaScript fallback
            const epoch = Math.floor(blockHeight / this.epochLength);
            
            if (epoch !== this.currentEpoch) {
                this.currentEpoch = epoch;
                await this.generateCache(epoch);
            }
        }
        
        this.initialized = true;
    }

    async generateCache(epoch) {
        // Optimized cache generation
        const seed = this.getSeedHash(epoch);
        this.cache = Buffer.alloc(this.cacheSize);
        
        // Use SHA3-512 for better performance
        let offset = 0;
        let hash = seed;
        
        while (offset < this.cacheSize) {
            hash = createHash('sha3-512').update(hash).digest();
            hash.copy(this.cache, offset, 0, Math.min(64, this.cacheSize - offset));
            offset += 64;
        }
        
        // Run cache rounds
        const rounds = 3;
        for (let i = 0; i < rounds; i++) {
            for (let j = 0; j < this.cacheSize / 64; j++) {
                const idx = j * 64;
                const data = this.cache.slice(idx, idx + 64);
                const mixed = createHash('sha3-512').update(data).digest();
                mixed.copy(this.cache, idx, 0, 64);
            }
        }
    }

    getSeedHash(epoch) {
        let seed = Buffer.alloc(32);
        
        for (let i = 0; i < epoch; i++) {
            seed = createHash('sha3-256').update(seed).digest();
        }
        
        return seed;
    }

    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.isBuffer(blockHeader) 
            ? blockHeader 
            : Buffer.from(blockHeader, 'hex');
        
        if (this.native) {
            // Use native implementation
            const currentHeight = this.currentEpoch * this.epochLength;
            const hash = this.native.hash(headerBuffer, nonce, currentHeight);
            const valid = Buffer.compare(hash, target) <= 0;
            
            return {
                valid,
                hash: hash.toString('hex'),
                mixHash: hash.slice(0, 32).toString('hex'), // First 32 bytes as mix
                nonce
            };
        }
        
        // JavaScript fallback
        // Prepare header without nonce (Ethash specific format)
        const headerWithoutNonce = headerBuffer.slice(0, 32);
        
        // Add nonce
        const nonceBuffer = Buffer.alloc(8);
        nonceBuffer.writeBigUInt64LE(BigInt(nonce), 0);
        
        // Calculate mix hash
        const mixHash = await this.calculateMixHash(headerWithoutNonce, nonce);
        
        // Final hash = sha3(header + mixHash + nonce)
        const finalHash = createHash('sha3-256')
            .update(headerWithoutNonce)
            .update(mixHash)
            .update(nonceBuffer)
            .digest();
        
        // Check if hash meets target
        const valid = Buffer.compare(finalHash, target) <= 0;
        
        return {
            valid,
            hash: finalHash.toString('hex'),
            mixHash: mixHash.toString('hex'),
            nonce
        };
    }

    async calculateMixHash(header, nonce) {
        // Optimized mix hash calculation
        const mix = Buffer.alloc(128);
        
        // Initialize mix with Keccak
        const seed = createHash('sha3-512')
            .update(header)
            .update(Buffer.from(nonce.toString()))
            .digest();
        seed.copy(mix, 0);
        seed.copy(mix, 64);
        
        // FNV prime for mixing
        const FNV_PRIME = 0x01000193;
        
        // Ethash mixing loop
        const mixWords = 32; // 128 bytes / 4
        const accesses = 64;
        
        for (let i = 0; i < accesses; i++) {
            // Calculate parent index
            const parent = this.fnv(i ^ mix.readUInt32LE(0), mix.readUInt32LE((i % mixWords) * 4));
            const index = parent % (this.cacheSize / 64);
            const cacheData = this.getFromCache(index);
            
            // FNV mix with cache data
            for (let j = 0; j < mixWords; j++) {
                const offset = j * 4;
                const a = mix.readUInt32LE(offset);
                const b = cacheData.readUInt32LE(offset % cacheData.length);
                mix.writeUInt32LE(this.fnv(a, b), offset);
            }
        }
        
        // Compress mix to 32 bytes
        const compressed = Buffer.alloc(32);
        for (let i = 0; i < 32; i++) {
            compressed[i] = mix[i * 4] ^ mix[i * 4 + 1] ^ mix[i * 4 + 2] ^ mix[i * 4 + 3];
        }
        
        return compressed;
    }
    
    fnv(a, b) {
        // FNV-1a hash function
        return ((a * 0x01000193) ^ b) >>> 0;
    }

    getFromCache(index) {
        // Get 64 bytes from cache at index
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
            difficulty: this.calculateDifficulty(result.hash)
        };
    }

    calculateDifficulty(hash) {
        const hashBuffer = Buffer.from(hash, 'hex');
        const hashNum = BigInt('0x' + hash);
        const maxTarget = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
        
        return Number(maxTarget / hashNum);
    }

    getInfo() {
        return {
            name: 'Ethash',
            version: '1.0.0',
            description: 'Memory-hard algorithm used by Ethereum',
            coins: ['ETH', 'ETC'],
            hardware: ['GPU', 'ASIC'],
            parameters: {
                cacheSizeMB: Math.round(this.cacheSize / 1024 / 1024),
                datasetSizeGB: Math.round(this.datasetSize / 1024 / 1024 / 1024),
                epoch: this.currentEpoch,
                epochLength: this.epochLength
            },
            features: {
                asicResistant: false, // ASICs exist now
                memoryHard: true,
                dagBased: true
            }
        };
    }

    async cleanup() {
        // Free cache memory
        this.cache = null;
        await super.cleanup();
    }
}

export default Ethash;