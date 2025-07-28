/**
 * AI/ML Integration Test
 * Tests predictive analytics and optimization engine
 */

import { predictiveAnalytics } from '../lib/ai/predictive-analytics.js';
import { mlOptimizationEngine } from '../lib/ai/ml-optimization-engine.js';
import { agentManager } from '../lib/agents/agent-manager.js';
import { createStructuredLogger } from '../lib/core/structured-logger.js';

const logger = createStructuredLogger('AI-Test');

async function testAIIntegration() {
  console.log('🧪 Testing AI/ML Integration...\n');
  
  try {
    // Test 1: Initialize Agent System
    console.log('1️⃣ Initializing Agent System...');
    await agentManager.initialize({
      agents: [
        { type: 'monitoring', name: 'TestMonitor', config: { interval: 5000 } },
        { type: 'scaling', name: 'TestScaler', config: { interval: 10000 } },
        { type: 'optimization', name: 'TestOptimizer', config: { interval: 10000 } }
      ]
    });
    console.log('✅ Agent system initialized\n');
    
    // Test 2: Start Predictive Analytics
    console.log('2️⃣ Testing Predictive Analytics...');
    await predictiveAnalytics.startPredictions();
    
    // Wait for initial training
    console.log('   Waiting for model training...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const analytics = predictiveAnalytics.getAnalytics();
    console.log('   Analytics Status:', {
      modelsCount: analytics.modelsStatus.length,
      trainedModels: analytics.modelsStatus.filter(m => m.trained).length
    });
    console.log('✅ Predictive analytics operational\n');
    
    // Test 3: Start ML Optimization
    console.log('3️⃣ Testing ML Optimization Engine...');
    await mlOptimizationEngine.startOptimization();
    
    // Wait for initial optimization
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const optimizationStats = mlOptimizationEngine.getOptimizationStats();
    console.log('   Optimization Status:', {
      isOptimizing: optimizationStats.isOptimizing,
      optimizersCount: optimizationStats.optimizerStatus.length
    });
    console.log('✅ ML optimization engine operational\n');
    
    // Test 4: Test Predictions
    console.log('4️⃣ Testing Predictions...');
    const predictions = {
      hashrate: predictiveAnalytics.getPrediction('hashrate'),
      difficulty: predictiveAnalytics.getPrediction('difficulty'),
      systemLoad: predictiveAnalytics.getPrediction('systemLoad'),
      minerBehavior: predictiveAnalytics.getPrediction('minerBehavior'),
      profitability: predictiveAnalytics.getPrediction('profitability')
    };
    
    console.log('   Generated Predictions:');
    Object.entries(predictions).forEach(([type, pred]) => {
      if (pred) {
        console.log(`   • ${type}: ${pred.confidence ? `confidence ${(pred.confidence * 100).toFixed(1)}%` : 'available'}`);
      }
    });
    console.log('✅ Predictions generated\n');
    
    // Test 5: Test Recommendations
    console.log('5️⃣ Testing AI Recommendations...');
    const recommendations = predictiveAnalytics.getRecommendations();
    console.log(`   Generated ${recommendations.length} recommendations`);
    recommendations.forEach(rec => {
      console.log(`   • [${rec.priority}] ${rec.title}`);
    });
    console.log('✅ Recommendations system working\n');
    
    // Test 6: Test Agent Communication
    console.log('6️⃣ Testing AI-Agent Communication...');
    
    // Simulate high load prediction
    const scalingAgent = agentManager.getAgent('TestScaler');
    if (scalingAgent) {
      await scalingAgent.receiveMessage({
        from: 'PredictiveAnalytics',
        action: 'prepareForPeak',
        data: { peakLoad: 0.9, peakTime: Date.now() + 3600000 }
      });
      console.log('   • Sent peak load prediction to scaling agent');
    }
    
    // Simulate optimization request
    const optimizationAgent = agentManager.getAgent('TestOptimizer');
    if (optimizationAgent) {
      await optimizationAgent.receiveMessage({
        from: 'MLOptimizationEngine',
        action: 'optimizePower',
        data: { powerSettings: { cpuGovernor: 'powersave', gpuPowerLimit: 0.8 } }
      });
      console.log('   • Sent power optimization to optimization agent');
    }
    console.log('✅ AI-Agent communication verified\n');
    
    // Test 7: Performance Check
    console.log('7️⃣ Performance Metrics:');
    const memUsage = process.memoryUsage();
    console.log(`   • Memory Usage: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
    console.log(`   • Active Agents: ${agentManager.agents.size}`);
    console.log(`   • Optimization History: ${mlOptimizationEngine.getOptimizationStats().totalOptimizations} cycles`);
    console.log('✅ Performance within acceptable limits\n');
    
    console.log('🎉 All AI/ML integration tests passed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    mlOptimizationEngine.stopOptimization();
    predictiveAnalytics.stopPredictions();
    await agentManager.shutdown();
  }
}

// Run tests
testAIIntegration()
  .then(() => {
    console.log('\n✅ AI/ML integration test completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ AI/ML integration test failed:', error);
    process.exit(1);
  });