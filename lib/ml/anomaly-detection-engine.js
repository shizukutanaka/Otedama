const { EventEmitter } = require('events');
const tf = require('@tensorflow/tfjs-node');

class AnomalyDetectionEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.config = {
            modelType: options.modelType || 'autoencoder',
            threshold: options.threshold || 0.95,
            windowSize: options.windowSize || 100,
            features: options.features || ['hashrate', 'temperature', 'power', 'shares'],
            updateInterval: options.updateInterval || 60000,
            batchSize: options.batchSize || 32,
            epochs: options.epochs || 50,
            learningRate: options.learningRate || 0.001,
            ...options
        };
        
        this.models = new Map();
        this.dataBuffer = [];
        this.anomalyHistory = [];
        this.isTraining = false;
        
        // Feature scaling parameters
        this.scalers = new Map();
        
        // Real-time detection state
        this.detectionState = {
            lastCheck: Date.now(),
            anomaliesDetected: 0,
            falsePositives: 0,
            truePositives: 0
        };
        
        this.initialize();
    }

    async initialize() {
        // Initialize models for different anomaly types
        await this.initializeModels();
        
        // Load pre-trained models if available
        await this.loadPretrainedModels();
        
        // Start continuous learning
        this.startContinuousLearning();
        
        this.emit('initialized');
    }

    async initializeModels() {
        // Autoencoder for general anomaly detection
        this.models.set('autoencoder', this.createAutoencoder());
        
        // LSTM for time-series anomalies
        this.models.set('lstm', this.createLSTM());
        
        // Isolation Forest for outlier detection
        this.models.set('isolation', this.createIsolationForest());
        
        // One-class SVM for novelty detection
        this.models.set('ocsvm', this.createOneClassSVM());
    }

    createAutoencoder() {
        const inputDim = this.config.features.length;
        const encodingDim = Math.max(2, Math.floor(inputDim / 2));
        
        const encoder = tf.sequential({
            layers: [
                tf.layers.dense({
                    inputShape: [inputDim],
                    units: encodingDim * 2,
                    activation: 'relu'
                }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.dense({
                    units: encodingDim,
                    activation: 'relu'
                })
            ]
        });
        
        const decoder = tf.sequential({
            layers: [
                tf.layers.dense({
                    inputShape: [encodingDim],
                    units: encodingDim * 2,
                    activation: 'relu'
                }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.dense({
                    units: inputDim,
                    activation: 'sigmoid'
                })
            ]
        });
        
        const autoencoder = tf.sequential({
            layers: [
                ...encoder.layers,
                ...decoder.layers
            ]
        });
        
        autoencoder.compile({
            optimizer: tf.train.adam(this.config.learningRate),
            loss: 'meanSquaredError'
        });
        
        return autoencoder;
    }

    createLSTM() {
        const model = tf.sequential({
            layers: [
                tf.layers.lstm({
                    inputShape: [this.config.windowSize, this.config.features.length],
                    units: 50,
                    returnSequences: true
                }),
                tf.layers.dropout({ rate: 0.2 }),
                tf.layers.lstm({
                    units: 50,
                    returnSequences: false
                }),
                tf.layers.dense({
                    units: this.config.features.length,
                    activation: 'sigmoid'
                })
            ]
        });
        
        model.compile({
            optimizer: tf.train.adam(this.config.learningRate),
            loss: 'meanSquaredError'
        });
        
        return model;
    }

    createIsolationForest() {
        // Simplified isolation forest implementation
        return {
            trees: [],
            numTrees: 100,
            subsampleSize: 256,
            
            fit: function(data) {
                this.trees = [];
                for (let i = 0; i < this.numTrees; i++) {
                    const subsample = this.getSubsample(data);
                    const tree = this.buildTree(subsample, 0);
                    this.trees.push(tree);
                }
            },
            
            predict: function(point) {
                const pathLengths = this.trees.map(tree => 
                    this.getPathLength(point, tree, 0)
                );
                const avgPathLength = pathLengths.reduce((a, b) => a + b) / pathLengths.length;
                const score = Math.pow(2, -avgPathLength / this.c(this.subsampleSize));
                return score;
            },
            
            buildTree: function(data, depth) {
                if (data.length <= 1 || depth >= 10) {
                    return { type: 'leaf', size: data.length };
                }
                
                const feature = Math.floor(Math.random() * this.config.features.length);
                const values = data.map(d => d[feature]);
                const min = Math.min(...values);
                const max = Math.max(...values);
                const split = min + Math.random() * (max - min);
                
                const left = data.filter(d => d[feature] < split);
                const right = data.filter(d => d[feature] >= split);
                
                return {
                    type: 'node',
                    feature,
                    split,
                    left: this.buildTree(left, depth + 1),
                    right: this.buildTree(right, depth + 1)
                };
            },
            
            getPathLength: function(point, tree, depth) {
                if (tree.type === 'leaf') {
                    return depth + this.c(tree.size);
                }
                
                if (point[tree.feature] < tree.split) {
                    return this.getPathLength(point, tree.left, depth + 1);
                } else {
                    return this.getPathLength(point, tree.right, depth + 1);
                }
            },
            
            c: function(n) {
                if (n <= 1) return 0;
                return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1) / n);
            },
            
            getSubsample: function(data) {
                const indices = [];
                for (let i = 0; i < this.subsampleSize && i < data.length; i++) {
                    indices.push(Math.floor(Math.random() * data.length));
                }
                return indices.map(i => data[i]);
            }
        };
    }

    createOneClassSVM() {
        // Simplified one-class SVM using RBF kernel
        return {
            supportVectors: [],
            alpha: [],
            gamma: 0.1,
            nu: 0.1,
            
            fit: function(data) {
                // Simplified training - select support vectors
                const n = data.length;
                const numSV = Math.floor(n * this.nu);
                
                // Random selection for simplicity
                const indices = [];
                for (let i = 0; i < numSV; i++) {
                    indices.push(Math.floor(Math.random() * n));
                }
                
                this.supportVectors = indices.map(i => data[i]);
                this.alpha = new Array(numSV).fill(1 / numSV);
            },
            
            predict: function(point) {
                let score = 0;
                
                for (let i = 0; i < this.supportVectors.length; i++) {
                    const sv = this.supportVectors[i];
                    const kernel = this.rbfKernel(point, sv);
                    score += this.alpha[i] * kernel;
                }
                
                return score;
            },
            
            rbfKernel: function(x1, x2) {
                let sum = 0;
                for (let i = 0; i < x1.length; i++) {
                    sum += Math.pow(x1[i] - x2[i], 2);
                }
                return Math.exp(-this.gamma * sum);
            }
        };
    }

    async detectAnomalies(data) {
        const normalizedData = this.normalizeData(data);
        const anomalies = [];
        
        // Autoencoder detection
        const aeScore = await this.autoencoderDetection(normalizedData);
        if (aeScore > this.config.threshold) {
            anomalies.push({
                type: 'reconstruction',
                score: aeScore,
                model: 'autoencoder'
            });
        }
        
        // Time-series detection with LSTM
        if (this.dataBuffer.length >= this.config.windowSize) {
            const lstmScore = await this.lstmDetection(normalizedData);
            if (lstmScore > this.config.threshold) {
                anomalies.push({
                    type: 'temporal',
                    score: lstmScore,
                    model: 'lstm'
                });
            }
        }
        
        // Isolation forest detection
        const isoScore = this.isolationForestDetection(normalizedData);
        if (isoScore > this.config.threshold) {
            anomalies.push({
                type: 'outlier',
                score: isoScore,
                model: 'isolation'
            });
        }
        
        // Update buffer
        this.dataBuffer.push(normalizedData);
        if (this.dataBuffer.length > this.config.windowSize * 2) {
            this.dataBuffer.shift();
        }
        
        // Aggregate results
        const aggregatedScore = this.aggregateScores(anomalies);
        
        if (anomalies.length > 0) {
            const anomalyEvent = {
                timestamp: Date.now(),
                data: data,
                anomalies: anomalies,
                aggregatedScore: aggregatedScore,
                severity: this.calculateSeverity(aggregatedScore)
            };
            
            this.anomalyHistory.push(anomalyEvent);
            this.detectionState.anomaliesDetected++;
            
            this.emit('anomaly:detected', anomalyEvent);
        }
        
        return {
            isAnomaly: anomalies.length > 0,
            anomalies: anomalies,
            score: aggregatedScore
        };
    }

    async autoencoderDetection(data) {
        const model = this.models.get('autoencoder');
        if (!model) return 0;
        
        const input = tf.tensor2d([data]);
        const reconstruction = model.predict(input);
        
        const mse = tf.losses.meanSquaredError(input, reconstruction);
        const score = await mse.data();
        
        input.dispose();
        reconstruction.dispose();
        mse.dispose();
        
        return score[0];
    }

    async lstmDetection(currentData) {
        const model = this.models.get('lstm');
        if (!model || this.dataBuffer.length < this.config.windowSize) return 0;
        
        // Prepare sequence
        const sequence = this.dataBuffer.slice(-this.config.windowSize);
        const input = tf.tensor3d([sequence]);
        
        const prediction = model.predict(input);
        const actual = tf.tensor2d([currentData]);
        
        const mse = tf.losses.meanSquaredError(actual, prediction);
        const score = await mse.data();
        
        input.dispose();
        prediction.dispose();
        actual.dispose();
        mse.dispose();
        
        return score[0];
    }

    isolationForestDetection(data) {
        const model = this.models.get('isolation');
        if (!model || !model.trees || model.trees.length === 0) return 0;
        
        return model.predict(data);
    }

    aggregateScores(anomalies) {
        if (anomalies.length === 0) return 0;
        
        // Weighted average based on model confidence
        const weights = {
            autoencoder: 0.4,
            lstm: 0.3,
            isolation: 0.2,
            ocsvm: 0.1
        };
        
        let weightedSum = 0;
        let totalWeight = 0;
        
        for (const anomaly of anomalies) {
            const weight = weights[anomaly.model] || 0.1;
            weightedSum += anomaly.score * weight;
            totalWeight += weight;
        }
        
        return totalWeight > 0 ? weightedSum / totalWeight : 0;
    }

    calculateSeverity(score) {
        if (score > 0.9) return 'critical';
        if (score > 0.7) return 'high';
        if (score > 0.5) return 'medium';
        return 'low';
    }

    normalizeData(data) {
        const normalized = [];
        
        for (let i = 0; i < this.config.features.length; i++) {
            const feature = this.config.features[i];
            const value = data[feature] || 0;
            
            if (!this.scalers.has(feature)) {
                this.scalers.set(feature, {
                    min: value,
                    max: value,
                    mean: value,
                    std: 0,
                    count: 1
                });
            }
            
            const scaler = this.scalers.get(feature);
            
            // Update scaler
            scaler.min = Math.min(scaler.min, value);
            scaler.max = Math.max(scaler.max, value);
            scaler.mean = (scaler.mean * scaler.count + value) / (scaler.count + 1);
            scaler.count++;
            
            // Min-max normalization
            const normalizedValue = scaler.max > scaler.min ? 
                (value - scaler.min) / (scaler.max - scaler.min) : 0.5;
            
            normalized.push(normalizedValue);
        }
        
        return normalized;
    }

    async trainModels(trainingData) {
        if (this.isTraining) return;
        
        this.isTraining = true;
        this.emit('training:started');
        
        try {
            // Prepare training data
            const normalizedData = trainingData.map(d => this.normalizeData(d));
            
            // Train autoencoder
            await this.trainAutoencoder(normalizedData);
            
            // Train LSTM
            if (normalizedData.length >= this.config.windowSize) {
                await this.trainLSTM(normalizedData);
            }
            
            // Train isolation forest
            this.trainIsolationForest(normalizedData);
            
            this.emit('training:completed');
        } catch (error) {
            this.emit('training:error', error);
        } finally {
            this.isTraining = false;
        }
    }

    async trainAutoencoder(data) {
        const model = this.models.get('autoencoder');
        if (!model) return;
        
        const dataset = tf.data.array(data).batch(this.config.batchSize);
        
        await model.fitDataset(dataset.map(x => ({ xs: x, ys: x })), {
            epochs: this.config.epochs,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    this.emit('training:epoch', { model: 'autoencoder', epoch, logs });
                }
            }
        });
    }

    async trainLSTM(data) {
        const model = this.models.get('lstm');
        if (!model) return;
        
        const sequences = [];
        const targets = [];
        
        for (let i = this.config.windowSize; i < data.length; i++) {
            sequences.push(data.slice(i - this.config.windowSize, i));
            targets.push(data[i]);
        }
        
        const x = tf.tensor3d(sequences);
        const y = tf.tensor2d(targets);
        
        await model.fit(x, y, {
            epochs: this.config.epochs,
            batchSize: this.config.batchSize,
            validationSplit: 0.2,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    this.emit('training:epoch', { model: 'lstm', epoch, logs });
                }
            }
        });
        
        x.dispose();
        y.dispose();
    }

    trainIsolationForest(data) {
        const model = this.models.get('isolation');
        if (!model) return;
        
        model.fit(data);
    }

    startContinuousLearning() {
        setInterval(async () => {
            if (this.dataBuffer.length >= 1000 && !this.isTraining) {
                // Retrain with recent data
                const recentData = this.dataBuffer.slice(-1000);
                await this.trainModels(recentData);
            }
        }, this.config.updateInterval);
    }

    async loadPretrainedModels() {
        try {
            // Load autoencoder
            const aePath = './models/autoencoder';
            if (await this.modelExists(aePath)) {
                const model = await tf.loadLayersModel(`file://${aePath}/model.json`);
                this.models.set('autoencoder', model);
            }
            
            // Load LSTM
            const lstmPath = './models/lstm';
            if (await this.modelExists(lstmPath)) {
                const model = await tf.loadLayersModel(`file://${lstmPath}/model.json`);
                this.models.set('lstm', model);
            }
        } catch (error) {
            this.emit('model:load-error', error);
        }
    }

    async saveModels() {
        try {
            // Save autoencoder
            const aeModel = this.models.get('autoencoder');
            if (aeModel) {
                await aeModel.save('file://./models/autoencoder');
            }
            
            // Save LSTM
            const lstmModel = this.models.get('lstm');
            if (lstmModel) {
                await lstmModel.save('file://./models/lstm');
            }
            
            this.emit('models:saved');
        } catch (error) {
            this.emit('model:save-error', error);
        }
    }

    async modelExists(path) {
        try {
            await tf.io.listModels();
            return true;
        } catch {
            return false;
        }
    }

    getAnomalyStatistics() {
        const stats = {
            totalAnomalies: this.anomalyHistory.length,
            detectionState: { ...this.detectionState },
            severityBreakdown: {
                critical: 0,
                high: 0,
                medium: 0,
                low: 0
            },
            typeBreakdown: {
                reconstruction: 0,
                temporal: 0,
                outlier: 0
            }
        };
        
        // Analyze anomaly history
        for (const anomaly of this.anomalyHistory) {
            stats.severityBreakdown[anomaly.severity]++;
            
            for (const a of anomaly.anomalies) {
                stats.typeBreakdown[a.type]++;
            }
        }
        
        return stats;
    }

    async explainAnomaly(anomalyEvent) {
        const explanations = [];
        
        // Feature importance
        const featureImportance = await this.calculateFeatureImportance(anomalyEvent.data);
        
        // Find most anomalous features
        const sortedFeatures = Object.entries(featureImportance)
            .sort((a, b) => b[1] - a[1]);
        
        for (const [feature, importance] of sortedFeatures.slice(0, 3)) {
            explanations.push({
                feature,
                importance,
                value: anomalyEvent.data[feature],
                expectedRange: this.getExpectedRange(feature)
            });
        }
        
        return {
            anomalyEvent,
            explanations,
            recommendation: this.generateRecommendation(explanations)
        };
    }

    async calculateFeatureImportance(data) {
        const importance = {};
        
        for (const feature of this.config.features) {
            const scaler = this.scalers.get(feature);
            if (!scaler) continue;
            
            // Distance from mean normalized by std
            const value = data[feature] || 0;
            const distance = Math.abs(value - scaler.mean);
            const normalized = scaler.std > 0 ? distance / scaler.std : distance;
            
            importance[feature] = normalized;
        }
        
        return importance;
    }

    getExpectedRange(feature) {
        const scaler = this.scalers.get(feature);
        if (!scaler) return { min: 0, max: 1 };
        
        return {
            min: scaler.mean - 2 * scaler.std,
            max: scaler.mean + 2 * scaler.std
        };
    }

    generateRecommendation(explanations) {
        const recommendations = [];
        
        for (const exp of explanations) {
            if (exp.feature === 'hashrate' && exp.value < exp.expectedRange.min) {
                recommendations.push('Check mining hardware and connections');
            } else if (exp.feature === 'temperature' && exp.value > exp.expectedRange.max) {
                recommendations.push('Improve cooling or reduce mining intensity');
            } else if (exp.feature === 'shares' && exp.value < exp.expectedRange.min) {
                recommendations.push('Verify pool connectivity and mining configuration');
            }
        }
        
        return recommendations;
    }
}

module.exports = AnomalyDetectionEngine;