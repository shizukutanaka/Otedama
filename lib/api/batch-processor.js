/**
 * Batch Processor for Otedama
 * Handles the actual processing logic for batch operations
 * 
 * Design principles:
 * - Efficient parallel processing with limits (Carmack)
 * - Clean separation of concerns (Martin)
 * - Simple and reliable batch handling (Pike)
 */

import { EventEmitter } from 'events';
import { logger } from '../core/logger.js';
import { v4 as uuidv4 } from 'uuid';

export class BatchProcessor extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            maxConcurrent: config.maxConcurrent || 10,
            retryAttempts: config.retryAttempts || 3,
            retryDelay: config.retryDelay || 1000,
            timeout: config.timeout || 30000,
            ...config
        };
        
        // Track active batches
        this.activeBatches = new Map();
        
        // Processing queue
        this.queue = [];
        this.processing = false;
        
        // Metrics
        this.metrics = {
            totalProcessed: 0,
            totalSucceeded: 0,
            totalFailed: 0,
            averageProcessingTime: 0
        };
    }
    
    /**
     * Process a batch of items
     */
    async processBatch(items, processor, options = {}) {
        const batchId = uuidv4();
        const startTime = Date.now();
        
        const batch = {
            id: batchId,
            items: items,
            processor: processor,
            options: {
                ...this.config,
                ...options
            },
            status: 'pending',
            results: [],
            failed: [],
            startTime: startTime,
            endTime: null
        };
        
        this.activeBatches.set(batchId, batch);
        this.emit('batch:started', { batchId, itemCount: items.length });
        
        try {
            // Process items with concurrency control
            const results = await this.processWithConcurrency(
                items, 
                processor, 
                batch.options.maxConcurrent
            );
            
            // Separate successful and failed results
            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    batch.results.push({
                        index,
                        item: items[index],
                        result: result.value,
                        status: 'success'
                    });
                } else {
                    batch.failed.push({
                        index,
                        item: items[index],
                        error: result.reason,
                        status: 'failed'
                    });
                }
            });
            
            // Retry failed items if configured
            if (batch.options.retryAttempts > 0 && batch.failed.length > 0) {
                await this.retryFailed(batch);
            }
            
            batch.status = 'completed';
            batch.endTime = Date.now();
            
            // Update metrics
            this.updateMetrics(batch);
            
            this.emit('batch:completed', {
                batchId,
                succeeded: batch.results.length,
                failed: batch.failed.length,
                duration: batch.endTime - batch.startTime
            });
            
            return {
                batchId,
                results: batch.results,
                failed: batch.failed,
                summary: {
                    total: items.length,
                    succeeded: batch.results.length,
                    failed: batch.failed.length,
                    duration: batch.endTime - batch.startTime
                }
            };
            
        } catch (error) {
            batch.status = 'error';
            batch.error = error;
            batch.endTime = Date.now();
            
            this.emit('batch:error', { batchId, error });
            
            throw error;
        }
    }
    
    /**
     * Process items with concurrency control
     */
    async processWithConcurrency(items, processor, maxConcurrent) {
        const results = new Array(items.length);
        const executing = [];
        
        for (let i = 0; i < items.length; i++) {
            const promise = this.processItem(items[i], processor, i).then(
                result => {
                    results[i] = { status: 'fulfilled', value: result };
                },
                error => {
                    results[i] = { status: 'rejected', reason: error };
                }
            );
            
            executing.push(promise);
            
            if (executing.length >= maxConcurrent) {
                await Promise.race(executing);
                executing.splice(executing.findIndex(p => p === promise), 1);
            }
        }
        
        await Promise.all(executing);
        return results;
    }
    
    /**
     * Process a single item with timeout
     */
    async processItem(item, processor, index) {
        return new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Processing timeout for item ${index}`));
            }, this.config.timeout);
            
            try {
                const result = await processor(item, index);
                clearTimeout(timeout);
                resolve(result);
            } catch (error) {
                clearTimeout(timeout);
                reject(error);
            }
        });
    }
    
    /**
     * Retry failed items
     */
    async retryFailed(batch) {
        const maxRetries = batch.options.retryAttempts;
        let remainingFailed = [...batch.failed];
        batch.failed = [];
        
        for (let attempt = 1; attempt <= maxRetries && remainingFailed.length > 0; attempt++) {
            logger.info(`Retrying ${remainingFailed.length} failed items, attempt ${attempt}/${maxRetries}`);
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, batch.options.retryDelay * attempt));
            
            const retryResults = await this.processWithConcurrency(
                remainingFailed.map(f => f.item),
                batch.processor,
                Math.max(1, Math.floor(batch.options.maxConcurrent / 2)) // Reduce concurrency for retries
            );
            
            const newFailed = [];
            retryResults.forEach((result, index) => {
                const originalIndex = remainingFailed[index].index;
                
                if (result.status === 'fulfilled') {
                    batch.results.push({
                        index: originalIndex,
                        item: remainingFailed[index].item,
                        result: result.value,
                        status: 'success',
                        retryAttempt: attempt
                    });
                } else {
                    newFailed.push({
                        ...remainingFailed[index],
                        error: result.reason,
                        retryAttempts: attempt
                    });
                }
            });
            
            remainingFailed = newFailed;
        }
        
        // Add final failed items
        batch.failed = remainingFailed;
    }
    
    /**
     * Update processing metrics
     */
    updateMetrics(batch) {
        this.metrics.totalProcessed += batch.items.length;
        this.metrics.totalSucceeded += batch.results.length;
        this.metrics.totalFailed += batch.failed.length;
        
        const processingTime = batch.endTime - batch.startTime;
        this.metrics.averageProcessingTime = 
            (this.metrics.averageProcessingTime * (this.metrics.totalProcessed - batch.items.length) + 
             processingTime * batch.items.length) / this.metrics.totalProcessed;
    }
    
    /**
     * Get batch status
     */
    getBatchStatus(batchId) {
        const batch = this.activeBatches.get(batchId);
        if (!batch) return null;
        
        return {
            id: batch.id,
            status: batch.status,
            total: batch.items.length,
            succeeded: batch.results.length,
            failed: batch.failed.length,
            startTime: batch.startTime,
            endTime: batch.endTime,
            duration: batch.endTime ? batch.endTime - batch.startTime : Date.now() - batch.startTime,
            error: batch.error
        };
    }
    
    /**
     * Get all active batches
     */
    getActiveBatches() {
        return Array.from(this.activeBatches.values()).map(batch => ({
            id: batch.id,
            status: batch.status,
            itemCount: batch.items.length,
            progress: {
                processed: batch.results.length + batch.failed.length,
                succeeded: batch.results.length,
                failed: batch.failed.length
            }
        }));
    }
    
    /**
     * Clean up completed batches
     */
    cleanup(maxAge = 3600000) { // 1 hour default
        const now = Date.now();
        const toRemove = [];
        
        this.activeBatches.forEach((batch, batchId) => {
            if (batch.endTime && (now - batch.endTime) > maxAge) {
                toRemove.push(batchId);
            }
        });
        
        toRemove.forEach(batchId => {
            this.activeBatches.delete(batchId);
        });
        
        logger.info(`Cleaned up ${toRemove.length} old batches`);
    }
    
    /**
     * Get processing metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            activeBatches: this.activeBatches.size
        };
    }
}

// Specialized batch processors for different operations

/**
 * Order batch processor
 */
export class OrderBatchProcessor extends BatchProcessor {
    constructor(orderEngine, config) {
        super(config);
        this.orderEngine = orderEngine;
    }
    
    async processOrders(orders, userId) {
        return this.processBatch(orders, async (order) => {
            return await this.orderEngine.placeOrder({
                ...order,
                userId,
                timestamp: Date.now()
            });
        });
    }
}

/**
 * Transaction batch processor
 */
export class TransactionBatchProcessor extends BatchProcessor {
    constructor(transactionManager, config) {
        super(config);
        this.transactionManager = transactionManager;
    }
    
    async processTransactions(transactions, userId) {
        // Pre-validate all transactions
        const validation = await this.validateTransactions(transactions, userId);
        if (!validation.valid) {
            throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
        }
        
        return this.processBatch(transactions, async (transaction) => {
            return await this.transactionManager.processTransaction({
                ...transaction,
                userId,
                timestamp: Date.now()
            });
        }, {
            maxConcurrent: 5 // Lower concurrency for financial transactions
        });
    }
    
    async validateTransactions(transactions, userId) {
        // Implementation would validate all transactions
        return { valid: true, errors: [] };
    }
}

/**
 * User batch processor
 */
export class UserBatchProcessor extends BatchProcessor {
    constructor(userManager, config) {
        super(config);
        this.userManager = userManager;
    }
    
    async processUserOperation(operation, users, adminId) {
        const operationMap = {
            create: (user) => this.userManager.createUser(user),
            update: (user) => this.userManager.updateUser(user.id, user),
            disable: (user) => this.userManager.disableUser(user.id),
            enable: (user) => this.userManager.enableUser(user.id)
        };
        
        const processor = operationMap[operation];
        if (!processor) {
            throw new Error(`Invalid operation: ${operation}`);
        }
        
        return this.processBatch(users, processor, {
            maxConcurrent: 20 // Higher concurrency for user operations
        });
    }
}

export default BatchProcessor;