/**
 * Octopus Mining Algorithm Implementation
 * Memory-hard algorithm designed for GPU mining (used by Conflux)
 */

import crypto from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

export class Octopus extends MiningAlgorithm {
    constructor(config = {}) {
        super('octopus', config);
        
        this.config = {
            version: config.version || 3,
            datasetSize: config.datasetSize || 4294967296, // 4GB
            cacheSize: config.cacheSize || 67108864, // 64MB
            epochLength: config.epochLength || 40000,
            mixSize: config.mixSize || 256,
            hashSize: config.hashSize || 64,
            parentsPerItem: config.parentsPerItem || 512,
            roundsPerHash: config.roundsPerHash || 3,
            ...config
        };
        
        this.cache = null;
        this.dataset = null;
        this.epoch = -1;
    }

    /**
     * Initialize algorithm for epoch
     */
    async initialize(blockHeight) {
        const newEpoch = Math.floor(blockHeight / this.config.epochLength);
        
        if (newEpoch !== this.epoch) {
            this.epoch = newEpoch;
            
            // Generate cache
            this.cache = await this.generateCache(this.epoch);
            
            // Generate dataset (in production, would be generated on demand)
            this.dataset = await this.generateDataset(this.cache);
        }
        
        return true;
    }

    /**
     * Generate cache for epoch
     */
    async generateCache(epoch) {
        const seed = this.getEpochSeed(epoch);
        const cacheSize = this.getCacheSize(epoch);
        const items = Math.floor(cacheSize / this.config.hashSize);
        
        const cache = Buffer.alloc(cacheSize);
        
        // Initialize first item with seed
        let hash = crypto.createHash('sha3-512').update(seed).digest();
        hash.copy(cache, 0);
        
        // Generate rest of cache
        for (let i = 1; i < items; i++) {
            const offset = i * this.config.hashSize;
            const prevOffset = (i - 1) * this.config.hashSize;
            
            hash = crypto.createHash('sha3-512')
                .update(cache.slice(prevOffset, prevOffset + this.config.hashSize))
                .digest();
            
            hash.copy(cache, offset);
        }
        
        // Final cache rounds
        for (let round = 0; round < this.config.roundsPerHash; round++) {
            for (let i = 0; i < items; i++) {
                const offset = i * this.config.hashSize;
                const v = cache.readUInt32LE(offset) % items;
                const u = (cache.readUInt32LE(offset + 4) % items + items - 1) % items;
                
                const mix = Buffer.alloc(this.config.hashSize);
                for (let j = 0; j < this.config.hashSize; j++) {
                    mix[j] = cache[u * this.config.hashSize + j] ^ 
                            cache[v * this.config.hashSize + j];
                }
                
                const newHash = crypto.createHash('sha3-512').update(mix).digest();
                newHash.copy(cache, offset);
            }
        }
        
        return cache;
    }

    /**
     * Generate dataset from cache
     */
    async generateDataset(cache) {
        const datasetSize = this.getDatasetSize(this.epoch);
        const items = Math.floor(datasetSize / this.config.hashSize);
        const dataset = Buffer.alloc(datasetSize);
        
        // Generate dataset items in parallel batches
        const batchSize = 1000;
        for (let batch = 0; batch < items; batch += batchSize) {
            const promises = [];
            
            for (let i = batch; i < Math.min(batch + batchSize, items); i++) {
                promises.push(this.generateDatasetItem(cache, i));
            }
            
            const results = await Promise.all(promises);
            
            results.forEach((item, index) => {
                const offset = (batch + index) * this.config.hashSize;
                item.copy(dataset, offset);
            });
        }
        
        return dataset;
    }

    /**
     * Generate single dataset item
     */
    async generateDatasetItem(cache, index) {
        const cacheItems = Math.floor(cache.length / this.config.hashSize);
        let mix = Buffer.alloc(this.config.hashSize);
        
        // Initialize mix
        const cacheOffset = (index % cacheItems) * this.config.hashSize;
        cache.copy(mix, 0, cacheOffset, cacheOffset + this.config.hashSize);
        mix.writeUInt32LE(mix.readUInt32LE(0) ^ index, 0);
        
        // SHA3-512 hash
        mix = crypto.createHash('sha3-512').update(mix).digest();
        
        // Memory accesses
        for (let i = 0; i < this.config.parentsPerItem; i++) {
            const parent = this.fnv1(index ^ i, mix.readUInt32LE(i % 16)) % cacheItems;
            const parentOffset = parent * this.config.hashSize;
            
            for (let j = 0; j < this.config.hashSize; j++) {
                mix[j] = this.fnv1(mix[j], cache[parentOffset + j]);
            }
        }
        
        // Final hash
        return crypto.createHash('sha3-512').update(mix).digest();
    }

