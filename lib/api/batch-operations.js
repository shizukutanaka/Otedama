/**
 * Batch Operations for Otedama API
 * Allows executing multiple operations in a single request
 */

import { getLogger } from '../core/logger.js';
import { OtedamaError, ErrorCategory } from '../error-handler.js';

const logger = getLogger('BatchOperations');

export class BatchOperationHandler {
    constructor(options = {}) {
        this.maxBatchSize = options.maxBatchSize || 100;
        this.maxParallel = options.maxParallel || 10;
        this.timeout = options.timeout || 30000;
        this.allowedOperations = options.allowedOperations || [
            'GET',
            'POST',
            'PUT',
            'DELETE'
        ];
        this.services = options.services || {};
    }

    /**
     * Process batch request
     */
    async processBatch(operations, context) {
        // Validate batch size
        if (!Array.isArray(operations)) {
            throw new OtedamaError('Batch operations must be an array', ErrorCategory.VALIDATION);
        }

        if (operations.length === 0) {
            throw new OtedamaError('Batch cannot be empty', ErrorCategory.VALIDATION);
        }

        if (operations.length > this.maxBatchSize) {
            throw new OtedamaError(`Batch size exceeds maximum of ${this.maxBatchSize}`, ErrorCategory.VALIDATION);
        }

        // Validate each operation
        const validatedOps = operations.map((op, index) => this.validateOperation(op, index));

        // Group operations by dependency
        const { independent, dependent } = this.groupOperations(validatedOps);

        // Process independent operations in parallel
        const independentResults = await this.processIndependentOps(independent, context);

        // Process dependent operations sequentially
        const dependentResults = await this.processDependentOps(dependent, context, independentResults);

        // Combine results
        const results = [...independentResults, ...dependentResults];

        // Sort results by original index
        results.sort((a, b) => a.index - b.index);

        return {
            success: results.filter(r => r.status === 'success').length,
            failed: results.filter(r => r.status === 'error').length,
            results: results.map(r => ({
                id: r.id,
                status: r.status,
                data: r.data,
                error: r.error
            }))
        };
    }

    /**
     * Validate single operation
     */
    validateOperation(operation, index) {
        if (!operation.id) {
            throw new OtedamaError(`Operation at index ${index} missing required 'id' field`, ErrorCategory.VALIDATION);
        }

        if (!operation.method) {
            throw new OtedamaError(`Operation ${operation.id} missing required 'method' field`, ErrorCategory.VALIDATION);
        }

        if (!this.allowedOperations.includes(operation.method)) {
            throw new OtedamaError(`Operation ${operation.id} has invalid method: ${operation.method}`, ErrorCategory.VALIDATION);
        }

        if (!operation.path) {
            throw new OtedamaError(`Operation ${operation.id} missing required 'path' field`, ErrorCategory.VALIDATION);
        }

        return {
            ...operation,
            index,
            dependencies: operation.dependencies || []
        };
    }

    /**
     * Group operations by dependency
     */
    groupOperations(operations) {
        const independent = [];
        const dependent = [];

        for (const op of operations) {
            if (op.dependencies.length === 0) {
                independent.push(op);
            } else {
                dependent.push(op);
            }
        }

        return { independent, dependent };
    }

    /**
     * Process independent operations in parallel
     */
    async processIndependentOps(operations, context) {
        const results = [];
        
        // Process in chunks to respect maxParallel
        for (let i = 0; i < operations.length; i += this.maxParallel) {
            const chunk = operations.slice(i, i + this.maxParallel);
            const chunkResults = await Promise.all(
                chunk.map(op => this.executeOperation(op, context))
            );
            results.push(...chunkResults);
        }

        return results;
    }

    /**
     * Process dependent operations sequentially
     */
    async processDependentOps(operations, context, previousResults) {
        const results = [];
        const resultMap = new Map(previousResults.map(r => [r.id, r]));

        for (const op of operations) {
            // Check if dependencies are satisfied
            const dependenciesSatisfied = op.dependencies.every(depId => {
                const dep = resultMap.get(depId);
                return dep && dep.status === 'success';
            });

            if (!dependenciesSatisfied) {
                results.push({
                    id: op.id,
                    index: op.index,
                    status: 'error',
                    error: {
                        code: 'DEPENDENCY_FAILED',
                        message: 'One or more dependencies failed'
                    }
                });
                continue;
            }

            // Execute operation with dependency results available
            const depResults = {};
            for (const depId of op.dependencies) {
                depResults[depId] = resultMap.get(depId).data;
            }

            const result = await this.executeOperation(op, context, depResults);
            results.push(result);
            resultMap.set(result.id, result);
        }

        return results;
    }

    /**
     * Execute single operation
     */
    async executeOperation(operation, context, dependencyResults = {}) {
        const startTime = Date.now();

        try {
            // Build request context
            const req = {
                method: operation.method,
                path: operation.path,
                params: operation.params || {},
                body: operation.body,
                headers: operation.headers || {},
                user: context.user,
                apiKey: context.apiKey,
                dependencyResults
            };

            // Route to appropriate handler
            let result;
            
            switch (operation.path) {
                case '/api/prices':
                    if (operation.method === 'GET') {
                        const priceFeed = this.services.priceFeed;
                        result = await priceFeed.getPrices();
                    }
                    break;

                case '/api/stats':
                    if (operation.method === 'GET') {
                        const miningPool = this.services.miningPool;
                        result = await miningPool.getStats();
                    }
                    break;

                default:
                    // Handle dynamic paths
                    if (operation.path.startsWith('/api/miner/')) {
                        const minerId = operation.path.split('/')[3];
                        const miningPool = this.services.miningPool;
                        
                        if (operation.method === 'GET') {
                            result = await miningPool.getMiner(minerId);
                        } else if (operation.method === 'PUT') {
                            result = await miningPool.updateMiner(minerId, operation.body);
                        }
                    } else if (operation.path.startsWith('/api/order/')) {
                        const orderId = operation.path.split('/')[3];
                        const dexEngine = this.services.dexEngine;
                        
                        if (operation.method === 'GET') {
                            result = await dexEngine.getOrder(orderId);
                        } else if (operation.method === 'DELETE') {
                            result = await dexEngine.cancelOrder(orderId);
                        }
                    } else {
                        throw new Error(`Unknown operation path: ${operation.path}`);
                    }
            }

            const duration = Date.now() - startTime;

            return {
                id: operation.id,
                index: operation.index,
                status: 'success',
                data: result,
                duration
            };

        } catch (error) {
            logger.error(`Batch operation ${operation.id} failed:`, error);

            return {
                id: operation.id,
                index: operation.index,
                status: 'error',
                error: {
                    code: error.code || 'OPERATION_FAILED',
                    message: error.message
                },
                duration: Date.now() - startTime
            };
        }
    }

    /**
     * Validate batch request
     */
    validateBatchRequest(request) {
        if (!request.operations) {
            throw new OtedamaError('Missing required field: operations', ErrorCategory.VALIDATION);
        }

        if (request.sequential !== undefined && typeof request.sequential !== 'boolean') {
            throw new OtedamaError('Field sequential must be boolean', ErrorCategory.VALIDATION);
        }

        if (request.stopOnError !== undefined && typeof request.stopOnError !== 'boolean') {
            throw new OtedamaError('Field stopOnError must be boolean', ErrorCategory.VALIDATION);
        }

        return {
            operations: request.operations,
            sequential: request.sequential || false,
            stopOnError: request.stopOnError || false
        };
    }
}

export default BatchOperationHandler;