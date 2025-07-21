/**
 * Machine Learning API Endpoints for Otedama
 * Provides access to ML predictions and model management
 * 
 * Design principles:
 * - Fast inference API (Carmack)
 * - Clean endpoint design (Martin)
 * - Simple integration (Pike)
 */

import { Router } from 'express';
import { authenticateToken } from '../auth/middleware.js';
import { logger } from '../core/logger.js';

const router = Router();

/**
 * Get price predictions
 * GET /api/ml/predictions/:pair
 */
router.get('/predictions/:pair', authenticateToken, async (req, res) => {
    try {
        const { pair } = req.params;
        const { horizon, model } = req.query;
        
        const predictor = req.app.locals.pricePredictor;
        if (!predictor) {
            return res.status(503).json({ error: 'ML service not available' });
        }
        
        const predictions = predictor.getPredictions(pair);
        if (!predictions) {
            return res.status(404).json({ error: 'No predictions available for this pair' });
        }
        
        // Filter by model if specified
        let result = predictions;
        if (model && predictions.predictions[model]) {
            result = {
                ...predictions,
                predictions: { [model]: predictions.predictions[model] }
            };
        }
        
        // Filter by horizon if specified
        if (horizon) {
            const horizonMinutes = parseInt(horizon);
            Object.keys(result.predictions).forEach(modelName => {
                result.predictions[modelName] = result.predictions[modelName].slice(0, horizonMinutes);
            });
        }
        
        res.json({
            success: true,
            pair,
            data: result
        });
        
    } catch (error) {
        logger.error('Get predictions error:', error);
        res.status(500).json({ error: 'Failed to get predictions' });
    }
});

/**
 * Get model accuracy metrics
 * GET /api/ml/accuracy
 */
router.get('/accuracy', authenticateToken, async (req, res) => {
    try {
        const predictor = req.app.locals.pricePredictor;
        if (!predictor) {
            return res.status(503).json({ error: 'ML service not available' });
        }
        
        const accuracy = predictor.getAccuracy();
        
        res.json({
            success: true,
            accuracy,
            models: Object.keys(accuracy),
            bestModel: Object.entries(accuracy).sort((a, b) => b[1] - a[1])[0]?.[0]
        });
        
    } catch (error) {
        logger.error('Get accuracy error:', error);
        res.status(500).json({ error: 'Failed to get accuracy metrics' });
    }
});

/**
 * Get trading signals based on predictions
 * GET /api/ml/signals
 */
router.get('/signals', authenticateToken, async (req, res) => {
    try {
        const predictor = req.app.locals.pricePredictor;
        if (!predictor) {
            return res.status(503).json({ error: 'ML service not available' });
        }
        
        const pairs = req.query.pairs ? req.query.pairs.split(',') : ['BTC/USDT', 'ETH/USDT', 'ETH/BTC'];
        const signals = [];
        
        for (const pair of pairs) {
            const prediction = predictor.getPredictions(pair);
            if (prediction && prediction.recommendation) {
                signals.push({
                    pair,
                    signal: prediction.recommendation,
                    timestamp: prediction.timestamp,
                    currentPrice: prediction.current
                });
            }
        }
        
        // Sort by signal strength
        signals.sort((a, b) => (b.signal.strength || 0) - (a.signal.strength || 0));
        
        res.json({
            success: true,
            signals,
            timestamp: Date.now()
        });
        
    } catch (error) {
        logger.error('Get signals error:', error);
        res.status(500).json({ error: 'Failed to get trading signals' });
    }
});

/**
 * Subscribe to real-time predictions via WebSocket
 * POST /api/ml/subscribe
 */
router.post('/subscribe', authenticateToken, async (req, res) => {
    try {
        const { pairs, models } = req.body;
        const userId = req.user.id;
        
        const predictor = req.app.locals.pricePredictor;
        if (!predictor) {
            return res.status(503).json({ error: 'ML service not available' });
        }
        
        // Create subscription
        const subscriptionId = `ml_${userId}_${Date.now()}`;
        
        // This would typically integrate with WebSocket server
        // For now, return subscription details
        res.json({
            success: true,
            subscriptionId,
            pairs: pairs || ['BTC/USDT', 'ETH/USDT'],
            models: models || ['ensemble'],
            websocket: {
                url: `ws://${req.headers.host}/ws/ml`,
                protocol: 'ml-predictions-v1'
            }
        });
        
    } catch (error) {
        logger.error('Subscribe error:', error);
        res.status(500).json({ error: 'Failed to create subscription' });
    }
});

/**
 * Train models with new data (admin only)
 * POST /api/ml/train
 */
router.post('/train', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { pairs, startDate, endDate } = req.body;
        
        const predictor = req.app.locals.pricePredictor;
        if (!predictor) {
            return res.status(503).json({ error: 'ML service not available' });
        }
        
        // This would typically be an async job
        res.json({
            success: true,
            message: 'Training job initiated',
            jobId: `train_${Date.now()}`,
            pairs,
            dateRange: { startDate, endDate }
        });
        
        // Start training in background
        setImmediate(async () => {
            try {
                // Fetch historical data
                const trainingData = await fetchHistoricalData(pairs, startDate, endDate);
                
                // Train models
                await predictor.trainModels(trainingData);
                
                logger.info('Model training completed successfully');
            } catch (error) {
                logger.error('Model training failed:', error);
            }
        });
        
    } catch (error) {
        logger.error('Train models error:', error);
        res.status(500).json({ error: 'Failed to initiate training' });
    }
});

/**
 * Get model configuration
 * GET /api/ml/config
 */
router.get('/config', authenticateToken, async (req, res) => {
    try {
        const predictor = req.app.locals.pricePredictor;
        if (!predictor) {
            return res.status(503).json({ error: 'ML service not available' });
        }
        
        res.json({
            success: true,
            config: {
                modelType: predictor.config.modelType,
                lookbackPeriod: predictor.config.lookbackPeriod,
                predictionHorizon: predictor.config.predictionHorizon,
                features: predictor.config.features,
                confidence: predictor.config.confidence,
                updateInterval: predictor.config.updateInterval
            }
        });
        
    } catch (error) {
        logger.error('Get config error:', error);
        res.status(500).json({ error: 'Failed to get configuration' });
    }
});

/**
 * Update model configuration (admin only)
 * PUT /api/ml/config
 */
router.put('/config', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { confidence, updateInterval } = req.body;
        
        const predictor = req.app.locals.pricePredictor;
        if (!predictor) {
            return res.status(503).json({ error: 'ML service not available' });
        }
        
        // Update configuration
        if (confidence !== undefined) {
            predictor.config.confidence = confidence;
        }
        if (updateInterval !== undefined) {
            predictor.config.updateInterval = updateInterval;
            // Restart prediction loop with new interval
            await predictor.stop();
            await predictor.start();
        }
        
        res.json({
            success: true,
            config: predictor.config
        });
        
    } catch (error) {
        logger.error('Update config error:', error);
        res.status(500).json({ error: 'Failed to update configuration' });
    }
});

// Helper functions
function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

async function fetchHistoricalData(pairs, startDate, endDate) {
    // This would fetch data from your data source
    // For now, return empty object
    const data = {};
    pairs.forEach(pair => {
        data[pair] = [];
    });
    return data;
}

export default router;