    /**
     * Main hash function
     */
    async hash(blockHeader, nonce, target) {
        const headerBuffer = Buffer.from(blockHeader, 'hex');
        const nonceBuffer = Buffer.allocUnsafe(8);
        nonceBuffer.writeBigUInt64LE(BigInt(nonce));
        
        // Combine header and nonce
        const seedHash = crypto.createHash('sha3-512')
            .update(headerBuffer)
            .update(nonceBuffer)
            .digest();
        
        // Octopus main loop
        const result = await this.octopusHash(seedHash, nonce);
        
        // Check if hash meets target
        const hashValue = BigInt('0x' + result.toString('hex'));
        const targetValue = BigInt(target);
        
        return {
            hash: result.toString('hex'),
            valid: hashValue <= targetValue,
            mixHash: seedHash.toString('hex').slice(0, 64)
        };
    }

    /**
     * Octopus hash algorithm
     */
    async octopusHash(seedHash, nonce) {
        const mixBytes = this.config.mixSize;
        const mix = Buffer.alloc(mixBytes);
        
        // Initialize mix from seed
        for (let i = 0; i < mixBytes / 64; i++) {
            const chunk = crypto.createHash('sha3-512')
                .update(seedHash)
                .update(Buffer.from([i]))
                .digest();
            chunk.copy(mix, i * 64);
        }
        
        // Dataset accesses
        const datasetItems = Math.floor(this.dataset.length / this.config.hashSize);
        const accessCount = 64; // Number of dataset accesses
        
        for (let i = 0; i < accessCount; i++) {
            const mixIndex = i % (mixBytes / 4);
            const mixValue = mix.readUInt32LE(mixIndex * 4);
            
            // Calculate dataset index
            const datasetIndex = this.fnv1(i ^ seedHash.readUInt32LE(0), mixValue) % datasetItems;
            const datasetOffset = datasetIndex * this.config.hashSize;
            
            // Mix with dataset
            for (let j = 0; j < mixBytes; j += this.config.hashSize) {
                for (let k = 0; k < this.config.hashSize && j + k < mixBytes; k++) {
                    mix[j + k] = this.fnv1(mix[j + k], this.dataset[datasetOffset + k]);
                }
            }
        }
        
        // Compress mix
        const compressed = Buffer.alloc(32);
        for (let i = 0; i < mixBytes / 4; i += 8) {
            const fnvResult = this.fnv1Reduce(mix.slice(i * 4, (i + 8) * 4));
            compressed.writeUInt32LE(fnvResult, (i / 8) * 4);
        }
        
        // Final hash
        return crypto.createHash('sha3-256')
            .update(seedHash)
            .update(compressed)
            .digest();
    }

    /**
     * FNV-1a hash function
     */
    fnv1(a, b) {
        return Math.imul((a ^ b) >>> 0, 0x01000193) >>> 0;
    }

    /**
     * FNV-1a reduce
     */
    fnv1Reduce(buffer) {
        let result = 0x811c9dc5;
        
        for (let i = 0; i < buffer.length; i += 4) {
            result = this.fnv1(result, buffer.readUInt32LE(i));
        }
        
        return result;
    }

    /**
     * Get epoch seed
     */
    getEpochSeed(epoch) {
        let seed = Buffer.alloc(32);
        
        for (let i = 0; i < epoch; i++) {
            seed = crypto.createHash('sha3-256').update(seed).digest();
        }
        
        return seed;
    }

    /**
     * Get cache size for epoch
     */
    getCacheSize(epoch) {
        const baseSize = this.config.cacheSize;
        const growth = epoch * 131072; // 128KB per epoch
        return baseSize + growth;
    }

    /**
     * Get dataset size for epoch
     */
    getDatasetSize(epoch) {
        const baseSize = this.config.datasetSize;
        const growth = epoch * 8388608; // 8MB per epoch
        return baseSize + growth;
    }

    /**
     * Validate share
     */
    async validateShare(share) {
        const result = await this.hash(share.header, share.nonce, share.target);
        
        return {
            valid: result.valid,
            hash: result.hash,
            mixHash: result.mixHash,
            difficulty: this.calculateDifficulty(result.hash)
        };
    }

    /**
     * Calculate difficulty from hash
     */
    calculateDifficulty(hash) {
        const hashBuffer = Buffer.from(hash, 'hex');
        let bits = 0;
        
        for (let i = 0; i < hashBuffer.length; i++) {
            if (hashBuffer[i] === 0) {
                bits += 8;
            } else {
                bits += Math.clz32(hashBuffer[i]) - 24;
                break;
            }
        }
        
        return Math.pow(2, bits);
    }

    /**
     * Get algorithm info
     */
    getInfo() {
        return {
            name: 'Octopus',
            version: this.config.version,
            epoch: this.epoch,
            epochLength: this.config.epochLength,
            cacheSize: this.cache ? this.cache.length : 0,
            datasetSize: this.dataset ? this.dataset.length : 0,
            features: [
                'Memory-hard',
                'GPU optimized',
                'ASIC resistant',
                'Used by Conflux Network'
            ]
        };
    }
}

export default Octopus;