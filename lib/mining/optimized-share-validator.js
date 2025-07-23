const EventEmitter = require('events');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const os = require('os');

/**
 * Optimized Share Validator
 * High-performance share validation with parallel processing
 */
class OptimizedShareValidator extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            // Performance settings
            workerThreads: options.workerThreads || os.cpus().length,
            validationTimeout: options.validationTimeout || 5000, // 5 seconds
            batchSize: options.batchSize || 100,
            cacheSize: options.cacheSize || 10000,
            
            // Validation rules
            maxExtraNonceSize: options.maxExtraNonceSize || 8,
            shareTargetBuffer: options.shareTargetBuffer || 16,
            duplicateWindow: options.duplicateWindow || 3600000, // 1 hour
            
            // Algorithm support
            algorithms: options.algorithms || ['sha256', 'scrypt', 'ethash'],
            
            // Security
            rejectStaleShares: options.rejectStaleShares !== false,
            validateTimestamp: options.validateTimestamp !== false,
            maxTimeDrift: options.maxTimeDrift || 7200, // 2 hours
            
            ...options
        };
        
        this.workers = [];
        this.validationQueue = [];
        this.shareCache = new Map();
        this.duplicateCache = new Map();
        this.jobCache = new Map();
        
        this.stats = {
            totalValidated: 0,
            validShares: 0,
            invalidShares: 0,
            duplicateShares: 0,
            staleShares: 0,
            averageValidationTime: 0
        };
        
        this.initialize();
    }
    
    /**
     * Initialize validator
     */
    async initialize() {
        // Create worker threads
        for (let i = 0; i < this.options.workerThreads; i++) {
            const worker = await this.createWorker();
            this.workers.push(worker);
        }
        
        // Start batch processor
        this.startBatchProcessor();
        
        // Setup cleanup
        this.setupCleanup();
        
        this.emit('initialized', {
            workers: this.workers.length,
            algorithms: this.options.algorithms
        });
    }
    
    /**
     * Create worker thread
     */
    async createWorker() {
        const workerCode = `
            const { parentPort } = require('worker_threads');
            const crypto = require('crypto');
            
            // Algorithm implementations
            const algorithms = {
                sha256: require('./algorithms/sha256'),
                scrypt: require('./algorithms/scrypt'),
                ethash: require('./algorithms/ethash')
            };
            
            parentPort.on('message', async ({ id, type, data }) => {
                try {
                    let result;
                    
                    switch (type) {
                        case 'validate':
                            result = await validateShare(data);
                            break;
                        case 'batch':
                            result = await validateBatch(data);
                            break;
                        default:
                            throw new Error('Unknown message type');
                    }
                    
                    parentPort.postMessage({ id, success: true, result });
                } catch (error) {
                    parentPort.postMessage({ id, success: false, error: error.message });
                }
            });
            
            async function validateShare(share) {
                const { algorithm, job, nonce, extraNonce, timestamp } = share;
                
                // Get algorithm implementation
                const algo = algorithms[algorithm];
                if (!algo) {
                    throw new Error('Unsupported algorithm: ' + algorithm);
                }
                
                // Construct block header
                const header = constructHeader(job, nonce, extraNonce, timestamp);
                
                // Calculate hash
                const hash = await algo.hash(header);
                
                // Check if meets target
                const meetsTarget = checkTarget(hash, job.target);
                const meetsShareTarget = checkTarget(hash, job.shareTarget);
                
                return {
                    hash: hash.toString('hex'),
                    meetsTarget,
                    meetsShareTarget,
                    difficulty: calculateDifficulty(hash)
                };
            }
            
            async function validateBatch(shares) {
                const results = [];
                
                for (const share of shares) {
                    try {
                        const result = await validateShare(share);
                        results.push({ id: share.id, success: true, result });
                    } catch (error) {
                        results.push({ id: share.id, success: false, error: error.message });
                    }
                }
                
                return results;
            }
            
            function constructHeader(job, nonce, extraNonce, timestamp) {
                // Implement header construction based on algorithm
                return Buffer.concat([
                    Buffer.from(job.prevHash, 'hex'),
                    Buffer.from(job.merkleRoot, 'hex'),
                    Buffer.from(timestamp.toString(16).padStart(8, '0'), 'hex'),
                    Buffer.from(job.bits, 'hex'),
                    Buffer.from(nonce, 'hex'),
                    Buffer.from(extraNonce, 'hex')
                ]);
            }
            
            function checkTarget(hash, target) {
                // Compare hash with target
                const hashBN = BigInt('0x' + hash.toString('hex'));
                const targetBN = BigInt('0x' + target);
                return hashBN <= targetBN;
            }
            
            function calculateDifficulty(hash) {
                // Calculate share difficulty
                const hashBN = BigInt('0x' + hash.toString('hex'));
                const maxTarget = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
                return Number(maxTarget / hashBN);
            }
        `;
        
        const worker = new Worker(workerCode, { eval: true });
        
        return new Promise((resolve, reject) => {
            worker.once('online', () => resolve(worker));
            worker.once('error', reject);
        });
    }
    
    /**
     * Validate share
     */
    async validateShare(share) {
        const validationStart = Date.now();
        
        try {
            this.stats.totalValidated++;
            
            // Quick validations first
            const quickCheck = this.quickValidation(share);
            if (!quickCheck.valid) {
                this.stats.invalidShares++;
                this.emit('share-rejected', {
                    share,
                    reason: quickCheck.reason,
                    validationTime: Date.now() - validationStart
                });
                return quickCheck;
            }
            
            // Check cache
            const cacheKey = this.getShareCacheKey(share);
            const cached = this.shareCache.get(cacheKey);
            if (cached) {
                return cached;
            }
            
            // Add to validation queue
            const result = await this.queueValidation(share);
            
            // Update stats
            if (result.valid) {
                this.stats.validShares++;
                this.emit('share-accepted', {
                    share,
                    difficulty: result.difficulty,
                    validationTime: Date.now() - validationStart
                });
            } else {
                this.stats.invalidShares++;
                this.emit('share-rejected', {
                    share,
                    reason: result.reason,
                    validationTime: Date.now() - validationStart
                });
            }
            
            // Update average validation time
            this.updateAverageValidationTime(Date.now() - validationStart);
            
            // Cache result
            this.shareCache.set(cacheKey, result);
            
            return result;
            
        } catch (error) {
            console.error('Share validation error:', error);
            this.stats.invalidShares++;
            return {
                valid: false,
                reason: 'Validation error',
                error: error.message
            };
        }
    }
    
    /**
     * Quick validation checks
     */
    quickValidation(share) {
        // Check required fields
        if (!share.jobId || !share.nonce || !share.extraNonce) {
            return { valid: false, reason: 'Missing required fields' };
        }
        
        // Check job exists
        const job = this.jobCache.get(share.jobId);
        if (!job) {
            this.stats.staleShares++;
            return { valid: false, reason: 'Unknown job' };
        }
        
        // Check if stale
        if (this.options.rejectStaleShares && job.stale) {
            this.stats.staleShares++;
            return { valid: false, reason: 'Stale share' };
        }
        
        // Validate timestamp
        if (this.options.validateTimestamp) {
            const now = Math.floor(Date.now() / 1000);
            const drift = Math.abs(share.timestamp - now);
            
            if (drift > this.options.maxTimeDrift) {
                return { valid: false, reason: 'Invalid timestamp' };
            }
        }
        
        // Check for duplicates
        if (this.isDuplicate(share)) {
            this.stats.duplicateShares++;
            return { valid: false, reason: 'Duplicate share' };
        }
        
        // Check nonce size
        if (share.extraNonce.length > this.options.maxExtraNonceSize * 2) {
            return { valid: false, reason: 'Invalid extranonce size' };
        }
        
        return { valid: true };
    }
    
    /**
     * Check if share is duplicate
     */
    isDuplicate(share) {
        const key = `${share.jobId}:${share.nonce}:${share.extraNonce}`;
        
        if (this.duplicateCache.has(key)) {
            return true;
        }
        
        // Add to duplicate cache with expiration
        this.duplicateCache.set(key, Date.now());
        
        return false;
    }
    
    /**
     * Queue share for validation
     */
    async queueValidation(share) {
        return new Promise((resolve, reject) => {
            const validationRequest = {
                id: crypto.randomUUID(),
                share,
                resolve,
                reject,
                timestamp: Date.now()
            };
            
            this.validationQueue.push(validationRequest);
            
            // Set timeout
            setTimeout(() => {
                reject(new Error('Validation timeout'));
            }, this.options.validationTimeout);
        });
    }
    
    /**
     * Start batch processor
     */
    startBatchProcessor() {
        setInterval(() => {
            if (this.validationQueue.length === 0) return;
            
            // Get batch
            const batch = this.validationQueue.splice(0, this.options.batchSize);
            
            // Find available worker
            const worker = this.getAvailableWorker();
            if (!worker) {
                // Put back in queue
                this.validationQueue.unshift(...batch);
                return;
            }
            
            // Process batch
            this.processBatch(worker, batch);
            
        }, 10); // Check every 10ms
    }
    
    /**
     * Process validation batch
     */
    async processBatch(worker, batch) {
        const messageId = crypto.randomUUID();
        
        const shares = batch.map(req => ({
            id: req.id,
            ...req.share,
            job: this.jobCache.get(req.share.jobId)
        }));
        
        // Send to worker
        worker.postMessage({
            id: messageId,
            type: 'batch',
            data: shares
        });
        
        // Handle response
        worker.once('message', ({ id, success, result, error }) => {
            if (id !== messageId) return;
            
            if (success) {
                // Process results
                for (const shareResult of result) {
                    const request = batch.find(r => r.id === shareResult.id);
                    
                    if (request) {
                        if (shareResult.success) {
                            const validation = {
                                valid: shareResult.result.meetsShareTarget,
                                hash: shareResult.result.hash,
                                difficulty: shareResult.result.difficulty,
                                blockFound: shareResult.result.meetsTarget
                            };
                            
                            if (!validation.valid) {
                                validation.reason = 'Below share target';
                            }
                            
                            request.resolve(validation);
                        } else {
                            request.resolve({
                                valid: false,
                                reason: shareResult.error
                            });
                        }
                    }
                }
            } else {
                // Reject all requests in batch
                for (const request of batch) {
                    request.reject(new Error(error));
                }
            }
            
            // Mark worker as available
            worker.busy = false;
        });
        
        // Mark worker as busy
        worker.busy = true;
    }
    
    /**
     * Get available worker
     */
    getAvailableWorker() {
        return this.workers.find(w => !w.busy);
    }
    
    /**
     * Get share cache key
     */
    getShareCacheKey(share) {
        return `${share.jobId}:${share.nonce}:${share.extraNonce}:${share.timestamp}`;
    }
    
    /**
     * Update average validation time
     */
    updateAverageValidationTime(time) {
        const alpha = 0.1; // Exponential moving average factor
        this.stats.averageValidationTime = 
            alpha * time + (1 - alpha) * this.stats.averageValidationTime;
    }
    
    /**
     * Add job for validation
     */
    addJob(job) {
        this.jobCache.set(job.id, {
            ...job,
            added: Date.now(),
            stale: false
        });
        
        this.emit('job-added', job);
    }
    
    /**
     * Mark job as stale
     */
    markJobStale(jobId) {
        const job = this.jobCache.get(jobId);
        if (job) {
            job.stale = true;
        }
    }
    
    /**
     * Setup cleanup tasks
     */
    setupCleanup() {
        // Clean duplicate cache
        setInterval(() => {
            const cutoff = Date.now() - this.options.duplicateWindow;
            
            for (const [key, timestamp] of this.duplicateCache) {
                if (timestamp < cutoff) {
                    this.duplicateCache.delete(key);
                }
            }
        }, 60000); // Every minute
        
        // Clean share cache
        setInterval(() => {
            if (this.shareCache.size > this.options.cacheSize) {
                // Remove oldest entries
                const entries = Array.from(this.shareCache.entries());
                const toRemove = entries.slice(0, entries.length - this.options.cacheSize);
                
                for (const [key] of toRemove) {
                    this.shareCache.delete(key);
                }
            }
        }, 30000); // Every 30 seconds
        
        // Clean old jobs
        setInterval(() => {
            const cutoff = Date.now() - 3600000; // 1 hour
            
            for (const [id, job] of this.jobCache) {
                if (job.added < cutoff) {
                    this.jobCache.delete(id);
                }
            }
        }, 300000); // Every 5 minutes
    }
    
    /**
     * Get statistics
     */
    getStats() {
        const total = this.stats.totalValidated || 1;
        
        return {
            ...this.stats,
            validationRate: this.stats.validShares / total * 100,
            rejectionRate: this.stats.invalidShares / total * 100,
            duplicateRate: this.stats.duplicateShares / total * 100,
            staleRate: this.stats.staleShares / total * 100,
            cacheSize: this.shareCache.size,
            queueLength: this.validationQueue.length,
            busyWorkers: this.workers.filter(w => w.busy).length
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
        
        this.emit('shutdown');
    }
}

module.exports = OptimizedShareValidator;