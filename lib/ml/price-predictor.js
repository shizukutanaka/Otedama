/**
 * Machine Learning Price Predictor for Otedama
 * Uses multiple models for accurate price predictions
 * 
 * Design principles:
 * - High-performance ML inference (Carmack)
 * - Clean model architecture (Martin)
 * - Simple API for predictions (Pike)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import * as tf from '@tensorflow/tfjs-node';

const logger = getLogger('PricePredictor');

export class PricePredictor extends EventEmitter {
    constructor(config = {}) {
        super();
        
        this.config = {
            modelType: config.modelType || 'lstm', // lstm, gru, transformer
            lookbackPeriod: config.lookbackPeriod || 60, // 60 minutes
            predictionHorizon: config.predictionHorizon || 15, // 15 minutes ahead
            updateInterval: config.updateInterval || 60000, // 1 minute
            features: config.features || ['price', 'volume', 'rsi', 'macd', 'bb'],
            confidence: config.confidence || 0.7, // Minimum confidence threshold
            ...config
        };
        
        // Model state
        this.models = new Map();
        this.predictions = new Map();
        this.accuracy = new Map();
        
        // Data preprocessing
        this.scalers = new Map();
        this.dataBuffer = new Map();
        
        // Initialize models
        this.initializeModels();
    }
    
    /**
     * Initialize ML models
     */
    async initializeModels() {
        try {
            // LSTM model for time series prediction
            this.models.set('lstm', await this.createLSTMModel());
            
            // GRU model (faster than LSTM)
            this.models.set('gru', await this.createGRUModel());
            
            // Ensemble model combining multiple approaches
            this.models.set('ensemble', await this.createEnsembleModel());
            
            logger.info('ML models initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize ML models:', error);
        }
    }
    
    /**
     * Create LSTM model
     */
    async createLSTMModel() {
        const model = tf.sequential({
            layers: [
                tf.layers.lstm({
                    units: 128,
                    returnSequences: true,
                    inputShape: [this.config.lookbackPeriod, this.config.features.length]
                }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.lstm({
                    units: 64,
                    returnSequences: true
                }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.lstm({
                    units: 32,
                    returnSequences: false
                }),
                tf.layers.dense({
                    units: 16,
                    activation: 'relu'
                }),
                tf.layers.dense({
                    units: this.config.predictionHorizon,
                    activation: 'linear'
                })
            ]
        });
        
        model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError',
            metrics: ['mae']
        });
        
        return model;
    }
    
    /**
     * Create GRU model
     */
    async createGRUModel() {
        const model = tf.sequential({
            layers: [
                tf.layers.gru({
                    units: 100,
                    returnSequences: true,
                    inputShape: [this.config.lookbackPeriod, this.config.features.length]
                }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.gru({
                    units: 50,
                    returnSequences: false
                }),
                tf.layers.dense({
                    units: 25,
                    activation: 'relu'
                }),
                tf.layers.dense({
                    units: this.config.predictionHorizon,
                    activation: 'linear'
                })
            ]
        });
        
        model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError',
            metrics: ['mae']
        });
        
        return model;
    }
    
    /**
     * Create ensemble model
     */
    async createEnsembleModel() {
        // This combines predictions from multiple models
        return {
            predict: async (input) => {
                const lstmPred = await this.models.get('lstm').predict(input);
                const gruPred = await this.models.get('gru').predict(input);
                
                // Weighted average based on recent accuracy
                const lstmWeight = this.accuracy.get('lstm') || 0.5;
                const gruWeight = this.accuracy.get('gru') || 0.5;
                const totalWeight = lstmWeight + gruWeight;
                
                return tf.add(
                    tf.mul(lstmPred, lstmWeight / totalWeight),
                    tf.mul(gruPred, gruWeight / totalWeight)
                );
            }
        };
    }
    
    /**
     * Preprocess price data
     */
    preprocessData(pair, data) {
        // Initialize scaler if needed
        if (!this.scalers.has(pair)) {
            this.scalers.set(pair, {
                price: { min: Infinity, max: -Infinity },
                volume: { min: Infinity, max: -Infinity }
            });
        }
        
        const scaler = this.scalers.get(pair);
        
        // Update scaler parameters
        data.forEach(point => {
            scaler.price.min = Math.min(scaler.price.min, point.price);
            scaler.price.max = Math.max(scaler.price.max, point.price);
            scaler.volume.min = Math.min(scaler.volume.min, point.volume);
            scaler.volume.max = Math.max(scaler.volume.max, point.volume);
        });
        
        // Calculate technical indicators
        const features = data.map((point, index) => {
            const normalizedPrice = this.normalize(point.price, scaler.price.min, scaler.price.max);
            const normalizedVolume = this.normalize(point.volume, scaler.volume.min, scaler.volume.max);
            
            // Calculate RSI
            const rsi = this.calculateRSI(data.slice(Math.max(0, index - 14), index + 1));
            
            // Calculate MACD
            const macd = this.calculateMACD(data.slice(Math.max(0, index - 26), index + 1));
            
            // Calculate Bollinger Bands
            const bb = this.calculateBollingerBands(data.slice(Math.max(0, index - 20), index + 1));
            
            return [
                normalizedPrice,
                normalizedVolume,
                rsi / 100, // Normalize RSI to 0-1
                macd.signal,
                bb.position
            ];
        });
        
        return features;
    }
    
    /**
     * Normalize value to 0-1 range
     */
    normalize(value, min, max) {
        if (max === min) return 0.5;
        return (value - min) / (max - min);
    }
    
    /**
     * Calculate RSI
     */
    calculateRSI(data, period = 14) {
        if (data.length < 2) return 50;
        
        let gains = 0;
        let losses = 0;
        
        for (let i = 1; i < Math.min(data.length, period + 1); i++) {
            const change = data[i].price - data[i - 1].price;
            if (change > 0) {
                gains += change;
            } else {
                losses -= change;
            }
        }
        
        const avgGain = gains / period;
        const avgLoss = losses / period;
        
        if (avgLoss === 0) return 100;
        
        const rs = avgGain / avgLoss;
        const rsi = 100 - (100 / (1 + rs));
        
        return rsi;
    }
    
    /**
     * Calculate MACD
     */
    calculateMACD(data) {
        if (data.length < 26) {
            return { macd: 0, signal: 0, histogram: 0 };
        }
        
        // Simplified MACD calculation
        const ema12 = this.calculateEMA(data.map(d => d.price), 12);
        const ema26 = this.calculateEMA(data.map(d => d.price), 26);
        const macd = ema12 - ema26;
        
        return {
            macd: this.normalize(macd, -100, 100),
            signal: this.normalize(macd * 0.9, -100, 100), // Simplified signal
            histogram: this.normalize(macd * 0.1, -100, 100)
        };
    }
    
    /**
     * Calculate EMA
     */
    calculateEMA(data, period) {
        if (data.length === 0) return 0;
        
        const k = 2 / (period + 1);
        let ema = data[0];
        
        for (let i = 1; i < data.length; i++) {
            ema = data[i] * k + ema * (1 - k);
        }
        
        return ema;
    }
    
    /**
     * Calculate Bollinger Bands
     */
    calculateBollingerBands(data, period = 20) {
        if (data.length < period) {
            return { upper: 0, middle: 0, lower: 0, position: 0.5 };
        }
        
        const prices = data.map(d => d.price);
        const sma = prices.reduce((a, b) => a + b, 0) / prices.length;
        
        const variance = prices.reduce((sum, price) => {
            return sum + Math.pow(price - sma, 2);
        }, 0) / prices.length;
        
        const stdDev = Math.sqrt(variance);
        
        const upper = sma + (2 * stdDev);
        const lower = sma - (2 * stdDev);
        const current = prices[prices.length - 1];
        
        // Position within bands (0 = lower, 1 = upper)
        const position = (current - lower) / (upper - lower);
        
        return {
            upper,
            middle: sma,
            lower,
            position: Math.max(0, Math.min(1, position))
        };
    }
    
    /**
     * Make price prediction
     */
    async predictPrice(pair, historicalData) {
        try {
            // Ensure we have enough data
            if (historicalData.length < this.config.lookbackPeriod) {
                throw new Error('Insufficient historical data');
            }
            
            // Preprocess data
            const features = this.preprocessData(pair, historicalData);
            const inputData = features.slice(-this.config.lookbackPeriod);
            
            // Convert to tensor
            const inputTensor = tf.tensor3d([inputData]);
            
            // Get predictions from each model
            const predictions = {};
            const modelType = this.config.modelType;
            
            if (modelType === 'ensemble' || modelType === 'all') {
                // Run all models
                for (const [name, model] of this.models) {
                    const prediction = await model.predict(inputTensor);
                    predictions[name] = await prediction.array();
                    prediction.dispose();
                }
            } else {
                // Run specific model
                const model = this.models.get(modelType);
                if (!model) throw new Error(`Model ${modelType} not found`);
                
                const prediction = await model.predict(inputTensor);
                predictions[modelType] = await prediction.array();
                prediction.dispose();
            }
            
            inputTensor.dispose();
            
            // Process predictions
            const scaler = this.scalers.get(pair);
            const currentPrice = historicalData[historicalData.length - 1].price;
            
            const results = {};
            for (const [modelName, pred] of Object.entries(predictions)) {
                const pricePoints = pred[0].map((normalizedValue, index) => {
                    // Denormalize prediction
                    const price = normalizedValue * (scaler.price.max - scaler.price.min) + scaler.price.min;
                    return {
                        time: Date.now() + (index + 1) * 60000, // 1 minute intervals
                        price: price,
                        change: ((price - currentPrice) / currentPrice) * 100,
                        confidence: this.calculateConfidence(modelName, normalizedValue)
                    };
                });
                
                results[modelName] = pricePoints;
            }
            
            // Calculate ensemble prediction if using multiple models
            if (Object.keys(results).length > 1) {
                results.ensemble = this.combineePredictions(results);
            }
            
            // Store predictions
            this.predictions.set(pair, {
                timestamp: Date.now(),
                current: currentPrice,
                predictions: results,
                recommendation: this.generateRecommendation(results)
            });
            
            // Emit prediction event
            this.emit('prediction', {
                pair,
                predictions: results
            });
            
            return results;
            
        } catch (error) {
            logger.error(`Price prediction error for ${pair}:`, error);
            throw error;
        }
    }
    
    /**
     * Calculate prediction confidence
     */
    calculateConfidence(modelName, normalizedValue) {
        // Base confidence on model accuracy
        const baseConfidence = this.accuracy.get(modelName) || 0.5;
        
        // Adjust based on prediction extremity
        const extremity = Math.abs(normalizedValue - 0.5) * 2; // 0 to 1
        const confidenceAdjustment = 1 - (extremity * 0.3); // Reduce confidence for extreme predictions
        
        return Math.max(0.3, Math.min(0.95, baseConfidence * confidenceAdjustment));
    }
    
    /**
     * Combine predictions from multiple models
     */
    combineePredictions(modelPredictions) {
        const combined = [];
        const models = Object.keys(modelPredictions).filter(m => m !== 'ensemble');
        
        // Get prediction horizon length
        const horizonLength = modelPredictions[models[0]].length;
        
        for (let i = 0; i < horizonLength; i++) {
            let weightedPrice = 0;
            let totalWeight = 0;
            let minPrice = Infinity;
            let maxPrice = -Infinity;
            
            models.forEach(model => {
                const pred = modelPredictions[model][i];
                const weight = pred.confidence;
                
                weightedPrice += pred.price * weight;
                totalWeight += weight;
                
                minPrice = Math.min(minPrice, pred.price);
                maxPrice = Math.max(maxPrice, pred.price);
            });
            
            const ensemblePrice = weightedPrice / totalWeight;
            const currentPrice = this.predictions.get('BTC/USDT')?.current || ensemblePrice;
            
            combined.push({
                time: modelPredictions[models[0]][i].time,
                price: ensemblePrice,
                change: ((ensemblePrice - currentPrice) / currentPrice) * 100,
                confidence: totalWeight / models.length,
                range: {
                    min: minPrice,
                    max: maxPrice
                }
            });
        }
        
        return combined;
    }
    
    /**
     * Generate trading recommendation
     */
    generateRecommendation(predictions) {
        const ensemble = predictions.ensemble || predictions[Object.keys(predictions)[0]];
        if (!ensemble || ensemble.length === 0) return { action: 'HOLD', confidence: 0 };
        
        // Look at short-term trend (next 5 minutes)
        const shortTerm = ensemble.slice(0, 5);
        const avgChange = shortTerm.reduce((sum, p) => sum + p.change, 0) / shortTerm.length;
        const avgConfidence = shortTerm.reduce((sum, p) => sum + p.confidence, 0) / shortTerm.length;
        
        let action = 'HOLD';
        let strength = 0;
        
        if (avgChange > 0.5 && avgConfidence > this.config.confidence) {
            action = 'BUY';
            strength = Math.min(avgChange / 2, 1); // 0 to 1
        } else if (avgChange < -0.5 && avgConfidence > this.config.confidence) {
            action = 'SELL';
            strength = Math.min(Math.abs(avgChange) / 2, 1);
        }
        
        return {
            action,
            strength,
            confidence: avgConfidence,
            expectedChange: avgChange,
            timeframe: '5m'
        };
    }
    
    /**
     * Update model with actual prices
     */
    async updateModel(pair, actualPrice) {
        const prediction = this.predictions.get(pair);
        if (!prediction) return;
        
        // Find the prediction for current time
        const currentTime = Date.now();
        const relevantPredictions = {};
        
        Object.entries(prediction.predictions).forEach(([modelName, preds]) => {
            const matchingPred = preds.find(p => 
                Math.abs(p.time - currentTime) < 30000 // Within 30 seconds
            );
            
            if (matchingPred) {
                relevantPredictions[modelName] = matchingPred;
            }
        });
        
        // Calculate accuracy for each model
        Object.entries(relevantPredictions).forEach(([modelName, pred]) => {
            const error = Math.abs(pred.price - actualPrice) / actualPrice;
            const accuracy = Math.max(0, 1 - error);
            
            // Update rolling accuracy
            const currentAccuracy = this.accuracy.get(modelName) || 0.5;
            const newAccuracy = currentAccuracy * 0.9 + accuracy * 0.1; // Exponential moving average
            
            this.accuracy.set(modelName, newAccuracy);
            
            logger.debug(`Model ${modelName} accuracy: ${(newAccuracy * 100).toFixed(2)}%`);
        });
        
        // Emit accuracy update
        this.emit('accuracy:update', {
            pair,
            accuracies: Object.fromEntries(this.accuracy)
        });
    }
    
    /**
     * Get current predictions
     */
    getPredictions(pair) {
        return this.predictions.get(pair);
    }
    
    /**
     * Get model accuracy
     */
    getAccuracy() {
        return Object.fromEntries(this.accuracy);
    }
    
    /**
     * Train models with historical data
     */
    async trainModels(trainingData) {
        logger.info('Starting model training...');
        
        for (const [pair, data] of Object.entries(trainingData)) {
            if (data.length < this.config.lookbackPeriod * 10) {
                logger.warn(`Insufficient training data for ${pair}`);
                continue;
            }
            
            // Prepare training sequences
            const sequences = [];
            const targets = [];
            
            for (let i = this.config.lookbackPeriod; i < data.length - this.config.predictionHorizon; i++) {
                const sequence = this.preprocessData(pair, data.slice(i - this.config.lookbackPeriod, i));
                const target = data.slice(i, i + this.config.predictionHorizon).map(d => 
                    this.normalize(d.price, this.scalers.get(pair).price.min, this.scalers.get(pair).price.max)
                );
                
                sequences.push(sequence);
                targets.push(target);
            }
            
            // Convert to tensors
            const xTrain = tf.tensor3d(sequences);
            const yTrain = tf.tensor2d(targets);
            
            // Train each model
            for (const [modelName, model] of this.models) {
                if (modelName === 'ensemble') continue; // Skip ensemble
                
                logger.info(`Training ${modelName} model for ${pair}...`);
                
                await model.fit(xTrain, yTrain, {
                    epochs: 50,
                    batchSize: 32,
                    validationSplit: 0.2,
                    callbacks: {
                        onEpochEnd: (epoch, logs) => {
                            if (epoch % 10 === 0) {
                                logger.debug(`Epoch ${epoch}: loss=${logs.loss.toFixed(4)}`);
                            }
                        }
                    }
                });
            }
            
            xTrain.dispose();
            yTrain.dispose();
        }
        
        logger.info('Model training completed');
    }
    
    /**
     * Start prediction service
     */
    async start() {
        // Start prediction loop
        this.predictionInterval = setInterval(async () => {
            try {
                // Get latest market data
                const marketData = await this.getMarketData();
                
                // Make predictions for each pair
                for (const [pair, data] of Object.entries(marketData)) {
                    if (data.length >= this.config.lookbackPeriod) {
                        await this.predictPrice(pair, data);
                    }
                }
            } catch (error) {
                logger.error('Prediction cycle error:', error);
            }
        }, this.config.updateInterval);
        
        logger.info('Price prediction service started');
    }
    
    /**
     * Stop prediction service
     */
    async stop() {
        if (this.predictionInterval) {
            clearInterval(this.predictionInterval);
        }
        
        // Dispose models
        for (const [name, model] of this.models) {
            if (model.dispose) {
                model.dispose();
            }
        }
        
        logger.info('Price prediction service stopped');
    }
    
    /**
     * Get market data (placeholder - integrate with actual data source)
     */
    async getMarketData() {
        // This should be connected to actual market data feed
        return {
            'BTC/USDT': [],
            'ETH/USDT': [],
            'ETH/BTC': []
        };
    }
}

export default PricePredictor;