const { EventEmitter } = require('events');
const tf = require('@tensorflow/tfjs-node');

class CryptoPricePredictor extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            symbols: options.symbols || ['BTC', 'ETH', 'LTC'],
            intervals: options.intervals || ['1m', '5m', '15m', '1h', '1d'],
            lookbackPeriod: options.lookbackPeriod || 100,
            predictionHorizon: options.predictionHorizon || 24, // hours
            updateInterval: options.updateInterval || 60000, // 1 minute
            modelType: options.modelType || 'ensemble',
            confidence: options.confidence || 0.7,
            ...options
        };
        
        this.models = new Map();
        this.priceHistory = new Map();
        this.predictions = new Map();
        this.indicators = new Map();
        
        // Market data
        this.marketData = {
            prices: new Map(),
            volumes: new Map(),
            sentiment: new Map()
        };
        
        // Performance tracking
        this.performance = {
            accuracy: new Map(),
            mse: new Map(),
            profitability: new Map()
        };
        
        this.isRunning = false;
    }

    async initialize() {
        // Initialize models for each symbol
        for (const symbol of this.config.symbols) {
            await this.initializeModels(symbol);
            this.priceHistory.set(symbol, []);
            this.predictions.set(symbol, []);
        }
        
        // Start data collection
        await this.startDataCollection();
        
        // Load historical data
        await this.loadHistoricalData();
        
        this.emit('initialized');
    }

    async initializeModels(symbol) {
        const models = {
            lstm: await this.createLSTMModel(),
            gru: await this.createGRUModel(),
            transformer: await this.createTransformerModel(),
            technical: this.createTechnicalModel(),
            sentiment: this.createSentimentModel()
        };
        
        this.models.set(symbol, models);
    }

    async createLSTMModel() {
        const model = tf.sequential({
            layers: [
                tf.layers.lstm({
                    inputShape: [this.config.lookbackPeriod, 10], // 10 features
                    units: 128,
                    returnSequences: true
                }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.lstm({
                    units: 64,
                    returnSequences: false
                }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.dense({
                    units: 32,
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

    async createGRUModel() {
        const model = tf.sequential({
            layers: [
                tf.layers.gru({
                    inputShape: [this.config.lookbackPeriod, 10],
                    units: 128,
                    returnSequences: true
                }),
                tf.layers.gru({
                    units: 64,
                    returnSequences: false
                }),
                tf.layers.dense({
                    units: 32,
                    activation: 'relu'
                }),
                tf.layers.dense({
                    units: this.config.predictionHorizon
                })
            ]
        });
        
        model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError'
        });
        
        return model;
    }

    async createTransformerModel() {
        // Simplified transformer architecture
        const inputs = tf.input({ shape: [this.config.lookbackPeriod, 10] });
        
        // Multi-head attention
        const attention = tf.layers.multiHeadAttention({
            numHeads: 4,
            keyDim: 32
        }).apply([inputs, inputs]);
        
        // Feed forward network
        const ffn = tf.layers.dense({ units: 128, activation: 'relu' }).apply(attention);
        const ffn2 = tf.layers.dense({ units: 64 }).apply(ffn);
        
        // Output layer
        const flat = tf.layers.flatten().apply(ffn2);
        const output = tf.layers.dense({ 
            units: this.config.predictionHorizon 
        }).apply(flat);
        
        const model = tf.model({ inputs, outputs: output });
        
        model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError'
        });
        
        return model;
    }

    createTechnicalModel() {
        // Technical analysis based model
        return {
            predict: (data) => {
                const indicators = this.calculateTechnicalIndicators(data);
                
                // Simple weighted combination of indicators
                const signals = {
                    trend: this.analyzeTrend(indicators),
                    momentum: this.analyzeMomentum(indicators),
                    volatility: this.analyzeVolatility(indicators),
                    volume: this.analyzeVolume(indicators)
                };
                
                return this.combineTechnicalSignals(signals);
            }
        };
    }

    createSentimentModel() {
        // Sentiment analysis model
        return {
            predict: async (symbol) => {
                const sentiment = await this.analyzeSentiment(symbol);
                
                // Convert sentiment to price prediction
                const sentimentScore = sentiment.positive - sentiment.negative;
                const magnitude = Math.abs(sentimentScore);
                
                // Simple linear mapping
                const priceChange = sentimentScore * magnitude * 0.1;
                
                return Array(this.config.predictionHorizon).fill(priceChange);
            }
        };
    }

    async predict(symbol) {
        const history = this.priceHistory.get(symbol);
        if (history.length < this.config.lookbackPeriod) {
            return null;
        }
        
        // Prepare features
        const features = await this.prepareFeatures(symbol, history);
        
        // Get predictions from all models
        const predictions = await this.getModelPredictions(symbol, features);
        
        // Ensemble predictions
        const ensemblePrediction = this.ensemblePredictions(predictions);
        
        // Calculate confidence intervals
        const confidence = this.calculateConfidence(predictions);
        
        // Risk assessment
        const risk = this.assessRisk(ensemblePrediction, confidence);
        
        const result = {
            symbol,
            timestamp: Date.now(),
            currentPrice: history[history.length - 1].price,
            predictions: ensemblePrediction,
            confidence,
            risk,
            signals: this.generateTradingSignals(ensemblePrediction, risk)
        };
        
        // Store prediction
        this.predictions.get(symbol).push(result);
        
        // Evaluate previous predictions
        this.evaluatePredictions(symbol);
        
        this.emit('prediction', result);
        
        return result;
    }

    async prepareFeatures(symbol, history) {
        const prices = history.map(h => h.price);
        const volumes = history.map(h => h.volume);
        const timestamps = history.map(h => h.timestamp);
        
        // Calculate technical indicators
        const sma20 = this.calculateSMA(prices, 20);
        const sma50 = this.calculateSMA(prices, 50);
        const rsi = this.calculateRSI(prices, 14);
        const macd = this.calculateMACD(prices);
        const bb = this.calculateBollingerBands(prices, 20);
        const obv = this.calculateOBV(prices, volumes);
        
        // Normalize features
        const features = [];
        for (let i = this.config.lookbackPeriod - 1; i < history.length; i++) {
            features.push([
                prices[i] / prices[i - 1] - 1, // Price change
                volumes[i] / (volumes[i - 1] || 1) - 1, // Volume change
                sma20[i] / prices[i] - 1, // SMA20 ratio
                sma50[i] / prices[i] - 1, // SMA50 ratio
                rsi[i] / 100, // Normalized RSI
                macd.signal[i], // MACD signal
                (prices[i] - bb.lower[i]) / (bb.upper[i] - bb.lower[i]), // BB position
                obv[i] / obv[i - 1] - 1, // OBV change
                this.getHourOfDay(timestamps[i]) / 24, // Time feature
                this.getDayOfWeek(timestamps[i]) / 7 // Day feature
            ]);
        }
        
        // Create tensor
        const lastFeatures = features.slice(-this.config.lookbackPeriod);
        return tf.tensor3d([lastFeatures]);
    }

    async getModelPredictions(symbol, features) {
        const models = this.models.get(symbol);
        const predictions = {};
        
        // Deep learning models
        predictions.lstm = await models.lstm.predict(features).array();
        predictions.gru = await models.gru.predict(features).array();
        predictions.transformer = await models.transformer.predict(features).array();
        
        // Technical analysis
        const history = this.priceHistory.get(symbol);
        predictions.technical = models.technical.predict(history);
        
        // Sentiment analysis
        predictions.sentiment = await models.sentiment.predict(symbol);
        
        return predictions;
    }

    ensemblePredictions(predictions) {
        // Weight models based on recent performance
        const weights = this.getModelWeights();
        
        const ensemble = [];
        for (let i = 0; i < this.config.predictionHorizon; i++) {
            let weightedSum = 0;
            let totalWeight = 0;
            
            for (const [model, prediction] of Object.entries(predictions)) {
                const weight = weights[model] || 0.2;
                const value = Array.isArray(prediction[0]) ? prediction[0][i] : prediction[i];
                
                weightedSum += value * weight;
                totalWeight += weight;
            }
            
            ensemble.push(weightedSum / totalWeight);
        }
        
        return ensemble;
    }

    getModelWeights() {
        // Dynamic weighting based on recent accuracy
        const weights = {
            lstm: 0.25,
            gru: 0.25,
            transformer: 0.3,
            technical: 0.15,
            sentiment: 0.05
        };
        
        // Adjust based on performance metrics
        for (const [model, weight] of Object.entries(weights)) {
            const accuracy = this.getModelAccuracy(model);
            if (accuracy) {
                weights[model] = weight * (0.5 + accuracy);
            }
        }
        
        // Normalize
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        for (const model in weights) {
            weights[model] /= total;
        }
        
        return weights;
    }

    calculateConfidence(predictions) {
        const values = Object.values(predictions).map(p => 
            Array.isArray(p[0]) ? p[0] : p
        );
        
        const confidence = [];
        for (let i = 0; i < this.config.predictionHorizon; i++) {
            const hourValues = values.map(v => v[i]);
            const mean = hourValues.reduce((a, b) => a + b, 0) / hourValues.length;
            const variance = hourValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / hourValues.length;
            const stdDev = Math.sqrt(variance);
            
            // Convert to confidence score (inverse of coefficient of variation)
            const cv = stdDev / (Math.abs(mean) + 0.0001);
            confidence.push(Math.max(0, Math.min(1, 1 - cv)));
        }
        
        return confidence;
    }

    assessRisk(predictions, confidence) {
        // Calculate various risk metrics
        const volatility = this.calculateVolatility(predictions);
        const drawdown = this.calculateMaxDrawdown(predictions);
        const sharpe = this.calculateSharpeRatio(predictions);
        
        // Aggregate risk score
        const riskScore = (volatility * 0.4 + drawdown * 0.4 + (1 - sharpe) * 0.2);
        
        return {
            score: riskScore,
            volatility,
            maxDrawdown: drawdown,
            sharpeRatio: sharpe,
            level: riskScore > 0.7 ? 'high' : riskScore > 0.4 ? 'medium' : 'low'
        };
    }

    generateTradingSignals(predictions, risk) {
        const signals = [];
        const currentPrice = this.getCurrentPrice(predictions);
        
        for (let i = 0; i < predictions.length; i++) {
            const priceChange = predictions[i];
            const confidence = risk.confidence?.[i] || 0.5;
            
            let signal = 'hold';
            let strength = 0;
            
            if (priceChange > 0.02 && confidence > this.config.confidence) {
                signal = 'buy';
                strength = Math.min(1, priceChange * confidence * 10);
            } else if (priceChange < -0.02 && confidence > this.config.confidence) {
                signal = 'sell';
                strength = Math.min(1, -priceChange * confidence * 10);
            }
            
            signals.push({
                time: i + 1, // Hours ahead
                signal,
                strength,
                expectedReturn: priceChange,
                confidence
            });
        }
        
        return signals;
    }

    // Technical Indicators
    calculateSMA(prices, period) {
        const sma = [];
        for (let i = 0; i < prices.length; i++) {
            if (i < period - 1) {
                sma.push(prices[i]);
            } else {
                const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
                sma.push(sum / period);
            }
        }
        return sma;
    }

    calculateRSI(prices, period = 14) {
        const gains = [];
        const losses = [];
        
        for (let i = 1; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            gains.push(diff > 0 ? diff : 0);
            losses.push(diff < 0 ? -diff : 0);
        }
        
        const avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
        const avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
        
        const rsi = [50]; // Initial RSI
        
        for (let i = period; i < prices.length; i++) {
            const gain = gains[i - 1];
            const loss = losses[i - 1];
            
            const newAvgGain = (avgGain * (period - 1) + gain) / period;
            const newAvgLoss = (avgLoss * (period - 1) + loss) / period;
            
            const rs = newAvgGain / (newAvgLoss + 0.0001);
            rsi.push(100 - (100 / (1 + rs)));
        }
        
        return rsi;
    }

    calculateMACD(prices, fast = 12, slow = 26, signal = 9) {
        const emaFast = this.calculateEMA(prices, fast);
        const emaSlow = this.calculateEMA(prices, slow);
        
        const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
        const signalLine = this.calculateEMA(macdLine, signal);
        const histogram = macdLine.map((v, i) => v - signalLine[i]);
        
        return { macd: macdLine, signal: signalLine, histogram };
    }

    calculateEMA(prices, period) {
        const multiplier = 2 / (period + 1);
        const ema = [prices[0]];
        
        for (let i = 1; i < prices.length; i++) {
            ema.push((prices[i] - ema[i - 1]) * multiplier + ema[i - 1]);
        }
        
        return ema;
    }

    calculateBollingerBands(prices, period = 20, stdDev = 2) {
        const sma = this.calculateSMA(prices, period);
        const upper = [];
        const lower = [];
        
        for (let i = 0; i < prices.length; i++) {
            if (i < period - 1) {
                upper.push(prices[i]);
                lower.push(prices[i]);
            } else {
                const slice = prices.slice(i - period + 1, i + 1);
                const mean = sma[i];
                const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
                const std = Math.sqrt(variance);
                
                upper.push(mean + stdDev * std);
                lower.push(mean - stdDev * std);
            }
        }
        
        return { upper, lower, middle: sma };
    }

    calculateOBV(prices, volumes) {
        const obv = [volumes[0]];
        
        for (let i = 1; i < prices.length; i++) {
            if (prices[i] > prices[i - 1]) {
                obv.push(obv[i - 1] + volumes[i]);
            } else if (prices[i] < prices[i - 1]) {
                obv.push(obv[i - 1] - volumes[i]);
            } else {
                obv.push(obv[i - 1]);
            }
        }
        
        return obv;
    }

    calculateVolatility(returns) {
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
        return Math.sqrt(variance);
    }

    calculateMaxDrawdown(prices) {
        let maxDrawdown = 0;
        let peak = prices[0];
        
        for (const price of prices) {
            if (price > peak) {
                peak = price;
            }
            const drawdown = (peak - price) / peak;
            maxDrawdown = Math.max(maxDrawdown, drawdown);
        }
        
        return maxDrawdown;
    }

    calculateSharpeRatio(returns, riskFreeRate = 0.02) {
        const annualizedReturn = returns.reduce((a, b) => a + b, 0) * 365 / returns.length;
        const volatility = this.calculateVolatility(returns) * Math.sqrt(365);
        
        return (annualizedReturn - riskFreeRate) / (volatility + 0.0001);
    }

    async analyzeSentiment(symbol) {
        // Placeholder for sentiment analysis
        // In production, this would analyze news, social media, etc.
        return {
            positive: 0.6,
            negative: 0.3,
            neutral: 0.1,
            sources: ['twitter', 'reddit', 'news']
        };
    }

    evaluatePredictions(symbol) {
        const predictions = this.predictions.get(symbol);
        const history = this.priceHistory.get(symbol);
        
        if (predictions.length < 10) return;
        
        // Evaluate predictions from 24 hours ago
        const oldPredictions = predictions.filter(p => 
            Date.now() - p.timestamp > 24 * 60 * 60 * 1000
        );
        
        for (const prediction of oldPredictions) {
            const actualPrices = history.filter(h => 
                h.timestamp >= prediction.timestamp &&
                h.timestamp <= prediction.timestamp + this.config.predictionHorizon * 60 * 60 * 1000
            );
            
            if (actualPrices.length > 0) {
                const accuracy = this.calculatePredictionAccuracy(prediction, actualPrices);
                this.updatePerformanceMetrics(symbol, accuracy);
            }
        }
    }

    calculatePredictionAccuracy(prediction, actualPrices) {
        // Calculate various accuracy metrics
        const mse = this.calculateMSE(prediction.predictions, actualPrices);
        const mae = this.calculateMAE(prediction.predictions, actualPrices);
        const directionalAccuracy = this.calculateDirectionalAccuracy(prediction.predictions, actualPrices);
        
        return { mse, mae, directionalAccuracy };
    }

    calculateMSE(predicted, actual) {
        let sum = 0;
        const n = Math.min(predicted.length, actual.length);
        
        for (let i = 0; i < n; i++) {
            sum += Math.pow(predicted[i] - actual[i].price, 2);
        }
        
        return sum / n;
    }

    calculateMAE(predicted, actual) {
        let sum = 0;
        const n = Math.min(predicted.length, actual.length);
        
        for (let i = 0; i < n; i++) {
            sum += Math.abs(predicted[i] - actual[i].price);
        }
        
        return sum / n;
    }

    calculateDirectionalAccuracy(predicted, actual) {
        let correct = 0;
        const n = Math.min(predicted.length - 1, actual.length - 1);
        
        for (let i = 0; i < n; i++) {
            const predictedDirection = predicted[i + 1] > predicted[i];
            const actualDirection = actual[i + 1].price > actual[i].price;
            
            if (predictedDirection === actualDirection) {
                correct++;
            }
        }
        
        return correct / n;
    }

    updatePerformanceMetrics(symbol, accuracy) {
        const perf = this.performance;
        
        if (!perf.accuracy.has(symbol)) {
            perf.accuracy.set(symbol, []);
            perf.mse.set(symbol, []);
        }
        
        perf.accuracy.get(symbol).push({
            timestamp: Date.now(),
            value: accuracy.directionalAccuracy
        });
        
        perf.mse.get(symbol).push({
            timestamp: Date.now(),
            value: accuracy.mse
        });
        
        // Keep only recent metrics
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
        for (const metric of [perf.accuracy, perf.mse]) {
            const data = metric.get(symbol);
            metric.set(symbol, data.filter(d => d.timestamp > cutoff));
        }
    }

    getModelAccuracy(model) {
        // Placeholder - would track individual model performance
        return 0.7;
    }

    getCurrentPrice(symbol) {
        const history = this.priceHistory.get(symbol);
        return history.length > 0 ? history[history.length - 1].price : 0;
    }

    getHourOfDay(timestamp) {
        return new Date(timestamp).getHours();
    }

    getDayOfWeek(timestamp) {
        return new Date(timestamp).getDay();
    }

    async startDataCollection() {
        // Start collecting real-time price data
        this.dataInterval = setInterval(async () => {
            for (const symbol of this.config.symbols) {
                await this.collectPriceData(symbol);
            }
        }, this.config.updateInterval);
    }

    async collectPriceData(symbol) {
        // Placeholder - would connect to real exchange APIs
        const price = this.getCurrentPrice(symbol) * (1 + (Math.random() - 0.5) * 0.01);
        const volume = Math.random() * 1000000;
        
        const data = {
            symbol,
            price,
            volume,
            timestamp: Date.now()
        };
        
        this.priceHistory.get(symbol).push(data);
        
        // Maintain history size
        const history = this.priceHistory.get(symbol);
        if (history.length > this.config.lookbackPeriod * 10) {
            history.shift();
        }
        
        this.emit('price:update', data);
    }

    async loadHistoricalData() {
        // Placeholder - would load actual historical data
        for (const symbol of this.config.symbols) {
            const history = [];
            const basePrice = symbol === 'BTC' ? 50000 : symbol === 'ETH' ? 3000 : 100;
            
            for (let i = 0; i < this.config.lookbackPeriod * 2; i++) {
                history.push({
                    symbol,
                    price: basePrice * (1 + (Math.random() - 0.5) * 0.1),
                    volume: Math.random() * 1000000,
                    timestamp: Date.now() - (this.config.lookbackPeriod * 2 - i) * 60 * 60 * 1000
                });
            }
            
            this.priceHistory.set(symbol, history);
        }
    }

    async start() {
        this.isRunning = true;
        await this.initialize();
        
        // Start prediction cycle
        this.predictionInterval = setInterval(async () => {
            for (const symbol of this.config.symbols) {
                await this.predict(symbol);
            }
        }, this.config.updateInterval);
        
        this.emit('started');
    }

    stop() {
        this.isRunning = false;
        
        if (this.dataInterval) clearInterval(this.dataInterval);
        if (this.predictionInterval) clearInterval(this.predictionInterval);
        
        this.emit('stopped');
    }

    getStatus() {
        const status = {
            running: this.isRunning,
            symbols: {},
            performance: {}
        };
        
        for (const symbol of this.config.symbols) {
            const predictions = this.predictions.get(symbol);
            const latest = predictions[predictions.length - 1];
            
            status.symbols[symbol] = {
                currentPrice: this.getCurrentPrice(symbol),
                latestPrediction: latest,
                historySize: this.priceHistory.get(symbol).length,
                predictionCount: predictions.length
            };
            
            const accuracy = this.performance.accuracy.get(symbol) || [];
            status.performance[symbol] = {
                averageAccuracy: accuracy.length > 0 ?
                    accuracy.reduce((a, b) => a + b.value, 0) / accuracy.length : null
            };
        }
        
        return status;
    }
}

module.exports = CryptoPricePredictor;