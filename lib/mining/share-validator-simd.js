/**
 * SIMD-Enhanced Share Validator for Otedama
 * 
 * High-performance share validation using SIMD acceleration
 * Following John Carmack's performance principles
 */

import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { logger } from '../core/logger.js';
import { SimdHashFactory, simdSHA256d } from '../performance/simd-hash.js';

export class SimdShareValidator extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            workerCount: config.workerCount || 4,
            batchSize: config.batchSize || 128, // Larger batches for SIMD
            cacheSize: config.cacheSize || 10000,
            enableCache: config.enableCache !== false,
            enableBatching: config.enableBatching !== false,
            enableSimd: config.enableSimd !== false,
            maxQueueSize: config.maxQueueSize || 10000,
            simdBatchSize: config.simdBatchSize || 8, // SIMD parallel operations
            ...config
        };
        
        // SIMD hash accelerator
        this.simdHasher = this.config.enableSimd ? simdSHA256d : null;
        
        // Validation cache for duplicate detection
        this.validationCache = new Map();
        this.cacheHits = 0;
        this.cacheMisses = 0;
        
        // Share queue for batching
        this.shareQueue = [];
        this.processing = false;
        this.pendingCallbacks = new Map();
        
        // Worker pool
        this.workers = [];
        this.workerRoundRobin = 0;
        
        // Pre-computed values
        this.maxTargetBigInt = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
        
        // Statistics
        this.stats = {
            totalValidated: 0,
            validShares: 0,
            invalidShares: 0,
            blocksFound: 0,
            avgValidationTime: 0,
            cacheHitRate: 0,
            simdSpeedup: 0
        };
        
        // Initialize workers
        this.initializeWorkers();
        
        // Start batch processor
        this.startBatchProcessor();
    }
    
    /**
     * Initialize worker pool with SIMD support
     */
    initializeWorkers() {
        for (let i = 0; i < this.config.workerCount; i++) {
            const worker = new Worker('./lib/mining/workers/share-validator-worker.js', {
                workerData: {
                    enableSimd: this.config.enableSimd,
                    workerId: i
                }
            });
            
            worker.on('message', (result) => {
                this.handleWorkerResult(result);
            });
            
            worker.on('error', (error) => {
                logger.error(`SIMD share validator worker ${i} error:`, error);
            });
            
            this.workers.push({
                id: i,
                worker,
                busy: false,
                jobCount: 0
            });
        }
    }
    
    /**
     * Validate share with SIMD optimization
     */
    async validateShare(share, job, minerDifficulty, networkDifficulty) {
        return new Promise((resolve, reject) => {
            const shareKey = this.createShareKey(share);
            
            // Check cache first
            if (this.config.enableCache) {
                const cached = this.validationCache.get(shareKey);
                if (cached) {
                    this.cacheHits++;
                    this.updateCacheStats();
                    resolve({ ...cached, cached: true });
                    return;
                }
            }
            
            this.cacheMisses++;
            
            // Add to queue for batch processing
            const queueItem = {
                share,
                job,
                minerDifficulty,
                networkDifficulty,
                shareKey,
                timestamp: Date.now()
            };
            
            this.shareQueue.push(queueItem);
            this.pendingCallbacks.set(shareKey, { resolve, reject });
            
            // Process immediately if batch is full
            if (this.shareQueue.length >= this.config.batchSize) {
                this.processBatch();
            }
        });
    }
    
    /**
     * Process batch of shares using SIMD
     */
    async processBatch() {
        if (this.processing || this.shareQueue.length === 0) return;
        
        this.processing = true;
        
        // Take batch from queue
        const batch = this.shareQueue.splice(0, this.config.batchSize);
        
        // Split batch for SIMD processing
        const simdBatches = [];
        for (let i = 0; i < batch.length; i += this.config.simdBatchSize) {
            simdBatches.push(batch.slice(i, i + this.config.simdBatchSize));
        }
        
        try {
            // Process batches in parallel
            const results = await Promise.all(
                simdBatches.map(simdBatch => this.processSimdBatch(simdBatch))
            );
            
            // Flatten results and handle callbacks
            const flatResults = results.flat();
            for (let i = 0; i < batch.length; i++) {
                const item = batch[i];
                const result = flatResults[i];
                
                // Cache result
                if (this.config.enableCache) {
                    this.addToCache(item.shareKey, result);
                }
                
                // Resolve callback
                const callback = this.pendingCallbacks.get(item.shareKey);
                if (callback) {
                    callback.resolve(result);
                    this.pendingCallbacks.delete(item.shareKey);
                }
                
                // Update stats
                this.updateStats(result);
            }
            
        } catch (error) {
            logger.error('Batch processing error:', error);
            
            // Reject all callbacks in batch
            for (const item of batch) {
                const callback = this.pendingCallbacks.get(item.shareKey);
                if (callback) {
                    callback.reject(error);
                    this.pendingCallbacks.delete(item.shareKey);
                }
            }
        } finally {
            this.processing = false;
            
            // Process next batch if queue has items
            if (this.shareQueue.length > 0) {
                setImmediate(() => this.processBatch());
            }
        }
    }
    
    /**
     * Process SIMD batch
     */
    async processSimdBatch(batch) {
        if (this.config.enableSimd && this.simdHasher) {
            // Prepare headers for SIMD hashing
            const headers = batch.map(item => 
                this.constructBlockHeader(item.share, item.job)
            );
            
            // Use SIMD to hash all headers in parallel
            const startTime = process.hrtime.bigint();
            const hashes = await this.simdHasher.hashBatch(headers);
            const endTime = process.hrtime.bigint();
            
            // Calculate speedup
            const simdTime = Number(endTime - startTime) / 1e6; // ms
            this.updateSimdStats(simdTime, batch.length);
            
            // Validate results
            return batch.map((item, index) => {
                const hash = hashes[index];
                return this.validateHash(
                    hash,
                    item.minerDifficulty,
                    item.networkDifficulty,
                    item.job
                );
            });
            
        } else {
            // Fallback to worker processing
            return this.processWithWorker(batch);
        }
    }
    
    /**
     * Construct block header for hashing
     */
    constructBlockHeader(share, job) {
        const header = Buffer.alloc(80);
        
        // Version
        header.writeUInt32LE(job.version || 0x20000000, 0);
        
        // Previous block hash
        Buffer.from(job.prevHash || job.previousblockhash, 'hex')
            .reverse()
            .copy(header, 4);
        
        // Merkle root (would be calculated from coinbase)
        const merkleRoot = this.calculateMerkleRoot(share, job);
        merkleRoot.copy(header, 36);
        
        // Timestamp
        header.writeUInt32LE(parseInt(share.ntime, 16), 68);
        
        // Bits
        header.writeUInt32LE(parseInt(job.nbits || job.bits, 16), 72);
        
        // Nonce
        header.writeUInt32LE(parseInt(share.nonce, 16), 76);
        
        return header;
    }
    
    /**
     * Calculate merkle root
     */
    calculateMerkleRoot(share, job) {
        // Simplified - in production would calculate full merkle tree
        const coinbase = Buffer.concat([
            Buffer.from(job.coinbase1 || '', 'hex'),
            Buffer.from(share.extraNonce1 || '', 'hex'),
            Buffer.from(share.extraNonce2 || '', 'hex'),
            Buffer.from(job.coinbase2 || '', 'hex')
        ]);
        
        // For now, return placeholder
        return Buffer.alloc(32);
    }
    
    /**
     * Validate hash against difficulty
     */
    validateHash(hash, minerDifficulty, networkDifficulty, job) {
        const hashBigInt = BigInt('0x' + hash.toString('hex'));
        const minerTarget = this.difficultyToTarget(minerDifficulty);
        const networkTarget = this.difficultyToTarget(networkDifficulty);
        
        const minerTargetBigInt = BigInt('0x' + minerTarget);
        const networkTargetBigInt = BigInt('0x' + networkTarget);
        
        if (hashBigInt > minerTargetBigInt) {
            return {
                valid: false,
                reason: 'High hash',
                hash: hash.toString('hex')
            };
        }
        
        const shareValue = Number(this.maxTargetBigInt / hashBigInt);
        const isBlock = hashBigInt <= networkTargetBigInt;
        
        return {
            valid: true,
            hash: hash.toString('hex'),
            shareValue,
            isBlock,
            blockHeight: isBlock ? job.height : null
        };
    }
    
    /**
     * Convert difficulty to target
     */
    difficultyToTarget(difficulty) {
        const diffBigInt = BigInt(Math.floor(difficulty));
        const targetBigInt = this.maxTargetBigInt / diffBigInt;
        return targetBigInt.toString(16).padStart(64, '0');
    }
    
    /**
     * Create share key for caching
     */
    createShareKey(share) {
        return `${share.nonce}-${share.ntime}-${share.extraNonce2}`;
    }
    
    /**
     * Add result to cache
     */
    addToCache(key, result) {
        this.validationCache.set(key, result);
        
        // Maintain cache size
        if (this.validationCache.size > this.config.cacheSize) {
            const firstKey = this.validationCache.keys().next().value;
            this.validationCache.delete(firstKey);
        }
    }
    
    /**
     * Update statistics
     */
    updateStats(result) {
        this.stats.totalValidated++;
        
        if (result.valid) {
            this.stats.validShares++;
            if (result.isBlock) {
                this.stats.blocksFound++;
                this.emit('block:found', result);
            }
        } else {
            this.stats.invalidShares++;
        }
    }
    
    /**
     * Update SIMD statistics
     */
    updateSimdStats(time, count) {
        const regularTime = count * 2; // Estimated regular time (2ms per hash)
        const speedup = regularTime / time;
        
        // Moving average
        this.stats.simdSpeedup = this.stats.simdSpeedup * 0.9 + speedup * 0.1;
    }
    
    /**
     * Update cache statistics
     */
    updateCacheStats() {
        const total = this.cacheHits + this.cacheMisses;
        if (total > 0) {
            this.stats.cacheHitRate = this.cacheHits / total;
        }
    }
    
    /**
     * Start batch processor
     */
    startBatchProcessor() {
        this.batchInterval = setInterval(() => {
            if (this.shareQueue.length > 0) {
                this.processBatch();
            }
        }, 100); // Process every 100ms
    }
    
    /**
     * Process with worker (fallback)
     */
    async processWithWorker(batch) {
        const worker = this.getAvailableWorker();
        
        return new Promise((resolve, reject) => {
            const batchId = Date.now() + Math.random();
            
            const timeout = setTimeout(() => {
                reject(new Error('Worker timeout'));
            }, 5000);
            
            const handler = (message) => {
                if (message.batchId === batchId) {
                    clearTimeout(timeout);
                    worker.removeListener('message', handler);
                    worker.busy = false;
                    resolve(message.results);
                }
            };
            
            worker.worker.on('message', handler);
            worker.busy = true;
            worker.jobCount++;
            
            worker.worker.postMessage({
                type: 'validateBatch',
                batch: batch.map(item => ({
                    share: item.share,
                    job: item.job,
                    minerTarget: this.difficultyToTarget(item.minerDifficulty),
                    networkTarget: this.difficultyToTarget(item.networkDifficulty)
                })),
                batchId
            });
        });
    }
    
    /**
     * Get available worker
     */
    getAvailableWorker() {
        // Find idle worker
        for (const worker of this.workers) {
            if (!worker.busy) {
                return worker;
            }
        }
        
        // Round-robin if all busy
        const worker = this.workers[this.workerRoundRobin];
        this.workerRoundRobin = (this.workerRoundRobin + 1) % this.workers.length;
        return worker;
    }
    
    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            queueLength: this.shareQueue.length,
            cacheSize: this.validationCache.size,
            workers: this.workers.map(w => ({
                id: w.id,
                busy: w.busy,
                jobCount: w.jobCount
            }))
        };
    }
    
    /**
     * Shutdown validator
     */
    async shutdown() {
        // Stop batch processor
        if (this.batchInterval) {
            clearInterval(this.batchInterval);
        }
        
        // Terminate workers
        for (const worker of this.workers) {
            await worker.worker.terminate();
        }
        
        // Shutdown SIMD hasher
        if (this.simdHasher && this.simdHasher.shutdown) {
            await this.simdHasher.shutdown();
        }
        
        // Clear queues
        this.shareQueue = [];
        this.pendingCallbacks.clear();
        this.validationCache.clear();
    }
}

export default SimdShareValidator;