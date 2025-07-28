import { createStructuredLogger } from '../core/structured-logger.js';
import { agentMetricsCollector } from '../monitoring/agent-metrics-collector.js';
import { agentManager } from '../agents/agent-manager.js';

const logger = createStructuredLogger('PredictiveAnalytics');

/**
 * Predictive Analytics Engine for Otedama
 * Machine learning-based predictions for mining optimization
 */
export class PredictiveAnalytics {
  constructor(options = {}) {
    this.modelUpdateInterval = options.modelUpdateInterval || 3600000; // 1 hour
    this.predictionHorizon = options.predictionHorizon || 86400000; // 24 hours
    this.minDataPoints = options.minDataPoints || 100;
    
    this.models = {
      hashrate: new HashratePredictionModel(),
      difficulty: new DifficultyPredictionModel(),
      minerBehavior: new MinerBehaviorModel(),
      systemLoad: new SystemLoadModel(),
      profitability: new ProfitabilityModel()
    };
    
    this.predictions = new Map();
    this.isTraining = false;
    this.trainingTimer = null;
    
    this.setupModels();
  }

  setupModels() {
    // Initialize each model with specific parameters
    this.models.hashrate.configure({
      windowSize: 24, // 24 hours of data
      seasonality: 168, // Weekly pattern (7 * 24)
      minConfidence: 0.85
    });
    
    this.models.difficulty.configure({
      adjustmentInterval: 2016, // Bitcoin blocks
      smoothingFactor: 0.1
    });
    
    this.models.minerBehavior.configure({
      churnThreshold: 0.3,
      activityPatterns: ['daily', 'weekly', 'monthly']
    });
    
    this.models.systemLoad.configure({
      peakThreshold: 0.8,
      predictiveWindow: 60 // minutes
    });
    
    this.models.profitability.configure({
      feeRate: 0.01,
      electricityCost: 0.12 // $/kWh average
    });
  }

  async startPredictions() {
    if (this.trainingTimer) {
      logger.warn('Predictions already running');
      return;
    }

    logger.info('Starting predictive analytics engine');
    
    // Initial training
    await this.trainAllModels();
    
    // Schedule periodic updates
    this.trainingTimer = setInterval(async () => {
      await this.trainAllModels();
      await this.generatePredictions();
    }, this.modelUpdateInterval);
    
    // Generate initial predictions
    await this.generatePredictions();
  }

  stopPredictions() {
    if (this.trainingTimer) {
      clearInterval(this.trainingTimer);
      this.trainingTimer = null;
    }
    
    logger.info('Predictive analytics stopped');
  }

  async trainAllModels() {
    if (this.isTraining) {
      logger.warn('Model training already in progress');
      return;
    }

    this.isTraining = true;
    logger.info('Training prediction models...');
    
    try {
      // Collect historical data
      const historicalData = await this.collectHistoricalData();
      
      // Train each model
      for (const [name, model] of Object.entries(this.models)) {
        try {
          await model.train(historicalData);
          logger.info(`Model trained: ${name}`);
        } catch (error) {
          logger.error(`Failed to train ${name} model:`, error);
        }
      }
      
    } catch (error) {
      logger.error('Error during model training:', error);
    } finally {
      this.isTraining = false;
    }
  }

  async collectHistoricalData() {
    const timeRange = this.predictionHorizon * 7; // 7 days of data
    
    const data = {
      systemMetrics: agentMetricsCollector.getSystemMetrics(null, timeRange),
      agentMetrics: {},
      poolStats: await this.getPoolStats(timeRange),
      marketData: await this.getMarketData(timeRange),
      timestamp: Date.now()
    };
    
    // Collect metrics for each agent
    for (const [name, agent] of agentManager.agents) {
      data.agentMetrics[name] = agentMetricsCollector.getAgentMetrics(name, null, timeRange);
    }
    
    return data;
  }

