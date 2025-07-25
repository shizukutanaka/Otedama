/**
 * Optimized Worker for Performance-Critical Tasks
 * 高性能タスク用の最適化されたワーカー
 */

const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

class OptimizedWorker {
    constructor(config) {
        this.id = config.id;
        this.config = config.config || {};
        
        // Performance metrics
        this.metrics = {
            tasksCompleted: 0,
            tasksFailed: 0,
            cpuTime: 0,
            memoryUsage: 0,
            averageTaskTime: 0
        };
        
        // Task handlers
        this.taskHandlers = {
            'cpu-intensive': this.handleCPUIntensiveTask.bind(this),
            'memory-intensive': this.handleMemoryIntensiveTask.bind(this),
            'io-intensive': this.handleIOIntensiveTask.bind(this),
            'crypto': this.handleCryptoTask.bind(this),
            'mining': this.handleMiningTask.bind(this),
            'validation': this.handleValidationTask.bind(this),
            'compression': this.handleCompressionTask.bind(this),
            'performance-test': this.handlePerformanceTest.bind(this),
            'batch': this.handleBatchTasks.bind(this),
            'cache-warmup': this.handleCacheWarmup.bind(this)
        };
        
        // Initialize worker
        this.initialize();
    }
    
    initialize() {
        // Set up message handler
        parentPort.on('message', async (message) => {
            await this.handleMessage(message);
        });
        
        // Send ready signal
        parentPort.postMessage({
            type: 'ready',
            workerId: this.id
        });
        
        // Start metrics reporting
        this.startMetricsReporting();
    }
    
    async handleMessage(message) {
        const startTime = performance.now();
        const startCPU = process.cpuUsage();
        
        try {
            let result;
            
            if (message.type === 'task') {
                result = await this.executeTask(message.task);
            } else if (message.type === 'batch') {
                result = await this.executeBatch(message.tasks);
            } else {
                throw new Error(`Unknown message type: ${message.type}`);
            }
            
            // Calculate metrics
            const endTime = performance.now();
            const endCPU = process.cpuUsage(startCPU);
            const taskTime = endTime - startTime;
            const cpuTime = (endCPU.user + endCPU.system) / 1000; // Convert to ms
            
            // Update metrics
            this.metrics.tasksCompleted++;
            this.metrics.cpuTime += cpuTime;
            this.metrics.averageTaskTime = 
                (this.metrics.averageTaskTime * (this.metrics.tasksCompleted - 1) + taskTime) / 
                this.metrics.tasksCompleted;
            
            // Send result
            parentPort.postMessage({
                type: 'result',
                taskId: message.task?.id || message.id,
                result,
                metrics: {
                    taskTime,
                    cpuTime,
                    memoryUsage: process.memoryUsage().heapUsed
                }
            });
            
        } catch (error) {
            this.metrics.tasksFailed++;
            
            parentPort.postMessage({
                type: 'result',
                taskId: message.task?.id || message.id,
                error: error.message,
                stack: error.stack
            });
        }
    }
    
    async executeTask(task) {
        const handler = this.taskHandlers[task.type];
        
        if (!handler) {
            throw new Error(`Unknown task type: ${task.type}`);
        }
        
        return await handler(task.data || {});
    }
    
    async executeBatch(tasks) {
        const results = [];
        
        for (const task of tasks) {
            try {
                const result = await this.executeTask(task);
                results.push({ success: true, result });
            } catch (error) {
                results.push({ success: false, error: error.message });
            }
        }
        
        return results;
    }
    
    /**
     * Task Handlers
     */
    
