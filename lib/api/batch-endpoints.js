/**
 * Batch API Endpoints for Otedama
 * Enables efficient bulk operations across the platform
 * 
 * Refactored to use common utilities for consistency
 */

const { Router } = require('express');
const { body } = require('express-validator');
const { authenticateToken } = require('../auth/middleware');
const { rateLimiter } = require('../security/rate-limiter');
const { apiResponse, asyncHandler, validateRequest } = require('../common/api-utils');
const { createLogger } = require('../utils/logger');

const logger = createLogger('batch-endpoints');
const router = Router();

// Batch size limits
const BATCH_LIMITS = {
    orders: 100,
    transactions: 50,
    users: 1000,
    trades: 100,
    withdrawals: 20
};

/**
 * Process a single order (helper function)
 */
async function processOrder(order, userId, tradingEngine) {
    // Implementation would interact with the trading engine
    return tradingEngine.createOrder({ ...order, userId });
}

/**
 * Process a single transaction (helper function)
 */
async function processTransaction(transaction, userId, paymentProcessor) {
    // Implementation would interact with the payment processor
    return paymentProcessor.processTransaction({ ...transaction, userId });
}

/**
 * Process batch operations with concurrency control
 */
async function processBatch(items, processor, concurrentLimit = 10) {
    const results = [];
    const failed = [];

    for (let i = 0; i < items.length; i += concurrentLimit) {
        const batch = items.slice(i, i + concurrentLimit);
        const batchResults = await Promise.allSettled(
            batch.map((item, idx) => processor(item, i + idx))
        );

        batchResults.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                results.push({
                    index: i + index,
                    data: result.value,
                    status: 'success'
                });
            } else {
                failed.push({
                    index: i + index,
                    error: result.reason.message,
                    data: batch[index],
                    status: 'failed'
                });
            }
        });
    }

    return { results, failed };
}

/**
 * Batch order placement
 * POST /api/v1/batch/orders
 */
router.post('/orders', 
    authenticateToken,
    rateLimiter({ max: 10, windowMs: 60000 }), // 10 batch requests per minute
    [
        body('orders').isArray({ min: 1, max: BATCH_LIMITS.orders }),
        body('orders.*.type').isIn(['market', 'limit', 'stop', 'stop_limit']),
        body('orders.*.side').isIn(['buy', 'sell']),
        body('orders.*.pair').notEmpty(),
        body('orders.*.quantity').isFloat({ min: 0.00000001 }),
        body('orders.*.price').optional().isFloat({ min: 0.00000001 }),
        body('orders.*.stopPrice').optional().isFloat({ min: 0.00000001 })
    ],
    asyncHandler(async (req, res) => {
        validateRequest(req);

        const { orders } = req.body;
        const userId = req.user.id;
        const tradingEngine = req.app.locals.tradingEngine;

        if (!tradingEngine) {
            return apiResponse(res, 503, null, 'Trading engine not available');
        }

        const { results, failed } = await processBatch(
            orders,
            async (order) => processOrder(order, userId, tradingEngine)
        );

        logger.info(`Batch order placement: ${results.length} success, ${failed.length} failed`, {
            userId,
            totalOrders: orders.length
        });

        apiResponse(res, 200, {
            processed: orders.length,
            successful: results,
            failed: failed,
            summary: {
                total: orders.length,
                succeeded: results.length,
                failed: failed.length
            }
        });
    })
);

/**
 * Batch transaction processing
 * POST /api/v1/batch/transactions
 */
router.post('/transactions',
    authenticateToken,
    rateLimiter({ max: 5, windowMs: 60000 }), // 5 batch requests per minute
    [
        body('transactions').isArray({ min: 1, max: BATCH_LIMITS.transactions }),
        body('transactions.*.type').isIn(['deposit', 'withdrawal', 'transfer']),
        body('transactions.*.currency').notEmpty(),
        body('transactions.*.amount').isFloat({ min: 0.00000001 }),
        body('transactions.*.address').optional().notEmpty(),
        body('transactions.*.memo').optional(),
        body('transactions.*.network').optional()
    ],
    asyncHandler(async (req, res) => {
        validateRequest(req);

        const { transactions } = req.body;
        const userId = req.user.id;
        const paymentProcessor = req.app.locals.paymentProcessor;

        if (!paymentProcessor) {
            return apiResponse(res, 503, null, 'Payment processor not available');
        }

        const { results, failed } = await processBatch(
            transactions,
            async (transaction) => processTransaction(transaction, userId, paymentProcessor),
            5 // Lower concurrency for financial operations
        );

        logger.info(`Batch transaction processing: ${results.length} success, ${failed.length} failed`, {
            userId,
            totalTransactions: transactions.length
        });

        apiResponse(res, 200, {
            processed: transactions.length,
            successful: results,
            failed: failed,
            summary: {
                total: transactions.length,
                succeeded: results.length,
                failed: failed.length
            }
        });
    })
);

