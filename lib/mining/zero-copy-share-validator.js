/**
 * Zero-Copy Share Validator for Otedama
 * 
 * Eliminates memory allocation in critical validation paths
 * Following John Carmack's performance principles
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { globalBufferPool } from '../performance/buffer-pool.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('ZeroCopyShareValidator');

/**
 * Pre-allocated buffer sizes
 */
const HEADER_SIZE = 80;
const COINBASE_MAX_SIZE = 1024;
const HASH_SIZE = 32;

/**
 * Zero-copy share validator with extreme optimization
 */
export class ZeroCopyShareValidator extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            workerCount: config.workerCount || 4,
            preallocateBuffers: config.preallocateBuffers || 1000,
            enableSimd: config.enableSimd !== false,
            ...config
        };
        
        // Pre-allocated buffers
        this.headerPool = [];
        this.coinbasePool = [];
        this.hashPool = [];
        
        // Reusable hash contexts
        this.hashContexts = [];
        
        // Worker pool
        this.workers = [];
        this.workerIndex = 0;
        
        // Statistics
        this.stats = {
            totalValidated: 0,
            validShares: 0,
            invalidShares: 0,
            blocksFound: 0,
            allocations: 0,
            poolHits: 0
        };
        
        // Pre-computed constants
        this.maxTargetBigInt = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
        
        // Lookup tables for hex conversion (avoid repeated parsing)
        this.hexLookup = new Map();
        this.targetCache = new Map();
        
        // Initialize pools
        this.initializePools();
        
        // Initialize workers
        this.initializeWorkers();
    }
    
    /**
     * Initialize buffer pools
     */
    initializePools() {
        // Pre-allocate header buffers
        for (let i = 0; i < this.config.preallocateBuffers; i++) {
            this.headerPool.push(Buffer.allocUnsafe(HEADER_SIZE));
        }
        
        // Pre-allocate coinbase buffers
        for (let i = 0; i < this.config.preallocateBuffers; i++) {
            this.coinbasePool.push(Buffer.allocUnsafe(COINBASE_MAX_SIZE));
        }
        
        // Pre-allocate hash buffers
        for (let i = 0; i < this.config.preallocateBuffers * 2; i++) {
            this.hashPool.push(Buffer.allocUnsafe(HASH_SIZE));
        }
        
        // Pre-create hash contexts
        for (let i = 0; i < 10; i++) {
            this.hashContexts.push({
                sha256_1: createHash('sha256'),
                sha256_2: createHash('sha256'),
                inUse: false
            });
        }
    }
    
    /**
     * Get buffer from pool (zero allocation)
     */
    getHeaderBuffer() {
        if (this.headerPool.length > 0) {
            this.stats.poolHits++;
            return this.headerPool.pop();
        }
        this.stats.allocations++;
        return Buffer.allocUnsafe(HEADER_SIZE);
    }
    
    getCoinbaseBuffer() {
        if (this.coinbasePool.length > 0) {
            this.stats.poolHits++;
            return this.coinbasePool.pop();
        }
        this.stats.allocations++;
        return Buffer.allocUnsafe(COINBASE_MAX_SIZE);
    }
    
    getHashBuffer() {
        if (this.hashPool.length > 0) {
            this.stats.poolHits++;
            return this.hashPool.pop();
        }
        this.stats.allocations++;
        return Buffer.allocUnsafe(HASH_SIZE);
    }
    
    /**
     * Return buffers to pool
     */
    releaseHeaderBuffer(buffer) {
        if (this.headerPool.length < this.config.preallocateBuffers) {
            buffer.fill(0); // Clear for security
            this.headerPool.push(buffer);
        }
    }
    
    releaseCoinbaseBuffer(buffer) {
        if (this.coinbasePool.length < this.config.preallocateBuffers) {
            buffer.fill(0);
            this.coinbasePool.push(buffer);
        }
    }
    
    releaseHashBuffer(buffer) {
        if (this.hashPool.length < this.config.preallocateBuffers * 2) {
            buffer.fill(0);
            this.hashPool.push(buffer);
        }
    }
    
    /**
     * Get reusable hash context
     */
    getHashContext() {
        for (const ctx of this.hashContexts) {
            if (!ctx.inUse) {
                ctx.inUse = true;
                return ctx;
            }
        }
        
        // Create new if all in use
        const ctx = {
            sha256_1: createHash('sha256'),
            sha256_2: createHash('sha256'),
            inUse: true
        };
        this.hashContexts.push(ctx);
        return ctx;
    }
    
    releaseHashContext(ctx) {
        ctx.inUse = false;
        // Reset hash contexts for reuse
        ctx.sha256_1 = createHash('sha256');
        ctx.sha256_2 = createHash('sha256');
    }
    
    /**
     * Parse hex string efficiently (cached)
     */
    parseHex(hexStr) {
        let value = this.hexLookup.get(hexStr);
        if (value !== undefined) return value;
        
        value = parseInt(hexStr, 16);
        
        // Cache frequently used values
        if (this.hexLookup.size < 10000) {
            this.hexLookup.set(hexStr, value);
        }
        
        return value;
    }
    
    /**
     * Get target from difficulty (cached)
     */
    getTarget(difficulty) {
        let target = this.targetCache.get(difficulty);
        if (target) return target;
        
        const targetBigInt = this.maxTargetBigInt / BigInt(Math.floor(difficulty));
        target = targetBigInt.toString(16).padStart(64, '0');
        
        // Cache frequently used targets
        if (this.targetCache.size < 1000) {
            this.targetCache.set(difficulty, target);
        }
        
        return target;
    }
    
    /**
     * Validate share with zero-copy operations
     */
    async validateShare(share, job, minerDifficulty, networkDifficulty) {
        const startTime = process.hrtime.bigint();
        
        try {
            // Get buffers from pool
            const headerBuffer = this.getHeaderBuffer();
            const coinbaseBuffer = this.getCoinbaseBuffer();
            const hash1Buffer = this.getHashBuffer();
            const hash2Buffer = this.getHashBuffer();
            
            // Construct header in-place (no allocations)
            this.constructHeaderInPlace(share, job, headerBuffer);
            
            // Calculate merkle root in-place
            const merkleRootLength = this.calculateMerkleRootInPlace(
                share, job, coinbaseBuffer, hash1Buffer, hash2Buffer
            );
            
            // Copy merkle root to header (32 bytes)
            coinbaseBuffer.copy(headerBuffer, 36, 0, 32);
            
            // Calculate block hash in-place
            const ctx = this.getHashContext();
            
            // First SHA256
            ctx.sha256_1.update(headerBuffer);
            ctx.sha256_1.digest(hash1Buffer);
            
            // Second SHA256
            ctx.sha256_2.update(hash1Buffer);
            ctx.sha256_2.digest(hash2Buffer);
            
            // Reverse for little-endian
            this.reverseInPlace(hash2Buffer);
            
            // Validate against targets
            const hashBigInt = this.bufferToBigInt(hash2Buffer);
            const minerTarget = this.getTarget(minerDifficulty);
            const networkTarget = this.getTarget(networkDifficulty);
            
            const minerTargetBigInt = BigInt('0x' + minerTarget);
            const networkTargetBigInt = BigInt('0x' + networkTarget);
            
            // Release resources immediately
            this.releaseHeaderBuffer(headerBuffer);
            this.releaseCoinbaseBuffer(coinbaseBuffer);
            this.releaseHashBuffer(hash1Buffer);
            this.releaseHashContext(ctx);
            
            // Check validity
            if (hashBigInt > minerTargetBigInt) {
                this.releaseHashBuffer(hash2Buffer);
                this.stats.invalidShares++;
                return {
                    valid: false,
                    reason: 'High hash'
                };
            }
            
            const shareValue = Number(this.maxTargetBigInt / hashBigInt);
            const isBlock = hashBigInt <= networkTargetBigInt;
            
            // Convert hash to hex without allocation
            const hashHex = this.bufferToHexInPlace(hash2Buffer);
            this.releaseHashBuffer(hash2Buffer);
            
            // Update stats
            this.stats.totalValidated++;
            this.stats.validShares++;
            if (isBlock) {
                this.stats.blocksFound++;
                this.emit('block:found', {
                    hash: hashHex,
                    height: job.height
                });
            }
            
            const endTime = process.hrtime.bigint();
            const validationTime = Number(endTime - startTime) / 1e6; // ms
            
            return {
                valid: true,
                hash: hashHex,
                shareValue,
                isBlock,
                validationTime
            };
            
        } catch (error) {
            logger.error('Share validation error:', error);
            this.stats.invalidShares++;
            return {
                valid: false,
                reason: error.message
            };
        }
    }
    
    /**
     * Construct block header in-place
     */
    constructHeaderInPlace(share, job, buffer) {
        // Version (4 bytes)
        buffer.writeUInt32LE(job.version || 0x20000000, 0);
        
        // Previous block hash (32 bytes) - convert and reverse in-place
        this.hexToBufferReversed(job.prevHash || job.previousblockhash, buffer, 4);
        
        // Merkle root placeholder (32 bytes) - will be filled later
        // Skip position 36-67
        
        // Timestamp (4 bytes)
        buffer.writeUInt32LE(this.parseHex(share.ntime), 68);
        
        // Bits (4 bytes)
        buffer.writeUInt32LE(this.parseHex(job.nbits || job.bits), 72);
        
        // Nonce (4 bytes)
        buffer.writeUInt32LE(this.parseHex(share.nonce), 76);
    }
    
    /**
     * Calculate merkle root in-place
     */
    calculateMerkleRootInPlace(share, job, coinbaseBuffer, hash1, hash2) {
        // Construct coinbase in buffer
        let pos = 0;
        
        // Copy coinbase1
        const cb1 = Buffer.from(job.coinbase1 || '', 'hex');
        cb1.copy(coinbaseBuffer, pos);
        pos += cb1.length;
        
        // Copy extraNonce1
        const en1 = Buffer.from(share.extraNonce1 || '', 'hex');
        en1.copy(coinbaseBuffer, pos);
        pos += en1.length;
        
        // Copy extraNonce2
        const en2 = Buffer.from(share.extraNonce2 || '', 'hex');
        en2.copy(coinbaseBuffer, pos);
        pos += en2.length;
        
        // Copy coinbase2
        const cb2 = Buffer.from(job.coinbase2 || '', 'hex');
        cb2.copy(coinbaseBuffer, pos);
        pos += cb2.length;
        
        // Hash coinbase (double SHA256)
        const coinbaseLength = pos;
        
        // Use pre-allocated hash buffers
        const sha256_1 = createHash('sha256');
        sha256_1.update(coinbaseBuffer.slice(0, coinbaseLength));
        sha256_1.digest(hash1);
        
        const sha256_2 = createHash('sha256');
        sha256_2.update(hash1);
        sha256_2.digest(hash2);
        
        // Calculate merkle root with branches
        let currentHash = hash2;
        let otherHash = hash1;
        
        for (const branch of (job.merkleBranch || job.merklebranch || [])) {
            // Parse branch hex directly into buffer
            this.hexToBuffer(branch, otherHash);
            
            // Concatenate and hash in-place
            const sha256_1 = createHash('sha256');
            sha256_1.update(currentHash);
            sha256_1.update(otherHash);
            sha256_1.digest(hash1);
            
            const sha256_2 = createHash('sha256');
            sha256_2.update(hash1);
            sha256_2.digest(hash2);
            
            // Swap buffers
            currentHash = hash2;
            otherHash = hash1;
        }
        
        // Reverse final hash and copy to beginning of coinbaseBuffer
        this.reverseInPlace(currentHash);
        currentHash.copy(coinbaseBuffer, 0);
        
        return 32; // Merkle root length
    }
    
    /**
     * Convert hex to buffer in-place
     */
    hexToBuffer(hex, buffer, offset = 0) {
        for (let i = 0; i < hex.length; i += 2) {
            buffer[offset + i / 2] = parseInt(hex.substr(i, 2), 16);
        }
    }
    
    /**
     * Convert hex to buffer and reverse in-place
     */
    hexToBufferReversed(hex, buffer, offset = 0) {
        const bytes = hex.length / 2;
        for (let i = 0; i < bytes; i++) {
            buffer[offset + bytes - 1 - i] = parseInt(hex.substr(i * 2, 2), 16);
        }
    }
    
    /**
     * Reverse buffer in-place
     */
    reverseInPlace(buffer) {
        let left = 0;
        let right = buffer.length - 1;
        
        while (left < right) {
            const temp = buffer[left];
            buffer[left] = buffer[right];
            buffer[right] = temp;
            left++;
            right--;
        }
    }
    
    /**
     * Convert buffer to BigInt without string allocation
     */
    bufferToBigInt(buffer) {
        let result = 0n;
        for (let i = 0; i < buffer.length; i++) {
            result = (result << 8n) | BigInt(buffer[i]);
        }
        return result;
    }
    
    /**
     * Convert buffer to hex string efficiently
     */
    bufferToHexInPlace(buffer) {
        const hexChars = '0123456789abcdef';
        let result = '';
        
        for (let i = 0; i < buffer.length; i++) {
            result += hexChars[buffer[i] >> 4];
            result += hexChars[buffer[i] & 0x0F];
        }
        
        return result;
    }
    
    /**
     * Initialize workers
     */
    initializeWorkers() {
        for (let i = 0; i < this.config.workerCount; i++) {
            const worker = new Worker('./lib/mining/workers/zero-copy-validator-worker.js', {
                workerData: {
                    workerId: i,
                    enableSimd: this.config.enableSimd
                }
            });
            
            worker.on('error', (error) => {
                logger.error(`Zero-copy validator worker ${i} error:`, error);
            });
            
            this.workers.push(worker);
        }
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            poolUtilization: {
                headers: `${this.headerPool.length}/${this.config.preallocateBuffers}`,
                coinbase: `${this.coinbasePool.length}/${this.config.preallocateBuffers}`,
                hash: `${this.hashPool.length}/${this.config.preallocateBuffers * 2}`
            },
            cacheSize: {
                hex: this.hexLookup.size,
                targets: this.targetCache.size
            },
            allocationsSaved: this.stats.poolHits,
            hitRate: this.stats.poolHits / (this.stats.poolHits + this.stats.allocations)
        };
    }
    
    /**
     * Shutdown validator
     */
    async shutdown() {
        // Terminate workers
        for (const worker of this.workers) {
            await worker.terminate();
        }
        
        // Clear pools
        this.headerPool = [];
        this.coinbasePool = [];
        this.hashPool = [];
        this.hashContexts = [];
        
        // Clear caches
        this.hexLookup.clear();
        this.targetCache.clear();
    }
}

export default ZeroCopyShareValidator;