  async generatePredictions() {
    logger.info('Generating predictions...');
    
    const predictions = {};
    
    try {
      // Generate predictions from each model
      predictions.hashrate = await this.models.hashrate.predict(this.predictionHorizon);
      predictions.difficulty = await this.models.difficulty.predict();
      predictions.minerBehavior = await this.models.minerBehavior.predict();
      predictions.systemLoad = await this.models.systemLoad.predict();
      predictions.profitability = await this.models.profitability.predict();
      
      // Store predictions with metadata
      this.predictions.set(Date.now(), {
        predictions,
        confidence: this.calculateOverallConfidence(predictions),
        timestamp: Date.now()
      });
      
      // Emit predictions for agent system
      this.emitPredictions(predictions);
      
      logger.info('Predictions generated successfully');
      
    } catch (error) {
      logger.error('Error generating predictions:', error);
    }
  }

  calculateOverallConfidence(predictions) {
    const confidences = Object.values(predictions)
      .map(p => p.confidence || 0)
      .filter(c => c > 0);
    
    if (confidences.length === 0) return 0;
    
    return confidences.reduce((sum, c) => sum + c, 0) / confidences.length;
  }

  emitPredictions(predictions) {
    // Send predictions to relevant agents
    if (predictions.systemLoad?.peakTime) {
      agentManager.getAgent('AutoScaler')?.receiveMessage({
        from: 'PredictiveAnalytics',
        action: 'prepareForPeak',
        data: predictions.systemLoad
      });
    }
    
    if (predictions.minerBehavior?.churnRisk > 0.5) {
      agentManager.getAgent('PerformanceOptimizer')?.receiveMessage({
        from: 'PredictiveAnalytics',
        action: 'optimizeRetention',
        data: predictions.minerBehavior
      });
    }
  }

  async getPoolStats(timeRange) {
    // Placeholder for pool statistics retrieval
    return {
      totalHashrate: [],
      activeMiners: [],
      sharesSubmitted: [],
      blocksFound: []
    };
  }

  async getMarketData(timeRange) {
    // Placeholder for market data retrieval
    return {
      price: [],
      difficulty: [],
      networkHashrate: []
    };
  }

  getPrediction(type, horizon = null) {
    const latest = Array.from(this.predictions.values()).pop();
    if (!latest) return null;
    
    const prediction = latest.predictions[type];
    if (!prediction) return null;
    
    if (horizon) {
      return prediction.getValueAt?.(horizon) || prediction;
    }
    
    return prediction;
  }

  getRecommendations() {
    const latest = Array.from(this.predictions.values()).pop();
    if (!latest) return [];
    
    const recommendations = [];
    
    // Hashrate recommendations
    if (latest.predictions.hashrate?.trend === 'declining') {
      recommendations.push({
        type: 'hashrate',
        priority: 'high',
        title: 'Declining Hashrate Predicted',
        description: 'Pool hashrate expected to decline in next 24 hours',
        actions: [
          'Increase mining rewards temporarily',
          'Launch miner retention campaign',
          'Check for competitive pools'
        ]
      });
    }
    
    // System load recommendations
    if (latest.predictions.systemLoad?.peakLoad > 0.9) {
      recommendations.push({
        type: 'capacity',
        priority: 'critical',
        title: 'System Overload Predicted',
        description: `Peak load of ${(latest.predictions.systemLoad.peakLoad * 100).toFixed(1)}% expected`,
        actions: [
          'Pre-scale infrastructure',
          'Enable load balancing',
          'Prepare emergency capacity'
        ]
      });
    }
    
    // Profitability recommendations
    if (latest.predictions.profitability?.margin < 0.1) {
      recommendations.push({
        type: 'profitability',
        priority: 'medium',
        title: 'Low Profitability Period Ahead',
        description: 'Mining profitability expected to decrease',
        actions: [
          'Optimize power consumption',
          'Consider fee adjustments',
          'Focus on efficiency improvements'
        ]
      });
    }
    
    return recommendations;
  }

  getAnalytics() {
    return {
      modelsStatus: Object.entries(this.models).map(([name, model]) => ({
        name,
        trained: model.isTrained || false,
        accuracy: model.accuracy || 0,
        lastUpdate: model.lastUpdate || null
      })),
      predictionsCount: this.predictions.size,
      latestPrediction: Array.from(this.predictions.values()).pop(),
      isTraining: this.isTraining
    };
  }
}

/**
 * Hashrate Prediction Model
 * Uses time series analysis with seasonal decomposition
 */
class HashratePredictionModel {
  constructor() {
    this.data = [];
    this.params = {};
    this.isTrained = false;
    this.lastUpdate = null;
    this.accuracy = 0;
  }

