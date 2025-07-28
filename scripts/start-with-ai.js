#!/usr/bin/env node
/**
 * Start Otedama with AI/ML Systems
 * Initializes predictive analytics and optimization engine
 */

import { application } from '../lib/core/enhanced-application.js';
import { predictiveAnalytics } from '../lib/ai/predictive-analytics.js';
import { mlOptimizationEngine } from '../lib/ai/ml-optimization-engine.js';
import { createStructuredLogger } from '../lib/core/structured-logger.js';

const logger = createStructuredLogger('AI-Startup');

async function startWithAI() {
  try {
    console.log('🚀 Starting Otedama with AI/ML Systems...');
    
    // Configure application with AI enabled
    const config = {
      port: process.env.API_PORT || 3333,
      wsPort: process.env.WS_PORT || 3334,
      
      agents: {
        enabled: true,
        config: {
          monitoring: { interval: 30000 },
          health: { interval: 60000 },
          security: { interval: 45000 },
          optimization: { interval: 120000 },
          healing: { interval: 90000 },
          scaling: { 
            interval: 180000,
            predictiveScaling: true
          }
        }
      },
      
      ai: {
        enabled: true,
        predictiveAnalytics: {
          modelUpdateInterval: 3600000, // 1 hour
          predictionHorizon: 86400000   // 24 hours
        },
        optimization: {
          optimizationInterval: 300000,  // 5 minutes
          confidenceThreshold: 0.7
        }
      }
    };
    
    // Initialize application
    await application.initialize(config);
    
    // Start application
    await application.start();
    
    // Start AI/ML systems
    console.log('🤖 Starting Predictive Analytics...');
    await predictiveAnalytics.startPredictions();
    
    console.log('🔧 Starting ML Optimization Engine...');
    await mlOptimizationEngine.startOptimization();
    
    // Setup AI system monitoring
    setupAIMonitoring();
    
    // Log initial status
    setTimeout(() => {
      logAIStatus();
    }, 10000);
    
    console.log('✅ All systems operational with AI/ML enabled!');
    
  } catch (error) {
    console.error('❌ Failed to start with AI:', error);
    process.exit(1);
  }
}

function setupAIMonitoring() {
  // Monitor predictive analytics
  setInterval(() => {
    const analytics = predictiveAnalytics.getAnalytics();
    logger.info('Predictive Analytics Status', {
      modelsStatus: analytics.modelsStatus,
      predictionsCount: analytics.predictionsCount,
      isTraining: analytics.isTraining
    });
  }, 60000); // Every minute
  
  // Monitor optimization engine
  setInterval(() => {
    const stats = mlOptimizationEngine.getOptimizationStats();
    logger.info('ML Optimization Stats', {
      totalOptimizations: stats.totalOptimizations,
      averageOptimizationsPerCycle: stats.averageOptimizationsPerCycle,
      isOptimizing: stats.isOptimizing
    });
  }, 300000); // Every 5 minutes
}

function logAIStatus() {
  console.log('\n📊 AI/ML System Status:');
  
  const analytics = predictiveAnalytics.getAnalytics();
  console.log('\n🔮 Predictive Analytics:');
  console.log(`   • Models Trained: ${analytics.modelsStatus.filter(m => m.trained).length}/${analytics.modelsStatus.length}`);
  console.log(`   • Predictions Generated: ${analytics.predictionsCount}`);
  console.log(`   • Currently Training: ${analytics.isTraining ? 'Yes' : 'No'}`);
  
  const optimizations = mlOptimizationEngine.getOptimizationStats();
  console.log('\n⚙️  ML Optimization Engine:');
  console.log(`   • Total Optimizations: ${optimizations.totalOptimizations}`);
  console.log(`   • Currently Optimizing: ${optimizations.isOptimizing ? 'Yes' : 'No'}`);
  console.log(`   • Active Optimizers: ${optimizations.optimizerStatus.filter(o => o.enabled).length}`);
  
  const recommendations = predictiveAnalytics.getRecommendations();
  if (recommendations.length > 0) {
    console.log('\n💡 AI Recommendations:');
    recommendations.forEach(rec => {
      console.log(`   • [${rec.priority.toUpperCase()}] ${rec.title}`);
      console.log(`     ${rec.description}`);
    });
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n⚡ Shutting down AI/ML systems...');
  
  mlOptimizationEngine.stopOptimization();
  predictiveAnalytics.stopPredictions();
  
  await application.stop();
  process.exit(0);
});

// Start the application
startWithAI();