/**
 * High-Performance Message Queue System
 * 高性能メッセージキューシステム
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

class MessageQueueSystem extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            // Queue configuration
            maxQueueSize: config.maxQueueSize || 10000,
            maxMessageSize: config.maxMessageSize || 1024 * 1024, // 1MB
            defaultTTL: config.defaultTTL || 3600000, // 1 hour
            
            // Processing configuration
            concurrency: config.concurrency || 10,
            batchSize: config.batchSize || 100,
            processingTimeout: config.processingTimeout || 30000,
            
            // Persistence
            enablePersistence: config.enablePersistence || false,
            persistenceInterval: config.persistenceInterval || 5000,
            persistencePath: config.persistencePath || './queue-data',
            
            // Dead letter queue
            enableDeadLetterQueue: config.enableDeadLetterQueue !== false,
            maxRetries: config.maxRetries || 3,
            deadLetterTTL: config.deadLetterTTL || 86400000, // 24 hours
            
            // Priority queue
            enablePriority: config.enablePriority !== false,
            priorityLevels: config.priorityLevels || 5,
            
            // Deduplication
            enableDeduplication: config.enableDeduplication || false,
            deduplicationWindow: config.deduplicationWindow || 60000, // 1 minute
            
            // Rate limiting
            enableRateLimiting: config.enableRateLimiting || false,
            rateLimit: config.rateLimit || 1000, // messages per second
            
            // Monitoring
            enableMonitoring: config.enableMonitoring !== false,
            monitoringInterval: config.monitoringInterval || 5000,
            
            ...config
        };
        
        // Queues
        this.queues = new Map();
        this.deadLetterQueue = [];
        this.priorityQueues = [];
        
        // Processing state
        this.processors = new Map();
        this.activeJobs = new Map();
        this.processingCount = 0;
        
        // Deduplication
        this.messageHashes = new Map();
        
        // Statistics
        this.stats = {
            enqueued: 0,
            processed: 0,
            failed: 0,
            deadLettered: 0,
            duplicates: 0,
            expired: 0,
            currentSize: 0,
            peakSize: 0
        };
        
        // Initialize
        this.initialize();
    }
    
    initialize() {
        console.log('メッセージキューシステムを初期化中...');
        
        // Initialize priority queues
        if (this.config.enablePriority) {
            for (let i = 0; i < this.config.priorityLevels; i++) {
                this.priorityQueues[i] = [];
            }
        }
        
        // Start persistence
        if (this.config.enablePersistence) {
            this.startPersistence();
        }
        
        // Start monitoring
        if (this.config.enableMonitoring) {
            this.startMonitoring();
        }
        
        // Start cleanup
        this.startCleanup();
        
        console.log('✓ メッセージキューシステムの初期化完了');
    }
    
    /**
     * Create or get a queue
     */
    createQueue(name, options = {}) {
        if (!this.queues.has(name)) {
            const queue = new Queue(name, {
                ...this.config,
                ...options
            });
            
            this.queues.set(name, queue);
            
            this.emit('queue-created', { name, options });
        }
        
        return this.queues.get(name);
    }
    
    /**
     * Enqueue a message
     */
    async enqueue(queueName, message, options = {}) {
        const queue = this.createQueue(queueName);
        
        // Validate message
        if (!this.validateMessage(message)) {
            throw new Error('Invalid message');
        }
        
        // Check deduplication
        if (this.config.enableDeduplication && await this.isDuplicate(message)) {
            this.stats.duplicates++;
            return null;
        }
        
        // Check rate limit
        if (this.config.enableRateLimiting && !this.checkRateLimit()) {
            throw new Error('Rate limit exceeded');
        }
        
        // Create message wrapper
        const messageWrapper = {
            id: this.generateMessageId(),
            queue: queueName,
            payload: message,
            priority: options.priority || 0,
            timestamp: Date.now(),
            ttl: options.ttl || this.config.defaultTTL,
            retries: 0,
            headers: options.headers || {},
            correlationId: options.correlationId || null
        };
        
        // Add to queue
        const enqueued = await queue.enqueue(messageWrapper);
        
        if (enqueued) {
            this.stats.enqueued++;
            this.updateQueueSize();
            
            // Track for deduplication
            if (this.config.enableDeduplication) {
                this.trackMessage(messageWrapper);
            }
            
            this.emit('message-enqueued', {
                queue: queueName,
                messageId: messageWrapper.id
            });
            
            // Trigger processing if processors are waiting
            this.triggerProcessing(queueName);
        }
        
        return messageWrapper.id;
    }
    
    /**
     * Register a message processor
     */
    registerProcessor(queueName, processor, options = {}) {
        const processorConfig = {
            fn: processor,
            concurrency: options.concurrency || this.config.concurrency,
            ...options
        };
        
        if (!this.processors.has(queueName)) {
            this.processors.set(queueName, []);
        }
        
        this.processors.get(queueName).push(processorConfig);
        
        // Start processing
        for (let i = 0; i < processorConfig.concurrency; i++) {
            this.startProcessor(queueName, processorConfig);
        }
        
        this.emit('processor-registered', { queue: queueName });
    }
    
    /**
     * Start a processor instance
     */
    async startProcessor(queueName, processorConfig) {
        const queue = this.queues.get(queueName);
        if (!queue) return;
        
        while (true) {
            try {
                // Check concurrency limit
                if (this.processingCount >= this.config.concurrency) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    continue;
                }
                
                // Get next message
                const message = await this.getNextMessage(queueName);
                if (!message) {
                    // No messages, wait
                    await new Promise(resolve => {
                        const cleanup = () => {
                            this.removeListener('message-enqueued', checkQueue);
                            clearTimeout(timeout);
                        };
                        
                        const checkQueue = (event) => {
                            if (event.queue === queueName) {
                                cleanup();
                                resolve();
                            }
                        };
                        
                        const timeout = setTimeout(() => {
                            cleanup();
                            resolve();
                        }, 1000);
                        
                        this.once('message-enqueued', checkQueue);
                    });
                    continue;
                }
                
                // Process message
                await this.processMessage(message, processorConfig);
                
            } catch (error) {
                console.error(`プロセッサーエラー (${queueName}):`, error);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    /**
     * Get next message from queue
     */
    async getNextMessage(queueName) {
        const queue = this.queues.get(queueName);
        if (!queue) return null;
        
        // Try priority queues first
        if (this.config.enablePriority) {
            for (let priority = this.config.priorityLevels - 1; priority >= 0; priority--) {
                const message = queue.dequeuePriority(priority);
                if (message) return message;
            }
        }
        
        // Regular dequeue
        return queue.dequeue();
    }
    
    /**
     * Process a message
     */
    async processMessage(message, processorConfig) {
        const jobId = this.generateJobId();
        this.processingCount++;
        
        const job = {
            id: jobId,
            message,
            startTime: Date.now(),
            processor: processorConfig
        };
        
        this.activeJobs.set(jobId, job);
        
        try {
            // Set timeout
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Processing timeout')), 
                    this.config.processingTimeout);
            });
            
            // Process message
            const result = await Promise.race([
                processorConfig.fn(message.payload, message),
                timeoutPromise
            ]);
            
            // Success
            this.stats.processed++;
            
            this.emit('message-processed', {
                queue: message.queue,
                messageId: message.id,
                duration: Date.now() - job.startTime,
                result
            });
            
        } catch (error) {
            // Failure
            this.stats.failed++;
            message.retries++;
            
            this.emit('message-failed', {
                queue: message.queue,
                messageId: message.id,
                error: error.message,
                retries: message.retries
            });
            
            // Handle retry or dead letter
            if (message.retries < this.config.maxRetries) {
                // Retry with exponential backoff
                const delay = Math.pow(2, message.retries) * 1000;
                setTimeout(() => {
                    this.enqueue(message.queue, message.payload, {
                        ...message,
                        retries: message.retries
                    });
                }, delay);
            } else {
                // Send to dead letter queue
                await this.sendToDeadLetterQueue(message, error);
            }
            
        } finally {
            this.processingCount--;
            this.activeJobs.delete(jobId);
        }
    }
    
    /**
     * Send message to dead letter queue
     */
    async sendToDeadLetterQueue(message, error) {
        if (!this.config.enableDeadLetterQueue) return;
        
        const deadLetter = {
            ...message,
            deadLetteredAt: Date.now(),
            error: error.message,
            ttl: this.config.deadLetterTTL
        };
        
        this.deadLetterQueue.push(deadLetter);
        this.stats.deadLettered++;
        
        this.emit('message-dead-lettered', {
            queue: message.queue,
            messageId: message.id,
            error: error.message
        });
    }
    
    /**
     * Validate message
     */
    validateMessage(message) {
        if (!message) return false;
        
        const size = JSON.stringify(message).length;
        if (size > this.config.maxMessageSize) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Check if message is duplicate
     */
    async isDuplicate(message) {
        const hash = this.hashMessage(message);
        return this.messageHashes.has(hash);
    }
    
    /**
     * Track message for deduplication
     */
    trackMessage(message) {
        const hash = this.hashMessage(message.payload);
        this.messageHashes.set(hash, Date.now());
    }
    
    /**
     * Hash message for deduplication
     */
    hashMessage(message) {
        const str = JSON.stringify(message);
        return crypto.createHash('md5').update(str).digest('hex');
    }
    
    /**
     * Check rate limit
     */
    checkRateLimit() {
        // Simple token bucket implementation
        const now = Date.now();
        if (!this.lastRateLimitCheck) {
            this.lastRateLimitCheck = now;
            this.rateLimitTokens = this.config.rateLimit;
        }
        
        const elapsed = now - this.lastRateLimitCheck;
        const newTokens = (elapsed / 1000) * this.config.rateLimit;
        this.rateLimitTokens = Math.min(
            this.config.rateLimit,
            this.rateLimitTokens + newTokens
        );
        
        this.lastRateLimitCheck = now;
        
        if (this.rateLimitTokens >= 1) {
            this.rateLimitTokens--;
            return true;
        }
        
        return false;
    }
    
    /**
     * Trigger processing for a queue
     */
    triggerProcessing(queueName) {
        // Processing is triggered automatically by waiting processors
    }
    
    /**
     * Generate message ID
     */
    generateMessageId() {
        return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Generate job ID
     */
    generateJobId() {
        return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    
    /**
     * Update queue size statistics
     */
    updateQueueSize() {
        let totalSize = 0;
        
        for (const queue of this.queues.values()) {
            totalSize += queue.size();
        }
        
        totalSize += this.deadLetterQueue.length;
        
        this.stats.currentSize = totalSize;
        this.stats.peakSize = Math.max(this.stats.peakSize, totalSize);
    }
    
    /**
     * Start persistence
     */
    startPersistence() {
        const fs = require('fs').promises;
        const path = require('path');
        
        setInterval(async () => {
            try {
                const data = {
                    queues: {},
                    deadLetterQueue: this.deadLetterQueue,
                    stats: this.stats,
                    timestamp: Date.now()
                };
                
                for (const [name, queue] of this.queues) {
                    data.queues[name] = queue.toJSON();
                }
                
                const filePath = path.join(
                    this.config.persistencePath,
                    'queue-snapshot.json'
                );
                
                await fs.mkdir(this.config.persistencePath, { recursive: true });
                await fs.writeFile(filePath, JSON.stringify(data, null, 2));
                
            } catch (error) {
                console.error('永続化エラー:', error);
            }
        }, this.config.persistenceInterval);
    }
    
    /**
     * Start monitoring
     */
    startMonitoring() {
        setInterval(() => {
            const metrics = this.getMetrics();
            this.emit('metrics', metrics);
        }, this.config.monitoringInterval);
    }
    
    /**
     * Start cleanup tasks
     */
    startCleanup() {
        // Clean expired messages
        setInterval(() => {
            const now = Date.now();
            let expiredCount = 0;
            
            // Clean from queues
            for (const queue of this.queues.values()) {
                expiredCount += queue.cleanExpired(now);
            }
            
            // Clean from dead letter queue
            const beforeDLQ = this.deadLetterQueue.length;
            this.deadLetterQueue = this.deadLetterQueue.filter(msg => {
                return now - msg.deadLetteredAt < msg.ttl;
            });
            expiredCount += beforeDLQ - this.deadLetterQueue.length;
            
            // Clean deduplication hashes
            if (this.config.enableDeduplication) {
                for (const [hash, timestamp] of this.messageHashes) {
                    if (now - timestamp > this.config.deduplicationWindow) {
                        this.messageHashes.delete(hash);
                    }
                }
            }
            
            if (expiredCount > 0) {
                this.stats.expired += expiredCount;
                this.updateQueueSize();
            }
        }, 60000); // Every minute
    }
    
    /**
     * Get queue metrics
     */
    getMetrics() {
        const queueMetrics = {};
        
        for (const [name, queue] of this.queues) {
            queueMetrics[name] = queue.getMetrics();
        }
        
        return {
            stats: this.stats,
            queues: queueMetrics,
            deadLetterQueue: {
                size: this.deadLetterQueue.length,
                oldest: this.deadLetterQueue[0]?.deadLetteredAt
            },
            processing: {
                active: this.processingCount,
                jobs: this.activeJobs.size
            },
            deduplication: {
                trackedHashes: this.messageHashes.size
            }
        };
    }
    
    /**
     * Get queue status
     */
    getQueueStatus(queueName) {
        const queue = this.queues.get(queueName);
        if (!queue) return null;
        
        return queue.getStatus();
    }
    
    /**
     * Pause processing for a queue
     */
    pauseQueue(queueName) {
        const queue = this.queues.get(queueName);
        if (queue) {
            queue.pause();
            this.emit('queue-paused', { queue: queueName });
        }
    }
    
    /**
     * Resume processing for a queue
     */
    resumeQueue(queueName) {
        const queue = this.queues.get(queueName);
        if (queue) {
            queue.resume();
            this.emit('queue-resumed', { queue: queueName });
        }
    }
    
    /**
     * Cleanup
     */
    async cleanup() {
        // Stop all processors
        this.processors.clear();
        
        // Clear all queues
        for (const queue of this.queues.values()) {
            queue.clear();
        }
        
        this.queues.clear();
        this.deadLetterQueue = [];
        this.messageHashes.clear();
    }
}

/**
 * Individual Queue implementation
 */
class Queue {
    constructor(name, config) {
        this.name = name;
        this.config = config;
        this.messages = [];
        this.paused = false;
        
        if (config.enablePriority) {
            this.priorityQueues = [];
            for (let i = 0; i < config.priorityLevels; i++) {
                this.priorityQueues[i] = [];
            }
        }
    }
    
    enqueue(message) {
        if (this.size() >= this.config.maxQueueSize) {
            return false;
        }
        
        if (this.config.enablePriority && message.priority > 0) {
            const priority = Math.min(message.priority, this.config.priorityLevels - 1);
            this.priorityQueues[priority].push(message);
        } else {
            this.messages.push(message);
        }
        
        return true;
    }
    
    dequeue() {
        if (this.paused) return null;
        return this.messages.shift() || null;
    }
    
    dequeuePriority(priority) {
        if (this.paused) return null;
        if (!this.config.enablePriority) return null;
        
        return this.priorityQueues[priority]?.shift() || null;
    }
    
    size() {
        let total = this.messages.length;
        
        if (this.config.enablePriority) {
            for (const pq of this.priorityQueues) {
                total += pq.length;
            }
        }
        
        return total;
    }
    
    cleanExpired(now) {
        let expired = 0;
        
        // Clean regular queue
        const beforeMain = this.messages.length;
        this.messages = this.messages.filter(msg => {
            return now - msg.timestamp < msg.ttl;
        });
        expired += beforeMain - this.messages.length;
        
        // Clean priority queues
        if (this.config.enablePriority) {
            for (let i = 0; i < this.priorityQueues.length; i++) {
                const before = this.priorityQueues[i].length;
                this.priorityQueues[i] = this.priorityQueues[i].filter(msg => {
                    return now - msg.timestamp < msg.ttl;
                });
                expired += before - this.priorityQueues[i].length;
            }
        }
        
        return expired;
    }
    
    pause() {
        this.paused = true;
    }
    
    resume() {
        this.paused = false;
    }
    
    clear() {
        this.messages = [];
        if (this.config.enablePriority) {
            for (let i = 0; i < this.priorityQueues.length; i++) {
                this.priorityQueues[i] = [];
            }
        }
    }
    
    getMetrics() {
        const metrics = {
            size: this.size(),
            paused: this.paused,
            oldest: this.messages[0]?.timestamp
        };
        
        if (this.config.enablePriority) {
            metrics.priorityDistribution = {};
            for (let i = 0; i < this.priorityQueues.length; i++) {
                metrics.priorityDistribution[i] = this.priorityQueues[i].length;
            }
        }
        
        return metrics;
    }
    
    getStatus() {
        return {
            name: this.name,
            size: this.size(),
            paused: this.paused,
            hasMessages: this.size() > 0
        };
    }
    
    toJSON() {
        const data = {
            name: this.name,
            messages: this.messages,
            paused: this.paused
        };
        
        if (this.config.enablePriority) {
            data.priorityQueues = this.priorityQueues;
        }
        
        return data;
    }
}

module.exports = MessageQueueSystem;