  configure(params) {
    this.params = { ...this.params, ...params };
  }

  async train(historicalData) {
    // Validate input structure
    if (!this.validateTrainingData(historicalData)) {
      throw new Error('Invalid training data format');
    }
    
    if (!historicalData.poolStats?.totalHashrate?.length) {
      throw new Error('Insufficient hashrate data for training');
    }

    // Sanitize and validate data points
    const sanitizedData = this.sanitizeData(historicalData.poolStats.totalHashrate);
    if (sanitizedData.length < this.params.windowSize) {
      throw new Error(`Insufficient data: ${sanitizedData.length} < ${this.params.windowSize}`);
    }
    
    this.data = sanitizedData;
    
    // Simple moving average model with seasonal adjustment
    this.movingAverage = this.calculateMovingAverage(this.data, this.params.windowSize);
    this.seasonalFactors = this.calculateSeasonalFactors(this.data, this.params.seasonality);
    this.trend = this.calculateTrend(this.movingAverage);
    
    this.isTrained = true;
    this.lastUpdate = Date.now();
    this.accuracy = this.calculateAccuracy();
  }

  async predict(horizon) {
    if (!this.isTrained) {
      throw new Error('Model not trained');
    }

    const steps = Math.ceil(horizon / 3600000); // Hourly predictions
    const predictions = [];
    
    let lastValue = this.data[this.data.length - 1]?.value || 0;
    
    for (let i = 0; i < steps; i++) {
      const seasonalFactor = this.seasonalFactors[i % this.seasonalFactors.length] || 1;
      const trendValue = this.trend.slope * i + this.trend.intercept;
      const prediction = (lastValue * seasonalFactor + trendValue) / 2;
      
      predictions.push({
        timestamp: Date.now() + (i * 3600000),
        value: Math.max(0, prediction),
        confidence: this.params.minConfidence * Math.exp(-i / steps)
      });
      
      lastValue = prediction;
    }

    return {
      predictions,
      trend: this.trend.slope > 0 ? 'increasing' : 'declining',
      confidence: this.accuracy,
      seasonality: this.detectSeasonality()
    };
  }

  calculateMovingAverage(data, windowSize) {
    const result = [];
    for (let i = windowSize - 1; i < data.length; i++) {
      const window = data.slice(i - windowSize + 1, i + 1);
      const avg = window.reduce((sum, d) => sum + d.value, 0) / windowSize;
      result.push({ timestamp: data[i].timestamp, value: avg });
    }
    return result;
  }

  calculateSeasonalFactors(data, period) {
    if (data.length < period * 2) return [1];
    
    const factors = [];
    for (let i = 0; i < period; i++) {
      const values = [];
      for (let j = i; j < data.length; j += period) {
        values.push(data[j].value);
      }
      const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
      const overallAvg = data.reduce((sum, d) => sum + d.value, 0) / data.length;
      factors.push(avg / overallAvg || 1);
    }
    return factors;
  }