    async handleCPUIntensiveTask(data) {
        const { iterations = 1000000 } = data;
        let result = 0;
        
        // Simulate CPU-intensive work
        for (let i = 0; i < iterations; i++) {
            result += Math.sqrt(i) * Math.sin(i);
            
            // Yield periodically to prevent blocking
            if (i % 10000 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        
        return { result, iterations };
    }
    
    async handleMemoryIntensiveTask(data) {
        const { size = 10 * 1024 * 1024 } = data; // 10MB default
        const buffers = [];
        const chunkSize = 1024 * 1024; // 1MB chunks
        
        // Allocate memory in chunks
        for (let allocated = 0; allocated < size; allocated += chunkSize) {
            const buffer = Buffer.allocUnsafe(Math.min(chunkSize, size - allocated));
            
            // Fill with random data
            crypto.randomFillSync(buffer);
            
            buffers.push(buffer);
            
            // Yield control
            await new Promise(resolve => setImmediate(resolve));
        }
        
        // Process buffers
        let checksum = 0;
        for (const buffer of buffers) {
            for (let i = 0; i < buffer.length; i++) {
                checksum ^= buffer[i];
            }
        }
        
        return {
            allocated: size,
            chunks: buffers.length,
            checksum
        };
    }
    
    async handleIOIntensiveTask(data) {
        const { operations = 1000 } = data;
        const results = [];
        
        for (let i = 0; i < operations; i++) {
            // Simulate I/O operation
            const hash = crypto.createHash('sha256');
            hash.update(`data-${i}-${Date.now()}`);
            results.push(hash.digest('hex'));
            
            // Yield periodically
            if (i % 100 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        
        return {
            operations,
            results: results.slice(0, 10), // Return sample
            totalResults: results.length
        };
    }
    
    async handleCryptoTask(data) {
        const { 
            operation = 'hash',
            algorithm = 'sha256',
            input = 'test-data',
            iterations = 1
        } = data;
        
        let result;
        
        switch (operation) {
            case 'hash':
                result = input;
                for (let i = 0; i < iterations; i++) {
                    const hash = crypto.createHash(algorithm);
                    hash.update(result);
                    result = hash.digest('hex');
                }
                break;
                
            case 'hmac':
                const key = crypto.randomBytes(32);
                result = input;
                for (let i = 0; i < iterations; i++) {
                    const hmac = crypto.createHmac(algorithm, key);
                    hmac.update(result);
                    result = hmac.digest('hex');
                }
                break;
                
            case 'pbkdf2':
                const salt = crypto.randomBytes(16);
                result = await new Promise((resolve, reject) => {
                    crypto.pbkdf2(input, salt, iterations, 32, algorithm, (err, derivedKey) => {
                        if (err) reject(err);
                        else resolve(derivedKey.toString('hex'));
                    });
                });
                break;
                
            default:
                throw new Error(`Unknown crypto operation: ${operation}`);
        }
        
        return { operation, algorithm, iterations, result };
    }
    
    async handleMiningTask(data) {
        const {
            blockHeader = '',
            target = '0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
            startNonce = 0,
            maxNonce = 1000000
        } = data;
        
        let nonce = startNonce;
        let found = false;
        let hash = '';
        
        // Convert target to buffer for comparison
        const targetBuffer = Buffer.from(target, 'hex');
        
        while (nonce < maxNonce && !found) {
            // Create hash of block header + nonce
            const hashInput = blockHeader + nonce.toString();
            const hashBuffer = crypto.createHash('sha256')
                .update(crypto.createHash('sha256').update(hashInput).digest())
                .digest();
            
            // Check if hash meets target
            if (hashBuffer.compare(targetBuffer) <= 0) {
                found = true;
                hash = hashBuffer.toString('hex');
            }
            
            nonce++;
            
            // Yield periodically
            if (nonce % 10000 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        
        return {
            found,
            nonce: found ? nonce - 1 : maxNonce,
            hash,
            attempts: nonce - startNonce
        };
    }
    
    async handleValidationTask(data) {
        const { 
            type = 'transaction',
            payload,
            rules = {}
        } = data;
        
        const errors = [];
        let valid = true;
        
        switch (type) {
            case 'transaction':
                // Validate transaction
                if (!payload.from || !payload.to) {
                    errors.push('Missing from/to address');
                    valid = false;
                }
                if (!payload.amount || payload.amount <= 0) {
                    errors.push('Invalid amount');
                    valid = false;
                }
                if (!payload.signature) {
                    errors.push('Missing signature');
                    valid = false;
                }
                break;
                
            case 'block':
                // Validate block
                if (!payload.hash || !payload.previousHash) {
                    errors.push('Missing hash fields');
                    valid = false;
                }
                if (!payload.transactions || !Array.isArray(payload.transactions)) {
                    errors.push('Invalid transactions');
                    valid = false;
                }
                if (!payload.nonce || !payload.timestamp) {
                    errors.push('Missing nonce or timestamp');
                    valid = false;
                }
                break;
                
            case 'share':
                // Validate mining share
                if (!payload.minerId || !payload.jobId) {
                    errors.push('Missing miner/job ID');
                    valid = false;
                }
                if (!payload.nonce || !payload.hash) {
                    errors.push('Missing nonce or hash');
                    valid = false;
                }
                break;
                
            default:
                errors.push(`Unknown validation type: ${type}`);
                valid = false;
        }
        
        // Apply custom rules
        for (const [field, rule] of Object.entries(rules)) {
            if (rule.required && !payload[field]) {
                errors.push(`Missing required field: ${field}`);
                valid = false;
            }
            if (rule.min && payload[field] < rule.min) {
                errors.push(`${field} below minimum: ${rule.min}`);
                valid = false;
            }
            if (rule.max && payload[field] > rule.max) {
                errors.push(`${field} above maximum: ${rule.max}`);
                valid = false;
            }
        }
        
        return { valid, errors, type };
    }
    
    async handleCompressionTask(data) {
        const { 
            input = '',
            algorithm = 'gzip',
            operation = 'compress'
        } = data;
        
        const zlib = require('zlib');
        let result;
        
        const inputBuffer = Buffer.from(input);
        
        if (operation === 'compress') {
            switch (algorithm) {
                case 'gzip':
                    result = await new Promise((resolve, reject) => {
                        zlib.gzip(inputBuffer, (err, compressed) => {
                            if (err) reject(err);
                            else resolve(compressed);
                        });
                    });
                    break;
                    
                case 'deflate':
                    result = await new Promise((resolve, reject) => {
                        zlib.deflate(inputBuffer, (err, compressed) => {
                            if (err) reject(err);
                            else resolve(compressed);
                        });
                    });
                    break;
                    
                case 'brotli':
                    result = await new Promise((resolve, reject) => {
                        zlib.brotliCompress(inputBuffer, (err, compressed) => {
                            if (err) reject(err);
                            else resolve(compressed);
                        });
                    });
                    break;
                    
                default:
                    throw new Error(`Unknown compression algorithm: ${algorithm}`);
            }
        } else {
            // Decompression
            switch (algorithm) {
                case 'gzip':
                    result = await new Promise((resolve, reject) => {
                        zlib.gunzip(inputBuffer, (err, decompressed) => {
                            if (err) reject(err);
                            else resolve(decompressed);
                        });
                    });
                    break;
                    
                case 'deflate':
                    result = await new Promise((resolve, reject) => {
                        zlib.inflate(inputBuffer, (err, decompressed) => {
                            if (err) reject(err);
                            else resolve(decompressed);
                        });
                    });
                    break;
                    
                case 'brotli':
                    result = await new Promise((resolve, reject) => {
                        zlib.brotliDecompress(inputBuffer, (err, decompressed) => {
                            if (err) reject(err);
                            else resolve(decompressed);
                        });
                    });
                    break;
                    
                default:
                    throw new Error(`Unknown decompression algorithm: ${algorithm}`);
            }
        }
        
        return {
            algorithm,
            operation,
            originalSize: inputBuffer.length,
            resultSize: result.length,
            ratio: operation === 'compress' ? 
                (1 - result.length / inputBuffer.length).toFixed(2) :
                (result.length / inputBuffer.length).toFixed(2)
        };
    }
    
    async handlePerformanceTest(data) {
        const { test } = data;
        
        switch (test.type) {
            case 'cpu-intensive':
                return await this.handleCPUIntensiveTask({ 
                    iterations: test.iterations || 1000000 
                });
                
            case 'memory-intensive':
                return await this.handleMemoryIntensiveTask({ 
                    size: test.size || 100 * 1024 * 1024 
                });
                
            case 'io-intensive':
                return await this.handleIOIntensiveTask({ 
                    operations: test.operations || 1000 
                });
                
            case 'parallel':
                const tasks = [];
                for (let i = 0; i < (test.tasks || 100); i++) {
                    tasks.push({
                        type: 'crypto',
                        data: {
                            operation: 'hash',
                            input: `test-${i}`,
                            iterations: 100
                        }
                    });
                }
                return await this.executeBatch(tasks);
                
            default:
                throw new Error(`Unknown performance test: ${test.type}`);
        }
    }
    
    async handleCacheWarmup(data) {
        const { item } = data;
        
        // Simulate cache warmup
        const cacheKey = crypto.createHash('md5').update(JSON.stringify(item)).digest('hex');
        const cacheValue = {
            key: cacheKey,
            data: item,
            timestamp: Date.now(),
            hits: 0
        };
        
        // Simulate data processing
        await new Promise(resolve => setTimeout(resolve, 10));
        
        return {
            cached: true,
            key: cacheKey,
            size: JSON.stringify(cacheValue).length
        };
    }
    
    /**
     * Metrics reporting
     */
    startMetricsReporting() {
        setInterval(() => {
            const memUsage = process.memoryUsage();
            
            this.metrics.memoryUsage = memUsage.heapUsed;
            
            parentPort.postMessage({
                type: 'metrics',
                metrics: {
                    ...this.metrics,
                    uptime: process.uptime(),
                    memory: {
                        heapUsed: memUsage.heapUsed,
                        heapTotal: memUsage.heapTotal,
                        external: memUsage.external,
                        rss: memUsage.rss
                    }
                }
            });
        }, 10000); // Every 10 seconds
    }
}

// Create and start worker
const worker = new OptimizedWorker(workerData);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Worker uncaught exception:', error);
    parentPort.postMessage({
        type: 'error',
        error: error.message,
        stack: error.stack
    });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Worker unhandled rejection:', reason);
    parentPort.postMessage({
        type: 'error',
        error: 'Unhandled rejection',
        reason: reason?.message || reason
    });
});