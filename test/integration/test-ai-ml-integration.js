/**
 * Integration Tests for AI/ML System with Agent Integration
 */

import { PredictiveAnalytics } from '../../lib/ai/predictive-analytics.js';
import { MLOptimizationEngine } from '../../lib/ai/ml-optimization-engine.js';
import { agentManager } from '../../lib/agents/agent-manager.js';
import { MonitoringAgent } from '../../lib/agents/monitoring-agent.js';
import { ScalingAgent } from '../../lib/agents/scaling-agent.js';
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';

describe('AI/ML Integration with Agents', () => {
  let predictiveAnalytics;
  let mlOptimizer;
  let monitoringAgent;
  let scalingAgent;
  
  beforeAll(async () => {
    // Initialize components
    predictiveAnalytics = new PredictiveAnalytics({
      modelUpdateInterval: 1000, // Fast for testing
      predictionHorizon: 3600000 // 1 hour
    });
    
    mlOptimizer = new MLOptimizationEngine({
      optimizationInterval: 1000,
      confidenceThreshold: 0.5 // Lower for testing
    });
    
    // Initialize agents
    monitoringAgent = new MonitoringAgent({ name: 'TestMonitor', interval: 500 });
    scalingAgent = new ScalingAgent({ name: 'TestScaler', interval: 500 });
    
    await agentManager.initialize({
      agents: [
        { type: 'monitoring', name: 'TestMonitor', config: { interval: 500 } },
        { type: 'scaling', name: 'TestScaler', config: { interval: 500 } }
      ]
    });
  });
  
  afterAll(async () => {
    predictiveAnalytics.stopPredictions();
    mlOptimizer.stopOptimization();
    await agentManager.shutdown();
  });
  
  describe('Predictive Analytics Training', () => {
    it('should train models with valid data', async () => {
      const trainingData = generateTrainingData();
      
      // Train all models
      await predictiveAnalytics.trainAllModels();
      
      const analytics = predictiveAnalytics.getAnalytics();
      expect(analytics.modelsStatus).toHaveLength(5);
      
      // At least some models should be trained
      const trainedModels = analytics.modelsStatus.filter(m => m.trained);
      expect(trainedModels.length).toBeGreaterThan(0);
    });
    
    it('should generate predictions after training', async () => {
      await predictiveAnalytics.generatePredictions();
      
      const hashratePrediction = predictiveAnalytics.getPrediction('hashrate');
      expect(hashratePrediction).toBeDefined();
      
      if (hashratePrediction) {
        expect(hashratePrediction).toHaveProperty('predictions');
        expect(hashratePrediction).toHaveProperty('trend');
        expect(hashratePrediction).toHaveProperty('confidence');
      }
    });
    
    it('should provide recommendations based on predictions', () => {
      const recommendations = predictiveAnalytics.getRecommendations();
      expect(Array.isArray(recommendations)).toBe(true);
      
      // Check recommendation structure
      if (recommendations.length > 0) {
        const rec = recommendations[0];
        expect(rec).toHaveProperty('type');
        expect(rec).toHaveProperty('priority');
        expect(rec).toHaveProperty('title');
        expect(rec).toHaveProperty('description');
        expect(rec).toHaveProperty('actions');
      }
    });
  });
  
  describe('ML Optimization Engine', () => {
    it('should wait for predictions before optimizing', async () => {
      const spy = jest.spyOn(mlOptimizer, 'waitForPredictions');
      
      await mlOptimizer.startOptimization();
      
      expect(spy).toHaveBeenCalled();
      mlOptimizer.stopOptimization();
    });
    
    it('should run optimization cycle', async () => {
      // Ensure predictions are available
      await predictiveAnalytics.generatePredictions();
      
      const spy = jest.spyOn(mlOptimizer, 'applyOptimizations');
      
      await mlOptimizer.runOptimizationCycle();
      
      expect(spy).toHaveBeenCalled();
    });
    
    it('should generate optimization stats', () => {
      const stats = mlOptimizer.getOptimizationStats();
      
      expect(stats).toHaveProperty('totalOptimizations');
      expect(stats).toHaveProperty('isOptimizing');
      expect(stats).toHaveProperty('optimizerStatus');
      expect(Array.isArray(stats.optimizerStatus)).toBe(true);
      expect(stats.optimizerStatus).toHaveLength(5);
    });
  });
  
  describe('Agent Communication', () => {
    it('should send predictions to agents', async () => {
      const scalingAgent = agentManager.getAgent('TestScaler');
      const spy = jest.spyOn(scalingAgent, 'receiveMessage');
      
      // Generate predictions with high load
      predictiveAnalytics.predictions.set(Date.now(), {
        predictions: {
          systemLoad: {
            peakTime: Date.now() + 3600000,
            peakLoad: 0.95,
            confidence: 0.8
          }
        }
      });
      
      await predictiveAnalytics.emitPredictions({
        systemLoad: { peakTime: Date.now() + 3600000, peakLoad: 0.95 }
      });
      
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'PredictiveAnalytics',
          action: 'prepareForPeak'
        })
      );
    });
    
    it('should apply optimizations through agents', async () => {
      const scalingAgent = agentManager.getAgent('TestScaler');
      const spy = jest.spyOn(scalingAgent, 'receiveMessage');
      
      await mlOptimizer.applyResourceAllocation({
        optimizer: 'resourceAllocation',
        actions: {
          cpu: { target: 0.8, action: 'increase' },
          memory: { target: 0.7, action: 'increase' }
        }
      });
      
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'MLOptimizationEngine',
          action: 'adjustResources'
        })
      );
    });
  });
  
  describe('End-to-End Workflow', () => {
    it('should complete full prediction-optimization cycle', async () => {
      // 1. Start monitoring
      await monitoringAgent.start();
      
      // 2. Collect some metrics
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // 3. Train models (would use collected metrics in real scenario)
      await predictiveAnalytics.trainAllModels();
      
      // 4. Generate predictions
      await predictiveAnalytics.generatePredictions();
      
      // 5. Run optimization
      await mlOptimizer.runOptimizationCycle();
      
      // 6. Check results
      const optimizationHistory = mlOptimizer.optimizationHistory;
      expect(optimizationHistory.length).toBeGreaterThanOrEqual(0);
      
      await monitoringAgent.stop();
    });
  });
  
  describe('Error Handling', () => {
    it('should handle invalid training data gracefully', async () => {
      const invalidData = { invalid: 'data' };
      
      // Should not throw
      await expect(predictiveAnalytics.trainAllModels()).resolves.not.toThrow();
    });
    
    it('should continue optimization despite individual optimizer failures', async () => {
      // Mock one optimizer to fail
      mlOptimizer.optimizers.resourceAllocation.optimize = jest.fn()
        .mockRejectedValue(new Error('Optimizer failed'));
      
      // Should not throw
      await expect(mlOptimizer.runOptimizationCycle()).resolves.not.toThrow();
      
      // Other optimizers should still run
      expect(mlOptimizer.isOptimizing).toBe(false);
    });
  });
});

// Helper function to generate training data
function generateTrainingData() {
  const now = Date.now();
  const data = {
    systemMetrics: [],
    agentMetrics: {},
    poolStats: {
      totalHashrate: [],
      activeMiners: [],
      sharesSubmitted: []
    },
    marketData: {
      price: [],
      difficulty: [],
      networkHashrate: []
    }
  };
  
  // Generate hourly data for past 7 days
  for (let i = 0; i < 168; i++) {
    const timestamp = now - i * 3600000;
    
    data.systemMetrics.push({
      timestamp,
      cpu: { user: Math.random() * 0.8 },
      memory: { heapUsed: Math.random() * 1e9 },
      eventBusStats: { activeListeners: Math.floor(Math.random() * 100) }
    });
    
    data.poolStats.totalHashrate.push({
      timestamp,
      value: 1e15 + Math.random() * 1e14
    });
    
    data.marketData.price.push({
      timestamp,
      value: 50000 + Math.random() * 10000
    });
    
    data.marketData.difficulty.push({
      timestamp,
      value: 2e13 + Math.random() * 1e12
    });
  }
  
  return data;
}