  calculateTrend(data) {
    if (data.length < 2) return { slope: 0, intercept: 0 };
    
    // Simple linear regression
    const n = data.length;
    const sumX = data.reduce((sum, _, i) => sum + i, 0);
    const sumY = data.reduce((sum, d) => sum + d.value, 0);
    const sumXY = data.reduce((sum, d, i) => sum + i * d.value, 0);
    const sumX2 = data.reduce((sum, _, i) => sum + i * i, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    return { slope, intercept };
  }

  calculateAccuracy() {
    // Calculate accuracy based on historical predictions if available
    if (this.historicalPredictions && this.historicalPredictions.length > 0) {
      const errors = this.historicalPredictions.map(pred => {
        const actual = this.getActualValue(pred.timestamp);
        if (!actual) return null;
        return Math.abs(pred.value - actual) / actual;
      }).filter(e => e !== null);
      
      if (errors.length > 0) {
        const avgError = errors.reduce((sum, e) => sum + e, 0) / errors.length;
        return Math.max(0, Math.min(1, 1 - avgError));
      }
    }
    
    // Default accuracy for new models
    return 0.75;
  }
  
  validateTrainingData(data) {
    if (!data || typeof data !== 'object') return false;
    if (!data.poolStats || typeof data.poolStats !== 'object') return false;
    if (!Array.isArray(data.poolStats.totalHashrate)) return false;
    
    // Validate data point structure
    for (const point of data.poolStats.totalHashrate) {
      if (!point || typeof point !== 'object') return false;
      if (typeof point.value !== 'number' || isNaN(point.value)) return false;
      if (typeof point.timestamp !== 'number' || point.timestamp <= 0) return false;
    }
    
    return true;
  }
  
  sanitizeData(dataPoints) {
    return dataPoints
      .filter(point => {
        // Remove invalid data points
        return point && 
               typeof point.value === 'number' && 
               !isNaN(point.value) && 
               point.value >= 0 &&
               typeof point.timestamp === 'number' &&
               point.timestamp > 0;
      })
      .map(point => ({
        timestamp: Math.floor(point.timestamp),
        value: Math.max(0, point.value)
      }))
      .sort((a, b) => a.timestamp - b.timestamp); // Ensure chronological order
  }
  
  getActualValue(timestamp) {
    // Find actual value from historical data
    const tolerance = 3600000; // 1 hour tolerance
    const point = this.data.find(p => 
      Math.abs(p.timestamp - timestamp) < tolerance
    );
    return point ? point.value : null;
  }

  detectSeasonality() {
    // Detect dominant seasonal pattern
    const hourlyPattern = this.checkPattern(24);
    const dailyPattern = this.checkPattern(24 * 7);
    
    if (dailyPattern > hourlyPattern) return 'weekly';
    if (hourlyPattern > 0.7) return 'daily';
    return 'none';
  }

  checkPattern(period) {
    if (this.data.length < period * 2) return 0;
    
    // Autocorrelation at given lag
    const mean = this.data.reduce((sum, d) => sum + d.value, 0) / this.data.length;
    let correlation = 0;
    let variance = 0;
    
    for (let i = period; i < this.data.length; i++) {
      correlation += (this.data[i].value - mean) * (this.data[i - period].value - mean);
      variance += Math.pow(this.data[i].value - mean, 2);
    }
    
    return correlation / variance || 0;
  }
}

/**
 * Difficulty Prediction Model
 * Based on network hashrate and block time analysis
 */
class DifficultyPredictionModel {
  constructor() {
    this.historicalDifficulty = [];
    this.blockTimes = [];
    this.isTrained = false;
  }

  configure(params) {
    this.params = params;
  }

  async train(historicalData) {
    if (historicalData.marketData?.difficulty) {
      this.historicalDifficulty = historicalData.marketData.difficulty;
    }
    
    this.isTrained = true;
    this.lastUpdate = Date.now();
  }

  async predict() {
    if (!this.isTrained || this.historicalDifficulty.length < 2) {
      return { nextAdjustment: 0, confidence: 0 };
    }

    // Calculate average block time
    const recentBlocks = this.blockTimes.slice(-2016); // Last difficulty period
    const avgBlockTime = recentBlocks.reduce((sum, t) => sum + t, 0) / recentBlocks.length || 600;
    
    // Expected adjustment
    const targetBlockTime = 600; // 10 minutes
    const adjustment = (targetBlockTime / avgBlockTime) - 1;
    
    // Apply smoothing
    const smoothedAdjustment = adjustment * this.params.smoothingFactor;
    
    return {
      nextAdjustment: smoothedAdjustment,
      estimatedDifficulty: this.getCurrentDifficulty() * (1 + smoothedAdjustment),
      blocksUntilAdjustment: this.params.adjustmentInterval - (recentBlocks.length % this.params.adjustmentInterval),
      confidence: Math.min(0.9, recentBlocks.length / this.params.adjustmentInterval)
    };
  }

  getCurrentDifficulty() {
    return this.historicalDifficulty[this.historicalDifficulty.length - 1]?.value || 1;
  }
}

/**
 * Miner Behavior Model
 * Predicts miner churn and activity patterns
 */
class MinerBehaviorModel {
  constructor() {
    this.minerProfiles = new Map();
    this.isTrained = false;
  }

  configure(params) {
    this.params = params;
  }

