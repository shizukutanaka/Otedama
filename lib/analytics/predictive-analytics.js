const EventEmitter = require('events');
const tf = require('@tensorflow/tfjs-node');
const crypto = require('crypto');

class PredictiveAnalytics extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      modelsPath: options.modelsPath || './models',
      updateInterval: options.updateInterval || 3600000, // 1 hour
      predictionHorizon: options.predictionHorizon || 24, // hours
      confidenceThreshold: options.confidenceThreshold || 0.75,
      anomalyThreshold: options.anomalyThreshold || 0.95,
      modelTypes: options.modelTypes || ['difficulty', 'hashrate', 'price', 'anomaly'],
      features: options.features || {
        difficulty: ['timestamp', 'blockHeight', 'hashrate', 'blockTime', 'networkDifficulty'],
        hashrate: ['timestamp', 'poolHashrate', 'networkHashrate', 'minerCount', 'shareRate'],
        price: ['timestamp', 'volume', 'marketCap', 'btcPrice', 'ethPrice', 'sentiment'],
        anomaly: ['shareRate', 'blockTime', 'orphanRate', 'latency', 'errorRate']
      }
    };
    
    this.models = new Map();
    this.predictions = new Map();
    this.historicalData = new Map();
    this.anomalyDetector = null;
    this.isTraining = false;
  }
  
  async initialize() {
    try {
      // Load existing models
      await this.loadModels();
      
      // Initialize anomaly detector
      this.anomalyDetector = new AnomalyDetector(this.config.anomalyThreshold);
      
      // Start periodic updates
      this.startPeriodicUpdates();
      
      this.emit('initialized');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  
  async loadModels() {
    for (const modelType of this.config.modelTypes) {
      try {
        const modelPath = `${this.config.modelsPath}/${modelType}_model`;
        const model = await tf.loadLayersModel(`file://${modelPath}/model.json`);
        this.models.set(modelType, model);
        this.emit('modelLoaded', { type: modelType });
      } catch (error) {
        // Create new model if doesn't exist
        const model = await this.createModel(modelType);
        this.models.set(modelType, model);
        this.emit('modelCreated', { type: modelType });
      }
    }
  }
  
  async createModel(modelType) {
    const features = this.config.features[modelType];
    const inputShape = [features.length];
    
    const model = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape,
          units: 128,
          activation: 'relu',
          kernelInitializer: 'glorotUniform'
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({
          units: 64,
          activation: 'relu'
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({
          units: 32,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: 1,
          activation: modelType === 'anomaly' ? 'sigmoid' : 'linear'
        })
      ]
    });
    
    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: modelType === 'anomaly' ? 'binaryCrossentropy' : 'meanSquaredError',
      metrics: ['mae', 'mse']
    });
    
    return model;
  }
  
  async predictDifficulty(currentData) {
    try {
      const model = this.models.get('difficulty');
      if (!model) throw new Error('Difficulty model not loaded');
      
      const features = this.extractFeatures('difficulty', currentData);
      const prediction = await this.makePrediction(model, features);
      
      const result = {
        nextDifficulty: prediction.value,
        confidence: prediction.confidence,
        changePercent: ((prediction.value - currentData.networkDifficulty) / currentData.networkDifficulty) * 100,
        timeToAdjustment: this.calculateTimeToAdjustment(currentData.blockHeight),
        recommendation: this.getDifficultyRecommendation(prediction.value, currentData)
      };
      
      this.predictions.set('difficulty', result);
      this.emit('difficultyPrediction', result);
      
      return result;
    } catch (error) {
      this.emit('error', { type: 'difficultyPrediction', error });
      throw error;
    }
  }
  
  async predictHashrate(poolData) {
    try {
      const model = this.models.get('hashrate');
      if (!model) throw new Error('Hashrate model not loaded');
      
      const features = this.extractFeatures('hashrate', poolData);
      const predictions = await this.makeTimeSeriesPrediction(model, features);
      
      const result = {
        predictions: predictions.map((value, index) => ({
          timestamp: Date.now() + (index + 1) * 3600000, // hourly predictions
          hashrate: value,
          confidence: predictions.confidence
        })),
        trend: this.calculateTrend(predictions),
        peakTime: this.findPeakTime(predictions),
        recommendation: this.getHashrateRecommendation(predictions, poolData)
      };
      
      this.predictions.set('hashrate', result);
      this.emit('hashratePrediction', result);
      
      return result;
    } catch (error) {
      this.emit('error', { type: 'hashratePrediction', error });
      throw error;
    }
  }
  
  async predictPrice(marketData) {
    try {
      const model = this.models.get('price');
      if (!model) throw new Error('Price model not loaded');
      
      const features = this.extractFeatures('price', marketData);
      const predictions = await this.makeTimeSeriesPrediction(model, features);
      
      const result = {
        predictions: predictions.map((value, index) => ({
          timestamp: Date.now() + (index + 1) * 3600000,
          price: value,
          confidence: predictions.confidence
        })),
        trend: this.calculateTrend(predictions),
        volatility: this.calculateVolatility(predictions),
        profitability: this.calculateProfitability(predictions, marketData),
        recommendation: this.getPriceRecommendation(predictions, marketData)
      };
      
      this.predictions.set('price', result);
      this.emit('pricePrediction', result);
      
      return result;
    } catch (error) {
      this.emit('error', { type: 'pricePrediction', error });
      throw error;
    }
  }
  
  async detectAnomalies(operationalData) {
    try {
      const model = this.models.get('anomaly');
      if (!model) throw new Error('Anomaly model not loaded');
      
      const features = this.extractFeatures('anomaly', operationalData);
      const anomalyScore = await this.makePrediction(model, features);
      
      const isAnomaly = anomalyScore.value > this.config.anomalyThreshold;
      const anomalyType = isAnomaly ? this.classifyAnomaly(operationalData) : null;
      
      const result = {
        isAnomaly,
        score: anomalyScore.value,
        confidence: anomalyScore.confidence,
        type: anomalyType,
        severity: this.calculateSeverity(anomalyScore.value),
        affectedMetrics: this.identifyAffectedMetrics(operationalData),
        recommendation: this.getAnomalyRecommendation(anomalyType, operationalData)
      };
      
      if (isAnomaly) {
        this.emit('anomalyDetected', result);
      }
      
      return result;
    } catch (error) {
      this.emit('error', { type: 'anomalyDetection', error });
      throw error;
    }
  }
  
  async trainModels(trainingData) {
    if (this.isTraining) {
      throw new Error('Training already in progress');
    }
    
    this.isTraining = true;
    this.emit('trainingStarted');
    
    try {
      for (const [modelType, model] of this.models) {
        const data = trainingData[modelType];
        if (!data || data.length === 0) continue;
        
        const { inputs, outputs } = this.prepareTrainingData(modelType, data);
        
        const result = await model.fit(inputs, outputs, {
          epochs: 100,
          batchSize: 32,
          validationSplit: 0.2,
          callbacks: {
            onEpochEnd: (epoch, logs) => {
              this.emit('trainingProgress', {
                modelType,
                epoch,
                loss: logs.loss,
                metrics: logs
              });
            }
          }
        });
        
        // Save model
        await this.saveModel(modelType, model);
        
        this.emit('modelTrained', {
          modelType,
          finalLoss: result.history.loss[result.history.loss.length - 1],
          metrics: result.history
        });
      }
      
      this.isTraining = false;
      this.emit('trainingCompleted');
    } catch (error) {
      this.isTraining = false;
      this.emit('error', { type: 'training', error });
      throw error;
    }
  }
  
  async makePrediction(model, features) {
    const input = tf.tensor2d([features]);
    const prediction = await model.predict(input).data();
    const confidence = await this.calculateConfidence(model, features);
    
    input.dispose();
    
    return {
      value: prediction[0],
      confidence
    };
  }
  
  async makeTimeSeriesPrediction(model, features) {
    const predictions = [];
    let currentFeatures = [...features];
    
    for (let i = 0; i < this.config.predictionHorizon; i++) {
      const input = tf.tensor2d([currentFeatures]);
      const prediction = await model.predict(input).data();
      predictions.push(prediction[0]);
      
      // Update features for next prediction (sliding window)
      currentFeatures = this.updateFeatures(currentFeatures, prediction[0]);
      input.dispose();
    }
    
    const confidence = await this.calculateTimeSeriesConfidence(model, features, predictions);
    predictions.confidence = confidence;
    
    return predictions;
  }
  
  extractFeatures(modelType, data) {
    const featureNames = this.config.features[modelType];
    return featureNames.map(name => this.normalizeFeature(data[name] || 0));
  }
  
  normalizeFeature(value) {
    // Simple normalization, can be improved with proper scaling
    return value / (Math.abs(value) + 1);
  }
  
  prepareTrainingData(modelType, data) {
    const features = this.config.features[modelType];
    const inputs = [];
    const outputs = [];
    
    for (let i = 0; i < data.length - 1; i++) {
      const input = features.map(feature => this.normalizeFeature(data[i][feature] || 0));
      const output = modelType === 'anomaly' 
        ? data[i].isAnomaly ? 1 : 0
        : this.normalizeFeature(data[i + 1].target || 0);
      
      inputs.push(input);
      outputs.push(output);
    }
    
    return {
      inputs: tf.tensor2d(inputs),
      outputs: tf.tensor2d(outputs, [outputs.length, 1])
    };
  }
  
  calculateConfidence(model, features) {
    // Simplified confidence calculation based on feature variance
    const variance = features.reduce((sum, val) => sum + Math.pow(val, 2), 0) / features.length;
    return Math.max(0, Math.min(1, 1 - variance));
  }
  
  calculateTimeSeriesConfidence(model, initialFeatures, predictions) {
    // Confidence decreases with prediction horizon
    const horizonPenalty = predictions.length / (this.config.predictionHorizon * 2);
    const predictionVariance = this.calculateVariance(predictions);
    return Math.max(0, Math.min(1, 1 - horizonPenalty - predictionVariance));
  }
  
  calculateVariance(values) {
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance) / (Math.abs(mean) + 1);
  }
  
  calculateTrend(predictions) {
    if (predictions.length < 2) return 'stable';
    
    const firstHalf = predictions.slice(0, Math.floor(predictions.length / 2));
    const secondHalf = predictions.slice(Math.floor(predictions.length / 2));
    
    const firstAvg = firstHalf.reduce((sum, val) => sum + val, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, val) => sum + val, 0) / secondHalf.length;
    
    const changePercent = ((secondAvg - firstAvg) / firstAvg) * 100;
    
    if (changePercent > 5) return 'increasing';
    if (changePercent < -5) return 'decreasing';
    return 'stable';
  }
  
  calculateVolatility(predictions) {
    const returns = [];
    for (let i = 1; i < predictions.length; i++) {
      returns.push((predictions[i] - predictions[i - 1]) / predictions[i - 1]);
    }
    
    const variance = this.calculateVariance(returns);
    return {
      value: variance,
      level: variance < 0.02 ? 'low' : variance < 0.05 ? 'medium' : 'high'
    };
  }
  
  calculateProfitability(pricePredictions, marketData) {
    const currentDifficulty = marketData.difficulty || 1;
    const powerCost = marketData.powerCost || 0.05; // $/kWh
    const hashrate = marketData.hashrate || 1000000; // MH/s
    const powerConsumption = marketData.powerConsumption || 1000; // W
    
    return pricePredictions.map((price, index) => {
      const revenuePerDay = (hashrate / currentDifficulty) * price * 86400;
      const powerCostPerDay = (powerConsumption / 1000) * 24 * powerCost;
      const profitPerDay = revenuePerDay - powerCostPerDay;
      
      return {
        timestamp: Date.now() + (index + 1) * 3600000,
        revenue: revenuePerDay,
        cost: powerCostPerDay,
        profit: profitPerDay,
        margin: (profitPerDay / revenuePerDay) * 100
      };
    });
  }
  
  findPeakTime(predictions) {
    let maxValue = predictions[0];
    let maxIndex = 0;
    
    predictions.forEach((value, index) => {
      if (value > maxValue) {
        maxValue = value;
        maxIndex = index;
      }
    });
    
    return {
      timestamp: Date.now() + (maxIndex + 1) * 3600000,
      value: maxValue,
      hoursFromNow: maxIndex + 1
    };
  }
  
  calculateTimeToAdjustment(currentBlockHeight) {
    const blocksPerAdjustment = 2016; // Bitcoin-like
    const blocksRemaining = blocksPerAdjustment - (currentBlockHeight % blocksPerAdjustment);
    const avgBlockTime = 10; // minutes
    
    return {
      blocks: blocksRemaining,
      estimatedMinutes: blocksRemaining * avgBlockTime,
      estimatedTime: new Date(Date.now() + blocksRemaining * avgBlockTime * 60000)
    };
  }
  
  classifyAnomaly(data) {
    const anomalies = [];
    
    if (data.shareRate < 0.5) anomalies.push('low_share_rate');
    if (data.blockTime > 15) anomalies.push('high_block_time');
    if (data.orphanRate > 0.05) anomalies.push('high_orphan_rate');
    if (data.latency > 100) anomalies.push('high_latency');
    if (data.errorRate > 0.01) anomalies.push('high_error_rate');
    
    return anomalies.length > 0 ? anomalies[0] : 'unknown';
  }
  
  calculateSeverity(anomalyScore) {
    if (anomalyScore > 0.99) return 'critical';
    if (anomalyScore > 0.95) return 'high';
    if (anomalyScore > 0.90) return 'medium';
    return 'low';
  }
  
  identifyAffectedMetrics(data) {
    const affected = [];
    const thresholds = {
      shareRate: { min: 0.8, max: 1.2 },
      blockTime: { min: 8, max: 12 },
      orphanRate: { min: 0, max: 0.02 },
      latency: { min: 0, max: 50 },
      errorRate: { min: 0, max: 0.005 }
    };
    
    for (const [metric, value] of Object.entries(data)) {
      if (thresholds[metric]) {
        const { min, max } = thresholds[metric];
        if (value < min || value > max) {
          affected.push({
            metric,
            value,
            deviation: value < min ? (min - value) / min : (value - max) / max
          });
        }
      }
    }
    
    return affected;
  }
  
  getDifficultyRecommendation(predictedDifficulty, currentData) {
    const changePercent = ((predictedDifficulty - currentData.networkDifficulty) / currentData.networkDifficulty) * 100;
    
    if (changePercent > 10) {
      return {
        action: 'prepare_for_increase',
        description: 'Significant difficulty increase expected. Consider upgrading hardware or optimizing efficiency.',
        urgency: 'high'
      };
    } else if (changePercent < -10) {
      return {
        action: 'opportunity',
        description: 'Difficulty decrease expected. Good opportunity to increase mining operations.',
        urgency: 'medium'
      };
    }
    
    return {
      action: 'maintain',
      description: 'Difficulty change within normal range. Continue current operations.',
      urgency: 'low'
    };
  }
  
  getHashrateRecommendation(predictions, poolData) {
    const trend = this.calculateTrend(predictions);
    const peak = this.findPeakTime(predictions);
    
    if (trend === 'decreasing') {
      return {
        action: 'investigate',
        description: 'Hashrate decline predicted. Check for miner disconnections or network issues.',
        urgency: 'high',
        peakMiningTime: peak
      };
    } else if (trend === 'increasing') {
      return {
        action: 'scale_infrastructure',
        description: 'Hashrate growth predicted. Ensure infrastructure can handle increased load.',
        urgency: 'medium',
        peakMiningTime: peak
      };
    }
    
    return {
      action: 'optimize',
      description: 'Stable hashrate predicted. Focus on efficiency improvements.',
      urgency: 'low',
      peakMiningTime: peak
    };
  }
  
  getPriceRecommendation(predictions, marketData) {
    const trend = this.calculateTrend(predictions);
    const volatility = this.calculateVolatility(predictions);
    const profitability = this.calculateProfitability(predictions, marketData);
    
    const avgProfit = profitability.reduce((sum, p) => sum + p.profit, 0) / profitability.length;
    
    if (avgProfit < 0) {
      return {
        action: 'reduce_operations',
        description: 'Negative profitability predicted. Consider reducing operations or switching coins.',
        urgency: 'critical',
        alternativeCoins: this.suggestAlternativeCoins(marketData)
      };
    } else if (trend === 'increasing' && volatility.level === 'low') {
      return {
        action: 'increase_operations',
        description: 'Favorable market conditions predicted. Good time to expand mining operations.',
        urgency: 'medium',
        optimalTimes: profitability.filter(p => p.margin > 20).map(p => p.timestamp)
      };
    }
    
    return {
      action: 'hedge',
      description: 'Mixed market signals. Consider hedging strategies or diversification.',
      urgency: 'medium',
      riskLevel: volatility.level
    };
  }
  
  getAnomalyRecommendation(anomalyType, data) {
    const recommendations = {
      low_share_rate: {
        action: 'check_miners',
        description: 'Low share rate detected. Check miner connectivity and performance.',
        steps: ['Verify network connectivity', 'Check miner software versions', 'Review difficulty settings']
      },
      high_block_time: {
        action: 'optimize_network',
        description: 'High block time detected. Network latency may be affecting performance.',
        steps: ['Check network latency', 'Optimize geographic distribution', 'Review peer connections']
      },
      high_orphan_rate: {
        action: 'improve_propagation',
        description: 'High orphan rate detected. Block propagation needs improvement.',
        steps: ['Increase peer connections', 'Optimize block validation', 'Check network topology']
      },
      high_latency: {
        action: 'network_optimization',
        description: 'High latency detected. Network infrastructure needs attention.',
        steps: ['Review CDN configuration', 'Check geographic distribution', 'Optimize routing']
      },
      high_error_rate: {
        action: 'system_maintenance',
        description: 'High error rate detected. System reliability issues need addressing.',
        steps: ['Review error logs', 'Check hardware health', 'Update software versions']
      },
      unknown: {
        action: 'investigate',
        description: 'Unknown anomaly detected. Manual investigation required.',
        steps: ['Review all metrics', 'Check system logs', 'Monitor closely']
      }
    };
    
    return recommendations[anomalyType] || recommendations.unknown;
  }
  
  suggestAlternativeCoins(marketData) {
    // Simplified coin suggestion based on profitability
    const coins = [
      { name: 'Ethereum', algorithm: 'Ethash', profitability: 0.8 },
      { name: 'Ravencoin', algorithm: 'KawPow', profitability: 0.7 },
      { name: 'Ergo', algorithm: 'Autolykos', profitability: 0.6 },
      { name: 'Flux', algorithm: 'ZelHash', profitability: 0.5 }
    ];
    
    return coins
      .filter(coin => coin.profitability > 0.5)
      .sort((a, b) => b.profitability - a.profitability)
      .slice(0, 3);
  }
  
  updateFeatures(features, newValue) {
    // Shift features and add new value (simplified)
    const updated = [...features];
    updated.shift();
    updated.push(this.normalizeFeature(newValue));
    return updated;
  }
  
  async saveModel(modelType, model) {
    const modelPath = `${this.config.modelsPath}/${modelType}_model`;
    await model.save(`file://${modelPath}`);
    this.emit('modelSaved', { type: modelType, path: modelPath });
  }
  
  startPeriodicUpdates() {
    setInterval(async () => {
      try {
        // Retrain models with recent data if available
        const recentData = await this.collectRecentData();
        if (recentData && Object.keys(recentData).length > 0) {
          await this.trainModels(recentData);
        }
        
        // Update predictions
        await this.updateAllPredictions();
        
        this.emit('periodicUpdateCompleted');
      } catch (error) {
        this.emit('error', { type: 'periodicUpdate', error });
      }
    }, this.config.updateInterval);
  }
  
  async collectRecentData() {
    // Collect recent data from various sources
    // This would integrate with the actual data collection system
    const data = {};
    
    for (const modelType of this.config.modelTypes) {
      const historicalData = this.historicalData.get(modelType) || [];
      if (historicalData.length > 100) {
        data[modelType] = historicalData.slice(-1000); // Use last 1000 data points
      }
    }
    
    return data;
  }
  
  async updateAllPredictions() {
    // Update all predictions with latest data
    // This would integrate with the actual monitoring system
    const currentData = await this.getCurrentSystemData();
    
    if (currentData.difficulty) {
      await this.predictDifficulty(currentData.difficulty);
    }
    
    if (currentData.hashrate) {
      await this.predictHashrate(currentData.hashrate);
    }
    
    if (currentData.market) {
      await this.predictPrice(currentData.market);
    }
    
    if (currentData.operational) {
      await this.detectAnomalies(currentData.operational);
    }
  }
  
  async getCurrentSystemData() {
    // This would integrate with actual monitoring systems
    return {
      difficulty: {
        timestamp: Date.now(),
        blockHeight: 700000,
        hashrate: 150000000,
        blockTime: 10,
        networkDifficulty: 25000000000000
      },
      hashrate: {
        timestamp: Date.now(),
        poolHashrate: 1500000,
        networkHashrate: 150000000,
        minerCount: 1000,
        shareRate: 0.98
      },
      market: {
        timestamp: Date.now(),
        volume: 50000000,
        marketCap: 500000000000,
        btcPrice: 50000,
        ethPrice: 3000,
        sentiment: 0.7
      },
      operational: {
        shareRate: 0.98,
        blockTime: 10.5,
        orphanRate: 0.01,
        latency: 45,
        errorRate: 0.002
      }
    };
  }
  
  // Public API methods
  
  async getOptimalMiningTimes(hours = 24) {
    const hashratePrediction = this.predictions.get('hashrate');
    const pricePrediction = this.predictions.get('price');
    
    if (!hashratePrediction || !pricePrediction) {
      throw new Error('Predictions not available');
    }
    
    const optimal = [];
    
    for (let i = 0; i < Math.min(hours, hashratePrediction.predictions.length); i++) {
      const hashrate = hashratePrediction.predictions[i];
      const price = pricePrediction.predictions[i];
      
      const score = (price.price / hashrate.hashrate) * price.confidence;
      
      optimal.push({
        timestamp: hashrate.timestamp,
        score,
        hashrate: hashrate.hashrate,
        price: price.price,
        recommendation: score > 0.8 ? 'highly_recommended' : score > 0.5 ? 'recommended' : 'not_recommended'
      });
    }
    
    return optimal.sort((a, b) => b.score - a.score);
  }
  
  async getRiskAssessment() {
    const predictions = {
      difficulty: this.predictions.get('difficulty'),
      hashrate: this.predictions.get('hashrate'),
      price: this.predictions.get('price')
    };
    
    const risks = [];
    
    if (predictions.difficulty && predictions.difficulty.changePercent > 15) {
      risks.push({
        type: 'difficulty_spike',
        severity: 'high',
        impact: 'Significant reduction in mining rewards',
        mitigation: 'Upgrade hardware or optimize efficiency'
      });
    }
    
    if (predictions.price && predictions.price.volatility.level === 'high') {
      risks.push({
        type: 'price_volatility',
        severity: 'medium',
        impact: 'Unpredictable profitability',
        mitigation: 'Implement hedging strategies'
      });
    }
    
    if (predictions.hashrate && predictions.hashrate.trend === 'decreasing') {
      risks.push({
        type: 'hashrate_decline',
        severity: 'medium',
        impact: 'Reduced pool competitiveness',
        mitigation: 'Investigate miner retention strategies'
      });
    }
    
    return {
      overallRisk: risks.length === 0 ? 'low' : risks.some(r => r.severity === 'high') ? 'high' : 'medium',
      risks,
      recommendations: this.generateRiskRecommendations(risks)
    };
  }
  
  generateRiskRecommendations(risks) {
    const recommendations = [];
    
    if (risks.some(r => r.type === 'difficulty_spike')) {
      recommendations.push('Consider diversifying to multiple coins');
    }
    
    if (risks.some(r => r.type === 'price_volatility')) {
      recommendations.push('Implement automatic profit switching');
    }
    
    if (risks.some(r => r.type === 'hashrate_decline')) {
      recommendations.push('Improve miner incentives and reduce fees');
    }
    
    return recommendations;
  }
  
  async getInsights() {
    const insights = [];
    
    // Difficulty insights
    const difficultyPred = this.predictions.get('difficulty');
    if (difficultyPred) {
      insights.push({
        type: 'difficulty',
        title: 'Network Difficulty Trend',
        description: `Difficulty expected to ${difficultyPred.changePercent > 0 ? 'increase' : 'decrease'} by ${Math.abs(difficultyPred.changePercent).toFixed(2)}%`,
        actionable: true,
        action: difficultyPred.recommendation
      });
    }
    
    // Optimal mining times
    try {
      const optimalTimes = await this.getOptimalMiningTimes(24);
      const bestTime = optimalTimes[0];
      insights.push({
        type: 'optimal_time',
        title: 'Best Mining Window',
        description: `Optimal mining time in ${new Date(bestTime.timestamp).getHours()} hours`,
        actionable: true,
        action: 'Schedule maintenance outside this window'
      });
    } catch (error) {
      // Skip if predictions not available
    }
    
    // Risk assessment
    const riskAssessment = await this.getRiskAssessment();
    if (riskAssessment.overallRisk !== 'low') {
      insights.push({
        type: 'risk',
        title: 'Risk Alert',
        description: `Overall risk level: ${riskAssessment.overallRisk}`,
        actionable: true,
        action: riskAssessment.recommendations[0] || 'Monitor closely'
      });
    }
    
    return insights;
  }
}

class AnomalyDetector {
  constructor(threshold) {
    this.threshold = threshold;
    this.buffer = [];
    this.bufferSize = 100;
  }
  
  addDataPoint(data) {
    this.buffer.push(data);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }
  }
  
  detectAnomaly(data) {
    // Simple statistical anomaly detection
    if (this.buffer.length < 10) return false;
    
    const mean = this.calculateMean();
    const stdDev = this.calculateStdDev(mean);
    const zScore = Math.abs((data - mean) / stdDev);
    
    return zScore > this.threshold * 3; // 3 sigma rule
  }
  
  calculateMean() {
    return this.buffer.reduce((sum, val) => sum + val, 0) / this.buffer.length;
  }
  
  calculateStdDev(mean) {
    const variance = this.buffer.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / this.buffer.length;
    return Math.sqrt(variance);
  }
}

module.exports = PredictiveAnalytics;