/**
 * Batch user operations
 * POST /api/v1/batch/users
 */
router.post('/users',
    authenticateToken,
    rateLimiter({ max: 5, windowMs: 300000 }), // 5 requests per 5 minutes
    [
        body('operation').isIn(['activate', 'deactivate', 'verify', 'update']),
        body('users').isArray({ min: 1, max: BATCH_LIMITS.users }),
        body('users.*').notEmpty(),
        body('data').optional().isObject()
    ],
    asyncHandler(async (req, res) => {
        validateRequest(req);

        // Check if user has admin privileges
        if (!req.user.isAdmin) {
            return apiResponse(res, 403, null, 'Admin access required');
        }

        const { operation, users, data } = req.body;
        const userManager = req.app.locals.userManager;

        if (!userManager) {
            return apiResponse(res, 503, null, 'User manager not available');
        }

        const { results, failed } = await processBatch(
            users,
            async (userId) => userManager.batchOperation(operation, userId, data)
        );

        logger.info(`Batch user operation [${operation}]: ${results.length} success, ${failed.length} failed`, {
            adminId: req.user.id,
            totalUsers: users.length
        });

        apiResponse(res, 200, {
            operation,
            processed: users.length,
            successful: results,
            failed: failed,
            summary: {
                total: users.length,
                succeeded: results.length,
                failed: failed.length
            }
        });
    })
);

/**
 * Batch data retrieval
 * POST /api/v1/batch/get
 */
router.post('/get',
    authenticateToken,
    rateLimiter({ max: 20, windowMs: 60000 }), // 20 requests per minute
    [
        body('type').isIn(['orders', 'trades', 'balances', 'positions']),
        body('ids').isArray({ min: 1, max: 1000 }),
        body('ids.*').notEmpty(),
        body('fields').optional().isArray()
    ],
    asyncHandler(async (req, res) => {
        validateRequest(req);

        const { type, ids, fields } = req.body;
        const userId = req.user.id;
        const dataService = req.app.locals.dataService;

        if (!dataService) {
            return apiResponse(res, 503, null, 'Data service not available');
        }

        const { results, failed } = await processBatch(
            ids,
            async (id) => dataService.getData(type, id, userId, fields),
            20 // Higher concurrency for read operations
        );

        apiResponse(res, 200, {
            type,
            requested: ids.length,
            found: results.length,
            notFound: failed.length,
            data: results,
            missing: failed
        });
    })
);

/**
 * Batch order cancellation
 * POST /api/v1/batch/cancel
 */
router.post('/cancel',
    authenticateToken,
    rateLimiter({ max: 10, windowMs: 60000 }), // 10 requests per minute
    [
        body('orderIds').isArray({ min: 1, max: BATCH_LIMITS.orders }),
        body('orderIds.*').notEmpty()
    ],
    asyncHandler(async (req, res) => {
        validateRequest(req);

        const { orderIds } = req.body;
        const userId = req.user.id;
        const tradingEngine = req.app.locals.tradingEngine;

        if (!tradingEngine) {
            return apiResponse(res, 503, null, 'Trading engine not available');
        }

        const { results, failed } = await processBatch(
            orderIds,
            async (orderId) => tradingEngine.cancelOrder(orderId, userId)
        );

        logger.info(`Batch order cancellation: ${results.length} success, ${failed.length} failed`, {
            userId,
            totalOrders: orderIds.length
        });

        apiResponse(res, 200, {
            cancelled: results.length,
            failed: failed.length,
            successful: results,
            errors: failed,
            summary: {
                total: orderIds.length,
                cancelled: results.length,
                failed: failed.length
            }
        });
    })
);

/**
 * Get batch operation status
 * GET /api/v1/batch/status/:batchId
 */
router.get('/status/:batchId',
    authenticateToken,
    asyncHandler(async (req, res) => {
        const { batchId } = req.params;
        const batchTracker = req.app.locals.batchTracker;

        if (!batchTracker) {
            return apiResponse(res, 503, null, 'Batch tracker not available');
        }

        const status = await batchTracker.getStatus(batchId, req.user.id);

        if (!status) {
            return apiResponse(res, 404, null, 'Batch operation not found');
        }

        apiResponse(res, 200, status);
    })
);

/**
 * Get batch limits for the current user
 * GET /api/v1/batch/limits
 */
router.get('/limits',
    authenticateToken,
    asyncHandler(async (req, res) => {
        const userLimits = {
            ...BATCH_LIMITS,
            // Could be customized based on user tier
            custom: req.user.tier === 'premium' ? {
                orders: 200,
                transactions: 100
            } : null
        };

        apiResponse(res, 200, {
            limits: userLimits,
            tier: req.user.tier || 'standard'
        });
    })
);

module.exports = router;