  async train(historicalData) {
    // Analyze miner activity patterns
    for (const [agentName, metrics] of Object.entries(historicalData.agentMetrics)) {
      if (metrics.performance) {
        this.analyzeMinerPattern(agentName, metrics.performance);
      }
    }
    
    this.isTrained = true;
    this.lastUpdate = Date.now();
  }

  analyzeMinerPattern(minerId, performanceData) {
    const profile = {
      avgOnlineHours: this.calculateAvgOnlineHours(performanceData),
      activityPattern: this.detectActivityPattern(performanceData),
      reliability: this.calculateReliability(performanceData),
      profitSensitivity: this.estimateProfitSensitivity(performanceData)
    };
    
    this.minerProfiles.set(minerId, profile);
  }

  async predict() {
    if (!this.isTrained) {
      return { churnRisk: 0, confidence: 0 };
    }

    const profiles = Array.from(this.minerProfiles.values());
    
    // Calculate overall churn risk
    const churnRisk = profiles.filter(p => p.reliability < 0.7).length / profiles.length;
    
    // Predict activity levels
    const activityPrediction = {
      peak: this.predictPeakHours(profiles),
      low: this.predictLowHours(profiles)
    };
    
    return {
      churnRisk,
      expectedChurn: Math.floor(profiles.length * churnRisk),
      activityPrediction,
      confidence: Math.min(0.8, profiles.length / 100)
    };
  }

  calculateAvgOnlineHours(data) {
    // Placeholder implementation
    return 18; // hours per day
  }

  detectActivityPattern(data) {
    // Placeholder - would analyze timestamps
    return 'continuous';
  }

  calculateReliability(data) {
    // Based on consistency of activity
    return 0.85;
  }

  estimateProfitSensitivity(data) {
    // How sensitive miner is to profitability changes
    return 0.5;
  }

  predictPeakHours(profiles) {
    // Aggregate activity patterns
    return { start: 14, end: 22 }; // 2 PM - 10 PM
  }

  predictLowHours(profiles) {
    return { start: 2, end: 6 }; // 2 AM - 6 AM
  }
}

/**
 * System Load Model
 * Predicts resource usage and capacity needs
 */
class SystemLoadModel {
  constructor() {
    this.loadHistory = [];
    this.patterns = {};
    this.isTrained = false;
  }

  configure(params) {
    this.params = params;
  }

  async train(historicalData) {
    if (historicalData.systemMetrics) {
      this.loadHistory = historicalData.systemMetrics.map(m => ({
        timestamp: m.timestamp,
        cpu: m.cpu?.user || 0,
        memory: m.memory?.heapUsed || 0,
        connections: m.eventBusStats?.activeListeners || 0
      }));
    }
    
    this.patterns = this.identifyPatterns();
    this.isTrained = true;
    this.lastUpdate = Date.now();
  }

  identifyPatterns() {
    return {
      daily: this.findDailyPattern(),
      weekly: this.findWeeklyPattern(),
      spikes: this.findLoadSpikes()
    };
  }

  async predict() {
    if (!this.isTrained) {
      return { peakLoad: 0, peakTime: null, confidence: 0 };
    }

    const nextWindow = this.params.predictiveWindow * 60 * 1000; // Convert to ms
    const predictions = [];
    
    // Generate predictions for next window
    for (let i = 0; i < this.params.predictiveWindow; i++) {
      const timestamp = Date.now() + (i * 60000);
      const prediction = this.predictLoadAt(timestamp);
      predictions.push(prediction);
    }
    
    // Find peak
    const peak = predictions.reduce((max, p) => p.load > max.load ? p : max);
    
    return {
      predictions,
      peakLoad: peak.load,
      peakTime: peak.timestamp,
      requiresScaling: peak.load > this.params.peakThreshold,
      confidence: 0.85
    };
  }

  predictLoadAt(timestamp) {
    const hour = new Date(timestamp).getHours();
    const dayOfWeek = new Date(timestamp).getDay();
    
    // Combine patterns
    const dailyFactor = this.patterns.daily?.[hour] || 1;
    const weeklyFactor = this.patterns.weekly?.[dayOfWeek] || 1;
    
    const baseLoad = 0.3;
    const predictedLoad = baseLoad * dailyFactor * weeklyFactor;
    
    return {
      timestamp,
      load: Math.min(1, predictedLoad),
      components: {
        cpu: predictedLoad * 0.7,
        memory: predictedLoad * 0.8,
        network: predictedLoad * 0.6
      }
    };
  }

