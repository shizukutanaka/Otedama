/**
 * Optimized Share Validator for Otedama
 * High-performance share validation with multiple optimizations
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { getLogger } from '../core/logger.js';

const logger = getLogger('ShareValidatorOptimized');

export class OptimizedShareValidator extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            workerCount: config.workerCount || 4,
            batchSize: config.batchSize || 100,
            cacheSize: config.cacheSize || 10000,
            enableCache: config.enableCache !== false,
            enableBatching: config.enableBatching !== false,
            maxQueueSize: config.maxQueueSize || 10000,
            ...config
        };
        
        // Validation cache for duplicate detection
        this.validationCache = new Map();
        this.cacheHits = 0;
        this.cacheMisses = 0;
        
        // Share queue for batching
        this.shareQueue = [];
        this.processing = false;
        
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
            cacheHitRate: 0
        };
        
        // Initialize workers
        this.initializeWorkers();
    }
    
    /**
     * Initialize worker pool
     */
    initializeWorkers() {
        for (let i = 0; i < this.config.workerCount; i++) {
            const worker = new Worker('./lib/mining/workers/share-validator-worker.js');
            
            worker.on('message', (result) => {
                this.handleWorkerResult(result);
            });
            
            worker.on('error', (error) => {
                logger.error(`Share validator worker ${i} error:`, error);
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
     * Validate share with optimizations
     */
    async validateShare(share, job, minerDifficulty, networkDifficulty) {
        const startTime = Date.now();
        
        // Create share key for caching
        const shareKey = this.createShareKey(share);
        
        // Check cache first
        if (this.config.enableCache) {
            const cached = this.validationCache.get(shareKey);
            if (cached) {
                this.cacheHits++;
                this.updateCacheStats();
                return { ...cached, cached: true };
            }
        }
        
        this.cacheMisses++;
        
        // Add to queue for batch processing
        if (this.config.enableBatching) {
            return this.queueShare(share, job, minerDifficulty, networkDifficulty);
        }
        
        // Direct validation
        const result = await this.performValidation(share, job, minerDifficulty, networkDifficulty);
        
        // Update statistics
        this.updateStats(result, Date.now() - startTime);
        
        return result;
    }
    
    /**
     * Queue share for batch processing
     */
    queueShare(share, job, minerDifficulty, networkDifficulty) {
        return new Promise((resolve, reject) => {
            if (this.shareQueue.length >= this.config.maxQueueSize) {
                reject(new Error('Share queue full'));
                return;
            }
            
            this.shareQueue.push({
                share,
                job,
                minerDifficulty,
                networkDifficulty,
                resolve,
                reject,
                timestamp: Date.now()
            });
            
            // Process queue if not already processing
            if (!this.processing) {
                this.processBatch();
            }
        });
    }
    
    /**
     * Process shares in batches
     */
    async processBatch() {
        if (this.processing || this.shareQueue.length === 0) return;
        
        this.processing = true;
        
        while (this.shareQueue.length > 0) {
            // Get batch
            const batch = this.shareQueue.splice(0, this.config.batchSize);
            
            // Find available worker
            const worker = this.getAvailableWorker();
            if (!worker) {
                // Put batch back and wait
                this.shareQueue.unshift(...batch);
                await new Promise(resolve => setTimeout(resolve, 10));
                continue;
            }
            
            // Send batch to worker
            worker.busy = true;
            worker.jobCount++;
            
            const batchData = batch.map(item => ({
                share: item.share,
                job: item.job,
                minerTarget: this.difficultyToTarget(item.minerDifficulty),
                networkTarget: this.difficultyToTarget(item.networkDifficulty)
            }));
            
            worker.worker.postMessage({
                type: 'validateBatch',
                batch: batchData,
                batchId: Date.now()
            });
            
            // Store callbacks
            worker.pendingBatch = batch;
        }
        
        this.processing = false;
    }
    
    /**
     * Handle worker result
     */
    handleWorkerResult(message) {
        const { type, results, workerId, batchId } = message;
        
        const worker = this.workers[workerId];
        if (!worker) return;
        
        worker.busy = false;
        
        if (type === 'batchComplete' && worker.pendingBatch) {
            const batch = worker.pendingBatch;
            worker.pendingBatch = null;
            
            // Process results
            results.forEach((result, index) => {
                const item = batch[index];
                if (!item) return;
                
                // Cache result
                if (this.config.enableCache && result.valid) {
                    const shareKey = this.createShareKey(item.share);
                    this.cacheResult(shareKey, result);
                }
                
                // Update stats
                this.updateStats(result, Date.now() - item.timestamp);
                
                // Resolve promise
                item.resolve(result);
            });
            
            // Process next batch if queue has items
            if (this.shareQueue.length > 0) {
                this.processBatch();
            }
        }
    }
    
    /**
     * Get available worker
     */
    getAvailableWorker() {
        // Round-robin with availability check
        for (let i = 0; i < this.config.workerCount; i++) {
            const index = (this.workerRoundRobin + i) % this.config.workerCount;
            const worker = this.workers[index];
            
            if (!worker.busy) {
                this.workerRoundRobin = (index + 1) % this.config.workerCount;
                return worker;
            }
        }
        
        return null;
    }
    
    /**
     * Perform direct validation (fallback)
     */
    async performValidation(share, job, minerDifficulty, networkDifficulty) {
        try {
            // Construct block header
            const header = this.constructHeader(share, job);
            
            // Calculate hash
            const hash = this.calculateHash(header);
            const hashBigInt = BigInt('0x' + hash.toString('hex'));
            
            // Calculate targets
            const minerTarget = this.difficultyToTarget(minerDifficulty);
            const networkTarget = this.difficultyToTarget(networkDifficulty);
            const minerTargetBigInt = BigInt('0x' + minerTarget);
            const networkTargetBigInt = BigInt('0x' + networkTarget);
            
            // Validate
            if (hashBigInt > minerTargetBigInt) {
                return {
                    valid: false,
                    reason: 'High hash',
                    hash: hash.toString('hex')
                };
            }
            
            // Calculate share value
            const shareValue = Number(this.maxTargetBigInt / hashBigInt);
            const isBlock = hashBigInt <= networkTargetBigInt;
            
            return {
                valid: true,
                hash: hash.toString('hex'),
                difficulty: minerDifficulty,
                shareValue,
                isBlock,
                blockHeight: isBlock ? job.height : null
            };
            
        } catch (error) {
            return {
                valid: false,
                reason: 'Validation error: ' + error.message
            };
        }
    }
    
    /**
     * Construct block header
     */
    constructHeader(share, job) {
        const header = Buffer.alloc(80);
        
        // Version
        header.writeUInt32LE(job.version || 0x20000000, 0);
        
        // Previous block hash
        Buffer.from(job.prevHash || job.previousblockhash, 'hex').reverse().copy(header, 4);
        
        // Merkle root - needs to be calculated with coinbase
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
     * Calculate merkle root with coinbase
     */
    calculateMerkleRoot(share, job) {
        // Construct coinbase
        const coinbase = Buffer.concat([
            Buffer.from(job.coinbase1, 'hex'),
            Buffer.from(share.extraNonce1, 'hex'),
            Buffer.from(share.extraNonce2, 'hex'),
            Buffer.from(job.coinbase2, 'hex')
        ]);
        
        // Hash coinbase
        const coinbaseHash = this.sha256d(coinbase);
        
        // Calculate merkle root
        let root = coinbaseHash;
        
        for (const branch of (job.merkleBranch || [])) {
            const branchHash = Buffer.from(branch, 'hex');
            root = this.sha256d(Buffer.concat([root, branchHash]));
        }
        
        return root.reverse();
    }
    
    /**
     * Calculate double SHA-256 hash
     */
    calculateHash(data) {
        return this.sha256d(data).reverse();
    }
    
    /**
     * SHA256d helper
     */
    sha256d(data) {
        return createHash('sha256')
            .update(createHash('sha256').update(data).digest())
            .digest();
    }
    
    /**
     * Convert difficulty to target
     */
    difficultyToTarget(difficulty) {
        const target = this.maxTargetBigInt / BigInt(Math.floor(difficulty));
        return target.toString(16).padStart(64, '0');
    }
    
    /**
     * Create cache key for share
     */
    createShareKey(share) {
        return `${share.jobId}:${share.extraNonce2}:${share.ntime}:${share.nonce}`;
    }
    
    /**
     * Cache validation result
     */
    cacheResult(key, result) {
        this.validationCache.set(key, {
            ...result,
            cachedAt: Date.now()
        });
        
        // Cleanup old entries
        if (this.validationCache.size > this.config.cacheSize) {
            const toDelete = this.validationCache.size - this.config.cacheSize;
            const keys = Array.from(this.validationCache.keys());
            
            for (let i = 0; i < toDelete; i++) {
                this.validationCache.delete(keys[i]);
            }
        }
    }
    
    /**
     * Update statistics
     */
    updateStats(result, validationTime) {
        this.stats.totalValidated++;
        
        if (result.valid) {
            this.stats.validShares++;
            if (result.isBlock) {
                this.stats.blocksFound++;
            }
        } else {
            this.stats.invalidShares++;
        }
        
        // Update average validation time
        this.stats.avgValidationTime = 
            (this.stats.avgValidationTime * (this.stats.totalValidated - 1) + validationTime) / 
            this.stats.totalValidated;
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
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            cacheSize: this.validationCache.size,
            queueSize: this.shareQueue.length,
            workers: this.workers.map(w => ({
                id: w.id,
                busy: w.busy,
                jobCount: w.jobCount
            }))
        };
    }
    
    /**
     * Clear cache
     */
    clearCache() {
        this.validationCache.clear();
        this.cacheHits = 0;
        this.cacheMisses = 0;
    }
    
    /**
     * Shutdown validator
     */
    async shutdown() {
        // Clear queue
        this.shareQueue.forEach(item => {
            item.reject(new Error('Validator shutting down'));
        });
        this.shareQueue = [];
        
        // Terminate workers
        for (const worker of this.workers) {
            await worker.worker.terminate();
        }
        
        this.workers = [];
        
        logger.info('Share validator shut down');
    }
}

export default OptimizedShareValidator;