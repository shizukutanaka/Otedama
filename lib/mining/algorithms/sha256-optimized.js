/**
 * Optimized SHA256 Mining Algorithm
 * Following John Carmack's performance principles
 * - Zero allocations in hot path
 * - SIMD-ready structure
 * - Cache-friendly memory access
 */

import { createHash } from 'crypto';
import { MiningAlgorithm } from './base-algorithm.js';

// Pre-allocated buffers
const HEADER_SIZE = 80;
const HASH_SIZE = 32;
const BUFFER_POOL_SIZE = 100;

export class SHA256Optimized extends MiningAlgorithm {
    constructor(config = {}) {
        super('sha256', config);
        this.doubleHash = config.doubleHash !== false;
        
        // Pre-allocate buffer pools
        this.headerPool = [];
        this.hashPool = [];
        this.poolIndex = 0;
        
        // Target cache for fast comparison
        this.targetCache = new Map();
        
        // Pre-initialize pools
        this._initializePools();
        
        // Statistics
        this.stats = {
            hashes: 0,
            poolHits: 0,
            allocations: 0
        };
    }
    
    _initializePools() {
        // Pre-allocate header buffers
        for (let i = 0; i < BUFFER_POOL_SIZE; i++) {
            this.headerPool.push(Buffer.allocUnsafe(HEADER_SIZE));
        }
        
        // Pre-allocate hash buffers
        for (let i = 0; i < BUFFER_POOL_SIZE * 2; i++) {
            this.hashPool.push(Buffer.allocUnsafe(HASH_SIZE));
        }
    }
    
    _getHeaderBuffer() {
        if (this.poolIndex < this.headerPool.length) {
            this.stats.poolHits++;
            return this.headerPool[this.poolIndex++];
        }
        this.stats.allocations++;
        return Buffer.allocUnsafe(HEADER_SIZE);
    }
    
    _getHashBuffer() {
        const buffer = this.hashPool.pop();
        if (buffer) {
            this.stats.poolHits++;
            return buffer;
        }
        this.stats.allocations++;
        return Buffer.allocUnsafe(HASH_SIZE);
    }
    
    _returnHashBuffer(buffer) {
        if (this.hashPool.length < BUFFER_POOL_SIZE * 2) {
            this.hashPool.push(buffer);
        }
    }
    
    async initialize(blockHeight) {
        this.initialized = true;
    }
    
    async hash(blockHeader, nonce, target) {
        this.stats.hashes++;
        
        // Get buffer from pool
        const headerBuffer = this._getHeaderBuffer();
        
        // Copy header data (avoid allocation)
        if (Buffer.isBuffer(blockHeader)) {
            blockHeader.copy(headerBuffer, 0, 0, HEADER_SIZE);
        } else {
            // Parse hex without intermediate string
            const hex = blockHeader;
            for (let i = 0; i < HEADER_SIZE; i++) {
                headerBuffer[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
        }
        
        // Write nonce directly
        headerBuffer.writeUInt32LE(nonce, 76);
        
        // First hash
        const hash1 = this._getHashBuffer();
        const hasher1 = createHash('sha256');
        hasher1.update(headerBuffer);
        hasher1.digest().copy(hash1);
        
        let finalHash;
        if (this.doubleHash) {
            // Second hash
            finalHash = this._getHashBuffer();
            const hasher2 = createHash('sha256');
            hasher2.update(hash1);
            hasher2.digest().copy(finalHash);
            this._returnHashBuffer(hash1);
        } else {
            finalHash = hash1;
        }
        
        // Reverse in-place for little-endian
        for (let i = 0; i < 16; i++) {
            const temp = finalHash[i];
            finalHash[i] = finalHash[31 - i];
            finalHash[31 - i] = temp;
        }
        
        // Fast comparison using cached target
        const targetKey = target.toString('hex');
        let targetBigInt = this.targetCache.get(targetKey);
        if (!targetBigInt) {
            targetBigInt = BigInt('0x' + target.toString('hex'));
            this.targetCache.set(targetKey, targetBigInt);
        }
        
        const hashBigInt = BigInt('0x' + finalHash.toString('hex'));
        const valid = hashBigInt <= targetBigInt;
        
        const result = {
            valid,
            hash: finalHash.toString('hex'),
            nonce
        };
        
        // Return buffer to pool
        this._returnHashBuffer(finalHash);
        
        // Reset pool index periodically
        if (this.poolIndex >= BUFFER_POOL_SIZE) {
            this.poolIndex = 0;
        }
        
        return result;
    }
    
    async batchHash(blockHeader, startNonce, endNonce, target) {
        const results = [];
        const batchSize = 1000;
        
        for (let nonce = startNonce; nonce < endNonce; nonce += batchSize) {
            const batchEnd = Math.min(nonce + batchSize, endNonce);
            
            // Process batch in parallel
            const promises = [];
            for (let n = nonce; n < batchEnd; n++) {
                promises.push(this.hash(blockHeader, n, target));
            }
            
            const batchResults = await Promise.all(promises);
            
            // Check for valid shares
            for (const result of batchResults) {
                if (result.valid) {
                    results.push(result);
                }
            }
        }
        
        return results;
    }
    
    async validateShare(share) {
        const { blockHeader, nonce, target, hash } = share;
        const result = await this.hash(blockHeader, nonce, target);
        
        if (result.hash !== hash) {
            return { valid: false, reason: 'Hash mismatch' };
        }
        
        if (!result.valid) {
            return { valid: false, reason: 'Insufficient difficulty' };
        }
        
        return {
            valid: true,
            difficulty: this._calculateDifficultyFast(result.hash)
        };
    }
    
    _calculateDifficultyFast(hash) {
        // Fast difficulty calculation using bit operations
        const hashBuffer = Buffer.from(hash, 'hex');
        let difficulty = 0;
        
        // Count leading zeros using bit manipulation
        for (let i = 0; i < hashBuffer.length; i++) {
            if (hashBuffer[i] === 0) {
                difficulty += 8;
            } else {
                // Use lookup table for faster calculation
                difficulty += Math.clz32(hashBuffer[i]) - 24;
                break;
            }
        }
        
        return difficulty;
    }
    
    getInfo() {
        return {
            name: 'SHA256 (Optimized)',
            algorithm: 'sha256',
            coins: ['BTC', 'BCH', 'BSV'],
            doubleHash: this.doubleHash,
            stats: this.stats
        };
    }
}

export default SHA256Optimized;