  findDailyPattern() {
    const hourlyAvg = {};
    
    for (let hour = 0; hour < 24; hour++) {
      const hourData = this.loadHistory.filter(d => 
        new Date(d.timestamp).getHours() === hour
      );
      
      if (hourData.length > 0) {
        hourlyAvg[hour] = hourData.reduce((sum, d) => sum + d.cpu, 0) / hourData.length;
      }
    }
    
    return hourlyAvg;
  }

  findWeeklyPattern() {
    const dailyAvg = {};
    
    for (let day = 0; day < 7; day++) {
      const dayData = this.loadHistory.filter(d => 
        new Date(d.timestamp).getDay() === day
      );
      
      if (dayData.length > 0) {
        dailyAvg[day] = dayData.reduce((sum, d) => sum + d.cpu, 0) / dayData.length;
      }
    }
    
    return dailyAvg;
  }

  findLoadSpikes() {
    const spikes = [];
    const threshold = 0.8;
    
    for (let i = 1; i < this.loadHistory.length; i++) {
      if (this.loadHistory[i].cpu > threshold && 
          this.loadHistory[i].cpu > this.loadHistory[i-1].cpu * 1.5) {
        spikes.push({
          timestamp: this.loadHistory[i].timestamp,
          load: this.loadHistory[i].cpu
        });
      }
    }
    
    return spikes;
  }
}

/**
 * Profitability Model
 * Predicts mining profitability based on multiple factors
 */
class ProfitabilityModel {
  constructor() {
    this.priceHistory = [];
    this.difficultyHistory = [];
    this.costFactors = {};
    this.isTrained = false;
  }

  configure(params) {
    this.params = params;
  }

  async train(historicalData) {
    if (historicalData.marketData) {
      this.priceHistory = historicalData.marketData.price || [];
      this.difficultyHistory = historicalData.marketData.difficulty || [];
    }
    
    this.costFactors = this.calculateCostFactors();
    this.isTrained = true;
    this.lastUpdate = Date.now();
  }

  calculateCostFactors() {
    return {
      electricity: this.params.electricityCost,
      maintenance: 0.02, // 2% of revenue
      poolFee: this.params.feeRate
    };
  }

  async predict() {
    if (!this.isTrained) {
      return { margin: 0, breakEven: 0, confidence: 0 };
    }

    // Simple profitability calculation
    const currentPrice = this.getCurrentPrice();
    const currentDifficulty = this.getCurrentDifficulty();
    const blocksPerDay = 144; // Bitcoin
    const blockReward = 6.25; // Current Bitcoin reward
    
    // Revenue calculation
    const dailyRevenue = (blocksPerDay * blockReward * currentPrice) / currentDifficulty;
    
    // Cost calculation
    const dailyCosts = this.calculateDailyCosts();
    
    // Profitability metrics
    const profit = dailyRevenue - dailyCosts;
    const margin = profit / dailyRevenue;
    const breakEvenPrice = (dailyCosts * currentDifficulty) / (blocksPerDay * blockReward);
    
    return {
      dailyRevenue,
      dailyCosts,
      profit,
      margin,
      breakEvenPrice,
      currentPrice,
      priceToBreakEvenRatio: currentPrice / breakEvenPrice,
      recommendation: this.generateRecommendation(margin),
      confidence: 0.75
    };
  }

  getCurrentPrice() {
    return this.priceHistory[this.priceHistory.length - 1]?.value || 50000;
  }

  getCurrentDifficulty() {
    return this.difficultyHistory[this.difficultyHistory.length - 1]?.value || 20000000000000;
  }

  calculateDailyCosts() {
    const powerConsumption = 3000; // kW for a medium pool
    const dailyPowerCost = powerConsumption * 24 * this.costFactors.electricity;
    const maintenanceCost = 100; // Daily operational costs
    
    return dailyPowerCost + maintenanceCost;
  }

  generateRecommendation(margin) {
    if (margin < 0) return 'shutdown';
    if (margin < 0.1) return 'optimize';
    if (margin < 0.3) return 'monitor';
    return 'expand';
  }
}

// Export singleton instance
export const predictiveAnalytics = new PredictiveAnalytics();